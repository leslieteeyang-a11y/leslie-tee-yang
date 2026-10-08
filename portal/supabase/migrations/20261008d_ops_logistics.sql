-- HomeWorks 营运系统 — 物流部（使用者 2026-10-08 决定）
--   * 新部门「物流部」（代号 logistics）：送货 / 当司机（送货可编辑）、仓库（可编辑）、订货到货跟进（订货只看），
--     加上每个部门都有的首页、任务、审批、打卡、请假。之后可在「员工与权限 → 部门权限」改。
--   * 「送货安装」部门改名「送货部」（代号仍是 delivery，原有权限不动；模块名称「送货安装」不变）。
--   * 员工司机 = 送货部或物流部、有手机号码的在职员工（原本只认送货部）：改 ops.dlv_drivers 与 ops_dlv_run_save 的部门条件，
--     其余内容与 20261008b_ops_delivery.sql 相同。
-- 可以重复套用；不含会被 Supabase MCP 挡下的指令。

insert into ops.department (code, name, sort) values ('logistics', '物流部', 55)
on conflict (code) do update set name = excluded.name, sort = excluded.sort;
update ops.department set name = '送货部' where code = 'delivery';

insert into ops.dept_module (department, module, level) values
  ('logistics', 'dashboard', 'view'), ('logistics', 'tasks', 'edit'), ('logistics', 'approvals', 'edit'),
  ('logistics', 'attendance', 'edit'), ('logistics', 'leave', 'edit'),
  ('logistics', 'delivery', 'edit'), ('logistics', 'warehouse', 'edit'), ('logistics', 'purchasing', 'view')
on conflict (department, module) do nothing;

-- 哪些部门的员工可以当司机
create or replace function ops.dlv_driver_dept(p_department text) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(p_department in ('delivery', 'logistics'), false)
$$;

create or replace function ops.dlv_drivers(p_me ops.staff) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(d order by d ->> 'kind' desc, d ->> 'name'), '[]'::jsonb) from (
    select jsonb_build_object('kind', 'staff', 'id', s.id, 'name', s.name, 'phone', bi.customer_phone(s.phone),
                              'store', ops.dlv_store(s.branch)) d
      from ops.staff s
     where s.active and ops.dlv_driver_dept(s.department) and bi.customer_phone(s.phone) is not null
       and (s.branch = 'ALL' or ops.sees_company(p_me, s.branch))
    union all
    select jsonb_build_object('kind', 'ext', 'id', x.id, 'name', x.name, 'phone', x.phone, 'store', x.store)
      from bi.delivery_driver x
     where x.active and (x.store is null or ops.sees_company(p_me, ops.dlv_company(x.store)))
  ) q
$$;

create or replace function public.ops_dlv_run_save(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  c text;
  v_stops jsonb := p -> 'stops';
  v_token text := nullif(p ->> 'token', '');
  v_kind text := nullif(p ->> 'driver_kind', '');
  v_driver bigint := nullif(p ->> 'driver_id', '')::bigint;
  v_name text;
  v_phone text;
  v_staff bigint;
  v_id bigint;
begin
  me := ops.require_level('delivery', 'edit');
  c := ops.dlv_check_company(me, p ->> 'company');
  if jsonb_typeof(v_stops) is distinct from 'array' or jsonb_array_length(v_stops) = 0 then
    raise exception '还没有要送的单。';
  end if;
  if jsonb_array_length(v_stops) > 100 then
    raise exception '一趟最多 100 站。';
  end if;
  if exists (select 1 from jsonb_array_elements(v_stops) s where nullif(s ->> 'key', '') is null) then
    raise exception '排单资料不完整，请重新整理页面再排一次。';
  end if;
  if v_token is null or length(v_token) < 20 or v_token !~ '^[A-Za-z0-9_-]+$' then
    raise exception '连结代码不对，请重新整理页面再按一次。';
  end if;
  v_stops := (select jsonb_agg(s - 'note' order by o) from jsonb_array_elements(v_stops) with ordinality t(s, o));   -- 不存内部备注
  if v_kind = 'staff' then
    select s.name, bi.customer_phone(s.phone), s.id into v_name, v_phone, v_staff
      from ops.staff s
     where s.id = v_driver and s.active and ops.dlv_driver_dept(s.department) and bi.customer_phone(s.phone) is not null
       and (s.branch = 'ALL' or s.branch = c);
    if v_staff is null then
      raise exception '这位司机不在送货部 / 物流部、没有手机号码、已停用，或不属于这间分店。';
    end if;
  elsif v_kind = 'ext' then
    select x.name, x.phone into v_name, v_phone
      from bi.delivery_driver x
     where x.id = v_driver and x.active and (x.store is null or x.store = ops.dlv_store(c));
    if v_name is null then
      raise exception '找不到这位司机，或他不属于这间分店。';
    end if;
  elsif v_kind is not null then
    raise exception '未知的司机种类：%', v_kind;
  end if;
  insert into bi.delivery_run (store, driver_name, driver_phone, driver_staff_id, stops, created_by, token, token_expires)
  values (ops.dlv_store(c), v_name, v_phone, v_staff, v_stops, me.email, v_token, now() + interval '3 days')
  returning id into v_id;
  perform ops.log(me.id, 'dlv_run', 'delivery_run', v_id,
                  jsonb_build_object('company', c, 'stops', jsonb_array_length(v_stops), 'driver', v_name));
  return jsonb_build_object('id', v_id);
end $$;

revoke all on function ops.dlv_driver_dept(text) from public, anon, authenticated;
revoke all on function ops.dlv_drivers(ops.staff) from public, anon, authenticated;
revoke all on function public.ops_dlv_run_save(jsonb) from public, anon;
grant execute on function public.ops_dlv_run_save(jsonb) to authenticated;
