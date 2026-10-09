-- 员工自己申请加入测试（接在 todo_test.sql 之后跑）。
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
-- 假的 bcrypt 杂凑（格式对就好；真的由 Edge Function 产生）
create or replace function pg_temp.h() returns text language sql as $$ select '$2a$10$' || repeat('a', 53) $$;
create or replace function pg_temp.sub(p jsonb) returns jsonb language sql as $$
  select public.ops_join_submit(jsonb_build_object('code', (select code from ops.join_setting), 'pw_hash', pg_temp.h()) || p)
$$;
grant execute on all functions in schema pg_temp to authenticated;

-- 1. 送出申请（Edge Function 用 service role；这里用 postgres 直接呼叫）
reset role;
do $$ declare c text := (select code from ops.join_setting); r jsonb; begin
  assert length(c) = 12, '12 码邀请码';
  assert public.ops_join_check(lower(c)) and not public.ops_join_check('WRONG') and not public.ops_join_check(null), 'check code';
  r := pg_temp.sub(jsonb_build_object('email', 'New.Worker@Gmail.com', 'name', '新工人阿德',
         'phone', '0129998888', 'gender', 'M', 'join_date', '2026-10-01', 'branch', 'HOMEWORKSSB', 'client_ip', '10.0.0.1'));
  assert r->>'email' = 'new.worker@gmail.com' and not (r->>'has_account')::boolean, 'lower email';
  assert (select pw_hash from ops.join_request) = pg_temp.h(), 'hash stored';
end $$;
-- 同一个 email 再送：不覆盖（第一版会被别人整张改掉）
select pg_temp.expect_error($q$select pg_temp.sub('{"email":"new.worker@gmail.com","name":"冒名","gender":"F"}')$q$, '已经送出过');
do $$ begin assert (select name = '新工人阿德' and gender = 'M' from ops.join_request), 'not overwritten'; end $$;
select pg_temp.expect_error($q$select public.ops_join_submit('{"code":"WRONG","email":"a@b.co","name":"x"}')$q$, '失效');
select pg_temp.expect_error($q$select pg_temp.sub('{"email":"boss@example.com","name":"x"}')$q$, '已经在员工名单');
select pg_temp.expect_error($q$select pg_temp.sub('{"email":"bad","name":"x"}')$q$, 'email');
select pg_temp.expect_error($q$select pg_temp.sub('{"email":"x@y.co","name":"x","join_date":"2026-13-01"}')$q$, '到职日');
select pg_temp.expect_error($q$select pg_temp.sub('{"email":"x@y.co","name":"x","branch":"ALL"}')$q$, '上班地点');
-- 没有杂凑（也不是已有账号）→ 不收
select pg_temp.expect_error($q$select pg_temp.sub('{"email":"x@y.co","name":"x","pw_hash":""}')$q$, '密码');
select pg_temp.expect_error($q$select pg_temp.sub('{"email":"x@y.co","name":"x","pw_hash":"plain-password"}')$q$, '密码');
-- 在 BI 名单、还没有登入账号：不能借申请自己设密码
insert into bi.allowed_users (email, role) values ('Acct@example.com', 'finance');
select pg_temp.expect_error($q$select pg_temp.sub('{"email":"acct@example.com","name":"会计"}')$q$, '管理员开');
-- 已有账号（Edge Function 已用他的密码验证过）：可以申请，不存杂凑
do $$ declare r jsonb; begin
  r := pg_temp.sub('{"email":"acct@example.com","name":"会计","has_account":true}');
  assert (r->>'has_account')::boolean, 'has_account';
  assert (select pw_hash is null from ops.join_request where email = 'acct@example.com'), 'no hash for existing';
end $$;

set role authenticated;
-- 一般员工 / 匿名不能直接叫 submit / check / pw
select pg_temp.as_user('hqsales@example.com');
select pg_temp.expect_error($q$select public.ops_join_submit('{}')$q$, 'permission');
select pg_temp.expect_error($q$select public.ops_join_check('X')$q$, 'permission');
select pg_temp.expect_error($q$select public.ops_join_pw(1, false)$q$, 'permission');
select pg_temp.expect_error($q$select public.ops_join_list()$q$, '');

-- 2. 已有账号的申请人登入了但还不是员工：看得到自己的状态
select pg_temp.as_user('acct@example.com');
do $$ begin
  assert public.ops_me() is null, 'not staff yet';
  assert public.ops_join_status()->>'status' = 'pending', 'pending status';
end $$;

-- 3. 管理员：首页数字、清单（没有杂凑 / IP）、批准
select pg_temp.as_user('boss@example.com');
do $$ declare l jsonb := public.ops_join_list(); id bigint; r jsonb; begin
  assert (public.ops_home()->>'join_pending')::int = 2, 'home count';
  assert jsonb_array_length(l->'pending') = 2 and length(l->'setting'->>'code') = 12, 'list';
  assert not (l->'pending'->0 ? 'pw_hash') and not (l->'pending'->0 ? 'client_ip'), 'no secrets in list';
  assert (l->'pending'->0->>'need_account')::boolean and not (l->'pending'->1->>'need_account')::boolean, 'need_account';
  id := (l->'pending'->0->>'id')::bigint;
  perform pg_temp.expect_error(format($q$select public.ops_join_decide('{"id":%s,"approve":true,"department":"nope"}')$q$, id), '部门');
  r := public.ops_join_decide(jsonb_build_object('id', id, 'approve', true, 'department', 'warehouse', 'branch', 'HOMEWORKSSB'));
  assert r->>'status' = 'approved' and r->>'how' = 'new' and (r->>'need_account')::boolean, 'approved';
  perform pg_temp.expect_error(format($q$select public.ops_join_decide('{"id":%s,"approve":false}')$q$, id), '处理过');
  assert (public.ops_home()->>'join_pending')::int = 1, 'home count 1';
end $$;
-- 4. Edge Function 拿杂凑建账号，再清掉
reset role;
do $$ declare rid bigint := (select x.id from ops.join_request x where x.email = 'new.worker@gmail.com'); r jsonb; begin
  r := public.ops_join_pw(rid, false);
  assert r->>'pw_hash' = pg_temp.h() and r->>'email' = 'new.worker@gmail.com', 'pw fetch';
  perform public.ops_join_pw(rid, true);
  assert (select x.pw_hash is null and x.account_created_at is not null from ops.join_request x where x.id = rid), 'pw cleared';
  assert public.ops_join_pw(rid, false)->>'pw_hash' is null, 'pw gone';
  -- 待审的拿不到
  assert public.ops_join_pw((select x.id from ops.join_request x where x.email = 'acct@example.com'), false) is null, 'pending no pw';
  assert (select gender = 'M' and join_date = '2026-10-01' and phone = '0129998888' from ops.staff where email = 'new.worker@gmail.com'), 'data copied';
end $$;
-- 5. 批准后就是员工
set role authenticated;
select pg_temp.as_user('new.worker@gmail.com');
do $$ declare m jsonb := public.ops_me(); begin
  assert m->'staff'->>'name' = '新工人阿德' and m->'staff'->>'department' = 'warehouse', 'now staff';
end $$;

-- 6. 拒绝会清掉杂凑；换新邀请码后旧码失效
reset role;
select pg_temp.sub('{"email":"spam@x.com","name":"Spam"}');
set role authenticated;
select pg_temp.as_user('boss@example.com');
do $$ declare id bigint := (select (e->>'id')::bigint from jsonb_array_elements(public.ops_join_list()->'pending') e
                            where e->>'email' = 'spam@x.com'); old text; s jsonb; begin
  assert public.ops_join_decide(jsonb_build_object('id', id, 'approve', false, 'note', '不认识'))->>'status' = 'rejected', 'rejected';
  assert (select (e->>'need_account')::boolean from jsonb_array_elements(public.ops_join_list()->'recent') e
          where e->>'email' = 'spam@x.com') = false, 'reject clears hash';
  assert (select e->>'decided_by_name' from jsonb_array_elements(public.ops_join_list()->'recent') e
          where e->>'email' = 'spam@x.com') is not null, 'decided_by_name';
  old := public.ops_join_list()->'setting'->>'code';
  s := public.ops_join_setting_save('{"new_code":true}');
  assert s->>'code' <> old and length(s->>'code') = 12, 'new code';
end $$;
reset role;
do $$ begin assert (select pw_hash is null from ops.join_request where email = 'spam@x.com'), 'reject hash null'; end $$;
-- 被拒绝的人可以重新申请（旧的那张不是 pending）
select pg_temp.sub('{"email":"spam@x.com","name":"Spam 2"}');

-- 7. 申请期间已被加进名单（在职）→ 批准 = 连到那位员工；停用的 = 复职
set role authenticated;
select pg_temp.as_user('boss@example.com');
select public.ops_staff_save('{"email":"spam@x.com","name":"阿斯","department":"sales","branch":"HOMEWORKSSB"}');
do $$ declare id bigint := (select (e->>'id')::bigint from jsonb_array_elements(public.ops_join_list()->'pending') e
                            where e->>'email' = 'spam@x.com'); r jsonb; begin
  r := public.ops_join_decide(jsonb_build_object('id', id, 'approve', true, 'department', 'warehouse'));
  assert r->>'how' = 'linked' and (r->>'need_account')::boolean, 'linked';
end $$;
reset role;
do $$ begin
  assert (select department = 'sales' and name = '阿斯' and active from ops.staff where email = 'spam@x.com'), 'linked keeps dept';
  -- 离职（最后上班日 10/5、已停用）后再申请回来
  update ops.staff set active = false, last_day = '2026-10-05' where email = 'new.worker@gmail.com';
end $$;
select pg_temp.sub('{"email":"new.worker@gmail.com","name":"新工人阿德","join_date":"2027-01-05","gender":"M"}');
set role authenticated;
select pg_temp.as_user('boss@example.com');
do $$ declare id bigint := (select (e->>'id')::bigint from jsonb_array_elements(public.ops_join_list()->'pending') e
                            where e->>'email' = 'new.worker@gmail.com'); r jsonb; begin
  r := public.ops_join_decide(jsonb_build_object('id', id, 'approve', true, 'department', 'sales', 'branch', 'HOMEWORKSSOUTHERN'));
  assert r->>'how' = 'rehire', 'rehire';
end $$;
reset role;
do $$ begin
  assert (select active and department = 'sales' and branch = 'HOMEWORKSSOUTHERN' and join_date = '2027-01-05'
                 and last_day is null
          from ops.staff where email = 'new.worker@gmail.com'), 'rehired, old last_day cleared';
end $$;

-- 8. 同一个 IP 一小时最多 5 张
do $$ declare i int; begin
  for i in 1..5 loop
    perform pg_temp.sub(jsonb_build_object('email', 'ip' || i || '@x.com', 'name', 'ip' || i, 'client_ip', '9.9.9.9'));
  end loop;
end $$;
select pg_temp.expect_error($q$select pg_temp.sub('{"email":"ip6@x.com","name":"ip6","client_ip":"9.9.9.9"}')$q$, '太多次');
select pg_temp.sub('{"email":"ip6@x.com","name":"ip6","client_ip":"9.9.9.8"}');

-- 9. 暂停后旧码失效
set role authenticated;
select pg_temp.as_user('boss@example.com');
select public.ops_join_setting_save('{"enabled":false}');
reset role;
select pg_temp.expect_error($q$select pg_temp.sub('{"email":"c@d.co","name":"x"}')$q$, '失效');

reset role;
select 'ALL JOIN TESTS PASSED' as result;
