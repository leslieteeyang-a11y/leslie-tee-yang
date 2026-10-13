-- 营运系统：订货 SOP — 一步接一步、这批的问题（少发决定 / 来错的型号 / 缺零件）、厂家还欠、点货后库存（进货待开 GRN）、开单部。
-- 套用到 Supabase 的 migration 名称：ops_po_sop（要先套 20261014_ops_po_receive。约 141 KB，一次送会被挡：照「-- ====」分 9 段
--   依序套用，每段 ≤ 24 KB：ops_po_sop_1 = 开头 + §1–2、_2 = §3、_3 = §4、_4 = §5、_5 = §6、_6 = §7–8、_7 = §9、_8 = §10、
--   _9 = §11–12；§12 的权限要在最后一段）。可以重复套用；不含会被 Supabase MCP 挡下的指令（没有删除资料或拿掉函数的语句：
--   §10 旧的 3 个参数的 ops_wh_move_mark 留著当转接，新的 4 个参数版本参数都必填，两个不会撞）。
--
-- 使用者 2026-10-13：
--   B1 SOP：厂家到货单显示目前第几步、等哪个部门（ops.podo_json.sop）；草稿开了超过 24 小时还没确认标红；
--      首页（订货「可编辑」）：草稿超过 24 小时（do_draft_stale）、PO 很久没 ETA 要问厂家（po_no_eta：中国货 ≥ 30 天、本地货 ≥ 7 天、
--      ≤ 120 天、没关闭 / 没标到货、没有任何非取消的厂家到货、没填 ETA、没挂货柜；未到货 PO 清单 p.no_eta 筛出同一批）；
--      少发 / 缺零件还没决定 → 沿用 po_issues_todo。
--   B2 开单画面「这批的问题」：少发每行可先选「厂家会补 / 取消（下次再订）/ 未决定」（items[].short_decision，确认时套到自动产生的少发）；
--      缺零件 / 其他要补的（supplier_do.parts → 确认时变成厂家问题 kind = part；不影响在路上 / 少发数量）。
--   B3 WhatsApp 给厂家：前端用厂家问题 JSON（do_no、po_nos、型号、品名、数量、request、part_name、note）组讯息；一律不含价格。
--   B4 厂家还欠：厂家问题记 CS 工厂（factory，从 PO 厂家名称栏）；owed_qty = 少发（未决定 / 厂家会补，还没补齐）+ 缺零件（还没处理）；
--      ops_po_issues 多 owed / factory 筛选。
--   B5 来错的型号：「收到的型号」搜我们的商品（ops_po_item_search）或「不是我们的产品」（own = false，品名必填）；
--      要厂家怎么处理（request：replace 换成正确的型号 / return 退回厂家 / next 下次补上（补正确的）/ keep 我们留下（照价算）/ other 其他）。
--   B6 点货后库存跟著变（不写 AutoCount）：点货产生仓库的 pending 搬动 kind = 'receive'（进货待入 AutoCount），
--      ops.wh_pending 已按 to_loc 加总 → 查商品、盘点的「应有」自动算进去。新部门「开单部」（billing）照「待开进货单」在 AutoCount 开 GRN，
--      回来按「已输入」填 GRN 号（ops_wh_move_mark）；开单部看得到厂家（ops.sees_supplier）。AutoCount 在点货那天之后已经有这张 PO
--      这个型号的进货单 → 清单标「可能已输入」（不会自动标）。
--   审查后（2026-10-13 第二轮）：
--     进货取消只有仓库「可审批」、一定要写原因（ops_wh_move_mark 多 p_reason），开单部只能标已输入；待开进货单「全部」列出取消的；
--     开单部要仓库「只看」以上（ops.grn_can_mark）；GRN 提示照在路上的先出先到（ops.podo_do_rcv、ops.grn_avail）：同一张 PO 两批货
--     不互相误提示、没有 PO 的多到不提示、扣掉已经用掉的 GRN，一张就够才给一键标（one_doc）、PO 已全收另外标（po_full）；
--     本地货先开 GRN 再点货：点货时 AutoCount 已经收了的记 wh_move.pre_grn，ops.wh_pending 不算（不重复算库存），还是等开单部核对；
--     点货画面带进开单时记的来错型号（unmatched[].row → wrong[].do_row，跟确认时记的那笔对上，不重复记）；
--     点货后补记坏货 / 到货少扣还没输入的进货、补记来错的我们的型号多一笔进货（ops_po_issue_add 回 stock_left / move_id）；
--     缺零件要厂家「下次补上」= 厂家会补（确认、手动记都是）；JB 账套的主要仓位（ops.podo_main_loc：JB），仓位要存在；
--     看不到厂家的人：点货画面不回厂家 DO 上的型号写法（不是我们的型号）；SOP 第 8 步还有进货待开 GRN = 等开单部（sop.grn_n）。
--   AutoCount 仍只读：这里不写 bi.*。

-- ==================================================================== 1. 资料表：缺零件、要厂家怎么处理、CS 工厂、进货待入 AutoCount、开单部
-- 厂家问题：kind 多 part（缺零件 / 其他要补的）；少发与缺零件才有 decision（pending 未决定 / await 厂家会补 / cancelled 取消）
alter table ops.supplier_issue drop constraint if exists supplier_issue_kind_check;
alter table ops.supplier_issue add constraint supplier_issue_kind_check
  check (kind in ('short', 'over', 'wrong', 'damaged', 'part'));
alter table ops.supplier_issue drop constraint if exists supplier_issue_check;
alter table ops.supplier_issue drop constraint if exists supplier_issue_decision_ck;
alter table ops.supplier_issue add constraint supplier_issue_decision_ck check ((kind in ('short', 'part')) = (decision is not null));
-- 要厂家怎么处理（少发不用：少发看 decision）
alter table ops.supplier_issue add column if not exists request text;
alter table ops.supplier_issue drop constraint if exists supplier_issue_request_ck;
alter table ops.supplier_issue add constraint supplier_issue_request_ck
  check (request in ('replace', 'return', 'next', 'keep', 'other'));
-- 缺的零件 / 东西名称（只有 part）
alter table ops.supplier_issue add column if not exists part_name text not null default '';
alter table ops.supplier_issue drop constraint if exists supplier_issue_part_ck;
alter table ops.supplier_issue add constraint supplier_issue_part_ck check (kind <> 'part' or length(trim(part_name)) > 0);
-- CS 工厂（代理户口下的中国厂，ops.podo_cs；新增时由触发器从 PO 的厂家名称栏带入）
alter table ops.supplier_issue add column if not exists factory text;

-- 开单时记的缺零件：[{item_code(可空), part_name, qty, request, note}]（草稿整份覆盖；确认时变成厂家问题）
alter table ops.supplier_do add column if not exists parts jsonb not null default '[]'::jsonb;

-- 仓库搬动多一种 receive = 点货后的进货，等开单部在 AutoCount 开 GRN（from_loc 空、to_loc = 进哪个仓位）
alter table ops.wh_move add column if not exists do_id bigint references ops.supplier_do(id);
alter table ops.wh_move add column if not exists po_no text;          -- 开 GRN 用哪张 PO（多到、来错的货 = 空）
alter table ops.wh_move add column if not exists outlet text;         -- 给哪间分店的货（来错的货 = 空）
alter table ops.wh_move add column if not exists recv_wrong boolean not null default false;   -- 来错的货（我们的型号）
-- 点货时 AutoCount 已经有这批的进货单（GRN 号，照在路上的先出先到规则算到这张 DO）：这几件 AutoCount 库存已经有了，
-- 不再另算进「应有」（ops.wh_pending 不算）；还是 pending，等开单部核对后标已输入（不会自动标）
alter table ops.wh_move add column if not exists pre_grn text;
alter table ops.wh_move drop constraint if exists wh_move_kind_check;
alter table ops.wh_move add constraint wh_move_kind_check
  check (kind in ('transfer', 'defect', 'display', 'sample', 'return', 'writeoff', 'other', 'receive'));
alter table ops.wh_move drop constraint if exists wh_move_receive_ck;
alter table ops.wh_move add constraint wh_move_receive_ck
  check ((kind = 'receive') = (do_id is not null) and (kind <> 'receive' or (from_loc is null and to_loc is not null)));
create index if not exists wh_move_do_idx on ops.wh_move (do_id) where do_id is not null;

-- 开单部：在 AutoCount 开进货单（GRN）的人。一般模块 + 仓库只看；「待开进货单」与标已输入另外开放（ops.grn_can_mark）。
-- 不给仓库「可审批」（会看到成本、审盘点）。之后可在「员工与权限 → 部门权限」改。
insert into ops.department (code, name, sort) values ('billing', '开单部', 52)
on conflict (code) do update set name = excluded.name, sort = excluded.sort;
insert into ops.dept_module (department, module, level) values
  ('billing', 'dashboard', 'view'), ('billing', 'tasks', 'edit'), ('billing', 'approvals', 'edit'),
  ('billing', 'attendance', 'edit'), ('billing', 'leave', 'edit'), ('billing', 'warehouse', 'view')
on conflict (department, module) do nothing;

-- ==================================================================== 2. 小工具
-- 谁看得到厂家（含 CS 编号）：订货「可编辑」（采购、管理层）、仓库部，加开单部（开 GRN 要知道厂家与 PO）
create or replace function ops.sees_supplier(p_staff ops.staff) returns boolean
language sql stable set search_path = '' as $$
  select coalesce(ops.level_rank(ops.module_level(p_staff, 'purchasing')) >= 2
                  or p_staff.department in ('warehouse', 'billing'), false)
$$;

-- 谁能看「待开进货单」、标进货已输入 AutoCount：开单部或仓库「可审批」（管理层、admin 也是）。
-- 一定要仓库至少「只看」：管理员用个人例外把某位开单部同事的仓库设成「无」就收回（与 ops_wh_move_mark 同规则）。
create or replace function ops.grn_can_mark(p_staff ops.staff) returns boolean
language sql stable set search_path = '' as $$
  select coalesce(p_staff.id is not null and ops.level_rank(ops.module_level(p_staff, 'warehouse')) >= 1
                  and (p_staff.department = 'billing' or ops.level_rank(ops.module_level(p_staff, 'warehouse')) >= 3), false)
$$;

-- 这间公司（账套）的主要仓位：总部账套 = HQ；其他账套 = 那间分店自己的仓位（JB 账套 = JB）。来错的货预设放这里。
create or replace function ops.podo_main_loc(p_company text) returns text
language sql stable set search_path = '' as $$
  select coalesce((select o.own_location from ops.outlet o where o.company = p_company and o.own_location is not null
                   order by o.sort, o.code limit 1), 'HQ')
$$;

-- 这间公司可以放货的仓位：仓库的仓位清单（从 AutoCount 库存带入）+ 主要仓位
create or replace function ops.podo_loc_ok(p_company text, p_loc text) returns boolean
language sql stable set search_path = '' as $$
  select coalesce(p_loc = ops.podo_main_loc(p_company)
                  or exists (select 1 from ops.wh_location l where l.company = p_company and l.code = p_loc), false)
$$;

-- AutoCount 单号栏（可能写了好几张：「GRN-1, GRN-2」）→ 大写单号阵列
create or replace function ops.grn_docs(p text) returns text[]
language sql immutable set search_path = '' as $$
  select coalesce(array_agg(distinct x) filter (where x <> ''), '{}')
  from unnest(regexp_split_to_array(upper(trim(coalesce(p, ''))), '[\s,;/、，]+')) x
$$;

-- 还没输入 AutoCount 的搬动对某仓位的影响（照抄 20261004_ops_warehouse.sql）：
-- 点货时 AutoCount 已经有进货单的进货（pre_grn）不算：AutoCount 库存已经有了，再加会重复
create or replace function ops.wh_pending(p_company text, p_item text, p_loc text) returns numeric
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(case when m.to_loc = p_loc then m.qty else 0 end)
                - sum(case when m.from_loc = p_loc then m.qty else 0 end), 0)
  from ops.wh_move m
  where m.company = p_company and m.item_code = p_item and m.status = 'pending'
    and (m.to_loc = p_loc or m.from_loc = p_loc)
    and not (m.kind = 'receive' and m.pre_grn is not null)
$$;

-- 先出先到：从前面扣 p_amt（扣到 0 为止，多的丢掉）
create or replace function ops.podo_fifo_take(p_rem numeric[], p_amt numeric) returns numeric[]
language plpgsql immutable set search_path = '' as $$
declare
  a numeric := greatest(coalesce(p_amt, 0), 0);
  t numeric;
begin
  for i in 1 .. coalesce(array_length(p_rem, 1), 0) loop
    exit when a <= 0;
    t := least(a, p_rem[i]);
    p_rem[i] := p_rem[i] - t;
    a := a - t;
  end loop;
  return p_rem;
end $$;

-- 这张厂家到货（p_do）每个型号 AutoCount 已经收了几件（照在路上的算法 ops.podo_pool：同厂家同型号所有 PO 一起算、
-- 照起算点先出先到）。qty = 这张算进在路上的件数（记在 PO 行、扣掉坏货 / 到货少）；received = 其中 AutoCount 已经开了 GRN 的。
-- 本地货常常先开 GRN 才点货：点货时 received > 0 = 这几件 AutoCount 库存已经有了。
create or replace function ops.podo_do_rcv(p_company text, p_creditor text, p_do bigint)
returns table (item_code text, qty numeric, received numeric)
language plpgsql stable set search_path = '' as $$
declare
  r record;
  cur text;
  ids bigint[];
  q0 numeric[];
  rem numeric[];
  v_last numeric;
  v_tot numeric;
  k int;
begin
  for r in
    with tr as (select l.item_code, sum(coalesce(l.transferred_qty, 0)) as t from bi.fact_po_line l
                where l.company = p_company and l.creditor_code = p_creditor and nullif(trim(l.item_code), '') is not null
                group by l.item_code),
    rd as (select i.do_id, i.item_code, sum(i.qty) as q from ops.supplier_issue i
           where i.company = p_company and i.creditor_code = p_creditor and i.status <> 'void' and i.do_id is not null
             and (i.kind = 'damaged' or (i.kind = 'short' and not i.auto))
           group by i.do_id, i.item_code),
    ev as (select a.item_code, min(a.rcv_base) as base, max(d.confirmed_at) as at, d.id,
                  least(coalesce(sum(a.qty) filter (where a.dtl_key is not null), 0), sum(a.qty) - coalesce(max(rd.q), 0)) as qty
           from ops.supplier_do_apply a
           join ops.supplier_do d on d.id = a.do_id
           left join rd on rd.do_id = a.do_id and rd.item_code = a.item_code
           where d.company = p_company and d.creditor_code = p_creditor and not a.void
             and d.status in ('confirmed', 'arrived')
             and a.item_code in (select x.item_code from ops.supplier_do_apply x where x.do_id = p_do and not x.void)
           group by a.item_code, d.id)
    select ev.*, coalesce(tr.t, 0) as t from ev left join tr on tr.item_code = ev.item_code
    where ev.qty > 0 order by ev.item_code, ev.base, ev.at, ev.id
  loop
    if cur is distinct from r.item_code then
      if cur is not null then
        rem := ops.podo_fifo_take(rem, v_tot - v_last);
        k := array_position(ids, p_do);
        if k is not null then
          item_code := cur; qty := q0[k]; received := q0[k] - rem[k];
          return next;
        end if;
      end if;
      cur := r.item_code; ids := '{}'; q0 := '{}'; rem := '{}'; v_last := coalesce(r.base, 0); v_tot := r.t;
    end if;
    rem := ops.podo_fifo_take(rem, coalesce(r.base, 0) - v_last);
    v_last := greatest(v_last, coalesce(r.base, 0));
    ids := ids || r.id;
    q0 := q0 || r.qty;
    rem := rem || r.qty;
  end loop;
  if cur is not null then
    rem := ops.podo_fifo_take(rem, v_tot - v_last);
    k := array_position(ids, p_do);
    if k is not null then
      item_code := cur; qty := q0[k]; received := q0[k] - rem[k];
      return next;
    end if;
  end if;
end $$;

-- 某厂家某型号从 p_from（含）起 AutoCount 的进货单（GRN），扣掉已经用掉的：别笔进货标已输入时写了这张单号（ac_doc），
-- 或点货时记成「AutoCount 已经有」（pre_grn）。一笔写了好几张单号的，数量平均摊到每张。qty = 还没对上的件数。
create or replace function ops.grn_avail(p_company text, p_creditor text, p_item text, p_from date)
returns table (doc_no text, rcv_date date, qty numeric)
language sql stable set search_path = '' as $$
  with g as (
    select upper(r.doc_no) as doc_no, min(r.rcv_date) as rcv_date, sum(r.qty) as qty
    from bi.fact_po_receipt r
    where r.company = p_company and r.item_code = p_item and r.rcv_date >= p_from
      and r.po_no in (select l.po_no from bi.fact_po_line l where l.company = p_company and l.creditor_code = p_creditor)
    group by upper(r.doc_no)),
  u as (
    select z.doc, sum(z.q) as q
    from (select unnest(x.docs) as doc, x.qty / greatest(cardinality(x.docs), 1) as q
          from (select m.qty, case when m.status = 'done' then ops.grn_docs(m.ac_doc) else ops.grn_docs(m.pre_grn) end as docs
                from ops.wh_move m
                where m.company = p_company and m.item_code = p_item and m.kind = 'receive'
                  and (m.status = 'done' or (m.status = 'pending' and m.pre_grn is not null))) x) z
    group by z.doc)
  select g.doc_no, g.rcv_date, g.qty - coalesce(u.q, 0)
  from g left join u on u.doc = g.doc_no
  where g.qty - coalesce(u.q, 0) > 0
  order by g.rcv_date, g.doc_no
$$;

-- 要厂家怎么处理：空 = null；不认得就报错
create or replace function ops.podo_request(p text) returns text
language plpgsql immutable set search_path = '' as $$
declare
  v text := nullif(lower(trim(coalesce(p, ''))), '');
begin
  if v is not null and v not in ('replace', 'return', 'next', 'keep', 'other') then
    raise exception '「要厂家怎么处理」不对：%。', p using errcode = '22023';
  end if;
  return v;
end $$;

-- 厂家问题的 CS 工厂：所选 PO 里这个型号那行的厂家名称栏（没有就看这些 PO 的任何一行）
create or replace function ops.podo_factory(p_company text, p_creditor text, p_item text, p_pos text[]) returns text
language sql stable set search_path = '' as $$
  select ops.podo_cs(l.creditor_name) from bi.fact_po_line l
  where l.company = p_company and l.creditor_code = p_creditor and l.po_no = any (coalesce(p_pos, '{}'))
    and ops.podo_cs(l.creditor_name) is not null
  order by (l.item_code is not distinct from p_item) desc, l.po_date desc, l.dtl_key
  limit 1
$$;

create or replace function ops.supplier_issue_factory() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.factory is null then
    new.factory := ops.podo_factory(new.company, new.creditor_code, new.item_code, new.po_nos);
  end if;
  return new;
end $$;
do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'supplier_issue_factory' and tgrelid = 'ops.supplier_issue'::regclass) then
    create trigger supplier_issue_factory before insert on ops.supplier_issue
      for each row execute function ops.supplier_issue_factory();
  end if;
end $$;
update ops.supplier_issue x set factory = ops.podo_factory(x.company, x.creditor_code, x.item_code, x.po_nos)
where x.factory is null;

-- 厂家还欠几件：少发（未决定 / 厂家会补，还没补齐的）、缺零件（还没处理、没取消的）；其他 0
create or replace function ops.podo_owed(i ops.supplier_issue) returns numeric
language sql immutable set search_path = '' as $$
  select case when i.status = 'open' and i.kind in ('short', 'part') and coalesce(i.decision, 'pending') in ('pending', 'await')
              then greatest(i.qty - i.resolved_qty, 0) else 0 end
$$;

-- 要问厂家 ETA 的 PO：中国货开单 ≥ 30 天、本地货 ≥ 7 天、≤ 120 天（更旧的预设隐藏）、没关闭 / 没标到货、
-- 没填 ETA、没挂货柜，也还没有任何（非取消的）厂家到货
create or replace function ops.po_needs_eta(x ops.v_po_open) returns boolean
language sql stable set search_path = '' as $$
  select coalesce(x.status not in ('closed', 'arrived') and x.po_eta is null and x.shipment_id is null
                  and x.days_open >= case when x.is_china then 30 else 7 end and x.days_open <= 120
                  and not exists (select 1 from ops.supplier_do d where d.company = x.company and d.po_nos @> array[x.po_no]
                                  and d.status <> 'cancelled'), false)
$$;

-- 点货后的好货进哪个仓位（进货待入 AutoCount）：
--   总部账套：总部仓库的货 → 那行 PO 的仓位（HQ / SRGADING；那行不是总部订的、没有 PO 行 → HQ）；
--             其他分店 → 总部账套里替那间分店预留的仓位（JB → PRE (JB)、Batu → PRE (BATU)、Puchong → PRE (PUCHONG)）。
--   其他账套（JB）：那行 PO 在 JB 账套的仓位（没有就那个账套的主要仓位 ops.podo_main_loc，JB 账套 = JB）。
create or replace function ops.podo_recv_loc(p_company text, p_outlet text, p_line_outlet text, p_line_loc text) returns text
language sql stable set search_path = '' as $$
  select case
    when p_company <> 'HOMEWORKSSB' then coalesce(nullif(upper(trim(p_line_loc)), ''), ops.podo_main_loc(p_company))
    when o.pre_location is not null then o.pre_location
    when p_line_outlet = p_outlet and upper(trim(coalesce(p_line_loc, ''))) = any (o.po_locations) then upper(trim(p_line_loc))
    else coalesce(o.own_location, 'HQ') end
  from (select 1) z left join ops.outlet o on o.code = p_outlet
$$;

-- ==================================================================== 3. 厂家到货：SOP 步骤；厂家问题多「要厂家怎么处理」、缺零件、CS 工厂、厂家还欠
-- DO 表头（照抄 20261012_ops_po_do.sql），多回 sop：
--   step 1 选 PO → 2 出货数量 → 3 分配分店 → 4 ETA → 5 确认（以上订货部）→ 6 点货（仓库部）→ 7 厂家问题（采购决定少发 / 缺零件）→ 8 都做完；
--   取消的 DO 是 null。草稿照「第一个还没做的」算（ETA 可以不填就确认，所以 4 没做也可以按确认）。
--   owner = 等哪个部门（purchasing / warehouse / billing / null）；done = 每一步做完没有；decide_n = 这张还没决定的少发 + 缺零件；
--   grn_n = 点货产生、开单部还没在 AutoCount 开进货单（GRN）的笔数（第 8 步还有这个 = 等开单部，不算「都做完了」）；
--   draft_overdue = 草稿从开单（created_at）起超过 24 小时还没确认。
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
    'can_add_issue', coalesce(d.status in ('confirmed', 'arrived') and k.po >= 2 and k.sees, false),
    'sop', jsonb_build_object(
      'step', case d.status
                when 'draft' then case when not f.po then 1 when not f.shipped then 2 when not f.alloc then 3
                                       when not f.eta then 4 else 5 end
                when 'confirmed' then 6
                when 'arrived' then case when f.decide_n > 0 then 7 else 8 end end,
      'owner', case when d.status = 'confirmed' then 'warehouse'
                    when d.status = 'draft' or (d.status = 'arrived' and f.decide_n > 0) then 'purchasing'
                    when d.status = 'arrived' and f.grn_n > 0 then 'billing' end,
      'done', jsonb_build_object('po', f.po, 'shipped', f.shipped, 'alloc', f.alloc, 'eta', f.eta,
                                 'confirmed', d.status in ('confirmed', 'arrived'), 'received', d.status = 'arrived',
                                 'decided', f.decide_n = 0),
      'decide_n', f.decide_n,
      'grn_n', f.grn_n,
      'draft_overdue', coalesce(d.status = 'draft' and d.created_at < ops.now() - interval '24 hours', false)))
  from (select ops.level_rank(ops.module_level(p_me, 'purchasing')) as po,
               ops.level_rank(ops.module_level(p_me, 'warehouse')) as wh,
               ops.sees_company(p_me, d.company) as sees) k
  left join ops.shipment s on s.id = d.shipment_id and s.status <> 'cancelled'
  cross join lateral (
    select cardinality(d.po_nos) > 0 as po,
           exists (select 1 from jsonb_array_elements(d.items) x where coalesce((x ->> 'shipped')::numeric, 0) > 0) as shipped,
           exists (select 1 from jsonb_array_elements(d.items) x where coalesce((x ->> 'shipped')::numeric, 0) > 0)
           and not exists (
             select 1 from jsonb_array_elements(d.items) x
             where x ->> 'item_code' is not null and coalesce((x ->> 'shipped')::numeric, 0) > 0
               and (select coalesce(sum(v.value::numeric), 0)
                    from jsonb_each_text(case when jsonb_typeof(x -> 'alloc') = 'object' then x -> 'alloc' else '{}'::jsonb end) v)
                   <> (x ->> 'shipped')::numeric) as alloc,
           coalesce(s.eta, d.eta) is not null as eta,
           (select count(*) from ops.supplier_issue i where i.do_id = d.id and i.status = 'open'
              and i.kind in ('short', 'part') and i.decision = 'pending')::int as decide_n,
           (select count(*) from ops.wh_move m where m.do_id = d.id and m.kind = 'receive' and m.status = 'pending')::int as grn_n) f
$$;

-- 新增一笔厂家问题（多了要厂家怎么处理、零件名称）；少发、缺零件预设「未决定」
create or replace function ops.podo_issue_make(d ops.supplier_do, p_me bigint, p_kind text, p_item text, p_recv text,
  p_desc text, p_pos text[], p_ordered numeric, p_received numeric, p_qty numeric, p_note text, p_auto boolean,
  p_request text, p_part text)
returns ops.supplier_issue
language plpgsql set search_path = '' as $$
declare
  r ops.supplier_issue;
begin
  insert into ops.supplier_issue (company, creditor_code, supplier_name, do_id, kind, item_code, received_code, description,
                                  po_nos, ordered, received, qty, decision, auto, note, created_by, request, part_name)
  values (d.company, d.creditor_code, d.supplier_name, d.id, p_kind, p_item, coalesce(p_recv, ''), coalesce(p_desc, ''),
          coalesce(p_pos, '{}'), p_ordered, p_received, p_qty, case when p_kind in ('short', 'part') then 'pending' end, p_auto,
          left(coalesce(p_note, ''), 500), p_me, p_request, left(coalesce(p_part, ''), 200))
  returning * into r;
  return r;
end $$;

-- 原本的（20261012）：签名不变，改成叫 ops.podo_issue_make
create or replace function ops.podo_issue_new(d ops.supplier_do, p_me bigint, p_kind text, p_item text, p_recv text,
  p_desc text, p_pos text[], p_ordered numeric, p_received numeric, p_qty numeric, p_note text, p_auto boolean)
returns ops.supplier_issue
language plpgsql set search_path = '' as $$
begin
  return ops.podo_issue_make(d, p_me, p_kind, p_item, p_recv, p_desc, p_pos, p_ordered, p_received, p_qty, p_note, p_auto,
                             null, '');
end $$;

-- 少发在开单时就决定了（厂家会补 / 取消）：跟 ops_po_issue_set 的 await / cancel 一样
create or replace function ops.podo_decide(p_id bigint, p_decision text, p_me bigint) returns void
language sql set search_path = '' as $$
  update ops.supplier_issue x set
    decision = p_decision, decided_by = p_me, decided_at = now(),
    status = case when p_decision = 'cancelled' then 'resolved' else x.status end,
    resolved_by = case when p_decision = 'cancelled' then p_me else x.resolved_by end,
    resolved_at = case when p_decision = 'cancelled' then now() else x.resolved_at end,
    resolved_auto = case when p_decision = 'cancelled' then false else x.resolved_auto end,
    updated_at = now()
  where x.id = p_id and x.status = 'open' and p_decision in ('await', 'cancelled')
$$;

-- 厂家问题（照抄 20261012），多回 request（要厂家怎么处理）、part_name（缺的零件）、factory（CS 工厂）、owed_qty（厂家还欠）
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
    'updated_at', i.updated_at, 'request', i.request, 'part_name', i.part_name, 'factory', i.factory,
    'owed_qty', ops.podo_owed(i))
  from (select 1) z left join ops.supplier_do d on d.id = i.do_id
$$;

-- 整张 DO（照抄 20261014_ops_po_receive.sql），多回 parts（开单时记的缺零件，确认时变成厂家问题）、
-- main_location（这间公司的主要仓位：点货后补记来错的货（我们的型号）进这里）
create or replace function ops.podo_full(p_me ops.staff, d ops.supplier_do) returns jsonb
language sql stable set search_path = '' as $$
  select ops.podo_json(p_me, d) || jsonb_build_object(
    'items', d.items,
    'receipt', d.receipt,
    'parts', d.parts,
    'main_location', ops.podo_main_loc(d.company),
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

-- ==================================================================== 4. 存草稿：少发先决定、来错的型号（我们的商品 / 不是我们的产品、要厂家怎么处理）、缺零件
-- 照抄 20261012_ops_po_do.sql，多：
--   items[]（对上 PO 的行）short_decision：pending / await / cancelled（少发先决定；只存 await / cancelled，确认时套到自动产生的少发）；
--   items[]（对不上 PO 的行 = 来错的型号）own：true = 收到的是我们的商品（src_code 要是我们的型号，品名自动带）/
--     false = 不是我们的产品（手动加的行品名必填）/ 没给 = 旧做法；request：要厂家怎么处理；
--   parts[]：{item_code（可空；要在所选 PO 里）, part_name（必填）, qty（> 0）, request（预设 next）, note}，最多 100 行。
--   已确认的 DO 不能改 parts（要先退回草稿；确认后补记缺零件用 ops_po_issue_add kind = part）。
create or replace function public.ops_po_do_save(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  d ops.supplier_do;
  v_id bigint := nullif(p ->> 'id', '')::bigint;
  v_key text := nullif(trim(coalesce(p ->> 'client_key', '')), '');
  v_company text;
  v_cred text;
  v_supname text;
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
  v_sd text;
  v_own boolean;
  v_req text;
  v_src text;
  v_rdesc text;
  v_name text;
  v_note text;
  v_parts jsonb;
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
    if d.status <> 'draft' and (p ? 'items' or p ? 'po_nos' or p ? 'creditor_code' or p ? 'company' or p ? 'parts') then
      raise exception '这张 DO 已确认，要改货品或 PO 请先「退回草稿」。' using errcode = '22023';
    end if;
  end if;

  -- 公司、厂家、PO、各型号：只有草稿才会改（已确认的照旧，不再对 BI 资料检查）
  if d.id is not null and d.status <> 'draft' then
    v_company := d.company;
    v_cred := d.creditor_code;
    v_supname := d.supplier_name;
    v_pos := d.po_nos;
    v_items := d.items;
    v_parts := d.parts;
  else
    v_company := ops.podo_company(me, coalesce(nullif(p ->> 'company', ''), d.company));
    v_cred := coalesce(nullif(trim(coalesce(p ->> 'creditor_code', '')), ''), d.creditor_code);
    if v_cred is null then
      raise exception '请先选厂家。' using errcode = '22023';
    end if;
    select l.creditor_code, coalesce(sp.name, l.creditor_name, '') into v_cred, v_supname
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
        v_sd := nullif(lower(trim(coalesce(e ->> 'short_decision', ''))), '');
        if v_sd is not null and v_sd not in ('pending', 'await', 'cancelled') then
          raise exception '型号 % 的少发要选「厂家会补」「取消（下次再订）」或「未决定」。', v_code using errcode = '22023';
        end if;
        v_own := null;
        v_req := null;
      else
        -- 对不上 PO 的行（发错型号）：要有型号或品名；整行空白就略过
        if coalesce(trim(e ->> 'src_code'), '') = '' and coalesce(trim(e ->> 'src_desc'), '') = '' then
          continue;
        end if;
        v_desc := left(trim(coalesce(e ->> 'src_desc', '')), 300);
        v_uom := '';
        v_alloc := '{}'::jsonb;
        v_sd := null;
        v_req := ops.podo_request(e ->> 'request');
        v_own := case when jsonb_typeof(e -> 'own') = 'boolean' then (e ->> 'own')::boolean end;
        if v_own then
          -- 收到的是我们的商品：型号照我们的写法，品名没填就带我们的
          select i.item_code, i.description into v_src, v_rdesc from bi.dim_item i
          where i.company = v_company and upper(i.item_code) = upper(trim(coalesce(e ->> 'src_code', ''))) limit 1;
          if not found then
            raise exception '来错的型号：找不到我们的型号 %。', coalesce(nullif(trim(e ->> 'src_code'), ''), '（空白）')
              using errcode = '22023';
          end if;
          v_desc := coalesce(nullif(v_desc, ''), v_rdesc, '');
        elsif v_own is false and v_desc = '' then
          raise exception '来错的型号「不是我们的产品」请填品名。' using errcode = '22023';
        end if;
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
        'src_code', case when v_own then v_src else left(trim(coalesce(e ->> 'src_code', '')), 100) end,
        'src_desc', case when v_own then v_desc else left(trim(coalesce(e ->> 'src_desc', '')), 300) end,
        'src_row', case when trim(coalesce(e ->> 'src_row', '')) ~ '^[0-9]{1,7}$' then (e ->> 'src_row')::int end,
        'expected_code', v_exp, 'note', left(trim(coalesce(e ->> 'note', '')), 500))
        || case when v_sd in ('await', 'cancelled') then jsonb_build_object('short_decision', v_sd) else '{}'::jsonb end
        || case when v_own is not null then jsonb_build_object('own', v_own) else '{}'::jsonb end
        || case when v_req is not null then jsonb_build_object('request', v_req) else '{}'::jsonb end);
    end loop;

    -- 缺零件 / 其他要补的（确认时记成厂家问题 kind = part；不影响在路上与少发）
    if p ? 'parts' and jsonb_typeof(p -> 'parts') is distinct from 'array' then
      raise exception '资料格式不对。' using errcode = '22023';
    end if;
    v_parts := '[]'::jsonb;
    for e in select x from jsonb_array_elements(case when p ? 'parts' then p -> 'parts' else coalesce(d.parts, '[]'::jsonb) end) x loop
      if jsonb_typeof(e) is distinct from 'object' then
        raise exception '资料格式不对。' using errcode = '22023';
      end if;
      v_name := left(trim(coalesce(e ->> 'part_name', '')), 200);
      v_note := left(trim(coalesce(e ->> 'note', '')), 500);
      v_q := ops.podo_num(e -> 'qty', '缺零件的数量');
      v_code := nullif(trim(coalesce(e ->> 'item_code', '')), '');
      if v_name = '' and v_code is null and v_q is null and v_note = '' then
        continue;
      end if;
      if v_name = '' then
        raise exception '缺零件请填零件 / 东西名称。' using errcode = '22023';
      end if;
      if coalesce(v_q, 0) <= 0 then
        raise exception '缺零件「%」请填数量。', v_name using errcode = '22023';
      end if;
      if v_code is not null then
        select l.item_code into v_code from bi.fact_po_line l
        where l.company = v_company and l.creditor_code = v_cred and l.po_no = any (v_pos)
          and not coalesce(l.cancelled, false) and upper(l.item_code) = upper(trim(e ->> 'item_code'))
        limit 1;
        if not found then
          raise exception '型号 % 不在所选的 PO 里。', trim(e ->> 'item_code') using errcode = '22023';
        end if;
      end if;
      v_parts := v_parts || jsonb_build_array(jsonb_build_object(
        'item_code', v_code, 'part_name', v_name, 'qty', v_q, 'request', coalesce(ops.podo_request(e ->> 'request'), 'next'),
        'note', v_note));
    end loop;
    if jsonb_array_length(v_parts) > 100 then
      raise exception '缺零件最多 100 行。' using errcode = '22023';
    end if;
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
                                 files, remark, client_key, created_by, updated_by, parts)
    values (v_company, v_cred, coalesce(v_supname, ''), v_do_no, nullif(p ->> 'do_date', '')::date, nullif(p ->> 'eta', '')::date,
            v_ship, v_pos, v_items, v_files, left(coalesce(p ->> 'remark', ''), 1000), v_key, me.id, me.id, v_parts)
    returning * into d;
    perform ops.log(me.id, 'create', 'supplier_do', d.id,
                    jsonb_build_object('do_no', d.do_no, 'creditor_code', d.creditor_code, 'po_nos', d.po_nos));
  else
    update ops.supplier_do x set
      company = v_company, creditor_code = v_cred, supplier_name = coalesce(v_supname, x.supplier_name), do_no = v_do_no,
      do_date = case when p ? 'do_date' then nullif(p ->> 'do_date', '')::date else x.do_date end,
      eta = case when p ? 'eta' then nullif(p ->> 'eta', '')::date else x.eta end,
      shipment_id = v_ship, po_nos = v_pos, items = v_items, files = v_files, parts = v_parts,
      remark = case when p ? 'remark' then left(coalesce(p ->> 'remark', ''), 1000) else x.remark end,
      updated_by = me.id, updated_at = now()
    where x.id = d.id returning * into d;
    perform ops.log(me.id, 'update', 'supplier_do', d.id,
                    jsonb_build_object('do_no', d.do_no, 'eta', d.eta, 'po_nos', d.po_nos, 'items', jsonb_array_length(d.items)));
  end if;
  return ops.podo_full(me, d);
end $$;

-- ==================================================================== 5. 确认：少发先决定、来错的型号要厂家怎么处理、缺零件变成厂家问题
-- 照抄 20261012_ops_po_do.sql，多三件事：
--   第 6 步新记的少发：开单时选了 short_decision（await 厂家会补 / cancelled 取消（下次再订））就直接套上（跟 ops_po_issue_set 一样）；
--     退回草稿后再确认、少发是之前留著的（已经决定过）：照那笔原本的决定，不再套。
--   来错的型号：request（要厂家怎么处理）记进厂家问题。
--   缺零件（supplier_do.parts）：同型号同名称合起来记成 kind = part（auto）；退回草稿再确认只记比这张留著的多出来的。
--     要厂家「下次补上」（预设）= 已经决定「厂家会补」（不用采购再按一次）；其他（例：其他（写在备注））= 未决定。
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
  v_new ops.supplier_issue;
  v_sd text;
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
      v_new := ops.podo_issue_new(d, me.id, 'short', it.item_code, '', v_desc, v_ipos, v_rem, v_ship, v_left - v_flag,
                                  coalesce(it.r_item ->> 'note', ''), true);
      -- 开单时就选了「厂家会补 / 取消（下次再订）」：套到这笔少发
      v_sd := it.r_item ->> 'short_decision';
      if v_sd in ('await', 'cancelled') then
        perform ops.podo_decide(v_new.id, v_sd, me.id);
        perform ops.log(me.id, case v_sd when 'await' then 'issue_await' else 'issue_cancel' end, 'supplier_issue', v_new.id,
                        jsonb_build_object('from', 'confirm'));
      end if;
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
                  sum((x ->> 'shipped')::numeric) as qty, coalesce(string_agg(nullif(x ->> 'note', ''), '；'), '') as note,
                  (array_agg(x ->> 'request') filter (where x ->> 'request' is not null))[1] as req
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
      perform ops.podo_issue_make(d, me.id, 'wrong', w.exp, w.code, w.descr, d.po_nos, v_rem, w.qty, v_take, w.note, true,
                                  w.req, '');
    end if;
  end loop;

  -- 缺零件 / 其他要补的（开单时记的）：同型号同名称合起来；退回草稿再确认只记比这张留著的多出来的
  for w in select t.x ->> 'item_code' as code, upper(t.x ->> 'part_name') as name_u, min(t.x ->> 'part_name') as pname,
                  sum((t.x ->> 'qty')::numeric) as qty, (array_agg(t.x ->> 'request' order by t.o))[1] as req,
                  coalesce(string_agg(nullif(t.x ->> 'note', ''), '；' order by t.o), '') as note
           from jsonb_array_elements(d.parts) with ordinality t(x, o)
           group by 1, 2 order by min(t.o) loop
    select w.qty - coalesce(sum(x.qty), 0) into v_take from ops.supplier_issue x
    where x.do_id = d.id and x.kind = 'part' and x.status <> 'void' and x.item_code is not distinct from w.code
      and upper(x.part_name) = w.name_u;
    if v_take > 0 then
      v_new := ops.podo_issue_make(d, me.id, 'part', w.code, '',
        coalesce((select y ->> 'description' from jsonb_array_elements(d.items) y where y ->> 'item_code' = w.code limit 1),
                 (select di.description from bi.dim_item di where di.company = d.company and di.item_code = w.code), ''),
        coalesce((select array_agg(z order by z) from jsonb_array_elements_text(v_pomap -> w.code) z), d.po_nos),
        null, null, v_take, w.note, true, coalesce(w.req, 'next'), w.pname);
      if v_new.request = 'next' then
        perform ops.podo_decide(v_new.id, 'await', me.id);
        perform ops.log(me.id, 'issue_await', 'supplier_issue', v_new.id, jsonb_build_object('from', 'confirm'));
      end if;
    end if;
  end loop;

  update ops.supplier_do x set status = 'confirmed', confirmed_by = me.id, confirmed_at = now(), updated_by = me.id,
                               updated_at = now()
  where x.id = d.id returning * into d;
  perform ops.log(me.id, 'confirm', 'supplier_do', d.id, jsonb_build_object('do_no', d.do_no, 'po_nos', d.po_nos));
  return ops.podo_full(me, d);
end $$;

-- ==================================================================== 6. 厂家问题：厂家还欠、缺零件、要厂家怎么处理、搜我们的商品
-- 清单（照抄 20261012_ops_po_do.sql），p 多：owed（true = 只列厂家还欠的：少发未决定 / 厂家会补还没补齐、缺零件还没处理）、
-- factory（CS 编号，cs28 = CS028）；搜寻也找零件名称与 CS 编号；排序：厂家 → CS 工厂 → 建立先后。
create or replace function public.ops_po_issues(p jsonb default '{}'::jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  st text := coalesce(nullif(p ->> 'status', ''), 'open');
  v_q text := nullif(trim(coalesce(p ->> 'q', '')), '');
begin
  me := ops.require_level('purchasing', 'edit');
  return (
    select coalesce(jsonb_agg(ops.podo_issue_json(x.i) order by (x.i).supplier_name, (x.i).creditor_code,
                              coalesce((x.i).factory, ''), (x.i).created_at, (x.i).id), '[]'::jsonb)
    from (select i from ops.supplier_issue i
          left join ops.supplier_do d on d.id = i.do_id
          where ops.sees_company(me, i.company)
            and case st when 'all' then i.status <> 'void' else i.status = st end
            and (nullif(p ->> 'company', '') is null or i.company = p ->> 'company')
            and (nullif(p ->> 'creditor_code', '') is null or i.creditor_code = p ->> 'creditor_code')
            and (nullif(p ->> 'kind', '') is null or i.kind = p ->> 'kind')
            and (nullif(p ->> 'factory', '') is null or i.factory = ops.podo_cs(p ->> 'factory'))
            and (not coalesce((p ->> 'owed')::boolean, false) or ops.podo_owed(i) > 0)
            and (v_q is null or i.supplier_name ilike '%' || v_q || '%' or coalesce(i.item_code, '') ilike '%' || v_q || '%'
                 or i.part_name ilike '%' || v_q || '%' or coalesce(i.factory, '') ilike '%' || v_q || '%'
                 or i.received_code ilike '%' || v_q || '%' or i.description ilike '%' || v_q || '%'
                 or coalesce(d.do_no, '') ilike '%' || v_q || '%' or array_to_string(i.po_nos, ' ') ilike '%' || v_q || '%')
          order by i.id desc limit 2000) x
  );
end $$;

-- 手动记问题（DO 确认后；订货或仓库「可编辑」）。照抄 20261014_ops_po_receive.sql，多：
--   kind = part（缺零件 / 其他要补的）：part_name 必填、item_code 可空（要是这张 DO 的型号）、request 预设 next（下次补上）；
--     next = 已经决定「厂家会补」；不影响在路上与少发数量；
--   request（要厂家怎么处理；到货少不用）；
--   wrong：own = true（收到的是我们的商品：received_code 要是我们的型号，品名没填就带我们的）/ false（不是我们的产品：品名必填）。
--   已点货的 DO（库存跟著变，进货待入 AutoCount = 仓库搬动 kind = receive）：
--     补记坏货 / 到货少 → 这个型号还没输入 AutoCount 的进货先扣（没有 PO 的多到先扣、总部的先扣、后来的先扣）；
--       已经输入 AutoCount（或点货时 AutoCount 就有 = pre_grn）的扣不到 → stock_left = 扣不到的件数（AutoCount 库存要由
--       仓库主管调整，例：登记「报坏」）；
--     补记来错的货（我们的型号）→ 多一笔进货待入 AutoCount（location，预设这间公司的主要仓位）。
--   回传多 stock_left、move_id。
create or replace function public.ops_po_issue_add(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  d ops.supplier_do;
  v_kind text := coalesce(nullif(p ->> 'kind', ''), 'damaged');
  v_qty numeric;
  v_code text := nullif(trim(coalesce(p ->> 'item_code', '')), '');
  v_recv text := left(trim(coalesce(p ->> 'received_code', '')), 100);
  v_desc text := left(trim(coalesce(p ->> 'description', '')), 300);
  v_part text := left(trim(coalesce(p ->> 'part_name', '')), 200);
  v_own boolean := case when jsonb_typeof(p -> 'own') = 'boolean' then (p ->> 'own')::boolean end;
  v_loc text := nullif(upper(trim(coalesce(p ->> 'location', ''))), '');
  v_req text;
  v_rdesc text;
  v_row jsonb;
  v_red numeric;
  v_left numeric := 0;
  v_take numeric;
  v_move bigint;
  m record;
  r ops.supplier_issue;
begin
  me := ops.require_staff();
  if not coalesce(ops.level_rank(ops.module_level(me, 'purchasing')) >= 2
                  or ops.level_rank(ops.module_level(me, 'warehouse')) >= 2, false) then
    raise exception '要「订货与 ETA」或「仓库」可编辑才能记厂家问题。' using errcode = '42501';
  end if;
  select * into d from ops.supplier_do x
  where x.id = case when (p ->> 'do_id') ~ '^[0-9]{1,18}$' then (p ->> 'do_id')::bigint end for update;
  if d.id is null or not ops.sees_company(me, d.company) then
    raise exception '找不到这张厂家 DO。' using errcode = 'P0002';
  end if;
  if d.status not in ('confirmed', 'arrived') then
    raise exception 'DO 确认之后才能记坏货、到货少或发错型号。' using errcode = '22023';
  end if;
  if v_kind not in ('damaged', 'short', 'wrong', 'part') then
    raise exception '只能手动记坏货、到货少、发错型号或缺零件（少发、多发确认时自动算）。' using errcode = '22023';
  end if;
  v_req := case when v_kind <> 'short' then ops.podo_request(p ->> 'request') end;
  v_qty := ops.podo_num(p -> 'qty', '数量');
  if coalesce(v_qty, 0) <= 0 then
    raise exception '请填数量。' using errcode = '22023';
  end if;
  if v_kind in ('damaged', 'short') then
    if v_code is null then
      raise exception '请选型号。' using errcode = '22023';
    end if;
    select x into v_row from jsonb_array_elements(d.items) x where upper(x ->> 'item_code') = upper(v_code) limit 1;
    if v_row is null then
      raise exception '这张 DO 没有型号 %。', v_code using errcode = '22023';
    end if;
    select coalesce(sum(x.qty), 0) into v_red from ops.supplier_issue x
    where x.do_id = d.id and x.item_code = v_row ->> 'item_code' and x.status <> 'void'
      and (x.kind = 'damaged' or (x.kind = 'short' and not x.auto));
    if v_qty + v_red > (v_row ->> 'shipped')::numeric then
      raise exception '坏货、到货少合计不能多过这张 DO 的出货数量（%）。', ops.podo_fmt((v_row ->> 'shipped')::numeric)
        using errcode = '22023';
    end if;
    r := ops.podo_issue_make(d, me.id, v_kind, v_row ->> 'item_code', '', v_row ->> 'description', d.po_nos, null,
                             (v_row ->> 'shipped')::numeric, v_qty, p ->> 'note', false, v_req, '');
    -- 已点货：这几件不是好货了 → 扣还没输入 AutoCount 的进货
    if d.status = 'arrived' then
      v_left := v_qty;
      for m in select x.id, x.qty from ops.wh_move x
               where x.do_id = d.id and x.kind = 'receive' and x.status = 'pending' and not x.recv_wrong
                 and x.item_code = v_row ->> 'item_code' and x.pre_grn is null
               order by (x.po_no is null) desc, (x.outlet = 'HQ') desc, x.id desc
               for update loop
        exit when v_left <= 0;
        v_take := least(v_left, m.qty);
        update ops.wh_move x set
          qty = case when v_take < m.qty then m.qty - v_take else x.qty end,
          status = case when v_take < m.qty then x.status else 'cancelled' end,
          done_by = case when v_take < m.qty then x.done_by else me.id end,
          done_at = case when v_take < m.qty then x.done_at else now() end,
          note = left(case when x.note = '' then '' else x.note || '；' end
                      || '点货后补记' || case v_kind when 'damaged' then '坏货' else '到货少' end || ' ' || ops.podo_fmt(v_take), 500)
        where x.id = m.id;
        perform ops.log(me.id, 'receive_less', 'wh_move', m.id, jsonb_build_object('issue_id', r.id, 'qty', v_take, 'was', m.qty));
        v_left := v_left - v_take;
      end loop;
    end if;
  elsif v_kind = 'part' then
    if v_part = '' then
      raise exception '请填缺的零件 / 东西名称。' using errcode = '22023';
    end if;
    if v_code is not null then
      select x into v_row from jsonb_array_elements(d.items) x where upper(x ->> 'item_code') = upper(v_code) limit 1;
      if v_row is null then
        raise exception '这张 DO 没有型号 %。', v_code using errcode = '22023';
      end if;
    end if;
    r := ops.podo_issue_make(d, me.id, 'part', v_row ->> 'item_code', '', coalesce(v_row ->> 'description', ''),
           coalesce((select array_agg(distinct l.po_no order by l.po_no) from bi.fact_po_line l
                     where l.company = d.company and l.creditor_code = d.creditor_code and l.po_no = any (d.po_nos)
                       and l.item_code = v_row ->> 'item_code'), d.po_nos),
           null, null, v_qty, p ->> 'note', false, coalesce(v_req, 'next'), v_part);
    -- 要厂家「下次补上」= 厂家会补（不用再按一次）
    if r.request = 'next' then
      perform ops.podo_decide(r.id, 'await', me.id);
      perform ops.log(me.id, 'issue_await', 'supplier_issue', r.id, jsonb_build_object('from', 'add'));
      select * into r from ops.supplier_issue x where x.id = r.id;
    end if;
  else
    if v_own then
      select i.item_code, i.description into v_recv, v_rdesc from bi.dim_item i
      where i.company = d.company and upper(i.item_code) = upper(trim(coalesce(p ->> 'received_code', ''))) limit 1;
      if not found then
        raise exception '找不到我们的型号 %。', coalesce(nullif(trim(p ->> 'received_code'), ''), '（空白）') using errcode = '22023';
      end if;
      v_desc := coalesce(nullif(v_desc, ''), v_rdesc, '');
      v_loc := coalesce(v_loc, ops.podo_main_loc(d.company));
      if d.status = 'arrived' and not ops.podo_loc_ok(d.company, v_loc) then
        raise exception '没有这个仓位 %。', v_loc using errcode = '22023';
      end if;
    elsif v_own is false then
      if v_desc = '' then
        raise exception '「不是我们的产品」请填品名。' using errcode = '22023';
      end if;
    elsif v_recv = '' and coalesce(trim(p ->> 'note'), '') = '' then
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
    r := ops.podo_issue_make(d, me.id, 'wrong', v_code, v_recv, v_desc, d.po_nos, null, v_qty, v_qty, p ->> 'note', false,
                             v_req, '');
    -- 已点货、收到的是我们的型号：货在仓库 → 进货待入 AutoCount（没有 PO）
    if d.status = 'arrived' and v_own then
      insert into ops.wh_move (company, item_code, qty, kind, from_loc, to_loc, note, created_by, do_id, po_no, outlet, recv_wrong)
      values (d.company, v_recv, v_qty, 'receive', null, v_loc, '点货后补记来错的货', me.id, d.id, null, null, true)
      returning id into v_move;
    end if;
  end if;
  perform ops.log(me.id, 'issue_add', 'supplier_do', d.id, jsonb_build_object('issue_id', r.id, 'kind', r.kind,
                                                                               'item_code', r.item_code, 'qty', r.qty,
                                                                               'stock_left', v_left, 'move_id', v_move));
  if not ops.sees_supplier(me) then
    return jsonb_build_object('id', r.id, 'kind', r.kind, 'item_code', r.item_code, 'received_code', r.received_code,
                              'description', r.description, 'part_name', r.part_name, 'request', r.request,
                              'qty', r.qty, 'status', r.status, 'decision', r.decision, 'note', r.note,
                              'stock_left', v_left, 'move_id', v_move);
  end if;
  return ops.podo_issue_json(r) || jsonb_build_object('stock_left', v_left, 'move_id', v_move);
end $$;

-- 处理问题（照抄 20261014_ops_po_receive.sql），多：
--   缺零件（part）跟少发一样可以选 await 厂家会补 / cancel 取消 / pending 改回未决定；缺零件不用先决定就可以「已处理」；
--   p_action = 'request'：改「要厂家怎么处理」（p_note = replace / return / next / keep / other，空 = 清掉；少发不用）。
create or replace function public.ops_po_issue_set(p_ids bigint[], p_action text, p_note text default null) returns int
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  s ops.supplier_issue;
  n int := 0;
  v_req text;
begin
  me := ops.require_level('purchasing', 'edit');
  if p_action not in ('await', 'cancel', 'pending', 'resolve', 'reopen', 'note', 'void', 'request') then
    raise exception '未知的动作：%', p_action using errcode = '22023';
  end if;
  if p_action = 'request' then
    v_req := ops.podo_request(p_note);
  end if;
  for s in select * from ops.supplier_issue x where x.id = any (coalesce(p_ids, '{}')) order by x.id for update loop
    if not ops.sees_company(me, s.company) then
      raise exception '找不到这个厂家问题。' using errcode = 'P0002';
    end if;
    if p_action in ('await', 'cancel', 'pending') and s.kind not in ('short', 'part') then
      raise exception '只有「少发」和「缺零件」要选「厂家会补」或「取消（下次再订）」。' using errcode = '22023';
    end if;
    if p_action = 'request' and (s.kind = 'short' or s.status = 'void') then
      raise exception '少发请选「厂家会补」或「取消（下次再订）」；作废的问题不能改。' using errcode = '22023';
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
    if p_action = 'void' and not ops.sees_prices(me)
       and exists (select 1 from ops.supplier_do d where d.id = s.do_id and d.receipt is not null) then
      raise exception '点过货的厂家 DO，厂家问题只有采购或管理层可以作废。' using errcode = '42501';
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
      action_note = case when p_action not in ('note', 'request') and p_note is not null then left(p_note, 500)
                         else x.action_note end,
      request = case when p_action = 'request' then v_req else x.request end,
      updated_at = now()
    where x.id = s.id;
    perform ops.log(me.id, 'issue_' || p_action, 'supplier_issue', s.id, jsonb_build_object('note', p_note));
    n := n + 1;
  end loop;
  return n;
end $$;

-- 来错的型号「收到的型号」：搜我们的商品（型号或品名，每个字都要出现），最多 20 笔。只回型号、品名、单位。
-- 订货或仓库「可编辑」（开厂家到货的采购、点货的仓库）；p_company 空 = 自己分店的公司。
create or replace function public.ops_po_item_search(p_company text, p_q text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  c text;
  v_q text := upper(trim(coalesce(p_q, '')));
  words text[];
begin
  me := ops.podo_require_receive();
  c := ops.podo_company(me, p_company);
  if v_q = '' then
    return '[]'::jsonb;
  end if;
  words := regexp_split_to_array(v_q, '\s+');
  return (select coalesce(jsonb_agg(jsonb_build_object('item_code', x.item_code, 'description', x.description, 'uom', x.uom)
                                    order by x.o1, x.o2, x.o3, x.item_code), '[]'::jsonb)
          from (select i.item_code, coalesce(i.description, '') as description, coalesce(i.base_uom, '') as uom,
                       upper(i.item_code) <> v_q as o1, position(v_q in upper(i.item_code)) <> 1 as o2,
                       not coalesce(i.is_active, true) as o3
                from bi.dim_item i
                where i.company = c
                  and not exists (select 1 from unnest(words) w
                                  where position(w in upper(i.item_code || ' ' || coalesce(i.description, ''))) = 0)
                order by 4, 5, 6, i.item_code
                limit 20) x);
end $$;

-- ==================================================================== 7. 点货画面：开单时的备注、来错的货、进货待入 AutoCount
-- 点货画面（照抄 20261014_ops_po_receive.sql），多：
--   items[].note = 开单时那行的备注（给仓库看）；unmatched[].own / request / row（这行在 DO 的第几行：点货时带 do_row 回来，
--     跟确认时记的那笔发错型号对上，不重复记）；
--   看不到厂家的人：unmatched 的 src_code（厂家 DO 上的型号写法）只有「是我们的商品」（own = true，= 我们的型号）才回；
--     issues 的 received_code 只有是我们的型号才回（厂家的型号前缀常常看得出是哪家厂；与点货清单的搜寻同规则）；
--   issues[] 多 request、part_name、owed_qty、ours（收到的型号是我们的商品）、po_nos / factory（看得到厂家的人才有）；
--   moves = 这张点货产生的「进货待入 AutoCount」（仓库搬动 kind = receive）：仓位、数量、PO（看得到厂家才有）、状态、GRN 号、
--     pre_grn（点货时 AutoCount 已经有的进货单）、note（取消原因等）；
--   locations = 来错的货可以放的仓位（这间公司的仓位 + 主要仓位）；main_location = 预设（总部账套 HQ、JB 账套 JB）。
create or replace function public.ops_po_receive_get(p_id bigint) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  d ops.supplier_do;
  sup boolean;
  h jsonb;
begin
  me := ops.require_staff();
  select * into d from ops.supplier_do x where x.id = p_id;
  if d.id is null or not ops.podo_can_receive(me, d.company) then
    raise exception '找不到这张厂家 DO。' using errcode = 'P0002';
  end if;
  sup := ops.sees_supplier(me);
  h := ops.podo_recv_head(d, sup);
  return h || jsonb_build_object(
    'alloc_outlets', h -> 'outlets',
    'remark', case when sup then d.remark else '' end,
    'files', case when sup then d.files else '[]'::jsonb end,
    'arrive_note', d.arrive_note, 'receipt', d.receipt,
    'can_receive', d.status = 'confirmed',
    'moves', (select coalesce(jsonb_agg(jsonb_build_object(
                'id', m.id, 'item_code', m.item_code,
                'description', coalesce((select di.description from bi.dim_item di
                                         where di.company = m.company and di.item_code = m.item_code), ''),
                'location', m.to_loc, 'qty', m.qty, 'po_no', case when sup then m.po_no end, 'outlet', m.outlet,
                'recv_wrong', m.recv_wrong, 'status', m.status, 'ac_doc', m.ac_doc, 'done_at', m.done_at,
                'done_by_name', ops.podo_who(m.done_by), 'pre_grn', m.pre_grn, 'note', m.note)
                order by m.recv_wrong, m.item_code, m.id), '[]'::jsonb)
              from ops.wh_move m where m.do_id = d.id and m.kind = 'receive'),
    'main_location', ops.podo_main_loc(d.company),
    'locations', (select jsonb_agg(x.code order by x.sort, x.code) from (
                    select l.code, l.sort from ops.wh_location l where l.company = d.company
                    union select ops.podo_main_loc(d.company), -1
                    where not exists (select 1 from ops.wh_location l where l.company = d.company
                                      and l.code = ops.podo_main_loc(d.company))) x),
    'outlets', (select coalesce(jsonb_agg(jsonb_build_object('code', o.code, 'name', o.name, 'short_name', o.short_name,
                                                             'company', o.company) order by o.sort, o.code), '[]'::jsonb)
                from ops.outlet o where o.active and ops.podo_outlet_ok(d.company, o.code)),
    'items', (select coalesce(jsonb_agg(jsonb_build_object(
                'item_code', t.e ->> 'item_code', 'description', coalesce(t.e ->> 'description', ''),
                'uom', coalesce(t.e ->> 'uom', ''), 'shipped', (t.e ->> 'shipped')::numeric,
                'note', coalesce(t.e ->> 'note', ''),
                'alloc', (select coalesce(jsonb_object_agg(q.outlet, q.qty), '{}'::jsonb)
                          from (select a.outlet, sum(a.qty) as qty from ops.supplier_do_apply a
                                where a.do_id = d.id and not a.void and a.item_code = t.e ->> 'item_code'
                                group by a.outlet) q),
                'prior', (select jsonb_build_object(
                            'damaged', coalesce(sum(i.qty) filter (where i.kind = 'damaged'), 0),
                            'short', coalesce(sum(i.qty) filter (where i.kind = 'short'), 0),
                            'over', coalesce(sum(i.qty) filter (where i.kind = 'over'), 0),
                            'wrong', coalesce(sum(i.qty) filter (where i.kind = 'wrong'), 0))
                          from ops.supplier_issue i
                          where i.do_id = d.id and i.status <> 'void' and not i.auto and i.item_code = t.e ->> 'item_code'))
                order by t.o), '[]'::jsonb)
              from jsonb_array_elements(d.items) with ordinality t(e, o)
              where t.e ->> 'item_code' is not null and coalesce((t.e ->> 'shipped')::numeric, 0) > 0),
    'unmatched', (select coalesce(jsonb_agg(jsonb_build_object(
                    'row', t.o,
                    'src_code', case when sup or (t.e ->> 'own') = 'true' then coalesce(t.e ->> 'src_code', '') else '' end,
                    'src_desc', coalesce(t.e ->> 'src_desc', ''),
                    'shipped', (t.e ->> 'shipped')::numeric, 'expected_code', t.e ->> 'expected_code',
                    'note', coalesce(t.e ->> 'note', ''), 'own', t.e -> 'own', 'request', t.e ->> 'request')
                    order by t.o), '[]'::jsonb)
                  from jsonb_array_elements(d.items) with ordinality t(e, o)
                  where t.e ->> 'item_code' is null and coalesce((t.e ->> 'shipped')::numeric, 0) > 0),
    'issues', (select coalesce(jsonb_agg(jsonb_build_object(
                 'id', i.id, 'kind', i.kind, 'item_code', i.item_code,
                 'received_code', case when sup or ours.ok then i.received_code else '' end, 'ours', ours.ok,
                 'description', i.description, 'qty', i.qty, 'auto', i.auto, 'status', i.status, 'decision', i.decision,
                 'note', i.note, 'created_at', i.created_at, 'request', i.request, 'part_name', i.part_name,
                 'owed_qty', ops.podo_owed(i), 'po_nos', case when sup then to_jsonb(i.po_nos) else '[]'::jsonb end,
                 'factory', case when sup then i.factory end,
                 'from_receipt', coalesce(d.receipt -> 'issue_ids' @> to_jsonb(i.id), false),
                 'after_receipt', coalesce(not i.auto and i.created_at > d.arrived_at
                                           and not coalesce(d.receipt -> 'issue_ids' @> to_jsonb(i.id), false), false))
                 order by i.id), '[]'::jsonb)
               from ops.supplier_issue i
               cross join lateral (select i.received_code <> '' and exists (select 1 from bi.dim_item di where di.company = d.company
                                                                              and di.item_code = i.received_code) as ok) ours
               where i.do_id = d.id and i.status <> 'void'));
end $$;

-- ==================================================================== 8. 点货后：进货待入 AutoCount（仓库搬动 kind = receive）
-- 点货（ops_po_do_receive）用：p_items = 点货纪录的各型号（好货 alloc 照分店）、p_wrong = 来错的货（own = true 的进 location）。
--   每个型号 × 分店的好货 → ops.podo_recv_loc 决定仓位；先用那间分店确认时记的 PO 行（每行最多到确认时记的数量），
--   多出来的（点货时改了分配）用同型号其他分店没用完的 PO 行（仓位照这间分店），再多（多到）没有 PO；
--   同型号同仓位同 PO 同分店合成一笔。坏货不进。来错的货（我们的型号）进选的仓位，没有 PO。
--   点货时 AutoCount 已经收了的（本地货常常先开 GRN 才点货；照在路上的先出先到算到这张，ops.podo_do_rcv）：有 PO 的那几笔先算，
--   拆成一笔 pre_grn = 那几张进货单号（ops.grn_avail：还没对上的）→ 不另算库存，还是等开单部核对后标已输入。回传新搬动的 id。
create or replace function ops.podo_recv_moves(d ops.supplier_do, p_me bigint, p_items jsonb, p_wrong jsonb) returns bigint[]
language plpgsql set search_path = '' as $$
declare
  e jsonb;
  kv record;
  g record;
  v_code text;
  v_note text;
  v_fb text;
  v_rest jsonb;
  v_left numeric;
  v_take numeric;
  v_cov numeric;
  v_id bigint;
  v_moves jsonb := '[]'::jsonb;  -- [{item_code, outlet, po_no, loc, qty, wrong}]
  v_move_ids bigint[] := '{}';
  v_pre jsonb := '{}'::jsonb;    -- 点货时 AutoCount 已经收了的：{型号: 件数}
  v_docs jsonb := '{}'::jsonb;   -- {型号: 「GRN-1, GRN-2」}
  r_out text[];
  r_cap numeric[];
  r_po text[];
  r_lo text[];
  r_loc text[];
  ri int;
  rn int;
begin
  -- 进货待入 AutoCount：好货照分店分配进仓位（先用那间分店的 PO 行，再用同型号其他分店还没用完的 PO 行，再多 = 没有 PO）
  for e in select x from jsonb_array_elements(p_items) x loop
    v_code := e ->> 'item_code';
    select coalesce(array_agg(z.outlet order by z.sort, z.outlet, z.nokey, z.id), '{}'),
           coalesce(array_agg(z.cap order by z.sort, z.outlet, z.nokey, z.id), '{}'),
           coalesce(array_agg(z.po_no order by z.sort, z.outlet, z.nokey, z.id), '{}'),
           coalesce(array_agg(z.line_outlet order by z.sort, z.outlet, z.nokey, z.id), '{}'),
           coalesce(array_agg(z.line_loc order by z.sort, z.outlet, z.nokey, z.id), '{}')
      into r_out, r_cap, r_po, r_lo, r_loc
    from (select ap.id, ap.outlet, ot.sort, ap.dtl_key is null as nokey, ap.qty as cap,
                 case when ap.dtl_key is not null then ap.po_no end as po_no, ap.line_outlet,
                 (select l.location from bi.fact_po_line l where l.company = d.company and l.dtl_key = ap.dtl_key limit 1) as line_loc
          from ops.supplier_do_apply ap join ops.outlet ot on ot.code = ap.outlet
          where ap.do_id = d.id and not ap.void and ap.item_code = v_code) z;
    rn := coalesce(array_length(r_out, 1), 0);
    -- 没有 PO 行可看的（多到、JB 账套）：这张 DO 的 PO 里这个型号最后一行的仓位
    v_fb := (select l.location from bi.fact_po_line l
             where l.company = d.company and l.creditor_code = d.creditor_code and l.po_no = any (d.po_nos)
               and l.item_code = v_code order by l.dtl_key desc limit 1);
    v_rest := '{}'::jsonb;
    for kv in select k.key, (k.value #>> '{}')::numeric as q from jsonb_each(e -> 'alloc') k
              join ops.outlet ot on ot.code = k.key order by ot.sort, k.key loop
      v_left := kv.q;
      for ri in 1 .. rn loop
        exit when v_left <= 0;
        if r_out[ri] = kv.key and r_cap[ri] > 0 then
          v_take := least(v_left, r_cap[ri]);
          v_moves := v_moves || jsonb_build_array(jsonb_build_object('item_code', v_code, 'outlet', kv.key, 'po_no', r_po[ri],
                       'loc', ops.podo_recv_loc(d.company, kv.key, r_lo[ri], coalesce(r_loc[ri], v_fb)), 'qty', v_take, 'wrong', false));
          r_cap[ri] := r_cap[ri] - v_take;
          v_left := v_left - v_take;
        end if;
      end loop;
      if v_left > 0 then
        v_rest := v_rest || jsonb_build_object(kv.key, v_left);
      end if;
    end loop;
    for kv in select k.key, (k.value #>> '{}')::numeric as q from jsonb_each(v_rest) k
              join ops.outlet ot on ot.code = k.key order by ot.sort, k.key loop
      v_left := kv.q;
      for ri in 1 .. rn loop
        exit when v_left <= 0;
        if r_po[ri] is not null and r_cap[ri] > 0 then
          v_take := least(v_left, r_cap[ri]);
          v_moves := v_moves || jsonb_build_array(jsonb_build_object('item_code', v_code, 'outlet', kv.key, 'po_no', r_po[ri],
                       'loc', ops.podo_recv_loc(d.company, kv.key, null, v_fb), 'qty', v_take, 'wrong', false));
          r_cap[ri] := r_cap[ri] - v_take;
          v_left := v_left - v_take;
        end if;
      end loop;
      if v_left > 0 then
        v_moves := v_moves || jsonb_build_array(jsonb_build_object('item_code', v_code, 'outlet', kv.key, 'po_no', null,
                     'loc', ops.podo_recv_loc(d.company, kv.key, null, v_fb), 'qty', v_left, 'wrong', false));
      end if;
    end loop;
  end loop;
  -- 来错的货（我们的型号）：进选的仓位
  v_moves := v_moves || coalesce((select jsonb_agg(jsonb_build_object('item_code', y ->> 'received_code', 'outlet', null, 'po_no', null,
                                                                      'loc', y ->> 'location', 'qty', (y ->> 'qty')::numeric, 'wrong', true))
                                  from jsonb_array_elements(p_wrong) y where coalesce((y ->> 'own')::boolean, false)), '[]'::jsonb);
  -- 点货时 AutoCount 已经收了的（坏货 / 到货少已经记好，照在路上的先出先到算到这张）：引用还没对上的进货单号
  for kv in select f.item_code as key, f.received as q from ops.podo_do_rcv(d.company, d.creditor_code, d.id) f where f.received > 0 loop
    select string_agg(ga.doc_no, ', ' order by ga.rcv_date, ga.doc_no) into v_note
    from (select x.doc_no, x.rcv_date, coalesce(sum(x.qty) over (order by x.rcv_date, x.doc_no rows between unbounded preceding
                                                                 and 1 preceding), 0) as before
          from ops.grn_avail(d.company, d.creditor_code, kv.key, ops.podo_basis(d)) x) ga
    where ga.before < kv.q;
    if v_note is not null then
      v_pre := v_pre || jsonb_build_object(kv.key, kv.q);
      v_docs := v_docs || jsonb_build_object(kv.key, left(v_note, 60));
    end if;
  end loop;
  for g in select y ->> 'item_code' as item_code, y ->> 'loc' as loc, y ->> 'po_no' as po_no, y ->> 'outlet' as outlet,
                  (y ->> 'wrong')::boolean as wrong, sum((y ->> 'qty')::numeric) as qty
           from jsonb_array_elements(v_moves) y
           left join ops.outlet ot on ot.code = y ->> 'outlet'
           group by 1, 2, 3, 4, 5
           having sum((y ->> 'qty')::numeric) > 0
           order by 5, 1, (y ->> 'po_no') is null, min(ot.sort), 4, 3, 2 loop
    v_cov := 0;
    if not g.wrong and g.po_no is not null then
      v_cov := least(g.qty, coalesce((v_pre ->> g.item_code)::numeric, 0));
      if v_cov > 0 then
        v_pre := v_pre || jsonb_build_object(g.item_code, (v_pre ->> g.item_code)::numeric - v_cov);
        insert into ops.wh_move (company, item_code, qty, kind, from_loc, to_loc, note, created_by, do_id, po_no, outlet, recv_wrong,
                                 pre_grn)
        values (d.company, g.item_code, v_cov, 'receive', null, g.loc, '', p_me, d.id, g.po_no, g.outlet, false,
                v_docs ->> g.item_code)
        returning id into v_id;
        v_move_ids := v_move_ids || v_id;
      end if;
    end if;
    if g.qty - v_cov > 0 then
      insert into ops.wh_move (company, item_code, qty, kind, from_loc, to_loc, note, created_by, do_id, po_no, outlet, recv_wrong)
      values (d.company, g.item_code, g.qty - v_cov, 'receive', null, g.loc, '', p_me, d.id, g.po_no, g.outlet, g.wrong)
      returning id into v_id;
      v_move_ids := v_move_ids || v_id;
    end if;
  end loop;

  return v_move_ids;
end $$;

-- ==================================================================== 9. 点货：来错的货（我们的型号 / 不是我们的产品、要厂家怎么处理）、进货待入 AutoCount
-- 照抄 20261014_ops_po_receive.sql，多：
--   wrong[]：own（true = 收到的是我们的型号：received_code 要是我们的商品，品名自动带，location 放哪个仓位（预设这间公司的
--     主要仓位：总部账套 HQ、JB 账套 JB；要是这间公司的仓位）；false = 不是我们的产品：品名必填，不进库存）、
--     request（要厂家怎么处理；跟已记过的同样问题合并时，那笔没填才补上）、
--     do_row（开单时 DO 上对不上 PO 的那一行（ops_po_receive_get 的 unmatched[].row）：点货画面预先带进来的；跟确认时
--     记的那笔发错型号对上，不重复记，就算点货的人改选了我们的型号也一样）；
--   进货待入 AutoCount（仓库搬动 kind = receive，status pending，开单部开 GRN 后标已输入）：
--     每个型号 × 分店的好货 → ops.podo_recv_loc 决定仓位；先用那间分店确认时记的 PO 行（每行最多到确认时记的数量），
--     多出来的（点货时改了分配）用同型号其他分店没用完的 PO 行（仓位照这间分店），再多（多到）没有 PO；
--     同型号同仓位同 PO 同分店合成一笔。坏货不进。来错的货（我们的型号）进选的仓位，没有 PO。点货时 AutoCount 已经收了的记
--     pre_grn（不另算库存）。都在 ops.podo_recv_moves（§8）。
--   receipt 多 move_ids；wrong[] 多 do_row。
create or replace function public.ops_po_do_receive(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  d ops.supplier_do;
  r ops.supplier_issue;
  e jsonb;
  kv record;
  o record;
  a record;
  w record;
  v_codes text[] := '{}';        -- 要点的型号（DO 里有型号、出货 > 0），照 DO 顺序
  v_all text[] := '{}';          -- 这张 DO 所有型号（「本来应该是」可以选的）
  v_seen text[] := '{}';
  v_bad text[];
  v_code text;
  v_desc text;
  v_uom text;
  v_note text;
  v_rc text;
  v_exp text;
  v_ship numeric;
  v_recv numeric;
  v_dmg numeric;
  v_gap numeric;
  v_deff numeric;
  v_q numeric;
  v_new numeric;
  v_left numeric;
  v_sum numeric;
  k_dmg numeric;
  k_short numeric;
  k_over numeric;
  v_alloc jsonb;
  v_planned jsonb;
  v_items jsonb := '[]'::jsonb;
  v_wrong jsonb := '[]'::jsonb;
  v_ids bigint[] := '{}';
  v_missing text;
  v_own boolean;
  v_req text;
  v_loc text;
  v_rdesc text;
  v_take numeric;
  v_move_ids bigint[] := '{}';
  v_drow int;
  v_drows int[] := '{}';
  v_src jsonb;
  v_cand record;
  v_iused jsonb := '{}'::jsonb;  -- 来错的货：每笔已记的发错型号已经抵掉多少件
  v_all_note text := left(trim(coalesce(p ->> 'note', '')), 500);
begin
  me := ops.podo_require_receive();
  if jsonb_typeof(p) is distinct from 'object' then
    raise exception '资料格式不对。' using errcode = '22023';
  end if;
  select * into d from ops.supplier_do x
  where x.id = case when (p ->> 'id') ~ '^[0-9]{1,18}$' then (p ->> 'id')::bigint end for update;
  if d.id is null or not ops.podo_can_receive(me, d.company) then
    raise exception '找不到这张厂家 DO。' using errcode = 'P0002';
  end if;
  if d.status = 'arrived' then
    raise exception '这张 DO 已经点过货了（% · %），请回点货清单看纪录。', coalesce(ops.podo_who(d.arrived_by), '—'),
      to_char(d.arrived_at at time zone 'Asia/Kuala_Lumpur', 'MM-DD HH24:MI') using errcode = '22023';
  end if;
  if d.status <> 'confirmed' then
    raise exception '还没确认的 DO 不能点货。' using errcode = '22023';
  end if;
  if (p ? 'items' and jsonb_typeof(p -> 'items') not in ('array', 'null'))
     or (p ? 'wrong' and jsonb_typeof(p -> 'wrong') not in ('array', 'null')) then
    raise exception '资料格式不对。' using errcode = '22023';
  end if;
  -- 同一厂家的确认 / 点货一个一个来（在路上的算法会读这个厂家的问题与分配）
  perform pg_advisory_xact_lock(hashtextextended('ops_po_do:' || d.company || ':' || d.creditor_code, 0));

  select coalesce(array_agg(t.e ->> 'item_code' order by t.o) filter (where coalesce((t.e ->> 'shipped')::numeric, 0) > 0), '{}'),
         coalesce(array_agg(t.e ->> 'item_code' order by t.o), '{}')
    into v_codes, v_all
  from jsonb_array_elements(d.items) with ordinality t(e, o) where t.e ->> 'item_code' is not null;

  -- 各型号
  for e in select t.v from jsonb_array_elements(case when jsonb_typeof(p -> 'items') = 'array' then p -> 'items'
                                                     else '[]'::jsonb end) t(v) loop
    if jsonb_typeof(e) is distinct from 'object' then
      raise exception '资料格式不对。' using errcode = '22023';
    end if;
    v_code := (select c from unnest(v_codes) c where upper(c) = upper(trim(coalesce(e ->> 'item_code', ''))) limit 1);
    if v_code is null then
      raise exception '型号 % 不是这张 DO 要点的货；来错的货请填在「来错的货」。',
        coalesce(nullif(trim(e ->> 'item_code'), ''), '（空白）') using errcode = '22023';
    end if;
    if v_code = any (v_seen) then
      raise exception '型号 % 重复了。', v_code using errcode = '22023';
    end if;
    v_seen := v_seen || v_code;
    v_recv := ops.podo_num(e -> 'received', '型号 ' || v_code || ' 的好货数量');
    if v_recv is null then
      raise exception '型号 % 请填好货收到几件。', v_code using errcode = '22023';
    end if;
    v_dmg := coalesce(ops.podo_num(e -> 'damaged', '型号 ' || v_code || ' 的坏货数量'), 0);
    if e ? 'alloc' and jsonb_typeof(e -> 'alloc') not in ('object', 'null') then
      raise exception '资料格式不对。' using errcode = '22023';
    end if;
    v_alloc := '{}'::jsonb;
    v_sum := 0;
    v_bad := '{}';
    for kv in select k.key, k.value from jsonb_each(case when jsonb_typeof(e -> 'alloc') = 'object' then e -> 'alloc'
                                                         else '{}'::jsonb end) k loop
      if not exists (select 1 from ops.outlet x where x.code = kv.key and x.active) then
        raise exception '没有这个分店：%。', kv.key using errcode = '22023';
      end if;
      v_q := coalesce(ops.podo_num(kv.value, '型号 ' || v_code || ' 分到 ' || kv.key || ' 的数量'), 0);
      if v_q > 0 then
        if not ops.podo_outlet_ok(d.company, kv.key) then
          v_bad := v_bad || kv.key;
        end if;
        v_alloc := v_alloc || jsonb_build_object(kv.key, v_q);
        v_sum := v_sum + v_q;
      end if;
    end loop;
    if cardinality(v_bad) > 0 then
      raise exception '%', ops.podo_outlet_msg(d.company, v_bad) using errcode = '22023';
    end if;
    if v_sum <> v_recv then
      raise exception '型号 % 好货 % 件，分到各分店合计 % 件：要相等。', v_code, ops.podo_fmt(v_recv), ops.podo_fmt(v_sum)
        using errcode = '22023';
    end if;
    v_note := left(trim(coalesce(e ->> 'note', '')), 500);
    select (t.e ->> 'shipped')::numeric, coalesce(t.e ->> 'description', ''), coalesce(t.e ->> 'uom', '')
      into v_ship, v_desc, v_uom
    from jsonb_array_elements(d.items) t(e) where t.e ->> 'item_code' = v_code limit 1;
    select coalesce(sum(i.qty) filter (where i.kind = 'damaged'), 0), coalesce(sum(i.qty) filter (where i.kind = 'short'), 0),
           coalesce(sum(i.qty) filter (where i.kind = 'over'), 0)
      into k_dmg, k_short, k_over
    from ops.supplier_issue i where i.do_id = d.id and i.item_code = v_code and i.status <> 'void' and not i.auto;
    select coalesce(jsonb_object_agg(q.outlet, q.qty), '{}'::jsonb) into v_planned
    from (select x.outlet, sum(x.qty) as qty from ops.supplier_do_apply x
          where x.do_id = d.id and not x.void and x.item_code = v_code group by x.outlet) q;

    v_gap := greatest(v_ship - v_recv, 0);                     -- 没到的好货（从在路上扣）
    v_deff := least(v_dmg, v_gap);                             -- 其中是坏了的
    v_q := greatest(v_gap - k_dmg - k_short, 0);               -- 已记的不够：还要记几件
    v_new := least(v_q, greatest(v_deff - k_dmg, 0));          -- 其中记成坏货的
    if v_q - v_new > 0 then                                    -- 到货少（会从在路上扣掉）
      r := ops.podo_issue_new(d, me.id, 'short', v_code, '', v_desc, d.po_nos, v_ship, v_recv + v_dmg, v_q - v_new, v_note, false);
      v_ids := v_ids || r.id;
    end if;
    if v_new > 0 then                                          -- 坏货
      r := ops.podo_issue_new(d, me.id, 'damaged', v_code, '', v_desc, d.po_nos, v_ship, v_recv + v_dmg, v_new, v_note, false);
      v_ids := v_ids || r.id;
    end if;
    v_q := greatest(v_recv + v_dmg - v_ship, 0) - k_over;      -- 多到（含多寄的坏件；只是纪录）
    if v_q > 0 then
      r := ops.podo_issue_new(d, me.id, 'over', v_code, '', v_desc, d.po_nos, v_ship, v_recv + v_dmg, v_q,
                              v_note || case when v_dmg > v_deff
                                             then '（其中坏的 ' || ops.podo_fmt(v_dmg - v_deff) || ' 件）' else '' end, false);
      v_ids := v_ids || r.id;
    end if;

    -- 分店分配比确认时少：记在那间分店的分配（先扣多发、再从后面的行扣）
    for o in select k.key as outlet, (k.value #>> '{}')::numeric - coalesce((v_alloc ->> k.key)::numeric, 0) as less
             from jsonb_each(v_planned) k loop
      v_left := o.less;
      continue when v_left <= 0;
      for a in select x.id, x.qty from ops.supplier_do_apply x
               where x.do_id = d.id and not x.void and x.item_code = v_code and x.outlet = o.outlet
               order by (x.dtl_key is null) desc, x.id desc loop
        exit when v_left <= 0;
        update ops.supplier_do_apply x set recv_less = least(a.qty, v_left) where x.id = a.id;
        v_left := v_left - least(a.qty, v_left);
      end loop;
    end loop;

    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'item_code', v_code, 'description', v_desc, 'uom', v_uom, 'shipped', v_ship, 'received', v_recv, 'damaged', v_dmg,
      'alloc', v_alloc, 'planned', v_planned, 'prior', jsonb_build_object('damaged', k_dmg, 'short', k_short), 'note', v_note));
  end loop;
  select string_agg(u.c, '、' order by u.o) into v_missing from unnest(v_codes) with ordinality u(c, o) where u.c <> all (v_seen);
  if v_missing is not null then
    raise exception '型号 % 还没填点货数量。', v_missing using errcode = '22023';
  end if;

  -- 来错的货（整行空白的略过；第几行 = 送来的顺序）
  if jsonb_array_length(case when jsonb_typeof(p -> 'wrong') = 'array' then p -> 'wrong' else '[]'::jsonb end) > 100 then
    raise exception '来错的货最多 100 行。' using errcode = '22023';
  end if;
  for w in select t.v, t.n from jsonb_array_elements(case when jsonb_typeof(p -> 'wrong') = 'array' then p -> 'wrong'
                                                         else '[]'::jsonb end) with ordinality t(v, n) loop
    e := w.v;
    if jsonb_typeof(e) is distinct from 'object' then
      raise exception '资料格式不对。' using errcode = '22023';
    end if;
    v_rc := left(trim(coalesce(e ->> 'received_code', '')), 100);
    v_desc := left(trim(coalesce(e ->> 'description', '')), 300);
    v_note := left(trim(coalesce(e ->> 'note', '')), 500);
    v_exp := nullif(trim(coalesce(e ->> 'expected_code', '')), '');
    v_q := ops.podo_num(e -> 'qty', '来错的货第 ' || w.n || ' 行的数量');
    if v_rc = '' and v_desc = '' and v_note = '' and v_exp is null and coalesce(v_q, 0) = 0 then
      continue;
    end if;
    v_own := case when jsonb_typeof(e -> 'own') = 'boolean' then (e ->> 'own')::boolean end;
    v_req := ops.podo_request(e ->> 'request');
    v_loc := null;
    v_drow := null;
    if e ? 'do_row' and jsonb_typeof(e -> 'do_row') <> 'null' then
      v_drow := case when (e ->> 'do_row') ~ '^[0-9]{1,4}$' then (e ->> 'do_row')::int end;
      if v_drow is null or not exists (select 1 from jsonb_array_elements(d.items) with ordinality t(x, o)
                                       where t.o = v_drow and t.x ->> 'item_code' is null) then
        raise exception '来错的货第 % 行：对不上开单时的那一行，请重新整理再点。', w.n using errcode = '22023';
      end if;
      if v_drow = any (v_drows) then
        raise exception '来错的货第 % 行：开单时的同一行重复了。', w.n using errcode = '22023';
      end if;
      v_drows := v_drows || v_drow;
    end if;
    if v_own then
      select x.item_code, x.description into v_code, v_rdesc from bi.dim_item x
      where x.company = d.company and upper(x.item_code) = upper(v_rc) limit 1;
      if not found or v_rc = '' then
        raise exception '来错的货第 % 行：找不到我们的型号 %。', w.n, coalesce(nullif(v_rc, ''), '（空白）') using errcode = '22023';
      end if;
      v_rc := v_code;
      v_desc := coalesce(nullif(v_desc, ''), v_rdesc, '');
      v_loc := coalesce(nullif(upper(trim(coalesce(e ->> 'location', ''))), ''), ops.podo_main_loc(d.company));
      if not ops.podo_loc_ok(d.company, v_loc) then
        raise exception '来错的货第 % 行：没有这个仓位 %。', w.n, v_loc using errcode = '22023';
      end if;
    elsif v_own is false then
      if v_desc = '' then
        raise exception '来错的货第 % 行「不是我们的产品」请填品名。', w.n using errcode = '22023';
      end if;
    elsif v_rc = '' and v_note = '' then
      raise exception '来错的货第 % 行请填收到的型号或备注。', w.n using errcode = '22023';
    end if;
    if coalesce(v_q, 0) <= 0 then
      raise exception '来错的货第 % 行请填数量。', w.n using errcode = '22023';
    end if;
    if v_exp is not null then
      v_code := (select c from unnest(v_all) c where upper(c) = upper(v_exp) limit 1);
      if v_code is null then
        raise exception '「本来应该是」的型号 % 不是这张 DO 的型号。', v_exp using errcode = '22023';
      end if;
      v_exp := v_code;
    end if;
    v_wrong := v_wrong || jsonb_build_array(jsonb_build_object('received_code', v_rc, 'description', v_desc,
                                                               'expected_code', v_exp, 'qty', v_q, 'note', v_note)
                 || case when v_own is not null then jsonb_build_object('own', v_own) else '{}'::jsonb end
                 || case when v_req is not null then jsonb_build_object('request', v_req) else '{}'::jsonb end
                 || case when v_own then jsonb_build_object('location', v_loc) else '{}'::jsonb end
                 || case when v_drow is not null then jsonb_build_object('do_row', v_drow) else '{}'::jsonb end);
  end loop;
  -- 跟已记过的发错型号合并（不重复记）：开单时那一行（do_row）= 确认时记的那笔；没有 do_row 的照收到的型号（+ 本来应该是）找。
  -- 每笔已记的最多抵它的件数（v_iused）；抵掉的那笔还没填「要厂家怎么处理」就补上；抵不完的才新记一笔。
  for w in select upper(t.y ->> 'received_code') as cu, min(t.y ->> 'received_code') as rc, t.y ->> 'expected_code' as exp,
                  (t.y ->> 'do_row')::int as drow,
                  coalesce(min(nullif(t.y ->> 'description', '')), '') as descr, sum((t.y ->> 'qty')::numeric) as qty,
                  coalesce(string_agg(nullif(t.y ->> 'note', ''), '；' order by t.o), '') as note,
                  (array_agg(t.y ->> 'request' order by t.o) filter (where t.y ->> 'request' is not null))[1] as req
           from jsonb_array_elements(v_wrong) with ordinality t(y, o)
           group by upper(t.y ->> 'received_code'), t.y ->> 'expected_code', (t.y ->> 'do_row')::int,
                    case when t.y ->> 'received_code' = '' and t.y ->> 'do_row' is null then t.o end
           order by (t.y ->> 'do_row')::int is null, (t.y ->> 'expected_code') is null, min(t.o) loop
    v_q := w.qty;
    v_src := case when w.drow is not null then (select t.x from jsonb_array_elements(d.items) with ordinality t(x, o)
                                                 where t.o = w.drow) end;
    if v_src is not null or w.cu <> '' then
      for v_cand in select i.id, i.qty, i.request from ops.supplier_issue i
                    where i.do_id = d.id and i.kind = 'wrong' and i.status <> 'void' and i.id <> all (v_ids)
                      and case when v_src is not null
                               then i.auto and upper(i.received_code) = upper(coalesce(v_src ->> 'src_code', ''))
                                    and i.description = coalesce(v_src ->> 'src_desc', '')
                                    and i.item_code is not distinct from (v_src ->> 'expected_code')
                               else upper(i.received_code) = w.cu and (w.exp is null or i.item_code = w.exp) end
                    order by i.id loop
        exit when v_q <= 0;
        v_take := least(v_q, greatest(v_cand.qty - coalesce((v_iused ->> v_cand.id::text)::numeric, 0), 0));
        continue when v_take <= 0;
        v_iused := v_iused || jsonb_build_object(v_cand.id::text, coalesce((v_iused ->> v_cand.id::text)::numeric, 0) + v_take);
        v_q := v_q - v_take;
        if w.req is not null and v_cand.request is null then
          update ops.supplier_issue x set request = w.req, updated_at = now() where x.id = v_cand.id;
        end if;
      end loop;
    end if;
    if v_q > 0 then
      r := ops.podo_issue_make(d, me.id, 'wrong', w.exp, w.rc, w.descr, d.po_nos, null, w.qty, v_q, w.note, false, w.req, '');
      v_ids := v_ids || r.id;
    end if;
  end loop;

  -- 进货待入 AutoCount（仓库库存跟著变；pre_grn = 点货时 AutoCount 已经有的）
  v_move_ids := ops.podo_recv_moves(d, me.id, v_items, v_wrong);

  update ops.supplier_do x set
    receipt = jsonb_build_object('items', v_items, 'wrong', v_wrong, 'note', v_all_note, 'issue_ids', to_jsonb(v_ids),
                                 'move_ids', to_jsonb(v_move_ids)),
    status = 'arrived', arrived_by = me.id, arrived_at = now(), arrive_note = v_all_note, updated_by = me.id, updated_at = now()
  where x.id = d.id;
  perform ops.log(me.id, 'receive', 'supplier_do', d.id, jsonb_build_object('note', v_all_note, 'issue_ids', to_jsonb(v_ids),
                                                                             'items', jsonb_array_length(v_items),
                                                                             'wrong', jsonb_array_length(v_wrong),
                                                                             'moves', cardinality(v_move_ids)));
  return public.ops_po_receive_get(d.id);
end $$;

-- ==================================================================== 10. 仓库：进货待入 AutoCount（搬动清单）、待开进货单（开单部）
-- 搬动 JSON（照抄 20261004_ops_warehouse.sql），进货（kind = receive）多 do_no、supplier_name；
-- 看不到厂家的人（门市等有仓库「只看」）po_no、do_no、厂家都是 null。
create or replace function ops.wh_move_json(m ops.wh_move) returns jsonb
language sql stable security definer set search_path = '' as $$
  select to_jsonb(m) || jsonb_build_object(
    'description', (select i.description from bi.dim_item i where i.company = m.company and i.item_code = m.item_code),
    'uom', (select i.base_uom from bi.dim_item i where i.company = m.company and i.item_code = m.item_code),
    'created_by_name', (select s.name from ops.staff s where s.id = m.created_by),
    'done_by_name', (select s.name from ops.staff s where s.id = m.done_by))
  || case when m.kind = 'receive' then (
       select jsonb_build_object('po_no', case when v.sup then m.po_no end,
                                 'do_no', case when v.sup then d.do_no end,
                                 'supplier_name', case when v.sup then d.supplier_name end)
       from (select coalesce(ops.sees_supplier(ops.current_staff()), false) as sup) v
       left join ops.supplier_do d on d.id = m.do_id)
     else '{}'::jsonb end
$$;

-- 搬动清单（照抄 20261004_ops_warehouse.sql），p 多 kind：'receive' = 只列进货待入 AutoCount、'move' = 只列一般搬动、空 = 全部
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
      and case coalesce(p->>'kind', '') when 'receive' then m.kind = 'receive' when 'move' then m.kind <> 'receive' else true end
      and (q = '' or upper(m.item_code) like '%' || q || '%' or upper(m.ac_doc) like '%' || q || '%')
    order by m.created_at desc limit 300) m);
end $$;

-- 标已输入 AutoCount / 取消（照抄 20261004_ops_warehouse.sql），多 p_reason。
-- 进货（kind = receive）：开单部或仓库「可审批」标已输入，一定要填 AutoCount 进货单（GRN）号；
--   取消只有仓库「可审批」（仓库主管、管理层、admin），一定要写原因（存在 note）：点货的人自己、开单部都不能取消
--   （不然点到的货可以不进 AutoCount，绕过「仓库点货、开单部开 GRN」的分工）。
-- 一般搬动照旧：仓库「可审批」标已输入 / 取消，登记的人可以取消自己的。
-- 4 个参数都必填（前端一律四个都送）；旧的 3 个参数版本（20261004，p_ac_doc 有预设）留著转接到这个、原因空白，
-- 所以叫 2、3 个参数的是旧版、4 个参数的是这个，不会有两个都对得上的情况（Supabase MCP 不让拿掉函数）。
create or replace function public.ops_wh_move_mark(p_ids bigint[], p_action text, p_ac_doc text, p_reason text)
returns int
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  m ops.wh_move;
  n int := 0;
  approver boolean;
  grn boolean;
  v_reason text := left(trim(coalesce(p_reason, '')), 300);
begin
  me := ops.require_level('warehouse', 'view');
  approver := ops.level_rank(ops.module_level(me, 'warehouse')) >= 3;
  grn := ops.grn_can_mark(me);
  if p_action not in ('done', 'cancelled') then
    raise exception '未知的动作：%', p_action using errcode = '22023';
  end if;
  for m in select * from ops.wh_move x where x.id = any(coalesce(p_ids, '{}')) order by x.id for update loop
    if not ops.sees_company(me, m.company) or m.status <> 'pending' then
      continue;
    end if;
    if m.kind = 'receive' then
      if p_action = 'done' and not grn then
        raise exception '进货待入 AutoCount 只有开单部或仓库「可审批」的人可以标已输入。' using errcode = '42501';
      end if;
      if p_action = 'cancelled' and not approver then
        raise exception '进货待入 AutoCount 只有仓库「可审批」的人（仓库主管、管理层）可以取消。' using errcode = '42501';
      end if;
      if p_action = 'done' and trim(coalesce(p_ac_doc, '')) = '' then
        raise exception '请填 AutoCount 进货单（GRN）号码。' using errcode = '22023';
      end if;
      if p_action = 'cancelled' and v_reason = '' then
        raise exception '取消进货要写原因。' using errcode = '22023';
      end if;
    elsif not (approver or (p_action = 'cancelled' and m.created_by = me.id)) then
      raise exception '只有仓库「可审批」的人可以标已输入 AutoCount。' using errcode = '42501';
    end if;
    update ops.wh_move x set status = p_action, done_by = me.id, done_at = now(),
                             ac_doc = case when p_action = 'done' then left(trim(coalesce(p_ac_doc, '')), 60) else x.ac_doc end,
                             note = case when m.kind = 'receive' and p_action = 'cancelled'
                                         then left(case when x.note = '' then '' else x.note || '；' end || '取消：' || v_reason, 500)
                                         else x.note end
    where x.id = m.id;
    perform ops.log(me.id, p_action, 'wh_move', m.id, jsonb_build_object('ac_doc', p_ac_doc, 'reason', nullif(v_reason, '')));
    n := n + 1;
  end loop;
  return n;
end $$;

-- 旧的 3 个参数版本（20261004）：转接到上面的 4 个参数版本，原因空白（旧版前端、测试只填 GRN 号的呼叫）
create or replace function public.ops_wh_move_mark(p_ids bigint[], p_action text, p_ac_doc text default '') returns int
language sql set search_path = '' as $$
  select public.ops_wh_move_mark(p_ids, p_action, coalesce(p_ac_doc, ''), '')
$$;

-- 待开进货单（开单部、仓库「可审批」）：点货产生的进货待入 AutoCount，以厂家到货（DO）分组。
-- p: company（空 = 看得到的全部）status（pending 预设 / done / all = 还没处理的 + 最近 days 天处理过的（已输入、已取消））
--    days（1–366，预设 30）q
-- 「AutoCount 可能已输入」（只提示，不会自动标）：照在路上的先出先到（ops.podo_do_rcv）算这张 DO 每个型号 AutoCount 已经收了几件，
--   扣掉这张已经标已输入的、点货时就有的（pre_grn），剩下的先分给有 PO 的那几笔（没有 PO 的多到最后）→ hint_qty；
--   grn_hint = 这张 DO 日期起、还没对上的进货单（ops.grn_avail：别笔用掉的已扣）；one_doc = 一张就够这笔的单号（才有一键标）。
--   同一张 PO 两批货：先到先算，第二批不会被第一批的 GRN 误提示；PO 只有 10 件、多到 2 件：那 2 件不提示。
--   po_full = 这笔的 PO 在 AutoCount 这个型号已经全收（另一个信号：请先核对再开）。
--   pre_grn = 点货时 AutoCount 已经有的进货单（没有重复算库存；核对后按一键标已输入）。
-- 看不到厂家的人（个人例外开了仓库「可审批」的门市等）：DO 号、厂家、PO 号都是 null。不含价格。
create or replace function public.ops_wh_grn_list(p jsonb default '{}'::jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  sup boolean;
  st text := coalesce(nullif(p ->> 'status', ''), 'pending');
  v_days int := least(greatest(coalesce(case when (p ->> 'days') ~ '^[0-9]{1,3}$' then (p ->> 'days')::int end, 30), 1), 366);
  v_q text := nullif(trim(coalesce(p ->> 'q', '')), '');
begin
  me := ops.require_staff();
  if not ops.grn_can_mark(me) then
    raise exception '只有开单部或仓库「可审批」的人看得到待开进货单。' using errcode = '42501';
  end if;
  if st not in ('pending', 'done', 'all') then
    raise exception '未知的状态：%', st using errcode = '22023';
  end if;
  sup := ops.sees_supplier(me);
  return jsonb_build_object('status', st, 'days', v_days, 'groups', (
    with ln as (
      select m.*, d.do_no, d.supplier_name, d.creditor_code, d.po_nos as do_pos, d.do_date, d.arrived_at, d.arrived_by,
             ops.podo_basis(d) as basis, coalesce(i.description, '') as description, coalesce(i.base_uom, '') as uom
      from ops.wh_move m
      join ops.supplier_do d on d.id = m.do_id
      left join bi.dim_item i on i.company = m.company and i.item_code = m.item_code
      where m.kind = 'receive' and ops.sees_company(me, m.company)
        and (nullif(p ->> 'company', '') is null or m.company = p ->> 'company')
        and case st when 'pending' then m.status = 'pending'
                    when 'done' then m.status = 'done' and m.done_at >= now() - make_interval(days => v_days)
                    else m.status = 'pending' or m.done_at >= now() - make_interval(days => v_days) end
        and (v_q is null or m.item_code ilike '%' || v_q || '%' or coalesce(i.description, '') ilike '%' || v_q || '%'
             or m.ac_doc ilike '%' || v_q || '%'
             or (sup and (d.do_no ilike '%' || v_q || '%' or d.supplier_name ilike '%' || v_q || '%'
                          or coalesce(m.po_no, '') ilike '%' || v_q || '%' or array_to_string(d.po_nos, ' ') ilike '%' || v_q || '%')))),
    pd as (select distinct ln.do_id, ln.company, ln.creditor_code, ln.basis from ln where ln.status = 'pending'),
    fr as (select pd.do_id, f.item_code, f.received from pd cross join lateral ops.podo_do_rcv(pd.company, pd.creditor_code, pd.do_id) f),
    cv as (select m.do_id, m.item_code, sum(m.qty) as q from ops.wh_move m join pd on pd.do_id = m.do_id
           where m.kind = 'receive' and not m.recv_wrong and m.po_no is not null
             and (m.status = 'done' or (m.status = 'pending' and m.pre_grn is not null))
           group by m.do_id, m.item_code),
    hc as (select ln.id, ln.do_id, ln.item_code, ln.qty, ln.company, ln.creditor_code, ln.basis,
                  least(ln.qty, greatest(0, greatest(0, coalesce(fr.received, 0) - coalesce(cv.q, 0))
                                             - coalesce(sum(ln.qty) over (partition by ln.do_id, ln.item_code
                                                                          order by ln.po_no is null, ln.id
                                                                          rows between unbounded preceding and 1 preceding), 0))) as hq
           from ln
           left join fr on fr.do_id = ln.do_id and fr.item_code = ln.item_code
           left join cv on cv.do_id = ln.do_id and cv.item_code = ln.item_code
           where ln.status = 'pending' and ln.pre_grn is null and not ln.recv_wrong),
    hd as (select hc.id, hc.hq,
                  coalesce(jsonb_agg(jsonb_build_object('doc_no', a.doc_no, 'rcv_date', a.rcv_date, 'qty', a.qty)
                                     order by a.rcv_date, a.doc_no) filter (where a.doc_no is not null), '[]'::jsonb) as hint,
                  (array_agg(a.doc_no order by a.rcv_date, a.doc_no) filter (where a.qty >= hc.qty and hc.hq >= hc.qty))[1] as one_doc
           from hc left join lateral ops.grn_avail(hc.company, hc.creditor_code, hc.item_code, hc.basis) a on true
           where hc.hq > 0
           group by hc.id, hc.hq),
    pf as (select ln.id, coalesce(sum(coalesce(l.qty, 0)) <= sum(coalesce(l.transferred_qty, 0)), false) as is_full
           from ln join bi.fact_po_line l on l.company = ln.company and l.po_no = ln.po_no and l.item_code = ln.item_code
                                            and not coalesce(l.cancelled, false)
           where ln.status = 'pending' and ln.po_no is not null and ln.pre_grn is null
           group by ln.id),
    g as (
      select ln.do_id, jsonb_build_object(
               'do_id', ln.do_id, 'company', min(ln.company),
               'do_no', case when sup then min(ln.do_no) end, 'supplier_name', case when sup then min(ln.supplier_name) end,
               'creditor_code', case when sup then min(ln.creditor_code) end,
               'po_nos', case when sup then to_jsonb(min(ln.do_pos)) else '[]'::jsonb end,
               'do_date', min(ln.do_date), 'arrived_at', min(ln.arrived_at), 'arrived_by_name', ops.podo_who(min(ln.arrived_by)),
               'pending_n', count(*) filter (where ln.status = 'pending'),
               'grn_docs', to_jsonb(array(select distinct z from ln l2 left join hd h2 on h2.id = l2.id,
                                          unnest(coalesce(array(select y ->> 'doc_no' from jsonb_array_elements(h2.hint) y), '{}')
                                                 || ops.grn_docs(case when l2.status = 'pending' then l2.pre_grn end)) z
                                          where l2.do_id = ln.do_id order by z)),
               'lines', jsonb_agg(jsonb_build_object(
                 'id', ln.id, 'item_code', ln.item_code, 'description', ln.description, 'uom', ln.uom, 'location', ln.to_loc,
                 'qty', ln.qty, 'po_no', case when sup then ln.po_no end, 'outlet', ln.outlet, 'recv_wrong', ln.recv_wrong,
                 'status', ln.status, 'ac_doc', ln.ac_doc, 'note', ln.note, 'pre_grn', ln.pre_grn, 'created_at', ln.created_at,
                 'created_by_name', ops.podo_who(ln.created_by), 'done_at', ln.done_at, 'done_by_name', ops.podo_who(ln.done_by),
                 'grn_hint', coalesce(hd.hint, '[]'::jsonb), 'hint_qty', coalesce(hd.hq, 0), 'one_doc', hd.one_doc,
                 'po_full', coalesce(pf.is_full, false))
                 order by ln.recv_wrong, ln.item_code, ln.id)) as j,
             min(ln.arrived_at) as ord
      from ln left join hd on hd.id = ln.id left join pf on pf.id = ln.id
      group by ln.do_id)
    select coalesce(jsonb_agg(g.j order by case when st = 'pending' then g.ord end, g.ord desc, g.do_id), '[]'::jsonb) from g));
end $$;

-- ==================================================================== 11. 未到货 PO 清单（还没 ETA 的筛选）、首页「今天要做」
-- 照抄 20261013b_ops_supplier_privacy.sql，p 多 no_eta（true = 只列要问厂家 ETA 的，ops.po_needs_eta；首页 po_no_eta 点进来）
create or replace function public.ops_po_list(p jsonb default '{}'::jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  prices boolean;
  v_q text := nullif(trim(coalesce(p ->> 'q', '')), '');
begin
  me := ops.require_level('purchasing', 'view');
  perform ops.require_supplier(me);
  prices := ops.level_rank(ops.module_level(me, 'purchasing')) >= 2;
  return (
    select coalesce(jsonb_agg(ops.po_row_json(me, r.x, prices)
                              order by ((r.x).status = 'closed'), (r.x).days_late desc nulls last, (r.x).po_no),
                    '[]'::jsonb)
    from (select x from ops.v_po_open x
          where ops.sees_company(me, x.company)
            and (nullif(p ->> 'company', '') is null or x.company = p ->> 'company')
            and case coalesce(nullif(p ->> 'status', ''), 'open')
                  when 'open' then x.status <> 'closed'
                  when 'all' then true
                  else x.status = p ->> 'status' end
            and (coalesce((p ->> 'stale')::boolean, false) or x.days_open <= 120 or x.status <> 'ordered'
                 or x.po_eta is not null or x.shipment_id is not null)
            and (not coalesce((p ->> 'overdue')::boolean, false) or x.days_late > 0)
            and (not coalesce((p ->> 'no_eta')::boolean, false) or ops.po_needs_eta(x))
            and case coalesce(p ->> 'china', '') when 'china' then x.is_china when 'local' then not x.is_china
                                                 else true end
            and (v_q is null
                 or x.po_no ilike '%' || v_q || '%' or x.supplier_name ilike '%' || v_q || '%'
                 or x.creditor_name ilike '%' || v_q || '%' or coalesce(x.shipment_name, '') ilike '%' || v_q || '%'
                 or exists (select 1 from ops.v_po_open_line l where l.company = x.company and l.po_no = x.po_no
                            and (l.item_code ilike '%' || v_q || '%' or l.description ilike '%' || v_q || '%')))
          limit 1000) r
  );
end $$;

-- 首页（照抄 20261014_ops_po_receive.sql），多：
--   do_draft_stale（订货「可编辑」）：厂家到货草稿从开单起超过 24 小时还没确认；
--   po_no_eta（订货「可编辑」）：要问厂家 ETA 的 PO（ops.po_needs_eta）；
--   po_issues_todo：还没决定的少发之外，也算还没决定的缺零件；
--   grn_pending（开单部、仓库「可审批」）：有进货待开 GRN 的厂家到货张数；
--   wh_moves_pending（仓库「可审批」）：不再算进货（进货看 grn_pending）；
--   po_arriving：开单部也看得到厂家，但打不开未到货 PO → 要订货「只看」以上才给；
--   po_overdue / po_arriving / po_no_eta 一次扫 ops.v_po_open（原本各扫一次）。
create or replace function public.ops_home() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  rec ops.attendance;
  wh int := ops.level_rank(ops.module_level(ops.current_staff(), 'warehouse'));
  po int := ops.level_rank(ops.module_level(ops.current_staff(), 'purchasing'));
  hr int := ops.level_rank(ops.module_level(ops.current_staff(), 'hr'));
  pay int := ops.level_rank(ops.module_level(ops.current_staff(), 'payroll'));
  adm int := ops.level_rank(ops.module_level(ops.current_staff(), 'admin'));
  n_overdue bigint;
  n_arriving bigint;
  n_no_eta bigint;
begin
  me := ops.require_staff();
  -- 未到货 PO 的三个数一次算（ops.v_po_open 不便宜）
  if po >= 2 or (po >= 1 and ops.sees_supplier(me)) then
    select count(*) filter (where v.status <> 'closed' and v.days_late > 0
                              and (v.days_open <= 120 or v.status <> 'ordered' or v.po_eta is not null or v.shipment_id is not null)),
           count(*) filter (where v.status not in ('closed', 'arrived') and v.eta between ops.today() and ops.today() + 3),
           count(*) filter (where ops.po_needs_eta(v))
      into n_overdue, n_arriving, n_no_eta
    from ops.v_po_open v where ops.sees_company(me, v.company);
  end if;
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
    'po_overdue', case when po >= 2 then n_overdue end,
    'po_arriving', case when ops.sees_supplier(me) and po >= 1 then n_arriving end,
    'do_to_count', case when po >= 2 or wh >= 2 then
                    (select count(*) from ops.supplier_do d
                     left join ops.shipment s on s.id = d.shipment_id and s.status <> 'cancelled'
                     where d.status = 'confirmed' and ops.sees_company(me, d.company)
                       and coalesce(s.eta, d.eta) <= ops.today() + 3) end,
    'do_no_eta', case when po >= 2 then
                    (select count(*) from ops.supplier_do d
                     left join ops.shipment s on s.id = d.shipment_id and s.status <> 'cancelled'
                     where d.status = 'confirmed' and ops.sees_company(me, d.company) and coalesce(s.eta, d.eta) is null) end,
    'po_issues_todo', case when ops.sees_prices(me) then
                    (select count(*) from ops.supplier_issue i
                     where i.status = 'open' and ops.sees_company(me, i.company)
                       and ((i.kind in ('short', 'part') and i.decision = 'pending')
                            or (not i.auto and i.created_at >= now() - interval '7 days'))) end,
    'do_draft_stale', case when po >= 2 then
                    (select count(*) from ops.supplier_do d
                     where d.status = 'draft' and ops.sees_company(me, d.company)
                       and d.created_at < ops.now() - interval '24 hours') end,
    'po_no_eta', case when po >= 2 then n_no_eta end,
    'grn_pending', case when ops.grn_can_mark(me) then
                    (select count(distinct m.do_id) from ops.wh_move m
                     where m.kind = 'receive' and m.status = 'pending' and ops.sees_company(me, m.company)) end,
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
                          where m.status = 'pending' and m.kind <> 'receive' and ops.sees_company(me, m.company)) end,
    'wh_variances', case when wh >= 3 then (select count(*) from ops.wh_count k
                      where k.status = 'variance' and ops.sees_company(me, k.company)
                        and (k.attempt = 2 or k.count_date < ops.today())) end,
    -- 物流部也有仓库「可编辑」（登记搬动），但不负责盘点：不提醒「今天还没盘点」；最近 30 天自己盘过的照样提醒（使用者 2026-10-09）
    'wh_counted_today', case when wh >= 2 and (me.department <> 'logistics' or exists (select 1 from ops.wh_count k
                          where k.counted_by = me.id and k.count_date >= ops.today() - 30)) then (select count(*) from ops.wh_count k
                          where k.counted_by = me.id and k.count_date = ops.today() and k.status <> 'superseded') end,
    'hr_gaps', case when hr >= 2 then (select count(*) from ops.staff s
                 where s.active and (s.last_day is null or s.last_day >= ops.today()) and ops.sees_branch(me, s.branch)
                   and cardinality(ops.hr_gap_codes(s, pay)) > 0) end,
    'holidays_ahead', case when hr >= 2 then (select count(*) from ops.holiday h
                        where h.date between ops.today() and ops.today() + 60) end,
    'join_pending', case when adm >= 3 then (select count(*) from ops.join_request r where r.status = 'pending') end
  );
end $$;

-- ==================================================================== 12. 权限
do $$
declare
  f text;
begin
  foreach f in array array['ops_po_item_search(text,text)', 'ops_wh_grn_list(jsonb)', 'ops_wh_move_mark(bigint[],text,text,text)',
                           'ops_wh_move_mark(bigint[],text,text)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
revoke all on function ops.grn_can_mark(ops.staff) from public, anon, authenticated;
revoke all on function ops.podo_request(text) from public, anon, authenticated;
revoke all on function ops.podo_factory(text, text, text, text[]) from public, anon, authenticated;
revoke all on function ops.supplier_issue_factory() from public, anon, authenticated;
revoke all on function ops.podo_owed(ops.supplier_issue) from public, anon, authenticated;
revoke all on function ops.po_needs_eta(ops.v_po_open) from public, anon, authenticated;
revoke all on function ops.podo_recv_loc(text, text, text, text) from public, anon, authenticated;
revoke all on function ops.podo_decide(bigint, text, bigint) from public, anon, authenticated;
revoke all on function ops.podo_main_loc(text) from public, anon, authenticated;
revoke all on function ops.podo_loc_ok(text, text) from public, anon, authenticated;
revoke all on function ops.grn_docs(text) from public, anon, authenticated;
revoke all on function ops.podo_fifo_take(numeric[], numeric) from public, anon, authenticated;
revoke all on function ops.podo_do_rcv(text, text, bigint) from public, anon, authenticated;
revoke all on function ops.grn_avail(text, text, text, date) from public, anon, authenticated;
revoke all on function ops.podo_recv_moves(ops.supplier_do, bigint, jsonb, jsonb) from public, anon, authenticated;
revoke all on function ops.wh_pending(text, text, text) from public, anon, authenticated;
revoke all on all functions in schema ops from public, anon, authenticated;
