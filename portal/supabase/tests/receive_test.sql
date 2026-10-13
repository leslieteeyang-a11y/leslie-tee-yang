-- 物流部开厂家到货、仓库部点货测试（20261014_ops_po_receive，接在 po_do_test.sql 之后跑）。
-- 资料：厂家 4000-R100（RECV FACTORY；PO 厂家名称栏写 CS101）
--   RV-P1：6001 RA HQ 10、6002 RA PRE (JB) 5、6003 RB HQ 20、6004 RC SRGADING 8、6005 RD HQ 4
--   RV-P2：6006 RE HQ 10；RV-P3：6007 RF HQ 6；HOMEWORKSSOUTHERN RV-J1：6101 RA 3（整本 = JB）
--   DO-A（RV-P1，ETA 10/22）：RA 15（总部 10 + JB 5）、RB 20、RC 8（总部 6 + Batu 2）、RD 0、对不上的 ZZ-7 1 件（本来应该是 RD）
--   DO-B 草稿；DO-C（货柜 ETA 10/18 = 已过）；DO-F（ETA 10/30，三天外）；今天 = 2026-10-20
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
create or replace function pg_temp.upload(p_name text) returns text language plpgsql security definer as $$
begin
  insert into storage.objects (bucket_id, name) values ('ops-po', p_name);
  return p_name;
end $$;
create or replace function pg_temp.item(p jsonb, p_code text) returns jsonb language sql as $$
  select x from jsonb_array_elements(p) x where x ->> 'item_code' = p_code limit 1
$$;
create or replace function pg_temp.no_price(p jsonb) returns boolean language sql as $$
  select p::text !~* '(price|amt|amount|cost)'
$$;
create or replace function pg_temp.mkdo(p jsonb) returns bigint language plpgsql as $$
begin
  return (public.ops_po_do_save(p) ->> 'id')::bigint;
end $$;
create or replace function pg_temp.cand(p_pos text[], p_item text) returns jsonb language sql as $$
  select pg_temp.item(public.ops_po_do_candidates('HOMEWORKSSB', '4000-R100', p_pos) -> 'items', p_item)
$$;
-- 这个厂家所有没作废的问题：kind:型号/收到的型号=件数（auto 加 *），照建立顺序
create or replace function pg_temp.iss_of(p_cred text) returns text language sql as $$
  select coalesce(string_agg((x ->> 'kind') || ':' || coalesce(x ->> 'item_code', '-') || '/' || (x ->> 'received_code') || '='
                             || (x ->> 'qty') || case when (x ->> 'auto')::boolean then '*' else '' end,
                             ',' order by (x ->> 'id')::bigint), '')
  from jsonb_array_elements(public.ops_po_issues(jsonb_build_object('status', 'all', 'creditor_code', p_cred))) x
$$;
create or replace function pg_temp.do_id(p_key text) returns bigint language sql as $$
  select (current_setting('rcv.' || p_key))::bigint
$$;
create or replace function pg_temp.keep(p_key text, p_id bigint) returns void language plpgsql as $$
begin
  perform set_config('rcv.' || p_key, p_id::text, false);
end $$;
-- 点 DO-A（items / wrong 用 JSON 文字）
create or replace function pg_temp.rcv(p_items text, p_wrong text default '[]') returns jsonb language sql as $$
  select public.ops_po_do_receive(jsonb_build_object('id', pg_temp.do_id('a'), 'items', p_items::jsonb, 'wrong', p_wrong::jsonb))
$$;
create or replace function pg_temp.todo_count() returns int language sql as $$
  select (public.ops_home() ->> 'do_to_count')::int
$$;
grant execute on all functions in schema pg_temp to authenticated, anon;

insert into bi.v_supplier_param values ('HOMEWORKSSB', '4000-R100', 'RECV FACTORY', true, 60),
  ('HOMEWORKSSOUTHERN', '4000-R100', 'RECV FACTORY', true, 60);
insert into bi.dim_item values ('HOMEWORKSSB', 'RA', 'BASIN RA', 'SANITARY', 'HEMOS', 'PCS'),
  ('HOMEWORKSSB', 'RB', 'TAP RB', 'TAP', 'HEMOS', 'PCS'), ('HOMEWORKSSB', 'RC', 'SINK RC', 'SANITARY', 'HEMOS', 'PCS'),
  ('HOMEWORKSSB', 'RD', 'WC RD', 'SANITARY', 'HEMOS', 'SETS'), ('HOMEWORKSSB', 'RE', 'MIRROR RE', 'MIRROR', 'HEMOS', 'PCS'),
  ('HOMEWORKSSB', 'RF', 'SHOWER RF', 'SHOWER', 'HEMOS', 'PCS'), ('HOMEWORKSSOUTHERN', 'RA', 'BASIN RA', 'SANITARY', 'HEMOS', 'PCS');
insert into bi.fact_po_line (company, dtl_key, po_no, po_date, creditor_code, creditor_name, item_code, description,
                             location, uom, qty, transferred_qty, unit_price) values
  ('HOMEWORKSSB', 6001, 'RV-P1', current_date - 30, '4000-R100', 'CS101 RECV', 'RA', 'BASIN RA', 'HQ', 'PCS', 10, 0, 10),
  ('HOMEWORKSSB', 6002, 'RV-P1', current_date - 30, '4000-R100', 'CS101 RECV', 'RA', 'BASIN RA', 'PRE (JB)', 'PCS', 5, 0, 10),
  ('HOMEWORKSSB', 6003, 'RV-P1', current_date - 30, '4000-R100', 'CS101 RECV', 'RB', 'TAP RB', 'HQ', 'PCS', 20, 0, 5),
  ('HOMEWORKSSB', 6004, 'RV-P1', current_date - 30, '4000-R100', 'CS101 RECV', 'RC', 'SINK RC', 'SRGADING', 'PCS', 8, 0, 20),
  ('HOMEWORKSSB', 6005, 'RV-P1', current_date - 30, '4000-R100', 'CS101 RECV', 'RD', 'WC RD', 'HQ', 'SETS', 4, 0, 100),
  ('HOMEWORKSSB', 6006, 'RV-P2', current_date - 20, '4000-R100', 'CS101 RECV', 'RE', 'MIRROR RE', 'HQ', 'PCS', 10, 0, 30),
  ('HOMEWORKSSB', 6007, 'RV-P3', current_date - 20, '4000-R100', 'CS101 RECV', 'RF', 'SHOWER RF', 'HQ', 'PCS', 6, 0, 40),
  ('HOMEWORKSSOUTHERN', 6101, 'RV-J1', current_date - 10, '4000-R100', 'CS101 RECV', 'RA', 'BASIN RA', 'HQ', 'PCS', 3, 0, 10);

-- 0. 物流部 = 订货可编辑（部门预设）；单价规则
do $$ begin
  assert (select level from ops.dept_module where department = 'logistics' and module = 'purchasing') = 'edit', 'logistics purchasing edit';
  assert (select level from ops.dept_module where department = 'warehouse' and module = 'purchasing') = 'view', 'warehouse unchanged';
end $$;

select pg_temp.at('2026-10-20 10:00:00+08');
set role authenticated;
select pg_temp.as_user('boss@example.com');
select public.ops_staff_save('{"email":"logi.r@example.com","name":"物流阿明","department":"logistics","branch":"HOMEWORKSSB","phone":"016-777 1234"}');
select public.ops_staff_save('{"email":"wh.r@example.com","name":"仓库小李","department":"warehouse","branch":"HOMEWORKSSB"}');
select public.ops_staff_save('{"email":"wh.jb@example.com","name":"JB 仓库","department":"warehouse","branch":"HOMEWORKSSOUTHERN"}');
-- 门市员工开了个人例外「仓库可编辑」（帮忙点货）：看不到厂家
select public.ops_staff_save('{"email":"helper@example.com","name":"门市帮手","department":"sales","branch":"HOMEWORKSSB","overrides":{"warehouse":"edit"}}');
-- 物流部主管：订货、仓库都自动升「可审批」，一样看不到单价与库存成本
select public.ops_staff_save('{"email":"logi.boss@example.com","name":"物流主管","department":"logistics","branch":"HOMEWORKSSB","role":"manager"}');
reset role;
do $$ declare s ops.staff; begin
  select * into s from ops.staff where email = 'logi.boss@example.com';
  assert ops.module_level(s, 'purchasing') = 'approve' and ops.module_level(s, 'warehouse') = 'approve', 'logistics manager levels';
  assert ops.sees_supplier(s) and not ops.sees_prices(s) and not ops.sees_cost(s), 'logistics manager: no prices, no cost';
  select * into s from ops.staff where email = 'whmgr@example.com';
  assert ops.sees_cost(s) and not ops.sees_prices(s), 'warehouse manager: cost yes';
  select * into s from ops.staff where email = 'picker@example.com';
  assert not ops.sees_cost(s), 'warehouse edit: no cost';
  select * into s from ops.staff where email = 'logi.r@example.com';
  assert ops.sees_supplier(s) and not ops.sees_prices(s), 'logistics: supplier yes, prices no';
  select * into s from ops.staff where email = 'buyer@example.com';
  assert ops.sees_prices(s), 'buyer prices';
  select * into s from ops.staff where email = 'boss@example.com';
  assert ops.sees_prices(s), 'admin prices';
  select * into s from ops.staff where email = 'wh.r@example.com';
  assert ops.sees_supplier(s) and not ops.sees_prices(s), 'warehouse: supplier yes, prices no';
  select * into s from ops.staff where email = 'helper@example.com';
  assert not ops.sees_supplier(s) and not ops.sees_prices(s), 'helper: neither';
  assert not ops.sees_prices(null::ops.staff) and not ops.sees_cost(null::ops.staff), 'null staff';
end $$;
set role authenticated;

-- 0b. 库存成本：物流部主管（仓库「可审批」）看得到系统数量，看不到平均成本 / 成本差额 / 旧货金额；仓库主管照旧看得到
select pg_temp.as_user('logi.boss@example.com');
do $$ declare w jsonb; c jsonb; g jsonb; begin
  w := public.ops_wh_item('HOMEWORKSSB', 'ST001');
  assert (w ->> 'found')::boolean and not exists (select 1 from jsonb_array_elements(w -> 'stock') x where x -> 'unit_cost' <> 'null'::jsonb),
    'logistics manager: no unit cost: ' || (w -> 'stock')::text;
  c := public.ops_wh_counts('{"status":"all"}');
  assert jsonb_array_length(c) > 0 and (select bool_and(x ? 'system_qty' and not x ? 'unit_cost' and not x ? 'diff_value')
                                        from jsonb_array_elements(c) x), 'logistics manager counts: qty yes, cost no: ' || c::text;
  g := public.ops_wh_aged('{}');
  assert not (g ->> 'show_cost')::boolean and (g ->> 'can_edit')::boolean and g -> 'summary' -> 'both_v' = 'null'::jsonb,
    'logistics manager aged: no cost, can edit';
  assert pg_temp.item(public.ops_po_get('HOMEWORKSSB', 'RV-P1') -> 'items', 'RA') -> 'unit_price' = 'null'::jsonb
     and (select x -> 'open_amt' from jsonb_array_elements(public.ops_po_list('{}')) x where x ->> 'po_no' = 'RV-P1') = 'null'::jsonb,
    'logistics manager: no PO prices';
end $$;
select pg_temp.as_user('whmgr@example.com');
do $$ declare w jsonb; c jsonb; begin
  w := public.ops_wh_item('HOMEWORKSSB', 'ST001');
  assert (select (x ->> 'unit_cost')::numeric from jsonb_array_elements(w -> 'stock') x where x ->> 'location' = 'HQ') = 10,
    'warehouse manager unit cost: ' || (w -> 'stock')::text;
  c := public.ops_wh_counts('{"status":"all"}');
  assert (select bool_and(x ? 'unit_cost' and x ? 'diff_value') from jsonb_array_elements(c) x), 'warehouse manager counts cost';
  assert (public.ops_wh_aged('{}') ->> 'show_cost')::boolean, 'warehouse manager aged cost';
end $$;

-- 1. 物流部：看得到 PO（没有价格）、厂家与 CS 编号；开厂家到货、货柜、确认
select pg_temp.as_user('logi.r@example.com');
select pg_temp.upload('HOMEWORKSSB/2026-10/rv0001.pdf');
do $$ declare me jsonb := public.ops_me(); l jsonb; g jsonb; s jsonb; c jsonb; r jsonb; v bigint; sh jsonb; begin
  assert exists (select 1 from jsonb_array_elements(me -> 'modules') x where x ->> 'key' = 'purchasing' and x ->> 'level' = 'edit'),
    'logistics purchasing edit';
  l := (select x from jsonb_array_elements(public.ops_po_list('{}')) x where x ->> 'po_no' = 'RV-P1');
  assert l is not null and l -> 'open_amt' = 'null'::jsonb and l ->> 'supplier_name' = 'RECV FACTORY', 'logistics po list no amount: ' || coalesce(l::text, 'null');
  g := public.ops_po_get('HOMEWORKSSB', 'RV-P1');
  assert g -> 'open_amt' = 'null'::jsonb and (g ->> 'can_edit')::boolean
     and (select bool_and(x -> 'unit_price' = 'null'::jsonb and x -> 'open_amt' = 'null'::jsonb) from jsonb_array_elements(g -> 'items') x),
    'logistics po get no prices: ' || g::text;
  s := (select x from jsonb_array_elements(public.ops_po_do_suppliers()) x where x ->> 'creditor_code' = '4000-R100');
  assert s -> 'factories' = '["CS101"]'::jsonb and (s ->> 'po_count')::int = 3, 'logistics sees supplier + CS: ' || coalesce(s::text, 'null');
  c := public.ops_po_do_candidates('', '4000-R100', array['RV-P1']);
  assert jsonb_array_length(c -> 'outlets') = 4 and jsonb_array_length(c -> 'items') = 4 and pg_temp.no_price(c), 'candidates: ' || c::text;
  assert public.ops_po_file_ok('HOMEWORKSSB/2026-10/rv0001.pdf', true), 'logistics can upload';

  v := pg_temp.mkdo('{"creditor_code":"4000-R100","po_nos":["RV-P1"],"do_no":"RV-0001","do_date":"2026-10-15","eta":"2026-10-22",
    "files":[{"path":"HOMEWORKSSB/2026-10/rv0001.pdf","name":"RV-0001.pdf","size":2048,"type":"application/pdf"}],
    "items":[{"item_code":"RA","shipped":15,"alloc":{"HQ":10,"JB":5}},
             {"item_code":"RB","shipped":20,"alloc":{"HQ":20}},
             {"item_code":"RC","shipped":8,"alloc":{"HQ":6,"BATU":2}},
             {"item_code":"RD","shipped":0,"alloc":{}},
             {"src_code":"ZZ-7","src_desc":"WRONG TAP","shipped":1,"expected_code":"RD"}]}');
  perform pg_temp.keep('a', v);
  r := public.ops_po_do_confirm(v);
  assert r ->> 'status' = 'confirmed' and r ->> 'confirmed_by_name' = '物流阿明', 'logistics confirmed: ' || r::text;
  assert pg_temp.iss_of('4000-R100') = 'short:RD/=4*,wrong:RD/ZZ-7=1*', 'confirm issues: ' || pg_temp.iss_of('4000-R100');

  perform pg_temp.keep('b', pg_temp.mkdo('{"creditor_code":"4000-R100","po_nos":["RV-P2"],"do_no":"RV-DRAFT",
    "items":[{"item_code":"RE","shipped":1,"alloc":{"HQ":1}}]}'));
  sh := public.ops_shipment_save('{"company":"HOMEWORKSSB","name":"RV-CTN","eta":"2026-10-18"}');
  v := pg_temp.mkdo(jsonb_build_object('creditor_code', '4000-R100', 'po_nos', '["RV-P2"]'::jsonb, 'do_no', 'RV-0002',
         'eta', '2026-11-30', 'shipment_id', sh -> 'id', 'items', '[{"item_code":"RE","shipped":10,"alloc":{"HQ":10}}]'::jsonb));
  perform pg_temp.keep('c', v);
  perform public.ops_po_do_confirm(v);
  v := pg_temp.mkdo('{"creditor_code":"4000-R100","po_nos":["RV-P3"],"do_no":"RV-0003","eta":"2026-10-30",
    "items":[{"item_code":"RF","shipped":6,"alloc":{"HQ":6}}]}');
  perform pg_temp.keep('f', v);
  perform public.ops_po_do_confirm(v);
  assert (public.ops_po_transit() ->> 'full')::boolean, 'logistics transit full';
  assert jsonb_array_length(public.ops_po_issues('{"creditor_code":"4000-R100"}')) = 2, 'logistics sees issues';
end $$;
-- 采购、管理层照样看得到金额
select pg_temp.as_user('buyer@example.com');
do $$ declare l jsonb; begin
  l := (select x from jsonb_array_elements(public.ops_po_list('{}')) x where x ->> 'po_no' = 'RV-P1');
  assert (l ->> 'open_amt')::numeric = 10 * 15 + 5 * 20 + 20 * 8 + 100 * 4, 'buyer sees amount: ' || l::text;
  assert (pg_temp.item(public.ops_po_get('HOMEWORKSSB', 'RV-P1') -> 'items', 'RB') ->> 'unit_price')::numeric = 5, 'buyer unit price';
  -- 货还在路上时采购先记了 RB 坏货 1 件（厂家拍照说的）
  perform public.ops_po_issue_add(jsonb_build_object('do_id', pg_temp.do_id('a'), 'item_code', 'RB', 'qty', 1, 'note', '厂家说破了一个'));
end $$;
select pg_temp.as_user('boss@example.com');
do $$ begin
  assert (select (x ->> 'open_amt')::numeric from jsonb_array_elements(public.ops_po_list('{}')) x where x ->> 'po_no' = 'RV-P1') = 810,
    'admin sees amount';
end $$;

-- 2. 不能再直接「标记到货」
select pg_temp.as_user('logi.r@example.com');
select pg_temp.expect_error(format('select public.ops_po_do_arrive(%s)', pg_temp.do_id('a')), '要先点货');
select pg_temp.as_user('wh.r@example.com');
select pg_temp.expect_error(format('select public.ops_po_do_arrive(%s, %L)', pg_temp.do_id('a'), 'x'), '要先点货');
select pg_temp.as_user('hqsales@example.com');
select pg_temp.expect_error(format('select public.ops_po_do_arrive(%s)', pg_temp.do_id('a')), '才能标记到货');

-- 3. 首页：三天内到（含已过 ETA）、还没点货
select pg_temp.as_user('hqsales@example.com');
do $$ begin assert public.ops_home() -> 'do_to_count' = 'null'::jsonb, 'sales: no do_to_count'; end $$;
select pg_temp.as_user('wh.jb@example.com');
do $$ begin assert pg_temp.todo_count() = 0, 'JB warehouse: HQ DOs not counted'; end $$;
select pg_temp.as_user('wh.r@example.com');
do $$ begin
  -- DO-C（货柜 10/18，已过）+ DO-A（10/22）；DO-F（10/30）不算、草稿不算
  assert pg_temp.todo_count() = 2, 'warehouse do_to_count: ' || (public.ops_home() ->> 'do_to_count');
end $$;
-- 物流阿明三张都是自己确认的（不能自己点）：不提醒；三张都有 ETA → 不算进 do_no_eta（前面的测试留下一些没 ETA 的，记下基数）
select pg_temp.as_user('logi.r@example.com');
do $$ declare h jsonb := public.ops_home(); begin
  assert pg_temp.todo_count() = 0 and (h ->> 'do_no_eta')::int >= 0, 'logistics home: ' || h::text;
  perform pg_temp.keep('noeta', (h ->> 'do_no_eta')::bigint);
  assert h -> 'po_issues_todo' = 'null'::jsonb, 'logistics: no supplier-issue reminder';
end $$;
select pg_temp.as_user('logi.boss@example.com');
do $$ begin assert pg_temp.todo_count() = 2, 'logistics manager (did not confirm) do_to_count'; end $$;
select pg_temp.as_user('wh.r@example.com');
do $$ declare h jsonb := public.ops_home(); begin
  assert h -> 'do_no_eta' = 'null'::jsonb and h -> 'po_issues_todo' = 'null'::jsonb, 'warehouse home: ' || h::text;
end $$;

-- 4. 点货清单与明细（仓库部）
select pg_temp.as_user('wh.r@example.com');
do $$ declare l jsonb; a jsonb; c jsonb; g jsonb; it jsonb; begin
  l := public.ops_po_receive_list();
  assert (l -> 'todo' -> 0 ->> 'id')::bigint = pg_temp.do_id('c') and (l -> 'todo' -> 1 ->> 'id')::bigint = pg_temp.do_id('a')
     and (l -> 'todo' -> 2 ->> 'id')::bigint = pg_temp.do_id('f'), 'todo order by ETA: ' || (l -> 'todo')::text;
  assert not exists (select 1 from jsonb_array_elements(l -> 'todo') x where (x ->> 'id')::bigint = pg_temp.do_id('b')), 'draft not in todo';
  assert not exists (select 1 from jsonb_array_elements(l -> 'todo') x where x ->> 'status' <> 'confirmed'), 'todo = confirmed only';
  c := l -> 'todo' -> 0;
  assert c ->> 'eta' = '2026-10-18' and c ->> 'eta_source' = 'shipment' and c ->> 'shipment_name' = 'RV-CTN'
     and (c ->> 'overdue')::boolean, 'DO-C: ' || c::text;
  a := l -> 'todo' -> 1;
  assert a ->> 'do_no' = 'RV-0001' and a ->> 'supplier_name' = 'RECV FACTORY' and a ->> 'creditor_code' = '4000-R100'
     and a ->> 'company' = 'HOMEWORKSSB' and a ->> 'eta' = '2026-10-22' and a ->> 'eta_source' = 'do' and not (a ->> 'overdue')::boolean
     and a -> 'po_nos' = '["RV-P1"]'::jsonb and (a ->> 'item_count')::int = 3 and (a ->> 'unmatched_count')::int = 1
     and (a ->> 'shipped_total')::numeric = 44 and a -> 'outlets' = '["HQ","BATU","JB"]'::jsonb
     and a -> 'summary' = 'null'::jsonb and a -> 'arrived_at' = 'null'::jsonb and a ->> 'do_date' = '2026-10-15', 'DO-A row: ' || a::text;
  assert pg_temp.no_price(l), 'list no prices';
  assert jsonb_array_length(public.ops_po_receive_list('{"company":"HOMEWORKSSOUTHERN"}') -> 'todo') = 0, 'company filter';

  g := public.ops_po_receive_get(pg_temp.do_id('a'));
  assert g ->> 'status' = 'confirmed' and (g ->> 'can_receive')::boolean and g -> 'receipt' = 'null'::jsonb
     and g ->> 'confirmed_by_name' = '物流阿明' and g -> 'alloc_outlets' = '["HQ","BATU","JB"]'::jsonb, 'get header: ' || g::text;
  assert (select string_agg(x ->> 'code', ',') from jsonb_array_elements(g -> 'outlets') x) = 'HQ,BATU,JB,PUCHONG', 'four outlets';
  assert (select string_agg(x ->> 'item_code', ',') from jsonb_array_elements(g -> 'items') x) = 'RA,RB,RC', 'items (RD shipped 0 left out)';
  it := pg_temp.item(g -> 'items', 'RA');
  assert it -> 'alloc' = '{"HQ":10,"JB":5}'::jsonb and (it ->> 'shipped')::numeric = 15 and it ->> 'description' = 'BASIN RA'
     and it ->> 'uom' = 'PCS' and it -> 'prior' = '{"damaged":0,"short":0,"over":0,"wrong":0}'::jsonb, 'RA: ' || it::text;
  assert pg_temp.item(g -> 'items', 'RB') -> 'prior' = '{"damaged":1,"short":0,"over":0,"wrong":0}'::jsonb, 'RB prior damaged';
  assert pg_temp.item(g -> 'items', 'RC') -> 'alloc' = '{"HQ":6,"BATU":2}'::jsonb, 'RC alloc';
  assert jsonb_array_length(g -> 'unmatched') = 1 and g -> 'unmatched' -> 0 ->> 'src_code' = 'ZZ-7'
     and g -> 'unmatched' -> 0 ->> 'expected_code' = 'RD' and (g -> 'unmatched' -> 0 ->> 'shipped')::numeric = 1, 'unmatched';
  assert jsonb_array_length(g -> 'files') = 1 and g -> 'files' -> 0 ->> 'path' = 'HOMEWORKSSB/2026-10/rv0001.pdf', 'files';
  assert (select string_agg((x ->> 'kind') || ':' || (x ->> 'auto') || ':' || (x ->> 'from_receipt'), ',' order by (x ->> 'id')::bigint)
          from jsonb_array_elements(g -> 'issues') x) = 'short:true:false,wrong:true:false,damaged:false:false', 'issues: ' || (g -> 'issues')::text;
  assert pg_temp.no_price(g), 'get no prices';
  -- 仓库看得到厂家 DO 附件，不能上传
  assert public.ops_po_file_ok('HOMEWORKSSB/2026-10/rv0001.pdf', false) and not public.ops_po_file_ok('HOMEWORKSSB/2026-10/x.pdf', true),
    'warehouse read yes, write no';
  -- 仓库没有订货「可编辑」：厂家问题清单、DO 编辑画面照旧打不开
end $$;
select pg_temp.expect_error($q$select public.ops_po_issues('{}')$q$, '编辑权限');
select pg_temp.expect_error(format('select public.ops_po_do_get(%s)', pg_temp.do_id('a')), '编辑权限');
-- 物流部也能看点货明细；但这张是物流阿明自己确认的：不能自己点（物流部记、仓库部点）
select pg_temp.as_user('logi.r@example.com');
do $$ declare g jsonb := public.ops_po_receive_get(pg_temp.do_id('a')); begin
  assert not (g ->> 'can_receive')::boolean and (g ->> 'self_confirmed')::boolean and g ->> 'status' = 'confirmed', 'self confirmed: ' || g::text;
  assert (public.ops_po_receive_list() -> 'todo' -> 1 ->> 'self_confirmed')::boolean, 'list self_confirmed';
  assert not (public.ops_po_do_get(pg_temp.do_id('a')) ->> 'can_arrive')::boolean
     and (public.ops_po_do_get(pg_temp.do_id('a')) ->> 'confirmed_by_me')::boolean, 'do_get: no receive button for confirmer';
end $$;
select pg_temp.expect_error($q$select pg_temp.rcv('[{"item_code":"RA","received":15,"alloc":{"HQ":10,"JB":5}},
  {"item_code":"RB","received":20,"alloc":{"HQ":20}},{"item_code":"RC","received":8,"alloc":{"HQ":6,"BATU":2}}]')$q$,
  '这张厂家 DO 是你确认的');
select pg_temp.as_user('logi.boss@example.com');
do $$ declare g jsonb := public.ops_po_receive_get(pg_temp.do_id('a')); begin
  assert (g ->> 'can_receive')::boolean and not (g ->> 'self_confirmed')::boolean, 'another logistics person can receive';
  assert (public.ops_po_do_get(pg_temp.do_id('a')) ->> 'can_arrive')::boolean, 'do_get: receive button for others';
end $$;
-- 门市帮手（个人例外仓库可编辑）：可以点，但看不到厂家、DO 号、PO 号、货柜、附件
select pg_temp.as_user('helper@example.com');
do $$ declare l jsonb; g jsonb; begin
  l := public.ops_po_receive_list();
  g := public.ops_po_receive_get(pg_temp.do_id('a'));
  assert (select bool_and(x -> 'supplier_name' = 'null'::jsonb and x -> 'do_no' = 'null'::jsonb and x -> 'creditor_code' = 'null'::jsonb
                          and x -> 'po_nos' = '[]'::jsonb and x -> 'shipment_name' = 'null'::jsonb)
          from jsonb_array_elements(l -> 'todo') x), 'helper list masked: ' || l::text;
  assert g -> 'supplier_name' = 'null'::jsonb and g -> 'files' = '[]'::jsonb and g ->> 'remark' = ''
     and jsonb_array_length(g -> 'items') = 3, 'helper get masked: ' || g::text;
  assert not public.ops_po_file_ok('HOMEWORKSSB/2026-10/rv0001.pdf', false), 'helper cannot read supplier files';
end $$;
-- 门市员工（只看）：不能点货
select pg_temp.as_user('hqsales@example.com');
select pg_temp.expect_error($q$select public.ops_po_receive_list()$q$, '才能点货');
select pg_temp.expect_error(format('select public.ops_po_receive_get(%s)', pg_temp.do_id('a')), '找不到这张厂家 DO');
select pg_temp.expect_error(format($q$select public.ops_po_do_receive('{"id":%s,"items":[]}')$q$, pg_temp.do_id('a')), '才能点货');
select pg_temp.expect_error(format($q$select public.ops_po_issue_add('{"do_id":%s,"item_code":"RA","qty":1}')$q$, pg_temp.do_id('a')),
  '才能记厂家问题');
do $$ begin assert not public.ops_po_file_ok('HOMEWORKSSB/2026-10/rv0001.pdf', false), 'sales cannot read'; end $$;
-- JB 的仓库：货到总部仓库，JB 的人不点总部的 DO
select pg_temp.as_user('wh.jb@example.com');
do $$ begin
  assert jsonb_array_length(public.ops_po_receive_list() -> 'todo') = 0, 'JB warehouse sees no HQ DO';
  assert not public.ops_po_file_ok('HOMEWORKSSB/2026-10/rv0001.pdf', false), 'JB warehouse cannot read HQ files';
end $$;
select pg_temp.expect_error(format('select public.ops_po_receive_get(%s)', pg_temp.do_id('a')), '找不到这张厂家 DO');
select pg_temp.expect_error(format($q$select public.ops_po_do_receive('{"id":%s,"items":[]}')$q$, pg_temp.do_id('a')), '找不到这张厂家 DO');
select pg_temp.expect_error(format($q$select public.ops_po_issue_add('{"do_id":%s,"item_code":"RA","qty":1}')$q$, pg_temp.do_id('a')),
  '找不到这张厂家 DO');

-- 5. 点货：检查（失败都不会留下任何东西）
select pg_temp.as_user('wh.r@example.com');
select pg_temp.expect_error($q$select public.ops_po_do_receive('[]')$q$, '资料格式不对');
select pg_temp.expect_error($q$select public.ops_po_do_receive('{"id":999999999,"items":[]}')$q$, '找不到这张厂家 DO');
select pg_temp.expect_error(format($q$select public.ops_po_do_receive('{"id":%s,"items":{}}')$q$, pg_temp.do_id('a')), '资料格式不对');
select pg_temp.expect_error(format($q$select public.ops_po_do_receive('{"id":%s,"items":[]}')$q$, pg_temp.do_id('b')),
  '还没确认的 DO 不能点货');
select pg_temp.expect_error($q$select pg_temp.rcv('[{"item_code":"RA","received":15,"alloc":{"HQ":10,"JB":4}},
  {"item_code":"RB","received":20,"alloc":{"HQ":20}},{"item_code":"RC","received":8,"alloc":{"HQ":8}}]')$q$,
  '型号 RA 好货 15 件，分到各分店合计 14 件：要相等。');
select pg_temp.expect_error($q$select pg_temp.rcv('[{"item_code":"RA","received":15,"alloc":{"HQ":15}},
  {"item_code":"RB","received":20,"damaged":-1,"alloc":{"HQ":20}},{"item_code":"RC","received":8,"alloc":{"HQ":8}}]')$q$,
  '型号 RB 的坏货数量不能是负数');
select pg_temp.expect_error($q$select pg_temp.rcv('[{"item_code":"RA","received":"x","alloc":{"HQ":15}}]')$q$, '型号 RA 的好货数量不是数字');
select pg_temp.expect_error($q$select pg_temp.rcv('[{"item_code":"RA","alloc":{"HQ":15}}]')$q$, '型号 RA 请填好货收到几件');
select pg_temp.expect_error($q$select pg_temp.rcv('[{"item_code":"RA","received":15,"alloc":{"HQ":20,"JB":-5}}]')$q$,
  '型号 RA 分到 JB 的数量不能是负数');
select pg_temp.expect_error($q$select pg_temp.rcv('[{"item_code":"RA","received":15,"alloc":{"HQ":15}},
  {"item_code":"RB","received":20,"alloc":{"HQ":20}}]')$q$, '型号 RC 还没填点货数量');
select pg_temp.expect_error($q$select pg_temp.rcv('[]')$q$, '型号 RA、RB、RC 还没填点货数量');
select pg_temp.expect_error($q$select pg_temp.rcv('[{"item_code":"RA","received":15,"alloc":{"HQ":15}},
  {"item_code":"XX","received":1,"alloc":{"HQ":1}}]')$q$, '型号 XX 不是这张 DO 要点的货');
select pg_temp.expect_error($q$select pg_temp.rcv('[{"item_code":"RD","received":1,"alloc":{"HQ":1}}]')$q$, '型号 RD 不是这张 DO 要点的货');
select pg_temp.expect_error($q$select pg_temp.rcv('[{"item_code":"RA","received":15,"alloc":{"HQ":15}},
  {"item_code":"ra","received":15,"alloc":{"HQ":15}}]')$q$, '型号 RA 重复了');
select pg_temp.expect_error($q$select pg_temp.rcv('[{"item_code":"RA","received":15,"alloc":{"MARS":15}}]')$q$, '没有这个分店：MARS');
select pg_temp.expect_error($q$select pg_temp.rcv('[{"item_code":"RA","received":15,"alloc":{"HQ":15}},
  {"item_code":"RB","received":20,"alloc":{"HQ":20}},{"item_code":"RC","received":8,"alloc":{"HQ":8}}]',
  '[{"received_code":"","description":"NO LABEL","qty":1}]')$q$, '来错的货第 1 行请填收到的型号或备注');
select pg_temp.expect_error($q$select pg_temp.rcv('[{"item_code":"RA","received":15,"alloc":{"HQ":15}},
  {"item_code":"RB","received":20,"alloc":{"HQ":20}},{"item_code":"RC","received":8,"alloc":{"HQ":8}}]',
  '[{"received_code":"QQ-1","qty":1},{"received_code":"QQ-2","qty":0}]')$q$, '来错的货第 2 行请填数量');
select pg_temp.expect_error($q$select pg_temp.rcv('[{"item_code":"RA","received":15,"alloc":{"HQ":15}},
  {"item_code":"RB","received":20,"alloc":{"HQ":20}},{"item_code":"RC","received":8,"alloc":{"HQ":8}}]',
  '[{"received_code":"QQ-1","qty":"x"}]')$q$, '来错的货第 1 行的数量不是数字');
select pg_temp.expect_error($q$select pg_temp.rcv('[{"item_code":"RA","received":15,"alloc":{"HQ":15}},
  {"item_code":"RB","received":20,"alloc":{"HQ":20}},{"item_code":"RC","received":8,"alloc":{"HQ":8}}]',
  '[{"received_code":"QQ-1","qty":1,"expected_code":"NOPE"}]')$q$, '「本来应该是」的型号 NOPE 不是这张 DO 的型号');
do $$ begin
  assert public.ops_po_receive_get(pg_temp.do_id('a')) ->> 'status' = 'confirmed', 'still confirmed after failures';
  assert pg_temp.todo_count() = 2, 'still 2 to count';
end $$;
select pg_temp.as_user('buyer@example.com');
do $$ declare b jsonb; begin
  assert pg_temp.iss_of('4000-R100') = 'short:RD/=4*,wrong:RD/ZZ-7=1*,damaged:RB/=1', 'no issues from failures: ' || pg_temp.iss_of('4000-R100');
  -- 点货前：RB 在路上 20 − 已记坏货 1 = 19 → 还可以出 1；RC 8 在路上
  b := pg_temp.cand(array['RV-P1'], 'RB');
  assert (b ->> 'in_transit')::numeric = 19 and (b ->> 'remaining')::numeric = 1, 'RB before receipt: ' || b::text;
  assert (pg_temp.cand(array['RV-P1'], 'RC') ->> 'in_transit')::numeric = 8, 'RC before';
end $$;

-- 6. 点货：RA 全到但分配改了；RB 少 2 坏 1（坏货 1 采购已记过，不重复）；RC 多 1；来错的货
select pg_temp.as_user('wh.r@example.com');
do $$ declare r jsonb; it jsonb; begin
  r := public.ops_po_do_receive(jsonb_build_object('id', pg_temp.do_id('a'), 'note', '外箱压坏一个',
    'items', '[{"item_code":"ra","received":15,"damaged":0,"alloc":{"HQ":11,"JB":4,"BATU":0}},
               {"item_code":"RB","received":"17","damaged":1,"alloc":{"HQ":17},"note":"少两个"},
               {"item_code":"RC","received":9,"alloc":{"HQ":7,"BATU":2},"note":"多一个"}]'::jsonb,
    'wrong', '[{"received_code":"zz-7","description":"WRONG TAP","expected_code":"rd","qty":1,"note":"跟 DO 一样"},
               {"received_code":"QQ-1","description":"MIRROR QQ","expected_code":"rb","qty":2,"note":"混在 RB 箱里"},
               {"received_code":"","description":"","note":"一箱没有标签","qty":1},
               {"received_code":"","description":"","qty":"","note":""}]'::jsonb));
  assert r ->> 'status' = 'arrived' and not (r ->> 'can_receive')::boolean and r ->> 'arrived_by_name' = '仓库小李'
     and r ->> 'arrive_note' = '外箱压坏一个' and r -> 'arrived_at' <> 'null'::jsonb, 'arrived: ' || r::text;
  assert jsonb_array_length(r -> 'receipt' -> 'items') = 3 and jsonb_array_length(r -> 'receipt' -> 'wrong') = 3
     and r -> 'receipt' ->> 'note' = '外箱压坏一个' and jsonb_array_length(r -> 'receipt' -> 'issue_ids') = 4, 'receipt: ' || (r -> 'receipt')::text;
  it := pg_temp.item(r -> 'receipt' -> 'items', 'RA');
  assert it -> 'alloc' = '{"HQ":11,"JB":4}'::jsonb and it -> 'planned' = '{"HQ":10,"JB":5}'::jsonb and (it ->> 'received')::numeric = 15
     and (it ->> 'damaged')::numeric = 0 and (it ->> 'shipped')::numeric = 15 and it ->> 'description' = 'BASIN RA', 'RA receipt: ' || it::text;
  it := pg_temp.item(r -> 'receipt' -> 'items', 'RB');
  assert (it ->> 'received')::numeric = 17 and (it ->> 'damaged')::numeric = 1 and it ->> 'note' = '少两个'
     and it -> 'prior' = '{"damaged":1,"short":0}'::jsonb, 'RB receipt: ' || it::text;
  assert r -> 'receipt' -> 'wrong' -> 0 ->> 'expected_code' = 'RD' and r -> 'receipt' -> 'wrong' -> 1 ->> 'expected_code' = 'RB'
     and r -> 'receipt' -> 'wrong' -> 2 -> 'expected_code' = 'null'::jsonb, 'wrong rows normalized';
  assert pg_temp.item(r -> 'items', 'RB') -> 'prior' = '{"damaged":1,"short":2,"over":0,"wrong":2}'::jsonb, 'RB prior after: ' || r::text;
  assert (select count(*) from jsonb_array_elements(r -> 'issues') x where (x ->> 'from_receipt')::boolean) = 4, 'from_receipt flags';
  assert pg_temp.no_price(r), 'no prices';
end $$;
select pg_temp.expect_error(format($q$select public.ops_po_do_receive('{"id":%s,"items":[]}')$q$, pg_temp.do_id('a')),
  '这张 DO 已经点过货了（仓库小李 · ');
select pg_temp.expect_error(format('select public.ops_po_do_arrive(%s)', pg_temp.do_id('a')), '要先点货');
do $$ declare l jsonb; d jsonb; begin
  l := public.ops_po_receive_list();
  assert not exists (select 1 from jsonb_array_elements(l -> 'todo') x where (x ->> 'id')::bigint = pg_temp.do_id('a')), 'not todo';
  d := (select x from jsonb_array_elements(l -> 'done') x where (x ->> 'id')::bigint = pg_temp.do_id('a'));
  assert d ->> 'arrived_by_name' = '仓库小李'
     and d -> 'summary' = '{"short":2,"damaged":1,"over":1,"wrong":4,"mismatch":0,"later":{"damaged":0,"short":0,"wrong":0}}'::jsonb
     and d ->> 'status' = 'arrived', 'done row: ' || coalesce(d::text, l::text);
  assert pg_temp.todo_count() = 1, 'one left to count (DO-C)';
  -- 在路上不再列这张
  assert not exists (select 1 from jsonb_array_elements(public.ops_po_transit() -> 'rows') x
                     where (x ->> 'do_id')::bigint = pg_temp.do_id('a')), 'arrived leaves transit';
  -- 点完货才发现的坏货：仓库也能记
  d := public.ops_po_issue_add(jsonb_build_object('do_id', pg_temp.do_id('a'), 'item_code', 'RA', 'qty', 1, 'note', '搬的时候摔破'));
  assert d ->> 'kind' = 'damaged' and d ->> 'supplier_name' = 'RECV FACTORY' and not (d ->> 'auto')::boolean, 'warehouse issue_add: ' || d::text;
  -- 点完货之后补记的：清单摘要 later、明细 after_receipt
  d := (select x from jsonb_array_elements(public.ops_po_receive_list() -> 'done') x where (x ->> 'id')::bigint = pg_temp.do_id('a'));
  assert d -> 'summary' -> 'later' = '{"damaged":1,"short":0,"wrong":0}'::jsonb, 'later in summary: ' || d::text;
  assert (select string_agg((x ->> 'from_receipt') || '/' || (x ->> 'after_receipt'), ',' order by (x ->> 'id')::bigint)
          from jsonb_array_elements(public.ops_po_receive_get(pg_temp.do_id('a')) -> 'issues') x)
         = 'false/false,false/false,false/false,true/false,true/false,true/false,true/false,false/true', 'issue flags';
end $$;
-- 门市帮手记问题：只回精简结果（没有厂家）
select pg_temp.as_user('helper@example.com');
do $$ declare d jsonb; begin
  d := public.ops_po_issue_add(jsonb_build_object('do_id', pg_temp.do_id('a'), 'kind', 'wrong', 'received_code', 'PP-9', 'qty', 1));
  assert d ->> 'kind' = 'wrong' and not d ? 'supplier_name' and not d ? 'po_nos', 'helper slim issue: ' || d::text;
end $$;

-- 7. 厂家问题（采购）：到货少 / 坏货 / 多到 / 来错；在路上把到货少、坏货算回来
select pg_temp.as_user('buyer@example.com');
do $$ declare s jsonb; b jsonb; r jsonb; v bigint; begin
  assert pg_temp.iss_of('4000-R100') = 'short:RD/=4*,wrong:RD/ZZ-7=1*,damaged:RB/=1,short:RB/=2,over:RC/=1,wrong:RB/QQ-1=2,wrong:-/=1,'
                                       || 'damaged:RA/=1,wrong:-/PP-9=1', 'issues: ' || pg_temp.iss_of('4000-R100');
  s := (select x from jsonb_array_elements(public.ops_po_issues('{"creditor_code":"4000-R100","kind":"short"}')) x where x ->> 'item_code' = 'RB');
  assert (s ->> 'ordered')::numeric = 20 and (s ->> 'received')::numeric = 18 and s ->> 'decision' = 'pending' and s ->> 'note' = '少两个'
     and s ->> 'do_no' = 'RV-0001' and s -> 'po_nos' = '["RV-P1"]'::jsonb and s ->> 'created_by_name' = '仓库小李', 'RB short: ' || s::text;
  s := (select x from jsonb_array_elements(public.ops_po_issues('{"creditor_code":"4000-R100","kind":"wrong"}')) x
        where x ->> 'received_code' = '' and x -> 'item_code' = 'null'::jsonb);
  assert s ->> 'note' = '一箱没有标签' and (s ->> 'qty')::numeric = 1, 'note-only wrong: ' || coalesce(s::text, 'null');
  -- 在路上：RB 20 − 坏 1 − 少 2 = 17 → 还可以出 3；RC 多到不影响；RA 摔破 1 → 在路上 14
  b := pg_temp.cand(array['RV-P1'], 'RB');
  assert (b ->> 'in_transit')::numeric = 17 and (b ->> 'remaining')::numeric = 3 and (b ->> 'owed')::numeric = 3, 'RB after: ' || b::text;
  assert (pg_temp.cand(array['RV-P1'], 'RC') ->> 'in_transit')::numeric = 8, 'RC over does not change transit';
  -- RA：点货时 JB 少分 1（总部多 1）、之后摔破 1 → 还可以出的 1 落在 JB 的 PO 行（点货时被减的分店），不是最早的总部行
  b := pg_temp.cand(array['RV-P1'], 'RA');
  assert (b ->> 'remaining')::numeric = 1 and (b -> 'by_outlet' -> 'JB' ->> 'remaining')::numeric = 1
     and coalesce((b -> 'by_outlet' -> 'HQ' ->> 'remaining')::numeric, 0) = 0, 'RA damaged after receipt counted back on JB: ' || b::text;
  -- 厂家补 RB 3 件：补到货少 2（自动结案），不算多发
  v := pg_temp.mkdo('{"creditor_code":"4000-R100","po_nos":["RV-P1"],"do_no":"RV-0004","items":[{"item_code":"RB","shipped":3,"alloc":{"HQ":3}}]}');
  r := public.ops_po_do_confirm(v);
  assert jsonb_array_length(r -> 'issues') = 0, 'replacement not over: ' || (r -> 'issues')::text;
  s := (select x from jsonb_array_elements(public.ops_po_issues('{"status":"all","creditor_code":"4000-R100","kind":"short"}')) x
        where x ->> 'item_code' = 'RB');
  assert s ->> 'status' = 'resolved' and (s ->> 'resolved_qty')::numeric = 2 and s -> 'resolutions' -> 0 ->> 'do_no' = 'RV-0004',
    'receipt short filled by next DO: ' || s::text;
  -- 采购看整张 DO：带点货纪录
  r := public.ops_po_do_get(pg_temp.do_id('a'));
  assert r ->> 'status' = 'arrived' and jsonb_array_length(r -> 'receipt' -> 'items') = 3 and not (r ->> 'can_reopen')::boolean, 'do_get receipt';
end $$;
select pg_temp.as_user('pomgr@example.com');
select pg_temp.expect_error(format('select public.ops_po_do_reopen(%s)', pg_temp.do_id('a')), '已到货的 DO 不能退回草稿');
-- 点过货的 DO：物流部（订货可编辑）不能把厂家问题作废；采购可以
select pg_temp.as_user('logi.r@example.com');
select pg_temp.expect_error($q$select public.ops_po_issue_set(array[(select (x ->> 'id')::bigint
  from jsonb_array_elements(public.ops_po_issues('{"creditor_code":"4000-R100","kind":"wrong"}')) x where x ->> 'received_code' = 'PP-9')],
  'void', '搞错了')$q$, '点过货的厂家 DO，厂家问题只有采购或管理层可以作废');
do $$ begin
  -- 已处理 / 备注照旧可以
  assert public.ops_po_issue_set(array[(select (x ->> 'id')::bigint
    from jsonb_array_elements(public.ops_po_issues('{"creditor_code":"4000-R100","kind":"wrong"}')) x where x ->> 'received_code' = 'PP-9')],
    'note', '已拍照') = 1, 'logistics can still add a note';
end $$;
select pg_temp.as_user('buyer@example.com');
do $$ begin
  assert public.ops_po_issue_set(array[(select (x ->> 'id')::bigint
    from jsonb_array_elements(public.ops_po_issues('{"creditor_code":"4000-R100","kind":"wrong"}')) x where x ->> 'received_code' = 'PP-9')],
    'void', '门市帮手记错') = 1, 'buyer can void';
end $$;

-- 8. JB 自己的 DO：JB 采购开、JB 仓库点
select pg_temp.as_user('jbbuyer@example.com');
-- JB 账套的货只能分给 JB（存草稿就挡；触发器）
select pg_temp.expect_error($q$select pg_temp.mkdo('{"creditor_code":"4000-R100","po_nos":["RV-J1"],"do_no":"RV-J-X",
  "items":[{"item_code":"RA","shipped":3,"alloc":{"HQ":2,"PUCHONG":1}}]}')$q$, 'JB 账套的货只能分给 JB（不能分给 总部、Puchong）。');
do $$ declare v bigint; begin
  v := pg_temp.mkdo('{"creditor_code":"4000-R100","po_nos":["RV-J1"],"do_no":"RV-J-1","eta":"2026-10-21",
    "items":[{"item_code":"RA","shipped":3,"alloc":{"JB":3}}]}');
  perform pg_temp.keep('j', v);
  perform public.ops_po_do_confirm(v);
end $$;
select pg_temp.as_user('wh.jb@example.com');
do $$ declare l jsonb; r jsonb; begin
  assert pg_temp.todo_count() = 1, 'JB warehouse counts JB DO';
  l := public.ops_po_receive_list();
  assert jsonb_array_length(l -> 'todo') = 1 and (l -> 'todo' -> 0 ->> 'id')::bigint = pg_temp.do_id('j')
     and l -> 'todo' -> 0 ->> 'company' = 'HOMEWORKSSOUTHERN' and l -> 'todo' -> 0 -> 'outlets' = '["JB"]'::jsonb, 'JB todo: ' || l::text;
  assert not exists (select 1 from jsonb_array_elements(l -> 'done') x where x ->> 'company' <> 'HOMEWORKSSOUTHERN'), 'JB done: own only';
  assert (select string_agg(x ->> 'code', ',') from jsonb_array_elements(public.ops_po_receive_get(pg_temp.do_id('j')) -> 'outlets') x) = 'JB',
    'JB DO: only JB column';
  perform pg_temp.expect_error(format($q$select public.ops_po_do_receive('{"id":%s,"items":[{"item_code":"RA","received":3,"alloc":{"HQ":3}}]}')$q$,
    pg_temp.do_id('j')), 'JB 账套的货只能分给 JB（不能分给 总部）。');
  r := public.ops_po_do_receive(jsonb_build_object('id', pg_temp.do_id('j'),
         'items', '[{"item_code":"RA","received":3,"alloc":{"JB":3}}]'::jsonb));
  assert r ->> 'status' = 'arrived' and r -> 'receipt' -> 'issue_ids' = '[]'::jsonb, 'JB received: ' || r::text;
  assert public.ops_po_file_ok('HOMEWORKSSOUTHERN/2026-10/a.pdf', false) and not public.ops_po_file_ok('HOMEWORKSSOUTHERN/2026-10/a.pdf', true),
    'JB warehouse reads own company files';
end $$;
-- 管理层看两间公司的点货清单
select pg_temp.as_user('boss@example.com');
do $$ declare l jsonb := public.ops_po_receive_list(); begin
  assert exists (select 1 from jsonb_array_elements(l -> 'done') x where (x ->> 'id')::bigint = pg_temp.do_id('j'))
     and exists (select 1 from jsonb_array_elements(l -> 'done') x where (x ->> 'id')::bigint = pg_temp.do_id('a')), 'admin sees both';
  assert jsonb_array_length(public.ops_po_receive_list('{"days":1}') -> 'done') >= 2, 'days param';
end $$;

-- 8b. 点货跟「在路上」：分店分配、点货前已记的问题、多寄的坏件、来错的货（厂家 4000-R200，PO RV2-P1，DO 没填 ETA）
reset role;
insert into bi.v_supplier_param values ('HOMEWORKSSB', '4000-R200', 'RECV TWO', true, 60);
insert into bi.dim_item values ('HOMEWORKSSB', 'SA', 'ITEM SA', 'TAP', 'HEMOS', 'PCS'), ('HOMEWORKSSB', 'SB', 'ITEM SB', 'TAP', 'HEMOS', 'PCS'),
  ('HOMEWORKSSB', 'SC', 'ITEM SC', 'TAP', 'HEMOS', 'PCS'), ('HOMEWORKSSB', 'SD', 'ITEM SD', 'TAP', 'HEMOS', 'PCS'),
  ('HOMEWORKSSB', 'SE', 'ITEM SE', 'TAP', 'HEMOS', 'PCS'), ('HOMEWORKSSB', 'SF', 'ITEM SF', 'TAP', 'HEMOS', 'PCS');
insert into bi.fact_po_line (company, dtl_key, po_no, po_date, creditor_code, creditor_name, item_code, description,
                             location, uom, qty, transferred_qty, unit_price) values
  ('HOMEWORKSSB', 7001, 'RV2-P1', current_date - 15, '4000-R200', 'RECV TWO', 'SA', 'ITEM SA', 'HQ', 'PCS', 10, 0, 1),
  ('HOMEWORKSSB', 7002, 'RV2-P1', current_date - 15, '4000-R200', 'RECV TWO', 'SA', 'ITEM SA', 'PRE (JB)', 'PCS', 10, 0, 1),
  ('HOMEWORKSSB', 7003, 'RV2-P1', current_date - 15, '4000-R200', 'RECV TWO', 'SB', 'ITEM SB', 'HQ', 'PCS', 10, 0, 1),
  ('HOMEWORKSSB', 7004, 'RV2-P1', current_date - 15, '4000-R200', 'RECV TWO', 'SC', 'ITEM SC', 'HQ', 'PCS', 10, 0, 1),
  ('HOMEWORKSSB', 7005, 'RV2-P1', current_date - 15, '4000-R200', 'RECV TWO', 'SD', 'ITEM SD', 'HQ', 'PCS', 10, 0, 1),
  ('HOMEWORKSSB', 7006, 'RV2-P1', current_date - 15, '4000-R200', 'RECV TWO', 'SE', 'ITEM SE', 'HQ', 'PCS', 10, 0, 1),
  ('HOMEWORKSSB', 7007, 'RV2-P1', current_date - 15, '4000-R200', 'RECV TWO', 'SF', 'ITEM SF', 'HQ', 'PCS', 10, 0, 1);
create or replace function pg_temp.cand2(p_item text) returns jsonb language sql as $$
  select pg_temp.item(public.ops_po_do_candidates('HOMEWORKSSB', '4000-R200', array['RV2-P1']) -> 'items', p_item)
$$;
create or replace function pg_temp.grn2(p_key bigint, p_tr numeric) returns void language sql security definer as $$
  update bi.fact_po_line set transferred_qty = p_tr where company = 'HOMEWORKSSB' and dtl_key = p_key
$$;
grant execute on all functions in schema pg_temp to authenticated, anon;
set role authenticated;
select pg_temp.as_user('logi.r@example.com');
do $$ declare v bigint; begin
  v := pg_temp.mkdo('{"creditor_code":"4000-R200","po_nos":["RV2-P1"],"do_no":"RV2-1",
    "items":[{"item_code":"SA","shipped":20,"alloc":{"HQ":10,"JB":10}},{"item_code":"SB","shipped":10,"alloc":{"HQ":10}},
             {"item_code":"SC","shipped":10,"alloc":{"HQ":10}},{"item_code":"SD","shipped":10,"alloc":{"HQ":10}},
             {"item_code":"SE","shipped":10,"alloc":{"HQ":10}},{"item_code":"SF","shipped":10,"alloc":{"HQ":10}},
             {"src_code":"QQ-9","src_desc":"ODD TAP","shipped":1,"expected_code":"SF"}]}');
  perform pg_temp.keep('x', v);
  perform pg_temp.keep('noeta', (public.ops_home() ->> 'do_no_eta')::bigint);
  perform public.ops_po_do_confirm(v);
  assert pg_temp.iss_of('4000-R200') = 'wrong:SF/QQ-9=1*', 'R200 confirm: ' || pg_temp.iss_of('4000-R200');
  -- 没填 ETA：物流部首页提醒补 ETA；仓库的「三天内到」不算它
  assert (public.ops_home() ->> 'do_no_eta')::int = pg_temp.do_id('noeta') + 1, 'logistics do_no_eta';
end $$;
select pg_temp.as_user('buyer@example.com');
do $$ begin
  -- 货还在路上：采购先记 SB 坏货 1（厂家说的）、SC 到货少 2（厂家说少装）
  perform public.ops_po_issue_add(jsonb_build_object('do_id', pg_temp.do_id('x'), 'item_code', 'SB', 'qty', 1, 'note', '厂家说破了一个'));
  perform public.ops_po_issue_add(jsonb_build_object('do_id', pg_temp.do_id('x'), 'kind', 'short', 'item_code', 'SC', 'qty', 2,
                                                     'note', '厂家说少装两个'));
  assert (public.ops_home() ->> 'do_no_eta')::int >= 1, 'buyer do_no_eta';
end $$;
select pg_temp.as_user('helper@example.com');
do $$ begin
  -- 看不到厂家的人只能用型号 / 品名找
  assert jsonb_array_length(public.ops_po_receive_list('{"q":"RECV TWO"}') -> 'todo') = 0, 'helper cannot search supplier';
  assert (public.ops_po_receive_list('{"q":"item sd"}') -> 'todo' -> 0 ->> 'id')::bigint = pg_temp.do_id('x'), 'helper item search';
end $$;
select pg_temp.as_user('wh.r@example.com');
do $$ declare g jsonb; r jsonb; begin
  assert pg_temp.todo_count() = 1, 'no-ETA DO not in three-day count';
  assert (public.ops_po_receive_list('{"q":"RECV TWO"}') -> 'todo' -> 0 ->> 'id')::bigint = pg_temp.do_id('x')
     and jsonb_array_length(public.ops_po_receive_list('{"q":"RECV TWO"}') -> 'todo') = 1, 'warehouse supplier search';
  assert (public.ops_po_receive_list('{"q":"rv2-p1"}') -> 'todo' -> 0 ->> 'id')::bigint = pg_temp.do_id('x'), 'PO search';
  g := public.ops_po_receive_get(pg_temp.do_id('x'));
  assert (select string_agg(x ->> 'code', ',') from jsonb_array_elements(g -> 'outlets') x) = 'HQ,BATU,JB,PUCHONG', 'HQ DO: four outlets';
  assert pg_temp.item(g -> 'items', 'SB') -> 'prior' = '{"damaged":1,"short":0,"over":0,"wrong":0}'::jsonb
     and pg_temp.item(g -> 'items', 'SC') -> 'prior' = '{"damaged":0,"short":2,"over":0,"wrong":0}'::jsonb, 'priors';
  r := public.ops_po_do_receive(jsonb_build_object('id', pg_temp.do_id('x'),
    'items', '[{"item_code":"SA","received":18,"alloc":{"HQ":10,"JB":8},"note":"JB 那箱少两个"},
               {"item_code":"SB","received":9,"alloc":{"HQ":9}},
               {"item_code":"SC","received":10,"alloc":{"HQ":10}},
               {"item_code":"SD","received":10,"damaged":2,"alloc":{"HQ":10},"note":"多两个破的"},
               {"item_code":"SE","received":9,"damaged":2,"alloc":{"HQ":9}},
               {"item_code":"SF","received":10,"alloc":{"HQ":10}}]'::jsonb,
    'wrong', '[{"received_code":"QQ-9","expected_code":"sf","qty":1},
               {"received_code":"QQ-9","expected_code":"SE","qty":1,"note":"SE 箱"},
               {"received_code":"qq-9","qty":1,"note":"没写"}]'::jsonb));
  assert r ->> 'status' = 'arrived' and jsonb_array_length(r -> 'receipt' -> 'issue_ids') = 6, 'R200 received: ' || (r -> 'receipt')::text;
  assert r -> 'summary' = '{"short":3,"damaged":4,"over":3,"wrong":3,"mismatch":2,"later":{"damaged":0,"short":0,"wrong":0}}'::jsonb,
    'R200 summary: ' || (r -> 'summary')::text;
  assert pg_temp.item(r -> 'receipt' -> 'items', 'SC') -> 'prior' = '{"damaged":0,"short":2}'::jsonb, 'SC prior in receipt';
end $$;
select pg_temp.as_user('buyer@example.com');
do $$ declare s jsonb; b jsonb; r jsonb; v bigint; h jsonb; n int; begin
  -- SB：点货前记的坏货 1 = 点到的缺口 1 → 不再记；SC：已记到货少 2 但全到 → 不动它（mismatch 2，采购核对）；
  -- SD：好货够了还有 2 个坏的 = 多寄的坏件 → 只记多到 2；SE：好货 9、坏 2 → 坏货 1（缺口）+ 多到 1；
  -- 来错：QQ-9→SF 跟确认时 Excel 对不上的那笔一样（不重复）、QQ-9→SE 另一笔、QQ-9 没写本来应该是 → 前面都抵完了，另记一笔
  assert pg_temp.iss_of('4000-R200') = 'wrong:SF/QQ-9=1*,damaged:SB/=1,short:SC/=2,short:SA/=2,over:SD/=2,damaged:SE/=1,over:SE/=1,'
                                       || 'wrong:SE/QQ-9=1,wrong:-/qq-9=1', 'R200 issues: ' || pg_temp.iss_of('4000-R200');
  s := (select x from jsonb_array_elements(public.ops_po_issues('{"creditor_code":"4000-R200","kind":"over"}')) x where x ->> 'item_code' = 'SD');
  assert s ->> 'note' = '多两个破的（其中坏的 2 件）' and (s ->> 'received')::numeric = 12, 'SD over note: ' || s::text;
  -- 在路上 / 还可以出（AutoCount 还没开 GRN）
  b := pg_temp.cand2('SA');
  assert (b ->> 'in_transit')::numeric = 18 and (b -> 'by_outlet' -> 'JB' ->> 'remaining')::numeric = 2
     and (b -> 'by_outlet' -> 'HQ' ->> 'remaining')::numeric = 0 and b ->> 'single_outlet' = 'JB', 'SA short lands on JB: ' || b::text;
  b := pg_temp.cand2('SB');
  assert (b ->> 'in_transit')::numeric = 9 and (b ->> 'remaining')::numeric = 1, 'SB counted once: ' || b::text;
  b := pg_temp.cand2('SC');
  assert (b ->> 'in_transit')::numeric = 8 and (b ->> 'remaining')::numeric = 2, 'SC prior short still counted until voided: ' || b::text;
  b := pg_temp.cand2('SD');
  assert (b ->> 'in_transit')::numeric = 10 and (b ->> 'remaining')::numeric = 0 and (b ->> 'owed')::numeric = 0, 'SD extra broken: ' || b::text;
  b := pg_temp.cand2('SE');
  assert (b ->> 'in_transit')::numeric = 9 and (b ->> 'remaining')::numeric = 1 and (b ->> 'owed')::numeric = 1, 'SE: ' || b::text;
  -- 采购核对 SC：全到了 → 作废那笔到货少
  perform public.ops_po_issue_set(array[(select (x ->> 'id')::bigint from jsonb_array_elements(public.ops_po_issues('{"creditor_code":"4000-R200","kind":"short"}')) x
                                         where x ->> 'item_code' = 'SC')], 'void', '点货全到');
  assert (pg_temp.cand2('SC') ->> 'remaining')::numeric = 0, 'SC after void';
  -- AutoCount 开了 GRN（总部 10、JB 8）：SA 还欠 JB 2
  perform pg_temp.grn2(7001, 10);
  perform pg_temp.grn2(7002, 8);
  b := pg_temp.cand2('SA');
  assert (b ->> 'in_transit')::numeric = 0 and (b -> 'by_outlet' -> 'JB' ->> 'remaining')::numeric = 2, 'SA after GRN: ' || b::text;
  -- 厂家补 SA 2 件：预设分给 JB、记在 JB 的 PO 行，补齐点货记的到货少
  v := pg_temp.mkdo('{"creditor_code":"4000-R200","po_nos":["RV2-P1"],"do_no":"RV2-2","items":[{"item_code":"SA","shipped":2,"alloc":{"JB":2}}]}');
  r := public.ops_po_do_confirm(v);
  assert (select string_agg(x ->> 'outlet' || ':' || (x ->> 'dtl_key') || ':' || (x ->> 'qty'), ',') from jsonb_array_elements(r -> 'applied') x)
         = 'JB:7002:2', 'replacement on JB line: ' || (r -> 'applied')::text;
  assert jsonb_array_length(r -> 'issues') = 0, 'no over on replacement';
  s := (select x from jsonb_array_elements(public.ops_po_issues('{"status":"all","creditor_code":"4000-R200","kind":"short"}')) x
        where x ->> 'item_code' = 'SA');
  assert s ->> 'status' = 'resolved' and (s ->> 'resolved_qty')::numeric = 2, 'SA short filled: ' || s::text;
  -- 采购首页：还没决定的少发 + 7 天内新记、还没处理的
  h := public.ops_home();
  select count(*) into n from jsonb_array_elements(public.ops_po_issues('{"status":"open"}')) x
  where (x ->> 'kind' = 'short' and x ->> 'decision' = 'pending') or not (x ->> 'auto')::boolean;
  assert n > 0 and (h ->> 'po_issues_todo')::int = n, 'po_issues_todo: ' || (h ->> 'po_issues_todo') || ' vs ' || n;
end $$;

-- 9. 纪录
reset role;
do $$ begin
  assert (select count(*) from ops.audit_log where entity = 'supplier_do' and action = 'receive')
         = (select count(*) from ops.supplier_do where receipt is not null), 'every receipt logged';
  assert (select data -> 'issue_ids' from ops.audit_log where entity = 'supplier_do' and action = 'receive' and entity_id = pg_temp.do_id('a'))
         = (select receipt -> 'issue_ids' from ops.supplier_do where id = pg_temp.do_id('a')), 'log issue ids';
  -- 点货不改确认时记在 PO 行的分配
  assert (select sum(qty) from ops.supplier_do_apply where do_id = pg_temp.do_id('a') and item_code = 'RA' and outlet = 'JB' and not void) = 5,
    'apply qty untouched';
  -- 点货时 JB 少分 1：记在 JB 那笔分配
  assert (select string_agg(outlet || ':' || recv_less, ',' order by outlet) from ops.supplier_do_apply
          where do_id = pg_temp.do_id('a') and item_code = 'RA' and not void) = 'HQ:0,JB:1', 'recv_less';
  assert (select count(*) from bi.fact_po_line where creditor_code = '4000-R100' and transferred_qty <> 0) = 0, 'bi untouched';
end $$;

-- 10. anon 什么都不能叫
set role anon;
select pg_temp.expect_error($q$select public.ops_po_receive_list()$q$, 'permission denied');
select pg_temp.expect_error($q$select public.ops_po_receive_get(1)$q$, 'permission denied');
select pg_temp.expect_error($q$select public.ops_po_do_receive('{}')$q$, 'permission denied');
reset role;
set role authenticated;
select pg_temp.expect_error($q$select ops.podo_can_receive(null, 'HOMEWORKSSB')$q$, 'permission denied');
select pg_temp.expect_error($q$select ops.sees_prices(null)$q$, 'permission denied');
reset role;

select 'receive_test ok';
