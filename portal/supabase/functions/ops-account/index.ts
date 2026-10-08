// 营运系统：管理员帮员工建立登入账号 / 重设密码。
// 已部署为 Supabase Edge Function `ops-account`（verify_jwt = false：新式 JWT 签章金钥与闸道的 verify_jwt
// 不一定相容，所以身分在函数里验：用呼叫者的 token 问 ops_me，PostgREST 会验 token，不是 admin 一律 403）。
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

// PostgREST 偶尔把刚签发的 token 判成「JWT issued at future」（401 / PGRST303；2026-10-08 记录到一次就是这里的
// ops_join_check，同一把金钥几毫秒前才通过 → 伺服器闲置后取时间的问题）。这个 401 在执行 SQL 之前就挡下，
// 等一下再送一次是安全的（送出申请、批准都不会做两次）。只重送一次，只限 /rest/v1/ 的文字 body。
async function fetchRetry(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const res = await fetch(input, init);
  if (res.status !== 401) return res;
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : "";
  const body = init?.body;
  if (!url.includes("/rest/v1/") || (body != null && typeof body !== "string")) return res;
  const text = await res.clone().text().catch(() => "");
  if (!text.includes("PGRST303") || !text.includes("issued at future")) return res;
  await new Promise((r) => setTimeout(r, 1500));
  return fetch(input, init);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return reply(405, { error: "只接受 POST" });

  const url = Deno.env.get("SUPABASE_URL")!;
  const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return reply(401, { error: "请先登入" });

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
  const asCaller = createClient(url, anon, { global: { headers: { Authorization: authHeader }, fetch: fetchRetry } });
  const { data: me, error: meErr } = await asCaller.rpc("ops_me");
  // 查身分本身失败（登入过期、连线问题）不要说成「不是管理员」，免得管理员以为权限被拿掉
  if (meErr) return reply(401, { error: `确认身分失败，请重新整理后再试一次（${meErr.message}）` });
  if (!me || me.staff?.role !== "admin") return reply(403, { error: "只有管理员可以设定员工密码" });
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
