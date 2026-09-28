import { Fragment, useEffect, useMemo, useState } from 'react';
import {
  ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';
import { supabase, COMPANY } from '../lib/supabase';
import { fmtRM, fmtDate, fmtNum, fmtCompact } from '../lib/format';
import { Kpi } from '../components/ChartCard';
import { useT } from '../lib/i18n';

type ApRow = {
  creditor_code: string; creditor_name: string; currency: string | null;
  balance: number; inv_outstanding: number; unapplied: number;
  b0_30: number; b31_60: number; b61_90: number; b90p: number;
  oldest_invoice: string | null; docs: number;
};
type DocRow = { doc_type: string; doc_no: string; doc_date: string; due_date: string | null; amount: number; balance: number; age_days: number };
type CfRow = { week_no: number; week_start: string; ar_in: number; ap_out: number; opex_out: number; cash_start: number; cum_cash: number };

// 单据类型 → 中文原文(显示时再经 t() 翻译)
const TYPE_LABEL: Record<string, string> = { PI: '采购发票', PD: '借项', PC: '贷项(未冲)', PP: '付款(未冲)', PF: '退款' };
const tooltipStyle = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12.5, color: 'var(--ink)' } as const;

function Cell({ v, bold }: { v: number; bold?: boolean }) {
  const n = Number(v ?? 0);
  return (
    <td className={'num' + (n < 0 ? ' neg' : '')} style={bold ? { fontWeight: 600 } : undefined}>
      {n === 0 ? <span className="muted">—</span> : fmtNum(n, 2)}
    </td>
  );
}

function Cashflow() {
  const t = useT();
  const [rows, setRows] = useState<CfRow[] | null>(null);
  useEffect(() => {
    supabase.from('bi_cashflow_13w').select('*').eq('company', COMPANY).order('week_no')
      .then(({ data }) => setRows((data ?? []).map((r) => ({
        ...r, ar_in: Number(r.ar_in), ap_out: Number(r.ap_out), opex_out: Number(r.opex_out),
        cash_start: Number(r.cash_start), cum_cash: Number(r.cum_cash),
      })) as CfRow[]));
  }, []);
  if (rows === null) return <div className="loading">{t('载入中…')}</div>;
  if (!rows.length) return null;
  const minCash = Math.min(...rows.map((r) => r.cum_cash));
  // 图例 / tooltip 直接显示 dataKey,所以 dataKey 本身就用翻译后的文字
  const K_IN = t('预计回款'), K_OUT = t('预计付款与开销'), K_CASH = t('现金余额');
  const chart = rows.map((r) => ({
    label: r.week_start.slice(5), [K_IN]: Math.round(r.ar_in),
    [K_OUT]: -Math.round(r.ap_out + r.opex_out), [K_CASH]: Math.round(r.cum_cash),
  }));
  return (
    <div className="card card-block">
      <h2>{t('13 周现金流预测')} <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>
        {t('当前账面现金 {a} · 13 周最低点 {b}', { a: fmtRM(rows[0].cash_start), b: fmtRM(minCash) })}{minCash < 0 ? ' ⚠️' : ''}</span></h2>
      <ResponsiveContainer width="100%" height={280}>
        <ComposedChart data={chart} margin={{ top: 8, right: 12, left: 8, bottom: 0 }} stackOffset="sign">
          <CartesianGrid stroke="var(--grid)" strokeWidth={1} vertical={false} />
          <XAxis dataKey="label" tick={{ fill: 'var(--muted)', fontSize: 11 }} axisLine={{ stroke: 'var(--baseline)' }} tickLine={false} />
          <YAxis tick={{ fill: 'var(--muted)', fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={fmtCompact} width={56} />
          <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => fmtRM(Math.abs(v))} />
          <Legend wrapperStyle={{ fontSize: 12.5 }} />
          <Bar dataKey={K_IN} fill="var(--series-1)" stackId="a" radius={[3, 3, 0, 0]} maxBarSize={26} />
          <Bar dataKey={K_OUT} fill="#EF4444" stackId="a" radius={[3, 3, 0, 0]} maxBarSize={26} />
          <Line dataKey={K_CASH} stroke="#ffffff" strokeWidth={2} dot={{ r: 2.5 }} type="monotone" />
        </ComposedChart>
      </ResponsiveContainer>
      <p className="muted" style={{ margin: '8px 0 0', fontSize: 12 }}>
        {t('口径:回款 = 现有欠款按到期推算(平台净额下周结算、月结客户发票+37天);付款 = 供应商净欠按到期日;')}
        {t('每周固定开销 = 近 12 个月费用均摊({x}/周)。', { x: fmtRM(rows[0].opex_out) })}<strong>{t('不含未来新销售的回款')}</strong>{t(',是"从今天起不做生意能撑多久"的保守口径;')}
        {t('分行欠款 RM 59 万因回款时间不定未计入。')}
      </p>
    </div>
  );
}

export default function Payables({ showCashflow = true }: { showCashflow?: boolean }) {
  const t = useT();
  const [rows, setRows] = useState<ApRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [docs, setDocs] = useState<DocRow[] | null>(null);
  const [hideNeg, setHideNeg] = useState(true);

  useEffect(() => {
    supabase.from('bi_ap_aging').select('*').eq('company', COMPANY).order('balance', { ascending: false })
      .then(({ data, error }) => { setErr(error ? error.message : null); setRows((data ?? []) as ApRow[]); });
  }, []);
  useEffect(() => {
    if (!open) { setDocs(null); return; }
    setDocs(null);
    supabase.from('bi_ap_open_docs').select('*').eq('company', COMPANY).eq('creditor_code', open)
      .order('doc_date').limit(500)
      .then(({ data }) => setDocs((data ?? []) as DocRow[]));
  }, [open]);

  const shown = useMemo(() => (rows ?? []).filter((r) => !hideNeg || Number(r.balance) > 0.005), [rows, hideNeg]);
  if (rows === null) return <div className="loading">{t('载入中…')}</div>;
  if (err) return <div className="notice">{t('查询失败:')}{err}</div>;

  const tot = (k: keyof ApRow) => rows.reduce((s, r) => s + Number(r[k] ?? 0), 0);
  const owed = rows.filter((r) => Number(r.balance) > 0.005);
  const owedTotal = owed.reduce((s, r) => s + Number(r.balance), 0);

  return (
    <>
      <div className="grid-kpi">
        <Kpi label={t('实际要付的(净欠供应商)')} value={fmtRM(owedTotal)} sub={t('{n} 家供应商有净欠款', { n: owed.length })} />
        <Kpi label={t('净应付合计(全部账户)')} value={fmtRM(tot('balance'))}
             sub={t('负数 = 付款已入账但发票未入账(预付状态)')} />
        <Kpi label={t('发票未付(毛)')} value={fmtRM(tot('inv_outstanding'))} sub={t('逐张采购发票的未付余额')} />
        <Kpi label={t('超 90 天未付发票')} value={fmtRM(tot('b90p'))} sub={t('多为未做 knock-off 的旧账')} />
      </div>

      <div className="notice">
        {t('口径:与 AutoCount AP Aging 一致——供应商余额 = 采购发票+借项 − 未冲销贷项 − 未冲销付款,已与总账供应商科目')}<strong>{t('分毫核对一致')}</strong>
        {t('。该账套大量付款未逐张冲销发票(约 RM 174 万),所以"发票未付"偏大、很多户是负数;')}
        <strong>{t('看"实际要付的"那个数')}</strong>{t('最准。点供应商行可展开单据明细。')}
      </div>

      {showCashflow && <Cashflow />}

      <div className="filters">
        <label className="muted" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input type="checkbox" checked={hideNeg} onChange={(e) => setHideNeg(e.target.checked)} />
          {t('只看有净欠款的供应商')}
        </label>
        <span className="muted">{t('{n} 家', { n: fmtNum(shown.length) })}</span>
      </div>

      <div className="card">
        <div className="table-scroll">
          <table className="data">
            <thead><tr>
              <th>{t('供应商')}</th><th className="num">{t('净余额')}</th>
              <th className="num">{t('0-30 天')}</th><th className="num">31-60</th><th className="num">61-90</th><th className="num">{t('>90 天')}</th>
              <th className="num">{t('未冲销付款')}</th><th>{t('最早未付发票')}</th>
            </tr></thead>
            <tbody>
              {shown.map((r) => (
                <Fragment key={r.creditor_code}>
                  <tr onClick={() => setOpen(open === r.creditor_code ? null : r.creditor_code)} style={{ cursor: 'pointer' }}>
                    <td title={r.creditor_code}>
                      <span className="muted" style={{ marginRight: 6 }}>{open === r.creditor_code ? '▾' : '▸'}</span>
                      {r.creditor_name}
                    </td>
                    <Cell v={r.balance} bold />
                    <Cell v={r.b0_30} /><Cell v={r.b31_60} /><Cell v={r.b61_90} /><Cell v={r.b90p} />
                    <Cell v={r.unapplied} />
                    <td className="muted">{fmtDate(r.oldest_invoice)}</td>
                  </tr>
                  {open === r.creditor_code && (
                    <tr><td colSpan={8} style={{ padding: '6px 8px 12px 28px', background: 'rgba(219,232,250,.04)' }}>
                      {docs === null ? <span className="muted">{t('载入明细…')}</span> : (
                        <table className="data" style={{ fontSize: 12 }}>
                          <thead><tr><th>{t('类型')}</th><th>{t('单号')}</th><th>{t('日期')}</th><th>{t('到期')}</th><th className="num">{t('账龄(天)')}</th><th className="num">{t('单据额')}</th><th className="num">{t('未结余额')}</th></tr></thead>
                          <tbody>
                            {docs.map((d) => (
                              <tr key={d.doc_type + d.doc_no}>
                                <td>{TYPE_LABEL[d.doc_type] ? t(TYPE_LABEL[d.doc_type]) : d.doc_type}</td>
                                <td>{d.doc_no}</td>
                                <td>{fmtDate(d.doc_date)}</td>
                                <td className="muted">{fmtDate(d.due_date)}</td>
                                <td className={'num' + (d.age_days > 60 && Number(d.balance) > 0 ? ' neg' : '')}>{d.age_days}</td>
                                <Cell v={d.amount} /><Cell v={d.balance} bold />
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </td></tr>
                  )}
                </Fragment>
              ))}
            </tbody>
            <tfoot><tr style={{ fontWeight: 650 }}>
              <td>{t('合计({n} 家)', { n: shown.length })}</td>
              <Cell v={shown.reduce((s, r) => s + Number(r.balance), 0)} bold />
              <Cell v={shown.reduce((s, r) => s + Number(r.b0_30 ?? 0), 0)} /><Cell v={shown.reduce((s, r) => s + Number(r.b31_60 ?? 0), 0)} />
              <Cell v={shown.reduce((s, r) => s + Number(r.b61_90 ?? 0), 0)} /><Cell v={shown.reduce((s, r) => s + Number(r.b90p ?? 0), 0)} />
              <td colSpan={2} />
            </tr></tfoot>
          </table>
        </div>
      </div>
    </>
  );
}
