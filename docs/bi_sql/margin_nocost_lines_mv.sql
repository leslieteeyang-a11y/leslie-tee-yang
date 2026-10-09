-- 2026-10-08：「没成本明细 CSV」改读物化视图，migration：margin_nocost_lines_mv。
--
-- 为什么：bi_margin_nocost_lines 直接查 fact_sales（HQ 近 12 个月要走索引读约 13 万行），
-- 同一个连线第二次只要 0.36 秒，但新连线第一次常常 2.5～2.7 秒（资料页不在共享缓冲区，这台机器只有 224MB），
-- 超过 1.5 秒的目标。没成本 / 成本异号的商品行其实很少（近 24 个月两家合计约 6～7 千行），
-- 所以另建 bi.mv_margin_nocost_lines 存这些明细，跟其他毛利物化视图一起每 2 小时重算；
-- 好处之二：CSV 与页面上的 KPI 来自同一次重算，行数、金额一定对得上。
-- 口径与 margin_nocost_lines_v3 相同：商品行（排除服务 / 费用群组与没商品代号的行）、sub_total <> 0、
-- 成本 = 0 或成本与销售异号。

create materialized view if not exists bi.mv_margin_nocost_lines as
select s.company, s.doc_type, s.doc_key, s.dtl_key, s.doc_no, s.doc_date,
       s.debtor_code, s.debtor_name,
       bi.sale_channel(s.debtor_code, c.debtor_type)       as channel,
       s.item_code,
       coalesce(i.description, s.item_description)        as descr,
       i.item_group,
       s.qty, s.uom, s.unit_price, s.sub_total,
       coalesce(s.cost, 0)                                 as cost,
       s.sales_agent
from bi.fact_sales s
left join bi.dim_item     i on i.company = s.company and i.item_code   = s.item_code
left join bi.dim_customer c on c.company = s.company and c.debtor_code = s.debtor_code
where s.doc_date >= (date_trunc('month', current_date) - interval '24 months')::date
  and s.sub_total <> 0
  and (coalesce(s.cost, 0) = 0 or s.sub_total * s.cost < 0)   -- 没成本，或成本与销售异号
  and coalesce(s.item_code, '') <> ''
  and coalesce(i.item_group, '') not in ('ONLINE','SHIP FEE','PAY FEE','TRAN FEE','SERV FEE','INSTALL','TRANSPOR',
                                         'DELIVERY','SERV INC','CARD INT','GST')
order by s.company, s.doc_date;

create unique index if not exists mv_margin_nocost_lines_uk
  on bi.mv_margin_nocost_lines (company, doc_type, doc_key, dtl_key);
create index if not exists mv_margin_nocost_lines_date
  on bi.mv_margin_nocost_lines (company, doc_date);

grant select on bi.mv_margin_nocost_lines to authenticated, service_role;

-- 重算：多一个 nocost_lines（同样扫 fact_sales 近 24 个月）
create or replace function bi.refresh_margin()
returns void
language plpgsql
security definer
set search_path to ''
as $$
declare
  t0 timestamptz := clock_timestamp();
  n  bigint;
begin
  refresh materialized view concurrently bi.mv_margin_month;
  refresh materialized view concurrently bi.mv_margin_item_month;
  refresh materialized view concurrently bi.mv_margin_dim_month;
  refresh materialized view concurrently bi.mv_margin_badcost;
  refresh materialized view concurrently bi.mv_margin_nocost_lines;
  select count(*) into n from bi.mv_margin_month;
  insert into bi.margin_refresh_log (id, refreshed_at, mv_rows, took_ms)
  values (1, now(), n, (extract(epoch from clock_timestamp() - t0) * 1000)::integer)
  on conflict (id) do update
    set refreshed_at = excluded.refreshed_at, mv_rows = excluded.mv_rows, took_ms = excluded.took_ms;
end $$;
revoke execute on function bi.refresh_margin() from public;

-- RPC 第 4 版：读物化视图。函数签名、权限检查、回传 jsonb 结构与 v3 相同。
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
    select n.*
    from bi.mv_margin_nocost_lines n
    where n.company = p_company
      and n.doc_date >= v_start
      and n.doc_date <  v_end
      and (not v_exb or n.channel <> '分行')
    order by n.doc_date, n.doc_no
    limit 5000
  ) x;

  return v_out;
end $$;

revoke execute on function public.bi_margin_nocost_lines(text, date, date, boolean) from public, anon;
grant execute on function public.bi_margin_nocost_lines(text, date, date, boolean) to authenticated, service_role;
