// 仓库 · 货架 · 对不上 / 未上架：同一个仓位里，货架合计跟应有（AutoCount + 还没输入的搬动）比。
//   货架比系统多 = 货架帐有错（卖出去时没从货架扣、数错）→ 请人去盘点；未上架 = 应有比货架合计多（在地上、刚点完货）→ 去上架。
//   应有已含「DO 待备」（AutoCount 开 DO 就扣，货还在货架上）；还有 DO 没备的列先请人备货，不叫人去盘。
//   网址 ?loc= &f= 由 BinsTab 带进来（initLoc / initFilter）。
import { useEffect, useState } from "react";
import { go } from "../router";
import { Empty, ErrorBox, Modal } from "../ui";
import { qtyLabel, whenLabel } from "../wh-api";
import { bins, ItemBins, ReconFilter, ReconPage, ReconRow } from "../wh-bin-api";
import { rememberLoc } from "./binLoc";

const FILTER_LABEL: [ReconFilter, string][] = [["over", "货架比系统多"], ["unshelved", "未上架"], ["all", "全部"]];

export function BinRecon({ company, binLocs, canEdit, initLoc, initFilter }: {
  company: string; binLocs: string[]; canEdit: boolean;
  /** 网址带进来的仓位 / 筛选（已经检查过） */ initLoc?: string; initFilter?: ReconFilter;
}) {
  const [loc, setLoc] = useState(() => { const l = initLoc || rememberLoc(company); return binLocs.includes(l) ? l : binLocs[0] || ""; });
  const [filter, setFilter] = useState<ReconFilter>(initFilter ?? "over");
  const [qInput, setQInput] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(0);
  const [data, setData] = useState<ReconPage | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<ReconRow | null>(null);

  useEffect(() => {
    if (!loc) return;
    let alive = true;
    setError("");
    bins.recon({ company, location: loc, filter, q, page }).then((d) => alive && setData(d)).catch((e: Error) => alive && setError(e.message));
    return () => { alive = false; };
  }, [company, loc, filter, q, page]);

  if (!binLocs.length) return <Empty>还没有货架。请主管在「货架清单」建货架。</Empty>;
  const c = data?.counts;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.page_size)) : 1;
  return (
    <>
      <div className="filters bin-toolbar">
        <label className="inline">仓位
          <select value={loc} onChange={(e) => { setLoc(e.target.value); rememberLoc(company, e.target.value); setPage(0); setData(null); }}>
            {binLocs.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
        </label>
        <form className="bin-q" onSubmit={(e) => { e.preventDefault(); setQ(qInput.trim()); setPage(0); }}>
          <input type="search" placeholder="找商品代号 / 品名…" value={qInput} onChange={(e) => setQInput(e.target.value)} />
          <button className="ghost">搜寻</button>
        </form>
      </div>
      {c && (
        <div className="kpis bin-kpis">
          <button className={"kpi" + (filter === "over" ? " on" : "") + (c.over ? " warn" : "")} onClick={() => { setFilter("over"); setPage(0); }}>
            <b>{c.over}</b><span>货架比系统多</span><small>请去盘点</small></button>
          <button className={"kpi" + (filter === "unshelved" ? " on" : "")} onClick={() => { setFilter("unshelved"); setPage(0); }}>
            <b className={c.unshelved ? "amber" : ""}>{c.unshelved}</b><span>未上架</span><small>应有比货架多</small></button>
          <button className={"kpi" + (filter === "all" ? " on" : "")} onClick={() => { setFilter("all"); setPage(0); }}>
            <b>{c.shelved}</b><span>已上架的商品</span><small>{`这个仓位有货的 ${c.items} 项`}</small></button>
        </div>
      )}
      <div className="filters bin-seg-row">
        <div className="bin-modes bin-recon-seg" role="group">
          {FILTER_LABEL.map(([k, v]) => <button key={k} type="button" className={k === filter ? "on" : ""} onClick={() => { setFilter(k); setPage(0); }}>{v}</button>)}
        </div>
        {data && <span className="muted small">{`共 ${data.total} 个商品`}</span>}
      </div>
      <ErrorBox error={error} />
      {!data ? (!error && <p className="muted">载入中…</p>) : data.rows.length === 0 ? (
        <Empty>{filter === "over" ? "没有货架比系统多的商品 👍" : filter === "unshelved" ? "没有未上架的商品。" : "没有符合的商品。"}</Empty>
      ) : (
        <div className="table-wrap">
          <table className="bin-recon">
            <thead><tr>
              <th>商品</th><th className="num">AutoCount</th><th className="num hide-sm">待输入</th><th className="num">应有</th>
              <th className="num hide-sm">DO 待备</th><th className="num">货架合计</th><th className="num">差</th><th className="num hide-sm">货架数</th><th />
            </tr></thead>
            <tbody>
              {data.rows.map((r) => {
                const diff = Number(r.shelved) - Number(r.expected);
                const over = Number(r.shelved) > Math.max(Number(r.expected), 0);
                const un = Number(r.expected) > Number(r.shelved);
                const dw = Number(r.do_unpicked ?? 0);
                return (
                  <tr key={r.item_code} className="click" onClick={() => setOpen(r)}>
                    <td><b>{r.item_code}</b><div className="muted small">{r.description}</div></td>
                    <td className="num">{qtyLabel(r.ac_qty)}</td>
                    <td className="num hide-sm">{Number(r.pending) ? (Number(r.pending) > 0 ? "+" : "") + qtyLabel(r.pending) : ""}</td>
                    <td className="num">{qtyLabel(r.expected)}</td>
                    <td className="num hide-sm">{dw > 0 ? qtyLabel(dw) : ""}</td>
                    <td className="num"><b>{qtyLabel(r.shelved)}</b></td>
                    <td className={"num" + (diff > 0 ? " late" : diff < 0 ? " amber" : "")}>{diff > 0 ? `+${qtyLabel(diff)}` : qtyLabel(diff)}</td>
                    <td className="num hide-sm">{r.n_bins}</td>
                    <td className="nowrap">
                      {un && canEdit && (
                        <button className="small" onClick={(e) => { e.stopPropagation(); go(`/warehouse/bins/ops?item=${encodeURIComponent(r.item_code)}&loc=${encodeURIComponent(loc)}&mode=putaway`); }}>上架</button>
                      )}
                      {over && (dw > 0
                        ? <span className="small amber">有 DO 还没备：备完还多再去盘点</span>
                        : <span className="small late">请去盘点这个商品</span>)}
                    </td>
                  </tr>
                );
              })}
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
      <p className="muted small">{"应有 = AutoCount 库存 + 还没输入 AutoCount 的搬动 / 进货 + DO 待备；货架合计 = 这个仓位所有货架加起来；差 = 货架合计 − 应有。"}</p>
      <p className="muted small">{"DO 待备 = 近 7 天已开、还没备的 DO：AutoCount 开 DO 就扣库存，可是货还在货架上，所以加回应有。"}</p>
      <p className="muted small">{"货架比系统多：多半是卖出去或拿货时没有从货架扣，请盘点这个商品（盘点会把货架改成实际数）。"}</p>
      {data?.synced_at && <p className="muted small">{`AutoCount 库存同步：${whenLabel(data.synced_at)}`}</p>}
      {open && <Spread company={company} loc={loc} row={open} canEdit={canEdit} onClose={() => setOpen(null)} />}
    </>
  );
}

/** 点一列：这个商品在这个仓位各货架的数量（也列出其他仓位） */
function Spread({ company, loc, row, canEdit, onClose }: { company: string; loc: string; row: ReconRow; canEdit: boolean; onClose: () => void }) {
  const [d, setD] = useState<ItemBins | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { bins.item(company, row.item_code).then(setD).catch((e: Error) => setError(e.message)); }, [company, row.item_code]);
  const here = d?.locations.find((l) => l.location === loc);
  const elsewhere = d?.locations.filter((l) => l.location !== loc && (l.bins.length > 0 || Number(l.expected) !== 0)) ?? [];
  return (
    <Modal title={row.item_code} onClose={onClose}>
      <p className="muted">{row.description}</p>
      <ErrorBox error={error} />
      {!d ? (!error && <p className="muted">载入中…</p>) : (
        <>
          <div className={"bin-stats" + (Number(here?.do_unpicked ?? 0) > 0 ? " four" : "")}>
            <div><span>应有</span><b>{qtyLabel(here?.expected ?? 0)}</b></div>
            <div><span>货架合计</span><b>{qtyLabel(here?.shelved ?? 0)}</b></div>
            <div><span>未上架</span><b>{qtyLabel(Math.max(0, Number(here?.unshelved ?? 0)))}</b></div>
            {Number(here?.do_unpicked ?? 0) > 0 && <div><span>DO 待备</span><b>{qtyLabel(here?.do_unpicked ?? 0)}</b></div>}
          </div>
          <h3>{loc}</h3>
          {!here || here.bins.length === 0 ? <p className="muted">这个仓位没有货架放这个商品。</p> : (
            <ul className="list">
              {here.bins.map((b) => (
                <li key={b.id}><span><b>{b.code}</b>{!b.active && <span className="muted small">{" "}<span>已停用</span></span>}</span>
                  <span>{Number(b.qty) > 0 ? qtyLabel(b.qty) : <span className="muted small">平常放这里</span>}</span></li>
              ))}
            </ul>
          )}
          {elsewhere.length > 0 && (
            <>
              <h3>其他仓位</h3>
              <ul className="list">
                {elsewhere.map((l) => (
                  <li key={l.location}><span><b>{l.location}</b>{" "}<span className="muted small">{l.bins.filter((b) => Number(b.qty) > 0).map((b) => `${b.code} × ${qtyLabel(b.qty)}`).join("、")}</span></span>
                    <span className="muted small nowrap">{`应有 ${qtyLabel(l.expected)} · 货架合计 ${qtyLabel(l.shelved)}`}</span></li>
                ))}
              </ul>
            </>
          )}
          {d.log.length > 0 && (
            <>
              <h3>最近货架变动</h3>
              <ul className="list bin-log">
                {d.log.slice(0, 8).map((g) => (
                  <li key={g.id} className={g.reversed ? "undone" : ""}>
                    <span><span>{g.bin}</span>{" "}<span className={Number(g.delta) < 0 ? "late" : "bin-plus"}>{Number(g.delta) > 0 ? `+${qtyLabel(g.delta)}` : qtyLabel(g.delta)}</span>
                      {g.note && <span className="muted small">{" · "}<span>{g.note}</span></span>}</span>
                    <span className="muted small nowrap">{`${whenLabel(g.created_at)}${g.by_name ? ` · ${g.by_name}` : ""}`}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          <div className="actions">
            {canEdit && <button className="ghost" onClick={() => go(`/warehouse/bins/ops?item=${encodeURIComponent(row.item_code)}&loc=${encodeURIComponent(loc)}`)}>上架 / 拿下</button>}
            <button className="ghost" onClick={onClose}>关闭</button>
          </div>
        </>
      )}
    </Modal>
  );
}
