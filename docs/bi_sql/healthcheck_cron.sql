-- 2026-10-10 健康体检快照每 3 小时（同步后约 35 分钟）重算；pg_cron 已在 onepager_cron 启用。migration：healthcheck_cron
select cron.schedule('bi_healthcheck_refresh', '35 1,4,7,10,13,16,19,22 * * *', 'select bi.refresh_healthcheck()');
