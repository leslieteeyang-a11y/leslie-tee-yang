-- HomeWorks 营运系统 — 把 BI 的三个分页搬进来（老板 2026-10-14：「把订货、滞销品、库存这三个移到员工多部门功能那边，BI 那边去掉」）
--   * 订货与 ETA 模块多两个分页：「补货建议」（BI 订货页的补货建议：近 90 天走量 ≥ 门槛、欠分行、没货的商品，建议订量、
--     已下单 / 暂不订、商品设定）与「供应商交期」（交期 / 安全 / 覆盖 / 订货周期、品牌 → 默认供应商）。
--   * 仓库模块多两个分页：「库存总表」（商品 × 仓位的现存量与售价）与「滞销品」（最后进货超过 3 / 6 个月还没售完）。
--   * 资料仍是 BI 同步进来的 bi.* 表；算法沿用 BI 的视图。public.bi_purchase_suggest 原本把计算与「BI 名单检查」写在同一个
--     视图里，这里拆成 bi.v_purchase_suggest（只有计算）+ public.bi_purchase_suggest（读它 + 原本的检查，输出栏位不变），
--     营运系统的函数读 bi.v_purchase_suggest，用营运系统自己的部门权限把关。
--   * 权限：补货建议 = 订货「只看」可看（看不到厂家的人：不显示供应商 / 厂号 / PO 号；看不到进货单价的人：不显示上次单价与采购额），
--     已下单 / 暂不订 / 商品设定 = 订货「可编辑」；供应商交期 = 看得到厂家的人可看、订货「可编辑」可改；
--     库存总表 / 滞销品 = 仓库「只看」可看，成本只给仓库「可审批」（与查货、差异审核、旧货同一规则）。
--   * 已下单 / 暂不订 / 商品设定 / 供应商设定仍写进 BI 的 bi.buyer_* 表（与 BI 共用同一份设定，created_by / updated_by = 员工 email）。
-- 这个档案不含删除指令：Supabase MCP 的 apply_migration 看到 delete / drop 会等使用者确认，无人确认就整段取消（2026-10-14 踩到），
-- 所以「撤销」不删 bi.buyer_item_action 的行，改标记 undone_at / undone_by（顺便留审计），视图把已撤销的行滤掉；BI 自己的
-- bi_delete_item_action 仍是硬删，两者并存。
-- 已套用到 Supabase（2026-10-14，分 6 段套用，名称 ops_bi_pages_1_views ～ ops_bi_pages_6_grants；每段都是 create or replace，可重跑）。

-- ------------------------------------------------------------ 1. 补货建议：基础视图（计算），public 视图改读它
-- 撤销用的标记栏（BI 原本没有；BI 的撤销是硬删，这里改软撤销）
alter table bi.buyer_item_action add column if not exists undone_at timestamptz;
alter table bi.buyer_item_action add column if not exists undone_by text;

create or replace view bi.v_purchase_suggest with (security_invoker = true) as
with sold as (
  select m.company, m.item_code, m.q90, m.q365, m.q90_branch_excl, m.q30, m.q90_ly, m.first_sale_win, m.last_sale
  from bi.mv_purchase_sold m
), stk as (
  select f.company, f.item_code,
         coalesce(sum(f.qty) filter (where f.location <> all (array['DEFECTS', 'DISPLAY', 'JB', 'PRE (JB)'])), 0) as on_hand,
         coalesce(sum(f.qty) filter (where f.location = 'JB'), 0) as jb_reserved,
         greatest(0, -coalesce(sum(f.qty) filter (where f.location = 'PRE (JB)'), 0)) as owed_branch,
         string_agg(f.location || ':' || round(f.qty)::text, ' / ' order by f.location) filter (where f.qty <> 0) as by_loc
  from bi.fact_stock f
  where f.location <> all (array['DEFECTS', 'DISPLAY'])
  group by f.company, f.item_code
), transit as (
  select l.company, l.item_code,
         sum(l.qty - l.transferred_qty) as transit_qty,
         min(case when l.est_delivery > l.po_date then l.est_delivery else l.po_date + coalesce(sp.lead_days, 7) end) as transit_eta,
         string_agg(distinct l.po_no, ', ') as transit_pos
  from bi.fact_po_line l
  left join bi.v_supplier_param sp on sp.company = l.company and sp.creditor_code = l.creditor_code
  where not l.cancelled and l.qty > l.transferred_qty and l.po_date >= current_date - 120
  group by l.company, l.item_code
), act as (
  select distinct on (a.company, a.item_code) a.company, a.item_code, a.id as action_id, a.action, a.qty as action_qty,
         a.until_date, a.note as action_note, a.created_by as action_by, a.created_at as action_at
  from bi.buyer_item_action a
  where a.undone_at is null
  order by a.company, a.item_code, a.created_at desc
), base as (
  select coalesce(s.company, st.company) as company, coalesce(s.item_code, st.item_code) as item_code,
         coalesce(s.q90, 0) as q90, coalesce(s.q365, 0) as q365, coalesce(s.q90_branch_excl, 0) as q90_branch_excl,
         coalesce(s.q30, 0) as q30, coalesce(s.q90_ly, 0) as q90_ly, s.first_sale_win, s.last_sale,
         coalesce(st.on_hand, 0) as on_hand, coalesce(st.jb_reserved, 0) as jb_reserved,
         coalesce(st.owed_branch, 0) as owed_branch, st.by_loc
  from sold s
  full join stk st on st.company = s.company and st.item_code = s.item_code
  where coalesce(s.q90, 0) > 0 or coalesce(st.owed_branch, 0) > 0
), calc as (
  select b.company, b.item_code, coalesce(i.description, b.item_code) as description, i.item_group, i.base_uom,
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
  where b.item_code <> all (array['VOUCHER', 'SHIPPING FEE']) and b.item_code not like 'ONLINE%'
), calc1 as (
  select c.*,
         greatest(c.daily_year, c.daily_ly) as order_rate,
         coalesce(sp.name, c.last_po_name, '中国供应商(未指定)') as supplier_name,
         coalesce(sp.is_china, true) as is_china,
         coalesce(sp.lead_days, 60) as lead_days,
         coalesce(sp.safety_days, 14) as safety_days,
         coalesce(sp.cover_days, 30) as cover_days,
         nullif(upper(replace(coalesce(substring(c.last_po_name from '[Cc][Ss] ?[0-9]+'),
                                       substring(sp.po_name from '[Cc][Ss] ?[0-9]+')), ' ', '')), '') as cs_code
  from calc c
  left join bi.v_supplier_param sp on sp.company = c.company and sp.creditor_code = c.supplier_code
), calc2 as (
  select c.*,
         round(c.on_hand / nullif(c.daily_avg, 0))::int as days_left,
         round((c.on_hand + c.transit_qty) / nullif(c.daily_avg, 0))::int as days_left_incl_transit,
         c.lead_days + c.safety_days as reorder_days,
         greatest(0, ceil((c.lead_days + c.safety_days + c.cover_days)::numeric * c.order_rate + c.owed_branch - c.on_hand - c.transit_qty)) as raw_qty,
         (c.on_hand + c.transit_qty) < c.owed_branch as branch_short,
         case when c.action = 'skip' and (c.until_date is null or c.until_date >= current_date) then 'skip'
              when c.action = 'ordered' and c.action_at >= now() - interval '30 days' then 'ordered' end as action_status
  from calc1 c
)
select c.company, c.item_code, c.description, c.item_group, c.base_uom,
       c.q90, c.q365, c.q90_branch_excl, c.q30, c.q90_ly, c.last_sale, c.daily_avg, c.daily_year, c.daily_ly,
       c.on_hand, c.jb_reserved, c.owed_branch, c.by_loc, c.transit_qty, c.transit_eta, c.transit_pos,
       c.supplier_code, c.last_po_name, c.last_price, c.last_po_date, c.po_24m, c.min_order_qty, c.pack_size, c.exclude,
       c.item_note, c.last_receipt_date, c.item_type,
       c.action_id, c.action, c.action_qty, c.until_date, c.action_note, c.action_by, c.action_at,
       c.order_rate, c.supplier_name, c.is_china, c.lead_days, c.safety_days, c.cover_days, c.cs_code,
       c.days_left, c.days_left_incl_transit, c.reorder_days, c.raw_qty, c.branch_short, c.action_status,
       (c.days_left_incl_transit <= c.reorder_days or c.branch_short) as need_order,
       case when c.branch_short then 'late' when c.on_hand <= 0 then 'out' when c.days_left < c.lead_days then 'late'
            when c.days_left_incl_transit <= c.reorder_days then 'now' else 'ok' end as urgency,
       current_date + greatest(0, coalesce(c.days_left, 0)) as est_out_date,
       case when c.pack_size > 0 then ceil(greatest(c.raw_qty, coalesce(c.min_order_qty, 0)) / c.pack_size) * c.pack_size
            else greatest(c.raw_qty, coalesce(c.min_order_qty, 0)) end as suggest_qty,
       (c.days_left_incl_transit > c.reorder_days and not c.branch_short and c.days_left_incl_transit <= c.reorder_days + 30) as fill_candidate
from calc2 c;
grant select on bi.v_purchase_suggest to authenticated;

-- BI 自己的视图：栏位、顺序不变；原本只在 sold 这一段按 bi_company() 过滤，现在整列过滤（HQ 老板看到的完全一样）
create or replace view public.bi_purchase_suggest with (security_invoker = true) as
select v.* from bi.v_purchase_suggest v
where (select public.bi_is_allowed())
  and ((select public.bi_company()) is null or v.company = (select public.bi_company()))
  and coalesce((select public.bi_role()), '') <> 'sales';

-- ------------------------------------------------------------ 2. 小工具
-- 要查哪间公司：没填就照员工的分店（ALL = 总部）；看不到的分店拒绝
create or replace function ops.rpl_company(p_me ops.staff, p_company text) returns text
language plpgsql stable set search_path = '' as $$
declare
  c text := coalesce(nullif(p_company, ''), case when p_me.branch = 'ALL' then 'HOMEWORKSSB' else p_me.branch end);
begin
  if c not in ('HOMEWORKSSB', 'HOMEWORKSSOUTHERN') or not ops.sees_company(p_me, c) then
    raise exception '你没有这间分店的订货权限。' using errcode = '42501';
  end if;
  return c;
end $$;

-- ------------------------------------------------------------ 3. 补货建议
-- 页面设定：权限、分店、同步时间、厂号清单（各门槛下会载入几项）、该下单的供应商
create or replace function public.ops_rpl_meta(p_company text default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
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
    'companies', (select jsonb_agg(x order by x) from unnest(array['HOMEWORKSSB', 'HOMEWORKSSOUTHERN']) x where ops.sees_company(me, x)),
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
end $$;

-- 清单：p = {company, min_q: 10 | 30 | 100, cs_code}
-- 载入规则与 BI 相同：近 90 天销量 ≥ 门槛，或欠分行，或现存 ≤ 0；已设「不再提醒」的不列；最多 3000 项（急的排前面）
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
             -- 看不到进货单价：不给上次单价
             'last_price', case when prices then v.last_price end)
        order by v.days_left nulls first, v.item_code)
      from (select * from bi.v_purchase_suggest v
            where v.company = c and not v.exclude and (v.q90 >= minq or v.owed_branch > 0 or v.on_hand <= 0)
              and (cs is null or v.cs_code = cs)
            order by v.days_left nulls first, v.item_code
            limit 3000) v), '[]'::jsonb));
end $$;

-- 已下单 / 暂不订 / 留言：p = {company, item_code, action: ordered | skip | note, qty, until_date, note}
create or replace function public.ops_rpl_action(p jsonb) returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  c text;
  code text := trim(coalesce(p->>'item_code', ''));
  act text := coalesce(p->>'action', '');
  v_id bigint;
begin
  me := ops.require_level('purchasing', 'edit');
  c := ops.rpl_company(me, p->>'company');
  if act not in ('ordered', 'skip', 'note') then
    raise exception '不认识的动作：%', act using errcode = '22023';
  end if;
  if code = '' or not exists (select 1 from bi.dim_item i where i.company = c and i.item_code = code) then
    raise exception '找不到商品 %。', code using errcode = '22023';
  end if;
  insert into bi.buyer_item_action (company, item_code, action, qty, until_date, note, created_by)
  values (c, code, act, nullif(p->>'qty', '')::numeric, nullif(p->>'until_date', '')::date,
          left(trim(coalesce(p->>'note', '')), 500), me.email)
  returning id into v_id;
  perform ops.log(me.id, 'rpl_action', 'buyer_item_action', v_id, p);
  return v_id;
end $$;

-- 撤销：自己记的，或订货「可审批」的人；软撤销（标记 undone_at / undone_by，视图不再算它）
create or replace function public.ops_rpl_action_undo(p_id bigint) returns int
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  n int;
begin
  me := ops.require_level('purchasing', 'edit');
  update bi.buyer_item_action a set undone_at = now(), undone_by = me.email
  where a.id = p_id and a.undone_at is null and ops.sees_company(me, a.company)
    and (lower(coalesce(a.created_by, '')) = lower(me.email) or ops.level_rank(ops.module_level(me, 'purchasing')) >= 3);
  get diagnostics n = row_count;
  if n = 0 then
    raise exception '这笔不是你记的，只有订货「可审批」的人能撤销。' using errcode = '42501';
  end if;
  perform ops.log(me.id, 'rpl_action_undo', 'buyer_item_action', p_id, null);
  return n;
end $$;

-- 商品设定：p = {company, item_code, supplier_code, min_order_qty, pack_size, exclude, note, action_note}
create or replace function public.ops_rpl_item_setting_save(p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  c text;
  code text := trim(coalesce(p->>'item_code', ''));
  sup text := nullif(trim(coalesce(p->>'supplier_code', '')), '');
begin
  me := ops.require_level('purchasing', 'edit');
  c := ops.rpl_company(me, p->>'company');
  if code = '' or not exists (select 1 from bi.dim_item i where i.company = c and i.item_code = code) then
    raise exception '找不到商品 %。', code using errcode = '22023';
  end if;
  if sup is not null and not ops.sees_supplier(me) then
    raise exception '你看不到厂家，不能指定供应商。' using errcode = '42501';
  end if;
  insert into bi.buyer_item_setting (company, item_code, supplier_code, min_order_qty, pack_size, exclude, note, updated_by, updated_at)
  values (c, code, sup, nullif(p->>'min_order_qty', '')::numeric, nullif(p->>'pack_size', '')::numeric,
          coalesce((p->>'exclude')::boolean, false), left(trim(coalesce(p->>'note', '')), 500), me.email, now())
  on conflict (company, item_code) do update set
    supplier_code = excluded.supplier_code, min_order_qty = excluded.min_order_qty, pack_size = excluded.pack_size,
    exclude = excluded.exclude, note = excluded.note, updated_by = excluded.updated_by, updated_at = now();
  if trim(coalesce(p->>'action_note', '')) <> '' then
    insert into bi.buyer_item_action (company, item_code, action, note, created_by)
    values (c, code, 'note', left(trim(p->>'action_note'), 500), me.email);
  end if;
  perform ops.log(me.id, 'rpl_item_setting', 'buyer_item_setting', null, p);
end $$;

-- ------------------------------------------------------------ 4. 供应商交期（看得到厂家的人）
create or replace function public.ops_rpl_suppliers(p_company text default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  c text;
begin
  me := ops.require_level('purchasing', 'view');
  c := ops.rpl_company(me, p_company);
  if not ops.sees_supplier(me) then
    raise exception '只有看得到厂家的人（采购、管理层、仓库部、开单部）能看供应商交期。' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'company', c,
    'can_edit', ops.level_rank(ops.module_level(me, 'purchasing')) >= 2,
    'suppliers', (select coalesce(jsonb_agg(to_jsonb(s) - 'company' order by s.po_24m desc nulls last, s.name), '[]'::jsonb)
                  from bi.v_supplier_param s where s.company = c),
    -- 品牌 → 默认供应商（没有采购纪录的商品按品牌归入）
    'brands', (select coalesce(jsonb_agg(jsonb_build_object('item_type', b.item_type, 'item_count', b.item_count,
                                                             'active_count', b.active_count, 'supplier_code', b.supplier_code,
                                                             'supplier_name', b.supplier_name, 'note', b.note)
                                         order by b.active_count desc, b.item_type), '[]'::jsonb)
               from (select i.item_type, count(*) as item_count, count(*) filter (where i.is_active) as active_count,
                            bb.supplier_code, sp.name as supplier_name, bb.note
                     from bi.dim_item i
                     left join bi.buyer_brand_supplier bb on bb.company = i.company and bb.item_type = i.item_type
                     left join bi.v_supplier_param sp on sp.company = i.company and sp.creditor_code = bb.supplier_code
                     where i.company = c and i.item_type is not null and i.item_type <> ''
                     group by i.item_type, bb.supplier_code, sp.name, bb.note) b));
end $$;

-- 供应商设定：p = {company, creditor_code, lead_days, safety_days, cover_days, is_china, note, cycle_days}（留空 = 用默认）
create or replace function public.ops_rpl_supplier_save(p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  c text;
  code text := trim(coalesce(p->>'creditor_code', ''));
  lead int := nullif(p->>'lead_days', '')::int;
  safety int := nullif(p->>'safety_days', '')::int;
  cover int := nullif(p->>'cover_days', '')::int;
  cyc int := nullif(p->>'cycle_days', '')::int;
begin
  me := ops.require_level('purchasing', 'edit');
  c := ops.rpl_company(me, p->>'company');
  if not ops.sees_supplier(me) then
    raise exception '你看不到厂家，不能改供应商设定。' using errcode = '42501';
  end if;
  if code = '' or not exists (select 1 from bi.v_supplier_param s where s.company = c and s.creditor_code = code) then
    raise exception '找不到供应商 %。', code using errcode = '22023';
  end if;
  if lead is not null and (lead < 0 or lead > 365) then raise exception '交期要在 0–365 天之间。' using errcode = '22023'; end if;
  if safety is not null and (safety < 0 or safety > 180) then raise exception '安全天数要在 0–180 天之间。' using errcode = '22023'; end if;
  if cover is not null and (cover < 1 or cover > 365) then raise exception '覆盖天数要在 1–365 天之间。' using errcode = '22023'; end if;
  if cyc is not null and (cyc < 1 or cyc > 365) then raise exception '订货周期要在 1–365 天之间。' using errcode = '22023'; end if;
  insert into bi.buyer_supplier_setting (company, creditor_code, lead_days, safety_days, cover_days, is_china, note, order_cycle_days, updated_by, updated_at)
  values (c, code, lead, safety, cover, nullif(p->>'is_china', '')::boolean, left(trim(coalesce(p->>'note', '')), 500), cyc, me.email, now())
  on conflict (company, creditor_code) do update set
    lead_days = excluded.lead_days, safety_days = excluded.safety_days, cover_days = excluded.cover_days,
    is_china = excluded.is_china, note = excluded.note, order_cycle_days = excluded.order_cycle_days,
    updated_by = excluded.updated_by, updated_at = now();
  perform ops.log(me.id, 'rpl_supplier_setting', 'buyer_supplier_setting', null, p);
end $$;

-- 品牌 → 默认供应商：p = {company, item_type, supplier_code}（supplier_code 空 = 取消分配，行留着、supplier_code 清成 null）
create or replace function public.ops_rpl_brand_supplier_save(p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  c text;
  brand text := trim(coalesce(p->>'item_type', ''));
  sup text := nullif(trim(coalesce(p->>'supplier_code', '')), '');
begin
  me := ops.require_level('purchasing', 'edit');
  c := ops.rpl_company(me, p->>'company');
  if not ops.sees_supplier(me) then
    raise exception '你看不到厂家，不能分配供应商。' using errcode = '42501';
  end if;
  if brand = '' then raise exception '请选品牌。' using errcode = '22023'; end if;
  if sup is null then
    -- 取消分配：不删行（见档头），把 supplier_code 清空即可；视图与 bi_brands 都把 null 当没分配
    update bi.buyer_brand_supplier b set supplier_code = null, updated_by = me.email, updated_at = now()
    where b.company = c and b.item_type = brand;
  else
    if not exists (select 1 from bi.v_supplier_param s where s.company = c and s.creditor_code = sup) then
      raise exception '找不到供应商 %。', sup using errcode = '22023';
    end if;
    insert into bi.buyer_brand_supplier (company, item_type, supplier_code, note, updated_by, updated_at)
    values (c, brand, sup, left(trim(coalesce(p->>'note', '')), 300), me.email, now())
    on conflict (company, item_type) do update set
      supplier_code = excluded.supplier_code, note = excluded.note, updated_by = excluded.updated_by, updated_at = now();
  end if;
  perform ops.log(me.id, 'rpl_brand_supplier', 'buyer_brand_supplier', null, p);
end $$;

-- ------------------------------------------------------------ 5. 仓库：库存总表、滞销品
-- 库存总表：p = {company, q, neg_only, page（从 0 起）}；一页 100 行（商品 × 仓位）；成本只给仓库「可审批」
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

-- 滞销品：p = {company, min_months, max_months, page}；一页 50 项；按成本（看不到成本的按现存量）从高到低
create or replace function public.ops_wh_slow(p jsonb default '{}'::jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  c text;
  lo int := coalesce(nullif(p->>'min_months', '')::int, 6);
  hi int := nullif(p->>'max_months', '')::int;
  pg int := greatest(0, coalesce(nullif(p->>'page', '')::int, 0));
  size int := 50;
  cost boolean;
  total bigint;
begin
  me := ops.require_level('warehouse', 'view');
  c := ops.wh_company(me, p->>'company');
  cost := ops.level_rank(ops.module_level(me, 'warehouse')) >= 3;
  return (
    with r as (
      select a.item_code, coalesce(i.description, a.item_code) as description, i.item_group, a.last_receipt_date,
             (extract(year from age(ops.today(), a.last_receipt_date)) * 12 + extract(month from age(ops.today(), a.last_receipt_date)))::int as months_since,
             a.on_hand, a.stock_value, a.sold_since
      from bi.fact_item_aging a
      left join bi.dim_item i on i.company = a.company and i.item_code = a.item_code
      where a.company = c and a.on_hand > 0 and a.last_receipt_date is not null),
    f as (select * from r where r.months_since >= lo and (hi is null or r.months_since < hi))
    select jsonb_build_object(
      'company', c, 'show_cost', cost, 'page', pg, 'page_size', size, 'total', (select count(*) from f),
      'rows', coalesce((select jsonb_agg(jsonb_build_object(
          'item_code', f.item_code, 'description', f.description, 'item_group', f.item_group,
          'last_receipt_date', f.last_receipt_date, 'months_since', f.months_since, 'on_hand', f.on_hand,
          'stock_value', case when cost then f.stock_value end, 'sold_since', f.sold_since)
          order by case when cost then f.stock_value else f.on_hand end desc, f.item_code)
        from (select * from f order by case when cost then f.stock_value else f.on_hand end desc, f.item_code
              offset pg * size limit size) f), '[]'::jsonb))
    from (select 1) one);
end $$;

-- ------------------------------------------------------------ 6. 权限
revoke all on function ops.rpl_company(ops.staff, text) from public, anon, authenticated;
do $$
declare
  f text;
begin
  foreach f in array array['ops_rpl_meta(text)', 'ops_rpl_rows(jsonb)', 'ops_rpl_action(jsonb)', 'ops_rpl_action_undo(bigint)',
                           'ops_rpl_item_setting_save(jsonb)', 'ops_rpl_suppliers(text)', 'ops_rpl_supplier_save(jsonb)',
                           'ops_rpl_brand_supplier_save(jsonb)', 'ops_wh_stock(jsonb)', 'ops_wh_slow(jsonb)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
