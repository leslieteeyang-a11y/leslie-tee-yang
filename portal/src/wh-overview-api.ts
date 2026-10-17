// 仓库「总览」的资料层（2026-10-15）。金额（成本）只给老板（show_cost，20261019b）。
import { supabase } from "./supabase";
import { BinSummary } from "./wh-bin-api";

export interface OverviewRecent {
  type: "move" | "bin" | "count"; at: string; kind: string; item_code: string; by_name: string | null;
  qty?: number; from_loc?: string | null; to_loc?: string | null; status?: string; bin?: string; location?: string;
}
export interface Overview {
  company: string; synced_at: string | null; show_cost: boolean; today: string;
  neg_rows: number;
  locations: { location: string; items: number; qty: number; value: number | null; neg: number }[];
  moves_pending: number; grn_pending: number; grn_pending_do: number; do_to_count: number; variances: number;
  count_today: { counted: number; target: number; people: number };
  bins: BinSummary[];
  /** 备货：今天要送几张、已备好几张、备到一半几张 */ picks: { today: number; today_done: number; picking: number };
  /** 开着的盘点单（最多 10 张） */
  sheets: { id: number; title: string; location: string; due_date: string | null; overdue: boolean; total: number; done: number; recount: number }[];
  recent: OverviewRecent[];
  /** 最近动态里的商品品名 */ names: Record<string, string>;
}

export async function overview(company: string): Promise<Overview> {
  const { data, error } = await supabase.rpc("ops_wh_overview", { p: { company } });
  if (error) throw new Error(error.message);
  return data as Overview;
}

/** 首页的仓库提醒（没有仓库权限 = null / 空） */
export interface WhHome {
  picks_left: number | null;
  sheets: { id: number; company: string; title: string; location: string; due_date: string | null; overdue: boolean; total: number; left: number }[];
  bins_over: number | null;
  /** 仓库把关（2026-10-17）：等我核对的备货单、等我复核的点货差异、逾期没上架 */
  pick_check?: number | null; recv_review?: number | null; putaway_late?: number | null;
}
export async function whHome(): Promise<WhHome> {
  const { data, error } = await supabase.rpc("ops_wh_home");
  if (error) throw new Error(error.message);
  return data as WhHome;
}
