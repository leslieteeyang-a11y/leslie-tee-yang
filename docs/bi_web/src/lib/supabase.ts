import { createClient } from '@supabase/supabase-js';

// anon key 是设计上可公开的客户端密钥;数据安全由服务端门禁保证:
// bi schema 不暴露 API,public 视图只授 authenticated,且视图内按邮箱白名单过滤。
const url =
  (import.meta.env.VITE_SUPABASE_URL as string | undefined) ??
  'https://vwljnypzgfqhatkgulqs.supabase.co';
const anonKey =
  (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ3bGpueXB6Z2ZxaGF0a2d1bHFzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ3MzE5NzgsImV4cCI6MjEwMDMwNzk3OH0.SrdYqJ5bxuFZf2TJz2-FmQFIIBDaQPxavJYA0NFAAJ8';

export const supabase = createClient(url, anonKey);

// 当前查看的公司:老板可在顶栏切换(存 localStorage,切换时整页刷新);其他角色固定自己的公司
// 键 = BI 的 company 代码(与 SERVER / 分行电脑脚本推上来的一致),值 = 显示名(中文原文,显示时经 t() 翻译)
// 新开分行:这里加一行 + scripts/supabase_push.py 的 BRANCHES 加同一个代码
export const COMPANIES: Record<string, string> = {
  HOMEWORKSSB: '总部',
  HOMEWORKSSOUTHERN: 'JB Southern',
  HOMEWORKSKL: 'KL',
};
export const HQ = 'HOMEWORKSSB';
const saved = typeof localStorage !== 'undefined' ? localStorage.getItem('bi_company') : null;
export const COMPANY = saved && COMPANIES[saved] ? saved : HQ;

export function switchCompany(c: string) {
  if (!COMPANIES[c]) return;
  localStorage.setItem('bi_company', c);
  window.location.reload();
}
// 写入并回读确认后才 reload:localStorage 不可用(隐私模式等)时避免无限刷新循环
function setCompanyAndReload(c: string) {
  try {
    localStorage.setItem('bi_company', c);
    if (localStorage.getItem('bi_company') === c) window.location.reload();
  } catch {
    /* localStorage 不可用:维持目前公司,不刷新 */
  }
}
// 非老板角色只能看 allowed_users.company 那家(没填 = 总部);登入后若 localStorage 里是别家就改回来
export function resetCompanyIfNotAllowed(isOwner: boolean, company: string | null) {
  if (isOwner) return;
  const want = company && COMPANIES[company] ? company : HQ;
  if (want !== COMPANY) setCompanyAndReload(want);
}
