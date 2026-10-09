-- 2026-10-08：修正 bi.refresh_margin()，migration：margin_refresh_fn_fix。
--
-- 为什么：套用 margin_badcost_mv 时，送进资料库的版本在最后的 on conflict 子句打错了栏名
-- （set refresh_at_placeholder = 1），plpgsql 建函数时不检查栏名，所以建成功、但每次执行会在写记录那一步报错，
-- 整个函数（含前面的四个 refresh）都会回滚 → 毛利分析的数字不会更新。
-- 这里用正确版本覆盖（与 margin_badcost_mv.sql 档案里写的一样）：依序重算四个物化视图，再写 margin_refresh_log。
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
  refresh materialized view concurrently bi.mv_margin_badcost;
  select count(*) into n from bi.mv_margin_month;
  insert into bi.margin_refresh_log (id, refreshed_at, mv_rows, took_ms)
  values (1, now(), n, (extract(epoch from clock_timestamp() - t0) * 1000)::integer)
  on conflict (id) do update
    set refreshed_at = excluded.refreshed_at, mv_rows = excluded.mv_rows, took_ms = excluded.took_ms;
end $$;
revoke execute on function bi.refresh_margin() from public;
