-- HomeWorks 营运系统 — 登入纪录、查货补充、多行搬动、搬动筛选（2026-10-15，使用者看了员工做的 WMS 后选的）
-- 套用到 Supabase 的 migration 名称：ops_wh_extras（整个档约 21 KB，可以一次套用；要分段就照「-- ====」切两段依序套：
--   ops_wh_extras_1 = 开头 + §1–3（约 12.5 KB）、ops_wh_extras_2 = §4–6（约 8.4 KB；§6 的权限要在最后）。
--   要在 20261017_ops_wh_bins.sql 之后（用到 ops.wh_bin_find / ops.wh_bin_apply）。可以重复套用；
--   不含会被 Supabase MCP 挡下的指令（没有移除资料或拿掉函数的语句）。
--
-- 使用者 2026-10-15：
--   1. 完整登入纪录（放在「员工与权限」）：每次按登入记一笔 login；之后每次打开系统（每个浏览器分页一次）记一笔 open，
--      同一人 10 分钟内只记一次（刚登入也算）。只有「员工与权限」能看（= 管理员，与 ops_staff_admin_list 同规则）。
--   2. 查货补充：AutoCount 最近卖出（不给金额）、最近进货（厂家与 PO 号只给看得到厂家的人）、按分店合计
--      （ops.outlet 的仓位设定：总部自己的；JB / Batu / Puchong 寄存在总部还没送的 = 分店仓位 + PRE 仓位 > 0 的部分，
--       还欠的 = PRE 仓位的负数；有数字才列）。
--   3. 多行搬动：种类 / 从 / 到 / 备注 / 照片共用，一行一个商品 + 数量 + 可选从哪个货架拿 / 放到哪个货架；
--      全部检查过才存（一行错整批不存、回传第几行）。每行照 ops_wh_move_save 的规则（直接呼叫它）；
--      货架变动挂在这笔搬动（ref_type = move），搬动取消时 20261017_ops_wh_bins 的触发器会冲回。
--   4. 搬动纪录筛选：日期区间、种类、登记人、商品 / 品名 / 单号；有日期区间时最多 2,000 笔（没有 = 最近 300 笔）。
--      导出 Excel 在前端做（同一份清单）。
-- 对 AutoCount 仍然只读：这里只读 bi.*。

-- ==================================================================== 1. 登入纪录
create table if not exists ops.login_log (
  id bigint generated always as identity primary key,
  staff_id bigint not null references ops.staff(id),
  kind text not null check (kind in ('login', 'open')),          -- login = 按登入；open = 已经登入、打开系统
  at timestamptz not null default now(),
  ua text not null default '' check (length(ua) <= 300)          -- 浏览器的 User-Agent（判断手机 / 电脑 / 浏览器）
);
create index if not exists login_log_staff_idx on ops.login_log (staff_id, at desc);
create index if not exists login_log_at_idx on ops.login_log (at);
alter table ops.login_log enable row level security;
-- 不建 policy：只能走下面的 security definer 函数

-- ==================================================================== 2. 登入纪录函数
-- 记一笔（任何在职员工；只记自己）。open：同一人 10 分钟内有任何一笔（登入或打开）就不记；
-- login：1 分钟内已经有登入就不记（连按两次）。回传 {recorded}
create or replace function public.ops_login_mark(p_kind text, p_ua text default '') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  k text := lower(trim(coalesce(p_kind, '')));
  t timestamptz := ops.now();
begin
  me := ops.require_staff();
  if k not in ('login', 'open') then
    raise exception '未知的登入纪录种类：%', p_kind using errcode = '22023';
  end if;
  -- 同一人同时送两笔（两个分页）时排队，不会两笔都记；no key update 不挡别的表指向这个员工的外键检查
  perform 1 from ops.staff s where s.id = me.id for no key update;
  if exists (select 1 from ops.login_log l
             where l.staff_id = me.id
               and l.at > t - case when k = 'open' then interval '10 minutes' else interval '1 minute' end
               and l.at <= t + interval '1 minute'
               and (k = 'open' or l.kind = 'login')) then
    return jsonb_build_object('recorded', false);
  end if;
  insert into ops.login_log (staff_id, kind, at, ua) values (me.id, k, t, left(trim(coalesce(p_ua, '')), 300));
  return jsonb_build_object('recorded', true);
end $$;

-- 管理员看登入纪录。p: {staff_id?}
--   没有 staff_id：每人一列 = 姓名、部门、分店、最后登入、最后打开、今天几次（马来西亚日期）、近 30 天几次、总共几次（登入 + 打开）
--   有 staff_id：这个人最近 100 笔（时间、种类、User-Agent）
create or replace function public.ops_login_log(p jsonb default '{}'::jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  sid bigint := case when coalesce(p->>'staff_id', '') ~ '^[0-9]{1,18}$' then (p->>'staff_id')::bigint end;
  td date := ops.today();
  t timestamptz := ops.now();
  s ops.staff;
begin
  me := ops.require_level('admin', 'approve');
  if coalesce(p->>'staff_id', '') <> '' and sid is null then
    raise exception '员工编号不对。' using errcode = '22023';
  end if;
  if sid is not null then
    select * into s from ops.staff x where x.id = sid;
    if s.id is null then
      raise exception '找不到这位员工。' using errcode = 'P0002';
    end if;
    return jsonb_build_object(
      'staff', jsonb_build_object('id', s.id, 'name', s.name, 'department', s.department, 'branch', s.branch, 'active', s.active),
      'rows', (select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'at', x.at, 'kind', x.kind, 'ua', x.ua)
                                         order by x.at desc, x.id desc), '[]'::jsonb)
               from (select * from ops.login_log l where l.staff_id = sid order by l.at desc, l.id desc limit 100) x));
  end if;
  return jsonb_build_object(
    'today', td,
    'staff', (select coalesce(jsonb_agg(jsonb_build_object(
                'id', st.id, 'name', st.name, 'department', st.department,
                'department_name', (select d.name from ops.department d where d.code = st.department),
                'branch', st.branch, 'role', st.role, 'active', st.active,
                'left', coalesce(st.last_day < td, false),
                'last_login', g.last_login, 'last_open', g.last_open, 'last_at', g.last_at,
                'today', g.n_today, 'd30', g.n30, 'total', g.n_all)
              order by st.active desc, g.last_at desc nulls last, st.name), '[]'::jsonb)
              from ops.staff st
              left join lateral (
                select max(l.at) filter (where l.kind = 'login') as last_login,
                       max(l.at) filter (where l.kind = 'open') as last_open,
                       max(l.at) as last_at,
                       count(*) filter (where (l.at at time zone 'Asia/Kuala_Lumpur')::date = td) as n_today,
                       count(*) filter (where l.at > t - interval '30 days') as n30,
                       count(*) as n_all
                from ops.login_log l where l.staff_id = st.id) g on true));
end $$;

-- ==================================================================== 3. 查货补充
-- p: {company, item (商品代号 / 纸箱条码)}；仓库「只看」以上。
--   sales：AutoCount 最近卖出 20 张单（同一张单同一商品几行合起来）：日期、单号、单据种类、数量、单位、顾客名；**不给金额**。
--          CN（退货 / 贷项）数量一律显示成负数。
--   receipts：最近进货 10 笔（bi.fact_po_receipt，同一张进货单同一 PO 同一仓位合起来）：日期、单号、来源、数量、仓位（PO 行的仓位）；
--          厂家（PO 厂家名称栏）与 PO 号只给看得到厂家的人（ops.sees_supplier），其他人是 null。
--   outlets：按分店合计（AutoCount 库存，不含还没输入的搬动）。每间分店：
--          mode = own（总部账套的总部、JB 账套整本）：total = 这些仓位合计；
--          mode = consign（总部账套里的 JB / Batu / Puchong 仓位）：own = 分店仓位（JB）、pre = PRE 仓位（PRE (JB)），
--          consigned = 寄存在总部、还没送去分店 = greatest(own + pre, 0)；owed = 还欠分店（还没到总部）= greatest(−pre, 0)。
--          总部 / 整本属于分店的一定列；寄存的分店有数字（不是 0）才列。locations = 每个仓位的数量。
create or replace function public.ops_wh_item_more(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  c text;
  code text;
  sup boolean;
begin
  me := ops.require_level('warehouse', 'view');
  c := ops.wh_company(me, p->>'company');
  code := ops.wh_resolve(c, p->>'item');
  if code is null then
    raise exception '找不到这个商品，请重新扫或打商品代号。' using errcode = 'P0002';
  end if;
  sup := coalesce(ops.sees_supplier(me), false);
  return jsonb_build_object(
    'company', c, 'item_code', code, 'sees_supplier', sup,
    'sales', (select coalesce(jsonb_agg(jsonb_build_object(
                'doc_date', x.doc_date, 'doc_no', x.doc_no, 'doc_type', x.doc_type, 'qty', x.qty, 'uom', x.uom,
                'customer', x.customer) order by x.doc_date desc, x.doc_no desc), '[]'::jsonb)
              from (select f.doc_date, f.doc_no, f.doc_type, max(f.uom) as uom, max(f.debtor_name) as customer,
                           case when upper(coalesce(f.doc_type, '')) = 'CN' then -abs(sum(f.qty)) else sum(f.qty) end as qty
                    from bi.fact_sales f
                    where f.company = c and f.item_code = code
                    group by f.doc_date, f.doc_no, f.doc_type
                    order by f.doc_date desc nulls last, f.doc_no desc
                    limit 20) x),
    'receipts', (select coalesce(jsonb_agg(jsonb_build_object(
                   'rcv_date', x.rcv_date, 'doc_no', x.doc_no, 'src', x.src, 'qty', x.qty, 'location', x.loc,
                   'po_no', case when sup then x.po_no end, 'supplier', case when sup then x.supplier end)
                   order by x.rcv_date desc, x.doc_no desc), '[]'::jsonb)
                 from (select r.rcv_date, r.doc_no, r.src, r.po_no, l.location as loc, max(l.creditor_name) as supplier,
                              sum(r.qty) as qty
                       from bi.fact_po_receipt r
                       left join lateral (
                         select pl.location, pl.creditor_name from bi.fact_po_line pl
                         where pl.company = r.company and pl.po_no = r.po_no and pl.item_code = r.item_code
                         order by coalesce(pl.dtl_key = r.dtl_key, false) desc, pl.dtl_key
                         limit 1) l on true
                       where r.company = c and r.item_code = code
                       group by r.rcv_date, r.doc_no, r.src, r.po_no, l.location
                       order by r.rcv_date desc nulls last, r.doc_no desc
                       limit 10) x),
    'outlets', (
      with st as (
        select f.location as loc, sum(f.qty) as qty
        from bi.fact_stock f where f.company = c and f.item_code = code and f.location is not null
        group by f.location),
      g as (select ops.outlet_of(c, st.loc) as oc, st.loc, st.qty, coalesce(wl.sort, 50) as srt
            from st left join ops.wh_location wl on wl.company = c and wl.code = st.loc),
      o as (
        select ot.code, ot.sort, ot.name, ot.short_name,
               case when ot.company = c and (c <> 'HOMEWORKSSB' or ot.code = 'HQ') then 'own' else 'consign' end as mode,
               sum(g.qty) as total,
               coalesce(sum(g.qty) filter (where g.loc = upper(ot.own_location)), 0) as own_q,
               coalesce(sum(g.qty) filter (where g.loc = upper(ot.pre_location)), 0) as pre_q,
               bool_or(g.qty <> 0) as nonzero,
               jsonb_agg(jsonb_build_object('location', g.loc, 'qty', g.qty) order by g.srt, g.loc) as locs
        from g join ops.outlet ot on ot.code = g.oc
        group by ot.code, ot.sort, ot.name, ot.short_name, ot.company)
      select coalesce(jsonb_agg(jsonb_build_object(
               'code', o.code, 'name', o.name, 'short_name', o.short_name, 'mode', o.mode, 'total', o.total,
               'own', case when o.mode = 'consign' then o.own_q end,
               'pre', case when o.mode = 'consign' then o.pre_q end,
               'consigned', case when o.mode = 'consign' then greatest(o.own_q + o.pre_q, 0) end,
               'owed', case when o.mode = 'consign' then greatest(-o.pre_q, 0) end,
               'locations', o.locs) order by o.sort, o.code), '[]'::jsonb)
      from o where o.mode = 'own' or o.nonzero));
end $$;

-- ==================================================================== 4. 多行搬动
-- p: {company, kind, from_loc, to_loc, note, photo, lines: [{item_code, qty, from_bin, to_bin}]}（仓库「可编辑」）
--   种类 / 从 / 到 / 备注 / 照片每行共用；每行照 ops_wh_move_save 的规则存一笔搬动（它自己检查商品、仓位、原因、照片）。
--   from_bin：从「从」那个仓位的哪个货架拿（货架上不够就挡）；to_bin：放到「到」那个仓位的哪个货架。
--   货架变动 kind = move、ref_type = move、ref_id = 这笔搬动：搬动取消时触发器 ops.wh_move_bin_reverse 冲回。
--   一行错 → 整批不存，回传 {ok: false, row: 第几行（1 起算）, message}；全对 → {ok: true, n, moves: [搬动…]}。
create or replace function public.ops_wh_move_batch(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  c text;
  v_from text := nullif(trim(coalesce(p->>'from_loc', '')), '');
  v_to text := nullif(trim(coalesce(p->>'to_loc', '')), '');
  v_note text := left(coalesce(nullif(trim(coalesce(p->>'note', '')), ''), '搬动'), 300);
  ln jsonb;
  i int := 0;
  m jsonb;
  b ops.wh_bin;
  q numeric;
  ids bigint[] := '{}';
  out jsonb := '[]'::jsonb;
begin
  me := ops.require_level('warehouse', 'edit');
  c := ops.wh_company(me, p->>'company');
  if jsonb_typeof(p->'lines') is distinct from 'array' or jsonb_array_length(p->'lines') = 0 then
    raise exception '请至少加一个商品。' using errcode = '22023';
  end if;
  if jsonb_array_length(p->'lines') > 200 then
    raise exception '一次最多 200 个商品，请分开登记。' using errcode = '22023';
  end if;
  begin
    for ln in select x from jsonb_array_elements(p->'lines') x loop
      i := i + 1;
      if jsonb_typeof(ln) is distinct from 'object' then
        raise exception '资料格式不对，请重新整理网页再试。' using errcode = '22023';
      end if;
      if coalesce(trim(ln->>'qty'), '') !~ '^[0-9]{1,9}(\.[0-9]{1,2})?$' then
        raise exception '数量要是大于 0 的数字（最多两位小数）。' using errcode = '22023';
      end if;
      m := public.ops_wh_move_save(jsonb_build_object(
             'company', c, 'item_code', ln->>'item_code', 'qty', trim(ln->>'qty'), 'kind', p->>'kind',
             'from_loc', v_from, 'to_loc', v_to, 'note', p->>'note', 'photo', p->>'photo'));
      q := (m->>'qty')::numeric;
      if nullif(trim(coalesce(ln->>'from_bin', '')), '') is not null then
        if m->>'from_loc' is null then
          raise exception '这种搬动没有「从哪个仓位」，不能选从哪个货架拿。' using errcode = '22023';
        end if;
        b := ops.wh_bin_find(c, ln->>'from_bin', m->>'from_loc');
        perform ops.wh_bin_apply(me, b.id, m->>'item_code', -q, 'move', 'move', (m->>'id')::bigint, v_note);
      end if;
      if nullif(trim(coalesce(ln->>'to_bin', '')), '') is not null then
        if m->>'to_loc' is null then
          raise exception '这种搬动没有「到哪个仓位」，不能选放到哪个货架。' using errcode = '22023';
        end if;
        b := ops.wh_bin_find(c, ln->>'to_bin', m->>'to_loc');
        perform ops.wh_bin_apply(me, b.id, m->>'item_code', q, 'move', 'move', (m->>'id')::bigint, v_note);
      end if;
      ids := ids || (m->>'id')::bigint;
      out := out || jsonb_build_array(m);
    end loop;
  exception when others then
    -- 这个区块里已经存的搬动、货架变动全部回滚（PL/pgSQL 的例外区块 = savepoint）
    return jsonb_build_object('ok', false, 'row', i, 'message', sqlerrm);
  end;
  perform ops.log(me.id, 'batch', 'wh_move', null, jsonb_build_object('company', c, 'ids', to_jsonb(ids)));
  return jsonb_build_object('ok', true, 'n', i, 'moves', out);
end $$;

-- ==================================================================== 5. 搬动纪录筛选
-- 日期参数（YYYY-MM-DD，空 = null）；格式不对给中文讯息
create or replace function ops.wh_date_arg(p text) returns date
language plpgsql immutable set search_path = '' as $$
declare
  v text := trim(coalesce(p, ''));
begin
  if v = '' then
    return null;
  end if;
  if v !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    raise exception '日期「%」不对，格式要是 YYYY-MM-DD。', p using errcode = '22023';
  end if;
  return v::date;
exception when invalid_datetime_format or datetime_field_overflow then
  raise exception '日期「%」不对，格式要是 YYYY-MM-DD。', p using errcode = '22023';
end $$;

-- 搬动清单（照抄 20261015_ops_po_sop.sql），p 多：
--   move_kind：只列这一种（transfer / defect / … / receive）；created_by：登记人（员工编号）；
--   from / to：登记日期区间（马来西亚日期，含头尾）；q 也找品名。
--   没有日期区间 = 最近 300 笔；有日期区间（from 或 to 有一个就算）= 最多 2,000 笔。
create or replace function public.ops_wh_moves(p jsonb default '{}'::jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  c text;
  st text := coalesce(nullif(p->>'status', ''), 'pending');
  q text := upper(trim(coalesce(p->>'q', '')));
  mk text := nullif(trim(coalesce(p->>'move_kind', '')), '');
  who bigint;
  d1 date := ops.wh_date_arg(p->>'from');
  d2 date := ops.wh_date_arg(p->>'to');
  lim int;
begin
  me := ops.require_level('warehouse', 'view');
  c := ops.wh_company(me, p->>'company');
  if coalesce(p->>'created_by', '') <> '' then
    if p->>'created_by' !~ '^[0-9]{1,18}$' then
      raise exception '登记人不对，请重新选。' using errcode = '22023';
    end if;
    who := (p->>'created_by')::bigint;
  end if;
  if d1 is not null and d2 is not null and d1 > d2 then
    raise exception '开始日期不能晚于结束日期。' using errcode = '22023';
  end if;
  lim := case when d1 is not null or d2 is not null then 2000 else 300 end;
  return (select coalesce(jsonb_agg(ops.wh_move_json(m) order by m.created_at desc, m.id desc), '[]'::jsonb) from (
    select * from ops.wh_move m
    where m.company = c and (st = 'all' or m.status = st)
      and (not coalesce((p->>'mine')::boolean, false) or m.created_by = me.id)
      and case coalesce(p->>'kind', '') when 'receive' then m.kind = 'receive' when 'move' then m.kind <> 'receive' else true end
      and (mk is null or m.kind = mk)
      and (who is null or m.created_by = who)
      and (d1 is null or (m.created_at at time zone 'Asia/Kuala_Lumpur')::date >= d1)
      and (d2 is null or (m.created_at at time zone 'Asia/Kuala_Lumpur')::date <= d2)
      and (q = '' or upper(m.item_code) like '%' || q || '%' or upper(m.ac_doc) like '%' || q || '%'
           or exists (select 1 from bi.dim_item i where i.company = m.company and i.item_code = m.item_code
                      and upper(coalesce(i.description, '')) like '%' || q || '%'))
    order by m.created_at desc, m.id desc limit lim) m);
end $$;

-- 登记过搬动的人（筛选「登记人」用）：这间分店的搬动（含进货）每个登记人几笔
create or replace function public.ops_wh_move_people(p_company text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  c text;
begin
  me := ops.require_level('warehouse', 'view');
  c := ops.wh_company(me, p_company);
  return (select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'n', x.n) order by s.name, s.id), '[]'::jsonb)
          from (select m.created_by, count(*) as n from ops.wh_move m where m.company = c group by m.created_by) x
          join ops.staff s on s.id = x.created_by);
end $$;

-- ==================================================================== 6. 权限
revoke all on table ops.login_log from public, anon, authenticated;
revoke all on function ops.wh_date_arg(text) from public, anon, authenticated;
do $$
declare
  f text;
begin
  foreach f in array array['ops_login_mark(text,text)', 'ops_login_log(jsonb)', 'ops_wh_item_more(jsonb)',
                           'ops_wh_move_batch(jsonb)', 'ops_wh_moves(jsonb)', 'ops_wh_move_people(text)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
