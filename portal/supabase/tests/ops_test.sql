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

-- 9. 订货与 ETA
select pg_temp.as_user('buyer@example.com');
do $$ declare l jsonb; one jsonb; begin
  l := public.ops_po_list('{}');
  assert jsonb_array_length(l) = 4, 'HQ buyer sees PO-1, PO-2, PO-CN5, PO-CN45 only (PO-3 received, PO-OLD stale, PO-JB other branch): ' || l::text;
  assert l->0->>'po_no' = 'PO-CN45' and (l->0->>'overdue')::boolean, 'overdue first (china est 45d after po is trusted)';
  assert l->1->>'po_no' = 'PO-2', 'then local overdue';
  assert (l->1->>'open_amt')::numeric = 40, 'buyer sees amount';
  assert jsonb_array_length(public.ops_po_list('{"stale":true}')) = 5, 'stale toggle';
  assert jsonb_array_length(public.ops_po_list('{"q":"bidet"}')) = 1, 'search by item';
  one := public.ops_po_get('HOMEWORKSSB', 'PO-1');
  assert jsonb_array_length(one->'items') = 2 and (one->'items'->1->>'open_qty')::numeric = 15, 'lines';
  assert one->>'eta' = (current_date + 50)::text and one->>'eta_source' = 'lead', 'lead-time eta';
end $$;
select pg_temp.expect_error($q$select public.ops_po_get('HOMEWORKSSOUTHERN', 'PO-JB')$q$, '找不到这张 PO');
select pg_temp.expect_error($q$select public.ops_po_update('HOMEWORKSSOUTHERN', array['PO-JB'], '{"status":"confirmed"}')$q$, '其他分店');

-- 填 ETA → 逾期消失；挂货柜 → ETA 以货柜为准；货柜出货 → PO 状态跟着变
do $$ declare s jsonb; l jsonb; begin
  perform public.ops_po_update('HOMEWORKSSB', array['PO-2'], jsonb_build_object('eta', current_date + 3, 'remark', '供应商说下周'));
  l := public.ops_po_list('{"overdue":true}');
  assert jsonb_array_length(l) = 1 and l->0->>'po_no' = 'PO-CN45', 'only china-45 overdue after eta: ' || l::text;
  s := public.ops_shipment_save(jsonb_build_object('company', 'HOMEWORKSSB', 'name', 'CS065-0925', 'eta', current_date + 30));
  perform public.ops_po_update('HOMEWORKSSB', array['PO-1', 'PO-2'], jsonb_build_object('shipment_id', s->>'id'));
  l := public.ops_po_list('{"q":"CS065-0925"}');
  assert jsonb_array_length(l) = 2 and l->0->>'eta_source' = 'shipment' and l->0->>'eta' = (current_date + 30)::text, 'shipment eta';
  perform public.ops_shipment_save(jsonb_build_object('id', s->>'id', 'status', 'shipped'));
  assert public.ops_po_get('HOMEWORKSSB', 'PO-1')->>'status' = 'shipped', 'status follows shipment';
  assert (public.ops_shipment_list()->0->>'open_po_count')::int = 2, 'shipment po count';
  assert jsonb_array_length(public.ops_po_get('HOMEWORKSSB', 'PO-2')->'history') = 2, 'history';
end $$;
select pg_temp.expect_error($q$select public.ops_po_update('HOMEWORKSSB', array['PO-1'], '{"shipment_id":"999"}')$q$, '货柜不存在');

-- 关闭旧单 → 清单隐藏
do $$ begin
  perform public.ops_po_update('HOMEWORKSSB', array['PO-OLD'], '{"status":"closed"}');
  assert jsonb_array_length(public.ops_po_list('{"stale":true}')) = 4, 'closed hidden';
  assert jsonb_array_length(public.ops_po_list('{"stale":true,"status":"all"}')) = 5, 'closed shown with all';
end $$;

-- 业务：只看（无价格），不能改；可查 SKU 到货
select pg_temp.as_user('boss@example.com');
select public.ops_staff_save('{"email":"hqsales@example.com","name":"门市小美","department":"sales","branch":"HOMEWORKSSB"}');
select pg_temp.as_user('hqsales@example.com');
do $$ declare l jsonb; e jsonb; begin
  l := public.ops_po_list('{}');
  assert jsonb_array_length(l) = 4 and l->0->'open_amt' = 'null'::jsonb, 'sales sees no amount';
  assert public.ops_po_get('HOMEWORKSSB', 'PO-1')->'items'->0->'unit_price' = 'null'::jsonb, 'sales no unit price';
  e := public.ops_item_eta('ST001');
  assert jsonb_array_length(e) = 1, 'sales sees only own branch item: ' || e::text;
  assert (e->0->>'on_hand')::numeric = 8 and jsonb_array_length(e->0->'incoming') = 4, 'stock + incoming';
  assert (public.ops_home()->'po_overdue') = 'null'::jsonb, 'sales no po kpi';
end $$;
select pg_temp.expect_error($q$select public.ops_po_update('HOMEWORKSSB', array['PO-1'], '{"status":"arrived"}')$q$, '编辑权限');

-- 人事部没有订货模块
select pg_temp.as_user('boss@example.com');
select public.ops_staff_save('{"email":"hr@example.com","name":"HR","department":"hr","branch":"HOMEWORKSSB"}');
select pg_temp.as_user('hr@example.com');
select pg_temp.expect_error($q$select public.ops_po_list('{}')$q$, '订货与 ETA');
select pg_temp.expect_error('select * from ops.v_po_open', 'permission denied');

-- 10. 中国货 ETA 修正：AutoCount 只填开单后 5 天 → 不采用，改按交期（60 天）
select pg_temp.as_user('buyer@example.com');
do $$ declare p jsonb; begin
  p := public.ops_po_get('HOMEWORKSSB', 'PO-CN5');
  assert p->>'eta_source' = 'lead' and p->>'eta' = (current_date + 20)::text and not (p->>'overdue')::boolean,
    'china est 5d after po ignored: ' || p::text;
  p := public.ops_po_get('HOMEWORKSSB', 'PO-CN45');
  assert p->>'eta_source' = 'autocount' and p->>'eta' = (current_date - 5)::text, 'china est 45d trusted';
end $$;

-- 11. 资料更新时间：只取成功的，只看得到自己分店
do $$ declare s jsonb := public.ops_sync_status(); begin
  assert jsonb_array_length(s) = 1 and s->0->>'company' = 'HOMEWORKSSB', 'own branch only: ' || s::text;
  assert (s->0->>'purchase')::timestamptz < now() - interval '90 minutes', 'failed run ignored';
  assert s->0->>'stock' is not null, 'stock time';
end $$;
select pg_temp.as_user('boss@example.com');
do $$ begin assert jsonb_array_length(public.ops_sync_status()) = 2, 'admin sees both'; end $$;

reset role;
select 'ALL OPS TESTS PASSED' as result;
