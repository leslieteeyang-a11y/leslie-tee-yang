-- 顾客资料测试（接在 sop_test.sql 之后跑）。BI 的权限函数与顾客资料函数的 stub 在 stub_supabase.sql 最后。
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

-- 0. 改写：顾客资料函数换成 bi.crm_require（读取的多一个 true），送货的不动；「没电话的单」改用 bi.crm_company
do $$ begin
  assert (select prosrc from pg_proc where oid = 'public.bi_customers()'::regprocedure)
         like '%bi.crm_require(array[''owner'', ''manager'', ''sales''], true)%', 'stable gets read-only flag';
  assert (select prosrc from pg_proc where oid = 'public.bi_customer_save(text, text)'::regprocedure)
         like '%bi.crm_require(array[''owner'', ''manager'', ''sales''])%', 'volatile has no flag';
  assert (select prosrc from pg_proc where oid = 'public.bi_customer_set_settings(numeric)'::regprocedure)
         like '%v_role text := bi.crm_require(array[''owner''])%', 'assignment form rewritten';
  assert (select prosrc from pg_proc where oid = 'public.bi_customer_missing_phone(integer)'::regprocedure)
         like '%bi.crm_company()%', 'missing phone uses crm_company';
  assert (select prosrc from pg_proc where oid = 'public.bi_delivery_stub_check()'::regprocedure)
         like '%bi.customer_require(%', 'delivery untouched';
  assert (select prosrc from pg_proc where oid = 'public.bi_customer_set_geo(text)'::regprocedure)
         like '%bi.customer_require(%', 'BI delivery geo untouched';
  assert (select prosrc from pg_proc where oid = 'public.bi_customer_stub_reader()'::regprocedure)
         like '%bi.crm_require(array[''owner'', ''manager'', ''sales''])%', 'stable but not in read list: no flag';
  assert not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                      where n.nspname = 'public' and p.proname ~ '^bi_(customer|campaign|wa_template)'
                        and p.proname not in ('bi_customer_set_address', 'bi_customer_set_geo')
                        and p.prosrc like '%bi.customer_require(%'), 'no CRM function left on customer_require';
  assert (select prosecdef from pg_proc where oid = 'public.bi_customers()'::regprocedure), 'still security definer';
  assert has_function_privilege('authenticated', 'public.bi_customers()', 'execute'), 'grant kept';
  assert (select name from ops.module where key = 'customers') = '顾客资料', 'module';
  assert (select level from ops.dept_module where department = 'sales' and module = 'customers') = 'edit', 'sales edit';
  assert (select level from ops.dept_module where department = 'mgmt' and module = 'customers') = 'approve', 'mgmt approve';
  assert not exists (select 1 from ops.dept_module where module = 'customers' and department not in ('sales', 'mgmt')),
    'other departments none';
end $$;

-- 员工：门市主管（sales manager）、送货部司机（dlv_test 建的）、仓库只看（个人例外）
select set_config('cust.wh', (select id::text from ops.staff where email = 'hqwh@example.com'), false);
select set_config('cust.hqsales', (select id::text from ops.staff where email = 'hqsales@example.com'), false);
select set_config('cust.buyer', (select id::text from ops.staff where email = 'buyer@example.com'), false);
set role authenticated;
select pg_temp.as_user('boss@example.com');
select public.ops_staff_save('{"email":"salesmgr@example.com","name":"门市主管","department":"sales","branch":"HOMEWORKSSOUTHERN","role":"manager"}');
select public.ops_staff_save(jsonb_build_object(
  'id', current_setting('cust.wh')::bigint,
  'email', 'hqwh@example.com', 'overrides', jsonb_build_object('customers', 'view')));

-- 1. 管理员（BI owner）：owner，什么都能做
do $$ begin
  assert public.ops_cust_role() = 'owner', 'boss owner';
  assert (public.bi_customer_set_settings(9000)->>'role') = 'owner', 'boss settings';
  assert public.bi_campaigns() = '[]'::jsonb, 'boss campaigns';
end $$;

-- 2. 门市（只在营运系统、BI 名单没有）：sales = 看、改，不能建活动 / 改设定；「没电话的单」只看自己分店
select pg_temp.as_user('hqsales@example.com');
do $$ declare r jsonb; begin
  assert public.ops_cust_role() = 'sales', 'hqsales sales: ' || coalesce(public.ops_cust_role(), 'null');
  r := public.bi_customer_save('60123456789', '陈先生');
  assert r->>'updated_by' = 'hqsales@example.com' and r->>'name' = '陈先生', 'save: ' || r::text;
  assert exists (select 1 from public.bi_customers() c where c.member_id = '60123456789'), 'list';
  assert (select array_agg(doc_no) from public.bi_customer_missing_phone(60)) = array['CS-1'], 'HQ only';
end $$;
select pg_temp.expect_error('select public.bi_campaigns()', '你没有「顾客资料」模块的审批权限');
select pg_temp.expect_error('select public.bi_customer_set_settings(1)', '这个动作只有管理员可以做');
-- 送货的 BI 函数照旧只认 BI 名单
select pg_temp.expect_error('select public.bi_delivery_stub_check()', '没有权限：顾客资料只开放给');

-- 3. 门市主管（JB）：manager = 可以建活动，不能改设定；「没电话的单」只看 JB
select pg_temp.as_user('salesmgr@example.com');
do $$ begin
  assert public.ops_cust_role() = 'manager', 'sales manager';
  assert public.bi_campaigns() = '[]'::jsonb, 'manager campaigns';
  assert (select array_agg(doc_no) from public.bi_customer_missing_phone(60)) = array['CS-2'], 'JB only';
end $$;
select pg_temp.expect_error('select public.bi_customer_set_settings(1)', '只有管理员');

-- 4. 只看（仓库「仓库看PO」的个人例外）：只能叫读取的函数
select pg_temp.as_user('hqwh@example.com');
do $$ begin
  assert public.ops_cust_role() = 'viewer', 'viewer';
  assert exists (select 1 from public.bi_customers()), 'viewer reads list';
end $$;
select pg_temp.expect_error($q$select public.bi_customer_save('60123456789', 'x')$q$, '你没有「顾客资料」模块的编辑权限');
select pg_temp.expect_error('select public.bi_campaigns()', '审批权限');
select pg_temp.expect_error('select public.bi_customer_stub_reader()', '编辑权限');   -- 不在只看名单的读取函数 = 当成要可编辑

-- 5. 送货部司机、其他部门：看不到
select pg_temp.as_user('driver@example.com');
do $$ begin assert public.ops_cust_role() is null, 'driver none'; end $$;
select pg_temp.expect_error('select * from public.bi_customers()', '你没有「顾客资料」模块的查看权限');
select pg_temp.as_user('hr@example.com');
select pg_temp.expect_error('select * from public.bi_customers()', '查看权限');

-- 6. 个人例外「无」：门市也可以被拿掉
select pg_temp.as_user('boss@example.com');
select public.ops_staff_save(jsonb_build_object(
  'id', current_setting('cust.hqsales')::bigint,
  'email', 'hqsales@example.com', 'overrides', jsonb_build_object('customers', 'none')));
select pg_temp.as_user('hqsales@example.com');
do $$ begin assert public.ops_cust_role() is null, 'override none'; end $$;
select pg_temp.expect_error('select * from public.bi_customers()', '查看权限');

-- 7. BI 名单的人照旧：BI 店长（manager）可以；BI 订货员（buyer）也是营运系统员工 → 营运系统的说法
select pg_temp.as_user('mgr@example.com');
do $$ begin
  assert public.ops_cust_role() = 'manager', 'bi manager';
  assert public.bi_campaigns() = '[]'::jsonb, 'bi manager campaigns';
end $$;
select pg_temp.as_user('buyer@example.com');
do $$ begin assert public.ops_cust_role() is null, 'buyer none'; end $$;
select pg_temp.expect_error('select * from public.bi_customers()', '你没有「顾客资料」模块的查看权限');

-- 7b. BI 订货员 + 营运系统给了「顾客资料 = 可编辑」：可以改，不能建活动（营运系统的说法）
select pg_temp.as_user('boss@example.com');
select public.ops_staff_save(jsonb_build_object('id', current_setting('cust.buyer')::bigint, 'email', 'buyer@example.com',
                                                'overrides', jsonb_build_object('customers', 'edit')));
select pg_temp.as_user('buyer@example.com');
do $$ begin
  assert public.ops_cust_role() = 'sales', 'buyer + ops edit';
  perform public.bi_customer_save('60123456789', '陈先生');
end $$;
select pg_temp.expect_error('select public.bi_campaigns()', '你没有「顾客资料」模块的审批权限');
-- 营运系统的管理员（不在 BI 名单）= owner
select pg_temp.as_user('boss@example.com');
select public.ops_staff_save('{"email":"custadmin@example.com","name":"顾客测试管理员","department":"mgmt","branch":"ALL","role":"admin"}');
select pg_temp.as_user('custadmin@example.com');
do $$ begin
  assert public.ops_cust_role() = 'owner', 'ops admin owner';
  assert (public.bi_customer_set_settings(1)->>'role') = 'owner', 'ops admin settings';
  assert (select count(*) from public.bi_customer_missing_phone(60)) = 2, 'ALL branch sees both';
end $$;

-- 8. 不在任何名单：BI 的说法；anon 叫不到角色函数
select pg_temp.as_user('stranger@example.com');
do $$ begin assert public.ops_cust_role() is null, 'stranger none'; end $$;
select pg_temp.expect_error('select * from public.bi_customers()', '没有权限：顾客资料只开放给');
reset role;
do $$ begin
  assert not has_function_privilege('anon', 'public.ops_cust_role()', 'execute'), 'anon cannot';
  assert not has_function_privilege('authenticated', 'bi.crm_require(text[], boolean)', 'execute'), 'gate not callable';
end $$;

-- 9. 模块开关关着（前端还没部署）：营运系统的员工进不来，BI 名单的人照旧
update ops.module set ready = false where key = 'customers';
set role authenticated;
select pg_temp.as_user('salesmgr@example.com');
do $$ begin assert public.ops_cust_role() is null, 'not ready: none'; end $$;
select pg_temp.expect_error('select * from public.bi_customers()', '你没有「顾客资料」模块的查看权限');
select pg_temp.as_user('boss@example.com');
do $$ begin assert public.ops_cust_role() = 'owner', 'BI owner unaffected'; end $$;
reset role;
update ops.module set ready = true where key = 'customers';

-- 10. 最后上班日过了：营运系统的权限跟着没了
update ops.staff set last_day = ops.today() - 1 where email = 'salesmgr@example.com';
set role authenticated;
select pg_temp.as_user('salesmgr@example.com');
do $$ begin assert public.ops_cust_role() is null, 'offboarded none'; end $$;
reset role;

select 'cust_test ok';
