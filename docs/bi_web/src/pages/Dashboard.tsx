import { useEffect, useMemo, useState } from 'react';
import {
  ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis,
  CartesianGrid, Tooltip, Legend, BarChart,
} from 'recharts';
import { supabase, COMPANY } from '../lib/supabase';
import { fmtRM, fmtCompact, ymLabel } from '../lib/format';
import { ChartCard, Kpi } from '../components/ChartCard';
import SalesCompare from '../components/SalesCompare';
import { useT } from '../lib/i18n';

type MonthRow = { yr: number; mth: number; net: number; cost: number; profit: number };
type CustRow = { debtor_code: string; debtor_name: string; net: number; profit: number };
type ItemRow = { item_code: string; item_description: string; qty: number; net: number; profit: number };

const tooltipStyle = {
  background: 'var(--surface)', border: '1px solid var(--border)',
  borderRadius: 8, fontSize: 12.5, color: 'var(--ink)',
};

export default function Dashboard({ onEmpty, showProfit = true }: { onEmpty: (empty: boolean) => void; showProfit?: boolean }) {
  const t = useT();
  const [months, setMonths] = useState<MonthRow[] | null>(null);
  const [openSum, setOpenSum] = useState<{ amt: number; lines: number }>({ amt: 0, lines: 0 });
  const [topCust, setTopCust] = useState<CustRow[]>([]);
  const [topItems, setTopItems] = useState<ItemRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  // 挂载时冻结"本月",保证 KPI 标签与查询口径一致
  const [{ curYr, curMth }] = useState(() => {
    const now = new Date();
    return { curYr: now.getFullYear(), curMth: now.getMonth() + 1 };
  });

  useEffect(() => {
    (async () => {
      // Top-N 由服务端年粒度视图 order+limit 精确给出,不受单次查询 1000 行上限影响
      // 店长版总览不显示月度图/Top10 栏目,相应查询也不发
      const [m, oo, cust, items] = await Promise.all([
        supabase.from(showProfit ? 'bi_sales_monthly' : 'bi_sales_monthly_nc')
          .select(showProfit ? 'yr,mth,net,cost,profit' : 'yr,mth,net')
          .eq('company', COMPANY).order('yr').order('mth'),
        supabase.from('bi_open_orders').select('outstanding_amount').eq('company', COMPANY),
        showProfit
          ? supabase.from('bi_sales_by_customer_y').select('debtor_code,debtor_name,net,profit')
              .eq('company', COMPANY).eq('yr', curYr).order('net', { ascending: false }).limit(10)
          : Promise.resolve({ data: [], error: null }),
        showProfit
          ? supabase.from('bi_sales_by_item_y').select('item_code,item_description,qty,net,profit')
              .eq('company', COMPANY).eq('yr', curYr).order('net', { ascending: false }).limit(10)
          : Promise.resolve({ data: [], error: null }),
      ]);
      const failed = [m.error, oo.error, cust.error, items.error].filter(Boolean);
      if (failed.length) {
        setErr(failed.map((e) => e!.message).join(' / '));
        setMonths([]);
        return;
      }
      const mrows = (m.data ?? []).map((r: Record<string, unknown>) => ({
        yr: Number(r.yr), mth: Number(r.mth), net: Number(r.net), cost: Number(r.cost ?? 0), profit: Number(r.profit ?? 0),
      }));
      setMonths(mrows);
      onEmpty(mrows.length === 0);

      const oos = oo.data ?? [];
      setOpenSum({ amt: oos.reduce((s, r) => s + Number(r.outstanding_amount ?? 0), 0), lines: oos.length });

      setTopCust((cust.data ?? []).map((r: Record<string, unknown>) => ({
        debtor_code: String(r.debtor_code), debtor_name: String(r.debtor_name),
        net: Number(r.net), profit: Number(r.profit ?? 0),
      })));
      // 没有商品编码的行存空字串,显示时再依语言换成「(无编码)」
      setTopItems((items.data ?? []).map((r: Record<string, unknown>) => ({
        item_code: r.item_code == null ? '' : String(r.item_code), item_description: String(r.item_description ?? ''),
        qty: Number(r.qty ?? 0), net: Number(r.net), profit: Number(r.profit ?? 0),
      })));
    })();
  }, []);

  const chartData = useMemo(() => {
    if (!months) return [];
    return months.slice(-24).map((r) => showProfit
      ? { label: ymLabel(r.yr, r.mth), net: r.net, profit: r.profit }
      : { label: ymLabel(r.yr, r.mth), net: r.net });
  }, [months, showProfit]);

  if (months === null) return <div className="loading">{t('载入中…')}</div>;

  const thisMonth = months.find((r) => r.yr === curYr && r.mth === curMth);
  const ytd = months.filter((r) => r.yr === curYr);
  const ytdNet = ytd.reduce((s, r) => s + r.net, 0);
  const ytdProfit = ytd.reduce((s, r) => s + r.profit, 0);

  return (
    <>
      {err && <div className="notice">{t('查询失败,以下数字不可信:{err}', { err })}</div>}
      <div className="grid-kpi">
        <Kpi label={t('本月净销售 ({ym})', { ym: `${curYr}-${String(curMth).padStart(2, '0')}` })}
             value={fmtRM(thisMonth?.net ?? 0)} sub={showProfit ? t('毛利 {v}', { v: fmtRM(thisMonth?.profit ?? 0) }) : undefined} />
        <Kpi label={t('{y} 年累计净销售', { y: curYr })} value={fmtRM(ytdNet)} sub={showProfit ? t('累计毛利 {v}', { v: fmtRM(ytdProfit) }) : undefined} />
        {showProfit && (
          <Kpi label={t('毛利率 (今年, 销售口径)')} value={ytdNet ? ((ytdProfit / ytdNet) * 100).toFixed(1) + '%' : '—'}
               sub={t('毛利=金额−商品成本;无成本记录的行按 0 成本计,与损益页 GL 口径不同')} />
        )}
        <Kpi label={t('未交订单')} value={fmtRM(openSum.amt)} sub={t('{n} 行未交', { n: openSum.lines })} />
      </div>

      <SalesCompare availableMonths={[...months].reverse().map((r) => ymLabel(r.yr, r.mth))}
                    months={months.map((r) => ({ yr: r.yr, mth: r.mth, net: r.net }))} />

      {showProfit && (<>
      <ChartCard title={t('月度净销售与毛利(近 24 个月)')}>
        <ResponsiveContainer width="100%" height={300}>
          <ComposedChart data={chartData} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
            <CartesianGrid stroke="var(--grid)" strokeWidth={1} vertical={false} />
            <XAxis dataKey="label" tick={{ fill: 'var(--muted)', fontSize: 11 }}
                   axisLine={{ stroke: 'var(--baseline)' }} tickLine={false} minTickGap={24} />
            <YAxis tick={{ fill: 'var(--muted)', fontSize: 11 }} axisLine={false} tickLine={false}
                   tickFormatter={fmtCompact} width={52} />
            <Tooltip contentStyle={tooltipStyle} cursor={{ fill: 'var(--grid)', opacity: 0.4 }}
                     formatter={(v: number) => fmtRM(v)} />
            <Legend wrapperStyle={{ fontSize: 12.5 }} />
            <Bar dataKey="net" name={t('净销售')} fill="var(--series-1)" radius={[4, 4, 0, 0]} maxBarSize={22} />
            {showProfit && <Line dataKey="profit" name={t('毛利')} stroke="var(--series-2)" strokeWidth={2} dot={false} type="monotone" />}
          </ComposedChart>
        </ResponsiveContainer>
      </ChartCard>

      <div className="two-col">
        <ChartCard title={t('{y} 年 Top 10 客户(净销售)', { y: curYr })}>
          <ResponsiveContainer width="100%" height={330}>
            <BarChart data={topCust} layout="vertical" margin={{ top: 0, right: 16, left: 8, bottom: 0 }}>
              <CartesianGrid stroke="var(--grid)" strokeWidth={1} horizontal={false} />
              <XAxis type="number" tick={{ fill: 'var(--muted)', fontSize: 11 }} axisLine={false}
                     tickLine={false} tickFormatter={fmtCompact} />
              <YAxis type="category" dataKey="debtor_name" width={150}
                     tick={{ fill: 'var(--ink-2)', fontSize: 11 }} axisLine={false} tickLine={false}
                     tickFormatter={(s: string) => (s?.length > 14 ? s.slice(0, 13) + '…' : s)} />
              <Tooltip contentStyle={tooltipStyle} cursor={{ fill: 'var(--grid)', opacity: 0.4 }}
                       formatter={(v: number) => fmtRM(v)} />
              <Bar dataKey="net" name={t('净销售')} fill="var(--series-1)" radius={[0, 4, 4, 0]} maxBarSize={16} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title={t('{y} 年 Top 10 商品(净销售)', { y: curYr })}>
          <div className="table-scroll">
            <table className="data">
              <thead>
                <tr><th>{t('商品')}</th><th className="num">{t('数量')}</th><th className="num">{t('净销售')}</th>{showProfit && <th className="num">{t('毛利')}</th>}</tr>
              </thead>
              <tbody>
                {topItems.map((r) => (
                  <tr key={r.item_code || '(无编码)'}>
                    <td title={r.item_code || t('(无编码)')}>{r.item_description || r.item_code || t('(无编码)')}</td>
                    <td className="num">{Number(r.qty).toLocaleString()}</td>
                    <td className="num">{fmtRM(r.net)}</td>
                    {showProfit && <td className="num">{fmtRM(r.profit)}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </ChartCard>
      </div>
      </>)}
    </>
  );
}
