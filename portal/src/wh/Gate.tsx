// 仓库「复核」（仓库把关 2026-10-17）：
//   · 拣货等核对：别人拣好的 DO，点进去「开始核对」再数一次（拣过的人不能核对）；
//   · 点货差异：点货有少 / 坏 / 多 / 来错 → 仓库主管看照片、确认（点货的人不能复核自己的）；复核前开单部不能标「已输入」；
//   · 设定（仓库可审批）：每间分店可以关掉复核 / 拍照 / 两人核对 / 装车核对、改上架提醒天数。
import { useCallback, useEffect, useState } from "react";
import { fmtDate, fmtQty } from "../api";
import { Empty, ErrorBox, Tabs } from "../ui";
import { CheckPick, gate, Gate, RecvReview, recvKey } from "../wh-gate-api";
import { openPick } from "../wh-pick-api";
import { PhotoThumbs } from "../podo/RecvPhotos";

type Sub = "check" | "recv" | "setup";

export function GateTab({ company, canEdit, canApprove, arg }: { company: string; canEdit: boolean; canApprove: boolean; arg?: string }) {
  const [sub, setSub] = useState<Sub>(arg === "recv" || arg === "setup" ? arg : "check");
  const opts: [Sub, string][] = [["check", "拣货等核对"], ["recv", "点货差异"]];
  if (canApprove) opts.push(["setup", "设定"]);
  return (
    <>
      <div className="filters"><Tabs value={sub} onChange={(k) => setSub(k as Sub)} options={opts} /></div>
      {sub === "check" && <CheckList company={company} canEdit={canEdit} />}
      {sub === "recv" && <RecvList company={company} />}
      {sub === "setup" && canApprove && <Setup company={company} />}
    </>
  );
}

function CheckList({ company, canEdit }: { company: string; canEdit: boolean }) {
  const [rows, setRows] = useState<CheckPick[] | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(() => { setError(""); gate.toCheck(company).then(setRows).catch((e: Error) => setError(e.message)); }, [company]);
  useEffect(() => { setRows(null); load(); }, [load]);
  if (!rows) return error ? <ErrorBox error={error} /> : <p className="muted">载入中…</p>;
  return (
    <>
      <p className="muted small">拣好的 DO 要另一个人再数一次，核对相符才算拣好、才能装车。拣过这张单的人不能核对。</p>
      <ErrorBox error={error} />
      {!rows.length ? <Empty>没有等核对的 DO。</Empty> : (
        <ul className="list">
          {rows.map((r) => (
            <li key={r.id} className="click" onClick={() => openPick(r.doc_no)}>
              <span className="main">
                <span><b>{r.doc_no}</b> <span className="muted">{r.debtor_name}</span>
                  {r.check_fails > 0 && <> <span className="tag late">{`核对不符 ${r.check_fails} 次`}</span></>}</span>
                <span className="sub">{`拣货：${r.done_by_name ?? r.started_by_name ?? "—"} · ${fmtDate(r.done_at)}`}
                  {r.claim && ` · ${r.claim.name} 在核对`}</span>
              </span>
              <span>{r.touched ? <span className="muted small">你有拣，请别人核对</span> : canEdit && <span className="go">核对 →</span>}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function RecvList({ company }: { company: string }) {
  const [st, setSt] = useState<"pending" | "done">("pending");
  const [rows, setRows] = useState<RecvReview[] | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(() => { setError(""); gate.reviews(company, st).then(setRows).catch((e: Error) => setError(e.message)); }, [company, st]);
  useEffect(() => { setRows(null); load(); }, [load]);
  return (
    <>
      <p className="muted small">点货有差异（少 / 坏 / 多 / 来错）要仓库主管看过照片、确认后才算定案；确认前开单部不能把这批进货标「已输入」。点货的人不能复核自己点的。</p>
      <div className="filters"><Tabs value={st} onChange={(k) => setSt(k as typeof st)} options={[["pending", "等复核"], ["done", "近 30 天已复核"]]} /></div>
      <ErrorBox error={error} />
      {rows === null ? <p className="muted">载入中…</p> : !rows.length ? <Empty>{st === "pending" ? "没有等复核的点货。" : "没有资料。"}</Empty>
        : rows.map((r) => <ReviewCard key={r.do_id} r={r} onDone={load} />)}
    </>
  );
}

function ReviewCard({ r, onDone }: { r: RecvReview; onDone: () => void }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const photosOf = (kind: string, key: string) => r.photos.filter((p) => p.kind === kind && p.item_key === key).map((p) => p.path);
  async function ok() {
    setBusy(true); setError("");
    try { await gate.reviewOk(r.do_id, note); onDone(); } catch (e) { setError((e as Error).message); setBusy(false); }
  }
  return (
    <section className="card gate-review">
      <div className="grn-head">
        <span><b>{r.do_no ? `DO ${r.do_no}` : "厂家到货"}</b>{r.supplier_name && <span className="muted">{` · ${r.supplier_name}`}</span>}</span>
        {r.status === "pending" ? <span className="ap pending">等复核</span> : <span className="ap approved">已复核</span>}
      </div>
      <p className="muted small">{`点货：${r.counted_by_name ?? "—"} · ${fmtDate(r.counted_at)}`}{r.arrive_note && ` · ${r.arrive_note}`}</p>
      <ul className="list small">
        {r.reasons.map((x, i) => x.wrong ? (
          <li key={i}><span>
            <span className="tag">来错的货</span>{" "}<b>{x.received_code || x.description}</b>{x.received_code && <span className="muted">{` ${x.description ?? ""}`}</span>}
            {` × ${fmtQty(Number(x.qty))}`}{x.expected_code && ` · 本来应该是 ${x.expected_code}`}
            <br /><PhotoThumbs paths={photosOf("wrong", recvKey(x.received_code, x.description))} />
          </span></li>
        ) : (
          <li key={i}><span>
            <b>{x.item_code}</b> <span className="muted">{x.description}</span>
            <br />{`应到 ${fmtQty(Number(x.shipped))} · 好货 ${fmtQty(Number(x.received))} · 坏货 ${fmtQty(Number(x.damaged))}`}
            <br /><PhotoThumbs paths={[...photosOf("damaged", recvKey(x.item_code, "")), ...photosOf("short", recvKey(x.item_code, ""))]} />
          </span></li>
        ))}
      </ul>
      {r.status === "approved" ? (
        <p className="small">{`✓ ${r.reviewed_by_name ?? ""} · ${fmtDate(r.reviewed_at)}`}{r.note && ` · ${r.note}`}</p>
      ) : r.can_review ? (
        <div className="actions left">
          <input value={note} placeholder="复核备注（可空白，例：坏的一件已拍照）" aria-label="复核备注" onChange={(e) => setNote(e.target.value)} />
          <button disabled={busy} onClick={ok}>✓ 确认差异属实</button>
        </div>
      ) : <p className="muted small">等仓库主管复核（点货的人不能复核自己点的）。</p>}
      <p className="muted small">数字不对：请采购在「厂家问题」作废或改那笔问题，再按确认。</p>
      <ErrorBox error={error} />
    </section>
  );
}

function Setup({ company }: { company: string }) {
  const [g, setG] = useState<Gate | null>(null);
  const [days, setDays] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { gate.get(company).then((x) => { setG(x); setDays(String(x.putaway_days)); }).catch((e: Error) => setError(e.message)); }, [company]);
  async function save(p: Partial<Gate>) {
    setBusy(true); setError("");
    try { const x = await gate.set({ company, ...p }); setG(x); setDays(String(x.putaway_days)); } catch (e) { setError((e as Error).message); }
    setBusy(false);
  }
  if (!g) return error ? <ErrorBox error={error} /> : <p className="muted">载入中…</p>;
  const row = (k: "recv_review" | "recv_photo" | "pick_check" | "load_check", label: string, hint: string) => (
    <label className="gate-switch">
      <input type="checkbox" checked={g[k]} disabled={busy} onChange={(e) => save({ [k]: e.target.checked })} />
      <span><b>{label}</b><br /><small className="muted">{hint}</small></span>
    </label>
  );
  return (
    <section className="card">
      <p className="muted small">这间分店的把关规则。人手不够（例：只有一个人在仓库）可以先关掉两人核对。</p>
      {row("recv_review", "点货有差异要主管复核", "复核前开单部不能把这批进货标「已输入」。")}
      {row("recv_photo", "坏货、来错的货要拍照", "没拍照不能送出点货。")}
      {row("pick_check", "拣货要另一个人核对", "核对相符才算拣好、才能装车。")}
      {row("load_check", "装车前扫码核对 + 拍装车照", "没拣好 / 没核对的 DO 不能装车；出车要拍照。")}
      <div className="actions left">
        <label>上架提醒天数<input className="podo-num" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} /></label>
        <button className="ghost" disabled={busy} onClick={() => save({ putaway_days: Number(days) })}>储存</button>
      </div>
      {g.updated_by_name && <p className="muted small">{`最后修改：${g.updated_by_name} · ${fmtDate(g.updated_at)}`}</p>}
      <ErrorBox error={error} />
    </section>
  );
}
