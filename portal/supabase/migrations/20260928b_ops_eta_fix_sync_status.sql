-- 营运系统：订货 ETA 修正 + 资料更新时间。套用到 Supabase 的 migration 名称：ops_eta_fix_sync_status。
--
-- 1. 中国货的「假逾期」：AutoCount 的 PO 预计交货日，中国货常填成开单后几天（2026-09 查：近一年中国 PO 有约 100 张
--    落在开单后 1–30 天），但货柜实际要 ~60 天。以前只要晚于开单日就采用，于是一堆中国 PO 显示「迟 100 天」。
--    改为：中国货的 AutoCount 预计交货日要 ≥ 开单日 + 30 天才采用，否则用开单日 + 供应商交期。本地货不变。
-- 2. ops_sync_status()：各公司 PO / 库存最后一次从 AutoCount 同步成功的时间（读 bi.sync_log），网页显示「资料更新到几点」。

create or replace view ops.v_po_open_line as
select l.company, l.po_no, l.po_date, l.creditor_code,
       coalesce(sp.name, l.creditor_name) as supplier_name, l.creditor_name,
       coalesce(sp.is_china, false) as is_china,
       l.dtl_key, l.item_code, coalesce(i.description, l.description) as description, l.location, l.uom,
       l.qty, l.transferred_qty, l.qty - l.transferred_qty as open_qty, l.unit_price,
       round((l.qty - l.transferred_qty) * coalesce(l.unit_price, 0), 2) as open_amt,
       case when l.est_delivery > l.po_date
                 and (not coalesce(sp.is_china, false) or l.est_delivery >= l.po_date + 30)
            then l.est_delivery
            else l.po_date + coalesce(sp.lead_days, 7) end as ac_eta,
       case when l.est_delivery > l.po_date
                 and (not coalesce(sp.is_china, false) or l.est_delivery >= l.po_date + 30)
            then 'autocount' else 'lead' end as ac_eta_source
from bi.fact_po_line l
left join bi.v_supplier_param sp on sp.company = l.company and sp.creditor_code = l.creditor_code
left join bi.dim_item i on i.company = l.company and i.item_code = l.item_code
where not l.cancelled and l.qty > l.transferred_qty;

create or replace function public.ops_sync_status() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
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
    from (values ('HOMEWORKSSB'), ('HOMEWORKSSOUTHERN')) c(company)
    where ops.sees_company(me, c.company)
  );
end $$;

revoke all on function public.ops_sync_status() from public, anon;
grant execute on function public.ops_sync_status() to authenticated;
revoke all on all tables in schema ops from public, anon, authenticated;
