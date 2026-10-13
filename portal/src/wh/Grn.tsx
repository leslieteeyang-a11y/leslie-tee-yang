// 仓库 · 待开进货单（开单部、仓库「可审批」）：点货后的进货待入 AutoCount，以厂家到货（DO）分组。
// 开单部在 AutoCount 开好进货单（GRN）后填 GRN 号按「已输入」→ 之后库存以 AutoCount 为准。还没按之前，查货、盘点的「应有」已经算进去。
// 防呆（只提示，不会自动标）：
//   「AutoCount 可能已输入」：照在路上的先出先到算这张 DO 这个型号 AutoCount 已经收了几件（同一张 PO 两批货不会互相误提示、
//   没有 PO 的多到不提示），列出还没对上的 GRN；一张就够这笔的才有一键标。
//   「点货时 AutoCount 已经有」（pre_grn）：本地货先开 GRN 才点货 → 这几件没有重复算库存，核对后按一键标。
//   「这张 PO 已经全收」：AutoCount 这张 PO 的这个型号已经全部收了，请先核对再开（避免在 AutoCount 重复进货）。
// 取消（点货记错）只有仓库「可审批」，一定要写原因；开单部只能标已输入。对 AutoCount 仍只读：这里只记清单状态。
import { FormEvent, useCallback, useEffect, useState } from "react";
import { BRANCH_LABEL, fmtDate, fmtQty } from "../api";
import { getLang } from "../i18n";
import { Empty, ErrorBox, Tabs } from "../ui";
import { AskModal } from "../podo/common";
import { GrnGroup, GrnLine, wh } from "../wh-api";

const join = (xs: string[]) => xs.join(getLang() === "en" ? ", " : "、");
const DAY_OPTIONS = [7, 30, 90];

export function GrnTab({ company, multi, canCancel }: { company: string; multi: boolean; canCancel: boolean }) {
  const [status, setStatus] = useState<"pending" | "done" | "all">("pending");
  const [days, setDays] = useState(30);
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [groups, setGroups] = useState<GrnGroup[] | null>(null);
  const [error, setError] = useState("");
  const [flash, setFlash] = useState("");

  const load = useCallback(() => {
    setError("");
    wh.grnList({ company, status, days, q: query }).then((r) => setGroups(r.groups)).catch((e: Error) => setError(e.message));
  }, [company, status, days, query]);
  useEffect(() => { setGroups(null); load(); }, [load]);

  return (
    <>
      <p className="muted small">
        {"仓库点完厂家的货，好货已经算进库存；请在 AutoCount 照这张清单开进货单（GRN），开好后填 GRN 号按「已输入」。"}
        <br />{"标「AutoCount 可能已输入」「点货时 AutoCount 已经有」或「这张 PO 已经全收」的：请先在 AutoCount 核对，不要重复开；是的话直接按那一行的「标已输入」。"}
      </p>
      <div className="filters">
        <Tabs value={status} onChange={(v) => { setStatus(v); setFlash(""); }}
              options={[["pending", "待开 GRN"], ["done", "已输入"], ["all", "全部（含已取消）"]]} />
      </div>
      <form className="toolbar" onSubmit={(e: FormEvent) => { e.preventDefault(); setQuery(q.trim()); }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="找型号、DO 号、厂家、PO、GRN 号…" />
        <button type="submit" className="ghost">找</button>
        {status !== "pending" && (
          <select value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="最近几天" className="narrow-select">
            {DAY_OPTIONS.map((n) => <option key={n} value={n}>{`最近 ${n} 天`}</option>)}
          </select>
        )}
      </form>
      <ErrorBox error={error} />
      {flash && <div className="ok">{flash}</div>}
      {groups === null ? (!error && <p className="muted">载入中…</p>) : groups.length === 0 ? (
        <Empty>{status === "pending" ? "没有待开的进货单。" : "没有纪录。"}</Empty>
      ) : groups.map((g) => (
        <GrnCard key={g.do_id} g={g} multi={multi} canCancel={canCancel} onDone={(m) => { setFlash(m); load(); }} />
      ))}
    </>
  );
}

/** 一行的防呆提示：点货时就有 / 可能已输入 / PO 已全收 */
function LineHints({ l, busy, onMark }: { l: GrnLine; busy: boolean; onMark: (doc: string) => void }) {
  if (l.status !== "pending") return null;
  if (l.pre_grn)
    return (
      <div className="grn-hint">
        <small className="amber">{`点货时 AutoCount 已经有进货单（GRN ${l.pre_grn}）：没有重复算库存，请核对`}</small>
        <button type="button" className="small ghost" disabled={busy} onClick={() => onMark(l.pre_grn!)}>{`标已输入（${l.pre_grn}）`}</button>
      </div>
    );
  if (Number(l.hint_qty) > 0)
    return (
      <div className="grn-hint">
        <small className="amber">
          {`AutoCount 可能已输入 ${fmtQty(l.hint_qty)} 件`}
          {l.grn_hint.length > 0 && ` · ${l.grn_hint.map((h) => `GRN ${h.doc_no}（${h.rcv_date} · ${fmtQty(h.qty)}）`).join(" · ")}`}
        </small>
        {l.one_doc && <button type="button" className="small ghost" disabled={busy} onClick={() => onMark(l.one_doc!)}>{`标已输入（${l.one_doc}）`}</button>}
      </div>
    );
  if (l.po_full)
    return <div className="grn-hint"><small className="amber">AutoCount 这张 PO 的这个型号已经全收：请先核对再开</small></div>;
  return null;
}

function GrnCard({ g, multi, canCancel, onDone }: { g: GrnGroup; multi: boolean; canCancel: boolean; onDone: (msg: string) => void }) {
  const pend = g.lines.filter((l) => l.status === "pending");
  const [picked, setPicked] = useState<Set<number>>(() => new Set(pend.map((l) => l.id)));
  const [doc, setDoc] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [asking, setAsking] = useState<number[] | null>(null);
  const pre = [...new Set(pend.flatMap((l) => (l.pre_grn ? [l.pre_grn] : [])))];
  const hinted = [...new Set(pend.filter((l) => !l.pre_grn && Number(l.hint_qty) > 0).flatMap((l) => l.grn_hint.map((h) => h.doc_no)))];
  const full = pend.filter((l) => !l.pre_grn && !(Number(l.hint_qty) > 0) && l.po_full).length;

  async function mark(ids: number[], acDoc: string) {
    if (!ids.length) return;
    if (!acDoc.trim()) return setError("请填 AutoCount 进货单（GRN）号码。");
    setBusy(true);
    setError("");
    try {
      const n = await wh.markMoves(ids, "done", acDoc.trim());
      if (acDoc.trim() === doc.trim()) setDoc("");
      onDone(`已标已输入（${acDoc.trim()}）：${n} 笔。`);
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  }
  const toggle = (id: number) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const sel = pend.filter((l) => picked.has(l.id)).map((l) => l.id);

  return (
    <section className="card grn-card">
      <div className="grn-head">
        <span>
          <b>{`DO ${g.do_no || "#" + g.do_id}`}</b>
          {multi && <span className="tag">{BRANCH_LABEL[g.company] ?? g.company}</span>}
          {g.supplier_name && <span className="muted">{` · ${g.supplier_name}`}</span>}
        </span>
        {pend.length > 0 ? <span className="ap pending">{`${pend.length} 笔待开`}</span> : <span className="ap approved">已处理</span>}
      </div>
      <p className="muted small">
        {g.po_nos.length > 0 && <>{`PO ${join(g.po_nos)}`}{" · "}</>}
        {`点货 ${g.arrived_by_name ?? ""} · ${fmtDate(g.arrived_at)}`}
        {g.do_date && <>{" · "}{`DO 日期 ${g.do_date}`}</>}
      </p>
      {pre.length > 0 && <div className="podo-sum warn">{`点货时 AutoCount 已经有进货单（GRN ${join(pre)}）：这几笔没有重复算库存，请核对后按那一行的「标已输入」。`}</div>}
      {hinted.length > 0 && <div className="podo-sum warn">{`AutoCount 可能已输入（GRN ${join(hinted)}）：请核对，是的话按那一行的「标已输入」，不要重复开。`}</div>}
      {full > 0 && <div className="podo-sum warn">{`${full} 笔的 PO 在 AutoCount 已经全收：请先核对再开，不要重复进货。`}</div>}
      <div className="table-wrap flat">
        <table>
          <thead>
            <tr>
              {pend.length > 0 && <th />}
              <th>型号 / 品名</th><th>仓位</th><th className="num">数量</th><th className="hide-sm">PO</th><th>状态</th>
            </tr>
          </thead>
          <tbody>
            {g.lines.map((l: GrnLine) => (
              <tr key={l.id} className={l.status === "pending" ? "" : "inactive-soft"}>
                {pend.length > 0 && (
                  <td>{l.status === "pending" && <input type="checkbox" checked={picked.has(l.id)} onChange={() => toggle(l.id)} aria-label={`选取 ${l.item_code}`} />}</td>
                )}
                <td>
                  <b>{l.item_code}</b> <small className="muted">{l.uom}</small><br /><small>{l.description}</small>
                  {l.recv_wrong && <span className="tag warn">来错的货</span>}
                  {l.outlet && l.outlet !== "HQ" && <><br /><small className="muted">{`给 ${l.outlet}`}</small></>}
                  {l.po_no && <><br /><small className="muted show-sm">{`PO ${l.po_no}`}</small></>}
                  <LineHints l={l} busy={busy} onMark={(d) => mark([l.id], d)} />
                </td>
                <td>{l.location}</td>
                <td className="num"><b>{fmtQty(l.qty)}</b></td>
                <td className="hide-sm small">{l.po_no ?? (l.recv_wrong ? "" : "—")}</td>
                <td className="small">
                  <span className={"ap " + (l.status === "pending" ? "pending" : l.status === "done" ? "approved" : "cancelled")}>
                    {l.status === "pending" ? "待开 GRN" : l.status === "done" ? "已输入" : "已取消"}
                  </span>
                  {l.ac_doc && <div className="muted">{l.ac_doc}</div>}
                  {l.status === "cancelled" && l.note && <div className="muted pre">{l.note}</div>}
                  {l.done_by_name && <div className="muted">{`${l.done_by_name} · ${fmtDate(l.done_at)}`}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pend.length > 0 && (
        <div className="actions left wh-bulk">
          <input placeholder="AutoCount 进货单（GRN）号码" value={doc} onChange={(e) => { setDoc(e.target.value); setError(""); }}
                 aria-label="AutoCount 进货单（GRN）号码" />
          <button disabled={busy || !sel.length} onClick={() => mark(sel, doc)}>{`✓ 已输入 AutoCount（${sel.length}）`}</button>
          {canCancel && <button className="ghost danger" disabled={busy || !sel.length} onClick={() => setAsking(sel)}>取消（点货记错）</button>}
        </div>
      )}
      <ErrorBox error={error} />
      {asking && (
        <AskModal title="取消进货" message={`取消这 ${asking.length} 笔进货？取消后不算进库存，也不会出现在待开清单（点货纪录不变）。`}
                  label="原因（必填，例：其实是样品、点货数错）" required okText="取消进货" danger
                  onClose={() => setAsking(null)}
                  onOk={async (reason) => {
                    const n = await wh.markMoves(asking, "cancelled", "", reason);
                    setAsking(null);
                    onDone(`已取消 ${n} 笔。`);
                  }} />
      )}
    </section>
  );
}
