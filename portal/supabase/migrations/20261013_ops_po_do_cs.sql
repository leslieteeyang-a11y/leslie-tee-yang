-- 营运系统：厂家到货可以用 CS 编号找 PO。套用到 Supabase 的 migration 名称：ops_po_do_cs
-- 使用者 2026-10-13：中国厂在 AutoCount 是开在代理户口下（例：4000-M002 MULTI GLOBE 有 91 张未到 PO、41 种 CS 编号），
-- 工厂代号 CSxxx 只写在 PO 的厂家名称栏（「CS028」「CS028 (ETA)」「( CS022 )」「MAIDEN SQUARE SDN BHD (CS040)」）。
-- 选厂家时要能打 CS 编号找到代理；选 PO 时每张显示 CS 编号与原本的厂家名称（订货员会在那里写备注）。
-- 只是在 ops_po_do_suppliers 多回 factories、ops_po_do_pos 多回 creditor_name / factory；其他照旧。
-- 同一天使用者又说：分行不能看到 CS / 厂家是谁，只要搜得到这个产品来了多少、ETA；再问「总部门市、电商、物流也看不到吗」→「也看不到」。
-- 规则 ops.sees_supplier：订货「可编辑」（采购、管理层）或仓库部的人才看得到厂家。厂家到货、CS 搜寻本来就只有订货「可编辑」；
-- 「在路上」：看得到厂家、而且是总部（含 ALL）的人才回厂家、DO 号、PO 号、货柜名称（full = true），其他人资料库就不回、
-- 搜寻也只找型号 / 品名。未到货 PO、货柜、查 SKU 到货、仓库查商品、首页到货提醒在 20261013b_ops_supplier_privacy.sql。

-- 谁看得到厂家（含 CS 编号）：订货「可编辑」（采购、管理层，含个人例外）或仓库部
create or replace function ops.sees_supplier(p_staff ops.staff) returns boolean
language sql stable set search_path = '' as $$
  select coalesce(ops.level_rank(ops.module_level(p_staff, 'purchasing')) >= 2 or p_staff.department = 'warehouse', false)
$$;

create or replace function ops.require_supplier(p_staff ops.staff) returns void
language plpgsql stable set search_path = '' as $$
begin
  if not ops.sees_supplier(p_staff) then
    raise exception '未到货 PO 与货柜有厂家资料，只有采购、管理层与仓库部看得到；要查货什么时候到，请用「查 SKU 到货」或「在路上」。'
      using errcode = '42501';
  end if;
end $$;

-- 厂家名称里的 CS 编号：CS 要在字首（PLASTICS 2020、DOCS2026 不算），中间可有空白或 -，数字补到 3 位：
-- 「( cs 22 )」→ CS022、「CS028 (ETA)」→ CS028、「CS-028」→ CS028；没有 = null
create or replace function ops.podo_cs(p_name text) returns text
language sql immutable set search_path = '' as $$
  select case when d is null then null when length(d) < 3 then 'CS' || lpad(d, 3, '0') else 'CS' || d end
  from (select regexp_replace(substring(coalesce(p_name, '') from '\m[Cc][Ss][ -]*[0-9]{2,}'), '[^0-9]', '', 'g') as d) x
$$;

create or replace function public.ops_po_do_suppliers(p_company text default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  c text;
begin
  me := ops.require_level('purchasing', 'edit');
  c := ops.podo_company(me, p_company);
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
             'company', c, 'creditor_code', x.creditor_code, 'supplier_name', x.supplier_name, 'is_china', x.is_china,
             'po_count', x.po_count, 'open_qty', x.open_qty, 'last_po_date', x.last_po_date,
             'factories', to_jsonb(x.factories),
             'drafts', (select count(*) from ops.supplier_do d where d.company = c and d.creditor_code = x.creditor_code
                        and d.status = 'draft'))
           order by x.supplier_name, x.creditor_code), '[]'::jsonb)
    from (select v.creditor_code, min(v.supplier_name) as supplier_name, bool_or(v.is_china) as is_china,
                 count(*) as po_count, sum(v.open_qty) as open_qty, max(v.po_date) as last_po_date,
                 coalesce(array_agg(distinct ops.podo_cs(v.creditor_name) order by ops.podo_cs(v.creditor_name))
                            filter (where ops.podo_cs(v.creditor_name) is not null), '{}') as factories
          from ops.v_po_open v where v.company = c and v.status <> 'closed'
          group by v.creditor_code) x
  );
end $$;

create or replace function public.ops_po_do_pos(p_company text, p_creditor_code text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  c text;
begin
  me := ops.require_level('purchasing', 'edit');
  c := ops.podo_company(me, p_company);
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
             'po_no', v.po_no, 'po_date', v.po_date, 'days_open', v.days_open, 'status', v.status,
             'closed', v.status = 'closed', 'eta', v.eta, 'eta_source', v.eta_source, 'lines', v.lines,
             'creditor_name', coalesce(v.creditor_name, ''), 'factory', ops.podo_cs(v.creditor_name),
             'open_qty', v.open_qty, 'in_transit', coalesce(t.in_transit, 0),
             'remaining', v.open_qty - coalesce(t.in_transit, 0), 'outlets', coalesce(t.outlets, '[]'::jsonb),
             'dos', (select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'do_no', d.do_no, 'status', d.status)
                                               order by d.id), '[]'::jsonb)
                     from ops.supplier_do d where d.company = c and d.po_nos @> array[v.po_no]
                       and d.status in ('draft', 'confirmed')))
           order by v.po_date, v.po_no), '[]'::jsonb)
    from ops.v_po_open v
    left join (select ln.po_no, sum(ln.in_transit) as in_transit, to_jsonb(array_agg(distinct ln.outlet)) as outlets
               from ops.podo_lines(c, p_creditor_code, null, null) ln where ln.open_qty > 0
               group by ln.po_no) t on t.po_no = v.po_no
    where v.company = c and v.creditor_code = p_creditor_code
  );
end $$;

-- 在路上（分店看）。p: outlet q。总部 / ALL 的人看全部分店；其他分店的人只看自己分店的。不含价格。
-- full：看得到厂家（ops.sees_supplier）的人用 DO 分组的画面；每一行还要看得到那张 DO 的公司（sees_company）才回厂家、DO 号、
-- PO 号、货柜（JB 采购 / 仓库部看总部分给 JB 的货：这些栏位是 null）。其他人只有型号、品名、数量、ETA。
create or replace function public.ops_po_transit(p jsonb default '{}'::jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  v_q text := nullif(trim(coalesce(p ->> 'q', '')), '');
  v_out text := nullif(p ->> 'outlet', '');
  arr boolean;
  v_full boolean;
begin
  me := ops.require_level('purchasing', 'view');
  arr := ops.level_rank(ops.module_level(me, 'purchasing')) >= 2 or ops.level_rank(ops.module_level(me, 'warehouse')) >= 2;
  v_full := ops.sees_supplier(me);
  return jsonb_build_object(
    'full', v_full,
    'outlets', (select coalesce(jsonb_agg(jsonb_build_object('code', o.code, 'name', o.name, 'short_name', o.short_name)
                                          order by o.sort, o.code), '[]'::jsonb)
                from ops.outlet o where o.active and ops.outlet_visible(me, o.code)),
    'rows', (select coalesce(jsonb_agg(jsonb_build_object(
               'do_id', r.id, 'eta', r.eta, 'eta_source', r.eta_source,
               'outlet', r.outlet, 'outlet_name', o.name, 'item_code', r.item_code, 'description', r.description,
               'uom', r.uom, 'qty', r.qty, 'confirmed_at', r.confirmed_at,
               'do_no', case when r.src then r.do_no end, 'do_date', case when r.src then r.do_date end,
               'company', case when r.src then r.company end, 'creditor_code', case when r.src then r.creditor_code end,
               'supplier_name', case when r.src then r.supplier_name end,
               'shipment_name', case when r.src then r.shipment_name end,
               'po_nos', case when r.src then r.po_nos else '[]'::jsonb end,
               'can_arrive', coalesce(arr and r.src, false))
             order by o.sort, r.eta nulls last, r.do_no, r.id, r.item_code), '[]'::jsonb)
             from (select d.id, d.do_no, d.do_date, d.company, d.creditor_code, d.supplier_name, d.confirmed_at,
                          coalesce(v_full and ops.sees_company(me, d.company), false) as src,
                          coalesce(s.eta, d.eta) as eta,
                          case when s.eta is not null then 'shipment' when d.eta is not null then 'do' end as eta_source,
                          s.name as shipment_name, a.outlet, a.item_code, sum(a.qty) as qty,
                          coalesce((select x ->> 'description' from jsonb_array_elements(d.items) x
                                    where x ->> 'item_code' = a.item_code limit 1), '') as description,
                          coalesce((select x ->> 'uom' from jsonb_array_elements(d.items) x
                                    where x ->> 'item_code' = a.item_code limit 1), '') as uom,
                          coalesce(to_jsonb(array_remove(array_agg(distinct a.po_no), null)), '[]'::jsonb) as po_nos
                   from ops.supplier_do d
                   join ops.supplier_do_apply a on a.do_id = d.id and not a.void
                   left join ops.shipment s on s.id = d.shipment_id and s.status <> 'cancelled'
                   where d.status = 'confirmed' and ops.outlet_visible(me, a.outlet)
                     and (v_out is null or a.outlet = v_out)
                   group by d.id, s.id, a.outlet, a.item_code) r
             join ops.outlet o on o.code = r.outlet
             where v_q is null or r.item_code ilike '%' || v_q || '%' or r.description ilike '%' || v_q || '%'
                or (r.src and (r.supplier_name ilike '%' || v_q || '%' or r.do_no ilike '%' || v_q || '%'
                               or r.po_nos::text ilike '%' || v_q || '%'))));
end $$;

revoke all on function ops.podo_cs(text) from public, anon, authenticated;
revoke all on function ops.sees_supplier(ops.staff) from public, anon, authenticated;
revoke all on function ops.require_supplier(ops.staff) from public, anon, authenticated;
