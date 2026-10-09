-- 2026-10-08：「健康度」分页的排程。migration：health_cron。
-- 每 2 小时第 35 分（UTC）跑 bi.refresh_health()：避开第 15 分（bi_onepager_refresh）与
-- 第 25 分（bi_heavy_views_refresh），不跟它们同时扫 fact_sales。
-- 资料本身每天 04:05 UTC 由 SERVER 的 bi_sync 同步，所以页面数字最多慢 2 小时。
-- cron.schedule 同名会覆盖（不会重复登记），重跑这个 migration 是安全的。
select cron.schedule('bi_health_refresh', '35 */2 * * *', $$select bi.refresh_health()$$);
