#!/bin/sh
# 在本机 PostgreSQL 建一个空库，套用 stub + migration，跑权限测试。
# 用法：PGHOST=/var/tmp/pgtest PGPORT=5499 PGUSER=postgres sh portal/supabase/tests/run.sh
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
DB=ops_test_$$
createdb "$DB"
trap 'dropdb "$DB"' EXIT
psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$HERE/stub_supabase.sql" >/dev/null
for f in "$HERE"/../migrations/*.sql; do psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$f" >/dev/null; done
psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$HERE/ops_test.sql"
psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$HERE/att_test.sql"
psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$HERE/leave_test.sql"
psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$HERE/wh_test.sql"
psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$HERE/pay_test.sql"
psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$HERE/todo_test.sql"
psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$HERE/join_test.sql"
psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$HERE/dlv_test.sql"
psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$HERE/profile_test.sql"
psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$HERE/po_do_test.sql"
psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$HERE/receive_test.sql"
psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$HERE/sop_test.sql"
psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$HERE/cust_test.sql"
psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$HERE/rpl_test.sql"
psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$HERE/bin_test.sql"
psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$HERE/map_test.sql"
psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$HERE/binui_test.sql"
psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$HERE/pick_test.sql"
psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$HERE/sheet_test.sql"
psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$HERE/overview_test.sql"
psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$HERE/tag_test.sql"
psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$HERE/extras_test.sql"
psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$HERE/wms_fix_test.sql"
psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$HERE/wms_perf_test.sql"
