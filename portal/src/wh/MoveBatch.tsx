// 仓库 · 一次登记多个商品的搬动（2026-10-15）：种类 / 从 / 到 / 备注 / 照片共用，一行一个商品 + 数量 +（可选）从哪个货架拿 / 放到哪个货架。
// 商品可以一个一个扫，也可以从 Excel 复制两栏（商品代号、数量）贴上。资料库全部检查过才存：一行错整批不存，画面标出第几行。
import { useEffect, useRef, useState } from "react";
import { Me } from "../api";
import { ErrorBox, Modal } from "../ui";
import { shrinkImage, uploadPhoto } from "../att-api";
import { ScanBox } from "./Scanner";
import { FoundItem, MOVE_KIND_LABEL, MoveKind, qtyLabel, wh } from "../wh-api";
import { BinRow, bins, ItemBins } from "../wh-bin-api";
import { whx } from "../wh-extra-api";
import "../wh-extra.css";

const DEFAULT_TO: Partial<Record<MoveKind, string>> = { defect: "DEFECTS", display: "DISPLAY" };
const MAX_LINES = 200;
/** 超过这么多行就不逐个查商品在哪些货架（货架下拉改列整个仓位的货架） */
const BIN_LOOKUP_MAX = 60;

interface Line { key: number; code: string; desc: string; uom: string; qty: string; found: boolean; from_bin: string; to_bin: string }
let seq = 1;

/** Excel 复制的两栏（Tab 分开）；不是从 Excel 贴的就用逗号或空白分开。第一行数量不是数字 = 表头，略过 */
export function parsePaste(text: string): { code: string; qty: string }[] {
  const out: { code: string; qty: string }[] = [];
  let first = true;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    let cells = raw.split("\t");
    if (cells.length < 2) cells = raw.trim().split(/\s*[,;，；]\s*|\s+/);
    const code = (cells[0] || "").trim();
    const qtyRaw = (cells[1] || "").trim().replace(/[,\s]/g, "");
    const isNum = /^\d+(\.\d+)?$/.test(qtyRaw);
    const head = first && !isNum && qtyRaw !== "";
    first = false;
    if (!code || head) continue;
    out.push({ code: code.toUpperCase(), qty: isNum ? qtyRaw : "" });
  }
  return out;
}

export function MoveBatchForm({ me, company, locs, onClose, onSaved }: {
  me: Me; company: string; locs: string[]; onClose: () => void; onSaved: (n: number) => void;
}) {
  const [kind, setKind] = useState<MoveKind>("transfer");
  const [from, setFrom] = useState(locs[0] || "");
  const [to, setTo] = useState("");
  const [note, setNote] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [choices, setChoices] = useState<FoundItem[] | null>(null);
  const [paste, setPaste] = useState<string | null>(null);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");
  const [bad, setBad] = useState<{ row: number; code: string; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [fromBins, setFromBins] = useState<BinRow[]>([]);
  const [toBins, setToBins] = useState<BinRow[]>([]);
  const [itemBins, setItemBins] = useState<Record<string, ItemBins>>({});
  const asked = useRef(new Set<string>());
  const needFrom = kind !== "return";
  const needTo = kind === "transfer" || kind === "return" || kind === "defect" || kind === "display";
  const fromLoc = needFrom ? from : "";
  const toLoc = needTo ? to : "";

  useEffect(() => {
    const d = DEFAULT_TO[kind];
    if (d && locs.includes(d)) setTo(d);
    else if (kind === "transfer") setTo((t) => (t && t !== from ? t : locs.find((l) => l !== from) || ""));
  }, [kind]); // eslint-disable-line react-hooks/exhaustive-deps

  // 两边仓位的货架（没有货架的仓位就不显示货架栏）；换仓位清掉已选的货架
  useEffect(() => {
    setLines((ls) => ls.map((l) => ({ ...l, from_bin: "" })));
    if (!fromLoc) { setFromBins([]); return; }
    let alive = true;
    bins.list(company, fromLoc).then((r) => alive && setFromBins(r.bins.filter((b) => b.active))).catch(() => alive && setFromBins([]));
    return () => { alive = false; };
  }, [company, fromLoc]);
  useEffect(() => {
    setLines((ls) => ls.map((l) => ({ ...l, to_bin: "" })));
    if (!toLoc) { setToBins([]); return; }
    let alive = true;
    bins.list(company, toLoc).then((r) => alive && setToBins(r.bins.filter((b) => b.active))).catch(() => alive && setToBins([]));
    return () => { alive = false; };
  }, [company, toLoc]);
  // 有货架时，逐个查商品放在哪些货架（下拉先列有这个商品的货架）
  useEffect(() => {
    if ((!fromBins.length && !toBins.length) || lines.length > BIN_LOOKUP_MAX) return;
    for (const l of lines) {
      if (!l.found || asked.current.has(l.code)) continue;
      asked.current.add(l.code);
      bins.item(company, l.code).then((r) => setItemBins((m) => ({ ...m, [l.code]: r }))).catch(() => { /* 下拉就列整个仓位 */ });
    }
  }, [lines, fromBins.length, toBins.length, company]);

  const showFrom = fromBins.length > 0;
  const showTo = toBins.length > 0;

  function addLine(code: string, desc: string, uom: string, qty: string, found = true) {
    setLines((ls) => {
      const i = ls.findIndex((l) => l.code === code);
      if (i >= 0) {
        const n = [...ls];
        const sum = Number(n[i].qty || 0) + Number(qty || 0);
        n[i] = { ...n[i], qty: n[i].qty || qty ? String(Math.round(sum * 100) / 100) : "" };
        return n;
      }
      return [...ls, { key: seq++, code, desc, uom, qty, found, from_bin: "", to_bin: "" }];
    });
  }

  async function onScan(raw: string) {
    setError(""); setMsg(""); setChoices(null); setBad(null);
    try {
      const d = await wh.item(company, raw);
      if (d.found) { addLine(d.item_code, d.description, d.uom, "1"); setMsg(`已加 ${d.item_code}`); return; }
      const f = await wh.find(company, raw);
      if (f.length === 1) { addLine(f[0].item_code, f[0].description, f[0].uom, "1"); setMsg(`已加 ${f[0].item_code}`); return; }
      if (f.length === 0) { setError(`找不到「${raw}」。`); return; }
      setChoices(f);
    } catch (e) { setError((e as Error).message); }
  }

  async function readPaste() {
    setError(""); setMsg(""); setBad(null);
    const rows = parsePaste(paste || "");
    if (!rows.length) { setError("没有读到资料：请从 Excel 复制两栏（商品代号、数量）再贴上。"); return; }
    if (rows.length > MAX_LINES * 5) { setError(`一次最多 ${MAX_LINES} 个商品，请分开登记。`); return; }
    setBusy(true);
    try {
      const codes = [...new Set(rows.map((r) => r.code))];
      const found = await wh.items(company, codes);
      const map = new Map(found.map((f) => [f.item_code.toUpperCase(), f]));
      for (const r of rows) {
        const f = map.get(r.code);
        addLine(f ? f.item_code : r.code, f ? f.description : "", f ? f.uom : "", r.qty, !!f);
      }
      const miss = codes.filter((c) => !map.has(c)).length;
      setMsg(miss ? `读到 ${rows.length} 行；${miss} 个商品代号找不到（红色），请拿掉或另外扫正确的商品。` : `读到 ${rows.length} 行，都对到商品了。`);
      setPaste(null);
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  }

  const setLine = (key: number, patch: Partial<Line>) => {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
    // 改了标红的那一行：红字的说明不一定还对，先拿掉（行号拿掉一行后也会不对，所以 × 一律清掉）
    setBad((b) => (b && lines[b.row - 1]?.key === key ? null : b));
  };

  async function submit() {
    setError(""); setMsg(""); setBad(null);
    if (!lines.length) { setError("请至少加一个商品。"); return; }
    if (lines.length > MAX_LINES) { setError(`一次最多 ${MAX_LINES} 个商品，请分开登记。`); return; }
    if (needTo && !to) { setError("请选「到哪个仓位」。"); return; }
    const i = lines.findIndex((l) => !l.found || !(Number(l.qty) > 0));
    if (i >= 0) {
      setBad({ row: i + 1, code: lines[i].code, message: lines[i].found ? "请填数量。" : "找不到这个商品，请拿掉或另外扫正确的商品。" });
      return;
    }
    setBusy(true);
    try {
      let photo: string | null = null;
      if (file) {
        const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kuala_Lumpur" }).format(new Date());
        photo = await uploadPhoto(me.staff.id, today, "wh", await shrinkImage(file));
      }
      const r = await whx.moveBatch({
        company, kind, from_loc: fromLoc || null, to_loc: toLoc || null, note, photo,
        lines: lines.map((l) => ({ item_code: l.code, qty: l.qty, from_bin: l.from_bin || undefined, to_bin: l.to_bin || undefined })),
      });
      if (!r.ok) {
        const row = r.row || 1;
        setBad({ row, code: lines[row - 1]?.code || "", message: r.message || "" });
        setBusy(false);
        return;
      }
      onSaved(r.n || lines.length);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  // 货架下拉：有这个商品的货架先列（附数量）；还没查到就列整个仓位的货架
  function binOptions(code: string, loc: string, all: BinRow[], onlyWithStock: boolean) {
    const ib = itemBins[code]?.locations.find((x) => x.location === loc);
    const mine = (ib?.bins || []).filter((b) => b.active && (!onlyWithStock || Number(b.qty) > 0));
    const rest = onlyWithStock && ib ? [] : all.filter((b) => !mine.some((m) => m.id === b.id));
    return (
      <>
        {mine.map((b) => <option key={b.id} value={b.code}>{`${b.code} · ${qtyLabel(b.qty)}`}</option>)}
        {rest.map((b) => <option key={b.id} value={b.code}>{b.code}</option>)}
      </>
    );
  }

  return (
    <Modal title="一次登记多个商品" onClose={onClose} wide>
      {/* 不用 <form>：扫描枪在数量栏按 Enter 不会整批送出；扫码框自己的 form 也不会冒泡到这里 */}
      <div className="form">
        <div className="row">
          <label>做什么
            <select value={kind} onChange={(e) => setKind(e.target.value as MoveKind)}>
              {Object.entries(MOVE_KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
          {needFrom && (
            <label>从哪个仓位
              <select value={from} onChange={(e) => setFrom(e.target.value)}>
                {locs.map((l) => <option key={l} value={l}>{l}</option>)}
              </select>
            </label>
          )}
          {needTo && (
            <label>到哪个仓位
              <select value={to} onChange={(e) => setTo(e.target.value)} required>
                <option value="">请选</option>
                {locs.filter((l) => l !== from || !needFrom).map((l) => <option key={l} value={l}>{l}</option>)}
              </select>
            </label>
          )}
        </div>
        <div className="row">
          <label>{kind === "writeoff" || kind === "other" ? "原因（必填，每个商品共用）" : "备注（选填，每个商品共用）"}
            <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} /></label>
          <label>照片（选填）<input type="file" accept="image/*" capture="environment" onChange={(e) => setFile(e.target.files?.[0] || null)} /></label>
        </div>

        <h3 className="mb-head">{`商品（${lines.length}）`}</h3>
        <div onSubmit={(e) => e.stopPropagation()}>
          <ScanBox onCode={onScan} placeholder="扫商品条码或打代号 / 品名，一个一个加" busy={busy} />
        </div>
        {choices && choices.length > 0 && (
          <ul className="list mb-choices">
            {choices.map((f) => (
              <li key={f.item_code}>
                <span><b>{f.item_code}</b>{" "}<span className="muted small">{f.description}</span></span>
                <button type="button" className="small" onClick={() => { addLine(f.item_code, f.description, f.uom, "1"); setChoices(null); setMsg(`已加 ${f.item_code}`); }}>加</button>
              </li>
            ))}
          </ul>
        )}
        {paste === null ? (
          <div><button type="button" className="ghost small" onClick={() => setPaste("")}>从 Excel 贴上</button></div>
        ) : (
          <div className="mb-paste">
            <textarea rows={6} value={paste} onChange={(e) => setPaste(e.target.value)} autoFocus
                      placeholder={"在 Excel 选两栏（商品代号、数量）复制，贴在这里。例：\nHM-UB001\t5\nST003\t2"} />
            <div className="actions left">
              <button type="button" onClick={readPaste} disabled={busy || !paste.trim()}>读取</button>
              <button type="button" className="ghost" onClick={() => setPaste(null)}>取消</button>
            </div>
          </div>
        )}
        {msg && <div className="ok">{msg}</div>}

        {lines.length > 0 && (
          <div className="table-wrap flat mb-lines">
            <table>
              <thead><tr>
                <th>#</th><th>商品</th><th className="num">数量</th>
                {showFrom && <th>{`从货架（${fromLoc}）`}</th>}{showTo && <th>{`到货架（${toLoc}）`}</th>}<th />
              </tr></thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={l.key} className={(bad?.row === i + 1 ? "mb-bad" : "") + (l.found ? "" : " mb-miss")}>
                    <td className="muted">{i + 1}</td>
                    <td><b>{l.code}</b>
                      <div className={"small" + (l.found ? " muted" : " late")}>{l.found ? l.desc : "找不到这个商品"}</div></td>
                    <td className="num nowrap">
                      <input className="num-input" type="number" inputMode="decimal" min="0.01" step="any" value={l.qty}
                             aria-label="数量" onChange={(e) => setLine(l.key, { qty: e.target.value })} />
                      {l.uom && <span className="muted small">{` ${l.uom}`}</span>}
                    </td>
                    {showFrom && (
                      <td><select value={l.from_bin} onChange={(e) => setLine(l.key, { from_bin: e.target.value })} disabled={!l.found}
                                  aria-label="从货架">
                        <option value="">（不从货架）</option>
                        {l.found && binOptions(l.code, fromLoc, fromBins, true)}
                      </select></td>
                    )}
                    {showTo && (
                      <td><select value={l.to_bin} onChange={(e) => setLine(l.key, { to_bin: e.target.value })} disabled={!l.found}
                                  aria-label="到货架">
                        <option value="">（不放货架）</option>
                        {l.found && binOptions(l.code, toLoc, toBins, false)}
                      </select></td>
                    )}
                    <td><button type="button" className="icon" aria-label="拿掉"
                                onClick={() => { setLines((ls) => ls.filter((x) => x.key !== l.key)); setBad(null); }}>×</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {(showFrom || showTo) && <p className="muted small">选了货架，货架上的数量会跟著变；这笔搬动取消时会自动还原。不选 = 只登记搬动。</p>}
        {bad && <div className="error"><b>{`第 ${bad.row} 行（${bad.code}）`}</b>{" "}<span>{bad.message}</span></div>}
        <ErrorBox error={error} />
        <p className="muted small">每个商品各记一笔搬动，出现在「待输入 AutoCount」清单；有一行不对就整批都不存。</p>
        <div className="actions">
          <button type="button" className="ghost" onClick={onClose}>取消</button>
          <button type="button" onClick={submit} disabled={busy || !lines.length}>{busy ? "储存中…" : `登记 ${lines.length} 个商品`}</button>
        </div>
      </div>
    </Modal>
  );
}
