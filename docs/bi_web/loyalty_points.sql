-- ⚠️ 已作废（2026-09-29）：使用者不要积分，改成顾客资料，见 customer_profiles.sql。此档只留历史。
-- 顾客积分（migration `loyalty_points`，2026-09-28）
-- 门市散客（HQ RETAIL；JB RETAIL + 空白类型）用电话当会员号，总公司与 JB 合并计算。
-- 积分不存盘：每次从 bi.fact_sales（每天同步）现算，只有兑换 / 手动调整存在 bi.loyalty_txn。
-- 读写一律走 public.bi_loyalty_* RPC（SECURITY DEFINER，函数内检查角色），不开视图。

-- ── 设定（只有一列） ──
create table bi.loyalty_settings (
  id int primary key default 1 check (id = 1),
  start_date date not null default '2026-01-01',
  earn_points_per_rm numeric not null default 1 check (earn_points_per_rm > 0),
  redeem_points_per_rm numeric not null default 100 check (redeem_points_per_rm > 0),
  expiry_months int not null default 12 check (expiry_months between 1 and 120),
  min_redeem_points int not null default 100 check (min_redeem_points >= 1),
  updated_at timestamptz not null default now(),
  updated_by text
);
insert into bi.loyalty_settings default values;

-- ── 哪些客户类型算门市散客（debtor_type 空白写 ''） ──
create table bi.loyalty_eligible (
  company text not null,
  debtor_type text not null,
  primary key (company, debtor_type)
);
insert into bi.loyalty_eligible values
  ('HOMEWORKSSB', 'RETAIL'),
  ('HOMEWORKSSOUTHERN', 'RETAIL'),
  ('HOMEWORKSSOUTHERN', '');

-- ── 兑换与手动调整（兑换存负数；作废不删，留痕） ──
create table bi.loyalty_txn (
  id bigint generated always as identity primary key,
  member_id text not null check (member_id ~ '^([0-9]{9,13}|A:[A-Z]+:.+)$'),
  kind text not null check (kind in ('redeem', 'adjust')),
  points int not null check (points <> 0),
  rm_value numeric(12,2),
  company text,
  doc_no text,
  note text,
  created_at timestamptz not null default now(),
  created_by text not null,
  voided_at timestamptz,
  voided_by text,
  void_reason text,
  check (kind <> 'redeem' or points < 0)
);
create index loyalty_txn_member_idx on bi.loyalty_txn (member_id);

alter table bi.loyalty_settings enable row level security;
alter table bi.loyalty_eligible enable row level security;
alter table bi.loyalty_txn enable row level security;
revoke all on bi.loyalty_settings, bi.loyalty_eligible, bi.loyalty_txn from anon, authenticated;

-- ── 从客户名称抽电话，统一成国码开头的纯数字（60… 马来西亚、65… 新加坡） ──
-- 先把「数字-空格-数字」连起来试；不行再只连「-」「.」（避免两个号码被空格黏成一串）。
create or replace function bi.loyalty_phone(p_name text)
returns text
language plpgsql immutable
set search_path = ''
as $$
declare
  s text;
  cand text;
  d text;
begin
  if p_name is null then
    return null;
  end if;
  foreach s in array array[
    regexp_replace(p_name, '([0-9])[ .-]+(?=[0-9])', '\1', 'g'),
    regexp_replace(p_name, '([0-9])[.-]+(?=[0-9])', '\1', 'g')
  ] loop
    for cand in select m[1] from regexp_matches(s, '([0-9]{8,})', 'g') as m loop
      d := case
        when cand ~ '^601[0-9]{8,9}$' then cand
        when cand ~ '^01[0-9]{8,9}$' then '6' || cand
        when cand ~ '^1[0-9]{8,9}$' then '60' || cand
        when cand ~ '^65[89][0-9]{7}$' then cand
        when cand ~ '^[89][0-9]{7}$' then '65' || cand
        when cand ~ '^0[3-9][0-9]{7,8}$' then '6' || cand
        when cand ~ '^60[3-9][0-9]{7,8}$' then cand
      end;
      if d is not null then
        return d;
      end if;
    end loop;
  end loop;
  return null;
end;
$$;

-- ── 每张符合资格的单据（IV / CS / CN），含会员号 ──
-- 会员号：单据客户名称里的电话 → 客户主档名称里的电话 → 自己有账号（不是 CASH 共用账号）就用 A:公司:客户代号
create or replace view bi.loyalty_doc as
with d as (
  select f.company, f.doc_type, f.doc_key, f.doc_no, f.doc_date, f.debtor_code,
         max(f.debtor_name) as debtor_name, c.name as customer_name,
         max(f.sales_agent) as sales_agent,
         sum(f.sub_total) as amount  -- fact_sales 的 CN 已是负数
    from bi.fact_sales f
    join bi.dim_customer c on c.company = f.company and c.debtor_code = f.debtor_code
    join bi.loyalty_eligible e on e.company = f.company and e.debtor_type = coalesce(c.debtor_type, '')
   where f.doc_date >= (select s.start_date from bi.loyalty_settings s where s.id = 1)
     and f.doc_type in ('IV', 'CS', 'CN')
   group by f.company, f.doc_type, f.doc_key, f.doc_no, f.doc_date, f.debtor_code, c.name
)
select d.*,
       coalesce(
         bi.loyalty_phone(d.debtor_name),
         bi.loyalty_phone(d.customer_name),
         case when d.customer_name !~* '^\s*CASH' then 'A:' || d.company || ':' || d.debtor_code end
       ) as member_id
  from d;
revoke all on bi.loyalty_doc from anon, authenticated;

-- ── 积分引擎：先进先出，每笔积分 expiry_months 个月后作废 ──
-- 退货（CN）与兑换从最旧的积分扣；扣到 0 为止不欠分（今年退去年买的货，不该变负数；兑换本来就查过余额）。
create or replace function bi.loyalty_calc(p_member text default null, p_asof date default null)
returns table (
  member_id text, earned int, returned int, redeemed int, adjusted int,
  expired int, balance int, expiring_soon int, next_expiry date
)
language plpgsql stable
set search_path = ''
as $$
#variable_conflict use_column
declare
  st bi.loyalty_settings;
  v_asof date := coalesce(p_asof, (now() at time zone 'Asia/Kuala_Lumpur')::date);
  r record;
  cur text;
  b_exp date[];
  b_pts int[];
  head int;
  v_earned int; v_ret int; v_red int; v_adj int; v_exp int;
  pts int; take int; i int; v_bal int; v_soon int;
begin
  select * into st from bi.loyalty_settings s where s.id = 1;
  for r in
    select e.mid, e.d, e.pts, e.kind from (
      select ld.member_id as mid, ld.doc_date as d,
             trunc(ld.amount * st.earn_points_per_rm)::int as pts,
             case when ld.amount < 0 then 'return' else 'earn' end as kind, 0 as ord
        from bi.loyalty_doc ld
       where ld.member_id is not null and (p_member is null or ld.member_id = p_member)
      union all
      select t.member_id, (t.created_at at time zone 'Asia/Kuala_Lumpur')::date, t.points, t.kind, 1
        from bi.loyalty_txn t
       where t.voided_at is null and (p_member is null or t.member_id = p_member)
      union all
      select null, null, 0, 'end', 9
    ) e
    where e.pts <> 0 or e.kind = 'end'
    order by e.mid nulls last, e.d, e.ord, e.pts desc
  loop
    if cur is distinct from r.mid then
      if cur is not null then
        -- 结算上一位：到 v_asof 为止到期的作废
        while head <= coalesce(array_length(b_pts, 1), 0) and b_exp[head] <= v_asof loop
          v_exp := v_exp + b_pts[head];
          head := head + 1;
        end loop;
        v_bal := 0;
        v_soon := 0;
        for i in head .. coalesce(array_length(b_pts, 1), 0) loop
          v_bal := v_bal + b_pts[i];
          if b_exp[i] <= v_asof + 60 then
            v_soon := v_soon + b_pts[i];
          end if;
        end loop;
        member_id := cur; earned := v_earned; returned := v_ret; redeemed := v_red;
        adjusted := v_adj; expired := v_exp; balance := v_bal; expiring_soon := v_soon;
        next_expiry := case when head <= coalesce(array_length(b_pts, 1), 0) then b_exp[head] end;
        return next;
      end if;
      exit when r.kind = 'end';
      cur := r.mid;
      b_exp := '{}'; b_pts := '{}'; head := 1;
      v_earned := 0; v_ret := 0; v_red := 0; v_adj := 0; v_exp := 0;
    end if;

    -- 这一天之前（含）到期的先作废
    while head <= coalesce(array_length(b_pts, 1), 0) and b_exp[head] <= r.d loop
      v_exp := v_exp + b_pts[head];
      head := head + 1;
    end loop;

    pts := r.pts;
    if pts > 0 then
      if r.kind = 'earn' then
        v_earned := v_earned + pts;
      else
        v_adj := v_adj + pts;
      end if;
      b_exp := b_exp || (r.d + make_interval(months => st.expiry_months))::date;
      b_pts := b_pts || pts;
    else
      pts := -pts;
      while pts > 0 and head <= coalesce(array_length(b_pts, 1), 0) loop
        take := least(pts, b_pts[head]);
        b_pts[head] := b_pts[head] - take;
        pts := pts - take;
        if b_pts[head] = 0 then
          head := head + 1;
        end if;
      end loop;
      -- 只记实际扣到的分数，让 已赚 − 退货 − 兑换 ± 调整 − 过期 = 余额
      take := -r.pts - pts;
      case r.kind
        when 'return' then v_ret := v_ret + take;
        when 'redeem' then v_red := v_red + take;
        else v_adj := v_adj - take;
      end case;
    end if;
  end loop;
end;
$$;
revoke all on function bi.loyalty_calc(text, date) from public, anon, authenticated;

-- ── 权限小工具 ──
create or replace function bi.loyalty_require(p_roles text[])
returns text
language plpgsql stable
set search_path = ''
as $$
declare
  v_role text := (select public.bi_role());
begin
  if not coalesce((select public.bi_is_allowed()), false) or v_role is null or not (v_role = any(p_roles)) then
    raise exception '没有权限：顾客积分只开放给 %', array_to_string(p_roles, ' / ');
  end if;
  return v_role;
end;
$$;

-- 使用者输入的电话 / 会员号 → 会员号
create or replace function bi.loyalty_member_key(p_input text)
returns text
language sql immutable
set search_path = ''
as $$
  select case when p_input ~ '^A:' then p_input else bi.loyalty_phone(p_input) end;
$$;

-- ── 会员列表（搜寻电话或名字） ──
create or replace function public.bi_loyalty_members(p_search text default null, p_limit int default 300)
returns table (
  member_id text, name text, stores text, first_date date, last_date date, doc_count int,
  spent numeric, earned int, returned int, redeemed int, adjusted int, expired int,
  balance int, expiring_soon int, next_expiry date
)
language plpgsql stable security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_digits text := regexp_replace(coalesce(p_search, ''), '[^0-9]', '', 'g');
  v_text text := nullif(trim(coalesce(p_search, '')), '');
begin
  perform bi.loyalty_require(array['owner', 'manager', 'sales']);
  return query
  with docs as (
    select ld.member_id,
           (array_agg(ld.debtor_name order by ld.doc_date desc, ld.amount desc))[1] as name,
           string_agg(distinct case ld.company when 'HOMEWORKSSB' then 'HQ' else 'JB' end, ' + ') as stores,
           min(ld.doc_date) as first_date, max(ld.doc_date) as last_date,
           count(*) filter (where ld.amount > 0)::int as doc_count,
           sum(ld.amount) as spent
      from bi.loyalty_doc ld
     where ld.member_id is not null
     group by ld.member_id
  ),
  hits as (
    select d.* from docs d
     where v_text is null
        or (length(v_digits) >= 4 and d.member_id like '%' || v_digits || '%')
        or d.name ilike '%' || v_text || '%'
        or d.member_id ilike '%' || v_text || '%'
  )
  select h.member_id, h.name, h.stores, h.first_date, h.last_date, h.doc_count, round(h.spent, 2),
         c.earned, c.returned, c.redeemed, c.adjusted, c.expired, c.balance, c.expiring_soon, c.next_expiry
    from hits h
    join bi.loyalty_calc() c on c.member_id = h.member_id
   order by h.last_date desc, h.member_id
   limit greatest(1, least(coalesce(p_limit, 300), 5000));
end;
$$;

-- ── 单一会员：摘要 + 购买历史（含品项）+ 兑换 / 调整纪录 ──
create or replace function public.bi_loyalty_member(p_member text)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_key text := bi.loyalty_member_key(p_member);
  st bi.loyalty_settings;
  v_summary jsonb;
  v_docs jsonb;
  v_txns jsonb;
begin
  perform bi.loyalty_require(array['owner', 'manager', 'sales']);
  if v_key is null then
    raise exception '看不出电话号码：请输入完整手机号，例如 012-3456789 或 +65 9123 4567';
  end if;
  select * into st from bi.loyalty_settings s where s.id = 1;

  select to_jsonb(c) into v_summary from bi.loyalty_calc(v_key) c;

  select coalesce(jsonb_agg(x order by x.doc_date desc, x.doc_no desc), '[]'::jsonb) into v_docs
    from (
      select ld.company, ld.doc_type, ld.doc_no, ld.doc_date, ld.debtor_code, ld.debtor_name,
             ld.sales_agent, round(ld.amount, 2) as amount,
             trunc(ld.amount * st.earn_points_per_rm)::int as points,
             (select coalesce(jsonb_agg(jsonb_build_object(
                        'item_code', f.item_code, 'description', f.item_description,
                        'qty', f.qty, 'uom', f.uom, 'sub_total', f.sub_total)
                      order by f.dtl_key), '[]'::jsonb)
                from bi.fact_sales f
               where f.company = ld.company and f.doc_type = ld.doc_type and f.doc_key = ld.doc_key) as items
        from bi.loyalty_doc ld
       where ld.member_id = v_key
    ) x;

  select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at desc), '[]'::jsonb) into v_txns
    from bi.loyalty_txn t
   where t.member_id = v_key;

  return jsonb_build_object(
    'member_id', v_key,
    'summary', v_summary,
    'docs', v_docs,
    'txns', v_txns,
    'settings', to_jsonb(st)
  );
end;
$$;

-- ── 兑换（柜台用）：检查余额，扣分 ──
create or replace function public.bi_loyalty_redeem(
  p_member text, p_points int, p_company text default null, p_doc_no text default null, p_note text default null)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_key text := bi.loyalty_member_key(p_member);
  v_company text := coalesce((select public.bi_company()), p_company);
  st bi.loyalty_settings;
  v_bal int;
  v_id bigint;
  v_rm numeric(12,2);
begin
  perform bi.loyalty_require(array['owner', 'manager', 'sales']);
  if v_key is null then
    raise exception '看不出电话号码：请输入完整手机号';
  end if;
  if v_company is null or v_company not in ('HOMEWORKSSB', 'HOMEWORKSSOUTHERN') then
    raise exception '请选择在哪一间门市兑换（HQ 或 JB）';
  end if;
  select * into st from bi.loyalty_settings s where s.id = 1;
  if p_points is null or p_points < st.min_redeem_points then
    raise exception '一次最少兑换 % 分', st.min_redeem_points;
  end if;

  perform pg_advisory_xact_lock(hashtext('loyalty:' || v_key));
  select c.balance into v_bal from bi.loyalty_calc(v_key) c;
  if coalesce(v_bal, 0) < p_points then
    raise exception '积分不足：目前只有 % 分', coalesce(v_bal, 0);
  end if;

  v_rm := round(p_points / st.redeem_points_per_rm, 2);
  insert into bi.loyalty_txn (member_id, kind, points, rm_value, company, doc_no, note, created_by)
  values (v_key, 'redeem', -p_points, v_rm, v_company, nullif(trim(p_doc_no), ''), nullif(trim(p_note), ''),
          coalesce(auth.jwt() ->> 'email', 'unknown'))
  returning id into v_id;

  return jsonb_build_object('id', v_id, 'member_id', v_key, 'points', p_points, 'rm_value', v_rm,
                            'balance_after', v_bal - p_points);
end;
$$;

-- ── 手动调整（只有 owner；例如补登漏掉的单、送生日分） ──
create or replace function public.bi_loyalty_adjust(p_member text, p_points int, p_note text)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_key text := bi.loyalty_member_key(p_member);
  v_id bigint;
begin
  perform bi.loyalty_require(array['owner']);
  if v_key is null then
    raise exception '看不出电话号码：请输入完整手机号';
  end if;
  if p_points is null or p_points = 0 then
    raise exception '调整分数不能是 0';
  end if;
  if nullif(trim(p_note), '') is null then
    raise exception '手动调整一定要写原因';
  end if;
  insert into bi.loyalty_txn (member_id, kind, points, note, created_by)
  values (v_key, 'adjust', p_points, trim(p_note), coalesce(auth.jwt() ->> 'email', 'unknown'))
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'member_id', v_key, 'points', p_points);
end;
$$;

-- ── 作废一笔兑换 / 调整（owner 全部；manager 只能作废自己门市的兑换） ──
create or replace function public.bi_loyalty_void(p_id bigint, p_reason text)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_role text := bi.loyalty_require(array['owner', 'manager']);
  v_company text := (select public.bi_company());
  t bi.loyalty_txn;
begin
  if nullif(trim(p_reason), '') is null then
    raise exception '作废一定要写原因';
  end if;
  select * into t from bi.loyalty_txn x where x.id = p_id for update;
  if not found then
    raise exception '找不到这笔纪录 #%', p_id;
  end if;
  if t.voided_at is not null then
    raise exception '这笔纪录已经作废过了';
  end if;
  if v_role <> 'owner' and (t.kind <> 'redeem' or v_company is null or t.company is distinct from v_company) then
    raise exception '店长只能作废自己门市的兑换';
  end if;
  update bi.loyalty_txn
     set voided_at = now(), voided_by = coalesce(auth.jwt() ->> 'email', 'unknown'), void_reason = trim(p_reason)
   where id = p_id;
  return jsonb_build_object('id', p_id, 'voided', true);
end;
$$;

-- ── 没抽到电话的门市单据（给员工回 AutoCount 补电话） ──
create or replace function public.bi_loyalty_missing_phone(p_days int default 60)
returns table (company text, doc_type text, doc_no text, doc_date date, debtor_code text,
               debtor_name text, sales_agent text, amount numeric)
language plpgsql stable security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_company text := (select public.bi_company());
begin
  perform bi.loyalty_require(array['owner', 'manager', 'sales']);
  return query
  select ld.company, ld.doc_type, ld.doc_no, ld.doc_date, ld.debtor_code, ld.debtor_name, ld.sales_agent,
         round(ld.amount, 2)
    from bi.loyalty_doc ld
   where ld.member_id is null
     and ld.amount > 0
     and ld.doc_date >= (now() at time zone 'Asia/Kuala_Lumpur')::date - greatest(1, least(coalesce(p_days, 60), 400))
     and (v_company is null or ld.company = v_company)
   order by ld.doc_date desc, ld.doc_no desc;
end;
$$;

-- ── 设定：读（有权限的都可）/ 改（只有 owner） ──
create or replace function public.bi_loyalty_settings()
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
begin
  perform bi.loyalty_require(array['owner', 'manager', 'sales']);
  return (select to_jsonb(s) from bi.loyalty_settings s where s.id = 1);
end;
$$;

create or replace function public.bi_loyalty_set_settings(
  p_earn_points_per_rm numeric, p_redeem_points_per_rm numeric, p_expiry_months int,
  p_min_redeem_points int, p_start_date date)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
begin
  perform bi.loyalty_require(array['owner']);
  update bi.loyalty_settings
     set earn_points_per_rm = p_earn_points_per_rm,
         redeem_points_per_rm = p_redeem_points_per_rm,
         expiry_months = p_expiry_months,
         min_redeem_points = p_min_redeem_points,
         start_date = p_start_date,
         updated_at = now(),
         updated_by = coalesce(auth.jwt() ->> 'email', 'unknown')
   where id = 1;
  return (select to_jsonb(s) from bi.loyalty_settings s where s.id = 1);
end;
$$;

-- RPC 只给登入的人（函数内再看角色）；内部函数不开放
revoke all on function public.bi_loyalty_members(text, int) from public, anon;
revoke all on function public.bi_loyalty_member(text) from public, anon;
revoke all on function public.bi_loyalty_redeem(text, int, text, text, text) from public, anon;
revoke all on function public.bi_loyalty_adjust(text, int, text) from public, anon;
revoke all on function public.bi_loyalty_void(bigint, text) from public, anon;
revoke all on function public.bi_loyalty_missing_phone(int) from public, anon;
revoke all on function public.bi_loyalty_settings() from public, anon;
revoke all on function public.bi_loyalty_set_settings(numeric, numeric, int, int, date) from public, anon;
grant execute on function public.bi_loyalty_members(text, int) to authenticated;
grant execute on function public.bi_loyalty_member(text) to authenticated;
grant execute on function public.bi_loyalty_redeem(text, int, text, text, text) to authenticated;
grant execute on function public.bi_loyalty_adjust(text, int, text) to authenticated;
grant execute on function public.bi_loyalty_void(bigint, text) to authenticated;
grant execute on function public.bi_loyalty_missing_phone(int) to authenticated;
grant execute on function public.bi_loyalty_settings() to authenticated;
grant execute on function public.bi_loyalty_set_settings(numeric, numeric, int, int, date) to authenticated;
revoke all on function bi.loyalty_require(text[]) from public, anon, authenticated;
revoke all on function bi.loyalty_member_key(text) from public, anon, authenticated;
revoke all on function bi.loyalty_phone(text) from public, anon, authenticated;
