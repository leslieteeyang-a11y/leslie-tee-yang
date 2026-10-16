// 仓库 · 盘点统计（可审批；#/warehouse/count/stats）：近 30 / 90 / 180 天盘了几次、相符率、差异项数与金额（成本，只给老板）、
// 常常不准的商品前 20、每个人、每月差异金额。只算最后定案的盘点（再数、请重盘作废的不算）。
import { useEffect, useState } from "react";
import { Empty, ErrorBox, Tabs } from "../ui";
import { qtyLabel } from "../wh-api";
import { CountStats as Stats, rm, sheets } from "../wh-sheet-api";
import "../wh-sheet.css";

const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 1000) / 10}%` : "—");
const signed = (n: number) => `${Number(n) > 0 ? "+" : ""}${qtyLabel(n)}`;

export default function CountStats({ company, locs }: { company: string; locs: string[] }) {
  const [days, setDays] = useState<"30" | "90" | "180">("30");
  const [loc, setLoc] = useState("");
  const [s, setS] = useState<Stats | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    setS(null); setError("");
    sheets.stats(company, Number(days) as 30 | 90 | 180, loc).then(setS).catch((e: Error) => setError(e.message));
  }, [company, days, loc]);

  const sm = s?.summary;
  // 差异金额（成本）只给老板（资料库 show_cost）；其他人每月长条改用差异项数
  const cost = !!s?.show_cost;
  const barOf = (m: Stats["months"][number]) => Number(cost ? m.value_abs : m.variance);
  const maxMonth = Math.max(1, ...(s?.months || []).map(barOf));
  return (
    <>
      <div className="filters ws-bar">
        <Tabs value={days} onChange={setDays} options={[["30", "近 30 天"], ["90", "近 90 天"], ["180", "近 180 天"]]} />
        <label className="inline ws-fixed">仓位
          <select value={loc} onChange={(e) => setLoc(e.target.value)}>
            <option value="">全部仓位</option>
            {locs.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
        </label>
      </div>
      <ErrorBox error={error} />
      {!s || !sm ? (!error && <p className="muted">载入中…</p>) : (
        <div className="ws-stats">
          <div className="kpis">
            <div className="kpi"><b>{sm.counts}</b><span>盘了几次</span><small className="muted">{`${sm.items} 个商品 × 仓位`}</small></div>
            <div className="kpi"><b>{pct(sm.match, sm.counts)}</b><span>相符率</span><small className="muted">{`相符 ${sm.match} 次`}</small></div>
            <div className={"kpi" + (sm.variance ? " warn" : "")}><b>{sm.variance}</b><span>差异几项</span>
              <small className="muted">{`待审核 ${sm.waiting} · 已调整 ${sm.adjusted} · 不调整 ${sm.ignored}`}</small></div>
            {cost && (
              <div className={"kpi" + (Number(sm.value_net) < 0 ? " warn" : "")}><b className="ws-money">{rm(sm.value_net)}</b><span>差异金额（成本，净额）</span>
                <small className="muted">{`多的少的加起来 ${rm(sm.value_abs)}`}</small></div>
            )}
          </div>
          {sm.counts === 0 ? <Empty>这段时间没有盘点纪录。</Empty> : (
            <>
              <h2 className="section-title">常常不准的商品（前 20）</h2>
              {s.top.length === 0 ? <Empty>这段时间没有差异。</Empty> : (
                <div className="table-wrap">
                  <table className="ws-table">
                    <thead><tr><th>商品</th><th className="num">差异次数</th><th className="num">差异件数合计</th>{cost && <th className="num">差异金额</th>}<th className="hide-sm">最近</th></tr></thead>
                    <tbody>
                      {s.top.map((t) => (
                        <tr key={t.item_code}>
                          <td><b>{t.item_code}</b><div className="muted small">{t.description}</div></td>
                          <td className="num">{t.times}</td>
                          <td className="num"><span className={Number(t.units) < 0 ? "late" : ""}>{signed(t.units)}</span>
                            {Number(t.abs_units) !== Math.abs(Number(t.units)) && <div className="muted small">{`多的少的加起来 ${qtyLabel(t.abs_units)}`}</div>}</td>
                          {cost && <td className="num">{rm(t.value)}</td>}
                          <td className="hide-sm small">{t.last}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <h2 className="section-title">每个人</h2>
              <div className="table-wrap">
                <table className="ws-table">
                  <thead><tr><th>盘点人</th><th className="num">盘了几项</th><th className="num">差异</th><th className="num">差异率</th>{cost && <th className="num hide-sm">差异金额</th>}</tr></thead>
                  <tbody>
                    {s.people.map((p) => (
                      <tr key={p.id}>
                        <td>{p.name}</td><td className="num">{p.counts}</td><td className="num">{p.variance}</td>
                        <td className={"num" + (p.variance ? " late" : "")}>{pct(p.variance, p.counts)}</td>
                        {cost && <td className="num hide-sm">{rm(p.value_abs)}</td>}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          <h2 className="section-title">{cost ? "每月差异金额（近 12 个月）" : "每月差异（近 12 个月）"}</h2>
          {s.months.length === 0 ? <Empty>没有纪录。</Empty> : (
            <div className="table-wrap">
              <table className="ws-table ws-months">
                <thead><tr><th>月份</th><th className="num hide-sm">盘了几次</th>{cost && <th className="num">差异</th>}{cost && <th className="num">净额</th>}<th className="ws-barcol">{cost ? "多的少的加起来" : "差异"}</th></tr></thead>
                <tbody>
                  {s.months.map((m) => (
                    <tr key={m.month}>
                      <td className="nowrap">{m.month}</td><td className="num hide-sm">{m.counts}</td>{cost && <td className="num">{m.variance}</td>}
                      {cost && <td className={"num" + (Number(m.value_net) < 0 ? " late" : "")}>{rm(m.value_net)}</td>}
                      <td className="ws-barcol"><div className="ws-mbar"><span style={{ width: `${(barOf(m) / maxMonth) * 100}%` }} /></div>
                        <span className="small nowrap">{cost ? rm(m.value_abs) : m.variance}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="muted small">{cost
            ? "差额 = 实盘 − 应有（应有 = AutoCount 库存 + 还没输入 AutoCount 的搬动）；金额用盘点当下的单位成本算，负数 = 少了。要再数、主管按「请重盘」的那次不算。"
            : "差额 = 实盘 − 应有（应有 = AutoCount 库存 + 还没输入 AutoCount 的搬动）。要再数、主管按「请重盘」的那次不算。"}</p>
        </div>
      )}
    </>
  );
}
