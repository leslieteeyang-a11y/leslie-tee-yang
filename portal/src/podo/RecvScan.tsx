// 扫码点货（使用者 2026-10-16）：扫一个型号一次，跳出视窗直接打这个型号一共收到几件（40 件不用扫 40 次）。
// 「开始扫码点货」把每个型号的好货清空（没扫到的送出时会被挡下，没到的要自己填 0），坏货归 0。
// 认得：这张 DO 的型号代号、仓库登记过的纸箱条码、箱贴批次 QR（ops_wh_item → ops.wh_resolve；没有仓库权限就只认型号代号）、
// 打品名的一部分。扫到不是这张 DO 的型号 → 记进「来错的货」。只改画面上的数字，按「点完，货到了」才存。
import { FormEvent, useState } from "react";
import { fmtQty } from "../api";
import { Modal } from "../ui";
import { wh } from "../wh-api";
import { num, RecvItem } from "../podo-api";
import { ScanBox } from "../wh/Scanner";

const r3 = (n: number) => Math.round(n * 1000) / 1000;

type Hit = { kind: "item"; it: RecvItem } | { kind: "wrong"; code: string; desc: string };

export function RecvScan({ company, items, received, scanMode, onStart, onCount, onWrong }: {
  company: string; items: RecvItem[]; received: Record<string, string>; scanMode: boolean;
  onStart: () => void;
  onCount: (code: string, good: string, damaged: string) => void;
  onWrong: (code: string, desc: string, qty: string) => void;
}) {
  const [hit, setHit] = useState<Hit | null>(null);
  const [choices, setChoices] = useState<RecvItem[] | null>(null);
  const [msg, setMsg] = useState<["ok" | "error", string] | null>(null);
  const [busy, setBusy] = useState(false);
  const [box, setBox] = useState(0);   // 换 key 让扫码框重新抓焦点（蓝牙扫描枪接着扫）
  const done = items.filter((it) => (received[it.item_code] ?? "").trim() !== "").length;

  async function scan(raw: string) {
    const t = raw.trim();
    setMsg(null); setChoices(null);
    if (!t) return;
    const byCode = (c: string) => items.find((it) => it.item_code.toUpperCase() === c.toUpperCase());
    let it = byCode(t);
    if (!it) {
      setBusy(true);
      try {
        const d = await wh.item(company, t);   // 纸箱条码 / 箱贴批次 → 商品代号
        if (d.found) {
          it = byCode(d.item_code);
          if (!it) { setHit({ kind: "wrong", code: d.item_code, desc: d.description }); return; }
        }
      } catch { /* 没有仓库权限：只认这张 DO 的型号 */ } finally { setBusy(false); }
    }
    if (!it) {
      const k = t.toLowerCase();
      const m = items.filter((x) => x.item_code.toLowerCase().includes(k) || (x.description ?? "").toLowerCase().includes(k));
      if (m.length === 1) it = m[0];
      else if (m.length > 1) { setChoices(m); return; }
      else {
        setMsg(["error", `这张 DO 没有「${t}」。如果是来错的货，请在下面「来错的货」加一行；纸箱条码认不出来，可以到仓库「查货」把条码绑到商品。`]);
        return;
      }
    }
    setHit({ kind: "item", it });
  }

  function close(m?: string) {
    setHit(null);
    if (m) setMsg(["ok", m]);
    setBox((b) => b + 1);
  }

  return (
    <div className="recv-scan">
      {!scanMode ? (
        <div className="recv-scan-start">
          <button type="button" onClick={onStart}>▦ 开始扫码点货</button>
          <span className="muted small">每个型号扫一次，再打一共收到几件。开始后每个型号的好货会先清空，没扫到的要自己填（没到就填 0）。</span>
        </div>
      ) : (
        <>
          <ScanBox key={box} autoFocus={!window.matchMedia?.("(pointer: coarse)").matches} busy={busy} onCode={scan} placeholder="扫码，或打型号 / 品名" />
          <div className="recv-scan-progress">
            <b>{`已点 ${done} / ${items.length} 个型号`}</b>
            {done < items.length && <span className="muted small">还没点的型号，好货栏是空的</span>}
          </div>
        </>
      )}
      {msg && <div className={msg[0]}>{msg[1]}</div>}
      {choices && (
        <ul className="list recv-scan-choices">
          {choices.map((c) => (
            <li key={c.item_code} className="click" onClick={() => { setChoices(null); setHit({ kind: "item", it: c }); }}>
              <span><b>{c.item_code}</b> <small className="muted">{c.description}</small></span><span>选这个 →</span>
            </li>
          ))}
        </ul>
      )}
      {hit?.kind === "item" && (
        <CountModal it={hit.it} prev={received[hit.it.item_code] ?? ""} onClose={() => close()}
                    onSave={(g, dm) => { onCount(hit.it.item_code, g, dm); close(`${hit.it.item_code}：好货 ${fmtQty(num(g))}${num(dm) > 0 ? `、坏货 ${fmtQty(num(dm))}` : ""}`); }} />
      )}
      {hit?.kind === "wrong" && (
        <WrongModal code={hit.code} desc={hit.desc} onClose={() => close()}
                    onSave={(q) => { onWrong(hit.code, hit.desc, q); close(`${hit.code} 记进「来错的货」：${fmtQty(num(q))} 件`); }} />
      )}
    </div>
  );
}

/** 扫到一个型号：打一共收到几件（好货），有坏的另外填；之前填过的可以「加上去」（同一型号分几箱点） */
function CountModal({ it, prev, onClose, onSave }: {
  it: RecvItem; prev: string; onClose: () => void; onSave: (good: string, damaged: string) => void;
}) {
  const [good, setGood] = useState("");
  const [dmg, setDmg] = useState("");
  const [err, setErr] = useState("");
  const shipped = Number(it.shipped);
  const had = prev.trim() !== "" && !Number.isNaN(num(prev));

  function save(mode: "set" | "add", g = good) {
    const n = num(g);
    const d = dmg.trim() ? num(dmg) : 0;
    if (!g.trim() || Number.isNaN(n) || n < 0) { setErr("请填好货收到几件（没收到填 0）。"); return; }
    if (Number.isNaN(d) || d < 0) { setErr("坏货数量不是数字。"); return; }
    onSave(String(r3(mode === "add" && had ? num(prev) + n : n)), String(r3(d)));
  }
  const submit = (e: FormEvent) => { e.preventDefault(); save("set"); };

  return (
    <Modal title={it.item_code} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <p className="small">{it.description}</p>
        <p><span>应到</span>{" "}<b>{fmtQty(shipped)}</b>{" "}<span className="muted small">{it.uom}</span></p>
        {had && <p className="small amber">{`之前填了好货 ${fmtQty(num(prev))} 件`}</p>}
        <label>好货一共收到几件
          <input className="big-num" inputMode="decimal" autoFocus value={good} onChange={(e) => { setGood(e.target.value); setErr(""); }} />
        </label>
        <label>坏货（没有就空着）
          <input inputMode="decimal" value={dmg} onChange={(e) => { setDmg(e.target.value); setErr(""); }} />
        </label>
        {err && <div className="error">{err}</div>}
        <div className="actions">
          <button type="button" className="ghost" onClick={onClose}>取消</button>
          <button type="button" className="ghost" onClick={() => save("set", String(shipped))}>{`全到（${fmtQty(shipped)}）`}</button>
          {had && <button type="button" className="ghost" onClick={() => save("add")}>加上去</button>}
          <button type="submit">确定</button>
        </div>
      </form>
    </Modal>
  );
}

function WrongModal({ code, desc, onClose, onSave }: { code: string; desc: string; onClose: () => void; onSave: (qty: string) => void }) {
  const [qty, setQty] = useState("");
  const [err, setErr] = useState("");
  function submit(e: FormEvent) {
    e.preventDefault();
    const n = num(qty);
    if (!qty.trim() || Number.isNaN(n) || n <= 0) { setErr("请填收到几件。"); return; }
    onSave(String(r3(n)));
  }
  return (
    <Modal title={code} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <p className="small">{desc}</p>
        <p className="amber">这个型号不在这张 DO 上，会记成「来错的货」。</p>
        <label>收到几件
          <input className="big-num" inputMode="decimal" autoFocus value={qty} onChange={(e) => { setQty(e.target.value); setErr(""); }} />
        </label>
        {err && <div className="error">{err}</div>}
        <div className="actions">
          <button type="button" className="ghost" onClick={onClose}>取消</button>
          <button type="submit">记成来错的货</button>
        </div>
      </form>
    </Modal>
  );
}
