// 扫条码：开后镜头，读到就回传。Android Chrome 用内建的 BarcodeDetector；iPhone（Safari 没有）才载入 ZXing（另一个档，不拖慢首页）。
// 也可以接蓝牙扫描枪：扫描枪就是键盘，在 ScanBox 的输入框扫完会自动送出 Enter。
import { FormEvent, useEffect, useRef, useState } from "react";
import { Modal } from "../ui";

type Detector = { detect: (src: HTMLVideoElement) => Promise<{ rawValue: string }[]> };

export function Scanner({ title, onCode, onClose }: { title: string; onCode: (code: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState("");
  const [torch, setTorch] = useState<boolean | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const done = useRef(false);
  const cb = useRef(onCode);
  cb.current = onCode;

  useEffect(() => {
    let stopZxing: (() => void) | null = null;
    let timer = 0;
    const finish = (code: string) => {
      if (done.current || !code.trim()) return;
      done.current = true;
      navigator.vibrate?.(80);
      cb.current(code.trim());
    };
    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError("这台手机的浏览器不能开相机，请直接在输入框打商品代号。");
        return;
      }
      const tries: MediaStreamConstraints[] = [
        { video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false },
        { video: { facingMode: "environment" }, audio: false },
        { video: true, audio: false },
      ];
      for (const c of tries) {
        try { stream.current = await navigator.mediaDevices.getUserMedia(c); break; } catch { /* 试下一个 */ }
      }
      const v = video.current;
      if (!stream.current || !v) {
        setError("开不了相机。请允许这个网页使用相机（iPhone：设定 → Safari → 相机 → 允许），再试一次。");
        return;
      }
      v.srcObject = stream.current;
      try { await v.play(); } catch { /* 点画面再播 */ }
      const track = stream.current.getVideoTracks()[0];
      const caps = (track?.getCapabilities?.() || {}) as { torch?: boolean };
      if (caps.torch) setTorch(false);

      const BD = (window as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => Detector }).BarcodeDetector;
      if (BD) {
        const det = new BD({ formats: ["code_128", "ean_13", "ean_8", "upc_a", "upc_e", "code_39", "qr_code", "itf"] });
        const loop = async () => {
          if (done.current) return;
          try {
            if (v.readyState >= 2) {
              const r = await det.detect(v);
              if (r[0]?.rawValue) return finish(r[0].rawValue);
            }
          } catch { /* 下一张 */ }
          timer = window.setTimeout(loop, 120);
        };
        loop();
      } else {
        try {
          const { BrowserMultiFormatReader } = await import("@zxing/browser");
          const reader = new BrowserMultiFormatReader();
          const ctl = await reader.decodeFromVideoElement(v, (res) => { if (res) finish(res.getText()); });
          stopZxing = () => ctl.stop();
        } catch {
          setError("这台手机读不了条码，请直接在输入框打商品代号。");
        }
      }
    })();
    return () => {
      done.current = true;
      clearTimeout(timer);
      stopZxing?.();
      stream.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  async function toggleTorch() {
    const track = stream.current?.getVideoTracks()[0];
    if (!track) return;
    try {
      await track.applyConstraints({ advanced: [{ torch: !torch } as MediaTrackConstraintSet] });
      setTorch(!torch);
    } catch { setTorch(null); }
  }

  return (
    <Modal title={title} onClose={onClose}>
      <div className="cam scan">
        <video ref={video} playsInline muted autoPlay onClick={() => video.current?.play()} />
        <div className="scan-line" />
      </div>
      <p className="muted small">把条码放在框里、离手机 10–20 公分；读到会震一下。</p>
      {error && <div className="error">{error}</div>}
      <div className="actions">
        {torch !== null && <button className="ghost" onClick={toggleTorch}>{torch ? "关手电筒" : "开手电筒"}</button>}
        <button className="ghost" onClick={onClose}>取消</button>
      </div>
    </Modal>
  );
}

/** 输入框 + 「扫码」按钮：打字或扫描枪按 Enter 送出；按扫码开相机 */
export function ScanBox({ placeholder, onCode, autoFocus, busy }: {
  placeholder?: string; onCode: (code: string) => void; autoFocus?: boolean; busy?: boolean;
}) {
  const [text, setText] = useState("");
  const [scanning, setScanning] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  function submit(e: FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    onCode(text.trim());
    setText("");
  }
  return (
    <>
      <form className="scanbox" onSubmit={submit}>
        <button type="button" className="scan-btn" onClick={() => setScanning(true)} disabled={busy}>▦ 扫码</button>
        <input ref={input} value={text} onChange={(e) => setText(e.target.value)} autoFocus={autoFocus}
               placeholder={placeholder || "扫码，或打商品代号 / 品名"} enterKeyHint="search" autoCapitalize="characters" />
        <button disabled={busy || !text.trim()}>找</button>
      </form>
      {scanning && (
        <Scanner title="扫条码" onClose={() => setScanning(false)}
                 onCode={(c) => { setScanning(false); onCode(c); }} />
      )}
    </>
  );
}
