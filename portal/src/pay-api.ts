// 薪资模块的资料层：RPC、员工资料 → 计算用的 PayEmp、工资单内容（照原系统 slipModel）。
import { supabase } from "./supabase";
import { BaseResult, CommResult, DEF_SET, PayEmp, PaySettings, r2 } from "./payroll/calc";

export type PayType = "base" | "comm";
export interface Profile {
  staff_id: number; name: string; department_name: string; branch: string; active: boolean; phone: string;
  join_date: string | null; has_profile: boolean; pay_name: string; base: number;
  category: "local" | "local60" | "foreign"; epf_opt_in: boolean; skbbk: boolean; no_epf: boolean; no_socso: boolean;
  no_eis: boolean; comm_type: "none" | "percent" | "fixed"; comm_rate: number; group_comm: boolean; comm_only: boolean;
  comm_with_base: boolean; leave_date: string | null; note: string;
}
export interface PayRecord {
  id: number; staff_id: number; name: string; year: number; month: number; type: PayType;
  inputs: Record<string, string | number | null>; result: BaseResult | CommResult; pay: number; remark: string;
  status: "draft" | "published"; published_at: string | null; updated_at: string; updated_by_name: string;
}
export interface Att { late_days: number; lunch_late_days: number; unpaid_days: number; absent_days: number; counted_to: string | null }
export interface MonthRow extends Profile { att: Att; records: Partial<Record<PayType, PayRecord>> }
export interface PayMeta {
  level: "view" | "edit" | "approve";
  setting: { company: string; params: Partial<PaySettings>; updated_at: string };
  profiles: Profile[];
}

async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}

export const pay = {
  meta: () => rpc<PayMeta>("ops_pay_meta"),
  saveProfile: (p: Partial<Profile>) => rpc<Profile>("ops_pay_profile_save", { p }),
  saveSetting: (p: { company: string; params: Partial<PaySettings> }) => rpc<void>("ops_pay_setting_save", { p }),
  month: (y: number, m: number) => rpc<{ year: number; month: number; rows: MonthRow[] }>("ops_pay_month", { p_year: y, p_month: m }),
  save: (p: Record<string, unknown>) => rpc<number>("ops_pay_save", { p }),
  remove: (id: number) => rpc<void>("ops_pay_delete", { p_id: id }),
  publish: (y: number, m: number, on: boolean, ids?: number[]) =>
    rpc<number>("ops_pay_publish", { p_year: y, p_month: m, p_publish: on, p_ids: ids ?? null }),
  history: (p: Record<string, unknown>) => rpc<PayRecord[]>("ops_pay_history", { p }),
  my: () => rpc<{ company: string; records: PayRecord[] }>("ops_pay_my"),
};

export function settingsOf(meta: { setting: { params: Partial<PaySettings> } } | null): PaySettings {
  return { ...DEF_SET, ...(meta?.setting.params || {}) };
}

/** 员工资料 → 计算用（栏位对照原系统） */
export function empOf(p: Profile, baseOverride?: number | null): PayEmp {
  return {
    base: baseOverride != null ? +baseOverride : +p.base, category: p.category, epfOptIn: p.epf_opt_in, skbbk: p.skbbk,
    noEpf: p.no_epf, noSocso: p.no_socso, noEis: p.no_eis, commType: p.comm_type, commRate: +p.comm_rate,
    groupComm: p.group_comm, commOnly: p.comm_only, commWithBase: p.comm_with_base,
    joinDate: p.join_date || "", leaveDate: p.leave_date || "", status: p.active ? "active" : "left",
  };
}
export const displayName = (p: { pay_name?: string; name: string }) => p.pay_name || p.name;

export const MON = ["一月", "二月", "三月", "四月", "五月", "六月", "七月", "八月", "九月", "十月", "十一月", "十二月"];
export const MON_EN = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const fmtRM = (v: number | string | null | undefined) =>
  (+(v as number) < 0 ? "-" : "") + Math.abs(r2(+(v as number) || 0)).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const money = (v: number | string | null | undefined) => "RM " + fmtRM(v);

// ------------------------------------------------------------ 工资单（照原系统 slipModel，中英对照）
type Row = [string, string, number, boolean?];
export interface SlipSection { title: [string, string]; rows: Row[]; total?: [string, string, number]; net?: [string, string, number] }
export interface Slip { name: string; y: number; m: number; b?: BaseResult; c?: CommResult; secs: SlipSection[]; total: [string, string, number] | null }

export function slipModel(name: string, y: number, m: number, b?: BaseResult, c?: CommResult, groupIn?: number): Slip | null {
  if (!b && !c) return null;
  const secs: SlipSection[] = [];
  if (b) {
    const adv = +b.advance || 0, back = adv < 0 ? -adv : 0;
    const ded = r2((+b.epfEmp || 0) + (+b.socsoEmp || 0) + (+b.eisEmp || 0) + (+b.pcb || 0) + Math.max(0, adv));
    secs.push({ title: ["Earnings", "收入"], rows: [
      ["Basic Salary", "底薪", b.base, true],
      [`Not employed (${+b.absentDays || 0} days)`, "未在职", -(+b.absentDeduct || 0)],
      [`Unpaid Leave (${+b.unpaidDays || 0} days)`, "无薪假", -(+b.unpaidDeduct || 0)],
      [`Overtime (${+b.otHours || 0} hrs)`, "加班", b.otTotal],
      ["Commission", "佣金", b.payComm],
      ["Back Pay", "补发", back]],
      total: ["Gross Pay", "总收入", r2((+b.gross || 0) + back)] });
    secs.push({ title: ["Deductions", "扣除"], rows: [
      ["EPF (KWSP)", "公积金", b.epfEmp],
      ["SOCSO (PERKESO)" + (b.skbbk ? " + SKBBK" : ""), "社险", b.socsoEmp],
      ["EIS (SIP)", "就业保险", b.eisEmp],
      ["PCB / MTD", "月扣税", b.pcb],
      ["Advance / Others", "预支／其他", Math.max(0, adv)]],
      total: ["Total Deductions", "扣除合计", ded], net: ["Net Pay", "实收", b.net] });
  }
  if (c) {
    const X = Math.max(0, -(+c.otherDeduct || 0));
    const taken = r2((+c.totalDeduct || 0) - (+c.spill || 0));
    const gross = r2((+c.payout || 0) + taken - X);                 // 扣款前的个人＋团体佣金
    const grp = c.groupVoided ? 0 : Math.min(gross, +(groupIn ?? c.commGroupIn) || 0);
    secs.push({ title: ["Commission", "佣金"], rows: [
      ["Personal Commission" + (+c.sales ? ` (Sales ${r2(c.sales).toLocaleString("en-MY", { minimumFractionDigits: 2 })})` : ""), "个人佣金", r2(gross - grp)],
      ["Group Commission", "团体佣金", grp],
      ["Back Pay", "补发", X],
      [`Wrong Packing (${+c.wrongQty || 0})`, "包错货", -(+c.wrongGoods || 0)],
      [`Late (${+c.lateCount || 0} times)`, "迟到", -(+c.lateDeduct || 0)],
      ["Other Deductions", "其他扣款", -Math.max(0, +c.otherDeduct || 0)],
      ["Not covered (outstanding)", "不够扣，结欠", +c.spill || 0]],
      net: ["Commission Paid", "佣金实发", c.payout] });
  }
  return { name, y, m, b, c, secs,
    total: b && c ? [`Total for ${MON_EN[m - 1]}`, "本月合计", r2((+b.net || 0) + (+c.payout || 0))] : null };
}

export function slipText(s: Slip, company: string): string {
  const out = [`*PAYSLIP 工资单 · ${MON_EN[s.m - 1]} ${s.y}*`];
  if (company) out.push(company);
  out.push(s.name, "");
  s.secs.forEach((x) => {
    out.push(`*${x.title[0]} ${x.title[1]}*`);
    x.rows.forEach(([en, zh, v, force]) => { if (force || +v) out.push(`${en} ${zh}: RM ${fmtRM(v)}`); });
    if (x.total) out.push(`${x.total[0]} ${x.total[1]}: RM ${fmtRM(x.total[2])}`);
    if (x.net) out.push(`*${x.net[0]} ${x.net[1]}: RM ${fmtRM(x.net[2])}*`);
    out.push("");
  });
  if (s.total) out.push(`*${s.total[0]} ${s.total[1]}: RM ${fmtRM(s.total[2])}*`);
  return out.join("\n").trim();
}

export function waPhone(p: string | null | undefined): string {
  let d = String(p || "").replace(/\D/g, "");
  if (!d) return "";
  if (d[0] === "0") d = "6" + d;
  return d;
}

/** 一个人一个月的工资单（从当月两笔记录组出来） */
export function slipFromRecords(name: string, y: number, m: number, recs: PayRecord[]): Slip | null {
  const b = recs.find((r) => r.type === "base");
  const c = recs.find((r) => r.type === "comm");
  return slipModel(name, y, m, b?.result as BaseResult | undefined, c?.result as CommResult | undefined);
}
