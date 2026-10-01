-- 打卡 + 补卡测试（接在 ops_test.sql 之后跑，沿用它建好的员工）。用 ops.fake_now 固定「现在」。
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
-- 模拟手机上传自拍（Storage 的 insert 由 policy 把关，这里直接写 objects 表）
create or replace function pg_temp.photo(p_email text, p_name text) returns text language plpgsql security definer as $$
declare
  path text := pg_temp.sid(p_email) || '/' || p_name;
begin
  insert into storage.objects (bucket_id, name) values ('ops-hr', path);
  return path;
end $$;
grant execute on all functions in schema pg_temp to authenticated;
grant usage on schema storage to authenticated;
grant select on storage.objects to authenticated;   -- 只为了让测试能检查 policy 函数；正式环境由 Storage 管

-- 0. 设定：HQ 打卡点、门市小美从 9 月就到职
select pg_temp.at('2026-10-05 07:00:00+08');
set role authenticated;
select pg_temp.as_user('boss@example.com');
select public.ops_att_fence_save('{"branch":"HOMEWORKSSB","name":"HQ 门市","lat":1.5,"lng":103.7,"radius":100}');
select public.ops_att_staff_set(jsonb_build_object('id', pg_temp.sid('hqsales@example.com'), 'join_date', '2026-09-01'));
do $$ declare s jsonb := public.ops_att_settings(); begin
  assert jsonb_array_length(s->'shifts') = 2 and jsonb_array_length(s->'fences') = 1, 'settings: ' || s::text;
  assert (select d->>'date' from jsonb_array_elements(s->'saturdays') d where d->>'ym' = '2026-10') = '2026-10-03',
    'first saturday default';
end $$;
-- 一般员工不能改设定
select pg_temp.as_user('hqsales@example.com');
select pg_temp.expect_error('select public.ops_att_settings()', '人事');
select pg_temp.expect_error($q$select public.ops_att_fence_save('{"branch":"HOMEWORKSSB","name":"x","lat":1,"lng":1}')$q$, '人事');

-- 1. 星期一 08:35:20 上班：迟到 5 分钟（秒数不算）
select pg_temp.at('2026-10-05 08:35:20+08');
select pg_temp.expect_error($q$select public.ops_att_punch('{"action":"in","lat":1.5,"lng":103.7}')$q$, '请先拍照');
select pg_temp.expect_error($q$select public.ops_att_punch(jsonb_build_object('action','in','lat',1.5,'lng',103.7,
  'selfie', pg_temp.sid('buyer@example.com') || '/fake.jpg'))$q$, '没有上传成功');
select pg_temp.expect_error($q$select public.ops_att_punch(jsonb_build_object('action','in','lat',1.51,'lng',103.7,
  'selfie', pg_temp.photo('hqsales@example.com', '2026-10-05/in.jpg')))$q$, '不在打卡范围');
select pg_temp.expect_error($q$select public.ops_att_punch(jsonb_build_object('action','in',
  'selfie', pg_temp.photo('hqsales@example.com', '2026-10-05/in2.jpg')))$q$, '读不到你的位置');
do $$ declare t jsonb; begin
  t := public.ops_att_punch(jsonb_build_object('action', 'in', 'lat', 1.5005, 'lng', 103.7,
                                               'selfie', pg_temp.photo('hqsales@example.com', '2026-10-05/in3.jpg')));
  assert t->'record'->>'in_place' = 'HQ 门市' and (t->'record'->>'late_min')::int = 5, 'late 5: ' || t::text;
end $$;
select pg_temp.expect_error($q$select public.ops_att_punch(jsonb_build_object('action','in','lat',1.5,'lng',103.7,
  'selfie', pg_temp.photo('hqsales@example.com', '2026-10-05/in4.jpg')))$q$, '已经打过上班卡');

-- 2. 12:31 下班（去吃饭）→ 13:33 上班（自动记午休，迟回 3 分钟）→ 17:50 下班
select pg_temp.at('2026-10-05 12:31:00+08');
select public.ops_att_punch(jsonb_build_object('action', 'out', 'selfie', pg_temp.photo('hqsales@example.com', '2026-10-05/o1.jpg')));
select pg_temp.at('2026-10-05 13:33:40+08');
do $$ declare t jsonb; begin
  t := public.ops_att_punch(jsonb_build_object('action', 'in', 'lat', 1.5, 'lng', 103.7,
                                               'selfie', pg_temp.photo('hqsales@example.com', '2026-10-05/i2.jpg')));
  assert t->'record'->>'lunch_out' is not null and t->'record'->>'clock_out' is null, 'lunch recorded: ' || t::text;
  assert (t->'record'->>'lunch_late_min')::int = 3, 'lunch late 3';
end $$;
select pg_temp.at('2026-10-05 17:50:00+08');
do $$ declare t jsonb; begin
  t := public.ops_att_punch(jsonb_build_object('action', 'out', 'selfie', pg_temp.photo('hqsales@example.com', '2026-10-05/o2.jpg')));
  -- 08:35:20 → 17:50 = 554 分，扣午休 12:31–13:33:40 = 62 分
  assert (t->'record'->>'worked_min')::int = 492 and (t->'record'->>'early_min')::int = 0, 'worked: ' || t::text;
  assert (public.ops_home()->'att'->>'clock_out') is not null, 'home att';
end $$;
-- 下班后又回来（加班）：清掉下班卡
select pg_temp.at('2026-10-05 18:30:00+08');
do $$ declare t jsonb; begin
  t := public.ops_att_punch(jsonb_build_object('action', 'in', 'lat', 1.5, 'lng', 103.7,
                                               'selfie', pg_temp.photo('hqsales@example.com', '2026-10-05/i3.jpg')));
  assert t->'record'->>'clock_out' is null and t->'record'->>'lunch_in' is not null, 'OT re-entry';
end $$;
select pg_temp.at('2026-10-05 20:00:00+08');
select public.ops_att_punch(jsonb_build_object('action', 'out', 'selfie', pg_temp.photo('hqsales@example.com', '2026-10-05/o3.jpg')));

-- 3. 星期二 08:30:59 上班（不算迟到），忘了打下班卡
select pg_temp.at('2026-10-06 08:30:59+08');
do $$ declare t jsonb; begin
  t := public.ops_att_punch(jsonb_build_object('action', 'in', 'lat', 1.5, 'lng', 103.7,
                                               'selfie', pg_temp.photo('hqsales@example.com', '2026-10-06/in.jpg')));
  assert (t->'record'->>'late_min')::int = 0, '08:30:59 not late';
end $$;
-- 星期三：被挡，先补下班卡
select pg_temp.at('2026-10-07 08:20:00+08');
select pg_temp.expect_error($q$select public.ops_att_punch(jsonb_build_object('action','in','lat',1.5,'lng',103.7,
  'selfie', pg_temp.photo('hqsales@example.com', '2026-10-07/in.jpg')))$q$, '没有打下班卡');
do $$ declare t jsonb := public.ops_att_today(); begin
  assert t->>'open_shift' = '2026-10-06', 'open shift shown';
end $$;
select pg_temp.expect_error($q$select public.ops_att_self_close('{"date":"2026-10-06","time":"18:00","reason":"忘"}')$q$, '至少 5 个字');
select pg_temp.expect_error($q$select public.ops_att_self_close('{"date":"2026-10-06","time":"08:00","reason":"忘了打下班卡"}')$q$, '要晚于');
select public.ops_att_self_close('{"date":"2026-10-06","time":"18:00","reason":"忘了打下班卡"}');
do $$ declare t jsonb; begin
  t := public.ops_att_punch(jsonb_build_object('action', 'in', 'lat', 1.5, 'lng', 103.7,
                                               'selfie', pg_temp.photo('hqsales@example.com', '2026-10-07/in2.jpg')));
  assert t->'record'->>'clock_in' is not null and t->'open_shift' = 'null'::jsonb, 'clock in after self close';
  assert (t->>'pending_corrections')::int = 1, 'self close pending';
end $$;
select pg_temp.expect_error($q$select public.ops_att_correction_cancel((public.ops_att_corrections('mine')->0->>'id')::bigint)$q$, '不能撤回');

-- 4. 补卡：星期一的上班卡改成 08:30（主管 → HR）
select pg_temp.expect_error($q$select public.ops_att_correction_create('{"date":"2026-10-05","punch":"clock_in","time":"13:00","reason":"打卡机慢了"}')$q$, '不像是上班');
select pg_temp.expect_error($q$select public.ops_att_correction_create('{"date":"2026-10-05","punch":"lunch_in","time":"12:00","reason":"打卡机慢了"}')$q$, '顺序不对');
select pg_temp.expect_error($q$select public.ops_att_correction_create('{"date":"2026-09-01","punch":"clock_in","time":"08:30","reason":"打卡机慢了"}')$q$, '14 天');
select pg_temp.expect_error($q$select public.ops_att_correction_create('{"date":"2026-10-07","punch":"clock_out","time":"18:00","reason":"打卡机慢了"}')$q$, '还没到');
do $$ declare c jsonb; begin
  c := public.ops_att_correction_create('{"date":"2026-10-05","punch":"clock_in","time":"08:30","reason":"门口排队打卡"}');
  assert c->>'status' = 'pending_hod' and not (c->>'can_decide')::boolean and c->>'original' is not null, 'created: ' || c::text;
end $$;
select pg_temp.expect_error($q$select public.ops_att_correction_create('{"date":"2026-10-05","punch":"clock_in","time":"08:31","reason":"门口排队打卡"}')$q$, '审核中');

-- 别分店的人、一般员工看不到也不能审
select pg_temp.as_user('jbsales@example.com');
do $$ begin assert jsonb_array_length(public.ops_att_corrections('todo')) = 0, 'jb no todo'; end $$;
select pg_temp.expect_error($q$select public.ops_att_days('2026-10', pg_temp.sid('hqsales@example.com'))$q$, '找不到');
select pg_temp.as_user('buyer@example.com');
do $$ begin assert jsonb_array_length(public.ops_att_corrections('todo')) = 0, 'buyer no todo'; end $$;
select pg_temp.expect_error('select public.ops_att_board()', '审批权限');
select pg_temp.expect_error($q$select public.ops_att_correction_decide(1, 'approve')$q$, '不能审');

-- 管理层预设对「人事」可审批 = 一次定案；这里把店长的人事降成只看，测两段流程：店长 = 第一段、HR = 第二段
select pg_temp.as_user('boss@example.com');
select public.ops_staff_save(jsonb_build_object('id', pg_temp.sid('mgr@example.com'), 'email', 'mgr@example.com',
                                                'overrides', jsonb_build_object('hr', 'view')));
select pg_temp.as_user('mgr@example.com');
do $$ declare l jsonb := public.ops_att_corrections('todo'); c jsonb; begin
  assert jsonb_array_length(l) = 2, 'mgr todo 2: ' || l::text;
  foreach c in array array(select jsonb_array_elements(l)) loop
    c := public.ops_att_correction_decide((c->>'id')::bigint, 'approve', '');
    assert c->>'status' = 'pending_hr' and c->>'hod_name' is not null, 'to HR';
  end loop;
  assert jsonb_array_length(public.ops_att_corrections('todo')) = 0, 'mgr done';
  -- 店长看得到门市小美的看板与月报
  assert exists (select 1 from jsonb_array_elements(public.ops_att_board('2026-10-05')->'rows') r where r->>'name' = '门市小美'),
    'board';
end $$;

select pg_temp.as_user('hr@example.com');
do $$ declare l jsonb := public.ops_att_corrections('todo'); c jsonb; d jsonb; begin
  assert jsonb_array_length(l) = 2, 'hr todo 2';
  foreach c in array array(select jsonb_array_elements(l)) loop
    c := public.ops_att_correction_decide((c->>'id')::bigint, 'approve', 'OK');
    assert c->>'status' = 'approved', 'approved';
  end loop;
  d := public.ops_att_days('2026-10', pg_temp.sid('hqsales@example.com'));
  assert (select (x->>'late_min')::int from jsonb_array_elements(d->'days') x where x->>'date' = '2026-10-05') = 0,
    'late fixed by correction: ' || d::text;
end $$;

-- 5. 自己补的下班卡被驳回 → 还原，又被挡
select pg_temp.as_user('hqsales@example.com');
select pg_temp.at('2026-10-08 08:20:00+08');
select public.ops_att_self_close('{"date":"2026-10-07","time":"17:00","reason":"手机没电了"}');
select pg_temp.as_user('hr@example.com');
select pg_temp.expect_error($q$select public.ops_att_correction_decide((public.ops_att_corrections('todo')->0->>'id')::bigint, 'reject', '')$q$, '写原因');
select public.ops_att_correction_decide((public.ops_att_corrections('todo')->0->>'id')::bigint, 'reject', '当天 18:30 才走');
select pg_temp.as_user('hqsales@example.com');
do $$ begin assert public.ops_att_today()->>'open_shift' = '2026-10-07', 'reverted'; end $$;
-- HR 替她补 18:30（不受 14 天限制，直接定案）
select pg_temp.as_user('hr@example.com');
do $$ declare c jsonb; begin
  c := public.ops_att_correction_create(jsonb_build_object('staff_id', pg_temp.sid('hqsales@example.com'),
         'date', '2026-10-07', 'punch', 'clock_out', 'time', '18:30', 'reason', 'HR 依监视器补登'));
  assert c->>'status' = 'pending_hod', 'hr filed';
  -- HR 不能审自己开的？可以：申请人是员工本人，不是 HR
  c := public.ops_att_correction_decide((c->>'id')::bigint, 'approve', '', '18:35');
  assert c->>'status' = 'approved' and c->>'time' = '18:35', 'hr override time: ' || c::text;
end $$;
select pg_temp.as_user('hqsales@example.com');
do $$ begin assert public.ops_att_today()->'open_shift' = 'null'::jsonb, 'closed by HR'; end $$;

-- 6. 外出公务：整天按班表补
select public.ops_att_correction_create('{"date":"2026-10-02","kind":"offsite","reason":"去客户工地丈量"}');
select pg_temp.as_user('hr@example.com');
select public.ops_att_correction_decide((public.ops_att_corrections('todo')->0->>'id')::bigint, 'approve');
do $$ declare d jsonb; x jsonb; begin
  d := public.ops_att_days('2026-10', pg_temp.sid('hqsales@example.com'));
  select e into x from jsonb_array_elements(d->'days') e where e->>'date' = '2026-10-02';
  assert (x->>'late_min')::int = 0 and (x->>'worked_min')::int = 495 and x->>'source' = 'correction', 'offsite: ' || x::text;
end $$;

-- 7. 月报：门市小美 10/1–10/7（10/3 是指定上班的星期六，10/4 星期日）
select pg_temp.at('2026-10-08 09:00:00+08');
select pg_temp.as_user('mgr@example.com');
do $$ declare m jsonb; begin
  select e into m from jsonb_array_elements(public.ops_att_month('2026-10')) e where e->>'name' = '门市小美';
  -- 工作日：10/1、2、3(六)、5、6、7、8 = 7；有出勤：2、5、6、7 = 4；缺勤（今天以前）：1、3 = 2
  assert (m->>'workdays')::int = 7 and (m->>'present')::int = 4 and (m->>'absent')::int = 2, 'month: ' || m::text;
  assert (m->>'lunch_late_days')::int = 1 and (m->>'missing_out')::int = 0, 'month 2: ' || m::text;
end $$;
-- 假日：10/1 设为假日 → 工作日少一天
select pg_temp.as_user('boss@example.com');
select public.ops_att_holiday_save('{"date":"2026-10-01","name":"测试假日"}');
select public.ops_att_saturday_set('2026-10', '2026-10-10');
select pg_temp.as_user('mgr@example.com');
do $$ declare m jsonb; begin
  select e into m from jsonb_array_elements(public.ops_att_month('2026-10')) e where e->>'name' = '门市小美';
  -- 10/1 假日、10/3 不再是指定星期六 → 工作日 2、5、6、7、8 = 5
  assert (m->>'workdays')::int = 5 and (m->>'absent')::int = 0, 'month after holiday: ' || m::text;
end $$;
select pg_temp.expect_error($q$select public.ops_att_saturday_set('2026-10', '2026-10-09')$q$, '人事');

-- 8. 照片权限：自己写自己的资料夹；主管读得到下属的；别分店读不到
select pg_temp.as_user('hqsales@example.com');
do $$ begin
  assert public.ops_hr_file_ok(pg_temp.sid('hqsales@example.com') || '/x.jpg', true), 'own write';
  assert not public.ops_hr_file_ok(pg_temp.sid('buyer@example.com') || '/x.jpg', true), 'other write';
  assert not public.ops_hr_file_ok('../x.jpg', false), 'bad path';
end $$;
select pg_temp.as_user('mgr@example.com');
do $$ begin assert public.ops_hr_file_ok(pg_temp.sid('hqsales@example.com') || '/x.jpg', false), 'mgr read'; end $$;
select pg_temp.as_user('jbsales@example.com');
do $$ begin assert not public.ops_hr_file_ok(pg_temp.sid('hqsales@example.com') || '/x.jpg', false), 'jb no read'; end $$;
select pg_temp.as_user('buyer@example.com');
do $$ begin assert not public.ops_hr_file_ok(pg_temp.sid('hqsales@example.com') || '/x.jpg', false), 'peer no read'; end $$;

-- 9. 外勤签到、直属主管
select pg_temp.as_user('jbsales@example.com');
select pg_temp.expect_error($q$select public.ops_att_field_checkin('{"purpose":"客户"}')$q$, '读不到你的位置');
do $$ declare t jsonb; begin
  t := public.ops_att_field_checkin(jsonb_build_object('lat', 1.46, 'lng', 103.76, 'purpose', '拜访水工',
                                                       'selfie', pg_temp.photo('jbsales@example.com', 'c1.jpg')));
  assert jsonb_array_length(t->'checkins') = 1, 'checkin';
end $$;
-- 设 buyer 为门市小美的直属主管 → 店长就不再是第一段审核人
select pg_temp.as_user('boss@example.com');
select public.ops_att_staff_set(jsonb_build_object('id', pg_temp.sid('hqsales@example.com'),
                                                   'manager_id', pg_temp.sid('buyer@example.com')));
select pg_temp.expect_error($q$select public.ops_att_staff_set(jsonb_build_object('id', pg_temp.sid('hqsales@example.com'),
  'manager_id', pg_temp.sid('hqsales@example.com')))$q$, '不能是自己');
select pg_temp.as_user('hqsales@example.com');
select public.ops_att_correction_create('{"date":"2026-10-08","punch":"clock_in","time":"08:30","reason":"测试直属主管"}');
select pg_temp.as_user('mgr@example.com');
do $$ begin assert jsonb_array_length(public.ops_att_corrections('todo')) = 0, 'mgr not hod anymore'; end $$;
select pg_temp.as_user('buyer@example.com');
do $$ begin
  assert jsonb_array_length(public.ops_att_corrections('todo')) = 1, 'direct manager hod';
  assert jsonb_array_length(public.ops_att_board()->'rows') = 1, 'direct manager board';
end $$;

reset role;
select 'ALL ATTENDANCE TESTS PASSED' as result;
