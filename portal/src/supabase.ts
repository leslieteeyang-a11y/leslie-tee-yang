// Supabase 连线：与 HomeWorks BI 同一个专案、同一套登入。publishable key 本来就是公开的（权限靠资料库函数检查）。
import { createClient } from "@supabase/supabase-js";

export const SUPABASE_URL = "https://vwljnypzgfqhatkgulqs.supabase.co";
const PUBLISHABLE_KEY = "sb_publishable__elDWkBfCa5ajEQLR0NmRQ_p5a3089Q";

// PostgREST 偶尔把刚签发的登入 token 判成「JWT issued at future」（401 / PGRST303）：2026-10-08 的 Supabase 记录有两次，
// 都是伺服器闲置几分钟后的第一批请求，同一个 token 几毫秒前才通过 → 是伺服器那边取时间的问题，不是员工手机的时钟。
// 这个 401 在执行任何 SQL 之前就挡下，所以同一个请求等一下再送一次是安全的（存排单、批准这类写入也不会做两次）。
// 只重送一次；只限资料库函数（/rest/v1/）、网址是字串、body 是文字；登入、照片上传、Edge Function 照旧不重送。
const REST_PREFIX = `${SUPABASE_URL}/rest/v1/`;

export async function fetchRetryIssuedAtFuture(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const res = await fetch(input, init);
  if (res.status !== 401) return res;
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : "";   // Request 物件的 body 只能读一次，不重送
  const body = init?.body;
  if (!url.startsWith(REST_PREFIX) || (body != null && typeof body !== "string")) return res;
  const text = await res.clone().text().catch(() => "");
  if (!text.includes("PGRST303") || !text.includes("issued at future")) return res;
  await new Promise((r) => setTimeout(r, 1500));
  return fetch(input, init);
}

export const supabase = createClient(SUPABASE_URL, PUBLISHABLE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, storageKey: "homeworks-ops-auth" },
  global: { fetch: fetchRetryIssuedAtFuture },
});
