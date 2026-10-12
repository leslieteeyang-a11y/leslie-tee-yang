-- 厂家 DO / 分店分配 / 在路上 / 厂家问题测试（接在 profile_test.sql 之后跑，2026-10-12）。
-- 资料：厂家 4000-F001（FOSHAN FACTORY）
--   PO-F1（2026-08-01）：101 BS100 HQ 10、102 BS100 PRE (JB) 6、103 TP200 SRGADING 20、104 WC300 PRE (JB) 4
--   PO-F2（2026-09-01）：105 BS100 HQ 5、106 MR400 DISPLAY 3（= 总部）、107 TP200 JB RESER 2（已取消）、109 SK500 HQ 10
--   HOMEWORKSSOUTHERN PO-JF1：201 BS100 8（整本 = JB）；另一个厂家 4000-F002 PO-G1。
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
-- 模拟前端上传厂家 DO 档案（Storage 的 insert 由 policy 把关，这里直接写 objects 表）
create or replace function pg_temp.upload(p_name text) returns text language plpgsql security definer as $$
begin
  insert into storage.objects (bucket_id, name) values ('ops-po', p_name);
  return p_name;
end $$;
-- 从型号清单 / 问题清单里挑一笔
create or replace function pg_temp.item(p jsonb, p_code text) returns jsonb language sql as $$
  select x from jsonb_array_elements(p) x where x ->> 'item_code' = p_code limit 1
$$;
create or replace function pg_temp.iss(p jsonb, p_kind text, p_code text) returns jsonb language sql as $$
  select x from jsonb_array_elements(p) x where x ->> 'kind' = p_kind and x ->> 'item_code' is not distinct from p_code limit 1
$$;
-- 没有价格栏位
create or replace function pg_temp.no_price(p jsonb) returns boolean language sql as $$
  select p::text !~* '(price|amt|amount|cost)'
$$;
grant execute on all functions in schema pg_temp to authenticated, anon;

insert into bi.v_supplier_param values ('HOMEWORKSSB', '4000-F001', 'FOSHAN FACTORY', true, 60),
  ('HOMEWORKSSB', '4000-F002', 'OTHER FACTORY', true, 60), ('HOMEWORKSSOUTHERN', '4000-F001', 'FOSHAN FACTORY', true, 60);
insert into bi.dim_item values ('HOMEWORKSSB', 'BS100', 'BASIN 100', 'SANITARY', 'HEMOS', 'PCS'),
  ('HOMEWORKSSB', 'TP200', 'TAP 200', 'TAP', 'HEMOS', 'PCS'), ('HOMEWORKSSB', 'WC300', 'WC 300', 'SANITARY', 'HEMOS', 'SETS'),
  ('HOMEWORKSSB', 'MR400', 'MIRROR 400', 'MIRROR', 'HEMOS', 'PCS'), ('HOMEWORKSSB', 'SK500', 'SINK 500', 'SANITARY', 'HEMOS', 'PCS');
insert into bi.fact_po_line (company, dtl_key, po_no, po_date, creditor_code, creditor_name, item_code, description,
                             location, uom, qty, transferred_qty, unit_price, est_delivery, cancelled) values
  ('HOMEWORKSSB', 101, 'PO-F1', '2026-08-01', '4000-F001', 'FOSHAN', 'BS100', 'BASIN 100', 'HQ', 'PCS', 10, 0, 50, null, false),
  ('HOMEWORKSSB', 102, 'PO-F1', '2026-08-01', '4000-F001', 'FOSHAN', 'BS100', 'BASIN 100', 'PRE (JB)', 'PCS', 6, 0, 50, null, false),
  ('HOMEWORKSSB', 103, 'PO-F1', '2026-08-01', '4000-F001', 'FOSHAN', 'TP200', 'TAP 200', 'SRGADING', 'PCS', 20, 0, 30, null, false),
  ('HOMEWORKSSB', 104, 'PO-F1', '2026-08-01', '4000-F001', 'FOSHAN', 'WC300', 'WC 300', 'PRE (JB)', 'SETS', 4, 0, 200, null, false),
  ('HOMEWORKSSB', 105, 'PO-F2', '2026-09-01', '4000-F001', 'FOSHAN', 'BS100', 'BASIN 100', 'HQ', 'PCS', 5, 0, 50, null, false),
  ('HOMEWORKSSB', 106, 'PO-F2', '2026-09-01', '4000-F001', 'FOSHAN', 'MR400', 'MIRROR 400', 'DISPLAY', 'PCS', 3, 0, 80, null, false),
  ('HOMEWORKSSB', 107, 'PO-F2', '2026-09-01', '4000-F001', 'FOSHAN', 'TP200', 'TAP 200', 'JB RESER', 'PCS', 2, 0, 30, null, true),
  ('HOMEWORKSSB', 109, 'PO-F2', '2026-09-01', '4000-F001', 'FOSHAN', 'SK500', 'SINK 500', 'HQ', 'PCS', 10, 0, 40, null, false),
  ('HOMEWORKSSB', 301, 'PO-G1', '2026-09-05', '4000-F002', 'OTHER', 'TP200', 'TAP 200', 'HQ', 'PCS', 5, 0, 30, null, false),
  ('HOMEWORKSSOUTHERN', 201, 'PO-JF1', '2026-09-10', '4000-F001', 'FOSHAN', 'BS100', 'BASIN 100', 'HQ', 'PCS', 8, 0, 50, null, false);

-- 0. 分店对照（ops.* 只给内部用，这里用超级用户直接测）
do $$ begin
  assert ops.outlet_of('HOMEWORKSSB', 'HQ') = 'HQ' and ops.outlet_of('HOMEWORKSSB', 'SRGADING') = 'HQ', 'HQ';
  assert ops.outlet_of('HOMEWORKSSB', 'PRE (JB)') = 'JB' and ops.outlet_of('HOMEWORKSSB', ' jb reser ') = 'JB'
     and ops.outlet_of('HOMEWORKSSB', 'JB') = 'JB', 'JB';
  assert ops.outlet_of('HOMEWORKSSB', 'PRE (BATU)') = 'BATU' and ops.outlet_of('HOMEWORKSSB', 'BATU') = 'BATU', 'BATU';
  assert ops.outlet_of('HOMEWORKSSB', 'PRE (PUCHONG)') = 'PUCHONG' and ops.outlet_of('HOMEWORKSSB', 'PUCHONG') = 'PUCHONG', 'PUCHONG';
  assert ops.outlet_of('HOMEWORKSSB', 'DISPLAY') = 'HQ' and ops.outlet_of('HOMEWORKSSB', 'MYNET') = 'HQ'
     and ops.outlet_of('HOMEWORKSSB', null) = 'HQ', 'other HQ-book locations = HQ';
  assert ops.outlet_of('HOMEWORKSSOUTHERN', 'HQ') = 'JB' and ops.outlet_of('HOMEWORKSSOUTHERN', 'PRE (BATU)') = 'JB',
    'JB company = JB';
  assert exists (select 1 from storage.buckets where id = 'ops-po' and not public), 'private bucket';
  assert (select count(*) from pg_policies where schemaname = 'storage' and policyname in ('ops-po read', 'ops-po insert')) = 2,
    'storage policies';
end $$;

select pg_temp.at('2026-10-20 10:00:00+08');
set role authenticated;
select pg_temp.expect_error('select * from ops.outlet', 'permission denied');
select pg_temp.expect_error('select * from ops.supplier_do', 'permission denied');
select pg_temp.as_user('boss@example.com');
select public.ops_staff_save('{"email":"pomgr@example.com","name":"采购主管","department":"purchasing","branch":"HOMEWORKSSB","role":"manager"}');
select public.ops_staff_save('{"email":"jbbuyer@example.com","name":"JB采购","department":"purchasing","branch":"HOMEWORKSSOUTHERN"}');

-- 1. 选厂家、选 PO、型号清单（各分店还没出的数量）
select pg_temp.as_user('buyer@example.com');
do $$ declare s jsonb; f jsonb; p jsonb; c jsonb; b jsonb; begin
  s := public.ops_po_do_suppliers();
  f := (select x from jsonb_array_elements(s) x where x ->> 'creditor_code' = '4000-F001');
  assert (f ->> 'po_count')::int = 2 and f ->> 'supplier_name' = 'FOSHAN FACTORY' and f ->> 'company' = 'HOMEWORKSSB',
    'supplier: ' || coalesce(f::text, s::text);
  p := public.ops_po_do_pos('', '4000-F001');
  assert jsonb_array_length(p) = 2 and p -> 0 ->> 'po_no' = 'PO-F1' and p -> 0 -> 'outlets' = '["HQ","JB"]'::jsonb
     and (p -> 0 ->> 'open_qty')::numeric = 40 and (p -> 1 ->> 'open_qty')::numeric = 18, 'pos: ' || p::text;
  c := public.ops_po_do_candidates('', '4000-F001', array['PO-F1', 'PO-F2']);
  assert jsonb_array_length(c -> 'outlets') = 4 and jsonb_array_length(c -> 'items') = 5, 'candidates: ' || c::text;
  assert (select string_agg(x ->> 'item_code', ',') from jsonb_array_elements(c -> 'items') x) = 'BS100,TP200,WC300,MR400,SK500',
    'PO line order';
  b := pg_temp.item(c -> 'items', 'BS100');
  assert (b ->> 'ordered')::numeric = 21 and (b ->> 'remaining')::numeric = 21 and b -> 'single_outlet' = 'null'::jsonb
     and (b -> 'by_outlet' -> 'HQ' ->> 'open')::numeric = 15 and (b -> 'by_outlet' -> 'JB' ->> 'open')::numeric = 6
     and b -> 'po_nos' = '["PO-F1","PO-F2"]'::jsonb, 'BS100: ' || b::text;
  assert (pg_temp.item(c -> 'items', 'TP200') ->> 'ordered')::numeric = 20, 'cancelled line excluded';
  assert pg_temp.item(c -> 'items', 'TP200') ->> 'single_outlet' = 'HQ'
     and pg_temp.item(c -> 'items', 'WC300') ->> 'single_outlet' = 'JB'
     and pg_temp.item(c -> 'items', 'MR400') ->> 'single_outlet' = 'HQ', 'single outlet prefill';
  assert pg_temp.no_price(s) and pg_temp.no_price(p) and pg_temp.no_price(c), 'no prices';
end $$;
select pg_temp.expect_error($q$select public.ops_po_do_suppliers('HOMEWORKSSOUTHERN')$q$, '请选择你分店的公司');

-- 2. 存草稿：检查
select pg_temp.upload('HOMEWORKSSB/2026-10/fs0901.xlsx');
select pg_temp.expect_error($q$select public.ops_po_do_save('{"po_nos":["PO-F1"]}')$q$, '请先选厂家');
select pg_temp.expect_error($q$select public.ops_po_do_save('{"creditor_code":"NOPE"}')$q$, '找不到这个厂家的 PO');
select pg_temp.expect_error($q$select public.ops_po_do_save('{"creditor_code":"4000-F001","po_nos":["PO-G1"]}')$q$,
  'PO PO-G1 不是这个厂家的单');
select pg_temp.expect_error($q$select public.ops_po_do_save('{"creditor_code":"4000-F001","po_nos":["PO-F1"],
  "items":[{"item_code":"ZZZ","shipped":1}]}')$q$, '型号 ZZZ 不在所选的 PO 里');
select pg_temp.expect_error($q$select public.ops_po_do_save('{"creditor_code":"4000-F001","po_nos":["PO-F1"],
  "items":[{"item_code":"MR400","shipped":1}]}')$q$, '型号 MR400 不在所选的 PO 里');
select pg_temp.expect_error($q$select public.ops_po_do_save('{"creditor_code":"4000-F001","po_nos":["PO-F1"],
  "items":[{"item_code":"BS100","shipped":1,"alloc":{"MARS":1}}]}')$q$, '没有这个分店：MARS');
select pg_temp.expect_error($q$select public.ops_po_do_save('{"creditor_code":"4000-F001","po_nos":["PO-F1"],
  "items":[{"item_code":"BS100","shipped":-1}]}')$q$, '出货数量不能是负数');
select pg_temp.expect_error($q$select public.ops_po_do_save('{"creditor_code":"4000-F001","po_nos":["PO-F1"],
  "items":[{"item_code":"BS100","shipped":"abc"}]}')$q$, '出货数量不是数字');
select pg_temp.expect_error($q$select public.ops_po_do_save('{"creditor_code":"4000-F001","po_nos":["PO-F1"],
  "items":[{"item_code":"BS100","shipped":1},{"item_code":"bs100","shipped":2}]}')$q$, '型号 BS100 重复了');
select pg_temp.expect_error($q$select public.ops_po_do_save('{"creditor_code":"4000-F001","po_nos":["PO-F1"],
  "files":[{"path":"HOMEWORKSSB/2026-10/never.xlsx","name":"x"}]}')$q$, '附件没有上传成功');
select pg_temp.expect_error($q$select public.ops_po_do_save('{"creditor_code":"4000-F001","po_nos":["PO-F1"],
  "files":[{"path":"HOMEWORKSSOUTHERN/2026-10/fs0901.xlsx","name":"x"}]}')$q$, '附件没有上传成功');
do $$ begin assert jsonb_array_length(public.ops_po_do_list('{"status":"all"}')) = 0, 'nothing saved by failures'; end $$;

-- 3. DO1（只有 PO-F1）：Excel 对上 3 个型号 + 1 行发错型号 + 1 行空白；同一个 client_key 重存不会多一张
create temp table t_do (k text primary key, id bigint);
grant all on t_do to authenticated;
do $$ declare r jsonb; r2 jsonb; payload jsonb; begin
  payload := '{"client_key":"k-do1","creditor_code":"4000-F001","po_nos":["PO-F1"],"do_no":"FS-0901","do_date":"2026-10-10",
    "eta":"2026-11-15","files":[{"path":"HOMEWORKSSB/2026-10/fs0901.xlsx","name":"FS-0901.xlsx","size":12345,"type":"x"}],
    "items":[{"item_code":"bs100","shipped":12,"alloc":{"HQ":8,"JB":3},"src_code":"BS-100","src_row":2},
             {"item_code":"TP200","shipped":"22","alloc":{"HQ":20,"BATU":2,"JB":0}},
             {"item_code":"WC300","shipped":0,"alloc":{}},
             {"src_code":"XX-9","src_desc":"WRONG BASIN","shipped":2,"expected_code":"wc300","note":"订 WC300 收到 XX-9"},
             {"src_code":"","src_desc":""}]}';
  r := public.ops_po_do_save(payload);
  insert into t_do values ('do1', (r ->> 'id')::bigint);
  assert r ->> 'status' = 'draft' and jsonb_array_length(r -> 'items') = 4 and (r ->> 'can_edit')::boolean, 'draft: ' || r::text;
  assert r -> 'items' -> 0 ->> 'item_code' = 'BS100' and r -> 'items' -> 0 ->> 'description' = 'BASIN 100'
     and r -> 'items' -> 0 -> 'alloc' = '{"HQ":8,"JB":3}'::jsonb and (r -> 'items' -> 0 ->> 'src_row')::int = 2, 'normalized';
  assert r -> 'items' -> 1 -> 'alloc' = '{"HQ":20,"BATU":2}'::jsonb and (r -> 'items' -> 1 ->> 'shipped')::numeric = 22, 'zero alloc dropped';
  assert r -> 'items' -> 3 -> 'item_code' = 'null'::jsonb and r -> 'items' -> 3 ->> 'expected_code' = 'WC300', 'unmatched row';
  assert r ->> 'supplier_name' = 'FOSHAN FACTORY' and jsonb_array_length(r -> 'files') = 1 and r -> 'files' -> 0 ->> 'name' = 'FS-0901.xlsx';
  assert jsonb_array_length(r -> 'candidates') = 3 and pg_temp.no_price(r), 'candidates of PO-F1, no prices';
  r2 := public.ops_po_do_save(payload);
  assert r2 ->> 'id' = r ->> 'id' and jsonb_array_length(r2 -> 'items') = 4, 'idempotent re-save';
  assert jsonb_array_length(public.ops_po_do_list('{}')) = 1, 'one DO';
end $$;
-- 同一个厂家的 DO 号不能重复登记
select pg_temp.expect_error($q$select public.ops_po_do_save('{"creditor_code":"4000-F001","po_nos":["PO-F1"],"do_no":"fs-0901"}')$q$,
  '已经登记过了');
-- 分配合计不等于出货 → 不能确认
select pg_temp.expect_error($q$select public.ops_po_do_confirm((select id from t_do where k = 'do1'))$q$,
  '型号 BS100 出货 12，分到各分店的合计是 11');
do $$ declare r jsonb; it jsonb; begin
  r := public.ops_po_do_get((select id from t_do where k = 'do1'));
  -- 把 BS100 改成 HQ 8 + JB 4 再存（整份 items 覆盖）
  it := jsonb_set(r -> 'items', '{0,alloc}', '{"HQ":8,"JB":4}');
  perform public.ops_po_do_save(jsonb_build_object('id', r -> 'id', 'items', it));
  r := public.ops_po_do_confirm((r ->> 'id')::bigint);
  assert r ->> 'status' = 'confirmed' and r ->> 'confirmed_by_name' = 'buyer' and not (r ->> 'can_edit')::boolean, 'confirmed: ' || r::text;
  -- 记到 PO 行：BS100 HQ 8 → 101、JB 4 → 102；TP200 HQ 20 → 103；Batu 没订 → 2 件多发（没有 PO 行）
  assert jsonb_array_length(r -> 'applied') = 4, 'applied: ' || (r -> 'applied')::text;
  assert exists (select 1 from jsonb_array_elements(r -> 'applied') a where a ->> 'item_code' = 'BS100' and a ->> 'outlet' = 'JB'
                 and (a ->> 'dtl_key')::bigint = 102 and (a ->> 'qty')::numeric = 4), 'JB line';
  assert exists (select 1 from jsonb_array_elements(r -> 'applied') a where a ->> 'outlet' = 'BATU' and a -> 'dtl_key' = 'null'::jsonb
                 and (a ->> 'qty')::numeric = 2), 'excess to Batu';
  -- 问题：BS100 少 4、WC300 少 4（整个没出）、TP200 多 2、发错型号 XX-9 2 件
  assert jsonb_array_length(r -> 'issues') = 4, 'issues: ' || (r -> 'issues')::text;
  assert (pg_temp.iss(r -> 'issues', 'short', 'BS100') ->> 'qty')::numeric = 4
     and (pg_temp.iss(r -> 'issues', 'short', 'BS100') ->> 'ordered')::numeric = 16
     and (pg_temp.iss(r -> 'issues', 'short', 'BS100') ->> 'received')::numeric = 12
     and pg_temp.iss(r -> 'issues', 'short', 'BS100') ->> 'decision' = 'pending', 'BS100 short';
  assert (pg_temp.iss(r -> 'issues', 'short', 'WC300') ->> 'qty')::numeric = 4, 'WC300 short';
  assert (pg_temp.iss(r -> 'issues', 'over', 'TP200') ->> 'qty')::numeric = 2
     and pg_temp.iss(r -> 'issues', 'over', 'TP200') -> 'decision' = 'null'::jsonb, 'TP200 over';
  assert pg_temp.iss(r -> 'issues', 'wrong', 'WC300') ->> 'received_code' = 'XX-9'
     and (pg_temp.iss(r -> 'issues', 'wrong', 'WC300') ->> 'qty')::numeric = 2
     and pg_temp.iss(r -> 'issues', 'wrong', 'WC300') ->> 'note' = '订 WC300 收到 XX-9'
     and pg_temp.iss(r -> 'issues', 'wrong', 'WC300') ->> 'do_no' = 'FS-0901', 'wrong model';
end $$;
select pg_temp.expect_error($q$select public.ops_po_do_confirm((select id from t_do where k = 'do1'))$q$, '已经确认过了');
select pg_temp.expect_error($q$select public.ops_po_do_save(jsonb_build_object('id', (select id from t_do where k = 'do1'),
  'items', '[]'::jsonb))$q$, '请先「退回草稿」');
-- 确认后：新的 DO 看到的「还可以出」已扣掉在路上；表头（ETA、货柜）照样可以改
do $$ declare c jsonb; b jsonb; s jsonb; r jsonb; begin
  c := public.ops_po_do_candidates('', '4000-F001', array['PO-F1', 'PO-F2']);
  b := pg_temp.item(c -> 'items', 'BS100');
  assert (b ->> 'open_qty')::numeric = 21 and (b ->> 'in_transit')::numeric = 12 and (b ->> 'remaining')::numeric = 9
     and (b -> 'by_outlet' -> 'HQ' ->> 'remaining')::numeric = 7 and (b -> 'by_outlet' -> 'JB' ->> 'remaining')::numeric = 2
     and (b ->> 'owed')::numeric = 4, 'BS100 after DO1: ' || b::text;
  assert (pg_temp.item(c -> 'items', 'TP200') ->> 'remaining')::numeric = 0, 'TP200 all on the way';
  s := public.ops_shipment_save('{"company":"HOMEWORKSSB","name":"FS-CTN-1","eta":"2026-11-01"}');
  r := public.ops_po_do_save(jsonb_build_object('id', (select id from t_do where k = 'do1'), 'shipment_id', s -> 'id',
                                                'eta', '2026-11-16', 'remark', '第一柜'));
  assert r ->> 'eta' = '2026-11-16' and r ->> 'eta_effective' = '2026-11-01' and r ->> 'eta_source' = 'shipment'
     and r ->> 'shipment_name' = 'FS-CTN-1' and r ->> 'status' = 'confirmed', 'header edit: ' || r::text;
  -- 未到货 PO 清单显示在路上的 DO
  assert public.ops_po_get('HOMEWORKSSB', 'PO-F1') -> 'dos' = jsonb_build_array(jsonb_build_object(
           'id', (select id from t_do where k = 'do1'), 'do_no', 'FS-0901', 'eta', '2026-11-01')), 'po dos';
  assert public.ops_po_get('HOMEWORKSSB', 'PO-F2') -> 'dos' = '[]'::jsonb, 'PO-F2 no DO yet';
  assert jsonb_array_length(public.ops_po_do_list('{"q":"XX-9"}')) = 1 and jsonb_array_length(public.ops_po_do_list('{"q":"PO-F2"}')) = 0,
    'list search';
end $$;

-- 4. 在路上：总部看全部分店，JB 的人只看 JB；不能标到货的人 can_arrive = false
do $$ declare t jsonb; begin
  t := public.ops_po_transit();
  assert jsonb_array_length(t -> 'rows') = 4 and jsonb_array_length(t -> 'outlets') = 4, 'buyer transit: ' || t::text;
  assert (select string_agg((x ->> 'outlet') || ':' || (x ->> 'item_code') || ':' || (x ->> 'qty'), ',') from jsonb_array_elements(t -> 'rows') x)
         = 'HQ:BS100:8,HQ:TP200:20,BATU:TP200:2,JB:BS100:4', 'rows by outlet';
  assert t -> 'rows' -> 0 ->> 'eta' = '2026-11-01' and t -> 'rows' -> 0 ->> 'supplier_name' = 'FOSHAN FACTORY'
     and t -> 'rows' -> 0 ->> 'do_no' = 'FS-0901' and t -> 'rows' -> 0 ->> 'uom' = 'PCS'
     and t -> 'rows' -> 0 -> 'po_nos' = '["PO-F1"]'::jsonb and (t -> 'rows' -> 0 ->> 'can_arrive')::boolean, 'row fields';
  assert pg_temp.no_price(t), 'transit no prices';
  assert jsonb_array_length(public.ops_po_transit('{"outlet":"BATU"}') -> 'rows') = 1, 'outlet filter';
  assert jsonb_array_length(public.ops_po_transit('{"q":"tap"}') -> 'rows') = 2, 'search';
end $$;
select pg_temp.as_user('jbsales@example.com');
do $$ declare t jsonb := public.ops_po_transit(); begin
  assert t -> 'outlets' = '[{"code":"JB","name":"JB","short_name":"JB"}]'::jsonb, 'JB outlets: ' || (t -> 'outlets')::text;
  assert jsonb_array_length(t -> 'rows') = 1 and t -> 'rows' -> 0 ->> 'outlet' = 'JB' and (t -> 'rows' -> 0 ->> 'qty')::numeric = 4
     and t -> 'rows' -> 0 ->> 'eta' = '2026-11-01' and not (t -> 'rows' -> 0 ->> 'can_arrive')::boolean, 'JB sees only JB: ' || t::text;
  assert jsonb_array_length(public.ops_po_transit('{"outlet":"HQ"}') -> 'rows') = 0, 'JB cannot ask for HQ';
end $$;
select pg_temp.expect_error($q$select public.ops_po_do_list('{}')$q$, '编辑权限');
select pg_temp.expect_error($q$select public.ops_po_issues('{}')$q$, '编辑权限');
select pg_temp.expect_error($q$select public.ops_po_do_arrive((select id from t_do where k = 'do1'))$q$, '才能标记到货');
select pg_temp.as_user('hqsales@example.com');
do $$ declare t jsonb := public.ops_po_transit(); begin
  assert jsonb_array_length(t -> 'rows') = 4 and not (t -> 'rows' -> 0 ->> 'can_arrive')::boolean, 'HQ sales sees all, cannot arrive';
end $$;
select pg_temp.expect_error($q$select public.ops_po_do_candidates('', '4000-F001', array['PO-F1'])$q$, '编辑权限');
select pg_temp.as_user('hr@example.com');
select pg_temp.expect_error($q$select public.ops_po_transit()$q$, '订货与 ETA');

-- 5. DO2（PO-F1 + PO-F2，还没开 GRN）：WC300 先决定「厂家会补」→ DO2 出了就自动补上
select pg_temp.as_user('buyer@example.com');
select pg_temp.expect_error($q$select public.ops_po_issue_set(array[(select (x ->> 'id')::bigint from jsonb_array_elements(
  public.ops_po_issues('{"kind":"over"}')) x)], 'await')$q$, '只有「少发」');
select public.ops_po_issue_set(array[(select (x ->> 'id')::bigint from jsonb_array_elements(public.ops_po_issues('{}')) x
                                      where x ->> 'kind' = 'short' and x ->> 'item_code' = 'WC300')], 'await', '厂家说下一柜补');
do $$ declare r jsonb; c jsonb; w jsonb; t jsonb; begin
  r := public.ops_po_do_save('{"creditor_code":"4000-F001","po_nos":["PO-F2","PO-F1"],"do_no":"FS-0902","eta":"2026-11-20",
    "items":[{"item_code":"BS100","shipped":9,"alloc":{"HQ":3,"JB":2,"PUCHONG":4}},
             {"item_code":"WC300","shipped":4,"alloc":{"JB":4}},
             {"item_code":"SK500","shipped":4,"alloc":{"HQ":4}}]}');
  insert into t_do values ('do2', (r ->> 'id')::bigint);
  assert r -> 'po_nos' = '["PO-F1","PO-F2"]'::jsonb, 'po sorted';
  r := public.ops_po_do_confirm((r ->> 'id')::bigint);
  -- BS100：HQ 3 → 101 剩的 2 + 105 的 1；JB 2 → 102；Puchong 没订 → 先记在同型号还有剩的 105（4）
  assert (select string_agg((a ->> 'outlet') || '@' || coalesce(a ->> 'dtl_key', '-') || '=' || (a ->> 'qty'), ',')
          from jsonb_array_elements(r -> 'applied') a where a ->> 'item_code' = 'BS100') = 'HQ@101=2,HQ@105=1,JB@102=2,PUCHONG@105=4',
    'FIFO + spill: ' || (r -> 'applied')::text;
  assert exists (select 1 from jsonb_array_elements(r -> 'applied') a where a ->> 'outlet' = 'PUCHONG' and a ->> 'line_outlet' = 'HQ'),
    'line outlet recorded';
  -- 问题：MR400 少 3、SK500 少 6；BS100 刚好
  assert jsonb_array_length(r -> 'issues') = 2 and (pg_temp.iss(r -> 'issues', 'short', 'MR400') ->> 'qty')::numeric = 3
     and (pg_temp.iss(r -> 'issues', 'short', 'SK500') ->> 'qty')::numeric = 6, 'DO2 issues: ' || (r -> 'issues')::text;
  w := (select x from jsonb_array_elements(public.ops_po_issues('{"status":"all"}')) x where x ->> 'kind' = 'short' and x ->> 'item_code' = 'WC300');
  assert w ->> 'status' = 'resolved' and (w ->> 'resolved_auto')::boolean and (w ->> 'resolved_qty')::numeric = 4
     and w -> 'resolutions' -> 0 ->> 'do_no' = 'FS-0902' and w ->> 'action_note' = '厂家说下一柜补', 'await short auto-resolved: ' || w::text;
  -- DO1 的 BS100 少发（PO-F1 少 4，还没决定）：DO2 在 PO-F1 出了 4（101 两件 + 102 两件）→ 一样自动补上（分批出货）
  w := pg_temp.iss(public.ops_po_issues('{"status":"all"}'), 'short', 'BS100');
  assert w ->> 'status' = 'resolved' and (w ->> 'resolved_auto')::boolean and (w ->> 'resolved_qty')::numeric = 4
     and w ->> 'decision' = 'pending' and w -> 'resolutions' -> 0 ->> 'do_no' = 'FS-0902', 'pending short filled by PO-F1 qty: ' || w::text;
  c := public.ops_po_do_candidates('', '4000-F001', array['PO-F1', 'PO-F2']);
  assert (pg_temp.item(c -> 'items', 'BS100') ->> 'remaining')::numeric = 0 and (pg_temp.item(c -> 'items', 'BS100') ->> 'in_transit')::numeric = 21
     and (pg_temp.item(c -> 'items', 'SK500') ->> 'remaining')::numeric = 6, 'before GRN: ' || c::text;
  t := public.ops_po_transit();
  assert jsonb_array_length(t -> 'rows') = 9, 'DO1 4 + DO2 5 rows: ' || t::text;
  assert public.ops_po_get('HOMEWORKSSB', 'PO-F2') -> 'dos' -> 0 ->> 'do_no' = 'FS-0902', 'PO-F2 dos';
end $$;
select pg_temp.as_user('jbsales@example.com');
do $$ declare t jsonb := public.ops_po_transit(); begin
  assert (select string_agg((x ->> 'do_no') || ':' || (x ->> 'item_code') || ':' || (x ->> 'qty'), ',') from jsonb_array_elements(t -> 'rows') x)
         = 'FS-0901:BS100:4,FS-0902:BS100:2,FS-0902:WC300:4', 'JB rows only (Puchong hidden): ' || t::text;
end $$;

-- 6. SK500 少发决定「取消（下次再订）」；然后 AutoCount 开了 GRN（101 收齐 10、109 收 4）
select pg_temp.as_user('buyer@example.com');
select public.ops_po_issue_set(array[(select (x ->> 'id')::bigint from jsonb_array_elements(public.ops_po_issues('{}')) x
                                      where x ->> 'kind' = 'short' and x ->> 'item_code' = 'SK500')], 'cancel');
reset role;
update bi.fact_po_line set transferred_qty = 10 where company = 'HOMEWORKSSB' and dtl_key = 101;
update bi.fact_po_line set transferred_qty = 4 where company = 'HOMEWORKSSB' and dtl_key = 109;
set role authenticated;
do $$ declare c jsonb; b jsonb; s jsonb; begin
  c := public.ops_po_do_candidates('', '4000-F001', array['PO-F1', 'PO-F2']);
  b := pg_temp.item(c -> 'items', 'BS100');
  -- GRN 之后：AutoCount 未到 21 → 11，在路上 21 → 11，还可以出照样 0（不会重复算）
  assert (b ->> 'open_qty')::numeric = 11 and (b ->> 'in_transit')::numeric = 11 and (b ->> 'remaining')::numeric = 0,
    'BS100 after GRN: ' || b::text;
  s := pg_temp.item(c -> 'items', 'SK500');
  assert (s ->> 'open_qty')::numeric = 6 and (s ->> 'in_transit')::numeric = 0 and (s ->> 'remaining')::numeric = 6,
    'SK500 after GRN: ' || s::text;
end $$;

-- 7. DO3（PO-F2，GRN 之后）：SK500 出 3 → 快照是 4；在路上要用第一次确认时的快照（0），不是这次的（4）
do $$ declare r jsonb; s jsonb; begin
  r := public.ops_po_do_save('{"creditor_code":"4000-F001","po_nos":["PO-F2"],"do_no":"FS-0903",
    "items":[{"item_code":"SK500","shipped":3,"alloc":{"HQ":3}}]}');
  insert into t_do values ('do3', (r ->> 'id')::bigint);
  r := public.ops_po_do_confirm((r ->> 'id')::bigint);
  -- MR400 还是少 3、SK500 少 3：之前已记过（MR400 未决定、SK500 已取消），不再重复记
  assert jsonb_array_length(r -> 'issues') = 0, 'no duplicate shorts: ' || (r -> 'issues')::text;
  s := pg_temp.item(public.ops_po_do_candidates('', '4000-F001', array['PO-F2']) -> 'items', 'SK500');
  assert (s ->> 'open_qty')::numeric = 6 and (s ->> 'in_transit')::numeric = 3 and (s ->> 'remaining')::numeric = 3,
    'first-confirm snapshot: ' || s::text;
end $$;
reset role;
do $$ declare t record; begin
  select * into t from ops.podo_lines('HOMEWORKSSB', '4000-F001', null, null) x where x.dtl_key = 109;
  assert t.open_qty = 6 and t.in_transit = 3 and t.remaining = 3, 'line 109: ' || t::text;
  assert (select transferred_at from ops.supplier_do_apply where dtl_key = 109 order by id desc limit 1) = 4, 'snapshot kept';
  assert (select array_agg(rcv_base order by id) from ops.supplier_do_apply where dtl_key = 109) = '{0,4}', 'pool base per DO';
end $$;
set role authenticated;

-- 8. 坏货（手动）、到货
select pg_temp.expect_error($q$select public.ops_po_issue_add(jsonb_build_object('do_id', (select id from t_do where k = 'do1'),
  'item_code', 'BS100', 'qty', 13))$q$, '不能多过这张 DO 的出货数量（12）');
select pg_temp.expect_error($q$select public.ops_po_issue_add(jsonb_build_object('do_id', (select id from t_do where k = 'do1'),
  'item_code', 'MR400', 'qty', 1))$q$, '这张 DO 没有型号 MR400');
select pg_temp.expect_error($q$select public.ops_po_issue_add(jsonb_build_object('do_id', (select id from t_do where k = 'do1'),
  'item_code', 'BS100', 'qty', 0))$q$, '请填数量');
select pg_temp.expect_error($q$select public.ops_po_issue_add(jsonb_build_object('do_id', (select id from t_do where k = 'do1'),
  'kind', 'over', 'item_code', 'BS100', 'qty', 1))$q$, '只能手动记');
do $$ declare i jsonb; begin
  i := public.ops_po_issue_add(jsonb_build_object('do_id', (select id from t_do where k = 'do1'), 'item_code', 'bs100', 'qty', 1,
                                                  'note', '破了一个'));
  assert i ->> 'kind' = 'damaged' and i ->> 'item_code' = 'BS100' and (i ->> 'received')::numeric = 12 and not (i ->> 'auto')::boolean
     and i ->> 'note' = '破了一个' and i ->> 'status' = 'open', 'damaged: ' || i::text;
end $$;
select pg_temp.as_user('picker@example.com');
select pg_temp.expect_error($q$select public.ops_po_issue_add(jsonb_build_object('do_id', (select id from t_do where k = 'do1'),
  'item_code', 'BS100', 'qty', 1))$q$, '编辑权限');
select pg_temp.expect_error($q$select public.ops_po_do_get((select id from t_do where k = 'do1'))$q$, '编辑权限');
do $$ declare r jsonb; t jsonb; begin
  t := public.ops_po_transit();
  assert (t -> 'rows' -> 0 ->> 'can_arrive')::boolean, 'warehouse can arrive';
  r := public.ops_po_do_arrive((select id from t_do where k = 'do1'), '少一箱');
  -- 只有仓库权限（打不开 DO）：只回状态，不回备注 / 附件 / PO
  assert r ->> 'status' = 'arrived' and (select array_agg(k order by k) from jsonb_object_keys(r) k) = '{arrived_at,id,status}',
    'arrived (warehouse gets status only): ' || r::text;
  t := public.ops_po_transit();
  assert not exists (select 1 from jsonb_array_elements(t -> 'rows') x where x ->> 'do_no' = 'FS-0901'), 'arrived leaves transit';
  assert jsonb_array_length(t -> 'rows') = 6, 'DO2 5 + DO3 1: ' || t::text;
end $$;
select pg_temp.expect_error($q$select public.ops_po_do_arrive((select id from t_do where k = 'do1'))$q$, '已经标记到货了');
select pg_temp.as_user('buyer@example.com');
do $$ declare b jsonb; r jsonb := public.ops_po_do_get((select id from t_do where k = 'do1')); begin
  assert r ->> 'arrived_by_name' = '仓库阿强' and r ->> 'arrive_note' = '少一箱', 'arrived: ' || r::text;
  -- 到货了但 AutoCount 还没开 GRN：PO 行照样算在路上（JB 的 102：DO1 4 + DO2 2），只扣掉记了坏货的 1 件（不会入库，厂家欠）
  b := pg_temp.item(public.ops_po_do_candidates('', '4000-F001', array['PO-F1']) -> 'items', 'BS100');
  assert (b -> 'by_outlet' -> 'JB' ->> 'in_transit')::numeric = 5 and (b -> 'by_outlet' -> 'JB' ->> 'remaining')::numeric = 1
     and (b ->> 'owed')::numeric = 1 and (b ->> 'flagged')::numeric = 1, 'arrived still counted until GRN: ' || b::text;
  assert public.ops_po_get('HOMEWORKSSB', 'PO-F1') -> 'dos' -> 0 ->> 'do_no' = 'FS-0902', 'arrived DO leaves PO list';
end $$;

-- 9. 退回草稿（订货可审批）：分配作废、还没决定的自动问题作废、已决定的留着、帮别张补的数量撤回
select pg_temp.expect_error($q$select public.ops_po_do_reopen((select id from t_do where k = 'do2'))$q$, '审批权限');
select pg_temp.as_user('pomgr@example.com');
select pg_temp.expect_error($q$select public.ops_po_do_reopen((select id from t_do where k = 'do1'))$q$, '已到货的 DO 不能退回草稿');
do $$ declare r jsonb; w jsonb; c jsonb; t jsonb; begin
  r := public.ops_po_do_reopen((select id from t_do where k = 'do2'), '分错店');
  assert r ->> 'status' = 'draft' and jsonb_array_length(r -> 'applied') = 0 and (r ->> 'can_edit')::boolean, 'reopened: ' || r::text;
  assert jsonb_array_length(r -> 'issues') = 1 and pg_temp.iss(r -> 'issues', 'short', 'SK500') ->> 'decision' = 'cancelled',
    'pending MR400 voided, cancelled SK500 kept: ' || (r -> 'issues')::text;
  assert (select count(*) from jsonb_array_elements(public.ops_po_issues('{"status":"void"}')) x) = 1, 'one void';
  w := (select x from jsonb_array_elements(public.ops_po_issues('{}')) x where x ->> 'kind' = 'short' and x ->> 'item_code' = 'WC300');
  assert w ->> 'status' = 'open' and w ->> 'decision' = 'await' and (w ->> 'resolved_qty')::numeric = 0
     and w -> 'resolutions' = '[]'::jsonb and not (w ->> 'resolved_auto')::boolean, 'resolution reverted: ' || coalesce(w::text, 'null');
  c := public.ops_po_do_candidates('', '4000-F001', array['PO-F1', 'PO-F2']);
  -- BS100：同型号一起算：DO1 出 12、坏 1、AutoCount 已收 10（不论开在哪一行）→ 在路上 1；未到 11 → 还可以出 10
  assert (pg_temp.item(c -> 'items', 'BS100') ->> 'remaining')::numeric = 10 and (pg_temp.item(c -> 'items', 'BS100') ->> 'in_transit')::numeric = 1
     and (pg_temp.item(c -> 'items', 'WC300') ->> 'remaining')::numeric = 4
     and (pg_temp.item(c -> 'items', 'SK500') ->> 'remaining')::numeric = 3, 'DO2 no longer in transit: ' || c::text;
  t := public.ops_po_transit();
  assert jsonb_array_length(t -> 'rows') = 1 and t -> 'rows' -> 0 ->> 'do_no' = 'FS-0903', 'only DO3 in transit';
  assert exists (select 1 from jsonb_array_elements(r -> 'history') h where h ->> 'action' = 'reopen' and h -> 'data' ->> 'reason' = '分错店'),
    'history';
end $$;
select pg_temp.as_user('buyer@example.com');
select pg_temp.expect_error($q$select public.ops_po_do_cancel((select id from t_do where k = 'do3'))$q$, '只有草稿可以取消');
do $$ declare r jsonb; begin
  r := public.ops_po_do_cancel((select id from t_do where k = 'do2'), '厂家重开 DO');
  assert r ->> 'status' = 'cancelled' and r ->> 'cancel_reason' = '厂家重开 DO' and r ->> 'cancelled_by_name' = 'buyer', 'cancelled';
  -- 退回草稿时留著的问题（SK500 已决定取消的少发）跟著作废：取消的 DO 不能还有「厂家欠」
  assert not exists (select 1 from jsonb_array_elements(public.ops_po_issues('{"status":"all"}')) x
                     where (x ->> 'do_id')::bigint = (select id from t_do where k = 'do2')), 'cancelled DO issues voided';
  assert jsonb_array_length(public.ops_po_do_list('{}')) = 1 and jsonb_array_length(public.ops_po_do_list('{"status":"all"}')) = 3,
    'list open / all';
end $$;
select pg_temp.expect_error($q$select public.ops_po_do_confirm((select id from t_do where k = 'do2'))$q$, '已取消');
select pg_temp.expect_error($q$select public.ops_po_do_cancel((select id from t_do where k = 'do2'))$q$, '已取消');
select pg_temp.expect_error($q$select public.ops_po_do_save(jsonb_build_object('id', (select id from t_do where k = 'do2'), 'eta', '2026-12-01'))$q$, '已取消');
-- 取消后 DO 号可以再用
do $$ declare r jsonb; begin
  r := public.ops_po_do_save('{"creditor_code":"4000-F001","po_nos":["PO-F2"],"do_no":"FS-0902",
    "items":[{"item_code":"BS100","shipped":5,"alloc":{"HQ":5}},{"item_code":"MR400","shipped":1,"alloc":{"HQ":1}}]}');
  insert into t_do values ('do4', (r ->> 'id')::bigint);
end $$;
select pg_temp.expect_error($q$select public.ops_po_issue_add(jsonb_build_object('do_id', (select id from t_do where k = 'do4'),
  'item_code', 'BS100', 'qty', 1))$q$, 'DO 确认之后');
-- 退回草稿再确认：已决定「厂家会补」的少发不会重复记
do $$ declare r jsonb; begin
  r := public.ops_po_do_confirm((select id from t_do where k = 'do4'));
  -- SK500：DO2 取消后它的「取消」少发作废了 → PO-F2 还欠的 3 件重新记
  assert jsonb_array_length(r -> 'issues') = 2 and (pg_temp.iss(r -> 'issues', 'short', 'MR400') ->> 'qty')::numeric = 2
     and (pg_temp.iss(r -> 'issues', 'short', 'SK500') ->> 'qty')::numeric = 3,
    'MR400 short 2 (the voided one no longer counts): ' || (r -> 'issues')::text;
  perform public.ops_po_issue_set(array[(pg_temp.iss(r -> 'issues', 'short', 'MR400') ->> 'id')::bigint], 'await');
end $$;
select pg_temp.as_user('pomgr@example.com');
select public.ops_po_do_reopen((select id from t_do where k = 'do4')) is not null as reopened;
select pg_temp.as_user('buyer@example.com');
do $$ declare r jsonb; begin
  r := public.ops_po_do_confirm((select id from t_do where k = 'do4'));
  assert jsonb_array_length(r -> 'issues') = 2 and pg_temp.iss(r -> 'issues', 'short', 'MR400') ->> 'decision' = 'await'
     and (pg_temp.iss(r -> 'issues', 'short', 'MR400') ->> 'qty')::numeric = 2
     and (pg_temp.iss(r -> 'issues', 'short', 'SK500') ->> 'qty')::numeric = 3,
    'kept await short, no duplicate: ' || (r -> 'issues')::text;
  assert (select count(*) from jsonb_array_elements(r -> 'applied') a) = 2, 'fresh applications';
end $$;

-- DO5（另一个厂家 PO-G1）：Excel 型号对不上 → 采购对应到 PO 的 TP200（保留原型号）；多发已处理的，退回草稿再确认不会重复
do $$ declare r jsonb; begin
  r := public.ops_po_do_save('{"creditor_code":"4000-F002","po_nos":["PO-G1"],"do_no":"G-1",
    "items":[{"src_code":"TP-200X","src_desc":"TAP 200 CHROME","shipped":7,"src_row":5},
             {"src_code":"ZZ-1","src_desc":"UNKNOWN","shipped":1}]}');
  insert into t_do values ('do5', (r ->> 'id')::bigint);
  assert r -> 'items' -> 0 -> 'item_code' = 'null'::jsonb and (r ->> 'unmatched_count')::int = 2
     and r ->> 'supplier_name' = 'OTHER FACTORY', 'unmatched: ' || r::text;
  r := public.ops_po_do_save(jsonb_build_object('id', r -> 'id', 'items', jsonb_build_array(
         (r -> 'items' -> 0) || '{"item_code":"tp200","alloc":{"HQ":7}}', r -> 'items' -> 1)));
  assert r -> 'items' -> 0 ->> 'item_code' = 'TP200' and r -> 'items' -> 0 ->> 'src_code' = 'TP-200X'
     and (r -> 'items' -> 0 ->> 'src_row')::int = 5 and r -> 'items' -> 0 ->> 'uom' = 'PCS'
     and (r ->> 'unmatched_count')::int = 1 and (r ->> 'item_count')::int = 1, 'mapped: ' || r::text;
  r := public.ops_po_do_confirm((r ->> 'id')::bigint);
  assert jsonb_array_length(r -> 'issues') = 2 and (pg_temp.iss(r -> 'issues', 'over', 'TP200') ->> 'qty')::numeric = 2
     and pg_temp.iss(r -> 'issues', 'wrong', null) ->> 'received_code' = 'ZZ-1'
     and pg_temp.iss(r -> 'issues', 'wrong', null) ->> 'description' = 'UNKNOWN'
     and pg_temp.iss(r -> 'issues', 'wrong', null) -> 'ordered' = 'null'::jsonb, 'DO5 issues: ' || (r -> 'issues')::text;
  assert (select count(*) from jsonb_array_elements(r -> 'applied') a where (a ->> 'dtl_key')::bigint = 301 and (a ->> 'qty')::numeric = 5) = 1
     and (select count(*) from jsonb_array_elements(r -> 'applied') a where a -> 'dtl_key' = 'null'::jsonb and (a ->> 'qty')::numeric = 2) = 1,
    'over part has no PO line';
  perform public.ops_po_issue_set(array[(pg_temp.iss(r -> 'issues', 'over', 'TP200') ->> 'id')::bigint], 'resolve', '厂家送的');
end $$;
select pg_temp.as_user('pomgr@example.com');
select public.ops_po_do_reopen((select id from t_do where k = 'do5')) is not null as reopened;
select pg_temp.as_user('buyer@example.com');
do $$ declare r jsonb; begin
  r := public.ops_po_do_confirm((select id from t_do where k = 'do5'));
  assert jsonb_array_length(r -> 'issues') = 2 and pg_temp.iss(r -> 'issues', 'over', 'TP200') ->> 'status' = 'resolved'
     and pg_temp.iss(r -> 'issues', 'over', 'TP200') ->> 'action_note' = '厂家送的'
     and pg_temp.iss(r -> 'issues', 'wrong', null) ->> 'status' = 'open', 'over kept, wrong recreated: ' || (r -> 'issues')::text;
end $$;

-- 10. 厂家问题清单与处理
do $$ declare l jsonb; o jsonb; d jsonb; n int; begin
  l := public.ops_po_issues('{}');
  -- 未处理：DO1 BS100 少 4、TP200 多 2、WC300 少 4（厂家会补）、发错 XX-9、坏货 1；DO4 MR400 少 2（厂家会补）、SK500 少 3；
  -- DO5 发错 ZZ-1。作废：DO2 的两笔（退回草稿 / 取消）、DO4 第一次的 SK500、DO5 第一次的 ZZ-1
  assert jsonb_array_length(l) = 8, 'open issues: ' || l::text;
  assert jsonb_array_length(public.ops_po_issues('{"status":"all"}')) = 9, 'all (no void)';
  assert jsonb_array_length(public.ops_po_issues('{"status":"void"}')) = 4, 'void';
  assert jsonb_array_length(public.ops_po_issues('{"q":"FS-0901"}')) = 5 and jsonb_array_length(public.ops_po_issues('{"kind":"wrong"}')) = 2
     and jsonb_array_length(public.ops_po_issues('{"creditor_code":"4000-F002"}')) = 1, 'filters';
  assert (select string_agg(distinct x ->> 'supplier_name', ',') from jsonb_array_elements(l) x) = 'FOSHAN FACTORY,OTHER FACTORY'
     and l -> 0 ->> 'supplier_name' = 'FOSHAN FACTORY', 'sorted by supplier';
  assert pg_temp.no_price(l), 'issues no prices';
  o := (select x from jsonb_array_elements(l) x where x ->> 'kind' = 'over' and x ->> 'do_no' = 'FS-0901');
  assert o ->> 'supplier_name' = 'FOSHAN FACTORY' and o ->> 'do_date' = '2026-10-10' and o -> 'po_nos' = '["PO-F1"]'::jsonb
     and (o ->> 'open_qty')::numeric = 2, 'issue fields: ' || o::text;
  n := public.ops_po_issue_set(array[(o ->> 'id')::bigint], 'resolve', '下次货款扣');
  assert n = 1 and (select x ->> 'action_note' from jsonb_array_elements(public.ops_po_issues('{"status":"resolved"}')) x
                    where (x ->> 'id')::bigint = (o ->> 'id')::bigint) = '下次货款扣', 'resolved';
  perform public.ops_po_issue_set(array[(o ->> 'id')::bigint], 'reopen');
  perform public.ops_po_issue_set(array[(o ->> 'id')::bigint], 'note', '多了 2 个 TAP');
  o := (select x from jsonb_array_elements(public.ops_po_issues('{}')) x where x ->> 'kind' = 'over' and x ->> 'do_no' = 'FS-0901');
  assert o ->> 'status' = 'open' and o ->> 'note' = '多了 2 个 TAP' and o -> 'resolved_at' = 'null'::jsonb, 'reopened + note: ' || o::text;
  d := pg_temp.iss(l, 'damaged', 'BS100');
  perform public.ops_po_issue_set(array[(d ->> 'id')::bigint], 'void');
  assert jsonb_array_length(public.ops_po_issues('{}')) = 7, 'manual damaged voided';
end $$;
select pg_temp.expect_error($q$select public.ops_po_issue_set(array[(select (x ->> 'id')::bigint from jsonb_array_elements(
  public.ops_po_issues('{"kind":"over"}')) x where x ->> 'do_no' = 'FS-0901')], 'void')$q$, '自动产生的问题不能作废');
select pg_temp.expect_error($q$select public.ops_po_issue_set(array[1::bigint], 'explode')$q$, '未知的动作');
-- 少发还没决定不能直接「已处理」（批量也一样）：要先选厂家会补或取消
select pg_temp.expect_error($q$select public.ops_po_issue_set(array[(select (x ->> 'id')::bigint from jsonb_array_elements(
  public.ops_po_issues('{}')) x where x ->> 'item_code' = 'SK500' and x ->> 'kind' = 'short')], 'resolve')$q$, '要先选「厂家会补」');
select public.ops_po_issue_set(array[(select (x ->> 'id')::bigint from jsonb_array_elements(public.ops_po_issues('{}')) x
                                      where x ->> 'item_code' = 'SK500' and x ->> 'kind' = 'short')], 'cancel');
select pg_temp.expect_error($q$select public.ops_po_issue_set(array[(select (x ->> 'id')::bigint from jsonb_array_elements(
  public.ops_po_issues('{"status":"resolved"}')) x where x ->> 'item_code' = 'SK500')], 'await')$q$, '已经处理过了');

-- 11. JB 分店的采购：只看得到 HOMEWORKSSOUTHERN 的 PO（整本 = JB）与 JB 的在路上
select pg_temp.as_user('jbbuyer@example.com');
do $$ declare s jsonb; c jsonb; t jsonb; begin
  s := (select x from jsonb_array_elements(public.ops_po_do_suppliers()) x where x ->> 'creditor_code' = '4000-F001');
  assert s ->> 'company' = 'HOMEWORKSSOUTHERN' and (s ->> 'po_count')::int = 1, 'JB suppliers: ' || s::text;
  assert not exists (select 1 from jsonb_array_elements(public.ops_po_do_suppliers()) x where x ->> 'company' <> 'HOMEWORKSSOUTHERN'),
    'JB company only';
  c := public.ops_po_do_candidates('', '4000-F001', array['PO-JF1']);
  assert pg_temp.item(c -> 'items', 'BS100') ->> 'single_outlet' = 'JB'
     and pg_temp.item(c -> 'items', 'BS100') -> 'by_outlet' ? 'JB', 'JB book = JB: ' || c::text;
  t := public.ops_po_transit();
  assert t -> 'outlets' -> 0 ->> 'code' = 'JB' and jsonb_array_length(t -> 'outlets') = 1
     and not exists (select 1 from jsonb_array_elements(t -> 'rows') x where x ->> 'outlet' <> 'JB'), 'JB transit';
  assert jsonb_array_length(public.ops_po_issues('{"status":"all"}')) = 0 and jsonb_array_length(public.ops_po_do_list('{"status":"all"}')) = 0,
    'HQ DOs and issues hidden';
end $$;
select pg_temp.expect_error($q$select public.ops_po_do_get((select id from t_do where k = 'do1'))$q$, '找不到这张厂家 DO');
select pg_temp.expect_error($q$select public.ops_po_do_suppliers('HOMEWORKSSB')$q$, '请选择你分店的公司');

-- 12. Storage policy 函数：读写都要订货「可编辑」+ 看得到那间公司
do $$ begin
  assert public.ops_po_file_ok('HOMEWORKSSOUTHERN/2026-10/a.pdf', true) and not public.ops_po_file_ok('HOMEWORKSSB/2026-10/a.pdf', false),
    'jb buyer: own company only';
end $$;
select pg_temp.as_user('buyer@example.com');
do $$ begin
  assert public.ops_po_file_ok('HOMEWORKSSB/2026-10/a.xlsx', true) and public.ops_po_file_ok('HOMEWORKSSB/2026-10/a.xlsx', false), 'buyer rw';
  assert not public.ops_po_file_ok('HOMEWORKSSOUTHERN/2026-10/a.xlsx', false) and not public.ops_po_file_ok('a.xlsx', true)
     and not public.ops_po_file_ok(null, false), 'buyer other company / bad path';
end $$;
select pg_temp.as_user('hqsales@example.com');
do $$ begin assert not public.ops_po_file_ok('HOMEWORKSSB/2026-10/a.xlsx', false), 'view-only cannot read files'; end $$;
select pg_temp.as_user('picker@example.com');
do $$ begin assert not public.ops_po_file_ok('HOMEWORKSSB/2026-10/a.xlsx', true), 'warehouse cannot upload'; end $$;
select pg_temp.as_user('stranger@example.com');
do $$ begin assert not public.ops_po_file_ok('HOMEWORKSSB/2026-10/a.xlsx', false), 'stranger'; end $$;
select pg_temp.expect_error($q$select public.ops_po_transit()$q$, '还没加入营运系统');
select pg_temp.as_user('boss@example.com');
do $$ begin
  assert public.ops_po_file_ok('HOMEWORKSSOUTHERN/x.pdf', false) and public.ops_po_file_ok('HOMEWORKSSB/x.pdf', true), 'admin both';
  assert jsonb_array_length(public.ops_po_transit() -> 'rows') = 4 and jsonb_array_length(public.ops_po_outlets()) = 4, 'admin sees all';
end $$;

-- 13. anon 什么都不能叫
reset role;
set role anon;
select pg_temp.expect_error($q$select public.ops_po_transit()$q$, 'permission denied');
select pg_temp.expect_error($q$select public.ops_po_outlets()$q$, 'permission denied');
select pg_temp.expect_error($q$select public.ops_po_do_list('{}')$q$, 'permission denied');
select pg_temp.expect_error($q$select public.ops_po_do_save('{}')$q$, 'permission denied');
select pg_temp.expect_error($q$select public.ops_po_do_confirm(1)$q$, 'permission denied');
select pg_temp.expect_error($q$select public.ops_po_issues('{}')$q$, 'permission denied');
select pg_temp.expect_error($q$select public.ops_po_issue_set(array[1::bigint], 'note')$q$, 'permission denied');
select pg_temp.expect_error($q$select public.ops_po_file_ok('HOMEWORKSSB/a', false)$q$, 'permission denied');
select pg_temp.expect_error('select * from ops.supplier_issue', 'permission denied');
reset role;
-- 没有任何东西写进 bi.*（AutoCount 只读）：测试自己改的 101 / 109 以外，PO 行原样
do $$ begin
  assert (select count(*) from bi.fact_po_line where creditor_code = '4000-F001' and transferred_qty <> 0) = 2, 'bi untouched';
end $$;

-- 14. 回归（2026-10-12 审查）：GRN 开在别行 / 别张 PO、先开 GRN 才登记 DO、退回草稿再确认、坏货与到货少、分批出货、
--     少发只被这张 PO 的出货补、同型号对不上的行合起来、取消的 DO 问题作废、PO 有没货号的行。每个情境用自己的厂家。
create or replace function pg_temp.mkdo(p jsonb) returns bigint language plpgsql as $$
begin
  return (public.ops_po_do_save(p) ->> 'id')::bigint;
end $$;
create or replace function pg_temp.cand(p_cred text, p_pos text[], p_item text) returns jsonb language sql as $$
  select pg_temp.item(public.ops_po_do_candidates('HOMEWORKSSB', p_cred, p_pos) -> 'items', p_item)
$$;
-- 这个厂家所有没作废的问题：kind:item → 还欠 / 状态
create or replace function pg_temp.iss_of(p_cred text) returns text language sql as $$
  select coalesce(string_agg((x ->> 'kind') || ':' || coalesce(x ->> 'item_code', x ->> 'received_code') || '='
                             || (x ->> 'qty') || '/' || (x ->> 'open_qty') || '/' || (x ->> 'status'), ',' order by (x ->> 'id')::bigint), '')
  from jsonb_array_elements(public.ops_po_issues(jsonb_build_object('status', 'all', 'creditor_code', p_cred))) x
$$;
create or replace function pg_temp.grn(p_key bigint, p_tr numeric) returns void language sql security definer as $$
  update bi.fact_po_line set transferred_qty = p_tr where company = 'HOMEWORKSSB' and dtl_key = p_key
$$;
grant execute on all functions in schema pg_temp to authenticated, anon;
insert into bi.fact_po_line (company, dtl_key, po_no, po_date, creditor_code, creditor_name, item_code, description,
                             location, uom, qty, transferred_qty) values
  ('HOMEWORKSSB', 1501, 'R5-P1', '2026-08-01', 'R5', 'R5', 'A5', 'A5', 'HQ', 'PCS', 10, 0),
  ('HOMEWORKSSB', 1502, 'R5-P1', '2026-08-01', 'R5', 'R5', 'A5', 'A5', 'PRE (JB)', 'PCS', 6, 0),
  ('HOMEWORKSSB', 1401, 'R4-P1', '2026-08-01', 'R4', 'R4', 'A4', 'A4', 'HQ', 'PCS', 10, 0),
  ('HOMEWORKSSB', 1402, 'R4-P2', '2026-09-01', 'R4', 'R4', 'A4', 'A4', 'HQ', 'PCS', 10, 0),
  ('HOMEWORKSSB', 1201, 'R2-P1', '2026-08-01', 'R2', 'R2', 'A2', 'A2', 'HQ', 'PCS', 10, 0),
  ('HOMEWORKSSB', 1202, 'R2-P1', '2026-08-01', 'R2', 'R2', 'A2B', 'A2B', 'HQ', 'PCS', 20, 0),
  ('HOMEWORKSSB', 1101, 'R1-P1', '2026-08-01', 'R1', 'R1', 'A1', 'A1', 'HQ', 'PCS', 20, 10),
  ('HOMEWORKSSB', 1102, 'R1-P1', '2026-08-01', 'R1', 'R1', 'A1B', 'A1B', 'HQ', 'PCS', 10, 10),
  ('HOMEWORKSSB', 1301, 'R3-P1', '2026-08-01', 'R3', 'R3', 'A3', 'A3', 'HQ', 'PCS', 10, 0),
  ('HOMEWORKSSB', 1302, 'R3-P1', '2026-08-01', 'R3', 'R3', 'A3B', 'A3B', 'HQ', 'PCS', 10, 0),
  ('HOMEWORKSSB', 1601, 'R6-P1', '2026-08-01', 'R6', 'R6', 'A6', 'A6', 'HQ', 'PCS', 10, 0),
  ('HOMEWORKSSB', 1602, 'R6-P2', '2026-09-01', 'R6', 'R6', 'A6', 'A6', 'HQ', 'PCS', 10, 0),
  ('HOMEWORKSSB', 1701, 'R7-P1', '2026-08-01', 'R7', 'R7', 'A7', 'A7', 'HQ', 'PCS', 10, 0),
  ('HOMEWORKSSB', 1702, 'R7-P2', '2026-09-01', 'R7', 'R7', 'A7', 'A7', 'HQ', 'PCS', 10, 0),
  ('HOMEWORKSSB', 1801, 'R8-P1', '2026-08-01', 'R8', 'R8', 'A8', 'A8', 'HQ', 'PCS', 100, 0),
  ('HOMEWORKSSB', 1901, 'R9-P1', '2026-08-01', 'R9', 'R9', 'A9', 'A9', 'HQ', 'PCS', 10, 0),
  ('HOMEWORKSSB', 2001, 'R10-P1', '2026-08-01', 'R10', 'R10', 'A10', 'A10', 'HQ', 'PCS', 5, 0),
  ('HOMEWORKSSB', 2101, 'R11-P1', '2026-08-01', 'R11', 'R11', 'A11', 'A11', 'HQ', 'PCS', 10, 0),
  ('HOMEWORKSSB', 2201, 'R12-P1', '2026-08-01', 'R12', 'R12', 'A12', 'A12', 'HQ', 'PCS', 5, 0),
  ('HOMEWORKSSB', 2202, 'R12-P1', '2026-08-01', 'R12', 'R12', null, 'TRANSPORT CHARGES', 'HQ', 'TRIP', 1, 0),
  ('HOMEWORKSSB', 2301, 'R13-P1', '2026-08-01', 'R13', 'R13', 'A13', 'A13', 'HQ', 'PCS', 10, 0),
  ('HOMEWORKSSB', 2302, 'R13-P2', '2026-09-01', 'R13', 'R13', 'A13', 'A13', 'HQ', 'PCS', 10, 0);
-- R1：本地货先开 GRN（DO 日期之后）才登记 DO
insert into bi.fact_po_receipt (company, src, dtl_key, doc_no, rcv_date, po_no, item_code, qty) values
  ('HOMEWORKSSB', 'GR', 1101, 'GR-R1', '2026-10-16', 'R1-P1', 'A1', 10),
  ('HOMEWORKSSB', 'GR', 1102, 'GR-R1', '2026-10-16', 'R1-P1', 'A1B', 10);
set role authenticated;
select pg_temp.as_user('buyer@example.com');

-- S5：同一张 PO 总部 10 + PRE (JB) 6；DO1 出 10（总部 6、JB 4）、到货，仓库 GRN 全开在总部那行
do $$ declare c jsonb; r jsonb; v bigint; begin
  v := pg_temp.mkdo('{"creditor_code":"R5","po_nos":["R5-P1"],"do_no":"R5-1",
    "items":[{"item_code":"A5","shipped":10,"alloc":{"HQ":6,"JB":4}}]}');
  perform public.ops_po_do_confirm(v);
  perform public.ops_po_do_arrive(v);
  perform pg_temp.grn(1501, 10);
  c := pg_temp.cand('R5', array['R5-P1'], 'A5');
  assert (c ->> 'in_transit')::numeric = 0 and (c ->> 'remaining')::numeric = 6
     and (c -> 'by_outlet' -> 'JB' ->> 'remaining')::numeric = 6, 'S5 after GRN on the HQ line: ' || c::text;
  r := public.ops_po_do_confirm(pg_temp.mkdo('{"creditor_code":"R5","po_nos":["R5-P1"],"do_no":"R5-2",
    "items":[{"item_code":"A5","shipped":6,"alloc":{"JB":6}}]}'));
  assert jsonb_array_length(r -> 'issues') = 0, 'S5 no false over: ' || (r -> 'issues')::text;
  assert pg_temp.iss_of('R5') = 'short:A5=6/0/resolved', 'S5 short filled by DO2: ' || pg_temp.iss_of('R5');
end $$;

-- S4：DO1 照 FIFO 记在 P1，仓库 GRN 开在 P2
do $$ declare c jsonb; r jsonb; begin
  perform public.ops_po_do_confirm(pg_temp.mkdo('{"creditor_code":"R4","po_nos":["R4-P1","R4-P2"],"do_no":"R4-1",
    "items":[{"item_code":"A4","shipped":10,"alloc":{"HQ":10}}]}'));
  perform pg_temp.grn(1402, 10);
  c := pg_temp.cand('R4', array['R4-P1', 'R4-P2'], 'A4');
  assert (c ->> 'in_transit')::numeric = 0 and (c ->> 'remaining')::numeric = 10, 'S4 GRN on another PO: ' || c::text;
  r := public.ops_po_do_confirm(pg_temp.mkdo('{"creditor_code":"R4","po_nos":["R4-P1","R4-P2"],"do_no":"R4-2",
    "items":[{"item_code":"A4","shipped":10,"alloc":{"HQ":10}}]}'));
  assert jsonb_array_length(r -> 'issues') = 0 and pg_temp.iss_of('R4') = 'short:A4=10/0/resolved', 'S4: ' || pg_temp.iss_of('R4');
end $$;

-- S2 / S2b：确认后货到了、开了 GRN（A2 只到 8、A2B 到 10），主管退回草稿改数量再确认 → 起算点沿用第一次的
do $$ begin
  insert into t_do values ('r2', pg_temp.mkdo('{"creditor_code":"R2","po_nos":["R2-P1"],"do_no":"R2-1","do_date":"2026-10-15",
    "items":[{"item_code":"A2","shipped":10,"alloc":{"HQ":10}},{"item_code":"A2B","shipped":10,"alloc":{"HQ":10}}]}'));
  perform public.ops_po_do_confirm((select id from t_do where k = 'r2'));
  assert pg_temp.iss_of('R2') = 'short:A2B=10/10/open', 'S2 first confirm: ' || pg_temp.iss_of('R2');
  perform pg_temp.grn(1201, 8);
  perform pg_temp.grn(1202, 10);
end $$;
select pg_temp.as_user('pomgr@example.com');
select public.ops_po_do_reopen((select id from t_do where k = 'r2')) is not null as reopened;
select pg_temp.as_user('buyer@example.com');
do $$ declare r jsonb; c jsonb; begin
  r := public.ops_po_do_get((select id from t_do where k = 'r2'));
  -- 草稿：还可以出把这张已开 GRN 的放回来（A2 10、A2B 20），画面看得到
  assert (pg_temp.item(r -> 'candidates', 'A2') ->> 'remaining')::numeric = 10
     and (pg_temp.item(r -> 'candidates', 'A2') ->> 'received_do')::numeric = 8
     and (pg_temp.item(r -> 'candidates', 'A2B') ->> 'remaining')::numeric = 20, 'S2 draft candidates: ' || (r -> 'candidates')::text;
  perform public.ops_po_do_save(jsonb_build_object('id', r -> 'id', 'items', jsonb_set(r -> 'items', '{0}',
            (r -> 'items' -> 0) || '{"shipped":8,"alloc":{"HQ":8}}')));
  r := public.ops_po_do_confirm((r ->> 'id')::bigint);
  assert pg_temp.iss_of('R2') = 'short:A2=2/2/open,short:A2B=10/10/open', 'S2b re-confirm: ' || pg_temp.iss_of('R2');
  assert not exists (select 1 from jsonb_array_elements(r -> 'applied') a where a -> 'dtl_key' = 'null'::jsonb), 'S2 nothing off-PO';
  c := pg_temp.cand('R2', array['R2-P1'], 'A2');
  assert (c ->> 'in_transit')::numeric = 0 and (c ->> 'remaining')::numeric = 2, 'S2b A2: ' || c::text;
  c := pg_temp.cand('R2', array['R2-P1'], 'A2B');
  assert (c ->> 'in_transit')::numeric = 0 and (c ->> 'remaining')::numeric = 10, 'S2 A2B: ' || c::text;
end $$;

-- S1：GRN（10/16）比登记 DO（DO 日期 10/15）早；A1B 甚至已经全收了
do $$ declare r jsonb; c jsonb; begin
  r := public.ops_po_do_confirm(pg_temp.mkdo('{"creditor_code":"R1","po_nos":["R1-P1"],"do_no":"R1-1","do_date":"2026-10-15",
    "items":[{"item_code":"A1","shipped":10,"alloc":{"HQ":10}},{"item_code":"A1B","shipped":10,"alloc":{"HQ":10}}]}'));
  assert pg_temp.iss_of('R1') = 'short:A1=10/10/open', 'S1 short not over: ' || pg_temp.iss_of('R1');
  assert (select count(*) from jsonb_array_elements(r -> 'applied') a where a -> 'dtl_key' = 'null'::jsonb) = 0, 'S1 on PO lines';
  c := pg_temp.cand('R1', array['R1-P1'], 'A1');
  assert (c ->> 'in_transit')::numeric = 0 and (c ->> 'remaining')::numeric = 10, 'S1 after: ' || c::text;
  r := public.ops_po_do_confirm(pg_temp.mkdo('{"creditor_code":"R1","po_nos":["R1-P1"],"do_no":"R1-2","do_date":"2026-10-18",
    "items":[{"item_code":"A1","shipped":10,"alloc":{"HQ":10}}]}'));
  assert jsonb_array_length(r -> 'issues') = 0 and pg_temp.iss_of('R1') = 'short:A1=10/0/resolved', 'S1 DO2: ' || pg_temp.iss_of('R1');
end $$;

-- S3：到货了，A3 坏 4（只开 GRN 6）、A3B 到货少 2（开 GRN 8）→ 厂家欠的看得到，补来的不算多发
do $$ declare c jsonb; r jsonb; v bigint; begin
  v := pg_temp.mkdo('{"creditor_code":"R3","po_nos":["R3-P1"],"do_no":"R3-1",
    "items":[{"item_code":"A3","shipped":10,"alloc":{"HQ":10}},{"item_code":"A3B","shipped":10,"alloc":{"HQ":10}}]}');
  perform public.ops_po_do_confirm(v);
  perform public.ops_po_do_arrive(v);
  perform public.ops_po_issue_add(jsonb_build_object('do_id', v, 'item_code', 'A3', 'qty', 4, 'note', '破了'));
  perform public.ops_po_issue_add(jsonb_build_object('do_id', v, 'kind', 'short', 'item_code', 'A3B', 'qty', 2, 'note', '少一箱'));
  perform pg_temp.expect_error(format('select public.ops_po_issue_add(%L)',
            jsonb_build_object('do_id', v, 'item_code', 'A3', 'qty', 7)), '合计不能多过这张 DO 的出货数量（10）');
  perform pg_temp.grn(1301, 6);
  perform pg_temp.grn(1302, 8);
  c := pg_temp.cand('R3', array['R3-P1'], 'A3');
  assert (c ->> 'in_transit')::numeric = 0 and (c ->> 'remaining')::numeric = 4 and (c ->> 'owed')::numeric = 4, 'S3 damaged: ' || c::text;
  c := pg_temp.cand('R3', array['R3-P1'], 'A3B');
  assert (c ->> 'in_transit')::numeric = 0 and (c ->> 'remaining')::numeric = 2 and (c ->> 'owed')::numeric = 2, 'S3 missing: ' || c::text;
  r := public.ops_po_do_confirm(pg_temp.mkdo('{"creditor_code":"R3","po_nos":["R3-P1"],"do_no":"R3-2",
    "items":[{"item_code":"A3","shipped":4,"alloc":{"HQ":4}},{"item_code":"A3B","shipped":2,"alloc":{"HQ":2}}]}'));
  assert jsonb_array_length(r -> 'issues') = 0, 'S3 replacements are not over: ' || (r -> 'issues')::text;
  assert pg_temp.iss_of('R3') = 'damaged:A3=4/4/open,short:A3B=2/0/resolved', 'S3: ' || pg_temp.iss_of('R3');
end $$;

-- S11b / S11：P1 少 4（厂家会补）；新单 P2。只出 P2 的 10 → P1 的少发不动；出 14 → 多的 4 补 P1、不算多发
do $$ declare r jsonb; c jsonb; begin
  r := public.ops_po_do_confirm(pg_temp.mkdo('{"creditor_code":"R6","po_nos":["R6-P1"],"do_no":"R6-1",
    "items":[{"item_code":"A6","shipped":6,"alloc":{"HQ":6}}]}'));
  perform public.ops_po_issue_set(array[(pg_temp.iss(r -> 'issues', 'short', 'A6') ->> 'id')::bigint], 'await');
  r := public.ops_po_do_confirm(pg_temp.mkdo('{"creditor_code":"R6","po_nos":["R6-P2"],"do_no":"R6-2",
    "items":[{"item_code":"A6","shipped":10,"alloc":{"HQ":10}}]}'));
  assert jsonb_array_length(r -> 'issues') = 0 and pg_temp.iss_of('R6') = 'short:A6=4/4/open', 'S11b: ' || pg_temp.iss_of('R6');
  assert (pg_temp.cand('R6', array['R6-P1'], 'A6') ->> 'remaining')::numeric = 4, 'S11b P1 still owes 4';

  r := public.ops_po_do_confirm(pg_temp.mkdo('{"creditor_code":"R7","po_nos":["R7-P1"],"do_no":"R7-1",
    "items":[{"item_code":"A7","shipped":6,"alloc":{"HQ":6}}]}'));
  perform public.ops_po_issue_set(array[(pg_temp.iss(r -> 'issues', 'short', 'A7') ->> 'id')::bigint], 'await');
  c := pg_temp.cand('R7', array['R7-P2'], 'A7');            -- 前端预估用
  assert (c ->> 'await_elsewhere')::numeric = 4 and (c ->> 'flagged')::numeric = 0 and (c ->> 'fillable')::numeric = 0
     and (pg_temp.cand('R7', array['R7-P1'], 'A7') ->> 'fillable')::numeric = 4, 'S11 preview numbers: ' || c::text;
  r := public.ops_po_do_confirm(pg_temp.mkdo('{"creditor_code":"R7","po_nos":["R7-P2"],"do_no":"R7-2",
    "items":[{"item_code":"A7","shipped":14,"alloc":{"HQ":14}}]}'));
  assert jsonb_array_length(r -> 'issues') = 0 and pg_temp.iss_of('R7') = 'short:A7=4/0/resolved', 'S11: ' || pg_temp.iss_of('R7');
  assert exists (select 1 from jsonb_array_elements(r -> 'applied') a where (a ->> 'dtl_key')::bigint = 1701 and (a ->> 'qty')::numeric = 4),
    'S11 extra booked on P1: ' || (r -> 'applied')::text;
  assert (pg_temp.cand('R7', array['R7-P1'], 'A7') ->> 'remaining')::numeric = 0, 'S11 P1 done';
end $$;

-- P1 少 4；下一张选 P1 + P2 出 10（先开的单先记：P1 4、P2 6）→ P1 的少发结案，改记 P1 + P2 还欠 4
do $$ begin
  perform public.ops_po_do_confirm(pg_temp.mkdo('{"creditor_code":"R13","po_nos":["R13-P1"],"do_no":"R13-1",
    "items":[{"item_code":"A13","shipped":6,"alloc":{"HQ":6}}]}'));
  perform public.ops_po_do_confirm(pg_temp.mkdo('{"creditor_code":"R13","po_nos":["R13-P1","R13-P2"],"do_no":"R13-2",
    "items":[{"item_code":"A13","shipped":10,"alloc":{"HQ":10}}]}'));
  assert pg_temp.iss_of('R13') = 'short:A13=4/0/resolved,short:A13=4/4/open', 'short moves to the PO that owes: ' || pg_temp.iss_of('R13');
end $$;

-- S10：一张 PO 分三批出（40 / 30 / 30），中间都没决定 → 少发跟著减，最后结案
do $$ begin
  perform public.ops_po_do_confirm(pg_temp.mkdo('{"creditor_code":"R8","po_nos":["R8-P1"],"do_no":"R8-1",
    "items":[{"item_code":"A8","shipped":40,"alloc":{"HQ":40}}]}'));
  perform public.ops_po_do_confirm(pg_temp.mkdo('{"creditor_code":"R8","po_nos":["R8-P1"],"do_no":"R8-2",
    "items":[{"item_code":"A8","shipped":30,"alloc":{"HQ":30}}]}'));
  assert pg_temp.iss_of('R8') = 'short:A8=60/30/open', 'S10 after 2: ' || pg_temp.iss_of('R8');
  perform public.ops_po_do_confirm(pg_temp.mkdo('{"creditor_code":"R8","po_nos":["R8-P1"],"do_no":"R8-3",
    "items":[{"item_code":"A8","shipped":30,"alloc":{"HQ":30}}]}'));
  assert pg_temp.iss_of('R8') = 'short:A8=60/0/resolved', 'S10 after 3: ' || pg_temp.iss_of('R8');
end $$;

-- S9：少 4 已决定「厂家会补」；主管退回草稿把出货改成 3 → 再记差额 3；再改成 10 → 留著的少发扣掉
do $$ declare r jsonb; begin
  insert into t_do values ('r9', pg_temp.mkdo('{"creditor_code":"R9","po_nos":["R9-P1"],"do_no":"R9-1",
    "items":[{"item_code":"A9","shipped":6,"alloc":{"HQ":6}}]}'));
  r := public.ops_po_do_confirm((select id from t_do where k = 'r9'));
  perform public.ops_po_issue_set(array[(pg_temp.iss(r -> 'issues', 'short', 'A9') ->> 'id')::bigint], 'await');
end $$;
select pg_temp.as_user('pomgr@example.com');
do $$ begin
  perform public.ops_po_do_reopen((select id from t_do where k = 'r9'));
  perform public.ops_po_do_save(jsonb_build_object('id', (select id from t_do where k = 'r9'),
            'items', '[{"item_code":"A9","shipped":3,"alloc":{"HQ":3}}]'::jsonb));
  perform public.ops_po_do_confirm((select id from t_do where k = 'r9'));
  assert pg_temp.iss_of('R9') = 'short:A9=4/4/open,short:A9=3/3/open', 'S9 shipped 6 → 3: ' || pg_temp.iss_of('R9');
  perform public.ops_po_do_reopen((select id from t_do where k = 'r9'));
  perform public.ops_po_do_save(jsonb_build_object('id', (select id from t_do where k = 'r9'),
            'items', '[{"item_code":"A9","shipped":10,"alloc":{"HQ":10}}]'::jsonb));
  perform public.ops_po_do_confirm((select id from t_do where k = 'r9'));
  assert pg_temp.iss_of('R9') = 'short:A9=4/0/resolved', 'S9 shipped → 10: ' || pg_temp.iss_of('R9');
  -- 再退回：这张自己扣掉的撤回（回到厂家会补 4）
  perform public.ops_po_do_reopen((select id from t_do where k = 'r9'));
  assert pg_temp.iss_of('R9') = 'short:A9=4/4/open', 'S9 reopen restores: ' || pg_temp.iss_of('R9');
end $$;
select pg_temp.as_user('buyer@example.com');

-- S8：Excel 同一个对不上的型号分两行（2 + 3）→ 发错型号 5
do $$ begin
  perform public.ops_po_do_confirm(pg_temp.mkdo('{"creditor_code":"R10","po_nos":["R10-P1"],"do_no":"R10-1",
    "items":[{"item_code":"A10","shipped":5,"alloc":{"HQ":5}},
             {"src_code":"XX-9","src_desc":"BASIN","shipped":2,"src_row":5},
             {"src_code":"xx-9","src_desc":"BASIN","shipped":3,"src_row":9}]}'));
  assert pg_temp.iss_of('R10') = 'wrong:XX-9=5/5/open', 'S8: ' || pg_temp.iss_of('R10');
end $$;

-- S12：退回草稿后取消 → 留著的少发（厂家会补）与坏货一起作废，不再算厂家欠
do $$ declare r jsonb; begin
  insert into t_do values ('r11', pg_temp.mkdo('{"creditor_code":"R11","po_nos":["R11-P1"],"do_no":"R11-1",
    "items":[{"item_code":"A11","shipped":6,"alloc":{"HQ":6}}]}'));
  r := public.ops_po_do_confirm((select id from t_do where k = 'r11'));
  perform public.ops_po_issue_set(array[(pg_temp.iss(r -> 'issues', 'short', 'A11') ->> 'id')::bigint], 'await');
  perform public.ops_po_issue_add(jsonb_build_object('do_id', r -> 'id', 'item_code', 'A11', 'qty', 2));
end $$;
select pg_temp.as_user('pomgr@example.com');
do $$ begin
  perform public.ops_po_do_reopen((select id from t_do where k = 'r11'));
  perform public.ops_po_do_cancel((select id from t_do where k = 'r11'), '厂家搞错');
  assert pg_temp.iss_of('R11') = '' and (pg_temp.cand('R11', array['R11-P1'], 'A11') ->> 'owed')::numeric = 0,
    'S12: ' || pg_temp.iss_of('R11');
end $$;

-- PO 有没货号的行（运费）：照样可以确认，型号清单不列它
do $$ declare r jsonb; begin
  r := public.ops_po_do_confirm(pg_temp.mkdo('{"creditor_code":"R12","po_nos":["R12-P1"],"do_no":"R12-1",
    "items":[{"item_code":"A12","shipped":5,"alloc":{"HQ":5}}]}'));
  assert r ->> 'status' = 'confirmed' and jsonb_array_length(r -> 'candidates') = 1, 'null item_code line: ' || r::text;
end $$;
reset role;

select 'po_do_test ok';
