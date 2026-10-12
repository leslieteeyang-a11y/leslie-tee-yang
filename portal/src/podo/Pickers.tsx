// 开新厂家到货的前两步：选厂家 → 选这家的 PO（编辑草稿时「改 PO」也用 PoPicker）
import { useEffect, useMemo, useState } from "react";
import { BRANCH_LABEL, ETA_SOURCE_LABEL, fmtQty, Me, PO_STATUS_LABEL } from "../api";
import { Empty, ErrorBox } from "../ui";
import { DO_STATUS_LABEL, DoPo, DoSupplier, podo } from "../podo-api";
import { outletName, useOutlets } from "./common";

export function SupplierPicker({ me, company, onCompany, onPick }: {
  me: Me; company: string; onCompany: (c: string) => void; onPick: (s: DoSupplier) => void;
}) {
  const [rows, setRows] = useState<DoSupplier[] | null>(null);
  const [error, setError] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => {
    setRows(null);
    setError("");
    podo.suppliers(company).then(setRows).catch((e: Error) => setError(e.message));
  }, [company]);
  const shown = useMemo(() => {
    const k = q.trim().toLowerCase();
    return (rows ?? []).filter((s) => !k || s.supplier_name.toLowerCase().includes(k) || s.creditor_code.toLowerCase().includes(k));
  }, [rows, q]);

  return (
    <div className="card">
      <h2>第 1 步：选厂家</h2>
      <div className="toolbar">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜厂家名称或代号…" autoFocus />
        {me.staff.branch === "ALL" && (
          <select value={company} onChange={(e) => onCompany(e.target.value)}>
            <option value="HOMEWORKSSB">{BRANCH_LABEL.HOMEWORKSSB}</option>
            <option value="HOMEWORKSSOUTHERN">{BRANCH_LABEL.HOMEWORKSSOUTHERN}</option>
          </select>
        )}
      </div>
      <ErrorBox error={error} />
      {rows === null ? <p className="muted">{error ? "" : "载入中…"}</p> : shown.length === 0 ? <Empty>没有还没到齐的 PO 的厂家。</Empty> : (
        <div className="table-wrap flat">
          <table>
            <thead><tr><th>厂家</th><th className="num">PO</th><th className="num">未到</th><th className="hide-sm">最近开单</th></tr></thead>
            <tbody>
              {shown.map((s) => (
                <tr key={s.creditor_code} className="click" onClick={() => onPick(s)}>
                  <td>
                    <b>{s.supplier_name || s.creditor_code}</b>{s.is_china && <span className="tag">中国</span>}
                    {s.drafts > 0 && <span className="badge">{`草稿 ${s.drafts} 张`}</span>}
                    <br /><small className="muted">{s.creditor_code}</small>
                  </td>
                  <td className="num">{s.po_count}</td>
                  <td className="num">{fmtQty(s.open_qty)}</td>
                  <td className="hide-sm">{s.last_po_date}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** 勾这张厂家 DO 包含哪几张 PO。旧单（120 天以上）与已关闭的预设藏起来（已选的照样显示） */
export function PoPicker({ company, creditor, supplierName, selected, okText, onOk, onBack }: {
  company: string; creditor: string; supplierName: string; selected: string[]; okText: string;
  onOk: (poNos: string[]) => void; onBack: () => void;
}) {
  const outlets = useOutlets();
  const [rows, setRows] = useState<DoPo[] | null>(null);
  const [error, setError] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set(selected));
  const [old, setOld] = useState(false);
  useEffect(() => {
    podo.pos(company, creditor).then(setRows).catch((e: Error) => setError(e.message));
  }, [company, creditor]);

  const hidden = (p: DoPo) => !picked.has(p.po_no) && !old && (p.closed || p.days_open > 120);
  const shown = (rows ?? []).filter((p) => !hidden(p));
  const nHidden = (rows ?? []).length - shown.length;
  const toggle = (po: string) => {
    const n = new Set(picked);
    if (n.has(po)) n.delete(po); else n.add(po);
    setPicked(n);
  };

  return (
    <div className="card">
      <h2>{`第 2 步：选 ${supplierName || creditor} 这次出货的 PO`}</h2>
      <p className="muted small">「还可以出」= AutoCount 未到 − 已确认的厂家 DO 在路上。一张厂家 DO 可以包含好几张 PO。</p>
      <div className="toolbar">
        <button type="button" className="ghost small" disabled={!rows}
                onClick={() => setPicked(new Set([...picked, ...shown.filter((p) => p.remaining > 0 && !p.closed).map((p) => p.po_no)]))}>
          勾选全部还可以出的
        </button>
        {picked.size > 0 && <button type="button" className="ghost small" onClick={() => setPicked(new Set())}>全部不选</button>}
        <label className="check"><input type="checkbox" checked={old} onChange={(e) => setOld(e.target.checked)} /> 含 120 天以上旧单与已关闭的</label>
      </div>
      <ErrorBox error={error} />
      {rows === null ? <p className="muted">{error ? "" : "载入中…"}</p> : shown.length === 0 ? <Empty>这个厂家没有还没到齐的 PO。</Empty> : (
        <div className="table-wrap flat">
          <table>
            <thead>
              <tr>
                <th></th><th>PO</th><th className="hide-sm">ETA</th><th>分店</th>
                <th className="num">未到</th><th className="num hide-sm">在路上</th><th className="num">还可以出</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((p) => (
                <tr key={p.po_no} className={"click" + (p.closed ? " inactive" : "")} onClick={() => toggle(p.po_no)}>
                  <td><input type="checkbox" checked={picked.has(p.po_no)} onChange={() => toggle(p.po_no)} onClick={(e) => e.stopPropagation()}
                             aria-label={`选取 ${p.po_no}`} /></td>
                  <td>
                    <b>{p.po_no}</b>{p.closed && <span className="tag">{PO_STATUS_LABEL.closed}</span>}
                    <br /><small className="muted">{`${p.po_date} · ${p.days_open} 天`}</small>
                    {p.dos.map((d) => (
                      <span key={d.id} className="tag">{`DO ${d.do_no || "#" + d.id} · ${DO_STATUS_LABEL[d.status]}`}</span>
                    ))}
                  </td>
                  <td className="hide-sm nowrap">{p.eta}<br /><small className="muted">{ETA_SOURCE_LABEL[p.eta_source] ?? p.eta_source}</small></td>
                  <td>{p.outlets.map((o) => <span key={o} className="tag outlet">{outletName(outlets, o)}</span>)}</td>
                  <td className="num">{fmtQty(p.open_qty)}<br /><small className="muted">{`${p.lines} 项`}</small></td>
                  <td className="num hide-sm">{p.in_transit ? fmtQty(p.in_transit) : ""}</td>
                  <td className="num"><b>{fmtQty(p.remaining)}</b></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {nHidden > 0 && <p className="muted small">{`另有 ${nHidden} 张 120 天以上的旧单或已关闭的 PO 没显示。`}</p>}
      <div className="actions">
        <button type="button" className="ghost" onClick={onBack}>上一步</button>
        <button type="button" disabled={picked.size === 0} onClick={() => onOk([...picked].sort())}>{okText}</button>
      </div>
    </div>
  );
}
