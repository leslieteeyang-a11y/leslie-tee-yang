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

export function fmtDate(s: string | null | undefined): string {
  if (!s) return "";
  return s.length > 10 ? new Date(s).toLocaleString("zh-CN", { dateStyle: "short", timeStyle: "short" }) : s;
}
