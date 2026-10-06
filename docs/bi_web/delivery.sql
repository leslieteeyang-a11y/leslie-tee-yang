-- 送货排单（migration `delivery_planner`，2026-10-06）
-- 使用者要：输入单号看到顾客资料与送货地址 → 今天要送的单排成最快路线 → 一键 WhatsApp 整张清单给司机。
-- 使用者选的：单据 = Delivery Order（DO）；地址只用顾客资料（bi.customer_profile.address）；免费排路线（前端用 OpenStreetMap
-- 找坐标、直线距离算最短顺序，坐标存回顾客资料下次不用再找）；WhatsApp 传清单，司机不用登入。
-- DO 从 SERVER / 分行电脑的 scripts/quote_push.py 每 15 分钟只读推上来（AutoCount 不写入）。
-- 这个档不含删除类语句（Supabase 连接器遇到会卡在确认）：DO 用 upsert，取消的 DO 以 cancelled 标记。

alter table bi.customer_profile
  add column lat numeric check (lat between -90 and 90),
  add column lng numeric check (lng between -180 and 180),
  add column geo_query text,            -- 找坐标时用的地址；地址改了就要重新找
  add column geo_at timestamptz;

alter table bi.customer_settings
  add column depot jsonb not null default '{}'::jsonb;   -- {"HQ": {"address":..,"lat":..,"lng":..}, "JB": {...}} 出发点

create table bi.delivery_doc (
  company text not null,
  doc_no text not null,
  doc_date date not null,
  debtor_code text not null,
  debtor_name text,
  sales_agent text,
  amount numeric not null default 0,
  items text,
  cancelled boolean not null default false,
  synced_at timestamptz not null default now(),
  primary key (company, doc_no)
);
create index on bi.delivery_doc (upper(doc_no));

create table bi.delivery_driver (
  id bigint generated always as identity primary key,
  name text not null check (length(name) <= 60),
  phone text not null check (phone ~ '^[0-9]{9,13}$'),
  store text check (store in ('HQ', 'JB')),
  active boolean not null default true,
  updated_at timestamptz not null default now(),
  updated_by text
);

create table bi.delivery_run (
  id bigint generated always as identity primary key,
  run_date date not null default ((now() at time zone 'Asia/Kuala_Lumpur')::date),
  store text,
  driver_name text,
  driver_phone text,
  stops jsonb not null,
  created_at timestamptz not null default now(),
  created_by text
);

alter table bi.delivery_doc enable row level security;
alter table bi.delivery_driver enable row level security;
alter table bi.delivery_run enable row level security;
revoke all on bi.delivery_doc, bi.delivery_driver, bi.delivery_run from anon, authenticated;

-- ── SERVER / 分行推 DO（service_role） ──
create function public.bi_delivery_doc_upsert(p_company text, p_docs jsonb)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_n int;
begin
  if p_company not in ('HOMEWORKSSB', 'HOMEWORKSSOUTHERN') then
    raise exception '公司代码 % 不认得（只收 HOMEWORKSSB / HOMEWORKSSOUTHERN）', p_company;
  end if;
  insert into bi.delivery_doc as d (company, doc_no, doc_date, debtor_code, debtor_name, sales_agent, amount, items, cancelled)
  select p_company, x.doc_no, x.doc_date, x.debtor_code, x.debtor_name, nullif(trim(x.sales_agent), ''),
         coalesce(x.amount, 0), left(x.items, 500), coalesce(x.cancelled, false)
    from jsonb_to_recordset(coalesce(p_docs, '[]'::jsonb))
         as x(doc_no text, doc_date date, debtor_code text, debtor_name text, sales_agent text, amount numeric,
              items text, cancelled boolean)
   where x.doc_no is not null and x.doc_date is not null and x.debtor_code is not null
  on conflict (company, doc_no) do update
     set doc_date = excluded.doc_date, debtor_code = excluded.debtor_code, debtor_name = excluded.debtor_name,
         sales_agent = excluded.sales_agent, amount = excluded.amount, items = excluded.items,
         cancelled = excluded.cancelled, synced_at = now();
  get diagnostics v_n = row_count;
  return jsonb_build_object('company', p_company, 'delivery_orders', v_n);
end;
$$;
revoke all on function public.bi_delivery_doc_upsert(text, jsonb) from public, anon, authenticated;
grant execute on function public.bi_delivery_doc_upsert(text, jsonb) to service_role;

-- ── 查单号（或电话）→ 顾客资料与送货地址 ──
create function public.bi_delivery_lookup(p_query text)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_q text := upper(regexp_replace(coalesce(p_query, ''), '\s', '', 'g'));
  v_company text := (select public.bi_company());
  v_phone text;
  v_out jsonb;
begin
  perform bi.customer_require(array['owner', 'manager', 'sales']);
  if length(v_q) < 3 then
    raise exception '请输入 DO 单号（或顾客电话）';
  end if;
  -- 纯数字且像电话 → 当电话查顾客
  if v_q ~ '^\+?[0-9-]+$' and length(regexp_replace(v_q, '\D', '', 'g')) >= 9 then
    v_phone := bi.customer_key(p_query);
  end if;
  with docs as (
    select d.*, c.name as customer_name
      from bi.delivery_doc d
      left join bi.dim_customer c on c.company = d.company and c.debtor_code = d.debtor_code
     where v_phone is null
       and (upper(d.doc_no) = v_q or upper(d.doc_no) like '%' || v_q)
       and (v_company is null or d.company = v_company)
     order by d.doc_date desc, d.doc_no desc
     limit 10
  ), keyed as (
    select d.*, bi.customer_key(coalesce(bi.customer_phone(d.debtor_name), bi.customer_phone(d.customer_name),
                case when coalesce(d.customer_name, '') !~* '^\s*CASH' then 'A:' || d.company || ':' || d.debtor_code end)) as member_id
      from docs d
  ), rows as (
    select k.doc_no, k.company, k.doc_date, k.debtor_code, k.debtor_name, k.sales_agent, round(k.amount, 2) as amount,
           k.items, k.cancelled, k.member_id
      from keyed k
    union all
    select null, null, null, null, null, null, null, null, false, v_phone where v_phone is not null
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'doc_no', r.doc_no, 'company', r.company, 'doc_date', r.doc_date, 'debtor_code', r.debtor_code,
           'debtor_name', r.debtor_name, 'sales_agent', r.sales_agent, 'amount', r.amount, 'items', r.items,
           'cancelled', r.cancelled, 'member_id', r.member_id,
           'name', p.name, 'address', p.address, 'lat', p.lat, 'lng', p.lng, 'geo_query', p.geo_query, 'note', p.note)), '[]'::jsonb)
    into v_out
    from rows r
    left join bi.customer_profile p on p.member_id = r.member_id;
  return v_out;
end;
$$;

-- ── 送货地址 / 坐标存回顾客资料 ──
create function public.bi_customer_set_address(p_member text, p_address text)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_key text := bi.customer_key(p_member);
  v_who text := coalesce(auth.jwt() ->> 'email', 'unknown');
  v_addr text := nullif(trim(p_address), '');
begin
  perform bi.customer_require(array['owner', 'manager', 'sales']);
  if v_key is null then
    raise exception '看不出电话号码';
  end if;
  if length(coalesce(v_addr, '')) > 300 then
    raise exception '地址太长';
  end if;
  insert into bi.customer_profile as p (member_id, address, created_by, updated_by)
  values (v_key, v_addr, v_who, v_who)
  on conflict (member_id) do update
     set address = excluded.address,
         lat = case when p.address is distinct from excluded.address then null else p.lat end,
         lng = case when p.address is distinct from excluded.address then null else p.lng end,
         geo_query = case when p.address is distinct from excluded.address then null else p.geo_query end,
         updated_at = now(), updated_by = v_who;
  return (select to_jsonb(x) from bi.customer_profile x where x.member_id = v_key);
end;
$$;

create function public.bi_customer_set_geo(p_member text, p_lat numeric, p_lng numeric, p_query text)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_key text := bi.customer_key(p_member);
  v_who text := coalesce(auth.jwt() ->> 'email', 'unknown');
begin
  perform bi.customer_require(array['owner', 'manager', 'sales']);
  if v_key is null then
    raise exception '看不出电话号码';
  end if;
  if (p_lat is null) <> (p_lng is null) or p_lat not between -90 and 90 or p_lng not between -180 and 180 then
    raise exception '坐标不对';
  end if;
  insert into bi.customer_profile as p (member_id, lat, lng, geo_query, geo_at, created_by, updated_by)
  values (v_key, p_lat, p_lng, left(p_query, 300), now(), v_who, v_who)
  on conflict (member_id) do update
     set lat = excluded.lat, lng = excluded.lng, geo_query = excluded.geo_query, geo_at = now();
  return jsonb_build_object('member_id', v_key, 'lat', p_lat, 'lng', p_lng);
end;
$$;

-- ── 出发点、司机、排单纪录 ──
create function public.bi_delivery_settings()
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
begin
  perform bi.customer_require(array['owner', 'manager', 'sales']);
  return jsonb_build_object(
    'depot', (select s.depot from bi.customer_settings s where s.id = 1),
    'drivers', (select coalesce(jsonb_agg(to_jsonb(d) order by d.store nulls last, d.name), '[]'::jsonb)
                  from bi.delivery_driver d where d.active),
    'company', (select public.bi_company()));
end;
$$;

create function public.bi_delivery_set_depot(p_store text, p_address text, p_lat numeric, p_lng numeric)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
begin
  perform bi.customer_require(array['owner', 'manager']);
  if p_store not in ('HQ', 'JB') then
    raise exception '门市只能是 HQ 或 JB';
  end if;
  if p_lat is null or p_lng is null or p_lat not between -90 and 90 or p_lng not between -180 and 180 then
    raise exception '出发点要有坐标';
  end if;
  update bi.customer_settings s
     set depot = s.depot || jsonb_build_object(p_store, jsonb_build_object('address', p_address, 'lat', p_lat, 'lng', p_lng)),
         updated_at = now(), updated_by = coalesce(auth.jwt() ->> 'email', 'unknown')
   where s.id = 1;
  return (select s.depot from bi.customer_settings s where s.id = 1);
end;
$$;

create function public.bi_delivery_driver_save(p_id bigint, p_name text, p_phone text, p_store text, p_active boolean)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_who text := coalesce(auth.jwt() ->> 'email', 'unknown');
  v_phone text := bi.customer_phone(p_phone);
  v_id bigint := p_id;
begin
  perform bi.customer_require(array['owner', 'manager']);
  if nullif(trim(p_name), '') is null or v_phone is null then
    raise exception '司机要有名字和完整手机号';
  end if;
  if v_id is null then
    insert into bi.delivery_driver (name, phone, store, active, updated_by)
    values (trim(p_name), v_phone, nullif(p_store, ''), coalesce(p_active, true), v_who) returning id into v_id;
  else
    update bi.delivery_driver
       set name = trim(p_name), phone = v_phone, store = nullif(p_store, ''), active = coalesce(p_active, true),
           updated_at = now(), updated_by = v_who
     where id = v_id;
    if not found then raise exception '找不到司机 #%', v_id; end if;
  end if;
  return (select to_jsonb(d) from bi.delivery_driver d where d.id = v_id);
end;
$$;

create function public.bi_delivery_run_save(p_store text, p_driver_id bigint, p_stops jsonb)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_id bigint;
  d bi.delivery_driver;
begin
  perform bi.customer_require(array['owner', 'manager', 'sales']);
  if jsonb_typeof(p_stops) <> 'array' or jsonb_array_length(p_stops) = 0 then
    raise exception '还没有要送的单';
  end if;
  select * into d from bi.delivery_driver x where x.id = p_driver_id;
  insert into bi.delivery_run (store, driver_name, driver_phone, stops, created_by)
  values (nullif(p_store, ''), d.name, d.phone, p_stops, coalesce(auth.jwt() ->> 'email', 'unknown'))
  returning id into v_id;
  return jsonb_build_object('id', v_id);
end;
$$;

create function public.bi_delivery_runs(p_days int default 14)
returns setof jsonb
language plpgsql stable security definer
set search_path = ''
as $$
begin
  perform bi.customer_require(array['owner', 'manager', 'sales']);
  return query
  select to_jsonb(r) from bi.delivery_run r
   where r.run_date >= (now() at time zone 'Asia/Kuala_Lumpur')::date - greatest(1, least(coalesce(p_days, 14), 90))
   order by r.created_at desc
   limit 50;
end;
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.bi_delivery_lookup(text)', 'public.bi_customer_set_address(text,text)',
    'public.bi_customer_set_geo(text,numeric,numeric,text)', 'public.bi_delivery_settings()',
    'public.bi_delivery_set_depot(text,text,numeric,numeric)', 'public.bi_delivery_driver_save(bigint,text,text,text,boolean)',
    'public.bi_delivery_run_save(text,bigint,jsonb)', 'public.bi_delivery_runs(int)']
  loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
