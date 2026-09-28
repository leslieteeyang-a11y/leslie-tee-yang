import { useEffect, useMemo, useState } from 'react';
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';
import { supabase, COMPANY } from '../lib/supabase';
import { fmtRM, fmtDate, fmtNum, fmtCompact } from '../lib/format';
import { Kpi } from '../components/ChartCard';
import { useT } from '../lib/i18n';

type ChDay = { doc_date: string; channel: string; is_store: boolean; net: number; orders: number };
type ChMonth = { yr: number; mth: number; channel: string; is_store: boolean; net: number; orders: number; net_mtd_equiv: number };
type AgentRow = { yr: number; mth: number; agent: string; net: number; orders: number; cust_n: number };
type Decline = {
  debtor_code: string; debtor_name: string; sales_agent: string | null; debtor_type: string | null;
  net_prev: number; net_cur: number; change_pct: number; last_order: string | null;
};
type Inactive = {
  debtor_code: string; name: string; debtor_type: string | null; sales_agent: string | null;
  net_prev12: number; last_iv: string | null; days_since: number | null;
};

// 渠道名与数据库 bi_mgr_channel_* 的 channel 值一致,不可翻译;显示时才用 t()
const CH_ORDER = ['门市现金', 'B2B客户', 'Shopee', 'Lazada', 'TikTok', '其他平台', '分行'];
const tooltipStyle = {
  background: 'var(--surface)', border: '1px solid var(--border)',
  borderRadius: 8, fontSize: 12.5, color: 'var(--ink)',
} as const;

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const pct = (cur: number, base: number) =>
  base ? `${cur >= base ? '+' : ''}${(((cur - base) / Math.abs(base)) * 100).toFixed(1)}%` : '—';

/* ---------------- 日报 ---------------- */
function DailyTab() {
  const t = useT();
  const [days, setDays] = useState<ChDay[] | null>(null);
  const [months, setMonths] = useState<ChMonth[] | null>(null);
  const [target, setTarget] = useState<number>(0);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const [d, m, tg] = await Promise.all([
        supabase.from('bi_mgr_channel_daily').select('*').eq('company', COMPANY),
        supabase.from('bi_mgr_channel_month').select('*').eq('company', COMPANY),
        supabase.from('bi_app_setting').select('value_num').eq('company', COMPANY).eq('key', 'store_month_target').maybeSingle(),
      ]);
      const failed = [d.error, m.error, tg.error].filter(Boolean);
      setErr(failed.length ? failed.map((e) => e!.message).join(' / ') : null);
      setDays((d.data ?? []).map((r) => ({ ...r, net: Number(r.net), orders: Number(r.orders) })) as ChDay[]);
      setMonths((m.data ?? []).map((r) => ({ ...r, net: Number(r.net), orders: Number(r.orders), net_mtd_equiv: Number(r.net_mtd_equiv ?? 0) })) as ChMonth[]);
      setTarget(Number(tg.data?.value_num ?? 0));
    })();
  }, []);

  const calc = useMemo(() => {
    if (!days || !months) return null;
    const lastDate = days.reduce((s, r) => (r.doc_date > s ? r.doc_date : s), '');
    const now = new Date();
    const thisYr = now.getFullYear(), thisMth = now.getMonth() + 1;
    const prevYr = thisMth === 1 ? thisYr - 1 : thisYr, prevMth = thisMth === 1 ? 12 : thisMth - 1;
    const monday = new Date(now); monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
    const weekFrom = ymd(monday);
    const sum = (rows: ChDay[], p: (r: ChDay) => boolean) => rows.filter(p).reduce((s, r) => s + r.net, 0);
    const cnt = (rows: ChDay[], p: (r: ChDay) => boolean) => rows.filter(p).reduce((s, r) => s + r.orders, 0);
    const lastStore = sum(days, (r) => r.doc_date === lastDate && r.is_store);
    const lastStoreOrders = cnt(days, (r) => r.doc_date === lastDate && r.is_store);
    const lastAll = sum(days, (r) => r.doc_date === lastDate);
    const weekStore = sum(days, (r) => r.doc_date >= weekFrom && r.is_store);
    const m = (yr: number, mth: number) => months.filter((r) => r.yr === yr && r.mth === mth);
    const mtdStore = m(thisYr, thisMth).filter((r) => r.is_store).reduce((s, r) => s + r.net, 0);
    const mtdAll = m(thisYr, thisMth).reduce((s, r) => s + r.net, 0);
    const prevSameStore = m(prevYr, prevMth).filter((r) => r.is_store).reduce((s, r) => s + r.net_mtd_equiv, 0);
    const prevFullStore = m(prevYr, prevMth).filter((r) => r.is_store).reduce((s, r) => s + r.net, 0);
    // 渠道表:本月 vs 上月同期
    const chRows = CH_ORDER.map((ch) => {
      const cur = m(thisYr, thisMth).filter((r) => r.channel === ch).reduce((s, r) => s + r.net, 0);
      const prevSame = m(prevYr, prevMth).filter((r) => r.channel === ch).reduce((s, r) => s + r.net_mtd_equiv, 0);
      const prevFull = m(prevYr, prevMth).filter((r) => r.channel === ch).reduce((s, r) => s + r.net, 0);
      const lySame = m(thisYr - 1, thisMth).filter((r) => r.channel === ch).reduce((s, r) => s + r.net_mtd_equiv, 0);
      return { ch, cur, prevSame, prevFull, lySame };
    }).filter((r) => r.cur !== 0 || r.prevFull !== 0);
    // 近 30 天趋势(dataKey 用英文键,图例 / tooltip 名称在 <Line name> 里翻译)
    const byDate = new Map<string, { store: number; all: number }>();
    for (const r of days) {
      const o = byDate.get(r.doc_date) ?? { store: 0, all: 0 };
      o.all += r.net; if (r.is_store) o.store += r.net;
      byDate.set(r.doc_date, o);
    }
    const trend = [...byDate.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1).slice(-30)
      .map(([d, v]) => ({ d: d.slice(5), store: Math.round(v.store), all: Math.round(v.all) }));
    return { lastDate, lastStore, lastStoreOrders, lastAll, weekStore, mtdStore, mtdAll, prevSameStore, prevFullStore, chRows, trend };
  }, [days, months]);

  if (days === null || months === null) return <div className="loading">{t('载入中…')}</div>;
  if (err) return <div className="notice">{t('查询失败:{e}', { e: err })}</div>;
  if (!calc) return null;
  const progress = target ? Math.min(100, (calc.mtdStore / target) * 100) : 0;
  const dayOfMonth = new Date().getDate();
  const daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
  const paceTarget = target * (dayOfMonth / daysInMonth);

  return (
    <>
      <div className="grid-kpi">
        <Kpi label={t('最近一天门店销售 ({d})', { d: calc.lastDate.slice(5) })} value={fmtRM(calc.lastStore)}
             sub={t('{n} 单 · 全公司 {rm}', { n: fmtNum(calc.lastStoreOrders), rm: fmtRM(calc.lastAll) })} />
        <Kpi label={t('本周门店销售 (周一起)')} value={fmtRM(calc.weekStore)} sub={t('门市现金 + B2B 客户')} />
        <Kpi label={t('本月门店销售')} value={fmtRM(calc.mtdStore)}
             sub={t('上月同期 {a} · {p}(上月全月 {b})', { a: fmtRM(calc.prevSameStore), p: pct(calc.mtdStore, calc.prevSameStore), b: fmtRM(calc.prevFullStore) })} />
        <Kpi label={t('本月全公司销售')} value={fmtRM(calc.mtdAll)} sub={t('含电商平台与分行')} />
      </div>

      {target > 0 && (
        <div className="card card-block">
          <h2>{t('本月门店目标')} {fmtRM(target)}</h2>
          <div style={{ background: 'var(--grid)', borderRadius: 8, height: 22, position: 'relative', overflow: 'hidden' }}>
            <div style={{ width: `${progress}%`, height: '100%', background: calc.mtdStore >= paceTarget ? 'var(--accent)' : '#f59e0b', borderRadius: 8 }} />
            <span style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', fontSize: 12.5, fontWeight: 650, color: 'var(--ink)' }}>
              {fmtRM(calc.mtdStore)} / {fmtRM(target)} · {progress.toFixed(1)}%
            </span>
          </div>
          <p className="muted" style={{ margin: '8px 0 0', fontSize: 12 }}>
            {t('本月已过 {d}/{n} 天,按进度应完成 {rm}', { d: dayOfMonth, n: daysInMonth, rm: fmtRM(paceTarget) })}
            {' — '}
            {calc.mtdStore >= paceTarget ? t('进度正常 ✅') : t('落后 {rm} ⚠️', { rm: fmtRM(paceTarget - calc.mtdStore) })}
          </p>
        </div>
      )}

      <div className="card card-block">
        <h2>{t('近 30 天销售趋势')}</h2>
        <ResponsiveContainer width="100%" height={240}>
          <LineChart data={calc.trend} margin={{ top: 8, right: 12, left: 8, bottom: 0 }}>
            <CartesianGrid stroke="var(--grid)" strokeWidth={1} vertical={false} />
            <XAxis dataKey="d" tick={{ fill: 'var(--muted)', fontSize: 11 }} axisLine={{ stroke: 'var(--baseline)' }} tickLine={false} minTickGap={20} />
            <YAxis tick={{ fill: 'var(--muted)', fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={fmtCompact} width={52} />
            <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => fmtRM(v)} />
            <Legend wrapperStyle={{ fontSize: 12.5 }} />
            <Line dataKey="store" name={t('门店')} stroke="var(--series-1)" strokeWidth={2.5} dot={false} type="monotone" />
            <Line dataKey="all" name={t('全公司')} stroke="var(--muted)" strokeWidth={1.5} dot={false} type="monotone" />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className="card card-block">
        <h2>{t('本月分渠道')}</h2>
        <div className="table-scroll">
          <table className="data">
            <thead><tr>
              <th>{t('渠道')}</th><th className="num">{t('本月至今')}</th><th className="num">{t('占比')}</th>
              <th className="num">{t('上月同期')}</th><th className="num">{t('环比')}</th><th className="num">{t('去年同月同期')}</th><th className="num">{t('同比')}</th>
            </tr></thead>
            <tbody>
              {calc.chRows.map((r) => (
                <tr key={r.ch}>
                  <td>{t(r.ch)}</td>
                  <td className="num" style={{ fontWeight: 600 }}>{fmtRM(r.cur)}</td>
                  <td className="num muted">{calc.mtdAll ? ((r.cur / calc.mtdAll) * 100).toFixed(1) + '%' : '—'}</td>
                  <td className="num">{fmtRM(r.prevSame)}</td>
                  <td className={'num' + (pct(r.cur, r.prevSame).startsWith('-') ? ' neg' : '')}>{pct(r.cur, r.prevSame)}</td>
                  <td className="num">{fmtRM(r.lySame)}</td>
                  <td className={'num' + (pct(r.cur, r.lySame).startsWith('-') ? ' neg' : '')}>{pct(r.cur, r.lySame)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted" style={{ margin: '8px 0 0', fontSize: 12 }}>
          {t('门店销售 = 门市现金 + B2B 客户(不含电商平台、不含分行调拨)。金额为净销售(发票−贷项)。数据随每日同步更新(13:00 / 19:30)。')}
        </p>
      </div>
    </>
  );
}

/* ---------------- 业务员 ---------------- */
function AgentTab() {
  const t = useT();
  const [rows, setRows] = useState<AgentRow[] | null>(null);
  const [ym, setYm] = useState<string>('');
  const [target, setTarget] = useState(0); // 每业务员默认月目标(bi_app_setting agent_month_target),0=未设不显示
  const [targetMap, setTargetMap] = useState<Record<string, number>>({}); // 个别业务员单独目标(key 形如 agent_month_target:EMILY)
  useEffect(() => {
    supabase.from('bi_mgr_agent_month').select('*').eq('company', COMPANY)
      .then(({ data }) => {
        const rs = (data ?? []).map((r) => ({ ...r, net: Number(r.net), orders: Number(r.orders), cust_n: Number(r.cust_n) })) as AgentRow[];
        setRows(rs);
        const list = [...new Set(rs.map((r) => `${r.yr}-${String(r.mth).padStart(2, '0')}`))].sort().reverse();
        if (list.length) setYm(list[0]);
      });
    supabase.from('bi_app_setting').select('key,value_num').eq('company', COMPANY).like('key', 'agent_month_target%')
      .then(({ data }) => {
        let def = 0; const map: Record<string, number> = {};
        for (const r of data ?? []) {
          if (r.key === 'agent_month_target') def = Number(r.value_num ?? 0);
          else map[r.key.slice('agent_month_target:'.length)] = Number(r.value_num ?? 0);
        }
        setTarget(def); setTargetMap(map);
      });
  }, []);
  if (rows === null) return <div className="loading">{t('载入中…')}</div>;
  const list = [...new Set(rows.map((r) => `${r.yr}-${String(r.mth).padStart(2, '0')}`))].sort().reverse();
  const [y, m] = ym.split('-').map(Number);
  const cur = rows.filter((r) => r.yr === y && r.mth === m).sort((a, b) => b.net - a.net);
  const now = new Date();
  const isCurMonth = y === now.getFullYear() && m === now.getMonth() + 1;
  const monthFrac = isCurMonth ? now.getDate() / new Date(y, m, 0).getDate() : 1; // 当月按天数进度比对,历史月按整月
  const prevYm = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
  const [py, pm] = prevYm.split('-').map(Number);
  const prevMap = new Map(rows.filter((r) => r.yr === py && r.mth === pm).map((r) => [r.agent, r.net]));
  const total = cur.reduce((s, r) => s + r.net, 0);
  return (
    <>
      <div className="filters">
        <label className="muted">{t('月份')}</label>
        <select value={ym} onChange={(e) => setYm(e.target.value)}>
          {list.map((v) => <option key={v} value={v}>{v}</option>)}
        </select>
        <span className="muted">{t('口径:门市 + B2B 客户销售(不含电商/分行);按开单时选的业务员归属')}</span>
      </div>
      <div className="card">
        <div className="table-scroll">
          <table className="data">
            <thead><tr>
              <th>#</th><th>{t('业务员')}</th><th className="num">{t('销售额')}</th>
              {target > 0 && <th className="num" title={t('默认每人月目标 {rm}', { rm: fmtRM(target) })}>{t('目标达成')}</th>}
              <th className="num">{t('占比')}</th>
              <th className="num">{t('单数')}</th><th className="num">{t('平均单值')}</th><th className="num">{t('客户数')}</th><th className="num">{t('上月')}</th><th className="num">{t('环比')}</th>
            </tr></thead>
            <tbody>
              {cur.map((r, i) => {
                const prev = Number(prevMap.get(r.agent) ?? 0);
                const tgt = targetMap[r.agent] ?? target; // 个别目标优先,否则用默认
                const ach = tgt > 0 ? r.net / tgt : 0;
                const behind = isCurMonth ? r.net < tgt * monthFrac : ach < 1;
                return (
                  <tr key={r.agent}>
                    <td className="muted">{i + 1}</td>
                    <td>{t(r.agent)}</td>
                    <td className="num" style={{ fontWeight: 600 }}>{fmtRM(r.net)}</td>
                    {target > 0 && (r.agent === '(未指定)' || tgt <= 0
                      ? <td className="num muted">—</td>
                      : <td className="num" title={t('目标 {rm}', { rm: fmtRM(tgt) })}
                            style={{ fontWeight: 650, color: ach >= 1 ? '#16a34a' : behind ? '#ef4444' : 'inherit' }}>
                          {(ach * 100).toFixed(0)}%
                        </td>)}
                    <td className="num muted">{total ? ((r.net / total) * 100).toFixed(1) + '%' : '—'}</td>
                    <td className="num">{fmtNum(r.orders)}</td>
                    <td className="num">{r.orders ? fmtRM(r.net / r.orders) : '—'}</td>
                    <td className="num">{fmtNum(r.cust_n)}</td>
                    <td className="num muted">{fmtRM(prev)}</td>
                    <td className={'num' + (pct(r.net, prev).startsWith('-') ? ' neg' : '')}>{pct(r.net, prev)}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot><tr style={{ fontWeight: 650 }}><td colSpan={2}>{t('合计')}</td>
              <td className="num">{fmtRM(total)}</td>{target > 0 && <td />}<td /><td className="num">{fmtNum(cur.reduce((s, r) => s + r.orders, 0))}</td><td colSpan={4} /></tr></tfoot>
          </table>
        </div>
        <p className="muted" style={{ marginBottom: 0, fontSize: 12 }}>
          {t('"(未指定)" = 开单时没选业务员的单。这个数越大,归属越不准 — 请提醒店员开单时选好业务员。')}
          {target > 0 && <> {t('目标达成按每人月目标 {rm}', { rm: fmtRM(target) })}
            {Object.keys(targetMap).length > 0 && <>{t('(单独目标: {list})', { list: Object.entries(targetMap).map(([a, v]) => `${a} ${fmtRM(v)}`).join(t('、')) })}</>}
            {t('计算;当月绿色=已达标、红色=落后于日历进度。')}</>}
        </p>
      </div>
    </>
  );
}

/* ---------------- 客户跟进 ---------------- */
function FollowTab() {
  const t = useT();
  const [decline, setDecline] = useState<Decline[] | null>(null);
  const [inactive, setInactive] = useState<Inactive[] | null>(null);
  useEffect(() => {
    (async () => {
      const [a, b] = await Promise.all([
        supabase.from('bi_alert_customer_decline').select('*').eq('company', COMPANY).order('net_prev', { ascending: false }),
        supabase.from('bi_mgr_customer_inactive').select('*').eq('company', COMPANY).order('net_prev12', { ascending: false }).limit(200),
      ]);
      setDecline((a.data ?? []) as Decline[]);
      setInactive((b.data ?? []) as Inactive[]);
    })();
  }, []);
  if (decline === null || inactive === null) return <div className="loading">{t('载入中…')}</div>;
  return (
    <>
      <div className="card card-block">
        <h2>{t('订货明显下滑的客户 · {n} 家', { n: decline.length })} <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>{t('(近 90 天比去年同期跌超 30%,去年同期 ≥ RM 5,000)')}</span></h2>
        <div className="table-scroll">
          <table className="data">
            <thead><tr><th>{t('客户')}</th><th>{t('类型')}</th><th>{t('业务员')}</th><th className="num">{t('去年同期')}</th><th className="num">{t('近 90 天')}</th><th className="num">{t('变化')}</th><th>{t('最近下单')}</th></tr></thead>
            <tbody>
              {decline.map((r) => (
                <tr key={r.debtor_code}>
                  <td title={r.debtor_code}>{r.debtor_name}</td>
                  <td className="muted">{r.debtor_type ?? ''}</td>
                  <td className="muted">{r.sales_agent ?? ''}</td>
                  <td className="num">{fmtRM(r.net_prev)}</td>
                  <td className="num">{fmtRM(r.net_cur)}</td>
                  <td className="num neg" style={{ fontWeight: 600 }}>{Number(r.change_pct).toFixed(0)}%</td>
                  <td className="muted">{r.last_order ? fmtDate(r.last_order) : <span className="neg">{t('90 天无单')}</span>}</td>
                </tr>
              ))}
              {decline.length === 0 && <tr><td colSpan={7} className="muted">{t('没有明显下滑的客户 👍')}</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      <div className="card card-block">
        <h2>{t('沉睡客户 · {n} 家', { n: inactive.length })} <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>{t('(之前一年买过 ≥ RM 3,000,近 90 天没来买 — 安排回访)')}</span></h2>
        <div className="table-scroll">
          <table className="data">
            <thead><tr><th>{t('客户')}</th><th>{t('类型')}</th><th>{t('业务员')}</th><th className="num">{t('之前 12 个月购买')}</th><th>{t('最后购买')}</th><th className="num">{t('已多久(天)')}</th></tr></thead>
            <tbody>
              {inactive.map((r) => (
                <tr key={r.debtor_code}>
                  <td title={r.debtor_code}>{r.name}</td>
                  <td className="muted">{r.debtor_type ?? ''}</td>
                  <td className="muted">{r.sales_agent ?? ''}</td>
                  <td className="num" style={{ fontWeight: 600 }}>{fmtRM(r.net_prev12)}</td>
                  <td className="muted">{fmtDate(r.last_iv)}</td>
                  <td className="num">{r.days_since ?? '—'}</td>
                </tr>
              ))}
              {inactive.length === 0 && <tr><td colSpan={6} className="muted">{t('没有沉睡客户 👍')}</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

export default function Manager() {
  const t = useT();
  const [sub, setSub] = useState<'daily' | 'agent' | 'follow'>('daily');
  return (
    <>
      <div className="seg" style={{ marginBottom: 14 }}>
        <button className={sub === 'daily' ? 'active' : ''} onClick={() => setSub('daily')}>{t('门店日报')}</button>
        <button className={sub === 'agent' ? 'active' : ''} onClick={() => setSub('agent')}>{t('业务员表现')}</button>
        <button className={sub === 'follow' ? 'active' : ''} onClick={() => setSub('follow')}>{t('客户跟进')}</button>
      </div>
      {sub === 'daily' && <DailyTab />}
      {sub === 'agent' && <AgentTab />}
      {sub === 'follow' && <FollowTab />}
    </>
  );
}
