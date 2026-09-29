import { Fragment, useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import { fmtRM, fmtNum, fmtDate } from '../lib/format';
import { Kpi } from '../components/ChartCard';
import { tr, type Lang } from '../lib/i18n';

// 顾客资料(2026-09-29 取代积分):门市散客用电话当顾客编号,总部 + JB 合并。购买历史从 bi.fact_sales 现算,
// 员工补的资料(名字、生日、地区、地址、类型、备注)存 bi.customer_profile(RPC public.bi_customer*,migration customer_profiles)。
// 做促销:筛选后汇出 CSV(Excel 可开)。档名沿用 Loyalty.tsx / loyalty.html,因为线上已有这个网址。

type Customer = {
  member_id: string; name: string | null; stores: string | null; first_date: string | null; last_date: string | null;
  doc_count: number; spent: number; spent_12m: number; categories: string[];
  birth_month: number | null; birth_day: number | null; area: string | null; address: string | null;
  customer_type: string | null; note: string | null; profile_updated_at: string | null;
};
type Item = { item_code: string | null; description: string | null; qty: number; uom: string | null; sub_total: number };
type Doc = {
  company: string; doc_type: string; doc_no: string; doc_date: string; debtor_code: string; debtor_name: string | null;
  sales_agent: string | null; amount: number; items: Item[];
};
type Profile = {
  name: string | null; birth_month: number | null; birth_day: number | null; area: string | null; address: string | null;
  customer_type: string | null; note: string | null; updated_at: string; updated_by: string | null;
};
type Detail = { member_id: string; profile: Profile | null; docs: Doc[] };
type Missing = {
  company: string; doc_type: string; doc_no: string; doc_date: string; debtor_code: string;
  debtor_name: string | null; sales_agent: string | null; amount: number;
};
type T = (zh: string, vars?: Record<string, string | number>) => string;

const n = (v: unknown) => Number(v ?? 0);
const STORE: Record<string, string> = { HOMEWORKSSB: 'HQ', HOMEWORKSSOUTHERN: 'JB' };
export const TYPES = ['屋主', '设计师', '承包商', '水工', '公司', '其他'];

/** 60123456789 → 012-345 6789;6591234567 → +65 9123 4567;A:公司:代号 → 代号 (HQ) */
export function fmtMember(id: string): string {
  if (id.startsWith('A:')) {
    const [, co, code] = id.split(':');
    return `${code} (${STORE[co] ?? co})`;
  }
  if (id.startsWith('65') && id.length === 10) return `+65 ${id.slice(2, 6)} ${id.slice(6)}`;
  if (id.startsWith('60')) {
    const d = '0' + id.slice(2);
    if (d.startsWith('01')) return `${d.slice(0, 3)}-${d.slice(3, d.length - 4)} ${d.slice(-4)}`;
    return `${d.slice(0, 2)}-${d.slice(2)}`;
  }
  return id;
}

/** 给 WhatsApp 用的国际格式:60123456789 → +60123456789;账号型顾客没有电话 → 空 */
export function waNumber(id: string): string {
  return /^[0-9]+$/.test(id) ? `+${id}` : '';
}

/** 单据上的客户名称常夹着电话:「ZILONG (017-7000190)」→「ZILONG」 */
export function cleanName(raw: string | null | undefined): string {
  return (raw ?? '').replace(/[(（]?\s*\+?\d[\d\s-]{6,}\d\s*[)）]?/g, ' ').replace(/[()（）]\s*[)）]?/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function daysSince(d: string | null): number {
  if (!d) return Infinity;
  return (Date.now() - new Date(d + 'T00:00:00').getTime()) / 86400000;
}

function csvCell(v: unknown): string {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadCsv(filename: string, header: string[], rows: unknown[][]) {
  const text = '﻿' + [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

type Filters = {
  q: string; store: string; recency: string; minSpent: string; category: string; ctype: string; area: string; bmonth: string;
};
const EMPTY: Filters = { q: '', store: '', recency: '', minSpent: '', category: '', ctype: '', area: '', bmonth: '' };

export function applyFilters(list: Customer[], f: Filters): Customer[] {
  const text = f.q.trim().toLowerCase();
  const digits = f.q.replace(/\D/g, '').replace(/^0/, '');
  const min = n(f.minSpent);
  return list.filter((c) => {
    if (text && !((digits.length >= 4 && c.member_id.includes(digits)) || (c.name ?? '').toLowerCase().includes(text)
      || (c.note ?? '').toLowerCase().includes(text))) return false;
    if (f.store === 'HQ' && !(c.stores ?? '').includes('HQ')) return false;
    if (f.store === 'JB' && !(c.stores ?? '').includes('JB')) return false;
    if (f.store === 'both' && c.stores !== 'HQ + JB') return false;
    const age = daysSince(c.last_date);
    if (f.recency === '90' && age > 90) return false;
    if (f.recency === '180' && age > 180) return false;
    if (f.recency === '365' && age > 365) return false;
    if (f.recency === 'lapsed' && !(age > 365 && isFinite(age))) return false;
    if (f.recency === 'none' && isFinite(age)) return false;
    if (min && n(c.spent) < min) return false;
    if (f.category && !c.categories.includes(f.category)) return false;
    if (f.ctype === '-' ? c.customer_type : f.ctype && c.customer_type !== f.ctype) return false;
    if (f.area && !`${c.area ?? ''} ${c.address ?? ''}`.toLowerCase().includes(f.area.trim().toLowerCase())) return false;
    if (f.bmonth && c.birth_month !== n(f.bmonth)) return false;
    return true;
  });
}

export default function Loyalty({ lang, role }: { lang: Lang; role: string | null; company: string | null }) {
  const t: T = (zh, vars) => tr(lang, zh, vars);
  const canExport = role === 'owner' || role === 'manager';

  const [list, setList] = useState<Customer[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [f, setF] = useState<Filters>(EMPTY);
  const [sort, setSort] = useState<'recent' | 'spent' | 'name'>('recent');
  const [shown, setShown] = useState(100);
  const [sel, setSel] = useState<string | null>(null);
  const [newPhone, setNewPhone] = useState('');

  async function load() {
    const r = await supabase.rpc('bi_customers');
    setErr(r.error ? r.error.message : null);
    setList((r.data ?? []) as Customer[]);
  }
  useEffect(() => { load(); }, []);

  const set = (k: keyof Filters) => (e: { target: { value: string } }) => { setF({ ...f, [k]: e.target.value }); setShown(100); };
  const categories = useMemo(() => Array.from(new Set((list ?? []).flatMap((c) => c.categories))).sort(), [list]);
  const filtered = useMemo(() => {
    const out = applyFilters(list ?? [], f);
    if (sort === 'spent') out.sort((a, b) => n(b.spent) - n(a.spent));
    else if (sort === 'name') out.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
    else out.sort((a, b) => ((a.last_date ?? '') < (b.last_date ?? '') ? 1 : (a.last_date ?? '') > (b.last_date ?? '') ? -1 : 0));
    return out;
  }, [list, f, sort]);

  const month = new Date().getMonth() + 1;
  const totals = useMemo(() => {
    const all = list ?? [];
    return {
      count: all.length,
      active: all.filter((c) => daysSince(c.last_date) <= 365).length,
      profiled: all.filter((c) => c.profile_updated_at).length,
      birthday: all.filter((c) => c.birth_month === month).length,
    };
  }, [list, month]);

  function exportCsv() {
    downloadCsv(`customers_${new Date().toISOString().slice(0, 10)}.csv`,
      [t('电话(WhatsApp)'), t('电话'), t('名字'), t('类型'), t('地区'), t('地址'), t('生日'), t('门市'), t('首次消费'),
        t('最后消费'), t('单数'), t('累计消费'), t('近 12 个月'), t('买过类别'), t('备注')],
      filtered.map((c) => [waNumber(c.member_id), fmtMember(c.member_id), cleanName(c.name), c.customer_type, c.area, c.address,
        c.birth_month ? `${c.birth_month}/${c.birth_day}` : '', c.stores, c.first_date, c.last_date, c.doc_count,
        n(c.spent).toFixed(2), n(c.spent_12m).toFixed(2), c.categories.join(' '), c.note]));
  }

  function openNew() {
    const digits = newPhone.replace(/\D/g, '');
    if (digits.length < 8) return;
    setSel(newPhone.trim());
    setNewPhone('');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  if (list === null) return <div className="loading">{t('载入中…')}</div>;

  return (
    <>
      {err && <div className="notice">{t('查询失败:')}{err}</div>}
      <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
        {t('门市顾客以电话认人,总部与 JB 合并;购买纪录每天中午从 AutoCount 同步。开单时客户名称写「名字 + 手机号」,顾客才会出现在这里。')}
      </p>

      <div className="grid-kpi">
        <Kpi label={t('顾客人数')} value={fmtNum(totals.count)} sub={t('近 12 个月有消费 {a} 位', { a: fmtNum(totals.active) })} />
        <Kpi label={t('已补资料')} value={fmtNum(totals.profiled)} sub={t('有填名字 / 生日 / 地区等')} />
        <Kpi label={t('本月生日')} value={fmtNum(totals.birthday)} sub={t('{m} 月', { m: month })} />
      </div>

      {sel && <CustomerPanel key={sel} id={sel} t={t} onClose={() => setSel(null)} onSaved={load} />}

      <div className="card card-block">
        <h2>{t('顾客')}</h2>
        <div className="filters" style={{ marginBottom: 8 }}>
          <input placeholder={t('电话、名字或备注')} value={f.q} onChange={set('q')} style={{ minWidth: 200 }} />
          <select value={f.store} onChange={set('store')}>
            <option value="">{t('全部门市')}</option>
            <option value="HQ">HQ</option>
            <option value="JB">JB</option>
            <option value="both">{t('两边都买过')}</option>
          </select>
          <select value={f.recency} onChange={set('recency')}>
            <option value="">{t('不限最后消费')}</option>
            <option value="90">{t('3 个月内来过')}</option>
            <option value="180">{t('6 个月内来过')}</option>
            <option value="365">{t('12 个月内来过')}</option>
            <option value="lapsed">{t('超过 12 个月没来')}</option>
            <option value="none">{t('还没买过')}</option>
          </select>
          <select value={f.category} onChange={set('category')}>
            <option value="">{t('全部类别')}</option>
            {categories.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <select value={f.ctype} onChange={set('ctype')}>
            <option value="">{t('全部类型')}</option>
            {TYPES.map((x) => <option key={x} value={x}>{t(x)}</option>)}
            <option value="-">{t('未分类')}</option>
          </select>
          <select value={f.bmonth} onChange={set('bmonth')}>
            <option value="">{t('生日月份')}</option>
            {Array.from({ length: 12 }, (_, i) => <option key={i} value={i + 1}>{t('{m} 月', { m: i + 1 })}</option>)}
          </select>
          <input placeholder={t('地区')} value={f.area} onChange={set('area')} style={{ width: 110 }} />
          <input placeholder={t('累计消费至少 RM')} value={f.minSpent} onChange={set('minSpent')} inputMode="numeric" style={{ width: 150 }} />
          <button className="btn" onClick={() => setF(EMPTY)}>{t('清除筛选')}</button>
        </div>
        <div className="filters" style={{ marginBottom: 8 }}>
          <div className="seg">
            <button className={sort === 'recent' ? 'active' : ''} onClick={() => setSort('recent')}>{t('最近消费')}</button>
            <button className={sort === 'spent' ? 'active' : ''} onClick={() => setSort('spent')}>{t('消费最多')}</button>
            <button className={sort === 'name' ? 'active' : ''} onClick={() => setSort('name')}>{t('名字')}</button>
          </div>
          <span className="muted" style={{ fontSize: 13 }}>{t('符合 {n} 位', { n: fmtNum(filtered.length) })}</span>
          {canExport && <button className="btn primary" onClick={exportCsv} disabled={!filtered.length}>{t('汇出名单 (Excel)')}</button>}
          <span className="spacer" style={{ flex: 1 }} />
          <input placeholder={t('新顾客电话')} value={newPhone} onChange={(e) => setNewPhone(e.target.value)}
                 onKeyDown={(e) => { if (e.key === 'Enter') openNew(); }} style={{ width: 150 }} />
          <button className="btn" onClick={openNew}>{t('新增顾客')}</button>
        </div>
        <div className="table-scroll">
          <table className="data">
            <thead>
              <tr>
                <th>{t('电话 / 账号')}</th><th>{t('名字')}</th><th>{t('类型')}</th><th>{t('地区')}</th><th>{t('门市')}</th>
                <th>{t('最后消费')}</th><th className="num">{t('累计消费')}</th><th className="num">{t('近 12 个月')}</th><th>{t('买过类别')}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && <tr><td colSpan={9} className="muted">{t('没有符合的顾客')}</td></tr>}
              {filtered.slice(0, shown).map((c) => (
                <tr key={c.member_id} className="lp-click" onClick={() => { setSel(c.member_id); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>
                  <td style={{ whiteSpace: 'nowrap' }}>{fmtMember(c.member_id)}</td>
                  <td>{cleanName(c.name)}</td>
                  <td>{c.customer_type ? t(c.customer_type) : ''}</td>
                  <td>{c.area}</td>
                  <td>{c.stores}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(c.last_date)}</td>
                  <td className="num">{fmtNum(c.spent, 2)}</td>
                  <td className={'num' + (n(c.spent_12m) ? '' : ' muted')}>{n(c.spent_12m) ? fmtNum(c.spent_12m, 2) : '–'}</td>
                  <td className="muted" style={{ fontSize: 12 }}>{c.categories.join(' · ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {filtered.length > shown && (
          <button className="btn" style={{ marginTop: 8 }} onClick={() => setShown(shown + 200)}>{t('显示更多')}</button>
        )}
      </div>

      <MissingPhone t={t} />
    </>
  );
}

function CustomerPanel({ id, t, onClose, onSaved }: { id: string; t: T; onClose: () => void; onSaved: () => void }) {
  const [d, setD] = useState<Detail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ name: '', bm: '', bd: '', area: '', address: '', ctype: '', note: '' });

  async function load() {
    const r = await supabase.rpc('bi_customer', { p_member: id });
    if (r.error) { setErr(r.error.message); return; }
    const det = r.data as Detail;
    setErr(null);
    setD(det);
    const p = det.profile;
    setForm({
      name: p?.name ?? cleanName(det.docs[0]?.debtor_name), bm: p?.birth_month ? String(p.birth_month) : '',
      bd: p?.birth_day ? String(p.birth_day) : '', area: p?.area ?? '', address: p?.address ?? '',
      ctype: p?.customer_type ?? '', note: p?.note ?? '',
    });
  }
  useEffect(() => { load(); }, [id]);

  const upd = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  async function save() {
    if (!!form.bm !== !!form.bd) { setMsg(t('生日要月、日都填,或都不填')); return; }
    setBusy(true);
    const r = await supabase.rpc('bi_customer_save', {
      p_member: d?.member_id ?? id, p_name: form.name, p_birth_month: form.bm ? n(form.bm) : null,
      p_birth_day: form.bd ? n(form.bd) : null, p_area: form.area, p_address: form.address,
      p_customer_type: form.ctype || null, p_note: form.note,
    });
    setBusy(false);
    if (r.error) { setMsg(r.error.message); return; }
    setMsg(t('已储存。'));
    await load();
    onSaved();
  }

  const key = d?.member_id ?? id;
  const stores = Array.from(new Set((d?.docs ?? []).map((x) => STORE[x.company] ?? x.company))).sort().join(' + ');
  const spent = (d?.docs ?? []).reduce((s, x) => s + n(x.amount), 0);
  const p = d?.profile;

  return (
    <div className="card card-block lp-panel">
      <div className="lp-head">
        <div>
          <h2 style={{ marginBottom: 2 }}>{form.name || fmtMember(key)}</h2>
          <div className="muted" style={{ fontSize: 13 }}>
            {fmtMember(key)}{stores ? ` · ${stores}` : ''}
            {d?.docs.length ? ` · ${t('首次消费')} ${fmtDate(d.docs[d.docs.length - 1].doc_date)}` : ''}
            {d && !d.docs.length ? ` · ${t('还没有购买纪录')}` : ''}
          </div>
        </div>
        <button className="btn" onClick={onClose}>{t('关闭')}</button>
      </div>

      {err && <div className="notice">{t('查询失败:')}{err}</div>}
      {!d && !err && <div className="loading">{t('载入中…')}</div>}

      {d && (
        <>
          <div className="grid-kpi">
            <Kpi label={t('累计消费')} value={fmtRM(spent)} sub={t('{n} 张单', { n: fmtNum(d.docs.filter((x) => n(x.amount) > 0).length) })} />
            <Kpi label={t('最后消费')} value={d.docs.length ? fmtDate(d.docs[0].doc_date) : '–'} sub={d.docs[0]?.sales_agent ? t('业务员 {a}', { a: d.docs[0].sales_agent }) : ''} />
          </div>

          <div className="lp-forms">
            <div className="lp-form">
              <h3>{t('基本资料')}</h3>
              <label>{t('名字')}</label>
              <input value={form.name} onChange={upd('name')} />
              <label>{t('生日(月 / 日)')}</label>
              <div className="lp-row">
                <select value={form.bm} onChange={upd('bm')}>
                  <option value="">{t('月')}</option>
                  {Array.from({ length: 12 }, (_, i) => <option key={i} value={i + 1}>{i + 1}</option>)}
                </select>
                <select value={form.bd} onChange={upd('bd')}>
                  <option value="">{t('日')}</option>
                  {Array.from({ length: 31 }, (_, i) => <option key={i} value={i + 1}>{i + 1}</option>)}
                </select>
              </div>
              <label>{t('类型')}</label>
              <select value={form.ctype} onChange={upd('ctype')}>
                <option value="">{t('请选择')}</option>
                {TYPES.map((x) => <option key={x} value={x}>{t(x)}</option>)}
              </select>
            </div>
            <div className="lp-form">
              <h3>&nbsp;</h3>
              <label>{t('地区(例:Skudai、Mount Austin、新加坡)')}</label>
              <input value={form.area} onChange={upd('area')} />
              <label>{t('地址(选填)')}</label>
              <input value={form.address} onChange={upd('address')} />
              <label>{t('备注(例:装修中、喜欢黑色款)')}</label>
              <textarea value={form.note} onChange={upd('note')} rows={3} />
              <button className="btn primary" disabled={busy} onClick={save}>{t('储存')}</button>
              {p?.updated_at && (
                <div className="muted" style={{ fontSize: 12 }}>
                  {t('上次修改')}: {new Date(p.updated_at).toLocaleString('en-MY')} {p.updated_by ?? ''}
                </div>
              )}
            </div>
          </div>
          {msg && <div className="notice" style={{ marginTop: 8 }}>{msg}</div>}

          <h3>{t('购买历史({n} 张单)', { n: fmtNum(d.docs.length) })}</h3>
          <div className="table-scroll">
            <table className="data">
              <thead>
                <tr>
                  <th>{t('日期')}</th><th>{t('门市')}</th><th>{t('单号')}</th><th>{t('业务员')}</th><th className="num">{t('金额')}</th>
                </tr>
              </thead>
              <tbody>
                {d.docs.length === 0 && <tr><td colSpan={5} className="muted">{t('没有消费纪录')}</td></tr>}
                {d.docs.map((x) => {
                  const k = `${x.company}|${x.doc_type}|${x.doc_no}`;
                  return (
                    <Fragment key={k}>
                      <tr className="lp-click" onClick={() => setOpen(open === k ? null : k)}>
                        <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(x.doc_date)}</td>
                        <td>{STORE[x.company] ?? x.company}</td>
                        <td style={{ whiteSpace: 'nowrap' }}>{open === k ? '▾ ' : '▸ '}{x.doc_no}{x.doc_type === 'CN' ? ` (${t('退货')})` : ''}</td>
                        <td>{x.sales_agent}</td>
                        <td className={'num' + (n(x.amount) < 0 ? ' neg' : '')}>{fmtNum(x.amount, 2)}</td>
                      </tr>
                      {open === k && (
                        <tr>
                          <td colSpan={5} className="lp-items">
                            <table className="data">
                              <tbody>
                                {x.items.map((it, i) => (
                                  <tr key={i}>
                                    <td style={{ whiteSpace: 'nowrap' }}>{it.item_code ?? ''}</td>
                                    <td>{it.description}</td>
                                    <td className="num" style={{ whiteSpace: 'nowrap' }}>{fmtNum(it.qty)} {it.uom ?? ''}</td>
                                    <td className="num">{fmtNum(it.sub_total, 2)}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                            {x.debtor_name && <div className="muted" style={{ fontSize: 12 }}>{t('单上客户名称')}: {x.debtor_name} ({x.debtor_code})</div>}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function MissingPhone({ t }: { t: T }) {
  const [rows, setRows] = useState<Missing[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    const r = await supabase.rpc('bi_customer_missing_phone', { p_days: 60 });
    setErr(r.error ? r.error.message : null);
    setRows((r.data ?? []) as Missing[]);
  }

  return (
    <details className="card card-block" onToggle={(e) => { if ((e.target as HTMLDetailsElement).open && rows === null) load(); }}>
      <summary><h2 style={{ display: 'inline' }}>{t('没抓到电话的门市单据(近 60 天)')}</h2></summary>
      <p className="muted" style={{ fontSize: 13 }}>
        {t('这些单的客户名称没有手机号(或号码少一位),顾客不会出现在名单里。请在 AutoCount 把客户名称改成「名字 + 手机号」,隔天同步后就会补上。')}
      </p>
      {err && <div className="notice">{t('查询失败:')}{err}</div>}
      {rows === null && !err && <div className="loading">{t('载入中…')}</div>}
      {rows && (
        <div className="table-scroll">
          <table className="data">
            <thead>
              <tr><th>{t('日期')}</th><th>{t('门市')}</th><th>{t('单号')}</th><th>{t('单上客户名称')}</th><th>{t('业务员')}</th><th className="num">{t('金额')}</th></tr>
            </thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={6} className="muted">{t('全部都有电话 👍')}</td></tr>}
              {rows.map((x) => (
                <tr key={`${x.company}|${x.doc_type}|${x.doc_no}`}>
                  <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(x.doc_date)}</td>
                  <td>{STORE[x.company] ?? x.company}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>{x.doc_no}</td>
                  <td>{x.debtor_name} <span className="muted">({x.debtor_code})</span></td>
                  <td>{x.sales_agent}</td>
                  <td className="num">{fmtNum(x.amount, 2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </details>
  );
}
