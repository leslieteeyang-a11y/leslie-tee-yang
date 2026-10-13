// 点货表单（每个型号好货 / 坏货、分店分配、来错的货）与送出前的确认；从 Receive.tsx 拆出来（只搬程式码）。
import { useEffect, useMemo, useState } from "react";
import { fmtDate, fmtQty } from "../api";
import { go, setLeaveGuard } from "../router";
import { Modal } from "../ui";
import { IssueRequest, joinList, num, podo, RecvFull, RecvItem, requestLabel, ui } from "../podo-api";
import { ErrorLines, NOT_PICKED, OurItemPicker, Picked, RequestSelect } from "./common";

export const r3 = (n: number) => Math.round(n * 1000) / 1000;
export const sumOf = (xs: number[]) => r3(xs.reduce((s, x) => s + x, 0));
export const doLabel = (d: { id: number; do_no: string | null }) => `DO ${d.do_no || "#" + d.id}`;
export const DAY_OPTIONS = [14, 30, 90, 365];
export type OutletCol = { code: string; name: string; short_name?: string };

// ------------------------------------------------------------------ 点货（可编辑）
interface Line {
  received: string; damaged: string; alloc: Record<string, string>;
  touched: boolean;              // 分配自己改过：好货改了也不自动跟
  note: string; showNote: boolean;
}
/** 来错的货：pick = 收到的型号（我们的商品 own = true，进 location 仓位的库存；不是我们的产品 own = false，不进库存）。
 *  do_row = 开单时 DO 上的那一行（预先带进来的；资料库跟确认时记的那笔对上，不重复记）；seed = 开单时的写法；doNote = 开单备注 */
interface Wrong {
  key: string; pick: Picked; qty: string; expected_code: string; note: string; request: IssueRequest | ""; location: string;
  do_row?: number; seed?: { code: string; desc: string }; doNote?: string;
}
let wseq = 0;
const wkey = () => `w${++wseq}`;
const blankWrong = (loc: string): Wrong => ({ key: wkey(), pick: NOT_PICKED, qty: "", expected_code: "", note: "", request: "", location: loc });
const isBlankWrong = (w: Wrong) => !w.do_row && w.pick.own === null && !w.qty.trim() && !w.expected_code && !w.note.trim() && !w.request;
/** 开单时记的来错型号 → 「来错的货」一行（数量预设 = DO 上的数量；没认出来的要选） */
function fromDo(u: RecvFull["unmatched"][number], loc: string): Wrong {
  const pick: Picked = u.own === true ? { own: true, code: u.src_code, desc: u.src_desc }
    : u.own === false ? { own: false, code: u.src_code, desc: u.src_desc } : NOT_PICKED;
  return {
    key: wkey(), pick, qty: String(r3(Number(u.shipped))), expected_code: u.expected_code ?? "", note: "", request: u.request ?? "",
    location: loc, do_row: u.row, seed: u.own == null ? { code: u.src_code, desc: u.src_desc } : undefined, doNote: u.note,
  };
}

const strAlloc = (a: Record<string, number>) =>
  Object.fromEntries(Object.entries(a ?? {}).filter(([, v]) => Number(v) > 0).map(([k, v]) => [k, String(r3(Number(v)))]));
const cleanAlloc = (a: Record<string, string>) => Object.fromEntries(Object.entries(a).filter(([, v]) => num(v) > 0).map(([k, v]) => [k, r3(num(v))]));
const plannedSum = (it: RecvItem) => sumOf(Object.values(it.alloc ?? {}).map(Number));
const plannedOutlets = (it: RecvItem) => Object.keys(it.alloc ?? {}).filter((k) => Number(it.alloc[k]) > 0);
const lineAllocSum = (l: Line) => sumOf(Object.values(l.alloc).map((v) => num(v) || 0));
const priorD = (it: RecvItem) => Number(it.prior?.damaged ?? 0);
const priorS = (it: RecvItem) => Number(it.prior?.short ?? 0);
const sameAlloc = (a: Record<string, string>, b: Record<string, string | number>) => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every((k) => r3(num(a[k] as string) || 0) === r3(Number(b[k] ?? 0)));
};
/** 改了分店分配：跟确认时的不一样；只有一间分店、好货全给那间（只是数量跟著好货变）不算 */
const splitChanged = (l: Line, it: RecvItem) => {
  if (sameAlloc(l.alloc, it.alloc ?? {})) return false;
  const only = plannedOutlets(it);
  const used = Object.keys(l.alloc).filter((k) => num(l.alloc[k]) > 0);
  return !(only.length === 1 && used.length <= 1 && (used.length === 0 || used[0] === only[0]));
};

/** 好货跟原分配不一样多：少的先从总部扣，总部不够再照分店顺序扣；多的放总部 */
function fitAlloc(it: RecvItem, good: number, order: string[]): Record<string, string> {
  const a: Record<string, number> = {};
  for (const [k, v] of Object.entries(it.alloc ?? {})) if (Number(v) > 0) a[k] = Number(v);
  let diff = r3(good - plannedSum(it));
  const hq = order.includes("HQ") ? "HQ" : order[0];
  if (diff > 0) a[hq] = r3((a[hq] ?? 0) + diff);
  for (const k of [hq, ...order.filter((x) => x !== hq)]) {
    if (diff >= 0) break;
    const take = Math.min(a[k] ?? 0, -diff);
    if (take > 0) { a[k] = r3(a[k] - take); diff = r3(diff + take); }
  }
  return Object.fromEntries(Object.entries(a).filter(([, v]) => v > 0).map(([k, v]) => [k, String(v)]));
}

/** 没自己改过分配时的分配：只有一间分店 = 好货全给那间；多间 = 少的先扣总部、多的放总部 */
function autoAlloc(it: RecvItem, good: number, order: string[]): Record<string, string> {
  const only = plannedOutlets(it);
  if (only.length === 1) return good > 0 ? { [only[0]]: String(r3(good)) } : {};
  return fitAlloc(it, good, order);
}

/** 预设：点货前已经记的坏货 / 到货少先填进去（好货 = 应到 − 已记的），分配照上面的规则 */
function defaultLine(it: RecvItem, order: string[]): Line {
  const s = Number(it.shipped);
  const dmg = r3(Math.min(priorD(it), s));
  const good = r3(Math.max(0, s - dmg - priorS(it)));
  return { received: String(good), damaged: String(dmg), alloc: autoAlloc(it, good, order), touched: false, note: "", showNote: false };
}

function withReceived(l: Line, it: RecvItem, v: string, order: string[]): Line {
  const n = num(v);
  if (l.touched || !v.trim() || Number.isNaN(n)) return { ...l, received: v };
  return { ...l, received: v, alloc: autoAlloc(it, n, order) };
}

interface Calc {
  bad: string | null; s: number; r: number; d: number; a: number;
  short: number; over: number; unalloc: number;
  gap: number; newShort: number; newDmg: number; newOver: number; extraBroken: number; covered: number; mismatch: number;
}
/** 一个型号点完会怎样（与资料库 ops_po_do_receive 同规则）：
 *  缺口 = 应到 − 好货；点货前已记的坏货 + 到货少先算进缺口，不够才补记（坏货最多到点到的坏货，其余记到货少）；
 *  已记的比缺口多 = mismatch（不动它，采购核对）；坏货比缺口多 = 多寄的坏件，算在多到。 */
function calc(it: RecvItem, l: Line): Calc {
  const s = Number(it.shipped);
  const r = num(l.received);
  const d = num(l.damaged);
  const bad = !l.received.trim() ? "还没填好货" : Number.isNaN(r) || Number.isNaN(d) || Object.values(l.alloc).some((v) => Number.isNaN(num(v)))
    ? "不是数字" : null;
  const rr = Number.isNaN(r) ? 0 : r;
  const dd = Number.isNaN(d) ? 0 : d;
  const a = lineAllocSum(l);
  const gap = r3(Math.max(0, s - rr));
  const deff = Math.min(dd, gap);
  const known = priorD(it) + priorS(it);
  const need = r3(Math.max(0, gap - known));
  const newDmg = r3(Math.min(need, Math.max(0, deff - priorD(it))));
  const over = r3(Math.max(0, rr + dd - s));
  return {
    bad, s, r: rr, d: dd, a, short: r3(Math.max(0, s - rr - dd)), over, unalloc: r3(rr - a),
    gap, newShort: r3(need - newDmg), newDmg, newOver: r3(Math.max(0, over - Number(it.prior?.over ?? 0))),
    extraBroken: r3(dd - deff), covered: r3(Math.min(gap, known)), mismatch: r3(Math.max(0, known - gap)),
  };
}
const rowOk = (c: Calc) => !c.bad && c.short === 0 && c.over === 0 && c.d === 0 && c.unalloc === 0 && c.mismatch === 0;

/** 一个型号的状态与按钮（桌面放在最后一栏，手机放在第一栏型号底下） */
function RowState({ it, l, c, outlets, order, onReset }: {
  it: RecvItem; l: Line; c: Calc; outlets: OutletCol[]; order: string[]; onReset: () => void;
}) {
  const ps = plannedSum(it);
  const auto = !c.bad ? autoAlloc(it, c.r, order) : null;
  const canReset = l.touched && auto && !sameAlloc(l.alloc, auto);
  // 没动过、有好几间分店、好货跟原分配不一样多：说清楚自动从哪间扣 / 加
  const deltas = !l.touched && !c.bad && plannedOutlets(it).length > 1 && c.r !== ps
    ? outlets.map((o) => ({ o, n: r3((num(l.alloc[o.code]) || 0) - Number(it.alloc?.[o.code] ?? 0)) })).filter((x) => x.n !== 0)
    : [];
  return (
    <>
      {c.bad ? <span className="late">{c.bad}</span> : (
        <>
          {rowOk(c) && <span className="okc">✓</span>}
          {c.short > 0 && <span className="late">{`少 ${fmtQty(c.short)}`}</span>}
          {c.over > 0 && <span className="amber">{`多 ${fmtQty(c.over)}`}</span>}
          {c.d > 0 && <span className="late">{`坏 ${fmtQty(c.d)}`}</span>}
          {c.unalloc > 0 && <span className="late">{`分配还差 ${fmtQty(c.unalloc)}`}</span>}
          {c.unalloc < 0 && <span className="late">{`多分 ${fmtQty(-c.unalloc)}`}</span>}
          {c.mismatch > 0 && <span className="amber">{`已记的多 ${fmtQty(c.mismatch)}`}</span>}
        </>
      )}
      {deltas.length > 0 && (
        <small className="muted recv-auto">{`自动调整：${deltas.map((x) => `${x.o.short_name || x.o.name} ${x.n > 0 ? "+" : "−"}${fmtQty(Math.abs(x.n))}`).join("、")}（可改）`}</small>
      )}
      {canReset && (
        <button type="button" className="small ghost" onClick={onReset}>
          {c.r === ps ? "照原分配" : c.r < ps ? "少的先扣总部" : "多的放总部"}
        </button>
      )}
    </>
  );
}

export function RecvForm({ d, onDone, onRace }: {
  d: RecvFull; onDone: (next: RecvFull, msg: string) => void; onRace: (msg: string) => void;
}) {
  const outlets = d.outlets;
  const order = outlets.map((o) => o.code);
  const [lines, setLines] = useState<Record<string, Line>>(() => Object.fromEntries(d.items.map((it) => [it.item_code, defaultLine(it, order)])));
  const mainLoc = d.main_location || "HQ";
  // 开单时记的来错型号先带进来（是我们的型号才会进库存；不是我们的产品照样只记问题）
  const [wrong, setWrong] = useState<Wrong[]>(() => d.unmatched.filter((u) => u.row).map((u) => fromDo(u, mainLoc)));
  const [note, setNote] = useState("");
  const [dirty, setDirty] = useState(false);
  const [q, setQ] = useState("");
  const [onlyIssues, setOnlyIssues] = useState(false);
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState(false);

  // 有改没送出：关分页 / 换页前先问
  useEffect(() => {
    if (!dirty) return;
    const on = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", on);
    setLeaveGuard(() => window.confirm(ui("点货还没送出，确定离开？")));
    return () => { window.removeEventListener("beforeunload", on); setLeaveGuard(null); };
  }, [dirty]);

  const touch = () => { setDirty(true); setError(""); };
  const setLine = (code: string, f: (l: Line) => Line) => { setLines((prev) => ({ ...prev, [code]: f(prev[code]) })); touch(); };
  const setW = (key: string, patch: Partial<Wrong>) => { setWrong((prev) => prev.map((w) => (w.key === key ? { ...w, ...patch } : w))); touch(); };
  const hasPrior = d.items.some((it) => priorD(it) + priorS(it) > 0);

  const allAsShipped = () => {
    setLines(Object.fromEntries(d.items.map((it) => [it.item_code, {
      ...lines[it.item_code], received: String(r3(Number(it.shipped))), damaged: "0", alloc: strAlloc(it.alloc), touched: false,
    }])));
    touch();
  };

  const shown = d.items.filter((it) => {
    const k = q.trim().toLowerCase();
    if (k && !it.item_code.toLowerCase().includes(k) && !(it.description ?? "").toLowerCase().includes(k)) return false;
    if (!onlyIssues) return true;
    return !rowOk(calc(it, lines[it.item_code])) || splitChanged(lines[it.item_code], it);
  });

  // ------------------------------------------------ 检查（与资料库同样的讯息）
  function problems(): string[] {
    const out: string[] = [];
    for (const it of d.items) {
      const l = lines[it.item_code];
      const code = it.item_code;
      if (!l.received.trim()) { out.push(`型号 ${code} 请填好货收到几件。`); continue; }
      if (Number.isNaN(num(l.received))) { out.push(`型号 ${code} 的好货数量不是数字。`); continue; }
      if (Number.isNaN(num(l.damaged))) { out.push(`型号 ${code} 的坏货数量不是数字。`); continue; }
      const badO = Object.entries(l.alloc).find(([, v]) => Number.isNaN(num(v)));
      if (badO) { out.push(`型号 ${code} 分到 ${badO[0]} 的数量不是数字。`); continue; }
      const c = calc(it, l);
      if (c.unalloc !== 0) out.push(`型号 ${code} 好货 ${fmtQty(c.r)} 件，分到各分店合计 ${fmtQty(c.a)} 件：要相等。`);
    }
    wrong.forEach((w, i) => {
      if (isBlankWrong(w)) return;
      if (w.pick.own === null) out.push(`来错的货第 ${i + 1} 行：请从清单选我们的型号，或按「不是我们的产品」。`);
      else if (w.pick.own === false && !w.pick.desc.trim()) out.push(`来错的货第 ${i + 1} 行「不是我们的产品」请填品名。`);
      else if (Number.isNaN(num(w.qty))) out.push(`来错的货第 ${i + 1} 行的数量不是数字。`);
      else if (!(num(w.qty) > 0)) out.push(`来错的货第 ${i + 1} 行请填数量。`);
    });
    return [...new Set(out)];
  }

  function payload() {
    return {
      id: d.id,
      items: d.items.map((it) => {
        const l = lines[it.item_code];
        return { item_code: it.item_code, received: num(l.received), damaged: num(l.damaged) || 0, alloc: cleanAlloc(l.alloc), note: l.note.trim() };
      }),
      // 整行空白的也送（资料库略过），「第几行」才跟画面一样
      wrong: wrong.map((w) => isBlankWrong(w) ? { received_code: "", description: "", qty: null, note: "" } : ({
        received_code: w.pick.code.trim(), description: w.pick.desc.trim(), expected_code: w.expected_code || null,
        qty: w.qty.trim() === "" ? null : num(w.qty), note: w.note.trim(), request: w.request || null,
        ...(w.pick.own === null ? {} : { own: w.pick.own }), ...(w.pick.own ? { location: w.location || mainLoc } : {}),
        ...(w.do_row ? { do_row: w.do_row } : {}),
      })),
      note: note.trim(),
    };
  }

  const totals = useMemo(() => {
    const cs = d.items.map((it) => calc(it, lines[it.item_code]));
    return {
      s: sumOf(cs.map((c) => c.s)), r: sumOf(cs.map((c) => c.r)), d: sumOf(cs.map((c) => c.d)),
      o: Object.fromEntries(order.map((o) => [o, sumOf(d.items.map((it) => num(lines[it.item_code].alloc[o]) || 0))])),
    };
  }, [d.items, lines]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <div className="ok">{`在路上（${d.confirmed_by_name ?? ""} · ${fmtDate(d.confirmed_at)} 确认）。货到了：照实际收到的填，点完按「点完，货到了」。`}</div>
      <div className="card podo-items">
        <h3>{`点货（${d.items.length} 个型号）`}</h3>
        <p className="muted small">好货预设 = 应到；有坏的填坏货（坏货不分给分店）。好货一定要分完：各分店合计 = 好货。灰字「原」是确认时的分配。</p>
        <p className="muted small">每行的「＋ 备注」会带进厂家问题（到货少 / 坏货 / 多到），印在给厂家的清单与 WhatsApp 讯息上；只给自己人看的写在最下面的「整张备注」。</p>
        <p className="muted small">好货改少了，没动过分配的型号会自动从总部先扣（多了放总部）；要别的分法直接改分店的数字。</p>
        {hasPrior && <p className="small amber">有型号点货前已经记了坏货 / 到货少：已先填进好货、坏货，实际不同请改。</p>}
        <div className="toolbar">
          {d.items.length > 8 && <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="找型号 / 品名…" />}
          <label className="check"><input type="checkbox" checked={onlyIssues} onChange={(e) => setOnlyIssues(e.target.checked)} /> 只看有改的</label>
          <button type="button" className="small ghost" onClick={allAsShipped}>全部照应到</button>
        </div>
        <div className="table-wrap flat">
          <table className="podo-table recv-table">
            <thead>
              <tr>
                <th className="sticky">型号 / 品名</th>
                <th className="num">应到</th>
                <th className="num">好货</th>
                <th className="num">坏货</th>
                {outlets.map((o) => <th key={o.code} className="num"><span>{o.short_name || o.name}</span><br /><small>好货分到</small></th>)}
                <th className="recv-lg">状态</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((it) => {
                const code = it.item_code;
                const l = lines[code];
                const c = calc(it, l);
                const reset = () => setLine(code, (x) => ({ ...x, alloc: autoAlloc(it, num(x.received) || 0, order), touched: false }));
                const allocParts = outlets.map((o) => ({ o, n: num(l.alloc[o.code]) || 0 })).filter((x) => x.n > 0);
                return (
                  <tr key={code} className={rowOk(c) ? "" : "recv-diff"}>
                    <td className="sticky">
                      <b>{code}</b> <small className="muted">{it.uom}</small><br />
                      <small>{it.description}</small>
                      {it.note && <small className="pre recv-do-note">{`开单备注：${it.note}`}</small>}
                      {(priorD(it) > 0 || priorS(it) > 0) && (
                        <div className="podo-tags">
                          {priorD(it) > 0 && <span className="tag warn">{`已记坏货 ${fmtQty(priorD(it))}`}</span>}
                          {priorS(it) > 0 && <span className="tag warn">{`已记到货少 ${fmtQty(priorS(it))}`}</span>}
                        </div>
                      )}
                      {/* 手机：分店栏在画面外，状态、分配、按钮放在型号底下 */}
                      <div className="recv-sm recv-state">
                        <RowState it={it} l={l} c={c} outlets={outlets} order={order} onReset={reset} />
                        {outlets.length > 1 && allocParts.length > 0 && (
                          <small className="recv-alloc">
                            {allocParts.map((x) => <span key={x.o.code}><span>{x.o.short_name || x.o.name}</span> {fmtQty(x.n)}</span>)}
                          </small>
                        )}
                      </div>
                      {!l.showNote && <button type="button" className="text-btn small" onClick={() => setLine(code, (x) => ({ ...x, showNote: true }))}>＋ 备注</button>}
                      {l.showNote && <input className="podo-note" value={l.note} placeholder="备注（会给厂家看，例：外箱压坏、有拍照）" title="会带进厂家问题、印在给厂家的清单 / 讯息上"
                                            onChange={(e) => setLine(code, (x) => ({ ...x, note: e.target.value }))} />}
                    </td>
                    <td className="num"><b>{fmtQty(it.shipped)}</b></td>
                    <td className="num">
                      <input className="podo-num" inputMode="decimal" value={l.received} aria-label={`${code} 好货`}
                             onChange={(e) => setLine(code, (x) => withReceived(x, it, e.target.value, order))} />
                    </td>
                    <td className="num">
                      <input className="podo-num" inputMode="decimal" value={l.damaged} aria-label={`${code} 坏货`}
                             onChange={(e) => setLine(code, (x) => ({ ...x, damaged: e.target.value }))} />
                    </td>
                    {outlets.map((o) => {
                      const p = Number(it.alloc?.[o.code] ?? 0);
                      const changed = r3(num(l.alloc[o.code]) || 0) !== r3(p);
                      return (
                        <td key={o.code} className="num">
                          <input className={"podo-num" + (changed ? " changed" : "")} inputMode="decimal" value={l.alloc[o.code] ?? ""}
                                 aria-label={`${code} ${o.short_name || o.name}`}
                                 onChange={(e) => setLine(code, (x) => ({ ...x, alloc: { ...x.alloc, [o.code]: e.target.value }, touched: true }))} />
                          <br /><small className="muted">{p > 0 ? `原 ${fmtQty(p)}` : "—"}</small>
                        </td>
                      );
                    })}
                    <td className="nowrap recv-state recv-lg">
                      <RowState it={it} l={l} c={c} outlets={outlets} order={order} onReset={reset} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <td className="sticky"><b>合计</b></td>
                <td className="num"><b>{fmtQty(totals.s)}</b></td>
                <td className="num"><b>{fmtQty(totals.r)}</b></td>
                <td className="num"><b>{fmtQty(totals.d)}</b></td>
                {outlets.map((o) => <td key={o.code} className="num"><b>{fmtQty(totals.o[o.code])}</b></td>)}
                <td className="recv-lg"></td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      {/* 来错的货：一行一张小卡（手机也看得到全部栏位） */}
      <div className="card podo-items">
        <h3>{`来错的货（${wrong.length}）`}</h3>
        <p className="muted small">收到不是这张 DO 的型号（例：订白色收到黑色）：一种一行，搜我们的型号（会进仓库库存）或按「不是我们的产品」，填数量；知道本来应该是哪个型号就选。会记成「发错型号」给采购找厂家；备注会印在给厂家的清单 / 讯息上。</p>
        {d.unmatched.length > 0 && (
          <p className="small amber">{`开单时记的来错型号（${d.unmatched.length} 行）已经带进下面：请照实际点到的数量改；是我们的型号会进仓库库存，没认出来的请选我们的型号或「不是我们的产品」；没收到就拿掉。`}</p>
        )}
        {wrong.map((w, i) => (
          <div key={w.key} className="recv-wrong-card">
            <div className="recv-wrong-head">
              <b className="small">{`第 ${i + 1} 行`}</b>
              {w.do_row && <span className="tag">开单时记的</span>}
              <button type="button" className="small ghost danger" onClick={() => { setWrong(wrong.filter((x) => x.key !== w.key)); touch(); }}>拿掉</button>
            </div>
            {w.do_row && w.pick.own === null && (
              <p className="wide small amber">
                {`开单时没认出来：${[w.seed?.code, w.seed?.desc].filter(Boolean).join(" ") || "（厂家写的型号）"}。请选我们的型号，或按「不是我们的产品」；没收到就拿掉。`}
              </p>
            )}
            {w.doNote && <small className="wide muted pre">{`开单备注：${w.doNote}`}</small>}
            <div className="wide pick-field">
              <span className="pick-label">收到的型号</span>
              <OurItemPicker company={d.company} value={w.pick} onChange={(v) => setW(w.key, { pick: v })} seed={w.seed} />
            </div>
            <label>数量<input className="podo-num" inputMode="decimal" value={w.qty} aria-label="来错数量" onChange={(e) => setW(w.key, { qty: e.target.value })} /></label>
            {w.pick.own && (
              <label>放哪个仓位
                <select value={w.location} aria-label="放哪个仓位" onChange={(e) => setW(w.key, { location: e.target.value })}>
                  {(d.locations?.length ? d.locations : [mainLoc]).map((l) => <option key={l} value={l}>{l}</option>)}
                </select>
              </label>
            )}
            <label>本来应该是
              <select value={w.expected_code} aria-label="本来应该是" onChange={(e) => setW(w.key, { expected_code: e.target.value })}>
                <option value="">—</option>
                {d.items.map((it) => <option key={it.item_code} value={it.item_code}>{it.item_code}</option>)}
              </select>
            </label>
            <label>要厂家怎么处理
              <RequestSelect kind="wrong" value={w.request} onChange={(v) => setW(w.key, { request: v })} />
            </label>
            <label className="wide">备注（会印在给厂家的清单 / 讯息上）<input value={w.note} placeholder="例：订白色收到黑色" aria-label="备注" onChange={(e) => setW(w.key, { note: e.target.value })} /></label>
          </div>
        ))}
        <button type="button" className="small ghost" onClick={() => { setWrong([...wrong, blankWrong(mainLoc)]); touch(); }}>＋ 加一行来错的货</button>
        <label className="recv-note">整张备注（可空白，只给自己人看）
          <textarea rows={2} value={note} onChange={(e) => { setNote(e.target.value); touch(); }} placeholder="例：外箱湿了、司机晚到" />
        </label>
      </div>

      <div className="podo-actions">
        <div className="podo-msgs" aria-live="polite">
          <ErrorLines error={error} />
          {dirty && !error && <p className="muted small">点货还没送出。</p>}
        </div>
        <div className="actions left">
          <button onClick={() => {
            const bad = problems();
            if (bad.length) { setError(bad.slice(0, 5).join("\n")); return; }
            setError("");
            setConfirming(true);
          }}>点完，货到了</button>
          <button className="ghost" onClick={() => go("/purchasing/receive")}>回点货清单</button>
        </div>
      </div>

      {confirming && (
        <RecvConfirm d={d} lines={lines} wrong={wrong.filter((w) => !isBlankWrong(w))} onClose={() => setConfirming(false)}
                     onOk={async () => {
                       let next: RecvFull;
                       try {
                         next = await podo.receive(payload());
                       } catch (e) {
                         const m = (e as Error).message;
                         // 别人已经先点完这张：不卡在对话框，直接看点货纪录
                         if (m.includes("已经点过货了")) { setDirty(false); setLeaveGuard(null); onRace(m); return; }
                         throw e;
                       }
                       setDirty(false);
                       setLeaveGuard(null);
                       const n = next.receipt?.issue_ids.length ?? 0;
                       // 没有新记的问题：可能是真的全部到齐，也可能是同样的问题之前已经记过（例：来错的型号确认时就记了）
                       const noted = wrong.some((w) => !isBlankWrong(w)) || d.unmatched.length > 0
                         || d.items.some((it) => !rowOk(calc(it, lines[it.item_code])));
                       onDone(next, n ? `已点完货：${n} 笔记进厂家问题。` : noted ? "已点完货：这些问题之前已经记过，没有新增。" : "已点完货：全部到齐。");
                     }} />
      )}
    </>
  );
}

// ------------------------------------------------------------------ 送出前：会记进厂家问题的
function RecvConfirm({ d, lines, wrong, onClose, onOk }: {
  d: RecvFull; lines: Record<string, Line>; wrong: Wrong[]; onClose: () => void; onOk: () => Promise<void>;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const rows = d.items.map((it) => ({ it, c: calc(it, lines[it.item_code]) }));
  // 与资料库同规则：点货前已记的先算进缺口，只补记多出来的
  const shorts = rows.filter((x) => x.c.newShort > 0);
  const dmgs = rows.filter((x) => x.c.newDmg > 0);
  const overs = rows.filter((x) => x.c.newOver > 0);
  const covered = rows.filter((x) => x.c.covered > 0 && x.c.newShort + x.c.newDmg === 0);
  const mism = rows.filter((x) => x.c.mismatch > 0);
  const moved = rows.filter((x) => splitChanged(lines[x.it.item_code], x.it));
  const byOutlet = d.outlets.map((o) => ({ o, n: sumOf(d.items.map((it) => num(lines[it.item_code].alloc[o.code]) || 0)) })).filter((x) => x.n > 0);
  const good = sumOf(rows.map((x) => x.c.r));
  const nothing = rows.every((x) => x.c.gap === 0 && x.c.over === 0 && x.c.mismatch === 0) && !wrong.length && !d.unmatched.length;

  async function ok() {
    setBusy(true);
    setError("");
    try {
      await onOk();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  type X = (typeof rows)[number];
  const list = (xs: X[], f: (x: X) => string) => (
    <ul className="list small">
      {xs.slice(0, 20).map((x) => (
        <li key={x.it.item_code}><span>{x.it.item_code}</span><span>{f(x)}</span></li>
      ))}
      {xs.length > 20 && <li><span className="muted">{`还有 ${xs.length - 20} 个`}</span></li>}
    </ul>
  );

  return (
    <Modal title="点完，货到了" onClose={onClose} wide>
      <p>
        {`好货共 ${fmtQty(good)} 件。`}
        {byOutlet.map((x) => <span key={x.o.code} className="tag outlet">{`${x.o.short_name || x.o.name} ${fmtQty(x.n)}`}</span>)}
      </p>
      <p className="muted small">确定后：这张 DO 算到货（各分店的「在路上」拿掉这张），下面的问题记进「厂家问题」给采购找厂家。点完不能撤回。</p>
      <p className="muted small">好货（和来错的我们的型号）马上算进仓库库存（查货、盘点的「应有」），开单部在 AutoCount 开好进货单（GRN）后按「已输入」。坏货不进库存。</p>
      {nothing && <div className="ok">全部照 DO 到齐，没有要记的厂家问题。</div>}
      {shorts.length > 0 && <><h3>{`到货少（${shorts.length}）`}</h3>{list(shorts, (x) => `应到 ${fmtQty(x.c.s)} · 好货 ${fmtQty(x.c.r)} · 坏货 ${fmtQty(x.c.d)} · 少 ${fmtQty(x.c.newShort)}`)}</>}
      {dmgs.length > 0 && <><h3>{`坏货（${dmgs.length}）`}</h3>{list(dmgs, (x) => `坏 ${fmtQty(x.c.newDmg)}`)}</>}
      {overs.length > 0 && (
        <><h3>{`多到（${overs.length}）`}</h3>
          {list(overs, (x) => `应到 ${fmtQty(x.c.s)} · 到了 ${fmtQty(r3(x.c.r + x.c.d))} · 多 ${fmtQty(x.c.newOver)}${x.c.extraBroken > 0 ? `（其中坏的 ${fmtQty(x.c.extraBroken)} 件）` : ""}`)}</>
      )}
      {covered.length > 0 && <><h3>{`点货前已记过（${covered.length}）`}</h3>{list(covered, (x) => `少 ${fmtQty(x.c.gap)} · 已记 ${fmtQty(x.c.covered)}，不重复记`)}</>}
      {mism.length > 0 && (
        <>
          <h3>{`跟已记的不一样（${mism.length}）`}</h3>
          {list(mism, (x) => `已记坏货 / 到货少 ${fmtQty(priorD(x.it) + priorS(x.it))} · 点到少 ${fmtQty(x.c.gap)}`)}
          <p className="small amber">点货前记的比点到的多：点完后请采购到「厂家问题」核对，多记的作废。</p>
        </>
      )}
      {wrong.length > 0 && (
        <>
          <h3>{`来错的货（${wrong.length}）`}</h3>
          <ul className="list small">
            {wrong.map((w) => (
              <li key={w.key}>
                <span>{w.pick.code || w.pick.desc || w.note}
                  {w.do_row ? <small className="muted">{" · 开单时记的"}</small> : null}
                  {w.pick.own ? <small className="muted">{` · 进 ${w.location || d.main_location || "HQ"}`}</small> : w.pick.own === false ? <small className="muted">{" · 不是我们的产品"}</small> : null}
                  {w.expected_code ? <small className="muted">{` · 本来应该是 ${w.expected_code}`}</small> : null}
                  {w.request ? <small className="muted">{` · 要厂家：${requestLabel("wrong", w.request)}`}</small> : null}</span>
                <span>{fmtQty(num(w.qty))}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {moved.length > 0 && (
        <>
          <p className="small">{`改了分店分配的型号：${joinList(moved.map((x) => x.it.item_code))}`}</p>
          <p className="muted small">总部送货去分店时照这里分；少到的件数算在被减的分店，下一张厂家到货会预设分给它。</p>
        </>
      )}
      <ErrorLines error={error} />
      <div className="actions">
        <button type="button" className="ghost" onClick={onClose}>再检查一下</button>
        <button type="button" disabled={busy} onClick={ok}>{busy ? "送出中…" : "确定，货到了"}</button>
      </div>
    </Modal>
  );
}
