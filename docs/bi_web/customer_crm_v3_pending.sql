-- 顾客资料第三版最后一批（migration customer_crm_v3_replace_functions），含 DROP / DELETE，要使用者在 Supabase 提示按确认。套用后删掉这个档。

drop function if exists bi.customer_v3_probe();

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

revoke all on function public.bi_quote_upsert(text, jsonb) from public, anon, authenticated;
grant execute on function public.bi_quote_upsert(text, jsonb) to service_role;

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

revoke all on function public.bi_customers() from public, anon;
grant execute on function public.bi_customers() to authenticated;
revoke all on function public.bi_customer_merge(text, text) from public, anon;
grant execute on function public.bi_customer_merge(text, text) to authenticated;
revoke all on function public.bi_customer_unmerge(text) from public, anon;
grant execute on function public.bi_customer_unmerge(text) to authenticated;
revoke all on function public.bi_customer_set_settings(numeric,int,int,int,int,int,int,int,jsonb) from public, anon;
grant execute on function public.bi_customer_set_settings(numeric,int,int,int,int,int,int,int,jsonb) to authenticated;
