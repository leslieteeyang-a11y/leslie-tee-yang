// 厂家到货（厂家 DO / 装箱单）、分到各分店、在路上、厂家问题：资料层（RPC、型别、档案上传）。
// 权限与分店都在 public.ops_po_* 函数里检查；这些函数一律不回传单价 / 金额。
// 档案放 Storage 私有 bucket ops-po，路径 <公司>/<yyyy-mm>/<随机>-<档名>（只有 insert / read policy：不能 upsert，也不删）。
import { supabase } from "./supabase";
import { getLang, tr } from "./i18n";
import type { PoStatus } from "./api";

export type DoStatus = "draft" | "confirmed" | "arrived" | "cancelled";
export type IssueKind = "short" | "over" | "wrong" | "damaged";
export type IssueDecision = "pending" | "await" | "cancelled";
export type IssueStatus = "open" | "resolved" | "void";

export interface Outlet { code: string; name: string; short_name: string; company: string; active: boolean }
export interface DoSupplier {
  company: string; creditor_code: string; supplier_name: string; is_china: boolean; po_count: number; open_qty: number;
  last_po_date: string; drafts: number;
}
export interface DoPo {
  po_no: string; po_date: string; days_open: number; status: PoStatus; closed: boolean; eta: string; eta_source: string;
  lines: number; open_qty: number; in_transit: number; remaining: number; outlets: string[];
  dos: { id: number; do_no: string; status: DoStatus }[];
}
export interface OutletQty { open: number; in_transit: number; remaining: number }
/** 所选 PO 的一个型号：订 / AutoCount 已收 / 未到 / 别张 DO 在路上 / 还可以出；各分店（有未到或还可以出的）。
 *  received_do = 这张 DO 已经开了 GRN 的（已算回 remaining）；owed = 已记、还开着的少发 + 坏货；
 *  flagged / fillable / await_elsewhere：确认前预估少发 / 多发（与伺服器 ops_po_do_confirm 同规则） */
export interface Candidate {
  item_code: string; description: string; uom: string; po_nos: string[]; ordered: number; received: number; open_qty: number;
  in_transit: number; received_do: number; remaining: number; owed: number; flagged: number; fillable: number;
  await_elsewhere: number; by_outlet: Record<string, OutletQty>; single_outlet: string | null;
}
export interface DoItem {
  item_code: string | null; description: string; uom: string; shipped: number; alloc: Record<string, number>;
  src_code: string; src_desc: string; src_row: number | null; expected_code: string | null; note: string;
}
export interface DoFile { path: string; name: string; size: number | null; type: string }
export interface DoHeader {
  id: number; company: string; creditor_code: string; supplier_name: string; do_no: string; do_date: string | null;
  eta: string | null; shipment_id: number | null; shipment_name: string | null; shipment_eta: string | null;
  eta_effective: string | null; eta_source: "shipment" | "do" | null; status: DoStatus; po_nos: string[]; remark: string;
  files: DoFile[]; item_count: number; unmatched_count: number; shipped_total: number; issue_open: number;
  created_by_name: string | null; created_at: string; updated_by_name: string | null; updated_at: string;
  confirmed_by_name: string | null; confirmed_at: string | null; arrived_by_name: string | null; arrived_at: string | null;
  arrive_note: string; cancelled_by_name: string | null; cancelled_at: string | null; cancel_reason: string;
  can_edit: boolean; can_edit_info: boolean; can_reopen: boolean; can_arrive: boolean; can_add_issue: boolean;
}
export interface Applied { item_code: string; outlet: string; qty: number; po_no: string | null; dtl_key: number | null; line_outlet: string | null }
export interface DoFull extends DoHeader {
  items: DoItem[]; outlets: Outlet[]; candidates: Candidate[]; applied: Applied[]; issues: Issue[];
  history: { at: string; action: string; staff_name: string | null; data: Record<string, unknown> }[];
}
export interface Issue {
  id: number; company: string; creditor_code: string; supplier_name: string; do_id: number | null; do_no: string | null;
  do_date: string | null; do_status: DoStatus | null; kind: IssueKind; item_code: string | null; received_code: string;
  description: string; po_nos: string[]; ordered: number | null; received: number | null; qty: number; resolved_qty: number;
  open_qty: number; decision: IssueDecision | null; status: IssueStatus; auto: boolean; note: string; action_note: string;
  resolutions: { do_id: number; do_no: string; qty: number; at: string }[];
  created_at: string; created_by_name: string | null; decided_at: string | null; decided_by_name: string | null;
  resolved_at: string | null; resolved_by_name: string | null; resolved_auto: boolean; updated_at: string;
}
export interface TransitRow {
  do_id: number; do_no: string; do_date: string | null; company: string; creditor_code: string; supplier_name: string;
  eta: string | null; eta_source: "shipment" | "do" | null; shipment_name: string | null; outlet: string; outlet_name: string;
  item_code: string; description: string; uom: string; qty: number; po_nos: string[]; confirmed_at: string; can_arrive: boolean;
}
export interface Transit { outlets: { code: string; name: string; short_name: string }[]; rows: TransitRow[] }

export const DO_STATUS_LABEL: Record<DoStatus, string> = {
  draft: "草稿", confirmed: "在路上", arrived: "已到货", cancelled: "已取消",
};
export const ISSUE_KIND_LABEL: Record<IssueKind, string> = { short: "少发", over: "多发", wrong: "发错型号", damaged: "坏货" };
/** 手动记的少发 = 到货少（厂家 DO 写的比实际到的多） */
export const issueKindLabel = (i: Pick<Issue, "kind" | "auto">) => (i.kind === "short" && !i.auto ? "到货少" : ISSUE_KIND_LABEL[i.kind]);
export const DECISION_LABEL: Record<IssueDecision, string> = { pending: "未决定", await: "厂家会补", cancelled: "取消（下次再订）" };
export const ISSUE_STATUS_LABEL: Record<IssueStatus, string> = { open: "未处理", resolved: "已处理", void: "已作废" };
export const DO_ETA_SOURCE_LABEL: Record<string, string> = { shipment: "货柜", do: "DO" };
export const DO_ACTION_LABEL: Record<string, string> = {
  create: "建立", update: "改了内容", confirm: "确认（在路上）", reopen: "退回草稿", cancel: "取消", arrive: "标记到货",
  issue_add: "记厂家问题",
};

async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}

export const podo = {
  outlets: () => rpc<Outlet[]>("ops_po_outlets"),
  suppliers: (company?: string) => rpc<DoSupplier[]>("ops_po_do_suppliers", { p_company: company || null }),
  pos: (company: string, creditor: string) => rpc<DoPo[]>("ops_po_do_pos", { p_company: company, p_creditor_code: creditor }),
  candidates: (company: string, creditor: string, poNos: string[], doId?: number | null) =>
    rpc<{ outlets: Outlet[]; items: Candidate[] }>("ops_po_do_candidates",
      { p_company: company, p_creditor_code: creditor, p_po_nos: poNos, p_do_id: doId ?? null }),
  save: (p: Record<string, unknown>) => rpc<DoFull>("ops_po_do_save", { p }),
  list: (p: Record<string, unknown>) => rpc<DoHeader[]>("ops_po_do_list", { p }),
  get: (id: number) => rpc<DoFull>("ops_po_do_get", { p_id: id }),
  confirm: (id: number) => rpc<DoFull>("ops_po_do_confirm", { p_id: id }),
  reopen: (id: number, reason: string) => rpc<DoFull>("ops_po_do_reopen", { p_id: id, p_reason: reason }),
  cancel: (id: number, reason: string) => rpc<DoHeader>("ops_po_do_cancel", { p_id: id, p_reason: reason }),
  arrive: (id: number, note: string) => rpc<DoHeader>("ops_po_do_arrive", { p_id: id, p_note: note }),
  transit: (p: Record<string, unknown>) => rpc<Transit>("ops_po_transit", { p }),
  issues: (p: Record<string, unknown>) => rpc<Issue[]>("ops_po_issues", { p }),
  issueAdd: (p: Record<string, unknown>) => rpc<Issue>("ops_po_issue_add", { p }),
  issueSet: (ids: number[], action: string, note?: string | null) =>
    rpc<number>("ops_po_issue_set", { p_ids: ids, p_action: action, p_note: note ?? null }),
};

// ------------------------------------------------------------ 档案
const BUCKET = "ops-po";
export const MAX_FILE_MB = 15;
const TYPES: Record<string, string> = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", xls: "application/vnd.ms-excel", csv: "text/csv",
  pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", heic: "image/heic",
  heif: "image/heif",
};
export const FILE_ACCEPT = ".xlsx,.xls,.csv,.pdf,.jpg,.jpeg,.png,.webp,.heic,.heif,image/*";

export function fileExt(name: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(name);
  return m ? m[1].toLowerCase() : "";
}
export const isSheet = (name: string) => ["xlsx", "xls", "csv"].includes(fileExt(name));
export const isImage = (name: string) => ["jpg", "jpeg", "png", "webp", "heic", "heif"].includes(fileExt(name));

function randomId(): string {
  try { return crypto.randomUUID().replace(/-/g, "").slice(0, 10); } catch { return Math.random().toString(36).slice(2, 12); }
}

/** 一张新 DO 的前端代号：断线重按「存草稿」不会多开一张 */
export function newClientKey(): string {
  try { return crypto.randomUUID(); } catch { return `${Date.now()}-${Math.random().toString(36).slice(2)}`; }
}

/** Storage 的路径只收英数字：中文档名换成 _（原档名另外存在 DO 的 files.name） */
function safeName(name: string): string {
  const ext = fileExt(name);
  const base = name.replace(/\.[^.]+$/, "").normalize("NFKD").replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60);
  return `${base || "file"}.${ext}`;
}

/** 手机照片太大就先缩（厂家 DO 的照片之后要给 AI 读：留 2400px） */
async function shrink(file: File): Promise<Blob> {
  if (!["jpg", "jpeg", "png", "webp"].includes(fileExt(file.name)) || file.size < 3 * 1024 * 1024) return file;
  const bmp = await createImageBitmap(file).catch(() => null);
  if (!bmp) return file;
  const scale = Math.min(1, 2400 / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
  const out = await new Promise<Blob | null>((res) => c.toBlob(res, "image/jpeg", 0.85));
  return out && out.size < file.size ? out : file;
}

/** 上传一个厂家 DO 档案，回传要存进 DO 的 {path, name, size, type} */
export async function uploadDoFile(company: string, ym: string, file: File): Promise<DoFile> {
  const ext = fileExt(file.name);
  if (!TYPES[ext]) throw new Error("只能上传 Excel（.xlsx / .xls / .csv）、PDF 或照片。");
  const blob: Blob = await shrink(file);
  const name = blob !== file ? file.name.replace(/\.[^.]+$/, "") + ".jpg" : file.name;
  if (blob.size > MAX_FILE_MB * 1024 * 1024) throw new Error(`档案太大（最多 ${MAX_FILE_MB} MB）。`);
  const type = TYPES[fileExt(name)];
  const path = `${company}/${ym}/${randomId()}-${safeName(name)}`;
  // storage-js 收到 Blob 时用它自己的 type（不看 contentType）：手机的 .csv 是 text/comma-separated-values、
  // 认不得的副档名是空的 → bucket 的允许清单会挡。照副档名重新包一次。
  const body = new Blob([blob], { type });
  const { error } = await supabase.storage.from(BUCKET).upload(path, body, { contentType: type, upsert: false });
  if (error) throw new Error("档案上传失败，请检查网络再试一次。（" + error.message + "）");
  return { path, name, size: blob.size, type };
}

/** 私有档案 → 1 小时有效的网址（不是图片 / PDF 就用原档名下载） */
export async function doFileUrl(f: DoFile): Promise<string> {
  const inline = isImage(f.name) || fileExt(f.name) === "pdf";
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(f.path, 3600, inline ? undefined : { download: f.name });
  if (error || !data) throw new Error("打不开这个档案：" + (error?.message ?? ""));
  return data.signedUrl;
}

/** 先同步开新分页（手机浏览器才不会挡），拿到网址再导过去 */
export async function openDoFile(f: DoFile): Promise<void> {
  const w = window.open("", "_blank");
  try {
    const url = await doFileUrl(f);
    if (w) w.location.href = url; else window.location.href = url;
  } catch (e) {
    w?.close();
    throw e;
  }
}

export async function downloadDoFile(f: DoFile): Promise<Blob> {
  const { data, error } = await supabase.storage.from(BUCKET).download(f.path);
  if (error || !data) throw new Error("读不到这个档案：" + (error?.message ?? ""));
  return data;
}

// ------------------------------------------------------------ 小工具
/** window.confirm / 下载的档案不在画面上，DOM 翻译层翻不到：英文模式时自己先翻 */
export function ui(s: string): string {
  return getLang() === "en" ? tr(s) : s;
}

/** 输入框的数量：空白 = 0；不是数字 = NaN */
export function num(s: string | number | null | undefined): number {
  if (s == null) return 0;
  const t = String(s).trim().replace(/,/g, "");
  if (t === "") return 0;
  return /^\d+(\.\d+)?$/.test(t) ? Number(t) : NaN;
}

/** 串几个代号：中文用「、」，英文用「, 」 */
export function joinList(xs: string[]): string {
  return xs.join(getLang() === "en" ? ", " : "、");
}

/** 资料库的时间（UTC）→ 吉隆坡的日期 */
export function dateKL(ts: string | null | undefined): string {
  if (!ts) return "";
  return ts.length <= 10 ? ts : new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kuala_Lumpur" }).format(new Date(ts));
}

export function fmtSize(n: number | null | undefined): string {
  if (!n) return "";
  return n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}
