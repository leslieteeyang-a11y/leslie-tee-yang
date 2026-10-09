// 打卡模块的资料层：RPC、照片上传 / 读取、时间格式。权限都在资料库里检查。
import { supabase } from "./supabase";

export interface DayStats {
  date: string;
  workday: boolean;
  holiday: string | null;
  start: string;
  end: string;
  lunch_min: number | null;
  late_min: number;
  lunch_late_min: number;
  early_min: number;
  worked_min: number | null;
  missing_out: boolean;
  leave?: { part: "full" | "am" | "pm"; type: string; name: string } | null;
}
export interface AttRecord extends DayStats {
  clock_in: string | null;
  lunch_out: string | null;
  lunch_in: string | null;
  clock_out: string | null;
  in_place?: string;
  in_lat?: number | null;
  in_lng?: number | null;
  out_lat?: number | null;
  out_lng?: number | null;
  selfie_in?: string | null;
  selfie_lunch_out?: string | null;
  selfie_lunch_in?: string | null;
  selfie_out?: string | null;
  source?: "app" | "correction";
  checkins?: number | Checkin[];
  corrections?: number;
}
export interface Checkin { id?: number; at: string; lat: number; lng: number; purpose: string; selfie: string }
export interface Fence { id?: number; branch?: string; name: string; lat: number; lng: number; radius: number; active?: boolean }
export interface AttToday {
  now: string;
  today: string;
  shift: { code: string; name: string } | null;
  schedule: DayStats;
  geofence_exempt: boolean;
  fences: Fence[];
  record: AttRecord | null;
  open_shift: string | null;
  checkins: Checkin[];
  pending_corrections: number;
}
export interface BoardRow extends AttRecord {
  staff_id: number;
  name: string;
  department_name: string;
  branch: string;
  geofence_exempt: boolean;
  checkins: Checkin[];
}
export interface MonthRow {
  staff_id: number;
  name: string;
  department_name: string;
  branch: string;
  workdays: number;
  present: number;
  absent: number;
  late_days: number;
  late_min: number;
  lunch_late_days: number;
  lunch_late_min: number;
  early_days: number;
  missing_out: number;
  leave_days: number;
  worked_min: number;
}
export type Punch = "clock_in" | "lunch_out" | "lunch_in" | "clock_out";
export type CorrStatus = "pending_hod" | "pending_hr" | "approved" | "rejected" | "cancelled";
export interface Correction {
  id: number;
  staff_id: number;
  staff_name: string;
  department_name: string;
  date: string;
  kind: "punch" | "offsite";
  punch: Punch | null;
  time: string | null;
  reason: string;
  attachment: string | null;
  self_closed: boolean;
  original: string | null;
  status: CorrStatus;
  hod_name: string | null;
  decided_by_name: string | null;
  decided_at: string | null;
  decision_note: string;
  created_at: string;
  recorded: { clock_in: string | null; lunch_out: string | null; lunch_in: string | null; clock_out: string | null } | null;
  can_decide: boolean;
  can_cancel?: boolean;
}
export interface Shift {
  code: string;
  name: string;
  start_time: string;
  lunch_start: string;
  lunch_end: string;
  end_time: string;
  sat_end: string;
  sat_rule: "every" | "designated" | "none";
  sort?: number;
}
export interface AttStaff {
  id: number;
  name: string;
  department: string;
  department_name: string;
  branch: string;
  role: string;
  manager_id: number | null;
  shift: string;
  geofence_exempt: boolean;
  friday_prayer: boolean;
  join_date: string | null;
  gender: "M" | "F" | null;
  last_day?: string | null;        // 最后上班日（过了这天进不了系统，隔天自动停用）
}
export interface AttSettings {
  shifts: Shift[];
  fences: Required<Fence>[];
  holidays: { date: string; branch: string; name: string }[];
  saturdays: { ym: string; date: string; custom: boolean }[];
  staff: AttStaff[];
}

export const PUNCH_LABEL: Record<Punch, string> = {
  clock_in: "上班", lunch_out: "午休开始", lunch_in: "午休回来", clock_out: "下班",
};
export const CORR_STATUS_LABEL: Record<CorrStatus, string> = {
  pending_hod: "等主管审核", pending_hr: "等 HR 审核", approved: "已批准", rejected: "已驳回", cancelled: "已撤回",
};
export const CORR_STATUS_CLASS: Record<CorrStatus, string> = {
  pending_hod: "pending", pending_hr: "pending", approved: "approved", rejected: "rejected", cancelled: "cancelled",
};
export const SAT_RULE_LABEL: Record<Shift["sat_rule"], string> = {
  every: "每个星期六上班", designated: "每月指定一个星期六", none: "星期六不上班",
};

async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}

export const att = {
  today: () => rpc<AttToday>("ops_att_today"),
  punch: (p: Record<string, unknown>) => rpc<AttToday>("ops_att_punch", { p }),
  selfClose: (p: Record<string, unknown>) => rpc<AttToday>("ops_att_self_close", { p }),
  fieldCheckin: (p: Record<string, unknown>) => rpc<AttToday>("ops_att_field_checkin", { p }),
  days: (ym: string, staffId?: number) =>
    rpc<{ staff: { id: number; name: string; shift: string }; days: AttRecord[] }>("ops_att_days",
      { p_ym: ym, p_staff_id: staffId ?? null }),
  board: (date?: string) => rpc<{ date: string; rows: BoardRow[] }>("ops_att_board", { p_date: date || null }),
  month: (ym: string) => rpc<MonthRow[]>("ops_att_month", { p_ym: ym }),
  corrections: (scope: string) => rpc<Correction[]>("ops_att_corrections", { p_scope: scope }),
  createCorrection: (p: Record<string, unknown>) => rpc<Correction>("ops_att_correction_create", { p }),
  decide: (id: number, decision: string, note = "", time: string | null = null) =>
    rpc<Correction>("ops_att_correction_decide", { p_id: id, p_decision: decision, p_note: note, p_time: time }),
  cancel: (id: number) => rpc<void>("ops_att_correction_cancel", { p_id: id }),
  settings: () => rpc<AttSettings>("ops_att_settings"),
  saveShift: (p: Partial<Shift>) => rpc<void>("ops_att_shift_save", { p }),
  saveFence: (p: Partial<Fence>) => rpc<void>("ops_att_fence_save", { p }),
  saveHoliday: (p: Record<string, unknown>) => rpc<void>("ops_att_holiday_save", { p }),
  setSaturday: (ym: string, date: string | null) => rpc<void>("ops_att_saturday_set", { p_ym: ym, p_date: date }),
  setStaff: (p: Record<string, unknown>) => rpc<void>("ops_att_staff_set", { p }),
};

// ------------------------------------------------------------ 照片
const BUCKET = "ops-hr";

/** 上传到自己的资料夹（<staff_id>/<日期>/<种类>-<时间>.jpg），回传路径 */
export async function uploadPhoto(staffId: number, date: string, kind: string, blob: Blob): Promise<string> {
  const ext = blob.type === "application/pdf" ? "pdf" : blob.type === "image/png" ? "png" : "jpg";
  const path = `${staffId}/${date}/${kind}-${Date.now()}.${ext}`;
  const { error } = await supabase.storage.from(BUCKET).upload(path, blob, { contentType: blob.type || "image/jpeg" });
  if (error) throw new Error("照片上传失败，请检查网络再试一次。（" + error.message + "）");
  return path;
}

const signed = new Map<string, { url: string; at: number }>();
/** 私有照片换成 1 小时有效的网址（同一张 50 分钟内重复用） */
export async function photoUrl(path: string | null | undefined): Promise<string | null> {
  if (!path) return null;
  const hit = signed.get(path);
  if (hit && Date.now() - hit.at < 50 * 60 * 1000) return hit.url;
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, 3600);
  if (error || !data) return null;
  signed.set(path, { url: data.signedUrl, at: Date.now() });
  return data.signedUrl;
}

/** 缩小图片（手机照片动辄 3–5 MB；打卡自拍 480px 宽就够认人） */
export async function shrinkImage(file: Blob, maxW = 1280, quality = 0.75): Promise<Blob> {
  const bmp = await createImageBitmap(file).catch(() => null);
  if (!bmp) return file;
  const scale = Math.min(1, maxW / bmp.width);
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
  return await new Promise((res) => c.toBlob((b) => res(b || file), "image/jpeg", quality));
}

// ------------------------------------------------------------ GPS
export interface Fix { lat: number; lng: number; accuracy: number }

/** 先试高精度 12 秒，逾时 / 抓不到再试一般精度 8 秒；拒绝权限就直接失败（移植自 AttendX） */
export function getFix(): Promise<Fix> {
  const once = (high: boolean, timeout: number) =>
    new Promise<GeolocationPosition>((res, rej) =>
      navigator.geolocation.getCurrentPosition(res, rej, { enableHighAccuracy: high, timeout, maximumAge: 60000 }));
  return (async () => {
    if (!navigator.geolocation) throw new Error("这台手机 / 浏览器不支援定位。");
    let pos: GeolocationPosition;
    try {
      pos = await once(true, 12000);
    } catch (e) {
      const code = (e as GeolocationPositionError).code;
      if (code === 1) throw new Error(locationHelp());
      try {
        pos = await once(false, 8000);
      } catch (e2) {
        if ((e2 as GeolocationPositionError).code === 1) throw new Error(locationHelp());
        throw new Error("抓不到 GPS 位置。请到窗边或户外、确认手机定位已开启，再试一次。");
      }
    }
    return { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy };
  })();
}

function locationHelp(): string {
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  return ios
    ? "没有定位权限。请到 iPhone「设定 → 隐私权与安全性 → 定位服务 → Safari 网站」选「使用 App 期间」，再重新整理这一页。"
    : "没有定位权限。请点网址列左边的锁头 → 权限 → 位置 → 允许，再重新整理这一页。";
}

export function distanceM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function mapLink(lat?: number | null, lng?: number | null): string | null {
  return lat == null || lng == null ? null : `https://www.google.com/maps?q=${lat},${lng}`;
}

// ------------------------------------------------------------ 时间（一律马来西亚时间显示）
const hm = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kuala_Lumpur", hour: "2-digit", minute: "2-digit", hour12: false });
export function hhmm(ts: string | null | undefined): string {
  return ts ? hm.format(new Date(ts)) : "";
}
export function minsLabel(m: number | null | undefined): string {
  if (m == null) return "";
  const h = Math.floor(m / 60), r = m % 60;
  return h ? `${h}h${r ? ` ${r}m` : ""}` : `${r}m`;
}
const WD = ["日", "一", "二", "三", "四", "五", "六"];
export function weekday(date: string): string {
  return "周" + WD[new Date(date + "T12:00:00Z").getUTCDay()];
}
export function thisMonth(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kuala_Lumpur", year: "numeric", month: "2-digit" })
    .format(new Date()).slice(0, 7);
}
export function shiftMonth(ym: string, delta: number): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
}
