-- HomeWorks 营运系统 — 仓库：盘点单 + 按货架盘 + 盘点统计（使用者 2026-10-15 看了员工做的 WMS 后选的）
-- 要在 20261017_ops_wh_bins.sql（货架帐）之后套。对 AutoCount 仍然只读：盘点差异照旧进「差异审核」，由主管在 AutoCount 开调整单。
--   · 按货架盘：这个商品在这个仓位有货架帐（ops.wh_bin_stock）时，盘点画面列出那些货架（只给名字、不给数量 = 盲盘）
--     +「其他地方 / 地上」+「加一个货架」，每格填数，合计 = 实盘数。照旧「第一次不符请再数，第二次才算差异」；
--     结果是相符或差异（定案）时，把每个列出来的货架改成盘到的数（货架帐跟着实盘走）；请再数的那次不改。每格都留底（ops.wh_count_bin）。
--   · 盘点单：主管（仓库可审批）指定 仓位 + 范围（整个仓位 / 几个货架 / 贴商品代号）、指派人、期限；
--     员工用手机盲盘（不给系统数），照货架顺序排（走一圈的顺序）；主管看进度，差异照样进「差异审核」。
--     一行的结果 = 开单后（结单前）这个仓位这个商品最后一笔没作废的盘点（每日小盘点盘到的也算）。
--     盘点单里盘过的商品，30 天内不会再出现在每日清单（原本的规则）。
--   · 盘点统计（可审批）：近 30 / 90 / 180 天的次数、相符率、差异项数与金额（成本）、常常不准的商品、每个人、每月。
-- 提醒：AutoCount 挡不了出货——盘的时候请门市暂停这个仓位出货，或下班后盘（画面上有写）。

-- ============================================================ 1. 资料表
create table ops.wh_count_sheet (
  id bigint generated always as identity primary key,
  company text not null check (company in ('HOMEWORKSSB', 'HOMEWORKSSOUTHERN')),
  title text not null check (length(title) between 1 and 80),
  location text not null,
  scope text not null check (scope in ('location', 'bins', 'items')),
  bins bigint[] not null default '{}',                     -- scope = bins 时选的货架
  due_date date,
  note text not null default '' check (length(note) <= 500),
  status text not null default 'open' check (status in ('open', 'closed', 'cancelled')),
  assignees bigint[] not null default '{}',                -- 指派的人（ops.staff.id）
  created_by bigint not null references ops.staff(id),
  created_at timestamptz not null default now(),
  closed_by bigint references ops.staff(id),               -- 结单或取消的人
  closed_at timestamptz,
  cancel_reason text not null default '' check (length(cancel_reason) <= 300),
  foreign key (company, location) references ops.wh_location (company, code)
);
create index wh_count_sheet_open_idx on ops.wh_count_sheet (company, status, created_at desc);

create table ops.wh_count_sheet_line (
  id bigint generated always as identity primary key,
  sheet_id bigint not null references ops.wh_count_sheet(id),
  item_code text not null,
  count_id bigint references ops.wh_count(id),             -- 在这张单上盘的最后一笔（留底；结果另外照规则算）
  counted_by bigint references ops.staff(id),
  counted_at timestamptz,
  unique (sheet_id, item_code)
);

alter table ops.wh_count add column sheet_id bigint references ops.wh_count_sheet(id);
create index wh_count_sheet_idx on ops.wh_count (sheet_id) where sheet_id is not null;

-- 按货架盘的每一格（bin_id 空 = 其他地方 / 地上）
create table ops.wh_count_bin (
  id bigint generated always as identity primary key,
  count_id bigint not null references ops.wh_count(id),
  bin_id bigint references ops.wh_bin(id),
  qty numeric(12,2) not null check (qty >= 0)
);
create index wh_count_bin_count_idx on ops.wh_count_bin (count_id);

alter table ops.wh_count_sheet enable row level security;
alter table ops.wh_count_sheet_line enable row level security;
alter table ops.wh_count_bin enable row level security;

-- ============================================================ 2. 小工具
-- 可以被指派盘点的人：在职（没过最后上班日）、看得到这间分店、仓库「可编辑」以上
create or replace function ops.wh_sheet_eligible(s ops.staff, p_company text) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(s.active and (s.last_day is null or s.last_day >= ops.today()) and ops.sees_company(s, p_company)
                  and ops.level_rank(ops.module_level(s, 'warehouse')) >= 2, false)
$$;

-- 盘点单每一行目前的结果：开单后（结单 / 取消前）这个仓位这个商品最后一笔没作废的盘点。
-- st：todo 未盘 / recount 要再数（第一次不符）/ match 相符 / variance 差异 / adjusted 已调整 / ignored 不调整
create or replace function ops.wh_sheet_counts(s ops.wh_count_sheet)
returns table (item_code text, count_id bigint, st text, counted_by bigint, counted_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select l.item_code, k.id,
         case when k.id is null then 'todo' when k.status = 'variance' and k.attempt = 1 then 'recount' else k.status end,
         k.counted_by, k.counted_at
  from ops.wh_count_sheet_line l
  left join lateral (
    select x.id, x.status, x.attempt, x.counted_by, x.counted_at from ops.wh_count x
    where x.company = s.company and x.location = s.location and x.item_code = l.item_code and x.status <> 'superseded'
      and x.counted_at >= s.created_at and (s.closed_at is null or x.counted_at <= s.closed_at)
    order by x.counted_at desc, x.id desc limit 1) k on true
  where l.sheet_id = s.id
$$;

-- 一张盘点单的摘要（清单、明细共用）：进度、各人盘了几项
create or replace function ops.wh_sheet_json(s ops.wh_count_sheet, p_me ops.staff) returns jsonb
language sql stable security definer set search_path = '' as $$
  with x as (select * from ops.wh_sheet_counts(s))
  select jsonb_build_object(
    'id', s.id, 'company', s.company, 'title', s.title, 'location', s.location, 'scope', s.scope,
    'bins', coalesce((select jsonb_agg(b.code order by b.sort, b.zone, length(b.shelf), b.shelf, length(b.level), b.level)
                      from ops.wh_bin b where b.id = any(s.bins)), '[]'::jsonb),
    'due_date', s.due_date, 'note', s.note, 'status', s.status, 'cancel_reason', s.cancel_reason,
    'overdue', coalesce(s.status = 'open' and s.due_date < ops.today(), false),
    'mine', coalesce(p_me.id = any(s.assignees), false),
    'created_by_name', (select st.name from ops.staff st where st.id = s.created_by), 'created_at', s.created_at,
    'closed_by_name', (select st.name from ops.staff st where st.id = s.closed_by), 'closed_at', s.closed_at,
    'total', (select count(*) from x),
    'done', (select count(*) from x where x.st in ('match', 'variance', 'adjusted', 'ignored')),
    'recount', (select count(*) from x where x.st = 'recount'),
    'variance', (select count(*) from x where x.st in ('variance', 'adjusted', 'ignored')),
    'todo', (select count(*) from x where x.st = 'todo'),
    'assignees', coalesce((select jsonb_agg(jsonb_build_object('id', st.id, 'name', st.name,
                             'n', (select count(*) from x where x.counted_by = st.id))
                           order by array_position(s.assignees, st.id))
                           from ops.staff st where st.id = any(s.assignees)), '[]'::jsonb),
    -- 没被指派、但也帮忙盘了的人
    'helpers', coalesce((select jsonb_agg(jsonb_build_object('id', h.counted_by, 'name', st.name, 'n', h.n) order by h.n desc)
                         from (select x.counted_by, count(*) n from x where x.counted_by is not null
                                 and not (x.counted_by = any(s.assignees)) group by x.counted_by) h
                         join ops.staff st on st.id = h.counted_by), '[]'::jsonb))
$$;

-- 盘点纪录（照抄 20261004_ops_warehouse.sql，多回盘点单名称与按货架盘的每一格）；p_full = 可审批的人才看得到系统数量与成本
create or replace function ops.wh_count_json(c ops.wh_count, p_full boolean) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', c.id, 'company', c.company, 'location', c.location, 'item_code', c.item_code, 'qty', c.qty,
    'attempt', c.attempt, 'status', c.status, 'note', c.note, 'counted_at', c.counted_at, 'count_date', c.count_date,
    'counted_by_name', (select s.name from ops.staff s where s.id = c.counted_by),
    'description', (select i.description from bi.dim_item i where i.company = c.company and i.item_code = c.item_code),
    'uom', (select i.base_uom from bi.dim_item i where i.company = c.company and i.item_code = c.item_code),
    'reviewed_by_name', (select s.name from ops.staff s where s.id = c.reviewed_by),
    'reviewed_at', c.reviewed_at, 'review_note', c.review_note, 'ac_doc', c.ac_doc,
    'sheet_id', c.sheet_id,
    'sheet_title', (select sh.title from ops.wh_count_sheet sh where sh.id = c.sheet_id),
    'bins', (select jsonb_agg(jsonb_build_object('code', b.code, 'qty', x.qty) order by x.bin_id is null, b.code)
             from ops.wh_count_bin x left join ops.wh_bin b on b.id = x.bin_id where x.count_id = c.id))
  || case when p_full then jsonb_build_object(
    'system_qty', c.system_qty, 'pending_qty', c.pending_qty, 'expected_qty', c.system_qty + c.pending_qty,
    'diff', c.qty - (c.system_qty + c.pending_qty), 'unit_cost', c.unit_cost,
    'diff_value', round((c.qty - (c.system_qty + c.pending_qty)) * coalesce(c.unit_cost, 0), 2),
    'synced_at', c.synced_at) else '{}'::jsonb end
$$;

-- ============================================================ 3. 按货架盘
-- 盘点画面要列的货架：这个商品在这个仓位有货架帐的货架（只给名字，不给数量 = 盲盘）、这个仓位全部货架（「加一个货架」用）、
-- 要不要再数、在不在开着的盘点单上。p: {company, location, item}
create or replace function public.ops_wh_count_bins(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
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
                      where b.company = c and b.location = loc and b.active
                        and exists (select 1 from ops.wh_bin_stock s where s.bin_id = b.id and s.item_code = v_item)), '[]'::jsonb),
    'all_bins', coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'code', x.code) order by x.o) from (
                          select b.id, b.code, row_number() over (order by b.sort, b.zone, length(b.shelf), b.shelf,
                                                                   length(b.level), b.level) o
                          from ops.wh_bin b where b.company = c and b.location = loc and b.active
                          order by o limit 2000) x), '[]'::jsonb),
    'recount', exists (select 1 from ops.wh_count k where k.company = c and k.location = loc and k.item_code = v_item
                         and k.count_date = ops.today() and k.status = 'variance' and k.attempt = 1),
    'sheet', (select jsonb_build_object('id', s.id, 'title', s.title) from ops.wh_count_sheet s
              where s.company = c and s.location = loc and s.status = 'open'
                and exists (select 1 from ops.wh_count_sheet_line l where l.sheet_id = s.id and l.item_code = v_item)
              order by s.created_at desc, s.id desc limit 1));
end $$;

-- 盘点（每日小盘点与盘点单都走这里）。p = ops_wh_count_save 的参数（company, location, item_code, note）
--   + bins: [{bin: 货架编号 / BIN:编号 / 代号, qty}] + loose（其他地方 / 地上）+ sheet_id（选填；没给就自动挂到开着、有这个商品的盘点单）。
-- 合计当实盘数交给 ops_wh_count_save；结果是 match 或 variance（定案）时，把列出来的货架改成盘到的数；recount 时不改。
create or replace function public.ops_wh_count_save_bins(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  c text;
  loc text := trim(coalesce(p->>'location', ''));
  v_item text;
  e jsonb;
  b ops.wh_bin;
  ids bigint[] := '{}';
  qtys numeric[] := '{}';
  q numeric;
  loose numeric := coalesce(nullif(trim(coalesce(p->>'loose', '')), '')::numeric, 0);
  total numeric;
  sh ops.wh_count_sheet;
  miss text;
  r jsonb;
  kid bigint;
  n int := 0;
begin
  me := ops.require_level('warehouse', 'edit');
  c := ops.wh_company(me, p->>'company');
  if not exists (select 1 from ops.wh_location l where l.company = c and l.code = loc) then
    raise exception '没有这个仓位。' using errcode = 'P0002';
  end if;
  v_item := ops.wh_resolve(c, p->>'item_code');
  if v_item is null then
    raise exception '找不到这个商品，请重新扫或打商品代号。' using errcode = 'P0002';
  end if;
  if loose < 0 then
    raise exception '「其他地方 / 地上」的数量不能小于 0。' using errcode = '22023';
  end if;
  for e in select x from jsonb_array_elements(case when jsonb_typeof(p->'bins') = 'array' then p->'bins' else '[]'::jsonb end) x loop
    b := ops.wh_bin_find(c, case when jsonb_typeof(e->'bin') = 'number' then 'BIN:' || (e->>'bin') else e->>'bin' end, loc);
    if not b.active then
      raise exception '货架 % 已经停用，请把数量填在「其他地方 / 地上」。', b.code using errcode = '22023';
    end if;
    if b.id = any(ids) then
      raise exception '货架 % 填了两次。', b.code using errcode = '22023';
    end if;
    q := nullif(trim(coalesce(e->>'qty', '')), '')::numeric;
    if q is null or q < 0 then
      raise exception '请填货架 % 数到几（没有就填 0）。', b.code using errcode = '22023';
    end if;
    ids := ids || b.id;
    qtys := qtys || q;
  end loop;
  -- 货架帐上有这个商品的货架都要一起数（打开画面之后有人上架到别的货架 → 请重开）
  select string_agg(bb.code, '、' order by bb.code) into miss
  from ops.wh_bin_stock s join ops.wh_bin bb on bb.id = s.bin_id
  where s.company = c and s.item_code = v_item and bb.location = loc and s.qty > 0 and not (bb.id = any(ids));
  if miss is not null then
    raise exception '货架 % 上也记了这个商品，请关掉再打开一次，把这些货架也数进去。', miss using errcode = '22023';
  end if;
  total := loose + coalesce((select sum(x) from unnest(qtys) x), 0);

  if nullif(trim(coalesce(p->>'sheet_id', '')), '') is not null then
    select * into sh from ops.wh_count_sheet s where s.id = (p->>'sheet_id')::bigint and s.company = c;
    if sh.id is null then
      raise exception '找不到这张盘点单。' using errcode = 'P0002';
    end if;
    if sh.status <> 'open' then
      raise exception '这张盘点单已经结束了，请回到盘点单清单。' using errcode = '22023';
    end if;
    if sh.location <> loc then
      raise exception '这张盘点单是盘 % 的，不是 %。', sh.location, loc using errcode = '22023';
    end if;
    if not exists (select 1 from ops.wh_count_sheet_line l where l.sheet_id = sh.id and l.item_code = v_item) then
      raise exception '% 不在这张盘点单上。', v_item using errcode = '22023';
    end if;
  else
    select s.* into sh from ops.wh_count_sheet s
    where s.company = c and s.location = loc and s.status = 'open'
      and exists (select 1 from ops.wh_count_sheet_line l where l.sheet_id = s.id and l.item_code = v_item)
    order by s.created_at desc, s.id desc limit 1;
  end if;

  r := public.ops_wh_count_save(jsonb_build_object('company', c, 'location', loc, 'item_code', v_item, 'qty', total,
                                                   'note', coalesce(p->>'note', '')));
  kid := (r->>'id')::bigint;
  insert into ops.wh_count_bin (count_id, bin_id, qty)
  select kid, ids[i], qtys[i] from generate_subscripts(ids, 1) i;
  if cardinality(ids) > 0 and loose > 0 then
    insert into ops.wh_count_bin (count_id, bin_id, qty) values (kid, null, loose);
  end if;
  if sh.id is not null then
    update ops.wh_count set sheet_id = sh.id where id = kid;
    update ops.wh_count_sheet_line set count_id = kid, counted_by = me.id, counted_at = now()
    where sheet_id = sh.id and item_code = v_item;
  end if;
  if r->>'result' in ('match', 'variance') then
    for i in 1 .. cardinality(ids) loop
      perform ops.wh_bin_apply(me, ids[i], v_item, null, 'count', 'count', kid,
                               case when sh.id is null then '盘点' else '盘点单：' || sh.title end, qtys[i]);
      n := n + 1;
    end loop;
  end if;
  return r || jsonb_build_object('total', total, 'bins_set', n, 'sheet_id', sh.id, 'sheet_title', sh.title);
end $$;

-- ============================================================ 4. 建 / 改 / 结 / 取消盘点单（可审批）
-- 可以指派的人（这间分店仓库「可编辑」以上、在职）
create or replace function public.ops_wh_sheet_staff(p_company text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  c text;
begin
  me := ops.require_level('warehouse', 'approve');
  c := ops.wh_company(me, p_company);
  return coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'department', s.department,
                     'department_name', (select d.name from ops.department d where d.code = s.department), 'role', s.role)
                   order by s.department <> 'warehouse', s.role = 'admin', s.name)
                   from ops.staff s where ops.wh_sheet_eligible(s, c)), '[]'::jsonb);
end $$;

-- 指派人：去重、每个都要能盘这间分店
create or replace function ops.wh_sheet_assignees(p jsonb, p_company text) returns bigint[]
language plpgsql stable security definer set search_path = '' as $$
declare
  ass bigint[];
  bad text;
begin
  if jsonb_typeof(p) is distinct from 'array' then
    raise exception '请至少指派一个人。' using errcode = '22023';
  end if;
  select array_agg(distinct x::bigint) into ass from jsonb_array_elements_text(p) x where x ~ '^[0-9]{1,12}$';
  if coalesce(cardinality(ass), 0) = 0 then
    raise exception '请至少指派一个人。' using errcode = '22023';
  end if;
  select string_agg(coalesce(s.name, a::text), '、') into bad
  from unnest(ass) a left join ops.staff s on s.id = a
  where not coalesce(ops.wh_sheet_eligible(s, p_company), false);
  if bad is not null then
    raise exception '% 没有这间分店仓库「可编辑」的权限（或已离职），不能指派。', bad using errcode = '22023';
  end if;
  return ass;
end $$;

-- p: {company, title, location, scope: location|bins|items, bins: [货架编号], items: [商品代号或纸箱条码], assignees: [员工编号],
--     due_date, note}
-- 范围：整个仓位 = AutoCount 在这个仓位有库存（含负数）的 + 货架帐上有的 + 还没输入 AutoCount、要进这个仓位的；
--       选货架 = 那些货架上记过的商品（含 0 = 平常放这里）；贴商品代号 = 那些商品（找不到的列出来，整张不建）。
create or replace function public.ops_wh_sheet_create(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  c text;
  loc text := trim(coalesce(p->>'location', ''));
  v_title text := trim(coalesce(p->>'title', ''));
  v_scope text := coalesce(nullif(p->>'scope', ''), 'location');
  v_due date := nullif(trim(coalesce(p->>'due_date', '')), '')::date;
  v_bins bigint[] := '{}';
  codes text[];
  bad text;
  ass bigint[];
  s ops.wh_count_sheet;
begin
  me := ops.require_level('warehouse', 'approve');
  c := ops.wh_company(me, p->>'company');
  if not exists (select 1 from ops.wh_location l where l.company = c and l.code = loc) then
    raise exception '没有这个仓位。' using errcode = '22023';
  end if;
  if v_title = '' or length(v_title) > 80 then
    raise exception '请填盘点单名称（80 个字以内）。' using errcode = '22023';
  end if;
  if v_scope not in ('location', 'bins', 'items') then
    raise exception '未知的盘点范围：%', v_scope using errcode = '22023';
  end if;
  if v_due is not null and v_due < ops.today() then
    raise exception '期限不能早于今天。' using errcode = '22023';
  end if;
  if length(coalesce(p->>'note', '')) > 500 then
    raise exception '备注太长（500 个字以内）。' using errcode = '22023';
  end if;
  ass := ops.wh_sheet_assignees(p->'assignees', c);

  if v_scope = 'location' then
    select array_agg(distinct x.item_code) into codes from (
      select f.item_code from bi.fact_stock f where f.company = c and f.location = loc and f.qty <> 0
      union
      select st.item_code from ops.wh_bin_stock st join ops.wh_bin b on b.id = st.bin_id
      where b.company = c and b.location = loc and b.active and st.qty > 0
      union
      select m.item_code from ops.wh_move m
      where m.company = c and m.status = 'pending' and m.to_loc = loc and not (m.kind = 'receive' and m.pre_grn is not null)
    ) x where exists (select 1 from bi.dim_item i where i.company = c and i.item_code = x.item_code);
    if coalesce(cardinality(codes), 0) = 0 then
      raise exception '% 没有要盘的商品（AutoCount 没有库存，货架上也没有）。', loc using errcode = '22023';
    end if;
  elsif v_scope = 'bins' then
    if jsonb_typeof(p->'bins') is distinct from 'array' or jsonb_array_length(p->'bins') = 0 then
      raise exception '请选要盘的货架。' using errcode = '22023';
    end if;
    select array_agg(distinct x::bigint) into v_bins from jsonb_array_elements_text(p->'bins') x where x ~ '^[0-9]{1,12}$';
    select string_agg(a::text, '、') into bad from unnest(v_bins) a
    where not exists (select 1 from ops.wh_bin b where b.id = a and b.company = c and b.location = loc and b.active);
    if bad is not null or coalesce(cardinality(v_bins), 0) = 0 then
      raise exception '选的货架不在 % 或已经停用，请重新选。', loc using errcode = '22023';
    end if;
    select array_agg(distinct st.item_code) into codes from ops.wh_bin_stock st
    where st.bin_id = any(v_bins) and exists (select 1 from bi.dim_item i where i.company = c and i.item_code = st.item_code);
    if coalesce(cardinality(codes), 0) = 0 then
      raise exception '选的货架上还没有记任何商品，请改用「整个仓位」或「贴商品代号」。' using errcode = '22023';
    end if;
  else
    if jsonb_typeof(p->'items') is distinct from 'array' or jsonb_array_length(p->'items') = 0 then
      raise exception '请贴上要盘的商品代号。' using errcode = '22023';
    end if;
    select string_agg(t, '、') into bad from (
      select distinct trim(x) t from jsonb_array_elements_text(p->'items') x
      where trim(x) <> '' and ops.wh_resolve(c, x) is null order by 1 limit 20) y;
    if bad is not null then
      raise exception '找不到这些商品代号：%。请改正后再建。', bad using errcode = 'P0002';
    end if;
    select array_agg(distinct ops.wh_resolve(c, x)) into codes from jsonb_array_elements_text(p->'items') x where trim(x) <> '';
    if coalesce(cardinality(codes), 0) = 0 then
      raise exception '请贴上要盘的商品代号。' using errcode = '22023';
    end if;
  end if;
  if cardinality(codes) > 5000 then
    raise exception '一张盘点单最多 5,000 个商品（这次 % 个），请分成几张。', cardinality(codes) using errcode = '22023';
  end if;

  insert into ops.wh_count_sheet (company, title, location, scope, bins, due_date, note, assignees, created_by)
  values (c, v_title, loc, v_scope, coalesce(v_bins, '{}'), v_due, trim(coalesce(p->>'note', '')), ass, me.id)
  returning * into s;
  insert into ops.wh_count_sheet_line (sheet_id, item_code) select s.id, x from unnest(codes) x;
  perform ops.log(me.id, 'create', 'wh_count_sheet', s.id,
                  jsonb_build_object('title', s.title, 'location', loc, 'scope', v_scope, 'items', cardinality(codes)));
  return ops.wh_sheet_json(s, me);
end $$;

-- 改名称 / 期限 / 备注 / 指派（只限还开着的单）。p: {id, title?, due_date?, note?, assignees?}
create or replace function public.ops_wh_sheet_update(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  s ops.wh_count_sheet;
  v_title text;
  v_due date;
begin
  me := ops.require_level('warehouse', 'approve');
  select * into s from ops.wh_count_sheet where id = nullif(p->>'id', '')::bigint for update;
  if s.id is null or not ops.sees_company(me, s.company) then
    raise exception '找不到这张盘点单。' using errcode = 'P0002';
  end if;
  if s.status <> 'open' then
    raise exception '这张盘点单已经结束了，不能再改。' using errcode = '22023';
  end if;
  v_title := case when p ? 'title' then trim(coalesce(p->>'title', '')) else s.title end;
  if v_title = '' or length(v_title) > 80 then
    raise exception '请填盘点单名称（80 个字以内）。' using errcode = '22023';
  end if;
  v_due := case when p ? 'due_date' then nullif(trim(coalesce(p->>'due_date', '')), '')::date else s.due_date end;
  if v_due is distinct from s.due_date and v_due < ops.today() then
    raise exception '期限不能早于今天。' using errcode = '22023';
  end if;
  if length(coalesce(p->>'note', '')) > 500 then
    raise exception '备注太长（500 个字以内）。' using errcode = '22023';
  end if;
  update ops.wh_count_sheet set
    title = v_title, due_date = v_due,
    note = case when p ? 'note' then trim(coalesce(p->>'note', '')) else note end,
    assignees = case when p ? 'assignees' then ops.wh_sheet_assignees(p->'assignees', s.company) else assignees end
  where id = s.id returning * into s;
  perform ops.log(me.id, 'update', 'wh_count_sheet', s.id, p);
  return ops.wh_sheet_json(s, me);
end $$;

-- 结单（没盘的留着算没盘）
create or replace function public.ops_wh_sheet_close(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  s ops.wh_count_sheet;
begin
  me := ops.require_level('warehouse', 'approve');
  select * into s from ops.wh_count_sheet where id = nullif(p->>'id', '')::bigint for update;
  if s.id is null or not ops.sees_company(me, s.company) then
    raise exception '找不到这张盘点单。' using errcode = 'P0002';
  end if;
  if s.status <> 'open' then
    raise exception '这张盘点单已经结束了。' using errcode = '22023';
  end if;
  update ops.wh_count_sheet set status = 'closed', closed_by = me.id, closed_at = now() where id = s.id returning * into s;
  perform ops.log(me.id, 'close', 'wh_count_sheet', s.id, '{}'::jsonb);
  return ops.wh_sheet_json(s, me);
end $$;

-- 取消（要写原因）：已经盘的照样有效（差异照样在「差异审核」）
create or replace function public.ops_wh_sheet_cancel(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  s ops.wh_count_sheet;
  why text := trim(coalesce(p->>'reason', ''));
begin
  me := ops.require_level('warehouse', 'approve');
  select * into s from ops.wh_count_sheet where id = nullif(p->>'id', '')::bigint for update;
  if s.id is null or not ops.sees_company(me, s.company) then
    raise exception '找不到这张盘点单。' using errcode = 'P0002';
  end if;
  if s.status <> 'open' then
    raise exception '这张盘点单已经结束了。' using errcode = '22023';
  end if;
  if why = '' then
    raise exception '请写取消的原因。' using errcode = '22023';
  end if;
  update ops.wh_count_sheet set status = 'cancelled', closed_by = me.id, closed_at = now(), cancel_reason = left(why, 300)
  where id = s.id returning * into s;
  perform ops.log(me.id, 'cancel', 'wh_count_sheet', s.id, jsonb_build_object('reason', why));
  return ops.wh_sheet_json(s, me);
end $$;

-- ============================================================ 5. 盘点单清单 / 明细 / 首页
-- p: {company, status: open|done|all, mine: bool}；仓库「可编辑」以上。开着的在前：指派给我的 → 期限近的 → 新的；最多 60 张
create or replace function public.ops_wh_sheets(p jsonb default '{}'::jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  c text;
  st text := coalesce(nullif(p->>'status', ''), 'open');
  mine boolean := coalesce((p->>'mine')::boolean, false);
begin
  me := ops.require_level('warehouse', 'edit');
  c := ops.wh_company(me, p->>'company');
  return coalesce((select jsonb_agg(ops.wh_sheet_json(s.sh, me) order by s.o) from (
    select x as sh, row_number() over (order by x.status = 'open' desc, coalesce(me.id = any(x.assignees), false) desc,
                                   case when x.status = 'open' then x.due_date end nulls last, x.created_at desc) o
    from ops.wh_count_sheet x
    where x.company = c
      and (st = 'all' or (st = 'open' and x.status = 'open') or (st = 'done' and x.status <> 'open'))
      and (not mine or coalesce(me.id = any(x.assignees), false))
    order by o limit 60) s), '[]'::jsonb);
end $$;

-- 一张盘点单：摘要 + 每一行（商品、品名、所在货架名、结果、谁盘的）。照货架顺序排（走一圈的顺序），没上货架的排最后。
-- 不给系统数；可审批的人另外看得到盘到几件、应有、差额、成本差额（已盘的行）。p: {id}
create or replace function public.ops_wh_sheet_get(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  s ops.wh_count_sheet;
  full_access boolean;
begin
  me := ops.require_level('warehouse', 'edit');
  select * into s from ops.wh_count_sheet where id = nullif(p->>'id', '')::bigint;
  if s.id is null or not ops.sees_company(me, s.company) then
    raise exception '找不到这张盘点单。' using errcode = 'P0002';
  end if;
  full_access := ops.level_rank(ops.module_level(me, 'warehouse')) >= 3;
  return ops.wh_sheet_json(s, me) || jsonb_build_object(
    'can_manage', full_access and s.status = 'open',
    'lines', coalesce((
      with bo as (
        select b.id, b.code, row_number() over (order by b.sort, b.zone, length(b.shelf), b.shelf, length(b.level), b.level) ord
        from ops.wh_bin b where b.company = s.company and b.location = s.location and b.active),
      x as (select * from ops.wh_sheet_counts(s)),
      lb as (
        select st.item_code, min(bo.ord) ord, jsonb_agg(bo.code order by bo.ord) codes
        from ops.wh_bin_stock st join bo on bo.id = st.bin_id
        where st.company = s.company and st.item_code in (select x.item_code from x)
        group by st.item_code)
      select jsonb_agg(jsonb_build_object(
          'item_code', x.item_code, 'description', i.description, 'uom', i.base_uom,
          'bins', coalesce(lb.codes, '[]'::jsonb), 'status', x.st, 'count_id', x.count_id, 'counted_at', x.counted_at,
          'counted_by_name', (select sf.name from ops.staff sf where sf.id = x.counted_by))
        || case when full_access and x.count_id is not null then
             (select jsonb_build_object('qty', k.qty, 'expected', k.system_qty + k.pending_qty,
                       'diff', k.qty - (k.system_qty + k.pending_qty),
                       'diff_value', round((k.qty - (k.system_qty + k.pending_qty)) * coalesce(k.unit_cost, 0), 2))
              from ops.wh_count k where k.id = x.count_id)
           else '{}'::jsonb end
        order by lb.ord nulls last, x.item_code)
      from x left join lb on lb.item_code = x.item_code
      left join bi.dim_item i on i.company = s.company and i.item_code = x.item_code), '[]'::jsonb));
end $$;

-- 首页提醒：指派给我、还开着的盘点单（剩几项）。没有仓库「可编辑」= 空清单（首页不会因此出错）
create or replace function public.ops_wh_sheet_home() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
begin
  me := ops.require_staff();
  if ops.level_rank(ops.module_level(me, 'warehouse')) < 2 then
    return '[]'::jsonb;
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', y.j->'id', 'company', y.j->'company', 'title', y.j->'title',
                     'location', y.j->'location', 'due_date', y.j->'due_date', 'overdue', y.j->'overdue', 'total', y.j->'total',
                     'left', (y.j->>'todo')::int + (y.j->>'recount')::int) order by s.due_date nulls last, s.created_at)
                   from ops.wh_count_sheet s, lateral (select ops.wh_sheet_json(s, me) j) y
                   where s.status = 'open' and coalesce(me.id = any(s.assignees), false) and ops.sees_company(me, s.company)),
                  '[]'::jsonb);
end $$;

-- ============================================================ 6. 盘点统计（可审批）
-- p: {company, days: 30|90|180, location?}。只算最后定案的（没作废的）盘点；差额 = 实盘 − 应有（应有 = AutoCount + 未输入的搬动）；
-- 金额 = 差额 × 盘点当下的单位成本。差异 = 有差异（含还没再数的）、已调整、不调整。
create or replace function public.ops_wh_count_stats(p jsonb default '{}'::jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  c text;
  d int := coalesce(nullif(p->>'days', '')::int, 30);
  loc text := nullif(trim(coalesce(p->>'location', '')), '');
  td date := ops.today();
begin
  me := ops.require_level('warehouse', 'approve');
  c := ops.wh_company(me, p->>'company');
  if d not in (30, 90, 180) then
    d := 30;
  end if;
  return (
    with k as (
      select x.*, x.qty - (x.system_qty + x.pending_qty) diff,
             round((x.qty - (x.system_qty + x.pending_qty)) * coalesce(x.unit_cost, 0), 2) val,
             x.status in ('variance', 'adjusted', 'ignored') bad
      from ops.wh_count x
      where x.company = c and x.status <> 'superseded' and x.count_date > td - d and (loc is null or x.location = loc)),
    m as (
      select x.*, round((x.qty - (x.system_qty + x.pending_qty)) * coalesce(x.unit_cost, 0), 2) val,
             x.status in ('variance', 'adjusted', 'ignored') bad
      from ops.wh_count x
      where x.company = c and x.status <> 'superseded' and (loc is null or x.location = loc)
        and x.count_date >= (date_trunc('month', td::timestamp) - interval '11 months')::date)
    select jsonb_build_object(
      'company', c, 'days', d, 'location', loc, 'today', td,
      'summary', (select jsonb_build_object(
          'counts', count(*), 'items', count(distinct (k.location, k.item_code)),
          'match', count(*) filter (where k.status = 'match'),
          'variance', count(*) filter (where k.bad),
          'waiting', count(*) filter (where k.status = 'variance'),
          'adjusted', count(*) filter (where k.status = 'adjusted'),
          'ignored', count(*) filter (where k.status = 'ignored'),
          'value_net', coalesce(sum(k.val) filter (where k.bad), 0),
          'value_abs', coalesce(sum(abs(k.val)) filter (where k.bad), 0),
          'sheets', (select count(*) from ops.wh_count_sheet s where s.company = c and (loc is null or s.location = loc)
                       and s.created_at::date > td - d and s.status <> 'cancelled'))
        from k),
      'top', coalesce((select jsonb_agg(jsonb_build_object('item_code', t.item_code, 'description', i.description, 'uom', i.base_uom,
                         'times', t.n, 'units', t.units, 'abs_units', t.abs_units, 'value', t.value, 'abs_value', t.abs_value,
                         'last', t.last) order by t.n desc, t.abs_value desc, t.item_code)
                       from (select k.item_code, count(*) n, sum(k.diff) units, sum(abs(k.diff)) abs_units, sum(k.val) value,
                                    sum(abs(k.val)) abs_value, max(k.count_date) last
                             from k where k.bad group by k.item_code
                             order by count(*) desc, sum(abs(k.val)) desc, k.item_code limit 20) t
                       left join bi.dim_item i on i.company = c and i.item_code = t.item_code), '[]'::jsonb),
      'people', coalesce((select jsonb_agg(jsonb_build_object('id', g.counted_by, 'name', st.name, 'counts', g.n,
                            'variance', g.nv, 'value_abs', g.va) order by g.n desc, st.name)
                          from (select k.counted_by, count(*) n, count(*) filter (where k.bad) nv,
                                       coalesce(sum(abs(k.val)) filter (where k.bad), 0) va
                                from k group by k.counted_by) g
                          join ops.staff st on st.id = g.counted_by), '[]'::jsonb),
      'months', coalesce((select jsonb_agg(jsonb_build_object('month', g.mo, 'counts', g.n, 'variance', g.nv,
                            'value_net', g.vn, 'value_abs', g.va) order by g.mo)
                          from (select to_char(m.count_date, 'YYYY-MM') mo, count(*) n, count(*) filter (where m.bad) nv,
                                       coalesce(sum(m.val) filter (where m.bad), 0) vn,
                                       coalesce(sum(abs(m.val)) filter (where m.bad), 0) va
                                from m group by 1) g), '[]'::jsonb)));
end $$;

-- ============================================================ 7. 权限
revoke all on function ops.wh_sheet_eligible(ops.staff, text) from public, anon, authenticated;
revoke all on function ops.wh_sheet_counts(ops.wh_count_sheet) from public, anon, authenticated;
revoke all on function ops.wh_sheet_json(ops.wh_count_sheet, ops.staff) from public, anon, authenticated;
revoke all on function ops.wh_count_json(ops.wh_count, boolean) from public, anon, authenticated;
revoke all on function ops.wh_sheet_assignees(jsonb, text) from public, anon, authenticated;
do $$
declare
  f text;
begin
  foreach f in array array['ops_wh_count_bins(jsonb)', 'ops_wh_count_save_bins(jsonb)', 'ops_wh_sheet_staff(text)',
                           'ops_wh_sheet_create(jsonb)', 'ops_wh_sheet_update(jsonb)', 'ops_wh_sheet_close(jsonb)',
                           'ops_wh_sheet_cancel(jsonb)', 'ops_wh_sheets(jsonb)', 'ops_wh_sheet_get(jsonb)',
                           'ops_wh_sheet_home()', 'ops_wh_count_stats(jsonb)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
