// 仓库 · 货架 · 上架 / 拿下 / 移货架（手机优先）。先选仓位 → 扫商品（或扫货架）→ 点货架 → 数量 → 确认。
// 上架后货架合计比系统应有多 → 先问一次（need_confirm）。这次开网页做的动作列在下面，可以撤销（ops_wh_bin_undo 照纪录冲回）。
// 网址 ?item=&loc=&mode= 带进来的仓位 / 动作优先（mode 不写回 localStorage）。
import { useEffect, useRef, useState } from "react";
import { Empty, ErrorBox, Modal } from "../ui";
import { FoundItem, qtyLabel, wh } from "../wh-api";
import { Bin, BinDetail, BinOp, BinOpKind, BinRow, bins, ItemBins, isBinCode } from "../wh-bin-api";
import { ScanBox } from "./Scanner";
import { rememberLoc } from "./binLoc";

interface Recent {
  id: number; company: string; op: BinOp; prev: number; item: string; desc: string; loc: string;
  from?: string; to?: string; undone: boolean;
  /** ops_wh_bin_op 回传的动作编号（撤销用） */ ref?: number;
}
// 这次开网页做的动作（换分页再回来还在；重新整理就清掉）
const RECENT: Recent[] = [];
let seq = 0;

const MODE_LABEL: Record<BinOpKind, string> = { putaway: "上架", take: "拿下", move: "移货架", adjust: "改数" };
const SUBMIT_LABEL: Record<BinOpKind, string> = { putaway: "确认上架", take: "确认拿下", move: "确认移货架", adjust: "确认改数" };

export function recentText(r: Recent): string {
  const q = qtyLabel(r.op.qty);
  switch (r.op.kind) {
    case "putaway": return `上架 ${r.item} × ${q} → ${r.to}`;
    case "take": return `拿下 ${r.item} × ${q} ← ${r.from}`;
    case "move": return `移货架 ${r.item} × ${q}：${r.from} → ${r.to}`;
    default: return `改数 ${r.item}：${r.to} ${qtyLabel(r.prev)} → ${q}`;
  }
}

export function BinOps({ company, canApprove, binLocs, all, item, loc: locParam, mode: modeParam, onChanged }: {
  company: string; canApprove: boolean; binLocs: string[]; all: BinRow[];
  /** 网址带进来的商品（?item=）、仓位（?loc=）与动作（?mode=putaway|take|move|adjust） */ item: string; loc: string; mode: string;
  onChanged: () => void;
}) {
  const [loc, setLoc] = useState(() => {
    const want = locParam || rememberLoc(company);
    return binLocs.includes(want) ? want : binLocs[0] || "";
  });
  const [mode, setModeState] = useState<BinOpKind>(() => {
    const ok = (m: string | null): m is BinOpKind => !!m && m in MODE_LABEL && (m !== "adjust" || canApprove);
    // 网址指定的动作优先（例：对不上清单、批次页的「上架」），不写回 localStorage
    if (ok(modeParam)) return modeParam;
    try { const m = localStorage.getItem("hw-bin-mode"); return ok(m) ? m : "putaway"; }
    catch { return "putaway"; }
  });
  const [it, setIt] = useState<ItemBins | null>(null);
  const [found, setFound] = useState<FoundItem[] | null>(null);
  const [binView, setBinView] = useState<BinDetail | null>(null);
  const [from, setFrom] = useState<Bin | null>(null);
  const [to, setTo] = useState<Bin | null>(null);
  const [slot, setSlot] = useState<"from" | "to">("from");
  const [qty, setQty] = useState("");
  const [note, setNote] = useState("");
  const [ask, setAsk] = useState<{ expected: number; shelved: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  // 只列这间公司的（分店 ALL 的人可以换公司）
  const mine = () => RECENT.filter((r) => r.company === company);
  const [recent, setRecent] = useState<Recent[]>(mine);
  const qtyRef = useRef<HTMLInputElement>(null);
  // 送出中就不再送（数量栏连按 Enter 不会登记两次；setBusy 要等下一次 render）
  const inFlight = useRef(false);

  const L = it?.locations.find((l) => l.location === loc);
  const expected = Number(L?.expected ?? 0);
  const shelved = Number(L?.shelved ?? 0);
  // 货架比系统多时未上架是负的：显示 0（多出来的由红字提示）
  const unshelved = Math.max(0, Number(L?.unshelved ?? 0));
  const doWait = Number(L?.do_unpicked ?? 0);
  const itemBins = (L?.bins ?? []).filter((b) => b.active);
  const others = all.filter((b) => b.location === loc && b.active && !itemBins.some((x) => x.id === b.id));
  const qtyOn = (b: Bin | null) => Number(itemBins.find((x) => x.id === b?.id)?.qty ?? 0);

  /** 上架的预填数量 = 这个仓位的未上架 */
  const preQty = (d: ItemBins | null, l: string, m: BinOpKind) => {
    const u = Math.max(0, Number(d?.locations.find((x) => x.location === l)?.unshelved ?? 0));
    return m === "putaway" && u > 0 ? qtyLabel(u) : "1";
  };

  function changeLoc(l: string) {
    setLoc(l); rememberLoc(company, l);
    setFrom(null); setTo(null); setSlot("from"); setBinView(null);
    if (it) setQty(preQty(it, l, mode));
  }
  function setMode(m: BinOpKind) {
    setModeState(m);
    try { localStorage.setItem("hw-bin-mode", m); } catch { /* 忽略 */ }
    setFrom(null); setTo(null); setSlot("from"); setNote(""); setAsk(null);
    setQty(preQty(it, loc, m));
  }

  /** 选货架：照目前的动作放进「从」或「到」 */
  function pickBin(b: Bin, d: ItemBins | null = it, s: "from" | "to" = slot) {
    setError("");
    if (mode === "take") setFrom(b);
    else if (mode === "move") {
      if (s === "from") { if (b.id === to?.id) setTo(null); setFrom(b); setSlot("to"); }
      else if (b.id === from?.id) { setError("「从」和「到」是同一个货架。"); return; }
      else setTo(b);
    } else setTo(b);
    if (mode === "adjust") {
      const l = d?.locations.find((x) => x.location === loc);
      setQty(qtyLabel(Number(l?.bins.find((x) => x.id === b.id)?.qty ?? 0)));
    }
    // 选好货架就跳到数量；使用者已经点到别的输入框就不抢
    const was = document.activeElement;
    setTimeout(() => { if (document.activeElement === was || document.activeElement === document.body) qtyRef.current?.focus(); }, 50);
  }

  function loadItem(d: ItemBins, preBin?: Bin | null) {
    setIt(d); setFound(null); setBinView(null); setAsk(null);
    setFrom(null); setTo(null); setSlot("from"); setNote("");
    setQty(preQty(d, loc, mode));
    if (preBin) pickBin(preBin, d, "from");
  }

  /** 扫到 / 打的货架（BIN:<编号>）：没选商品 → 看这个货架上有什么（不同仓位就换过去）；有商品 → 当成要用的货架 */
  async function openBin(code: string) {
    const b = await bins.get(company, code, it ? loc : undefined);
    if (!b.active) { setError(`货架 ${b.code} 已经停用。`); return; }
    if (!it) {
      if (b.location !== loc && binLocs.includes(b.location)) changeLoc(b.location);
      setBinView(b);
      return;
    }
    pickBin(b);
  }

  async function scan(code: string) {
    setError(""); setDone(""); setFound(null);
    setBusy(true);
    try {
      if (isBinCode(code)) { await openBin(code); return; }
      // 打的货架代号（例 A-R1-2）：先找这个仓位；还没选商品时别的仓位也找
      const up = code.trim().toUpperCase();
      const hit = all.find((b) => b.active && b.location === loc && b.code === up) ?? (it ? undefined : all.find((b) => b.active && b.code === up));
      if (hit) { await openBin(hit.barcode); return; }
      const pre = binView;
      try { loadItem(await bins.item(company, code), pre); return; } catch { /* 不是商品代号 / 纸箱条码：当品名找 */ }
      const f = await wh.find(company, code);
      if (f.length === 1) loadItem(await bins.item(company, f[0].item_code), pre);
      else if (f.length === 0) setError(`找不到「${code}」。`);
      else setFound(f);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  // 网址带商品进来（查货、对不上清单的「上架」）
  useEffect(() => {
    if (item) bins.item(company, item).then((d) => loadItem(d)).catch((e: Error) => setError(e.message));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function refreshItem(code: string) {
    try { const d = await bins.item(company, code); setIt((cur) => (cur && cur.item_code === code ? d : cur)); } catch { /* 忽略 */ }
  }

  const q = Number(qty);
  const qtyOk = qty.trim() !== "" && Number.isFinite(q) && (mode === "adjust" ? q >= 0 : q > 0);
  const binsOk = mode === "move" ? !!from && !!to : mode === "take" ? !!from : !!to;
  const noteOk = mode !== "adjust" || note.trim() !== "";
  const missing = !it ? "" : !binsOk ? (mode === "move" ? "请选「从货架」与「到货架」（点下面的货架或扫货架条码）。" : "请点下面的货架，或扫货架条码。")
    : !qtyOk ? "请填数量。" : !noteOk ? "改数请写原因。" : "";

  async function submit(confirm = false) {
    if (!it || missing || inFlight.current) return;
    inFlight.current = true;
    const op: BinOp = { kind: mode, item: it.item_code, qty: q, location: loc, note: note.trim() };
    if (mode === "move") { op.from_bin = from!.barcode; op.to_bin = to!.barcode; }
    else op.bin = (mode === "take" ? from : to)!.barcode;
    const prev = mode === "adjust" ? qtyOn(to) : 0;
    setBusy(true); setError(""); setDone("");
    try {
      const r = await bins.op(company, op, confirm);
      if (r.need_confirm) { setAsk({ expected: Number(r.expected), shelved: Number(r.shelved) }); return; }
      const rec: Recent = { id: ++seq, company, op, prev, item: it.item_code, desc: it.description, loc, from: from?.code, to: to?.code, undone: false, ref: r.ref_id };
      RECENT.unshift(rec);
      if (RECENT.length > 50) RECENT.pop();
      setRecent(mine());
      setDone(recentText(rec));
      setAsk(null); setNote(""); setFrom(null); setTo(null); setSlot("from");
      setQty(mode === "putaway" ? "" : "1");
      await refreshItem(it.item_code);
      onChanged();
    } catch (e) { setError((e as Error).message); setAsk(null); }
    finally { inFlight.current = false; setBusy(false); }
  }

  /** 撤销 = 资料库照这个动作的纪录反向冲回（不会盖掉这段时间别人做的变动；货架上已经不够的扣到 0） */
  async function undo(r: Recent) {
    if (r.ref == null || inFlight.current) return;
    inFlight.current = true;
    setBusy(true); setError(""); setDone("");
    try {
      await bins.undo(r.company, r.ref);
      r.undone = true;
      setRecent(mine());
      if (it?.item_code === r.item) await refreshItem(r.item);
      onChanged();
    } catch (e) {
      const msg = (e as Error).message;
      // 别的分页已经撤销过：标成已撤销
      if (msg === "这个动作已经撤销过了。") { r.undone = true; setRecent(mine()); }
      setError(msg);
    } finally { inFlight.current = false; setBusy(false); }
  }

  if (!binLocs.length) return <Empty>还没有货架。请主管在「货架清单」建货架，或用「Excel 带入」。</Empty>;

  const modes: BinOpKind[] = canApprove ? ["putaway", "take", "move", "adjust"] : ["putaway", "take", "move"];
  const binBtn = (b: Bin & { qty?: number }, inList: boolean) => {
    const n = Number(b.qty ?? 0);
    const sel = b.id === from?.id || b.id === to?.id;
    const off = inList && n <= 0 && (mode === "take" || (mode === "move" && slot === "from"));
    return (
      <button key={b.id} type="button" className={"bin-btn" + (sel ? " on" : "") + (n > 0 ? "" : " zero")} disabled={off || busy}
              onClick={() => pickBin(b)}>
        <b>{b.code}</b>
        {inList && (n > 0 ? <span>{`× ${qtyLabel(n)}`}</span> : <span className="small">平常放这里</span>)}
      </button>
    );
  };

  return (
    <div className="bin-ops">
      <div className="filters">
        <label className="inline bin-loc">仓位
          <select value={loc} onChange={(e) => changeLoc(e.target.value)}>
            {binLocs.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
        </label>
        <div className="bin-modes" role="group">
          {modes.map((m) => <button key={m} type="button" className={m === mode ? "on" : ""} onClick={() => setMode(m)}>{MODE_LABEL[m]}</button>)}
        </div>
      </div>
      {mode === "move" && <p className="muted small bin-mode-note">移货架：同一个仓位里，从一个货架搬到另一个货架。搬到别的仓位请用「搬动」。</p>}
      <ScanBox onCode={scan} busy={busy} placeholder="扫商品或货架条码，或打代号 / 品名" />
      <ErrorBox error={error} />
      {done && <div className="ok"><b>已登记</b>{" "}<span>{done}</span></div>}
      {found && (
        <>
          <p className="muted small">{`找到 ${found.length} 项，点要的那一项：`}</p>
          <ul className="list card wh-found">
            {found.map((f) => (
              <li key={f.item_code} className="click" onClick={() => { setFound(null); scan(f.item_code); }}>
                <span><b>{f.item_code}</b>{" "}<span className="muted small">{f.description}</span></span>
                <span className="muted small nowrap">{f.uom}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      {binView && !it && (
        <section className="card bin-card">
          <div className="bin-card-head">
            <h2>{binView.code}</h2>
            <span className="muted">{binView.location}</span>
            <button className="ghost small" onClick={() => setBinView(null)}>清除</button>
          </div>
          <p className="muted small">{mode === "putaway" ? "接着扫要放上这个货架的商品；或点下面的商品。" : "点要处理的商品，或扫商品条码。"}</p>
          {binView.items.length === 0 ? <p className="muted">这个货架是空的。</p> : (
            <ul className="list">
              {binView.items.map((x) => (
                <li key={x.item_code} className="click" onClick={() => { setBusy(true); bins.item(company, x.item_code).then((d) => loadItem(d, binView)).catch((e: Error) => setError(e.message)).finally(() => setBusy(false)); }}>
                  <span><b>{x.item_code}</b>{" "}<span className="muted small">{x.description}</span></span>
                  <span className="nowrap">{Number(x.qty) > 0 ? qtyLabel(x.qty) : <span className="muted small">平常放这里</span>}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {it && (
        <section className="card bin-card">
          <div className="bin-card-head">
            <h2>{it.item_code}</h2>
            <button className="ghost small" onClick={() => { setIt(null); setFrom(null); setTo(null); }}>清除</button>
          </div>
          <p className="muted">{it.description}</p>
          <div className={"bin-stats" + (doWait > 0 ? " four" : "")}>
            <div><span>应有</span><b>{qtyLabel(expected)}</b></div>
            <div><span>货架合计</span><b className={shelved > Math.max(expected, 0) ? "late" : ""}>{qtyLabel(shelved)}</b></div>
            <div><span>未上架</span><b className={unshelved > 0 ? "amber" : ""}>{qtyLabel(unshelved)}</b></div>
            {doWait > 0 && <div title="已开 DO、还没备的（AutoCount 已经扣了，货还在货架上），已经算进应有"><span>DO 待备</span><b>{qtyLabel(doWait)}</b></div>}
          </div>
          {shelved > Math.max(expected, 0) && (
            <p className="small late">{doWait > 0 ? "货架合计比系统应有多，但有 DO 还没备：备完还多再去盘点。" : "货架合计比系统应有多：请去盘点这个商品。"}</p>
          )}

          {mode === "move" && (
            <div className="bin-slots">
              <button type="button" className={"bin-slot" + (slot === "from" ? " on" : "")} onClick={() => setSlot("from")}>
                <span>从货架</span><b>{from ? from.code : "—"}</b>
              </button>
              <span className="bin-arrow">→</span>
              <button type="button" className={"bin-slot" + (slot === "to" ? " on" : "")} onClick={() => setSlot("to")}>
                <span>到货架</span><b>{to ? to.code : "—"}</b>
              </button>
            </div>
          )}

          <h3>{itemBins.length ? "有这个商品的货架" : "这个仓位还没有货架放这个商品"}</h3>
          {itemBins.length > 0 && <div className="bin-btns">{itemBins.map((b) => binBtn(b, true))}</div>}
          {others.length > 0 && mode !== "take" && !(mode === "move" && slot === "from") && (
            <label className="bin-other">别的货架
              <select value="" onChange={(e) => { const b = others.find((x) => String(x.id) === e.target.value); if (b) pickBin(b); }}>
                <option value="">选货架…</option>
                {others.map((b) => <option key={b.id} value={b.id}>{b.code}</option>)}
              </select>
            </label>
          )}

          {(from || to) && mode !== "move" && (
            <p className="bin-target">
              <span className="muted">{mode === "take" ? "从货架" : mode === "adjust" ? "改数的货架" : "到货架"}</span>{" "}<b>{(mode === "take" ? from : to)?.code}</b>
              {mode !== "putaway" && <span className="muted small">{` · 现在 ${qtyLabel(qtyOn(mode === "take" ? from : to))}`}</span>}
            </p>
          )}

          <div className="bin-form">
            <label>{mode === "adjust" ? "改成几件" : "数量"}
              <input ref={qtyRef} className="big-num" type="number" inputMode="decimal" min="0" step="any" value={qty}
                     onChange={(e) => setQty(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !busy) submit(); }} />
            </label>
            {(mode === "take" || mode === "move") && from && qtyOn(from) > 0 && (
              <button type="button" className="ghost" onClick={() => setQty(qtyLabel(qtyOn(from)))}>{`全部（${qtyLabel(qtyOn(from))}）`}</button>
            )}
            {mode === "putaway" && unshelved > 0 && (
              <button type="button" className="ghost" onClick={() => setQty(qtyLabel(unshelved))}>{`未上架的全部（${qtyLabel(unshelved)}）`}</button>
            )}
          </div>
          <label>{mode === "adjust" ? "原因（一定要写）" : "备注（可不填）"}
            <input value={note} maxLength={300} onChange={(e) => setNote(e.target.value)}
                   placeholder={mode === "adjust" ? "例：实际数过是 5 件" : ""} />
          </label>
          {missing && <p className="muted small">{missing}</p>}
          <div className="actions">
            <button className="bin-submit" disabled={busy || !!missing} onClick={() => submit()}>{busy ? "储存中…" : SUBMIT_LABEL[mode]}</button>
          </div>
        </section>
      )}

      {!it && !binView && !found && <p className="muted small">扫商品条码（或打代号），再点要放的货架；也可以先扫货架条码再扫商品。货架条码在「货架清单」印。</p>}

      {recent.length > 0 && (
        <>
          <h2 className="section-title">刚刚做的（这次开网页）</h2>
          <ul className="list card bin-recent">
            {recent.map((r) => (
              <li key={r.id} className={r.undone ? "undone" : ""}>
                <span><span className="muted small">{r.loc}</span>{" "}<span>{recentText(r)}</span></span>
                {r.undone ? <span className="muted small nowrap">已撤销</span>
                  : r.ref != null && <button className="ghost small" disabled={busy} onClick={() => undo(r)}>撤销</button>}
              </li>
            ))}
          </ul>
        </>
      )}

      {ask && (
        <Modal title="货架合计会比系统多" onClose={() => setAsk(null)}>
          <p>{mode === "adjust" ? `改数后货架合计 ${qtyLabel(ask.shelved)} 会比系统应有 ${qtyLabel(ask.expected)} 多，确定？`
            : `上架后货架合计 ${qtyLabel(ask.shelved)} 会比系统应有 ${qtyLabel(ask.expected)} 多，确定？`}</p>
          <p className="muted small">可能是 AutoCount 还没输入进货或调仓，或数量打错了。确定的话照样存，这个商品会出现在「对不上」清单。</p>
          <div className="actions">
            <button className="ghost" onClick={() => setAsk(null)}>取消</button>
            <button disabled={busy} onClick={() => submit(true)}>照样存</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
