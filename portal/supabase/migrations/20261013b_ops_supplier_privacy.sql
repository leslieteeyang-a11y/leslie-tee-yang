-- 营运系统：厂家资料只给采购、管理层与仓库部看。套用到 Supabase 的 migration 名称：ops_supplier_privacy
-- （要先套 20261013_ops_po_do_cs.sql：ops.sees_supplier / ops.require_supplier 在那里。）
-- 使用者 2026-10-13：分行不能知道厂家是谁（含 CS 编号），只要看得到产品来了多少与 ETA；总部门市、电商、物流也一样看不到。
-- 看得到厂家 = ops.sees_supplier（订货「可编辑」或仓库部）。其他人：
--   未到货 PO（ops_po_list / ops_po_get）、货柜（ops_shipment_list）：不能开（错误讯息指去「查 SKU 到货」「在路上」）；
--   查 SKU 到货（ops_item_eta）：在途只回数量、ETA、状态、仓位，不回 PO 号 / 厂家 / 货柜名称；
--   仓库查商品（ops_wh_item）的在途 PO：不回 PO 号与厂家；
--   首页「N 张 PO 三天内到货」（ops_home.po_arriving）：只给看得到 PO 的人（不然连结点进去打不开）。
-- 函数本体照抄最新版（ops_po_list / _get / ops_shipment_list / ops_item_eta = 20260928_ops_purchasing，
-- ops_wh_item = 20261004_ops_warehouse，ops_home = 20261010_ops_profile_offboard），只改上面这几处。

create or replace function public.ops_po_list(p jsonb default '{}'::jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  prices boolean;
  v_q text := nullif(trim(coalesce(p ->> 'q', '')), '');
begin
  me := ops.require_level('purchasing', 'view');
  perform ops.require_supplier(me);
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
  perform ops.require_supplier(me);
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

create or replace function public.ops_shipment_list(p_include_done boolean default false) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
begin
  me := ops.require_level('purchasing', 'view');
  perform ops.require_supplier(me);
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

create or replace function public.ops_item_eta(p_q text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  v_q text := nullif(trim(coalesce(p_q, '')), '');
  sup boolean;
begin
  me := ops.require_level('purchasing', 'view');
  sup := ops.sees_supplier(me);
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
                         'po_no', case when sup then l.po_no end, 'open_qty', l.open_qty, 'eta', v.eta, 'eta_source', v.eta_source,
                         'status', v.status, 'shipment_name', case when sup then v.shipment_name end, 'supplier_name', case when sup then v.supplier_name end,
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

create or replace function public.ops_wh_item(p_company text, p_code text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  c text;
  code text;
  full_access boolean;
  it record;
  sup boolean;
begin
  me := ops.require_level('warehouse', 'view');
  sup := ops.sees_supplier(me);
  c := ops.wh_company(me, p_company);
  code := ops.wh_resolve(c, p_code);
  select * into it from bi.dim_item i where i.company = c and i.item_code = code;
  if it.item_code is null then
    return jsonb_build_object('found', false, 'scanned', trim(coalesce(p_code, '')));
  end if;
  full_access := ops.level_rank(ops.module_level(me, 'warehouse')) >= 3;
  return jsonb_build_object(
    'found', true, 'company', c, 'item_code', it.item_code, 'description', it.description, 'uom', it.base_uom,
    'item_group', it.item_group, 'item_type', it.item_type, 'active', it.is_active,
    'synced_at', ops.wh_synced_at(c),
    'stock', (select coalesce(jsonb_agg(jsonb_build_object(
                'location', l.loc, 'qty', coalesce(f.qty, 0), 'pending', ops.wh_pending(c, it.item_code, l.loc),
                'unit_cost', case when full_access and f.qty > 0 then round(f.total_cost / f.qty, 2) end)
                order by coalesce(wl.sort, 50), l.loc), '[]'::jsonb)
              from (select f2.location as loc from bi.fact_stock f2 where f2.company = c and f2.item_code = it.item_code
                    union select m.from_loc from ops.wh_move m where m.company = c and m.item_code = it.item_code
                      and m.status = 'pending' and m.from_loc is not null
                    union select m.to_loc from ops.wh_move m where m.company = c and m.item_code = it.item_code
                      and m.status = 'pending' and m.to_loc is not null) l
              left join bi.fact_stock f on f.company = c and f.item_code = it.item_code and f.location = l.loc
              left join ops.wh_location wl on wl.company = c and wl.code = l.loc),
    'open_orders', (select coalesce(jsonb_agg(jsonb_build_object('doc_no', o.doc_no, 'doc_date', o.doc_date,
                      'customer', o.debtor_name, 'qty', o.outstanding_qty) order by o.doc_date), '[]'::jsonb)
                    from bi.fact_open_order o where o.company = c and o.item_code = it.item_code and o.outstanding_qty > 0),
    'incoming', (select coalesce(jsonb_agg(jsonb_build_object('po_no', case when sup then l.po_no end, 'po_date', l.po_date,
                   'supplier', case when sup then l.creditor_name end, 'location', l.location, 'qty', l.qty - l.transferred_qty) order by l.po_date), '[]'::jsonb)
                 from bi.fact_po_line l where l.company = c and l.item_code = it.item_code and not l.cancelled
                   and l.qty > l.transferred_qty and l.po_date > current_date - 365),
    'moves', (select coalesce(jsonb_agg(ops.wh_move_json(m) order by m.created_at desc), '[]'::jsonb) from (
                select * from ops.wh_move m where m.company = c and m.item_code = it.item_code
                order by (m.status = 'pending') desc, m.created_at desc limit 10) m),
    'counts', (select coalesce(jsonb_agg(ops.wh_count_json(k, full_access) order by k.counted_at desc), '[]'::jsonb) from (
                 select * from ops.wh_count k where k.company = c and k.item_code = it.item_code
                 order by k.counted_at desc limit 10) k),
    'barcodes', (select coalesce(jsonb_agg(b.barcode order by b.barcode), '[]'::jsonb)
                 from ops.wh_barcode b where b.company = c and b.item_code = it.item_code));
end $$;

create or replace function public.ops_home() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  rec ops.attendance;
  wh int := ops.level_rank(ops.module_level(ops.current_staff(), 'warehouse'));
  po int := ops.level_rank(ops.module_level(ops.current_staff(), 'purchasing'));
  hr int := ops.level_rank(ops.module_level(ops.current_staff(), 'hr'));
  pay int := ops.level_rank(ops.module_level(ops.current_staff(), 'payroll'));
  adm int := ops.level_rank(ops.module_level(ops.current_staff(), 'admin'));
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
    'po_arriving', case when ops.sees_supplier(me) then
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
    -- 物流部也有仓库「可编辑」（登记搬动），但不负责盘点：不提醒「今天还没盘点」；最近 30 天自己盘过的照样提醒（使用者 2026-10-09）
    'wh_counted_today', case when wh >= 2 and (me.department <> 'logistics' or exists (select 1 from ops.wh_count k
                          where k.counted_by = me.id and k.count_date >= ops.today() - 30)) then (select count(*) from ops.wh_count k
                          where k.counted_by = me.id and k.count_date = ops.today() and k.status <> 'superseded') end,
    'hr_gaps', case when hr >= 2 then (select count(*) from ops.staff s
                 where s.active and (s.last_day is null or s.last_day >= ops.today()) and ops.sees_branch(me, s.branch)
                   and cardinality(ops.hr_gap_codes(s, pay)) > 0) end,
    'holidays_ahead', case when hr >= 2 then (select count(*) from ops.holiday h
                        where h.date between ops.today() and ops.today() + 60) end,
    'join_pending', case when adm >= 3 then (select count(*) from ops.join_request r where r.status = 'pending') end
  );
end $$;
