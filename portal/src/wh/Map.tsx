// 仓库 →「地图」（#/warehouse/map/<仓位>）：每个 AutoCount 仓位一张平面图，一个方块 = 一个货架（所有层）。
// 找商品 → 它在的货架都标起来、放大到最多的那格并闪；点方块看每层放什么。仓库「可审批」在电脑上可以拖拉改排版（放开就存）。
// 参考员工 WMS 的地图（同样的自动排法、方块大小、缩放范围），改用 SVG + 主题颜色；资料在 ops.wh_bin / ops.wh_map（只读 AutoCount）。
import { FormEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { bins, MapData, MapFind, MapRect, MapShelfDetail } from "../wh-bin-api";
import { wh, qtyLabel } from "../wh-api";
import { go } from "../router";
import { Empty, ErrorBox, Tabs } from "../ui";
import { Scanner } from "./Scanner";
import { autoLayout, CanvasApi, MapCanvas } from "./MapCanvas";
import "../wh-map.css";

const RECENT_KEY = "hw-wh-map-recent:";
const PHONE = "(max-width: 767px)";
type Bin = MapFind["bins"][number];

function readRecent(company: string): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY + company) || "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(0, 5) : [];
  } catch { return []; }
}
function decode(s?: string): string {
  try { return s ? decodeURIComponent(s) : ""; } catch { return s || ""; }
}
const zoneText = (zone: string) => (zone ? `${zone}区` : "");
/** 「A区 R1 → 第 2 层 3 件」 */
function binText(b: Bin): string {
  return `${b.zone ? `${b.zone}区 ` : ""}${b.shelf}${b.level ? ` → 第 ${b.level} 层` : ""} ${qtyLabel(b.qty)} 件`;
}

export default function MapTab({ company, loc: urlLoc }: { company: string; loc?: string }) {
  const want = decode(urlLoc);
  const [data, setData] = useState<MapData | null>(null);
  const [rects, setRects] = useState<Record<string, MapRect>>({});
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<MapShelfDetail | null>(null);
  const [detailErr, setDetailErr] = useState("");
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [found, setFound] = useState<MapFind | null>(null);
  const [choices, setChoices] = useState<MapFind[] | null>(null);
  const [msg, setMsg] = useState("");
  const [blink, setBlink] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [recent, setRecent] = useState<string[]>(() => readRecent(company));
  const [edit, setEdit] = useState(false);
  const [save, setSave] = useState("");
  const [mobile, setMobile] = useState(() => window.matchMedia?.(PHONE).matches ?? false);
  const [height, setHeight] = useState(() => Math.max(340, window.innerHeight - 330));
  const canvas = useRef<CanvasApi>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const blinkT = useRef(0);
  const focusAfterLoad = useRef(false);
  const saveQ = useRef<Promise<unknown>>(Promise.resolve());

  // 换公司：全部重来
  useEffect(() => {
    setFound(null); setChoices(null); setMsg(""); setQ(""); setRecent(readRecent(company));
  }, [company]);

  useEffect(() => {
    let live = true;
    setError(""); setSelected(null); setDetail(null); setEdit(false); setSave("");
    bins.map(company, want || null).then((d) => {
      if (!live) return;
      setData(d);
      setRects(autoLayout(d.shelves, d.layout?.shelves));
    }).catch((e: Error) => live && setError(e.message));
    return () => { live = false; };
  }, [company, want]);

  useEffect(() => {
    const mq = window.matchMedia?.(PHONE);
    if (!mq) return;
    const on = () => setMobile(mq.matches);
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);
  useEffect(() => { if (mobile) setEdit(false); }, [mobile]);

  // 地图高度 = 视窗剩下的高度（最少 340）。上面的横幅、「AutoCount 资料更新」出现或消失都要重算
  const hasMap = !!data && data.shelves.length > 0;
  const fitH = useRef(() => {});
  fitH.current = () => {
    const el = wrap.current;
    if (!el) return;
    const top = el.getBoundingClientRect().top + window.scrollY;
    const h = Math.max(340, Math.round(window.innerHeight - top - (mobile ? 16 : 28)));
    setHeight((h0) => (h0 === h ? h0 : h));
  };
  useLayoutEffect(() => fitH.current());
  useEffect(() => {
    const on = () => fitH.current();
    window.addEventListener("resize", on);
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(on) : null;
    ro?.observe(document.body);
    return () => { window.removeEventListener("resize", on); ro?.disconnect(); };
  }, []);

  useEffect(() => () => window.clearInterval(blinkT.current), []);

  const loc = data?.location ?? "";
  const here = useMemo(() => (found ? found.bins.filter((b) => b.location === loc) : []), [found, loc]);
  const marked = useMemo(() => new Set(here.map((b) => `${b.zone}::${b.shelf}`)), [here]);
  const hitBins = useMemo(() => new Set(here.map((b) => b.id)), [here]);
  const zoneIdx = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of data?.shelves ?? []) if (!m.has(s.zone)) m.set(s.zone, m.size % 8);
    return m;
  }, [data]);

  // 搜到的商品放在别的仓位 → 换过去之后再放大
  useEffect(() => {
    if (!focusAfterLoad.current || !data) return;
    focusAfterLoad.current = false;
    if (here.length) window.setTimeout(() => focusOn(here), 50);
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  // 点到的货架：每层放什么
  const selShelf = data?.shelves.find((s) => s.key === selected) ?? null;
  const selRef = useRef(selShelf);
  selRef.current = selShelf;
  // 手机：抽屉打开后，地图上缘卷到上方栏下面（抽屉下面垫了空白，卷得动），点到的货架被抽屉盖住就往上移
  useEffect(() => {
    if (!mobile || !selected || !detail) return;
    const drawer = document.querySelector(".wm-drawer");
    const top = wrap.current?.getBoundingClientRect().top ?? 0;
    if (top > 64) window.scrollBy(0, top - 60);
    if (drawer) canvas.current?.reveal(selected, drawer.getBoundingClientRect().top);
  }, [mobile, selected, detail]);
  useEffect(() => {
    setDetail(null); setDetailErr("");
    if (!selShelf || !loc) return;
    let live = true;
    bins.mapShelf(company, loc, selShelf.zone, selShelf.shelf)
      .then((d) => live && setDetail(d)).catch((e: Error) => live && setDetailErr(e.message));
    return () => { live = false; };
  }, [company, loc, selShelf?.key]); // eslint-disable-line react-hooks/exhaustive-deps

  function startBlink() {
    window.clearInterval(blinkT.current);
    let n = 0;
    setBlink(true);
    blinkT.current = window.setInterval(() => {
      n += 1;
      setBlink(n % 2 === 0 && n < 8);
      if (n >= 8) window.clearInterval(blinkT.current);
    }, 350);
  }
  function focusOn(list: Bin[]) {
    const best = list[0];   // 已经照数量多的排在前面
    const key = `${best.zone}::${best.shelf}`;
    canvas.current?.focus(key, 1.8, !mobile && !selRef.current ? 288 : 0);   // 电脑：右边面板等一下会打开
    setSelected(key);
    startBlink();
  }
  function remember(code: string) {
    const next = [code, ...recent.filter((x) => x !== code)].slice(0, 5);
    setRecent(next);
    try { localStorage.setItem(RECENT_KEY + company, JSON.stringify(next)); } catch { /* 无痕模式存不了就算了 */ }
  }
  function show(it: MapFind) {
    setFound(it); setChoices(null); setMsg("");
    remember(it.item_code);
    const list = it.bins.filter((b) => b.location === loc);
    if (list.length) focusOn(list);
  }
  async function search(text: string) {
    const s = text.trim();
    if (!s || busy) return;
    setBusy(true); setMsg(""); setChoices(null);
    try {
      const list = await bins.mapFind(company, s, null);
      const exact = list.find((x) => x.item_code.toUpperCase() === s.toUpperCase());
      if (exact || list.length === 1) show(exact ?? list[0]);
      else if (list.length > 1) { setFound(null); setChoices(list); }
      else {
        setFound(null);
        const any = await wh.find(company, s).catch(() => []);
        setMsg(any.length ? "这个商品没有放在货架上" : "找不到这个商品");
      }
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function submit(e: FormEvent) { e.preventDefault(); search(q); }
  function clear() {
    focusAfterLoad.current = false;
    setFound(null); setChoices(null); setMsg(""); setQ(""); setSelected(null);
    window.clearInterval(blinkT.current); setBlink(false);
  }
  function switchLoc(l: string) {
    if (l === loc) return;
    focusAfterLoad.current = true;
    go(`/warehouse/map/${encodeURIComponent(l)}`);
  }
  function commit(r: Record<string, MapRect>) {
    if (!data?.location) return;
    setRects(r);
    const shelves: Record<string, MapRect> = {};
    for (const s of data.shelves) if (r[s.key]) shelves[s.key] = r[s.key];
    const layout = { ...data.layout, shelves };
    const at = data.location;
    setSave("储存中…");
    saveQ.current = saveQ.current.then(() => bins.mapSave(company, at, layout))
      .then(() => setSave("已储存"), (e: Error) => setSave(e.message));
  }

  if (error) return <ErrorBox error={error} />;
  if (!data) return <p className="muted">载入中…</p>;
  if (!data.locations.length) {
    return (
      <Empty>
        <p>请先在「货架」建货架。</p>
        {data.can_edit && <button onClick={() => go("/warehouse/bins/list")}>去建货架</button>}
      </Empty>
    );
  }

  // 别的仓位也有：给按钮换过去
  const elsewhere = found ? [...found.bins.filter((b) => b.location !== loc).reduce((m, b) => m.set(b.location, (m.get(b.location) ?? 0) + Number(b.qty)), new Map<string, number>())] : [];
  const tabs: [string, string][] = data.locations.map((l) => [l.location, `${l.location} · ${l.shelves} 个货架`]);

  const panel = selShelf && (
    <aside className={mobile ? "wm-drawer" : "wm-panel"} style={mobile ? undefined : { height }}>
      <div className="wm-panel-head">
        <div>
          <b>{`货架 ${selShelf.shelf}`}</b>
          <small className="muted">{[zoneText(selShelf.zone), `${selShelf.levels.length} 层`, selShelf.qty > 0 ? `${qtyLabel(selShelf.qty)} 件` : ""].filter(Boolean).join(" · ")}</small>
        </div>
        <button className="icon" aria-label="关闭" onClick={() => setSelected(null)}>×</button>
      </div>
      <ErrorBox error={detailErr} />
      {!detail && !detailErr && <p className="muted wm-pad">载入中…</p>}
      {detail?.levels.map((lv) => (
        <div key={lv.id} className={"wm-level" + (hitBins.has(lv.id) ? " hit" : "")}>
          <div className="wm-level-head">
            {hitBins.has(lv.id) && <span aria-hidden>📍</span>}
            <span>{lv.level ? `第 ${lv.level} 层` : "（不分层）"}</span>
            <small className="muted">{lv.code}</small>
            {lv.items.length === 0 && <span className="muted">（空）</span>}
          </div>
          {lv.items.map((it) => (
            <div key={it.item_code} className={"wm-item" + (found?.item_code === it.item_code ? " hit" : "")}>
              <div><b>{it.item_code}</b><small className="muted">{it.description}</small></div>
              <span className="wm-qty">{qtyLabel(it.qty)}<small className="muted">{it.uom ?? ""}</small></span>
            </div>
          ))}
        </div>
      ))}
    </aside>
  );

  return (
    <div className="wm">
      <div className="filters"><Tabs value={loc} options={tabs} onChange={switchLoc} /></div>
      <div className="wm-bar">
        <form className="wm-search" onSubmit={submit}>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="商品代号或品名，按 Enter" enterKeyHint="search" aria-label="找商品" />
          <button disabled={busy}>搜寻</button>
          <button type="button" className="ghost" onClick={() => setScanning(true)}>▦ 扫码</button>
          {(found || choices || msg) && <button type="button" className="ghost" onClick={clear}>清除</button>}
        </form>
        <div className="wm-tools">
          <button type="button" className="ghost small" aria-label="缩小" onClick={() => canvas.current?.zoomStep(-0.2)}>−</button>
          <button type="button" className="ghost small" aria-label="放大" onClick={() => canvas.current?.zoomStep(0.2)}>+</button>
          <button type="button" className="ghost small" onClick={() => canvas.current?.fit()}>置中</button>
          {data.can_edit && !mobile && hasMap && (
            <label className="check wm-edit">
              <input type="checkbox" checked={edit} onChange={(e) => { setEdit(e.target.checked); setSave(""); }} /> 编辑排版
            </label>
          )}
          {save && <small className={save === "已储存" ? "wm-saved" : save === "储存中…" ? "muted" : "wm-err"}>{save}</small>}
        </div>
      </div>
      {recent.length > 0 && (
        <div className="wm-recent">
          <small className="muted">最近：</small>
          {recent.map((c) => <button key={c} type="button" className="ghost small" onClick={() => { setQ(c); search(c); }}>{c}</button>)}
        </div>
      )}
      {msg && <div className="wm-msg">{msg}</div>}
      {choices && (
        <div className="wm-choices">
          <p>{`找到 ${choices.length} 个商品，请选一个：`}</p>
          {choices.map((it) => (
            <button key={it.item_code} type="button" className="ghost" onClick={() => show(it)}>
              <b>{it.item_code}</b> <span className="muted">{it.description}</span> <small>{`${it.bins.length} 个货架`}</small>
            </button>
          ))}
        </div>
      )}
      {found && here.length > 0 && <div className="wm-found">{`📍 找到 ${found.item_code}：${here.map(binText).join("；")}`}</div>}
      {found && here.length === 0 && elsewhere.length > 0 && <div className="wm-msg">{`${found.item_code} 不在 ${loc} 的货架上，在别的仓位：`}</div>}
      {found && elsewhere.length > 0 && (
        <div className="wm-recent">
          {here.length > 0 && <small className="muted">别的仓位也有：</small>}
          {elsewhere.map(([l, n]) => <button key={l} type="button" className="small" onClick={() => switchLoc(l)}>{`${l}（${qtyLabel(n)} 件）`}</button>)}
        </div>
      )}
      <div ref={wrap} className="wm-body">
        {hasMap ? (
          <MapCanvas key={loc} ref={canvas} location={loc} shelves={data.shelves} rects={rects} zoneIdx={zoneIdx} height={height}
                     selected={selected} marked={marked} blink={blink} edit={edit} mobile={mobile}
                     onSelect={setSelected} onRects={setRects} onCommit={commit} />
        ) : (
          <Empty>{`${loc} 还没有货架。`}</Empty>
        )}
        {panel}
      </div>
      {mobile && panel && <div className="wm-drawer-space" />}
      {scanning && <Scanner title="扫商品条码" onClose={() => setScanning(false)} onCode={(c) => { setScanning(false); setQ(c); search(c); }} />}
    </div>
  );
}
