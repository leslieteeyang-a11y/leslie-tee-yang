// 仓库 · 滞销品（从 BI 的滞销品页搬进来，2026-10-16）：最后一次进货超过 3 / 6 个月、目前仍有现存量的商品；成本只给仓库「可审批」。
// 与「旧货」分页的差别：旧货看 12 个月（入货 > 12 个月 / 12 个月没卖）并记处理方式；这里看 3–6 个月的预警区。
import { useEffect, useState } from "react";
import { fmtQty, fmtRM } from "../api";
import { Empty, ErrorBox } from "../ui";
import { rpl, SlowPage } from "../rpl-api";
import "../rpl.css";

function AgingTable({ company, title, minMonths, maxMonths, hint }: { company: string; title: string; minMonths: number; maxMonths?: number; hint: string }) {
  const [page, setPage] = useState(0);
  const [data, setData] = useState<SlowPage | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    setData(null); setError("");
    rpl.slow({ company, min_months: minMonths, max_months: maxMonths, page }).then((d) => alive && setData(d)).catch((e: Error) => alive && setError(e.message));
    return () => { alive = false; };
  }, [company, minMonths, maxMonths, page]);
  const pages = data ? Math.max(1, Math.ceil(data.total / data.page_size)) : 1;
  return (
    <div className="card rpl-group">
      <h3>{title} {data && <span className="muted small">{`· ${data.total} 个商品`}</span>}</h3>
      <ErrorBox error={error} />
      {!data ? (!error && <p className="muted">载入中…</p>) : data.rows.length === 0 ? <Empty>没有符合条件的商品 🎉</Empty> : (
        <div className="table-wrap">
          <table>
            <thead><tr>
              <th>商品</th><th className="hide-sm">类别</th><th>最后进货</th><th className="num">距今（月）</th><th className="num">现存量</th>
              {data.show_cost && <th className="num">库存成本值</th>}<th className="num">进货后已售</th>
            </tr></thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.item_code}>
                  <td><b>{r.item_code}</b><div className="small">{r.description}</div></td>
                  <td className="hide-sm">{r.item_group ?? ""}</td>
                  <td className="nowrap">{r.last_receipt_date}</td>
                  <td className="num"><b>{r.months_since}</b></td>
                  <td className="num">{fmtQty(r.on_hand)}</td>
                  {data.show_cost && <td className="num">{fmtRM(r.stock_value)}</td>}
                  <td className="num">{Number(r.sold_since) === 0 ? <span className="urg out">零动销</span> : fmtQty(r.sold_since)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && pages > 1 && (
        <div className="pager">
          <button className="small ghost" disabled={page === 0} onClick={() => setPage(page - 1)}>上一页</button>
          <span className="muted small">{`${page + 1} / ${pages}`}</span>
          <button className="small ghost" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>下一页</button>
        </div>
      )}
      <p className="rpl-foot">{hint}</p>
    </div>
  );
}

export function SlowTab({ company }: { company: string }) {
  return (
    <>
      <p className="muted small">口径：距最后一次进货（收货单 GR / 采购发票 PI / 期初 OB，不含仓库调拨）已超过 3 / 6 个月，且目前仍有现存量的商品；「进货后已售」= 最后进货日之后的销售出库量，零动销 = 进货后一件都没卖出。按库存成本（看不到成本的按现存量）从高到低排列。</p>
      <AgingTable company={company} title="超过 6 个月还没售完" minMonths={6} hint="压钱最久的库存——优先考虑促销 / 清仓 / 退供应商。" />
      <AgingTable company={company} title="超过 3 个月（3–6 个月）还没售完" minMonths={3} maxMonths={6} hint="进入预警区——观察动销，必要时调价。" />
    </>
  );
}
