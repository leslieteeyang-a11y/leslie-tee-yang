-- 盘点单 + 按货架盘 + 盘点统计（2026-10-15）。接在 bin_test.sql 之后跑。
-- 用到前面测试建的人：picker（仓库可编辑）、whmgr（仓库主管 = 可审批）、hqsales（门市 = 只看）、jbwh（JB 仓库）、boss（管理员）。
-- 自己的商品 SH001–SH004（HQ 库存 5 / 3 / 4 / 2），时间拨到 2027-03-01（统计 30 天只算这个测试盘的）。
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
create or replace function pg_temp.binid(p_code text) returns bigint language sql as $$
  select (x->>'id')::bigint from jsonb_array_elements(public.ops_wh_bins('{"include_inactive":true}')->'bins') x
  where x->>'code' = p_code and x->>'location' = 'HQ'
$$;
create or replace function pg_temp.binqty(p_code text, p_item text) returns numeric language sql as $$
  select coalesce((select (x->>'qty')::numeric
    from jsonb_array_elements(public.ops_wh_bin_get(jsonb_build_object('bin', p_code, 'location', 'HQ'))->'items') x
    where x->>'item_code' = p_item), 0)
$$;
create or replace function pg_temp.staff_id(p_name text) returns bigint language sql as $$
  select (x->>'id')::bigint from jsonb_array_elements(public.ops_wh_sheet_staff('')) x where x->>'name' = p_name
$$;
-- 盘点单某一行（用 API）
create or replace function pg_temp.line(p_sheet bigint, p_item text) returns jsonb language sql as $$
  select x from jsonb_array_elements(public.ops_wh_sheet_get(jsonb_build_object('id', p_sheet))->'lines') x
  where x->>'item_code' = p_item
$$;
create or replace function pg_temp.sid(p_name text) returns bigint language sql as $$
  select current_setting('test.' || p_name)::bigint
$$;
grant execute on all functions in schema pg_temp to authenticated;

-- 测试资料（stub 的 BI 表）
insert into bi.dim_item (company, item_code, description, item_group, item_type, base_uom) values
  ('HOMEWORKSSB', 'SH001', 'SHEET BASIN A', 'SANITARY', 'HEMOS', 'PCS'),
  ('HOMEWORKSSB', 'SH002', 'SHEET TAP B', 'TAP', 'HEMOS', 'PCS'),
  ('HOMEWORKSSB', 'SH003', 'SHEET MIRROR C', 'MIRROR', 'HEMOS', 'PCS'),
  ('HOMEWORKSSB', 'SH004', 'SHEET HOSE D', 'TAP', 'HEMOS', 'PCS'),
  ('HOMEWORKSSOUTHERN', 'SH001', 'SHEET BASIN A', 'SANITARY', 'HEMOS', 'PCS');
insert into bi.fact_stock (company, item_code, location, qty, total_cost) values
  ('HOMEWORKSSB', 'SH001', 'HQ', 5, 500), ('HOMEWORKSSB', 'SH002', 'HQ', 3, 180),
  ('HOMEWORKSSB', 'SH003', 'HQ', 4, 200), ('HOMEWORKSSB', 'SH004', 'HQ', 2, 20),
  ('HOMEWORKSSOUTHERN', 'SH001', 'JB', 7, 700);
insert into ops.wh_location (company, code, sort) values ('HOMEWORKSSOUTHERN', 'JB', 30) on conflict do nothing;

set role authenticated;
select pg_temp.at('2027-03-01 10:00:00+08');
select pg_temp.as_user('boss@example.com');
select public.ops_staff_save('{"email":"counter2@example.com","name":"盘点小华","department":"warehouse","branch":"HOMEWORKSSB"}');

-- 0. 货架：S-R1-1、S-R2-1、T-R1；SH001 放 S-R1-1 3 件、S-R2-1 2 件；SH002 放 T-R1 1 件
select pg_temp.as_user('whmgr@example.com');
select public.ops_wh_bin_bulk('{"location":"HQ","zone":"S","shelves":["R1","R2"],"levels":["1"]}');
select public.ops_wh_bin_bulk('{"location":"HQ","zone":"T","shelves":["R1"]}');
select pg_temp.as_user('picker@example.com');
select public.ops_wh_bin_batch('{"ops":[{"kind":"putaway","item":"SH001","qty":3,"bin":"S-R1-1","location":"HQ"},
  {"kind":"putaway","item":"SH001","qty":2,"bin":"S-R2-1","location":"HQ"},
  {"kind":"putaway","item":"SH002","qty":1,"bin":"T-R1","location":"HQ"}]}');

-- 1. 可以指派的人：只有可审批能查；只列这间分店仓库可编辑以上
select pg_temp.expect_error($q$select public.ops_wh_sheet_staff('')$q$, '审批');
select pg_temp.as_user('whmgr@example.com');
do $$ declare s jsonb := public.ops_wh_sheet_staff(''); begin
  assert exists (select 1 from jsonb_array_elements(s) x where x->>'name' = '仓库阿强')
     and exists (select 1 from jsonb_array_elements(s) x where x->>'name' = '盘点小华'), 'staff: ' || s::text;
  assert not exists (select 1 from jsonb_array_elements(s) x where x->>'name' in ('门市小美', 'JB 仓库')), 'no sales / JB: ' || s::text;
  perform set_config('test.picker', pg_temp.staff_id('仓库阿强')::text, false);
  perform set_config('test.counter2', pg_temp.staff_id('盘点小华')::text, false);
end $$;
reset role;
do $$ begin
  perform set_config('test.hqsales', (select id from ops.staff where email = 'hqsales@example.com')::text, false);
  perform set_config('test.jbwh', (select id from ops.staff where email = 'jbwh@example.com')::text, false);
end $$;
set role authenticated;

-- 2. 建盘点单：三种范围；错误
select pg_temp.expect_error(format($q$select public.ops_wh_sheet_create('{"title":"x","location":"HQ","scope":"location","assignees":[]}')$q$), '至少指派');
select pg_temp.expect_error(format($q$select public.ops_wh_sheet_create('{"title":"x","location":"HQ","scope":"location","assignees":[%s]}')$q$, pg_temp.sid('hqsales')), '不能指派');
select pg_temp.expect_error(format($q$select public.ops_wh_sheet_create('{"title":"x","location":"HQ","scope":"location","assignees":[%s]}')$q$, pg_temp.sid('jbwh')), '不能指派');
select pg_temp.expect_error(format($q$select public.ops_wh_sheet_create('{"title":"x","location":"HQ","scope":"location","due_date":"2027-02-28","assignees":[%s]}')$q$, pg_temp.sid('picker')), '期限');
select pg_temp.expect_error(format($q$select public.ops_wh_sheet_create('{"title":" ","location":"HQ","scope":"location","assignees":[%s]}')$q$, pg_temp.sid('picker')), '名称');
select pg_temp.expect_error(format($q$select public.ops_wh_sheet_create('{"title":"x","location":"MARS","scope":"location","assignees":[%s]}')$q$, pg_temp.sid('picker')), '没有这个仓位');
select pg_temp.expect_error(format($q$select public.ops_wh_sheet_create('{"title":"x","location":"HQ","scope":"items","items":["sh002","NOPE"],"assignees":[%s]}')$q$, pg_temp.sid('picker')), 'NOPE');
select pg_temp.expect_error(format($q$select public.ops_wh_sheet_create('{"title":"x","location":"HQ","scope":"bins","bins":[%s],"assignees":[%s]}')$q$,
  (select (x->>'id') from jsonb_array_elements(public.ops_wh_bins('{"location":"SRGADING"}')->'bins') x limit 1), pg_temp.sid('picker')), '不在 HQ');
do $$ declare s jsonb; begin
  s := public.ops_wh_sheet_create(jsonb_build_object('title', 'HQ 全盘', 'location', 'HQ', 'scope', 'location',
         'due_date', '2027-03-05', 'note', '下班后盘', 'assignees', jsonb_build_array(pg_temp.sid('picker'))));
  assert s->>'status' = 'open' and (s->>'total')::int >= 4 and (s->>'todo')::int = (s->>'total')::int
     and s->'assignees'->0->>'name' = '仓库阿强' and not (s->>'mine')::boolean, 'location sheet: ' || s::text;
  perform set_config('test.full', s->>'id', false);
  s := public.ops_wh_sheet_create(jsonb_build_object('title', '货架 S-R1-1', 'location', 'HQ', 'scope', 'bins',
         'bins', jsonb_build_array(pg_temp.binid('S-R1-1')), 'assignees', jsonb_build_array(pg_temp.sid('picker'), pg_temp.sid('counter2'))));
  assert (s->>'total')::int = 1 and s->'bins' = '["S-R1-1"]'::jsonb and jsonb_array_length(s->'assignees') = 2, 'bins sheet: ' || s::text;
  perform set_config('test.bins', s->>'id', false);
  s := public.ops_wh_sheet_create(jsonb_build_object('title', '抽查', 'location', 'HQ', 'scope', 'items',
         'items', '["sh002", " SH004 ", "SH002"]'::jsonb, 'assignees', jsonb_build_array(pg_temp.sid('counter2'))));
  assert (s->>'total')::int = 2, 'items sheet: ' || s::text;
  perform set_config('test.items', s->>'id', false);
end $$;
select pg_temp.as_user('picker@example.com');
select pg_temp.expect_error($q$select public.ops_wh_sheet_create('{"title":"x","location":"HQ","scope":"location","assignees":[1]}')$q$, '审批');

-- 3. 盲盘：盘点单不给系统数；照货架顺序排（S 区在 T 区前，没上货架的最后）
do $$ declare g jsonb; codes text[]; begin
  g := public.ops_wh_sheet_get(jsonb_build_object('id', pg_temp.sid('full')));
  assert (g->>'mine')::boolean and not (g->>'can_manage')::boolean, 'picker: mine, cannot manage';
  assert not exists (select 1 from jsonb_array_elements(g->'lines') x where x ? 'qty' or x ? 'expected' or x ? 'diff'), 'blind';
  select array_agg(x->>'item_code' order by o) into codes from jsonb_array_elements(g->'lines') with ordinality t(x, o);
  assert array_position(codes, 'SH001') < array_position(codes, 'SH002')
     and array_position(codes, 'SH002') < array_position(codes, 'SH003'), 'walk order: ' || codes::text;
  assert pg_temp.line(pg_temp.sid('full'), 'SH001')->'bins' = '["S-R1-1", "S-R2-1"]'::jsonb, 'bin names';
  assert pg_temp.line(pg_temp.sid('full'), 'SH003')->'bins' = '[]'::jsonb, 'no bins';
  -- 盘点画面：只给货架名字，不给数量
  g := public.ops_wh_count_bins('{"location":"HQ","item":"sh001"}');
  assert g->>'item_code' = 'SH001' and g->'bins' = jsonb_build_array(jsonb_build_object('id', pg_temp.binid('S-R1-1'), 'code', 'S-R1-1'),
           jsonb_build_object('id', pg_temp.binid('S-R2-1'), 'code', 'S-R2-1')), 'count bins: ' || g::text;
  assert not (g->>'recount')::boolean and (g->'sheet'->>'id')::bigint = pg_temp.sid('bins'), 'newest open sheet with item';
  assert exists (select 1 from jsonb_array_elements(g->'all_bins') x where x->>'code' = 'T-R1'), 'all bins for 加一个货架';
end $$;

-- 4. 按货架盘：货架帐上有的货架一定要一起数；相符 → 货架照盘到的数（不变），挂到指定的盘点单
select pg_temp.expect_error(format($q$select public.ops_wh_count_save_bins('{"location":"HQ","item_code":"SH001","bins":[{"bin":%s,"qty":3}],"sheet_id":%s}')$q$,
  pg_temp.binid('S-R1-1'), pg_temp.sid('full')), 'S-R2-1');
select pg_temp.expect_error(format($q$select public.ops_wh_count_save_bins('{"location":"HQ","item_code":"SH001","bins":[{"bin":%s,"qty":3},{"bin":"S-R2-1"}],"sheet_id":%s}')$q$,
  pg_temp.binid('S-R1-1'), pg_temp.sid('full')), '没有就填 0');
select pg_temp.expect_error(format($q$select public.ops_wh_count_save_bins('{"location":"HQ","item_code":"SH001","bins":[{"bin":%s,"qty":3},{"bin":"s-r1-1","qty":1}]}')$q$,
  pg_temp.binid('S-R1-1')), '两次');
select pg_temp.expect_error($q$select public.ops_wh_count_save_bins('{"location":"HQ","item_code":"SH003","bins":[{"bin":"S1","qty":4}]}')$q$, '找不到货架');
select pg_temp.expect_error(format($q$select public.ops_wh_count_save_bins('{"location":"HQ","item_code":"SH003","bins":[],"loose":4,"sheet_id":%s}')$q$, pg_temp.sid('bins')), '不在这张盘点单');
do $$ declare r jsonb; begin
  r := public.ops_wh_count_save_bins(jsonb_build_object('location', 'HQ', 'item_code', 'SH001', 'sheet_id', pg_temp.sid('full'),
         'bins', jsonb_build_array(jsonb_build_object('bin', pg_temp.binid('S-R1-1'), 'qty', 3), jsonb_build_object('bin', 'S-R2-1', 'qty', 2))));
  assert r->>'result' = 'match' and (r->>'total')::numeric = 5 and (r->>'bins_set')::int = 2
     and (r->>'sheet_id')::bigint = pg_temp.sid('full') and r->>'sheet_title' = 'HQ 全盘', 'match: ' || r::text;
  assert pg_temp.binqty('S-R1-1', 'SH001') = 3 and pg_temp.binqty('S-R2-1', 'SH001') = 2, 'bins unchanged on match';
  assert public.ops_wh_bin_get('{"bin":"S-R1-1","location":"HQ"}')->'log'->0->>'kind' = 'count', 'count logged on bin';
  assert pg_temp.line(pg_temp.sid('full'), 'SH001')->>'status' = 'match'
     and pg_temp.line(pg_temp.sid('full'), 'SH001')->>'counted_by_name' = '仓库阿强', 'line match';
  -- 同一个商品在另一张开着的单（选货架那张）也算盘过了
  assert pg_temp.line(pg_temp.sid('bins'), 'SH001')->>'status' = 'match', 'other sheet sees the count';
end $$;

-- 5. 第一次不符 → 请再数（货架不改）；第二次还是不符 → 差异（货架改成盘到的数）。没给 sheet_id → 自动挂到有这个商品的单（抽查）
do $$ declare r jsonb; begin
  r := public.ops_wh_count_save_bins('{"location":"HQ","item_code":"SH002","bins":[{"bin":"T-R1","qty":0}],"loose":2,"note":"一箱在地上"}');
  assert r->>'result' = 'recount' and (r->>'bins_set')::int = 0 and (r->>'sheet_id')::bigint = pg_temp.sid('items'), 'recount: ' || r::text;
  assert pg_temp.binqty('T-R1', 'SH002') = 1, 'bin not changed on recount';
  assert pg_temp.line(pg_temp.sid('items'), 'SH002')->>'status' = 'recount', 'line recount';
  assert (public.ops_wh_count_bins('{"location":"HQ","item":"SH002"}')->>'recount')::boolean, 'count_bins says recount';
  r := public.ops_wh_count_save_bins('{"location":"HQ","item_code":"SH002","bins":[{"bin":"T-R1","qty":0}],"loose":2}');
  assert r->>'result' = 'variance' and (r->>'attempt')::int = 2 and (r->>'bins_set')::int = 1, 'variance: ' || r::text;
  assert pg_temp.binqty('T-R1', 'SH002') = 0, 'bin set on variance';
  assert pg_temp.line(pg_temp.sid('items'), 'SH002')->>'status' = 'variance', 'line variance';
  assert pg_temp.line(pg_temp.sid('full'), 'SH002')->>'status' = 'variance', 'full sheet too';
  -- 加一个货架：SH003 原本没上货架，盘的时候在 S-R2-1 找到 4 件 → 相符，货架帐多了这一格
  r := public.ops_wh_count_save_bins(jsonb_build_object('location', 'HQ', 'item_code', 'SH003', 'sheet_id', pg_temp.sid('full'),
         'bins', jsonb_build_array(jsonb_build_object('bin', 'BIN:' || pg_temp.binid('S-R2-1'), 'qty', 4))));
  assert r->>'result' = 'match' and pg_temp.binqty('S-R2-1', 'SH003') = 4, 'added bin: ' || r::text;
end $$;
-- 帮忙盘的（没被指派）也算；没走按货架盘的旧函数也算进盘点单
select pg_temp.as_user('counter2@example.com');
do $$ declare r jsonb; s jsonb; begin
  r := public.ops_wh_count_save('{"location":"HQ","item_code":"SH004","qty":2}');
  assert r->>'result' = 'match', 'plain count: ' || r::text;
  s := (select x from jsonb_array_elements(public.ops_wh_sheets('{}')) x where (x->>'id')::bigint = pg_temp.sid('full'));
  assert (s->>'done')::int = 4 and (s->>'variance')::int = 1 and (s->>'recount')::int = 0, 'progress: ' || s::text;
  assert (s->'assignees'->0->>'n')::int = 3 and s->'helpers'->0->>'name' = '盘点小华' and (s->'helpers'->0->>'n')::int = 1, 'people: ' || s::text;
  assert not (s->>'mine')::boolean, 'not mine';
  assert (select count(*) from jsonb_array_elements(public.ops_wh_sheets('{"mine":true}'))) = 2, 'counter2 has 2 sheets';
  assert (select (x->>'left')::int from jsonb_array_elements(public.ops_wh_sheet_home()) x where (x->>'id')::bigint = pg_temp.sid('items')) = 0, 'home left 0';
end $$;
-- 盘点单里盘过的不会再出现在每日清单
do $$ begin
  assert not exists (select 1 from jsonb_array_elements(public.ops_wh_count_list('', 'HQ', 500)->'todo') t
                     where t->>'item_code' in ('SH001', 'SH002', 'SH003', 'SH004')), 'counted items skipped in daily list';
end $$;

-- 6. 差异审核看得到盘点单名称与每一格；主管「请重盘」→ 盘点单那一行回到未盘
select pg_temp.as_user('whmgr@example.com');
do $$ declare v jsonb; n int; g jsonb; begin
  v := (select x from jsonb_array_elements(public.ops_wh_counts('{"status":"variance"}')) x where x->>'item_code' = 'SH002');
  assert v->>'sheet_title' = '抽查' and (v->>'diff')::numeric = -1
     and v->'bins' = '[{"qty": 0, "code": "T-R1"}, {"qty": 2, "code": null}]'::jsonb, 'review row: ' || v::text;
  g := public.ops_wh_sheet_get(jsonb_build_object('id', pg_temp.sid('items')));
  assert (g->>'can_manage')::boolean and (pg_temp.line(pg_temp.sid('items'), 'SH002')->>'diff')::numeric = -1
     and (pg_temp.line(pg_temp.sid('items'), 'SH002')->>'diff_value')::numeric = -60, 'manager sees diff: ' || g::text;
  n := public.ops_wh_count_review(array[(v->>'id')::bigint], 'recount');
  assert n = 1 and pg_temp.line(pg_temp.sid('items'), 'SH002')->>'status' = 'todo', 'recount → todo';
end $$;

-- 7. 改 / 结 / 取消（可审批）
select pg_temp.as_user('picker@example.com');
select pg_temp.expect_error(format($q$select public.ops_wh_sheet_close('{"id":%s}')$q$, pg_temp.sid('full')), '审批');
select pg_temp.as_user('whmgr@example.com');
select pg_temp.expect_error(format($q$select public.ops_wh_sheet_update('{"id":%s,"assignees":[%s]}')$q$, pg_temp.sid('full'), pg_temp.sid('hqsales')), '不能指派');
select pg_temp.expect_error(format($q$select public.ops_wh_sheet_update('{"id":%s,"due_date":"2027-01-01"}')$q$, pg_temp.sid('full')), '期限');
do $$ declare s jsonb; begin
  s := public.ops_wh_sheet_update(jsonb_build_object('id', pg_temp.sid('full'), 'due_date', '2027-03-08',
         'assignees', jsonb_build_array(pg_temp.sid('picker'), pg_temp.sid('counter2'))));
  assert s->>'due_date' = '2027-03-08' and jsonb_array_length(s->'assignees') = 2 and s->>'note' = '下班后盘', 'update: ' || s::text;
  s := public.ops_wh_sheet_close(jsonb_build_object('id', pg_temp.sid('full')));
  assert s->>'status' = 'closed' and s->>'closed_by_name' = '仓库主管', 'closed';
end $$;
select pg_temp.expect_error(format($q$select public.ops_wh_sheet_close('{"id":%s}')$q$, pg_temp.sid('full')), '已经结束');
select pg_temp.expect_error(format($q$select public.ops_wh_sheet_cancel('{"id":%s}')$q$, pg_temp.sid('items')), '原因');
select pg_temp.as_user('picker@example.com');
select pg_temp.expect_error(format($q$select public.ops_wh_count_save_bins('{"location":"HQ","item_code":"SH001","bins":[{"bin":"S-R1-1","qty":3},{"bin":"S-R2-1","qty":2}],"sheet_id":%s}')$q$,
  pg_temp.sid('full')), '已经结束');
-- 结单后才盘的不算进那张单（抽查那张还开着，算进去）
do $$ begin
  perform public.ops_wh_count_save_bins('{"location":"HQ","item_code":"SH002","bins":[{"bin":"T-R1","qty":0}],"loose":3}');
  assert pg_temp.line(pg_temp.sid('items'), 'SH002')->>'status' = 'match', 'items sheet: recounted after review';
  assert pg_temp.line(pg_temp.sid('full'), 'SH002')->>'status' = 'todo', 'closed sheet frozen (its count was re-queued)';
  assert (select count(*) from jsonb_array_elements(public.ops_wh_sheets('{}'))) = 2
     and (select count(*) from jsonb_array_elements(public.ops_wh_sheets('{"status":"done"}'))) >= 1, 'open / done lists';
end $$;
select pg_temp.as_user('whmgr@example.com');
do $$ declare s jsonb; begin
  s := public.ops_wh_sheet_cancel(jsonb_build_object('id', pg_temp.sid('bins'), 'reason', '改天整个仓位一起盘'));
  assert s->>'status' = 'cancelled' and s->>'cancel_reason' = '改天整个仓位一起盘', 'cancelled';
end $$;

-- 8. 盘点统计（只有可审批）
select pg_temp.as_user('picker@example.com');
select pg_temp.expect_error($q$select public.ops_wh_count_stats('{}')$q$, '审批');
select pg_temp.as_user('whmgr@example.com');
do $$ declare s jsonb; sm jsonb; begin
  s := public.ops_wh_count_stats('{"days":30}');
  sm := s->'summary';
  -- 2027-03-01：SH001 相符、SH002 第一次请再数（作废）→ 第二次差异 → 主管请重盘（作废）→ 再盘相符、SH003 相符、SH004 相符
  assert (sm->>'counts')::int = 4 and (sm->>'match')::int = 4 and (sm->>'variance')::int = 0, 'summary: ' || sm::text;
  assert jsonb_array_length(s->'top') = 0 and s->'months'->-1->>'month' = '2027-03', 'top / months: ' || s::text;
  assert (select (x->>'counts')::int from jsonb_array_elements(s->'people') x where x->>'name' = '仓库阿强') = 3, 'people: ' || (s->'people')::text;
  -- 180 天会算进前面测试（2026-10）的盘点
  s := public.ops_wh_count_stats('{"days":180}');
  assert (s->'summary'->>'counts')::int > 4 and jsonb_array_length(s->'top') >= 1, '180 days: ' || (s->'summary')::text;
  assert (s->'top'->0->>'times')::int >= 1 and s->'top'->0 ? 'value', 'top row';
  s := public.ops_wh_count_stats('{"days":30,"location":"SRGADING"}');
  assert (s->'summary'->>'counts')::int = 0, 'location filter';
end $$;
-- 差异金额：再做一个差异（SH004 少 1 件，成本 10）
select pg_temp.as_user('picker@example.com');
select pg_temp.at('2027-03-02 10:00:00+08');
do $$ begin
  perform public.ops_wh_count_save_bins('{"location":"HQ","item_code":"SH004","loose":1}');
  perform public.ops_wh_count_save_bins('{"location":"HQ","item_code":"SH004","loose":1}');
end $$;
select pg_temp.as_user('whmgr@example.com');
do $$ declare s jsonb := public.ops_wh_count_stats('{"days":30}'); begin
  assert (s->'summary'->>'variance')::int = 1 and (s->'summary'->>'value_net')::numeric = -10
     and (s->'summary'->>'value_abs')::numeric = 10, 'value: ' || (s->'summary')::text;
  assert s->'top'->0->>'item_code' = 'SH004' and (s->'top'->0->>'units')::numeric = -1, 'top: ' || (s->'top')::text;
  assert (select (x->>'variance')::int from jsonb_array_elements(s->'people') x where x->>'name' = '仓库阿强') = 1, 'person variance';
end $$;

-- 9. 权限：门市（只看）不能用；JB 看不到总部的单；首页提醒不会出错；内部函数一般账号叫不到
select pg_temp.as_user('hqsales@example.com');
select pg_temp.expect_error($q$select public.ops_wh_sheets('{}')$q$, '编辑');
select pg_temp.expect_error($q$select public.ops_wh_count_save_bins('{"location":"HQ","item_code":"SH001","loose":5}')$q$, '编辑');
select pg_temp.expect_error($q$select public.ops_wh_count_bins('{"location":"HQ","item":"SH001"}')$q$, '编辑');
do $$ begin assert public.ops_wh_sheet_home() = '[]'::jsonb, 'sales home empty'; end $$;
select pg_temp.as_user('jbwh@example.com');
do $$ begin
  assert public.ops_wh_sheets('{}') = '[]'::jsonb, 'JB has no sheets';
  assert public.ops_wh_sheet_home() = '[]'::jsonb, 'JB home empty';
end $$;
select pg_temp.expect_error($q$select public.ops_wh_sheets('{"company":"HOMEWORKSSB"}')$q$, '分店');
select pg_temp.expect_error(format($q$select public.ops_wh_sheet_get('{"id":%s}')$q$, pg_temp.sid('items')), '找不到这张盘点单');
select pg_temp.expect_error(format($q$select public.ops_wh_count_save_bins('{"location":"JB","item_code":"SH001","loose":7,"sheet_id":%s}')$q$, pg_temp.sid('items')), '找不到这张盘点单');
do $$ declare r jsonb; begin
  r := public.ops_wh_count_save_bins('{"location":"JB","item_code":"SH001","loose":7}');
  assert r->>'result' = 'match' and r->'sheet_id' = 'null'::jsonb, 'JB count, no sheet: ' || r::text;
end $$;
select pg_temp.expect_error($q$select ops.wh_sheet_counts(null::ops.wh_count_sheet)$q$, 'permission');
select pg_temp.expect_error($q$select ops.wh_sheet_eligible(null::ops.staff, 'HOMEWORKSSB')$q$, 'permission');
reset role;
select 'sheet_test ok' as result;
