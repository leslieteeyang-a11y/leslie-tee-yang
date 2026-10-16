-- BI 三个分页搬进营运系统（2026-10-16）：补货建议 / 供应商交期 / 库存总表 / 滞销品 的权限与隐私测试。
-- 接在 sop_test.sql 之后跑。stub：ST003 走量（q90 45、HQ 10）、ST004 慢（q90 2、HQ 4）、ST002 没货（q90 12、HQ −2）、
-- ST001 欠分行（PRE (JB) −3）；供应商 4000-M002 中国（交期 60）、400-S001 本地。
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
create or replace function pg_temp.assert_true(p boolean, p_msg text) returns void language plpgsql as $$
begin
  if not coalesce(p, false) then raise exception 'assert failed: %', p_msg; end if;
end $$;
grant execute on all functions in schema pg_temp to authenticated;

-- 测试资料（只在这个档案里塞，前面的测试不受影响）：ST003 走量（近 90 天 45 件、HQ 10）、ST004 卖得慢（2 件、HQ 4）、
-- ST002 没货（12 件、HQ −2）、ST001 近 90 天 0 件但欠分行（PRE (JB) −3）；最后进货 ST004 200 天前、ST003 100 天前
update bi.v_supplier_param set po_name = name, safety_days = case when is_china then 14 else 7 end, cover_days = 30, po_24m = 3, order_due = false;
update bi.dim_item set price2 = 99, price3 = 89, price4 = 79 where item_code = 'ST003';
insert into bi.mv_purchase_sold values
  ('HOMEWORKSSB', 'ST003', 45, 180, 0, 15, 40, current_date - 300, current_date - 1),
  ('HOMEWORKSSB', 'ST004', 2, 10, 0, 1, 3, current_date - 300, current_date - 20),
  ('HOMEWORKSSB', 'ST002', 12, 50, 0, 4, 10, current_date - 300, current_date - 3);
insert into bi.fact_stock values ('HOMEWORKSSB', 'ST001', 'PRE (JB)', -3, 0);
insert into bi.v_item_supplier (company, item_code, supplier_code, last_supplier_code, last_supplier_name, last_price, last_po_date, po_24m, exclude)
  values ('HOMEWORKSSB', 'ST003', '4000-M002', '4000-M002', 'CS065', 12.5, current_date - 40, 3, false),
         ('HOMEWORKSSB', 'ST002', '4000-M002', '4000-M002', 'CS065', 8, current_date - 10, 2, false);
insert into bi.fact_item_aging values ('HOMEWORKSSB', 'ST004', current_date - 200, 4, 1200, 2),
  ('HOMEWORKSSB', 'ST003', current_date - 100, 10, 300, 40);

-- 员工：采购（订货可编辑）、门市销售（订货只看、仓库只看，看不到厂家与单价）、仓库主管（仓库可审批、看得到厂家、看不到单价）
set role authenticated;
select pg_temp.as_user('boss@example.com');
select public.ops_staff_save('{"email":"buyer2@example.com","name":"采购小陈","department":"purchasing","branch":"HOMEWORKSSB"}');
select public.ops_staff_save('{"email":"shop@example.com","name":"门市小美","department":"sales","branch":"HOMEWORKSSB"}');
select public.ops_staff_save('{"email":"whboss@example.com","name":"仓库主管二","department":"warehouse","branch":"HOMEWORKSSB","role":"manager"}');
select public.ops_staff_save('{"email":"buyer3@example.com","name":"采购小林","department":"purchasing","branch":"HOMEWORKSSB"}');

-- 0. BI 自己的视图照旧：BI 名单里的 owner 看得到，不在名单的员工看不到（视图是 security invoker，员工没有 bi 表的 RLS 放行）
reset role;
select pg_temp.as_user('boss@example.com');
do $$ begin
  assert (select count(*) from public.bi_purchase_suggest where company = 'HOMEWORKSSB') = 4, 'BI view for owner: ' ||
    (select count(*) from public.bi_purchase_suggest where company = 'HOMEWORKSSB');
  assert (select urgency from public.bi_purchase_suggest where item_code = 'ST002') = 'out', 'ST002 out';
  assert (select owed_branch from public.bi_purchase_suggest where item_code = 'ST001') = 3, 'ST001 loaded because owed to branch';
end $$;
set role authenticated;

-- 1. 补货建议：采购看全部（含厂家、单价）；门槛 30 只载入 ST003（走量）+ ST002（没货）+ ST001（欠分行），ST004 不载入
select pg_temp.as_user('buyer2@example.com');
do $$ declare m jsonb := public.ops_rpl_meta(''); r jsonb; begin
  assert m->>'company' = 'HOMEWORKSSB' and (m->>'can_edit')::boolean and (m->>'prices')::boolean and (m->>'supplier')::boolean, 'meta: ' || m::text;
  assert (select count(*) from jsonb_array_elements(m->'cs_codes') c where c->>'cs_code' = 'CS065' and (c->>'loaded30')::int = 2) = 1,
    'cs codes: ' || (m->'cs_codes')::text;
  r := public.ops_rpl_rows('{"min_q":30}');
  assert (r->>'total')::int = 3 and jsonb_array_length(r->'rows') = 3, 'rows@30: ' || r::text;
  assert (select count(*) from jsonb_array_elements(r->'rows') x where x->>'item_code' = 'ST004') = 0, 'ST004 below threshold';
  assert (select x->>'supplier_name' from jsonb_array_elements(r->'rows') x where x->>'item_code' = 'ST003') = 'MAIDEN (CS)', 'supplier visible to buyer';
  assert (select (x->>'last_price')::numeric from jsonb_array_elements(r->'rows') x where x->>'item_code' = 'ST003') = 12.5, 'price visible to buyer';
  assert (select x->>'cs_code' from jsonb_array_elements(r->'rows') x where x->>'item_code' = 'ST003') = 'CS065', 'cs code';
  r := public.ops_rpl_rows('{"min_q":10}');
  assert (r->>'total')::int = 3, 'rows@10 (ST004 q90=2 still out): ' || (r->>'total');
  r := public.ops_rpl_rows('{"min_q":30,"cs_code":"CS065"}');
  assert (r->>'total')::int = 2, 'cs filter: ' || (r->>'total');
end $$;
-- 门市：只看；看不到厂家与单价；不能用厂号筛（会被忽略）；不能记已下单
select pg_temp.as_user('shop@example.com');
do $$ declare m jsonb := public.ops_rpl_meta(''); r jsonb; begin
  assert not (m->>'can_edit')::boolean and not (m->>'prices')::boolean and not (m->>'supplier')::boolean, 'shop meta: ' || m::text;
  assert m->'cs_codes' = '[]'::jsonb and m->'due_suppliers' = '[]'::jsonb, 'shop sees no suppliers';
  r := public.ops_rpl_rows('{"min_q":30,"cs_code":"CS065"}');
  assert (r->>'total')::int = 3 and r->>'cs_code' is null, 'cs filter ignored for shop: ' || (r->>'total');
  assert (select x->'supplier_name' from jsonb_array_elements(r->'rows') x where x->>'item_code' = 'ST003') = 'null'::jsonb, 'supplier hidden';
  assert (select x->'last_price' from jsonb_array_elements(r->'rows') x where x->>'item_code' = 'ST003') = 'null'::jsonb, 'price hidden';
  assert (select x->'cs_code' from jsonb_array_elements(r->'rows') x where x->>'item_code' = 'ST003') = 'null'::jsonb, 'cs hidden';
  assert (select x->'transit_pos' from jsonb_array_elements(r->'rows') x where x->>'item_code' = 'ST003') = 'null'::jsonb, 'po no hidden';
end $$;
select pg_temp.expect_error($q$select public.ops_rpl_action('{"item_code":"ST003","action":"ordered","qty":5}')$q$, '编辑');
select pg_temp.expect_error($q$select public.ops_rpl_suppliers('')$q$, '厂家');

-- 2. 已下单 / 暂不订 / 撤销 / 商品设定（采购）
select pg_temp.as_user('buyer2@example.com');
do $$ declare id1 bigint; id2 bigint; r jsonb; begin
  id1 := public.ops_rpl_action('{"item_code":"ST003","action":"ordered","qty":120}');
  r := public.ops_rpl_rows('{"min_q":30}');
  assert (select x->>'action_status' from jsonb_array_elements(r->'rows') x where x->>'item_code' = 'ST003') = 'ordered', 'ordered shows';
  assert (select x->>'action_by' from jsonb_array_elements(r->'rows') x where x->>'item_code' = 'ST003') = 'buyer2@example.com', 'action_by = staff email';
  perform public.ops_rpl_action_undo(id1);
  r := public.ops_rpl_rows('{"min_q":30}');
  assert (select x->'action_status' from jsonb_array_elements(r->'rows') x where x->>'item_code' = 'ST003') = 'null'::jsonb, 'undo clears';
  id2 := public.ops_rpl_action(('{"item_code":"ST003","action":"skip","until_date":"' || (current_date + 14)::text || '"}')::jsonb);
  -- 商品设定：不再提醒 ST002 → 载入清单少一项
  perform public.ops_rpl_item_setting_save('{"item_code":"ST002","exclude":true,"note":"停售"}');
end $$;
reset role;
do $$ begin
  assert (select exclude from bi.buyer_item_setting where item_code = 'ST002'), 'setting saved';
  assert (select updated_by from bi.buyer_item_setting where item_code = 'ST002') = 'buyer2@example.com', 'updated_by = staff email';
end $$;
select max(id) as aid from bi.buyer_item_action \gset
set role authenticated;
select pg_temp.as_user('buyer2@example.com');
select pg_temp.expect_error($q$select public.ops_rpl_action('{"item_code":"NOPE","action":"ordered"}')$q$, '找不到商品');
select pg_temp.expect_error($q$select public.ops_rpl_action('{"item_code":"ST003","action":"buy"}')$q$, '不认识的动作');
-- 别人记的不能撤销（除非可审批）；主管（manager → approve）可以
select pg_temp.as_user('whboss@example.com');
select pg_temp.expect_error('select public.ops_rpl_action_undo(' || :aid || ')', '编辑');
select pg_temp.as_user('buyer3@example.com');
select pg_temp.expect_error('select public.ops_rpl_action_undo(' || :aid || ')', '撤销');
select pg_temp.as_user('boss@example.com');
select pg_temp.assert_true(public.ops_rpl_action_undo(:aid) = 1, 'admin undo');
-- 软撤销：行还在、标了谁撤的；再撤一次会被挡（已撤销的不算自己的）
reset role;
select pg_temp.assert_true((select undone_by from bi.buyer_item_action where id = :aid) = 'boss@example.com', 'undo marks row');
set role authenticated;
select pg_temp.as_user('boss@example.com');
select pg_temp.expect_error('select public.ops_rpl_action_undo(' || :aid || ')', '撤销');

-- 3. 供应商交期：采购可看可改；仓库主管可看（看得到厂家）不可改；范围检查
select pg_temp.as_user('buyer2@example.com');
do $$ declare s jsonb := public.ops_rpl_suppliers(''); begin
  assert (s->>'can_edit')::boolean and jsonb_array_length(s->'suppliers') >= 2 and exists (select 1 from jsonb_array_elements(s->'suppliers') x where x->>'creditor_code' = '4000-M002'), 'suppliers: ' || s::text;
  assert (select count(*) from jsonb_array_elements(s->'brands') b where b->>'item_type' = 'HEMOS') = 1, 'brands';
  perform public.ops_rpl_supplier_save('{"creditor_code":"4000-M002","lead_days":75,"cycle_days":30}');
  perform public.ops_rpl_brand_supplier_save('{"item_type":"HEMOS","supplier_code":"4000-M002"}');
end $$;
reset role;
do $$ begin
  assert (select lead_days from bi.buyer_supplier_setting where creditor_code = '4000-M002') = 75, 'supplier setting saved';
  assert (select supplier_code from bi.buyer_brand_supplier where item_type = 'HEMOS') = '4000-M002', 'brand supplier saved';
end $$;
set role authenticated;
select pg_temp.as_user('buyer2@example.com');
select public.ops_rpl_brand_supplier_save('{"item_type":"HEMOS","supplier_code":""}');
reset role;
do $$ begin assert (select supplier_code from bi.buyer_brand_supplier where item_type = 'HEMOS') is null, 'brand supplier cleared'; end $$;
set role authenticated;
select pg_temp.as_user('buyer2@example.com');
select pg_temp.expect_error($q$select public.ops_rpl_supplier_save('{"creditor_code":"4000-M002","lead_days":400}')$q$, '交期');
select pg_temp.expect_error($q$select public.ops_rpl_supplier_save('{"creditor_code":"NOPE","lead_days":10}')$q$, '找不到供应商');
select pg_temp.as_user('whboss@example.com');
do $$ declare s jsonb := public.ops_rpl_suppliers(''); begin
  assert not (s->>'can_edit')::boolean and jsonb_array_length(s->'suppliers') >= 2, 'wh boss sees suppliers read-only';
end $$;
select pg_temp.expect_error($q$select public.ops_rpl_supplier_save('{"creditor_code":"4000-M002","lead_days":10}')$q$, '编辑');

-- 4. 库存总表：成本只给老板（20261019b），仓库主管、门市都看不到成本、看得到售价；负库存筛选；搜寻
select pg_temp.as_user('boss@example.com');
do $$ declare r jsonb := public.ops_wh_stock('{}'); x jsonb := public.ops_wh_stock_export('{}'); begin
  assert (r->>'show_cost')::boolean and (select (e->>'total_cost')::numeric from jsonb_array_elements(r->'rows') e
                                           where e->>'item_code' = 'ST003' and e->>'location' = 'HQ') = 300, 'owner sees cost';
  assert (x->>'show_cost')::boolean and (select (e->>'total_cost')::numeric from jsonb_array_elements(x->'rows') e
                                           where e->>'item_code' = 'ST003' and e->>'location' = 'HQ') = 300, 'owner export has cost';
end $$;
select pg_temp.as_user('whboss@example.com');
do $$ declare r jsonb := public.ops_wh_stock('{}'); n jsonb; begin
  assert not (r->>'show_cost')::boolean and (r->>'total')::int >= 6, 'stock: ' || r::text;
  assert (select bool_and(x->'total_cost' = 'null'::jsonb) from jsonb_array_elements(r->'rows') x), 'manager: cost hidden';
  n := public.ops_wh_stock_export('{}');
  assert not (n->>'show_cost')::boolean and (select bool_and(x->'total_cost' = 'null'::jsonb) from jsonb_array_elements(n->'rows') x), 'manager export: no cost';
  n := public.ops_wh_stock('{"neg_only":true}');
  assert (n->>'total')::int = (r->>'neg_total')::int and (n->>'total')::int = 2, 'negatives: ' || n::text;
  -- 商品合计 = 全部仓位（ST001：HQ 5 + SRGADING 3 + PRE (JB) −3 = 5），不是只算负库存那几行
  assert (select (x->>'item_total')::numeric from jsonb_array_elements(n->'rows') x where x->>'item_code' = 'ST001') = 5, 'item_total: ' || n::text;
  n := public.ops_wh_stock('{"q":"basin"}');
  -- total 是「商品×仓库」行数（ST003 在 HQ 与 DEFECTS 各一行），与 BI 原页口径相同
  assert (n->>'total')::int = 2 and (select bool_and(x->>'item_code' = 'ST003') from jsonb_array_elements(n->'rows') x), 'search by name: ' || n::text;
end $$;
select pg_temp.as_user('shop@example.com');
do $$ declare r jsonb := public.ops_wh_stock('{"q":"ST003"}'); begin
  assert not (r->>'show_cost')::boolean and r->'rows'->0->'total_cost' = 'null'::jsonb, 'cost hidden for shop';
  assert (r->'rows'->0->>'price2')::numeric = 99, 'selling price visible';
end $$;

-- 5. 滞销品：6 个月以上 = ST004（200 天）；3–6 个月 = ST003（100 天）；成本只给老板（20261019b）
select pg_temp.as_user('boss@example.com');
do $$ declare r jsonb := public.ops_wh_slow('{"min_months":6}'); begin
  -- 其他测试档也塞了账龄资料（A1 / A3），只检查 ST004 的成本
  assert (select (x->>'stock_value')::numeric from jsonb_array_elements(r->'rows') x where x->>'item_code' = 'ST004') = 1200, 'slow 6m owner: ' || r::text;
end $$;
select pg_temp.as_user('whboss@example.com');
do $$ declare r jsonb := public.ops_wh_slow('{"min_months":6}'); begin
  assert not (r->>'show_cost')::boolean and exists (select 1 from jsonb_array_elements(r->'rows') x where x->>'item_code' = 'ST004' and x->'stock_value' = 'null'::jsonb),
    'slow 6m manager: no cost: ' || r::text;
  assert not exists (select 1 from jsonb_array_elements(r->'rows') x where x->>'item_code' = 'ST003'), 'slow 6m excludes 3-6m item';
  r := public.ops_wh_slow('{"min_months":3,"max_months":6}');
  assert exists (select 1 from jsonb_array_elements(r->'rows') x where x->>'item_code' = 'ST003')
     and not exists (select 1 from jsonb_array_elements(r->'rows') x where x->>'item_code' = 'ST004'), 'slow 3-6m: ' || r::text;
end $$;
select pg_temp.as_user('shop@example.com');
do $$ declare r jsonb := public.ops_wh_slow('{"min_months":6}'); begin
  assert not (r->>'show_cost')::boolean and (select bool_and(x->'stock_value' = 'null'::jsonb) from jsonb_array_elements(r->'rows') x), 'slow cost hidden';
end $$;
-- JB 的员工看不到总部
select pg_temp.as_user('boss@example.com');
select public.ops_staff_save('{"email":"jbwh@example.com","name":"JB 仓库","department":"warehouse","branch":"HOMEWORKSSOUTHERN"}');
select pg_temp.as_user('jbwh@example.com');
select pg_temp.expect_error($q$select public.ops_wh_stock('{"company":"HOMEWORKSSB"}')$q$, '分店');
select pg_temp.expect_error($q$select public.ops_rpl_rows('{"company":"HOMEWORKSSB"}')$q$, '分店');
-- 采购的留言只给看得到厂家的人（留言常写厂家名、PO 号）
select pg_temp.as_user('buyer2@example.com');
select public.ops_rpl_action('{"item_code":"ST003","action":"note","note":"PO 已发给 MAIDEN，等 PI"}');
do $$ declare r jsonb := public.ops_rpl_rows('{"min_q":30}'); begin
  assert (select x->>'action_note' from jsonb_array_elements(r->'rows') x where x->>'item_code' = 'ST003') = 'PO 已发给 MAIDEN，等 PI', 'buyer sees note';
end $$;
select pg_temp.as_user('shop@example.com');
do $$ declare r jsonb := public.ops_rpl_rows('{"min_q":30}'); begin
  assert (select x->'action_note' = 'null'::jsonb and x->'action_by' = 'null'::jsonb and x->'item_note' = 'null'::jsonb
          from jsonb_array_elements(r->'rows') x where x->>'item_code' = 'ST003'), 'notes hidden from shop: ' || r::text;
end $$;
reset role;
select 'rpl_test ok' as result;
