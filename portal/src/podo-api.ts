// 厂家到货（厂家 DO / 装箱单）、分到各分店、在路上、厂家问题：资料层（RPC、型别、档案上传）。
// 权限与分店都在 public.ops_po_* 函数里检查；这些函数一律不回传单价 / 金额。
// 档案放 Storage 私有 bucket ops-po，路径 <公司>/<yyyy-mm>/<随机>-<档名>（只有 insert / read policy：不能 upsert，也不删）。
import { supabase } from "./supabase";
import { getLang, tr } from "./i18n";
import type { PoStatus } from "./api";

export type DoStatus = "draft" | "confirmed" | "arrived" | "cancelled";
export type IssueKind = "short" | "over" | "wrong" | "damaged" | "part";
/** 要厂家怎么处理（少发不用：少发看 decision） */
export type IssueRequest = "replace" | "return" | "next" | "keep" | "other";
export type IssueDecision = "pending" | "await" | "cancelled";
export type IssueStatus = "open" | "resolved" | "void";

export interface Outlet { code: string; name: string; short_name: string; company: string; active: boolean }
export interface DoSupplier {
  company: string; creditor_code: string; supplier_name: string; is_china: boolean; po_count: number; open_qty: number;
  last_po_date: string; drafts: number;
  /** 未到 PO 的厂家名称栏里的 CS 编号（代理户口下的中国厂，大写去空白，例 CS028） */
  factories: string[];
}
export interface DoPo {
  po_no: string; po_date: string; days_open: number; status: PoStatus; closed: boolean; eta: string; eta_source: string;
  lines: number; open_qty: number; in_transit: number; remaining: number; outlets: string[];
  /** AutoCount PO 的厂家名称栏（订货员常写 CS 编号与备注）；factory = 里面的 CS 编号 */
  creditor_name: string; factory: string | null;
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
  /** 对上 PO 的行：少发先决定（只存 await / cancelled；确认时套到自动产生的少发） */
  short_decision?: "await" | "cancelled";
  /** 对不上 PO 的行（来错的型号）：true = 收到的是我们的商品、false = 不是我们的产品；request = 要厂家怎么处理 */
  own?: boolean; request?: IssueRequest;
}
/** 开单时记的缺零件 / 其他要补的（确认时变成厂家问题 kind = part） */
export interface DoPart { item_code: string | null; part_name: string; qty: number; request: IssueRequest; note: string }
/** SOP：① 选 PO ② 出货数量 ③ 分配分店 ④ ETA ⑤ 确认（订货部）→ ⑥ 点货（仓库部）→ ⑦ 厂家问题（采购）→ 8 都做完；取消的是 null */
export interface DoSop {
  step: number | null; owner: "purchasing" | "warehouse" | "billing" | null;
  done: { po: boolean; shipped: boolean; alloc: boolean; eta: boolean; confirmed: boolean; received: boolean; decided: boolean };
  /** 这张还没决定的少发 + 缺零件 */ decide_n: number;
  /** 点货产生、开单部还没在 AutoCount 开进货单（GRN）的笔数（第 8 步还有 = 等开单部） */ grn_n?: number;
  /** 草稿从开单起超过 24 小时还没确认 */ draft_overdue: boolean;
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
  sop?: DoSop;
}
export interface Applied { item_code: string; outlet: string; qty: number; po_no: string | null; dtl_key: number | null; line_outlet: string | null }
export interface DoFull extends DoHeader {
  items: DoItem[]; outlets: Outlet[]; candidates: Candidate[]; applied: Applied[]; issues: Issue[];
  /** 开单时记的缺零件（草稿可改；确认后已变成厂家问题） */
  parts?: DoPart[];
  /** 这间公司的主要仓位（总部账套 HQ、JB 账套 JB）：点货后补记来错的货（我们的型号）进这里 */
  main_location?: string;
  /** 点货纪录（仓库点完货才有；旧版直接「标记到货」的是 null） */
  receipt?: Receipt | null;
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
  /** 要厂家怎么处理（少发没有）；part_name = 缺的零件 / 东西（只有 part）；factory = CS 工厂；owed_qty = 厂家还欠 */
  request: IssueRequest | null; part_name: string; factory: string | null; owed_qty: number;
}
/** full = false（分行、门市等不是总部订货 / 仓库「可编辑」的人）：资料库不回厂家、DO 号、PO 号、货柜（都是 null / []） */
export interface TransitRow {
  do_id: number; do_no: string | null; do_date: string | null; company: string | null; creditor_code: string | null;
  supplier_name: string | null; eta: string | null; eta_source: "shipment" | "do" | null; shipment_name: string | null;
  outlet: string; outlet_name: string; item_code: string; description: string; uom: string; qty: number; po_nos: string[];
  confirmed_at: string; can_arrive: boolean;
}
export interface Transit { full: boolean; outlets: { code: string; name: string; short_name: string }[]; rows: TransitRow[] }

// ------------------------------------------------------------ 点货（货到了由仓库点数量）
/** 点完货的件数：到货少 = 出货 − 好货 − 坏货；多到 = 好货 + 坏货 − 出货；来错 = 来错的货合计；
 *  mismatch = 点货前手动记的坏货 + 到货少比点到的缺口多几件（要采购核对）；later = 点完货之后才补记的 */
export interface RecvSummary {
  short: number; damaged: number; over: number; wrong: number;
  mismatch?: number; later?: { damaged: number; short: number; wrong: number };
}
/** 点货清单的一张 DO。看不到厂家的人（ops.sees_supplier = false）：do_no / 厂家 / 货柜是 null、po_nos 是 []。不含价格。 */
export interface RecvRow {
  id: number; company: string; status: DoStatus; do_date: string | null;
  do_no: string | null; supplier_name: string | null; creditor_code: string | null; shipment_name: string | null; po_nos: string[];
  eta: string | null; eta_source: "shipment" | "do" | null; overdue: boolean;
  item_count: number; unmatched_count: number; shipped_total: number;
  /** 这张分到的分店代号（照分店顺序） */
  outlets: string[];
  confirmed_at: string | null; confirmed_by_name: string | null; arrived_at: string | null; arrived_by_name: string | null;
  summary: RecvSummary | null;
}
export interface RecvList { todo: RecvRow[]; done: RecvRow[]; days?: number }
/** 要点的一个型号：出货（应到）与确认时的分配；prior = 这张 DO 已经有的手动问题件数（到货少只算手动记的） */
export interface RecvItem {
  item_code: string; description: string; uom: string; shipped: number; alloc: Record<string, number>;
  prior: { damaged: number; short: number; over: number; wrong: number };
  /** 开单时这行的备注（给仓库看） */ note?: string;
}
export interface ReceiptItem {
  item_code: string; description: string; uom: string; shipped: number; received: number; damaged: number;
  /** 点货的人分给各分店的好货 */ alloc: Record<string, number>;
  /** 确认时的分配 */ planned: Record<string, number>;
  /** 点货前已经手动记的坏货 / 到货少（旧纪录没有） */ prior?: { damaged: number; short: number };
  note: string;
}
export interface ReceiptWrong {
  received_code: string; description: string; expected_code: string | null; qty: number; note: string;
  /** true = 我们的型号（进了 location 仓位的库存）；false = 不是我们的产品 */
  own?: boolean; request?: IssueRequest; location?: string;
}
export interface Receipt { items: ReceiptItem[]; wrong: ReceiptWrong[]; note: string; issue_ids: number[]; move_ids?: number[] }
/** 点货产生的「进货待入 AutoCount」（仓库搬动 kind = receive）：开单部在 AutoCount 开 GRN 后标已输入。
 *  po_no：看不到厂家的人是 null */
export interface RecvMove {
  id: number; item_code: string; description: string; location: string; qty: number; po_no: string | null; outlet: string | null;
  recv_wrong: boolean; status: "pending" | "done" | "cancelled"; ac_doc: string; done_at: string | null; done_by_name: string | null;
  /** 点货时 AutoCount 已经有的进货单号（没有重复算库存） */ pre_grn?: string | null;
  /** 取消原因、点货后补记等 */ note?: string;
}
export interface RecvIssue {
  id: number; kind: IssueKind; item_code: string | null; received_code: string; description: string; qty: number; auto: boolean;
  status: IssueStatus; decision: IssueDecision | null; note: string; from_receipt: boolean;
  /** 点完货之后才补记的 */ after_receipt?: boolean; created_at?: string;
  request?: IssueRequest | null; part_name?: string; owed_qty?: number;
  /** 看不到厂家的人：[] / null */ po_nos?: string[]; factory?: string | null;
  /** 收到的型号是我们的商品（看不到厂家的人：不是我们的型号 received_code 是空的） */ ours?: boolean;
}
export interface RecvFull extends Omit<RecvRow, "outlets"> {
  alloc_outlets: string[];
  /** 这张可以分的分店，照顺序：总部账套四间都有；JB 账套只有 JB */
  outlets: { code: string; name: string; short_name: string; company: string }[];
  remark: string; files: DoFile[]; arrive_note: string;
  receipt: Receipt | null; can_receive: boolean;
  items: RecvItem[];
  /** 确认时 Excel 对不上 PO 的行（已记成发错型号） */
  unmatched: { src_code: string; src_desc: string; shipped: number; expected_code: string | null; note: string;
               own?: boolean | null; request?: IssueRequest | null;
               /** 在 DO 的第几行：点货时带 do_row 回去，跟确认时记的那笔发错型号对上（不重复记） */ row?: number }[];
  issues: RecvIssue[];
  /** 这张点货产生的进货待入 AutoCount */ moves?: RecvMove[];
  /** 来错的货（我们的型号）可以放的仓位（这间公司的仓位 + 主要仓位） */ locations?: string[];
  /** 来错的货预设仓位：总部账套 HQ、JB 账套 JB */ main_location?: string;
}
/** 搜我们的商品（来错的型号「收到的型号」）：只有型号、品名、单位 */
export interface OurItem { item_code: string; description: string; uom: string }

export const DO_STATUS_LABEL: Record<DoStatus, string> = {
  draft: "草稿", confirmed: "在路上", arrived: "已到货", cancelled: "已取消",
};
export const ISSUE_KIND_LABEL: Record<IssueKind, string> = {
  short: "少发", over: "多发", wrong: "发错型号", damaged: "坏货", part: "缺零件",
};
/** 手动记的少发 = 到货少（厂家 DO 写的比实际到的多）；点货记的多发 = 多到（实际到的比厂家 DO 写的多） */
export const issueKindLabel = (i: Pick<Issue, "kind" | "auto">) =>
  (!i.auto && i.kind === "short" ? "到货少" : !i.auto && i.kind === "over" ? "多到" : ISSUE_KIND_LABEL[i.kind]);
export const DECISION_LABEL: Record<IssueDecision, string> = { pending: "未决定", await: "厂家会补", cancelled: "取消（下次再订）" };

/** 要厂家怎么处理：每种问题可以选的（少发没有，看 decision）。第一个是预设 */
const REQUEST_OPTIONS: Partial<Record<IssueKind, IssueRequest[]>> = {
  wrong: ["replace", "return", "next", "keep", "other"],
  part: ["next", "other"],
  damaged: ["replace", "next", "return", "other"],
  over: ["keep", "return", "other"],
};
const REQUEST_TEXT: Record<IssueRequest, string> = {
  replace: "换成正确的型号", return: "退回厂家", next: "下次补上", keep: "我们留下（照价算）", other: "其他（写在备注）",
};
export function requestOptions(kind: IssueKind): IssueRequest[] {
  return REQUEST_OPTIONS[kind] ?? [];
}
/** 「要厂家：…」的文字：来错的型号「下次补正确的」、坏货「换新的」 */
export function requestLabel(kind: IssueKind, r: IssueRequest | null | undefined): string {
  if (!r) return "";
  if (kind === "wrong" && r === "next") return "下次补正确的";
  if (kind === "damaged" && r === "replace") return "换新的";
  return REQUEST_TEXT[r];
}
export const ISSUE_STATUS_LABEL: Record<IssueStatus, string> = { open: "未处理", resolved: "已处理", void: "已作废" };
export const DO_ETA_SOURCE_LABEL: Record<string, string> = { shipment: "货柜", do: "DO" };
export const DO_ACTION_LABEL: Record<string, string> = {
  create: "建立", update: "改了内容", confirm: "确认（在路上）", reopen: "退回草稿", cancel: "取消", arrive: "标记到货",
  receive: "点货（货到了）", issue_add: "记厂家问题",
};
export const SOP_STEPS = ["选 PO", "出货数量", "分配分店", "ETA", "确认", "点货", "厂家问题"];
export const SOP_OWNER_LABEL: Record<string, string> = { purchasing: "等订货部", warehouse: "等仓库部", billing: "等开单部" };

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
  // 货到了一定要点货（ops_po_do_arrive 现在一律回「要先点货」）
  receiveList: (p: Record<string, unknown> = {}) => rpc<RecvList>("ops_po_receive_list", { p }),
  receiveGet: (id: number) => rpc<RecvFull>("ops_po_receive_get", { p_id: id }),
  receive: (p: Record<string, unknown>) => rpc<RecvFull>("ops_po_do_receive", { p }),
  transit: (p: Record<string, unknown>) => rpc<Transit>("ops_po_transit", { p }),
  issues: (p: Record<string, unknown>) => rpc<Issue[]>("ops_po_issues", { p }),
  /** 已点货的 DO：补记坏货 / 到货少会扣还没输入 AutoCount 的进货（stock_left = 扣不到的件数）；补记来错的货（我们的型号）多一笔进货（move_id） */
  issueAdd: (p: Record<string, unknown>) => rpc<Issue & { stock_left?: number; move_id?: number | null }>("ops_po_issue_add", { p }),
  issueSet: (ids: number[], action: string, note?: string | null) =>
    rpc<number>("ops_po_issue_set", { p_ids: ids, p_action: action, p_note: note ?? null }),
  /** 搜我们的商品（型号或品名，最多 20 笔）：订货或仓库「可编辑」；company 空 = 自己分店的公司 */
  itemSearch: (company: string | null, q: string) => rpc<OurItem[]>("ops_po_item_search", { p_company: company || null, p_q: q }),
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
