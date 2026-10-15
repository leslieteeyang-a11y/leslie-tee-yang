-- HomeWorks 营运系统 — 仓库新功能上线前的效能修正（2026-10-15，正式环境实测后加）
-- 问题：「已开 DO 还没拣」（ops.wh_do_unpicked）每算一次要把这间公司 5,780 个商品的品名都整理一遍（去空白、转大写）
-- 再跟 DO 明细比对，正式环境一次 0.2 秒。上架 / 改数每一行都要算一次应有（ops.wh_bin_expected），
-- 点货后一次上架 300 行就要一分钟（超过 8 秒会被资料库中断）；查货一个商品也要算三次。
-- 修正：
--   ① bi.dim_item 加「整理过的品名」索引（只用内建函数；BI 同步照常写入，跟 dim_item_company_upper_code_idx 一样）
--   ② ops.wh_do_unpicked：品名整理直接写在查询里（函数有 set search_path 不会被展开，每叫一次都有额外成本），
--      用 DO 上出现的品名去索引找商品，不再整理全部商品
--   ③ 新增 ops.wh_do_unpicked_for(公司, 商品)：只算一个商品（规则跟 ops.wh_do_unpicked 完全一样，测试逐一比对），
--      ops.wh_do_unpicked_item 改用它
--   ④ ops_wh_item_bins：每个仓位的 AutoCount / 搬动 / DO 未拣 / 货架合计只算一次
--   ⑤ ops_wh_bin_undo：主管改数但数量没变的动作，撤销时说「没有改到数量」，不再说「已经撤销过了」
-- 可以重复套用。

-- ============================================================ 1. 索引
-- 跟下面查询里的写法一字不差，索引才用得到
create index if not exists dim_item_company_norm_desc_idx
  on bi.dim_item (company, upper(regexp_replace(btrim(coalesce(description, '')), '\s+', ' ', 'g')));

-- ============================================================ 2. 已开 DO 还没拣
-- 规则同 20261017b：近 7 天开的、没取消、还没拣好、还没送达的 DO；已开始拣的照拣货单（扣掉已从货架扣的），
-- 还没开始的照 DO 明细配对商品（c 商品代号 > 品名唯一相同）。
create or replace function ops.wh_do_unpicked(p_company text) returns table (item_code text, qty numeric)
language sql stable security definer set search_path = '' as $$
  with docs as (
    select d.doc_no, d.lines from bi.delivery_doc d
    where d.company = p_company and not d.cancelled and d.doc_date >= (select ops.today()) - 7
      and not exists (select 1 from ops.wh_pick k where k.company = p_company and k.doc_no = d.doc_no and k.status = 'done')
      and not exists (select 1 from bi.delivery_pod pd join bi.delivery_run r on r.id = pd.run_id
                      where r.store = (select ops.dlv_store(p_company)) and pd.doc_no = d.doc_no and pd.status = 'delivered')),
  started as (
    select l.item_code, greatest(l.qty - coalesce((select sum(sc.qty) from ops.wh_pick_scan sc
                                                   where sc.line_id = l.id and not sc.voided and sc.bin_id is not null), 0), 0) q
    from ops.wh_pick k join ops.wh_pick_line l on l.pick_id = k.id
    where k.company = p_company and k.status = 'picking' and k.doc_no in (select doc_no from docs)
      and l.item_code is not null and not l.skip),
  raw as (
    select nullif(upper(regexp_replace(btrim(coalesce(x->>'d', '')), '\s+', ' ', 'g')), '') nd,
           nullif(btrim(coalesce(x->>'c', '')), '') c,
           greatest(case when jsonb_typeof(x->'q') = 'number' then (x->'q' #>> '{}')::numeric
                         when jsonb_typeof(x->'q') = 'string' and btrim(x->>'q') ~ '^-?[0-9]+(\.[0-9]+)?$' then btrim(x->>'q')::numeric
                         else 0 end, 0) q
    from docs
    cross join lateral jsonb_array_elements(case when jsonb_typeof(docs.lines) = 'array' then docs.lines else '[]'::jsonb end) x
    where not exists (select 1 from ops.wh_pick k where k.company = p_company and k.doc_no = docs.doc_no and k.status = 'picking')),
  dn as (   -- DO 上出现的每个品名对到几个商品（用索引一个一个找）
    select u.nd, m.item_code, m.n
    from (select distinct r.nd from raw r where r.nd is not null) u
    cross join lateral (
      select min(i.item_code) item_code, count(distinct i.item_code) n
      from bi.dim_item i
      where i.company = p_company
        and upper(regexp_replace(btrim(coalesce(i.description, '')), '\s+', ' ', 'g')) = u.nd) m),
  notstarted as (
    select coalesce((select i.item_code from bi.dim_item i where i.company = p_company and r.c is not null
                       and upper(i.item_code) = upper(r.c) limit 1),
                    case when dn.n = 1 then dn.item_code end) item_code, r.q
    from raw r left join dn on dn.nd = r.nd)
  select z.item_code, sum(z.q) from (select item_code, q from started union all select item_code, q from notstarted) z
  where z.item_code is not null
  group by z.item_code having sum(z.q) > 0
$$;

-- 只算一个商品（上架、查货、盘点每次只要一个商品）；结果跟 ops.wh_do_unpicked 里这个商品那一行相同，没有 = 0
create or replace function ops.wh_do_unpicked_for(p_company text, p_item text) returns numeric
language sql stable security definer set search_path = '' as $$
  with uniq as (   -- 这个商品整理过的品名，而且这间公司只有它叫这个名字（品名配对才算它）
    select x.nd from (
      select upper(regexp_replace(btrim(coalesce(i.description, '')), '\s+', ' ', 'g')) nd
      from bi.dim_item i where i.company = p_company and i.item_code = p_item) x
    where x.nd <> ''
      and (select count(distinct i.item_code) from bi.dim_item i
           where i.company = p_company
             and upper(regexp_replace(btrim(coalesce(i.description, '')), '\s+', ' ', 'g')) = x.nd) = 1),
  docs as (
    select d.doc_no, d.lines from bi.delivery_doc d
    where d.company = p_company and not d.cancelled and d.doc_date >= (select ops.today()) - 7
      and not exists (select 1 from ops.wh_pick k where k.company = p_company and k.doc_no = d.doc_no and k.status = 'done')
      and not exists (select 1 from bi.delivery_pod pd join bi.delivery_run r on r.id = pd.run_id
                      where r.store = (select ops.dlv_store(p_company)) and pd.doc_no = d.doc_no and pd.status = 'delivered')),
  started as (
    select greatest(l.qty - coalesce((select sum(sc.qty) from ops.wh_pick_scan sc
                                      where sc.line_id = l.id and not sc.voided and sc.bin_id is not null), 0), 0) q
    from ops.wh_pick k join ops.wh_pick_line l on l.pick_id = k.id
    where k.company = p_company and k.status = 'picking' and k.doc_no in (select doc_no from docs)
      and l.item_code = p_item and not l.skip),
  raw as (
    select nullif(upper(regexp_replace(btrim(coalesce(x->>'d', '')), '\s+', ' ', 'g')), '') nd,
           nullif(btrim(coalesce(x->>'c', '')), '') c,
           greatest(case when jsonb_typeof(x->'q') = 'number' then (x->'q' #>> '{}')::numeric
                         when jsonb_typeof(x->'q') = 'string' and btrim(x->>'q') ~ '^-?[0-9]+(\.[0-9]+)?$' then btrim(x->>'q')::numeric
                         else 0 end, 0) q
    from docs
    cross join lateral jsonb_array_elements(case when jsonb_typeof(docs.lines) = 'array' then docs.lines else '[]'::jsonb end) x
    where not exists (select 1 from ops.wh_pick k where k.company = p_company and k.doc_no = docs.doc_no and k.status = 'picking')),
  mine as (   -- 配对结果 = 这个商品的行：c 对到的商品优先，c 没对到才看品名
    select r.q from raw r
    where coalesce((select i.item_code from bi.dim_item i where i.company = p_company and r.c is not null
                      and upper(i.item_code) = upper(r.c) limit 1),
                   case when r.nd = (select u.nd from uniq u) then p_item end) = p_item)
  select coalesce((select sum(q) from started), 0) + coalesce((select sum(q) from mine), 0)
$$;

-- 一个商品在某仓位的已开 DO 未拣（DO 没有仓位：算在这间公司的主要仓位）
create or replace function ops.wh_do_unpicked_item(p_company text, p_item text, p_loc text) returns numeric
language sql stable security definer set search_path = '' as $$
  select case when p_loc = ops.podo_main_loc(p_company) then ops.wh_do_unpicked_for(p_company, p_item) else 0 end
$$;

-- ============================================================ 3. 查货：一个商品在各仓位的货架分布（每个仓位的数字只算一次）
create or replace function public.ops_wh_item_bins(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  c text;
  v_item text;
begin
  me := ops.require_level('warehouse', 'view');
  c := ops.wh_company(me, p->>'company');
  v_item := ops.wh_resolve(c, p->>'item');
  if v_item is null then
    raise exception '找不到这个商品，请重新扫或打商品代号。' using errcode = 'P0002';
  end if;
  return jsonb_build_object(
    'item_code', v_item,
    'description', (select coalesce(i.description, v_item) from bi.dim_item i where i.company = c and i.item_code = v_item),
    'uom', (select i.base_uom from bi.dim_item i where i.company = c and i.item_code = v_item),
    'locations', coalesce((
      select jsonb_agg(jsonb_build_object(
          'location', l.loc,
          'ac_qty', v.ac,
          'pending', v.pe,
          'do_unpicked', v.du,
          'expected', v.ac + v.pe + v.du,
          'shelved', v.sh,
          'unshelved', v.ac + v.pe + v.du - v.sh,
          'has_bins', exists (select 1 from ops.wh_bin b where b.company = c and b.location = l.loc and b.active),
          'bins', coalesce((
            select jsonb_agg(ops.wh_bin_json(b) || jsonb_build_object('qty', s.qty, 'updated_at', s.updated_at)
              order by s.qty desc, b.sort, b.code)
            from ops.wh_bin_stock s join ops.wh_bin b on b.id = s.bin_id
            where s.company = c and s.item_code = v_item and b.location = l.loc), '[]'::jsonb))
        order by coalesce(wl.sort, 50), l.loc)
      from (select f.location loc from bi.fact_stock f where f.company = c and f.item_code = v_item and f.qty <> 0
            union select b.location from ops.wh_bin_stock s join ops.wh_bin b on b.id = s.bin_id
                  where s.company = c and s.item_code = v_item
            union select m.to_loc from ops.wh_move m where m.company = c and m.item_code = v_item and m.status = 'pending' and m.to_loc is not null) l
      left join ops.wh_location wl on wl.company = c and wl.code = l.loc
      cross join lateral (
        select coalesce((select sum(f.qty) from bi.fact_stock f where f.company = c and f.item_code = v_item and f.location = l.loc), 0) ac,
               ops.wh_pending(c, v_item, l.loc) pe,
               ops.wh_do_unpicked_item(c, v_item, l.loc) du,
               ops.wh_bin_shelved(c, v_item, l.loc) sh
        offset 0) v), '[]'::jsonb),   -- offset 0：不让查询展开后每个栏位各算一次
    'log', coalesce((
      select jsonb_agg(x.j order by x.id desc) from (
        select g.id, jsonb_build_object('id', g.id, 'bin_id', g.bin_id,
          'bin', (select b.location || ' · ' || b.code from ops.wh_bin b where b.id = g.bin_id),
          'delta', g.delta, 'qty_after', g.qty_after, 'kind', g.kind, 'ref_type', g.ref_type, 'ref_id', g.ref_id,
          'note', g.note, 'created_at', g.created_at, 'reversed', g.reversed_by is not null,
          'by_name', (select st.name from ops.staff st where st.id = g.created_by)) j
        from ops.wh_bin_log g where g.company = c and g.item_code = v_item order by g.id desc limit 20) x), '[]'::jsonb));
end $$;

-- ============================================================ 4. 撤销货架动作：没改到数量的另外说
create or replace function public.ops_wh_bin_undo(p_company text, p_ref_id bigint) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  c text;
  n int;
begin
  me := ops.require_level('warehouse', 'edit');
  c := ops.wh_company(me, p_company);
  if not exists (select 1 from ops.wh_bin_log g where g.ref_type = 'bin_op' and g.ref_id = p_ref_id and g.company = c
                   and g.created_by = me.id) then
    raise exception '找不到这个动作（只能撤销自己做的）。' using errcode = 'P0002';
  end if;
  if exists (select 1 from ops.wh_bin_log g where g.ref_type = 'bin_op' and g.ref_id = p_ref_id and g.kind = 'adjust')
     and ops.level_rank(ops.module_level(me, 'warehouse')) < 3 then
    raise exception '改数的撤销要仓库「可审批」。' using errcode = '42501';
  end if;
  n := ops.wh_bin_reverse(me, 'bin_op', p_ref_id, '撤销');
  if n = 0 then
    if not exists (select 1 from ops.wh_bin_log g where g.ref_type = 'bin_op' and g.ref_id = p_ref_id and g.delta <> 0) then
      raise exception '这个动作没有改到数量，不用撤销。' using errcode = '22023';
    end if;
    raise exception '这个动作已经撤销过了。' using errcode = '22023';
  end if;
  return jsonb_build_object('ok', true, 'reversed', n);
end $$;

-- ============================================================ 5. 权限
revoke all on function ops.wh_do_unpicked(text) from public, anon, authenticated;
revoke all on function ops.wh_do_unpicked_for(text, text) from public, anon, authenticated;
revoke all on function ops.wh_do_unpicked_item(text, text, text) from public, anon, authenticated;
revoke all on function public.ops_wh_item_bins(jsonb) from public, anon;
grant execute on function public.ops_wh_item_bins(jsonb) to authenticated;
revoke all on function public.ops_wh_bin_undo(text, bigint) from public, anon;
grant execute on function public.ops_wh_bin_undo(text, bigint) to authenticated;
