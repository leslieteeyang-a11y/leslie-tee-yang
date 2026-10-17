-- 仓库效能修正（20261017g）：「已开 DO 还没备」只算一个商品的版本要跟整份清单完全一样；撤销没改到数量的动作。
-- 接在 wms_fix_test.sql 之后跑，只用自己建的商品 PF001～PF004。
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
  if sqlerrm not like '%' || p_like || '%' then
    raise exception 'expected error "%" but got: %', p_like, sqlerrm;
  end if;
end $$;
grant execute on all functions in schema pg_temp to authenticated;

-- PF001 / PF002 品名整理后一样（不唯一 → 品名配对不算任何一个）；PF003 品名唯一；PF004 只靠商品代号
insert into bi.dim_item values ('HOMEWORKSSB', 'PF001', 'PERF SAME NAME', 'TAP', 'HEMOS', 'PCS'),
  ('HOMEWORKSSB', 'PF002', ' perf  same   name ', 'TAP', 'HEMOS', 'PCS'),
  ('HOMEWORKSSB', 'PF003', 'PERF UNIQUE  NAME', 'TAP', 'HEMOS', 'PCS'),
  ('HOMEWORKSSB', 'PF004', 'PERF CODE ONLY', 'TAP', 'HEMOS', 'PCS');
insert into bi.delivery_doc (company, doc_no, doc_date, debtor_code, debtor_name, items, lines) values
  ('HOMEWORKSSB', 'DO-PF1', (now() at time zone 'Asia/Kuala_Lumpur')::date, '300-C001', 'PF CUSTOMER', 'x',
   '[{"d":"perf unique name","q":3},{"d":"PERF SAME NAME","q":2},{"c":"pf004","d":"whatever","q":5},
     {"c":"NOPE","d":"Perf Unique Name ","q":"1"},{"c":"pf003","d":"perf same name","q":7},{"d":"运费","q":1}]'),
  ('HOMEWORKSSB', 'DO-PF2', (now() at time zone 'Asia/Kuala_Lumpur')::date - 10, '300-C001', 'PF OLD', 'x',
   '[{"d":"perf unique name","q":100}]');

do $$ declare n int; begin
  -- 整份清单：PF003 = 3 + 1 + 7、PF004 = 5、PF001 / PF002 没有（品名不唯一）、10 天前的 DO 不算
  assert (select u.qty from ops.wh_do_unpicked('HOMEWORKSSB') u where u.item_code = 'PF003') = 11, 'PF003 full';
  assert (select u.qty from ops.wh_do_unpicked('HOMEWORKSSB') u where u.item_code = 'PF004') = 5, 'PF004 full';
  assert not exists (select 1 from ops.wh_do_unpicked('HOMEWORKSSB') u where u.item_code in ('PF001', 'PF002')), 'non-unique name not matched';
  assert ops.wh_do_unpicked_for('HOMEWORKSSB', 'PF003') = 11 and ops.wh_do_unpicked_for('HOMEWORKSSB', 'PF001') = 0, 'per item';
  -- 两间公司每个商品：单一商品版 = 整份清单那一行（没有 = 0）
  select count(*) into n
  from (values ('HOMEWORKSSB'), ('HOMEWORKSSOUTHERN')) c(c)
  cross join lateral (select i.item_code from bi.dim_item i where i.company = c.c) i
  where ops.wh_do_unpicked_for(c.c, i.item_code)
        <> coalesce((select u.qty from ops.wh_do_unpicked(c.c) u where u.item_code = i.item_code), 0);
  assert n = 0, n || ' items differ between per-item and full DO unpicked';
  assert (select count(*) from ops.wh_do_unpicked('HOMEWORKSSB')) >= 2, 'full list not empty';
  -- 只算主要仓位
  assert ops.wh_do_unpicked_item('HOMEWORKSSB', 'PF003', ops.podo_main_loc('HOMEWORKSSB')) = 11
     and ops.wh_do_unpicked_item('HOMEWORKSSB', 'PF003', 'NOT-MAIN') = 0, 'main location only';
end $$;

set role authenticated;
select pg_temp.as_user('whmgr@example.com');
do $$ declare h jsonb; r jsonb; q numeric; begin
  -- 查货：每个仓位的应有 = AutoCount + 搬动 + DO 未备，未上架 = 应有 − 货架
  r := public.ops_wh_item_bins('{"item":"PF003"}');
  select x into h from jsonb_array_elements(r->'locations') x where x->>'location' = 'HQ';
  assert h is null or ((h->>'expected')::numeric = (h->>'ac_qty')::numeric + (h->>'pending')::numeric + (h->>'do_unpicked')::numeric
                       and (h->>'unshelved')::numeric = (h->>'expected')::numeric - (h->>'shelved')::numeric), 'item bins sums: ' || r::text;
  r := public.ops_wh_item_bins('{"item":"RF001"}');
  select x into h from jsonb_array_elements(r->'locations') x where x->>'location' = 'HQ';
  assert (h->>'expected')::numeric = (h->>'ac_qty')::numeric + (h->>'pending')::numeric + (h->>'do_unpicked')::numeric, 'RF001 sums: ' || h::text;
  -- 主管改数但数量没变 → 撤销说「没有改到数量」
  q := (select (x->>'qty')::numeric from jsonb_array_elements(public.ops_wh_bin_get('{"bin":"R-F1","location":"HQ"}')->'items') x
        where x->>'item_code' = 'RF001');
  r := public.ops_wh_bin_op(jsonb_build_object('kind', 'adjust', 'item', 'RF001', 'qty', q, 'bin', 'R-F1', 'location', 'HQ',
                                               'note', '核对：数量没变', 'confirm', true));
  assert (r->>'ok')::boolean, 'same-qty adjust: ' || r::text;
  perform pg_temp.expect_error(format('select public.ops_wh_bin_undo(null, %s)', r->>'ref_id'), '没有改到数量');
end $$;
reset role;
select 'wms_perf_test ok' as result;
