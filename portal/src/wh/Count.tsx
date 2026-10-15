// 仓库 · 盘点：每日小盘点（盲盘）、盘点单、盘点统计（可审批）。路由 #/warehouse/count/<daily|sheets|stats|盘点单编号>
// 盲盘：不符先请再数一次，第二次才记为差异。商品在这个仓位有货架帐时，按货架一格一格数（CountBins）。
import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { go } from "../router";
import { Empty, ErrorBox, Tabs } from "../ui";
import { ScanBox } from "./Scanner";
import { CountBins, CountItem } from "./CountBins";
import { COUNT_STATUS_LABEL, CountList, FoundItem, countClass, qtyLabel, whenLabel, wh } from "../wh-api";
import { CountSaveResult, SheetHome, sheets } from "../wh-sheet-api";
import "../wh-sheet.css";

const SheetsTab = lazy(() => import("./Sheets"));
const SheetDetail = lazy(() => import("./SheetDetail"));
const CountStats = lazy(() => import("./CountStats"));

type View = "daily" | "sheets" | "stats";

export function CountTab({ company, locs, allLocs, arg, canApprove }: {
  company: string; locs: string[]; allLocs?: string[]; arg?: string; canApprove?: boolean;
}) {
  const sheetId = arg && /^\d+$/.test(arg) ? Number(arg) : null;
  const views: [View, string][] = [["daily", "每日盘点"], ["sheets", "盘点单"]];
  if (canApprove) views.push(["stats", "盘点统计"]);
  const view: View = sheetId ? "sheets" : views.some(([k]) => k === arg) ? (arg as View) : "daily";
  return (
    <>
      <div className="filters"><Tabs value={view} options={views} onChange={(k) => go(`/warehouse/count/${k}`)} /></div>
      <Suspense fallback={<p className="muted">载入中…</p>}>
        {sheetId ? <SheetDetail key={sheetId} id={sheetId} company={company} />
          : view === "sheets" ? <SheetsTab company={company} locs={allLocs?.length ? allLocs : locs} canApprove={!!canApprove} />
          : view === "stats" ? <CountStats company={company} locs={allLocs?.length ? allLocs : locs} />
          : <Daily company={company} locs={locs} />}
      </Suspense>
    </>
  );
}

function Daily({ company, locs }: { company: string; locs: string[] }) {
  const [loc, setLoc] = useState(() => { try { return localStorage.getItem("hw-wh-loc") || ""; } catch { return ""; } });
  const [data, setData] = useState<CountList | null>(null);
  const [error, setError] = useState("");
  const [counting, setCounting] = useState<CountItem | null>(null);
  const [notice, setNotice] = useState<[string, string] | null>(null);
  const [found, setFound] = useState<FoundItem[] | null>(null);
  const [mine, setMine] = useState<SheetHome[]>([]);
  const location = locs.includes(loc) ? loc : locs[0] || "";

  const load = useCallback(() => {
    if (!location) return;
    setError("");
    wh.countList(company, location).then(setData).catch((e: Error) => setError(e.message));
  }, [company, location]);
  useEffect(() => { setData(null); load(); }, [load]);
  // 指派给我、还开着的盘点单（失败就不显示，不影响每日盘点）
  useEffect(() => { sheets.home().then((h) => setMine(h.filter((s) => s.company === company && s.left > 0))).catch(() => setMine([])); }, [company]);

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

  function saved(r: CountSaveResult) {
    const c = counting?.code || r.item_code;
    if (r.result === "recount") {
      setNotice(["error", `${c} 跟系统不一样，请再仔细数一次（包括别的货架、坏货、展示品有没有放错）。`]);
    } else {
      setCounting(null);
      setNotice(r.result === "match" ? ["ok", `✓ ${c} 相符。`] : ["error", `${c} 第二次还是不一样，已记录为差异，交给主管审核。`]);
    }
    load();
  }

  if (!locs.length) return <Empty>没有要盘点的仓位。</Empty>;
  const p = data?.progress;
  return (
    <>
      {mine.length > 0 && (
        <section className="card ws-mine">
          <b>指派给你的盘点单</b>
          <ul className="list">
            {mine.map((s) => (
              <li key={s.id} className="click" onClick={() => go(`/warehouse/count/${s.id}`)}>
                <span><b>{s.title}</b>{" "}<span className="muted small">{s.location}</span></span>
                <span className={s.overdue ? "late small nowrap" : "go nowrap"}>{`还有 ${s.left} 项 →`}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <div className="filters">
        <label className="inline ws-fixed">仓位
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
      {counting && <CountBins company={company} location={location} item={counting} onClose={() => setCounting(null)} onSaved={saved} />}
    </>
  );
}
