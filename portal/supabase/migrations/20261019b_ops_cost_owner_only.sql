-- 库存成本只给老板（2026-10-16）。使用者看了「仓库 → 库存总表」（成本值）与「旧货」（成本、上面三格的 RM 金额）：
-- 「这两个地方都看到成本，我都要收起来，不要让职员看到，包含店长」。
-- 以前：仓库「可审批」（主管、管理层、店长）就拿得到成本。现在：只有 BI 名单上 role = 'owner' 的人（老板）拿得到。
-- 范围 = 仓库模块所有会回成本的地方：库存总表（含下载 Excel）、旧货（成本栏与三格金额）、滞销品（库存成本值）、总览（各仓位金额）、
-- 查货（单位成本）、盘点纪录 / 差异审核（单位成本、成本差额）、盘点单明细（成本差额）、盘点统计（差异金额）。
-- 其余权限都不变：旧货的「标处理方式」照旧是仓库「可审批」；盘点的应有 / 差额（件数）照旧给可审批。
-- 订货模块的进货单价（ops.sees_prices，采购要用来下单）不在这次范围。
-- 做法：ops.sees_cost(me) 判断；下面的 DO 段读出每个函数的现行定义，只把判断成本的那几个字换掉（其余一字不动），可以重复套用。
-- 以后新增或重写会回成本的函数，一律用 ops.sees_cost(me)，不要再用「仓库可审批」；tests/cost_test.sql 会挡。

create or replace function ops.sees_cost(p_staff ops.staff) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(p_staff.id is not null and exists (
           select 1 from bi.allowed_users au
            where lower(au.email) = lower(p_staff.email) and au.role = 'owner'), false)
$$;
revoke all on function ops.sees_cost(ops.staff) from public, anon, authenticated;

do $m$
declare
  r record;
  d text;
  n int;
begin
  for r in select * from (values
    -- 旧货：成本只给老板；「标处理方式」照旧给仓库可审批（以前跟成本绑在一起）
    (1, 'public.ops_wh_aged(jsonb)', 1,
     $o$cost := ops.level_rank(ops.module_level(me, 'warehouse')) >= 3;$o$,
     $n$cost := ops.sees_cost(me);$n$),
    (2, 'public.ops_wh_aged(jsonb)', 1,
     $o$'can_edit', cost,$o$,
     $n$'can_edit', ops.level_rank(ops.module_level(me, 'warehouse')) >= 3,$n$),
    -- 库存总表、下载 Excel、滞销品
    (3, 'public.ops_wh_stock(jsonb)', 1,
     $o$cost := ops.level_rank(ops.module_level(me, 'warehouse')) >= 3;$o$,
     $n$cost := ops.sees_cost(me);$n$),
    (4, 'public.ops_wh_stock_export(jsonb)', 1,
     $o$cost := ops.level_rank(ops.module_level(me, 'warehouse')) >= 3;$o$,
     $n$cost := ops.sees_cost(me);$n$),
    (5, 'public.ops_wh_slow(jsonb)', 1,
     $o$cost := ops.level_rank(ops.module_level(me, 'warehouse')) >= 3;$o$,
     $n$cost := ops.sees_cost(me);$n$),
    -- 总览：各仓位金额
    (6, 'public.ops_wh_overview(jsonb)', 1,
     $o$cost := lvl >= 3;$o$,
     $n$cost := ops.sees_cost(me);$n$),
    -- 查货：单位成本（盘点纪录走 ops.wh_count_json，下面另外改）
    (7, 'public.ops_wh_item(text,text)', 1,
     $o$'unit_cost', case when full_access and f.qty > 0 then$o$,
     $n$'unit_cost', case when full_access and ops.sees_cost(me) and f.qty > 0 then$n$),
    -- 盘点纪录（查货、差异审核、盘点）：应有 / 差额照旧给可审批（p_full），单位成本与成本差额只给老板
    (8, 'ops.wh_count_json(ops.wh_count,boolean)', 1,
     $o$'diff', c.qty - (c.system_qty + c.pending_qty), 'unit_cost', c.unit_cost,
    'diff_value', round((c.qty - (c.system_qty + c.pending_qty)) * coalesce(c.unit_cost, 0), 2),
    'synced_at', c.synced_at) else '{}'::jsonb end$o$,
     $n$'diff', c.qty - (c.system_qty + c.pending_qty),
    'synced_at', c.synced_at) else '{}'::jsonb end
  || case when p_full and ops.sees_cost(ops.current_staff()) then jsonb_build_object(
    'unit_cost', c.unit_cost,
    'diff_value', round((c.qty - (c.system_qty + c.pending_qty)) * coalesce(c.unit_cost, 0), 2)) else '{}'::jsonb end$n$),
    -- 盘点单明细：成本差额
    (9, 'public.ops_wh_sheet_get(jsonb)', 1,
     $o$'diff_value', round((k.qty - (k.system_qty + k.pending_qty)) * coalesce(k.unit_cost, 0), 2))$o$,
     $n$'diff_value', case when ops.sees_cost(me) then round((k.qty - (k.system_qty + k.pending_qty)) * coalesce(k.unit_cost, 0), 2) end)$n$),
    -- 盘点统计（可审批才打得开）：差异金额只给老板，其他人金额都是 0、show_cost = false（画面藏起金额）
    (10, 'public.ops_wh_count_stats(jsonb)', 1,
     $o$td date := ops.today();
begin
  me := ops.require_level('warehouse', 'approve');$o$,
     $n$td date := ops.today();
  cost boolean;
begin
  me := ops.require_level('warehouse', 'approve');
  cost := ops.sees_cost(me);$n$),
    (11, 'public.ops_wh_count_stats(jsonb)', 2,
     $o$round((x.qty - (x.system_qty + x.pending_qty)) * coalesce(x.unit_cost, 0), 2) val,$o$,
     $n$case when cost then round((x.qty - (x.system_qty + x.pending_qty)) * coalesce(x.unit_cost, 0), 2) end val,$n$),
    (12, 'public.ops_wh_count_stats(jsonb)', 1,
     $o$'company', c, 'days', d,$o$,
     $n$'company', c, 'show_cost', cost, 'days', d,$n$)
  ) v(ord, fn, cnt, old, new) order by ord
  loop
    d := pg_get_functiondef(r.fn::regprocedure);
    n := (length(d) - length(replace(d, r.old, ''))) / length(r.old);
    if n = 0 and position(r.new in d) > 0 then
      continue;                                   -- 已经改过（重复套用）
    end if;
    if n <> r.cnt then
      raise exception '成本只给老板：% 找到 % 处要换的字（应该是 % 处），函数可能被改过，请对照 migration 手动改：%', r.fn, n, r.cnt, r.old;
    end if;
    execute replace(d, r.old, r.new);
  end loop;
end $m$;
