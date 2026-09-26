// Supabase 连线：与 HomeWorks BI 同一个专案、同一套登入。publishable key 本来就是公开的（权限靠资料库函数检查）。
import { createClient } from "@supabase/supabase-js";

export const SUPABASE_URL = "https://vwljnypzgfqhatkgulqs.supabase.co";
const PUBLISHABLE_KEY = "sb_publishable__elDWkBfCa5ajEQLR0NmRQ_p5a3089Q";

export const supabase = createClient(SUPABASE_URL, PUBLISHABLE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, storageKey: "homeworks-ops-auth" },
});
