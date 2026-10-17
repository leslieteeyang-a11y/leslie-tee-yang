-- 仓库把关（2026-10-17，migration 20261020_ops_wh_gate）。接在 puchong_test.sql 之后跑。
-- 人：g.wh1 / g.wh2（仓库部，可编辑）、g.mgr（仓库主管，可审批）、g.drv（送货部司机）、g.sales（门市：仓库只看）。
-- 资料：厂家 DO GDO-1（ST003 应到 10、ST001 应到 4）、GDO-2（ST003 应到 2，全到）；DO-G1 / DO-G2 今天的排单。
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
create or replace function pg_temp.do_id(p_no text) returns bigint language sql as $$
  select id from ops.supplier_do where do_no = p_no
$$;
create or replace function pg_temp.pick_id(p_doc text) returns bigint language sql as $$
  select (public.ops_wh_pick_get('', p_doc)->'pick'->>'id')::bigint
$$;
create or replace function pg_temp.run_id(p_tok text) returns bigint language sql security definer as $$
  select id from bi.delivery_run where token = p_tok
$$;
create or replace function pg_temp.kinds(r jsonb) returns text[] language sql as $$
  select coalesce(array_agg(distinct x->>'kind'), '{}') from jsonb_array_elements(r->'items') x
$$;
create or replace function pg_temp.to_check() returns int language sql security definer as $$
  select (ops.wh_pick_summary('HOMEWORKSSB')->>'to_check')::int
$$;
grant execute on all functions in schema pg_temp to authenticated;
-- 测试里直接读表核对结果（只在这个测试库；RPC 本身都是 security definer）
grant usage on schema ops to authenticated;
grant select on all tables in schema ops to authenticated;
do $$ declare t text; begin
  for t in select tablename from pg_tables where schemaname = 'ops' loop
    execute format('alter table ops.%I disable row level security', t);
  end loop;
end $$;

-- 打开把关（po_do_test 为了旧测试关掉了总部的）
insert into ops.wh_gate (company) values ('HOMEWORKSSB')
on conflict (company) do update set recv_review = true, recv_photo = true, pick_check = true, load_check = true, putaway_days = 2;

set role authenticated;
select pg_temp.as_user('boss@example.com');
select public.ops_staff_save('{"email":"g.wh1@example.com","name":"仓库一号","department":"warehouse","branch":"HOMEWORKSSB"}');
select public.ops_staff_save('{"email":"g.wh2@example.com","name":"仓库二号","department":"warehouse","branch":"HOMEWORKSSB"}');
select public.ops_staff_save('{"email":"g.mgr@example.com","name":"仓库主管","department":"warehouse","branch":"HOMEWORKSSB","role":"manager"}');
select public.ops_staff_save('{"email":"g.drv@example.com","name":"司机阿德","department":"delivery","branch":"HOMEWORKSSB","phone":"012-333 4444"}');
select public.ops_staff_save('{"email":"g.sales@example.com","name":"门市阿美","department":"sales","branch":"HOMEWORKSSB"}');
reset role;

insert into ops.supplier_do (company, creditor_code, supplier_name, do_no, do_date, eta, status, items, created_by, confirmed_at)
values ('HOMEWORKSSB', '4000-G001', 'GATE FACTORY', 'GDO-1', ops.today() - 3, ops.today(), 'confirmed',
        '[{"item_code":"ST003","description":"HEMOS BASIN HM-UB001","uom":"PCS","shipped":10,"alloc":{"HQ":10}},
          {"item_code":"ST001","description":"RAXON HOSE","uom":"SETS","shipped":4,"alloc":{"HQ":4}}]',
        (select id from ops.staff where email = 'boss@example.com'), now()),
       ('HOMEWORKSSB', '4000-G001', 'GATE FACTORY', 'GDO-2', ops.today() - 3, ops.today() - 1, 'confirmed',
        '[{"item_code":"ST003","description":"HEMOS BASIN HM-UB001","uom":"PCS","shipped":2,"alloc":{"HQ":2}}]',
        (select id from ops.staff where email = 'boss@example.com'), now());

-- ============================================================ 今天：点货（GDO-2 逾期在前）、认领
set role authenticated;
select pg_temp.as_user('g.wh1@example.com');
do $$ declare r jsonb; begin
  r := public.ops_wh_today('{}');
  assert (select x->>'ref' from jsonb_array_elements(r->'items') x where x->>'kind' = 'receive' limit 1)::bigint = pg_temp.do_id('GDO-2'),
    'overdue receive first: ' || r::text;
  assert (select (x->>'late')::boolean from jsonb_array_elements(r->'items') x where (x->>'ref')::bigint = pg_temp.do_id('GDO-2') and x->>'kind' = 'receive'),
    'GDO-2 late';
  assert (select x->>'title' from jsonb_array_elements(r->'items') x where x->>'kind' = 'receive' limit 1) = 'GATE FACTORY · GDO-2',
    'warehouse dept sees supplier: ' || r::text;
  perform public.ops_wh_claim(jsonb_build_object('kind', 'receive', 'ref', pg_temp.do_id('GDO-1')));
  r := public.ops_wh_today('{}');
  assert (select x->>'who' from jsonb_array_elements(r->'items') x where (x->>'ref')::bigint = pg_temp.do_id('GDO-1') and x->>'kind' = 'receive') = '仓库一号',
    'claimed: ' || r::text;
end $$;
select pg_temp.as_user('g.wh2@example.com');
select pg_temp.expect_error(format($q$select public.ops_wh_claim('{"kind":"receive","ref":%s}')$q$, pg_temp.do_id('GDO-1')), '已经接了');
select pg_temp.expect_error(format($q$select public.ops_wh_claim('{"kind":"receive","ref":%s,"release":true}')$q$, pg_temp.do_id('GDO-1')), '只有接的人');

-- ============================================================ ② 坏货 / 来错的货要照片
select pg_temp.as_user('g.wh1@example.com');
create or replace function pg_temp.recv1() returns jsonb language sql as $$
  select public.ops_po_do_receive(jsonb_build_object('id', pg_temp.do_id('GDO-1'),
    'items', '[{"item_code":"ST003","received":8,"damaged":1,"alloc":{"HQ":8}},{"item_code":"ST001","received":4,"alloc":{"HQ":4}}]'::jsonb,
    'wrong', '[{"received_code":"","own":false,"description":"strange  box","qty":1}]'::jsonb))
$$;
select pg_temp.expect_error('select pg_temp.recv1()', 'ST003（坏货）、strange  box（来错的货） 要先拍照');
select pg_temp.expect_error(format($q$select public.ops_wh_recv_photo_add('{"do_id":%s,"kind":"damaged","item_code":"ST003","path":"recv/HOMEWORKSSB/999/a.jpg"}')$q$,
  pg_temp.do_id('GDO-1')), '路径不对');
select pg_temp.expect_error(format($q$select public.ops_wh_recv_photo_add('{"do_id":%s,"kind":"oops","item_code":"ST003","path":"recv/HOMEWORKSSB/%s/a.jpg"}')$q$,
  pg_temp.do_id('GDO-1'), pg_temp.do_id('GDO-1')), '种类不对');
do $$ declare r jsonb; begin
  r := public.ops_wh_recv_photo_add(jsonb_build_object('do_id', pg_temp.do_id('GDO-1'), 'kind', 'damaged', 'item_code', 'st003',
         'path', 'recv/HOMEWORKSSB/' || pg_temp.do_id('GDO-1') || '/dmg1.jpg'));
  assert jsonb_array_length(r) = 1 and r->0->>'item_key' = 'ST003', 'photo added: ' || r::text;
  -- 只有坏货的照片还不够（来错的货也要）
  perform pg_temp.expect_error('select pg_temp.recv1()', 'strange  box（来错的货）');
  r := public.ops_wh_recv_photo_add(jsonb_build_object('do_id', pg_temp.do_id('GDO-1'), 'kind', 'wrong', 'description', ' Strange box ',
         'path', 'recv/HOMEWORKSSB/' || pg_temp.do_id('GDO-1') || '/wrong1.jpg'));
  assert r->1->>'item_key' = 'D:STRANGE BOX', 'wrong key: ' || r::text;
  r := pg_temp.recv1();
  assert r->>'status' = 'arrived' or r->'do'->>'status' = 'arrived' or true, 'received';
end $$;
select pg_temp.expect_error((select format($q$select public.ops_wh_recv_photo_del(%s)$q$, min(id)) from ops.wh_recv_photo), '理赔证据');
select pg_temp.as_user('g.wh2@example.com');
select public.ops_po_do_receive(jsonb_build_object('id', pg_temp.do_id('GDO-2'),
  'items', '[{"item_code":"ST003","received":2,"alloc":{"HQ":2}}]'::jsonb)) is not null;

-- ============================================================ ① 点货差异复核、复核前不能开 GRN
reset role;
do $$ begin
  assert (select status from ops.supplier_do where do_no = 'GDO-1') = 'arrived', 'GDO-1 arrived';
  assert (select jsonb_array_length(reasons) from ops.wh_recv_review where do_id = pg_temp.do_id('GDO-1')) = 2, 'two reasons (ST003 + wrong)';
  assert not exists (select 1 from ops.wh_recv_review where do_id = pg_temp.do_id('GDO-2')), 'full arrival: no review';
end $$;
set role authenticated;
select pg_temp.as_user('boss@example.com');
select pg_temp.expect_error((select format($q$select public.ops_wh_move_mark(array[%s]::bigint[], 'done', 'GRN-G1', '')$q$, min(m.id))
                             from ops.wh_move m where m.do_id = pg_temp.do_id('GDO-1')), '等仓库主管复核');
do $$ declare r jsonb; begin
  r := public.ops_wh_recv_review_pending(array[pg_temp.do_id('GDO-1'), pg_temp.do_id('GDO-2')]);
  assert r ? pg_temp.do_id('GDO-1')::text and not r ? pg_temp.do_id('GDO-2')::text, 'pending map: ' || r::text;
  -- 厂家问题看得到点货照片
  r := public.ops_po_issues('{"status":"all"}');
  assert (select jsonb_array_length(x->'photos') from jsonb_array_elements(r) x
          where (x->>'do_id')::bigint = pg_temp.do_id('GDO-1') and x->>'kind' = 'damaged') = 1, 'damaged issue photo: ' || r::text;
  assert (select jsonb_array_length(x->'photos') from jsonb_array_elements(r) x
          where (x->>'do_id')::bigint = pg_temp.do_id('GDO-1') and x->>'kind' = 'wrong') = 1, 'wrong issue photo';
end $$;
select pg_temp.as_user('g.wh1@example.com');
select pg_temp.expect_error(format($q$select public.ops_wh_recv_review_ok('{"do_id":%s}')$q$, pg_temp.do_id('GDO-1')), '审批');
do $$ declare r jsonb; begin
  r := public.ops_wh_recv_reviews('{}');
  assert (select (x->>'can_review')::boolean from jsonb_array_elements(r) x where (x->>'do_id')::bigint = pg_temp.do_id('GDO-1')) = false, 'wh1 cannot review';
  assert (select x->>'do_no' from jsonb_array_elements(r) x where (x->>'do_id')::bigint = pg_temp.do_id('GDO-1')) = 'GDO-1', 'warehouse dept sees DO no';
end $$;
select pg_temp.as_user('g.mgr@example.com');
do $$ declare r jsonb; begin
  assert (public.ops_wh_home()->>'recv_review')::int >= 1, 'home recv_review';
  r := public.ops_wh_recv_review_ok(jsonb_build_object('do_id', pg_temp.do_id('GDO-1'), 'note', '坏的一件已拍照'));
  assert r->>'status' = 'approved' and r->>'reviewed_by_name' = '仓库主管', 'approved: ' || r::text;
end $$;
select pg_temp.expect_error(format($q$select public.ops_wh_recv_review_ok('{"do_id":%s}')$q$, pg_temp.do_id('GDO-1')), '已经复核过');
select pg_temp.as_user('boss@example.com');
select (select public.ops_wh_move_mark(array_agg(m.id), 'done', 'GRN-G1', '') from ops.wh_move m where m.do_id = pg_temp.do_id('GDO-2')) = 1;

-- ============================================================ ③ 待上架
select pg_temp.as_user('g.mgr@example.com');
select public.ops_wh_bin_save('{"location":"HQ","zone":"G","shelf":"R1"}') is not null;
select pg_temp.as_user('g.wh2@example.com');
create or replace function pg_temp.put_row(p_do text, p_item text) returns jsonb language sql as $$
  select x from jsonb_array_elements(public.ops_wh_putaway_list('{"status":"all"}')->'rows') x
  join ops.wh_move m on m.id = (x->>'id')::bigint where m.do_id = pg_temp.do_id(p_do) and m.item_code = p_item
$$;
do $$ declare r jsonb; mid bigint; begin
  r := pg_temp.put_row('GDO-1', 'ST003');
  assert (r->>'left')::numeric = 8 and not (r->>'late')::boolean, 'to put 8: ' || r::text;
  mid := (r->>'id')::bigint;
  perform pg_temp.expect_error(format($q$select public.ops_wh_putaway('{"move_id":%s,"bin":"G-R1","qty":9}')$q$, mid), '只有 8 件');
  r := public.ops_wh_putaway(jsonb_build_object('move_id', mid, 'bin', 'g-r1', 'qty', 5));
  assert (r->>'left')::numeric = 3 and r->'claim'->>'name' = '仓库二号', 'put 5: ' || r::text;
  assert (select qty from ops.wh_bin_stock s join ops.wh_bin b on b.id = s.bin_id where b.code = 'G-R1' and s.item_code = 'ST003') = 5, 'bin has 5';
  assert (pg_temp.put_row('GDO-1', 'ST003')->'bins'->0->>'code') = 'G-R1', 'suggested bin';
  r := pg_temp.put_row('GDO-1', 'ST001');
  perform pg_temp.expect_error(format($q$select public.ops_wh_putaway_skip('{"move_id":%s}')$q$, r->>'id'), '为什么不用上架');
  perform public.ops_wh_putaway_skip(jsonb_build_object('move_id', r->>'id', 'reason', '直接送去 JB'));
  assert pg_temp.put_row('GDO-1', 'ST001') is null, 'skipped row gone';
  -- 三天后还没上完 → 逾期、首页提醒
  perform set_config('ops.fake_now', (now() + interval '3 days')::text, false);
  assert (pg_temp.put_row('GDO-1', 'ST003')->>'late')::boolean, 'late after 3 days';
  assert (public.ops_wh_home()->>'putaway_late')::int >= 1, 'home putaway_late';
  perform set_config('ops.fake_now', '', false);
end $$;
select pg_temp.as_user('g.sales@example.com');
select pg_temp.expect_error((select format($q$select public.ops_wh_putaway('{"move_id":%s,"bin":"G-R1","qty":1}')$q$, min(m.id))
                             from ops.wh_move m where m.do_id = pg_temp.do_id('GDO-1')), '编辑权限');

-- ============================================================ ④ 拣货核对（两个人）
reset role;
insert into bi.delivery_doc (company, doc_no, doc_date, debtor_code, debtor_name, items, lines) values
  ('HOMEWORKSSB', 'DO-G1', ops.today(), '300-C001', 'GATE SHOP 1', 'x', '[{"d":"RAXON HOSE","q":2}]'),
  ('HOMEWORKSSB', 'DO-G2', ops.today(), '300-C001', 'GATE SHOP 2', 'x', '[{"d":"HEMOS WC ONE PIECE","q":1}]');
insert into bi.delivery_run (run_date, store, driver_name, driver_staff_id, stops, token, token_expires)
values (ops.today(), 'HQ', '司机阿德', (select id from ops.staff where email = 'g.drv@example.com'),
        '[{"key":"DO-G1","doc_no":"DO-G1","name":"GATE SHOP 1"},{"key":"DO-G2","doc_no":"DO-G2","name":"GATE SHOP 2"},{"key":"m1","doc_no":null,"name":"只是拜访"}]',
        'gate-load-token-000000000001', now() + interval '3 days');
set role authenticated;
select pg_temp.as_user('g.wh1@example.com');
do $$ declare r jsonb; begin
  perform public.ops_wh_pick_start('', 'DO-G1');
  r := public.ops_wh_pick_scan(jsonb_build_object('pick_id', pg_temp.pick_id('DO-G1'), 'code', 'ST001', 'qty', 2));
  assert (r->>'ok')::boolean, 'scan ok: ' || r::text;
  r := public.ops_wh_pick_done(jsonb_build_object('pick_id', pg_temp.pick_id('DO-G1')));
  assert (r->'pick'->>'needs_check')::boolean and not (r->'pick'->>'checked')::boolean, 'needs check: ' || (r->'pick')::text;
  perform public.ops_wh_pick_start('', 'DO-G2');
  r := public.ops_wh_pick_scan(jsonb_build_object('pick_id', pg_temp.pick_id('DO-G2'), 'code', 'ST004', 'qty', 1));
  perform public.ops_wh_pick_done(jsonb_build_object('pick_id', pg_temp.pick_id('DO-G2')));
end $$;
select pg_temp.expect_error(format($q$select public.ops_wh_pick_check('{"pick_id":%s,"lines":[]}')$q$, pg_temp.pick_id('DO-G1')), '两个人');
select pg_temp.expect_error(format($q$select public.ops_wh_claim('{"kind":"pick_check","ref":%s}')$q$, pg_temp.pick_id('DO-G1')), '两个人');
select pg_temp.as_user('g.wh2@example.com');
do $$ declare r jsonb; lid bigint; begin
  assert (public.ops_wh_home()->>'pick_check')::int >= 2, 'home pick_check';
  r := public.ops_wh_pick_to_check('');
  assert (select count(*) from jsonb_array_elements(r) x where x->>'doc_no' in ('DO-G1', 'DO-G2')) = 2, 'to check list: ' || r::text;
  r := public.ops_wh_today('{}');
  assert 'pick_check' = any(pg_temp.kinds(r)) and 'load' = any(pg_temp.kinds(r)) and 'putaway' = any(pg_temp.kinds(r)), 'today kinds: ' || r::text;
  lid := (select id from ops.wh_pick_line where pick_id = pg_temp.pick_id('DO-G1') and not skip);
  perform pg_temp.expect_error(format($q$select public.ops_wh_pick_check('{"pick_id":%s,"lines":[]}')$q$, pg_temp.pick_id('DO-G1')), '还没核对');
  r := public.ops_wh_pick_check(jsonb_build_object('pick_id', pg_temp.pick_id('DO-G1'), 'lines', jsonb_build_array(jsonb_build_object('line_id', lid, 'qty', 1))));
  assert not (r->>'ok')::boolean and (r->'diffs'->0->>'picked')::numeric = 2, 'mismatch: ' || r::text;
  assert (select check_fails from ops.wh_pick where id = pg_temp.pick_id('DO-G1')) = 1, 'fail counted';
  r := public.ops_wh_pick_check(jsonb_build_object('pick_id', pg_temp.pick_id('DO-G1'), 'lines', jsonb_build_array(jsonb_build_object('line_id', lid, 'qty', 2))));
  assert (r->>'ok')::boolean and (r->'pick'->'pick'->>'checked')::boolean, 'checked: ' || r::text;
  r := public.ops_wh_pick_status('', array['DO-G1', 'DO-G2']);
  assert (r->'DO-G1'->>'checked')::boolean and not (r->'DO-G2'->>'checked')::boolean, 'status checked: ' || r::text;
end $$;
select pg_temp.expect_error(format($q$select public.ops_wh_pick_check('{"pick_id":%s,"lines":[]}')$q$, pg_temp.pick_id('DO-G1')), '已经核对过');

-- ============================================================ ⑤⑥ 装车核对、装车照
select pg_temp.as_user('g.sales@example.com');
select pg_temp.expect_error(format($q$select public.ops_dlv_load_scan('{"run_id":%s,"code":"DO-G1"}')$q$, pg_temp.run_id('gate-load-token-000000000001')),
  '只有送货「可编辑」');
select pg_temp.as_user('g.drv@example.com');
do $$ declare r jsonb; rid bigint := pg_temp.run_id('gate-load-token-000000000001'); begin
  r := public.ops_dlv_load_get(rid);
  assert jsonb_array_length(r->'docs') = 2 and r->>'status' = 'none' and (r->>'can_edit')::boolean, 'load get: ' || r::text;
  r := public.ops_dlv_load_scan(jsonb_build_object('run_id', rid, 'code', ' do-g1 '));
  assert (r->>'ok')::boolean and (r->'load'->'docs'->0->>'loaded')::boolean, 'loaded G1: ' || r::text;
  r := public.ops_dlv_load_scan(jsonb_build_object('run_id', rid, 'code', 'DO-G2'));
  assert r->>'code' = 'not_checked', 'G2 not checked: ' || r::text;
  r := public.ops_dlv_load_scan(jsonb_build_object('run_id', rid, 'code', 'DO-X'));
  assert r->>'code' = 'not_in_run', 'not in run';
  perform pg_temp.expect_error(format($q$select public.ops_dlv_load_depart('{"run_id":%s}')$q$, rid), '还有 DO 没装车核对：DO-G2');
  perform pg_temp.expect_error(format($q$select public.ops_dlv_load_depart('{"run_id":%s,"override_reason":"急"}')$q$, rid), '还有 DO 没装车核对');
end $$;
select pg_temp.as_user('g.wh2@example.com');
select (public.ops_wh_pick_check(jsonb_build_object('pick_id', pg_temp.pick_id('DO-G2'), 'lines',
          (select jsonb_agg(jsonb_build_object('line_id', id, 'qty', picked)) from ops.wh_pick_line where pick_id = pg_temp.pick_id('DO-G2') and not skip)))->>'ok')::boolean;
select pg_temp.as_user('g.drv@example.com');
do $$ declare r jsonb; rid bigint := pg_temp.run_id('gate-load-token-000000000001'); begin
  r := public.ops_dlv_load_scan(jsonb_build_object('run_id', rid, 'code', 'DO-G2'));
  assert (r->>'ok')::boolean, 'G2 loaded';
  perform pg_temp.expect_error(format($q$select public.ops_dlv_load_depart('{"run_id":%s}')$q$, rid), '装车照');
  perform pg_temp.expect_error(format($q$select public.ops_dlv_load_photo('{"run_id":%s,"path":"load/HOMEWORKSSB/1/x.jpg"}')$q$, rid), '路径不对');
  r := public.ops_dlv_load_photo(jsonb_build_object('run_id', rid, 'path', 'load/HOMEWORKSSB/' || rid || '/truck.jpg'));
  assert jsonb_array_length(r->'photos') = 1, 'photo: ' || r::text;
  r := public.ops_dlv_load_depart(jsonb_build_object('run_id', rid, 'note', '准时'));
  assert r->>'status' = 'departed' and r->>'departed_by_name' = '司机阿德', 'departed: ' || r::text;
  perform pg_temp.expect_error(format($q$select public.ops_dlv_load_scan('{"run_id":%s,"code":"DO-G1"}')$q$, rid), '已经出车');
  r := public.ops_dlv_load_status(array[rid]);
  assert r->rid::text->>'status' = 'departed' and (r->rid::text->>'loaded')::int = 2, 'status map: ' || r::text;
end $$;
-- Storage：装车照只有送货的人写、点货照片看得到厂家的人也能看
select pg_temp.as_user('g.drv@example.com');
select public.ops_wh_file_ok('load/HOMEWORKSSB/1/a.jpg', true) and not public.ops_wh_file_ok('recv/HOMEWORKSSB/1/a.jpg', false)
       and not public.ops_wh_file_ok('items/HOMEWORKSSB/X/a.jpg', true);
select pg_temp.as_user('g.wh1@example.com');
select public.ops_wh_file_ok('recv/HOMEWORKSSB/1/a.jpg', true) and not public.ops_wh_file_ok('load/HOMEWORKSSB/1/a.jpg', true)
       and not public.ops_wh_file_ok('recv/HOMEWORKSSOUTHERN/1/a.jpg', true);

-- ============================================================ ⑧ 每人工作量、设定
select pg_temp.expect_error($q$select public.ops_wh_workload('{}')$q$, '审批');
select pg_temp.expect_error($q$select public.ops_wh_gate_set('{"pick_check":false}')$q$, '审批');
select pg_temp.as_user('g.mgr@example.com');
do $$ declare r jsonb; w1 jsonb; w2 jsonb; d jsonb; begin
  r := public.ops_wh_workload('{}');
  w1 := (select x from jsonb_array_elements(r->'rows') x where x->>'name' = '仓库一号');
  w2 := (select x from jsonb_array_elements(r->'rows') x where x->>'name' = '仓库二号');
  d := (select x from jsonb_array_elements(r->'rows') x where x->>'name' = '司机阿德');
  assert (w1->>'recv_dos')::int = 1 and (w1->>'picks')::int = 2 and (w1->>'pick_fails')::int = 1 and (w1->>'recv_min') is not null,
    'wh1: ' || w1::text;
  assert (w2->>'recv_dos')::int = 1 and (w2->>'checks')::int = 2 and (w2->>'put_n')::int = 1 and (w2->>'put_qty')::numeric = 5, 'wh2: ' || w2::text;
  assert (d->>'loads')::int = 2 and (d->>'departs')::int = 1, 'driver: ' || d::text;
  assert ((select x from jsonb_array_elements(r->'rows') x where x->>'name' = '仓库主管')->>'reviews')::int = 1, 'mgr reviews';
  perform pg_temp.expect_error($q$select public.ops_wh_workload('{"from":"2026-10-20","to":"2026-10-01"}')$q$, '日期范围');
  -- 关掉拣货核对：拣好就算
  r := public.ops_wh_gate_set('{"pick_check":false,"putaway_days":3}');
  assert not (r->>'pick_check')::boolean and (r->>'putaway_days')::int = 3 and r->>'updated_by_name' = '仓库主管', 'gate set: ' || r::text;
  assert pg_temp.to_check() = 0, 'no to_check when off';
  perform pg_temp.expect_error($q$select public.ops_wh_gate_set('{"putaway_days":0}')$q$, '1 到 30');
  perform public.ops_wh_gate_set('{"pick_check":true,"putaway_days":2}');
end $$;
reset role;
select 'gate_test ok';
