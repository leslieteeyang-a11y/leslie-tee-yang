-- 库存成本只给老板（20261019b_ops_cost_owner_only.sql）的总检查，接在其他仓库测试后面跑（用前面留下的资料）。
-- 以后新增 / 重写会回成本的函数，要用 ops.sees_cost(me)，不要再用「仓库可审批」，不然这里会失败。
\set ON_ERROR_STOP 1
create or replace function pg_temp.as_user(p_email text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('email', p_email)::text, false);
end $$;
grant execute on all functions in schema pg_temp to authenticated;

-- 1. 没有函数还用「仓库等级」决定成本
do $$ begin
  assert not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname in ('public', 'ops') and p.prokind = 'f'
       and pg_get_functiondef(p.oid) ~ '(cost|show_cost|full_cost)\s*:=\s*(lvl\s*>=|ops\.level_rank)'),
    'a function still decides cost by warehouse level: use ops.sees_cost(me)';
  assert not has_function_privilege('authenticated', 'ops.sees_cost(ops.staff)', 'execute'), 'sees_cost is internal';
end $$;

set role authenticated;
-- 2. 仓库主管（可审批）：每个会回成本的地方都拿不到成本
select pg_temp.as_user('whmgr@example.com');
do $$ declare r jsonb; begin
  r := public.ops_wh_stock('{}');
  assert not (r->>'show_cost')::boolean and not exists (select 1 from jsonb_array_elements(r->'rows') x where x->'total_cost' <> 'null'::jsonb), 'stock';
  r := public.ops_wh_stock_export('{}');
  assert not (r->>'show_cost')::boolean and not exists (select 1 from jsonb_array_elements(r->'rows') x where x->'total_cost' <> 'null'::jsonb), 'export';
  r := public.ops_wh_slow('{"min_months":0}');
  assert not (r->>'show_cost')::boolean and not exists (select 1 from jsonb_array_elements(r->'rows') x where x->'stock_value' <> 'null'::jsonb), 'slow';
  r := public.ops_wh_aged('{"kind":"old"}');
  assert not (r->>'show_cost')::boolean and (r->>'can_edit')::boolean
     and r->'summary'->'old_v' = 'null'::jsonb and r->'summary'->'nosale_v' = 'null'::jsonb and r->'summary'->'both_v' = 'null'::jsonb
     and not exists (select 1 from jsonb_array_elements(r->'rows') x where x->'stock_value' <> 'null'::jsonb), 'aged';
  r := public.ops_wh_overview('{}');
  assert not (r->>'show_cost')::boolean and not exists (select 1 from jsonb_array_elements(r->'locations') x where x->'value' <> 'null'::jsonb), 'overview';
  r := public.ops_wh_item('HOMEWORKSSB', 'ST001');
  assert not exists (select 1 from jsonb_array_elements(r->'stock') x where x->'unit_cost' <> 'null'::jsonb)
     and not exists (select 1 from jsonb_array_elements(r->'counts') x where x ? 'unit_cost' or x ? 'diff_value'), 'item';
  r := public.ops_wh_counts('{"status":"all"}');
  assert jsonb_array_length(r) > 0 and not exists (select 1 from jsonb_array_elements(r) x where x ? 'unit_cost' or x ? 'diff_value')
     and exists (select 1 from jsonb_array_elements(r) x where x ? 'diff'), 'counts: diff yes, cost no';
  r := public.ops_wh_count_stats('{"days":180}');
  assert not (r->>'show_cost')::boolean and (r->'summary'->>'value_abs')::numeric = 0
     and not exists (select 1 from jsonb_array_elements(r->'top') x where x->'value' <> 'null'::jsonb or x->'abs_value' <> 'null'::jsonb)
     and not exists (select 1 from jsonb_array_elements(r->'people') x where (x->>'value_abs')::numeric <> 0)
     and not exists (select 1 from jsonb_array_elements(r->'months') x where (x->>'value_abs')::numeric <> 0), 'count stats';
end $$;

-- 3. 老板（BI owner）：看得到
select pg_temp.as_user('boss@example.com');
do $$ begin
  assert (public.ops_wh_stock('{}')->>'show_cost')::boolean and (public.ops_wh_stock_export('{}')->>'show_cost')::boolean
     and (public.ops_wh_slow('{}')->>'show_cost')::boolean and (public.ops_wh_aged('{}')->>'show_cost')::boolean
     and (public.ops_wh_overview('{}')->>'show_cost')::boolean and (public.ops_wh_count_stats('{}')->>'show_cost')::boolean, 'owner sees cost';
end $$;
reset role;

-- 4. 店长（BI 名单 role = manager、营运系统管理员 → 仓库可审批）：一样看不到。使用者特别说「包含店长」；
--    这段挡住以后把规则放宽成「在 BI 名单上」或「营运系统管理员」（2026-10-16 审查：前面只测了不在 BI 名单上的仓库主管）
update ops.staff set role = 'admin' where lower(email) = 'mgr@example.com';
do $$ declare s ops.staff; begin
  select * into s from ops.staff where lower(email) = 'mgr@example.com';
  assert exists (select 1 from bi.allowed_users au where lower(au.email) = 'mgr@example.com' and au.role = 'manager'), 'mgr is a BI manager';
  assert ops.module_level(s, 'warehouse') = 'approve', 'mgr: warehouse approve';
  assert not ops.sees_cost(s), 'BI manager / ops admin: no cost';
end $$;
set role authenticated;
select pg_temp.as_user('mgr@example.com');
do $$ declare r jsonb; begin
  r := public.ops_wh_stock('{}');
  assert jsonb_array_length(r->'rows') > 0 and not (r->>'show_cost')::boolean
     and not exists (select 1 from jsonb_array_elements(r->'rows') x where x->'total_cost' <> 'null'::jsonb), '店长 stock';
  r := public.ops_wh_stock_export('{}');
  assert not (r->>'show_cost')::boolean and not exists (select 1 from jsonb_array_elements(r->'rows') x where x->'total_cost' <> 'null'::jsonb), '店长 export';
  r := public.ops_wh_slow('{"min_months":0}');
  assert not (r->>'show_cost')::boolean and not exists (select 1 from jsonb_array_elements(r->'rows') x where x->'stock_value' <> 'null'::jsonb), '店长 slow';
  r := public.ops_wh_aged('{"kind":"old"}');
  assert jsonb_array_length(r->'rows') > 0 and not (r->>'show_cost')::boolean and (r->>'can_edit')::boolean
     and r->'summary'->'old_v' = 'null'::jsonb and r->'summary'->'nosale_v' = 'null'::jsonb and r->'summary'->'both_v' = 'null'::jsonb
     and not exists (select 1 from jsonb_array_elements(r->'rows') x where x->'stock_value' <> 'null'::jsonb), '店长 aged';
  r := public.ops_wh_overview('{}');
  assert not (r->>'show_cost')::boolean and not exists (select 1 from jsonb_array_elements(r->'locations') x where x->'value' <> 'null'::jsonb), '店长 overview';
  r := public.ops_wh_item('HOMEWORKSSB', 'ST001');
  assert jsonb_array_length(r->'stock') > 0 and not exists (select 1 from jsonb_array_elements(r->'stock') x where x->'unit_cost' <> 'null'::jsonb)
     and not exists (select 1 from jsonb_array_elements(r->'counts') x where x ? 'unit_cost' or x ? 'diff_value'), '店长 item';
  r := public.ops_wh_counts('{"status":"all"}');
  assert jsonb_array_length(r) > 0 and not exists (select 1 from jsonb_array_elements(r) x where x ? 'unit_cost' or x ? 'diff_value'), '店长 counts';
  r := public.ops_wh_count_stats('{"days":180}');
  assert not (r->>'show_cost')::boolean and (r->'summary'->>'value_abs')::numeric = 0
     and not exists (select 1 from jsonb_array_elements(r->'top') x where x->'value' <> 'null'::jsonb), '店长 count stats';
end $$;
reset role;

select 'cost_test ok';
