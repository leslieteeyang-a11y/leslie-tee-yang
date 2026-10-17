-- HomeWorks 营运系统 — 仓库把关（使用者 2026-10-17：「我想要让进货和出货都有人把关，然后可以有效率的处理」，选了 8 项）
-- 进货：① 点货有差异（少 / 坏 / 多 / 来错）→ 仓库主管复核；复核前开单部不能把这批进货标「已输入」（GRN）。全到、没坏的不用复核。
--       ② 坏货、来错的货一定要拍照（跟厂家理赔用；厂家问题清单看得到照片）。少货可以拍（没有东西可拍，不强制）。
--       ③ 点完货 →「待上架」：扫货架上架（货架帐 kind putaway、ref_type move、ref_id = 这笔进货；进货取消时触发器自动冲回），
--          超过 ops.wh_gate.putaway_days（预设 2）天没上架就提醒。只算这个功能上线之后的进货、而且仓位有建货架的。
-- 出货：④ 拣货按「已拣好」后，要另一个人扫码核对（开始拣、按已拣好、有扫码的人都不能核对），每行数量相符才算核对好；
--          不符记一次 check_fails（算在拣货的人身上），请拣货的人重开改正或再核对一次。
--       ⑤ 装车核对：出车前一张一张扫 DO，没拣好 / 没核对的不能装；⑥ 出车要拍装车照（Storage ops-wh：load/<公司>/<排单>/…）。
--          送货「可审批」可以写原因强制出车（例：DO 没有要拣的货）。
-- 效率：⑦ 仓库「今天」：今天要点货、复核、拣货、核对、上架、出车，照急迫排，显示谁接了哪一项（认领 ops.wh_claim）；
--       ⑧ 每人工作量（仓库可审批）：点货、拣货、核对、上架、装车的件数、平均时间、核对不符次数。
-- 每间分店可以分别关掉 ① ② ④ ⑤⑥（ops.wh_gate，仓库可审批在「复核 → 设定」改；人手不够两个人核对时用）。没有设定 = 全部开。
-- 对 AutoCount 仍然只读。正式环境照「-- ====」分段套用；§1 有 create table / trigger（用 if not exists 包著，可以重跑），
-- 其他段只有 create or replace。

-- ==================================================================== 1. 资料表、触发器
create table if not exists ops.wh_gate (
  company text primary key check (company in ('HOMEWORKSSB', 'HOMEWORKSSOUTHERN', 'HOMEWORKSPUCHONG')),
  recv_review boolean not null default true,     -- ① 点货差异要主管复核
  recv_photo boolean not null default true,      -- ② 坏货 / 来错的货要拍照
  pick_check boolean not null default true,      -- ④ 拣货要另一个人核对
  load_check boolean not null default true,      -- ⑤⑥ 装车核对 + 装车照
  putaway_days int not null default 2 check (putaway_days between 1 and 30),
  updated_by bigint references ops.staff(id),
  updated_at timestamptz not null default now()
);

-- 点货照片：item_key = 型号（大写）；来错的货没有型号 = 'D:' + 品名（大写、连续空白当一个），见 ops.wh_recv_key
create table if not exists ops.wh_recv_photo (
  id bigint generated always as identity primary key,
  do_id bigint not null references ops.supplier_do(id),
  company text not null,
  kind text not null check (kind in ('damaged', 'wrong', 'short')),
  item_key text not null check (length(item_key) between 1 and 320),
  path text not null unique check (length(path) <= 300),
  created_by bigint not null references ops.staff(id),
  created_at timestamptz not null default now(),
  voided boolean not null default false,
  voided_by bigint references ops.staff(id)
);
create index if not exists wh_recv_photo_do_idx on ops.wh_recv_photo (do_id);

-- 点货差异复核：一张厂家 DO 一笔（点货有差异时由触发器建立）
create table if not exists ops.wh_recv_review (
  do_id bigint primary key references ops.supplier_do(id),
  company text not null,
  status text not null default 'pending' check (status in ('pending', 'approved')),
  reasons jsonb not null default '[]'::jsonb,    -- [{item_code, description, shipped, received, damaged}] / [{wrong:true, received_code, description, qty}]
  counted_by bigint references ops.staff(id),
  counted_at timestamptz not null default now(),
  reviewed_by bigint references ops.staff(id),
  reviewed_at timestamptz,
  note text not null default '' check (length(note) <= 500)
);
create index if not exists wh_recv_review_pending_idx on ops.wh_recv_review (company, status);

-- 拣货核对
alter table ops.wh_pick add column if not exists checked_by bigint references ops.staff(id);
alter table ops.wh_pick add column if not exists checked_at timestamptz;
alter table ops.wh_pick add column if not exists check_note text not null default '';
alter table ops.wh_pick add column if not exists check_fails int not null default 0;
alter table ops.wh_pick_line add column if not exists checked numeric(12,2);
create index if not exists wh_pick_tocheck_idx on ops.wh_pick (company, done_at) where status = 'done' and checked_at is null;

-- 上架：不用上架的（例：直接送去分店、放地上）写原因
alter table ops.wh_move add column if not exists put_skip text;
alter table ops.wh_move add column if not exists put_skip_by bigint references ops.staff(id);
alter table ops.wh_move add column if not exists put_skip_at timestamptz;
create index if not exists wh_move_receive_idx on ops.wh_move (company, created_at) where kind = 'receive';

-- 认领（今天的工作谁接了）：staff_id = null = 放掉
create table if not exists ops.wh_claim (
  kind text not null check (kind in ('receive', 'putaway', 'pick_check')),
  ref bigint not null,
  company text not null,
  staff_id bigint references ops.staff(id),
  claimed_at timestamptz not null default now(),
  primary key (kind, ref)
);

-- 装车：一趟排单一笔（bi.delivery_run.id）；每张 DO 扫过一次一笔（取消 = voided，不删）
create table if not exists ops.dlv_load (
  run_id bigint primary key,
  company text not null,
  status text not null default 'loading' check (status in ('loading', 'departed')),
  photos text[] not null default '{}',
  note text not null default '' check (length(note) <= 500),
  override_reason text not null default '' check (length(override_reason) <= 300),
  started_by bigint not null references ops.staff(id),
  started_at timestamptz not null default now(),
  departed_by bigint references ops.staff(id),
  departed_at timestamptz
);
create table if not exists ops.dlv_load_doc (
  run_id bigint not null references ops.dlv_load(run_id),
  doc_no text not null,
  voided boolean not null default false,
  loaded_by bigint not null references ops.staff(id),
  loaded_at timestamptz not null default now(),
  primary key (run_id, doc_no)
);
create index if not exists dlv_load_doc_by_idx on ops.dlv_load_doc (loaded_by, loaded_at);

alter table ops.wh_gate enable row level security;
alter table ops.wh_recv_photo enable row level security;
alter table ops.wh_recv_review enable row level security;
alter table ops.wh_claim enable row level security;
alter table ops.dlv_load enable row level security;
alter table ops.dlv_load_doc enable row level security;

-- 这间分店的把关设定（没有设定 = 全部开、上架 2 天）
create or replace function ops.wh_gate_of(p_company text) returns ops.wh_gate
language sql stable security definer set search_path = '' as $$
  select coalesce((select g from ops.wh_gate g where g.company = p_company),
                  row(p_company, true, true, true, true, 2, null, now())::ops.wh_gate)
$$;

-- 来错的货 / 照片的对照键：有型号 = 型号大写；没有 = 'D:' + 品名大写（前端 recvKey 同一套）
create or replace function ops.wh_recv_key(p_code text, p_desc text) returns text
language sql immutable set search_path = '' as $$
  select case when nullif(trim(coalesce(p_code, '')), '') is not null then upper(left(trim(p_code), 100))
              else 'D:' || upper(regexp_replace(left(trim(coalesce(p_desc, '')), 300), '\s+', ' ', 'g')) end
$$;

-- 点货送出（status → arrived）：② 坏货 / 来错的货要有照片（没有就整个点货不存）；① 有差异 → 建复核
create or replace function ops.supplier_do_gate() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  g ops.wh_gate;
  v_miss text;
  v_reasons jsonb;
begin
  if new.status is distinct from 'arrived' or old.status = 'arrived' or new.receipt is null then
    return new;
  end if;
  g := ops.wh_gate_of(new.company);
  if g.recv_photo then
    select string_agg(z.label, '、' order by z.o) into v_miss from (
      select x.o, (x.e ->> 'item_code') || '（坏货）' as label
      from jsonb_array_elements(coalesce(new.receipt -> 'items', '[]'::jsonb)) with ordinality x(e, o)
      where coalesce((x.e ->> 'damaged')::numeric, 0) > 0
        and not exists (select 1 from ops.wh_recv_photo ph where ph.do_id = new.id and not ph.voided and ph.kind = 'damaged'
                          and ph.item_key = ops.wh_recv_key(x.e ->> 'item_code', ''))
      union all
      select 100000 + y.o, coalesce(nullif(y.e ->> 'received_code', ''), y.e ->> 'description') || '（来错的货）'
      from jsonb_array_elements(coalesce(new.receipt -> 'wrong', '[]'::jsonb)) with ordinality y(e, o)
      where not exists (select 1 from ops.wh_recv_photo ph where ph.do_id = new.id and not ph.voided and ph.kind = 'wrong'
                          and ph.item_key = ops.wh_recv_key(y.e ->> 'received_code', y.e ->> 'description'))) z;
    if v_miss is not null then
      raise exception '% 要先拍照才能送出（跟厂家理赔要用）。', v_miss using errcode = '22023';
    end if;
  end if;
  if g.recv_review then
    select coalesce(jsonb_agg(z.j order by z.o), '[]'::jsonb) into v_reasons from (
      select x.o, jsonb_build_object('item_code', x.e ->> 'item_code', 'description', x.e ->> 'description',
                                     'shipped', (x.e ->> 'shipped')::numeric, 'received', (x.e ->> 'received')::numeric,
                                     'damaged', coalesce((x.e ->> 'damaged')::numeric, 0)) as j
      from jsonb_array_elements(coalesce(new.receipt -> 'items', '[]'::jsonb)) with ordinality x(e, o)
      where coalesce((x.e ->> 'damaged')::numeric, 0) > 0
         or coalesce((x.e ->> 'received')::numeric, 0) + coalesce((x.e ->> 'damaged')::numeric, 0)
            <> coalesce((x.e ->> 'shipped')::numeric, 0)
      union all
      select 100000 + y.o, jsonb_build_object('wrong', true, 'received_code', y.e ->> 'received_code',
                                              'description', y.e ->> 'description', 'qty', (y.e ->> 'qty')::numeric,
                                              'expected_code', y.e ->> 'expected_code')
      from jsonb_array_elements(coalesce(new.receipt -> 'wrong', '[]'::jsonb)) with ordinality y(e, o)) z;
    if jsonb_array_length(v_reasons) > 0 then
      insert into ops.wh_recv_review (do_id, company, status, reasons, counted_by, counted_at)
      values (new.id, new.company, 'pending', v_reasons, new.arrived_by, coalesce(new.arrived_at, now()))
      on conflict (do_id) do update set status = 'pending', reasons = excluded.reasons, counted_by = excluded.counted_by,
                                        counted_at = excluded.counted_at, reviewed_by = null, reviewed_at = null, note = '';
    end if;
  end if;
  return new;
end $$;

-- ① 复核前不能标「已输入」（开 GRN）
create or replace function ops.wh_move_gate() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.kind = 'receive' and new.status = 'done' and old.status = 'pending' and new.do_id is not null
     and exists (select 1 from ops.wh_recv_review r where r.do_id = new.do_id and r.status = 'pending') then
    raise exception '这批进货点货有差异，还在等仓库主管复核；复核后才能标「已输入」。' using errcode = '22023';
  end if;
  return new;
end $$;

do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'supplier_do_gate' and tgrelid = 'ops.supplier_do'::regclass) then
    create trigger supplier_do_gate after update of status on ops.supplier_do
      for each row execute function ops.supplier_do_gate();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'wh_move_gate' and tgrelid = 'ops.wh_move'::regclass) then
    create trigger wh_move_gate before update of status on ops.wh_move
      for each row execute function ops.wh_move_gate();
  end if;
end $$;

-- ==================================================================== 2. 设定、照片（Storage ops-wh：recv/<公司>/<DO id>/…、load/<公司>/<排单>/…）
-- 设定：仓库「只看」以上看得到；「可审批」才能改
create or replace function public.ops_wh_gate_get(p_company text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  c text;
begin
  me := ops.require_level('warehouse', 'view');
  c := ops.wh_company(me, p_company);
  return to_jsonb(ops.wh_gate_of(c)) || jsonb_build_object(
    'updated_by_name', (select s.name from ops.staff s where s.id = (ops.wh_gate_of(c)).updated_by));
end $$;

-- p: {company, recv_review, recv_photo, pick_check, load_check, putaway_days}（没给的栏位不变）
create or replace function public.ops_wh_gate_set(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  c text;
  g ops.wh_gate;
  v_days int;
begin
  me := ops.require_level('warehouse', 'approve');
  c := ops.wh_company(me, p ->> 'company');
  g := ops.wh_gate_of(c);
  if p ? 'putaway_days' then
    v_days := case when (p ->> 'putaway_days') ~ '^[0-9]{1,2}$' then (p ->> 'putaway_days')::int end;
    if v_days is null or v_days not between 1 and 30 then
      raise exception '上架提醒天数要 1 到 30 天。' using errcode = '22023';
    end if;
  end if;
  insert into ops.wh_gate (company, recv_review, recv_photo, pick_check, load_check, putaway_days, updated_by, updated_at)
  values (c,
          case when jsonb_typeof(p -> 'recv_review') = 'boolean' then (p ->> 'recv_review')::boolean else g.recv_review end,
          case when jsonb_typeof(p -> 'recv_photo') = 'boolean' then (p ->> 'recv_photo')::boolean else g.recv_photo end,
          case when jsonb_typeof(p -> 'pick_check') = 'boolean' then (p ->> 'pick_check')::boolean else g.pick_check end,
          case when jsonb_typeof(p -> 'load_check') = 'boolean' then (p ->> 'load_check')::boolean else g.load_check end,
          coalesce(v_days, g.putaway_days), me.id, now())
  on conflict (company) do update set recv_review = excluded.recv_review, recv_photo = excluded.recv_photo,
    pick_check = excluded.pick_check, load_check = excluded.load_check, putaway_days = excluded.putaway_days,
    updated_by = excluded.updated_by, updated_at = excluded.updated_at;
  perform ops.log(me.id, 'gate', 'wh_gate', null, to_jsonb(ops.wh_gate_of(c)));
  return public.ops_wh_gate_get(c);
end $$;

-- ops-wh 的读写权限：items（商品照片，照旧）、recv（点货照片：能点货的人写；看得到厂家的人也能看）、
-- load（装车照：送货可编辑写、送货只看或仓库可审批看）
create or replace function public.ops_wh_file_ok(p_name text, p_write boolean) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff := ops.current_staff();
  k text := split_part(coalesce(p_name, ''), '/', 1);
  c text := split_part(coalesce(p_name, ''), '/', 2);
  w boolean := coalesce(p_write, true);
begin
  if me.id is null or c not in ('HOMEWORKSSB', 'HOMEWORKSSOUTHERN', 'HOMEWORKSPUCHONG') or not coalesce(ops.sees_company(me, c), false) then
    return false;
  end if;
  return coalesce(case k
    when 'items' then ops.level_rank(ops.module_level(me, 'warehouse')) >= case when w then 2 else 1 end
    when 'recv' then ops.podo_can_receive(me, c) or (not w and ops.sees_supplier(me))
    when 'load' then ops.level_rank(ops.module_level(me, 'delivery')) >= case when w then 2 else 1 end
                     or (not w and ops.level_rank(ops.module_level(me, 'warehouse')) >= 3)
    else false end, false);
end $$;

-- 一张 DO 的点货照片
create or replace function ops.wh_recv_photo_list(p_do bigint) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', ph.id, 'kind', ph.kind, 'item_key', ph.item_key, 'path', ph.path,
                                               'created_at', ph.created_at,
                                               'by_name', (select s.name from ops.staff s where s.id = ph.created_by))
                            order by ph.id), '[]'::jsonb)
  from ops.wh_recv_photo ph where ph.do_id = p_do and not ph.voided
$$;

create or replace function public.ops_wh_recv_photos(p_do_id bigint) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  d ops.supplier_do;
begin
  me := ops.require_staff();
  select * into d from ops.supplier_do x where x.id = p_do_id;
  if d.id is null or not coalesce(ops.podo_can_receive(me, d.company)
                                  or (ops.sees_supplier(me) and ops.sees_company(me, d.company))
                                  or (ops.level_rank(ops.module_level(me, 'warehouse')) >= 1 and ops.sees_company(me, d.company)), false) then
    raise exception '找不到这张厂家 DO。' using errcode = 'P0002';
  end if;
  return ops.wh_recv_photo_list(d.id);
end $$;

-- p: {do_id, kind: damaged|wrong|short, item_code, description, path}；先传到 Storage 再登记。点货前、点货后都可以加（理赔补照片）。
create or replace function public.ops_wh_recv_photo_add(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  d ops.supplier_do;
  v_kind text := p ->> 'kind';
  v_key text;
  v_path text := trim(coalesce(p ->> 'path', ''));
begin
  me := ops.podo_require_receive();
  select * into d from ops.supplier_do x
  where x.id = case when (p ->> 'do_id') ~ '^[0-9]{1,18}$' then (p ->> 'do_id')::bigint end;
  if d.id is null or not ops.podo_can_receive(me, d.company) then
    raise exception '找不到这张厂家 DO。' using errcode = 'P0002';
  end if;
  if d.status not in ('confirmed', 'arrived') then
    raise exception '还没确认的 DO 不能加点货照片。' using errcode = '22023';
  end if;
  if v_kind is null or v_kind not in ('damaged', 'wrong', 'short') then
    raise exception '照片种类不对。' using errcode = '22023';
  end if;
  v_key := ops.wh_recv_key(p ->> 'item_code', p ->> 'description');
  if v_key in ('', 'D:') then
    raise exception '照片要对到型号或品名。' using errcode = '22023';
  end if;
  if v_path not like 'recv/' || d.company || '/' || d.id || '/%' or v_path like '%..%' or length(v_path) > 300 then
    raise exception '照片路径不对，请重新拍一次。' using errcode = '22023';
  end if;
  if (select count(*) from ops.wh_recv_photo ph where ph.do_id = d.id and not ph.voided) >= 80 then
    raise exception '一张 DO 最多 80 张照片。' using errcode = '22023';
  end if;
  insert into ops.wh_recv_photo (do_id, company, kind, item_key, path, created_by)
  values (d.id, d.company, v_kind, v_key, v_path, me.id)
  on conflict (path) do nothing;
  return ops.wh_recv_photo_list(d.id);
end $$;

-- 拿掉一张（还没点货的才能拿；点货后照片是理赔证据，不拿）。拍的人或仓库可审批。
create or replace function public.ops_wh_recv_photo_del(p_id bigint) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  ph ops.wh_recv_photo;
  d ops.supplier_do;
begin
  me := ops.podo_require_receive();
  select * into ph from ops.wh_recv_photo x where x.id = p_id and not x.voided for update;
  select * into d from ops.supplier_do x where x.id = ph.do_id;
  if ph.id is null or not ops.podo_can_receive(me, d.company) then
    raise exception '找不到这张照片。' using errcode = 'P0002';
  end if;
  if d.status <> 'confirmed' then
    raise exception '点过货的照片是理赔证据，不能拿掉。' using errcode = '22023';
  end if;
  if ph.created_by <> me.id and ops.level_rank(ops.module_level(me, 'warehouse')) < 3 then
    raise exception '只有拍照的人或仓库「可审批」可以拿掉。' using errcode = '42501';
  end if;
  update ops.wh_recv_photo set voided = true, voided_by = me.id where id = ph.id;
  return ops.wh_recv_photo_list(d.id);
end $$;

-- 厂家问题（照抄 20261015_ops_po_sop.sql），多 photos（点货时拍的照片路径）
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
    'owed_qty', ops.podo_owed(i),
    'photos', (select coalesce(jsonb_agg(ph.path order by ph.id), '[]'::jsonb) from ops.wh_recv_photo ph
               where ph.do_id = i.do_id and not ph.voided and ph.kind = i.kind
                 and ph.item_key = case when i.kind = 'wrong' then ops.wh_recv_key(i.received_code, i.description)
                                        else ops.wh_recv_key(i.item_code, '') end))
  from (select 1) z left join ops.supplier_do d on d.id = i.do_id
$$;

-- ==================================================================== 3. ① 点货差异复核
create or replace function ops.wh_recv_review_json(p_me ops.staff, r ops.wh_recv_review) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'do_id', r.do_id, 'company', r.company, 'status', r.status, 'reasons', r.reasons,
    'do_no', case when ops.sees_supplier(p_me) then d.do_no end,
    'supplier_name', case when ops.sees_supplier(p_me) then d.supplier_name end,
    'arrive_note', d.arrive_note,
    'counted_by_name', (select s.name from ops.staff s where s.id = r.counted_by), 'counted_at', r.counted_at,
    'reviewed_by_name', (select s.name from ops.staff s where s.id = r.reviewed_by), 'reviewed_at', r.reviewed_at,
    'note', r.note, 'photos', ops.wh_recv_photo_list(r.do_id),
    'can_review', coalesce(r.status = 'pending' and ops.level_rank(ops.module_level(p_me, 'warehouse')) >= 3
                           and (r.counted_by is distinct from p_me.id or p_me.role = 'admin'), false))
  from ops.supplier_do d where d.id = r.do_id
$$;

-- p: {company, status: pending|done|all}（done = 近 30 天复核过的）
create or replace function public.ops_wh_recv_reviews(p jsonb default '{}'::jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  c text;
  st text := coalesce(nullif(p ->> 'status', ''), 'pending');
begin
  me := ops.require_level('warehouse', 'view');
  c := ops.wh_company(me, p ->> 'company');
  if st not in ('pending', 'done', 'all') then
    raise exception '未知的状态：%', st using errcode = '22023';
  end if;
  return coalesce((select jsonb_agg(ops.wh_recv_review_json(me, x) order by x.status = 'pending' desc, x.counted_at desc)
                   from (select * from ops.wh_recv_review r
                         where r.company = c
                           and case st when 'pending' then r.status = 'pending'
                                       when 'done' then r.status = 'approved' and r.reviewed_at >= ops.now() - interval '30 days'
                                       else r.status = 'pending' or r.reviewed_at >= ops.now() - interval '30 days' end
                         order by r.counted_at desc limit 200) x), '[]'::jsonb);
end $$;

-- 复核（仓库可审批；点货的人不能复核自己点的，管理员除外）。p: {do_id, note}
create or replace function public.ops_wh_recv_review_ok(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  r ops.wh_recv_review;
begin
  me := ops.require_level('warehouse', 'approve');
  select * into r from ops.wh_recv_review x
  where x.do_id = case when (p ->> 'do_id') ~ '^[0-9]{1,18}$' then (p ->> 'do_id')::bigint end for update;
  if r.do_id is null or not coalesce(ops.sees_company(me, r.company), false) then
    raise exception '找不到这笔复核。' using errcode = 'P0002';
  end if;
  if r.status <> 'pending' then
    raise exception '这笔已经复核过了。' using errcode = '22023';
  end if;
  if r.counted_by = me.id and me.role <> 'admin' then
    raise exception '点货的人不能复核自己点的货，请找另一位主管。' using errcode = '42501';
  end if;
  update ops.wh_recv_review set status = 'approved', reviewed_by = me.id, reviewed_at = now(),
                                note = left(trim(coalesce(p ->> 'note', '')), 500)
  where do_id = r.do_id returning * into r;
  update ops.wh_claim set staff_id = null where kind = 'receive' and ref = r.do_id;
  perform ops.log(me.id, 'review', 'wh_recv_review', r.do_id, jsonb_build_object('note', r.note));
  return ops.wh_recv_review_json(me, r);
end $$;

-- 待开进货单 / 点货纪录用：这几张 DO 哪些还在等复核 → {do_id: true}
create or replace function public.ops_wh_recv_review_pending(p_do_ids bigint[]) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
begin
  me := ops.require_staff();
  if coalesce(array_length(p_do_ids, 1), 0) > 500 then
    raise exception '一次最多 500 张。' using errcode = '22023';
  end if;
  return coalesce((select jsonb_object_agg(r.do_id::text, true) from ops.wh_recv_review r
                   where r.do_id = any (coalesce(p_do_ids, '{}')) and r.status = 'pending'
                     and coalesce(ops.sees_company(me, r.company), false)), '{}'::jsonb);
end $$;

-- ==================================================================== 4. ④ 拣货核对
-- 拣好了吗：已拣好，而且核对过（这间分店没开核对 = 拣好就算）
create or replace function ops.wh_pick_checked(k ops.wh_pick) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(k.status = 'done' and (k.checked_at is not null or not (ops.wh_gate_of(k.company)).pick_check), false)
$$;

-- 这个人有没有拣过这张单（开始、按已拣好、有扫码）→ 不能核对
create or replace function ops.wh_pick_touched(k ops.wh_pick, p_staff bigint) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(k.started_by = p_staff or k.done_by = p_staff
                  or exists (select 1 from ops.wh_pick_scan s where s.pick_id = k.id and s.created_by = p_staff and not s.voided), false)
$$;

-- 照抄 20261017b，多核对的栏位
create or replace function ops.wh_pick_json(k ops.wh_pick) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', k.id, 'company', k.company, 'doc_no', k.doc_no, 'status', k.status, 'short_note', k.short_note,
    'started_by', k.started_by, 'started_at', k.started_at,
    'started_by_name', (select st.name from ops.staff st where st.id = k.started_by),
    'done_by', k.done_by, 'done_at', k.done_at, 'done_by_name', (select st.name from ops.staff st where st.id = k.done_by),
    'cancelled_at', k.cancelled_at, 'cancel_reason', k.cancel_reason,
    'cancelled_by_name', (select st.name from ops.staff st where st.id = k.cancelled_by),
    'picked', (select coalesce(sum(least(l.picked, l.qty)), 0) from ops.wh_pick_line l where l.pick_id = k.id and not l.skip),
    'total', (select coalesce(sum(l.qty), 0) from ops.wh_pick_line l where l.pick_id = k.id and not l.skip),
    'lines_left', (select count(*) from ops.wh_pick_line l where l.pick_id = k.id and not l.skip and l.picked < l.qty),
    'checked_at', k.checked_at, 'checked_by_name', (select st.name from ops.staff st where st.id = k.checked_by),
    'check_note', k.check_note, 'check_fails', k.check_fails,
    'checked', ops.wh_pick_checked(k),
    'needs_check', k.status = 'done' and not ops.wh_pick_checked(k),
    'touched', ops.wh_pick_touched(k, (ops.current_staff()).id))
$$;

-- 核对（仓库可编辑、没拣过这张单的人）。p: {pick_id, lines: [{line_id, qty}], note}
-- 每一行（没略过的）都要填数到几件；跟已拣的数相同才算核对好。不符：记一次 check_fails、存这次数到的，回 {ok:false, diffs}（不报错）。
create or replace function public.ops_wh_pick_check(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
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
    raise exception '找不到这张拣货单。' using errcode = 'P0002';
  end if;
  if k.status <> 'done' then
    raise exception '还没按「已拣好」的单不能核对。' using errcode = '22023';
  end if;
  if k.checked_at is not null then
    raise exception '这张单已经核对过了（%）。', (select s.name from ops.staff s where s.id = k.checked_by) using errcode = '22023';
  end if;
  if ops.wh_pick_touched(k, me.id) then
    raise exception '拣货和核对要两个人：你有拣这张单，请找另一位同事核对。' using errcode = '42501';
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
end $$;

-- 重新打开（照抄 20261017b），核对一起清掉
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
  update ops.wh_pick set status = 'picking', done_by = null, done_at = null, checked_by = null, checked_at = null, check_note = ''
  where id = k.id returning * into k;
  update ops.wh_pick_line set checked = null where pick_id = k.id;
  perform ops.log(me.id, 'reopen', 'wh_pick', k.id, jsonb_build_object('doc_no', k.doc_no));
  return public.ops_wh_pick_get(k.company, k.doc_no);
end $$;

-- 排单页「已拣好」（照抄 20261019），多 checked
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
  if c not in ('HOMEWORKSSB', 'HOMEWORKSSOUTHERN', 'HOMEWORKSPUCHONG') or not coalesce(ops.sees_company(me, c), false) then
    raise exception '你没有这间分店的权限。' using errcode = '42501';
  end if;
  if coalesce(array_length(p_doc_nos, 1), 0) > 500 then
    raise exception '一次最多 500 张单。' using errcode = '22023';
  end if;
  return coalesce((
    select jsonb_object_agg(k.doc_no, jsonb_build_object(
      'status', k.status, 'done_at', k.done_at, 'checked', ops.wh_pick_checked(k),
      'picked', (select coalesce(sum(least(l.picked, l.qty)), 0) from ops.wh_pick_line l where l.pick_id = k.id and not l.skip),
      'total', (select coalesce(sum(l.qty), 0) from ops.wh_pick_line l where l.pick_id = k.id and not l.skip)))
    from ops.wh_pick k
    where k.company = c and k.status <> 'cancelled' and k.doc_no = any(coalesce(p_doc_nos, array[]::text[]))), '{}'::jsonb);
end $$;

-- 总览 / 首页（照抄 20261018），多 to_check（已拣好、等核对，近 7 天）
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
    'picking', (select count(*) from ops.wh_pick k where k.company = p_company and k.status = 'picking'),
    'to_check', case when (ops.wh_gate_of(p_company)).pick_check then
                  (select count(*) from ops.wh_pick k where k.company = p_company and k.status = 'done' and k.checked_at is null
                     and k.done_at >= ops.now() - interval '7 days') else 0 end)
$$;

-- 等核对的拣货单（今天页、复核页）
create or replace function public.ops_wh_pick_to_check(p_company text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  c text;
begin
  me := ops.require_level('warehouse', 'view');
  c := ops.wh_company(me, p_company);
  if not (ops.wh_gate_of(c)).pick_check then
    return '[]'::jsonb;
  end if;
  return coalesce((select jsonb_agg(ops.wh_pick_json(k) || jsonb_build_object(
                      'debtor_name', (select d.debtor_name from bi.delivery_doc d where d.company = k.company and d.doc_no = k.doc_no),
                      'claim', ops.wh_claim_json('pick_check', k.id)) order by k.done_at)
                   from ops.wh_pick k
                   where k.company = c and k.status = 'done' and k.checked_at is null
                     and k.done_at >= ops.now() - interval '7 days'), '[]'::jsonb);
end $$;

-- ==================================================================== 5. ③ 待上架、认领
-- 认领的人：{staff_id, name, at}（没人 = null）
create or replace function ops.wh_claim_json(p_kind text, p_ref bigint) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('staff_id', c.staff_id, 'name', s.name, 'at', c.claimed_at)
  from ops.wh_claim c join ops.staff s on s.id = c.staff_id
  where c.kind = p_kind and c.ref = p_ref and c.staff_id is not null
$$;

-- 这个功能上线日：之前的进货不列（多半早就上架了）
create or replace function ops.wh_put_from() returns timestamptz
language sql immutable set search_path = '' as $$ select timestamptz '2026-10-17 00:00:00+08' $$;

-- 要上架的进货（还没取消、没写不用上架、仓位有建货架的）与已上架几件
create or replace function ops.wh_put_rows(p_company text)
returns table (id bigint, item_code text, qty numeric, put numeric, to_loc text, created_at timestamptz, do_id bigint,
               outlet text, recv_wrong boolean, created_by bigint)
language sql stable security definer set search_path = '' as $$
  select m.id, m.item_code, m.qty, coalesce(pq.q, 0), m.to_loc, m.created_at, m.do_id, m.outlet, m.recv_wrong, m.created_by
  from ops.wh_move m
  left join lateral (select sum(l.delta) q from ops.wh_bin_log l
                     where l.ref_type = 'move' and l.ref_id = m.id and l.kind = 'putaway' and l.reversed_by is null) pq on true
  where m.company = p_company and m.kind = 'receive' and m.status <> 'cancelled' and m.put_skip is null
    and m.created_at >= ops.wh_put_from()
    and exists (select 1 from ops.wh_bin b where b.company = m.company and b.location = m.to_loc and b.active)
$$;

create or replace function ops.wh_put_json(p_me ops.staff, p_days int, p_company text, p_id bigint, p_item text, p_qty numeric,
  p_put numeric, p_loc text, p_at timestamptz, p_do bigint, p_outlet text, p_wrong boolean, p_by bigint) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', p_id, 'item_code', p_item, 'qty', p_qty, 'put', p_put, 'left', greatest(p_qty - p_put, 0),
    'location', p_loc, 'created_at', p_at, 'outlet', p_outlet, 'recv_wrong', p_wrong,
    'late', p_put < p_qty and p_at < ops.now() - make_interval(days => p_days),
    'description', (select i.description from bi.dim_item i where i.company = p_company and i.item_code = p_item),
    'uom', (select i.base_uom from bi.dim_item i where i.company = p_company and i.item_code = p_item),
    'do_no', case when ops.sees_supplier(p_me) then (select d.do_no from ops.supplier_do d where d.id = p_do) end,
    'by_name', (select s.name from ops.staff s where s.id = p_by),
    'claim', ops.wh_claim_json('putaway', p_id),
    -- 建议放哪：这个仓位已经放这个商品的货架（最多 3 个，多的在前）
    'bins', (select coalesce(jsonb_agg(jsonb_build_object('code', z.code, 'qty', z.qty) order by z.qty desc), '[]'::jsonb)
             from (select b.code, s.qty from ops.wh_bin_stock s join ops.wh_bin b on b.id = s.bin_id
                   where b.company = p_company and b.location = p_loc and b.active and s.item_code = p_item and s.qty > 0
                   order by s.qty desc limit 3) z))
$$;

-- p: {company, status: todo|done|all, q}；todo = 还没上完（逾期的在前、旧的在前）；done = 近 14 天上完的
create or replace function public.ops_wh_putaway_list(p jsonb default '{}'::jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  c text;
  st text := coalesce(nullif(p ->> 'status', ''), 'todo');
  v_q text := upper(trim(coalesce(p ->> 'q', '')));
  v_days int;
begin
  me := ops.require_level('warehouse', 'view');
  c := ops.wh_company(me, p ->> 'company');
  if st not in ('todo', 'done', 'all') then
    raise exception '未知的状态：%', st using errcode = '22023';
  end if;
  v_days := (ops.wh_gate_of(c)).putaway_days;
  return jsonb_build_object('days', v_days, 'rows', coalesce((
    select jsonb_agg(ops.wh_put_json(me, v_days, c, r.id, r.item_code, r.qty, r.put, r.to_loc, r.created_at, r.do_id, r.outlet,
                                         r.recv_wrong, r.created_by) order by (r.put < r.qty and r.created_at < ops.now() - make_interval(days => v_days)) desc,
                                                            r.created_at, r.id)
    from (select * from ops.wh_put_rows(c) x
          where case st when 'todo' then x.put < x.qty
                        when 'done' then x.put >= x.qty and x.created_at >= ops.now() - interval '14 days'
                        else x.put < x.qty or x.created_at >= ops.now() - interval '14 days' end
            and (v_q = '' or upper(x.item_code) like '%' || v_q || '%'
                 or exists (select 1 from bi.dim_item i where i.company = c and i.item_code = x.item_code
                              and upper(i.description) like '%' || v_q || '%'))
          order by x.created_at limit 300) r), '[]'::jsonb));
end $$;

-- 上架（仓库可编辑）。p: {move_id, bin, qty}；货架要在这笔进货的仓位；最多上到还没上的件数
create or replace function public.ops_wh_putaway(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  m ops.wh_move;
  b ops.wh_bin;
  v_q numeric;
  v_put numeric;
begin
  me := ops.require_level('warehouse', 'edit');
  select * into m from ops.wh_move x
  where x.id = case when (p ->> 'move_id') ~ '^[0-9]{1,18}$' then (p ->> 'move_id')::bigint end for update;
  if m.id is null or m.kind <> 'receive' or not coalesce(ops.sees_company(me, m.company), false) then
    raise exception '找不到这笔进货。' using errcode = 'P0002';
  end if;
  if m.status = 'cancelled' then
    raise exception '这笔进货已经取消了。' using errcode = '22023';
  end if;
  if coalesce(trim(p ->> 'qty'), '') !~ '^[0-9]{1,9}(\.[0-9]{1,2})?$' or trim(p ->> 'qty')::numeric <= 0 then
    raise exception '数量要是大于 0 的数字。' using errcode = '22023';
  end if;
  v_q := trim(p ->> 'qty')::numeric;
  select coalesce(sum(l.delta), 0) into v_put from ops.wh_bin_log l
  where l.ref_type = 'move' and l.ref_id = m.id and l.kind = 'putaway' and l.reversed_by is null;
  if v_q > m.qty - v_put then
    raise exception '这笔进货还没上架的只有 % 件。', trim_scale(m.qty - v_put)::text using errcode = '22023';
  end if;
  b := ops.wh_bin_find(m.company, p ->> 'bin', m.to_loc);
  perform ops.wh_bin_apply(me, b.id, m.item_code, v_q, 'putaway', 'move', m.id, '上架（进货）');
  insert into ops.wh_claim as w (kind, ref, company, staff_id, claimed_at) values ('putaway', m.id, m.company, me.id, now())
  on conflict (kind, ref) do update set staff_id = coalesce(w.staff_id, excluded.staff_id);
  perform ops.log(me.id, 'putaway', 'wh_move', m.id, jsonb_build_object('bin', b.code, 'qty', v_q));
  return (select ops.wh_put_json(me, (ops.wh_gate_of(m.company)).putaway_days, m.company, r.id, r.item_code, r.qty, r.put, r.to_loc,
                                 r.created_at, r.do_id, r.outlet, r.recv_wrong, r.created_by)
          from ops.wh_put_rows(m.company) r where r.id = m.id);
end $$;

-- 不用上架（例：直接送去分店、放在地上）。p: {move_id, reason}
create or replace function public.ops_wh_putaway_skip(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  m ops.wh_move;
  v_reason text := left(trim(coalesce(p ->> 'reason', '')), 300);
begin
  me := ops.require_level('warehouse', 'edit');
  select * into m from ops.wh_move x
  where x.id = case when (p ->> 'move_id') ~ '^[0-9]{1,18}$' then (p ->> 'move_id')::bigint end for update;
  if m.id is null or m.kind <> 'receive' or not coalesce(ops.sees_company(me, m.company), false) then
    raise exception '找不到这笔进货。' using errcode = 'P0002';
  end if;
  if v_reason = '' then
    raise exception '请写为什么不用上架（例：直接送去分店）。' using errcode = '22023';
  end if;
  update ops.wh_move set put_skip = v_reason, put_skip_by = me.id, put_skip_at = now() where id = m.id;
  perform ops.log(me.id, 'putaway_skip', 'wh_move', m.id, jsonb_build_object('reason', v_reason));
  return jsonb_build_object('ok', true);
end $$;

-- 认领 / 放掉。p: {kind: receive|putaway|pick_check, ref, release}
create or replace function public.ops_wh_claim(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
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
      raise exception '找不到这张等核对的拣货单。' using errcode = 'P0002';
    end if;
    if not v_rel and ops.wh_pick_touched(k, me.id) then
      raise exception '拣货和核对要两个人：你有拣这张单，请找另一位同事核对。' using errcode = '42501';
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
end $$;

-- ==================================================================== 6. ⑤⑥ 装车核对、装车照
-- 这趟排单的 DO（有 DO 号的站，照顺序、不重复）
create or replace function ops.dlv_load_docs(r bi.delivery_run) returns table (doc_no text, name text, seq int)
language sql stable security definer set search_path = '' as $$
  select x.doc_no, min(x.name), min(x.o)::int from (
    select nullif(trim(t.s ->> 'doc_no'), '') as doc_no, coalesce(t.s ->> 'name', '') as name, t.o
    from jsonb_array_elements(case when jsonb_typeof(r.stops) = 'array' then r.stops else '[]'::jsonb end) with ordinality t(s, o)) x
  where x.doc_no is not null
  group by x.doc_no
$$;

-- 可以装车 / 出车：送货可编辑，或这趟的司机
create or replace function ops.dlv_load_can(p_me ops.staff, r bi.delivery_run) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(ops.dlv_run_visible(p_me, r)
                  and (ops.level_rank(ops.module_level(p_me, 'delivery')) >= 2
                       or (r.driver_staff_id is not null and r.driver_staff_id = p_me.id)), false)
$$;

create or replace function ops.dlv_load_json(p_me ops.staff, r bi.delivery_run) returns jsonb
language sql stable security definer set search_path = '' as $$
  with g as (select ops.wh_gate_of(ops.dlv_company(r.store)) g),
  ld as (select * from ops.dlv_load l where l.run_id = r.id),
  docs as (
    select x.doc_no, x.name, x.seq, k.k, ld2.voided, ld2.loaded_by, ld2.loaded_at
    from ops.dlv_load_docs(r) x
    left join lateral (select k from ops.wh_pick k where k.company = ops.dlv_company(r.store) and k.doc_no = x.doc_no
                         and k.status <> 'cancelled' order by k.id desc limit 1) k on true
    left join ops.dlv_load_doc ld2 on ld2.run_id = r.id and ld2.doc_no = x.doc_no)
  select jsonb_build_object(
    'run_id', r.id, 'run_date', r.run_date, 'company', ops.dlv_company(r.store), 'driver_name', r.driver_name,
    'gate', (select (g.g).load_check from g),
    'status', coalesce((select ld.status from ld), 'none'),
    'photos', coalesce((select to_jsonb(ld.photos) from ld), '[]'::jsonb),
    'note', (select ld.note from ld), 'override_reason', (select ld.override_reason from ld),
    'started_by_name', (select s.name from ld join ops.staff s on s.id = ld.started_by),
    'departed_at', (select ld.departed_at from ld),
    'departed_by_name', (select s.name from ld join ops.staff s on s.id = ld.departed_by),
    'can_edit', ops.dlv_load_can(p_me, r),
    'can_override', ops.level_rank(ops.module_level(p_me, 'delivery')) >= 3,
    'docs', coalesce((select jsonb_agg(jsonb_build_object(
        'doc_no', d.doc_no, 'name', d.name, 'seq', d.seq,
        'pick', case when (d.k).id is not null then jsonb_build_object('status', (d.k).status, 'checked', ops.wh_pick_checked(d.k),
                       'short_note', (d.k).short_note) end,
        'ready', (d.k).id is not null and ops.wh_pick_checked(d.k),
        'loaded', d.loaded_by is not null and not d.voided,
        'loaded_at', case when not d.voided then d.loaded_at end,
        'loaded_by_name', case when not d.voided then (select s.name from ops.staff s where s.id = d.loaded_by) end)
      order by d.seq) from docs d), '[]'::jsonb))
$$;

create or replace function ops.dlv_load_run(p_me ops.staff, p_run text, p_lock boolean) returns bi.delivery_run
language plpgsql security definer set search_path = '' as $$
declare
  r bi.delivery_run;
begin
  select * into r from bi.delivery_run x where x.id = case when p_run ~ '^[0-9]{1,18}$' then p_run::bigint end;
  if r.id is null or not ops.dlv_run_visible(p_me, r) then
    raise exception '找不到这趟排单。' using errcode = 'P0002';
  end if;
  if p_lock then
    if not ops.dlv_load_can(p_me, r) then
      raise exception '只有送货「可编辑」或这趟的司机可以装车核对。' using errcode = '42501';
    end if;
    insert into ops.dlv_load (run_id, company, started_by) values (r.id, ops.dlv_company(r.store), p_me.id)
    on conflict (run_id) do nothing;
    perform 1 from ops.dlv_load l where l.run_id = r.id for update;
  end if;
  return r;
end $$;

create or replace function public.ops_dlv_load_get(p_run_id bigint) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  r bi.delivery_run;
begin
  me := ops.require_staff();
  r := ops.dlv_load_run(me, p_run_id::text, false);
  return ops.dlv_load_json(me, r);
end $$;

-- 扫 DO（或打 DO 号）装车。p: {run_id, code}。不在这趟 / 没拣好 / 没核对 → {ok:false, code, message}（不报错）
create or replace function public.ops_dlv_load_scan(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
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
    return jsonb_build_object('ok', false, 'code', 'not_picked', 'message', v_doc || ' 还没拣好，不能装车。');
  end if;
  if g.load_check and not ops.wh_pick_checked(k) then
    return jsonb_build_object('ok', false, 'code', 'not_checked', 'message', v_doc || ' 拣好了，还没有人核对，不能装车。');
  end if;
  insert into ops.dlv_load_doc (run_id, doc_no, loaded_by) values (r.id, v_doc, me.id)
  on conflict (run_id, doc_no) do update set voided = false, loaded_by = excluded.loaded_by, loaded_at = now();
  return jsonb_build_object('ok', true, 'doc_no', v_doc, 'short_note', nullif(k.short_note, ''), 'load', ops.dlv_load_json(me, r));
end $$;

-- 拿下来（扫错 / 没装）。p: {run_id, doc_no}
create or replace function public.ops_dlv_load_unscan(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  r bi.delivery_run;
begin
  me := ops.require_staff();
  r := ops.dlv_load_run(me, p ->> 'run_id', true);
  if (select l.status from ops.dlv_load l where l.run_id = r.id) = 'departed' then
    raise exception '这趟已经出车了。' using errcode = '22023';
  end if;
  update ops.dlv_load_doc set voided = true where run_id = r.id and doc_no = p ->> 'doc_no';
  return ops.dlv_load_json(me, r);
end $$;

-- 装车照。p: {run_id, path, remove}；路径 load/<公司>/<排单>/…，最多 10 张
create or replace function public.ops_dlv_load_photo(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  r bi.delivery_run;
  v_path text := trim(coalesce(p ->> 'path', ''));
begin
  me := ops.require_staff();
  r := ops.dlv_load_run(me, p ->> 'run_id', true);
  if v_path not like 'load/' || ops.dlv_company(r.store) || '/' || r.id || '/%' or v_path like '%..%' or length(v_path) > 300 then
    raise exception '照片路径不对，请重新拍一次。' using errcode = '22023';
  end if;
  if coalesce((p ->> 'remove')::boolean, false) then
    if (select l.status from ops.dlv_load l where l.run_id = r.id) = 'departed' then
      raise exception '已经出车了，装车照不能拿掉。' using errcode = '22023';
    end if;
    update ops.dlv_load set photos = array_remove(photos, v_path) where run_id = r.id;
  else
    if (select cardinality(l.photos) from ops.dlv_load l where l.run_id = r.id) >= 10 then
      raise exception '装车照最多 10 张。' using errcode = '22023';
    end if;
    update ops.dlv_load set photos = case when v_path = any (photos) then photos else photos || v_path end where run_id = r.id;
  end if;
  return ops.dlv_load_json(me, r);
end $$;

-- 出车。p: {run_id, note, override_reason}：每张 DO 都装了（而且拣好、核对过）、至少一张装车照；
-- 送货「可审批」可以写原因强制出车。这间分店没开装车核对 = 直接出车。
create or replace function public.ops_dlv_load_depart(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  r bi.delivery_run;
  g ops.wh_gate;
  j jsonb;
  v_miss text;
  v_reason text := left(trim(coalesce(p ->> 'override_reason', '')), 300);
begin
  me := ops.require_staff();
  r := ops.dlv_load_run(me, p ->> 'run_id', true);
  j := ops.dlv_load_json(me, r);
  if j ->> 'status' = 'departed' then
    raise exception '这趟已经出车了。' using errcode = '22023';
  end if;
  g := ops.wh_gate_of(ops.dlv_company(r.store));
  if g.load_check then
    select string_agg(d ->> 'doc_no', '、' order by (d ->> 'seq')::int) into v_miss
    from jsonb_array_elements(j -> 'docs') d where not ((d ->> 'loaded')::boolean and (d ->> 'ready')::boolean);
    if v_miss is not null then
      if v_reason = '' or ops.level_rank(ops.module_level(me, 'delivery')) < 3 then
        raise exception '还有 DO 没装车核对：%。都扫过才能出车%。', v_miss,
          case when ops.level_rank(ops.module_level(me, 'delivery')) >= 3 then '（或写原因强制出车）' else '' end
          using errcode = '22023';
      end if;
    else
      v_reason := '';
    end if;
    if jsonb_array_length(j -> 'photos') = 0 then
      raise exception '请先拍装车照再出车。' using errcode = '22023';
    end if;
  end if;
  update ops.dlv_load set status = 'departed', departed_by = me.id, departed_at = now(),
                          note = left(trim(coalesce(p ->> 'note', '')), 500), override_reason = v_reason
  where run_id = r.id;
  perform ops.log(me.id, 'depart', 'delivery_run', r.id, jsonb_build_object('override', v_reason, 'missing', v_miss));
  return ops.dlv_load_json(me, r);
end $$;

-- 几趟排单的装车状态（排单纪录卡片用）→ {run_id: {status, loaded, docs, photos}}
create or replace function public.ops_dlv_load_status(p_run_ids bigint[]) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
begin
  me := ops.require_staff();
  if coalesce(array_length(p_run_ids, 1), 0) > 200 then
    raise exception '一次最多 200 趟。' using errcode = '22023';
  end if;
  return coalesce((select jsonb_object_agg(r.id::text, jsonb_build_object(
                     'status', coalesce(l.status, 'none'),
                     'loaded', (select count(*) from ops.dlv_load_doc d where d.run_id = r.id and not d.voided),
                     'docs', (select count(*) from ops.dlv_load_docs(r)),
                     'photos', coalesce(cardinality(l.photos), 0)))
                   from bi.delivery_run r left join ops.dlv_load l on l.run_id = r.id
                   where r.id = any (coalesce(p_run_ids, '{}')) and ops.dlv_run_visible(me, r)), '{}'::jsonb);
end $$;

-- ==================================================================== 7. ⑦ 仓库「今天」
-- p: {company} → {today, me_id, items: [{kind, ref, title, sub, due, late, today, who, who_id, href, can}]}
-- kind：load 出车 / pick 拣货 / pick_check 核对 / receive 点货 / recv_review 点货复核 / putaway 上架；
-- 排序：逾期 → 今天 → 其他；同一级照种类（出车、拣货、核对、点货、复核、上架）与日期。
create or replace function public.ops_wh_today(p jsonb default '{}'::jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
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

  -- 拣货：今天 / 明天要送、还没拣好的
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

  -- 核对：已拣好、还没核对
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
end $$;

-- ==================================================================== 8. ⑧ 每人工作量（仓库可审批）
-- p: {company, from, to}（YYYY-MM-DD，马来西亚日期；预设近 7 天）→ {from, to, rows: [每人]}
--   recv_dos / recv_lines：点货几张 DO / 几个型号；recv_min：从认领到点完平均几分钟（有认领的才算）
--   picks / pick_lines / pick_min：拣好几张 / 几行 / 从开始到已拣好平均几分钟（超过 8 小时的不算进平均）
--   pick_fails：自己拣的单被核对出不符几次；undo：自己撤销的扫码几笔
--   checks：帮别人核对几张；put_n / put_qty：上架几笔 / 几件；loads：装车扫了几张 DO；departs：出车几趟；reviews：点货复核几张
create or replace function public.ops_wh_workload(p jsonb default '{}'::jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  c text;
  v_from date := coalesce(ops.wh_date_arg(p ->> 'from'), ops.today() - 6);
  v_to date := coalesce(ops.wh_date_arg(p ->> 'to'), ops.today());
  t0 timestamptz;
  t1 timestamptz;
begin
  me := ops.require_level('warehouse', 'approve');
  c := ops.wh_company(me, p ->> 'company');
  if v_to < v_from or v_to - v_from > 366 then
    raise exception '日期范围不对（最多一年）。' using errcode = '22023';
  end if;
  t0 := ops.kl_at(v_from, time '00:00');
  t1 := ops.kl_at(v_to + 1, time '00:00');
  return jsonb_build_object('company', c, 'from', v_from, 'to', v_to, 'rows', coalesce((
    with ev as (
      select d.arrived_by sid, 'recv' k, 1 n, jsonb_array_length(coalesce(d.receipt -> 'items', '[]'::jsonb)) q,
             extract(epoch from d.arrived_at - cl.claimed_at) / 60 mins
      from ops.supplier_do d left join ops.wh_claim cl on cl.kind = 'receive' and cl.ref = d.id and cl.claimed_at < d.arrived_at
      where d.company = c and d.status = 'arrived' and d.arrived_at >= t0 and d.arrived_at < t1
      union all
      select k.done_by, 'pick', 1, (select count(*) from ops.wh_pick_line l where l.pick_id = k.id and not l.skip),
             case when k.done_at - k.started_at < interval '8 hours' then extract(epoch from k.done_at - k.started_at) / 60 end
      from ops.wh_pick k where k.company = c and k.status = 'done' and k.done_at >= t0 and k.done_at < t1
      union all
      select k.done_by, 'fail', k.check_fails, 0, null
      from ops.wh_pick k where k.company = c and k.check_fails > 0 and k.done_by is not null
        and coalesce(k.done_at, k.started_at) >= t0 and coalesce(k.done_at, k.started_at) < t1
      union all
      select k.checked_by, 'check', 1, 0, null
      from ops.wh_pick k where k.company = c and k.checked_at >= t0 and k.checked_at < t1
      union all
      select s.voided_by, 'undo', 1, 0, null
      from ops.wh_pick_scan s join ops.wh_pick k on k.id = s.pick_id
      where k.company = c and s.voided and s.voided_at >= t0 and s.voided_at < t1
      union all
      select l.created_by, 'put', 1, l.delta, null
      from ops.wh_bin_log l where l.company = c and l.kind = 'putaway' and l.ref_type = 'move' and l.reversed_by is null
        and l.created_at >= t0 and l.created_at < t1
      union all
      select d.loaded_by, 'load', 1, 0, null
      from ops.dlv_load_doc d join ops.dlv_load l on l.run_id = d.run_id
      where l.company = c and not d.voided and d.loaded_at >= t0 and d.loaded_at < t1
      union all
      select l.departed_by, 'depart', 1, 0, null
      from ops.dlv_load l where l.company = c and l.status = 'departed' and l.departed_at >= t0 and l.departed_at < t1
      union all
      select r.reviewed_by, 'review', 1, 0, null
      from ops.wh_recv_review r where r.company = c and r.status = 'approved' and r.reviewed_at >= t0 and r.reviewed_at < t1),
    agg as (
      select ev.sid,
             sum(ev.n) filter (where ev.k = 'recv') recv_dos, sum(ev.q) filter (where ev.k = 'recv') recv_lines,
             round(avg(ev.mins) filter (where ev.k = 'recv')) recv_min,
             sum(ev.n) filter (where ev.k = 'pick') picks, sum(ev.q) filter (where ev.k = 'pick') pick_lines,
             round(avg(ev.mins) filter (where ev.k = 'pick')) pick_min,
             sum(ev.n) filter (where ev.k = 'fail') pick_fails, sum(ev.n) filter (where ev.k = 'undo') undo,
             sum(ev.n) filter (where ev.k = 'check') checks,
             sum(ev.n) filter (where ev.k = 'put') put_n, sum(ev.q) filter (where ev.k = 'put') put_qty,
             sum(ev.n) filter (where ev.k = 'load') loads, sum(ev.n) filter (where ev.k = 'depart') departs,
             sum(ev.n) filter (where ev.k = 'review') reviews,
             sum(ev.n) filter (where ev.k in ('recv', 'pick', 'check', 'put', 'load', 'depart', 'review')) total
      from ev where ev.sid is not null group by ev.sid)
    select jsonb_agg(jsonb_build_object(
             'staff_id', a.sid, 'name', s.name, 'department', s.department,
             'recv_dos', coalesce(a.recv_dos, 0), 'recv_lines', coalesce(a.recv_lines, 0), 'recv_min', a.recv_min,
             'picks', coalesce(a.picks, 0), 'pick_lines', coalesce(a.pick_lines, 0), 'pick_min', a.pick_min,
             'pick_fails', coalesce(a.pick_fails, 0), 'undo', coalesce(a.undo, 0), 'checks', coalesce(a.checks, 0),
             'put_n', coalesce(a.put_n, 0), 'put_qty', coalesce(a.put_qty, 0), 'loads', coalesce(a.loads, 0),
             'departs', coalesce(a.departs, 0), 'reviews', coalesce(a.reviews, 0))
           order by a.total desc nulls last, s.name)
    from agg a join ops.staff s on s.id = a.sid), '[]'::jsonb));
end $$;

-- ==================================================================== 9. 首页（照抄 20261019），多 pick_check / recv_review / putaway_late
create or replace function public.ops_wh_home() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
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
    -- 等我核对：别人拣好、还没核对（我没拣过）
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
end $$;

-- ==================================================================== 10. 权限
revoke all on function ops.wh_gate_of(text), ops.wh_recv_key(text, text), ops.supplier_do_gate(), ops.wh_move_gate(),
  ops.wh_recv_photo_list(bigint), ops.wh_recv_review_json(ops.staff, ops.wh_recv_review), ops.wh_pick_checked(ops.wh_pick),
  ops.wh_pick_touched(ops.wh_pick, bigint), ops.wh_claim_json(text, bigint), ops.wh_put_from(), ops.wh_put_rows(text),
  ops.wh_put_json(ops.staff, int, text, bigint, text, numeric, numeric, text, timestamptz, bigint, text, boolean, bigint),
  ops.dlv_load_docs(bi.delivery_run), ops.dlv_load_can(ops.staff, bi.delivery_run), ops.dlv_load_json(ops.staff, bi.delivery_run),
  ops.dlv_load_run(ops.staff, text, boolean)
  from public, anon, authenticated;
revoke all on function public.ops_wh_gate_get(text), public.ops_wh_gate_set(jsonb), public.ops_wh_recv_photos(bigint),
  public.ops_wh_recv_photo_add(jsonb), public.ops_wh_recv_photo_del(bigint), public.ops_wh_recv_reviews(jsonb),
  public.ops_wh_recv_review_ok(jsonb), public.ops_wh_recv_review_pending(bigint[]), public.ops_wh_pick_check(jsonb),
  public.ops_wh_pick_to_check(text), public.ops_wh_putaway_list(jsonb), public.ops_wh_putaway(jsonb),
  public.ops_wh_putaway_skip(jsonb), public.ops_wh_claim(jsonb), public.ops_dlv_load_get(bigint), public.ops_dlv_load_scan(jsonb),
  public.ops_dlv_load_unscan(jsonb), public.ops_dlv_load_photo(jsonb), public.ops_dlv_load_depart(jsonb),
  public.ops_dlv_load_status(bigint[]), public.ops_wh_today(jsonb), public.ops_wh_workload(jsonb)
  from public, anon;
grant execute on function public.ops_wh_gate_get(text), public.ops_wh_gate_set(jsonb), public.ops_wh_recv_photos(bigint),
  public.ops_wh_recv_photo_add(jsonb), public.ops_wh_recv_photo_del(bigint), public.ops_wh_recv_reviews(jsonb),
  public.ops_wh_recv_review_ok(jsonb), public.ops_wh_recv_review_pending(bigint[]), public.ops_wh_pick_check(jsonb),
  public.ops_wh_pick_to_check(text), public.ops_wh_putaway_list(jsonb), public.ops_wh_putaway(jsonb),
  public.ops_wh_putaway_skip(jsonb), public.ops_wh_claim(jsonb), public.ops_dlv_load_get(bigint), public.ops_dlv_load_scan(jsonb),
  public.ops_dlv_load_unscan(jsonb), public.ops_dlv_load_photo(jsonb), public.ops_dlv_load_depart(jsonb),
  public.ops_dlv_load_status(bigint[]), public.ops_wh_today(jsonb), public.ops_wh_workload(jsonb)
  to authenticated;
