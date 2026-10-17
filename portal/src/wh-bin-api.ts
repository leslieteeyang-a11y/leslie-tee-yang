// 货架（仓 / 区 / 货架 / 层）与货架数量的资料层（2026-10-15）。「仓」= AutoCount 仓位（HQ、SRGADING…）。
// 货架帐是营运系统自己记的：上架 +、拿下 −、货架之间移、主管改数、Excel 带入；之后的备货、盘点单也会改它。
// 应有 = AutoCount 库存 + 还没输入 AutoCount 的搬动；未上架 = 应有 − 货架合计；货架合计 > 应有 = 对不上（要去数）。
import { supabase } from "./supabase";

export interface Bin {
  id: number; location: string; zone: string; shelf: string; level: string;
  /** 区-货架-层（大写），同一仓位内唯一，例 A-R3-2 */ code: string;
  note: string; active: boolean; sort: number;
  /** 货架条码内容（Code 128）：BIN:<id> */ barcode: string;
}
export interface BinRow extends Bin { items: number; qty: number; updated_at: string | null }
export interface BinSummary { location: string; bins: number; items_shelved: number; items_over: number; items_unshelved: number }
export interface BinList { company: string; bins: BinRow[]; summary: BinSummary[] }

export type BinLogKind = "putaway" | "take" | "move" | "adjust" | "import" | "count" | "pick" | "reverse";
export interface BinLog {
  id: number; item_code?: string; bin_id?: number; /** 「HQ · A-R1-2」 */ bin?: string;
  delta: number; qty_after: number; kind: BinLogKind; ref_type: string | null; ref_id: number | null;
  note: string; created_at: string; reversed: boolean; by_name: string | null;
}
export interface BinItem { item_code: string; description: string; uom: string | null; qty: number; updated_at: string; updated_by_name: string | null }
export interface BinDetail extends Bin { items: BinItem[]; log: BinLog[] }

export interface ItemBinLoc {
  location: string;
  /** AutoCount 库存 */ ac_qty: number;
  /** 还没输入 AutoCount 的搬动（进 + / 出 −） */ pending: number;
  /** 已开 DO、还没备的（AutoCount 开 DO 就扣，货还在货架上；只算在主要仓位），已经算进 expected */ do_unpicked: number;
  expected: number; shelved: number; unshelved: number;
  /** 这个仓位有没有建货架 */ has_bins: boolean;
  /** qty = 0 的 = 平常放这里（上架时建议） */ bins: (Bin & { qty: number; updated_at: string })[];
}
export interface ItemBins { item_code: string; description: string; uom: string | null; locations: ItemBinLoc[]; log: BinLog[] }

export type BinOpKind = "putaway" | "take" | "move" | "adjust";
export interface BinOp {
  kind: BinOpKind; item: string; qty: number;
  /** putaway / take / adjust 用 bin；move 用 from_bin + to_bin。可以是 BIN:<id> 或代号 */
  bin?: string; from_bin?: string; to_bin?: string;
  /** 有给就只在这个仓位找货架代号 */ location?: string;
  note?: string;
}
export interface BinOpResult {
  ok: boolean; item_code?: string; location?: string; expected: number; shelved: number; over?: boolean;
  /** 上架 / 改数后货架合计会比应有多：没存，问使用者确定后带 confirm: true 再送一次 */ need_confirm?: boolean;
  /** 这个动作的编号（撤销用 bins.undo） */ ref_id?: number;
}
export interface BinBatchResult {
  ok: boolean; rows?: number; need_confirm?: boolean;
  over: { row: number; item_code: string; location: string; expected: number; shelved: number }[];
}
export interface BinImportRow { item: string; qty: number; bin?: string; zone?: string; shelf?: string; level?: string }
export interface BinImportResult {
  ok: boolean; saved: boolean; errors: number; new_bins: number;
  rows: { row: number; ok: boolean; item_code?: string; bin?: string; qty?: number; error?: string }[];
}
export type ReconFilter = "over" | "unshelved" | "all";
export interface ReconRow {
  item_code: string; description: string; uom: string | null; ac_qty: number; pending: number;
  /** 已开 DO 还没备（已经算进 expected） */ do_unpicked: number; expected: number;
  shelved: number; n_bins: number;
}
export interface ReconPage {
  company: string; location: string; filter: ReconFilter; page: number; page_size: number; total: number;
  counts: { over: number; unshelved: number; shelved: number; items: number }; synced_at: string | null; rows: ReconRow[];
}

/** 地图：一个方块 = 同一区同一货架的所有层；layout.shelves 的 key 是「区::货架」 */
export interface MapLevel { bin_id: number; level: string; code: string; items: number; qty: number }
export interface MapShelf { key: string; zone: string; shelf: string; levels: MapLevel[]; items: number; qty: number }
export interface MapRect { x: number; y: number; w: number; h: number }
export interface MapLayout { shelves?: Record<string, MapRect>; [k: string]: unknown }
export interface MapData {
  company: string; location: string | null; can_edit: boolean;
  locations: { location: string; shelves: number }[];
  layout: MapLayout; updated_at: string | null; shelves: MapShelf[];
}
export interface MapShelfDetail {
  location: string; zone: string; shelf: string;
  levels: (Bin & { items: { item_code: string; description: string; uom: string | null; qty: number }[] })[];
}
export interface MapFind { item_code: string; description: string; uom: string | null; bins: (Bin & { qty: number })[] }

async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}

export const bins = {
  list: (company: string, location?: string, includeInactive = false) =>
    rpc<BinList>("ops_wh_bins", { p: { company, location: location ?? null, include_inactive: includeInactive } }),
  /** 建 / 改货架（可审批）；有 id = 改 */
  save: (p: { id?: number; company: string; location: string; zone?: string; shelf: string; level?: string; note?: string; active?: boolean; sort?: number }) =>
    rpc<Bin>("ops_wh_bin_save", { p }),
  /** 一次建很多（可审批）：shelves × levels；levels 空 = 不分层 */
  bulk: (p: { company: string; location: string; zone?: string; shelves: string[]; levels?: string[] }) =>
    rpc<{ created: number; existed: number }>("ops_wh_bin_bulk", { p }),
  get: (company: string, bin: string, location?: string) =>
    rpc<BinDetail>("ops_wh_bin_get", { p: { company, bin, location: location ?? null } }),
  item: (company: string, item: string) => rpc<ItemBins>("ops_wh_item_bins", { p: { company, item } }),
  op: (company: string, op: BinOp, confirm = false) => rpc<BinOpResult>("ops_wh_bin_op", { p: { company, ...op, confirm } }),
  /** 撤销自己做的一个货架动作（照纪录反向冲回，不会盖掉别人后来的变动；改数的撤销要可审批）。refId = op 回传的 ref_id */
  undo: (company: string, refId: number) =>
    rpc<{ ok: boolean; reversed: number }>("ops_wh_bin_undo", { p_company: company, p_ref_id: refId }),
  batch: (company: string, ops: BinOp[], confirm = false) => rpc<BinBatchResult>("ops_wh_bin_batch", { p: { company, ops, confirm } }),
  /** Excel 带入（可审批）：把货架数量「改成」表上的数；dry_run = 只检查 */
  import: (company: string, location: string, rows: BinImportRow[], createBins: boolean, dryRun: boolean) =>
    rpc<BinImportResult>("ops_wh_bin_import", { p: { company, location, rows, create_bins: createBins, dry_run: dryRun } }),
  recon: (p: { company: string; location: string; filter: ReconFilter; q?: string; page?: number }) =>
    rpc<ReconPage>("ops_wh_bin_recon", { p }),
  map: (company: string, location?: string | null) => rpc<MapData>("ops_wh_map_get", { p: { company, location: location ?? null } }),
  mapShelf: (company: string, location: string, zone: string, shelf: string) =>
    rpc<MapShelfDetail>("ops_wh_map_shelf", { p: { company, location, zone, shelf } }),
  mapFind: (company: string, q: string, location?: string | null) =>
    rpc<MapFind[]>("ops_wh_map_find", { p: { company, q, location: location ?? null } }),
  /** 存地图排版（可审批） */
  mapSave: (company: string, location: string, layout: MapLayout) =>
    rpc<{ ok: boolean; updated_at: string }>("ops_wh_map_save", { p: { company, location, layout } }),
};

export const BIN_LOG_LABEL: Record<BinLogKind, string> = {
  putaway: "上架", take: "从货架拿下", move: "移货架", adjust: "主管改数", import: "Excel 带入", count: "盘点", pick: "备货", reverse: "冲回",
};

/** 「HQ · A-R3-2」 */
export function binLabel(b: { location: string; code: string }): string {
  return `${b.location} · ${b.code}`;
}
/** 扫到的是货架条码？（BIN:123） */
export function isBinCode(s: string): boolean {
  return /^BIN:\d{1,12}$/i.test(s.trim());
}
