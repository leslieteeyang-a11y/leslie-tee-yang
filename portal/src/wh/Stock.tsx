// 仓库 · 库存总表（从 BI 的库存页搬进来，2026-10-16）：商品 × 仓位的现存量、售价；成本只给仓库「可审批」。
import { useEffect, useState } from "react";
import { fmtQty, fmtRM } from "../api";
import { Empty, ErrorBox } from "../ui";
import { rpl, StockPage, StockRow } from "../rpl-api";
import "../rpl.css";

export function StockTab({ company }: { company: string }) {
  const [qInput, setQInput] = useState("");
  const [q, setQ] = useState("");
  const [negOnly, setNegOnly] = useState(false);
  const [page, setPage] = useState(0);
  const [data, setData] = useState<StockPage | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    setData(null); setError("");
    rpl.stock({ company, q, neg_only: negOnly, page }).then((d) => alive && setData(d)).catch((e: Error) => alive && setError(e.message));
    return () => { alive = false; };
  }, [company, q, negOnly, page]);
  const pages = data ? Math.max(1, Math.ceil(data.total / data.page_size)) : 1;
  // 同一商品的几个仓位放在一起，第一行印商品与合计
  const grouped: { locs: StockRow[]; total: number }[] = [];
  if (data) {
    const m = new Map<string, StockRow[]>();
    for (const r of data.rows) { const l = m.get(r.item_code) ?? []; l.push(r); m.set(r.item_code, l); }
    for (const locs of m.values()) grouped.push({ locs, total: locs.reduce((s, r) => s + Number(r.qty), 0) });
  }
  return (
    <>
      <form className="rpl-filters" onSubmit={(e) => { e.preventDefault(); setQ(qInput.trim()); setPage(0); }}>
        <input className="search" type="search" placeholder="搜商品代号 / 品名 / 型号…" value={qInput} onChange={(e) => setQInput(e.target.value)} />
        <button className="small">搜寻</button>
        <label className="check"><input type="checkbox" checked={negOnly} onChange={(e) => { setNegOnly(e.target.checked); setPage(0); }} /> {`只看负库存（${data?.neg_total ?? "…"} 行）`}</label>
        {data && <span className="muted small">{`${data.total} 行（商品 × 仓位）`}</span>}
      </form>
      <ErrorBox error={error} />
      {!data ? (!error && <p className="muted">载入中…</p>) : data.rows.length === 0 ? <Empty>没有符合的商品。</Empty> : (
        <div className="table-wrap">
          <table>
            <thead><tr>
              <th>商品</th><th className="hide-sm">类别</th><th>仓位</th><th className="num">现存量</th><th className="num">商品合计</th>
              <th className="num hide-sm">门市价 P2</th><th className="num hide-sm">P3</th><th className="num hide-sm">P4</th>{data.show_cost && <th className="num">成本值</th>}
            </tr></thead>
            <tbody>
              {grouped.map((g) => g.locs.map((r, i) => (
                <tr key={r.item_code + "|" + r.location}>
                  <td>{i === 0 && <><b>{r.item_code}</b><div className="small">{r.description}</div></>}</td>
                  <td className="hide-sm">{i === 0 ? r.item_group ?? "" : ""}</td>
                  <td>{r.location || "（默认）"}</td>
                  <td className={"num" + (Number(r.qty) < 0 ? " rpl-neg" : "")}>{fmtQty(r.qty)}{r.uom ? ` ${r.uom}` : ""}</td>
                  <td className="num"><b>{i === 0 ? fmtQty(g.total) : ""}</b></td>
                  <td className="num hide-sm">{i === 0 && r.price2 ? fmtRM(r.price2) : ""}</td>
                  <td className="num hide-sm muted">{i === 0 && r.price3 ? fmtRM(r.price3) : ""}</td>
                  <td className="num hide-sm muted">{i === 0 && r.price4 ? fmtRM(r.price4) : ""}</td>
                  {data.show_cost && <td className="num">{fmtRM(r.total_cost)}</td>}
                </tr>
              )))}
            </tbody>
          </table>
        </div>
      )}
      {data && (
        <div className="pager">
          <button className="small ghost" disabled={page === 0} onClick={() => setPage(page - 1)}>上一页</button>
          <span className="muted small">{`${page + 1} / ${pages}`}</span>
          <button className="small ghost" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>下一页</button>
        </div>
      )}
      <p className="rpl-foot">现存量按 AutoCount 库存流水汇总，随每日同步更新{data?.synced_at ? `（最近同步 ${data.synced_at.slice(0, 16).replace("T", " ")}）` : ""}；红色负数 = 负库存，请到「查货」盘点那个仓位，并检查调仓有没有输入。
        {data?.show_cost && "成本值为流水成本净额估算。"}</p>
    </>
  );
}
