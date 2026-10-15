// 仓库 · 货架 · Excel 带入（可审批，初次设定用）：把货架上的数量「改成」表上的数。
// 先「检查」（dry_run，每行结果，错的标红）→ 全部没问题才能「确认带入」。读表在浏览器（binImport.ts）。
import { useState } from "react";
import { ErrorBox } from "../ui";
import { qtyLabel } from "../wh-api";
import { BinImportRow, bins } from "../wh-bin-api";
import { downloadTemplate, ImpRow, Parsed, parseBinSheet, rowBin } from "./binImport";

interface Res { ok: boolean; error?: string; item_code?: string }
const SHOW = 300;

export function BinImport({ company, locs, onSaved }: { company: string; locs: string[]; onSaved: () => void }) {
  const [file, setFile] = useState("");
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [map, setMap] = useState<Record<string, string>>({});
  const [loc, setLoc] = useState(locs[0] || "");
  const [create, setCreate] = useState(true);
  const [res, setRes] = useState<Map<ImpRow, Res> | null>(null);
  const [newBins, setNewBins] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  async function pick(f: File | undefined) {
    if (!f) return;
    setError(""); setDone(""); setParsed(null); setRes(null); setFile(f.name);
    setBusy(true);
    try {
      const { readWorkbook } = await import("../podo/parse");
      const sheets = await readWorkbook(f, f.name);
      let p: Parsed | string = "这个档案没有资料。";
      for (const s of sheets) { p = parseBinSheet(s.rows); if (typeof p !== "string") break; }
      if (typeof p === "string") { setError(p); return; }
      if (p.rows.length === 0) { setError("表上没有要带入的数量（0 或空白的格子会略过）。"); return; }
      // WMS 的仓名：跟 AutoCount 仓位同名（不分大小写、去掉结尾「仓」）就先对上，不然先略过
      const m: Record<string, string> = {};
      for (const w of p.warehouses) {
        const k = w.replace(/仓$/, "").trim().toUpperCase();
        m[w] = locs.find((l) => l.toUpperCase() === k || l.toUpperCase() === w.toUpperCase()) || "";
      }
      setMap(m);
      setParsed(p);
    } catch (e) { setError(`读不了这个档案：${(e as Error).message}`); }
    finally { setBusy(false); }
  }

  const target = (r: ImpRow) => (parsed?.kind === "wms" ? map[r.wh || ""] || "" : loc);
  const used = parsed ? parsed.rows.filter((r) => target(r) !== "") : [];
  const localErr = used.filter((r) => r.err).length;
  // 照仓位分组（一个仓位叫一次）
  const groups = new Map<string, ImpRow[]>();
  for (const r of used) if (!r.err) { const t = target(r); if (!groups.has(t)) groups.set(t, []); groups.get(t)!.push(r); }
  const toApi = (r: ImpRow): BinImportRow => (r.bin ? { item: r.item, qty: r.qty, bin: r.bin } : { item: r.item, qty: r.qty, zone: r.zone, shelf: r.shelf, level: r.level });
  const dbErr = res ? [...res.values()].filter((x) => !x.ok).length : 0;
  const reset = () => { setRes(null); setDone(""); };

  async function run(dry: boolean) {
    setBusy(true); setError(""); setDone("");
    const out = new Map<ImpRow, Res>();
    let nb = 0, saved = 0;
    const doneLocs: string[] = [];
    try {
      for (const [l, rows] of groups) {
        const r = await bins.import(company, l, rows.map(toApi), create, dry);
        rows.forEach((row, i) => { const x = r.rows.find((y) => y.row === i + 1); out.set(row, { ok: !!x?.ok, error: x?.error, item_code: x?.item_code }); });
        nb += Number(r.new_bins) || 0;
        if (r.saved) { saved += rows.length; doneLocs.push(l); }
      }
      setRes(out); setNewBins(nb);
      if (!dry) {
        setDone(`已带入 ${saved} 行（${doneLocs.join("、")}），新建 ${nb} 个货架。`);
        setParsed(null); setFile(""); setRes(null);
        onSaved();
      }
    } catch (e) {
      setError(doneLocs.length ? `${(e as Error).message}（已经带入：${doneLocs.join("、")}）` : (e as Error).message);
      if (!dry) onSaved();
    } finally { setBusy(false); }
  }

  // 有错的排前面（只列前 300 行，错的一定看得到）
  const isBad = (r: ImpRow) => !!r.err || res?.get(r)?.ok === false;
  const shown = (localErr || dbErr ? [...used.filter(isBad), ...used.filter((r) => !isBad(r))] : used).slice(0, SHOW);
  return (
    <div className="bin-import">
      <section className="card">
        <h2>Excel 带入货架数量</h2>
        <p className="muted small">初次设定用：表上每个商品 × 货架的数量会把货架帐「改成」表上的数（不是加上去）。不会动 AutoCount。</p>
        <ul className="muted small bin-howto">
          <li>员工 WMS 的「库存导出」可以直接用：每个「仓」对到一个 AutoCount 仓位；区、层的名称会自动整理（「A区」→ A、「第1层」→ 1）；0 或空白的格子略过。</li>
          <li>或用范本：商品代号 | 区 | 货架 | 层 | 数量（也可以用「货架代号」一栏代替区 / 货架 / 层）。</li>
        </ul>
        <div className="actions left">
          <label className="bin-file">
            <input type="file" accept=".xlsx,.xls,.csv" hidden onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ""; }} />
            <span>{file ? "换一个档案" : "选 Excel / CSV 档案"}</span>
          </label>
          <button className="ghost" type="button" onClick={() => downloadTemplate().catch((e: Error) => setError(e.message))}>下载范本</button>
          {file && <span className="muted small">{file}</span>}
        </div>
        <ErrorBox error={error} />
        {done && <div className="ok">{done}</div>}
        {busy && !parsed && <p className="muted">读取中…</p>}
      </section>

      {parsed && (
        <section className="card">
          <h3>{parsed.kind === "wms" ? "员工 WMS 的库存导出" : "货架数量表"}</h3>
          {parsed.kind === "wms" ? (
            <div className="bin-map">
              <p className="muted small">每个 WMS 的「仓」要放进哪个 AutoCount 仓位？不要的选「略过」。</p>
              {parsed.warehouses.map((w) => (
                <label key={w} className="inline">
                  <span className="bin-map-wh">{w}</span>
                  <select value={map[w] || ""} onChange={(e) => { setMap({ ...map, [w]: e.target.value }); reset(); }}>
                    <option value="">略过</option>
                    {locs.map((l) => <option key={l} value={l}>{l}</option>)}
                  </select>
                </label>
              ))}
            </div>
          ) : (
            <label className="inline">放进哪个仓位
              <select value={loc} onChange={(e) => { setLoc(e.target.value); reset(); }}>
                {locs.map((l) => <option key={l} value={l}>{l}</option>)}
              </select>
            </label>
          )}
          <label className="check"><input type="checkbox" checked={create} onChange={(e) => { setCreate(e.target.checked); reset(); }} /> 没有的货架自动建</label>
          <p className="small">{`共 ${used.length} 行要带入，${groups.size} 个仓位；略过 ${parsed.skipped + (parsed.rows.length - used.length)} 格（0、空白或没选仓位）。`}</p>
          {localErr > 0 && <p className="small late">{`有 ${localErr} 行数量不对或没有货架（标红），请改好 Excel 再选一次档案。`}</p>}
          {res && (dbErr > 0
            ? <p className="small late">{`检查完：有 ${dbErr} 行有错（标红），请改好 Excel 再选一次档案；全部没错才能带入。`}</p>
            : <div className="ok">{`检查完没有错。会新建 ${newBins} 个货架。按「确认带入」才会存。`}</div>)}
          <div className="actions left">
            <button className="ghost" disabled={busy || used.length === 0} onClick={() => run(true)}>{busy ? "检查中…" : "检查"}</button>
            <button disabled={busy || !res || dbErr > 0 || localErr > 0 || used.length === 0} onClick={() => run(false)}>确认带入</button>
          </div>
          {used.length > 0 && (
            <div className="table-wrap flat">
              <table className="bin-imp">
                <thead><tr><th className="num">行</th><th>商品</th><th>仓位</th><th>货架代号</th><th className="num">数量</th><th>结果</th></tr></thead>
                <tbody>
                  {shown.map((r, i) => {
                    const x = res?.get(r);
                    const bad = isBad(r);
                    return (
                      <tr key={i} className={bad ? "bad" : ""}>
                        <td className="num muted">{r.line}</td>
                        <td><b>{x?.item_code || r.item}</b></td>
                        <td>{target(r)}</td>
                        <td>{rowBin(r) || "—"}</td>
                        <td className="num">{Number.isNaN(r.qty) ? "?" : qtyLabel(r.qty)}</td>
                        <td className="small">{r.err ? <span className="late">{r.err}</span> : !x ? "" : x.ok ? <span className="bin-plus">✓</span> : <span className="late">{x.error}</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {used.length > SHOW && <p className="muted small">{`只列前 ${SHOW} 行，其余 ${used.length - SHOW} 行一样会检查、带入。`}</p>}
        </section>
      )}
    </div>
  );
}
