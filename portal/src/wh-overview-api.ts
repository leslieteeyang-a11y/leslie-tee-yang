// 仓库「总览」的资料层（2026-10-15）。金额（成本）只给仓库「可审批」（show_cost）。
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
  recent: OverviewRecent[];
  /** 最近动态里的商品品名 */ names: Record<string, string>;
}

export async function overview(company: string): Promise<Overview> {
  const { data, error } = await supabase.rpc("ops_wh_overview", { p: { company } });
  if (error) throw new Error(error.message);
  return data as Overview;
}
