-- 仓库地图（2026-10-15）：前端 wh/Map.tsx 依赖的回传格式与权限。接在 bin_test.sql 之后跑。
-- bin_test 留下：HQ 货架 A-R1-1/2、A-R2-1/2、B-R9-1（三个方块 A::R1、A::R2、B::R9），SRGADING 的 S1；HQ 地图存过 A::R1。
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
grant execute on all functions in schema pg_temp to authenticated;

set role authenticated;

-- 1. 主管在 HQ 加一个两层的货架 C-R1；ST001 放 HQ C-R1-2 两件、SRGADING S1 一件
select pg_temp.as_user('whmgr@example.com');
do $$ declare r jsonb; begin
  perform public.ops_wh_bin_bulk('{"location":"HQ","zone":"c","shelves":["r1"],"levels":["1","2"]}');
  r := public.ops_wh_bin_op('{"kind":"putaway","item":"ST001","qty":2,"bin":"C-R1-2","location":"HQ","confirm":true}');
  assert (r->>'ok')::boolean, 'putaway HQ: ' || r::text;
  r := public.ops_wh_bin_op('{"kind":"putaway","item":"ST001","qty":1,"bin":"S1","location":"SRGADING","confirm":true}');
  assert (r->>'ok')::boolean, 'putaway SRGADING: ' || r::text;
end $$;

-- 2. 地图：没给仓位 = 排第一的仓位（HQ）；仓位分页「N 个货架」= 方块数；每个方块有层、几种、几件
do $$ declare m jsonb; s jsonb; begin
  m := public.ops_wh_map_get('{}');
  assert m->>'company' = 'HOMEWORKSSB' and m->>'location' = 'HQ' and (m->>'can_edit')::boolean, 'default location: ' || (m - 'shelves')::text;
  assert (select (x->>'shelves')::int from jsonb_array_elements(m->'locations') x where x->>'location' = 'HQ') = 4, 'HQ 4 shelves';
  assert (select (x->>'shelves')::int from jsonb_array_elements(m->'locations') x where x->>'location' = 'SRGADING') = 1, 'SRGADING 1 shelf';
  assert m->'locations'->0->>'location' = 'HQ', 'locations sorted by wh_location.sort';
  s := (select x from jsonb_array_elements(m->'shelves') x where x->>'key' = 'C::R1');
  assert s->>'zone' = 'C' and s->>'shelf' = 'R1' and jsonb_array_length(s->'levels') = 2, 'C::R1 levels: ' || s::text;
  assert (s->>'items')::int = 1 and (s->>'qty')::numeric = 2, 'C::R1 items / qty: ' || s::text;
  assert s->'levels'->1->>'code' = 'C-R1-2' and (s->'levels'->1->>'qty')::numeric = 2 and (s->'levels'->0->>'items')::int = 0, 'level detail';
  assert m->'layout'->'shelves'->'A::R1'->>'x' = '10', 'layout from bin_test kept';
  -- 没有货架的仓位：空的
  m := public.ops_wh_map_get('{"location":"DISPLAY"}');
  assert m->>'location' = 'DISPLAY' and jsonb_array_length(m->'shelves') = 0 and m->'layout' = '{}'::jsonb, 'empty location';
end $$;

-- 3. 点方块：每层的商品（空层 items = []）；区 / 货架不分大小写
do $$ declare s jsonb; begin
  s := public.ops_wh_map_shelf('{"location":"HQ","zone":"c","shelf":"r1"}');
  assert s->>'zone' = 'C' and jsonb_array_length(s->'levels') = 2, 'shelf: ' || s::text;
  assert s->'levels'->0->>'level' = '1' and s->'levels'->0->'items' = '[]'::jsonb, 'empty level';
  assert s->'levels'->1->'items'->0->>'item_code' = 'ST001' and s->'levels'->1->'items'->0->>'description' = 'RAXON HOSE'
     and (s->'levels'->1->'items'->0->>'qty')::numeric = 2, 'level 2 items: ' || s::text;
end $$;

-- 4. 找商品：不限仓位 = 每个货架带 location（画面用来「别的仓位也有」）；限仓位只回那个仓位；没上架的回 []
do $$ declare f jsonb; begin
  f := public.ops_wh_map_find('{"q":"st001"}');
  assert jsonb_array_length(f) = 1 and f->0->>'item_code' = 'ST001' and jsonb_array_length(f->0->'bins') = 2, 'find all: ' || f::text;
  assert f->0->'bins'->0->>'location' = 'HQ' and f->0->'bins'->0->>'code' = 'C-R1-2' and (f->0->'bins'->0->>'qty')::numeric = 2
     and f->0->'bins'->1->>'location' = 'SRGADING', 'bins: most qty first, with location: ' || f::text;
  f := public.ops_wh_map_find('{"q":"ST001","location":"SRGADING"}');
  assert jsonb_array_length(f->0->'bins') = 1 and f->0->'bins'->0->>'code' = 'S1', 'find in SRGADING';
  assert public.ops_wh_map_find('{"q":"bidet"}') = '[]'::jsonb, 'not on a shelf → []';
  assert public.ops_wh_map_find('{"q":"  "}') = '[]'::jsonb, 'blank → []';
  -- 品名每个字都要出现
  f := public.ops_wh_map_find('{"q":"raxon hose"}');
  assert f->0->>'item_code' = 'ST001', 'words: ' || f::text;
end $$;

-- 5. 存排版：整份 layout（其他键保留）、updated_at；仓位要存在
do $$ declare m jsonb; begin
  perform public.ops_wh_map_save('{"location":"HQ","layout":{"shelves":{"A::R1":{"x":0,"y":0,"w":120,"h":60},"C::R1":{"x":300,"y":200,"w":80,"h":54}},"v":1}}');
  m := public.ops_wh_map_get('{"location":"HQ"}');
  assert m->'layout'->>'v' = '1' and m->'layout'->'shelves'->'C::R1'->>'x' = '300' and m->'layout'->'shelves'->'A::R1'->>'w' = '120', 'layout: ' || (m->'layout')::text;
  assert m->>'updated_at' is not null, 'updated_at';
end $$;
select pg_temp.expect_error($q$select public.ops_wh_map_save('{"location":"MARS","layout":{}}')$q$, '没有这个仓位');
select pg_temp.expect_error($q$select public.ops_wh_map_save('{"location":"HQ"}')$q$, '地图资料');

-- 6. 停用的货架不上地图、找不到；有货的不能停用
do $$ declare m jsonb; id1 bigint; begin
  id1 := (select (x->>'id')::bigint from jsonb_array_elements(public.ops_wh_bins('{"location":"HQ"}')->'bins') x where x->>'code' = 'C-R1-1');
  perform public.ops_wh_bin_save(jsonb_build_object('id', id1, 'zone', 'C', 'shelf', 'R1', 'level', '1', 'active', false));
  m := public.ops_wh_map_get('{"location":"HQ"}');
  assert (select jsonb_array_length(x->'levels') from jsonb_array_elements(m->'shelves') x where x->>'key' = 'C::R1') = 1, 'inactive level hidden';
  assert jsonb_array_length(public.ops_wh_map_shelf('{"location":"HQ","zone":"C","shelf":"R1"}')->'levels') = 1, 'shelf: inactive hidden';
end $$;
select pg_temp.expect_error($q$select public.ops_wh_bin_save(jsonb_build_object('id',
  (select (x->>'id')::bigint from jsonb_array_elements(public.ops_wh_bins('{"location":"HQ"}')->'bins') x where x->>'code' = 'C-R1-2'),
  'zone', 'C', 'shelf', 'R1', 'level', '2', 'active', false))$q$, '还有货');

-- 7. 权限：门市（只看）、仓库员工（可编辑）看得到、不能改排版；没有仓库权限的人叫不到
select pg_temp.as_user('hqsales@example.com');
do $$ begin
  assert not (public.ops_wh_map_get('{}')->>'can_edit')::boolean, 'view: can_edit false';
  assert jsonb_array_length(public.ops_wh_map_find('{"q":"ST001"}')->0->'bins') = 2, 'view can search';
end $$;
select pg_temp.expect_error($q$select public.ops_wh_map_save('{"location":"HQ","layout":{"shelves":{}}}')$q$, '审批');
select pg_temp.as_user('picker@example.com');
do $$ begin assert not (public.ops_wh_map_get('{}')->>'can_edit')::boolean, 'edit level: can_edit false'; end $$;
select pg_temp.as_user('hr@example.com');
select pg_temp.expect_error($q$select public.ops_wh_map_get('{}')$q$, '仓库');

-- 8. 分店：JB 的人只看到 JB（没有货架）；叫总部的地图、找总部的商品、看总部的货架都挡
select pg_temp.as_user('jbwh@example.com');
do $$ declare m jsonb; begin
  m := public.ops_wh_map_get('{}');
  assert m->>'company' = 'HOMEWORKSSOUTHERN' and m->>'location' is null and m->'locations' = '[]'::jsonb, 'JB map empty: ' || m::text;
  assert public.ops_wh_map_find('{"q":"ST001"}') = '[]'::jsonb, 'JB find sees no HQ shelves';
end $$;
select pg_temp.expect_error($q$select public.ops_wh_map_get('{"company":"HOMEWORKSSB","location":"HQ"}')$q$, '分店');
select pg_temp.expect_error($q$select public.ops_wh_map_find('{"company":"HOMEWORKSSB","q":"ST001"}')$q$, '分店');
select pg_temp.expect_error($q$select public.ops_wh_map_shelf('{"company":"HOMEWORKSSB","location":"HQ","zone":"C","shelf":"R1"}')$q$, '分店');
select pg_temp.as_user('jbboss@example.com');
select pg_temp.expect_error($q$select public.ops_wh_map_save('{"company":"HOMEWORKSSB","location":"HQ","layout":{"shelves":{}}}')$q$, '分店');
do $$ begin
  assert (public.ops_wh_map_get('{}')->>'can_edit')::boolean, 'JB management can edit (own branch)';
end $$;

reset role;
select 'map_test ok' as result;
