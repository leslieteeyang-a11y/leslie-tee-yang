-- HomeWorks 营运系统（员工各部门用）— 地基
-- 已套用到 Supabase 专案 vwljnypzgfqhatkgulqs（migration 名称 ops_foundation）。这里留底，改动请另开新 migration。
--
-- 设计：
--   * 权限判断函数一律 coalesce(..., false)：栏位是 NULL（没指定负责人 / 审批人）时，
--     SQL 的三值逻辑会得到 NULL，`not NULL` 也是 NULL，if 就不会拦下，等于放行。
--   * 资料放新的 ops schema，不开放给 PostgREST；前端只能透过 public.ops_* 函数读写，
--     每个函数开头都用 ops.require_staff() / ops.require_level() 检查「你是谁、有没有这个模块的权限」。
--   * 账号沿用同一个 Supabase Auth（和 BI 同一套登入），但营运系统的名单是 ops.staff，
--     与 bi.allowed_users 分开：仓库、HR 的员工进得了营运系统，却看不到 BI 的财务数据。
--   * 权限 = 部门预设（ops.dept_module）+ 个人例外（ops.staff_module）；admin 全开；
--     manager 在自己部门「可编辑」的模块自动升为「可审批」。
--   * 所有写入都记 ops.audit_log。

create schema if not exists ops;
revoke all on schema ops from public, anon, authenticated;

-- ------------------------------------------------------------ 基本资料
create table ops.department (
  code text primary key,
  name text not null,
  sort int not null default 0
);

insert into ops.department (code, name, sort) values
  ('mgmt',       '管理层',       10),
  ('sales',      '销售 / 门市',  20),
  ('ecommerce',  '电商',         30),
  ('purchasing', '采购订货',     40),
  ('warehouse',  '仓库',         50),
  ('delivery',   '送货安装',     60),
  ('finance',    '财务',         70),
  ('hr',         '人事',         80);

create table ops.module (
  key text primary key,
  name text not null,
  phase int not null,                 -- 路线图第几阶段
  ready boolean not null default false,
  description text not null default '',
  sort int not null default 0
);

insert into ops.module (key, name, phase, ready, sort, description) values
  ('dashboard',  '首页',         1, true,  10, '我的待办、待审批、各模块入口'),
  ('tasks',      '任务',         1, true,  20, '跨部门交办事项：指派、期限、进度、留言'),
  ('approvals',  '审批',         1, true,  30, '通用申请与审批：请假、采购、折扣、报销…'),
  ('purchasing', '订货与 ETA',   2, false, 40, '未到货 PO、预计到货日、货柜跟踪、逾期提醒'),
  ('warehouse',  '仓库',         3, false, 50, '库存查询、预留、拣货、收货'),
  ('delivery',   '送货安装',     3, false, 60, '送货排程、签收、安装跟踪'),
  ('sales',      '销售',         2, false, 70, '客户、销售订单、业绩'),
  ('collection', '收款',         4, false, 80, '应收、账龄、催收提醒'),
  ('commission', '佣金',         4, false, 90, '佣金计算、审批、报表'),
  ('hr',         '人事',         5, false, 100, '员工档案、打卡、请假'),
  ('payroll',    '薪资',         5, false, 110, '薪资计算、津贴、扣款'),
  ('reports',    '报表',         4, false, 120, '月报、管理报表'),
  ('admin',      '员工与权限',   1, true,  900, '新增员工、设定部门与权限、登入密码');

create table ops.staff (
  id bigint generated always as identity primary key,
  email text not null,
  name text not null,
  department text not null references ops.department(code),
  branch text not null default 'HOMEWORKSSB'
    check (branch in ('HOMEWORKSSB', 'HOMEWORKSSOUTHERN', 'ALL')),
  role text not null default 'staff' check (role in ('admin', 'manager', 'staff')),
  title text not null default '',
  phone text not null default '',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index staff_email_uq on ops.staff (lower(email));

-- 部门预设权限：view 只看 / edit 可编辑 / approve 可审批（没有列 = 看不到）
create table ops.dept_module (
  department text not null references ops.department(code) on delete cascade,
  module text not null references ops.module(key) on delete cascade,
  level text not null check (level in ('view', 'edit', 'approve')),
  primary key (department, module)
);

-- 个人例外：覆盖部门预设；level = 'none' 表示拿掉
create table ops.staff_module (
  staff_id bigint not null references ops.staff(id) on delete cascade,
  module text not null references ops.module(key) on delete cascade,
  level text not null check (level in ('none', 'view', 'edit', 'approve')),
  primary key (staff_id, module)
);

-- 每个部门都有：首页、任务、审批
insert into ops.dept_module (department, module, level)
select d.code, m.key, case m.key when 'dashboard' then 'view' else 'edit' end
from ops.department d cross join (values ('dashboard'), ('tasks'), ('approvals')) m(key);

insert into ops.dept_module (department, module, level) values
  ('sales', 'sales', 'edit'), ('sales', 'warehouse', 'view'), ('sales', 'purchasing', 'view'),
  ('sales', 'delivery', 'view'), ('sales', 'commission', 'view'),
  ('ecommerce', 'sales', 'edit'), ('ecommerce', 'warehouse', 'view'), ('ecommerce', 'purchasing', 'view'),
  ('ecommerce', 'reports', 'view'),
  ('purchasing', 'purchasing', 'edit'), ('purchasing', 'warehouse', 'view'),
  ('warehouse', 'warehouse', 'edit'), ('warehouse', 'delivery', 'edit'), ('warehouse', 'purchasing', 'view'),
  ('delivery', 'delivery', 'edit'), ('delivery', 'warehouse', 'view'),
  ('finance', 'collection', 'edit'), ('finance', 'commission', 'edit'), ('finance', 'payroll', 'view'),
  ('finance', 'reports', 'view'),
  ('hr', 'hr', 'edit'), ('hr', 'payroll', 'edit');

-- 管理层：除了「员工与权限」之外全部可审批
insert into ops.dept_module (department, module, level)
select 'mgmt', key, 'approve' from ops.module where key not in ('admin')
on conflict (department, module) do update set level = excluded.level;

-- ------------------------------------------------------------ 任务 / 审批 / 稽核
create table ops.task (
  id bigint generated always as identity primary key,
  branch text not null default 'HOMEWORKSSB' check (branch in ('HOMEWORKSSB', 'HOMEWORKSSOUTHERN')),
  department text not null references ops.department(code),
  title text not null check (length(trim(title)) > 0),
  detail text not null default '',
  status text not null default 'todo' check (status in ('todo', 'doing', 'done', 'cancelled')),
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  assignee_id bigint references ops.staff(id),
  due_date date,
  ref_no text not null default '',      -- 关联单号（PO / DO / 发票…），之后各模块会用到
  created_by bigint not null references ops.staff(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  done_at timestamptz
);
create index task_assignee_idx on ops.task (assignee_id) where status in ('todo', 'doing');
create index task_dept_idx on ops.task (department, status);

create table ops.task_comment (
  id bigint generated always as identity primary key,
  task_id bigint not null references ops.task(id) on delete cascade,
  staff_id bigint not null references ops.staff(id),
  body text not null check (length(trim(body)) > 0),
  created_at timestamptz not null default now()
);
create index task_comment_task_idx on ops.task_comment (task_id);

create table ops.approval (
  id bigint generated always as identity primary key,
  branch text not null default 'HOMEWORKSSB' check (branch in ('HOMEWORKSSB', 'HOMEWORKSSOUTHERN')),
  department text not null references ops.department(code),
  kind text not null default 'other'
    check (kind in ('leave', 'purchase', 'discount', 'expense', 'other')),
  title text not null check (length(trim(title)) > 0),
  detail text not null default '',
  amount numeric(14, 2),
  data jsonb not null default '{}'::jsonb,   -- 各模块自己的栏位（请假日期、PO 号…）
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  requested_by bigint not null references ops.staff(id),
  approver_id bigint references ops.staff(id),  -- 指定审批人（可空：部门主管 / 管理层都可批）
  decided_by bigint references ops.staff(id),
  decided_at timestamptz,
  decision_note text not null default '',
  created_at timestamptz not null default now()
);
create index approval_status_idx on ops.approval (status, department);

create table ops.audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  staff_id bigint references ops.staff(id),
  action text not null,
  entity text not null,
  entity_id bigint,
  data jsonb not null default '{}'::jsonb
);
create index audit_entity_idx on ops.audit_log (entity, entity_id);

alter table ops.department enable row level security;
alter table ops.module enable row level security;
alter table ops.staff enable row level security;
alter table ops.dept_module enable row level security;
alter table ops.staff_module enable row level security;
alter table ops.task enable row level security;
alter table ops.task_comment enable row level security;
alter table ops.approval enable row level security;
alter table ops.audit_log enable row level security;
-- 不建任何 policy：anon / authenticated 直接碰表一律拒绝，只能走下面的 security definer 函数。

-- 第一批名单：沿用 BI 已有的账号（owner → admin；店长 → 管理层主管；订货员 → 采购；销售员 → 销售）
insert into ops.staff (email, name, department, branch, role, title)
select lower(au.email),
       split_part(lower(au.email), '@', 1),                -- 姓名之后在「员工与权限」改
       case au.role when 'owner' then 'mgmt' when 'manager' then 'mgmt'
                    when 'buyer' then 'purchasing' else 'sales' end,
       case when au.role = 'owner' or au.company is null then 'ALL' else au.company end,
       case au.role when 'owner' then 'admin' when 'manager' then 'manager' else 'staff' end,
       coalesce(au.note, '')
from bi.allowed_users au
on conflict do nothing;

-- ------------------------------------------------------------ 权限函数
create or replace function ops.level_rank(p_level text) returns int
language sql immutable set search_path = '' as $$
  select case p_level when 'view' then 1 when 'edit' then 2 when 'approve' then 3 else 0 end
$$;

create or replace function ops.current_staff() returns ops.staff
language sql stable security definer set search_path = '' as $$
  select s.* from ops.staff s
  where lower(s.email) = lower(coalesce(auth.jwt() ->> 'email', '')) and s.active
$$;

create or replace function ops.require_staff() returns ops.staff
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
begin
  me := ops.current_staff();
  if me.id is null then
    raise exception '你的账号还没加入营运系统，或已停用。请找管理员在「员工与权限」加入你的 email。'
      using errcode = '42501';
  end if;
  return me;
end $$;

create or replace function ops.module_level(p_staff ops.staff, p_module text) returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  lvl text;
  own text;
begin
  if p_staff.id is null then
    return 'none';
  end if;
  if p_staff.role = 'admin' then
    return 'approve';
  end if;
  if p_module = 'admin' then
    return 'none';                                   -- 员工与权限只有 admin 能进
  end if;
  select sm.level into own from ops.staff_module sm where sm.staff_id = p_staff.id and sm.module = p_module;
  if own is not null then
    return own;
  end if;
  select dm.level into lvl from ops.dept_module dm where dm.department = p_staff.department and dm.module = p_module;
  lvl := coalesce(lvl, 'none');
  if p_staff.role = 'manager' and lvl = 'edit' then
    lvl := 'approve';
  end if;
  return lvl;
end $$;

create or replace function ops.require_level(p_module text, p_need text) returns ops.staff
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  v_name text;
begin
  me := ops.require_staff();
  if ops.level_rank(ops.module_level(me, p_module)) < ops.level_rank(p_need) then
    select m.name into v_name from ops.module m where m.key = p_module;
    raise exception '你没有「%」模块的%权限，请找管理员开通。', coalesce(v_name, p_module),
      case p_need when 'view' then '查看' when 'edit' then '编辑' else '审批' end
      using errcode = '42501';
  end if;
  return me;
end $$;

create or replace function ops.sees_branch(p_staff ops.staff, p_branch text) returns boolean
language sql stable set search_path = '' as $$
  select coalesce(
    p_staff.branch = 'ALL' or p_branch is null or p_branch = p_staff.branch,
    false)
$$;

create or replace function ops.home_branch(p_staff ops.staff, p_branch text) returns text
language sql stable set search_path = '' as $$
  -- 新单据落在哪个分店：只属一间分店的员工固定用自己的；ALL 的人可以选，没选就总部
  select case when p_staff.branch = 'ALL'
              then coalesce(nullif(p_branch, ''), 'HOMEWORKSSB')
              else p_staff.branch end
$$;

create or replace function ops.log(p_staff bigint, p_action text, p_entity text, p_id bigint, p_data jsonb)
returns void language sql security definer set search_path = '' as $$
  insert into ops.audit_log (staff_id, action, entity, entity_id, data)
  values (p_staff, p_action, p_entity, p_id, coalesce(p_data, '{}'::jsonb))
$$;

-- ------------------------------------------------------------ 我是谁
create or replace function public.ops_me() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
begin
  me := ops.current_staff();
  if me.id is null then
    return null;                                     -- 前端据此显示「请找管理员加入」
  end if;
  return jsonb_build_object(
    'staff', jsonb_build_object('id', me.id, 'email', me.email, 'name', me.name, 'department', me.department,
                                'department_name', (select d.name from ops.department d where d.code = me.department),
                                'branch', me.branch, 'role', me.role, 'title', me.title),
    'modules', (select coalesce(jsonb_agg(jsonb_build_object('key', m.key, 'name', m.name, 'phase', m.phase,
                                                             'ready', m.ready, 'description', m.description,
                                                             'level', ops.module_level(me, m.key))
                                          order by m.sort), '[]'::jsonb)
                from ops.module m),
    'departments', (select jsonb_agg(jsonb_build_object('code', d.code, 'name', d.name) order by d.sort)
                    from ops.department d)
  );
end $$;

-- 员工通讯录（指派任务、选审批人用），所有在职员工都看得到基本资料
create or replace function public.ops_directory() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform ops.require_staff();
  return (select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'department', s.department,
                                                       'branch', s.branch, 'role', s.role, 'title', s.title)
                                    order by s.name), '[]'::jsonb)
          from ops.staff s where s.active);
end $$;

-- 首页数字
create or replace function public.ops_home() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
begin
  me := ops.require_staff();
  return jsonb_build_object(
    'my_open_tasks', (select count(*) from ops.task t where t.assignee_id = me.id and t.status in ('todo', 'doing')),
    'my_overdue', (select count(*) from ops.task t where t.assignee_id = me.id and t.status in ('todo', 'doing')
                   and t.due_date < current_date),
    'dept_open_tasks', (select count(*) from ops.task t where t.department = me.department
                        and t.status in ('todo', 'doing') and ops.sees_branch(me, t.branch)),
    'approvals_waiting', (select count(*) from ops.approval a where a.status = 'pending'
                          and ops.can_decide(me, a)),
    'my_pending_requests', (select count(*) from ops.approval a where a.requested_by = me.id and a.status = 'pending')
  );
end $$;

-- ------------------------------------------------------------ 任务
create or replace function ops.task_visible(p_staff ops.staff, p_task ops.task) returns boolean
language sql stable set search_path = '' as $$
  select coalesce(
    ops.sees_branch(p_staff, p_task.branch) and (
      p_staff.role = 'admin' or p_staff.department = 'mgmt'
      or p_task.assignee_id = p_staff.id or p_task.created_by = p_staff.id
      or p_task.department = p_staff.department),
    false)
$$;

create or replace function ops.task_editable(p_staff ops.staff, p_task ops.task) returns boolean
language sql stable set search_path = '' as $$
  select coalesce(
    ops.sees_branch(p_staff, p_task.branch) and (
      p_staff.role = 'admin'
      or p_task.assignee_id = p_staff.id or p_task.created_by = p_staff.id
      or (p_staff.role = 'manager' and (p_staff.department = p_task.department or p_staff.department = 'mgmt'))),
    false)
$$;

create or replace function ops.task_json(p_task ops.task) returns jsonb
language sql stable set search_path = '' as $$
  select to_jsonb(p_task) || jsonb_build_object(
    'assignee_name', (select s.name from ops.staff s where s.id = p_task.assignee_id),
    'created_by_name', (select s.name from ops.staff s where s.id = p_task.created_by),
    'department_name', (select d.name from ops.department d where d.code = p_task.department),
    'comment_count', (select count(*) from ops.task_comment c where c.task_id = p_task.id),
    'overdue', p_task.status in ('todo', 'doing') and p_task.due_date < current_date)
$$;

-- p_scope: mine（指派给我或我开的）/ dept（我的部门）/ all（我看得到的全部）
-- p_status: open（未完成）/ done / all
create or replace function public.ops_task_list(p_scope text default 'mine', p_status text default 'open')
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
begin
  me := ops.require_level('tasks', 'view');
  return (
    select coalesce(jsonb_agg(ops.task_json(r.x) || jsonb_build_object('editable', ops.task_editable(me, r.x))
                              order by ((r.x).status in ('todo', 'doing')) desc, (r.x).due_date nulls last, (r.x).id desc),
                    '[]'::jsonb)
    from (select x from ops.task x
          where ops.task_visible(me, x)
            and case coalesce(p_scope, 'mine')
                  when 'mine' then x.assignee_id = me.id or x.created_by = me.id
                  when 'dept' then x.department = me.department
                  else true end
            and case coalesce(p_status, 'open')
                  when 'open' then x.status in ('todo', 'doing')
                  when 'done' then x.status in ('done', 'cancelled')
                  else true end
          order by x.id desc
          limit 500) r
  );
end $$;

create or replace function public.ops_task_get(p_id bigint) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  t ops.task;
begin
  me := ops.require_level('tasks', 'view');
  select * into t from ops.task where id = p_id;
  if t.id is null or not ops.task_visible(me, t) then
    raise exception '找不到这个任务，或你没有权限看。' using errcode = 'P0002';
  end if;
  return ops.task_json(t) || jsonb_build_object(
    'editable', ops.task_editable(me, t),
    'comments', (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'body', c.body, 'created_at', c.created_at,
                                                              'staff_name', s.name) order by c.id), '[]'::jsonb)
                 from ops.task_comment c join ops.staff s on s.id = c.staff_id where c.task_id = t.id));
end $$;

-- 新增（p 没有 id）或修改（p 有 id）。栏位：title detail department assignee_id due_date priority status ref_no branch
create or replace function public.ops_task_save(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  t ops.task;
  v_id bigint := nullif(p ->> 'id', '')::bigint;
  v_status text;
begin
  me := ops.require_level('tasks', 'edit');
  if p ? 'assignee_id' and nullif(p ->> 'assignee_id', '') is not null
     and not exists (select 1 from ops.staff s where s.id = (p ->> 'assignee_id')::bigint and s.active) then
    raise exception '指派的员工不存在或已停用。';
  end if;

  if v_id is null then
    insert into ops.task (branch, department, title, detail, priority, assignee_id, due_date, ref_no, created_by)
    values (ops.home_branch(me, p ->> 'branch'),
            coalesce(nullif(p ->> 'department', ''), me.department),
            trim(coalesce(p ->> 'title', '')),
            coalesce(p ->> 'detail', ''),
            coalesce(nullif(p ->> 'priority', ''), 'normal'),
            nullif(p ->> 'assignee_id', '')::bigint,
            nullif(p ->> 'due_date', '')::date,
            coalesce(p ->> 'ref_no', ''),
            me.id)
    returning * into t;
    perform ops.log(me.id, 'create', 'task', t.id, p);
    return ops.task_json(t);
  end if;

  select * into t from ops.task where id = v_id for update;
  if t.id is null or not ops.task_editable(me, t) then
    raise exception '你不能修改这个任务（只有开任务的人、被指派的人、部门主管可以改）。' using errcode = '42501';
  end if;
  v_status := coalesce(nullif(p ->> 'status', ''), t.status);
  update ops.task set
    title       = case when p ? 'title' then trim(p ->> 'title') else title end,
    detail      = case when p ? 'detail' then coalesce(p ->> 'detail', '') else detail end,
    department  = case when p ? 'department' then coalesce(nullif(p ->> 'department', ''), department) else department end,
    priority    = case when p ? 'priority' then coalesce(nullif(p ->> 'priority', ''), priority) else priority end,
    assignee_id = case when p ? 'assignee_id' then nullif(p ->> 'assignee_id', '')::bigint else assignee_id end,
    due_date    = case when p ? 'due_date' then nullif(p ->> 'due_date', '')::date else due_date end,
    ref_no      = case when p ? 'ref_no' then coalesce(p ->> 'ref_no', '') else ref_no end,
    status      = v_status,
    done_at     = case when v_status = 'done' and status <> 'done' then now()
                       when v_status <> 'done' then null else done_at end,
    updated_at  = now()
  where id = v_id
  returning * into t;
  perform ops.log(me.id, 'update', 'task', t.id, p);
  return ops.task_json(t);
end $$;

create or replace function public.ops_task_comment(p_task_id bigint, p_body text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  t ops.task;
  c ops.task_comment;
begin
  me := ops.require_level('tasks', 'view');
  select * into t from ops.task where id = p_task_id;
  if t.id is null or not ops.task_visible(me, t) then
    raise exception '找不到这个任务，或你没有权限看。' using errcode = 'P0002';
  end if;
  insert into ops.task_comment (task_id, staff_id, body) values (t.id, me.id, trim(coalesce(p_body, '')))
  returning * into c;
  update ops.task set updated_at = now() where id = t.id;
  return jsonb_build_object('id', c.id, 'body', c.body, 'created_at', c.created_at, 'staff_name', me.name);
end $$;

-- ------------------------------------------------------------ 审批
create or replace function ops.can_decide(p_staff ops.staff, p_a ops.approval) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(
    p_a.requested_by <> p_staff.id and ops.sees_branch(p_staff, p_a.branch) and (
      p_staff.role = 'admin'
      or p_a.approver_id = p_staff.id
      or (ops.module_level(p_staff, 'approvals') = 'approve'
          and (p_staff.department = p_a.department or p_staff.department = 'mgmt'))),
    false)
$$;

create or replace function ops.approval_visible(p_staff ops.staff, p_a ops.approval) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(
    p_a.requested_by = p_staff.id or p_a.approver_id = p_staff.id or ops.can_decide(p_staff, p_a)
        or (p_staff.role = 'admin') or (p_staff.department = 'mgmt' and ops.sees_branch(p_staff, p_a.branch)),
    false)
$$;

create or replace function ops.approval_json(p_staff ops.staff, p_a ops.approval) returns jsonb
language sql stable security definer set search_path = '' as $$
  select to_jsonb(p_a) || jsonb_build_object(
    'requested_by_name', (select s.name from ops.staff s where s.id = p_a.requested_by),
    'approver_name', (select s.name from ops.staff s where s.id = p_a.approver_id),
    'decided_by_name', (select s.name from ops.staff s where s.id = p_a.decided_by),
    'department_name', (select d.name from ops.department d where d.code = p_a.department),
    'can_decide', p_a.status = 'pending' and ops.can_decide(p_staff, p_a),
    'can_cancel', p_a.status = 'pending' and p_a.requested_by = p_staff.id)
$$;

-- p_scope: todo（等我批）/ mine（我提交的）/ all（我看得到的全部）
create or replace function public.ops_approval_list(p_scope text default 'todo') returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
begin
  me := ops.require_level('approvals', 'view');
  return (
    select coalesce(jsonb_agg(ops.approval_json(me, r.x) order by ((r.x).status = 'pending') desc, (r.x).id desc),
                    '[]'::jsonb)
    from (select x from ops.approval x
          where ops.approval_visible(me, x)
            and case coalesce(p_scope, 'todo')
                  when 'todo' then x.status = 'pending' and ops.can_decide(me, x)
                  when 'mine' then x.requested_by = me.id
                  else true end
          order by x.id desc
          limit 500) r
  );
end $$;

-- 栏位：kind title detail amount department approver_id data branch
create or replace function public.ops_approval_create(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  a ops.approval;
begin
  me := ops.require_level('approvals', 'edit');
  if nullif(p ->> 'approver_id', '') is not null and (p ->> 'approver_id')::bigint = me.id then
    raise exception '不能指定自己审批自己的申请。';
  end if;
  insert into ops.approval (branch, department, kind, title, detail, amount, data, requested_by, approver_id)
  values (ops.home_branch(me, p ->> 'branch'),
          coalesce(nullif(p ->> 'department', ''), me.department),
          coalesce(nullif(p ->> 'kind', ''), 'other'),
          trim(coalesce(p ->> 'title', '')),
          coalesce(p ->> 'detail', ''),
          nullif(p ->> 'amount', '')::numeric,
          coalesce(p -> 'data', '{}'::jsonb),
          me.id,
          nullif(p ->> 'approver_id', '')::bigint)
  returning * into a;
  perform ops.log(me.id, 'create', 'approval', a.id, p);
  return ops.approval_json(me, a);
end $$;

-- p_decision: approved / rejected / cancelled（撤回，只有申请人）
create or replace function public.ops_approval_decide(p_id bigint, p_decision text, p_note text default '')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  a ops.approval;
begin
  me := ops.require_level('approvals', 'view');
  select * into a from ops.approval where id = p_id for update;
  if a.id is null or not ops.approval_visible(me, a) then
    raise exception '找不到这张申请，或你没有权限看。' using errcode = 'P0002';
  end if;
  if a.status <> 'pending' then
    raise exception '这张申请已经处理过了（%）。', a.status;
  end if;
  if p_decision = 'cancelled' then
    if a.requested_by <> me.id then
      raise exception '只有申请人可以撤回。' using errcode = '42501';
    end if;
  elsif p_decision in ('approved', 'rejected') then
    if not ops.can_decide(me, a) then
      raise exception '你不能审批这张申请（不能批自己的，也要是该部门主管、管理层或指定审批人）。' using errcode = '42501';
    end if;
  else
    raise exception '未知的决定：%', p_decision;
  end if;
  update ops.approval set status = p_decision, decided_by = me.id, decided_at = now(),
                          decision_note = coalesce(p_note, '')
  where id = a.id returning * into a;
  perform ops.log(me.id, p_decision, 'approval', a.id, jsonb_build_object('note', p_note));
  return ops.approval_json(me, a);
end $$;

-- ------------------------------------------------------------ 员工与权限（admin）
create or replace function public.ops_staff_admin_list() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform ops.require_level('admin', 'approve');
  return (select coalesce(jsonb_agg(to_jsonb(s) || jsonb_build_object(
                    'has_login', exists (select 1 from auth.users u where lower(u.email) = lower(s.email)),
                    'overrides', (select coalesce(jsonb_object_agg(sm.module, sm.level), '{}'::jsonb)
                                  from ops.staff_module sm where sm.staff_id = s.id))
                  order by s.active desc, s.department, s.name), '[]'::jsonb)
          from ops.staff s);
end $$;

-- 栏位：id(可空) email name department branch role title phone active overrides{module: level|''}
create or replace function public.ops_staff_save(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  s ops.staff;
  v_id bigint := nullif(p ->> 'id', '')::bigint;
  k text;
  v text;
begin
  me := ops.require_level('admin', 'approve');
  if coalesce(trim(p ->> 'email'), '') !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'email 格式不对。';
  end if;
  if v_id = me.id and (coalesce(p ->> 'role', 'admin') <> 'admin' or coalesce((p ->> 'active')::boolean, true) = false) then
    raise exception '不能拿掉自己的 admin 或停用自己（避免没有人能管理）。';
  end if;
  if v_id is null then
    insert into ops.staff (email, name, department, branch, role, title, phone, active)
    values (lower(trim(p ->> 'email')), trim(coalesce(p ->> 'name', '')), p ->> 'department',
            coalesce(nullif(p ->> 'branch', ''), 'HOMEWORKSSB'), coalesce(nullif(p ->> 'role', ''), 'staff'),
            coalesce(p ->> 'title', ''), coalesce(p ->> 'phone', ''), coalesce((p ->> 'active')::boolean, true))
    returning * into s;
  else
    update ops.staff set
      email = lower(trim(p ->> 'email')), name = trim(coalesce(p ->> 'name', name)),
      department = coalesce(nullif(p ->> 'department', ''), department),
      branch = coalesce(nullif(p ->> 'branch', ''), branch), role = coalesce(nullif(p ->> 'role', ''), role),
      title = coalesce(p ->> 'title', title), phone = coalesce(p ->> 'phone', phone),
      active = coalesce((p ->> 'active')::boolean, active), updated_at = now()
    where id = v_id returning * into s;
    if s.id is null then
      raise exception '找不到这位员工。';
    end if;
  end if;
  if length(s.name) = 0 then
    raise exception '请填员工姓名。';
  end if;
  if jsonb_typeof(p -> 'overrides') = 'object' then
    for k, v in select * from jsonb_each_text(p -> 'overrides') loop
      if coalesce(v, '') = '' then
        delete from ops.staff_module where staff_id = s.id and module = k;
      else
        insert into ops.staff_module (staff_id, module, level) values (s.id, k, v)
        on conflict (staff_id, module) do update set level = excluded.level;
      end if;
    end loop;
  end if;
  perform ops.log(me.id, case when v_id is null then 'create' else 'update' end, 'staff', s.id, p);
  return to_jsonb(s);
exception when unique_violation then
  raise exception '这个 email 已经在名单里了。';
end $$;

create or replace function public.ops_dept_module_list() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform ops.require_level('admin', 'approve');
  return (select coalesce(jsonb_agg(jsonb_build_object('department', dm.department, 'module', dm.module,
                                                       'level', dm.level)), '[]'::jsonb)
          from ops.dept_module dm);
end $$;

-- p_level 为空字串 = 拿掉
create or replace function public.ops_dept_module_set(p_department text, p_module text, p_level text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
begin
  me := ops.require_level('admin', 'approve');
  if p_module = 'admin' then
    raise exception '「员工与权限」只给 admin，不能开给部门。';
  end if;
  if coalesce(p_level, '') = '' then
    delete from ops.dept_module where department = p_department and module = p_module;
  else
    insert into ops.dept_module (department, module, level) values (p_department, p_module, p_level)
    on conflict (department, module) do update set level = excluded.level;
  end if;
  perform ops.log(me.id, 'set', 'dept_module', null,
                  jsonb_build_object('department', p_department, 'module', p_module, 'level', p_level));
end $$;

-- ------------------------------------------------------------ 执行权限：只给登入的人
do $$
declare
  f text;
begin
  foreach f in array array[
    'ops_me()', 'ops_directory()', 'ops_home()',
    'ops_task_list(text,text)', 'ops_task_get(bigint)', 'ops_task_save(jsonb)', 'ops_task_comment(bigint,text)',
    'ops_approval_list(text)', 'ops_approval_create(jsonb)', 'ops_approval_decide(bigint,text,text)',
    'ops_staff_admin_list()', 'ops_staff_save(jsonb)', 'ops_dept_module_list()',
    'ops_dept_module_set(text,text,text)'
  ] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

revoke all on all functions in schema ops from public, anon, authenticated;
