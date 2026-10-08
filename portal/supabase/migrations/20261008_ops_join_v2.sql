-- HomeWorks 营运系统 — 加入申请第二版（2026-10-08，程式审查后改）
-- 第一版在「送出申请」时就用 Auth admin 建好「已验证」的登入账号：拿到加入链接的人可以填**别人的 email**、设自己的密码，
-- 先把账号占走（之后那个 email 被批准、或被加进 BI 名单，就等于冒用身分），而且被拒绝的申请账号还留著。
-- 第二版改成：
--   * 送出时**不建账号**。Edge Function 把密码做成 bcrypt 杂凑存在 join_request.pw_hash（原密码不进资料库），
--     管理员批准时才由 Edge Function 用这个杂凑建账号；被拒绝 → 清掉杂凑，什么账号都不会留下。
--   * email 本来就有登入账号（例：BI 用户）→ Edge Function 先用他输入的密码登入一次验证是本人，has_account = true，不存杂凑。
--   * 没有账号、但 email 在 bi.allowed_users 的 → 不接受（批准会顺便给出 BI 财务权限），请找管理员开。
--   * 同一个 email 已经有待审申请 → 不接受（第一版会被后送的人整张覆盖）。
--   * 同一个来源 IP 一小时最多 5 张；邀请码改 12 码（gen_random_uuid，密码学等级乱数）。
--   * 批准时 email 已经在员工名单：停用的 = 重新启用（复职）、在职的 = 直接连到那位员工，不再卡住。
-- 这个档案不含会被 Supabase MCP 挡下的指令。

alter table ops.join_request
  add column pw_hash text,
  add column has_account boolean not null default false,
  add column client_ip text not null default '',
  add column account_created_at timestamptz;
create index join_request_ip_idx on ops.join_request (client_ip, created_at);

-- 第一版的链接还没发出去；换成 12 码
update ops.join_setting set code = upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12)), updated_at = now()
where id = 1;

-- ------------------------------------------------------------ 打开链接时先检查邀请码（只给 Edge Function 的 service role 叫）
create or replace function public.ops_join_check(p_code text) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select s.enabled and upper(trim(coalesce(p_code, ''))) = s.code from ops.join_setting s where s.id = 1), false)
$$;

-- ------------------------------------------------------------ 送出申请（只给 Edge Function 的 service role 叫）
-- p = {code, email, name, phone, gender, join_date, branch, note, pw_hash, has_account, client_ip}
--   pw_hash / has_account / client_ip 由 Edge Function 填（使用者送不进来：这个函数只有 service role 能叫）
create or replace function public.ops_join_submit(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  em text := lower(trim(coalesce(p->>'email', '')));
  nm text := trim(coalesce(p->>'name', ''));
  acct boolean := coalesce((p->>'has_account')::boolean, false);
  hash text := nullif(p->>'pw_hash', '');
  ip text := left(trim(coalesce(p->>'client_ip', '')), 64);
  jd date;
  r ops.join_request;
begin
  if not public.ops_join_check(p->>'code') then
    raise exception '加入链接已失效，请向管理员要新的链接。' using errcode = '42501';
  end if;
  if em !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or length(em) > 200 then
    raise exception 'email 格式不对。' using errcode = '22023';
  end if;
  if length(nm) = 0 or length(nm) > 80 then
    raise exception '请填名字。' using errcode = '22023';
  end if;
  if coalesce(p->>'gender', '') not in ('', 'M', 'F') then
    raise exception '性别只能是男或女。' using errcode = '22023';
  end if;
  if coalesce(p->>'branch', '') not in ('', 'HOMEWORKSSB', 'HOMEWORKSSOUTHERN') then
    raise exception '上班地点不对。' using errcode = '22023';
  end if;
  begin
    jd := nullif(p->>'join_date', '')::date;
  exception when others then
    raise exception '到职日格式不对。' using errcode = '22023';
  end;
  if exists (select 1 from ops.staff s where lower(s.email) = em and s.active) then
    raise exception '这个 email 已经在员工名单里了，请直接登入；忘了密码请找管理员。' using errcode = '23505';
  end if;
  if exists (select 1 from ops.join_request x where lower(x.email) = em and x.status = 'pending') then
    raise exception '这个 email 已经送出过申请，正在等管理员处理。资料要改请直接找管理员。' using errcode = '23505';
  end if;
  if not acct then
    if exists (select 1 from bi.allowed_users a where lower(a.email) = em) then
      raise exception '这个 email 的账号要由管理员开，请直接找管理员。' using errcode = '42501';
    end if;
    if hash is null or hash !~ '^\$2[aby]\$\d\d\$.{53}$' then
      raise exception '密码处理失败，请再送一次。' using errcode = '22023';
    end if;
  else
    hash := null;
  end if;
  if ip <> '' and (select count(*) from ops.join_request x
                   where x.client_ip = ip and x.created_at > now() - interval '1 hour') >= 5 then
    raise exception '送出太多次了，请一个小时后再试。' using errcode = '54000';
  end if;
  if (select count(*) from ops.join_request where status = 'pending') >= 200 then
    raise exception '申请太多了，请等管理员处理后再送。' using errcode = '54000';
  end if;
  insert into ops.join_request (email, name, phone, gender, join_date, branch, note, pw_hash, has_account, client_ip)
  values (em, nm, left(trim(coalesce(p->>'phone', '')), 30), nullif(p->>'gender', ''), jd, nullif(p->>'branch', ''),
          left(trim(coalesce(p->>'note', '')), 300), hash, acct, ip)
  returning * into r;
  return jsonb_build_object('id', r.id, 'email', r.email, 'has_account', r.has_account);
end $$;

-- ------------------------------------------------------------ 批准后建账号用：拿 / 清掉密码杂凑（只给 Edge Function 的 service role 叫）
create or replace function public.ops_join_pw(p_id bigint, p_clear boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  r ops.join_request;
begin
  select * into r from ops.join_request where id = p_id and status = 'approved' for update;
  if r.id is null then
    return null;
  end if;
  if p_clear then
    update ops.join_request set pw_hash = null,
      account_created_at = case when r.pw_hash is not null then now() else account_created_at end, updated_at = now()
    where id = r.id;
    return jsonb_build_object('id', r.id);
  end if;
  return jsonb_build_object('id', r.id, 'email', lower(r.email), 'pw_hash', r.pw_hash);
end $$;

-- ------------------------------------------------------------ 管理员清单：不回传杂凑与 IP
create or replace function public.ops_join_list() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me ops.staff;
begin
  me := ops.require_level('admin', 'approve');
  return jsonb_build_object(
    'setting', (select jsonb_build_object('code', s.code, 'enabled', s.enabled, 'updated_at', s.updated_at)
                from ops.join_setting s where s.id = 1),
    'pending', (select coalesce(jsonb_agg(ops.join_public(r) order by r.created_at), '[]'::jsonb)
                from ops.join_request r where r.status = 'pending'),
    'recent', (select coalesce(jsonb_agg(ops.join_public(x.r) || jsonb_build_object('decided_by_name', x.decided_by_name)
                                         order by x.decided_at desc), '[]'::jsonb) from (
                 select r, d.name as decided_by_name, r.decided_at from ops.join_request r
                 left join ops.staff d on d.id = r.decided_by
                 where r.status <> 'pending' order by r.decided_at desc limit 30) x(r, decided_by_name, decided_at)));
end $$;

create or replace function ops.join_public(r ops.join_request) returns jsonb
language sql immutable set search_path = '' as $$
  select (to_jsonb(r) - 'pw_hash' - 'client_ip') || jsonb_build_object('need_account', r.pw_hash is not null)
$$;

create or replace function public.ops_join_setting_save(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
begin
  me := ops.require_level('admin', 'approve');
  update ops.join_setting set
    enabled = coalesce((p->>'enabled')::boolean, enabled),
    code = case when coalesce((p->>'new_code')::boolean, false)
                then upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12)) else code end,
    updated_by = me.id, updated_at = now()
  where id = 1;
  perform ops.log(me.id, 'join_setting', 'join_setting', 1, p);
  return (select jsonb_build_object('code', s.code, 'enabled', s.enabled) from ops.join_setting s where s.id = 1);
end $$;

-- p = {id, approve: bool, department, branch, role, title, note}
-- 回传 need_account = true 时，Edge Function 接著用 ops_join_pw 建登入账号。
create or replace function public.ops_join_decide(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  r ops.join_request;
  s ops.staff;
  br text := coalesce(nullif(p->>'branch', ''), 'HOMEWORKSSB');
  rl text := coalesce(nullif(p->>'role', ''), 'staff');
  how text := 'new';
begin
  me := ops.require_level('admin', 'approve');
  select * into r from ops.join_request where id = (p->>'id')::bigint for update;
  if r.id is null or r.status <> 'pending' then
    raise exception '找不到这张申请，或已经处理过了。' using errcode = 'P0002';
  end if;
  if not coalesce((p->>'approve')::boolean, false) then
    update ops.join_request set status = 'rejected', pw_hash = null, decided_by = me.id, decided_at = now(),
      decide_note = left(trim(coalesce(p->>'note', '')), 300), updated_at = now()
    where id = r.id;
    perform ops.log(me.id, 'join_reject', 'join_request', r.id, p);
    return jsonb_build_object('id', r.id, 'status', 'rejected', 'need_account', false);
  end if;
  if not exists (select 1 from ops.department d where d.code = p->>'department') then
    raise exception '请选部门。' using errcode = '22023';
  end if;
  if br not in ('HOMEWORKSSB', 'HOMEWORKSSOUTHERN', 'ALL') then
    raise exception '分店不对。' using errcode = '22023';
  end if;
  if rl not in ('staff', 'manager') then
    raise exception '角色只能是员工或主管。' using errcode = '22023';
  end if;
  select * into s from ops.staff x where lower(x.email) = lower(r.email) for update;
  if s.id is null then
    insert into ops.staff (email, name, department, branch, role, title, phone, active, gender, join_date)
    values (lower(r.email), r.name, p->>'department', br, rl, left(trim(coalesce(p->>'title', '')), 60),
            r.phone, true, r.gender, r.join_date)
    returning * into s;
  elsif not s.active then
    -- 复职：用这次批准选的部门 / 分店 / 角色，到职日换新的
    how := 'rehire';
    update ops.staff set active = true, name = r.name, department = p->>'department', branch = br,
      role = case when role = 'admin' then role else rl end,
      title = coalesce(nullif(left(trim(coalesce(p->>'title', '')), 60), ''), title),
      phone = coalesce(nullif(r.phone, ''), phone), gender = coalesce(r.gender, gender),
      join_date = coalesce(r.join_date, join_date), updated_at = now()
    where id = s.id returning * into s;
  else
    -- 申请期间管理员已经从名单 / Excel 加了这个人：只补空白的资料，不动部门与权限
    how := 'linked';
    update ops.staff set phone = case when coalesce(trim(phone), '') = '' then r.phone else phone end,
      gender = coalesce(gender, r.gender), join_date = coalesce(join_date, r.join_date), updated_at = now()
    where id = s.id returning * into s;
  end if;
  update ops.join_request set status = 'approved', staff_id = s.id, decided_by = me.id, decided_at = now(),
    decide_note = left(trim(coalesce(p->>'note', '')), 300), updated_at = now()
  where id = r.id;
  perform ops.log(me.id, 'join_approve', 'staff', s.id, p || jsonb_build_object('how', how));
  return jsonb_build_object('id', r.id, 'status', 'approved', 'staff_id', s.id, 'how', how,
                            'need_account', r.pw_hash is not null);
end $$;

-- ------------------------------------------------------------ 权限
do $$
begin
  revoke all on function public.ops_join_check(text) from public, anon, authenticated;
  revoke all on function public.ops_join_submit(jsonb) from public, anon, authenticated;
  revoke all on function public.ops_join_pw(bigint, boolean) from public, anon, authenticated;
  revoke all on function ops.join_public(ops.join_request) from public, anon, authenticated;
  revoke all on function public.ops_join_list() from public, anon;
  revoke all on function public.ops_join_setting_save(jsonb) from public, anon;
  revoke all on function public.ops_join_decide(jsonb) from public, anon;
  grant execute on function public.ops_join_list() to authenticated;
  grant execute on function public.ops_join_setting_save(jsonb) to authenticated;
  grant execute on function public.ops_join_decide(jsonb) to authenticated;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.ops_join_check(text) to service_role;
    grant execute on function public.ops_join_submit(jsonb) to service_role;
    grant execute on function public.ops_join_pw(bigint, boolean) to service_role;
  end if;
end $$;
revoke all on all tables in schema ops from public, anon, authenticated;
