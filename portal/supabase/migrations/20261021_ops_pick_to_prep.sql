-- 「拣货」改名「备货」（使用者 2026-10-17 看了仓库「拣货」分页：「把这个拣货，改成备货」）。
-- 只改员工看得到的字（错误讯息、回传的 message）与函数里的注解：14 个函数照目前正式环境的定义（md5 与本机一致）把「拣」换成「备」。
-- 资料表、栏位、代号（pick、picked、ops_wh_pick_*）都不改，前端呼叫照旧。
-- 只有 create or replace function，可以重跑。

-- ops_dlv_load_scan
CREATE OR REPLACE FUNCTION public.ops_dlv_load_scan(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  me ops.staff;
  r bi.delivery_run;
  v_code text := upper(trim(coalesce(p ->> 'code', '')));
  v_doc text;
  k ops.wh_pick;
  g ops.wh_gate;
begin
  me := ops.require_staff();
  r := ops.dlv_load_run(me, p ->> 'run_id', true);
  if (select l.status from ops.dlv_load l where l.run_id = r.id) = 'departed' then
    raise exception '这趟已经出车了。' using errcode = '22023';
  end if;
  select x.doc_no into v_doc from ops.dlv_load_docs(r) x where upper(x.doc_no) = v_code;
  if v_doc is null then
    return jsonb_build_object('ok', false, 'code', 'not_in_run', 'message', '这趟没有 ' || coalesce(nullif(v_code, ''), '（空白）') || '。');
  end if;
  g := ops.wh_gate_of(ops.dlv_company(r.store));
  select * into k from ops.wh_pick x where x.company = ops.dlv_company(r.store) and x.doc_no = v_doc and x.status <> 'cancelled'
  order by x.id desc limit 1;
  if g.load_check and (k.id is null or k.status <> 'done') then
    return jsonb_build_object('ok', false, 'code', 'not_picked', 'message', v_doc || ' 还没备好，不能装车。');
  end if;
  if g.load_check and not ops.wh_pick_checked(k) then
    return jsonb_build_object('ok', false, 'code', 'not_checked', 'message', v_doc || ' 备好了，还没有人核对，不能装车。');
  end if;
  insert into ops.dlv_load_doc (run_id, doc_no, loaded_by) values (r.id, v_doc, me.id)
  on conflict (run_id, doc_no) do update set voided = false, loaded_by = excluded.loaded_by, loaded_at = now();
  return jsonb_build_object('ok', true, 'doc_no', v_doc, 'short_note', nullif(k.short_note, ''), 'load', ops.dlv_load_json(me, r));
end $function$;

-- ops_wh_claim
CREATE OR REPLACE FUNCTION public.ops_wh_claim(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  me ops.staff;
  v_kind text := p ->> 'kind';
  v_ref bigint := case when (p ->> 'ref') ~ '^[0-9]{1,18}$' then (p ->> 'ref')::bigint end;
  v_rel boolean := coalesce((p ->> 'release')::boolean, false);
  c text;
  k ops.wh_pick;
  cur ops.wh_claim;
begin
  me := ops.require_staff();
  if v_kind = 'receive' then
    select d.company into c from ops.supplier_do d where d.id = v_ref and d.status = 'confirmed';
    if c is null or not ops.podo_can_receive(me, c) then
      raise exception '找不到这张要点货的厂家 DO。' using errcode = 'P0002';
    end if;
  elsif v_kind = 'putaway' then
    perform ops.require_level('warehouse', 'edit');
    select m.company into c from ops.wh_move m where m.id = v_ref and m.kind = 'receive' and m.status <> 'cancelled';
    if c is null or not coalesce(ops.sees_company(me, c), false) then
      raise exception '找不到这笔进货。' using errcode = 'P0002';
    end if;
  elsif v_kind = 'pick_check' then
    perform ops.require_level('warehouse', 'edit');
    select * into k from ops.wh_pick x where x.id = v_ref and x.status = 'done' and x.checked_at is null;
    if k.id is null or not coalesce(ops.sees_company(me, k.company), false) then
      raise exception '找不到这张等核对的备货单。' using errcode = 'P0002';
    end if;
    if not v_rel and ops.wh_pick_touched(k, me.id) then
      raise exception '备货和核对要两个人：你有备这张单，请找另一位同事核对。' using errcode = '42501';
    end if;
    c := k.company;
  else
    raise exception '未知的工作种类。' using errcode = '22023';
  end if;
  select * into cur from ops.wh_claim x where x.kind = v_kind and x.ref = v_ref for update;
  if v_rel then
    if cur.staff_id is not null and cur.staff_id <> me.id and ops.level_rank(ops.module_level(me, 'warehouse')) < 3 then
      raise exception '这是 % 接的，只有接的人自己或仓库「可审批」可以放掉。', (select s.name from ops.staff s where s.id = cur.staff_id)
        using errcode = '42501';
    end if;
    update ops.wh_claim set staff_id = null where kind = v_kind and ref = v_ref;
  else
    if cur.staff_id is not null and cur.staff_id <> me.id then
      raise exception '% 已经接了这一项。', (select s.name from ops.staff s where s.id = cur.staff_id) using errcode = '22023';
    end if;
    insert into ops.wh_claim (kind, ref, company, staff_id, claimed_at) values (v_kind, v_ref, c, me.id, now())
    on conflict (kind, ref) do update set staff_id = excluded.staff_id, claimed_at = excluded.claimed_at;
  end if;
  return coalesce(ops.wh_claim_json(v_kind, v_ref), 'null'::jsonb);
end $function$;

-- ops_wh_count_bins
CREATE OR REPLACE FUNCTION public.ops_wh_count_bins(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  me ops.staff;
  c text;
  loc text := trim(coalesce(p->>'location', ''));
  v_item text;
begin
  me := ops.require_level('warehouse', 'edit');
  c := ops.wh_company(me, p->>'company');
  if not exists (select 1 from ops.wh_location l where l.company = c and l.code = loc) then
    raise exception '没有这个仓位。' using errcode = 'P0002';
  end if;
  v_item := ops.wh_resolve(c, p->>'item');
  if v_item is null then
    raise exception '找不到这个商品，请重新扫或打商品代号。' using errcode = 'P0002';
  end if;
  return jsonb_build_object(
    'item_code', v_item, 'location', loc,
    'description', (select i.description from bi.dim_item i where i.company = c and i.item_code = v_item),
    'uom', (select i.base_uom from bi.dim_item i where i.company = c and i.item_code = v_item),
    'bins', coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'code', b.code)
                        order by b.sort, b.zone, length(b.shelf), b.shelf, length(b.level), b.level)
                      from ops.wh_bin b
                      where b.company = c and b.location = loc
                        and exists (select 1 from ops.wh_bin_stock s where s.bin_id = b.id and s.item_code = v_item
                                      and (b.active or s.qty > 0))), '[]'::jsonb),
    'all_bins', coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'code', x.code) order by x.o) from (
                          select b.id, b.code, row_number() over (order by b.sort, b.zone, length(b.shelf), b.shelf,
                                                                   length(b.level), b.level) o
                          from ops.wh_bin b where b.company = c and b.location = loc and b.active
                          order by o limit 2000) x), '[]'::jsonb),
    -- 已开 DO 还没备的（AutoCount 已经扣了、货还在）：盘点画面提醒
    'do_unpicked', ops.wh_do_unpicked_item(c, v_item, loc),
    'recount', exists (select 1 from ops.wh_count k where k.company = c and k.location = loc and k.item_code = v_item
                         and k.count_date = ops.today() and k.status = 'variance' and k.attempt = 1),
    'sheet', (select jsonb_build_object('id', s.id, 'title', s.title) from ops.wh_count_sheet s
              where s.company = c and s.location = loc and s.status = 'open'
                and exists (select 1 from ops.wh_count_sheet_line l where l.sheet_id = s.id and l.item_code = v_item)
              order by s.created_at desc, s.id desc limit 1));
end $function$;

-- ops_wh_home
CREATE OR REPLACE FUNCTION public.ops_wh_home()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  me ops.staff;
  lvl int;
  sh jsonb;
  cs text[];
begin
  me := ops.require_staff();
  lvl := ops.level_rank(ops.module_level(me, 'warehouse'));
  if lvl < 1 then
    return jsonb_build_object('picks_left', null, 'sheets', '[]'::jsonb, 'bins_over', null);
  end if;
  cs := array(select c from unnest(array['HOMEWORKSSB', 'HOMEWORKSSOUTHERN', 'HOMEWORKSPUCHONG']) c where ops.sees_company(me, c));
  sh := case when lvl >= 2 then public.ops_wh_sheet_home() else '[]'::jsonb end;
  return jsonb_build_object(
    'picks_left', case when lvl >= 2 then (
      select coalesce(sum((x.j->>'today')::int - (x.j->>'today_done')::int), 0)
      from unnest(cs) c, lateral (select ops.wh_pick_summary(c) j offset 0) x) end,
    'sheets', coalesce(sh, '[]'::jsonb),
    'bins_over', case when lvl >= 3 then (
      select coalesce(sum((b->>'items_over')::int), 0)
      from unnest(cs) c, jsonb_array_elements(ops.wh_bin_summary(c)) b) end,
    -- 等我核对：别人备好、还没核对（我没备过）
    'pick_check', case when lvl >= 2 then (
      select count(*) from ops.wh_pick k
      where k.company = any (cs) and k.status = 'done' and k.checked_at is null and k.done_at >= ops.now() - interval '7 days'
        and (ops.wh_gate_of(k.company)).pick_check and not ops.wh_pick_touched(k, me.id)) end,
    'recv_review', case when lvl >= 3 then (
      select count(*) from ops.wh_recv_review r
      where r.company = any (cs) and r.status = 'pending' and (r.counted_by is distinct from me.id or me.role = 'admin')) end,
    'putaway_late', case when lvl >= 2 then (
      select count(*) from unnest(cs) c, ops.wh_put_rows(c) x
      where x.put < x.qty and x.created_at < ops.now() - make_interval(days => (ops.wh_gate_of(c)).putaway_days)) end);
end $function$;

-- ops_wh_overview
CREATE OR REPLACE FUNCTION public.ops_wh_overview(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  me ops.staff;
  c text;
  lvl int;
  cost boolean;
  td date := ops.today();                             -- 只算一次（放在 where 里会每一列都算）
begin
  me := ops.require_level('warehouse', 'view');
  c := ops.wh_company(me, p->>'company');
  lvl := ops.level_rank(ops.module_level(me, 'warehouse'));
  cost := ops.sees_cost(me);
  return jsonb_build_object(
    'company', c, 'synced_at', ops.wh_synced_at(c), 'show_cost', cost, 'today', td,
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
                    where d.company = c and d.status = 'confirmed' and coalesce(s.eta, d.eta) <= td + 3),
    'variances', (select count(*) from ops.wh_count k where k.company = c and k.status = 'variance'
                    and (k.attempt = 2 or k.count_date < td)),
    -- 今天的每日小盘点：盘了几项 / 目标（要盘的仓位每天几件加起来）
    'count_today', jsonb_build_object(
      'counted', (select count(distinct (k.location, k.item_code)) from ops.wh_count k
                  where k.company = c and k.count_date = td and k.status <> 'superseded'),
      'target', (select coalesce(sum(l.daily_target), 0) from ops.wh_location l where l.company = c and l.counting),
      'people', (select count(distinct k.counted_by) from ops.wh_count k where k.company = c and k.count_date = td)),
    -- 货架帐
    'bins', ops.wh_bin_summary(c),
    -- 备货（照 DO）：今天要送几张、已备好几张、备到一半几张
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
end $function$;

-- ops_wh_pick_cancel
CREATE OR REPLACE FUNCTION public.ops_wh_pick_cancel(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  me ops.staff;
  k ops.wh_pick;
  s record;
  n int := 0;
  v_reason text := left(trim(coalesce(p->>'reason', '')), 300);
begin
  me := ops.require_level('warehouse', 'edit');
  select * into k from ops.wh_pick x where x.id = nullif(p->>'pick_id', '')::bigint for update;
  if k.id is null or not coalesce(ops.sees_company(me, k.company), false) then
    raise exception '找不到这张备货单。' using errcode = 'P0002';
  end if;
  if k.status = 'cancelled' then
    raise exception '这张备货单已经取消了。' using errcode = '22023';
  end if;
  if not ops.wh_pick_can_manage(me, k) then
    raise exception '只有开始备货的人或仓库「可审批」可以取消。' using errcode = '42501';
  end if;
  -- 已备好的（货多半已经出门）取消会把货架加回去：只给仓库「可审批」
  if k.status = 'done' and ops.level_rank(ops.module_level(me, 'warehouse')) < 3 then
    raise exception '已备好的备货单只有仓库「可审批」可以取消（取消会把货架上的数量加回去）。' using errcode = '42501';
  end if;
  if v_reason = '' then
    raise exception '取消要写原因（例：DO 取消了、备错要重来）。' using errcode = '22023';
  end if;
  for s in select x.id from ops.wh_pick_scan x where x.pick_id = k.id and not x.voided and x.bin_id is not null order by x.id desc loop
    n := n + ops.wh_bin_reverse(me, 'pick', s.id, '取消备货 ' || k.doc_no);
  end loop;
  update ops.wh_pick set status = 'cancelled', cancelled_by = me.id, cancelled_at = now(), cancel_reason = v_reason
  where id = k.id returning * into k;
  perform ops.log(me.id, 'cancel', 'wh_pick', k.id, jsonb_build_object('doc_no', k.doc_no, 'reason', v_reason, 'reversed', n));
  return jsonb_build_object('ok', true, 'doc_no', k.doc_no, 'reversed', n);
end $function$;

-- ops_wh_pick_check
CREATE OR REPLACE FUNCTION public.ops_wh_pick_check(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  me ops.staff;
  k ops.wh_pick;
  l record;
  v_q numeric;
  v_diffs jsonb := '[]'::jsonb;
  v_map jsonb := '{}'::jsonb;
  e jsonb;
begin
  me := ops.require_level('warehouse', 'edit');
  select * into k from ops.wh_pick x
  where x.id = case when (p ->> 'pick_id') ~ '^[0-9]{1,18}$' then (p ->> 'pick_id')::bigint end for update;
  if k.id is null or not coalesce(ops.sees_company(me, k.company), false) then
    raise exception '找不到这张备货单。' using errcode = 'P0002';
  end if;
  if k.status <> 'done' then
    raise exception '还没按「已备好」的单不能核对。' using errcode = '22023';
  end if;
  if k.checked_at is not null then
    raise exception '这张单已经核对过了（%）。', (select s.name from ops.staff s where s.id = k.checked_by) using errcode = '22023';
  end if;
  if ops.wh_pick_touched(k, me.id) then
    raise exception '备货和核对要两个人：你有备这张单，请找另一位同事核对。' using errcode = '42501';
  end if;
  if jsonb_typeof(p -> 'lines') is distinct from 'array' then
    raise exception '资料格式不对。' using errcode = '22023';
  end if;
  for e in select x from jsonb_array_elements(p -> 'lines') x loop
    if jsonb_typeof(e) is distinct from 'object' or coalesce(e ->> 'line_id', '') !~ '^[0-9]{1,18}$'
       or coalesce(trim(e ->> 'qty'), '') !~ '^[0-9]{1,9}(\.[0-9]{1,3})?$' then
      raise exception '核对数量要是 0 或以上的数字。' using errcode = '22023';
    end if;
    v_map := v_map || jsonb_build_object(e ->> 'line_id', trim(e ->> 'qty')::numeric);
  end loop;
  for l in select * from ops.wh_pick_line x where x.pick_id = k.id and not x.skip order by x.line_no loop
    if not v_map ? l.id::text then
      raise exception '第 % 行（%）还没核对。', l.line_no, l.description using errcode = '22023';
    end if;
    v_q := (v_map ->> l.id::text)::numeric;
    update ops.wh_pick_line set checked = v_q where id = l.id;
    if v_q <> l.picked then
      v_diffs := v_diffs || jsonb_build_array(jsonb_build_object('line_id', l.id, 'line_no', l.line_no, 'description', l.description,
                                                                 'item_code', l.item_code, 'picked', l.picked, 'checked', v_q));
    end if;
  end loop;
  if jsonb_array_length(v_diffs) > 0 then
    update ops.wh_pick set check_fails = check_fails + 1 where id = k.id;
    perform ops.log(me.id, 'check_fail', 'wh_pick', k.id, jsonb_build_object('doc_no', k.doc_no, 'diffs', v_diffs));
    return jsonb_build_object('ok', false, 'diffs', v_diffs, 'pick', public.ops_wh_pick_get(k.company, k.doc_no));
  end if;
  update ops.wh_pick set checked_by = me.id, checked_at = now(), check_note = left(trim(coalesce(p ->> 'note', '')), 300)
  where id = k.id;
  update ops.wh_claim set staff_id = null where kind = 'pick_check' and ref = k.id;
  perform ops.log(me.id, 'check', 'wh_pick', k.id, jsonb_build_object('doc_no', k.doc_no));
  return jsonb_build_object('ok', true, 'pick', public.ops_wh_pick_get(k.company, k.doc_no));
end $function$;

-- ====

-- ops_wh_pick_done
CREATE OR REPLACE FUNCTION public.ops_wh_pick_done(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  me ops.staff;
  k ops.wh_pick;
  n int;
  v_note text := left(trim(coalesce(p->>'short_note', '')), 500);
begin
  me := ops.require_level('warehouse', 'edit');
  select * into k from ops.wh_pick x where x.id = nullif(p->>'pick_id', '')::bigint for update;
  if k.id is null or not coalesce(ops.sees_company(me, k.company), false) then
    raise exception '找不到这张备货单。' using errcode = 'P0002';
  end if;
  if k.status <> 'picking' then
    raise exception '这张备货单已经%了。', case k.status when 'done' then '备好' else '取消' end using errcode = '22023';
  end if;
  select count(*) into n from ops.wh_pick_line l where l.pick_id = k.id and not l.skip and l.picked < l.qty;
  if n > 0 and (not coalesce((p->>'force')::boolean, false) or v_note = '') then
    raise exception '还有 % 行没备够。确定要这样出货，请写缺货备注再按「已备好」。', n using errcode = '22023';
  end if;
  update ops.wh_pick set status = 'done', done_by = me.id, done_at = now(), short_note = case when n > 0 then v_note else '' end
  where id = k.id returning * into k;
  perform ops.log(me.id, 'done', 'wh_pick', k.id, jsonb_build_object('doc_no', k.doc_no, 'short_lines', n, 'note', k.short_note));
  return public.ops_wh_pick_get(k.company, k.doc_no);
end $function$;

-- ops_wh_pick_line_set
CREATE OR REPLACE FUNCTION public.ops_wh_pick_line_set(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  me ops.staff;
  k ops.wh_pick;
  l ops.wh_pick_line;
  b ops.wh_bin;
  s ops.wh_pick_scan;
  v_action text := coalesce(p->>'action', '');
  v_reason text := left(trim(coalesce(p->>'reason', '')), 300);
  v_bin text := nullif(trim(coalesce(p->>'bin', '')), '');
  v_qty numeric;
  v_onbin numeric;
begin
  me := ops.require_level('warehouse', 'edit');
  select * into k from ops.wh_pick x where x.id = nullif(p->>'pick_id', '')::bigint for update;
  if k.id is null or not coalesce(ops.sees_company(me, k.company), false) then
    raise exception '找不到这张备货单。' using errcode = 'P0002';
  end if;
  if k.status <> 'picking' then
    raise exception '这张备货单已经%，不能再改。', case k.status when 'done' then '备好' else '取消' end using errcode = '22023';
  end if;
  select * into l from ops.wh_pick_line x where x.id = nullif(p->>'line_id', '')::bigint and x.pick_id = k.id for update;
  if l.id is null then
    raise exception '找不到这一行，请重新整理页面。' using errcode = 'P0002';
  end if;
  if v_action = 'skip' then
    if v_reason = '' then
      raise exception '略过要写原因（例：运费、不用出货）。' using errcode = '22023';
    end if;
    if l.picked > 0 then
      raise exception '第 % 行已经备了 %，请先撤销那几笔扫码再略过。', l.line_no, ops.wh_pick_q(l.picked) using errcode = '22023';
    end if;
    update ops.wh_pick_line set skip = true, skip_reason = v_reason where id = l.id returning * into l;
  elsif v_action = 'unskip' then
    update ops.wh_pick_line set skip = false, skip_reason = '' where id = l.id returning * into l;
  elsif v_action = 'manual' then
    v_qty := nullif(trim(coalesce(p->>'qty', '')), '')::numeric;
    if l.skip then
      raise exception '第 % 行已经略过，要备请先取消略过。', l.line_no using errcode = '22023';
    end if;
    if v_qty is null or v_qty <= 0 then
      raise exception '请填数量。' using errcode = '22023';
    end if;
    if v_qty > l.qty - l.picked then
      raise exception '第 % 行只差 %，不能确认 %。', l.line_no, ops.wh_pick_q(greatest(l.qty - l.picked, 0)), ops.wh_pick_q(v_qty)
        using errcode = '22023';
    end if;
    if v_reason = '' then
      raise exception '手动确认要写原因（例：没有条码、条码坏了）。' using errcode = '22023';
    end if;
    if v_bin is not null then
      if l.item_code is null then
        raise exception '第 % 行对不到商品，不能从货架扣；请不要选货架，或先扫商品指定。', l.line_no using errcode = '22023';
      end if;
      if ops.wh_pick_uom_diff(l.uom, (select i.base_uom from bi.dim_item i where i.company = k.company and i.item_code = l.item_code)) then
        raise exception '第 % 行 DO 的单位是 %，跟商品的单位不一样，不能照 DO 的数量从货架扣：请不要选货架，再到「货架」用「拿下」扣实际件数。',
          l.line_no, l.uom using errcode = '22023';
      end if;
      b := ops.wh_bin_find(k.company, v_bin, null);
      if not b.active then
        raise exception '货架 % 已经停用，请换一个货架。', b.code using errcode = '22023';
      end if;
      v_onbin := coalesce((select st.qty from ops.wh_bin_stock st where st.bin_id = b.id and st.item_code = l.item_code), 0);
      if v_onbin < v_qty then
        raise exception '货架 % 上的 % 只有 % 件，不够扣 % 件。可以不选货架再确认。', b.code, l.item_code,
          ops.wh_pick_q(v_onbin), ops.wh_pick_q(v_qty) using errcode = '22023';
      end if;
    end if;
    insert into ops.wh_pick_scan (pick_id, line_id, item_code, qty, bin_id, manual, note, created_by)
    values (k.id, l.id, l.item_code, v_qty, b.id, true, v_reason, me.id)
    returning * into s;
    update ops.wh_pick_line set picked = picked + v_qty where id = l.id returning * into l;
    if b.id is not null then
      perform ops.wh_bin_apply(me, b.id, l.item_code, -v_qty, 'pick', 'pick', s.id, k.doc_no || ' 手动');
    end if;
  else
    raise exception '未知的动作：%', v_action using errcode = '22023';
  end if;
  return jsonb_build_object('ok', true, 'line', ops.wh_pick_line_json(l, k.company),
    'scan', case when s.id is not null then ops.wh_pick_scan_json(s) end,
    'pick', ops.wh_pick_json(k),
    'done_all', not exists (select 1 from ops.wh_pick_line x where x.pick_id = k.id and not x.skip and x.picked < x.qty));
end $function$;

-- ops_wh_pick_reopen
CREATE OR REPLACE FUNCTION public.ops_wh_pick_reopen(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  me ops.staff;
  k ops.wh_pick;
begin
  me := ops.require_level('warehouse', 'edit');
  select * into k from ops.wh_pick x where x.id = nullif(p->>'pick_id', '')::bigint for update;
  if k.id is null or not coalesce(ops.sees_company(me, k.company), false) then
    raise exception '找不到这张备货单。' using errcode = 'P0002';
  end if;
  if k.status <> 'done' then
    raise exception '只有已备好的才能重新打开。' using errcode = '22023';
  end if;
  if not ops.wh_pick_can_manage(me, k) then
    raise exception '只有开始备货的人或仓库「可审批」可以重新打开。' using errcode = '42501';
  end if;
  update ops.wh_pick set status = 'picking', done_by = null, done_at = null, checked_by = null, checked_at = null, check_note = ''
  where id = k.id returning * into k;
  update ops.wh_pick_line set checked = null where pick_id = k.id;
  perform ops.log(me.id, 'reopen', 'wh_pick', k.id, jsonb_build_object('doc_no', k.doc_no));
  return public.ops_wh_pick_get(k.company, k.doc_no);
end $function$;

-- ops_wh_pick_scan
CREATE OR REPLACE FUNCTION public.ops_wh_pick_scan(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  me ops.staff;
  k ops.wh_pick;
  l ops.wh_pick_line;
  b ops.wh_bin;
  s ops.wh_pick_scan;
  v_code text := trim(coalesce(p->>'code', ''));
  v_bin text := nullif(trim(coalesce(p->>'bin', '')), '');
  v_line bigint := nullif(p->>'line_id', '')::bigint;
  v_qty numeric := coalesce(nullif(p->>'qty', '')::numeric, 1);
  v_item text;
  v_desc text;
  v_left numeric;
  v_onbin numeric;
begin
  me := ops.require_level('warehouse', 'edit');
  select * into k from ops.wh_pick x where x.id = nullif(p->>'pick_id', '')::bigint for update;
  if k.id is null or not coalesce(ops.sees_company(me, k.company), false) then
    raise exception '找不到这张备货单。' using errcode = 'P0002';
  end if;
  if k.status <> 'picking' then
    raise exception '这张备货单已经%，不能再扫。', case k.status when 'done' then '备好' else '取消' end using errcode = '22023';
  end if;
  if v_qty <= 0 or v_qty > 100000 then
    raise exception '数量不对。' using errcode = '22023';
  end if;
  if v_code = '' then
    raise exception '请扫或打商品代号。' using errcode = '22023';
  end if;
  if upper(v_code) ~ '^BIN:[0-9]+$' then
    return jsonb_build_object('ok', false, 'code', 'is_bin', 'message', '这是货架条码，请在「目前货架」那里扫。');
  end if;
  v_item := ops.wh_resolve(k.company, v_code);
  if v_item is null then
    return jsonb_build_object('ok', false, 'code', 'unknown',
      'message', format('不认识「%s」。请扫商品上的条码或打商品代号；纸箱条码可以到「查货」绑定到商品。', v_code));
  end if;
  v_desc := coalesce((select i.description from bi.dim_item i where i.company = k.company and i.item_code = v_item limit 1), v_item);
  if v_line is not null then
    select * into l from ops.wh_pick_line x where x.id = v_line and x.pick_id = k.id for update;
    if l.id is null then
      raise exception '找不到这一行，请重新整理页面。' using errcode = 'P0002';
    end if;
    if l.skip then
      return jsonb_build_object('ok', false, 'code', 'skipped', 'message', format('第 %s 行已经略过。', l.line_no));
    end if;
    if l.item_code is not null and l.item_code <> v_item then
      return jsonb_build_object('ok', false, 'code', 'wrong', 'item_code', v_item, 'description', v_desc,
        'message', format('扫到的是 %s（%s），不是第 %s 行的 %s。请放回去。', v_item, v_desc, l.line_no, l.item_code));
    end if;
  else
    select * into l from ops.wh_pick_line x
    where x.pick_id = k.id and x.item_code = v_item and not x.skip
    order by (x.picked < x.qty) desc, x.line_no limit 1 for update;
    if l.id is null then
      if exists (select 1 from ops.wh_pick_line x where x.pick_id = k.id and x.item_code = v_item and x.skip) then
        return jsonb_build_object('ok', false, 'code', 'skipped', 'item_code', v_item, 'description', v_desc,
          'message', format('%s 那一行已经略过，不用备。', v_item));
      end if;
      return jsonb_build_object('ok', false, 'code', 'wrong', 'item_code', v_item, 'description', v_desc,
        'message', format('这张 DO 没有 %s（%s）。请放回去。', v_item, v_desc));
    end if;
  end if;
  v_left := l.qty - l.picked;
  if v_qty > v_left then
    return jsonb_build_object('ok', false, 'code', 'over', 'item_code', v_item, 'description', v_desc,
      'line', ops.wh_pick_line_json(l, k.company),
      'message', case when v_left <= 0
                      then format('%s 已经备够了（要 %s）。多拿的请放回去。', v_item, ops.wh_pick_q(l.qty))
                      else format('%s 只差 %s，这次扫了 %s。多拿的请放回去。', v_item, ops.wh_pick_q(v_left), ops.wh_pick_q(v_qty)) end);
  end if;
  if v_bin is not null and ops.wh_pick_uom_diff(l.uom, (select i.base_uom from bi.dim_item i where i.company = k.company and i.item_code = v_item)) then
    return jsonb_build_object('ok', false, 'code', 'uom', 'item_code', v_item,
      'message', format('DO 的单位是 %s，商品的单位是 %s，不能照 DO 的数量从货架扣：请按「不从货架扣」备，再到「货架」用「拿下」扣实际件数。',
                        l.uom, (select i.base_uom from bi.dim_item i where i.company = k.company and i.item_code = v_item)));
  end if;
  if v_bin is not null then
    begin
      b := ops.wh_bin_find(k.company, v_bin, null);
    exception when others then
      return jsonb_build_object('ok', false, 'code', 'bin', 'message', sqlerrm);
    end;
    if not b.active then
      return jsonb_build_object('ok', false, 'code', 'bin', 'message', format('货架 %s 已经停用，请换一个货架。', b.code));
    end if;
    v_onbin := coalesce((select st.qty from ops.wh_bin_stock st where st.bin_id = b.id and st.item_code = v_item), 0);
    if v_onbin < v_qty then
      return jsonb_build_object('ok', false, 'code', 'bin_short', 'item_code', v_item, 'bin', b.location || ' · ' || b.code,
        'bin_qty', v_onbin, 'bins', ops.wh_pick_bins(k.company, v_item),   -- 这个商品在哪些货架有货（画面让人改选）
        'message', format('货架 %s 上的 %s 只有 %s 件，不够扣 %s 件。', b.code, v_item, ops.wh_pick_q(v_onbin), ops.wh_pick_q(v_qty)));
    end if;
  end if;
  if l.item_code is null then
    update ops.wh_pick_line set item_code = v_item, match = 'manual' where id = l.id;
  end if;
  insert into ops.wh_pick_scan (pick_id, line_id, item_code, qty, bin_id, code, created_by)
  values (k.id, l.id, v_item, v_qty, b.id, left(v_code, 100), me.id)
  returning * into s;
  update ops.wh_pick_line set picked = picked + v_qty where id = l.id returning * into l;
  if b.id is not null then
    perform ops.wh_bin_apply(me, b.id, v_item, -v_qty, 'pick', 'pick', s.id, k.doc_no);
  end if;
  return jsonb_build_object('ok', true, 'line', ops.wh_pick_line_json(l, k.company), 'scan', ops.wh_pick_scan_json(s),
    'pick', ops.wh_pick_json(k),
    'done_all', not exists (select 1 from ops.wh_pick_line x where x.pick_id = k.id and not x.skip and x.picked < x.qty));
end $function$;

-- ops_wh_pick_start
CREATE OR REPLACE FUNCTION public.ops_wh_pick_start(p_company text, p_doc_no text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  me ops.staff;
  c text;
  d bi.delivery_doc;
  k ops.wh_pick;
begin
  me := ops.require_level('warehouse', 'edit');
  c := ops.wh_company(me, p_company);
  select * into d from bi.delivery_doc x where x.company = c and upper(x.doc_no) = upper(trim(coalesce(p_doc_no, ''))) limit 1;
  if d.doc_no is null then
    raise exception '找不到 DO %。DO 每 15 分钟从 AutoCount 同步一次，刚开的单请稍后再试。', trim(coalesce(p_doc_no, '')) using errcode = 'P0002';
  end if;
  if d.cancelled then
    raise exception 'DO % 在 AutoCount 已经取消，不用备货。', d.doc_no using errcode = '22023';
  end if;
  if jsonb_typeof(d.lines) is distinct from 'array' or jsonb_array_length(d.lines) = 0 then
    raise exception 'DO % 还没有明细（同步还没抓到），请过 15 分钟再试。', d.doc_no using errcode = '22023';
  end if;
  insert into ops.wh_pick (company, doc_no, do_lines, started_by)
  values (c, d.doc_no, d.lines, me.id)
  on conflict (company, doc_no) where status <> 'cancelled' do nothing
  returning * into k;
  if k.id is not null then
    insert into ops.wh_pick_line (pick_id, line_no, description, uom, qty, item_code, match, skip, skip_reason)
    select k.id, m.line_no, m.description, m.uom, m.qty, m.item_code, m.match, m.qty <= 0,
           case when m.qty <= 0 then '数量 0（说明行）' else '' end
    from ops.wh_pick_match(c, d.lines) m;
    perform ops.log(me.id, 'start', 'wh_pick', k.id, jsonb_build_object('company', c, 'doc_no', d.doc_no));
  end if;
  return public.ops_wh_pick_get(c, d.doc_no);
end $function$;

-- ops_wh_pick_undo
CREATE OR REPLACE FUNCTION public.ops_wh_pick_undo(p_scan_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  me ops.staff;
  s ops.wh_pick_scan;
  k ops.wh_pick;
  l ops.wh_pick_line;
begin
  me := ops.require_level('warehouse', 'edit');
  select * into s from ops.wh_pick_scan x where x.id = p_scan_id;
  select * into k from ops.wh_pick x where x.id = s.pick_id for update;
  if s.id is null or k.id is null or not coalesce(ops.sees_company(me, k.company), false) then
    raise exception '找不到这笔扫码纪录。' using errcode = 'P0002';
  end if;
  if k.status <> 'picking' then
    raise exception '备货单已经%，不能撤销单笔。', case k.status when 'done' then '备好（要改请先「重新打开」）' else '取消' end
      using errcode = '22023';
  end if;
  select * into s from ops.wh_pick_scan x where x.id = p_scan_id for update;
  if s.voided then
    raise exception '这笔已经撤销过了。' using errcode = '22023';
  end if;
  update ops.wh_pick_scan set voided = true, voided_by = me.id, voided_at = now() where id = s.id returning * into s;
  update ops.wh_pick_line set picked = greatest(picked - s.qty, 0) where id = s.line_id returning * into l;
  if l.match = 'manual' and not exists (select 1 from ops.wh_pick_scan x where x.line_id = l.id and not x.voided) then
    update ops.wh_pick_line set item_code = null, match = 'none' where id = l.id returning * into l;
  end if;
  perform ops.wh_bin_reverse(me, 'pick', s.id, '撤销备货 ' || k.doc_no);
  return jsonb_build_object('ok', true, 'line', ops.wh_pick_line_json(l, k.company), 'scan', ops.wh_pick_scan_json(s),
    'pick', ops.wh_pick_json(k));
end $function$;

-- ops_wh_today
CREATE OR REPLACE FUNCTION public.ops_wh_today(p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  me ops.staff;
  c text;
  g ops.wh_gate;
  v_today date := ops.today();
  lvl int;
  sup boolean;
  v_items jsonb := '[]'::jsonb;
  v_pick jsonb;
begin
  me := ops.require_level('warehouse', 'view');
  c := ops.wh_company(me, p ->> 'company');
  g := ops.wh_gate_of(c);
  lvl := ops.level_rank(ops.module_level(me, 'warehouse'));
  sup := ops.sees_supplier(me);

  -- 出车：今天的排单、还没出车
  v_items := v_items || coalesce((
    select jsonb_agg(jsonb_build_object('kind', 'load', 'ref', r.id, 'title', coalesce(r.driver_name, '（没选司机）'),
             'n', (select count(*) from ops.dlv_load_docs(r)),
             'done', (select count(*) from ops.dlv_load_doc d where d.run_id = r.id and not d.voided),
             'due', r.run_date, 'late', false, 'today', true,
             'who', (select s.name from ops.dlv_load l join ops.staff s on s.id = l.started_by where l.run_id = r.id),
             'who_id', (select l.started_by from ops.dlv_load l where l.run_id = r.id),
             'can', ops.dlv_load_can(me, r)))
    from bi.delivery_run r
    where r.store = ops.dlv_store(c) and r.run_date = v_today
      and not exists (select 1 from ops.dlv_load l where l.run_id = r.id and l.status = 'departed')), '[]'::jsonb);

  -- 备货：今天 / 明天要送、还没备好的
  v_pick := public.ops_wh_pick_list(jsonb_build_object('company', c, 'when', 'today', 'status', 'todo'));
  v_items := v_items || coalesce((
    select jsonb_agg(jsonb_build_object('kind', 'pick', 'ref', x ->> 'doc_no', 'title', x ->> 'doc_no', 'sub', x ->> 'debtor_name',
             'n', (x ->> 'total')::numeric, 'done', (x ->> 'picked')::numeric,
             'due', coalesce(x -> 'run' ->> 'run_date', ((x ->> 'doc_date')::date + 1)::text),
             'late', coalesce((x -> 'run' ->> 'run_date')::date < v_today, (x ->> 'doc_date')::date < v_today - 1),
             'today', coalesce((x -> 'run' ->> 'today')::boolean, false),
             'who', (select s.name from ops.wh_pick k join ops.staff s on s.id = k.started_by
                     where k.company = c and k.doc_no = x ->> 'doc_no' and k.status = 'picking'),
             'who_id', (select k.started_by from ops.wh_pick k where k.company = c and k.doc_no = x ->> 'doc_no' and k.status = 'picking'),
             'can', lvl >= 2))
    from jsonb_array_elements(v_pick -> 'rows') x
    where not coalesce((x ->> 'cancelled')::boolean, false)), '[]'::jsonb);

  -- 核对：已备好、还没核对
  if g.pick_check then
    v_items := v_items || coalesce((
      select jsonb_agg(jsonb_build_object('kind', 'pick_check', 'ref', k.id, 'title', k.doc_no,
               'sub', (select st.name from ops.staff st where st.id = k.done_by),
               'due', coalesce(rd.run_date, v_today), 'late', coalesce(rd.run_date < v_today, false),
               'today', coalesce(rd.run_date <= v_today, false) or k.done_at < ops.now() - interval '4 hours',
               'who', (ops.wh_claim_json('pick_check', k.id)) ->> 'name',
               'who_id', ((ops.wh_claim_json('pick_check', k.id)) ->> 'staff_id')::bigint,
               'can', lvl >= 2 and not ops.wh_pick_touched(k, me.id)))
      from ops.wh_pick k
      left join lateral (select min(r.run_date) run_date from bi.delivery_run r,
                           jsonb_array_elements(case when jsonb_typeof(r.stops) = 'array' then r.stops else '[]'::jsonb end) t(s)
                         where r.store = ops.dlv_store(c) and r.run_date >= v_today and t.s ->> 'doc_no' = k.doc_no) rd on true
      where k.company = c and k.status = 'done' and k.checked_at is null and k.done_at >= ops.now() - interval '7 days'), '[]'::jsonb);
  end if;

  -- 点货：已确认、ETA 明天以前（含逾期）还没点
  v_items := v_items || coalesce((
    select jsonb_agg(jsonb_build_object('kind', 'receive', 'ref', d.id,
             'title', case when sup then coalesce(d.supplier_name, '') || ' · ' || coalesce(d.do_no, '') else '厂家到货' end,
             'n', (select count(*) from jsonb_array_elements(d.items) t(e) where coalesce((t.e ->> 'shipped')::numeric, 0) > 0),
             'due', coalesce(s.eta, d.eta), 'late', coalesce(s.eta, d.eta) < v_today, 'today', coalesce(s.eta, d.eta) = v_today,
             'who', (ops.wh_claim_json('receive', d.id)) ->> 'name',
             'who_id', ((ops.wh_claim_json('receive', d.id)) ->> 'staff_id')::bigint,
             'can', ops.podo_can_receive(me, d.company)))
    from ops.supplier_do d left join ops.shipment s on s.id = d.shipment_id
    where d.company = c and d.status = 'confirmed' and coalesce(s.eta, d.eta) <= v_today + 1), '[]'::jsonb);

  -- 点货复核
  v_items := v_items || coalesce((
    select jsonb_agg(jsonb_build_object('kind', 'recv_review', 'ref', r.do_id,
             'title', case when sup then coalesce(d.supplier_name, '') || ' · ' || coalesce(d.do_no, '') else '厂家到货' end,
             'n', jsonb_array_length(r.reasons), 'sub', (select st.name from ops.staff st where st.id = r.counted_by),
             'due', (r.counted_at at time zone 'Asia/Kuala_Lumpur')::date,
             'late', r.counted_at < ops.now() - interval '1 day', 'today', true, 'who', null, 'who_id', null,
             'can', lvl >= 3 and (r.counted_by is distinct from me.id or me.role = 'admin')))
    from ops.wh_recv_review r join ops.supplier_do d on d.id = r.do_id
    where r.company = c and r.status = 'pending'), '[]'::jsonb);

  -- 上架
  v_items := v_items || coalesce((
    select jsonb_agg(jsonb_build_object('kind', 'putaway', 'ref', x.id, 'title', x.item_code,
             'sub', (select i.description from bi.dim_item i where i.company = c and i.item_code = x.item_code),
             'n', x.qty, 'done', x.put, 'location', x.to_loc,
             'due', ((x.created_at at time zone 'Asia/Kuala_Lumpur')::date + g.putaway_days),
             'late', x.created_at < ops.now() - make_interval(days => g.putaway_days),
             'today', x.created_at < ops.now() - make_interval(days => greatest(g.putaway_days - 1, 0)),
             'who', (ops.wh_claim_json('putaway', x.id)) ->> 'name',
             'who_id', ((ops.wh_claim_json('putaway', x.id)) ->> 'staff_id')::bigint,
             'can', lvl >= 2))
    from ops.wh_put_rows(c) x where x.put < x.qty), '[]'::jsonb);

  return jsonb_build_object('company', c, 'today', v_today, 'me_id', me.id, 'gate', to_jsonb(g),
    'items', coalesce((select jsonb_agg(i order by (i ->> 'late')::boolean desc, (i ->> 'today')::boolean desc,
                                        array_position(array['load', 'pick', 'pick_check', 'receive', 'recv_review', 'putaway'], i ->> 'kind'),
                                        i ->> 'due', i ->> 'title')
                       from jsonb_array_elements(v_items) i), '[]'::jsonb));
end $function$;

-- 模块说明（「规划中」页面会显示）
update ops.module set description = replace(description, '拣', '备') where key = 'warehouse';
