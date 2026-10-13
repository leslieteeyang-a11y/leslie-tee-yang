// 厂家到货草稿的资料列（对得上 PO 的型号、来错的型号、缺零件）与预估少发 / 多发；从 DoEditor.tsx 拆出来（只搬程式码）。
import { Candidate, DoFull, DoPart, IssueRequest, num } from "../podo-api";
import { OtherHit } from "./Import";

export interface Start { company: string; creditor_code: string; supplier_name: string; po_nos: string[] }
/** 对得上 PO 的型号（一个型号一行） */
export interface Row {
  item_code: string;
  shipped: string;
  alloc: Record<string, string>;
  auto: boolean;                 // 只有一间分店订：分配跟著出货数量自动填
  src_code: string; src_desc: string; src_row: number | null;
  note: string;
  excel?: "hit" | "missing";
  showNote?: boolean;
  /** 少发先决定：空 = 未决定（确认时套到自动产生的少发） */
  short_decision: "" | "await" | "cancelled";
}
/** 对不上 PO 的行 = 来错的型号（确认时记成发错型号）。手动加的：own = true 我们的商品 / false 不是我们的产品 / null 还没选；
 *  Excel 读进来的：own = undefined（照 Excel 的写法） */
export interface XRow {
  key: string; manual: boolean; shipped: string; src_code: string; src_desc: string; src_row: number | null; sheet?: string;
  expected_code: string; note: string; suggest: string[]; other?: OtherHit;
  own?: boolean | null; request: IssueRequest | "";
}
/** 缺零件 / 其他要补的（确认时记成厂家问题 kind = part） */
export interface PRow { key: string; item_code: string; part_name: string; qty: string; request: IssueRequest | ""; note: string }

let xseq = 0;
export const xkey = () => `x${++xseq}`;
export const r3 = (n: number) => Math.round(n * 1000) / 1000;
export const allocSum = (r: Row) => r3(Object.values(r.alloc).reduce((s, v) => s + (num(v) || 0), 0));

export function rowsFromFull(full: DoFull): Record<string, Row> {
  const out: Record<string, Row> = {};
  for (const c of full.candidates) out[c.item_code] = blankRow(c.item_code);
  const single = new Map(full.candidates.map((c) => [c.item_code, c.single_outlet]));
  for (const it of full.items) {
    if (!it.item_code) continue;
    const alloc = Object.fromEntries(Object.entries(it.alloc ?? {}).map(([k, v]) => [k, String(v)]));
    const s = single.get(it.item_code);
    const keys = Object.keys(alloc);
    out[it.item_code] = {
      item_code: it.item_code, shipped: String(it.shipped ?? 0), alloc,
      auto: !!s && (keys.length === 0 || (keys.length === 1 && keys[0] === s && Number(alloc[s]) === Number(it.shipped))),
      src_code: it.src_code ?? "", src_desc: it.src_desc ?? "", src_row: it.src_row ?? null, note: it.note ?? "",
      showNote: !!it.note, short_decision: it.short_decision ?? "",
    };
  }
  return out;
}

export function xrowsFromFull(full: DoFull): XRow[] {
  return full.items.filter((it) => !it.item_code).map((it) => {
    const manual = it.src_row == null;
    // 手动加的：照存的 own；以前存的（没有 own）当「不是我们的产品」，照原本打的型号 / 品名
    const own = manual ? (typeof it.own === "boolean" ? it.own : (it.src_code || it.src_desc ? false : null)) : it.own;
    return {
      key: xkey(), manual, shipped: String(it.shipped ?? 0), src_code: it.src_code ?? "", src_desc: it.src_desc ?? "",
      src_row: it.src_row ?? null, expected_code: it.expected_code ?? "", note: it.note ?? "", suggest: [], own,
      request: it.request ?? "",
    };
  });
}

export function prowsFromFull(full: DoFull): PRow[] {
  return (full.parts ?? []).map((x: DoPart) => ({
    key: xkey(), item_code: x.item_code ?? "", part_name: x.part_name ?? "", qty: String(x.qty ?? ""), request: x.request ?? "next",
    note: x.note ?? "",
  }));
}

function blankRow(code: string): Row {
  return { item_code: code, shipped: "0", alloc: {}, auto: false, src_code: "", src_desc: "", src_row: null, note: "", short_decision: "" };
}

/** 预估会记的少发 / 多发（与伺服器 ops_po_do_confirm 同规则）：这张在那几张 PO 出的先补别张 DO 的少发，还欠的跟已记过的比、只记差额；
 *  超出所选 PO 的先补别张 PO「厂家会补」的少发 */
export function estimate(order: string[], rows: Record<string, Row>, candMap: Map<string, Candidate>) {
  return order.map((code) => {
    const c = candMap.get(code);
    const s = num(rows[code].shipped) || 0;
    const rem = c?.remaining ?? 0;
    const fill = Math.min(c?.fillable ?? 0, s, rem);
    const short = r3(Math.max(0, rem - s));
    const over = r3(Math.max(0, s - rem));
    return { c: code, rem, s, short, over, newShort: r3(Math.max(0, short - Math.max(0, (c?.flagged ?? 0) - fill))),
             newOver: r3(Math.max(0, over - (c?.await_elsewhere ?? 0))) };
  });
}
export type Est = ReturnType<typeof estimate>[number];

/** 新的型号：出货预设 = 还可以出；只有一间分店订就先分给那间 */
export function defaultRow(c: Candidate): Row {
  const s = c.remaining > 0 ? String(r3(c.remaining)) : "0";
  return withShipped({ ...blankRow(c.item_code), auto: !!c.single_outlet }, s, c);
}

export function withShipped(r: Row, shipped: string, c?: Candidate): Row {
  const single = c?.single_outlet;
  if (single && (r.auto || Object.values(r.alloc).every((v) => !String(v).trim()))) {
    return { ...r, shipped, alloc: num(shipped) > 0 ? { [single]: shipped } : {}, auto: true };
  }
  return { ...r, shipped };
}

/** 照各分店还可以出的数量分配（出货 = 还可以出合计时才这样分） */
export function allocByRemaining(r: Row, c?: Candidate): Row {
  if (!c) return r;
  const alloc: Record<string, string> = {};
  for (const [o, q] of Object.entries(c.by_outlet)) if (q.remaining > 0) alloc[o] = String(r3(q.remaining));
  return { ...r, alloc, auto: false };
}

/** 全到：出货 = 还可以出，分配照各分店未出（只有一间分店订的照样预填那间） */
export function fullRow(r: Row, c?: Candidate): Row {
  const rem = c ? r3(Math.max(c.remaining, 0)) : 0;
  const x = withShipped({ ...r, alloc: {}, auto: !!c?.single_outlet }, String(rem), c);
  return c && !c.single_outlet && rem > 0 ? allocByRemaining(x, c) : x;
}
