-- 2026-10-10 BI「健康体检」分页：快照表 + 重算函数 + 视图。migration：healthcheck_snapshot
-- （原名 health_snapshot 与另一条管线 2026-10-08 建的 bi.health_snapshot 撞名，改名避开；排程另见 healthcheck_cron）
-- 口径沿用 docs/health_check_2026-10.md（8 维度、经独立核对）。只存「基础值」，比率在前端算，
-- 这样 GROUP（总行对外 + 分行）直接用加总就对。
-- 关键口径：
--   cmp  = 可比销售：排除 item_code like 'ONLINE%'（2026 起平台费以 CN 行 ONLINE000002 冲销售，2025 走 GL 6160）
--   goods= 商品行：有 item_code、非 VOUCHER/SHIPPING FEE/ONLINE%、item_group 不在服务群组（GST/DELIVERY/TRANSPOR…）
--   ext  = 对外：总行排除卖给分行的 3000-H008；分行全部
--   GL 余额 = 自首月全量累计；P&L 月份用完整月（当月不算）
-- 写法：各区块各算成一列 jsonb 再合并（不用临时表——MCP apply_migration 会把 truncate / drop 字眼当破坏性语句卡住）。
-- 2026-10-10 同日修正（migration healthcheck_low_s90_external，只重建函数）：ls.s90 剔除总行卖给分行，与 goods_90 同口径。
create table if not exists bi.healthcheck_snapshot (
  company      text primary key,
  as_of        date not null,
  m            jsonb not null,
  refreshed_at timestamptz not null default now()
);
alter table bi.healthcheck_snapshot enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'bi' and tablename = 'healthcheck_snapshot' and policyname = 'p_read_owner') then
    create policy p_read_owner on bi.healthcheck_snapshot for select to authenticated
      using ((select public.bi_is_allowed()) and coalesce((select public.bi_role()), '') = 'owner');
  end if;
end $$;
grant select on bi.healthcheck_snapshot to authenticated, service_role;

create or replace function bi.refresh_healthcheck() returns void
language plpgsql security definer set search_path = '' as $$
declare
  m0   date := date_trunc('month', current_date)::date;                           -- 本月 1 日（不完整月起点）
  l12s date := (date_trunc('month', current_date) - interval '12 months')::date;  -- 近 12 个完整月起点
  p12s date := (date_trunc('month', current_date) - interval '24 months')::date;
  l3s  date := (date_trunc('month', current_date) - interval '3 months')::date;
  p3s  date := (date_trunc('month', current_date) - interval '6 months')::date;
  ly3s date := (date_trunc('month', current_date) - interval '15 months')::date;
  ys   date := date_trunc('year', current_date)::date;
  lys  date := (date_trunc('year', current_date) - interval '1 year')::date;
  lye  date := (current_date - interval '1 year')::date;                         -- 去年同日（含）
  m0ly date := (date_trunc('month', current_date) - interval '1 year')::date;     -- 去年的「本月 1 日」
  plat  text[] := array['300-S001','300-0004','3000-S009','3000-S016','300-E001','3000-T003','3000-S011'];
  cashc text[] := array['300-C001','3000-C009','3000-C010'];
  srv   text[] := array['GST','DELIVERY','TRANSPOR','TRAN FEE','INSTALL','ONLINE','SHIP FEE','PAY FEE','SERV FEE'];
  -- 集团可直接加总的基础值
  addk  text[] := array['sales_ytd','sales_ly_ytd','sales_l12','sales_p12','sales_l3','sales_p3','sales_ly3','orders_l12','orders_p12',
              'goods_l12','goods_p12','goods_cn_l12','goods_cn_p12','gnet_l12','gp_l12','gnet_p12','gp_p12','zero_cost_l12','gnet_l3','goods_90',
              'credit_90','cust_active_l12','cust_active_p12','cust_new_l12','cust_lost','cust_retained',
              'rev_ext_ytd','rev_ext_ly_ytd','rev_ext_l12','co_ytd','co_ly_ytd','co_l12','purch_l12','purch_l3',
              'ep_ytd','ep_ly_ytd','ep_l12','oi_ytd','oi_ly_ytd','oi_l12','tx_ytd','tx_ly_ytd','tx_l12',
              'staff_ytd','staff_ly_ytd','adv_ytd','adv_ly_ytd','comm_ytd','rent_ytd','trans_ytd','dep_l12','int_l12','capex_ytd','div_ytd',
              'cash_pos','cash_neg','net_cash','net_cash_y0','net_cash_m0','net_cash_12','loans_cl_neg','loans_cl_neg_y0','cash_neg_y0','sh_loans_neg',
              'ar_inv','ar_net','ar_unapplied','ar_over60','ar_over90','ar_over365','stock_cost','neg_rows','neg_cost','aging_total','dead_180','never_sold',
              'low_n','low_s90','ap_inv','ap_unapplied','ap_net','ap_over90','open_po','open_po_n','open_po_old_n','backlog','backlog_n','backlog_over90'];
  c  text;
  j  jsonb;
  mm jsonb;
  mh jsonb;
  ms jsonb;
  mg jsonb;
begin
  foreach c in array array['HOMEWORKSSB','HOMEWORKSSOUTHERN'] loop
    mm := '{}'::jsonb;

    ------------------------------------------------------------------ 销售口径（fact_sales，近 24 个月）
    select to_jsonb(r) into j from (
    with s as (
      select f.doc_type, f.doc_no, f.doc_date, f.debtor_code, f.item_code, f.sub_total, f.cost, f.profit, f.sales_agent,
             (f.item_code is not null and f.item_code not in ('VOUCHER','SHIPPING FEE') and f.item_code not like 'ONLINE%'
              and coalesce(i.item_group, '') <> all (srv))                     as goods,
             (f.item_code is null or f.item_code not like 'ONLINE%')           as cmp,
             (f.debtor_code = any (plat))                                      as is_plat,
             (c = 'HOMEWORKSSB' and f.debtor_code = '3000-H008')              as is_ic
      from bi.fact_sales f
      left join bi.dim_item i on i.company = f.company and i.item_code = f.item_code
      where f.company = c and f.doc_date >= p12s
    )
      select
        sum(sub_total) filter (where cmp and not is_ic and doc_date >= ys)                                   as sales_ytd,
        sum(sub_total) filter (where cmp and not is_ic and doc_date >= lys and doc_date <= lye)              as sales_ly_ytd,
        sum(sub_total) filter (where cmp and not is_ic and doc_date >= l12s and doc_date < m0)               as sales_l12,
        sum(sub_total) filter (where cmp and not is_ic and doc_date >= p12s and doc_date < l12s)             as sales_p12,
        sum(sub_total) filter (where cmp and not is_ic and doc_date >= l3s and doc_date < m0)                as sales_l3,
        sum(sub_total) filter (where cmp and not is_ic and doc_date >= p3s and doc_date < l3s)               as sales_p3,
        sum(sub_total) filter (where cmp and not is_ic and doc_date >= ly3s and doc_date < l12s)             as sales_ly3,
        sum(sub_total) filter (where cmp and is_ic and doc_date >= ys and doc_date < m0)                     as ic_ytd,
        sum(sub_total) filter (where cmp and is_ic and doc_date >= lys and doc_date < m0ly)                  as ic_ly_ytd,
        sum(sub_total) filter (where cmp and is_ic and doc_date >= l12s and doc_date < m0)                   as ic_l12,
        count(distinct doc_no) filter (where doc_type in ('IV','CS') and not is_ic and doc_date >= l12s and doc_date < m0)   as orders_l12,
        count(distinct doc_no) filter (where doc_type in ('IV','CS') and not is_ic and doc_date >= p12s and doc_date < l12s) as orders_p12,
        sum(sub_total) filter (where goods and not is_ic and doc_type in ('IV','CS') and doc_date >= l12s and doc_date < m0)     as goods_l12,
        sum(sub_total) filter (where goods and not is_ic and doc_type in ('IV','CS') and doc_date >= p12s and doc_date < l12s)   as goods_p12,
        -sum(sub_total) filter (where goods and not is_ic and doc_type = 'CN' and doc_date >= l12s and doc_date < m0)            as goods_cn_l12,
        -sum(sub_total) filter (where goods and not is_ic and doc_type = 'CN' and doc_date >= p12s and doc_date < l12s)          as goods_cn_p12,
        sum(sub_total) filter (where goods and not is_ic and doc_date >= l12s and doc_date < m0)             as gnet_l12,
        sum(profit)    filter (where goods and not is_ic and doc_date >= l12s and doc_date < m0)             as gp_l12,
        sum(sub_total) filter (where goods and not is_ic and doc_date >= p12s and doc_date < l12s)           as gnet_p12,
        sum(profit)    filter (where goods and not is_ic and doc_date >= p12s and doc_date < l12s)           as gp_p12,
        sum(sub_total) filter (where goods and not is_ic and doc_type in ('IV','CS') and coalesce(cost, 0) = 0
                                 and doc_date >= l12s and doc_date < m0)                                      as zero_cost_l12,
        sum(sub_total) filter (where goods and not is_ic and doc_date >= l3s and doc_date < m0)              as gnet_l3,
        sum(sub_total) filter (where goods and not is_ic and doc_date >= current_date - 90)                  as goods_90,
        sum(sub_total) filter (where goods and is_plat and doc_type in ('IV','CS') and doc_date >= l12s and doc_date < m0)  as plat_goods_l12,
        sum(sub_total) filter (where goods and is_plat and doc_type in ('IV','CS') and doc_date >= ys and doc_date < m0)    as plat_goods_ytd,
        sum(sub_total) filter (where goods and is_plat and doc_type in ('IV','CS') and doc_date >= lys and doc_date < m0ly) as plat_goods_ly_ytd,
        sum(profit)    filter (where goods and is_plat and doc_date >= ys and doc_date < m0)                 as plat_gp_ytd,
        sum(sub_total) filter (where is_plat and item_code = 'VOUCHER' and doc_date >= ys and doc_date < m0) as plat_voucher_ytd,
        sum(sub_total) filter (where cmp and not is_plat and not is_ic and doc_date >= l3s and doc_date < m0) as store_l3,
        sum(sub_total) filter (where cmp and not is_plat and not is_ic and doc_date >= l3s and doc_date < m0
                                 and coalesce(trim(sales_agent), '') = '')                                    as store_blank_l3,
        sum(sub_total) filter (where doc_type = 'IV' and cmp and not is_ic and not is_plat
                                 and debtor_code <> all (cashc) and doc_date >= current_date - 90)             as credit_90
      from s
    ) r;
    mm := mm || j;

    ------------------------------------------------------------------ 客户（具名客户，全历史）
    select to_jsonb(r) into j from (
    with cs as (
      select f.debtor_code, min(f.doc_date) as first_d,
             sum(f.sub_total) filter (where f.doc_date >= l12s and f.doc_date < m0)   as s_l12,
             sum(f.sub_total) filter (where f.doc_date >= p12s and f.doc_date < l12s) as s_p12,
             bool_or(f.doc_type in ('IV','CS') and f.doc_date >= l12s and f.doc_date < m0)   as a_l12,
             bool_or(f.doc_type in ('IV','CS') and f.doc_date >= p12s and f.doc_date < l12s) as a_p12
      from bi.fact_sales f
      left join bi.dim_customer d on d.company = f.company and d.debtor_code = f.debtor_code
      where f.company = c
        and (c <> 'HOMEWORKSSB' or (f.debtor_code <> '3000-H008' and f.debtor_code <> all (plat) and f.debtor_code <> all (cashc)
                                     and coalesce(d.debtor_type, '') not in ('ONLINE','BRANCH')))
      group by f.debtor_code
    )
      select count(*) filter (where a_l12)                           as cust_active_l12,
             count(*) filter (where a_p12)                           as cust_active_p12,
             count(*) filter (where a_l12 and first_d >= l12s)       as cust_new_l12,
             sum(s_l12) filter (where a_l12 and first_d >= l12s)     as cust_new_sales_l12,
             count(*) filter (where a_p12 and not a_l12)             as cust_lost,
             sum(s_p12) filter (where a_p12 and not a_l12)           as cust_lost_sales,
             count(*) filter (where a_p12 and a_l12)                 as cust_retained,
             sum(s_l12) filter (where a_l12)                         as named_l12,
             (select sum(t.s_l12) from (select s_l12 from cs where a_l12 order by s_l12 desc limit 10) t) as top10_l12
      from cs
    ) r;
    mm := mm || j;

    ------------------------------------------------------------------ 总账：损益（完整月）与余额（全量累计）
    select to_jsonb(r) into j from (
    with g as (
      select acc_no, description, acc_type, coalesce(special_acc_type, '') as sp, dr, cr, net,
             make_date(yr::int, mth::int, 1) as d
      from bi.fact_gl where company = c
    ), pl as (
      select
        -sum(net) filter (where acc_type in ('SL','SA') and d >= ys  and d < m0)   as rev_ytd,
        -sum(net) filter (where acc_type in ('SL','SA') and d >= lys and d < m0ly) as rev_ly_ytd,
        -sum(net) filter (where acc_type in ('SL','SA') and d >= l12s and d < m0)  as rev_l12,
        -sum(net) filter (where acc_type in ('SL','SA') and d >= l3s and d < m0)   as rev_l3,
         sum(net) filter (where acc_type = 'CO' and d >= ys  and d < m0)   as co_ytd,
         sum(net) filter (where acc_type = 'CO' and d >= lys and d < m0ly) as co_ly_ytd,
         sum(net) filter (where acc_type = 'CO' and d >= l12s and d < m0)  as co_l12,
         sum(net) filter (where acc_type = 'CO' and description ilike 'PURCHASE%' and d >= l12s and d < m0) as purch_l12,
         sum(net) filter (where acc_type = 'CO' and description ilike 'PURCHASE%' and d >= l3s  and d < m0) as purch_l3,
         sum(net) filter (where acc_type = 'CO' and description ilike '%FEES PAID%' and d >= ys  and d < m0)   as plat_fee_ytd,
         sum(net) filter (where acc_type = 'CO' and description ilike '%FEES PAID%' and d >= lys and d < m0ly) as plat_fee_ly_ytd,
         sum(net) filter (where acc_type = 'CO' and description ilike '%FEES PAID%' and d >= l12s and d < m0)  as plat_fee_l12,
         sum(net) filter (where acc_type = 'EP' and d >= ys  and d < m0)   as ep_ytd,
         sum(net) filter (where acc_type = 'EP' and d >= lys and d < m0ly) as ep_ly_ytd,
         sum(net) filter (where acc_type = 'EP' and d >= l12s and d < m0)  as ep_l12,
         sum(net) filter (where acc_type = 'OI' and d >= ys  and d < m0)   as oi_ytd,
         sum(net) filter (where acc_type = 'OI' and d >= lys and d < m0ly) as oi_ly_ytd,
         sum(net) filter (where acc_type = 'OI' and d >= l12s and d < m0)  as oi_l12,
         sum(net) filter (where acc_type = 'TX' and d >= ys  and d < m0)   as tx_ytd,
         sum(net) filter (where acc_type = 'TX' and d >= lys and d < m0ly) as tx_ly_ytd,
         sum(net) filter (where acc_type = 'TX' and d >= l12s and d < m0)  as tx_l12,
         sum(net) filter (where acc_type = 'EP' and d >= ys and d < m0
                            and description ~* '(SALAR|WAGES|EPF|SOCSO|EIS|ALLOWANCE|BONUS|COMMISSION|DIRECTOR)'
                            and description !~* '(GIFT|SPONSOR|QUARTERS|FOOD|CUSTOMER|TRAINING)')            as staff_ytd,
         sum(net) filter (where acc_type = 'EP' and d >= lys and d < m0ly
                            and description ~* '(SALAR|WAGES|EPF|SOCSO|EIS|ALLOWANCE|BONUS|COMMISSION|DIRECTOR)'
                            and description !~* '(GIFT|SPONSOR|QUARTERS|FOOD|CUSTOMER|TRAINING)')            as staff_ly_ytd,
         sum(net) filter (where acc_type = 'EP' and d >= ys and d < m0 and description ilike '%ADVERT%')      as adv_ytd,
         sum(net) filter (where acc_type = 'EP' and d >= lys and d < m0ly and description ilike '%ADVERT%')   as adv_ly_ytd,
         sum(net) filter (where acc_type = 'EP' and d >= ys and d < m0 and description ilike '%COMMISSION%'
                            and description not ilike '%CUSTOMER%')                                           as comm_ytd,
         sum(net) filter (where acc_type = 'EP' and d >= ys and d < m0 and description ilike '%RENT%')        as rent_ytd,
         sum(net) filter (where acc_type = 'EP' and d >= ys and d < m0
                            and (description ilike '%TRANSPORT%' or description ilike '%PETROL%' or description ilike '%DELIVERY%')) as trans_ytd,
         sum(net) filter (where acc_type = 'EP' and d >= l12s and d < m0 and description ilike '%DEPRECIATION%') as dep_l12,
         sum(net) filter (where acc_type = 'EP' and d >= l12s and d < m0 and description ilike '%INTEREST%')     as int_l12,
         sum(dr)  filter (where sp = 'SFA' and d >= ys and d < m0)                                              as capex_ytd,
         sum(net) filter (where acc_type = 'RE' and d >= ys and d < m0)                                         as div_ytd
      from g
    ), bal as (
      select acc_no, max(description) as description, max(acc_type) as acc_type, max(sp) as sp,
             sum(net) as b_now,
             sum(net) filter (where d < ys)   as b_y0,
             sum(net) filter (where d < m0)   as b_m0,
             sum(net) filter (where d < l12s) as b_12
      from g group by acc_no
    ), bs as (
      select
        sum(b_now) filter (where sp in ('SBK','SCH') and b_now > 0) as cash_pos,
        sum(b_now) filter (where sp in ('SBK','SCH') and b_now < 0) as cash_neg,
        sum(b_now) filter (where sp in ('SBK','SCH'))               as net_cash,
        sum(b_y0)  filter (where sp in ('SBK','SCH'))               as net_cash_y0,
        sum(b_m0)  filter (where sp in ('SBK','SCH'))               as net_cash_m0,
        sum(b_12)  filter (where sp in ('SBK','SCH'))               as net_cash_12,
        sum(b_now) filter (where sp = 'SDR' and b_now > 0)          as ar_gl_pos,
        sum(b_now) filter (where sp = 'SDR' and b_now < 0)          as ar_gl_neg,
        sum(b_now) filter (where sp = 'SCR' and b_now > 0)          as ap_gl_prepaid,
        sum(b_now) filter (where sp = 'SCR' and b_now < 0)          as ap_gl_neg,
        sum(b_now) filter (where acc_type = 'CA' and sp = '' and b_now > 0)              as ca_other_pos,
        sum(b_now) filter (where acc_type = 'CA' and sp = '' and b_now < 0)              as ca_other_neg,
        sum(b_now) filter (where acc_type = 'CL' and sp = '' and b_now < 0)              as cl_other_neg,
        sum(b_now) filter (where acc_type = 'LL' and b_now < 0)                           as ll_neg,
        sum(b_now) filter (where acc_type = 'CL' and sp = '' and b_now < 0
                             and description ~* '(LOAN|HP CREDITOR|HIRE PURCHASE)' and description !~* 'LESLIE - TERM') as loans_cl_neg,
        sum(b_y0)  filter (where acc_type = 'CL' and sp = '' and b_y0 < 0
                             and description ~* '(LOAN|HP CREDITOR|HIRE PURCHASE)' and description !~* 'LESLIE - TERM') as loans_cl_neg_y0,
        sum(b_y0)  filter (where sp in ('SBK','SCH') and b_y0 < 0)                        as cash_neg_y0,
        sum(b_now) filter (where acc_type = 'CL' and sp = '' and b_now < 0
                             and description ~* '(DIRECTOR|OTHER CREDITOR)')               as sh_loans_neg,
        sum(b_now) filter (where acc_type = 'FA')                                         as fa_net
      from bal
    )
      select pl.*, bs.* from pl, bs
    ) r;
    mm := mm || j;

    ------------------------------------------------------------------ 应收（fact_ar_open 当前快照）
    select to_jsonb(r) into j from (
    with a as (
      select a.doc_type, a.doc_date, a.debtor_code, a.balance,
             (c = 'HOMEWORKSSB' and (a.debtor_code = '3000-H008' or a.debtor_code = any (plat) or a.debtor_code = any (cashc)
                                     or coalesce(d.debtor_type, '') in ('ONLINE','BRANCH'))) as excl
      from bi.fact_ar_open a
      left join bi.dim_customer d on d.company = a.company and d.debtor_code = a.debtor_code
      where a.company = c
    )
      select
        sum(balance) filter (where not excl and doc_type in ('RI','RD'))                                    as ar_inv,
        sum(balance) filter (where not excl)                                                                as ar_net,
        sum(balance) filter (where not excl and doc_type in ('RP','RC','RF'))                               as ar_unapplied,
        sum(balance) filter (where not excl and doc_type in ('RI','RD') and doc_date < current_date - 60)   as ar_over60,
        sum(balance) filter (where not excl and doc_type in ('RI','RD') and doc_date < current_date - 90)   as ar_over90,
        sum(balance) filter (where not excl and doc_type in ('RI','RD') and doc_date < current_date - 365)  as ar_over365,
        sum(balance) filter (where debtor_code = '3000-H008')                                               as ar_h008,
        sum(balance) filter (where debtor_code = any (cashc) and doc_type = 'RP')                           as cash_counter_unapplied,
        sum(balance) filter (where doc_type = 'RP')                                                         as deposits_rp,
        (select sum(t.b) from (select sum(balance) as b from a where not excl group by debtor_code having sum(balance) > 0 order by 1 desc limit 10) t) as ar_top10,
        (select sum(t.b) from (select sum(balance) as b from a where not excl group by debtor_code having sum(balance) > 0) t)                         as ar_pos_total
      from a
    ) r;
    mm := mm || j;

    ------------------------------------------------------------------ 库存
    select to_jsonb(r) into j from (
    with st as (
      select s.item_code, s.qty, s.total_cost
      from bi.fact_stock s left join bi.dim_item i on i.company = s.company and i.item_code = s.item_code
      where s.company = c and s.location not in ('DEFECTS','DISPLAY')
        and s.item_code not in ('VOUCHER','SHIPPING FEE') and s.item_code not like 'ONLINE%'
        and coalesce(i.item_group, '') <> all (srv)
    ), ls as (
      select item_code, max(doc_date) filter (where doc_type in ('IV','CS')) as last_sale,
             sum(sub_total) filter (where doc_date >= current_date - 90
                                      and not (c = 'HOMEWORKSSB' and debtor_code = '3000-H008')) as s90   -- 对外口径，与 goods_90 一致
      from bi.fact_sales where company = c group by item_code
    ), ag as (
      select a.item_code, a.stock_value from bi.fact_item_aging a where a.company = c and a.on_hand > 0
    ), low as (
      select item_code from bi.mv_alert_low_stock where company = c and days_left < 30
    ), snap as (
      select snap_date, sum(cost_pos) as cost from bi.snap_stock_group where company = c group by snap_date
    )
      select
        (select sum(total_cost) from st where qty > 0)                        as stock_cost,
        (select count(*) from st where qty < 0)                               as neg_rows,
        (select -sum(total_cost) from st where qty < 0 and total_cost < 0)    as neg_cost,
        (select sum(stock_value) from ag)                                     as aging_total,
        (select sum(ag.stock_value) from ag left join ls on ls.item_code = ag.item_code
          where ls.last_sale is null or ls.last_sale < current_date - 180)    as dead_180,
        (select sum(ag.stock_value) from ag left join ls on ls.item_code = ag.item_code
          where ls.last_sale is null)                                         as never_sold,
        (select count(*) from low)                                            as low_n,
        (select sum(ls.s90) from low join ls on ls.item_code = low.item_code) as low_s90,
        (select cost from snap order by snap_date desc limit 1)               as stock_snap_now,
        (select cost from snap where snap_date <= (select max(snap_date) from snap) - 30 order by snap_date desc limit 1) as stock_snap_30
    ) r;
    mm := mm || j;

    ------------------------------------------------------------------ 应付、采购承诺、积压、报价、业务员目标
    select to_jsonb(r) into j from (
    with ap as (
      select
        sum(balance) filter (where doc_type in ('PI','PD'))                                   as ap_inv,
        sum(balance) filter (where doc_type in ('PP','PC','PF'))                              as ap_unapplied,
        sum(balance)                                                                          as ap_net,
        sum(balance) filter (where doc_type in ('PI','PD') and doc_date < current_date - 90)  as ap_over90,
        sum(balance) filter (where creditor_code in (select creditor_code from bi.dim_supplier where company = c and name ilike 'HOMEGUARD%')) as ap_related
      from bi.fact_ap_open where company = c
    ), po as (
      select sum((qty - transferred_qty) * unit_price) as open_po,
             count(distinct po_no) as open_po_n,
             count(distinct po_no) filter (where po_date < current_date - 365) as open_po_old_n
      from bi.fact_po_line where company = c and not cancelled and qty > transferred_qty
    ), bk as (
      select sum(outstanding_amount) as backlog, count(distinct doc_no) as backlog_n,
             sum(outstanding_amount) filter (where doc_date < current_date - 90) as backlog_over90
      from bi.fact_open_order where company = c
    ), q as (
      select sum(amount) filter (where not transferred) as quote_open, sum(amount) filter (where transferred) as quote_won
      from bi.quote_open where company = c
    ), tg as (
      select (select value_num from bi.app_setting where company = c and key = 'store_month_target')  as store_target,
             (select value_num from bi.app_setting where company = c and key = 'agent_month_target')  as agent_target
    ), am as (
      select count(*) filter (where a.net >= t.tgt) as agent_hit, count(*) as agent_n
      from bi.mv_mgr_agent_month a
      cross join lateral (
        select coalesce((select value_num from bi.app_setting where company = c and key = 'agent_month_target:' || a.agent),
                        (select value_num from bi.app_setting where company = c and key = 'agent_month_target')) as tgt
      ) t
      where a.company = c and make_date(a.yr, a.mth, 1) >= l3s and make_date(a.yr, a.mth, 1) < m0
        and a.net > 50000 and a.agent <> '(未指定)' and t.tgt is not null
    )
      select ap.*, po.*, bk.*, q.*, tg.*, am.* from ap, po, bk, q, tg, am
    ) r;
    mm := mm || j;

    ------------------------------------------------------------------ 衍生：对外 GL 收入 = 收入 − 卖给分行（分行 ic_* 为空 → 等于收入）
    mm := mm || jsonb_build_object(
      'rev_ext_ytd',    (mm->>'rev_ytd')::numeric    - coalesce((mm->>'ic_ytd')::numeric, 0),
      'rev_ext_ly_ytd', (mm->>'rev_ly_ytd')::numeric - coalesce((mm->>'ic_ly_ytd')::numeric, 0),
      'rev_ext_l12',    (mm->>'rev_l12')::numeric    - coalesce((mm->>'ic_l12')::numeric, 0));

    if c = 'HOMEWORKSSB' then mh := mm; else ms := mm; end if;
  end loop;

  ------------------------------------------------------------------ 集团 = 总行对外 + 分行（只加可加的基础值）
  select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) into mg
  from (
    select k, sum(v) as v from (
      select e.key as k, e.value::numeric as v from jsonb_each_text(mh) e where e.key = any (addk)
      union all
      select e.key,      e.value::numeric      from jsonb_each_text(ms) e where e.key = any (addk)
    ) u group by k
  ) t;
  -- 集团采购 = 总行采购 + 分行向外采购（分行向总行的进货等于总行卖给分行，剔除内部往来）；对外 GL 收入也存成 rev_* 供前端统一取用
  mg := mg || jsonb_build_object(
    'purch_l12', (mg->>'purch_l12')::numeric - coalesce((mh->>'ic_l12')::numeric, 0),
    'rev_ytd', mg->'rev_ext_ytd', 'rev_ly_ytd', mg->'rev_ext_ly_ytd', 'rev_l12', mg->'rev_ext_l12');

  insert into bi.healthcheck_snapshot (company, as_of, m, refreshed_at) values
    ('HOMEWORKSSB', current_date, mh, now()),
    ('HOMEWORKSSOUTHERN', current_date, ms, now()),
    ('GROUP', current_date, mg, now())
  on conflict (company) do update set as_of = excluded.as_of, m = excluded.m, refreshed_at = excluded.refreshed_at;
end $$;

create or replace view public.bi_healthcheck with (security_invoker = true) as
select company, as_of, m, refreshed_at from bi.healthcheck_snapshot;
grant select on public.bi_healthcheck to authenticated;
