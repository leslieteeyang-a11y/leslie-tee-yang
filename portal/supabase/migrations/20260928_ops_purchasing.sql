-- 营运系统第 2 阶段：订货与 ETA。套用到 Supabase 的 migration 名称：ops_purchasing。
--
-- AutoCount 的 PO 每天由 BI 管线同步到 bi.fact_po_line（只读，不要改）。这里只补 AutoCount 没有的：
--   * ops.po_track：每张 PO 的跟进状态、ETA、备注（key = company + po_no，与 BI 同步方式无关，重同步不会掉）
--   * ops.shipment：货柜（中国货一柜装多张 PO）。PO 挂上货柜后，ETA 以货柜为准
-- 有效 ETA 的优先顺序：货柜 ETA > PO 上填的 ETA > AutoCount 的预计交货日（晚于开单日才算）> 开单日 + 供应商交期。
-- PO 在 AutoCount 收货（GR 转完）后就不在「未到货」清单里，不用人工结案；
-- 永远不会来的旧单可标「关闭」，从清单隐藏（真正要结案请在 AutoCount 取消）。
-- 价格：只有订货模块「可编辑」以上看得到单价与金额（业务、仓库只看数量与日期）。

create table ops.shipment (
  id bigint generated always as identity primary key,
  company text not null check (company in ('HOMEWORKSSB', 'HOMEWORKSSOUTHERN')),
  name text not null check (length(trim(name)) > 0),        -- 柜号 / 批次名，例：CS065-0925 或 TCLU1234567
  forwarder text not null default '',
  etd date,                                                  -- 预计 / 实际出货日
  eta date,                                                  -- 预计到仓日
  status text not null default 'booked'
    check (status in ('booked', 'loading', 'shipped', 'arrived', 'received', 'cancelled')),
  remark text not null default '',
  created_by bigint references ops.staff(id),
  updated_by bigint references ops.staff(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table ops.po_track (
  company text not null check (company in ('HOMEWORKSSB', 'HOMEWORKSSOUTHERN')),
  po_no text not null,
  status text not null default 'ordered'
    check (status in ('ordered', 'confirmed', 'producing', 'shipped', 'arrived', 'closed')),
  eta date,
  shipment_id bigint references ops.shipment(id) on delete set null,
  remark text not null default '',
  updated_by bigint references ops.staff(id),
  updated_at timestamptz not null default now(),
  primary key (company, po_no)
);
create index po_track_shipment_idx on ops.po_track (shipment_id);

alter table ops.shipment enable row level security;
alter table ops.po_track enable row level security;

update ops.module set ready = true where key = 'purchasing';

-- ------------------------------------------------------------ 未到货 PO（行）+ 有效 ETA
-- 内部用；对外一律经 ops_po_* 函数（会检查权限、分店、价格可见性）。
create or replace view ops.v_po_open_line as
select l.company, l.po_no, l.po_date, l.creditor_code,
       coalesce(sp.name, l.creditor_name) as supplier_name, l.creditor_name,
       coalesce(sp.is_china, false) as is_china,
       l.dtl_key, l.item_code, coalesce(i.description, l.description) as description, l.location, l.uom,
       l.qty, l.transferred_qty, l.qty - l.transferred_qty as open_qty, l.unit_price,
       round((l.qty - l.transferred_qty) * coalesce(l.unit_price, 0), 2) as open_amt,
       case when l.est_delivery > l.po_date then l.est_delivery
            else l.po_date + coalesce(sp.lead_days, 7) end as ac_eta,
       case when l.est_delivery > l.po_date then 'autocount' else 'lead' end as ac_eta_source
from bi.fact_po_line l
left join bi.v_supplier_param sp on sp.company = l.company and sp.creditor_code = l.creditor_code
left join bi.dim_item i on i.company = l.company and i.item_code = l.item_code
where not l.cancelled and l.qty > l.transferred_qty;

create or replace view ops.v_po_open as
with po as (
  select company, po_no, min(po_date) as po_date, min(creditor_code) as creditor_code,
         min(supplier_name) as supplier_name, min(creditor_name) as creditor_name, bool_or(is_china) as is_china,
         count(*) as lines, sum(open_qty) as open_qty, sum(open_amt) as open_amt,
         min(ac_eta) as ac_eta, min(ac_eta_source) as ac_eta_source,
         string_agg(distinct location, ', ') as locations
  from ops.v_po_open_line group by company, po_no
)
select po.*,
       coalesce(t.status, 'ordered') as status, t.eta as po_eta, t.remark, t.updated_by, t.updated_at,
       s.id as shipment_id, s.name as shipment_name, s.eta as shipment_eta, s.status as shipment_status,
       coalesce(s.eta, t.eta, po.ac_eta) as eta,
       case when s.eta is not null then 'shipment' when t.eta is not null then 'po' else po.ac_eta_source end as eta_source,
       current_date - po.po_date as days_open,
       current_date - coalesce(s.eta, t.eta, po.ac_eta) as days_late
from po
left join ops.po_track t on t.company = po.company and t.po_no = po.po_no
left join ops.shipment s on s.id = t.shipment_id and s.status <> 'cancelled';

-- ------------------------------------------------------------ 权限小工具
create or replace function ops.sees_company(p_staff ops.staff, p_company text) returns boolean
language sql stable set search_path = '' as $$
  select coalesce(p_staff.branch = 'ALL' or p_staff.branch = p_company, false)
$$;

create or replace function ops.po_row_json(p_staff ops.staff, p ops.v_po_open, p_prices boolean) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'company', p.company, 'po_no', p.po_no, 'po_date', p.po_date, 'creditor_code', p.creditor_code,
    'supplier_name', p.supplier_name, 'creditor_name', p.creditor_name, 'is_china', p.is_china,
    'lines', p.lines, 'open_qty', p.open_qty, 'locations', p.locations,
    'open_amt', case when p_prices then p.open_amt end,
    'status', p.status, 'po_eta', p.po_eta, 'remark', p.remark, 'updated_at', p.updated_at,
    'updated_by_name', (select s.name from ops.staff s where s.id = p.updated_by),
    'shipment_id', p.shipment_id, 'shipment_name', p.shipment_name, 'shipment_status', p.shipment_status,
    'eta', p.eta, 'eta_source', p.eta_source, 'days_open', p.days_open,
    'days_late', p.days_late, 'overdue', p.days_late > 0 and p.status <> 'closed',
    'stale', p.days_open > 120)
$$;

-- ------------------------------------------------------------ 清单 / 明细
-- p: company(可空) status(可空 / 'open' = 非关闭) q(PO / 供应商 / 货柜 / SKU) overdue(bool) stale(bool：含 120 天以上旧单)
--    china('china' / 'local' / 空)
create or replace function public.ops_po_list(p jsonb default '{}'::jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  prices boolean;
  v_q text := nullif(trim(coalesce(p ->> 'q', '')), '');
begin
  me := ops.require_level('purchasing', 'view');
  prices := ops.level_rank(ops.module_level(me, 'purchasing')) >= 2;
  return (
    select coalesce(jsonb_agg(ops.po_row_json(me, r.x, prices)
                              order by ((r.x).status = 'closed'), (r.x).days_late desc nulls last, (r.x).po_no),
                    '[]'::jsonb)
    from (select x from ops.v_po_open x
          where ops.sees_company(me, x.company)
            and (nullif(p ->> 'company', '') is null or x.company = p ->> 'company')
            and case coalesce(nullif(p ->> 'status', ''), 'open')
                  when 'open' then x.status <> 'closed'
                  when 'all' then true
                  else x.status = p ->> 'status' end
            and (coalesce((p ->> 'stale')::boolean, false) or x.days_open <= 120 or x.status <> 'ordered'
                 or x.po_eta is not null or x.shipment_id is not null)
            and (not coalesce((p ->> 'overdue')::boolean, false) or x.days_late > 0)
            and case coalesce(p ->> 'china', '') when 'china' then x.is_china when 'local' then not x.is_china
                                                 else true end
            and (v_q is null
                 or x.po_no ilike '%' || v_q || '%' or x.supplier_name ilike '%' || v_q || '%'
                 or x.creditor_name ilike '%' || v_q || '%' or coalesce(x.shipment_name, '') ilike '%' || v_q || '%'
                 or exists (select 1 from ops.v_po_open_line l where l.company = x.company and l.po_no = x.po_no
                            and (l.item_code ilike '%' || v_q || '%' or l.description ilike '%' || v_q || '%')))
          limit 1000) r
  );
end $$;

create or replace function public.ops_po_get(p_company text, p_po_no text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  prices boolean;
  po ops.v_po_open;
begin
  me := ops.require_level('purchasing', 'view');
  prices := ops.level_rank(ops.module_level(me, 'purchasing')) >= 2;
  select * into po from ops.v_po_open v where v.company = p_company and v.po_no = p_po_no;
  if po.po_no is null or not ops.sees_company(me, po.company) then
    raise exception '找不到这张 PO（可能已全部到货，或不是你分店的单）。' using errcode = 'P0002';
  end if;
  return ops.po_row_json(me, po, prices) || jsonb_build_object(
    'can_edit', ops.level_rank(ops.module_level(me, 'purchasing')) >= 2,
    'items', (select coalesce(jsonb_agg(jsonb_build_object(
                'item_code', l.item_code, 'description', l.description, 'uom', l.uom, 'location', l.location,
                'qty', l.qty, 'received', l.transferred_qty, 'open_qty', l.open_qty,
                'unit_price', case when prices then l.unit_price end,
                'open_amt', case when prices then l.open_amt end) order by l.dtl_key), '[]'::jsonb)
              from ops.v_po_open_line l where l.company = po.company and l.po_no = po.po_no),
    'receipts', (select coalesce(jsonb_agg(jsonb_build_object('doc_no', r.doc_no, 'src', r.src, 'rcv_date', r.rcv_date,
                                                              'item_code', r.item_code, 'qty', r.qty)
                                           order by r.rcv_date desc), '[]'::jsonb)
                 from bi.fact_po_receipt r where r.company = po.company and r.po_no = po.po_no),
    'history', (select coalesce(jsonb_agg(jsonb_build_object('at', a.at, 'staff_name', s.name, 'data', a.data)
                                          order by a.id desc), '[]'::jsonb)
                from ops.audit_log a left join ops.staff s on s.id = a.staff_id
                where a.entity = 'po' and a.data ->> 'company' = po.company and a.data ->> 'po_no' = po.po_no));
end $$;

-- 更新一张或多张 PO 的跟进资料。p: status eta(''=清掉) shipment_id(''=拿掉) remark；只更新有带的栏位。
create or replace function public.ops_po_update(p_company text, p_po_nos text[], p jsonb) returns int
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  v_po text;
  v_ship ops.shipment;
  n int := 0;
begin
  me := ops.require_level('purchasing', 'edit');
  if not ops.sees_company(me, p_company) then
    raise exception '你不能改其他分店的 PO。' using errcode = '42501';
  end if;
  if nullif(p ->> 'shipment_id', '') is not null then
    select * into v_ship from ops.shipment where id = (p ->> 'shipment_id')::bigint;
    if v_ship.id is null or v_ship.company <> p_company then
      raise exception '货柜不存在，或不是同一间公司的货柜。';
    end if;
  end if;
  foreach v_po in array coalesce(p_po_nos, array[]::text[]) loop
    if not exists (select 1 from bi.fact_po_line l where l.company = p_company and l.po_no = v_po) then
      raise exception '找不到 PO %。', v_po;
    end if;
    insert into ops.po_track (company, po_no, updated_by) values (p_company, v_po, me.id)
    on conflict (company, po_no) do nothing;
    update ops.po_track set
      status      = case when p ? 'status' then coalesce(nullif(p ->> 'status', ''), status) else status end,
      eta         = case when p ? 'eta' then nullif(p ->> 'eta', '')::date else eta end,
      shipment_id = case when p ? 'shipment_id' then nullif(p ->> 'shipment_id', '')::bigint else shipment_id end,
      remark      = case when p ? 'remark' then coalesce(p ->> 'remark', '') else remark end,
      updated_by  = me.id,
      updated_at  = now()
    where company = p_company and po_no = v_po;
    perform ops.log(me.id, 'update', 'po', null, p || jsonb_build_object('company', p_company, 'po_no', v_po));
    n := n + 1;
  end loop;
  return n;
end $$;

-- ------------------------------------------------------------ 货柜
create or replace function public.ops_shipment_list(p_include_done boolean default false) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
begin
  me := ops.require_level('purchasing', 'view');
  return (
    select coalesce(jsonb_agg(to_jsonb(s) || jsonb_build_object(
             'po_count', (select count(*) from ops.po_track t where t.shipment_id = s.id),
             'open_po_count', (select count(*) from ops.v_po_open v where v.shipment_id = s.id),
             'po_nos', (select coalesce(jsonb_agg(t.po_no order by t.po_no), '[]'::jsonb)
                        from ops.po_track t where t.shipment_id = s.id),
             'updated_by_name', (select st.name from ops.staff st where st.id = s.updated_by),
             'overdue', s.eta < current_date and s.status not in ('received', 'cancelled'))
           order by (s.status in ('received', 'cancelled')), s.eta nulls last, s.id desc), '[]'::jsonb)
    from ops.shipment s
    where ops.sees_company(me, s.company)
      and (coalesce(p_include_done, false) or s.status not in ('received', 'cancelled'))
  );
end $$;

-- p: id(可空) company name forwarder etd eta status remark
create or replace function public.ops_shipment_save(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  s ops.shipment;
  v_id bigint := nullif(p ->> 'id', '')::bigint;
begin
  me := ops.require_level('purchasing', 'edit');
  if v_id is null then
    if not ops.sees_company(me, coalesce(p ->> 'company', '')) then
      raise exception '请选择你分店的公司。' using errcode = '42501';
    end if;
    insert into ops.shipment (company, name, forwarder, etd, eta, status, remark, created_by, updated_by)
    values (p ->> 'company', trim(coalesce(p ->> 'name', '')), coalesce(p ->> 'forwarder', ''),
            nullif(p ->> 'etd', '')::date, nullif(p ->> 'eta', '')::date,
            coalesce(nullif(p ->> 'status', ''), 'booked'), coalesce(p ->> 'remark', ''), me.id, me.id)
    returning * into s;
  else
    select * into s from ops.shipment where id = v_id for update;
    if s.id is null or not ops.sees_company(me, s.company) then
      raise exception '找不到这个货柜。' using errcode = 'P0002';
    end if;
    update ops.shipment set
      name      = case when p ? 'name' then trim(p ->> 'name') else name end,
      forwarder = case when p ? 'forwarder' then coalesce(p ->> 'forwarder', '') else forwarder end,
      etd       = case when p ? 'etd' then nullif(p ->> 'etd', '')::date else etd end,
      eta       = case when p ? 'eta' then nullif(p ->> 'eta', '')::date else eta end,
      status    = case when p ? 'status' then coalesce(nullif(p ->> 'status', ''), status) else status end,
      remark    = case when p ? 'remark' then coalesce(p ->> 'remark', '') else remark end,
      updated_by = me.id, updated_at = now()
    where id = v_id returning * into s;
  end if;
  -- 货柜出货 / 到港时，同步把柜里的 PO 状态往前推（不往回退）
  if s.status in ('shipped', 'arrived') then
    update ops.po_track t set status = s.status, updated_by = me.id, updated_at = now()
    where t.shipment_id = s.id and t.status in ('ordered', 'confirmed', 'producing')
       or (t.shipment_id = s.id and s.status = 'arrived' and t.status = 'shipped');
  end if;
  perform ops.log(me.id, case when v_id is null then 'create' else 'update' end, 'shipment', s.id, p);
  return to_jsonb(s);
end $$;

-- ------------------------------------------------------------ SKU 什么时候到货（业务、仓库用）
create or replace function public.ops_item_eta(p_q text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  v_q text := nullif(trim(coalesce(p_q, '')), '');
begin
  me := ops.require_level('purchasing', 'view');
  if v_q is null or length(v_q) < 2 then
    return '[]'::jsonb;
  end if;
  return (
    select coalesce(jsonb_agg(x order by x ->> 'item_code', x ->> 'company'), '[]'::jsonb) from (
      select jsonb_build_object(
        'company', i.company, 'item_code', i.item_code, 'description', i.description, 'uom', i.base_uom,
        'on_hand', (select coalesce(sum(f.qty), 0) from bi.fact_stock f where f.company = i.company and f.item_code = i.item_code),
        'by_loc', (select coalesce(jsonb_object_agg(f.location, f.qty), '{}'::jsonb) from bi.fact_stock f
                   where f.company = i.company and f.item_code = i.item_code and f.qty <> 0),
        'incoming', (select coalesce(jsonb_agg(jsonb_build_object(
                         'po_no', l.po_no, 'open_qty', l.open_qty, 'eta', v.eta, 'eta_source', v.eta_source,
                         'status', v.status, 'shipment_name', v.shipment_name, 'supplier_name', v.supplier_name,
                         'location', l.location, 'overdue', v.days_late > 0)
                       order by v.eta), '[]'::jsonb)
                     from ops.v_po_open_line l join ops.v_po_open v on v.company = l.company and v.po_no = l.po_no
                     where l.company = i.company and l.item_code = i.item_code and v.status <> 'closed')) as x
      from bi.dim_item i
      where ops.sees_company(me, i.company)
        and (i.item_code ilike '%' || v_q || '%' or i.description ilike '%' || v_q || '%')
      order by i.item_code
      limit 30) t
  );
end $$;

-- ------------------------------------------------------------ 首页：订货逾期数
create or replace function public.ops_home() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
begin
  me := ops.require_staff();
  return jsonb_build_object(
    'my_open_tasks', (select count(*) from ops.task t where t.assignee_id = me.id and t.status in ('todo', 'doing')),
    'my_overdue', (select count(*) from ops.task t where t.assignee_id = me.id and t.status in ('todo', 'doing')
                   and t.due_date < current_date),
    'dept_open_tasks', (select count(*) from ops.task t where t.department = me.department
                        and t.status in ('todo', 'doing') and ops.sees_branch(me, t.branch)),
    'approvals_waiting', (select count(*) from ops.approval a where a.status = 'pending'
                          and ops.can_decide(me, a)),
    'my_pending_requests', (select count(*) from ops.approval a where a.requested_by = me.id and a.status = 'pending'),
    'po_overdue', case when ops.level_rank(ops.module_level(me, 'purchasing')) >= 2 then
                    (select count(*) from ops.v_po_open v where ops.sees_company(me, v.company)
                     and v.status <> 'closed' and v.days_late > 0
                     and (v.days_open <= 120 or v.status <> 'ordered' or v.po_eta is not null or v.shipment_id is not null))
                  end
  );
end $$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'ops_po_list(jsonb)', 'ops_po_get(text,text)', 'ops_po_update(text,text[],jsonb)',
    'ops_shipment_list(boolean)', 'ops_shipment_save(jsonb)', 'ops_item_eta(text)', 'ops_home()'
  ] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

revoke all on all functions in schema ops from public, anon, authenticated;
revoke all on all tables in schema ops from public, anon, authenticated;
