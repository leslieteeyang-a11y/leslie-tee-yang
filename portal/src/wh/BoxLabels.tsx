// 印条码 → 箱贴：点货后（最近 14 天的进货，或从点货完成画面带 ?do=<厂家到货>）勾选 → 填几箱 → 建批次 → 印；也可以手动建。
// 箱贴：商品代号（大）、品名、Code 128（商品代号）、QR（营运系统的批次页 #/warehouse/lot/<批次号>，扫了要先登入）、批次号、点货日期、
// 给哪间分店、第 n / N 箱、建议货架。尺寸：大箱 100×60mm、小箱 50×30mm（标签机一张一个；浏览器列印，边界设「无」）。
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { BRANCH_LABEL, fmtQty } from "../api";
import { Empty, ErrorBox } from "../ui";
import { wh } from "../wh-api";
import { dateKL, Lot, LotMove, LotMoves, lotUrl, whTag } from "../wh-tag-api";
import { code128Svg } from "./code128";
import { ScanBox } from "./Scanner";
import "../wh-tag.css";

export type BoxSize = "big" | "small";
export const BOX_SIZES: Record<BoxSize, { name: string; page: string; w: number; h: number }> = {
  big: { name: "大箱 100×60mm", page: "100mm 60mm", w: 100, h: 60 },
  small: { name: "小箱 50×30mm", page: "50mm 30mm", w: 50, h: 30 },
};
const SIZE_KEY = "hw-box-size";
export function savedSize(): BoxSize {
  try { return localStorage.getItem(SIZE_KEY) === "small" ? "small" : "big"; } catch { return "big"; }
}
function keepSize(s: BoxSize) {
  try { localStorage.setItem(SIZE_KEY, s); } catch { /* 无痕模式 */ }
}
const OUTLETS: [string, string][] = [["HQ", "总部"], ["BATU", "Batu"], ["JB", "JB"], ["PUCHONG", "Puchong"]];

/** 每个批次的 QR（SVG 字串）；qrcode-generator 动态载入，只有要印才下载 */
async function qrSvgs(lots: Lot[]): Promise<Record<string, string>> {
  const { default: qrcode } = await import("qrcode-generator");
  const out: Record<string, string> = {};
  for (const l of lots) {
    const qr = qrcode(0, "M");
    qr.addData(lotUrl(l.lot_no));
    qr.make();
    // margin 0：白边由箱贴的 padding 与 wh-tag.css 的间距留（再加 margin 会把 QR 本体缩小，小箱更难扫）
    out[l.lot_no] = qr.createSvgTag({ cellSize: 2, margin: 0, scalable: true });
  }
  return out;
}

/** 一张箱贴（白纸黑字，画面预览与列印共用） */
export function BoxLabel({ lot, n, size, qr }: { lot: Lot; n: number; size: BoxSize; qr: string }) {
  const s = BOX_SIZES[size];
  let bar = "";
  try { bar = code128Svg(lot.item_code); } catch { bar = ""; }
  return (
    <div className={`box-label ${size}`} style={{ width: `${s.w}mm`, height: `${s.h}mm` }}>
      <div className="bl-top">
        <div className="bl-main">
          <div className="bl-code">{lot.item_code}</div>
          <div className="bl-desc">{lot.description}</div>
        </div>
        <div className="bl-qr" dangerouslySetInnerHTML={{ __html: qr }} />
      </div>
      <div className="bl-bar" dangerouslySetInnerHTML={{ __html: bar }} />
      <div className="bl-row"><span>{`批次 ${lot.lot_no}`}</span><span>{`点货日期 ${dateKL(lot.received_at || lot.created_at)}`}</span></div>
      <div className="bl-row">
        {lot.outlet_name ? <b>{`给 ${lot.outlet_name}`}</b> : <span />}
        <b>{`第 ${n} / ${lot.boxes} 箱`}</b>
        {lot.bin ? <span>{`货架 ${lot.bin}`}</span> : <span />}
      </div>
    </div>
  );
}

/** 列印箱贴：print(lots, size) 先产生 QR、记打印纪录，再叫浏览器列印；portal 要放进画面 */
export function useBoxPrint() {
  const [job, setJob] = useState<{ lots: Lot[]; size: BoxSize; qr: Record<string, string> } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!job) return;
    const style = document.createElement("style");
    style.textContent = `@page { size: ${BOX_SIZES[job.size].page}; margin: 0; }`;
    document.head.appendChild(style);
    const done = () => setJob(null);
    window.addEventListener("afterprint", done);
    const t = setTimeout(() => window.print(), 300);
    return () => { clearTimeout(t); window.removeEventListener("afterprint", done); style.remove(); };
  }, [job]);
  async function print(lots: Lot[], size: BoxSize) {
    setError("");
    if (!lots.length) return;
    try {
      const qr = await qrSvgs(lots);
      setJob({ lots, size, qr });
      whTag.logPrints(lots[0].company, lots.map((l) => ({ kind: "lot", lot_no: l.lot_no, copies: l.boxes, size }))).catch(() => { /* 纪录失败不挡列印 */ });
    } catch (e) { setError((e as Error).message); }
  }
  const portal = job && createPortal(
    <div id="label-print" className="roll">
      {job.lots.flatMap((l) => Array.from({ length: Math.min(l.boxes, 999) }, (_, i) => (
        <BoxLabel key={`${l.lot_no}-${i}`} lot={l} n={i + 1} size={job.size} qr={job.qr[l.lot_no] ?? ""} />
      )))}
    </div>, document.body);
  return { print, portal, error, printing: !!job };
}

/** 尺寸下拉（记在这台电脑） */
export function SizePick({ size, onChange }: { size: BoxSize; onChange: (s: BoxSize) => void }) {
  return (
    <label className="inline">尺寸
      <select value={size} onChange={(e) => { const v = e.target.value as BoxSize; keepSize(v); onChange(v); }}>
        {(Object.keys(BOX_SIZES) as BoxSize[]).map((k) => <option key={k} value={k}>{BOX_SIZES[k].name}</option>)}
      </select>
    </label>
  );
}

/** 画面上的预览（第一张） */
export function BoxPreview({ lot, size }: { lot: Lot; size: BoxSize }) {
  const [qr, setQr] = useState("");
  useEffect(() => { let alive = true; qrSvgs([lot]).then((m) => alive && setQr(m[lot.lot_no] ?? "")).catch(() => {}); return () => { alive = false; }; }, [lot]);
  return (
    <div className="label-preview wht-preview">
      <BoxLabel lot={lot} n={1} size={size} qr={qr} />
      <span className="muted small">预览（第一张）</span>
    </div>
  );
}

export default function BoxLabels({ company, locs, query }: { company: string; locs: string[]; query: string }) {
  const doId = Number(new URLSearchParams(query).get("do")) || null;
  const [byDo, setByDo] = useState(!!doId);
  const [qIn, setQIn] = useState("");
  const [q, setQ] = useState("");
  const [data, setData] = useState<LotMoves | null>(null);
  const [error, setError] = useState("");
  const [sel, setSel] = useState<Record<number, number>>({});   // move_id → 几箱
  const [size, setSize] = useState<BoxSize>(savedSize);
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState<Lot[]>([]);
  const bp = useBoxPrint();

  useEffect(() => {
    let alive = true;
    setData(null); setError("");
    whTag.lotMoves({ company, do_id: byDo ? doId : null, days: 14, q })
      .then((d) => {
        if (!alive) return;
        setData(d);
        // 从点货完成画面来的：这张厂家到货的进货预先全勾（箱数 = 上次印的，没印过 1）
        if (byDo) setSel(Object.fromEntries(d.rows.map((r) => [r.move_id, r.boxes ?? 1])));
      })
      .catch((e: Error) => alive && setError(e.message));
    return () => { alive = false; };
  }, [company, byDo, doId, q]);

  const groups = useMemo(() => {
    const m = new Map<number, LotMove[]>();
    for (const r of data?.rows ?? []) { const l = m.get(r.do_id) ?? []; l.push(r); m.set(r.do_id, l); }
    return [...m.entries()];
  }, [data]);
  const picked = (data?.rows ?? []).filter((r) => sel[r.move_id] != null);
  const sheets = picked.reduce((a, r) => a + (sel[r.move_id] || 0), 0);
  const co = data?.company ?? company;

  async function make() {
    setBusy(true); setError(""); setMade([]);
    try {
      const r = await whTag.createLots(co, picked.map((x) => ({ move_id: x.move_id, boxes: sel[x.move_id] || 1 })));
      setMade(r.lots);
      await bp.print(r.lots, size);
      const d = await whTag.lotMoves({ company, do_id: byDo ? doId : null, days: 14, q });
      setData(d);
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  }
  const toggle = (r: LotMove, on: boolean) => setSel((s) => {
    const n = { ...s };
    if (on) n[r.move_id] = r.boxes ?? 1; else delete n[r.move_id];
    return n;
  });

  return (
    <>
      <div className="rpl-filters">
        {doId && (
          <label className="check"><input type="checkbox" checked={byDo} onChange={(e) => setByDo(e.target.checked)} /> 只看这张厂家到货</label>
        )}
        {!byDo && (
          <form className="wht-search" onSubmit={(e) => { e.preventDefault(); setQ(qIn.trim()); }}>
            <input className="search" type="search" value={qIn} placeholder="搜商品 / 批次号 / 厂家 DO 号…" onChange={(e) => setQIn(e.target.value)} />
            <button className="small">搜寻</button>
          </form>
        )}
        <SizePick size={size} onChange={setSize} />
      </div>
      {data && data.company !== company && <p className="small amber">{`这张厂家到货是「${BRANCH_LABEL[data.company] ?? data.company}」的。`}</p>}
      <ErrorBox error={error || bp.error} />
      {!data ? (!error && <p className="muted">载入中…</p>) : data.rows.length === 0 ? (
        <Empty>{byDo ? "这张厂家到货没有进货（还没点货，或进货都取消了）。" : "最近 14 天没有点货的进货。下面可以手动建批次。"}</Empty>
      ) : (
        <>
          {!byDo && <p className="muted small">最近 14 天点货的进货。勾选要印的，填几箱，按「建批次并列印」。</p>}
          {groups.map(([d, rows]) => {
            const all = rows.every((r) => sel[r.move_id] != null);
            const h = rows[0];
            return (
              <section key={d} className="card wht-group">
                <div className="wht-group-head">
                  <label className="check"><input type="checkbox" checked={all} disabled={!data.can_create}
                    onChange={(e) => rows.forEach((r) => toggle(r, e.target.checked))} />
                    <b>{h.do_no ? `厂家 DO ${h.do_no}` : `厂家到货 #${d}`}</b>
                  </label>
                  <span className="muted small">{[h.supplier_name, `点货日期 ${dateKL(h.arrived_at)}`].filter(Boolean).join(" · ")}</span>
                </div>
                <ul className="list wht-moves">
                  {rows.map((r) => {
                    const on = sel[r.move_id] != null;
                    return (
                      <li key={r.move_id} className={on ? "on" : ""}>
                        <label className="check wht-pick">
                          <input type="checkbox" checked={on} disabled={!data.can_create} onChange={(e) => toggle(r, e.target.checked)} />
                          <span>
                            <b>{r.item_code}</b>{" "}<span className="small">{r.description}</span>
                            <br />
                            <span className="muted small">{`${fmtQty(r.qty)} ${r.uom ?? ""} · ${r.location}`}</span>
                            {r.outlet_name && <span className="tag outlet">{`给 ${r.outlet_name}`}</span>}
                            {r.recv_wrong && <span className="tag warn">来错的货</span>}
                            {r.lot_no && <span className="tag">{r.printed ? `${r.lot_no} · 已印 ${r.printed} 张` : r.lot_no}</span>}
                          </span>
                        </label>
                        {on && (
                          <label className="inline wht-boxes">箱数
                            <input className="num-input" type="number" min="1" max="999" value={sel[r.move_id]}
                              onChange={(e) => setSel((s) => ({ ...s, [r.move_id]: Math.min(999, Math.max(1, Number(e.target.value) || 1)) }))} />
                          </label>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
          {data.can_create ? (
            <div className="filters">
              <button disabled={busy || bp.printing || picked.length === 0} onClick={make}>
                {busy ? "处理中…" : `🖨 建批次并列印（${picked.length} 个商品、${sheets} 张）`}
              </button>
              <span className="muted small">同一笔进货再按一次 = 同一个批次号（只改箱数），不会多出批次。</span>
            </div>
          ) : <p className="muted small">印箱贴要仓库或订货「可编辑」。</p>}
        </>
      )}
      {made.length > 0 && (
        <div className="ok">
          {`已建 ${made.length} 个批次：`}
          {made.map((l) => <a key={l.lot_no} className="wht-lotlink" href={`#/warehouse/lot/${l.lot_no}`}>{l.lot_no}</a>)}
        </div>
      )}
      {made.length > 0 && <BoxPreview lot={made[0]} size={size} />}
      {(data?.can_create ?? false) && <ManualLot company={company} locs={locs} size={size} onMade={(l) => { setMade([l]); bp.print([l], size); }} />}
      <p className="muted small">列印时在浏览器的列印设定把「边界 / Margins」设成「无 / None」、缩放 100%，纸张选标签的尺寸。箱贴上的 QR 用手机扫会开这个批次（要先登入营运系统）。</p>
      {bp.portal}
    </>
  );
}

/** 手动建批次：没有点货纪录的货（例：客户退货、旧货重新贴） */
function ManualLot({ company, locs, size, onMade }: { company: string; locs: string[]; size: BoxSize; onMade: (l: Lot) => void }) {
  const [item, setItem] = useState<{ code: string; desc: string } | null>(null);
  const [qty, setQty] = useState("");
  const [boxes, setBoxes] = useState("1");
  const [loc, setLoc] = useState(locs.includes("HQ") ? "HQ" : locs[0] ?? "");
  const [outlet, setOutlet] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const outlets = OUTLETS.filter(([k]) => company === "HOMEWORKSSB" || k === "JB");

  async function find(code: string) {
    setError("");
    try {
      const d = await wh.item(company, code);
      if (!d.found) { setError(`找不到「${code}」。`); return; }
      setItem({ code: d.item_code, desc: d.description });
    } catch (e) { setError((e as Error).message); }
  }
  async function save() {
    if (!item) return;
    setBusy(true); setError("");
    try {
      const r = await whTag.createLots(company, [{ item: item.code, qty: Number(qty), location: loc, outlet: outlet || undefined, boxes: Number(boxes) || 1, note }]);
      onMade(r.lots[0]);
      setItem(null); setQty(""); setBoxes("1"); setNote("");
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  }
  return (
    <details className="card wht-manual">
      <summary>手动建批次（没有点货纪录的货，例：客户退货、旧货重新贴）</summary>
      {item ? (
        <p><b>{item.code}</b>{" "}<span className="small">{item.desc}</span>{" "}<button className="small ghost" onClick={() => setItem(null)}>换商品</button></p>
      ) : <ScanBox onCode={find} placeholder="扫或打商品代号" />}
      <div className="wht-form">
        <label>数量<input type="number" min="0" step="any" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} /></label>
        <label>箱数<input type="number" min="1" max="999" value={boxes} onChange={(e) => setBoxes(e.target.value)} /></label>
        <label>仓位
          <select value={loc} onChange={(e) => setLoc(e.target.value)}>
            {locs.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
        </label>
        <label>给哪间分店
          <select value={outlet} onChange={(e) => setOutlet(e.target.value)}>
            <option value="">（不写）</option>
            {outlets.map(([k, n]) => <option key={k} value={k}>{n}</option>)}
          </select>
        </label>
      </div>
      <input value={note} maxLength={200} placeholder="备注（选填，只在批次页看得到）" onChange={(e) => setNote(e.target.value)} />
      <ErrorBox error={error} />
      <div className="filters">
        <button disabled={busy || !item || !(Number(qty) > 0) || !loc} onClick={save}>{busy ? "处理中…" : "🖨 建批次并列印"}</button>
        <span className="muted small">{BOX_SIZES[size].name}</span>
      </div>
    </details>
  );
}
