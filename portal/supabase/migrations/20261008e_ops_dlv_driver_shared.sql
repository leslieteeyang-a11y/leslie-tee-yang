-- HomeWorks 营运系统 — 送货：两间分店共用的外包司机（2026-10-08，合并送货模块时的审查）
-- bi.delivery_driver.store 空白 = 两间分店共用（BI 旧送货页可以建）。原本 ops_dlv_driver_save 只检查「旧分店」不是空白时的权限，
-- 而且一律把 store 写成呼叫者的分店：只管 JB 的主管在自己的分页按「移除」，就会把共用司机钉到 JB 并停用，总部那边也不见了。
-- 改成：共用司机只有管全部分店（branch = ALL）的人能改，改了仍保持共用。其余与 20261008b 相同。可以重复套用。

create or replace function public.ops_dlv_driver_save(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  c text;
  v_id bigint := nullif(p ->> 'id', '')::bigint;
  v_name text := nullif(trim(coalesce(p ->> 'name', '')), '');
  v_phone text := bi.customer_phone(p ->> 'phone');
  v_old text;
begin
  me := ops.require_level('delivery', 'approve');
  c := ops.dlv_check_company(me, p ->> 'company');
  if v_name is null or v_phone is null then
    raise exception '司机要有名字和完整手机号码。';
  end if;
  if v_id is null then
    insert into bi.delivery_driver (name, phone, store, active, updated_by)
    values (v_name, v_phone, ops.dlv_store(c), coalesce((p ->> 'active')::boolean, true), me.email)
    returning id into v_id;
  else
    select x.store into v_old from bi.delivery_driver x where x.id = v_id;
    if not found then
      raise exception '找不到司机 #%。', v_id;
    end if;
    if v_old is not null and not ops.sees_company(me, ops.dlv_company(v_old)) then
      raise exception '你没有这间分店的送货权限。' using errcode = '42501';
    end if;
    -- 两间分店共用的外包司机（store 空白，BI 旧页面建的）：只有管全部分店的人能改；改了也保持共用，不会被钉到某一间
    if v_old is null and coalesce(me.branch, '') <> 'ALL' then
      raise exception '这位外包司机两间分店共用，只有管理全部分店的人能改。' using errcode = '42501';
    end if;
    update bi.delivery_driver
       set name = v_name, phone = v_phone, store = case when v_old is null then null else ops.dlv_store(c) end, active = coalesce((p ->> 'active')::boolean, true),
           updated_at = now(), updated_by = me.email
     where id = v_id;
  end if;
  perform ops.log(me.id, 'dlv_driver', 'delivery_driver', v_id, jsonb_build_object('name', v_name, 'company', c));
  return (select jsonb_build_object('kind', 'ext', 'id', x.id, 'name', x.name, 'phone', x.phone, 'store', x.store, 'active', x.active)
            from bi.delivery_driver x where x.id = v_id);
end $$;
