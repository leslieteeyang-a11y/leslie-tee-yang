-- 营运系统：订货升级 — 仓库部点货。套用到 Supabase 的 migration 名称：ops_po_receive
-- （要先套 20261012_ops_po_do / 20261013_ops_po_do_cs / 20261013b_ops_supplier_privacy；之后接著套 20261015_ops_po_sop。
--   约 56 KB，一次送会被挡：照「-- ====」分 3 段依序套用，每段 ≤ 24 KB：ops_po_receive_1 = 开头 + §1–3、
--   ops_po_receive_2 = §4、ops_po_receive_3 = §5–7；§7 的权限要在最后一段。）
--
-- 使用者 2026-10-13 决定：
--   * 厂家到货只有订货部（采购）开（使用者改口：原本想让物流部开，后来改成只有订货部；物流部维持订货「只看」、看不到厂家）。
--   * 货到了由仓库部的人点货：每个型号填实际收到几件（好货、坏货）、来错的货另外记，点货的人自己改分给各分店的数量，
--     然后才「货到了」。少 / 坏 / 多 / 来错自动记进「厂家问题」（auto = false），采购照清单追厂家。「标记到货」不能再直接按。
--     点货的人：订货或仓库「可编辑」、看得到那间公司（物流部有仓库「可编辑」也能点，但看不到厂家：清单 / 明细都遮掉）。
--     确认 DO 的人自己也可以点（JB 人少、老板自己测试）。点过货的 DO，厂家问题只有采购 / 管理层可以作废。
--   * 点货发现的到货少、坏货跟以前手动记的一样从「在路上」扣掉（ops.podo_pool 规则不变），扣的件数 = 好货比出货少的件数：
--     确认后已经手动记的坏货 / 到货少先算进去（不重复记）；好货已经够了还有坏的 = 多寄的坏件，记在「多到」。多到只是纪录。
--   * 点货改的分店分配：点货纪录（supplier_do.receipt.alloc）+ 每行 PO 分配少到的好货（supplier_do_apply.recv_less）。
--     ops.podo_lines 用 recv_less 决定还没出的数量落在哪间分店的 PO 行（例：JB 少 2 → 下一张厂家到货 JB 还可以出 2，不会跑到总部）。
--     分店的「在路上」只列还没到货的 DO，看不到点货后的分配；第二段（分店要货 / 已送出 / 已收到）要读 receipt.alloc。
--   * 厂家 DO 的分店：总部账套（HOMEWORKSSB）的 PO 替四间分店订；其他账套（HOMEWORKSSOUTHERN = JB）只能分给同公司的分店（JB）。
--   * AutoCount 仍只读：这里不写 bi.*。

-- ==================================================================== 1. 单价只给订货「可编辑」（采购、管理层）
-- 看得到进货单价 / 金额：订货「可编辑」以上；admin 一律看得到（与 ops_po_list / ops_po_get 的 prices 同规则）。
-- 点过货的 DO，厂家问题只有这些人能作废（ops_po_issue_set）；首页「厂家问题要处理」也只给他们。
create or replace function ops.sees_prices(p_staff ops.staff) returns boolean
language sql stable set search_path = '' as $$
  select coalesce(p_staff.role = 'admin' or ops.level_rank(ops.module_level(p_staff, 'purchasing')) >= 2, false)
$$;

-- ==================================================================== 2. 分店规则、点货栏位、在路上落在哪间分店、DO 表头
-- 厂家 DO 可以分给哪间分店：总部账套（HOMEWORKSSB）的 PO 替四间分店订；其他账套（HOMEWORKSSOUTHERN）整本属于同公司的分店（JB）
create or replace function ops.podo_outlet_ok(p_company text, p_outlet text) returns boolean
language sql stable set search_path = '' as $$
  select coalesce(exists (select 1 from ops.outlet o where o.code = p_outlet and o.active
                          and (p_company = 'HOMEWORKSSB' or o.company = p_company)), false)
$$;

-- 「JB 账套的货只能分给 JB（不能分给 总部、Puchong）。」
create or replace function ops.podo_outlet_msg(p_company text, p_bad text[]) returns text
language sql stable set search_path = '' as $$
  select format('%s 账套的货只能分给 %s（不能分给 %s）。', coalesce(g.names, p_company), coalesce(g.names, '—'),
                (select string_agg(coalesce(nullif(o.short_name, ''), o.name, b.c), '、' order by b.o)
                 from unnest(p_bad) with ordinality b(c, o) left join ops.outlet o on o.code = b.c))
  from (select string_agg(coalesce(nullif(o.short_name, ''), o.name), '、' order by o.sort, o.code) as names
        from ops.outlet o where o.active and o.company = p_company) g
$$;

-- 存草稿 / 确认时检查（触发器：ops_po_do_save 整份覆盖 items、ops_po_do_confirm 改状态都会经过）
create or replace function ops.supplier_do_outlet_guard() returns trigger
language plpgsql set search_path = '' as $$
declare
  v_bad text[];
begin
  if new.company = 'HOMEWORKSSB' or new.status not in ('draft', 'confirmed') then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.items is not distinct from old.items and new.company is not distinct from old.company
     and new.status is not distinct from old.status then
    return new;
  end if;
  select array_agg(distinct k.key order by k.key) into v_bad
  from jsonb_array_elements(new.items) e,
       jsonb_each(case when jsonb_typeof(e -> 'alloc') = 'object' then e -> 'alloc' else '{}'::jsonb end) k
  where not ops.podo_outlet_ok(new.company, k.key);
  if v_bad is not null then
    raise exception '%', ops.podo_outlet_msg(new.company, v_bad) using errcode = '22023';
  end if;
  return new;
end $$;
do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'supplier_do_outlet_guard' and tgrelid = 'ops.supplier_do'::regclass) then
    create trigger supplier_do_outlet_guard before insert or update on ops.supplier_do
      for each row execute function ops.supplier_do_outlet_guard();
  end if;
end $$;

-- receipt（null = 还没点）：{items:[{item_code, description, uom, shipped, received(好货), damaged(坏货), alloc{分店: 好货},
--   planned{分店: 确认时的分配}, prior{damaged, short: 点货前已手动记的}, note}], wrong:[{received_code, description,
--   expected_code, qty, note}], note, issue_ids:[…]}
alter table ops.supplier_do add column if not exists receipt jsonb;
-- 点货时这一笔分配（这间分店、这行 PO）少分到的好货：分店分配比确认时少的件数，先扣超出 PO 的（多发）再从后面的行扣
alter table ops.supplier_do_apply add column if not exists recv_less numeric not null default 0;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'supplier_do_apply_recv_less_ck') then
    alter table ops.supplier_do_apply add constraint supplier_do_apply_recv_less_ck check (recv_less >= 0 and recv_less <= qty);
  end if;
end $$;

-- 照抄 20261012_ops_po_do.sql §3，只改 ap：每行记的数量扣掉点货时这行少分到的（recv_less），
-- 总数照旧由 ops.podo_pool 决定（多了从最早的行扣、少了补在有记 DO 的行），所以只影响「还没出的落在哪间分店的行」。
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
  ap as (select a.dtl_key, sum(a.qty - a.recv_less) as applied, (array_agg(a.transferred_at order by a.rcv_base, a.id))[1] as first_tr,
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

-- ==================================================================== 3. 谁能点货、清单 / 明细
-- 能点货：订货或仓库「可编辑」，而且看得到那间公司（货到总部仓库：JB 的人不点总部的 DO）。确认这张 DO 的人自己也可以点。
create or replace function ops.podo_can_receive(p_staff ops.staff, p_company text) returns boolean
language sql stable set search_path = '' as $$
  select coalesce((ops.level_rank(ops.module_level(p_staff, 'purchasing')) >= 2
                   or ops.level_rank(ops.module_level(p_staff, 'warehouse')) >= 2)
                  and ops.sees_company(p_staff, p_company), false)
$$;

create or replace function ops.podo_require_receive() returns ops.staff
language plpgsql stable set search_path = '' as $$
declare
  me ops.staff;
begin
  me := ops.require_staff();
  if not coalesce(ops.level_rank(ops.module_level(me, 'purchasing')) >= 2
                  or ops.level_rank(ops.module_level(me, 'warehouse')) >= 2, false) then
    raise exception '要「订货与 ETA」或「仓库」可编辑才能点货。' using errcode = '42501';
  end if;
  return me;
end $$;

-- 点货清单 / 明细的表头。p_sup = 看得到厂家（ops.sees_supplier）；看不到的人（个人例外开了仓库可编辑的门市等）
-- 不回厂家、DO 号、PO 号、货柜名称。不含价格。summary 只有点过货的才有（件数）：
--   short / damaged / over / wrong = 点货纪录；mismatch = 点货前手动记的坏货 + 到货少比点到的缺口多几件（要采购核对、作废）；
--   later = 点完货之后才补记的（坏货、到货少、来错）。
create or replace function ops.podo_recv_head(d ops.supplier_do, p_sup boolean) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', d.id, 'company', d.company, 'status', d.status, 'do_date', d.do_date,
    'do_no', case when p_sup then d.do_no end,
    'supplier_name', case when p_sup then d.supplier_name end,
    'creditor_code', case when p_sup then d.creditor_code end,
    'shipment_name', case when p_sup then s.name end,
    'po_nos', case when p_sup then to_jsonb(d.po_nos) else '[]'::jsonb end,
    'eta', coalesce(s.eta, d.eta),
    'eta_source', case when s.eta is not null then 'shipment' when d.eta is not null then 'do' end,
    'overdue', coalesce(d.status = 'confirmed' and coalesce(s.eta, d.eta) < ops.today(), false),
    'item_count', (select count(*) from jsonb_array_elements(d.items) x
                   where x ->> 'item_code' is not null and coalesce((x ->> 'shipped')::numeric, 0) > 0),
    'unmatched_count', (select count(*) from jsonb_array_elements(d.items) x
                        where x ->> 'item_code' is null and coalesce((x ->> 'shipped')::numeric, 0) > 0),
    'shipped_total', (select coalesce(sum((x ->> 'shipped')::numeric), 0) from jsonb_array_elements(d.items) x),
    'outlets', (select coalesce(jsonb_agg(o.code order by o.sort, o.code), '[]'::jsonb) from ops.outlet o
                where exists (select 1 from ops.supplier_do_apply a where a.do_id = d.id and not a.void and a.outlet = o.code)),
    'confirmed_at', d.confirmed_at, 'confirmed_by_name', ops.podo_who(d.confirmed_by),
    'arrived_at', d.arrived_at, 'arrived_by_name', ops.podo_who(d.arrived_by),
    'summary', case when d.receipt is not null then (
      select jsonb_build_object(
        'short', coalesce(sum(greatest((x ->> 'shipped')::numeric - (x ->> 'received')::numeric - (x ->> 'damaged')::numeric, 0)), 0),
        'damaged', coalesce(sum((x ->> 'damaged')::numeric), 0),
        'over', coalesce(sum(greatest((x ->> 'received')::numeric + (x ->> 'damaged')::numeric - (x ->> 'shipped')::numeric, 0)), 0),
        'wrong', (select coalesce(sum((y ->> 'qty')::numeric), 0) from jsonb_array_elements(coalesce(d.receipt -> 'wrong', '[]'::jsonb)) y),
        'mismatch', coalesce(sum(greatest(coalesce((x #>> '{prior,damaged}')::numeric, 0) + coalesce((x #>> '{prior,short}')::numeric, 0)
                                          - greatest((x ->> 'shipped')::numeric - (x ->> 'received')::numeric, 0), 0)), 0),
        'later', (select jsonb_build_object(
                    'damaged', coalesce(sum(i.qty) filter (where i.kind = 'damaged'), 0),
                    'short', coalesce(sum(i.qty) filter (where i.kind = 'short'), 0),
                    'wrong', coalesce(sum(i.qty) filter (where i.kind = 'wrong'), 0))
                  from ops.supplier_issue i
                  where i.do_id = d.id and i.status <> 'void' and not i.auto and i.created_at > d.arrived_at
                    and not coalesce(d.receipt -> 'issue_ids' @> to_jsonb(i.id), false)))
      from jsonb_array_elements(coalesce(d.receipt -> 'items', '[]'::jsonb)) x) end)
  from (select 1) z left join ops.shipment s on s.id = d.shipment_id and s.status <> 'cancelled'
$$;

-- 点货清单的搜寻：型号 / 品名；看得到厂家的人也找 DO 号、厂家、PO 号、厂家 DO 上的型号写法
create or replace function ops.podo_recv_match(d ops.supplier_do, p_sup boolean, p_q text) returns boolean
language sql stable set search_path = '' as $$
  select p_q is null
      or exists (select 1 from jsonb_array_elements(d.items) x
                 where coalesce(x ->> 'item_code', '') ilike '%' || p_q || '%'
                    or coalesce(x ->> 'description', '') ilike '%' || p_q || '%'
                    or (p_sup and coalesce(x ->> 'src_code', '') ilike '%' || p_q || '%'))
      or (p_sup and (d.do_no ilike '%' || p_q || '%' or d.supplier_name ilike '%' || p_q || '%'
                     or d.creditor_code ilike '%' || p_q || '%' or array_to_string(d.po_nos, ' ') ilike '%' || p_q || '%'))
$$;

-- p: company（可空）days（「最近点过」几天，预设 14，1–366）q（搜寻，两区都套）。
-- todo = 已确认、还没点货（有效 ETA 近的在前，没 ETA 的最后）；done = 最近 days 天点过的（新的在前）。
create or replace function public.ops_po_receive_list(p jsonb default '{}'::jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  sup boolean;
  v_days int := least(greatest(coalesce(case when (p ->> 'days') ~ '^[0-9]{1,3}$' then (p ->> 'days')::int end, 14), 1), 366);
  v_q text := nullif(trim(coalesce(p ->> 'q', '')), '');
begin
  me := ops.podo_require_receive();
  sup := ops.sees_supplier(me);
  return jsonb_build_object(
    'days', v_days,
    'todo', (select coalesce(jsonb_agg(ops.podo_recv_head(r.x, sup) order by r.eta nulls last, (r.x).confirmed_at, (r.x).id),
                             '[]'::jsonb)
             from (select x, coalesce(s.eta, x.eta) as eta from ops.supplier_do x
                   left join ops.shipment s on s.id = x.shipment_id and s.status <> 'cancelled'
                   where x.status = 'confirmed' and ops.sees_company(me, x.company)
                     and (nullif(p ->> 'company', '') is null or x.company = p ->> 'company')
                     and ops.podo_recv_match(x, sup, v_q)
                   order by coalesce(s.eta, x.eta) nulls last, x.id limit 500) r),
    'done', (select coalesce(jsonb_agg(ops.podo_recv_head(r.x, sup) order by (r.x).arrived_at desc, (r.x).id desc), '[]'::jsonb)
             from (select x from ops.supplier_do x
                   where x.status = 'arrived' and x.arrived_at >= now() - make_interval(days => v_days)
                     and ops.sees_company(me, x.company)
                     and (nullif(p ->> 'company', '') is null or x.company = p ->> 'company')
                     and ops.podo_recv_match(x, sup, v_q)
                   order by x.arrived_at desc limit 200) r));
end $$;

-- 点货画面：表头 + 这张可以分的分店（总部账套四间；JB 账套只有 JB）+ 要点的型号（有型号、出货 > 0）+ 对不上 PO 的行 +
-- 这张 DO 的厂家问题（精简；from_receipt = 点货时记的、after_receipt = 点完货之后才补记的）
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
    'outlets', (select coalesce(jsonb_agg(jsonb_build_object('code', o.code, 'name', o.name, 'short_name', o.short_name,
                                                             'company', o.company) order by o.sort, o.code), '[]'::jsonb)
                from ops.outlet o where o.active and ops.podo_outlet_ok(d.company, o.code)),
    'items', (select coalesce(jsonb_agg(jsonb_build_object(
                'item_code', t.e ->> 'item_code', 'description', coalesce(t.e ->> 'description', ''),
                'uom', coalesce(t.e ->> 'uom', ''), 'shipped', (t.e ->> 'shipped')::numeric,
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
                    'src_code', coalesce(t.e ->> 'src_code', ''), 'src_desc', coalesce(t.e ->> 'src_desc', ''),
                    'shipped', (t.e ->> 'shipped')::numeric, 'expected_code', t.e ->> 'expected_code',
                    'note', coalesce(t.e ->> 'note', '')) order by t.o), '[]'::jsonb)
                  from jsonb_array_elements(d.items) with ordinality t(e, o)
                  where t.e ->> 'item_code' is null and coalesce((t.e ->> 'shipped')::numeric, 0) > 0),
    'issues', (select coalesce(jsonb_agg(jsonb_build_object(
                 'id', i.id, 'kind', i.kind, 'item_code', i.item_code, 'received_code', i.received_code,
                 'description', i.description, 'qty', i.qty, 'auto', i.auto, 'status', i.status, 'decision', i.decision,
                 'note', i.note, 'created_at', i.created_at,
                 'from_receipt', coalesce(d.receipt -> 'issue_ids' @> to_jsonb(i.id), false),
                 'after_receipt', coalesce(not i.auto and i.created_at > d.arrived_at
                                           and not coalesce(d.receipt -> 'issue_ids' @> to_jsonb(i.id), false), false))
                 order by i.id), '[]'::jsonb)
               from ops.supplier_issue i where i.do_id = d.id and i.status <> 'void'));
end $$;

-- ==================================================================== 4. 点货（货到了）
-- p: {id, items:[{item_code, received, damaged, alloc{分店: 好货}, note}], wrong:[{received_code, description, expected_code, qty, note}], note}
--   items 要刚好是这张 DO 有型号、出货 > 0 的那些；好货一定要分完（各分店合计 = 好货），坏货不分配。
--   每个型号：缺口 = 出货 − 好货（> 0 才有）= 这张这个型号要从「在路上」扣的件数。点货前已经手动记的坏货 / 到货少（没作废）
--   先算进缺口，不够才补记：坏货（最多到点到的坏货）、其余记到货少。已记的比缺口还多 = 跟点货结果不一致：不动它，
--   receipt 记 prior、清单显示要采购核对。坏货比缺口多（好货已经够了）= 多寄的坏件：不记坏货，算在「多到」的件数与备注。
--   多到 = 好货 + 坏货 − 出货（只是纪录）。
--   来错的货：同一个（收到的型号, 本来应该是）合起来；扣掉这张 DO 已经记过的同样发错型号（含确认时 Excel 对不上自动记的）；
--   没选「本来应该是」的，扣掉同一个收到的型号还没被其他行抵掉的。
--   分店分配比确认时少：照分店把少的件数记在那间分店的分配（supplier_do_apply.recv_less，先扣多发、再从后面的行扣）。
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
  v_used jsonb := '{}'::jsonb;   -- 来错的货：每个收到的型号已经抵掉多少件已记的发错型号
  v_ids bigint[] := '{}';
  v_missing text;
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
    if v_rc = '' and v_note = '' then
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
                                                               'expected_code', v_exp, 'qty', v_q, 'note', v_note));
  end loop;
  for w in select upper(t.y ->> 'received_code') as cu, min(t.y ->> 'received_code') as rc, t.y ->> 'expected_code' as exp,
                  coalesce(min(nullif(t.y ->> 'description', '')), '') as descr, sum((t.y ->> 'qty')::numeric) as qty,
                  coalesce(string_agg(nullif(t.y ->> 'note', ''), '；' order by t.o), '') as note
           from jsonb_array_elements(v_wrong) with ordinality t(y, o)
           group by upper(t.y ->> 'received_code'), t.y ->> 'expected_code', case when t.y ->> 'received_code' = '' then t.o end
           order by (t.y ->> 'expected_code') is null, min(t.o) loop
    v_q := w.qty;
    if w.cu <> '' then
      select coalesce(sum(i.qty), 0) - case when w.exp is null then coalesce((v_used ->> w.cu)::numeric, 0) else 0 end
        into v_left
      from ops.supplier_issue i
      where i.do_id = d.id and i.kind = 'wrong' and i.status <> 'void' and upper(i.received_code) = w.cu
        and (w.exp is null or i.item_code = w.exp) and i.id <> all (v_ids);
      v_left := least(greatest(v_left, 0), w.qty);
      v_used := v_used || jsonb_build_object(w.cu, coalesce((v_used ->> w.cu)::numeric, 0) + v_left);
      v_q := w.qty - v_left;
    end if;
    if v_q > 0 then
      r := ops.podo_issue_new(d, me.id, 'wrong', w.exp, w.rc, w.descr, d.po_nos, null, w.qty, v_q, w.note, false);
      v_ids := v_ids || r.id;
    end if;
  end loop;

  update ops.supplier_do x set
    receipt = jsonb_build_object('items', v_items, 'wrong', v_wrong, 'note', v_all_note, 'issue_ids', to_jsonb(v_ids)),
    status = 'arrived', arrived_by = me.id, arrived_at = now(), arrive_note = v_all_note, updated_by = me.id, updated_at = now()
  where x.id = d.id;
  perform ops.log(me.id, 'receive', 'supplier_do', d.id, jsonb_build_object('note', v_all_note, 'issue_ids', to_jsonb(v_ids),
                                                                             'items', jsonb_array_length(v_items),
                                                                             'wrong', jsonb_array_length(v_wrong)));
  return public.ops_po_receive_get(d.id);
end $$;

-- 不能再直接「标记到货」：一定要点货（签名与权限照旧，前端旧版按下去会看到这句）
create or replace function public.ops_po_do_arrive(p_id bigint, p_note text default '') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
begin
  me := ops.require_staff();
  if not coalesce(ops.level_rank(ops.module_level(me, 'purchasing')) >= 2
                  or ops.level_rank(ops.module_level(me, 'warehouse')) >= 2, false) then
    raise exception '要「订货与 ETA」或「仓库」可编辑才能标记到货。' using errcode = '42501';
  end if;
  raise exception '要先点货：请在「点货」填每个型号实际收到几件，再按「点完，货到了」。' using errcode = '22023';
end $$;

-- ==================================================================== 5. 厂家问题（仓库也能记；点过货的只有采购 / 管理层能作废）、档案、整张 DO
-- 照抄 20261012_ops_po_do.sql，只改权限：订货「可编辑」或仓库「可编辑」（点完货之后才发现的坏货、来错货）；
-- 看不到厂家的人（ops.sees_supplier = false）只回精简的结果。
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
  me := ops.require_staff();
  if not coalesce(ops.level_rank(ops.module_level(me, 'purchasing')) >= 2
                  or ops.level_rank(ops.module_level(me, 'warehouse')) >= 2, false) then
    raise exception '要「订货与 ETA」或「仓库」可编辑才能记厂家问题。' using errcode = '42501';
  end if;
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
  if not ops.sees_supplier(me) then
    return jsonb_build_object('id', r.id, 'kind', r.kind, 'item_code', r.item_code, 'received_code', r.received_code,
                              'qty', r.qty, 'status', r.status, 'note', r.note);
  end if;
  return ops.podo_issue_json(r);
end $$;

-- 处理问题（照抄 20261012_ops_po_do.sql）：只多一条——点过货的 DO（有点货纪录），厂家问题只有采购 / 管理层（ops.sees_prices）
-- 可以作废（作废会让「在路上 / 还可以出」又算回来）。现在要订货「可编辑」才叫得到这个函数，这条是防以后权限放宽。
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
      action_note = case when p_action <> 'note' and p_note is not null then left(p_note, 500) else x.action_note end,
      updated_at = now()
    where x.id = s.id;
    perform ops.log(me.id, 'issue_' || p_action, 'supplier_issue', s.id, jsonb_build_object('note', p_note));
    n := n + 1;
  end loop;
  return n;
end $$;

-- Storage ops-po：写（上传）照旧只给订货「可编辑」；读也给仓库「可编辑」且看得到厂家的人（点货时对照厂家 DO）
create or replace function public.ops_po_file_ok(p_name text, p_write boolean) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff := ops.current_staff();
  c text := split_part(coalesce(p_name, ''), '/', 1);
begin
  return coalesce(me.id is not null and c in ('HOMEWORKSSB', 'HOMEWORKSSOUTHERN') and ops.sees_company(me, c)
                  and (ops.level_rank(ops.module_level(me, 'purchasing')) >= 2
                       or (not coalesce(p_write, true) and ops.level_rank(ops.module_level(me, 'warehouse')) >= 2
                           and ops.sees_supplier(me))), false);
end $$;

-- 整张 DO（ops_po_do_get / _save / _confirm / _reopen 回传）：照抄 20261012，多回 receipt（点货纪录，null = 还没点）
create or replace function ops.podo_full(p_me ops.staff, d ops.supplier_do) returns jsonb
language sql stable set search_path = '' as $$
  select ops.podo_json(p_me, d) || jsonb_build_object(
    'items', d.items,
    'receipt', d.receipt,
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

-- ==================================================================== 6. 首页
-- 照抄 20261013b_ops_supplier_privacy.sql，多三个：
--   do_to_count：订货或仓库「可编辑」的人，看得到的公司里已确认、还没点货、有效 ETA（货柜 > DO）在三天内或已过；
--   do_no_eta：订货「可编辑」的人（采购、管理层），已确认还没填 ETA 的厂家 DO（分店看到「未填」）；
--   po_issues_todo：采购 / 管理层（ops.sees_prices），还没决定的少发 + 7 天内新记、还没处理的厂家问题（点货记的会出现在这里）。
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
    'po_overdue', case when po >= 2 then
                    (select count(*) from ops.v_po_open v where ops.sees_company(me, v.company)
                     and v.status <> 'closed' and v.days_late > 0
                     and (v.days_open <= 120 or v.status <> 'ordered' or v.po_eta is not null or v.shipment_id is not null))
                  end,
    'po_arriving', case when ops.sees_supplier(me) then
                    (select count(*) from ops.v_po_open v where ops.sees_company(me, v.company)
                     and v.status not in ('closed', 'arrived') and v.eta between ops.today() and ops.today() + 3) end,
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
                       and ((i.kind = 'short' and i.decision = 'pending')
                            or (not i.auto and i.created_at >= now() - interval '7 days'))) end,
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

-- ==================================================================== 7. 权限
do $$
declare
  f text;
begin
  foreach f in array array['ops_po_receive_list(jsonb)', 'ops_po_receive_get(bigint)', 'ops_po_do_receive(jsonb)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
revoke all on function ops.sees_prices(ops.staff) from public, anon, authenticated;
revoke all on function ops.podo_outlet_ok(text, text) from public, anon, authenticated;
revoke all on function ops.podo_outlet_msg(text, text[]) from public, anon, authenticated;
revoke all on function ops.supplier_do_outlet_guard() from public, anon, authenticated;
revoke all on function ops.podo_can_receive(ops.staff, text) from public, anon, authenticated;
revoke all on function ops.podo_require_receive() from public, anon, authenticated;
revoke all on function ops.podo_recv_head(ops.supplier_do, boolean) from public, anon, authenticated;
revoke all on function ops.podo_recv_match(ops.supplier_do, boolean, text) from public, anon, authenticated;
revoke all on all functions in schema ops from public, anon, authenticated;
