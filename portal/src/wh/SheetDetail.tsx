// 仓库 · 一张盘点单（#/warehouse/count/<编号>）：照货架顺序（走一圈）列商品，员工扫码或点一行盲盘；
// 主管（仓库可审批）看进度、差额，可以改指派 / 期限、结单、取消。差异照样进「差异审核」。
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { getLang, tr } from "../i18n";
import { Empty, ErrorBox, Modal, Tabs } from "../ui";
import { ScanBox } from "./Scanner";
import { CountBins, CountItem } from "./CountBins";
import { AC_WARN } from "./Sheets";
import { qtyLabel, whenLabel, wh } from "../wh-api";
import { CountSaveResult, LINE_STATUS_LABEL, SCOPE_LABEL, SHEET_STATUS_LABEL, SheetDetail as Detail, SheetLine, SheetStaff, binsShort, lineClass, rm, sheets } from "../wh-sheet-api";
import "../wh-sheet.css";

type Filter = "todo" | "done" | "diff" | "all";
const ui = (s: string) => (getLang() === "en" ? tr(s) : s);

export default function SheetDetail({ id }: { id: number; company?: string }) {
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<Filter>("todo");
  const [q, setQ] = useState("");
  const [counting, setCounting] = useState<CountItem | null>(null);
  const [notice, setNotice] = useState<[string, string] | null>(null);
  const [editing, setEditing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    sheets.get(id).then((x) => { setD(x); if (x.status !== "open") setFilter((f) => (f === "todo" ? "all" : f)); })
      .catch((e: Error) => setError(e.message));
  }, [id]);
  useEffect(load, [load]);

  const lines = useMemo(() => {
    if (!d) return [];
    const k = q.trim().toUpperCase();
    return d.lines.filter((l) => (filter === "all" || (filter === "todo" ? l.status === "todo" || l.status === "recount"
      : filter === "done" ? l.status !== "todo" && l.status !== "recount" : ["variance", "adjusted", "ignored"].includes(l.status)))
      && (!k || `${l.item_code} ${l.description || ""} ${l.bins.join(" ")}`.toUpperCase().includes(k)));
  }, [d, filter, q]);

  if (!d) return error ? <><BackLink /><ErrorBox error={error} /></> : <p className="muted">载入中…</p>;
  const open = d.status === "open";
  const full = d.can_manage || d.lines.some((l) => l.diff != null);
  // 差异（含已调整 / 不调整）不在这里重盘：主管在「差异审核」按「请重盘」，这一行就回到未盘
  const canCount = (l: SheetLine) => open && (l.status === "todo" || l.status === "recount" || l.status === "match");

  function start(l: SheetLine) {
    if (!canCount(l)) return;
    setNotice(null);
    setCounting({ code: l.item_code, desc: l.description, uom: l.uom, recount: l.status === "recount" });
  }
  async function scan(code: string) {
    if (!d) return;
    setNotice(null); setError("");
    let hit = d.lines.find((l) => l.item_code.toUpperCase() === code.trim().toUpperCase());
    if (!hit) {
      try {
        const it = await wh.item(d.company, code);
        if (!it.found) { setError(`找不到「${code}」。`); return; }
        hit = d.lines.find((l) => l.item_code === it.item_code);
        if (!hit) { setError(`${it.item_code} 不在这张盘点单上。`); return; }
      } catch (e) { setError((e as Error).message); return; }
    }
    if (!canCount(hit)) { setNotice(["error", `${hit.item_code} 已经盘过（${LINE_STATUS_LABEL[hit.status]}）。要重盘请主管在「差异审核」按「请重盘」。`]); return; }
    start(hit);
  }
  function saved(r: CountSaveResult) {
    const c = counting?.code || r.item_code;
    if (r.result !== "recount") {
      setCounting(null);
      setNotice(r.result === "match" ? ["ok", `✓ ${c} 相符。`] : ["error", `${c} 第二次还是不一样，已记录为差异，交给主管审核。`]);
    }
    load();
  }
  async function close() {
    if (!d || !window.confirm(ui(d.todo + d.recount > 0 ? `还有 ${d.todo + d.recount} 项没盘完，结单后就算没盘。确定结单？` : "确定结单？"))) return;
    setBusy(true); setError("");
    try { await sheets.close(d.id); load(); } catch (e) { setError((e as Error).message); }
    setBusy(false);
  }

  const people = [...d.assignees.map((p) => ({ ...p, helper: false })), ...d.helpers.map((p) => ({ ...p, helper: true }))];
  const pct = d.total ? Math.round((d.done / d.total) * 100) : 0;
  return (
    <>
      <BackLink />
      <section className="card ws-head">
        <div className="ws-card-head">
          <h2>{d.title}</h2>
          {d.mine && open && <span className="tag">指派给我</span>}
          <span className={"ap " + (open ? "pending" : d.status === "closed" ? "approved" : "cancelled")}>{SHEET_STATUS_LABEL[d.status]}</span>
        </div>
        <div className="muted small">{`${d.location} · ${SCOPE_LABEL[d.scope]}${d.scope === "bins" ? binsShort(d.bins, 12) : ""}`}</div>
        <div className="ws-nums small">
          {d.due_date && <span className={d.overdue ? "late" : "muted"}>{`期限 ${d.due_date}`}</span>}
          <span className="muted">{`${d.created_by_name || ""} 建于 ${whenLabel(d.created_at)}`}</span>
          {d.closed_at && <span className="muted">{`${d.closed_by_name || ""} ${d.status === "closed" ? "结单" : "取消"}于 ${whenLabel(d.closed_at)}`}</span>}
        </div>
        {d.note && <p className="small">{d.note}</p>}
        {d.cancel_reason && <p className="small late">{`取消原因：${d.cancel_reason}`}</p>}
        <div className="ws-progress" aria-hidden="true"><span style={{ width: `${pct}%` }} /></div>
        <div className="ws-nums small">
          <span>{`已盘 ${d.done} / ${d.total}`}</span>
          {d.recount > 0 && <span className="amber">{`要再数 ${d.recount}`}</span>}
          {d.variance > 0 && <span className="late">{`差异 ${d.variance}`}</span>}
        </div>
        {people.length > 0 && (
          <div className="ws-people">
            {people.map((p) => <span key={`${p.helper}-${p.id}`} className={"ws-person" + (p.helper ? " helper" : "")}>{p.helper ? `${p.name}（帮忙）· ${p.n}` : `${p.name} · ${p.n}`}</span>)}
          </div>
        )}
        {open && <p className="ws-warn small">{AC_WARN}</p>}
        {d.can_manage && (
          <div className="actions left">
            <button className="ghost" onClick={() => setEditing(true)}>改指派 / 期限</button>
            <button disabled={busy} onClick={close}>结单</button>
            <button className="ghost danger" onClick={() => setCancelling(true)}>取消盘点单</button>
          </div>
        )}
      </section>

      {open && <ScanBox onCode={scan} placeholder="扫要盘的商品，或打代号" />}
      <ErrorBox error={error} />
      {notice && <div className={notice[0]}>{notice[1]}</div>}
      <div className="filters ws-bar">
        <Tabs value={filter} onChange={setFilter} options={[
          ["todo", `未盘（${d.todo + d.recount}）`], ["done", `已盘（${d.done}）`], ["diff", `差异（${d.variance}）`], ["all", "全部"]]} />
        <input className="ws-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="找商品代号、品名或货架" />
      </div>
      {lines.length === 0 ? <Empty>{filter === "todo" && !q ? "都盘完了。" : "没有符合的商品。"}</Empty> : (
        <ul className="list card ws-lines">
          {lines.map((l) => (
            <li key={l.item_code} className={canCount(l) ? "click" : ""} onClick={() => start(l)}>
              <div className="ws-line-main">
                <div><b>{l.item_code}</b>{" "}<span className="muted small">{l.description}</span></div>
                {l.bins.length > 0 && <div className="ws-binlist">{l.bins.map((b) => <span key={b} className="ws-bin">{b}</span>)}</div>}
                {l.counted_by_name && <div className="muted small">{`${l.counted_by_name} · ${whenLabel(l.counted_at)}`}</div>}
              </div>
              <div className="ws-line-side">
                <span className={"ap " + lineClass(l.status)}>{LINE_STATUS_LABEL[l.status]}</span>
                {full && l.diff != null && (
                  <span className={"small nowrap" + (Number(l.diff) ? " late" : " muted")}>
                    {`${qtyLabel(l.qty)} / ${qtyLabel(l.expected)} · 差 ${Number(l.diff) > 0 ? "+" : ""}${qtyLabel(l.diff)}`}
                  </span>
                )}
                {full && l.diff != null && l.diff_value != null && Number(l.diff_value) !== 0 && <span className="small muted nowrap">{rm(l.diff_value)}</span>}
                {canCount(l) && <span className="go nowrap">{l.status === "todo" ? "盘 →" : l.status === "recount" ? "再数 →" : "重盘 →"}</span>}
              </div>
            </li>
          ))}
        </ul>
      )}
      {full && <p className="muted small">主管看得到「实盘 / 应有 · 差」；盘点的人看不到系统数量（盲盘）。差异在「差异审核」处理。</p>}
      {counting && (
        <CountBins company={d.company} location={d.location} item={counting} sheetId={d.id} sheetTitle={d.title}
                   onClose={() => setCounting(null)} onSaved={saved} />
      )}
      {editing && <EditSheet d={d} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); load(); }} />}
      {cancelling && <CancelSheet id={d.id} onClose={() => setCancelling(false)} onDone={() => { setCancelling(false); load(); }} />}
    </>
  );
}

function BackLink() {
  return <p className="ws-back"><a className="small" href="#/warehouse/count/sheets">← 盘点单</a></p>;
}

function EditSheet({ d, onClose, onSaved }: { d: Detail; onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState(d.title);
  const [due, setDue] = useState(d.due_date || "");
  const [note, setNote] = useState(d.note);
  const [staff, setStaff] = useState<SheetStaff[] | null>(null);
  const [ass, setAss] = useState<Set<number>>(new Set(d.assignees.map((a) => a.id)));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { sheets.staff(d.company).then(setStaff).catch((e: Error) => setError(e.message)); }, [d.company]);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError("");
    try { await sheets.update({ id: d.id, title, due_date: due || null, note, assignees: [...ass] }); onSaved(); }
    catch (err) { setError((err as Error).message); setBusy(false); }
  }
  return (
    <Modal title="改盘点单" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label>名称<input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} required /></label>
        <div>
          <div className="small muted ws-label">指派给</div>
          {!staff ? <p className="muted small">载入中…</p> : (
            <div className="ws-chips">
              {staff.map((p) => (
                <label key={p.id} className={"ws-chip" + (ass.has(p.id) ? " on" : "")}>
                  <input type="checkbox" checked={ass.has(p.id)}
                         onChange={() => setAss((a) => { const n = new Set(a); n.has(p.id) ? n.delete(p.id) : n.add(p.id); return n; })} />
                  <span>{p.name}</span>
                </label>
              ))}
            </div>
          )}
        </div>
        <label>期限（选填）<input type="date" value={due} onChange={(e) => setDue(e.target.value)} /></label>
        <label>备注（选填）<input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} /></label>
        <ErrorBox error={error} />
        <div className="actions">
          <button type="button" className="ghost" onClick={onClose}>取消</button>
          <button disabled={busy || !ass.size}>{busy ? "储存中…" : "储存"}</button>
        </div>
      </form>
    </Modal>
  );
}

function CancelSheet({ id, onClose, onDone }: { id: number; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError("");
    try { await sheets.cancel(id, reason); onDone(); } catch (err) { setError((err as Error).message); setBusy(false); }
  }
  return (
    <Modal title="取消盘点单" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <p className="small muted">已经盘的照样有效，差异照样在「差异审核」。</p>
        <label>原因<input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} required autoFocus placeholder="例：改天整个仓位一起盘" /></label>
        <ErrorBox error={error} />
        <div className="actions">
          <button type="button" className="ghost" onClick={onClose}>不取消</button>
          <button className="danger-fill" disabled={busy || !reason.trim()}>{busy ? "储存中…" : "取消盘点单"}</button>
        </div>
      </form>
    </Modal>
  );
}
