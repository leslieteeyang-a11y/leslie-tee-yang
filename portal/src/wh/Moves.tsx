// 仓库 · 搬动登记：调仓、报坏、展示、样品、退货、报废；负责人在 AutoCount 输入后标「已输入」。
// 点货产生的「进货待入 AutoCount」（kind = receive）另外一区列出（不是一般搬动：不能跟搬动一起标已输入，要在「待开进货单」填 GRN 号）。
import { FormEvent, useCallback, useEffect, useState } from "react";
import { canCancelReceive, canGrn, Me } from "../api";
import { Empty, ErrorBox, Modal, Tabs } from "../ui";
import { shrinkImage, uploadPhoto } from "../att-api";
import { ScanBox } from "./Scanner";
import { Move, MOVE_KIND_LABEL, MOVE_STATUS_LABEL, MoveKind, moveText, qtyLabel, whenLabel, wh } from "../wh-api";
import { AskModal } from "../podo/common";


const DEFAULT_TO: Partial<Record<MoveKind, string>> = { defect: "DEFECTS", display: "DISPLAY" };

export function MoveForm({ me, company, locs, itemCode, onClose, onSaved }: {
  me: Me; company: string; locs: string[]; itemCode?: string; onClose: () => void; onSaved: (m: Move) => void;
}) {
  const [code, setCode] = useState(itemCode || "");
  const [desc, setDesc] = useState("");
  const [kind, setKind] = useState<MoveKind>("transfer");
  const [qty, setQty] = useState("");
  const [from, setFrom] = useState(locs[0] || "");
  const [to, setTo] = useState("");
  const [note, setNote] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const needFrom = kind !== "return";
  const needTo = kind === "transfer" || kind === "return" || kind === "defect" || kind === "display";

  useEffect(() => {
    if (!code) { setDesc(""); return; }
    wh.item(company, code).then((d) => setDesc(d.found ? `${d.item_code} · ${d.description}` : "找不到这个商品")).catch(() => setDesc(""));
  }, [code, company]);
  useEffect(() => {
    const d = DEFAULT_TO[kind];
    if (d && locs.includes(d)) setTo(d);
    else if (kind === "transfer") setTo((t) => (t && t !== from ? t : locs.find((l) => l !== from) || ""));
  }, [kind]); // eslint-disable-line react-hooks/exhaustive-deps

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      let photo: string | null = null;
      if (file) {
        const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kuala_Lumpur" }).format(new Date());
        photo = await uploadPhoto(me.staff.id, today, "wh", await shrinkImage(file));
      }
      onSaved(await wh.saveMove({ company, item_code: code, qty, kind, from_loc: needFrom ? from : null,
                                  to_loc: needTo ? to : null, note, photo }));
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal title="登记搬动" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        {itemCode ? <p><b>{desc || itemCode}</b></p> : (
          <>
            <ScanBox onCode={setCode} placeholder="扫商品条码或打代号" />
            {code && <p className="small">{desc}</p>}
          </>
        )}
        <label>做什么
          <select value={kind} onChange={(e) => setKind(e.target.value as MoveKind)}>
            {Object.entries(MOVE_KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <div className="row">
          {needFrom && (
            <label>从哪个仓位
              <select value={from} onChange={(e) => setFrom(e.target.value)}>
                {locs.map((l) => <option key={l} value={l}>{l}</option>)}
              </select>
            </label>
          )}
          {needTo && (
            <label>到哪个仓位
              <select value={to} onChange={(e) => setTo(e.target.value)} required>
                <option value="">请选</option>
                {locs.filter((l) => l !== from || !needFrom).map((l) => <option key={l} value={l}>{l}</option>)}
              </select>
            </label>
          )}
          <label>数量<input type="number" inputMode="decimal" min="0.01" step="any" value={qty} onChange={(e) => setQty(e.target.value)} required /></label>
        </div>
        <label>{kind === "writeoff" || kind === "other" ? "原因（必填）" : "备注（选填）"}
          <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500}
                 placeholder={kind === "defect" ? "例：纸箱压坏、马桶裂" : kind === "return" ? "例：客户退货，单号…" : ""} /></label>
        <label>照片（选填）<input type="file" accept="image/*" capture="environment" onChange={(e) => setFile(e.target.files?.[0] || null)} /></label>
        <p className="muted small">登记后会出现在「搬动」的待输入清单，负责人在 AutoCount 开转仓 / 调整单后标「已输入」。还没输入前，盘点会自动把这笔算进去。</p>
        <ErrorBox error={error} />
        <div className="actions">
          <button type="button" className="ghost" onClick={onClose}>取消</button>
          <button disabled={busy || !code}>{busy ? "储存中…" : "登记"}</button>
        </div>
      </form>
    </Modal>
  );
}

export function MovesTab({ me, company, locs, canEdit, canApprove }: {
  me: Me; company: string; locs: string[]; canEdit: boolean; canApprove: boolean;
}) {
  const [status, setStatus] = useState<"pending" | "done" | "all">("pending");
  const [rows, setRows] = useState<Move[] | null>(null);
  const [recv, setRecv] = useState<Move[]>([]);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [doc, setDoc] = useState("");
  const [busy, setBusy] = useState(false);
  const grn = canGrn(me);
  const cancelRecv = canCancelReceive(me);
  const [askCancel, setAskCancel] = useState<Move | null>(null);
  // 进货一批（一张厂家到货）一组，收合：一柜货上百笔不会把搬动挤到下面
  const recvGroups = (() => {
    const m = new Map<string, { key: string; do_id: number | null; do_no: string | null; supplier_name: string | null; rows: Move[]; qty: number; pending: number }>();
    for (const x of recv) {
      const k = String(x.do_id ?? "-");
      let g = m.get(k);
      if (!g) { g = { key: k, do_id: x.do_id ?? null, do_no: x.do_no ?? null, supplier_name: x.supplier_name ?? null, rows: [], qty: 0, pending: 0 }; m.set(k, g); }
      g.rows.push(x);
      g.qty += Number(x.qty);
      if (x.status === "pending") g.pending += 1;
    }
    return [...m.values()];
  })();

  const load = useCallback(() => {
    setRows(null); setError(""); setPicked(new Set());
    wh.moves({ company, status, kind: "move" }).then(setRows).catch((e: Error) => setError(e.message));
    wh.moves({ company, status, kind: "receive" }).then(setRecv).catch(() => setRecv([]));
  }, [company, status]);
  useEffect(load, [load]);

  async function mark(action: "done" | "cancelled", ids: number[]) {
    setBusy(true); setError("");
    try { await wh.markMoves(ids, action, doc); setDoc(""); load(); } catch (e) { setError((e as Error).message); }
    setBusy(false);
  }
  const toggle = (id: number) => setPicked((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  return (
    <>
      <div className="filters">
        <Tabs value={status} onChange={setStatus} options={[["pending", "待输入 AutoCount"], ["done", "已输入"], ["all", "全部"]]} />
        {canEdit && <button onClick={() => setAdding(true)}>＋ 登记搬动</button>}
      </div>
      <ErrorBox error={error} />
      {recv.length > 0 && (
        <section className="wh-recv">
          <h3>{`进货待入 AutoCount（${recv.length} 笔 · ${recvGroups.length} 批厂家货）`}</h3>
          <p className="muted small">点货后自动产生：货已经算进库存（查货、盘点的「应有」；点货时 AutoCount 就有进货单的不重复算）。开单部在 AutoCount 开进货单（GRN）后，在「待开进货单」填 GRN 号标已输入；不要当成搬动输入转仓单。按一批展开看明细。</p>
          {recvGroups.map((g) => (
            <details key={g.key} className="wh-recv-group">
              <summary>
                <b>{g.do_no ? `DO ${g.do_no}` : g.do_id ? `DO #${g.do_id}` : "进货"}</b>
                {g.supplier_name && <span className="muted">{` · ${g.supplier_name}`}</span>}
                <span className="muted">{` · ${g.rows.length} 笔 · 共 ${qtyLabel(g.qty)} 件`}</span>
                {g.pending > 0 && <span className="ap pending">{`待开 GRN ${g.pending}`}</span>}
              </summary>
              <div className="table-wrap flat">
                <table>
                  <thead><tr><th>进货</th><th className="hide-sm">PO / 分店</th><th>状态</th></tr></thead>
                  <tbody>
                    {g.rows.map((m) => (
                      <tr key={m.id}>
                        <td><b>{m.item_code}</b>{" "}<span>{moveText(m)}</span>{" "}<span className="muted small">{m.uom}</span>
                          {m.recv_wrong && <span className="tag warn">来错的货</span>}
                          <div className="muted small">{m.description}</div>
                          {m.po_no && <div className="muted small show-sm">{`PO ${m.po_no}`}</div>}
                          {m.status === "pending" && m.pre_grn && <div className="amber small">{`点货时 AutoCount 已经有（GRN ${m.pre_grn}），没有重复算库存`}</div>}
                          {m.note && <div className="muted small">{m.note}</div>}
                          <div className="muted small">{`点货 ${m.created_by_name} · ${whenLabel(m.created_at)}`}</div></td>
                        <td className="small hide-sm">
                          {m.po_no && <div>{`PO ${m.po_no}`}</div>}
                          {m.outlet && m.outlet !== "HQ" && <div className="muted">{`给 ${m.outlet}`}</div>}
                        </td>
                        <td>
                          <span className={"ap " + (m.status === "pending" ? "pending" : m.status === "done" ? "approved" : "cancelled")}>
                            {m.status === "pending" ? "待开 GRN" : MOVE_STATUS_LABEL[m.status]}
                          </span>
                          {m.ac_doc && <div className="muted small">{m.ac_doc}</div>}
                          {m.status === "pending" && cancelRecv && (
                            <div><a href="#" className="small" onClick={(e) => { e.preventDefault(); setAskCancel(m); }}>取消</a></div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          ))}
          {grn && recv.some((m) => m.status === "pending") && <p className="small"><a href="#/warehouse/grn">到「待开进货单」输入 GRN →</a></p>}
          <h3>搬动</h3>
        </section>
      )}
      {!rows ? (!error && <p className="muted">载入中…</p>) : rows.length === 0 ? (
        <Empty>{status === "pending" ? "没有待输入的搬动。" : "没有纪录。"}</Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr>{canApprove && status === "pending" && <th />}<th>搬动</th><th className="hide-sm">登记</th><th>状态</th></tr></thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.id}>
                  {canApprove && status === "pending" && <td><input type="checkbox" checked={picked.has(m.id)} onChange={() => toggle(m.id)} /></td>}
                  <td><b>{m.item_code}</b>{" "}<span>{moveText(m)}</span>{" "}<span className="muted small">{m.uom}</span>
                    <div className="muted small">{m.description}</div>{m.note && <div className="small">{m.note}</div>}
                    <div className="muted small show-sm">{`${m.created_by_name} · ${whenLabel(m.created_at)}`}</div></td>
                  <td className="small nowrap hide-sm">{m.created_by_name}<div className="muted">{whenLabel(m.created_at)}</div></td>
                  <td>
                    <span className={"ap " + (m.status === "pending" ? "pending" : m.status === "done" ? "approved" : "cancelled")}>{MOVE_STATUS_LABEL[m.status]}</span>
                    {m.ac_doc && <div className="muted small">{m.ac_doc}</div>}
                    {m.status === "pending" && !canApprove && m.created_by === me.staff.id && (
                      <div><a href="#" className="small" onClick={(e) => { e.preventDefault(); mark("cancelled", [m.id]); }}>取消</a></div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {canApprove && status === "pending" && rows && rows.length > 0 && (
        <div className="actions left wh-bulk">
          <input placeholder="AutoCount 单号（选填，例：转仓单号）" value={doc} onChange={(e) => setDoc(e.target.value)} />
          <button disabled={busy || !picked.size} onClick={() => mark("done", [...picked])}>{`✓ 已输入 AutoCount（${picked.size}）`}</button>
          <button className="ghost danger" disabled={busy || !picked.size} onClick={() => mark("cancelled", [...picked])}>取消（登记错）</button>
        </div>
      )}
      {adding && <MoveForm me={me} company={company} locs={locs} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); load(); }} />}
      {askCancel && (
        <AskModal title="取消进货" message="取消后这笔不算进库存，也不会出现在待开进货单（点货纪录不变）。只有点货记错才取消。"
                  label="原因（必填，例：其实是样品、点货数错）" required okText="取消进货" danger
                  onClose={() => setAskCancel(null)}
                  onOk={async (reason) => { await wh.markMoves([askCancel.id], "cancelled", "", reason); setAskCancel(null); load(); }} />
      )}
    </>
  );
}

