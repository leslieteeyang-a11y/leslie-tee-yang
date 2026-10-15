// 登入纪录、查货补充、多行搬动、搬动筛选（2026-10-15）的资料层。权限都在资料库函数里检查。
import { supabase } from "./supabase";
import type { Move } from "./wh-api";

async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}

// ------------------------------------------------------------------ 登入纪录
export type LoginKind = "login" | "open";
export interface LoginStaffRow {
  id: number; name: string; department: string; department_name: string | null; branch: string; role: string;
  active: boolean; left: boolean;
  last_login: string | null; last_open: string | null; last_at: string | null;
  /** 今天（马来西亚日期）/ 近 30 天 / 总共几次（登入 + 打开系统） */ today: number; d30: number; total: number;
}
export interface LoginLogList { today: string; staff: LoginStaffRow[] }
export interface LoginLogDetail {
  staff: { id: number; name: string; department: string; branch: string; active: boolean };
  rows: { id: number; at: string; kind: LoginKind; ua: string }[];
}

const LOGIN_FLAG = "hw-login-just";
const OPEN_KEY = "hw-open-mark-";

async function mark(kind: LoginKind): Promise<void> {
  try {
    await supabase.rpc("ops_login_mark", { p_kind: kind, p_ua: (navigator.userAgent || "").slice(0, 300) });
  } catch { /* 记不到不影响画面 */ }
}

/** 登入画面：按登入成功后。等 App 载入到「我是谁」才真的记（同一个请求、先后不会乱）；无痕模式存不了就直接记 */
export function noteLogin(): void {
  try { sessionStorage.setItem(LOGIN_FLAG, "1"); return; } catch { /* 存不了 */ }
  void mark("login");
}

/** App 载入到「我是谁」之后：刚按过登入 → 记 login；不然这个浏览器分页第一次 → 记 open（资料库 10 分钟内只记一次） */
export function markOpen(staffId: number): void {
  let kind: LoginKind = "open";
  try {
    if (sessionStorage.getItem(LOGIN_FLAG)) { kind = "login"; sessionStorage.removeItem(LOGIN_FLAG); }
    else if (sessionStorage.getItem(OPEN_KEY + staffId)) return;
    sessionStorage.setItem(OPEN_KEY + staffId, "1");
  } catch { /* 读不到 sessionStorage：每次载入都送，资料库 10 分钟内只记一次 */ }
  void mark(kind);
}

/** User-Agent → 「手机 · Android · Chrome」（每段是中文介面用语，英文模式逐段翻） */
export function uaLabel(ua: string): string {
  const u = ua || "";
  if (!u) return "—";
  const tablet = /iPad|Tablet|PlayBook|Silk/i.test(u) || (/Android/i.test(u) && !/Mobile/i.test(u));
  const phone = !tablet && /iPhone|iPod|Android|Mobile|IEMobile|Opera Mini/i.test(u);
  const device = tablet ? "平板" : phone ? "手机" : "电脑";
  const os = /iPhone|iPad|iPod/i.test(u) ? "iOS" : /Android/i.test(u) ? "Android" : /Windows/i.test(u) ? "Windows"
    : /Mac OS X|Macintosh/i.test(u) ? "Mac" : /CrOS/i.test(u) ? "ChromeOS" : /Linux/i.test(u) ? "Linux" : "";
  const browser = /MicroMessenger/i.test(u) ? "微信" : /FBAN|FBAV|FB_IAB/i.test(u) ? "Facebook" : /Instagram/i.test(u) ? "Instagram"
    : /WhatsApp/i.test(u) ? "WhatsApp" : /SamsungBrowser/i.test(u) ? "Samsung" : /EdgA?\/|EdgiOS/i.test(u) ? "Edge"
    : /OPR\/|Opera/i.test(u) ? "Opera" : /Firefox|FxiOS/i.test(u) ? "Firefox" : /CriOS|Chrome\//i.test(u) ? "Chrome"
    : /Safari/i.test(u) ? "Safari" : "";
  return [device, os, browser].filter(Boolean).join(" · ");
}

// ------------------------------------------------------------------ 查货补充
export interface ItemMoreSale { doc_date: string | null; doc_no: string; doc_type: string; qty: number; uom: string | null; customer: string | null }
export interface ItemMoreReceipt {
  rcv_date: string | null; doc_no: string; src: string | null; qty: number; location: string | null;
  /** 看不到厂家的人是 null */ po_no: string | null; supplier: string | null;
}
export interface ItemMoreOutlet {
  code: string; name: string; short_name: string;
  /** own = 自己的（总部账套的总部、JB 账套整本）；consign = 总部账套里替分店订 / 寄存的仓位 */
  mode: "own" | "consign"; total: number;
  /** consign 才有：分店仓位、PRE 仓位、寄存在总部还没送、还欠分店 */
  own: number | null; pre: number | null; consigned: number | null; owed: number | null;
  locations: { location: string; qty: number }[];
}
export interface ItemMore {
  company: string; item_code: string; sees_supplier: boolean;
  sales: ItemMoreSale[]; receipts: ItemMoreReceipt[]; outlets: ItemMoreOutlet[];
}
export const SALE_DOC_LABEL: Record<string, string> = { IV: "发票", CS: "现金单", CN: "退货单", DN: "借项单" };

// ------------------------------------------------------------------ 多行搬动、搬动筛选
export interface MoveBatchLine { item_code: string; qty: string; from_bin?: string; to_bin?: string }
export interface MoveBatchResult { ok: boolean; n?: number; moves?: Move[]; /** 第几行错（1 起算） */ row?: number; message?: string }
export interface MoveFilter { from: string; to: string; move_kind: string; created_by: string; q: string }
export const EMPTY_FILTER: MoveFilter = { from: "", to: "", move_kind: "", created_by: "", q: "" };
/** 没有日期区间最多几笔、有日期区间最多几笔（与资料库 ops_wh_moves 相同） */
export const MOVE_LIMIT = 300;
export const MOVE_LIMIT_RANGE = 2000;

export const whx = {
  loginLog: () => rpc<LoginLogList>("ops_login_log", { p: {} }),
  loginDetail: (staffId: number) => rpc<LoginLogDetail>("ops_login_log", { p: { staff_id: staffId } }),
  itemMore: (company: string, item: string) => rpc<ItemMore>("ops_wh_item_more", { p: { company, item } }),
  /** 全部检查过才存：一行错整批不存，回传 row / message */
  moveBatch: (p: { company: string; kind: string; from_loc: string | null; to_loc: string | null; note: string; photo: string | null; lines: MoveBatchLine[] }) =>
    rpc<MoveBatchResult>("ops_wh_move_batch", { p }),
  movePeople: (company: string) => rpc<{ id: number; name: string; n: number }[]>("ops_wh_move_people", { p_company: company }),
};

/** 搬动清单的筛选参数（空的不送） */
export function filterParams(f: MoveFilter): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(f)) if (v.trim()) out[k] = v.trim();
  return out;
}
