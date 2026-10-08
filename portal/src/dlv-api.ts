// 送货模块的资料层：RPC、型别与纯函数（排路线、组 WhatsApp 清单）。
// 资料在 BI 的 bi.delivery_*（与 BI 顾客资料页的旧送货排单共用同一份）；权限在 public.ops_dlv_* 函数里检查。
// 路线：OpenStreetMap（Nominatim）找坐标、每秒最多 1 次；顺序 = 最近邻 + 2-opt（直线距离，不是实际车程）。
import { supabase } from "./supabase";
import { getLang, tr } from "./i18n";

export type DlvLevel = "view" | "edit" | "approve";
/** DO 明细一行：品名 / 数量 / 单位（SERVER 的 quote_push.py 从 DODTL 全部抓） */
export interface Line { d: string; q: number; u?: string | null }
export interface Hit {
  query?: string; found?: boolean;
  doc_no: string | null; company: string | null; doc_date: string | null; debtor_name: string | null; sales_agent?: string | null;
  amount?: number | null; items: string | null; cancelled: boolean; member_id: string | null;
  name: string | null; address: string | null; lat: number | null; lng: number | null;
  address_source?: "manual" | "do" | "profile" | null;
  lines?: Line[] | null; do_remark?: string | null; delivery_note?: string | null;
}
export interface Stop {
  key: string; doc_no: string | null; member_id: string | null; name: string; phone: string; address: string;
  lat: number | null; lng: number | null; items: string | null; geo: "ok" | "approx" | "none" | "todo";   // approx = 只找到邮区
  company?: string | null; source?: "manual" | "do" | "profile" | null;
  lines?: Line[] | null; remark?: string | null; dnote?: string | null;   // 完整货品、AutoCount DO 备注、给司机的备注
}
export interface Driver { kind: "staff" | "ext"; id: number; name: string; phone: string; store: string | null; active?: boolean }
export interface Depot { address: string; lat: number; lng: number }
export interface DlvMeta {
  level: DlvLevel; me_id: number; companies: string[]; depot: Record<string, Depot>; drivers: Driver[]; synced: string | null;
}
/** photos = 照片路径（路径里有连结代码，所以连结有效时只给可编辑的人与司机；其他人只有 photo_count） */
export interface Pod { stop_key: string; doc_no: string | null; status: "delivered" | "failed"; note: string | null; photos: string[]; photo_count: number; created_at: string }
export interface Run {
  id: number; run_date: string; store: string | null; company: string | null; driver_name: string | null; driver_phone: string | null;
  driver_staff_id: number | null; stops: Stop[]; created_by: string | null; created_at: string;
  has_link: boolean; link_valid: boolean; token: string | null; pods: Pod[];
}

/** 分店 ↔ 门市代号（排单与出发点用 HQ / JB） */
export const STORE: Record<string, string> = { HOMEWORKSSB: "HQ", HOMEWORKSSOUTHERN: "JB" };

async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}

export const dlv = {
  meta: () => rpc<DlvMeta>("ops_dlv_meta"),
  lookupMany: (company: string, queries: string[]) => rpc<Hit[]>("ops_dlv_lookup_many", { p_company: company, p_queries: queries }),
  lookup: (company: string, q: string) => rpc<Hit[]>("ops_dlv_lookup", { p_company: company, p_query: q }),
  docs: (company: string, date: string) => rpc<Hit[]>("ops_dlv_docs", { p_company: company, p_date: date }),
  setAddress: (company: string, docNo: string, address: string) =>
    rpc<void>("ops_dlv_doc_set_address", { p_company: company, p_doc_no: docNo, p_address: address }),
  setNote: (company: string, docNo: string, note: string) =>
    rpc<void>("ops_dlv_doc_set_note", { p_company: company, p_doc_no: docNo, p_note: note }),
  setCustomerAddress: (member: string, address: string) =>
    rpc<void>("ops_dlv_customer_set_address", { p_member: member, p_address: address }),
  setGeo: (address: string, lat: number, lng: number) => rpc<void>("ops_dlv_geo_set", { p_address: address, p_lat: lat, p_lng: lng }),
  saveRun: (p: { company: string; driver_kind: string | null; driver_id: number | null; stops: Stop[]; token: string }) =>
    rpc<{ id: number }>("ops_dlv_run_save", { p }),
  runs: (company: string, days = 14) => rpc<Run[]>("ops_dlv_runs", { p_company: company, p_days: days }),
  myRuns: () => rpc<Run[]>("ops_dlv_my_runs"),
  home: () => rpc<{ my_stops_left: number; stops_open_today: number | null }>("ops_dlv_home"),
  setDepot: (company: string, address: string, lat: number, lng: number) =>
    rpc<void>("ops_dlv_set_depot", { p_company: company, p_address: address, p_lat: lat, p_lng: lng }),
  saveDriver: (p: { id?: number | null; name: string; phone: string; company: string; active?: boolean }) =>
    rpc<Driver>("ops_dlv_driver_save", { p }),
  /** 签收照片（私有 bucket）：1 小时有效的网址 */
  async photoUrls(paths: string[]): Promise<Record<string, string>> {
    if (!paths.length) return {};
    const { data, error } = await supabase.storage.from("delivery-pod").createSignedUrls(paths, 3600);
    if (error) throw new Error(error.message);
    return Object.fromEntries((data ?? []).filter((x) => x.signedUrl).map((x) => [x.path ?? "", x.signedUrl as string]));
  },
};

// ------------------------------------------------------------ 纯函数

/** 司机签收连结的代码：24 个网址安全的随机字元，排单时在前端产生，WhatsApp 讯息里就带得到连结 */
export function newToken(): string {
  const b = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
/** 营运系统里的司机签收页（不用登入） */
export function driverLink(token: string, base: string = location.origin + location.pathname): string {
  return `${base}#/driver?t=${token}`;
}

export function phoneOf(member: string | null): string {
  return member && /^[0-9]+$/.test(member) ? member : "";
}

/** 60123456789 → 012-345 6789 */
export function fmtPhone(p: string | null | undefined): string {
  if (!p) return "";
  if (p.startsWith("65") && p.length === 10) return `+65 ${p.slice(2, 6)} ${p.slice(6)}`;
  if (p.startsWith("60")) {
    const d = "0" + p.slice(2);
    return d.startsWith("01") ? `${d.slice(0, 3)}-${d.slice(3, d.length - 4)} ${d.slice(-4)}` : d;
  }
  return p;
}

/** 两点直线距离（公里） */
export function km(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const r = (x: number) => (x * Math.PI) / 180;
  const dLat = r(b.lat - a.lat), dLng = r(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

type Pt = { lat: number; lng: number };
/** 排最短顺序：从出发点开始找最近的下一站，再用 2-opt 把交叉的路段拉直。没坐标的排在最后。 */
export function orderStops(stops: Stop[], start: Pt | null): Stop[] {
  const geo = stops.filter((s) => s.lat != null && s.lng != null) as (Stop & Pt)[];
  const rest = stops.filter((s) => s.lat == null || s.lng == null);
  if (geo.length < 2) return [...geo, ...rest];
  const left = [...geo];
  const path: (Stop & Pt)[] = [];
  let cur: Pt = start ?? left[0];
  while (left.length) {
    let bi = 0;
    for (let i = 1; i < left.length; i++) if (km(cur, left[i]) < km(cur, left[bi])) bi = i;
    cur = left.splice(bi, 1)[0];
    path.push(cur as Stop & Pt);
  }
  const pts: Pt[] = start ? [start, ...path] : [...path];
  const off = start ? 1 : 0;
  let improved = true;
  for (let guard = 0; improved && guard < 50; guard++) {
    improved = false;
    for (let i = off; i < pts.length - 1; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const a = pts[i - 1] ?? null, b = pts[i], c = pts[j], d = pts[j + 1] ?? null;   // 最后一站后面没有路段
        const before = (a ? km(a, b) : 0) + (d ? km(c, d) : 0);
        const after = (a ? km(a, c) : 0) + (d ? km(b, d) : 0);
        if (after + 1e-9 < before) {
          pts.splice(i, j - i + 1, ...pts.slice(i, j + 1).reverse());
          improved = true;
        }
      }
    }
  }
  return [...(pts.slice(off) as Stop[]), ...rest];
}

export function routeKm(stops: Stop[], start: Pt | null): number {
  let total = 0;
  let prev: Pt | null = start;
  for (const s of stops) {
    if (s.lat == null || s.lng == null) continue;
    if (prev) total += km(prev, { lat: s.lat, lng: s.lng });
    prev = { lat: s.lat, lng: s.lng };
  }
  return total;
}

export function wazeLink(s: { lat: number | null; lng: number | null; address: string | null; geo?: string }): string {
  return s.lat != null && s.lng != null && !(s.geo === "approx" && s.address)       // 只找到邮区：导航用地址，不用邮区中心
    ? `https://waze.com/ul?ll=${s.lat},${s.lng}&navigate=yes`
    : `https://waze.com/ul?q=${encodeURIComponent(s.address ?? "")}&navigate=yes`;
}

function gmapPoint(p: { lat?: number | null; lng?: number | null; address?: string; geo?: string }): string {
  return p.lat != null && p.lng != null && !(p.geo === "approx" && p.address) ? `${p.lat},${p.lng}` : encodeURIComponent(p.address ?? "");
}

/** Google Maps 全程连结；一条最多 9 个中途站，超过就分段 */
export function gmapRoutes(stops: Stop[], depot: Depot | null): string[] {
  // 没坐标又没地址的站（使用者确认「没有地址也要传」）不放进全程路线，不然整条路线的终点 / 中途站是空的
  const pts: { lat?: number | null; lng?: number | null; address?: string; geo?: string }[] = [...(depot ? [depot] : []), ...stops]
    .filter((p) => (p.lat != null && p.lng != null) || !!p.address?.trim());
  const out: string[] = [];
  for (let i = 0; i < pts.length - 1; i += 10) {
    const seg = pts.slice(i, Math.min(i + 11, pts.length));
    if (seg.length < 2) break;
    const mid = seg.slice(1, -1).map(gmapPoint).join("%7C");
    out.push(`https://www.google.com/maps/dir/?api=1&travelmode=driving&origin=${gmapPoint(seg[0])}`
      + `&destination=${gmapPoint(seg[seg.length - 1])}${mid ? `&waypoints=${mid}` : ""}`);
  }
  return out;
}

/** 「HEMOS TAP × 2 UNIT」；数量是整数就不印小数 */
export function fmtLine(l: Line): string {
  const q = Number(l.q) || 0;
  const qty = Number.isInteger(q) ? String(q) : String(Math.round(q * 1000) / 1000);
  return `${l.d} × ${qty}${l.u ? ` ${l.u}` : ""}`;
}

/** 给司机的 WhatsApp 清单（中文；司机签收页另有中 / 英 / 马来文） */
export function driverMessage(stops: Stop[], opt: { date: string; driver: string; store: string; depot: Depot | null; link?: string }): string {
  const total = routeKm(stops, opt.depot);
  const lines = [
    `🚚 HomeWorks 送货单 ${opt.date}`,
    `司机：${opt.driver} · 共 ${stops.length} 站${total ? `（直线约 ${total.toFixed(0)} km）` : ""}`,
    `出发：${opt.store}${opt.depot?.address ? ` ${opt.depot.address}` : ""}`,
    "",
  ];
  if (opt.link) lines.splice(3, 0, "📲 每送完一站，开这个连结按「已送达」并拍照：", opt.link);
  stops.forEach((s, i) => {
    lines.push(`${i + 1}. ${s.doc_no ?? "（没有 DO 单号）"}`);
    lines.push(`👤 ${[s.name, fmtPhone(s.phone)].filter(Boolean).join(" · ") || "-"}`);
    lines.push(`📍 ${s.address || "（没有地址，请先打电话问顾客）"}`);
    if (s.dnote) lines.push(`⚠️ 备注：${s.dnote}`);
    if (s.remark) lines.push(`📝 单据备注：${s.remark}`);
    if (s.lines?.length) {
      lines.push(`🧾 货品（${s.lines.length} 项）：`);
      s.lines.forEach((l) => lines.push(`   • ${fmtLine(l)}`));
    } else if (s.items) lines.push(`🧾 ${s.items}`);
    if (s.address || s.lat != null) lines.push(`🧭 ${wazeLink(s)}`);
    lines.push("");
  });
  const routes = gmapRoutes(stops, opt.depot);
  if (routes.length) {
    lines.push("🗺️ 全程路线（Google Maps）：");
    routes.forEach((r, i) => lines.push(routes.length > 1 ? `第 ${i + 1} 段：${r}` : r));
  }
  return lines.join("\n");
}

/** 「1.5321, 103.6612」或 Google Maps 连结（…@1.53,103.66… / …q=1.53,103.66…）→ 坐标 */
export function parseCoords(text: string): Pt | null {
  const m = text.match(/(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)/);
  if (!m) return null;
  const lat = Number(m[1]), lng = Number(m[2]);
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
}

// OpenStreetMap 规定每秒最多 1 次：每一次请求前都等到离上一次 1.1 秒（找到 / 找不到都一样）
let lastGeo = 0;
async function geoGap(): Promise<void> {
  const at = Math.max(Date.now(), lastGeo + 1100);   // 先占好自己的时段，两个地方同时找也不会挤在一起
  lastGeo = at;
  const wait = at - Date.now();
  if (wait > 0) await new Promise((res) => setTimeout(res, wait));
}

/** 地图位置资料来源（OpenStreetMap 的使用规定要标出来） */
export const OSM_CREDIT = "地图位置资料 © OpenStreetMap 贡献者";
// 这次开网页期间找过、确定找不到的地址：不再重问（OpenStreetMap 规定不要重复送同一个查询）；改了地址就是新的一笔
const geoMiss = new Set<string>();

/** 地址 → 坐标（OpenStreetMap，免费）。先整段地址，找不到再用 5 位邮编（只是邮区的大概位置，approx = true）。
 *  网路出错 / 被限流就直接回 null，不拿邮编乱猜。 */
export async function geocode(address: string): Promise<(Pt & { approx?: boolean }) | null> {
  const key = address.trim().toLowerCase();
  if (geoMiss.has(key)) return null;
  const post = address.match(/\b\d{5}\b/)?.[0];
  const tries: [string, boolean][] = [[`q=${encodeURIComponent(address)}&countrycodes=my,sg`, false],
    ...(post ? [[`postalcode=${post}&countrycodes=my`, true] as [string, boolean]] : [])];
  for (const [q, approx] of tries) {
    await geoGap();
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&${q}`, { headers: { "Accept-Language": "en" } });
      if (!r.ok) return null;
      const j = (await r.json()) as { lat: string; lon: string }[];
      if (!Array.isArray(j)) return null;
      if (j.length) return { lat: Number(j[0].lat), lng: Number(j[0].lon), approx };
    } catch {
      return null;
    }
  }
  geoMiss.add(key);   // 两种都问过、确定找不到（网路出错不算）
  return null;
}

/** window.confirm 不在画面上，DOM 翻译层翻不到：英文模式时自己先翻 */
export function ui(s: string): string {
  return getLang() === "en" ? tr(s) : s;
}

export function toStop(h: Hit): Stop {
  return {
    key: h.doc_no ?? `M:${h.member_id}`, doc_no: h.doc_no, member_id: h.member_id,
    // 门市散客的单据名称多是「CASH（电话）」：去掉电话后只剩 CASH 就不显示，司机看电话就好
    name: (h.name ?? h.debtor_name ?? "").replace(/[(（]?\s*\+?\d[\d\s-]{6,}\d\s*[)）]?/g, " ").replace(/[()（）]/g, " ")
      .replace(/\s+/g, " ").trim().replace(/^CASH$/i, ""),
    phone: phoneOf(h.member_id), address: h.address ?? "", lat: h.lat, lng: h.lng, items: h.items,
    lines: h.lines ?? null, remark: h.do_remark ?? null, dnote: h.delivery_note ?? null,
    geo: h.lat != null && h.lng != null ? "ok" : "todo", company: h.company, source: h.address_source ?? null,
  };
}

/** 马来西亚今天的日期 YYYY-MM-DD */
export function todayKL(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kuala_Lumpur" }).format(new Date());
}

/** 店员整串贴上的单号 → 一个个单号（空白、换行、逗号、分号都可以分开） */
export function splitDocNos(text: string): string[] {
  const out: string[] = [];
  for (const x of text.split(/[\s,，;；、]+/)) {
    const v = x.trim().toUpperCase();
    if (v.length >= 3 && !out.includes(v)) out.push(v);
  }
  return out;
}

const klTime = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kuala_Lumpur", hour: "2-digit", minute: "2-digit" });
/** 签收时间（UTC）→ 马来西亚时间 14:05 */
export function hhmmKL(ts: string): string {
  return klTime.format(new Date(ts));
}
