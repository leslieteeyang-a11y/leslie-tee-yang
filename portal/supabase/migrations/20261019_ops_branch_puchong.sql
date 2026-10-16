-- KL Puchong 分店（2026-10-16，使用者：「全部功能，跟 JB 分店一样，它是其中一家分店」；Puchong 用店里自己的电脑开单，跟 JB 一样）
-- 分店代号 HOMEWORKSPUCHONG（= Puchong 账套；以后 Puchong 电脑跑同步时 autocount.json 的 supabase.company 填这个）。
-- 门市代号（送货 bi.delivery_run.store / 出发点 depot / 外包司机）= PUCHONG。
-- ① 所有只认 HOMEWORKSSB / HOMEWORKSSOUTHERN 的 check constraint 加 HOMEWORKSPUCHONG（照现有定义替换，名称不变）
-- ② 只认两间分店的函数加第三间（函数本体照原样，只改分店清单）
-- ③ ops.outlet PUCHONG 改成 Puchong 自己的公司与员工分店（总部账套的 PUCHONG / PRE (PUCHONG) 仓位照旧算 Puchong 寄存，跟 JB 一样）
-- ④ BI 同步接收函数 bi_quote_upsert / bi_delivery_doc_upsert 收 HOMEWORKSPUCHONG（本体在 BI 分支，这里只替换公司清单）

-- ==== ① constraints
do $$
declare r record;
begin
  for r in select c.conrelid::regclass::text as t, c.conname, pg_get_constraintdef(c.oid) as d
             from pg_constraint c
            where c.connamespace = 'ops'::regnamespace and c.contype = 'c'
              and pg_get_constraintdef(c.oid) like '%''HOMEWORKSSOUTHERN''::text%'
              and pg_get_constraintdef(c.oid) not like '%HOMEWORKSPUCHONG%' loop
    execute format('alter table %s drop constraint %I, add constraint %I %s', r.t, r.conname, r.conname,
                   replace(r.d, '''HOMEWORKSSOUTHERN''::text', '''HOMEWORKSSOUTHERN''::text, ''HOMEWORKSPUCHONG''::text'));
  end loop;
  for r in select c.conrelid::regclass::text as t, c.conname, pg_get_constraintdef(c.oid) as d
             from pg_constraint c
            where c.conrelid = to_regclass('bi.delivery_driver') and c.contype = 'c'
              and pg_get_constraintdef(c.oid) like '%''JB''::text%' and pg_get_constraintdef(c.oid) not like '%PUCHONG%' loop
    execute format('alter table %s drop constraint %I, add constraint %I %s', r.t, r.conname, r.conname,
                   replace(r.d, '''JB''::text', '''JB''::text, ''PUCHONG''::text'));
  end loop;
end $$;

-- ==== ② functions
CREATE OR REPLACE FUNCTION ops.dlv_check_company(p_me ops.staff, p_company text)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
declare
  c text := coalesce(nullif(p_company, ''), case when p_me.branch = 'ALL' then 'HOMEWORKSSB' else p_me.branch end);
begin
  if c not in ('HOMEWORKSSB', 'HOMEWORKSSOUTHERN', 'HOMEWORKSPUCHONG') or not ops.sees_company(p_me, c) then
    raise exception '你没有这间分店的送货权限。' using errcode = '42501';
  end if;
  return c;
end $function$

;

CREATE OR REPLACE FUNCTION ops.dlv_company(p_store text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select case p_store when 'HQ' then 'HOMEWORKSSB' when 'JB' then 'HOMEWORKSSOUTHERN' when 'PUCHONG' then 'HOMEWORKSPUCHONG' end
$function$

;

CREATE OR REPLACE FUNCTION ops.dlv_store(p_company text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select case p_company when 'HOMEWORKSSB' then 'HQ' when 'HOMEWORKSSOUTHERN' then 'JB' when 'HOMEWORKSPUCHONG' then 'PUCHONG' end
$function$

;

CREATE OR REPLACE FUNCTION ops.podo_company(p_me ops.staff, p_company text)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
declare
  c text := coalesce(nullif(p_company, ''), case when p_me.branch = 'ALL' then 'HOMEWORKSSB' else p_me.branch end);
begin
  if c not in ('HOMEWORKSSB', 'HOMEWORKSSOUTHERN', 'HOMEWORKSPUCHONG') or not ops.sees_company(p_me, c) then
    raise exception '请选择你分店的公司。' using errcode = '42501';
  end if;
  return c;
end $function$

;

CREATE OR REPLACE FUNCTION ops.rpl_company(p_me ops.staff, p_company text)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
declare
  c text := coalesce(nullif(p_company, ''), case when p_me.branch = 'ALL' then 'HOMEWORKSSB' else p_me.branch end);
begin
  if c not in ('HOMEWORKSSB', 'HOMEWORKSSOUTHERN', 'HOMEWORKSPUCHONG') or not ops.sees_company(p_me, c) then
    raise exception '你没有这间分店的订货权限。' using errcode = '42501';
  end if;
  return c;
end $function$

;

CREATE OR REPLACE FUNCTION ops.wh_company(p_me ops.staff, p_company text)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
declare
  c text := coalesce(nullif(p_company, ''), case when p_me.branch = 'ALL' then 'HOMEWORKSSB' else p_me.branch end);
begin
  if c not in ('HOMEWORKSSB', 'HOMEWORKSSOUTHERN', 'HOMEWORKSPUCHONG') or not ops.sees_company(p_me, c) then
    raise exception '你没有这间分店的仓库权限。' using errcode = '42501';
  end if;
  return c;
end $function$

;

CREATE OR REPLACE FUNCTION public.ops_dlv_meta()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  me ops.staff;
  v_depot jsonb := coalesce((select s.depot from bi.customer_settings s where s.id = 1), '{}'::jsonb);
begin
  me := ops.require_level('delivery', 'view');
  return jsonb_build_object(
    'level', ops.module_level(me, 'delivery'),
    'me_id', me.id,
    'companies', (select jsonb_agg(c order by c) from unnest(array['HOMEWORKSSB', 'HOMEWORKSSOUTHERN', 'HOMEWORKSPUCHONG']) c
                  where ops.sees_company(me, c)),
    'depot', (select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) from jsonb_each(v_depot) e
              where ops.sees_company(me, ops.dlv_company(e.key))),
    'drivers', ops.dlv_drivers(me),
    'synced', (select max(d.synced_at) from bi.delivery_doc d where ops.sees_company(me, d.company)));
end $function$

;

CREATE OR REPLACE FUNCTION public.ops_hr_gaps()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
                 from unnest(array['HOMEWORKSSB', 'HOMEWORKSSOUTHERN', 'HOMEWORKSPUCHONG']) b
                 where ops.sees_branch(me, b)
                   and exists (select 1 from ops.staff s where s.active and s.branch = b and not s.geofence_exempt)
                   and not exists (select 1 from ops.geofence g where g.branch = b and g.active)),
    'holidays_ahead', (select count(*) from ops.holiday h where h.date between ops.today() and ops.today() + 60),
    'last_holiday', (select max(h.date) from ops.holiday h));
end $function$

;

CREATE OR REPLACE FUNCTION public.ops_join_decide(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  me ops.staff;
  r ops.join_request;
  s ops.staff;
  br text := coalesce(nullif(p->>'branch', ''), 'HOMEWORKSSB');
  rl text := coalesce(nullif(p->>'role', ''), 'staff');
  how text := 'new';
begin
  me := ops.require_level('admin', 'approve');
  select * into r from ops.join_request where id = (p->>'id')::bigint for update;
  if r.id is null or r.status <> 'pending' then
    raise exception '找不到这张申请，或已经处理过了。' using errcode = 'P0002';
  end if;
  if not coalesce((p->>'approve')::boolean, false) then
    update ops.join_request set status = 'rejected', pw_hash = null, decided_by = me.id, decided_at = now(),
      decide_note = left(trim(coalesce(p->>'note', '')), 300), updated_at = now()
    where id = r.id;
    perform ops.log(me.id, 'join_reject', 'join_request', r.id, p);
    return jsonb_build_object('id', r.id, 'status', 'rejected', 'need_account', false);
  end if;
  if not exists (select 1 from ops.department d where d.code = p->>'department') then
    raise exception '请选部门。' using errcode = '22023';
  end if;
  if br not in ('HOMEWORKSSB', 'HOMEWORKSSOUTHERN', 'HOMEWORKSPUCHONG', 'ALL') then
    raise exception '分店不对。' using errcode = '22023';
  end if;
  if rl not in ('staff', 'manager') then
    raise exception '角色只能是员工或主管。' using errcode = '22023';
  end if;
  select * into s from ops.staff x where lower(x.email) = lower(r.email) for update;
  if s.id is null then
    insert into ops.staff (email, name, department, branch, role, title, phone, active, gender, join_date)
    values (lower(r.email), r.name, p->>'department', br, rl, left(trim(coalesce(p->>'title', '')), 60),
            r.phone, true, r.gender, r.join_date)
    returning * into s;
  elsif not s.active then
    -- 复职：用这次批准选的部门 / 分店 / 角色，到职日换新的
    how := 'rehire';
    update ops.staff set active = true, name = r.name, department = p->>'department', branch = br,
      role = case when role = 'admin' then role else rl end,
      title = coalesce(nullif(left(trim(coalesce(p->>'title', '')), 60), ''), title),
      phone = coalesce(nullif(r.phone, ''), phone), gender = coalesce(r.gender, gender),
      join_date = coalesce(r.join_date, join_date), updated_at = now()
    where id = s.id returning * into s;
  else
    -- 申请期间管理员已经从名单 / Excel 加了这个人：只补空白的资料，不动部门与权限
    how := 'linked';
    update ops.staff set phone = case when coalesce(trim(phone), '') = '' then r.phone else phone end,
      gender = coalesce(gender, r.gender), join_date = coalesce(join_date, r.join_date), updated_at = now()
    where id = s.id returning * into s;
  end if;
  update ops.join_request set status = 'approved', staff_id = s.id, decided_by = me.id, decided_at = now(),
    decide_note = left(trim(coalesce(p->>'note', '')), 300), updated_at = now()
  where id = r.id;
  perform ops.log(me.id, 'join_approve', 'staff', s.id, p || jsonb_build_object('how', how));
  return jsonb_build_object('id', r.id, 'status', 'approved', 'staff_id', s.id, 'how', how,
                            'need_account', r.pw_hash is not null);
end $function$

;

CREATE OR REPLACE FUNCTION public.ops_join_submit(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  em text := lower(trim(coalesce(p->>'email', '')));
  nm text := trim(coalesce(p->>'name', ''));
  acct boolean := coalesce((p->>'has_account')::boolean, false);
  hash text := nullif(p->>'pw_hash', '');
  ip text := left(trim(coalesce(p->>'client_ip', '')), 64);
  jd date;
  r ops.join_request;
begin
  if not public.ops_join_check(p->>'code') then
    raise exception '加入链接已失效，请向管理员要新的链接。' using errcode = '42501';
  end if;
  if em !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or length(em) > 200 then
    raise exception 'email 格式不对。' using errcode = '22023';
  end if;
  if length(nm) = 0 or length(nm) > 80 then
    raise exception '请填名字。' using errcode = '22023';
  end if;
  if coalesce(p->>'gender', '') not in ('', 'M', 'F') then
    raise exception '性别只能是男或女。' using errcode = '22023';
  end if;
  if coalesce(p->>'branch', '') not in ('', 'HOMEWORKSSB', 'HOMEWORKSSOUTHERN', 'HOMEWORKSPUCHONG') then
    raise exception '上班地点不对。' using errcode = '22023';
  end if;
  begin
    jd := nullif(p->>'join_date', '')::date;
  exception when others then
    raise exception '到职日格式不对。' using errcode = '22023';
  end;
  if exists (select 1 from ops.staff s where lower(s.email) = em and s.active) then
    raise exception '这个 email 已经在员工名单里了，请直接登入；忘了密码请找管理员。' using errcode = '23505';
  end if;
  if exists (select 1 from ops.join_request x where lower(x.email) = em and x.status = 'pending') then
    raise exception '这个 email 已经送出过申请，正在等管理员处理。资料要改请直接找管理员。' using errcode = '23505';
  end if;
  if not acct then
    if exists (select 1 from bi.allowed_users a where lower(a.email) = em) then
      raise exception '这个 email 的账号要由管理员开，请直接找管理员。' using errcode = '42501';
    end if;
    if hash is null or hash !~ '^\$2[aby]\$\d\d\$.{53}$' then
      raise exception '密码处理失败，请再送一次。' using errcode = '22023';
    end if;
  else
    hash := null;
  end if;
  if ip <> '' and (select count(*) from ops.join_request x
                   where x.client_ip = ip and x.created_at > now() - interval '1 hour') >= 5 then
    raise exception '送出太多次了，请一个小时后再试。' using errcode = '54000';
  end if;
  if (select count(*) from ops.join_request where status = 'pending') >= 200 then
    raise exception '申请太多了，请等管理员处理后再送。' using errcode = '54000';
  end if;
  insert into ops.join_request (email, name, phone, gender, join_date, branch, note, pw_hash, has_account, client_ip)
  values (em, nm, left(trim(coalesce(p->>'phone', '')), 30), nullif(p->>'gender', ''), jd, nullif(p->>'branch', ''),
          left(trim(coalesce(p->>'note', '')), 300), hash, acct, ip)
  returning * into r;
  return jsonb_build_object('id', r.id, 'email', r.email, 'has_account', r.has_account);
end $function$

;

CREATE OR REPLACE FUNCTION public.ops_po_file_ok(p_name text, p_write boolean)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  me ops.staff := ops.current_staff();
  c text := split_part(coalesce(p_name, ''), '/', 1);
begin
  return coalesce(me.id is not null and c in ('HOMEWORKSSB', 'HOMEWORKSSOUTHERN', 'HOMEWORKSPUCHONG') and ops.sees_company(me, c)
                  and (ops.level_rank(ops.module_level(me, 'purchasing')) >= 2
                       or (not coalesce(p_write, true) and ops.level_rank(ops.module_level(me, 'warehouse')) >= 2
                           and ops.sees_supplier(me))), false);
end $function$

;

CREATE OR REPLACE FUNCTION public.ops_rpl_meta(p_company text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  me ops.staff;
  c text;
  sup boolean;
begin
  me := ops.require_level('purchasing', 'view');
  c := ops.rpl_company(me, p_company);
  sup := ops.sees_supplier(me);
  return jsonb_build_object(
    'company', c,
    'level', ops.module_level(me, 'purchasing'),
    'can_edit', ops.level_rank(ops.module_level(me, 'purchasing')) >= 2,
    'prices', ops.sees_prices(me),
    'supplier', sup,
    'companies', (select jsonb_agg(x order by x) from unnest(array['HOMEWORKSSB', 'HOMEWORKSSOUTHERN', 'HOMEWORKSPUCHONG']) x where ops.sees_company(me, x)),
    'synced_at', ops.wh_synced_at(c),
    -- 厂号 = 商品最近一张 PO 供应商名称里的 CSxxx；件数 = 三个门槛下会载入几项（没货 / 欠分行的不受门槛限制）
    'cs_codes', case when sup then (
      select coalesce(jsonb_agg(jsonb_build_object('cs_code', t.cs_code, 'items', t.items, 'loaded10', t.loaded10,
                                                   'loaded30', t.loaded30, 'loaded100', t.loaded100)
                                order by substring(t.cs_code from '[0-9]+')::int, t.cs_code), '[]'::jsonb)
      from (select v.cs_code,
                   count(*) filter (where not v.exclude) as items,
                   count(*) filter (where not v.exclude and (v.q90 >= 10 or v.owed_branch > 0 or v.on_hand <= 0)) as loaded10,
                   count(*) filter (where not v.exclude and (v.q90 >= 30 or v.owed_branch > 0 or v.on_hand <= 0)) as loaded30,
                   count(*) filter (where not v.exclude and (v.q90 >= 100 or v.owed_branch > 0 or v.on_hand <= 0)) as loaded100
            from bi.v_purchase_suggest v where v.company = c and v.cs_code is not null group by v.cs_code) t)
      else '[]'::jsonb end,
    'due_suppliers', case when sup then (
      select coalesce(jsonb_agg(jsonb_build_object('creditor_code', s.creditor_code, 'name', s.name,
                                                   'days_since_po', s.days_since_po, 'order_cycle_days', s.order_cycle_days)
                                order by s.days_since_po desc nulls last), '[]'::jsonb)
      from bi.v_supplier_param s where s.company = c and coalesce(s.order_due, false))
      else '[]'::jsonb end);
end $function$

;

CREATE OR REPLACE FUNCTION public.ops_sync_status()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  me ops.staff;
begin
  me := ops.require_staff();
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
             'company', c.company,
             'purchase', (select max(s.finished_at) from bi.sync_log s
                          where s.ok and s.step = 'purchase:' || c.company || ':load'),
             'stock', (select max(s.finished_at) from bi.sync_log s
                       where s.ok and s.step = 'stock:' || c.company || ':load'))
           order by c.company), '[]'::jsonb)
    from (values ('HOMEWORKSSB'), ('HOMEWORKSSOUTHERN'), ('HOMEWORKSPUCHONG')) c(company)
    where ops.sees_company(me, c.company)
      -- 还没开始同步的分店（Puchong 电脑还没装）只给那间分店自己的人看，不然管理层的提示一直显示「超过一天没更新」
      and (me.branch = c.company or exists (select 1 from bi.sync_log s where s.ok and s.step in ('purchase:' || c.company || ':load',
                                                                                                'stock:' || c.company || ':load')))
  );
end $function$

;

CREATE OR REPLACE FUNCTION public.ops_wh_file_ok(p_name text, p_write boolean)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  me ops.staff := ops.current_staff();
  c text := split_part(coalesce(p_name, ''), '/', 2);
begin
  return coalesce(me.id is not null and split_part(coalesce(p_name, ''), '/', 1) = 'items'
                  and c in ('HOMEWORKSSB', 'HOMEWORKSSOUTHERN', 'HOMEWORKSPUCHONG') and ops.sees_company(me, c)
                  and ops.level_rank(ops.module_level(me, 'warehouse')) >= case when coalesce(p_write, true) then 2 else 1 end,
                  false);
end $function$

;

CREATE OR REPLACE FUNCTION public.ops_wh_home()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  me ops.staff;
  lvl int;
  sh jsonb;
begin
  me := ops.require_staff();
  lvl := ops.level_rank(ops.module_level(me, 'warehouse'));
  if lvl < 1 then
    return jsonb_build_object('picks_left', null, 'sheets', '[]'::jsonb, 'bins_over', null);
  end if;
  sh := case when lvl >= 2 then public.ops_wh_sheet_home() else '[]'::jsonb end;
  return jsonb_build_object(
    'picks_left', case when lvl >= 2 then (
      select coalesce(sum((x.j->>'today')::int - (x.j->>'today_done')::int), 0)
      from unnest(array['HOMEWORKSSB', 'HOMEWORKSSOUTHERN', 'HOMEWORKSPUCHONG']) c,
           lateral (select ops.wh_pick_summary(c) j offset 0) x
      where ops.sees_company(me, c)) end,
    'sheets', coalesce(sh, '[]'::jsonb),
    'bins_over', case when lvl >= 3 then (
      select coalesce(sum((b->>'items_over')::int), 0)
      from unnest(array['HOMEWORKSSB', 'HOMEWORKSSOUTHERN', 'HOMEWORKSPUCHONG']) c, jsonb_array_elements(ops.wh_bin_summary(c)) b
      where ops.sees_company(me, c)) end);
end $function$

;

CREATE OR REPLACE FUNCTION public.ops_wh_meta()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  me ops.staff;
begin
  me := ops.require_level('warehouse', 'view');
  return jsonb_build_object(
    'level', ops.module_level(me, 'warehouse'),
    'companies', (select jsonb_agg(c order by c) from unnest(array['HOMEWORKSSB', 'HOMEWORKSSOUTHERN', 'HOMEWORKSPUCHONG']) c
                  where ops.sees_company(me, c)),
    'locations', (select coalesce(jsonb_agg(to_jsonb(l) order by l.company, l.sort, l.code), '[]'::jsonb)
                  from ops.wh_location l where ops.sees_company(me, l.company)),
    'synced', (select jsonb_object_agg(c, ops.wh_synced_at(c)) from unnest(array['HOMEWORKSSB', 'HOMEWORKSSOUTHERN', 'HOMEWORKSPUCHONG']) c
               where ops.sees_company(me, c)));
end $function$

;

CREATE OR REPLACE FUNCTION public.ops_wh_pick_status(p_company text, p_doc_nos text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  me ops.staff;
  c text;
begin
  me := ops.require_staff();
  if not coalesce(ops.level_rank(ops.module_level(me, 'warehouse')) >= 1
                  or ops.level_rank(ops.module_level(me, 'delivery')) >= 1, false) then
    raise exception '你没有「仓库」或「送货」模块的查看权限，请找管理员开通。' using errcode = '42501';
  end if;
  c := coalesce(nullif(p_company, ''), case when me.branch = 'ALL' then 'HOMEWORKSSB' else me.branch end);
  if c not in ('HOMEWORKSSB', 'HOMEWORKSSOUTHERN', 'HOMEWORKSPUCHONG') or not coalesce(ops.sees_company(me, c), false) then
    raise exception '你没有这间分店的权限。' using errcode = '42501';
  end if;
  if coalesce(array_length(p_doc_nos, 1), 0) > 500 then
    raise exception '一次最多 500 张单。' using errcode = '22023';
  end if;
  return coalesce((
    select jsonb_object_agg(k.doc_no, jsonb_build_object(
      'status', k.status, 'done_at', k.done_at,
      'picked', (select coalesce(sum(least(l.picked, l.qty)), 0) from ops.wh_pick_line l where l.pick_id = k.id and not l.skip),
      'total', (select coalesce(sum(l.qty), 0) from ops.wh_pick_line l where l.pick_id = k.id and not l.skip)))
    from ops.wh_pick k
    where k.company = c and k.status <> 'cancelled' and k.doc_no = any(coalesce(p_doc_nos, array[]::text[]))), '{}'::jsonb);
end $function$

;

-- ==== ③ outlet
update ops.outlet set company = 'HOMEWORKSPUCHONG', staff_branch = 'HOMEWORKSPUCHONG'
 where code = 'PUCHONG' and company is distinct from 'HOMEWORKSPUCHONG';

-- ==== ④ BI 同步接收
do $$
declare r record;
begin
  for r in select p.oid, pg_get_functiondef(p.oid) as d from pg_proc p
            where p.oid in (select to_regprocedure(x) from unnest(array['public.bi_quote_upsert(text,jsonb)',
                                                                        'public.bi_delivery_doc_upsert(text,jsonb)']) x)
              and p.prosrc not like '%HOMEWORKSPUCHONG%' loop
    execute replace(replace(r.d, '(''HOMEWORKSSB'', ''HOMEWORKSSOUTHERN'')', '(''HOMEWORKSSB'', ''HOMEWORKSSOUTHERN'', ''HOMEWORKSPUCHONG'')'),
                    'HOMEWORKSSB / HOMEWORKSSOUTHERN', 'HOMEWORKSSB / HOMEWORKSSOUTHERN / HOMEWORKSPUCHONG');
  end loop;
end $$;
