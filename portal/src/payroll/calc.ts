// 薪资计算核心：原样移植自 HR 原本的薪资系统（index.html 的 calcBase / calcComm 与相关工具，2026-10 版）。
// 业务规则（马来西亚 EPF 第三附表、SOCSO Act 4 官方表含 SKBBK、EIS、佣金 / 迟到 / 包错货）与原系统一分不差；
// 用 scripts/payroll_parity.mjs 拿原系统的程式跑随机输入逐笔比对。改这里之前先跑那个比对。
// 原系统作者已用 2026 年 7 月 24 笔真实记录核对过（23 笔完全吻合）。

export interface PaySettings {
  epfEmpLocal: number; epfErLow: number; epfErHigh: number; epfErThreshold: number;
  epfEmp60: number; epfEr60: number; epfForeignErFlat: number;
  pcbThreshold: number;
  wrongGoodsRate: number; lateUnit: number; lateFraction: number; lateNoGroup: number;
}
export const DEF_SET: PaySettings = {
  epfEmpLocal: 11, epfErLow: 13, epfErHigh: 12, epfErThreshold: 5000,
  epfEmp60: 0, epfEr60: 4, epfForeignErFlat: 5,
  pcbThreshold: 3000,
  wrongGoodsRate: 10, lateUnit: 3, lateFraction: 0.5, lateNoGroup: 5,
};

export type Category = "local" | "local60" | "foreign";
export type CommType = "none" | "percent" | "fixed";

/** 员工的薪资设定（栏位名照原系统，方便对照） */
export interface PayEmp {
  base: number;
  category?: Category;
  epfOptIn?: boolean;        // 外劳自愿缴 EPF
  skbbk?: boolean;           // false = 没参加 SKBBK
  noEpf?: boolean; noSocso?: boolean; noEis?: boolean;
  commType?: CommType;
  commRate?: number;         // percent：% ；fixed：每月固定金额
  groupComm?: boolean;       // false = 没有团体佣金
  commOnly?: boolean;        // 无底薪、只拿佣金
  commWithBase?: boolean;    // 佣金跟底薪同一批月头发
  joinDate?: string;         // YYYY-MM-DD
  leaveDate?: string;
  status?: "active" | "left";
}

/** 每月输入（全部可选；空白当 0） */
export interface PayInput {
  year: number; month: number;
  workDays?: number | string;
  otHours?: number | string; unpaidDays?: number | string; pcb?: number | string; advance?: number | string;
  basePayComm?: number | string; baseSales?: number | string; baseRate?: number | string | null; baseExtraComm?: number | string;
  sales?: number | string; commGroup?: number | string; wrongQty?: number | string; lateCount?: number | string;
  otherDeduct?: number | string;
}

export const r2 = (x: number) => Math.round((x + Number.EPSILON) * 100) / 100;
export const r10c = (x: number) => Math.round(x * 10) / 10;
export const rInt = (x: number) => Math.round(x);
export const ceilRM = (x: number) => { const v = Math.ceil(x - 1e-9); return v === 0 ? 0 : v; };
const pos = (v: unknown) => Math.max(0, +(v as number) || 0);        // 不准负数的栏位一律当 0
const nz = (v: unknown) => +(v as number) || 0;                        // 可以是负数（预支 / 其他扣款）

/** 一个月的星期一到六天数（星期日不算） */
export function workDays(y: number, m: number): number {
  const d = new Date(y, m - 1, 1);
  let n = 0;
  while (d.getMonth() === m - 1) { if (d.getDay() !== 0) n++; d.setDate(d.getDate() + 1); }
  return n;
}

/* PERKESO Act 4 官方缴费表（含 SKBBK / LINDUNG 24 Jam），2026年6月生效
   每列：[薪金上限, 第一类雇主, 员工Keilatan, 员工SKBBK, 第二类雇主, 第二类员工SKBBK] */
export const SOCSO_TBL: [number, number, number, number, number, number][] = [
[30,0.40,0.10,0.20,0.30,0.20],[50,0.70,0.20,0.30,0.50,0.30],[70,1.10,0.30,0.50,0.80,0.50],
[100,1.50,0.40,0.65,1.10,0.65],[140,2.10,0.60,0.90,1.50,0.90],[200,2.95,0.85,1.25,2.10,1.25],
[300,4.35,1.25,1.85,3.10,1.85],[400,6.15,1.75,2.65,4.40,2.65],[500,7.85,2.25,3.35,5.60,3.35],
[600,9.65,2.75,4.15,6.90,4.15],[700,11.35,3.25,4.85,8.10,4.85],[800,13.15,3.75,5.65,9.40,5.65],
[900,14.85,4.25,6.35,10.60,6.35],[1000,16.65,4.75,7.15,11.90,7.15],[1100,18.35,5.25,7.85,13.10,7.85],
[1200,20.15,5.75,8.65,14.40,8.65],[1300,21.85,6.25,9.35,15.60,9.35],[1400,23.65,6.75,10.15,16.90,10.15],
[1500,25.35,7.25,10.85,18.10,10.85],[1600,27.15,7.75,11.65,19.40,11.65],[1700,28.85,8.25,12.35,20.60,12.35],
[1800,30.65,8.75,13.15,21.90,13.15],[1900,32.35,9.25,13.85,23.10,13.85],[2000,34.15,9.75,14.65,24.40,14.65],
[2100,35.85,10.25,15.35,25.60,15.35],[2200,37.65,10.75,16.15,26.90,16.15],[2300,39.35,11.25,16.85,28.10,16.85],
[2400,41.15,11.75,17.65,29.40,17.65],[2500,42.85,12.25,18.35,30.60,18.35],[2600,44.65,12.75,19.15,31.90,19.15],
[2700,46.35,13.25,19.85,33.10,19.85],[2800,48.15,13.75,20.65,34.40,20.65],[2900,49.85,14.25,21.35,35.60,21.35],
[3000,51.65,14.75,22.15,36.90,22.15],[3100,53.35,15.25,22.85,38.10,22.85],[3200,55.15,15.75,23.65,39.40,23.65],
[3300,56.85,16.25,24.35,40.60,24.35],[3400,58.65,16.75,25.15,41.90,25.15],[3500,60.35,17.25,25.85,43.10,25.85],
[3600,62.15,17.75,26.65,44.40,26.65],[3700,63.85,18.25,27.35,45.60,27.35],[3800,65.65,18.75,28.15,46.90,28.15],
[3900,67.35,19.25,28.85,48.10,28.85],[4000,69.15,19.75,29.65,49.40,29.65],[4100,70.85,20.25,30.35,50.60,30.35],
[4200,72.65,20.75,31.15,51.90,31.15],[4300,74.35,21.25,31.85,53.10,31.85],[4400,76.15,21.75,32.65,54.40,32.65],
[4500,77.85,22.25,33.35,55.60,33.35],[4600,79.65,22.75,34.15,56.90,34.15],[4700,81.35,23.25,34.85,58.10,34.85],
[4800,83.15,23.75,35.65,59.40,35.65],[4900,84.85,24.25,36.35,60.60,36.35],[5000,86.65,24.75,37.15,61.90,37.15],
[5100,88.35,25.25,37.85,63.10,37.85],[5200,90.15,25.75,38.65,64.40,38.65],[5300,91.85,26.25,39.35,65.60,39.35],
[5400,93.65,26.75,40.15,66.90,40.15],[5500,95.35,27.25,40.85,68.10,40.85],[5600,97.15,27.75,41.65,69.40,41.65],
[5700,98.85,28.25,42.35,70.60,42.35],[5800,100.65,28.75,43.15,71.90,43.15],[5900,102.35,29.25,43.85,73.10,43.85],
[6000,104.15,29.75,44.65,74.40,44.65]];
export function socsoRow(w: number) { for (const r of SOCSO_TBL) if (w <= r[0]) return r; return SOCSO_TBL[SOCSO_TBL.length - 1]; }
/* EIS (Act 800)：级距中间值 × 0.2%，双方各付，上限 RM6,000 */
export function eisAmt(w: number): number {
  let lo = 0;
  for (const r of SOCSO_TBL) { if (w <= r[0]) return r2((lo + r[0]) / 2 * 0.002); lo = r[0]; }
  return r2(5950 * 0.002);
}
/* EPF 第三附表：RM10 以下不缴；≤RM5,000 每 RM20 一级；RM5,000–20,000 每 RM100 一级；
   都取级距上限算百分比，最后进位到令吉。超过 RM20,000 直接按实际薪金 */
export function epfWage(w: number): number {
  if (w <= 10) return 0;
  if (w > 20000) return w;
  return w > 5000 ? Math.ceil(w / 100 - 1e-9) * 100 : Math.ceil(w / 20 - 1e-9) * 20;
}

/* 入职／离职：哪个月算在职、当月有几个工作天不在职 */
export const ymd = (y: number, m: number, d: number) => y + "-" + String(m).padStart(2, "0") + "-" + String(d).padStart(2, "0");
export const monthEnd = (y: number, m: number) => new Date(y, m, 0).getDate();
export function inMonth(e: PayEmp, y: number, m: number): boolean {
  if (e.joinDate && e.joinDate > ymd(y, m, monthEnd(y, m))) return false;
  if (e.leaveDate) return e.leaveDate >= ymd(y, m, 1);
  return e.status !== "left";
}
export function absentDays(e: PayEmp, y: number, m: number): number {
  if (!e.joinDate && !e.leaveDate) return 0;
  let n = 0;
  const d = new Date(y, m - 1, 1);
  while (d.getMonth() === m - 1) {
    const s = ymd(y, m, d.getDate());
    if (d.getDay() !== 0 && ((e.joinDate && s < e.joinDate) || (e.leaveDate && s > e.leaveDate))) n++;
    d.setDate(d.getDate() + 1);
  }
  return n;
}

export interface BaseResult {
  base: number; workDays: number; skbbk: boolean; payComm: number; baseSales: number; baseRate: number;
  basePayComm: number; baseExtraComm: number; otHours: number; otTotal: number;
  absentDays: number; absentDeduct: number; unpaidDays: number; unpaidDeduct: number;
  statWage: number; epfEmp: number; epfEr: number; socsoEmp: number; socsoEr: number; eisEmp: number; eisEr: number;
  pcb: number; advance: number; gross: number; net: number;
}

/* ===== 第一部分：底薪（月头发） ===== */
export function calcBase(e: PayEmp, i: PayInput, st: PaySettings = DEF_SET): BaseResult {
  const base = pos(e.base);
  const wd = Math.max(1, pos(i.workDays) || workDays(i.year, i.month));
  const otHours = pos(i.otHours);
  const otTotal = rInt(base / wd / 8 * 1.5 * otHours);
  const absentCal = absentDays(e, i.year, i.month);                               // 入职前／离职后的工作天（照日历数）
  const absent = Math.min(wd, absentCal * wd / workDays(i.year, i.month));          // 手动改过工作天数时按比例换算
  const absentDeduct = rInt(base / wd * absent);
  const unpaidDays = Math.min(pos(i.unpaidDays), r2(wd - absent));
  const unpaidDeduct = rInt(base / wd * (absent + unpaidDays)) - absentDeduct;    // 两项一起取整，合计不会超过底薪
  const statWage = r2(Math.max(0, base - absentDeduct - unpaidDeduct));           // 法定基数 = 底薪 − 未在职 − 无薪假
  const cat = e.category || "local";
  const ew = epfWage(statWage);
  let epfEmp = 0, epfEr = 0;
  if (cat === "local") { epfEmp = ceilRM(ew * st.epfEmpLocal / 100); epfEr = ceilRM(ew * (statWage <= st.epfErThreshold ? st.epfErLow : st.epfErHigh) / 100); }
  else if (cat === "local60") { epfEmp = ceilRM(ew * st.epfEmp60 / 100); epfEr = ceilRM(ew * st.epfEr60 / 100); }
  else {
    epfEmp = e.epfOptIn ? ceilRM(ew * st.epfEmpLocal / 100) : 0;
    epfEr = e.epfOptIn ? ceilRM(ew * st.epfErLow / 100) : st.epfForeignErFlat;
  }
  // SOCSO：查 Act 4 官方表
  const row = socsoRow(statWage);
  const skbbkOn = e.skbbk !== false;
  let socsoEmp = 0, socsoEr = 0;
  if (statWage > 0) {
    if (cat === "local") { socsoEr = row[1]; socsoEmp = r2(row[2] + (skbbkOn ? row[3] : 0)); }
    else { socsoEr = row[4]; socsoEmp = skbbkOn ? row[5] : 0; }                    // 60岁以上／外劳：第二类
  }
  // EIS：60岁以上及外劳豁免
  let eisEmp = 0, eisEr = 0;
  if (cat === "local" && statWage > 0) { eisEmp = eisAmt(statWage); eisEr = eisEmp; }
  // 个别豁免
  if (e.noEpf) { epfEmp = 0; epfEr = 0; }
  if (e.noSocso) { socsoEmp = 0; socsoEr = 0; }
  if (e.noEis) { eisEmp = 0; eisEr = 0; }
  const pcb = base > st.pcbThreshold ? pos(i.pcb) : 0;
  const advance = nz(i.advance);                                                   // 负数 = 补发
  let payComm = 0, baseSales = 0, baseRate = 0, basePayComm = 0, baseExtraComm = 0;
  if (e.commWithBase) {
    if (e.commType === "percent") {
      baseSales = pos(i.baseSales);
      baseRate = (i.baseRate != null && i.baseRate !== "") ? pos(i.baseRate) : pos(e.commRate);
      payComm = r10c(baseSales * baseRate / 100);
    } else { basePayComm = pos(i.basePayComm); payComm = r10c(basePayComm); }
    baseExtraComm = pos(i.baseExtraComm);
    payComm = r2(payComm + baseExtraComm);
  }
  const gross = r2(base - absentDeduct - unpaidDeduct + otTotal + payComm);
  const net = r2(gross - epfEmp - socsoEmp - eisEmp - pcb - advance);
  return { base, workDays: wd, skbbk: skbbkOn, payComm, baseSales, baseRate, basePayComm, baseExtraComm, otHours, otTotal,
    absentDays: absentCal, absentDeduct, unpaidDays, unpaidDeduct,
    statWage, epfEmp, epfEr, socsoEmp, socsoEr, eisEmp, eisEr, pcb, advance, gross, net };
}

export interface CommResult {
  base: number; workDays: number; sales: number; commPersonal: number; commGroup: number; commGroupIn: number;
  groupVoided: boolean; lateCount: number; lateUnits: number; lateDeduct: number; wrongQty: number; wrongGoods: number;
  otherDeduct: number; extraPay: number; totalDeduct: number; spill: number; payout: number;
}

/* ===== 第二部分：佣金（15 号发） ===== */
export function calcComm(e: PayEmp, i: PayInput, st: PaySettings = DEF_SET): CommResult {
  const base = pos(e.base);
  const wd = Math.max(1, pos(i.workDays) || workDays(i.year, i.month));
  const dayRate = base / wd;

  let commPersonal = 0;
  if (e.commType === "percent") commPersonal = r10c(pos(i.sales) * pos(e.commRate) / 100);
  else if (e.commType === "fixed") commPersonal = r10c(pos(e.commRate));

  let commGroup = e.groupComm === false ? 0 : r10c(pos(i.commGroup));
  const commGroupIn = commGroup;                                                   // 原始输入，编辑时要用这个，不是扣完的
  const late = pos(i.lateCount);
  const groupVoided = late >= st.lateNoGroup && commGroup > 0;
  if (late >= st.lateNoGroup) commGroup = 0;                                       // 迟到达标自动取消团体佣金

  const wrongQty = pos(i.wrongQty);
  const wrongGoods = r2(wrongQty * st.wrongGoodsRate);                             // 每包 RM10
  const lateUnits = Math.floor(late / st.lateUnit);                                // 每 3 次 = 半天
  const lateDeduct = rInt(lateUnits * dayRate * st.lateFraction);
  const otherDeduct = nz(i.otherDeduct);                                           // 负数 = 补发
  const totalDeduct = r2(wrongGoods + lateDeduct + Math.max(0, otherDeduct));
  let extraPay = otherDeduct < 0 ? r2(-otherDeduct) : 0;

  // 佣金本身取到 RM0.10；扣款照实扣到仙：先扣团体、再扣个人、再扣补发，都不够就是结欠
  let left = totalDeduct;
  const gTake = Math.min(left, commGroup); commGroup = r2(commGroup - gTake); left = r2(left - gTake);
  const pTake = Math.min(left, commPersonal); commPersonal = r2(commPersonal - pTake); left = r2(left - pTake);
  const xTake = Math.min(left, extraPay); extraPay = r2(extraPay - xTake); left = r2(left - xTake);
  const spill = r2(left);
  const payout = r2(commPersonal + commGroup + extraPay);

  return { base, workDays: wd, sales: pos(i.sales), commPersonal, commGroup, commGroupIn, groupVoided,
    lateCount: late, lateUnits, lateDeduct, wrongQty, wrongGoods, otherDeduct, extraPay, totalDeduct, spill, payout };
}

/** 当月要算底薪 / 佣金的员工（原系统 batchPool） */
export function needsBase(e: PayEmp): boolean { return !e.commOnly || !!e.commWithBase; }
export function needsComm(e: PayEmp): boolean {
  return !e.commWithBase && (e.commType !== "none" || e.groupComm !== false);   // 照原系统：没设佣金方式也算
}
