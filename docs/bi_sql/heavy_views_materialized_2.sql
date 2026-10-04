-- 2026-10-04 晚：总览页仍超时（bi_sales_monthly / bi_sales_daily 每次整表扫 fact_sales 326MB，
-- 两条并发 + 手机冷快取就超过 8 秒）。把前端还会直接扫 fact_sales 的 4 组视图也改成物化视图：
-- 总览的月汇总 / 逐日汇总、店长页的渠道逐日、低库存警示。migration：heavy_views_materialized_2。
create materialized view if not exists bi.mv_sales_monthly as
select company,
       extract(year from doc_date)::integer  as yr,
       extract(month from doc_date)::integer as mth,
       sum(sub_total) as net,
       sum(cost)      as cost,
       sum(profit)    as profit,
       count(*) filter (where doc_type in ('IV','CS')) as iv_lines,
       count(*) filter (where doc_type = 'CN')         as cn_lines
from bi.fact_sales
group by company, 2, 3
with no data;
create unique index if not exists mv_sales_monthly_uk on bi.mv_sales_monthly (company, yr, mth);

create materialized view if not exists bi.mv_sales_daily as
select company, doc_date,
       sum(sub_total) as net,
       count(distinct doc_no) filter (where doc_type in ('IV','CS')) as orders
from bi.fact_sales
group by company, doc_date
with no data;
create unique index if not exists mv_sales_daily_uk on bi.mv_sales_daily (company, doc_date);

create materialized view if not exists bi.mv_mgr_channel_daily as
select s.company, s.doc_date,
       bi.sale_channel(s.debtor_code, c.debtor_type) as channel,
       coalesce(bi.sale_channel(s.debtor_code, c.debtor_type), '') as channel_key,
       bi.sale_channel(s.debtor_code, c.debtor_type) in ('门市现金','B2B客户') as is_store,
       sum(s.sub_total) as net,
       count(distinct s.doc_no) filter (where s.doc_type in ('IV','CS')) as orders
from bi.fact_sales s
left join bi.dim_customer c on c.company = s.company and c.debtor_code = s.debtor_code
where s.doc_date >= current_date - 70
group by s.company, s.doc_date, 3, 4, 5
with no data;
create unique index if not exists mv_mgr_channel_daily_uk on bi.mv_mgr_channel_daily (company, doc_date, channel_key);

create materialized view if not exists bi.mv_alert_low_stock as
with sold as (
  select company, item_code, sum(qty) as qty_90d
  from bi.fact_sales
  where doc_date >= current_date - 90 and item_code is not null
  group by company, item_code
  having sum(qty) > 0
), stock as (
  select company, item_code, sum(qty) as on_hand
  from bi.fact_stock
  where location not in ('DEFECTS','DISPLAY')
  group by company, item_code
)
select s.company, s.item_code,
       coalesce(i.description, s.item_code) as item_description,
       i.item_group,
       coalesce(st.on_hand, 0) as on_hand,
       round(s.qty_90d / 90.0, 2) as daily_avg,
       round(coalesce(st.on_hand, 0) / nullif(s.qty_90d / 90.0, 0), 0)::integer as days_left,
       s.qty_90d
from sold s
left join stock st on st.company = s.company and st.item_code = s.item_code
left join bi.dim_item i on i.company = s.company and i.item_code = s.item_code
where s.item_code not in ('VOUCHER','SHIPPING FEE') and s.item_code not like 'ONLINE%'
  and coalesce(st.on_hand, 0) >= 0
  and (coalesce(st.on_hand, 0) / nullif(s.qty_90d / 90.0, 0)) < 30
with no data;
create unique index if not exists mv_alert_low_stock_uk on bi.mv_alert_low_stock (company, item_code);

grant select on bi.mv_sales_monthly, bi.mv_sales_daily, bi.mv_mgr_channel_daily, bi.mv_alert_low_stock
  to authenticated, service_role;

-- 并行重算全部 13 个 mv（concurrently：重算时页面照常可读）
create or replace function bi.refresh_heavy_views() returns void
language plpgsql security definer set search_path = '' as $$
begin
  refresh materialized view concurrently bi.mv_sales_monthly;
  refresh materialized view concurrently bi.mv_sales_daily;
  refresh materialized view concurrently bi.mv_sales_item_month;
  refresh materialized view concurrently bi.mv_sales_customer_month;
  refresh materialized view concurrently bi.mv_alert_customer_decline;
  refresh materialized view concurrently bi.mv_alert_overdue_shipping;
  refresh materialized view concurrently bi.mv_alert_low_stock;
  refresh materialized view concurrently bi.mv_mgr_customer_inactive;
  refresh materialized view concurrently bi.mv_mgr_channel_month;
  refresh materialized view concurrently bi.mv_mgr_channel_daily;
  refresh materialized view concurrently bi.mv_mgr_agent_month;
  refresh materialized view concurrently bi.mv_price_effect;
  refresh materialized view concurrently bi.mv_purchase_sold;
end $$;
