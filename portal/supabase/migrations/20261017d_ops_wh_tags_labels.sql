-- HomeWorks 营运系统 — 仓库：商品标签、商品照片、入库箱贴（批次）、打印纪录、库存总表的标签筛选与下载 Excel
-- （2026-10-15，使用者看了员工做的 WMS 后选的）
--   · 标签：系统自动标「畅销」（近 90 天销量在这间公司前 5% 而且 ≥ 10 件）与「滞销」（与「滞销品」页同一条规则：最后进货满 6 个月还有库存），
--     手动标「清货」与自订标签（订货「可编辑」或仓库「可审批」）。自动标签每次现算，不存。
--   · 商品照片：Storage 私有 bucket ops-wh，路径 items/<公司>/<商品代号>/<随机>.jpg；读 = 仓库「只看」以上，拍 / 换 = 仓库「可编辑」。
--   · 入库箱贴：点货后（或手动）建批次 ops.wh_lot（批次号 L + 马来西亚日期 YYMMDD + - + 当天流水 4 位），印箱贴（大箱 100×60mm / 小箱 50×30mm，
--     有商品条码与 QR），QR = 营运系统的批次页（#/warehouse/lot/<批次号>），所以扫码要先登入。厂家 DO 号只给看得到厂家的人。
--   · 打印纪录 ops.wh_label_print：商品条码 / 箱贴 / 货架标签每印一次记一笔，可搜寻、补印。
--   · 库存总表：可按标签筛选、每列带标签；下载 Excel（同样筛选、全部列、最多 50,000 列；成本只给仓库「可审批」）。
-- 对 AutoCount 仍是只读。这个档案不含删除指令（Supabase MCP 会挡）：拿掉标签 = wh_item_tag.active = false；换照片 = 旧的 active = false。
-- 正式环境照「-- ====」分段套用（每段 ≤ 24 KB）；全部 create … if not exists / create or replace，可重跑。

-- ==================================================================== 1. 资料表
create table if not exists ops.wh_tag (
  name text primary key check (name = btrim(name) and length(name) between 1 and 10),
  color text not null default 'gray' check (color in ('red', 'amber', 'green', 'blue', 'purple', 'gray')),
  kind text not null default 'manual' check (kind in ('manual', 'auto')),
  rule text check (rule in ('hot', 'slow')),             -- 自动标签的规则：hot = 畅销、slow = 滞销
  active boolean not null default true,                  -- 停用 = 不显示、不能再标
  sort int not null default 100,
  created_by bigint references ops.staff(id),
  created_at timestamptz not null default now(),
  check ((kind = 'auto') = (rule is not null))
);
create unique index if not exists wh_tag_rule_uq on ops.wh_tag (rule) where rule is not null;
insert into ops.wh_tag (name, color, kind, rule, sort) values
  ('清货', 'red', 'manual', null, 10), ('畅销', 'green', 'auto', 'hot', 20), ('滞销', 'gray', 'auto', 'slow', 30)
on conflict (name) do nothing;

-- 手动标签（自动标签不存）。拿掉 = active false（不删，留纪录）
create table if not exists ops.wh_item_tag (
  company text not null check (company in ('HOMEWORKSSB', 'HOMEWORKSSOUTHERN')),
  item_code text not null,
  tag text not null references ops.wh_tag(name),
  active boolean not null default true,
  created_by bigint references ops.staff(id),
  created_at timestamptz not null default now(),
  removed_by bigint references ops.staff(id),
  removed_at timestamptz,
  primary key (company, item_code, tag)
);
create index if not exists wh_item_tag_tag_idx on ops.wh_item_tag (company, tag) where active;

-- 商品照片：一个商品一张有效的（换照片 = 旧的 active false）
create table if not exists ops.wh_item_photo (
  id bigint generated always as identity primary key,
  company text not null check (company in ('HOMEWORKSSB', 'HOMEWORKSSOUTHERN')),
  item_code text not null,
  path text not null unique,                             -- Storage bucket ops-wh
  active boolean not null default true,
  created_by bigint references ops.staff(id),
  created_at timestamptz not null default now()
);
create unique index if not exists wh_item_photo_cur_uq on ops.wh_item_photo (company, item_code) where active;

-- 批次号的当天流水（马来西亚日期）
create table if not exists ops.wh_lot_seq (day date primary key, n int not null default 0);

-- 批次（一批进货 = 一张箱贴的内容；箱贴上的 QR 指到这里）
create table if not exists ops.wh_lot (
  lot_no text primary key check (lot_no ~ '^L[0-9]{6}-[0-9]{4,}$'),
  company text not null check (company in ('HOMEWORKSSB', 'HOMEWORKSSOUTHERN')),
  item_code text not null,
  qty numeric(12,2) not null check (qty > 0),
  boxes int not null default 1 check (boxes between 1 and 999),
  outlet text references ops.outlet(code),               -- 给哪间分店（空 = 没指定，例：来错的货）
  location text,                                         -- 进哪个仓位（点货的进货 = 那笔进货的仓位）
  move_id bigint references ops.wh_move(id),             -- 点货产生的进货（kind = receive）
  do_id bigint references ops.supplier_do(id),
  received_at timestamptz,                               -- 点货时间（手动建 = 建的时间）
  received_by bigint references ops.staff(id),
  note text not null default '' check (length(note) <= 200),
  created_by bigint references ops.staff(id),
  created_at timestamptz not null default now()
);
create unique index if not exists wh_lot_move_uq on ops.wh_lot (move_id) where move_id is not null;
create index if not exists wh_lot_item_idx on ops.wh_lot (company, item_code, created_at desc);

-- 打印纪录：lot = 箱贴、item = 商品条码、bin = 货架标签
create table if not exists ops.wh_label_print (
  id bigint generated always as identity primary key,
  company text not null check (company in ('HOMEWORKSSB', 'HOMEWORKSSOUTHERN')),
  kind text not null check (kind in ('lot', 'item', 'bin')),
  lot_no text references ops.wh_lot(lot_no),
  item_code text check (length(item_code) <= 60),
  bin_id bigint references ops.wh_bin(id),
  copies int not null check (copies between 1 and 2000),
  size text not null default '' check (length(size) <= 30),
  created_by bigint references ops.staff(id),
  created_at timestamptz not null default now(),
  check ((kind = 'lot') = (lot_no is not null)),
  check (kind <> 'bin' or bin_id is not null),
  check (kind <> 'item' or item_code is not null)
);
create index if not exists wh_label_print_idx on ops.wh_label_print (company, created_at desc);
create index if not exists wh_label_print_lot_idx on ops.wh_label_print (lot_no) where lot_no is not null;

alter table ops.wh_tag enable row level security;
alter table ops.wh_item_tag enable row level security;
alter table ops.wh_item_photo enable row level security;
alter table ops.wh_lot_seq enable row level security;
alter table ops.wh_lot enable row level security;
alter table ops.wh_label_print enable row level security;

-- ==================================================================== 2. 标签
-- 谁能标 / 建标签：订货「可编辑」（采购、管理层）或仓库「可审批」（仓库主管）
create or replace function ops.wh_can_tag(p_staff ops.staff) returns boolean
language sql stable set search_path = '' as $$
  select coalesce(p_staff.id is not null and (ops.level_rank(ops.module_level(p_staff, 'purchasing')) >= 2
                  or ops.level_rank(ops.module_level(p_staff, 'warehouse')) >= 3), false)
$$;

-- 畅销：近 90 天销量（bi.mv_purchase_sold.q90，与补货建议同一个数）在这间公司排前 5%（至少 1 名，同数并列都算）而且 ≥ 10 件
create or replace function ops.wh_hot_items(p_company text) returns setof text
language sql stable security definer set search_path = '' as $$
  select r.item_code from (
    select m.item_code::text item_code, m.q90, rank() over (order by m.q90 desc) rk, count(*) over () n
    from bi.mv_purchase_sold m where m.company = p_company and m.q90 > 0) r
  where r.q90 >= 10 and r.rk <= greatest(1, ceil(r.n * 0.05))
$$;

-- 滞销：与「滞销品」页（ops_wh_slow）同一条规则：最后进货满 6 个月、还有库存（bi.fact_item_aging）
create or replace function ops.wh_slow_items(p_company text) returns setof text
language sql stable security definer set search_path = '' as $$
  select a.item_code::text from bi.fact_item_aging a
  where a.company = p_company and a.on_hand > 0 and a.last_receipt_date is not null
    and (extract(year from age(ops.today(), a.last_receipt_date)) * 12
         + extract(month from age(ops.today(), a.last_receipt_date))) >= 6
$$;

-- 有某个标签的商品（手动 + 自动；停用的标签没有商品）
create or replace function ops.wh_tag_items(p_company text, p_tag text) returns setof text
language sql stable security definer set search_path = '' as $$
  select it.item_code from ops.wh_item_tag it join ops.wh_tag g on g.name = it.tag and g.active and g.kind = 'manual'
  where it.company = p_company and it.tag = p_tag and it.active
  union
  select x from ops.wh_hot_items(p_company) h(x)
  where exists (select 1 from ops.wh_tag g where g.name = p_tag and g.active and g.rule = 'hot')
  union
  select x from ops.wh_slow_items(p_company) s(x)
  where exists (select 1 from ops.wh_tag g where g.name = p_tag and g.active and g.rule = 'slow')
$$;

-- 一批商品的标签（手动 + 自动，照标签顺序）：{"ST003": ["清货", "畅销"], …}；没有标签的商品不出现
create or replace function ops.wh_item_tags(p_company text, p_codes text[]) returns jsonb
language sql stable security definer set search_path = '' as $$
  with t as (
    select it.item_code, it.tag from ops.wh_item_tag it join ops.wh_tag g on g.name = it.tag and g.kind = 'manual'
    where it.company = p_company and it.active and it.item_code = any (p_codes)
    union
    select x, (select g.name from ops.wh_tag g where g.rule = 'hot') from ops.wh_hot_items(p_company) h(x) where x = any (p_codes)
    union
    select x, (select g.name from ops.wh_tag g where g.rule = 'slow') from ops.wh_slow_items(p_company) s(x) where x = any (p_codes))
  select coalesce(jsonb_object_agg(z.item_code, z.tags), '{}'::jsonb)
  from (select t.item_code, jsonb_agg(g.name order by g.sort, g.name) tags
        from t join ops.wh_tag g on g.name = t.tag and g.active group by t.item_code) z
$$;

-- 标签清单（仓库「只看」以上）：每个标签在这间分店有几个商品；can_edit = 能不能标 / 建标签。p: {company}
create or replace function public.ops_wh_tags(p jsonb default '{}'::jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  c text;
begin
  me := ops.require_level('warehouse', 'view');
  c := ops.wh_company(me, p->>'company');
  return jsonb_build_object('company', c, 'can_edit', ops.wh_can_tag(me),
    'tags', coalesce((
      select jsonb_agg(jsonb_build_object('name', g.name, 'color', g.color, 'kind', g.kind, 'rule', g.rule,
          'active', g.active, 'sort', g.sort,
          'items', case when not g.active then 0
                        when g.kind = 'manual' then (select count(*) from ops.wh_item_tag it
                                                     where it.company = c and it.tag = g.name and it.active)
                        else (select count(*) from ops.wh_tag_items(c, g.name)) end)
        order by g.sort, g.name)
      from ops.wh_tag g), '[]'::jsonb));
end $$;

-- 建 / 改标签（订货「可编辑」或仓库「可审批」）。p: {name, color, active, sort}
-- 新标签都是手动标签；自动标签（畅销 / 滞销）只能改颜色、顺序、停用。名称不能改（要改名 = 建新的、旧的停用）。
create or replace function public.ops_wh_tag_save(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  g ops.wh_tag;
  v_name text := btrim(coalesce(p->>'name', ''));
  v_color text := nullif(btrim(coalesce(p->>'color', '')), '');
begin
  me := ops.require_level('warehouse', 'view');
  if not ops.wh_can_tag(me) then
    raise exception '标商品标签要订货「可编辑」或仓库「可审批」，请找管理员开通。' using errcode = '42501';
  end if;
  if v_name = '' then
    raise exception '请填标签名称。' using errcode = '22023';
  end if;
  if length(v_name) > 10 then
    raise exception '标签名称最多 10 个字。' using errcode = '22023';
  end if;
  if v_color is not null and v_color not in ('red', 'amber', 'green', 'blue', 'purple', 'gray') then
    raise exception '颜色不对，请重新选。' using errcode = '22023';
  end if;
  select * into g from ops.wh_tag where name = v_name for update;
  if g.name is null then
    if (select count(*) from ops.wh_tag) >= 50 then
      raise exception '标签最多 50 个，请先停用用不到的。' using errcode = '22023';
    end if;
    insert into ops.wh_tag (name, color, kind, rule, active, sort, created_by)
    values (v_name, coalesce(v_color, 'gray'), 'manual', null, coalesce((p->>'active')::boolean, true),
            coalesce(nullif(p->>'sort', '')::int, (select coalesce(max(x.sort), 0) + 10 from ops.wh_tag x)), me.id)
    returning * into g;
  else
    update ops.wh_tag set color = coalesce(v_color, color), active = coalesce((p->>'active')::boolean, active),
      sort = coalesce(nullif(p->>'sort', '')::int, sort)
    where name = g.name returning * into g;
  end if;
  perform ops.log(me.id, 'save', 'wh_tag', null, to_jsonb(g));
  return jsonb_build_object('name', g.name, 'color', g.color, 'kind', g.kind, 'rule', g.rule, 'active', g.active, 'sort', g.sort);
end $$;

-- 商品标上 / 拿掉手动标签。p: {company, items: [商品代号 / 纸箱条码…]（或 item）, tag, on: true / false}
-- 回传 {changed, tags: {商品: [标签…]}}
create or replace function public.ops_wh_item_tag_set(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  c text;
  g ops.wh_tag;
  v_on boolean := coalesce((p->>'on')::boolean, true);
  codes text[];
  done text[] := '{}';
  x text;
  v_item text;
  n int := 0;
  k int;
begin
  me := ops.require_level('warehouse', 'view');
  if not ops.wh_can_tag(me) then
    raise exception '标商品标签要订货「可编辑」或仓库「可审批」，请找管理员开通。' using errcode = '42501';
  end if;
  c := ops.wh_company(me, p->>'company');
  select * into g from ops.wh_tag where name = btrim(coalesce(p->>'tag', ''));
  if g.name is null then
    raise exception '没有这个标签。' using errcode = 'P0002';
  end if;
  if g.kind = 'auto' then
    raise exception '「%」是系统照销量 / 最后进货日自动标的，不能手动标或拿掉。', g.name using errcode = '22023';
  end if;
  if v_on and not g.active then
    raise exception '标签「%」已经停用。', g.name using errcode = '22023';
  end if;
  codes := case when jsonb_typeof(p->'items') = 'array' then array(select jsonb_array_elements_text(p->'items'))
                else array[p->>'item'] end;
  if coalesce(array_length(codes, 1), 0) = 0 or codes[1] is null then
    raise exception '请选商品。' using errcode = '22023';
  end if;
  if array_length(codes, 1) > 500 then
    raise exception '一次最多 500 个商品。' using errcode = '22023';
  end if;
  foreach x in array codes loop
    v_item := ops.wh_resolve(c, x);
    if v_item is null then
      raise exception '找不到商品「%」。', x using errcode = 'P0002';
    end if;
    if v_on then
      insert into ops.wh_item_tag (company, item_code, tag, created_by)
      values (c, v_item, g.name, me.id)
      on conflict (company, item_code, tag) do update
        set active = true, created_by = excluded.created_by, created_at = now(), removed_by = null, removed_at = null
        where not ops.wh_item_tag.active;
    else
      update ops.wh_item_tag set active = false, removed_by = me.id, removed_at = now()
      where company = c and item_code = v_item and tag = g.name and active;
    end if;
    get diagnostics k = row_count;
    n := n + k;
    done := done || v_item;
  end loop;
  perform ops.log(me.id, case when v_on then 'tag' else 'untag' end, 'wh_item_tag', null,
                  jsonb_build_object('company', c, 'tag', g.name, 'items', to_jsonb(done)));
  return jsonb_build_object('changed', n, 'tags', ops.wh_item_tags(c, done));
end $$;

-- 一批商品的标签（查货卡片、批次页用）。p: {company, items: [...]} → {商品: [标签…]}
create or replace function public.ops_wh_item_tags(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  c text;
  codes text[];
begin
  me := ops.require_level('warehouse', 'view');
  c := ops.wh_company(me, p->>'company');
  codes := case when jsonb_typeof(p->'items') = 'array' then array(select jsonb_array_elements_text(p->'items')) else '{}' end;
  if coalesce(array_length(codes, 1), 0) > 2000 then
    raise exception '一次最多 2,000 个商品。' using errcode = '22023';
  end if;
  return ops.wh_item_tags(c, codes);
end $$;

-- ==================================================================== 3. 库存总表：标签筛选、每列标签、下载 Excel
-- 筛选后的库存行（库存总表、下载共用）。p_tag 空 = 不筛
create or replace function ops.wh_stock_filter(p_company text, p_q text, p_neg boolean, p_tag text)
returns table (item_code text, location text, qty numeric, total_cost numeric)
language sql stable security definer set search_path = '' as $$
  select s.item_code::text, s.location::text, s.qty::numeric, s.total_cost::numeric
  from bi.fact_stock s left join bi.dim_item i on i.company = s.company and i.item_code = s.item_code
  where s.company = p_company and (not p_neg or s.qty < 0)
    and (p_q = '' or s.item_code ilike '%' || p_q || '%' or coalesce(i.description, '') ilike '%' || p_q || '%')
    and (p_tag is null or s.item_code in (select x from ops.wh_tag_items(p_company, p_tag) t(x)))
$$;

-- 库存总表（照抄 20261016c_ops_bi_pages_fix.sql，多 tag 筛选与每列 tags）：p = {company, q, neg_only, tag, page}
create or replace function public.ops_wh_stock(p jsonb default '{}'::jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  c text;
  q text := trim(coalesce(p->>'q', ''));
  neg boolean := coalesce((p->>'neg_only')::boolean, false);
  tg text := nullif(btrim(coalesce(p->>'tag', '')), '');
  pg int := greatest(0, coalesce(nullif(p->>'page', '')::int, 0));
  size int := 100;
  cost boolean;
  total bigint;
  neg_total bigint;
  rows jsonb;
  tmap jsonb;
begin
  me := ops.require_level('warehouse', 'view');
  c := ops.wh_company(me, p->>'company');
  cost := ops.level_rank(ops.module_level(me, 'warehouse')) >= 3;
  select count(*), count(*) filter (where f.qty < 0) into total, neg_total from ops.wh_stock_filter(c, q, neg, tg) f;
  select coalesce(jsonb_agg(jsonb_build_object(
      'item_code', s.item_code, 'description', coalesce(i.description, s.item_code), 'item_group', i.item_group,
      'uom', i.base_uom, 'location', s.location, 'qty', s.qty,
      -- 商品合计：这个商品所有仓位（不受负库存 / 标签筛选、分页影响）
      'item_total', (select sum(t.qty) from bi.fact_stock t where t.company = c and t.item_code = s.item_code),
      'total_cost', case when cost then s.total_cost end,
      'price2', i.price2, 'price3', i.price3, 'price4', i.price4)
      order by s.item_code, s.location), '[]'::jsonb)
  into rows
  from (select f.* from ops.wh_stock_filter(c, q, neg, tg) f order by f.item_code, f.location offset pg * size limit size) s
  left join bi.dim_item i on i.company = c and i.item_code = s.item_code;
  tmap := ops.wh_item_tags(c, array(select distinct x->>'item_code' from jsonb_array_elements(rows) x));
  return jsonb_build_object(
    'company', c, 'show_cost', cost, 'page', pg, 'page_size', size, 'total', total, 'neg_total', neg_total, 'tag', tg,
    'synced_at', ops.wh_synced_at(c),
    'rows', coalesce((select jsonb_agg(x || jsonb_build_object('tags', coalesce(tmap -> (x->>'item_code'), '[]'::jsonb)) order by o)
                      from jsonb_array_elements(rows) with ordinality r(x, o)), '[]'::jsonb));
end $$;

-- 下载 Excel：同样的筛选、全部列（最多 50,000 列，超过回 capped）；成本只给仓库「可审批」。
-- 会记一笔 audit_log（谁下载了什么），所以不能宣告 stable（PostgREST 会用唯读交易跑 stable 函数）
create or replace function public.ops_wh_stock_export(p jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  c text;
  q text := trim(coalesce(p->>'q', ''));
  neg boolean := coalesce((p->>'neg_only')::boolean, false);
  tg text := nullif(btrim(coalesce(p->>'tag', '')), '');
  cap int := 50000;
  cost boolean;
  total bigint;
  rows jsonb;
  tmap jsonb;
begin
  me := ops.require_level('warehouse', 'view');
  c := ops.wh_company(me, p->>'company');
  cost := ops.level_rank(ops.module_level(me, 'warehouse')) >= 3;
  select count(*) into total from ops.wh_stock_filter(c, q, neg, tg);
  with tot as (select t.item_code, sum(t.qty) q from bi.fact_stock t where t.company = c group by 1)
  select coalesce(jsonb_agg(jsonb_build_object(
      'item_code', s.item_code, 'description', coalesce(i.description, s.item_code), 'item_group', i.item_group,
      'uom', i.base_uom, 'location', s.location, 'qty', s.qty, 'item_total', tot.q,
      'total_cost', case when cost then s.total_cost end,
      'price2', i.price2, 'price3', i.price3, 'price4', i.price4)
      order by s.item_code, s.location), '[]'::jsonb)
  into rows
  from (select f.* from ops.wh_stock_filter(c, q, neg, tg) f order by f.item_code, f.location limit cap) s
  left join bi.dim_item i on i.company = c and i.item_code = s.item_code
  left join tot on tot.item_code = s.item_code;
  tmap := ops.wh_item_tags(c, array(select distinct x->>'item_code' from jsonb_array_elements(rows) x));
  perform ops.log(me.id, 'export', 'wh_stock', null, jsonb_build_object('company', c, 'q', q, 'neg_only', neg, 'tag', tg, 'rows', total));
  return jsonb_build_object(
    'company', c, 'show_cost', cost, 'total', total, 'capped', total > cap, 'tag', tg, 'synced_at', ops.wh_synced_at(c),
    'rows', coalesce((select jsonb_agg(x || jsonb_build_object('tags', coalesce(tmap -> (x->>'item_code'), '[]'::jsonb)) order by o)
                      from jsonb_array_elements(rows) with ordinality r(x, o)), '[]'::jsonb));
end $$;

-- ==================================================================== 4. 商品照片（Storage 私有 bucket ops-wh）
-- 路径：items/<公司>/<商品代号（英数字 . _ - 以外换成 _）>/<随机>.jpg
create or replace function ops.wh_photo_dir(p_company text, p_item text) returns text
language sql immutable set search_path = '' as $$
  select 'items/' || p_company || '/' || regexp_replace(p_item, '[^A-Za-z0-9._-]', '_', 'g') || '/'
$$;

-- Storage policy 呼叫：读 = 仓库「只看」以上、看得到那间分店；写 = 仓库「可编辑」以上（p_write 空当成写）
create or replace function public.ops_wh_file_ok(p_name text, p_write boolean) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff := ops.current_staff();
  c text := split_part(coalesce(p_name, ''), '/', 2);
begin
  return coalesce(me.id is not null and split_part(coalesce(p_name, ''), '/', 1) = 'items'
                  and c in ('HOMEWORKSSB', 'HOMEWORKSSOUTHERN') and ops.sees_company(me, c)
                  and ops.level_rank(ops.module_level(me, 'warehouse')) >= case when coalesce(p_write, true) then 2 else 1 end,
                  false);
end $$;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('ops-wh', 'ops-wh', false, 3145728, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
                                             and policyname = 'ops-wh read') then
    create policy "ops-wh read" on storage.objects for select to authenticated
      using (bucket_id = 'ops-wh' and public.ops_wh_file_ok(name, false));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
                                             and policyname = 'ops-wh insert') then
    create policy "ops-wh insert" on storage.objects for insert to authenticated
      with check (bucket_id = 'ops-wh' and public.ops_wh_file_ok(name, true));
  end if;
end $$;

create or replace function ops.wh_photo_json(f ops.wh_item_photo) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', f.id, 'item_code', f.item_code, 'path', f.path, 'created_at', f.created_at,
    'by_name', (select s.name from ops.staff s where s.id = f.created_by))
$$;

-- 存 / 换 / 拿掉商品照片（仓库「可编辑」）。照片先上传到 ops-wh（路径照 ops.wh_photo_dir），这里检查档案真的在；旧照片 active = false。
-- p: {company, item, path}；拿掉：{company, item, remove: true}
create or replace function public.ops_wh_item_photo_set(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  c text;
  v_item text;
  v_path text := btrim(coalesce(p->>'path', ''));
  dir text;
  f ops.wh_item_photo;
begin
  me := ops.require_level('warehouse', 'edit');
  c := ops.wh_company(me, p->>'company');
  v_item := ops.wh_resolve(c, p->>'item');
  if v_item is null then
    raise exception '找不到这个商品，请重新扫或打商品代号。' using errcode = 'P0002';
  end if;
  if coalesce((p->>'remove')::boolean, false) then
    update ops.wh_item_photo set active = false where company = c and item_code = v_item and active;
    perform ops.log(me.id, 'remove', 'wh_item_photo', null, jsonb_build_object('company', c, 'item_code', v_item));
    return jsonb_build_object('item_code', v_item, 'photo', null);
  end if;
  dir := ops.wh_photo_dir(c, v_item);
  if left(v_path, length(dir)) <> dir or length(v_path) <= length(dir) or length(v_path) > 300
     or not exists (select 1 from storage.objects o where o.bucket_id = 'ops-wh' and o.name = v_path) then
    raise exception '照片还没上传成功，请再拍一次。' using errcode = '22023';
  end if;
  select * into f from ops.wh_item_photo where path = v_path;
  if f.id is null then
    update ops.wh_item_photo set active = false where company = c and item_code = v_item and active;
    insert into ops.wh_item_photo (company, item_code, path, created_by) values (c, v_item, v_path, me.id) returning * into f;
    perform ops.log(me.id, 'create', 'wh_item_photo', f.id, jsonb_build_object('company', c, 'item_code', v_item, 'path', v_path));
  end if;
  return jsonb_build_object('item_code', v_item, 'photo', case when f.active then ops.wh_photo_json(f) end);
end $$;

-- 一批商品目前的照片（仓库「只看」以上）：{"ST003": {path, by_name, created_at}}
create or replace function public.ops_wh_item_photos(p_company text, p_codes text[]) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  c text;
begin
  me := ops.require_level('warehouse', 'view');
  c := ops.wh_company(me, p_company);
  if coalesce(array_length(p_codes, 1), 0) > 500 then
    raise exception '一次最多 500 个商品。' using errcode = '22023';
  end if;
  return coalesce((select jsonb_object_agg(f.item_code, ops.wh_photo_json(f))
                   from ops.wh_item_photo f where f.company = c and f.active and f.item_code = any (coalesce(p_codes, '{}'))),
                  '{}'::jsonb);
end $$;

-- ==================================================================== 5. 入库箱贴：批次
-- 谁能建批次（印箱贴）：仓库或订货「可编辑」
create or replace function ops.wh_can_lot(p_staff ops.staff) returns boolean
language sql stable set search_path = '' as $$
  select coalesce(p_staff.id is not null and (ops.level_rank(ops.module_level(p_staff, 'warehouse')) >= 2
                  or ops.level_rank(ops.module_level(p_staff, 'purchasing')) >= 2), false)
$$;

-- 下一个批次号：L + 今天（马来西亚）YYMMDD + - + 当天流水（4 位，超过 9999 照实多位）
create or replace function ops.wh_lot_next() returns text
language plpgsql security definer set search_path = '' as $$
declare
  d date := ops.today();
  v_n int;
begin
  insert into ops.wh_lot_seq as s (day, n) values (d, 1)
  on conflict (day) do update set n = s.n + 1
  returning s.n into v_n;
  return 'L' || to_char(d, 'YYMMDD') || '-' || case when v_n < 10000 then lpad(v_n::text, 4, '0') else v_n::text end;
end $$;

-- 这个商品在这个仓位的货架：有货的在前（多的先），0 = 平常放这里
create or replace function ops.wh_lot_bins(p_company text, p_item text, p_loc text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'code', b.code, 'barcode', 'BIN:' || b.id, 'qty', s.qty)
                            order by s.qty desc, b.sort, b.code), '[]'::jsonb)
  from ops.wh_bin_stock s join ops.wh_bin b on b.id = s.bin_id
  where s.company = p_company and s.item_code = p_item and b.location = p_loc and b.active
$$;

-- 批次（箱贴内容）。厂家 / 厂家 DO 号 / PO 号只给看得到厂家的人（ops.sees_supplier）
create or replace function ops.wh_lot_json(p_me ops.staff, l ops.wh_lot) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'lot_no', l.lot_no, 'company', l.company, 'item_code', l.item_code,
    'description', coalesce(i.description, l.item_code), 'uom', i.base_uom,
    'qty', l.qty, 'boxes', l.boxes, 'outlet', l.outlet,
    'outlet_name', (select coalesce(nullif(o.short_name, ''), o.name) from ops.outlet o where o.code = l.outlet),
    'location', l.location, 'move_id', l.move_id, 'do_id', l.do_id, 'note', l.note,
    'received_at', l.received_at, 'received_by_name', (select s.name from ops.staff s where s.id = l.received_by),
    'created_at', l.created_at, 'created_by_name', (select s.name from ops.staff s where s.id = l.created_by),
    'do_no', case when ops.sees_supplier(p_me) then nullif(d.do_no, '') end,
    'supplier_name', case when ops.sees_supplier(p_me) then nullif(d.supplier_name, '') end,
    'po_no', case when ops.sees_supplier(p_me) then m.po_no end,
    -- 建议货架：这个商品在这个仓位数量最多的货架（没有就是平常放的）
    'bin', (select b.code from ops.wh_bin_stock s join ops.wh_bin b on b.id = s.bin_id
            where s.company = l.company and s.item_code = l.item_code and b.location = l.location and b.active
            order by s.qty desc, b.sort, b.code limit 1),
    'printed', (select coalesce(sum(x.copies), 0) from ops.wh_label_print x where x.lot_no = l.lot_no))
  from (select 1) one
  left join bi.dim_item i on i.company = l.company and i.item_code = l.item_code
  left join ops.supplier_do d on d.id = l.do_id
  left join ops.wh_move m on m.id = l.move_id
$$;

-- 建批次（仓库或订货「可编辑」）。p: {company, lots: [{move_id, boxes} 或 {item, qty, location, outlet?, boxes, note?}]}
-- 从点货的进货（kind = receive）建：商品、数量、分店、仓位、厂家到货、点货时间 / 人照那笔进货；同一笔进货只有一个批次
-- （再建 = 改箱数、回传原来的批次）。手动：商品 + 数量 + 仓位（分店可空）。一行错整批不存。回传 {lots: [...]}
create or replace function public.ops_wh_lot_create(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  c text;
  o jsonb;
  i int := 0;
  many boolean;
  m ops.wh_move;
  d ops.supplier_do;
  l ops.wh_lot;
  v_item text;
  v_qty numeric;
  v_boxes int;
  v_loc text;
  v_outlet text;
  res jsonb := '[]'::jsonb;
begin
  me := ops.require_level('warehouse', 'view');
  if not ops.wh_can_lot(me) then
    raise exception '印箱贴要仓库或订货「可编辑」，请找管理员开通。' using errcode = '42501';
  end if;
  c := ops.wh_company(me, p->>'company');
  if jsonb_typeof(p->'lots') is distinct from 'array' or jsonb_array_length(p->'lots') = 0 then
    raise exception '请先勾选要印箱贴的进货。' using errcode = '22023';
  end if;
  if jsonb_array_length(p->'lots') > 200 then
    raise exception '一次最多 200 个批次。' using errcode = '22023';
  end if;
  many := jsonb_array_length(p->'lots') > 1;
  for o in select x from jsonb_array_elements(p->'lots') x loop
    i := i + 1;
    begin
      m := null; d := null; l := null;
      if btrim(coalesce(o->>'boxes', '')) !~ '^[0-9]{0,4}$' then
        raise exception '箱数要 1 到 999。' using errcode = '22023';
      end if;
      v_boxes := coalesce(nullif(btrim(coalesce(o->>'boxes', '')), '')::int, 1);
      if v_boxes < 1 or v_boxes > 999 then
        raise exception '箱数要 1 到 999。' using errcode = '22023';
      end if;
      if nullif(o->>'move_id', '') is not null then
        if o->>'move_id' !~ '^[0-9]{1,12}$' then
          raise exception '找不到这笔进货。' using errcode = 'P0002';
        end if;
        select * into m from ops.wh_move x where x.id = (o->>'move_id')::bigint and x.company = c;
        if m.id is null or m.kind <> 'receive' then
          raise exception '找不到这笔进货。' using errcode = 'P0002';
        end if;
        if m.status = 'cancelled' then
          raise exception '这笔进货（%）已经取消，不能印箱贴。', m.item_code using errcode = '22023';
        end if;
        select * into l from ops.wh_lot x where x.move_id = m.id for update;
        if l.lot_no is not null then
          update ops.wh_lot set boxes = v_boxes where lot_no = l.lot_no returning * into l;
        else
          select * into d from ops.supplier_do x where x.id = m.do_id;
          insert into ops.wh_lot (lot_no, company, item_code, qty, boxes, outlet, location, move_id, do_id,
                                  received_at, received_by, note, created_by)
          values (ops.wh_lot_next(), c, m.item_code, m.qty, v_boxes, m.outlet, m.to_loc, m.id, m.do_id,
                  coalesce(d.arrived_at, m.created_at), coalesce(d.arrived_by, m.created_by),
                  left(btrim(coalesce(o->>'note', '')), 200), me.id)
          returning * into l;
        end if;
      else
        v_item := ops.wh_resolve(c, o->>'item');
        if v_item is null then
          raise exception '找不到商品「%」，请重新扫或打商品代号。', coalesce(o->>'item', '') using errcode = 'P0002';
        end if;
        if btrim(coalesce(o->>'qty', '')) !~ '^[0-9]{1,9}(\.[0-9]{1,2})?$' then
          raise exception '请填数量。' using errcode = '22023';
        end if;
        v_qty := btrim(o->>'qty')::numeric;
        if v_qty <= 0 then
          raise exception '请填数量。' using errcode = '22023';
        end if;
        v_loc := btrim(coalesce(o->>'location', ''));
        if not exists (select 1 from ops.wh_location x where x.company = c and x.code = v_loc) then
          raise exception '请选仓位。' using errcode = '22023';
        end if;
        v_outlet := nullif(btrim(coalesce(o->>'outlet', '')), '');
        if v_outlet is not null and not exists (select 1 from ops.outlet x where x.code = v_outlet and x.active
                                                  and (x.company = c or c = 'HOMEWORKSSB')) then
          raise exception '没有这间分店。' using errcode = '22023';
        end if;
        insert into ops.wh_lot (lot_no, company, item_code, qty, boxes, outlet, location, received_at, received_by, note, created_by)
        values (ops.wh_lot_next(), c, v_item, v_qty, v_boxes, v_outlet, v_loc, ops.now(), me.id,
                left(btrim(coalesce(o->>'note', '')), 200), me.id)
        returning * into l;
      end if;
    exception when others then
      if many then
        raise exception '第 % 行：%', i, sqlerrm using errcode = sqlstate;
      end if;
      raise;
    end;
    res := res || jsonb_build_array(ops.wh_lot_json(me, l));
  end loop;
  perform ops.log(me.id, 'create', 'wh_lot', null,
                  jsonb_build_object('company', c, 'lots', (select jsonb_agg(x->>'lot_no') from jsonb_array_elements(res) x)));
  return jsonb_build_object('lots', res);
end $$;

-- 一个批次（扫箱贴 QR 打开）：仓库「只看」以上、看得到那间分店（JB 的人看不到总部的批次）
create or replace function public.ops_wh_lot_get(p_lot_no text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  l ops.wh_lot;
  m ops.wh_move;
begin
  me := ops.require_level('warehouse', 'view');
  select * into l from ops.wh_lot where lot_no = upper(btrim(coalesce(p_lot_no, '')));
  if l.lot_no is null then
    raise exception '找不到批次「%」。请检查箱贴上的批次号。', coalesce(p_lot_no, '') using errcode = 'P0002';
  end if;
  perform ops.wh_company(me, l.company);
  select * into m from ops.wh_move where id = l.move_id;
  return ops.wh_lot_json(me, l) || jsonb_build_object(
    'can_print', ops.wh_can_lot(me),
    'move_status', m.status, 'move_ac_doc', nullif(m.ac_doc, ''),
    'expected', ops.wh_bin_expected(l.company, l.item_code, l.location),
    'shelved', ops.wh_bin_shelved(l.company, l.item_code, l.location),
    'bins', ops.wh_lot_bins(l.company, l.item_code, l.location),
    'prints', coalesce((
      select jsonb_agg(jsonb_build_object('id', x.id, 'copies', x.copies, 'size', x.size, 'created_at', x.created_at,
                                          'by_name', (select s.name from ops.staff s where s.id = x.created_by)) order by x.id desc)
      from (select * from ops.wh_label_print x where x.lot_no = l.lot_no order by x.id desc limit 20) x), '[]'::jsonb));
end $$;

-- 印箱贴可以选的进货：最近 N 天（预设 14）点货产生的进货（kind = receive、没取消），或指定一张厂家到货（do_id）
-- p: {company, days, do_id, q}。指定 do_id 时用那张厂家到货的公司（要看得到）。厂家 / DO 号只给看得到厂家的人。
create or replace function public.ops_wh_lot_moves(p jsonb default '{}'::jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  c text;
  v_do bigint;
  v_days int := least(greatest(coalesce(nullif(p->>'days', '')::int, 14), 1), 90);
  q text := upper(btrim(coalesce(p->>'q', '')));
  sup boolean;
begin
  me := ops.require_level('warehouse', 'view');
  v_do := case when coalesce(p->>'do_id', '') ~ '^[0-9]{1,12}$' then (p->>'do_id')::bigint end;
  if v_do is not null then
    c := ops.wh_company(me, coalesce((select d.company from ops.supplier_do d where d.id = v_do), p->>'company'));
  else
    c := ops.wh_company(me, p->>'company');
  end if;
  sup := ops.sees_supplier(me);
  return jsonb_build_object('company', c, 'do_id', v_do, 'days', v_days, 'can_create', ops.wh_can_lot(me),
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
          'move_id', m.id, 'item_code', m.item_code, 'description', coalesce(i.description, m.item_code), 'uom', i.base_uom,
          'qty', m.qty, 'outlet', m.outlet,
          'outlet_name', (select coalesce(nullif(o.short_name, ''), o.name) from ops.outlet o where o.code = m.outlet),
          'location', m.to_loc, 'status', m.status, 'recv_wrong', m.recv_wrong, 'created_at', m.created_at,
          'do_id', m.do_id, 'arrived_at', coalesce(d.arrived_at, m.created_at),
          'do_no', case when sup then nullif(d.do_no, '') end,
          'supplier_name', case when sup then nullif(d.supplier_name, '') end,
          'lot_no', l.lot_no, 'boxes', l.boxes,
          'printed', (select coalesce(sum(x.copies), 0) from ops.wh_label_print x where x.lot_no = l.lot_no))
        order by coalesce(d.arrived_at, m.created_at) desc, m.do_id desc, m.id)
      from ops.wh_move m
      left join ops.supplier_do d on d.id = m.do_id
      left join ops.wh_lot l on l.move_id = m.id
      left join bi.dim_item i on i.company = m.company and i.item_code = m.item_code
      where m.company = c and m.kind = 'receive' and m.status <> 'cancelled'
        and (case when v_do is not null then m.do_id = v_do else m.created_at >= ops.now() - make_interval(days => v_days) end)
        and (q = '' or upper(m.item_code) like '%' || q || '%' or upper(coalesce(i.description, '')) like '%' || q || '%'
             or (sup and upper(coalesce(d.do_no, '')) like '%' || q || '%') or upper(coalesce(l.lot_no, '')) like '%' || q || '%')),
      '[]'::jsonb));
end $$;

-- ==================================================================== 6. 打印纪录
-- 记打印（按了列印才记）。p: {company, rows: [{kind: lot|item|bin, lot_no?, item_code?, bin_id?, copies, size}]}
-- 商品条码、货架标签：仓库「只看」以上；箱贴：仓库或订货「可编辑」
create or replace function public.ops_wh_label_log(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  c text;
  o jsonb;
  k text;
  v_copies int;
  v_lot text;
  v_item text;
  v_bin bigint;
  n int := 0;
begin
  me := ops.require_level('warehouse', 'view');
  c := ops.wh_company(me, p->>'company');
  if jsonb_typeof(p->'rows') is distinct from 'array' or jsonb_array_length(p->'rows') = 0 then
    return jsonb_build_object('logged', 0);
  end if;
  if jsonb_array_length(p->'rows') > 500 then
    raise exception '一次最多记 500 行。' using errcode = '22023';
  end if;
  for o in select x from jsonb_array_elements(p->'rows') x loop
    k := coalesce(o->>'kind', '');
    v_copies := case when coalesce(o->>'copies', '') ~ '^[0-9]{1,6}$' then least(greatest((o->>'copies')::int, 1), 2000) else 1 end;
    v_lot := null; v_item := null; v_bin := null;
    if k = 'lot' then
      if not ops.wh_can_lot(me) then
        raise exception '印箱贴要仓库或订货「可编辑」，请找管理员开通。' using errcode = '42501';
      end if;
      select x.lot_no, x.item_code into v_lot, v_item from ops.wh_lot x
      where x.lot_no = upper(btrim(coalesce(o->>'lot_no', ''))) and x.company = c;
      if v_lot is null then
        raise exception '找不到批次「%」。', coalesce(o->>'lot_no', '') using errcode = 'P0002';
      end if;
    elsif k = 'item' then
      v_item := left(btrim(coalesce(o->>'item_code', '')), 60);
      if v_item = '' then
        raise exception '请填商品代号。' using errcode = '22023';
      end if;
    elsif k = 'bin' then
      select b.id into v_bin from ops.wh_bin b
      where b.id = case when coalesce(o->>'bin_id', '') ~ '^[0-9]{1,12}$' then (o->>'bin_id')::bigint end and b.company = c;
      if v_bin is null then
        raise exception '找不到货架。' using errcode = 'P0002';
      end if;
    else
      raise exception '未知的标签种类：%', k using errcode = '22023';
    end if;
    insert into ops.wh_label_print (company, kind, lot_no, item_code, bin_id, copies, size, created_by)
    values (c, k, v_lot, v_item, v_bin, v_copies, left(btrim(coalesce(o->>'size', '')), 30), me.id);
    n := n + 1;
  end loop;
  return jsonb_build_object('logged', n);
end $$;

-- 打印纪录（仓库「只看」以上）：p: {company, kind, q（商品 / 品名 / 批次号 / 货架 / 印的人）, from, to（马来西亚日期）, page}；一页 100
create or replace function public.ops_wh_label_prints(p jsonb default '{}'::jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  c text;
  k text := nullif(btrim(coalesce(p->>'kind', '')), '');
  q text := upper(btrim(coalesce(p->>'q', '')));
  d1 date;
  d2 date;
  pg int := greatest(0, coalesce(nullif(p->>'page', '')::int, 0));
  v_size int := 100;
begin
  me := ops.require_level('warehouse', 'view');
  c := ops.wh_company(me, p->>'company');
  begin
    d1 := nullif(p->>'from', '')::date;
    d2 := nullif(p->>'to', '')::date;
  exception when others then
    raise exception '日期格式不对，请重新选日期。' using errcode = '22023';
  end;
  return (
    with r as (
      select x.*, coalesce(x.item_code, l.item_code) item, coalesce(i.description, x.item_code, l.item_code) descr,
             b.code bin_code, b.location bin_loc, s.name by_name, l.qty lot_qty, l.boxes lot_boxes, l.outlet lot_outlet,
             l.location lot_loc
      from ops.wh_label_print x
      left join ops.wh_lot l on l.lot_no = x.lot_no
      left join ops.wh_bin b on b.id = x.bin_id
      left join ops.staff s on s.id = x.created_by
      left join bi.dim_item i on i.company = x.company and i.item_code = coalesce(x.item_code, l.item_code)
      where x.company = c and (k is null or x.kind = k)
        and (d1 is null or (x.created_at at time zone 'Asia/Kuala_Lumpur')::date >= d1)
        and (d2 is null or (x.created_at at time zone 'Asia/Kuala_Lumpur')::date <= d2)
        and (q = '' or upper(coalesce(x.item_code, l.item_code, '')) like '%' || q || '%'
             or upper(coalesce(i.description, '')) like '%' || q || '%' or upper(coalesce(x.lot_no, '')) like '%' || q || '%'
             or upper(coalesce(b.code, '')) like '%' || q || '%' or upper(coalesce(s.name, '')) like '%' || q || '%'))
    select jsonb_build_object('company', c, 'page', pg, 'page_size', v_size, 'total', (select count(*) from r),
      'can_lot', ops.wh_can_lot(me),
      'rows', coalesce((select jsonb_agg(jsonb_build_object(
          'id', r.id, 'kind', r.kind, 'lot_no', r.lot_no, 'item_code', r.item, 'description', r.descr,
          'bin_id', r.bin_id, 'bin_code', r.bin_code, 'bin_location', r.bin_loc,
          'copies', r.copies, 'size', r.size, 'created_at', r.created_at, 'by_name', r.by_name,
          'lot_qty', r.lot_qty, 'lot_boxes', r.lot_boxes, 'lot_outlet', r.lot_outlet, 'lot_location', r.lot_loc)
          order by r.id desc)
        from (select * from r order by r.id desc offset pg * v_size limit v_size) r), '[]'::jsonb)));
end $$;

-- ==================================================================== 7. 权限
revoke all on function ops.wh_can_tag(ops.staff) from public, anon, authenticated;
revoke all on function ops.wh_hot_items(text) from public, anon, authenticated;
revoke all on function ops.wh_slow_items(text) from public, anon, authenticated;
revoke all on function ops.wh_tag_items(text, text) from public, anon, authenticated;
revoke all on function ops.wh_item_tags(text, text[]) from public, anon, authenticated;
revoke all on function ops.wh_stock_filter(text, text, boolean, text) from public, anon, authenticated;
revoke all on function ops.wh_photo_dir(text, text) from public, anon, authenticated;
revoke all on function ops.wh_photo_json(ops.wh_item_photo) from public, anon, authenticated;
revoke all on function ops.wh_can_lot(ops.staff) from public, anon, authenticated;
revoke all on function ops.wh_lot_next() from public, anon, authenticated;
revoke all on function ops.wh_lot_bins(text, text, text) from public, anon, authenticated;
revoke all on function ops.wh_lot_json(ops.staff, ops.wh_lot) from public, anon, authenticated;
do $$
declare
  f text;
begin
  foreach f in array array['ops_wh_tags(jsonb)', 'ops_wh_tag_save(jsonb)', 'ops_wh_item_tag_set(jsonb)', 'ops_wh_item_tags(jsonb)',
                           'ops_wh_stock(jsonb)', 'ops_wh_stock_export(jsonb)', 'ops_wh_file_ok(text,boolean)',
                           'ops_wh_item_photo_set(jsonb)', 'ops_wh_item_photos(text,text[])', 'ops_wh_lot_create(jsonb)',
                           'ops_wh_lot_get(text)', 'ops_wh_lot_moves(jsonb)', 'ops_wh_label_log(jsonb)', 'ops_wh_label_prints(jsonb)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
