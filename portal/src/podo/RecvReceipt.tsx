// 点货纪录（唯读）与点货后的进货待入 AutoCount；从 Receive.tsx 拆出来（只搬程式码）。
import { useState } from "react";
import { can, canGrn, fmtDate, fmtQty, Me } from "../api";
import { Receipt, RecvFull, RecvMove, RecvSummary, requestLabel } from "../podo-api";
import { IssueBadges } from "./common";
import { AddIssueModal, issueModel } from "./Issues";
import { r3, sumOf } from "./RecvForm";

/** 点货结果的小标签（清单、DO 画面共用）：点货时的到货少 / 坏货 / 多到 / 来错；已记的比点到的多；点完之后才补记的 */
export function SummaryTags({ s, unmatched = 0 }: { s: RecvSummary; unmatched?: number }) {
  const n = Number(s.short) + Number(s.damaged) + Number(s.over) + Number(s.wrong);
  const later = s.later ?? { damaged: 0, short: 0, wrong: 0 };
  const laterN = Number(later.damaged) + Number(later.short) + Number(later.wrong);
  return (
    <>
      {n === 0 && !unmatched && <span className="okc">{laterN ? "点货时全部到齐" : "全部到齐"}</span>}
      {n === 0 && unmatched > 0 && <span className="tag warn">{`开单时记了来错的型号 ${unmatched} 行`}</span>}
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

export function ReceiptView({ me, d, flash, onChanged }: { me: Me; d: RecvFull; flash: string; onChanged: () => void }) {
  const [addIssue, setAddIssue] = useState(false);
  const [stockMsg, setStockMsg] = useState("");
  const r: Receipt | null = d.receipt;
  const canAdd = d.status === "arrived" || d.status === "confirmed";
  return (
    <>
      {flash && !flash.startsWith("!") && <div className="ok">{flash}</div>}
      {flash.startsWith("!") && (
        <>
          <div className="error">{flash.slice(1)}</div>
          <p className="small">你点的数字跟下面的纪录不一样的话，用「＋ 记坏货 / 到货少 / 来错货」补记（会跟著调整进货待入 AutoCount）。</p>
        </>
      )}
      {d.status === "draft" && <div className="error">这张厂家 DO 还没确认（草稿），不能点货。</div>}
      {d.status === "cancelled" && <div className="error">这张厂家 DO 已取消。</div>}
      {d.status === "arrived" && (
        <div className="ok">{`已点货 · ${d.arrived_by_name ?? ""} · ${fmtDate(d.arrived_at)}${d.arrive_note ? " · " + d.arrive_note : ""}`}</div>
      )}
      {d.status === "arrived" && d.summary && <p className="small recv-sum-line"><SummaryTags s={d.summary} unmatched={d.unmatched_count} /></p>}
      {d.status === "arrived" && !r && <p className="muted">这张是以前直接「标记到货」的，没有点货纪录。</p>}
      {r && <ReceiptTable d={d} r={r} />}
      {(d.moves ?? []).length > 0 && <MovesView me={me} moves={d.moves!} />}
      {d.status === "arrived" && (
        <>
          <div className="podo-group-head">
            <h3>{`厂家问题（${d.issues.length}）`}</h3>
            {canAdd && <button className="small" onClick={() => setAddIssue(true)}>＋ 记坏货 / 到货少 / 来错货 / 缺零件</button>}
          </div>
          {d.issues.length === 0 ? <p className="muted small">这张没有厂家问题。</p> : (
            <ul className="list recv-issues">
              {d.issues.map((i) => (
                <li key={i.id}>
                  <span>
                    <IssueBadges i={i} />
                    <b>{i.kind === "wrong" ? (i.received_code || i.item_code || "—") : i.kind === "part" ? issueModel(i) : i.item_code}</b>
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
          {stockMsg && <div className="podo-sum warn">{stockMsg}</div>}
          <p className="muted small">点完货之后补记：坏货 / 到货少会从还没输入 AutoCount 的进货扣掉；来错的货（我们的型号）会多一笔进货。补记的备注会印在给厂家的清单 / 讯息上。</p>
          {can(me, "purchasing", "edit") && d.issues.length > 0 && (
            <p className="small"><a href="#/purchasing/issues">到「厂家问题」处理（厂家会补 / 取消 / 已处理）→</a></p>
          )}
        </>
      )}
      {addIssue && (
        <AddIssueModal doFull={{ id: d.id, company: d.company, items: d.items, candidates: d.items, status: d.status,
                                 locations: d.locations, main_location: d.main_location }}
                       onClose={() => setAddIssue(false)}
                       onSaved={(r) => {
                         setAddIssue(false);
                         const left = Number(r?.stock_left ?? 0);
                         setStockMsg(left > 0 ? `这 ${fmtQty(left)} 件已经输入 AutoCount（或点货时 AutoCount 就有），扣不到：请仓库主管在 AutoCount 调整库存（例：登记「报坏」）。` : "");
                         onChanged();
                       }} />
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
  const doNote = new Map(d.items.filter((x) => x.note).map((x) => [x.item_code, x.note!]));
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
                    {doNote.get(x.item_code) && <small className="pre recv-do-note">{`开单备注：${doNote.get(x.item_code)}`}</small>}
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
                  {w.own ? <small className="muted">{` · 进 ${w.location || "HQ"}`}</small> : w.own === false ? <small className="muted">{" · 不是我们的产品"}</small> : null}
                  {w.expected_code && <small className="muted">{` · 本来应该是 ${w.expected_code}`}</small>}
                  {w.request && <small className="muted">{` · 要厂家：${requestLabel("wrong", w.request)}`}</small>}
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

// ------------------------------------------------------------------ 点货后：进货待入 AutoCount（仓库库存已算进去，等开单部开 GRN）
function MovesView({ me, moves }: { me: Me; moves: RecvMove[] }) {
  const pending = moves.filter((m) => m.status === "pending").length;
  return (
    <div className="card podo-items">
      <h3>{`进货待入 AutoCount（${moves.length}）`}</h3>
      <p className="muted small">
        {pending ? `这些货已经算进仓库库存（查货、盘点的「应有」）；开单部在 AutoCount 开好进货单（GRN）后按「已输入」。还有 ${pending} 笔没输入。`
          : "都已经输入 AutoCount。"}
      </p>
      <div className="table-wrap flat">
        <table>
          <thead><tr><th>型号 / 品名</th><th>仓位</th><th className="num">数量</th><th className="hide-sm">PO</th><th>状态</th></tr></thead>
          <tbody>
            {moves.map((m) => (
              <tr key={m.id}>
                <td>
                  <b>{m.item_code}</b> <small>{m.description}</small>
                  {m.recv_wrong && <span className="tag warn">来错的货</span>}
                  {m.po_no && <><br /><small className="muted show-sm">{`PO ${m.po_no}`}</small></>}
                  {m.status === "pending" && m.pre_grn && <><br /><small className="amber">{`点货时 AutoCount 已经有（GRN ${m.pre_grn}），没有重复算库存`}</small></>}
                  {m.note && <><br /><small className="muted">{m.note}</small></>}
                </td>
                <td>{m.location}</td>
                <td className="num">{fmtQty(m.qty)}</td>
                <td className="hide-sm small">{m.po_no ?? (m.recv_wrong ? "" : "—")}</td>
                <td className="small">
                  <span className={"ap " + (m.status === "pending" ? "pending" : m.status === "done" ? "approved" : "cancelled")}>
                    {m.status === "pending" ? "待开 GRN" : m.status === "done" ? "已输入" : "已取消"}
                  </span>
                  {m.ac_doc && <div className="muted">{m.ac_doc}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {canGrn(me) && pending > 0 && <p className="small"><a href="#/warehouse/grn">到「待开进货单」输入 GRN →</a></p>}
    </div>
  );
}
