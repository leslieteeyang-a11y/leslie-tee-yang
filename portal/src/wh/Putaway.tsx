// 待上架（仓库把关 2026-10-17）：点完货的好货（进货）→ 扫货架、打几件 → 货架帐加上去（跟这笔进货连在一起：进货取消时自动冲回）。
// 超过设定天数（预设 2 天）还没上完 = 逾期（首页、「今天」会提醒）。不用上架的（直接送去分店、放地上）写原因。
// 只列这个功能上线（2026-10-17）之后的进货，而且那个仓位有建货架的。
import { FormEvent, useCallback, useEffect, useState } from "react";
import { fmtDate, fmtQty } from "../api";
import { Empty, ErrorBox, Modal, Tabs } from "../ui";
import { gate, PutRow } from "../wh-gate-api";
import { ScanBox } from "./Scanner";

export function PutawayTab({ company, canEdit }: { company: string; canEdit: boolean }) {
  const [status, setStatus] = useState<"todo" | "done" | "all">("todo");
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [data, setData] = useState<{ days: number; rows: PutRow[] } | null>(null);
  const [error, setError] = useState("");
  const [flash, setFlash] = useState("");
  const [put, setPut] = useState<PutRow | null>(null);
  const [skip, setSkip] = useState<PutRow | null>(null);
  const load = useCallback(() => {
    setError("");
    gate.putList(company, status, query).then(setData).catch((e: Error) => setError(e.message));
  }, [company, status, query]);
  useEffect(() => { setData(null); load(); }, [load]);

  // 扫商品条码 / 打型号：只有一笔就直接开上架视窗
  function find(code: string) {
    const k = code.trim().toUpperCase();
    if (!k || !data) return;
    const m = data.rows.filter((r) => r.left > 0 && r.item_code.toUpperCase() === k);
    if (m.length === 1 && canEdit) { setPut(m[0]); return; }
    setQ(code.trim()); setQuery(code.trim());
  }

  return (
    <>
      <p className="muted small">{`点完货的好货要放上货架：扫货架、打几件就好（货架帐跟著加）。超过 ${data?.days ?? 2} 天还没上完会提醒。`}</p>
      <div className="filters">
        <Tabs value={status} onChange={(k) => setStatus(k as typeof status)} options={[["todo", "待上架"], ["done", "已上完"], ["all", "全部"]]} />
      </div>
      <form className="toolbar" onSubmit={(e: FormEvent) => { e.preventDefault(); setQuery(q.trim()); }}>
        <input value={q} placeholder="搜型号 / 品名" aria-label="搜型号 / 品名" onChange={(e) => setQ(e.target.value)} />
        <button type="submit" className="ghost">搜寻</button>
      </form>
      {canEdit && status !== "done" && <ScanBox onCode={find} placeholder="扫商品条码，或打型号" />}
      {flash && <div className="ok">{flash}</div>}
      <ErrorBox error={error} />
      {data === null ? (!error && <p className="muted">载入中…</p>) : !data.rows.length ? (
        <Empty>{status === "todo" ? "没有要上架的货。" : "没有资料。"}</Empty>
      ) : (
        <ul className="list wh-put">
          {data.rows.map((r) => (
            <li key={r.id} className={r.late ? "late-row" : ""}>
              <span className="main">
                <span>
                  <b>{r.item_code}</b> <span className="muted">{r.description}</span>
                  {r.late && <> <span className="tag late">逾期</span></>}
                  {r.recv_wrong && <> <span className="tag">来错的货</span></>}
                </span>
                <span className="sub">
                  {`${r.location} · 收 ${fmtQty(r.qty)} · 已上 ${fmtQty(r.put)} · 还有 ${fmtQty(r.left)} ${r.uom ?? ""}`}
                  {` · 点货 ${fmtDate(r.created_at)}`}{r.do_no && ` · DO ${r.do_no}`}
                  {r.claim && ` · ${r.claim.name}`}
                </span>
                {r.bins.length > 0 && <span className="sub">{`已经放在：${r.bins.map((b) => `${b.code}（${fmtQty(b.qty)}）`).join("、")}`}</span>}
              </span>
              {canEdit && r.left > 0 && (
                <span className="wh-put-act">
                  <button className="small" onClick={() => setPut(r)}>上架</button>
                  <button className="small ghost" onClick={() => setSkip(r)}>不用上架</button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {put && <PutModal r={put} onClose={() => setPut(null)} onDone={(x, msg) => { setPut(null); setFlash(msg); load(); if (x.left > 0) setPut(x); }} />}
      {skip && <SkipModal r={skip} onClose={() => setSkip(null)} onDone={() => { setSkip(null); setFlash(`${skip.item_code} 不用上架。`); load(); }} />}
    </>
  );
}

function PutModal({ r, onClose, onDone }: { r: PutRow; onClose: () => void; onDone: (x: PutRow, msg: string) => void }) {
  const [bin, setBin] = useState(r.bins[0]?.code ?? "");
  const [qty, setQty] = useState(String(r.left));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save(e?: FormEvent) {
    e?.preventDefault();
    if (!bin.trim()) { setError("请扫或打货架代号。"); return; }
    setBusy(true); setError("");
    try {
      const x = await gate.put(r.id, bin.trim(), qty.trim());
      onDone(x, `✓ ${r.item_code} × ${qty.trim()} 放上 ${bin.trim().toUpperCase()}`);
    } catch (err) { setError((err as Error).message); setBusy(false); }
  }
  return (
    <Modal title={`上架 ${r.item_code}`} onClose={onClose}>
      <form className="form" onSubmit={save}>
        <p className="small">{`${r.description ?? ""} · ${r.location} · 还有 ${fmtQty(r.left)} 件`}</p>
        <label>货架（扫货架条码或打代号）
          <ScanBox onCode={(c) => setBin(c)} placeholder="扫货架" />
          <input value={bin} aria-label="货架" placeholder="例：A-R1-2" onChange={(e) => setBin(e.target.value)} />
        </label>
        {r.bins.length > 0 && (
          <p className="small">{"已经放在："}{r.bins.map((b) => (
            <button key={b.code} type="button" className="text-btn small" onClick={() => setBin(b.code)}>{`${b.code}（${fmtQty(b.qty)}）`}</button>
          ))}</p>
        )}
        <label>几件<input className="big-num" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} /></label>
        <ErrorBox error={error} />
        <div className="actions">
          <button type="button" className="ghost" onClick={onClose}>取消</button>
          <button type="submit" disabled={busy}>放上去</button>
        </div>
      </form>
    </Modal>
  );
}

function SkipModal({ r, onClose, onDone }: { r: PutRow; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError("");
    try { await gate.putSkip(r.id, reason); onDone(); } catch (err) { setError((err as Error).message); setBusy(false); }
  }
  return (
    <Modal title={`${r.item_code} 不用上架`} onClose={onClose}>
      <form className="form" onSubmit={save}>
        <label>原因<input value={reason} autoFocus placeholder="例：直接送去 JB、放在地上" onChange={(e) => setReason(e.target.value)} /></label>
        <ErrorBox error={error} />
        <div className="actions">
          <button type="button" className="ghost" onClick={onClose}>取消</button>
          <button type="submit" disabled={busy}>确定</button>
        </div>
      </form>
    </Modal>
  );
}
