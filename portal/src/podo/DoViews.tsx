// 厂家到货：点货纪录摘要、已确认的唯读型号表与分配、确认前的总览；从 DoEditor.tsx 拆出来（只搬程式码）。
import { useState } from "react";
import { fmtQty } from "../api";
import { ErrorBox, Modal } from "../ui";
import { DECISION_LABEL, DoFull, num, Outlet, requestLabel } from "../podo-api";
import { outletName } from "./common";
import { Est, PRow, r3, Row, XRow } from "./doRows";

// ------------------------------------------------------------------ 已到货：点货纪录的摘要（全文在 #/purchasing/receive/<id>）
export function ReceiptSummary({ full }: { full: DoFull }) {
  const r = full.receipt!;
  const sum = (f: (x: (typeof r.items)[number]) => number) => r3(r.items.reduce((s, x) => s + f(x), 0));
  const good = sum((x) => Number(x.received));
  const damaged = sum((x) => Number(x.damaged));
  const short = sum((x) => Math.max(0, Number(x.shipped) - Number(x.received) - Number(x.damaged)));
  const over = sum((x) => Math.max(0, Number(x.received) + Number(x.damaged) - Number(x.shipped)));
  const wrong = r3(r.wrong.reduce((s, x) => s + Number(x.qty), 0));
  // 点货前记的坏货 / 到货少比点到的缺口多（要采购核对）
  const mism = sum((x) => Math.max(0, Number(x.prior?.damaged ?? 0) + Number(x.prior?.short ?? 0) - Math.max(0, Number(x.shipped) - Number(x.received))));
  // 点完货之后才补记的（手动、不是点货记的）
  const arrived = full.arrived_at ? new Date(full.arrived_at).getTime() : 0;
  const later = full.issues.filter((i) => !i.auto && i.status !== "void" && !r.issue_ids.includes(i.id) && new Date(i.created_at).getTime() > arrived);
  const laterOf = (k: string) => r3(later.filter((i) => i.kind === k).reduce((s, i) => s + Number(i.qty), 0));
  // 改了分店分配（只有一间分店、好货全给那间不算：那只是数量跟著好货变）
  const changed = r.items.filter((x) => {
    const a = normAlloc(x.alloc), p = normAlloc(x.planned);
    if (JSON.stringify(a) === JSON.stringify(p)) return false;
    return !(p.length === 1 && a.length <= 1 && (a.length === 0 || a[0][0] === p[0][0]));
  }).length;
  return (
    <div className="card podo-recv-sum">
      <b>点货纪录</b>
      <span>{`好货 ${fmtQty(good)}`}</span>
      {damaged > 0 && <span className="late">{`坏货 ${fmtQty(damaged)}`}</span>}
      {short > 0 && <span className="late">{`到货少 ${fmtQty(short)}`}</span>}
      {over > 0 && <span className="amber">{`多到 ${fmtQty(over)}`}</span>}
      {wrong > 0 && <span className="late">{`来错 ${fmtQty(wrong)}`}</span>}
      {damaged + short + over + wrong === 0 && <span className="okc">{later.length ? "点货时全部照 DO 到齐" : "全部照 DO 到齐"}</span>}
      {mism > 0 && <span className="amber">{`已记的比点到的多 ${fmtQty(mism)}`}</span>}
      {laterOf("damaged") > 0 && <span className="late">{`之后补记坏货 ${fmtQty(laterOf("damaged"))}`}</span>}
      {laterOf("short") > 0 && <span className="late">{`之后补记到货少 ${fmtQty(laterOf("short"))}`}</span>}
      {laterOf("wrong") > 0 && <span className="late">{`之后补记来错 ${fmtQty(laterOf("wrong"))}`}</span>}
      {changed > 0 && <span className="muted">{`${changed} 个型号改了分店分配`}</span>}
      <a href={`#/purchasing/receive/${full.id}`}>看点货纪录 →</a>
    </div>
  );
}

/** 分配比对用：拿掉 0、照分店代号排序 */
function normAlloc(a: Record<string, number> | null | undefined): [string, number][] {
  return Object.entries(a ?? {}).filter(([, v]) => Number(v) > 0).map(([k, v]): [string, number] => [k, Number(v)]).sort(([x], [y]) => x.localeCompare(y));
}

// ------------------------------------------------------------------ 已确认：唯读的型号表、分到哪几张 PO
export function ItemsView({ full }: { full: DoFull }) {
  const items = full.items.filter((x) => x.item_code);
  const wrong = full.items.filter((x) => !x.item_code);
  const codes = full.outlets.filter((o) => items.some((x) => (x.alloc?.[o.code] ?? 0) > 0));
  return (
    <div className="card podo-items">
      <h3>{`这批出货（${items.length} 个型号）`}</h3>
      <div className="table-wrap flat">
        <table className="podo-table">
          <thead>
            <tr><th className="sticky">型号 / 品名</th><th className="num">出货</th>{codes.map((o) => <th key={o.code} className="num">{o.short_name || o.name}</th>)}</tr>
          </thead>
          <tbody>
            {items.map((x) => (
              <tr key={x.item_code!}>
                <td className="sticky">
                  <b>{x.item_code}</b> <small className="muted">{x.uom}</small><br /><small>{x.description}</small>
                  {x.src_row != null && <><br /><small className="muted">{x.src_code && x.src_code.toUpperCase() !== x.item_code!.toUpperCase() ? `Excel 第 ${x.src_row} 行 · ${x.src_code}` : `Excel 第 ${x.src_row} 行`}</small></>}
                  {x.note && <><br /><small className="pre">{`备注：${x.note}`}</small></>}
                </td>
                <td className="num"><b>{fmtQty(x.shipped)}</b></td>
                {codes.map((o) => <td key={o.code} className="num">{x.alloc?.[o.code] ? fmtQty(x.alloc[o.code]) : ""}</td>)}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td className="sticky"><b>合计</b></td>
              <td className="num"><b>{fmtQty(items.reduce((s, x) => s + Number(x.shipped), 0))}</b></td>
              {codes.map((o) => <td key={o.code} className="num"><b>{fmtQty(items.reduce((s, x) => s + Number(x.alloc?.[o.code] ?? 0), 0))}</b></td>)}
            </tr>
          </tfoot>
        </table>
      </div>
      {wrong.length > 0 && (
        <>
          <h3>{`来错的型号（${wrong.length}）`}</h3>
          <ul className="list">
            {wrong.map((x, n) => (
              <li key={n}>
                <span><b>{x.src_code || "—"}</b> <small>{x.src_desc}</small>{x.own === false && <small className="muted">{" · 不是我们的产品"}</small>}
                  {x.expected_code && <small className="muted">{` · 本来应该是 ${x.expected_code}`}</small>}
                  {x.request && <small className="muted">{` · 要厂家：${requestLabel("wrong", x.request)}`}</small>}
                  {x.note && <small className="muted">{` · ${x.note}`}</small>}</span>
                <span>{fmtQty(x.shipped)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {(full.parts ?? []).length > 0 && (
        <>
          <h3>{`缺零件 / 其他要补的（${full.parts!.length}）`}</h3>
          <ul className="list">
            {full.parts!.map((x, n) => (
              <li key={n}>
                <span><b>{`${x.item_code ? x.item_code + " " : ""}缺「${x.part_name}」`}</b>
                  {x.request && <small className="muted">{` · 要厂家：${requestLabel("part", x.request)}`}</small>}
                  {x.note && <small className="muted">{` · ${x.note}`}</small>}</span>
                <span>{fmtQty(x.qty)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

export function AppliedView({ full }: { full: DoFull }) {
  return (
    <details className="podo-history">
      <summary>{`记在哪几行 PO（${full.applied.length} 笔）`}</summary>
      <p className="muted small">确认时把每间分店的数量记在那间分店订的 PO 行（先开的单先记）；分店没订或订不够就记在同型号其他分店的 PO 行；再多就是多发。</p>
      <div className="table-wrap flat">
        <table>
          <thead><tr><th>型号</th><th>分店</th><th className="num">数量</th><th>PO</th><th>说明</th></tr></thead>
          <tbody>
            {full.applied.map((a, n) => (
              <tr key={n}>
                <td>{a.item_code}</td>
                <td>{outletName(full.outlets, a.outlet)}</td>
                <td className="num">{fmtQty(a.qty)}</td>
                <td>{a.po_no ?? "—"}</td>
                <td className="small muted">
                  {a.dtl_key == null ? "超出 PO（多发）" : a.line_outlet && a.line_outlet !== a.outlet ? `用 ${outletName(full.outlets, a.line_outlet)} 订的 PO 行` : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

// ------------------------------------------------------------------ 确认前：总览、预计的厂家问题、顺便记坏货
interface Damaged { item_code: string; qty: string; note: string }
export function ConfirmModal({ order, rows, xrows, prows, est, outlets, hasEta, hasNo, onClose, onOk }: {
  order: string[]; rows: Record<string, Row>; xrows: XRow[]; prows: PRow[]; est: Est[]; outlets: Outlet[];
  hasEta: boolean; hasNo: boolean; onClose: () => void; onOk: (damaged: Damaged[]) => Promise<void>;
}) {
  const [damaged, setDamaged] = useState<Damaged[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const shipped = order.filter((c) => num(rows[c].shipped) > 0);
  const shorts = est.filter((x) => x.short > 0);
  const overs = est.filter((x) => x.over > 0);
  const wrongs = xrows.filter((x) => num(x.shipped) > 0);
  const parts = prows.filter((x) => x.part_name.trim());
  const decText = (code: string) => DECISION_LABEL[rows[code].short_decision || "pending"];
  const byOutlet = outlets.map((o) => ({ o, n: r3(order.reduce((s, c) => s + (num(rows[c].alloc[o.code]) || 0), 0)) })).filter((x) => x.n > 0);

  async function ok() {
    for (const d of damaged) {
      if (!d.item_code || !(num(d.qty) > 0)) return setError("坏货要选型号、填数量。");
      if (num(d.qty) > num(rows[d.item_code]?.shipped)) return setError(`坏货数量不能多过这张 DO 的出货数量（${fmtQty(num(rows[d.item_code]?.shipped))}）。`);
    }
    setBusy(true);
    setError("");
    try {
      await onOk(damaged);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  const list = (xs: Est[], f: (x: Est) => string) => (
    <ul className="list small">
      {xs.slice(0, 15).map((x) => <li key={x.c}><span>{x.c}</span><span>{f(x)}</span></li>)}
      {xs.length > 15 && <li><span className="muted">{`还有 ${xs.length - 15} 个`}</span></li>}
    </ul>
  );

  return (
    <Modal title="确认这张厂家 DO" onClose={onClose} wide>
      <p>{`${shipped.length} 个型号，共 ${fmtQty(r3(shipped.reduce((s, c) => s + num(rows[c].shipped), 0)))} 件。`}
        {byOutlet.map((x) => <span key={x.o.code} className="tag outlet">{`${x.o.short_name || x.o.name} ${fmtQty(x.n)}`}</span>)}
      </p>
      <p className="muted small">确认后：各分店在「在路上」看得到这批货与 ETA；下面的少发 / 多发 / 发错型号 / 缺零件会记到「厂家问题」（已记过的不会重复记），可以 WhatsApp 发给厂家。</p>
      {!hasEta && <div className="podo-sum warn">还没填 ETA：分店会看到「未填」。可以确认后再补。</div>}
      {!hasNo && <div className="podo-sum warn">还没填厂家 DO 号。</div>}
      {shorts.length > 0 && <><h3>{`少发（${shorts.length}）`}</h3>{list(shorts, (x) => `还可以出 ${fmtQty(x.rem)} · 出 ${fmtQty(x.s)} · 少 ${fmtQty(x.short)}`
        + (x.newShort === 0 ? " · 已记过" : (x.newShort < x.short ? ` · 新记 ${fmtQty(x.newShort)}` : "") + ` · ${decText(x.c)}`))}</>}
      {overs.length > 0 && <><h3>{`多发（${overs.length}）`}</h3>{list(overs, (x) => `还可以出 ${fmtQty(x.rem)} · 出 ${fmtQty(x.s)} · 多 ${fmtQty(x.over)}`
        + (x.newOver < x.over ? ` · 先补厂家欠的 ${fmtQty(r3(x.over - x.newOver))}` : ""))}</>}
      {wrongs.length > 0 && (
        <>
          <h3>{`发错型号（${wrongs.length}）`}</h3>
          <ul className="list small">
            {wrongs.map((x) => (
              <li key={x.key}>
                <span>{x.src_code || x.src_desc}{x.own === false && <small className="muted">{" · 不是我们的产品"}</small>}
                  {x.request && <small className="muted">{` · 要厂家：${requestLabel("wrong", x.request)}`}</small>}</span>
                <span>{fmtQty(num(x.shipped))}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {parts.length > 0 && (
        <>
          <h3>{`缺零件（${parts.length}）`}</h3>
          <ul className="list small">
            {parts.map((x) => (
              <li key={x.key}>
                <span>{`${x.item_code ? x.item_code + " " : ""}缺「${x.part_name.trim()}」`}
                  {x.request && <small className="muted">{` · 要厂家：${requestLabel("part", x.request)}`}</small>}</span>
                <span>{fmtQty(num(x.qty))}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <h3>坏货 / 破损（可不填，货到了再记也可以）</h3>
      {damaged.map((d, n) => (
        <div key={n} className="row podo-damaged">
          <select value={d.item_code} onChange={(e) => setDamaged(damaged.map((x, i) => (i === n ? { ...x, item_code: e.target.value } : x)))}>
            <option value="">（选型号）</option>
            {shipped.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <input className="podo-num" inputMode="decimal" placeholder="数量" value={d.qty}
                 onChange={(e) => setDamaged(damaged.map((x, i) => (i === n ? { ...x, qty: e.target.value } : x)))} />
          <input placeholder="备注" value={d.note} onChange={(e) => setDamaged(damaged.map((x, i) => (i === n ? { ...x, note: e.target.value } : x)))} />
          <button type="button" className="small ghost danger" onClick={() => setDamaged(damaged.filter((_, i) => i !== n))}>×</button>
        </div>
      ))}
      <button type="button" className="small ghost" onClick={() => setDamaged([...damaged, { item_code: "", qty: "", note: "" }])}>＋ 记一笔坏货</button>
      <ErrorBox error={error} />
      <div className="actions">
        <button type="button" className="ghost" onClick={onClose}>取消</button>
        <button type="button" disabled={busy} onClick={ok}>{busy ? "确认中…" : "确认（在路上）"}</button>
      </div>
    </Modal>
  );
}
