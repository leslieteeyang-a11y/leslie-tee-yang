// 顾客资料模块的资料层：型别、纯函数（分级、跟进提醒、筛选、电话格式）与翻译。
// 资料在 BI 的 bi.customer_*（与 BI 的顾客资料页 loyalty.html 共用同一份）；前端直接呼叫 BI 原本的 public.bi_customer* /
// bi_campaign* / bi_wa_template* 函数，权限在函数开头的 bi.crm_require 检查（BI 名单 + 营运系统「顾客资料」模块权限，
// migration 20261016_ops_customers.sql）。这一页自己带中英文（translate="no"，字典在 cust/dict.ts），不走 i18n.ts 的 DOM 翻译。
import { supabase } from "./supabase";
import { getLang, tr as portalTr } from "./i18n";
import { CUST_EN, CUST_PATTERNS } from "./cust/dict";

export type Consent = "yes" | "no" | null;
export interface Customer {
  member_id: string; name: string | null; stores: string | null; first_date: string | null; last_date: string | null;
  doc_count: number; doc_count_12m: number; spent: number; spent_12m: number; categories: string[];
  birth_month: number | null; birth_day: number | null; area: string | null; address: string | null;
  customer_type: string | null; note: string | null; consent: Consent; next_contact: string | null;
  last_contact_at: string | null; profile_created_at: string | null; profile_updated_at: string | null;
  reno_stage?: string | null; reno_stage_at?: string | null; quote_open?: number; quote_amount?: number; quote_due?: string | null;
}
export interface Item { item_code: string | null; description: string | null; qty: number; uom: string | null; sub_total: number }
export interface Doc {
  company: string; doc_type: string; doc_no: string; doc_date: string; debtor_code: string; debtor_name: string | null;
  sales_agent: string | null; amount: number; items: Item[];
}
export interface Profile {
  name: string | null; birth_month: number | null; birth_day: number | null; area: string | null; address: string | null;
  customer_type: string | null; note: string | null; consent: Consent; consent_at: string | null; consent_by: string | null;
  next_contact: string | null; last_contact_at: string | null; updated_at: string; updated_by: string | null;
  reno_stage?: string | null; reno_stage_at?: string | null; email?: string | null;
}
export interface Quote {
  company: string; doc_no: string; doc_date: string; sales_agent: string | null; amount: number; transferred: boolean;
  items: string | null; bought_after: boolean;
}
export interface Detail { member_id: string; profile: Profile | null; docs: Doc[]; aliases?: string[]; quotes?: Quote[] }
export interface Signup {
  id: number; member_id: string; main_id: string; name: string | null; birth_month: number | null; birth_day: number | null;
  area: string | null; address?: string | null; email?: string | null; consent: boolean; store: string | null; created_at: string;
  status: "pending" | "confirmed" | "rejected";
  current: {
    name: string | null; birth_month: number | null; birth_day: number | null; area: string | null; consent: Consent;
    last_contact_at?: string | null;
  } | null;
}
export interface LogRow { at: string; by: string | null; action: string; changes: Record<string, unknown>; member_id: string }
export interface Missing {
  company: string; doc_type: string; doc_no: string; doc_date: string; debtor_code: string;
  debtor_name: string | null; sales_agent: string | null; amount: number;
}
export interface Settings {
  vip_min_12m: number; regular_min_docs: number; lapsed_days: number; lead_follow_days: number; birthday_days: number;
  quote_follow_days: number; quote_max_days: number; stage_follow_days: number; stage_reco: Record<string, string[]>;
  updated_at?: string | null; updated_by?: string | null;
}
export interface Template { id: number; title: string; body: string; sort: number }
export interface Campaign {
  id: number; name: string; message: string | null; sent_on: string; created_by: string | null; members: number;
  buyers_30: number; revenue_30: number; buyers_60: number; revenue_60: number;
}
export interface Monthly {
  month: string; active: number; new_customers: number; returning_customers: number;
  new_revenue: number; returning_revenue: number; lapsed: number;
}
export interface Agent { agent: string; customers: number; returning_customers: number; new_customers: number; revenue: number }

/** 顾客资料的角色（public.ops_cust_role）：owner = 管理员 / BI 老板、manager = 可审批、sales = 可编辑、viewer = 只看 */
export type CustRole = "owner" | "manager" | "sales" | "viewer";

// ------------------------------------------------------------ 翻译：这一页 translate="no"，自己翻
const EN = getLang() === "en";
/** 中文原句 → 目前语言；{a} 换成 vars.a。字典没有的退回营运系统的字典（资料库错误讯息在那边） */
export function t(zh: string, vars?: Record<string, string | number>): string {
  let s = EN ? CUST_EN[zh] ?? portalTr(zh) : zh;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return s;
}
/** 资料库来的错误讯息（中文）→ 目前语言 */
export function errText(e: unknown): string {
  const m = e instanceof Error ? e.message : typeof e === "object" && e && "message" in e ? String((e as { message: unknown }).message) : String(e);
  if (EN) {
    for (const [re, fn] of CUST_PATTERNS) {
      const hit = m.match(re);
      if (hit) return fn(hit);
    }
  }
  return t(m);
}

/** 资料库存的系统文字（例：「顾客自己扫码登记（HQ）」）→ 目前语言；员工 email 照原样 */
export function dbText(s: string | null | undefined): string {
  if (!s || !EN) return s ?? "";
  for (const [re, fn] of CUST_PATTERNS) {
    const hit = s.match(re);
    if (hit) return fn(hit);
  }
  return s;
}

// ------------------------------------------------------------ 呼叫
export async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}
export const custRole = () => rpc<CustRole | null>("ops_cust_role");
/** 「已联络」：记下联络时间（跟进提醒就消失）；回传错误讯息（空字串 = 成功） */
export async function touch(id: string): Promise<string> {
  const { error } = await supabase.rpc("bi_customer_touch", { p_member: id });
  return error ? errText(error) : "";
}

// ------------------------------------------------------------ 纯函数（与 BI 的 Loyalty.tsx 相同）
export const num = (v: unknown) => Number(v ?? 0);
export const STORE: Record<string, string> = { HOMEWORKSSB: "HQ", HOMEWORKSSOUTHERN: "JB" };
export const TYPES = ["屋主", "设计师", "承包商", "水工", "公司", "其他"];
export const DEFAULT_SETTINGS: Settings = {
  vip_min_12m: 10000, regular_min_docs: 2, lapsed_days: 365, lead_follow_days: 7, birthday_days: 7,
  quote_follow_days: 7, quote_max_days: 60, stage_follow_days: 30,
  stage_reco: { plan: ["SANITARY", "KITCHEN"], rough: ["VALVE", "FITTING"], tile: ["SANITARY", "BUILDING"],
    install: ["LOCK", "KITCHEN", "ELECTRIC", "GARDEN"], done: ["LOCK", "GARDEN"] },
};
/** 装修进度 5 段（使用者 2026-10-05 选的），键存资料库、名称显示用 */
export const STAGES: [string, string][] = [
  ["plan", "规划中"], ["rough", "动工 / 水电"], ["tile", "泥水 / 贴砖"], ["install", "安装"], ["done", "完工"],
];
export const STAGE_LABEL: Record<string, string> = Object.fromEntries(STAGES);

/** 这个装修阶段推荐的类别里，顾客还没买过的（给店员开口推荐） */
export function stageNext(stage: string | null | undefined, bought: string[], s: Settings): string[] {
  if (!stage) return [];
  return (s.stage_reco?.[stage] ?? []).filter((c) => !bought.includes(c));
}

/** 60123456789 → 012-345 6789；6591234567 → +65 9123 4567；A:公司:代号 → 代号 (HQ) */
export function fmtMember(id: string): string {
  if (id.startsWith("A:")) {
    const [, co, code] = id.split(":");
    return `${code} (${STORE[co] ?? co})`;
  }
  if (id.startsWith("65") && id.length === 10) return `+65 ${id.slice(2, 6)} ${id.slice(6)}`;
  if (id.startsWith("60")) {
    const d = "0" + id.slice(2);
    if (d.startsWith("01")) return `${d.slice(0, 3)}-${d.slice(3, d.length - 4)} ${d.slice(-4)}`;
    return `${d.slice(0, 2)}-${d.slice(2)}`;
  }
  return id;
}

/** 给 WhatsApp 用的国际格式：60123456789 → +60123456789；账号型顾客没有电话 → 空 */
export function waNumber(id: string): string {
  return /^[0-9]+$/.test(id) ? `+${id}` : "";
}

/** 单据上的客户名称常夹着电话：「ZILONG (017-7000190)」→「ZILONG」 */
export function cleanName(raw: string | null | undefined): string {
  return (raw ?? "").replace(/[(（]?\s*\+?\d[\d\s-]{6,}\d\s*[)）]?/g, " ").replace(/[()（）]\s*[)）]?/g, " ")
    .replace(/\s+/g, " ").trim();
}

/** 范本的 {name} 换成顾客名字；没有名字时把「Hi {name}，」收成「Hi，」 */
export function fillTemplate(body: string, name: string): string {
  return body.replace(/\{name\}/g, name.trim()).replace(/[ \t]+([，,！!])/g, "$1");
}

/** wa.me 连结；账号型顾客（没有电话）回空字串 */
export function waLink(id: string, text?: string): string {
  if (!/^[0-9]+$/.test(id)) return "";
  return `https://wa.me/${id}` + (text ? `?text=${encodeURIComponent(text)}` : "");
}

/** 本地日期 yyyy-mm-dd（不用 toISOString，避免马来西亚早上 8 点前算成前一天） */
export function localISO(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function midnight(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function daysSince(d: string | null, today: Date = new Date()): number {
  if (!d) return Infinity;
  const at = d.length <= 10 ? new Date(d + "T00:00:00") : new Date(d);
  return (midnight(today).getTime() - midnight(at).getTime()) / 86400000;
}

/** 离下一次生日还有几天（今天生日 = 0）；2/29 在平年算 3/1 */
export function daysUntilBirthday(month: number, day: number, today: Date = new Date()): number {
  const t0 = midnight(today);
  let b = new Date(t0.getFullYear(), month - 1, day);
  if (b < t0) b = new Date(t0.getFullYear() + 1, month - 1, day);
  return Math.round((b.getTime() - t0.getTime()) / 86400000);
}

export type Tier = "vip" | "regular" | "normal" | "lapsed" | "lead";
export const TIERS: Tier[] = ["vip", "regular", "normal", "lapsed", "lead"];
export const TIER_LABEL: Record<Tier, string> = { vip: "VIP", regular: "常客", normal: "一般", lapsed: "流失", lead: "潜在客" };

/** 分级：没买过 = 潜在客；最后消费超过流失天数 = 流失；近 12 个月消费 ≥ 门槛 = VIP；近 12 个月单数 ≥ 门槛 = 常客；其余一般 */
export function tierOf(c: Pick<Customer, "last_date" | "spent_12m" | "doc_count_12m">, s: Settings, today: Date = new Date()): Tier {
  if (!c.last_date) return "lead";
  if (daysSince(c.last_date, today) > s.lapsed_days) return "lapsed";
  if (num(c.spent_12m) >= num(s.vip_min_12m)) return "vip";
  if (num(c.doc_count_12m) >= num(s.regular_min_docs)) return "regular";
  return "normal";
}

export interface Reason { kind: "due" | "birthday" | "lead" | "quote" | "stage"; days: number }
export interface FollowUp { c: Customer; reasons: Reason[] }

/** 跟进提醒：约好的联络日到了、生日快到（这段期间还没联络过）、潜在客建档后 N 天都没联络、报价没成交、装修进度太久没更新 */
export function followUps(list: Customer[], s: Settings, today: Date = new Date()): FollowUp[] {
  const iso = localISO(today);
  const out: FollowUp[] = [];
  for (const c of list) {
    const reasons: Reason[] = [];
    const contacted = daysSince(c.last_contact_at, today);
    if (c.next_contact && c.next_contact <= iso) reasons.push({ kind: "due", days: daysSince(c.next_contact, today) });
    if (c.birth_month && c.birth_day) {
      const d = daysUntilBirthday(c.birth_month, c.birth_day, today);
      if (d <= s.birthday_days && !(contacted <= s.birthday_days - d)) reasons.push({ kind: "birthday", days: d });
    }
    if (!c.last_date && c.profile_created_at && !c.last_contact_at && !(c.next_contact && c.next_contact > iso)
        && daysSince(c.profile_created_at, today) >= s.lead_follow_days) {
      reasons.push({ kind: "lead", days: daysSince(c.profile_created_at, today) });
    }
    // 报价单开出 N 天还没成交（没转单、之后也没买），从该跟进的那天起还没联络过
    if (c.quote_due && (!c.last_contact_at || localISO(new Date(c.last_contact_at)) < c.quote_due)) {
      reasons.push({ kind: "quote", days: daysSince(c.quote_due, today) + s.quote_follow_days });
    }
    // 装修进度太久没更新（完工的不追）
    if (c.reno_stage && c.reno_stage !== "done" && c.reno_stage_at && daysSince(c.reno_stage_at, today) >= s.stage_follow_days
        && !(contacted < s.stage_follow_days)) {
      reasons.push({ kind: "stage", days: daysSince(c.reno_stage_at, today) });
    }
    if (reasons.length) out.push({ c, reasons });
  }
  const order = { due: 0, quote: 50, birthday: 100, stage: 500, lead: 1000 };
  const rank = (x: FollowUp) => Math.min(...x.reasons.map((r) => order[r.kind] + (r.kind === "birthday" ? r.days : 0)));
  return out.sort((a, b) => rank(a) - rank(b));
}

export interface Filters {
  q: string; store: string; recency: string; minSpent: string; category: string; notCategory: string; ctype: string;
  area: string; bmonth: string; tier: string; consent: string; stage: string;
}
export const EMPTY_FILTERS: Filters = {
  q: "", store: "", recency: "", minSpent: "", category: "", notCategory: "", ctype: "", area: "", bmonth: "", tier: "", consent: "",
  stage: "",
};

export function applyFilters(list: Customer[], f: Filters, s: Settings = DEFAULT_SETTINGS): Customer[] {
  const text = f.q.trim().toLowerCase();
  const digits = f.q.replace(/\D/g, "").replace(/^0/, "");
  const min = num(f.minSpent);
  return list.filter((c) => {
    if (text && !((digits.length >= 4 && c.member_id.includes(digits)) || (c.name ?? "").toLowerCase().includes(text)
      || (c.note ?? "").toLowerCase().includes(text))) return false;
    if (f.store === "HQ" && !(c.stores ?? "").includes("HQ")) return false;
    if (f.store === "JB" && !(c.stores ?? "").includes("JB")) return false;
    if (f.store === "both" && c.stores !== "HQ + JB") return false;
    const age = daysSince(c.last_date);
    if (f.recency === "90" && age > 90) return false;
    if (f.recency === "180" && age > 180) return false;
    if (f.recency === "365" && age > 365) return false;
    if (f.recency === "lapsed" && !(age > 365 && isFinite(age))) return false;
    if (f.recency === "none" && isFinite(age)) return false;
    if (min && num(c.spent) < min) return false;
    if (f.category && !c.categories.includes(f.category)) return false;
    if (f.notCategory && c.categories.includes(f.notCategory)) return false;
    if (f.ctype === "-" ? c.customer_type : f.ctype && c.customer_type !== f.ctype) return false;
    if (f.area && !`${c.area ?? ""} ${c.address ?? ""}`.toLowerCase().includes(f.area.trim().toLowerCase())) return false;
    if (f.bmonth && c.birth_month !== num(f.bmonth)) return false;
    if (f.tier && tierOf(c, s) !== f.tier) return false;
    if (f.consent === "yes" && c.consent !== "yes") return false;
    if (f.consent === "no" && c.consent !== "no") return false;
    if (f.consent === "unknown" && c.consent) return false;
    if (f.stage === "quote" ? !num(c.quote_open) : f.stage === "any" ? !c.reno_stage : f.stage && c.reno_stage !== f.stage) return false;
    return true;
  });
}

// ------------------------------------------------------------ 格式与汇出
export function fmtNum(v: unknown, digits = 0): string {
  return num(v).toLocaleString("en-MY", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
export function fmtMoney(v: unknown): string {
  return "RM " + fmtNum(v, 2);
}
export function fmtDay(s: string | null | undefined): string {
  return s ? s.slice(0, 10) : "";
}
export function fmtTime(s: string | null | undefined): string {
  return s ? new Date(s).toLocaleString("en-MY", { dateStyle: "short", timeStyle: "short" }) : "";
}
export function pct(a: number, b: number): string {
  return b ? `${((a / b) * 100).toFixed(0)}%` : "–";
}

function csvCell(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export function downloadCsv(filename: string, header: string[], rows: unknown[][]): void {
  const text = "﻿" + [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** BI 网站（顾客扫码登记页 join.html 在那边，不用登入） */
export const BI_SITE = "https://homeworks-bi.vercel.app";
