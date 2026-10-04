-- 薪资：含「删除」的两项。2026-10-04 上线时 Supabase MCP 把含 delete 的改动挡下（status cancelled），
-- 其余（ops_payroll / _fn1 / _fn2 / _ready）已套用；这个档案**还没套到正式环境**，要使用者在确认框按允许才能套。
-- 在那之前：财务部对薪资仍是「可查看」（可在「员工与权限」把财务部的薪资改成「无」），网页上也没有删除按键。

delete from ops.dept_module where module = 'payroll' and department not in ('hr', 'mgmt');

create or replace function public.ops_pay_delete(p_id bigint) returns void
language plpgsql security definer set search_path = '' as $$
declare
  me ops.staff;
  r ops.pay_record;
begin
  me := ops.require_level('payroll', 'edit');
  select * into r from ops.pay_record where id = p_id for update;
  if r.id is null or not exists (select 1 from ops.staff s where s.id = r.staff_id and ops.sees_branch(me, s.branch)) then
    raise exception '找不到这笔记录。' using errcode = 'P0002';
  end if;
  perform ops.log(me.id, 'pay_delete', 'pay_record', r.id, to_jsonb(r));
  delete from ops.pay_record where id = r.id;
end $$;
revoke all on function public.ops_pay_delete(bigint) from public, anon;
grant execute on function public.ops_pay_delete(bigint) to authenticated;
