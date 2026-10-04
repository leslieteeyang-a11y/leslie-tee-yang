-- HomeWorks 营运系统 — 薪资（使用者 2026-10-04：把 HR 原本独立的薪资系统做成营运系统的模块）
-- 计算在前端 src/payroll/calc.ts（原样移植原系统、已逐笔比对），资料库只负责存放、权限与自动带入出勤：
--   * ops.pay_profile：每位员工的薪资设定（底薪、类别、EPF/SOCSO/EIS/SKBBK、佣金方式…），接在 ops.staff 上。
--   * ops.pay_setting：公司名称与可调参数（EPF %、包错货、迟到…），预设值同原系统。
--   * ops.pay_record：每人每月底薪 / 佣金各一笔，存当时的输入（inputs）与结果（result），调薪不影响旧月份。
--     draft → published（员工才看得到自己的）。改已发布的会自动退回草稿，要重新发布。
--   * 自动带入（使用者决定）：迟到次数 = 上班迟到的天数 + 午休迟回的天数；无薪假天数 = 已批的无薪假（半天 0.5）；
--     缺勤（没打卡也没请假）只显示给 HR 参考，不自动扣（选项 A）。加班先手动，加班模块做好再带入。
--   * 权限（使用者决定）：只有 HR 与管理层（薪资模块「可编辑」以上）；财务部拿掉。员工只看自己已发布的工资单。
-- 旧系统资料不搬（使用者决定重新开始）。

-- 拿掉财务部看薪资的权限、HR 删单笔记录：在 20261005_ops_payroll_delete.sql（还没套到正式环境）。
update ops.module set ready = true, description = '每月底薪 / 佣金计算（EPF、SOCSO、EIS）、工资单、自动带入迟到与无薪假'
where key = 'payroll';

create table ops.pay_profile (
  staff_id bigint primary key references ops.staff(id) on delete cascade,
  pay_name text not null default '',                    -- 工资单上的名字（空白 = 用员工名单的名字）
  base numeric(12,2) not null default 0 check (base >= 0),
  category text not null default 'local' check (category in ('local', 'local60', 'foreign')),
  epf_opt_in boolean not null default false,
  skbbk boolean not null default true,
  no_epf boolean not null default false,
  no_socso boolean not null default false,
  no_eis boolean not null default false,
  comm_type text not null default 'none' check (comm_type in ('none', 'percent', 'fixed')),
  comm_rate numeric(12,2) not null default 0 check (comm_rate >= 0),
  group_comm boolean not null default true,
  comm_only boolean not null default false,
  comm_with_base boolean not null default false,
  leave_date date,
  note text not null default '',
  updated_by bigint references ops.staff(id),
  updated_at timestamptz not null default now()
);

create table ops.pay_setting (
  id int primary key default 1 check (id = 1),
  company text not null default '',
  params jsonb not null default '{}'::jsonb,            -- 覆写 calc.ts 的 DEF_SET（只存改过的）
  updated_by bigint references ops.staff(id),
  updated_at timestamptz not null default now()
);
insert into ops.pay_setting (id) values (1);

create table ops.pay_record (
  id bigint generated always as identity primary key,
  staff_id bigint not null references ops.staff(id) on delete cascade,
  year int not null check (year between 2020 and 2100),
  month int not null check (month between 1 and 12),
  type text not null check (type in ('base', 'comm')),
  inputs jsonb not null default '{}'::jsonb,
  result jsonb not null,
  pay numeric(12,2) not null,                           -- 实收（底薪 net / 佣金 payout），汇总与员工清单用
  remark text not null default '' check (length(remark) <= 500),
  status text not null default 'draft' check (status in ('draft', 'published')),
  published_at timestamptz,
  created_by bigint not null references ops.staff(id),
  created_at timestamptz not null default now(),
  updated_by bigint references ops.staff(id),
  updated_at timestamptz not null default now(),
  unique (staff_id, year, month, type)
);
create index pay_record_month_idx on ops.pay_record (year, month);

alter table ops.pay_profile enable row level security;
alter table ops.pay_setting enable row level security;
alter table ops.pay_record enable row level security;

-- ------------------------------------------------------------ 出勤自动带入
-- 某人某月：迟到天数、午休迟回天数、无薪假天数（已批，半天 0.5）、缺勤天数（工作日没打卡也没请整天假，只给 HR 参考）
create or replace function ops.pay_att(p_staff ops.staff, p_year int, p_month int) returns jsonb
language sql stable security definer set search_path = '' as $$
  with d as (
    select g.d::date as d,
           ops.att_stats(p_staff, case when a.id is null then ops.att_blank(p_staff.id, g.d::date) else a end) as st,
           a.clock_in is not null as present
    from generate_series(greatest(make_date(p_year, p_month, 1), coalesce(p_staff.join_date, make_date(p_year, p_month, 1))),
                         least((make_date(p_year, p_month, 1) + interval '1 month - 1 day')::date, ops.today()),
                         interval '1 day') g(d)
    left join ops.attendance a on a.staff_id = p_staff.id and a.date = g.d::date
  )
  select jsonb_build_object(
    'late_days', count(*) filter (where (st->>'late_min')::int > 0),
    'lunch_late_days', count(*) filter (where (st->>'lunch_late_min')::int > 0),
    'unpaid_days', coalesce(sum(case when (st->>'workday')::boolean and st->'leave'->>'type' = 'unpaid'
                                     then case st->'leave'->>'part' when 'full' then 1 else 0.5 end end), 0),
    'absent_days', count(*) filter (where (st->>'workday')::boolean and not present and d < ops.today()
                                      and coalesce(st->'leave'->>'part', '') <> 'full'),
    'counted_to', max(d))
  from d
$$;

-- ------------------------------------------------------------ JSON
create or replace function ops.pay_profile_json(s ops.staff) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'staff_id', s.id, 'name', s.name, 'department_name', (select d.name from ops.department d where d.code = s.department),
    'branch', s.branch, 'active', s.active, 'phone', s.phone, 'join_date', s.join_date, 'has_profile', p.staff_id is not null,
    'pay_name', coalesce(p.pay_name, ''), 'base', coalesce(p.base, 0), 'category', coalesce(p.category, 'local'),
    'epf_opt_in', coalesce(p.epf_opt_in, false), 'skbbk', coalesce(p.skbbk, true), 'no_epf', coalesce(p.no_epf, false),
    'no_socso', coalesce(p.no_socso, false), 'no_eis', coalesce(p.no_eis, false),
    'comm_type', coalesce(p.comm_type, 'none'), 'comm_rate', coalesce(p.comm_rate, 0),
    'group_comm', coalesce(p.group_comm, true), 'comm_only', coalesce(p.comm_only, false),
    'comm_with_base', coalesce(p.comm_with_base, false), 'leave_date', p.leave_date, 'note', coalesce(p.note, ''))
  from (select 1) x left join ops.pay_profile p on p.staff_id = s.id
$$;

create or replace function ops.pay_record_json(r ops.pay_record) returns jsonb
language sql stable security definer set search_path = '' as $$
  select to_jsonb(r) || jsonb_build_object(
    'name', (select coalesce(nullif(p.pay_name, ''), s.name) from ops.staff s left join ops.pay_profile p on p.staff_id = s.id
             where s.id = r.staff_id),
    'updated_by_name', (select s.name from ops.staff s where s.id = coalesce(r.updated_by, r.created_by)))
$$;

-- ------------------------------------------------------------ HR：设定、员工薪资资料
create or replace function public.ops_pay_meta() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
begin
  me := ops.require_level('payroll', 'view');
  return jsonb_build_object(
    'level', ops.module_level(me, 'payroll'),
    'setting', (select jsonb_build_object('company', st.company, 'params', st.params, 'updated_at', st.updated_at)
                from ops.pay_setting st where st.id = 1),
    'profiles', (select coalesce(jsonb_agg(ops.pay_profile_json(s) order by s.active desc, s.name), '[]'::jsonb)
                 from ops.staff s where ops.sees_branch(me, s.branch)
                   and (s.active or exists (select 1 from ops.pay_profile p where p.staff_id = s.id))));
end $$;

create or replace function public.ops_pay_profile_save(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  t ops.staff;
begin
  me := ops.require_level('payroll', 'edit');
  select * into t from ops.staff where id = (p->>'staff_id')::bigint;
  if t.id is null or not ops.sees_branch(me, t.branch) then
    raise exception '找不到这位员工。' using errcode = 'P0002';
  end if;
  if coalesce((p->>'base')::numeric, 0) < 0 or coalesce((p->>'comm_rate')::numeric, 0) < 0 then
    raise exception '底薪、佣金不能是负数。' using errcode = '22023';
  end if;
  if nullif(p->>'leave_date', '') is not null and t.join_date is not null and (p->>'leave_date')::date < t.join_date then
    raise exception '离职日期不能早过到职日（%）。', t.join_date using errcode = '22023';
  end if;
  insert into ops.pay_profile as x (staff_id, pay_name, base, category, epf_opt_in, skbbk, no_epf, no_socso, no_eis,
                                    comm_type, comm_rate, group_comm, comm_only, comm_with_base, leave_date, note,
                                    updated_by, updated_at)
  values (t.id, trim(coalesce(p->>'pay_name', '')),
          case when coalesce((p->>'comm_only')::boolean, false) then 0 else coalesce((p->>'base')::numeric, 0) end,
          coalesce(nullif(p->>'category', ''), 'local'), coalesce((p->>'epf_opt_in')::boolean, false),
          coalesce((p->>'skbbk')::boolean, true), coalesce((p->>'no_epf')::boolean, false),
          coalesce((p->>'no_socso')::boolean, false), coalesce((p->>'no_eis')::boolean, false),
          coalesce(nullif(p->>'comm_type', ''), 'none'), coalesce((p->>'comm_rate')::numeric, 0),
          coalesce((p->>'group_comm')::boolean, true), coalesce((p->>'comm_only')::boolean, false),
          coalesce((p->>'comm_with_base')::boolean, false), nullif(p->>'leave_date', '')::date,
          trim(coalesce(p->>'note', '')), me.id, now())
  on conflict (staff_id) do update set
    pay_name = excluded.pay_name, base = excluded.base, category = excluded.category, epf_opt_in = excluded.epf_opt_in,
    skbbk = excluded.skbbk, no_epf = excluded.no_epf, no_socso = excluded.no_socso, no_eis = excluded.no_eis,
    comm_type = excluded.comm_type, comm_rate = excluded.comm_rate, group_comm = excluded.group_comm,
    comm_only = excluded.comm_only, comm_with_base = excluded.comm_with_base, leave_date = excluded.leave_date,
    note = excluded.note, updated_by = me.id, updated_at = now();
  -- 员工名单上的手机（WhatsApp 工资单用）可以在这里一起改
  if p ? 'phone' then
    update ops.staff set phone = trim(coalesce(p->>'phone', '')), updated_at = now() where id = t.id;
  end if;
  perform ops.log(me.id, 'pay_profile', 'staff', t.id, p);
  select * into t from ops.staff where id = t.id;
  return ops.pay_profile_json(t);
end $$;

create or replace function public.ops_pay_setting_save(p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  k text;
  v jsonb;
begin
  me := ops.require_level('payroll', 'edit');
  if jsonb_typeof(coalesce(p->'params', '{}'::jsonb)) <> 'object' then
    raise exception '参数格式不对。' using errcode = '22023';
  end if;
  for k, v in select * from jsonb_each(coalesce(p->'params', '{}'::jsonb)) loop
    if k not in ('epfEmpLocal', 'epfErLow', 'epfErHigh', 'epfErThreshold', 'epfEmp60', 'epfEr60', 'epfForeignErFlat',
                 'pcbThreshold', 'wrongGoodsRate', 'lateUnit', 'lateFraction', 'lateNoGroup')
       or jsonb_typeof(v) <> 'number' or (v::text)::numeric < 0 then
      raise exception '参数 % 不对（要是 0 以上的数字）。', k using errcode = '22023';
    end if;
    if k in ('lateUnit', 'lateNoGroup') and (v::text)::numeric < 1 then
      raise exception '迟到次数类的参数至少要 1。' using errcode = '22023';
    end if;
  end loop;
  update ops.pay_setting set company = trim(coalesce(p->>'company', company)),
    params = coalesce(p->'params', params), updated_by = me.id, updated_at = now()
  where id = 1;
  perform ops.log(me.id, 'pay_setting', 'pay_setting', 1, p);
end $$;

-- ------------------------------------------------------------ 每月
-- 当月：每人薪资资料 + 已存的记录 + 自动带入的出勤
create or replace function public.ops_pay_month(p_year int, p_month int) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  first date;
begin
  me := ops.require_level('payroll', 'view');
  if p_year not between 2020 and 2100 or p_month not between 1 and 12 then
    raise exception '月份不对。' using errcode = '22023';
  end if;
  first := make_date(p_year, p_month, 1);
  return jsonb_build_object(
    'year', p_year, 'month', p_month,
    'rows', (select coalesce(jsonb_agg(ops.pay_profile_json(s)
                   || jsonb_build_object('att', ops.pay_att(s, p_year, p_month),
                                         'records', (select coalesce(jsonb_object_agg(r.type, ops.pay_record_json(r)), '{}'::jsonb)
                                                     from ops.pay_record r where r.staff_id = s.id and r.year = p_year
                                                       and r.month = p_month))
                   order by s.name), '[]'::jsonb)
             from ops.staff s
             where ops.sees_branch(me, s.branch)
               and (exists (select 1 from ops.pay_record r where r.staff_id = s.id and r.year = p_year and r.month = p_month)
                    or (exists (select 1 from ops.pay_profile p where p.staff_id = s.id
                                  and (p.leave_date is null or p.leave_date >= first))
                        and (s.join_date is null or s.join_date <= (first + interval '1 month - 1 day')::date)
                        and s.active))));
end $$;

-- 存一批（批量页一次存全部）：p = {year, month, records: [{staff_id, type, inputs, result, pay, remark}]}
-- 已发布的被改了会退回草稿（要重新发布员工才看得到新的）
create or replace function public.ops_pay_save(p jsonb) returns int
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  y int := (p->>'year')::int;
  m int := (p->>'month')::int;
  x jsonb;
  t ops.staff;
  old ops.pay_record;
  n int := 0;
begin
  me := ops.require_level('payroll', 'edit');
  if y not between 2020 and 2100 or m not between 1 and 12 then
    raise exception '月份不对。' using errcode = '22023';
  end if;
  for x in select * from jsonb_array_elements(coalesce(p->'records', '[]'::jsonb)) loop
    select * into t from ops.staff where id = (x->>'staff_id')::bigint;
    if t.id is null or not ops.sees_branch(me, t.branch) then
      raise exception '找不到员工 %。', x->>'staff_id' using errcode = 'P0002';
    end if;
    if coalesce(x->>'type', '') not in ('base', 'comm') or jsonb_typeof(x->'result') <> 'object'
       or jsonb_typeof(x->'pay') <> 'number' then
      raise exception '资料格式不对（%）。', t.name using errcode = '22023';
    end if;
    select * into old from ops.pay_record r where r.staff_id = t.id and r.year = y and r.month = m and r.type = x->>'type'
      for update;
    if old.id is null then
      insert into ops.pay_record (staff_id, year, month, type, inputs, result, pay, remark, created_by)
      values (t.id, y, m, x->>'type', coalesce(x->'inputs', '{}'::jsonb), x->'result', (x->>'pay')::numeric,
              trim(coalesce(x->>'remark', '')), me.id);
      n := n + 1;
    elsif old.inputs is distinct from coalesce(x->'inputs', '{}'::jsonb) or old.result is distinct from x->'result'
          or old.remark is distinct from trim(coalesce(x->>'remark', '')) then
      perform ops.log(me.id, 'pay_update', 'pay_record', old.id, to_jsonb(old));   -- 旧版本留在稽核纪录
      update ops.pay_record set inputs = coalesce(x->'inputs', '{}'::jsonb), result = x->'result',
        pay = (x->>'pay')::numeric, remark = trim(coalesce(x->>'remark', '')),
        status = 'draft', published_at = null, updated_by = me.id, updated_at = now()
      where id = old.id;
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;


-- 发布 / 收回：p_ids 为空 = 当月全部
create or replace function public.ops_pay_publish(p_year int, p_month int, p_publish boolean, p_ids bigint[] default null)
returns int language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  n int;
begin
  me := ops.require_level('payroll', 'edit');
  update ops.pay_record r set status = case when p_publish then 'published' else 'draft' end,
    published_at = case when p_publish then now() end, updated_by = me.id, updated_at = now()
  where r.year = p_year and r.month = p_month and (p_ids is null or r.id = any(p_ids))
    and r.status = case when p_publish then 'draft' else 'published' end
    and exists (select 1 from ops.staff s where s.id = r.staff_id and ops.sees_branch(me, s.branch));
  get diagnostics n = row_count;
  perform ops.log(me.id, case when p_publish then 'pay_publish' else 'pay_unpublish' end, 'pay_record', null,
                  jsonb_build_object('year', p_year, 'month', p_month, 'ids', p_ids, 'n', n));
  return n;
end $$;

-- 历史：p = {year, month(可空), staff_id(可空)}
create or replace function public.ops_pay_history(p jsonb default '{}'::jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
begin
  me := ops.require_level('payroll', 'view');
  return (select coalesce(jsonb_agg(ops.pay_record_json(r) order by r.year desc, r.month desc, r.type, r.staff_id), '[]'::jsonb)
          from ops.pay_record r join ops.staff s on s.id = r.staff_id
          where ops.sees_branch(me, s.branch)
            and (nullif(p->>'year', '') is null or r.year = (p->>'year')::int)
            and (nullif(p->>'month', '') is null or r.month = (p->>'month')::int)
            and (nullif(p->>'staff_id', '') is null or r.staff_id = (p->>'staff_id')::bigint));
end $$;

-- ------------------------------------------------------------ 员工：我的工资单（只有已发布的）
create or replace function public.ops_pay_my() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
begin
  me := ops.require_staff();
  return jsonb_build_object(
    'company', (select st.company from ops.pay_setting st where st.id = 1),
    'records', (select coalesce(jsonb_agg(ops.pay_record_json(r) order by r.year desc, r.month desc, r.type), '[]'::jsonb)
                from ops.pay_record r where r.staff_id = me.id and r.status = 'published'));
end $$;

-- ------------------------------------------------------------ 权限
do $$
declare
  f text;
begin
  foreach f in array array[
    'ops_pay_meta()', 'ops_pay_profile_save(jsonb)', 'ops_pay_setting_save(jsonb)', 'ops_pay_month(int,int)',
    'ops_pay_save(jsonb)', 'ops_pay_publish(int,int,boolean,bigint[])',
    'ops_pay_history(jsonb)', 'ops_pay_my()'
  ] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

revoke all on all functions in schema ops from public, anon, authenticated;
revoke all on all tables in schema ops from public, anon, authenticated;
