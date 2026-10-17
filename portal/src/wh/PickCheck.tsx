// 拣货核对（仓库把关 2026-10-17）：按「已拣好」之后，要另一个人再数一次（拣过这张单的人不能核对，资料库也会挡）。
// 每行打数到几件（或扫商品跳出视窗打数量，同一个商品分几箱可以「加上去」）；全部跟拣的数一样才算核对好。
// 不符：资料库记一次「核对不符」（算在拣货的人身上），画面列出哪几行不一样 → 请拣货的人重开改正，或再数一次。
import { FormEvent, useState } from "react";
import { ErrorBox, Modal } from "../ui";
import { gate } from "../wh-gate-api";
import { qtyLabel } from "../wh-api";
import { beep, buzz, PickDoc, PickLine } from "../wh-pick-api";
import { ScanBox } from "./Scanner";

export function PickCheck({ d, onDone }: { d: PickDoc; onDone: (next: PickDoc) => void }) {
  const p = d.pick!;
  const lines = d.lines.filter((l) => !l.skip && l.id != null);
  const [open, setOpen] = useState(false);
  const [qty, setQty] = useState<Record<number, string>>({});
  const [ask, setAsk] = useState<PickLine | null>(null);
  const [msg, setMsg] = useState<["ok" | "error", string] | null>(null);
  const [diffs, setDiffs] = useState<Record<number, number>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [box, setBox] = useState(0);

  if (p.touched) return <p className="muted small">你有拣这张单，请另一位同事核对（拣货和核对要两个人）。</p>;
  if (!open) return (
    <div className="pick-check-start">
      <button className="pk-big" onClick={() => setOpen(true)}>开始核对</button>
      <span className="muted small">另一个人再数一次：扫商品或直接打每行数到几件。</span>
    </div>
  );

  function scan(raw: string) {
    const t = raw.trim().toUpperCase();
    setMsg(null);
    if (!t) return;
    const m = lines.filter((l) => (l.item_code ?? "").toUpperCase() === t);
    const hit = m.length ? m : lines.filter((l) => (l.item_code ?? "").toUpperCase().includes(t) || l.description.toUpperCase().includes(t));
    if (hit.length === 1) { setAsk(hit[0]); return; }
    buzz(false);
    setMsg(["error", hit.length ? `「${raw.trim()}」对到好几行，请直接在那一行打数量。` : `这张 DO 没有「${raw.trim()}」。`]);
    setBox((b) => b + 1);
  }

  async function submit() {
    const miss = lines.filter((l) => !(qty[l.id!] ?? "").trim());
    if (miss.length) { setError(`还有 ${miss.length} 行没核对（第 ${miss.map((l) => l.line_no).join("、")} 行）。`); return; }
    setBusy(true); setError("");
    try {
      const r = await gate.check(p.id, lines.map((l) => ({ line_id: l.id!, qty: qty[l.id!].trim() })), "");
      if (r.ok) { beep(true); onDone(r.pick); return; }
      buzz(false);
      setDiffs(Object.fromEntries((r.diffs ?? []).map((x) => [x.line_id, x.checked])));
      setError(`有 ${r.diffs?.length ?? 0} 行跟拣的数不一样（已记一次核对不符）。请再数一次，或请拣货的人「重新打开」改正。`);
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  }

  const done = lines.filter((l) => (qty[l.id!] ?? "").trim() !== "").length;
  return (
    <section className="card pick-check">
      <h3>核对</h3>
      <ScanBox key={box} autoFocus={!window.matchMedia?.("(pointer: coarse)").matches} onCode={scan} placeholder="扫商品，或打型号 / 品名" />
      {msg && <div className={msg[0]}>{msg[1]}</div>}
      <p className="small"><b>{`已核对 ${done} / ${lines.length} 行`}</b></p>
      <div className="table-wrap flat">
        <table>
          <thead><tr><th>#</th><th>商品</th><th className="num">DO 数量</th><th className="num">数到</th></tr></thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.id} className={diffs[l.id!] != null ? "red-row" : ""}>
                <td>{l.line_no}</td>
                <td><b>{l.item_code ?? "—"}</b> <small className="muted">{l.description}</small></td>
                <td className="num">{qtyLabel(l.qty)}</td>
                <td className="num">
                  <input className="podo-num" inputMode="decimal" value={qty[l.id!] ?? ""} aria-label={`第 ${l.line_no} 行数到`}
                         onChange={(e) => { setQty({ ...qty, [l.id!]: e.target.value }); setError(""); }} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ErrorBox error={error} />
      <div className="actions left">
        <button disabled={busy} onClick={submit}>核对完成</button>
        <button className="ghost" disabled={busy} onClick={() => setOpen(false)}>先不核对</button>
      </div>
      {ask && <CountModal l={ask} prev={qty[ask.id!] ?? ""} onClose={() => { setAsk(null); setBox((b) => b + 1); }}
                          onSave={(v) => { setQty({ ...qty, [ask.id!]: v }); setAsk(null); setBox((b) => b + 1); beep(true); }} />}
    </section>
  );
}

function CountModal({ l, prev, onClose, onSave }: { l: PickLine; prev: string; onClose: () => void; onSave: (v: string) => void }) {
  const [v, setV] = useState("");
  const [err, setErr] = useState("");
  const had = prev.trim() !== "" && !Number.isNaN(Number(prev));
  function save(mode: "set" | "add") {
    const n = Number(v.trim());
    if (!v.trim() || Number.isNaN(n) || n < 0) { setErr("请填数到几件（没有填 0）。"); return; }
    onSave(String(mode === "add" && had ? Math.round((Number(prev) + n) * 1000) / 1000 : n));
  }
  const submit = (e: FormEvent) => { e.preventDefault(); save("set"); };
  return (
    <Modal title={l.item_code ?? `第 ${l.line_no} 行`} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <p className="small">{l.description}</p>
        {had && <p className="small amber">{`之前填了 ${prev} 件`}</p>}
        <label>数到几件
          <input className="big-num" inputMode="decimal" autoFocus value={v} onChange={(e) => { setV(e.target.value); setErr(""); }} />
        </label>
        {err && <div className="error">{err}</div>}
        <div className="actions">
          <button type="button" className="ghost" onClick={onClose}>取消</button>
          {had && <button type="button" className="ghost" onClick={() => save("add")}>加上去</button>}
          <button type="submit">确定</button>
        </div>
      </form>
    </Modal>
  );
}
