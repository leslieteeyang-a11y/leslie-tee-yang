// 查货卡片的补充（2026-10-15）：各分店合计（总部自己的、寄存在总部还没送分店、还欠分店）、AutoCount 最近卖出 / 进货。
// 可收合；打开过一次之后记住（这台机器），下次查货自动打开。不给金额；厂家与 PO 号只给看得到厂家的人（资料库处理）。
import { useEffect, useState } from "react";
import { ErrorBox } from "../ui";
import { qtyLabel } from "../wh-api";
import { ItemMore as Data, SALE_DOC_LABEL, whx } from "../wh-extra-api";
import "../wh-extra.css";

const KEY = "hw-wh-more-open";

export function ItemMore({ company, item }: { company: string; item: string }) {
  const [open, setOpen] = useState(() => { try { return localStorage.getItem(KEY) === "1"; } catch { return false; } });
  const [d, setD] = useState<Data | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { setD(null); setError(""); }, [company, item]);
  useEffect(() => {
    if (!open || d || error) return;
    let alive = true;
    whx.itemMore(company, item).then((x) => alive && setD(x)).catch((e: Error) => alive && setError(e.message));
    return () => { alive = false; };
  }, [open, d, error, company, item]);
  const toggle = (v: boolean) => {
    setOpen(v);
    try { localStorage.setItem(KEY, v ? "1" : "0"); } catch { /* 记不住就算了 */ }
  };

  return (
    <details className="wh-more" open={open} onToggle={(e) => toggle((e.currentTarget as HTMLDetailsElement).open)}>
      <summary>各分店合计 · AutoCount 最近卖出 / 进货</summary>
      <ErrorBox error={error} />
      {open && !d && !error && <p className="muted small">载入中…</p>}
      {d && (
        <>
          <h3>各分店（AutoCount 库存）</h3>
          {d.outlets.length === 0 ? <p className="muted small">AutoCount 没有这个商品的库存纪录。</p> : (
            <div className="table-wrap flat">
              <table className="wh-outlets">
                <thead><tr><th>分店</th><th className="num">自己的</th><th className="num">寄存在总部</th><th className="num">还欠</th></tr></thead>
                <tbody>
                  {d.outlets.map((o) => (
                    <tr key={o.code}>
                      <td><b>{o.short_name || o.name}</b>
                        <div className="muted small">{o.locations.map((l) => `${l.location} ${qtyLabel(l.qty)}`).join(" · ")}</div></td>
                      <td className={"num" + (Number(o.total) < 0 ? " late" : "")}>{o.mode === "own" ? <b>{qtyLabel(o.total)}</b> : <span className="muted">—</span>}</td>
                      <td className="num">{o.mode === "consign" ? (Number(o.consigned) > 0 ? <b>{qtyLabel(o.consigned)}</b> : "0") : <span className="muted">—</span>}</td>
                      <td className={"num" + (Number(o.owed) > 0 ? " amber" : "")}>{o.mode === "consign" ? qtyLabel(o.owed) : <span className="muted">—</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {d.outlets.some((o) => o.mode === "consign") && (
            <p className="muted small">寄存在总部 = 分店的货已经到总部、还没送去（分店仓位 + PRE 仓位）；还欠 = 分店订了、还没到总部（PRE 仓位的负数）。</p>
          )}

          <h3>{`AutoCount 最近卖出（${d.sales.length}）`}</h3>
          {d.sales.length === 0 ? <p className="muted small">没有销售纪录。</p> : (
            <ul className="list wh-more-list">
              {d.sales.map((s) => (
                <li key={s.doc_type + s.doc_no}>
                  <span>{`${s.doc_date ?? ""} · ${s.doc_no}`}
                    <span className={"tag" + (s.doc_type === "CN" ? " warn" : "")}>{SALE_DOC_LABEL[s.doc_type] || s.doc_type}</span>
                    {s.customer && <div className="muted small">{s.customer}</div>}</span>
                  <span className={"nowrap" + (Number(s.qty) < 0 ? " late" : "")}>{qtyLabel(s.qty)}{" "}<span className="muted small">{s.uom || ""}</span></span>
                </li>
              ))}
            </ul>
          )}

          <h3>{`AutoCount 最近进货（${d.receipts.length}）`}</h3>
          {d.receipts.length === 0 ? <p className="muted small">没有进货纪录。</p> : (
            <ul className="list wh-more-list">
              {d.receipts.map((r, i) => (
                <li key={r.doc_no + (r.location || "") + i}>
                  <span>{`${r.rcv_date ?? ""} · ${r.doc_no}`}{r.location && <span className="muted small">{` → ${r.location}`}</span>}
                    {(r.po_no || r.supplier) && <div className="muted small">{[r.po_no && `PO ${r.po_no}`, r.supplier].filter(Boolean).join(" · ")}</div>}</span>
                  <span className="nowrap">{qtyLabel(r.qty)}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="muted small">AutoCount 每天同步的数字；只列数量，不列金额。</p>
        </>
      )}
    </details>
  );
}
