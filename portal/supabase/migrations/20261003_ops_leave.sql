-- HomeWorks 营运系统 — 请假（使用者 2026-10-03：员工自己申请，HR 审批；假别 = 年假、病假（劳工法）、
-- 无薪假、产假 / 陪产假、丧假 / 婚假（公司自订））。参考 AttendX docs/FEATURES-AND-RULES.md §7，简化如下：
--   * 假别是资料表 ops.leave_type，HR 可改天数、能不能请半天、要不要附件、启用 / 停用。
--   * 应得天数：
--       年假 annual：马来西亚 Employment Act s.60E —— 服务未满 2 年 8 天、2–5 年 12 天、5 年以上 16 天；
--                    到职那一年按到年底的完整月数比例（不足半天舍去、半天以上进一天）。
--       病假 sick：s.60F —— 未满 2 年 14 天、2–5 年 18 天、5 年以上 22 天（不按比例）。
--       其他 fixed：leave_type.days；none（无薪、丧假）不设上限、不算余额。
--     「服务年资」= 到当年的参考日已满几年：今年用今天，过去的年份用 12/31，未来的年份用 1/1。
--     没填到职日 = 当作新人（第一档）且不按比例，所以 HR 要记得填到职日。
--   * HR 调整（上年结转、系统上线前已休的天数、特别给假）记在 ops.leave_adjust，可正可负，都留纪录。
--   * 天数：一般假别算「上班日」（依员工班表，星期日 / 公共假期 0；星期六整天上班算 1 天）；
--     calendar_days 的假别（产假、陪产假、丧假）算日历天。半天 = 单一上班日 0.5 天。一张申请不能跨年。
--   * 余额检查：申请时与批准时都检查「已批 + 审核中 + 这张 ≤ 应得 + 调整」。
--   * 只有 HR（人事模块可编辑以上）可以批，不能批自己的。申请人可撤回审核中的，或开始日之前撤回已批的；
--     已开始的已批假单只有 HR 能取消。
--   * 打卡联动：已批的整天假 → 那天不算缺勤 / 迟到 / 早退；上午半天不算迟到，下午半天不算早退。

alter table ops.staff add column gender text check (gender in ('M', 'F'));

create table ops.leave_type (
  code text primary key check (code ~ '^[a-z0-9_]{2,20}$'),
  name text not null check (length(trim(name)) > 0),
  rule text not null check (rule in ('annual', 'sick', 'fixed', 'none')),
  days numeric(5,1) not null default 0 check (days >= 0),          -- fixed：每年天数；none：每次最多几天（0 = 不限）
  half_day boolean not null default false,
  calendar_days boolean not null default false,
  need_attachment boolean not null default false,
  gender text check (gender in ('M', 'F')),                          -- 只限男 / 女；null = 不限
  min_service_months int not null default 0 check (min_service_months >= 0),
  active boolean not null default true,
  note text not null default '',
  sort int not null default 0
);

insert into ops.leave_type (code, name, rule, days, half_day, calendar_days, need_attachment, gender,
                            min_service_months, sort, note) values
  ('annual',        '年假',   'annual', 0,  true,  false, false, null, 0,  10, '劳工法：未满 2 年 8 天、2–5 年 12 天、5 年以上 16 天'),
  ('sick',          '病假',   'sick',   0,  true,  false, true,  null, 0,  20, '劳工法：未满 2 年 14 天、2–5 年 18 天、5 年以上 22 天；要附医生证明（MC）'),
  ('hospital',      '住院假', 'fixed',  60, false, false, true,  null, 0,  30, '劳工法：每年 60 天（含病假）'),
  ('unpaid',        '无薪假', 'none',   0,  true,  false, false, null, 0,  40, '不扣余额，薪资按天扣'),
  ('maternity',     '产假',   'fixed',  98, false, true,  true,  'F',  0,  50, '劳工法：98 天（日历天）'),
  ('paternity',     '陪产假', 'fixed',  7,  false, true,  true,  'M',  12, 60, '劳工法：7 天（日历天），服务满 12 个月'),
  ('compassionate', '丧假',   'none',   3,  false, true,  false, null, 0,  70, '公司自订：每次最多 3 天（日历天）'),
  ('marriage',      '婚假',   'fixed',  3,  false, false, false, null, 0,  80, '公司自订：每年 3 天');

create table ops.leave_adjust (
  id bigint generated always as identity primary key,
  staff_id bigint not null references ops.staff(id) on delete cascade,
  year int not null check (year between 2020 and 2100),
  type text not null references ops.leave_type(code),
  days numeric(5,1) not null check (days <> 0 and days between -366 and 366),
  note text not null check (length(trim(note)) > 0),
  created_by bigint not null references ops.staff(id),
  created_at timestamptz not null default now()
);
create index leave_adjust_staff_idx on ops.leave_adjust (staff_id, year);

create table ops.leave_request (
  id bigint generated always as identity primary key,
  staff_id bigint not null references ops.staff(id) on delete cascade,
  type text not null references ops.leave_type(code),
  start_date date not null,
  end_date date not null,
  part text not null default 'full' check (part in ('full', 'am', 'pm')),
  days numeric(5,1) not null check (days > 0),
  reason text not null default '' check (length(reason) <= 500),
  attachment text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  decided_by bigint references ops.staff(id),
  decided_at timestamptz,
  decision_note text not null default '',
  created_by bigint not null references ops.staff(id),
  created_at timestamptz not null default now(),
  check (end_date >= start_date),
  check (extract(year from start_date) = extract(year from end_date)),
  check (part = 'full' or start_date = end_date)
);
create index leave_request_staff_idx on ops.leave_request (staff_id, start_date);
create index leave_request_pending_idx on ops.leave_request (status) where status = 'pending';

alter table ops.leave_type enable row level security;
alter table ops.leave_adjust enable row level security;
alter table ops.leave_request enable row level security;

-- 模块：「请假」所有部门可编辑（= 自己申请）；「人事」上线（HR 审批、余额、假别设定）
insert into ops.module (key, name, phase, ready, sort, description) values
  ('leave', '请假', 5, true, 96, '申请请假、看自己的假期余额');
insert into ops.dept_module (department, module, level)
select code, 'leave', 'edit' from ops.department
on conflict (department, module) do nothing;
update ops.module set ready = true, description = '请假审批、假期余额、假别设定' where key = 'hr';

-- ------------------------------------------------------------ 计算
-- 到某日已满几年
create or replace function ops.leave_years(p_join date, p_asof date) returns int
language sql immutable set search_path = '' as $$
  select case when p_join is null or p_asof < p_join then 0
              else extract(year from age(p_asof, p_join))::int end
$$;

-- 某年的年资参考日：今年 = 今天；过去 = 12/31；未来 = 1/1
create or replace function ops.leave_asof(p_year int) returns date
language sql stable set search_path = '' as $$
  select case when p_year = extract(year from ops.today())::int then ops.today()
              when p_year < extract(year from ops.today())::int then make_date(p_year, 12, 31)
              else make_date(p_year, 1, 1) end
$$;

-- 应得天数（不含 HR 调整）；none 规则回传 null（不算余额）
create or replace function ops.leave_entitled(p_staff ops.staff, p_type ops.leave_type, p_year int) returns numeric
language plpgsql stable set search_path = '' as $$
declare
  yrs int := ops.leave_years(p_staff.join_date, ops.leave_asof(p_year));
  base numeric;
  months int;
begin
  if p_type.rule = 'none' then
    return null;
  end if;
  if p_staff.join_date is not null and p_staff.join_date > make_date(p_year, 12, 31) then
    return 0;
  end if;
  if p_type.min_service_months > 0 and (p_staff.join_date is null
       or p_staff.join_date + make_interval(months => p_type.min_service_months) > make_date(p_year, 12, 31)) then
    return 0;
  end if;
  if p_type.rule = 'annual' then
    base := case when yrs < 2 then 8 when yrs < 5 then 12 else 16 end;
    -- 到职那一年：按到年底的完整月数比例，半天以上进一天
    if p_staff.join_date is not null and extract(year from p_staff.join_date)::int = p_year then
      months := extract(year from age(make_date(p_year, 12, 31) + 1, p_staff.join_date))::int * 12
              + extract(month from age(make_date(p_year, 12, 31) + 1, p_staff.join_date))::int;
      return floor(base * months / 12.0 + 0.5);
    end if;
    return base;
  elsif p_type.rule = 'sick' then
    return case when yrs < 2 then 14 when yrs < 5 then 18 else 22 end;
  end if;
  return p_type.days;
end $$;

-- 某张假单要扣几天
create or replace function ops.leave_count(p_staff ops.staff, p_type ops.leave_type, p_start date, p_end date,
                                           p_part text) returns numeric
language sql stable set search_path = '' as $$
  select case
    when p_part in ('am', 'pm') then 0.5
    when p_type.calendar_days then (p_end - p_start + 1)::numeric
    else (select count(*)::numeric from generate_series(p_start, p_end, interval '1 day') g(d)
          where (select s.workday from ops.att_schedule(p_staff, g.d::date) s))
  end
$$;

-- 已用（已批）/ 审核中，某年某假别
create or replace function ops.leave_used(p_staff bigint, p_type text, p_year int, p_status text,
                                          p_except bigint default null) returns numeric
language sql stable set search_path = '' as $$
  select coalesce(sum(r.days), 0) from ops.leave_request r
  where r.staff_id = p_staff and r.type = p_type and r.status = p_status
    and extract(year from r.start_date)::int = p_year and r.id is distinct from p_except
$$;

create or replace function ops.leave_adjusted(p_staff bigint, p_type text, p_year int) returns numeric
language sql stable set search_path = '' as $$
  select coalesce(sum(a.days), 0) from ops.leave_adjust a
  where a.staff_id = p_staff and a.type = p_type and a.year = p_year
$$;

-- 一位员工某年的所有假别余额
create or replace function ops.leave_balances(p_staff ops.staff, p_year int) returns jsonb
language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'type', t.code, 'name', t.name, 'rule', t.rule,
           'entitled', e.ent, 'adjust', e.adj, 'used', e.used, 'pending', e.pend,
           'balance', case when e.ent is null then null else e.ent + e.adj - e.used - e.pend end)
         order by t.sort), '[]'::jsonb)
  from ops.leave_type t
  cross join lateral (select ops.leave_entitled(p_staff, t, p_year) as ent,
                             ops.leave_adjusted(p_staff.id, t.code, p_year) as adj,
                             ops.leave_used(p_staff.id, t.code, p_year, 'approved') as used,
                             ops.leave_used(p_staff.id, t.code, p_year, 'pending') as pend) e
  where (t.active or e.used > 0 or e.pend > 0 or e.adj <> 0)
    and (t.gender is null or p_staff.gender is null or t.gender = p_staff.gender)
$$;

-- 某员工某天有没有已批的假：'full' / 'am' / 'pm' / null
create or replace function ops.leave_on(p_staff bigint, p_date date) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('part', r.part, 'type', r.type, 'name', t.name)
  from ops.leave_request r join ops.leave_type t on t.code = r.type
  where r.staff_id = p_staff and r.status = 'approved' and p_date between r.start_date and r.end_date
  order by (r.part = 'full') desc limit 1
$$;

-- ------------------------------------------------------------ 权限
create or replace function ops.leave_can_decide(p_me ops.staff, r ops.leave_request) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  t ops.staff;
begin
  if r.status <> 'pending' or r.staff_id = p_me.id then
    return false;
  end if;
  select * into t from ops.staff where id = r.staff_id;
  return coalesce(t.id is not null and ops.sees_branch(p_me, t.branch) and ops.att_is_hr(p_me), false);
end $$;

create or replace function ops.leave_can_cancel(p_me ops.staff, r ops.leave_request) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  t ops.staff;
begin
  if r.status = 'pending' and r.staff_id = p_me.id then
    return true;
  end if;
  if r.status <> 'approved' then
    return false;
  end if;
  if r.staff_id = p_me.id and r.start_date > ops.today() then
    return true;
  end if;
  select * into t from ops.staff where id = r.staff_id;
  return coalesce(r.staff_id <> p_me.id and ops.sees_branch(p_me, t.branch) and ops.att_is_hr(p_me), false);
end $$;

create or replace function ops.leave_json(p_me ops.staff, r ops.leave_request) returns jsonb
language sql stable security definer set search_path = '' as $$
  select to_jsonb(r) || jsonb_build_object(
    'type_name', (select t.name from ops.leave_type t where t.code = r.type),
    'staff_name', (select s.name from ops.staff s where s.id = r.staff_id),
    'department_name', (select d.name from ops.staff s join ops.department d on d.code = s.department where s.id = r.staff_id),
    'decided_by_name', (select s.name from ops.staff s where s.id = r.decided_by),
    'created_by_name', case when r.created_by <> r.staff_id then (select s.name from ops.staff s where s.id = r.created_by) end,
    'can_decide', ops.leave_can_decide(p_me, r),
    'can_cancel', ops.leave_can_cancel(p_me, r))
$$;

-- 余额够不够（申请、批准都用）
create or replace function ops.leave_check_balance(p_staff ops.staff, p_type ops.leave_type, p_year int, p_days numeric,
                                                   p_except bigint) returns void
language plpgsql stable set search_path = '' as $$
declare
  ent numeric := ops.leave_entitled(p_staff, p_type, p_year);
  avail numeric;
begin
  if ent is null then
    return;
  end if;
  avail := ent + ops.leave_adjusted(p_staff.id, p_type.code, p_year)
           - ops.leave_used(p_staff.id, p_type.code, p_year, 'approved', p_except)
           - ops.leave_used(p_staff.id, p_type.code, p_year, 'pending', p_except);
  if p_days > avail then
    raise exception '%余额不够：% 年还可以请 % 天（已扣掉审核中的），这张要 % 天。', p_type.name, p_year,
      trim_scale(greatest(avail, 0)), trim_scale(p_days) using errcode = '22023';
  end if;
end $$;

-- ------------------------------------------------------------ 员工：申请、看自己的
-- 请假页：假别、我今年的余额、我的假单
create or replace function public.ops_leave_home(p_year int default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  y int;
begin
  me := ops.require_level('leave', 'view');
  y := coalesce(p_year, extract(year from ops.today())::int);
  return jsonb_build_object(
    'today', ops.today(), 'year', y, 'join_date', me.join_date, 'gender', me.gender,
    'is_hr', ops.att_is_hr(me),
    'types', (select coalesce(jsonb_agg(jsonb_build_object('code', t.code, 'name', t.name, 'rule', t.rule, 'days', t.days,
                                                           'half_day', t.half_day, 'calendar_days', t.calendar_days,
                                                           'need_attachment', t.need_attachment, 'note', t.note)
                                        order by t.sort), '[]'::jsonb)
              from ops.leave_type t where t.active and (t.gender is null or me.gender is null or t.gender = me.gender)),
    'balances', ops.leave_balances(me, y),
    'requests', (select coalesce(jsonb_agg(ops.leave_json(me, r) order by r.start_date desc, r.id desc), '[]'::jsonb)
                 from ops.leave_request r where r.staff_id = me.id
                   and (extract(year from r.start_date)::int = y or r.status = 'pending')));
end $$;

-- 先算天数给表单看（不写入）
create or replace function public.ops_leave_preview(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  t ops.staff;
  lt ops.leave_type;
  s date := nullif(p->>'start_date', '')::date;
  e date := coalesce(nullif(p->>'end_date', '')::date, nullif(p->>'start_date', '')::date);
  v_part text := coalesce(nullif(p->>'part', ''), 'full');
begin
  me := ops.require_level('leave', 'view');
  t := me;
  if nullif(p->>'staff_id', '') is not null and (p->>'staff_id')::bigint <> me.id and ops.att_is_hr(me) then
    select * into t from ops.staff where id = (p->>'staff_id')::bigint;
  end if;
  select * into lt from ops.leave_type where code = p->>'type';
  if lt.code is null or s is null or e < s or e - s > 366 then
    return jsonb_build_object('days', null);
  end if;
  return jsonb_build_object('days', ops.leave_count(t, lt, s, e, case when v_part in ('am', 'pm') and s = e then v_part else 'full' end));
end $$;

-- p: {type, start_date, end_date, part: full|am|pm, reason, attachment, staff_id?（HR 代填）}
create or replace function public.ops_leave_apply(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  t ops.staff;
  lt ops.leave_type;
  s date := nullif(p->>'start_date', '')::date;
  e date := coalesce(nullif(p->>'end_date', '')::date, nullif(p->>'start_date', '')::date);
  v_part text := coalesce(nullif(p->>'part', ''), 'full');
  n numeric;
  att text := nullif(p->>'attachment', '');
  by_hr boolean := false;
  r ops.leave_request;
begin
  me := ops.require_level('leave', 'edit');
  t := me;
  if nullif(p->>'staff_id', '') is not null and (p->>'staff_id')::bigint <> me.id then
    if not ops.att_is_hr(me) then
      raise exception '只有 HR 可以帮别人请假。' using errcode = '42501';
    end if;
    select * into t from ops.staff where id = (p->>'staff_id')::bigint and active;
    if t.id is null or not ops.sees_branch(me, t.branch) then
      raise exception '找不到这位员工。' using errcode = 'P0002';
    end if;
    by_hr := true;
  end if;
  select * into lt from ops.leave_type where code = p->>'type';
  if lt.code is null or not lt.active then
    raise exception '请选择假别。' using errcode = '22023';
  end if;
  if s is null then
    raise exception '请填开始日期。' using errcode = '22023';
  end if;
  if e < s then
    raise exception '结束日期不能早于开始日期。' using errcode = '22023';
  end if;
  if extract(year from s) <> extract(year from e) then
    raise exception '请假不能跨年，请分成两张申请（12/31 之前一张、1/1 之后一张）。' using errcode = '22023';
  end if;
  if e - s > 98 then
    raise exception '一张申请最多 99 天。' using errcode = '22023';
  end if;
  if v_part not in ('full', 'am', 'pm') then
    v_part := 'full';
  end if;
  if v_part <> 'full' then
    if not lt.half_day then
      raise exception '%不能请半天。', lt.name using errcode = '22023';
    end if;
    if s <> e then
      raise exception '半天假只能选一天。' using errcode = '22023';
    end if;
  end if;
  if not by_hr and s < ops.today() - 30 then
    raise exception '只能补请 30 天以内的假；更早的请找 HR 帮你登记。' using errcode = '22023';
  end if;
  if t.join_date is not null and s < t.join_date then
    raise exception '请假日期不能早于到职日（%）。', t.join_date using errcode = '22023';
  end if;
  if lt.gender is not null and t.gender is not null and lt.gender <> t.gender then
    raise exception '%只限%性员工。', lt.name, case lt.gender when 'F' then '女' else '男' end using errcode = '22023';
  end if;
  if lt.min_service_months > 0 and (t.join_date is null or t.join_date + make_interval(months => lt.min_service_months) > s) then
    raise exception '%要服务满 % 个月才能请%。', lt.name, lt.min_service_months,
      case when t.join_date is null then '（HR 还没填你的到职日）' else '' end using errcode = '22023';
  end if;
  n := ops.leave_count(t, lt, s, e, v_part);
  if n <= 0 then
    raise exception '这几天都不是上班日（星期日 / 公共假期），不用请假。' using errcode = '22023';
  end if;
  if v_part <> 'full' and not lt.calendar_days
     and not (select sc.workday from ops.att_schedule(t, s) sc) then
    raise exception '那天不是上班日，不用请半天。' using errcode = '22023';
  end if;
  if lt.rule = 'none' and lt.days > 0 and n > lt.days then
    raise exception '%每次最多 % 天。', lt.name, trim_scale(lt.days) using errcode = '22023';
  end if;
  if lt.need_attachment and att is null then
    raise exception '%要附证明（照片或 PDF），例：医生证明。', lt.name using errcode = '22023';
  end if;
  if att is not null and (split_part(att, '/', 1) <> t.id::text and split_part(att, '/', 1) <> me.id::text
       or not exists (select 1 from storage.objects o where o.bucket_id = 'ops-hr' and o.name = att)) then
    raise exception '附件没有上传成功，请再选一次档案。' using errcode = '22023';
  end if;
  if exists (select 1 from ops.leave_request x where x.staff_id = t.id and x.status in ('pending', 'approved')
             and x.start_date <= e and x.end_date >= s
             and not (x.part <> 'full' and v_part <> 'full' and x.part <> v_part)) then
    raise exception '这段时间已经有请假（审核中或已批准），不能重复申请。' using errcode = '22023';
  end if;
  perform ops.leave_check_balance(t, lt, extract(year from s)::int, n, null);
  insert into ops.leave_request (staff_id, type, start_date, end_date, part, days, reason, attachment, created_by)
  values (t.id, lt.code, s, e, v_part, n, trim(coalesce(p->>'reason', '')), att, me.id)
  returning * into r;
  perform ops.log(me.id, 'apply', 'leave_request', r.id, to_jsonb(r));
  return ops.leave_json(me, r);
end $$;

create or replace function public.ops_leave_cancel(p_id bigint, p_note text default '') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  r ops.leave_request;
begin
  me := ops.require_level('leave', 'view');
  select * into r from ops.leave_request where id = p_id for update;
  if r.id is null or not ops.leave_can_cancel(me, r) then
    if r.id is not null and r.status = 'approved' and r.staff_id = me.id then
      raise exception '假期已经开始（或已过），不能自己撤回，请找 HR。' using errcode = '42501';
    end if;
    raise exception '这张假单不能撤回（可能已经处理过）。' using errcode = '42501';
  end if;
  update ops.leave_request set status = 'cancelled', decided_at = now(),
    decided_by = case when r.staff_id <> me.id then me.id else decided_by end,
    decision_note = case when r.staff_id <> me.id then trim(coalesce(p_note, '')) else decision_note end
  where id = r.id returning * into r;
  perform ops.log(me.id, 'cancel', 'leave_request', r.id, '{}'::jsonb);
  return ops.leave_json(me, r);
end $$;

-- ------------------------------------------------------------ HR
-- scope: todo（等我审）/ all（看得到的全部，可按月份 / 员工筛）
create or replace function public.ops_leave_list(p jsonb default '{}'::jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  scope text := coalesce(p->>'scope', 'todo');
  ym text := nullif(p->>'ym', '');
  sid bigint := nullif(p->>'staff_id', '')::bigint;
  f date; l date;
begin
  me := ops.require_level('hr', 'view');
  if ym is not null then
    if ym !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
      raise exception '月份格式要是 YYYY-MM。' using errcode = '22023';
    end if;
    f := to_date(ym || '-01', 'YYYY-MM-DD');
    l := (f + interval '1 month - 1 day')::date;
  end if;
  return (select coalesce(jsonb_agg(ops.leave_json(me, r) order by r.start_date desc, r.id desc), '[]'::jsonb)
          from ops.leave_request r join ops.staff s on s.id = r.staff_id
          where ops.sees_branch(me, s.branch)
            and case when scope = 'todo' then r.status = 'pending' and ops.leave_can_decide(me, r)
                     else (f is null or (r.start_date <= l and r.end_date >= f))
                          and (sid is null or r.staff_id = sid) end);
end $$;

create or replace function public.ops_leave_decide(p_id bigint, p_decision text, p_note text default '') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  t ops.staff;
  lt ops.leave_type;
  r ops.leave_request;
begin
  me := ops.require_staff();
  select * into r from ops.leave_request where id = p_id for update;
  if r.id is null then
    raise exception '找不到这张假单。' using errcode = 'P0002';
  end if;
  if not ops.leave_can_decide(me, r) then
    if r.status <> 'pending' then
      raise exception '这张假单已经处理过了。' using errcode = '22023';
    end if;
    raise exception '只有 HR 可以审请假（也不能审自己的）。' using errcode = '42501';
  end if;
  if p_decision = 'reject' then
    if length(trim(coalesce(p_note, ''))) = 0 then
      raise exception '驳回请写原因，让申请人知道。' using errcode = '22023';
    end if;
    update ops.leave_request set status = 'rejected', decided_by = me.id, decided_at = now(), decision_note = trim(p_note)
    where id = r.id returning * into r;
  elsif p_decision = 'approve' then
    select * into t from ops.staff where id = r.staff_id;
    select * into lt from ops.leave_type where code = r.type;
    -- 申请后余额可能变了（HR 调整、别张先批）：批之前再检查一次，自己这张不算审核中
    perform ops.leave_check_balance(t, lt, extract(year from r.start_date)::int, r.days, r.id);
    update ops.leave_request set status = 'approved', decided_by = me.id, decided_at = now(),
                                 decision_note = trim(coalesce(p_note, ''))
    where id = r.id returning * into r;
  else
    raise exception '未知的决定：%', p_decision using errcode = '22023';
  end if;
  perform ops.log(me.id, p_decision, 'leave_request', r.id, jsonb_build_object('status', r.status));
  return ops.leave_json(me, r);
end $$;

-- 全体员工某年的余额（HR）
create or replace function public.ops_leave_balances(p_year int default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  y int;
begin
  me := ops.require_level('hr', 'view');
  y := coalesce(p_year, extract(year from ops.today())::int);
  return jsonb_build_object('year', y, 'rows', (
    select coalesce(jsonb_agg(jsonb_build_object('staff_id', s.id, 'name', s.name, 'department_name', d.name,
                                                 'branch', s.branch, 'join_date', s.join_date, 'gender', s.gender,
                                                 'years', ops.leave_years(s.join_date, ops.leave_asof(y)),
                                                 'balances', ops.leave_balances(s, y),
                                                 'adjustments', (select coalesce(jsonb_agg(jsonb_build_object(
                                                      'id', a.id, 'type', a.type, 'days', a.days, 'note', a.note,
                                                      'by', (select b.name from ops.staff b where b.id = a.created_by),
                                                      'at', a.created_at) order by a.id), '[]'::jsonb)
                                                    from ops.leave_adjust a where a.staff_id = s.id and a.year = y))
                              order by d.sort, s.name), '[]'::jsonb)
    from ops.staff s join ops.department d on d.code = s.department
    where s.active and ops.sees_branch(me, s.branch)));
end $$;

-- p: {staff_id, year, type, days, note}
create or replace function public.ops_leave_adjust(p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  t ops.staff;
  v numeric := nullif(p->>'days', '')::numeric;
  a ops.leave_adjust;
begin
  me := ops.require_level('hr', 'edit');
  select * into t from ops.staff where id = (p->>'staff_id')::bigint;
  if t.id is null or not ops.sees_branch(me, t.branch) then
    raise exception '找不到这位员工。' using errcode = 'P0002';
  end if;
  if t.id = me.id and me.role <> 'admin' then
    raise exception '不能调整自己的假期，请找另一位 HR。' using errcode = '42501';
  end if;
  if not exists (select 1 from ops.leave_type lt where lt.code = p->>'type' and lt.rule <> 'none') then
    raise exception '这个假别没有余额，不用调整。' using errcode = '22023';
  end if;
  if v is null or v = 0 or v * 2 <> round(v * 2) then
    raise exception '天数要是 0.5 的倍数（加用正数、扣用负数）。' using errcode = '22023';
  end if;
  if length(trim(coalesce(p->>'note', ''))) = 0 then
    raise exception '请写调整原因（例：2025 年结转、上线前已休 3 天）。' using errcode = '22023';
  end if;
  insert into ops.leave_adjust (staff_id, year, type, days, note, created_by)
  values (t.id, (p->>'year')::int, p->>'type', v, trim(p->>'note'), me.id) returning * into a;
  perform ops.log(me.id, 'adjust', 'leave_adjust', a.id, to_jsonb(a));
end $$;

create or replace function public.ops_leave_types() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform ops.require_level('hr', 'view');
  return (select coalesce(jsonb_agg(to_jsonb(t) order by t.sort), '[]'::jsonb) from ops.leave_type t);
end $$;

-- 只改公司可以自订的栏位；规则（annual / sick / fixed / none）与代号不能改
create or replace function public.ops_leave_type_save(p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  t ops.leave_type;
begin
  me := ops.require_level('hr', 'approve');
  select * into t from ops.leave_type where code = p->>'code';
  if t.code is null then
    raise exception '没有这个假别。' using errcode = 'P0002';
  end if;
  if length(trim(coalesce(p->>'name', t.name))) = 0 then
    raise exception '请填假别名称。' using errcode = '22023';
  end if;
  update ops.leave_type set
    name = trim(coalesce(p->>'name', name)),
    days = case when rule in ('fixed', 'none') then coalesce(nullif(p->>'days', '')::numeric, days) else days end,
    half_day = coalesce((p->>'half_day')::boolean, half_day),
    need_attachment = coalesce((p->>'need_attachment')::boolean, need_attachment),
    active = coalesce((p->>'active')::boolean, active),
    note = coalesce(p->>'note', note)
  where code = t.code;
  perform ops.log(me.id, 'leave_type', 'leave_type', null, p);
end $$;

-- ------------------------------------------------------------ 打卡联动：请假的日子不算迟到 / 早退 / 缺勤
create or replace function ops.att_stats(p_staff ops.staff, a ops.attendance)
returns jsonb language plpgsql stable set search_path = '' as $$
declare
  s record;
  ci time; co time;
  allowed int;
  lv jsonb := ops.leave_on(p_staff.id, a.date);
  part text := lv->>'part';
  late int := 0; lunch_late int := 0; early int := 0; worked int := null;
begin
  select * into s from ops.att_schedule(p_staff, a.date);
  allowed := ops.att_mins(s.t_lunch_out, s.t_lunch_in);
  ci := date_trunc('minute', ops.kl(a.clock_in))::time;
  co := ops.kl(a.clock_out)::time;
  if s.workday and ci is not null and coalesce(part, '') not in ('full', 'am') then
    late := greatest(0, ops.att_mins(s.t_start, ci));
  end if;
  if s.workday and s.has_lunch and a.lunch_out is not null and a.lunch_in is not null then
    lunch_late := greatest(0, floor(extract(epoch from (a.lunch_in - a.lunch_out)) / 60)::int - allowed);
  end if;
  if s.workday and co is not null and ops.kl(a.clock_out)::date = a.date and coalesce(part, '') not in ('full', 'pm') then
    early := greatest(0, ops.att_mins(co, s.t_end));
  end if;
  if a.clock_in is not null and a.clock_out is not null then
    worked := floor(extract(epoch from (a.clock_out - a.clock_in)) / 60)::int;
    if a.lunch_out is not null and a.lunch_in is not null then
      worked := worked - floor(extract(epoch from (a.lunch_in - a.lunch_out)) / 60)::int;
    elsif s.has_lunch and worked >= 300 then
      worked := worked - allowed;   -- 没打午休卡：扣标准午休长度
    end if;
  end if;
  return jsonb_build_object(
    'workday', s.workday, 'holiday', s.holiday,
    'start', to_char(s.t_start, 'HH24:MI'), 'end', to_char(s.t_end, 'HH24:MI'),
    'lunch_min', case when s.has_lunch then allowed end,
    'late_min', late, 'lunch_late_min', lunch_late, 'early_min', early, 'worked_min', worked,
    'leave', lv,
    'missing_out', a.clock_in is not null and a.clock_out is null and a.date < ops.today());
end $$;

-- 月统计：加请假天数；整天请假不算缺勤
create or replace function public.ops_att_month(p_ym text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  first date;
  last date;
begin
  me := ops.require_level('attendance', 'view');
  if coalesce(p_ym, '') !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
    raise exception '月份格式要是 YYYY-MM。' using errcode = '22023';
  end if;
  first := to_date(p_ym || '-01', 'YYYY-MM-DD');
  last := least((first + interval '1 month - 1 day')::date, ops.today());
  return (
    select coalesce(jsonb_agg(to_jsonb(m) order by m.dept_sort, m.name) , '[]'::jsonb)
    from (
      select s.id as staff_id, s.name, dp.name as department_name, dp.sort as dept_sort, s.branch,
             count(*) filter (where (x.st->>'workday')::boolean) as workdays,
             count(*) filter (where x.present) as present,
             count(*) filter (where (x.st->>'workday')::boolean and not x.present and x.d < ops.today()
                              and coalesce(x.st->'leave'->>'part', '') <> 'full') as absent,
             coalesce(sum(case when (x.st->>'workday')::boolean and x.st->'leave' is not null and x.st->'leave' <> 'null'::jsonb
                               then case x.st->'leave'->>'part' when 'full' then 1 else 0.5 end end), 0) as leave_days,
             count(*) filter (where (x.st->>'late_min')::int > 0) as late_days,
             coalesce(sum((x.st->>'late_min')::int), 0) as late_min,
             count(*) filter (where (x.st->>'lunch_late_min')::int > 0) as lunch_late_days,
             coalesce(sum((x.st->>'lunch_late_min')::int), 0) as lunch_late_min,
             count(*) filter (where (x.st->>'early_min')::int > 0) as early_days,
             count(*) filter (where (x.st->>'missing_out')::boolean) as missing_out,
             coalesce(sum((x.st->>'worked_min')::int), 0) as worked_min
      from ops.staff s
      join ops.department dp on dp.code = s.department
      cross join lateral (
        select g.d::date as d, a.id is not null and a.clock_in is not null as present,
               ops.att_stats(s, case when a.id is null then ops.att_blank(s.id, g.d::date) else a end) as st
        from generate_series(greatest(first, coalesce(s.join_date, s.created_at::date)), last, interval '1 day') g(d)
        left join ops.attendance a on a.staff_id = s.id and a.date = g.d::date) x
      where s.active and ops.att_can_see(me, s)
      group by s.id, s.name, dp.name, dp.sort, s.branch) m
  );
end $$;

-- 员工设定加性别（产假 / 陪产假用）
create or replace function public.ops_att_staff_set(p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  t ops.staff;
  mgr bigint := nullif(p->>'manager_id', '')::bigint;
begin
  me := ops.require_level('hr', 'edit');
  select * into t from ops.staff where id = (p->>'id')::bigint;
  if t.id is null or not ops.sees_branch(me, t.branch) then
    raise exception '找不到这位员工。' using errcode = 'P0002';
  end if;
  if mgr = t.id then
    raise exception '直属主管不能是自己。' using errcode = '22023';
  end if;
  if mgr is not null and not exists (select 1 from ops.staff s where s.id = mgr and s.active) then
    raise exception '指派的员工不存在或已停用。' using errcode = '22023';
  end if;
  if not exists (select 1 from ops.hr_shift h where h.code = coalesce(p->>'shift', t.shift)) then
    raise exception '没有这个班别。' using errcode = '22023';
  end if;
  if coalesce(p->>'gender', '') not in ('', 'M', 'F') then
    raise exception '性别只能是男或女。' using errcode = '22023';
  end if;
  update ops.staff set manager_id = mgr, shift = coalesce(p->>'shift', shift),
    geofence_exempt = coalesce((p->>'geofence_exempt')::boolean, geofence_exempt),
    friday_prayer = coalesce((p->>'friday_prayer')::boolean, friday_prayer),
    join_date = case when p ? 'join_date' then nullif(p->>'join_date', '')::date else join_date end,
    gender = case when p ? 'gender' then nullif(p->>'gender', '') else gender end,
    updated_at = now()
  where id = t.id;
  perform ops.log(me.id, 'att_settings', 'staff', t.id, p);
end $$;

create or replace function public.ops_att_settings() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
begin
  me := ops.require_level('hr', 'edit');
  return jsonb_build_object(
    'shifts', (select coalesce(jsonb_agg(to_jsonb(h) || jsonb_build_object(
                 'start_time', to_char(h.start_time, 'HH24:MI'), 'lunch_start', to_char(h.lunch_start, 'HH24:MI'),
                 'lunch_end', to_char(h.lunch_end, 'HH24:MI'), 'end_time', to_char(h.end_time, 'HH24:MI'),
                 'sat_end', to_char(h.sat_end, 'HH24:MI')) order by h.sort), '[]'::jsonb) from ops.hr_shift h),
    'fences', (select coalesce(jsonb_agg(to_jsonb(g) order by g.branch, g.id), '[]'::jsonb)
               from ops.geofence g where ops.sees_branch(me, g.branch)),
    'holidays', (select coalesce(jsonb_agg(to_jsonb(h) order by h.date), '[]'::jsonb)
                 from ops.holiday h where h.date >= date_trunc('year', ops.today()) - interval '1 year'),
    'saturdays', (select coalesce(jsonb_agg(jsonb_build_object('ym', m.ym, 'date', ops.designated_saturday(m.ym),
                                                               'custom', exists (select 1 from ops.work_saturday w where w.ym = m.ym))
                                            order by m.ym), '[]'::jsonb)
                  from (select to_char(ops.today() + make_interval(months => i), 'YYYY-MM') as ym
                        from generate_series(-1, 10) i) m),
    'staff', (select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'department', s.department,
                                                           'department_name', d.name, 'branch', s.branch, 'role', s.role,
                                                           'manager_id', s.manager_id, 'shift', s.shift,
                                                           'geofence_exempt', s.geofence_exempt,
                                                           'friday_prayer', s.friday_prayer, 'join_date', s.join_date,
                                                           'gender', s.gender)
                                        order by d.sort, s.name), '[]'::jsonb)
              from ops.staff s join ops.department d on d.code = s.department
              where s.active and ops.sees_branch(me, s.branch))
  );
end $$;

-- 首页：HR 待审请假、我审核中的假单
create or replace function public.ops_home() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  rec ops.attendance;
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
    'po_overdue', case when ops.level_rank(ops.module_level(me, 'purchasing')) >= 2 then
                    (select count(*) from ops.v_po_open v where ops.sees_company(me, v.company)
                     and v.status <> 'closed' and v.days_late > 0
                     and (v.days_open <= 120 or v.status <> 'ordered' or v.po_eta is not null or v.shipment_id is not null))
                  end,
    'att', case when ops.level_rank(ops.module_level(me, 'attendance')) >= 2 then jsonb_build_object(
             'clock_in', rec.clock_in, 'clock_out', rec.clock_out, 'lunch_in', rec.lunch_in,
             'workday', (select s.workday from ops.att_schedule(me, ops.today()) s),
             'leave', ops.leave_on(me.id, ops.today()),
             'open_shift', exists (select 1 from ops.attendance a where a.staff_id = me.id and a.date < ops.today()
                                   and a.clock_in is not null and a.clock_out is null)) end,
    'corrections_waiting', (select count(*) from ops.punch_correction c
                            where c.status in ('pending_hod', 'pending_hr') and ops.att_can_decide(me, c)),
    'leave_waiting', (select count(*) from ops.leave_request r where r.status = 'pending' and ops.leave_can_decide(me, r)),
    'my_pending_leave', (select count(*) from ops.leave_request r where r.staff_id = me.id and r.status = 'pending')
  );
end $$;

-- ------------------------------------------------------------ 权限
do $$
declare
  f text;
begin
  foreach f in array array[
    'ops_leave_home(int)', 'ops_leave_preview(jsonb)', 'ops_leave_apply(jsonb)', 'ops_leave_cancel(bigint,text)',
    'ops_leave_list(jsonb)', 'ops_leave_decide(bigint,text,text)', 'ops_leave_balances(int)', 'ops_leave_adjust(jsonb)',
    'ops_leave_types()', 'ops_leave_type_save(jsonb)', 'ops_att_month(text)', 'ops_att_staff_set(jsonb)',
    'ops_att_settings()', 'ops_home()'
  ] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

revoke all on all functions in schema ops from public, anon, authenticated;
revoke all on all tables in schema ops from public, anon, authenticated;
