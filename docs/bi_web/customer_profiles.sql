-- 顾客资料（migration `customer_profiles`，2026-09-29）——取代 2026-09-28 的顾客积分（使用者说积分不要，
-- 要的是「有个地方记录顾客讯息，将来做促销」）。
-- 门市散客（HQ debtor_type RETAIL；JB RETAIL + 空白）以电话为顾客编号、总部与 JB 合并；购买历史从 bi.fact_sales
-- 全部历史现算（HQ 2022-06 起、JB 2024-03 起）；员工补的资料（名字、生日、地区、地址、类型、备注）存 bi.customer_profile。
-- 读写一律走 public.bi_customer* RPC（SECURITY DEFINER，函数内查角色 owner / manager / sales）。

-- ── 拿掉积分（loyalty_txn 当时 0 笔，没有资料会丢） ──
drop function if exists public.bi_loyalty_members(text, int);
drop function if exists public.bi_loyalty_member(text);
drop function if exists public.bi_loyalty_redeem(text, int, text, text, text);
drop function if exists public.bi_loyalty_adjust(text, int, text);
drop function if exists public.bi_loyalty_void(bigint, text);
drop function if exists public.bi_loyalty_missing_phone(int);
drop function if exists public.bi_loyalty_settings();
drop function if exists public.bi_loyalty_set_settings(numeric, numeric, int, int, date);
drop function if exists bi.loyalty_calc(text, date);
drop function if exists bi.loyalty_member_key(text);
drop view if exists bi.loyalty_doc;
drop table if exists bi.loyalty_txn;
drop table if exists bi.loyalty_settings;
alter table bi.loyalty_eligible rename to customer_eligible;
alter function bi.loyalty_phone(text) rename to customer_phone;
alter function bi.loyalty_require(text[]) rename to customer_require;
create or replace function bi.customer_require(p_roles text[])
returns text
language plpgsql stable
set search_path = ''
as $$
declare
  v_role text := (select public.bi_role());
begin
  if not coalesce((select public.bi_is_allowed()), false) or v_role is null or not (v_role = any(p_roles)) then
    raise exception '没有权限：顾客资料只开放给 %', array_to_string(p_roles, ' / ');
  end if;
  return v_role;
end;
$$;
revoke all on function bi.customer_require(text[]) from public, anon, authenticated;

-- ── 员工补的资料（顾客编号 = 60…/65… 电话，或 A:公司:客户代号） ──
create table bi.customer_profile (
  member_id text primary key check (member_id ~ '^([0-9]{9,13}|A:[A-Z]+:.+)$'),
  name text,
  birth_month smallint check (birth_month between 1 and 12),
  birth_day smallint check (birth_day between 1 and 31),
  area text,
  address text,
  customer_type text check (customer_type in ('屋主', '设计师', '承包商', '水工', '公司', '其他')),
  note text,
  created_at timestamptz not null default now(),
  created_by text,
  updated_at timestamptz not null default now(),
  updated_by text
);
alter table bi.customer_profile enable row level security;
revoke all on bi.customer_profile from anon, authenticated;

-- ── 每张门市单据（全部历史），含顾客编号 ──
create or replace view bi.customer_doc as
with d as (
  select f.company, f.doc_type, f.doc_key, f.doc_no, f.doc_date, f.debtor_code,
         max(f.debtor_name) as debtor_name, c.name as customer_name,
         max(f.sales_agent) as sales_agent,
         sum(f.sub_total) as amount                -- fact_sales 的 CN 已是负数
    from bi.fact_sales f
    join bi.dim_customer c on c.company = f.company and c.debtor_code = f.debtor_code
    join bi.customer_eligible e on e.company = f.company and e.debtor_type = coalesce(c.debtor_type, '')
   where f.doc_type in ('IV', 'CS', 'CN')
   group by f.company, f.doc_type, f.doc_key, f.doc_no, f.doc_date, f.debtor_code, c.name
)
select d.*,
       coalesce(
         bi.customer_phone(d.debtor_name),
         bi.customer_phone(d.customer_name),
         case when d.customer_name !~* '^\s*CASH' then 'A:' || d.company || ':' || d.debtor_code end
       ) as member_id
  from d;
revoke all on bi.customer_doc from anon, authenticated;

create or replace function bi.customer_key(p_input text)
returns text
language sql immutable
set search_path = ''
as $$
  select case when p_input ~ '^A:' then p_input else bi.customer_phone(p_input) end;
$$;

-- ── 顾客清单（前端一次拿全部，筛选与汇出在浏览器做） ──
-- categories = 买过的商品群组（排除运费、安装、手续费这类服务项目）
create or replace function public.bi_customers()
returns table (
  member_id text, name text, stores text, first_date date, last_date date, doc_count int,
  spent numeric, spent_12m numeric, categories text[],
  birth_month smallint, birth_day smallint, area text, address text, customer_type text, note text,
  profile_updated_at timestamptz
)
language plpgsql stable security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  perform bi.customer_require(array['owner', 'manager', 'sales']);
  return query
  with docs as (
    select cd.member_id,
           (array_agg(cd.debtor_name order by cd.doc_date desc, cd.amount desc))[1] as last_name,
           string_agg(distinct case cd.company when 'HOMEWORKSSB' then 'HQ' else 'JB' end, ' + ') as stores,
           min(cd.doc_date) as first_date, max(cd.doc_date) as last_date,
           count(*) filter (where cd.amount > 0)::int as doc_count,
           sum(cd.amount) as spent,
           sum(cd.amount) filter (where cd.doc_date > current_date - 365) as spent_12m
      from bi.customer_doc cd
     where cd.member_id is not null
     group by cd.member_id
  ),
  cats as (
    select cd.member_id, array_agg(distinct i.item_group order by i.item_group) as categories
      from bi.customer_doc cd
      join bi.fact_sales f on f.company = cd.company and f.doc_type = cd.doc_type and f.doc_key = cd.doc_key
      join bi.dim_item i on i.company = f.company and i.item_code = f.item_code
     where cd.member_id is not null and cd.amount > 0 and i.item_group is not null
       and i.item_group not in ('INSTALL', 'SERV FEE', 'SHIP FEE', 'TRAN FEE', 'TRANSPOR', 'DELIVERY',
                                'CARD INT', 'GST', 'SERV INC', 'SAMPLE', 'STOCK A', 'ONLINE', 'PAY FEE')
     group by cd.member_id
  ),
  ids as (
    select d.member_id from docs d
    union
    select p.member_id from bi.customer_profile p
  )
  select ids.member_id, coalesce(nullif(p.name, ''), d.last_name), d.stores, d.first_date, d.last_date,
         coalesce(d.doc_count, 0), round(coalesce(d.spent, 0), 2), round(coalesce(d.spent_12m, 0), 2),
         coalesce(c.categories, '{}'),
         p.birth_month, p.birth_day, p.area, p.address, p.customer_type, p.note, p.updated_at
    from ids
    left join docs d on d.member_id = ids.member_id
    left join cats c on c.member_id = ids.member_id
    left join bi.customer_profile p on p.member_id = ids.member_id
   order by d.last_date desc nulls last, ids.member_id;
end;
$$;

-- ── 单一顾客：资料 + 购买历史（含品项） ──
create or replace function public.bi_customer(p_member text)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_key text := bi.customer_key(p_member);
  v_docs jsonb;
begin
  perform bi.customer_require(array['owner', 'manager', 'sales']);
  if v_key is null then
    raise exception '看不出电话号码：请输入完整手机号，例如 012-3456789 或 +65 9123 4567';
  end if;
  select coalesce(jsonb_agg(x order by x.doc_date desc, x.doc_no desc), '[]'::jsonb) into v_docs
    from (
      select cd.company, cd.doc_type, cd.doc_no, cd.doc_date, cd.debtor_code, cd.debtor_name,
             cd.sales_agent, round(cd.amount, 2) as amount,
             (select coalesce(jsonb_agg(jsonb_build_object(
                        'item_code', f.item_code, 'description', f.item_description,
                        'qty', f.qty, 'uom', f.uom, 'sub_total', f.sub_total)
                      order by f.dtl_key), '[]'::jsonb)
                from bi.fact_sales f
               where f.company = cd.company and f.doc_type = cd.doc_type and f.doc_key = cd.doc_key) as items
        from bi.customer_doc cd
       where cd.member_id = v_key
    ) x;
  return jsonb_build_object(
    'member_id', v_key,
    'profile', (select to_jsonb(p) from bi.customer_profile p where p.member_id = v_key),
    'docs', v_docs
  );
end;
$$;

-- ── 储存员工补的资料（没有这位顾客就新增，例如还没买过的潜在客） ──
create or replace function public.bi_customer_save(
  p_member text, p_name text, p_birth_month int, p_birth_day int,
  p_area text, p_address text, p_customer_type text, p_note text)
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
    raise exception '看不出电话号码：请输入完整手机号，例如 012-3456789 或 +65 9123 4567';
  end if;
  if (p_birth_month is null) <> (p_birth_day is null) then
    raise exception '生日要月、日都填，或都不填';
  end if;
  insert into bi.customer_profile as p (member_id, name, birth_month, birth_day, area, address, customer_type, note,
                                        created_by, updated_by)
  values (v_key, nullif(trim(p_name), ''), p_birth_month, p_birth_day, nullif(trim(p_area), ''),
          nullif(trim(p_address), ''), nullif(trim(p_customer_type), ''), nullif(trim(p_note), ''), v_who, v_who)
  on conflict (member_id) do update
     set name = excluded.name, birth_month = excluded.birth_month, birth_day = excluded.birth_day,
         area = excluded.area, address = excluded.address, customer_type = excluded.customer_type,
         note = excluded.note, updated_at = now(), updated_by = v_who;
  return (select to_jsonb(p) from bi.customer_profile p where p.member_id = v_key);
end;
$$;

-- ── 没抓到电话的门市单据（给员工回 AutoCount 补电话） ──
create or replace function public.bi_customer_missing_phone(p_days int default 60)
returns table (company text, doc_type text, doc_no text, doc_date date, debtor_code text,
               debtor_name text, sales_agent text, amount numeric)
language plpgsql stable security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_company text := (select public.bi_company());
begin
  perform bi.customer_require(array['owner', 'manager', 'sales']);
  return query
  select cd.company, cd.doc_type, cd.doc_no, cd.doc_date, cd.debtor_code, cd.debtor_name, cd.sales_agent,
         round(cd.amount, 2)
    from bi.customer_doc cd
   where cd.member_id is null
     and cd.amount > 0
     and cd.doc_date >= (now() at time zone 'Asia/Kuala_Lumpur')::date - greatest(1, least(coalesce(p_days, 60), 400))
     and (v_company is null or cd.company = v_company)
   order by cd.doc_date desc, cd.doc_no desc;
end;
$$;

revoke all on function public.bi_customers() from public, anon;
revoke all on function public.bi_customer(text) from public, anon;
revoke all on function public.bi_customer_save(text, text, int, int, text, text, text, text) from public, anon;
revoke all on function public.bi_customer_missing_phone(int) from public, anon;
grant execute on function public.bi_customers() to authenticated;
grant execute on function public.bi_customer(text) to authenticated;
grant execute on function public.bi_customer_save(text, text, int, int, text, text, text, text) to authenticated;
grant execute on function public.bi_customer_missing_phone(int) to authenticated;
revoke all on function bi.customer_key(text) from public, anon, authenticated;

-- ── 之后的调整（migration customer_profiles_faster_list、customer_doc_parse_names_once），以这两段为准 ──
-- bi_customers：单据只算一次（materialized CTE），类别改从门市客户的明细直接取；全体约 1.6 秒。
-- bi.customer_doc：每个不同的客户名称只抽一次电话（names materialized CTE，再 left join 回单据）。
-- 完整定义请直接看 Supabase：select pg_get_functiondef('public.bi_customers()'::regprocedure);
--                             select pg_get_viewdef('bi.customer_doc'::regclass);
