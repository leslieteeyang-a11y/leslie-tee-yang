-- 本机测试用：模拟 Supabase 的 auth 与 BI 的 allowed_users（正式环境本来就有，不要套用到 Supabase）
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;
create schema auth;
create table auth.users (id bigint generated always as identity, email text);
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
grant usage on schema auth to authenticated, anon;
grant execute on function auth.jwt() to authenticated, anon;
create schema bi;
create table bi.allowed_users (email text, note text, added_at timestamptz default now(), role text, company text);
insert into bi.allowed_users (email, note, role, company) values
  ('Boss@example.com', 'owner', 'owner', null),
  ('mgr@example.com', '店长 (2026-08-19)', 'manager', 'HOMEWORKSSB'),
  ('buyer@example.com', '订货员', 'buyer', 'HOMEWORKSSB'),
  ('jbsales@example.com', 'JB销售员', 'sales', 'HOMEWORKSSOUTHERN');
insert into auth.users (email) values ('boss@example.com'), ('buyer@example.com');

-- 订货（第 2 阶段）用到的 BI 表，栏位与正式环境相同（只取用到的）
create table bi.fact_po_line (company text, po_key bigint, dtl_key bigint, po_no text, po_date date, creditor_code text,
  creditor_name text, cancelled boolean default false, item_code text, description text, location text, uom text,
  qty numeric, transferred_qty numeric default 0, foc_qty numeric default 0, unit_price numeric, sub_total numeric,
  est_delivery date);
create table bi.v_supplier_param (company text, creditor_code text, name text, is_china boolean, lead_days int);
create table bi.dim_item (company text, item_code text, description text, item_group text, item_type text, base_uom text,
  is_active boolean default true);
create table bi.fact_stock (company text, item_code text, location text, qty numeric, total_cost numeric);
create table bi.fact_po_receipt (company text, src text, dtl_key bigint, doc_no text, rcv_date date, po_no text,
  item_code text, qty numeric);
insert into bi.v_supplier_param values ('HOMEWORKSSB', '4000-M002', 'MAIDEN (CS)', true, 60),
  ('HOMEWORKSSB', '400-S001', 'SHING SOON HENG', false, 7);
insert into bi.dim_item values ('HOMEWORKSSB', 'ST001', 'RAXON HOSE', 'TAP', 'HEMOS', 'SETS'),
  ('HOMEWORKSSB', 'ST002', 'RAXON BIDET', 'TAP', 'HEMOS', 'SETS'),
  ('HOMEWORKSSOUTHERN', 'ST001', 'RAXON HOSE', 'TAP', 'HEMOS', 'SETS');
insert into bi.fact_stock values ('HOMEWORKSSB', 'ST001', 'HQ', 5, 50), ('HOMEWORKSSB', 'ST001', 'SRGADING', 3, 30);
insert into bi.fact_po_line (company, dtl_key, po_no, po_date, creditor_code, creditor_name, item_code, description,
                             location, uom, qty, transferred_qty, unit_price, est_delivery) values
  -- 中国货，开单 10 天前，交期 60 天 → 未逾期
  ('HOMEWORKSSB', 1, 'PO-1', current_date - 10, '4000-M002', 'CS065', 'ST001', 'RAXON HOSE', 'SRGADING', 'SETS', 10, 0, 12.5, current_date - 10),
  ('HOMEWORKSSB', 2, 'PO-1', current_date - 10, '4000-M002', 'CS065', 'ST002', 'RAXON BIDET', 'SRGADING', 'SETS', 20, 5, 8, null),
  -- 本地货，AutoCount 预计交货日已过 → 逾期
  ('HOMEWORKSSB', 3, 'PO-2', current_date - 20, '400-S001', 'SHING SOON HENG', 'ST001', 'RAXON HOSE', 'HQ', 'SETS', 4, 0, 10, current_date - 3),
  -- 已全部到货 → 不在清单
  ('HOMEWORKSSB', 4, 'PO-3', current_date - 20, '400-S001', 'SHING SOON HENG', 'ST001', 'RAXON HOSE', 'HQ', 'SETS', 4, 4, 10, null),
  -- 两年前的旧单 → 预设隐藏
  ('HOMEWORKSSB', 5, 'PO-OLD', current_date - 700, '400-S001', 'SHING SOON HENG', 'ST002', 'RAXON BIDET', 'HQ', 'SETS', 1, 0, 10, null),
  -- JB 的单
  ('HOMEWORKSSOUTHERN', 6, 'PO-JB', current_date - 5, '400-S001', 'HOMEWORKS', 'ST001', 'RAXON HOSE', 'HQ', 'SETS', 2, 0, 9, null);

-- ETA 修正 / 同步时间（2026-09-28b）
create table bi.sync_log (id bigint generated always as identity, step text, started_at timestamptz,
  finished_at timestamptz, rows int, ok boolean, error text);
insert into bi.sync_log (step, started_at, finished_at, rows, ok) values
  ('purchase:HOMEWORKSSB:load', now() - interval '2 hours', now() - interval '2 hours', 10, true),
  ('purchase:HOMEWORKSSB:load', now() - interval '1 hour', now() - interval '1 hour', 0, false),
  ('stock:HOMEWORKSSB:load', now() - interval '3 hours', now() - interval '3 hours', 10, true),
  ('purchase:HOMEWORKSSOUTHERN:load', now() - interval '5 hours', now() - interval '5 hours', 10, true);
-- 中国货：AutoCount 预计交货日只填开单后 5 天（不可信）/ 开单后 45 天（可信）
insert into bi.fact_po_line (company, dtl_key, po_no, po_date, creditor_code, creditor_name, item_code, description,
                             location, uom, qty, transferred_qty, unit_price, est_delivery) values
  ('HOMEWORKSSB', 7, 'PO-CN5', current_date - 40, '4000-M002', 'CS065', 'ST001', 'RAXON HOSE', 'SRGADING', 'SETS', 1, 0, null, current_date - 35),
  ('HOMEWORKSSB', 8, 'PO-CN45', current_date - 50, '4000-M002', 'CS065', 'ST001', 'RAXON HOSE', 'SRGADING', 'SETS', 1, 0, null, current_date - 5);
