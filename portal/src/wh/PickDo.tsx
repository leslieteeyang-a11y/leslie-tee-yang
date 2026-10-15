// 仓库 · 照一张 DO 拣货（手机优先）：扫货架条码 = 换「目前货架」；扫商品 = 记拣货（有目前货架就从那个货架扣）。
// 扫对绿闪 + 高音；扫错 / 扫太多 / 货架不够红闪 + 震动（资料库什么都不存）。对不到商品的行可以扫商品指定、手动确认或略过。
// 蓝牙扫描枪扫得很快：扫到的码排队一个一个送，不会漏掉；货架条码排在前面的，后面的商品就从那个货架扣。
import { useCallback, useEffect, useRef, useState } from "react";
import { todayKL } from "../api";
import { getLang, tr } from "../i18n";
import { ErrorBox } from "../ui";
import { bins as binApi, isBinCode } from "../wh-bin-api";
import { qtyLabel, whenLabel } from "../wh-api";
import { beep, buzz, MATCH_LABEL, pick, PICK_STATUS_LABEL, PickBin, PickDoc, PickLine, PickScan, runLabel, ScanResult } from "../wh-pick-api";
import { ScanBox } from "./Scanner";
import { BinShortModal, CancelModal, DoneModal, ManualModal, SkipModal } from "./PickModals";
import "../wh-pick.css";

type Bin = { barcode: string; label: string };
/** bin：这一笔指定的货架（货架不够时改选的）；noBin：这一笔不从货架扣 */
type Job = { code: string; qty: number; line: number | null; noBin?: boolean; bin?: string };
const ui = (s: string) => (getLang() === "en" ? tr(s) : s);

export function PickDo({ company, docNo }: { company: string; docNo: string }) {
  const [d, setD] = useState<PickDoc | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [bin, setBinState] = useState<Bin | null>(null);
  const [qty, setQty] = useState("1");
  const [assign, setAssign] = useState<PickLine | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [flash, setFlash] = useState<{ ok: boolean; n: number } | null>(null);
  const [hit, setHit] = useState<number | null>(null);
  const [manual, setManual] = useState<PickLine | null>(null);
  const [skip, setSkip] = useState<PickLine | null>(null);
  const [doneOpen, setDoneOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [binShort, setBinShort] = useState<(Job & { message: string; bins: PickBin[] }) | null>(null);
  const flashN = useRef(0);
  const binRef = useRef<Bin | null>(null);
  const pickId = useRef<number | null>(null);
  const queue = useRef<Job[]>([]);
  const running = useRef(false);
  pickId.current = d?.pick?.status === "picking" ? d.pick.id : null;
  const setBin = (b: Bin | null) => { binRef.current = b; setBinState(b); };

  const load = useCallback(() => {
    setError("");
    return pick.get(company, docNo).then(setD).catch((e: Error) => setError(e.message));
  }, [company, docNo]);
  useEffect(() => { load(); }, [load]);

  function signal(ok: boolean, text: string) {
    setResult({ ok, text });
    setFlash({ ok, n: ++flashN.current });
    beep(ok); buzz(ok);
  }
  /** 扫码 / 手动确认 / 撤销之后：只换那一行、加那一笔，不重新载入整张 */
  function apply(r: ScanResult) {
    setD((cur) => {
      if (!cur) return cur;
      const lines = r.line ? cur.lines.map((l) => (l.id === r.line!.id ? r.line! : l)) : cur.lines;
      let scans = cur.scans;
      if (r.scan) scans = scans.some((s) => s.id === r.scan!.id) ? scans.map((s) => (s.id === r.scan!.id ? r.scan! : s)) : [r.scan, ...scans];
      return { ...cur, lines, scans, pick: r.pick ?? cur.pick };
    });
    if (r.line?.id) setHit(r.line.id);
  }

  function onCode(code: string) {
    if (!pickId.current) return;
    queue.current.push({ code, qty: Number(qty) > 0 ? Number(qty) : 1, line: assign?.id ?? null });
    setQty("1");
    drain();
  }
  async function drain() {
    if (running.current) return;
    running.current = true; setBusy(true);
    try {
      while (queue.current.length) await run(queue.current.shift()!);
    } finally { running.current = false; setBusy(false); }
  }
  async function run(j: Job) {
    const id = pickId.current;
    if (!id) return;
    try {
      if (isBinCode(j.code)) {
        const b = await binApi.get(company, j.code);
        if (!b.active) { signal(false, `货架 ${b.code} 已经停用，请换一个货架。`); return; }
        setBin({ barcode: b.barcode, label: `${b.location} · ${b.code}` });
        signal(true, `目前货架：${b.location} · ${b.code}`);
        return;
      }
      const r = await pick.scan({ pick_id: id, code: j.code, qty: j.qty, bin: j.noBin ? null : j.bin ?? binRef.current?.barcode ?? null, line_id: j.line });
      if (r.ok) {
        apply(r);
        if (j.line != null) setAssign(null);
        const where = r.scan?.bin ? `（${r.scan.bin}）` : "";
        signal(true, r.done_all ? `✓ ${r.scan?.item_code} × ${qtyLabel(j.qty)}${where} — 全部拣好了，按「已拣好」完成。`
                                : `✓ ${r.scan?.item_code} × ${qtyLabel(j.qty)}${where}`);
      } else {
        signal(false, r.message || "扫错了");
        if (r.code === "bin_short") setBinShort({ ...j, message: r.message || "", bins: r.bins || [] });
      }
    } catch (e) { signal(false, (e as Error).message); }
  }

  async function undo(s: PickScan) {
    if (!window.confirm(ui("撤销这笔扫码？从货架扣的会加回去。"))) return;
    try { apply(await pick.undo(s.id)); setResult({ ok: true, text: `已撤销：${s.item_code || "#" + s.line_no} × ${qtyLabel(s.qty)}` }); }
    catch (e) { setError((e as Error).message); }
  }
  async function unskip(l: PickLine) {
    try { apply(await pick.lineSet({ pick_id: d!.pick!.id, line_id: l.id!, action: "unskip" })); }
    catch (e) { setError((e as Error).message); }
  }
  async function finish() {
    if (!d?.pick) return;
    if (d.lines.some((l) => !l.done)) { setDoneOpen(true); return; }
    setBusy(true);
    try { setD(await pick.done({ pick_id: d.pick.id })); setResult(null); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function start() {
    setBusy(true); setError("");
    try { setD(await pick.start(company, d!.doc_no)); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function reopen() {
    if (!d?.pick || !window.confirm(ui("重新打开这张拣货单？之后要再按一次「已拣好」。"))) return;
    try { setD(await pick.reopen(d.pick.id)); } catch (e) { setError((e as Error).message); }
  }

  if (!d) return (<><a className="pick-back" href="#/warehouse/pick">← 拣货清单</a>{error ? <ErrorBox error={error} /> : <p className="muted">载入中…</p>}</>);
  const p = d.pick;
  const picking = p?.status === "picking";
  const canScan = picking && d.can_edit;
  const pct = p && p.total > 0 ? Math.min(100, (p.picked / p.total) * 100) : 0;
  const today = todayKL();

  return (
    <>
      {flash && <div key={flash.n} className={"pick-flash " + (flash.ok ? "ok" : "err")} />}
      <a className="pick-back" href="#/warehouse/pick">← 拣货清单</a>
      <div className="pick-title">
        <h2>{d.doc_no}</h2>
        {p ? <span className={"pk " + p.status}>{PICK_STATUS_LABEL[p.status]}</span> : <span className="pk">待拣</span>}
        {d.runs.slice(0, 2).map((r) => (
          <span key={r.run_id} className={"pk " + (r.run_date === today ? "today" : "run")}>
            {runLabel({ ...r, today: r.run_date === today })}
          </span>
        ))}
        {d.runs.some((r) => r.delivered) && <span className="pk done">已送达</span>}
      </div>
      <p className="pick-who">{`${d.debtor_name || "—"} · ${d.doc_date || ""}`}</p>
      {d.do_remark && <p className="pick-note">{`DO 备注：${d.do_remark}`}</p>}
      {d.cancelled && <div className="error">{p ? "这张 DO 在 AutoCount 已经取消：请把拣好的货放回货架，再按「取消拣货」。" : "这张 DO 在 AutoCount 已经取消，不用拣货。"}</div>}
      {d.missing && <div className="pick-warn">同步资料里找不到这张 DO 了（可能在 AutoCount 删了或改了单号）。</div>}
      {d.do_changed && <div className="pick-warn">开始拣货之后，AutoCount 改过这张 DO 的明细。下面是开始时的明细；要照新的拣，请「取消拣货」再重新开始。</div>}
      <ErrorBox error={error} />

      {!p && (
        <section className="card">
          {!d.has_lines ? <p className="muted">这张 DO 还没有明细（同步还没抓到），请过 15 分钟再看。</p>
            : d.can_edit && !d.cancelled ? (
              <div className="actions left">
                <button className="pk-big" disabled={busy} onClick={start}>开始拣货</button>
                <span className="muted small">按了才开始记：之后扫商品条码、扫货架条码。</span>
              </div>
            ) : !d.can_edit ? <p className="muted">你是「只看」：拣货要仓库「可编辑」。</p> : null}
          {d.cancelled_picks > 0 && <p className="muted small">{`之前取消过 ${d.cancelled_picks} 次拣货。`}</p>}
        </section>
      )}

      {canScan && p && (
        <section className="card pick-scan">
          <div className="pick-bin">
            <span className="lbl">目前货架</span>
            {bin ? <><b>{bin.label}</b><button className="ghost small" onClick={() => setBin(null)}>不从货架扣</button></>
              : <span className="muted small">没有选（不从货架扣）：扫货架条码，或点下面的货架</span>}
          </div>
          {assign && (
            <div className="pick-assign">
              <span>{`指定第 ${assign.line_no} 行：扫这一行的商品`}</span>
              <button className="ghost small" onClick={() => setAssign(null)}>取消指定</button>
            </div>
          )}
          <ScanBox onCode={onCode} autoFocus placeholder="扫商品或货架条码" />
          <div className="pick-qty">
            <span className="lbl">每次扫算几件</span>
            <button className="ghost small" onClick={() => setQty(String(Math.max(1, (Number(qty) || 1) - 1)))} aria-label="减一">−</button>
            <input type="number" inputMode="decimal" min="1" step="any" value={qty} onChange={(e) => setQty(e.target.value)} aria-label="数量" />
            <button className="ghost small" onClick={() => setQty(String((Number(qty) || 0) + 1))} aria-label="加一">+</button>
            {busy && <span className="muted small">储存中…</span>}
          </div>
          {result && <div className={"pick-result " + (result.ok ? "ok" : "err")}>{result.text}</div>}
          <div className="pick-total">
            <span className={"pk-bar" + (p.lines_left === 0 ? " full" : "")}><i style={{ width: `${pct}%` }} /></span>
            <span>{`${qtyLabel(p.picked)} / ${qtyLabel(p.total)}`}</span>
          </div>
        </section>
      )}

      {p?.status === "done" && (
        <div className="pick-done">{`✓ 已拣好 · ${p.done_by_name || ""} · ${whenLabel(p.done_at)}`}
          {p.short_note && <small>{`缺货：${p.short_note}`}</small>}</div>
      )}
      {!canScan && result && <div className={"pick-result " + (result.ok ? "ok" : "err")}>{result.text}</div>}
      {picking && !d.can_edit && (
        <div className="pick-total">
          <span className="pk-bar"><i style={{ width: `${pct}%` }} /></span>
          <span>{`${qtyLabel(p!.picked)} / ${qtyLabel(p!.total)}`}</span>
        </div>
      )}

      <h3>{`明细（${d.lines.length} 行）`}</h3>
      <div className="pick-lines">
        {d.lines.map((l) => (
          <Line key={l.line_no} l={l} canScan={!!canScan} hit={hit != null && hit === l.id} assign={assign != null && assign.id === l.id}
                curBin={bin} onBin={(b) => { setBin(b); signal(true, `目前货架：${b.label}`); }}
                onAssign={() => { setAssign(l); setResult({ ok: true, text: `指定第 ${l.line_no} 行：扫这一行的商品` }); }}
                onManual={() => setManual(l)} onSkip={() => setSkip(l)} onUnskip={() => unskip(l)} />
        ))}
      </div>

      {p && d.can_edit && (
        <div className="pick-foot">
          {picking && <button className="pk-big" disabled={busy || d.cancelled} onClick={finish}>已拣好</button>}
          {p.status === "done" && d.can_cancel && <button className="ghost" onClick={reopen}>重新打开</button>}
          {d.can_cancel && <button className="ghost danger" onClick={() => setCancelOpen(true)}>取消拣货</button>}
          <button className="ghost" onClick={() => load()}>重新整理</button>
        </div>
      )}
      {p && <p className="muted small">{`开始：${p.started_by_name || ""} · ${whenLabel(p.started_at)}`}</p>}

      {p && d.scans.length > 0 && (
        <details className="card" open={picking}>
          <summary>{`扫码纪录（${d.scans.filter((s) => !s.voided).length}）`}</summary>
          <ul className="list pick-log">
            {d.scans.map((s) => (
              <li key={s.id} className={s.voided ? "voided" : ""}>
                <span className="main">{scanText(s)}<br /><span className="muted small">{`${whenLabel(s.created_at)} · ${s.by_name || ""}`}</span></span>
                {s.voided ? <span className="pk">已撤销</span>
                  : canScan && <button className="ghost small" onClick={() => undo(s)}>撤销</button>}
              </li>
            ))}
          </ul>
        </details>
      )}

      {manual && p && (
        <ManualModal line={manual} curBin={bin} onClose={() => setManual(null)} onSave={async (n, reason, b) => {
          const r = await pick.lineSet({ pick_id: p.id, line_id: manual.id!, action: "manual", qty: n, reason, bin: b });
          apply(r); setManual(null);
          signal(true, r.done_all ? `✓ 第 ${manual.line_no} 行手动确认 ${qtyLabel(n)} — 全部拣好了，按「已拣好」完成。`
                                  : `✓ 第 ${manual.line_no} 行手动确认 ${qtyLabel(n)}`);
        }} />
      )}
      {skip && p && (
        <SkipModal line={skip} onClose={() => setSkip(null)} onSave={async (reason) => {
          const r = await pick.lineSet({ pick_id: p.id, line_id: skip.id!, action: "skip", reason });
          apply(r); setSkip(null);
          setResult({ ok: true, text: r.done_all ? `第 ${skip.line_no} 行已略过 — 全部拣好了，按「已拣好」完成。` : `第 ${skip.line_no} 行已略过` });
        }} />
      )}
      {doneOpen && p && (
        <DoneModal short={d.lines.filter((l) => !l.done)} onClose={() => setDoneOpen(false)} onSave={async (note) => {
          setD(await pick.done({ pick_id: p.id, force: true, short_note: note }));
          setDoneOpen(false); setResult(null);
        }} />
      )}
      {cancelOpen && p && (
        <CancelModal p={p} onClose={() => setCancelOpen(false)} onSave={async (reason) => {
          const r = await pick.cancel({ pick_id: p.id, reason });
          setCancelOpen(false); setBin(null); setAssign(null);
          setResult({ ok: true, text: `已取消拣货（货架加回 ${r.reversed} 笔）。` });
          await load();
        }} />
      )}
      {binShort && (
        <BinShortModal message={binShort.message} qty={binShort.qty} bins={binShort.bins} onClose={() => setBinShort(null)}
                       onBin={(b) => {
                         const j = binShort; setBinShort(null);
                         setBin({ barcode: b.barcode, label: `${b.location} · ${b.code}` });   // 人多半已经走到那个货架
                         queue.current.push({ code: j.code, qty: j.qty, line: j.line, bin: b.barcode }); drain();
                       }}
                       onNoBin={() => { const j = binShort; setBinShort(null); queue.current.push({ code: j.code, qty: j.qty, line: j.line, noBin: true }); drain(); }} />
      )}
    </>
  );
}

function scanText(s: PickScan): string {
  const what = `#${s.line_no} ${s.item_code || ""} × ${qtyLabel(s.qty)}`;
  if (s.manual) return `${what} · 手动：${s.note}`;
  return s.bin ? `${what} · ${s.bin}` : what;
}

function Line({ l, canScan, hit, assign, curBin, onBin, onAssign, onManual, onSkip, onUnskip }: {
  l: PickLine; canScan: boolean; hit: boolean; assign: boolean; curBin: Bin | null;
  onBin: (b: Bin) => void; onAssign: () => void; onManual: () => void; onSkip: () => void; onUnskip: () => void;
}) {
  const pct = l.qty > 0 ? Math.min(100, (l.picked / l.qty) * 100) : 100;
  const cls = ["pick-line", l.skip ? "skip" : l.done ? "done" : !l.item_code ? "none" : "", hit ? "hit" : "", assign ? "assign" : ""];
  const desc = l.item_desc && l.item_desc.trim().toUpperCase() !== l.description.trim().toUpperCase() ? l.item_desc : "";
  const uomDiff = !!(l.item_code && l.uom && l.base_uom && l.uom.trim().toUpperCase() !== l.base_uom.trim().toUpperCase());
  return (
    <div className={cls.filter(Boolean).join(" ")}>
      <div className="top">
        <span className="desc">{`#${l.line_no} ${l.description || "—"}`}</span>
        <span className={"count" + (l.done && !l.skip ? " full" : "")}>
          {l.skip ? "已略过" : `${qtyLabel(l.picked)} / ${qtyLabel(l.qty)}${l.uom ? " " + l.uom : ""}`}
        </span>
      </div>
      <div className="meta">
        {l.item_code ? <b>{l.item_code}</b> : null}
        <span className={"pk" + (l.match === "none" ? " none" : "")}>{MATCH_LABEL[l.match]}</span>
        {desc && <span>{desc}</span>}
        {l.skip && l.skip_reason && <span>{`原因：${l.skip_reason}`}</span>}
      </div>
      {!l.skip && <span className={"pk-bar" + (l.done ? " full" : "")}><i style={{ width: `${pct}%` }} /></span>}
      {!l.skip && uomDiff && <div className="pick-note amber">{`DO 的单位是 ${l.uom}，商品基本单位是 ${l.base_uom}：数量照 DO 的单位算，从货架扣也是这个数，请注意换算。`}</div>}
      {!l.skip && !l.done && l.bins.length > 0 && (
        <div className="pick-bins">
          <span className="lbl">货架</span>
          {l.bins.map((b) => (
            <button key={b.id} type="button" className={"bin-chip" + (curBin?.barcode === b.barcode ? " on" : "")} disabled={!canScan}
                    onClick={() => onBin({ barcode: b.barcode, label: `${b.location} · ${b.code}` })}>
              {`${b.location} · ${b.code} × ${qtyLabel(b.qty)}`}
            </button>
          ))}
        </div>
      )}
      {!l.skip && !l.done && l.item_code && l.bins.length === 0 && <div className="pick-note">货架上没有这个商品的纪录</div>}
      {canScan && l.id != null && (
        <div className="pick-acts">
          {l.skip ? <button className="ghost small" onClick={onUnskip}>取消略过</button> : !l.done && (
            <>
              {!l.item_code && <button className="small" onClick={onAssign}>扫商品指定</button>}
              <button className="ghost small" onClick={onManual}>手动确认</button>
              {Number(l.picked) === 0 && <button className="ghost small" onClick={onSkip}>略过</button>}
            </>
          )}
        </div>
      )}
    </div>
  );
}
