-- 货架（仓 / 区 / 货架 / 层）与货架数量（2026-10-15）。接在 rpl_test.sql 之后跑。
-- 用到前面测试建的人：picker（仓库可编辑）、whmgr（仓库主管 = 可审批）、hqsales（门市 = 只看）、jbwh（JB 仓库）。
-- HQ 库存（stub）：ST003 10、ST004 4；SRGADING ST001 3。前面的测试可能留下还没输入 AutoCount 的搬动，所以「应有」都现算。
\set ON_ERROR_STOP 1
create or replace function pg_temp.as_user(p_email text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('email', p_email)::text, false);
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
-- 货架上某商品几件（用 API 读，测试身分不能直接读 ops 的表）
create or replace function pg_temp.binqty(p_code text, p_item text) returns numeric language sql as $$
  select coalesce((select (x->>'qty')::numeric
    from jsonb_array_elements(public.ops_wh_bin_get(jsonb_build_object('bin', p_code, 'location', 'HQ'))->'items') x
    where x->>'item_code' = p_item), 0)
$$;
create or replace function pg_temp.binid(p_code text) returns bigint language sql as $$
  select (x->>'id')::bigint from jsonb_array_elements(public.ops_wh_bins('{"location":"HQ","include_inactive":true}')->'bins') x
  where x->>'code' = p_code
$$;
grant execute on all functions in schema pg_temp to authenticated;

set role authenticated;

-- 1. 建货架：只有可审批
select pg_temp.as_user('picker@example.com');
select pg_temp.expect_error($q$select public.ops_wh_bin_save('{"location":"HQ","zone":"A","shelf":"R1","level":"1"}')$q$, '审批');
select pg_temp.as_user('whmgr@example.com');
do $$ declare b jsonb; r jsonb; begin
  b := public.ops_wh_bin_save('{"location":"HQ","zone":"a","shelf":" r1 ","level":"1"}');
  assert b->>'code' = 'A-R1-1' and b->>'barcode' = 'BIN:' || (b->>'id'), 'bin code: ' || b::text;
  r := public.ops_wh_bin_bulk('{"location":"HQ","zone":"A","shelves":["R1","R2"],"levels":["1","2"]}');
  assert (r->>'created')::int = 3 and (r->>'existed')::int = 1, 'bulk: ' || r::text;
  r := public.ops_wh_bin_bulk('{"location":"SRGADING","shelves":["S1"]}');
  assert (r->>'created')::int = 1, 'bulk no zone/level';
  assert (select count(*) from jsonb_array_elements(public.ops_wh_bins('{"location":"HQ"}')->'bins')) = 4, 'HQ bins';
end $$;
select pg_temp.expect_error($q$select public.ops_wh_bin_save('{"location":"HQ","zone":"A","shelf":"R1","level":"1"}')$q$, '已经有货架');
select pg_temp.expect_error($q$select public.ops_wh_bin_save('{"location":"HQ","shelf":"R 9"}')$q$, '空格');
select pg_temp.expect_error($q$select public.ops_wh_bin_save('{"location":"MARS","shelf":"R9"}')$q$, '没有这个仓位');
select pg_temp.expect_error($q$select public.ops_wh_bin_bulk('{"location":"HQ","shelves":[]}')$q$, '请填货架');

-- 2. 上架 / 拿下 / 移货架（可编辑）
select pg_temp.as_user('hqsales@example.com');
do $$ begin assert jsonb_array_length(public.ops_wh_bins('{}')->'bins') = 5, 'sales can view bins'; end $$;
select pg_temp.expect_error($q$select public.ops_wh_bin_op('{"kind":"putaway","item":"ST003","qty":1,"bin":"A-R1-1","location":"HQ"}')$q$, '编辑');
select pg_temp.as_user('picker@example.com');
do $$ declare r jsonb; i jsonb; hq jsonb; begin
  r := public.ops_wh_bin_op('{"kind":"putaway","item":"st003","qty":3,"bin":"a-r1-1","location":"HQ"}');
  assert (r->>'ok')::boolean and r->>'item_code' = 'ST003' and (r->>'shelved')::numeric = 3, 'putaway: ' || r::text;
  r := public.ops_wh_bin_op('{"kind":"move","item":"ST003","qty":2,"from_bin":"A-R1-1","to_bin":"A-R1-2","location":"HQ"}');
  assert (r->>'shelved')::numeric = 3, 'move keeps total: ' || r::text;
  i := public.ops_wh_item_bins('{"item":"ST003"}');
  hq := (select x from jsonb_array_elements(i->'locations') x where x->>'location' = 'HQ');
  assert (hq->>'shelved')::numeric = 3 and (hq->>'unshelved')::numeric = (hq->>'expected')::numeric - 3, 'item bins: ' || hq::text;
  assert (select (x->>'qty')::numeric from jsonb_array_elements(hq->'bins') x where x->>'code' = 'A-R1-2') = 2, 'bin qty after move';
  assert jsonb_array_length(i->'log') = 3, 'log: putaway + move out + move in';
  r := public.ops_wh_bin_op('{"kind":"take","item":"ST003","qty":1,"bin":"A-R1-1","location":"HQ","note":"拿去门市"}');
  assert (r->>'shelved')::numeric = 2, 'take';
end $$;
select pg_temp.expect_error($q$select public.ops_wh_bin_op('{"kind":"take","item":"ST003","qty":5,"bin":"A-R1-2","location":"HQ"}')$q$, '不够拿');
select pg_temp.expect_error($q$select public.ops_wh_bin_op('{"kind":"move","item":"ST003","qty":1,"from_bin":"A-R1-2","to_bin":"S1","location":null}')$q$, '不同仓位');
select pg_temp.expect_error($q$select public.ops_wh_bin_op('{"kind":"putaway","item":"NOPE","qty":1,"bin":"A-R1-1","location":"HQ"}')$q$, '找不到商品');
select pg_temp.expect_error($q$select public.ops_wh_bin_op('{"kind":"putaway","item":"ST003","qty":0,"bin":"A-R1-1","location":"HQ"}')$q$, '数量');
select pg_temp.expect_error($q$select public.ops_wh_bin_op('{"kind":"putaway","item":"ST003","qty":1,"bin":"ZZ-9","location":"HQ"}')$q$, '找不到货架');
-- 改数要可审批
select pg_temp.expect_error($q$select public.ops_wh_bin_op('{"kind":"adjust","item":"ST003","qty":9,"bin":"A-R1-2","location":"HQ","note":"x"}')$q$, '可审批');

-- 3. 上架后货架合计比应有多 → 先问；确认才存
do $$ declare r jsonb; exp numeric; begin
  r := public.ops_wh_bin_op('{"kind":"putaway","item":"ST004","qty":50,"bin":"A-R2-1","location":"HQ"}');
  assert not (r->>'ok')::boolean and (r->>'need_confirm')::boolean and (r->>'shelved')::numeric = 50, 'need confirm: ' || r::text;
  exp := (r->>'expected')::numeric;
  assert (select x->>'shelved' from jsonb_array_elements(public.ops_wh_item_bins('{"item":"ST004"}')->'locations') x
          where x->>'location' = 'HQ')::numeric = 0, 'not saved without confirm';
  r := public.ops_wh_bin_op('{"kind":"putaway","item":"ST004","qty":50,"bin":"A-R2-1","location":"HQ","confirm":true}');
  assert (r->>'ok')::boolean and (r->>'over')::boolean, 'saved with confirm';
end $$;
-- 对不上清单：ST004 货架比应有多
do $$ declare r jsonb; begin
  r := public.ops_wh_bin_recon('{"location":"HQ","filter":"over"}');
  assert exists (select 1 from jsonb_array_elements(r->'rows') x where x->>'item_code' = 'ST004'), 'recon over: ' || r::text;
  assert not exists (select 1 from jsonb_array_elements(r->'rows') x where x->>'item_code' = 'ST003'), 'ST003 not over';
  r := public.ops_wh_bin_recon('{"location":"HQ","filter":"unshelved","q":"basin"}');
  assert exists (select 1 from jsonb_array_elements(r->'rows') x where x->>'item_code' = 'ST003')
     and not exists (select 1 from jsonb_array_elements(r->'rows') x where x->>'item_code' = 'ST004'), 'recon unshelved + q: ' || r::text;
  assert (r->'counts'->>'over')::int >= 1, 'counts';
end $$;

-- 4. 主管改数（要原因）
select pg_temp.as_user('whmgr@example.com');
select pg_temp.expect_error($q$select public.ops_wh_bin_op('{"kind":"adjust","item":"ST004","qty":4,"bin":"A-R2-1","location":"HQ"}')$q$, '原因');
do $$ declare r jsonb; g jsonb; begin
  r := public.ops_wh_bin_op('{"kind":"adjust","item":"ST004","qty":4,"bin":"A-R2-1","location":"HQ","note":"盘点后改正"}');
  assert (r->>'shelved')::numeric = 4 and not (r->>'over')::boolean or (r->>'expected')::numeric < 4, 'adjust: ' || r::text;
  g := public.ops_wh_bin_get('{"bin":"A-R2-1","location":"HQ"}');
  assert (g->'items'->0->>'qty')::numeric = 4 and g->'log'->0->>'kind' = 'adjust' and g->'log'->0->>'by_name' = '仓库主管', 'bin get: ' || g::text;
end $$;
-- 停用：货架上还有货不能停
select pg_temp.expect_error(format($q$select public.ops_wh_bin_save('{"id":%s,"location":"HQ","zone":"A","shelf":"R2","level":"1","active":false}')$q$,
  pg_temp.binid('A-R2-1')), '还有货');

-- 5. 一次很多动作：有一行错就全部不存
select pg_temp.as_user('picker@example.com');
select pg_temp.expect_error($q$select public.ops_wh_bin_batch('{"ops":[{"kind":"putaway","item":"ST003","qty":1,"bin":"A-R1-1","location":"HQ"},{"kind":"take","item":"ST003","qty":99,"bin":"A-R1-1","location":"HQ"}]}')$q$, '第 2 行');
do $$ declare r jsonb; begin
  assert pg_temp.binqty('A-R1-1', 'ST003') = 0, 'batch rolled back';
  r := public.ops_wh_bin_batch('{"ops":[{"kind":"putaway","item":"ST003","qty":1,"bin":"A-R1-1","location":"HQ"},{"kind":"putaway","item":"ST003","qty":1,"bin":"A-R2-2","location":"HQ"}]}');
  assert (r->>'ok')::boolean and (r->>'rows')::int = 2, 'batch ok: ' || r::text;
end $$;

-- 6. Excel 带入（可审批）：先试算，有错不存；可以顺便建货架
select pg_temp.expect_error($q$select public.ops_wh_bin_import('{"location":"HQ","rows":[{"item":"ST003","bin":"A-R1-1","qty":1}]}')$q$, '审批');
select pg_temp.as_user('whmgr@example.com');
do $$ declare r jsonb; begin
  r := public.ops_wh_bin_import('{"location":"HQ","rows":[{"item":"ST003","zone":"B","shelf":"R9","level":"1","qty":2},{"item":"NOPE","bin":"A-R1-1","qty":1}],"create_bins":true}');
  assert not (r->>'ok')::boolean and not (r->>'saved')::boolean and (r->>'errors')::int = 1, 'import errors: ' || r::text;
  assert pg_temp.binid('B-R9-1') is null, 'nothing created on error';
  r := public.ops_wh_bin_import('{"location":"HQ","rows":[{"item":"ST003","zone":"B","shelf":"R9","level":"1","qty":2},{"item":"ST003","zone":"B","shelf":"R9","level":"1","qty":1}],"create_bins":true,"dry_run":true}');
  assert (r->>'ok')::boolean and not (r->>'saved')::boolean and (r->>'new_bins')::int = 1, 'dry run: ' || r::text;
  r := public.ops_wh_bin_import('{"location":"HQ","rows":[{"item":"ST003","zone":"B","shelf":"R9","level":"1","qty":2},{"item":"ST003","zone":"B","shelf":"R9","level":"1","qty":1}],"create_bins":true}');
  assert (r->>'saved')::boolean and (r->>'new_bins')::int = 1, 'import saved: ' || r::text;
  assert pg_temp.binqty('B-R9-1', 'ST003') = 3, 'import sums duplicates';
  r := public.ops_wh_bin_import('{"location":"HQ","rows":[{"item":"ST003","bin":"B-R9-1","qty":0}]}');
  assert pg_temp.binqty('B-R9-1', 'ST003') = 0, 'import sets (not adds)';
end $$;
do $$ begin
  assert not (public.ops_wh_bin_import('{"location":"HQ","rows":[{"item":"ST003","bin":"Q-1","qty":1}]}')->>'ok')::boolean, 'unknown bin without create';
end $$;

-- 7. 地图
select pg_temp.as_user('picker@example.com');
select pg_temp.expect_error($q$select public.ops_wh_map_save('{"location":"HQ","layout":{"shelves":{}}}')$q$, '审批');
do $$ declare m jsonb; f jsonb; s jsonb; begin
  m := public.ops_wh_map_get('{"location":"HQ"}');
  assert not (m->>'can_edit')::boolean and jsonb_array_length(m->'shelves') = 3, 'map shelves (A::R1, A::R2, B::R9): ' || m::text;
  assert (select jsonb_array_length(x->'levels') from jsonb_array_elements(m->'shelves') x where x->>'key' = 'A::R1') = 2, 'levels';
  assert exists (select 1 from jsonb_array_elements(m->'locations') x where x->>'location' = 'SRGADING'), 'locations with bins';
  f := public.ops_wh_map_find('{"location":"HQ","q":"basin"}');
  assert f->0->>'item_code' = 'ST003' and jsonb_array_length(f->0->'bins') >= 1, 'map find: ' || f::text;
  f := public.ops_wh_map_find('{"q":"ST004"}');
  assert f->0->'bins'->0->>'code' = 'A-R2-1', 'map find exact code';
  s := public.ops_wh_map_shelf('{"location":"HQ","zone":"A","shelf":"R2"}');
  assert jsonb_array_length(s->'levels') = 2 and s->'levels'->0->'items'->0->>'item_code' = 'ST004', 'shelf: ' || s::text;
end $$;
select pg_temp.as_user('whmgr@example.com');
do $$ declare m jsonb; begin
  perform public.ops_wh_map_save('{"location":"HQ","layout":{"shelves":{"A::R1":{"x":10,"y":20,"w":80,"h":54}}}}');
  m := public.ops_wh_map_get('{"location":"HQ"}');
  assert (m->>'can_edit')::boolean and m->'layout'->'shelves'->'A::R1'->>'x' = '10', 'layout saved';
end $$;
select pg_temp.expect_error($q$select public.ops_wh_map_save('{"location":"HQ","layout":[1]}')$q$, '地图资料');

-- 8. 搬动取消 → 一起登记的货架变动反向（之后多行搬动会用 ref_type = move）
reset role;
do $$ declare me ops.staff; mv bigint; begin
  select * into me from ops.staff where email = 'picker@example.com';
  insert into ops.wh_move (company, item_code, qty, kind, from_loc, to_loc, created_by)
  values ('HOMEWORKSSB', 'ST003', 1, 'transfer', 'HQ', 'SRGADING', me.id) returning id into mv;
  perform ops.wh_bin_apply(me, (select id from ops.wh_bin where code = 'A-R1-2'), 'ST003', -1, 'take', 'move', mv, '调去 SRGADING');
  perform set_config('test.mv', mv::text, false);
end $$;
set role authenticated;
select pg_temp.as_user('picker@example.com');
do $$ declare before numeric; after numeric; begin
  before := pg_temp.binqty('A-R1-2', 'ST003');
  assert public.ops_wh_move_mark(array[current_setting('test.mv')::bigint], 'cancelled') = 1, 'cancel move';
  after := pg_temp.binqty('A-R1-2', 'ST003');
  assert after = before + 1, format('reversed: %s → %s', before, after);
  assert public.ops_wh_bin_get('{"bin":"A-R1-2","location":"HQ"}')->'log'->0->>'kind' = 'reverse', 'reverse log';
end $$;

-- 9. 分店：JB 的人看不到总部货架；内部函数一般账号叫不到
select pg_temp.as_user('jbwh@example.com');
select pg_temp.expect_error($q$select public.ops_wh_bins('{"company":"HOMEWORKSSB"}')$q$, '分店');
do $$ begin assert jsonb_array_length(public.ops_wh_bins('{}')->'bins') = 0, 'JB has no bins'; end $$;
select pg_temp.expect_error($q$select ops.wh_bin_apply(null::ops.staff, 1, 'ST003', 1, 'putaway')$q$, 'permission');
select pg_temp.as_user('whmgr@example.com');
do $$ declare s jsonb; begin
  s := (select x from jsonb_array_elements(public.ops_wh_bins('{}')->'summary') x where x->>'location' = 'HQ');
  assert (s->>'bins')::int = 5 and (s->>'items_shelved')::int = 2, 'summary: ' || s::text;
end $$;
reset role;
select 'bin_test ok' as result;
