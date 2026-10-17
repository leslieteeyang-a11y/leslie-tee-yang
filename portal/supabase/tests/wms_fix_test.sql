-- 仓库新功能合并后审查的修正（2026-10-15）。接在全部新功能测试之后跑，只用自己建的商品 RF001 / RF002 与货架 R-*。
-- 涵盖：两次上架不丢数、停用货架冲回后还能盘成 0、已开 DO 还没备算进应有、撤销自己的货架动作、DO 单位不同不从货架扣、
-- 已备好的备货单只有可审批能取消、批次号 / 批次 QR 当商品扫、Excel 带入同一个交易叫两次。
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
create or replace function pg_temp.binqty(p_code text, p_item text) returns numeric language sql as $$
  select coalesce((select (x->>'qty')::numeric
    from jsonb_array_elements(public.ops_wh_bin_get(jsonb_build_object('bin', p_code, 'location', 'HQ'))->'items') x
    where x->>'item_code' = p_item), 0)
$$;
create or replace function pg_temp.hq(p_item text) returns jsonb language sql as $$
  select x from jsonb_array_elements(public.ops_wh_item_bins(jsonb_build_object('item', p_item))->'locations') x
  where x->>'location' = 'HQ'
$$;
grant execute on all functions in schema pg_temp to authenticated;

-- 测试资料：RF001 HQ 有 5 件；RF002 单位 PCS；今天开一张 DO（RF001 × 2，还没备；RF002 × 1 CTN）
insert into bi.dim_item values ('HOMEWORKSSB', 'RF001', 'REVIEW FIX ITEM', 'TAP', 'HEMOS', 'PCS'),
  ('HOMEWORKSSB', 'RF002', 'REVIEW BOX ITEM', 'TAP', 'HEMOS', 'PCS');
insert into bi.fact_stock values ('HOMEWORKSSB', 'RF001', 'HQ', 5, 50), ('HOMEWORKSSB', 'RF002', 'HQ', 24, 24);
insert into bi.delivery_doc (company, doc_no, doc_date, debtor_code, debtor_name, items, lines) values
  ('HOMEWORKSSB', 'DO-RF1', (now() at time zone 'Asia/Kuala_Lumpur')::date, '300-C001', 'RF CUSTOMER', 'x',
   '[{"d":"review fix item","q":2,"u":"PCS"},{"d":"REVIEW BOX ITEM","q":1,"u":"CTN"}]');

set role authenticated;
select pg_temp.as_user('whmgr@example.com');
select public.ops_wh_bin_bulk('{"location":"HQ","zone":"R","shelves":["F1","F2"]}');

-- 1. 已开 DO 还没备（AutoCount 已扣 2 件）：应有 = 5 + 2 = 7；上架 7 件不用确认，对不上清单不会列 RF001
select pg_temp.as_user('picker@example.com');
do $$ declare h jsonb; r jsonb; begin
  h := pg_temp.hq('RF001');
  assert (h->>'do_unpicked')::numeric = 2 and (h->>'expected')::numeric = 7, 'expected includes unpicked DO: ' || h::text;
  -- 两次上架（第一次放上这一格）合计要对
  r := public.ops_wh_bin_op('{"kind":"putaway","item":"RF001","qty":3,"bin":"R-F1","location":"HQ"}');
  assert (r->>'ok')::boolean and r->>'ref_id' is not null, 'putaway 1: ' || r::text;
  r := public.ops_wh_bin_op('{"kind":"putaway","item":"RF001","qty":4,"bin":"R-F1","location":"HQ"}');
  assert (r->>'ok')::boolean and (r->>'shelved')::numeric = 7, 'putaway 2 no confirm needed: ' || r::text;
  assert pg_temp.binqty('R-F1', 'RF001') = 7, 'two putaways add up';
  r := public.ops_wh_bin_recon('{"location":"HQ","filter":"over","q":"RF001"}');
  assert jsonb_array_length(r->'rows') = 0, 'not over because of unpicked DO: ' || r::text;
  r := public.ops_wh_bin_recon('{"location":"HQ","filter":"all","q":"RF001"}');
  assert (r->'rows'->0->>'do_unpicked')::numeric = 2, 'recon shows do_unpicked: ' || r::text;
end $$;

-- 2. 撤销自己的动作（服务器照纪录反向）：只能撤销一次；别人的不能撤销
do $$ declare r jsonb; u jsonb; begin
  r := public.ops_wh_bin_op('{"kind":"move","item":"RF001","qty":2,"from_bin":"R-F1","to_bin":"R-F2","location":"HQ"}');
  u := public.ops_wh_bin_undo('', (r->>'ref_id')::bigint);
  assert (u->>'reversed')::int = 2 and pg_temp.binqty('R-F1', 'RF001') = 7 and pg_temp.binqty('R-F2', 'RF001') = 0, 'undo move';
  perform set_config('test.ref', r->>'ref_id', false);
end $$;
select pg_temp.expect_error($q$select public.ops_wh_bin_undo('', current_setting('test.ref')::bigint)$q$, '撤销过');
select pg_temp.as_user('whmgr@example.com');
select pg_temp.expect_error($q$select public.ops_wh_bin_undo('', current_setting('test.ref')::bigint)$q$, '自己做的');

-- 3. 备货：DO 单位 CTN ≠ 商品 PCS → 有选货架就不扣（回 code = uom）；不选货架照样可以备
select pg_temp.as_user('picker@example.com');
do $$ declare g jsonb; pid bigint; r jsonb; begin
  g := public.ops_wh_pick_start('', 'DO-RF1');
  pid := (g->'pick'->>'id')::bigint;
  perform set_config('test.pick', pid::text, false);
  r := public.ops_wh_pick_scan(jsonb_build_object('pick_id', pid, 'code', 'RF002', 'bin', 'R-F1'));
  assert not (r->>'ok')::boolean and r->>'code' = 'uom', 'uom mismatch blocked: ' || r::text;
  r := public.ops_wh_pick_scan(jsonb_build_object('pick_id', pid, 'code', 'RF002'));
  assert (r->>'ok')::boolean, 'pick without bin ok: ' || r::text;
  r := public.ops_wh_pick_scan(jsonb_build_object('pick_id', pid, 'code', 'RF001', 'qty', 2, 'bin', 'R-F1'));
  assert (r->>'ok')::boolean and pg_temp.binqty('R-F1', 'RF001') = 5, 'pick from bin: ' || r::text;
  -- 备了以后：DO 未备变 0，应有回到 5，货架 5
  assert (pg_temp.hq('RF001')->>'do_unpicked')::numeric = 0 and (pg_temp.hq('RF001')->>'expected')::numeric = 5, 'after pick';
  r := public.ops_wh_pick_done(jsonb_build_object('pick_id', pid));
  assert r->'pick'->>'status' = 'done', 'done: ' || r::text;
end $$;
-- 已备好的：开始的人（可编辑）不能取消，可审批可以（货架加回去）
select pg_temp.expect_error($q$select public.ops_wh_pick_cancel(jsonb_build_object('pick_id', current_setting('test.pick')::bigint, 'reason', '测试'))$q$, '可审批');
select pg_temp.as_user('whmgr@example.com');
do $$ declare r jsonb; begin
  r := public.ops_wh_pick_cancel(jsonb_build_object('pick_id', current_setting('test.pick')::bigint, 'reason', '测试'));
  assert (r->>'ok')::boolean and pg_temp.binqty('R-F1', 'RF001') = 7, 'approve cancels done pick: ' || r::text;
end $$;

-- 4. 停用货架：搬动从 R-F2 拿走 2 件 → R-F2 清空、停用 → 搬动取消，冲回到已停用的 R-F2。
--    之后这一格只能减少（拿走 / 盘成 0），不能再放；按货架盘的时候也列得出来
select pg_temp.as_user('whmgr@example.com');
select public.ops_wh_bin_op('{"kind":"putaway","item":"RF001","qty":2,"bin":"R-F2","location":"HQ","confirm":true}');
reset role;
do $$ declare me ops.staff; mv bigint; begin
  select * into me from ops.staff where email = 'picker@example.com';
  insert into ops.wh_move (company, item_code, qty, kind, from_loc, to_loc, created_by)
  values ('HOMEWORKSSB', 'RF001', 2, 'transfer', 'HQ', 'SRGADING', me.id) returning id into mv;
  perform ops.wh_bin_apply(me, (select id from ops.wh_bin where company = 'HOMEWORKSSB' and location = 'HQ' and code = 'R-F2'),
                           'RF001', -2, 'take', 'move', mv, '调去 SRGADING');
  perform set_config('test.mv2', mv::text, false);
end $$;
set role authenticated;
select pg_temp.as_user('whmgr@example.com');
do $$ declare id bigint; b jsonb; c jsonb; begin
  id := (select (x->>'id')::bigint from jsonb_array_elements(public.ops_wh_bins('{"location":"HQ"}')->'bins') x where x->>'code' = 'R-F2');
  perform public.ops_wh_bin_save(jsonb_build_object('id', id, 'location', 'HQ', 'zone', 'R', 'shelf', 'F2', 'active', false));
  assert public.ops_wh_move_mark(array[current_setting('test.mv2')::bigint], 'cancelled', '', '测试') = 1, 'cancel move';
  b := public.ops_wh_bin_get('{"bin":"R-F2","location":"HQ"}');
  assert not (b->>'active')::boolean and (b->'items'->0->>'qty')::numeric = 2, 'reversed onto inactive bin: ' || b::text;
  c := public.ops_wh_count_bins('{"location":"HQ","item":"RF001"}');
  assert exists (select 1 from jsonb_array_elements(c->'bins') x where x->>'code' = 'R-F2'), 'inactive bin with stock listed: ' || c::text;
end $$;
select pg_temp.expect_error($q$select public.ops_wh_bin_op('{"kind":"putaway","item":"RF001","qty":1,"bin":"R-F2","location":"HQ"}')$q$, '停用');
do $$ begin
  perform public.ops_wh_bin_op('{"kind":"take","item":"RF001","qty":2,"bin":"R-F2","location":"HQ"}');
  assert pg_temp.binqty('R-F2', 'RF001') = 0, 'take from inactive bin';
end $$;

-- 5. 批次号 / 批次 QR 当商品扫：上架、备货、盘点都认得
reset role;
insert into ops.wh_lot (lot_no, company, item_code, qty, boxes, location, created_by)
select 'L261015-9901', 'HOMEWORKSSB', 'RF001', 3, 1, 'HQ', id from ops.staff where email = 'picker@example.com';
set role authenticated;
select pg_temp.as_user('picker@example.com');
do $$ declare r jsonb; begin
  r := public.ops_wh_bin_op('{"kind":"take","item":"https://x.example/#/warehouse/lot/l261015-9901","qty":1,"bin":"R-F1","location":"HQ"}');
  assert r->>'item_code' = 'RF001', 'lot QR resolves to item: ' || r::text;
  r := public.ops_wh_item_bins('{"item":"L261015-9901"}');
  assert r->>'item_code' = 'RF001', 'lot number resolves';
end $$;

-- 6. Excel 带入：同一个交易里试算再存（暂存表用 call_id 分开，不用 truncate）
select pg_temp.as_user('whmgr@example.com');
do $$ declare r jsonb; begin
  r := public.ops_wh_bin_import('{"location":"HQ","rows":[{"item":"RF002","zone":"R","shelf":"F3","qty":6}],"create_bins":true,"dry_run":true}');
  assert (r->>'ok')::boolean and not (r->>'saved')::boolean and (r->>'new_bins')::int = 1, 'dry run: ' || r::text;
  r := public.ops_wh_bin_import('{"location":"HQ","rows":[{"item":"RF002","zone":"R","shelf":"F3","qty":6}],"create_bins":true}');
  assert (r->>'saved')::boolean and jsonb_array_length(r->'rows') = 1 and pg_temp.binqty('R-F3', 'RF002') = 6, 'import saved: ' || r::text;
end $$;
reset role;
select 'wms_fix_test ok' as result;
