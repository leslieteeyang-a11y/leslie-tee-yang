// 营运系统：员工自己申请加入。部署为 Supabase Edge Function `ops-join`（verify_jwt = false）。
//
// 不用登入：
//   POST { action: "check", code } → { ok }：打开链接时先确认邀请码还有效。
//   POST { action: "submit", code, email, password, name, phone, gender, join_date, branch, note }
//     * email 还没有登入账号 → 密码做成 bcrypt 杂凑存进申请（原密码不进资料库），这时**不建账号**。
//     * email 已经有登入账号（例：BI 用户）→ 先用他输入的密码登入一次，确认是本人才收；不存杂凑、不改密码。
// 要管理员登入（Authorization 带他的 token；身分由资料库函数检查）：
//   POST { action: "decide", id, approve, department, branch, role, title, note }
//     批准且申请里有杂凑 → 用 service role 以那个杂凑建账号（email 视为已验证），申请人用自己设的密码登入。
//     拒绝 → 资料库清掉杂凑，什么账号都没建过。
//   POST { action: "account", id }：批准时建账号失败的，重试。
// 第一版在送出时就建「已验证」账号，拿到链接的人可以用别人的 email 先占账号（2026-10-08 程式审查），所以改成批准才建。
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";
import bcrypt from "npm:bcryptjs@2.4.3";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function reply(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

async function findUser(admin: SupabaseClient, email: string): Promise<{ id: string } | null> {
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(`读取账号失败：${error.message}`);
    const u = data.users.find((x) => (x.email ?? "").toLowerCase() === email);
    if (u) return { id: u.id };
    if (data.users.length < 1000) break;
  }
  return null;
}

// 批准后：用申请里的杂凑建账号，成功（或账号已经有了）就清掉杂凑。
async function createAccount(admin: SupabaseClient, id: number): Promise<{ account: string; account_error?: string }> {
  const { data: pw, error } = await admin.rpc("ops_join_pw", { p_id: id, p_clear: false });
  if (error) return { account: "error", account_error: error.message };
  if (!pw?.pw_hash) return { account: "existing" };
  const user = await findUser(admin, pw.email);
  if (!user) {
    const { error: cErr } = await admin.auth.admin.createUser({ email: pw.email, password_hash: pw.pw_hash, email_confirm: true });
    if (cErr) return { account: "error", account_error: cErr.message };
  }
  await admin.rpc("ops_join_pw", { p_id: id, p_clear: true });
  return { account: user ? "existing" : "created" };
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
  const url = Deno.env.get("SUPABASE_URL")!;
  const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });
  const action = String(body.action ?? "submit");

  try {
    if (action === "check") {
      const { data, error } = await admin.rpc("ops_join_check", { p_code: String(body.code ?? "") });
      if (error) return reply(500, { error: error.message });
      return reply(200, { ok: data === true });
    }

    if (action === "decide" || action === "account") {
      const authHeader = req.headers.get("Authorization") ?? "";
      if (!authHeader.startsWith("Bearer ")) return reply(401, { error: "请先登入" });
      const asCaller = createClient(url, anon, {
        global: { headers: { Authorization: authHeader } },
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const id = Number(body.id);
      if (!id) return reply(400, { error: "缺少申请编号" });
      if (action === "account") {
        // 只有管理员叫得动 ops_join_list，用它确认身分
        const { error } = await asCaller.rpc("ops_join_list");
        if (error) return reply(403, { error: error.message });
        return reply(200, { ok: true, ...(await createAccount(admin, id)) });
      }
      const p = {
        id, approve: body.approve === true, department: body.department ?? "", branch: body.branch ?? "",
        role: body.role ?? "", title: body.title ?? "", note: body.note ?? "",
      };
      const { data: res, error } = await asCaller.rpc("ops_join_decide", { p });
      if (error) return reply(400, { error: error.message });
      if (res.status !== "approved") return reply(200, { ok: true, ...res, account: "none" });
      return reply(200, { ok: true, ...res, ...(await createAccount(admin, id)) });
    }

    if (action !== "submit") return reply(400, { error: "不认识的动作" });
    const email = String(body.email ?? "").trim().toLowerCase();
    const password = String(body.password ?? "");
    if (password.length < 8) return reply(400, { error: "密码至少 8 个字元" });
    if (new TextEncoder().encode(password).length > 72) return reply(400, { error: "密码太长了（最多 72 个英文字元）" });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return reply(400, { error: "email 格式不对。" });

    // 先确认邀请码，免得白白算杂凑 / 试登入
    const { data: ok, error: cErr } = await admin.rpc("ops_join_check", { p_code: String(body.code ?? "") });
    if (cErr) return reply(500, { error: cErr.message });
    if (ok !== true) return reply(400, { error: "加入链接已失效，请向管理员要新的链接。" });

    let hasAccount = false;
    let pwHash: string | null = null;
    if (await findUser(admin, email)) {
      const tryLogin = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } });
      const { error } = await tryLogin.auth.signInWithPassword({ email, password });
      if (error) {
        return reply(400, { error: "这个 email 已经有 HomeWorks 登入账号（例如 BI）。请输入那个账号的密码；忘了密码请找管理员。" });
      }
      hasAccount = true;
    } else {
      pwHash = await bcrypt.hash(password, 10);
    }
    const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim();
    const p = {
      code: body.code, email, name: body.name, phone: body.phone, gender: body.gender, join_date: body.join_date,
      branch: body.branch, note: body.note, pw_hash: pwHash, has_account: hasAccount, client_ip: ip,
    };
    const { error: subErr } = await admin.rpc("ops_join_submit", { p });
    if (subErr) return reply(400, { error: subErr.message });
    return reply(200, { ok: true, existing: hasAccount });
  } catch (e) {
    return reply(500, { error: (e as Error).message });
  }
});
