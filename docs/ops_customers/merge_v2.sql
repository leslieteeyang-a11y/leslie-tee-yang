-- 顾客资料第二版：合并重复顾客时把电邮与延长保修一起搬过去（2026-10-15）。
-- 这段含删除语句，Supabase 连接器会卡在确认，所以请使用者贴进 Supabase SQL Editor 执行：
-- https://supabase.com/dashboard/project/vwljnypzgfqhatkgulqs/sql/new → 贴上 → Run（问 destructive 就按 Run query）。
-- 内容与 portal/supabase/migrations/20261018_ops_customers_v2.sql 里的 bi_customer_merge 一样；可以重复执行。

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
