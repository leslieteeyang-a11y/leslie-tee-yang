-- 2026-10-08：「没成本明细 CSV」RPC 第 3 版，migration：margin_nocost_lines_v3。
--
-- 为什么：毛利分析的「有成本」改成「成本与销售同号」（见 margin_badcost_mv），所以成本异号的商品行
-- （例：发票卖 RM 212.25、成本 −0.92）也要列进给会计的明细；并多回一栏 cost，让会计看得出是「没填」还是「填错」。
-- 函数签名与权限检查不变；回传每行多一个 cost 键（前端 CSV 多一栏 Cost）。

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
           'sales_agent', x.sales_agent, 'cost', x.cost)
         order by x.doc_date, x.doc_no), '[]'::jsonb)
    into v_out
  from (
    select s.doc_type, s.doc_no, s.doc_date, s.debtor_code, s.debtor_name,
           bi.sale_channel(s.debtor_code, c.debtor_type) as channel,
           s.item_code, coalesce(i.description, s.item_description) as descr, i.item_group,
           s.qty, s.uom, s.unit_price, s.sub_total, s.sales_agent, coalesce(s.cost, 0) as cost
    from bi.fact_sales s
    left join bi.dim_item     i on i.company = s.company and i.item_code   = s.item_code
    left join bi.dim_customer c on c.company = s.company and c.debtor_code = s.debtor_code
    where s.company = p_company
      and s.doc_date >= v_start
      and s.doc_date <  v_end
      and s.sub_total <> 0
      and (coalesce(s.cost, 0) = 0 or s.sub_total * s.cost < 0)   -- 没成本，或成本与销售异号
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
