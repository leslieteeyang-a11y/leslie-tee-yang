-- HomeWorks 营运系统 — 首页每日待办、PO 到货提醒、HR 资料缺漏提醒、仓库旧货清单（使用者 2026-10-07 选的优化）
--   * 旧货：bi.fact_item_aging（最后进货日、现有量、库存成本）+ bi.mv_sales_item_month（近 12 个月销量）。
--     ① 入货超过 12 个月 ② 12 个月没卖出 ③ 两者都是。处理方式记在 ops.wh_aged_action（清货 / 促销 / 退供应商 / 报废 / 保留）。
--     看清单：仓库「可查看」；看成本、填处理方式：仓库「可审批」（与看成本的规则相同）。
--   * HR 缺漏：在职员工没填到职日 / 性别 / 手机 / 薪资资料、分店没有打卡点、接下来 60 天以后没有设假日。
--   * 首页：po_arriving（3 天内预计到货的 PO 张数）给订货「可查看」或仓库「可编辑」的人；hr_gaps 给人事「可编辑」的人。
-- 这个档案不含删除指令（Supabase MCP 会挡）。

create table ops.wh_aged_action (
  company text not null,
  item_code text not null,
  action text not null default 'none' check (action in ('none', 'clearance', 'promo', 'return', 'scrap', 'keep')),
  owner_id bigint references ops.staff(id),
  note text not null default '' check (length(note) <= 500),
  updated_by bigint references ops.staff(id),
  updated_at timestamptz not null default now(),
  primary key (company, item_code)
);
alter table ops.wh_aged_action enable row level security;

-- 每个商品：最后进货、现有量、成本、近 12 个月销量、最后有卖的月份、分类（old / nosale）
create or replace function ops.wh_aged_rows(p_company text) returns table (
  company text, item_code text, description text, item_group text, item_type text, last_receipt date, months int,
  on_hand numeric, stock_value numeric, sold12 numeric, last_sale_month date, is_old boolean, no_sale boolean)
language sql stable security definer set search_path = '' as $$
  with cut as (select (extract(year from ops.today()) * 12 + extract(month from ops.today()))::int - 12 as ym),
  s as (
    select m.company, m.item_code,
           sum(m.qty) filter (where m.yr * 12 + m.mth > (select ym from cut)) as q12,
           max(make_date(m.yr, m.mth, 1)) filter (where m.qty > 0) as last_m
    from bi.mv_sales_item_month m where m.company = p_company group by 1, 2)
  select a.company, a.item_code, coalesce(i.description, a.item_code), coalesce(i.item_group, ''), coalesce(i.item_type, ''),
         a.last_receipt_date,
         (extract(year from age(ops.today(), a.last_receipt_date)) * 12 + extract(month from age(ops.today(), a.last_receipt_date)))::int,
         a.on_hand, a.stock_value, coalesce(s.q12, 0), s.last_m,
         a.last_receipt_date < (ops.today() - interval '12 months')::date, coalesce(s.q12, 0) <= 0
  from bi.fact_item_aging a
  left join bi.dim_item i on i.company = a.company and i.item_code = a.item_code
  left join s on s.company = a.company and s.item_code = a.item_code
  where a.company = p_company and a.on_hand > 0 and a.last_receipt_date is not null
$$;

-- 清单：p = {company, kind: both | old | nosale, action: '' | none | clearance …, q}
create or replace function public.ops_wh_aged(p jsonb default '{}'::jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  c text := coalesce(nullif(p->>'company', ''), 'HOMEWORKSSB');
  kind text := coalesce(nullif(p->>'kind', ''), 'both');
  act text := coalesce(p->>'action', '');
  q text := upper(trim(coalesce(p->>'q', '')));
  cost boolean;
begin
  me := ops.require_level('warehouse', 'view');
  if not ops.sees_company(me, c) then
    raise exception '你看不到这间公司的库存。' using errcode = '42501';
  end if;
  cost := ops.level_rank(ops.module_level(me, 'warehouse')) >= 3;
  return (
    with r as (
      select x.*, coalesce(w.action, 'none') as action, w.note, w.owner_id, o.name as owner_name, w.updated_at as action_at
      from ops.wh_aged_rows(c) x
      left join ops.wh_aged_action w on w.company = x.company and w.item_code = x.item_code
      left join ops.staff o on o.id = w.owner_id
      where (x.is_old or x.no_sale)),
    f as (
      select * from r
      where (kind = 'both' and r.is_old and r.no_sale or kind = 'old' and r.is_old or kind = 'nosale' and r.no_sale)
        and (act = '' or r.action = act)
        and (q = '' or position(q in upper(r.item_code || ' ' || r.description || ' ' || r.item_group)) > 0))
    select jsonb_build_object(
      'company', c, 'show_cost', cost, 'can_edit', cost,
      'summary', (select jsonb_build_object(
          'old_n', count(*) filter (where r.is_old), 'nosale_n', count(*) filter (where r.no_sale),
          'both_n', count(*) filter (where r.is_old and r.no_sale),
          'both_open', count(*) filter (where r.is_old and r.no_sale and r.action = 'none'),
          'old_v', case when cost then round(sum(r.stock_value) filter (where r.is_old), 2) end,
          'nosale_v', case when cost then round(sum(r.stock_value) filter (where r.no_sale), 2) end,
          'both_v', case when cost then round(sum(r.stock_value) filter (where r.is_old and r.no_sale), 2) end)
        from r),
      'total', (select count(*) from f),
      'rows', coalesce((select jsonb_agg(jsonb_build_object(
          'item_code', f.item_code, 'description', f.description, 'item_group', f.item_group, 'item_type', f.item_type,
          'last_receipt', f.last_receipt, 'months', f.months, 'on_hand', f.on_hand,
          'stock_value', case when cost then f.stock_value end, 'sold12', f.sold12, 'last_sale_month', f.last_sale_month,
          'is_old', f.is_old, 'no_sale', f.no_sale, 'action', f.action, 'note', coalesce(f.note, ''),
          'owner_id', f.owner_id, 'owner_name', f.owner_name, 'action_at', f.action_at,
          'locations', (select coalesce(jsonb_agg(jsonb_build_object('location', fs.location, 'qty', fs.qty) order by fs.qty desc), '[]'::jsonb)
                        from bi.fact_stock fs where fs.company = c and fs.item_code = f.item_code and fs.qty > 0))
          order by case when cost then f.stock_value else f.on_hand end desc, f.item_code)
        from (select * from f order by case when cost then f.stock_value else f.on_hand end desc, f.item_code limit 300) f), '[]'::jsonb)
    ) from (select 1) one);
end $$;

-- 填处理方式（可一次多项）：p = {company, item_codes: [...], action, owner_id, note}
create or replace function public.ops_wh_aged_save(p jsonb) returns int
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  c text := coalesce(nullif(p->>'company', ''), 'HOMEWORKSSB');
  act text := coalesce(nullif(p->>'action', ''), 'none');
  own bigint := nullif(p->>'owner_id', '')::bigint;
  n int;
begin
  me := ops.require_level('warehouse', 'approve');
  if not ops.sees_company(me, c) then
    raise exception '你看不到这间公司的库存。' using errcode = '42501';
  end if;
  if act not in ('none', 'clearance', 'promo', 'return', 'scrap', 'keep') then
    raise exception '处理方式不对。' using errcode = '22023';
  end if;
  if own is not null and not exists (select 1 from ops.staff s where s.id = own and s.active) then
    raise exception '指派的员工不存在或已停用。' using errcode = '22023';
  end if;
  if jsonb_typeof(p->'item_codes') <> 'array' or jsonb_array_length(p->'item_codes') = 0 then
    raise exception '请先选商品。' using errcode = '22023';
  end if;
  insert into ops.wh_aged_action as w (company, item_code, action, owner_id, note, updated_by, updated_at)
  select c, x, act, own, left(trim(coalesce(p->>'note', '')), 500), me.id, now()
  from jsonb_array_elements_text(p->'item_codes') x
  on conflict (company, item_code) do update set action = excluded.action, owner_id = excluded.owner_id,
    note = excluded.note, updated_by = me.id, updated_at = now();
  get diagnostics n = row_count;
  perform ops.log(me.id, 'aged_action', 'wh_aged', null, p);
  return n;
end $$;

-- ------------------------------------------------------------ HR：资料缺漏
create or replace function public.ops_hr_gaps() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  pay boolean;
begin
  me := ops.require_level('hr', 'edit');
  pay := ops.level_rank(ops.module_level(me, 'payroll')) >= 1;
  return jsonb_build_object(
    'staff', (select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'branch', s.branch,
                'department_name', (select d.name from ops.department d where d.code = s.department),
                'missing', to_jsonb(array_remove(array[
                   case when s.join_date is null then 'join_date' end,
                   case when s.gender is null then 'gender' end,
                   case when coalesce(trim(s.phone), '') = '' then 'phone' end,
                   case when pay and not exists (select 1 from ops.pay_profile p where p.staff_id = s.id) then 'pay' end], null)))
              order by s.name), '[]'::jsonb)
              from ops.staff s
              where s.active and ops.sees_branch(me, s.branch)
                and (s.join_date is null or s.gender is null or coalesce(trim(s.phone), '') = ''
                     or (pay and not exists (select 1 from ops.pay_profile p where p.staff_id = s.id)))),
    'no_fence', (select coalesce(jsonb_agg(b order by b), '[]'::jsonb)
                 from unnest(array['HOMEWORKSSB', 'HOMEWORKSSOUTHERN']) b
                 where ops.sees_branch(me, b)
                   and exists (select 1 from ops.staff s where s.active and s.branch = b and not s.geofence_exempt)
                   and not exists (select 1 from ops.geofence g where g.branch = b and g.active)),
    'holidays_ahead', (select count(*) from ops.holiday h where h.date between ops.today() and ops.today() + 60),
    'last_holiday', (select max(h.date) from ops.holiday h));
end $$;

-- ------------------------------------------------------------ 首页（在仓库版 ops_home 上再加三项）
create or replace function public.ops_home() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  rec ops.attendance;
  wh int := ops.level_rank(ops.module_level(ops.current_staff(), 'warehouse'));
  po int := ops.level_rank(ops.module_level(ops.current_staff(), 'purchasing'));
  hr int := ops.level_rank(ops.module_level(ops.current_staff(), 'hr'));
  pay int := ops.level_rank(ops.module_level(ops.current_staff(), 'payroll'));
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
                        where h.date between ops.today() and ops.today() + 60) end
  );
end $$;

-- ------------------------------------------------------------ 权限
revoke all on function ops.wh_aged_rows(text) from public, anon, authenticated;
do $$
declare
  f text;
begin
  foreach f in array array['ops_wh_aged(jsonb)', 'ops_wh_aged_save(jsonb)', 'ops_hr_gaps()', 'ops_home()'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
revoke all on all tables in schema ops from public, anon, authenticated;
