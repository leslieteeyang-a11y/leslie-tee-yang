-- HomeWorks 营运系统 — 对照 AttendX 补上的四项（使用者 2026-10-09 决定）
--
-- F1 离职日自动停用：ops.staff.last_day（最后上班日）。
--   * HR 在「打卡 → 设定」员工设定填（ops_att_staff_set，和到职日同一处）；薪资资料的「离职日」写的也是这一栏，
--     ops.pay_profile.leave_date 只是同步的副本（触发器 staff_last_day_sync），薪资函数回传 coalesce(last_day, leave_date)。
--   * 过了最后上班日（马来西亚时间隔天 00:00）ops.current_staff() 就找不到人 → 所有 ops_* 函数、ops_me、照片 policy 一起挡下。
--   * 每天 00:05（KL）pg_cron 跑 ops.staff_offboard() 把这些人 active 改 false（本机测试库没有 pg_cron，只在有装时排程）。
--   * 复职（停用 → 启用，员工与权限或加入申请批准）时，已经到了 / 过了的最后上班日自动清掉；提早停用时还没到的最后上班日
--     改成今天（触发器 staff_last_day_guard）。
--   * 管理员的最后上班日只有管理员能设、不能设自己的、至少留一位没有最后上班日的管理员（ops.check_last_day），
--     和 ops_staff_save「不能停用自己」同理：不然没有人能进「员工与权限」复职。
--   * 只挡营运系统：同一个账号在 BI 名单的话 BI 照样能进，「员工与权限」会提醒另外移除（ops_staff_admin_list.in_bi）。
--   * 报表保留离职的人做过的月份：出勤月报 / 当天看板 / 薪资带入出勤都算到最后上班日为止；之后的月份不再出现。
--     首页「资料缺漏」、人事缺漏清单不再算过了最后上班日的人。HR 照样能替离职的人补最后上班日以前的卡、登记请假。
-- F2 补卡要附证明：员工申请补卡（含外出公务、HR 替员工补）一定要附图。
--   照 AttendX FEATURES-AND-RULES.md：§3.2 每张补卡都要附证明；§2.5 自己补下班卡（忘了打下班卡）附件选填 → ops_att_self_close 不变。
-- F3 年假要到职满 3 个月才能请：leave_type.min_service_months = 3（年假）。年假的应得天数照算（按比例），
--   只是开始日早于「到职日 + 3 个月」的申请会被挡；没填到职日先不挡（人事「资料缺漏」会提醒补）。其他假别规则不变。
--   HR 在「人事 → 假别设定」可改每个假别的月数（ops_leave_type_save 多收 min_service_months，没带 = 不改）。
-- F4 员工档案 ops.staff_profile：证件（MyKad / 护照）、生日、地址、紧急联络人、银行户口。
--   本人看 / 改自己的全部；HR 看（人事「可查看」）/ 改（「可编辑」）同分店员工的个人资料；
--   银行资料只有本人与管理薪资的人（薪资「可编辑」以上）看得到、改得到，其他人拿到的 JSON 里根本没有这两栏。
--   通讯录等既有清单都不回传证件号码、地址、银行。人事「资料缺漏」多三种：id_no、emergency、bank（只给管薪资的人）。
-- 这个档案不含会被 Supabase MCP 挡下的指令。

-- ============================================================ F1 离职日
alter table ops.staff add column last_day date;
alter table ops.staff add constraint staff_last_day_after_join
  check (last_day is null or join_date is null or last_day >= join_date);

-- 薪资资料原本的「离职日」带进来（正式环境 pay_profile 是空的；这里只为了本机 / 旧资料一致）
update ops.staff s set last_day = p.leave_date
from ops.pay_profile p
where p.staff_id = s.id and p.leave_date is not null and s.last_day is null
  and (s.join_date is null or p.leave_date >= s.join_date);

-- 最后上班日与「在职」要一致（所有写入路径都经过这里）：
--   * 复职（停用 → 在职）：已经到了 / 过了的最后上班日清掉（含今天：不清的话今晚又会被自动停用）
--   * 提早停用（人先走了，管理员取消「在职」）：还没到的最后上班日改成今天，看板 / 月报 / 薪资不会一直算缺勤到原本的日期
--   * 已停用的人不能再设还没到的最后上班日（要复职请管理员在「员工与权限」勾「在职」）
--   * 最后上班日不能早于到职日
create or replace function ops.staff_last_day_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    if new.active and not old.active and new.last_day is not null
       and (new.last_day <= ops.today() or new.last_day < new.join_date) then
      new.last_day := null;
    end if;
    if old.active and not new.active and new.last_day > ops.today() then
      new.last_day := ops.today();
    end if;
  end if;
  if not new.active and new.last_day > ops.today()
     and (tg_op = 'INSERT' or new.last_day is distinct from old.last_day) then
    raise exception '这位员工已停用，最后上班日不能晚于今天（%）。要复职请管理员在「员工与权限」勾「在职」。', ops.today()
      using errcode = '22023';
  end if;
  if new.last_day is not null and new.join_date is not null and new.last_day < new.join_date then
    raise exception '最后上班日（%）不能早于到职日（%）。', new.last_day, new.join_date using errcode = '22023';
  end if;
  return new;
end $$;
create trigger staff_last_day_guard before insert or update on ops.staff
  for each row execute function ops.staff_last_day_guard();

-- 薪资资料的离职日跟著最后上班日走（只有一个日期）
create or replace function ops.staff_last_day_sync() returns trigger
language plpgsql set search_path = '' as $$
begin
  update ops.pay_profile set leave_date = new.last_day
  where staff_id = new.id and leave_date is distinct from new.last_day;
  return null;
end $$;
create trigger staff_last_day_sync after update on ops.staff
  for each row when (old.last_day is distinct from new.last_day) execute function ops.staff_last_day_sync();

-- 过了最后上班日 = 找不到这个人（马来西亚时间隔天 00:00 起）
create or replace function ops.current_staff() returns ops.staff
language sql stable security definer set search_path = '' as $$
  select s.* from ops.staff s
  where lower(s.email) = lower(coalesce(auth.jwt() ->> 'email', '')) and s.active
    and (s.last_day is null or s.last_day >= ops.today())
$$;

-- 每天 00:05（KL）把过了最后上班日的人停用；回传停用几个人
create or replace function ops.staff_offboard() returns int
language plpgsql security definer set search_path = '' as $$
declare
  n int;
begin
  with x as (
    update ops.staff set active = false, updated_at = now()
    where active and last_day < ops.today()
    returning id, last_day)
  insert into ops.audit_log (staff_id, action, entity, entity_id, data)
  select null, 'offboard', 'staff', x.id, jsonb_build_object('last_day', x.last_day) from x;
  get diagnostics n = row_count;
  return n;
end $$;

-- pg_cron 用 UTC：16:05 UTC = 00:05 KL。同名工作会被取代（重套不会重复）。本机测试库没有 pg_cron → 跳过。
do $$
begin
  if exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron') then
    execute $c$select cron.schedule('ops_staff_offboard', '5 16 * * *', 'select ops.staff_offboard()')$c$;
  end if;
end $$;

-- 存最后上班日之前的检查（打卡设定、薪资资料、员工与权限共用）
-- 管理员：和 ops_staff_save「不能停用自己」同一个道理，避免没有人能进「员工与权限」复职 ——
--   只有管理员能设定 / 改管理员的最后上班日、管理员不能设自己的、至少要留一位没有最后上班日的在职管理员。
--   原样送回同一个日期（打卡设定表单会整笔送回）不算改。
create or replace function ops.check_last_day(p_me ops.staff, p_target ops.staff, p_join date, p_last date) returns void
language plpgsql stable set search_path = '' as $$
begin
  if p_last is not null and p_join is not null and p_last < p_join then
    raise exception '最后上班日（%）不能早于到职日（%）。', p_last, p_join using errcode = '22023';
  end if;
  if p_target.id = p_me.id and p_last < ops.today() then
    raise exception '不能把自己的最后上班日设在今天以前（设了会马上进不了系统）。' using errcode = '22023';
  end if;
  if p_target.role = 'admin' and p_last is not null and p_last is distinct from p_target.last_day then
    if p_me.role is distinct from 'admin' then
      raise exception '只有管理员可以设定管理员的最后上班日。' using errcode = '42501';
    end if;
    if p_target.id = p_me.id then
      raise exception '管理员不能设定自己的最后上班日（避免没有人能管理），请另一位管理员设定。' using errcode = '22023';
    end if;
    if not exists (select 1 from ops.staff a where a.role = 'admin' and a.active and a.id <> p_target.id
                   and a.last_day is null) then
      raise exception '至少要留一位没有最后上班日的管理员（避免没有人能管理）。' using errcode = '22023';
    end if;
  end if;
end $$;

-- 员工的打卡设定（20261003_ops_leave 版）+ 最后上班日；manager_id 没带就不改（Excel 开账号只带到职日 / 性别时不会清掉直属主管）
create or replace function public.ops_att_staff_set(p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  t ops.staff;
  mgr bigint := nullif(p->>'manager_id', '')::bigint;
  v_join date;
  v_last date;
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
  v_join := case when p ? 'join_date' then nullif(p->>'join_date', '')::date else t.join_date end;
  v_last := case when p ? 'last_day' then nullif(p->>'last_day', '')::date else t.last_day end;
  perform ops.check_last_day(me, t, v_join, v_last);
  update ops.staff set manager_id = case when p ? 'manager_id' then mgr else manager_id end,
    shift = coalesce(p->>'shift', shift),
    geofence_exempt = coalesce((p->>'geofence_exempt')::boolean, geofence_exempt),
    friday_prayer = coalesce((p->>'friday_prayer')::boolean, friday_prayer),
    join_date = v_join,
    last_day = v_last,
    gender = case when p ? 'gender' then nullif(p->>'gender', '') else gender end,
    updated_at = now()
  where id = t.id;
  perform ops.log(me.id, 'att_settings', 'staff', t.id, p);
end $$;

-- 打卡设定（20261003_ops_leave 版）：员工清单多回传 last_day
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
                                                           'gender', s.gender, 'last_day', s.last_day)
                                        order by d.sort, s.name), '[]'::jsonb)
              from ops.staff s join ops.department d on d.code = s.department
              where s.active and ops.sees_branch(me, s.branch))
  );
end $$;

-- 员工与权限清单：多一个 left（已过最后上班日）、in_bi（也在 BI 名单）；last_day 本来就在 to_jsonb(s) 里。
-- 离职只挡营运系统：同一个登入账号在 BI 名单（bi.allowed_users）的话 BI 照样看得到，画面提醒管理员另外移除。
create or replace function public.ops_staff_admin_list() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform ops.require_level('admin', 'approve');
  return (select coalesce(jsonb_agg(to_jsonb(s) || jsonb_build_object(
                    'has_login', exists (select 1 from auth.users u where lower(u.email) = lower(s.email)),
                    'left', coalesce(s.last_day < ops.today(), false),
                    'in_bi', exists (select 1 from bi.allowed_users b where lower(b.email) = lower(s.email)),
                    'overrides', (select coalesce(jsonb_object_agg(sm.module, sm.level), '{}'::jsonb)
                                  from ops.staff_module sm where sm.staff_id = s.id))
                  order by s.active desc, s.department, s.name), '[]'::jsonb)
          from ops.staff s);
end $$;

-- 某员工某月逐日（20261001_ops_attendance 版）：只列到最后上班日
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
  last := least((first + interval '1 month - 1 day')::date, ops.today(), t.last_day);   -- least 不理 null
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

-- 当天看板（20261001_ops_attendance 版）：最后上班日 ≥ 那天的人照列（就算已停用）；过了最后上班日的不列
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
      where coalesce(s.last_day >= d, s.active) and s.id <> me.id and ops.att_can_see(me, s)
        and d >= coalesce(s.join_date, s.created_at::date)) x));
end $$;

-- 月统计（20261003_ops_leave 版）：离职的人照列到最后上班日那个月；工作日 / 缺勤只算到最后上班日
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
        from generate_series(greatest(first, coalesce(s.join_date, s.created_at::date)), least(last, s.last_day),
                             interval '1 day') g(d)
        left join ops.attendance a on a.staff_id = s.id and a.date = g.d::date) x
      where (s.active or s.last_day >= first) and ops.att_can_see(me, s)
      group by s.id, s.name, dp.name, dp.sort, s.branch) m
  );
end $$;

-- 薪资自动带入出勤（20261005_ops_payroll 版）：只算到最后上班日
create or replace function ops.pay_att(p_staff ops.staff, p_year int, p_month int) returns jsonb
language sql stable security definer set search_path = '' as $$
  with d as (
    select g.d::date as d,
           ops.att_stats(p_staff, case when a.id is null then ops.att_blank(p_staff.id, g.d::date) else a end) as st,
           a.clock_in is not null as present
    from generate_series(greatest(make_date(p_year, p_month, 1), coalesce(p_staff.join_date, make_date(p_year, p_month, 1))),
                         least((make_date(p_year, p_month, 1) + interval '1 month - 1 day')::date, ops.today(), p_staff.last_day),
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

-- 薪资资料 JSON（20261005_ops_payroll 版）：离职日 = 最后上班日（没有才用旧的 leave_date）
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
    'comm_with_base', coalesce(p.comm_with_base, false), 'leave_date', coalesce(s.last_day, p.leave_date),
    'note', coalesce(p.note, ''))
  from (select 1) x left join ops.pay_profile p on p.staff_id = s.id
$$;

-- 存薪资资料（20261005_ops_payroll 版）：离职日同时写进 ops.staff.last_day；没带 leave_date = 不改
create or replace function public.ops_pay_profile_save(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  t ops.staff;
  v_leave date;
begin
  me := ops.require_level('payroll', 'edit');
  select * into t from ops.staff where id = (p->>'staff_id')::bigint;
  if t.id is null or not ops.sees_branch(me, t.branch) then
    raise exception '找不到这位员工。' using errcode = 'P0002';
  end if;
  if coalesce((p->>'base')::numeric, 0) < 0 or coalesce((p->>'comm_rate')::numeric, 0) < 0 then
    raise exception '底薪、佣金不能是负数。' using errcode = '22023';
  end if;
  v_leave := case when p ? 'leave_date' then nullif(p->>'leave_date', '')::date
                  else coalesce(t.last_day, (select x.leave_date from ops.pay_profile x where x.staff_id = t.id)) end;
  if v_leave is not null and t.join_date is not null and v_leave < t.join_date then
    raise exception '离职日期不能早过到职日（%）。', t.join_date using errcode = '22023';
  end if;
  perform ops.check_last_day(me, t, t.join_date, v_leave);
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
          coalesce((p->>'comm_with_base')::boolean, false), v_leave,
          trim(coalesce(p->>'note', '')), me.id, now())
  on conflict (staff_id) do update set
    pay_name = excluded.pay_name, base = excluded.base, category = excluded.category, epf_opt_in = excluded.epf_opt_in,
    skbbk = excluded.skbbk, no_epf = excluded.no_epf, no_socso = excluded.no_socso, no_eis = excluded.no_eis,
    comm_type = excluded.comm_type, comm_rate = excluded.comm_rate, group_comm = excluded.group_comm,
    comm_only = excluded.comm_only, comm_with_base = excluded.comm_with_base, leave_date = excluded.leave_date,
    note = excluded.note, updated_by = me.id, updated_at = now();
  -- 离职日 = 员工名单的最后上班日（唯一来源）
  update ops.staff set last_day = v_leave, updated_at = now() where id = t.id and last_day is distinct from v_leave;
  -- 员工名单上的手机（WhatsApp 工资单用）可以在这里一起改
  if p ? 'phone' then
    update ops.staff set phone = trim(coalesce(p->>'phone', '')), updated_at = now() where id = t.id;
  end if;
  perform ops.log(me.id, 'pay_profile', 'staff', t.id, p);
  select * into t from ops.staff where id = t.id;
  return ops.pay_profile_json(t);
end $$;

-- 当月薪资（20261005_ops_payroll 版）：离职日（最后上班日）在这个月或之后的照列，就算已经停用
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
                                  and coalesce(coalesce(s.last_day, p.leave_date) >= first, s.active))
                        and (s.join_date is null or s.join_date <= (first + interval '1 month - 1 day')::date)))));
end $$;

-- ============================================================ F2 补卡要附证明
-- 申请补卡（20261001_ops_attendance 版）：附件（证明）必填，HR 替员工补也一样（AttendX §3.2）。
-- 自己补下班卡（ops_att_self_close）照 AttendX §2.5 不用附件，不在这里。
-- 离职的人：隔天就被自动停用，HR 还是要能替他补最后上班日（含）以前的卡（最后一个月的薪资要用）；
-- 任何人都不能补最后上班日之后的日子。
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
  if t.id is null or (by_hr and not (ops.att_is_hr(me) and ops.sees_branch(me, t.branch))) then
    raise exception '只有 HR 可以替别人申请补卡。' using errcode = '42501';
  end if;
  by_hr := by_hr or ops.att_is_hr(me);
  if d is null then
    raise exception '请选日期。' using errcode = '22023';
  end if;
  if not t.active and t.last_day is null then
    raise exception '这位员工已停用。' using errcode = '22023';
  end if;
  if d > t.last_day then
    raise exception '补卡日期不能晚于最后上班日（%）。', t.last_day using errcode = '22023';
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
  if coalesce(trim(p->>'attachment'), '') = '' then
    raise exception '补卡要附证明（例：WhatsApp 截图、送货单照片）。' using errcode = '22023';
  end if;
  select * into rec from ops.attendance where staff_id = t.id and date = d;
  begin
    insert into ops.punch_correction (staff_id, date, kind, punch, time, reason, attachment, original, created_by)
    values (t.id, d, k, pu, tm, trim(coalesce(p->>'reason', '')), ops.att_check_file(me, trim(p->>'attachment'), true),
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

-- ============================================================ F3 年假到职满 3 个月才能请
update ops.leave_type set min_service_months = 3 where code = 'annual';

-- 应得天数（20261003_ops_leave 版）：年假的 min_service_months 不归零（照比例累积），只挡「开始日太早」的申请
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
  if p_type.min_service_months > 0 and p_type.rule <> 'annual' and (p_staff.join_date is null
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

-- 从哪天起可以请这个假别（到职日 + min_service_months；没设月数或没填到职日 = null）
create or replace function ops.leave_available_from(p_staff ops.staff, p_type ops.leave_type) returns date
language sql stable set search_path = '' as $$
  select case when p_type.min_service_months > 0 and p_staff.join_date is not null
              then (p_staff.join_date + make_interval(months => p_type.min_service_months))::date end
$$;

-- 申请请假（20261003_ops_leave 版）：年假到职满 N 个月（没填到职日不挡）；不能请到最后上班日之后。
-- HR 代填：离职的人（已停用、有最后上班日）也收，补最后上班日以前的假（最后一个月的无薪假要扣薪）。
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
    select * into t from ops.staff where id = (p->>'staff_id')::bigint and (active or last_day is not null);
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
  if t.last_day is not null and e > t.last_day then
    raise exception '请假日期不能晚于最后上班日（%）。', t.last_day using errcode = '22023';
  end if;
  if lt.gender is not null and t.gender is not null and lt.gender <> t.gender then
    raise exception '%只限%性员工。', lt.name, case lt.gender when 'F' then '女' else '男' end using errcode = '22023';
  end if;
  if lt.min_service_months > 0 then
    if lt.rule = 'annual' then
      -- 年假：开始日要在到职满 N 个月之后；没填到职日先不挡
      if t.join_date is not null and s < ops.leave_available_from(t, lt) then
        raise exception '到职满 % 个月（%）后才能请%。', lt.min_service_months, ops.leave_available_from(t, lt), lt.name
          using errcode = '22023';
      end if;
    elsif t.join_date is null or t.join_date + make_interval(months => lt.min_service_months) > s then
      raise exception '%要服务满 % 个月才能请%。', lt.name, lt.min_service_months,
        case when t.join_date is null then '（HR 还没填你的到职日）' else '' end using errcode = '22023';
    end if;
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

-- 请假页（20261003_ops_leave 版）：假别多回传 min_service_months、available_from（从哪天起可以请）；另回传 last_day
create or replace function public.ops_leave_home(p_year int default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  y int;
begin
  me := ops.require_level('leave', 'view');
  y := coalesce(p_year, extract(year from ops.today())::int);
  return jsonb_build_object(
    'today', ops.today(), 'year', y, 'join_date', me.join_date, 'last_day', me.last_day, 'gender', me.gender,
    'is_hr', ops.att_is_hr(me),
    'types', (select coalesce(jsonb_agg(jsonb_build_object('code', t.code, 'name', t.name, 'rule', t.rule, 'days', t.days,
                                                           'half_day', t.half_day, 'calendar_days', t.calendar_days,
                                                           'need_attachment', t.need_attachment, 'note', t.note,
                                                           'min_service_months', t.min_service_months,
                                                           'available_from', ops.leave_available_from(me, t))
                                        order by t.sort), '[]'::jsonb)
              from ops.leave_type t where t.active and (t.gender is null or me.gender is null or t.gender = me.gender)),
    'balances', ops.leave_balances(me, y),
    'requests', (select coalesce(jsonb_agg(ops.leave_json(me, r) order by r.start_date desc, r.id desc), '[]'::jsonb)
                 from ops.leave_request r where r.staff_id = me.id
                   and (extract(year from r.start_date)::int = y or r.status = 'pending')));
end $$;

-- 全体员工某年的余额（20261003_ops_leave 版）：那一年离职的人照列（HR 要替他补最后几天的假、算剩几天），多回传 last_day
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
                                                 'last_day', s.last_day,
                                                 'years', ops.leave_years(s.join_date, ops.leave_asof(y)),
                                                 'balances', ops.leave_balances(s, y),
                                                 'adjustments', (select coalesce(jsonb_agg(jsonb_build_object(
                                                      'id', a.id, 'type', a.type, 'days', a.days, 'note', a.note,
                                                      'by', (select b.name from ops.staff b where b.id = a.created_by),
                                                      'at', a.created_at) order by a.id), '[]'::jsonb)
                                                    from ops.leave_adjust a where a.staff_id = s.id and a.year = y))
                              order by d.sort, s.name), '[]'::jsonb)
    from ops.staff s join ops.department d on d.code = s.department
    where (s.active or s.last_day >= make_date(y, 1, 1)) and ops.sees_branch(me, s.branch)));
end $$;

-- 假别设定（20261003_ops_leave 版）+ min_service_months（没带 = 不改，旧版前端照常可用）
create or replace function public.ops_leave_type_save(p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  t ops.leave_type;
  v_txt text := nullif(trim(coalesce(p->>'min_service_months', '')), '');
  v_min int;
begin
  me := ops.require_level('hr', 'approve');
  select * into t from ops.leave_type where code = p->>'code';
  if t.code is null then
    raise exception '没有这个假别。' using errcode = 'P0002';
  end if;
  if length(trim(coalesce(p->>'name', t.name))) = 0 then
    raise exception '请填假别名称。' using errcode = '22023';
  end if;
  if v_txt is not null then
    if v_txt !~ '^[0-9]{1,3}$' then
      raise exception '「到职满几个月才能请」要是 0 – 120 的整数。' using errcode = '22023';
    end if;
    v_min := v_txt::int;
    if v_min > 120 then
      raise exception '「到职满几个月才能请」要是 0 – 120 的整数。' using errcode = '22023';
    end if;
  end if;
  update ops.leave_type set
    name = trim(coalesce(p->>'name', name)),
    days = case when rule in ('fixed', 'none') then coalesce(nullif(p->>'days', '')::numeric, days) else days end,
    half_day = coalesce((p->>'half_day')::boolean, half_day),
    need_attachment = coalesce((p->>'need_attachment')::boolean, need_attachment),
    min_service_months = coalesce(v_min, min_service_months),
    active = coalesce((p->>'active')::boolean, active),
    note = coalesce(p->>'note', note)
  where code = t.code;
  perform ops.log(me.id, 'leave_type', 'leave_type', null, p);
end $$;

-- ============================================================ F4 员工档案
create table ops.staff_profile (
  staff_id bigint primary key references ops.staff(id),
  id_type text not null default 'mykad' check (id_type in ('mykad', 'passport')),
  id_no text,                                   -- MyKad 存成 YYMMDD-PB-####；护照大写英数
  dob date,
  address text,
  emergency_name text,
  emergency_relation text,
  emergency_phone text,
  bank_name text,
  bank_account text,                            -- 只存数字
  updated_by bigint references ops.staff(id),
  updated_at timestamptz not null default now()
);
alter table ops.staff_profile enable row level security;
revoke all on ops.staff_profile from public, anon, authenticated;

-- 看个人资料：本人；同分店、人事「可查看」以上
create or replace function ops.profile_can_view(p_me ops.staff, p_t ops.staff) returns boolean
language sql stable set search_path = '' as $$
  select coalesce(p_me.id = p_t.id
    or (ops.sees_branch(p_me, p_t.branch) and ops.level_rank(ops.module_level(p_me, 'hr')) >= 1), false)
$$;

-- 改个人资料：本人；同分店、人事「可编辑」以上
create or replace function ops.profile_can_edit(p_me ops.staff, p_t ops.staff) returns boolean
language sql stable set search_path = '' as $$
  select coalesce(p_me.id = p_t.id
    or (ops.sees_branch(p_me, p_t.branch) and ops.level_rank(ops.module_level(p_me, 'hr')) >= 2), false)
$$;

-- 银行资料：只有本人与管理薪资的人（同分店、薪资「可编辑」以上）
create or replace function ops.profile_bank_ok(p_me ops.staff, p_t ops.staff) returns boolean
language sql stable set search_path = '' as $$
  select coalesce(p_me.id = p_t.id
    or (ops.sees_branch(p_me, p_t.branch) and ops.level_rank(ops.module_level(p_me, 'payroll')) >= 2), false)
$$;

-- 档案缺什么：id_no（证件号码）、emergency（紧急联络人名字或电话）、bank（银行，只在 p_bank 时检查）
create or replace function ops.profile_missing(f ops.staff_profile, p_bank boolean) returns text[]
language sql stable set search_path = '' as $$
  select array_remove(array[
    case when f.id_no is null then 'id_no' end,
    case when f.emergency_name is null or f.emergency_phone is null then 'emergency' end,
    case when p_bank and (f.bank_name is null or f.bank_account is null) then 'bank' end], null)
$$;

-- 人事「资料缺漏」的代号（首页计数与清单共用）：join_date gender phone pay id_no emergency bank
--   pay：薪资「可查看」以上才检查；bank：薪资「可编辑」以上才检查
create or replace function ops.hr_gap_codes(p_staff ops.staff, p_pay int) returns text[]
language sql stable set search_path = '' as $$
  select array_remove(array[
    case when p_staff.join_date is null then 'join_date' end,
    case when p_staff.gender is null then 'gender' end,
    case when coalesce(trim(p_staff.phone), '') = '' then 'phone' end,
    case when p_pay >= 1 and not exists (select 1 from ops.pay_profile p where p.staff_id = p_staff.id) then 'pay' end], null)
    || ops.profile_missing(f, p_pay >= 2)
  from (select 1) one left join ops.staff_profile f on f.staff_id = p_staff.id
$$;

-- 证件号码整理：MyKad 去掉 - 与空白后要 12 位数字，存成 YYMMDD-PB-####；护照 5–20 个英文字母 / 数字（转大写）
create or replace function ops.profile_id_no(p_type text, p_no text) returns text
language plpgsql immutable set search_path = '' as $$
declare
  v text := nullif(trim(coalesce(p_no, '')), '');
begin
  if v is null then
    return null;
  end if;
  if p_type = 'mykad' then
    v := regexp_replace(v, '[\s-]', '', 'g');
    if v !~ '^[0-9]{12}$' then
      raise exception '身份证号码要是 12 位数字（例：900101-01-1234）。' using errcode = '22023';
    end if;
    return substr(v, 1, 6) || '-' || substr(v, 7, 2) || '-' || substr(v, 9, 4);
  end if;
  v := upper(regexp_replace(v, '\s', '', 'g'));
  if v !~ '^[A-Z0-9]{5,20}$' then
    raise exception '护照号码要是 5 – 20 个英文字母或数字。' using errcode = '22023';
  end if;
  return v;
end $$;

-- MyKad 前 6 位 = 生日 YYMMDD：YY 大于今年的两位数 → 19YY，否则 20YY；不是有效日期就报错
create or replace function ops.mykad_dob(p_no text) returns date
language plpgsql stable set search_path = '' as $$
declare
  yy int := substr(p_no, 1, 2)::int;
  cy int := extract(year from ops.today())::int % 100;
begin
  return make_date(case when yy > cy then 1900 else 2000 end + yy, substr(p_no, 3, 2)::int, substr(p_no, 5, 2)::int);
exception when others then
  raise exception '身份证号码前 6 位不是有效的出生日期（YYMMDD）。' using errcode = '22023';
end $$;

create or replace function ops.profile_json(p_me ops.staff, p_t ops.staff) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
      'staff_id', p_t.id, 'name', p_t.name, 'department', p_t.department,
      'department_name', (select d.name from ops.department d where d.code = p_t.department),
      'branch', p_t.branch, 'phone', p_t.phone, 'join_date', p_t.join_date, 'last_day', p_t.last_day,
      'self', p_me.id = p_t.id,
      'can_edit', ops.profile_can_edit(p_me, p_t),
      'can_bank', ops.profile_bank_ok(p_me, p_t),
      'id_type', coalesce(f.id_type, 'mykad'), 'id_no', f.id_no, 'dob', f.dob, 'address', f.address,
      'emergency_name', f.emergency_name, 'emergency_relation', f.emergency_relation,
      'emergency_phone', f.emergency_phone,
      'missing', to_jsonb(ops.profile_missing(f, ops.profile_bank_ok(p_me, p_t))),
      'updated_at', f.updated_at,
      'updated_by_name', (select s.name from ops.staff s where s.id = f.updated_by))
    -- 银行两栏：没有权限的人连 key 都不给
    || case when ops.profile_bank_ok(p_me, p_t)
            then jsonb_build_object('bank_name', f.bank_name, 'bank_account', f.bank_account)
            else '{}'::jsonb end
  from (select 1) one left join ops.staff_profile f on f.staff_id = p_t.id
$$;

-- 看一位员工的档案；p_staff_id 空 = 自己
create or replace function public.ops_profile_get(p_staff_id bigint default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  t ops.staff;
begin
  me := ops.require_staff();
  select * into t from ops.staff where id = coalesce(p_staff_id, me.id);
  if t.id is null or not ops.profile_can_view(me, t) then
    raise exception '找不到这位员工，或你没有权限看。' using errcode = 'P0002';
  end if;
  return ops.profile_json(me, t);
end $$;
revoke all on function public.ops_profile_get(bigint) from public, anon;
grant execute on function public.ops_profile_get(bigint) to authenticated;

-- 存档案（只改 p 里有的栏位；空字串 = 清空）。p_staff_id 空 = 自己。
-- p: {id_type, id_no, dob, address, emergency_name, emergency_relation, emergency_phone, bank_name, bank_account}
-- 不是本人又不是管理薪资的人，p 里有银行栏位就拒绝（前端不显示银行区块时不要送这两栏）。
create or replace function public.ops_profile_save(p_staff_id bigint, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  t ops.staff;
  cur ops.staff_profile;
  v_type text;
  v_no text;
  v_dob date;
  v_addr text;
  v_ename text;
  v_erel text;
  v_ephone text;
  v_bname text;
  v_bacc text;
  ic_dob date;
begin
  me := ops.require_staff();
  if jsonb_typeof(p) is distinct from 'object' then
    raise exception '资料格式不对。' using errcode = '22023';
  end if;
  select * into t from ops.staff where id = coalesce(p_staff_id, me.id);
  if t.id is null or not ops.profile_can_edit(me, t) then
    raise exception '你没有权限改这位员工的资料。' using errcode = '42501';
  end if;
  if (p ? 'bank_name' or p ? 'bank_account') and not ops.profile_bank_ok(me, t) then
    raise exception '只有本人和管理薪资的人可以改银行资料。' using errcode = '42501';
  end if;
  select * into cur from ops.staff_profile where staff_id = t.id for update;

  v_type := case when p ? 'id_type' then coalesce(nullif(trim(p->>'id_type'), ''), 'mykad') else coalesce(cur.id_type, 'mykad') end;
  if v_type not in ('mykad', 'passport') then
    raise exception '证件种类只能是 MyKad 或护照。' using errcode = '22023';
  end if;
  v_no := ops.profile_id_no(v_type, case when p ? 'id_no' then p->>'id_no' else cur.id_no end);
  begin
    v_dob := case when p ? 'dob' then nullif(trim(coalesce(p->>'dob', '')), '')::date else cur.dob end;
  exception when others then
    raise exception '生日格式不对（要是 YYYY-MM-DD）。' using errcode = '22023';
  end;
  if v_type = 'mykad' and v_no is not null then
    ic_dob := ops.mykad_dob(v_no);            -- 身份证前 6 位一定要是有效日期
    v_dob := coalesce(v_dob, ic_dob);         -- 生日空白就用身份证的
  end if;
  if v_dob is not null and extract(year from age(ops.today(), v_dob)) not between 14 and 80 then
    raise exception '生日不合理：年龄要在 14 – 80 岁之间。' using errcode = '22023';
  end if;

  v_addr := case when p ? 'address' then nullif(trim(coalesce(p->>'address', '')), '') else cur.address end;
  v_ename := case when p ? 'emergency_name' then nullif(trim(coalesce(p->>'emergency_name', '')), '') else cur.emergency_name end;
  v_erel := case when p ? 'emergency_relation' then nullif(trim(coalesce(p->>'emergency_relation', '')), '')
                 else cur.emergency_relation end;
  v_ephone := case when p ? 'emergency_phone' then nullif(trim(coalesce(p->>'emergency_phone', '')), '') else cur.emergency_phone end;
  v_bname := case when p ? 'bank_name' then nullif(trim(coalesce(p->>'bank_name', '')), '') else cur.bank_name end;
  v_bacc := case when p ? 'bank_account' then nullif(regexp_replace(coalesce(p->>'bank_account', ''), '[\s-]', '', 'g'), '')
                 else cur.bank_account end;
  if length(v_addr) > 300 then
    raise exception '「%」太长了（最多 % 个字）。', '地址', 300 using errcode = '22023';
  end if;
  if length(v_ename) > 80 then
    raise exception '「%」太长了（最多 % 个字）。', '紧急联络人', 80 using errcode = '22023';
  end if;
  if length(v_erel) > 40 then
    raise exception '「%」太长了（最多 % 个字）。', '关系', 40 using errcode = '22023';
  end if;
  if length(v_bname) > 80 then
    raise exception '「%」太长了（最多 % 个字）。', '银行', 80 using errcode = '22023';
  end if;
  if v_ephone is not null and (v_ephone !~ '^[0-9 +-]+$'
                               or length(regexp_replace(v_ephone, '[^0-9]', '', 'g')) not between 8 and 15) then
    raise exception '紧急联络人电话要是 8 – 15 位数字（可以有空格、+、-）。' using errcode = '22023';
  end if;
  if v_bacc is not null and v_bacc !~ '^[0-9]{6,20}$' then
    raise exception '银行户口号码要是 6 – 20 位数字。' using errcode = '22023';
  end if;

  insert into ops.staff_profile as x (staff_id, id_type, id_no, dob, address, emergency_name, emergency_relation,
                                      emergency_phone, bank_name, bank_account, updated_by, updated_at)
  values (t.id, v_type, v_no, v_dob, v_addr, v_ename, v_erel, v_ephone, v_bname, v_bacc, me.id, now())
  on conflict (staff_id) do update set
    id_type = excluded.id_type, id_no = excluded.id_no, dob = excluded.dob, address = excluded.address,
    emergency_name = excluded.emergency_name, emergency_relation = excluded.emergency_relation,
    emergency_phone = excluded.emergency_phone, bank_name = excluded.bank_name, bank_account = excluded.bank_account,
    updated_by = me.id, updated_at = now();
  -- 稽核只记改了哪些栏位，不记证件 / 银行号码
  perform ops.log(me.id, 'profile', 'staff', t.id,
                  jsonb_build_object('fields', (select coalesce(jsonb_agg(k order by k), '[]'::jsonb) from jsonb_object_keys(p) k)));
  return ops.profile_json(me, t);
end $$;
revoke all on function public.ops_profile_save(bigint, jsonb) from public, anon;
grant execute on function public.ops_profile_save(bigint, jsonb) to authenticated;

-- 人事「员工档案」清单：同分店在职员工（过了最后上班日的不列）；不回传地址、银行
create or replace function public.ops_profile_list() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  bank boolean;
begin
  me := ops.require_level('hr', 'view');
  bank := ops.level_rank(ops.module_level(me, 'payroll')) >= 2;
  return jsonb_build_object(
    'can_edit', ops.level_rank(ops.module_level(me, 'hr')) >= 2,
    'can_bank', bank,
    'rows', (select coalesce(jsonb_agg(jsonb_build_object(
                 'staff_id', s.id, 'name', s.name, 'department', s.department, 'department_name', d.name,
                 'branch', s.branch, 'phone', s.phone, 'join_date', s.join_date, 'last_day', s.last_day,
                 'id_type', coalesce(f.id_type, 'mykad'), 'id_no', f.id_no, 'dob', f.dob,
                 'emergency_name', f.emergency_name, 'emergency_relation', f.emergency_relation,
                 'emergency_phone', f.emergency_phone, 'has_address', f.address is not null,
                 'missing', to_jsonb(ops.profile_missing(f, bank)), 'updated_at', f.updated_at)
               order by d.sort, s.name), '[]'::jsonb)
             from ops.staff s
             join ops.department d on d.code = s.department
             left join ops.staff_profile f on f.staff_id = s.id
             where s.active and (s.last_day is null or s.last_day >= ops.today()) and ops.sees_branch(me, s.branch)));
end $$;
revoke all on function public.ops_profile_list() from public, anon;
grant execute on function public.ops_profile_list() to authenticated;

-- 人事资料缺漏（20261007_ops_todo_aged 版）：代号改由 ops.hr_gap_codes 产生（多 id_no / emergency / bank）；
-- 过了最后上班日的人不列
create or replace function public.ops_hr_gaps() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  pay int;
begin
  me := ops.require_level('hr', 'edit');
  pay := ops.level_rank(ops.module_level(me, 'payroll'));
  return jsonb_build_object(
    'staff', (select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'name', x.name, 'branch', x.branch,
                'department_name', (select d.name from ops.department d where d.code = x.department),
                'missing', to_jsonb(x.codes))
              order by x.name), '[]'::jsonb)
              from (select s.id, s.name, s.branch, s.department, ops.hr_gap_codes(s, pay) as codes
                    from ops.staff s
                    where s.active and (s.last_day is null or s.last_day >= ops.today())
                      and ops.sees_branch(me, s.branch)) x
              where cardinality(x.codes) > 0),
    'no_fence', (select coalesce(jsonb_agg(b order by b), '[]'::jsonb)
                 from unnest(array['HOMEWORKSSB', 'HOMEWORKSSOUTHERN']) b
                 where ops.sees_branch(me, b)
                   and exists (select 1 from ops.staff s where s.active and s.branch = b and not s.geofence_exempt)
                   and not exists (select 1 from ops.geofence g where g.branch = b and g.active)),
    'holidays_ahead', (select count(*) from ops.holiday h where h.date between ops.today() and ops.today() + 60),
    'last_holiday', (select max(h.date) from ops.holiday h));
end $$;

-- 首页（20261009_ops_home_no_count_logistics 版）：hr_gaps 与缺漏清单同一套规则（ops.hr_gap_codes）
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
    -- 物流部也有仓库「可编辑」（登记搬动），但不负责盘点：不提醒「今天还没盘点」；最近 30 天自己盘过的照样提醒（使用者 2026-10-09）
    'wh_counted_today', case when wh >= 2 and (me.department <> 'logistics' or exists (select 1 from ops.wh_count k
                          where k.counted_by = me.id and k.count_date >= ops.today() - 30)) then (select count(*) from ops.wh_count k
                          where k.counted_by = me.id and k.count_date = ops.today() and k.status <> 'superseded') end,
    'hr_gaps', case when hr >= 2 then (select count(*) from ops.staff s
                 where s.active and (s.last_day is null or s.last_day >= ops.today()) and ops.sees_branch(me, s.branch)
                   and cardinality(ops.hr_gap_codes(s, pay)) > 0) end,
    'holidays_ahead', case when hr >= 2 then (select count(*) from ops.holiday h
                        where h.date between ops.today() and ops.today() + 60) end,
    'join_pending', case when adm >= 3 then (select count(*) from ops.join_request r where r.status = 'pending') end
  );
end $$;

-- ------------------------------------------------------------ 权限
-- create or replace 会保留旧函数的权限；这里再明确设一次
do $$
declare
  f text;
begin
  foreach f in array array[
    'ops_att_staff_set(jsonb)', 'ops_att_settings()', 'ops_staff_admin_list()', 'ops_att_days(text,bigint)',
    'ops_att_board(date)', 'ops_att_month(text)', 'ops_pay_profile_save(jsonb)', 'ops_pay_month(int,int)',
    'ops_att_correction_create(jsonb)', 'ops_leave_apply(jsonb)', 'ops_leave_home(int)', 'ops_leave_type_save(jsonb)',
    'ops_leave_balances(int)',
    'ops_hr_gaps()', 'ops_home()'
  ] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

revoke all on all functions in schema ops from public, anon, authenticated;
revoke all on all tables in schema ops from public, anon, authenticated;
