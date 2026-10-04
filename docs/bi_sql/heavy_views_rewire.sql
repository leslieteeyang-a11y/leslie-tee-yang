-- 2026-10-04 BI 页面提速：把 15 个最慢的 public 视图改读物化视图（bi.mv_*）。
-- 物化视图由 migration heavy_views_materialized 建立，pg_cron 每 2 小时（25 */2 * * *）
-- 跑 bi.refresh_heavy_views() 重算；页面只读结果，从 3～18 秒降到毫秒级。
-- 物化视图没有 RLS，所以每个视图都补 bi_is_allowed() + 公司过滤
-- （bi_company() 为 null = owner 看全部），角色门槛与原视图相同。
-- 栏位顺序 / 型别必须与原视图一致（create or replace view 的限制）。

-- ───────── 商品 ─────────
create or replace view public.bi_item_rank_m with (security_invoker = true) as
select company, yr, mth, item_code, item_description, item_group, qty, net, profit
from bi.mv_sales_item_month
where (select bi_is_allowed())
  and ((select bi_company()) is null or company = (select bi_company()))
  and coalesce((select bi_role()), '') not in ('manager', 'sales')
  and item_code is not null
  and item_code not in ('VOUCHER', 'SHIPPING FEE')
  and item_code not like 'ONLINE%';

create or replace view public.bi_item_rank_m_nc with (security_invoker = true) as
select company, yr, mth, item_code, item_description, item_group, qty, net
from bi.mv_sales_item_month
where (select bi_is_allowed())
  and ((select bi_company()) is null or company = (select bi_company()))
  and item_code is not null
  and item_code not in ('VOUCHER', 'SHIPPING FEE')
  and item_code not like 'ONLINE%';

create or replace view public.bi_sales_by_item_m with (security_invoker = true) as
select company, yr, mth, item_code, item_description, qty, net, profit
from bi.mv_sales_item_month
where (select bi_is_allowed())
  and ((select bi_company()) is null or company = (select bi_company()))
  and coalesce((select bi_role()), '') not in ('manager', 'sales');

create or replace view public.bi_sales_by_item_y with (security_invoker = true) as
select company, yr, max(item_code) as item_code, max(item_description) as item_description,
       sum(qty) as qty, sum(net) as net, sum(profit) as profit
from bi.mv_sales_item_month
where (select bi_is_allowed())
  and ((select bi_company()) is null or company = (select bi_company()))
  and coalesce((select bi_role()), '') not in ('manager', 'sales')
group by company, yr, item_key;

create or replace view public.bi_sales_by_item_y_nc with (security_invoker = true) as
select company, yr, max(item_code) as item_code, max(item_description) as item_description,
       sum(qty) as qty, sum(net) as net
from bi.mv_sales_item_month
where (select bi_is_allowed())
  and ((select bi_company()) is null or company = (select bi_company()))
group by company, yr, item_key;

-- ───────── 客户 ─────────
create or replace view public.bi_sales_by_customer_m with (security_invoker = true) as
select company, yr, mth, debtor_code, debtor_name, net, profit
from bi.mv_sales_customer_month
where (select bi_is_allowed())
  and ((select bi_company()) is null or company = (select bi_company()))
  and coalesce((select bi_role()), '') not in ('manager', 'sales');

create or replace view public.bi_sales_by_customer_y with (security_invoker = true) as
select company, yr, max(debtor_code) as debtor_code, max(debtor_name) as debtor_name,
       sum(net) as net, sum(profit) as profit
from bi.mv_sales_customer_month
where (select bi_is_allowed())
  and ((select bi_company()) is null or company = (select bi_company()))
  and coalesce((select bi_role()), '') not in ('manager', 'sales')
group by company, yr, debtor_key;

create or replace view public.bi_sales_by_customer_y_nc with (security_invoker = true) as
select company, yr, max(debtor_code) as debtor_code, max(debtor_name) as debtor_name,
       sum(net) as net
from bi.mv_sales_customer_month
where (select bi_is_allowed())
  and ((select bi_company()) is null or company = (select bi_company()))
group by company, yr, debtor_key;

-- ───────── 警示 ─────────
create or replace view public.bi_alert_customer_decline with (security_invoker = true) as
select company, debtor_code, debtor_name, sales_agent, debtor_type,
       net_prev, net_cur, change_pct, last_order
from bi.mv_alert_customer_decline
where (select bi_is_allowed())
  and ((select bi_company()) is null or company = (select bi_company()));

create or replace view public.bi_alert_overdue_shipping with (security_invoker = true) as
select company, debtor_code, debtor_name, sales_agent, overdue_amt, net_balance,
       oldest_overdue, oldest_days, shipped_30d, invoices_30d, last_ship
from bi.mv_alert_overdue_shipping
where (select bi_is_allowed())
  and ((select bi_company()) is null or company = (select bi_company()));

-- ───────── 店长页 ─────────
create or replace view public.bi_mgr_customer_inactive with (security_invoker = true) as
select company, debtor_code, name, debtor_type, sales_agent, net_prev12, last_iv, days_since
from bi.mv_mgr_customer_inactive
where (select bi_is_allowed())
  and ((select bi_company()) is null or company = (select bi_company()));

create or replace view public.bi_mgr_channel_month with (security_invoker = true) as
select company, yr, mth, channel, is_store, net, orders, net_mtd_equiv
from bi.mv_mgr_channel_month
where (select bi_is_allowed())
  and ((select bi_company()) is null or company = (select bi_company()));

create or replace view public.bi_mgr_agent_month with (security_invoker = true) as
select company, yr, mth, agent, net, orders, cust_n
from bi.mv_mgr_agent_month
where (select bi_is_allowed())
  and ((select bi_company()) is null or company = (select bi_company()));

-- ───────── 调价效果（只给 owner）─────────
create or replace view public.bi_price_effect with (security_invoker = true) as
select company, item_code, description, item_group, item_type, change_date,
       prev_p1, new_p1, new_p2, days_after, qty_before, net_before, qty_after, net_after,
       daily_before, daily_after, avg_price_before, avg_price_after
from bi.mv_price_effect
where (select bi_is_allowed())
  and ((select bi_company()) is null or company = (select bi_company()))
  and coalesce((select bi_role()), '') = 'owner';
