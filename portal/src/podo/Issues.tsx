// 厂家问题：少发 / 多发 / 发错型号（确认 DO 时自动记）、坏货 / 到货少（手动记）。按厂家分组，一次提醒一家：下载 Excel、打印（存 PDF）。
// 少发：之后同厂家的 DO 在那张 PO 出了这个型号会自动扣掉；要决定「厂家会补」（超出 PO 的也先补它）或「取消（下次再订）」。
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { BRANCH_LABEL, fmtDate, fmtQty, Me, todayKL } from "../api";
import { Empty, ErrorBox, Modal } from "../ui";
import { getLang } from "../i18n";
import {
  dateKL, DECISION_LABEL, DoFull, DoHeader, Issue, ISSUE_KIND_LABEL, ISSUE_STATUS_LABEL, issueKindLabel, joinList, num, podo, ui,
} from "../podo-api";
import { AskModal, IssueBadges } from "./common";

// ------------------------------------------------------------------ 共用：问题的文字
/** 型号栏：发错型号写「订 X 收到 Y」 */
export function issueModel(i: Issue): string {
  if (i.kind !== "wrong") return i.item_code ?? "";
  if (i.item_code && i.received_code) return `订 ${i.item_code} 收到 ${i.received_code}`;
  if (i.received_code) return `收到 ${i.received_code}`;
  return i.item_code ? `订 ${i.item_code}` : "";
}

/** 处理栏：决定 / 状态 + 已补多少 + 处理说明 */
export function issueHandling(i: Issue): string {
  const parts: string[] = [];
  if (i.kind === "short" && i.decision) parts.push(DECISION_LABEL[i.decision]);
  if (i.status !== "open" || i.kind !== "short") parts.push(ISSUE_STATUS_LABEL[i.status]);
  if (i.resolved_qty > 0) parts.push(`已补 ${fmtQty(i.resolved_qty)}`);
  if (i.action_note) parts.push(i.action_note);
  return parts.join(" · ");
}

const ISSUE_QTY = (i: Issue) => (i.status === "open" ? i.open_qty : i.qty);

// ------------------------------------------------------------------ 处理按钮
type Act = "await" | "cancel" | "pending" | "resolve" | "reopen" | "note" | "void";
export function IssueActions({ i, onDone }: { i: Issue; onDone: () => void }) {
  const [ask, setAsk] = useState<Act | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const run = async (a: Act, note?: string | null) => {
    await podo.issueSet([i.id], a, note);
    setAsk(null);
    onDone();
  };
  const now = (a: Act) => {
    setBusy(true);
    setError("");
    run(a).catch((e: Error) => setError(e.message)).finally(() => setBusy(false));
  };
  if (i.status === "void") return null;
  const short = i.kind === "short";
  return (
    <div className="podo-acts">
      {i.status === "open" && short && i.decision !== "await" && <button className="small" disabled={busy} onClick={() => now("await")}>厂家会补</button>}
      {i.status === "open" && short && <button className="small ghost" disabled={busy} onClick={() => setAsk("cancel")}>取消（下次再订）</button>}
      {i.status === "open" && short && i.decision === "await" && i.resolved_qty === 0 &&
        <button className="small ghost" disabled={busy} onClick={() => now("pending")}>改回未决定</button>}
      {i.status === "open" && (!short || i.decision === "await") &&
        <button className="small ghost" disabled={busy} onClick={() => setAsk("resolve")}>已处理</button>}
      {i.status === "resolved" && <button className="small ghost" disabled={busy} onClick={() => now("reopen")}>重开</button>}
      <button className="small ghost" disabled={busy} onClick={() => setAsk("note")}>备注</button>
      {!i.auto && <button className="small ghost danger" disabled={busy} onClick={() => setAsk("void")}>作废</button>}
      <ErrorBox error={error} />
      {ask === "cancel" && (
        <AskModal title="取消（下次再订）" message="厂家不补了：这笔少发标为已处理，下次要的话另开 PO。" label="说明（可空白）"
                  okText="确定" onClose={() => setAsk(null)} onOk={(t) => run("cancel", t || null)} />
      )}
      {ask === "resolve" && (
        <AskModal title="标为已处理" label="怎么处理的（可空白，例：厂家退款 / 下一柜补）" okText="已处理"
                  onClose={() => setAsk(null)} onOk={(t) => run("resolve", t || null)} />
      )}
      {ask === "note" && (
        <AskModal title="备注" label="备注（会印在给厂家的清单上）" initial={i.note} okText="储存"
                  onClose={() => setAsk(null)} onOk={(t) => run("note", t)} />
      )}
      {ask === "void" && (
        <AskModal title="作废这笔" message="记错了才作废（不会出现在清单上）。" label="原因（可空白）" okText="作废" danger
                  onClose={() => setAsk(null)} onOk={(t) => run("void", t || null)} />
      )}
    </div>
  );
}

/** 问题表格（DO 画面与厂家问题页共用）。picked / onPick：多选批量处理 */
export function IssueTable({ rows, onChanged, showDo, picked, onPick }: {
  rows: Issue[]; onChanged: () => void; showDo?: boolean; picked?: Set<number>; onPick?: (id: number) => void;
}) {
  return (
    <div className="table-wrap">
      <table className="podo-issues">
        <thead>
          <tr>
            {onPick && <th></th>}
            <th>问题</th><th>型号 / 品名</th>{showDo && <th className="hide-sm">DO / PO</th>}
            <th className="num">订 / 到</th><th className="num">数量</th><th>处理</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((i) => (
            <tr key={i.id} className={i.status === "open" ? "" : "inactive-soft"}>
              {onPick && (
                <td><input type="checkbox" checked={picked?.has(i.id) ?? false} onChange={() => onPick(i.id)} disabled={i.status === "void"}
                           aria-label={`选取 ${i.item_code ?? i.received_code}`} /></td>
              )}
              <td><IssueBadges i={i} /><br /><small className="muted">{fmtDate(i.created_at)}</small></td>
              <td>
                <b>{issueModel(i)}</b><br /><small>{i.description}</small>
                {i.note && <><br /><small className="pre">{`备注：${i.note}`}</small></>}
              </td>
              {showDo && (
                <td className="hide-sm small">
                  {i.do_id && <a href={`#/purchasing/do/${i.do_id}`}>{i.do_no || `#${i.do_id}`}</a>}
                  {i.do_date && <span className="muted">{` · ${i.do_date}`}</span>}
                  <br /><span className="muted">{joinList(i.po_nos)}</span>
                </td>
              )}
              <td className="num">{i.ordered != null ? fmtQty(i.ordered) : "—"}<br /><small className="muted">{i.received != null ? fmtQty(i.received) : "—"}</small></td>
              <td className="num">
                <b>{fmtQty(ISSUE_QTY(i))}</b>
                {i.resolved_qty > 0 && <><br /><small className="muted">{`共 ${fmtQty(i.qty)} · 已补 ${fmtQty(i.resolved_qty)}`}</small></>}
              </td>
              <td>
                {i.action_note && <small className="pre">{i.action_note}</small>}
                {i.resolutions.map((r, n) => (
                  <small key={n} className="muted podo-res">{`DO ${r.do_no || "#" + r.do_id} 补 ${fmtQty(r.qty)}`}</small>
                ))}
                <IssueActions i={i} onDone={onChanged} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ------------------------------------------------------------------ 手动记：坏货 / 到货少 / 发错型号
export function AddIssueModal({ doFull, onClose, onSaved }: { doFull?: DoFull; onClose: () => void; onSaved: () => void }) {
  const [dos, setDos] = useState<DoHeader[] | null>(null);
  const [full, setFull] = useState<DoFull | null>(doFull ?? null);
  const [kind, setKind] = useState<"damaged" | "short" | "wrong">("damaged");
  const [f, setF] = useState({ item_code: "", received_code: "", description: "", qty: "", note: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (doFull) return;
    podo.list({ status: "all" })
      .then((r) => setDos(r.filter((d) => d.can_add_issue)))
      .catch((e: Error) => setError(e.message));
  }, [doFull]);

  const pickDo = (id: string) => {
    setFull(null);
    setError("");
    if (id) podo.get(Number(id)).then(setFull).catch((e: Error) => setError(e.message));
  };
  const items = (full?.items ?? []).filter((x) => x.item_code && x.shipped > 0);
  const codes = useMemo(() => {
    const s = new Set<string>();
    full?.candidates.forEach((c) => s.add(c.item_code));
    full?.items.forEach((x) => x.item_code && s.add(x.item_code));
    return [...s].sort();
  }, [full]);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!full) return setError("请先选厂家 DO。");
    const q = num(f.qty);
    if (!(q > 0)) return setError("请填数量。");
    setBusy(true);
    setError("");
    try {
      await podo.issueAdd(kind !== "wrong"
        ? { do_id: full.id, kind, item_code: f.item_code, qty: q, note: f.note }
        : { do_id: full.id, kind, item_code: f.item_code, received_code: f.received_code, description: f.description, qty: q, note: f.note });
      onSaved();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal title="记坏货 / 到货少 / 发错型号" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        {!doFull && (
          <label>哪一张厂家 DO
            <select onChange={(e) => pickDo(e.target.value)} defaultValue="" required>
              <option value="">{dos === null ? "载入中…" : "（选一张已确认 / 已到货的 DO）"}</option>
              {(dos ?? []).map((d) => (
                <option key={d.id} value={d.id}>{`${d.supplier_name || d.creditor_code} · ${d.do_no || "#" + d.id}${d.do_date ? " · " + d.do_date : ""}`}</option>
              ))}
            </select>
          </label>
        )}
        <div className="row">
          <label className="check"><input type="radio" checked={kind === "damaged"} onChange={() => setKind("damaged")} /> 坏货 / 破损</label>
          <label className="check"><input type="radio" checked={kind === "short"} onChange={() => setKind("short")} /> 到货少</label>
          <label className="check"><input type="radio" checked={kind === "wrong"} onChange={() => setKind("wrong")} /> 发错型号</label>
        </div>
        {kind === "short" && <p className="muted small">厂家 DO 写的比实际到的多：这几件不算在路上，厂家欠（跟少发一样选厂家会补或取消）。</p>}
        {kind !== "wrong" ? (
          <label>型号
            <select value={f.item_code} onChange={set("item_code")} required disabled={!full}>
              <option value="">（选型号）</option>
              {items.map((x) => <option key={x.item_code!} value={x.item_code!}>{`${x.item_code} · ${x.description} · 出货 ${fmtQty(x.shipped)}`}</option>)}
            </select>
          </label>
        ) : (
          <>
            <div className="row">
              <label>收到的型号<input value={f.received_code} onChange={set("received_code")} placeholder="厂家实际发来的型号" /></label>
              <label>本来应该是（可不填）
                <select value={f.item_code} onChange={set("item_code")} disabled={!full}>
                  <option value="">—</option>
                  {codes.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </label>
            </div>
            <label>品名<input value={f.description} onChange={set("description")} /></label>
          </>
        )}
        <div className="row">
          <label>数量<input inputMode="decimal" value={f.qty} onChange={set("qty")} required /></label>
          <label>备注<input value={f.note} onChange={set("note")}
                            placeholder={kind === "damaged" ? "例：2 个裂开，有拍照" : kind === "short" ? "例：少一箱" : "例：订白色收到黑色"} /></label>
        </div>
        <ErrorBox error={error} />
        <div className="actions">
          <button type="button" className="ghost" onClick={onClose}>取消</button>
          <button disabled={busy || !full}>{busy ? "储存中…" : "记下来"}</button>
        </div>
      </form>
    </Modal>
  );
}

// ------------------------------------------------------------------ 厂家问题页
interface Group { key: string; company: string; creditor_code: string; supplier_name: string; rows: Issue[] }

function groupBySupplier(rows: Issue[]): Group[] {
  const m = new Map<string, Group>();
  for (const i of rows) {
    const k = `${i.company}|${i.creditor_code}`;
    const g = m.get(k);
    if (g) g.rows.push(i);
    else m.set(k, { key: k, company: i.company, creditor_code: i.creditor_code, supplier_name: i.supplier_name, rows: [i] });
  }
  return [...m.values()];
}

export default function IssuesTab({ me }: { me: Me }) {
  const [status, setStatus] = useState("open");
  const [kind, setKind] = useState("");
  const [company, setCompany] = useState("");
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<Issue[] | null>(null);
  const [error, setError] = useState("");
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [adding, setAdding] = useState(false);
  const [printing, setPrinting] = useState<Group[] | null>(null);
  const [bulk, setBulk] = useState<"cancel" | "resolve" | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setError("");
    podo.issues({ status, kind, company, q: query })
      .then((r) => { setRows(r); setPicked(new Set()); })
      .catch((e: Error) => setError(e.message));
  }, [status, kind, company, query]);
  useEffect(() => { setRows(null); load(); }, [load]);

  const groups = useMemo(() => groupBySupplier(rows ?? []), [rows]);
  const pickedRows = (rows ?? []).filter((i) => picked.has(i.id));
  const allShort = pickedRows.length > 0 && pickedRows.every((i) => i.kind === "short" && i.status === "open");
  // 「已处理」与单笔同规则：少发要先选厂家会补（未决定的不能直接结案）
  const canResolve = pickedRows.length > 0 && pickedRows.every((i) => i.status === "open" && (i.kind !== "short" || i.decision === "await"));
  const toggle = (id: number) => {
    const n = new Set(picked);
    if (n.has(id)) n.delete(id); else n.add(id);
    setPicked(n);
  };
  async function bulkRun(action: string, note?: string | null) {
    setBusy(true);
    setError("");
    try {
      await podo.issueSet([...picked], action, note);
      setBulk(null);
      load();
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  }

  return (
    <>
      <div className="page-head">
        <p className="muted">
          {"确认厂家 DO 时自动记：少发（所选 PO 还没出的 − 这批出货）、多发、发错型号；坏货 / 破损、到货少要手动记。"}
          <br />{"少发：之后同一厂家的 DO 在那张 PO 出了这个型号会自动扣掉。请选「厂家会补」（超出 PO 的数量也会先补它）或「取消（下次再订）」。"}
          <br />{"要提醒厂家：下载 Excel 或打印（可存成 PDF），一个厂家一页。"}
        </p>
        <button onClick={() => setAdding(true)}>＋ 记坏货 / 到货少 / 发错型号</button>
      </div>
      <form className="toolbar" onSubmit={(e) => { e.preventDefault(); setQuery(q.trim()); }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜厂家、型号、品名、DO 号、PO 号…" />
        <button>搜寻</button>
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="open">未处理</option>
          <option value="resolved">已处理</option>
          <option value="all">全部（不含作废）</option>
          <option value="void">已作废</option>
        </select>
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">全部问题</option>
          {Object.entries(ISSUE_KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        {me.staff.branch === "ALL" && (
          <select value={company} onChange={(e) => setCompany(e.target.value)}>
            <option value="">全部分店</option>
            <option value="HOMEWORKSSB">{BRANCH_LABEL.HOMEWORKSSB}</option>
            <option value="HOMEWORKSSOUTHERN">{BRANCH_LABEL.HOMEWORKSSOUTHERN}</option>
          </select>
        )}
        <button type="button" className="ghost" disabled={!rows?.length} onClick={() => exportIssuesXlsx(groups).catch((e: Error) => setError(e.message))}>下载 Excel</button>
        <button type="button" className="ghost" disabled={!rows?.length} onClick={() => setPrinting(groups)}>打印</button>
      </form>
      <ErrorBox error={error} />
      {picked.size > 0 && (
        <div className="bulkbar">
          {`已选 ${picked.size} 笔`}
          {allShort && <button disabled={busy} onClick={() => bulkRun("await")}>厂家会补</button>}
          {allShort && <button className="ghost" disabled={busy} onClick={() => setBulk("cancel")}>取消（下次再订）</button>}
          {canResolve && <button className="ghost" disabled={busy} onClick={() => setBulk("resolve")}>已处理</button>}
          <button className="ghost" onClick={() => setPicked(new Set())}>取消选取</button>
        </div>
      )}
      {rows === null ? <p className="muted">{error ? "" : "载入中…"}</p> : rows.length === 0 ? <Empty>没有厂家问题。</Empty> : (
        groups.map((g) => (
          <section key={g.key} className="podo-group">
            <div className="podo-group-head">
              <h3>
                {g.supplier_name || g.creditor_code} <small className="muted">{g.creditor_code}</small>
                {me.staff.branch === "ALL" && <span className="tag">{BRANCH_LABEL[g.company]}</span>}
              </h3>
              <span className="nowrap">
                <small className="muted">{`${g.rows.length} 笔`}</small>{" "}
                <button className="small ghost" onClick={() => exportIssuesXlsx([g]).catch((e: Error) => setError(e.message))}>Excel</button>{" "}
                <button className="small ghost" onClick={() => setPrinting([g])}>打印</button>
              </span>
            </div>
            <IssueTable rows={g.rows} onChanged={load} showDo picked={picked} onPick={toggle} />
          </section>
        ))
      )}
      {adding && <AddIssueModal onClose={() => setAdding(false)} onSaved={() => { setAdding(false); load(); }} />}
      {bulk === "cancel" && (
        <AskModal title="取消（下次再订）" message={`${picked.size} 笔少发：厂家不补了，标为已处理。`} label="说明（可空白）" okText="确定"
                  onClose={() => setBulk(null)} onOk={(t) => bulkRun("cancel", t || null)} />
      )}
      {bulk === "resolve" && (
        <AskModal title="标为已处理" label="怎么处理的（可空白）" okText="已处理"
                  onClose={() => setBulk(null)} onOk={(t) => bulkRun("resolve", t || null)} />
      )}
      {printing && <PrintIssues groups={printing} onDone={() => setPrinting(null)} />}
    </>
  );
}

// ------------------------------------------------------------------ Excel / 打印
const HEAD = ["厂家", "PO", "型号", "品名", "订", "到", "问题", "数量", "处理", "备注", "DO 号", "日期"];
// 「到」「处理」在共用字典里另有意思（To / Decision），表头的英文在这里自己给
const HEAD_EN = ["Supplier", "PO", "Model", "Item", "Ordered", "Received", "Issue", "Qty", "Handling", "Note", "DO no.", "Date"];
const head = () => (getLang() === "en" ? HEAD_EN : HEAD);

function issueRow(i: Issue): (string | number)[] {
  return [
    i.supplier_name || i.creditor_code, i.po_nos.join(", "), ui(issueModel(i)), i.description,
    i.ordered ?? "", i.received ?? "", ui(issueKindLabel(i)), ISSUE_QTY(i),
    issueHandling(i).split(" · ").map(ui).join(" · "), i.note, i.do_no ?? "", i.do_date ?? dateKL(i.created_at),
  ];
}

async function exportIssuesXlsx(groups: Group[]): Promise<void> {
  const XLSX = await import("@e965/xlsx");
  const aoa: (string | number)[][] = [head()];
  for (const g of groups) for (const i of g.rows) aoa.push(issueRow(i));
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = [24, 16, 22, 36, 8, 8, 12, 8, 28, 30, 14, 12].map((wch) => ({ wch }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, ui("厂家问题").slice(0, 31));
  const who = groups.length === 1 ? `_${(groups[0].supplier_name || groups[0].creditor_code).replace(/[\\/:*?"<>|]+/g, " ").trim()}` : "";
  const out = XLSX.write(wb, { bookType: "xlsx", type: "array", compression: true }) as ArrayBuffer;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([out], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
  a.download = `${ui("厂家问题")}${who}_${todayKL()}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

/** 打印：一个厂家一页（横向 A4）。浏览器的列印可以「存成 PDF」 */
function PrintIssues({ groups, onDone }: { groups: Group[]; onDone: () => void }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setReady(true);
    const style = document.createElement("style");
    style.textContent = "@page { size: A4 landscape; margin: 10mm; }";
    document.head.appendChild(style);
    const done = () => onDone();
    window.addEventListener("afterprint", done);
    const t = setTimeout(() => window.print(), 300);
    return () => { clearTimeout(t); window.removeEventListener("afterprint", done); style.remove(); };
  }, [onDone]);
  if (!ready) return null;
  return createPortal(
    <div id="podo-print">
      {groups.map((g) => (
        <section key={g.key} className="podo-print-group">
          <h2>{g.supplier_name || g.creditor_code} <small>{g.creditor_code}</small></h2>
          <p className="podo-print-sub">{`HomeWorks · 厂家问题清单 · ${todayKL()} · ${g.rows.length} 笔`}</p>
          <table>
            <thead translate="no"><tr>{head().slice(1).map((h) => <th key={h}>{h}</th>)}</tr></thead>
            <tbody>
              {g.rows.map((i) => {
                const r = issueRow(i);
                return <tr key={i.id}>{r.slice(1).map((v, n) => <td key={n} className={[3, 4, 6].includes(n) ? "n" : ""}>{typeof v === "number" ? fmtQty(v) : v}</td>)}</tr>;
              })}
            </tbody>
          </table>
        </section>
      ))}
    </div>,
    document.body,
  );
}
