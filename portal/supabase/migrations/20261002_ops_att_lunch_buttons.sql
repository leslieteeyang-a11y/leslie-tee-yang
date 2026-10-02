-- 使用者 2026-10-02：午休用明确的「午休下班」「午休上班」按键，不必靠「下班→上班」自动判断。
-- ops_att_punch 多两个动作 lunch_out / lunch_in；午休中不能直接打下班（要先午休上班）。
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
  if act not in ('in', 'out', 'lunch_out', 'lunch_in') then
    raise exception '未知的动作：%', act using errcode = '22023';
  end if;
  if (v_lat is null) <> (v_lng is null) or v_lat not between -90 and 90 or v_lng not between -180 and 180 then
    v_lat := null; v_lng := null;
  end if;
  selfie := ops.att_check_file(me, p->>'selfie', true);
  ts := ops.now();
  td := ops.today();
  select * into rec from ops.attendance where staff_id = me.id and date = td for update;

  -- 午休下班 / 午休上班（明确的按键；旧的「下班→上班」自动判断午休仍保留）
  if act in ('lunch_out', 'lunch_in') then
    if rec.id is null or rec.clock_in is null then
      raise exception '你今天还没打上班卡。' using errcode = '22023';
    end if;
    if rec.clock_out is not null then
      raise exception '你已经打了下班卡，不能再打午休卡。' using errcode = '22023';
    end if;
    if act = 'lunch_out' then
      if rec.lunch_out is not null then
        raise exception '今天已经打过午休下班卡了。' using errcode = '22023';
      end if;
      update ops.attendance set lunch_out = ts, selfie_lunch_out = selfie, updated_at = now() where id = rec.id;
    else
      if rec.lunch_out is null then
        raise exception '你还没打午休下班卡。' using errcode = '22023';
      end if;
      if rec.lunch_in is not null then
        raise exception '今天已经打过午休上班卡了。' using errcode = '22023';
      end if;
      update ops.attendance set lunch_in = ts, selfie_lunch_in = selfie, updated_at = now() where id = rec.id;
    end if;
    return public.ops_att_today();
  end if;

  if act = 'out' then
    if rec.lunch_out is not null and rec.lunch_in is null then
      raise exception '你还在午休，请先打「午休上班」。' using errcode = '22023';
    end if;
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
       and co_local::time >= time '10:30' and co_local::time < time '16:00' then
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
