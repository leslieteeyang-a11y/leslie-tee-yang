// 营运系统：员工自己申请加入（不用登入）。部署为 Supabase Edge Function `ops-join`（verify_jwt = false）。
//
// POST { code, email, password, name, phone, gender, join_date, branch, note }
// 1. 用 service role 呼叫 ops_join_submit：检查邀请码、email、是否已是员工，存申请（不存密码）。
// 2. 用 Auth admin 建登入账号（email 直接视为已验证，不寄验证信）。
//    email 已经有登入账号（例：BI 用户）就**不改密码**，避免有人拿邀请链接改别人的密码；回传 existing = true。
// 批准前这个账号进不了任何模块（不在 ops.staff，也不在 bi.allowed_users）。
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

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return reply(400, { error: "资料格式不对" });
  }
  const email = String(body.email ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");
  if (password.length < 8) return reply(400, { error: "密码至少 8 个字元" });
  if (password.length > 72) return reply(400, { error: "密码太长了（最多 72 个字元）" });

  const url = Deno.env.get("SUPABASE_URL")!;
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(url, service, { auth: { persistSession: false } });

  // 1. 检查邀请码与资料、存申请（密码不进资料库）
  const p = { ...body, email };
  delete (p as Record<string, unknown>).password;
  const { error: subErr } = await admin.rpc("ops_join_submit", { p });
  if (subErr) return reply(400, { error: subErr.message });

  // 2. 建登入账号；已经有账号就不动
  let existing = false;
  for (let page = 1; page <= 20 && !existing; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) return reply(500, { error: `读取账号失败：${error.message}` });
    existing = data.users.some((u) => (u.email ?? "").toLowerCase() === email);
    if (data.users.length < 1000) break;
  }
  if (!existing) {
    const { error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (error) return reply(500, { error: `建立账号失败：${error.message}` });
  }
  return reply(200, { ok: true, existing });
});
