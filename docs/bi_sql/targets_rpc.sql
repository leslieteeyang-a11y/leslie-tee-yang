-- 2026-10-08：「目标」分页的写入 RPC。migration：targets_rpc。
-- 为什么用 RPC：bi.target_month 只开读取（RLS），前端角色没有 insert / update 权限；
--   写入一律经这两个 security definer 函数，函数内检查 public.bi_role() = 'owner'（与 bi_report_set_ads 同做法），
--   店长 / 订货员 / 业务员呼叫会收到「只有老板帐号能设定目标」。
-- search_path = ''：函数内所有物件都写完整 schema，避免被别的 schema 的同名物件劫持。
--
-- public.bi_target_set(p_company, p_month, p_scope, p_scope_key, p_amount)
--   设定 / 修改一个目标；p_amount 为 null 或 0 = 删除该目标（回到「未设定」）。
--   p_month 任何一天都可以，会自动换成月初；p_scope = 'company'（scope_key 自动 = 'ALL'）或 'channel'。
--   检查：公司必须是 BI 里有资料的公司（fact_sales 或分行电脑推送过）；渠道名必须是该公司真的出现过的渠道
--         （bi.mv_targets_daily 里有），避免打错字存出一个永远对不到实际值的目标；金额不能是负数；
--         月份限制在本月前 24 个月 ～ 后 12 个月（防止手误输入成别的年份）。
--   回传 jsonb：{company, month, scope, scope_key, amount, action: 'saved' | 'deleted' | 'nothing'}
--
-- public.bi_target_copy_prev(p_company, p_month)
--   把上个月的所有目标（公司总目标 + 渠道目标）复制到 p_month；p_month 已经有的目标不覆盖（on conflict do nothing），
--   回传 jsonb：{company, month, copied: 复制了几笔, skipped: 已存在而跳过几笔}
create or replace function public.bi_target_set(
  p_company text, p_month date, p_scope text, p_scope_key text, p_amount numeric)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $fn$
declare
  v_month     date;
  v_key       text;
  v_email     text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_cur_month date := date_trunc('month', now() at time zone 'Asia/Kuala_Lumpur')::date;
  v_n         int;
begin
  if coalesce((select public.bi_role()), '') <> 'owner' then
    raise exception '只有老板帐号（owner）能设定目标';
  end if;
  if p_company is null or btrim(p_company) = '' or p_month is null or p_scope is null then
    raise exception '公司、月份、范围都要填';
  end if;
  if p_scope not in ('company', 'channel') then
    raise exception '范围只能是 company（公司总目标）或 channel（渠道目标），收到 %', p_scope;
  end if;
  v_month := date_trunc('month', p_month)::date;
  if v_month < (v_cur_month - interval '24 months')::date or v_month > (v_cur_month + interval '12 months')::date then
    raise exception '月份 % 超出可设定范围（本月前 24 个月到后 12 个月）', to_char(v_month, 'YYYY-MM');
  end if;
  v_key := case when p_scope = 'company' then 'ALL' else nullif(btrim(coalesce(p_scope_key, '')), '') end;
  if v_key is null then
    raise exception '渠道目标要指定渠道名称';
  end if;
  if not exists (select 1 from bi.mv_targets_daily t where t.company = p_company)
     and not exists (select 1 from bi.branch_actual_meta m where m.company = p_company) then
    raise exception '不认得公司代码 %（BI 里没有它的销售资料，也没有分行电脑推送过）', p_company;
  end if;
  if p_scope = 'channel'
     and not exists (select 1 from bi.mv_targets_daily t where t.company = p_company and t.channel = v_key) then
    raise exception '% 没有渠道「%」的销售资料（渠道名称要与 BI 一致；分行电脑推送的公司只能设公司总目标）', p_company, v_key;
  end if;
  if p_amount is not null and p_amount < 0 then
    raise exception '目标金额不能是负数';
  end if;

  if coalesce(p_amount, 0) = 0 then
    delete from bi.target_month
     where company = p_company and month = v_month and scope = p_scope and scope_key = v_key;
    get diagnostics v_n = row_count;
    return jsonb_build_object('company', p_company, 'month', v_month, 'scope', p_scope, 'scope_key', v_key,
                              'amount', null, 'action', case when v_n > 0 then 'deleted' else 'nothing' end);
  end if;

  insert into bi.target_month (company, month, scope, scope_key, amount, updated_by, updated_at)
  values (p_company, v_month, p_scope, v_key, round(p_amount, 2), v_email, now())
  on conflict (company, month, scope, scope_key) do update
     set amount = excluded.amount, updated_by = excluded.updated_by, updated_at = excluded.updated_at;
  return jsonb_build_object('company', p_company, 'month', v_month, 'scope', p_scope, 'scope_key', v_key,
                            'amount', round(p_amount, 2), 'action', 'saved');
end
$fn$;

create or replace function public.bi_target_copy_prev(p_company text, p_month date)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $fn$
declare
  v_month  date;
  v_prev   date;
  v_email  text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_total  int;
  v_copied int;
begin
  if coalesce((select public.bi_role()), '') <> 'owner' then
    raise exception '只有老板帐号（owner）能设定目标';
  end if;
  if p_company is null or p_month is null then
    raise exception '公司、月份都要填';
  end if;
  v_month := date_trunc('month', p_month)::date;
  v_prev  := (v_month - interval '1 month')::date;
  select count(*) into v_total from bi.target_month where company = p_company and month = v_prev;
  if v_total = 0 then
    raise exception '% 的 % 没有任何目标可以复制', p_company, to_char(v_prev, 'YYYY-MM');
  end if;
  insert into bi.target_month (company, month, scope, scope_key, amount, updated_by, updated_at)
  select t.company, v_month, t.scope, t.scope_key, t.amount, v_email, now()
    from bi.target_month t
   where t.company = p_company and t.month = v_prev
  on conflict (company, month, scope, scope_key) do nothing;
  get diagnostics v_copied = row_count;
  return jsonb_build_object('company', p_company, 'month', v_month, 'copied', v_copied, 'skipped', v_total - v_copied);
end
$fn$;

grant execute on function public.bi_target_set(text, date, text, text, numeric) to authenticated;
grant execute on function public.bi_target_copy_prev(text, date) to authenticated;
