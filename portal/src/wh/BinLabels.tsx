// 货架标签：Code 128（内容 BIN:<编号>，扫到就知道是哪个货架）+ 大字代号 + 仓位。
// 版面：A4 贴纸 3×8（70×37mm）或标签机 50×30mm。印法同「印条码」（Labels.tsx）：浏览器列印，边界设「无」。
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Bin } from "../wh-bin-api";
import { code128Svg } from "./code128";

type Layout = { key: string; name: string; page: string; cols: number; w: number; h: number; top: number; left: number };
const LAYOUTS: Layout[] = [
  { key: "a4-24", name: "A4 贴纸 24 格（70×37mm）", page: "A4", cols: 3, w: 70, h: 37, top: 0.5, left: 0 },
  { key: "roll-50x30", name: "标签机 50×30mm（一张一个）", page: "50mm 30mm", cols: 1, w: 50, h: 30, top: 0, left: 0 },
];
const KEY = "hw-bin-label-layout";

/** 选好的货架 → 版面 + 列印（放在货架清单的勾选列） */
export function BinLabelBar({ bins }: { bins: Bin[] }) {
  const [layout, setLayout] = useState(() => { try { return localStorage.getItem(KEY) || "a4-24"; } catch { return "a4-24"; } });
  const [printing, setPrinting] = useState(false);
  const L = LAYOUTS.find((x) => x.key === layout) || LAYOUTS[0];
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

  return (
    <>
      <select className="narrow-select" value={layout} aria-label="版面"
              onChange={(e) => { setLayout(e.target.value); try { localStorage.setItem(KEY, e.target.value); } catch { /* 忽略 */ } }}>
        {LAYOUTS.map((x) => <option key={x.key} value={x.key}>{x.name}</option>)}
      </select>
      <button disabled={!bins.length} onClick={() => setPrinting(true)}>{`🖨 列印（${bins.length} 张）`}</button>
      {bins.length > 0 && (
        <div className="label-preview bin-label-preview">
          <BinLabel b={bins[0]} L={L} />
          <span className="muted small">预览（第一张）。列印时把「边界 / Margins」设成「无 / None」、缩放 100%。</span>
        </div>
      )}
      {printing && createPortal(
        <div id="label-print" className={L.page === "A4" ? "" : "roll"} style={{ paddingTop: `${L.top}mm`, paddingLeft: `${L.left}mm` }}>
          <div style={{ display: "grid", gridTemplateColumns: `repeat(${L.cols}, ${L.w}mm)` }}>
            {bins.map((b) => <BinLabel key={b.id} b={b} L={L} />)}
          </div>
        </div>, document.body)}
    </>
  );
}

export function BinLabel({ b, L }: { b: Bin; L: Layout }) {
  let svg = "";
  try { svg = code128Svg(b.barcode || "BIN:" + b.id); } catch { svg = ""; }
  // 代号越长字越小，免得超出贴纸
  const n = b.code.length;
  const big = L.w >= 60 ? (n <= 7 ? 24 : n <= 10 ? 19 : n <= 14 ? 14 : 11) : (n <= 7 ? 18 : n <= 10 ? 14 : n <= 14 ? 11 : 9);
  return (
    <div className="label bin-label" style={{ width: `${L.w}mm`, height: `${L.h}mm` }}>
      <div className="bl-top"><span>{b.location}</span><span>{b.barcode || "BIN:" + b.id}</span></div>
      <div className="bl-code" style={{ fontSize: `${big}pt` }}>{b.code}</div>
      <div className="bl-bar" dangerouslySetInnerHTML={{ __html: svg }} />
    </div>
  );
}
