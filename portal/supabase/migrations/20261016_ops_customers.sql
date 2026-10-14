-- 顾客资料模块（2026-10-14）：把 BI 的顾客资料页（loyalty.html）搬进营运系统，使用者：「我要把这个系统连接在员工多部门里面」，
-- 权限选「照部门权限」：
--   只看            = 看顾客名单、购买历史、跟进提醒、每月报告（不能改）
--   可编辑（销售 / 门市）= 再加：补资料、快速登记、WhatsApp / 已联络、装修进度
--   可审批（主管、管理层）= 再加：汇出同意名单 CSV、合并重复顾客、建促销活动、改 WhatsApp 范本
--   管理员           = 再加：改分级门槛与提醒天数、删除促销活动（= BI 的 owner）
-- 送货部不开（他们在「送货」就看得到这张 DO 的顾客名字、电话、地址）；其他部门看不到。
--
-- 资料**不搬家**：顾客资料、购买历史、扫码登记、活动都还在 BI 的 bi.customer_* 表，前端直接呼叫 BI 原本的 public.bi_customer* /
-- bi_campaign* / bi_wa_template* 函数（与 BI 网页共用同一份，两边改的互相看得到）。这些函数开头原本是 bi.customer_require(角色)
-- 只认 BI 名单（bi.allowed_users）；这里改成 bi.crm_require：BI 名单的人照旧，另外认营运系统员工的「顾客资料」模块权限
-- （管理员 → owner、可审批 → manager、可编辑 → sales、只看 → 只能叫读取的函数）。
-- 送货的 bi_delivery_* 与 BI 送货页用的 bi_customer_set_address / bi_customer_set_geo 不动（营运系统走 ops_dlv_*，有自己的权限）。
-- 「只看」只能叫下面 DO 段列出的读取函数（名单写死，不是看 STABLE：BI 以后改函数时不会意外把写入的函数开给只看的人）。
-- 模块开关 ready = false 的期间，营运系统的员工一律进不来（BI 名单的人照旧）；20261016b 打开。
--
-- **以后在 BI 改任何顾客资料函数，开头要写 bi.crm_require(…)，不要再用 bi.customer_require**，不然营运系统的员工会被挡掉
-- （挡掉 = 比较严，不会多开）；分店用 bi.crm_company()，不要用 public.bi_company()（营运系统的员工不在 BI 名单，会变成不限分店）。
-- 新的读取函数要给「只看」的人用，第二个参数给 true，并加进 DO 段的 v_read 名单。重套这个档会把漏掉的改过来（可以重复套用）。
-- 对 AutoCount 仍只读。模块上线开关（ops.module.ready）放在 20261016b_ops_customers_ready.sql，等前端部署好才套。

-- ------------------------------------------------------------ 模块与部门预设
insert into ops.module (key, name, phase, ready, sort, description) values
  ('customers', '顾客资料', 2, false, 65, '门市顾客名单、跟进提醒、一键 WhatsApp、顾客扫码登记、促销活动')
on conflict (key) do update set name = excluded.name, phase = excluded.phase, sort = excluded.sort,
                                description = excluded.description;
-- 只补没有的（管理员之后在「员工与权限」改过的不盖掉）
insert into ops.dept_module (department, module, level) values
  ('sales', 'customers', 'edit'), ('mgmt', 'customers', 'approve')
on conflict (department, module) do nothing;

-- ------------------------------------------------------------ 权限
-- 营运系统员工在顾客资料的角色：管理员 = owner、可审批 = manager、可编辑 = sales、只看 = viewer；不是员工 / 没开 = null
create or replace function bi.crm_ops_role() returns text
language plpgsql stable set search_path = '' as $$
declare
  me ops.staff := ops.current_staff();
begin
  -- 模块还没上线（前端还没部署）：营运系统的员工一律没有
  if me.id is null or not coalesce((select m.ready from ops.module m where m.key = 'customers'), false) then
    return null;
  end if;
  if me.role = 'admin' then
    return 'owner';
  end if;
  return case ops.module_level(me, 'customers')
           when 'approve' then 'manager' when 'edit' then 'sales' when 'view' then 'viewer' end;
end $$;

-- 取代 bi.customer_require：BI 名单的人照旧看 BI 角色；营运系统员工看「顾客资料」模块权限。
-- p_read_only = true（读取的函数）时「只看」的人也放行，但只限一般员工就能用的（角色清单有 sales 的）。
create or replace function bi.crm_require(p_roles text[], p_read_only boolean default false) returns text
language plpgsql stable set search_path = '' as $$
declare
  v_bi text;
  v_ops text := bi.crm_ops_role();
begin
  if coalesce((select public.bi_is_allowed()), false) then
    v_bi := (select public.bi_role());
    if coalesce(v_bi = any(p_roles), false) then
      return v_bi;
    end if;
  end if;
  if coalesce(v_ops = any(p_roles), false) then
    return v_ops;
  end if;
  if coalesce(v_ops = 'viewer' and p_read_only and 'sales' = any(p_roles), false) then
    return v_ops;
  end if;
  -- 营运系统的员工（不是 BI 顾客资料的角色）：用营运系统的说法，前端有英文
  if not coalesce(v_bi in ('owner', 'manager', 'sales'), false) and (ops.current_staff()).id is not null then
    if not ('manager' = any(p_roles)) then
      raise exception '这个动作只有管理员可以做。' using errcode = '42501';
    end if;
    raise exception '你没有「顾客资料」模块的%权限，请找管理员开通。',
      case when 'sales' = any(p_roles) then case when p_read_only then '查看' else '编辑' end else '审批' end
      using errcode = '42501';
  end if;
  raise exception '没有权限：顾客资料只开放给 %', array_to_string(p_roles, ' / ');
end $$;

-- 「没抓到电话的单据」限分店：BI 名单的人照 BI 的 company；营运系统员工照自己的分店（全部分店 = 不限）
create or replace function bi.crm_company() returns text
language plpgsql stable set search_path = '' as $$
declare
  me ops.staff;
begin
  if coalesce((select public.bi_is_allowed()), false)
     and coalesce((select public.bi_role()) in ('owner', 'manager', 'sales'), false) then
    return (select public.bi_company());
  end if;
  me := ops.current_staff();
  return case when me.id is null or me.branch = 'ALL' then null else me.branch end;
end $$;

revoke all on function bi.crm_ops_role() from public;
revoke all on function bi.crm_require(text[], boolean) from public;
revoke all on function bi.crm_company() from public;

-- 前端用：我在顾客资料是什么角色（决定显示哪些按钮；真正的检查在每个函数里）。两边都有就取高的。
create or replace function public.ops_cust_role() returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  v_bi text;
begin
  if coalesce((select public.bi_is_allowed()), false) then
    v_bi := (select public.bi_role());
  end if;
  return (select r from unnest(array[v_bi, bi.crm_ops_role()]) r
           where r in ('owner', 'manager', 'sales', 'viewer')
           order by array_position(array['owner', 'manager', 'sales', 'viewer'], r) limit 1);
end $$;
revoke all on function public.ops_cust_role() from public, anon;
grant execute on function public.ops_cust_role() to authenticated;

-- ------------------------------------------------------------ 顾客资料函数改用 bi.crm_require
-- 读出每个函数目前的定义，只把 bi.customer_require(array[…]) 换成 bi.crm_require(array[…][, true])、public.bi_company()
-- 换成 bi.crm_company()，其他一个字都不动（create or replace：拥有者、security definer、search_path、授权都保留）。
-- 送货的 bi_delivery_* 与 BI 送货页的 bi_customer_set_address / bi_customer_set_geo 不在范围内。
do $$
declare
  -- 「只看」可以叫的读取函数（还要是 STABLE 才算）；其他的只给可编辑以上
  v_read text[] := array['bi_customers', 'bi_customer', 'bi_customer_log', 'bi_customer_settings', 'bi_wa_templates',
                         'bi_customer_signups', 'bi_customer_monthly', 'bi_customer_agents', 'bi_customer_missing_phone',
                         'bi_campaigns', 'bi_campaign_members'];
  f record;
  def text;
  n int := 0;
begin
  for f in
    select p.oid, p.proname, p.provolatile
      from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = 'public'
       and p.prosrc like '%bi.customer_require(%'
       and (p.proname like 'bi\_customer%' or p.proname like 'bi\_campaign%' or p.proname like 'bi\_wa\_template%')
       and p.proname not in ('bi_customer_set_address', 'bi_customer_set_geo')
  loop
    def := pg_get_functiondef(f.oid);
    def := regexp_replace(def, 'bi\.customer_require\((array\[[^]]*\])\)',
             case when f.proname = any(v_read) and f.provolatile in ('s', 'i') then 'bi.crm_require(\1, true)'
                  else 'bi.crm_require(\1)' end, 'g');
    def := replace(def, 'public.bi_company()', 'bi.crm_company()');
    if def like '%bi.customer_require(%' or def like '%bi_company(%' then
      raise exception '% 里有认不得的 bi.customer_require / bi_company 写法，请手动改成 bi.crm_require / bi.crm_company',
        f.oid::regprocedure;
    end if;
    execute def;
    n := n + 1;
  end loop;
  raise notice '顾客资料函数改用 bi.crm_require：% 个', n;
end $$;
