// 厂家到货草稿：这批的问题（少发 / 多发 / 来错的型号 / 缺零件）、确认按钮上方的摘要、这家还欠；从 DoEditor.tsx 拆出来（只搬程式码）。
import { useEffect, useState } from "react";
import { fmtQty } from "../api";
import { Candidate, DECISION_LABEL, Issue, joinList, num, podo } from "../podo-api";
import { OurItemPicker, Picked, RequestSelect } from "./common";
import { issueModel } from "./Issues";
import { Est, PRow, r3, Row, XRow } from "./doRows";

// ------------------------------------------------------------------ 草稿：这批的问题
// 少发 / 多发照表格自动列出（备注 = 那一行的备注，会带进厂家问题）；少发先选厂家会补 / 取消 / 未决定。
// 来错的型号：手动加的搜我们的商品或「不是我们的产品」（没有「就是 X」下拉：使用者一选整行被并掉）；Excel 对不上的行保留「就是 X？」，
// 但要再确认一次才并。缺零件 / 其他要补的：确认时变成厂家问题（不影响在路上与少发）。
export function ProblemsPanel({ editable, company, order, rows, candMap, est, xrows, prows, poNos, others, busy, setRow, setX, setP,
  setDecisionAll, addX, dropX, addP, dropP, mapX, loadOthers, addPos }: {
  editable: boolean; company: string; order: string[]; rows: Record<string, Row>; candMap: Map<string, Candidate>; est: Est[];
  xrows: XRow[]; prows: PRow[]; poNos: string[]; others: Candidate[] | null; busy: boolean;
  setRow: (code: string, f: (r: Row) => Row) => void; setX: (key: string, patch: Partial<XRow>) => void;
  setP: (key: string, patch: Partial<PRow>) => void; setDecisionAll: (d: Row["short_decision"]) => void;
  addX: () => void; dropX: (key: string) => void; addP: () => void; dropP: (key: string) => void;
  mapX: (x: XRow, code: string) => void; loadOthers: () => void; addPos: (pos: string[]) => void;
}) {
  const shorts = est.filter((x) => x.short > 0);
  const overs = est.filter((x) => x.over > 0);
  const shipped = order.filter((c) => num(rows[c].shipped) > 0);
  const desc = (code: string) => candMap.get(code)?.description ?? "";
  const noteInput = (code: string) => (
    <input className="podo-note" value={rows[code].note} disabled={!editable} placeholder="备注（会带进厂家问题、给厂家的讯息）"
           aria-label={`问题备注 ${code}`} onChange={(e) => setRow(code, (x) => ({ ...x, note: e.target.value, showNote: true }))} />
  );
  // 手动加的行选了我们的型号：在别张还没到齐的 PO 上 → 提示加选那张 PO；就在所选的 PO → 提示直接填上面的表格
  const otherFor = (code: string) => {
    if (!code || rows[code] || !others) return null;
    const c = others.find((o) => o.item_code === code);
    const pos = (c?.po_nos ?? []).filter((p) => !poNos.includes(p));
    return pos.length ? pos : null;
  };

  return (
    <div className="podo-problems">
      <h3>这批的问题</h3>
      <p className="muted small">少发、多发照上面的出货数量自动列出；来错的型号、缺零件自己加。确认后都记进「厂家问题」，可以 WhatsApp 发给厂家。</p>

      <h4>{`少发（${shorts.length}）`}</h4>
      {shorts.length === 0 ? <p className="muted small">没有少发。</p> : (
        <>
          {editable && shorts.some((x) => x.newShort > 0) && (
            <div className="toolbar">
              <span className="small muted">全部：</span>
              <button type="button" className="small ghost" onClick={() => setDecisionAll("await")}>厂家会补</button>
              <button type="button" className="small ghost" onClick={() => setDecisionAll("cancelled")}>取消（下次再订）</button>
              <button type="button" className="small ghost" onClick={() => setDecisionAll("")}>未决定</button>
            </div>
          )}
          <ul className="list podo-prob-list">
            {shorts.map((x) => (
              <li key={x.c}>
                <span className="podo-prob-what">
                  <b>{x.c}</b> <small>{desc(x.c)}</small><br />
                  <small className="muted">{`还可以出 ${fmtQty(x.rem)} · 出 ${fmtQty(x.s)} · 少 ${fmtQty(x.short)}`}</small>
                  {x.newShort === 0 && <><br /><small className="muted">已记过（之前的少发还没补齐），不重复记</small></>}
                  {x.newShort > 0 && x.newShort < x.short && <><br /><small className="muted">{`新记 ${fmtQty(x.newShort)}（其余之前已记过）`}</small></>}
                </span>
                <span className="podo-prob-do">
                  {x.newShort > 0 && (
                    <select value={rows[x.c].short_decision} disabled={!editable} aria-label={`${x.c} 少发怎么处理`}
                            onChange={(e) => setRow(x.c, (r) => ({ ...r, short_decision: e.target.value as Row["short_decision"] }))}>
                      <option value="">未决定</option>
                      <option value="await">厂家会补</option>
                      <option value="cancelled">取消（下次再订）</option>
                    </select>
                  )}
                  {noteInput(x.c)}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      <h4>{`多发（${overs.length}）`}</h4>
      {overs.length === 0 ? <p className="muted small">没有多发。</p> : (
        <ul className="list podo-prob-list">
          {overs.map((x) => (
            <li key={x.c}>
              <span className="podo-prob-what">
                <b>{x.c}</b> <small>{desc(x.c)}</small><br />
                <small className="muted">{`还可以出 ${fmtQty(x.rem)} · 出 ${fmtQty(x.s)} · 多 ${fmtQty(x.over)}`}</small>
                {x.newOver < x.over && <><br /><small className="muted">{`先补厂家欠的 ${fmtQty(r3(x.over - x.newOver))}`}</small></>}
              </span>
              <span className="podo-prob-do">{noteInput(x.c)}</span>
            </li>
          ))}
        </ul>
      )}

      <h4>{`来错的型号（${xrows.length}）`}</h4>
      {xrows.length === 0 && <p className="muted small">收到不是这些 PO 的型号（例：订白色收到黑色）才加。Excel 里对不到 PO 的行也会列在这里。</p>}
      {xrows.map((x, i) => {
        const otherPos = x.manual && x.own ? otherFor(x.src_code) : null;
        const inTable = x.manual && x.own && !!rows[x.src_code];
        const excelPos = !x.manual && x.other && !rows[x.other.item_code] ? x.other.po_nos : null;
        const sugg = !x.manual ? [...new Set([...(x.other ? [x.other.item_code] : []), ...x.suggest])].filter((c) => rows[c]) : [];
        return (
          <div key={x.key} className="recv-wrong-card podo-wrong-card">
            <div className="recv-wrong-head">
              <b className="small">{x.manual ? `第 ${i + 1} 行` : x.sheet ? `${x.sheet} 第 ${x.src_row} 行` : `Excel 第 ${x.src_row} 行`}</b>
              {editable && <button type="button" className="small ghost danger" onClick={() => dropX(x.key)}>拿掉</button>}
            </div>
            <div className="wide pick-field">
              <span className="pick-label">收到的型号</span>
              {x.manual ? (
                <OurItemPicker company={company} disabled={!editable}
                               value={{ own: x.own ?? null, code: x.src_code, desc: x.src_desc }}
                               onChange={(v: Picked) => {
                                 setX(x.key, { own: v.own, src_code: v.code, src_desc: v.desc });
                                 if (v.own) loadOthers();
                               }} />
              ) : (
                <span className="podo-xsrc"><b>{x.src_code || "—"}</b> <small>{x.src_desc}</small></span>
              )}
            </div>
            {inTable && <p className="small amber wide">{`${x.src_code} 就在所选的 PO 里：直接在上面的表格填出货数量就好，不用记成来错。`}</p>}
            {inTable && editable && (
              <button type="button" className="small ghost wide-btn" onClick={() => mapX(x, x.src_code)}>{`并进上面的 ${x.src_code}`}</button>
            )}
            {(otherPos || excelPos) && (
              <p className="small late wide">
                {`这个型号在 ${joinList((otherPos ?? excelPos)!)} 有订，要加选那张 PO 吗？`}{" "}
                <button type="button" className="small ghost" disabled={!editable || busy} onClick={() => addPos((otherPos ?? excelPos)!)}>
                  {`加选 ${joinList((otherPos ?? excelPos)!)}`}
                </button>
              </p>
            )}
            <label>数量
              <input className="podo-num" inputMode="decimal" value={x.shipped} disabled={!editable} aria-label="来错数量"
                     onChange={(e) => setX(x.key, { shipped: e.target.value })} />
            </label>
            <label>本来应该是（可不填）
              <select value={x.expected_code} disabled={!editable} aria-label="本来应该是" onChange={(e) => setX(x.key, { expected_code: e.target.value })}>
                <option value="">—</option>
                {order.map((code) => <option key={code} value={code}>{code}</option>)}
              </select>
            </label>
            <label>要厂家怎么处理
              <RequestSelect kind="wrong" value={x.request} disabled={!editable} onChange={(v) => setX(x.key, { request: v })} />
            </label>
            <label className="wide">备注
              <input value={x.note} disabled={!editable} placeholder="例：订白色收到黑色，请换货" aria-label="来错备注"
                     onChange={(e) => setX(x.key, { note: e.target.value })} />
            </label>
            {!x.manual && editable && (sugg.length > 0 || order.length > 0) && (
              <div className="wide podo-same">
                <small className="muted">厂家写法不同、其实是同一个型号？</small>
                {sugg.map((c) => (
                  <button key={c} type="button" className="small ghost" onClick={() => mapX(x, c)}>{`就是 ${c}？`}</button>
                ))}
                <select value="" aria-label="就是哪个型号" onChange={(e) => e.target.value && mapX(x, e.target.value)}>
                  <option value="">就是…（选了会再问一次）</option>
                  {order.map((code) => <option key={code} value={code}>{`就是 ${code}（厂家写法不同）`}</option>)}
                </select>
              </div>
            )}
          </div>
        );
      })}
      {editable && <button type="button" className="small ghost" onClick={addX}>＋ 加一行来错的型号</button>}

      <h4>{`缺零件 / 其他要补的（${prows.length}）`}</h4>
      {prows.length === 0 && <p className="muted small">例：少了螺丝包、少一片玻璃。不影响在路上与少发的数量；确认后在「厂家问题」决定厂家会补或取消。</p>}
      {prows.map((x, i) => (
        <div key={x.key} className="recv-wrong-card podo-part-card">
          <div className="recv-wrong-head">
            <b className="small">{`第 ${i + 1} 行`}</b>
            {editable && <button type="button" className="small ghost danger" onClick={() => dropP(x.key)}>拿掉</button>}
          </div>
          <label>型号（可不选）
            <select value={x.item_code} disabled={!editable} aria-label="缺零件的型号" onChange={(e) => setP(x.key, { item_code: e.target.value })}>
              <option value="">—</option>
              {(shipped.length ? shipped : order).map((code) => <option key={code} value={code}>{code}</option>)}
            </select>
          </label>
          <label>缺的零件 / 东西
            <input value={x.part_name} disabled={!editable} placeholder="例：螺丝包" aria-label="缺的零件"
                   onChange={(e) => setP(x.key, { part_name: e.target.value })} />
          </label>
          <label>数量
            <input className="podo-num" inputMode="decimal" value={x.qty} disabled={!editable} aria-label="缺零件数量"
                   onChange={(e) => setP(x.key, { qty: e.target.value })} />
          </label>
          <label>要厂家怎么处理
            <RequestSelect kind="part" value={x.request} disabled={!editable} onChange={(v) => setP(x.key, { request: v })} />
          </label>
          <label className="wide">备注
            <input value={x.note} disabled={!editable} placeholder="例：每箱少 1 包" aria-label="缺零件备注"
                   onChange={(e) => setP(x.key, { note: e.target.value })} />
          </label>
        </div>
      ))}
      {editable && <button type="button" className="small ghost" onClick={addP}>＋ 加一行缺零件 / 其他要补的</button>}
    </div>
  );
}

/** 确认按钮上方的摘要：少发几个型号共几件（厂家会补 / 取消 / 未决定）、多发、来错、缺零件 */
export function ProblemSummary({ est, rows, xrows, prows }: { est: Est[]; rows: Record<string, Row>; xrows: XRow[]; prows: PRow[] }) {
  const shorts = est.filter((x) => x.short > 0);
  const overs = est.filter((x) => x.over > 0);
  const fresh = shorts.filter((x) => x.newShort > 0);
  const dec = (d: Row["short_decision"]) => fresh.filter((x) => rows[x.c].short_decision === d).length;
  const wrongs = xrows.filter((x) => num(x.shipped) > 0);
  const parts = prows.filter((x) => x.part_name.trim());
  if (!shorts.length && !overs.length && !wrongs.length && !parts.length) return null;
  const sum = (xs: number[]) => fmtQty(r3(xs.reduce((s, x) => s + x, 0)));
  const known = shorts.length - fresh.length;
  return (
    <p className="small podo-prob-sum">
      {shorts.length > 0 && (
        <span className={dec("") ? "amber" : ""}>
          {`少发 ${shorts.length} 个型号共 ${sum(shorts.map((x) => x.short))} 件（厂家会补 ${dec("await")} / 取消 ${dec("cancelled")} / 未决定 ${dec("")}${known ? ` / 已记过 ${known}` : ""}）`}
        </span>
      )}
      {overs.length > 0 && <span>{`多发 ${overs.length} 个型号共 ${sum(overs.map((x) => x.over))} 件`}</span>}
      {wrongs.length > 0 && <span>{`来错的型号 ${wrongs.length} 行`}</span>}
      {parts.length > 0 && <span>{`缺零件 ${parts.length} 项`}</span>}
    </p>
  );
}

/** 开同一家厂的新厂家到货（选完 PO）：这家还欠的（少发未决定 / 厂家会补还没补齐、缺零件还没处理），同 CS 工厂的排前面 */
export function OwedHint({ company, creditor, poNos, doId }: { company: string; creditor: string; poNos: string[]; doId: number | null }) {
  const [owed, setOwed] = useState<Issue[] | null>(null);
  const [facs, setFacs] = useState<string[]>([]);
  useEffect(() => {
    podo.issues({ status: "open", owed: true, company, creditor_code: creditor }).then(setOwed).catch(() => setOwed([]));
  }, [company, creditor]);
  const key = poNos.join(",");
  useEffect(() => {
    podo.pos(company, creditor)
      .then((ps) => setFacs([...new Set(ps.filter((p) => poNos.includes(p.po_no) && p.factory).map((p) => p.factory!))]))
      .catch(() => setFacs([]));
  }, [company, creditor, key]); // eslint-disable-line react-hooks/exhaustive-deps
  const list = (owed ?? []).filter((i) => i.do_id !== doId && Number(i.owed_qty) > 0)
    .sort((a, b) => Number(!facs.includes(a.factory ?? "")) - Number(!facs.includes(b.factory ?? "")));
  if (!list.length) return null;
  const same = list.filter((i) => i.factory && facs.includes(i.factory)).length;
  return (
    <div className="podo-sum warn podo-owed-hint">
      <b>{`这家还欠 ${list.length} 项`}</b>
      {facs.length > 0 && same > 0 && <>{" · "}<small>{`同一个工厂（${joinList(facs)}）的 ${same} 项排前面`}</small></>}
      <ul>
        {list.slice(0, 8).map((i) => (
          <li key={i.id}>
            {i.factory && <span className={"tag cs" + (facs.includes(i.factory) ? " hit" : "")}>{i.factory}</span>}
            <b>{issueModel(i)}</b>{` × ${fmtQty(i.owed_qty)}`}
            {" · "}<small className="muted">{`${i.kind === "part" ? "缺零件" : "少发"}${i.decision ? " · " + DECISION_LABEL[i.decision] : ""} · DO ${i.do_no || "#" + i.do_id}`}</small>
          </li>
        ))}
        {list.length > 8 && <li className="muted">{`还有 ${list.length - 8} 项`}</li>}
      </ul>
      <small>这批出了这些型号（同一张 PO）的话，确认时会自动补掉少发。 <a href="#/purchasing/issues">到厂家问题看 →</a></small>
    </div>
  );
}
