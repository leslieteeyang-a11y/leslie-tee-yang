// 开新厂家到货的前两步：选厂家 → 选这家的 PO（编辑草稿时「改 PO」也用 PoPicker）
import { useEffect, useMemo, useState } from "react";
import { BRANCH_LABEL, ETA_SOURCE_LABEL, fmtQty, Me, PO_STATUS_LABEL } from "../api";
import { Empty, ErrorBox } from "../ui";
import { DO_STATUS_LABEL, DoPo, DoSupplier, podo } from "../podo-api";
import { outletName, useOutlets } from "./common";

/** CS 编号比对（代理户口下的中国厂）：不分大小写、空白；cs28 = CS028；打一半（CS02）找开头相同的 */
export function csMatch(code: string, q: string): boolean {
  const k = q.toUpperCase().replace(/\s+/g, "");
  if (!/^CS\d/.test(k)) return false;
  if (code.startsWith(k)) return true;
  const n = /^CS0*(\d+)$/.exec(k)?.[1];
  return !!n && /^CS0*(\d+)$/.exec(code)?.[1] === n;
}

/** 厂家名称栏除了代理名称、CS 编号以外还写了东西（例「CS028 (ETA)」「CS011(还没订）」）才值得显示 */
function nameNote(name: string, supplierName: string, factory: string | null): string {
  if (!name) return "";
  let t = name.toUpperCase();
  if (supplierName) t = t.split(supplierName.toUpperCase()).join("");
  if (factory) t = t.replace(/CS\s*\d+/g, "");
  return t.replace(/[\s()（）\-,.，。]/g, "") ? name : "";
}

export function SupplierPicker({ me, company, onCompany, onPick }: {
  me: Me; company: string; onCompany: (c: string) => void; onPick: (s: DoSupplier, factoryQ?: string) => void;
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
    return (rows ?? []).filter((s) => !k || s.supplier_name.toLowerCase().includes(k) || s.creditor_code.toLowerCase().includes(k)
      || s.factories.some((f) => csMatch(f, q)));
  }, [rows, q]);

  return (
    <div className="card">
      <h2>第 1 步：选厂家</h2>
      <div className="toolbar">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜厂家名称、代号或 CS 编号…" autoFocus />
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
              {shown.map((s) => {
                const hit = s.factories.filter((f) => csMatch(f, q));
                return (
                <tr key={s.creditor_code} className="click" onClick={() => onPick(s, hit.length ? q.trim() : undefined)}>
                  <td>
                    <b>{s.supplier_name || s.creditor_code}</b>{s.is_china && <span className="tag">中国</span>}
                    {s.drafts > 0 && <span className="badge">{`草稿 ${s.drafts} 张`}</span>}
                    <br /><small className="muted">{s.creditor_code}</small>
                    {hit.length > 0
                      ? <div className="podo-tags">{hit.map((f) => <span key={f} className="tag cs hit">{f}</span>)}</div>
                      : s.factories.length > 0 && (
                        <div className="podo-tags">
                          {s.factories.slice(0, 6).map((f) => <span key={f} className="tag cs">{f}</span>)}
                          {s.factories.length > 6 && <small className="muted">{`+${s.factories.length - 6}`}</small>}
                        </div>
                      )}
                  </td>
                  <td className="num">{s.po_count}</td>
                  <td className="num">{fmtQty(s.open_qty)}</td>
                  <td className="hide-sm">{s.last_po_date}</td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** 勾这张厂家 DO 包含哪几张 PO。旧单（120 天以上）与已关闭的预设藏起来（已选的照样显示） */
export function PoPicker({ company, creditor, supplierName, selected, okText, onOk, onBack, initialQ = "" }: {
  company: string; creditor: string; supplierName: string; selected: string[]; okText: string;
  onOk: (poNos: string[]) => void; onBack: () => void; initialQ?: string;
}) {
  const outlets = useOutlets();
  const [rows, setRows] = useState<DoPo[] | null>(null);
  const [error, setError] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set(selected));
  const [old, setOld] = useState(false);
  const [q, setQ] = useState(initialQ);
  useEffect(() => {
    podo.pos(company, creditor).then(setRows).catch((e: Error) => setError(e.message));
  }, [company, creditor]);

  const hidden = (p: DoPo) => !picked.has(p.po_no) && !old && (p.closed || p.days_open > 120);
  const k = q.trim().toLowerCase();
  const hits = (rows ?? []).filter((p) => !k || p.po_no.toLowerCase().includes(k) || p.creditor_name.toLowerCase().includes(k)
    || (!!p.factory && csMatch(p.factory, q)));
  const shown = hits.filter((p) => !hidden(p));
  const nHidden = hits.length - shown.length;
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
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="找 PO 号或 CS 编号…" />
        <button type="button" className="ghost small" disabled={!rows}
                onClick={() => setPicked(new Set([...picked, ...shown.filter((p) => p.remaining > 0 && !p.closed).map((p) => p.po_no)]))}>
          勾选全部还可以出的
        </button>
        {picked.size > 0 && <button type="button" className="ghost small" onClick={() => setPicked(new Set())}>全部不选</button>}
        <label className="check"><input type="checkbox" checked={old} onChange={(e) => setOld(e.target.checked)} /> 含 120 天以上旧单与已关闭的</label>
        {picked.size > 0 && <small className="muted">{`已选 ${picked.size} 张`}</small>}
      </div>
      <ErrorBox error={error} />
      {rows === null ? <p className="muted">{error ? "" : "载入中…"}</p> : shown.length === 0 ? <Empty>{k ? "没有符合的 PO。" : "这个厂家没有还没到齐的 PO。"}</Empty> : (
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
                    <b>{p.po_no}</b>{p.factory && <span className="tag cs">{p.factory}</span>}
                    {p.closed && <span className="tag">{PO_STATUS_LABEL.closed}</span>}
                    <br /><small className="muted">{`${p.po_date} · ${p.days_open} 天`}</small>
                    {nameNote(p.creditor_name, supplierName, p.factory) && <><br /><small className="muted">{p.creditor_name}</small></>}
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
