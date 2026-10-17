// 盘点一个商品（每日小盘点与盘点单共用）：这个商品在这个仓位有货架帐时，列出那些货架（只有名字、不给数量 = 盲盘）
// + 「其他地方 / 地上」+「加一个货架」，每格填数，合计 = 实盘数。不符先请再数一次（画面不关、清空重填），第二次才算差异。
// 相符或差异（定案）时资料库会把列出来的货架改成盘到的数；要再数那次不改。
// 这个商品有已开、还没备的 DO（AutoCount 已经扣了、货可能还在货架上）→ 琥珀色提醒照实际看到的数。
import { FormEvent, useEffect, useMemo, useState } from "react";
import { ErrorBox, Modal } from "../ui";
import { Scanner } from "./Scanner";
import { qtyLabel } from "../wh-api";
import { CountBinsInfo, CountSaveResult, sheets } from "../wh-sheet-api";
import "../wh-sheet.css";

export interface CountItem { code: string; desc?: string | null; uom?: string | null; recount?: boolean }
interface Row { id: number; code: string; qty: string; added?: boolean }

export function CountBins({ company, location, item, sheetId, sheetTitle, onClose, onSaved }: {
  company: string; location: string; item: CountItem;
  /** 从盘点单打开：存到这张单（没给 = 自动挂到开着、有这个商品的盘点单） */ sheetId?: number | null; sheetTitle?: string;
  onClose: () => void;
  /** 每次存都会叫（recount 时画面不关，父层只要重新载入清单） */ onSaved: (r: CountSaveResult) => void;
}) {
  const [info, setInfo] = useState<CountBinsInfo | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [loose, setLoose] = useState("");
  const [note, setNote] = useState("");
  const [recount, setRecount] = useState(!!item.recount);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [addText, setAddText] = useState("");
  const [scan, setScan] = useState(false);

  useEffect(() => {
    let live = true;
    sheets.countBins(company, location, item.code).then((d) => {
      if (!live) return;
      setInfo(d);
      setRows(d.bins.map((b) => ({ id: b.id, code: b.code, qty: "" })));
      if (d.recount) setRecount(true);
    }).catch((e: Error) => live && setError(e.message));
    return () => { live = false; };
  }, [company, location, item.code]);

  const total = useMemo(() => rows.reduce((a, r) => a + (Number(r.qty) || 0), 0) + (Number(loose) || 0), [rows, loose]);
  const binMode = rows.length > 0;
  const uom = info?.uom || item.uom || "";
  const free = (info?.all_bins || []).filter((b) => !rows.some((r) => r.id === b.id));
  const doWait = Number(info?.do_unpicked ?? 0);

  function addBin(text: string) {
    const t = text.trim().toUpperCase();
    if (!t || !info) return;
    const id = /^BIN:(\d+)$/.exec(t)?.[1];
    const b = info.all_bins.find((x) => (id ? String(x.id) === id : x.code === t));
    if (!b) { setError(`${location} 没有货架「${text.trim()}」。`); return; }
    if (rows.some((r) => r.id === b.id)) { setError(`货架 ${b.code} 已经在上面了。`); return; }
    setError("");
    setRows((rs) => [...rs, { id: b.id, code: b.code, qty: "", added: true }]);
    setAddText(""); setAdding(false);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!info) return;
    if (rows.some((r) => r.qty.trim() === "")) { setError("每个货架都要填（没有就填 0）。"); return; }
    if (!binMode && loose.trim() === "") { setError("请填实际数到的数量（没有就填 0）。"); return; }
    setBusy(true); setError("");
    try {
      const r = await sheets.save({
        company, location, item_code: info.item_code, note, sheet_id: sheetId ?? null,
        bins: rows.map((x) => ({ bin: x.id, qty: Number(x.qty) })), loose: Number(loose) || 0,
      });
      if (r.result === "recount") {
        // 不关：清空重填（加上去的货架留着，免得再找一次）
        setRecount(true);
        setRows((rs) => rs.map((x) => ({ ...x, qty: "" })));
        setLoose(""); setBusy(false);
      }
      onSaved(r);
    } catch (err) { setError((err as Error).message); setBusy(false); }
  }

  return (
    <Modal title={recount ? `再数一次 · ${location}` : `盘点 · ${location}`} onClose={onClose}>
      <form className="form cb-form" onSubmit={submit}>
        <p className="cb-item"><b>{item.code}</b><br /><span className="muted">{info?.description || item.desc || ""}</span></p>
        {(sheetId ? sheetTitle : info?.sheet?.title) && <p className="small muted">{`盘点单：${sheetId ? sheetTitle : info?.sheet?.title}`}</p>}
        {recount && <p className="late small">第一次数的跟系统不一样，请再仔细数一次（包括别的货架、坏货、展示品有没有放错）。</p>}
        {doWait > 0 && <p className="amber small">{`有 ${qtyLabel(doWait)} 件在已开、还没备的 DO 上：货可能还在货架上，照实际看到的数（已经备好放在出货区的不要算）。`}</p>}
        {!info ? (!error && <p className="muted">载入中…</p>) : (
          <>
            {binMode && (
              <>
                <p className="small muted">每个货架都要数，没有就填 0。系统数量故意不给看（盲盘）。</p>
                <div className="cb-rows">
                  {rows.map((r, i) => (
                    <div key={r.id} className="cb-row">
                      <span className="cb-bin">{r.code}</span>
                      {r.added && <span className="tag">新加</span>}
                      <input className="cb-qty" type="number" inputMode="decimal" min="0" step="any" value={r.qty} autoFocus={i === 0}
                             aria-label={`货架 ${r.code} 数到几`} placeholder="0"
                             onChange={(e) => { setError(""); setRows((rs) => rs.map((x) => (x.id === r.id ? { ...x, qty: e.target.value } : x))); }} />
                      {r.added && <button type="button" className="ghost small" onClick={() => setRows((rs) => rs.filter((x) => x.id !== r.id))}>移除</button>}
                    </div>
                  ))}
                  <div className="cb-row">
                    <span className="cb-bin cb-loose">其他地方 / 地上</span>
                    <input className="cb-qty" type="number" inputMode="decimal" min="0" step="any" value={loose} placeholder="0"
                           aria-label="其他地方 / 地上" onChange={(e) => { setError(""); setLoose(e.target.value); }} />
                  </div>
                </div>
              </>
            )}
            {!binMode && (
              <label>{`实际数到几${uom ? `（${uom}）` : ""}`}
                <input className="big-num" type="number" inputMode="decimal" min="0" step="any" value={loose} autoFocus
                       onChange={(e) => { setError(""); setLoose(e.target.value); }} /></label>
            )}
            {free.length > 0 && !adding && (
              <button type="button" className="ghost small cb-add" onClick={() => setAdding(true)}>
                {binMode ? "＋ 加一个货架" : "＋ 分货架数"}
              </button>
            )}
            {adding && (
              <div className="cb-addbox">
                <input list="cb-bins" value={addText} onChange={(e) => setAddText(e.target.value)} placeholder="扫货架条码，或打货架代号"
                       autoCapitalize="characters" autoFocus
                       onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addBin(addText); } }} />
                <datalist id="cb-bins">{free.map((b) => <option key={b.id} value={b.code} />)}</datalist>
                <button type="button" className="ghost small" onClick={() => setScan(true)}>▦ 扫码</button>
                <button type="button" className="small" disabled={!addText.trim()} onClick={() => addBin(addText)}>加入</button>
                <button type="button" className="ghost small" onClick={() => { setAdding(false); setAddText(""); }}>取消</button>
              </div>
            )}
            {!binMode && adding && <p className="small muted">加了货架之后，上面那格就是「其他地方 / 地上」。</p>}
            {binMode && <p className="cb-total">{`合计 ${qtyLabel(total)}${uom ? ` ${uom}` : ""}`}</p>}
          </>
        )}
        <label>备注（选填）<input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="例：2 箱压坏、1 件在展示区" /></label>
        <ErrorBox error={error} />
        <div className="actions">
          <button type="button" className="ghost" onClick={onClose}>取消</button>
          <button disabled={busy || !info}>{busy ? "储存中…" : "确认"}</button>
        </div>
      </form>
      {scan && <Scanner title="扫货架条码" onClose={() => setScan(false)} onCode={(c) => { setScan(false); addBin(c); }} />}
    </Modal>
  );
}
