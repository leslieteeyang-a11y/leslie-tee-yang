// 仓库 · 库存总表（从 BI 的库存页搬进来，2026-10-16）：商品 × 仓位的现存量、售价；成本只给仓库「可审批」。
// 2026-10-15 加：商品标签（自动的畅销 / 滞销 + 手动的清货等）与标签筛选、下载 Excel（同样筛选、全部列，最多 50,000 列）。
import { useEffect, useState } from "react";
import { fmtQty, fmtRM } from "../api";
import { Empty, ErrorBox, Modal } from "../ui";
import { StockRow } from "../rpl-api";
import { StockExport, StockTagPage, StockTagRow, ui, whTag } from "../wh-tag-api";
import { ItemTags, TagChips, TagManager, useTagList } from "./ItemTags";
import "../rpl.css";
import "../wh-tag.css";

export function StockTab({ company }: { company: string }) {
  const [qInput, setQInput] = useState("");
  const [q, setQ] = useState("");
  const [negOnly, setNegOnly] = useState(false);
  const [tag, setTag] = useState("");
  const [page, setPage] = useState(0);
  const [data, setData] = useState<StockTagPage | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [tagList, reloadTags] = useTagList(company);
  const [manage, setManage] = useState(false);
  const [editItem, setEditItem] = useState<StockTagRow | null>(null);
  const [rev, setRev] = useState(0);
  useEffect(() => {
    let alive = true;
    setData(null); setError("");
    whTag.stock({ company, q, neg_only: negOnly, tag, page }).then((d) => alive && setData(d)).catch((e: Error) => alive && setError(e.message));
    return () => { alive = false; };
  }, [company, q, negOnly, tag, page, rev]);
  const pages = data ? Math.max(1, Math.ceil(data.total / data.page_size)) : 1;
  // 同一商品的几个仓位放在一起，第一行印商品与合计
  const grouped: { locs: StockTagRow[]; total: number }[] = [];
  if (data) {
    const m = new Map<string, StockTagRow[]>();
    for (const r of data.rows) { const l = m.get(r.item_code) ?? []; l.push(r); m.set(r.item_code, l); }
    // 商品合计 = 资料库算的全部仓位合计（不受负库存筛选、分页影响）；旧版资料库没有 item_total 时退回本页加总
    for (const locs of m.values()) grouped.push({ locs, total: locs[0].item_total != null ? Number(locs[0].item_total) : locs.reduce((s, r) => s + Number(r.qty), 0) });
  }
  const activeTags = (tagList?.tags ?? []).filter((t) => t.active);
  const canTag = !!tagList?.can_edit;

  async function download() {
    setBusy(true); setError("");
    try { await exportXlsx(await whTag.stockExport({ company, q, neg_only: negOnly, tag })); }
    catch (e) { setError((e as Error).message); }
    setBusy(false);
  }

  return (
    <>
      <form className="rpl-filters" onSubmit={(e) => { e.preventDefault(); setQ(qInput.trim()); setPage(0); }}>
        <input className="search" type="search" placeholder="搜商品代号 / 品名 / 型号…" value={qInput} onChange={(e) => setQInput(e.target.value)} />
        <button className="small">搜寻</button>
        <select value={tag} aria-label="标签" onChange={(e) => { setTag(e.target.value); setPage(0); }}>
          <option value="">全部标签</option>
          {activeTags.map((t) => <option key={t.name} value={t.name}>{`${t.name}（${t.items}）`}</option>)}
        </select>
        <label className="check"><input type="checkbox" checked={negOnly} onChange={(e) => { setNegOnly(e.target.checked); setPage(0); }} /> {`只看负库存（${data?.neg_total ?? "…"} 行）`}</label>
        {data && <span className="muted small">{`${data.total} 行（商品 × 仓位）`}</span>}
        <span className="wht-spacer" />
        <button type="button" className="small ghost" disabled={busy || !data?.total} onClick={download}>{busy ? "准备中…" : "⬇ 下载 Excel"}</button>
        {canTag && <button type="button" className="small ghost" onClick={() => setManage(true)}>管理标签</button>}
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
                  <td>{i === 0 && <>
                    <b>{r.item_code}</b>
                    <div className="small">{r.description}</div>
                    <div className="wht-row-tags">
                      <TagChips tags={r.tags} list={tagList} />
                      {canTag && <button type="button" className="wht-edit" onClick={() => setEditItem(r)} title="改标签" aria-label="改标签">🏷</button>}
                    </div>
                  </>}</td>
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
      <p className="rpl-foot">{`现存量按 AutoCount 库存流水汇总，随每日同步更新${data?.synced_at ? `（最近同步 ${data.synced_at.slice(0, 16).replace("T", " ")}）` : ""}；红色负数 = 负库存，请到「查货」盘点那个仓位，并检查调仓有没有输入。${data?.show_cost ? "成本值为流水成本净额估算。" : ""}`}</p>
      <p className="rpl-foot">标签：「畅销」= 近 90 天销量在这间分店前 5% 而且至少 10 件；「滞销」= 最后进货满 6 个月还有库存（与「滞销品」同一条规则），都是系统自动标的。其他标签由采购或仓库主管手动标。</p>
      {manage && <TagManager company={company} onClose={() => setManage(false)} onChanged={() => { reloadTags(); setRev((x) => x + 1); }} />}
      {editItem && (
        <Modal title={editItem.item_code} onClose={() => { setEditItem(null); reloadTags(); setRev((x) => x + 1); }}>
          <p className="small">{editItem.description}</p>
          <ItemTags company={company} itemCode={editItem.item_code} />
        </Modal>
      )}
    </>
  );
}

/** 下载 Excel（SheetJS 动态载入，只有按下载才下载） */
async function exportXlsx(d: StockExport): Promise<void> {
  const XLSX = await import("@e965/xlsx");
  const head = ["商品代号", "品名", "类别", "单位", "仓位", "现存量", "商品合计", "标签", "门市价 P2", "P3", "P4"].map(ui);
  if (d.show_cost) head.push(ui("成本值"));
  const aoa: (string | number | null)[][] = [head];
  for (const r of d.rows as (StockRow & { tags?: string[] })[]) {
    const row: (string | number | null)[] = [r.item_code, r.description, r.item_group ?? "", r.uom ?? "", r.location || "", Number(r.qty),
      r.item_total != null ? Number(r.item_total) : null, (r.tags ?? []).map(ui).join(", "), num(r.price2), num(r.price3), num(r.price4)];
    if (d.show_cost) row.push(num(r.total_cost));
    aoa.push(row);
  }
  if (d.capped) aoa.push([ui(`只下载了前 ${d.rows.length} 行（共 ${d.total} 行），请加筛选条件再下载。`)]);
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = [16, 40, 12, 8, 12, 10, 10, 16, 10, 10, 10, 12].map((wch) => ({ wch }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, ui("库存总表").slice(0, 31));
  const out = XLSX.write(wb, { bookType: "xlsx", type: "array", compression: true }) as ArrayBuffer;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([out], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
  const stamp = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kuala_Lumpur" }).format(new Date());
  a.download = `${ui("库存总表")}_${d.company}${d.tag ? `_${ui(d.tag)}` : ""}_${stamp}.xlsx`.replace(/[\\/:*?"<>|]+/g, " ");
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
function num(v: number | null | undefined): number | null {
  return v == null ? null : Number(v);
}
