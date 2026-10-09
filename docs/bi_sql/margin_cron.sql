-- 2026-10-08：「毛利分析」物化视图 bi.mv_margin_month 的定时重算，migration：margin_cron。
-- 每 2 小时第 45 分（00:45、02:45 … UTC）跑 bi.refresh_margin()；
-- 避开既有的 bi_onepager_refresh（15 分）与 bi_heavy_views_refresh（25 分），三个重算不会同时抢 IO。
-- 重算一次约 10～12 秒（refresh concurrently，前端读的时候不会被锁）。数字最多慢 2 小时。
-- cron.schedule 同名会覆盖，所以重跑这个 migration 不会产生第二个排程。
select cron.schedule('bi_margin_refresh', '45 */2 * * *', $$select bi.refresh_margin()$$);
