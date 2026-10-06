import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { fmtNum } from '../lib/format';

// 送货排单(2026-10-06):输入 DO 单号(或电话)→ 顾客资料与送货地址 → 今天要送的单排成最短顺序 → 一键 WhatsApp 整张清单给司机。
// 使用者选的:单据 = Delivery Order;地址只用顾客资料;免费排路线 —— 用 OpenStreetMap(Nominatim)找坐标,坐标存回顾客资料
// 下次不用再找;顺序用直线距离算(最近邻 + 2-opt),不是实际车程。司机不用登入,收到 WhatsApp 清单,每站按连结开 Waze。
// RPC:bi_delivery_lookup / bi_delivery_docs / bi_customer_set_address / bi_customer_set_geo / bi_delivery_settings /
// bi_delivery_set_depot / bi_delivery_driver_save / bi_delivery_run_save / bi_delivery_runs(migration delivery_planner)。

type T = (zh: string, vars?: Record<string, string | number>) => string;
type Hit = {
  doc_no: string | null; company: string | null; doc_date: string | null; debtor_name: string | null; sales_agent: string | null;
  amount: number | null; items: string | null; cancelled: boolean; member_id: string | null;
  name: string | null; address: string | null; lat: number | null; lng: number | null; geo_query: string | null; note: string | null;
};
export type Stop = {
  key: string; doc_no: string | null; member_id: string | null; name: string; phone: string; address: string;
  lat: number | null; lng: number | null; items: string | null; note: string | null; geo: 'ok' | 'none' | 'todo';
};
type Driver = { id: number; name: string; phone: string; store: string | null };
type Depot = { address: string; lat: number; lng: number };
type Run = { id: number; run_date: string; store: string | null; driver_name: string | null; driver_phone: string | null; stops: Stop[]; created_by: string | null };

const STORE: Record<string, string> = { HOMEWORKSSB: 'HQ', HOMEWORKSSOUTHERN: 'JB' };

function phoneOf(member: string | null): string {
  return member && /^[0-9]+$/.test(member) ? member : '';
}

/** 60123456789 → 012-345 6789 */
export function fmtPhone(p: string): string {
  if (!p) return '';
  if (p.startsWith('65') && p.length === 10) return `+65 ${p.slice(2, 6)} ${p.slice(6)}`;
  if (p.startsWith('60')) {
    const d = '0' + p.slice(2);
    return d.startsWith('01') ? `${d.slice(0, 3)}-${d.slice(3, d.length - 4)} ${d.slice(-4)}` : d;
  }
  return p;
}

/** 两点直线距离(公里) */
export function km(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const r = (x: number) => (x * Math.PI) / 180;
  const dLat = r(b.lat - a.lat), dLng = r(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

/** 排最短顺序:从出发点开始找最近的下一站,再用 2-opt 把交叉的路段拉直。没坐标的排在最后。 */
export function orderStops(stops: Stop[], start: { lat: number; lng: number } | null): Stop[] {
  const geo = stops.filter((s) => s.lat != null && s.lng != null) as (Stop & { lat: number; lng: number })[];
  const rest = stops.filter((s) => s.lat == null || s.lng == null);
  if (geo.length < 2) return [...geo, ...rest];
  const left = [...geo];
  const path: typeof geo = [];
  let cur: { lat: number; lng: number } = start ?? left[0];
  while (left.length) {
    let bi = 0;
    for (let i = 1; i < left.length; i++) if (km(cur, left[i]) < km(cur, left[bi])) bi = i;
    cur = left.splice(bi, 1)[0];
    path.push(cur as Stop & { lat: number; lng: number });
  }
  const pts = start ? [start, ...path] : path;
  const off = start ? 1 : 0;
  let improved = true;
  for (let guard = 0; improved && guard < 50; guard++) {
    improved = false;
    for (let i = off; i < pts.length - 1; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const a = pts[i - 1] ?? null, b = pts[i], c = pts[j], d = pts[j + 1] ?? null;   // 最后一站后面没有路段
        const before = (a ? km(a, b) : 0) + (d ? km(c, d) : 0);
        const after = (a ? km(a, c) : 0) + (d ? km(b, d) : 0);
        if (after + 1e-9 < before) {
          pts.splice(i, j - i + 1, ...pts.slice(i, j + 1).reverse());
          improved = true;
        }
      }
    }
  }
  return [...(pts.slice(off) as Stop[]), ...rest];
}

export function routeKm(stops: Stop[], start: { lat: number; lng: number } | null): number {
  let total = 0;
  let prev: { lat: number; lng: number } | null = start;
  for (const s of stops) {
    if (s.lat == null || s.lng == null) continue;
    if (prev) total += km(prev, { lat: s.lat, lng: s.lng });
    prev = { lat: s.lat, lng: s.lng };
  }
  return total;
}

function wazeLink(s: Stop): string {
  return s.lat != null && s.lng != null
    ? `https://waze.com/ul?ll=${s.lat},${s.lng}&navigate=yes`
    : `https://waze.com/ul?q=${encodeURIComponent(s.address)}&navigate=yes`;
}

function gmapPoint(p: { lat?: number | null; lng?: number | null; address?: string }): string {
  return p.lat != null && p.lng != null ? `${p.lat},${p.lng}` : encodeURIComponent(p.address ?? '');
}

/** Google Maps 全程连结;一条最多 9 个中途站,超过就分段 */
export function gmapRoutes(stops: Stop[], depot: Depot | null): string[] {
  const pts: { lat?: number | null; lng?: number | null; address?: string }[] = [...(depot ? [depot] : []), ...stops];
  const out: string[] = [];
  for (let i = 0; i < pts.length - 1; i += 10) {
    const seg = pts.slice(i, Math.min(i + 11, pts.length));
    if (seg.length < 2) break;
    const mid = seg.slice(1, -1).map(gmapPoint).join('%7C');
    out.push(`https://www.google.com/maps/dir/?api=1&travelmode=driving&origin=${gmapPoint(seg[0])}`
      + `&destination=${gmapPoint(seg[seg.length - 1])}${mid ? `&waypoints=${mid}` : ''}`);
  }
  return out;
}

/** 给司机的 WhatsApp 清单 */
export function driverMessage(stops: Stop[], opt: { date: string; driver: string; store: string; depot: Depot | null }): string {
  const total = routeKm(stops, opt.depot);
  const lines = [
    `🚚 HomeWorks 送货单 ${opt.date}`,
    `司机：${opt.driver} · 共 ${stops.length} 站${total ? `（直线约 ${total.toFixed(0)} km）` : ''}`,
    `出发：${opt.store}${opt.depot?.address ? ` ${opt.depot.address}` : ''}`,
    '',
  ];
  stops.forEach((s, i) => {
    lines.push(`${i + 1}. ${s.doc_no ?? '（没有 DO 单号）'}`);
    lines.push(`👤 ${s.name || '-'}${s.phone ? ` · ${fmtPhone(s.phone)}` : ''}`);
    lines.push(`📍 ${s.address || '（没有地址，请先打电话问顾客）'}`);
    if (s.items) lines.push(`🧾 ${s.items}`);
    if (s.note) lines.push(`📝 ${s.note}`);
    if (s.address || s.lat != null) lines.push(`🧭 ${wazeLink(s)}`);
    lines.push('');
  });
  const routes = gmapRoutes(stops, opt.depot);
  if (routes.length) {
    lines.push('🗺️ 全程路线（Google Maps）：');
    routes.forEach((r, i) => lines.push(routes.length > 1 ? `第 ${i + 1} 段：${r}` : r));
  }
  return lines.join('\n');
}

/** 「1.5321, 103.6612」或 Google Maps 连结(…@1.53,103.66… / …q=1.53,103.66…)→ 坐标 */
export function parseCoords(text: string): { lat: number; lng: number } | null {
  const m = text.match(/(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)/);
  if (!m) return null;
  const lat = Number(m[1]), lng = Number(m[2]);
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
}

async function geocode(address: string): Promise<{ lat: number; lng: number } | null> {
  const tries = [
    `q=${encodeURIComponent(address)}&countrycodes=my,sg`,
    ...(address.match(/\b\d{5}\b/) ? [`postalcode=${address.match(/\b\d{5}\b/)![0]}&countrycodes=my`] : []),
  ];
  for (const q of tries) {
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&${q}`, { headers: { 'Accept-Language': 'en' } });
      const j = (await r.json()) as { lat: string; lon: string }[];
      if (j.length) return { lat: Number(j[0].lat), lng: Number(j[0].lon) };
    } catch { /* 网路问题:当作找不到 */ }
    await new Promise((res) => setTimeout(res, 1100));        // OpenStreetMap 规定每秒最多 1 次
  }
  return null;
}

function toStop(h: Hit): Stop {
  return {
    key: h.doc_no ?? `M:${h.member_id}`, doc_no: h.doc_no, member_id: h.member_id,
    name: (h.name ?? h.debtor_name ?? '').replace(/[(（]?\s*\+?\d[\d\s-]{6,}\d\s*[)）]?/g, ' ').replace(/\s+/g, ' ').trim(),
    phone: phoneOf(h.member_id), address: h.address ?? '', lat: h.lat, lng: h.lng, items: h.items, note: h.note,
    geo: h.lat != null && h.lng != null ? 'ok' : 'todo',
  };
}

function localISO(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export default function Delivery({ t, role, onOpen }: { t: T; role: string | null; onOpen: (id: string) => void }) {
  const canManage = role === 'owner' || role === 'manager';
  const [depots, setDepots] = useState<Record<string, Depot>>({});
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [store, setStore] = useState('HQ');
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [day, setDay] = useState(localISO());
  const [dayDocs, setDayDocs] = useState<Hit[] | null>(null);
  const [stops, setStops] = useState<Stop[]>([]);
  const [driverId, setDriverId] = useState('');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [runs, setRuns] = useState<Run[] | null>(null);

  async function loadSettings() {
    const r = await supabase.rpc('bi_delivery_settings');
    if (r.error) { setMsg(r.error.message); return; }
    const d = r.data as { depot: Record<string, Depot>; drivers: Driver[]; company: string | null };
    setDepots(d.depot ?? {});
    setDrivers(d.drivers ?? []);
    if (d.company && STORE[d.company]) setStore(STORE[d.company]);
  }
  useEffect(() => { loadSettings(); }, []);

  const depot = depots[store] ?? null;

  function addStops(list: Hit[]) {
    const add = list.filter((h) => !h.cancelled).map(toStop).filter((s) => !stops.some((x) => x.key === s.key));
    setStops([...stops, ...add]);
    return add.length;
  }

  async function lookup() {
    if (!query.trim()) return;
    setBusy('lookup'); setMsg(null);
    const r = await supabase.rpc('bi_delivery_lookup', { p_query: query });
    setBusy('');
    if (r.error) { setMsg(r.error.message); return; }
    const list = (r.data ?? []) as Hit[];
    if (!list.length) { setMsg(t('找不到 {q}。DO 每 15 分钟从 AutoCount 同步一次,刚开的单请稍后再查。', { q: query })); setHits(null); return; }
    if (list.length === 1 && !list[0].cancelled) { addStops(list); setQuery(''); setHits(null); return; }
    setHits(list);
  }

  async function loadDay() {
    setBusy('day');
    const r = await supabase.rpc('bi_delivery_docs', { p_date: day });
    setBusy('');
    if (r.error) { setMsg(r.error.message); return; }
    setDayDocs((r.data ?? []) as Hit[]);
  }

  function update(key: string, patch: Partial<Stop>) {
    setStops((cur) => cur.map((s) => (s.key === key ? { ...s, ...patch } : s)));
  }

  async function saveAddress(s: Stop, address: string) {
    if (!s.member_id) { update(s.key, { address, lat: null, lng: null, geo: 'todo' }); return; }
    const r = await supabase.rpc('bi_customer_set_address', { p_member: s.member_id, p_address: address });
    if (r.error) { setMsg(r.error.message); return; }
    update(s.key, { address, lat: null, lng: null, geo: 'todo' });
  }

  async function saveCoords(s: Stop, text: string) {
    const c = parseCoords(text);
    if (!c) { setMsg(t('看不懂坐标。请贴 Google Maps 的连结,或像 1.5321, 103.6612 这样的数字。')); return; }
    if (s.member_id) await supabase.rpc('bi_customer_set_geo', { p_member: s.member_id, p_lat: c.lat, p_lng: c.lng, p_query: s.address });
    update(s.key, { ...c, geo: 'ok' });
  }

  async function plan() {
    setBusy('plan'); setMsg(null);
    const cur = [...stops];
    for (let i = 0; i < cur.length; i++) {
      const s = cur[i];
      if (s.lat != null || !s.address) continue;
      setMsg(t('找坐标中… {i}/{n}', { i: i + 1, n: cur.length }));
      const c = await geocode(s.address);
      if (c) {
        cur[i] = { ...s, ...c, geo: 'ok' };
        if (s.member_id) await supabase.rpc('bi_customer_set_geo', { p_member: s.member_id, p_lat: c.lat, p_lng: c.lng, p_query: s.address });
      } else {
        cur[i] = { ...s, geo: 'none' };
      }
    }
    const ordered = orderStops(cur, depot);
    setStops(ordered);
    setBusy('');
    const missing = ordered.filter((s) => s.lat == null).length;
    setMsg(missing
      ? t('已排好。{m} 站找不到位置(排在最后),请贴 Google Maps 坐标或改地址后再按一次。', { m: missing })
      : t('已排好最短顺序(直线距离,约 {k} km)。可以用 ↑ ↓ 微调。', { k: routeKm(ordered, depot).toFixed(0) }));
  }

  function move(i: number, d: number) {
    const j = i + d;
    if (j < 0 || j >= stops.length) return;
    const cur = [...stops];
    [cur[i], cur[j]] = [cur[j], cur[i]];
    setStops(cur);
  }

  const driver = drivers.find((d) => String(d.id) === driverId) ?? null;
  const text = driverMessage(stops, { date: localISO(), driver: driver?.name ?? '-', store, depot });

  async function send() {
    if (!driver) { setMsg(t('请先选司机')); return; }
    const missing = stops.filter((s) => !s.address).length;
    if (missing && !window.confirm(t('有 {m} 站没有地址,还是要传给司机吗?', { m: missing }))) return;
    window.open(`https://wa.me/${driver.phone}?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
    const r = await supabase.rpc('bi_delivery_run_save', { p_store: store, p_driver_id: driver.id, p_stops: stops });
    setMsg(r.error ? r.error.message : t('已打开 WhatsApp,并存进排单纪录。'));
    if (runs) loadRuns();
  }

  async function copy() {
    try { await navigator.clipboard.writeText(text); setMsg(t('清单已复制,可以贴到任何地方。')); }
    catch { setMsg(t('浏览器不让复制,请用「WhatsApp 传给司机」。')); }
  }

  async function loadRuns() {
    const r = await supabase.rpc('bi_delivery_runs', { p_days: 14 });
    setRuns((r.data ?? []) as Run[]);
  }

  return (
    <details className="card card-block lp-delivery" open={stops.length > 0}>
      <summary><h2 style={{ display: 'inline' }}>{t('送货排单')}</h2>
        <span className="muted" style={{ fontSize: 13 }}> {t('输入 DO 单号看顾客地址 → 排最短路线 → WhatsApp 给司机')}</span></summary>

      <div className="filters" style={{ margin: '10px 0' }}>
        <div className="seg">
          {['HQ', 'JB'].map((s) => <button key={s} className={store === s ? 'active' : ''} onClick={() => setStore(s)}>{s}</button>)}
        </div>
        <input placeholder={t('DO 单号或顾客电话')} value={query} onChange={(e) => setQuery(e.target.value)}
               onKeyDown={(e) => { if (e.key === 'Enter') lookup(); }} style={{ minWidth: 200 }} />
        <button className="btn primary" disabled={busy === 'lookup'} onClick={lookup}>{t('查询并加入')}</button>
        <span className="spacer" style={{ flex: 1 }} />
        <input type="date" value={day} onChange={(e) => setDay(e.target.value)} />
        <button className="btn" disabled={busy === 'day'} onClick={loadDay}>{t('列出这天的 DO')}</button>
      </div>

      {hits && (
        <div className="lp-box">
          <b>{t('找到 {n} 笔,按「加入」放进今天的路线:', { n: hits.length })}</b>
          {hits.map((h, i) => (
            <div key={i} className="lp-row" style={{ alignItems: 'center', flexWrap: 'wrap', fontSize: 13 }}>
              <span>{h.doc_no ?? t('(顾客)')} · {toStop(h).name || h.debtor_name} · {fmtPhone(phoneOf(h.member_id))}</span>
              <span className="muted">{h.address || t('没有地址')}</span>
              {h.cancelled ? <span className="lp-tag lp-no">{t('已取消')}</span>
                : <button className="btn" onClick={() => { addStops([h]); }}>{t('加入')}</button>}
              {h.member_id && <button className="btn" onClick={() => onOpen(h.member_id!)}>{t('顾客资料')}</button>}
            </div>
          ))}
          <button className="btn" onClick={() => setHits(null)}>{t('关闭')}</button>
        </div>
      )}

      {dayDocs && (
        <div className="lp-box">
          <b>{t('{d} 的 DO({n} 张)', { d: day, n: dayDocs.length })}</b>
          {dayDocs.length === 0 && <span className="muted">{t('这天没有 DO(或还没同步)')}</span>}
          {dayDocs.map((h) => (
            <div key={h.doc_no!} className="lp-row" style={{ alignItems: 'center', flexWrap: 'wrap', fontSize: 13 }}>
              <span>{h.doc_no} · {toStop(h).name || h.debtor_name}</span>
              <span className="muted">{h.address || t('没有地址')}</span>
              {stops.some((s) => s.key === h.doc_no) ? <span className="muted">{t('已加入')}</span>
                : <button className="btn" onClick={() => addStops([h])}>{t('加入')}</button>}
            </div>
          ))}
          <div className="lp-row">
            <button className="btn primary" onClick={() => { const n = addStops(dayDocs); setMsg(t('加入 {n} 张', { n })); }}>{t('全部加入')}</button>
            <button className="btn" onClick={() => setDayDocs(null)}>{t('关闭')}</button>
          </div>
        </div>
      )}

      {stops.length > 0 && (
        <>
          <div className="table-scroll">
            <table className="data">
              <thead>
                <tr><th>#</th><th>{t('单号')}</th><th>{t('顾客')}</th><th>{t('送货地址')}</th><th>{t('位置')}</th><th /></tr>
              </thead>
              <tbody>
                {stops.map((s, i) => (
                  <StopRow key={s.key} s={s} i={i} n={stops.length} t={t}
                           onMove={(d) => move(i, d)} onRemove={() => setStops(stops.filter((x) => x.key !== s.key))}
                           onAddress={(a) => saveAddress(s, a)} onCoords={(c) => saveCoords(s, c)}
                           onOpen={() => s.member_id && onOpen(s.member_id)} />
                ))}
              </tbody>
            </table>
          </div>
          <div className="filters" style={{ marginTop: 10 }}>
            <button className="btn primary" disabled={!!busy} onClick={plan}>{t('排最短路线')}</button>
            <select value={driverId} onChange={(e) => setDriverId(e.target.value)}>
              <option value="">{t('选司机')}</option>
              {drivers.filter((d) => !d.store || d.store === store).map((d) => (
                <option key={d.id} value={d.id}>{d.name} · {fmtPhone(d.phone)}</option>
              ))}
            </select>
            <button className="btn primary" disabled={!stops.length} onClick={send}>{t('WhatsApp 传给司机')}</button>
            <button className="btn" onClick={copy}>{t('复制清单')}</button>
            <button className="btn" onClick={() => { if (window.confirm(t('清空这次的排单?'))) setStops([]); }}>{t('清空')}</button>
            <span className="muted" style={{ fontSize: 13 }}>
              {t('{n} 站', { n: stops.length })}{routeKm(stops, depot) ? ` · ${t('直线约 {k} km', { k: fmtNum(routeKm(stops, depot), 0) })}` : ''}
            </span>
          </div>
          <details style={{ marginTop: 6 }}>
            <summary className="muted" style={{ fontSize: 13 }}>{t('预览给司机的讯息')}</summary>
            <pre className="lp-pre">{text}</pre>
          </details>
        </>
      )}
      {msg && <div className="notice" style={{ marginTop: 8 }}>{msg}</div>}

      <DeliverySetup t={t} canManage={canManage} store={store} depot={depot} drivers={drivers} onChanged={loadSettings}
                     setMsg={setMsg} />

      <details style={{ marginTop: 8 }} onToggle={(e) => { if ((e.target as HTMLDetailsElement).open && runs === null) loadRuns(); }}>
        <summary className="muted" style={{ fontSize: 13 }}>{t('最近 14 天的排单纪录')}</summary>
        {runs && runs.length === 0 && <div className="muted" style={{ fontSize: 13 }}>{t('还没有纪录')}</div>}
        {runs && runs.map((r) => (
          <div key={r.id} className="lp-row" style={{ alignItems: 'center', fontSize: 13, flexWrap: 'wrap' }}>
            <span>{r.run_date} · {r.store} · {r.driver_name} · {t('{n} 站', { n: r.stops.length })}</span>
            <span className="muted">{r.stops.map((s) => s.doc_no ?? s.name).join(', ')}</span>
            <button className="btn" onClick={() => { setStops(r.stops); if (r.store) setStore(r.store); }}>{t('载入')}</button>
          </div>
        ))}
      </details>
    </details>
  );
}

function StopRow({ s, i, n, t, onMove, onRemove, onAddress, onCoords, onOpen }: {
  s: Stop; i: number; n: number; t: T; onMove: (d: number) => void; onRemove: () => void;
  onAddress: (a: string) => void; onCoords: (c: string) => void; onOpen: () => void;
}) {
  const [addr, setAddr] = useState(s.address);
  const [coords, setCoords] = useState('');
  useEffect(() => { setAddr(s.address); }, [s.address]);
  return (
    <tr>
      <td>{i + 1}</td>
      <td style={{ whiteSpace: 'nowrap' }}>{s.doc_no ?? '–'}</td>
      <td>
        <span className="lp-click" onClick={onOpen}>{s.name || '–'}</span>
        <div className="muted" style={{ fontSize: 12 }}>{fmtPhone(s.phone)}</div>
        {s.items && <div className="muted" style={{ fontSize: 12 }}>{s.items}</div>}
      </td>
      <td style={{ minWidth: 220 }}>
        <textarea rows={2} value={addr} onChange={(e) => setAddr(e.target.value)} placeholder={t('没有地址,请填上(会存进顾客资料)')}
                  style={{ width: '100%', font: 'inherit' }} />
        {addr !== s.address && <button className="btn" onClick={() => onAddress(addr)}>{t('储存地址')}</button>}
      </td>
      <td style={{ fontSize: 12, minWidth: 140 }}>
        {s.lat != null ? <span className="lp-tag lp-yes">✓ {t('有位置')}</span>
          : s.geo === 'none' ? <span className="lp-tag lp-no">{t('找不到')}</span> : <span className="muted">{t('未找')}</span>}
        {s.lat == null && (
          <div className="lp-row" style={{ marginTop: 4 }}>
            <input placeholder={t('贴 Google Maps 坐标')} value={coords} onChange={(e) => setCoords(e.target.value)} style={{ width: 120 }} />
            <button className="btn" onClick={() => onCoords(coords)}>OK</button>
          </div>
        )}
      </td>
      <td style={{ whiteSpace: 'nowrap' }}>
        <button className="btn" disabled={i === 0} onClick={() => onMove(-1)}>↑</button>
        <button className="btn" disabled={i === n - 1} onClick={() => onMove(1)}>↓</button>
        <button className="btn" onClick={onRemove}>✕</button>
      </td>
    </tr>
  );
}

function DeliverySetup({ t, canManage, store, depot, drivers, onChanged, setMsg }: {
  t: T; canManage: boolean; store: string; depot: Depot | null; drivers: Driver[]; onChanged: () => void;
  setMsg: (m: string | null) => void;
}) {
  const [addr, setAddr] = useState(depot?.address ?? '');
  const [coords, setCoords] = useState(depot ? `${depot.lat}, ${depot.lng}` : '');
  const [dname, setDname] = useState('');
  const [dphone, setDphone] = useState('');
  useEffect(() => { setAddr(depot?.address ?? ''); setCoords(depot ? `${depot.lat}, ${depot.lng}` : ''); }, [depot, store]);
  if (!canManage) return null;

  async function saveDepot() {
    let c = parseCoords(coords);
    if (!c && addr) c = await geocode(addr);
    if (!c) { setMsg(t('找不到出发点的位置,请贴 Google Maps 坐标。')); return; }
    const r = await supabase.rpc('bi_delivery_set_depot', { p_store: store, p_address: addr, p_lat: c.lat, p_lng: c.lng });
    setMsg(r.error ? r.error.message : t('出发点已储存。'));
    onChanged();
  }

  async function addDriver() {
    const r = await supabase.rpc('bi_delivery_driver_save', { p_id: null, p_name: dname, p_phone: dphone, p_store: store, p_active: true });
    if (r.error) { setMsg(r.error.message); return; }
    setDname(''); setDphone('');
    onChanged();
  }

  async function removeDriver(d: Driver) {
    if (!window.confirm(t('不再列出司机 {n}?', { n: d.name }))) return;
    const r = await supabase.rpc('bi_delivery_driver_save', { p_id: d.id, p_name: d.name, p_phone: d.phone, p_store: d.store, p_active: false });
    setMsg(r.error ? r.error.message : null);
    onChanged();
  }

  return (
    <details style={{ marginTop: 8 }} open={!depot || drivers.length === 0}>
      <summary className="muted" style={{ fontSize: 13 }}>{t('设定:{s} 出发点与司机', { s: store })}</summary>
      <div className="lp-forms">
        <div className="lp-form">
          <h3>{t('{s} 出发点(仓库 / 门市)', { s: store })}</h3>
          <label>{t('地址')}</label>
          <input value={addr} onChange={(e) => setAddr(e.target.value)} />
          <label>{t('坐标(选填,找不到时贴 Google Maps 的位置)')}</label>
          <input value={coords} onChange={(e) => setCoords(e.target.value)} placeholder="1.5321, 103.6612" />
          <button className="btn primary" onClick={saveDepot}>{t('储存出发点')}</button>
        </div>
        <div className="lp-form">
          <h3>{t('司机')}</h3>
          {drivers.filter((d) => !d.store || d.store === store).map((d) => (
            <div key={d.id} className="lp-row" style={{ alignItems: 'center' }}>
              <span>{d.name} · {fmtPhone(d.phone)}</span>
              <button className="btn" onClick={() => removeDriver(d)}>✕</button>
            </div>
          ))}
          <label>{t('新增司机')}</label>
          <div className="lp-row">
            <input placeholder={t('名字')} value={dname} onChange={(e) => setDname(e.target.value)} />
            <input placeholder={t('手机号码')} value={dphone} onChange={(e) => setDphone(e.target.value)} inputMode="tel" />
            <button className="btn" onClick={addDriver}>{t('新增')}</button>
          </div>
        </div>
      </div>
    </details>
  );
}
