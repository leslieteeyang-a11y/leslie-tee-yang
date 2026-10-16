-- KL Puchong 分店（2026-10-16，migration 20261019_ops_branch_puchong）。接在其他测试之后跑。
\set ON_ERROR_STOP 1
create or replace function pg_temp.as_user(p_email text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('email', p_email)::text, false);
end $$;
create or replace function pg_temp.expect_error(p_sql text, p_msg text) returns void language plpgsql as $$
begin
  execute p_sql;
  raise exception 'expected error containing %', p_msg;
exception when others then
  if position(p_msg in sqlerrm) = 0 then raise; end if;
end $$;
grant execute on all functions in schema pg_temp to authenticated;

-- 分店代号都认得
do $$ begin
  assert ops.dlv_store('HOMEWORKSPUCHONG') = 'PUCHONG' and ops.dlv_company('PUCHONG') = 'HOMEWORKSPUCHONG', 'store mapping';
  assert (select company = 'HOMEWORKSPUCHONG' and staff_branch = 'HOMEWORKSPUCHONG' from ops.outlet where code = 'PUCHONG'), 'outlet';
  -- 总部账套的 PRE (PUCHONG) 仓位照旧算 Puchong（寄存在总部，跟 JB 一样）
  assert ops.outlet_of('HOMEWORKSSB', 'PRE (PUCHONG)') = 'PUCHONG' and ops.outlet_of('HOMEWORKSPUCHONG', null) = 'PUCHONG', 'outlet_of';
  assert ops.podo_outlet_ok('HOMEWORKSSB', 'PUCHONG') and not ops.podo_outlet_ok('HOMEWORKSPUCHONG', 'JB')
     and ops.podo_outlet_ok('HOMEWORKSPUCHONG', 'PUCHONG'), 'outlet ok';
  assert ops.podo_recv_loc('HOMEWORKSSB', 'PUCHONG', 'PUCHONG', 'PUCHONG') = 'PRE (PUCHONG)', 'recv loc';
end $$;

set role authenticated;
select pg_temp.as_user('boss@example.com');
select public.ops_staff_save('{"email":"pcmgr@example.com","name":"Puchong 店长","department":"sales","branch":"HOMEWORKSPUCHONG","role":"manager"}');
select public.ops_staff_save('{"email":"pcsales@example.com","name":"Puchong 店员","department":"sales","branch":"HOMEWORKSPUCHONG"}');
do $$ begin
  assert (select jsonb_agg(c) from jsonb_array_elements_text(public.ops_wh_meta()->'companies') c) ? 'HOMEWORKSPUCHONG', 'ALL sees Puchong in warehouse';
  assert public.ops_dlv_meta() -> 'companies' ? 'HOMEWORKSPUCHONG', 'ALL sees Puchong in delivery';
  assert public.ops_hr_gaps() -> 'no_fence' ? 'HOMEWORKSPUCHONG', 'Puchong has no geofence yet';
end $$;
reset role;
insert into ops.geofence (branch, name, lat, lng, radius) values ('HOMEWORKSPUCHONG', 'KL Puchong', 3.0, 101.6, 100);
insert into ops.holiday (date, name, branch) values ('2027-12-31', 'Puchong test', 'HOMEWORKSPUCHONG');

select pg_temp.as_user('pcmgr@example.com');
do $$ declare me ops.staff := ops.current_staff(); begin
  assert me.branch = 'HOMEWORKSPUCHONG', 'branch saved';
  assert ops.wh_company(me, '') = 'HOMEWORKSPUCHONG' and ops.dlv_check_company(me, '') = 'HOMEWORKSPUCHONG'
     and ops.rpl_company(me, '') = 'HOMEWORKSPUCHONG', 'own company default';
  assert ops.outlet_visible(me, 'PUCHONG') and not ops.outlet_visible(me, 'JB') and not ops.outlet_visible(me, 'HQ'), 'outlet visible';
  assert (select jsonb_agg(c) from jsonb_array_elements_text(public.ops_wh_meta()->'companies') c) = '["HOMEWORKSPUCHONG"]', 'only own company';
  assert ops.att_branch(me) = 'HOMEWORKSPUCHONG', 'attendance branch';
end $$;
select pg_temp.expect_error($q$select ops.wh_company(ops.current_staff(), 'HOMEWORKSSOUTHERN')$q$, '仓库权限');
select pg_temp.expect_error($q$select ops.dlv_check_company(ops.current_staff(), 'HOMEWORKSSB')$q$, '送货权限');
set role authenticated;
-- 任务落在 Puchong
select public.ops_task_save('{"title":"Puchong 开店检查"}');
reset role;
do $$ begin
  assert (select branch from ops.task where title = 'Puchong 开店检查') = 'HOMEWORKSPUCHONG', 'task branch';
end $$;
-- JB 的人看不到 Puchong
do $$ begin
  assert not ops.sees_company((select s from ops.staff s where s.email = 'pcmgr@example.com'), 'HOMEWORKSSOUTHERN'), 'pc not JB';
end $$;
-- 不认得的分店照样挡
do $$ begin
  begin
    insert into ops.geofence (branch, name, lat, lng, radius) values ('HOMEWORKSXX', 'x', 3, 101, 100);
    raise exception 'should fail';
  exception when check_violation then null;
  end;
end $$;
select 'puchong_test ok';
