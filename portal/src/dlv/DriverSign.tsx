// 司机签收：每站导航、打电话、逐项打勾对货、拍照、按「已送达 / 送不成」。
// 两种用法：外包司机打开 WhatsApp 里的连结 #/driver?t=<代码>（不用登入，DriverPage）；员工司机登入后在「我的送货」（inApp）。
// 都凭排单时产生的连结代码呼叫 anon 可用的 bi_driver_run / bi_driver_pod；照片先压缩（最长边 1280px、JPEG），
// 上传到 Storage 私有 bucket delivery-pod 的 <代码>/ 资料夹。
// 司机多讲马来文：这页自己带中 / 英 / 马来文，整块标 translate="no"，营运系统的英文翻译层不会再翻一次。
import { useEffect, useMemo, useState } from "react";
import { supabase } from "../supabase";
import { fmtLine, fmtPhone, Line, wazeLink } from "../dlv-api";

type L = "zh" | "en" | "ms";
const TXT: Record<string, Record<L, string>> = {
  title: { zh: "送货签收", en: "Delivery sign-off", ms: "Pengesahan penghantaran" },
  progress: { zh: "已完成 {d} / {n} 站", en: "{d} of {n} stops done", ms: "{d} / {n} hentian selesai" },
  nav: { zh: "导航", en: "Navigate", ms: "Navigasi" },
  call: { zh: "打电话", en: "Call", ms: "Telefon" },
  goods: { zh: "货品（打勾对货）", en: "Goods (tick to check)", ms: "Barang (tanda untuk semak)" },
  note: { zh: "备注", en: "Note", ms: "Nota" },
  docNote: { zh: "单据备注", en: "DO remark", ms: "Catatan DO" },
  photo: { zh: "📷 拍照（顾客签名的单 + 货）", en: "📷 Photo (signed DO + goods)", ms: "📷 Foto (DO bertandatangan + barang)" },
  more: { zh: "再拍一张", en: "Add photo", ms: "Tambah foto" },
  driverNote: { zh: "备注（选填；送不成要写原因）", en: "Note (optional; give a reason if not delivered)", ms: "Nota (pilihan; beri sebab jika gagal)" },
  done: { zh: "✓ 已送达", en: "✓ Delivered", ms: "✓ Dihantar" },
  fail: { zh: "✗ 送不成", en: "✗ Not delivered", ms: "✗ Tidak dihantar" },
  sending: { zh: "上传中…", en: "Uploading…", ms: "Memuat naik…" },
  needReason: { zh: "送不成请写原因（例：顾客不在、地址不对）", en: "Please give a reason (e.g. nobody home, wrong address)", ms: "Sila beri sebab (cth. tiada orang, alamat salah)" },
  noPhoto: { zh: "还没拍照，确定不拍就送出吗？", en: "No photo yet. Send without a photo?", ms: "Tiada foto. Hantar tanpa foto?" },
  delivered: { zh: "已送达", en: "Delivered", ms: "Dihantar" },
  failed: { zh: "送不成", en: "Not delivered", ms: "Tidak dihantar" },
  redo: { zh: "重新签收", en: "Redo", ms: "Buat semula" },
  photos: { zh: "{n} 张照片", en: "{n} photo(s)", ms: "{n} foto" },
  allDone: { zh: "全部完成，辛苦了！", en: "All done. Thank you!", ms: "Semua selesai. Terima kasih!" },
  bad: { zh: "打不开：", en: "Cannot open: ", ms: "Tidak dapat dibuka: " },
  failSend: { zh: "送出失败：", en: "Could not send: ", ms: "Gagal dihantar: " },
  noAddr: { zh: "（没有地址，请打电话问顾客）", en: "(no address, please call the customer)", ms: "(tiada alamat, sila telefon pelanggan)" },
  loading: { zh: "载入中…", en: "Loading…", ms: "Memuatkan…" },
  noLink: { zh: "这个连结不完整，请向店里要新的。", en: "This link is incomplete — ask the shop for a new one.", ms: "Pautan ini tidak lengkap — minta pautan baharu dari kedai." },
  // bi_driver_run / bi_driver_pod 的错误讯息（资料库只有中文）
  expired: { zh: "这个连结已失效，请向店里要新的", en: "This link has expired — ask the shop for a new one.", ms: "Pautan ini telah tamat tempoh — minta pautan baharu dari kedai." },
  noStop: { zh: "这趟没有这一站", en: "This stop is not in this run.", ms: "Hentian ini tiada dalam perjalanan ini." },
  badPhoto: { zh: "照片不对", en: "Photo upload problem — try again.", ms: "Masalah muat naik foto — cuba lagi." },
  tooMany: { zh: "这趟的纪录太多了，请联络店里", en: "Too many records for this run — contact the shop.", ms: "Terlalu banyak rekod untuk perjalanan ini — hubungi kedai." },
};
const KNOWN_ERR: Record<string, string> = {
  "这个连结已失效，请向店里要新的": "expired", "这趟没有这一站": "noStop", "照片不对": "badPhoto", "这趟的纪录太多了，请联络店里": "tooMany",
};

type SignStop = {
  key: string; doc_no: string | null; name: string | null; phone: string | null; address: string | null;
  lat: number | null; lng: number | null; lines: Line[] | null; items: string | null; remark: string | null; dnote: string | null;
  geo?: string | null;   // approx = 坐标只是邮区中心，导航改用地址（bi_driver_run 2026-10-08 起回传）
};
type SignPod = { stop_key: string; status: "delivered" | "failed"; note: string | null; photos: number; at: string };
type SignRun = { run_date: string; store: string | null; driver_name: string | null; stops: SignStop[]; pods: SignPod[] };
type Tf = (k: string, v?: Record<string, string | number>) => string;

/** 语言：司机自己选过的 → 营运系统切过的（员工司机）→ 手机语言（马来文 / 英文）→ 中文 */
function initialLang(): L {
  try {
    const saved = localStorage.getItem("hw-drv-lang");
    if (saved === "zh" || saved === "en" || saved === "ms") return saved;
    const portal = localStorage.getItem("hw-lang");
    if (portal === "zh" || portal === "en") return portal;
  } catch { /* 无痕模式 */ }
  const n = (navigator.language || "").toLowerCase();
  if (n.startsWith("ms") || n.startsWith("id")) return "ms";
  return n.startsWith("en") ? "en" : "zh";
}

/** 手机照片很大（3～8 MB）：缩到最长边 1280px、JPEG 0.7，约 150～300 KB，省流量也省空间 */
export async function compress(file: File, max = 1280, quality = 0.7): Promise<Blob> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((ok, bad) => {
      const i = new Image(); i.onload = () => ok(i); i.onerror = bad; i.src = url;
    });
    const k = Math.min(1, max / Math.max(img.width, img.height));
    const c = document.createElement("canvas");
    c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
    c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
    return await new Promise<Blob>((ok, bad) => c.toBlob((b) => (b ? ok(b) : bad(new Error("toBlob"))), "image/jpeg", quality));
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** 签收地点（选用）：司机没回应定位权限的询问时 getCurrentPosition 会一直等，所以自己 4 秒就放弃 */
function here(): Promise<{ lat: number; lng: number } | null> {
  return new Promise((ok) => {
    if (!navigator.geolocation) { ok(null); return; }
    setTimeout(() => ok(null), 4000);
    navigator.geolocation.getCurrentPosition((p) => ok({ lat: p.coords.latitude, lng: p.coords.longitude }), () => ok(null),
                                             { timeout: 5000, maximumAge: 60000 });
  });
}

/** 不用登入的签收页：#/driver?t=<代码> */
export function DriverPage() {
  const token = new URLSearchParams(window.location.hash.split("?")[1] || "").get("t") || "";
  return <div className="dv-page"><DriverSign token={token} /></div>;
}

export function DriverSign({ token, inApp = false }: { token: string; inApp?: boolean }) {
  const [lang, setLang] = useState<L>(initialLang);   // 每次重新整理都照 initialLang（选过的语言存在 hw-drv-lang）
  const t: Tf = (k, v = {}) => Object.entries(v).reduce((s, [a, b]) => s.replace(`{${a}}`, String(b)), TXT[k][lang]);
  const tErr = (m: string) => (KNOWN_ERR[m] ? t(KNOWN_ERR[m]) : m);
  const [run, setRun] = useState<SignRun | null>(null);
  const [err, setErr] = useState<{ key?: string; raw?: string } | null>(null);   // 存原文，换语言时重新翻

  async function load() {
    if (token.length < 20) { setErr({ key: "noLink" }); return; }
    const r = await supabase.rpc("bi_driver_run", { p_token: token });
    if (r.error) { setErr({ raw: r.error.message }); return; }
    setErr(null);
    setRun(r.data as SignRun);
  }
  useEffect(() => { setRun(null); load(); }, [token]); // eslint-disable-line react-hooks/exhaustive-deps
  function pick(l: L) { setLang(l); try { localStorage.setItem("hw-drv-lang", l); } catch { /* 无痕模式 */ } }

  const podOf = (k: string) => run?.pods.find((p) => p.stop_key === k) ?? null;
  const doneN = run ? run.stops.filter((s) => podOf(s.key)).length : 0;

  return (
    <div className="dv" translate="no">
      <div className="dv-top">
        {inApp ? <span /> : <h1>{t("title")}</h1>}
        <div className="dv-lang">
          {(["zh", "en", "ms"] as L[]).map((l) => (
            <button key={l} className={lang === l ? "on" : ""} onClick={() => pick(l)}>{l === "zh" ? "中" : l.toUpperCase()}</button>
          ))}
        </div>
      </div>
      {err && <div className="card"><div className="error">{t("bad")}{err.key ? t(err.key) : tErr(err.raw ?? "")}</div></div>}
      {!run && !err && <p className="muted">{t("loading")}</p>}
      {run && (
        <>
          <div className="dv-head">
            {run.run_date} · {run.store} · {run.driver_name}
            <div className="dv-bar"><span style={{ width: `${run.stops.length ? (100 * doneN) / run.stops.length : 0}%` }} /></div>
            <b>{doneN === run.stops.length ? t("allDone") : t("progress", { d: doneN, n: run.stops.length })}</b>
          </div>
          {run.stops.map((s, i) => (
            <StopCard key={s.key} s={s} i={i} pod={podOf(s.key)} token={token} t={t} tErr={tErr} onSaved={load} />
          ))}
        </>
      )}
    </div>
  );
}

function Thumb({ file, onRemove }: { file: File; onRemove: () => void }) {
  const url = useMemo(() => URL.createObjectURL(file), [file]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return (
    <span className="dv-thumb">
      <img src={url} alt="" />
      <button type="button" onClick={onRemove}>✕</button>
    </span>
  );
}

function StopCard({ s, i, pod, token, t, tErr, onSaved }: {
  s: SignStop; i: number; pod: SignPod | null; token: string; t: Tf; tErr: (m: string) => string; onSaved: () => void;
}) {
  const [open, setOpen] = useState(!pod);
  const [ticks, setTicks] = useState<boolean[]>([]);
  const [files, setFiles] = useState<File[]>([]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ key?: string; raw?: string } | null>(null);   // 存原文，换语言时重新翻
  useEffect(() => { if (pod) setOpen(false); }, [pod?.at]);

  async function send(status: "delivered" | "failed") {
    setErr(null);
    if (status === "failed" && !note.trim()) { setErr({ key: "needReason" }); return; }
    if (status === "delivered" && !files.length && !window.confirm(t("noPhoto"))) return;
    setBusy(true);
    try {
      const where = here();
      const paths: string[] = [];
      const safe = (s.doc_no ?? s.key).replace(/[^A-Za-z0-9_-]/g, "_");
      for (const [k, f] of files.entries()) {
        const path = `${token}/${safe}-${Date.now()}-${k}.jpg`;
        const up = await supabase.storage.from("delivery-pod").upload(path, await compress(f), { contentType: "image/jpeg" });
        if (up.error) {
          // 连结过期后 Storage 的权限会挡上传（英文的 row-level security 讯息）：照「连结已失效」说
          if (/row-level security|unauthorized|403/i.test(up.error.message)) { setErr({ key: "expired" }); return; }
          throw up.error;
        }
        paths.push(path);
      }
      const g = await where;
      const r = await supabase.rpc("bi_driver_pod", {
        p_token: token, p_key: s.key, p_status: status, p_note: note, p_photos: paths, p_lat: g?.lat ?? null, p_lng: g?.lng ?? null,
      });
      if (r.error) throw r.error;
      setFiles([]); setNote("");
      onSaved();
    } catch (e) {
      setErr({ raw: (e as Error).message || String(e) });
    } finally {
      setBusy(false);
    }
  }

  const phone = s.phone ? (s.phone.startsWith("60") ? "0" + s.phone.slice(2) : "+" + s.phone) : "";
  return (
    <div className={`card dv-stop ${pod ? `dv-${pod.status}` : ""}`}>
      <div className="dv-title" onClick={() => setOpen(!open)}>
        <span className="dv-no">{i + 1}</span>
        <span className="dv-main">
          <b>{s.doc_no ?? "–"}</b> {s.name}
          {pod && <span className={`dv-tag dv-tag-${pod.status}`}>{t(pod.status)}{pod.photos ? ` · ${t("photos", { n: pod.photos })}` : ""}</span>}
        </span>
        <span className="dv-caret">{open ? "▾" : "▸"}</span>
      </div>
      {open && (
        <>
          <div className="dv-addr">📍 {s.address || t("noAddr")}</div>
          <div className="dv-actions">
            {(s.address || s.lat != null) && (
              <a className="dv-btn" href={wazeLink({ lat: s.lat, lng: s.lng, address: s.address, geo: s.geo ?? undefined })} target="_blank" rel="noopener">🧭 {t("nav")}</a>
            )}
            {phone && <a className="dv-btn" href={`tel:${phone}`}>📞 {t("call")} {fmtPhone(s.phone)}</a>}
          </div>
          {s.dnote && <div className="dv-warn">⚠️ {t("note")}：{s.dnote}</div>}
          {s.remark && <div className="dv-muted">📝 {t("docNote")}：{s.remark}</div>}
          {s.lines?.length ? (
            <div className="dv-goods">
              <div className="dv-muted">{t("goods")}</div>
              {s.lines.map((l, k) => (
                <label key={k} className="check dv-line">
                  <input type="checkbox" checked={!!ticks[k]} onChange={(e) => { const x = [...ticks]; x[k] = e.target.checked; setTicks(x); }} />
                  <span>{fmtLine(l)}</span>
                </label>
              ))}
            </div>
          ) : s.items && <div className="dv-muted">🧾 {s.items}</div>}
          <label className="dv-photo">
            <input type="file" accept="image/*" capture="environment" multiple
                   onChange={(e) => { setFiles([...files, ...Array.from(e.target.files ?? [])].slice(0, 6)); e.target.value = ""; }} />
            <span>{files.length ? t("more") : t("photo")}</span>
          </label>
          {files.length > 0 && (
            <div className="dv-thumbs">
              {files.map((f, k) => <Thumb key={`${f.name}-${f.lastModified}-${k}`} file={f} onRemove={() => setFiles(files.filter((_, j) => j !== k))} />)}
            </div>
          )}
          <label className="dv-note">{t("driverNote")}
            <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
          {err && <div className="error">{err.key ? t(err.key) : t("failSend") + tErr(err.raw ?? "")}</div>}
          <div className="dv-actions">
            <button className="dv-ok" disabled={busy} onClick={() => send("delivered")}>{busy ? t("sending") : t("done")}</button>
            <button className="dv-no-btn" disabled={busy} onClick={() => send("failed")}>{t("fail")}</button>
          </div>
        </>
      )}
      {!open && pod && <button className="ghost small dv-redo" onClick={() => setOpen(true)}>{t("redo")}</button>}
    </div>
  );
}
