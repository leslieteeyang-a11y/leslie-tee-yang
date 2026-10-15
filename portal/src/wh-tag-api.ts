// 仓库 · 商品标签、商品照片、入库箱贴（批次）、打印纪录、库存总表下载的资料层（2026-10-15）。
// 权限都在资料库：标标签 = 订货「可编辑」或仓库「可审批」；拍照 = 仓库「可编辑」；建批次（印箱贴）= 仓库或订货「可编辑」；
// 厂家 / 厂家 DO 号只给看得到厂家的人；成本只给仓库「可审批」。
import { supabase } from "./supabase";
import { getLang, tr } from "./i18n";
import { StockPage, StockRow } from "./rpl-api";

export type TagColor = "red" | "amber" | "green" | "blue" | "purple" | "gray";
export const TAG_COLORS: TagColor[] = ["red", "amber", "green", "blue", "purple", "gray"];
export const TAG_COLOR_LABEL: Record<TagColor, string> = { red: "红", amber: "橙", green: "绿", blue: "蓝", purple: "紫", gray: "灰" };

export interface Tag {
  name: string; color: TagColor; kind: "manual" | "auto"; rule: "hot" | "slow" | null;
  active: boolean; sort: number; /** 这间分店有几个商品 */ items: number;
}
export interface TagList { company: string; can_edit: boolean; tags: Tag[] }
/** {商品代号: [标签名…]}（含自动标签；没有标签的商品不出现） */
export type TagMap = Record<string, string[]>;

export interface Photo { id: number; item_code: string; path: string; created_at: string; by_name: string | null }

export interface StockTagRow extends StockRow { tags?: string[] }
export interface StockTagPage extends StockPage { tag: string | null; rows: StockTagRow[] }
export interface StockExport {
  company: string; show_cost: boolean; total: number; capped: boolean; tag: string | null; synced_at: string | null;
  rows: (StockTagRow & { item_total: number })[];
}

export interface Lot {
  lot_no: string; company: string; item_code: string; description: string; uom: string | null;
  qty: number; boxes: number; outlet: string | null; outlet_name: string | null; location: string | null;
  move_id: number | null; do_id: number | null; note: string;
  received_at: string | null; received_by_name: string | null; created_at: string; created_by_name: string | null;
  /** 看不到厂家的人是 null */ do_no: string | null; supplier_name: string | null; po_no: string | null;
  /** 建议货架（代号） */ bin: string | null;
  /** 印过几张 */ printed: number;
}
export interface LotDetail extends Lot {
  can_print: boolean; move_status: "pending" | "done" | "cancelled" | null; move_ac_doc: string | null;
  expected: number; shelved: number;
  bins: { id: number; code: string; barcode: string; qty: number }[];
  prints: { id: number; copies: number; size: string; created_at: string; by_name: string | null }[];
}
export interface LotMove {
  move_id: number; item_code: string; description: string; uom: string | null; qty: number;
  outlet: string | null; outlet_name: string | null; location: string; status: "pending" | "done";
  recv_wrong: boolean; created_at: string; do_id: number; arrived_at: string;
  do_no: string | null; supplier_name: string | null; lot_no: string | null; boxes: number | null; printed: number;
}
export interface LotMoves { company: string; do_id: number | null; days: number; can_create: boolean; rows: LotMove[] }
export interface LotNew { move_id?: number; item?: string; qty?: number; location?: string; outlet?: string; boxes: number; note?: string }

export type PrintKind = "lot" | "item" | "bin";
export interface PrintRow {
  id: number; kind: PrintKind; lot_no: string | null; item_code: string | null; description: string | null;
  bin_id: number | null; bin_code: string | null; bin_location: string | null;
  copies: number; size: string; created_at: string; by_name: string | null;
  lot_qty: number | null; lot_boxes: number | null; lot_outlet: string | null; lot_location: string | null;
}
export interface PrintPage { company: string; page: number; page_size: number; total: number; can_lot: boolean; rows: PrintRow[] }
export interface PrintLog { kind: PrintKind; lot_no?: string; item_code?: string; bin_id?: number; copies: number; size: string }

async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}

export const whTag = {
  tags: (company: string) => rpc<TagList>("ops_wh_tags", { p: { company } }),
  saveTag: (p: { name: string; color?: TagColor; active?: boolean; sort?: number }) => rpc<Tag>("ops_wh_tag_save", { p }),
  setItemTag: (company: string, items: string[], tag: string, on: boolean) =>
    rpc<{ changed: number; tags: TagMap }>("ops_wh_item_tag_set", { p: { company, items, tag, on } }),
  itemTags: (company: string, items: string[]) => rpc<TagMap>("ops_wh_item_tags", { p: { company, items } }),
  /** 库存总表（多 tag 筛选、每列 tags） */
  stock: (p: { company: string; q?: string; neg_only?: boolean; tag?: string; page?: number }) => rpc<StockTagPage>("ops_wh_stock", { p }),
  stockExport: (p: { company: string; q: string; neg_only: boolean; tag: string }) => rpc<StockExport>("ops_wh_stock_export", { p }),

  photos: (company: string, codes: string[]) => rpc<Record<string, Photo>>("ops_wh_item_photos", { p_company: company, p_codes: codes }),
  setPhoto: (company: string, item: string, path: string) =>
    rpc<{ item_code: string; photo: Photo | null }>("ops_wh_item_photo_set", { p: { company, item, path } }),
  removePhoto: (company: string, item: string) =>
    rpc<{ item_code: string; photo: null }>("ops_wh_item_photo_set", { p: { company, item, remove: true } }),

  createLots: (company: string, lots: LotNew[]) => rpc<{ lots: Lot[] }>("ops_wh_lot_create", { p: { company, lots } }),
  lot: (lotNo: string) => rpc<LotDetail>("ops_wh_lot_get", { p_lot_no: lotNo }),
  lotMoves: (p: { company: string; do_id?: number | null; days?: number; q?: string }) => rpc<LotMoves>("ops_wh_lot_moves", { p }),
  logPrints: (company: string, rows: PrintLog[]) => rpc<{ logged: number }>("ops_wh_label_log", { p: { company, rows } }),
  prints: (p: { company: string; kind?: string; q?: string; from?: string; to?: string; page?: number }) =>
    rpc<PrintPage>("ops_wh_label_prints", { p }),
};

// ------------------------------------------------------------ 照片：Storage 私有 bucket ops-wh
const BUCKET = "ops-wh";
/** 路径 items/<公司>/<商品代号（英数字 . _ - 以外换成 _）>/<随机>.jpg（与资料库 ops.wh_photo_dir 同规则） */
export function photoPath(company: string, item: string): string {
  const safe = item.replace(/[^A-Za-z0-9._-]/g, "_");
  const rnd = Math.random().toString(36).slice(2, 10);
  return `items/${company}/${safe}/${Date.now().toString(36)}-${rnd}.jpg`;
}

/** 手机照片很大：缩到最长边 800px、JPEG 0.75（约 60～120 KB） */
export async function shrinkPhoto(file: Blob, max = 800, quality = 0.75): Promise<Blob> {
  const bmp = await createImageBitmap(file).catch(() => null);
  if (!bmp) throw new Error("读不到这张照片，请换一张（JPG / PNG）。");
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * k);
  c.height = Math.round(bmp.height * k);
  c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
  return await new Promise((ok, bad) => c.toBlob((b) => (b ? ok(b) : bad(new Error("照片压缩失败，请再试一次。"))), "image/jpeg", quality));
}

export async function uploadPhoto(company: string, item: string, file: Blob): Promise<string> {
  const path = photoPath(company, item);
  const { error } = await supabase.storage.from(BUCKET).upload(path, file, { contentType: "image/jpeg", upsert: false });
  if (error) throw new Error(`照片上传失败：${error.message}`);
  return path;
}

const urlCache = new Map<string, { url: string; exp: number }>();
/** 私有照片的暂时网址（1 小时；50 分钟内重用） */
export async function photoUrl(path: string): Promise<string> {
  const hit = urlCache.get(path);
  if (hit && hit.exp > Date.now()) return hit.url;
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, 3600);
  if (error || !data) throw new Error(error?.message || "照片读不到。");
  urlCache.set(path, { url: data.signedUrl, exp: Date.now() + 50 * 60 * 1000 });
  return data.signedUrl;
}

// ------------------------------------------------------------ 批次号 / 扫到箱贴 QR
/** 扫到的东西是不是箱贴（QR 网址 …#/warehouse/lot/L251015-0001 或批次号本身）→ 批次号；不是回 null */
export function lotFromScan(code: string): string | null {
  const s = code.trim();
  const m = /#\/warehouse\/lot\/(L\d{6}-\d+)/i.exec(s) || /^(L\d{6}-\d+)$/i.exec(s);
  return m ? m[1].toUpperCase() : null;
}
/** 箱贴 QR 的内容：营运系统的批次页（扫了要先登入） */
export function lotUrl(lotNo: string): string {
  return `${window.location.origin}${window.location.pathname}#/warehouse/lot/${lotNo}`;
}

const klDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kuala_Lumpur", year: "numeric", month: "2-digit", day: "2-digit" });
/** 马来西亚日期 YYYY-MM-DD */
export function dateKL(ts: string | number | Date | null | undefined): string {
  if (ts == null || ts === "") return "";
  return klDate.format(new Date(ts));
}

/** window.confirm / 下载档名不经过 DOM 翻译层：英文模式自己翻 */
export function ui(s: string): string {
  return getLang() === "en" ? tr(s) : s;
}
