-- 仓库测试（接在 leave_test.sql 之后跑）。HQ 库存（stub）：ST001 5、ST002 −2、ST003 10、ST004 4；SRGADING ST001 3。
\set ON_ERROR_STOP 1
create or replace function pg_temp.as_user(p_email text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('email', p_email)::text, false);
end $$;
create or replace function pg_temp.at(p_ts text) returns void language plpgsql as $$
begin
  perform set_config('ops.fake_now', p_ts, false);
end $$;
create or replace function pg_temp.expect_error(p_sql text, p_like text) returns void language plpgsql as $$
begin
  execute p_sql;
  raise exception 'expected error "%" from: %', p_like, p_sql;
exception when others then
  if sqlerrm like 'expected error%' or sqlerrm not like '%' || p_like || '%' then
    raise;
  end if;
end $$;
grant execute on all functions in schema pg_temp to authenticated;

-- 新仓库员工（可编辑）与仓库主管（manager → 可审批）
set role authenticated;
select pg_temp.as_user('boss@example.com');
select public.ops_staff_save('{"email":"picker@example.com","name":"仓库阿强","department":"warehouse","branch":"HOMEWORKSSB"}');
select public.ops_staff_save('{"email":"whmgr@example.com","name":"仓库主管","department":"warehouse","branch":"HOMEWORKSSB","role":"manager"}');
select pg_temp.at('2026-10-21 10:00:00+08');

-- 1. 设定、查货
select pg_temp.as_user('picker@example.com');
do $$ declare m jsonb := public.ops_wh_meta(); i jsonb; f jsonb; begin
  assert m->>'level' = 'edit' and m->'companies' = '["HOMEWORKSSB"]'::jsonb, 'meta: ' || m::text;
  assert exists (select 1 from jsonb_array_elements(m->'locations') l where l->>'code' = 'SRGADING'), 'locations seeded';
  f := public.ops_wh_find('', 'hemos basin');
  assert jsonb_array_length(f) = 1 and f->0->>'item_code' = 'ST003', 'find by words: ' || f::text;
  i := public.ops_wh_item('', ' st003 ');
  assert (i->>'found')::boolean and i->>'item_code' = 'ST003' and jsonb_array_length(i->'open_orders') = 1, 'item: ' || i::text;
  assert (select (s->>'unit_cost') from jsonb_array_elements(i->'stock') s where s->>'location' = 'HQ') is null,
    'edit level does not see cost';
  assert not (public.ops_wh_item('', 'NOPE')->>'found')::boolean, 'not found';
end $$;
select pg_temp.expect_error($q$select public.ops_wh_find('HOMEWORKSSOUTHERN', 'raxon')$q$, '分店');
-- 纸箱条码绑定
select public.ops_wh_barcode_bind('', '9551234567890', 'ST003');
do $$ begin assert public.ops_wh_item('', '9551234567890')->>'item_code' = 'ST003', 'barcode bound'; end $$;
select pg_temp.expect_error($q$select public.ops_wh_barcode_bind('', 'ST004', 'ST003')$q$, '另一个商品');
-- 门市（销售部）只能看
select pg_temp.as_user('hqsales@example.com');
do $$ begin assert public.ops_wh_meta()->>'level' = 'view', 'sales view'; end $$;
select pg_temp.expect_error($q$select public.ops_wh_move_save('{"item_code":"ST003","qty":1,"kind":"defect","from_loc":"HQ"}')$q$, '仓库');

-- 2. 搬动：HQ → DEFECTS 报坏 2 件（还没输入 AutoCount）
select pg_temp.as_user('picker@example.com');
select pg_temp.expect_error($q$select public.ops_wh_move_save('{"item_code":"ST003","qty":1,"kind":"transfer","from_loc":"HQ"}')$q$, '到哪个仓位');
select pg_temp.expect_error($q$select public.ops_wh_move_save('{"item_code":"ST003","qty":1,"kind":"transfer","from_loc":"HQ","to_loc":"HQ"}')$q$, '同一个仓位');
select pg_temp.expect_error($q$select public.ops_wh_move_save('{"item_code":"ST003","qty":1,"kind":"writeoff","from_loc":"HQ"}')$q$, '写原因');
select pg_temp.expect_error($q$select public.ops_wh_move_save('{"item_code":"ST003","qty":1,"kind":"transfer","from_loc":"HQ","to_loc":"MARS"}')$q$, '没有这个仓位');
do $$ declare m jsonb; i jsonb; begin
  m := public.ops_wh_move_save('{"item_code":"9551234567890","qty":2,"kind":"defect","from_loc":"HQ","to_loc":"DEFECTS","note":"破了"}');
  assert m->>'item_code' = 'ST003' and m->>'status' = 'pending' and m->>'created_by_name' = '仓库阿强', 'move: ' || m::text;
  i := public.ops_wh_item('', 'ST003');
  assert (select (s->>'pending')::numeric from jsonb_array_elements(i->'stock') s where s->>'location' = 'HQ') = -2
     and (select (s->>'pending')::numeric from jsonb_array_elements(i->'stock') s where s->>'location' = 'DEFECTS') = 2,
    'pending shown: ' || (i->'stock')::text;
end $$;
select pg_temp.expect_error($q$select public.ops_wh_move_mark(array[1::bigint], 'done', 'ST-0001')$q$, '可审批');

-- 3. 盘点 HQ：负库存的 ST002 排第一，然后卖得多的 ST003；清单不含系统数量
do $$ declare l jsonb := public.ops_wh_count_list('', 'HQ', 10); begin
  assert l->'todo'->0->>'item_code' = 'ST002' and l->'todo'->1->>'item_code' = 'ST003', 'order: ' || (l->'todo')::text;
  assert not (l->'todo'->0 ? 'qty'), 'blind';
  assert (l->'progress'->>'items')::int = 4, 'progress';
end $$;
-- ST003：系统 10，报坏 2 还没输入 → 应有 8；数到 8 = 相符
do $$ declare r jsonb; begin
  r := public.ops_wh_count_save('{"location":"HQ","item_code":"ST003","qty":8}');
  assert r->>'result' = 'match', 'pending move counted: ' || r::text;
  -- ST004：系统 4，数到 3 → 请再数；再数还是 3 → 差异
  r := public.ops_wh_count_save('{"location":"HQ","item_code":"ST004","qty":3}');
  assert r->>'result' = 'recount' and (r->>'attempt')::int = 1, 'recount: ' || r::text;
  assert public.ops_wh_count_list('', 'HQ')->'recount' = '["ST004"]'::jsonb, 'recount list';
  r := public.ops_wh_count_save('{"location":"HQ","item_code":"ST004","qty":3}');
  assert r->>'result' = 'variance' and (r->>'attempt')::int = 2, 'variance: ' || r::text;
  -- ST002：系统 −2，实际 0 → 再数 0 → 差异
  perform public.ops_wh_count_save('{"location":"HQ","item_code":"ST002","qty":0}');
  r := public.ops_wh_count_save('{"location":"HQ","item_code":"ST002","qty":0}');
  assert r->>'result' = 'variance', 'neg variance';
  -- 盘过的不再出现在今天的清单
  assert jsonb_array_length(public.ops_wh_count_list('', 'HQ')->'todo') = 1, 'only ST001 left';
  assert jsonb_array_length(public.ops_wh_count_list('', 'HQ')->'done_today') = 3, 'done today 3 (superseded hidden)';
end $$;
select pg_temp.expect_error($q$select public.ops_wh_count_save('{"location":"HQ","item_code":"ST001","qty":-1}')$q$, '实际数到');
-- 一般员工看不到差异
select pg_temp.expect_error($q$select public.ops_wh_counts('{"status":"variance"}')$q$, '可审批');
do $$ begin assert jsonb_array_length(public.ops_wh_counts('{"status":"all"}')) = 3 and
  not (public.ops_wh_counts('{"status":"all"}')->0 ? 'system_qty'), 'own counts, no system qty'; end $$;

-- 4. 主管：差异 2 笔（ST004 少 1、价值 −300；ST002 +2），搬动 1 笔待输入
select pg_temp.as_user('whmgr@example.com');
do $$ declare v jsonb := public.ops_wh_counts('{"status":"variance"}'); h jsonb := public.ops_home(); x jsonb; begin
  assert jsonb_array_length(v) = 2, 'variances: ' || v::text;
  x := (select e from jsonb_array_elements(v) e where e->>'item_code' = 'ST004');
  assert (x->>'diff')::numeric = -1 and (x->>'diff_value')::numeric = -300 and (x->>'system_qty')::numeric = 4, 'diff: ' || x::text;
  assert (h->>'wh_variances')::int = 2 and (h->>'wh_moves_pending')::int = 1, 'home: ' || h::text;
end $$;
select pg_temp.expect_error($q$select public.ops_wh_count_review(array[1::bigint], 'ignored')$q$, '写原因');
do $$ declare ids bigint[]; n int; begin
  select array_agg((e->>'id')::bigint) into ids from jsonb_array_elements(public.ops_wh_counts('{"status":"variance"}')) e;
  n := public.ops_wh_count_review(ids, 'adjusted', 'SA-0099');
  assert n = 2, 'reviewed 2';
  assert jsonb_array_length(public.ops_wh_counts('{"status":"variance"}')) = 0, 'none left';
  assert (public.ops_wh_counts('{"status":"adjusted"}')->0->>'ac_doc') = 'SA-0099', 'ac doc';
  select array_agg((e->>'id')::bigint) into ids from jsonb_array_elements(public.ops_wh_moves('{}')) e;
  n := public.ops_wh_move_mark(ids, 'done', 'ST-0001');
  assert n = 1 and jsonb_array_length(public.ops_wh_moves('{}')) = 0, 'move done';
  assert public.ops_wh_moves('{"status":"done"}')->0->>'done_by_name' = '仓库主管', 'done by';
end $$;
select public.ops_wh_location_save('{"code":"HQ","daily_target":50,"name":"总部门市仓"}');
select pg_temp.as_user('picker@example.com');
select pg_temp.expect_error($q$select public.ops_wh_location_save('{"code":"HQ","daily_target":5}')$q$, '审批');
-- 登记的人可以取消自己还没处理的搬动
do $$ declare m jsonb; begin
  m := public.ops_wh_move_save('{"item_code":"ST001","qty":1,"kind":"display","from_loc":"HQ","to_loc":"DISPLAY"}');
  assert public.ops_wh_move_mark(array[(m->>'id')::bigint], 'cancelled') = 1, 'own cancel';
end $$;
-- 隔天再盘 ST004 不会被 30 天规则挡（只是不在建议清单）
select pg_temp.at('2026-10-22 10:00:00+08');
do $$ begin
  assert not exists (select 1 from jsonb_array_elements(public.ops_wh_count_list('', 'HQ')->'todo') t where t->>'item_code' = 'ST004'),
    'counted within 30 days skipped';
  assert public.ops_wh_count_save('{"location":"HQ","item_code":"ST004","qty":4}')->>'result' = 'match', 'ad-hoc count ok';
end $$;

reset role;
select 'ALL WAREHOUSE TESTS PASSED' as result;
