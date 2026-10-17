// 照 DO 拣货 + 扫码核对的资料层（2026-10-15）。DO 由 SERVER 每 15 分钟从 AutoCount 只读同步（bi.delivery_doc），
// 明细只有品名 / 数量 / 单位：资料库把品名对到商品（唯一相同才算），对不到的行在画面上「扫商品指定」「手动确认」或「略过」。
// 扫错 / 扫太多 / 货架不够：ops_wh_pick_scan 不报错，回传 ok:false + code + message（画面红闪 + 震动），什么都不存。
import { go } from "./router";
import { supabase } from "./supabase";

export type PickStatus = "picking" | "done" | "cancelled";
export type PickWhen = "today" | "week" | "all";
export type PickFilter = "todo" | "done" | "all";
export type PickMatch = "code" | "desc" | "manual" | "none";

export interface PickRun { run_id: number; run_date: string; driver_name: string | null; seq: number; today?: boolean; tomorrow?: boolean; delivered?: boolean }
export interface PickRow {
  doc_no: string; doc_date: string; debtor_name: string | null; cancelled: boolean;
  /** DO 明细几行 */ lines: number;
  /** null = 还没开始 */ status: PickStatus | null;
  /** 已经送达（签收）的不用拣 */ delivered: boolean;
  picked: number; total: number; run: PickRun | null;
}
export interface PickSummary { today: number; today_done: number; picking: number }
export interface PickList {
  company: string; when: PickWhen; status: PickFilter; today: string; summary: PickSummary; synced: string | null; rows: PickRow[];
}
export interface PickBin { id: number; location: string; code: string; barcode: string; qty: number }
export interface PickLine {
  /** 还没开始拣（预览）= null */ id: number | null;
  line_no: number; description: string; uom: string | null; qty: number;
  item_code: string | null; item_desc: string | null; match: PickMatch;
  /** 商品的基本单位（货架帐照这个单位记）；跟 DO 的单位不同时画面提醒 */ base_uom: string | null;
  picked: number; skip: boolean; skip_reason: string; done: boolean;
  /** 这个商品有货的货架（多的在前） */ bins: PickBin[];
}
export interface PickScan {
  id: number; line_id: number; line_no: number; item_code: string | null; qty: number; bin_id: number | null;
  /** 「HQ · A-R1-2」 */ bin: string | null; manual: boolean; code: string; note: string; created_at: string;
  by_name: string | null; voided: boolean; voided_at: string | null; voided_by_name: string | null;
}
export interface Pick {
  id: number; company: string; doc_no: string; status: PickStatus; short_note: string;
  started_by: number; started_at: string; started_by_name: string | null;
  done_at: string | null; done_by_name: string | null;
  cancelled_at: string | null; cancel_reason: string; cancelled_by_name: string | null;
  picked: number; total: number; lines_left: number;
  /** 核对（仓库把关 2026-10-17）：checked = 拣好而且核对过（分店没开核对 = 拣好就算）；touched = 我有拣这张（不能核对） */
  checked_at?: string | null; checked_by_name?: string | null; check_note?: string; check_fails?: number;
  checked?: boolean; needs_check?: boolean; touched?: boolean;
}
export interface PickDoc {
  company: string; doc_no: string; doc_date: string | null; debtor_name: string | null;
  cancelled: boolean; missing: boolean; do_remark: string | null; has_lines: boolean; synced_at: string | null;
  runs: PickRun[]; pick: Pick | null; lines: PickLine[]; scans: PickScan[];
  /** 开始拣货之后 AutoCount 改了这张 DO 的明细 */ do_changed: boolean;
  cancelled_picks: number; can_edit: boolean; can_cancel: boolean;
}
/** uom = DO 的单位跟商品基本单位不同（货架帐照基本单位记），不能照 DO 的数量从货架扣 */
export type ScanCode = "unknown" | "wrong" | "over" | "skipped" | "bin" | "bin_short" | "is_bin" | "uom";
export interface ScanResult {
  ok: boolean;
  /** ok = false：为什么 */ code?: ScanCode; message?: string;
  item_code?: string; description?: string;
  /** bin_short：货架上有几件、哪个货架；bins = 这个商品有货的货架（让人改选） */ bin_qty?: number; bin?: string; bins?: PickBin[];
  line?: PickLine; scan?: PickScan; pick?: Pick; done_all?: boolean;
}
export interface PickStatusMap { [docNo: string]: { status: PickStatus; picked: number; total: number; done_at: string | null } }

async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}

export const pick = {
  list: (p: { company: string; when: PickWhen; status: PickFilter; q?: string }) => rpc<PickList>("ops_wh_pick_list", { p }),
  get: (company: string, docNo: string) => rpc<PickDoc>("ops_wh_pick_get", { p_company: company, p_doc_no: docNo }),
  /** 排单画面：这些 DO 拣好了没（仓库或送货「只看」以上） */
  status: (company: string, docNos: string[]) =>
    rpc<PickStatusMap>("ops_wh_pick_status", { p_company: company, p_doc_nos: docNos }),
  /** 开始拣货（可编辑）；已经有人开始了就回传那一张 */
  start: (company: string, docNo: string) => rpc<PickDoc>("ops_wh_pick_start", { p_company: company, p_doc_no: docNo }),
  /** bin = 目前货架（BIN:<id>），没有就不从货架扣；lineId = 给对不到的行指定商品 */
  scan: (p: { pick_id: number; code: string; qty?: number; bin?: string | null; line_id?: number | null }) =>
    rpc<ScanResult>("ops_wh_pick_scan", { p }),
  undo: (scanId: number) => rpc<ScanResult>("ops_wh_pick_undo", { p_scan_id: scanId }),
  /** manual = 手动确认（要原因）；skip = 略过（要原因）；unskip = 取消略过 */
  lineSet: (p: { pick_id: number; line_id: number; action: "manual" | "skip" | "unskip"; qty?: number; reason?: string; bin?: string | null }) =>
    rpc<ScanResult>("ops_wh_pick_line_set", { p }),
  /** 已拣好；还有没拣够的要 force + short_note（缺货备注） */
  done: (p: { pick_id: number; force?: boolean; short_note?: string }) => rpc<PickDoc>("ops_wh_pick_done", { p }),
  cancel: (p: { pick_id: number; reason: string }) => rpc<{ ok: boolean; doc_no: string; reversed: number }>("ops_wh_pick_cancel", { p }),
  reopen: (pickId: number) => rpc<PickDoc>("ops_wh_pick_reopen", { p: { pick_id: pickId } }),
};

/** DO 的单位跟商品基本单位不同？（同资料库 ops.wh_pick_uom_diff：大小写、结尾的 S 不算，SET / SETS 一样） */
export function pickUomDiff(l: { item_code: string | null; uom: string | null; base_uom: string | null }): boolean {
  const n = (s: string | null) => (s || "").trim().toUpperCase().replace(/S$/, "");
  return !!(l.item_code && l.uom?.trim() && l.base_uom?.trim() && n(l.uom) !== n(l.base_uom));
}

export const PICK_STATUS_LABEL: Record<PickStatus, string> = { picking: "拣货中", done: "已拣好", cancelled: "已取消" };
export const MATCH_LABEL: Record<PickMatch, string> = {
  code: "商品代号", desc: "品名对到", manual: "扫码指定", none: "对不到商品",
};

/** 扫码结果的声音：对 = 高音一声、错 = 低音两声（浏览器不给就算了） */
let audio: AudioContext | null = null;
export function beep(ok: boolean): void {
  try {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    audio = audio || new AC();
    const ctx = audio;
    const tones = ok ? [[0, 1320, 0.09]] : [[0, 220, 0.16], [0.22, 220, 0.16]];
    for (const [at, freq, len] of tones) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = ok ? "sine" : "square";
      o.frequency.value = freq;
      g.gain.value = 0.08;
      o.connect(g); g.connect(ctx.destination);
      o.start(ctx.currentTime + at);
      o.stop(ctx.currentTime + at + len);
    }
  } catch { /* 没声音也可以 */ }
}
export function buzz(ok: boolean): void {
  try { navigator.vibrate?.(ok ? 60 : [200, 80, 200]); } catch { /* 有些浏览器不给震 */ }
}

/** 开一张 DO 的拣货画面（#/warehouse/pick/<DO 号>） */
export function openPick(docNo: string): void {
  go(`/warehouse/pick/${encodeURIComponent(docNo)}`);
}
/** 「今天第 2 站」/「明天第 2 站」/「10-16 第 2 站」 */
export function runLabel(r: { run_date: string; seq: number; today?: boolean; tomorrow?: boolean } | null): string {
  if (!r) return "";
  return r.today ? `今天第 ${r.seq} 站` : r.tomorrow ? `明天第 ${r.seq} 站` : `${r.run_date.slice(5)} 第 ${r.seq} 站`;
}
