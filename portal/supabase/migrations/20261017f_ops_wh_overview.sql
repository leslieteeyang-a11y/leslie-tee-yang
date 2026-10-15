-- HomeWorks 营运系统 — 仓库「总览」分页（2026-10-15，使用者看了员工 WMS 的仪表盘后说要）
-- 一页看完：负库存几项、各仓位有几种货、还没输入 AutoCount 的搬动、待开进货单、快到 / 待点的厂家货、今天盘点进度、差异待审、
-- 货架帐（几个货架、已上架、对不上、未上架）、今天要拣的 DO、开着的盘点单、最近的动态。
-- 只读；金额（库存成本）只给仓库「可审批」。要在 20261017_ops_wh_bins.sql、20261017b（拣货）、20261017c（盘点单）之后套。
-- 另外 ops_wh_home()：首页的仓库提醒（今天还没拣好的 DO、指派给我的盘点单、货架对不上）。

-- ============================================================ 总览
-- p: {company}
create or replace function public.ops_wh_overview(p jsonb default '{}'::jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  c text;
  lvl int;
  cost boolean;
begin
  me := ops.require_level('warehouse', 'view');
  c := ops.wh_company(me, p->>'company');
  lvl := ops.level_rank(ops.module_level(me, 'warehouse'));
  cost := lvl >= 3;
  return jsonb_build_object(
    'company', c, 'synced_at', ops.wh_synced_at(c), 'show_cost', cost, 'today', ops.today(),
    -- AutoCount 库存：负数的 商品×仓位、各仓位几种货 / 几件 / 成本
    'neg_rows', (select count(*) from bi.fact_stock f where f.company = c and f.qty < 0),
    'locations', coalesce((
      select jsonb_agg(jsonb_build_object('location', x.location, 'items', x.items, 'qty', x.qty,
          'value', case when cost then x.value end, 'neg', x.neg) order by coalesce(wl.sort, 50), x.location)
      from (select f.location, count(*) filter (where f.qty > 0) items, sum(greatest(f.qty, 0)) qty,
                   round(sum(greatest(coalesce(f.total_cost, 0), 0)), 2) value, count(*) filter (where f.qty < 0) neg
            from bi.fact_stock f where f.company = c and f.location is not null group by f.location) x
      left join ops.wh_location wl on wl.company = c and wl.code = x.location
      where x.items > 0 or x.neg > 0), '[]'::jsonb),
    -- 清单
    'moves_pending', (select count(*) from ops.wh_move m where m.company = c and m.status = 'pending' and m.kind <> 'receive'),
    'grn_pending', (select count(*) from ops.wh_move m where m.company = c and m.status = 'pending' and m.kind = 'receive'),
    'grn_pending_do', (select count(distinct m.do_id) from ops.wh_move m where m.company = c and m.status = 'pending' and m.kind = 'receive'),
    'do_to_count', (select count(*) from ops.supplier_do d
                    left join ops.shipment s on s.id = d.shipment_id and s.status <> 'cancelled'
                    where d.company = c and d.status = 'confirmed' and coalesce(s.eta, d.eta) <= ops.today() + 3),
    'variances', (select count(*) from ops.wh_count k where k.company = c and k.status = 'variance'
                    and (k.attempt = 2 or k.count_date < ops.today())),
    -- 今天的每日小盘点：盘了几项 / 目标（要盘的仓位每天几件加起来）
    'count_today', jsonb_build_object(
      'counted', (select count(distinct (k.location, k.item_code)) from ops.wh_count k
                  where k.company = c and k.count_date = ops.today() and k.status <> 'superseded'),
      'target', (select coalesce(sum(l.daily_target), 0) from ops.wh_location l where l.company = c and l.counting),
      'people', (select count(distinct k.counted_by) from ops.wh_count k where k.company = c and k.count_date = ops.today())),
    -- 货架帐
    'bins', ops.wh_bin_summary(c),
    -- 拣货（照 DO）：今天要送几张、已拣好几张、拣到一半几张
    'picks', ops.wh_pick_summary(c),
    -- 开着的盘点单（最多 10 张，期限早的在前）
    'sheets', coalesce((
      select jsonb_agg(ops.wh_sheet_json(s, me) order by s.due_date nulls last, s.id)
      from (select * from ops.wh_count_sheet x where x.company = c and x.status = 'open'
            order by x.due_date nulls last, x.id limit 10) s), '[]'::jsonb),
    -- 最近的动态（搬动、货架、盘点；各取最近 15 笔再合起来取 15 笔）
    'recent', coalesce((
      select jsonb_agg(e.j order by e.at desc) from (
        select * from (
          select m.created_at at, jsonb_build_object('type', 'move', 'at', m.created_at, 'kind', m.kind, 'item_code', m.item_code,
                   'qty', m.qty, 'from_loc', m.from_loc, 'to_loc', m.to_loc, 'status', m.status,
                   'by_name', (select s.name from ops.staff s where s.id = m.created_by)) j
          from ops.wh_move m where m.company = c order by m.created_at desc limit 15) a
        union all
        select * from (
          select g.created_at, jsonb_build_object('type', 'bin', 'at', g.created_at, 'kind', g.kind, 'item_code', g.item_code,
                   'qty', g.delta, 'bin', b.location || ' · ' || b.code,
                   'by_name', (select s.name from ops.staff s where s.id = g.created_by))
          from ops.wh_bin_log g join ops.wh_bin b on b.id = g.bin_id
          where g.company = c and g.kind <> 'import' order by g.created_at desc limit 15) b
        union all
        select * from (
          select k.counted_at, jsonb_build_object('type', 'count', 'at', k.counted_at, 'kind', k.status, 'item_code', k.item_code,
                   'location', k.location, 'by_name', (select s.name from ops.staff s where s.id = k.counted_by))
          from ops.wh_count k where k.company = c order by k.counted_at desc limit 15) k
        order by 1 desc limit 15) e), '[]'::jsonb)
    -- 品名一起给（画面显示用）
    ) || jsonb_build_object('names', coalesce((
      select jsonb_object_agg(i.item_code, i.description) from bi.dim_item i
      where i.company = c and i.item_code in (
        (select m.item_code from ops.wh_move m where m.company = c order by m.created_at desc limit 15)
        union (select g.item_code from ops.wh_bin_log g where g.company = c and g.kind <> 'import' order by g.created_at desc limit 15)
        union (select k.item_code from ops.wh_count k where k.company = c order by k.counted_at desc limit 15))), '{}'::jsonb));
end $$;

-- ============================================================ 首页的仓库提醒
-- picks_left：仓库可编辑以上，看得到的分店今天要送、还没拣好的 DO 张数；sheets：指派给我、还开着的盘点单（ops_wh_sheet_home）；
-- bins_over：仓库可审批，货架比系统多的商品数。没有仓库权限 = 都是 null。
create or replace function public.ops_wh_home() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  lvl int;
  sh jsonb;
begin
  me := ops.require_staff();
  lvl := ops.level_rank(ops.module_level(me, 'warehouse'));
  if lvl < 1 then
    return jsonb_build_object('picks_left', null, 'sheets', '[]'::jsonb, 'bins_over', null);
  end if;
  sh := case when lvl >= 2 then public.ops_wh_sheet_home() else '[]'::jsonb end;
  return jsonb_build_object(
    'picks_left', case when lvl >= 2 then (
      select coalesce(sum((ops.wh_pick_summary(c)->>'today')::int - (ops.wh_pick_summary(c)->>'today_done')::int), 0)
      from unnest(array['HOMEWORKSSB', 'HOMEWORKSSOUTHERN']) c where ops.sees_company(me, c)) end,
    'sheets', coalesce(sh, '[]'::jsonb),
    'bins_over', case when lvl >= 3 then (
      select coalesce(sum((b->>'items_over')::int), 0)
      from unnest(array['HOMEWORKSSB', 'HOMEWORKSSOUTHERN']) c, jsonb_array_elements(ops.wh_bin_summary(c)) b
      where ops.sees_company(me, c)) end);
end $$;

-- ============================================================ 权限
revoke all on function public.ops_wh_home() from public, anon;
grant execute on function public.ops_wh_home() to authenticated;
revoke all on function public.ops_wh_overview(jsonb) from public, anon;
grant execute on function public.ops_wh_overview(jsonb) to authenticated;
