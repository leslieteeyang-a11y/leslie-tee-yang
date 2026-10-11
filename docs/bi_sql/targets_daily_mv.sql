-- ※ 2026-10-10 targets_fix1 已收回 authenticated 对这个物化视图的 SELECT，前端改经 security definer 函数 bi.targets_daily_rows()（先过滤公司）读取。
-- 2026-10-08：「目标」分页的逐日渠道净销售物化视图。migration：targets_daily_mv。
-- 为什么要自己的物化视图：
--   进度要「本月至今」、预测要「去年同月同期累计」（逐日），参考栏要「去年同月 / 近 3 个月平均」，
--   直接扫 bi.fact_sales（55 万行、263MB）要 2.6 秒以上，超过前端可接受的 1.5 秒；
--   既有的 bi.mv_mgr_channel_daily 只有近 70 天、拿不到去年同月逐日，所以另建一个只有约 5,000 行的小表。
-- 口径：净额 = sum(sub_total)（fact_sales 里 CN 的 sub_total 已是负数，与 bi.mv_sales_monthly 相同 = IV + CS − CN）；
--       渠道 = bi.sale_channel(debtor_code, dim_customer.debtor_type)，与「门店」分页 bi.mv_mgr_channel_* 同一个函数
--       （永远不会回 null，ELSE = 'B2B客户'）。
-- 范围：马来西亚时间本月 1 号往前 25 个月（够算「近 12 个月 + 下个月」每一列的去年同月与前 3 个月平均）。
-- 重算：bi.refresh_targets()（pg_cron bi_targets_refresh 每 2 小时第 55 分）concurrently 重算，所以要 unique index。
-- 物化视图没有 RLS：只 grant select 给 authenticated 让 security_invoker 的 public.bi_targets_progress 读，
--   公司过滤与 bi_is_allowed() 写在那个视图里（bi schema 不经 PostgREST 暴露，前端读不到这里）。
create materialized view if not exists bi.mv_targets_daily as
select s.company,
       s.doc_date,
       bi.sale_channel(s.debtor_code, c.debtor_type) as channel,
       sum(s.sub_total) as net
from bi.fact_sales s
left join bi.dim_customer c on c.company = s.company and c.debtor_code = s.debtor_code
where s.doc_date >= (date_trunc('month', (now() at time zone 'Asia/Kuala_Lumpur')) - interval '25 months')::date
group by s.company, s.doc_date, bi.sale_channel(s.debtor_code, c.debtor_type);

create unique index if not exists mv_targets_daily_uk on bi.mv_targets_daily (company, doc_date, channel);

grant select on bi.mv_targets_daily to authenticated;
grant select on bi.mv_targets_daily to service_role;
