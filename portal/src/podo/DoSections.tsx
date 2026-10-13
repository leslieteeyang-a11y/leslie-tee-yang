// 厂家到货草稿画面的两块：表头（DO 号、日期、ETA、货柜、备注、附件）与这批出货的型号表；从 DoEditor.tsx 拆出来（只搬程式码）。
import { ChangeEvent } from "react";
import { fmtQty, Shipment, SHIPMENT_STATUS_LABEL } from "../api";
import { Candidate, DoFile, DoFull, FILE_ACCEPT, joinList, num, Outlet } from "../podo-api";
import { FileList } from "./common";
import { allocByRemaining, allocSum, fullRow, r3, Row, withShipped } from "./doRows";

export interface Head { do_no: string; do_date: string; eta: string; shipment_id: string; remark: string }

/** 表头：确认后也可以改（DO 号、日期、ETA、货柜、备注、附件） */
export function HeadCard({ head, setHead, touch, infoEditable, busy, full, ships, ship, files, setFiles, onRead, onUpload, draftEditable }: {
  head: Head; setHead: (h: Head) => void; touch: () => void; infoEditable: boolean; busy: string; full: DoFull | null;
  ships: Shipment[]; ship: Shipment | undefined; files: DoFile[]; setFiles: (f: DoFile[]) => void;
  onRead: ((f: DoFile) => void) | undefined; onUpload: (e: ChangeEvent<HTMLInputElement>) => void; draftEditable: boolean;
}) {
  return (
      <div className="card podo-head">
        <fieldset className="plain" disabled={!infoEditable || !!busy}>
          <div className="row">
            <label>厂家 DO / 装箱单号<input value={head.do_no} onChange={(e) => { setHead({ ...head, do_no: e.target.value }); touch(); }} placeholder="例：FS-0901" /></label>
            <label>DO 日期<input type="date" value={head.do_date} onChange={(e) => { setHead({ ...head, do_date: e.target.value }); touch(); }} /></label>
            <label>预计到货（ETA）<input type="date" value={head.eta} onChange={(e) => { setHead({ ...head, eta: e.target.value }); touch(); }} /></label>
          </div>
          <div className="row">
            <label>货柜（可不选；货柜有 ETA 就以货柜为准）
              <select value={head.shipment_id} onChange={(e) => { setHead({ ...head, shipment_id: e.target.value }); touch(); }}>
                <option value="">（没有）</option>
                {full?.shipment_id && !ships.some((s) => s.id === full.shipment_id) && (
                  <option value={String(full.shipment_id)}>{full.shipment_name ?? `#${full.shipment_id}`}</option>
                )}
                {ships.map((s) => <option key={s.id} value={s.id}>{`${s.name}${s.eta ? " · ETA " + s.eta : ""} · ${SHIPMENT_STATUS_LABEL[s.status]}`}</option>)}
              </select>
            </label>
            <label>备注<input value={head.remark} onChange={(e) => { setHead({ ...head, remark: e.target.value }); touch(); }} /></label>
          </div>
          {ship?.eta && head.eta && ship.eta !== head.eta && <p className="muted small">{`挂了货柜：分店看到的 ETA 是货柜的 ${ship.eta}。`}</p>}
          <h3>附件（厂家 DO / 装箱单）</h3>
          <FileList files={files} onRemove={infoEditable ? (f) => { setFiles(files.filter((x) => x.path !== f.path)); touch(); } : undefined}
                    onRead={onRead} />
          {infoEditable && (
            <label className="ghost file-btn">
              {busy === "上传中…" ? "上传中…" : "＋ 上传 Excel / PDF / 照片"}
              <input type="file" accept={FILE_ACCEPT} multiple hidden onChange={onUpload} />
            </label>
          )}
          {draftEditable && <p className="muted small">Excel（.xlsx / .xls / .csv）会自动读出每个型号的数量；PDF、照片先当附件，数量在下面自己填：到齐的型号按「全到」，少到的再改数字。</p>}
        </fieldset>
      </div>
  );
}

/** 这批出货的型号表：还可以出、这批出货（全到）、各分店未出 / 分到、分配检查 */
export function ItemsTable({ shown, rows, candMap, showCols, editable, setRow, totShipped, totAlloc }: {
  shown: string[]; rows: Record<string, Row>; candMap: Map<string, Candidate>; showCols: Outlet[]; editable: boolean;
  setRow: (code: string, f: (r: Row) => Row) => void; totShipped: number; totAlloc: (o: string) => number;
}) {
  return (
      <div className="table-wrap flat">
        <table className="podo-table">
          <thead>
            <tr>
              <th className="sticky">型号 / 品名</th>
              <th className="num">还可以出</th>
              <th className="num">这批出货</th>
              {showCols.map((o) => <th key={o.code} className="num"><span>{o.short_name || o.name}</span><br /><small>未出 / 分到</small></th>)}
              <th>分配</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((code) => {
              const r = rows[code];
              const c = candMap.get(code);
              const s = num(r.shipped);
              const a = allocSum(r);
              const rem = c?.remaining ?? 0;
              const diff = r3((Number.isNaN(s) ? 0 : s) - a);
              return (
                <tr key={code} className={s > 0 ? "" : "podo-zero"}>
                  <td className="sticky">
                    <b>{code}</b> <small className="muted">{c?.uom}</small><br />
                    <small>{c?.description ?? ""}</small>
                    <div className="podo-tags">
                      {c && <small className="muted">{`PO ${joinList(c.po_nos)}`}</small>}
                      {r.excel === "hit" || (r.src_row != null && r.excel !== "missing")
                        ? <span className="tag">{r.src_code && r.src_code.toUpperCase() !== code.toUpperCase() ? `Excel 第 ${r.src_row} 行 · ${r.src_code}` : `Excel 第 ${r.src_row} 行`}</span>
                        : r.excel === "missing" ? <span className="tag warn">Excel 没有</span> : null}
                      {c && c.owed > 0 && <span className="tag warn">{`厂家欠 ${fmtQty(c.owed)}`}</span>}
                      {!c && <span className="tag warn">不在所选 PO</span>}
                    </div>
                    {editable && !r.showNote && (
                      <span className="podo-note-btn">
                        <button type="button" className="text-btn small" onClick={() => setRow(code, (x) => ({ ...x, showNote: true }))}>＋ 备注</button>
                        {!Number.isNaN(s) && r3(s) !== r3(rem) && <small className="muted">会带进厂家问题、印在给厂家的清单 / 讯息上</small>}
                      </span>
                    )}
                    {r.showNote && (editable
                      ? <>
                          <input className="podo-note" value={r.note} placeholder="备注（例：颜色不对）" aria-label={`${code} 备注`}
                                 onChange={(e) => setRow(code, (x) => ({ ...x, note: e.target.value }))} />
                          <small className="muted podo-note-hint">
                            {!Number.isNaN(s) && r3(s) !== r3(rem) ? "会带进厂家问题、印在给厂家的清单 / 讯息上；仓库点货时也看得到。" : "仓库点货时看得到。"}
                          </small>
                        </>
                      : <small className="pre">{r.note}</small>)}
                  </td>
                  <td className="num">
                    <b>{fmtQty(rem)}</b>
                    {c && c.in_transit > 0 && <><br /><small className="muted">{`别张 DO 在路上 ${fmtQty(c.in_transit)}`}</small></>}
                    {c && c.received_do > 0 && <><br /><small className="amber">{`含这张已开 GRN 的 ${fmtQty(c.received_do)}`}</small></>}
                    {c && <><br /><small className="muted">{`订 ${fmtQty(c.ordered)} · 已收 ${fmtQty(c.received)}`}</small></>}
                  </td>
                  <td className="num">
                    <input className="podo-num" inputMode="decimal" value={r.shipped} disabled={!editable}
                           onChange={(e) => setRow(code, (x) => withShipped(x, e.target.value, c))} aria-label={`${code} 出货`} />
                    {!Number.isNaN(s) && s > rem && <><br /><small className="late">{`多 ${fmtQty(r3(s - rem))}`}</small></>}
                    {!Number.isNaN(s) && s < rem && <><br /><small className="amber">{`少 ${fmtQty(r3(rem - s))}`}</small></>}
                    {editable && c && rem > 0 && (Number.isNaN(s) || r3(s) !== r3(rem)) && (
                      <><br /><button type="button" className="small ghost podo-full" onClick={() => setRow(code, (x) => fullRow(x, c))}>全到</button></>
                    )}
                  </td>
                  {showCols.map((o) => {
                    const bo = c?.by_outlet[o.code];
                    return (
                      <td key={o.code} className="num">
                        <small className="muted">{bo ? fmtQty(bo.remaining) : "—"}</small><br />
                        <input className="podo-num" inputMode="decimal" value={r.alloc[o.code] ?? ""} disabled={!editable}
                               onChange={(e) => setRow(code, (x) => ({ ...x, alloc: { ...x.alloc, [o.code]: e.target.value }, auto: false }))}
                               aria-label={`${code} ${o.short_name || o.name}`} />
                      </td>
                    );
                  })}
                  <td className="nowrap">
                    {Number.isNaN(s) ? <span className="late">不是数字</span>
                      : s === 0 && a === 0 ? <span className="muted">—</span>
                      : diff === 0 ? <span className="okc">✓</span>
                      : diff > 0 ? <span className="late">{`还差 ${fmtQty(diff)}`}</span>
                      : <span className="late">{`多分 ${fmtQty(-diff)}`}</span>}
                    {editable && c && !c.single_outlet && s > 0 && r3(s) === r3(c.remaining) && a === 0 && (
                      <><br /><button type="button" className="text-btn small" onClick={() => setRow(code, (x) => allocByRemaining(x, c))}>照未出分</button></>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <td className="sticky"><b>合计</b></td><td></td>
              <td className="num"><b>{fmtQty(totShipped)}</b></td>
              {showCols.map((o) => <td key={o.code} className="num"><b>{fmtQty(totAlloc(o.code))}</b></td>)}
              <td></td>
            </tr>
          </tfoot>
        </table>
      </div>
  );
}
