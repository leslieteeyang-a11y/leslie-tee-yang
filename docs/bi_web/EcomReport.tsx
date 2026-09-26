import { useEffect, useMemo, useState } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid } from 'recharts';
import { supabase, COMPANY } from '../lib/supabase';
import { fmtRM, fmtNum } from '../lib/format';

// 电商月报:由 HomeWorks 营运系统每月从 AutoCount 抓取后推进 bi.report_month_*(见 bi_report_upsert)。
// 与其他页不同,这里的类别/渠道口径 = 纸本月报口径(Sales Forecast Summary),不是 bi.sale_channel。

type Month = { month: string; produced_by: string | null; ads: Record<string, unknown>; live_sales: Record<string, number>; updated_at: string };
type Cat = { scope: string; category: string; qty: number; amount: number };
type Ch = { scope: string; category: string; channel: string; amount: number };
type Sku = { month: string; platform: string; sku: string; qty: number };
type Top = { direction: string; rank: number; sku: string; lazada_qty: number; shopee_qty: number };
type AdRow = { period: string; gmv: number; expense: number };

const CHANNELS: [string, string][] = [
  ['shopee', 'Shopee'], ['lazada', 'Lazada'], ['cash', 'Cash'], ['online', 'Online'], ['referral', 'Referral'],
  ['shuigong', '水工'], ['southern', 'Southern'], ['tiktok', 'Tiktok'], ['shopify', 'Shopify'],
];
const MONTHS_CN = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const ym = (d: string) => d.slice(0, 7);
const n = (v: unknown) => Number(v ?? 0);

function ForecastTable({ title, cats, chs }: { title: string; cats: Cat[]; chs: Ch[] }) {
  const byCat = new Map<string, Map<string, number>>();
  chs.forEach((r) => {
    if (!byCat.has(r.category)) byCat.set(r.category, new Map());
    byCat.get(r.category)!.set(r.channel, n(r.amount));
  });
  const total = cats.reduce((s, c) => s + n(c.amount), 0);
  const colTotal = (ch: string) => cats.reduce((s, c) => s + (byCat.get(c.category)?.get(ch) ?? 0), 0);
  const cell = (v: number) => (v ? <td className={'num' + (v < 0 ? ' neg' : '')}>{fmtNum(v, 2)}</td> : <td className="num muted">–</td>);
  return (
    <div className="card card-block">
      <h2>{title}</h2>
      <div className="table-scroll">
        <table className="data">
          <thead>
            <tr>
              <th>Categories</th><th className="num">QTY</th>
              {CHANNELS.map(([k, l]) => <th key={k} className="num">{l} RM</th>)}
              <th className="num">Total RM</th><th className="num">Contribution</th><th className="num">Avg. Price</th>
            </tr>
          </thead>
          <tbody>
            {cats.length === 0 && <tr><td colSpan={CHANNELS.length + 5} className="muted">该月无数据</td></tr>}
            {cats.map((c) => (
              <tr key={c.category}>
                <td>{c.category}</td>
                <td className="num">{fmtNum(c.qty)}</td>
                {CHANNELS.map(([k]) => <span key={k} style={{ display: 'contents' }}>{cell(byCat.get(c.category)?.get(k) ?? 0)}</span>)}
                <td className={'num' + (n(c.amount) < 0 ? ' neg' : '')} style={{ fontWeight: 600 }}>{fmtNum(c.amount, 2)}</td>
                <td className="num">{total ? ((n(c.amount) / total) * 100).toFixed(1) + '%' : '–'}</td>
                <td className="num">{n(c.qty) ? fmtNum(n(c.amount) / n(c.qty), 2) : '–'}</td>
              </tr>
            ))}
          </tbody>
          {cats.length > 0 && (
            <tfoot>
              <tr style={{ fontWeight: 650 }}>
                <td>TOTAL</td>
                <td className="num">{fmtNum(cats.reduce((s, c) => s + n(c.qty), 0))}</td>
                {CHANNELS.map(([k]) => <span key={k} style={{ display: 'contents' }}>{cell(colTotal(k))}</span>)}
                <td className="num">{fmtNum(total, 2)}</td><td className="num">100%</td><td />
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}

function TopTable({ title, rows }: { title: string; rows: Top[] }) {
  return (
    <div className="card card-block">
      <h2>{title}</h2>
      <table className="data">
        <thead><tr><th>#</th><th>SKU</th><th className="num">Lazada</th><th className="num">Shopee</th><th className="num">Total (qty)</th></tr></thead>
        <tbody>
          {rows.length === 0 && <tr><td colSpan={5} className="muted">该月无数据</td></tr>}
          {rows.map((r) => (
            <tr key={r.rank}>
              <td className="muted">{r.rank}</td><td>{r.sku}</td>
              <td className="num">{fmtNum(r.lazada_qty)}</td><td className="num">{fmtNum(r.shopee_qty)}</td>
              <td className="num" style={{ fontWeight: 600 }}>{fmtNum(n(r.lazada_qty) + n(r.shopee_qty))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AdsTable({ title, rows }: { title: string; rows: AdRow[] }) {
  const gmv = rows.reduce((s, r) => s + n(r.gmv), 0), exp = rows.reduce((s, r) => s + n(r.expense), 0);
  return (
    <div className="card card-block">
      <h2>{title}</h2>
      <table className="data">
        <thead><tr><th>期间</th><th className="num">ADS GMV (RM)</th><th className="num">ADS EXPENSE (RM)</th><th className="num">%</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.period}>
              <td>{r.period}</td><td className="num">{fmtNum(r.gmv, 2)}</td><td className="num">{fmtNum(r.expense, 2)}</td>
              <td className="num">{n(r.gmv) ? ((n(r.expense) / n(r.gmv)) * 100).toFixed(2) + '%' : '–'}</td>
            </tr>
          ))}
          <tr style={{ fontWeight: 650 }}>
            <td>TOTAL</td><td className="num">{fmtNum(gmv, 2)}</td><td className="num">{fmtNum(exp, 2)}</td>
            <td className="num">{gmv ? ((exp / gmv) * 100).toFixed(2) + '%' : '–'}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

export default function EcomReport() {
  const [months, setMonths] = useState<Month[] | null>(null);
  const [sel, setSel] = useState<string>('');
  const [scope, setScope] = useState<'all' | 'hemos'>('all');
  const [cats, setCats] = useState<Cat[]>([]);
  const [chs, setChs] = useState<Ch[]>([]);
  const [skus, setSkus] = useState<Sku[]>([]);
  const [tops, setTops] = useState<Top[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    supabase.from('bi_report_month').select('month,produced_by,ads,live_sales,updated_at')
      .eq('company', COMPANY).order('month', { ascending: false })
      .then(({ data, error }) => {
        if (error) { setErr(error.message); setMonths([]); return; }
        const rows = (data ?? []) as Month[];
        setMonths(rows);
        if (rows.length && !sel) setSel(rows[0].month);
      });
  }, []);

  useEffect(() => {
    if (!sel) return;
    const year = sel.slice(0, 4);
    (async () => {
      const [a, b, c, d] = await Promise.all([
        supabase.from('bi_report_month_category').select('scope,category,qty,amount').eq('company', COMPANY).eq('month', sel),
        supabase.from('bi_report_month_channel').select('scope,category,channel,amount').eq('company', COMPANY).eq('month', sel),
        supabase.from('bi_report_month_sku').select('month,platform,sku,qty').eq('company', COMPANY)
          .gte('month', `${year}-01-01`).lte('month', `${year}-12-31`),
        supabase.from('bi_report_month_top10').select('direction,rank,sku,lazada_qty,shopee_qty').eq('company', COMPANY).eq('month', sel).order('rank'),
      ]);
      const e = a.error ?? b.error ?? c.error ?? d.error;
      setErr(e ? e.message : null);
      setCats((a.data ?? []) as Cat[]); setChs((b.data ?? []) as Ch[]);
      setSkus((c.data ?? []) as Sku[]); setTops((d.data ?? []) as Top[]);
    })();
  }, [sel]);

  const cur = months?.find((m) => m.month === sel);
  const catOrder = ['Building', 'Electric', 'Fitting', 'Garden', 'Online Fee', 'Kitchen', 'Lock', 'Sanitary', 'Service Fee',
    'Shipping Fee', 'Sample', 'Transaction Fee', 'Transport', 'Install', 'Valve'];
  const rank = (c: string) => { const i = catOrder.indexOf(c); return i < 0 ? 99 : i; };
  const catsScoped = cats.filter((r) => r.scope === scope).sort((x, y) => rank(x.category) - rank(y.category) || x.category.localeCompare(y.category));
  const chsScoped = chs.filter((r) => r.scope === scope);

  // SKU 全年趋势:每个平台一张表 + 一张折线图
  const skuTrend = useMemo(() => {
    const platforms = Array.from(new Set(skus.map((s) => s.platform)));
    const skuList = Array.from(new Set(skus.map((s) => s.sku)));
    const at = (p: string, sku: string, m: number) => skus.find((s) => s.platform === p && s.sku === sku && Number(s.month.slice(5, 7)) === m)?.qty;
    return { platforms, skuList, at };
  }, [skus]);
  const chartData = MONTHS_CN.map((label, i) => {
    const row: Record<string, string | number> = { m: label };
    skuTrend.platforms.forEach((p) => {
      const vals = skuTrend.skuList.map((s) => skuTrend.at(p, s, i + 1)).filter((v) => v !== undefined) as number[];
      if (vals.length) row[p] = vals.reduce((a, b) => a + n(b), 0);
    });
    return row;
  });

  if (months === null) return <div className="loading">载入中…</div>;
  if (!months.length) {
    return <div className="notice">还没有电商月报资料{err ? `:${err}` : ''}。请在 SERVER 上执行 setup_bi.bat 或 backfill.bat 推送。</div>;
  }
  const ads = (cur?.ads ?? {}) as Record<string, AdRow[]>;
  const live = (cur?.live_sales ?? {}) as Record<string, number>;

  return (
    <>
      <div className="filters">
        <select value={sel} onChange={(e) => setSel(e.target.value)}>
          {months.map((m) => <option key={m.month} value={m.month}>{ym(m.month)}</option>)}
        </select>
        <div className="seg">
          <button className={scope === 'all' ? 'active' : ''} onClick={() => setScope('all')}>All brand</button>
          <button className={scope === 'hemos' ? 'active' : ''} onClick={() => setScope('hemos')}>Hemos &amp; Hemos X</button>
        </div>
        <span className="muted" style={{ fontSize: 12 }}>
          {cur?.produced_by ? cur.produced_by.split('。')[0] : ''} · 更新于 {cur?.updated_at?.slice(0, 16).replace('T', ' ')}
        </span>
      </div>
      {err && <div className="notice">查询失败:{err}</div>}

      <ForecastTable title={`Sales Forecast Summary (${scope === 'all' ? 'All brand' : 'Hemos & Hemos X only'}) · ${ym(sel)}`}
                     cats={catsScoped} chs={chsScoped} />

      <div className="two-col">
        <TopTable title={`Top 10 UP · ${ym(sel)}`} rows={tops.filter((t) => t.direction === 'up')} />
        <TopTable title={`Top 10 DOWN · ${ym(sel)}`} rows={tops.filter((t) => t.direction === 'down')} />
      </div>

      {skuTrend.platforms.map((p) => (
        <div className="card card-block" key={p}>
          <h2>{p} · SKU 月度销量 {sel.slice(0, 4)}</h2>
          <div className="table-scroll">
            <table className="data">
              <thead><tr><th>SKU</th>{MONTHS_CN.map((m) => <th key={m} className="num">{m}</th>)}<th className="num">TOTAL</th></tr></thead>
              <tbody>
                {skuTrend.skuList.map((s) => {
                  const vals: (number | undefined)[] = MONTHS_CN.map((_, i) => skuTrend.at(p, s, i + 1));
                  return (
                    <tr key={s}>
                      <td>{s}</td>
                      {vals.map((v, i) => <td key={i} className={'num' + (v === undefined ? ' muted' : '')}>{v === undefined ? '' : fmtNum(v)}</td>)}
                      <td className="num" style={{ fontWeight: 600 }}>{fmtNum(vals.reduce((a: number, b) => a + n(b), 0))}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ))}

      {skuTrend.platforms.length > 0 && (
        <div className="card card-block">
          <h2>追踪 SKU 合计销量趋势 {sel.slice(0, 4)}</h2>
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={chartData}>
              <CartesianGrid stroke="var(--grid)" />
              <XAxis dataKey="m" tick={{ fill: 'var(--muted)', fontSize: 12 }} />
              <YAxis tick={{ fill: 'var(--muted)', fontSize: 12 }} allowDecimals={false} />
              <Tooltip contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)' }} />
              <Legend />
              {skuTrend.platforms.map((p, i) => (
                <Line key={p} type="monotone" dataKey={p} stroke={i === 0 ? '#e5eefb' : '#8fa3c7'} strokeWidth={2} dot={{ r: 3 }} connectNulls />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {Object.keys(ads).length > 0 ? (
        <div className="two-col">
          {Object.entries(ads).map(([name, rows]) => <AdsTable key={name} title={`${name} · ${ym(sel)}`} rows={rows} />)}
        </div>
      ) : (
        <div className="notice">Shopee Ads / Lazada Sponsored Affiliate / Live Sales 不在 AutoCount 里,这个月还没填(填进 SERVER 的 data/{ym(sel)}.json 后再推送一次)。</div>
      )}
      {Object.keys(live).length > 0 && (
        <div className="grid-kpi">
          {Object.entries(live).map(([k, v]) => (
            <div className="card kpi" key={k}><div className="label">LIVE SALES · {k}</div><div className="value">{fmtRM(v)}</div></div>
          ))}
        </div>
      )}
      <p className="muted" style={{ fontSize: 12 }}>
        口径:销售 = 发票 + 现销 − 贷项 + 借项,按商品群组与客户账号分类,与 Excel 月报完全一致;「(未分类)」= 开单时没选商品代号的行。
        Top 10 只看 Shopee + Lazada 销量,按型号合并。
      </p>
    </>
  );
}
