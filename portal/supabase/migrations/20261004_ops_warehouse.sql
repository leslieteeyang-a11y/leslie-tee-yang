-- HomeWorks 营运系统 — 仓库（第 3 阶段，第一版；使用者 2026-10-03 决定先做仓库再做加班 / 薪资）
-- 问题（系统资料）：HOMEWORKSSB 约 5,000 个 SKU×仓位有货，另有 1,296 个 SKU×仓位库存是负数；
-- 半年盘一次（5 人 3 天），进货点得清，几个星期后就不准 → 漏记的是货进来之后的搬动。
-- 这一版做四件事（对 AutoCount 仍然只读，要调的数由员工照清单在 AutoCount 输入，再回来标「已输入」）：
--   1. 查货：扫条码 / 打字找商品，看各仓位库存（AutoCount 每天 09/12/15/18 点同步）、未出货订单、在途 PO。
--   2. 搬动登记：调仓、报坏、搬去展示、样品、退货、报废，当下在手机上登记 → 清单给负责人在 AutoCount 开转仓 / 调整单。
--      还没输入 AutoCount 的搬动会算进盘点的「应有数量」，避免同一件事被当成盘点差异。
--   3. 每日小盘点（循环盘点）：系统每天每个仓位挑一批（负库存优先 → 卖得快的 → 值钱的；30 天内盘过的跳过），
--      员工只看到要盘什么、看不到系统数量（盲盘）；不符先请他再数一次，第二次才算差异。
--   4. 差异审核：可审批的人看系统数 / 应有数 / 实盘数 / 差额（含成本），在 AutoCount 调整后标「已调整」或「不调整」。
-- 条码：商品条码就是 AutoCount 商品代号（Code 128，网页自己印）；纸箱上原本的条码可以绑定到商品（ops.wh_barcode）。

-- ------------------------------------------------------------ 资料表
create table ops.wh_location (
  company text not null check (company in ('HOMEWORKSSB', 'HOMEWORKSSOUTHERN')),
  code text not null,                                   -- AutoCount 的 Location 代号
  name text not null default '',
  counting boolean not null default true,               -- 要不要列入每日盘点
  daily_target int not null default 30 check (daily_target between 1 and 500),
  sort int not null default 0,
  primary key (company, code)
);
-- 从目前的库存带入仓位；主要仓位排前面
insert into ops.wh_location (company, code, sort, counting)
select distinct f.company, f.location,
       case f.location when 'HQ' then 10 when 'SRGADING' then 20 when 'JB' then 30 when 'DEFECTS' then 80
                       when 'DISPLAY' then 90 else 50 end,
       f.location not in ('EGO', 'JB RESER', 'TP STORE')
from bi.fact_stock f where f.location is not null and f.company in ('HOMEWORKSSB', 'HOMEWORKSSOUTHERN')
on conflict do nothing;

create table ops.wh_barcode (
  company text not null,
  barcode text not null check (length(barcode) between 3 and 64),
  item_code text not null,
  created_by bigint references ops.staff(id),
  created_at timestamptz not null default now(),
  primary key (company, barcode)
);

create table ops.wh_move (
  id bigint generated always as identity primary key,
  company text not null check (company in ('HOMEWORKSSB', 'HOMEWORKSSOUTHERN')),
  item_code text not null,
  qty numeric(12,2) not null check (qty > 0),
  kind text not null check (kind in ('transfer', 'defect', 'display', 'sample', 'return', 'writeoff', 'other')),
  from_loc text,
  to_loc text,
  note text not null default '' check (length(note) <= 500),
  photo text,
  status text not null default 'pending' check (status in ('pending', 'done', 'cancelled')),
  ac_doc text not null default '',
  created_by bigint not null references ops.staff(id),
  created_at timestamptz not null default now(),
  done_by bigint references ops.staff(id),
  done_at timestamptz,
  check (from_loc is not null or to_loc is not null),
  check (from_loc is distinct from to_loc)
);
create index wh_move_pending_idx on ops.wh_move (company, status) where status = 'pending';
create index wh_move_item_idx on ops.wh_move (company, item_code);

create table ops.wh_count (
  id bigint generated always as identity primary key,
  company text not null check (company in ('HOMEWORKSSB', 'HOMEWORKSSOUTHERN')),
  location text not null,
  item_code text not null,
  qty numeric(12,2) not null check (qty >= 0),
  system_qty numeric(12,2) not null,                    -- 盘点当下 AutoCount 同步来的数量
  pending_qty numeric(12,2) not null default 0,         -- 还没输入 AutoCount 的搬动（进 + / 出 −）
  unit_cost numeric(14,4),
  synced_at timestamptz,
  attempt int not null default 1 check (attempt in (1, 2)),
  status text not null check (status in ('match', 'variance', 'superseded', 'adjusted', 'ignored')),
  note text not null default '' check (length(note) <= 500),
  counted_by bigint not null references ops.staff(id),
  counted_at timestamptz not null default now(),
  count_date date not null,
  reviewed_by bigint references ops.staff(id),
  reviewed_at timestamptz,
  review_note text not null default '',
  ac_doc text not null default ''
);
create index wh_count_loc_idx on ops.wh_count (company, location, item_code, counted_at desc);
create index wh_count_status_idx on ops.wh_count (company, status) where status = 'variance';

alter table ops.wh_location enable row level security;
alter table ops.wh_barcode enable row level security;
alter table ops.wh_move enable row level security;
alter table ops.wh_count enable row level security;

update ops.module set ready = true,
  description = '查货（扫条码）、搬动登记、每日小盘点、差异审核、印条码'
where key = 'warehouse';

-- ------------------------------------------------------------ 小工具
create or replace function ops.wh_company(p_me ops.staff, p_company text) returns text
language plpgsql stable set search_path = '' as $$
declare
  c text := coalesce(nullif(p_company, ''), case when p_me.branch = 'ALL' then 'HOMEWORKSSB' else p_me.branch end);
begin
  if c not in ('HOMEWORKSSB', 'HOMEWORKSSOUTHERN') or not ops.sees_company(p_me, c) then
    raise exception '你没有这间分店的仓库权限。' using errcode = '42501';
  end if;
  return c;
end $$;

create or replace function ops.wh_synced_at(p_company text) returns timestamptz
language sql stable security definer set search_path = '' as $$
  select max(s.finished_at) from bi.sync_log s where s.ok and s.step = 'stock:' || p_company || ':load'
$$;

-- 扫到的码 → 商品代号（先找绑定的纸箱条码，再当成商品代号；大小写、前后空白不计）
create or replace function ops.wh_resolve(p_company text, p_code text) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select b.item_code from ops.wh_barcode b where b.company = p_company and b.barcode = trim(p_code)),
    (select i.item_code from bi.dim_item i where i.company = p_company and upper(i.item_code) = upper(trim(p_code))))
$$;

-- 还没输入 AutoCount 的搬动对某仓位的影响（进 + / 出 −）
create or replace function ops.wh_pending(p_company text, p_item text, p_loc text) returns numeric
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(case when m.to_loc = p_loc then m.qty else 0 end)
                - sum(case when m.from_loc = p_loc then m.qty else 0 end), 0)
  from ops.wh_move m
  where m.company = p_company and m.item_code = p_item and m.status = 'pending'
    and (m.to_loc = p_loc or m.from_loc = p_loc)
$$;

create or replace function ops.wh_move_json(m ops.wh_move) returns jsonb
language sql stable security definer set search_path = '' as $$
  select to_jsonb(m) || jsonb_build_object(
    'description', (select i.description from bi.dim_item i where i.company = m.company and i.item_code = m.item_code),
    'uom', (select i.base_uom from bi.dim_item i where i.company = m.company and i.item_code = m.item_code),
    'created_by_name', (select s.name from ops.staff s where s.id = m.created_by),
    'done_by_name', (select s.name from ops.staff s where s.id = m.done_by))
$$;

-- 盘点纪录；p_full = 可审批的人才看得到系统数量与成本
create or replace function ops.wh_count_json(c ops.wh_count, p_full boolean) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', c.id, 'company', c.company, 'location', c.location, 'item_code', c.item_code, 'qty', c.qty,
    'attempt', c.attempt, 'status', c.status, 'note', c.note, 'counted_at', c.counted_at, 'count_date', c.count_date,
    'counted_by_name', (select s.name from ops.staff s where s.id = c.counted_by),
    'description', (select i.description from bi.dim_item i where i.company = c.company and i.item_code = c.item_code),
    'uom', (select i.base_uom from bi.dim_item i where i.company = c.company and i.item_code = c.item_code),
    'reviewed_by_name', (select s.name from ops.staff s where s.id = c.reviewed_by),
    'reviewed_at', c.reviewed_at, 'review_note', c.review_note, 'ac_doc', c.ac_doc)
  || case when p_full then jsonb_build_object(
    'system_qty', c.system_qty, 'pending_qty', c.pending_qty, 'expected_qty', c.system_qty + c.pending_qty,
    'diff', c.qty - (c.system_qty + c.pending_qty), 'unit_cost', c.unit_cost,
    'diff_value', round((c.qty - (c.system_qty + c.pending_qty)) * coalesce(c.unit_cost, 0), 2),
    'synced_at', c.synced_at) else '{}'::jsonb end
$$;

-- ------------------------------------------------------------ 设定 / 查货
create or replace function public.ops_wh_meta() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
begin
  me := ops.require_level('warehouse', 'view');
  return jsonb_build_object(
    'level', ops.module_level(me, 'warehouse'),
    'companies', (select jsonb_agg(c order by c) from unnest(array['HOMEWORKSSB', 'HOMEWORKSSOUTHERN']) c
                  where ops.sees_company(me, c)),
    'locations', (select coalesce(jsonb_agg(to_jsonb(l) order by l.company, l.sort, l.code), '[]'::jsonb)
                  from ops.wh_location l where ops.sees_company(me, l.company)),
    'synced', (select jsonb_object_agg(c, ops.wh_synced_at(c)) from unnest(array['HOMEWORKSSB', 'HOMEWORKSSOUTHERN']) c
               where ops.sees_company(me, c)));
end $$;

-- 打字找商品：代号或品名（每个字都要出现），最多 30 笔
create or replace function public.ops_wh_find(p_company text, p_q text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  c text;
  words text[];
  hit text;
begin
  me := ops.require_level('warehouse', 'view');
  c := ops.wh_company(me, p_company);
  if length(trim(coalesce(p_q, ''))) < 2 then
    return '[]'::jsonb;
  end if;
  hit := ops.wh_resolve(c, p_q);
  words := regexp_split_to_array(upper(trim(p_q)), '\s+');
  return (select coalesce(jsonb_agg(x.j order by x.exact desc, x.code), '[]'::jsonb) from (
    select i.item_code as code, i.item_code = hit as exact,
           jsonb_build_object('item_code', i.item_code, 'description', i.description, 'uom', i.base_uom,
                              'item_group', i.item_group, 'active', i.is_active,
                              'qty', (select coalesce(sum(f.qty), 0) from bi.fact_stock f
                                      where f.company = c and f.item_code = i.item_code)) as j
    from bi.dim_item i
    where i.company = c and (i.item_code = hit or not exists (
            select 1 from unnest(words) w where position(w in upper(i.item_code || ' ' || coalesce(i.description, ''))) = 0))
    order by i.item_code = hit desc, i.is_active desc, i.item_code limit 30) x);
end $$;

-- 一件商品的全部：各仓位库存、还没输入的搬动、未出货订单、在途 PO、最近盘点
create or replace function public.ops_wh_item(p_company text, p_code text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  c text;
  code text;
  full_access boolean;
  it record;
begin
  me := ops.require_level('warehouse', 'view');
  c := ops.wh_company(me, p_company);
  code := ops.wh_resolve(c, p_code);
  select * into it from bi.dim_item i where i.company = c and i.item_code = code;
  if it.item_code is null then
    return jsonb_build_object('found', false, 'scanned', trim(coalesce(p_code, '')));
  end if;
  full_access := ops.level_rank(ops.module_level(me, 'warehouse')) >= 3;
  return jsonb_build_object(
    'found', true, 'company', c, 'item_code', it.item_code, 'description', it.description, 'uom', it.base_uom,
    'item_group', it.item_group, 'item_type', it.item_type, 'active', it.is_active,
    'synced_at', ops.wh_synced_at(c),
    'stock', (select coalesce(jsonb_agg(jsonb_build_object(
                'location', l.loc, 'qty', coalesce(f.qty, 0), 'pending', ops.wh_pending(c, it.item_code, l.loc),
                'unit_cost', case when full_access and f.qty > 0 then round(f.total_cost / f.qty, 2) end)
                order by coalesce(wl.sort, 50), l.loc), '[]'::jsonb)
              from (select f2.location as loc from bi.fact_stock f2 where f2.company = c and f2.item_code = it.item_code
                    union select m.from_loc from ops.wh_move m where m.company = c and m.item_code = it.item_code
                      and m.status = 'pending' and m.from_loc is not null
                    union select m.to_loc from ops.wh_move m where m.company = c and m.item_code = it.item_code
                      and m.status = 'pending' and m.to_loc is not null) l
              left join bi.fact_stock f on f.company = c and f.item_code = it.item_code and f.location = l.loc
              left join ops.wh_location wl on wl.company = c and wl.code = l.loc),
    'open_orders', (select coalesce(jsonb_agg(jsonb_build_object('doc_no', o.doc_no, 'doc_date', o.doc_date,
                      'customer', o.debtor_name, 'qty', o.outstanding_qty) order by o.doc_date), '[]'::jsonb)
                    from bi.fact_open_order o where o.company = c and o.item_code = it.item_code and o.outstanding_qty > 0),
    'incoming', (select coalesce(jsonb_agg(jsonb_build_object('po_no', l.po_no, 'po_date', l.po_date,
                   'supplier', l.creditor_name, 'location', l.location, 'qty', l.qty - l.transferred_qty) order by l.po_date), '[]'::jsonb)
                 from bi.fact_po_line l where l.company = c and l.item_code = it.item_code and not l.cancelled
                   and l.qty > l.transferred_qty and l.po_date > current_date - 365),
    'moves', (select coalesce(jsonb_agg(ops.wh_move_json(m) order by m.created_at desc), '[]'::jsonb) from (
                select * from ops.wh_move m where m.company = c and m.item_code = it.item_code
                order by (m.status = 'pending') desc, m.created_at desc limit 10) m),
    'counts', (select coalesce(jsonb_agg(ops.wh_count_json(k, full_access) order by k.counted_at desc), '[]'::jsonb) from (
                 select * from ops.wh_count k where k.company = c and k.item_code = it.item_code
                 order by k.counted_at desc limit 10) k),
    'barcodes', (select coalesce(jsonb_agg(b.barcode order by b.barcode), '[]'::jsonb)
                 from ops.wh_barcode b where b.company = c and b.item_code = it.item_code));
end $$;

-- 把纸箱上原本的条码绑到商品（之后扫那个码就会找到这件）
create or replace function public.ops_wh_barcode_bind(p_company text, p_barcode text, p_item_code text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  c text;
  bc text := trim(coalesce(p_barcode, ''));
begin
  me := ops.require_level('warehouse', 'edit');
  c := ops.wh_company(me, p_company);
  if length(bc) < 3 or length(bc) > 64 then
    raise exception '条码太短或太长。' using errcode = '22023';
  end if;
  if not exists (select 1 from bi.dim_item i where i.company = c and i.item_code = p_item_code) then
    raise exception '找不到商品 %。', p_item_code using errcode = 'P0002';
  end if;
  if exists (select 1 from bi.dim_item i where i.company = c and upper(i.item_code) = upper(bc) and i.item_code <> p_item_code) then
    raise exception '这个码是另一个商品的代号（%），不能绑定。', bc using errcode = '22023';
  end if;
  insert into ops.wh_barcode (company, barcode, item_code, created_by) values (c, bc, p_item_code, me.id)
  on conflict (company, barcode) do update set item_code = excluded.item_code, created_by = excluded.created_by,
                                                created_at = now();
  perform ops.log(me.id, 'bind', 'wh_barcode', null, jsonb_build_object('company', c, 'barcode', bc, 'item_code', p_item_code));
end $$;

-- ------------------------------------------------------------ 搬动
-- p: {company, item_code, qty, kind, from_loc, to_loc, note, photo}
create or replace function public.ops_wh_move_save(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  c text;
  code text;
  v_qty numeric := nullif(p->>'qty', '')::numeric;
  v_kind text := coalesce(nullif(p->>'kind', ''), 'transfer');
  v_from text := nullif(trim(coalesce(p->>'from_loc', '')), '');
  v_to text := nullif(trim(coalesce(p->>'to_loc', '')), '');
  ph text := nullif(p->>'photo', '');
  m ops.wh_move;
begin
  me := ops.require_level('warehouse', 'edit');
  c := ops.wh_company(me, p->>'company');
  code := ops.wh_resolve(c, p->>'item_code');
  if code is null then
    raise exception '找不到这个商品，请重新扫或打商品代号。' using errcode = 'P0002';
  end if;
  if v_qty is null or v_qty <= 0 then
    raise exception '请填数量。' using errcode = '22023';
  end if;
  if v_kind not in ('transfer', 'defect', 'display', 'sample', 'return', 'writeoff', 'other') then
    raise exception '未知的搬动种类：%', v_kind using errcode = '22023';
  end if;
  if v_kind = 'transfer' and (v_from is null or v_to is null) then
    raise exception '调仓要选「从哪个仓位」和「到哪个仓位」。' using errcode = '22023';
  end if;
  if v_kind in ('defect', 'display', 'sample', 'writeoff') and v_from is null then
    raise exception '请选货是从哪个仓位拿出来的。' using errcode = '22023';
  end if;
  if v_kind = 'return' and v_to is null then
    raise exception '退货请选放到哪个仓位。' using errcode = '22023';
  end if;
  if v_from is null and v_to is null then
    raise exception '请选仓位。' using errcode = '22023';
  end if;
  if v_from = v_to then
    raise exception '「从」和「到」不能是同一个仓位。' using errcode = '22023';
  end if;
  if (v_from is not null and not exists (select 1 from ops.wh_location l where l.company = c and l.code = v_from))
     or (v_to is not null and not exists (select 1 from ops.wh_location l where l.company = c and l.code = v_to)) then
    raise exception '没有这个仓位。' using errcode = '22023';
  end if;
  if v_kind in ('writeoff', 'other') and length(trim(coalesce(p->>'note', ''))) = 0 then
    raise exception '报废 / 其他请写原因。' using errcode = '22023';
  end if;
  if ph is not null and (split_part(ph, '/', 1) <> me.id::text
       or not exists (select 1 from storage.objects o where o.bucket_id = 'ops-hr' and o.name = ph)) then
    raise exception '照片没有上传成功，请再拍一次。' using errcode = '22023';
  end if;
  insert into ops.wh_move (company, item_code, qty, kind, from_loc, to_loc, note, photo, created_by)
  values (c, code, v_qty, v_kind, v_from, v_to, trim(coalesce(p->>'note', '')), ph, me.id) returning * into m;
  perform ops.log(me.id, 'create', 'wh_move', m.id, to_jsonb(m));
  return ops.wh_move_json(m);
end $$;

-- p: {company, status: pending|done|cancelled|all, mine: bool, q}
create or replace function public.ops_wh_moves(p jsonb default '{}'::jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  c text;
  st text := coalesce(nullif(p->>'status', ''), 'pending');
  q text := upper(trim(coalesce(p->>'q', '')));
begin
  me := ops.require_level('warehouse', 'view');
  c := ops.wh_company(me, p->>'company');
  return (select coalesce(jsonb_agg(ops.wh_move_json(m) order by m.created_at desc), '[]'::jsonb) from (
    select * from ops.wh_move m
    where m.company = c and (st = 'all' or m.status = st)
      and (not coalesce((p->>'mine')::boolean, false) or m.created_by = me.id)
      and (q = '' or upper(m.item_code) like '%' || q || '%' or upper(m.ac_doc) like '%' || q || '%')
    order by m.created_at desc limit 300) m);
end $$;

-- 负责人在 AutoCount 输入后标「已输入」（可一次多笔）；或取消（登记错）。登记的人自己也可以取消还没处理的
create or replace function public.ops_wh_move_mark(p_ids bigint[], p_action text, p_ac_doc text default '') returns int
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  m ops.wh_move;
  n int := 0;
  approver boolean;
begin
  me := ops.require_level('warehouse', 'view');
  approver := ops.level_rank(ops.module_level(me, 'warehouse')) >= 3;
  if p_action not in ('done', 'cancelled') then
    raise exception '未知的动作：%', p_action using errcode = '22023';
  end if;
  for m in select * from ops.wh_move where id = any(coalesce(p_ids, '{}')) for update loop
    if not ops.sees_company(me, m.company) or m.status <> 'pending' then
      continue;
    end if;
    if not (approver or (p_action = 'cancelled' and m.created_by = me.id)) then
      raise exception '只有仓库「可审批」的人可以标已输入 AutoCount。' using errcode = '42501';
    end if;
    update ops.wh_move set status = p_action, done_by = me.id, done_at = now(),
                           ac_doc = case when p_action = 'done' then trim(coalesce(p_ac_doc, '')) else ac_doc end
    where id = m.id;
    perform ops.log(me.id, p_action, 'wh_move', m.id, jsonb_build_object('ac_doc', p_ac_doc));
    n := n + 1;
  end loop;
  return n;
end $$;

-- ------------------------------------------------------------ 盘点
-- 今天这个仓位要盘的：30 天内没盘过（最终结果）的商品，负库存优先 → 90 天卖得多的 → 库存值高的。不给系统数量（盲盘）
create or replace function public.ops_wh_count_list(p_company text, p_location text, p_limit int default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  c text;
  loc ops.wh_location;
  td date := ops.today();
  n int;
begin
  me := ops.require_level('warehouse', 'view');
  c := ops.wh_company(me, p_company);
  select * into loc from ops.wh_location l where l.company = c and l.code = p_location;
  if loc.code is null then
    raise exception '没有这个仓位。' using errcode = 'P0002';
  end if;
  n := least(greatest(coalesce(p_limit, loc.daily_target), 1), 500);
  return jsonb_build_object(
    'company', c, 'location', loc.code, 'date', td, 'synced_at', ops.wh_synced_at(c),
    'done_today', (select coalesce(jsonb_agg(ops.wh_count_json(k, false) order by k.counted_at desc), '[]'::jsonb)
                   from ops.wh_count k where k.company = c and k.location = loc.code and k.count_date = td
                     and k.status <> 'superseded'),
    'recount', (select coalesce(jsonb_agg(k.item_code), '[]'::jsonb) from ops.wh_count k
                where k.company = c and k.location = loc.code and k.count_date = td and k.status = 'variance'
                  and k.attempt = 1),
    'todo', (select coalesce(jsonb_agg(jsonb_build_object('item_code', x.item_code, 'description', i.description,
                                                         'uom', i.base_uom, 'item_group', i.item_group)
                                       order by x.neg desc, x.sold desc, x.value desc, x.item_code), '[]'::jsonb)
             from (select f.item_code, f.qty < 0 as neg, coalesce(f.total_cost, 0) as value,
                          coalesce((select sum(s.qty) from bi.fact_sales s where s.company = c and s.item_code = f.item_code
                                    and s.doc_date > td - 90 and s.doc_type in ('IV', 'CS')), 0) as sold
                   from bi.fact_stock f
                   where f.company = c and f.location = loc.code and f.qty <> 0
                     and not exists (select 1 from ops.wh_count k where k.company = c and k.location = loc.code
                                       and k.item_code = f.item_code and k.status <> 'superseded'
                                       and k.count_date > td - 30)
                   order by f.qty < 0 desc, 4 desc, 3 desc, f.item_code limit n) x
             join bi.dim_item i on i.company = c and i.item_code = x.item_code),
    'progress', jsonb_build_object(
      'items', (select count(*) from bi.fact_stock f where f.company = c and f.location = loc.code and f.qty <> 0),
      'counted_30d', (select count(distinct k.item_code) from ops.wh_count k where k.company = c and k.location = loc.code
                        and k.status <> 'superseded' and k.count_date > td - 30)));
end $$;

-- p: {company, location, item_code（或扫到的码）, qty, note}
-- 回传 result：match（相符）/ recount（不符，请再数一次）/ variance（第二次还是不符，记为差异）
create or replace function public.ops_wh_count_save(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  c text;
  code text;
  loc text := p->>'location';
  v_qty numeric := nullif(p->>'qty', '')::numeric;
  f record;
  pend numeric;
  prev ops.wh_count;
  att int := 1;
  st text;
  k ops.wh_count;
  td date := ops.today();
begin
  me := ops.require_level('warehouse', 'edit');
  c := ops.wh_company(me, p->>'company');
  if not exists (select 1 from ops.wh_location l where l.company = c and l.code = loc) then
    raise exception '没有这个仓位。' using errcode = 'P0002';
  end if;
  code := ops.wh_resolve(c, p->>'item_code');
  if code is null then
    raise exception '找不到这个商品，请重新扫或打商品代号。' using errcode = 'P0002';
  end if;
  if v_qty is null or v_qty < 0 then
    raise exception '请填实际数到的数量（没有就填 0）。' using errcode = '22023';
  end if;
  select fs.qty, fs.total_cost into f from bi.fact_stock fs where fs.company = c and fs.item_code = code and fs.location = loc;
  pend := ops.wh_pending(c, code, loc);
  select * into prev from ops.wh_count x where x.company = c and x.location = loc and x.item_code = code
    and x.count_date = td and x.status <> 'superseded' order by x.counted_at desc limit 1 for update;
  if prev.id is not null and prev.status = 'variance' and prev.attempt = 1 then
    att := 2;
  end if;
  st := case when v_qty = coalesce(f.qty, 0) + pend then 'match' else 'variance' end;
  if prev.id is not null then
    -- 同一天重盘：旧的那笔作废（最后一次算数）
    update ops.wh_count set status = 'superseded' where id = prev.id;
  end if;
  insert into ops.wh_count (company, location, item_code, qty, system_qty, pending_qty, unit_cost, synced_at, attempt,
                            status, note, counted_by, count_date)
  values (c, loc, code, v_qty, coalesce(f.qty, 0), pend,
          case when f.qty > 0 then f.total_cost / f.qty end, ops.wh_synced_at(c), att, st,
          trim(coalesce(p->>'note', '')), me.id, td)
  returning * into k;
  perform ops.log(me.id, 'count', 'wh_count', k.id, jsonb_build_object('status', st, 'attempt', att));
  return jsonb_build_object('id', k.id, 'item_code', code, 'attempt', att,
                            'result', case when st = 'match' then 'match' when att = 1 then 'recount' else 'variance' end);
end $$;

-- 差异审核清单（可审批）：p {company, location, status: variance|adjusted|ignored|match|all, from, to}
create or replace function public.ops_wh_counts(p jsonb default '{}'::jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  c text;
  st text := coalesce(nullif(p->>'status', ''), 'variance');
  full_access boolean;
begin
  me := ops.require_level('warehouse', 'view');
  c := ops.wh_company(me, p->>'company');
  full_access := ops.level_rank(ops.module_level(me, 'warehouse')) >= 3;
  if not full_access and st = 'variance' then
    raise exception '只有仓库「可审批」的人看得到盘点差异。' using errcode = '42501';
  end if;
  return (select coalesce(jsonb_agg(ops.wh_count_json(k, full_access) order by k.counted_at desc), '[]'::jsonb) from (
    select * from ops.wh_count k
    where k.company = c and k.status <> 'superseded' and (st = 'all' or k.status = st)
      and (nullif(p->>'location', '') is null or k.location = p->>'location')
      and (nullif(p->>'from', '') is null or k.count_date >= (p->>'from')::date)
      and (nullif(p->>'to', '') is null or k.count_date <= (p->>'to')::date)
      and (full_access or k.counted_by = me.id)
    order by k.counted_at desc limit 500) k);
end $$;

-- 审核：adjusted（已在 AutoCount 调整）/ ignored（不调整，写原因）/ recount（请明天再盘：作废这笔）
create or replace function public.ops_wh_count_review(p_ids bigint[], p_action text, p_ac_doc text default '',
                                                      p_note text default '') returns int
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  k ops.wh_count;
  n int := 0;
begin
  me := ops.require_level('warehouse', 'approve');
  if p_action not in ('adjusted', 'ignored', 'recount') then
    raise exception '未知的动作：%', p_action using errcode = '22023';
  end if;
  if p_action = 'ignored' and length(trim(coalesce(p_note, ''))) = 0 then
    raise exception '不调整请写原因（例：货在路上、AutoCount 单还没开）。' using errcode = '22023';
  end if;
  for k in select * from ops.wh_count where id = any(coalesce(p_ids, '{}')) for update loop
    if not ops.sees_company(me, k.company) or k.status <> 'variance' then
      continue;
    end if;
    update ops.wh_count set
      status = case p_action when 'recount' then 'superseded' else p_action end,
      reviewed_by = me.id, reviewed_at = now(), review_note = trim(coalesce(p_note, '')),
      ac_doc = case when p_action = 'adjusted' then trim(coalesce(p_ac_doc, '')) else ac_doc end
    where id = k.id;
    perform ops.log(me.id, 'review_' || p_action, 'wh_count', k.id, jsonb_build_object('ac_doc', p_ac_doc));
    n := n + 1;
  end loop;
  return n;
end $$;

-- 仓位设定（可审批）：每日盘几件、要不要盘、显示名称
create or replace function public.ops_wh_location_save(p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  c text;
begin
  me := ops.require_level('warehouse', 'approve');
  c := ops.wh_company(me, p->>'company');
  update ops.wh_location set
    name = coalesce(p->>'name', name),
    counting = coalesce((p->>'counting')::boolean, counting),
    daily_target = coalesce(nullif(p->>'daily_target', '')::int, daily_target)
  where company = c and code = p->>'code';
  if not found then
    raise exception '没有这个仓位。' using errcode = 'P0002';
  end if;
  perform ops.log(me.id, 'location', 'wh_location', null, p);
end $$;

-- 印标签用：一批商品代号 → 品名（只回传找得到的）
create or replace function public.ops_wh_items(p_company text, p_codes text[]) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  c text;
begin
  me := ops.require_level('warehouse', 'view');
  c := ops.wh_company(me, p_company);
  return (select coalesce(jsonb_agg(jsonb_build_object('item_code', i.item_code, 'description', i.description,
                                                      'uom', i.base_uom) order by i.item_code), '[]'::jsonb)
          from bi.dim_item i where i.company = c and i.item_code = any(coalesce(p_codes, '{}')));
end $$;

-- 某仓位所有有库存的商品（印整个仓位的标签用）
create or replace function public.ops_wh_location_items(p_company text, p_location text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  c text;
begin
  me := ops.require_level('warehouse', 'view');
  c := ops.wh_company(me, p_company);
  return (select coalesce(jsonb_agg(jsonb_build_object('item_code', i.item_code, 'description', i.description,
                                                      'uom', i.base_uom, 'qty', f.qty) order by i.item_code), '[]'::jsonb)
          from bi.fact_stock f join bi.dim_item i on i.company = f.company and i.item_code = f.item_code
          where f.company = c and f.location = p_location and f.qty > 0);
end $$;

-- ------------------------------------------------------------ 首页：仓库待办
create or replace function public.ops_home() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  rec ops.attendance;
  wh int := ops.level_rank(ops.module_level(ops.current_staff(), 'warehouse'));
begin
  me := ops.require_staff();
  select * into rec from ops.attendance where staff_id = me.id and date = ops.today();
  return jsonb_build_object(
    'my_open_tasks', (select count(*) from ops.task t where t.assignee_id = me.id and t.status in ('todo', 'doing')),
    'my_overdue', (select count(*) from ops.task t where t.assignee_id = me.id and t.status in ('todo', 'doing')
                   and t.due_date < current_date),
    'dept_open_tasks', (select count(*) from ops.task t where t.department = me.department
                        and t.status in ('todo', 'doing') and ops.sees_branch(me, t.branch)),
    'approvals_waiting', (select count(*) from ops.approval a where a.status = 'pending'
                          and ops.can_decide(me, a)),
    'my_pending_requests', (select count(*) from ops.approval a where a.requested_by = me.id and a.status = 'pending'),
    'po_overdue', case when ops.level_rank(ops.module_level(me, 'purchasing')) >= 2 then
                    (select count(*) from ops.v_po_open v where ops.sees_company(me, v.company)
                     and v.status <> 'closed' and v.days_late > 0
                     and (v.days_open <= 120 or v.status <> 'ordered' or v.po_eta is not null or v.shipment_id is not null))
                  end,
    'att', case when ops.level_rank(ops.module_level(me, 'attendance')) >= 2 then jsonb_build_object(
             'clock_in', rec.clock_in, 'clock_out', rec.clock_out, 'lunch_in', rec.lunch_in,
             'workday', (select s.workday from ops.att_schedule(me, ops.today()) s),
             'leave', ops.leave_on(me.id, ops.today()),
             'open_shift', exists (select 1 from ops.attendance a where a.staff_id = me.id and a.date < ops.today()
                                   and a.clock_in is not null and a.clock_out is null)) end,
    'corrections_waiting', (select count(*) from ops.punch_correction c
                            where c.status in ('pending_hod', 'pending_hr') and ops.att_can_decide(me, c)),
    'leave_waiting', (select count(*) from ops.leave_request r where r.status = 'pending' and ops.leave_can_decide(me, r)),
    'my_pending_leave', (select count(*) from ops.leave_request r where r.staff_id = me.id and r.status = 'pending'),
    'wh_moves_pending', case when wh >= 3 then (select count(*) from ops.wh_move m
                          where m.status = 'pending' and ops.sees_company(me, m.company)) end,
    'wh_variances', case when wh >= 3 then (select count(*) from ops.wh_count k
                      where k.status = 'variance' and ops.sees_company(me, k.company)
                        and (k.attempt = 2 or k.count_date < ops.today())) end,
    'wh_counted_today', case when wh >= 2 then (select count(*) from ops.wh_count k
                          where k.counted_by = me.id and k.count_date = ops.today() and k.status <> 'superseded') end
  );
end $$;

-- ------------------------------------------------------------ 权限
do $$
declare
  f text;
begin
  foreach f in array array[
    'ops_wh_meta()', 'ops_wh_find(text,text)', 'ops_wh_item(text,text)', 'ops_wh_barcode_bind(text,text,text)',
    'ops_wh_move_save(jsonb)', 'ops_wh_moves(jsonb)', 'ops_wh_move_mark(bigint[],text,text)',
    'ops_wh_count_list(text,text,int)', 'ops_wh_count_save(jsonb)', 'ops_wh_counts(jsonb)',
    'ops_wh_count_review(bigint[],text,text,text)', 'ops_wh_location_save(jsonb)', 'ops_wh_items(text,text[])',
    'ops_wh_location_items(text,text)', 'ops_home()'
  ] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

revoke all on all functions in schema ops from public, anon, authenticated;
revoke all on all tables in schema ops from public, anon, authenticated;
