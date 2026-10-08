-- 送货安装模块（第一版，2026-10-08）：把 BI 顾客资料页里的「送货排单 + 司机签收拍照」搬进营运系统，
-- 使用者要「跟员工多部门功能连在一起，不要分成两个地方」。
--
-- 资料**不搬家**：DO、地址、备注、排单、签收照片都还在 BI 那边的 bi.delivery_* 表（SERVER 的 quote_push.py 每 15 分钟
-- 只读推 AutoCount 的 DO 进来），这里只加一层 public.ops_dlv_* 函数，改用营运系统的员工名单与模块权限：
--   只看（销售 / 门市）  = 查 DO 与地址、看排单纪录与签收进度
--   可编辑（送货、仓库）  = 排单、改这张 DO 的地址 / 给司机的备注、存坐标、传 WhatsApp 给司机
--   可审批（主管、管理层）= 设定出发点、管理外包司机
-- 分店：HOMEWORKSSB = 门市 HQ、HOMEWORKSSOUTHERN = JB；只属一间分店的员工只看得到自己分店的 DO 与排单。
-- 司机 = 送货部门、有手机号的在职员工（在「员工与权限」管理）+ 外包司机（bi.delivery_driver，这里的「设定」分页管理）。
-- 员工司机登入营运系统就在「我的送货」签收；外包司机照旧用 WhatsApp 里的连结（#/driver?t=…，不用登入，3 天有效）。
-- 司机签收页沿用 BI 的 anon 函数 bi_driver_run / bi_driver_pod 与 Storage 私有 bucket delivery-pod（migration delivery_pod）。
--
-- 对 AutoCount 仍只读。可以重复套用（create or replace / if not exists）。
-- 模块上线开关（ops.module.ready）放在 20261008c_ops_delivery_ready.sql，等前端部署好才套。
-- 正式环境分三次套：ops_delivery（第一版）+ ops_delivery_review_fixes（多人审查后的修正：照片路径与连结代码同样只给可编辑 / 司机、
-- 查 DO 不回内部备注与金额、备注与坐标移动记 audit_log、首页计数不重复算同一站）+ ops_delivery_fixes2（排单的站不存 / 不回传内部备注 note）。
-- 合起来 = 这个档。另外 BI 的 bi_driver_run 加回传每站的 geo（migration driver_run_geo，BI 那边留底在 docs/bi_web/delivery.sql）。

-- ------------------------------------------------------------ 资料：排单记下哪一位员工是司机
alter table bi.delivery_run add column if not exists driver_staff_id bigint;
create index if not exists delivery_run_driver_staff_idx on bi.delivery_run (driver_staff_id, run_date);

-- ------------------------------------------------------------ 小工具
-- 分店代号 ↔ 门市代号（bi.delivery_run.store 与出发点 depot 用 HQ / JB）
create or replace function ops.dlv_store(p_company text) returns text
language sql immutable set search_path = '' as $$
  select case p_company when 'HOMEWORKSSB' then 'HQ' when 'HOMEWORKSSOUTHERN' then 'JB' end
$$;
create or replace function ops.dlv_company(p_store text) returns text
language sql immutable set search_path = '' as $$
  select case p_store when 'HQ' then 'HOMEWORKSSB' when 'JB' then 'HOMEWORKSSOUTHERN' end
$$;

-- 这次要看哪间分店：没指定就用自己的（ALL 的人预设总部）；看不到就挡
create or replace function ops.dlv_check_company(p_me ops.staff, p_company text) returns text
language plpgsql stable set search_path = '' as $$
declare
  c text := coalesce(nullif(p_company, ''), case when p_me.branch = 'ALL' then 'HOMEWORKSSB' else p_me.branch end);
begin
  if c not in ('HOMEWORKSSB', 'HOMEWORKSSOUTHERN') or not ops.sees_company(p_me, c) then
    raise exception '你没有这间分店的送货权限。' using errcode = '42501';
  end if;
  return c;
end $$;

-- 这张排单我看得到吗：有送货模块权限且同分店，或我就是这趟的司机
create or replace function ops.dlv_run_visible(p_me ops.staff, r bi.delivery_run) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (r.driver_staff_id is not null and r.driver_staff_id = p_me.id)
    or (ops.level_rank(ops.module_level(p_me, 'delivery')) >= 1
        and ops.sees_company(p_me, ops.dlv_company(r.store))),
    false)
$$;

-- 看得到连结代码（以及路径里含代码的照片）：可编辑的人、这趟的司机；连结过期后（代码不能再签收）只看的人也看得到照片。
-- 照片路径是 <代码>/…（BI 的 bi_driver_pod 规定），只看的人拿到路径就等于拿到代码、可以假签收，所以路径要跟代码一起挡。
create or replace function ops.dlv_full_access(p_me ops.staff, r bi.delivery_run) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(
    ops.level_rank(ops.module_level(p_me, 'delivery')) >= 2
    or (r.driver_staff_id is not null and r.driver_staff_id = p_me.id)
    or r.token_expires < now(),
    false)
$$;

-- 一趟排单 → 前端要的 json（每站最新一笔签收；连结代码只给可编辑的人与这趟的司机；照片路径照 dlv_full_access）
create or replace function ops.dlv_run_json(p_me ops.staff, r bi.delivery_run) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', r.id, 'run_date', r.run_date, 'store', r.store, 'company', ops.dlv_company(r.store),
    'driver_name', r.driver_name, 'driver_phone', r.driver_phone, 'driver_staff_id', r.driver_staff_id,
    -- BI 旧版存的站带顾客资料的内部备注 note：不回传
    'stops', coalesce((select jsonb_agg(s - 'note' order by o) from jsonb_array_elements(r.stops) with ordinality t(s, o)), '[]'::jsonb),
    'created_by', r.created_by, 'created_at', r.created_at,
    'has_link', r.token is not null,
    'link_valid', r.token is not null and coalesce(r.token_expires, now()) >= now(),
    'token', case when coalesce(ops.level_rank(ops.module_level(p_me, 'delivery')) >= 2
                                or r.driver_staff_id = p_me.id, false) then r.token end,
    'pods', coalesce((
      select jsonb_agg(jsonb_build_object('stop_key', p.stop_key, 'doc_no', p.doc_no, 'status', p.status, 'note', p.note,
                                          'photos', case when ops.dlv_full_access(p_me, r) then to_jsonb(p.photos) else '[]'::jsonb end,
                                          'photo_count', cardinality(p.photos), 'created_at', p.created_at) order by p.created_at)
        from (select distinct on (x.stop_key) x.* from bi.delivery_pod x
               where x.run_id = r.id order by x.stop_key, x.created_at desc) p), '[]'::jsonb))
$$;

-- 可以选的司机：送货部门、有手机号的在职员工（kind = staff）+ 外包司机（kind = ext）。只列看得到的分店。
create or replace function ops.dlv_drivers(p_me ops.staff) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(d order by d ->> 'kind' desc, d ->> 'name'), '[]'::jsonb) from (
    select jsonb_build_object('kind', 'staff', 'id', s.id, 'name', s.name, 'phone', bi.customer_phone(s.phone),
                              'store', ops.dlv_store(s.branch)) d
      from ops.staff s
     where s.active and s.department = 'delivery' and bi.customer_phone(s.phone) is not null
       and (s.branch = 'ALL' or ops.sees_company(p_me, s.branch))
    union all
    select jsonb_build_object('kind', 'ext', 'id', x.id, 'name', x.name, 'phone', x.phone, 'store', x.store)
      from bi.delivery_driver x
     where x.active and (x.store is null or ops.sees_company(p_me, ops.dlv_company(x.store)))
  ) q
$$;

-- ------------------------------------------------------------ 设定、权限
create or replace function public.ops_dlv_meta() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  v_depot jsonb := coalesce((select s.depot from bi.customer_settings s where s.id = 1), '{}'::jsonb);
begin
  me := ops.require_level('delivery', 'view');
  return jsonb_build_object(
    'level', ops.module_level(me, 'delivery'),
    'me_id', me.id,
    'companies', (select jsonb_agg(c order by c) from unnest(array['HOMEWORKSSB', 'HOMEWORKSSOUTHERN']) c
                  where ops.sees_company(me, c)),
    'depot', (select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) from jsonb_each(v_depot) e
              where ops.sees_company(me, ops.dlv_company(e.key))),
    'drivers', ops.dlv_drivers(me),
    'synced', (select max(d.synced_at) from bi.delivery_doc d where ops.sees_company(me, d.company)));
end $$;

-- ------------------------------------------------------------ 查 DO
-- 回传时拿掉排单用不到的栏位：顾客资料的内部备注（note）、DO 金额、业务员、客户代号（送货 / 仓库员工不该看到 BI 的财务数字）
-- 一键排单：整串单号（可只打数字尾码），每个单号回一笔；找不到 found = false。最多 100 张。
create or replace function public.ops_dlv_lookup_many(p_company text, p_queries text[]) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  c text;
  v_out jsonb;
begin
  me := ops.require_level('delivery', 'view');
  c := ops.dlv_check_company(me, p_company);
  if coalesce(array_length(p_queries, 1), 0) > 100 then
    raise exception '一次最多 100 张单。';
  end if;
  with q as (
    select distinct on (v) v, ord
      from (select upper(regexp_replace(x, '\s', '', 'g')) as v, o as ord
              from unnest(p_queries) with ordinality as t(x, o)) s
     where length(v) >= 3
     order by v, ord
  ), m as (
    select q.v, f.*,
           row_number() over (partition by q.v order by (upper(f.doc_no) = q.v) desc, f.doc_date desc, f.doc_no desc) as rn
      from q
      join bi.delivery_doc_full f on f.company = c and (upper(f.doc_no) = q.v or upper(f.doc_no) like '%' || q.v)
  )
  select coalesce(jsonb_agg(
           jsonb_build_object('query', q.v, 'found', m.doc_no is not null)
           || coalesce(to_jsonb(m) - 'v' - 'rn' - 'note' - 'amount' - 'sales_agent' - 'debtor_code' - 'do_address', '{}'::jsonb)
           order by q.ord), '[]'::jsonb)
    into v_out
    from q left join m on m.v = q.v and m.rn = 1;
  return v_out;
end $$;

-- 单号（最多 10 张尾码相同的）或顾客电话（回顾客资料的地址）
create or replace function public.ops_dlv_lookup(p_company text, p_query text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  c text;
  v_q text := upper(regexp_replace(coalesce(p_query, ''), '\s', '', 'g'));
  v_phone text;
  v_out jsonb;
begin
  me := ops.require_level('delivery', 'view');
  c := ops.dlv_check_company(me, p_company);
  if length(v_q) < 3 then
    raise exception '请输入 DO 单号（或顾客电话）。';
  end if;
  if v_q ~ '^\+?[0-9-]+$' and length(regexp_replace(v_q, '\D', '', 'g')) >= 9 then
    v_phone := bi.customer_key(p_query);
  end if;
  if v_phone is not null then
    select coalesce(jsonb_agg(jsonb_build_object(
             'doc_no', null, 'company', c, 'cancelled', false, 'member_id', v_phone, 'name', p.name,
             'address', p.address, 'address_source', case when p.address is not null then 'profile' end,
             'lat', coalesce(g.lat, p.lat), 'lng', coalesce(g.lng, p.lng))), '[]'::jsonb)
      into v_out
      from (select v_phone as m) x
      left join bi.customer_profile p on p.member_id = x.m
      left join bi.geo_cache g on g.addr = bi.addr_key(p.address);
    return v_out;
  end if;
  select coalesce(jsonb_agg(to_jsonb(f) - 'note' - 'amount' - 'sales_agent' - 'debtor_code' - 'do_address' order by f.doc_date desc, f.doc_no desc), '[]'::jsonb) into v_out
    from (select * from bi.delivery_doc_full f
           where f.company = c and (upper(f.doc_no) = v_q or upper(f.doc_no) like '%' || v_q)
           order by f.doc_date desc, f.doc_no desc limit 10) f;
  return v_out;
end $$;

-- 某天没取消的 DO（预设今天，马来西亚时间）
create or replace function public.ops_dlv_docs(p_company text, p_date date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  c text;
begin
  me := ops.require_level('delivery', 'view');
  c := ops.dlv_check_company(me, p_company);
  return (select coalesce(jsonb_agg(to_jsonb(f) - 'note' - 'amount' - 'sales_agent' - 'debtor_code' - 'do_address' order by f.doc_no), '[]'::jsonb)
            from bi.delivery_doc_full f
           where f.company = c and not f.cancelled
             and f.doc_date = coalesce(p_date, (now() at time zone 'Asia/Kuala_Lumpur')::date));
end $$;

-- ------------------------------------------------------------ 改地址、备注、坐标（可编辑）
-- 只改这张 DO 的送货地址（同步不会盖掉）；空白 = 还原成 DO / 顾客资料的地址
create or replace function public.ops_dlv_doc_set_address(p_company text, p_doc_no text, p_address text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  c text;
  v text := nullif(trim(coalesce(p_address, '')), '');
begin
  me := ops.require_level('delivery', 'edit');
  c := ops.dlv_check_company(me, p_company);
  if length(coalesce(v, '')) > 300 then
    raise exception '地址太长（最多 300 字）。';
  end if;
  update bi.delivery_doc d set address_override = v, override_by = me.email, override_at = now()
   where d.company = c and d.doc_no = p_doc_no;
  if not found then
    raise exception '找不到 DO %。', p_doc_no;
  end if;
  perform ops.log(me.id, 'dlv_address', 'delivery_doc', null, jsonb_build_object('company', c, 'doc_no', p_doc_no, 'address', v));
  return jsonb_build_object('doc_no', p_doc_no, 'address', v);
end $$;

-- 给司机的备注（时间、地点、下货位置…）；存在那张 DO 上，同步不会盖掉
create or replace function public.ops_dlv_doc_set_note(p_company text, p_doc_no text, p_note text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  c text;
  v text := nullif(trim(coalesce(p_note, '')), '');
begin
  me := ops.require_level('delivery', 'edit');
  c := ops.dlv_check_company(me, p_company);
  if length(coalesce(v, '')) > 500 then
    raise exception '备注太长（最多 500 字）。';
  end if;
  update bi.delivery_doc d set delivery_note = v, note_by = me.email, note_at = now()
   where d.company = c and d.doc_no = p_doc_no;
  if not found then
    raise exception '找不到 DO %。', p_doc_no;
  end if;
  perform ops.log(me.id, 'dlv_note', 'delivery_doc', null, jsonb_build_object('company', c, 'doc_no', p_doc_no, 'note', v));
  return jsonb_build_object('doc_no', p_doc_no, 'delivery_note', v);
end $$;

-- 用电话加的站（没有 DO）或顾客资料本来没地址：存进顾客资料（BI 顾客资料页看得到，修改纪录会记是谁改的）
create or replace function public.ops_dlv_customer_set_address(p_member text, p_address text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  v_key text := bi.customer_key(p_member);
  v_addr text := nullif(trim(coalesce(p_address, '')), '');
begin
  me := ops.require_level('delivery', 'edit');
  if v_key is null or v_key like 'A:%' and not ops.sees_company(me, split_part(v_key, ':', 2)) then
    raise exception '看不出顾客的电话号码。';
  end if;
  if length(coalesce(v_addr, '')) > 300 then
    raise exception '地址太长（最多 300 字）。';
  end if;
  insert into bi.customer_profile as p (member_id, address, created_by, updated_by)
  values (v_key, v_addr, me.email, me.email)
  on conflict (member_id) do update
     set address = excluded.address,
         lat = case when p.address is distinct from excluded.address then null else p.lat end,
         lng = case when p.address is distinct from excluded.address then null else p.lng end,
         geo_query = case when p.address is distinct from excluded.address then null else p.geo_query end,
         updated_at = now(), updated_by = me.email;
  return jsonb_build_object('member_id', v_key, 'address', v_addr);
end $$;

-- 地址 → 坐标（OpenStreetMap 找到的，或员工贴的 Google Maps 坐标）；同一个地址下次不用再找
create or replace function public.ops_dlv_geo_set(p_address text, p_lat numeric, p_lng numeric) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  v_key text := bi.addr_key(p_address);
  v_old_lat numeric;
  v_old_lng numeric;
begin
  me := ops.require_level('delivery', 'edit');
  if v_key is null or p_lat is null or p_lng is null or p_lat not between -90 and 90 or p_lng not between -180 and 180 then
    raise exception '地址或坐标不对。';
  end if;
  select g.lat, g.lng into v_old_lat, v_old_lng from bi.geo_cache g where g.addr = v_key;
  if v_old_lat is not null and (v_old_lat, v_old_lng) is distinct from (p_lat, p_lng) then
    -- 已有的点被移动才记（第一次自动找到的坐标太多，不记）；geo_cache 两间分店共用
    perform ops.log(me.id, 'dlv_geo', 'geo_cache', null, jsonb_build_object('address', p_address, 'from', jsonb_build_array(v_old_lat, v_old_lng),
                                                                         'to', jsonb_build_array(p_lat, p_lng)));
  end if;
  insert into bi.geo_cache as g (addr, address, lat, lng, updated_by)
  values (v_key, left(trim(p_address), 300), p_lat, p_lng, me.email)
  on conflict (addr) do update set lat = excluded.lat, lng = excluded.lng, updated_at = now(), updated_by = excluded.updated_by;
  return jsonb_build_object('address', p_address, 'lat', p_lat, 'lng', p_lng);
end $$;

-- ------------------------------------------------------------ 排单
-- p: company, driver_kind ('staff' / 'ext' / 空), driver_id, stops (jsonb 阵列), token（前端产生，WhatsApp 讯息里已带连结）
create or replace function public.ops_dlv_run_save(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  c text;
  v_stops jsonb := p -> 'stops';
  v_token text := nullif(p ->> 'token', '');
  v_kind text := nullif(p ->> 'driver_kind', '');
  v_driver bigint := nullif(p ->> 'driver_id', '')::bigint;
  v_name text;
  v_phone text;
  v_staff bigint;
  v_id bigint;
begin
  me := ops.require_level('delivery', 'edit');
  c := ops.dlv_check_company(me, p ->> 'company');
  if jsonb_typeof(v_stops) is distinct from 'array' or jsonb_array_length(v_stops) = 0 then
    raise exception '还没有要送的单。';
  end if;
  if jsonb_array_length(v_stops) > 100 then
    raise exception '一趟最多 100 站。';
  end if;
  if exists (select 1 from jsonb_array_elements(v_stops) s where nullif(s ->> 'key', '') is null) then
    raise exception '排单资料不完整，请重新整理页面再排一次。';
  end if;
  if v_token is null or length(v_token) < 20 or v_token !~ '^[A-Za-z0-9_-]+$' then
    raise exception '连结代码不对，请重新整理页面再按一次。';
  end if;
  v_stops := (select jsonb_agg(s - 'note' order by o) from jsonb_array_elements(v_stops) with ordinality t(s, o));   -- 不存内部备注
  if v_kind = 'staff' then
    select s.name, bi.customer_phone(s.phone), s.id into v_name, v_phone, v_staff
      from ops.staff s
     where s.id = v_driver and s.active and s.department = 'delivery' and bi.customer_phone(s.phone) is not null
       and (s.branch = 'ALL' or s.branch = c);
    if v_staff is null then
      raise exception '这位司机不在「送货安装」部门、没有手机号码、已停用，或不属于这间分店。';
    end if;
  elsif v_kind = 'ext' then
    select x.name, x.phone into v_name, v_phone
      from bi.delivery_driver x
     where x.id = v_driver and x.active and (x.store is null or x.store = ops.dlv_store(c));
    if v_name is null then
      raise exception '找不到这位司机，或他不属于这间分店。';
    end if;
  elsif v_kind is not null then
    raise exception '未知的司机种类：%', v_kind;
  end if;
  insert into bi.delivery_run (store, driver_name, driver_phone, driver_staff_id, stops, created_by, token, token_expires)
  values (ops.dlv_store(c), v_name, v_phone, v_staff, v_stops, me.email, v_token, now() + interval '3 days')
  returning id into v_id;
  perform ops.log(me.id, 'dlv_run', 'delivery_run', v_id,
                  jsonb_build_object('company', c, 'stops', jsonb_array_length(v_stops), 'driver', v_name));
  return jsonb_build_object('id', v_id);
end $$;

-- 排单纪录（近 N 天，最多 50 趟）与每站签收进度
create or replace function public.ops_dlv_runs(p_company text, p_days int) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  c text;
begin
  me := ops.require_level('delivery', 'view');
  c := ops.dlv_check_company(me, p_company);
  return (select coalesce(jsonb_agg(ops.dlv_run_json(me, r) order by r.created_at desc), '[]'::jsonb)
            from (select * from bi.delivery_run r
                   where r.store = ops.dlv_store(c)
                     and r.run_date >= (now() at time zone 'Asia/Kuala_Lumpur')::date
                                       - greatest(1, least(coalesce(p_days, 14), 90))
                   order by r.created_at desc limit 50) r);
end $$;

-- 我的送货：我是司机、连结还有效的排单（员工司机登入就能签收，不用点 WhatsApp 连结）。不需要送货模块权限。
create or replace function public.ops_dlv_my_runs() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
begin
  me := ops.require_staff();
  return (select coalesce(jsonb_agg(ops.dlv_run_json(me, r) order by r.created_at desc), '[]'::jsonb)
            from bi.delivery_run r
           where r.driver_staff_id = me.id and r.token is not null and coalesce(r.token_expires, now()) >= now());
end $$;

-- 这一站（同一天、同一门市）有没有人签收过：同一批单常被重复排（按了两次 WhatsApp / 复制），任何一趟签了就算
create or replace function ops.dlv_stop_signed(p_store text, p_date date, p_key text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from bi.delivery_pod p join bi.delivery_run r2 on r2.id = p.run_id
                  where r2.store = p_store and r2.run_date = p_date and p.stop_key = p_key)
$$;

-- 首页：我还没签收的站（我是司机、连结有效）、今天这间分店还没签收的站（可编辑的人）；重复排的同一站只算一次
create or replace function public.ops_dlv_home() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
  v_today date := (now() at time zone 'Asia/Kuala_Lumpur')::date;
begin
  me := ops.require_staff();
  return jsonb_build_object(
    'my_stops_left', (
      select count(distinct (r.store, r.run_date, s ->> 'key'))
        from bi.delivery_run r, jsonb_array_elements(r.stops) s
       where r.driver_staff_id = me.id and r.token is not null and coalesce(r.token_expires, now()) >= now()
         and not ops.dlv_stop_signed(r.store, r.run_date, s ->> 'key')),
    'stops_open_today', case when ops.level_rank(ops.module_level(me, 'delivery')) >= 2 then (
      select count(distinct (r.store, s ->> 'key'))
        from bi.delivery_run r, jsonb_array_elements(r.stops) s
       where r.run_date = v_today and r.token is not null and ops.sees_company(me, ops.dlv_company(r.store))
         and not ops.dlv_stop_signed(r.store, r.run_date, s ->> 'key'))
    end);
end $$;

-- ------------------------------------------------------------ 设定（可审批）
create or replace function public.ops_dlv_set_depot(p_company text, p_address text, p_lat numeric, p_lng numeric) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  c text;
begin
  me := ops.require_level('delivery', 'approve');
  c := ops.dlv_check_company(me, p_company);
  if p_lat is null or p_lng is null or p_lat not between -90 and 90 or p_lng not between -180 and 180 then
    raise exception '出发点要有坐标。';
  end if;
  update bi.customer_settings s
     set depot = coalesce(s.depot, '{}'::jsonb)
                 || jsonb_build_object(ops.dlv_store(c), jsonb_build_object('address', left(trim(coalesce(p_address, '')), 300),
                                                                         'lat', p_lat, 'lng', p_lng)),
         updated_at = now(), updated_by = me.email
   where s.id = 1;
  perform ops.log(me.id, 'dlv_depot', 'customer_settings', 1, jsonb_build_object('company', c, 'address', p_address));
  return jsonb_build_object('company', c, 'address', p_address, 'lat', p_lat, 'lng', p_lng);
end $$;

-- 外包司机（不是员工的）。p: id（空 = 新增）、name、phone、company、active
create or replace function public.ops_dlv_driver_save(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  c text;
  v_id bigint := nullif(p ->> 'id', '')::bigint;
  v_name text := nullif(trim(coalesce(p ->> 'name', '')), '');
  v_phone text := bi.customer_phone(p ->> 'phone');
  v_old text;
begin
  me := ops.require_level('delivery', 'approve');
  c := ops.dlv_check_company(me, p ->> 'company');
  if v_name is null or v_phone is null then
    raise exception '司机要有名字和完整手机号码。';
  end if;
  if v_id is null then
    insert into bi.delivery_driver (name, phone, store, active, updated_by)
    values (v_name, v_phone, ops.dlv_store(c), coalesce((p ->> 'active')::boolean, true), me.email)
    returning id into v_id;
  else
    select x.store into v_old from bi.delivery_driver x where x.id = v_id;
    if not found then
      raise exception '找不到司机 #%。', v_id;
    end if;
    if v_old is not null and not ops.sees_company(me, ops.dlv_company(v_old)) then
      raise exception '你没有这间分店的送货权限。' using errcode = '42501';
    end if;
    update bi.delivery_driver
       set name = v_name, phone = v_phone, store = ops.dlv_store(c), active = coalesce((p ->> 'active')::boolean, true),
           updated_at = now(), updated_by = me.email
     where id = v_id;
  end if;
  perform ops.log(me.id, 'dlv_driver', 'delivery_driver', v_id, jsonb_build_object('name', v_name, 'company', c));
  return (select jsonb_build_object('kind', 'ext', 'id', x.id, 'name', x.name, 'phone', x.phone, 'store', x.store, 'active', x.active)
            from bi.delivery_driver x where x.id = v_id);
end $$;

-- ------------------------------------------------------------ 签收照片：营运系统的员工也看得到
-- （BI 的 policy「delivery-pod staff read」只认 BI 名单；Storage 的多条 policy 是「任一条过就可以」）
create or replace function public.ops_dlv_photo_ok(p_token text) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff := ops.current_staff();
  r bi.delivery_run;
begin
  if me.id is null or length(coalesce(p_token, '')) < 20 then
    return false;
  end if;
  select * into r from bi.delivery_run x where x.token = p_token;
  if r.id is null then
    return false;
  end if;
  return ops.dlv_run_visible(me, r) and ops.dlv_full_access(me, r);
end $$;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
                                             and policyname = 'delivery-pod ops read') then
    create policy "delivery-pod ops read" on storage.objects for select to authenticated
      using (bucket_id = 'delivery-pod' and public.ops_dlv_photo_ok((storage.foldername(name))[1]));
  end if;
end $$;

-- ------------------------------------------------------------ 权限
do $$
declare f text;
begin
  foreach f in array array[
    'ops_dlv_meta()', 'ops_dlv_lookup_many(text,text[])', 'ops_dlv_lookup(text,text)', 'ops_dlv_docs(text,date)',
    'ops_dlv_doc_set_address(text,text,text)', 'ops_dlv_doc_set_note(text,text,text)',
    'ops_dlv_customer_set_address(text,text)', 'ops_dlv_geo_set(text,numeric,numeric)', 'ops_dlv_run_save(jsonb)',
    'ops_dlv_runs(text,int)', 'ops_dlv_my_runs()', 'ops_dlv_home()', 'ops_dlv_set_depot(text,text,numeric,numeric)',
    'ops_dlv_driver_save(jsonb)', 'ops_dlv_photo_ok(text)'
  ] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
revoke all on function ops.dlv_full_access(ops.staff, bi.delivery_run), ops.dlv_stop_signed(text, date, text),
  ops.dlv_store(text), ops.dlv_company(text), ops.dlv_check_company(ops.staff, text),
  ops.dlv_run_visible(ops.staff, bi.delivery_run), ops.dlv_run_json(ops.staff, bi.delivery_run), ops.dlv_drivers(ops.staff)
  from public, anon, authenticated;
