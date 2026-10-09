-- 2026-10-08：「毛利分析」把「成本正负号跟销售相反」的商品行也当作没成本，migration：margin_badcost_mv。
--
-- 为什么：核对时发现有些发票行成本是负数（例：ST001552 在 I-196048 卖 RM 212.25，成本 −0.92；
-- 可能是库存变负数时 AutoCount 算出的移动平均成本）。原本「有成本」= cost <> 0，这些行会被算进可信毛利，
-- 而且负成本反而把毛利灌高。近 12 个月 HQ 有 615 行、销售 RM 71,258、成本 −50,055（JB 8 行、RM 22,536、−6,762），
-- 让 HQ 可信毛利多算约 RM 12 万、毛利率高约 0.9 个百分点。
-- 「有成本」改成「成本与销售同号」（IV 正正、CN 负负；售价 0 的赠品只要成本 ≠ 0 也算），异号的行移到「没成本」，
-- 一起列给会计补。
--
-- 注意：实际套用到资料库的版本，bi.refresh_margin() 最后一行打错成 set refresh_at_placeholder = 1（建得起来、执行会报错），
-- 几分钟后已由 margin_refresh_fn_fix 覆盖成下面这个正确版本（期间排程没有跑过）。本档保留正确写法。
--
-- 作法（不动既有物化视图，避免删掉重建）：另建一个只收「成本异号的商品行」的小物化视图
-- bi.mv_margin_badcost（键与 bi.mv_margin_month 相同，近 24 个月只有几百行），RPC 读的时候从「有成本」扣掉、
-- 加到「没成本」。public.bi_margin_month 尾端加 4 栏 badcost_*，让直接查表的人也能做同样的修正。

create materialized view if not exists bi.mv_margin_badcost as
select s.company,
       extract(year from s.doc_date)::integer  as yr,
       extract(month from s.doc_date)::integer as mth,
       s.item_code,
       bi.sale_channel(s.debtor_code, c.debtor_type)               as channel,
       coalesce(nullif(btrim(s.sales_agent), ''), '')              as sales_agent,
       (bi.sale_channel(s.debtor_code, c.debtor_type) = '分行')    as is_branch,
       coalesce(sum(s.qty), 0)       as qty,
       coalesce(sum(s.sub_total), 0) as net,
       coalesce(sum(s.cost), 0)      as cost,
       count(*)                      as lines
from bi.fact_sales s
left join bi.dim_customer c on c.company = s.company and c.debtor_code = s.debtor_code
left join bi.dim_item     i on i.company = s.company and i.item_code   = s.item_code
where s.doc_date >= (date_trunc('month', current_date) - interval '24 months')::date
  and s.sub_total * s.cost < 0                                   -- 成本与销售异号
  and coalesce(s.item_code, '') <> ''                             -- 只修正商品行（服务 / 无代号行本来就不进商品毛利率）
  and coalesce(i.item_group, '') not in ('ONLINE','SHIP FEE','PAY FEE','TRAN FEE','SERV FEE','INSTALL','TRANSPOR',
                                         'DELIVERY','SERV INC','CARD INT','GST')
group by 1, 2, 3, 4, 5, 6, 7;

create unique index if not exists mv_margin_badcost_uk
  on bi.mv_margin_badcost (company, yr, mth, item_code, channel, sales_agent);

grant select on bi.mv_margin_badcost to authenticated, service_role;

-- public 视图尾端加修正栏（只能在尾端加栏）：可信 = net_costed − badcost_net，没成本 = net_nocost + badcost_net
create or replace view public.bi_margin_month with (security_invoker = true) as
select m.company, m.yr, m.mth, m.item_code, m.channel, m.sales_agent, m.line_class, m.item_group, m.item_type,
       m.qty, m.net, m.cost, m.net - m.cost as profit,
       m.qty_costed, m.net_costed, m.cost_costed, m.net_costed - m.cost_costed as profit_costed,
       m.qty_nocost, m.net_nocost, m.lines, m.lines_nocost,
       coalesce(b.qty, 0)   as badcost_qty,
       coalesce(b.net, 0)   as badcost_net,
       coalesce(b.cost, 0)  as badcost_cost,
       coalesce(b.lines, 0) as badcost_lines
from bi.mv_margin_month m
left join bi.mv_margin_badcost b
  on b.company = m.company and b.yr = m.yr and b.mth = m.mth and b.item_code = m.item_code
 and b.channel = m.channel and b.sales_agent = m.sales_agent
where (select public.bi_is_allowed())
  and coalesce((select public.bi_role()), '') = 'owner'
  and ((select public.bi_company()) is null or m.company = (select public.bi_company()));
grant select on public.bi_margin_month to authenticated;

-- 重算：多一个 badcost（扫 fact_sales 近 24 个月，约 8～10 秒）
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
  select count(*) into n from bi.mv_margin_month;
  insert into bi.margin_refresh_log (id, refreshed_at, mv_rows, took_ms)
  values (1, now(), n, (extract(epoch from clock_timestamp() - t0) * 1000)::integer)
  on conflict (id) do update
    set refreshed_at = excluded.refreshed_at, mv_rows = excluded.mv_rows, took_ms = excluded.took_ms;
end $$;
revoke execute on function bi.refresh_margin() from public;
