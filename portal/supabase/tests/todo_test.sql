-- 首页待办 / HR 缺漏 / 旧货清单测试（接在 pay_test.sql 之后跑）。
\set ON_ERROR_STOP 1
create or replace function pg_temp.as_user(p_email text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('email', p_email)::text, false);
end $$;
create or replace function pg_temp.at(p_ts text) returns void language plpgsql as $$
begin
  perform set_config('ops.fake_now', p_ts, false);
end $$;
create or replace function pg_temp.expect_error(p_sql text, p_like text) returns void language plpgsql as $$
begin
  execute p_sql;
  raise exception 'expected error "%" from: %', p_like, p_sql;
exception when others then
  if sqlerrm like 'expected error%' or sqlerrm not like '%' || p_like || '%' then
    raise;
  end if;
end $$;
grant execute on all functions in schema pg_temp to authenticated;

-- 旧货资料（今天 = 2026-10-21）：A1 旧又没卖、A2 新但没卖、A3 旧但有卖、A4 没库存
insert into bi.fact_item_aging values
  ('HOMEWORKSSB', 'A1', '2025-01-01', 5, 500, 0), ('HOMEWORKSSB', 'A2', '2026-08-01', 3, 300, 0),
  ('HOMEWORKSSB', 'A3', '2024-05-01', 2, 200, 1), ('HOMEWORKSSB', 'A4', '2023-01-01', 0, 0, 0);
insert into bi.mv_sales_item_month (company, yr, mth, item_code, qty) values
  ('HOMEWORKSSB', 2026, 9, 'A3', 1), ('HOMEWORKSSB', 2025, 6, 'A1', 2);
insert into bi.fact_stock values ('HOMEWORKSSB', 'A1', 'SRGADING', 4, 400), ('HOMEWORKSSB', 'A1', 'HQ', 1, 100);

set role authenticated;
select pg_temp.at('2026-10-21 10:00:00+08');

-- 仓库员工：看得到清单、看不到成本、不能填处理方式
select pg_temp.as_user('picker@example.com');
do $$ declare r jsonb := public.ops_wh_aged('{}'); begin
  assert jsonb_array_length(r->'rows') = 1 and r->'rows'->0->>'item_code' = 'A1', 'both = A1';
  assert (r->>'show_cost')::boolean = false and r->'rows'->0->'stock_value' = 'null'::jsonb, 'no cost for picker';
  assert jsonb_array_length(r->'rows'->0->'locations') = 2, 'locations';
  assert (r->'summary'->>'old_n')::int = 2 and (r->'summary'->>'nosale_n')::int = 2, 'summary counts';
  assert r->'summary'->'old_v' = 'null'::jsonb, 'no summary cost';
  assert jsonb_array_length(public.ops_wh_aged('{"kind":"old"}')->'rows') = 2, 'old = A1 A3';
  assert jsonb_array_length(public.ops_wh_aged('{"kind":"nosale"}')->'rows') = 2, 'nosale = A1 A2';
  assert (public.ops_home()->>'po_arriving') is not null and public.ops_home()->'hr_gaps' = 'null'::jsonb, 'picker home';
end $$;
select pg_temp.expect_error($q$select public.ops_wh_aged_save('{"item_codes":["A1"],"action":"clearance"}')$q$, '审批');

-- 仓库主管：看得到成本、可以标处理方式
select pg_temp.as_user('whmgr@example.com');
do $$ declare r jsonb; begin
  r := public.ops_wh_aged('{}');
  assert (r->>'show_cost')::boolean and (r->'rows'->0->>'stock_value')::numeric = 500, 'cost for manager';
  assert (r->'summary'->>'both_v')::numeric = 500 and (r->'summary'->>'both_open')::int = 1, 'summary value';
  assert public.ops_wh_aged_save('{"item_codes":["A1","A2"],"action":"clearance","note":"十一月清货"}') = 2, 'saved 2';
  r := public.ops_wh_aged('{"kind":"nosale","action":"clearance"}');
  assert jsonb_array_length(r->'rows') = 2 and r->'rows'->0->>'note' = '十一月清货', 'filter by action';
  assert (public.ops_wh_aged('{}')->'summary'->>'both_open')::int = 0, 'nothing open';
  assert jsonb_array_length(public.ops_wh_aged('{"kind":"old","q":"a3"}')->'rows') = 1, 'search';
end $$;
select pg_temp.expect_error($q$select public.ops_wh_aged_save('{"item_codes":["A1"],"action":"burn"}')$q$, '处理方式');
select pg_temp.expect_error($q$select public.ops_wh_aged_save('{"item_codes":[]}')$q$, '先选商品');

-- 没有仓库权限的人看不到
select pg_temp.as_user('hqsales@example.com');
do $$ begin
  assert public.ops_home()->'hr_gaps' = 'null'::jsonb, 'sales no hr gaps';
end $$;
select pg_temp.expect_error($q$select public.ops_hr_gaps()$q$, '');

-- HR：缺漏清单与首页数字
select pg_temp.as_user('hr@example.com');
do $$ declare g jsonb := public.ops_hr_gaps(); h jsonb := public.ops_home(); begin
  assert jsonb_array_length(g->'staff') > 0, 'some staff missing data';
  assert (h->>'hr_gaps')::int = jsonb_array_length(g->'staff'), 'home count matches list';
  assert exists (select 1 from jsonb_array_elements(g->'staff') s where s->'missing' ? 'join_date'), 'join date flagged';
  assert (h->>'holidays_ahead') is not null, 'holidays ahead shown to hr';
end $$;

reset role;
select 'ALL TODO / AGED TESTS PASSED' as result;
