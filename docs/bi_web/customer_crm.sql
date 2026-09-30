-- 顾客资料第二版（migration `customer_crm`，2026-09-30）：使用者选的 7 项
-- 跟进提醒清单、一键 WhatsApp（话术范本）、买了 A 没买 B（前端筛选）、促销活动纪录与成效、
-- 同意收促销（只汇出 / 只放进活动的明确同意者）、顾客分级（VIP 近 12 个月 ≥ RM10,000、常客 ≥ 2 张单、
-- 12 个月没来 = 流失）、每月顾客报告（新客 / 回头客 / 流失 / 业务员）。

-- ── 顾客资料多几栏 ──
alter table bi.customer_profile
  add column consent text check (consent in ('yes', 'no')),      -- null = 未确认
  add column consent_at timestamptz,
  add column consent_by text,
  add column next_contact date,                                  -- 员工自订的下次联络日
  add column last_contact_at timestamptz;                        -- 最后一次按 WhatsApp 联络

-- ── 设定（分级门槛；owner 可改） ──
create table bi.customer_settings (
  id int primary key default 1 check (id = 1),
  vip_min_12m numeric not null default 10000,
  regular_min_docs int not null default 2,
  lapsed_days int not null default 365,
  lead_follow_days int not null default 7,
  birthday_days int not null default 7,
  updated_at timestamptz not null default now(),
  updated_by text
);
insert into bi.customer_settings default values;

-- ── WhatsApp 话术范本（{name} 会换成顾客名字） ──
create table bi.customer_wa_template (
  id bigint generated always as identity primary key,
  title text not null,
  body text not null,
  sort int not null default 0,
  updated_at timestamptz not null default now(),
  updated_by text
);
insert into bi.customer_wa_template (title, body, sort) values
  ('生日祝贺', 'Hi {name}，HomeWorks 祝你生日快乐！🎂 这个月来店出示这则讯息，有生日优惠等你。', 1),
  ('新品通知', 'Hi {name}，HomeWorks 有新品到货，欢迎来店看看，或回复这则讯息了解详情。', 2),
  ('回访', 'Hi {name}，我是 HomeWorks 的店员，想了解一下你的装修 / 选购进度，有什么可以帮忙的吗？', 3);

-- ── 促销活动与名单 ──
create table bi.customer_campaign (
  id bigint generated always as identity primary key,
  name text not null,
  message text,
  sent_on date not null default ((now() at time zone 'Asia/Kuala_Lumpur')::date),
  created_at timestamptz not null default now(),
  created_by text
);
create table bi.customer_campaign_member (
  campaign_id bigint not null references bi.customer_campaign (id) on delete cascade,
  member_id text not null,
  primary key (campaign_id, member_id)
);

alter table bi.customer_settings enable row level security;
alter table bi.customer_wa_template enable row level security;
alter table bi.customer_campaign enable row level security;
alter table bi.customer_campaign_member enable row level security;
revoke all on bi.customer_settings, bi.customer_wa_template, bi.customer_campaign, bi.customer_campaign_member
  from anon, authenticated;

-- ── 顾客清单（多了同意、提醒、联络、近 12 个月单数、建档时间） ──
drop function if exists public.bi_customers();
create function public.bi_customers()
returns table (
  member_id text, name text, stores text, first_date date, last_date date, doc_count int, doc_count_12m int,
  spent numeric, spent_12m numeric, categories text[],
  birth_month smallint, birth_day smallint, area text, address text, customer_type text, note text,
  consent text, next_contact date, last_contact_at timestamptz,
  profile_created_at timestamptz, profile_updated_at timestamptz
)
language plpgsql stable security definer
set search_path = ''
as $$
#variable_conflict use_column
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
  ids as (
    select d.member_id from docs d
    union
    select p.member_id from bi.customer_profile p
  )
  select ids.member_id, coalesce(nullif(p.name, ''), d.last_name), d.stores, d.first_date, d.last_date,
         coalesce(d.doc_count, 0), coalesce(d.doc_count_12m, 0),
         round(coalesce(d.spent, 0), 2), round(coalesce(d.spent_12m, 0), 2),
         coalesce(c.categories, '{}'),
         p.birth_month, p.birth_day, p.area, p.address, p.customer_type, p.note,
         p.consent, p.next_contact, p.last_contact_at, p.created_at, p.updated_at
    from ids
    left join docs d on d.member_id = ids.member_id
    left join cats c on c.member_id = ids.member_id
    left join bi.customer_profile p on p.member_id = ids.member_id
   order by d.last_date desc nulls last, ids.member_id;
end;
$$;

-- ── 储存（多了同意、下次联络日） ──
drop function if exists public.bi_customer_save(text, text, int, int, text, text, text, text);
create function public.bi_customer_save(
  p_member text, p_name text, p_birth_month int, p_birth_day int,
  p_area text, p_address text, p_customer_type text, p_note text,
  p_consent text, p_next_contact date)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_key text := bi.customer_key(p_member);
  v_who text := coalesce(auth.jwt() ->> 'email', 'unknown');
  v_consent text := nullif(trim(coalesce(p_consent, '')), '');
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
  insert into bi.customer_profile as p (member_id, name, birth_month, birth_day, area, address, customer_type, note,
                                        consent, consent_at, consent_by, next_contact, created_by, updated_by)
  values (v_key, nullif(trim(p_name), ''), p_birth_month, p_birth_day, nullif(trim(p_area), ''),
          nullif(trim(p_address), ''), nullif(trim(p_customer_type), ''), nullif(trim(p_note), ''),
          v_consent, case when v_consent is not null then now() end, case when v_consent is not null then v_who end,
          p_next_contact, v_who, v_who)
  on conflict (member_id) do update
     set name = excluded.name, birth_month = excluded.birth_month, birth_day = excluded.birth_day,
         area = excluded.area, address = excluded.address, customer_type = excluded.customer_type,
         note = excluded.note, next_contact = excluded.next_contact,
         consent = excluded.consent,
         consent_at = case when p.consent is distinct from excluded.consent then now() else p.consent_at end,
         consent_by = case when p.consent is distinct from excluded.consent then v_who else p.consent_by end,
         updated_at = now(), updated_by = v_who;
  return (select to_jsonb(x) from bi.customer_profile x where x.member_id = v_key);
end;
$$;

-- ── 按了 WhatsApp：记下联络时间；到期的下次联络日清掉 ──
create function public.bi_customer_touch(p_member text)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_key text := bi.customer_key(p_member);
  v_who text := coalesce(auth.jwt() ->> 'email', 'unknown');
  v_today date := (now() at time zone 'Asia/Kuala_Lumpur')::date;
begin
  perform bi.customer_require(array['owner', 'manager', 'sales']);
  if v_key is null then
    raise exception '看不出电话号码';
  end if;
  insert into bi.customer_profile as p (member_id, last_contact_at, created_by, updated_by)
  values (v_key, now(), v_who, v_who)
  on conflict (member_id) do update
     set last_contact_at = now(),
         next_contact = case when p.next_contact <= v_today then null else p.next_contact end;
  return (select to_jsonb(x) from bi.customer_profile x where x.member_id = v_key);
end;
$$;

-- ── 设定 ──
create function public.bi_customer_settings()
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
begin
  perform bi.customer_require(array['owner', 'manager', 'sales']);
  return (select to_jsonb(s) from bi.customer_settings s where s.id = 1);
end;
$$;

create function public.bi_customer_set_settings(
  p_vip_min_12m numeric, p_regular_min_docs int, p_lapsed_days int, p_lead_follow_days int, p_birthday_days int)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
begin
  perform bi.customer_require(array['owner']);
  if p_vip_min_12m < 0 or p_regular_min_docs < 1 or p_lapsed_days < 30 or p_lead_follow_days < 1 or p_birthday_days < 0 then
    raise exception '设定值不合理（VIP 门槛 ≥ 0、常客至少 1 张单、流失至少 30 天、潜在客跟进至少 1 天）';
  end if;
  update bi.customer_settings
     set vip_min_12m = p_vip_min_12m, regular_min_docs = p_regular_min_docs, lapsed_days = p_lapsed_days,
         lead_follow_days = p_lead_follow_days, birthday_days = p_birthday_days,
         updated_at = now(), updated_by = coalesce(auth.jwt() ->> 'email', 'unknown')
   where id = 1;
  return (select to_jsonb(s) from bi.customer_settings s where s.id = 1);
end;
$$;

-- ── WhatsApp 话术范本 ──
create function public.bi_wa_templates()
returns setof jsonb
language plpgsql stable security definer
set search_path = ''
as $$
begin
  perform bi.customer_require(array['owner', 'manager', 'sales']);
  return query select to_jsonb(t) from bi.customer_wa_template t order by t.sort, t.id;
end;
$$;

create function public.bi_wa_template_save(p_id bigint, p_title text, p_body text, p_sort int)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_who text := coalesce(auth.jwt() ->> 'email', 'unknown');
  v_id bigint := p_id;
begin
  perform bi.customer_require(array['owner', 'manager']);
  if nullif(trim(p_title), '') is null or nullif(trim(p_body), '') is null then
    raise exception '范本要有标题和内容';
  end if;
  if v_id is null then
    insert into bi.customer_wa_template (title, body, sort, updated_by)
    values (trim(p_title), trim(p_body), coalesce(p_sort, 0), v_who) returning id into v_id;
  else
    update bi.customer_wa_template
       set title = trim(p_title), body = trim(p_body), sort = coalesce(p_sort, sort), updated_at = now(), updated_by = v_who
     where id = v_id;
    if not found then raise exception '找不到范本 #%', v_id; end if;
  end if;
  return (select to_jsonb(t) from bi.customer_wa_template t where t.id = v_id);
end;
$$;

create function public.bi_wa_template_delete(p_id bigint)
returns void
language plpgsql volatile security definer
set search_path = ''
as $$
begin
  perform bi.customer_require(array['owner', 'manager']);
  delete from bi.customer_wa_template where id = p_id;
end;
$$;

-- ── 促销活动：建立（只收明确同意的顾客）、列表含成效、删除 ──
create function public.bi_campaign_create(p_name text, p_message text, p_sent_on date, p_members text[])
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_id bigint;
  v_n int;
begin
  perform bi.customer_require(array['owner', 'manager']);
  if nullif(trim(p_name), '') is null then
    raise exception '活动要有名称';
  end if;
  insert into bi.customer_campaign (name, message, sent_on, created_by)
  values (trim(p_name), nullif(trim(p_message), ''),
          coalesce(p_sent_on, (now() at time zone 'Asia/Kuala_Lumpur')::date), coalesce(auth.jwt() ->> 'email', 'unknown'))
  returning id into v_id;
  insert into bi.customer_campaign_member (campaign_id, member_id)
  select distinct v_id, p.member_id
    from unnest(coalesce(p_members, '{}')) m(id)
    join bi.customer_profile p on p.member_id = m.id and p.consent = 'yes';
  get diagnostics v_n = row_count;
  if v_n = 0 then
    raise exception '名单里没有「同意收促销」的顾客，活动没有建立';
  end if;
  return jsonb_build_object('id', v_id, 'members', v_n);
end;
$$;

create function public.bi_campaigns()
returns table (id bigint, name text, message text, sent_on date, created_by text, members int,
               buyers_30 int, revenue_30 numeric, buyers_60 int, revenue_60 numeric)
language plpgsql stable security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  perform bi.customer_require(array['owner', 'manager']);
  return query
  with cd as materialized (
    select x.member_id, x.doc_date, x.amount from bi.customer_doc x
     where x.member_id in (select m.member_id from bi.customer_campaign_member m)
  )
  select c.id, c.name, c.message, c.sent_on, c.created_by,
         (select count(*)::int from bi.customer_campaign_member m where m.campaign_id = c.id),
         count(distinct cd.member_id) filter (where cd.doc_date > c.sent_on and cd.doc_date <= c.sent_on + 30 and cd.amount > 0)::int,
         round(coalesce(sum(cd.amount) filter (where cd.doc_date > c.sent_on and cd.doc_date <= c.sent_on + 30), 0), 2),
         count(distinct cd.member_id) filter (where cd.doc_date > c.sent_on and cd.doc_date <= c.sent_on + 60 and cd.amount > 0)::int,
         round(coalesce(sum(cd.amount) filter (where cd.doc_date > c.sent_on and cd.doc_date <= c.sent_on + 60), 0), 2)
    from bi.customer_campaign c
    left join bi.customer_campaign_member m on m.campaign_id = c.id
    left join cd on cd.member_id = m.member_id
   group by c.id
   order by c.sent_on desc, c.id desc;
end;
$$;

create function public.bi_campaign_members(p_id bigint)
returns setof text
language plpgsql stable security definer
set search_path = ''
as $$
begin
  perform bi.customer_require(array['owner', 'manager']);
  return query select m.member_id from bi.customer_campaign_member m where m.campaign_id = p_id order by 1;
end;
$$;

create function public.bi_campaign_delete(p_id bigint)
returns void
language plpgsql volatile security definer
set search_path = ''
as $$
begin
  perform bi.customer_require(array['owner']);
  delete from bi.customer_campaign where id = p_id;
end;
$$;

-- ── 每月顾客报告：新客 / 回头客 / 流失；业务员带的回头客 ──
create function public.bi_customer_monthly(p_months int default 12)
returns table (month date, active int, new_customers int, returning_customers int,
               new_revenue numeric, returning_revenue numeric, lapsed int)
language plpgsql stable security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_lapsed int := (select s.lapsed_days from bi.customer_settings s where s.id = 1);
begin
  perform bi.customer_require(array['owner', 'manager', 'sales']);
  return query
  with cd as materialized (
    select x.member_id, x.doc_date, x.amount from bi.customer_doc x where x.member_id is not null
  ),
  firsts as (select cd.member_id, min(cd.doc_date) as first_date, max(cd.doc_date) as last_date from cd group by 1),
  months as (
    select generate_series(date_trunc('month', current_date) - make_interval(months => greatest(1, least(coalesce(p_months, 12), 48)) - 1),
                           date_trunc('month', current_date), interval '1 month')::date as m
  ),
  per as (
    select date_trunc('month', cd.doc_date)::date as m, cd.member_id, sum(cd.amount) as amt
      from cd group by 1, 2
  )
  select mo.m,
         count(distinct per.member_id) filter (where per.amt > 0)::int,
         count(distinct per.member_id) filter (where per.amt > 0 and date_trunc('month', f.first_date) = mo.m)::int,
         count(distinct per.member_id) filter (where per.amt > 0 and f.first_date < mo.m)::int,
         round(coalesce(sum(per.amt) filter (where date_trunc('month', f.first_date) = mo.m), 0), 2),
         round(coalesce(sum(per.amt) filter (where f.first_date < mo.m), 0), 2),
         (select count(*)::int from firsts l
           where l.last_date + v_lapsed >= mo.m and l.last_date + v_lapsed < (mo.m + interval '1 month')::date
             and l.last_date + v_lapsed <= current_date)
    from months mo
    left join per on per.m = mo.m
    left join firsts f on f.member_id = per.member_id
   group by mo.m
   order by mo.m;
end;
$$;

create function public.bi_customer_agents(p_from date, p_to date)
returns table (agent text, customers int, returning_customers int, new_customers int, revenue numeric)
language plpgsql stable security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  perform bi.customer_require(array['owner', 'manager', 'sales']);
  return query
  with cd as materialized (
    select x.member_id, x.doc_date, x.amount, coalesce(nullif(trim(x.sales_agent), ''), '(空白)') as agent
      from bi.customer_doc x where x.member_id is not null
  ),
  firsts as (select cd.member_id, min(cd.doc_date) as first_date from cd group by 1)
  select cd.agent,
         count(distinct cd.member_id) filter (where cd.amount > 0)::int,
         count(distinct cd.member_id) filter (where cd.amount > 0 and f.first_date < p_from)::int,
         count(distinct cd.member_id) filter (where cd.amount > 0 and f.first_date >= p_from)::int,
         round(sum(cd.amount), 2)
    from cd join firsts f on f.member_id = cd.member_id
   where cd.doc_date >= p_from and cd.doc_date <= p_to
   group by cd.agent
   order by 3 desc, 5 desc;
end;
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.bi_customers()', 'public.bi_customer_save(text,text,int,int,text,text,text,text,text,date)',
    'public.bi_customer_touch(text)', 'public.bi_customer_settings()',
    'public.bi_customer_set_settings(numeric,int,int,int,int)', 'public.bi_wa_templates()',
    'public.bi_wa_template_save(bigint,text,text,int)', 'public.bi_wa_template_delete(bigint)',
    'public.bi_campaign_create(text,text,date,text[])', 'public.bi_campaigns()', 'public.bi_campaign_members(bigint)',
    'public.bi_campaign_delete(bigint)', 'public.bi_customer_monthly(int)', 'public.bi_customer_agents(date,date)']
  loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
