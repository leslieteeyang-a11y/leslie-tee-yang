-- 商品标签、商品照片、入库箱贴（批次）、打印纪录、库存总表标签筛选 / 下载（2026-10-15）。接在 bin_test.sql 之后跑。
-- 用到前面测试建的人：picker（仓库可编辑、看得到厂家、不能标标签）、whmgr（仓库可审批 = 可标标签、看成本）、
-- hqsales（门市：仓库只看、看不到厂家）、buyer3（采购：订货可编辑 = 可标标签、可建批次）、jbwh（JB 仓库）。
-- 前面 rpl_test 的资料：近 90 天销量 ST003 45、ST002 12、ST004 2；最后进货 ST004 200 天前（库存 4）、ST003 100 天前。
-- 自己的进货用 TGA / TGB（测完把这两笔进货取消，不影响后面的测试）。
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
-- 模拟手机上传照片（Storage 的 insert 由 policy 把关，这里直接写 objects 表）
create or replace function pg_temp.upload(p_name text) returns text language plpgsql security definer as $$
begin
  insert into storage.objects (bucket_id, name) values ('ops-wh', p_name);
  return p_name;
end $$;
create or replace function pg_temp.tags_of(p_item text) returns text language sql as $$
  select coalesce((select string_agg(x, ',' order by o) from jsonb_array_elements_text(
    public.ops_wh_item_tags(jsonb_build_object('items', jsonb_build_array(p_item))) -> p_item) with ordinality t(x, o)), '')
$$;
create or replace function pg_temp.tag_n(p_tag text) returns int language sql as $$
  select (x->>'items')::int from jsonb_array_elements(public.ops_wh_tags('{}')->'tags') x where x->>'name' = p_tag
$$;
grant execute on all functions in schema pg_temp to authenticated;

-- 测试资料：再加 40 个有销量的商品（TGQ01..TGQ40 卖 1..40 件）→ 总部 43 个有销量，前 5% = 前 3 名（ST003 45、TGQ40、TGQ39）；
-- JB 的 RA 近 90 天 5 件：排第一但不到 10 件 → 不算畅销
insert into bi.mv_purchase_sold (company, item_code, q90)
select 'HOMEWORKSSB', 'TGQ' || lpad(g::text, 2, '0'), g from generate_series(1, 40) g;
insert into bi.mv_purchase_sold (company, item_code, q90) values ('HOMEWORKSSOUTHERN', 'RA', 5);
insert into bi.dim_item values ('HOMEWORKSSB', 'TGA', 'TAG BOX A', 'SANITARY', 'HEMOS', 'PCS'),
  ('HOMEWORKSSB', 'TGB', 'TAG BOX B', 'SANITARY', 'HEMOS', 'PCS'), ('HOMEWORKSSB', 'TG/Q 1', 'SLASH CODE', 'TAP', 'HEMOS', 'PCS');
-- 厂家到货（已点货）+ 两笔进货：TGA 6 件进 HQ（总部）、TGB 2 件进 PRE (JB)（给 JB）；另一笔已取消的
do $$
declare
  pk bigint := (select id from ops.staff where email = 'picker@example.com');
  d bigint;
begin
  insert into ops.supplier_do (company, creditor_code, supplier_name, do_no, do_date, status, arrived_by, arrived_at, created_by)
  values ('HOMEWORKSSB', '4000-TG1', 'TAG FACTORY', 'TG-DO-1', current_date - 2, 'arrived', pk, now() - interval '1 day', pk)
  returning id into d;
  insert into ops.wh_move (company, item_code, qty, kind, from_loc, to_loc, created_by, do_id, po_no, outlet) values
    ('HOMEWORKSSB', 'TGA', 6, 'receive', null, 'HQ', pk, d, 'PO-TG1', 'HQ'),
    ('HOMEWORKSSB', 'TGB', 2, 'receive', null, 'PRE (JB)', pk, d, 'PO-TG1', 'JB');
  insert into ops.wh_move (company, item_code, qty, kind, from_loc, to_loc, created_by, do_id, po_no, outlet, status)
  values ('HOMEWORKSSB', 'TGB', 1, 'receive', null, 'HQ', pk, d, 'PO-TG1', 'HQ', 'cancelled');
  perform set_config('tg.do', d::text, false);
  perform set_config('tg.mva', (select id::text from ops.wh_move where do_id = d and item_code = 'TGA'), false);
  perform set_config('tg.mvb', (select id::text from ops.wh_move where do_id = d and item_code = 'TGB' and status = 'pending'), false);
  perform set_config('tg.mvx', (select id::text from ops.wh_move where do_id = d and status = 'cancelled'), false);
end $$;
grant usage on schema storage to authenticated;

set role authenticated;

-- 1. 标签：谁能看、谁能标
select pg_temp.as_user('hqsales@example.com');
do $$ declare t jsonb; begin
  t := public.ops_wh_tags('{}');
  assert not (t->>'can_edit')::boolean, 'sales cannot tag';
  assert (select count(*) from jsonb_array_elements(t->'tags') x where x->>'name' in ('清货', '畅销', '滞销')) = 3, 'default tags';
  assert pg_temp.tag_n('畅销') = 3, 'hot = top 5% (3 items): ' || pg_temp.tag_n('畅销');
  assert pg_temp.tag_n('滞销') >= 1, 'slow';
  assert pg_temp.tags_of('ST003') = '畅销', 'ST003 hot: ' || pg_temp.tags_of('ST003');
  assert pg_temp.tags_of('TGQ40') = '畅销' and pg_temp.tags_of('TGQ39') = '畅销' and pg_temp.tags_of('TGQ38') = '', 'top 3 only';
  assert pg_temp.tags_of('ST002') = '', 'ST002 (12) not in top 5%';
  assert pg_temp.tags_of('ST004') = '滞销', 'ST004 slow (200 days): ' || pg_temp.tags_of('ST004');
end $$;
select pg_temp.expect_error($q$select public.ops_wh_item_tag_set('{"items":["ST002"],"tag":"清货"}')$q$, '订货「可编辑」或仓库「可审批」');
select pg_temp.expect_error($q$select public.ops_wh_tag_save('{"name":"新的"}')$q$, '订货「可编辑」或仓库「可审批」');
select pg_temp.as_user('picker@example.com');   -- 仓库可编辑（不是可审批）、订货只看：不能标
select pg_temp.expect_error($q$select public.ops_wh_item_tag_set('{"items":["ST002"],"tag":"清货"}')$q$, '订货「可编辑」或仓库「可审批」');
select pg_temp.as_user('whmgr@example.com');
do $$ declare r jsonb; begin
  assert (public.ops_wh_tags('{}')->>'can_edit')::boolean, 'warehouse approve can tag';
  r := public.ops_wh_item_tag_set('{"items":["st002","ST004"],"tag":"清货"}');
  assert (r->>'changed')::int = 2 and r->'tags'->'ST004' = '["清货","滞销"]'::jsonb, 'tag 2: ' || r::text;
  r := public.ops_wh_item_tag_set('{"items":["ST002"],"tag":"清货"}');
  assert (r->>'changed')::int = 0, 'tag again = no change';
  assert pg_temp.tag_n('清货') = 2, 'clearance count';
  r := public.ops_wh_item_tag_set('{"item":"ST004","tag":"清货","on":false}');
  assert (r->>'changed')::int = 1 and r->'tags'->'ST004' = '["滞销"]'::jsonb, 'untag: ' || r::text;
  r := public.ops_wh_item_tag_set('{"item":"ST004","tag":"清货"}');   -- 拿掉后再标回来
  assert (r->>'changed')::int = 1, 're-tag';
end $$;
select pg_temp.expect_error($q$select public.ops_wh_item_tag_set('{"items":["ST003"],"tag":"畅销"}')$q$, '自动标');
select pg_temp.expect_error($q$select public.ops_wh_item_tag_set('{"items":["NOPE"],"tag":"清货"}')$q$, '找不到商品');
select pg_temp.expect_error($q$select public.ops_wh_item_tag_set('{"items":["ST003"],"tag":"没有"}')$q$, '没有这个标签');
select pg_temp.expect_error($q$select public.ops_wh_tag_save('{"name":"一二三四五六七八九十一"}')$q$, '10 个字');
select pg_temp.expect_error($q$select public.ops_wh_tag_save('{"name":"展示品","color":"pink"}')$q$, '颜色');
-- 采购（订货可编辑）也能建标签；停用的标签不能再标
select pg_temp.as_user('buyer3@example.com');
do $$ declare g jsonb; begin
  g := public.ops_wh_tag_save('{"name":" 展示品 ","color":"purple"}');
  assert g->>'name' = '展示品' and g->>'kind' = 'manual' and g->>'color' = 'purple', 'new tag: ' || g::text;
  perform public.ops_wh_item_tag_set('{"items":["ST003"],"tag":"展示品"}');
  assert pg_temp.tags_of('ST003') = '畅销,展示品', 'sorted by tag sort: ' || pg_temp.tags_of('ST003');
  g := public.ops_wh_tag_save('{"name":"展示品","active":false}');
  assert not (g->>'active')::boolean and g->>'color' = 'purple', 'deactivate keeps color';
  assert pg_temp.tags_of('ST003') = '畅销', 'inactive tag hidden';
end $$;
-- 自动标签两间分店共用：只属总部的采购不能停用（审查 DBSEC-3）；管理全部分店的人可以
select pg_temp.expect_error($q$select public.ops_wh_tag_save('{"name":"畅销","active":false}')$q$, '两间分店共用');
select pg_temp.as_user('boss@example.com');
do $$ declare g jsonb; begin
  -- 自动标签只能改颜色 / 停用：停用「畅销」→ 没有商品是畅销；再开回来
  perform public.ops_wh_tag_save('{"name":"畅销","active":false}');
  assert pg_temp.tags_of('ST003') = '' and pg_temp.tag_n('畅销') = 0, 'auto tag off';
  g := public.ops_wh_tag_save('{"name":"畅销","active":true,"color":"blue"}');
  assert g->>'kind' = 'auto' and g->>'color' = 'blue' and pg_temp.tags_of('ST003') = '畅销', 'auto tag back on';
end $$;
select pg_temp.as_user('buyer3@example.com');
select pg_temp.expect_error($q$select public.ops_wh_item_tag_set('{"items":["ST004"],"tag":"展示品"}')$q$, '停用');
-- JB：看不到总部；JB 的 RA 卖 5 件，第一名但不到 10 件 → 不是畅销
select pg_temp.as_user('jbwh@example.com');
select pg_temp.expect_error($q$select public.ops_wh_tags('{"company":"HOMEWORKSSB"}')$q$, '分店');
do $$ begin
  assert public.ops_wh_item_tags('{"items":["RA"]}') = '{}'::jsonb, 'JB RA (5 pcs) not hot';
end $$;

-- 2. 库存总表：标签筛选、每列标签；下载 Excel 的成本只给可审批
select pg_temp.as_user('picker@example.com');
do $$ declare s jsonb; e jsonb; begin
  s := public.ops_wh_stock('{"tag":"畅销"}');
  assert (s->>'total')::int >= 1 and (s->>'total')::int = jsonb_array_length(s->'rows'), 'hot rows: ' || (s->>'total');
  assert not exists (select 1 from jsonb_array_elements(s->'rows') x where x->>'item_code' <> 'ST003' or x->'tags' <> '["畅销"]'::jsonb), 'only ST003 with tags';
  s := public.ops_wh_stock('{"tag":"清货","q":"st00"}');
  assert (select count(distinct x->>'item_code') from jsonb_array_elements(s->'rows') x) = 2, 'clearance: ST002 + ST004';
  assert (select x->'tags' from jsonb_array_elements(s->'rows') x where x->>'item_code' = 'ST004' limit 1) = '["清货","滞销"]'::jsonb, 'row tags';
  s := public.ops_wh_stock('{}');
  assert s->'rows'->0 ? 'tags' and not (s->>'show_cost')::boolean, 'plain stock has tags, no cost';
  e := public.ops_wh_stock_export('{"tag":"滞销"}');
  assert not (e->>'show_cost')::boolean and not (e->>'capped')::boolean and (e->>'total')::int = jsonb_array_length(e->'rows'), 'export: ' || e::text;
  assert not exists (select 1 from jsonb_array_elements(e->'rows') x where x->>'total_cost' is not null or not x->'tags' ? '滞销'), 'no cost for edit';
  assert exists (select 1 from jsonb_array_elements(e->'rows') x where x->>'item_code' = 'ST004'), 'ST004 exported';
  assert (select x->>'item_total' from jsonb_array_elements(e->'rows') x limit 1) is not null, 'export item_total';
end $$;
select pg_temp.as_user('whmgr@example.com');
do $$ declare e jsonb; begin
  e := public.ops_wh_stock_export('{"tag":"滞销"}');
  assert (e->>'show_cost')::boolean and (select bool_and(x->>'total_cost' is not null) from jsonb_array_elements(e->'rows') x), 'approve sees cost';
  e := public.ops_wh_stock_export('{}');
  assert (e->>'total')::int = jsonb_array_length(e->'rows') and (e->>'total')::int = (public.ops_wh_stock('{}')->>'total')::int, 'export all rows';
end $$;
select pg_temp.as_user('hqsales@example.com');
do $$ begin
  assert (public.ops_wh_stock_export('{}')->>'total')::int > 0, 'view can export';
end $$;

-- 3. 商品照片：Storage policy 与存照片
do $$ begin
  assert public.ops_wh_file_ok('items/HOMEWORKSSB/ST003/a.jpg', false), 'sales (view) can read';
  assert not public.ops_wh_file_ok('items/HOMEWORKSSB/ST003/a.jpg', true), 'sales cannot write';
  assert not public.ops_wh_file_ok('items/HOMEWORKSSB/ST003/a.jpg', null), 'null write = write';
end $$;
select pg_temp.as_user('jbwh@example.com');
do $$ begin
  assert not public.ops_wh_file_ok('items/HOMEWORKSSB/ST003/a.jpg', false), 'JB cannot read HQ';
  assert public.ops_wh_file_ok('items/HOMEWORKSSOUTHERN/RA/a.jpg', true), 'JB writes JB';
end $$;
select pg_temp.as_user('picker@example.com');
do $$ declare r jsonb; m jsonb; begin
  assert public.ops_wh_file_ok('items/HOMEWORKSSB/ST003/a.jpg', true), 'picker can write';
  assert not public.ops_wh_file_ok('other/HOMEWORKSSB/ST003/a.jpg', false) and not public.ops_wh_file_ok('items/MARS/x/a.jpg', false)
     and not public.ops_wh_file_ok(null, false), 'bad paths';
end $$;
select pg_temp.expect_error($q$select public.ops_wh_item_photo_set('{"item":"ST003","path":"items/HOMEWORKSSB/ST003/none.jpg"}')$q$, '还没上传成功');
select pg_temp.expect_error($q$select public.ops_wh_item_photo_set(jsonb_build_object('item','ST003','path',pg_temp.upload('items/HOMEWORKSSB/ST004/x.jpg')))$q$, '还没上传成功');
do $$ declare r jsonb; m jsonb; begin
  r := public.ops_wh_item_photo_set(jsonb_build_object('item', 'st003', 'path', pg_temp.upload('items/HOMEWORKSSB/ST003/p1.jpg')));
  assert r->'photo'->>'path' = 'items/HOMEWORKSSB/ST003/p1.jpg' and r->'photo'->>'by_name' = '仓库阿强', 'photo 1: ' || r::text;
  r := public.ops_wh_item_photo_set(jsonb_build_object('item', 'ST003', 'path', pg_temp.upload('items/HOMEWORKSSB/ST003/p2.jpg')));
  m := public.ops_wh_item_photos('HOMEWORKSSB', array['ST003', 'ST004']);
  assert m->'ST003'->>'path' = 'items/HOMEWORKSSB/ST003/p2.jpg' and not m ? 'ST004', 'replace: ' || m::text;
  -- 商品代号有斜线 / 空白：路径换成 _
  r := public.ops_wh_item_photo_set(jsonb_build_object('item', 'TG/Q 1', 'path', pg_temp.upload('items/HOMEWORKSSB/TG_Q_1/s.jpg')));
  assert r->'photo'->>'item_code' = 'TG/Q 1', 'odd code';
  r := public.ops_wh_item_photo_set('{"item":"TG/Q 1","remove":true}');
  assert r->'photo' = 'null'::jsonb and not public.ops_wh_item_photos('HOMEWORKSSB', array['TG/Q 1']) ? 'TG/Q 1', 'remove';
end $$;
select pg_temp.as_user('hqsales@example.com');
select pg_temp.expect_error($q$select public.ops_wh_item_photo_set('{"item":"ST003","remove":true}')$q$, '编辑');
do $$ begin
  assert public.ops_wh_item_photos('HOMEWORKSSB', array['ST003'])->'ST003'->>'path' like '%/p2.jpg', 'sales sees photo';
end $$;
select pg_temp.as_user('jbwh@example.com');
select pg_temp.expect_error($q$select public.ops_wh_item_photos('HOMEWORKSSB', array['ST003'])$q$, '分店');

-- 4. 入库箱贴：批次号、从进货建、手动建、权限、看不到厂家的人没有 DO 号
select pg_temp.as_user('hqsales@example.com');
select pg_temp.expect_error(format($q$select public.ops_wh_lot_create('{"lots":[{"move_id":%s}]}')$q$, current_setting('tg.mva')), '可编辑');
select pg_temp.as_user('picker@example.com');
do $$ declare r jsonb; a jsonb; b jsonb; ymd text := to_char((now() at time zone 'Asia/Kuala_Lumpur')::date, 'YYMMDD'); n1 int; begin
  r := public.ops_wh_lot_create(jsonb_build_object('lots', jsonb_build_array(
         jsonb_build_object('move_id', current_setting('tg.mva'), 'boxes', 3),
         jsonb_build_object('move_id', current_setting('tg.mvb')))));
  a := r->'lots'->0; b := r->'lots'->1;
  assert a->>'lot_no' ~ ('^L' || ymd || '-[0-9]{4}$') and b->>'lot_no' ~ ('^L' || ymd || '-[0-9]{4}$'), 'lot no format: ' || r::text;
  n1 := split_part(a->>'lot_no', '-', 2)::int;
  assert split_part(b->>'lot_no', '-', 2)::int = n1 + 1, 'sequence +1';
  assert a->>'item_code' = 'TGA' and (a->>'qty')::numeric = 6 and (a->>'boxes')::int = 3 and a->>'location' = 'HQ'
     and a->>'outlet' = 'HQ' and a->>'do_no' = 'TG-DO-1' and a->>'po_no' = 'PO-TG1' and a->>'supplier_name' = 'TAG FACTORY'
     and a->>'received_by_name' = '仓库阿强' and a->>'received_at' is not null, 'lot from receive: ' || a::text;
  assert b->>'outlet' = 'JB' and b->>'outlet_name' = 'JB' and b->>'location' = 'PRE (JB)' and (b->>'boxes')::int = 1, 'JB lot: ' || b::text;
  perform set_config('tg.lota', a->>'lot_no', false);
  perform set_config('tg.lotb', b->>'lot_no', false);
  -- 同一笔进货再建 = 同一个批次、改箱数
  r := public.ops_wh_lot_create(jsonb_build_object('lots', jsonb_build_array(jsonb_build_object('move_id', current_setting('tg.mva'), 'boxes', 4))));
  assert r->'lots'->0->>'lot_no' = a->>'lot_no' and (r->'lots'->0->>'boxes')::int = 4, 'same move = same lot';
  -- 手动建：仓位要有、数量要对
  r := public.ops_wh_lot_create('{"lots":[{"item":"st003","qty":"5","location":"HQ","outlet":"BATU","boxes":2,"note":"手动"}]}');
  assert r->'lots'->0->>'item_code' = 'ST003' and r->'lots'->0->>'outlet_name' = 'Batu' and r->'lots'->0->>'do_no' is null
     and split_part(r->'lots'->0->>'lot_no', '-', 2)::int = n1 + 2, 'manual lot: ' || r::text;
  perform set_config('tg.n', (n1 + 2)::text, false);
  perform set_config('tg.lotm', r->'lots'->0->>'lot_no', false);
end $$;
select pg_temp.expect_error($q$select public.ops_wh_lot_create('{"lots":[{"item":"ST003","qty":"5","location":"MARS"}]}')$q$, '请选仓位');
select pg_temp.expect_error($q$select public.ops_wh_lot_create('{"lots":[{"item":"ST003","qty":"0","location":"HQ"}]}')$q$, '请填数量');
select pg_temp.expect_error($q$select public.ops_wh_lot_create('{"lots":[{"item":"ST003","qty":"1","location":"HQ","boxes":0}]}')$q$, '箱数');
select pg_temp.expect_error($q$select public.ops_wh_lot_create('{"lots":[{"item":"ST003","qty":"1","location":"HQ","outlet":"MOON"}]}')$q$, '没有这间分店');
select pg_temp.expect_error(format($q$select public.ops_wh_lot_create('{"lots":[{"move_id":%s}]}')$q$, current_setting('tg.mvx')), '已经取消');
select pg_temp.expect_error($q$select public.ops_wh_lot_create('{"lots":[]}')$q$, '请先勾选');
select pg_temp.expect_error($q$select public.ops_wh_lot_create('{"lots":[{"move_id":"abc"}]}')$q$, '找不到这笔进货');
select pg_temp.expect_error($q$select public.ops_wh_lot_create('{"lots":[{"item":"ST003","qty":"abc","location":"HQ"}]}')$q$, '请填数量');
-- 一行错整批不存（流水号也不跳）
select pg_temp.expect_error($q$select public.ops_wh_lot_create('{"lots":[{"item":"ST003","qty":"1","location":"HQ"},{"item":"NOPE","qty":"1","location":"HQ"}]}')$q$, '第 2 行');
do $$ declare r jsonb; begin
  r := public.ops_wh_lot_create('{"lots":[{"item":"ST004","qty":"1","location":"HQ"}]}');
  assert split_part(r->'lots'->0->>'lot_no', '-', 2)::int = current_setting('tg.n')::int + 1, 'no gap after failed batch: ' || r::text;
end $$;
-- 采购（订货可编辑）也能建
select pg_temp.as_user('buyer3@example.com');
do $$ begin
  assert jsonb_array_length(public.ops_wh_lot_create('{"lots":[{"item":"ST004","qty":"2","location":"HQ"}]}')->'lots') = 1, 'buyer can create';
end $$;
-- 批次页：看不到厂家的门市没有 DO 号 / 厂家 / PO 号；看得到货架（ST003 在 bin_test 上过 HQ 的货架）
select pg_temp.as_user('hqsales@example.com');
do $$ declare g jsonb; begin
  g := public.ops_wh_lot_get(lower(current_setting('tg.lota')));
  assert g->>'lot_no' = current_setting('tg.lota') and g->>'item_code' = 'TGA' and (g->>'boxes')::int = 4, 'sales gets lot';
  assert g->>'do_no' is null and g->>'supplier_name' is null and g->>'po_no' is null, 'sales: no supplier / DO / PO: ' || g::text;
  assert not (g->>'can_print')::boolean and g->>'move_status' = 'pending', 'sales cannot print';
  assert g->>'bin' is null and jsonb_array_length(g->'bins') = 0 and (g->>'expected')::numeric = 6, 'TGA not shelved: ' || g::text;
  g := public.ops_wh_lot_get(current_setting('tg.lotm'));
  assert jsonb_array_length(g->'bins') > 0 and g->>'bin' = g->'bins'->0->>'code' and g->>'move_status' is null, 'suggested bin: ' || g::text;
  g := public.ops_wh_lot_moves(jsonb_build_object('do_id', current_setting('tg.do')));
  assert jsonb_array_length(g->'rows') = 2 and not (g->>'can_create')::boolean, 'lot moves for DO (no cancelled): ' || g::text;
  assert not exists (select 1 from jsonb_array_elements(g->'rows') x where x->>'do_no' is not null or x->>'supplier_name' is not null), 'sales: moves without DO no';
  g := public.ops_wh_lot_moves('{"q":"tg-do"}');
  assert jsonb_array_length(g->'rows') = 0, 'sales cannot search by DO no';
end $$;
select pg_temp.expect_error($q$select public.ops_wh_lot_get('L000000-9999')$q$, '找不到批次');
select pg_temp.as_user('picker@example.com');
do $$ declare g jsonb; begin
  g := public.ops_wh_lot_moves('{"q":"tg-do-1"}');
  assert jsonb_array_length(g->'rows') = 2 and g->'rows'->0->>'do_no' = 'TG-DO-1' and g->'rows'->0->>'lot_no' is not null, 'picker: ' || g::text;
  g := public.ops_wh_lot_moves('{"days":14}');
  assert (select count(*) from jsonb_array_elements(g->'rows') x where x->>'item_code' in ('TGA', 'TGB')) = 2, 'recent 14 days';
end $$;
select pg_temp.as_user('jbwh@example.com');
select pg_temp.expect_error(format($q$select public.ops_wh_lot_get(%L)$q$, current_setting('tg.lota')), '分店');
select pg_temp.expect_error(format($q$select public.ops_wh_lot_moves('{"do_id":%s}')$q$, current_setting('tg.do')), '分店');

-- 5. 打印纪录
select pg_temp.as_user('picker@example.com');
do $$ declare r jsonb; bid bigint; begin
  select (x->>'id')::bigint into bid from jsonb_array_elements(public.ops_wh_bins('{"location":"HQ"}')->'bins') x where x->>'code' = 'A-R1-1';
  r := public.ops_wh_label_log(jsonb_build_object('rows', jsonb_build_array(
         jsonb_build_object('kind', 'lot', 'lot_no', current_setting('tg.lota'), 'copies', 4, 'size', '100x60'),
         jsonb_build_object('kind', 'item', 'item_code', 'ST003', 'copies', 2, 'size', 'a4-24'),
         jsonb_build_object('kind', 'bin', 'bin_id', bid, 'copies', 1, 'size', 'roll'))));
  assert (r->>'logged')::int = 3, 'logged 3';
  r := public.ops_wh_label_prints(jsonb_build_object('q', current_setting('tg.lota')));
  assert (r->>'total')::int = 1 and r->'rows'->0->>'item_code' = 'TGA' and (r->'rows'->0->>'lot_boxes')::int = 4
     and r->'rows'->0->>'by_name' = '仓库阿强', 'search by lot: ' || r::text;
  r := public.ops_wh_label_prints('{"kind":"bin"}');
  assert (r->>'total')::int = 1 and r->'rows'->0->>'bin_code' = 'A-R1-1', 'bin print';
  r := public.ops_wh_label_prints(jsonb_build_object('from', to_char((now() at time zone 'Asia/Kuala_Lumpur')::date, 'YYYY-MM-DD'), 'q', '仓库阿强'));
  assert (r->>'total')::int = 3 and (r->>'can_lot')::boolean, 'today by name';
  r := public.ops_wh_label_prints(jsonb_build_object('to', to_char((now() at time zone 'Asia/Kuala_Lumpur')::date - 1, 'YYYY-MM-DD')));
  assert (r->>'total')::int = 0, 'date range';
  r := public.ops_wh_lot_get(current_setting('tg.lota'));
  assert (r->>'printed')::int = 4 and jsonb_array_length(r->'prints') = 1, 'lot print history';
end $$;
select pg_temp.expect_error($q$select public.ops_wh_label_log('{"rows":[{"kind":"bin","bin_id":999999}]}')$q$, '找不到货架');
select pg_temp.expect_error($q$select public.ops_wh_label_log('{"rows":[{"kind":"bin","bin_id":"x1"}]}')$q$, '找不到货架');
select pg_temp.expect_error($q$select public.ops_wh_label_log('{"rows":[{"kind":"lot","lot_no":"L000000-0001"}]}')$q$, '找不到批次');
select pg_temp.expect_error($q$select public.ops_wh_label_prints('{"from":"昨天"}')$q$, '日期');
select pg_temp.as_user('hqsales@example.com');
select pg_temp.expect_error(format($q$select public.ops_wh_label_log('{"rows":[{"kind":"lot","lot_no":"%s"}]}')$q$, current_setting('tg.lota')), '可编辑');
do $$ begin
  assert (public.ops_wh_label_log('{"rows":[{"kind":"item","item_code":"ST004","copies":1}]}')->>'logged')::int = 1, 'sales logs item labels';
end $$;
select pg_temp.as_user('jbwh@example.com');
do $$ begin
  assert (public.ops_wh_label_prints('{}')->>'total')::int = 0, 'JB sees no HQ prints';
end $$;
select pg_temp.expect_error($q$select public.ops_wh_label_prints('{"company":"HOMEWORKSSB"}')$q$, '分店');

-- 6. 内部函数与匿名都叫不到
select pg_temp.expect_error($q$select ops.wh_lot_next()$q$, 'permission');
select pg_temp.expect_error($q$select ops.wh_item_tags('HOMEWORKSSB', array['ST003'])$q$, 'permission');
reset role;
set role anon;
select pg_temp.expect_error($q$select public.ops_wh_tags('{}')$q$, 'permission');
select pg_temp.expect_error($q$select public.ops_wh_lot_get('L000000-0001')$q$, 'permission');
reset role;

-- 会写纪录的函数不能是 stable（PostgREST 用唯读交易跑 stable 函数）
do $$ begin
  assert (select provolatile from pg_proc where proname = 'ops_wh_stock_export' and pronamespace = 'public'::regnamespace) = 'v', 'export volatile';
  assert (select bool_and(provolatile = 'v') from pg_proc where pronamespace = 'public'::regnamespace and proname in
          ('ops_wh_tag_save', 'ops_wh_item_tag_set', 'ops_wh_item_photo_set', 'ops_wh_lot_create', 'ops_wh_label_log')), 'writers volatile';
end $$;

-- 测完：两笔进货取消（不留还没输入 AutoCount 的进货给后面的测试）
update ops.wh_move set status = 'cancelled' where do_id = current_setting('tg.do')::bigint and status = 'pending';
select 'tag_test ok' as result;
