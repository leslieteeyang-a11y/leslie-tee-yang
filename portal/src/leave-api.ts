// 请假模块的资料层：RPC 与型别。权限都在资料库里检查（只有 HR 能批、余额不够会被挡）。
import { supabase } from "./supabase";

export type LeaveStatus = "pending" | "approved" | "rejected" | "cancelled";
export type LeavePart = "full" | "am" | "pm";

export interface LeaveType {
  code: string;
  name: string;
  rule: "annual" | "sick" | "fixed" | "none";
  days: number;
  half_day: boolean;
  calendar_days: boolean;
  need_attachment: boolean;
  gender?: "M" | "F" | null;
  min_service_months?: number;
  active?: boolean;
  note: string;
  sort?: number;
}
export interface Balance {
  type: string;
  name: string;
  rule: LeaveType["rule"];
  entitled: number | null;
  adjust: number;
  used: number;
  pending: number;
  balance: number | null;
}
export interface LeaveRequest {
  id: number;
  staff_id: number;
  staff_name: string;
  department_name: string;
  type: string;
  type_name: string;
  start_date: string;
  end_date: string;
  part: LeavePart;
  days: number;
  reason: string;
  attachment: string | null;
  status: LeaveStatus;
  decided_by_name: string | null;
  decided_at: string | null;
  decision_note: string;
  created_at: string;
  created_by_name: string | null;
  can_decide: boolean;
  can_cancel: boolean;
}
export interface LeaveHome {
  today: string;
  year: number;
  join_date: string | null;
  gender: "M" | "F" | null;
  is_hr: boolean;
  types: LeaveType[];
  balances: Balance[];
  requests: LeaveRequest[];
}
export interface Adjustment { id: number; type: string; days: number; note: string; by: string; at: string }
export interface StaffBalances {
  staff_id: number;
  name: string;
  department_name: string;
  branch: string;
  join_date: string | null;
  gender: "M" | "F" | null;
  years: number;
  balances: Balance[];
  adjustments: Adjustment[];
}

export const LEAVE_STATUS_LABEL: Record<LeaveStatus, string> = {
  pending: "等 HR 审核", approved: "已批准", rejected: "已驳回", cancelled: "已取消",
};
export const PART_LABEL: Record<LeavePart, string> = { full: "整天", am: "上午半天", pm: "下午半天" };

async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}

export const leave = {
  home: (year?: number) => rpc<LeaveHome>("ops_leave_home", { p_year: year ?? null }),
  preview: (p: Record<string, unknown>) => rpc<{ days: number | null }>("ops_leave_preview", { p }),
  apply: (p: Record<string, unknown>) => rpc<LeaveRequest>("ops_leave_apply", { p }),
  cancel: (id: number, note = "") => rpc<LeaveRequest>("ops_leave_cancel", { p_id: id, p_note: note }),
  list: (p: Record<string, unknown>) => rpc<LeaveRequest[]>("ops_leave_list", { p }),
  decide: (id: number, decision: "approve" | "reject", note = "") =>
    rpc<LeaveRequest>("ops_leave_decide", { p_id: id, p_decision: decision, p_note: note }),
  balances: (year: number) => rpc<{ year: number; rows: StaffBalances[] }>("ops_leave_balances", { p_year: year }),
  adjust: (p: Record<string, unknown>) => rpc<void>("ops_leave_adjust", { p }),
  types: () => rpc<LeaveType[]>("ops_leave_types"),
  saveType: (p: Partial<LeaveType>) => rpc<void>("ops_leave_type_save", { p }),
};

/** 12/31 – 1/2 这类日期范围的显示 */
export function dateRange(r: { start_date: string; end_date: string; part: LeavePart }): string {
  if (r.part !== "full") return `${r.start_date}（${PART_LABEL[r.part]}）`;
  return r.start_date === r.end_date ? r.start_date : `${r.start_date} – ${r.end_date}`;
}

/** 0.5 → "0.5"、3 → "3"（资料库回传 numeric 可能是字串） */
export function daysLabel(n: number | string | null | undefined): string {
  if (n == null) return "—";
  return String(Number(n));
}
