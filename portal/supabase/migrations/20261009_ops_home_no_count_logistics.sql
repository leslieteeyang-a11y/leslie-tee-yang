-- 首页「今天还没盘点」不再提醒物流部（2026-10-09，使用者：「可以关掉」）。
-- 物流部的仓库权限是「可编辑」（要能登记搬动），所以原本 wh >= 2 就每天提醒盘点、首页还多一格「我今天盘了几件」。
-- 改成：物流部只有最近 30 天自己盘过点的人才提醒；其他部门照旧。其余栏位与 20261008_ops_join.sql 的 ops_home 相同。
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
    'hr_gaps', case when hr >= 2 then (select count(*) from ops.staff s where s.active and ops.sees_branch(me, s.branch)
                 and (s.join_date is null or s.gender is null or coalesce(trim(s.phone), '') = ''
                      or (pay >= 1 and not exists (select 1 from ops.pay_profile p where p.staff_id = s.id)))) end,
    'holidays_ahead', case when hr >= 2 then (select count(*) from ops.holiday h
                        where h.date between ops.today() and ops.today() + 60) end,
    'join_pending', case when adm >= 3 then (select count(*) from ops.join_request r where r.status = 'pending') end
  );
end $$;

revoke all on function public.ops_home() from public, anon;
grant execute on function public.ops_home() to authenticated;
