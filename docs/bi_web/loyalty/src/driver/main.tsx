import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { supabase } from '../lib/supabase';
import { fmtLine, fmtPhone, wazeLink, type Line } from '../pages/Delivery';
import '../join/join.css';
import './driver.css';

// 司机签收拍照(/driver.html?t=<连结代码>,2026-10-07 使用者选的):司机不用帐号,凭排单时 WhatsApp 里的连结打开;
// 连结 3 天后失效。每站:导航、打电话、对货(逐项打勾,只在这支手机)、拍照、按「已送达」或「送不成」(要写原因)。
// 照片先压缩(最长边 1280px、JPEG)再上传到 storage 私有 bucket delivery-pod 的 <连结代码>/ 资料夹,
// 再呼叫 bi_driver_pod 记状态;店里在送货排单页的「排单纪录」看进度与照片。三种语言写在这里,不进主看板的字典。

type L = 'zh' | 'en' | 'ms';
const TXT: Record<string, Record<L, string>> = {
  title: { zh: '送货签收', en: 'Delivery sign-off', ms: 'Pengesahan penghantaran' },
  progress: { zh: '已完成 {d} / {n} 站', en: '{d} of {n} stops done', ms: '{d} / {n} hentian selesai' },
  nav: { zh: '导航', en: 'Navigate', ms: 'Navigasi' },
  call: { zh: '打电话', en: 'Call', ms: 'Telefon' },
  goods: { zh: '货品（打勾对货）', en: 'Goods (tick to check)', ms: 'Barang (tanda untuk semak)' },
  note: { zh: '备注', en: 'Note', ms: 'Nota' },
  docNote: { zh: '单据备注', en: 'DO remark', ms: 'Catatan DO' },
  photo: { zh: '📷 拍照（顾客签名的单 + 货）', en: '📷 Photo (signed DO + goods)', ms: '📷 Foto (DO bertandatangan + barang)' },
  more: { zh: '再拍一张', en: 'Add photo', ms: 'Tambah foto' },
  driverNote: { zh: '备注（选填；送不成要写原因）', en: 'Note (optional; give a reason if not delivered)', ms: 'Nota (pilihan; beri sebab jika gagal)' },
  done: { zh: '✓ 已送达', en: '✓ Delivered', ms: '✓ Dihantar' },
  fail: { zh: '✗ 送不成', en: '✗ Not delivered', ms: '✗ Tidak dihantar' },
  sending: { zh: '上传中…', en: 'Uploading…', ms: 'Memuat naik…' },
  needReason: { zh: '送不成请写原因（例：顾客不在、地址不对）', en: 'Please give a reason (e.g. nobody home, wrong address)', ms: 'Sila beri sebab (cth. tiada orang, alamat salah)' },
  noPhoto: { zh: '还没拍照，确定不拍就送出吗？', en: 'No photo yet. Send without a photo?', ms: 'Tiada foto. Hantar tanpa foto?' },
  delivered: { zh: '已送达', en: 'Delivered', ms: 'Dihantar' },
  failed: { zh: '送不成', en: 'Not delivered', ms: 'Tidak dihantar' },
  redo: { zh: '重新签收', en: 'Redo', ms: 'Buat semula' },
  photos: { zh: '{n} 张照片', en: '{n} photo(s)', ms: '{n} foto' },
  allDone: { zh: '全部完成，辛苦了！', en: 'All done. Thank you!', ms: 'Semua selesai. Terima kasih!' },
  bad: { zh: '打不开：', en: 'Cannot open: ', ms: 'Tidak dapat dibuka: ' },
  failSend: { zh: '送出失败：', en: 'Could not send: ', ms: 'Gagal dihantar: ' },
  noAddr: { zh: '（没有地址，请打电话问顾客）', en: '(no address, please call the customer)', ms: '(tiada alamat, sila telefon pelanggan)' },
  loading: { zh: '载入中…', en: 'Loading…', ms: 'Memuatkan…' },
};

type Stop = {
  key: string; doc_no: string | null; name: string | null; phone: string | null; address: string | null;
  lat: number | null; lng: number | null; lines: Line[] | null; items: string | null; remark: string | null; dnote: string | null;
};
type Pod = { stop_key: string; status: 'delivered' | 'failed'; note: string | null; photos: number; at: string };
type Run = { run_date: string; store: string | null; driver_name: string | null; stops: Stop[]; pods: Pod[] };

function initialLang(): L {
  const saved = (() => { try { return localStorage.getItem('drv_lang'); } catch { return null; } })();
  if (saved === 'zh' || saved === 'en' || saved === 'ms') return saved;
  const n = (navigator.language || '').toLowerCase();
  return n.startsWith('ms') || n.startsWith('id') ? 'ms' : n.startsWith('en') ? 'en' : 'zh';
}

/** 手机照片很大(3～8MB):缩到最长边 1280px、JPEG 0.7,约 150～300KB,省流量也省空间 */
export async function compress(file: File, max = 1280, quality = 0.7): Promise<Blob> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((ok, bad) => {
      const i = new Image(); i.onload = () => ok(i); i.onerror = bad; i.src = url;
    });
    const k = Math.min(1, max / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
    return await new Promise<Blob>((ok, bad) => c.toBlob((b) => (b ? ok(b) : bad(new Error('toBlob'))), 'image/jpeg', quality));
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** 签收地点(选用):司机没回应定位权限的询问时 getCurrentPosition 会一直等,所以自己 4 秒就放弃 */
function here(): Promise<{ lat: number; lng: number } | null> {
  return new Promise((ok) => {
    if (!navigator.geolocation) { ok(null); return; }
    setTimeout(() => ok(null), 4000);
    navigator.geolocation.getCurrentPosition((p) => ok({ lat: p.coords.latitude, lng: p.coords.longitude }), () => ok(null),
                                             { timeout: 5000, maximumAge: 60000 });
  });
}

function Driver() {
  const [lang, setLang] = useState<L>(initialLang);
  const t = (k: string, v: Record<string, string | number> = {}) =>
    Object.entries(v).reduce((s, [a, b]) => s.replace(`{${a}}`, String(b)), TXT[k][lang]);
  const token = new URLSearchParams(location.search).get('t') || '';
  const [run, setRun] = useState<Run | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    const r = await supabase.rpc('bi_driver_run', { p_token: token });
    if (r.error) { setErr(r.error.message); return; }
    setRun(r.data as Run);
  }
  useEffect(() => { load(); }, []);
  function pick(l: L) { setLang(l); try { localStorage.setItem('drv_lang', l); } catch { /* 无痕模式 */ } }

  const podOf = (k: string) => run?.pods.find((p) => p.stop_key === k) ?? null;
  const doneN = run ? run.stops.filter((s) => podOf(s.key)).length : 0;

  return (
    <div className="jn dv">
      <div className="jn-top">
        <h1>{t('title')}</h1>
        <div className="jn-lang">
          {(['zh', 'en', 'ms'] as L[]).map((l) => (
            <button key={l} className={lang === l ? 'on' : ''} onClick={() => pick(l)}>{l === 'zh' ? '中文' : l.toUpperCase()}</button>
          ))}
        </div>
      </div>
      {err && <div className="jn-card"><div className="jn-err">{t('bad')}{err}</div></div>}
      {!run && !err && <div className="jn-small">{t('loading')}</div>}
      {run && (
        <>
          <div className="dv-head">
            {run.run_date} · {run.store} · {run.driver_name}
            <div className="dv-bar"><span style={{ width: `${run.stops.length ? (100 * doneN) / run.stops.length : 0}%` }} /></div>
            <b>{doneN === run.stops.length ? t('allDone') : t('progress', { d: doneN, n: run.stops.length })}</b>
          </div>
          {run.stops.map((s, i) => (
            <StopCard key={s.key} s={s} i={i} pod={podOf(s.key)} token={token} t={t} onSaved={load} />
          ))}
        </>
      )}
    </div>
  );
}

function StopCard({ s, i, pod, token, t, onSaved }: {
  s: Stop; i: number; pod: Pod | null; token: string; t: (k: string, v?: Record<string, string | number>) => string; onSaved: () => void;
}) {
  const [open, setOpen] = useState(!pod);
  const [ticks, setTicks] = useState<boolean[]>([]);
  const [files, setFiles] = useState<File[]>([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (pod) setOpen(false); }, [pod?.at]);

  async function send(status: 'delivered' | 'failed') {
    setErr(null);
    if (status === 'failed' && !note.trim()) { setErr(t('needReason')); return; }
    if (status === 'delivered' && !files.length && !window.confirm(t('noPhoto'))) return;
    setBusy(true);
    try {
      const where = here();
      const paths: string[] = [];
      const safe = (s.doc_no ?? s.key).replace(/[^A-Za-z0-9_-]/g, '_');
      for (const [k, f] of files.entries()) {
        const path = `${token}/${safe}-${Date.now()}-${k}.jpg`;
        const up = await supabase.storage.from('delivery-pod').upload(path, await compress(f), { contentType: 'image/jpeg' });
        if (up.error) throw up.error;
        paths.push(path);
      }
      const g = await where;
      const r = await supabase.rpc('bi_driver_pod', {
        p_token: token, p_key: s.key, p_status: status, p_note: note, p_photos: paths, p_lat: g?.lat ?? null, p_lng: g?.lng ?? null,
      });
      if (r.error) throw r.error;
      setFiles([]); setNote('');
      onSaved();
    } catch (e) {
      setErr(t('failSend') + ((e as Error).message || String(e)));
    } finally {
      setBusy(false);
    }
  }

  const phone = s.phone ? (s.phone.startsWith('60') ? '0' + s.phone.slice(2) : '+' + s.phone) : '';
  return (
    <div className={`jn-card dv-stop ${pod ? `dv-${pod.status}` : ''}`}>
      <div className="dv-title" onClick={() => setOpen(!open)}>
        <span className="dv-no">{i + 1}</span>
        <span className="dv-main">
          <b>{s.doc_no ?? '–'}</b> {s.name}
          {pod && <span className={`dv-tag dv-tag-${pod.status}`}>{t(pod.status)}{pod.photos ? ` · ${t('photos', { n: pod.photos })}` : ''}</span>}
        </span>
        <span className="dv-caret">{open ? '▾' : '▸'}</span>
      </div>
      {open && (
        <>
          <div className="dv-addr">📍 {s.address || t('noAddr')}</div>
          <div className="dv-actions">
            {(s.address || s.lat != null) && (
              <a className="dv-btn" href={wazeLink({ lat: s.lat, lng: s.lng, address: s.address ?? '' })} target="_blank" rel="noopener">🧭 {t('nav')}</a>
            )}
            {phone && <a className="dv-btn" href={`tel:${phone}`}>📞 {t('call')} {fmtPhone(s.phone!)}</a>}
          </div>
          {s.dnote && <div className="dv-warn">⚠️ {t('note')}：{s.dnote}</div>}
          {s.remark && <div className="dv-muted">📝 {t('docNote')}：{s.remark}</div>}
          {s.lines?.length ? (
            <div className="dv-goods">
              <div className="dv-muted">{t('goods')}</div>
              {s.lines.map((l, k) => (
                <label key={k} className="jn-check dv-line">
                  <input type="checkbox" checked={!!ticks[k]} onChange={(e) => { const x = [...ticks]; x[k] = e.target.checked; setTicks(x); }} />
                  <span>{fmtLine(l)}</span>
                </label>
              ))}
            </div>
          ) : s.items && <div className="dv-muted">🧾 {s.items}</div>}
          <label className="dv-photo">
            <input type="file" accept="image/*" capture="environment" multiple
                   onChange={(e) => { setFiles([...files, ...Array.from(e.target.files ?? [])].slice(0, 6)); e.target.value = ''; }} />
            <span>{files.length ? t('more') : t('photo')}</span>
          </label>
          {files.length > 0 && (
            <div className="dv-thumbs">
              {files.map((f, k) => (
                <span key={k} className="dv-thumb">
                  <img src={URL.createObjectURL(f)} alt="" />
                  <button onClick={() => setFiles(files.filter((_, j) => j !== k))}>✕</button>
                </span>
              ))}
            </div>
          )}
          <label>{t('driverNote')}</label>
          <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
          {err && <div className="jn-err">{err}</div>}
          <div className="dv-actions">
            <button className="jn-go dv-ok" disabled={busy} onClick={() => send('delivered')}>{busy ? t('sending') : t('done')}</button>
            <button className="jn-go dv-no-btn" disabled={busy} onClick={() => send('failed')}>{t('fail')}</button>
          </div>
        </>
      )}
      {!open && pod && <button className="dv-link" onClick={() => setOpen(true)}>{t('redo')}</button>}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><Driver /></React.StrictMode>);
