-- 仓库总览（2026-10-15）。接在 bin_test.sql 之后跑：权限、分店、成本只给可审批。
\set ON_ERROR_STOP 1
create or replace function pg_temp.as_user(p_email text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('email', p_email)::text, false);
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
set role authenticated;

select pg_temp.as_user('whmgr@example.com');
do $$ declare o jsonb; hq jsonb; begin
  o := public.ops_wh_overview('{}');
  assert o->>'company' = 'HOMEWORKSSB' and (o->>'show_cost')::boolean, 'approve sees cost';
  hq := (select x from jsonb_array_elements(o->'locations') x where x->>'location' = 'HQ');
  assert (hq->>'value') is not null and (hq->>'neg')::int >= 1, 'HQ row: ' || hq::text;
  assert (o->>'neg_rows')::int >= 1, 'negative rows';
  assert jsonb_array_length(o->'bins') >= 1 and jsonb_array_length(o->'recent') between 1 and 15, 'bins + recent';
  assert o->'names' ? (o->'recent'->0->>'item_code'), 'names for recent items';
end $$;
select pg_temp.as_user('picker@example.com');
do $$ declare o jsonb; begin
  o := public.ops_wh_overview('{}');
  assert not (o->>'show_cost')::boolean and (select x->'value' from jsonb_array_elements(o->'locations') x where x->>'location' = 'HQ') = 'null'::jsonb,
    'edit level has no cost';
end $$;
select pg_temp.as_user('hqsales@example.com');
do $$ begin assert public.ops_wh_overview('{}')->>'company' = 'HOMEWORKSSB', 'view level ok'; end $$;
select pg_temp.as_user('jbwh@example.com');
select pg_temp.expect_error($q$select public.ops_wh_overview('{"company":"HOMEWORKSSB"}')$q$, '分店');
select pg_temp.as_user('hr@example.com');
select pg_temp.expect_error($q$select public.ops_wh_overview('{}')$q$, '仓库');
reset role;
select 'overview_test ok' as result;
