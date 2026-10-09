-- 员工档案测试（接在 dlv_test.sql 之后跑，2026-10-09）：权限矩阵（本人 / HR 只看 / HR 可编辑 / 管薪资的人 / 其他员工 / anon）、
-- 银行资料只给本人与管薪资的人、MyKad 整理与生日带入、各种格式错误、人事资料缺漏的新代号。
-- 第 10 段：最后上班日的审查修正（管理员保护、BI 名单提醒、提早停用 / 同日复职、HR 替离职的人补卡请假）。
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
create or replace function pg_temp.sid(p_email text) returns bigint language sql security definer as $$
  select id from ops.staff where email = p_email
$$;
-- 补卡证明（第 10 段）：假装已经上传到 ops-hr
create or replace function pg_temp.photo(p_email text, p_name text) returns text language plpgsql security definer as $$
declare
  path text := pg_temp.sid(p_email) || '/' || p_name;
begin
  insert into storage.objects (bucket_id, name) values ('ops-hr', path);
  return path;
end $$;
grant execute on all functions in schema pg_temp to authenticated, anon;

select pg_temp.at('2026-10-21 10:00:00+08');
set role authenticated;

-- 人事的几种人：人事小陈（人事可编辑、没有薪资权限）、门市看档案（销售部，人事只看）、JB 人事（别分店）
-- 另外沿用：hr@（人事 + 薪资可编辑）、mgr@（人事只看、薪资可审批）、buyer@（一般员工）
select pg_temp.as_user('boss@example.com');
select public.ops_staff_save('{"email":"hrclerk@example.com","name":"人事小陈","department":"hr","branch":"HOMEWORKSSB","overrides":{"payroll":"none"}}');
select public.ops_staff_save('{"email":"hrview@example.com","name":"门市看档案","department":"sales","branch":"HOMEWORKSSB","overrides":{"hr":"view"}}');
select public.ops_staff_save('{"email":"jbhr@example.com","name":"JB 人事","department":"hr","branch":"HOMEWORKSSOUTHERN"}');

-- 1. 本人：看得到、改得到自己的全部（含银行）
select pg_temp.as_user('hqsales@example.com');
do $$ declare g jsonb := public.ops_profile_get(); begin
  assert (g->>'self')::boolean and (g->>'can_edit')::boolean and (g->>'can_bank')::boolean, 'self rights: ' || g::text;
  assert g ? 'bank_name' and g ? 'bank_account' and g->>'id_type' = 'mykad' and g->>'name' = '门市小美', 'self keys: ' || g::text;
  assert g->'missing' = '["id_no", "emergency", "bank"]'::jsonb, 'missing: ' || g::text;
end $$;

-- 2. 格式检查
select pg_temp.expect_error($q$select public.ops_profile_save(null, '{"id_no":"90010101123"}')$q$, '12 位数字');
select pg_temp.expect_error($q$select public.ops_profile_save(null, '{"id_no":"9001010112AB"}')$q$, '12 位数字');
select pg_temp.expect_error($q$select public.ops_profile_save(null, '{"id_no":"901301-01-1234"}')$q$, '有效的出生日期');
select pg_temp.expect_error($q$select public.ops_profile_save(null, '{"id_no":"900230-01-1234"}')$q$, '有效的出生日期');
select pg_temp.expect_error($q$select public.ops_profile_save(null, '{"id_no":"200101-01-1234"}')$q$, '14 – 80');   -- 2020 年生
select pg_temp.expect_error($q$select public.ops_profile_save(null, '{"id_no":"400101-01-1234"}')$q$, '14 – 80');   -- 1940 年生
select pg_temp.expect_error($q$select public.ops_profile_save(null, '{"id_type":"ic"}')$q$, 'MyKad 或护照');
select pg_temp.expect_error($q$select public.ops_profile_save(null, '{"dob":"1990-13-01"}')$q$, '生日格式');
select pg_temp.expect_error($q$select public.ops_profile_save(null, '{"dob":"2030-01-01"}')$q$, '14 – 80');
select pg_temp.expect_error($q$select public.ops_profile_save(null, '{"emergency_phone":"12345"}')$q$, '8 – 15 位数字');
select pg_temp.expect_error($q$select public.ops_profile_save(null, '{"emergency_phone":"012-abc 4567"}')$q$, '8 – 15 位数字');
select pg_temp.expect_error($q$select public.ops_profile_save(null, '{"emergency_phone":"+60 12 3456 7890 1234 5"}')$q$, '8 – 15 位数字');
select pg_temp.expect_error($q$select public.ops_profile_save(null, '{"bank_account":"12AB"}')$q$, '6 – 20 位数字');
select pg_temp.expect_error($q$select public.ops_profile_save(null, jsonb_build_object('address', repeat('长', 301)))$q$, '太长了');
select pg_temp.expect_error($q$select public.ops_profile_save(null, '"x"')$q$, '格式不对');

-- 3. MyKad：去空白 / 横线后存成 YYMMDD-PB-####，生日空白就从前 6 位带入；其他栏位去头尾空白
do $$ declare g jsonb; begin
  g := public.ops_profile_save(null, jsonb_build_object('id_no', ' 9001 0101 1234 ', 'address', '  12 Jalan Mawar, Johor Bahru  ',
         'emergency_name', '陈太太', 'emergency_relation', '母亲', 'emergency_phone', ' +60 12-345 6789 ',
         'bank_name', 'Maybank', 'bank_account', '1122-3344 5566'));
  assert g->>'id_no' = '900101-01-1234' and g->>'dob' = '1990-01-01', 'mykad formatted + dob: ' || g::text;
  assert g->>'address' = '12 Jalan Mawar, Johor Bahru' and g->>'emergency_phone' = '+60 12-345 6789'
     and g->>'bank_account' = '112233445566', 'trimmed: ' || g::text;
  assert g->'missing' = '[]'::jsonb and g->>'updated_by_name' = '门市小美', 'complete: ' || g::text;
  -- 生日可以改（身份证不变）；空字串 = 清空
  g := public.ops_profile_save(null, '{"dob":"1990-01-02","address":"   "}');
  assert g->>'dob' = '1990-01-02' and g->'address' = 'null'::jsonb and g->>'id_no' = '900101-01-1234', 'dob editable: ' || g::text;
  -- 生日清空 → 再从身份证带入
  g := public.ops_profile_save(null, '{"dob":""}');
  assert g->>'dob' = '1990-01-01', 'dob re-derived: ' || g::text;
  -- 两位年份：05 ≤ 今年的 26 → 2005 年
  g := public.ops_profile_save(null, '{"id_no":"050101101234","dob":""}');
  assert g->>'id_no' = '050101-10-1234' and g->>'dob' = '2005-01-01', 'century 20xx: ' || g::text;
  -- 护照：大写、去空白；生日不会自己带入
  g := public.ops_profile_save(null, '{"id_type":"passport","id_no":" a1234 567 ","dob":""}');
  assert g->>'id_type' = 'passport' and g->>'id_no' = 'A1234567' and g->'dob' = 'null'::jsonb, 'passport: ' || g::text;
end $$;
select pg_temp.expect_error($q$select public.ops_profile_save(null, '{"id_type":"passport","id_no":"AB1"}')$q$, '5 – 20');
select pg_temp.expect_error($q$select public.ops_profile_save(null, '{"id_type":"passport","id_no":"A1234-567"}')$q$, '5 – 20');
-- 改回 MyKad 却没给新号码：护照号码不是 12 位数字 → 挡
select pg_temp.expect_error($q$select public.ops_profile_save(null, '{"id_type":"mykad"}')$q$, '12 位数字');
do $$ declare g jsonb; begin
  g := public.ops_profile_save(null, '{"id_type":"mykad","id_no":"900101-01-1234","dob":"","address":"12 Jalan Mawar"}');
  assert g->>'id_type' = 'mykad' and g->>'dob' = '1990-01-01', 'back to mykad: ' || g::text;
end $$;

-- 4. 人事可编辑、没有薪资权限：看 / 改个人资料，银行两栏连 key 都没有，也不能改
select pg_temp.as_user('hrclerk@example.com');
do $$ declare g jsonb; l jsonb; r jsonb; begin
  g := public.ops_profile_get(pg_temp.sid('hqsales@example.com'));
  assert not (g->>'self')::boolean and (g->>'can_edit')::boolean and not (g->>'can_bank')::boolean, 'clerk rights: ' || g::text;
  assert not (g ? 'bank_name') and not (g ? 'bank_account'), 'no bank keys for non-payroll HR: ' || g::text;
  assert g->>'id_no' = '900101-01-1234' and g->>'emergency_name' = '陈太太' and g->>'address' = '12 Jalan Mawar', 'clerk sees personal';
  assert g->'missing' = '[]'::jsonb, 'bank not counted for clerk';
  g := public.ops_profile_save(pg_temp.sid('hqsales@example.com'), '{"emergency_relation":"妈妈"}');
  assert g->>'emergency_relation' = '妈妈' and not (g ? 'bank_account') and g->>'updated_by_name' = '人事小陈', 'clerk edits: ' || g::text;
  l := public.ops_profile_list();
  assert (l->>'can_edit')::boolean and not (l->>'can_bank')::boolean, 'list flags: ' || (l - 'rows')::text;
  r := (select x from jsonb_array_elements(l->'rows') x where x->>'name' = '门市小美');
  assert r->>'id_no' = '900101-01-1234' and r->>'emergency_phone' = '+60 12-345 6789' and (r->>'has_address')::boolean
     and not (r ? 'bank_account') and not (r ? 'bank_name') and not (r ? 'address') and r->'missing' = '[]'::jsonb, 'list row: ' || r::text;
  assert not exists (select 1 from jsonb_array_elements(l->'rows') x where x->'missing' ? 'bank'), 'no bank gap for clerk';
  assert exists (select 1 from jsonb_array_elements(l->'rows') x where x->'missing' ? 'id_no'), 'others missing id';
  assert not exists (select 1 from jsonb_array_elements(l->'rows') x where x->>'branch' = 'HOMEWORKSSOUTHERN'), 'own branch only';
end $$;
select pg_temp.expect_error($q$select public.ops_profile_save(pg_temp.sid('hqsales@example.com'), '{"bank_account":"999999"}')$q$, '银行资料');
select pg_temp.expect_error($q$select public.ops_profile_save(pg_temp.sid('hqsales@example.com'), '{"bank_name":null}')$q$, '银行资料');

-- 5. 人事只看：看得到个人资料、改不了；自己的档案（含银行）照样可以改
select pg_temp.as_user('hrview@example.com');
do $$ declare g jsonb := public.ops_profile_get(pg_temp.sid('hqsales@example.com')); l jsonb := public.ops_profile_list(); begin
  assert not (g->>'can_edit')::boolean and not (g->>'can_bank')::boolean and not (g ? 'bank_name') and g->>'id_no' is not null,
    'view only: ' || g::text;
  assert jsonb_array_length(l->'rows') > 0 and not (l->>'can_edit')::boolean, 'view list';
end $$;
select pg_temp.expect_error($q$select public.ops_profile_save(pg_temp.sid('hqsales@example.com'), '{"address":"x"}')$q$, '没有权限改');
select pg_temp.expect_error($q$select public.ops_hr_gaps()$q$, '人事');
do $$ declare g jsonb := public.ops_profile_save(null, '{"bank_name":"CIMB","bank_account":"8000123456"}'); begin
  assert (g->>'self')::boolean and g->>'bank_account' = '8000123456', 'own bank: ' || g::text;
end $$;

-- 6. 人事 + 薪资可编辑（hr@）：看得到、改得到银行
select pg_temp.as_user('hr@example.com');
do $$ declare g jsonb; l jsonb; begin
  g := public.ops_profile_get(pg_temp.sid('hqsales@example.com'));
  assert (g->>'can_edit')::boolean and (g->>'can_bank')::boolean and g->>'bank_account' = '112233445566', 'payroll HR: ' || g::text;
  g := public.ops_profile_save(pg_temp.sid('hqsales@example.com'), '{"bank_name":"Public Bank","bank_account":"3123456789"}');
  assert g->>'bank_name' = 'Public Bank' and g->>'bank_account' = '3123456789', 'payroll HR edits bank';
  l := public.ops_profile_list();
  assert (l->>'can_bank')::boolean and exists (select 1 from jsonb_array_elements(l->'rows') x where x->'missing' ? 'bank'),
    'bank gap for payroll: ' || (l - 'rows')::text;
  assert not exists (select 1 from jsonb_array_elements(l->'rows') x where x ? 'bank_account' or x ? 'address'),
    'list never has bank numbers or address';
end $$;

-- 7. 人事只看 + 薪资可审批（店长）：看得到银行，但不能改
select pg_temp.as_user('mgr@example.com');
do $$ declare g jsonb := public.ops_profile_get(pg_temp.sid('hqsales@example.com')); begin
  assert (g->>'can_bank')::boolean and not (g->>'can_edit')::boolean and g->>'bank_name' = 'Public Bank', 'mgr: ' || g::text;
end $$;
select pg_temp.expect_error($q$select public.ops_profile_save(pg_temp.sid('hqsales@example.com'), '{"bank_name":"x"}')$q$, '没有权限改');

-- 8. 一般员工、别分店的 HR、不存在的员工、anon
select pg_temp.as_user('buyer@example.com');
select pg_temp.expect_error($q$select public.ops_profile_get(pg_temp.sid('hqsales@example.com'))$q$, '没有权限看');
select pg_temp.expect_error($q$select public.ops_profile_save(pg_temp.sid('hqsales@example.com'), '{"address":"x"}')$q$, '没有权限改');
select pg_temp.expect_error($q$select public.ops_profile_list()$q$, '人事');
select pg_temp.expect_error($q$select public.ops_profile_get(999999)$q$, '没有权限看');
do $$ declare g jsonb := public.ops_profile_get(); begin
  assert (g->>'self')::boolean and g->'id_no' = 'null'::jsonb and g ? 'bank_account', 'buyer own empty profile: ' || g::text;
  -- 通讯录不回传证件、地址、银行
  assert not exists (select 1 from jsonb_array_elements(public.ops_directory()) x
                     where x ? 'id_no' or x ? 'address' or x ? 'bank_account' or x ? 'dob'), 'directory clean';
end $$;
select pg_temp.as_user('jbhr@example.com');
select pg_temp.expect_error($q$select public.ops_profile_get(pg_temp.sid('hqsales@example.com'))$q$, '没有权限看');
do $$ begin
  assert not exists (select 1 from jsonb_array_elements(public.ops_profile_list()->'rows') x where x->>'branch' <> 'HOMEWORKSSOUTHERN'),
    'jb hr sees jb only';
end $$;
select pg_temp.expect_error('select * from ops.staff_profile', 'permission denied');
reset role;
set role anon;
select pg_temp.expect_error($q$select public.ops_profile_get(null)$q$, 'permission denied');
select pg_temp.expect_error($q$select public.ops_profile_save(null, '{}')$q$, 'permission denied');
select pg_temp.expect_error($q$select public.ops_profile_list()$q$, 'permission denied');
select pg_temp.expect_error('select * from ops.staff_profile', 'permission denied');
reset role;
-- 稽核只记改了哪些栏位，不记号码
do $$ begin
  assert not exists (select 1 from ops.audit_log a where a.action = 'profile'
                     and (a.data::text like '%900101%' or a.data::text like '%3123456789%')), 'audit has no numbers';
  assert exists (select 1 from ops.audit_log a where a.action = 'profile' and a.data->'fields' ? 'bank_account'), 'audit has field names';
end $$;
set role authenticated;

-- 9. 人事资料缺漏：多 id_no / emergency；bank 只给管薪资的人；首页数字与清单一致
select pg_temp.as_user('hr@example.com');
do $$ declare g jsonb := public.ops_hr_gaps(); h jsonb := public.ops_home(); begin
  assert (h->>'hr_gaps')::int = jsonb_array_length(g->'staff'), 'home = list: ' || g::text;
  assert exists (select 1 from jsonb_array_elements(g->'staff') x
                 where x->'missing' ? 'id_no' and x->'missing' ? 'emergency' and x->'missing' ? 'bank'), 'new codes: ' || g::text;
  -- 门市小美：到职日、性别、手机、薪资资料、证件、紧急联络人、银行都有了 → 不在清单
  assert not exists (select 1 from jsonb_array_elements(g->'staff') x where x->>'name' = '门市小美'), 'complete staff not listed';
  -- 离职阿伟（已停用）不在清单
  assert not exists (select 1 from jsonb_array_elements(g->'staff') x where x->>'name' = '离职阿伟'), 'leaver not listed';
end $$;
select pg_temp.as_user('hrclerk@example.com');
do $$ declare g jsonb := public.ops_hr_gaps(); h jsonb := public.ops_home(); begin
  assert (h->>'hr_gaps')::int = jsonb_array_length(g->'staff'), 'clerk home = list';
  assert not exists (select 1 from jsonb_array_elements(g->'staff') x where x->'missing' ? 'bank' or x->'missing' ? 'pay'),
    'clerk: no bank / pay codes: ' || g::text;
  assert exists (select 1 from jsonb_array_elements(g->'staff') x where x->'missing' ? 'id_no'), 'clerk sees id gaps';
  -- 门市看档案 自己填了银行，但没有证件 / 紧急联络人
  assert (select x->'missing' from jsonb_array_elements(g->'staff') x where x->>'name' = '门市看档案') ?& array['id_no', 'emergency'],
    'hrview gaps';
end $$;

-- 10. 最后上班日的审查修正（2026-10-10）
-- 10a. 管理员保护：不是管理员的人（管理层 gm@，分店 ALL、人事 / 薪资可审批）不能设管理员的最后上班日；
--      管理员不能设自己的；至少留一位没有最后上班日的管理员。原样送回同一个日期照常可以存。
select pg_temp.as_user('boss@example.com');
select public.ops_staff_save('{"email":"gm@example.com","name":"总经理","department":"mgmt","branch":"ALL"}');
select public.ops_staff_save('{"email":"admin2@example.com","name":"副管理员","department":"mgmt","branch":"ALL","role":"admin"}');
select pg_temp.as_user('gm@example.com');
select pg_temp.expect_error($q$select public.ops_att_staff_set(jsonb_build_object('id', pg_temp.sid('boss@example.com'),
  'last_day', '2026-10-20'))$q$, '只有管理员可以设定管理员');
select pg_temp.expect_error($q$select public.ops_att_staff_set(jsonb_build_object('id', pg_temp.sid('boss@example.com'),
  'last_day', '2026-12-31'))$q$, '只有管理员可以设定管理员');
select pg_temp.expect_error($q$select public.ops_pay_profile_save(jsonb_build_object('staff_id', pg_temp.sid('boss@example.com'),
  'leave_date', '2026-10-01'))$q$, '只有管理员可以设定管理员');
-- 没改最后上班日（打卡设定整笔送回、薪资资料空白）照常可以存
select public.ops_att_staff_set(jsonb_build_object('id', pg_temp.sid('boss@example.com'), 'last_day', '', 'geofence_exempt', true));
select public.ops_pay_profile_save(jsonb_build_object('staff_id', pg_temp.sid('boss@example.com'), 'base', 0, 'leave_date', ''));
select pg_temp.as_user('boss@example.com');
do $$ begin assert public.ops_me() is not null, 'boss still in'; end $$;
select pg_temp.expect_error($q$select public.ops_att_staff_set(jsonb_build_object('id', pg_temp.sid('boss@example.com'),
  'last_day', '2026-12-31'))$q$, '管理员不能设定自己');
select pg_temp.expect_error($q$select public.ops_pay_profile_save(jsonb_build_object('staff_id', pg_temp.sid('boss@example.com'),
  'leave_date', '2026-12-31'))$q$, '管理员不能设定自己');
select public.ops_att_staff_set(jsonb_build_object('id', pg_temp.sid('admin2@example.com'), 'last_day', '2026-12-31'));
select pg_temp.as_user('admin2@example.com');
select pg_temp.expect_error($q$select public.ops_att_staff_set(jsonb_build_object('id', pg_temp.sid('boss@example.com'),
  'last_day', '2026-12-31'))$q$, '至少要留一位');
select pg_temp.expect_error($q$select public.ops_pay_profile_save(jsonb_build_object('staff_id', pg_temp.sid('boss@example.com'),
  'leave_date', '2026-11-30'))$q$, '至少要留一位');
select pg_temp.as_user('gm@example.com');
-- 管理员已经有的日期原样送回可以；改日期不行；清掉（延长）可以
select public.ops_att_staff_set(jsonb_build_object('id', pg_temp.sid('admin2@example.com'), 'last_day', '2026-12-31',
                                                   'geofence_exempt', true));
select pg_temp.expect_error($q$select public.ops_att_staff_set(jsonb_build_object('id', pg_temp.sid('admin2@example.com'),
  'last_day', '2026-12-30'))$q$, '只有管理员可以设定管理员');
select public.ops_att_staff_set(jsonb_build_object('id', pg_temp.sid('admin2@example.com'), 'last_day', ''));
-- 一般员工照常可以设（管理层替门市小美设一个还没到的日期，再清掉）
select public.ops_att_staff_set(jsonb_build_object('id', pg_temp.sid('hqsales@example.com'), 'last_day', '2026-12-31'));
select public.ops_att_staff_set(jsonb_build_object('id', pg_temp.sid('hqsales@example.com'), 'last_day', ''));
select pg_temp.as_user('boss@example.com');
select public.ops_staff_save('{"email":"admin2@example.com","active":false}' ::jsonb
                             || jsonb_build_object('id', pg_temp.sid('admin2@example.com')));

-- 10b. 员工与权限：离职只挡营运系统，也在 BI 名单的人要提醒另外移除
do $$ declare l jsonb := public.ops_staff_admin_list(); begin
  assert (select (x->>'in_bi')::boolean from jsonb_array_elements(l) x where x->>'email' = 'boss@example.com'), 'boss in bi';
  assert (select (x->>'in_bi')::boolean from jsonb_array_elements(l) x where x->>'email' = 'buyer@example.com'), 'buyer in bi';
  assert not (select (x->>'in_bi')::boolean from jsonb_array_elements(l) x where x->>'email' = 'leaver@example.com'), 'leaver not in bi';
end $$;

-- 10c. 提早停用：还没到的最后上班日改成今天（10/21）；停用的人不能再设还没到的日期；
--      复职清掉已经到了 / 过了的（含今天，不然今晚又被停用）
select public.ops_staff_save('{"email":"quitter@example.com","name":"走人阿明","department":"sales","branch":"HOMEWORKSSB"}');
select pg_temp.as_user('hr@example.com');
select public.ops_att_staff_set(jsonb_build_object('id', pg_temp.sid('quitter@example.com'), 'last_day', '2026-10-31'));
select pg_temp.as_user('boss@example.com');
do $$ declare s jsonb; begin
  s := public.ops_staff_save(jsonb_build_object('id', pg_temp.sid('quitter@example.com'), 'email', 'quitter@example.com',
                                                'active', false));
  assert not (s->>'active')::boolean and s->>'last_day' = '2026-10-21', 'deactivated early → last_day today: ' || s::text;
end $$;
select pg_temp.as_user('hr@example.com');
do $$ begin
  assert exists (select 1 from jsonb_array_elements(public.ops_att_board('2026-10-21')->'rows') r where r->>'name' = '走人阿明'),
    'board today';
  assert not exists (select 1 from jsonb_array_elements(public.ops_att_board('2026-10-22')->'rows') r where r->>'name' = '走人阿明'),
    'not on board after deactivation';
end $$;
select pg_temp.expect_error($q$select public.ops_att_staff_set(jsonb_build_object('id', pg_temp.sid('quitter@example.com'),
  'last_day', '2026-10-31'))$q$, '已停用，最后上班日不能晚于今天');
select pg_temp.expect_error($q$select public.ops_pay_profile_save(jsonb_build_object('staff_id', pg_temp.sid('quitter@example.com'),
  'base', 1500, 'leave_date', '2026-10-30'))$q$, '已停用，最后上班日不能晚于今天');
select public.ops_att_staff_set(jsonb_build_object('id', pg_temp.sid('quitter@example.com'), 'last_day', '2026-10-20'));
select public.ops_att_staff_set(jsonb_build_object('id', pg_temp.sid('quitter@example.com'), 'last_day', '2026-10-21'));
select pg_temp.as_user('boss@example.com');
do $$ declare s jsonb; begin
  s := public.ops_staff_save(jsonb_build_object('id', pg_temp.sid('quitter@example.com'), 'email', 'quitter@example.com',
                                                'active', true));
  assert (s->>'active')::boolean and s->'last_day' = 'null'::jsonb, 'same-day rehire clears today: ' || s::text;
end $$;
reset role;
do $$ begin
  perform ops.staff_offboard();
  assert (select active from ops.staff where email = 'quitter@example.com'), 'rehired not offboarded tonight';
end $$;
set role authenticated;

-- 10d. HR 替已停用的离职员工（离职阿伟：10/14 最后上班日、已停用）补最后几天的卡、登记请假，最后一个月薪资带得到
select pg_temp.as_user('hr@example.com');
do $$ declare c jsonb; r jsonb; x jsonb; begin
  c := public.ops_att_correction_create(jsonb_build_object('staff_id', pg_temp.sid('leaver@example.com'), 'date', '2026-10-14',
         'punch', 'clock_out', 'time', '17:30', 'reason', '离职当天忘了打下班卡',
         'attachment', pg_temp.photo('hr@example.com', 'proof/leaver-1014.jpg')));
  assert c->>'status' = 'pending_hr' and (c->>'can_decide')::boolean, 'hr filed for leaver: ' || c::text;
  c := public.ops_att_correction_decide((c->>'id')::bigint, 'approve');
  assert c->>'status' = 'approved', 'approved for leaver';
  r := public.ops_leave_apply(jsonb_build_object('staff_id', pg_temp.sid('leaver@example.com'), 'type', 'unpaid',
                                                 'start_date', '2026-10-12', 'reason', '最后一个星期请事假'));
  assert r->>'status' = 'pending', 'hr leave for leaver: ' || r::text;
  perform public.ops_leave_decide((r->>'id')::bigint, 'approve');
  x := (select e from jsonb_array_elements(public.ops_pay_month(2026, 10)->'rows') e where e->>'name' = '离职阿伟');
  assert (x->'att'->>'unpaid_days')::numeric = 1, 'final month payroll sees unpaid leave: ' || coalesce(x::text, 'missing');
  -- 假期余额：那一年离职的人照列（带 last_day），隔年不列
  assert (select e->>'last_day' from jsonb_array_elements(public.ops_leave_balances(2026)->'rows') e
          where e->>'name' = '离职阿伟') = '2026-10-14', 'leaver in 2026 balances';
  assert not exists (select 1 from jsonb_array_elements(public.ops_leave_balances(2027)->'rows') e where e->>'name' = '离职阿伟'),
    'leaver not in 2027 balances';
end $$;
select pg_temp.expect_error($q$select public.ops_att_correction_create(jsonb_build_object('staff_id', pg_temp.sid('leaver@example.com'),
  'date', '2026-10-15', 'punch', 'clock_in', 'time', '08:30', 'reason', '离职后一天的卡',
  'attachment', pg_temp.photo('hr@example.com', 'proof/leaver-1015.jpg')))$q$, '不能晚于最后上班日');
select pg_temp.expect_error($q$select public.ops_leave_apply(jsonb_build_object('staff_id', pg_temp.sid('leaver@example.com'),
  'type', 'unpaid', 'start_date', '2026-10-15'))$q$, '不能晚于最后上班日');
-- 停用了又没有最后上班日的人（打错的账号之类）照旧不收
select pg_temp.as_user('boss@example.com');
select public.ops_staff_save('{"email":"oops@example.com","name":"打错的账号","department":"sales","branch":"HOMEWORKSSB","active":false}');
select pg_temp.as_user('hr@example.com');
select pg_temp.expect_error($q$select public.ops_att_correction_create(jsonb_build_object('staff_id', pg_temp.sid('oops@example.com'),
  'date', '2026-10-20', 'punch', 'clock_in', 'time', '08:30', 'reason', '测试已停用的人',
  'attachment', pg_temp.photo('hr@example.com', 'proof/oops.jpg')))$q$, '已停用');
select pg_temp.expect_error($q$select public.ops_leave_apply(jsonb_build_object('staff_id', pg_temp.sid('oops@example.com'),
  'type', 'unpaid', 'start_date', '2026-10-20'))$q$, '找不到这位员工');

reset role;
select 'profile_test ok';
