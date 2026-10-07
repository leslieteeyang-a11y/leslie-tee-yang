// 仓库 · 每日小盘点（盲盘）：不符先请再数一次，第二次才记为差异。
import { FormEvent, useCallback, useEffect, useState } from "react";
import { Empty, ErrorBox, Modal } from "../ui";
import { ScanBox } from "./Scanner";
import { COUNT_STATUS_LABEL, CountList, FoundItem, countClass, qtyLabel, whenLabel, wh } from "../wh-api";

export function CountTab({ company, locs }: { company: string; locs: string[] }) {
  const [loc, setLoc] = useState(() => { try { return localStorage.getItem("hw-wh-loc") || ""; } catch { return ""; } });
  const [data, setData] = useState<CountList | null>(null);
  const [error, setError] = useState("");
  const [counting, setCounting] = useState<{ code: string; desc: string; uom: string; recount?: boolean } | null>(null);
  const [notice, setNotice] = useState<[string, string] | null>(null);
  const [found, setFound] = useState<FoundItem[] | null>(null);
  const location = locs.includes(loc) ? loc : locs[0] || "";

  const load = useCallback(() => {
    if (!location) return;
    setError("");
    wh.countList(company, location).then(setData).catch((e: Error) => setError(e.message));
  }, [company, location]);
  useEffect(() => { setData(null); load(); }, [load]);

  async function scan(code: string) {
    setNotice(null); setError("");
    try {
      setFound(null);
      let d = await wh.item(company, code);
      if (!d.found) {
        // 不是完整代号 / 条码：当成品名或部分代号搜寻，一笔就直接盘，多笔列出来让同事点
        const f = await wh.find(company, code);
        if (f.length === 0) { setError(`找不到「${code}」。试试打品名的一部分，或到「查货」把纸箱条码绑定到商品。`); return; }
        if (f.length > 1) { setFound(f); return; }
        d = await wh.item(company, f[0].item_code);
        if (!d.found) return;
      }
      setCounting({ code: d.item_code, desc: d.description, uom: d.uom, recount: data?.recount.includes(d.item_code) });
    } catch (e) { setError((e as Error).message); }
  }

  if (!locs.length) return <Empty>没有要盘点的仓位。</Empty>;
  const p = data?.progress;
  return (
    <>
      <div className="filters">
        <label className="inline">仓位
          <select value={location} onChange={(e) => { setLoc(e.target.value); try { localStorage.setItem("hw-wh-loc", e.target.value); } catch { /* 忽略 */ } }}>
            {locs.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
        </label>
        {p && <span className="muted small">{`近 30 天已盘 ${p.counted_30d} / ${p.items} 个商品`}</span>}
      </div>
      <ScanBox onCode={scan} placeholder="扫码，或打商品代号 / 品名" />
      {found && (
        <>
          <p className="muted small">{`找到 ${found.length} 项，点要盘的那一项：`}</p>
          <ul className="list wh-found">
            {found.map((f) => (
              <li key={f.item_code} className="click" onClick={() => { setFound(null); scan(f.item_code); }}>
                <span><b>{f.item_code}</b>{" "}<span className="muted small">{f.description}</span></span>
                <span className="muted small nowrap">{f.uom}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <ErrorBox error={error} />
      {notice && <div className={notice[0]}>{notice[1]}</div>}
      {!data ? (!error && <p className="muted">载入中…</p>) : (
        <>
          {data.recount.length > 0 && (
            <section className="card warn-card">
              <b>要再数一次</b>
              <ul className="list">{data.recount.map((c) => <li key={c} className="click" onClick={() => scan(c)}><span>{c}</span><span className="late">再数 →</span></li>)}</ul>
            </section>
          )}
          <h2 className="section-title">{`今天要盘（${data.todo.length}）`}</h2>
          {data.todo.length === 0 ? <Empty>这个仓位今天的都盘完了，或 30 天内都盘过了。</Empty> : (
            <ul className="list card wh-todo">
              {data.todo.map((t) => (
                <li key={t.item_code} className="click" onClick={() => setCounting({ code: t.item_code, desc: t.description, uom: t.uom })}>
                  <span><b>{t.item_code}</b>{" "}<span className="muted small">{t.description}</span></span>
                  <span className="go">盘 →</span>
                </li>
              ))}
            </ul>
          )}
          <p className="muted small">系统每天挑一批：库存是负数的先盘，然后是卖得快、值钱的；30 天内盘过的不会再出现。看不到系统数量是故意的（盲盘），照实际数到的填。最好在早上开工前或同步之后马上盘。</p>
          {data.done_today.length > 0 && (
            <>
              <h2 className="section-title">{`今天已盘（${data.done_today.length}）`}</h2>
              <ul className="list card">
                {data.done_today.map((c) => (
                  <li key={c.id}><span><b>{c.item_code}</b>{` 数到 ${qtyLabel(c.qty)} ${c.uom || ""}`}{" "}<span className="muted small">{`${whenLabel(c.counted_at)} · ${c.counted_by_name}`}</span></span>
                    <span className={"ap " + countClass(c)}>{c.status === "variance" && c.attempt === 1 ? "要再数" : COUNT_STATUS_LABEL[c.status]}</span></li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
      {counting && (
        <CountForm company={company} location={location} item={counting} onClose={() => setCounting(null)}
                   onSaved={(r) => {
                     if (r === "recount") {
                       setCounting({ ...counting, recount: true });
                       setNotice(["error", `${counting.code} 跟系统不一样，请再仔细数一次（包括别的货架、坏货、展示品有没有放错）。`]);
                     } else {
                       setCounting(null);
                       setNotice(r === "match" ? ["ok", `✓ ${counting.code} 相符。`] : ["error", `${counting.code} 第二次还是不一样，已记录为差异，交给主管审核。`]);
                     }
                     load();
                   }} />
      )}
    </>
  );
}

function CountForm({ company, location, item, onClose, onSaved }: {
  company: string; location: string; item: { code: string; desc: string; uom: string; recount?: boolean };
  onClose: () => void; onSaved: (r: "match" | "recount" | "variance") => void;
}) {
  const [qty, setQty] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { setQty(""); setNote(""); setBusy(false); }, [item.recount]);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError("");
    try {
      const r = await wh.saveCount({ company, location, item_code: item.code, qty, note });
      onSaved(r.result);
    } catch (err) { setError((err as Error).message); setBusy(false); }
  }
  return (
    <Modal title={item.recount ? `再数一次 · ${location}` : `盘点 · ${location}`} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <p><b>{item.code}</b><br /><span className="muted">{item.desc}</span></p>
        {item.recount && <p className="late small">第一次数的跟系统不一样，请再仔细数一次。</p>}
        <label>{`实际数到几${item.uom ? `（${item.uom}）` : ""}`}
          <input className="big-num" type="number" inputMode="decimal" min="0" step="any" value={qty} autoFocus
                 onChange={(e) => setQty(e.target.value)} required /></label>
        <label>备注（选填）<input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="例：2 箱压坏、1 件在展示区" /></label>
        <ErrorBox error={error} />
        <div className="actions">
          <button type="button" className="ghost" onClick={onClose}>取消</button>
          <button disabled={busy || qty === ""}>{busy ? "储存中…" : "确认"}</button>
        </div>
      </form>
    </Modal>
  );
}

