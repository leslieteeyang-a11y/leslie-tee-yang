// 厂家 DO / 装箱单的 Excel（.xlsx / .xls）与 CSV：在浏览器读，不上传到伺服器解析。
// SheetJS 用动态载入（import()），只有真的读 Excel 时才下载，不会让主程式变大。
//
// 做法（每个工作表各自判断，采购可以在画面上改）：
//   1. 找表头：前 40 行里，哪一行（或连续两行合起来：例「Quantity」下面一行是「PCS / CTNS」）最像表头 ——
//      要有「数量」栏（QTY / Quantity / PCS / 数量 / Qty(pcs)…，排除每箱几个、箱数、重量、单价），
//      以及「货号 / 型号 / 品名」其中一栏；数量栏底下真的要有数字。
//   2. 表头下面每一行：有数量（> 0）、有货号 / 型号 / 品名才算；合计行、换页重复的表头略过。
//      合并储存格：货号 / 品名照左上角的值补上（数量不补，免得算两次）。
//   3. 对型号（所选 PO 的商品代号）：货号 / 型号栏完全相同 → 去掉大小写、空白、横线后相同（HM-123 = HM123）→
//      这一行任何一格里的字（品名常写「HEMOS BASIN HM-123」）→ 厂家的型号出现在我们商品的品名里。
//      对到不只一个就不猜，列为对不上（附上可能的型号）。同型号几行加总。
export type Cell = string | number | null;
export interface Merge { s: { r: number; c: number }; e: { r: number; c: number } }
export interface Sheet { name: string; rows: Cell[][]; merges: Merge[] }
export type Role = "code" | "model" | "desc" | "qty";
export const ROLES: Role[] = ["code", "model", "desc", "qty"];
export interface Plan {
  sheet: string;
  header: number;               // 表头在第几行（0 起算）；-1 = 找不到
  headerRows: 1 | 2;
  cols: Partial<Record<Role, number>>;
  use: boolean;
  score?: number;               // 自动找表头的分数（几张表重复时留分数高的）
}
export interface Line { sheet: string; row: number; code: string; model: string; desc: string; qty: number; texts: string[] }
export interface MatchCand { item_code: string; description: string }
export interface Matched { item_code: string; qty: number; lines: Line[]; how: MatchHow }
export type MatchHow = "code" | "normalized" | "text" | "description";
export interface Unmatched extends Line { suggest: string[] }
export interface MatchResult { matched: Matched[]; unmatched: Unmatched[] }

const MAX_ROWS = 5000;
const MAX_COLS = 60;
const MAX_SHEETS = 30;
const SCAN = 40;

// ------------------------------------------------------------------ 读档
/** 读 Excel / CSV → 每个工作表一个二维阵列（第 0 行 = Excel 第 1 行，第 0 栏 = A 栏） */
export async function readWorkbook(file: Blob, name: string): Promise<Sheet[]> {
  const XLSX = await import("@e965/xlsx");
  const buf = await file.arrayBuffer();
  let wb;
  if (/\.csv$/i.test(name)) {
    // CSV：先当 UTF-8；有乱码再试 GB18030（中国厂家的 Excel 存成 CSV 常是这个）
    let text = new TextDecoder("utf-8").decode(buf);
    if (text.includes("�")) {
      try { text = new TextDecoder("gb18030").decode(buf); } catch { /* 浏览器不支援就用原本的 */ }
    }
    wb = XLSX.read(text.replace(/^﻿/, ""), { type: "string", raw: true });
  } else {
    wb = XLSX.read(buf, { type: "array", cellFormula: false, cellHTML: false, cellStyles: false });
  }
  const out: Sheet[] = [];
  for (const sn of wb.SheetNames.slice(0, MAX_SHEETS)) {
    const ws = wb.Sheets[sn];
    if (!ws || !ws["!ref"]) { out.push({ name: sn, rows: [], merges: [] }); continue; }
    const rg = XLSX.utils.decode_range(ws["!ref"]);
    const lastR = Math.min(rg.e.r, MAX_ROWS - 1);
    const lastC = Math.min(rg.e.c, MAX_COLS - 1);
    const rows: Cell[][] = [];
    for (let r = 0; r <= lastR; r++) {
      const row: Cell[] = [];
      for (let c = 0; c <= lastC; c++) {
        const cell = r < rg.s.r || c < rg.s.c ? undefined : ws[XLSX.utils.encode_cell({ r, c })];
        row.push(cellValue(cell, XLSX.SSF.is_date));
      }
      while (row.length && row[row.length - 1] == null) row.pop();
      rows.push(row);
    }
    const merges = ((ws["!merges"] ?? []) as Merge[]).filter((m) => m.s.r <= lastR && m.s.c <= lastC);
    out.push({ name: sn, rows, merges });
  }
  return out;
}

interface RawCell { t?: string; v?: unknown; w?: string; z?: unknown }
function cellValue(cell: RawCell | undefined, isDate: (z: string | number) => boolean): Cell {
  if (!cell || cell.v == null || cell.t === "z" || cell.t === "e") return null;
  if (cell.t === "n" && typeof cell.v === "number") {
    // 用格式补零的代号（00123）、日期：用画面上看到的字；其他数字照原值
    if (cell.w && (/^0\d+$/.test(cell.w.trim()) || (cell.z != null && isDate(cell.z as string)))) return cell.w.trim();
    return cell.v;
  }
  const s = String(cell.w ?? cell.v).trim();
  return s === "" ? null : s;
}

// ------------------------------------------------------------------ 小工具
/** 型号比对用：全形转半形、大写、只留英数字（HM-123、hm 123、ＨＭ１２３ 都变 HM123） */
export function normCode(s: string): string {
  return s.normalize("NFKC").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function colLetter(c: number): string {
  let s = "";
  for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

function str(v: Cell | undefined): string {
  return v == null ? "" : String(v).replace(/\s+/g, " ").trim();
}

/** 数量：数字，或「1,200」「120 PCS」「１２０pcs」；其他（10+2、空白、文字）= null */
export function toQty(v: Cell | undefined): number | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const t = v.normalize("NFKC").replace(/(\d),(?=\d{3}\b)/g, "$1").trim();
  const m = /^(\d+(?:\.\d+)?)\s*([a-z一-鿿'’]{0,8})\.?$/i.exec(t);
  return m ? Number(m[1]) : null;
}

/** 合并储存格：左上角以外的格子是空的 → 补上左上角的值（skipCol 那一栏不补） */
function cellAt(sh: Sheet, r: number, c: number, fill: boolean, skipCol?: number): Cell {
  const v = sh.rows[r]?.[c] ?? null;
  if (v != null || !fill || c === skipCol) return v;
  for (const m of sh.merges) {
    if (r >= m.s.r && r <= m.e.r && c >= m.s.c && c <= m.e.c && (r !== m.s.r || c !== m.s.c)) return sh.rows[m.s.r]?.[m.s.c] ?? null;
  }
  return null;
}

function width(sh: Sheet, from: number, to: number): number {
  let w = 0;
  for (let r = from; r < Math.min(to, sh.rows.length); r++) w = Math.max(w, sh.rows[r]?.length ?? 0);
  return w;
}

// ------------------------------------------------------------------ 表头
function lower(s: string): string {
  return s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

const PER_PACK = /(\/|per |每|一)\s*(ctns?|cartons?|箱|boxe?s?|bags?|包|inner|件)|pcs\s*\/\s*ctn|装箱|入数|箱入|per\s*pack|qty\s*\/\s*ctn/;
const NOT_QTY = /(n\.?\s?w\.?|g\.?\s?w\.?|weight|kgs?\b|重量|毛重|净重|cbm|meas|体积|尺寸|size|price|amount|金额|单价|价格|value|usd|rmb|myr|remark|备注|date|日期|unit\b|单位)/;

export function qtyScore(label: string): number {
  const h = lower(label);
  if (!h || PER_PACK.test(h) || NOT_QTY.test(h)) return 0;
  if (/^(no\.?\s*of\s*)?(ctns?|cartons?|箱数|箱|packages?|pkgs?|total\s*ctns?|ctns?\s*qty|cartons?\s*qty)$/.test(h)) return 0;
  let s = 0;
  if (/(qty|quantity|quantities|qnty|q'ty|数量|数目)/.test(h)) s = 4;
  else if (/(\bpcs\b|pieces|\bsets?\b|个数|只数|套数|实发|发货数|出货数)/.test(h)) s = 3;
  else if (/\bunits\b/.test(h)) s = 2;                                          // Units / Units Shipped（Unit 单独 = 单位，上面已排除）
  else if (/件数/.test(h)) s = 1;
  if (!s) return 0;
  if (/(total|总|合计)/.test(h)) s += 1;
  if (/(ship|deliver|dispatch|actual|发|出|实|交|送)/.test(h)) s += 1;
  if (/(order|订|\bpo\b|balance|余|欠|outstanding|backorder)/.test(h)) s -= 2;     // 订单数量、余数不是这批出货
  if (/(ctn|carton|箱)/.test(h)) s -= 2;                                            // Quantity (CTNS) = 箱数
  return Math.max(s, 0);
}

const NOT_CODE = /(\bp\.?o\b|order|订单|invoice|\binv\b|发票|ctn|carton|箱|container|柜|seal|\bhs\b|tariff|海关|customer|客户|batch|lot)/;
export function codeScore(label: string): number {
  const h = lower(label);
  if (!h || NOT_CODE.test(h)) return 0;
  if (/^(no\.?|s\/?n|序号|序|#|line|行)$/.test(h)) return 0;
  if (/(item\s*code|item\s*no|item\s*#|stock\s*code|product\s*code|product\s*no|part\s*no|part\s*number|art(icle)?\.?\s*no|\bsku\b|货号|商品编号|物料编号|料号|产品编号|货品编号|商品代号|产品代码|物料代码|编码|代码|编号|\bcode\b)/.test(h)) return 5;
  if (/(barcode|条码|\bean\b|\bupc\b)/.test(h)) return 2;
  if (/^(ref|reference|ref\.?\s*no\.?)$/.test(h)) return 3;
  if (/^(item|items)$/.test(h)) return 2;
  return 0;
}

export function modelScore(label: string): number {
  const h = lower(label);
  if (!h || NOT_CODE.test(h)) return 0;
  return /(model|型号|款号|款式|style)/.test(h) ? 5 : 0;
}

export function descScore(label: string): number {
  const h = lower(label);
  if (!h) return 0;
  if (/(description|descr|\bdesc\b|品名|名称|描述|货物|商品名|产品名|product\s*name|item\s*name|goods|commodity|particular|\bname\b)/.test(h)) return 5;
  if (/^(product|产品|规格|spec|specification|item|items)$/.test(h)) return 3;
  return 0;
}

const SCORE: Record<Role, (s: string) => number> = { code: codeScore, model: modelScore, desc: descScore, qty: qtyScore };

/** 某一行（或两行）当表头时，每栏的文字 */
export function headerLabels(sh: Sheet, r: number, n: 1 | 2): string[] {
  const w = width(sh, r, r + n);
  const out: string[] = [];
  for (let c = 0; c < w; c++) {
    const a = str(cellAt(sh, r, c, true));
    const b = n === 2 ? str(cellAt(sh, r + 1, c, true)) : "";
    out.push(a && b && lower(a) !== lower(b) ? `${a} ${b}` : a || b);
  }
  return out;
}

function qtyColumnHasNumbers(sh: Sheet, from: number, c: number): boolean {
  for (let r = from; r < Math.min(sh.rows.length, from + 30); r++) {
    const q = toQty(sh.rows[r]?.[c] ?? null);
    if (q != null && q > 0) return true;
  }
  return false;
}

/** 像商品代号的比例（短、没太多空白、有数字）：表头没写「货号」时用内容猜 */
function codeLike(sh: Sheet, from: number, c: number): number {
  let n = 0;
  let hit = 0;
  for (let r = from; r < Math.min(sh.rows.length, from + 50); r++) {
    const v = str(sh.rows[r]?.[c] ?? null);
    if (!v) continue;
    n++;
    if (v.length <= 30 && /\d/.test(v) && /[A-Za-z]/.test(v) && v.split(" ").length <= 3) hit++;
  }
  return n >= 2 ? hit / n : 0;
}

function assign(sh: Sheet, labels: string[], dataFrom: number): { cols: Partial<Record<Role, number>>; score: number } {
  const cols: Partial<Record<Role, number>> = {};
  const used = new Set<number>();
  let score = 0;
  const best = (role: Role, min: number, check?: (c: number) => boolean) => {
    const ranked = labels.map((l, c) => ({ c, s: used.has(c) ? 0 : SCORE[role](l) }))
      .filter((x) => x.s >= min).sort((a, b) => b.s - a.s || a.c - b.c);
    for (const x of ranked) {
      if (check && !check(x.c)) continue;
      cols[role] = x.c;
      used.add(x.c);
      score += x.s;
      return;
    }
  };
  best("qty", 3, (c) => qtyColumnHasNumbers(sh, dataFrom, c));
  if (cols.qty == null) best("qty", 1, (c) => qtyColumnHasNumbers(sh, dataFrom, c));     // 只有「件数」
  if (cols.qty == null) return { cols, score: 0 };
  best("code", 3);
  best("model", 3);
  best("desc", 3);
  if (cols.code == null && cols.model == null) {
    best("code", 2);                                   // 表头只写「Item」
    if (cols.code == null) {
      // 表头没写，用内容猜：最像代号的那一栏
      let bc = -1;
      let bs = 0.6;
      for (let c = 0; c < labels.length; c++) {
        if (used.has(c)) continue;
        const s = codeLike(sh, dataFrom, c);
        if (s > bs) { bs = s; bc = c; }
      }
      if (bc >= 0) { cols.code = bc; used.add(bc); score += 2; }
    }
  }
  if (cols.code == null && cols.model == null && cols.desc == null) return { cols, score: 0 };
  return { cols, score };
}

/** 自动找表头与各栏；找不到 → header = -1（画面上让采购自己选） */
export function detectPlan(sh: Sheet): Plan {
  let best: Plan = { sheet: sh.name, header: -1, headerRows: 1, cols: {}, use: false };
  let bestScore = 0;
  for (let r = 0; r < Math.min(sh.rows.length, SCAN); r++) {
    if (!sh.rows[r]?.some((v) => v != null)) continue;
    for (const n of [1, 2] as const) {
      if (n === 2 && r + 1 >= sh.rows.length) continue;
      const { cols, score } = assign(sh, headerLabels(sh, r, n), r + n);
      const s = score - (n === 2 ? 0.5 : 0);
      if (s > bestScore) {
        bestScore = s;
        best = { sheet: sh.name, header: r, headerRows: n, cols, use: true, score: s };
      }
    }
  }
  return best;
}

/** 整份档案：每张表各自找表头；几张表的型号大多一样（常见：Commercial Invoice + Packing List 列同一批货）→
 *  预设只用分数最高的一张，其他的不勾（画面上提醒，要两张都算可以自己勾），免得数量算两次 */
export function detectPlans(sheets: Sheet[]): { plans: Plan[]; dups: [string, string][] } {
  const plans = sheets.map(detectPlan);
  const keys = sheets.map((sh, i) => new Set(readLines(sh, plans[i]).map((l) => normCode(l.code || l.model || l.desc)).filter(Boolean)));
  const order = plans.map((_, i) => i).filter((i) => plans[i].use)
    .sort((a, b) => (plans[b].score ?? 0) - (plans[a].score ?? 0) || keys[b].size - keys[a].size || a - b);
  const kept: number[] = [];
  const dups: [string, string][] = [];
  for (const i of order) {
    const k = kept.find((j) => overlap(keys[i], keys[j]) >= 0.6);
    if (k == null) kept.push(i);
    else {
      plans[i] = { ...plans[i], use: false };
      dups.push([sheets[k].name, sheets[i].name]);
    }
  }
  return { plans, dups };
}

function overlap(a: Set<string>, b: Set<string>): number {
  const n = Math.min(a.size, b.size);
  if (!n) return 0;
  let hit = 0;
  a.forEach((x) => { if (b.has(x)) hit++; });
  return hit / n;
}

/** 采购在画面上改了表头行：重新猜各栏 */
export function planForHeader(sh: Sheet, header: number, headerRows: 1 | 2): Plan {
  const { cols } = assign(sh, headerLabels(sh, header, headerRows), header + headerRows);
  return { sheet: sh.name, header, headerRows, cols, use: true };
}

// ------------------------------------------------------------------ 资料行
const TOTAL_ROW = /^((total|sub-?\s?total|grand\s*total|sum)\b|合计|总计|小计|共计|总数|总共)/i;

export function readLines(sh: Sheet, plan: Plan): Line[] {
  const out: Line[] = [];
  const qc = plan.cols.qty;
  if (!plan.use || qc == null || plan.header < 0) return out;
  const w = width(sh, plan.header, sh.rows.length);
  for (let r = plan.header + plan.headerRows; r < sh.rows.length; r++) {
    const row = sh.rows[r];
    if (!row || !row.some((v) => v != null)) continue;
    const get = (c: number | undefined) => (c == null ? "" : str(cellAt(sh, r, c, true, qc)));
    const code = get(plan.cols.code);
    const model = get(plan.cols.model);
    const desc = get(plan.cols.desc);
    const texts: string[] = [];
    for (let c = 0; c < w; c++) {
      if (c === qc) continue;
      const v = cellAt(sh, r, c, true, qc);
      if (typeof v === "string" && v.length <= 300) texts.push(str(v));
    }
    if (!code && !model && !desc && !texts.some((t) => /[A-Za-z一-鿿]/.test(t))) continue;   // 只有数字 = 合计行
    if ([code, model, desc, texts[0] ?? ""].some((t) => TOTAL_ROW.test(t))) continue;
    const qv = row[qc] ?? null;
    const q = toQty(qv);
    if (q == null || q <= 0) continue;                                                             // 含换页重复的表头
    out.push({ sheet: sh.name, row: r + 1, code, model, desc, qty: q, texts });
  }
  return out;
}

// ------------------------------------------------------------------ 对型号
function tokens(text: string): string[] {
  const out = new Set<string>();
  const base = text.split(/[\s,;，；、|()（）[\]【】{}<>"'“”‘’:：*]+/).filter(Boolean);
  base.forEach((t, i) => {
    out.add(t);
    if (t.includes("/")) t.split("/").forEach((x) => x && out.add(x));
    if (i + 1 < base.length) out.add(t + base[i + 1]);          // 「HM 123」
  });
  return [...out];
}

const codeish = (n: string) => n.length >= 3 && /\d/.test(n);

function add(m: Map<string, Set<string>>, k: string, v: string) {
  if (!k) return;
  const s = m.get(k);
  if (s) s.add(v); else m.set(k, new Set([v]));
}

export function matchLines(lines: Line[], cands: MatchCand[]): MatchResult {
  const exact = new Map<string, string>();
  const norm = new Map<string, Set<string>>();
  const inDesc = new Map<string, Set<string>>();
  for (const c of cands) {
    exact.set(c.item_code.trim().toUpperCase(), c.item_code);
    add(norm, normCode(c.item_code), c.item_code);
    for (const t of tokens(c.description ?? "")) {
      const n = normCode(t);
      if (n.length >= 4 && /\d/.test(n) && /[A-Z]/.test(n)) add(inDesc, n, c.item_code);
    }
  }
  const one = (s: Set<string> | undefined) => (s && s.size === 1 ? [...s][0] : null);

  const byItem = new Map<string, Matched>();
  const unmatched: Unmatched[] = [];
  for (const ln of lines) {
    let hit: string | null = null;
    let how: MatchHow = "code";
    const suggest = new Set<string>();
    for (const v of [ln.code, ln.model]) {
      if (!hit && v) hit = exact.get(v.trim().toUpperCase()) ?? null;
    }
    if (!hit) {
      for (const v of [ln.code, ln.model]) {
        if (hit || !v) continue;
        const s = norm.get(normCode(v));
        hit = one(s);
        if (hit) how = "normalized";
        else s?.forEach((x) => suggest.add(x));
      }
    }
    if (!hit) {
      const found = new Set<string>();
      for (const t of [ln.code, ln.model, ln.desc, ...ln.texts].flatMap((x) => (x ? tokens(x) : []))) {
        const n = normCode(t);
        if (codeish(n)) norm.get(n)?.forEach((x) => found.add(x));
      }
      if (found.size === 1) { hit = [...found][0]; how = "text"; }
      else found.forEach((x) => suggest.add(x));
    }
    if (!hit) {
      const found = new Set<string>();
      for (const v of [ln.code, ln.model]) {
        const n = v ? normCode(v) : "";
        if (n.length >= 4 && /\d/.test(n)) inDesc.get(n)?.forEach((x) => found.add(x));
      }
      if (found.size === 1) { hit = [...found][0]; how = "description"; }
      else found.forEach((x) => suggest.add(x));
    }
    if (!hit) {
      // 只给建议：厂家代号是我们代号加了颜色 / 尺寸尾码（BS100-WH）
      for (const v of [ln.code, ln.model]) {
        const n = v ? normCode(v) : "";
        if (n.length < 4) continue;
        for (const c of cands) {
          const cn = normCode(c.item_code);
          if (cn.length >= 4 && cn !== n && (n.startsWith(cn) || cn.startsWith(n))) suggest.add(c.item_code);
        }
      }
      unmatched.push({ ...ln, suggest: [...suggest].slice(0, 5) });
      continue;
    }
    const m = byItem.get(hit);
    if (m) { m.qty += ln.qty; m.lines.push(ln); } else byItem.set(hit, { item_code: hit, qty: ln.qty, lines: [ln], how });
  }
  for (const m of byItem.values()) m.qty = Math.round(m.qty * 1000) / 1000;
  return { matched: [...byItem.values()], unmatched };
}

/** 整份档案：各工作表照 plan 读出的资料行 */
export function allLines(sheets: Sheet[], plans: Plan[]): Line[] {
  return sheets.flatMap((sh, i) => (plans[i] ? readLines(sh, plans[i]) : []));
}
