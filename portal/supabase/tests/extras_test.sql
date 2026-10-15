-- 登入纪录、查货补充、多行搬动、搬动筛选（2026-10-15）。接在 bin_test.sql 之后跑。
-- 自己建测试员工（ex.*）与商品 EX01 / EX02，不依赖前面测试留下的资料（只用到 boss = 管理员）。
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
-- 员工编号（借管理员的身分读员工名单，读完换回原本的身分）
create or replace function pg_temp.sid(p_email text) returns bigint language plpgsql as $$
declare v bigint; was text := current_setting('request.jwt.claims', true);
begin
  perform set_config('request.jwt.claims', json_build_object('email', 'boss@example.com')::text, false);
  select (x->>'id')::bigint into v from jsonb_array_elements(public.ops_staff_admin_list()) x where lower(x->>'email') = lower(p_email);
  perform set_config('request.jwt.claims', coalesce(was, ''), false);
  return v;
end $$;
-- 某货架上某商品几件（用 API 读）
create or replace function pg_temp.binqty(p_loc text, p_code text, p_item text) returns numeric language sql as $$
  select coalesce((select (x->>'qty')::numeric
    from jsonb_array_elements(public.ops_wh_bin_get(jsonb_build_object('bin', p_code, 'location', p_loc))->'items') x
    where x->>'item_code' = p_item), 0)
$$;
-- 某人某商品的搬动笔数（全部状态）
create or replace function pg_temp.nmoves(p_item text) returns int language sql as $$
  select jsonb_array_length(public.ops_wh_moves(jsonb_build_object('status', 'all', 'q', p_item)))
$$;
grant execute on all functions in schema pg_temp to authenticated;

-- 测试资料（BI 同步进来的表）：EX01 / EX02
insert into bi.dim_item values ('HOMEWORKSSB', 'EX01', 'EXTRA BASIN WHITE', 'SANITARY', 'HEMOS', 'PCS'),
  ('HOMEWORKSSB', 'EX02', 'EXTRA TAP CHROME', 'TAP', 'HEMOS', 'PCS'),
  ('HOMEWORKSSOUTHERN', 'EX01', 'EXTRA BASIN WHITE', 'SANITARY', 'HEMOS', 'PCS');
insert into bi.fact_stock values
  ('HOMEWORKSSB', 'EX01', 'HQ', 10, 100), ('HOMEWORKSSB', 'EX01', 'SRGADING', 2, 20), ('HOMEWORKSSB', 'EX01', 'DEFECTS', 1, 10),
  ('HOMEWORKSSB', 'EX01', 'JB', 6, 60), ('HOMEWORKSSB', 'EX01', 'PRE (JB)', -2, -20), ('HOMEWORKSSB', 'EX01', 'JB RESER', 0, 0),
  ('HOMEWORKSSB', 'EX01', 'BATU', 0, 0), ('HOMEWORKSSB', 'EX01', 'PRE (BATU)', 0, 0),
  ('HOMEWORKSSB', 'EX01', 'PRE (PUCHONG)', -3, -30),
  ('HOMEWORKSSB', 'EX02', 'HQ', 5, 50),
  ('HOMEWORKSSOUTHERN', 'EX01', 'HQ', 4, 40), ('HOMEWORKSSOUTHERN', 'EX01', 'JB', 1, 10);
-- 25 张发票（每张两行同一商品 = 合成一笔）+ 一张退货 CN（数量存正数，画面要显示负数），全部有金额
insert into bi.fact_sales (company, doc_type, doc_no, doc_date, debtor_name, item_code, qty, uom, unit_price, sub_total, cost, profit)
select 'HOMEWORKSSB', 'IV', 'IV-EX' || lpad(g::text, 3, '0'), date '2026-09-01' + g, '顾客 ' || g, 'EX01', 1, 'PCS', 99, 99, 50, 49
from generate_series(1, 25) g, generate_series(1, 2) k;
insert into bi.fact_sales (company, doc_type, doc_no, doc_date, debtor_name, item_code, qty, uom, unit_price, sub_total)
values ('HOMEWORKSSB', 'CN', 'CN-EX1', date '2026-09-30', '退货顾客', 'EX01', 3, 'PCS', 99, 297);
-- 12 张进货单；PO 行的厂家 = SECRET SUPPLIER；第 12 张同一 PO 有两行（HQ 与 PRE (JB)）
insert into bi.fact_po_line (company, dtl_key, po_no, po_date, creditor_code, creditor_name, item_code, description, location, uom, qty, transferred_qty)
select 'HOMEWORKSSB', 9000 + g, 'PO-EX' || g, date '2026-08-01', '400-S999', 'SECRET SUPPLIER', 'EX01', 'EXTRA BASIN WHITE', 'HQ', 'PCS', 5, 5
from generate_series(1, 12) g;
insert into bi.fact_po_line (company, dtl_key, po_no, po_date, creditor_code, creditor_name, item_code, description, location, uom, qty, transferred_qty)
values ('HOMEWORKSSB', 9100, 'PO-EX12', date '2026-08-01', '400-S999', 'SECRET SUPPLIER', 'EX01', 'EXTRA BASIN WHITE', 'PRE (JB)', 'PCS', 2, 2);
insert into bi.fact_po_receipt (company, src, dtl_key, doc_no, rcv_date, po_no, item_code, qty)
select 'HOMEWORKSSB', 'GR', 9000 + g, 'GRN-EX' || lpad(g::text, 2, '0'), date '2026-08-10' + g, 'PO-EX' || g, 'EX01', 5
from generate_series(1, 12) g;
insert into bi.fact_po_receipt (company, src, dtl_key, doc_no, rcv_date, po_no, item_code, qty)
values ('HOMEWORKSSB', 'GR', 9100, 'GRN-EX12', date '2026-08-22', 'PO-EX12', 'EX01', 2);

set role authenticated;
select pg_temp.as_user('boss@example.com');
select public.ops_staff_save('{"email":"ex.wh@example.com","name":"仓库甲","department":"warehouse","branch":"HOMEWORKSSB"}');
select public.ops_staff_save('{"email":"ex.whmgr@example.com","name":"仓库主管甲","department":"warehouse","branch":"HOMEWORKSSB","role":"manager"}');
select public.ops_staff_save('{"email":"ex.sales@example.com","name":"门市甲","department":"sales","branch":"HOMEWORKSSB"}');
select public.ops_staff_save('{"email":"ex.jb@example.com","name":"JB 仓库甲","department":"warehouse","branch":"HOMEWORKSSOUTHERN"}');
select public.ops_staff_save('{"email":"ex.gm@example.com","name":"经理甲","department":"mgmt","branch":"ALL","role":"manager"}');
select public.ops_staff_save('{"email":"ex.hr@example.com","name":"人事甲","department":"hr","branch":"HOMEWORKSSB"}');
select public.ops_staff_save('{"email":"ex.gone@example.com","name":"已走甲","department":"sales","branch":"HOMEWORKSSB"}');

-- ==================================================================== 1. 登入纪录
select pg_temp.at('2026-10-22 09:00:00+08');
select pg_temp.as_user('ex.wh@example.com');
do $$ begin
  assert (public.ops_login_mark('login', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1')->>'recorded')::boolean, 'login recorded';
end $$;
select pg_temp.at('2026-10-22 09:00:30+08');
do $$ begin
  assert not (public.ops_login_mark('login', 'x')->>'recorded')::boolean, 'second login within 1 minute skipped';
  assert not (public.ops_login_mark('open', 'x')->>'recorded')::boolean, 'open right after login skipped';
end $$;
select pg_temp.at('2026-10-22 09:09:00+08');
do $$ begin assert not (public.ops_login_mark('open', 'x')->>'recorded')::boolean, 'open within 10 min of login skipped'; end $$;
select pg_temp.at('2026-10-22 09:11:00+08');
do $$ begin assert (public.ops_login_mark('OPEN', repeat('u', 400))->>'recorded')::boolean, 'open after 10 min recorded'; end $$;
select pg_temp.at('2026-10-22 09:20:00+08');
do $$ begin assert not (public.ops_login_mark('open', 'x')->>'recorded')::boolean, 'open within 10 min of open skipped'; end $$;
select pg_temp.at('2026-10-22 09:21:30+08');
do $$ begin
  assert (public.ops_login_mark('open', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0')->>'recorded')::boolean, 'open 10+ min later';
  -- 登入不受「打开」的 10 分钟限制
  assert (public.ops_login_mark('login', 'x')->>'recorded')::boolean, 'login not blocked by open';
end $$;
select pg_temp.expect_error($q$select public.ops_login_mark('hack', '')$q$, '未知的登入纪录种类');
-- 测试身分不能直接读表
select pg_temp.expect_error($q$select count(*) from ops.login_log$q$, 'permission denied');
-- 不在名单的人不能记
select pg_temp.as_user('nobody@example.com');
select pg_temp.expect_error($q$select public.ops_login_mark('login', '')$q$, '还没加入营运系统');
-- 昨天的一笔（不算今天）
select pg_temp.at('2026-10-21 23:50:00+08');
select pg_temp.as_user('ex.sales@example.com');
do $$ begin assert (public.ops_login_mark('login', 'Mozilla/5.0 (Linux; Android 14) Chrome/120 Mobile')->>'recorded')::boolean, 'sales login'; end $$;

-- 只有「员工与权限」（管理员）能看
select pg_temp.at('2026-10-22 10:00:00+08');
select pg_temp.as_user('ex.wh@example.com');
select pg_temp.expect_error($q$select public.ops_login_log('{}')$q$, '员工与权限');
select pg_temp.as_user('ex.gm@example.com');
select pg_temp.expect_error($q$select public.ops_login_log('{}')$q$, '员工与权限');
select pg_temp.expect_error($q$select public.ops_login_log(jsonb_build_object('staff_id', pg_temp.sid('ex.wh@example.com')))$q$, '员工与权限');
select pg_temp.as_user('boss@example.com');
do $$ declare r jsonb; w jsonb; s jsonb; d jsonb; begin
  r := public.ops_login_log('{}');
  assert r->>'today' = '2026-10-22', 'today KL: ' || (r->>'today');
  w := (select x from jsonb_array_elements(r->'staff') x where x->>'name' = '仓库甲');
  assert (w->>'today')::int = 4 and (w->>'d30')::int = 4 and (w->>'total')::int = 4, 'counts: ' || w::text;
  assert (w->>'last_login')::timestamptz = '2026-10-22 09:21:30+08' and (w->>'last_open')::timestamptz = '2026-10-22 09:21:30+08', 'last: ' || w::text;
  assert w->>'department_name' is not null and w->>'branch' = 'HOMEWORKSSB', 'dept / branch';
  s := (select x from jsonb_array_elements(r->'staff') x where x->>'name' = '门市甲');
  assert (s->>'today')::int = 0 and (s->>'total')::int = 1, 'yesterday not today: ' || s::text;
  -- 从没登入的人也列出来（最后时间是 null，排在后面）
  assert (select x->>'last_at' from jsonb_array_elements(r->'staff') x where x->>'name' = '人事甲') is null, 'never logged in';
  assert (select min(o) from jsonb_array_elements(r->'staff') with ordinality e(x, o) where x->>'name' = '仓库甲')
       < (select min(o) from jsonb_array_elements(r->'staff') with ordinality e(x, o) where x->>'name' = '人事甲'), 'recent first';
  -- 一个人最近 100 笔：新的在前、User-Agent 截到 300 字
  d := public.ops_login_log(jsonb_build_object('staff_id', pg_temp.sid('ex.wh@example.com')));
  assert jsonb_array_length(d->'rows') = 4 and d->'staff'->>'name' = '仓库甲', 'detail rows: ' || d::text;
  assert d->'rows'->0->>'kind' = 'login' and d->'rows'->1->>'kind' = 'open' and d->'rows'->3->>'kind' = 'login', 'order';
  assert length(d->'rows'->2->>'ua') = 300, 'ua truncated';
end $$;
select pg_temp.expect_error($q$select public.ops_login_log('{"staff_id":"abc"}')$q$, '员工编号不对');
select pg_temp.expect_error($q$select public.ops_login_log('{"staff_id":999999}')$q$, '找不到这位员工');
-- 一个多月后：今天、近 30 天归零，总共不变
select pg_temp.at('2026-12-01 10:00:00+08');
do $$ declare w jsonb; begin
  w := (select x from jsonb_array_elements(public.ops_login_log('{}')->'staff') x where x->>'name' = '仓库甲');
  assert (w->>'today')::int = 0 and (w->>'d30')::int = 0 and (w->>'total')::int = 4, 'later: ' || w::text;
end $$;
select pg_temp.at('2026-10-22 10:00:00+08');
-- 停用的人：照样列（active = false，排在在职的后面）
select public.ops_staff_save(jsonb_build_object('id', pg_temp.sid('ex.gone@example.com'), 'email', 'ex.gone@example.com', 'name', '已走甲',
  'department', 'sales', 'branch', 'HOMEWORKSSB', 'active', false));
do $$ declare r jsonb := public.ops_login_log('{}'); begin
  assert (select not (x->>'active')::boolean from jsonb_array_elements(r->'staff') x where x->>'name' = '已走甲'), 'inactive listed';
  assert not (r->'staff'->(jsonb_array_length(r->'staff') - 1)->>'active')::boolean, 'inactive last';
end $$;

-- ==================================================================== 2. 查货补充
select pg_temp.as_user('ex.sales@example.com');      -- 门市：仓库只看、看不到厂家
do $$ declare r jsonb; x jsonb; o jsonb; begin
  r := public.ops_wh_item_more('{"item":" ex01 "}');
  assert r->>'item_code' = 'EX01' and r->>'company' = 'HOMEWORKSSB' and not (r->>'sees_supplier')::boolean, 'head: ' || left(r::text, 200);
  -- 最近卖出：20 张（同一张两行合起来）、新的在前、不给金额
  assert jsonb_array_length(r->'sales') = 20, 'sales 20';
  assert r->'sales'->0->>'doc_no' = 'CN-EX1' and (r->'sales'->0->>'qty')::numeric = -3, 'CN negative first: ' || (r->'sales'->0)::text;
  assert r->'sales'->1->>'doc_no' = 'IV-EX025' and (r->'sales'->1->>'qty')::numeric = 2 and r->'sales'->1->>'customer' = '顾客 25', 'iv merged';
  for x in select y from jsonb_array_elements(r->'sales') y loop
    assert not (x ?| array['unit_price', 'sub_total', 'cost', 'profit', 'amount']), 'no amounts: ' || x::text;
  end loop;
  assert position('99' in (r->'sales')::text) = 0 and position('297' in (r->'sales')::text) = 0, 'no price anywhere';
  -- 最近进货：10 笔、仓位来自 PO 行；看不到厂家 → 厂家与 PO 号都是 null
  assert jsonb_array_length(r->'receipts') = 10, 'receipts 10';
  assert r->'receipts'->0->>'doc_no' = 'GRN-EX12', 'newest first';
  for x in select y from jsonb_array_elements(r->'receipts') y loop
    assert x->>'supplier' is null and x->>'po_no' is null, 'supplier hidden: ' || x::text;
  end loop;
  assert position('SECRET' in r::text) = 0 and position('PO-EX' in r::text) = 0, 'no supplier / PO anywhere';
  -- GRN-EX12 有两个仓位（HQ 5、PRE (JB) 2）→ 两笔
  assert (select count(*) from jsonb_array_elements(r->'receipts') y where y->>'doc_no' = 'GRN-EX12') = 2, 'grn by location';
  assert (select (y->>'qty')::numeric from jsonb_array_elements(r->'receipts') y where y->>'doc_no' = 'GRN-EX12' and y->>'location' = 'PRE (JB)') = 2,
    'PRE (JB) line';
  -- 按分店：总部自己的 = HQ + SRGADING + DEFECTS；JB 寄存 = JB + PRE (JB) = 4、还欠 2；Puchong 还欠 3；Batu 全是 0 → 不列
  assert jsonb_array_length(r->'outlets') = 3, 'outlets: ' || (r->'outlets')::text;
  o := r->'outlets'->0;
  assert o->>'code' = 'HQ' and o->>'mode' = 'own' and (o->>'total')::numeric = 13 and o->>'consigned' is null, 'hq: ' || o::text;
  assert jsonb_array_length(o->'locations') = 3, 'hq locations';
  o := r->'outlets'->1;
  assert o->>'code' = 'JB' and o->>'mode' = 'consign' and (o->>'own')::numeric = 6 and (o->>'pre')::numeric = -2
     and (o->>'consigned')::numeric = 4 and (o->>'owed')::numeric = 2 and jsonb_array_length(o->'locations') = 3, 'jb: ' || o::text;
  o := r->'outlets'->2;
  assert o->>'code' = 'PUCHONG' and (o->>'consigned')::numeric = 0 and (o->>'owed')::numeric = 3, 'puchong: ' || o::text;
  -- 没有卖过、没有进货的商品：空清单，总部那列照样有
  r := public.ops_wh_item_more('{"item":"EX02"}');
  assert jsonb_array_length(r->'sales') = 0 and jsonb_array_length(r->'receipts') = 0
     and jsonb_array_length(r->'outlets') = 1 and (r->'outlets'->0->>'total')::numeric = 5, 'ex02: ' || r::text;
end $$;
select pg_temp.expect_error($q$select public.ops_wh_item_more('{"item":"NOPE"}')$q$, '找不到这个商品');
-- 仓库部看得到厂家与 PO 号
select pg_temp.as_user('ex.wh@example.com');
do $$ declare r jsonb; begin
  r := public.ops_wh_item_more('{"item":"EX01"}');
  assert (r->>'sees_supplier')::boolean and r->'receipts'->0->>'supplier' = 'SECRET SUPPLIER' and r->'receipts'->0->>'po_no' = 'PO-EX12',
    'supplier shown: ' || (r->'receipts'->0)::text;
end $$;
-- JB：看不到总部；自己账套整本 = JB 自己的
select pg_temp.as_user('ex.jb@example.com');
select pg_temp.expect_error($q$select public.ops_wh_item_more('{"company":"HOMEWORKSSB","item":"EX01"}')$q$, '分店');
do $$ declare r jsonb; begin
  r := public.ops_wh_item_more('{"item":"EX01"}');
  assert r->>'company' = 'HOMEWORKSSOUTHERN' and jsonb_array_length(r->'outlets') = 1 and r->'outlets'->0->>'code' = 'JB'
     and r->'outlets'->0->>'mode' = 'own' and (r->'outlets'->0->>'total')::numeric = 5 and jsonb_array_length(r->'sales') = 0, 'jb own: ' || r::text;
end $$;
-- 没有仓库权限
select pg_temp.as_user('ex.gm@example.com');
do $$ begin assert jsonb_array_length(public.ops_wh_item_more('{"item":"EX01"}')->'sales') = 20, 'mgmt can view'; end $$;
select pg_temp.as_user('ex.hr@example.com');
select pg_temp.expect_error($q$select public.ops_wh_item_more('{"item":"EX01"}')$q$, '仓库');
-- 内部函数一般账号叫不到
select pg_temp.expect_error($q$select ops.wh_date_arg('2026-01-01')$q$, 'permission');

-- ==================================================================== 3. 多行搬动
-- 货架：HQ 的 X-E1-1、X-E1-2，SRGADING 的 X-E2（仓库主管建）
select pg_temp.as_user('ex.whmgr@example.com');
select public.ops_wh_bin_save('{"location":"HQ","zone":"X","shelf":"E1","level":"1"}');
select public.ops_wh_bin_save('{"location":"HQ","zone":"X","shelf":"E1","level":"2"}');
select public.ops_wh_bin_save('{"location":"SRGADING","zone":"X","shelf":"E2"}');
select pg_temp.as_user('ex.wh@example.com');
do $$ begin
  assert (public.ops_wh_bin_op('{"kind":"putaway","item":"EX01","qty":3,"bin":"X-E1-1","location":"HQ"}')->>'ok')::boolean, 'putaway';
end $$;

-- 只看的人不能登记
select pg_temp.as_user('ex.sales@example.com');
select pg_temp.expect_error($q$select public.ops_wh_move_batch('{"kind":"transfer","from_loc":"HQ","to_loc":"SRGADING","lines":[{"item_code":"EX01","qty":1}]}')$q$, '编辑');
select pg_temp.as_user('ex.jb@example.com');
select pg_temp.expect_error($q$select public.ops_wh_move_batch('{"company":"HOMEWORKSSB","kind":"transfer","from_loc":"HQ","to_loc":"SRGADING","lines":[{"item_code":"EX01","qty":1}]}')$q$, '分店');

select pg_temp.as_user('ex.wh@example.com');
select pg_temp.expect_error($q$select public.ops_wh_move_batch('{"kind":"transfer","from_loc":"HQ","to_loc":"SRGADING","lines":[]}')$q$, '请至少加一个商品');
select pg_temp.expect_error($q$select public.ops_wh_move_batch('{"kind":"transfer","from_loc":"HQ","to_loc":"SRGADING"}')$q$, '请至少加一个商品');
select pg_temp.expect_error(format($q$select public.ops_wh_move_batch(%L)$q$,
  jsonb_build_object('kind', 'transfer', 'from_loc', 'HQ', 'to_loc', 'SRGADING',
                     'lines', (select jsonb_agg(jsonb_build_object('item_code', 'EX01', 'qty', 1)) from generate_series(1, 201))))::text,
  '一次最多 200 个商品');
do $$ declare r jsonb; n0 int := pg_temp.nmoves('EX0'); m jsonb; begin
  -- 第 2 行商品找不到 → 整批不存，回传第 2 行
  r := public.ops_wh_move_batch('{"kind":"transfer","from_loc":"HQ","to_loc":"SRGADING","note":"整批",
    "lines":[{"item_code":"EX01","qty":"2"},{"item_code":"NOPE","qty":1},{"item_code":"EX02","qty":1}]}');
  assert not (r->>'ok')::boolean and (r->>'row')::int = 2 and r->>'message' like '%找不到这个商品%', 'row 2: ' || r::text;
  assert pg_temp.nmoves('EX0') = n0, 'nothing saved';
  -- 数量不对
  r := public.ops_wh_move_batch('{"kind":"transfer","from_loc":"HQ","to_loc":"SRGADING","lines":[{"item_code":"EX01","qty":"abc"}]}');
  assert not (r->>'ok')::boolean and (r->>'row')::int = 1 and r->>'message' like '%数量要是%', 'qty: ' || r::text;
  r := public.ops_wh_move_batch('{"kind":"transfer","from_loc":"HQ","to_loc":"SRGADING","lines":[{"item_code":"EX01","qty":0}]}');
  assert not (r->>'ok')::boolean and r->>'message' like '%请填数量%', 'qty 0: ' || r::text;
  -- 报废要原因（ops_wh_move_save 的规则）
  r := public.ops_wh_move_batch('{"kind":"writeoff","from_loc":"HQ","lines":[{"item_code":"EX01","qty":1}]}');
  assert not (r->>'ok')::boolean and r->>'message' like '%写原因%', 'writeoff reason: ' || r::text;
  -- 退货没有「从」：不能选从哪个货架
  r := public.ops_wh_move_batch('{"kind":"return","to_loc":"HQ","lines":[{"item_code":"EX01","qty":1,"from_bin":"X-E1-1"}]}');
  assert not (r->>'ok')::boolean and r->>'message' like '%不能选从哪个货架%', 'return from_bin: ' || r::text;
  -- 货架不够拿 → 第 2 行错，第 1 行的搬动与货架变动都不存
  r := public.ops_wh_move_batch('{"kind":"transfer","from_loc":"HQ","to_loc":"SRGADING",
    "lines":[{"item_code":"EX01","qty":1,"from_bin":"X-E1-1"},{"item_code":"EX01","qty":5,"from_bin":"X-E1-1"}]}');
  assert not (r->>'ok')::boolean and (r->>'row')::int = 2 and r->>'message' like '%不够拿%', 'bin short: ' || r::text;
  assert pg_temp.binqty('HQ', 'X-E1-1', 'EX01') = 3 and pg_temp.nmoves('EX0') = n0, 'rolled back';
  -- 货架不在那个仓位
  r := public.ops_wh_move_batch('{"kind":"transfer","from_loc":"HQ","to_loc":"SRGADING","lines":[{"item_code":"EX01","qty":1,"from_bin":"X-E2"}]}');
  assert not (r->>'ok')::boolean and r->>'message' like '%找不到货架%', 'wrong location bin: ' || r::text;
  -- 全对：两行（EX01 从 X-E1-1 拿 2 放到 X-E2、EX02 不用货架）
  r := public.ops_wh_move_batch('{"kind":"transfer","from_loc":"HQ","to_loc":"SRGADING","note":"整批调去 SRGADING",
    "lines":[{"item_code":"ex01","qty":"2","from_bin":"x-e1-1","to_bin":"X-E2"},{"item_code":"EX02","qty":1.5}]}');
  assert (r->>'ok')::boolean and (r->>'n')::int = 2 and jsonb_array_length(r->'moves') = 2, 'batch ok: ' || r::text;
  m := r->'moves'->0;
  assert m->>'item_code' = 'EX01' and (m->>'qty')::numeric = 2 and m->>'from_loc' = 'HQ' and m->>'to_loc' = 'SRGADING'
     and m->>'note' = '整批调去 SRGADING' and m->>'status' = 'pending' and m->>'created_by_name' = '仓库甲', 'move 1: ' || m::text;
  assert (r->'moves'->1->>'qty')::numeric = 1.5, 'decimal qty';
  assert pg_temp.nmoves('EX0') = n0 + 2, 'two saved';
  assert pg_temp.binqty('HQ', 'X-E1-1', 'EX01') = 1 and pg_temp.binqty('SRGADING', 'X-E2', 'EX01') = 2, 'bins moved';
  perform set_config('test.mv1', m->>'id', false);
  -- 货架帐的变动记在这笔搬动（ref move）
  assert (select count(*) from jsonb_array_elements(public.ops_wh_bin_get('{"bin":"X-E2","location":"SRGADING"}')->'log') g
          where g->>'ref_type' = 'move' and (g->>'ref_id')::bigint = (m->>'id')::bigint and g->>'kind' = 'move') = 1, 'bin log ref';
end $$;
-- 取消这笔搬动 → 货架冲回
do $$ begin
  assert public.ops_wh_move_mark(array[current_setting('test.mv1')::bigint], 'cancelled', '', '') = 1, 'cancel';
  assert pg_temp.binqty('HQ', 'X-E1-1', 'EX01') = 3 and pg_temp.binqty('SRGADING', 'X-E2', 'EX01') = 0, 'reversed on cancel';
end $$;
-- 报坏到 DEFECTS（「到」没有货架就不能选放到哪个货架 → 货架找不到）
do $$ declare r jsonb; begin
  r := public.ops_wh_move_batch('{"kind":"defect","from_loc":"HQ","to_loc":"DEFECTS","note":"压坏",
    "lines":[{"item_code":"EX01","qty":1,"from_bin":"X-E1-1"},{"item_code":"EX02","qty":1}]}');
  assert (r->>'ok')::boolean and (r->>'n')::int = 2, 'defect batch: ' || r::text;
  assert pg_temp.binqty('HQ', 'X-E1-1', 'EX01') = 2, 'defect took from bin';
  r := public.ops_wh_move_batch('{"kind":"sample","from_loc":"HQ","note":"x","lines":[{"item_code":"EX02","qty":1,"to_bin":"X-E1-2"}]}');
  assert not (r->>'ok')::boolean and r->>'message' like '%不能选放到哪个货架%', 'sample has no to: ' || r::text;
end $$;

-- ==================================================================== 4. 搬动纪录筛选
reset role;
-- 350 笔旧的调仓（ex.whmgr 登记，40 天前）：没有日期区间只列最近 300 笔，有日期区间最多 2,000 笔
insert into ops.wh_move (company, item_code, qty, kind, from_loc, to_loc, created_by, created_at)
select 'HOMEWORKSSB', 'EX02', 1, 'transfer', 'HQ', 'SRGADING', (select id from ops.staff where email = 'ex.whmgr@example.com'),
       now() - interval '40 days' - g * interval '1 minute'
from generate_series(1, 350) g;
set role authenticated;
select pg_temp.as_user('ex.sales@example.com');
do $$ declare r jsonb; td text := to_char((now() at time zone 'Asia/Kuala_Lumpur')::date, 'YYYY-MM-DD');
  old text := to_char((now() at time zone 'Asia/Kuala_Lumpur')::date - 40, 'YYYY-MM-DD');
  old1 text := to_char((now() at time zone 'Asia/Kuala_Lumpur')::date - 41, 'YYYY-MM-DD');
  wh bigint := pg_temp.sid('ex.wh@example.com'); mgr bigint := pg_temp.sid('ex.whmgr@example.com'); x jsonb; begin
  perform pg_temp.as_user('ex.sales@example.com');
  assert jsonb_array_length(public.ops_wh_moves('{"status":"all"}')) = 300, 'default limit 300';
  -- 350 笔横跨 40 天前那天与前一天（每笔差 1 分钟）
  assert jsonb_array_length(public.ops_wh_moves(jsonb_build_object('status', 'all', 'q', 'EX02', 'from', old1, 'to', old))) = 350, 'date range up to 2000';
  -- 种类 + 登记人
  r := public.ops_wh_moves(jsonb_build_object('status', 'all', 'move_kind', 'defect', 'created_by', wh));
  assert jsonb_array_length(r) = 2, 'defect by ex.wh: ' || jsonb_array_length(r);
  for x in select y from jsonb_array_elements(r) y loop
    assert x->>'kind' = 'defect' and (x->>'created_by')::bigint = wh, 'filter: ' || x::text;
  end loop;
  -- 今天、登记人 ex.wh：调仓 2（一笔已取消）+ 报坏 2
  r := public.ops_wh_moves(jsonb_build_object('status', 'all', 'from', td, 'to', td, 'created_by', wh));
  assert jsonb_array_length(r) = 4, 'today by ex.wh: ' || jsonb_array_length(r);
  r := public.ops_wh_moves(jsonb_build_object('status', 'cancelled', 'from', td, 'created_by', wh));
  assert jsonb_array_length(r) = 1 and r->0->>'item_code' = 'EX01', 'cancelled one';
  -- 明天以后没有；只给结束日期也算日期区间
  assert jsonb_array_length(public.ops_wh_moves(jsonb_build_object('status', 'all', 'from', to_char((now() at time zone 'Asia/Kuala_Lumpur')::date + 1, 'YYYY-MM-DD')))) = 0, 'future';
  assert jsonb_array_length(public.ops_wh_moves(jsonb_build_object('status', 'all', 'to', old, 'created_by', mgr))) = 350, 'to only';
  -- 搜品名
  r := public.ops_wh_moves(jsonb_build_object('status', 'all', 'q', 'extra basin', 'created_by', wh));
  assert jsonb_array_length(r) = 2 and not exists (select 1 from jsonb_array_elements(r) y where y->>'item_code' <> 'EX01'), 'q description: ' || r::text;
  -- 进货 / 一般搬动分组照旧
  assert jsonb_array_length(public.ops_wh_moves(jsonb_build_object('status', 'all', 'kind', 'receive', 'created_by', wh))) = 0, 'kind receive';
  -- 登记人清单
  r := public.ops_wh_move_people('');
  assert (select (y->>'n')::int from jsonb_array_elements(r) y where (y->>'id')::bigint = mgr) = 350
     and (select (y->>'n')::int from jsonb_array_elements(r) y where (y->>'id')::bigint = wh) = 4, 'people: ' || r::text;
end $$;
select pg_temp.expect_error($q$select public.ops_wh_moves('{"from":"2026-13-01"}')$q$, '日期');
select pg_temp.expect_error($q$select public.ops_wh_moves('{"from":"15/10/2026"}')$q$, 'YYYY-MM-DD');
select pg_temp.expect_error($q$select public.ops_wh_moves('{"from":"2026-10-20","to":"2026-10-01"}')$q$, '开始日期不能晚于结束日期');
select pg_temp.expect_error($q$select public.ops_wh_moves('{"created_by":"x"}')$q$, '登记人不对');
select pg_temp.as_user('ex.jb@example.com');
select pg_temp.expect_error($q$select public.ops_wh_moves('{"company":"HOMEWORKSSB","status":"all"}')$q$, '分店');
select pg_temp.expect_error($q$select public.ops_wh_move_people('HOMEWORKSSB')$q$, '分店');
do $$ begin
  assert not exists (select 1 from jsonb_array_elements(public.ops_wh_move_people('')) y where y->>'name' in ('仓库甲', '仓库主管甲')),
    'jb people: only JB moves';
end $$;
select pg_temp.as_user('ex.hr@example.com');
select pg_temp.expect_error($q$select public.ops_wh_move_people('')$q$, '仓库');
reset role;
select 'extras_test ok' as result;
