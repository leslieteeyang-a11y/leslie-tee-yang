-- 2026-10-08：「毛利分析」提速，migration：margin_coarse_mv。
--
-- 为什么：第一版 RPC 直接读 bi.mv_margin_month（商品 × 渠道 × 业务员 × 月，HQ 近 12 个月 26,786 行），
-- 在 RPC 里对它来回扫 8～9 次（KPI、类别、品牌、渠道、业务员、商品、参考成本、趋势），
-- 加上 work_mem 只有 2MB、CTE 溢写到暂存档，以老板身份实测 3.1 秒，超过 1.5 秒的目标。
-- 这台 Supabase 机器扫一行约 8 微秒，所以要减少「行数 × 次数」：
--   * bi.mv_margin_item_month：商品 × 月（只多一个 is_branch 旗标给「不含分行」开关用），HQ 12 个月约 1.4 万行，
--     RPC 只扫一次就得到全部商品数字（含服务 / 无代号行、参考成本）。
--   * bi.mv_margin_dim_month：渠道 × 业务员 × 行类别 × 月，HQ 12 个月约 350 行，KPI / 渠道 / 业务员 / 趋势都从这里算。
-- 两个都从 bi.mv_margin_month 汇总（不再扫 fact_sales），重算各约 1 秒；定义里 order by (company, yr, mth)
-- 让 (company, yr, mth) 范围扫描读连续的页。
-- 口径与 bi.mv_margin_month 完全相同（只是再加总），所以数字不变。

create materialized view if not exists bi.mv_margin_item_month as
select company, yr, mth, item_code,
       (channel = '分行')  as is_branch,
       line_class, item_group, item_type,
       sum(qty)          as qty,
       sum(net)          as net,
       sum(cost)         as cost,
       sum(qty_costed)   as qty_costed,
       sum(net_costed)   as net_costed,
       sum(cost_costed)  as cost_costed,
       sum(qty_nocost)   as qty_nocost,
       sum(net_nocost)   as net_nocost,
       sum(lines)        as lines,
       sum(lines_nocost) as lines_nocost
from bi.mv_margin_month
group by company, yr, mth, item_code, (channel = '分行'), line_class, item_group, item_type
order by company, yr, mth, item_code;

create unique index if not exists mv_margin_item_month_uk
  on bi.mv_margin_item_month (company, yr, mth, item_code, is_branch);

create materialized view if not exists bi.mv_margin_dim_month as
select company, yr, mth, channel, sales_agent, line_class,
       sum(qty)          as qty,
       sum(net)          as net,
       sum(cost)         as cost,
       sum(qty_costed)   as qty_costed,
       sum(net_costed)   as net_costed,
       sum(cost_costed)  as cost_costed,
       sum(qty_nocost)   as qty_nocost,
       sum(net_nocost)   as net_nocost,
       sum(lines)        as lines,
       sum(lines_nocost) as lines_nocost
from bi.mv_margin_month
group by company, yr, mth, channel, sales_agent, line_class
order by company, yr, mth;

create unique index if not exists mv_margin_dim_month_uk
  on bi.mv_margin_dim_month (company, yr, mth, channel, sales_agent, line_class);

grant select on bi.mv_margin_item_month to authenticated, service_role;
grant select on bi.mv_margin_dim_month  to authenticated, service_role;

-- 重算顺序：先细的（扫 fact_sales），再两个粗的（从细的加总）
create or replace function bi.refresh_margin()
returns void
language plpgsql
security definer
set search_path to ''
as $$
declare
  t0 timestamptz := clock_timestamp();
  n  bigint;
begin
  refresh materialized view concurrently bi.mv_margin_month;
  refresh materialized view concurrently bi.mv_margin_item_month;
  refresh materialized view concurrently bi.mv_margin_dim_month;
  select count(*) into n from bi.mv_margin_month;
  insert into bi.margin_refresh_log (id, refreshed_at, mv_rows, took_ms)
  values (1, now(), n, (extract(epoch from clock_timestamp() - t0) * 1000)::integer)
  on conflict (id) do update
    set refreshed_at = excluded.refreshed_at, mv_rows = excluded.mv_rows, took_ms = excluded.took_ms;
end $$;
revoke execute on function bi.refresh_margin() from public;
