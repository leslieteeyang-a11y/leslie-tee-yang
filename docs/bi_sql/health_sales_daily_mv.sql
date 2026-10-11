-- 【2026-10-10 health_fix1】最后一行的 grant 已收回：authenticated 不能直接读这个 mv，
--  改经 security definer 的 bi.health_sales_daily()（只给 owner）。
-- 2026-10-08：「健康度」分页（只给 owner 看）的销售流量底稿。migration：health_sales_daily_mv。
-- 为什么要另建物化视图：毛利率要把「没有成本的行」分开算（可信毛利率只算 cost<>0 的行），
-- 既有的 bi.mv_sales_monthly / mv_sales_daily 只有 net / cost 合计，分不出来；直接扫 fact_sales
-- （55 万行、326MB）会超过 authenticated 的 8 秒 statement_timeout。
-- 按 (company, doc_date) 汇总约 2,300 行；月指标与「近 90 天」指标都从这里加总，前端查询 < 50ms。
-- 口径：
--   net            = IV + CS − CN（fact_sales 里 CN 的 sub_total 已是负数，直接加总，与 mv_sales_monthly 一致）
--   net_ic         = 卖给分行（bi.sale_channel = '分行'，总部账套的 3000-H008）的净额：集团内调拨
--   sales_costed / cost_costed = 有成本记录的行（cost <> 0，含退货冲回的负成本）→ 可信毛利率
--   gross_goods    = IV/CS 正金额的商品行（排除服务群组 ONLINE / SHIP FEE / PAY FEE / TRAN FEE /
--                    SERV FEE / INSTALL / TRANSPOR，这些本来就没有商品成本）
--   sales_nocost   = 上面那些商品行里 cost = 0 的金额（资料品质警示：没有成本 → 毛利被灌高）
--   sales_nocost_ic= 其中卖给分行的部分（总部的零成本行约 8～9 成是卖给分行的发票）
-- 由 bi.refresh_health()（pg_cron bi_health_refresh，每 2 小时第 35 分）concurrently 重算。
create materialized view if not exists bi.mv_health_sales_daily as
select s.company,
       s.doc_date,
       sum(s.sub_total) as net,
       coalesce(sum(s.sub_total) filter (where bi.sale_channel(s.debtor_code, c.debtor_type) = '分行'), 0) as net_ic,
       coalesce(sum(s.sub_total) filter (where s.cost <> 0), 0) as sales_costed,
       coalesce(sum(s.cost)      filter (where s.cost <> 0), 0) as cost_costed,
       coalesce(sum(s.sub_total) filter (where s.doc_type in ('IV','CS') and s.sub_total > 0
                 and coalesce(i.item_group, '') not in ('ONLINE','SHIP FEE','PAY FEE','TRAN FEE','SERV FEE','INSTALL','TRANSPOR')), 0) as gross_goods,
       coalesce(sum(s.sub_total) filter (where s.doc_type in ('IV','CS') and s.sub_total > 0 and s.cost = 0
                 and coalesce(i.item_group, '') not in ('ONLINE','SHIP FEE','PAY FEE','TRAN FEE','SERV FEE','INSTALL','TRANSPOR')), 0) as sales_nocost,
       coalesce(sum(s.sub_total) filter (where s.doc_type in ('IV','CS') and s.sub_total > 0 and s.cost = 0
                 and coalesce(i.item_group, '') not in ('ONLINE','SHIP FEE','PAY FEE','TRAN FEE','SERV FEE','INSTALL','TRANSPOR')
                 and bi.sale_channel(s.debtor_code, c.debtor_type) = '分行'), 0) as sales_nocost_ic,
       count(*) filter (where s.doc_type in ('IV','CS') and s.sub_total > 0 and s.cost = 0
                 and coalesce(i.item_group, '') not in ('ONLINE','SHIP FEE','PAY FEE','TRAN FEE','SERV FEE','INSTALL','TRANSPOR')) as nocost_lines,
       coalesce(sum(s.cost), 0) as cost_all
from bi.fact_sales s
left join bi.dim_customer c on c.company = s.company and c.debtor_code = s.debtor_code
left join bi.dim_item i     on i.company = s.company and i.item_code   = s.item_code
group by s.company, s.doc_date;

-- refresh concurrently 需要 unique index
create unique index if not exists mv_health_sales_daily_uk on bi.mv_health_sales_daily (company, doc_date);

-- 照既有物化视图的做法：authenticated 有 select（bi schema 不对 API 暴露），
-- 实际只能透过加了 bi_is_allowed() / bi_company() / owner 条件的 public.bi_health_* 视图读。
grant select on bi.mv_health_sales_daily to authenticated;
