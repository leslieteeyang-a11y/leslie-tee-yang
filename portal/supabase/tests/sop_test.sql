-- 订货 SOP 测试（20261015_ops_po_sop，接在 receive_test.sql 之后跑）：
--   B1 一步接一步 / 首页提醒、B2 少发先决定 / 缺零件、B4 厂家还欠（CS 工厂）、B5 来错的型号（搜我们的商品 / 不是我们的产品 /
--   要厂家怎么处理）、B6 点货后进货待入 AutoCount + 开单部、A 物流部不能开单但可以点货（遮厂家）。
--   审查后：缺零件「下次补上」= 厂家会补、进货取消只给仓库可审批（要原因）、开单部要仓库「只看」以上、GRN 提示照先出先到
--   （先开 GRN 再点货 = pre_grn 不重复算库存）、开单时的来错型号（do_row）点货带进来、点货后补记调整进货、JB 账套主要仓位、
--   看不到厂家的人不回厂家的型号写法。
-- 资料：代理 4000-S300 MULTI GLOBE（中国货）。SP-P1（厂家名称栏 CS201，开单 40 天前）：8001 SA1 HQ 10、8002 SA1 PRE (JB) 6、
--   8003 SB1 SRGADING 8、8004 SC1 HQ 5、8005 SD1 PRE (BATU) 4；SP-P2（CS202，35 天前）：8006 SE1 HQ 10；
--   SP-N1 / N2 / N3（CS203，31 / 20 / 200 天前）。本地厂 400-S301：SP-L1…L8（8 / 5 / 10 天前，各种情况）。JB 账套 400-S302 SJ-P1。
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
create or replace function pg_temp.keep(p_key text, p_id bigint) returns void language plpgsql as $$
begin
  perform set_config('sop.' || p_key, p_id::text, false);
end $$;
create or replace function pg_temp.id(p_key text) returns bigint language sql as $$
  select (current_setting('sop.' || p_key))::bigint
$$;
-- 厂家问题一览（照种类 / 型号 / 收到的型号 / 零件排）：kind:型号/收到的型号/零件=件数[*自动] 决定 要厂家 [状态]
create or replace function pg_temp.iss(p_cred text, p_do bigint default null) returns text language sql as $$
  select coalesce(string_agg(
    (x ->> 'kind') || ':' || coalesce(x ->> 'item_code', '-') || '/' || (x ->> 'received_code') || '/' || (x ->> 'part_name')
    || '=' || (x ->> 'qty') || case when (x ->> 'auto')::boolean then '*' else '' end
    || coalesce(' ' || (x ->> 'decision'), '') || coalesce(' ' || (x ->> 'request'), '')
    || case when x ->> 'status' <> 'open' then ' ' || (x ->> 'status') else '' end,
    ',' order by x ->> 'kind', coalesce(x ->> 'item_code', ''), x ->> 'received_code', x ->> 'part_name', (x ->> 'id')::bigint), '')
  from jsonb_array_elements(public.ops_po_issues(jsonb_build_object('status', 'all', 'creditor_code', p_cred))) x
  where p_do is null or (x ->> 'do_id')::bigint = p_do
$$;
create or replace function pg_temp.issue_id(p_cred text, p_kind text, p_item text, p_part text default '') returns bigint language sql as $$
  select (x ->> 'id')::bigint from jsonb_array_elements(public.ops_po_issues(jsonb_build_object('creditor_code', p_cred, 'kind', p_kind))) x
  where x ->> 'item_code' is not distinct from p_item and x ->> 'part_name' = p_part order by (x ->> 'id')::bigint limit 1
$$;
-- 这张 DO 的进货待入 AutoCount：型号@仓位/PO/分店=数量（来错的货加 !），照型号、仓位排
create or replace function pg_temp.moves(p_do bigint) returns text language sql security definer as $$
  select coalesce(string_agg(m.item_code || '@' || m.to_loc || '/' || coalesce(m.po_no, '-') || '/' || coalesce(m.outlet, '-')
                             || '=' || trim_scale(m.qty)::text || case when m.recv_wrong then '!' else '' end
                             || case when m.status <> 'pending' then ' ' || m.status else '' end,
                             ',' order by m.item_code, m.to_loc, m.po_no), '')
  from ops.wh_move m where m.do_id = p_do and m.kind = 'receive'
$$;
create or replace function pg_temp.staff_id(p_email text) returns bigint language sql security definer as $$
  select id from ops.staff where email = p_email
$$;
create or replace function pg_temp.kl_today() returns date language sql as $$
  select (now() at time zone 'Asia/Kuala_Lumpur')::date
$$;
grant execute on all functions in schema pg_temp to authenticated, anon;

insert into bi.v_supplier_param values ('HOMEWORKSSB', '4000-S300', 'MULTI GLOBE', true, 60),
  ('HOMEWORKSSB', '400-S301', 'LOCAL SOP', false, 7), ('HOMEWORKSSOUTHERN', '400-S302', 'JB LOCAL', false, 7);
insert into bi.dim_item values ('HOMEWORKSSB', 'SA1', 'BASIN SA1', 'SANITARY', 'HEMOS', 'PCS'),
  ('HOMEWORKSSB', 'SB1', 'TAP SB1', 'TAP', 'HEMOS', 'PCS'), ('HOMEWORKSSB', 'SC1', 'SINK SC1', 'SANITARY', 'HEMOS', 'PCS'),
  ('HOMEWORKSSB', 'SD1', 'WC SD1', 'SANITARY', 'HEMOS', 'SETS'), ('HOMEWORKSSB', 'SE1', 'MIRROR SE1', 'MIRROR', 'HEMOS', 'PCS'),
  ('HOMEWORKSSB', 'SF1', 'SHOWER SF1', 'SHOWER', 'HEMOS', 'PCS'), ('HOMEWORKSSB', 'SG1', 'HOSE SG1', 'TAP', 'HEMOS', 'PCS'),
  ('HOMEWORKSSOUTHERN', 'SJ1', 'JB ITEM SJ1', 'TAP', 'HEMOS', 'PCS');
insert into bi.dim_item (company, item_code, description, item_group, item_type, base_uom, is_active)
select 'HOMEWORKSSB', 'SRCH-' || lpad(g::text, 2, '0'), 'SEARCH WIDGET ' || g, 'TAP', 'HEMOS', 'PCS', g <> 1
from generate_series(1, 25) g;
insert into bi.fact_po_line (company, dtl_key, po_no, po_date, creditor_code, creditor_name, item_code, description,
                             location, uom, qty, transferred_qty, unit_price) values
  ('HOMEWORKSSB', 8001, 'SP-P1', current_date - 40, '4000-S300', 'CS201 MAIDEN', 'SA1', 'BASIN SA1', 'HQ', 'PCS', 10, 0, 50),
  ('HOMEWORKSSB', 8002, 'SP-P1', current_date - 40, '4000-S300', 'CS201 MAIDEN', 'SA1', 'BASIN SA1', 'PRE (JB)', 'PCS', 6, 0, 50),
  ('HOMEWORKSSB', 8003, 'SP-P1', current_date - 40, '4000-S300', 'CS201 MAIDEN', 'SB1', 'TAP SB1', 'SRGADING', 'PCS', 8, 0, 20),
  ('HOMEWORKSSB', 8004, 'SP-P1', current_date - 40, '4000-S300', 'CS201 MAIDEN', 'SC1', 'SINK SC1', 'HQ', 'PCS', 5, 0, 30),
  ('HOMEWORKSSB', 8005, 'SP-P1', current_date - 40, '4000-S300', 'CS201 MAIDEN', 'SD1', 'WC SD1', 'PRE (BATU)', 'SETS', 4, 0, 99),
  ('HOMEWORKSSB', 8006, 'SP-P2', current_date - 35, '4000-S300', 'CS202 (ETA)', 'SE1', 'MIRROR SE1', 'HQ', 'PCS', 10, 0, 15),
  ('HOMEWORKSSB', 8010, 'SP-N1', current_date - 31, '4000-S300', 'CS203', 'SF1', 'SHOWER SF1', 'HQ', 'PCS', 2, 0, 1),
  ('HOMEWORKSSB', 8011, 'SP-N2', current_date - 20, '4000-S300', 'CS203', 'SF1', 'SHOWER SF1', 'HQ', 'PCS', 2, 0, 1),
  ('HOMEWORKSSB', 8012, 'SP-N3', current_date - 200, '4000-S300', 'CS203', 'SF1', 'SHOWER SF1', 'HQ', 'PCS', 2, 0, 1),
  ('HOMEWORKSSB', 8020, 'SP-L1', current_date - 8, '400-S301', 'LOCAL SOP', 'SA1', 'BASIN SA1', 'HQ', 'PCS', 1, 0, 1),
  ('HOMEWORKSSB', 8021, 'SP-L2', current_date - 5, '400-S301', 'LOCAL SOP', 'SA1', 'BASIN SA1', 'HQ', 'PCS', 1, 0, 1),
  ('HOMEWORKSSB', 8022, 'SP-L3', current_date - 10, '400-S301', 'LOCAL SOP', 'SA1', 'BASIN SA1', 'HQ', 'PCS', 1, 0, 1),
  ('HOMEWORKSSB', 8023, 'SP-L4', current_date - 10, '400-S301', 'LOCAL SOP', 'SA1', 'BASIN SA1', 'HQ', 'PCS', 1, 0, 1),
  ('HOMEWORKSSB', 8024, 'SP-L5', current_date - 10, '400-S301', 'LOCAL SOP', 'SA1', 'BASIN SA1', 'HQ', 'PCS', 1, 0, 1),
  ('HOMEWORKSSB', 8025, 'SP-L6', current_date - 10, '400-S301', 'LOCAL SOP', 'SA1', 'BASIN SA1', 'HQ', 'PCS', 1, 0, 1),
  ('HOMEWORKSSB', 8026, 'SP-L7', current_date - 10, '400-S301', 'LOCAL SOP', 'SA1', 'BASIN SA1', 'HQ', 'PCS', 1, 0, 1),
  ('HOMEWORKSSB', 8027, 'SP-L8', current_date - 10, '400-S301', 'LOCAL SOP', 'SA1', 'BASIN SA1', 'HQ', 'PCS', 1, 0, 1),
  ('HOMEWORKSSOUTHERN', 8101, 'SJ-P1', current_date - 12, '400-S302', 'JB LOCAL', 'SJ1', 'JB ITEM SJ1', 'MAIN', 'PCS', 5, 0, 1);
-- SP-L3 填了 ETA、SP-L4 挂了货柜、SP-L5 关闭、SP-L8 标了到货
insert into ops.po_track (company, po_no, eta) values ('HOMEWORKSSB', 'SP-L3', current_date + 5);
insert into ops.po_track (company, po_no, status) values ('HOMEWORKSSB', 'SP-L5', 'closed'), ('HOMEWORKSSB', 'SP-L8', 'arrived');
with s as (insert into ops.shipment (company, name, eta) values ('HOMEWORKSSB', 'SOP-CTN', current_date + 20) returning id)
insert into ops.po_track (company, po_no, shipment_id) select 'HOMEWORKSSB', 'SP-L4', s.id from s;

-- 0. 开单部（billing）：一般模块 + 仓库只看；看得到厂家；可以看待开进货单
do $$ begin
  assert (select name from ops.department where code = 'billing') = '开单部', 'billing dept';
  assert (select string_agg(module || ':' || level, ',' order by module) from ops.dept_module where department = 'billing')
         = 'approvals:edit,attendance:edit,dashboard:view,leave:edit,tasks:edit,warehouse:view', 'billing modules';
  assert (select level from ops.dept_module where department = 'logistics' and module = 'purchasing') = 'view', 'logistics still view';
end $$;
set role authenticated;
select pg_temp.as_user('boss@example.com');
select public.ops_staff_save('{"email":"bill@example.com","name":"开单小陈","department":"billing","branch":"HOMEWORKSSB"}');
-- 门市员工开了个人例外「仓库可审批」：可以标进货已输入，但看不到厂家
select public.ops_staff_save('{"email":"whover@example.com","name":"门市代班","department":"sales","branch":"HOMEWORKSSB","overrides":{"warehouse":"approve"}}');
reset role;
do $$ declare s ops.staff; begin
  select * into s from ops.staff where email = 'bill@example.com';
  assert ops.sees_supplier(s) and ops.grn_can_mark(s) and not ops.sees_prices(s), 'billing: supplier yes, grn yes, prices no';
  assert ops.module_level(s, 'warehouse') = 'view' and ops.module_level(s, 'purchasing') = 'none', 'billing levels';
  select * into s from ops.staff where email = 'whover@example.com';
  assert not ops.sees_supplier(s) and ops.grn_can_mark(s), 'whover: grn yes, supplier no';
  select * into s from ops.staff where email = 'picker@example.com';
  assert ops.sees_supplier(s) and not ops.grn_can_mark(s), 'warehouse edit: no grn';
  select * into s from ops.staff where email = 'whmgr@example.com';
  assert ops.grn_can_mark(s), 'warehouse approve: grn';
  assert not ops.grn_can_mark(null::ops.staff), 'null staff';
end $$;
set role authenticated;
select pg_temp.as_user('bill@example.com');
do $$ declare me jsonb := public.ops_me(); h jsonb := public.ops_home(); begin
  assert exists (select 1 from jsonb_array_elements(me -> 'departments') x where x ->> 'code' = 'billing' and x ->> 'name' = '开单部'),
    'departments list has billing';
  assert (h ->> 'grn_pending')::int >= 0 and h -> 'po_no_eta' = 'null'::jsonb and h -> 'wh_moves_pending' = 'null'::jsonb
     and h -> 'po_arriving' = 'null'::jsonb and h -> 'do_to_count' = 'null'::jsonb,
    'billing home: ' || h::text;
end $$;
select pg_temp.expect_error($q$select public.ops_po_list('{}')$q$, '查看权限');
select pg_temp.expect_error($q$select public.ops_po_receive_list()$q$, '才能点货');
select pg_temp.expect_error($q$select public.ops_po_item_search('', 'sa1')$q$, '才能点货');

-- 1. B1：要问厂家 ETA 的 PO（中国货 ≥ 30 天、本地货 ≥ 7 天、≤ 120 天；有 DO / ETA / 货柜 / 关闭 / 到货的不算）
select pg_temp.as_user('buyer@example.com');
do $$ declare v bigint; l jsonb; begin
  v := pg_temp.mkdo('{"creditor_code":"400-S301","po_nos":["SP-L6"],"do_no":"L6-DRAFT"}');
  v := pg_temp.mkdo('{"creditor_code":"400-S301","po_nos":["SP-L7"],"do_no":"L7-CANCEL"}');
  perform public.ops_po_do_cancel(v, '开错了');
  l := public.ops_po_list('{"no_eta":true}');
  assert (select string_agg(x ->> 'po_no', ',' order by x ->> 'po_no') from jsonb_array_elements(l) x
          where x ->> 'creditor_code' in ('4000-S300', '400-S301')) = 'SP-L1,SP-L7,SP-N1,SP-P1,SP-P2',
    'no_eta list: ' || (select string_agg(x ->> 'po_no', ',' order by x ->> 'po_no') from jsonb_array_elements(l) x
                        where x ->> 'creditor_code' in ('4000-S300', '400-S301'));
  assert (public.ops_home() ->> 'po_no_eta')::int = jsonb_array_length(l), 'home po_no_eta = list: ' || (public.ops_home() ->> 'po_no_eta');
end $$;
select pg_temp.as_user('hqsales@example.com');
do $$ begin assert public.ops_home() -> 'po_no_eta' = 'null'::jsonb and public.ops_home() -> 'do_draft_stale' = 'null'::jsonb, 'sales: no'; end $$;

-- 2. B1：厂家到货一步接一步（草稿：1 选 PO → 2 出货数量 → 3 分配 → 4 ETA → 5 确认）
select pg_temp.as_user('buyer@example.com');
do $$ declare r jsonb; v bigint; begin
  r := public.ops_po_do_save('{"creditor_code":"4000-S300","do_no":"SOP-1"}');
  v := (r ->> 'id')::bigint;
  perform pg_temp.keep('one', v);
  assert (r -> 'sop' ->> 'step')::int = 1 and r -> 'sop' ->> 'owner' = 'purchasing' and not (r -> 'sop' -> 'done' ->> 'po')::boolean
     and not (r -> 'sop' ->> 'draft_overdue')::boolean and (r -> 'sop' ->> 'decide_n')::int = 0, 'step 1: ' || (r -> 'sop')::text;
  r := public.ops_po_do_save(jsonb_build_object('id', v, 'po_nos', '["SP-P1"]'::jsonb));
  assert (r -> 'sop' ->> 'step')::int = 2, 'step 2: ' || (r -> 'sop')::text;
  r := public.ops_po_do_save(jsonb_build_object('id', v, 'items', '[{"item_code":"SA1","shipped":12,"alloc":{"HQ":8}}]'::jsonb));
  assert (r -> 'sop' ->> 'step')::int = 3 and (r -> 'sop' -> 'done' ->> 'shipped')::boolean
     and not (r -> 'sop' -> 'done' ->> 'alloc')::boolean, 'step 3: ' || (r -> 'sop')::text;
  r := public.ops_po_do_save(jsonb_build_object('id', v, 'items', '[{"item_code":"SA1","shipped":12,"alloc":{"HQ":8,"JB":4}}]'::jsonb));
  assert (r -> 'sop' ->> 'step')::int = 4 and not (r -> 'sop' -> 'done' ->> 'eta')::boolean, 'step 4: ' || (r -> 'sop')::text;
  r := public.ops_po_do_save(jsonb_build_object('id', v, 'eta', to_char(current_date + 10, 'YYYY-MM-DD')));
  assert (r -> 'sop' ->> 'step')::int = 5 and r -> 'sop' -> 'done' = '{"po":true,"shipped":true,"alloc":true,"eta":true,"confirmed":false,"received":false,"decided":true}'::jsonb,
    'step 5: ' || (r -> 'sop')::text;
end $$;
-- 草稿开了 25 小时：标红、首页提醒
reset role;
update ops.supplier_do set created_at = now() - interval '25 hours' where id = pg_temp.id('one');
set role authenticated;
do $$ declare l jsonb; n int; begin
  l := public.ops_po_do_list('{"status":"draft"}');
  assert (select (x -> 'sop' ->> 'draft_overdue')::boolean from jsonb_array_elements(l) x where (x ->> 'id')::bigint = pg_temp.id('one')),
    'draft overdue in list';
  select count(*) into n from jsonb_array_elements(l) x where (x -> 'sop' ->> 'draft_overdue')::boolean;
  assert n >= 1 and (public.ops_home() ->> 'do_draft_stale')::int = n, 'home do_draft_stale: ' || (public.ops_home() ->> 'do_draft_stale') || ' vs ' || n;
end $$;

-- 3. B2 / B5：这批的问题 — 少发先决定、多发备注、来错的型号（我们的商品 / 不是我们的产品）、缺零件
select pg_temp.expect_error(format($q$select public.ops_po_do_save('{"id":%s,"items":[{"item_code":"SA1","shipped":12,"alloc":{"HQ":12},"short_decision":"maybe"}]}')$q$,
  pg_temp.id('one')), '型号 SA1 的少发要选「厂家会补」「取消（下次再订）」或「未决定」');
select pg_temp.expect_error(format($q$select public.ops_po_do_save('{"id":%s,"items":[{"src_code":"nope-1","shipped":1,"own":true}]}')$q$,
  pg_temp.id('one')), '来错的型号：找不到我们的型号 nope-1');
select pg_temp.expect_error(format($q$select public.ops_po_do_save('{"id":%s,"items":[{"src_code":"QQ","shipped":1,"own":false}]}')$q$,
  pg_temp.id('one')), '来错的型号「不是我们的产品」请填品名');
select pg_temp.expect_error(format($q$select public.ops_po_do_save('{"id":%s,"items":[{"src_code":"SG1","shipped":1,"own":true,"request":"burn"}]}')$q$,
  pg_temp.id('one')), '「要厂家怎么处理」不对：burn');
select pg_temp.expect_error(format($q$select public.ops_po_do_save('{"id":%s,"parts":[{"part_name":"","qty":1}]}')$q$, pg_temp.id('one')),
  '缺零件请填零件 / 东西名称');
select pg_temp.expect_error(format($q$select public.ops_po_do_save('{"id":%s,"parts":[{"part_name":"螺丝包","qty":0}]}')$q$, pg_temp.id('one')),
  '缺零件「螺丝包」请填数量');
select pg_temp.expect_error(format($q$select public.ops_po_do_save('{"id":%s,"parts":[{"part_name":"螺丝包","qty":1,"item_code":"SE1"}]}')$q$,
  pg_temp.id('one')), '型号 SE1 不在所选的 PO 里');
select pg_temp.expect_error(format($q$select public.ops_po_do_save('{"id":%s,"parts":{}}')$q$, pg_temp.id('one')), '资料格式不对');
do $$ declare r jsonb; it jsonb; c jsonb; begin
  r := public.ops_po_do_save(jsonb_build_object('id', pg_temp.id('one'),
    'items', '[{"item_code":"SA1","shipped":12,"alloc":{"HQ":8,"JB":4},"short_decision":"await","note":"下批补"},
               {"item_code":"SB1","shipped":9,"alloc":{"HQ":9},"note":"多一个"},
               {"item_code":"SC1","shipped":2,"alloc":{"HQ":2},"short_decision":"cancelled"},
               {"item_code":"SD1","shipped":4,"alloc":{"BATU":4},"short_decision":"pending"},
               {"src_code":"sg1","src_desc":"","shipped":2,"own":true,"expected_code":"sc1","request":"RETURN","note":"收到 SG1"},
               {"src_code":"","src_desc":"MYSTERY TAP","shipped":1,"own":false,"request":"other","note":"不是我们的"}]'::jsonb,
    'parts', '[{"item_code":"sd1","part_name":"螺丝包","qty":4,"note":"每箱少一包"},{"part_name":"说明书","qty":"1","request":"other"},
               {"part_name":"","qty":"","note":""}]'::jsonb));
  assert pg_temp.item(r -> 'items', 'SA1') ->> 'short_decision' = 'await' and pg_temp.item(r -> 'items', 'SC1') ->> 'short_decision' = 'cancelled'
     and not pg_temp.item(r -> 'items', 'SD1') ? 'short_decision' and not pg_temp.item(r -> 'items', 'SB1') ? 'own', 'short decisions saved: ' || (r -> 'items')::text;
  it := (select x from jsonb_array_elements(r -> 'items') x where x ->> 'src_code' = 'SG1');
  assert it -> 'item_code' = 'null'::jsonb and it ->> 'src_desc' = 'HOSE SG1' and it ->> 'description' = 'HOSE SG1' and (it ->> 'own')::boolean
     and it ->> 'request' = 'return' and it ->> 'expected_code' = 'SC1', 'own wrong row normalized: ' || coalesce(it::text, r::text);
  it := (select x from jsonb_array_elements(r -> 'items') x where x ->> 'src_desc' = 'MYSTERY TAP');
  assert not (it ->> 'own')::boolean and it ->> 'request' = 'other' and it ->> 'src_code' = '', 'not ours row: ' || it::text;
  assert r -> 'parts' = '[{"qty":4,"note":"每箱少一包","request":"next","item_code":"SD1","part_name":"螺丝包"},
                         {"qty":1,"note":"","request":"other","item_code":null,"part_name":"说明书"}]'::jsonb, 'parts: ' || (r -> 'parts')::text;
  assert (r -> 'sop' ->> 'step')::int = 5, 'still step 5';
  -- 存草稿不影响还可以出
  c := pg_temp.item(public.ops_po_do_candidates('', '4000-S300', array['SP-P1']) -> 'items', 'SA1');
  assert (c ->> 'remaining')::numeric = 16, 'draft does not count: ' || c::text;
  r := public.ops_po_do_confirm(pg_temp.id('one'));
  assert r ->> 'status' = 'confirmed' and (r -> 'sop' ->> 'step')::int = 6 and r -> 'sop' ->> 'owner' = 'warehouse'
     and (r -> 'sop' ->> 'decide_n')::int = 1 and not (r -> 'sop' -> 'done' ->> 'decided')::boolean and (r -> 'sop' ->> 'grn_n')::int = 0,
    'confirmed sop: ' || (r -> 'sop')::text;
  assert pg_temp.no_price(r), 'no prices';
end $$;
do $$ declare s jsonb; c jsonb; n int; begin
  -- 缺零件「下次补上」（预设）= 厂家会补；「其他」= 未决定
  assert pg_temp.iss('4000-S300') = 'over:SB1//=1*,part:-//说明书=1* pending other,part:SD1//螺丝包=4* await next,'
                                    || 'short:SA1//=4* await,short:SC1//=3* cancelled resolved,wrong:-//=1* other,wrong:SC1/SG1/=2* return',
    'confirm issues: ' || pg_temp.iss('4000-S300');
  s := (select x from jsonb_array_elements(public.ops_po_issues('{"creditor_code":"4000-S300","kind":"short"}')) x where x ->> 'item_code' = 'SA1');
  assert s ->> 'decided_by_name' = 'buyer' and s ->> 'note' = '下批补' and s ->> 'factory' = 'CS201' and (s ->> 'owed_qty')::numeric = 4
     and s -> 'part_name' = '""'::jsonb and s -> 'request' = 'null'::jsonb, 'SA1 short: ' || s::text;
  s := (select x from jsonb_array_elements(public.ops_po_issues('{"creditor_code":"4000-S300","kind":"over"}')) x);
  assert s ->> 'note' = '多一个' and (s ->> 'owed_qty')::numeric = 0, 'over note';
  s := (select x from jsonb_array_elements(public.ops_po_issues('{"creditor_code":"4000-S300","kind":"wrong"}')) x where x ->> 'received_code' = 'SG1');
  assert s ->> 'description' = 'HOSE SG1' and s ->> 'note' = '收到 SG1' and s ->> 'do_no' = 'SOP-1' and s -> 'po_nos' = '["SP-P1"]'::jsonb, 'wrong: ' || s::text;
  s := (select x from jsonb_array_elements(public.ops_po_issues('{"creditor_code":"4000-S300","kind":"part"}')) x where x ->> 'part_name' = '螺丝包');
  assert s ->> 'description' = 'WC SD1' and s -> 'po_nos' = '["SP-P1"]'::jsonb and s ->> 'note' = '每箱少一包' and (s ->> 'owed_qty')::numeric = 4
     and s ->> 'factory' = 'CS201', 'part: ' || s::text;
  -- 缺零件不影响在路上 / 少发：SD1 全到，在路上 4、还可以出 0、owed 0
  c := pg_temp.item(public.ops_po_do_candidates('', '4000-S300', array['SP-P1']) -> 'items', 'SD1');
  assert (c ->> 'in_transit')::numeric = 4 and (c ->> 'remaining')::numeric = 0 and (c ->> 'owed')::numeric = 0, 'parts no effect: ' || c::text;
  c := pg_temp.item(public.ops_po_do_candidates('', '4000-S300', array['SP-P1']) -> 'items', 'SA1');
  assert (c ->> 'in_transit')::numeric = 12 and (c ->> 'remaining')::numeric = 4 and (c ->> 'owed')::numeric = 4, 'SA1 after confirm: ' || c::text;
  -- 首页：还没决定的少发 + 缺零件 + 7 天内新记的（同一条，不重复两条）
  select count(*) into n from jsonb_array_elements(public.ops_po_issues('{"status":"open"}')) x
  where (x ->> 'kind' in ('short', 'part') and x ->> 'decision' = 'pending') or not (x ->> 'auto')::boolean;
  assert (public.ops_home() ->> 'po_issues_todo')::int = n, 'po_issues_todo with parts: ' || (public.ops_home() ->> 'po_issues_todo') || ' vs ' || n;
  -- 已确认的不能改缺零件
  perform pg_temp.expect_error(format($q$select public.ops_po_do_save('{"id":%s,"parts":[]}')$q$, pg_temp.id('one')), '请先「退回草稿」');
  -- 清单的 SOP
  s := (select x from jsonb_array_elements(public.ops_po_do_list('{}')) x where (x ->> 'id')::bigint = pg_temp.id('one'));
  assert (s -> 'sop' ->> 'step')::int = 6 and not (s -> 'sop' ->> 'draft_overdue')::boolean, 'list sop after confirm';
end $$;
-- 开单时决定的有纪录
reset role;
do $$ begin
  assert (select count(*) from ops.audit_log a where a.action in ('issue_await', 'issue_cancel') and a.data ->> 'from' = 'confirm'
          and a.entity_id in (select i.id from ops.supplier_issue i where i.creditor_code = '4000-S300')) = 3, 'decisions logged';
end $$;
set role authenticated;

-- 4. B4：厂家还欠（少发未决定 / 厂家会补 + 缺零件还没处理）、CS 工厂、要厂家怎么处理
do $$ declare o jsonb; begin
  o := public.ops_po_issues('{"creditor_code":"4000-S300","owed":true}');
  assert (select string_agg((x ->> 'kind') || ':' || coalesce(x ->> 'item_code', '-') || (x ->> 'part_name') || '=' || (x ->> 'owed_qty'), ','
                            order by x ->> 'kind', coalesce(x ->> 'item_code', '')) from jsonb_array_elements(o) x)
         = 'part:-说明书=1,part:SD1螺丝包=4,short:SA1=4', 'owed: ' || o::text;
  assert jsonb_array_length(public.ops_po_issues('{"creditor_code":"4000-S300","factory":"cs 201","status":"all"}')) = 7, 'factory filter';
  assert jsonb_array_length(public.ops_po_issues('{"creditor_code":"4000-S300","factory":"CS202"}')) = 0, 'factory filter none';
  assert jsonb_array_length(public.ops_po_issues('{"q":"螺丝"}')) = 1 and jsonb_array_length(public.ops_po_issues('{"q":"cs201"}')) >= 3, 'search part / factory';
end $$;
-- 处理：缺零件可以选厂家会补 / 取消 / 改回未决定、直接已处理；改「要厂家怎么处理」
do $$ declare p1 bigint := pg_temp.issue_id('4000-S300', 'part', 'SD1', '螺丝包'); p2 bigint := pg_temp.issue_id('4000-S300', 'part', null, '说明书');
  w bigint := (select (x ->> 'id')::bigint from jsonb_array_elements(public.ops_po_issues('{"creditor_code":"4000-S300","kind":"wrong"}')) x
               where x ->> 'received_code' = '');
begin
  assert public.ops_po_issue_set(array[p1], 'await') = 1, 'part await';
  assert public.ops_po_issue_set(array[p2], 'cancel', '不用了') = 1, 'part cancel';
  assert public.ops_po_issue_set(array[p2], 'reopen') = 1, 'part reopen';
  assert public.ops_po_issue_set(array[w], 'request', 'keep') = 1, 'wrong request';
  assert public.ops_po_issue_set(array[w], 'request', '') = 1, 'wrong request cleared';
  assert public.ops_po_issue_set(array[w], 'request', 'replace') = 1, 'wrong request again';
  assert pg_temp.iss('4000-S300') = 'over:SB1//=1*,part:-//说明书=1* pending other,part:SD1//螺丝包=4* await next,'
                                    || 'short:SA1//=4* await,short:SC1//=3* cancelled resolved,wrong:-//=1* replace,wrong:SC1/SG1/=2* return',
    'after set: ' || pg_temp.iss('4000-S300');
  assert (select x ->> 'action_note' from jsonb_array_elements(public.ops_po_issues('{"creditor_code":"4000-S300","kind":"wrong"}')) x
          where (x ->> 'id')::bigint = w) = '', 'request does not touch action_note';
end $$;
select pg_temp.expect_error(format($q$select public.ops_po_issue_set(array[%s::bigint], 'request', 'next')$q$,
  pg_temp.issue_id('4000-S300', 'short', 'SA1')), '少发请选「厂家会补」或「取消（下次再订）」');
select pg_temp.expect_error(format($q$select public.ops_po_issue_set(array[%s::bigint], 'await')$q$,
  pg_temp.issue_id('4000-S300', 'over', 'SB1')), '只有「少发」和「缺零件」');
select pg_temp.expect_error(format($q$select public.ops_po_issue_set(array[%s::bigint], 'request', 'burn')$q$,
  pg_temp.issue_id('4000-S300', 'over', 'SB1')), '「要厂家怎么处理」不对');

-- 退回草稿再确认：缺零件 / 来错的型号重记，已决定的留著只补差额；少发照原本的决定
select pg_temp.as_user('pomgr@example.com');
select public.ops_po_do_reopen(pg_temp.id('one'), '改零件数量') ->> 'status';
select pg_temp.as_user('buyer@example.com');
do $$ declare r jsonb; begin
  r := public.ops_po_do_save(jsonb_build_object('id', pg_temp.id('one'),
    'parts', '[{"item_code":"SD1","part_name":"螺丝包","qty":5},{"part_name":"说明书","qty":1,"request":"other"}]'::jsonb));
  assert (r -> 'sop' ->> 'step')::int = 5, 'reopened step 5';
  r := public.ops_po_do_confirm(pg_temp.id('one'));
  -- （「all」不含作废的：退回草稿时作废的多发、缺零件、来错的型号不列）
  assert pg_temp.iss('4000-S300') = 'over:SB1//=1*,part:-//说明书=1* pending other,'
                                    || 'part:SD1//螺丝包=4* await next,part:SD1//螺丝包=1* await next,'
                                    || 'short:SA1//=4* await,short:SC1//=3* cancelled resolved,'
                                    || 'wrong:-//=1* other,wrong:SC1/SG1/=2* return',
    'reconfirm: ' || pg_temp.iss('4000-S300');
end $$;

-- 5. B5：搜我们的商品（订货或仓库「可编辑」；最多 20 笔；只回型号、品名、单位）
do $$ declare r jsonb; begin
  r := public.ops_po_item_search('', 'sa1');
  assert r -> 0 = '{"item_code":"SA1","description":"BASIN SA1","uom":"PCS"}'::jsonb, 'exact first: ' || r::text;
  r := public.ops_po_item_search('HOMEWORKSSB', 'search widget');
  assert jsonb_array_length(r) = 20 and r -> 0 ->> 'item_code' = 'SRCH-02'
     and (select bool_and((select array_agg(k order by k) from jsonb_object_keys(x) k) = '{description,item_code,uom}') from jsonb_array_elements(r) x),
    'limit 20, inactive last, three keys: ' || r::text;
  assert public.ops_po_item_search('', '   ') = '[]'::jsonb, 'empty';
  assert jsonb_array_length(public.ops_po_item_search('', 'hose sg')) = 1, 'words';
end $$;
select pg_temp.as_user('picker@example.com');
do $$ begin assert jsonb_array_length(public.ops_po_item_search('', 'SG1')) = 1, 'warehouse edit can search'; end $$;
select pg_temp.as_user('hqsales@example.com');
select pg_temp.expect_error($q$select public.ops_po_item_search('', 'SG1')$q$, '才能点货');
select pg_temp.as_user('wh.jb@example.com');
select pg_temp.expect_error($q$select public.ops_po_item_search('HOMEWORKSSB', 'SG1')$q$, '请选择你分店的公司');
do $$ begin assert jsonb_array_length(public.ops_po_item_search('', 'sj1')) = 1, 'JB searches JB items'; end $$;

-- 6. 确认后补记：缺零件（仓库也能记）、来错的型号（我们的 / 不是我们的）
select pg_temp.as_user('picker@example.com');
select pg_temp.expect_error(format($q$select public.ops_po_issue_add('{"do_id":%s,"kind":"part","qty":1}')$q$, pg_temp.id('one')),
  '请填缺的零件 / 东西名称');
select pg_temp.expect_error(format($q$select public.ops_po_issue_add('{"do_id":%s,"kind":"part","part_name":"把手","qty":1,"item_code":"SE1"}')$q$,
  pg_temp.id('one')), '这张 DO 没有型号 SE1');
select pg_temp.expect_error(format($q$select public.ops_po_issue_add('{"do_id":%s,"kind":"wrong","own":true,"received_code":"zz","qty":1}')$q$,
  pg_temp.id('one')), '找不到我们的型号 zz');
select pg_temp.expect_error(format($q$select public.ops_po_issue_add('{"do_id":%s,"kind":"wrong","own":false,"qty":1}')$q$,
  pg_temp.id('one')), '「不是我们的产品」请填品名');
select pg_temp.expect_error(format($q$select public.ops_po_issue_add('{"do_id":%s,"kind":"over","item_code":"SA1","qty":1}')$q$,
  pg_temp.id('one')), '只能手动记坏货、到货少、发错型号或缺零件');
do $$ declare r jsonb; begin
  r := public.ops_po_issue_add(jsonb_build_object('do_id', pg_temp.id('one'), 'kind', 'part', 'part_name', '把手', 'qty', 2,
                                                  'item_code', 'sa1', 'note', '箱子里没有'));
  assert r ->> 'kind' = 'part' and r ->> 'item_code' = 'SA1' and r ->> 'part_name' = '把手' and r ->> 'request' = 'next'
     and r ->> 'decision' = 'await' and r ->> 'decided_by_name' = '仓库阿强' and not (r ->> 'auto')::boolean
     and r ->> 'description' = 'BASIN SA1' and r ->> 'factory' = 'CS201', 'part add (next = await): ' || r::text;
  r := public.ops_po_issue_add(jsonb_build_object('do_id', pg_temp.id('one'), 'kind', 'wrong', 'own', true, 'received_code', 'srch-03',
                                                  'qty', 1, 'request', 'return'));
  assert r ->> 'received_code' = 'SRCH-03' and r ->> 'description' = 'SEARCH WIDGET 3' and r ->> 'request' = 'return', 'wrong own add: ' || r::text;
  r := public.ops_po_issue_add(jsonb_build_object('do_id', pg_temp.id('one'), 'kind', 'damaged', 'item_code', 'SB1', 'qty', 1, 'request', 'replace'));
  assert r ->> 'request' = 'replace' and r ->> 'kind' = 'damaged', 'damaged with request';
end $$;
-- 看不到厂家的人：精简结果也有零件名称、要厂家怎么处理
select pg_temp.as_user('helper@example.com');
do $$ declare r jsonb; begin
  r := public.ops_po_issue_add(jsonb_build_object('do_id', pg_temp.id('one'), 'kind', 'part', 'part_name', '胶条', 'qty', 1, 'request', 'other'));
  assert r ->> 'part_name' = '胶条' and r ->> 'request' = 'other' and r ->> 'decision' = 'pending' and not r ? 'supplier_name'
     and not r ? 'factory', 'slim: ' || r::text;
end $$;
-- 物流部（仓库可编辑）可以记，看不到厂家
select pg_temp.as_user('logi.r@example.com');
do $$ declare r jsonb; begin
  r := public.ops_po_issue_add(jsonb_build_object('do_id', pg_temp.id('one'), 'kind', 'part', 'part_name', '垫片', 'qty', 3));
  assert not r ? 'supplier_name' and r ->> 'request' = 'next' and r ->> 'decision' = 'await', 'logistics slim: ' || r::text;
end $$;

-- 6b. 看不到厂家的人（物流部，仓库可编辑 = 可以点货）：厂家 DO 上的型号写法遮掉，只有「是我们的商品」的才回；
--     厂家问题的「收到的型号」也只回我们的型号；每行有 row（点货时带 do_row 回来对上确认时记的那笔）；主要仓位 HQ
select pg_temp.as_user('logi.r@example.com');
do $$ declare g jsonb := public.ops_po_receive_get(pg_temp.id('one')); begin
  assert g -> 'do_no' = 'null'::jsonb and g ->> 'main_location' = 'HQ', 'logi head: ' || (g - 'items' - 'issues')::text;
  assert (select string_agg(coalesce(x ->> 'own', '-') || ':' || (x ->> 'src_code') || ':' || (x ->> 'src_desc') || ':' || (x ->> 'row'), ','
                            order by (x ->> 'row')::int) from jsonb_array_elements(g -> 'unmatched') x)
         = 'true:SG1:HOSE SG1:5,false::MYSTERY TAP:6', 'logi unmatched: ' || (g -> 'unmatched')::text;
  assert (select bool_and(case when x ->> 'kind' = 'wrong' then (x ->> 'received_code' = '') = not (x ->> 'ours')::boolean else true end)
          from jsonb_array_elements(g -> 'issues') x)
     and exists (select 1 from jsonb_array_elements(g -> 'issues') x where x ->> 'received_code' = 'SRCH-03' and (x ->> 'ours')::boolean),
    'logi issues masked: ' || (g -> 'issues')::text;
end $$;
-- 采购把一行厂家写法的来错型号（对不上 PO、没认是不是我们的）记进来，看不到厂家的人看不到写法
reset role;
update ops.supplier_issue set received_code = 'FAC-77' where id = (select max(id) from ops.supplier_issue
  where do_id = pg_temp.id('one') and kind = 'wrong' and received_code = '' and status <> 'void');
do $$ begin assert exists (select 1 from ops.supplier_issue where received_code = 'FAC-77'), 'fixture FAC-77'; end $$;
set role authenticated;
do $$ declare g jsonb := public.ops_po_receive_get(pg_temp.id('one')); begin
  assert not exists (select 1 from jsonb_array_elements(g -> 'issues') x where x::text like '%FAC-77%'), 'factory spelling hidden: ' || (g -> 'issues')::text;
end $$;
select pg_temp.as_user('wh.r@example.com');
do $$ begin
  assert exists (select 1 from jsonb_array_elements(public.ops_po_receive_get(pg_temp.id('one')) -> 'issues') x where x ->> 'received_code' = 'FAC-77'),
    'warehouse dept sees supplier spelling';
end $$;
reset role;
update ops.supplier_issue set received_code = '' where received_code = 'FAC-77';
set role authenticated;

-- 7. B6：点货 → 进货待入 AutoCount（仓库 pending 搬动 kind = receive）
select pg_temp.as_user('wh.r@example.com');
do $$ declare g jsonb; begin
  g := public.ops_po_receive_get(pg_temp.id('one'));
  assert pg_temp.item(g -> 'items', 'SA1') ->> 'note' = '下批补' and pg_temp.item(g -> 'items', 'SB1') ->> 'note' = '多一个'
     and pg_temp.item(g -> 'items', 'SC1') ->> 'note' = '', 'receive shows editor notes: ' || (g -> 'items')::text;
  assert (select string_agg(coalesce(x ->> 'own', '-') || ':' || coalesce(x ->> 'request', '-'), ',' order by x ->> 'src_code')
          from jsonb_array_elements(g -> 'unmatched') x) = 'false:other,true:return', 'unmatched own/request: ' || (g -> 'unmatched')::text;
  assert g -> 'moves' = '[]'::jsonb and g -> 'locations' ? 'HQ' and g -> 'locations' ? 'SRGADING', 'moves empty, locations: ' || (g -> 'locations')::text;
  assert exists (select 1 from jsonb_array_elements(g -> 'issues') x where x ->> 'part_name' = '螺丝包' and x ->> 'request' = 'next'
                 and x -> 'po_nos' = '["SP-P1"]'::jsonb and x ->> 'factory' = 'CS201'), 'issues have parts: ' || (g -> 'issues')::text;
  assert pg_temp.no_price(g), 'no prices';
end $$;
select pg_temp.expect_error(format($q$select public.ops_po_do_receive(jsonb_build_object('id', %s,
  'items', '[{"item_code":"SA1","received":12,"alloc":{"HQ":9,"JB":3}},{"item_code":"SB1","received":9,"alloc":{"HQ":9}},
             {"item_code":"SC1","received":1,"damaged":1,"alloc":{"HQ":1}},{"item_code":"SD1","received":4,"alloc":{"BATU":4}}]'::jsonb,
  'wrong', '[{"received_code":"sg1","own":true,"qty":2,"location":"MARS"}]'::jsonb))$q$, pg_temp.id('one')), '来错的货第 1 行：没有这个仓位 MARS');
select pg_temp.expect_error(format($q$select public.ops_po_do_receive(jsonb_build_object('id', %s,
  'items', '[{"item_code":"SA1","received":12,"alloc":{"HQ":9,"JB":3}},{"item_code":"SB1","received":9,"alloc":{"HQ":9}},
             {"item_code":"SC1","received":1,"damaged":1,"alloc":{"HQ":1}},{"item_code":"SD1","received":4,"alloc":{"BATU":4}}]'::jsonb,
  'wrong', '[{"received_code":"","own":false,"qty":1}]'::jsonb))$q$, pg_temp.id('one')), '来错的货第 1 行「不是我们的产品」请填品名');
select pg_temp.expect_error(format($q$select public.ops_po_do_receive(jsonb_build_object('id', %s,
  'items', '[{"item_code":"SA1","received":12,"alloc":{"HQ":9,"JB":3}},{"item_code":"SB1","received":9,"alloc":{"HQ":9}},
             {"item_code":"SC1","received":1,"damaged":1,"alloc":{"HQ":1}},{"item_code":"SD1","received":4,"alloc":{"BATU":4}}]'::jsonb,
  'wrong', '[{"received_code":"zz-9","own":true,"qty":1}]'::jsonb))$q$, pg_temp.id('one')), '来错的货第 1 行：找不到我们的型号 zz-9');
do $$ declare r jsonb; begin
  r := public.ops_po_do_receive(jsonb_build_object('id', pg_temp.id('one'),
    'items', '[{"item_code":"SA1","received":12,"alloc":{"HQ":9,"JB":3}},{"item_code":"SB1","received":9,"alloc":{"HQ":9}},
               {"item_code":"SC1","received":1,"damaged":1,"alloc":{"HQ":1}},{"item_code":"SD1","received":4,"alloc":{"BATU":4}}]'::jsonb,
    'wrong', '[{"received_code":"sg1","own":true,"qty":2,"expected_code":"SC1","request":"replace","location":"SRGADING"},
               {"description":"MYSTERY TAP","own":false,"qty":1,"request":"return"}]'::jsonb));
  assert r ->> 'status' = 'arrived' and jsonb_array_length(r -> 'receipt' -> 'move_ids') = 7, 'received: ' || (r -> 'receipt')::text;
  -- 总部：那行 PO 的仓位（HQ / SRGADING）；JB → PRE (JB)；Batu → PRE (BATU)；多到 → HQ 没有 PO；
  -- SA1 点货时 JB 少分 1 给总部 → 用 JB 那行 PO 没用完的 1 件（仓位 HQ）；坏货不进；来错的货（我们的型号）进选的仓位
  assert pg_temp.moves(pg_temp.id('one')) = 'SA1@HQ/SP-P1/HQ=9,SA1@PRE (JB)/SP-P1/JB=3,SB1@HQ/-/HQ=1,SB1@SRGADING/SP-P1/HQ=8,'
                                            || 'SC1@HQ/SP-P1/HQ=1,SD1@PRE (BATU)/SP-P1/BATU=4,SG1@SRGADING/-/-=2!',
    'moves: ' || pg_temp.moves(pg_temp.id('one'));
  assert (select string_agg(coalesce(x ->> 'own', '-') || ':' || coalesce(x ->> 'request', '-') || ':' || coalesce(x ->> 'location', '-'), ',' order by x ->> 'received_code')
          from jsonb_array_elements(r -> 'receipt' -> 'wrong') x) = 'false:return:-,true:replace:SRGADING', 'receipt wrong: ' || (r -> 'receipt' -> 'wrong')::text;
  assert jsonb_array_length(r -> 'moves') = 7 and (select bool_and(x ->> 'status' = 'pending' and (x ->> 'po_no' is not null or x ->> 'item_code' in ('SB1', 'SG1')))
                                                   from jsonb_array_elements(r -> 'moves') x), 'get moves: ' || (r -> 'moves')::text;
end $$;
select pg_temp.as_user('buyer@example.com');
do $$ declare r jsonb := public.ops_po_do_get(pg_temp.id('one')); begin
  -- 问题：SC1 坏 1；SG1 跟确认时记的同一笔（不重复，那笔已有 return 不改）；MYSTERY 另一笔（return）
  assert pg_temp.iss('4000-S300', pg_temp.id('one')) like '%damaged:SC1//=1,%' and pg_temp.iss('4000-S300', pg_temp.id('one')) like '%wrong:-//=1 return%'
     and pg_temp.iss('4000-S300', pg_temp.id('one')) like '%wrong:SC1/SG1/=2* return', 'receive issues: ' || pg_temp.iss('4000-S300', pg_temp.id('one'));
  -- SOP：到货了还有没决定的缺零件 → 第 7 步（采购）
  -- （缺零件「下次补上」的已经是厂家会补：只剩「其他」的说明书、胶条要决定）
  assert (r -> 'sop' ->> 'step')::int = 7 and r -> 'sop' ->> 'owner' = 'purchasing' and (r -> 'sop' ->> 'decide_n')::int = 2
     and (r -> 'sop' -> 'done' ->> 'received')::boolean and (r -> 'sop' ->> 'grn_n')::int = 7, 'step 7: ' || (r -> 'sop')::text;
  perform public.ops_po_issue_set(array(select (x ->> 'id')::bigint from jsonb_array_elements(r -> 'issues') x
                                        where x ->> 'kind' = 'part' and x ->> 'decision' = 'pending'), 'await');
  r := public.ops_po_do_get(pg_temp.id('one'));
  -- 都决定了，但开单部还没开 GRN：第 8 步等开单部（不是「都做完了」）
  assert (r -> 'sop' ->> 'step')::int = 8 and r -> 'sop' ->> 'owner' = 'billing' and (r -> 'sop' ->> 'grn_n')::int = 7
     and (r -> 'sop' -> 'done' ->> 'decided')::boolean, 'step 8 waits for billing: ' || (r -> 'sop')::text;
end $$;

-- 7b. 仓库：查商品、盘点的「应有」算进进货待入 AutoCount
select pg_temp.as_user('picker@example.com');
do $$ declare w jsonb; c jsonb; begin
  w := public.ops_wh_item('HOMEWORKSSB', 'SB1');
  assert (select (x ->> 'pending')::numeric from jsonb_array_elements(w -> 'stock') x where x ->> 'location' = 'SRGADING') = 8
     and (select (x ->> 'pending')::numeric from jsonb_array_elements(w -> 'stock') x where x ->> 'location' = 'HQ') = 1, 'wh_item pending: ' || (w -> 'stock')::text;
  assert (select (x ->> 'pending')::numeric from jsonb_array_elements(public.ops_wh_item('HOMEWORKSSB', 'SD1') -> 'stock') x
          where x ->> 'location' = 'PRE (BATU)') = 4, 'PRE (BATU) listed';
  c := public.ops_wh_count_save('{"company":"HOMEWORKSSB","location":"SRGADING","item_code":"SB1","qty":8}');
  assert c ->> 'result' = 'match', 'count expects pending receive: ' || c::text;
  -- 搬动清单：进货另外一类；看得到厂家的人有 DO 号 / PO / 厂家
  w := public.ops_wh_moves('{"kind":"receive"}');
  assert (select count(*) from jsonb_array_elements(w) x where (x ->> 'do_id')::bigint = pg_temp.id('one')) = 7
     and (select bool_and(x ->> 'do_no' = 'SOP-1' and x ->> 'supplier_name' = 'MULTI GLOBE' and x ->> 'kind' = 'receive')
          from jsonb_array_elements(w) x where (x ->> 'do_id')::bigint = pg_temp.id('one')), 'receive moves: ' || w::text;
  assert not exists (select 1 from jsonb_array_elements(public.ops_wh_moves('{"kind":"move","status":"all"}')) x where x ->> 'kind' = 'receive'), 'move filter';
end $$;
select pg_temp.expect_error($q$select public.ops_wh_move_save('{"company":"HOMEWORKSSB","item_code":"SB1","qty":1,"kind":"receive","to_loc":"HQ"}')$q$,
  '未知的搬动种类');
select public.ops_wh_move_save('{"company":"HOMEWORKSSB","item_code":"ST001","qty":1,"kind":"transfer","from_loc":"HQ","to_loc":"SRGADING"}') ->> 'kind';
-- 门市（仓库只看）：看得到进货，但没有 DO 号、PO、厂家
select pg_temp.as_user('hqsales@example.com');
do $$ declare w jsonb := public.ops_wh_moves('{"kind":"receive"}'); begin
  assert jsonb_array_length(w) > 0 and (select bool_and(x -> 'po_no' = 'null'::jsonb and x -> 'do_no' = 'null'::jsonb and x -> 'supplier_name' = 'null'::jsonb)
                                        from jsonb_array_elements(w) x), 'sales masked: ' || w::text;
  assert (select bool_and(x -> 'po_no' = 'null'::jsonb) from jsonb_array_elements(public.ops_wh_item('HOMEWORKSSB', 'SB1') -> 'moves') x
          where x ->> 'kind' = 'receive'), 'wh_item moves masked';
end $$;
select pg_temp.expect_error($q$select public.ops_wh_grn_list()$q$, '只有开单部或仓库「可审批」');
select pg_temp.as_user('picker@example.com');
select pg_temp.expect_error($q$select public.ops_wh_grn_list()$q$, '只有开单部或仓库「可审批」');
select pg_temp.expect_error(format($q$select public.ops_wh_move_mark(array(select id from jsonb_to_recordset(public.ops_wh_moves('{"kind":"receive"}')) as t(id bigint, do_id bigint) where do_id = %s), 'done', 'GRN-X')$q$,
  pg_temp.id('one')), '进货待入 AutoCount 只有开单部或仓库「可审批」');

-- 8. 开单部：待开进货单、AutoCount 可能已输入（照在路上的先出先到算，不会自动标）、标已输入一定要 GRN 号
reset role;
-- AutoCount 今天开了 SP-P1 SB1 8 件的 GRN（BI 同步：进货单 + PO 行已收一起进来）
insert into bi.fact_po_receipt (company, src, dtl_key, doc_no, rcv_date, po_no, item_code, qty) values
  ('HOMEWORKSSB', 'GR', 8003, 'GRN-0001', pg_temp.kl_today(), 'SP-P1', 'SB1', 8);
update bi.fact_po_line set transferred_qty = 8 where company = 'HOMEWORKSSB' and dtl_key = 8003;
set role authenticated;
select pg_temp.as_user('bill@example.com');
do $$ declare l jsonb; g jsonb; h jsonb := public.ops_home(); n bigint; x jsonb; begin
  l := public.ops_wh_grn_list();
  assert l ->> 'status' = 'pending' and (h ->> 'grn_pending')::int = jsonb_array_length(l -> 'groups'), 'grn_pending = groups: ' || h::text;
  g := (select y from jsonb_array_elements(l -> 'groups') y where (y ->> 'do_id')::bigint = pg_temp.id('one'));
  assert g ->> 'do_no' = 'SOP-1' and g ->> 'supplier_name' = 'MULTI GLOBE' and g -> 'po_nos' = '["SP-P1"]'::jsonb and (g ->> 'pending_n')::int = 7
     and jsonb_array_length(g -> 'lines') = 7 and g -> 'grn_docs' = '["GRN-0001"]'::jsonb and g ->> 'arrived_by_name' = '仓库小李', 'group: ' || coalesce(g::text, l::text);
  -- 只提示有 PO 的那行（8 件，一张就够 → 一键标）；没有 PO 的多到 1 件不提示（PO 只有 8 件，GRN 是那 8 件的）
  x := (select y from jsonb_array_elements(g -> 'lines') y where y ->> 'item_code' = 'SB1' and y ->> 'location' = 'SRGADING');
  assert x -> 'grn_hint' = jsonb_build_array(jsonb_build_object('qty', 8, 'doc_no', 'GRN-0001', 'rcv_date', pg_temp.kl_today()))
     and (x ->> 'hint_qty')::numeric = 8 and x ->> 'one_doc' = 'GRN-0001' and (x ->> 'po_full')::boolean, 'SB1 PO line hint: ' || x::text;
  assert (select bool_and(y -> 'grn_hint' = '[]'::jsonb and (y ->> 'hint_qty')::numeric = 0 and y -> 'one_doc' = 'null'::jsonb)
          from jsonb_array_elements(g -> 'lines') y where not (y ->> 'item_code' = 'SB1' and y ->> 'location' = 'SRGADING')),
    'no other hints (over line not hinted): ' || (g -> 'lines')::text;
  assert pg_temp.no_price(l), 'no prices';
  assert jsonb_array_length(public.ops_wh_grn_list('{"q":"sop-1"}') -> 'groups') = 1 and jsonb_array_length(public.ops_wh_grn_list('{"q":"multi globe"}') -> 'groups') >= 1,
    'search do / supplier';
  -- 一般搬动：开单部不能标
  n := (select (y ->> 'id')::bigint from jsonb_array_elements(public.ops_wh_moves('{"kind":"move"}')) y where y ->> 'item_code' = 'ST001' order by (y ->> 'id')::bigint desc limit 1);
  perform pg_temp.expect_error(format('select public.ops_wh_move_mark(array[%s::bigint], %L, %L)', n, 'done', 'X'), '只有仓库「可审批」的人可以标已输入 AutoCount');
  -- 没填 GRN 号
  perform pg_temp.expect_error(format('select public.ops_wh_move_mark(array[%s::bigint], %L, %L)',
    (g -> 'lines' -> 0 ->> 'id'), 'done', '  '), '请填 AutoCount 进货单（GRN）号码');
  -- 开单部不能取消（只能标已输入）
  perform pg_temp.expect_error(format('select public.ops_wh_move_mark(array[%s::bigint], %L, %L, %L)',
    (g -> 'lines' -> 0 ->> 'id'), 'cancelled', '', '不要了'), '只有仓库「可审批」的人（仓库主管、管理层）可以取消');
  -- 照提示一键标 SB1 有 PO 那行
  assert public.ops_wh_move_mark(array[(x ->> 'id')::bigint], 'done', x ->> 'one_doc') = 1, 'billing marks done';
end $$;
-- 没有自动标：其他还在待开；GRN-0001 用掉了就不再提示；done 清单
do $$ declare l jsonb; g jsonb; begin
  assert pg_temp.moves(pg_temp.id('one')) = 'SA1@HQ/SP-P1/HQ=9,SA1@PRE (JB)/SP-P1/JB=3,SB1@HQ/-/HQ=1,SB1@SRGADING/SP-P1/HQ=8 done,'
                                            || 'SC1@HQ/SP-P1/HQ=1,SD1@PRE (BATU)/SP-P1/BATU=4,SG1@SRGADING/-/-=2!', 'after mark: ' || pg_temp.moves(pg_temp.id('one'));
  g := (select x from jsonb_array_elements(public.ops_wh_grn_list() -> 'groups') x where (x ->> 'do_id')::bigint = pg_temp.id('one'));
  assert (g ->> 'pending_n')::int = 6 and g -> 'grn_docs' = '[]'::jsonb
     and (select bool_and(x -> 'grn_hint' = '[]'::jsonb) from jsonb_array_elements(g -> 'lines') x), 'pending 6, no hints: ' || g::text;
  l := public.ops_wh_grn_list('{"status":"done"}');
  g := (select x from jsonb_array_elements(l -> 'groups') x where (x ->> 'do_id')::bigint = pg_temp.id('one'));
  assert jsonb_array_length(g -> 'lines') = 1 and (select bool_and(x ->> 'ac_doc' = 'GRN-0001' and x ->> 'done_by_name' = '开单小陈')
                                                   from jsonb_array_elements(g -> 'lines') x), 'done list: ' || g::text;
  assert jsonb_array_length((select x from jsonb_array_elements(public.ops_wh_grn_list('{"status":"all"}') -> 'groups') x
                             where (x ->> 'do_id')::bigint = pg_temp.id('one')) -> 'lines') = 7, 'all';
end $$;
select pg_temp.expect_error($q$select public.ops_wh_grn_list('{"status":"x"}')$q$, '未知的状态');
-- 取消进货：点货的人自己不能取消（不然点到的货可以不进 AutoCount）；仓库「可审批」才可以，而且要写原因
select pg_temp.as_user('wh.r@example.com');
select pg_temp.expect_error(format($q$select public.ops_wh_move_mark(array(select m.id from ops.wh_move m where m.do_id = %s and m.recv_wrong), 'cancelled', '', '不入库')$q$,
  pg_temp.id('one')), 'permission denied');
do $$ begin
  perform pg_temp.expect_error(format($q$select public.ops_wh_move_mark(array(select (x ->> 'id')::bigint from jsonb_array_elements(public.ops_wh_moves('{"kind":"receive"}')) x
                                       where (x ->> 'do_id')::bigint = %s and (x ->> 'recv_wrong')::boolean), 'cancelled', '', '不入库')$q$, pg_temp.id('one')),
    '只有仓库「可审批」的人（仓库主管、管理层）可以取消');
end $$;
select pg_temp.as_user('whmgr@example.com');
do $$ declare ids bigint[] := array(select (x ->> 'id')::bigint from jsonb_array_elements(public.ops_wh_moves('{"kind":"receive"}')) x
                                    where (x ->> 'do_id')::bigint = pg_temp.id('one') and (x ->> 'recv_wrong')::boolean);
begin
  perform pg_temp.expect_error(format('select public.ops_wh_move_mark(%L::bigint[], %L)', ids, 'cancelled'), '取消进货要写原因');
  assert public.ops_wh_move_mark(ids, 'cancelled', '', '其实是样品，不入库') = 1, 'manager cancels with reason';
end $$;
-- 取消的在「全部」看得到（谁、什么时候、原因）
select pg_temp.as_user('bill@example.com');
do $$ declare x jsonb; begin
  x := (select y from jsonb_array_elements((select g from jsonb_array_elements(public.ops_wh_grn_list('{"status":"all"}') -> 'groups') g
                                            where (g ->> 'do_id')::bigint = pg_temp.id('one')) -> 'lines') y where (y ->> 'recv_wrong')::boolean);
  assert x ->> 'status' = 'cancelled' and x ->> 'note' = '取消：其实是样品，不入库' and x ->> 'done_by_name' = '仓库主管' and x ->> 'done_at' is not null,
    'cancelled listed: ' || coalesce(x::text, '-');
end $$;
-- 开单部的仓库被个人例外设成「无」：看不到待开进货单、首页不提醒（收回权限）
select pg_temp.as_user('boss@example.com');
select public.ops_staff_save(jsonb_build_object('id', pg_temp.staff_id('bill@example.com'), 'email', 'bill@example.com',
  'name', '开单小陈', 'department', 'billing', 'overrides', '{"warehouse":"none"}'::jsonb)) ->> 'id' is not null;
select pg_temp.as_user('bill@example.com');
select pg_temp.expect_error($q$select public.ops_wh_grn_list()$q$, '只有开单部或仓库「可审批」');
do $$ begin assert public.ops_home() -> 'grn_pending' = 'null'::jsonb, 'no grn reminder when warehouse none'; end $$;
select pg_temp.as_user('boss@example.com');
select public.ops_staff_save(jsonb_build_object('id', pg_temp.staff_id('bill@example.com'), 'email', 'bill@example.com',
  'name', '开单小陈', 'department', 'billing', 'overrides', '{"warehouse":""}'::jsonb)) ->> 'id' is not null;
select pg_temp.as_user('bill@example.com');
do $$ begin assert (public.ops_home() ->> 'grn_pending')::int >= 1, 'restored'; end $$;
-- 门市代班（仓库可审批）：看得到待开进货单、可以标，但没有厂家、DO 号、PO
select pg_temp.as_user('whover@example.com');
do $$ declare g jsonb; begin
  g := (select x from jsonb_array_elements(public.ops_wh_grn_list() -> 'groups') x where (x ->> 'do_id')::bigint = pg_temp.id('one'));
  assert g -> 'do_no' = 'null'::jsonb and g -> 'supplier_name' = 'null'::jsonb and g -> 'po_nos' = '[]'::jsonb
     and (select bool_and(x -> 'po_no' = 'null'::jsonb) from jsonb_array_elements(g -> 'lines') x) and (g ->> 'pending_n')::int = 5, 'masked: ' || g::text;
  assert jsonb_array_length(public.ops_wh_grn_list('{"q":"multi globe"}') -> 'groups') = 0, 'masked search';
  assert public.ops_wh_move_mark(array(select (x ->> 'id')::bigint from jsonb_array_elements(g -> 'lines') x where x ->> 'item_code' = 'SC1'),
                                 'done', 'GRN-0002') = 1, 'whover marks';
end $$;
-- 仓库主管：首页的一般搬动不再算进货；待开进货单也看得到
select pg_temp.as_user('whmgr@example.com');
do $$ declare h jsonb := public.ops_home(); begin
  assert (h ->> 'wh_moves_pending')::int = jsonb_array_length(public.ops_wh_moves('{"kind":"move"}')), 'wh_moves_pending excludes receive: ' || h::text;
  assert (h ->> 'grn_pending')::int = jsonb_array_length(public.ops_wh_grn_list() -> 'groups'), 'whmgr grn_pending';
end $$;

-- 8b. GRN 提示照先出先到：同一张 PO 两批货（第一批的 GRN 不会让第二批也说「可能已输入」）；
--     本地货先开 GRN 再点货（pre_grn：不重复算库存、等开单部核对）；GRN 日期早于 DO 日期（照数量提示 + PO 已全收）
reset role;
insert into bi.v_supplier_param values ('HOMEWORKSSB', '400-S303', 'LOCAL GRN', false, 7);
insert into bi.fact_po_line (company, dtl_key, po_no, po_date, creditor_code, creditor_name, item_code, description,
                             location, uom, qty, transferred_qty, unit_price) values
  ('HOMEWORKSSB', 8030, 'SG-P1', current_date - 6, '400-S303', 'LOCAL GRN', 'SA1', 'BASIN SA1', 'HQ', 'PCS', 10, 0, 1),
  ('HOMEWORKSSB', 8031, 'SG-P2', current_date - 6, '400-S303', 'LOCAL GRN', 'SB1', 'TAP SB1', 'HQ', 'PCS', 5, 0, 1),
  ('HOMEWORKSSB', 8032, 'SG-P3', current_date - 30, '400-S303', 'LOCAL GRN', 'SC1', 'SINK SC1', 'HQ', 'PCS', 2, 0, 1);
-- 先开了 GRN 才登记 DO：SG-P2 SB1 5 件，昨天
insert into bi.fact_po_receipt (company, src, dtl_key, doc_no, rcv_date, po_no, item_code, qty) values
  ('HOMEWORKSSB', 'GR', 8031, 'GRN-EARLY', pg_temp.kl_today() - 1, 'SG-P2', 'SB1', 5);
update bi.fact_po_line set transferred_qty = 5 where dtl_key = 8031;
insert into bi.fact_stock values ('HOMEWORKSSB', 'SB1', 'HQ', 5, 5);
set role authenticated;
select pg_temp.as_user('buyer@example.com');
do $$ declare v bigint; begin
  v := pg_temp.mkdo('{"creditor_code":"400-S303","po_nos":["SG-P1"],"do_no":"GA","items":[{"item_code":"SA1","shipped":4,"alloc":{"HQ":4}}]}');
  perform pg_temp.keep('ga', v);
  perform public.ops_po_do_confirm(v);
  v := pg_temp.mkdo('{"creditor_code":"400-S303","po_nos":["SG-P1"],"do_no":"GB","items":[{"item_code":"SA1","shipped":3,"alloc":{"HQ":3}}]}');
  perform pg_temp.keep('gb', v);
  perform public.ops_po_do_confirm(v);
  v := pg_temp.mkdo(jsonb_build_object('creditor_code', '400-S303', 'po_nos', '["SG-P2"]'::jsonb, 'do_no', 'GC',
                                       'do_date', pg_temp.kl_today() - 1, 'items', '[{"item_code":"SB1","shipped":5,"alloc":{"HQ":5}}]'::jsonb));
  perform pg_temp.keep('gc', v);
  perform public.ops_po_do_confirm(v);
  v := pg_temp.mkdo(jsonb_build_object('creditor_code', '400-S303', 'po_nos', '["SG-P3"]'::jsonb, 'do_no', 'GD',
                                       'do_date', pg_temp.kl_today(), 'items', '[{"item_code":"SC1","shipped":2,"alloc":{"HQ":2}}]'::jsonb));
  perform pg_temp.keep('gd', v);
  perform public.ops_po_do_confirm(v);
end $$;
select pg_temp.as_user('wh.r@example.com');
do $$ declare w jsonb; begin
  perform public.ops_po_do_receive(jsonb_build_object('id', pg_temp.id('ga'), 'items', '[{"item_code":"SA1","received":4,"alloc":{"HQ":4}}]'::jsonb));
  perform public.ops_po_do_receive(jsonb_build_object('id', pg_temp.id('gb'), 'items', '[{"item_code":"SA1","received":3,"alloc":{"HQ":3}}]'::jsonb));
  perform public.ops_po_do_receive(jsonb_build_object('id', pg_temp.id('gc'), 'items', '[{"item_code":"SB1","received":5,"alloc":{"HQ":5}}]'::jsonb));
  perform public.ops_po_do_receive(jsonb_build_object('id', pg_temp.id('gd'), 'items', '[{"item_code":"SC1","received":2,"alloc":{"HQ":2}}]'::jsonb));
  assert pg_temp.moves(pg_temp.id('gc')) = 'SB1@HQ/SG-P2/HQ=5', 'gc move: ' || pg_temp.moves(pg_temp.id('gc'));
  -- 点货时 AutoCount 已经有 GRN-EARLY：记 pre_grn，不另算库存（HQ 的 SB1 只有 SOP-1 没有 PO 的那 1 件待入）
  w := public.ops_wh_item('HOMEWORKSSB', 'SB1');
  assert (select (x ->> 'qty')::numeric = 5 and (x ->> 'pending')::numeric = 1 from jsonb_array_elements(w -> 'stock') x where x ->> 'location' = 'HQ'),
    'no double count: ' || (w -> 'stock')::text;
  assert (select (x ->> 'pre_grn') from jsonb_array_elements(public.ops_po_receive_get(pg_temp.id('gc')) -> 'moves') x) = 'GRN-EARLY', 'receive_get pre_grn';
  assert (select x -> 'pre_grn' from jsonb_array_elements(public.ops_po_receive_get(pg_temp.id('ga')) -> 'moves') x) = 'null'::jsonb, 'ga normal';
end $$;
select pg_temp.as_user('picker@example.com');
do $$ begin
  -- 盘点：AutoCount 5 + 待入 1 = 6（没有把 GRN-EARLY 的 5 件再加一次）
  assert public.ops_wh_count_save('{"company":"HOMEWORKSSB","location":"HQ","item_code":"SB1","qty":6}') ->> 'result' = 'match', 'count with pre_grn';
end $$;
reset role;
-- AutoCount 今天开了第一批的 GRN（SG-P1 SA1 4 件）
insert into bi.fact_po_receipt (company, src, dtl_key, doc_no, rcv_date, po_no, item_code, qty) values
  ('HOMEWORKSSB', 'GR', 8030, 'GRN-A', pg_temp.kl_today(), 'SG-P1', 'SA1', 4);
update bi.fact_po_line set transferred_qty = 4 where dtl_key = 8030;
-- SG-P3：AutoCount 的 GRN 日期打成 DO 日期之前（窗口外），PO 已经全收
insert into bi.fact_po_receipt (company, src, dtl_key, doc_no, rcv_date, po_no, item_code, qty) values
  ('HOMEWORKSSB', 'GR', 8032, 'GRN-OLD', pg_temp.kl_today() - 10, 'SG-P3', 'SC1', 2);
update bi.fact_po_line set transferred_qty = 2 where dtl_key = 8032;
set role authenticated;
select pg_temp.as_user('bill@example.com');
do $$ declare l jsonb; a jsonb; b jsonb; c jsonb; dd jsonb; begin
  l := public.ops_wh_grn_list('{"q":"local grn"}');
  a := (select g -> 'lines' -> 0 from jsonb_array_elements(l -> 'groups') g where (g ->> 'do_id')::bigint = pg_temp.id('ga'));
  b := (select g -> 'lines' -> 0 from jsonb_array_elements(l -> 'groups') g where (g ->> 'do_id')::bigint = pg_temp.id('gb'));
  c := (select g -> 'lines' -> 0 from jsonb_array_elements(l -> 'groups') g where (g ->> 'do_id')::bigint = pg_temp.id('gc'));
  dd := (select g -> 'lines' -> 0 from jsonb_array_elements(l -> 'groups') g where (g ->> 'do_id')::bigint = pg_temp.id('gd'));
  assert a ->> 'one_doc' = 'GRN-A' and (a ->> 'hint_qty')::numeric = 4, 'first batch hinted: ' || a::text;
  assert b -> 'grn_hint' = '[]'::jsonb and (b ->> 'hint_qty')::numeric = 0 and not (b ->> 'po_full')::boolean, 'second batch not hinted: ' || b::text;
  assert c ->> 'pre_grn' = 'GRN-EARLY' and (c ->> 'hint_qty')::numeric = 0 and c -> 'grn_hint' = '[]'::jsonb, 'pre_grn line: ' || c::text;
  assert (select g -> 'grn_docs' from jsonb_array_elements(l -> 'groups') g where (g ->> 'do_id')::bigint = pg_temp.id('gc')) = '["GRN-EARLY"]'::jsonb, 'gc docs';
  assert dd -> 'grn_hint' = '[]'::jsonb and (dd ->> 'hint_qty')::numeric = 2 and dd -> 'one_doc' = 'null'::jsonb and (dd ->> 'po_full')::boolean,
    'gd: received by quantity, PO full, no doc in window: ' || dd::text;
  assert public.ops_wh_move_mark(array[(a ->> 'id')::bigint], 'done', 'GRN-A') = 1, 'mark first';
  assert public.ops_wh_move_mark(array[(c ->> 'id')::bigint], 'done', c ->> 'pre_grn') = 1, 'mark pre_grn';
  b := (select g -> 'lines' -> 0 from jsonb_array_elements(public.ops_wh_grn_list('{"q":"local grn"}') -> 'groups') g where (g ->> 'do_id')::bigint = pg_temp.id('gb'));
  assert b -> 'grn_hint' = '[]'::jsonb, 'still not hinted after first marked: ' || b::text;
end $$;
reset role;
insert into bi.fact_po_receipt (company, src, dtl_key, doc_no, rcv_date, po_no, item_code, qty) values
  ('HOMEWORKSSB', 'GR', 8030, 'GRN-B', pg_temp.kl_today(), 'SG-P1', 'SA1', 3);
update bi.fact_po_line set transferred_qty = 7 where dtl_key = 8030;
set role authenticated;
select pg_temp.as_user('bill@example.com');
do $$ declare b jsonb; begin
  b := (select g -> 'lines' -> 0 from jsonb_array_elements(public.ops_wh_grn_list('{"q":"local grn"}') -> 'groups') g where (g ->> 'do_id')::bigint = pg_temp.id('gb'));
  assert b ->> 'one_doc' = 'GRN-B' and b -> 'grn_hint' = jsonb_build_array(jsonb_build_object('qty', 3, 'doc_no', 'GRN-B', 'rcv_date', pg_temp.kl_today())),
    'second batch hinted with its own GRN: ' || b::text;
end $$;

-- 9. JB 账套：进 JB 账套那行 PO 的仓位；来错的货预设 JB 账套的主要仓位（JB），没有 HQ；总部的开单部看不到
select pg_temp.as_user('jbbuyer@example.com');
do $$ declare v bigint; begin
  v := pg_temp.mkdo('{"creditor_code":"400-S302","po_nos":["SJ-P1"],"do_no":"SJ-1","items":[{"item_code":"SJ1","shipped":6,"alloc":{"JB":6}}]}');
  perform pg_temp.keep('jb', v);
  perform public.ops_po_do_confirm(v);
end $$;
select pg_temp.as_user('wh.jb@example.com');
do $$ declare g jsonb := public.ops_po_receive_get(pg_temp.id('jb')); begin
  assert g ->> 'main_location' = 'JB' and g -> 'locations' = '["JB"]'::jsonb, 'JB locations: ' || (g -> 'locations')::text;
end $$;
select pg_temp.expect_error(format($q$select public.ops_po_do_receive(jsonb_build_object('id', %s, 'items', '[{"item_code":"SJ1","received":6,"alloc":{"JB":6}}]'::jsonb,
  'wrong', '[{"received_code":"st001","own":true,"qty":1,"location":"HQ"}]'::jsonb))$q$, pg_temp.id('jb')), '来错的货第 1 行：没有这个仓位 HQ');
do $$ declare r jsonb; begin
  r := public.ops_po_do_receive(jsonb_build_object('id', pg_temp.id('jb'), 'items', '[{"item_code":"SJ1","received":6,"alloc":{"JB":6}}]'::jsonb,
    'wrong', '[{"received_code":"st001","own":true,"qty":1}]'::jsonb));
  assert pg_temp.moves(pg_temp.id('jb')) = 'SJ1@MAIN/SJ-P1/JB=5,SJ1@MAIN/-/JB=1,ST001@JB/-/-=1!', 'JB moves (over 1 no PO, wrong → JB): ' || pg_temp.moves(pg_temp.id('jb'));
  assert (select (x ->> 'pending')::numeric from jsonb_array_elements(public.ops_wh_item('HOMEWORKSSOUTHERN', 'SJ1') -> 'stock') x
          where x ->> 'location' = 'MAIN') = 6, 'JB pending';
end $$;
select pg_temp.as_user('bill@example.com');
do $$ begin
  assert not exists (select 1 from jsonb_array_elements(public.ops_wh_grn_list() -> 'groups') x where (x ->> 'do_id')::bigint = pg_temp.id('jb')),
    'HQ billing does not see JB';
end $$;
select pg_temp.as_user('boss@example.com');
do $$ begin
  assert exists (select 1 from jsonb_array_elements(public.ops_wh_grn_list('{"company":"HOMEWORKSSOUTHERN"}') -> 'groups') x
                 where (x ->> 'do_id')::bigint = pg_temp.id('jb') and x ->> 'company' = 'HOMEWORKSSOUTHERN'), 'admin sees JB';
end $$;

-- 10. 厂家还欠第二家工厂（CS202）：Excel 对不上的行没填要厂家怎么处理，点货时补上；SOP 清单
select pg_temp.as_user('buyer@example.com');
do $$ declare v bigint; begin
  v := pg_temp.mkdo('{"creditor_code":"4000-S300","po_nos":["SP-P2"],"do_no":"SOP-2","eta":"2026-12-01",
    "items":[{"item_code":"SE1","shipped":7,"alloc":{"HQ":7}},{"src_code":"XX-9","src_desc":"ODD","src_row":5,"shipped":1}]}');
  perform pg_temp.keep('two', v);
  perform public.ops_po_do_confirm(v);
end $$;
select pg_temp.as_user('wh.r@example.com');
do $$ begin
  perform public.ops_po_do_receive(jsonb_build_object('id', pg_temp.id('two'), 'items', '[{"item_code":"SE1","received":7,"alloc":{"HQ":7}}]'::jsonb,
    'wrong', '[{"received_code":"xx-9","qty":1,"request":"return"}]'::jsonb));
end $$;
select pg_temp.as_user('buyer@example.com');
do $$ declare o jsonb; begin
  assert pg_temp.iss('4000-S300', pg_temp.id('two')) = 'short:SE1//=3* pending,wrong:-/XX-9/=1* return', 'SOP-2: ' || pg_temp.iss('4000-S300', pg_temp.id('two'));
  o := public.ops_po_issues('{"creditor_code":"4000-S300","owed":true}');
  assert (select string_agg(coalesce(x ->> 'factory', '-') || ':' || (x ->> 'kind') || '=' || (x ->> 'owed_qty'), ',' order by x ->> 'factory', x ->> 'kind', (x ->> 'id')::bigint)
          from jsonb_array_elements(o) x) = 'CS201:part=4,CS201:part=1,CS201:part=1,CS201:part=2,CS201:part=1,CS201:part=3,CS201:short=4,CS202:short=3',
    'owed by factory: ' || (select string_agg(coalesce(x ->> 'factory', '-') || ':' || (x ->> 'kind') || coalesce(x ->> 'part_name', '') || '=' || (x ->> 'owed_qty'), ','
                                              order by x ->> 'factory', x ->> 'kind', (x ->> 'id')::bigint) from jsonb_array_elements(o) x);
end $$;

-- 12. 开单时记的来错型号，点货画面带进来（do_row）：跟确认时记的那笔对上，不重复记；点货的人改选我们的型号 → 进库存
select pg_temp.as_user('buyer@example.com');
do $$ declare v bigint; begin
  v := pg_temp.mkdo('{"creditor_code":"4000-S300","po_nos":["SP-P2"],"do_no":"SOP-3",
    "items":[{"item_code":"SE1","shipped":3,"alloc":{"HQ":3}},
             {"src_code":"QQ-1","src_desc":"ODD BASIN","shipped":2,"expected_code":"SE1"},
             {"src_code":"","src_desc":"BOX OF SCREWS","shipped":1,"own":false},
             {"src_code":"SG1","shipped":1,"own":true,"request":"replace"}]}');
  perform pg_temp.keep('three', v);
  perform public.ops_po_do_confirm(v);
  assert pg_temp.iss('4000-S300', v) = 'wrong:-//=1*,wrong:-/SG1/=1* replace,wrong:SE1/QQ-1/=2*', 'SOP-3 confirm: ' || pg_temp.iss('4000-S300', v);
end $$;
select pg_temp.as_user('wh.r@example.com');
do $$ declare g jsonb := public.ops_po_receive_get(pg_temp.id('three')); begin
  assert (select string_agg((x ->> 'row') || ':' || coalesce(x ->> 'own', '-') || ':' || (x ->> 'src_code'), ',' order by (x ->> 'row')::int)
          from jsonb_array_elements(g -> 'unmatched') x) = '2:-:QQ-1,3:false:,4:true:SG1', 'rows: ' || (g -> 'unmatched')::text;
end $$;
select pg_temp.expect_error(format($q$select public.ops_po_do_receive(jsonb_build_object('id', %s, 'items', '[{"item_code":"SE1","received":3,"alloc":{"HQ":3}}]'::jsonb,
  'wrong', '[{"do_row":1,"own":true,"received_code":"SA1","qty":1}]'::jsonb))$q$, pg_temp.id('three')), '对不上开单时的那一行');
select pg_temp.expect_error(format($q$select public.ops_po_do_receive(jsonb_build_object('id', %s, 'items', '[{"item_code":"SE1","received":3,"alloc":{"HQ":3}}]'::jsonb,
  'wrong', '[{"do_row":2,"own":true,"received_code":"SA1","qty":1},{"do_row":2,"own":false,"description":"X","qty":1}]'::jsonb))$q$, pg_temp.id('three')),
  '开单时的同一行重复了');
do $$ declare r jsonb; begin
  r := public.ops_po_do_receive(jsonb_build_object('id', pg_temp.id('three'), 'items', '[{"item_code":"SE1","received":3,"alloc":{"HQ":3}}]'::jsonb,
    'wrong', '[{"do_row":2,"own":true,"received_code":"sa1","qty":2,"expected_code":"SE1","location":"SRGADING"},
               {"do_row":3,"own":false,"description":"BOX OF SCREWS","qty":1},
               {"do_row":4,"own":true,"received_code":"SG1","qty":1}]'::jsonb));
  assert jsonb_array_length(r -> 'receipt' -> 'issue_ids') = 0, 'no new issues: ' || (r -> 'receipt')::text;
  assert (select string_agg((x ->> 'do_row') || ':' || (x ->> 'received_code'), ',' order by (x ->> 'do_row')::int) from jsonb_array_elements(r -> 'receipt' -> 'wrong') x)
         = '2:SA1,3:,4:SG1', 'receipt keeps do_row: ' || (r -> 'receipt' -> 'wrong')::text;
  assert pg_temp.moves(pg_temp.id('three')) = 'SA1@SRGADING/-/-=2!,SE1@HQ/SP-P2/HQ=3,SG1@HQ/-/-=1!', 'SOP-3 moves: ' || pg_temp.moves(pg_temp.id('three'));
end $$;
select pg_temp.as_user('buyer@example.com');
do $$ begin
  assert pg_temp.iss('4000-S300', pg_temp.id('three')) = 'wrong:-//=1*,wrong:-/SG1/=1* replace,wrong:SE1/QQ-1/=2*', 'SOP-3 not duplicated: '
    || pg_temp.iss('4000-S300', pg_temp.id('three'));
end $$;

-- 13. 点货后补记：坏货 / 到货少扣还没输入 AutoCount 的进货；已经输入的扣不到（stock_left）；来错的货（我们的型号）多一笔进货
select pg_temp.as_user('picker@example.com');
do $$ declare r jsonb; w jsonb; begin
  r := public.ops_po_issue_add(jsonb_build_object('do_id', pg_temp.id('three'), 'kind', 'damaged', 'item_code', 'SE1', 'qty', 2, 'note', '裂开'));
  assert (r ->> 'stock_left')::numeric = 0 and pg_temp.moves(pg_temp.id('three')) like '%SE1@HQ/SP-P2/HQ=1,%', 'damaged reduces pending: ' || pg_temp.moves(pg_temp.id('three'));
  r := public.ops_po_issue_add(jsonb_build_object('do_id', pg_temp.id('three'), 'kind', 'short', 'item_code', 'SE1', 'qty', 1));
  assert (r ->> 'stock_left')::numeric = 0 and pg_temp.moves(pg_temp.id('three')) like '%SE1@HQ/SP-P2/HQ=1 cancelled,%', 'short cancels the rest: ' || pg_temp.moves(pg_temp.id('three'));
  w := public.ops_wh_item('HOMEWORKSSB', 'SE1');
  -- （HQ 的 SE1 只剩 SOP-2 那 7 件待入；SOP-3 的 3 件：坏 2、到货少 1，都扣掉了）
  assert (select (x ->> 'pending')::numeric from jsonb_array_elements(w -> 'stock') x where x ->> 'location' = 'HQ') = 7, 'SE1 pending: ' || (w -> 'stock')::text;
  -- SOP-1 的 SB1：有 PO 的 8 件已输入 AutoCount，只有没有 PO 的 1 件还在待入 → 扣 1，2 件扣不到
  r := public.ops_po_issue_add(jsonb_build_object('do_id', pg_temp.id('one'), 'kind', 'damaged', 'item_code', 'SB1', 'qty', 3));
  assert (r ->> 'stock_left')::numeric = 2 and pg_temp.moves(pg_temp.id('one')) like '%SB1@HQ/-/HQ=1 cancelled,SB1@SRGADING/SP-P1/HQ=8 done,%',
    'stock_left: ' || r::text || ' ' || pg_temp.moves(pg_temp.id('one'));
end $$;
select pg_temp.expect_error(format($q$select public.ops_po_issue_add('{"do_id":%s,"kind":"wrong","own":true,"received_code":"sc1","qty":1,"location":"MARS"}')$q$,
  pg_temp.id('three')), '没有这个仓位 MARS');
do $$ declare r jsonb; v bigint; begin
  r := public.ops_po_issue_add(jsonb_build_object('do_id', pg_temp.id('three'), 'kind', 'wrong', 'own', true, 'received_code', 'sc1', 'qty', 1));
  assert r ->> 'move_id' is not null and pg_temp.moves(pg_temp.id('three')) like 'SA1@SRGADING/-/-=2!,SC1@HQ/-/-=1!,%', 'wrong after receipt → move: ' || pg_temp.moves(pg_temp.id('three'));
  -- 还没点货的 DO：只记问题，点货时才进库存
  perform set_config('request.jwt.claims', json_build_object('email', 'buyer@example.com')::text, false);
  v := pg_temp.mkdo('{"creditor_code":"400-S301","po_nos":["SP-L1"],"do_no":"L1-A","items":[{"item_code":"SA1","shipped":1,"alloc":{"HQ":1}}]}');
  perform public.ops_po_do_confirm(v);
  perform set_config('request.jwt.claims', json_build_object('email', 'picker@example.com')::text, false);
  r := public.ops_po_issue_add(jsonb_build_object('do_id', v, 'kind', 'wrong', 'own', true, 'received_code', 'sg1', 'qty', 1));
  assert r -> 'move_id' = 'null'::jsonb and pg_temp.moves(v) = '', 'confirmed DO: no move yet';
end $$;

-- 11. anon / 内部函数
reset role;
set role anon;
select pg_temp.expect_error($q$select public.ops_po_item_search('', 'x')$q$, 'permission denied');
select pg_temp.expect_error($q$select public.ops_wh_grn_list()$q$, 'permission denied');
reset role;
set role authenticated;
select pg_temp.expect_error($q$select ops.grn_can_mark(null)$q$, 'permission denied');
select pg_temp.expect_error($q$select ops.podo_recv_loc('HOMEWORKSSB', 'HQ', null, null)$q$, 'permission denied');
select pg_temp.expect_error($q$select * from ops.podo_do_rcv('HOMEWORKSSB', '4000-S300', 1)$q$, 'permission denied');
select pg_temp.expect_error($q$select * from ops.grn_avail('HOMEWORKSSB', '4000-S300', 'SB1', current_date)$q$, 'permission denied');
reset role;
do $$ begin
  -- 纯函数：仓位规则
  assert ops.podo_recv_loc('HOMEWORKSSB', 'HQ', 'HQ', 'srgading') = 'SRGADING' and ops.podo_recv_loc('HOMEWORKSSB', 'HQ', 'JB', 'PRE (JB)') = 'HQ'
     and ops.podo_recv_loc('HOMEWORKSSB', 'HQ', 'HQ', 'DISPLAY') = 'HQ' and ops.podo_recv_loc('HOMEWORKSSB', 'JB', 'HQ', 'HQ') = 'PRE (JB)'
     and ops.podo_recv_loc('HOMEWORKSSB', 'PUCHONG', null, null) = 'PRE (PUCHONG)' and ops.podo_recv_loc('HOMEWORKSSOUTHERN', 'JB', 'JB', null) = 'JB'
     and ops.podo_recv_loc('HOMEWORKSSOUTHERN', 'JB', 'JB', 'main') = 'MAIN',
    'recv loc rules';
  assert ops.podo_main_loc('HOMEWORKSSB') = 'HQ' and ops.podo_main_loc('HOMEWORKSSOUTHERN') = 'JB' and ops.podo_loc_ok('HOMEWORKSSOUTHERN', 'JB')
     and not ops.podo_loc_ok('HOMEWORKSSOUTHERN', 'HQ') and ops.podo_loc_ok('HOMEWORKSSB', 'SRGADING'), 'main loc';
  assert ops.grn_docs(' grn-1, GRN-2;grn-1 / ') = '{GRN-1,GRN-2}' and ops.grn_docs('') = '{}' and ops.grn_docs(null) = '{}', 'grn_docs';
  assert ops.podo_fifo_take('{3,4,5}', 5) = '{0,2,5}' and ops.podo_fifo_take('{3}', 9) = '{0}' and ops.podo_fifo_take('{3}', -1) = '{3}', 'fifo take';
  -- 只有测试自己改了 AutoCount 已收（8003 = GRN-0001）；程式没写 bi.*
  assert (select count(*) from bi.fact_po_line where creditor_code in ('4000-S300', '400-S301', '400-S302') and dtl_key <> 8003
          and transferred_qty <> 0) = 0 and (select transferred_qty from bi.fact_po_line where dtl_key = 8003) = 8, 'bi untouched';
  assert (select count(*) from ops.supplier_issue where factory is null and creditor_code = '4000-S300') = 0, 'factory filled';
end $$;

select 'sop_test ok';
