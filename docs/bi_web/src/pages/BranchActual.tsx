import { useEffect, useMemo, useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { supabase, COMPANY } from '../lib/supabase';
import { fmtRM, fmtNum, fmtCompact } from '../lib/format';
import { useT } from '../lib/i18n';
import { Kpi } from '../components/ChartCard';

// 分行实际销售额:分行电脑上的 HomeWorks 营运系统(scripts/branch_actual.py)从分行 AutoCount 账套抓取后
// 推进 bi.branch_actual_month / bi.branch_actual_meta(见 bi_branch_actual_upsert)。给 JB Southern 店长看。
// 口径:Sales Order 全部 + 不是从 SO 转来的 Invoice − Credit Note,三种单据都排除 SalesAgent 空白的单。

type Row = { month: string; scope: string; category: string; so_amount: number; so_open: number; iv_amount: number; iv_direct: number; cn_amount: number; actual_amount: number };
type AgentRow = { doc: string; agent: string; docs: number; amount: number; direct?: number };
type Meta = { month: string; produced_by: string | null; updated_at: string; detail: { agents?: AgentRow[]; excluded_blank_agent?: Record<string, number> } | null };

const n = (v: unknown) => Number(v ?? 0);
const ym = (d: string) => d.slice(0, 7);
const ORANGE = '#f59e0b';

function num(v: number, strong = false) {
  return v
    ? <td className={'num' + (v < 0 ? ' neg' : '')} style={strong ? { fontWeight: 600 } : undefined}>{fmtNum(v, 2)}</td>
    : <td className="num muted">–</td>;
}

export default function BranchActual() {
  const t = useT();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [metas, setMetas] = useState<Meta[]>([]);
  const [sel, setSel] = useState<string>('');
  const [scope, setScope] = useState<'all' | 'hemos'>('all');
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const [r, m] = await Promise.all([
        supabase.from('bi_branch_actual_month')
          .select('month,scope,category,so_amount,so_open,iv_amount,iv_direct,cn_amount,actual_amount')
          .eq('company', COMPANY).order('month', { ascending: false }),
        supabase.from('bi_branch_actual_meta').select('month,produced_by,updated_at,detail')
          .eq('company', COMPANY).order('month', { ascending: false }),
      ]);
      const e = r.error ?? m.error;
      setErr(e ? e.message : null);
      const list = (r.data ?? []) as Row[];
      setRows(list);
      setMetas((m.data ?? []) as Meta[]);
      const months = Array.from(new Set(list.map((x) => x.month)));
      if (months.length && !sel) setSel(months[0]);
    })();
  }, []);

  const months = useMemo(() => Array.from(new Set((rows ?? []).map((x) => x.month))).sort().reverse(), [rows]);
  const cur = useMemo(() => (rows ?? []).filter((x) => x.month === sel && x.scope === scope)
    .sort((a, b) => n(b.actual_amount) - n(a.actual_amount)), [rows, sel, scope]);
  const meta = metas.find((m) => m.month === sel);
  const sum = (k: keyof Row) => cur.reduce((s, r) => s + n(r[k]), 0);
  const total = { so: sum('so_amount'), open: sum('so_open'), iv: sum('iv_amount'), direct: sum('iv_direct'), cn: sum('cn_amount'), actual: sum('actual_amount') };

  // 逐月趋势(所选品牌范围)
  const trend = useMemo(() => months.slice().sort().map((m) => ({
    m: ym(m),
    actual: (rows ?? []).filter((x) => x.month === m && x.scope === scope).reduce((s, r) => s + n(r.actual_amount), 0),
  })), [rows, months, scope]);

  // 各 agent:SO / 发票 / 贷项。实际销售额要有「非SO发票」才能算(新版脚本才有 direct 栏位)
  const agents = useMemo(() => {
    const list = meta?.detail?.agents ?? [];
    const by = new Map<string, { so: number; soDocs: number; iv: number; ivDocs: number; direct?: number; cn: number; cnDocs: number }>();
    list.forEach((a) => {
      const key = a.agent || '(blank)';
      const rec = by.get(key) ?? { so: 0, soDocs: 0, iv: 0, ivDocs: 0, cn: 0, cnDocs: 0 };
      if (a.doc === 'SO') { rec.so += n(a.amount); rec.soDocs += n(a.docs); }
      if (a.doc === 'IV') { rec.iv += n(a.amount); rec.ivDocs += n(a.docs); if (a.direct !== undefined) rec.direct = n(a.direct); }
      if (a.doc === 'CN') { rec.cn += n(a.amount); rec.cnDocs += n(a.docs); }
      by.set(key, rec);
    });
    const out = Array.from(by.entries()).map(([agent, r]) => ({
      agent, ...r,
      actual: r.direct === undefined ? undefined : r.so + r.direct - r.cn,
      blank: agent === '(blank)',
    }));
    const named = out.filter((a) => !a.blank).sort((a, b) => (b.actual ?? b.so + b.iv) - (a.actual ?? a.so + a.iv));
    const blank = out.find((a) => a.blank);
    return { named, blank, hasDirect: named.some((a) => a.direct !== undefined) };
  }, [meta]);

  if (rows === null) return <div className="loading">{t('载入中…')}</div>;
  if (!months.length) {
    return <div className="notice">{t('还没有分行实际销售额资料{err}。请在分行电脑上执行 setup_branch.bat 推送。', { err: err ? `:${err}` : '' })}</div>;
  }

  const scopeLabel = scope === 'all' ? 'All brand' : 'Hemos & Hemos X';
  const tipStyle = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12.5, color: 'var(--ink)' } as const;

  return (
    <>
      <div className="filters">
        <select value={sel} onChange={(e) => setSel(e.target.value)}>
          {months.map((m) => <option key={m} value={m}>{ym(m)}</option>)}
        </select>
        <div className="seg">
          <button className={scope === 'all' ? 'active' : ''} onClick={() => setScope('all')}>All brand</button>
          <button className={scope === 'hemos' ? 'active' : ''} onClick={() => setScope('hemos')}>Hemos &amp; Hemos X</button>
        </div>
        <span className="muted" style={{ fontSize: 12 }}>
          {t('分行账套')} · {t('更新于')} {meta?.updated_at ? meta.updated_at.slice(0, 16).replace('T', ' ') : '–'}
        </span>
      </div>
      {err && <div className="notice">{t('查询失败:{err}', { err })}</div>}

      <div className="grid-kpi">
        <Kpi label={`${t('当月实际销售额')} (${ym(sel)} · ${scopeLabel})`} value={fmtRM(total.actual)}
             sub={t('= SO 全部 + 非SO发票 − 贷项;排除 agent 空白')} />
        <Kpi label={t('Sales Order 全部')} value={fmtRM(total.so)} sub={t('其中未转发票 {v}', { v: fmtRM(total.open) })} />
        <Kpi label={t('非 SO 转来的发票')} value={fmtRM(total.direct)} sub={t('发票全部 {v}(含转自 SO 的)', { v: fmtRM(total.iv) })} />
        <Kpi label={t('贷项 (Credit Note)')} value={fmtRM(total.cn)} sub={meta?.detail?.excluded_blank_agent
          ? t('排除 agent 空白:{list}', { list: Object.entries(meta.detail.excluded_blank_agent).map(([k, v]) => `${k} ${fmtNum(v, 2)}`).join(' / ') || t('无') })
          : undefined} />
      </div>

      <div className="card card-block">
        <h2>{t('按类别')} · {ym(sel)} · {scopeLabel}</h2>
        <div className="table-scroll">
          <table className="data">
            <thead>
              <tr>
                <th>{t('类别')}</th>
                <th className="num">{t('SO 全部')}</th><th className="num">{t('其中未转发票')}</th>
                <th className="num">{t('非SO发票')}</th><th className="num">{t('发票全部')}</th>
                <th className="num">{t('贷项')}</th>
                <th className="num" style={{ color: ORANGE }}>{t('实际销售额')} RM</th><th className="num">{t('占比')}</th>
              </tr>
            </thead>
            <tbody>
              {cur.length === 0 && <tr><td colSpan={8} className="muted">{t('该月无数据')}</td></tr>}
              {cur.map((r) => (
                <tr key={r.category}>
                  <td>{r.category}</td>
                  {num(n(r.so_amount))}{num(n(r.so_open))}{num(n(r.iv_direct))}{num(n(r.iv_amount))}{num(n(r.cn_amount))}
                  <td className={'num' + (n(r.actual_amount) < 0 ? ' neg' : '')} style={{ color: ORANGE, fontWeight: 600 }}>{fmtNum(r.actual_amount, 2)}</td>
                  <td className="num">{total.actual ? ((n(r.actual_amount) / total.actual) * 100).toFixed(1) + '%' : '–'}</td>
                </tr>
              ))}
            </tbody>
            {cur.length > 0 && (
              <tfoot>
                <tr style={{ fontWeight: 650 }}>
                  <td>TOTAL</td>
                  {num(total.so, true)}{num(total.open, true)}{num(total.direct, true)}{num(total.iv, true)}{num(total.cn, true)}
                  <td className="num" style={{ color: ORANGE }}>{fmtNum(total.actual, 2)}</td><td className="num">100%</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>

      <div className="two-col">
        <div className="card card-block">
          <h2>{t('各 Sales Agent')} · {ym(sel)}{t('(全品牌)')}</h2>
          <div className="table-scroll">
            <table className="data">
              <thead>
                <tr>
                  <th>Agent</th>
                  <th className="num">{t('SO 全部')}</th><th className="num">{t('SO 单数')}</th>
                  <th className="num">{t('发票全部')}</th><th className="num">{t('发票单数')}</th>
                  <th className="num">{t('贷项')}</th>
                  <th className="num" style={{ color: ORANGE }}>{t('实际销售额')}</th>
                </tr>
              </thead>
              <tbody>
                {agents.named.length === 0 && <tr><td colSpan={7} className="muted">{t('该月无 agent 明细')}</td></tr>}
                {agents.named.map((a) => (
                  <tr key={a.agent}>
                    <td>{a.agent}</td>
                    {num(a.so)}<td className="num muted">{fmtNum(a.soDocs)}</td>
                    {num(a.iv)}<td className="num muted">{fmtNum(a.ivDocs)}</td>
                    {num(a.cn)}
                    <td className="num" style={{ color: ORANGE, fontWeight: 600 }}
                        title={a.direct === undefined ? '' : t('SO {so} + 非SO发票 {direct} − 贷项 {cn}', { so: fmtNum(a.so, 2), direct: fmtNum(a.direct, 2), cn: fmtNum(a.cn, 2) })}>
                      {a.actual === undefined ? '–' : fmtNum(a.actual, 2)}
                    </td>
                  </tr>
                ))}
                {agents.blank && (
                  <tr className="muted">
                    <td>{t('(agent 空白,已排除)')}</td>
                    {num(agents.blank.so)}<td className="num">{fmtNum(agents.blank.soDocs)}</td>
                    {num(agents.blank.iv)}<td className="num">{fmtNum(agents.blank.ivDocs)}</td>
                    {num(agents.blank.cn)}<td className="num">–</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {!agents.hasDirect && agents.named.length > 0 && (
            <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
              {t('各 agent 的实际销售额要分行电脑更新到新版脚本后才会有(需要「非SO发票」按 agent 拆分);表里的发票全部含转自 SO 的发票。')}
            </p>
          )}
        </div>

        <div className="card card-block">
          <h2>{t('逐月实际销售额')} · {scopeLabel}</h2>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={trend}>
              <CartesianGrid stroke="var(--grid)" vertical={false} />
              <XAxis dataKey="m" tick={{ fill: 'var(--muted)', fontSize: 12 }} />
              <YAxis tick={{ fill: 'var(--muted)', fontSize: 12 }} tickFormatter={fmtCompact} width={54} />
              <Tooltip contentStyle={tipStyle} formatter={(v: number) => [fmtRM(v), t('实际销售额')]} cursor={{ fill: 'rgba(219,232,250,.06)' }} />
              <Bar dataKey="actual" fill={ORANGE} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <p className="muted" style={{ fontSize: 12 }}>
        {t('口径:Sales Order 全部(含未转发票的部分)+ 不是从 SO 转来的 Invoice − Credit Note;三种单据都排除 Sales Agent 空白的单。')}
        {meta?.produced_by ? ` ${meta.produced_by.split('；')[0]}。` : ''}
      </p>
    </>
  );
}
