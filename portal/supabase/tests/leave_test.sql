-- 请假测试（接在 att_test.sql 之后跑，沿用它的员工与 HomeWorks 班表：星期一到六上班、星期日休）。
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
create or replace function pg_temp.photo(p_email text, p_name text) returns text language plpgsql security definer as $$
declare
  path text := pg_temp.sid(p_email) || '/' || p_name;
begin
  insert into storage.objects (bucket_id, name) values ('ops-hr', path);
  return path;
end $$;
create or replace function pg_temp.bal(b jsonb, p_type text, p_key text) returns numeric language sql as $$
  select (x->>p_key)::numeric from jsonb_array_elements(b) x where x->>'type' = p_type
$$;
create or replace function pg_temp.last_leave() returns bigint language sql security definer as $$
  select max(id) from ops.leave_request
$$;
create or replace function pg_temp.first_annual() returns bigint language sql security definer as $$
  select min(id) from ops.leave_request where type = 'annual'
$$;
grant execute on all functions in schema pg_temp to authenticated;

-- 纯计算：年资、应得天数
do $$ declare st ops.staff; lt ops.leave_type; begin
  assert ops.leave_years('2024-03-01', '2026-02-28') = 1 and ops.leave_years('2024-03-01', '2026-03-01') = 2, 'years';
  select * into lt from ops.leave_type where code = 'annual';
  st.join_date := '2020-01-01';
  assert ops.leave_entitled(st, lt, 2026) = 16, 'annual 5y+';
  st.join_date := '2024-09-01';
  assert ops.leave_entitled(st, lt, 2026) = 12, 'annual 2-5y (today >= 2026-09-01)';
  assert ops.leave_entitled(st, lt, 2025) = 8, 'annual 2025 = 1 year at 12/31';
  st.join_date := null;
  assert ops.leave_entitled(st, lt, 2026) = 8, 'annual no join date = first tier, full';
  st.join_date := '2027-02-01';
  assert ops.leave_entitled(st, lt, 2026) = 0, 'not joined yet';
  -- 年假要到职满 3 个月才能请（2026-10-09），但应得天数照算：11/15 到职 → 8 × 1/12 → 1 天（不是 0）
  assert lt.min_service_months = 3, 'annual min service 3 months';
  st.join_date := '2026-11-15';
  assert ops.leave_entitled(st, lt, 2026) = 1, 'annual min service does not zero entitlement';
  select * into lt from ops.leave_type where code = 'sick';
  st.join_date := '2022-01-01';
  assert ops.leave_entitled(st, lt, 2025) = 18, 'sick 2-5y';
  select * into lt from ops.leave_type where code = 'unpaid';
  assert ops.leave_entitled(st, lt, 2026) is null, 'unpaid no balance';
end $$;

-- 门市小美 2026-09-01 到职：年假按比例 8 × 4/12 = 2.67 → 3 天；病假 14 天
select pg_temp.at('2026-10-21 09:30:00+08');   -- 星期三
set role authenticated;
select pg_temp.as_user('hqsales@example.com');
do $$ declare h jsonb := public.ops_leave_home(); begin
  assert pg_temp.bal(h->'balances', 'annual', 'entitled') = 3, 'annual prorated: ' || (h->'balances')::text;
  assert pg_temp.bal(h->'balances', 'sick', 'entitled') = 14, 'sick 14';
  assert pg_temp.bal(h->'balances', 'paternity', 'entitled') = 0, 'paternity needs 12 months';
  assert not (h->>'is_hr')::boolean, 'not hr';
  -- 10/22 星期四 – 10/26 星期一：中间星期日不算 = 4 天
  assert (public.ops_leave_preview('{"type":"annual","start_date":"2026-10-22","end_date":"2026-10-26"}')->>'days')::numeric = 4,
    'preview skips sunday';
  assert (public.ops_leave_preview('{"type":"compassionate","start_date":"2026-10-24","end_date":"2026-10-26"}')->>'days')::numeric = 3,
    'calendar days';
end $$;
-- 年假到职满 3 个月：小美 9/1 到职 → 12/1 起才能请（请假页拿得到这个日期）
do $$ declare h jsonb := public.ops_leave_home(); begin
  assert (select x->>'available_from' from jsonb_array_elements(h->'types') x where x->>'code' = 'annual') = '2026-12-01'
     and (select (x->>'min_service_months')::int from jsonb_array_elements(h->'types') x where x->>'code' = 'annual') = 3,
    'annual available_from: ' || (h->'types')::text;
  assert (select x->'available_from' from jsonb_array_elements(h->'types') x where x->>'code' = 'sick') = 'null'::jsonb,
    'sick has no service limit';
end $$;
select pg_temp.expect_error($q$select public.ops_leave_apply('{"type":"annual","start_date":"2026-10-22","end_date":"2026-10-23"}')$q$,
  '到职满 3 个月（2026-12-01）后才能请年假');
-- HR（人事可审批）可以改月数：先改成不限，沿用下面原本的年假测试；最后再改回 3 个月
select pg_temp.as_user('boss@example.com');
select pg_temp.expect_error($q$select public.ops_leave_type_save('{"code":"annual","min_service_months":-1}')$q$, '0 – 120');
select pg_temp.expect_error($q$select public.ops_leave_type_save('{"code":"annual","min_service_months":121}')$q$, '0 – 120');
select pg_temp.expect_error($q$select public.ops_leave_type_save('{"code":"annual","min_service_months":"三"}')$q$, '0 – 120');
select public.ops_leave_type_save('{"code":"annual","min_service_months":0}');
do $$ begin
  assert (select (x->>'min_service_months')::int from jsonb_array_elements(public.ops_leave_types()) x where x->>'code' = 'annual') = 0,
    'min service saved';
end $$;
-- 没带 min_service_months（旧版前端）= 不改
select public.ops_leave_type_save('{"code":"annual","half_day":true}');
do $$ begin
  assert (select (x->>'min_service_months')::int from jsonb_array_elements(public.ops_leave_types()) x where x->>'code' = 'annual') = 0,
    'min service untouched';
end $$;
select pg_temp.as_user('hqsales@example.com');
select pg_temp.expect_error($q$select public.ops_leave_apply('{"type":"annual","start_date":"2026-10-22","end_date":"2026-10-26"}')$q$, '余额不够');
select pg_temp.expect_error($q$select public.ops_leave_apply('{"type":"annual","start_date":"2026-10-25"}')$q$, '不是上班日');
select pg_temp.expect_error($q$select public.ops_leave_apply('{"type":"annual","start_date":"2026-12-31","end_date":"2027-01-02"}')$q$, '不能跨年');
select pg_temp.expect_error($q$select public.ops_leave_apply('{"type":"marriage","start_date":"2026-10-28","part":"am"}')$q$, '不能请半天');
select pg_temp.expect_error($q$select public.ops_leave_apply('{"type":"annual","start_date":"2026-10-28","end_date":"2026-10-29","part":"am"}')$q$, '只能选一天');
select pg_temp.expect_error($q$select public.ops_leave_apply('{"type":"annual","start_date":"2026-08-01"}')$q$, '30 天');
do $$ declare r jsonb; begin
  r := public.ops_leave_apply('{"type":"annual","start_date":"2026-10-22","end_date":"2026-10-23","reason":"回乡"}');
  assert r->>'status' = 'pending' and (r->>'days')::numeric = 2 and (r->>'can_cancel')::boolean
     and not (r->>'can_decide')::boolean, 'applied: ' || r::text;
  r := public.ops_leave_apply('{"type":"annual","start_date":"2026-10-26","part":"am"}');
  assert (r->>'days')::numeric = 0.5, 'half day';
  -- 下午半天同一天可以另请（无薪）
  r := public.ops_leave_apply('{"type":"unpaid","start_date":"2026-10-26","part":"pm"}');
  assert (r->>'days')::numeric = 0.5, 'pm half other type';
end $$;
-- 已用 2.5（审核中也算）：再请 1 天超过 3 天
select pg_temp.expect_error($q$select public.ops_leave_apply('{"type":"annual","start_date":"2026-10-28"}')$q$, '余额不够');
select pg_temp.expect_error($q$select public.ops_leave_apply('{"type":"unpaid","start_date":"2026-10-23"}')$q$, '已经有请假');
select pg_temp.expect_error($q$select public.ops_leave_apply('{"type":"sick","start_date":"2026-10-21"}')$q$, '要附证明');
select pg_temp.expect_error($q$select public.ops_leave_apply(jsonb_build_object('type','sick','start_date','2026-10-21',
  'attachment', pg_temp.sid('buyer@example.com') || '/mc.jpg'))$q$, '附件没有上传成功');
select public.ops_leave_apply(jsonb_build_object('type', 'sick', 'start_date', '2026-10-21', 'reason', '发烧',
                                                 'attachment', pg_temp.photo('hqsales@example.com', 'leave/mc.jpg')));
select pg_temp.expect_error($q$select public.ops_leave_apply('{"type":"compassionate","start_date":"2026-11-02","end_date":"2026-11-05"}')$q$, '最多 3 天');
-- 一般员工不能帮别人请、不能看 HR 清单
select pg_temp.expect_error($q$select public.ops_leave_apply(jsonb_build_object('type','unpaid','start_date','2026-11-02',
  'staff_id', pg_temp.sid('buyer@example.com')))$q$, '只有 HR');
select pg_temp.expect_error($q$select public.ops_leave_list()$q$, '人事');
select pg_temp.expect_error($q$select public.ops_leave_decide(1, 'approve')$q$, '只有 HR');

-- 性别：HR 设成男 → 产假被挡，表单也不显示产假
select pg_temp.as_user('hr@example.com');
select public.ops_att_staff_set(jsonb_build_object('id', pg_temp.sid('hqsales@example.com'), 'gender', 'M'));
select pg_temp.as_user('hqsales@example.com');
select pg_temp.expect_error($q$select public.ops_leave_apply('{"type":"maternity","start_date":"2026-11-02"}')$q$, '只限女');
select pg_temp.expect_error($q$select public.ops_leave_apply('{"type":"paternity","start_date":"2026-11-02"}')$q$, '服务满 12 个月');
do $$ declare h jsonb := public.ops_leave_home(); begin
  assert not exists (select 1 from jsonb_array_elements(h->'types') t where t->>'code' = 'maternity'), 'maternity hidden';
  assert pg_temp.bal(h->'balances', 'annual', 'pending') = 2.5, 'pending 2.5';
end $$;

-- 店长（人事只看）审不到；HR 审
select pg_temp.as_user('mgr@example.com');
do $$ begin assert jsonb_array_length(public.ops_leave_list('{"scope":"todo"}')) = 0, 'mgr no todo'; end $$;
select pg_temp.expect_error($q$select public.ops_leave_adjust(jsonb_build_object('staff_id', pg_temp.sid('hqsales@example.com'),
  'year', 2026, 'type', 'annual', 'days', 1, 'note', 'x'))$q$, '人事');
select pg_temp.as_user('hr@example.com');
do $$ declare l jsonb := public.ops_leave_list('{"scope":"todo"}'); r jsonb; begin
  assert jsonb_array_length(l) = 4, 'hr todo 4: ' || l::text;
  assert (public.ops_home()->>'leave_waiting')::int = 4, 'home count';
  foreach r in array array(select jsonb_array_elements(l)) loop
    if r->>'type' = 'unpaid' then
      perform pg_temp.expect_error(format('select public.ops_leave_decide(%s, %L)', r->>'id', 'reject'), '驳回请写原因');
      r := public.ops_leave_decide((r->>'id')::bigint, 'reject', '那天要盘点');
      assert r->>'status' = 'rejected', 'rejected';
    else
      r := public.ops_leave_decide((r->>'id')::bigint, 'approve');
      assert r->>'status' = 'approved' and r->>'decided_by_name' is not null, 'approved: ' || r::text;
    end if;
  end loop;
end $$;
select pg_temp.expect_error($q$select public.ops_leave_decide(pg_temp.last_leave(), 'approve')$q$, '处理过');
-- HR 不能审自己的
select public.ops_leave_apply('{"type":"annual","start_date":"2026-11-02"}');
select pg_temp.expect_error($q$select public.ops_leave_decide(pg_temp.last_leave(), 'approve')$q$, '不能审自己');
select public.ops_leave_cancel(pg_temp.last_leave());

-- HR 调整：+2 天（2025 年结转）→ 小美可以再请
select pg_temp.expect_error($q$select public.ops_leave_adjust(jsonb_build_object('staff_id', pg_temp.sid('hqsales@example.com'),
  'year', 2026, 'type', 'annual', 'days', 0.3, 'note', 'x'))$q$, '0.5 的倍数');
select pg_temp.expect_error($q$select public.ops_leave_adjust(jsonb_build_object('staff_id', pg_temp.sid('hqsales@example.com'),
  'year', 2026, 'type', 'unpaid', 'days', 1, 'note', 'x'))$q$, '没有余额');
select public.ops_leave_adjust(jsonb_build_object('staff_id', pg_temp.sid('hqsales@example.com'),
                                                  'year', 2026, 'type', 'annual', 'days', 2, 'note', '2025 年结转'));
do $$ declare b jsonb; begin
  b := (select x->'balances' from jsonb_array_elements(public.ops_leave_balances(2026)->'rows') x where x->>'name' = '门市小美');
  assert pg_temp.bal(b, 'annual', 'adjust') = 2 and pg_temp.bal(b, 'annual', 'used') = 2.5
     and pg_temp.bal(b, 'annual', 'balance') = 2.5, 'balances: ' || b::text;
  assert pg_temp.bal(b, 'sick', 'used') = 1, 'sick used';
end $$;
select pg_temp.as_user('hqsales@example.com');
select public.ops_leave_apply('{"type":"annual","start_date":"2026-10-28"}');
-- 审核中的可以自己撤回
select public.ops_leave_cancel(pg_temp.last_leave());

-- 打卡联动：10/22、10/23 请年假 → 不算缺勤；10/26 上午半天 → 13:30 才上班不算迟到
select pg_temp.at('2026-10-26 13:30:00+08');
select public.ops_att_self_close('{"date":"2026-10-20","time":"17:30","reason":"忘了打下班卡"}');
do $$ declare t jsonb; begin
  t := public.ops_att_punch(jsonb_build_object('action', 'in', 'lat', 1.5, 'lng', 103.7,
                                               'selfie', pg_temp.photo('hqsales@example.com', '2026-10-26/in.jpg')));
  assert (t->'record'->>'late_min')::int = 0 and t->'record'->'leave'->>'part' = 'am', 'am leave no late: ' || t::text;
end $$;
select pg_temp.expect_error($q$select public.ops_leave_cancel(pg_temp.first_annual())$q$, '已经开始');
select pg_temp.as_user('hr@example.com');
do $$ declare m jsonb; d jsonb; begin
  m := (select x from jsonb_array_elements(public.ops_att_month('2026-10')) x where x->>'name' = '门市小美');
  -- 已批：年假 2 + 半天 0.5 + 病假 1 = 3.5
  assert (m->>'leave_days')::numeric = 3.5, 'leave days: ' || m::text;
  d := public.ops_att_days('2026-10', pg_temp.sid('hqsales@example.com'));
  assert (select x->'leave'->>'name' from jsonb_array_elements(d->'days') x where x->>'date' = '2026-10-22') = '年假',
    'day shows leave';
end $$;
-- HR 可以取消已开始的假
do $$ declare r jsonb; begin
  r := public.ops_leave_cancel(pg_temp.first_annual(), '其实有来上班');
  assert r->>'status' = 'cancelled' and r->>'decision_note' = '其实有来上班', 'hr cancel: ' || r::text;
end $$;

-- 假别设定：只有人事「可审批」能改（hr 部门是可编辑 → 被挡；老板可以）
select pg_temp.expect_error($q$select public.ops_leave_type_save('{"code":"marriage","days":5}')$q$, '审批');
select pg_temp.as_user('boss@example.com');
select public.ops_leave_type_save('{"code":"marriage","days":5,"half_day":true}');
do $$ declare t jsonb := public.ops_leave_types(); begin
  assert (select (x->>'days')::numeric from jsonb_array_elements(t) x where x->>'code' = 'marriage') = 5, 'type saved';
end $$;

-- 年假改回到职满 3 个月：小美 11/30 被挡、12/1 可以（应得天数没被归零）；没填到职日（buyer）不挡；陪产假规则照旧
select public.ops_leave_type_save('{"code":"annual","min_service_months":3}');
select pg_temp.as_user('hqsales@example.com');
select pg_temp.expect_error($q$select public.ops_leave_apply('{"type":"annual","start_date":"2026-11-30"}')$q$,
  '到职满 3 个月（2026-12-01）后才能请年假');
do $$ declare r jsonb; begin
  assert pg_temp.bal(public.ops_leave_home()->'balances', 'annual', 'entitled') = 3, 'entitlement not zeroed';
  r := public.ops_leave_apply('{"type":"annual","start_date":"2026-12-01"}');
  assert r->>'status' = 'pending' and (r->>'days')::numeric = 1, 'annual after 3 months: ' || r::text;
  perform public.ops_leave_cancel((r->>'id')::bigint);
end $$;
select pg_temp.expect_error($q$select public.ops_leave_apply('{"type":"paternity","start_date":"2026-12-01"}')$q$, '服务满 12 个月');
select pg_temp.as_user('buyer@example.com');
do $$ declare r jsonb; h jsonb := public.ops_leave_home(); begin
  assert h->'join_date' = 'null'::jsonb, 'buyer has no join date';
  assert (select x->'available_from' from jsonb_array_elements(h->'types') x where x->>'code' = 'annual') = 'null'::jsonb,
    'no join date = no date';
  r := public.ops_leave_apply('{"type":"annual","start_date":"2026-11-02"}');
  assert r->>'status' = 'pending', 'no join date = not blocked';
  perform public.ops_leave_cancel((r->>'id')::bigint);
end $$;
-- 最后上班日之后不能请假
select pg_temp.as_user('hr@example.com');
select public.ops_att_staff_set(jsonb_build_object('id', pg_temp.sid('buyer@example.com'), 'last_day', '2026-11-30'));
select pg_temp.as_user('buyer@example.com');
select pg_temp.expect_error($q$select public.ops_leave_apply('{"type":"annual","start_date":"2026-11-30","end_date":"2026-12-01"}')$q$,
  '不能晚于最后上班日（2026-11-30）');
do $$ begin assert public.ops_leave_home()->>'last_day' = '2026-11-30', 'leave home last_day'; end $$;
select pg_temp.as_user('hr@example.com');
select public.ops_att_staff_set(jsonb_build_object('id', pg_temp.sid('buyer@example.com'), 'last_day', ''));

reset role;
select 'ALL LEAVE TESTS PASSED' as result;
