-- 从 BI 搬来的四页：审查修正（2026-10-15）。套用到 Supabase 的 migration 名称：ops_bi_pages_7_fix（只有 create or replace，可重跑；
-- 要在 20261016_ops_bi_pages.sql 之后）。两个函数照抄 20261016_ops_bi_pages.sql，只加下面两处：
--   ① ops_rpl_rows：action_note / item_note / action_by 只给看得到厂家的人（看不到厂家的门市、电商、物流、分行拿到 null）。
--   ② ops_wh_stock：每行多回 item_total（商品全部仓位合计），前端「商品合计」用它——原本是本页加总，商品被分页切开或勾了「只看负库存」时数字不对。

create or replace function public.ops_rpl_rows(p jsonb default '{}'::jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  c text;
  minq int := coalesce(nullif(p->>'min_q', '')::int, 30);
  cs text := nullif(trim(coalesce(p->>'cs_code', '')), '');
  sup boolean;
  prices boolean;
  total bigint;
begin
  me := ops.require_level('purchasing', 'view');
  c := ops.rpl_company(me, p->>'company');
  sup := ops.sees_supplier(me);
  prices := ops.sees_prices(me);
  if minq not in (10, 30, 100) then minq := 30; end if;
  if not sup then cs := null; end if;
  select count(*) into total from bi.v_purchase_suggest v
  where v.company = c and not v.exclude and (v.q90 >= minq or v.owed_branch > 0 or v.on_hand <= 0)
    and (cs is null or v.cs_code = cs);
  return jsonb_build_object(
    'company', c, 'min_q', minq, 'cs_code', cs, 'total', total, 'capped', total > 3000,
    'rows', coalesce((
      select jsonb_agg(
        (to_jsonb(v) - 'company')
        || jsonb_build_object(
             -- 看不到厂家：不给供应商 / 上次 PO 的厂家 / 厂号 / 在途 PO 号
             'supplier_code', case when sup then v.supplier_code end,
             'supplier_name', case when sup then v.supplier_name end,
             'last_po_name', case when sup then v.last_po_name end,
             'cs_code', case when sup then v.cs_code end,
             'transit_pos', case when sup then v.transit_pos end,
             -- 采购的留言 / 商品备注 / 记录人 email 常写厂家名与 PO 号：同样只给看得到厂家的人（与厂家 DO 备注 remark 同规则）
             'action_note', case when sup then v.action_note end,
             'item_note', case when sup then v.item_note end,
             'action_by', case when sup then v.action_by end,
             -- 看不到进货单价：不给上次单价
             'last_price', case when prices then v.last_price end)
        order by v.days_left nulls first, v.item_code)
      from (select * from bi.v_purchase_suggest v
            where v.company = c and not v.exclude and (v.q90 >= minq or v.owed_branch > 0 or v.on_hand <= 0)
              and (cs is null or v.cs_code = cs)
            order by v.days_left nulls first, v.item_code
            limit 3000) v), '[]'::jsonb));
end $$;

create or replace function public.ops_wh_stock(p jsonb default '{}'::jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  c text;
  q text := trim(coalesce(p->>'q', ''));
  neg boolean := coalesce((p->>'neg_only')::boolean, false);
  pg int := greatest(0, coalesce(nullif(p->>'page', '')::int, 0));
  size int := 100;
  cost boolean;
  total bigint;
  neg_total bigint;
begin
  me := ops.require_level('warehouse', 'view');
  c := ops.wh_company(me, p->>'company');
  cost := ops.level_rank(ops.module_level(me, 'warehouse')) >= 3;
  select count(*), count(*) filter (where s.qty < 0) into total, neg_total
  from bi.fact_stock s left join bi.dim_item i on i.company = s.company and i.item_code = s.item_code
  where s.company = c and (not neg or s.qty < 0)
    and (q = '' or s.item_code ilike '%' || q || '%' or coalesce(i.description, '') ilike '%' || q || '%');
  return jsonb_build_object(
    'company', c, 'show_cost', cost, 'page', pg, 'page_size', size, 'total', total, 'neg_total', neg_total,
    'synced_at', ops.wh_synced_at(c),
    'rows', coalesce((select jsonb_agg(jsonb_build_object(
        'item_code', s.item_code, 'description', coalesce(i.description, s.item_code), 'item_group', i.item_group,
        'uom', i.base_uom, 'location', s.location, 'qty', s.qty,
        -- 商品合计：这个商品所有仓位（不受负库存筛选、分页影响）
        'item_total', (select sum(t.qty) from bi.fact_stock t where t.company = s.company and t.item_code = s.item_code),
        'total_cost', case when cost then s.total_cost end,
        'price2', i.price2, 'price3', i.price3, 'price4', i.price4)
        order by s.item_code, s.location)
      from (select s.* from bi.fact_stock s left join bi.dim_item i on i.company = s.company and i.item_code = s.item_code
            where s.company = c and (not neg or s.qty < 0)
              and (q = '' or s.item_code ilike '%' || q || '%' or coalesce(i.description, '') ilike '%' || q || '%')
            order by s.item_code, s.location
            offset pg * size limit size) s
      left join bi.dim_item i on i.company = s.company and i.item_code = s.item_code), '[]'::jsonb));
end $$;
