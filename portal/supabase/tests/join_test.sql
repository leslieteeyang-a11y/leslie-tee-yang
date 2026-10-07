-- 首页待办 / HR 缺漏 / 旧货清单测试（接在 pay_test.sql 之后跑）。
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
grant execute on all functions in schema pg_temp to authenticated;

-- 1. 送出申请（Edge Function 用 service role；这里用 postgres 直接呼叫）
reset role;
do $$ declare c text := (select code from ops.join_setting); r jsonb; begin
  r := public.ops_join_submit(jsonb_build_object('code', c, 'email', 'New.Worker@Gmail.com', 'name', '新工人阿德',
         'phone', '0129998888', 'gender', 'M', 'join_date', '2026-10-01', 'branch', 'HOMEWORKSSB'));
  assert r->>'email' = 'new.worker@gmail.com', 'lower email';
  -- 同一个 email 再送 = 更新同一张
  r := public.ops_join_submit(jsonb_build_object('code', lower(c), 'email', 'new.worker@gmail.com', 'name', '新工人阿德', 'phone', '0127777777', 'gender', 'M', 'join_date', '2026-10-01'));
  assert (select count(*) from ops.join_request) = 1 and (select phone from ops.join_request) = '0127777777', 'upsert pending';
end $$;
select pg_temp.expect_error($q$select public.ops_join_submit('{"code":"WRONG","email":"a@b.co","name":"x"}')$q$, '失效');
select pg_temp.expect_error($q$select public.ops_join_submit(jsonb_build_object('code', (select code from ops.join_setting), 'email', 'boss@example.com', 'name', 'x'))$q$, '已经在员工名单');
select pg_temp.expect_error($q$select public.ops_join_submit(jsonb_build_object('code', (select code from ops.join_setting), 'email', 'bad', 'name', 'x'))$q$, 'email');

set role authenticated;
-- 一般员工 / 匿名不能直接叫 submit
select pg_temp.as_user('hqsales@example.com');
select pg_temp.expect_error($q$select public.ops_join_submit('{}')$q$, 'permission');
select pg_temp.expect_error($q$select public.ops_join_list()$q$, '');

-- 2. 申请人登入了但还不是员工：看得到自己的状态
select pg_temp.as_user('new.worker@gmail.com');
do $$ begin
  assert public.ops_me() is null, 'not staff yet';
  assert public.ops_join_status()->>'status' = 'pending', 'pending status';
end $$;

-- 3. 管理员：首页数字、清单、批准
select pg_temp.as_user('boss@example.com');
do $$ declare l jsonb := public.ops_join_list(); id bigint; begin
  assert (public.ops_home()->>'join_pending')::int = 1, 'home count';
  assert jsonb_array_length(l->'pending') = 1 and length(l->'setting'->>'code') = 8, 'list';
  id := (l->'pending'->0->>'id')::bigint;
  perform pg_temp.expect_error(format($q$select public.ops_join_decide('{"id":%s,"approve":true,"department":"nope"}')$q$, id), '部门');
  assert public.ops_join_decide(jsonb_build_object('id', id, 'approve', true, 'department', 'warehouse', 'branch', 'HOMEWORKSSB'))->>'status' = 'approved', 'approved';
  perform pg_temp.expect_error(format($q$select public.ops_join_decide('{"id":%s,"approve":false}')$q$, id), '处理过');
  assert (public.ops_home()->>'join_pending')::int = 0, 'home count 0';
end $$;
-- 4. 批准后就是员工，资料带过去
select pg_temp.as_user('new.worker@gmail.com');
do $$ declare m jsonb := public.ops_me(); begin
  assert m->'staff'->>'name' = '新工人阿德' and m->'staff'->>'department' = 'warehouse', 'now staff';
end $$;
reset role;
do $$ begin
  assert (select gender = 'M' and join_date = '2026-10-01' and phone = '0127777777' from ops.staff where email = 'new.worker@gmail.com'), 'data copied';
end $$;

-- 5. 拒绝；换新邀请码后旧码失效
do $$ declare c text := (select code from ops.join_setting); begin
  perform public.ops_join_submit(jsonb_build_object('code', c, 'email', 'spam@x.com', 'name', 'Spam'));
end $$;
set role authenticated;
select pg_temp.as_user('boss@example.com');
do $$ declare id bigint := (public.ops_join_list()->'pending'->0->>'id')::bigint; old text; s jsonb; begin
  assert public.ops_join_decide(jsonb_build_object('id', id, 'approve', false, 'note', '不认识'))->>'status' = 'rejected', 'rejected';
  old := public.ops_join_list()->'setting'->>'code';
  s := public.ops_join_setting_save('{"new_code":true}');
  assert s->>'code' <> old, 'new code';
  s := public.ops_join_setting_save('{"enabled":false}');
  assert not (s->>'enabled')::boolean, 'disabled';
end $$;
select pg_temp.as_user('spam@x.com');
do $$ begin assert public.ops_join_status()->>'decide_note' = '不认识', 'reject note'; end $$;
reset role;
select pg_temp.expect_error($q$select public.ops_join_submit(jsonb_build_object('code', (select code from ops.join_setting), 'email', 'c@d.co', 'name', 'x'))$q$, '失效');

reset role;
select 'ALL JOIN TESTS PASSED' as result;
