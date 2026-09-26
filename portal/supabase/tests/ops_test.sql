-- 营运系统地基的权限测试。任何一条不符预期就 raise，psql 以 ON_ERROR_STOP 结束并回传非 0。
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

set role authenticated;

-- 1. 直接碰表一律拒绝
select pg_temp.expect_error('select * from ops.staff', 'permission denied');

-- 2. 不在名单的人：ops_me 回 null，其他函数报「还没加入」
select pg_temp.as_user('stranger@example.com');
do $$ begin assert public.ops_me() is null, 'stranger ops_me should be null'; end $$;
select pg_temp.expect_error('select public.ops_home()', '还没加入营运系统');

-- 3. 种子资料：owner = admin/ALL，email 大小写不影响
select pg_temp.as_user('BOSS@example.com');
do $$ declare m jsonb := public.ops_me(); begin
  assert m->'staff'->>'role' = 'admin', 'owner should be admin';
  assert m->'staff'->>'branch' = 'ALL', 'owner branch ALL';
  assert (select count(*) from jsonb_array_elements(m->'modules') e where e->>'level' = 'approve') = 13, 'admin all modules';
end $$;

-- 4. admin 新增仓库员工，且 buyer 不能进员工与权限
do $$ declare s jsonb; begin
  s := public.ops_staff_save('{"email":"WH@example.com","name":"阿明","department":"warehouse","branch":"HOMEWORKSSB"}');
  assert s->>'email' = 'wh@example.com', 'email lowercased';
end $$;
select pg_temp.expect_error($q$select public.ops_staff_save('{"email":"wh@example.com","name":"x","department":"warehouse"}')$q$, '已经在名单');
select pg_temp.expect_error($q$select public.ops_staff_save('{"id":1,"email":"boss@example.com","name":"b","role":"staff"}')$q$, '不能拿掉自己');

select pg_temp.as_user('buyer@example.com');
select pg_temp.expect_error('select public.ops_staff_admin_list()', '员工与权限');
do $$ declare m jsonb := public.ops_me(); begin
  assert (select e->>'level' from jsonb_array_elements(m->'modules') e where e->>'key' = 'purchasing') = 'edit', 'buyer purchasing edit';
  assert (select e->>'level' from jsonb_array_elements(m->'modules') e where e->>'key' = 'hr') = 'none', 'buyer no hr';
end $$;

-- 5. 任务：buyer 开任务指派给仓库阿明
do $$ declare t jsonb; wh bigint; begin
  select (e->>'id')::bigint into wh from jsonb_array_elements(public.ops_directory()) e where e->>'name' = '阿明';
  t := public.ops_task_save(jsonb_build_object('title', '柜子到了请收货', 'department', 'warehouse',
                                               'assignee_id', wh, 'due_date', '2020-01-01', 'ref_no', 'PO-0001'));
  assert t->>'branch' = 'HOMEWORKSSB' and (t->>'overdue')::boolean, 'task branch + overdue';
end $$;

select pg_temp.as_user('wh@example.com');
do $$ declare l jsonb := public.ops_task_list('mine', 'open'); h jsonb := public.ops_home(); t jsonb; begin
  assert jsonb_array_length(l) = 1, 'assignee sees task';
  assert (h->>'my_overdue')::int = 1, 'overdue count';
  t := public.ops_task_save(jsonb_build_object('id', l->0->'id', 'status', 'done'));
  assert t->>'done_at' is not null, 'done_at set';
  perform public.ops_task_comment((l->0->>'id')::bigint, '已收货 20 箱');
  assert jsonb_array_length(public.ops_task_get((l->0->>'id')::bigint)->'comments') = 1, 'comment';
end $$;

-- JB 销售看不到总部仓库的任务，也不能改
select pg_temp.as_user('jbsales@example.com');
do $$ begin assert jsonb_array_length(public.ops_task_list('all', 'all')) = 0, 'JB cannot see HQ task'; end $$;
select pg_temp.expect_error('select public.ops_task_get(1)', '找不到这个任务');
select pg_temp.expect_error($q$select public.ops_task_save('{"id":1,"status":"todo"}')$q$, '不能修改');

-- 6. 审批：阿明请假 → 自己不能批、JB 不能批、店长（管理层 manager）可以批
select pg_temp.as_user('wh@example.com');
do $$ declare a jsonb; begin
  a := public.ops_approval_create('{"kind":"leave","title":"请假 10/3","data":{"from":"2026-10-03","to":"2026-10-03"}}');
  assert a->>'status' = 'pending' and not (a->>'can_decide')::boolean and (a->>'can_cancel')::boolean, 'own request';
end $$;
select pg_temp.expect_error($q$select public.ops_approval_decide(1, 'approved')$q$, '不能审批');

select pg_temp.as_user('jbsales@example.com');
select pg_temp.expect_error($q$select public.ops_approval_decide(1, 'approved')$q$, '找不到这张申请');

select pg_temp.as_user('mgr@example.com');
do $$ declare a jsonb; begin
  assert jsonb_array_length(public.ops_approval_list('todo')) = 1, 'manager todo';
  assert (public.ops_home()->>'approvals_waiting')::int = 1, 'home waiting';
  a := public.ops_approval_decide(1, 'approved', 'OK');
  assert a->>'status' = 'approved' and a->>'decided_by_name' = 'mgr', 'approved';
end $$;
select pg_temp.expect_error($q$select public.ops_approval_decide(1, 'rejected')$q$, '已经处理过');

-- 7. 部门权限矩阵：拿掉仓库的任务模块后，阿明就不能开任务
select pg_temp.as_user('boss@example.com');
select public.ops_dept_module_set('warehouse', 'tasks', 'view');
select pg_temp.as_user('wh@example.com');
select pg_temp.expect_error($q$select public.ops_task_save('{"title":"x"}')$q$, '编辑权限');
-- 个人例外可以覆盖回来
select pg_temp.as_user('boss@example.com');
select public.ops_staff_save(jsonb_build_object('id', (select (e->>'id') from jsonb_array_elements(public.ops_directory()) e where e->>'name' = '阿明'),
  'email', 'wh@example.com', 'overrides', jsonb_build_object('tasks', 'edit')));
select pg_temp.as_user('wh@example.com');
select public.ops_task_save('{"title":"盘点 A 区"}') is not null as ok;

-- 8. 停用后进不来
select pg_temp.as_user('boss@example.com');
select public.ops_staff_save(jsonb_build_object('id', (select (e->>'id') from jsonb_array_elements(public.ops_directory()) e where e->>'name' = '阿明'),
  'email', 'wh@example.com', 'active', false));
select pg_temp.as_user('wh@example.com');
do $$ begin assert public.ops_me() is null, 'inactive'; end $$;

reset role;
select 'ALL OPS TESTS PASSED' as result;
