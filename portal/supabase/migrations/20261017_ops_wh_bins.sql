-- HomeWorks 营运系统 — 仓库：货架位置与每个货架的数量（使用者 2026-10-15 看了员工做的 WMS 后决定）
-- 员工系统把仓库分成「仓 / 区 / 货架 / 层」，每个货架都记数量。使用者选「每个货架都记数量」（知道每次上架、拿货都要扫码登记）。
-- 做法（对 AutoCount 仍然只读）：
--   · 「仓」= AutoCount 的仓位（HQ、SRGADING、JB…）；底下再分 区 / 货架 / 层 = ops.wh_bin。
--   · 每个货架上每个商品几件 = ops.wh_bin_stock（营运系统自己记的「货架帐」）；每一次变动都写 ops.wh_bin_log。
--   · AutoCount 只知道仓位的总数。同一个商品在同一个仓位：应有 = AutoCount 库存 + 还没输入 AutoCount 的搬动（ops.wh_pending），
--     货架合计 = 这个仓位所有货架加起来；未上架 = 应有 − 货架合计（放在地上、刚点完货还没上架、拣好待出货）。
--     货架合计比应有还多 = 货架帐有错（卖出去时没有从货架扣）→ 「对不上」清单请人去数。
--   · 改货架数量的动作：上架（+）、从货架拿下（−）、货架之间移（同一个仓位）、主管直接改数（要写原因）、Excel 带入（初次设定）；
--     之后的拣货（照 DO）、盘点单按货架盘、多行搬动都呼叫 ops.wh_bin_apply。
--   · 货架上的数量不会小于 0：拿的比货架上多 → 挡下，请先盘点 / 改数。
--   · 搬动（ops.wh_move）取消时，跟这笔搬动一起登记的货架变动自动反向（触发器）。
--   · 仓库地图：每个仓位一张，货架方块的位置存 ops.wh_map.layout（主管可拖拉）。
-- 权限：仓库「只看」= 看货架、地图、对不上清单；「可编辑」= 上架 / 拿下 / 移货架；「可审批」= 建货架、改地图、直接改数、Excel 带入。
-- 货架条码 = Code 128「BIN:<编号>」（网页自己印），扫到就知道是哪个货架；也可以打货架代号（例 A-R3-2）。

-- ============================================================ 1. 资料表
create table ops.wh_bin (
  id bigint generated always as identity primary key,
  company text not null check (company in ('HOMEWORKSSB', 'HOMEWORKSSOUTHERN')),
  location text not null,                                -- AutoCount 仓位（员工系统的「仓」）
  zone text not null default '',                         -- 区（可空）
  shelf text not null,                                   -- 货架
  level text not null default '',                        -- 层（可空）
  code text not null,                                    -- 区-货架-层（大写），同一仓位内唯一
  note text not null default '' check (length(note) <= 200),
  active boolean not null default true,
  sort int not null default 0,
  created_by bigint references ops.staff(id),
  created_at timestamptz not null default now(),
  foreign key (company, location) references ops.wh_location (company, code),
  unique (company, location, code)
);

create table ops.wh_bin_stock (
  bin_id bigint not null references ops.wh_bin(id),
  company text not null,
  item_code text not null,
  qty numeric(12,2) not null check (qty >= 0),           -- 0 也留着 = 这个商品平常放这里（上架时优先建议）
  updated_at timestamptz not null default now(),
  updated_by bigint references ops.staff(id),
  primary key (bin_id, item_code)
);
create index wh_bin_stock_item_idx on ops.wh_bin_stock (company, item_code);

create table ops.wh_bin_log (
  id bigint generated always as identity primary key,
  company text not null,
  bin_id bigint not null references ops.wh_bin(id),
  item_code text not null,
  delta numeric(12,2) not null,
  qty_after numeric(12,2) not null,
  kind text not null check (kind in ('putaway', 'take', 'move', 'adjust', 'import', 'count', 'pick', 'reverse')),
  ref_type text,                                         -- move（搬动）/ pick（拣货）/ count（盘点）/ bin_op（货架之间移）…
  ref_id bigint,
  note text not null default '' check (length(note) <= 300),
  reversed_by bigint,                                    -- 被哪一笔 reverse 冲回
  created_by bigint references ops.staff(id),
  created_at timestamptz not null default now()
);
create index wh_bin_log_item_idx on ops.wh_bin_log (company, item_code, created_at desc);
create index wh_bin_log_bin_idx on ops.wh_bin_log (bin_id, created_at desc);
create index wh_bin_log_ref_idx on ops.wh_bin_log (ref_type, ref_id) where ref_type is not null;

create table ops.wh_map (
  company text not null,
  location text not null,
  layout jsonb not null default '{}'::jsonb,             -- {"shelves": {"<区>::<货架>": {"x":…,"y":…,"w":…,"h":…}}, "w":…, "h":…}
  updated_by bigint references ops.staff(id),
  updated_at timestamptz not null default now(),
  primary key (company, location),
  foreign key (company, location) references ops.wh_location (company, code)
);

create sequence ops.wh_bin_ref_seq;
-- 扫码 / 打代号找商品（ops.wh_resolve）比对 upper(item_code)：没有这个索引每次都要扫整间公司 5,000 多个商品（Excel 带入几千行会超过 8 秒）
create index if not exists dim_item_company_upper_code_idx on bi.dim_item (company, upper(item_code));                      -- 一次货架动作（可能动到两个货架）的 ref_id

alter table ops.wh_bin enable row level security;
alter table ops.wh_bin_stock enable row level security;
alter table ops.wh_bin_log enable row level security;
alter table ops.wh_map enable row level security;

-- ============================================================ 2. 小工具
-- 区 / 货架 / 层：去头尾空白、英文转大写；不能有空白、/、-、:（代号用 - 连接，条码用 :）
create or replace function ops.wh_bin_part(p text, p_label text, p_required boolean) returns text
language plpgsql immutable set search_path = '' as $$
declare
  v text := upper(trim(coalesce(p, '')));
begin
  if v = '' then
    if p_required then
      raise exception '请填%。', p_label using errcode = '22023';
    end if;
    return '';
  end if;
  if length(v) > 12 or v ~ '[[:space:]/:-]' then
    raise exception '%「%」太长或有空格 / 斜线 / 减号，请用短一点的字（例：A、R3、2）。', p_label, v using errcode = '22023';
  end if;
  return v;
end $$;

create or replace function ops.wh_bin_code(p_zone text, p_shelf text, p_level text) returns text
language sql immutable set search_path = '' as $$
  select concat_ws('-', nullif(p_zone, ''), p_shelf, nullif(p_level, ''))
$$;

-- 扫到 / 打的货架：「BIN:123」或代号（例 A-R3-2，不分大小写）；有给仓位就只在那个仓位找
create or replace function ops.wh_bin_find(p_company text, p_code text, p_location text default null) returns ops.wh_bin
language plpgsql stable security definer set search_path = '' as $$
declare
  v text := upper(trim(coalesce(p_code, '')));
  b ops.wh_bin;
  n int;
begin
  if v = '' then
    raise exception '请扫或打货架代号。' using errcode = '22023';
  end if;
  if v ~ '^BIN:[0-9]{1,12}$' then
    select * into b from ops.wh_bin where id = substr(v, 5)::bigint and company = p_company;
  else
    select count(*) into n from ops.wh_bin
    where company = p_company and code = v and (p_location is null or location = p_location);
    if n > 1 then
      raise exception '有好几个仓位都有货架 %，请先选仓位或扫货架条码。', v using errcode = '22023';
    end if;
    select * into b from ops.wh_bin
    where company = p_company and code = v and (p_location is null or location = p_location);
  end if;
  if b.id is null then
    raise exception '找不到货架「%」。', p_code using errcode = 'P0002';
  end if;
  if p_location is not null and b.location <> p_location then
    raise exception '货架 % 在 %，不是 %。', b.code, b.location, p_location using errcode = '22023';
  end if;
  return b;
end $$;

-- 已开 DO、还没拣的数量：AutoCount 开 DO 当下就扣库存，可是货还在货架上（拣货时才拿下来）。
-- 真正的算法在拣货（20261017b_ops_wh_pick.sql 换掉这个函数）；这里先回空，让这个档自己也能套。
create or replace function ops.wh_do_unpicked(p_company text) returns table (item_code text, qty numeric)
language sql stable security definer set search_path = '' as $$
  select null::text, null::numeric where false
$$;

-- 一个商品在某仓位的已开 DO 未拣（DO 没有仓位：算在这间公司的主要仓位）
create or replace function ops.wh_do_unpicked_item(p_company text, p_item text, p_loc text) returns numeric
language sql stable security definer set search_path = '' as $$
  select case when p_loc = ops.podo_main_loc(p_company)
              then coalesce((select sum(u.qty) from ops.wh_do_unpicked(p_company) u where u.item_code = p_item), 0)
              else 0 end
$$;

-- 应有（货架上该有的）= AutoCount 库存 + 还没输入 AutoCount 的搬动 + 已开 DO 还没拣的
create or replace function ops.wh_bin_expected(p_company text, p_item text, p_loc text) returns numeric
language sql stable security definer set search_path = '' as $$
  select coalesce((select sum(f.qty) from bi.fact_stock f
                   where f.company = p_company and f.item_code = p_item and f.location = p_loc), 0)
       + ops.wh_pending(p_company, p_item, p_loc)
       + ops.wh_do_unpicked_item(p_company, p_item, p_loc)
$$;

create or replace function ops.wh_bin_shelved(p_company text, p_item text, p_loc text) returns numeric
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(s.qty), 0) from ops.wh_bin_stock s join ops.wh_bin b on b.id = s.bin_id
  where s.company = p_company and s.item_code = p_item and b.location = p_loc
$$;

-- 改一个货架上一个商品的数量（所有改货架帐的地方都走这里）。p_set 有值 = 改成这个数；不然加 p_delta。
-- 回传改完的数量。数量不能小于 0。停用的货架只能减少（拿走、盘成 0、改数），不能再放东西上去。
-- 先确保那一行存在再上锁（两人同时第一次放上同一格时，for update 才锁得到，不会丢数）。
create or replace function ops.wh_bin_apply(p_me ops.staff, p_bin bigint, p_item text, p_delta numeric, p_kind text,
  p_ref_type text default null, p_ref_id bigint default null, p_note text default '', p_set numeric default null)
returns numeric
language plpgsql security definer set search_path = '' as $$
declare
  b ops.wh_bin;
  cur numeric;
  nxt numeric;
  d numeric;
begin
  select * into b from ops.wh_bin where id = p_bin for share;   -- 跟停用货架排队
  if b.id is null then
    raise exception '找不到货架。' using errcode = 'P0002';
  end if;
  insert into ops.wh_bin_stock (bin_id, company, item_code, qty, updated_at, updated_by)
  values (p_bin, b.company, p_item, 0, now(), p_me.id)
  on conflict (bin_id, item_code) do nothing;
  select s.qty into cur from ops.wh_bin_stock s where s.bin_id = p_bin and s.item_code = p_item for update;
  cur := coalesce(cur, 0);
  if p_set is not null then
    if p_set < 0 then
      raise exception '数量不能小于 0。' using errcode = '22023';
    end if;
    nxt := p_set;
  else
    nxt := cur + coalesce(p_delta, 0);
  end if;
  if nxt < 0 then
    raise exception '货架 % 上的 % 只有 % 件，不够拿 % 件。如果实际有货，请先盘点或请主管改数。',
      b.code, p_item, trim_scale(cur)::text, trim_scale(-p_delta)::text
      using errcode = '22023';
  end if;
  if not b.active and nxt > cur then
    raise exception '货架 % 已经停用，不能再放东西上去。', b.code using errcode = '22023';
  end if;
  d := nxt - cur;
  update ops.wh_bin_stock set qty = nxt, updated_at = now(), updated_by = p_me.id
  where bin_id = p_bin and item_code = p_item;
  if d <> 0 or p_kind in ('count', 'adjust', 'import') then
    insert into ops.wh_bin_log (company, bin_id, item_code, delta, qty_after, kind, ref_type, ref_id, note, created_by)
    values (b.company, p_bin, p_item, d, nxt, p_kind, p_ref_type, p_ref_id, left(coalesce(p_note, ''), 300), p_me.id);
  end if;
  return nxt;
end $$;

-- 把某个来源（例：一笔搬动、一次拣货扫码）登记过的货架变动全部反向；货架上已经不够扣回的扣到 0 为止。回传冲回几笔。
create or replace function ops.wh_bin_reverse(p_me ops.staff, p_ref_type text, p_ref_id bigint, p_note text default '')
returns int
language plpgsql security definer set search_path = '' as $$
declare
  l record;
  cur numeric;
  nxt numeric;
  rid bigint;
  n int := 0;
begin
  for l in select * from ops.wh_bin_log g
           where g.ref_type = p_ref_type and g.ref_id = p_ref_id and g.reversed_by is null and g.kind <> 'reverse' and g.delta <> 0
           order by g.id desc loop
    select s.qty into cur from ops.wh_bin_stock s where s.bin_id = l.bin_id and s.item_code = l.item_code for update;
    cur := coalesce(cur, 0);
    nxt := greatest(cur - l.delta, 0);
    insert into ops.wh_bin_stock (bin_id, company, item_code, qty, updated_at, updated_by)
    values (l.bin_id, l.company, l.item_code, nxt, now(), p_me.id)
    on conflict (bin_id, item_code) do update set qty = excluded.qty, updated_at = excluded.updated_at, updated_by = excluded.updated_by;
    insert into ops.wh_bin_log (company, bin_id, item_code, delta, qty_after, kind, ref_type, ref_id, note, created_by)
    values (l.company, l.bin_id, l.item_code, nxt - cur, nxt, 'reverse', p_ref_type, p_ref_id,
            left(coalesce(nullif(p_note, ''), '冲回') || case when nxt - cur <> -l.delta then '（货架上不够，扣到 0）' else '' end, 300),
            p_me.id)
    returning id into rid;
    update ops.wh_bin_log set reversed_by = rid where id = l.id;
    n := n + 1;
  end loop;
  return n;
end $$;

-- 搬动取消 → 跟它一起登记的货架变动反向
create or replace function ops.wh_move_bin_reverse() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'cancelled' and old.status <> 'cancelled' then
    perform ops.wh_bin_reverse(ops.current_staff(), 'move', new.id, '搬动取消');
  end if;
  return new;
end $$;
create trigger wh_move_bin_reverse after update of status on ops.wh_move
  for each row execute function ops.wh_move_bin_reverse();

create or replace function ops.wh_bin_json(b ops.wh_bin) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', b.id, 'location', b.location, 'zone', b.zone, 'shelf', b.shelf, 'level', b.level,
    'code', b.code, 'note', b.note, 'active', b.active, 'sort', b.sort, 'barcode', 'BIN:' || b.id)
$$;

-- 每个仓位的货架帐概况（总览、首页用）：几个货架、几个商品有上架、对不上（货架比应有多）几个、未上架几个
create or replace function ops.wh_bin_summary(p_company text) returns jsonb
language sql stable security definer set search_path = '' as $$
  with locs as (select distinct b.location from ops.wh_bin b where b.company = p_company and b.active),
  pend as (
    select m.item_code, loc, sum(q) q from (
      select m.item_code, m.to_loc loc, m.qty q from ops.wh_move m
      where m.company = p_company and m.status = 'pending' and m.to_loc is not null and not (m.kind = 'receive' and m.pre_grn is not null)
      union all
      select m.item_code, m.from_loc, -m.qty from ops.wh_move m
      where m.company = p_company and m.status = 'pending' and m.from_loc is not null and not (m.kind = 'receive' and m.pre_grn is not null)
    ) m group by 1, 2),
  shelved as (
    select s.item_code, b.location loc, sum(s.qty) q from ops.wh_bin_stock s join ops.wh_bin b on b.id = s.bin_id
    where s.company = p_company group by 1, 2),
  ac as (select f.item_code, f.location loc, sum(f.qty) q from bi.fact_stock f
         where f.company = p_company and f.location in (select location from locs) group by 1, 2),
  allk as (select item_code, loc from shelved union select item_code, loc from ac union
           select item_code, loc from pend where loc in (select location from locs)),
  dou as (select u.item_code, ops.podo_main_loc(p_company) loc, sum(u.qty) q from ops.wh_do_unpicked(p_company) u group by 1, 2),
  r as (
    select k.loc, coalesce(a.q, 0) + coalesce(p.q, 0) + coalesce(du.q, 0) expected, coalesce(s.q, 0) shelved
    from allk k
    left join ac a on a.item_code = k.item_code and a.loc = k.loc
    left join pend p on p.item_code = k.item_code and p.loc = k.loc
    left join dou du on du.item_code = k.item_code and du.loc = k.loc
    left join shelved s on s.item_code = k.item_code and s.loc = k.loc)
  select coalesce(jsonb_agg(jsonb_build_object(
    'location', l.location,
    'bins', (select count(*) from ops.wh_bin b where b.company = p_company and b.location = l.location and b.active),
    'items_shelved', (select count(*) from r where r.loc = l.location and r.shelved > 0),
    'items_over', (select count(*) from r where r.loc = l.location and r.shelved > greatest(r.expected, 0)),
    'items_unshelved', (select count(*) from r where r.loc = l.location and r.expected > r.shelved))
    order by l.location), '[]'::jsonb)
  from locs l
$$;

-- ============================================================ 3. 货架清单 / 建货架
-- p: {company, location?, include_inactive?}
create or replace function public.ops_wh_bins(p jsonb default '{}'::jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  c text;
  loc text := nullif(trim(coalesce(p->>'location', '')), '');
  inact boolean := coalesce((p->>'include_inactive')::boolean, false);
begin
  me := ops.require_level('warehouse', 'view');
  c := ops.wh_company(me, p->>'company');
  return jsonb_build_object(
    'company', c,
    'bins', coalesce((
      select jsonb_agg(ops.wh_bin_json(b) || jsonb_build_object(
          'items', (select count(*) from ops.wh_bin_stock s where s.bin_id = b.id and s.qty > 0),
          'qty', (select coalesce(sum(s.qty), 0) from ops.wh_bin_stock s where s.bin_id = b.id),
          'updated_at', (select max(s.updated_at) from ops.wh_bin_stock s where s.bin_id = b.id))
        order by b.location, b.sort, b.zone, length(b.shelf), b.shelf, length(b.level), b.level)
      from ops.wh_bin b
      where b.company = c and (loc is null or b.location = loc) and (inact or b.active)), '[]'::jsonb),
    'summary', ops.wh_bin_summary(c));
end $$;

-- 建 / 改一个货架（可审批）。p: {id?, company, location, zone, shelf, level, note, active, sort}
-- 建好之后仓位不能改；停用前货架要先清空。
create or replace function public.ops_wh_bin_save(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  c text;
  b ops.wh_bin;
  v_loc text := trim(coalesce(p->>'location', ''));
  v_zone text;
  v_shelf text;
  v_level text;
  v_code text;
  v_active boolean;
begin
  me := ops.require_level('warehouse', 'approve');
  c := ops.wh_company(me, p->>'company');
  v_zone := ops.wh_bin_part(p->>'zone', '区', false);
  v_shelf := ops.wh_bin_part(p->>'shelf', '货架', true);
  v_level := ops.wh_bin_part(p->>'level', '层', false);
  v_code := ops.wh_bin_code(v_zone, v_shelf, v_level);
  if nullif(p->>'id', '') is not null then
    select * into b from ops.wh_bin where id = (p->>'id')::bigint and company = c for update;
    if b.id is null then
      raise exception '找不到货架。' using errcode = 'P0002';
    end if;
    v_loc := b.location;
    v_active := coalesce((p->>'active')::boolean, b.active);
    if not v_active and b.active and exists (select 1 from ops.wh_bin_stock s where s.bin_id = b.id and s.qty > 0) then
      raise exception '货架 % 上还有货，请先移走或盘点成 0 再停用。', b.code using errcode = '22023';
    end if;
    if exists (select 1 from ops.wh_bin x where x.company = c and x.location = v_loc and x.code = v_code and x.id <> b.id) then
      raise exception '% 已经有货架 %。', v_loc, v_code using errcode = '23505';
    end if;
    update ops.wh_bin set zone = v_zone, shelf = v_shelf, level = v_level, code = v_code,
      note = left(trim(coalesce(p->>'note', b.note)), 200), active = v_active,
      sort = coalesce(nullif(p->>'sort', '')::int, b.sort)
    where id = b.id returning * into b;
    perform ops.log(me.id, 'update', 'wh_bin', b.id, to_jsonb(b));
  else
    if not exists (select 1 from ops.wh_location l where l.company = c and l.code = v_loc) then
      raise exception '没有这个仓位。' using errcode = '22023';
    end if;
    if exists (select 1 from ops.wh_bin x where x.company = c and x.location = v_loc and x.code = v_code) then
      raise exception '% 已经有货架 %。', v_loc, v_code using errcode = '23505';
    end if;
    insert into ops.wh_bin (company, location, zone, shelf, level, code, note, active, sort, created_by)
    values (c, v_loc, v_zone, v_shelf, v_level, v_code, left(trim(coalesce(p->>'note', '')), 200), true,
            coalesce(nullif(p->>'sort', '')::int, 0), me.id)
    returning * into b;
    perform ops.log(me.id, 'create', 'wh_bin', b.id, to_jsonb(b));
  end if;
  return ops.wh_bin_json(b);
end $$;

-- 一次建很多货架（可审批）：p: {company, location, zone, shelves: ["R1","R2",…], levels: ["1","2",…]}
-- levels 空 = 不分层。已经有的跳过。回传 {created, existed, bins}
create or replace function public.ops_wh_bin_bulk(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  c text;
  v_loc text := trim(coalesce(p->>'location', ''));
  v_zone text;
  sh text;
  lv text;
  v_code text;
  lvls text[];
  n_new int := 0;
  n_old int := 0;
  b ops.wh_bin;
begin
  me := ops.require_level('warehouse', 'approve');
  c := ops.wh_company(me, p->>'company');
  if not exists (select 1 from ops.wh_location l where l.company = c and l.code = v_loc) then
    raise exception '没有这个仓位。' using errcode = '22023';
  end if;
  v_zone := ops.wh_bin_part(p->>'zone', '区', false);
  if jsonb_typeof(p->'shelves') <> 'array' or jsonb_array_length(p->'shelves') = 0 then
    raise exception '请填货架。' using errcode = '22023';
  end if;
  if jsonb_array_length(p->'shelves') * greatest(coalesce(jsonb_array_length(case when jsonb_typeof(p->'levels') = 'array' then p->'levels' end), 0), 1) > 500 then
    raise exception '一次最多建 500 个货架。' using errcode = '22023';
  end if;
  lvls := case when jsonb_typeof(p->'levels') = 'array' and jsonb_array_length(p->'levels') > 0
               then array(select ops.wh_bin_part(x, '层', true) from jsonb_array_elements_text(p->'levels') x)
               else array[''] end;
  for sh in select ops.wh_bin_part(x, '货架', true) from jsonb_array_elements_text(p->'shelves') x loop
    foreach lv in array lvls loop
      v_code := ops.wh_bin_code(v_zone, sh, lv);
      if exists (select 1 from ops.wh_bin x where x.company = c and x.location = v_loc and x.code = v_code) then
        n_old := n_old + 1;
      else
        insert into ops.wh_bin (company, location, zone, shelf, level, code, created_by)
        values (c, v_loc, v_zone, sh, lv, v_code, me.id) returning * into b;
        n_new := n_new + 1;
      end if;
    end loop;
  end loop;
  perform ops.log(me.id, 'create', 'wh_bin_bulk', null, p);
  return jsonb_build_object('created', n_new, 'existed', n_old);
end $$;

-- 一个货架：上面有什么（数量 > 0 的在前，0 = 平常放这里）+ 最近 50 笔变动
-- p: {company, bin (BIN:id / 代号 / id), location?}
create or replace function public.ops_wh_bin_get(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  c text;
  b ops.wh_bin;
begin
  me := ops.require_level('warehouse', 'view');
  c := ops.wh_company(me, p->>'company');
  b := ops.wh_bin_find(c, p->>'bin', nullif(trim(coalesce(p->>'location', '')), ''));
  return ops.wh_bin_json(b) || jsonb_build_object(
    'items', coalesce((
      select jsonb_agg(jsonb_build_object('item_code', s.item_code,
          'description', coalesce(i.description, s.item_code), 'uom', i.base_uom, 'qty', s.qty, 'updated_at', s.updated_at,
          'updated_by_name', (select st.name from ops.staff st where st.id = s.updated_by))
        order by (s.qty > 0) desc, s.item_code)
      from ops.wh_bin_stock s left join bi.dim_item i on i.company = s.company and i.item_code = s.item_code
      where s.bin_id = b.id), '[]'::jsonb),
    'log', coalesce((
      select jsonb_agg(x.j order by x.id desc) from (
        select g.id, jsonb_build_object('id', g.id, 'item_code', g.item_code, 'delta', g.delta, 'qty_after', g.qty_after,
          'kind', g.kind, 'ref_type', g.ref_type, 'ref_id', g.ref_id, 'note', g.note, 'created_at', g.created_at,
          'reversed', g.reversed_by is not null,
          'by_name', (select st.name from ops.staff st where st.id = g.created_by)) j
        from ops.wh_bin_log g where g.bin_id = b.id order by g.id desc limit 50) x), '[]'::jsonb));
end $$;

-- 一个商品在各仓位的货架分布：AutoCount 库存、还没输入的搬动、应有、货架合计、未上架；各货架几件（含 0 = 平常放这里）
-- p: {company, item (商品代号 / 纸箱条码)}
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
          'ac_qty', coalesce((select sum(f.qty) from bi.fact_stock f where f.company = c and f.item_code = v_item and f.location = l.loc), 0),
          'pending', ops.wh_pending(c, v_item, l.loc),
          'do_unpicked', ops.wh_do_unpicked_item(c, v_item, l.loc),
          'expected', ops.wh_bin_expected(c, v_item, l.loc),
          'shelved', ops.wh_bin_shelved(c, v_item, l.loc),
          'unshelved', ops.wh_bin_expected(c, v_item, l.loc) - ops.wh_bin_shelved(c, v_item, l.loc),
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
      left join ops.wh_location wl on wl.company = c and wl.code = l.loc), '[]'::jsonb),
    'log', coalesce((
      select jsonb_agg(x.j order by x.id desc) from (
        select g.id, jsonb_build_object('id', g.id, 'bin_id', g.bin_id,
          'bin', (select b.location || ' · ' || b.code from ops.wh_bin b where b.id = g.bin_id),
          'delta', g.delta, 'qty_after', g.qty_after, 'kind', g.kind, 'ref_type', g.ref_type, 'ref_id', g.ref_id,
          'note', g.note, 'created_at', g.created_at, 'reversed', g.reversed_by is not null,
          'by_name', (select st.name from ops.staff st where st.id = g.created_by)) j
        from ops.wh_bin_log g where g.company = c and g.item_code = v_item order by g.id desc limit 20) x), '[]'::jsonb));
end $$;

-- ============================================================ 4. 上架 / 拿下 / 货架之间移 / 改数
-- 一个动作（不检查权限、不处理确认；给 ops_wh_bin_op / ops_wh_bin_batch 共用）。回传 {item_code, location, over, expected, shelved}
-- o: {kind: putaway|take|move|adjust, item, qty, bin, from_bin, to_bin, location?, note}
create or replace function ops.wh_bin_do(p_me ops.staff, p_company text, o jsonb, p_ref_id bigint) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  k text := coalesce(nullif(o->>'kind', ''), 'putaway');
  v_item text;
  v_qty numeric := nullif(o->>'qty', '')::numeric;
  loc text := nullif(trim(coalesce(o->>'location', '')), '');
  bf ops.wh_bin;
  bt ops.wh_bin;
  note text := left(trim(coalesce(o->>'note', '')), 300);
  exp numeric;
  sh numeric;
begin
  v_item := ops.wh_resolve(p_company, o->>'item');
  if v_item is null then
    raise exception '找不到商品「%」，请重新扫或打商品代号。', coalesce(o->>'item', '') using errcode = 'P0002';
  end if;
  if k not in ('putaway', 'take', 'move', 'adjust') then
    raise exception '未知的货架动作：%', k using errcode = '22023';
  end if;
  if v_qty is null or (k <> 'adjust' and v_qty <= 0) or v_qty < 0 then
    raise exception '请填数量。' using errcode = '22023';
  end if;
  if k = 'putaway' then
    bt := ops.wh_bin_find(p_company, coalesce(o->>'to_bin', o->>'bin'), loc);
    perform ops.wh_bin_apply(p_me, bt.id, v_item, v_qty, 'putaway', 'bin_op', p_ref_id, note);
    loc := bt.location;
  elsif k = 'take' then
    bf := ops.wh_bin_find(p_company, coalesce(o->>'from_bin', o->>'bin'), loc);
    perform ops.wh_bin_apply(p_me, bf.id, v_item, -v_qty, 'take', 'bin_op', p_ref_id, note);
    loc := bf.location;
  elsif k = 'move' then
    bf := ops.wh_bin_find(p_company, o->>'from_bin', loc);
    bt := ops.wh_bin_find(p_company, o->>'to_bin', loc);
    if bf.id = bt.id then
      raise exception '「从」和「到」是同一个货架。' using errcode = '22023';
    end if;
    if bf.location <> bt.location then
      raise exception '货架 %（%）和 %（%）在不同仓位：不同仓位要用「搬动」登记调仓（AutoCount 要开转仓单）。',
        bf.code, bf.location, bt.code, bt.location using errcode = '22023';
    end if;
    perform ops.wh_bin_apply(p_me, bf.id, v_item, -v_qty, 'move', 'bin_op', p_ref_id, note);
    perform ops.wh_bin_apply(p_me, bt.id, v_item, v_qty, 'move', 'bin_op', p_ref_id, note);
    loc := bf.location;
  else
    if ops.level_rank(ops.module_level(p_me, 'warehouse')) < 3 then
      raise exception '直接改货架数量要仓库「可审批」；一般请用盘点。' using errcode = '42501';
    end if;
    if note = '' then
      raise exception '改数请写原因。' using errcode = '22023';
    end if;
    bt := ops.wh_bin_find(p_company, coalesce(o->>'bin', o->>'to_bin'), loc);
    perform ops.wh_bin_apply(p_me, bt.id, v_item, null, 'adjust', 'bin_op', p_ref_id, note, v_qty);
    loc := bt.location;
  end if;
  exp := ops.wh_bin_expected(p_company, v_item, loc);
  sh := ops.wh_bin_shelved(p_company, v_item, loc);
  return jsonb_build_object('item_code', v_item, 'location', loc, 'expected', exp, 'shelved', sh,
    'over', k in ('putaway', 'adjust') and sh > greatest(exp, 0));
end $$;

-- 一个动作。上架 / 改数之后货架合计会比应有（AutoCount + 还没输入的搬动）多 → 没有 confirm 就不存，回传 need_confirm 让画面问一次。
-- p: {company, kind, item, qty, bin / from_bin / to_bin, location?, note, confirm}
create or replace function public.ops_wh_bin_op(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  c text;
  r jsonb;
  rid bigint := nextval('ops.wh_bin_ref_seq');
begin
  me := ops.require_level('warehouse', 'edit');
  c := ops.wh_company(me, p->>'company');
  r := ops.wh_bin_do(me, c, p, rid);
  if (r->>'over')::boolean and not coalesce((p->>'confirm')::boolean, false) then
    raise exception 'NEED_CONFIRM:%:%', r->>'expected', r->>'shelved' using errcode = 'P0001';
  end if;
  return r || jsonb_build_object('ok', true, 'ref_id', rid);
exception when raise_exception then
  if sqlerrm like 'NEED_CONFIRM:%' then
    -- 整个动作已经被回滚：告诉画面要再确认一次
    return jsonb_build_object('ok', false, 'need_confirm', true,
      'expected', split_part(sqlerrm, ':', 2)::numeric, 'shelved', split_part(sqlerrm, ':', 3)::numeric);
  end if;
  raise;
end $$;

-- 撤销自己刚做的货架动作（上架 / 拿下 / 移货架 / 改数）：照纪录反向冲回，不会盖掉这段时间别人做的变动；同一个动作只能撤销一次。
-- 改数的撤销要可审批。p_ref_id = ops_wh_bin_op 回传的 ref_id
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
    raise exception '这个动作已经撤销过了。' using errcode = '22023';
  end if;
  return jsonb_build_object('ok', true, 'reversed', n);
end $$;

-- 很多动作一起（点货后一次上架、Excel 带入的上架）：全部成功才存；有错回传第几行。
-- p: {company, ops: [{kind, item, qty, bin…}], confirm}
create or replace function public.ops_wh_bin_batch(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  c text;
  o jsonb;
  r jsonb;
  i int := 0;
  overs jsonb := '[]'::jsonb;
  rid bigint := nextval('ops.wh_bin_ref_seq');
begin
  me := ops.require_level('warehouse', 'edit');
  c := ops.wh_company(me, p->>'company');
  if jsonb_typeof(p->'ops') <> 'array' or jsonb_array_length(p->'ops') = 0 then
    raise exception '没有要登记的。' using errcode = '22023';
  end if;
  if jsonb_array_length(p->'ops') > 300 then
    raise exception '一次最多 300 行。' using errcode = '22023';
  end if;
  for o in select x from jsonb_array_elements(p->'ops') x loop
    i := i + 1;
    begin
      r := ops.wh_bin_do(me, c, o, rid);
    exception when others then
      raise exception '第 % 行：%', i, sqlerrm using errcode = sqlstate;
    end;
    if (r->>'over')::boolean then
      overs := overs || jsonb_build_array(r || jsonb_build_object('row', i));
    end if;
  end loop;
  if jsonb_array_length(overs) > 0 and not coalesce((p->>'confirm')::boolean, false) then
    raise exception 'NEED_CONFIRM_BATCH:%', overs::text using errcode = 'P0001';
  end if;
  return jsonb_build_object('ok', true, 'rows', i, 'over', overs);
exception when raise_exception then
  if sqlerrm like 'NEED_CONFIRM_BATCH:%' then
    return jsonb_build_object('ok', false, 'need_confirm', true, 'over', substr(sqlerrm, 20)::jsonb);
  end if;
  raise;
end $$;

-- Excel 带入货架数量（初次设定；可审批）：直接把货架上的数量改成表上的数。
-- p: {company, location, rows: [{item, bin (代号) 或 zone/shelf/level, qty}], create_bins, dry_run}
-- 同一个商品 + 货架出现两次 = 加起来。有任何一行错就全部不存，回传每行的结果。
create or replace function public.ops_wh_bin_import(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  c text;
  v_loc text := trim(coalesce(p->>'location', ''));
  mk boolean := coalesce((p->>'create_bins')::boolean, false);
  dry boolean := coalesce((p->>'dry_run')::boolean, false);
  o jsonb;
  i int := 0;
  v_item text;
  bcode text;
  z text; s text; l text;
  b ops.wh_bin;
  q numeric;
  res jsonb[] := '{}';                                   -- 阵列累加（jsonb || 每次整份复制，几千行会很慢）
  nerr int := 0;
  nnew int := 0;
  rid bigint := nextval('ops.wh_bin_ref_seq');
  agg record;
begin
  me := ops.require_level('warehouse', 'approve');
  c := ops.wh_company(me, p->>'company');
  if not exists (select 1 from ops.wh_location wl where wl.company = c and wl.code = v_loc) then
    raise exception '没有这个仓位。' using errcode = '22023';
  end if;
  if jsonb_typeof(p->'rows') <> 'array' or jsonb_array_length(p->'rows') = 0 then
    raise exception '表上没有资料。' using errcode = '22023';
  end if;
  if jsonb_array_length(p->'rows') > 5000 then
    raise exception '一次最多 5,000 行，请分开带入。' using errcode = '22023';
  end if;
  -- 暂存表（交易结束自动消失）；同一个交易里叫两次时用 call_id 分开
  create temp table if not exists wh_bin_import_tmp (call_id bigint, row_no int, item_code text, bin_code text, zone text, shelf text, level text, qty numeric) on commit drop;
  for o in select x from jsonb_array_elements(p->'rows') x loop
    i := i + 1;
    begin
      v_item := ops.wh_resolve(c, o->>'item');
      if v_item is null then
        raise exception '找不到商品「%」', coalesce(o->>'item', '');
      end if;
      q := nullif(trim(coalesce(o->>'qty', '')), '')::numeric;
      if q is null or q < 0 then
        raise exception '数量不对';
      end if;
      if nullif(trim(coalesce(o->>'bin', '')), '') is not null and nullif(trim(coalesce(o->>'shelf', '')), '') is null then
        bcode := upper(trim(o->>'bin'));
        z := null; s := null; l := null;
      else
        z := ops.wh_bin_part(o->>'zone', '区', false);
        s := ops.wh_bin_part(o->>'shelf', '货架', true);
        l := ops.wh_bin_part(o->>'level', '层', false);
        bcode := ops.wh_bin_code(z, s, l);
      end if;
      if exists (select 1 from ops.wh_bin x where x.company = c and x.location = v_loc and x.code = bcode and not x.active) then
        raise exception '货架 % 已经停用', bcode;
      end if;
      if not exists (select 1 from ops.wh_bin x where x.company = c and x.location = v_loc and x.code = bcode) and (not mk or s is null) then
        raise exception '% 没有货架 %', v_loc, bcode;
      end if;
      insert into wh_bin_import_tmp values (rid, i, v_item, bcode, z, s, l, q);
      res := res || jsonb_build_object('row', i, 'ok', true, 'item_code', v_item, 'bin', bcode, 'qty', q);
    exception when others then
      nerr := nerr + 1;
      res := res || jsonb_build_object('row', i, 'ok', false, 'error', sqlerrm);
    end;
  end loop;
  if nerr > 0 or dry then
    return jsonb_build_object('ok', nerr = 0, 'saved', false, 'errors', nerr, 'rows', to_jsonb(res),
      'new_bins', (select count(distinct t.bin_code) from wh_bin_import_tmp t
                   where t.call_id = rid and not exists (select 1 from ops.wh_bin x where x.company = c and x.location = v_loc and x.code = t.bin_code)));
  end if;
  for agg in select t.bin_code, max(t.zone) zone, max(t.shelf) shelf, max(t.level) level from wh_bin_import_tmp t
             where t.call_id = rid and not exists (select 1 from ops.wh_bin x where x.company = c and x.location = v_loc and x.code = t.bin_code)
             group by t.bin_code loop
    insert into ops.wh_bin (company, location, zone, shelf, level, code, created_by)
    values (c, v_loc, coalesce(agg.zone, ''), agg.shelf, coalesce(agg.level, ''), agg.bin_code, me.id);
    nnew := nnew + 1;
  end loop;
  for agg in select t.item_code, t.bin_code, sum(t.qty) qty from wh_bin_import_tmp t where t.call_id = rid group by 1, 2 loop
    select * into b from ops.wh_bin x where x.company = c and x.location = v_loc and x.code = agg.bin_code;
    perform ops.wh_bin_apply(me, b.id, agg.item_code, null, 'import', 'import', rid, 'Excel 带入', agg.qty);
  end loop;
  perform ops.log(me.id, 'import', 'wh_bin_stock', rid, jsonb_build_object('location', v_loc, 'rows', i, 'new_bins', nnew));
  return jsonb_build_object('ok', true, 'saved', true, 'errors', 0, 'rows', to_jsonb(res), 'new_bins', nnew);
end $$;

-- ============================================================ 5. 对不上 / 未上架清单
-- p: {company, location, filter: over|unshelved|all, q, page}；每页 100
-- over = 货架合计比应有多（卖出去没从货架扣、或货架数错）→ 请人去数；unshelved = 应有比货架合计多（还没上架）
-- 应有 = AutoCount + 还没输入的搬动 + 已开 DO 还没拣的（主要仓位；AutoCount 开 DO 就扣，货还在架上）
create or replace function public.ops_wh_bin_recon(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  c text;
  v_loc text := trim(coalesce(p->>'location', ''));
  flt text := coalesce(nullif(p->>'filter', ''), 'over');
  q text := upper(trim(coalesce(p->>'q', '')));
  pg int := greatest(0, coalesce(nullif(p->>'page', '')::int, 0));
  size int := 100;
begin
  me := ops.require_level('warehouse', 'view');
  c := ops.wh_company(me, p->>'company');
  if not exists (select 1 from ops.wh_location wl where wl.company = c and wl.code = v_loc) then
    raise exception '没有这个仓位。' using errcode = '22023';
  end if;
  return (
    with pend as (
      select m.item_code, sum(case when m.to_loc = v_loc then m.qty else -m.qty end) q
      from ops.wh_move m
      where m.company = c and m.status = 'pending' and (m.to_loc = v_loc or m.from_loc = v_loc)
        and not (m.kind = 'receive' and m.pre_grn is not null)
      group by 1),
    shelved as (
      select s.item_code, sum(s.qty) q, count(*) filter (where s.qty > 0) nb
      from ops.wh_bin_stock s join ops.wh_bin b on b.id = s.bin_id
      where s.company = c and b.location = v_loc group by 1),
    ac as (select f.item_code, sum(f.qty) q from bi.fact_stock f where f.company = c and f.location = v_loc group by 1),
    dou as (select u.item_code, sum(u.qty) q from ops.wh_do_unpicked(c) u where v_loc = ops.podo_main_loc(c) group by 1),
    k as (select item_code from ac union select item_code from shelved union select item_code from pend),
    r as (
      select k.item_code, coalesce(i.description, k.item_code) description, i.base_uom uom,
             coalesce(ac.q, 0) ac_qty, coalesce(pend.q, 0) pending, coalesce(dou.q, 0) do_unpicked,
             coalesce(ac.q, 0) + coalesce(pend.q, 0) + coalesce(dou.q, 0) expected,
             coalesce(shelved.q, 0) shelved, coalesce(shelved.nb, 0) n_bins
      from k
      left join ac on ac.item_code = k.item_code
      left join pend on pend.item_code = k.item_code
      left join dou on dou.item_code = k.item_code
      left join shelved on shelved.item_code = k.item_code
      left join bi.dim_item i on i.company = c and i.item_code = k.item_code),
    f as (
      select * from r
      where ((flt = 'all' and (r.expected <> 0 or r.shelved <> 0))
          or (flt = 'over' and r.shelved > greatest(r.expected, 0))
          or (flt = 'unshelved' and r.expected > r.shelved))
        and (q = '' or upper(r.item_code) like '%' || q || '%' or upper(r.description) like '%' || q || '%'))
    select jsonb_build_object(
      'company', c, 'location', v_loc, 'filter', flt, 'page', pg, 'page_size', size,
      'total', (select count(*) from f),
      'counts', jsonb_build_object(
        'over', (select count(*) from r where r.shelved > greatest(r.expected, 0)),
        'unshelved', (select count(*) from r where r.expected > r.shelved),
        'shelved', (select count(*) from r where r.shelved > 0),
        'items', (select count(*) from r where r.expected > 0)),
      'synced_at', ops.wh_synced_at(c),
      'rows', coalesce((select jsonb_agg(to_jsonb(x) order by abs(x.shelved - x.expected) desc, x.item_code)
                        from (select * from f order by abs(f.shelved - f.expected) desc, f.item_code
                              offset pg * size limit size) x), '[]'::jsonb)));
end $$;

-- ============================================================ 6. 仓库地图
-- p: {company, location} → {layout, shelves: [{key, zone, shelf, levels: [{bin_id, level, code, items, qty}], items, qty}], locations}
-- 一个「货架」方块 = 同一区同一货架的所有层
create or replace function public.ops_wh_map_get(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  c text;
  v_loc text := nullif(trim(coalesce(p->>'location', '')), '');
begin
  me := ops.require_level('warehouse', 'view');
  c := ops.wh_company(me, p->>'company');
  if v_loc is null then
    select b.location into v_loc from ops.wh_bin b left join ops.wh_location wl on wl.company = b.company and wl.code = b.location
    where b.company = c and b.active order by coalesce(wl.sort, 50), b.location limit 1;
  end if;
  return jsonb_build_object(
    'company', c, 'location', v_loc,
    'can_edit', ops.level_rank(ops.module_level(me, 'warehouse')) >= 3,
    'locations', coalesce((
      select jsonb_agg(jsonb_build_object('location', x.location, 'shelves', x.n) order by x.sort, x.location)
      from (select b.location, count(distinct b.zone || '::' || b.shelf) n, min(coalesce(wl.sort, 50)) sort
            from ops.wh_bin b left join ops.wh_location wl on wl.company = b.company and wl.code = b.location
            where b.company = c and b.active group by b.location) x), '[]'::jsonb),
    'layout', coalesce((select m.layout from ops.wh_map m where m.company = c and m.location = v_loc), '{}'::jsonb),
    'updated_at', (select m.updated_at from ops.wh_map m where m.company = c and m.location = v_loc),
    'shelves', coalesce((
      select jsonb_agg(jsonb_build_object('key', g.zone || '::' || g.shelf, 'zone', g.zone, 'shelf', g.shelf,
          'levels', g.levels, 'items', g.items, 'qty', g.qty) order by g.zone, length(g.shelf), g.shelf)
      from (
        select b.zone, b.shelf,
          jsonb_agg(jsonb_build_object('bin_id', b.id, 'level', b.level, 'code', b.code,
              'items', (select count(*) from ops.wh_bin_stock s where s.bin_id = b.id and s.qty > 0),
              'qty', (select coalesce(sum(s.qty), 0) from ops.wh_bin_stock s where s.bin_id = b.id))
            order by length(b.level), b.level) levels,
          (select count(*) from ops.wh_bin_stock s join ops.wh_bin b2 on b2.id = s.bin_id
           where b2.company = c and b2.location = v_loc and b2.zone = b.zone and b2.shelf = b.shelf and s.qty > 0) items,
          (select coalesce(sum(s.qty), 0) from ops.wh_bin_stock s join ops.wh_bin b2 on b2.id = s.bin_id
           where b2.company = c and b2.location = v_loc and b2.zone = b.zone and b2.shelf = b.shelf) qty
        from ops.wh_bin b
        where b.company = c and b.location = v_loc and b.active
        group by b.zone, b.shelf) g), '[]'::jsonb));
end $$;

-- 点一个货架方块：每层上面的商品与数量。p: {company, location, zone, shelf}
create or replace function public.ops_wh_map_shelf(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  c text;
  v_loc text := trim(coalesce(p->>'location', ''));
  v_zone text := upper(trim(coalesce(p->>'zone', '')));
  v_shelf text := upper(trim(coalesce(p->>'shelf', '')));
begin
  me := ops.require_level('warehouse', 'view');
  c := ops.wh_company(me, p->>'company');
  return jsonb_build_object('location', v_loc, 'zone', v_zone, 'shelf', v_shelf,
    'levels', coalesce((
      select jsonb_agg(ops.wh_bin_json(b) || jsonb_build_object('items', coalesce((
          select jsonb_agg(jsonb_build_object('item_code', s.item_code, 'description', coalesce(i.description, s.item_code),
              'uom', i.base_uom, 'qty', s.qty) order by s.qty desc, s.item_code)
          from ops.wh_bin_stock s left join bi.dim_item i on i.company = s.company and i.item_code = s.item_code
          where s.bin_id = b.id and s.qty > 0), '[]'::jsonb))
        order by length(b.level), b.level)
      from ops.wh_bin b
      where b.company = c and b.location = v_loc and b.zone = v_zone and b.shelf = v_shelf and b.active), '[]'::jsonb));
end $$;

-- 地图上找商品：代号 / 纸箱条码完全相同优先，不然品名每个字都要出现（最多 20 个商品）；每个商品列出有货的货架（多的在前）
-- p: {company, location?, q}
create or replace function public.ops_wh_map_find(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  c text;
  v_loc text := nullif(trim(coalesce(p->>'location', '')), '');
  q text := trim(coalesce(p->>'q', ''));
  exact text;
  words text[];
begin
  me := ops.require_level('warehouse', 'view');
  c := ops.wh_company(me, p->>'company');
  if q = '' then
    return '[]'::jsonb;
  end if;
  exact := ops.wh_resolve(c, q);
  words := regexp_split_to_array(upper(q), '\s+');
  return coalesce((
    select jsonb_agg(jsonb_build_object('item_code', it.item_code, 'description', it.description, 'uom', it.uom,
        'bins', coalesce((
          select jsonb_agg(ops.wh_bin_json(b) || jsonb_build_object('qty', s.qty) order by s.qty desc, b.code)
          from ops.wh_bin_stock s join ops.wh_bin b on b.id = s.bin_id
          where s.company = c and s.item_code = it.item_code and s.qty > 0 and b.active
            and (v_loc is null or b.location = v_loc)), '[]'::jsonb))
      order by it.rk, it.item_code)
    from (
      select i.item_code, coalesce(i.description, i.item_code) description, i.base_uom uom,
             case when i.item_code = exact then 0 else 1 end rk
      from bi.dim_item i
      where i.company = c
        and (i.item_code = exact
             or (exact is null and not exists (
                   select 1 from unnest(words) w
                   where position(w in upper(i.item_code || ' ' || coalesce(i.description, ''))) = 0)))
        and exists (select 1 from ops.wh_bin_stock s join ops.wh_bin b on b.id = s.bin_id
                    where s.company = c and s.item_code = i.item_code and s.qty > 0 and b.active
                      and (v_loc is null or b.location = v_loc))
      order by 4, i.item_code
      limit 20) it), '[]'::jsonb);
end $$;

-- 存地图排版（可审批）。p: {company, location, layout}
create or replace function public.ops_wh_map_save(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  c text;
  v_loc text := trim(coalesce(p->>'location', ''));
  lay jsonb := p->'layout';
begin
  me := ops.require_level('warehouse', 'approve');
  c := ops.wh_company(me, p->>'company');
  if not exists (select 1 from ops.wh_location wl where wl.company = c and wl.code = v_loc) then
    raise exception '没有这个仓位。' using errcode = '22023';
  end if;
  if lay is null or jsonb_typeof(lay) <> 'object' or length(lay::text) > 200000 then
    raise exception '地图资料不对。' using errcode = '22023';
  end if;
  insert into ops.wh_map (company, location, layout, updated_by, updated_at)
  values (c, v_loc, lay, me.id, now())
  on conflict (company, location) do update set layout = excluded.layout, updated_by = excluded.updated_by, updated_at = now();
  return jsonb_build_object('ok', true, 'updated_at', now());
end $$;

-- ============================================================ 7. 权限
revoke all on function ops.wh_bin_part(text, text, boolean) from public, anon, authenticated;
revoke all on function ops.wh_bin_code(text, text, text) from public, anon, authenticated;
revoke all on function ops.wh_bin_find(text, text, text) from public, anon, authenticated;
revoke all on function ops.wh_bin_expected(text, text, text) from public, anon, authenticated;
revoke all on function ops.wh_bin_shelved(text, text, text) from public, anon, authenticated;
revoke all on function ops.wh_bin_apply(ops.staff, bigint, text, numeric, text, text, bigint, text, numeric) from public, anon, authenticated;
revoke all on function ops.wh_bin_reverse(ops.staff, text, bigint, text) from public, anon, authenticated;
revoke all on function ops.wh_move_bin_reverse() from public, anon, authenticated;
revoke all on function ops.wh_bin_json(ops.wh_bin) from public, anon, authenticated;
revoke all on function ops.wh_bin_summary(text) from public, anon, authenticated;
revoke all on function ops.wh_bin_do(ops.staff, text, jsonb, bigint) from public, anon, authenticated;
revoke all on function ops.wh_do_unpicked(text) from public, anon, authenticated;
revoke all on function ops.wh_do_unpicked_item(text, text, text) from public, anon, authenticated;
do $$
declare
  f text;
begin
  foreach f in array array['ops_wh_bins(jsonb)', 'ops_wh_bin_save(jsonb)', 'ops_wh_bin_bulk(jsonb)', 'ops_wh_bin_get(jsonb)',
                           'ops_wh_item_bins(jsonb)', 'ops_wh_bin_op(jsonb)', 'ops_wh_bin_batch(jsonb)', 'ops_wh_bin_import(jsonb)',
                           'ops_wh_bin_recon(jsonb)', 'ops_wh_map_get(jsonb)', 'ops_wh_map_shelf(jsonb)', 'ops_wh_map_find(jsonb)',
                           'ops_wh_map_save(jsonb)', 'ops_wh_bin_undo(text,bigint)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
revoke all on sequence ops.wh_bin_ref_seq from public, anon, authenticated;
