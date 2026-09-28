// 资料层：所有读写都走 public.ops_* 函数（权限在资料库里检查），这里只负责呼叫与型别。
import { supabase } from "./supabase";

export type Level = "none" | "view" | "edit" | "approve";
export const LEVEL_RANK: Record<Level, number> = { none: 0, view: 1, edit: 2, approve: 3 };
export const LEVEL_LABEL: Record<string, string> = { none: "无", view: "只看", edit: "可编辑", approve: "可审批" };

export interface Module {
  key: string;
  name: string;
  phase: number;
  ready: boolean;
  description: string;
  level: Level;
}
export interface Department {
  code: string;
  name: string;
}
export interface Me {
  staff: {
    id: number;
    email: string;
    name: string;
    department: string;
    department_name: string;
    branch: string;
    role: "admin" | "manager" | "staff";
    title: string;
  };
  modules: Module[];
  departments: Department[];
}
export interface DirectoryEntry {
  id: number;
  name: string;
  department: string;
  branch: string;
  role: string;
  title: string;
}
export interface Home {
  my_open_tasks: number;
  my_overdue: number;
  dept_open_tasks: number;
  approvals_waiting: number;
  my_pending_requests: number;
  po_overdue: number | null;   // 只有订货模块可编辑的人才有
}
export type TaskStatus = "todo" | "doing" | "done" | "cancelled";
export type Priority = "low" | "normal" | "high" | "urgent";
export interface Task {
  id: number;
  branch: string;
  department: string;
  department_name: string;
  title: string;
  detail: string;
  status: TaskStatus;
  priority: Priority;
  assignee_id: number | null;
  assignee_name: string | null;
  due_date: string | null;
  ref_no: string;
  created_by: number;
  created_by_name: string;
  created_at: string;
  updated_at: string;
  done_at: string | null;
  comment_count: number;
  overdue: boolean;
  editable: boolean;
  comments?: { id: number; body: string; created_at: string; staff_name: string }[];
}
export type ApprovalKind = "leave" | "purchase" | "discount" | "expense" | "other";
export type ApprovalStatus = "pending" | "approved" | "rejected" | "cancelled";
export interface Approval {
  id: number;
  branch: string;
  department: string;
  department_name: string;
  kind: ApprovalKind;
  title: string;
  detail: string;
  amount: number | null;
  data: Record<string, string>;
  status: ApprovalStatus;
  requested_by: number;
  requested_by_name: string;
  approver_id: number | null;
  approver_name: string | null;
  decided_by_name: string | null;
  decided_at: string | null;
  decision_note: string;
  created_at: string;
  can_decide: boolean;
  can_cancel: boolean;
}
export interface StaffAdmin {
  id: number;
  email: string;
  name: string;
  department: string;
  branch: string;
  role: "admin" | "manager" | "staff";
  title: string;
  phone: string;
  active: boolean;
  has_login: boolean;
  overrides: Record<string, Level>;
}
export interface DeptModule {
  department: string;
  module: string;
  level: Level;
}

export type PoStatus = "ordered" | "confirmed" | "producing" | "shipped" | "arrived" | "closed";
export type ShipmentStatus = "booked" | "loading" | "shipped" | "arrived" | "received" | "cancelled";
export interface PoRow {
  company: string;
  po_no: string;
  po_date: string;
  creditor_code: string;
  supplier_name: string;
  creditor_name: string;
  is_china: boolean;
  lines: number;
  open_qty: number;
  locations: string;
  open_amt: number | null;        // 没有编辑权限的人看不到金额（null）
  status: PoStatus;
  po_eta: string | null;
  remark: string | null;
  updated_at: string | null;
  updated_by_name: string | null;
  shipment_id: number | null;
  shipment_name: string | null;
  shipment_status: ShipmentStatus | null;
  eta: string;
  eta_source: "shipment" | "po" | "autocount" | "lead";
  days_open: number;
  days_late: number;
  overdue: boolean;
  stale: boolean;
}
export interface PoDetail extends PoRow {
  can_edit: boolean;
  items: { item_code: string; description: string; uom: string; location: string; qty: number; received: number;
           open_qty: number; unit_price: number | null; open_amt: number | null }[];
  receipts: { doc_no: string; src: string; rcv_date: string; item_code: string; qty: number }[];
  history: { at: string; staff_name: string; data: Record<string, string> }[];
}
export interface Shipment {
  id: number;
  company: string;
  name: string;
  forwarder: string;
  etd: string | null;
  eta: string | null;
  status: ShipmentStatus;
  remark: string;
  po_count: number;
  open_po_count: number;
  po_nos: string[];
  updated_by_name: string | null;
  updated_at: string;
  overdue: boolean;
}
export interface ItemEta {
  company: string;
  item_code: string;
  description: string;
  uom: string;
  on_hand: number;
  by_loc: Record<string, number>;
  incoming: { po_no: string; open_qty: number; eta: string; eta_source: string; status: PoStatus;
              shipment_name: string | null; supplier_name: string; location: string; overdue: boolean }[];
}
export interface SyncStatus {
  company: string;
  purchase: string | null;   // PO 最后一次从 AutoCount 同步成功的时间
  stock: string | null;      // 库存
}
export const PO_STATUS_LABEL: Record<PoStatus, string> = {
  ordered: "已下单", confirmed: "供应商已确认", producing: "生产 / 备货中", shipped: "已出货", arrived: "已到港 / 到货中",
  closed: "关闭（不会来）",
};
export const SHIPMENT_STATUS_LABEL: Record<ShipmentStatus, string> = {
  booked: "已订舱", loading: "装柜中", shipped: "已出海", arrived: "已到港", received: "已入仓", cancelled: "取消",
};
export const ETA_SOURCE_LABEL: Record<string, string> = {
  shipment: "货柜", po: "采购填写", autocount: "AutoCount", lead: "按交期推算",
};

export const STATUS_LABEL: Record<TaskStatus, string> = { todo: "待办", doing: "进行中", done: "已完成", cancelled: "已取消" };
export const PRIORITY_LABEL: Record<Priority, string> = { low: "低", normal: "一般", high: "高", urgent: "紧急" };
export const KIND_LABEL: Record<ApprovalKind, string> = {
  leave: "请假", purchase: "采购", discount: "折扣 / 特价", expense: "报销 / 费用", other: "其他",
};
export const APPROVAL_STATUS_LABEL: Record<ApprovalStatus, string> = {
  pending: "待审批", approved: "已批准", rejected: "已驳回", cancelled: "已撤回",
};
export const BRANCH_LABEL: Record<string, string> = { HOMEWORKSSB: "总部", HOMEWORKSSOUTHERN: "JB 分店", ALL: "全部分店" };
export const ROLE_LABEL: Record<string, string> = { admin: "管理员", manager: "主管", staff: "员工" };

async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}

export const api = {
  me: () => rpc<Me | null>("ops_me"),
  home: () => rpc<Home>("ops_home"),
  directory: () => rpc<DirectoryEntry[]>("ops_directory"),
  tasks: (scope: string, status: string) => rpc<Task[]>("ops_task_list", { p_scope: scope, p_status: status }),
  task: (id: number) => rpc<Task>("ops_task_get", { p_id: id }),
  saveTask: (p: Partial<Task>) => rpc<Task>("ops_task_save", { p }),
  commentTask: (id: number, body: string) => rpc("ops_task_comment", { p_task_id: id, p_body: body }),
  approvals: (scope: string) => rpc<Approval[]>("ops_approval_list", { p_scope: scope }),
  createApproval: (p: Record<string, unknown>) => rpc<Approval>("ops_approval_create", { p }),
  decide: (id: number, decision: string, note = "") =>
    rpc<Approval>("ops_approval_decide", { p_id: id, p_decision: decision, p_note: note }),
  staffList: () => rpc<StaffAdmin[]>("ops_staff_admin_list"),
  saveStaff: (p: Record<string, unknown>) => rpc<StaffAdmin>("ops_staff_save", { p }),
  deptModules: () => rpc<DeptModule[]>("ops_dept_module_list"),
  setDeptModule: (department: string, module: string, level: string) =>
    rpc<void>("ops_dept_module_set", { p_department: department, p_module: module, p_level: level }),
  poList: (p: Record<string, unknown>) => rpc<PoRow[]>("ops_po_list", { p }),
  po: (company: string, poNo: string) => rpc<PoDetail>("ops_po_get", { p_company: company, p_po_no: poNo }),
  updatePos: (company: string, poNos: string[], p: Record<string, unknown>) =>
    rpc<number>("ops_po_update", { p_company: company, p_po_nos: poNos, p }),
  shipments: (includeDone = false) => rpc<Shipment[]>("ops_shipment_list", { p_include_done: includeDone }),
  saveShipment: (p: Record<string, unknown>) => rpc<Shipment>("ops_shipment_save", { p }),
  itemEta: (q: string) => rpc<ItemEta[]>("ops_item_eta", { p_q: q }),
  syncStatus: () => rpc<SyncStatus[]>("ops_sync_status"),
  async setPassword(staffId: number, password: string): Promise<{ created: boolean }> {
    const { data, error } = await supabase.functions.invoke("ops-account", {
      body: { staff_id: staffId, password },
    });
    if (error) {
      // FunctionsHttpError 的内文才有中文原因
      const ctx = (error as { context?: Response }).context;
      const msg = ctx ? (await ctx.json().catch(() => null))?.error : null;
      throw new Error(msg || error.message);
    }
    return data;
  },
};

export function can(me: Me, module: string, need: Level): boolean {
  const m = me.modules.find((x) => x.key === module);
  return !!m && LEVEL_RANK[m.level] >= LEVEL_RANK[need];
}

export function fmtQty(n: number | null | undefined): string {
  return n == null ? "" : Number(n).toLocaleString("en-MY", { maximumFractionDigits: 2 });
}

export function fmtRM(n: number | null | undefined): string {
  return n == null ? "" : "RM " + Number(n).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** 已上线的模块有自己的页面，其余进「规划中」说明页 */
export function moduleHref(m: { key: string; ready: boolean }): string {
  if (m.key === "dashboard") return "#/";
  return m.ready ? `#/${m.key}` : `#/m/${m.key}`;
}

/** 「今天 15:05」「昨天 12:05」「9/25 12:05」：给员工看资料新不新 */
export function fmtAgo(s: string | null | undefined): string {
  if (!s) return "未知";
  const d = new Date(s);
  const now = new Date();
  const hm = d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86400000);
  if (diff === 0) return `今天 ${hm}`;
  if (diff === 1) return `昨天 ${hm}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

export function fmtDate(s: string | null | undefined): string {
  if (!s) return "";
  return s.length > 10 ? new Date(s).toLocaleString("zh-CN", { dateStyle: "short", timeStyle: "short" }) : s;
}
