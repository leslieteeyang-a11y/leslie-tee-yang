// 印条码标签：条码内容 = AutoCount 商品代号（Code 128）。清单存在这台手机 / 电脑（localStorage），可以慢慢加再一次印。
// 版面：A4 贴纸（24 格 70×37mm、21 格 63.5×38.1mm）或标签机 50×30mm。用浏览器的列印，记得把「边界」设成「无」。
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Empty, ErrorBox } from "../ui";
import { qtyLabel, wh } from "../wh-api";
import { code128Svg } from "./code128";
import { ScanBox } from "./Scanner";

export interface LabelRow { item_code: string; description: string; copies: number }
const KEY = "hw-labels";

function readList(): LabelRow[] {
  try { return JSON.parse(localStorage.getItem(KEY) || "[]") as LabelRow[]; } catch { return []; }
}
function writeList(rows: LabelRow[]) {
  try { localStorage.setItem(KEY, JSON.stringify(rows)); } catch { /* 无痕模式：只留在画面上 */ }
}
/** 从别的地方（查货）加进清单 */
export function addLabels(add: LabelRow[]) {
  const rows = readList();
  for (const a of add) {
    const hit = rows.find((r) => r.item_code === a.item_code);
    if (hit) hit.copies += a.copies; else rows.push({ ...a });
  }
  writeList(rows);
}

type Layout = { key: string; name: string; page: string; cols: number; w: number; h: number; top: number; left: number; gapX: number; gapY: number };
const LAYOUTS: Layout[] = [
  { key: "a4-24", name: "A4 贴纸 24 格（70×37mm）", page: "A4", cols: 3, w: 70, h: 37, top: 0.5, left: 0, gapX: 0, gapY: 0 },
  { key: "a4-21", name: "A4 贴纸 21 格（63.5×38.1mm）", page: "A4", cols: 3, w: 63.5, h: 38.1, top: 15.15, left: 7.25, gapX: 2.5, gapY: 0 },
  { key: "roll-50x30", name: "标签机 50×30mm（一张一个）", page: "50mm 30mm", cols: 1, w: 50, h: 30, top: 0, left: 0, gapX: 0, gapY: 0 },
];

export default function Labels({ company, locs }: { company: string; locs: string[] }) {
  const [rows, setRows] = useState<LabelRow[]>(readList);
  const [layout, setLayout] = useState(() => { try { return localStorage.getItem("hw-label-layout") || "a4-24"; } catch { return "a4-24"; } });
  const [loc, setLoc] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [printing, setPrinting] = useState(false);
  const L = LAYOUTS.find((x) => x.key === layout) || LAYOUTS[0];
  const total = rows.reduce((a, r) => a + r.copies, 0);

  useEffect(() => writeList(rows), [rows]);
  useEffect(() => {
    if (!printing) return;
    const style = document.createElement("style");
    style.textContent = `@page { size: ${L.page}; margin: 0; }`;
    document.head.appendChild(style);
    const done = () => setPrinting(false);
    window.addEventListener("afterprint", done);
    const t = setTimeout(() => window.print(), 300);
    return () => { clearTimeout(t); window.removeEventListener("afterprint", done); style.remove(); };
  }, [printing, L.page]);

  async function add(code: string) {
    setError("");
    const d = await wh.item(company, code).catch((e: Error) => { setError(e.message); return null; });
    if (!d) return;
    if (!d.found) { setError(`找不到「${code}」。`); return; }
    setRows((rs) => rs.some((r) => r.item_code === d.item_code)
      ? rs.map((r) => (r.item_code === d.item_code ? { ...r, copies: r.copies + 1 } : r))
      : [...rs, { item_code: d.item_code, description: d.description, copies: 1 }]);
  }
  async function addLocation() {
    if (!loc) return;
    setBusy(true); setError("");
    try {
      const items = await wh.locationItems(company, loc);
      setRows((rs) => {
        const out = [...rs];
        for (const i of items) if (!out.some((r) => r.item_code === i.item_code)) out.push({ item_code: i.item_code, description: i.description, copies: 1 });
        return out;
      });
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  }

  const labels = rows.flatMap((r) => Array.from({ length: Math.max(0, Math.min(r.copies, 500)) }, () => r));
  return (
    <>
      <ScanBox onCode={add} placeholder="扫或打商品代号，加进要印的清单" />
      <div className="filters">
        <label className="inline">整个仓位
          <select value={loc} onChange={(e) => setLoc(e.target.value)}>
            <option value="">请选</option>
            {locs.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
        </label>
        <button className="ghost" disabled={!loc || busy} onClick={addLocation}>{busy ? "载入中…" : "加入这个仓位所有有货的商品"}</button>
      </div>
      <ErrorBox error={error} />
      {rows.length === 0 ? <Empty>还没有要印的条码。在上面扫或打商品代号，或在「查货」按「印条码」。</Empty> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>商品</th><th className="num">张数</th><th /></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.item_code}>
                  <td><b>{r.item_code}</b><div className="muted small">{r.description}</div></td>
                  <td className="num"><input className="num-input" type="number" min="1" max="500" value={r.copies}
                    onChange={(e) => setRows((rs) => rs.map((x) => (x.item_code === r.item_code ? { ...x, copies: Math.max(1, Number(e.target.value) || 1) } : x)))} /></td>
                  <td className="nowrap"><a href="#" onClick={(e) => { e.preventDefault(); setRows((rs) => rs.filter((x) => x.item_code !== r.item_code)); }}>移除</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="filters">
        <label className="inline">版面
          <select value={layout} onChange={(e) => { setLayout(e.target.value); try { localStorage.setItem("hw-label-layout", e.target.value); } catch { /* 忽略 */ } }}>
            {LAYOUTS.map((x) => <option key={x.key} value={x.key}>{x.name}</option>)}
          </select>
        </label>
        <button disabled={!total} onClick={() => setPrinting(true)}>{`🖨 列印（${qtyLabel(total)} 张）`}</button>
        {rows.length > 0 && <button className="ghost" onClick={() => setRows([])}>清空清单</button>}
      </div>
      <p className="muted small">列印时在浏览器的列印设定把「边界 / Margins」设成「无 / None」、缩放 100%。先用白纸印一张对一下贴纸的位置。手机印不方便的话，在办公室电脑开这一页印。</p>
      {rows.length > 0 && (
        <div className="label-preview">
          <LabelBox r={rows[0]} L={L} />
          <span className="muted small">预览（第一张）</span>
        </div>
      )}
      {printing && createPortal(
        <div id="label-print" className={L.page === "A4" ? "" : "roll"} style={{ paddingTop: `${L.top}mm`, paddingLeft: `${L.left}mm` }}>
          <div style={{ display: "grid", gridTemplateColumns: `repeat(${L.cols}, ${L.w}mm)`, columnGap: `${L.gapX}mm`, rowGap: `${L.gapY}mm` }}>
            {labels.map((r, i) => <LabelBox key={i} r={r} L={L} />)}
          </div>
        </div>, document.body)}
    </>
  );
}

function LabelBox({ r, L }: { r: LabelRow; L: Layout }) {
  let svg = "";
  try { svg = code128Svg(r.item_code); } catch { svg = ""; }
  return (
    <div className="label" style={{ width: `${L.w}mm`, height: `${L.h}mm` }}>
      <div className="label-code">{r.item_code}</div>
      <div className="label-bar" dangerouslySetInnerHTML={{ __html: svg }} />
      <div className="label-desc">{r.description}</div>
    </div>
  );
}
