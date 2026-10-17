// 装车核对 + 装车照（仓库把关 2026-10-17）：出车前一张一张扫 DO（或打 DO 号），没备好 / 没核对的不能装；
// 拍装车照（Storage ops-wh：load/<公司>/<排单>/…）后按「出车」。送货「可审批」可以写原因强制出车（例：DO 没有要备的货）。
// 分店在「仓库 → 复核 → 设定」关掉装车核对 = 扫不扫都可以出车、不用拍照。
import { useEffect, useRef, useState } from "react";
import { ErrorBox } from "../ui";
import { gate, Load, uploadLoadPhoto } from "../wh-gate-api";
import { shrinkPhoto } from "../wh-tag-api";
import { beep, buzz } from "../wh-pick-api";
import { ScanBox } from "../wh/Scanner";
import { PhotoThumbs } from "../podo/RecvPhotos";

const hhmm = (s: string | null) => (s ? new Date(s).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kuala_Lumpur" }) : "");

export function LoadPanel({ runId, onChange }: { runId: number; onChange?: () => void }) {
  const [ld, setLd] = useState<Load | null>(null);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState<["ok" | "error", string] | null>(null);
  const [busy, setBusy] = useState(false);
  const [box, setBox] = useState(0);
  const [note, setNote] = useState("");
  const [why, setWhy] = useState("");
  const file = useRef<HTMLInputElement>(null);

  useEffect(() => { gate.load(runId).then(setLd).catch((e: Error) => setError(e.message)); }, [runId]);
  if (!ld) return error ? <ErrorBox error={error} /> : <p className="muted small">载入中…</p>;
  const gone = ld.status === "departed";
  const edit = ld.can_edit && !gone;
  const missing = ld.docs.filter((x) => !(x.loaded && x.ready));
  const set = (x: Load) => { setLd(x); onChange?.(); };

  async function scan(code: string) {
    if (!code.trim()) return;
    setBusy(true); setMsg(null); setError("");
    try {
      const r = await gate.loadScan(runId, code);
      if (r.ok && r.load) {
        beep(true); set(r.load);
        setMsg(["ok", r.short_note ? `✓ ${r.doc_no} 已装车（备货时缺货：${r.short_note}）` : `✓ ${r.doc_no} 已装车`]);
      } else { buzz(false); setMsg(["error", r.message ?? "扫不进去。"]); }
    } catch (e) { setError((e as Error).message); }
    setBusy(false); setBox((b) => b + 1);
  }
  async function run(f: () => Promise<Load>) {
    setBusy(true); setError("");
    try { set(await f()); } catch (e) { setError((e as Error).message); }
    setBusy(false);
  }
  async function photo(f: File | undefined) {
    if (!f) return;
    await run(async () => gate.loadPhoto(runId, await uploadLoadPhoto(ld!.company, runId, await shrinkPhoto(f, 1280, 0.8))));
    if (file.current) file.current.value = "";
  }

  return (
    <div className="dlv-load">
      <h4>
        装车核对{" "}
        {gone ? <span className="tag ok-tag">{`已出车 · ${ld.departed_by_name ?? ""} ${hhmm(ld.departed_at)}`}</span>
          : <span className="tag">{`已装 ${ld.docs.filter((x) => x.loaded).length} / ${ld.docs.length} 张`}</span>}
      </h4>
      {!ld.gate && !gone && <p className="muted small">这间分店没有开装车核对：扫不扫都可以出车。</p>}
      {edit && <ScanBox key={box} autoFocus={false} busy={busy} onCode={scan} placeholder="扫 DO，或打 DO 号" />}
      {msg && <div className={msg[0]}>{msg[1]}</div>}
      <ul className="list small">
        {ld.docs.map((x) => (
          <li key={x.doc_no}>
            <span>
              <b>{x.doc_no}</b> <span className="muted">{x.name}</span>{" "}
              {!x.pick ? <span className="tag late">还没备</span>
                : x.pick.status !== "done" ? <span className="tag late">备货中</span>
                : !x.pick.checked ? <span className="tag late">等核对</span>
                : <span className="tag ok-tag">已备好</span>}
              {x.pick?.short_note && <small className="amber">{` 缺货：${x.pick.short_note}`}</small>}
            </span>
            <span>
              {x.loaded ? <span className="gate-ok">{`✓ 已装 ${hhmm(x.loaded_at)}`}</span> : <span className="muted">没装</span>}
              {x.loaded && edit && <button className="text-btn small" disabled={busy} onClick={() => run(() => gate.loadUnscan(runId, x.doc_no))}>拿下来</button>}
            </span>
          </li>
        ))}
        {!ld.docs.length && <li className="muted">这趟没有 DO（都是手动加的站）。</li>}
      </ul>
      <div className="dlv-load-photos">
        <PhotoThumbs paths={ld.photos} onRemove={edit ? (i) => run(() => gate.loadPhoto(runId, ld.photos[i], true)) : undefined} />
        {edit && (
          <>
            <input ref={file} type="file" accept="image/*" capture="environment" hidden onChange={(e) => photo(e.target.files?.[0])} />
            <button className="small ghost" disabled={busy} onClick={() => file.current?.click()}>
              {ld.photos.length ? "📷 再拍一张装车照" : "📷 拍装车照"}
            </button>
            {ld.gate && !ld.photos.length && <small className="late">出车前要拍</small>}
          </>
        )}
      </div>
      {gone && ld.override_reason && <p className="small amber">{`强制出车：${ld.override_reason}`}</p>}
      {gone && ld.note && <p className="small muted">{ld.note}</p>}
      {edit && (
        <div className="dlv-load-go">
          <input value={note} placeholder="备注（可空白）" aria-label="出车备注" onChange={(e) => setNote(e.target.value)} />
          {ld.gate && missing.length > 0 && ld.can_override && (
            <input value={why} placeholder="强制出车的原因（还有 DO 没装车核对时才要）" aria-label="强制出车的原因" onChange={(e) => setWhy(e.target.value)} />
          )}
          <button disabled={busy} onClick={() => run(() => gate.depart(runId, note, why))}>🚚 出车</button>
          {ld.gate && missing.length > 0 && <small className="muted">{`还有 ${missing.length} 张没装车核对`}</small>}
        </div>
      )}
      <ErrorBox error={error} />
    </div>
  );
}
