-- HomeWorks 营运系统 — 员工自己申请加入、管理员批准（使用者 2026-10-08 决定）
--   * 管理员把「加入链接」（#/join?c=<邀请码>）发到员工群组；员工不用登入，填名字、email、自己的密码、手机、性别、到职日。
--   * 送出走 Edge Function `ops-join`（service role）：先呼叫 ops_join_submit 检查邀请码、存申请（不存密码），
--     再用 Auth admin 建登入账号（email 直接视为已验证）。email 已经有登入账号的**不改密码**（避免有人借申请改别人的密码）。
--   * 批准前账号进不了任何模块（ops_me 找不到员工 → 前端显示「申请审核中」）；批准 = 加进 ops.staff（管理员选部门、分店）。
--   * 管理员可以关掉申请、或换新邀请码（旧链接立刻失效）。
-- 这个档案不含删除指令（Supabase MCP 会挡）。

create table ops.join_setting (
  id int primary key default 1 check (id = 1),
  code text not null,
  enabled boolean not null default true,
  updated_by bigint references ops.staff(id),
  updated_at timestamptz not null default now()
);
insert into ops.join_setting (code) values (upper(substr(md5(random()::text || clock_timestamp()::text), 1, 8)));

create table ops.join_request (
  id bigint generated always as identity primary key,
  email text not null,
  name text not null check (length(trim(name)) > 0),
  phone text not null default '',
  gender text check (gender in ('M', 'F')),
  join_date date,
  branch text check (branch in ('HOMEWORKSSB', 'HOMEWORKSSOUTHERN')),
  note text not null default '' check (length(note) <= 300),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  staff_id bigint references ops.staff(id),
  decided_by bigint references ops.staff(id),
  decided_at timestamptz,
  decide_note text not null default '' check (length(decide_note) <= 300),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index join_request_pending_uq on ops.join_request (lower(email)) where status = 'pending';
alter table ops.join_setting enable row level security;
alter table ops.join_request enable row level security;

-- ------------------------------------------------------------ 送出申请（只给 Edge Function 的 service role 叫）
create or replace function public.ops_join_submit(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  st ops.join_setting;
  em text := lower(trim(coalesce(p->>'email', '')));
  nm text := trim(coalesce(p->>'name', ''));
  r ops.join_request;
begin
  select * into st from ops.join_setting where id = 1;
  if st.id is null or not st.enabled or upper(trim(coalesce(p->>'code', ''))) <> st.code then
    raise exception '加入链接已失效，请向管理员要新的链接。' using errcode = '42501';
  end if;
  if em !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'email 格式不对。' using errcode = '22023';
  end if;
  if length(nm) = 0 or length(nm) > 80 then
    raise exception '请填名字。' using errcode = '22023';
  end if;
  if exists (select 1 from ops.staff s where lower(s.email) = em) then
    raise exception '这个 email 已经在员工名单里了，请直接登入；忘了密码请找管理员。' using errcode = '23505';
  end if;
  if coalesce(p->>'gender', '') not in ('', 'M', 'F') then
    raise exception '性别只能是男或女。' using errcode = '22023';
  end if;
  if (select count(*) from ops.join_request where status = 'pending') >= 200 then
    raise exception '申请太多了，请等管理员处理后再送。' using errcode = '54000';
  end if;
  select * into r from ops.join_request where lower(email) = em and status = 'pending';
  if r.id is null then
    insert into ops.join_request (email, name, phone, gender, join_date, branch, note)
    values (em, nm, left(trim(coalesce(p->>'phone', '')), 30), nullif(p->>'gender', ''),
            nullif(p->>'join_date', '')::date, nullif(p->>'branch', ''), left(trim(coalesce(p->>'note', '')), 300))
    returning * into r;
  else
    update ops.join_request set name = nm, phone = left(trim(coalesce(p->>'phone', '')), 30),
      gender = nullif(p->>'gender', ''), join_date = nullif(p->>'join_date', '')::date,
      branch = nullif(p->>'branch', ''), note = left(trim(coalesce(p->>'note', '')), 300), updated_at = now()
    where id = r.id returning * into r;
  end if;
  return jsonb_build_object('id', r.id, 'email', r.email);
end $$;

-- ------------------------------------------------------------ 登入了但还不是员工：看自己的申请状态
create or replace function public.ops_join_status() returns jsonb
language sql stable security definer set search_path = '' as $$
  select (select jsonb_build_object('status', r.status, 'name', r.name, 'created_at', r.created_at, 'decide_note', r.decide_note)
          from ops.join_request r
          where lower(r.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
          order by r.created_at desc limit 1)
$$;

-- ------------------------------------------------------------ 管理员：设定、清单、批准 / 拒绝
create or replace function public.ops_join_list() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
begin
  me := ops.require_level('admin', 'approve');
  return jsonb_build_object(
    'setting', (select jsonb_build_object('code', s.code, 'enabled', s.enabled, 'updated_at', s.updated_at)
                from ops.join_setting s where s.id = 1),
    'pending', (select coalesce(jsonb_agg(to_jsonb(r) order by r.created_at), '[]'::jsonb)
                from ops.join_request r where r.status = 'pending'),
    'recent', (select coalesce(jsonb_agg(to_jsonb(x) order by x.decided_at desc), '[]'::jsonb) from (
                 select r.*, d.name as decided_by_name from ops.join_request r left join ops.staff d on d.id = r.decided_by
                 where r.status <> 'pending' order by r.decided_at desc limit 30) x));
end $$;

create or replace function public.ops_join_setting_save(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
begin
  me := ops.require_level('admin', 'approve');
  update ops.join_setting set
    enabled = coalesce((p->>'enabled')::boolean, enabled),
    code = case when coalesce((p->>'new_code')::boolean, false)
                then upper(substr(md5(random()::text || clock_timestamp()::text), 1, 8)) else code end,
    updated_by = me.id, updated_at = now()
  where id = 1;
  perform ops.log(me.id, 'join_setting', 'join_setting', 1, p);
  return (select jsonb_build_object('code', s.code, 'enabled', s.enabled) from ops.join_setting s where s.id = 1);
end $$;

-- p = {id, approve: bool, department, branch, role, title, note}
create or replace function public.ops_join_decide(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  r ops.join_request;
  s ops.staff;
  br text := coalesce(nullif(p->>'branch', ''), 'HOMEWORKSSB');
begin
  me := ops.require_level('admin', 'approve');
  select * into r from ops.join_request where id = (p->>'id')::bigint for update;
  if r.id is null or r.status <> 'pending' then
    raise exception '找不到这张申请，或已经处理过了。' using errcode = 'P0002';
  end if;
  if not coalesce((p->>'approve')::boolean, false) then
    update ops.join_request set status = 'rejected', decided_by = me.id, decided_at = now(),
      decide_note = left(trim(coalesce(p->>'note', '')), 300), updated_at = now()
    where id = r.id;
    perform ops.log(me.id, 'join_reject', 'join_request', r.id, p);
    return jsonb_build_object('id', r.id, 'status', 'rejected');
  end if;
  if not exists (select 1 from ops.department d where d.code = p->>'department') then
    raise exception '请选部门。' using errcode = '22023';
  end if;
  if br not in ('HOMEWORKSSB', 'HOMEWORKSSOUTHERN', 'ALL') then
    raise exception '分店不对。' using errcode = '22023';
  end if;
  if coalesce(nullif(p->>'role', ''), 'staff') not in ('staff', 'manager') then
    raise exception '角色只能是员工或主管。' using errcode = '22023';
  end if;
  if exists (select 1 from ops.staff x where lower(x.email) = lower(r.email)) then
    raise exception '这个 email 已经在员工名单里了。' using errcode = '23505';
  end if;
  insert into ops.staff (email, name, department, branch, role, title, phone, active, gender, join_date)
  values (lower(r.email), r.name, p->>'department', br, coalesce(nullif(p->>'role', ''), 'staff'),
          left(trim(coalesce(p->>'title', '')), 60), r.phone, true, r.gender, r.join_date)
  returning * into s;
  update ops.join_request set status = 'approved', staff_id = s.id, decided_by = me.id, decided_at = now(),
    decide_note = left(trim(coalesce(p->>'note', '')), 300), updated_at = now()
  where id = r.id;
  perform ops.log(me.id, 'join_approve', 'staff', s.id, p);
  return jsonb_build_object('id', r.id, 'status', 'approved', 'staff_id', s.id);
end $$;

-- ------------------------------------------------------------ 首页：管理员看到「N 个新员工申请加入」
create or replace function public.ops_home() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  rec ops.attendance;
  wh int := ops.level_rank(ops.module_level(ops.current_staff(), 'warehouse'));
  po int := ops.level_rank(ops.module_level(ops.current_staff(), 'purchasing'));
  hr int := ops.level_rank(ops.module_level(ops.current_staff(), 'hr'));
  pay int := ops.level_rank(ops.module_level(ops.current_staff(), 'payroll'));
  adm int := ops.level_rank(ops.module_level(ops.current_staff(), 'admin'));
begin
  me := ops.require_staff();
  select * into rec from ops.attendance where staff_id = me.id and date = ops.today();
  return jsonb_build_object(
    'my_open_tasks', (select count(*) from ops.task t where t.assignee_id = me.id and t.status in ('todo', 'doing')),
    'my_overdue', (select count(*) from ops.task t where t.assignee_id = me.id and t.status in ('todo', 'doing')
                   and t.due_date < current_date),
    'dept_open_tasks', (select count(*) from ops.task t where t.department = me.department
                        and t.status in ('todo', 'doing') and ops.sees_branch(me, t.branch)),
    'approvals_waiting', (select count(*) from ops.approval a where a.status = 'pending'
                          and ops.can_decide(me, a)),
    'my_pending_requests', (select count(*) from ops.approval a where a.requested_by = me.id and a.status = 'pending'),
    'po_overdue', case when po >= 2 then
                    (select count(*) from ops.v_po_open v where ops.sees_company(me, v.company)
                     and v.status <> 'closed' and v.days_late > 0
                     and (v.days_open <= 120 or v.status <> 'ordered' or v.po_eta is not null or v.shipment_id is not null))
                  end,
    'po_arriving', case when po >= 1 or wh >= 2 then
                    (select count(*) from ops.v_po_open v where ops.sees_company(me, v.company)
                     and v.status not in ('closed', 'arrived') and v.eta between ops.today() and ops.today() + 3) end,
    'att', case when ops.level_rank(ops.module_level(me, 'attendance')) >= 2 then jsonb_build_object(
             'clock_in', rec.clock_in, 'clock_out', rec.clock_out, 'lunch_in', rec.lunch_in,
             'workday', (select s.workday from ops.att_schedule(me, ops.today()) s),
             'leave', ops.leave_on(me.id, ops.today()),
             'open_shift', exists (select 1 from ops.attendance a where a.staff_id = me.id and a.date < ops.today()
                                   and a.clock_in is not null and a.clock_out is null)) end,
    'corrections_waiting', (select count(*) from ops.punch_correction c
                            where c.status in ('pending_hod', 'pending_hr') and ops.att_can_decide(me, c)),
    'leave_waiting', (select count(*) from ops.leave_request r where r.status = 'pending' and ops.leave_can_decide(me, r)),
    'my_pending_leave', (select count(*) from ops.leave_request r where r.staff_id = me.id and r.status = 'pending'),
    'wh_moves_pending', case when wh >= 3 then (select count(*) from ops.wh_move m
                          where m.status = 'pending' and ops.sees_company(me, m.company)) end,
    'wh_variances', case when wh >= 3 then (select count(*) from ops.wh_count k
                      where k.status = 'variance' and ops.sees_company(me, k.company)
                        and (k.attempt = 2 or k.count_date < ops.today())) end,
    'wh_counted_today', case when wh >= 2 then (select count(*) from ops.wh_count k
                          where k.counted_by = me.id and k.count_date = ops.today() and k.status <> 'superseded') end,
    'hr_gaps', case when hr >= 2 then (select count(*) from ops.staff s where s.active and ops.sees_branch(me, s.branch)
                 and (s.join_date is null or s.gender is null or coalesce(trim(s.phone), '') = ''
                      or (pay >= 1 and not exists (select 1 from ops.pay_profile p where p.staff_id = s.id)))) end,
    'holidays_ahead', case when hr >= 2 then (select count(*) from ops.holiday h
                        where h.date between ops.today() and ops.today() + 60) end,
    'join_pending', case when adm >= 3 then (select count(*) from ops.join_request r where r.status = 'pending') end
  );
end $$;

-- ------------------------------------------------------------ 权限
do $$
declare
  f text;
begin
  foreach f in array array['ops_join_status()', 'ops_join_list()', 'ops_join_setting_save(jsonb)', 'ops_join_decide(jsonb)', 'ops_home()'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
  revoke all on function public.ops_join_submit(jsonb) from public, anon, authenticated;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.ops_join_submit(jsonb) to service_role;
  end if;
end $$;
revoke all on all tables in schema ops from public, anon, authenticated;
