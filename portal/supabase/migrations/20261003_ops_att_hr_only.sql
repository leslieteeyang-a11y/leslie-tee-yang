-- 使用者 2026-10-03：补卡只要 HR 批（一层），不再经过直属主管 / 部门主管。
-- 新补卡直接是 pending_hr；还在 pending_hod 的旧单转给 HR；att_can_decide 只认 HR。
-- status 保留 'pending_hod' 这个值（旧资料 / 栏位检查不动），只是不再产生。
alter table ops.punch_correction alter column status set default 'pending_hr';
update ops.punch_correction set status = 'pending_hr' where status = 'pending_hod';

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
  return coalesce(ops.att_is_hr(p_me), false);               -- 只有 HR 可以批，批了就定案
end $$;

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
    raise exception '只有 HR 可以审补卡（也不能审自己的）。' using errcode = '42501';
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
    raise exception '自己补的下班卡不能撤回，请等 HR 审核。' using errcode = '22023';
  end if;
  update ops.punch_correction set status = 'cancelled', decided_at = now() where id = c.id;
  perform ops.log(me.id, 'cancel', 'punch_correction', c.id, '{}'::jsonb);
end $$;
