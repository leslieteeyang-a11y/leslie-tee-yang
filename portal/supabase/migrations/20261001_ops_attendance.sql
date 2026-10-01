-- HomeWorks 营运系统 — 打卡 + 补卡（移植自 AttendX 的打卡规则，改成 ops schema + Supabase Auth）
-- 已套用到 Supabase 专案 vwljnypzgfqhatkgulqs（migration 名称 ops_attendance）。改动请另开新 migration。
--
-- 规则（来源：AttendX docs/FEATURES-AND-RULES.md §2、§3，数字改成资料表可调）：
--   * 打卡 = 自拍 + GPS。上班卡要在自己分店的任一打卡点（地理围栏）半径内；免围栏的员工（业务、司机）不检查，
--     但照样记 GPS。分店还没设打卡点 = 不检查（HR 要记得设）。
--   * 一人一天一笔。只有「上班」「下班」两个按钮：
--       上班 → 下班（出去吃饭）→ 上班（吃饭回来，自动记成午休）→ 下班。
--     第二次按上班时，前一个下班卡若在 11:00–15:00 且是周一到周五，就当成午休；否则当成加班再进（清掉下班卡）。
--   * 之前有一天只打上班没打下班 → 今天不能打上班卡，要先「补下班卡」：立刻写入、同时送主管审核，驳回就还原。
--   * 补卡：主管（staff.manager_id；没设就是同部门、可审批打卡的主管）→ HR 两段；HR 可以直接批。不能批自己的。
--     员工只能补 14 天内；HR 不受限。
--   * 迟到：上班卡超过班别开始时间的分钟数（秒数不算，08:30:59 不算迟到）；午休回来同理。
--   * 时间一律马来西亚时间（Asia/Kuala_Lumpur）。
-- 照片放 Storage 私有 bucket ops-hr，路径 <staff_id>/<yyyy-mm-dd>/<种类>-<时间>.jpg；读写权限由 public.ops_hr_file_ok() 判断。

-- ------------------------------------------------------------ 时间工具
create or replace function ops.now() returns timestamptz
language sql stable set search_path = '' as $$
  -- 本机测试才能用 ops.fake_now 改「现在」：正式库没有 ops_test_marker schema，设定会被忽略
  select case when exists (select 1 from pg_catalog.pg_namespace where nspname = 'ops_test_marker')
              then coalesce(nullif(current_setting('ops.fake_now', true), '')::timestamptz, now())
              else now() end
$$;

create or replace function ops.kl(p timestamptz) returns timestamp
language sql immutable set search_path = '' as $$ select p at time zone 'Asia/Kuala_Lumpur' $$;

create or replace function ops.today() returns date
language sql stable set search_path = '' as $$ select (ops.now() at time zone 'Asia/Kuala_Lumpur')::date $$;

-- 某天某时（马来西亚时间）→ timestamptz
create or replace function ops.kl_at(p_date date, p_time time) returns timestamptz
language sql immutable set search_path = '' as $$ select (p_date + p_time) at time zone 'Asia/Kuala_Lumpur' $$;

create or replace function ops.distance_m(lat1 double precision, lng1 double precision,
                                          lat2 double precision, lng2 double precision) returns double precision
language sql immutable set search_path = '' as $$
  select 6371000 * 2 * asin(sqrt(
    power(sin(radians(lat2 - lat1) / 2), 2)
    + cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2)))
$$;

-- ------------------------------------------------------------ 设定资料
create table ops.hr_shift (
  code text primary key check (code ~ '^[a-z0-9_]{2,20}$'),
  name text not null,
  start_time time not null,
  lunch_start time not null,
  lunch_end time not null,
  end_time time not null,
  sat_end time not null,
  -- every = 每个星期六都上半天；designated = 每月指定一个星期六；none = 星期六不上班
  sat_rule text not null check (sat_rule in ('every', 'designated', 'none')),
  sort int not null default 0,
  check (start_time < lunch_start and lunch_start < lunch_end and lunch_end < end_time and start_time < sat_end)
);
-- 预设值沿用 AttendX，请 HR 在「打卡设定」改成 HomeWorks 实际的上下班时间
insert into ops.hr_shift (code, name, start_time, lunch_start, lunch_end, end_time, sat_end, sat_rule, sort) values
  ('office',    '办公室 / 门市', '08:30', '12:30', '13:30', '17:45', '12:30', 'designated', 10),
  ('warehouse', '仓库',          '08:30', '12:30', '13:30', '17:30', '12:30', 'every',      20);

alter table ops.staff
  add column manager_id bigint references ops.staff(id) on delete set null,
  add column shift text not null default 'office' references ops.hr_shift(code),
  add column geofence_exempt boolean not null default false,
  add column friday_prayer boolean not null default false,   -- 星期五午休到 14:30（回教男性员工）
  add column join_date date;
update ops.staff set shift = 'warehouse' where department in ('warehouse', 'delivery');
update ops.staff set geofence_exempt = true where department in ('delivery');

create table ops.holiday (
  date date not null,
  branch text not null default 'ALL' check (branch in ('ALL', 'HOMEWORKSSB', 'HOMEWORKSSOUTHERN')),
  name text not null check (length(trim(name)) > 0),
  primary key (date, branch)
);

-- 每月指定上班的星期六（没设 = 当月第一个星期六）
create table ops.work_saturday (
  ym text primary key check (ym ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  date date not null check (to_char(date, 'YYYY-MM') = ym and extract(isodow from date) = 6)
);

create table ops.geofence (
  id bigint generated always as identity primary key,
  branch text not null check (branch in ('HOMEWORKSSB', 'HOMEWORKSSOUTHERN')),
  name text not null check (length(trim(name)) > 0),
  lat double precision not null check (lat between -90 and 90),
  lng double precision not null check (lng between -180 and 180),
  radius int not null default 150 check (radius between 20 and 5000),
  active boolean not null default true,
  updated_by bigint references ops.staff(id),
  updated_at timestamptz not null default now()
);

-- ------------------------------------------------------------ 打卡纪录
create table ops.attendance (
  id bigint generated always as identity primary key,
  staff_id bigint not null references ops.staff(id) on delete cascade,
  date date not null,
  clock_in timestamptz,
  lunch_out timestamptz,
  lunch_in timestamptz,
  clock_out timestamptz,
  in_lat double precision,
  in_lng double precision,
  in_place text not null default '',
  out_lat double precision,
  out_lng double precision,
  selfie_in text,
  selfie_lunch_out text,
  selfie_lunch_in text,
  selfie_out text,
  source text not null default 'app' check (source in ('app', 'correction')),
  updated_at timestamptz not null default now(),
  unique (staff_id, date),
  check (clock_out is null or clock_in is null or clock_out >= clock_in),
  check (lunch_out is null or clock_in is null or lunch_out >= clock_in),
  check (lunch_in is null or lunch_out is null or lunch_in >= lunch_out)
);

create table ops.field_checkin (
  id bigint generated always as identity primary key,
  staff_id bigint not null references ops.staff(id) on delete cascade,
  at timestamptz not null default now(),
  date date not null,
  lat double precision not null,
  lng double precision not null,
  purpose text not null default '' check (length(purpose) <= 280),
  selfie text not null
);
create index field_checkin_date_idx on ops.field_checkin (date);

create table ops.punch_correction (
  id bigint generated always as identity primary key,
  staff_id bigint not null references ops.staff(id) on delete cascade,
  date date not null,
  kind text not null default 'punch' check (kind in ('punch', 'offsite')),
  punch text check (punch in ('clock_in', 'lunch_out', 'lunch_in', 'clock_out')),
  time time,
  reason text not null check (length(trim(reason)) >= 5),
  attachment text,
  self_closed boolean not null default false,   -- 自己补的下班卡：已先写入，驳回会还原
  original timestamptz,                         -- 改之前记录的时间（显示给审核的人看）
  status text not null default 'pending_hod'
    check (status in ('pending_hod', 'pending_hr', 'approved', 'rejected', 'cancelled')),
  hod_by bigint references ops.staff(id),
  hod_at timestamptz,
  decided_by bigint references ops.staff(id),
  decided_at timestamptz,
  decision_note text not null default '',
  created_by bigint not null references ops.staff(id),
  created_at timestamptz not null default now(),
  check ((kind = 'punch') = (punch is not null and time is not null))
);
create index punch_correction_status_idx on ops.punch_correction (status) where status in ('pending_hod', 'pending_hr');
create unique index punch_correction_one_pending on ops.punch_correction (staff_id, date, coalesce(punch, kind))
  where status in ('pending_hod', 'pending_hr');

alter table ops.hr_shift enable row level security;
alter table ops.holiday enable row level security;
alter table ops.work_saturday enable row level security;
alter table ops.geofence enable row level security;
alter table ops.attendance enable row level security;
alter table ops.field_checkin enable row level security;
alter table ops.punch_correction enable row level security;

-- ------------------------------------------------------------ 模块与预设权限
insert into ops.module (key, name, phase, ready, sort, description) values
  ('attendance', '打卡', 5, true, 95, '自拍 + GPS 打卡、补卡、出勤纪录');
update ops.module set description = '员工档案、请假、打卡设定' where key = 'hr';
-- 每个人都要打卡：所有部门「可编辑」（= 打自己的卡、补卡）；主管自动升「可审批」= 批自己部门的补卡
insert into ops.dept_module (department, module, level)
select code, 'attendance', case code when 'mgmt' then 'approve' else 'edit' end from ops.department
on conflict (department, module) do nothing;

-- ------------------------------------------------------------ 权限判断（一律 coalesce(..., false)）
create or replace function ops.att_branch(p_staff ops.staff) returns text
language sql stable set search_path = '' as $$
  select case when p_staff.branch = 'ALL' then 'HOMEWORKSSB' else p_staff.branch end
$$;

create or replace function ops.att_is_hr(p_me ops.staff) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(ops.level_rank(ops.module_level(p_me, 'hr')) >= 2, false)
$$;

-- 看得到某员工的打卡：自己；HR（同分店）；可审批打卡的主管看自己部门 / 直属下属；管理层主管看全分店
create or replace function ops.att_can_see(p_me ops.staff, p_target ops.staff) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(
    p_me.id = p_target.id
    or (ops.sees_branch(p_me, p_target.branch) and (
          ops.att_is_hr(p_me)
          or p_target.manager_id = p_me.id
          or (ops.level_rank(ops.module_level(p_me, 'attendance')) >= 3
              and (p_me.department = p_target.department or p_me.department = 'mgmt')))),
    false)
$$;

-- 第一段审核人：有设直属主管就只有他；没设就是同部门（或管理层）可审批打卡的主管
create or replace function ops.att_is_hod(p_me ops.staff, p_target ops.staff) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(
    p_me.id <> p_target.id and ops.sees_branch(p_me, p_target.branch) and (
      p_target.manager_id = p_me.id
      or (p_target.manager_id is null
          and ops.level_rank(ops.module_level(p_me, 'attendance')) >= 3
          and (p_me.department = p_target.department or p_me.department = 'mgmt'))),
    false)
$$;

create or replace function ops.att_can_decide(p_me ops.staff, p_c ops.punch_correction) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  t ops.staff;
begin
  if p_c.status not in ('pending_hod', 'pending_hr') or p_c.staff_id = p_me.id then
    return false;
  end if;
  select * into t from ops.staff where id = p_c.staff_id;
  if t.id is null or not ops.sees_branch(p_me, t.branch) then
    return false;
  end if;
  if ops.att_is_hr(p_me) then
    return true;                                            -- HR 两段都可以批（批了就定案）
  end if;
  return coalesce(p_c.status = 'pending_hod' and ops.att_is_hod(p_me, t), false);
end $$;

-- Storage 读写判断（ops-hr bucket 的 policy 呼叫）：写只能写自己的资料夹；读要看得到那位员工
create or replace function public.ops_hr_file_ok(p_name text, p_write boolean) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  t ops.staff;
  owner_txt text := split_part(coalesce(p_name, ''), '/', 1);
begin
  me := ops.current_staff();
  if me.id is null or owner_txt !~ '^[0-9]{1,18}$' then
    return false;
  end if;
  if p_write then
    return owner_txt::bigint = me.id;
  end if;
  select * into t from ops.staff where id = owner_txt::bigint;
  return t.id is not null and ops.att_can_see(me, t);
end $$;

-- ------------------------------------------------------------ 班表与迟到计算
create or replace function ops.designated_saturday(p_ym text) returns date
language sql stable set search_path = '' as $$
  select coalesce(
    (select w.date from ops.work_saturday w where w.ym = p_ym),
    (select d from (select to_date(p_ym || '-01', 'YYYY-MM-DD') as f) x,
            lateral (select x.f + ((6 - extract(isodow from x.f)::int + 7) % 7) as d) y))
$$;

create or replace function ops.att_schedule(p_staff ops.staff, p_date date,
  out workday boolean, out holiday text, out t_start time, out t_lunch_out time, out t_lunch_in time,
  out t_end time, out has_lunch boolean)
language plpgsql stable set search_path = '' as $$
declare
  sh ops.hr_shift;
  dow int := extract(isodow from p_date);
begin
  select * into sh from ops.hr_shift where code = p_staff.shift;
  if sh.code is null then
    select * into sh from ops.hr_shift order by sort limit 1;
  end if;
  select h.name into holiday from ops.holiday h
  where h.date = p_date and h.branch in ('ALL', ops.att_branch(p_staff)) limit 1;
  t_start := sh.start_time;
  t_lunch_out := sh.lunch_start;
  t_lunch_in := sh.lunch_end + case when dow = 5 and p_staff.friday_prayer then interval '1 hour' else interval '0' end;
  t_end := sh.end_time;
  has_lunch := dow between 1 and 5;
  if dow = 6 then
    t_end := sh.sat_end;
  end if;
  workday := holiday is null and case
    when dow = 7 then false
    when dow = 6 then case sh.sat_rule when 'every' then true when 'none' then false
                                     else p_date = ops.designated_saturday(to_char(p_date, 'YYYY-MM')) end
    else true end;
end $$;

create or replace function ops.att_mins(p_from time, p_to time) returns int
language sql immutable set search_path = '' as $$
  select floor(extract(epoch from (p_to - p_from)) / 60)::int
$$;

-- 某天的出勤统计：迟到 / 午休迟回 / 早退分钟、工作分钟、漏打下班卡
create or replace function ops.att_stats(p_staff ops.staff, a ops.attendance)
returns jsonb language plpgsql stable set search_path = '' as $$
declare
  s record;
  ci time; lo time; li time; co time;
  late int := 0; lunch_late int := 0; early int := 0; worked int := null;
begin
  select * into s from ops.att_schedule(p_staff, a.date);
  ci := date_trunc('minute', ops.kl(a.clock_in))::time;
  lo := ops.kl(a.lunch_out)::time;
  li := date_trunc('minute', ops.kl(a.lunch_in))::time;
  co := ops.kl(a.clock_out)::time;
  if s.workday and ci is not null then
    late := greatest(0, ops.att_mins(s.t_start, ci));
  end if;
  if s.workday and s.has_lunch and li is not null then
    lunch_late := greatest(0, ops.att_mins(s.t_lunch_in, li));
  end if;
  if s.workday and co is not null and ops.kl(a.clock_out)::date = a.date then
    early := greatest(0, ops.att_mins(co, s.t_end));
  end if;
  if a.clock_in is not null and a.clock_out is not null then
    worked := floor(extract(epoch from (a.clock_out - a.clock_in)) / 60)::int;
    if a.lunch_out is not null and a.lunch_in is not null then
      worked := worked - floor(extract(epoch from (a.lunch_in - a.lunch_out)) / 60)::int;
    elsif s.has_lunch and ops.kl(a.clock_in)::time <= s.t_lunch_out and co >= s.t_lunch_in then
      worked := worked - ops.att_mins(s.t_lunch_out, s.t_lunch_in);   -- 没打午休卡：扣标准午休
    end if;
  end if;
  return jsonb_build_object(
    'workday', s.workday, 'holiday', s.holiday,
    'start', to_char(s.t_start, 'HH24:MI'), 'end', to_char(s.t_end, 'HH24:MI'),
    'lunch_in_due', case when s.has_lunch then to_char(s.t_lunch_in, 'HH24:MI') end,
    'late_min', late, 'lunch_late_min', lunch_late, 'early_min', early, 'worked_min', worked,
    'missing_out', a.clock_in is not null and a.clock_out is null and a.date < ops.today());
end $$;

create or replace function ops.att_json(p_staff ops.staff, a ops.attendance) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'date', a.date, 'clock_in', a.clock_in, 'lunch_out', a.lunch_out, 'lunch_in', a.lunch_in, 'clock_out', a.clock_out,
    'in_place', a.in_place, 'in_lat', a.in_lat, 'in_lng', a.in_lng, 'out_lat', a.out_lat, 'out_lng', a.out_lng,
    'selfie_in', a.selfie_in, 'selfie_lunch_out', a.selfie_lunch_out, 'selfie_lunch_in', a.selfie_lunch_in,
    'selfie_out', a.selfie_out, 'source', a.source) || ops.att_stats(p_staff, a)
$$;

-- 某天没有打卡纪录时用的空白列
create or replace function ops.att_blank(p_staff bigint, p_date date) returns ops.attendance
language sql immutable set search_path = '' as $$
  select row(null, p_staff, p_date, null, null, null, null, null, null, '', null, null, null, null, null, null,
             'app', null)::ops.attendance
$$;

-- 一天一列（有纪录就是纪录 + 统计；没有就只有日期 + 统计）
create or replace function ops.att_row(p_staff ops.staff, p_date date, a ops.attendance) returns jsonb
language sql stable set search_path = '' as $$
  select case when a.id is null then jsonb_build_object('date', p_date) || ops.att_stats(p_staff, ops.att_blank(p_staff.id, p_date))
              else ops.att_json(p_staff, a) end
$$;

create or replace function ops.correction_json(c ops.punch_correction) returns jsonb
language sql stable set search_path = '' as $$
  select to_jsonb(c) || jsonb_build_object(
    'staff_name', (select s.name from ops.staff s where s.id = c.staff_id),
    'department_name', (select d.name from ops.staff s join ops.department d on d.code = s.department where s.id = c.staff_id),
    'hod_name', (select s.name from ops.staff s where s.id = c.hod_by),
    'decided_by_name', (select s.name from ops.staff s where s.id = c.decided_by),
    'time', to_char(c.time, 'HH24:MI'),
    'recorded', (select jsonb_build_object('clock_in', a.clock_in, 'lunch_out', a.lunch_out,
                                           'lunch_in', a.lunch_in, 'clock_out', a.clock_out)
                 from ops.attendance a where a.staff_id = c.staff_id and a.date = c.date))
$$;

-- 自拍 / 附件路径：一定要是自己资料夹里、真的已上传的档
create or replace function ops.att_check_file(p_me ops.staff, p_path text, p_required boolean) returns text
language plpgsql stable security definer set search_path = '' as $$
begin
  if coalesce(p_path, '') = '' then
    if p_required then
      raise exception '请先拍照。' using errcode = '22023';
    end if;
    return null;
  end if;
  if split_part(p_path, '/', 1) <> p_me.id::text
     or not exists (select 1 from storage.objects o where o.bucket_id = 'ops-hr' and o.name = p_path) then
    raise exception '照片没有上传成功，请再拍一次。' using errcode = '22023';
  end if;
  return p_path;
end $$;

-- ------------------------------------------------------------ 我的打卡
create or replace function public.ops_att_today() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  td date;
  rec ops.attendance;
begin
  me := ops.require_level('attendance', 'view');
  td := ops.today();
  select * into rec from ops.attendance where staff_id = me.id and date = td;
  return jsonb_build_object(
    'now', ops.now(), 'today', td,
    'shift', (select jsonb_build_object('code', h.code, 'name', h.name) from ops.hr_shift h where h.code = me.shift),
    'schedule', ops.att_row(me, td, rec),
    'geofence_exempt', me.geofence_exempt,
    'fences', (select coalesce(jsonb_agg(jsonb_build_object('name', g.name, 'lat', g.lat, 'lng', g.lng, 'radius', g.radius)
                                         order by g.id), '[]'::jsonb)
               from ops.geofence g where g.active and (me.branch = 'ALL' or g.branch = me.branch)),
    'record', case when rec.id is null then null else ops.att_json(me, rec) end,
    'open_shift', (select min(a.date) from ops.attendance a where a.staff_id = me.id and a.date < td
                   and a.clock_in is not null and a.clock_out is null),
    'checkins', (select coalesce(jsonb_agg(jsonb_build_object('id', f.id, 'at', f.at, 'lat', f.lat, 'lng', f.lng,
                                                              'purpose', f.purpose, 'selfie', f.selfie) order by f.at), '[]'::jsonb)
                 from ops.field_checkin f where f.staff_id = me.id and f.date = td),
    'pending_corrections', (select count(*) from ops.punch_correction c where c.staff_id = me.id
                            and c.status in ('pending_hod', 'pending_hr'))
  );
end $$;

-- p: {action: 'in' | 'out', lat, lng, selfie}
create or replace function public.ops_att_punch(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  td date;
  ts timestamptz;
  act text := p->>'action';
  v_lat double precision := nullif(p->>'lat', '')::double precision;
  v_lng double precision := nullif(p->>'lng', '')::double precision;
  selfie text;
  rec ops.attendance;
  open_day date;
  place text := '';
  best record;
  co_local timestamp;
begin
  me := ops.require_level('attendance', 'edit');
  if act not in ('in', 'out') then
    raise exception '未知的动作：%', act using errcode = '22023';
  end if;
  if (v_lat is null) <> (v_lng is null) or v_lat not between -90 and 90 or v_lng not between -180 and 180 then
    v_lat := null; v_lng := null;
  end if;
  selfie := ops.att_check_file(me, p->>'selfie', true);
  ts := ops.now();
  td := ops.today();
  select * into rec from ops.attendance where staff_id = me.id and date = td for update;

  if act = 'out' then
    if rec.id is null or rec.clock_in is null then
      raise exception '你今天还没打上班卡。' using errcode = '22023';
    end if;
    if rec.clock_out is not null then
      raise exception '今天已经打过下班卡了。' using errcode = '22023';
    end if;
    update ops.attendance set clock_out = ts, out_lat = v_lat, out_lng = v_lng, selfie_out = selfie, updated_at = now()
    where id = rec.id;
    return public.ops_att_today();
  end if;

  -- ---- 上班卡：先检查打卡范围
  if me.geofence_exempt then
    place := '免打卡范围';
  elsif exists (select 1 from ops.geofence g where g.active and (me.branch = 'ALL' or g.branch = me.branch)) then
    if v_lat is null then
      raise exception '读不到你的位置。请打开手机定位并允许这个网页使用位置，再打一次。' using errcode = '22023';
    end if;
    select g.name, g.radius, ops.distance_m(v_lat, v_lng, g.lat, g.lng) as dist into best
    from ops.geofence g where g.active and (me.branch = 'ALL' or g.branch = me.branch)
    order by ops.distance_m(v_lat, v_lng, g.lat, g.lng) - g.radius limit 1;
    if best.dist > best.radius then
      raise exception '你不在打卡范围内：离「%」% 公尺（要在 % 公尺内）。', best.name, round(best.dist), best.radius
        using errcode = '22023';
    end if;
    place := best.name;
  end if;

  -- 之前有没打下班卡的日子 → 先补
  select min(a.date) into open_day from ops.attendance a
  where a.staff_id = me.id and a.date < td and a.clock_in is not null and a.clock_out is null;
  if open_day is not null then
    raise exception '你 % 没有打下班卡。请先在下方「补下班卡」填写当天的下班时间，才能打今天的卡。', open_day
      using errcode = '22023';
  end if;

  if rec.id is null then
    insert into ops.attendance (staff_id, date, clock_in, in_lat, in_lng, in_place, selfie_in)
    values (me.id, td, ts, v_lat, v_lng, place, selfie);
  elsif rec.clock_in is null then
    update ops.attendance set clock_in = ts, in_lat = v_lat, in_lng = v_lng, in_place = place, selfie_in = selfie,
                              source = 'app', updated_at = now()
    where id = rec.id;
  elsif rec.clock_out is null then
    raise exception '今天已经打过上班卡了。' using errcode = '22023';
  else
    co_local := ops.kl(rec.clock_out);
    if rec.lunch_out is null and extract(isodow from co_local) between 1 and 5
       and co_local::time >= time '11:00' and co_local::time < time '15:00' then
      -- 吃饭回来：刚才的下班卡变成午休开始
      update ops.attendance set lunch_out = rec.clock_out, selfie_lunch_out = rec.selfie_out,
                                lunch_in = ts, selfie_lunch_in = selfie,
                                clock_out = null, selfie_out = null, out_lat = null, out_lng = null, updated_at = now()
      where id = rec.id;
    else
      -- 下班后又回来（加班）：清掉下班卡，等一下再打一次
      update ops.attendance set clock_out = null, selfie_out = null, out_lat = null, out_lng = null, updated_at = now()
      where id = rec.id;
    end if;
  end if;
  return public.ops_att_today();
end $$;

-- 补下班卡（之前某天忘了打）：立刻写入，同时送主管审核
-- p: {date, time: 'HH:MM', reason}
create or replace function public.ops_att_self_close(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  d date := nullif(p->>'date', '')::date;
  t time := nullif(p->>'time', '')::time;
  rsn text := trim(coalesce(p->>'reason', ''));
  rec ops.attendance;
  ts timestamptz;
  cid bigint;
begin
  me := ops.require_level('attendance', 'edit');
  if d is null or t is null then
    raise exception '请填日期和下班时间。' using errcode = '22023';
  end if;
  if d >= ops.today() then
    raise exception '只能补今天以前的下班卡。' using errcode = '22023';
  end if;
  if length(rsn) < 5 then
    raise exception '请写原因（至少 5 个字）。' using errcode = '22023';
  end if;
  select * into rec from ops.attendance where staff_id = me.id and date = d for update;
  if rec.id is null or rec.clock_in is null then
    raise exception '那天没有上班卡纪录。' using errcode = '22023';
  end if;
  if rec.clock_out is not null then
    raise exception '那天已经有下班卡了。' using errcode = '22023';
  end if;
  ts := ops.kl_at(d, t);
  if ts <= coalesce(rec.lunch_in, rec.lunch_out, rec.clock_in) then
    raise exception '下班时间要晚于当天最后一次打卡（%）。',
      to_char(ops.kl(coalesce(rec.lunch_in, rec.lunch_out, rec.clock_in)), 'HH24:MI') using errcode = '22023';
  end if;
  update ops.attendance set clock_out = ts, updated_at = now() where id = rec.id;
  insert into ops.punch_correction (staff_id, date, kind, punch, time, reason, self_closed, created_by)
  values (me.id, d, 'punch', 'clock_out', t, rsn, true, me.id)
  returning id into cid;
  perform ops.log(me.id, 'self_close', 'punch_correction', cid, jsonb_build_object('date', d, 'time', t));
  return public.ops_att_today();
end $$;

-- 外勤签到（业务、送货在客户那里）：自拍 + GPS，不检查范围
create or replace function public.ops_att_field_checkin(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  v_lat double precision := nullif(p->>'lat', '')::double precision;
  v_lng double precision := nullif(p->>'lng', '')::double precision;
begin
  me := ops.require_level('attendance', 'edit');
  if v_lat is null or v_lng is null or v_lat not between -90 and 90 or v_lng not between -180 and 180 then
    raise exception '读不到你的位置。请打开手机定位并允许这个网页使用位置，再签到一次。' using errcode = '22023';
  end if;
  insert into ops.field_checkin (staff_id, date, at, lat, lng, purpose, selfie)
  values (me.id, ops.today(), ops.now(), v_lat, v_lng, left(trim(coalesce(p->>'purpose', '')), 280),
          ops.att_check_file(me, p->>'selfie', true));
  return public.ops_att_today();
end $$;

-- ------------------------------------------------------------ 出勤纪录（自己 / 团队）
-- 某员工某月逐日（p_staff_id 空 = 自己）
create or replace function public.ops_att_days(p_ym text, p_staff_id bigint default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  t ops.staff;
  first date;
  last date;
begin
  me := ops.require_level('attendance', 'view');
  if coalesce(p_ym, '') !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
    raise exception '月份格式要是 YYYY-MM。' using errcode = '22023';
  end if;
  select * into t from ops.staff where id = coalesce(p_staff_id, me.id);
  if t.id is null or not ops.att_can_see(me, t) then
    raise exception '找不到这位员工，或你没有权限看。' using errcode = 'P0002';
  end if;
  first := to_date(p_ym || '-01', 'YYYY-MM-DD');
  last := least((first + interval '1 month - 1 day')::date, ops.today());
  return jsonb_build_object(
    'staff', jsonb_build_object('id', t.id, 'name', t.name,
                                'shift', (select h.name from ops.hr_shift h where h.code = t.shift)),
    'days', (select coalesce(jsonb_agg(
               ops.att_row(t, g.d::date, a)
               || jsonb_build_object(
                    'checkins', (select count(*) from ops.field_checkin f where f.staff_id = t.id and f.date = g.d),
                    'corrections', (select count(*) from ops.punch_correction c where c.staff_id = t.id and c.date = g.d
                                    and c.status in ('pending_hod', 'pending_hr', 'approved')))
               order by g.d desc), '[]'::jsonb)
             from generate_series(first, last, interval '1 day') g(d)
             left join ops.attendance a on a.staff_id = t.id and a.date = g.d::date
             where g.d::date >= coalesce(t.join_date, t.created_at::date, first)));
end $$;

-- 当天看板：看得到的每位员工今天的状态
create or replace function public.ops_att_board(p_date date default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  d date := coalesce(p_date, ops.today());
begin
  me := ops.require_staff();
  if not ops.att_is_hr(me) and ops.level_rank(ops.module_level(me, 'attendance')) < 3
     and not exists (select 1 from ops.staff s where s.manager_id = me.id) then
    raise exception '你没有「打卡」模块的审批权限，请找管理员开通。' using errcode = '42501';
  end if;
  return jsonb_build_object('date', d, 'rows', (
    select coalesce(jsonb_agg(x.j order by x.dept_sort, x.name), '[]'::jsonb) from (
      select s.name, dp.sort as dept_sort,
             jsonb_build_object('staff_id', s.id, 'name', s.name, 'department_name', dp.name, 'branch', s.branch,
                                'geofence_exempt', s.geofence_exempt,
                                'checkins', (select coalesce(jsonb_agg(jsonb_build_object('at', f.at, 'lat', f.lat,
                                               'lng', f.lng, 'purpose', f.purpose, 'selfie', f.selfie) order by f.at), '[]'::jsonb)
                                             from ops.field_checkin f where f.staff_id = s.id and f.date = d))
             || ops.att_row(s, d, a) as j
      from ops.staff s
      join ops.department dp on dp.code = s.department
      left join ops.attendance a on a.staff_id = s.id and a.date = d
      where s.active and s.id <> me.id and ops.att_can_see(me, s)
        and d >= coalesce(s.join_date, s.created_at::date)) x));
end $$;

-- 月统计：看得到的每位员工（含自己）
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
             count(*) filter (where (x.st->>'workday')::boolean and not x.present and x.d < ops.today()) as absent,
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

-- ------------------------------------------------------------ 补卡
-- 检查补卡时间合不合理（移植 AttendX lib/punchTime.ts）
create or replace function ops.att_check_punch(p_staff ops.staff, p_date date, p_punch text, p_time time,
                                               p_by_hr boolean) returns void
language plpgsql stable security definer set search_path = '' as $$
declare
  rec ops.attendance;
  td date := ops.today();
  lo time; hi time;
  v ops.attendance;
  seq timestamptz[];
  i int;
begin
  if p_date > td then
    raise exception '不能补还没到的日子。' using errcode = '22023';
  end if;
  if not p_by_hr and p_date < td - 14 then
    raise exception '超过 14 天的补卡请找 HR 处理。' using errcode = '22023';
  end if;
  if p_date = td and p_time > ops.kl(ops.now())::time then
    raise exception '这个时间还没到（现在 %）。', to_char(ops.kl(ops.now()), 'HH24:MI') using errcode = '22023';
  end if;
  select case p_punch when 'clock_in' then '05:00' when 'lunch_out' then '10:00' when 'lunch_in' then '10:30' else '11:00' end::time,
         case p_punch when 'clock_in' then '12:00' when 'lunch_out' then '16:00' when 'lunch_in' then '17:00' else '23:59' end::time
    into lo, hi;
  if p_time < lo or p_time > hi then
    raise exception '% 不像是%的时间（应在 % – % 之间）。', to_char(p_time, 'HH24:MI'),
      case p_punch when 'clock_in' then '上班' when 'lunch_out' then '午休开始' when 'lunch_in' then '午休回来' else '下班' end,
      to_char(lo, 'HH24:MI'), to_char(hi, 'HH24:MI') using errcode = '22023';
  end if;
  -- 顺序：上班 ≤ 午休开始 ≤ 午休回来 ≤ 下班
  select * into rec from ops.attendance where staff_id = p_staff.id and date = p_date;
  v := rec;
  case p_punch
    when 'clock_in' then v.clock_in := ops.kl_at(p_date, p_time);
    when 'lunch_out' then v.lunch_out := ops.kl_at(p_date, p_time);
    when 'lunch_in' then v.lunch_in := ops.kl_at(p_date, p_time);
    else v.clock_out := ops.kl_at(p_date, p_time);
  end case;
  seq := array_remove(array[v.clock_in, v.lunch_out, v.lunch_in, v.clock_out], null);
  for i in 2 .. coalesce(array_length(seq, 1), 0) loop
    if seq[i] < seq[i - 1] then
      raise exception '时间顺序不对：要「上班 ≤ 午休开始 ≤ 午休回来 ≤ 下班」，请对照当天已有的打卡。' using errcode = '22023';
    end if;
  end loop;
end $$;

-- 申请补卡。p: {date, kind: 'punch'|'offsite', punch, time, reason, attachment, staff_id(只有 HR 可以替别人申请)}
create or replace function public.ops_att_correction_create(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  t ops.staff;
  d date := nullif(p->>'date', '')::date;
  k text := coalesce(nullif(p->>'kind', ''), 'punch');
  pu text := nullif(p->>'punch', '');
  tm time := nullif(p->>'time', '')::time;
  by_hr boolean;
  c ops.punch_correction;
  rec ops.attendance;
begin
  me := ops.require_level('attendance', 'edit');
  select * into t from ops.staff where id = coalesce(nullif(p->>'staff_id', '')::bigint, me.id);
  by_hr := t.id <> me.id;
  if t.id is null or not t.active or (by_hr and not (ops.att_is_hr(me) and ops.sees_branch(me, t.branch))) then
    raise exception '只有 HR 可以替别人申请补卡。' using errcode = '42501';
  end if;
  by_hr := by_hr or ops.att_is_hr(me);
  if d is null then
    raise exception '请选日期。' using errcode = '22023';
  end if;
  if k = 'punch' then
    if pu is not null and pu not in ('clock_in', 'lunch_out', 'lunch_in', 'clock_out') then
      raise exception '未知的补卡种类：%', pu using errcode = '22023';
    end if;
    if pu is null or tm is null then
      raise exception '请选要补哪一个卡，并填时间。' using errcode = '22023';
    end if;
    perform ops.att_check_punch(t, d, pu, tm, by_hr);
  elsif k = 'offsite' then
    pu := null; tm := null;
    if d > ops.today() then
      raise exception '不能补还没到的日子。' using errcode = '22023';
    end if;
  else
    raise exception '未知的补卡种类：%', k using errcode = '22023';
  end if;
  select * into rec from ops.attendance where staff_id = t.id and date = d;
  begin
    insert into ops.punch_correction (staff_id, date, kind, punch, time, reason, attachment, original, created_by)
    values (t.id, d, k, pu, tm, trim(coalesce(p->>'reason', '')), ops.att_check_file(me, p->>'attachment', false),
            case pu when 'clock_in' then rec.clock_in when 'lunch_out' then rec.lunch_out
                    when 'lunch_in' then rec.lunch_in when 'clock_out' then rec.clock_out end,
            me.id)
    returning * into c;
  exception
    when check_violation then
      raise exception '请写原因（至少 5 个字）。' using errcode = '22023';
    when unique_violation then
      raise exception '这一天的这个卡已经有一张补卡在审核中了。' using errcode = '22023';
  end;
  perform ops.log(me.id, 'create', 'punch_correction', c.id, jsonb_build_object('date', d, 'punch', coalesce(pu, k)));
  return ops.correction_json(c) || jsonb_build_object('can_decide', ops.att_can_decide(me, c));
end $$;

-- p_scope: mine（我的）/ todo（等我审）/ team（看得到的别人的，近 60 天）
create or replace function public.ops_att_corrections(p_scope text default 'mine') returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
begin
  me := ops.require_level('attendance', 'view');
  return (
    select coalesce(jsonb_agg(ops.correction_json(c) || jsonb_build_object('can_decide', ops.att_can_decide(me, c),
                                                       'can_cancel', c.staff_id = me.id and not c.self_closed
                                                                     and c.status in ('pending_hod', 'pending_hr'))
                              order by c.status in ('pending_hod', 'pending_hr') desc, c.date desc, c.id desc), '[]'::jsonb)
    from ops.punch_correction c join ops.staff t on t.id = c.staff_id
    where case coalesce(p_scope, 'mine')
            when 'mine' then c.staff_id = me.id
            when 'todo' then ops.att_can_decide(me, c)
            else c.staff_id <> me.id and c.created_at > ops.now() - interval '60 days' and ops.att_can_see(me, t) end
    limit 300
  );
end $$;

-- 写进打卡纪录（定案时）
create or replace function ops.att_apply(c ops.punch_correction, p_time time) returns void
language plpgsql security definer set search_path = '' as $$
declare
  t ops.staff;
  s record;
  ts timestamptz;
begin
  select * into t from ops.staff where id = c.staff_id;
  if c.kind = 'offsite' then
    select * into s from ops.att_schedule(t, c.date);
    insert into ops.attendance (staff_id, date, source) values (c.staff_id, c.date, 'correction')
    on conflict (staff_id, date) do nothing;
    update ops.attendance set clock_in = ops.kl_at(c.date, s.t_start),
                              lunch_out = case when s.has_lunch then ops.kl_at(c.date, s.t_lunch_out) end,
                              lunch_in = case when s.has_lunch then ops.kl_at(c.date, s.t_lunch_in) end,
                              clock_out = ops.kl_at(c.date, s.t_end), in_place = '外出公务', source = 'correction',
                              updated_at = now()
    where staff_id = c.staff_id and date = c.date;
    return;
  end if;
  ts := ops.kl_at(c.date, p_time);
  insert into ops.attendance (staff_id, date, source) values (c.staff_id, c.date, 'correction')
  on conflict (staff_id, date) do nothing;
  update ops.attendance set
    clock_in = case when c.punch = 'clock_in' then ts else clock_in end,
    lunch_out = case when c.punch = 'lunch_out' then ts else lunch_out end,
    lunch_in = case when c.punch = 'lunch_in' then ts else lunch_in end,
    clock_out = case when c.punch = 'clock_out' then ts else clock_out end,
    in_place = case when c.punch = 'clock_in' then '补卡' else in_place end,
    source = 'correction', updated_at = now()
  where staff_id = c.staff_id and date = c.date;
end $$;

-- p_decision: approve / reject。p_time：HR 定案时可以改成别的时间（HH:MM，可空）
create or replace function public.ops_att_correction_decide(p_id bigint, p_decision text, p_note text default '',
                                                            p_time text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  t ops.staff;
  c ops.punch_correction;
  is_hr boolean;
  final_time time;
begin
  me := ops.require_staff();
  select * into c from ops.punch_correction where id = p_id for update;
  if c.id is null then
    raise exception '找不到这张补卡。' using errcode = 'P0002';
  end if;
  if not ops.att_can_decide(me, c) then
    if c.status not in ('pending_hod', 'pending_hr') then
      raise exception '这张补卡已经处理过了。' using errcode = '22023';
    end if;
    raise exception '你不能审这张补卡（不能审自己的；第一段要直属主管，第二段要 HR）。' using errcode = '42501';
  end if;
  select * into t from ops.staff where id = c.staff_id;
  is_hr := ops.att_is_hr(me);
  if p_decision = 'reject' then
    if length(trim(coalesce(p_note, ''))) = 0 then
      raise exception '驳回请写原因，让申请人知道。' using errcode = '22023';
    end if;
    update ops.punch_correction set status = 'rejected', decided_by = me.id, decided_at = now(),
                                    decision_note = trim(p_note)
    where id = c.id returning * into c;
    if c.self_closed then
      -- 自己补的下班卡被驳回：还原（只在纪录还是当初补的那个时间时）
      update ops.attendance set clock_out = null, updated_at = now()
      where staff_id = c.staff_id and date = c.date and clock_out = ops.kl_at(c.date, c.time);
    end if;
  elsif p_decision = 'approve' then
    if not is_hr then
      -- 主管批了 → 等 HR
      update ops.punch_correction set status = 'pending_hr', hod_by = me.id, hod_at = now(),
                                      decision_note = trim(coalesce(p_note, ''))
      where id = c.id returning * into c;
    else
      final_time := coalesce(nullif(p_time, '')::time, c.time);
      if c.kind = 'punch' then
        if c.self_closed and final_time <> c.time then
          update ops.attendance set clock_out = null where staff_id = c.staff_id and date = c.date
            and clock_out = ops.kl_at(c.date, c.time);
        end if;
        perform ops.att_check_punch(t, c.date, c.punch, final_time, true);   -- 定案前再检查一次（纪录可能变了）
      end if;
      perform ops.att_apply(c, final_time);
      update ops.punch_correction set status = 'approved', decided_by = me.id, decided_at = now(), time = final_time,
                                      hod_by = coalesce(hod_by, case when c.status = 'pending_hod' then me.id end),
                                      hod_at = coalesce(hod_at, case when c.status = 'pending_hod' then now() end),
                                      decision_note = trim(coalesce(p_note, ''))
      where id = c.id returning * into c;
    end if;
  else
    raise exception '未知的决定：%', p_decision using errcode = '22023';
  end if;
  perform ops.log(me.id, p_decision, 'punch_correction', c.id, jsonb_build_object('status', c.status));
  return ops.correction_json(c) || jsonb_build_object('can_decide', ops.att_can_decide(me, c));
end $$;

create or replace function public.ops_att_correction_cancel(p_id bigint) returns void
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  c ops.punch_correction;
begin
  me := ops.require_staff();
  select * into c from ops.punch_correction where id = p_id for update;
  if c.id is null or c.staff_id <> me.id then
    raise exception '只有申请人可以撤回。' using errcode = '42501';
  end if;
  if c.status not in ('pending_hod', 'pending_hr') then
    raise exception '这张补卡已经处理过了。' using errcode = '22023';
  end if;
  if c.self_closed then
    raise exception '自己补的下班卡不能撤回，请等主管审核。' using errcode = '22023';
  end if;
  update ops.punch_correction set status = 'cancelled', decided_at = now() where id = c.id;
  perform ops.log(me.id, 'cancel', 'punch_correction', c.id, '{}'::jsonb);
end $$;

-- ------------------------------------------------------------ 打卡设定（HR）
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
                                                           'friday_prayer', s.friday_prayer, 'join_date', s.join_date)
                                        order by d.sort, s.name), '[]'::jsonb)
              from ops.staff s join ops.department d on d.code = s.department
              where s.active and ops.sees_branch(me, s.branch))
  );
end $$;

create or replace function public.ops_att_shift_save(p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
begin
  me := ops.require_level('hr', 'edit');
  begin
    insert into ops.hr_shift (code, name, start_time, lunch_start, lunch_end, end_time, sat_end, sat_rule, sort)
    values (p->>'code', trim(p->>'name'), (p->>'start_time')::time, (p->>'lunch_start')::time, (p->>'lunch_end')::time,
            (p->>'end_time')::time, (p->>'sat_end')::time, p->>'sat_rule',
            coalesce((p->>'sort')::int, (select coalesce(max(sort), 0) + 10 from ops.hr_shift)))
    on conflict (code) do update set name = excluded.name, start_time = excluded.start_time,
      lunch_start = excluded.lunch_start, lunch_end = excluded.lunch_end, end_time = excluded.end_time,
      sat_end = excluded.sat_end, sat_rule = excluded.sat_rule;
  exception when check_violation or not_null_violation or invalid_datetime_format then
    raise exception '班别时间不对：要「上班 < 午休开始 < 午休结束 < 下班」，代号只能用小写英文、数字。' using errcode = '22023';
  end;
  perform ops.log(me.id, 'save', 'hr_shift', null, p);
end $$;

-- p: {id?, branch, name, lat, lng, radius, active}
create or replace function public.ops_att_fence_save(p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  g ops.geofence;
  v_id bigint := nullif(p->>'id', '')::bigint;
begin
  me := ops.require_level('hr', 'edit');
  if v_id is not null then
    select * into g from ops.geofence where id = v_id;
    if g.id is null or not ops.sees_branch(me, g.branch) then
      raise exception '找不到这个打卡点。' using errcode = 'P0002';
    end if;
  end if;
  if not ops.sees_branch(me, p->>'branch') then
    raise exception '你不能改其他分店的打卡点。' using errcode = '42501';
  end if;
  begin
    if v_id is null then
      insert into ops.geofence (branch, name, lat, lng, radius, active, updated_by)
      values (p->>'branch', trim(p->>'name'), (p->>'lat')::double precision, (p->>'lng')::double precision,
              coalesce((p->>'radius')::int, 150), coalesce((p->>'active')::boolean, true), me.id)
      returning id into v_id;
    else
      update ops.geofence set branch = p->>'branch', name = trim(p->>'name'), lat = (p->>'lat')::double precision,
        lng = (p->>'lng')::double precision, radius = coalesce((p->>'radius')::int, radius),
        active = coalesce((p->>'active')::boolean, active), updated_by = me.id, updated_at = now()
      where id = v_id;
    end if;
  exception when check_violation or not_null_violation or invalid_text_representation then
    raise exception '打卡点资料不对：要有名称、正确的经纬度，半径 20 – 5000 公尺。' using errcode = '22023';
  end;
  perform ops.log(me.id, 'save', 'geofence', v_id, p);
end $$;

-- p: {date, branch, name, delete?}
create or replace function public.ops_att_holiday_save(p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  br text := coalesce(nullif(p->>'branch', ''), 'ALL');
begin
  me := ops.require_level('hr', 'edit');
  if br <> 'ALL' and not ops.sees_branch(me, br) then
    raise exception '你不能改其他分店的假日。' using errcode = '42501';
  end if;
  if coalesce((p->>'delete')::boolean, false) then
    delete from ops.holiday where date = (p->>'date')::date and branch = br;
  else
    begin
      insert into ops.holiday (date, branch, name) values ((p->>'date')::date, br, trim(p->>'name'))
      on conflict (date, branch) do update set name = excluded.name;
    exception when check_violation or not_null_violation then
      raise exception '请填日期和假日名称。' using errcode = '22023';
    end;
  end if;
  perform ops.log(me.id, 'save', 'holiday', null, p);
end $$;

-- 指定某月上班的星期六；p_date 空 = 回到预设（当月第一个星期六）
create or replace function public.ops_att_saturday_set(p_ym text, p_date date) returns void
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
begin
  me := ops.require_level('hr', 'edit');
  if p_date is null then
    delete from ops.work_saturday where ym = p_ym;
  else
    begin
      insert into ops.work_saturday (ym, date) values (p_ym, p_date)
      on conflict (ym) do update set date = excluded.date;
    exception when check_violation then
      raise exception '要选那个月的星期六。' using errcode = '22023';
    end;
  end if;
  perform ops.log(me.id, 'save', 'work_saturday', null, jsonb_build_object('ym', p_ym, 'date', p_date));
end $$;

-- 员工的打卡设定。p: {id, manager_id, shift, geofence_exempt, friday_prayer, join_date}
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
  update ops.staff set manager_id = mgr, shift = coalesce(p->>'shift', shift),
    geofence_exempt = coalesce((p->>'geofence_exempt')::boolean, geofence_exempt),
    friday_prayer = coalesce((p->>'friday_prayer')::boolean, friday_prayer),
    join_date = case when p ? 'join_date' then nullif(p->>'join_date', '')::date else join_date end,
    updated_at = now()
  where id = t.id;
  perform ops.log(me.id, 'att_settings', 'staff', t.id, p);
end $$;

-- ------------------------------------------------------------ 首页：加打卡状态与待审补卡
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
             'open_shift', exists (select 1 from ops.attendance a where a.staff_id = me.id and a.date < ops.today()
                                   and a.clock_in is not null and a.clock_out is null)) end,
    'corrections_waiting', (select count(*) from ops.punch_correction c
                            where c.status in ('pending_hod', 'pending_hr') and ops.att_can_decide(me, c))
  );
end $$;

-- ------------------------------------------------------------ Storage：私有 bucket + policy
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('ops-hr', 'ops-hr', false, 5242880, array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
on conflict (id) do nothing;

create policy "ops-hr read" on storage.objects for select to authenticated
  using (bucket_id = 'ops-hr' and public.ops_hr_file_ok(name, false));
create policy "ops-hr insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'ops-hr' and public.ops_hr_file_ok(name, true));

-- ------------------------------------------------------------ 权限
do $$
declare
  f text;
begin
  foreach f in array array[
    'ops_hr_file_ok(text,boolean)', 'ops_att_today()', 'ops_att_punch(jsonb)', 'ops_att_self_close(jsonb)',
    'ops_att_field_checkin(jsonb)', 'ops_att_days(text,bigint)', 'ops_att_board(date)', 'ops_att_month(text)',
    'ops_att_correction_create(jsonb)', 'ops_att_corrections(text)', 'ops_att_correction_decide(bigint,text,text,text)',
    'ops_att_correction_cancel(bigint)', 'ops_att_settings()', 'ops_att_shift_save(jsonb)', 'ops_att_fence_save(jsonb)',
    'ops_att_holiday_save(jsonb)', 'ops_att_saturday_set(text,date)', 'ops_att_staff_set(jsonb)', 'ops_home()'
  ] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

revoke all on all functions in schema ops from public, anon, authenticated;
revoke all on all tables in schema ops from public, anon, authenticated;
