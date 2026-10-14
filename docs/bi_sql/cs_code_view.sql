-- 2026-10-14 订货页「CS 厂号」下拉改列全部厂号并标件数（修法 A，使用者「做 A」）。migration：cs_code_view
-- 原本下拉只列「目前载入的走量品」身上的厂号（诊断见 docs/bi_web/cs_dropdown_2026-10-14.md），商品不走量的厂号就看不到。
-- 这个视图：PO 供应商名称里出现过的每个 CS 码一行，附最近一张 PO 挂此码的商品数（含无销售）、候选名单内的商品数、
-- 前端三个门槛（10 / 30 / 100）下各会载入几行。件数直接从 public.bi_purchase_suggest 汇总，口径与前端载入条件完全一致
--（exclude=false 且 q90≥门槛 或 欠分行），以后 cs_code 算法若改，这里自动跟着变。老板帐号实测 0.7 秒。
-- v2（同日审查后，migration cs_code_view_v2）：items 也排除 exclude、多一栏 excluded；codes / creditor_codes 只算未取消的 PO。
create or replace view public.bi_cs_code with (security_invoker = true) as
with codes as (
  select company,
         upper(replace(substring(creditor_name from '[Cc][Ss] ?[0-9]+'), ' ', '')) as cs_code,
         count(distinct po_no) filter (where not cancelled) as n_po,
         min(po_date) filter (where not cancelled) as first_po_date,
         max(po_date) filter (where not cancelled) as last_po_date,
         string_agg(distinct creditor_code, ', ') as creditor_codes
  from bi.fact_po_line
  where not cancelled and creditor_name ~ '[Cc][Ss] ?[0-9]+'
  group by 1, 2
), lastpo as (   -- 最近一张 PO 挂此码的商品数（含近 90 天没销售的）
  select company, upper(replace(substring(last_supplier_name from '[Cc][Ss] ?[0-9]+'), ' ', '')) as cs_code, count(*) as items_last_po
  from bi.v_item_supplier
  where last_supplier_name ~ '[Cc][Ss] ?[0-9]+'
  group by 1, 2
), sug as (      -- 候选名单（近 90 天有销售或欠分行）内的商品，按前端三个门槛各算会载入几行
  select company, cs_code,
         count(*) filter (where not exclude) as items,
         count(*) filter (where exclude) as excluded,
         count(*) filter (where not exclude and (q90 >= 10  or owed_branch > 0)) as loaded10,
         count(*) filter (where not exclude and (q90 >= 30  or owed_branch > 0)) as loaded30,
         count(*) filter (where not exclude and (q90 >= 100 or owed_branch > 0)) as loaded100
  from public.bi_purchase_suggest
  where cs_code is not null
  group by 1, 2
)
select c.company, c.cs_code, c.n_po, c.first_po_date, c.last_po_date, c.creditor_codes,
       coalesce(l.items_last_po, 0) as items_last_po,
       coalesce(s.items, 0) as items,
       coalesce(s.loaded10, 0) as loaded10,
       coalesce(s.loaded30, 0) as loaded30,
       coalesce(s.loaded100, 0) as loaded100,
       coalesce(s.excluded, 0) as excluded   -- v2 加的栏放最后：create or replace view 不能在中间插栏
from codes c
left join lastpo l on l.company = c.company and l.cs_code = c.cs_code
left join sug s on s.company = c.company and s.cs_code = c.cs_code
where (select bi_is_allowed())
  and ((select bi_company()) is null or c.company = (select bi_company()))
  and coalesce((select bi_role()), '') <> 'sales';
grant select on public.bi_cs_code to authenticated;
