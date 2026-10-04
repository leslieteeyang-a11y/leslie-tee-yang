-- 2026-10-04 BI 页面提速（续）：bi_purchase_suggest 只把最慢的 sold CTE（扫 fact_sales 455 天）
-- 换成 bi.mv_purchase_sold；stk / transit / act / calc… 全部照旧。migration：heavy_views_rewire_purchase。
create or replace view public.bi_purchase_suggest with (security_invoker = true) as
select company, item_code, description, item_group, base_uom, q90, q365, q90_branch_excl, q30, q90_ly,
       last_sale, daily_avg, daily_year, daily_ly, on_hand, jb_reserved, owed_branch, by_loc,
       transit_qty, transit_eta, transit_pos, supplier_code, last_po_name, last_price, last_po_date,
       po_24m, min_order_qty, pack_size, exclude, item_note, last_receipt_date, item_type,
       action_id, action, action_qty, until_date, action_note, action_by, action_at,
       order_rate, supplier_name, is_china, lead_days, safety_days, cover_days, cs_code,
       days_left, days_left_incl_transit, reorder_days, raw_qty, branch_short, action_status,
       need_order, urgency, est_out_date, suggest_qty, fill_candidate
from (
  with sold as (
    select company, item_code, q90, q365, q90_branch_excl, q30, q90_ly, first_sale_win, last_sale
    from bi.mv_purchase_sold
    where ((select bi_company()) is null or company = (select bi_company()))
  ), stk as (
    select fact_stock.company, fact_stock.item_code,
      coalesce(sum(fact_stock.qty) filter (where fact_stock.location <> all (array['DEFECTS','DISPLAY','JB','PRE (JB)'])), 0) as on_hand,
      coalesce(sum(fact_stock.qty) filter (where fact_stock.location = 'JB'), 0) as jb_reserved,
      greatest(0, - coalesce(sum(fact_stock.qty) filter (where fact_stock.location = 'PRE (JB)'), 0)) as owed_branch,
      string_agg((fact_stock.location || ':') || round(fact_stock.qty)::text, ' / ' order by fact_stock.location)
        filter (where fact_stock.qty <> 0) as by_loc
    from bi.fact_stock
    where fact_stock.location <> all (array['DEFECTS','DISPLAY'])
    group by fact_stock.company, fact_stock.item_code
  ), transit as (
    select l.company, l.item_code,
      sum(l.qty - l.transferred_qty) as transit_qty,
      min(case when l.est_delivery > l.po_date then l.est_delivery else l.po_date + coalesce(sp.lead_days, 7) end) as transit_eta,
      string_agg(distinct l.po_no, ', ') as transit_pos
    from bi.fact_po_line l
    left join bi.v_supplier_param sp on sp.company = l.company and sp.creditor_code = l.creditor_code
    where not l.cancelled and l.qty > l.transferred_qty and l.po_date >= (current_date - 120)
    group by l.company, l.item_code
  ), act as (
    select distinct on (buyer_item_action.company, buyer_item_action.item_code)
      buyer_item_action.company, buyer_item_action.item_code,
      buyer_item_action.id as action_id, buyer_item_action.action, buyer_item_action.qty as action_qty,
      buyer_item_action.until_date, buyer_item_action.note as action_note,
      buyer_item_action.created_by as action_by, buyer_item_action.created_at as action_at
    from bi.buyer_item_action
    order by buyer_item_action.company, buyer_item_action.item_code, buyer_item_action.created_at desc
  ), base as (
    select coalesce(s.company, st.company) as company,
      coalesce(s.item_code, st.item_code) as item_code,
      coalesce(s.q90, 0) as q90, coalesce(s.q365, 0) as q365,
      coalesce(s.q90_branch_excl, 0) as q90_branch_excl, coalesce(s.q30, 0) as q30,
      coalesce(s.q90_ly, 0) as q90_ly, s.first_sale_win, s.last_sale,
      coalesce(st.on_hand, 0) as on_hand, coalesce(st.jb_reserved, 0) as jb_reserved,
      coalesce(st.owed_branch, 0) as owed_branch, st.by_loc
    from sold s
    full join stk st on st.company = s.company and st.item_code = s.item_code
    where coalesce(s.q90, 0) > 0 or coalesce(st.owed_branch, 0) > 0
  ), calc as (
    select b.company, b.item_code,
      coalesce(i.description, b.item_code) as description, i.item_group, i.base_uom,
      b.q90, b.q365, b.q90_branch_excl, b.q30, b.q90_ly, b.last_sale,
      round(b.q90 / 90.0, 2) as daily_avg,
      round(b.q365 / least(365, greatest(60, current_date - coalesce(b.first_sale_win, current_date - 365)))::numeric, 2) as daily_year,
      round(b.q90_ly / 120.0, 2) as daily_ly,
      b.on_hand, b.jb_reserved, b.owed_branch, b.by_loc,
      coalesce(t.transit_qty, 0) as transit_qty, t.transit_eta, t.transit_pos,
      coalesce(nullif(isup.supplier_code, 'CN-UNKNOWN'), bb.supplier_code, 'CN-UNKNOWN') as supplier_code,
      isup.last_supplier_name as last_po_name, isup.last_price, isup.last_po_date, isup.po_24m,
      isup.min_order_qty, isup.pack_size, coalesce(isup.exclude, false) as exclude, isup.item_note,
      ag.last_receipt_date, i.item_type,
      a.action_id, a.action, a.action_qty, a.until_date, a.action_note, a.action_by, a.action_at
    from base b
    left join transit t on t.company = b.company and t.item_code = b.item_code
    left join bi.v_item_supplier isup on isup.company = b.company and isup.item_code = b.item_code
    left join bi.dim_item i on i.company = b.company and i.item_code = b.item_code
    left join bi.buyer_brand_supplier bb on bb.company = b.company and bb.item_type = i.item_type
    left join bi.fact_item_aging ag on ag.company = b.company and ag.item_code = b.item_code
    left join act a on a.company = b.company and a.item_code = b.item_code
    where b.item_code <> all (array['VOUCHER','SHIPPING FEE']) and b.item_code not like 'ONLINE%'
  ), calc1 as (
    select c_1.*,
      greatest(c_1.daily_year, c_1.daily_ly) as order_rate,
      coalesce(sp.name, c_1.last_po_name, '中国供应商(未指定)') as supplier_name,
      coalesce(sp.is_china, true) as is_china,
      coalesce(sp.lead_days, 60) as lead_days,
      coalesce(sp.safety_days, 14) as safety_days,
      coalesce(sp.cover_days, 30) as cover_days,
      nullif(upper(replace(coalesce(substring(c_1.last_po_name, '[Cc][Ss] ?[0-9]+'),
                                    substring(sp.po_name, '[Cc][Ss] ?[0-9]+')), ' ', '')), '') as cs_code
    from calc c_1
    left join bi.v_supplier_param sp on sp.company = c_1.company and sp.creditor_code = c_1.supplier_code
  ), calc2 as (
    select c_1.*,
      round(c_1.on_hand / nullif(c_1.daily_avg, 0))::integer as days_left,
      round((c_1.on_hand + c_1.transit_qty) / nullif(c_1.daily_avg, 0))::integer as days_left_incl_transit,
      c_1.lead_days + c_1.safety_days as reorder_days,
      greatest(0, ceil((c_1.lead_days + c_1.safety_days + c_1.cover_days)::numeric * c_1.order_rate
                       + c_1.owed_branch - c_1.on_hand - c_1.transit_qty)) as raw_qty,
      (c_1.on_hand + c_1.transit_qty) < c_1.owed_branch as branch_short,
      case
        when c_1.action = 'skip' and (c_1.until_date is null or c_1.until_date >= current_date) then 'skip'
        when c_1.action = 'ordered' and c_1.action_at >= (now() - interval '30 days') then 'ordered'
        else null
      end as action_status
    from calc1 c_1
  )
  select c.company, c.item_code, c.description, c.item_group, c.base_uom, c.q90, c.q365, c.q90_branch_excl,
    c.q30, c.q90_ly, c.last_sale, c.daily_avg, c.daily_year, c.daily_ly, c.on_hand, c.jb_reserved,
    c.owed_branch, c.by_loc, c.transit_qty, c.transit_eta, c.transit_pos, c.supplier_code, c.last_po_name,
    c.last_price, c.last_po_date, c.po_24m, c.min_order_qty, c.pack_size, c.exclude, c.item_note,
    c.last_receipt_date, c.item_type, c.action_id, c.action, c.action_qty, c.until_date, c.action_note,
    c.action_by, c.action_at, c.order_rate, c.supplier_name, c.is_china, c.lead_days, c.safety_days,
    c.cover_days, c.cs_code, c.days_left, c.days_left_incl_transit, c.reorder_days, c.raw_qty,
    c.branch_short, c.action_status,
    c.days_left_incl_transit <= c.reorder_days or c.branch_short as need_order,
    case
      when c.branch_short then 'late'
      when c.on_hand <= 0 then 'out'
      when c.days_left < c.lead_days then 'late'
      when c.days_left_incl_transit <= c.reorder_days then 'now'
      else 'ok'
    end as urgency,
    current_date + greatest(0, coalesce(c.days_left, 0)) as est_out_date,
    case
      when c.pack_size > 0 then ceil(greatest(c.raw_qty, coalesce(c.min_order_qty, 0)) / c.pack_size) * c.pack_size
      else greatest(c.raw_qty, coalesce(c.min_order_qty, 0))
    end as suggest_qty,
    c.days_left_incl_transit > c.reorder_days and not c.branch_short
      and c.days_left_incl_transit <= (c.reorder_days + 30) as fill_candidate
  from calc2 c
  where (select bi_is_allowed())
) __v
where coalesce((select bi_role()), '') <> 'sales';
