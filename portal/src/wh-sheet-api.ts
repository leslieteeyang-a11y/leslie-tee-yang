// 盘点单 + 按货架盘 + 盘点统计的资料层（2026-10-15）。函数在 migration 20261017c_ops_wh_count_sheet.sql。
// 盲盘：盘点画面只拿货架名字、盘点单只拿结果（相符 / 要再数 / 差异），系统数量只给仓库「可审批」。
import { supabase } from "./supabase";

export type SheetScope = "location" | "bins" | "items";
export type SheetStatus = "open" | "closed" | "cancelled";
/** 一行的结果：todo 未盘 / recount 要再数 / match 相符 / variance 差异 / adjusted 已调整 / ignored 不调整 */
export type LineStatus = "todo" | "recount" | "match" | "variance" | "adjusted" | "ignored";

export interface SheetPerson { id: number; name: string; /** 盘了几项 */ n: number }
export interface Sheet {
  id: number; company: string; title: string; location: string; scope: SheetScope;
  /** scope = bins 时选的货架代号 */ bins: string[];
  due_date: string | null; note: string; status: SheetStatus; cancel_reason: string;
  overdue: boolean; /** 指派给我 */ mine: boolean;
  created_by_name: string | null; created_at: string; closed_by_name: string | null; closed_at: string | null;
  total: number; done: number; recount: number; variance: number; todo: number;
  assignees: SheetPerson[]; /** 没被指派、也帮忙盘了的人 */ helpers: SheetPerson[];
}
export interface SheetLine {
  item_code: string; description: string | null; uom: string | null;
  /** 这个商品在这个仓位的货架（走一圈的顺序） */ bins: string[];
  status: LineStatus; count_id: number | null; counted_at: string | null; counted_by_name: string | null;
  /** 只有仓库「可审批」才有：盘到几件、应有、差额；成本差额只给老板（20261019b） */
  qty?: number; expected?: number; diff?: number; diff_value?: number | null;
}
export interface SheetDetail extends Sheet { can_manage: boolean; lines: SheetLine[] }

export interface CountBinsInfo {
  item_code: string; location: string; description: string | null; uom: string | null;
  /** 这个商品在这个仓位有货架帐的货架（只有名字 = 盲盘） */ bins: { id: number; code: string }[];
  /** 这个仓位所有货架（「加一个货架」用） */ all_bins: { id: number; code: string }[];
  /** 今天第一次数的跟系统不一样，这次是再数 */ recount: boolean;
  /** 开着、有这个商品的盘点单（存的时候会挂上去） */ sheet: { id: number; title: string } | null;
  /** 已开 DO 还没备的件数（AutoCount 已经扣了、货可能还在架上） */ do_unpicked: number;
}
export type CountResult = "match" | "recount" | "variance";
export interface CountSaveResult {
  id: number; item_code: string; attempt: number; result: CountResult; total: number;
  /** 改了几个货架的数量（相符 / 差异才改） */ bins_set: number; sheet_id: number | null; sheet_title: string | null;
}
export interface SheetStaff { id: number; name: string; department: string; department_name: string | null; role: string }
export interface SheetHome { id: number; company: string; title: string; location: string; due_date: string | null; overdue: boolean; total: number; left: number }

export interface CountStats {
  /** 看得到差异金额（成本）= 老板（20261019b）；其他人金额都是 0 / null，画面不显示 */
  company: string; days: number; location: string | null; today: string; show_cost?: boolean;
  summary: {
    counts: number; items: number; match: number; variance: number; waiting: number; adjusted: number; ignored: number;
    /** 差异金额（成本）：净额（负 = 少了）与绝对值合计 */ value_net: number; value_abs: number; sheets: number;
  };
  top: { item_code: string; description: string | null; uom: string | null; times: number; units: number; abs_units: number; value: number | null; abs_value: number | null; last: string }[];
  people: { id: number; name: string; counts: number; variance: number; value_abs: number }[];
  months: { month: string; counts: number; variance: number; value_net: number; value_abs: number }[];
}

async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}

export const sheets = {
  /** 盘点画面：这个商品在这个仓位的货架（只有名字） */
  countBins: (company: string, location: string, item: string) =>
    rpc<CountBinsInfo>("ops_wh_count_bins", { p: { company, location, item } }),
  /** 盘点（每日与盘点单共用）。bins 每格都要填（没有就 0）；loose = 其他地方 / 地上 */
  save: (p: { company: string; location: string; item_code: string; bins: { bin: number; qty: number }[]; loose: number; note: string; sheet_id?: number | null }) =>
    rpc<CountSaveResult>("ops_wh_count_save_bins", { p }),
  list: (company: string, status: "open" | "done" | "all", mine = false) =>
    rpc<Sheet[]>("ops_wh_sheets", { p: { company, status, mine } }),
  get: (id: number) => rpc<SheetDetail>("ops_wh_sheet_get", { p: { id } }),
  /** 可以指派的人（可审批） */
  staff: (company: string) => rpc<SheetStaff[]>("ops_wh_sheet_staff", { p_company: company }),
  create: (p: { company: string; title: string; location: string; scope: SheetScope; bins?: number[]; items?: string[];
                assignees: number[]; due_date?: string | null; note?: string }) => rpc<Sheet>("ops_wh_sheet_create", { p }),
  update: (p: { id: number; title?: string; due_date?: string | null; note?: string; assignees?: number[] }) =>
    rpc<Sheet>("ops_wh_sheet_update", { p }),
  close: (id: number) => rpc<Sheet>("ops_wh_sheet_close", { p: { id } }),
  cancel: (id: number, reason: string) => rpc<Sheet>("ops_wh_sheet_cancel", { p: { id, reason } }),
  /** 指派给我、还开着的盘点单（首页提醒用） */
  home: () => rpc<SheetHome[]>("ops_wh_sheet_home"),
  stats: (company: string, days: 30 | 90 | 180, location?: string) =>
    rpc<CountStats>("ops_wh_count_stats", { p: { company, days, location: location || null } }),
};

export const SCOPE_LABEL: Record<SheetScope, string> = { location: "整个仓位", bins: "选几个货架", items: "指定商品" };
export const SHEET_STATUS_LABEL: Record<SheetStatus, string> = { open: "进行中", closed: "已结单", cancelled: "已取消" };
export const LINE_STATUS_LABEL: Record<LineStatus, string> = {
  todo: "未盘", recount: "要再数", match: "相符", variance: "差异", adjusted: "差异 · 已调整", ignored: "差异 · 不调整",
};
/** 结果小标签的 class（沿用 style.css 的 .ap） */
export function lineClass(s: LineStatus): string {
  return s === "match" ? "approved" : s === "todo" ? "cancelled-soft" : s === "recount" ? "pending" : "rejected";
}
/** 选的货架：「：A-R1、A-R2」；太多就「：A-R1、A-R2、A-R3…（共 12 个）」 */
export function binsShort(bins: string[], max: number): string {
  if (!bins.length) return "";
  return bins.length <= max ? `：${bins.join("、")}` : `：${bins.slice(0, max - 1).join("、")}…（共 ${bins.length} 个）`;
}
/** 「RM 1,234.50」 */
export function rm(n: number | string | null | undefined): string {
  const v = Number(n || 0);
  return `RM ${v.toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
