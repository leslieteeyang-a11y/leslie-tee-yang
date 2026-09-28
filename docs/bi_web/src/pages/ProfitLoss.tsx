import { useEffect, useMemo, useState } from 'react';
import {
  ResponsiveContainer, ComposedChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
} from 'recharts';
import { supabase, COMPANY } from '../lib/supabase';
import { fmtRM, fmtCompact } from '../lib/format';
import { ChartCard } from '../components/ChartCard';
import { useT } from '../lib/i18n';

// AutoCount 损益类科目大类。net = dr - cr:收入类贷方为正常方向,故显示值取 -net。
type GlRow = { acc_type: string; yr: number; mth: number; net: number };

const PL_TYPES = ['SA', 'SL', 'CO', 'OI', 'EP', 'TX'];
// label 是中文原文(字典键),显示时经 t() 翻译
const ROWS: { key: string; label: string; types: string[]; flip: boolean; bold?: boolean }[] = [
  { key: 'rev', label: '销售收入 (SA+SL)', types: ['SA', 'SL'], flip: true },
  { key: 'cogs', label: '销售成本 (CO)', types: ['CO'], flip: false },
  { key: 'gross', label: '毛利', types: [], flip: false, bold: true },
  { key: 'oi', label: '其他收入 (OI)', types: ['OI'], flip: true },
  { key: 'ep', label: '费用 (EP)', types: ['EP'], flip: false },
  { key: 'tx', label: '税项 (TX)', types: ['TX'], flip: false },
  { key: 'np', label: '净利', types: [], flip: false, bold: true },
];

export default function ProfitLoss() {
  const t = useT();
  const [rows, setRows] = useState<GlRow[] | null>(null);
  const [year, setYear] = useState<number>(new Date().getFullYear());
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const { data, error } = await supabase
        .from('bi_gl_type_monthly')
        .select('acc_type,yr,mth,net')
        .eq('company', COMPANY)
        .in('acc_type', PL_TYPES);
      setErr(error ? error.message : null);
      setRows((data ?? []).map((r) => ({ ...r, net: Number(r.net) })));
    })();
  }, []);

  const years = useMemo(
    () => [...new Set((rows ?? []).map((r) => r.yr))].sort((a, b) => b - a),
    [rows]
  );

  // 若当前选中年份没有数据(如新年初),自动落到最近有数据的年份
  useEffect(() => {
    if (years.length && !years.includes(year)) setYear(years[0]);
  }, [years]);

  const table = useMemo(() => {
    if (!rows) return null;
    const y = rows.filter((r) => r.yr === year);
    // sum(types, mth):按大类合计当月 net
    const cell = (types: string[], mth: number) =>
      y.filter((r) => types.includes(r.acc_type) && r.mth === mth)
        .reduce((s, r) => s + r.net, 0);
    const months = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    const values: Record<string, number[]> = {};
    for (const row of ROWS) {
      if (row.key === 'gross' || row.key === 'np') continue;
      values[row.key] = months.map((m) => {
        const v = cell(row.types, m);
        return row.flip ? -v : v;
      });
    }
    values.gross = months.map((_, i) => values.rev[i] - values.cogs[i]);
    values.np = months.map(
      (_, i) => values.gross[i] + values.oi[i] - values.ep[i] - values.tx[i]
    );
    // 完全无过账的月份(未来月份/空月)在折线图上留空,而不是画成 0
    const hasData = months.map((m) => y.some((r) => r.mth === m));
    return { months, values, hasData };
  }, [rows, year]);

  if (rows === null) return <div className="loading">{t('载入中…')}</div>;

  const npChart = table
    ? table.months.map((m, i) => ({
        label: t('{m}月', { m }),
        np: table.hasData[i] ? table.values.np[i] : null,
      }))
    : [];

  return (
    <>
      {err && <div className="notice">{t('查询失败:{err}', { err })}</div>}
      <div className="filters">
        <label className="muted">{t('年份')}</label>
        <select value={year} onChange={(e) => setYear(Number(e.target.value))}>
          {years.map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
        <span className="muted">{t('口径:总账 GLDTL 本位币;收入类科目按贷方为正显示。')}</span>
      </div>

      <ChartCard title={t('{y} 年逐月净利', { y: year })}>
        <ResponsiveContainer width="100%" height={220}>
          <ComposedChart data={npChart} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
            <CartesianGrid stroke="var(--grid)" strokeWidth={1} vertical={false} />
            <XAxis dataKey="label" tick={{ fill: 'var(--muted)', fontSize: 11 }}
                   axisLine={{ stroke: 'var(--baseline)' }} tickLine={false} />
            <YAxis tick={{ fill: 'var(--muted)', fontSize: 11 }} axisLine={false} tickLine={false}
                   tickFormatter={fmtCompact} width={52} />
            <Tooltip contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12.5 }}
                     formatter={(v: number) => fmtRM(v)} />
            <Line dataKey="np" name={t('净利')} stroke="var(--series-1)" strokeWidth={2} dot={{ r: 3 }} type="monotone" />
          </ComposedChart>
        </ResponsiveContainer>
      </ChartCard>

      <div className="card card-block">
        <h2>{t('{y} 年损益表(逐月)', { y: year })}</h2>
        <div className="table-scroll">
          <table className="data">
            <thead>
              <tr>
                <th>{t('项目')}</th>
                {table!.months.map((m) => <th key={m} className="num">{t('{m}月', { m })}</th>)}
                <th className="num">{t('全年')}</th>
              </tr>
            </thead>
            <tbody>
              {ROWS.map((row) => {
                const vals = table!.values[row.key];
                const total = vals.reduce((s, v) => s + v, 0);
                return (
                  <tr key={row.key} style={row.bold ? { fontWeight: 650 } : undefined}>
                    <td>{t(row.label)}</td>
                    {vals.map((v, i) => (
                      <td key={i} className={'num' + (row.bold && v < 0 ? ' neg' : '')}>
                        {v === 0 ? '—' : Number(v).toLocaleString('en-MY', { maximumFractionDigits: 0 })}
                      </td>
                    ))}
                    <td className={'num' + (row.bold && total < 0 ? ' neg' : '')}>
                      {Number(total).toLocaleString('en-MY', { maximumFractionDigits: 0 })}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          {t('单位:RM。此表为管理口径速览,精确到分的核对以 AutoCount 报表为准。')}
        </p>
      </div>
    </>
  );
}
