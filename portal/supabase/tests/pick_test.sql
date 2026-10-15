-- 照 DO 拣货 + 扫码核对（2026-10-15）。接在 bin_test.sql 之后跑（不依赖其他新功能的测试）。
-- 用到前面测试建的人：picker（仓库可编辑）、whmgr（仓库主管 = 可审批）、hqsales（门市：仓库只看、送货只看）、jbwh（JB 仓库）、hr（没有仓库 / 送货）。
-- 商品（stub）：ST003 'HEMOS BASIN HM-UB001'、ST004 'HEMOS WC ONE PIECE'、ST001 'RAXON HOSE'。
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
-- 货架上某商品几件（用 API 读）
create or replace function pg_temp.binqty(p_code text, p_item text) returns numeric language sql as $$
  select coalesce((select (x->>'qty')::numeric
    from jsonb_array_elements(public.ops_wh_bin_get(jsonb_build_object('bin', p_code, 'location', 'HQ'))->'items') x
    where x->>'item_code' = p_item), 0)
$$;
create or replace function pg_temp.binbc(p_code text) returns text language sql as $$
  select x->>'barcode' from jsonb_array_elements(public.ops_wh_bins('{"location":"HQ"}')->'bins') x where x->>'code' = p_code
$$;
-- 拣货单里第 n 行
create or replace function pg_temp.line(g jsonb, n int) returns jsonb language sql as $$
  select x from jsonb_array_elements(g->'lines') x where (x->>'line_no')::int = n
$$;
create or replace function pg_temp.pick_id(p_doc text) returns bigint language sql as $$
  select (public.ops_wh_pick_get('', p_doc)->'pick'->>'id')::bigint
$$;
create or replace function pg_temp.scan(p_doc text, p_code text, p_qty numeric default 1, p_bin text default null,
  p_line bigint default null) returns jsonb language sql as $$
  select public.ops_wh_pick_scan(jsonb_build_object('pick_id', pg_temp.pick_id(p_doc), 'code', p_code, 'qty', p_qty,
                                                    'bin', p_bin, 'line_id', p_line))
$$;
-- 清单里本测试的 DO（前面的测试也留下了别的 DO 与排单）
create or replace function pg_temp.docs(r jsonb) returns text[] language sql as $$
  select coalesce(array_agg(x->>'doc_no' order by o), '{}') from jsonb_array_elements(r->'rows') with ordinality t(x, o)
  where x->>'doc_no' like 'DO-P%'
$$;
grant execute on all functions in schema pg_temp to authenticated;

-- 总览数字的基准（前面的测试留下的 DO / 排单 / 拣货单）
select set_config('pick.base', ops.wh_pick_summary('HOMEWORKSSB')::text, false);
-- 资料：HQ 四张 DO + JB 一张；今天的排单（DO-P002 第 1 站、DO-P001 第 2 站）
insert into bi.dim_item (company, item_code, description, item_group, item_type, base_uom) values
  ('HOMEWORKSSB', 'DUP1', 'DUP NAME', 'X', 'HEMOS', 'PCS'), ('HOMEWORKSSB', 'DUP2', 'dup  name', 'X', 'HEMOS', 'PCS');
insert into bi.delivery_doc (company, doc_no, doc_date, debtor_code, debtor_name, items, lines, do_remark) values
  ('HOMEWORKSSB', 'DO-P001', (now() at time zone 'Asia/Kuala_Lumpur')::date, '300-C001', 'PICK CUSTOMER', 'x',
   '[{"d":"  hemos basin   hm-ub001 ","q":3,"u":"PCS"},{"d":"HEMOS WC ONE PIECE","q":2,"u":"SETS"},{"d":"TRANSPORT CHARGES","q":1,"u":"TRIP"},{"d":"DUP NAME","q":1},{"d":"NOTE ONLY","q":0}]',
   'Call first'),
  ('HOMEWORKSSB', 'DO-P002', (now() at time zone 'Asia/Kuala_Lumpur')::date - 3, '300-C002', 'ANOTHER SHOP', 'y',
   '[{"d":"WHATEVER","q":"2","c":"st004"}]', null),
  ('HOMEWORKSSB', 'DO-P003', (now() at time zone 'Asia/Kuala_Lumpur')::date - 2, '300-C003', 'OLD SHOP', 'z',
   '[{"d":"RAXON HOSE","q":1}]', null),
  ('HOMEWORKSSB', 'DO-P004', (now() at time zone 'Asia/Kuala_Lumpur')::date - 1, '300-C004', 'DELIVERED SHOP', 'z',
   '[{"d":"RAXON HOSE","q":1}]', null),
  ('HOMEWORKSSB', 'DO-P005', (now() at time zone 'Asia/Kuala_Lumpur')::date, '300-C005', 'NO LINES YET', 'z', null, null),
  ('HOMEWORKSSOUTHERN', 'DO-PJB1', (now() at time zone 'Asia/Kuala_Lumpur')::date, '300-J001', 'JB SHOP', 'j',
   '[{"d":"RAXON HOSE","q":1}]', null);
insert into bi.delivery_run (run_date, store, driver_name, stops, token) values
  ((now() at time zone 'Asia/Kuala_Lumpur')::date, 'HQ', '阿明',
   '[{"key":"DO-P002","doc_no":"DO-P002"},{"key":"DO-P001","doc_no":"DO-P001"}]', 'pick-test-token-0000000001'),
  ((now() at time zone 'Asia/Kuala_Lumpur')::date - 1, 'HQ', '阿明', '[{"key":"DO-P004","doc_no":"DO-P004"}]', 'pick-test-token-0000000002');
insert into bi.delivery_pod (run_id, stop_key, doc_no, status)
select r.id, 'DO-P004', 'DO-P004', 'delivered' from bi.delivery_run r where r.token = 'pick-test-token-0000000002';

set role authenticated;
-- 送货部只看、没有仓库权限的人（排单用 ops_wh_pick_status）；第二个仓库员工（不是开始拣货的人）
select pg_temp.as_user('boss@example.com');
select public.ops_staff_save('{"email":"dlvonly@example.com","name":"排单小美","department":"delivery","branch":"HOMEWORKSSB","overrides":{"warehouse":"none","delivery":"view"}}');
select public.ops_staff_save('{"email":"picker2@example.com","name":"仓库阿华","department":"warehouse","branch":"HOMEWORKSSB"}');
-- 货架：P-P1 放 ST003 5 件、P-P2 放 ST004 1 件
select pg_temp.as_user('whmgr@example.com');
select public.ops_wh_bin_bulk('{"location":"HQ","zone":"P","shelves":["P1","P2"]}');
select public.ops_wh_bin_import('{"location":"HQ","rows":[{"item":"ST003","bin":"P-P1","qty":5},{"item":"ST004","bin":"P-P2","qty":1}]}');

-- 1. 只看（门市）：清单、预览配对；不能开始
select pg_temp.as_user('hqsales@example.com');
do $$ declare r jsonb; g jsonb; begin
  r := public.ops_wh_pick_list('{"when":"today"}');
  assert (pg_temp.docs(r))[1:2] = array['DO-P002', 'DO-P001'], 'today: runs first, by stop order: ' || r::text;
  assert not ('DO-PJB1' = any(pg_temp.docs(r))) and not ('DO-P003' = any(pg_temp.docs(r))), 'today only: ' || r::text;
  g := (select x from jsonb_array_elements(r->'rows') x where x->>'doc_no' = 'DO-P001');
  assert (g->'run'->>'seq')::int = 2 and (g->'run'->>'today')::boolean
     and (g->>'total')::numeric = 7 and g->>'status' is null and (g->>'lines')::int = 5, 'row fields: ' || g::text;
  assert (r->'summary'->>'today')::int = (current_setting('pick.base')::jsonb->>'today')::int + 3,
    'summary today (P001, P002 via run, P005 dated today): ' || (r->'summary')::text;
  g := public.ops_wh_pick_get('', 'do-p001');
  assert g->>'doc_no' = 'DO-P001' and g->'pick' = 'null'::jsonb and not (g->>'can_edit')::boolean and g->>'do_remark' = 'Call first', 'get: ' || g::text;
  assert pg_temp.line(g, 1)->>'item_code' = 'ST003' and pg_temp.line(g, 1)->>'match' = 'desc', 'desc match (spaces, case): ' || g::text;
  assert pg_temp.line(g, 2)->>'item_code' = 'ST004' and pg_temp.line(g, 3)->>'match' = 'none', 'match 2/3';
  assert pg_temp.line(g, 1)->>'base_uom' = 'PCS' and pg_temp.line(g, 2)->>'uom' = 'SETS', 'units';
  assert pg_temp.line(g, 4)->>'match' = 'none', 'ambiguous description → none';
  assert (pg_temp.line(g, 5)->>'skip')::boolean, 'qty 0 → skip';
  assert exists (select 1 from jsonb_array_elements(pg_temp.line(g, 1)->'bins') b where b->>'code' = 'P-P1' and (b->>'qty')::numeric = 5),
    'suggested bins: ' || (pg_temp.line(g, 1)->'bins')::text;
  assert jsonb_array_length(g->'runs') = 1 and g->'runs'->0->>'driver_name' = '阿明', 'runs';
  g := public.ops_wh_pick_get('', 'DO-P002');
  assert pg_temp.line(g, 1)->>'item_code' = 'ST004' and pg_temp.line(g, 1)->>'match' = 'code'
     and (pg_temp.line(g, 1)->>'qty')::numeric = 2, 'code match + text qty: ' || g::text;
  r := public.ops_wh_pick_list('{"when":"all","status":"todo"}');
  assert not ('DO-P004' = any(pg_temp.docs(r))) and 'DO-P003' = any(pg_temp.docs(r)), 'delivered DO not in todo: ' || r::text;
  r := public.ops_wh_pick_list('{"when":"today","q":"old shop"}');
  assert pg_temp.docs(r) = array['DO-P003'], 'search ignores the day filter: ' || r::text;
end $$;
select pg_temp.expect_error($q$select public.ops_wh_pick_start('', 'DO-P001')$q$, '编辑');
select pg_temp.expect_error($q$select public.ops_wh_pick_get('', 'DO-NOPE')$q$, '找不到 DO');

-- 2. 分店：JB 看不到总部的 DO
select pg_temp.as_user('jbwh@example.com');
select pg_temp.expect_error($q$select public.ops_wh_pick_get('HOMEWORKSSB', 'DO-P001')$q$, '分店');
select pg_temp.expect_error($q$select public.ops_wh_pick_list('{"company":"HOMEWORKSSB"}')$q$, '分店');
do $$ begin assert pg_temp.docs(public.ops_wh_pick_list('{}')) = array['DO-PJB1'], 'JB sees own DO'; end $$;
select pg_temp.expect_error($q$select public.ops_wh_pick_get('', 'DO-P001')$q$, '找不到 DO');

-- 3. 开始拣货（可编辑）；两个人同时按 = 同一张
select pg_temp.as_user('picker@example.com');
select pg_temp.expect_error($q$select public.ops_wh_pick_start('', 'DO-P005')$q$, '还没有明细');
do $$ declare g jsonb; g2 jsonb; begin
  g := public.ops_wh_pick_start('', 'DO-P001');
  assert g->'pick'->>'status' = 'picking' and (g->>'can_edit')::boolean and (g->>'can_cancel')::boolean
     and jsonb_array_length(g->'lines') = 5 and (g->'pick'->>'total')::numeric = 7, 'start: ' || g::text;
  assert (pg_temp.line(g, 5)->>'skip')::boolean and pg_temp.line(g, 5)->>'skip_reason' like '数量 0%', 'auto skip';
  perform pg_temp.as_user('whmgr@example.com');
  g2 := public.ops_wh_pick_start('', 'DO-P001');
  assert g2->'pick'->>'id' = g->'pick'->>'id' and (g2->>'can_cancel')::boolean, 'same pick; manager may cancel';
  perform set_config('pick.id', g->'pick'->>'id', false);
end $$;

-- 4. 扫码：扫错 / 扫太多 / 货架不够不报错、不存
select pg_temp.as_user('picker@example.com');
do $$ declare r jsonb; g jsonb; v_bin text := pg_temp.binbc('P-P1'); v_bin2 text := pg_temp.binbc('P-P2'); begin
  r := pg_temp.scan('DO-P001', 'NOPE');
  assert not (r->>'ok')::boolean and r->>'code' = 'unknown', 'unknown: ' || r::text;
  r := pg_temp.scan('DO-P001', 'ST001');
  assert r->>'code' = 'wrong' and r->>'message' like '%没有 ST001%', 'wrong item: ' || r::text;
  r := pg_temp.scan('DO-P001', 'BIN:1');
  assert r->>'code' = 'is_bin', 'bin code: ' || r::text;
  r := pg_temp.scan('DO-P001', 'st003', 1, v_bin);
  assert (r->>'ok')::boolean and (r->'line'->>'picked')::numeric = 1 and r->'scan'->>'bin' = 'HQ · P-P1'
     and not (r->>'done_all')::boolean, 'scan ok: ' || r::text;
  assert pg_temp.binqty('P-P1', 'ST003') = 4, 'bin deducted';
  r := pg_temp.scan('DO-P001', 'ST003', 5);
  assert r->>'code' = 'over' and r->>'message' like '%只差 2%', 'over: ' || r::text;
  r := pg_temp.scan('DO-P001', 'ST003', 2, v_bin2);
  assert r->>'code' = 'bin_short' and (r->>'bin_qty')::numeric = 0
     and exists (select 1 from jsonb_array_elements(r->'bins') b where b->>'code' = 'P-P1' and (b->>'qty')::numeric = 4), 'bin short: ' || r::text;
  r := pg_temp.scan('DO-P001', 'ST003', 2, 'ZZ-9');
  assert r->>'code' = 'bin' and r->>'message' like '%找不到货架%', 'bad bin: ' || r::text;
  g := public.ops_wh_pick_get('', 'DO-P001');
  assert (pg_temp.line(g, 1)->>'picked')::numeric = 1 and jsonb_array_length(g->'scans') = 1, 'nothing saved on errors';
  r := pg_temp.scan('DO-P001', 'ST003', 2);
  assert (r->>'ok')::boolean and (r->'line'->>'done')::boolean and r->'scan'->>'bin_id' is null, 'scan without bin';
  r := pg_temp.scan('DO-P001', 'ST003');
  assert r->>'code' = 'over' and r->>'message' like '%已经拣够了%', 'full: ' || r::text;
  -- 从货架扣，再撤销 → 加回去
  r := pg_temp.scan('DO-P001', 'ST004', 1, v_bin2);
  assert (r->>'ok')::boolean and pg_temp.binqty('P-P2', 'ST004') = 0, 'ST004 from P-P2';
  perform set_config('pick.undo', r->'scan'->>'id', false);
  r := public.ops_wh_pick_undo(current_setting('pick.undo')::bigint);
  assert (r->'line'->>'picked')::numeric = 0 and (r->'scan'->>'voided')::boolean, 'undo: ' || r::text;
  assert pg_temp.binqty('P-P2', 'ST004') = 1, 'undo puts it back';
end $$;
select pg_temp.expect_error($q$select public.ops_wh_pick_undo(current_setting('pick.undo')::bigint)$q$, '撤销过');
select pg_temp.as_user('hqsales@example.com');
select pg_temp.expect_error($q$select pg_temp.scan('DO-P001', 'ST004')$q$, '编辑');
select pg_temp.as_user('jbwh@example.com');
select pg_temp.expect_error($q$select public.ops_wh_pick_scan(jsonb_build_object('pick_id', current_setting('pick.id'), 'code', 'ST004'))$q$, '找不到这张拣货单');
select pg_temp.expect_error($q$select public.ops_wh_pick_undo(current_setting('pick.undo')::bigint)$q$, '找不到这笔');

-- 5. 对不到的行：扫商品指定 / 撤销还原 / 手动确认 / 略过
select pg_temp.as_user('picker@example.com');
do $$ declare r jsonb; g jsonb; l3 bigint; l4 bigint; begin
  r := pg_temp.scan('DO-P001', 'ST004', 2);
  assert (r->>'ok')::boolean and (r->'line'->>'done')::boolean, 'ST004 x2';
  g := public.ops_wh_pick_get('', 'DO-P001');
  l3 := (pg_temp.line(g, 3)->>'id')::bigint;
  l4 := (pg_temp.line(g, 4)->>'id')::bigint;
  r := pg_temp.scan('DO-P001', 'ST004', 1, null, (pg_temp.line(g, 1)->>'id')::bigint);
  assert r->>'code' = 'wrong' and r->>'message' like '%不是第 1 行%', 'line mismatch: ' || r::text;
  r := pg_temp.scan('DO-P001', 'ST001', 1, null, l4);
  assert (r->>'ok')::boolean and r->'line'->>'item_code' = 'ST001' and r->'line'->>'match' = 'manual', 'assign: ' || r::text;
  r := public.ops_wh_pick_undo((r->'scan'->>'id')::bigint);
  assert r->'line'->>'item_code' is null and r->'line'->>'match' = 'none', 'undo assignment: ' || r::text;
  perform set_config('pick.l3', l3::text, false);
  perform set_config('pick.l4', l4::text, false);
end $$;
select pg_temp.expect_error($q$select public.ops_wh_pick_line_set(jsonb_build_object('pick_id', current_setting('pick.id'), 'line_id', current_setting('pick.l3'), 'action', 'skip'))$q$, '原因');
select pg_temp.expect_error($q$select public.ops_wh_pick_line_set(jsonb_build_object('pick_id', current_setting('pick.id'), 'line_id', current_setting('pick.l4'), 'action', 'manual', 'qty', 2, 'reason', '没有条码'))$q$, '只差 1');
select pg_temp.expect_error($q$select public.ops_wh_pick_line_set(jsonb_build_object('pick_id', current_setting('pick.id'), 'line_id', current_setting('pick.l4'), 'action', 'manual', 'qty', 1))$q$, '原因');
select pg_temp.expect_error($q$select public.ops_wh_pick_line_set(jsonb_build_object('pick_id', current_setting('pick.id'), 'line_id', current_setting('pick.l4'), 'action', 'manual', 'qty', 1, 'reason', 'x', 'bin', 'P-P1'))$q$, '对不到商品');
select pg_temp.expect_error($q$select public.ops_wh_pick_done(jsonb_build_object('pick_id', current_setting('pick.id')))$q$, '还有 2 行没拣够');
do $$ declare r jsonb; begin
  r := public.ops_wh_pick_line_set(jsonb_build_object('pick_id', current_setting('pick.id'), 'line_id', current_setting('pick.l3'),
                                                      'action', 'skip', 'reason', '运费'));
  assert (r->'line'->>'skip')::boolean and (r->'line'->>'done')::boolean and not (r->>'done_all')::boolean, 'skip: ' || r::text;
  r := public.ops_wh_pick_line_set(jsonb_build_object('pick_id', current_setting('pick.id'), 'line_id', current_setting('pick.l4'),
                                                      'action', 'manual', 'qty', 1, 'reason', '没有条码'));
  assert (r->>'done_all')::boolean and (r->'scan'->>'manual')::boolean and r->'scan'->>'note' = '没有条码', 'manual: ' || r::text;
  assert (r->'pick'->>'picked')::numeric = 6 and (r->'pick'->>'total')::numeric = 6 and (r->'pick'->>'lines_left')::int = 0,
    'totals exclude skipped: ' || (r->'pick')::text;
end $$;

-- 6. 已拣好；完成后不能再扫；排单的人看得到
do $$ declare g jsonb; begin
  g := public.ops_wh_pick_done(jsonb_build_object('pick_id', current_setting('pick.id')));
  assert g->'pick'->>'status' = 'done' and g->'pick'->>'done_by_name' = '仓库阿强' and g->'pick'->>'short_note' = '', 'done: ' || g::text;
end $$;
select pg_temp.expect_error($q$select pg_temp.scan('DO-P001', 'ST004')$q$, '已经拣好');
-- 没拣够：要缺货备注
do $$ begin perform public.ops_wh_pick_start('', 'DO-P002'); end $$;
select pg_temp.expect_error($q$select public.ops_wh_pick_done(jsonb_build_object('pick_id', pg_temp.pick_id('DO-P002'), 'force', true))$q$, '缺货备注');
do $$ declare g jsonb; r jsonb; begin
  perform pg_temp.scan('DO-P002', 'ST004');
  g := public.ops_wh_pick_done(jsonb_build_object('pick_id', pg_temp.pick_id('DO-P002'), 'force', true, 'short_note', '缺 1 件，下次补'));
  assert g->'pick'->>'status' = 'done' and g->'pick'->>'short_note' = '缺 1 件，下次补' and (g->'pick'->>'picked')::numeric = 1, 'forced done: ' || g::text;
  r := public.ops_wh_pick_list('{"when":"today","status":"done"}');
  assert pg_temp.docs(r) = array['DO-P002', 'DO-P001'], 'done filter: ' || r::text;
  r := public.ops_wh_pick_list('{"when":"today","status":"todo"}');
  assert not ('DO-P001' = any(pg_temp.docs(r))) and 'DO-P005' = any(pg_temp.docs(r)), 'todo filter: ' || r::text;
end $$;
select pg_temp.as_user('dlvonly@example.com');
do $$ declare s jsonb; begin
  s := public.ops_wh_pick_status('', array['DO-P001', 'DO-P002', 'DO-P003']);
  assert s->'DO-P001'->>'status' = 'done' and (s->'DO-P002'->>'total')::numeric = 2 and not (s ? 'DO-P003'), 'status: ' || s::text;
end $$;
select pg_temp.expect_error($q$select public.ops_wh_pick_list('{}')$q$, '仓库');
select pg_temp.expect_error($q$select public.ops_wh_pick_status('HOMEWORKSSOUTHERN', array['DO-PJB1'])$q$, '分店');
select pg_temp.as_user('hqsales@example.com');
do $$ begin assert public.ops_wh_pick_status('', array['DO-P001'])->'DO-P001'->>'status' = 'done', 'sales status'; end $$;
select pg_temp.as_user('hr@example.com');
select pg_temp.expect_error($q$select public.ops_wh_pick_status('', array['DO-P001'])$q$, '查看权限');

-- 7. 重新打开 / 取消：开始的人或可审批；取消 = 货架加回去
select pg_temp.as_user('picker2@example.com');
select pg_temp.expect_error($q$select public.ops_wh_pick_reopen(jsonb_build_object('pick_id', pg_temp.pick_id('DO-P001')))$q$, '开始拣货的人');
select pg_temp.expect_error($q$select public.ops_wh_pick_cancel(jsonb_build_object('pick_id', pg_temp.pick_id('DO-P001'), 'reason', 'x'))$q$, '开始拣货的人');
do $$ begin assert not (public.ops_wh_pick_get('', 'DO-P001')->>'can_cancel')::boolean, 'picker2 cannot cancel'; end $$;
select pg_temp.as_user('picker@example.com');
do $$ declare g jsonb; r jsonb; begin
  g := public.ops_wh_pick_reopen(jsonb_build_object('pick_id', pg_temp.pick_id('DO-P001')));
  assert g->'pick'->>'status' = 'picking' and g->'pick'->>'done_at' is null, 'reopen: ' || g::text;
  r := public.ops_wh_pick_line_set(jsonb_build_object('pick_id', pg_temp.pick_id('DO-P001'), 'line_id', current_setting('pick.l3'), 'action', 'unskip'));
  assert not (r->'line'->>'skip')::boolean and not (r->>'done_all')::boolean, 'unskip';
end $$;
select pg_temp.as_user('whmgr@example.com');
select pg_temp.expect_error($q$select public.ops_wh_pick_cancel(jsonb_build_object('pick_id', pg_temp.pick_id('DO-P001')))$q$, '原因');
do $$ declare r jsonb; g jsonb; old bigint := pg_temp.pick_id('DO-P001'); begin
  assert pg_temp.binqty('P-P1', 'ST003') = 4, 'before cancel';
  r := public.ops_wh_pick_cancel(jsonb_build_object('pick_id', old, 'reason', '拣错要重来'));
  assert (r->>'ok')::boolean and (r->>'reversed')::int = 1, 'cancel: ' || r::text;
  assert pg_temp.binqty('P-P1', 'ST003') = 5, 'cancel puts bins back';
  g := public.ops_wh_pick_get('', 'DO-P001');
  assert g->'pick' = 'null'::jsonb and (g->>'cancelled_picks')::int = 1, 'cancelled: ' || g::text;
  g := public.ops_wh_pick_start('', 'DO-P001');
  assert (g->'pick'->>'id')::bigint <> old and (g->'pick'->>'picked')::numeric = 0, 'restart after cancel';
end $$;

-- 8. DO 开始后在 AutoCount 改了 / 取消了：画面提醒；取消的 DO 有拣货单还留在待拣清单
reset role;
update bi.delivery_doc set lines = '[{"d":"RAXON HOSE","q":2}]' where doc_no = 'DO-P003';
set role authenticated;
select pg_temp.as_user('picker@example.com');
do $$ begin perform public.ops_wh_pick_start('', 'DO-P003'); end $$;
reset role;
update bi.delivery_doc set lines = '[{"d":"RAXON HOSE","q":3}]', cancelled = true where doc_no = 'DO-P003';
set role authenticated;
select pg_temp.as_user('picker@example.com');
do $$ declare g jsonb; r jsonb; begin
  g := public.ops_wh_pick_get('', 'DO-P003');
  assert (g->>'do_changed')::boolean and (g->>'cancelled')::boolean and (pg_temp.line(g, 1)->>'qty')::numeric = 2, 'changed: ' || g::text;
  r := public.ops_wh_pick_list('{"when":"week","status":"todo"}');
  assert exists (select 1 from jsonb_array_elements(r->'rows') x where x->>'doc_no' = 'DO-P003' and (x->>'cancelled')::boolean), 'cancelled DO with pick listed';
end $$;
select pg_temp.expect_error($q$select public.ops_wh_pick_start('', 'DO-P003')$q$, '已经取消');

-- 9. 内部函数一般账号叫不到；总览数字
select pg_temp.expect_error($q$select ops.wh_pick_match('HOMEWORKSSB', '[]'::jsonb)$q$, 'permission');
reset role;
do $$ declare s jsonb := ops.wh_pick_summary('HOMEWORKSSB'); b jsonb := current_setting('pick.base')::jsonb; begin
  assert (s->>'today')::int = (b->>'today')::int + 3 and (s->>'today_done')::int = (b->>'today_done')::int + 1
     and (s->>'picking')::int = (b->>'picking')::int + 2, 'summary: ' || s::text || ' base ' || b::text;
end $$;
select 'pick_test ok' as result;
