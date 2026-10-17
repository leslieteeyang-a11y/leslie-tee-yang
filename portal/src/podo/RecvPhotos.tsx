// 点货照片（仓库把关 2026-10-17）：坏货、来错的货一定要拍照（跟厂家理赔用；分店可以在「仓库 → 复核 → 设定」关掉）。
// 照片先传到 Storage ops-wh（recv/<公司>/<DO id>/…）再登记；资料库在点货送出时再检查一次，没照片就整个点货不存。
// PhotoThumbs：厂家问题、复核页显示照片（1 小时的暂时网址，点开看大图 / 长按存到手机再传给厂家）。
import { useEffect, useRef, useState } from "react";
import { gate, recvKey, RecvPhoto, RecvPhotoKind, uploadRecvPhoto } from "../wh-gate-api";
import { photoUrl, shrinkPhoto } from "../wh-tag-api";

export interface RecvPhotoState {
  photos: RecvPhoto[]; need: boolean; doId: number; company: string;
  set: (p: RecvPhoto[]) => void;
  has: (kind: RecvPhotoKind, code: string | null | undefined, desc?: string | null) => boolean;
}

export function useRecvPhotos(doId: number, company: string): RecvPhotoState {
  const [photos, set] = useState<RecvPhoto[]>([]);
  const [need, setNeed] = useState(true);
  useEffect(() => {
    gate.photos(doId).then(set).catch(() => set([]));
    // 没有仓库权限（采购）读不到设定：当成要拍（资料库照设定检查）
    gate.get(company).then((g) => setNeed(g.recv_photo)).catch(() => setNeed(true));
  }, [doId, company]);
  const has = (kind: RecvPhotoKind, code: string | null | undefined, desc?: string | null) => {
    const k = recvKey(code, desc);
    return photos.some((p) => p.kind === kind && p.item_key === k);
  };
  return { photos, need, doId, company, set, has };
}

/** 一格：已拍几张（缩图）+ 拍照按键；need 而且还没拍 = 红字提醒 */
export function PhotoSlot({ ph, kind, code, desc }: {
  ph: RecvPhotoState; kind: RecvPhotoKind; code: string | null | undefined; desc?: string | null;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const file = useRef<HTMLInputElement>(null);
  const key = recvKey(code, desc);
  const mine = ph.photos.filter((p) => p.kind === kind && p.item_key === key);
  if (key === "D:") return null;

  async function pick(f: File | undefined) {
    if (!f) return;
    setBusy(true); setError("");
    try {
      const path = await uploadRecvPhoto(ph.company, ph.doId, await shrinkPhoto(f, 1280, 0.8));
      ph.set(await gate.addPhoto({ do_id: ph.doId, kind, item_code: code ?? "", description: desc ?? "", path }));
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
    if (file.current) file.current.value = "";
  }
  async function del(id: number) {
    setBusy(true); setError("");
    try { ph.set(await gate.delPhoto(id)); } catch (e) { setError((e as Error).message); }
    setBusy(false);
  }

  return (
    <div className="recv-photo-slot">
      <PhotoThumbs paths={mine.map((p) => p.path)} onRemove={(i) => del(mine[i].id)} />
      <input ref={file} type="file" accept="image/*" capture="environment" hidden onChange={(e) => pick(e.target.files?.[0])} />
      <button type="button" className="small ghost" disabled={busy} onClick={() => file.current?.click()}>
        {busy ? "上传中…" : mine.length ? "📷 再拍一张" : "📷 拍照"}
      </button>
      {ph.need && !mine.length && kind !== "short" && <small className="late">要拍照</small>}
      {error && <small className="late">{error}</small>}
    </div>
  );
}

/** 缩图一排（点开看大图）；onRemove 有给才显示 ✕ */
export function PhotoThumbs({ paths, onRemove }: { paths: string[]; onRemove?: (i: number) => void }) {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const k = paths.join("|");
  useEffect(() => {
    let alive = true;
    paths.filter((p) => !urls[p]).forEach((p) => photoUrl(p).then((u) => alive && setUrls((m) => ({ ...m, [p]: u }))).catch(() => {}));
    return () => { alive = false; };
  }, [k]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!paths.length) return null;
  return (
    <span className="recv-thumbs">
      {paths.map((p, i) => (
        <span key={p} className="recv-thumb">
          {urls[p] ? <a href={urls[p]} target="_blank" rel="noopener"><img src={urls[p]} alt="" /></a> : <span className="muted">📷</span>}
          {onRemove && <button type="button" className="text-btn small" aria-label="拿掉照片" title="拿掉照片" onClick={() => onRemove(i)}>✕</button>}
        </span>
      ))}
    </span>
  );
}

/** 送出前的检查（跟资料库同样的讯息）：坏货 > 0 的型号、每一行来错的货都要有照片 */
export function missingPhotos(ph: RecvPhotoState, damaged: { code: string; n: number }[], wrong: { code: string; desc: string }[]): string[] {
  if (!ph.need) return [];
  const out: string[] = [];
  for (const d of damaged) if (d.n > 0 && !ph.has("damaged", d.code)) out.push(`型号 ${d.code} 有坏货，请先拍照（跟厂家理赔要用）。`);
  for (const w of wrong) {
    if (!ph.has("wrong", w.code, w.desc)) out.push(`来错的货「${w.code.trim() || w.desc.trim()}」请先拍照（跟厂家理赔要用）。`);
  }
  return out;
}
