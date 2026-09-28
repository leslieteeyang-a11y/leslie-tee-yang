import { useEffect, useMemo, useState } from 'react';
import {
  ResponsiveContainer, LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';
import { supabase, COMPANY } from '../lib/supabase';
import { fmtRM, fmtCompact, fmtNum } from '../lib/format';
import { tr, useLang, useT } from '../lib/i18n';

type Mode = 'yoy' | 'mom';
type View = 'daily' | 'monthly';
type DayRow = { doc_date: string; net: number; orders: number };
type Period = { yr: number; mth: number };
export type MonthNet = { yr: number; mth: number; net: number };

const tooltipStyle = {
  background: 'var(--surface)', border: '1px solid var(--border)',
  borderRadius: 8, fontSize: 12.5, color: 'var(--ink)',
};

const daysIn = (yr: number, mth: number) => new Date(yr, mth, 0).getDate();
const label = (p: Period) => `${p.yr}-${String(p.mth).padStart(2, '0')}`;
const pct = (cur: number, base: number) =>
  base ? `${cur >= base ? '+' : ''}${(((cur - base) / Math.abs(base)) * 100).toFixed(1)}%` : '—';

async function fetchMonth(p: Period): Promise<DayRow[]> {
  const from = `${p.yr}-${String(p.mth).padStart(2, '0')}-01`;
  const next = p.mth === 12 ? `${p.yr + 1}-01-01` : `${p.yr}-${String(p.mth + 1).padStart(2, '0')}-01`;
  const { data } = await supabase.from('bi_sales_daily').select('doc_date,net,orders')
    .eq('company', COMPANY).gte('doc_date', from).lt('doc_date', next).order('doc_date');
  return (data ?? []).map((r) => ({ doc_date: r.doc_date, net: Number(r.net), orders: Number(r.orders) }));
}

/** 把一个月的日数据铺成 1..N 天的累计序列 */
function cumulative(rows: DayRow[], p: Period, uptoDay?: number) {
  const n = daysIn(p.yr, p.mth);
  const byDay = new Map<number, DayRow>();
  for (const r of rows) byDay.set(Number(r.doc_date.slice(8, 10)), r);
  const out: (number | null)[] = [];
  let acc = 0;
  for (let d = 1; d <= n; d++) {
    if (uptoDay !== undefined && d > uptoDay) { out.push(null); continue; }
    acc += byDay.get(d)?.net ?? 0;
    out.push(acc);
  }
  return out;
}

/** 按月对比:选定年份 12 个月 vs 上一年同月(柱状并排),含同比表 */
function MonthlyCompare({ months, curYr }: { months: MonthNet[]; curYr: number }) {
  const t = useT();
  const { lang } = useLang();
  const [year, setYear] = useState(curYr);
  const years = useMemo(() => [...new Set(months.map((r) => r.yr))].sort((a, b) => b - a), [months]);
  const lookup = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of months) m.set(`${r.yr}-${r.mth}`, r.net);
    return m;
  }, [months]);
  const data = useMemo(() => Array.from({ length: 12 }, (_, i) => {
    const m = i + 1;
    const cur = lookup.get(`${year}-${m}`);
    const prev = lookup.get(`${year - 1}-${m}`);
    return {
      label: tr(lang, '{m}月', { m }),
      [`${year}`]: cur ?? null,
      [`${year - 1}`]: prev ?? null,
      delta: cur !== undefined && prev !== undefined ? pct(cur, prev) : '—',
    };
  }), [lookup, year, lang]);
  const totCur = months.filter((r) => r.yr === year).reduce((s, r) => s + r.net, 0);
  const totPrev = months.filter((r) => r.yr === year - 1).reduce((s, r) => s + r.net, 0);
  // 同期口径:上一年只累计到本年有数据的最后一个月
  const lastM = Math.max(0, ...months.filter((r) => r.yr === year).map((r) => r.mth));
  const totPrevSame = months.filter((r) => r.yr === year - 1 && r.mth <= lastM).reduce((s, r) => s + r.net, 0);

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 10 }}>
        <select value={year} onChange={(e) => setYear(Number(e.target.value))}
                style={{ background: 'var(--surface)', color: 'var(--ink)', border: '1px solid var(--border)', borderRadius: 8, padding: '5px 8px', fontFamily: 'inherit' }}>
          {years.map((y) => <option key={y} value={y}>{y} vs {y - 1}</option>)}
        </select>
        <span className="muted" style={{ fontSize: 12.5 }}>
          {t('{y} 累计', { y: year })} {fmtRM(totCur)} · {t('{y} 同期(1–{m}月)', { y: year - 1, m: lastM })} {fmtRM(totPrevSame)} ·{' '}
          <strong className={pct(totCur, totPrevSame).startsWith('-') ? 'neg' : ''}>{pct(totCur, totPrevSame)}</strong>
          {lastM < 12 && <> · {t('{y} 全年', { y: year - 1 })} {fmtRM(totPrev)}</>}
        </span>
      </div>
      <ResponsiveContainer width="100%" height={280}>
        <BarChart data={data} margin={{ top: 8, right: 8, left: 8, bottom: 0 }} barGap={2}>
          <CartesianGrid stroke="var(--grid)" strokeWidth={1} vertical={false} />
          <XAxis dataKey="label" tick={{ fill: 'var(--muted)', fontSize: 11 }}
                 axisLine={{ stroke: 'var(--baseline)' }} tickLine={false} />
          <YAxis tick={{ fill: 'var(--muted)', fontSize: 11 }} axisLine={false} tickLine={false}
                 tickFormatter={fmtCompact} width={52} />
          <Tooltip contentStyle={tooltipStyle} cursor={{ fill: 'var(--grid)', opacity: 0.4 }}
                   formatter={(v: number) => fmtRM(v)}
                   labelFormatter={(l, payload) => {
                     const d = (payload?.[0]?.payload ?? {}) as { delta?: string };
                     return `${l}  ${t('同比')} ${d.delta ?? '—'}`;
                   }} />
          <Legend wrapperStyle={{ fontSize: 12.5 }} />
          <Bar dataKey={`${year - 1}`} fill="var(--muted)" radius={[4, 4, 0, 0]} maxBarSize={24} />
          <Bar dataKey={`${year}`} fill="var(--series-1)" radius={[4, 4, 0, 0]} maxBarSize={24} />
        </BarChart>
      </ResponsiveContainer>
      <div className="table-scroll" style={{ marginTop: 8 }}>
        <table className="data">
          <thead>
            <tr><th>{t('月份')}</th>{data.map((d) => <th key={d.label} className="num">{d.label}</th>)}</tr>
          </thead>
          <tbody>
            <tr><td>{year}</td>{data.map((d) => <td key={d.label} className="num">{d[`${year}`] == null ? '—' : fmtCompact(Number(d[`${year}`]))}</td>)}</tr>
            <tr><td className="muted">{year - 1}</td>{data.map((d) => <td key={d.label} className="num muted">{d[`${year - 1}`] == null ? '—' : fmtCompact(Number(d[`${year - 1}`]))}</td>)}</tr>
            <tr><td>{t('同比')}</td>{data.map((d) => (
              <td key={d.label} className={'num' + (d.delta.startsWith('-') ? ' neg' : '')} style={{ fontWeight: 600 }}>{d.delta}</td>
            ))}</tr>
          </tbody>
        </table>
      </div>
    </>
  );
}

export default function SalesCompare({ availableMonths, months }: { availableMonths: string[]; months: MonthNet[] }) {
  const t = useT();
  const [view, setView] = useState<View>('daily');
  const [mode, setMode] = useState<Mode>('yoy');
  const [{ curYr, curMth, curDay }] = useState(() => {
    const now = new Date();
    return { curYr: now.getFullYear(), curMth: now.getMonth() + 1, curDay: now.getDate() };
  });
  const [sel, setSel] = useState<string>(label({ yr: curYr, mth: curMth }));
  const [cur, setCur] = useState<DayRow[] | null>(null);
  const [base, setBase] = useState<DayRow[] | null>(null);

  const curP: Period = useMemo(() => {
    const [y, m] = sel.split('-').map(Number);
    return { yr: y, mth: m };
  }, [sel]);
  const baseP: Period = useMemo(() => {
    if (mode === 'yoy') return { yr: curP.yr - 1, mth: curP.mth };
    return curP.mth === 1 ? { yr: curP.yr - 1, mth: 12 } : { yr: curP.yr, mth: curP.mth - 1 };
  }, [mode, curP]);

  useEffect(() => {
    let alive = true;
    setCur(null); setBase(null);
    Promise.all([fetchMonth(curP), fetchMonth(baseP)]).then(([a, b]) => {
      if (!alive) return;
      setCur(a); setBase(b);
    });
    return () => { alive = false; };
  }, [curP, baseP]);

  // 本期若是当月,只画到今天;对比期画整月
  const isCurrentMonth = curP.yr === curYr && curP.mth === curMth;
  const chart = useMemo(() => {
    if (!cur || !base) return [];
    const cSeries = cumulative(cur, curP, isCurrentMonth ? curDay : undefined);
    const bSeries = cumulative(base, baseP);
    const n = Math.max(cSeries.length, bSeries.length);
    return Array.from({ length: n }, (_, i) => ({
      day: i + 1,
      [label(curP)]: cSeries[i] ?? null,
      [label(baseP)]: bSeries[i] ?? null,
    }));
  }, [cur, base, curP, baseP, isCurrentMonth, curDay]);

  const curTotal = (cur ?? []).reduce((s, r) => s + r.net, 0);
  const curOrders = (cur ?? []).reduce((s, r) => s + r.orders, 0);
  const baseTotal = (base ?? []).reduce((s, r) => s + r.net, 0);
  const baseOrders = (base ?? []).reduce((s, r) => s + r.orders, 0);
  // 同期口径:本期是当月时,对比期只算到相同天数
  const baseSameDay = isCurrentMonth
    ? (base ?? []).filter((r) => Number(r.doc_date.slice(8, 10)) <= curDay).reduce((s, r) => s + r.net, 0)
    : baseTotal;
  const delta = pct(curTotal, baseSameDay);
  const down = delta.startsWith('-');

  return (
    <div className="card card-block">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>{t('销售对比')}</h2>
        <div className="seg">
          <button className={view === 'daily' ? 'active' : ''} onClick={() => setView('daily')}>{t('逐日累计')}</button>
          <button className={view === 'monthly' ? 'active' : ''} onClick={() => setView('monthly')}>{t('按月对比')}</button>
        </div>
        {view === 'daily' && (
          <select value={sel} onChange={(e) => setSel(e.target.value)}
                  style={{ background: 'var(--surface)', color: 'var(--ink)', border: '1px solid var(--border)', borderRadius: 8, padding: '5px 8px', fontFamily: 'inherit' }}>
            {!availableMonths.includes(sel) && <option value={sel}>{sel}</option>}
            {availableMonths.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        )}
        <div style={{ flex: 1 }} />
        {view === 'daily' && (
          <div className="seg">
            <button className={mode === 'yoy' ? 'active' : ''} onClick={() => setMode('yoy')}>{t('对比去年同月')}</button>
            <button className={mode === 'mom' ? 'active' : ''} onClick={() => setMode('mom')}>{t('对比上个月')}</button>
          </div>
        )}
      </div>

      {view === 'monthly' ? (
        <MonthlyCompare months={months} curYr={curYr} />
      ) : (
      <div className="cmp-grid">
        <div>
          {cur === null || base === null ? (
            <div className="loading">{t('载入中…')}</div>
          ) : (
            <ResponsiveContainer width="100%" height={280}>
              <LineChart data={chart} margin={{ top: 8, right: 12, left: 8, bottom: 0 }}>
                <CartesianGrid stroke="var(--grid)" strokeWidth={1} vertical={false} />
                <XAxis dataKey="day" tick={{ fill: 'var(--muted)', fontSize: 11 }}
                       axisLine={{ stroke: 'var(--baseline)' }} tickLine={false}
                       tickFormatter={(d: number) => t('{d}日', { d })} interval={4} />
                <YAxis tick={{ fill: 'var(--muted)', fontSize: 11 }} axisLine={false} tickLine={false}
                       tickFormatter={fmtCompact} width={52} />
                <Tooltip contentStyle={tooltipStyle}
                         formatter={(v: number) => fmtRM(v)}
                         labelFormatter={(d) => t('第 {d} 日累计', { d: String(d) })} />
                <Legend wrapperStyle={{ fontSize: 12.5 }} />
                <Line dataKey={label(baseP)} stroke="var(--muted)" strokeWidth={2}
                      dot={{ r: 2, fill: 'var(--muted)' }} type="monotone" connectNulls={false} />
                <Line dataKey={label(curP)} stroke="var(--series-1)" strokeWidth={2.5}
                      dot={{ r: 2.5, fill: 'var(--series-1)' }} type="monotone" connectNulls={false} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>

        <div className="cmp-cards">
          <div className="cmp-card cur">
            <div className="cmp-title">{isCurrentMonth ? t('本月') : label(curP)}{isCurrentMonth ? ' ' + t('(至 {d} 日)', { d: curDay }) : ''}</div>
            <div className="cmp-label">{t('销售额')}</div>
            <div className="cmp-value">
              {fmtRM(curTotal)}
              <span className={'cmp-delta' + (down ? ' neg' : ' pos')}>{delta} {down ? '▼' : '▲'}</span>
            </div>
            <div className="cmp-label">{t('发票数')}</div>
            <div className="cmp-value">{fmtNum(curOrders)}</div>
          </div>
          <div className="cmp-card">
            <div className="cmp-title">{mode === 'yoy' ? t('去年同月') : t('上个月')} · {label(baseP)}</div>
            <div className="cmp-label">{t('销售额')}{isCurrentMonth ? t('(同期至 {d} 日)', { d: curDay }) : ''}</div>
            <div className="cmp-value">{fmtRM(baseSameDay)}</div>
            {isCurrentMonth && <div className="muted" style={{ fontSize: 12, marginTop: -4, marginBottom: 6 }}>{t('整月')} {fmtRM(baseTotal)}</div>}
            <div className="cmp-label">{t('发票数')}</div>
            <div className="cmp-value">{fmtNum(baseOrders)}</div>
          </div>
        </div>
      </div>
      )}
      <p className="muted" style={{ margin: '8px 0 0', fontSize: 12 }}>
        {view === 'daily'
          ? <>{t('曲线为月内逐日累计净销售(发票−贷项)。本期为当月时只画到今天,且增幅按对比期')}<strong>{t('相同天数')}</strong>{t('计算,避免整月对半月的失真。')}</>
          : <>{t('每月净销售(发票−贷项),浅蓝 = 所选年份,灰 = 上一年同月;累计同比按上一年')}<strong>{t('相同月份区间')}</strong>{t('计算。悬停柱子看该月同比。')}</>}
      </p>
    </div>
  );
}
