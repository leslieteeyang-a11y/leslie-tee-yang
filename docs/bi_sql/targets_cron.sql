-- 2026-10-08：「目标」分页的排程。migration：targets_cron。
-- 每 2 小时第 55 分（UTC）跑 bi.refresh_targets()：避开第 15 分（bi_onepager_refresh）、第 25 分（bi_heavy_views_refresh）、
-- 第 35 分（bi_health_refresh）、第 45 分（bi_margin_refresh），不跟它们同时扫 fact_sales。
-- 销售资料由 SERVER 的 bi_sync 一天同步数次（sync_log 可见 04:15 / 07:00 / 10:00 UTC 等），所以页面数字最多慢 2 小时。
-- cron.schedule 同名会覆盖（不会重复登记），重跑这个 migration 是安全的。
select cron.schedule('bi_targets_refresh', '55 */2 * * *', $$select bi.refresh_targets()$$);
