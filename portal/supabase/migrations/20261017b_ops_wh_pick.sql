-- HomeWorks 营运系统 — 仓库：照 DO 拣货 + 扫码核对（使用者 2026-10-15 看了员工做的 WMS 后选「拣货 + 扫码核对」）
-- DO 由 SERVER 的 quote_push.py 每 15 分钟从 AutoCount 只读推进 bi.delivery_doc（lines = [{"d":品名,"q":数量,"u":单位}]，
-- 没有商品代号）。这里只记营运系统自己的东西：哪张 DO 谁在拣、每行拣了几件、每次扫码从哪个货架拿（对 AutoCount 仍然只读）。
--   · 每行配对商品：l->>'c'（以后同步程式加了商品代号就用它）> 品名唯一相同（去头尾空白、连续空白当一个、不分大小写；
--     正式资料近 60 天 96% 刚好对到一个商品）> 对不到（运费、手打的字）。对不到的行可以「扫商品指定」「手动确认」或「略过」。
--   · 开始拣货时把 DO 明细存一份快照（ops.wh_pick_line）；之后 AutoCount 改了 DO，画面会提醒。
--   · 扫码：扫对 → 记一笔 ops.wh_pick_scan；有选「目前货架」就从那个货架扣（ops.wh_bin_apply kind = pick，ref = 这笔扫码）。
--     扫错 / 扫太多 / 货架不够 **不报错**，回传 {ok:false, code, message} 让画面红闪 + 震动（什么都不存）。
--   · 撤销一笔扫码 = 作废 + 货架加回去；取消整张拣货单 = 全部货架加回去。
--   · 拣好的货放在出货区：货架合计少了、AutoCount 还没出 → 「未上架」多了；开 DO 过账后 AutoCount 库存减少就对上。
-- 权限：仓库「只看」= 看清单与进度；「可编辑」= 开始、扫码、撤销、手动确认 / 略过、已拣好；
--       取消 / 重新打开 = 开始拣货的人或仓库「可审批」。排单的人（送货「只看」以上）可以叫 ops_wh_pick_status 看「已拣好」。
-- 可以重复套用（create … if not exists / create or replace）。正式环境照「-- ====」分段套用。

-- ============================================================ 1. 资料表
create table if not exists ops.wh_pick (
  id bigint generated always as identity primary key,
  company text not null check (company in ('HOMEWORKSSB', 'HOMEWORKSSOUTHERN')),
  doc_no text not null,
  status text not null default 'picking' check (status in ('picking', 'done', 'cancelled')),
  short_note text not null default '' check (length(short_note) <= 500),   -- 没拣够就完成时的缺货备注
  do_lines jsonb,                                                          -- 开始时的 DO 明细（之后 AutoCount 改了 DO 才看得出来）
  started_by bigint not null references ops.staff(id),
  started_at timestamptz not null default now(),
  done_by bigint references ops.staff(id),
  done_at timestamptz,
  cancelled_by bigint references ops.staff(id),
  cancelled_at timestamptz,
  cancel_reason text not null default '' check (length(cancel_reason) <= 300)
);
-- 同一张 DO 只能有一张没取消的拣货单
create unique index if not exists wh_pick_open_uq on ops.wh_pick (company, doc_no) where status <> 'cancelled';
create index if not exists wh_pick_status_idx on ops.wh_pick (company, status);

create table if not exists ops.wh_pick_line (
  id bigint generated always as identity primary key,
  pick_id bigint not null references ops.wh_pick(id),
  line_no int not null,                                  -- DO 明细的第几行（从 1 开始）
  description text not null default '',
  uom text,
  qty numeric(12,2) not null check (qty >= 0),           -- 应拣
  item_code text,                                        -- 配对到的商品（对不到 = null）
  match text not null check (match in ('code', 'desc', 'manual', 'none')),   -- manual = 拣货时扫商品指定
  picked numeric(12,2) not null default 0 check (picked >= 0),               -- 已拣（没作废的扫码合计）
  skip boolean not null default false,                   -- 略过（运费、说明行）
  skip_reason text not null default '' check (length(skip_reason) <= 300),
  unique (pick_id, line_no)
);

create table if not exists ops.wh_pick_scan (
  id bigint generated always as identity primary key,
  pick_id bigint not null references ops.wh_pick(id),
  line_id bigint not null references ops.wh_pick_line(id),
  item_code text,
  qty numeric(12,2) not null check (qty > 0),
  bin_id bigint references ops.wh_bin(id),               -- 从哪个货架拿（没选 = 不从货架扣）
  manual boolean not null default false,                 -- 手动确认（没有条码）
  code text not null default '',                         -- 扫到 / 打的码
  note text not null default '' check (length(note) <= 300),
  created_by bigint not null references ops.staff(id),
  created_at timestamptz not null default now(),
  voided boolean not null default false,                 -- 撤销
  voided_by bigint references ops.staff(id),
  voided_at timestamptz
);
create index if not exists wh_pick_scan_pick_idx on ops.wh_pick_scan (pick_id, id desc);
create index if not exists wh_pick_scan_line_idx on ops.wh_pick_scan (line_id);

alter table ops.wh_pick enable row level security;
alter table ops.wh_pick_line enable row level security;
alter table ops.wh_pick_scan enable row level security;

-- ============================================================ 2. 小工具
-- DO 明细的数量：可能是数字或文字；看不懂当 0
create or replace function ops.wh_pick_num(p jsonb) returns numeric
language sql immutable set search_path = '' as $$
  select case when jsonb_typeof(p) = 'number' then (p #>> '{}')::numeric
              when jsonb_typeof(p) = 'string' and trim(p #>> '{}') ~ '^-?[0-9]+(\.[0-9]+)?$' then trim(p #>> '{}')::numeric
              else 0 end
$$;

-- 品名比对用：去头尾空白、连续空白当一个、不分大小写
create or replace function ops.wh_pick_norm(p text) returns text
language sql immutable set search_path = '' as $$
  select nullif(upper(regexp_replace(trim(coalesce(p, '')), '\s+', ' ', 'g')), '')
$$;

-- 数字转文字（2.50 → 2.5、3.00 → 3），错误讯息用
create or replace function ops.wh_pick_q(p numeric) returns text
language sql immutable set search_path = '' as $$
  select coalesce(trim_scale(p)::text, '0')
$$;

-- DO 明细每一行配对商品：c（商品代号）> 品名唯一相同 > 对不到
create or replace function ops.wh_pick_match(p_company text, p_lines jsonb)
returns table (line_no int, description text, uom text, qty numeric, item_code text, match text)
language sql stable security definer set search_path = '' as $$
  with l as (
    select t.o::int line_no, t.l
    from jsonb_array_elements(case when jsonb_typeof(p_lines) = 'array' then p_lines else '[]'::jsonb end) with ordinality t(l, o)),
  dn as (   -- 这间公司每个品名对到几个商品（只看 DO 上出现的品名）
    select ops.wh_pick_norm(i.description) nd, min(i.item_code) item_code, count(distinct i.item_code) n
    from bi.dim_item i
    where i.company = p_company
      and ops.wh_pick_norm(i.description) in (select ops.wh_pick_norm(l.l->>'d') from l)
    group by 1)
  select l.line_no, coalesce(l.l->>'d', ''), nullif(trim(coalesce(l.l->>'u', '')), ''),
         greatest(ops.wh_pick_num(l.l->'q'), 0),
         coalesce(c.item_code, case when dn.n = 1 then dn.item_code end),
         case when c.item_code is not null then 'code' when dn.n = 1 then 'desc' else 'none' end
  from l
  left join lateral (
    select i.item_code from bi.dim_item i
    where i.company = p_company and nullif(trim(coalesce(l.l->>'c', '')), '') is not null
      and upper(i.item_code) = upper(trim(l.l->>'c'))
    limit 1) c on true
  left join dn on dn.nd = ops.wh_pick_norm(l.l->>'d')
  order by l.line_no
$$;

-- 一个商品有货的货架（多的在前，最多 6 个），给「建议货架」
create or replace function ops.wh_pick_bins(p_company text, p_item text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'location', x.location, 'code', x.code,
                                               'barcode', 'BIN:' || x.id, 'qty', x.qty)
                            order by x.qty desc, x.location, x.code), '[]'::jsonb)
  from (select b.id, b.location, b.code, s.qty
        from ops.wh_bin_stock s join ops.wh_bin b on b.id = s.bin_id
        where s.company = p_company and s.item_code = p_item and s.qty > 0 and b.active
        order by s.qty desc, b.location, b.code limit 6) x
$$;

-- 一行 → 前端要的 json（预览时还没有 id）
create or replace function ops.wh_pick_line_obj(p_company text, p_id bigint, p_line_no int, p_desc text, p_uom text,
  p_qty numeric, p_item text, p_match text, p_picked numeric, p_skip boolean, p_skip_reason text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', p_id, 'line_no', p_line_no, 'description', p_desc, 'uom', p_uom, 'qty', p_qty,
    'item_code', p_item,
    'item_desc', (select i.description from bi.dim_item i where i.company = p_company and i.item_code = p_item limit 1),
    -- 商品的基本单位：DO 用别的单位（例：CTN）时画面提醒，货架帐是照基本单位记的
    'base_uom', (select i.base_uom from bi.dim_item i where i.company = p_company and i.item_code = p_item limit 1),
    'match', p_match, 'picked', p_picked, 'skip', p_skip, 'skip_reason', p_skip_reason,
    'done', coalesce(p_skip or p_picked >= p_qty, false),
    'bins', case when p_item is not null then ops.wh_pick_bins(p_company, p_item) else '[]'::jsonb end)
$$;

create or replace function ops.wh_pick_line_json(l ops.wh_pick_line, p_company text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select ops.wh_pick_line_obj(p_company, l.id, l.line_no, l.description, l.uom, l.qty, l.item_code, l.match,
                              l.picked, l.skip, l.skip_reason)
$$;

create or replace function ops.wh_pick_scan_json(s ops.wh_pick_scan) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', s.id, 'line_id', s.line_id, 'line_no', (select l.line_no from ops.wh_pick_line l where l.id = s.line_id),
    'item_code', s.item_code, 'qty', s.qty, 'bin_id', s.bin_id,
    'bin', (select b.location || ' · ' || b.code from ops.wh_bin b where b.id = s.bin_id),
    'manual', s.manual, 'code', s.code, 'note', s.note, 'created_at', s.created_at,
    'by_name', (select st.name from ops.staff st where st.id = s.created_by),
    'voided', s.voided, 'voided_at', s.voided_at,
    'voided_by_name', (select st.name from ops.staff st where st.id = s.voided_by))
$$;

create or replace function ops.wh_pick_json(k ops.wh_pick) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', k.id, 'company', k.company, 'doc_no', k.doc_no, 'status', k.status, 'short_note', k.short_note,
    'started_by', k.started_by, 'started_at', k.started_at,
    'started_by_name', (select st.name from ops.staff st where st.id = k.started_by),
    'done_at', k.done_at, 'done_by_name', (select st.name from ops.staff st where st.id = k.done_by),
    'cancelled_at', k.cancelled_at, 'cancel_reason', k.cancel_reason,
    'cancelled_by_name', (select st.name from ops.staff st where st.id = k.cancelled_by),
    'picked', (select coalesce(sum(least(l.picked, l.qty)), 0) from ops.wh_pick_line l where l.pick_id = k.id and not l.skip),
    'total', (select coalesce(sum(l.qty), 0) from ops.wh_pick_line l where l.pick_id = k.id and not l.skip),
    'lines_left', (select count(*) from ops.wh_pick_line l where l.pick_id = k.id and not l.skip and l.picked < l.qty))
$$;

-- 这张 DO 排在哪几趟（最近的在前，最多 5 趟）
create or replace function ops.wh_pick_runs(p_company text, p_doc_no text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(x.j order by x.run_date desc, x.id desc), '[]'::jsonb)
  from (
    select r.id, r.run_date, jsonb_build_object('run_id', r.id, 'run_date', r.run_date, 'driver_name', r.driver_name, 'seq', t.o,
             'delivered', exists (select 1 from bi.delivery_pod d where d.run_id = r.id and d.stop_key = t.s->>'key'
                                    and d.status = 'delivered')) j
    from bi.delivery_run r
    cross join lateral jsonb_array_elements(case when jsonb_typeof(r.stops) = 'array' then r.stops else '[]'::jsonb end)
         with ordinality t(s, o)
    where r.store = ops.dlv_store(p_company) and coalesce(nullif(t.s->>'doc_no', ''), t.s->>'key') = p_doc_no
    order by r.run_date desc, r.id desc limit 5) x
$$;

-- DO 的单位跟商品的基本单位不一样（例 CTN vs PCS；SET / SETS 这种写法不同不算）→ 不能照 DO 的数量从货架扣
create or replace function ops.wh_pick_uom_diff(p_do_uom text, p_base_uom text) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(nullif(trim(p_do_uom), '') is not null and nullif(trim(p_base_uom), '') is not null
                  and regexp_replace(upper(trim(p_do_uom)), 'S$', '') <> regexp_replace(upper(trim(p_base_uom)), 'S$', ''), false)
$$;

-- 总览 / 首页用：今天要送（今天的排单或今天开的 DO，没取消、还没送达）几张、已拣好几张；拣到一半的几张
create or replace function ops.wh_pick_summary(p_company text) returns jsonb
language sql stable security definer set search_path = '' as $$
  with today_runs as (
    select distinct coalesce(nullif(t.s->>'doc_no', ''), t.s->>'key') doc
    from bi.delivery_run r
    cross join lateral jsonb_array_elements(case when jsonb_typeof(r.stops) = 'array' then r.stops else '[]'::jsonb end) t(s)
    where r.store = (select ops.dlv_store(p_company)) and r.run_date = (select ops.today())),
  docs as (
    select d.doc_no from bi.delivery_doc d
    where d.company = p_company and not d.cancelled
      and (d.doc_date = (select ops.today()) or d.doc_no in (select doc from today_runs))
      and not exists (select 1 from bi.delivery_pod p join bi.delivery_run r2 on r2.id = p.run_id
                      where r2.store = (select ops.dlv_store(p_company)) and p.doc_no = d.doc_no and p.status = 'delivered'))
  select jsonb_build_object(
    'today', (select count(*) from docs),
    'today_done', (select count(*) from docs join ops.wh_pick k on k.company = p_company and k.doc_no = docs.doc_no and k.status = 'done'),
    'picking', (select count(*) from ops.wh_pick k where k.company = p_company and k.status = 'picking'))
$$;

-- 已开 DO、还没拣的数量（每个商品）。AutoCount 开 DO 当下就扣库存，可是货还在货架上：货架帐的「应有」要加回去，
-- 不然每一张还没拣的 DO 都会被列成「货架比系统多」。范围：近 7 天开的、没取消、还没拣好、还没送达的 DO。
-- 已开始拣的：照拣货单的行，扣掉已经从货架扣的；还没开始的：照 DO 明细配对商品（跟拣货同一套配对）。
-- DO 的单位不一定是基本单位，这里照 DO 的数量算（没有换算率）。
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
    select ops.wh_pick_norm(x->>'d') nd, nullif(trim(coalesce(x->>'c', '')), '') c, greatest(ops.wh_pick_num(x->'q'), 0) q
    from docs
    cross join lateral jsonb_array_elements(case when jsonb_typeof(docs.lines) = 'array' then docs.lines else '[]'::jsonb end) x
    where not exists (select 1 from ops.wh_pick k where k.company = p_company and k.doc_no = docs.doc_no and k.status = 'picking')),
  dn as (
    select ops.wh_pick_norm(i.description) nd, min(i.item_code) item_code, count(distinct i.item_code) n
    from bi.dim_item i
    where i.company = p_company and ops.wh_pick_norm(i.description) in (select r.nd from raw r)
    group by 1),
  notstarted as (
    select coalesce((select i.item_code from bi.dim_item i where i.company = p_company and r.c is not null
                       and upper(i.item_code) = upper(r.c) limit 1),
                    case when dn.n = 1 then dn.item_code end) item_code, r.q
    from raw r left join dn on dn.nd = r.nd)
  select z.item_code, sum(z.q) from (select item_code, q from started union all select item_code, q from notstarted) z
  where z.item_code is not null
  group by z.item_code having sum(z.q) > 0
$$;

-- ============================================================ 3. 清单 / 一张 DO / 状态
-- p: {company, when: today|week|all, status: todo|done|all, q}
--   today = 今天的排单或今天开的 DO；week = 近 7 天开的或近 7 天以后的排单；all = 近 60 天。有打搜寻 = 近 60 天。
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
  -- 一张 DO 排过好几次：今天那趟优先，不然最近的一趟。先做成 {DO 号: 排单}，下面直接取（不用跟每张 DO 比对）
  select coalesce(jsonb_object_agg(x.doc, jsonb_build_object('run_id', x.run_id, 'run_date', x.run_date,
           'driver_name', x.driver_name, 'seq', x.seq)), '{}'::jsonb)
    into v_runs
  from (select distinct on (x.doc) x.doc, r.id run_id, r.run_date, r.driver_name, t.o::int seq
        from bi.delivery_run r
        cross join lateral jsonb_array_elements(case when jsonb_typeof(r.stops) = 'array' then r.stops else '[]'::jsonb end)
             with ordinality t(s, o)
        cross join lateral (select coalesce(nullif(t.s->>'doc_no', ''), t.s->>'key') doc) x
        where r.store = v_store and r.run_date >= v_today - 60 and x.doc is not null
        order by x.doc, (r.run_date = v_today) desc, r.run_date desc, r.id desc) x;
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
               or case v_when when 'today' then d.doc_date = v_today or d.run_date = v_today
                              else d.doc_date >= v_from or d.run_date >= v_from end)
          and (v_q = '' or upper(d.doc_no) like '%' || v_q || '%' or upper(coalesce(d.debtor_name, '')) like '%' || v_q || '%')),
      f as (
        select * from docs x
        where case v_status
                when 'todo' then (x.pick_status is null or x.pick_status = 'picking' or x.cancelled) and not (x.delivered and not x.cancelled)
                when 'done' then x.pick_status = 'done'
                else true end
        order by (x.run_date = v_today) desc nulls last, case when x.run_date = v_today then x.run_id end,
                 case when x.run_date = v_today then x.seq end, x.doc_date desc, x.doc_no desc
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
                   'driver_name', f.driver_name, 'seq', f.seq, 'today', f.run_date = v_today) end)
        order by (f.run_date = v_today) desc nulls last, case when f.run_date = v_today then f.run_id end,
                 case when f.run_date = v_today then f.seq end, f.doc_date desc, f.doc_no desc)
      from f), '[]'::jsonb));
end $$;

-- 一张 DO：明细（还没开始 = 现在配对的预览；开始后 = 快照与进度）、建议货架、扫码纪录、排单
create or replace function public.ops_wh_pick_get(p_company text, p_doc_no text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  c text;
  d bi.delivery_doc;
  k ops.wh_pick;
  v_doc text := upper(trim(coalesce(p_doc_no, '')));
  v_lines jsonb;
  lvl int;
begin
  me := ops.require_level('warehouse', 'view');
  c := ops.wh_company(me, p_company);
  if v_doc = '' then
    raise exception '请输入 DO 单号。' using errcode = '22023';
  end if;
  select * into d from bi.delivery_doc x where x.company = c and upper(x.doc_no) = v_doc limit 1;
  select * into k from ops.wh_pick x where x.company = c and upper(x.doc_no) = v_doc and x.status <> 'cancelled';
  if d.doc_no is null and k.id is null then
    raise exception '找不到 DO %。DO 每 15 分钟从 AutoCount 同步一次，刚开的单请稍后再查。', trim(p_doc_no) using errcode = 'P0002';
  end if;
  lvl := ops.level_rank(ops.module_level(me, 'warehouse'));
  if k.id is not null then
    select jsonb_agg(ops.wh_pick_line_json(l, c) order by l.line_no) into v_lines from ops.wh_pick_line l where l.pick_id = k.id;
  else
    select jsonb_agg(ops.wh_pick_line_obj(c, null, m.line_no, m.description, m.uom, m.qty, m.item_code, m.match, 0,
                                          m.qty <= 0, case when m.qty <= 0 then '数量 0（说明行）' else '' end)
                     order by m.line_no)
      into v_lines from ops.wh_pick_match(c, d.lines) m;
  end if;
  return jsonb_build_object(
    'company', c, 'doc_no', coalesce(d.doc_no, k.doc_no), 'doc_date', d.doc_date, 'debtor_name', d.debtor_name,
    'cancelled', coalesce(d.cancelled, false), 'missing', d.doc_no is null, 'do_remark', d.do_remark,
    'has_lines', coalesce(jsonb_typeof(d.lines) = 'array' and jsonb_array_length(d.lines) > 0, false),
    'synced_at', d.synced_at,
    'runs', ops.wh_pick_runs(c, coalesce(d.doc_no, k.doc_no)),
    'pick', case when k.id is not null then ops.wh_pick_json(k) end,
    'lines', coalesce(v_lines, '[]'::jsonb),
    'scans', coalesce((select jsonb_agg(ops.wh_pick_scan_json(s) order by s.id desc)
                       from (select * from ops.wh_pick_scan s where s.pick_id = k.id order by s.id desc limit 200) s), '[]'::jsonb),
    'do_changed', coalesce(k.id is not null and d.doc_no is not null and k.do_lines is distinct from d.lines, false),
    'cancelled_picks', (select count(*) from ops.wh_pick x where x.company = c and upper(x.doc_no) = v_doc and x.status = 'cancelled'),
    'can_edit', lvl >= 2,
    'can_cancel', coalesce(k.id is not null and (lvl >= 3 or (lvl >= 2 and k.started_by = me.id)), false));
end $$;

-- 排单画面用：这些 DO 拣好了没。仓库「只看」或送货「只看」以上都可以叫。回传 {DO 号: {status, picked, total, done_at}}
create or replace function public.ops_wh_pick_status(p_company text, p_doc_nos text[]) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  c text;
begin
  me := ops.require_staff();
  if not coalesce(ops.level_rank(ops.module_level(me, 'warehouse')) >= 1
                  or ops.level_rank(ops.module_level(me, 'delivery')) >= 1, false) then
    raise exception '你没有「仓库」或「送货」模块的查看权限，请找管理员开通。' using errcode = '42501';
  end if;
  c := coalesce(nullif(p_company, ''), case when me.branch = 'ALL' then 'HOMEWORKSSB' else me.branch end);
  if c not in ('HOMEWORKSSB', 'HOMEWORKSSOUTHERN') or not coalesce(ops.sees_company(me, c), false) then
    raise exception '你没有这间分店的权限。' using errcode = '42501';
  end if;
  if coalesce(array_length(p_doc_nos, 1), 0) > 500 then
    raise exception '一次最多 500 张单。' using errcode = '22023';
  end if;
  return coalesce((
    select jsonb_object_agg(k.doc_no, jsonb_build_object(
      'status', k.status, 'done_at', k.done_at,
      'picked', (select coalesce(sum(least(l.picked, l.qty)), 0) from ops.wh_pick_line l where l.pick_id = k.id and not l.skip),
      'total', (select coalesce(sum(l.qty), 0) from ops.wh_pick_line l where l.pick_id = k.id and not l.skip)))
    from ops.wh_pick k
    where k.company = c and k.status <> 'cancelled' and k.doc_no = any(coalesce(p_doc_nos, array[]::text[]))), '{}'::jsonb);
end $$;

-- ============================================================ 4. 开始 / 扫码 / 撤销
-- 开始拣货（可编辑）：存 DO 明细快照、配对商品。已经有人开始了 = 直接回传那一张（两个人同时按不会开两张）。
create or replace function public.ops_wh_pick_start(p_company text, p_doc_no text) returns jsonb
language plpgsql security definer set search_path = '' as $$
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
    raise exception 'DO % 在 AutoCount 已经取消，不用拣货。', d.doc_no using errcode = '22023';
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
end $$;

-- 扫一个商品。p: {pick_id, code, qty (预设 1), bin (目前货架，BIN:<id> 或代号，可空), line_id (给对不到的行指定商品)}
-- 扫错不报错：回传 {ok:false, code: unknown|wrong|over|skipped|bin|bin_short|is_bin, message}，什么都不存；
-- bin_short 另外回传 bins = 这个商品有货的货架（画面让人改选，或不从货架扣）。
-- 扫对：{ok:true, line, scan, pick, done_all}
create or replace function public.ops_wh_pick_scan(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
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
    raise exception '找不到这张拣货单。' using errcode = 'P0002';
  end if;
  if k.status <> 'picking' then
    raise exception '这张拣货单已经%，不能再扫。', case k.status when 'done' then '拣好' else '取消' end using errcode = '22023';
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
          'message', format('%s 那一行已经略过，不用拣。', v_item));
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
                      then format('%s 已经拣够了（要 %s）。多拿的请放回去。', v_item, ops.wh_pick_q(l.qty))
                      else format('%s 只差 %s，这次扫了 %s。多拿的请放回去。', v_item, ops.wh_pick_q(v_left), ops.wh_pick_q(v_qty)) end);
  end if;
  if v_bin is not null and ops.wh_pick_uom_diff(l.uom, (select i.base_uom from bi.dim_item i where i.company = k.company and i.item_code = v_item)) then
    return jsonb_build_object('ok', false, 'code', 'uom', 'item_code', v_item,
      'message', format('DO 的单位是 %s，商品的单位是 %s，不能照 DO 的数量从货架扣：请按「不从货架扣」拣，再到「货架」用「拿下」扣实际件数。',
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
end $$;

-- 撤销一笔扫码（可编辑、拣货中）：作废 + 货架加回去；扫码指定的商品没有扫码了就还原成「对不到」
create or replace function public.ops_wh_pick_undo(p_scan_id bigint) returns jsonb
language plpgsql security definer set search_path = '' as $$
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
    raise exception '拣货单已经%，不能撤销单笔。', case k.status when 'done' then '拣好（要改请先「重新打开」）' else '取消' end
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
  perform ops.wh_bin_reverse(me, 'pick', s.id, '撤销拣货 ' || k.doc_no);
  return jsonb_build_object('ok', true, 'line', ops.wh_pick_line_json(l, k.company), 'scan', ops.wh_pick_scan_json(s),
    'pick', ops.wh_pick_json(k));
end $$;

-- ============================================================ 5. 手动确认 / 略过 / 已拣好 / 取消 / 重新打开
-- 一行：p: {pick_id, line_id, action: manual|skip|unskip, qty, reason, bin}
--   manual = 没有条码（或条码坏了）手动确认拣了几件，要写原因；有对到商品才可以选货架扣
--   skip = 略过（运费、不用出货的），要写原因；已经拣了的要先撤销
create or replace function public.ops_wh_pick_line_set(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
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
    raise exception '找不到这张拣货单。' using errcode = 'P0002';
  end if;
  if k.status <> 'picking' then
    raise exception '这张拣货单已经%，不能再改。', case k.status when 'done' then '拣好' else '取消' end using errcode = '22023';
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
      raise exception '第 % 行已经拣了 %，请先撤销那几笔扫码再略过。', l.line_no, ops.wh_pick_q(l.picked) using errcode = '22023';
    end if;
    update ops.wh_pick_line set skip = true, skip_reason = v_reason where id = l.id returning * into l;
  elsif v_action = 'unskip' then
    update ops.wh_pick_line set skip = false, skip_reason = '' where id = l.id returning * into l;
  elsif v_action = 'manual' then
    v_qty := nullif(trim(coalesce(p->>'qty', '')), '')::numeric;
    if l.skip then
      raise exception '第 % 行已经略过，要拣请先取消略过。', l.line_no using errcode = '22023';
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
end $$;

-- 已拣好（可编辑）。p: {pick_id, force, short_note}；还有没拣够的行要 force + 缺货备注
create or replace function public.ops_wh_pick_done(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  k ops.wh_pick;
  n int;
  v_note text := left(trim(coalesce(p->>'short_note', '')), 500);
begin
  me := ops.require_level('warehouse', 'edit');
  select * into k from ops.wh_pick x where x.id = nullif(p->>'pick_id', '')::bigint for update;
  if k.id is null or not coalesce(ops.sees_company(me, k.company), false) then
    raise exception '找不到这张拣货单。' using errcode = 'P0002';
  end if;
  if k.status <> 'picking' then
    raise exception '这张拣货单已经%了。', case k.status when 'done' then '拣好' else '取消' end using errcode = '22023';
  end if;
  select count(*) into n from ops.wh_pick_line l where l.pick_id = k.id and not l.skip and l.picked < l.qty;
  if n > 0 and (not coalesce((p->>'force')::boolean, false) or v_note = '') then
    raise exception '还有 % 行没拣够。确定要这样出货，请写缺货备注再按「已拣好」。', n using errcode = '22023';
  end if;
  update ops.wh_pick set status = 'done', done_by = me.id, done_at = now(), short_note = case when n > 0 then v_note else '' end
  where id = k.id returning * into k;
  perform ops.log(me.id, 'done', 'wh_pick', k.id, jsonb_build_object('doc_no', k.doc_no, 'short_lines', n, 'note', k.short_note));
  return public.ops_wh_pick_get(k.company, k.doc_no);
end $$;

-- 谁可以取消 / 重新打开：仓库「可审批」，或开始拣货的人（还要可编辑）
create or replace function ops.wh_pick_can_manage(p_me ops.staff, k ops.wh_pick) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(ops.level_rank(ops.module_level(p_me, 'warehouse')) >= 3
                  or (ops.level_rank(ops.module_level(p_me, 'warehouse')) >= 2 and k.started_by = p_me.id), false)
$$;

-- 取消拣货（例：DO 在 AutoCount 取消了、拣错要重来）：所有从货架扣的加回去。p: {pick_id, reason}
create or replace function public.ops_wh_pick_cancel(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
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
    raise exception '找不到这张拣货单。' using errcode = 'P0002';
  end if;
  if k.status = 'cancelled' then
    raise exception '这张拣货单已经取消了。' using errcode = '22023';
  end if;
  if not ops.wh_pick_can_manage(me, k) then
    raise exception '只有开始拣货的人或仓库「可审批」可以取消。' using errcode = '42501';
  end if;
  -- 已拣好的（货多半已经出门）取消会把货架加回去：只给仓库「可审批」
  if k.status = 'done' and ops.level_rank(ops.module_level(me, 'warehouse')) < 3 then
    raise exception '已拣好的拣货单只有仓库「可审批」可以取消（取消会把货架上的数量加回去）。' using errcode = '42501';
  end if;
  if v_reason = '' then
    raise exception '取消要写原因（例：DO 取消了、拣错要重来）。' using errcode = '22023';
  end if;
  for s in select x.id from ops.wh_pick_scan x where x.pick_id = k.id and not x.voided and x.bin_id is not null order by x.id desc loop
    n := n + ops.wh_bin_reverse(me, 'pick', s.id, '取消拣货 ' || k.doc_no);
  end loop;
  update ops.wh_pick set status = 'cancelled', cancelled_by = me.id, cancelled_at = now(), cancel_reason = v_reason
  where id = k.id returning * into k;
  perform ops.log(me.id, 'cancel', 'wh_pick', k.id, jsonb_build_object('doc_no', k.doc_no, 'reason', v_reason, 'reversed', n));
  return jsonb_build_object('ok', true, 'doc_no', k.doc_no, 'reversed', n);
end $$;

-- 重新打开（已拣好 → 拣货中；例：按了已拣好才发现少一件）。p: {pick_id}
create or replace function public.ops_wh_pick_reopen(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  k ops.wh_pick;
begin
  me := ops.require_level('warehouse', 'edit');
  select * into k from ops.wh_pick x where x.id = nullif(p->>'pick_id', '')::bigint for update;
  if k.id is null or not coalesce(ops.sees_company(me, k.company), false) then
    raise exception '找不到这张拣货单。' using errcode = 'P0002';
  end if;
  if k.status <> 'done' then
    raise exception '只有已拣好的才能重新打开。' using errcode = '22023';
  end if;
  if not ops.wh_pick_can_manage(me, k) then
    raise exception '只有开始拣货的人或仓库「可审批」可以重新打开。' using errcode = '42501';
  end if;
  update ops.wh_pick set status = 'picking', done_by = null, done_at = null where id = k.id returning * into k;
  perform ops.log(me.id, 'reopen', 'wh_pick', k.id, jsonb_build_object('doc_no', k.doc_no));
  return public.ops_wh_pick_get(k.company, k.doc_no);
end $$;

-- ============================================================ 6. 权限
revoke all on function ops.wh_pick_num(jsonb) from public, anon, authenticated;
revoke all on function ops.wh_pick_norm(text) from public, anon, authenticated;
revoke all on function ops.wh_pick_q(numeric) from public, anon, authenticated;
revoke all on function ops.wh_pick_match(text, jsonb) from public, anon, authenticated;
revoke all on function ops.wh_pick_bins(text, text) from public, anon, authenticated;
revoke all on function ops.wh_pick_line_obj(text, bigint, int, text, text, numeric, text, text, numeric, boolean, text)
  from public, anon, authenticated;
revoke all on function ops.wh_pick_line_json(ops.wh_pick_line, text) from public, anon, authenticated;
revoke all on function ops.wh_pick_scan_json(ops.wh_pick_scan) from public, anon, authenticated;
revoke all on function ops.wh_pick_json(ops.wh_pick) from public, anon, authenticated;
revoke all on function ops.wh_pick_runs(text, text) from public, anon, authenticated;
revoke all on function ops.wh_pick_summary(text) from public, anon, authenticated;
revoke all on function ops.wh_do_unpicked(text) from public, anon, authenticated;
revoke all on function ops.wh_pick_uom_diff(text, text) from public, anon, authenticated;
revoke all on function ops.wh_pick_can_manage(ops.staff, ops.wh_pick) from public, anon, authenticated;
do $$
declare
  f text;
begin
  foreach f in array array['ops_wh_pick_list(jsonb)', 'ops_wh_pick_get(text, text)', 'ops_wh_pick_status(text, text[])',
                           'ops_wh_pick_start(text, text)', 'ops_wh_pick_scan(jsonb)', 'ops_wh_pick_undo(bigint)',
                           'ops_wh_pick_line_set(jsonb)', 'ops_wh_pick_done(jsonb)', 'ops_wh_pick_cancel(jsonb)',
                           'ops_wh_pick_reopen(jsonb)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
