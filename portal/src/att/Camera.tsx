// 自拍：开前镜头 → 拍 → 确认。iOS 的注意事项移植自 AttendX：
//   * 点按钮后要立刻 getUserMedia（不能先 setTimeout），否则 iOS 会默默拒绝、画面全黑；
//   * 先给 srcObject 再 await play()；
//   * 指定解析度失败（旧 iPhone）就退回只要前镜头、再退回任何镜头。
import { useEffect, useRef, useState } from "react";
import { Modal } from "../ui";

export default function Camera({ title, confirmLabel, busy, error, onConfirm, onClose, children }: {
  title: string;
  confirmLabel: string;
  busy: boolean;
  error: string;
  onConfirm: (photo: Blob) => void;
  onClose: () => void;
  children?: React.ReactNode;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const [photo, setPhoto] = useState<Blob | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [camError, setCamError] = useState("");
  const noCamera = typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia;

  async function start() {
    setCamError("");
    stop();
    const tries: MediaStreamConstraints[] = [
      { video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } }, audio: false },
      { video: { facingMode: "user" }, audio: false },
      { video: true, audio: false },
    ];
    for (const c of tries) {
      try {
        stream.current = await navigator.mediaDevices.getUserMedia(c);
        break;
      } catch { /* 试下一个 */ }
    }
    if (!stream.current) {
      setCamError("开不了相机。请允许这个网页使用相机（iPhone：设定 → Safari → 相机 → 允许），再按「重开相机」。");
      return;
    }
    if (video.current) {
      video.current.srcObject = stream.current;
      try { await video.current.play(); } catch { setCamError("请点一下画面启动相机。"); }
    }
  }
  function stop() {
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
  }
  useEffect(() => {
    if (!noCamera) start();
    return stop;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  function snap() {
    const v = video.current;
    if (!v || !v.videoWidth) {
      setCamError("相机还没准备好，请按「重开相机」再拍。");
      return;
    }
    const w = Math.min(480, v.videoWidth);
    const c = document.createElement("canvas");
    c.width = w;
    c.height = Math.round(v.videoHeight * (w / v.videoWidth));
    const ctx = c.getContext("2d")!;
    ctx.translate(w, 0);   // 前镜头画面是镜像的，存档时转回来
    ctx.scale(-1, 1);
    ctx.drawImage(v, 0, 0, c.width, c.height);
    c.toBlob((b) => {
      if (!b) return;
      setPhoto(b);
      setPreview(URL.createObjectURL(b));
      stop();
    }, "image/jpeg", 0.7);
  }

  function retake() {
    setPhoto(null);
    setPreview(null);
    start();
  }

  return (
    <Modal title={title} onClose={() => { stop(); onClose(); }}>
      <div className="cam">
        {preview ? <img src={preview} alt="" /> : noCamera ? null : (
          <video ref={video} playsInline muted autoPlay onClick={() => video.current?.play()} />
        )}
        {noCamera && !preview && (
          <label className="cam-file">这台手机的浏览器不能直接开相机，请点这里拍照
            <input type="file" accept="image/*" capture="user" onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) { setPhoto(f); setPreview(URL.createObjectURL(f)); }
            }} />
          </label>
        )}
      </div>
      {children}
      {(camError || error) && <div className="error">{error || camError}</div>}
      <div className="actions">
        {!photo && !noCamera && camError && <button className="ghost" onClick={start}>重开相机</button>}
        {!photo && !noCamera && <button onClick={snap}>📷 拍照</button>}
        {photo && <button className="ghost" disabled={busy} onClick={retake}>重拍</button>}
        {photo && <button disabled={busy} onClick={() => onConfirm(photo)}>{busy ? "处理中…" : confirmLabel}</button>}
      </div>
    </Modal>
  );
}
