import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import { supabase, COMPANY, COMPANIES } from '../lib/supabase';
import { fmtRM, fmtNum, ymLabel } from '../lib/format';
import { useT } from '../lib/i18n';

// 公司健康度(只给 owner 看):8 个核心指标 + 1 个资料品质指标,每个都有本期、去年同期、近 12 个月趋势、红黄绿灯与白话解释。
// 资料层(Supabase,migration health_*):
//   public.bi_health_monthly  按月的销售流量(可信毛利率的分子分母、没成本的行)+ 总账(SL/SA/CO/进货/EP)
//   public.bi_health_now      当月 / 今年累计 与去年同期(同样的日期区间)。as_of = 该公司「已完整同步的最后一天」
//                             (分行电脑没开机就不同步,所以每家公司不同;去年同期也截到 as_of − 1 年,避免拿半天比整天)
//   public.bi_health_snapshot 每日余额快照(库存 / 应收 / 应付 / 滞销 + 截到 sales_through 的近 90 天流量),2026-08-24 起
// 三个视图都限 owner;比率与灯号在这里算,门槛集中在下面的 TH,要调就改这里(页面上的说明文字会跟着变)。
// migration:health_sales_daily_mv / health_snapshot_table / health_refresh_fn / health_cron / health_views / health_fix1。

const TH = {
  revGreenMin: 3,     // 营收:今年至今比去年同期 ≥ +3% 绿
  revRedBelow: -5,    //       低于 −5% 红,中间黄
  gmRedDrop: 3,       // 可信毛利率:比去年同期低 ≥ 3 个百分点 红
  gmYellowDrop: 1,    //            低 1～3 个百分点 黄
  epRedRise: 3,       // 费用率:比去年同期高 ≥ 3 个百分点 红
  epYellowRise: 1,    //        高 1～3 个百分点 黄
  dioGreen: 120,      // 库存天数 ≤ 120 绿
  dioRed: 180,        //          > 180 红
  slowGreen: 10,      // 滞销库存占比 ≤ 10% 绿
  slowRed: 20,        //              > 20% 红
  dsoGreen: 30,       // 应收天数 ≤ 30 绿
  dsoRed: 60,         //          > 60 红
  ar90Green: 10,      // 逾期 90 天以上占应收 ≤ 10% 绿
  ar90Red: 25,        //                      > 25% 红
  dpoLow: 15,         // 应付天数 15～90 绿;< 15 或 90～120 黄
  dpoHigh: 90,
  dpoRed: 120,        //          > 120 红
  cccGreen: 60,       // 现金周期 ≤ 60 绿
  cccRed: 120,        //          > 120 红
  nocostGreen: 5,     // 没有成本的销售占比 ≤ 5% 绿
  nocostRed: 15,      //                    > 15% 红
};

// 可信毛利率从哪个月起可信(之前的成本资料异常,不拿来当去年同期比)。
// 总部 2024-04～2024-12 的可信毛利率只有 −2%～10%(2025-01 起回到 38%～41%),是成本资料问题,不是真的毛利。
const GM_RELIABLE_FROM: Record<string, { yr: number; mth: number }> = {
  HOMEWORKSSB: { yr: 2025, mth: 1 },
};

type Light = 'g' | 'y' | 'r' | 'na';
const LIGHT_COLOR: Record<Light, string> = { g: 'var(--good)', y: '#f59e0b', r: 'var(--critical)', na: 'var(--muted)' };
const LIGHT_LABEL: Record<Light, string> = { g: '正常', y: '留意', r: '警示', na: '资料不足' };

type Monthly = {
  yr: number; mth: number; net: number; net_ic: number; sales_costed: number; cost_costed: number;
  gross_goods: number; sales_nocost: number; sales_nocost_ic: number; nocost_lines: number; last_date: string | null;
  gl_sales: number | null; gl_sa: number | null; gl_co: number | null; gl_purch: number | null; gl_ep: number | null;
};
type Now = {
  as_of: string; ly_as_of: string; last_sales_date: string | null;
  mtd_net: number; mtd_ic: number; ly_mtd_net: number; ly_mtd_ic: number;
  ytd_net: number; ytd_ic: number; ly_ytd_net: number; ly_ytd_ic: number;
  refreshed_at: string | null; synced_at: string | null;
};
type Snap = {
  snap_date: string; source: string;
  stock_cost: number | null; stock_excluded: number | null; stock_neg: number | null;
  slow_cost: number | null; aging_total: number | null;
  ar_pos: number | null; ar_neg: number | null; ar_over90: number | null; ar_ic: number | null;
  ap_pos: number | null; ap_neg: number | null;
  sales_90: number; sales_costed_90: number; cost_costed_90: number; sales_nocost_90: number;
  purch_3m: number | null; purch_days: number | null; refreshed_at: string;
};
type YM = { yr: number; mth: number };
type Pt = { label: string; cur: number | null; ly?: number | null };

const n = (v: unknown) => Number(v ?? 0);
const nn = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const pct1 = (v: number) => v.toFixed(1) + '%';
const signed = (v: number, d = 1) => (v >= 0 ? '+' : '') + v.toFixed(d);
const ymShort = (p: YM) => `${String(p.yr).slice(2)}/${String(p.mth).padStart(2, '0')}`;
const ymBefore = (a: YM, b: YM) => a.yr * 100 + a.mth < b.yr * 100 + b.mth;
// 马来西亚今天的日期(YYYY-MM-DD),用来判断这家公司今天有没有同步
const todayMY = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kuala_Lumpur' }).format(new Date());
const addDays = (d: string, k: number) => {
  const [y, m, dd] = d.split('-').map(Number);
  const x = new Date(y, m - 1, dd + k);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
};
const fmtTime = (ts: string | null) => (ts ? new Date(ts).toLocaleString('en-MY', { hour12: false }) : '—');
const tooltipStyle = {
  background: 'var(--surface)', border: '1px solid var(--border)',
  borderRadius: 8, fontSize: 12, color: 'var(--ink)',
} as const;

/* ---------- 指标计算(纯函数) ---------- */

// 近 90 天日均销货成本(估):有成本的行用实际成本;没成本的行按同期「成本 ÷ 销售」比例估
function cogsDaily(s: Snap): number {
  const ratio = s.sales_costed_90 > 0 ? s.cost_costed_90 / s.sales_costed_90 : 0;
  return (s.cost_costed_90 + s.sales_nocost_90 * ratio) / 90;
}
const dioOf = (s: Snap) => (s.stock_cost !== null && cogsDaily(s) > 0 ? s.stock_cost / cogsDaily(s) : null);
const dsoOf = (s: Snap) => (s.ar_pos !== null && s.sales_90 > 0 ? s.ar_pos / (s.sales_90 / 90) : null);
const dpoOf = (s: Snap) =>
  s.ap_pos !== null && s.purch_3m !== null && s.purch_3m > 0 && s.purch_days ? s.ap_pos / (s.purch_3m / s.purch_days) : null;
const cccOf = (s: Snap) => {
  const a = dioOf(s), b = dsoOf(s), c = dpoOf(s);
  return a === null || b === null || c === null ? null : a + b - c;
};
const slowOf = (s: Snap) => (s.slow_cost !== null && s.aging_total ? (s.slow_cost / s.aging_total) * 100 : null);

const lightLow = (v: number | null, green: number, red: number): Light =>
  v === null ? 'na' : v <= green ? 'g' : v > red ? 'r' : 'y';
const worse = (a: Light, b: Light): Light => {
  const rank: Record<Light, number> = { na: 0, g: 1, y: 2, r: 3 };
  if (a === 'na') return b; if (b === 'na') return a;
  return rank[a] >= rank[b] ? a : b;
};

/* ---------- 小元件 ---------- */

function LightBadge({ light }: { light: Light }) {
  const t = useT();
  const sym = light === 'g' ? '●' : light === 'y' ? '▲' : light === 'r' ? '■' : '○';
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12.5, fontWeight: 650, color: 'var(--ink)', whiteSpace: 'nowrap' }}>
      <span style={{ color: LIGHT_COLOR[light], fontSize: 13 }} aria-hidden>{sym}</span>{t(LIGHT_LABEL[light])}
    </span>
  );
}

function Spark({ data, kind, fmt, curName, lyName, note }: {
  data: Pt[]; kind: 'bar' | 'line'; fmt: (v: number) => string; curName: string; lyName?: string; note?: string;
}) {
  const t = useT();
  const points = data.filter((p) => p.cur !== null).length;
  if (points < 2) return <div className="muted" style={{ fontSize: 12, margin: '10px 0 4px' }}>{note ?? t('趋势资料不足')}</div>;
  const hasLy = !!lyName && data.some((p) => p.ly !== null && p.ly !== undefined);
  return (
    <div style={{ margin: '8px 0 2px' }}>
      <ResponsiveContainer width="100%" height={96}>
        <ComposedChart data={data} margin={{ top: 6, right: 4, left: 4, bottom: 0 }}>
          <CartesianGrid stroke="var(--grid)" strokeWidth={1} vertical={false} />
          <XAxis dataKey="label" tick={{ fill: 'var(--muted)', fontSize: 10 }} axisLine={{ stroke: 'var(--baseline)' }} tickLine={false} minTickGap={18} />
          <YAxis hide domain={kind === 'bar' ? [0, 'auto'] : ['auto', 'auto']} />
          <Tooltip contentStyle={tooltipStyle} cursor={{ fill: 'var(--grid)', opacity: 0.4 }}
                   formatter={(v: number) => fmt(Number(v))} />
          {kind === 'bar'
            ? <Bar dataKey="cur" name={curName} fill="var(--series-1)" radius={[3, 3, 0, 0]} maxBarSize={14} />
            : <Line dataKey="cur" name={curName} stroke="var(--series-1)" strokeWidth={2} dot={false} type="monotone" connectNulls />}
          {hasLy && <Line dataKey="ly" name={lyName} stroke="var(--muted)" strokeWidth={1.5} strokeDasharray="4 3" dot={false} type="monotone" connectNulls />}
        </ComposedChart>
      </ResponsiveContainer>
      {hasLy && (
        <div className="muted" style={{ fontSize: 11, display: 'flex', gap: 12 }}>
          <span><span style={{ color: 'var(--series-1)' }} aria-hidden>■</span> {curName}</span>
          <span><span aria-hidden>┄</span> {lyName}</span>
        </div>
      )}
    </div>
  );
}

function HealthCard({ title, value, light, ly, lines, chart, explain, rule }: {
  title: string; value: string; light: Light; ly: string; lines: (string | false | null)[];
  chart: ReactNode; explain: string; rule: string;
}) {
  const t = useT();
  return (
    <div className="card card-block" style={{ borderTop: `3px solid ${LIGHT_COLOR[light]}`, margin: 0, minWidth: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <h2 style={{ margin: 0 }}>{title}</h2>
        <LightBadge light={light} />
      </div>
      <div style={{ fontSize: 26, fontWeight: 700, margin: '6px 0 2px', color: 'var(--ink)' }}>{value}</div>
      <div className="muted" style={{ fontSize: 12.5 }}>{t('去年同期')}: {ly}</div>
      {lines.filter(Boolean).map((l, i) => (
        <div key={i} style={{ fontSize: 12.5, marginTop: 3, color: 'var(--ink)' }}>{l}</div>
      ))}
      {chart}
      <p style={{ fontSize: 12.5, margin: '8px 0 4px', color: 'var(--ink)' }}>{explain}</p>
      <p className="muted" style={{ fontSize: 11.5, margin: 0 }}>{rule}</p>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <>
      <h2 style={{ fontSize: 14, color: 'var(--muted)', margin: '18px 0 8px', fontWeight: 600 }}>{title}</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 320px), 1fr))', gap: 14 }}>
        {children}
      </div>
    </>
  );
}

/* ---------- 分页 ---------- */

export default function Health() {
  const t = useT();
  const [months, setMonths] = useState<Monthly[] | null>(null);
  const [now, setNow] = useState<Now | null>(null);
  const [snaps, setSnaps] = useState<Snap[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const [m, w, s] = await Promise.all([
        supabase.from('bi_health_monthly').select('*').eq('company', COMPANY).order('yr').order('mth'),
        supabase.from('bi_health_now').select('*').eq('company', COMPANY).maybeSingle(),
        supabase.from('bi_health_snapshot').select('*').eq('company', COMPANY).order('snap_date'),
      ]);
      const failed = [m.error, w.error, s.error].filter(Boolean);
      setErr(failed.length ? failed.map((e) => e!.message).join(' / ') : null);
      setMonths((m.data ?? []).map((r: Record<string, unknown>) => ({
        yr: n(r.yr), mth: n(r.mth), net: n(r.net), net_ic: n(r.net_ic),
        sales_costed: n(r.sales_costed), cost_costed: n(r.cost_costed), gross_goods: n(r.gross_goods),
        sales_nocost: n(r.sales_nocost), sales_nocost_ic: n(r.sales_nocost_ic), nocost_lines: n(r.nocost_lines),
        last_date: (r.last_date as string | null) ?? null,
        gl_sales: nn(r.gl_sales), gl_sa: nn(r.gl_sa), gl_co: nn(r.gl_co), gl_purch: nn(r.gl_purch), gl_ep: nn(r.gl_ep),
      })));
      const wr = w.data as Record<string, unknown> | null;
      setNow(wr ? {
        as_of: String(wr.as_of), ly_as_of: String(wr.ly_as_of ?? ''),
        last_sales_date: (wr.last_sales_date as string | null) ?? null,
        mtd_net: n(wr.mtd_net), mtd_ic: n(wr.mtd_ic), ly_mtd_net: n(wr.ly_mtd_net), ly_mtd_ic: n(wr.ly_mtd_ic),
        ytd_net: n(wr.ytd_net), ytd_ic: n(wr.ytd_ic), ly_ytd_net: n(wr.ly_ytd_net), ly_ytd_ic: n(wr.ly_ytd_ic),
        refreshed_at: (wr.refreshed_at as string | null) ?? null,
        synced_at: (wr.synced_at as string | null) ?? null,
      } : null);
      setSnaps((s.data ?? []).map((r: Record<string, unknown>) => ({
        snap_date: String(r.snap_date), source: String(r.source),
        stock_cost: nn(r.stock_cost), stock_excluded: nn(r.stock_excluded), stock_neg: nn(r.stock_neg),
        slow_cost: nn(r.slow_cost), aging_total: nn(r.aging_total),
        ar_pos: nn(r.ar_pos), ar_neg: nn(r.ar_neg), ar_over90: nn(r.ar_over90), ar_ic: nn(r.ar_ic),
        ap_pos: nn(r.ap_pos), ap_neg: nn(r.ap_neg),
        sales_90: n(r.sales_90), sales_costed_90: n(r.sales_costed_90), cost_costed_90: n(r.cost_costed_90),
        sales_nocost_90: n(r.sales_nocost_90), purch_3m: nn(r.purch_3m), purch_days: nn(r.purch_days),
        refreshed_at: String(r.refreshed_at),
      })));
    })();
  }, []);

  const calc = useMemo(() => {
    if (!months || !now) return null;
    const key = (p: YM) => p.yr * 100 + p.mth;
    const byKey = new Map(months.map((r) => [key(r), r]));
    const get = (p: YM) => byKey.get(key(p));
    // as_of 是「已完整同步的最后一天」;它的下一天所在的月份才是还没完整的「本月」
    // (例:as_of = 10-31 时,10 月已经完整,算进近 12 个完整月)
    const [cy, cm] = addDays(now.as_of, 1).split('-').map(Number);
    // 近 12 个「完整」月(不含本月)
    const complete: YM[] = [];
    for (let i = 12; i >= 1; i--) {
      const d = new Date(cy, cm - 1 - i, 1);
      complete.push({ yr: d.getFullYear(), mth: d.getMonth() + 1 });
    }
    const last3 = complete.slice(-3);
    const lyOf = (p: YM): YM => ({ yr: p.yr - 1, mth: p.mth });
    const sumOver = (ps: YM[], f: (r: Monthly) => number) => ps.reduce((s, p) => { const r = get(p); return s + (r ? f(r) : 0); }, 0);
    const hasAll = (ps: YM[], f: (r: Monthly) => boolean) => ps.every((p) => { const r = get(p); return !!r && f(r); });
    const rangeLabel = (ps: YM[]) => `${ymLabel(ps[0].yr, ps[0].mth)} ~ ${ymLabel(ps[ps.length - 1].yr, ps[ps.length - 1].mth)}`;
    const series = (f: (p: YM) => number | null): Pt[] =>
      complete.map((p) => ({ label: ymShort(p), cur: f(p), ly: f(lyOf(p)) }));

    // ① 营收增长(不含卖给分行的集团内调拨)
    const ytd = now.ytd_net - now.ytd_ic, lyYtd = now.ly_ytd_net - now.ly_ytd_ic;
    const mtd = now.mtd_net - now.mtd_ic, lyMtd = now.ly_mtd_net - now.ly_mtd_ic;
    const revG = lyYtd > 0 ? ((ytd - lyYtd) / lyYtd) * 100 : null;
    const mtdG = lyMtd > 0 ? ((mtd - lyMtd) / lyMtd) * 100 : null;
    const icG = now.ly_ytd_ic > 0 ? ((now.ytd_ic - now.ly_ytd_ic) / now.ly_ytd_ic) * 100 : null;
    const revLight: Light = revG === null ? 'na' : revG >= TH.revGreenMin ? 'g' : revG < TH.revRedBelow ? 'r' : 'y';
    const revSeries = series((p) => { const r = get(p); return r ? r.net - r.net_ic : null; });

    // ② 可信毛利率(只算有成本记录的行);早于 GM_RELIABLE_FROM 的月份成本资料异常,不拿来比
    const gmFloor = GM_RELIABLE_FROM[COMPANY];
    const gmReliable = (p: YM) => !gmFloor || !ymBefore(p, gmFloor);
    const gmOf = (ps: YM[]) => {
      if (!ps.every(gmReliable)) return null;
      if (!hasAll(ps, (r) => r.sales_costed > 0)) return null;
      const s = sumOver(ps, (r) => r.sales_costed), c = sumOver(ps, (r) => r.cost_costed);
      return s > 0 ? ((s - c) / s) * 100 : null;
    };
    const gm = gmOf(last3), gmLy = gmOf(last3.map(lyOf));
    const curYM: YM = { yr: cy, mth: cm };
    const gmMtd = (() => { const r = get(curYM); return r && r.sales_costed > 0 ? ((r.sales_costed - r.cost_costed) / r.sales_costed) * 100 : null; })();
    const gmDelta = gm !== null && gmLy !== null ? gm - gmLy : null;
    const gmLight: Light = gmDelta === null ? 'na' : gmDelta <= -TH.gmRedDrop ? 'r' : gmDelta <= -TH.gmYellowDrop ? 'y' : 'g';
    const glOk = hasAll(complete, (r) => r.gl_sales !== null);
    const glSales12 = sumOver(complete, (r) => (r.gl_sales ?? 0) - (r.gl_sa ?? 0));
    const glGm = glOk && glSales12 > 0 ? ((glSales12 - sumOver(complete, (r) => r.gl_co ?? 0)) / glSales12) * 100 : null;
    const gmMonth = (p: YM) => { const r = get(p); return gmReliable(p) && r && r.sales_costed > 0 ? ((r.sales_costed - r.cost_costed) / r.sales_costed) * 100 : null; };
    const gmSeries = series(gmMonth);
    const gmLyHidden = complete.some((p) => !gmReliable(lyOf(p)));

    // ③ 费用率 = 总账 EP ÷ 销售(发票 + 现金单 − 贷项单,不含卖给分行;与营收卡片同口径)
    //    总部卖给分行的调拨(每月约 RM0.8～0.9M)不算销售,否则费用率会被稀释成一半左右。
    //    总账月份还没过账(gl_sales 为 null)就不算。
    const extSales = (r: Monthly) => r.net - r.net_ic;
    const glSalesOf = (r: Monthly) => (r.gl_sales ?? 0) - (r.gl_sa ?? 0);
    const epOf = (ps: YM[]) => {
      if (!hasAll(ps, (r) => r.gl_sales !== null)) return null;
      const s = sumOver(ps, extSales), e = sumOver(ps, (r) => r.gl_ep ?? 0);
      return s > 0 ? (e / s) * 100 : null;
    };
    const ep = epOf(last3), epLy = epOf(last3.map(lyOf));
    const epDelta = ep !== null && epLy !== null ? ep - epLy : null;
    const epLight: Light = epDelta === null ? 'na' : epDelta >= TH.epRedRise ? 'r' : epDelta >= TH.epYellowRise ? 'y' : 'g';
    const ep3 = sumOver(last3, (r) => r.gl_ep ?? 0), epSales3 = sumOver(last3, extSales);
    // 参考:分母用总账销售(SL − SA,总部含卖给分行)
    const epGlSales3 = sumOver(last3, glSalesOf);
    const epGl = hasAll(last3, (r) => r.gl_sales !== null) && epGlSales3 > 0 ? (ep3 / epGlSales3) * 100 : null;
    const epSeries = series((p) => { const r = get(p); return r && r.gl_sales !== null && extSales(r) > 0 ? ((r.gl_ep ?? 0) / extSales(r)) * 100 : null; });

    // ⑨ 资料品质:没有成本的销售占比
    const ncOf = (ps: YM[]) => {
      const g = sumOver(ps, (r) => r.gross_goods);
      return hasAll(ps, (r) => r.gross_goods > 0) && g > 0 ? (sumOver(ps, (r) => r.sales_nocost) / g) * 100 : null;
    };
    const nc = ncOf(last3), ncLy = ncOf(last3.map(lyOf));
    const ncAmt = sumOver(last3, (r) => r.sales_nocost);
    const ncIcPct = ncAmt > 0 ? (sumOver(last3, (r) => r.sales_nocost_ic) / ncAmt) * 100 : 0;
    const ncLines = Math.round(sumOver(last3, (r) => r.nocost_lines) / 3);
    const ncLight = lightLow(nc, TH.nocostGreen, TH.nocostRed);
    const ncSeries = series((p) => { const r = get(p); return r && r.gross_goods > 0 ? (r.sales_nocost / r.gross_goods) * 100 : null; });

    // ④～⑧ 余额类(每日快照)
    const live = snaps.filter((s) => s.source === 'live');
    const latest = live.length ? live[live.length - 1] : null;
    const firstStock = snaps.find((s) => s.stock_cost !== null)?.snap_date ?? null;
    const firstLive = live.length ? live[0].snap_date : null;
    const snapSeries = (f: (s: Snap) => number | null): Pt[] =>
      snaps.map((s) => ({ label: s.snap_date.slice(5), cur: f(s) }));

    const dio = latest ? dioOf(latest) : null;
    const dso = latest ? dsoOf(latest) : null;
    const dpo = latest ? dpoOf(latest) : null;
    const ccc = latest ? cccOf(latest) : null;
    const slow = latest ? slowOf(latest) : null;
    const ar90 = latest && latest.ar_pos ? ((latest.ar_over90 ?? 0) / latest.ar_pos) * 100 : null;
    const dpoLight: Light = dpo === null ? 'na'
      : dpo > TH.dpoRed ? 'r' : dpo < TH.dpoLow || dpo > TH.dpoHigh ? 'y' : 'g';

    const lights = {
      rev: revLight, gm: gmLight, ep: epLight,
      dio: lightLow(dio, TH.dioGreen, TH.dioRed), slow: lightLow(slow, TH.slowGreen, TH.slowRed),
      dso: worse(lightLow(dso, TH.dsoGreen, TH.dsoRed), lightLow(ar90, TH.ar90Green, TH.ar90Red)),
      dpo: dpoLight, ccc: lightLow(ccc, TH.cccGreen, TH.cccRed),
    };
    return {
      complete, last3, rangeLabel,
      ytd, lyYtd, mtd, lyMtd, revG, mtdG, icG, revSeries,
      gm, gmLy, gmMtd, gmDelta, glGm, gmSeries, gmLyHidden,
      ep, epLy, epDelta, ep3, epSales3, epGl, epSeries,
      nc, ncLy, ncAmt, ncIcPct, ncLines, ncLight, ncSeries,
      latest, firstStock, firstLive, snapSeries, dio, dso, dpo, ccc, slow, ar90,
      lights,
    };
  }, [months, now, snaps]);

  if (months === null) return <div className="loading">{t('载入中…')}</div>;
  if (err) return <div className="notice">{t('查询失败(此页仅老板账号可看):')}{err}</div>;
  if (!now || !calc) {
    return (
      <div className="notice">
        {t('{c} 还没有每日同步的销售 / 库存资料,健康度无法计算。', { c: t(COMPANIES[COMPANY] ?? COMPANY) })}
        {' '}{t('(KL 目前只有「实际销售」分页的资料;此页仅老板账号可看。)')}
      </div>
    );
  }

  const c = calc;
  const L = c.lights;
  const days = (v: number | null) => (v === null ? '—' : t('{n} 天', { n: fmtNum(Math.round(v)) }));
  const lyAsOf = now.ly_as_of || `${Number(now.as_of.slice(0, 4)) - 1}${now.as_of.slice(4)}`;
  const ytdStart = `${now.as_of.slice(0, 4)}-01-01`, lyYtdStart = `${lyAsOf.slice(0, 4)}-01-01`;
  const mtdStart = `${now.as_of.slice(0, 7)}-01`, lyMtdStart = `${lyAsOf.slice(0, 7)}-01`;
  // as_of 比「昨天」还早 = 今天还没同步(分行电脑没开机),数字少算了几天
  const stale = now.as_of < addDays(todayMY(), -1);
  const hasIc = now.ytd_ic !== 0 || now.ly_ytd_ic !== 0;
  const s = c.latest;
  const noLyBalance = t('没有去年的余额资料');
  const fromNote = (d: string | null) => (d ? t('每天自动累积,{d} 起才有资料;过几天就会出现趋势线。', { d }) : t('还没有快照资料'));

  // 页首总结
  const core: [string, Light][] = [
    [t('营收增长'), L.rev], [t('可信毛利率'), L.gm], [t('费用率'), L.ep],
    [t('库存周转天数'), L.dio], [t('滞销库存占比'), L.slow],
    [t('应收天数'), L.dso], [t('应付天数'), L.dpo], [t('现金周期'), L.ccc],
  ];
  const cnt = (l: Light) => core.filter(([, x]) => x === l).length;
  const reds = core.filter(([, x]) => x === 'r').map(([name]) => name);
  const yellows = core.filter(([, x]) => x === 'y').map(([name]) => name);

  return (
    <>
      <div className="notice" style={{ marginBottom: 6 }}>
        <strong>{t('公司健康度')}</strong> · {t(COMPANIES[COMPANY] ?? COMPANY)} · {t('{n} 个核心指标:', { n: core.length })}
        {' '}<span style={{ color: LIGHT_COLOR.g }} aria-hidden>●</span> {t('{k} 个正常', { k: cnt('g') })}
        {' · '}<span style={{ color: LIGHT_COLOR.y }} aria-hidden>▲</span> {t('{k} 个留意', { k: cnt('y') })}
        {' · '}<span style={{ color: LIGHT_COLOR.r }} aria-hidden>■</span> {t('{k} 个警示', { k: cnt('r') })}
        {cnt('na') > 0 && <> · {t('{k} 个资料不足', { k: cnt('na') })}</>}
        <div style={{ marginTop: 4 }}>
          {reds.length > 0
            ? t('先问红灯:{list}。', { list: reds.join(t('、')) })
            : yellows.length > 0 ? t('没有红灯;留意:{list}。', { list: yellows.join(t('、')) }) : t('全部正常,在轨道上。')}
          {' '}{t('资料品质:')}<LightBadge light={c.ncLight} />
        </div>
        <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
          {t('销售算到 {d}(已完整同步的最后一天),去年同期也算到 {ly}', { d: now.as_of, ly: lyAsOf })}
          {' · '}{t('最后同步 {t}', { t: fmtTime(now.synced_at) })}
          {stale && <> · <strong style={{ color: 'var(--ink)' }}>{t('今天还没同步,所以只算到 {d}', { d: now.as_of })}</strong></>}
          {' · '}{t('余额快照更新于 {t}', { t: fmtTime(now.refreshed_at) })}
        </div>
      </div>

      <Section title={t('① 成长与获利')}>
        <HealthCard
          title={t('营收增长')} light={L.rev}
          value={c.revG === null ? '—' : signed(c.revG) + '%'}
          ly={t('{a}({s} ～ {d})', { a: fmtRM(c.lyYtd), s: lyYtdStart, d: lyAsOf })}
          lines={[
            t('今年累计 {a}({s} ～ {d})', { a: fmtRM(c.ytd), s: ytdStart, d: now.as_of }),
            t('当月累计 {a}({s} ～ {d})· 去年同期 {b}({ls} ～ {ld},{p})', {
              a: fmtRM(c.mtd), s: mtdStart, d: now.as_of, b: fmtRM(c.lyMtd), ls: lyMtdStart, ld: lyAsOf,
              p: c.mtdG === null ? '—' : signed(c.mtdG) + '%',
            }),
            hasIc && t('另有卖给分行(集团内调拨):今年至今 {a},去年同期 {b}({p})',
              { a: fmtRM(now.ytd_ic), b: fmtRM(now.ly_ytd_ic), p: c.icG === null ? '—' : signed(c.icG) + '%' }),
          ]}
          chart={<Spark data={c.revSeries} kind="bar" fmt={fmtRM} curName={t('近 12 个月')} lyName={t('去年同月')} />}
          explain={t('生意有没有比去年大。看「今年累计」比较稳,月初的「当月累计」天数少、起伏大。总部的数字不含卖给分行的调拨(那是集团内部转货,分行自己的销售请切换到分行看)。')}
          rule={t('灯号:今年累计比去年同期 ≥ +{g}% 绿;{r}% ～ +{g}% 黄;低于 {r}% 红。', { g: TH.revGreenMin, r: TH.revRedBelow })}
        />
        <HealthCard
          title={t('可信毛利率')} light={L.gm}
          value={c.gm === null ? '—' : pct1(c.gm)}
          ly={c.gmLy === null ? '—' : pct1(c.gmLy)}
          lines={[
            t('近 3 个完整月({m})', { m: c.rangeLabel(c.last3) }),
            c.gmDelta !== null && t('比去年同期 {d} 个百分点', { d: signed(c.gmDelta) }),
            c.gmMtd !== null && t('本月至今 {p}', { p: pct1(c.gmMtd) }),
            c.glGm !== null && t('总账口径参考(近 12 个完整月):{p}', { p: pct1(c.glGm) }),
          ]}
          chart={<>
            <Spark data={c.gmSeries} kind="line" fmt={pct1} curName={t('近 12 个月')} lyName={t('去年同月')} />
            {c.gmLyHidden && (
              <div className="muted" style={{ fontSize: 11 }}>
                {t('总部 2024 年 4～12 月的成本资料异常(可信毛利率只有 −2%～10%),去年同月线不画这几个月,也不拿来比较。')}
              </div>
            )}
          </>}
          explain={t('每卖 RM100 赚多少毛利。只算有成本记录的行,避免没成本的行把毛利灌高(没成本的部分见下方「资料品质」)。比去年低,代表进价涨了、售价被压低或卖的货组合变了。总账口径的成本科目含进货、平台手续费、运费,没有扣存货变动,只供参考。')}
          rule={t('灯号:比去年同期低 {r} 个百分点以上 = 红;低 {y}～{r} 个百分点 = 黄;其他 = 绿。', { r: TH.gmRedDrop, y: TH.gmYellowDrop })}
        />
        <HealthCard
          title={t('费用率')} light={L.ep}
          value={c.ep === null ? '—' : pct1(c.ep)}
          ly={c.epLy === null ? '—' : pct1(c.epLy)}
          lines={[
            hasIc
              ? t('近 3 个完整月:营业费用 {e} ÷ 销售(不含卖给分行){s}', { e: fmtRM(c.ep3), s: fmtRM(c.epSales3) })
              : t('近 3 个完整月:营业费用 {e} ÷ 销售 {s}', { e: fmtRM(c.ep3), s: fmtRM(c.epSales3) }),
            c.epDelta !== null && t('比去年同期 {d} 个百分点', { d: signed(c.epDelta) }),
            hasIc && c.epGl !== null && t('参考:销售含卖给分行(总账 SL − SA)时是 {p}', { p: pct1(c.epGl) }),
          ]}
          chart={<Spark data={c.epSeries} kind="line" fmt={pct1} curName={t('近 12 个月')} lyName={t('去年同月')} />}
          explain={t('每卖 RM100 要花多少营业费用(薪水、租金、水电、广告…,总账 EP 科目)。销售与「营收增长」同口径,总部不含卖给分行的调拨。越低越好;比去年高,要看是费用涨了还是销售掉了。平台手续费记在成本类科目,不算在这里。12 月常有年底调整,会特别高。')}
          rule={t('灯号:比去年同期高 {r} 个百分点以上 = 红;高 {y}～{r} 个百分点 = 黄;其他 = 绿。', { r: TH.epRedRise, y: TH.epYellowRise })}
        />
      </Section>

      <Section title={t('② 库存')}>
        <HealthCard
          title={t('库存周转天数')} light={L.dio}
          value={days(c.dio)}
          ly={noLyBalance}
          lines={s ? [
            t('库存成本 {a}', { a: fmtRM(s.stock_cost) }),
            t('近 90 天销货成本(估){a}:有成本的行 {b} + 没成本的行估 {c}', {
              a: fmtRM(cogsDaily(s) * 90), b: fmtRM(s.cost_costed_90), c: fmtRM(cogsDaily(s) * 90 - s.cost_costed_90),
            }),
            (s.stock_excluded ?? 0) > 0 && t('未计入:次品 / 展示仓与服务项目 {a}', { a: fmtRM(s.stock_excluded) }),
          ] : []}
          chart={<Spark data={c.snapSeries(dioOf)} kind="line" fmt={(v) => t('{n} 天', { n: fmtNum(Math.round(v)) })}
                        curName={t('库存周转天数')} note={fromNote(c.firstStock)} />}
          explain={t('现在的库存照近 90 天的卖法,要多少天才卖得完。天数越长,钱压在货上越久、越容易变成滞销。')}
          rule={t('灯号:≤ {g} 天 绿;{g}～{r} 天 黄;> {r} 天 红。', { g: TH.dioGreen, r: TH.dioRed })}
        />
        <HealthCard
          title={t('滞销库存占比')} light={L.slow}
          value={c.slow === null ? '—' : pct1(c.slow)}
          ly={noLyBalance}
          lines={s && s.slow_cost !== null ? [
            t('滞销库存 {a} ÷ 库龄表库存 {b}', { a: fmtRM(s.slow_cost), b: fmtRM(s.aging_total) }),
          ] : []}
          chart={<Spark data={c.snapSeries(slowOf)} kind="line" fmt={pct1} curName={t('滞销库存占比')} note={fromNote(c.firstLive)} />}
          explain={t('超过 12 个月没进货、近 12 个月也没卖出的库存占多少。这些货很可能要打折、清仓或退供应商;逐项明细看「滞销品」分页。')}
          rule={t('灯号:≤ {g}% 绿;{g}%～{r}% 黄;> {r}% 红。', { g: TH.slowGreen, r: TH.slowRed })}
        />
      </Section>

      <Section title={t('③ 收付与现金')}>
        <HealthCard
          title={t('应收天数')} light={L.dso}
          value={days(c.dso)}
          ly={noLyBalance}
          lines={s && s.ar_pos !== null ? [
            (s.ar_ic ?? 0) > 0
              ? t('应收余额 {a}(其中分行 {b})', { a: fmtRM(s.ar_pos), b: fmtRM(s.ar_ic) })
              : t('应收余额 {a}', { a: fmtRM(s.ar_pos) }),
            t('逾期 90 天以上 {a}(占 {p})', { a: fmtRM(s.ar_over90), p: c.ar90 === null ? '—' : pct1(c.ar90) }),
            t('近 90 天日均销售 {a}', { a: fmtRM(s.sales_90 / 90) }),
            (s.ar_neg ?? 0) < 0 && t('另有客户订金 / 未冲销的收款 {a}(不拿来抵别的客户)', { a: fmtRM(-(s.ar_neg ?? 0)) }),
          ] : []}
          chart={<Spark data={c.snapSeries(dsoOf)} kind="line" fmt={(v) => t('{n} 天', { n: fmtNum(Math.round(v)) })}
                        curName={t('应收天数')} note={fromNote(c.firstLive)} />}
          explain={t('客户平均多少天付钱。越短越好;逾期 90 天以上的部分要追,追不回来就是坏账。')}
          rule={t('灯号:应收天数 ≤ {g} 天且逾期 90 天以上 ≤ {ag}% = 绿;应收天数 > {r} 天或逾期占比 > {ar}% = 红;其他 = 黄。',
            { g: TH.dsoGreen, r: TH.dsoRed, ag: TH.ar90Green, ar: TH.ar90Red })}
        />
        <HealthCard
          title={t('应付天数')} light={L.dpo}
          value={days(c.dpo)}
          ly={noLyBalance}
          lines={s && s.ap_pos !== null ? [
            t('应付供应商 {a}', { a: fmtRM(s.ap_pos) }),
            s.purch_3m !== null && s.purch_days
              ? t('近 3 个完整月进货 {a}(日均 {b})', { a: fmtRM(s.purch_3m), b: fmtRM(s.purch_3m / s.purch_days) })
              : t('总账没有进货资料'),
            (s.ap_neg ?? 0) < 0 && t('另有预付给供应商 {a}(付款先于发票入账)', { a: fmtRM(-(s.ap_neg ?? 0)) }),
          ] : []}
          chart={<Spark data={c.snapSeries(dpoOf)} kind="line" fmt={(v) => t('{n} 天', { n: fmtNum(Math.round(v)) })}
                        curName={t('应付天数')} note={fromNote(c.firstLive)} />}
          explain={t('我们平均多少天付钱给供应商。太短 = 钱很早就付出去(或先付订金);太长可能影响供应商关系与进价。')}
          rule={t('灯号:{lo}～{hi} 天 绿;少于 {lo} 天或 {hi}～{r} 天 黄;> {r} 天 红。', { lo: TH.dpoLow, hi: TH.dpoHigh, r: TH.dpoRed })}
        />
        <HealthCard
          title={t('现金周期')} light={L.ccc}
          value={days(c.ccc)}
          ly={noLyBalance}
          lines={[
            c.ccc !== null && t('= 库存 {a} 天 + 应收 {b} 天 − 应付 {c} 天', {
              a: fmtNum(Math.round(c.dio ?? 0)), b: fmtNum(Math.round(c.dso ?? 0)), c: fmtNum(Math.round(c.dpo ?? 0)),
            }),
          ]}
          chart={<Spark data={c.snapSeries(cccOf)} kind="line" fmt={(v) => t('{n} 天', { n: fmtNum(Math.round(v)) })}
                        curName={t('现金周期')} note={fromNote(c.firstLive)} />}
          explain={t('从付钱进货到把货款收回来,钱被占用多少天。越短,做同样的生意需要的现金越少;变长就要看是库存堆高、客户拖款,还是太早付款给供应商。')}
          rule={t('灯号:≤ {g} 天 绿;{g}～{r} 天 黄;> {r} 天 红。', { g: TH.cccGreen, r: TH.cccRed })}
        />
      </Section>

      <Section title={t('④ 资料品质')}>
        <HealthCard
          title={t('没有成本的销售占比')} light={c.ncLight}
          value={c.nc === null ? '—' : pct1(c.nc)}
          ly={c.ncLy === null ? '—' : pct1(c.ncLy)}
          lines={[
            t('近 3 个完整月没有成本的商品销售 {a}(每月约 {k} 行)', { a: fmtRM(c.ncAmt), k: fmtNum(c.ncLines) }),
            c.ncIcPct > 0 && t('其中 {p} 是卖给分行的发票', { p: pct1(c.ncIcPct) }),
          ]}
          chart={<Spark data={c.ncSeries} kind="line" fmt={pct1} curName={t('近 12 个月')} lyName={t('去年同月')} />}
          explain={t('有多少销售金额在 AutoCount 里没有商品成本(运费、平台费等服务项目不算)。这些行会让毛利率、库存天数失真,所以上面的毛利率把它们排除。请会计查这些发票为什么没有成本,补上后毛利才准。')}
          rule={t('灯号:≤ {g}% 绿;{g}%～{r}% 黄;> {r}% 红。', { g: TH.nocostGreen, r: TH.nocostRed })}
        />
      </Section>

      <div className="card card-block" style={{ marginTop: 18 }}>
        <h2>{t('口径说明')}</h2>
        <ul className="muted" style={{ fontSize: 12.5, paddingLeft: 18, margin: 0, lineHeight: 1.6 }}>
          <li>{t('资料来源:总部账套每天同步 4 次(马来西亚约 09:00 / 12:00 / 15:00 / 18:00),分行账套要分行电脑开机才会同步(有些天只有一次);本页的物化视图与余额快照每 2 小时(第 35 分)重算。')}</li>
          <li>{t('今年 / 当月累计只算到「已完整同步的最后一天」(页首的日期,通常是昨天),去年同期也算到同一天,不拿今天还没同步完的半天去比去年的整天;近 90 天的销售与成本也截到这一天。趋势只比较完整月份。')}</li>
          <li>{t('销售 = 发票 + 现金单 − 贷项单(不含税)。总部的营收灯号以「不含卖给分行」计算。')}</li>
          <li>{t('可信毛利率只算有成本记录的行(含退货冲回的成本);没有成本的行另列在「资料品质」。')}</li>
          <li>{t('库存 = 正库存的成本,不含 DEFECTS / DISPLAY 仓与服务项目(运费、平台费等);负库存(没转仓造成)不抵减。近 90 天销货成本 = 有成本行的成本 + 没成本行按同期成本率估算。')}</li>
          <li>{t('应收 / 应付:按客户 / 供应商把未结单据加总,只算净额为正的部分(AutoCount 很多收款没有冲销到发票,单看发票余额会虚高);逾期 90 天以上用「收款先抵最旧的单」估算。')}</li>
          <li>{t('应付天数用总账近 3 个完整月的进货(PURCHASES − PURCHASES RETURN)。费用率 = 总账营业费用(EP)÷ 销售(发票 + 现金单 − 贷项单,不含卖给分行,与营收同口径)。')}</li>
          <li>{t('滞销库存来自库龄表(最后进货日):超过 12 个月没进货,且近 12 个月销售数量为 0。')}</li>
          <li>{t('库存、应收、应付只有「现在」的余额,所以没有去年同期;库存趋势从 {a} 起有,应收 / 应付 / 滞销从 {b} 起每天累积。', { a: c.firstStock ?? '—', b: c.firstLive ?? '—' })}</li>
        </ul>
      </div>
    </>
  );
}
