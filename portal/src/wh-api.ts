// 仓库模块的资料层：RPC 与型别。权限、盲盘（一般员工看不到系统数量）都在资料库里处理。
import { supabase } from "./supabase";

export type MoveKind = "transfer" | "defect" | "display" | "sample" | "return" | "writeoff" | "other";
export type MoveStatus = "pending" | "done" | "cancelled";
export type CountStatus = "match" | "variance" | "superseded" | "adjusted" | "ignored";

export interface WhLocation { company: string; code: string; name: string; counting: boolean; daily_target: number; sort: number }
export interface WhMeta {
  level: "view" | "edit" | "approve";
  companies: string[];
  locations: WhLocation[];
  synced: Record<string, string | null>;
}
export interface FoundItem { item_code: string; description: string; uom: string; item_group: string; active: boolean; qty: number }
export interface Move {
  id: number; company: string; item_code: string; description: string; uom: string; qty: number; kind: MoveKind;
  from_loc: string | null; to_loc: string | null; note: string; photo: string | null; status: MoveStatus; ac_doc: string;
  created_by: number; created_by_name: string; created_at: string; done_by_name: string | null; done_at: string | null;
}
export interface Count {
  id: number; company: string; location: string; item_code: string; description: string; uom: string; qty: number;
  attempt: number; status: CountStatus; note: string; counted_at: string; count_date: string; counted_by_name: string;
  reviewed_by_name: string | null; reviewed_at: string | null; review_note: string; ac_doc: string;
  system_qty?: number; pending_qty?: number; expected_qty?: number; diff?: number; unit_cost?: number | null;
  diff_value?: number; synced_at?: string | null;
}
export interface ItemDetail {
  found: boolean;
  scanned?: string;
  company: string; item_code: string; description: string; uom: string; item_group: string; item_type: string;
  active: boolean; synced_at: string | null;
  stock: { location: string; qty: number; pending: number; unit_cost?: number | null }[];
  open_orders: { doc_no: string; doc_date: string; customer: string; qty: number }[];
  incoming: { po_no: string; po_date: string; supplier: string; location: string; qty: number }[];
  moves: Move[];
  counts: Count[];
  barcodes: string[];
}
export interface CountList {
  company: string; location: string; date: string; synced_at: string | null;
  done_today: Count[];
  recount: string[];
  todo: { item_code: string; description: string; uom: string; item_group: string }[];
  progress: { items: number; counted_30d: number };
}

export const MOVE_KIND_LABEL: Record<MoveKind, string> = {
  transfer: "调仓", defect: "报坏（搬去坏货仓）", display: "搬去展示", sample: "拿去当样品",
  return: "客户退货入仓", writeoff: "报废 / 遗失", other: "其他",
};
export const MOVE_KIND_SHORT: Record<MoveKind, string> = {
  transfer: "调仓", defect: "报坏", display: "展示", sample: "样品", return: "退货", writeoff: "报废", other: "其他",
};
export const MOVE_STATUS_LABEL: Record<MoveStatus, string> = { pending: "待输入 AutoCount", done: "已输入", cancelled: "已取消" };
export const COUNT_STATUS_LABEL: Record<CountStatus, string> = {
  match: "相符", variance: "有差异", superseded: "已重盘", adjusted: "已调整", ignored: "不调整",
};

async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}

export const wh = {
  meta: () => rpc<WhMeta>("ops_wh_meta"),
  find: (company: string, q: string) => rpc<FoundItem[]>("ops_wh_find", { p_company: company, p_q: q }),
  item: (company: string, code: string) => rpc<ItemDetail>("ops_wh_item", { p_company: company, p_code: code }),
  bind: (company: string, barcode: string, itemCode: string) =>
    rpc<void>("ops_wh_barcode_bind", { p_company: company, p_barcode: barcode, p_item_code: itemCode }),
  saveMove: (p: Record<string, unknown>) => rpc<Move>("ops_wh_move_save", { p }),
  moves: (p: Record<string, unknown>) => rpc<Move[]>("ops_wh_moves", { p }),
  markMoves: (ids: number[], action: "done" | "cancelled", acDoc = "") =>
    rpc<number>("ops_wh_move_mark", { p_ids: ids, p_action: action, p_ac_doc: acDoc }),
  countList: (company: string, location: string, limit?: number) =>
    rpc<CountList>("ops_wh_count_list", { p_company: company, p_location: location, p_limit: limit ?? null }),
  saveCount: (p: Record<string, unknown>) =>
    rpc<{ id: number; item_code: string; attempt: number; result: "match" | "recount" | "variance" }>("ops_wh_count_save", { p }),
  counts: (p: Record<string, unknown>) => rpc<Count[]>("ops_wh_counts", { p }),
  review: (ids: number[], action: "adjusted" | "ignored" | "recount", acDoc = "", note = "") =>
    rpc<number>("ops_wh_count_review", { p_ids: ids, p_action: action, p_ac_doc: acDoc, p_note: note }),
  saveLocation: (p: Record<string, unknown>) => rpc<void>("ops_wh_location_save", { p }),
  items: (company: string, codes: string[]) =>
    rpc<{ item_code: string; description: string; uom: string }[]>("ops_wh_items", { p_company: company, p_codes: codes }),
  locationItems: (company: string, location: string) =>
    rpc<{ item_code: string; description: string; uom: string; qty: number }[]>("ops_wh_location_items",
      { p_company: company, p_location: location }),
};

export function qtyLabel(n: number | string | null | undefined): string {
  if (n == null) return "—";
  const v = Number(n);
  return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

const kl = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kuala_Lumpur", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
/** 「10-03 18:05」（马来西亚时间） */
export function whenLabel(ts: string | null | undefined): string {
  if (!ts) return "";
  const p = Object.fromEntries(kl.formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  return `${p.month}-${p.day} ${p.hour}:${p.minute}`;
}
