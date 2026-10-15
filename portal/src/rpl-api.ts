// 从 BI 搬进来的四个分页（2026-10-16）的资料层：补货建议、供应商交期（订货与 ETA 模块）、库存总表、滞销品（仓库模块）。
// 权限与隐私（看不到厂家的人没有供应商 / 厂号 / PO 号，看不到单价的人没有上次单价，看不到成本的人没有成本）都在资料库函数里处理，
// 这里只负责呼叫与型别。资料是 AutoCount 每天同步进 BI 的数字，不是即时的。
import { supabase } from "./supabase";

export type RplLevel = "view" | "edit" | "approve";
export interface CsCode { cs_code: string; items: number; loaded10: number; loaded30: number; loaded100: number }
export interface DueSupplier { creditor_code: string; name: string; days_since_po: number | null; order_cycle_days: number | null }
export interface RplMeta {
  company: string; level: RplLevel; can_edit: boolean; prices: boolean; supplier: boolean; companies: string[];
  synced_at: string | null; cs_codes: CsCode[]; due_suppliers: DueSupplier[];
}
export type Urgency = "out" | "late" | "now" | "ok";
export interface RplRow {
  item_code: string; description: string; item_group: string | null; base_uom: string | null;
  q90: number; q365: number; q90_branch_excl: number; q30: number; q90_ly: number; last_sale: string | null;
  daily_avg: number; daily_year: number; daily_ly: number; order_rate: number;
  on_hand: number; jb_reserved: number; owed_branch: number; by_loc: string | null;
  transit_qty: number; transit_eta: string | null; transit_pos: string | null;
  /** 看不到厂家的人：supplier_code / supplier_name / last_po_name / cs_code / transit_pos 是 null */
  supplier_code: string | null; supplier_name: string | null; last_po_name: string | null; cs_code: string | null;
  /** 看不到进货单价的人是 null */
  last_price: number | null;
  last_po_date: string | null; po_24m: number | null; min_order_qty: number | null; pack_size: number | null;
  exclude: boolean; item_note: string | null; last_receipt_date: string | null; item_type: string | null;
  action_id: number | null; action: string | null; action_qty: number | null; until_date: string | null;
  action_note: string | null; action_by: string | null; action_at: string | null; action_status: "skip" | "ordered" | null;
  is_china: boolean; lead_days: number; safety_days: number; cover_days: number;
  days_left: number | null; days_left_incl_transit: number | null; reorder_days: number; raw_qty: number;
  branch_short: boolean; need_order: boolean; urgency: Urgency; est_out_date: string; suggest_qty: number; fill_candidate: boolean;
}
export interface RplRows { company: string; min_q: number; cs_code: string | null; total: number; capped: boolean; rows: RplRow[] }
export interface SupplierRow {
  creditor_code: string; name: string; currency: string | null; is_active: boolean | null; po_name: string | null;
  po_24m: number | null; last_po: string | null; n_rcv: number | null; hist_lead_days: number | null;
  is_china: boolean; lead_days: number; safety_days: number; cover_days: number;
  lead_override: number | null; safety_override: number | null; cover_override: number | null; china_override: boolean | null;
  note: string | null; updated_by: string | null; updated_at: string | null;
  order_cycle_days: number | null; order_due: boolean | null; days_since_po: number | null; short_pct: number | null;
}
export interface BrandRow { item_type: string; item_count: number; active_count: number; supplier_code: string | null; supplier_name: string | null; note: string | null }
export interface Suppliers { company: string; can_edit: boolean; suppliers: SupplierRow[]; brands: BrandRow[] }
export interface StockRow {
  item_code: string; description: string; item_group: string | null; uom: string | null; location: string; qty: number;
  /** 仓库「可审批」才有 */ total_cost: number | null; price2: number | null; price3: number | null; price4: number | null;
  /** 这个商品所有仓位的合计（20261016c 起） */ item_total?: number | null;
}
export interface StockPage { company: string; show_cost: boolean; page: number; page_size: number; total: number; neg_total: number; synced_at: string | null; rows: StockRow[] }
export interface SlowRow {
  item_code: string; description: string; item_group: string | null; last_receipt_date: string; months_since: number;
  on_hand: number; stock_value: number | null; sold_since: number;
}
export interface SlowPage { company: string; show_cost: boolean; page: number; page_size: number; total: number; rows: SlowRow[] }

export const URGENCY_LABEL: Record<Urgency, string> = { out: "已断货", late: "来不及", now: "该下单", ok: "正常" };

async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}

export const rpl = {
  meta: (company: string) => rpc<RplMeta>("ops_rpl_meta", { p_company: company }),
  rows: (p: { company: string; min_q: number; cs_code?: string }) => rpc<RplRows>("ops_rpl_rows", { p }),
  /** ordered（已下单，qty = 订了几件）/ skip（暂不订到 until_date）/ note（留言） */
  action: (p: { company: string; item_code: string; action: "ordered" | "skip" | "note"; qty?: number | null; until_date?: string | null; note?: string }) =>
    rpc<number>("ops_rpl_action", { p }),
  undo: (id: number) => rpc<number>("ops_rpl_action_undo", { p_id: id }),
  saveItem: (p: Record<string, unknown>) => rpc<void>("ops_rpl_item_setting_save", { p }),
  suppliers: (company: string) => rpc<Suppliers>("ops_rpl_suppliers", { p_company: company }),
  saveSupplier: (p: Record<string, unknown>) => rpc<void>("ops_rpl_supplier_save", { p }),
  saveBrand: (p: { company: string; item_type: string; supplier_code: string }) => rpc<void>("ops_rpl_brand_supplier_save", { p }),
  stock: (p: { company: string; q?: string; neg_only?: boolean; page?: number }) => rpc<StockPage>("ops_wh_stock", { p }),
  slow: (p: { company: string; min_months: number; max_months?: number; page?: number }) => rpc<SlowPage>("ops_wh_slow", { p }),
};

/** 今天 + n 天（YYYY-MM-DD，马来西亚时间） */
export function plusDays(n: number): string {
  const d = new Date(Date.now() + n * 86400000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kuala_Lumpur" }).format(d);
}
