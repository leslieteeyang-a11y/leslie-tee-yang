import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';
import { supabase, COMPANY } from '../lib/supabase';
import { fmtRM, fmtNum, fmtCompact } from '../lib/format';
import { useT } from '../lib/i18n';

// 毛利分析(只有 owner 看;App 决定是否显示这个分页,资料层 RPC 也会挡非 owner)
// 资料:public.bi_margin_summary(p_company, p_from, p_to, p_ex_branch, p_top) 一次回全部区块(jsonb)
//      public.bi_margin_nocost_lines(...) 没成本明细(含单号),按下载按钮才查
// 口径:
//   * 销售净额 = 全部明细合计(CN 已是负数),与总览页一致
//   * 商品 / 服务费用 / 没商品代号 三种行分开;服务费用与无代号行不进商品毛利率
//   * 可信毛利 = 有成本(cost ≠ 0)的商品行;成本 = 0 的商品行另列「没成本」
//   * 扣费后毛利率 ≈ 可信毛利率 + 扣费净额(fee_net)÷ 商品销售。fee_net 只算 ONLINE(平台手续费、Voucher)、
//     SHIP FEE(网店运费)、PAY FEE、TRAN FEE、SERV FEE;代收的 GST、运费(DELIVERY)、刷卡利息、运输、安装不算,
//     否则 JB 的扣费后毛利率反而会比可信毛利率高。本月至今手续费还没过账完,扣费后一栏显示 —。
//   * 渠道(bi.sale_channel)只认总部的客户代号,JB 的客户几乎都会落到「B2B客户」,所以只有总部显示按渠道表

type Period = 'mtd' | 'last' | '3m' | '12m' | 'ytd';
type ItemTab = 'low' | 'neg' | 'hidden' | 'nocost';

type KpiData = {
  net_all: number; goods_net: number; net_c: number; cost_c: number; net_nc: number;
  lines_nc: number; items_nc: number; svc_net: number; svc_cost: number;
  noitem_net: number; noitem_cost: number; lines: number;
};
// fee_net:只有渠道 / 业务员有(RPC v5 起);svc_net 含代收款,不拿来算扣费后毛利率
type Dim = { k: string; net: number; net_c: number; cost_c: number; net_nc: number; svc_net: number; noitem_net: number; fee_net?: number };
type Item = {
  code: string; desc: string; grp: string; brand: string;
  qty: number; net: number; qty_c: number; net_c: number; cost_c: number;
  qty_nc: number; net_nc: number; lines_nc: number; ref_cost?: number | null;
};
type Svc = { cls: 'svc' | 'noitem'; grp: string; code: string; desc: string; net: number; cost: number; lines: number };
type TrendRow = { yr: number; mth: number; net: number; net_c: number; cost_c: number; net_nc: number; svc_net: number };
type Summary = {
  company: string; from: number; to: number; ex_branch: boolean; refreshed_at: string | null; has_branch: boolean;
  kpi: KpiData; svc: Svc[];
  dims: { grp?: Dim[]; brand?: Dim[]; channel?: Dim[]; agent?: Dim[] };
  low: Item[]; neg: Item[]; hidden: Item[]; nocost: Item[]; trend: TrendRow[];
};
type NocostLine = {
  doc_type: string; doc_no: string; doc_date: string; debtor_code: string | null; debtor_name: string | null;
  channel: string | null; item_code: string; desc: string | null; grp: string | null;
  qty: number | null; uom: string | null; unit_price: number | null; sub_total: number; sales_agent: string | null;
  cost: number | null;
};

const n = (v: unknown) => Number(v ?? 0);
const pad = (x: number) => String(x).padStart(2, '0');
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const ymLabel = (v: number) => `${Math.floor(v / 100)}-${pad(v % 100)}`;
const gmPct = (net: number, cost: number): number | null => (net ? ((net - cost) / net) * 100 : null);
const pctText = (v: number | null | undefined) => (v === null || v === undefined || !isFinite(v) ? '—' : v.toFixed(1) + '%');
const rm0 = (v: number) => fmtNum(Math.round(v));
const rmK = (v: number) => 'RM ' + fmtCompact(Math.round(v));
const tooltipStyle = {
  background: 'var(--surface)', border: '1px solid var(--border)',
  borderRadius: 8, fontSize: 12.5, color: 'var(--ink)',
} as const;

// RPC 的上限:bi_margin_nocost_lines 最多 5000 行(日期最早的先);bi_margin_summary 的 nocost 最多 2000 个商品
const LINES_CAP = 5000;

const PERIODS: { key: Period; label: string }[] = [
  { key: 'mtd', label: '本月至今' },
  { key: 'last', label: '上个月' },
  { key: '3m', label: '近 3 个月' },
  { key: '12m', label: '近 12 个月' },
  { key: 'ytd', label: '今年至今' },
];

// 期间(本地时间):近 3 / 12 个月含本月
function periodRange(p: Period): { from: string; to: string } {
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth();
  const first = (yy: number, mm: number) => new Date(yy, mm, 1);
  switch (p) {
    case 'mtd': return { from: ymd(first(y, m)), to: ymd(now) };
    case 'last': return { from: ymd(first(y, m - 1)), to: ymd(new Date(y, m, 0)) };
    case '3m': return { from: ymd(first(y, m - 2)), to: ymd(now) };
    case '12m': return { from: ymd(first(y, m - 11)), to: ymd(now) };
    case 'ytd': return { from: ymd(first(y, 0)), to: ymd(now) };
  }
}

function downloadCsv(name: string, header: string[], rows: (string | number | null)[][]) {
  const esc = (v: string | number | null) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = '﻿' + [header, ...rows].map((r) => r.map(esc).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = name; a.click();
  URL.revokeObjectURL(a.href);
}

function KpiCard({ label, value, sub, sub2, warn }: { label: string; value: string; sub?: string; sub2?: string; warn?: boolean }) {
  return (
    <div className="card kpi">
      <div className="label">{label}</div>
      <div className={'value' + (warn ? ' neg' : '')}>{value}</div>
      {sub && <div className="sub">{sub}</div>}
      {sub2 && <div className={'sub' + (warn ? ' neg' : '')}>{sub2}</div>}
    </div>
  );
}

/* ---------- 维度表(类别 / 品牌 / 渠道 / 业务员) ---------- */
function DimTable({ rows, keyLabel, emptyKey, totalProfit, showFees, feeIncomplete, limit }: {
  rows: Dim[]; keyLabel: string; emptyKey: string; totalProfit: number; showFees?: boolean;
  feeIncomplete?: boolean;   // 本月至今:手续费还没过账完,扣费后毛利率显示 —
  limit?: number;
}) {
  const t = useT();
  const [all, setAll] = useState(false);
  const shown = limit && !all ? rows.slice(0, limit) : rows;
  return (
    <>
      <div className="table-scroll">
        <table className="data">
          <thead><tr>
            <th>{keyLabel}</th>
            <th className="num">{t('商品销售')}</th>
            <th className="num">{t('可信毛利')}</th>
            <th className="num">{t('可信毛利率')}</th>
            {showFees
              ? <><th className="num">{t('扣费净额')}</th><th className="num">{t('扣费后毛利率')}</th></>
              : <th className="num">{t('占总毛利')}</th>}
            <th className="num">{t('没成本占比')}</th>
          </tr></thead>
          <tbody>
            {shown.length === 0 && <tr><td colSpan={showFees ? 7 : 6} className="muted">{t('没有资料')}</td></tr>}
            {shown.map((r) => {
              const profit = r.net_c - r.cost_c;
              const gm = gmPct(r.net_c, r.cost_c);
              const ncShare = r.net ? (r.net_nc / r.net) * 100 : null;
              const fee = n(r.fee_net);
              const afterFee = feeIncomplete ? null : !fee ? gm : gm !== null && r.net ? gm + (fee / r.net) * 100 : null;
              return (
                <tr key={r.k || '_'}>
                  <td>{r.k ? t(r.k) : t(emptyKey)}</td>
                  <td className="num" style={{ fontWeight: 600 }}>{rm0(r.net)}</td>
                  <td className={'num' + (profit < 0 ? ' neg' : '')}>{rm0(profit)}</td>
                  <td className={'num' + (gm !== null && gm < 0 ? ' neg' : '')}>{pctText(gm)}</td>
                  {showFees ? (
                    <>
                      <td className={'num' + (fee < 0 ? ' neg' : '')}>{fee ? rm0(fee) : '—'}</td>
                      <td className={'num' + (afterFee !== null && afterFee < 0 ? ' neg' : '')} style={{ fontWeight: 600 }}>
                        {pctText(afterFee)}
                      </td>
                    </>
                  ) : (
                    <td className="num muted">{totalProfit ? pctText((profit / totalProfit) * 100) : '—'}</td>
                  )}
                  <td className={'num' + (ncShare !== null && ncShare >= 10 ? ' neg' : ' muted')}>{pctText(ncShare)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {limit && rows.length > limit && (
        <button className="btn" style={{ marginTop: 8 }} onClick={() => setAll(!all)}>
          {all ? t('只看前 {n} 个', { n: limit }) : t('显示全部 {n} 个', { n: rows.length })}
        </button>
      )}
    </>
  );
}

/* ---------- 商品表((a) 低毛利 / (b) 负毛利 / (d) 被忽略) ---------- */
function ItemTable({ rows, lowLine }: { rows: Item[]; lowLine?: number }) {
  const t = useT();
  return (
    <div className="table-scroll">
      <table className="data">
        <thead><tr>
          <th>{t('商品')}</th><th>{t('类别')}</th>
          <th className="num">{t('数量')}</th><th className="num">{t('销售 (RM)')}</th>
          <th className="num">{t('成本 (RM)')}</th><th className="num">{t('毛利 (RM)')}</th>
          <th className="num">{t('毛利率')}</th><th className="num">{t('均价 / 均成本')}</th>
        </tr></thead>
        <tbody>
          {rows.length === 0 && <tr><td colSpan={8} className="muted">{t('没有符合条件的商品')}</td></tr>}
          {rows.map((r) => {
            const profit = r.net_c - r.cost_c;
            const gm = gmPct(r.net_c, r.cost_c);
            const red = profit < 0 || (lowLine !== undefined && gm !== null && gm < lowLine);
            return (
              <tr key={r.code}>
                <td style={{ minWidth: 200 }}>
                  {r.desc}
                  <div className="muted" style={{ fontSize: 11.5 }}>{r.code}{r.brand ? ` · ${r.brand}` : ''}</div>
                </td>
                <td className="muted">{r.grp || t('(未分组)')}</td>
                <td className="num">{fmtNum(r.qty_c)}</td>
                <td className="num" style={{ fontWeight: 600 }}>
                  {rm0(r.net_c)}
                  {r.net_nc !== 0 && <div className="muted" style={{ fontSize: 11.5, fontWeight: 400 }}>{t('另有没成本 {v}', { v: rm0(r.net_nc) })}</div>}
                </td>
                <td className="num">{rm0(r.cost_c)}</td>
                <td className={'num' + (profit < 0 ? ' neg' : '')}>{rm0(profit)}</td>
                <td className={'num' + (red ? ' neg' : '')} style={{ fontWeight: 600 }}>{pctText(gm)}</td>
                <td className="num" style={{ whiteSpace: 'nowrap' }}>
                  {r.qty_c ? fmtNum(r.net_c / r.qty_c, 2) : '—'} / {r.qty_c ? fmtNum(r.cost_c / r.qty_c, 2) : '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ---------- (c) 没成本商品 ---------- */
function NocostTable({ rows, limit }: { rows: Item[]; limit: number }) {
  const t = useT();
  return (
    <div className="table-scroll">
      <table className="data">
        <thead><tr>
          <th>{t('商品')}</th><th>{t('类别')}</th>
          <th className="num">{t('没成本数量')}</th><th className="num">{t('没成本销售额 (RM)')}</th>
          <th className="num">{t('行数')}</th><th className="num">{t('参考单位成本')}</th>
          <th className="num">{t('估计漏算成本 (RM)')}</th>
        </tr></thead>
        <tbody>
          {rows.length === 0 && <tr><td colSpan={7} className="muted">{t('这段期间没有没成本的商品行')}</td></tr>}
          {rows.slice(0, limit).map((r) => {
            const ref = r.ref_cost === null || r.ref_cost === undefined ? null : n(r.ref_cost);
            return (
              <tr key={r.code}>
                <td style={{ minWidth: 200 }}>
                  {r.desc}
                  <div className="muted" style={{ fontSize: 11.5 }}>{r.code}{r.brand ? ` · ${r.brand}` : ''}</div>
                </td>
                <td className="muted">{r.grp || t('(未分组)')}</td>
                <td className="num">{fmtNum(r.qty_nc)}</td>
                <td className="num neg" style={{ fontWeight: 600 }}>{rm0(r.net_nc)}</td>
                <td className="num">{fmtNum(r.lines_nc)}</td>
                <td className="num">{ref !== null ? fmtNum(ref, 2) : <span className="muted">{t('没有参考')}</span>}</td>
                <td className="num">{ref !== null ? rm0(ref * r.qty_nc) : '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function Margin() {
  const t = useT();
  const [period, setPeriod] = useState<Period>('3m');
  const [exBranch, setExBranch] = useState(false);
  const [data, setData] = useState<Summary | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [itemTab, setItemTab] = useState<ItemTab>('low');
  const [csvBusy, setCsvBusy] = useState(false);
  const [csvErr, setCsvErr] = useState<string | null>(null);
  const [csvCut, setCsvCut] = useState(false);   // 明细 CSV 碰到 RPC 的 5000 行上限
  const reqId = useRef(0);

  const range = useMemo(() => periodRange(period), [period]);

  useEffect(() => {
    const id = ++reqId.current;
    setLoading(true);
    setErr(null);
    setCsvCut(false);
    supabase.rpc('bi_margin_summary', {
      p_company: COMPANY, p_from: range.from, p_to: range.to, p_ex_branch: exBranch, p_top: 30,
    }).then(({ data: d, error }) => {
      if (id !== reqId.current) return;           // 期间切太快:只用最后一次的结果
      setLoading(false);
      if (error) { setErr(error.message); return; }
      setData((d ?? null) as Summary | null);
    });
  }, [range, exBranch]);

  const calc = useMemo(() => {
    if (!data) return null;
    const k = data.kpi;
    const profitC = n(k.net_c) - n(k.cost_c);
    const gm = gmPct(n(k.net_c), n(k.cost_c));
    const bookGm = gmPct(n(k.goods_net), n(k.cost_c));       // 账面:没成本的行当 0 成本
    const ncShare = n(k.goods_net) ? (n(k.net_nc) / n(k.goods_net)) * 100 : null;
    const branchRow = (data.dims.channel ?? []).find((r) => r.k === '分行');
    const branchNcShare = n(k.net_nc) && branchRow ? (n(branchRow.net_nc) / n(k.net_nc)) * 100 : null;
    const trend = data.trend.map((r) => ({
      m: `${String(r.yr).slice(2)}-${pad(r.mth)}`,
      gm: gmPct(n(r.net_c), n(r.cost_c)),
      nc: n(r.net) ? (n(r.net_nc) / n(r.net)) * 100 : null,
    }));
    return { profitC, gm, bookGm, ncShare, branchNcShare, trend };
  }, [data]);

  async function downloadLines() {
    setCsvBusy(true); setCsvErr(null); setCsvCut(false);
    const { data: d, error } = await supabase.rpc('bi_margin_nocost_lines', {
      p_company: COMPANY, p_from: range.from, p_to: range.to, p_ex_branch: exBranch,
    });
    setCsvBusy(false);
    if (error) { setCsvErr(error.message); return; }
    const lines = (d ?? []) as NocostLine[];
    setCsvCut(lines.length >= LINES_CAP);
    downloadCsv(`nocost_lines_${COMPANY}_${range.from}_${range.to}.csv`,
      ['DocType', 'DocNo', 'DocDate', 'DebtorCode', 'DebtorName', 'Channel', 'ItemCode', 'Description', 'Group',
       'Qty', 'UOM', 'UnitPrice', 'SubTotal', 'SalesAgent', 'CurrentCost', 'CostToFill'],
      lines.map((x) => [x.doc_type, x.doc_no, x.doc_date, x.debtor_code, x.debtor_name, x.channel, x.item_code,
        x.desc, x.grp, x.qty, x.uom, x.unit_price, x.sub_total, x.sales_agent, x.cost, '']));
  }

  function downloadItems() {
    if (!data) return;
    downloadCsv(`nocost_items_${COMPANY}_${range.from}_${range.to}.csv`,
      ['ItemCode', 'Description', 'Group', 'Brand', 'QtyNoCost', 'SalesNoCost', 'Lines', 'RefUnitCost', 'EstMissingCost'],
      data.nocost.map((r) => {
        const ref = r.ref_cost === null || r.ref_cost === undefined ? null : n(r.ref_cost);
        return [r.code, r.desc, r.grp, r.brand, r.qty_nc, r.net_nc, r.lines_nc,
          ref !== null ? ref.toFixed(4) : '', ref !== null ? (ref * r.qty_nc).toFixed(2) : ''];
      }));
  }

  const header = (
    <div className="filters">
      <div className="seg" style={{ flexWrap: 'wrap' }}>
        {PERIODS.map((p) => (
          <button key={p.key} className={period === p.key ? 'active' : ''} onClick={() => setPeriod(p.key)}>{t(p.label)}</button>
        ))}
      </div>
      {(data?.has_branch || exBranch) && (
        <div className="seg">
          <button className={!exBranch ? 'active' : ''} onClick={() => setExBranch(false)}>{t('含分行')}</button>
          <button className={exBranch ? 'active' : ''} onClick={() => setExBranch(true)}>{t('不含分行')}</button>
        </div>
      )}
      {data && (
        <span className="muted" style={{ fontSize: 12 }}>
          {t('期间 {a} ~ {b}', { a: ymLabel(data.from), b: ymLabel(data.to) })}
          {data.refreshed_at && <> · {t('数据更新于 {d}', { d: (() => { const x = new Date(data.refreshed_at); return `${ymd(x)} ${pad(x.getHours())}:${pad(x.getMinutes())}`; })() })}</>}
          {loading && <> · {t('载入中…')}</>}
        </span>
      )}
    </div>
  );

  if (!data && loading) return <>{header}<div className="loading">{t('载入中…')}</div></>;
  if (err && !data) return <>{header}<div className="notice">{t('查询失败(此页仅老板账号可看):')}{err}</div></>;
  if (!data || !calc) return <>{header}<div className="notice">{t('没有资料')}</div></>;

  const k = data.kpi;
  if (n(k.lines) === 0) {
    return (
      <>
        {header}
        <div className="notice">{t('这家公司在这段期间没有销售明细(BI 只有总部与 JB Southern 的发票明细;KL 目前只有分行电脑推的「实际销售」),所以算不出毛利。')}</div>
      </>
    );
  }

  const lowLine = calc.gm !== null ? calc.gm / 2 : undefined;
  const dims = data.dims;
  // 渠道规则只认总部的客户代号;JB 等分行账套不分渠道、也没有平台手续费,扣费后毛利率没有意义
  const isHQ = data.company === 'HOMEWORKSSB';
  const feeIncomplete = period === 'mtd';
  const ncCut = n(k.items_nc) > data.nocost.length;
  const itemTabs: { key: ItemTab; label: string; count: number }[] = [
    { key: 'low', label: '卖得多但毛利率低', count: data.low.length },
    { key: 'neg', label: '毛利为负', count: data.neg.length },
    { key: 'hidden', label: '赚钱但被忽略', count: data.hidden.length },
    { key: 'nocost', label: '没成本(给会计)', count: n(k.items_nc) },
  ];

  return (
    <>
      {header}
      {err && <div className="notice">{t('查询失败:')}{err}</div>}

      <div className="grid-kpi">
        <KpiCard label={t('销售净额')} value={fmtRM(k.net_all)}
                 sub={t('商品 {a} · 服务/费用 {b} · 无代号 {c}', { a: rmK(n(k.goods_net)), b: rmK(n(k.svc_net)), c: rmK(n(k.noitem_net)) })} />
        <KpiCard label={t('可信毛利')} value={fmtRM(calc.profitC)}
                 sub={t('只算有成本的商品行(销售 {v})', { v: rmK(n(k.net_c)) })} />
        <KpiCard label={t('可信毛利率')} value={pctText(calc.gm)}
                 sub={t('账面毛利率 {p}(没成本的行当 0 成本,会偏高)', { p: pctText(calc.bookGm) })} />
        <KpiCard label={t('没成本的销售额')} value={fmtRM(k.net_nc)} warn={n(k.net_nc) > 0}
                 sub={t('占商品销售 {p} · {a} 行 / {b} 个商品', { p: pctText(calc.ncShare), a: fmtNum(k.lines_nc), b: fmtNum(k.items_nc) })}
                 sub2={n(k.net_nc) > 0 ? t('请会计在 AutoCount 补成本价') : undefined} />
      </div>

      {calc.branchNcShare !== null && calc.branchNcShare >= 30 && !exBranch && (
        <div className="notice" style={{ marginBottom: 14 }}>
          {t('没成本的金额里,{p} 来自「分行」渠道(总部开给 HOMEWORKS (SOUTHERN) 的整批调拨发票)。按「不含分行」可以看对外生意的毛利。', { p: pctText(calc.branchNcShare) })}
        </div>
      )}

      <div className="card card-block">
        <h2>{t('近 12 个月可信毛利率')}</h2>
        <ResponsiveContainer width="100%" height={240}>
          <LineChart data={calc.trend} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="var(--grid)" strokeWidth={1} vertical={false} />
            <XAxis dataKey="m" tick={{ fill: 'var(--muted)', fontSize: 11 }} axisLine={{ stroke: 'var(--baseline)' }} tickLine={false} minTickGap={12} />
            <YAxis tick={{ fill: 'var(--muted)', fontSize: 11 }} axisLine={false} tickLine={false} width={44}
                   tickFormatter={(v: number) => `${v}%`}
                   domain={[0, (max: number) => Math.min(100, Math.max(10, Math.ceil(max / 10) * 10))]} />
            <Tooltip contentStyle={tooltipStyle} formatter={(v: unknown) => (typeof v === 'number' ? `${v.toFixed(1)}%` : '—')} />
            <Legend wrapperStyle={{ fontSize: 12.5 }} />
            <Line dataKey="gm" name={t('可信毛利率')} stroke="var(--series-1)" strokeWidth={2} dot={{ r: 3 }} activeDot={{ r: 5 }} type="monotone" connectNulls={false} />
            <Line dataKey="nc" name={t('没成本占商品销售')} stroke="var(--series-2)" strokeWidth={2} strokeDasharray="5 4" dot={{ r: 3 }} activeDot={{ r: 5 }} type="monotone" connectNulls={false} />
          </LineChart>
        </ResponsiveContainer>
        <p className="muted" style={{ margin: '8px 0 0', fontSize: 12 }}>
          {t('实线是只算有成本行的毛利率;虚线是没成本的销售占比——虚线越高,那个月的毛利率越不可靠。本月只到今天。')}
        </p>
      </div>

      {isHQ ? (
        <div className="card card-block">
          <h2>{t('按渠道')}</h2>
          {feeIncomplete && (
            <div className="notice" style={{ marginBottom: 10 }}>
              {t('本月的平台手续费还没过账完(Shopee 每周汇总过账一次),所以「本月至今」不显示扣费后毛利率。请看「上个月」或「近 3 个月」。')}
            </div>
          )}
          <DimTable rows={dims.channel ?? []} keyLabel={t('渠道')} emptyKey="(未分类)" totalProfit={calc.profitC}
                    showFees feeIncomplete={feeIncomplete} />
          <p className="muted" style={{ margin: '8px 0 0', fontSize: 12 }}>
            {t('扣费净额 = 平台手续费(ONLINE000002)、Voucher 折扣、刷卡 / 转账费(负数),加上网店向客人收的运费(正数);代收的 GST、运费、刷卡利息、运输费、安装费不算。扣费后毛利率 ≈ 可信毛利率 + 扣费净额 ÷ 商品销售,是估计值;手续费是汇总过账,期间越短越不准。')}
          </p>
        </div>
      ) : (
        <p className="muted" style={{ margin: '0 0 14px', fontSize: 12 }}>
          {t('这个账套的客户代号没有对应到渠道(渠道规则只认总部的客户代号),也没有平台手续费,所以不分渠道、不算扣费后毛利率,请看按业务员。')}
        </p>
      )}

      <div className="two-col">
        <div className="card card-block">
          <h2>{t('按类别')}</h2>
          <DimTable rows={dims.grp ?? []} keyLabel={t('类别')} emptyKey="(未分组)" totalProfit={calc.profitC} />
        </div>
        <div className="card card-block">
          <h2>{t('按业务员')}</h2>
          <DimTable rows={dims.agent ?? []} keyLabel={t('业务员')} emptyKey="(未指定)" totalProfit={calc.profitC}
                    showFees={isHQ} feeIncomplete={feeIncomplete} />
        </div>
      </div>

      <div className="card card-block">
        <h2>{t('按品牌')}</h2>
        <DimTable rows={dims.brand ?? []} keyLabel={t('品牌')} emptyKey="(未设品牌)" totalProfit={calc.profitC} limit={15} />
      </div>

      <div className="card card-block">
        <h2>{t('商品排行')}</h2>
        <div className="seg" style={{ marginBottom: 10, flexWrap: 'wrap' }}>
          {itemTabs.map((x) => (
            <button key={x.key} className={itemTab === x.key ? 'active' : ''} onClick={() => setItemTab(x.key)}>
              {t(x.label)} ({fmtNum(x.count)})
            </button>
          ))}
        </div>
        {itemTab === 'low' && (
          <>
            <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>
              {t('有成本的销售额前 100 名里,毛利率最低的 {n} 个。红色 = 亏钱,或低于公司平均毛利率的一半({p})。', { n: data.low.length, p: pctText(lowLine) })}
            </p>
            <ItemTable rows={data.low} lowLine={lowLine} />
          </>
        )}
        {itemTab === 'neg' && (
          <>
            <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>
              {t('有成本的销售扣掉成本后是负数(卖一件亏一件)。售价 0 的赠品(例如 STOCK A 群组)也会出现在这里——那是送出去的货的成本。')}
            </p>
            <ItemTable rows={data.neg} />
          </>
        )}
        {itemTab === 'hidden' && (
          <>
            <p className="muted" style={{ marginTop: 0, fontSize: 12 }}>
              {t('毛利率比公司平均高 30% 以上、有成本的销售至少 RM 300,但销售额不在前 100 名的商品——可以考虑多推、放首页或给业务员奖励。')}
            </p>
            <ItemTable rows={data.hidden} />
          </>
        )}
        {itemTab === 'nocost' && (
          <>
            <div className="filters" style={{ marginBottom: 8 }}>
              <button className="btn" onClick={downloadItems} disabled={!data.nocost.length}>{t('下载商品清单 CSV')}</button>
              <button className="btn primary" onClick={downloadLines} disabled={csvBusy || !data.nocost.length}>
                {csvBusy ? t('准备中…') : t('下载明细(含单号)CSV')}
              </button>
              <span className="muted" style={{ fontSize: 12 }}>
                {t('明细 CSV 列出每一张没成本(或成本正负号填错)的发票行,会计照单号在 AutoCount 打开补成本;补好后隔天这里就会变少。')}
              </span>
            </div>
            {csvErr && <div className="notice">{t('查询失败:')}{csvErr}</div>}
            {ncCut && (
              <div className="notice" style={{ marginBottom: 8 }}>
                {t('没成本的商品共 {b} 个,这里和商品清单 CSV 只列没成本金额最高的 {a} 个。要看全部,请缩短期间,或下载明细 CSV。', { a: fmtNum(data.nocost.length), b: fmtNum(k.items_nc) })}
              </div>
            )}
            {csvCut && (
              <div className="notice" style={{ marginBottom: 8 }}>
                {t('明细超过 {n} 行,CSV 只有日期最早的 {n} 行。请缩短期间分次下载。', { n: fmtNum(LINES_CAP) })}
              </div>
            )}
            <NocostTable rows={data.nocost} limit={100} />
            {data.nocost.length > 100 && (
              <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>{t('只显示前 100 个,完整清单请下载 CSV。')}</p>
            )}
            <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
              {t('参考单位成本 = 同一商品近 12 个月有成本的行的平均成本;估计漏算成本 = 参考单位成本 × 没成本数量(单位不同时只是粗估)。')}
            </p>
          </>
        )}
      </div>

      <div className="card card-block">
        <h2>{t('服务 / 费用与没有商品代号的行(不算进商品毛利率)')}</h2>
        <div className="table-scroll">
          <table className="data">
            <thead><tr>
              <th>{t('项目')}</th><th>{t('群组')}</th>
              <th className="num">{t('净额 (RM)')}</th><th className="num">{t('成本 (RM)')}</th><th className="num">{t('行数')}</th>
            </tr></thead>
            <tbody>
              {data.svc.length === 0 && <tr><td colSpan={5} className="muted">{t('没有资料')}</td></tr>}
              {data.svc.map((r) => (
                <tr key={r.cls + r.code}>
                  <td>
                    {r.cls === 'noitem' ? t('(没有商品代号的自由输入行)') : (r.desc || r.code)}
                    {r.cls !== 'noitem' && <div className="muted" style={{ fontSize: 11.5 }}>{r.code}</div>}
                  </td>
                  <td className="muted">{r.cls === 'noitem' ? '—' : r.grp}</td>
                  <td className={'num' + (r.net < 0 ? ' neg' : '')} style={{ fontWeight: 600 }}>{rm0(r.net)}</td>
                  <td className="num">{rm0(r.cost)}</td>
                  <td className="num">{fmtNum(r.lines)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted" style={{ margin: '8px 0 0', fontSize: 12 }}>
          {t('这些行本来就没有进货成本(平台手续费、Voucher、运费、安装、转账费、代收的 GST / 运费等),或是开单时没选商品代号的自由输入行,所以单独列出,不混进商品毛利率。')}
        </p>
      </div>

      <div className="card card-block">
        <h2>{t('口径说明')}</h2>
        <ul className="muted" style={{ fontSize: 12.5, margin: 0, paddingLeft: 18, lineHeight: 1.7 }}>
          <li>{t('销售净额 = 发票 + 现金单 − 贷项单(CN)的明细合计,与总览页相同。数字每 2 小时重算一次(每逢双数小时的第 45 分),最多慢 2 小时。')}</li>
          <li>{t('可信毛利 / 可信毛利率只算「有成本」的商品行(成本 ≠ 0 且正负号跟销售一样)。成本 = 0 的商品行另列为「没成本」,不混进毛利率,否则毛利率会被灌高。')}</li>
          <li>{t('成本跟销售正负相反的行(例如发票卖 RM 212、成本却是 −0.92)是成本算错,也归到「没成本」,一样列给会计修。')}</li>
          <li>{t('服务 / 费用群组(ONLINE、SHIP FEE、PAY FEE、TRAN FEE、SERV FEE、INSTALL、TRANSPOR、DELIVERY、SERV INC、CARD INT、GST)与没有商品代号的行另外列,不算商品毛利率。')}</li>
          <li>{t('为什么总部有那么多成本 = 0 的行:按行数算,大部分是网店订单里的运费行(ONLINE SHIPPING FEES 等服务项目,本来就没成本,这页已分开);按金额算,大部分是开给分行 HOMEWORKS (SOUTHERN) 的整批调拨发票,其次是 SAMPLE 样品与新商品。')}</li>
          <li>{t('没成本的商品行有两种:同一个月别张发票有成本(单据问题,例如货先用 DO 出库、发票由 DO 转入,成本留在 DO),以及整个月都没有成本(新商品或样品,开单时还没有进货成本)。请会计用明细 CSV 逐张核对。')}</li>
          <li>{t('「不含分行」= 剔除总部开给分行的集团内调拨发票,只看对外生意。')}</li>
        </ul>
      </div>
    </>
  );
}
