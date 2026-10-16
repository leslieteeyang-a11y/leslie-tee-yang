-- 拣货「今天要送」改成「今天 / 明天要送」（使用者 2026-10-16：「DO 通常是明天要送」）。
-- 只改两个函数的日期范围与排序（参数、回传栏位不变；排单多回 tomorrow）：
--   范围 = 昨天或今天开的 DO（昨天开、今天送还没拣的也要看到）+ 今天或明天的排单；排序 = 今天的排单 → 明天的排单 → 其他。
-- 首页「要拣的 DO」与总览都读 ops.wh_pick_summary，一起跟着变。可以重跑（只有 create or replace）。

-- ============================================================
-- 总览 / 首页用：今天 / 明天要送（今天或明天的排单、昨天或今天开的 DO，没取消、还没送达）几张、已拣好几张；拣到一半的几张
create or replace function ops.wh_pick_summary(p_company text) returns jsonb
language sql stable security definer set search_path = '' as $$
  with today_runs as (
    select distinct coalesce(nullif(t.s->>'doc_no', ''), t.s->>'key') doc
    from bi.delivery_run r
    cross join lateral jsonb_array_elements(case when jsonb_typeof(r.stops) = 'array' then r.stops else '[]'::jsonb end) t(s)
    where r.store = (select ops.dlv_store(p_company)) and r.run_date between (select ops.today()) and (select ops.today()) + 1),
  docs as (
    select d.doc_no from bi.delivery_doc d
    where d.company = p_company and not d.cancelled
      and (d.doc_date >= (select ops.today()) - 1 or d.doc_no in (select doc from today_runs))
      and not exists (select 1 from bi.delivery_pod p join bi.delivery_run r2 on r2.id = p.run_id
                      where r2.store = (select ops.dlv_store(p_company)) and p.doc_no = d.doc_no and p.status = 'delivered'))
  select jsonb_build_object(
    'today', (select count(*) from docs),
    'today_done', (select count(*) from docs join ops.wh_pick k on k.company = p_company and k.doc_no = docs.doc_no and k.status = 'done'),
    'picking', (select count(*) from ops.wh_pick k where k.company = p_company and k.status = 'picking'))
$$;

-- ============================================================
-- p: {company, when: today|week|all, status: todo|done|all, q}
--   today = 今天 / 明天要送：今天或明天的排单、昨天或今天开的 DO（DO 通常隔天送，使用者 2026-10-16）；week = 近 7 天开的或近 7 天以后的排单；all = 近 60 天。有打搜寻 = 近 60 天。
--   拣到一半的不管日期都列出来。todo = 还没拣好（已送达的不列）；done = 已拣好。今天要送的排前面。最多 300 张。
create or replace function public.ops_wh_pick_list(p jsonb default '{}'::jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  c text;
  v_q text := upper(trim(coalesce(p->>'q', '')));
  v_when text := coalesce(nullif(p->>'when', ''), 'today');
  v_status text := coalesce(nullif(p->>'status', ''), 'todo');
  v_today date := ops.today();
  v_store text;
  v_from date;
  v_runs jsonb;
begin
  me := ops.require_level('warehouse', 'view');
  c := ops.wh_company(me, p->>'company');
  if v_when not in ('today', 'week', 'all') or v_status not in ('todo', 'done', 'all') then
    raise exception '清单条件不对，请重新整理页面。' using errcode = '22023';
  end if;
  if v_q <> '' then
    v_when := 'all';
  end if;
  v_store := ops.dlv_store(c);
  v_from := case v_when when 'today' then v_today when 'week' then v_today - 6 else v_today - 60 end;
  -- 一张 DO 排过好几次：今天那趟优先、再来明天，不然最近的一趟。先做成 {DO 号: 排单}，下面直接取（不用跟每张 DO 比对）
  select coalesce(jsonb_object_agg(x.doc, jsonb_build_object('run_id', x.run_id, 'run_date', x.run_date,
           'driver_name', x.driver_name, 'seq', x.seq)), '{}'::jsonb)
    into v_runs
  from (select distinct on (x.doc) x.doc, r.id run_id, r.run_date, r.driver_name, t.o::int seq
        from bi.delivery_run r
        cross join lateral jsonb_array_elements(case when jsonb_typeof(r.stops) = 'array' then r.stops else '[]'::jsonb end)
             with ordinality t(s, o)
        cross join lateral (select coalesce(nullif(t.s->>'doc_no', ''), t.s->>'key') doc) x
        where r.store = v_store and r.run_date >= v_today - 60 and x.doc is not null
        order by x.doc, (r.run_date = v_today) desc, (r.run_date = v_today + 1) desc, r.run_date desc, r.id desc) x;
  return jsonb_build_object(
    'company', c, 'when', v_when, 'status', v_status, 'today', v_today,
    'summary', ops.wh_pick_summary(c),
    'synced', (select max(d.synced_at) from bi.delivery_doc d where d.company = c),
    'rows', coalesce((
      with picks as (select k.* from ops.wh_pick k where k.company = c and k.status <> 'cancelled'),
      d0 as (
        select d.doc_no, d.doc_date, d.debtor_name, d.cancelled, d.lines,
               (v_runs->d.doc_no->>'run_id')::bigint run_id, (v_runs->d.doc_no->>'run_date')::date run_date,
               v_runs->d.doc_no->>'driver_name' driver_name, (v_runs->d.doc_no->>'seq')::int seq
        from bi.delivery_doc d where d.company = c),
      docs as (
        select d.doc_no, d.doc_date, d.debtor_name, d.cancelled, d.lines, d.run_id, d.run_date, d.driver_name, d.seq,
               k.id pick_id, k.status pick_status,
               exists (select 1 from bi.delivery_pod pd join bi.delivery_run r2 on r2.id = pd.run_id
                       where r2.store = v_store and pd.doc_no = d.doc_no and pd.status = 'delivered') delivered
        from d0 d
        left join picks k on k.doc_no = d.doc_no
        where (not d.cancelled or k.id is not null)
          and (k.status = 'picking'
               or case v_when when 'today' then d.doc_date >= v_today - 1 or d.run_date between v_today and v_today + 1
                              else d.doc_date >= v_from or d.run_date >= v_from end)
          and (v_q = '' or upper(d.doc_no) like '%' || v_q || '%' or upper(coalesce(d.debtor_name, '')) like '%' || v_q || '%')),
      f as (
        select * from docs x
        where case v_status
                when 'todo' then (x.pick_status is null or x.pick_status = 'picking' or x.cancelled) and not (x.delivered and not x.cancelled)
                when 'done' then x.pick_status = 'done'
                else true end
        order by (x.run_date = v_today) desc nulls last, (x.run_date = v_today + 1) desc nulls last,
                 case when x.run_date between v_today and v_today + 1 then x.run_id end,
                 case when x.run_date between v_today and v_today + 1 then x.seq end, x.doc_date desc, x.doc_no desc
        limit 300)
      select jsonb_agg(jsonb_build_object(
          'doc_no', f.doc_no, 'doc_date', f.doc_date, 'debtor_name', f.debtor_name, 'cancelled', f.cancelled,
          'lines', case when jsonb_typeof(f.lines) = 'array' then jsonb_array_length(f.lines) else 0 end,
          'status', f.pick_status, 'delivered', f.delivered,
          'picked', case when f.pick_id is not null then
                      (select coalesce(sum(least(l.picked, l.qty)), 0) from ops.wh_pick_line l where l.pick_id = f.pick_id and not l.skip)
                    else 0 end,
          'total', case when f.pick_id is not null then
                     (select coalesce(sum(l.qty), 0) from ops.wh_pick_line l where l.pick_id = f.pick_id and not l.skip)
                   else (select coalesce(sum(greatest(ops.wh_pick_num(x->'q'), 0)), 0)
                         from jsonb_array_elements(case when jsonb_typeof(f.lines) = 'array' then f.lines else '[]'::jsonb end) x) end,
          'run', case when f.run_id is not null then jsonb_build_object('run_id', f.run_id, 'run_date', f.run_date,
                   'driver_name', f.driver_name, 'seq', f.seq, 'today', f.run_date = v_today,
                   'tomorrow', f.run_date = v_today + 1) end)
        order by (f.run_date = v_today) desc nulls last, (f.run_date = v_today + 1) desc nulls last,
                 case when f.run_date between v_today and v_today + 1 then f.run_id end,
                 case when f.run_date between v_today and v_today + 1 then f.seq end, f.doc_date desc, f.doc_no desc)
      from f), '[]'::jsonb));
end $$;

