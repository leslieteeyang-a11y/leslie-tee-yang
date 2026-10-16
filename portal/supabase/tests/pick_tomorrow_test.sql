-- 拣货「今天 / 明天要送」（2026-10-16，migration 20261018_ops_wh_pick_tomorrow）。接在 pick_test.sql 之后跑。
-- 资料：昨天开还没拣 (T-Y)、三天前开但排在明天 (T-RUN)、两天前开没排 (T-OLD)、昨天开已送达 (T-DLV)。
\set ON_ERROR_STOP 1
create or replace function pg_temp.as_user(p_email text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('email', p_email)::text, false);
end $$;
create or replace function pg_temp.tdocs(r jsonb) returns text[] language sql as $$
  select coalesce(array_agg(x->>'doc_no' order by o), '{}') from jsonb_array_elements(r->'rows') with ordinality t(x, o)
  where x->>'doc_no' like 'T-%'
$$;
grant execute on all functions in schema pg_temp to authenticated;
select set_config('tm.base', ops.wh_pick_summary('HOMEWORKSSB')::text, false);
insert into bi.delivery_doc (company, doc_no, doc_date, debtor_code, debtor_name, items, lines) values
  ('HOMEWORKSSB', 'T-Y', (now() at time zone 'Asia/Kuala_Lumpur')::date - 1, '300-C001', 'YESTERDAY SHOP', 'x', '[{"d":"RAXON HOSE","q":1}]'),
  ('HOMEWORKSSB', 'T-RUN', (now() at time zone 'Asia/Kuala_Lumpur')::date - 3, '300-C001', 'TOMORROW RUN', 'x', '[{"d":"RAXON HOSE","q":1}]'),
  ('HOMEWORKSSB', 'T-OLD', (now() at time zone 'Asia/Kuala_Lumpur')::date - 2, '300-C001', 'OLD SHOP 2', 'x', '[{"d":"RAXON HOSE","q":1}]'),
  ('HOMEWORKSSB', 'T-DLV', (now() at time zone 'Asia/Kuala_Lumpur')::date - 1, '300-C001', 'DONE SHOP', 'x', '[{"d":"RAXON HOSE","q":1}]');
insert into bi.delivery_run (run_date, store, driver_name, stops, token) values
  ((now() at time zone 'Asia/Kuala_Lumpur')::date + 1, 'HQ', '阿明', '[{"key":"T-RUN","doc_no":"T-RUN"}]', 'pick-tm-token-00000000001'),
  ((now() at time zone 'Asia/Kuala_Lumpur')::date - 1, 'HQ', '阿明', '[{"key":"T-DLV","doc_no":"T-DLV"}]', 'pick-tm-token-00000000002');
insert into bi.delivery_pod (run_id, stop_key, doc_no, status)
select r.id, 'T-DLV', 'T-DLV', 'delivered' from bi.delivery_run r where r.token = 'pick-tm-token-00000000002';

set role authenticated;
select pg_temp.as_user('hqsales@example.com');
do $$ declare r jsonb; g jsonb; begin
  r := public.ops_wh_pick_list('{"when":"today"}');
  assert pg_temp.tdocs(r) = array['T-RUN', 'T-Y'], 'today+tomorrow: tomorrow run first, then yesterday DO; old and delivered out: ' || r::text;
  g := (select x from jsonb_array_elements(r->'rows') x where x->>'doc_no' = 'T-RUN');
  assert (g->'run'->>'tomorrow')::boolean and not (g->'run'->>'today')::boolean, 'run flags: ' || g::text;
  -- 今天的排单仍排在明天的前面（pick_test 的 DO-P002 / DO-P001 是今天的排单）
  assert (select min(o) from jsonb_array_elements(r->'rows') with ordinality t(x, o) where x->>'doc_no' in ('DO-P002', 'DO-P001'))
       < (select min(o) from jsonb_array_elements(r->'rows') with ordinality t(x, o) where x->>'doc_no' = 'T-RUN'), 'today runs before tomorrow';
  assert (r->'summary'->>'today')::int = (current_setting('tm.base')::jsonb->>'today')::int + 2,
    'summary counts T-RUN + T-Y: ' || (r->'summary')::text;
  r := public.ops_wh_pick_list('{"when":"week"}');
  assert 'T-OLD' = any(pg_temp.tdocs(r)), 'week still has older DO';
end $$;
reset role;
select 'pick_tomorrow_test ok';
