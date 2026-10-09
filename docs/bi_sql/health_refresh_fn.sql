-- 2026-10-08：「健康度」分页的重算函数。migration：health_refresh_fn。
-- bi.refresh_health() 做两件事（pg_cron bi_health_refresh 每 2 小时第 35 分呼叫，避开 15 / 25 分的
-- onepager 与 heavy_views 重算）：
--   1) concurrently 重算 bi.mv_health_sales_daily（逐日销售流量，可信毛利率要用）；
--   2) 往 bi.health_snapshot 写「今天」（马来西亚时间）一行：库存、应收、应付、滞销库存、
--      截至今天的近 90 天销售 / 成本、前 3 个完整月的总账进货；同一天重跑就覆盖（最后一次为准）。
--      另外把 bi.snap_stock_group 里有、而快照表还没有的过去日期回补成 source='snap_stock_group'
--      （只有库存与流量；应收 / 应付 / 滞销没有历史，留空）——库存天数的趋势因此从 2026-08-24 起就有。
-- 口径细节见 health_snapshot_table.sql 的注释。security definer + search_path ''：cron 以 postgres 跑，
-- 前端不能呼叫（不 grant execute 给 authenticated / anon）。
-- 回补行的 stock_excluded 只含服务群组（snap_stock_group 本来就不含 DEFECTS / DISPLAY 仓），只供说明。
create or replace function bi.refresh_health()
returns void
language plpgsql
security definer
set search_path to ''
as $fn$
declare
  v_today date := (now() at time zone 'Asia/Kuala_Lumpur')::date;
begin
  refresh materialized view concurrently bi.mv_health_sales_daily;

  insert into bi.health_snapshot (
    company, snap_date, stock_cost, stock_excluded, stock_neg, slow_cost, aging_total,
    ar_pos, ar_neg, ar_over90, ar_ic, ap_pos, ap_neg,
    sales_90, sales_costed_90, cost_costed_90, sales_nocost_90, purch_3m, purch_days,
    source, refreshed_at)
  with pairs as (
    select distinct d.company, v_today as snap_date, 'live'::text as source
    from bi.mv_health_sales_daily d
    union
    select distinct g.company, g.snap_date, 'snap_stock_group'::text
    from bi.snap_stock_group g
    where g.snap_date < v_today
      and not exists (select 1 from bi.health_snapshot x
                      where x.company = g.company and x.snap_date = g.snap_date)
  ),
  st as (
    select s.company,
           sum(s.total_cost) filter (where s.qty > 0 and s.location not in ('DEFECTS','DISPLAY')
                   and coalesce(i.item_group, '') not in ('ONLINE','SHIP FEE','PAY FEE','TRAN FEE','SERV FEE','INSTALL','TRANSPOR')) as stock_cost,
           sum(s.total_cost) filter (where s.qty > 0 and (s.location in ('DEFECTS','DISPLAY')
                   or coalesce(i.item_group, '') in ('ONLINE','SHIP FEE','PAY FEE','TRAN FEE','SERV FEE','INSTALL','TRANSPOR'))) as stock_excluded,
           sum(s.total_cost) filter (where s.qty < 0) as stock_neg
    from bi.fact_stock s
    left join bi.dim_item i on i.company = s.company and i.item_code = s.item_code
    group by s.company
  ),
  st_hist as (
    select g.company, g.snap_date,
           sum(g.cost_pos) filter (where coalesce(g.item_group, '') not in ('ONLINE','SHIP FEE','PAY FEE','TRAN FEE','SERV FEE','INSTALL','TRANSPOR')) as stock_cost,
           sum(g.cost_pos) filter (where coalesce(g.item_group, '') in ('ONLINE','SHIP FEE','PAY FEE','TRAN FEE','SERV FEE','INSTALL','TRANSPOR')) as stock_excluded
    from bi.snap_stock_group g
    group by g.company, g.snap_date
  ),
  q12 as (
    select f.company, f.item_code, sum(f.qty) as q12
    from bi.fact_sales f
    where f.doc_date > v_today - 365 and f.doc_date <= v_today and f.doc_type in ('IV','CS')
    group by f.company, f.item_code
  ),
  sl as (
    select a.company,
           sum(a.stock_value) filter (where a.last_receipt_date < v_today - 365 and coalesce(q.q12, 0) <= 0) as slow_cost,
           sum(a.stock_value) as aging_total
    from bi.fact_item_aging a
    left join q12 q on q.company = a.company and q.item_code = a.item_code
    where a.on_hand > 0
    group by a.company
  ),
  ar_d as (
    select a.company, a.debtor_code,
           bi.sale_channel(a.debtor_code, c.debtor_type) as channel,
           sum(a.balance) as net,
           coalesce(sum(a.balance) filter (where a.doc_type in ('RI','RD','RF')
                     and coalesce(a.due_date, a.doc_date) > v_today - 90), 0) as recent
    from bi.fact_ar_open a
    left join bi.dim_customer c on c.company = a.company and c.debtor_code = a.debtor_code
    group by a.company, a.debtor_code, c.debtor_type
  ),
  ar as (
    select company,
           sum(net) filter (where net > 0) as ar_pos,
           sum(net) filter (where net < 0) as ar_neg,
           sum(greatest(0, net - recent)) filter (where net > 0) as ar_over90,
           sum(net) filter (where net > 0 and channel = '分行') as ar_ic
    from ar_d
    group by company
  ),
  ap_c as (
    select company, creditor_code, sum(balance) as net
    from bi.fact_ap_open
    group by company, creditor_code
  ),
  ap as (
    select company,
           sum(net) filter (where net > 0) as ap_pos,
           sum(net) filter (where net < 0) as ap_neg
    from ap_c
    group by company
  )
  select p.company, p.snap_date,
         case when p.source = 'live' then st.stock_cost     else sh.stock_cost     end,
         case when p.source = 'live' then st.stock_excluded else sh.stock_excluded end,
         case when p.source = 'live' then st.stock_neg      end,
         case when p.source = 'live' then sl.slow_cost      end,
         case when p.source = 'live' then sl.aging_total    end,
         case when p.source = 'live' then coalesce(ar.ar_pos, 0)    end,
         case when p.source = 'live' then coalesce(ar.ar_neg, 0)    end,
         case when p.source = 'live' then coalesce(ar.ar_over90, 0) end,
         case when p.source = 'live' then coalesce(ar.ar_ic, 0)     end,
         case when p.source = 'live' then coalesce(ap.ap_pos, 0)    end,
         case when p.source = 'live' then coalesce(ap.ap_neg, 0)    end,
         fl.sales_90, fl.sales_costed_90, fl.cost_costed_90, fl.sales_nocost_90,
         pu.purch_3m, pu.purch_days,
         p.source, now()
  from pairs p
  left join st         on st.company = p.company
  left join st_hist sh on sh.company = p.company and sh.snap_date = p.snap_date
  left join sl         on sl.company = p.company
  left join ar         on ar.company = p.company
  left join ap         on ap.company = p.company
  cross join lateral (
    select coalesce(sum(d.net), 0)          as sales_90,
           coalesce(sum(d.sales_costed), 0) as sales_costed_90,
           coalesce(sum(d.cost_costed), 0)  as cost_costed_90,
           coalesce(sum(d.sales_nocost), 0) as sales_nocost_90
    from bi.mv_health_sales_daily d
    where d.company = p.company and d.doc_date > p.snap_date - 90 and d.doc_date <= p.snap_date
  ) fl
  cross join lateral (
    select sum(g.net) as purch_3m,
           (date_trunc('month', p.snap_date)::date
            - (date_trunc('month', p.snap_date) - interval '3 months')::date) as purch_days
    from bi.fact_gl g
    where g.company = p.company and g.acc_type = 'CO' and upper(g.description) like 'PURCHASE%'
      and make_date(g.yr, g.mth, 1) >= (date_trunc('month', p.snap_date) - interval '3 months')::date
      and make_date(g.yr, g.mth, 1) <  date_trunc('month', p.snap_date)::date
  ) pu
  on conflict (company, snap_date) do update set
    stock_cost = excluded.stock_cost, stock_excluded = excluded.stock_excluded, stock_neg = excluded.stock_neg,
    slow_cost = excluded.slow_cost, aging_total = excluded.aging_total,
    ar_pos = excluded.ar_pos, ar_neg = excluded.ar_neg, ar_over90 = excluded.ar_over90, ar_ic = excluded.ar_ic,
    ap_pos = excluded.ap_pos, ap_neg = excluded.ap_neg,
    sales_90 = excluded.sales_90, sales_costed_90 = excluded.sales_costed_90,
    cost_costed_90 = excluded.cost_costed_90, sales_nocost_90 = excluded.sales_nocost_90,
    purch_3m = excluded.purch_3m, purch_days = excluded.purch_days,
    source = excluded.source, refreshed_at = excluded.refreshed_at;
end
$fn$;

-- 只给排程（postgres）跑，前端角色不能呼叫
revoke execute on function bi.refresh_health() from public;
