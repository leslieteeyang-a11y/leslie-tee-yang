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
