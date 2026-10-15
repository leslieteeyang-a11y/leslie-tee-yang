-- 顾客资料第二版测试（接在 cust_test.sql 之后跑）：跟进提醒（含新客回访）、首页人数、员工排行、延长保修。
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

-- 资料（今天 = 马来西亚日期）
select set_config('t.today', ((now() at time zone 'Asia/Kuala_Lumpur')::date)::text, false);
insert into bi.stub_customer_row (member_id, stores, first_date, last_date, doc_count, consent, last_contact_at, next_contact,
                                  birth_month, birth_day) values
  ('60120000001', 'HQ', current_setting('t.today')::date - 8, current_setting('t.today')::date - 8, 1, null, null, null, null, null),
  -- 第 7 天联络过（第 15 天），到第 21 天要再联络一次
  ('60120000002', 'HQ', current_setting('t.today')::date - 25, current_setting('t.today')::date - 25, 1, null,
   (current_setting('t.today')::date - 10)::timestamp at time zone 'Asia/Kuala_Lumpur', null, null, null),
  -- 第 23 天联络过：这一轮已联络
  ('60120000003', 'HQ', current_setting('t.today')::date - 25, current_setting('t.today')::date - 25, 1, null,
   (current_setting('t.today')::date - 2)::timestamp at time zone 'Asia/Kuala_Lumpur', null, null, null),
  ('60120000004', 'HQ', current_setting('t.today')::date - 8, current_setting('t.today')::date - 8, 1, 'no', null, null, null, null),
  ('A:HOMEWORKSSB:300-X01', 'HQ', current_setting('t.today')::date - 8, current_setting('t.today')::date - 8, 1, null, null, null, null, null),
  ('60120000006', 'HQ', current_setting('t.today')::date - 30, current_setting('t.today')::date - 10, 2, null, null, null, null, null),
  ('60120000007', 'HQ', current_setting('t.today')::date - 300, current_setting('t.today')::date - 200, 3, 'yes', null,
   current_setting('t.today')::date - 1, null, null),
  ('60120000009', 'JB', current_setting('t.today')::date - 10, current_setting('t.today')::date - 10, 1, null, null, null, null, null),
  ('60120000010', 'HQ', current_setting('t.today')::date - 50, current_setting('t.today')::date - 50, 1, null, null, null, null, null),
  ('60120000011', 'HQ', current_setting('t.today')::date - 8, current_setting('t.today')::date - 8, 1, null, null,
   current_setting('t.today')::date + 3, null, null),
  ('60120000012', 'HQ', current_setting('t.today')::date - 5, current_setting('t.today')::date - 5, 1, null, null, null, null, null);
-- 3 天后生日（2/29 在平年也不会让整份清单出错：另放一位 2/29 生日、一位不合理的月份）
insert into bi.stub_customer_row (member_id, stores, birth_month, birth_day, last_date)
select '60120000008', 'JB', extract(month from d)::int, extract(day from d)::int, null
  from (select current_setting('t.today')::date + 3 as d) x;
insert into bi.stub_customer_row (member_id, stores, birth_month, birth_day) values ('60120000013', 'HQ', 2, 29), ('60120000014', 'HQ', 13, 1);
-- 只买过一次、之后有退货（CN 让 last_date 往后）：还是新客
insert into bi.stub_customer_row (member_id, stores, first_date, last_date, doc_count) values
  ('60120000015', 'HQ', current_setting('t.today')::date - 9, current_setting('t.today')::date - 3, 1);
-- 没买过、只有总部开的报价单：只在总部的清单
insert into bi.stub_customer_row (member_id, stores, quote_due) values ('60120000016', null, current_setting('t.today')::date - 1);
insert into bi.customer_quote (company, doc_no, doc_date, amount, member_id) values
  ('HOMEWORKSSB', 'QT-1', current_setting('t.today')::date - 8, 500, '60120000016');

-- 门市员工（总部）、JB 门市、仓库（看不到）
set role authenticated;
select pg_temp.as_user('boss@example.com');
select public.ops_staff_save('{"email":"crm2@example.com","name":"门市阿丽","department":"sales","branch":"HOMEWORKSSB"}');
select public.ops_staff_save('{"email":"crm2jb@example.com","name":"JB 阿强","department":"sales","branch":"HOMEWORKSSOUTHERN"}');

-- 1. 跟进提醒：规则与分店
select pg_temp.as_user('crm2@example.com');
do $$ declare j jsonb := public.bi_customer_followups(null); m jsonb := '{}'; e jsonb; begin
  for e in select * from jsonb_array_elements(j) loop m := m || jsonb_build_object(e ->> 'member_id', e -> 'reasons'); end loop;
  assert m -> '60120000001' = '[{"kind": "new", "days": 8}]'::jsonb, 'new day 8: ' || coalesce(m ->> '60120000001', 'missing');
  assert m -> '60120000002' -> 0 ->> 'kind' = 'new', 'second touch at day 21: ' || j::text;
  assert not m ? '60120000003', 'contacted after day 21';
  assert not m ? '60120000004', 'said no to promotions';
  assert not m ? 'A:HOMEWORKSSB:300-X01', 'account customers have no phone';
  assert not m ? '60120000006', 'came back already';
  assert m -> '60120000007' -> 0 ->> 'kind' = 'due', 'due: ' || j::text;
  assert m -> '60120000008' = '[{"kind": "birthday", "days": 3}]'::jsonb, 'birthday in 3 days';
  assert m ? '60120000009', 'JB new in all';
  assert not m ? '60120000010', 'after 45 days stop';
  assert not m ? '60120000011', 'staff booked a later contact date';
  assert not m ? '60120000012', 'not before day 7';
  assert not m ? '60120000014', 'bad birthday ignored';
  assert m -> '60120000015' = '[{"kind": "new", "days": 9}]'::jsonb, 'refund later is not a second purchase';
  assert m -> '60120000016' -> 0 ->> 'kind' = 'quote', 'quote: ' || j::text;
  -- 最急的在前：约好的联络日 > 生日 > 新客（刚到第 7 / 21 天的在前）
  assert j -> 0 ->> 'member_id' = '60120000007', 'due first: ' || j::text;
  assert (select array_agg(x ->> 'member_id' order by n) from jsonb_array_elements(j) with ordinality t(x, n)
           where x ->> 'member_id' in ('60120000001', '60120000002', '60120000009'))
         = array['60120000001', '60120000009', '60120000002'], 'new: just reached day 7 / 21 first: ' || j::text;
  j := public.bi_customer_followups('HQ');
  assert not exists (select 1 from jsonb_array_elements(j) x where x ->> 'member_id' in ('60120000009', '60120000008')), 'HQ only: ' || j::text;
  assert exists (select 1 from jsonb_array_elements(j) x where x ->> 'member_id' = '60120000016'), 'HQ quote in HQ: ' || j::text;
  j := public.bi_customer_followups('JB');
  assert exists (select 1 from jsonb_array_elements(j) x where x ->> 'member_id' = '60120000009')
     and not exists (select 1 from jsonb_array_elements(j) x where x ->> 'member_id' in ('60120000001', '60120000016')), 'JB only: ' || j::text;
end $$;

-- 2. 首页人数：照自己的分店；这个月我联络 / 登记了几位
reset role;
insert into bi.customer_profile_log (member_id, by, action, changes) values
  ('60120000001', 'crm2@example.com', 'update', '{"last_contact_at": [null, "2026-10-15T03:00:00+00:00"]}'),
  ('60120000099', 'crm2@example.com', 'insert', '{"name": [null, "陈先生"], "consent": [null, "yes"]}'),
  ('60120000098', 'crm2@example.com', 'insert', '{"last_contact_at": [null, "2026-10-15T03:00:00+00:00"]}'),
  ('60120000097', '顾客自己扫码登记（HQ）', 'insert', '{"name": [null, "A"], "consent": [null, "yes"]}'),
  ('60120000096', '顾客自己登记（boss@example.com 确认）', 'update', '{"consent": [null, "yes"]}'),
  -- 同一位按很多次只算一位
  ('60120000001', 'crm2@example.com', 'update', '{"last_contact_at": ["2026-10-15T03:00:00+00:00", "2026-10-15T03:05:00+00:00"]}'),
  ('60120000099', 'crm2@example.com', 'update', '{"consent": ["no", "yes"]}'),
  -- 先按「已联络」建了空档，之后补名字：算登记
  ('60120000098', 'crm2@example.com', 'update', '{"name": [null, "林小姐"]}'),
  -- 改名字（原本就有）：不算登记
  ('60120000097', 'crm2@example.com', 'update', '{"name": ["A", "B"]}'),
  -- 只补送货地址（送货页的物流同事也会写）：不算登记
  ('60120000094', 'crm2@example.com', 'insert', '{"address": [null, "No 1 Jalan Test"]}'),
  -- 合并重复顾客搬过去的资料：不算
  ('60120000095', 'boss@example.com（合并）', 'update', '{"name": [null, "合并来的"]}');
set role authenticated;
select pg_temp.as_user('crm2@example.com');
do $$ declare h jsonb := public.ops_cust_home(); begin
  assert h ->> 'store' = 'HQ', 'store: ' || h::text;
  assert (h -> 'by_kind' ->> 'new')::int = 3 and (h -> 'by_kind' ->> 'due')::int = 1 and (h -> 'by_kind' ->> 'quote')::int = 1
     and not (h -> 'by_kind') ? 'birthday', 'HQ kinds: ' || h::text;
  -- 联络 2 位（001 按了两次）；登记 2 位（099 新建档、098 先按已联络后补名字；只按已联络的空档、改名字都不算）
  assert (h ->> 'my_contacts')::int = 2 and (h ->> 'my_registered')::int = 2, 'my month: ' || h::text;
end $$;
select pg_temp.as_user('crm2jb@example.com');
do $$ declare h jsonb := public.ops_cust_home(); begin
  assert h ->> 'store' = 'JB' and (h -> 'by_kind' ->> 'birthday')::int = 1 and (h -> 'by_kind' ->> 'new')::int = 1
     and not (h -> 'by_kind') ? 'quote', 'JB: ' || h::text;
end $$;
select pg_temp.as_user('driver@example.com');
do $$ begin assert public.ops_cust_home() is null, 'no module, no card'; end $$;
select pg_temp.expect_error('select public.bi_customer_followups(null)', '查看权限');

-- 3. 员工排行：名字照员工名单；顾客扫码、确认登记另列（名字不被 @ 切断）；业务员新客 90 天回头率
reset role;
insert into bi.customer_doc (company, doc_type, doc_date, sales_agent, amount, member_id)
select 'HOMEWORKSSB', 'CS', current_setting('t.today')::date - 120, 'ZHI', 100, '6013000000' || g from generate_series(1, 6) g;
insert into bi.customer_doc (company, doc_type, doc_date, sales_agent, amount, member_id)
select 'HOMEWORKSSB', 'CS', current_setting('t.today')::date - 120 + 30, 'ZHI', 50, '6013000000' || g from generate_series(1, 3) g;
insert into bi.customer_doc (company, doc_type, doc_date, sales_agent, amount, member_id) values
  ('HOMEWORKSSB', 'CS', current_setting('t.today')::date - 5, 'ZHI', 80, '60130000004');   -- 第 115 天才回来：不算 90 天内
set role authenticated;
select pg_temp.as_user('crm2@example.com');
do $$ declare b jsonb := public.bi_customer_staff_board(current_setting('t.today')::date - 30, current_setting('t.today')::date); begin
  assert exists (select 1 from jsonb_array_elements(b -> 'staff') x where x ->> 'name' = '门市阿丽'
                   and (x ->> 'contacts')::int = 2 and (x ->> 'registered')::int = 2 and (x ->> 'consents')::int = 1), 'staff: ' || b::text;
  assert not exists (select 1 from jsonb_array_elements(b -> 'staff') x where x ->> 'by' like '%（合并）'), 'merge not counted: ' || b::text;
  assert exists (select 1 from jsonb_array_elements(b -> 'staff') x where x ->> 'name' = '顾客自己扫码登记（HQ）'), 'qr row';
  assert exists (select 1 from jsonb_array_elements(b -> 'staff') x where x ->> 'name' = '顾客自己登记（boss@example.com 确认）'),
    'confirm row keeps full name: ' || b::text;
  assert b -> 'agents' = '[{"agent": "ZHI", "company": "HOMEWORKSSB", "returned_90": 3, "new_customers": 6}]'::jsonb,
    'agents: ' || (b -> 'agents')::text;
end $$;

-- 4. 延长保修：预设不送；只有管理员能开；登记以第一次为准；扫码登记送出即记
do $$ begin
  assert public.bi_customer_signup_offer() = '{"warranty_months": 0, "warranty_back_days": 90}'::jsonb, 'default off';
end $$;
select pg_temp.expect_error($q$select public.bi_customer_warranty_register('012-111 2222')$q$, '还没开延长保修');
select pg_temp.expect_error('select public.bi_customer_set_warranty(12, 90)', '只有管理员');
select pg_temp.as_user('boss@example.com');
select pg_temp.expect_error('select public.bi_customer_set_warranty(99, 90)', '不合理');
select public.bi_customer_set_warranty(12, 90) is not null;
select pg_temp.as_user('crm2@example.com');
do $$ declare p jsonb; begin
  assert public.bi_customer_signup_offer() ->> 'warranty_months' = '12', 'offer on';
  p := public.bi_customer_warranty_register('012-111 2222');
  assert p ->> 'member_id' = '60121112222' and (p ->> 'warranty_months')::int = 12 and p ->> 'warranty_by' = 'crm2@example.com', 'reg: ' || p::text;
  assert (p ->> 'warranty_from')::date = current_setting('t.today')::date - 90, 'from = today - 90: ' || p::text;
end $$;
select pg_temp.expect_error($q$select public.bi_customer_warranty_register('A:HOMEWORKSSB:300-X01')$q$, '手机号');
select pg_temp.as_user('boss@example.com');
select public.bi_customer_set_warranty(6, 30) is not null;
select pg_temp.as_user('crm2@example.com');
do $$ declare p jsonb := public.bi_customer_warranty_register('0121112222'); begin
  assert (p ->> 'warranty_months')::int = 12 and p ->> 'warranty_by' = 'crm2@example.com'
     and (p ->> 'warranty_from')::date = current_setting('t.today')::date - 90, 'first registration kept: ' || p::text;
end $$;
-- 只看的人不能登记
select pg_temp.as_user('hqwh@example.com');
select pg_temp.expect_error($q$select public.bi_customer_warranty_register('0121113333')$q$, '编辑权限');
do $$ begin assert jsonb_typeof(public.bi_customer_followups(null)) = 'array', 'viewer reads followups'; end $$;
reset role;
-- 扫码登记（BI 的共用写入规则）：送保修期间第一次登记就记下来，已登记过的不改
insert into bi.customer_signup (member_id, name, consent, store) values ('0121114444', '扫码新客', true, 'HQ'), ('0121112222', '已登记过', true, 'HQ');
do $$ declare p bi.customer_profile; begin
  perform bi.customer_signup_apply((select id from bi.customer_signup where member_id = '0121114444'), '顾客自己扫码登记（HQ）');
  select * into p from bi.customer_profile where member_id = '60121114444';
  assert p.warranty_months = 6 and p.warranty_by = '顾客自己扫码登记（HQ）' and p.warranty_at is not null and p.consent = 'yes'
     and p.warranty_from = current_setting('t.today')::date - 30, 'qr signup warranty';
  perform bi.customer_signup_apply((select id from bi.customer_signup where member_id = '0121112222'), '顾客自己扫码登记（HQ）');
  select * into p from bi.customer_profile where member_id = '60121112222';
  assert p.warranty_months = 12 and p.warranty_by = 'crm2@example.com' and p.warranty_from = current_setting('t.today')::date - 90,
    'existing warranty kept';
end $$;
-- 顾客扫码登记（9 参数版，anon）：完成页照资料库实际记下的月数
set role anon;
do $$ begin
  assert public.bi_customer_signup('012-111 6666', '扫码', null, null, null, true, 'HQ', null, null) ->> 'warranty_months' = '6', 'new: 6';
  assert public.bi_customer_signup('0121112222', '再扫一次', null, null, null, true, 'HQ', null, null) ->> 'warranty_months' = '12',
    'already registered: first months';
end $$;
reset role;
-- 合并重复顾客：电邮、保修一起搬过来；两边都有保修就留比较早的
insert into bi.customer_profile (member_id, name, email, warranty_at, warranty_months, warranty_by, warranty_from) values
  ('60121117777', '旧号码', 'old@example.com', now() - interval '20 days', 6, 'crm2@example.com', current_date - 50),
  ('60121118888', '新号码', null, null, null, null, null),
  ('60121119991', '甲', null, now() - interval '5 days', 12, 'x@example.com', current_date - 95),
  ('60121119992', '乙', null, now() - interval '30 days', 3, 'y@example.com', current_date - 60);
set role authenticated;
select pg_temp.as_user('boss@example.com');
select public.bi_customer_merge('0121118888', '0121117777') is not null, public.bi_customer_merge('0121119991', '0121119992') is not null;
select pg_temp.as_user('crm2@example.com');
select pg_temp.expect_error($q$select public.bi_customer_merge('0121118888', '0121119991')$q$, '审批');
reset role;
do $$ declare p bi.customer_profile; begin
  select * into p from bi.customer_profile where member_id = '60121118888';
  assert p.email = 'old@example.com' and p.warranty_months = 6 and p.warranty_by = 'crm2@example.com'
     and p.warranty_from = current_date - 50, 'merge carries warranty + email';
  assert not exists (select 1 from bi.customer_profile where member_id = '60121117777'), 'dropped row gone';
  select * into p from bi.customer_profile where member_id = '60121119991';
  assert p.warranty_months = 3 and p.warranty_by = 'y@example.com' and p.warranty_from = current_date - 60, 'earlier registration wins';
end $$;
-- 一位顾客：购买明细每一行带品牌（只在有 Hemos 的单标保修用）。测试资料最后回滚，不影响后面的测试
begin;
insert into bi.dim_item (company, item_code, description, item_group, item_type, base_uom) values
  ('HOMEWORKSSB', 'ZZCUST-H', 'Hemos 龙头', 'SANITARY', 'HEMOS', 'UNIT'), ('HOMEWORKSSB', 'ZZCUST-V', 'Vatti 炉', 'KITCHEN', 'VATTI', 'UNIT');
insert into bi.customer_doc (company, doc_type, doc_key, doc_no, doc_date, amount, member_id) values
  ('HOMEWORKSSB', 'CS', 990001, 'CS-990001', current_date - 3, 300, '60121112222');
insert into bi.fact_sales (company, doc_type, doc_key, dtl_key, doc_no, doc_date, item_code, item_description, qty, uom, sub_total) values
  ('HOMEWORKSSB', 'CS', 990001, 1, 'CS-990001', current_date - 3, 'ZZCUST-H', 'Hemos 龙头', 1, 'UNIT', 200),
  ('HOMEWORKSSB', 'CS', 990001, 2, 'CS-990001', current_date - 3, 'ZZCUST-V', 'Vatti 炉', 1, 'UNIT', 100);
set role authenticated;
select pg_temp.as_user('crm2@example.com');
do $$ declare c jsonb := public.bi_customer('0121112222'); begin
  assert c -> 'docs' -> 0 -> 'items' = '[{"qty": 1, "uom": "UNIT", "brand": "HEMOS", "item_code": "ZZCUST-H", "sub_total": 200, "description": "Hemos 龙头"},
                                         {"qty": 1, "uom": "UNIT", "brand": "VATTI", "item_code": "ZZCUST-V", "sub_total": 100, "description": "Vatti 炉"}]'::jsonb,
    'items with brand: ' || c::text;
  assert (c -> 'profile' ->> 'warranty_months')::int = 12, 'profile has warranty';
end $$;
reset role;
rollback;
update bi.customer_settings set warranty_months = 0 where id = 1;
do $$ declare p bi.customer_profile; begin
  insert into bi.customer_signup (member_id, name, consent, store) values ('0121115555', '不送的时候', true, 'HQ');
  perform bi.customer_signup_apply((select id from bi.customer_signup where member_id = '0121115555'), '顾客自己扫码登记（HQ）');
  select * into p from bi.customer_profile where member_id = '60121115555';
  assert p.warranty_at is null and p.warranty_months is null and p.warranty_from is null, 'no warranty when off';
end $$;
set role anon;
do $$ begin
  assert public.bi_customer_signup('012-111 7676', '不送', null, null, null, true, 'JB', null, null) ->> 'warranty_months' is null, 'off: no months';
end $$;
reset role;
do $$ begin
  assert not has_function_privilege('anon', 'public.bi_customer_followups(text)', 'execute'), 'anon no followups';
  assert has_function_privilege('anon', 'public.bi_customer_signup_offer()', 'execute'), 'anon offer';
  assert not has_function_privilege('anon', 'public.bi_customer_warranty_register(text)', 'execute'), 'anon no register';
  assert not has_function_privilege('anon', 'public.bi_customer_merge(text, text)', 'execute'), 'anon no merge';
  assert not has_function_privilege('anon', 'public.bi_customer(text)', 'execute'), 'anon no customer';
  assert not has_function_privilege('authenticated', 'bi.customer_signup_apply(bigint, text)', 'execute'), 'apply is internal';
end $$;

select 'cust2_test ok';
