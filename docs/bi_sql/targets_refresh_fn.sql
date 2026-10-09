-- 2026-10-08：「目标」分页的重算函数。migration：targets_refresh_fn。
-- bi.refresh_targets() 只做一件事：concurrently 重算 bi.mv_targets_daily（约 2.6 秒），
-- concurrently 让重算期间前端照样读得到旧资料、不会被锁住。
-- 由 pg_cron bi_targets_refresh 每 2 小时第 55 分呼叫（避开 15 / 25 / 35 / 45 分的 onepager / heavy_views /
-- health / margin 重算，不同时扫 fact_sales）。
-- security definer + search_path ''：cron 以 postgres 跑；前端角色不能呼叫（revoke public、不 grant 给 authenticated / anon）。
create or replace function bi.refresh_targets()
returns void
language plpgsql
security definer
set search_path to ''
as $fn$
begin
  refresh materialized view concurrently bi.mv_targets_daily;
end
$fn$;

-- 只给排程（postgres）跑，前端角色不能呼叫
revoke execute on function bi.refresh_targets() from public;
