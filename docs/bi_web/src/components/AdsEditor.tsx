import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useT } from '../lib/i18n';

// 电商月报里不在 AutoCount 的三块:Shopee Ads / Lazada Sponsored Affiliate / Shopee AMS(每周 GMV 与花费)与 Live Sales。
// 老板在这里填,存进 bi.report_month(bi_report_set_ads,只有 owner 能写);SERVER 产 Excel 时会拉回去,重推月报也不会盖掉。

export type AdRow = { period: string; gmv: number; expense: number };
export type AdsDoc = Record<string, AdRow[]>;
export type LiveDoc = Record<string, number>;

const AD_SECTIONS = ['SHOPEE ADS', 'LAZADA SPONSORED AFFILIATE', 'SHOPEE AMS'];
const LIVE_CHANNELS = ['SHOPEE', 'TIKTOK'];
const DEFAULT_PERIODS = ['1~8', '9~15', '16~22', '23~31'];

type Draft = { ads: Record<string, { period: string; gmv: string; expense: string }[]>; live: Record<string, string> };

function toDraft(ads: AdsDoc, live: LiveDoc): Draft {
  const d: Draft = { ads: {}, live: {} };
  AD_SECTIONS.forEach((s) => {
    const rows = ads[s] ?? [];
    d.ads[s] = rows.length
      ? rows.map((r) => ({ period: r.period, gmv: String(r.gmv ?? ''), expense: String(r.expense ?? '') }))
      : (s === 'SHOPEE AMS' ? ['1~31'] : DEFAULT_PERIODS).map((p) => ({ period: p, gmv: '', expense: '' }));
  });
  LIVE_CHANNELS.forEach((c) => { d.live[c] = live[c] === undefined ? '' : String(live[c]); });
  return d;
}

function fromDraft(d: Draft): { ads: AdsDoc; live: LiveDoc } {
  const ads: AdsDoc = {};
  const num = (s: string) => Number(String(s).replace(/[,\s]/g, '')) || 0;
  AD_SECTIONS.forEach((s) => {
    const rows = (d.ads[s] ?? []).filter((r) => r.period.trim() && (r.gmv.trim() || r.expense.trim()))
      .map((r) => ({ period: r.period.trim(), gmv: num(r.gmv), expense: num(r.expense) }));
    if (rows.length) ads[s] = rows;
  });
  const live: LiveDoc = {};
  LIVE_CHANNELS.forEach((c) => { live[c] = num(d.live[c] ?? ''); });
  return { ads, live };
}

const inputStyle = {
  background: 'var(--page)', color: 'var(--ink)', border: '1px solid var(--border)', borderRadius: 6,
  padding: '5px 8px', fontFamily: 'inherit', fontSize: 12.5, width: '100%', boxSizing: 'border-box',
} as const;

export default function AdsEditor({ company, month, ads, live, onSaved }:
  { company: string; month: string; ads: AdsDoc; live: LiveDoc; onSaved: () => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => toDraft(ads, live));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => { setDraft(toDraft(ads, live)); setMsg(null); }, [month, ads, live]);

  const setRow = (s: string, i: number, k: 'period' | 'gmv' | 'expense', v: string) =>
    setDraft((d) => ({ ...d, ads: { ...d.ads, [s]: d.ads[s].map((r, j) => (j === i ? { ...r, [k]: v } : r)) } }));
  const addRow = (s: string) => setDraft((d) => ({ ...d, ads: { ...d.ads, [s]: [...d.ads[s], { period: '', gmv: '', expense: '' }] } }));
  const delRow = (s: string, i: number) => setDraft((d) => ({ ...d, ads: { ...d.ads, [s]: d.ads[s].filter((_, j) => j !== i) } }));

  async function save() {
    setBusy(true); setMsg(null);
    const { ads: a, live: l } = fromDraft(draft);
    const { error } = await supabase.rpc('bi_report_set_ads', { p_company: company, p_month: month, p_ads: a, p_live_sales: l });
    setBusy(false);
    if (error) { setMsg(t('储存失败:{err}', { err: error.message })); return; }
    setMsg(t('已储存,Excel 月报下次产生时会自动带入。'));
    onSaved();
  }

  if (!open) {
    return (
      <div className="filters" style={{ marginTop: -6 }}>
        <button className="btn" onClick={() => setOpen(true)}>{t('填写 {m} 的广告 / 直播数字', { m: month.slice(0, 7) })}</button>
        <span className="muted" style={{ fontSize: 12 }}>{t('Shopee Ads、Lazada Affiliate、Shopee AMS、Live Sales 不在 AutoCount,由这里填')}</span>
      </div>
    );
  }

  return (
    <div className="card card-block">
      <h2>{t('填写广告 / 直播数字')} · {month.slice(0, 7)}</h2>
      <div className="two-col">
        {AD_SECTIONS.map((s) => (
          <div key={s}>
            <div style={{ fontSize: 13, fontWeight: 650, margin: '6px 0' }}>{s}</div>
            <table className="data">
              <thead><tr><th>{t('期间(日)')}</th><th className="num">GMV (RM)</th><th className="num">{t('花费 (RM)')}</th><th /></tr></thead>
              <tbody>
                {draft.ads[s].map((r, i) => (
                  <tr key={i}>
                    <td style={{ width: 90 }}><input style={inputStyle} value={r.period} onChange={(e) => setRow(s, i, 'period', e.target.value)} placeholder="1~8" /></td>
                    <td><input style={inputStyle} inputMode="decimal" value={r.gmv} onChange={(e) => setRow(s, i, 'gmv', e.target.value)} /></td>
                    <td><input style={inputStyle} inputMode="decimal" value={r.expense} onChange={(e) => setRow(s, i, 'expense', e.target.value)} /></td>
                    <td style={{ width: 30 }}><button className="btn" style={{ padding: '2px 7px' }} onClick={() => delRow(s, i)} title={t('删除这一行')}>×</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button className="btn" style={{ marginTop: 6 }} onClick={() => addRow(s)}>{t('+ 加一行')}</button>
          </div>
        ))}
        <div>
          <div style={{ fontSize: 13, fontWeight: 650, margin: '6px 0' }}>{t('LIVE SALES(整月,RM)')}</div>
          <table className="data">
            <tbody>
              {LIVE_CHANNELS.map((c) => (
                <tr key={c}>
                  <td style={{ width: 110 }}>{c}</td>
                  <td><input style={inputStyle} inputMode="decimal" value={draft.live[c]} onChange={(e) => setDraft((d) => ({ ...d, live: { ...d.live, [c]: e.target.value } }))} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="filters" style={{ marginTop: 12, marginBottom: 0 }}>
        <button className="btn primary" disabled={busy} onClick={save}>{busy ? t('储存中…') : t('储存')}</button>
        <button className="btn" onClick={() => { setDraft(toDraft(ads, live)); setOpen(false); setMsg(null); }}>{t('关闭')}</button>
        {msg && <span className="muted" style={{ fontSize: 12.5 }}>{msg}</span>}
      </div>
    </div>
  );
}
