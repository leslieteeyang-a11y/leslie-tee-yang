// 商品照片：私有 Storage（ops-wh），显示用 1 小时的暂时网址；仓库「可编辑」可以拍照 / 换照片（压到最长边 800px JPEG）。
// ItemMedia = 照片 + 标签，查货卡片、批次页各插一行。
import { useEffect, useRef, useState } from "react";
import { ErrorBox, Modal } from "../ui";
import { Photo, photoUrl, shrinkPhoto, ui, uploadPhoto, whTag } from "../wh-tag-api";
import { ItemTags } from "./ItemTags";
import "../wh-tag.css";

export function ItemMedia({ company, itemCode, canEdit }: { company: string; itemCode: string; canEdit: boolean }) {
  return (
    <div className="wht-media">
      <ItemPhoto company={company} itemCode={itemCode} canEdit={canEdit} />
      <ItemTags company={company} itemCode={itemCode} />
    </div>
  );
}

export function ItemPhoto({ company, itemCode, canEdit }: { company: string; itemCode: string; canEdit: boolean }) {
  const [photo, setPhoto] = useState<Photo | null | undefined>(undefined);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [big, setBig] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    setPhoto(undefined); setUrl(""); setError("");
    whTag.photos(company, [itemCode]).then((m) => alive && setPhoto(m[itemCode] ?? null)).catch((e: Error) => alive && setError(e.message));
    return () => { alive = false; };
  }, [company, itemCode]);
  useEffect(() => {
    let alive = true;
    if (photo?.path) photoUrl(photo.path).then((u) => alive && setUrl(u)).catch(() => alive && setUrl(""));
    return () => { alive = false; };
  }, [photo?.path]);

  async function pick(f: File | undefined) {
    if (!f) return;
    setBusy(true); setError("");
    try {
      const blob = await shrinkPhoto(f);
      const path = await uploadPhoto(company, itemCode, blob);
      const r = await whTag.setPhoto(company, itemCode, path);
      setPhoto(r.photo);
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
    if (file.current) file.current.value = "";
  }
  async function remove() {
    if (!window.confirm(ui("确定拿掉这张照片？"))) return;
    setBusy(true); setError("");
    try { await whTag.removePhoto(company, itemCode); setPhoto(null); setBig(false); }
    catch (e) { setError((e as Error).message); }
    setBusy(false);
  }

  if (photo === undefined && !error) return <div className="wht-photo wht-nophoto" aria-hidden="true" />;
  return (
    <div className="wht-photo-box">
      {photo && url ? (
        <button className="wht-photo" onClick={() => setBig(true)} title="看大图" aria-label="看大图"><img src={url} alt={itemCode} /></button>
      ) : photo ? (
        <div className="wht-photo wht-nophoto" />
      ) : (
        <div className="wht-photo wht-nophoto"><span className="muted small">没有照片</span></div>
      )}
      {canEdit && (
        <>
          <input ref={file} type="file" accept="image/*" capture="environment" hidden onChange={(e) => pick(e.target.files?.[0])} />
          <button className="small ghost" disabled={busy} onClick={() => file.current?.click()}>
            {busy ? "上传中…" : photo ? "📷 换照片" : "📷 拍照"}
          </button>
        </>
      )}
      <ErrorBox error={error} />
      {big && photo && (
        <Modal title={itemCode} onClose={() => setBig(false)}>
          {url && <img className="wht-big" src={url} alt={itemCode} />}
          <p className="muted small">{`${photo.by_name ?? ""} · ${photo.created_at.slice(0, 10)}`}</p>
          {canEdit && <button className="small ghost danger" disabled={busy} onClick={remove}>拿掉照片</button>}
        </Modal>
      )}
    </div>
  );
}
