-- 2026-10-10：「健康度」分页审查后的修正。migration：health_fix1（取代 health_refresh_fn / health_views 的定义，
-- 并收回 health_sales_daily_mv 里给 authenticated 的 select）。
--
-- ① 「数据截至」改成按公司算的「已完整同步的最后一天」(sales_through)，不再用马来西亚的「今天」。
--    原因：总部账套一天同步 4 次（马来西亚 09:00 / 12:00 / 15:00 / 18:00），分行账套要分行电脑开机才同步
--    （09:15～18:15 之间，有些天只有一次）。原本 as_of = 今天，今年只算到已同步的部分，去年同期却算满整天，
--    本月至今 / 今年至今的成长率被低估（2026-10-09 早上 JB 本月至今显示 +30.5%，只比完整日子应为 +61.8%）。
--    规则：sales_through = least(今天 − 1, 最后一次成功同步(bi.sync_log 'sales:<公司>:load')那天 − 1)；
--          sync_log 没有纪录时退回 least(今天 − 1, 最后有销售的日期)。
--          在 bi.refresh_health() 里与物化视图同一次重算时算好、存进 bi.health_snapshot，所以与 mv 的内容一致。
--    bi_health_now 的本月至今 / 今年至今与去年同期都截到这一天（去年 = 同一天 − 1 年）；
--    快照的「近 90 天」流量也改成截到这一天（原本含今天未同步完的部分，应收天数 / 库存天数会略高估）。
--    已有的旧快照行一次性重算：近 90 天 = (snap_date − 91, snap_date − 1]。
-- ② bi.mv_health_sales_daily 没有 RLS，原本 grant select 给 authenticated（店长在 SQL 层读得到两家公司的逐日成本）。
--    改成只能经 security definer 的 bi.health_sales_daily()（函数里检查 bi_is_allowed + owner + bi_company），
--    再收回 authenticated 对 mv 的 select。public 视图改读这个函数，栏位不变。

-- 快照表加两栏：sales_through = 近 90 天流量截到哪一天；sales_synced_at = 那时最后一次成功同步的时间
alter table bi.health_snapshot add column if not exists sales_through   date;
alter table bi.health_snapshot add column if not exists sales_synced_at timestamptz;

-- 只给 owner 的读取函数（mv 本身不再给 authenticated 读）
create or replace function bi.health_sales_daily()
returns setof bi.mv_health_sales_daily
language sql
stable
security definer
set search_path to ''
as $fn$
  select m.*
  from bi.mv_health_sales_daily m
  where (select public.bi_is_allowed())
    and coalesce((select public.bi_role()), '') = 'owner'
    and ((select public.bi_company()) is null or m.company = (select public.bi_company()));
$fn$;

revoke execute on function bi.health_sales_daily() from public;
grant execute on function bi.health_sales_daily() to authenticated;

-- 重算函数：与 health_refresh_fn 相同，只改 pairs（多算 through / synced_at）与近 90 天窗口
create or replace function bi.refresh_health()
returns void
language plpgsql
security definer
set search_path to ''
as $fn$
declare
  v_today   date        := (now() at time zone 'Asia/Kuala_Lumpur')::date;
  v_started timestamptz := clock_timestamp();
begin
  refresh materialized view concurrently bi.mv_health_sales_daily;

  insert into bi.health_snapshot (
    company, snap_date, stock_cost, stock_excluded, stock_neg, slow_cost, aging_total,
    ar_pos, ar_neg, ar_over90, ar_ic, ap_pos, ap_neg,
    sales_90, sales_costed_90, cost_costed_90, sales_nocost_90, purch_3m, purch_days,
    source, refreshed_at, sales_through, sales_synced_at)
  with pairs as (
    -- 今天：截到「已完整同步的最后一天」
    select c.company, v_today as snap_date, 'live'::text as source,
           least(v_today - 1,
                 coalesce((ls.synced_at at time zone 'Asia/Kuala_Lumpur')::date - 1, c.max_date)) as through,
           ls.synced_at
    from (select d.company, max(d.doc_date) as max_date
          from bi.mv_health_sales_daily d
          group by d.company) c
    left join lateral (
      select max(l.started_at) as synced_at
      from bi.sync_log l
      where l.step = 'sales:' || c.company || ':load'
        and l.ok
        and l.finished_at is not null
        and l.finished_at < v_started
    ) ls on true
    union all
    -- 回补：过去的日子资料已完整，截到前一天
    select distinct g.company, g.snap_date, 'snap_stock_group'::text, g.snap_date - 1, null::timestamptz
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
         p.source, now(), p.through, p.synced_at
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
    where d.company = p.company and d.doc_date > p.through - 90 and d.doc_date <= p.through
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
    source = excluded.source, refreshed_at = excluded.refreshed_at,
    sales_through = excluded.sales_through, sales_synced_at = excluded.sales_synced_at;
end
$fn$;

revoke execute on function bi.refresh_health() from public;

-- 旧快照行一次性重算近 90 天流量（过去的日子资料已完整，截到前一天）
update bi.health_snapshot h
set (sales_90, sales_costed_90, cost_costed_90, sales_nocost_90) = (
      select coalesce(sum(d.net), 0), coalesce(sum(d.sales_costed), 0),
             coalesce(sum(d.cost_costed), 0), coalesce(sum(d.sales_nocost), 0)
      from bi.mv_health_sales_daily d
      where d.company = h.company and d.doc_date > h.snap_date - 91 and d.doc_date <= h.snap_date - 1),
    sales_through = h.snap_date - 1
where h.sales_through is null
  and h.snap_date < (now() at time zone 'Asia/Kuala_Lumpur')::date;

-- 月度视图：改读 bi.health_sales_daily()，其他不变
create or replace view public.bi_health_monthly with (security_invoker = true) as
with s as (
  select company,
         extract(year from doc_date)::int  as yr,
         extract(month from doc_date)::int as mth,
         sum(net)             as net,
         sum(net_ic)          as net_ic,
         sum(sales_costed)    as sales_costed,
         sum(cost_costed)     as cost_costed,
         sum(gross_goods)     as gross_goods,
         sum(sales_nocost)    as sales_nocost,
         sum(sales_nocost_ic) as sales_nocost_ic,
         sum(nocost_lines)::int as nocost_lines,
         max(doc_date)        as last_date
  from bi.health_sales_daily()
  where doc_date >= (date_trunc('month', current_date) - interval '36 months')::date
  group by company, 2, 3
), g as (
  select company, yr::int as yr, mth::int as mth,
         -sum(net) filter (where acc_type = 'SL') as gl_sales,
          sum(net) filter (where acc_type = 'SA') as gl_sa,
          sum(net) filter (where acc_type = 'CO') as gl_co,
          sum(net) filter (where acc_type = 'CO' and upper(description) like 'PURCHASE%') as gl_purch,
          sum(net) filter (where acc_type = 'EP') as gl_ep
  from bi.fact_gl
  where make_date(yr, mth, 1) >= (date_trunc('month', current_date) - interval '36 months')::date
  group by company, 2, 3
)
select coalesce(s.company, g.company) as company,
       coalesce(s.yr, g.yr)           as yr,
       coalesce(s.mth, g.mth)         as mth,
       coalesce(s.net, 0)             as net,
       coalesce(s.net_ic, 0)          as net_ic,
       coalesce(s.sales_costed, 0)    as sales_costed,
       coalesce(s.cost_costed, 0)     as cost_costed,
       coalesce(s.gross_goods, 0)     as gross_goods,
       coalesce(s.sales_nocost, 0)    as sales_nocost,
       coalesce(s.sales_nocost_ic, 0) as sales_nocost_ic,
       coalesce(s.nocost_lines, 0)    as nocost_lines,
       s.last_date,
       g.gl_sales, g.gl_sa, g.gl_co, g.gl_purch, g.gl_ep
from s
full join g on g.company = s.company and g.yr = s.yr and g.mth = s.mth
where (select public.bi_is_allowed())
  and coalesce((select public.bi_role()), '') = 'owner'
  and ((select public.bi_company()) is null or coalesce(s.company, g.company) = (select public.bi_company()));

-- 现在：as_of = 按公司「已完整同步的最后一天」（最新 live 快照的 sales_through）；
-- 去年同期截到 as_of − 1 年（尾端新栏 ly_as_of）；尾端新栏 synced_at = 最后一次成功同步的时间。
create or replace view public.bi_health_now with (security_invoker = true) as
with m as (
  select f.company, f.doc_date, f.net, f.net_ic
  from bi.health_sales_daily() f
), c as (
  select m.company, max(m.doc_date) as last_sales_date
  from m
  group by m.company
), p as (
  select c.company, c.last_sales_date,
         coalesce(h.sales_through,
                  least((now() at time zone 'Asia/Kuala_Lumpur')::date - 1, c.last_sales_date)) as as_of,
         h.sales_synced_at
  from c
  left join lateral (
    select x.sales_through, x.sales_synced_at
    from bi.health_snapshot x
    where x.company = c.company and x.source = 'live' and x.sales_through is not null
    order by x.snap_date desc
    limit 1
  ) h on true
), d as (
  select p.company, p.as_of, p.last_sales_date, p.sales_synced_at,
         sum(m.net)    filter (where m.doc_date >= date_trunc('month', p.as_of)::date and m.doc_date <= p.as_of) as mtd_net,
         sum(m.net_ic) filter (where m.doc_date >= date_trunc('month', p.as_of)::date and m.doc_date <= p.as_of) as mtd_ic,
         sum(m.net)    filter (where m.doc_date >= (date_trunc('month', p.as_of) - interval '1 year')::date
                                 and m.doc_date <= (p.as_of - interval '1 year')::date) as ly_mtd_net,
         sum(m.net_ic) filter (where m.doc_date >= (date_trunc('month', p.as_of) - interval '1 year')::date
                                 and m.doc_date <= (p.as_of - interval '1 year')::date) as ly_mtd_ic,
         sum(m.net)    filter (where m.doc_date >= date_trunc('year', p.as_of)::date and m.doc_date <= p.as_of) as ytd_net,
         sum(m.net_ic) filter (where m.doc_date >= date_trunc('year', p.as_of)::date and m.doc_date <= p.as_of) as ytd_ic,
         sum(m.net)    filter (where m.doc_date >= (date_trunc('year', p.as_of) - interval '1 year')::date
                                 and m.doc_date <= (p.as_of - interval '1 year')::date) as ly_ytd_net,
         sum(m.net_ic) filter (where m.doc_date >= (date_trunc('year', p.as_of) - interval '1 year')::date
                                 and m.doc_date <= (p.as_of - interval '1 year')::date) as ly_ytd_ic
  from p
  join m on m.company = p.company
        and m.doc_date >= (date_trunc('year', p.as_of) - interval '1 year')::date
  group by p.company, p.as_of, p.last_sales_date, p.sales_synced_at
)
select d.company, d.as_of, d.last_sales_date,
       coalesce(d.mtd_net, 0)    as mtd_net,    coalesce(d.mtd_ic, 0)    as mtd_ic,
       coalesce(d.ly_mtd_net, 0) as ly_mtd_net, coalesce(d.ly_mtd_ic, 0) as ly_mtd_ic,
       coalesce(d.ytd_net, 0)    as ytd_net,    coalesce(d.ytd_ic, 0)    as ytd_ic,
       coalesce(d.ly_ytd_net, 0) as ly_ytd_net, coalesce(d.ly_ytd_ic, 0) as ly_ytd_ic,
       (select max(h.refreshed_at) from bi.health_snapshot h where h.company = d.company) as refreshed_at,
       (d.as_of - interval '1 year')::date as ly_as_of,
       d.sales_synced_at                   as synced_at
from d
where (select public.bi_is_allowed())
  and coalesce((select public.bi_role()), '') = 'owner'
  and ((select public.bi_company()) is null or d.company = (select public.bi_company()));

-- 快照视图：尾端加 sales_through / sales_synced_at
create or replace view public.bi_health_snapshot with (security_invoker = true) as
select h.company, h.snap_date, h.source,
       h.stock_cost, h.stock_excluded, h.stock_neg, h.slow_cost, h.aging_total,
       h.ar_pos, h.ar_neg, h.ar_over90, h.ar_ic, h.ap_pos, h.ap_neg,
       h.sales_90, h.sales_costed_90, h.cost_costed_90, h.sales_nocost_90,
       h.purch_3m, h.purch_days, h.refreshed_at,
       h.sales_through, h.sales_synced_at
from bi.health_snapshot h
where h.snap_date >= ((now() at time zone 'Asia/Kuala_Lumpur')::date - 400)
  and (select public.bi_is_allowed())
  and coalesce((select public.bi_role()), '') = 'owner'
  and ((select public.bi_company()) is null or h.company = (select public.bi_company()));

grant select on public.bi_health_monthly  to authenticated;
grant select on public.bi_health_now      to authenticated;
grant select on public.bi_health_snapshot to authenticated;

-- 最后才收回 mv 的直接读取（视图已改读函数）
revoke select on bi.mv_health_sales_daily from authenticated;
