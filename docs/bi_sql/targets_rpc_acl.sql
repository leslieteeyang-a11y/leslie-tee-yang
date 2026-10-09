-- 2026-10-08：收紧「目标」写入 RPC 的执行权限。migration：targets_rpc_acl。
-- 为什么：targets_rpc 建出来的两个函数带了 PUBLIC 的 execute（=X），anon 也能呼叫。
--   虽然函数内会检查 bi_role() = 'owner'（anon 没有 email，一定被挡），但照 bi_report_set_ads 的做法，
--   只留 authenticated / service_role 能呼叫，少一层暴露面。
revoke execute on function public.bi_target_set(text, date, text, text, numeric) from public, anon;
revoke execute on function public.bi_target_copy_prev(text, date) from public, anon;
grant execute on function public.bi_target_set(text, date, text, text, numeric) to authenticated, service_role;
grant execute on function public.bi_target_copy_prev(text, date) to authenticated, service_role;
