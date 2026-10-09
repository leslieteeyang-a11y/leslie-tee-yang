-- 2026-10-08：BI 新分页「毛利分析」（只有 owner 看）的资料层，migration：margin_month_mv。
--
-- 为什么要物化视图：毛利分析要按 类别 / 品牌 / 渠道 / 业务员 / 商品 × 期间 汇总，
-- 直接扫 bi.fact_sales（55 万行、326MB）会超过 authenticated 的 8 秒 statement_timeout。
-- 先按「公司 × 年月 × 商品 × 渠道 × 业务员」汇总成 bi.mv_margin_month（约 7～8 万行），
-- 前端再透过 RPC public.bi_margin_summary 按期间二次汇总（< 1.5 秒）。
--
-- 口径（与 bi.mv_sales_monthly 相同）：
--   * fact_sales 的 CN 已经是负数（sub_total / cost / qty 都带负号），所以净额 = sum(sub_total)
--     就等于 IV + CS − CN，不需要再减一次。
--   * 「可信」= 有成本的行（cost <> 0；CN 的成本是负数，所以不能用 cost > 0）。
--     没成本的行（cost = 0 且 sub_total <> 0）单独累计 net_nocost，不混进毛利率，
--     否则会把毛利率灌高（HQ 每月有 1,000～1,400 行这种行）。
--   * line_class 把三种行分开：
--       goods  = 真正的商品
--       svc    = 服务 / 费用类群组（平台手续费 ONLINE000002、VOUCHER、运费、安装、转账费…），
--                本来就没有进货成本，单独列，不进商品毛利率
--       noitem = 开单时没选商品代号的自由输入行（例：PROMOTION HEMOS MEMBRANE FILTER）
--   * 只留最近 24 个月 + 本月（期间选单最长 12 个月 / 今年至今，趋势 12 个月，够用），控制行数。
--   * 渠道用既有 bi.sale_channel(debtor_code, debtor_type)，与店长页一致。
--
-- 权限：物化视图没有 RLS，照既有 mv 做法 grant select 给 authenticated / service_role，
-- 但前端只透过 security definer RPC（函数内检查 owner + 公司）或 public.bi_margin_month
-- （security_invoker + bi_is_allowed + owner + bi_company 过滤）读。bi schema 不对 API 开放。

create materialized view if not exists bi.mv_margin_month as
select s.company,
       extract(year from s.doc_date)::integer  as yr,
       extract(month from s.doc_date)::integer as mth,
       coalesce(s.item_code, '')                                   as item_code,
       bi.sale_channel(s.debtor_code, c.debtor_type)               as channel,
       coalesce(nullif(btrim(s.sales_agent), ''), '')              as sales_agent,
       case when coalesce(s.item_code, '') = '' then 'noitem'
            when i.item_group in ('ONLINE','SHIP FEE','PAY FEE','TRAN FEE','SERV FEE','INSTALL','TRANSPOR',
                                  'DELIVERY','SERV INC','CARD INT','GST') then 'svc'
            else 'goods' end                                       as line_class,
       coalesce(i.item_group, '')                                  as item_group,
       coalesce(i.item_type, '')                                   as item_type,
       coalesce(sum(s.qty), 0)                                                          as qty,
       coalesce(sum(s.sub_total), 0)                                                    as net,
       coalesce(sum(s.cost), 0)                                                         as cost,
       coalesce(sum(s.qty)       filter (where coalesce(s.cost, 0) <> 0), 0)            as qty_costed,
       coalesce(sum(s.sub_total) filter (where coalesce(s.cost, 0) <> 0), 0)            as net_costed,
       coalesce(sum(s.cost)      filter (where coalesce(s.cost, 0) <> 0), 0)            as cost_costed,
       coalesce(sum(s.qty)       filter (where coalesce(s.cost, 0) = 0 and s.sub_total <> 0), 0) as qty_nocost,
       coalesce(sum(s.sub_total) filter (where coalesce(s.cost, 0) = 0), 0)            as net_nocost,
       count(*)                                                                         as lines,
       count(*) filter (where coalesce(s.cost, 0) = 0 and s.sub_total <> 0)             as lines_nocost
from bi.fact_sales s
left join bi.dim_customer c on c.company = s.company and c.debtor_code = s.debtor_code
left join bi.dim_item     i on i.company = s.company and i.item_code   = s.item_code
where s.doc_date >= (date_trunc('month', current_date) - interval '24 months')::date
group by 1, 2, 3, 4, 5, 6, 7, 8, 9;

-- refresh concurrently 必须有 unique index；line_class / item_group / item_type 由 (company, item_code) 决定
create unique index if not exists mv_margin_month_uk
  on bi.mv_margin_month (company, yr, mth, item_code, channel, sales_agent);

grant select on bi.mv_margin_month to authenticated, service_role;

-- 记录最后一次重算时间，页面显示「数据更新于」
create table if not exists bi.margin_refresh_log (
  id           integer primary key default 1 check (id = 1),
  refreshed_at timestamptz not null,
  mv_rows      bigint,
  took_ms      integer
);
alter table bi.margin_refresh_log enable row level security;  -- 没有 policy = 一般使用者读不到；只给下面的 definer 函数用

-- 重算函数：pg_cron 每 2 小时第 45 分跑（避开 onepager 的 15 分、heavy views 的 25 分）
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
  select count(*) into n from bi.mv_margin_month;
  insert into bi.margin_refresh_log (id, refreshed_at, mv_rows, took_ms)
  values (1, now(), n, (extract(epoch from clock_timestamp() - t0) * 1000)::integer)
  on conflict (id) do update
    set refreshed_at = excluded.refreshed_at, mv_rows = excluded.mv_rows, took_ms = excluded.took_ms;
end $$;
revoke execute on function bi.refresh_margin() from public;

-- 给想直接查表的人（例如以后做别的报表）：只有 owner 看得到，且受 bi_company() 限制
create or replace view public.bi_margin_month with (security_invoker = true) as
select company, yr, mth, item_code, channel, sales_agent, line_class, item_group, item_type,
       qty, net, cost, net - cost as profit,
       qty_costed, net_costed, cost_costed, net_costed - cost_costed as profit_costed,
       qty_nocost, net_nocost, lines, lines_nocost
from bi.mv_margin_month
where (select public.bi_is_allowed())
  and coalesce((select public.bi_role()), '') = 'owner'
  and ((select public.bi_company()) is null or company = (select public.bi_company()));
grant select on public.bi_margin_month to authenticated;
