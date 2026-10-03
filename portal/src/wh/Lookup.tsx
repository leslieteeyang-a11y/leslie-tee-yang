// 仓库 · 查货：扫码 / 打字找商品，看各仓位库存、未输入的搬动、订单、在途 PO；不认识的纸箱条码可以绑定。
import { useCallback, useEffect, useState } from "react";
import { Me } from "../api";
import { ErrorBox } from "../ui";
import { ScanBox } from "./Scanner";
import { addLabels } from "./Labels";
import { MoveForm } from "./Moves";
import { COUNT_STATUS_LABEL, countClass, FoundItem, ItemDetail, MOVE_STATUS_LABEL, moveText, qtyLabel, whenLabel, wh } from "../wh-api";

export function Lookup({ me, company, locs, canEdit }: { me: Me; company: string; locs: string[]; canEdit: boolean }) {
  const [item, setItem] = useState<ItemDetail | null>(null);
  const [found, setFound] = useState<FoundItem[] | null>(null);
  const [unknown, setUnknown] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [moving, setMoving] = useState(false);
  const [notice, setNotice] = useState("");

  const open = useCallback(async (code: string) => {
    setError(""); setNotice(""); setBusy(true);
    try {
      const d = await wh.item(company, code);
      if (d.found) { setItem(d); setFound(null); setUnknown(""); }
      else {
        const f = await wh.find(company, code);
        setItem(null);
        if (f.length === 1) { setItem(await wh.item(company, f[0].item_code)); setFound(null); setUnknown(""); }
        else { setFound(f); setUnknown(f.length === 0 ? code : ""); }
      }
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  }, [company]);
  useEffect(() => { setItem(null); setFound(null); setUnknown(""); }, [company]);

  return (
    <>
      <ScanBox onCode={open} busy={busy} />
      <ErrorBox error={error} />
      {notice && <div className="ok">{notice}</div>}
      {busy && <p className="muted">查找中…</p>}
      {found && found.length > 0 && (
        <ul className="list wh-found">
          {found.map((f) => (
            <li key={f.item_code} className="click" onClick={() => open(f.item_code)}>
              <span><b>{f.item_code}</b>{" "}<span className="muted small">{f.description}</span></span>
              <span className="nowrap">{qtyLabel(f.qty)}{" "}<span className="muted small">{f.uom}</span></span>
            </li>
          ))}
        </ul>
      )}
      {unknown && <Unknown code={unknown} company={company} canEdit={canEdit} onBound={(c) => open(c)} />}
      {item && (
        <ItemCard d={item} canEdit={canEdit}
                  onMove={() => setMoving(true)}
                  onLabel={() => { addLabels([{ item_code: item.item_code, description: item.description, copies: 1 }]); setNotice("已加入「印条码」清单。"); }} />
      )}
      {moving && item && (
        <MoveForm me={me} company={company} locs={locs} itemCode={item.item_code} onClose={() => setMoving(false)}
                  onSaved={() => { setMoving(false); setNotice("已登记，等负责人输入 AutoCount。"); open(item.item_code); }} />
      )}
    </>
  );
}

function Unknown({ code, company, canEdit, onBound }: { code: string; company: string; canEdit: boolean; onBound: (code: string) => void }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<FoundItem[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    if (q.trim().length < 2) { setHits([]); return; }
    const t = setTimeout(() => wh.find(company, q).then(setHits).catch(() => setHits([])), 250);
    return () => clearTimeout(t);
  }, [q, company]);
  return (
    <section className="card warn-card">
      <p>{`找不到「${code}」。`}</p>
      {canEdit && (
        <>
          <p className="muted small">如果这是纸箱上原本的条码，可以绑定到商品，之后扫这个码就会直接找到。</p>
          <input placeholder="找要绑定的商品（代号或品名）" value={q} onChange={(e) => setQ(e.target.value)} />
          <ErrorBox error={error} />
          <ul className="list">
            {hits.map((h) => (
              <li key={h.item_code}>
                <span><b>{h.item_code}</b>{" "}<span className="muted small">{h.description}</span></span>
                <button className="small-btn" onClick={() => wh.bind(company, code, h.item_code).then(() => onBound(code))
                  .catch((e: Error) => setError(e.message))}>绑定</button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function ItemCard({ d, canEdit, onMove, onLabel }: { d: ItemDetail; canEdit: boolean; onMove: () => void; onLabel: () => void }) {
  const total = d.stock.reduce((a, s) => a + Number(s.qty), 0);
  const hasPending = d.stock.some((s) => Number(s.pending) !== 0);
  const showCost = d.stock.some((s) => s.unit_cost != null);
  return (
    <section className="card wh-item">
      <div className="page-head">
        <div>
          <h2>{d.item_code}</h2>
          <p className="muted">{d.description}</p>
          <p className="small muted">{[d.item_group, d.item_type, d.uom].filter(Boolean).join(" · ")}{!d.active && " · 已停用"}</p>
        </div>
        <div className="actions">
          {canEdit && <button onClick={onMove}>登记搬动</button>}
          <button className="ghost" onClick={onLabel}>印条码</button>
        </div>
      </div>
      <div className="table-wrap flat">
        <table>
          <thead><tr><th>仓位</th><th className="num">AutoCount</th>{hasPending && <th className="num">未输入的搬动</th>}{hasPending && <th className="num">应有</th>}{showCost && <th className="num hide-sm">单位成本</th>}</tr></thead>
          <tbody>
            {d.stock.map((s) => (
              <tr key={s.location}>
                <td>{s.location}</td>
                <td className={"num" + (Number(s.qty) < 0 ? " late" : "")}>{qtyLabel(s.qty)}</td>
                {hasPending && <td className="num">{Number(s.pending) ? (Number(s.pending) > 0 ? "+" : "") + qtyLabel(s.pending) : ""}</td>}
                {hasPending && <td className="num"><b>{qtyLabel(Number(s.qty) + Number(s.pending))}</b></td>}
                {showCost && <td className="num hide-sm">{s.unit_cost != null ? Number(s.unit_cost).toFixed(2) : ""}</td>}
              </tr>
            ))}
            <tr className="total"><td>合计</td><td className="num">{qtyLabel(total)}</td>{hasPending && <td />}{hasPending && <td />}{showCost && <td className="hide-sm" />}</tr>
          </tbody>
        </table>
      </div>
      {d.stock.some((s) => Number(s.qty) < 0) && <p className="small late">库存是负数：货从系统认为没有货的仓位出去了，请盘点这个仓位，并检查调仓有没有输入。</p>}
      {d.open_orders.length > 0 && (
        <>
          <h3>{`未出货订单（${d.open_orders.length}）`}</h3>
          <ul className="list">{d.open_orders.map((o) => <li key={o.doc_no}><span>{o.doc_no}{" "}<span className="muted small">{`${o.doc_date} · ${o.customer || ""}`}</span></span><span>{qtyLabel(o.qty)}</span></li>)}</ul>
        </>
      )}
      {d.incoming.length > 0 && (
        <>
          <h3>{`在途 PO（${d.incoming.length}）`}</h3>
          <ul className="list">{d.incoming.map((o) => <li key={o.po_no + o.location}><span>{o.po_no}{" "}<span className="muted small">{`${o.po_date} · ${o.supplier} → ${o.location}`}</span></span><span>{qtyLabel(o.qty)}</span></li>)}</ul>
        </>
      )}
      {d.moves.length > 0 && (
        <>
          <h3>最近搬动</h3>
          <ul className="list">{d.moves.map((m) => <li key={m.id}><span>{moveText(m)}{" "}<span className="muted small">{`${whenLabel(m.created_at)} · ${m.created_by_name}`}</span></span><span className={"ap " + (m.status === "pending" ? "pending" : m.status === "done" ? "approved" : "cancelled")}>{MOVE_STATUS_LABEL[m.status]}</span></li>)}</ul>
        </>
      )}
      {d.counts.length > 0 && (
        <>
          <h3>最近盘点</h3>
          <ul className="list">{d.counts.map((c) => <li key={c.id}><span>{`${c.location} · 数到 ${qtyLabel(c.qty)}`}{c.diff != null && Number(c.diff) !== 0 ? ` · 差 ${Number(c.diff) > 0 ? "+" : ""}${qtyLabel(c.diff)}` : ""}{" "}<span className="muted small">{`${whenLabel(c.counted_at)} · ${c.counted_by_name}`}</span></span><span className={"ap " + countClass(c)}>{COUNT_STATUS_LABEL[c.status]}</span></li>)}</ul>
        </>
      )}
      {d.barcodes.length > 0 && <p className="muted small">{`绑定的纸箱条码：${d.barcodes.join("、")}`}</p>}
    </section>
  );
}

