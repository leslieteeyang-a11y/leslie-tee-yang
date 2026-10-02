-- HomeWorks 实际上班时间（使用者 2026-10-02）：星期一到星期六 9:00am – 5:30pm，星期日休息。
-- 星期六整天上班 → 不再用「每月指定一个星期六」；整天的星期六也有午休。
update ops.hr_shift set start_time = '09:00', lunch_start = '12:30', lunch_end = '13:30',
                        end_time = '17:30', sat_end = '17:30', sat_rule = 'every';

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
  -- 星期六若做到午休之后（整天班）也有午休；半天班没有
  has_lunch := dow between 1 and 5 or (dow = 6 and sh.sat_end > sh.lunch_end);
  if dow = 6 then
    t_end := sh.sat_end;
  end if;
  workday := holiday is null and case
    when dow = 7 then false
    when dow = 6 then case sh.sat_rule when 'every' then true when 'none' then false
                                     else p_date = ops.designated_saturday(to_char(p_date, 'YYYY-MM')) end
    else true end;
end $$;

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
    if rec.lunch_out is null and (ops.att_schedule(me, co_local::date)).has_lunch
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
