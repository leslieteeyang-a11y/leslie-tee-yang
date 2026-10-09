-- 2026-10-08：「没成本明细 CSV」RPC 提速，migration：margin_nocost_lines_v2。
--
-- 为什么：第一版在 WHERE 里直接写 date_trunc('month', p_from)::date。date_trunc(date) 会先转成 timestamptz，
-- 属于 stable 函数，规划时不能折成常数，planner 估不出日期范围，近 12 个月 HQ 实测 2.5 秒；
-- 同一个查询把日期写成常数只要 0.27 秒。改成先算好 v_start / v_end 两个 date 变数再查
-- （plpgsql 的 custom plan 会把变数当常数），并把「不含分行」改成只在需要时才算渠道。
-- 函数签名、权限检查、回传 jsonb 结构都不变。

create or replace function public.bi_margin_nocost_lines(
  p_company   text,
  p_from      date,
  p_to        date,
  p_ex_branch boolean default false
)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
set work_mem to '16MB'
as $$
declare
  v_co    text;
  v_start date;
  v_end   date;
  v_exb   boolean := coalesce(p_ex_branch, false);
  v_out   jsonb;
begin
  if not coalesce((select public.bi_is_allowed()), false) then
    raise exception '这个账号不在 BI 白名单';
  end if;
  if coalesce((select public.bi_role()), '') <> 'owner' then
    raise exception '毛利分析只有老板账号可以看';
  end if;
  v_co := (select public.bi_company());
  if v_co is not null and v_co <> p_company then
    raise exception '这个账号只能看 % 的资料', v_co;
  end if;
  if p_from is null or p_to is null or p_from > p_to then
    raise exception '期间不正确（开始 % / 结束 %）', p_from, p_to;
  end if;

  v_start := make_date(extract(year from p_from)::integer, extract(month from p_from)::integer, 1);
  v_end   := (make_date(extract(year from p_to)::integer, extract(month from p_to)::integer, 1) + interval '1 month')::date;

  select coalesce(jsonb_agg(jsonb_build_object(
           'doc_type', x.doc_type, 'doc_no', x.doc_no, 'doc_date', x.doc_date,
           'debtor_code', x.debtor_code, 'debtor_name', x.debtor_name, 'channel', x.channel,
           'item_code', x.item_code, 'desc', x.descr, 'grp', x.item_group,
           'qty', x.qty, 'uom', x.uom, 'unit_price', x.unit_price, 'sub_total', x.sub_total,
           'sales_agent', x.sales_agent)
         order by x.doc_date, x.doc_no), '[]'::jsonb)
    into v_out
  from (
    select s.doc_type, s.doc_no, s.doc_date, s.debtor_code, s.debtor_name,
           bi.sale_channel(s.debtor_code, c.debtor_type) as channel,
           s.item_code, coalesce(i.description, s.item_description) as descr, i.item_group,
           s.qty, s.uom, s.unit_price, s.sub_total, s.sales_agent
    from bi.fact_sales s
    left join bi.dim_item     i on i.company = s.company and i.item_code   = s.item_code
    left join bi.dim_customer c on c.company = s.company and c.debtor_code = s.debtor_code
    where s.company = p_company
      and s.doc_date >= v_start
      and s.doc_date <  v_end
      and coalesce(s.cost, 0) = 0
      and s.sub_total <> 0
      and coalesce(s.item_code, '') <> ''
      and coalesce(i.item_group, '') not in ('ONLINE','SHIP FEE','PAY FEE','TRAN FEE','SERV FEE','INSTALL','TRANSPOR',
                                             'DELIVERY','SERV INC','CARD INT','GST')
      and (not v_exb or bi.sale_channel(s.debtor_code, c.debtor_type) <> '分行')
    order by s.doc_date, s.doc_no
    limit 5000
  ) x;

  return v_out;
end $$;

revoke execute on function public.bi_margin_nocost_lines(text, date, date, boolean) from public, anon;
grant execute on function public.bi_margin_nocost_lines(text, date, date, boolean) to authenticated, service_role;
