// 点货：厂家的货到了，仓库（或订货「可编辑」的人；确认这张 DO 的人除外）点每个型号实际收到几件（好货、坏货），来错的货另外记，
// 好货分给各分店的数量由点货的人自己改（没动过分配的型号，好货一改就自动「少的先扣总部、多的放总部」），按「点完，货到了」→
// 这张 DO 算到货（各分店的「在路上」拿掉）；到货少 / 坏货 / 多到 / 来错自动记进「厂家问题」（采购照清单找厂家）。点完不能撤回。
// 预设：点货前已经记的坏货 / 到货少先填进去（好货 = 应到 − 已记的），资料库也只补记比已记的多出来的。
// #/purchasing/receive：待点货（ETA 近的在前）+ 最近点过（14 / 30 / 90 / 365 天、可搜寻）；#/purchasing/receive/<DO id>：点一张，或看点货纪录。
// 不含价格。看不到厂家的人（资料库已遮）：没有厂家、DO 号、PO 号、货柜、附件。分店栏由资料库给：总部账套四间、JB 账套只有 JB。
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { BRANCH_LABEL, can, fmtDate, fmtQty, Me, seesSupplier } from "../api";
import { go, setLeaveGuard } from "../router";
import { Empty, ErrorBox, Modal } from "../ui";
import {
  DECISION_LABEL, issueKindLabel, ISSUE_STATUS_LABEL, joinList, num, podo, Receipt, RecvFull, RecvItem, RecvList, RecvRow,
  RecvSummary, ui,
} from "../podo-api";
import { DoStatusBadge, ErrorLines, EtaText, FileList, outletName, useOutlets } from "./common";
import { AddIssueModal } from "./Issues";

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const sumOf = (xs: number[]) => r3(xs.reduce((s, x) => s + x, 0));
const doLabel = (d: { id: number; do_no: string | null }) => `DO ${d.do_no || "#" + d.id}`;
const DAY_OPTIONS = [14, 30, 90, 365];
type OutletCol = { code: string; name: string; short_name?: string };

export default function ReceiveTab({ me, idParam }: { me: Me; idParam?: string }) {
  if (!idParam) return <RecvListView me={me} />;
  const id = Number(idParam);
  if (!Number.isInteger(id) || id <= 0) return <><BackLink /><ErrorBox error="找不到这张厂家 DO。" /></>;
  return <RecvLoad me={me} id={id} />;
}

function BackLink() {
  return <p className="small"><a href="#/purchasing/receive">← 点货清单</a></p>;
}

// ------------------------------------------------------------------ 清单
function RecvListView({ me }: { me: Me }) {
  const [company, setCompany] = useState("");
  const [days, setDays] = useState(14);
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [data, setData] = useState<RecvList | null>(null);
  const [error, setError] = useState("");
  const outlets = useOutlets();

  useEffect(() => {
    setData(null);
    setError("");
    podo.receiveList({ company, days, q: query }).then(setData).catch((e: Error) => setError(e.message));
  }, [company, days, query]);

  return (
    <>
      <p className="muted">
        {"厂家的货到了：点每个型号实际收到几件（好货、坏货），来错的货另外记；好货分给各分店的数量可以改。点完按「点完，货到了」。"}
        <br />{"到货少、坏货、多到、来错会自动记进「厂家问题」，采购照清单找厂家。"}
      </p>
      <form className="toolbar" onSubmit={(e: FormEvent) => { e.preventDefault(); setQuery(q.trim()); }}>
        {me.staff.branch === "ALL" && (
          <select value={company} onChange={(e) => setCompany(e.target.value)}>
            <option value="">全部分店</option>
            <option value="HOMEWORKSSB">{BRANCH_LABEL.HOMEWORKSSB}</option>
            <option value="HOMEWORKSSOUTHERN">{BRANCH_LABEL.HOMEWORKSSOUTHERN}</option>
          </select>
        )}
        <input value={q} onChange={(e) => setQ(e.target.value)}
               placeholder={seesSupplier(me) ? "找 DO 号 / 厂家 / PO / 型号…" : "找型号 / 品名…"} />
        <button type="submit" className="ghost">找</button>
        {query && <button type="button" className="ghost" onClick={() => { setQ(""); setQuery(""); }}>清除</button>}
      </form>
      <ErrorBox error={error} />
      {data === null ? <p className="muted">{error ? "" : "载入中…"}</p> : (
        <>
          <h3>{`待点货（${data.todo.length}）`}</h3>
          {data.todo.length === 0 ? <Empty>{query ? "找不到符合的厂家货。" : "没有要点的货。"}</Empty>
            : <RecvTable rows={data.todo} me={me} outlets={outlets} todo />}
          <div className="podo-group-head">
            <h3>{`最近点过（${data.done.length}）`}</h3>
            <select className="recv-days" value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="最近几天">
              {DAY_OPTIONS.map((n) => <option key={n} value={n}>{`最近 ${n} 天`}</option>)}
            </select>
          </div>
          {data.done.length === 0 ? <p className="muted small">{query ? "找不到符合的点货纪录。" : `最近 ${days} 天没有点过货。`}</p>
            : <RecvTable rows={data.done} me={me} outlets={outlets} />}
        </>
      )}
    </>
  );
}

/** 点货结果的小标签（清单、DO 画面共用）：点货时的到货少 / 坏货 / 多到 / 来错；已记的比点到的多；点完之后才补记的 */
export function SummaryTags({ s }: { s: RecvSummary }) {
  const n = Number(s.short) + Number(s.damaged) + Number(s.over) + Number(s.wrong);
  const later = s.later ?? { damaged: 0, short: 0, wrong: 0 };
  const laterN = Number(later.damaged) + Number(later.short) + Number(later.wrong);
  return (
    <>
      {n === 0 && <span className="okc">{laterN ? "点货时全部到齐" : "全部到齐"}</span>}
      {Number(s.short) > 0 && <span className="tag warn">{`到货少 ${fmtQty(s.short)}`}</span>}
      {Number(s.damaged) > 0 && <span className="tag warn">{`坏货 ${fmtQty(s.damaged)}`}</span>}
      {Number(s.over) > 0 && <span className="tag transit">{`多到 ${fmtQty(s.over)}`}</span>}
      {Number(s.wrong) > 0 && <span className="tag warn">{`来错 ${fmtQty(s.wrong)}`}</span>}
      {Number(s.mismatch ?? 0) > 0 && <span className="tag transit">{`已记的比点到的多 ${fmtQty(s.mismatch)}`}</span>}
      {Number(later.damaged) > 0 && <span className="tag">{`之后补记坏货 ${fmtQty(later.damaged)}`}</span>}
      {Number(later.short) > 0 && <span className="tag">{`之后补记到货少 ${fmtQty(later.short)}`}</span>}
      {Number(later.wrong) > 0 && <span className="tag">{`之后补记来错 ${fmtQty(later.wrong)}`}</span>}
    </>
  );
}

function RecvTable({ rows, me, outlets, todo }: { rows: RecvRow[]; me: Me; outlets: OutletCol[]; todo?: boolean }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>厂家到货</th><th>ETA</th><th className="hide-sm">分到</th><th className="num">出货</th>
            <th>{todo ? "" : "点货"}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => (
            <tr key={d.id} className="click" onClick={() => go(`/purchasing/receive/${d.id}`)}>
              <td>
                <b>{doLabel(d)}</b>
                {me.staff.branch === "ALL" && <span className="tag">{BRANCH_LABEL[d.company]}</span>}
                {(d.supplier_name || d.creditor_code) && <><br /><span className="muted">{d.supplier_name || d.creditor_code}</span></>}
                {d.do_date && <><br /><small className="muted">{`DO 日期 ${d.do_date}`}</small></>}
              </td>
              <td className="nowrap">
                <EtaText eta={d.eta} source={d.eta_source} arrived={!todo} />
                {d.shipment_name && <><br /><small className="muted">{`柜 ${d.shipment_name}`}</small></>}
              </td>
              <td className="hide-sm">
                {d.outlets.map((o) => <span key={o} className="tag outlet">{outletName(outlets, o)}</span>)}
              </td>
              <td className="num">
                {fmtQty(d.shipped_total)}<br /><small className="muted">{`${d.item_count} 个型号`}</small>
              </td>
              <td className="nowrap">
                {todo ? (d.self_confirmed
                  ? <small className="muted">你确认的：请仓库同事点</small>
                  : <button className="small" onClick={(e) => { e.stopPropagation(); go(`/purchasing/receive/${d.id}`); }}>点货</button>) : (
                  <>
                    {d.summary && <SummaryTags s={d.summary} />}
                    <br /><small className="muted">{`${d.arrived_by_name ?? ""} · ${fmtDate(d.arrived_at)}`}</small>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ------------------------------------------------------------------ 一张：载入
function RecvLoad({ me, id }: { me: Me; id: number }) {
  const [data, setData] = useState<RecvFull | null>(null);
  const [flash, setFlash] = useState("");
  const [error, setError] = useState("");
  const load = useCallback(() => podo.receiveGet(id).then(setData).catch((e: Error) => setError(e.message)), [id]);
  useEffect(() => { load(); }, [load]);
  if (!data) return <><BackLink />{error ? <ErrorBox error={error} /> : <p className="muted">载入中…</p>}</>;
  return (
    <>
      <BackLink />
      <RecvHead me={me} d={data} />
      {data.can_receive
        ? <RecvForm key={`${data.id}:${data.status}`} d={data}
                    onDone={(next, msg) => { setFlash(msg); setData(next); window.scrollTo(0, 0); }}
                    onRace={(msg) => { setFlash("!" + msg); load(); window.scrollTo(0, 0); }} />
        : <ReceiptView me={me} d={data} flash={flash} onChanged={() => { setFlash(""); load(); }} />}
    </>
  );
}

function RecvHead({ me, d }: { me: Me; d: RecvFull }) {
  return (
    <>
      <div className="page-head">
        <h2>
          {doLabel(d)} <DoStatusBadge status={d.status} />
          {me.staff.branch === "ALL" && <span className="tag">{BRANCH_LABEL[d.company]}</span>}
        </h2>
      </div>
      {(d.supplier_name || d.creditor_code) && (
        <p className="muted">
          <b>{d.supplier_name || d.creditor_code}</b>
          {d.creditor_code && d.supplier_name ? ` · ${d.creditor_code}` : ""}
          {d.po_nos.length > 0 ? ` · PO ${joinList(d.po_nos)}` : ""}
        </p>
      )}
      <p className="small">
        {"ETA "}<EtaText eta={d.eta} source={d.eta_source} arrived={d.status !== "confirmed"} />
        {d.shipment_name && <span className="tag">{`柜 ${d.shipment_name}`}</span>}
        {d.do_date && <small className="muted">{" · "}{`DO 日期 ${d.do_date}`}</small>}
      </p>
      {d.remark && <p className="small pre">{`备注：${d.remark}`}</p>}
      {d.files.length > 0 && (
        <details className="podo-history" open={d.can_receive}>
          <summary>{`厂家 DO / 装箱单（${d.files.length}）`}</summary>
          <FileList files={d.files} />
        </details>
      )}
      {can(me, "purchasing", "edit") && <p className="small"><a href={`#/purchasing/do/${d.id}`}>打开这张厂家到货 →</a></p>}
    </>
  );
}

// ------------------------------------------------------------------ 点货（可编辑）
interface Line {
  received: string; damaged: string; alloc: Record<string, string>;
  touched: boolean;              // 分配自己改过：好货改了也不自动跟
  note: string; showNote: boolean;
}
interface Wrong { key: string; received_code: string; description: string; qty: string; expected_code: string; note: string }
let wseq = 0;
const wkey = () => `w${++wseq}`;
const blankWrong = (): Wrong => ({ key: wkey(), received_code: "", description: "", qty: "", expected_code: "", note: "" });
const isBlankWrong = (w: Wrong) => !w.received_code.trim() && !w.description.trim() && !w.qty.trim() && !w.expected_code && !w.note.trim();

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

function RecvForm({ d, onDone, onRace }: {
  d: RecvFull; onDone: (next: RecvFull, msg: string) => void; onRace: (msg: string) => void;
}) {
  const outlets = d.outlets;
  const order = outlets.map((o) => o.code);
  const [lines, setLines] = useState<Record<string, Line>>(() => Object.fromEntries(d.items.map((it) => [it.item_code, defaultLine(it, order)])));
  const [wrong, setWrong] = useState<Wrong[]>([]);
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
      if (!w.received_code.trim() && !w.note.trim()) out.push(`来错的货第 ${i + 1} 行请填收到的型号或备注。`);
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
      wrong: wrong.map((w) => ({
        received_code: w.received_code.trim(), description: w.description.trim(), expected_code: w.expected_code || null,
        qty: w.qty.trim() === "" ? null : num(w.qty), note: w.note.trim(),
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
                      {l.showNote && <input className="podo-note" value={l.note} placeholder="备注（例：外箱压坏、有拍照）" onChange={(e) => setLine(code, (x) => ({ ...x, note: e.target.value }))} />}
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
        <p className="muted small">收到不是这张 DO 的型号（例：订白色收到黑色）：一种一行，填收到的型号和数量；知道本来应该是哪个型号就选。会记成「发错型号」给采购找厂家。</p>
        {d.unmatched.length > 0 && (
          <p className="muted small">{`确认时已记成发错型号（厂家 DO 对不上 PO 的行）：${joinList(d.unmatched.map((u) => `${u.src_code || u.src_desc} × ${fmtQty(u.shipped)}`))}。点到的是这些就不用再填。`}</p>
        )}
        {wrong.map((w, i) => (
          <div key={w.key} className="recv-wrong-card">
            <div className="recv-wrong-head">
              <b className="small">{`第 ${i + 1} 行`}</b>
              <button type="button" className="small ghost danger" onClick={() => { setWrong(wrong.filter((x) => x.key !== w.key)); touch(); }}>拿掉</button>
            </div>
            <label>收到的型号<input value={w.received_code} placeholder="收到的型号" aria-label="收到的型号" onChange={(e) => setW(w.key, { received_code: e.target.value })} /></label>
            <label>数量<input className="podo-num" inputMode="decimal" value={w.qty} aria-label="来错数量" onChange={(e) => setW(w.key, { qty: e.target.value })} /></label>
            <label>本来应该是
              <select value={w.expected_code} aria-label="本来应该是" onChange={(e) => setW(w.key, { expected_code: e.target.value })}>
                <option value="">—</option>
                {d.items.map((it) => <option key={it.item_code} value={it.item_code}>{it.item_code}</option>)}
              </select>
            </label>
            <label>品名<input value={w.description} placeholder="品名" aria-label="品名" onChange={(e) => setW(w.key, { description: e.target.value })} /></label>
            <label className="wide">备注<input value={w.note} placeholder="例：订白色收到黑色" aria-label="备注" onChange={(e) => setW(w.key, { note: e.target.value })} /></label>
          </div>
        ))}
        <button type="button" className="small ghost" onClick={() => { setWrong([...wrong, blankWrong()]); touch(); }}>＋ 加一行来错的货</button>
        <label className="recv-note">整张备注（可空白）
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
                       onDone(next, n ? `已点完货：${n} 笔记进厂家问题。` : "已点完货：全部到齐。");
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
  const nothing = rows.every((x) => x.c.gap === 0 && x.c.over === 0 && x.c.mismatch === 0) && !wrong.length;

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
      <p className="muted small">确定后：这张 DO 算到货（各分店的「在路上」拿掉这张），下面的问题记进「厂家问题」给采购找厂家。点完不能撤回；AutoCount 仍要照常开 GRN。</p>
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
                <span>{w.received_code || w.note}{w.expected_code ? <small className="muted">{` · 本来应该是 ${w.expected_code}`}</small> : null}</span>
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

// ------------------------------------------------------------------ 点货纪录（唯读）
function ReceiptView({ me, d, flash, onChanged }: { me: Me; d: RecvFull; flash: string; onChanged: () => void }) {
  const [addIssue, setAddIssue] = useState(false);
  const r: Receipt | null = d.receipt;
  const canAdd = d.status === "arrived" || d.status === "confirmed";
  return (
    <>
      {flash && !flash.startsWith("!") && <div className="ok">{flash}</div>}
      {flash.startsWith("!") && (
        <>
          <div className="error">{flash.slice(1)}</div>
          <p className="small">你点的数字跟下面的纪录不一样的话，用「＋ 记坏货 / 到货少 / 来错货」补记。</p>
        </>
      )}
      {d.status === "confirmed" && d.self_confirmed && (
        <div className="podo-sum warn">这张厂家 DO 是你确认的：请仓库的同事点货（确认和点货分开，少了、坏了才有人核对）。</div>
      )}
      {d.status === "draft" && <div className="error">这张厂家 DO 还没确认（草稿），不能点货。</div>}
      {d.status === "cancelled" && <div className="error">这张厂家 DO 已取消。</div>}
      {d.status === "arrived" && (
        <div className="ok">{`已点货 · ${d.arrived_by_name ?? ""} · ${fmtDate(d.arrived_at)}${d.arrive_note ? " · " + d.arrive_note : ""}`}</div>
      )}
      {d.status === "arrived" && d.summary && <p className="small recv-sum-line"><SummaryTags s={d.summary} /></p>}
      {d.status === "arrived" && !r && <p className="muted">这张是以前直接「标记到货」的，没有点货纪录。</p>}
      {r && <ReceiptTable d={d} r={r} />}
      {d.status === "arrived" && (
        <>
          <div className="podo-group-head">
            <h3>{`厂家问题（${d.issues.length}）`}</h3>
            {canAdd && <button className="small" onClick={() => setAddIssue(true)}>＋ 记坏货 / 到货少 / 来错货</button>}
          </div>
          {d.issues.length === 0 ? <p className="muted small">这张没有厂家问题。</p> : (
            <ul className="list recv-issues">
              {d.issues.map((i) => (
                <li key={i.id}>
                  <span>
                    <span className={"isk " + i.kind}>{issueKindLabel(i)}</span>
                    {i.kind === "short" && i.decision && <span className={"isd " + i.decision}>{DECISION_LABEL[i.decision]}</span>}
                    {i.status !== "open" && <span className={"iss " + i.status}>{ISSUE_STATUS_LABEL[i.status]}</span>}
                    <b>{i.kind === "wrong" ? (i.received_code || i.item_code || "—") : i.item_code}</b>
                    {i.kind === "wrong" && i.item_code && i.received_code ? <small className="muted">{` · 本来应该是 ${i.item_code}`}</small> : null}
                    {i.from_receipt && <span className="tag">点货时记的</span>}
                    {i.after_receipt && <span className="tag">点货后补记</span>}
                    {i.note && <><br /><small className="pre">{`备注：${i.note}`}</small></>}
                  </span>
                  <span>{fmtQty(i.qty)}</span>
                </li>
              ))}
            </ul>
          )}
          {can(me, "purchasing", "edit") && d.issues.length > 0 && (
            <p className="small"><a href="#/purchasing/issues">到「厂家问题」处理（厂家会补 / 取消 / 已处理）→</a></p>
          )}
        </>
      )}
      {addIssue && (
        <AddIssueModal doFull={{ id: d.id, items: d.items, candidates: d.items }} onClose={() => setAddIssue(false)}
                       onSaved={() => { setAddIssue(false); onChanged(); }} />
      )}
    </>
  );
}

function ReceiptTable({ d, r }: { d: RecvFull; r: Receipt }) {
  // 只列有分到的分店（点货的分配或确认时的分配）
  const cols = d.outlets.filter((o) => r.items.some((x) => Number(x.alloc?.[o.code] ?? 0) > 0 || Number(x.planned?.[o.code] ?? 0) > 0));
  const tot = (f: (x: Receipt["items"][number]) => number) => sumOf(r.items.map(f));
  const mism = (x: Receipt["items"][number]) =>
    r3(Math.max(0, Number(x.prior?.damaged ?? 0) + Number(x.prior?.short ?? 0) - Math.max(0, Number(x.shipped) - Number(x.received))));
  const anyMism = r.items.some((x) => mism(x) > 0);
  return (
    <div className="card podo-items">
      <h3>{`点货纪录（${r.items.length} 个型号）`}</h3>
      <div className="table-wrap flat">
        <table className="podo-table recv-table">
          <thead>
            <tr>
              <th className="sticky">型号 / 品名</th><th className="num">应到</th><th className="num">好货</th><th className="num">坏货</th>
              {cols.map((o) => <th key={o.code} className="num"><span>{o.short_name || o.name}</span><br /><small>好货分到</small></th>)}
              <th>结果</th>
            </tr>
          </thead>
          <tbody>
            {r.items.map((x) => {
              const s = Number(x.shipped), g = Number(x.received), dm = Number(x.damaged);
              const short = r3(Math.max(0, s - g - dm)), over = r3(Math.max(0, g + dm - s)), mm = mism(x);
              return (
                <tr key={x.item_code} className={short || over || dm || mm ? "recv-diff" : ""}>
                  <td className="sticky">
                    <b>{x.item_code}</b> <small className="muted">{x.uom}</small><br /><small>{x.description}</small>
                    {x.note && <><br /><small className="pre">{`备注：${x.note}`}</small></>}
                  </td>
                  <td className="num">{fmtQty(s)}</td>
                  <td className="num"><b>{fmtQty(g)}</b></td>
                  <td className="num">{dm ? <span className="late">{fmtQty(dm)}</span> : "0"}</td>
                  {cols.map((o) => {
                    const a = Number(x.alloc?.[o.code] ?? 0), p = Number(x.planned?.[o.code] ?? 0);
                    return (
                      <td key={o.code} className="num">
                        {a ? fmtQty(a) : ""}
                        {r3(a) !== r3(p) && <><br /><small className="amber">{`原 ${fmtQty(p)}`}</small></>}
                      </td>
                    );
                  })}
                  <td className="nowrap recv-state">
                    {!short && !over && !dm && !mm && <span className="okc">✓</span>}
                    {short > 0 && <span className="late">{`少 ${fmtQty(short)}`}</span>}
                    {over > 0 && <span className="amber">{`多 ${fmtQty(over)}`}</span>}
                    {dm > 0 && <span className="late">{`坏 ${fmtQty(dm)}`}</span>}
                    {mm > 0 && <span className="amber">{`已记的多 ${fmtQty(mm)}`}</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <td className="sticky"><b>合计</b></td>
              <td className="num"><b>{fmtQty(tot((x) => Number(x.shipped)))}</b></td>
              <td className="num"><b>{fmtQty(tot((x) => Number(x.received)))}</b></td>
              <td className="num"><b>{fmtQty(tot((x) => Number(x.damaged)))}</b></td>
              {cols.map((o) => <td key={o.code} className="num"><b>{fmtQty(tot((x) => Number(x.alloc?.[o.code] ?? 0)))}</b></td>)}
              <td></td>
            </tr>
          </tfoot>
        </table>
      </div>
      {anyMism && <p className="small amber">点货前记的坏货 / 到货少比点到的多：请采购到「厂家问题」核对，多记的作废。</p>}
      {r.wrong.length > 0 && (
        <>
          <h3>{`来错的货（${r.wrong.length}）`}</h3>
          <ul className="list">
            {r.wrong.map((w, n) => (
              <li key={n}>
                <span>
                  <b>{w.received_code || "—"}</b> <small>{w.description}</small>
                  {w.expected_code && <small className="muted">{` · 本来应该是 ${w.expected_code}`}</small>}
                  {w.note && <small className="muted">{` · ${w.note}`}</small>}
                </span>
                <span>{fmtQty(w.qty)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {r.note && <p className="small pre">{`整张备注：${r.note}`}</p>}
    </div>
  );
}
