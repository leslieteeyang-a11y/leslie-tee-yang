-- 【2026-10-10 已被 health_fix1 取代】三个视图的现行定义见 health_fix1.sql（改读 bi.health_sales_daily()；
--  bi_health_now 的 as_of 改成按公司「已完整同步的最后一天」，尾端加 ly_as_of / synced_at；bi_health_snapshot 尾端加 sales_through / sales_synced_at）。
-- 2026-10-08：「健康度」分页（BI 网页 src/pages/Health.tsx）读的三个 public 视图。migration：health_views。
-- 权限照既有做法：security_invoker + bi_is_allowed() + bi_company() 公司过滤；
-- 含成本 / 毛利 / 余额，所以再加 bi_role() = 'owner'（店长 / 订货员读到 0 行）。
-- 底层：bi.mv_health_sales_daily（物化视图，约 2,300 行）、bi.fact_gl（约 2 万行）、bi.health_snapshot（每日一行），
-- 都很小，前端每个查询 < 50ms；比率与红黄绿灯号在前端算（门槛是 Health.tsx 里的常数）。

-- ① 月度：销售流量（含可信毛利率的分子分母、没成本行）+ 总账（销售 / 退货调整 / 成本科目 / 进货 / 营业费用）
--    只给近 37 个月（12 个月趋势 + 去年同期 + 本月）。
--    gl_sales = SL 科目 −net（销售为贷方）；gl_sa = SA 科目 net（退货 / 折让，正数 = 减少销售）；
--    gl_co = CO 科目 net（AutoCount 这里是「进货 + 平台手续费 + 运费 + 包材」，没有期初 / 期末存货调整，
--            所以不是真正的销货成本，只供参考）；gl_purch = CO 里 PURCHASES / PURCHASES RETURN；gl_ep = 营业费用。
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
  from bi.mv_health_sales_daily
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

-- ② 现在：本月至今 / 年初至今 与去年同期（同样的日期区间，不是按天数比例推算）。
--    as_of = 马来西亚时间的今天（含今天已同步的部分）；_ic = 卖给分行（集团内）的部分。
create or replace view public.bi_health_now with (security_invoker = true) as
with p as (
  select (now() at time zone 'Asia/Kuala_Lumpur')::date as as_of
), d as (
  select m.company, p.as_of,
         max(m.doc_date) as last_sales_date,
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
  from bi.mv_health_sales_daily m
  cross join p
  where m.doc_date >= (date_trunc('year', p.as_of) - interval '1 year')::date
  group by m.company, p.as_of
)
select d.company, d.as_of, d.last_sales_date,
       coalesce(d.mtd_net, 0)    as mtd_net,    coalesce(d.mtd_ic, 0)    as mtd_ic,
       coalesce(d.ly_mtd_net, 0) as ly_mtd_net, coalesce(d.ly_mtd_ic, 0) as ly_mtd_ic,
       coalesce(d.ytd_net, 0)    as ytd_net,    coalesce(d.ytd_ic, 0)    as ytd_ic,
       coalesce(d.ly_ytd_net, 0) as ly_ytd_net, coalesce(d.ly_ytd_ic, 0) as ly_ytd_ic,
       (select max(h.refreshed_at) from bi.health_snapshot h where h.company = d.company) as refreshed_at
from d
where (select public.bi_is_allowed())
  and coalesce((select public.bi_role()), '') = 'owner'
  and ((select public.bi_company()) is null or d.company = (select public.bi_company()));

-- ③ 每日余额快照（库存 / 应收 / 应付 / 滞销 + 当天的近 90 天流量），近 400 天。
--    库存天数 / 应收天数 / 应付天数 / 现金周期 / 滞销占比的「现在」与趋势都从这里算。
create or replace view public.bi_health_snapshot with (security_invoker = true) as
select h.company, h.snap_date, h.source,
       h.stock_cost, h.stock_excluded, h.stock_neg, h.slow_cost, h.aging_total,
       h.ar_pos, h.ar_neg, h.ar_over90, h.ar_ic, h.ap_pos, h.ap_neg,
       h.sales_90, h.sales_costed_90, h.cost_costed_90, h.sales_nocost_90,
       h.purch_3m, h.purch_days, h.refreshed_at
from bi.health_snapshot h
where h.snap_date >= ((now() at time zone 'Asia/Kuala_Lumpur')::date - 400)
  and (select public.bi_is_allowed())
  and coalesce((select public.bi_role()), '') = 'owner'
  and ((select public.bi_company()) is null or h.company = (select public.bi_company()));

grant select on public.bi_health_monthly  to authenticated;
grant select on public.bi_health_now      to authenticated;
grant select on public.bi_health_snapshot to authenticated;
