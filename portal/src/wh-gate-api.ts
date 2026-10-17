// 仓库把关（2026-10-17）的资料层：点货差异复核、点货照片、拣货核对、待上架、装车核对、今天要做的事、每人工作量、设定。
// 权限与「拣过的人不能核对」「点货的人不能复核自己」都在资料库检查；这里只决定画面上的按键。
import { supabase } from "./supabase";
import type { PickDoc } from "./wh-pick-api";

async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}

export interface Gate {
  company: string; recv_review: boolean; recv_photo: boolean; pick_check: boolean; load_check: boolean; putaway_days: number;
  updated_at: string; updated_by_name?: string | null;
}
export type RecvPhotoKind = "damaged" | "wrong" | "short";
export interface RecvPhoto { id: number; kind: RecvPhotoKind; item_key: string; path: string; created_at: string; by_name: string | null }
export interface ReviewReason {
  item_code?: string; description?: string; shipped?: number; received?: number; damaged?: number;
  wrong?: boolean; received_code?: string; qty?: number; expected_code?: string | null;
}
export interface RecvReview {
  do_id: number; company: string; status: "pending" | "approved"; reasons: ReviewReason[];
  /** 看不到厂家的人是 null */ do_no: string | null; supplier_name: string | null; arrive_note: string;
  counted_by_name: string | null; counted_at: string; reviewed_by_name: string | null; reviewed_at: string | null; note: string;
  photos: RecvPhoto[]; can_review: boolean;
}
export interface Claim { staff_id: number; name: string; at: string }
export interface PutRow {
  id: number; item_code: string; description: string | null; uom: string | null; qty: number; put: number; left: number;
  location: string; created_at: string; outlet: string | null; recv_wrong: boolean; late: boolean; do_no: string | null;
  by_name: string | null; claim: Claim | null; bins: { code: string; qty: number }[];
}
export interface CheckPick {
  id: number; doc_no: string; debtor_name: string | null; done_at: string; done_by_name: string | null;
  started_by_name: string | null; touched: boolean; check_fails: number; claim: Claim | null; total: number;
}
export interface CheckResult {
  ok: boolean; pick: PickDoc;
  diffs?: { line_id: number; line_no: number; description: string; item_code: string | null; picked: number; checked: number }[];
}
export interface LoadDoc {
  doc_no: string; name: string; seq: number;
  pick: { status: string; checked: boolean; short_note: string } | null;
  ready: boolean; loaded: boolean; loaded_at: string | null; loaded_by_name: string | null;
}
export interface Load {
  run_id: number; run_date: string; company: string; driver_name: string | null; gate: boolean;
  status: "none" | "loading" | "departed"; photos: string[]; note: string | null; override_reason: string | null;
  started_by_name: string | null; departed_at: string | null; departed_by_name: string | null;
  can_edit: boolean; can_override: boolean; docs: LoadDoc[];
}
export interface LoadScan { ok: boolean; code?: "not_in_run" | "not_picked" | "not_checked"; message?: string; doc_no?: string; short_note?: string | null; load?: Load }
export type TodayKind = "load" | "pick" | "pick_check" | "receive" | "recv_review" | "putaway";
export interface TodayItem {
  kind: TodayKind; ref: number | string; title: string; sub?: string | null; n?: number; done?: number; location?: string;
  due: string | null; late: boolean; today: boolean; who: string | null; who_id: number | null; can: boolean;
}
export interface Today { company: string; today: string; me_id: number; gate: Gate; items: TodayItem[] }
export interface WorkRow {
  staff_id: number; name: string; department: string;
  recv_dos: number; recv_lines: number; recv_min: number | null; picks: number; pick_lines: number; pick_min: number | null;
  pick_fails: number; undo: number; checks: number; put_n: number; put_qty: number; loads: number; departs: number; reviews: number;
}

export const gate = {
  get: (company: string) => rpc<Gate>("ops_wh_gate_get", { p_company: company }),
  set: (p: Partial<Gate> & { company: string }) => rpc<Gate>("ops_wh_gate_set", { p }),

  photos: (doId: number) => rpc<RecvPhoto[]>("ops_wh_recv_photos", { p_do_id: doId }),
  addPhoto: (p: { do_id: number; kind: RecvPhotoKind; item_code?: string; description?: string; path: string }) =>
    rpc<RecvPhoto[]>("ops_wh_recv_photo_add", { p }),
  delPhoto: (id: number) => rpc<RecvPhoto[]>("ops_wh_recv_photo_del", { p_id: id }),

  reviews: (company: string, status: "pending" | "done" | "all") => rpc<RecvReview[]>("ops_wh_recv_reviews", { p: { company, status } }),
  reviewOk: (doId: number, note: string) => rpc<RecvReview>("ops_wh_recv_review_ok", { p: { do_id: doId, note } }),
  reviewPending: (doIds: number[]) => rpc<Record<string, true>>("ops_wh_recv_review_pending", { p_do_ids: doIds }),

  toCheck: (company: string) => rpc<CheckPick[]>("ops_wh_pick_to_check", { p_company: company }),
  check: (pickId: number, lines: { line_id: number; qty: string }[], note: string) =>
    rpc<CheckResult>("ops_wh_pick_check", { p: { pick_id: pickId, lines, note } }),

  putList: (company: string, status: "todo" | "done" | "all", q: string) =>
    rpc<{ days: number; rows: PutRow[] }>("ops_wh_putaway_list", { p: { company, status, q } }),
  put: (moveId: number, bin: string, qty: string) => rpc<PutRow>("ops_wh_putaway", { p: { move_id: moveId, bin, qty } }),
  putSkip: (moveId: number, reason: string) => rpc<{ ok: true }>("ops_wh_putaway_skip", { p: { move_id: moveId, reason } }),
  claim: (kind: "receive" | "putaway" | "pick_check", ref: number, release = false) =>
    rpc<Claim | null>("ops_wh_claim", { p: { kind, ref, release } }),

  load: (runId: number) => rpc<Load>("ops_dlv_load_get", { p_run_id: runId }),
  loadScan: (runId: number, code: string) => rpc<LoadScan>("ops_dlv_load_scan", { p: { run_id: runId, code } }),
  loadUnscan: (runId: number, docNo: string) => rpc<Load>("ops_dlv_load_unscan", { p: { run_id: runId, doc_no: docNo } }),
  loadPhoto: (runId: number, path: string, remove = false) => rpc<Load>("ops_dlv_load_photo", { p: { run_id: runId, path, remove } }),
  depart: (runId: number, note: string, override_reason: string) =>
    rpc<Load>("ops_dlv_load_depart", { p: { run_id: runId, note, override_reason } }),
  loadStatus: (runIds: number[]) =>
    rpc<Record<string, { status: Load["status"]; loaded: number; docs: number; photos: number }>>("ops_dlv_load_status", { p_run_ids: runIds }),

  today: (company: string) => rpc<Today>("ops_wh_today", { p: { company } }),
  workload: (company: string, from: string, to: string) =>
    rpc<{ from: string; to: string; rows: WorkRow[] }>("ops_wh_workload", { p: { company, from, to } }),
};

// ------------------------------------------------------------ 照片（Storage ops-wh：recv/<公司>/<DO id>/…、load/<公司>/<排单>/…）
const BUCKET = "ops-wh";
const rnd = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
async function upload(path: string, file: Blob): Promise<string> {
  const { error } = await supabase.storage.from(BUCKET).upload(path, file, { contentType: "image/jpeg", upsert: false });
  if (error) throw new Error(`照片上传失败：${error.message}`);
  return path;
}
export const uploadRecvPhoto = (company: string, doId: number, file: Blob) => upload(`recv/${company}/${doId}/${rnd()}.jpg`, file);
export const uploadLoadPhoto = (company: string, runId: number, file: Blob) => upload(`load/${company}/${runId}/${rnd()}.jpg`, file);

/** 照片的对照键（与资料库 ops.wh_recv_key 同一套）：有型号 = 型号大写；没有 = 'D:' + 品名大写、连续空白当一个 */
export function recvKey(code: string | null | undefined, desc: string | null | undefined): string {
  const c = (code ?? "").trim();
  if (c) return c.slice(0, 100).toUpperCase();
  return "D:" + (desc ?? "").trim().slice(0, 300).replace(/\s+/g, " ").toUpperCase();
}
