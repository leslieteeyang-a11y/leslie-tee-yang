-- 顾客资料第二版（2026-10-15）：使用者问「还可以怎么让我更能锁住老顾客？」，看了数据后选了三项：
--   ① 新客 30 天回访：第一次买后第 7 天、第 21 天出现在「跟进提醒」（回头的顾客有一半在 22 天内买第二次、81% 在 90 天内；
--      过了就很难回来）。只算有电话、只来买过一次、没说「不收促销」的；店员自己约了以后的联络日就照约的。
--   ② 首页「今天要跟进」+ 员工排行：跟进提醒改在资料库算（bi_customer_followups，顾客页与首页共用同一套规则），
--      首页只拿人数（ops_cust_home）；「报告」多员工排行（登记 / 联络 / 取得同意）与业务员新客回头率（bi_customer_staff_board）。
--   ③ 登记送延长保修（「Hemos 保修登记」，只算 Hemos 产品）：顾客扫码登记（或店员按「登记延长保修」）就记下登记时间、当时的延长月数
--      与起算日（登记前 N 天）；之后改设定不影响已登记的。月数在「设定」由管理员填，**0 = 不送**（预设 0：登记页不会出现保修字样）。
-- 资料都在 BI 的 bi.customer_*（与 20261016_ops_customers.sql 同样不搬家）；新函数开头一律 bi.crm_require（读取的第二个参数 true）。
-- 对 AutoCount 仍只读。可以重复套用，不含 DROP / DELETE。

-- ------------------------------------------------------------ ③ 延长保修：栏位与设定
alter table bi.customer_profile add column if not exists warranty_at timestamptz;      -- 第一次登记延长保修的时间
alter table bi.customer_profile add column if not exists warranty_months smallint;     -- 登记当时答应延长几个月（之后改设定不影响已登记的）
alter table bi.customer_profile add column if not exists warranty_by text;             -- 谁登记的（顾客自己扫码 / 店员 email）
alter table bi.customer_profile add column if not exists warranty_from date;           -- 从哪天买的算（登记日 - 当时的「登记前几天」）
alter table bi.customer_settings add column if not exists warranty_months smallint not null default 0;     -- 0 = 不送
alter table bi.customer_settings add column if not exists warranty_back_days smallint not null default 90;  -- 登记前几天内的购买也算

-- 扫码登记送出即生效（customer_signup_apply 是 BI 的共用写入规则）：送保修的期间第一次登记就记下来；其余照旧
create or replace function bi.customer_signup_apply(p_id bigint, p_actor text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  s bi.customer_signup;
  v_key text;
  v_consent text;
  v_months smallint := (select st.warranty_months from bi.customer_settings st where st.id = 1);
  v_from date := (now() at time zone 'Asia/Kuala_Lumpur')::date
                 - coalesce((select st.warranty_back_days from bi.customer_settings st where st.id = 1), 0);
begin
  select * into s from bi.customer_signup x where x.id = p_id;
  if not found then
    raise exception '找不到登记 #%', p_id;
  end if;
  v_key := bi.customer_key(s.member_id);
  v_consent := case when s.consent then 'yes' else 'no' end;
  perform set_config('bi.actor', p_actor, true);
  insert into bi.customer_profile as p (member_id, name, birth_month, birth_day, area, address, email, consent, consent_at,
                                        consent_by, created_by, updated_by, warranty_at, warranty_months, warranty_by, warranty_from)
  values (v_key, s.name, s.birth_month, s.birth_day, s.area, s.address, s.email, v_consent, now(), p_actor, p_actor, p_actor,
          case when coalesce(v_months, 0) > 0 then now() end, nullif(coalesce(v_months, 0), 0),
          case when coalesce(v_months, 0) > 0 then p_actor end, case when coalesce(v_months, 0) > 0 then v_from end)
  on conflict (member_id) do update
     set name = coalesce(p.name, excluded.name),
         birth_month = case when p.birth_month is null then excluded.birth_month else p.birth_month end,
         birth_day = case when p.birth_month is null then excluded.birth_day else p.birth_day end,
         area = coalesce(p.area, excluded.area),
         address = coalesce(excluded.address, p.address),
         email = coalesce(excluded.email, p.email),
         consent = excluded.consent,
         consent_at = case when p.consent is distinct from excluded.consent then now() else p.consent_at end,
         consent_by = case when p.consent is distinct from excluded.consent then excluded.consent_by else p.consent_by end,
         -- 已经登记过保修的不改（时间、月数、起算日都以第一次为准）
         warranty_at = coalesce(p.warranty_at, excluded.warranty_at),
         warranty_months = case when p.warranty_at is null then excluded.warranty_months else p.warranty_months end,
         warranty_by = case when p.warranty_at is null then excluded.warranty_by else p.warranty_by end,
         warranty_from = case when p.warranty_at is null then excluded.warranty_from else p.warranty_from end,
         updated_at = now(), updated_by = p_actor;
  update bi.customer_signup x set status = 'confirmed', handled_at = now(), handled_by = p_actor where x.id = p_id;
  return v_key;
end;
$$;
revoke all on function bi.customer_signup_apply(bigint, text) from public, anon, authenticated;

-- 公开的登记页（BI join.html，不用登入）读：现在送不送、送几个月
create or replace function public.bi_customer_signup_offer() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('warranty_months', coalesce(s.warranty_months, 0), 'warranty_back_days', coalesce(s.warranty_back_days, 0))
    from bi.customer_settings s where s.id = 1
$$;
revoke all on function public.bi_customer_signup_offer() from public;
grant execute on function public.bi_customer_signup_offer() to anon, authenticated;

-- 店员在柜台帮顾客登记延长保修（顾客没扫码时）
create or replace function public.bi_customer_warranty_register(p_member text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_key text := bi.customer_key(p_member);
  v_who text := coalesce(auth.jwt() ->> 'email', 'unknown');
  v_months smallint := (select s.warranty_months from bi.customer_settings s where s.id = 1);
  v_from date := (now() at time zone 'Asia/Kuala_Lumpur')::date
                 - coalesce((select s.warranty_back_days from bi.customer_settings s where s.id = 1), 0);
begin
  perform bi.crm_require(array['owner', 'manager', 'sales']);
  if v_key is null or v_key like 'A:%' then
    raise exception '看不出电话号码：延长保修要用顾客的手机号登记';
  end if;
  if coalesce(v_months, 0) <= 0 then
    raise exception '还没开延长保修：请管理员在「顾客资料 → 设定」填延长几个月';
  end if;
  insert into bi.customer_profile as p (member_id, created_by, updated_by, warranty_at, warranty_months, warranty_by, warranty_from)
  values (v_key, v_who, v_who, now(), v_months, v_who, v_from)
  on conflict (member_id) do update
     set warranty_at = coalesce(p.warranty_at, excluded.warranty_at),
         warranty_months = case when p.warranty_at is null then excluded.warranty_months else p.warranty_months end,
         warranty_by = case when p.warranty_at is null then excluded.warranty_by else p.warranty_by end,
         warranty_from = case when p.warranty_at is null then excluded.warranty_from else p.warranty_from end,
         updated_at = case when p.warranty_at is null then now() else p.updated_at end,
         updated_by = case when p.warranty_at is null then v_who else p.updated_by end;
  return (select to_jsonb(x) from bi.customer_profile x where x.member_id = v_key);
end $$;
revoke all on function public.bi_customer_warranty_register(text) from public, anon;
grant execute on function public.bi_customer_warranty_register(text) to authenticated;

-- 管理员设定：送几个月（0 = 不送）、登记前几天内的购买也算
create or replace function public.bi_customer_set_warranty(p_months integer, p_back_days integer) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_who text := coalesce(auth.jwt() ->> 'email', 'unknown');
begin
  perform bi.crm_require(array['owner']);
  if p_months is null or p_months < 0 or p_months > 60 or p_back_days is null or p_back_days < 0 or p_back_days > 365 then
    raise exception '延长保修设定不合理（月数 0～60，登记前 0～365 天）';
  end if;
  update bi.customer_settings s
     set warranty_months = p_months, warranty_back_days = p_back_days, updated_at = now(), updated_by = v_who
   where s.id = 1;
  return (select to_jsonb(s) from bi.customer_settings s where s.id = 1);
end $$;
revoke all on function public.bi_customer_set_warranty(integer, integer) from public, anon;
grant execute on function public.bi_customer_set_warranty(integer, integer) to authenticated;

-- 顾客扫码登记（BI join.html 用的 9 参数版）：跟正式环境原本一字不差，只多回传「资料库实际记下的」保修月数，
-- 完成页照这个显示（以前登记过的以第一次为准；送出前管理员刚关掉的就不显示）
create or replace function public.bi_customer_signup(p_phone text, p_name text, p_birth_month integer, p_birth_day integer,
                                                     p_area text, p_consent boolean, p_store text, p_address text, p_email text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_key text := bi.customer_phone(p_phone);
  v_name text := nullif(trim(p_name), '');
  v_area text := nullif(trim(p_area), '');
  v_addr text := nullif(trim(p_address), '');
  v_email text := lower(nullif(trim(p_email), ''));
  v_store text := nullif(upper(trim(p_store)), '');
  v_id bigint;
  v_member text;
begin
  if v_key is null then
    raise exception '电话号码看不懂，请输入完整手机号，例如 012-345 6789';
  end if;
  if v_name is null then
    raise exception '请填名字';
  end if;
  if length(v_name) > 60 or length(coalesce(v_area, '')) > 60 or length(coalesce(v_addr, '')) > 300 then
    raise exception '名字或地址太长';
  end if;
  if v_email is not null and (length(v_email) > 120 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$') then
    raise exception '电邮地址格式不对';
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
  insert into bi.customer_signup (member_id, name, birth_month, birth_day, area, address, email, consent, store)
  values (v_key, v_name, p_birth_month, p_birth_day, v_area, v_addr, v_email, coalesce(p_consent, false), v_store)
  returning id into v_id;
  v_member := bi.customer_signup_apply(v_id, '顾客自己扫码登记' || coalesce('（' || v_store || '）', ''));
  return jsonb_build_object('ok', true,
                            'warranty_months', (select p.warranty_months from bi.customer_profile p
                                                 where p.member_id = v_member and p.warranty_at is not null));
end;
$$;
revoke all on function public.bi_customer_signup(text, text, integer, integer, text, boolean, text, text, text) from public;
grant execute on function public.bi_customer_signup(text, text, integer, integer, text, boolean, text, text, text)
  to anon, authenticated;

-- 合并重复顾客：跟正式环境原本一字不差，另外把电邮与延长保修一起搬过来（以前合并时这几栏会跟着被删掉的号码不见）。
-- 两边都登记过保修就留比较早的那次（时间、月数、起算日、谁登记的一起）
create or replace function public.bi_customer_merge(p_keep text, p_drop text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_who text := coalesce(auth.jwt() ->> 'email', 'unknown');
  v_keep text := bi.customer_key(p_keep);
  v_drop text := case when p_drop ~ '^A:' then p_drop else bi.customer_phone(p_drop) end;
  d bi.customer_profile;
begin
  perform bi.crm_require(array['owner', 'manager']);
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
             email = coalesce(p.email, d.email),
             warranty_at = case when d.warranty_at < p.warranty_at or p.warranty_at is null then d.warranty_at else p.warranty_at end,
             warranty_months = case when d.warranty_at < p.warranty_at or p.warranty_at is null then d.warranty_months else p.warranty_months end,
             warranty_by = case when d.warranty_at < p.warranty_at or p.warranty_at is null then d.warranty_by else p.warranty_by end,
             warranty_from = case when d.warranty_at < p.warranty_at or p.warranty_at is null then d.warranty_from else p.warranty_from end,
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
revoke all on function public.bi_customer_merge(text, text) from public, anon;
grant execute on function public.bi_customer_merge(text, text) to authenticated;

-- 一位顾客：跟正式环境原本一字不差，只在购买明细每一行多 brand（AutoCount 的 ItemType：HEMOS / HEMOSX / VATTI…），
-- 顾客页用它只在有 Hemos 产品的单标「保修」
create or replace function public.bi_customer(p_member text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_key text := bi.customer_key(p_member);
  v_docs jsonb;
begin
  perform bi.crm_require(array['owner', 'manager', 'sales'], true);
  if v_key is null then
    raise exception '看不出电话号码：请输入完整手机号，例如 012-3456789 或 +65 9123 4567';
  end if;
  select coalesce(jsonb_agg(x order by x.doc_date desc, x.doc_no desc), '[]'::jsonb) into v_docs
    from (
      select cd.company, cd.doc_type, cd.doc_no, cd.doc_date, cd.debtor_code, cd.debtor_name,
             cd.sales_agent, round(cd.amount, 2) as amount,
             (select coalesce(jsonb_agg(jsonb_build_object(
                        'item_code', f.item_code, 'description', f.item_description,
                        'qty', f.qty, 'uom', f.uom, 'sub_total', f.sub_total, 'brand', i.item_type)
                      order by f.dtl_key), '[]'::jsonb)
                from bi.fact_sales f
                left join bi.dim_item i on i.company = f.company and i.item_code = f.item_code
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
revoke all on function public.bi_customer(text) from public, anon;
grant execute on function public.bi_customer(text) to authenticated;

-- ------------------------------------------------------------ ①② 跟进提醒（顾客页「跟进」与首页共用）
-- 规则与 BI 顾客资料页的 followUps()（Loyalty.tsx）相同，另加「新客回访」：
--   due      约好的下次联络日到了
--   quote    报价开出 N 天还没成交（没转单、之后也没买），而且从该跟进那天起还没联络
--   birthday N 天内生日，这段期间还没联络过
--   new      新客：只来买过一次（之后的退货 CN 不算回来）、有电话、没说不收促销；第 7 天、第 21 天各一次（之前联络过就不重复），
--            （例外：第一天开了两张以上的单、之后又退货的，会被当成回来过——一年约 3 位；要分得出来得再扫一次全部单据，清单会慢约 0.8 秒，不值得）
--            45 天后不再追；刚到第 7 / 21 天的排前面（回头的一半在 22 天内，越早联络越有用）；约了以后的联络日就照约的
--   stage    装修进度太久没更新（完工的不追）
--   lead     潜在客（没买过）建档 N 天还没联络
-- p_store：'HQ' / 'JB' 只看那间门市买过的；没买过的看报价单是哪间开的；都没有的（潜在客）两边都列；其他 = 全部。
-- 回传 [{member_id, reasons:[{kind, days}]}]，最急的在前（同样急的，最近来过的在前，跟顾客名单一样）。
create or replace function public.bi_customer_followups(p_store text default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  s bi.customer_settings;
  v_today date := (now() at time zone 'Asia/Kuala_Lumpur')::date;
  v_store text := case when p_store in ('HQ', 'JB') then p_store end;
begin
  perform bi.crm_require(array['owner', 'manager', 'sales'], true);
  select * into s from bi.customer_settings x where x.id = 1;
  return coalesce((
    with qs as (
      -- 没买过的顾客：报价单在哪间门市开的
      select q.member_id, string_agg(distinct case q.company when 'HOMEWORKSSB' then 'HQ' else 'JB' end, ' + ') as stores
        from bi.customer_quote q where q.member_id is not null and not q.transferred group by q.member_id
    )
    select jsonb_agg(jsonb_build_object('member_id', f.member_id, 'reasons', f.reasons)
                     order by f.rank, f.last_date desc nulls last, f.member_id)
      from (
        select c.member_id, c.last_date, r.reasons, r.rank, coalesce(c.stores, qs.stores) as stores
          from public.bi_customers() c
          left join qs on qs.member_id = c.member_id
          cross join lateral (
            select v_today - (c.last_contact_at at time zone 'Asia/Kuala_Lumpur')::date as contacted,
                   v_today - c.first_date as age,
                   -- 生日：这个月的 1 号 + (日 - 1)，2/29 在平年自然变 3/1（跟 BI 页的 JS 一样）；月 / 日不合理的不算，免得整份清单出错
                   case when c.birth_month between 1 and 12 and c.birth_day between 1 and 31 then
                     (select case when b >= v_today then b
                                  else make_date(extract(year from v_today)::int + 1, c.birth_month, 1) + (c.birth_day - 1) end - v_today
                        from (select make_date(extract(year from v_today)::int, c.birth_month, 1) + (c.birth_day - 1) as b) bb)
                   end as bday
          ) v
          cross join lateral (
            select jsonb_agg(jsonb_build_object('kind', k.kind, 'days', k.days) order by k.rank) as reasons, min(k.rank) as rank
              from (
                select 'due' as kind, v_today - c.next_contact as days, 0 as rank
                 where c.next_contact <= v_today
                union all
                select 'quote', (v_today - c.quote_due) + s.quote_follow_days, 50
                 where c.quote_due is not null
                   and (c.last_contact_at is null or (c.last_contact_at at time zone 'Asia/Kuala_Lumpur')::date < c.quote_due)
                union all
                select 'birthday', v.bday, 100 + v.bday
                 where v.bday is not null and v.bday <= s.birthday_days
                   and not coalesce(v.contacted <= s.birthday_days - v.bday, false)
                union all
                select 'new', v.age, 200 + v.age - case when v.age >= 21 then 21 else 7 end
                 where c.first_date is not null and c.doc_count >= 1 and (c.first_date = c.last_date or c.doc_count = 1)
                   and c.member_id ~ '^[0-9]+$' and c.consent is distinct from 'no'
                   and v.age between 7 and 45
                   and not coalesce(c.next_contact > v_today, false)
                   and (c.last_contact_at is null
                        or (c.last_contact_at at time zone 'Asia/Kuala_Lumpur')::date
                           < c.first_date + case when v.age >= 21 then 21 else 7 end)
                union all
                select 'stage', v_today - (c.reno_stage_at at time zone 'Asia/Kuala_Lumpur')::date, 500
                 where c.reno_stage is not null and c.reno_stage <> 'done' and c.reno_stage_at is not null
                   and v_today - (c.reno_stage_at at time zone 'Asia/Kuala_Lumpur')::date >= s.stage_follow_days
                   and not coalesce(v.contacted < s.stage_follow_days, false)
                union all
                select 'lead', v_today - (c.profile_created_at at time zone 'Asia/Kuala_Lumpur')::date, 1000
                 where c.last_date is null and c.profile_created_at is not null and c.last_contact_at is null
                   and not coalesce(c.next_contact > v_today, false)
                   and v_today - (c.profile_created_at at time zone 'Asia/Kuala_Lumpur')::date >= s.lead_follow_days
              ) k
          ) r
         where r.reasons is not null
      ) f
     where v_store is null or f.stores is null or f.stores like '%' || v_store || '%'
  ), '[]'::jsonb);
end $$;
revoke all on function public.bi_customer_followups(text) from public, anon;
grant execute on function public.bi_customer_followups(text) to authenticated;

-- ------------------------------------------------------------ ② 员工排行（「报告」分页）
-- staff：这段期间各员工在顾客资料做的事（修改纪录 bi.customer_profile_log），都算「几位顾客」，同一位按很多次只算一次：
--        联络、登记（名字 / 生日 / 同意 / 电邮 / 保修 任一项从空白填上，不管是新建档还是补资料；只按「已联络」自动建的空档、只补送货地址的不算——
--        送货页的物流同事也会补地址）、
--        取得「同意收促销」。顾客自己扫码另列一行；合并重复顾客时搬过去的资料不算（by 后面有「（合并）」）。
-- agents：业务员新客回头率（AutoCount 单上的业务员）：3～6 个月前第一次来买的新客，90 天内回来买第二次的比例（门市散客才算）
-- 一笔修改纪录算不算「登记」：名字 / 生日 / 同意 / 电邮 / 保修 任一项从空白变成有值（changes 每栏是 [旧, 新]）；地址不算（送货页也会写）
create or replace function bi.customer_log_registers(p_changes jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select exists (select 1 from unnest(array['name', 'birth_month', 'consent', 'email', 'warranty_at']) k
                  where p_changes ? k
                    and coalesce(p_changes -> k -> 0, 'null'::jsonb) = 'null'::jsonb
                    and coalesce(p_changes -> k -> 1, 'null'::jsonb) <> 'null'::jsonb)
$$;
revoke all on function bi.customer_log_registers(jsonb) from public, anon, authenticated;

create or replace function public.bi_customer_staff_board(p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_today date := (now() at time zone 'Asia/Kuala_Lumpur')::date;
begin
  perform bi.crm_require(array['owner', 'manager', 'sales'], true);
  return jsonb_build_object(
    'staff', (
      select coalesce(jsonb_agg(jsonb_build_object('by', x.by, 'name', x.name, 'contacts', x.contacts, 'registered', x.registered,
                                                   'consents', x.consents)
                                order by x.contacts + x.registered + x.consents desc, x.by), '[]'::jsonb)
        from (
          select l.by,
                 coalesce((select st.name from ops.staff st where lower(st.email) = lower(l.by) limit 1),
                          case when l.by ~ '^[^@\s（）]+@[^@\s（）]+$' then split_part(l.by, '@', 1) else l.by end) as name,
                 count(distinct l.member_id) filter (where l.changes ? 'last_contact_at')::int as contacts,
                 count(distinct l.member_id) filter (where bi.customer_log_registers(l.changes))::int as registered,
                 count(distinct l.member_id) filter (where l.changes -> 'consent' ->> 1 = 'yes')::int as consents
            from bi.customer_profile_log l
           where (l.at at time zone 'Asia/Kuala_Lumpur')::date between p_from and p_to
             and l.by is not null and l.by not like '%（合并）'
           group by l.by
        ) x
       where x.contacts + x.registered + x.consents > 0),
    'agents', (
      with d as materialized (
        select cd.member_id, cd.company, cd.doc_date, cd.amount, coalesce(nullif(trim(cd.sales_agent), ''), '(空白)') as agent
          from bi.customer_doc cd where cd.member_id is not null and cd.amount > 0
      ),
      firsts as (
        select distinct on (d.member_id) d.member_id, d.company, d.doc_date as first_date, d.agent
          from d order by d.member_id, d.doc_date, d.amount desc
      ),
      seconds as (
        select d.member_id, min(d.doc_date) as second_date
          from d join firsts f on f.member_id = d.member_id and d.doc_date > f.first_date
         group by d.member_id
      )
      select coalesce(jsonb_agg(jsonb_build_object('company', a.company, 'agent', a.agent, 'new_customers', a.n,
                                                   'returned_90', a.r) order by a.company, a.n desc), '[]'::jsonb)
        from (
          select f.company, f.agent, count(*)::int as n,
                 count(*) filter (where s2.second_date <= f.first_date + 90)::int as r
            from firsts f left join seconds s2 on s2.member_id = f.member_id
           where f.first_date between v_today - 180 and v_today - 90
           group by f.company, f.agent
        ) a
       where a.n >= 5),
    'cohort_from', v_today - 180, 'cohort_to', v_today - 90);
end $$;
revoke all on function public.bi_customer_staff_board(date, date) from public, anon;
grant execute on function public.bi_customer_staff_board(date, date) to authenticated;

-- ------------------------------------------------------------ ② 首页卡片：今天要跟进几位、这个月我做了多少
-- 营运系统员工照自己的分店（全部分店 = 两边）；没有顾客资料权限 → null（首页不显示这张卡，不报错）
create or replace function public.ops_cust_home() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_role text := public.ops_cust_role();
  v_store text := case bi.crm_company() when 'HOMEWORKSSB' then 'HQ' when 'HOMEWORKSSOUTHERN' then 'JB' end;
  v_me text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_month date := date_trunc('month', (now() at time zone 'Asia/Kuala_Lumpur'))::date;
  v_list jsonb;
begin
  if v_role is null then
    return null;
  end if;
  v_list := public.bi_customer_followups(v_store);
  return jsonb_build_object(
    'store', v_store,
    'total', jsonb_array_length(v_list),
    'by_kind', (select coalesce(jsonb_object_agg(k.kind, k.n), '{}'::jsonb)
                  from (select r ->> 'kind' as kind, count(distinct e ->> 'member_id')::int as n
                          from jsonb_array_elements(v_list) e, jsonb_array_elements(e -> 'reasons') r group by 1) k),
    'my_contacts', (select count(distinct l.member_id)::int from bi.customer_profile_log l
                     where lower(l.by) = v_me and l.changes ? 'last_contact_at'
                       and (l.at at time zone 'Asia/Kuala_Lumpur')::date >= v_month),
    'my_registered', (select count(distinct l.member_id)::int from bi.customer_profile_log l
                       where lower(l.by) = v_me and bi.customer_log_registers(l.changes)
                         and (l.at at time zone 'Asia/Kuala_Lumpur')::date >= v_month));
end $$;
revoke all on function public.ops_cust_home() from public, anon;
grant execute on function public.ops_cust_home() to authenticated;
