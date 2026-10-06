-- 套用状态：2026-10-06 全部套用。Supabase 连接器遇到含 DROP / DELETE 的变更要使用者确认、60 秒过期，所以分批：
--   customer_crm_v3_tables / _key / _doc_view / _rpcs / _grant_test 由 Claude 套用；
--   最后一批（bi_quote_upsert、修改纪录触发器、merge / unmerge、bi_customers 新版、bi_customer_set_settings 新版、删探针函数）
--   由使用者在 Supabase SQL Editor 贴上执行（不会出现在 schema_migrations）。
-- 顾客资料第三版（migration `customer_crm_v3`，2026-10-05）：使用者选的 6 项
-- 手机版快速登记（bi_customer_quick）、顾客自己扫 QR 登记（店员确认后才生效）、报价没成交提醒（Quotation，7 天）、
-- 装修进度 5 段 + 各段推荐类别、顾客资料修改纪录（触发器）、合并重复顾客（别名表）。
-- 旧版网页（第二版）呼叫的函数签名都保留（bi_customer_set_settings 新参数都有预设值），部署前后都能用。

-- ── 装修阶段：plan 规划中 / rough 动工·水电 / tile 泥水·贴砖 / install 安装 / done 完工 ──
alter table bi.customer_profile
  add column reno_stage text check (reno_stage in ('plan', 'rough', 'tile', 'install', 'done')),
  add column reno_stage_at timestamptz;

alter table bi.customer_settings
  add column quote_follow_days int not null default 7,
  add column quote_max_days int not null default 60,
  add column stage_follow_days int not null default 30,
  add column stage_reco jsonb not null default '{
    "plan": ["SANITARY", "KITCHEN"],
    "rough": ["VALVE", "FITTING"],
    "tile": ["SANITARY", "BUILDING"],
    "install": ["LOCK", "KITCHEN", "ELECTRIC", "GARDEN"],
    "done": ["LOCK", "GARDEN"]
  }'::jsonb;

-- ── 合并重复顾客：别名 → 主号码。customer_doc / customer_key 都会先换成主号码 ──
create table bi.customer_alias (
  alias_id text primary key check (alias_id ~ '^([0-9]{9,13}|A:[A-Z]+:.+)$'),
  member_id text not null check (member_id ~ '^([0-9]{9,13}|A:[A-Z]+:.+)$'),
  created_at timestamptz not null default now(),
  created_by text,
  check (alias_id <> member_id)
);
create index on bi.customer_alias (member_id);

create or replace function bi.customer_key(p_input text)
returns text
language sql
stable
set search_path = ''
as $$
  with k as (select case when p_input ~ '^A:' then p_input else bi.customer_phone(p_input) end as k)
  select coalesce((select a.member_id from bi.customer_alias a where a.alias_id = k.k), k.k) from k;
$$;

create or replace view bi.customer_doc as
with d as (
  select f.company, f.doc_type, f.doc_key, f.doc_no, f.doc_date, f.debtor_code,
         max(f.debtor_name) as debtor_name, c.name as customer_name, max(f.sales_agent) as sales_agent,
         sum(f.sub_total) as amount
    from bi.fact_sales f
    join bi.dim_customer c on c.company = f.company and c.debtor_code = f.debtor_code
    join bi.customer_eligible e on e.company = f.company and e.debtor_type = coalesce(c.debtor_type, '')
   where f.doc_type = any (array['IV', 'CS', 'CN'])
   group by f.company, f.doc_type, f.doc_key, f.doc_no, f.doc_date, f.debtor_code, c.name
), names as materialized (
  select n.nm, bi.customer_phone(n.nm) as phone
    from (select d1.debtor_name as nm from d d1 union select d1.customer_name from d d1) n
   where n.nm is not null
), raw as (
  select d.*,
         coalesce(dn.phone, cn.phone,
                  case when d.customer_name !~* '^\s*CASH' then 'A:' || d.company || ':' || d.debtor_code end) as raw_id
    from d
    left join names dn on dn.nm = d.debtor_name
    left join names cn on cn.nm = d.customer_name
)
select r.company, r.doc_type, r.doc_key, r.doc_no, r.doc_date, r.debtor_code, r.debtor_name, r.customer_name,
       r.sales_agent, r.amount, coalesce(a.member_id, r.raw_id) as member_id
  from raw r
  left join bi.customer_alias a on a.alias_id = r.raw_id;

-- ── 报价单（Quotation）：SERVER / 分行电脑每天推「近 120 天、没取消」的报价单快照 ──
create table bi.quote_open (
  company text not null,
  doc_no text not null,
  doc_date date not null,
  debtor_code text not null,
  debtor_name text,
  sales_agent text,
  amount numeric not null default 0,
  transferred boolean not null default false,   -- 已转 SO / DO / IV（明细 TransferedQty > 0）
  items text,
  synced_at timestamptz not null default now(),
  primary key (company, doc_no)
);

create or replace view bi.customer_quote as
with q as (
  select q.*, c.name as customer_name
    from bi.quote_open q
    join bi.dim_customer c on c.company = q.company and c.debtor_code = q.debtor_code
    join bi.customer_eligible e on e.company = q.company and e.debtor_type = coalesce(c.debtor_type, '')
), raw as (
  select q.*, coalesce(bi.customer_phone(q.debtor_name), bi.customer_phone(q.customer_name),
                       case when q.customer_name !~* '^\s*CASH' then 'A:' || q.company || ':' || q.debtor_code end) as raw_id
    from q
)
select r.company, r.doc_no, r.doc_date, r.debtor_code, r.debtor_name, r.sales_agent, r.amount, r.transferred, r.items,
       r.synced_at, coalesce(a.member_id, r.raw_id) as member_id
  from raw r
  left join bi.customer_alias a on a.alias_id = r.raw_id;

create function public.bi_quote_upsert(p_company text, p_docs jsonb)
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
  delete from bi.quote_open where company = p_company;
  insert into bi.quote_open (company, doc_no, doc_date, debtor_code, debtor_name, sales_agent, amount, transferred, items)
  select p_company, x.doc_no, x.doc_date, x.debtor_code, x.debtor_name, nullif(trim(x.sales_agent), ''),
         coalesce(x.amount, 0), coalesce(x.transferred, false), left(x.items, 500)
    from jsonb_to_recordset(coalesce(p_docs, '[]'::jsonb))
         as x(doc_no text, doc_date date, debtor_code text, debtor_name text, sales_agent text, amount numeric,
              transferred boolean, items text)
   where x.doc_no is not null and x.doc_date is not null and x.debtor_code is not null
  on conflict (company, doc_no) do nothing;
  get diagnostics v_n = row_count;
  return jsonb_build_object('company', p_company, 'quotes', v_n);
end;
$$;

-- ── 顾客资料修改纪录 ──
create table bi.customer_profile_log (
  id bigint generated always as identity primary key,
  member_id text not null,
  at timestamptz not null default now(),
  by text,
  action text not null,           -- insert / update / delete / merge / unmerge
  changes jsonb not null default '{}'
);
create index on bi.customer_profile_log (member_id, at desc);

create function bi.customer_profile_audit()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_skip text[] := array['member_id', 'created_at', 'created_by', 'updated_at', 'updated_by', 'consent_at', 'consent_by',
                         'reno_stage_at'];
  v_old jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) else '{}'::jsonb end;
  v_new jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) else '{}'::jsonb end;
  v_changes jsonb;
  v_by text := coalesce(nullif(current_setting('bi.actor', true), ''), auth.jwt() ->> 'email', session_user);
begin
  select coalesce(jsonb_object_agg(k, jsonb_build_array(v_old -> k, v_new -> k)), '{}'::jsonb) into v_changes
    from (select jsonb_object_keys(v_old) as k union select jsonb_object_keys(v_new)) keys
   where not (k = any (v_skip))
     and (v_old -> k) is distinct from (v_new -> k)
     and not (coalesce(v_old -> k, 'null'::jsonb) = 'null'::jsonb and coalesce(v_new -> k, 'null'::jsonb) = 'null'::jsonb);
  if v_changes = '{}'::jsonb then
    return null;
  end if;
  insert into bi.customer_profile_log (member_id, by, action, changes)
  values (case when tg_op = 'DELETE' then old.member_id else new.member_id end, v_by, lower(tg_op), v_changes);
  return null;
end;
$$;

create trigger customer_profile_audit
after insert or update or delete on bi.customer_profile
for each row execute function bi.customer_profile_audit();

-- ── 顾客自己扫 QR 登记（店员确认后才写进顾客资料） ──
create table bi.customer_signup (
  id bigint generated always as identity primary key,
  member_id text not null check (member_id ~ '^[0-9]{9,13}$'),
  name text check (length(name) <= 60),
  birth_month smallint check (birth_month between 1 and 12),
  birth_day smallint check (birth_day between 1 and 31),
  area text check (length(area) <= 60),
  consent boolean not null,
  store text check (store in ('HQ', 'JB')),
  created_at timestamptz not null default now(),
  status text not null default 'pending' check (status in ('pending', 'confirmed', 'rejected')),
  handled_at timestamptz,
  handled_by text
);
create index on bi.customer_signup (status, created_at desc);

alter table bi.customer_alias enable row level security;
alter table bi.quote_open enable row level security;
alter table bi.customer_profile_log enable row level security;
alter table bi.customer_signup enable row level security;
revoke all on bi.customer_alias, bi.quote_open, bi.customer_profile_log, bi.customer_signup from anon, authenticated;

-- 公开（anon）可呼叫：只收资料，不回传任何顾客资讯
create function public.bi_customer_signup(p_phone text, p_name text, p_birth_month int, p_birth_day int,
                                          p_area text, p_consent boolean, p_store text)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_key text := bi.customer_phone(p_phone);
  v_name text := nullif(trim(p_name), '');
  v_area text := nullif(trim(p_area), '');
  v_store text := nullif(upper(trim(p_store)), '');
begin
  if v_key is null then
    raise exception '电话号码看不懂，请输入完整手机号，例如 012-345 6789';
  end if;
  if v_name is null then
    raise exception '请填名字';
  end if;
  if length(v_name) > 60 or length(coalesce(v_area, '')) > 60 then
    raise exception '名字或地区太长';
  end if;
  if (p_birth_month is null) <> (p_birth_day is null) then
    raise exception '生日要月、日都填，或都不填';
  end if;
  if p_birth_month is not null then
    begin
      perform make_date(2000, p_birth_month, p_birth_day);
    exception when others then
      raise exception '生日日期不对';
    end;
  end if;
  if v_store is not null and v_store not in ('HQ', 'JB') then
    v_store := null;
  end if;
  if (select count(*) from bi.customer_signup s where s.created_at > now() - interval '10 minutes') >= 30 then
    raise exception '现在登记的人太多，请稍后再试，或请店员帮忙登记';
  end if;
  update bi.customer_signup s
     set name = v_name, birth_month = p_birth_month, birth_day = p_birth_day, area = v_area,
         consent = coalesce(p_consent, false), store = coalesce(v_store, s.store), created_at = now()
   where s.member_id = v_key and s.status = 'pending';
  if not found then
    insert into bi.customer_signup (member_id, name, birth_month, birth_day, area, consent, store)
    values (v_key, v_name, p_birth_month, p_birth_day, v_area, coalesce(p_consent, false), v_store);
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

create function public.bi_customer_signups()
returns setof jsonb
language plpgsql stable security definer
set search_path = ''
as $$
begin
  perform bi.customer_require(array['owner', 'manager', 'sales']);
  return query
  select to_jsonb(s) || jsonb_build_object(
           'main_id', bi.customer_key(s.member_id),
           'current', (select jsonb_build_object('name', p.name, 'birth_month', p.birth_month, 'birth_day', p.birth_day,
                                                 'area', p.area, 'consent', p.consent)
                         from bi.customer_profile p where p.member_id = bi.customer_key(s.member_id)))
    from bi.customer_signup s
   where s.status = 'pending'
   order by s.created_at desc
   limit 200;
end;
$$;

create function public.bi_customer_signup_handle(p_id bigint, p_accept boolean)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_who text := coalesce(auth.jwt() ->> 'email', 'unknown');
  s bi.customer_signup;
  v_key text;
  v_consent text;
begin
  perform bi.customer_require(array['owner', 'manager', 'sales']);
  select * into s from bi.customer_signup x where x.id = p_id and x.status = 'pending' for update;
  if not found then
    raise exception '这笔登记已经处理过（或不存在），请重新整理页面';
  end if;
  update bi.customer_signup x
     set status = case when p_accept then 'confirmed' else 'rejected' end, handled_at = now(), handled_by = v_who
   where x.id = p_id;
  if not p_accept then
    return jsonb_build_object('member_id', s.member_id, 'accepted', false);
  end if;
  v_key := bi.customer_key(s.member_id);
  v_consent := case when s.consent then 'yes' else 'no' end;
  perform set_config('bi.actor', '顾客自己登记（' || v_who || ' 确认）', true);
  -- 已有的名字 / 生日 / 地区不盖掉（店员填的比较可靠）；同意收促销以顾客本人的选择为准
  insert into bi.customer_profile as p (member_id, name, birth_month, birth_day, area, consent, consent_at, consent_by,
                                        created_by, updated_by)
  values (v_key, s.name, s.birth_month, s.birth_day, s.area, v_consent, now(), '顾客自己登记（' || v_who || ' 确认）',
          v_who, v_who)
  on conflict (member_id) do update
     set name = coalesce(p.name, excluded.name),
         birth_month = case when p.birth_month is null then excluded.birth_month else p.birth_month end,
         birth_day = case when p.birth_month is null then excluded.birth_day else p.birth_day end,
         area = coalesce(p.area, excluded.area),
         consent = excluded.consent,
         consent_at = case when p.consent is distinct from excluded.consent then now() else p.consent_at end,
         consent_by = case when p.consent is distinct from excluded.consent then excluded.consent_by else p.consent_by end,
         updated_at = now(), updated_by = v_who;
  return jsonb_build_object('member_id', v_key, 'accepted', true);
end;
$$;

-- ── 快速登记：只写有填的栏位，不会把别的资料清掉（手机上用） ──
create function public.bi_customer_quick(p_member text, p_name text, p_birth_month int, p_birth_day int,
                                         p_consent text, p_reno_stage text, p_area text)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_key text := bi.customer_key(p_member);
  v_who text := coalesce(auth.jwt() ->> 'email', 'unknown');
  v_consent text := nullif(trim(coalesce(p_consent, '')), '');
  v_stage text := nullif(trim(coalesce(p_reno_stage, '')), '');
begin
  perform bi.customer_require(array['owner', 'manager', 'sales']);
  if v_key is null then
    raise exception '看不出电话号码：请输入完整手机号，例如 012-3456789 或 +65 9123 4567';
  end if;
  if (p_birth_month is null) <> (p_birth_day is null) then
    raise exception '生日要月、日都填，或都不填';
  end if;
  if v_consent is not null and v_consent not in ('yes', 'no') then
    raise exception '同意收促销只能是 同意 / 不同意 / 未确认';
  end if;
  insert into bi.customer_profile as p (member_id, name, birth_month, birth_day, area, consent, consent_at, consent_by,
                                        reno_stage, reno_stage_at, created_by, updated_by)
  values (v_key, nullif(trim(p_name), ''), p_birth_month, p_birth_day, nullif(trim(p_area), ''),
          v_consent, case when v_consent is not null then now() end, case when v_consent is not null then v_who end,
          v_stage, case when v_stage is not null then now() end, v_who, v_who)
  on conflict (member_id) do update
     set name = coalesce(excluded.name, p.name),
         birth_month = coalesce(excluded.birth_month, p.birth_month),
         birth_day = case when excluded.birth_month is not null then excluded.birth_day else p.birth_day end,
         area = coalesce(excluded.area, p.area),
         consent = coalesce(excluded.consent, p.consent),
         consent_at = case when excluded.consent is not null and p.consent is distinct from excluded.consent then now()
                           else p.consent_at end,
         consent_by = case when excluded.consent is not null and p.consent is distinct from excluded.consent then v_who
                           else p.consent_by end,
         reno_stage = coalesce(excluded.reno_stage, p.reno_stage),
         reno_stage_at = case when excluded.reno_stage is not null and p.reno_stage is distinct from excluded.reno_stage
                              then now() else p.reno_stage_at end,
         updated_at = now(), updated_by = v_who;
  return (select to_jsonb(x) from bi.customer_profile x where x.member_id = v_key);
end;
$$;

create function public.bi_customer_set_stage(p_member text, p_stage text)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_key text := bi.customer_key(p_member);
  v_who text := coalesce(auth.jwt() ->> 'email', 'unknown');
  v_stage text := nullif(trim(coalesce(p_stage, '')), '');
begin
  perform bi.customer_require(array['owner', 'manager', 'sales']);
  if v_key is null then
    raise exception '看不出电话号码';
  end if;
  insert into bi.customer_profile as p (member_id, reno_stage, reno_stage_at, created_by, updated_by)
  values (v_key, v_stage, now(), v_who, v_who)
  on conflict (member_id) do update
     set reno_stage = excluded.reno_stage, reno_stage_at = now(), updated_at = now(), updated_by = v_who;
  return (select to_jsonb(x) from bi.customer_profile x where x.member_id = v_key);
end;
$$;

-- ── 合并 / 取消合并 ──
create function public.bi_customer_merge(p_keep text, p_drop text)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_who text := coalesce(auth.jwt() ->> 'email', 'unknown');
  v_keep text := bi.customer_key(p_keep);
  v_drop text := case when p_drop ~ '^A:' then p_drop else bi.customer_phone(p_drop) end;
  d bi.customer_profile;
begin
  perform bi.customer_require(array['owner', 'manager']);
  if v_keep is null or v_drop is null then
    raise exception '看不出电话号码：两边都要填完整手机号';
  end if;
  if bi.customer_key(v_drop) = v_keep then
    raise exception '这两个号码已经是同一位顾客';
  end if;
  if exists (select 1 from bi.customer_alias a where a.alias_id = v_drop) then
    raise exception '% 已经合并到别的顾客，请先取消那次合并', v_drop;
  end if;
  perform set_config('bi.actor', v_who || '（合并）', true);
  update bi.customer_alias set member_id = v_keep where member_id = v_drop;
  insert into bi.customer_alias (alias_id, member_id, created_by) values (v_drop, v_keep, v_who);

  select * into d from bi.customer_profile p where p.member_id = v_drop;
  if found then
    if exists (select 1 from bi.customer_profile p where p.member_id = v_keep) then
      update bi.customer_profile p
         set name = coalesce(p.name, d.name),
             birth_month = case when p.birth_month is null then d.birth_month else p.birth_month end,
             birth_day = case when p.birth_month is null then d.birth_day else p.birth_day end,
             area = coalesce(p.area, d.area), address = coalesce(p.address, d.address),
             customer_type = coalesce(p.customer_type, d.customer_type),
             note = case when p.note is null then d.note when d.note is null or d.note = p.note then p.note
                         else p.note || ' / ' || d.note end,
             consent = coalesce(p.consent, d.consent), consent_at = case when p.consent is null then d.consent_at else p.consent_at end,
             consent_by = case when p.consent is null then d.consent_by else p.consent_by end,
             next_contact = least(p.next_contact, d.next_contact),
             last_contact_at = greatest(p.last_contact_at, d.last_contact_at),
             reno_stage = coalesce(p.reno_stage, d.reno_stage),
             reno_stage_at = case when p.reno_stage is null then d.reno_stage_at else p.reno_stage_at end,
             updated_at = now(), updated_by = v_who
       where p.member_id = v_keep;
      delete from bi.customer_profile p where p.member_id = v_drop;
    else
      update bi.customer_profile p set member_id = v_keep, updated_at = now(), updated_by = v_who where p.member_id = v_drop;
    end if;
  end if;
  insert into bi.customer_campaign_member (campaign_id, member_id)
  select m.campaign_id, v_keep from bi.customer_campaign_member m where m.member_id = v_drop
  on conflict do nothing;
  delete from bi.customer_campaign_member m where m.member_id = v_drop;
  insert into bi.customer_profile_log (member_id, by, action, changes)
  values (v_keep, v_who, 'merge', jsonb_build_object('merged', v_drop));
  return jsonb_build_object('member_id', v_keep, 'merged', v_drop);
end;
$$;

create function public.bi_customer_unmerge(p_alias text)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_who text := coalesce(auth.jwt() ->> 'email', 'unknown');
  v_alias text := case when p_alias ~ '^A:' then p_alias else bi.customer_phone(p_alias) end;
  v_main text;
begin
  perform bi.customer_require(array['owner', 'manager']);
  delete from bi.customer_alias a where a.alias_id = v_alias returning a.member_id into v_main;
  if v_main is null then
    raise exception '% 没有合并过', coalesce(v_alias, p_alias);
  end if;
  insert into bi.customer_profile_log (member_id, by, action, changes)
  values (v_main, v_who, 'unmerge', jsonb_build_object('unmerged', v_alias));
  return jsonb_build_object('member_id', v_main, 'unmerged', v_alias);
end;
$$;

create function public.bi_customer_log(p_member text)
returns setof jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_key text := bi.customer_key(p_member);
begin
  perform bi.customer_require(array['owner', 'manager', 'sales']);
  return query
  select jsonb_build_object('at', l.at, 'by', l.by, 'action', l.action, 'changes', l.changes, 'member_id', l.member_id)
    from bi.customer_profile_log l
   where l.member_id = v_key or l.member_id in (select a.alias_id from bi.customer_alias a where a.member_id = v_key)
   order by l.at desc, l.id desc
   limit 100;
end;
$$;

-- ── 顾客明细多了别名与报价单 ──
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
    'docs', v_docs,
    'aliases', (select coalesce(jsonb_agg(a.alias_id order by a.alias_id), '[]'::jsonb)
                  from bi.customer_alias a where a.member_id = v_key),
    'quotes', (select coalesce(jsonb_agg(jsonb_build_object(
                        'company', q.company, 'doc_no', q.doc_no, 'doc_date', q.doc_date, 'sales_agent', q.sales_agent,
                        'amount', round(q.amount, 2), 'transferred', q.transferred, 'items', q.items,
                        'bought_after', exists (select 1 from bi.customer_doc cd
                                                 where cd.member_id = v_key and cd.doc_type in ('IV', 'CS')
                                                   and cd.doc_date >= q.doc_date))
                      order by q.doc_date desc), '[]'::jsonb)
                 from bi.customer_quote q where q.member_id = v_key)
  );
end;
$$;

-- ── 顾客清单：多了装修阶段、报价单 ──
drop function if exists public.bi_customers();
create function public.bi_customers()
returns table (
  member_id text, name text, stores text, first_date date, last_date date, doc_count int, doc_count_12m int,
  spent numeric, spent_12m numeric, categories text[],
  birth_month smallint, birth_day smallint, area text, address text, customer_type text, note text,
  consent text, next_contact date, last_contact_at timestamptz,
  profile_created_at timestamptz, profile_updated_at timestamptz,
  reno_stage text, reno_stage_at timestamptz, quote_open int, quote_amount numeric, quote_due date
)
language plpgsql stable security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_today date := (now() at time zone 'Asia/Kuala_Lumpur')::date;
  v_follow int := (select s.quote_follow_days from bi.customer_settings s where s.id = 1);
  v_max int := (select s.quote_max_days from bi.customer_settings s where s.id = 1);
begin
  perform bi.customer_require(array['owner', 'manager', 'sales']);
  return query
  with cd as materialized (
    select x.* from bi.customer_doc x where x.member_id is not null
  ),
  docs as (
    select cd.member_id,
           (array_agg(cd.debtor_name order by cd.doc_date desc, cd.amount desc))[1] as last_name,
           string_agg(distinct case cd.company when 'HOMEWORKSSB' then 'HQ' else 'JB' end, ' + ') as stores,
           min(cd.doc_date) as first_date, max(cd.doc_date) as last_date,
           max(cd.doc_date) filter (where cd.doc_type in ('IV', 'CS')) as last_buy,
           count(*) filter (where cd.amount > 0)::int as doc_count,
           count(*) filter (where cd.amount > 0 and cd.doc_date > current_date - 365)::int as doc_count_12m,
           sum(cd.amount) as spent,
           sum(cd.amount) filter (where cd.doc_date > current_date - 365) as spent_12m
      from cd
     group by cd.member_id
  ),
  lines as (
    select distinct f.company, f.doc_type, f.doc_key, i.item_group
      from bi.fact_sales f
      join bi.dim_customer c on c.company = f.company and c.debtor_code = f.debtor_code
      join bi.customer_eligible e on e.company = f.company and e.debtor_type = coalesce(c.debtor_type, '')
      join bi.dim_item i on i.company = f.company and i.item_code = f.item_code
     where f.doc_type in ('IV', 'CS') and i.item_group is not null
       and i.item_group not in ('INSTALL', 'SERV FEE', 'SHIP FEE', 'TRAN FEE', 'TRANSPOR', 'DELIVERY',
                                'CARD INT', 'GST', 'SERV INC', 'SAMPLE', 'STOCK A', 'ONLINE', 'PAY FEE')
  ),
  cats as (
    select cd.member_id, array_agg(distinct l.item_group order by l.item_group) as categories
      from cd join lines l on l.company = cd.company and l.doc_type = cd.doc_type and l.doc_key = cd.doc_key
     group by cd.member_id
  ),
  qo as (
    select q.member_id, q.doc_date, q.amount
      from bi.customer_quote q
      left join docs d on d.member_id = q.member_id
     where q.member_id is not null and not q.transferred
       and (d.last_buy is null or d.last_buy < q.doc_date)
  ),
  qa as (
    select qo.member_id, count(*)::int as n, sum(qo.amount) as amt,
           max(qo.doc_date + v_follow) filter (where qo.doc_date <= v_today - v_follow and qo.doc_date >= v_today - v_max) as due
      from qo group by qo.member_id
  ),
  ids as (
    select d.member_id from docs d
    union
    select p.member_id from bi.customer_profile p
    union
    select qa.member_id from qa
  )
  select ids.member_id, coalesce(nullif(p.name, ''), d.last_name,
                                 (select q.debtor_name from bi.customer_quote q where q.member_id = ids.member_id
                                   order by q.doc_date desc limit 1)),
         d.stores, d.first_date, d.last_date,
         coalesce(d.doc_count, 0), coalesce(d.doc_count_12m, 0),
         round(coalesce(d.spent, 0), 2), round(coalesce(d.spent_12m, 0), 2),
         coalesce(c.categories, '{}'),
         p.birth_month, p.birth_day, p.area, p.address, p.customer_type, p.note,
         p.consent, p.next_contact, p.last_contact_at, p.created_at, p.updated_at,
         p.reno_stage, p.reno_stage_at, coalesce(qa.n, 0), round(coalesce(qa.amt, 0), 2), qa.due
    from ids
    left join docs d on d.member_id = ids.member_id
    left join cats c on c.member_id = ids.member_id
    left join bi.customer_profile p on p.member_id = ids.member_id
    left join qa on qa.member_id = ids.member_id
   order by d.last_date desc nulls last, ids.member_id;
end;
$$;

-- ── 设定多了报价、装修阶段（新参数有预设值，第二版网页照旧呼叫 5 个参数也可以） ──
drop function if exists public.bi_customer_set_settings(numeric, int, int, int, int);
create function public.bi_customer_set_settings(
  p_vip_min_12m numeric, p_regular_min_docs int, p_lapsed_days int, p_lead_follow_days int, p_birthday_days int,
  p_quote_follow_days int default null, p_quote_max_days int default null, p_stage_follow_days int default null,
  p_stage_reco jsonb default null)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
begin
  perform bi.customer_require(array['owner']);
  if p_vip_min_12m < 0 or p_regular_min_docs < 1 or p_lapsed_days < 30 or p_lead_follow_days < 1 or p_birthday_days < 0
     or p_quote_follow_days < 1 or p_quote_max_days < 7 or p_stage_follow_days < 7 then
    raise exception '设定值不合理（VIP 门槛 ≥ 0、常客至少 1 张单、流失至少 30 天、潜在客跟进至少 1 天、报价跟进至少 1 天、报价最多追至少 7 天、装修进度至少 7 天）';
  end if;
  if p_stage_reco is not null and (jsonb_typeof(p_stage_reco) <> 'object'
      or exists (select 1 from jsonb_each(p_stage_reco) e
                  where e.key not in ('plan', 'rough', 'tile', 'install', 'done') or jsonb_typeof(e.value) <> 'array')) then
    raise exception '装修阶段推荐格式不对';
  end if;
  update bi.customer_settings s
     set vip_min_12m = p_vip_min_12m, regular_min_docs = p_regular_min_docs, lapsed_days = p_lapsed_days,
         lead_follow_days = p_lead_follow_days, birthday_days = p_birthday_days,
         quote_follow_days = coalesce(p_quote_follow_days, s.quote_follow_days),
         quote_max_days = coalesce(p_quote_max_days, s.quote_max_days),
         stage_follow_days = coalesce(p_stage_follow_days, s.stage_follow_days),
         stage_reco = coalesce(p_stage_reco, s.stage_reco),
         updated_at = now(), updated_by = coalesce(auth.jwt() ->> 'email', 'unknown')
   where s.id = 1;
  return (select to_jsonb(s) from bi.customer_settings s where s.id = 1);
end;
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.bi_customers()', 'public.bi_customer(text)', 'public.bi_customer_signups()',
    'public.bi_customer_signup_handle(bigint,boolean)', 'public.bi_customer_quick(text,text,int,int,text,text,text)',
    'public.bi_customer_set_stage(text,text)', 'public.bi_customer_merge(text,text)', 'public.bi_customer_unmerge(text)',
    'public.bi_customer_log(text)',
    'public.bi_customer_set_settings(numeric,int,int,int,int,int,int,int,jsonb)']
  loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

revoke all on function public.bi_customer_signup(text, text, int, int, text, boolean, text) from public;
grant execute on function public.bi_customer_signup(text, text, int, int, text, boolean, text) to anon, authenticated;

revoke all on function public.bi_quote_upsert(text, jsonb) from public, anon, authenticated;
grant execute on function public.bi_quote_upsert(text, jsonb) to service_role;

-- ── 2026-10-06 migration customer_signup_address：登记页「住哪一区」改成送货地址 ──
-- alter table bi.customer_signup add column address text check (length(address) <= 300);
-- public.bi_customer_signup(p_phone, p_name, p_birth_month, p_birth_day, p_area, p_consent, p_store, p_address) 新增 8 参数版
--   （p_address 无预设值，所以旧网页呼叫 7 个参数仍对到旧版）；bi_customer_signups 的 current 多 address；
--   bi_customer_signup_handle 写入 address = coalesce(顾客新填, 原有)（送货要最新的地址）。完整内容见 Supabase migration。

-- ── 2026-10-06 migration customer_signup_email：登记页加电邮 ──
-- customer_signup.email、customer_profile.email（≤120 字）；bi_customer_signup 9 参数版（p_email 无预设值，旧 7 / 8 参数版保留），
-- 电邮转小写、格式检查；bi_customer_signups 的 current 多 email；bi_customer_signup_handle 写入 email = coalesce(新填, 原有)。

-- ── 2026-10-06 migration customer_signup_auto_confirm / customer_signups_recent：扫码登记不用店员确认 ──
-- bi.customer_signup_apply(p_id, p_actor)（只给 security definer 函数内部用）：写入规则同店员确认 —— 已有名字 / 生日 / 地区不盖掉，
-- 地址、电邮以新填的为准，同意收促销以顾客选择为准；status = confirmed。9 参数版 bi_customer_signup 送出即呼叫它。
-- bi_customer_signups 改列 pending + 近 14 天 handled_by like '顾客自己扫码登记%'，current 多 last_contact_at。
