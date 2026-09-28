import { Fragment, useEffect, useMemo, useState } from 'react';
import { supabase, COMPANY } from '../lib/supabase';
import { fmtRM, fmtDate, fmtNum } from '../lib/format';
import { Kpi } from '../components/ChartCard';
import { useT } from '../lib/i18n';

type AgingRow = {
  debtor_code: string; debtor_name: string; debtor_type: string | null; sales_agent: string | null;
  balance: number; b0_30: number; b31_60: number; b61_90: number; b91_120: number; b120p: number;
  inv_outstanding: number; unapplied_payment: number; unapplied_cn: number;
  oldest_invoice: string | null; docs: number;
};
type DocRow = {
  doc_type: string; doc_no: string; doc_date: string; due_date: string | null;
  amount: number; balance: number; age_days: number;
};

// 单据类型 → 中文原文(显示时再经 t() 翻译)
const TYPE_LABEL: Record<string, string> = {
  RI: '发票', RD: '借项', RC: '贷项(未冲)', RP: '收款(未冲)', RF: '退款',
};

type CollRow = { yr: number; mth: number; agent: string; collected: number; n_pay: number; debtors: number };
type AgentAr = { agent: string; net_balance: number; over30: number; over60: number; debtors: number };

function Collections() {
  const t = useT();
  const [rows, setRows] = useState<CollRow[] | null>(null);
  const [arRows, setArRows] = useState<AgentAr[]>([]);
  const [ym, setYm] = useState('');
  useEffect(() => {
    (async () => {
      const [a, b] = await Promise.all([
        supabase.from('bi_agent_collections_m').select('*').eq('company', COMPANY),
        supabase.from('bi_agent_ar_open').select('*').eq('company', COMPANY),
      ]);
      const rs = (a.data ?? []).map((r) => ({ ...r, collected: Number(r.collected), n_pay: Number(r.n_pay), debtors: Number(r.debtors) })) as CollRow[];
      setRows(rs);
      setArRows((b.data ?? []).map((r) => ({ ...r, net_balance: Number(r.net_balance), over30: Number(r.over30 ?? 0), over60: Number(r.over60 ?? 0) })) as AgentAr[]);
      const list = [...new Set(rs.map((r) => `${r.yr}-${String(r.mth).padStart(2, '0')}`))].sort().reverse();
      if (list.length) setYm(list[0]);
    })();
  }, []);
  if (rows === null) return <div className="loading">{t('载入中…')}</div>;
  const list = [...new Set(rows.map((r) => `${r.yr}-${String(r.mth).padStart(2, '0')}`))].sort().reverse();
  const [y, m] = ym.split('-').map(Number);
  const cur = rows.filter((r) => r.yr === y && r.mth === m).sort((a, b) => b.collected - a.collected);
  const prevYm = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
  const [py, pm] = prevYm.split('-').map(Number);
  const prevMap = new Map(rows.filter((r) => r.yr === py && r.mth === pm).map((r) => [r.agent, r.collected]));
  const arMap = new Map(arRows.map((r) => [r.agent, r]));
  const total = cur.reduce((s, r) => s + r.collected, 0);
  return (
    <>
      <div className="filters">
        <label className="muted">{t('月份')}</label>
        <select value={ym} onChange={(e) => setYm(e.target.value)}>
          {list.map((v) => <option key={v} value={v}>{v}</option>)}
        </select>
        <span className="muted">{t('口径:门市+B2B 客户的收款(不含电商平台/分行/现金柜台),按客户档案上的业务员归属')}</span>
      </div>
      <div className="card">
        <div className="table-scroll">
          <table className="data">
            <thead><tr>
              <th>#</th><th>{t('业务员')}</th><th className="num">{t('本月回款')}</th><th className="num">{t('占比')}</th>
              <th className="num">{t('笔数')}</th><th className="num">{t('客户数')}</th><th className="num">{t('上月回款')}</th>
              <th className="num">{t('名下未收')}</th><th className="num">{t('其中 >30 天')}</th><th className="num">{t('>60 天')}</th>
            </tr></thead>
            <tbody>
              {cur.map((r, i) => {
                const ar = arMap.get(r.agent);
                return (
                  <tr key={r.agent}>
                    <td className="muted">{i + 1}</td>
                    <td>{r.agent}</td>
                    <td className="num" style={{ fontWeight: 600 }}>{fmtRM(r.collected)}</td>
                    <td className="num muted">{total ? ((r.collected / total) * 100).toFixed(1) + '%' : '—'}</td>
                    <td className="num">{fmtNum(r.n_pay)}</td>
                    <td className="num">{fmtNum(r.debtors)}</td>
                    <td className="num muted">{fmtRM(Number(prevMap.get(r.agent) ?? 0))}</td>
                    <td className="num">{ar ? fmtRM(ar.net_balance) : '—'}</td>
                    <td className={'num' + (ar && ar.over30 > 0 ? ' neg' : '')}>{ar ? fmtRM(ar.over30) : '—'}</td>
                    <td className={'num' + (ar && ar.over60 > 0 ? ' neg' : '')}>{ar ? fmtRM(ar.over60) : '—'}</td>
                  </tr>
                );
              })}
              {cur.length === 0 && <tr><td colSpan={10} className="muted">{t('该月无回款记录')}</td></tr>}
            </tbody>
            <tfoot><tr style={{ fontWeight: 650 }}><td colSpan={2}>{t('合计')}</td>
              <td className="num">{fmtRM(total)}</td><td colSpan={7} /></tr></tfoot>
          </table>
        </div>
        <p className="muted" style={{ marginBottom: 0, fontSize: 12 }}>
          {t('"(未指定)" = 客户档案没填业务员的收款——这个数越大考核越不准,建议在 AutoCount 客户档案里补上业务员。')}
          {t('"名下未收/逾期"按当前时点,与月份选择无关。')}
        </p>
      </div>
    </>
  );
}

function Cell({ v, bold }: { v: number; bold?: boolean }) {
  const n = Number(v ?? 0);
  return (
    <td className={'num' + (n < 0 ? ' neg' : '')} style={bold ? { fontWeight: 600 } : undefined}>
      {n === 0 ? <span className="muted">—</span> : fmtNum(n, 2)}
    </td>
  );
}

export default function Receivables() {
  const t = useT();
  const [sub, setSub] = useState<'aging' | 'coll'>('aging');
  const [rows, setRows] = useState<AgingRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [hideNeg, setHideNeg] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [docs, setDocs] = useState<DocRow[] | null>(null);

  useEffect(() => {
    (async () => {
      const { data, error } = await supabase.from('bi_ar_aging').select('*')
        .eq('company', COMPANY).order('balance', { ascending: false });
      setErr(error ? error.message : null);
      setRows((data ?? []) as AgingRow[]);
    })();
  }, []);

  useEffect(() => {
    if (!open) { setDocs(null); return; }
    (async () => {
      setDocs(null);
      const { data } = await supabase.from('bi_ar_open_docs').select('*')
        .eq('company', COMPANY).eq('debtor_code', open)
        .order('doc_date', { ascending: true }).limit(500);
      setDocs((data ?? []) as DocRow[]);
    })();
  }, [open]);

  const shown = useMemo(() => {
    if (!rows) return [];
    const k = q.trim().toLowerCase();
    return rows.filter((r) =>
      (!hideNeg || Number(r.balance) > 0.005) &&
      (!k || r.debtor_code.toLowerCase().includes(k) || (r.debtor_name ?? '').toLowerCase().includes(k)));
  }, [rows, q, hideNeg]);

  if (rows === null) return <div className="loading">{t('载入中…')}</div>;
  if (err) return <div className="notice">{t('查询失败:')}{err}</div>;

  const tot = (k: keyof AgingRow) => rows.reduce((s, r) => s + Number(r[k] ?? 0), 0);
  const total = tot('balance');
  const over90 = tot('b91_120') + tot('b120p');
  const positives = rows.filter((r) => Number(r.balance) > 0.005);

  return (
    <>
      <div className="seg" style={{ marginBottom: 14 }}>
        <button className={sub === 'aging' ? 'active' : ''} onClick={() => setSub('aging')}>{t('客户账龄')}</button>
        <button className={sub === 'coll' ? 'active' : ''} onClick={() => setSub('coll')}>{t('业务员回款')}</button>
      </div>
      {sub === 'coll' ? <Collections /> : (
      <>
      <div className="grid-kpi">
        <Kpi label={t('净应收合计')} value={fmtRM(total)}
             sub={t('{a} 个客户有欠款 · {b} 个为预收/待冲', { a: positives.length, b: rows.length - positives.length })} />
        <Kpi label={t('逾期 90 天以上')} value={fmtRM(over90)}
             sub={t('占净应收 {p}%', { p: total ? ((over90 / total) * 100).toFixed(1) : '0' })} />
        <Kpi label={t('发票未收(毛)')} value={fmtRM(tot('inv_outstanding'))}
             sub={t('逐张发票的未收余额合计')} />
        <Kpi label={t('未冲销收款 + 贷项')} value={fmtRM(-(tot('unapplied_payment') + tot('unapplied_cn')))}
             sub={t('已收到但未逐张冲销发票的款项')} />
      </div>

      <div className="notice">
        {t('口径:与 AutoCount AR Aging 一致——客户余额 = 发票+借项 − 未冲销贷项 − 未冲销收款,按')}<strong>{t('单据日期')}</strong>{t('分桶。')}
        <strong className="neg"> {t('负数')}</strong>{t(' = 该客户有预收/未冲销款项(常见于 Shopee / Lazada 等平台账户,收款按周结算、未逐张冲发票)。')}
        {t('点击客户行可展开未结单据明细。数据每日随同步刷新,已与总账客户明细账逐户核对一致。')}
      </div>

      <div className="filters">
        <input placeholder={t('搜索客户编码 / 名称…')} value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="muted" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input type="checkbox" checked={hideNeg} onChange={(e) => setHideNeg(e.target.checked)} />
          {t('只看有欠款的客户')}
        </label>
        <span className="muted">{t('{n} 个客户', { n: fmtNum(shown.length) })}</span>
      </div>

      <div className="card">
        <div className="table-scroll">
          <table className="data">
            <thead>
              <tr>
                <th>{t('客户')}</th><th>{t('类型')}</th><th>{t('业务员')}</th>
                <th className="num">{t('净余额')}</th>
                <th className="num">{t('0-30 天')}</th><th className="num">31-60</th><th className="num">61-90</th>
                <th className="num">91-120</th><th className="num">{t('>120 天')}</th>
                <th>{t('最早未结发票')}</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <Fragment key={r.debtor_code}>
                  <tr onClick={() => setOpen(open === r.debtor_code ? null : r.debtor_code)}
                      style={{ cursor: 'pointer' }}>
                    <td title={r.debtor_code}>
                      <span className="muted" style={{ marginRight: 6 }}>{open === r.debtor_code ? '▾' : '▸'}</span>
                      {r.debtor_name}
                    </td>
                    <td className="muted">{r.debtor_type ?? ''}</td>
                    <td className="muted">{r.sales_agent ?? ''}</td>
                    <Cell v={r.balance} bold />
                    <Cell v={r.b0_30} /><Cell v={r.b31_60} /><Cell v={r.b61_90} />
                    <Cell v={r.b91_120} /><Cell v={r.b120p} />
                    <td className="muted">{fmtDate(r.oldest_invoice)}</td>
                  </tr>
                  {open === r.debtor_code && (
                    <tr>
                      <td colSpan={10} style={{ padding: '6px 8px 12px 28px', background: 'rgba(219,232,250,.04)' }}>
                        {docs === null ? (
                          <span className="muted">{t('载入明细…')}</span>
                        ) : (
                          <table className="data" style={{ fontSize: 12 }}>
                            <thead>
                              <tr><th>{t('类型')}</th><th>{t('单号')}</th><th>{t('日期')}</th><th>{t('到期')}</th>
                                  <th className="num">{t('账龄(天)')}</th><th className="num">{t('单据额')}</th><th className="num">{t('未结余额')}</th></tr>
                            </thead>
                            <tbody>
                              {docs.map((d) => (
                                <tr key={d.doc_type + d.doc_no}>
                                  <td>{TYPE_LABEL[d.doc_type] ? t(TYPE_LABEL[d.doc_type]) : d.doc_type}</td>
                                  <td>{d.doc_no}</td>
                                  <td>{fmtDate(d.doc_date)}</td>
                                  <td className="muted">{fmtDate(d.due_date)}</td>
                                  <td className={'num' + (d.age_days > 90 && Number(d.balance) > 0 ? ' neg' : '')}>{d.age_days}</td>
                                  <Cell v={d.amount} />
                                  <Cell v={d.balance} bold />
                                </tr>
                              ))}
                              {docs.length >= 500 && <tr><td colSpan={7} className="muted">{t('仅显示前 500 张单据')}</td></tr>}
                            </tbody>
                          </table>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ fontWeight: 650 }}>
                <td colSpan={3}>{t('合计({n} 个客户)', { n: rows.length })}</td>
                <Cell v={total} bold />
                <Cell v={tot('b0_30')} /><Cell v={tot('b31_60')} /><Cell v={tot('b61_90')} />
                <Cell v={tot('b91_120')} /><Cell v={tot('b120p')} />
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
      </>
      )}
    </>
  );
}
