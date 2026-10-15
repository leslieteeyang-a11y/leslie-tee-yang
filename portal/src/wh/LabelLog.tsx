// 印条码 → 打印纪录：商品条码、箱贴、货架标签每印一次一笔。可以搜（商品 / 品名 / 批次号 / 货架 / 印的人）、选日期，补印。
import { useEffect, useState } from "react";
import { fmtQty } from "../api";
import { go } from "../router";
import { Empty, ErrorBox } from "../ui";
import { whenLabel } from "../wh-api";
import { PrintPage, PrintRow, whTag } from "../wh-tag-api";
import { savedSize, useBoxPrint } from "./BoxLabels";
import { addLabels } from "./Labels";
import { sizeName } from "./LotView";
import "../wh-tag.css";

const KIND_LABEL: Record<string, string> = { lot: "箱贴", item: "商品条码", bin: "货架标签" };
const ITEM_LAYOUT: Record<string, string> = { "a4-24": "A4 24 格", "a4-21": "A4 21 格", "roll-50x30": "标签机 50×30mm" };

export default function LabelLog({ company }: { company: string }) {
  const [kind, setKind] = useState("");
  const [qIn, setQIn] = useState("");
  const [q, setQ] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(0);
  const [data, setData] = useState<PrintPage | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const bp = useBoxPrint();

  useEffect(() => {
    let alive = true;
    setData(null); setError("");
    whTag.prints({ company, kind, q, from, to, page }).then((d) => alive && setData(d)).catch((e: Error) => alive && setError(e.message));
    return () => { alive = false; };
  }, [company, kind, q, from, to, page]);
  const pages = data ? Math.max(1, Math.ceil(data.total / data.page_size)) : 1;

  async function again(r: PrintRow) {
    setError(""); setNotice("");
    if (r.kind === "lot" && r.lot_no) {
      try {
        const l = await whTag.lot(r.lot_no);
        await bp.print([l], r.size === "small" || r.size === "big" ? r.size : savedSize());
      } catch (e) { setError((e as Error).message); }
    } else if (r.kind === "item" && r.item_code) {
      addLabels([{ item_code: r.item_code, description: r.description ?? "", copies: r.copies }]);
      setNotice("已加入「商品条码」清单。");
    }
  }

  return (
    <>
      <form className="rpl-filters" onSubmit={(e) => { e.preventDefault(); setQ(qIn.trim()); setPage(0); }}>
        <select value={kind} aria-label="种类" onChange={(e) => { setKind(e.target.value); setPage(0); }}>
          <option value="">全部种类</option>
          <option value="lot">箱贴</option>
          <option value="item">商品条码</option>
          <option value="bin">货架标签</option>
        </select>
        <input className="search" type="search" value={qIn} placeholder="搜商品 / 品名 / 批次号 / 货架 / 印的人…" onChange={(e) => setQIn(e.target.value)} />
        <button className="small">搜寻</button>
        <label className="inline">从<input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPage(0); }} /></label>
        <label className="inline">到<input type="date" value={to} onChange={(e) => { setTo(e.target.value); setPage(0); }} /></label>
        {data && <span className="muted small">{`${data.total} 笔`}</span>}
      </form>
      <ErrorBox error={error || bp.error} />
      {notice && <div className="ok">{notice}{" "}<a href="#/warehouse/labels">去印 →</a></div>}
      {!data ? (!error && <p className="muted">载入中…</p>) : data.rows.length === 0 ? <Empty>没有打印纪录。</Empty> : (
        <div className="table-wrap">
          <table className="wht-log">
            <thead><tr><th>时间</th><th className="hide-sm">种类</th><th>内容</th><th className="num hide-sm">张数</th><th className="hide-sm">尺寸</th><th className="hide-sm">印的人</th><th /></tr></thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.id}>
                  <td className="nowrap">{whenLabel(r.created_at)}<div className="show-sm muted small">{`${KIND_LABEL[r.kind] ?? r.kind} × ${r.copies}`}</div><div className="show-sm muted small">{r.by_name}</div></td>
                  <td className="nowrap hide-sm">{KIND_LABEL[r.kind] ?? r.kind}</td>
                  <td className="wht-log-what">
                    {r.kind === "lot" && <><a href={`#/warehouse/lot/${r.lot_no}`}>{r.lot_no}</a><br /></>}
                    {r.kind === "bin" ? <b>{`${r.bin_location ?? ""} · ${r.bin_code ?? ""}`}</b> : <b>{r.item_code}</b>}
                    {r.kind !== "bin" && r.description && <span className="small">{` ${r.description}`}</span>}
                    {r.kind === "lot" && r.lot_qty != null && <div className="muted small">{`${fmtQty(r.lot_qty)} 件 · ${r.lot_boxes} 箱${r.lot_location ? ` · ${r.lot_location}` : ""}`}</div>}
                  </td>
                  <td className="num hide-sm">{r.copies}</td>
                  <td className="hide-sm small">{r.kind === "item" ? ITEM_LAYOUT[r.size] ?? r.size : sizeName(r.size)}</td>
                  <td className="small hide-sm">{r.by_name}</td>
                  <td className="nowrap">
                    {r.kind === "lot" && data.can_lot && <button className="small ghost" disabled={bp.printing} onClick={() => again(r)}>补印</button>}
                    {r.kind === "item" && <button className="small ghost" onClick={() => again(r)}>补印</button>}
                    {r.kind === "bin" && <button className="small ghost" onClick={() => go("/warehouse/bins/list")}>到货架</button>}
                  </td>
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
      {bp.portal}
    </>
  );
}
