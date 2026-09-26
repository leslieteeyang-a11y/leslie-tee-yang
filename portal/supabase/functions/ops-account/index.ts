// 营运系统：管理员帮员工建立登入账号 / 重设密码。
// 已部署为 Supabase Edge Function `ops-account`（verify_jwt = true）。
//
// POST { staff_id: number, password: string }，Authorization 带呼叫者（必须是 ops admin）的登入 token。
// 只对 ops.staff 名单里的 email 动作：没有账号就建（email 直接视为已验证），有账号就改密码。
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function reply(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return reply(405, { error: "只接受 POST" });

  const url = Deno.env.get("SUPABASE_URL")!;
  const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const authHeader = req.headers.get("Authorization") ?? "";

  let body: { staff_id?: number; password?: string };
  try {
    body = await req.json();
  } catch {
    return reply(400, { error: "资料格式不对" });
  }
  const password = String(body.password ?? "");
  if (!body.staff_id) return reply(400, { error: "缺少 staff_id" });
  if (password.length < 8) return reply(400, { error: "密码至少 8 个字元" });

  // 1. 用呼叫者自己的身分问：你是 admin 吗？顺便拿员工名单（ops_staff_admin_list 只有 admin 能叫）
  const asCaller = createClient(url, anon, { global: { headers: { Authorization: authHeader } } });
  const { data: me, error: meErr } = await asCaller.rpc("ops_me");
  if (meErr || !me || me.staff?.role !== "admin") return reply(403, { error: "只有管理员可以设定员工密码" });
  const { data: staffList, error: listErr } = await asCaller.rpc("ops_staff_admin_list");
  if (listErr) return reply(403, { error: listErr.message });
  const staff = (staffList as Array<{ id: number; email: string; active: boolean }>).find((s) => s.id === body.staff_id);
  if (!staff) return reply(404, { error: "找不到这位员工" });
  if (!staff.active) return reply(400, { error: "这位员工已停用，请先启用" });
  if (staff.email.toLowerCase() === String(me.staff.email).toLowerCase()) {
    return reply(400, { error: "自己的密码请用右上角「改密码」" });
  }

  // 2. 用 service role 建账号或改密码
  const admin = createClient(url, service, { auth: { persistSession: false } });
  let existing: { id: string } | undefined;
  for (let page = 1; page <= 20 && !existing; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) return reply(500, { error: `读取账号失败：${error.message}` });
    existing = data.users.find((u) => (u.email ?? "").toLowerCase() === staff.email.toLowerCase());
    if (data.users.length < 1000) break;
  }
  if (existing) {
    const { error } = await admin.auth.admin.updateUserById(existing.id, { password });
    if (error) return reply(500, { error: `改密码失败：${error.message}` });
    return reply(200, { ok: true, created: false });
  }
  const { error } = await admin.auth.admin.createUser({ email: staff.email, password, email_confirm: true });
  if (error) return reply(500, { error: `建立账号失败：${error.message}` });
  return reply(200, { ok: true, created: true });
});
