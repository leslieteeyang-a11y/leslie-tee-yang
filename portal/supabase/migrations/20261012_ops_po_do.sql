-- 营运系统：订货升级第一段 — 分店、厂家 DO（装箱单）、分到各分店、在路上、厂家问题。
-- 套用到 Supabase 的 migration 名称：ops_po_do（约 90 KB，一次送会被挡：照「-- ====」分五段依序套用，每段 ≤ 24 KB：
--   ops_po_do_1 = 开头 + §1–2、ops_po_do_2 = §3、ops_po_do_3 = §4–5、ops_po_do_4 = §6–7、ops_po_do_5 = §8–12；
--   §12 的权限要在最后一段）。
--
-- 使用者 2026-10-12 决定（第一段）：
--   * 分店 ops.outlet：总部仓库 HQ、Batu 店、JB、KL Puchong。总部账套的 PO 行用 AutoCount 仓位分辨「替哪间分店订」：
--     HQ / SRGADING = 总部；PRE (JB) / JB / JB RESER = JB；PRE (BATU) / BATU = Batu；PRE (PUCHONG) / PUCHONG = Puchong；
--     其他仓位（DEFECTS、DISPLAY…）都算总部。HOMEWORKSSOUTHERN 账套的 PO 整本都算 JB。
--   * 厂家出货时，采购开一张「厂家到货」：选厂家 → 选这家的 PO → 上传厂家 DO（Excel 在浏览器读；PDF / 照片先当附件）→
--     每个型号填这批出了几件、分给哪间分店（同型号可拆）→ 确认。确认后：在路上、ETA 给分店看；少发 / 多发 / 发错型号自动记成厂家问题。
--   * AutoCount 仍只读：这里不写 bi.*。AutoCount 的「未到」要等员工开 GRN 才减少，所以「在路上」自己记（见 §3）。
--   * 新画面与函数一律不回传单价 / 金额。
-- 状态：DO draft 草稿 → confirmed 已确认（在路上）→ arrived 已到货；草稿可 cancelled 取消（不删资料）；
--       已确认的可由订货「可审批」退回草稿（自动产生、还没人处理的问题改成 void）。

-- ==================================================================== 1. 分店
create table ops.outlet (
  code text primary key check (code ~ '^[A-Z][A-Z0-9_]{1,15}$'),
  name text not null check (length(trim(name)) > 0),
  short_name text not null default '',              -- 表头用：「总部 订」「JB 订」
  company text not null check (company in ('HOMEWORKSSB', 'HOMEWORKSSOUTHERN')),
  po_locations text[] not null default '{}',        -- PO / 库存仓位里代表「替这间分店订」的（大写）
  own_location text,                                -- 分店自己的仓位（第二段用）
  pre_location text,                                -- 总部账套里替这间分店预留的仓位（第二段用）
  staff_branch text,                                -- 哪个 ops.staff.branch 的人看这间分店（空 = 只有总部 / ALL 看）
  sort int not null default 0,
  active boolean not null default true
);
alter table ops.outlet enable row level security;

insert into ops.outlet (code, name, short_name, company, po_locations, own_location, pre_location, staff_branch, sort) values
  ('HQ', '总部仓库', '总部', 'HOMEWORKSSB', array['HQ', 'SRGADING'], 'HQ', null, 'HOMEWORKSSB', 10),
  ('BATU', 'Batu 店', 'Batu', 'HOMEWORKSSB', array['PRE (BATU)', 'BATU'], 'BATU', 'PRE (BATU)', 'HOMEWORKSSB', 20),
  ('JB', 'JB', 'JB', 'HOMEWORKSSOUTHERN', array['PRE (JB)', 'JB', 'JB RESER'], 'JB', 'PRE (JB)', 'HOMEWORKSSOUTHERN', 30),
  ('PUCHONG', 'KL Puchong', 'Puchong', 'HOMEWORKSSB', array['PRE (PUCHONG)', 'PUCHONG'], 'PUCHONG', 'PRE (PUCHONG)', null, 40)
on conflict (code) do nothing;

-- PO 行（账套 + 仓位）→ 分店代号。总部账套：仓位写在哪间分店的 po_locations；都没有 = 总部。其他账套：整本属于那间分店。
create or replace function ops.outlet_of(p_company text, p_location text) returns text
language sql stable set search_path = '' as $$
  select coalesce(
    (select o.code from ops.outlet o
      where case when p_company = 'HOMEWORKSSB' then upper(trim(coalesce(p_location, ''))) = any (o.po_locations)
                 else o.company = p_company end
      order by o.sort, o.code limit 1),
    'HQ')
$$;

-- 在路上 / 分店资料谁看得到：总部（HOMEWORKSSB）与 ALL 看全部；其他分店的人只看 staff_branch 是自己的分店
create or replace function ops.outlet_visible(p_staff ops.staff, p_outlet text) returns boolean
language sql stable set search_path = '' as $$
  select coalesce(p_staff.branch in ('ALL', 'HOMEWORKSSB')
                  or exists (select 1 from ops.outlet o where o.code = p_outlet and o.staff_branch = p_staff.branch), false)
$$;

create or replace function ops.podo_outlets() returns jsonb
language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('code', o.code, 'name', o.name, 'short_name', o.short_name,
                                               'company', o.company, 'active', o.active) order by o.sort, o.code), '[]'::jsonb)
  from ops.outlet o
$$;

-- ==================================================================== 2. 厂家 DO、分配、厂家问题
create table ops.supplier_do (
  id bigint generated always as identity primary key,
  company text not null check (company in ('HOMEWORKSSB', 'HOMEWORKSSOUTHERN')),   -- PO 的账套
  creditor_code text not null,
  supplier_name text not null default '',
  do_no text not null default '',                  -- 厂家 DO / 装箱单号
  do_date date,
  eta date,
  shipment_id bigint references ops.shipment(id),  -- 可挂货柜；货柜有 ETA 就以货柜为准（与 PO 清单同规则）
  status text not null default 'draft' check (status in ('draft', 'confirmed', 'arrived', 'cancelled')),
  po_nos text[] not null default '{}',
  -- 每个型号一行：{item_code(空 = 对不上 PO), description, shipped, alloc{分店: 数量}, src_code, src_desc, src_row,
  --              expected_code(对不上的行：本来应该是哪个型号), note}。草稿整份覆盖（重存不会多出资料）。
  items jsonb not null default '[]'::jsonb,
  files jsonb not null default '[]'::jsonb,        -- [{path, name, size, type}]，Storage bucket ops-po
  remark text not null default '',
  client_key text unique,                          -- 前端产生；断线重送同一张不会多开
  created_by bigint references ops.staff(id),
  created_at timestamptz not null default now(),
  updated_by bigint references ops.staff(id),
  updated_at timestamptz not null default now(),
  confirmed_by bigint references ops.staff(id),
  confirmed_at timestamptz,
  arrived_by bigint references ops.staff(id),
  arrived_at timestamptz,
  arrive_note text not null default '',
  cancelled_by bigint references ops.staff(id),
  cancelled_at timestamptz,
  cancel_reason text not null default ''
);
create unique index supplier_do_no_uq on ops.supplier_do (company, creditor_code, upper(do_no))
  where status <> 'cancelled' and do_no <> '';
create index supplier_do_po_idx on ops.supplier_do using gin (po_nos);
create index supplier_do_status_idx on ops.supplier_do (status, company);

-- 确认时把每个型号分给各分店的数量记在 PO 行上（FIFO）。void = 退回草稿后作废（不删）。
create table ops.supplier_do_apply (
  id bigint generated always as identity primary key,
  do_id bigint not null references ops.supplier_do(id),
  company text not null,
  item_code text not null,
  outlet text not null references ops.outlet(code),   -- 分给哪间分店
  qty numeric not null check (qty > 0),
  dtl_key bigint,                                    -- 记在哪一行 PO（空 = 超出 PO 的数量，多发）
  po_no text,
  line_outlet text,                                  -- 那行 PO 原本是哪间分店订的
  transferred_at numeric,                            -- 确认当下这行已收的（扣掉看起来是这张 DO 的 GRN）：只用来分到各行 / 分店
  rcv_base numeric,                                  -- 起算点：同厂家这个型号所有 PO 累计已收到这里为止的不是这张的货（见 §3）
  void boolean not null default false,
  created_at timestamptz not null default now()
);
create index supplier_do_apply_do_idx on ops.supplier_do_apply (do_id);
create index supplier_do_apply_line_idx on ops.supplier_do_apply (company, dtl_key) where not void;
create index supplier_do_apply_outlet_idx on ops.supplier_do_apply (outlet) where not void;

create table ops.supplier_issue (
  id bigint generated always as identity primary key,
  company text not null,
  creditor_code text not null,
  supplier_name text not null default '',
  do_id bigint references ops.supplier_do(id),
  kind text not null check (kind in ('short', 'over', 'wrong', 'damaged')),   -- 少发 / 多发 / 发错型号 / 坏货
  item_code text,                                   -- 型号（发错型号：本来应该收到的，可空）
  received_code text not null default '',          -- 发错型号：实际收到的型号
  description text not null default '',
  po_nos text[] not null default '{}',
  ordered numeric,                                  -- 订：确认时所选 PO 还没出的数量
  received numeric,                                 -- 到：这张 DO 的出货数量
  qty numeric not null check (qty > 0),
  decision text check (decision in ('pending', 'await', 'cancelled')),       -- 只有少发：未决定 / 厂家会补 / 取消（下次再订）
  status text not null default 'open' check (status in ('open', 'resolved', 'void')),
  resolved_qty numeric not null default 0,          -- 少发（厂家会补）后来的 DO 补了多少
  resolutions jsonb not null default '[]'::jsonb,   -- [{do_id, do_no, qty, at}]
  auto boolean not null default false,              -- 确认 DO 时自动产生
  note text not null default '',
  action_note text not null default '',             -- 处理说明
  created_by bigint references ops.staff(id),
  created_at timestamptz not null default now(),
  decided_by bigint references ops.staff(id),
  decided_at timestamptz,
  resolved_by bigint references ops.staff(id),
  resolved_at timestamptz,
  resolved_auto boolean not null default false,     -- 被后来的 DO 自动补齐
  updated_at timestamptz not null default now(),
  check ((kind = 'short') = (decision is not null))
);
create index supplier_issue_sup_idx on ops.supplier_issue (company, creditor_code, item_code) where status <> 'void';
create index supplier_issue_do_idx on ops.supplier_issue (do_id);

alter table ops.supplier_do enable row level security;
alter table ops.supplier_do_apply enable row level security;
alter table ops.supplier_issue enable row level security;

-- ==================================================================== 3. 在路上的算法与小工具
-- 问题：AutoCount 的「未到」要等员工开 GRN 才减少（BI 一天同步几次）；只看 AutoCount 会把已出货的再算一次「还没出」。
-- 做法：确认 DO 时把各分店的数量记在 PO 行上（supplier_do_apply），在路上自己算。仓库开 GRN 不一定开在采购分的那一行
--   （总部 / PRE (JB) 同一张 PO 拆两行、或开到另一张 PO），所以**总数**照「同厂家 + 同型号」所有 PO 一起算：
--   * 累计已收 T = 这个厂家这个型号所有 PO 行的 transferred_qty 合计（不论哪一行）。
--   * 每张有效 DO（已确认 / 已到货）有一个起算点 base = 确认时的 T − DO 日期（含）之后的 GRN（bi.fact_po_receipt；
--     本地货常常先开 GRN 才登记 DO，那些 GRN 就是这张的货）；退回草稿再确认沿用第一次的（取小的）。
--   * 照 base 由小到大（同 base 照确认先后）走一遍：两个 base 之间多收的件数先抵前面的 DO（先出先到），抵完多的丢掉
--     （没登记 DO 的货，不会留到后面去抵新的 DO）；最后 T − 最后一个 base 再抵一次 → 剩下的 = 这个型号在路上。
--   * 每张 DO 算进去的 = min(记在 PO 行的数量, 出货 − 这张已记的坏货 / 到货少)：超出 PO 的（多发）不会有 GRN，坏的不会入库。
--   各行 / 各分店怎么分：先照「这行记了多少、这行收了多少」估（采购分在哪行、仓库也开在哪行时就是准的），再调成上面的总数
--   （多了从最早的行扣，少了补在有记 DO 的行），最多到那行未到为止。还可以出 = AutoCount 未到 − 在路上。
--   已到货的 DO 照样算，直到 GRN 追上（或记了坏货 / 到货少）。
--   限制：没登记 DO 就开 GRN 的货，若刚好在某张 DO 还在路上时收，会被当成那张的货（少算在路上）；DO 日期写错（太早）同理。

-- 某厂家某型号的起算点（p_do 退回草稿过：沿用它作废的分配里最小的）
create or replace function ops.podo_base(p_company text, p_creditor text, p_item text, p_basis date, p_do bigint)
returns numeric language sql stable set search_path = '' as $$
  select least(
    greatest(0, coalesce((select sum(coalesce(l.transferred_qty, 0)) from bi.fact_po_line l
                          where l.company = p_company and l.creditor_code = p_creditor and l.item_code = p_item), 0)
              - coalesce((select sum(r.qty) from bi.fact_po_receipt r
                          where r.company = p_company and r.item_code = p_item and r.rcv_date >= p_basis
                            and r.po_no in (select l.po_no from bi.fact_po_line l
                                            where l.company = p_company and l.creditor_code = p_creditor)), 0)),
    (select min(a.rcv_base) from ops.supplier_do_apply a where a.do_id = p_do and a.item_code = p_item))
$$;

-- 每个型号在路上的总数（不算 p_skip_do）。p_extra {型号: base}：假设那张 DO 在这个 base 出了很多，
-- absorbed = 它最多能吃掉的已收（= 这张 DO 已经开了 GRN 的数量；确认时放回「还可以出」）。
create or replace function ops.podo_pool(p_company text, p_creditor text, p_skip_do bigint, p_extra jsonb default null)
returns table (item_code text, in_transit numeric, absorbed numeric)
language plpgsql stable set search_path = '' as $$
declare
  q constant numeric := 1e12;
  r record;
  cur text;
  b1 numeric;            -- 不含假设的那张
  b2 numeric;            -- 含
  v_last numeric;
  v_tot numeric;
  v_x boolean;
begin
  for r in
    with tr as (select l.item_code, sum(coalesce(l.transferred_qty, 0)) as t from bi.fact_po_line l
                where l.company = p_company and l.creditor_code = p_creditor and nullif(trim(l.item_code), '') is not null
                group by l.item_code),
    rd as (select i.do_id, i.item_code, sum(i.qty) as q from ops.supplier_issue i
           where i.company = p_company and i.creditor_code = p_creditor and i.status <> 'void' and i.do_id is not null
             and (i.kind = 'damaged' or (i.kind = 'short' and not i.auto))
           group by i.do_id, i.item_code),
    ev as (select a.item_code, min(a.rcv_base) as base, max(d.confirmed_at) as at, d.id, false as x,
                  least(coalesce(sum(a.qty) filter (where a.dtl_key is not null), 0), sum(a.qty) - coalesce(max(rd.q), 0)) as qty
           from ops.supplier_do_apply a
           join ops.supplier_do d on d.id = a.do_id
           left join rd on rd.do_id = a.do_id and rd.item_code = a.item_code
           where d.company = p_company and d.creditor_code = p_creditor and not a.void
             and d.status in ('confirmed', 'arrived') and d.id is distinct from p_skip_do
           group by a.item_code, d.id
           union all
           select x.key, (x.value #>> '{}')::numeric, now(), 0, true, q
           from jsonb_each(coalesce(p_extra, '{}'::jsonb)) x where jsonb_typeof(x.value) = 'number')
    select ev.*, coalesce(tr.t, 0) as t from ev left join tr on tr.item_code = ev.item_code
    where ev.qty > 0 order by ev.item_code, ev.base, ev.at, ev.id
  loop
    if cur is distinct from r.item_code then
      if cur is not null then
        item_code := cur;
        in_transit := greatest(0, b1 - greatest(0, v_tot - v_last));
        absorbed := case when v_x then in_transit + q - greatest(0, b2 - greatest(0, v_tot - v_last)) else 0 end;
        return next;
      end if;
      cur := r.item_code; b1 := 0; b2 := 0; v_last := coalesce(r.base, 0); v_tot := r.t; v_x := false;
    end if;
    b1 := greatest(0, b1 - greatest(0, coalesce(r.base, 0) - v_last));
    b2 := greatest(0, b2 - greatest(0, coalesce(r.base, 0) - v_last));
    v_last := greatest(v_last, coalesce(r.base, 0));
    b2 := b2 + r.qty;
    if r.x then v_x := true; else b1 := b1 + r.qty; end if;
  end loop;
  if cur is not null then
    item_code := cur;
    in_transit := greatest(0, b1 - greatest(0, v_tot - v_last));
    absorbed := case when v_x then in_transit + q - greatest(0, b2 - greatest(0, v_tot - v_last)) else 0 end;
    return next;
  end if;
end $$;

-- 某厂家（所选 PO，空 = 全部）的 PO 行：分店、AutoCount 未到、在路上（不算 p_skip_do）、还可以出。
-- p_basis（DO 日期）有给：这张 DO 已经开了 GRN 的数量（extra）放回所选的行（先开的单先放，最多到那行已收）。
create or replace function ops.podo_lines(p_company text, p_creditor text, p_po_nos text[], p_skip_do bigint,
                                          p_basis date default null)
returns table (dtl_key bigint, po_no text, po_date date, item_code text, description text, uom text, outlet text,
               qty numeric, transferred numeric, open_qty numeric, in_transit numeric, extra numeric, remaining numeric,
               rcv_base numeric)
language sql stable set search_path = '' as $$
  with al as (
    select l.dtl_key, l.po_no, l.po_date, l.item_code, l.description, l.uom, l.location, coalesce(l.cancelled, false) as cancelled,
           coalesce(l.qty, 0) as qty, coalesce(l.transferred_qty, 0) as tr
    from bi.fact_po_line l
    where l.company = p_company and l.creditor_code = p_creditor and nullif(trim(l.item_code), '') is not null),
  sel as (select * from al where not al.cancelled and (p_po_nos is null or al.po_no = any (p_po_nos))),
  bs as (select s.item_code, sum(s.tr) as tr_sel, ops.podo_base(p_company, p_creditor, s.item_code, p_basis, p_skip_do) as base
         from sel s where p_basis is not null group by s.item_code),
  pool as (select * from ops.podo_pool(p_company, p_creditor, p_skip_do, (select jsonb_object_agg(b.item_code, b.base) from bs b))),
  ap as (select a.dtl_key, sum(a.qty) as applied, (array_agg(a.transferred_at order by a.rcv_base, a.id))[1] as first_tr,
                max(a.id) as last_id
         from ops.supplier_do_apply a join ops.supplier_do d on d.id = a.do_id
         where d.company = p_company and d.creditor_code = p_creditor and not a.void and a.dtl_key is not null
           and d.status in ('confirmed', 'arrived') and d.id is distinct from p_skip_do
         group by a.dtl_key),
  op as (select al.dtl_key, al.item_code, al.po_date, al.po_no, al.qty - al.tr as open, ap.last_id,
                least(al.qty - al.tr, greatest(0, coalesce(ap.applied, 0) - greatest(0, al.tr - coalesce(ap.first_tr, al.tr)))) as est
         from al left join ap on ap.dtl_key = al.dtl_key
         where not al.cancelled and al.qty > al.tr),
  df as (select o.item_code, least(coalesce(max(p.in_transit), 0), sum(o.open)) - sum(o.est) as diff
         from op o left join pool p on p.item_code = o.item_code group by o.item_code),
  tt as (select o.dtl_key,
                case when f.diff < 0 then o.est - least(o.est, greatest(0, -f.diff - coalesce(sum(o.est) over w1, 0)))
                     else o.est + least(o.open - o.est, greatest(0, f.diff - coalesce(sum(o.open - o.est) over w2, 0))) end as t
         from op o join df f on f.item_code = o.item_code
         window w1 as (partition by o.item_code order by o.po_date, o.po_no, o.dtl_key rows between unbounded preceding and 1 preceding),
                w2 as (partition by o.item_code order by o.last_id desc nulls last, o.po_date, o.po_no, o.dtl_key
                       rows between unbounded preceding and 1 preceding)),
  ex as (select s.dtl_key, b.base,
                least(s.tr, greatest(0, least(coalesce(p.absorbed, 0), b.tr_sel) - coalesce(sum(s.tr) over w3, 0))) as x
         from sel s join bs b on b.item_code = s.item_code left join pool p on p.item_code = s.item_code
         window w3 as (partition by s.item_code order by s.po_date, s.po_no, s.dtl_key rows between unbounded preceding and 1 preceding))
  select s.dtl_key, s.po_no, s.po_date, s.item_code, coalesce(i.description, s.description), s.uom,
         ops.outlet_of(p_company, s.location), s.qty, s.tr, greatest(s.qty - s.tr, 0), coalesce(t.t, 0), coalesce(e.x, 0),
         greatest(s.qty - s.tr, 0) - coalesce(t.t, 0) + coalesce(e.x, 0), e.base
  from sel s
  left join tt t on t.dtl_key = s.dtl_key
  left join ex e on e.dtl_key = s.dtl_key
  left join bi.dim_item i on i.company = p_company and i.item_code = s.item_code
$$;

-- 已经记过、还欠的（同厂家同型号、PO 有重叠）：少发（还没补的；已决定取消的也算）+ 还没处理的坏货。
-- 确认时「所选 PO 出完这张还欠的」跟它比：少了才补记少发，多了就扣掉还开着的少发。
create or replace function ops.podo_flag(p_company text, p_creditor text, p_item text, p_pos text[]) returns numeric
language sql stable set search_path = '' as $$
  select coalesce(sum(s.qty - s.resolved_qty), 0) from ops.supplier_issue s
  where s.company = p_company and s.creditor_code = p_creditor and s.item_code = p_item and s.po_nos && p_pos
    and ((s.kind = 'short' and s.status in ('open', 'resolved')) or (s.kind = 'damaged' and s.status = 'open'))
$$;

-- 所选 PO 的型号清单（一型号一行）+ 各分店还没出的数量。不含单价。
--   received_do = 这张 DO 已经开了 GRN 的（已放回 remaining）；owed = 已记还开着的少发 + 坏货；
--   flagged / fillable / await_elsewhere：前端预估确认后的少发 / 多发（flagged 同 ops.podo_flag；fillable = 别张 DO 还开着的
--   少发；await_elsewhere = 别张 PO「厂家会补」的少发：超出的先补它们）。
create or replace function ops.podo_items(p_company text, p_creditor text, p_po_nos text[], p_skip_do bigint,
                                          p_basis date default null) returns jsonb
language sql stable set search_path = '' as $$
  with ln as (select * from ops.podo_lines(p_company, p_creditor, coalesce(p_po_nos, '{}'), p_skip_do, p_basis)),
  bo as (select ln.item_code, ln.outlet, sum(ln.open_qty) as open_qty, sum(ln.in_transit) as in_transit,
                sum(ln.remaining) as remaining
         from ln group by ln.item_code, ln.outlet),
  it as (select ln.item_code, min(ln.description) as description, min(ln.uom) as uom, sum(ln.qty) as ordered,
                sum(ln.transferred) as received, sum(ln.open_qty) as open_qty, sum(ln.in_transit) as in_transit,
                sum(ln.extra) as extra, sum(ln.remaining) as remaining, min(ln.po_date) as d1, min(ln.po_no) as p1,
                min(ln.dtl_key) as k1, array_agg(distinct ln.po_no) as po_nos
         from ln group by ln.item_code),
  fl as (select it.item_code,
                coalesce(sum(s.qty - s.resolved_qty) filter (where s.status = 'open'), 0) as owed,
                coalesce(sum(s.qty - s.resolved_qty) filter (where s.kind = 'short' and s.status = 'open'
                                                              and s.do_id is distinct from p_skip_do), 0) as fillable
         from it join ops.supplier_issue s on s.company = p_company and s.creditor_code = p_creditor
           and s.item_code = it.item_code and s.po_nos && it.po_nos
           and ((s.kind = 'short' and s.status in ('open', 'resolved')) or (s.kind = 'damaged' and s.status = 'open'))
         group by it.item_code)
  select coalesce(jsonb_agg(jsonb_build_object(
           'item_code', it.item_code, 'description', it.description, 'uom', it.uom, 'po_nos', to_jsonb(it.po_nos),
           'ordered', it.ordered, 'received', it.received, 'open_qty', it.open_qty, 'in_transit', it.in_transit,
           'received_do', it.extra, 'remaining', it.remaining, 'owed', coalesce(fl.owed, 0), 'fillable', coalesce(fl.fillable, 0),
           'flagged', ops.podo_flag(p_company, p_creditor, it.item_code, it.po_nos),
           'await_elsewhere', (select coalesce(sum(s.qty - s.resolved_qty), 0) from ops.supplier_issue s
                               where s.company = p_company and s.creditor_code = p_creditor and s.item_code = it.item_code
                                 and s.kind = 'short' and s.decision = 'await' and s.status = 'open'
                                 and s.do_id is distinct from p_skip_do and not s.po_nos && it.po_nos),
           'by_outlet', (select coalesce(jsonb_object_agg(b.outlet, jsonb_build_object('open', b.open_qty,
                                          'in_transit', b.in_transit, 'remaining', b.remaining)), '{}'::jsonb)
                         from bo b where b.item_code = it.item_code and (b.open_qty > 0 or b.remaining > 0)),
           'single_outlet', (select case when count(*) filter (where b.remaining > 0) = 1
                                           then max(b.outlet) filter (where b.remaining > 0)
                                         when count(*) filter (where b.remaining > 0) = 0
                                              and count(*) filter (where b.open_qty > 0) = 1
                                           then max(b.outlet) filter (where b.open_qty > 0) end
                             from bo b where b.item_code = it.item_code))
         order by it.d1, it.p1, it.k1), '[]'::jsonb)
  from it left join fl on fl.item_code = it.item_code
$$;

-- DO 的「DO 日期」：没填就用开单那天（吉隆坡）
create or replace function ops.podo_basis(d ops.supplier_do) returns date
language sql stable set search_path = '' as $$
  select coalesce(d.do_date, (d.created_at at time zone 'Asia/Kuala_Lumpur')::date)
$$;

create or replace function ops.podo_company(p_me ops.staff, p_company text) returns text
language plpgsql stable set search_path = '' as $$
declare
  c text := coalesce(nullif(p_company, ''), case when p_me.branch = 'ALL' then 'HOMEWORKSSB' else p_me.branch end);
begin
  if c not in ('HOMEWORKSSB', 'HOMEWORKSSOUTHERN') or not ops.sees_company(p_me, c) then
    raise exception '请选择你分店的公司。' using errcode = '42501';
  end if;
  return c;
end $$;

-- 数量：数字或数字字串；空 = null；负数 / 不是数字就报错
create or replace function ops.podo_num(p_val jsonb, p_what text) returns numeric
language plpgsql immutable set search_path = '' as $$
declare
  t text := case when p_val is null or jsonb_typeof(p_val) = 'null' then '' else trim(p_val #>> '{}') end;
  v numeric;
begin
  if t = '' then
    return null;
  end if;
  if jsonb_typeof(p_val) not in ('number', 'string') or t !~ '^-?[0-9]+(\.[0-9]+)?$' then
    raise exception '%不是数字。', p_what using errcode = '22023';
  end if;
  v := t::numeric;
  if v < 0 then
    raise exception '%不能是负数。', p_what using errcode = '22023';
  end if;
  return v;
end $$;

create or replace function ops.podo_fmt(p numeric) returns text
language sql immutable set search_path = '' as $$ select coalesce(trim_scale(p)::text, '0') $$;

create or replace function ops.podo_who(p_id bigint) returns text
language sql stable set search_path = '' as $$ select s.name from ops.staff s where s.id = p_id $$;

-- DO 表头 + 这个人能做什么
create or replace function ops.podo_json(p_me ops.staff, d ops.supplier_do) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', d.id, 'company', d.company, 'creditor_code', d.creditor_code, 'supplier_name', d.supplier_name,
    'do_no', d.do_no, 'do_date', d.do_date, 'eta', d.eta, 'shipment_id', d.shipment_id,
    'shipment_name', s.name, 'shipment_eta', s.eta, 'eta_effective', coalesce(s.eta, d.eta),
    'eta_source', case when s.eta is not null then 'shipment' when d.eta is not null then 'do' end,
    'status', d.status, 'po_nos', to_jsonb(d.po_nos), 'remark', d.remark, 'files', d.files,
    'item_count', (select count(*) from jsonb_array_elements(d.items) x where x ->> 'item_code' is not null),
    'unmatched_count', (select count(*) from jsonb_array_elements(d.items) x where x ->> 'item_code' is null),
    'shipped_total', (select coalesce(sum((x ->> 'shipped')::numeric), 0) from jsonb_array_elements(d.items) x),
    'issue_open', (select count(*) from ops.supplier_issue i where i.do_id = d.id and i.status = 'open'),
    'created_by_name', ops.podo_who(d.created_by), 'created_at', d.created_at,
    'updated_by_name', ops.podo_who(d.updated_by), 'updated_at', d.updated_at,
    'confirmed_by_name', ops.podo_who(d.confirmed_by), 'confirmed_at', d.confirmed_at,
    'arrived_by_name', ops.podo_who(d.arrived_by), 'arrived_at', d.arrived_at, 'arrive_note', d.arrive_note,
    'cancelled_by_name', ops.podo_who(d.cancelled_by), 'cancelled_at', d.cancelled_at, 'cancel_reason', d.cancel_reason,
    'can_edit', coalesce(d.status = 'draft' and k.po >= 2 and k.sees, false),
    'can_edit_info', coalesce(d.status <> 'cancelled' and k.po >= 2 and k.sees, false),
    'can_reopen', coalesce(d.status = 'confirmed' and k.po >= 3 and k.sees, false),
    'can_arrive', coalesce(d.status = 'confirmed' and (k.po >= 2 or k.wh >= 2) and k.sees, false),
    'can_add_issue', coalesce(d.status in ('confirmed', 'arrived') and k.po >= 2 and k.sees, false))
  from (select ops.level_rank(ops.module_level(p_me, 'purchasing')) as po,
               ops.level_rank(ops.module_level(p_me, 'warehouse')) as wh,
               ops.sees_company(p_me, d.company) as sees) k
  left join ops.shipment s on s.id = d.shipment_id and s.status <> 'cancelled'
$$;

create or replace function ops.podo_issue_json(i ops.supplier_issue) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', i.id, 'company', i.company, 'creditor_code', i.creditor_code, 'supplier_name', i.supplier_name,
    'do_id', i.do_id, 'do_no', d.do_no, 'do_date', d.do_date, 'do_status', d.status,
    'kind', i.kind, 'item_code', i.item_code, 'received_code', i.received_code, 'description', i.description,
    'po_nos', to_jsonb(i.po_nos), 'ordered', i.ordered, 'received', i.received, 'qty', i.qty,
    'resolved_qty', i.resolved_qty, 'open_qty', case when i.status = 'open' then i.qty - i.resolved_qty else 0 end,
    'decision', i.decision, 'status', i.status, 'auto', i.auto, 'note', i.note, 'action_note', i.action_note,
    'resolutions', i.resolutions, 'created_at', i.created_at, 'created_by_name', ops.podo_who(i.created_by),
    'decided_at', i.decided_at, 'decided_by_name', ops.podo_who(i.decided_by),
    'resolved_at', i.resolved_at, 'resolved_by_name', ops.podo_who(i.resolved_by), 'resolved_auto', i.resolved_auto,
    'updated_at', i.updated_at)
  from (select 1) z left join ops.supplier_do d on d.id = i.do_id
$$;

-- 整张 DO（编辑画面用）：表头 + 各型号 + 所选 PO 的型号清单（不含这张 DO 自己的在路上）+ 分配结果 + 问题 + 纪录
create or replace function ops.podo_full(p_me ops.staff, d ops.supplier_do) returns jsonb
language sql stable set search_path = '' as $$
  select ops.podo_json(p_me, d) || jsonb_build_object(
    'items', d.items,
    'outlets', ops.podo_outlets(),
    'candidates', ops.podo_items(d.company, d.creditor_code, d.po_nos, d.id,
                                 case when d.status = 'draft' then ops.podo_basis(d) end),
    'applied', (select coalesce(jsonb_agg(jsonb_build_object('item_code', a.item_code, 'outlet', a.outlet, 'qty', a.qty,
                                  'po_no', a.po_no, 'dtl_key', a.dtl_key, 'line_outlet', a.line_outlet) order by a.id), '[]'::jsonb)
                from ops.supplier_do_apply a where a.do_id = d.id and not a.void),
    'issues', (select coalesce(jsonb_agg(ops.podo_issue_json(i) order by i.id), '[]'::jsonb)
               from ops.supplier_issue i where i.do_id = d.id and i.status <> 'void'),
    'history', (select coalesce(jsonb_agg(jsonb_build_object('at', a.at, 'action', a.action, 'staff_name', s.name,
                                                             'data', a.data) order by a.id desc), '[]'::jsonb)
                from ops.audit_log a left join ops.staff s on s.id = a.staff_id
                where a.entity = 'supplier_do' and a.entity_id = d.id))
$$;

-- 新增一笔厂家问题（退回草稿再确认时，呼叫的地方已经扣掉这张留著的同样问题，只记差额）
create or replace function ops.podo_issue_new(d ops.supplier_do, p_me bigint, p_kind text, p_item text, p_recv text,
  p_desc text, p_pos text[], p_ordered numeric, p_received numeric, p_qty numeric, p_note text, p_auto boolean)
returns ops.supplier_issue
language plpgsql set search_path = '' as $$
declare
  r ops.supplier_issue;
begin
  insert into ops.supplier_issue (company, creditor_code, supplier_name, do_id, kind, item_code, received_code, description,
                                  po_nos, ordered, received, qty, decision, auto, note, created_by)
  values (d.company, d.creditor_code, d.supplier_name, d.id, p_kind, p_item, coalesce(p_recv, ''), coalesce(p_desc, ''),
          coalesce(p_pos, '{}'), p_ordered, p_received, p_qty, case when p_kind = 'short' then 'pending' end, p_auto,
          left(coalesce(p_note, ''), 500), p_me)
  returning * into r;
  return r;
end $$;

-- 少发被这张 DO 补了 p_qty（补齐 = 自动结案）；退回草稿时照 resolutions 里这张的 do_id 撤回
create or replace function ops.podo_fill(p_issue bigint, p_do bigint, p_do_no text, p_me bigint, p_qty numeric) returns void
language sql set search_path = '' as $$
  update ops.supplier_issue x set
    resolved_qty = x.resolved_qty + p_qty,
    resolutions = x.resolutions || jsonb_build_array(jsonb_build_object('do_id', p_do, 'do_no', p_do_no, 'qty', p_qty, 'at', now())),
    status = case when x.resolved_qty + p_qty >= x.qty then 'resolved' else x.status end,
    resolved_auto = x.resolved_qty + p_qty >= x.qty,
    resolved_by = case when x.resolved_qty + p_qty >= x.qty then p_me else x.resolved_by end,
    resolved_at = case when x.resolved_qty + p_qty >= x.qty then now() else x.resolved_at end,
    updated_at = now()
  where x.id = p_issue and p_qty > 0
$$;

-- ==================================================================== 4. 选厂家、选 PO、型号清单
create or replace function public.ops_po_outlets() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform ops.require_level('purchasing', 'view');
  return ops.podo_outlets();
end $$;

-- 有未到货 PO 的厂家（不含已标「关闭」的 PO）
create or replace function public.ops_po_do_suppliers(p_company text default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  c text;
begin
  me := ops.require_level('purchasing', 'edit');
  c := ops.podo_company(me, p_company);
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
             'company', c, 'creditor_code', x.creditor_code, 'supplier_name', x.supplier_name, 'is_china', x.is_china,
             'po_count', x.po_count, 'open_qty', x.open_qty, 'last_po_date', x.last_po_date,
             'drafts', (select count(*) from ops.supplier_do d where d.company = c and d.creditor_code = x.creditor_code
                        and d.status = 'draft'))
           order by x.supplier_name, x.creditor_code), '[]'::jsonb)
    from (select v.creditor_code, min(v.supplier_name) as supplier_name, bool_or(v.is_china) as is_china,
                 count(*) as po_count, sum(v.open_qty) as open_qty, max(v.po_date) as last_po_date
          from ops.v_po_open v where v.company = c and v.status <> 'closed'
          group by v.creditor_code) x
  );
end $$;

-- 这个厂家的未到货 PO（含 120 天以上旧单与已关闭的，用 closed 标示）
create or replace function public.ops_po_do_pos(p_company text, p_creditor_code text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  c text;
begin
  me := ops.require_level('purchasing', 'edit');
  c := ops.podo_company(me, p_company);
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
             'po_no', v.po_no, 'po_date', v.po_date, 'days_open', v.days_open, 'status', v.status,
             'closed', v.status = 'closed', 'eta', v.eta, 'eta_source', v.eta_source, 'lines', v.lines,
             'open_qty', v.open_qty, 'in_transit', coalesce(t.in_transit, 0),
             'remaining', v.open_qty - coalesce(t.in_transit, 0), 'outlets', coalesce(t.outlets, '[]'::jsonb),
             'dos', (select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'do_no', d.do_no, 'status', d.status)
                                               order by d.id), '[]'::jsonb)
                     from ops.supplier_do d where d.company = c and d.po_nos @> array[v.po_no]
                       and d.status in ('draft', 'confirmed')))
           order by v.po_date, v.po_no), '[]'::jsonb)
    from ops.v_po_open v
    left join (select ln.po_no, sum(ln.in_transit) as in_transit, to_jsonb(array_agg(distinct ln.outlet)) as outlets
               from ops.podo_lines(c, p_creditor_code, null, null) ln where ln.open_qty > 0
               group by ln.po_no) t on t.po_no = v.po_no
    where v.company = c and v.creditor_code = p_creditor_code
  );
end $$;

-- 所选 PO 的型号清单。p_do_id：编辑中那张 DO（它自己的在路上不算；照它的 DO 日期算已开 GRN 的，新的 = 今天）
create or replace function public.ops_po_do_candidates(p_company text, p_creditor_code text, p_po_nos text[],
                                                       p_do_id bigint default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  c text;
  v_basis date;
begin
  me := ops.require_level('purchasing', 'edit');
  c := ops.podo_company(me, p_company);
  select ops.podo_basis(x) into v_basis from ops.supplier_do x where x.id = p_do_id and x.company = c;
  return jsonb_build_object('outlets', ops.podo_outlets(),
                            'items', ops.podo_items(c, p_creditor_code, p_po_nos, p_do_id, coalesce(v_basis, ops.today())));
end $$;

-- ==================================================================== 5. 存草稿、清单、明细
-- p: id(空 = 新的) client_key company creditor_code po_nos[] do_no do_date eta shipment_id remark files[] items[]
-- 已确认 / 已到货的 DO 只能改表头（do_no do_date eta shipment_id remark files）；要改货品或 PO 先退回草稿。
create or replace function public.ops_po_do_save(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  d ops.supplier_do;
  v_id bigint := nullif(p ->> 'id', '')::bigint;
  v_key text := nullif(trim(coalesce(p ->> 'client_key', '')), '');
  v_company text;
  v_cred text;
  v_name text;
  v_pos text[];
  v_items jsonb;
  v_files jsonb;
  v_ship bigint;
  v_do_no text;
  v_dup bigint;
  e jsonb;
  f jsonb;
  a record;
  v_code text;
  v_exp text;
  v_desc text;
  v_uom text;
  v_alloc jsonb;
  v_q numeric;
  v_shipped numeric;
  codes text[] := '{}';
  v_path text;
begin
  me := ops.require_level('purchasing', 'edit');
  if jsonb_typeof(p) is distinct from 'object' then
    raise exception '资料格式不对。' using errcode = '22023';
  end if;
  if v_id is null and v_key is not null then
    select x.id into v_id from ops.supplier_do x where x.client_key = v_key;      -- 断线重送：沿用同一张
  end if;
  if v_id is not null then
    select * into d from ops.supplier_do x where x.id = v_id for update;
    if d.id is null or not ops.sees_company(me, d.company) then
      raise exception '找不到这张厂家 DO。' using errcode = 'P0002';
    end if;
    if d.status = 'cancelled' then
      raise exception '这张 DO 已取消，不能再改。' using errcode = '22023';
    end if;
    if d.status <> 'draft' and (p ? 'items' or p ? 'po_nos' or p ? 'creditor_code' or p ? 'company') then
      raise exception '这张 DO 已确认，要改货品或 PO 请先「退回草稿」。' using errcode = '22023';
    end if;
  end if;

  -- 公司、厂家、PO、各型号：只有草稿才会改（已确认的照旧，不再对 BI 资料检查）
  if d.id is not null and d.status <> 'draft' then
    v_company := d.company;
    v_cred := d.creditor_code;
    v_name := d.supplier_name;
    v_pos := d.po_nos;
    v_items := d.items;
  else
    v_company := ops.podo_company(me, coalesce(nullif(p ->> 'company', ''), d.company));
    v_cred := coalesce(nullif(trim(coalesce(p ->> 'creditor_code', '')), ''), d.creditor_code);
    if v_cred is null then
      raise exception '请先选厂家。' using errcode = '22023';
    end if;
    select l.creditor_code, coalesce(sp.name, l.creditor_name, '') into v_cred, v_name
    from bi.fact_po_line l
    left join bi.v_supplier_param sp on sp.company = l.company and sp.creditor_code = l.creditor_code
    where l.company = v_company and upper(l.creditor_code) = upper(v_cred)
    order by l.po_date desc limit 1;
    if not found then
      raise exception '找不到这个厂家的 PO。' using errcode = 'P0002';
    end if;
    if p ? 'po_nos' then
      if jsonb_typeof(p -> 'po_nos') is distinct from 'array' then
        raise exception '资料格式不对。' using errcode = '22023';
      end if;
      select coalesce(array_agg(distinct trim(x) order by trim(x)), '{}') into v_pos
      from jsonb_array_elements_text(p -> 'po_nos') x where trim(x) <> '';
    else
      v_pos := coalesce(d.po_nos, '{}');
    end if;
    if cardinality(v_pos) > 50 then
      raise exception 'PO 太多了（一张 DO 最多 50 张）。' using errcode = '22023';
    end if;
    for v_code in select unnest(v_pos) loop
      if not exists (select 1 from bi.fact_po_line l where l.company = v_company and l.creditor_code = v_cred
                     and l.po_no = v_code) then
        raise exception 'PO % 不是这个厂家的单。', v_code using errcode = '22023';
      end if;
    end loop;

    -- 各型号（整份覆盖）
    if p ? 'items' and jsonb_typeof(p -> 'items') is distinct from 'array' then
      raise exception '资料格式不对。' using errcode = '22023';
    end if;
    if jsonb_array_length(case when p ? 'items' then p -> 'items' else coalesce(d.items, '[]'::jsonb) end) > 500 then
      raise exception '一张 DO 最多 500 行。' using errcode = '22023';
    end if;
    v_items := '[]'::jsonb;
    for e in select x from jsonb_array_elements(case when p ? 'items' then p -> 'items' else coalesce(d.items, '[]'::jsonb) end) x loop
      if jsonb_typeof(e) is distinct from 'object' then
        raise exception '资料格式不对。' using errcode = '22023';
      end if;
      v_shipped := coalesce(ops.podo_num(e -> 'shipped', '出货数量'), 0);
      v_code := nullif(trim(coalesce(e ->> 'item_code', '')), '');
      v_exp := nullif(trim(coalesce(e ->> 'expected_code', '')), '');
      if v_code is not null then
        select l.item_code, coalesce(i.description, l.description), coalesce(l.uom, '') into v_code, v_desc, v_uom
        from bi.fact_po_line l left join bi.dim_item i on i.company = l.company and i.item_code = l.item_code
        where l.company = v_company and l.creditor_code = v_cred and l.po_no = any (v_pos)
          and not coalesce(l.cancelled, false) and upper(l.item_code) = upper(trim(e ->> 'item_code'))
        order by l.dtl_key limit 1;
        if not found then
          raise exception '型号 % 不在所选的 PO 里。', trim(e ->> 'item_code') using errcode = '22023';
        end if;
        if v_code = any (codes) then
          raise exception '型号 % 重复了，请合并成一行。', v_code using errcode = '22023';
        end if;
        codes := codes || v_code;
        v_alloc := '{}'::jsonb;
        if jsonb_typeof(e -> 'alloc') = 'object' then
          for a in select x.key, x.value from jsonb_each(e -> 'alloc') x loop
            v_q := ops.podo_num(a.value, '分配数量');
            if not exists (select 1 from ops.outlet o where o.code = a.key and o.active) then
              raise exception '没有这个分店：%。', a.key using errcode = '22023';
            end if;
            if v_q > 0 then
              v_alloc := v_alloc || jsonb_build_object(a.key, v_q);
            end if;
          end loop;
        end if;
        v_exp := null;
      else
        -- 对不上 PO 的行（发错型号）：要有型号或品名；整行空白就略过
        if coalesce(trim(e ->> 'src_code'), '') = '' and coalesce(trim(e ->> 'src_desc'), '') = '' then
          continue;
        end if;
        v_desc := left(trim(coalesce(e ->> 'src_desc', '')), 300);
        v_uom := '';
        v_alloc := '{}'::jsonb;
        if v_exp is not null then
          select l.item_code into v_exp from bi.fact_po_line l
          where l.company = v_company and l.creditor_code = v_cred and l.po_no = any (v_pos)
            and not coalesce(l.cancelled, false) and upper(l.item_code) = upper(trim(e ->> 'expected_code'))
          limit 1;
          if not found then
            raise exception '型号 % 不在所选的 PO 里。', trim(e ->> 'expected_code') using errcode = '22023';
          end if;
        end if;
      end if;
      v_items := v_items || jsonb_build_array(jsonb_build_object(
        'item_code', v_code, 'description', coalesce(v_desc, ''), 'uom', v_uom, 'shipped', v_shipped, 'alloc', v_alloc,
        'src_code', left(trim(coalesce(e ->> 'src_code', '')), 100), 'src_desc', left(trim(coalesce(e ->> 'src_desc', '')), 300),
        'src_row', case when trim(coalesce(e ->> 'src_row', '')) ~ '^[0-9]{1,7}$' then (e ->> 'src_row')::int end,
        'expected_code', v_exp, 'note', left(trim(coalesce(e ->> 'note', '')), 500)));
    end loop;
  end if;

  -- 附件：路径要是 <公司>/…，而且真的上传到 ops-po 了
  if p ? 'files' then
    if jsonb_typeof(p -> 'files') is distinct from 'array' then
      raise exception '资料格式不对。' using errcode = '22023';
    end if;
    if jsonb_array_length(p -> 'files') > 10 then
      raise exception '附件最多 10 个。' using errcode = '22023';
    end if;
    v_files := '[]'::jsonb;
    for f in select x from jsonb_array_elements(p -> 'files') x loop
      v_path := coalesce(f ->> 'path', '');
      if split_part(v_path, '/', 1) <> v_company
         or not exists (select 1 from storage.objects o where o.bucket_id = 'ops-po' and o.name = v_path) then
        raise exception '附件没有上传成功，请再上传一次。' using errcode = '22023';
      end if;
      v_files := v_files || jsonb_build_array(jsonb_build_object(
        'path', v_path, 'name', left(coalesce(nullif(trim(f ->> 'name'), ''), regexp_replace(v_path, '^.*/', '')), 200),
        'size', case when (f ->> 'size') ~ '^[0-9]{1,12}$' then (f ->> 'size')::bigint end,
        'type', left(coalesce(f ->> 'type', ''), 100)));
    end loop;
  else
    v_files := coalesce(d.files, '[]'::jsonb);
  end if;

  -- 货柜、DO 号
  v_ship := case when p ? 'shipment_id' then nullif(p ->> 'shipment_id', '')::bigint else d.shipment_id end;
  if v_ship is not null and not exists (select 1 from ops.shipment s where s.id = v_ship and s.company = v_company
                                         and s.status <> 'cancelled') then
    raise exception '货柜不存在，或不是同一间公司的货柜。' using errcode = '22023';
  end if;
  v_do_no := case when p ? 'do_no' then left(trim(coalesce(p ->> 'do_no', '')), 60) else coalesce(d.do_no, '') end;
  if v_do_no <> '' then
    select x.id into v_dup from ops.supplier_do x
    where x.company = v_company and x.creditor_code = v_cred and upper(x.do_no) = upper(v_do_no)
      and x.status <> 'cancelled' and x.id is distinct from d.id limit 1;
    if v_dup is not null then
      raise exception '这个厂家的 DO % 已经登记过了（#%）。', v_do_no, v_dup using errcode = '23505';
    end if;
  end if;

  if d.id is null then
    insert into ops.supplier_do (company, creditor_code, supplier_name, do_no, do_date, eta, shipment_id, po_nos, items,
                                 files, remark, client_key, created_by, updated_by)
    values (v_company, v_cred, coalesce(v_name, ''), v_do_no, nullif(p ->> 'do_date', '')::date, nullif(p ->> 'eta', '')::date,
            v_ship, v_pos, v_items, v_files, left(coalesce(p ->> 'remark', ''), 1000), v_key, me.id, me.id)
    returning * into d;
    perform ops.log(me.id, 'create', 'supplier_do', d.id,
                    jsonb_build_object('do_no', d.do_no, 'creditor_code', d.creditor_code, 'po_nos', d.po_nos));
  else
    update ops.supplier_do x set
      company = v_company, creditor_code = v_cred, supplier_name = coalesce(v_name, x.supplier_name), do_no = v_do_no,
      do_date = case when p ? 'do_date' then nullif(p ->> 'do_date', '')::date else x.do_date end,
      eta = case when p ? 'eta' then nullif(p ->> 'eta', '')::date else x.eta end,
      shipment_id = v_ship, po_nos = v_pos, items = v_items, files = v_files,
      remark = case when p ? 'remark' then left(coalesce(p ->> 'remark', ''), 1000) else x.remark end,
      updated_by = me.id, updated_at = now()
    where x.id = d.id returning * into d;
    perform ops.log(me.id, 'update', 'supplier_do', d.id,
                    jsonb_build_object('do_no', d.do_no, 'eta', d.eta, 'po_nos', d.po_nos, 'items', jsonb_array_length(d.items)));
  end if;
  return ops.podo_full(me, d);
end $$;

-- p: status('open' 预设 = 草稿 + 在路上；'all'；或 draft / confirmed / arrived / cancelled) company creditor_code q
create or replace function public.ops_po_do_list(p jsonb default '{}'::jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  st text := coalesce(nullif(p ->> 'status', ''), 'open');
  v_q text := nullif(trim(coalesce(p ->> 'q', '')), '');
begin
  me := ops.require_level('purchasing', 'edit');
  return (
    select coalesce(jsonb_agg(ops.podo_json(me, r.x) order by r.ord, (r.x).id desc), '[]'::jsonb)
    from (select x, case x.status when 'draft' then 0 when 'confirmed' then 1 when 'arrived' then 2 else 3 end as ord
          from ops.supplier_do x
          where ops.sees_company(me, x.company)
            and (nullif(p ->> 'company', '') is null or x.company = p ->> 'company')
            and (nullif(p ->> 'creditor_code', '') is null or x.creditor_code = p ->> 'creditor_code')
            and case st when 'open' then x.status in ('draft', 'confirmed') when 'all' then true else x.status = st end
            and (v_q is null or x.do_no ilike '%' || v_q || '%' or x.supplier_name ilike '%' || v_q || '%'
                 or x.creditor_code ilike '%' || v_q || '%' or array_to_string(x.po_nos, ' ') ilike '%' || v_q || '%'
                 or x.items::text ilike '%' || v_q || '%')
          order by x.id desc limit 500) r
  );
end $$;

create or replace function public.ops_po_do_get(p_id bigint) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  d ops.supplier_do;
begin
  me := ops.require_level('purchasing', 'edit');
  select * into d from ops.supplier_do x where x.id = p_id;
  if d.id is null or not ops.sees_company(me, d.company) then
    raise exception '找不到这张厂家 DO。' using errcode = 'P0002';
  end if;
  return ops.podo_full(me, d);
end $$;

-- ==================================================================== 6. 确认：分配记到 PO 行、产生厂家问题
-- 每个型号（还可以出 = 所选 PO 在这张之前还没出的；这张已开 GRN 的放回来，最多到这张的出货）：
--   1. 各分店的数量先记在「这间分店订的」PO 行（FIFO：开单日 → PO 号 → 行号），每行最多记到还可以出；
--   2. 还有剩的记在同型号其他分店的行（一样 FIFO）；
--   3. 别张 DO 还开着的少发（未决定 / 厂家会补），这张在它的 PO 有出货：照记在那几张 PO 的数量补上；
--   4. 还剩 = 超出所选 PO：先补「厂家会补」的少发（在没选的 PO：记在那张 PO 的行），再剩 = 多发（没有 PO 行）；
--   5. 多发 / 发错型号（同样的行合起来）：只记比这张留著的（退回草稿前已处理的）多出来的；
--   6. 少发：所选 PO 出完这张（扣掉这张已记的坏货 / 到货少）还欠的，跟已经记过的（ops.podo_flag）比：
--      少了补记差额；多了扣掉还开着的少发（先扣这张自己的：退回草稿后改了数量）。
--   补 / 扣都记在 resolutions（退回草稿时撤回）。
create or replace function public.ops_po_do_confirm(p_id bigint) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  d ops.supplier_do;
  e jsonb;
  it record;
  k record;
  w record;
  s ops.supplier_issue;
  v_basis date;
  v_base numeric;
  v_sum numeric;
  v_ship numeric;
  v_net numeric;
  v_rem numeric;
  v_x numeric;
  v_over numeric;
  v_flag numeric;
  v_left numeric;
  v_take numeric;
  v_q numeric;
  v_cap numeric;
  v_po text;
  v_desc text;
  v_ipos text[];
  v_pomap jsonb;                 -- 型号 → 所选 PO 里有这个型号的 PO 号
  v_budget jsonb;                -- 这张这个型号记在各张 PO 的数量（第 3 步）
  v_used jsonb;                  -- 第 4 步用掉没选的 PO 行多少
  -- 所选 PO 还可以出的行：一次读进来，照型号 + FIFO 排好
  v_items text[];
  v_keys bigint[];
  v_pos text[];
  v_outs text[];
  v_trs numeric[];
  v_descs text[];
  v_xs numeric[];
  v_rem0 numeric[];
  v_rems numeric[];
  v_sp_out text[];
  v_sp_q numeric[];
  n int;
  m int;
  b int;
  i int;
  j int;
begin
  me := ops.require_level('purchasing', 'edit');
  select * into d from ops.supplier_do x where x.id = p_id for update;
  if d.id is null or not ops.sees_company(me, d.company) then
    raise exception '找不到这张厂家 DO。' using errcode = 'P0002';
  end if;
  if d.status = 'cancelled' then
    raise exception '这张 DO 已取消，不能再改。' using errcode = '22023';
  end if;
  if d.status <> 'draft' then
    raise exception '这张 DO 已经确认过了。' using errcode = '22023';
  end if;
  if cardinality(d.po_nos) = 0 then
    raise exception '请先选这张 DO 对应的 PO。' using errcode = '22023';
  end if;
  if not exists (select 1 from jsonb_array_elements(d.items) x where (x ->> 'shipped')::numeric > 0) then
    raise exception '这张 DO 没有任何出货数量。' using errcode = '22023';
  end if;
  for e in select x from jsonb_array_elements(d.items) x where x ->> 'item_code' is not null loop
    select coalesce(sum(x.value::numeric), 0) into v_sum from jsonb_each_text(e -> 'alloc') x;
    if v_sum <> (e ->> 'shipped')::numeric then
      raise exception '型号 % 出货 %，分到各分店的合计是 %：要相等才能确认。', e ->> 'item_code',
        ops.podo_fmt((e ->> 'shipped')::numeric), ops.podo_fmt(v_sum) using errcode = '22023';
    end if;
  end loop;
  -- 同一厂家同时确认两张 DO 会抢同一批 PO 行：一个一个来
  perform pg_advisory_xact_lock(hashtextextended('ops_po_do:' || d.company || ':' || d.creditor_code, 0));
  v_basis := ops.podo_basis(d);

  select coalesce(array_agg(ln.item_code order by ln.item_code, ln.po_date, ln.po_no, ln.dtl_key), '{}'),
         coalesce(array_agg(ln.dtl_key order by ln.item_code, ln.po_date, ln.po_no, ln.dtl_key), '{}'),
         coalesce(array_agg(ln.po_no order by ln.item_code, ln.po_date, ln.po_no, ln.dtl_key), '{}'),
         coalesce(array_agg(ln.outlet order by ln.item_code, ln.po_date, ln.po_no, ln.dtl_key), '{}'),
         coalesce(array_agg(ln.transferred - ln.extra order by ln.item_code, ln.po_date, ln.po_no, ln.dtl_key), '{}'),
         coalesce(array_agg(ln.description order by ln.item_code, ln.po_date, ln.po_no, ln.dtl_key), '{}'),
         coalesce(array_agg(ln.extra order by ln.item_code, ln.po_date, ln.po_no, ln.dtl_key), '{}'),
         coalesce(array_agg(ln.remaining order by ln.item_code, ln.po_date, ln.po_no, ln.dtl_key), '{}')
    into v_items, v_keys, v_pos, v_outs, v_trs, v_descs, v_xs, v_rem0
  from ops.podo_lines(d.company, d.creditor_code, d.po_nos, d.id, v_basis) ln where ln.remaining > 0;
  v_rems := v_rem0;
  n := coalesce(array_length(v_keys, 1), 0);
  select coalesce(jsonb_object_agg(x.item_code, x.pos), '{}'::jsonb) into v_pomap
  from (select l.item_code, to_jsonb(array_agg(distinct l.po_no)) as pos from bi.fact_po_line l
        where l.company = d.company and l.creditor_code = d.creditor_code and l.po_no = any (d.po_nos)
          and not coalesce(l.cancelled, false) and nullif(trim(l.item_code), '') is not null
        group by l.item_code) x;

  for it in
    select c.item_code, (select x from jsonb_array_elements(d.items) x where x ->> 'item_code' = c.item_code limit 1) as r_item
    from (select jsonb_object_keys(v_pomap)
          union
          select x ->> 'item_code' from jsonb_array_elements(d.items) x where x ->> 'item_code' is not null) c(item_code)
    order by c.item_code
  loop
    v_ship := coalesce((it.r_item ->> 'shipped')::numeric, 0);
    select greatest(0, v_ship - coalesce(sum(x.qty), 0)) into v_net from ops.supplier_issue x
    where x.do_id = d.id and x.item_code = it.item_code and x.status <> 'void'
      and (x.kind = 'damaged' or (x.kind = 'short' and not x.auto));
    v_rem := 0;
    v_x := 0;
    v_desc := null;
    for i in 1 .. n loop
      if v_items[i] = it.item_code then
        v_rem := v_rem + v_rem0[i];
        v_x := v_x + v_xs[i];
        v_desc := coalesce(v_desc, v_descs[i]);
      end if;
    end loop;
    v_rem := v_rem - v_x + least(v_x, v_net);
    v_desc := coalesce(nullif(it.r_item ->> 'description', ''), v_desc, '');
    select coalesce(array_agg(x order by x), '{}') into v_ipos from jsonb_array_elements_text(v_pomap -> it.item_code) x;
    v_base := ops.podo_base(d.company, d.creditor_code, it.item_code, v_basis, d.id);
    v_budget := '{}';

    -- 1. 记在自己分店的 PO 行；2. 剩的记在同型号其他行
    v_sp_out := '{}';
    v_sp_q := '{}';
    for k in select x.key, x.value::numeric as q from jsonb_each_text(coalesce(it.r_item -> 'alloc', '{}'::jsonb)) x
             join ops.outlet o on o.code = x.key where x.value::numeric > 0 order by o.sort, o.code loop
      v_sp_out := v_sp_out || k.key;
      v_sp_q := v_sp_q || k.q;
    end loop;
    m := coalesce(array_length(v_sp_out, 1), 0);
    for j in 1 .. m * 2 loop                      -- 先每间分店都记自己的行，再记其他行
      b := case when j <= m then j else j - m end;
      for i in 1 .. n loop
        exit when v_sp_q[b] <= 0;
        if v_items[i] = it.item_code and v_rems[i] > 0 and (j > m or v_outs[i] = v_sp_out[b]) then
          v_take := least(v_sp_q[b], v_rems[i]);
          insert into ops.supplier_do_apply (do_id, company, item_code, outlet, qty, dtl_key, po_no, line_outlet,
                                             transferred_at, rcv_base)
          values (d.id, d.company, it.item_code, v_sp_out[b], v_take, v_keys[i], v_pos[i], v_outs[i], v_trs[i], v_base);
          v_rems[i] := v_rems[i] - v_take;
          v_sp_q[b] := v_sp_q[b] - v_take;
          v_budget := jsonb_set(v_budget, array[v_pos[i]], to_jsonb(coalesce((v_budget ->> v_pos[i])::numeric, 0) + v_take));
        end if;
      end loop;
    end loop;

    -- 3. 别张 DO 的少发：这张在它的 PO 出了多少就补多少
    for s in select * from ops.supplier_issue x
             where x.company = d.company and x.creditor_code = d.creditor_code and x.item_code = it.item_code
               and x.kind = 'short' and x.status = 'open' and x.do_id is distinct from d.id and x.po_nos && v_ipos
             order by x.created_at, x.id for update loop
      select least(coalesce(sum((v_budget ->> p)::numeric), 0), s.qty - s.resolved_qty) into v_left from unnest(s.po_nos) p;
      continue when v_left <= 0;
      perform ops.podo_fill(s.id, d.id, d.do_no, me.id, v_left);
      foreach v_po in array s.po_nos loop
        v_take := least(v_left, coalesce((v_budget ->> v_po)::numeric, 0));
        continue when v_take <= 0;
        v_budget := jsonb_set(v_budget, array[v_po], to_jsonb((v_budget ->> v_po)::numeric - v_take));
        v_left := v_left - v_take;
      end loop;
    end loop;

    -- 4. 超出所选 PO：先补「厂家会补」的少发，再剩 = 多发
    v_over := greatest(0, v_ship - v_rem);
    select coalesce(sum(x), 0) into v_left from unnest(v_sp_q) x;
    v_used := '{}';
    for s in select * from ops.supplier_issue x
             where x.company = d.company and x.creditor_code = d.creditor_code and x.item_code = it.item_code
               and x.kind = 'short' and x.decision = 'await' and x.status = 'open' and x.do_id is distinct from d.id
               and v_left > 0
             order by x.created_at, x.id for update loop
      exit when v_left <= 0;
      v_take := least(v_left, s.qty - s.resolved_qty);
      continue when v_take <= 0;
      perform ops.podo_fill(s.id, d.id, d.do_no, me.id, v_take);
      v_left := v_left - v_take;
      v_over := greatest(0, v_over - v_take);
      for k in select ln.dtl_key, ln.po_no, ln.outlet, ln.transferred,
                      ln.remaining - coalesce((v_used ->> ln.dtl_key::text)::numeric, 0) as cap
               from ops.podo_lines(d.company, d.creditor_code,
                                   coalesce((select array_agg(p) from unnest(s.po_nos) p where p <> all (d.po_nos)), '{}'),
                                   d.id) ln
               where ln.item_code = it.item_code order by ln.po_date, ln.po_no, ln.dtl_key loop
        exit when v_take <= 0;
        v_cap := least(v_take, k.cap);
        for j in 1 .. coalesce(array_length(v_sp_out, 1), 0) loop
          exit when v_cap <= 0;
          v_q := least(v_cap, v_sp_q[j]);
          continue when v_q <= 0;
          insert into ops.supplier_do_apply (do_id, company, item_code, outlet, qty, dtl_key, po_no, line_outlet,
                                             transferred_at, rcv_base)
          values (d.id, d.company, it.item_code, v_sp_out[j], v_q, k.dtl_key, k.po_no, k.outlet, k.transferred, v_base);
          v_sp_q[j] := v_sp_q[j] - v_q;
          v_cap := v_cap - v_q;
          v_take := v_take - v_q;
          v_used := jsonb_set(v_used, array[k.dtl_key::text], to_jsonb(coalesce((v_used ->> k.dtl_key::text)::numeric, 0) + v_q));
        end loop;
      end loop;
    end loop;
    for j in 1 .. coalesce(array_length(v_sp_out, 1), 0) loop
      if v_sp_q[j] > 0 then
        insert into ops.supplier_do_apply (do_id, company, item_code, outlet, qty, rcv_base)
        values (d.id, d.company, it.item_code, v_sp_out[j], v_sp_q[j], v_base);
      end if;
    end loop;

    -- 5. 多发
    select v_over - coalesce(sum(x.qty), 0) into v_over from ops.supplier_issue x
    where x.do_id = d.id and x.kind = 'over' and x.item_code = it.item_code and x.status <> 'void';
    if v_over > 0 then
      perform ops.podo_issue_new(d, me.id, 'over', it.item_code, '', v_desc, v_ipos, v_rem, v_ship, v_over,
                                 coalesce(it.r_item ->> 'note', ''), true);
    end if;
    -- 6. 少发
    v_flag := ops.podo_flag(d.company, d.creditor_code, it.item_code, v_ipos);
    v_left := greatest(0, v_rem - v_net);
    if v_flag < v_left then
      perform ops.podo_issue_new(d, me.id, 'short', it.item_code, '', v_desc, v_ipos, v_rem, v_ship, v_left - v_flag,
                                 coalesce(it.r_item ->> 'note', ''), true);
    end if;
    v_left := v_flag - v_left;
    for s in select * from ops.supplier_issue x
             where x.company = d.company and x.creditor_code = d.creditor_code and x.item_code = it.item_code
               and x.kind = 'short' and x.status = 'open' and x.po_nos && v_ipos and v_left > 0
             order by x.do_id is not distinct from d.id desc, x.created_at, x.id for update loop
      v_take := least(v_left, s.qty - s.resolved_qty);
      perform ops.podo_fill(s.id, d.id, d.do_no, me.id, v_take);
      v_left := v_left - v_take;
      exit when v_left <= 0;
    end loop;
  end loop;

  -- 对不上 PO 的行 = 发错型号（同样的行合起来；订 = 本来应该收到的型号还可以出的数量）
  for w in select x ->> 'expected_code' as exp, upper(coalesce(x ->> 'src_code', '')) as code_u,
                  min(coalesce(x ->> 'src_code', '')) as code, coalesce(x ->> 'src_desc', '') as descr,
                  sum((x ->> 'shipped')::numeric) as qty, coalesce(string_agg(nullif(x ->> 'note', ''), '；'), '') as note
           from jsonb_array_elements(d.items) x
           where x ->> 'item_code' is null and coalesce((x ->> 'shipped')::numeric, 0) > 0
           group by 1, 2, 4 loop
    v_rem := null;
    if w.exp is not null then
      v_rem := 0;
      for i in 1 .. n loop
        if v_items[i] = w.exp then
          v_rem := v_rem + v_rem0[i] - v_xs[i];
        end if;
      end loop;
    end if;
    select w.qty - coalesce(sum(x.qty), 0) into v_take from ops.supplier_issue x
    where x.do_id = d.id and x.kind = 'wrong' and x.status <> 'void' and x.item_code is not distinct from w.exp
      and upper(x.received_code) = w.code_u and x.description = w.descr;
    if v_take > 0 then
      perform ops.podo_issue_new(d, me.id, 'wrong', w.exp, w.code, w.descr, d.po_nos, v_rem, w.qty, v_take, w.note, true);
    end if;
  end loop;

  update ops.supplier_do x set status = 'confirmed', confirmed_by = me.id, confirmed_at = now(), updated_by = me.id,
                               updated_at = now()
  where x.id = d.id returning * into d;
  perform ops.log(me.id, 'confirm', 'supplier_do', d.id, jsonb_build_object('do_no', d.do_no, 'po_nos', d.po_nos));
  return ops.podo_full(me, d);
end $$;

-- ==================================================================== 7. 退回草稿、取消、到货
-- 退回草稿（订货「可审批」，只限还没到货的）：分配作废（起算点留著，再确认时沿用）；这张 DO 补 / 扣别的少发的数量撤回；
-- 这张自动产生、还没人处理的问题 → void。已经有人决定 / 处理的问题、手动记的坏货 / 到货少保留。
create or replace function public.ops_po_do_reopen(p_id bigint, p_reason text default '') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  d ops.supplier_do;
begin
  me := ops.require_level('purchasing', 'approve');
  select * into d from ops.supplier_do x where x.id = p_id for update;
  if d.id is null or not ops.sees_company(me, d.company) then
    raise exception '找不到这张厂家 DO。' using errcode = 'P0002';
  end if;
  if d.status = 'arrived' then
    raise exception '已到货的 DO 不能退回草稿。' using errcode = '22023';
  end if;
  if d.status <> 'confirmed' then
    raise exception '只有已确认（在路上）的 DO 可以退回草稿。' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('ops_po_do:' || d.company || ':' || d.creditor_code, 0));

  update ops.supplier_do_apply a set void = true where a.do_id = d.id and not a.void;
  update ops.supplier_issue x set
    resolved_qty = greatest(x.resolved_qty - r.qty, 0),
    resolutions = r.rest,
    status = case when x.status = 'resolved' and x.resolved_auto then 'open' else x.status end,
    resolved_by = case when x.status = 'resolved' and x.resolved_auto then null else x.resolved_by end,
    resolved_at = case when x.status = 'resolved' and x.resolved_auto then null else x.resolved_at end,
    resolved_auto = false,
    updated_at = now()
  from (select y.id, sum((z ->> 'qty')::numeric) as qty,
               coalesce((select jsonb_agg(w) from jsonb_array_elements(y.resolutions) w
                         where (w ->> 'do_id')::bigint is distinct from d.id), '[]'::jsonb) as rest
        from ops.supplier_issue y, jsonb_array_elements(y.resolutions) z
        where (z ->> 'do_id')::bigint = d.id
        group by y.id) r
  where x.id = r.id;
  update ops.supplier_issue x set status = 'void', updated_at = now()
  where x.do_id = d.id and x.auto and x.status = 'open' and coalesce(x.decision, 'pending') = 'pending'
    and x.resolved_qty = 0;

  update ops.supplier_do x set status = 'draft', confirmed_by = null, confirmed_at = null, updated_by = me.id,
                               updated_at = now()
  where x.id = d.id returning * into d;
  perform ops.log(me.id, 'reopen', 'supplier_do', d.id, jsonb_build_object('reason', coalesce(p_reason, '')));
  return ops.podo_full(me, d);
end $$;

-- 取消（只限草稿；不删资料）。退回草稿后留著的问题（已决定的少发、坏货…）一起作废：这张 DO 不算了。
create or replace function public.ops_po_do_cancel(p_id bigint, p_reason text default '') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  d ops.supplier_do;
begin
  me := ops.require_level('purchasing', 'edit');
  select * into d from ops.supplier_do x where x.id = p_id for update;
  if d.id is null or not ops.sees_company(me, d.company) then
    raise exception '找不到这张厂家 DO。' using errcode = 'P0002';
  end if;
  if d.status = 'cancelled' then
    raise exception '这张 DO 已取消，不能再改。' using errcode = '22023';
  end if;
  if d.status <> 'draft' then
    raise exception '只有草稿可以取消；已确认的请先「退回草稿」。' using errcode = '22023';
  end if;
  update ops.supplier_do x set status = 'cancelled', cancelled_by = me.id, cancelled_at = now(),
                               cancel_reason = left(coalesce(p_reason, ''), 500), updated_by = me.id, updated_at = now()
  where x.id = d.id returning * into d;
  update ops.supplier_issue x set status = 'void', updated_at = now() where x.do_id = d.id and x.status <> 'void';
  perform ops.log(me.id, 'cancel', 'supplier_do', d.id, jsonb_build_object('reason', coalesce(p_reason, '')));
  return ops.podo_json(me, d);
end $$;

-- 货到了（订货或仓库「可编辑」）：从「在路上」拿掉。PO 行的在路上照算，直到 AutoCount 开了 GRN。
create or replace function public.ops_po_do_arrive(p_id bigint, p_note text default '') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  d ops.supplier_do;
begin
  me := ops.require_staff();
  if not (ops.level_rank(ops.module_level(me, 'purchasing')) >= 2
          or ops.level_rank(ops.module_level(me, 'warehouse')) >= 2) then
    raise exception '要「订货与 ETA」或「仓库」可编辑才能标记到货。' using errcode = '42501';
  end if;
  select * into d from ops.supplier_do x where x.id = p_id for update;
  if d.id is null or not ops.sees_company(me, d.company) then
    raise exception '找不到这张厂家 DO。' using errcode = 'P0002';
  end if;
  if d.status = 'arrived' then
    raise exception '这张 DO 已经标记到货了。' using errcode = '22023';
  end if;
  if d.status <> 'confirmed' then
    raise exception '只有已确认（在路上）的 DO 可以标记到货。' using errcode = '22023';
  end if;
  update ops.supplier_do x set status = 'arrived', arrived_by = me.id, arrived_at = now(),
                               arrive_note = left(coalesce(p_note, ''), 500), updated_by = me.id, updated_at = now()
  where x.id = d.id returning * into d;
  perform ops.log(me.id, 'arrive', 'supplier_do', d.id, jsonb_build_object('note', coalesce(p_note, '')));
  if ops.level_rank(ops.module_level(me, 'purchasing')) < 2 then
    return jsonb_build_object('id', d.id, 'status', d.status, 'arrived_at', d.arrived_at);   -- 只有仓库权限：不回表头
  end if;
  return ops.podo_json(me, d);
end $$;

-- ==================================================================== 8. 在路上（分店看）
-- p: outlet q。总部 / ALL 的人看全部分店；其他分店的人只看自己分店的。不含价格。
create or replace function public.ops_po_transit(p jsonb default '{}'::jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  v_q text := nullif(trim(coalesce(p ->> 'q', '')), '');
  v_out text := nullif(p ->> 'outlet', '');
  arr boolean;
begin
  me := ops.require_level('purchasing', 'view');
  arr := ops.level_rank(ops.module_level(me, 'purchasing')) >= 2 or ops.level_rank(ops.module_level(me, 'warehouse')) >= 2;
  return jsonb_build_object(
    'outlets', (select coalesce(jsonb_agg(jsonb_build_object('code', o.code, 'name', o.name, 'short_name', o.short_name)
                                          order by o.sort, o.code), '[]'::jsonb)
                from ops.outlet o where o.active and ops.outlet_visible(me, o.code)),
    'rows', (select coalesce(jsonb_agg(jsonb_build_object(
               'do_id', r.id, 'do_no', r.do_no, 'do_date', r.do_date, 'company', r.company, 'creditor_code', r.creditor_code,
               'supplier_name', r.supplier_name, 'eta', r.eta, 'eta_source', r.eta_source, 'shipment_name', r.shipment_name,
               'outlet', r.outlet, 'outlet_name', o.name, 'item_code', r.item_code, 'description', r.description,
               'uom', r.uom, 'qty', r.qty, 'po_nos', r.po_nos, 'confirmed_at', r.confirmed_at,
               'can_arrive', coalesce(arr and ops.sees_company(me, r.company), false))
             order by o.sort, r.eta nulls last, r.do_no, r.id, r.item_code), '[]'::jsonb)
             from (select d.id, d.do_no, d.do_date, d.company, d.creditor_code, d.supplier_name, d.confirmed_at,
                          coalesce(s.eta, d.eta) as eta,
                          case when s.eta is not null then 'shipment' when d.eta is not null then 'do' end as eta_source,
                          s.name as shipment_name, a.outlet, a.item_code, sum(a.qty) as qty,
                          coalesce((select x ->> 'description' from jsonb_array_elements(d.items) x
                                    where x ->> 'item_code' = a.item_code limit 1), '') as description,
                          coalesce((select x ->> 'uom' from jsonb_array_elements(d.items) x
                                    where x ->> 'item_code' = a.item_code limit 1), '') as uom,
                          coalesce(to_jsonb(array_remove(array_agg(distinct a.po_no), null)), '[]'::jsonb) as po_nos
                   from ops.supplier_do d
                   join ops.supplier_do_apply a on a.do_id = d.id and not a.void
                   left join ops.shipment s on s.id = d.shipment_id and s.status <> 'cancelled'
                   where d.status = 'confirmed' and ops.outlet_visible(me, a.outlet)
                     and (v_out is null or a.outlet = v_out)
                   group by d.id, s.id, a.outlet, a.item_code) r
             join ops.outlet o on o.code = r.outlet
             where v_q is null or r.item_code ilike '%' || v_q || '%' or r.description ilike '%' || v_q || '%'
                or r.supplier_name ilike '%' || v_q || '%' or r.do_no ilike '%' || v_q || '%'
                or r.po_nos::text ilike '%' || v_q || '%'));
end $$;

-- ==================================================================== 9. 厂家问题
-- p: status('open' 预设 / 'resolved' / 'all' = 不含 void / 'void') company creditor_code kind q
create or replace function public.ops_po_issues(p jsonb default '{}'::jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  st text := coalesce(nullif(p ->> 'status', ''), 'open');
  v_q text := nullif(trim(coalesce(p ->> 'q', '')), '');
begin
  me := ops.require_level('purchasing', 'edit');
  return (
    select coalesce(jsonb_agg(ops.podo_issue_json(x.i) order by (x.i).supplier_name, (x.i).creditor_code, (x.i).created_at,
                              (x.i).id), '[]'::jsonb)
    from (select i from ops.supplier_issue i
          left join ops.supplier_do d on d.id = i.do_id
          where ops.sees_company(me, i.company)
            and case st when 'all' then i.status <> 'void' else i.status = st end
            and (nullif(p ->> 'company', '') is null or i.company = p ->> 'company')
            and (nullif(p ->> 'creditor_code', '') is null or i.creditor_code = p ->> 'creditor_code')
            and (nullif(p ->> 'kind', '') is null or i.kind = p ->> 'kind')
            and (v_q is null or i.supplier_name ilike '%' || v_q || '%' or coalesce(i.item_code, '') ilike '%' || v_q || '%'
                 or i.received_code ilike '%' || v_q || '%' or i.description ilike '%' || v_q || '%'
                 or coalesce(d.do_no, '') ilike '%' || v_q || '%' or array_to_string(i.po_nos, ' ') ilike '%' || v_q || '%')
          order by i.id desc limit 2000) x
  );
end $$;

-- 手动记问题（DO 确认后）：p: do_id kind('damaged' 坏货 预设 / 'short' 到货少 / 'wrong') item_code received_code qty note
-- 坏货、到货少：这几件不会入库 → 这张 DO 的在路上扣掉（ops.podo_pool），厂家要补的记在问题里。
create or replace function public.ops_po_issue_add(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  d ops.supplier_do;
  v_kind text := coalesce(nullif(p ->> 'kind', ''), 'damaged');
  v_qty numeric;
  v_code text := nullif(trim(coalesce(p ->> 'item_code', '')), '');
  v_recv text := left(trim(coalesce(p ->> 'received_code', '')), 100);
  v_row jsonb;
  v_red numeric;
  r ops.supplier_issue;
begin
  me := ops.require_level('purchasing', 'edit');
  select * into d from ops.supplier_do x where x.id = nullif(p ->> 'do_id', '')::bigint for update;
  if d.id is null or not ops.sees_company(me, d.company) then
    raise exception '找不到这张厂家 DO。' using errcode = 'P0002';
  end if;
  if d.status not in ('confirmed', 'arrived') then
    raise exception 'DO 确认之后才能记坏货、到货少或发错型号。' using errcode = '22023';
  end if;
  if v_kind not in ('damaged', 'short', 'wrong') then
    raise exception '只能手动记坏货、到货少或发错型号（少发、多发确认时自动算）。' using errcode = '22023';
  end if;
  v_qty := ops.podo_num(p -> 'qty', '数量');
  if coalesce(v_qty, 0) <= 0 then
    raise exception '请填数量。' using errcode = '22023';
  end if;
  if v_kind <> 'wrong' then
    if v_code is null then
      raise exception '请选型号。' using errcode = '22023';
    end if;
    select x into v_row from jsonb_array_elements(d.items) x where upper(x ->> 'item_code') = upper(coalesce(v_code, '')) limit 1;
    if v_row is null then
      raise exception '这张 DO 没有型号 %。', coalesce(v_code, '') using errcode = '22023';
    end if;
    select coalesce(sum(x.qty), 0) into v_red from ops.supplier_issue x
    where x.do_id = d.id and x.item_code = v_row ->> 'item_code' and x.status <> 'void'
      and (x.kind = 'damaged' or (x.kind = 'short' and not x.auto));
    if v_qty + v_red > (v_row ->> 'shipped')::numeric then
      raise exception '坏货、到货少合计不能多过这张 DO 的出货数量（%）。', ops.podo_fmt((v_row ->> 'shipped')::numeric)
        using errcode = '22023';
    end if;
    r := ops.podo_issue_new(d, me.id, v_kind, v_row ->> 'item_code', '', v_row ->> 'description', d.po_nos, null,
                            (v_row ->> 'shipped')::numeric, v_qty, p ->> 'note', false);
  else
    if v_recv = '' and coalesce(trim(p ->> 'note'), '') = '' then
      raise exception '请填收到的型号或备注。' using errcode = '22023';
    end if;
    if v_code is not null then
      select l.item_code into v_code from bi.fact_po_line l
      where l.company = d.company and l.creditor_code = d.creditor_code and l.po_no = any (d.po_nos)
        and upper(l.item_code) = upper(trim(p ->> 'item_code')) limit 1;
      if not found then
        raise exception '型号 % 不在所选的 PO 里。', trim(p ->> 'item_code') using errcode = '22023';
      end if;
    end if;
    r := ops.podo_issue_new(d, me.id, 'wrong', v_code, v_recv, left(coalesce(p ->> 'description', ''), 300), d.po_nos,
                            null, v_qty, v_qty, p ->> 'note', false);
  end if;
  perform ops.log(me.id, 'issue_add', 'supplier_do', d.id, jsonb_build_object('issue_id', r.id, 'kind', r.kind,
                                                                               'item_code', r.item_code, 'qty', r.qty));
  return ops.podo_issue_json(r);
end $$;

-- 处理问题（可一次多笔）。p_action：
--   await（少发：厂家会补）/ cancel（少发：取消，下次再订 → 已处理）/ pending（少发：改回未决定）
--   resolve（已处理）/ reopen（重开）/ note（只改备注）/ void（作废手动加错的；自动产生的不行）
-- p_note：note 动作改「备注」，其他动作写进「处理说明」（null = 不改）
create or replace function public.ops_po_issue_set(p_ids bigint[], p_action text, p_note text default null) returns int
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  s ops.supplier_issue;
  n int := 0;
begin
  me := ops.require_level('purchasing', 'edit');
  if p_action not in ('await', 'cancel', 'pending', 'resolve', 'reopen', 'note', 'void') then
    raise exception '未知的动作：%', p_action using errcode = '22023';
  end if;
  for s in select * from ops.supplier_issue x where x.id = any (coalesce(p_ids, '{}')) order by x.id for update loop
    if not ops.sees_company(me, s.company) then
      raise exception '找不到这个厂家问题。' using errcode = 'P0002';
    end if;
    if p_action in ('await', 'cancel', 'pending') and s.kind <> 'short' then
      raise exception '只有「少发」要选「厂家会补」或「取消（下次再订）」。' using errcode = '22023';
    end if;
    if p_action in ('await', 'cancel', 'pending', 'resolve') and s.status <> 'open' then
      raise exception '这个问题已经处理过了。' using errcode = '22023';
    end if;
    if p_action = 'resolve' and s.kind = 'short' and s.decision = 'pending' then
      raise exception '少发要先选「厂家会补」或「取消（下次再订）」。' using errcode = '22023';
    end if;
    if p_action = 'pending' and s.resolved_qty > 0 then
      raise exception '后来的 DO 已经补了一部分，不能改回未决定。' using errcode = '22023';
    end if;
    if p_action = 'reopen' and s.status <> 'resolved' then
      raise exception '只有已处理的问题可以重开。' using errcode = '22023';
    end if;
    if p_action = 'void' and s.auto then
      raise exception '自动产生的问题不能作废（DO 退回草稿时会自动撤回）；请改用「已处理」并写原因。' using errcode = '22023';
    end if;
    if p_action = 'void' and s.status = 'void' then
      continue;
    end if;
    update ops.supplier_issue x set
      decision = case p_action when 'await' then 'await' when 'cancel' then 'cancelled' when 'pending' then 'pending'
                               when 'reopen' then case when x.decision = 'cancelled' then 'pending' else x.decision end
                               else x.decision end,
      decided_by = case when p_action in ('await', 'cancel', 'pending') then me.id else x.decided_by end,
      decided_at = case when p_action in ('await', 'cancel', 'pending') then now() else x.decided_at end,
      status = case p_action when 'cancel' then 'resolved' when 'resolve' then 'resolved' when 'reopen' then 'open'
                             when 'void' then 'void' else x.status end,
      resolved_by = case when p_action in ('cancel', 'resolve') then me.id when p_action = 'reopen' then null
                         else x.resolved_by end,
      resolved_at = case when p_action in ('cancel', 'resolve') then now() when p_action = 'reopen' then null
                         else x.resolved_at end,
      resolved_auto = case when p_action in ('cancel', 'resolve', 'reopen') then false else x.resolved_auto end,
      note = case when p_action = 'note' and p_note is not null then left(p_note, 500) else x.note end,
      action_note = case when p_action <> 'note' and p_note is not null then left(p_note, 500) else x.action_note end,
      updated_at = now()
    where x.id = s.id;
    perform ops.log(me.id, 'issue_' || p_action, 'supplier_issue', s.id, jsonb_build_object('note', p_note));
    n := n + 1;
  end loop;
  return n;
end $$;

-- ==================================================================== 10. Storage：私有 bucket ops-po（厂家 DO 档案）
-- 路径 <公司>/<yyyy-mm>/<随机>-<档名>；读写都要订货「可编辑」且看得到那间公司。
create or replace function public.ops_po_file_ok(p_name text, p_write boolean) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff := ops.current_staff();
  c text := split_part(coalesce(p_name, ''), '/', 1);
begin
  return coalesce(me.id is not null and c in ('HOMEWORKSSB', 'HOMEWORKSSOUTHERN') and ops.sees_company(me, c)
                  and ops.level_rank(ops.module_level(me, 'purchasing')) >= 2, false);
end $$;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('ops-po', 'ops-po', false, 15728640, array[
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel', 'text/csv',
  'application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'])
on conflict (id) do nothing;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
                                             and policyname = 'ops-po read') then
    create policy "ops-po read" on storage.objects for select to authenticated
      using (bucket_id = 'ops-po' and public.ops_po_file_ok(name, false));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
                                             and policyname = 'ops-po insert') then
    create policy "ops-po insert" on storage.objects for insert to authenticated
      with check (bucket_id = 'ops-po' and public.ops_po_file_ok(name, true));
  end if;
end $$;

-- ==================================================================== 11. 未到货 PO 清单：显示在路上的厂家 DO
-- 与 20260928_ops_purchasing 的 ops.po_row_json 相同，只多 dos（这张 PO 已确认、还没到货的厂家 DO 号与 ETA）。有效 ETA 规则不变。
create or replace function ops.po_row_json(p_staff ops.staff, p ops.v_po_open, p_prices boolean) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'company', p.company, 'po_no', p.po_no, 'po_date', p.po_date, 'creditor_code', p.creditor_code,
    'supplier_name', p.supplier_name, 'creditor_name', p.creditor_name, 'is_china', p.is_china,
    'lines', p.lines, 'open_qty', p.open_qty, 'locations', p.locations,
    'open_amt', case when p_prices then p.open_amt end,
    'status', p.status, 'po_eta', p.po_eta, 'remark', p.remark, 'updated_at', p.updated_at,
    'updated_by_name', (select s.name from ops.staff s where s.id = p.updated_by),
    'shipment_id', p.shipment_id, 'shipment_name', p.shipment_name, 'shipment_status', p.shipment_status,
    'eta', p.eta, 'eta_source', p.eta_source, 'days_open', p.days_open,
    'days_late', p.days_late, 'overdue', p.days_late > 0 and p.status <> 'closed',
    'stale', p.days_open > 120,
    'dos', (select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'do_no', d.do_no, 'eta', coalesce(s.eta, d.eta))
                                      order by coalesce(s.eta, d.eta) nulls last, d.id), '[]'::jsonb)
            from ops.supplier_do d left join ops.shipment s on s.id = d.shipment_id and s.status <> 'cancelled'
            where d.company = p.company and d.po_nos @> array[p.po_no] and d.status = 'confirmed'))
$$;

-- ==================================================================== 12. 权限
do $$
declare
  f text;
begin
  foreach f in array array[
    'ops_po_outlets()', 'ops_po_do_suppliers(text)', 'ops_po_do_pos(text,text)',
    'ops_po_do_candidates(text,text,text[],bigint)', 'ops_po_do_save(jsonb)', 'ops_po_do_list(jsonb)',
    'ops_po_do_get(bigint)', 'ops_po_do_confirm(bigint)', 'ops_po_do_reopen(bigint,text)',
    'ops_po_do_cancel(bigint,text)', 'ops_po_do_arrive(bigint,text)', 'ops_po_transit(jsonb)', 'ops_po_issues(jsonb)',
    'ops_po_issue_add(jsonb)', 'ops_po_issue_set(bigint[],text,text)', 'ops_po_file_ok(text,boolean)'
  ] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

revoke all on all functions in schema ops from public, anon, authenticated;
revoke all on all tables in schema ops from public, anon, authenticated;
