// 仓库 · 总览（2026-10-15，照员工 WMS 的仪表盘）：负库存、待输入 AutoCount 的搬动、待开进货单、快到的厂家货、今天盘点、
// 差异待审、货架帐（对不上 / 未上架）、各仓位库存、最近动态。点卡片到对应的分页（没有权限开的就不做成连结）。
import { useEffect, useState } from "react";
import { fmtQty, fmtRM } from "../api";
import { Empty, ErrorBox } from "../ui";
import { COUNT_STATUS_LABEL, CountStatus, MOVE_KIND_SHORT, MoveKind, qtyLabel, whenLabel } from "../wh-api";
import { BIN_LOG_LABEL, BinLogKind } from "../wh-bin-api";
import { overview, Overview, OverviewRecent } from "../wh-overview-api";
import "../rpl.css";

function recentText(r: OverviewRecent): string {
  if (r.type === "move") {
    const route = r.from_loc && r.to_loc ? `${r.from_loc} → ${r.to_loc}` : r.from_loc ? `${r.from_loc} →` : `→ ${r.to_loc ?? ""}`;
    return `${MOVE_KIND_SHORT[r.kind as MoveKind] ?? r.kind} ${qtyLabel(r.qty)} · ${route}`;
  }
  if (r.type === "bin") {
    const q = Number(r.qty ?? 0);
    return `${BIN_LOG_LABEL[r.kind as BinLogKind] ?? r.kind} ${q > 0 ? "+" : ""}${qtyLabel(q)} · ${r.bin ?? ""}`;
  }
  return `盘点${COUNT_STATUS_LABEL[r.kind as CountStatus] ?? r.kind} · ${r.location ?? ""}`;
}

/** 货架帐对不上清单：带仓位与筛选 */
const reconHref = (loc: string | undefined, f: "over" | "unshelved") =>
  `#/warehouse/bins/recon?${loc ? `loc=${encodeURIComponent(loc)}&` : ""}f=${f}`;

export function OverviewTab({ company, canEdit, canApprove, canGrn, canReceive, canTransit }: {
  company: string; canEdit: boolean; canApprove: boolean; canGrn: boolean;
  /** 能点货（#/purchasing/receive） */ canReceive: boolean;
  /** 订货至少只看（#/purchasing/transit） */ canTransit: boolean;
}) {
  const [d, setD] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    setD(null); setError("");
    overview(company).then((x) => alive && setD(x)).catch((e: Error) => alive && setError(e.message));
    return () => { alive = false; };
  }, [company]);
  if (!d) return error ? <ErrorBox error={error} /> : <p className="muted">载入中…</p>;

  const over = d.bins.reduce((s, b) => s + b.items_over, 0);
  const unshelved = d.bins.reduce((s, b) => s + b.items_unshelved, 0);
  const ct = d.count_today;
  // KPI 是所有仓位加起来；点进去开第一个有数字的仓位
  const overLoc = d.bins.find((b) => b.items_over > 0)?.location;
  const unLoc = d.bins.find((b) => b.items_unshelved > 0)?.location;
  // 厂家货：能点货 → 点货；订货只看 → 在路上；没有订货模块 → 不连（订货页整页要订货「只看」，仓库可编辑但没订货的人开不了点货）
  const transitHref = !canTransit ? "" : canReceive ? "#/purchasing/receive" : "#/purchasing/transit";
  const transitBody = <><b>{d.do_to_count}</b><span>三天内到 / 待点货的厂家货</span></>;
  return (
    <>
      <p className="muted small">{`AutoCount 库存最近同步 ${d.synced_at ? whenLabel(d.synced_at) : "—"}（每天 09 / 12 / 15 / 18 点）`}</p>
      <div className="kpis">
        <a className={"kpi" + (d.neg_rows ? " warn" : "")} href="#/warehouse/stock/neg"><b>{d.neg_rows}</b><span>库存是负数（商品 × 仓位）</span></a>
        <a className={"kpi" + (d.moves_pending ? " warn" : "")} href="#/warehouse/moves"><b>{d.moves_pending}</b><span>搬动待输入 AutoCount</span></a>
        {canGrn && (
          <a className={"kpi" + (d.grn_pending ? " warn" : "")} href="#/warehouse/grn"><b>{d.grn_pending_do}</b><span>厂家到货待开进货单</span></a>
        )}
        <a className={"kpi" + (d.picks.today > d.picks.today_done ? " warn" : "")} href="#/warehouse/pick/today"><b>{`${d.picks.today_done} / ${d.picks.today}`}</b><span>{d.picks.picking ? `今天 / 明天的 DO 已备好（${d.picks.picking} 张备到一半）` : "今天 / 明天的 DO 已备好"}</span></a>
        {transitHref
          ? <a className={"kpi" + (d.do_to_count ? " warn" : "")} href={transitHref}>{transitBody}</a>
          : <div className={"kpi" + (d.do_to_count ? " warn" : "")}>{transitBody}</div>}
        {canEdit && (
          <a className="kpi" href="#/warehouse/count"><b>{`${ct.counted} / ${ct.target}`}</b><span>{`今天盘点（${ct.people} 人）`}</span></a>
        )}
        {canApprove && (
          <a className={"kpi" + (d.variances ? " warn" : "")} href="#/warehouse/review"><b>{d.variances}</b><span>盘点差异待审核</span></a>
        )}
        {d.bins.length > 0 && (
          <>
            <a className={"kpi" + (over ? " warn" : "")} href={reconHref(overLoc, "over")}><b>{over}</b><span>货架比系统多（要去数）</span></a>
            <a className="kpi" href={reconHref(unLoc, "unshelved")}><b>{unshelved}</b><span>还没上架的商品</span></a>
          </>
        )}
      </div>

      {d.sheets.length > 0 && (
        <section className="card">
          <h2>开着的盘点单</h2>
          <ul className="list">
            {d.sheets.map((sh) => (
              <li key={sh.id}>
                {/* 盘点分页只给可编辑以上：只看的人显示文字 */}
                {canEdit ? <a href={`#/warehouse/count/${sh.id}`}><b>{sh.title}</b></a> : <b>{sh.title}</b>}
                <span className="muted small">{` · ${sh.location}${sh.due_date ? ` · 期限 ${sh.due_date}` : ""}`}</span>
                {sh.overdue && <span className="small rpl-neg">{" 已过期限"}</span>}
                <div className="small">{`已盘 ${sh.done} / ${sh.total}${sh.recount ? `，要再数 ${sh.recount}` : ""}`}</div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {d.bins.length > 0 && (
        <section className="card">
          <h2>货架</h2>
          <div className="table-wrap">
            <table>
              <thead><tr><th>仓位</th><th className="num">货架</th><th className="num">已上架商品</th><th className="num">对不上</th><th className="num">未上架</th></tr></thead>
              <tbody>
                {d.bins.map((b) => (
                  <tr key={b.location}>
                    <td><a href={`#/warehouse/bins/list`}>{b.location}</a></td>
                    <td className="num">{b.bins}</td>
                    <td className="num">{b.items_shelved}</td>
                    <td className={"num" + (b.items_over ? " rpl-neg" : "")}>
                      {b.items_over ? <a href={reconHref(b.location, "over")}>{b.items_over}</a> : b.items_over}</td>
                    <td className="num">{b.items_unshelved ? <a href={reconHref(b.location, "unshelved")}>{b.items_unshelved}</a> : b.items_unshelved}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="card">
        <h2>各仓位库存（AutoCount）</h2>
        {d.locations.length === 0 ? <Empty>AutoCount 还没有这间分店的库存资料（JB 的电脑要跑同步）。</Empty> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>仓位</th><th className="num">几种货</th><th className="num">件数</th><th className="num">负数</th>{d.show_cost && <th className="num">成本值</th>}</tr></thead>
              <tbody>
                {d.locations.map((l) => (
                  <tr key={l.location}>
                    <td>{l.location}</td>
                    <td className="num">{l.items}</td>
                    <td className="num">{fmtQty(l.qty)}</td>
                    <td className={"num" + (l.neg ? " rpl-neg" : " muted")}>{l.neg}</td>
                    {d.show_cost && <td className="num">{fmtRM(l.value ?? 0)}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <h2>最近动态</h2>
        {d.recent.length === 0 ? <p className="muted">还没有纪录。</p> : (
          <ul className="list wh-recent">
            {d.recent.map((r, i) => (
              <li key={i}>
                <span className="muted small">{`${whenLabel(r.at)} · ${r.by_name ?? ""}`}</span>
                <div><b>{r.item_code}</b> <span className="small">{d.names[r.item_code] ?? ""}</span></div>
                <div className="small">{recentText(r)}</div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
