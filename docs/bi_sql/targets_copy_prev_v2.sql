-- 2026-10-08：bi_target_copy_prev 改成「上个月没有目标」时不报错。migration：targets_copy_prev_v2。
-- 为什么：前端的「把上个月目标复制到本月」按钮会对每一家看得到的公司（总部 / JB / KL）各呼叫一次，
--   某家上个月没设目标是正常情况，不该让整个动作出现红字错误；改成回传 source = 0（上个月有几笔）、copied = 0。
-- 其余行为不变：只有 owner 能呼叫；已存在的目标不覆盖（on conflict do nothing）。
-- 回传 jsonb：{company, month, source: 上个月目标笔数, copied: 复制了几笔, skipped: 已存在而跳过几笔}
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
  v_copied int := 0;
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
  if v_total > 0 then
    insert into bi.target_month (company, month, scope, scope_key, amount, updated_by, updated_at)
    select t.company, v_month, t.scope, t.scope_key, t.amount, v_email, now()
      from bi.target_month t
     where t.company = p_company and t.month = v_prev
    on conflict (company, month, scope, scope_key) do nothing;
    get diagnostics v_copied = row_count;
  end if;
  return jsonb_build_object('company', p_company, 'month', v_month, 'source', v_total,
                            'copied', v_copied, 'skipped', v_total - v_copied);
end
$fn$;
