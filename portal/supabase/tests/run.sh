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
