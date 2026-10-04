-- 薪资测试（接在 wh_test.sql 之后跑）：权限、设定、自动带入出勤、存档 / 发布 / 员工只看自己已发布的。
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
create or replace function pg_temp.sid(p_email text) returns bigint language sql security definer as $$
  select id from ops.staff where email = p_email
$$;
grant execute on all functions in schema pg_temp to authenticated;

set role authenticated;
-- 1. 权限：门市小美（销售）、仓库都进不去；财务部预设拿掉
select pg_temp.as_user('hqsales@example.com');
select pg_temp.expect_error('select public.ops_pay_meta()', '薪资');
select pg_temp.expect_error($q$select public.ops_pay_save('{"year":2026,"month":10,"records":[]}')$q$, '薪资');
do $$ begin assert jsonb_array_length(public.ops_pay_my()->'records') = 0, 'no slips yet'; end $$;
select pg_temp.as_user('picker@example.com');
select pg_temp.expect_error('select public.ops_pay_meta()', '薪资');

-- 2. HR：设定、员工薪资资料
select pg_temp.as_user('hr@example.com');
do $$ declare m jsonb := public.ops_pay_meta(); begin
  assert m->>'level' = 'edit', 'hr edit: ' || (m->>'level');
  assert exists (select 1 from jsonb_array_elements(m->'profiles') x where x->>'name' = '门市小美' and not (x->>'has_profile')::boolean),
    'profiles listed';
end $$;
select pg_temp.expect_error($q$select public.ops_pay_setting_save('{"params":{"lateUnit":0}}')$q$, '至少要 1');
select pg_temp.expect_error($q$select public.ops_pay_setting_save('{"params":{"hack":1}}')$q$, '参数 hack');
select public.ops_pay_setting_save('{"company":"HOMEWORKS SDN. BHD.","params":{"wrongGoodsRate":10}}');
select pg_temp.expect_error($q$select public.ops_pay_profile_save(jsonb_build_object('staff_id', pg_temp.sid('hqsales@example.com'), 'base', -1))$q$, '负数');
select pg_temp.expect_error($q$select public.ops_pay_profile_save(jsonb_build_object('staff_id', pg_temp.sid('hqsales@example.com'), 'leave_date', '2026-01-01'))$q$, '到职日');
do $$ declare p jsonb; begin
  p := public.ops_pay_profile_save(jsonb_build_object('staff_id', pg_temp.sid('hqsales@example.com'), 'base', 2000,
         'comm_type', 'percent', 'comm_rate', 1.5, 'phone', '0123456789', 'pay_name', 'SIEW MEI'));
  assert (p->>'has_profile')::boolean and (p->>'base')::numeric = 2000 and p->>'phone' = '0123456789', 'profile: ' || p::text;
  -- 只拿佣金：底薪强制 0
  p := public.ops_pay_profile_save(jsonb_build_object('staff_id', pg_temp.sid('picker@example.com'), 'base', 1800, 'comm_only', true));
  assert (p->>'base')::numeric = 0, 'comm only base 0';
  p := public.ops_pay_profile_save(jsonb_build_object('staff_id', pg_temp.sid('picker@example.com'), 'base', 1800));
end $$;

-- 3. 10 月出勤自动带入（打卡测试：10/05 迟到、10/19 午休迟回 10 分、10/20 午休迟回 5 分；请假测试留下的假）
--    再批一天无薪假（10/27）、一个下午无薪假（10/28）
reset role;
select pg_temp.at('2026-10-23 09:00:00+08');
set role authenticated;
select pg_temp.as_user('hr@example.com');
select public.ops_leave_apply(jsonb_build_object('type', 'unpaid', 'start_date', '2026-10-27', 'staff_id', pg_temp.sid('hqsales@example.com')));
select public.ops_leave_apply(jsonb_build_object('type', 'unpaid', 'start_date', '2026-10-28', 'part', 'pm', 'staff_id', pg_temp.sid('hqsales@example.com')));
do $$ declare r jsonb; begin
  for r in select jsonb_array_elements(public.ops_leave_list('{"scope":"todo"}')) loop
    if r->>'type' = 'unpaid' then perform public.ops_leave_decide((r->>'id')::bigint, 'approve'); end if;
  end loop;
end $$;
select pg_temp.at('2026-11-02 09:00:00+08');
do $$ declare m jsonb := public.ops_pay_month(2026, 10); x jsonb; d jsonb; begin
  x := (select e from jsonb_array_elements(m->'rows') e where e->>'name' = '门市小美');
  assert x is not null and (select count(*) from jsonb_array_elements(m->'rows') e where e->>'name' = '仓库阿强') = 1, 'rows: ' || m::text;
  d := public.ops_att_days('2026-10', pg_temp.sid('hqsales@example.com'));
  assert (x->'att'->>'late_days')::int = (select count(*) from jsonb_array_elements(d->'days') z where (z->>'late_min')::int > 0),
    'late days = att report: ' || (x->'att')::text;
  assert (x->'att'->>'lunch_late_days')::int = (select count(*) from jsonb_array_elements(d->'days') z where (z->>'lunch_late_min')::int > 0),
    'lunch late days';
  assert (x->'att'->>'lunch_late_days')::int >= 2, 'has lunch late';
  assert (x->'att'->>'unpaid_days')::numeric = 1.5, 'unpaid 1 + 0.5: ' || (x->'att')::text;
  assert (x->'att'->>'absent_days')::int > 0, 'absent days shown';
  assert x->'records' = '{}'::jsonb, 'no records yet';
end $$;

-- 4. 存档：一批两笔；同一笔再存没变就不算；改了就更新
do $$ declare n int; m jsonb; x jsonb; begin
  n := public.ops_pay_save(jsonb_build_object('year', 2026, 'month', 10, 'records', jsonb_build_array(
    jsonb_build_object('staff_id', pg_temp.sid('hqsales@example.com'), 'type', 'base', 'inputs', '{"lateCount":4}'::jsonb,
                       'result', '{"net":1800.5}'::jsonb, 'pay', 1800.5),
    jsonb_build_object('staff_id', pg_temp.sid('hqsales@example.com'), 'type', 'comm', 'inputs', '{"sales":10000}'::jsonb,
                       'result', '{"payout":150}'::jsonb, 'pay', 150))));
  assert n = 2, 'saved 2';
  n := public.ops_pay_save(jsonb_build_object('year', 2026, 'month', 10, 'records', jsonb_build_array(
    jsonb_build_object('staff_id', pg_temp.sid('hqsales@example.com'), 'type', 'comm', 'inputs', '{"sales":10000}'::jsonb,
                       'result', '{"payout":150}'::jsonb, 'pay', 150))));
  assert n = 0, 'unchanged not counted';
  m := public.ops_pay_month(2026, 10);
  x := (select e from jsonb_array_elements(m->'rows') e where e->>'name' = '门市小美');
  assert (x->'records'->'base'->>'pay')::numeric = 1800.5 and x->'records'->'comm'->>'name' = 'SIEW MEI', 'records in month';
end $$;
select pg_temp.expect_error($q$select public.ops_pay_save('{"year":2026,"month":13,"records":[]}')$q$, '月份');
select pg_temp.expect_error($q$select public.ops_pay_save(jsonb_build_object('year',2026,'month',10,'records',jsonb_build_array(jsonb_build_object('staff_id', pg_temp.sid('hqsales@example.com'),'type','bonus','result','{}'::jsonb,'pay',1))))$q$, '格式');

-- 5. 发布前员工看不到；发布后只看到自己的；改了退回草稿
select pg_temp.as_user('hqsales@example.com');
do $$ begin assert jsonb_array_length(public.ops_pay_my()->'records') = 0, 'draft hidden'; end $$;
select pg_temp.as_user('hr@example.com');
do $$ begin assert public.ops_pay_publish(2026, 10, true) = 2, 'published 2'; end $$;
select pg_temp.as_user('hqsales@example.com');
do $$ declare m jsonb := public.ops_pay_my(); begin
  assert jsonb_array_length(m->'records') = 2 and m->>'company' = 'HOMEWORKS SDN. BHD.', 'my slips: ' || m::text;
end $$;
select pg_temp.as_user('picker@example.com');
do $$ begin assert jsonb_array_length(public.ops_pay_my()->'records') = 0, 'others not visible'; end $$;
select pg_temp.as_user('hr@example.com');
do $$ declare h jsonb; begin
  perform public.ops_pay_save(jsonb_build_object('year', 2026, 'month', 10, 'records', jsonb_build_array(
    jsonb_build_object('staff_id', pg_temp.sid('hqsales@example.com'), 'type', 'comm', 'inputs', '{"sales":12000}'::jsonb,
                       'result', '{"payout":180}'::jsonb, 'pay', 180))));
  h := public.ops_pay_history('{"year":2026,"month":10}');
  assert (select e->>'status' from jsonb_array_elements(h) e where e->>'type' = 'comm') = 'draft', 'edited back to draft';
  assert (select e->>'status' from jsonb_array_elements(h) e where e->>'type' = 'base') = 'published', 'base still published';
end $$;
select pg_temp.as_user('hqsales@example.com');
do $$ begin assert jsonb_array_length(public.ops_pay_my()->'records') = 1, 'only published one'; end $$;

-- 6. 管理层（老板）可以看可以改；删除
select pg_temp.as_user('boss@example.com');
do $$ declare h jsonb := public.ops_pay_history('{}'); begin
  assert public.ops_pay_meta()->>'level' = 'approve' and jsonb_array_length(h) = 2, 'boss sees';
  perform public.ops_pay_delete((select (e->>'id')::bigint from jsonb_array_elements(h) e where e->>'type' = 'comm'));
  assert jsonb_array_length(public.ops_pay_history('{}')) = 1, 'deleted';
end $$;

reset role;
select 'ALL PAYROLL TESTS PASSED' as result;
