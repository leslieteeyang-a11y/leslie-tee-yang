-- 2026-10-04 晚：总览 / 店长页 / 低库存警示用的 5 个视图改读 bi.mv_*（见 heavy_views_materialized_2.sql）。
-- migration：heavy_views_rewire_2。栏位顺序与原视图一致；补 bi_is_allowed() + 公司过滤，角色门槛照旧。
create or replace view public.bi_sales_monthly with (security_invoker = true) as
select company, yr, mth, net, cost, profit, iv_lines, cn_lines
from bi.mv_sales_monthly
where (select bi_is_allowed())
  and ((select bi_company()) is null or company = (select bi_company()))
  and coalesce((select bi_role()), '') not in ('manager', 'sales');

create or replace view public.bi_sales_monthly_nc with (security_invoker = true) as
select company, yr, mth, net, iv_lines, cn_lines
from bi.mv_sales_monthly
where (select bi_is_allowed())
  and ((select bi_company()) is null or company = (select bi_company()));

create or replace view public.bi_sales_daily with (security_invoker = true) as
select company, doc_date, net, orders
from bi.mv_sales_daily
where (select bi_is_allowed())
  and ((select bi_company()) is null or company = (select bi_company()));

create or replace view public.bi_mgr_channel_daily with (security_invoker = true) as
select company, doc_date, channel, is_store, net, orders
from bi.mv_mgr_channel_daily
where (select bi_is_allowed())
  and ((select bi_company()) is null or company = (select bi_company()));

create or replace view public.bi_alert_low_stock with (security_invoker = true) as
select company, item_code, item_description, item_group, on_hand, daily_avg, days_left, qty_90d
from bi.mv_alert_low_stock
where (select bi_is_allowed())
  and ((select bi_company()) is null or company = (select bi_company()));
