-- 使用者 2026-10-02：星期五没有延长午休，所有人每天都是一小时。
-- 拿掉「星期五礼拜多一小时」：att_schedule 不再看 friday_prayer；栏位保留（都设为 false），设定页不再显示。
update ops.staff set friday_prayer = false where friday_prayer;

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
  t_lunch_in := sh.lunch_end;
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
