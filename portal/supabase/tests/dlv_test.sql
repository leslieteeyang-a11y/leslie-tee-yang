-- 送货测试（接在 join_test.sql 之后跑）。BI 的送货表在 stub_supabase.sql。
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

-- 资料：HQ 两张 DO（一张有送货地址）、一张取消的；JB 一张
insert into bi.delivery_doc (company, doc_no, doc_date, debtor_code, debtor_name, items, address, lines, do_remark) values
  ('HOMEWORKSSB', 'DO-017707', (now() at time zone 'Asia/Kuala_Lumpur')::date, '300-F001', 'FEI PLUMBING', 'TAP x2',
   '12 Jalan Seraya, 81300 Skudai', '[{"d":"TAP","q":2,"u":"UNIT"}]', 'Call first'),
  ('HOMEWORKSSB', 'DO-017708', (now() at time zone 'Asia/Kuala_Lumpur')::date, '300-C001', 'CASH (012-345 6789)', 'BASIN x1',
   null, null, null),
  ('HOMEWORKSSB', 'DO-017709', (now() at time zone 'Asia/Kuala_Lumpur')::date - 1, '300-C001', 'X', 'Y', null, null, null),
  ('HOMEWORKSSOUTHERN', 'DO-000501', (now() at time zone 'Asia/Kuala_Lumpur')::date, '300-J001', 'JB CO', 'Z', 'Taman JB', null, null);
update bi.delivery_doc set cancelled = true where doc_no = 'DO-017709';
insert into bi.delivery_driver (name, phone, store) values ('外包阿明', '60137145782', 'HQ'), ('JB 外包', '60120000009', 'JB');
select set_config('dlv.jb_driver', (select id::text from bi.delivery_driver where name = 'JB 外包'), false);

-- 员工：送货部司机（有手机）、送货部主管、门市（只看）、JB 门市
set role authenticated;
select pg_temp.as_user('boss@example.com');
select public.ops_staff_save('{"email":"driver@example.com","name":"司机阿强","department":"delivery","branch":"HOMEWORKSSB","phone":"012-777 8888"}');
select public.ops_staff_save('{"email":"dlvmgr@example.com","name":"送货主管","department":"delivery","branch":"HOMEWORKSSB","role":"manager"}');
select public.ops_staff_save('{"email":"jbsales2@example.com","name":"JB 门市","department":"sales","branch":"HOMEWORKSSOUTHERN"}');

-- 1. 权限与分店
select pg_temp.as_user('hqsales@example.com');      -- 门市（ops_test.sql 建的）：只看
do $$ declare m jsonb := public.ops_dlv_meta(); r jsonb; begin
  assert m->>'level' = 'view' and m->'companies' = '["HOMEWORKSSB"]'::jsonb, 'meta: ' || m::text;
  assert (select count(*) from jsonb_array_elements(m->'drivers') d where d->>'kind' = 'staff' and d->>'name' = '司机阿强'
            and d->>'phone' = '60127778888') = 1, 'staff driver listed: ' || (m->'drivers')::text;
  assert not exists (select 1 from jsonb_array_elements(m->'drivers') d where d->>'name' = 'JB 外包'), 'JB driver hidden';
  r := public.ops_dlv_lookup_many('', array['17707', 'nope', 'DO-017709']);
  assert jsonb_array_length(r) = 3 and r->0->>'doc_no' = 'DO-017707' and (r->0->>'found')::boolean
     and r->0->>'address' = '12 Jalan Seraya, 81300 Skudai' and r->0->'lines'->0->>'d' = 'TAP', 'many: ' || r::text;
  assert not (r->1->>'found')::boolean and (r->2->>'cancelled')::boolean, 'not found / cancelled: ' || r::text;
  r := public.ops_dlv_docs('', null);
  assert jsonb_array_length(r) = 2, 'today HQ docs (cancelled & JB excluded): ' || r::text;
  r := public.ops_dlv_lookup('', '17708');
  assert r->0->>'member_id' = '60123456789', 'phone from debtor name: ' || r::text;
  -- 内部备注、金额、业务员、客户代号不回传
  r := public.ops_dlv_lookup('', '17707');
  assert not (r->0 ? 'note') and not (r->0 ? 'amount') and not (r->0 ? 'sales_agent') and not (r->0 ? 'debtor_code'),
    'internal fields stripped (lookup): ' || r::text;
  r := public.ops_dlv_lookup_many('', array['17707']);
  assert not (r->0 ? 'note') and not (r->0 ? 'amount'), 'internal fields stripped (many): ' || r::text;
  r := public.ops_dlv_docs('', null);
  assert not (r->0 ? 'note') and not (r->0 ? 'amount'), 'internal fields stripped (docs): ' || r::text;
end $$;
select pg_temp.expect_error($q$select public.ops_dlv_docs('HOMEWORKSSOUTHERN', null)$q$, '分店');
select pg_temp.expect_error($q$select public.ops_dlv_lookup_many('HOMEWORKSSOUTHERN', array['501'])$q$, '分店');
select pg_temp.expect_error($q$select public.ops_dlv_doc_set_note('', 'DO-017707', 'x')$q$, '编辑');
select pg_temp.expect_error($q$select public.ops_dlv_run_save('{"company":"","stops":[{"key":"DO-017707"}],"token":"abcdefghijklmnopqrstuvwx"}')$q$, '编辑');
select pg_temp.as_user('jbsales2@example.com');
do $$ begin
  assert jsonb_array_length(public.ops_dlv_docs('', null)) = 1, 'JB sees own docs';
  assert public.ops_dlv_meta()->'companies' = '["HOMEWORKSSOUTHERN"]'::jsonb, 'JB company';
end $$;
-- 采购部没有送货模块
select pg_temp.as_user('hr@example.com');
select pg_temp.expect_error($q$select public.ops_dlv_meta()$q$, '「送货」模块');

-- 2. 司机（送货部可编辑）：改地址、备注、存坐标、排单
select pg_temp.as_user('driver@example.com');
do $$ declare r jsonb; begin
  assert public.ops_dlv_meta()->>'level' = 'edit', 'delivery dept edit';
  perform public.ops_dlv_doc_set_address('', 'DO-017708', '  5 Jalan Mawar, 81300  ');
  perform public.ops_dlv_doc_set_note('', 'DO-017708', '下午 2 点后');
  perform public.ops_dlv_geo_set('5 Jalan Mawar, 81300', 1.55, 103.7);
  r := public.ops_dlv_lookup_many('', array['17708']);
  assert r->0->>'address' = '5 Jalan Mawar, 81300' and r->0->>'address_source' = 'manual'
     and r->0->>'delivery_note' = '下午 2 点后' and (r->0->>'lat')::numeric = 1.55, 'override + note + geo: ' || r::text;
  r := public.ops_dlv_customer_set_address('012-345 6789', '5 Jalan Mawar');
  assert r->>'member_id' = '60123456789', 'profile address: ' || r::text;
end $$;
reset role;
do $$ begin
  assert (select override_by from bi.delivery_doc where doc_no = 'DO-017708') = 'driver@example.com', 'override_by';
  assert (select address || '|' || updated_by from bi.customer_profile where member_id = '60123456789') = '5 Jalan Mawar|driver@example.com',
    'profile address saved';
end $$;
set role authenticated;
select pg_temp.expect_error($q$select public.ops_dlv_doc_set_address('', 'DO-NOPE', 'x')$q$, '找不到');
select pg_temp.expect_error($q$select public.ops_dlv_doc_set_note('HOMEWORKSSOUTHERN', 'DO-000501', 'x')$q$, '分店');
select pg_temp.expect_error($q$select public.ops_dlv_geo_set('x', 95, 1)$q$, '坐标');
select pg_temp.expect_error($q$select public.ops_dlv_set_depot('', 'HQ', 1.5, 103.7)$q$, '审批');
select pg_temp.expect_error($q$select public.ops_dlv_run_save('{"company":"","stops":[],"token":"abcdefghijklmnopqrstuvwx"}')$q$, '还没有');
select pg_temp.expect_error($q$select public.ops_dlv_run_save('{"company":"","stops":[{"key":"A"}],"token":"short"}')$q$, '连结代码');
select pg_temp.expect_error($q$select public.ops_dlv_run_save('{"company":"","stops":[{"doc_no":"A"}],"token":"abcdefghijklmnopqrstuvwx"}')$q$, '不完整');
select pg_temp.expect_error(format($q$select public.ops_dlv_run_save('{"company":"","driver_kind":"ext","driver_id":%s,"stops":[{"key":"A"}],"token":"abcdefghijklmnopqrstuvwx"}')$q$,
  current_setting('dlv.jb_driver')), '不属于');
do $$ declare r jsonb; me_id bigint; begin
  me_id := (public.ops_dlv_meta()->>'me_id')::bigint;
  r := public.ops_dlv_run_save(jsonb_build_object('company', '', 'driver_kind', 'staff', 'driver_id', me_id,
         'stops', '[{"key":"DO-017707","doc_no":"DO-017707","note":"内部：欠款多"},{"key":"DO-017708","doc_no":"DO-017708"}]'::jsonb,
         'token', 'TOKEN_driver_run_000000001'));
  perform set_config('dlv.run_id', r->>'id', false);
  perform set_config('dlv.me_id', me_id::text, false);
end $$;
reset role;
do $$ declare v_id bigint := current_setting('dlv.run_id')::bigint; begin
  assert (select driver_staff_id = current_setting('dlv.me_id')::bigint and driver_phone = '60127778888' and store = 'HQ'
                 and token_expires > now() + interval '2 days' and created_by = 'driver@example.com'
            from bi.delivery_run where id = v_id), 'run saved with staff driver';
  assert (select not (stops->0 ? 'note') from bi.delivery_run where id = v_id), 'internal note not stored';
  -- BI 旧版存进去的站带 note：回传时也拿掉
  update bi.delivery_run set stops = jsonb_set(stops, '{1,note}', '"内部"') where id = v_id;
  -- 司机签了第一站（正式环境由 anon 的 bi_driver_pod 写入）
  insert into bi.delivery_pod (run_id, stop_key, doc_no, status, photos) values (v_id, 'DO-017707', 'DO-017707', 'delivered',
    array['TOKEN_driver_run_000000001/a.jpg']);
end $$;
set role authenticated;
do $$ declare r jsonb; begin
  r := public.ops_dlv_my_runs();
  assert jsonb_array_length(r) = 1 and r->0->>'token' = 'TOKEN_driver_run_000000001' and jsonb_array_length(r->0->'pods') = 1,
    'my runs: ' || r::text;
  assert not (r->0->'stops'->1 ? 'note') and r->0->'stops'->1->>'key' = 'DO-017708', 'note stripped on read: ' || (r->0->'stops')::text;
  r := public.ops_dlv_home();
  assert (r->>'my_stops_left')::int = 1 and (r->>'stops_open_today')::int = 1, 'home: ' || r::text;
  assert public.ops_dlv_photo_ok('TOKEN_driver_run_000000001'), 'driver sees own photos';
  -- 同一批单再排一次（按了两次 WhatsApp）：首页不重复算
  perform public.ops_dlv_run_save(jsonb_build_object('company', '', 'driver_kind', 'staff', 'driver_id', (public.ops_dlv_meta()->>'me_id')::bigint,
         'stops', '[{"key":"DO-017707","doc_no":"DO-017707"},{"key":"DO-017708","doc_no":"DO-017708"}]'::jsonb,
         'token', 'TOKEN_driver_run_000000002'));
  r := public.ops_dlv_home();
  assert (r->>'my_stops_left')::int = 1 and (r->>'stops_open_today')::int = 1, 'home dedup: ' || r::text;
  -- 改备注会记 audit_log
  perform public.ops_dlv_doc_set_note('', 'DO-017707', '后门');
end $$;
reset role;
do $$ begin
  assert (select count(*) from ops.audit_log where action = 'dlv_note') = 2, 'notes audited (section 2 + here)';
  assert (select count(*) from ops.audit_log where action = 'dlv_run') = 2, 'runs audited';
end $$;
set role authenticated;

-- 3. 门市（只看）：看得到排单与进度，但拿不到签收连结代码
select pg_temp.as_user('hqsales@example.com');
do $$ declare r jsonb := public.ops_dlv_runs('', 14); v jsonb; begin
  v := (select x from jsonb_array_elements(r) x where (x->>'id')::bigint = current_setting('dlv.run_id')::bigint);
  assert jsonb_array_length(r) = 2 and v->>'token' is null and (v->>'has_link')::boolean
     and v->'pods'->0->>'status' = 'delivered', 'viewer runs: ' || r::text;
  -- 照片路径里有连结代码：连结还有效时只看的人拿不到路径（只给张数），也读不到照片
  assert v->'pods'->0->'photos' = '[]'::jsonb and (v->'pods'->0->>'photo_count')::int = 1, 'viewer: no token-bearing paths: ' || v::text;
  assert not public.ops_dlv_photo_ok('TOKEN_driver_run_000000001'), 'viewer cannot read photos while link is live';
  assert (public.ops_dlv_home()->>'stops_open_today') is null, 'viewer: no open-stops count';
  assert jsonb_array_length(public.ops_dlv_my_runs()) = 0, 'not a driver';
end $$;
-- 连结过期后，只看的人就看得到照片（代码已不能签收）
reset role;
update bi.delivery_run set token_expires = now() - interval '1 minute' where token = 'TOKEN_driver_run_000000001';
set role authenticated;
do $$ declare v jsonb; begin
  v := (select x from jsonb_array_elements(public.ops_dlv_runs('', 14)) x where (x->>'id')::bigint = current_setting('dlv.run_id')::bigint);
  assert v->'pods'->0->'photos' = '["TOKEN_driver_run_000000001/a.jpg"]'::jsonb, 'viewer sees paths after expiry: ' || v::text;
  assert public.ops_dlv_photo_ok('TOKEN_driver_run_000000001'), 'viewer reads photos after expiry';
end $$;
-- JB 的人看不到 HQ 的照片；没在营运名单的人也看不到
select pg_temp.as_user('jbsales2@example.com');
do $$ begin
  assert not public.ops_dlv_photo_ok('TOKEN_driver_run_000000001'), 'JB cannot see HQ photos';
  assert jsonb_array_length(public.ops_dlv_runs('', 14)) = 0, 'JB runs empty';
end $$;
select pg_temp.as_user('stranger@example.com');
do $$ begin assert not public.ops_dlv_photo_ok('TOKEN_driver_run_000000001'), 'stranger'; end $$;

-- 4. 主管（manager → 可审批）：出发点、外包司机
select pg_temp.as_user('dlvmgr@example.com');
do $$ declare r jsonb; m jsonb; begin
  assert public.ops_dlv_meta()->>'level' = 'approve', 'manager approve';
  r := public.ops_dlv_runs('', 14);
  assert exists (select 1 from jsonb_array_elements(r) x where x->>'token' = 'TOKEN_driver_run_000000002'), 'editor gets token to re-share';
  -- 坐标：第一次存不记，已有的点被移动才记
  perform public.ops_dlv_geo_set('5 Jalan Mawar, 81300', 1.56, 103.71);
  perform public.ops_dlv_set_depot('', 'HomeWorks HQ', 1.5321, 103.6612);
  r := public.ops_dlv_driver_save('{"name":"新外包","phone":"013-111 2222","company":""}');
  assert r->>'store' = 'HQ' and r->>'phone' = '60131112222', 'ext driver: ' || r::text;
  perform public.ops_dlv_driver_save(jsonb_build_object('id', r->>'id', 'name', '新外包', 'phone', '0131112222', 'company', '', 'active', false));
  m := public.ops_dlv_meta();
  assert m->'depot'->'HQ'->>'address' = 'HomeWorks HQ' and not (m->'depot' ? 'JB'), 'depot: ' || (m->'depot')::text;
  assert not exists (select 1 from jsonb_array_elements(m->'drivers') d where d->>'name' = '新外包'), 'inactive driver hidden';
end $$;
reset role;
do $$ begin assert (select count(*) from ops.audit_log where action = 'dlv_geo') = 1, 'moved pin audited'; end $$;
set role authenticated;
select pg_temp.expect_error($q$select public.ops_dlv_driver_save('{"name":"x","phone":"123","company":""}')$q$, '手机');
select pg_temp.expect_error(format($q$select public.ops_dlv_driver_save('{"id":%s,"name":"x","phone":"0120000009","company":""}')$q$,
  current_setting('dlv.jb_driver')), '分店');
select pg_temp.expect_error($q$select public.ops_dlv_set_depot('HOMEWORKSSOUTHERN', 'JB', 1.5, 103.7)$q$, '分店');
-- 送货部但没有手机号码的员工不能当司机（司机清单也不会列）
select pg_temp.expect_error(format($q$select public.ops_dlv_run_save('{"company":"","driver_kind":"staff","driver_id":%s,"stops":[{"key":"A"}],"token":"abcdefghijklmnopqrstuvwx"}')$q$,
  (select (public.ops_dlv_meta()->>'me_id'))), '送货部 / 物流部');
reset role;

-- 物流部（20261008d）：新部门、预设权限、也能当司机；「送货安装」部门改名「送货部」
do $$ begin
  assert (select name from ops.department where code = 'logistics') = '物流部', 'logistics dept';
  assert (select name from ops.department where code = 'delivery') = '送货部', 'delivery renamed';
  assert (select string_agg(module || ':' || level, ',' order by module) from ops.dept_module where department = 'logistics')
       = 'approvals:edit,attendance:edit,dashboard:view,delivery:edit,leave:edit,purchasing:view,tasks:edit,warehouse:edit',
    'logistics modules';
end $$;
set role authenticated;
select pg_temp.as_user('boss@example.com');
select public.ops_staff_save('{"email":"logi@example.com","name":"物流阿华","department":"logistics","branch":"HOMEWORKSSB","phone":"016-555 1234"}');
select public.ops_staff_save('{"email":"logi.jb@example.com","name":"JB 物流","department":"logistics","branch":"HOMEWORKSSOUTHERN","phone":"016-555 9999"}');
select pg_temp.as_user('logi@example.com');
do $$ declare m jsonb := public.ops_dlv_meta(); me jsonb := public.ops_me(); r jsonb; v_id bigint; begin
  assert m->>'level' = 'edit', 'logistics can plan: ' || m::text;
  assert exists (select 1 from jsonb_array_elements(me->'modules') x where x->>'key' = 'warehouse' and x->>'level' = 'edit'), 'warehouse edit';
  assert exists (select 1 from jsonb_array_elements(me->'modules') x where x->>'key' = 'purchasing' and x->>'level' = 'view'), 'purchasing view';
  assert exists (select 1 from jsonb_array_elements(m->'drivers') d where d->>'kind' = 'staff' and d->>'name' = '物流阿华'
                 and d->>'phone' = '60165551234'), 'logistics staff listed as driver: ' || (m->'drivers')::text;
  assert exists (select 1 from jsonb_array_elements(m->'drivers') d where d->>'name' = '司机阿强'), 'delivery staff still drivers';
  assert not exists (select 1 from jsonb_array_elements(m->'drivers') d where d->>'name' = 'JB 物流'), 'JB logistics hidden from HQ';
  r := public.ops_dlv_run_save(jsonb_build_object('company', '', 'driver_kind', 'staff', 'driver_id', m->>'me_id',
         'stops', '[{"key":"DO-017707","doc_no":"DO-017707"}]'::jsonb, 'token', 'TOKEN_logistics_run_0000001'));
  v_id := (r->>'id')::bigint;
  assert jsonb_array_length(public.ops_dlv_my_runs()) = 1, 'logistics driver sees own run';
end $$;
reset role;
-- 物流部不提醒「今天还没盘点」（20261009）；仓库部照旧；物流部最近 30 天自己盘过的也照旧提醒
set role authenticated;
select pg_temp.as_user('logi@example.com');
do $$ begin
  assert public.ops_home()->'wh_counted_today' = 'null'::jsonb, 'logistics: no count reminder';
end $$;
select pg_temp.as_user('picker@example.com');
do $$ begin
  assert (public.ops_home()->>'wh_counted_today') is not null, 'warehouse still reminded';
end $$;
reset role;
insert into ops.wh_count (company, location, item_code, qty, system_qty, status, counted_by, count_date)
  values ('HOMEWORKSSB', 'HQ', 'X-LOGI', 1, 1, 'match', (select id from ops.staff where email = 'logi@example.com'), ops.today() - 5);
set role authenticated;
select pg_temp.as_user('logi@example.com');
do $$ begin
  assert (public.ops_home()->>'wh_counted_today')::int = 0, 'logistics who counted recently: reminded again';
end $$;
reset role;
delete from ops.wh_count where item_code = 'X-LOGI';
select set_config('dlv.logi_jb', (select id::text from ops.staff where email = 'logi.jb@example.com'), false),
       set_config('dlv.hqsales', (select id::text from ops.staff where email = 'hqsales@example.com'), false);
set role authenticated;
-- 不能指派别间分店的物流部员工
select pg_temp.expect_error(format($q$select public.ops_dlv_run_save('{"company":"","driver_kind":"staff","driver_id":%s,"stops":[{"key":"A"}],"token":"abcdefghijklmnopqrstuvwx"}')$q$,
  current_setting('dlv.logi_jb')), '送货部 / 物流部');
-- 销售部的人不能当司机
select pg_temp.expect_error(format($q$select public.ops_dlv_run_save('{"company":"","driver_kind":"staff","driver_id":%s,"stops":[{"key":"A"}],"token":"abcdefghijklmnopqrstuvwx"}')$q$,
  current_setting('dlv.hqsales')), '送货部 / 物流部');
reset role;

-- 两间分店共用的外包司机（store 空白）：只管一间分店的人不能改；管全部分店的人改了仍是共用（20261008e）
insert into bi.delivery_driver (name, phone, store) values ('共用外包', '60138888888', null);
select set_config('dlv.shared', (select id::text from bi.delivery_driver where name = '共用外包'), false);
set role authenticated;
select pg_temp.as_user('boss@example.com');
select public.ops_staff_save('{"email":"jbboss@example.com","name":"JB 经理","department":"mgmt","branch":"HOMEWORKSSOUTHERN"}');
select pg_temp.as_user('jbboss@example.com');
select pg_temp.expect_error(format($q$select public.ops_dlv_driver_save('{"id":%s,"name":"共用外包","phone":"0138888888","company":"","active":false}')$q$,
  current_setting('dlv.shared')), '两间分店共用');
select pg_temp.as_user('boss@example.com');
select public.ops_dlv_driver_save(jsonb_build_object('id', current_setting('dlv.shared'), 'name', '共用外包', 'phone', '0138888888',
  'company', 'HOMEWORKSSB', 'active', false));
reset role;
do $$ begin
  assert (select store is null and not active from bi.delivery_driver where name = '共用外包'), 'shared driver stays shared';
end $$;
select 'dlv_test ok';
