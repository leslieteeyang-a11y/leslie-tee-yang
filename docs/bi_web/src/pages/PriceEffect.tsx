import { useEffect, useMemo, useState } from 'react';
import { supabase, COMPANY } from '../lib/supabase';
import { fmtRM, fmtDate, fmtNum } from '../lib/format';
import { Kpi } from '../components/ChartCard';
import { useT } from '../lib/i18n';

type Row = {
  item_code: string; description: string; item_group: string | null; item_type: string | null;
  change_date: string; prev_p1: number | null; new_p1: number; new_p2: number | null;
  days_after: number; qty_before: number; net_before: number; qty_after: number; net_after: number;
  daily_before: number; daily_after: number | null; avg_price_before: number | null; avg_price_after: number | null;
};

const pct = (cur: number, base: number) =>
  base ? `${cur >= base ? '+' : ''}${(((cur - base) / Math.abs(base)) * 100).toFixed(0)}%` : '—';

export default function PriceEffect() {
  const t = useT();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [brand, setBrand] = useState('');
  const [minDays, setMinDays] = useState(7);

  useEffect(() => {
    supabase.from('bi_price_effect').select('*').eq('company', COMPANY)
      .order('net_before', { ascending: false }).limit(1000)
      .then(({ data, error }) => {
        setErr(error ? error.message : null);
        setRows((data ?? []).map((r) => ({
          ...r, qty_before: Number(r.qty_before), qty_after: Number(r.qty_after),
          net_before: Number(r.net_before), net_after: Number(r.net_after),
          daily_before: Number(r.daily_before), daily_after: r.daily_after == null ? null : Number(r.daily_after),
        })) as Row[]);
      });
  }, []);

  const brands = useMemo(() => [...new Set((rows ?? []).map((r) => r.item_type ?? '(无)'))].sort(), [rows]);
  const shown = useMemo(() => (rows ?? []).filter((r) =>
    r.days_after >= minDays && (!brand || (r.item_type ?? '(无)') === brand)), [rows, brand, minDays]);

  if (rows === null) return <div className="loading">{t('载入中…')}</div>;
  if (err) return <div className="notice">{t('查询失败:')}{err}</div>;

  // 判定:调价后日均销量掉一半以上且之前有走量 = 卖不动预警;实收均价确实上去了才算涨价成功
  const judged = shown.map((r) => {
    const volDrop = r.daily_before > 0.2 && r.daily_after != null && r.daily_after < r.daily_before * 0.5;
    const volOk = r.daily_before > 0 && r.daily_after != null && r.daily_after >= r.daily_before * 0.8;
    const priceUp = r.avg_price_before != null && r.avg_price_after != null && r.avg_price_after > Number(r.avg_price_before) * 1.02;
    return { ...r, volDrop, status: volDrop ? 'drop' : (priceUp && volOk ? 'good' : 'watch') };
  });
  const withSales = judged.filter((r) => r.qty_before > 0);
  const nGood = judged.filter((r) => r.status === 'good').length;
  const nDrop = judged.filter((r) => r.status === 'drop').length;
  const rateB = withSales.reduce((s, r) => s + r.daily_before, 0);
  const rateA = withSales.reduce((s, r) => s + (r.daily_after ?? 0), 0);

  return (
    <>
      <div className="grid-kpi">
        <Kpi label={t('纳入观察的调价商品')} value={fmtNum(shown.length)}
             sub={t('近 12 个月调过 Price 1、调后已满 {d} 天', { d: minDays })} />
        <Kpi label={t('涨价成功')} value={fmtNum(nGood)} sub={t('实收均价上去了,销量基本没掉(≥80%)')} />
        <Kpi label={t('卖不动预警')} value={fmtNum(nDrop)} sub={t('调后日均销量掉超一半 — 考虑回调或促销')} />
        <Kpi label={t('整体销量变化')} value={rateB ? pct(rateA, rateB) : '—'}
             sub={t('调价前合计 {b} 件/天 → 调后 {a} 件/天', { b: rateB.toFixed(1), a: rateA.toFixed(1) })} />
      </div>

      <div className="filters">
        <label className="muted">{t('品牌')}</label>
        <select value={brand} onChange={(e) => setBrand(e.target.value)}>
          <option value="">{t('全部')}</option>
          {brands.map((b) => <option key={b} value={b}>{t(b)}</option>)}
        </select>
        <label className="muted">{t('调后至少满')}</label>
        <select value={minDays} onChange={(e) => setMinDays(Number(e.target.value))}>
          {[0, 7, 14, 30].map((n) => <option key={n} value={n}>{t('{n} 天', { n })}</option>)}
        </select>
        <span className="muted">{t('按调价前销售额从大到小排列')}</span>
      </div>

      <div className="card">
        <div className="table-scroll">
          <table className="data">
            <thead><tr>
              <th>{t('商品')}</th><th>{t('调价日')}</th><th className="num">Price 1</th>
              <th className="num">{t('实收均价 前→后')}</th><th className="num">{t('价变')}</th>
              <th className="num">{t('日均销量 前→后')}</th><th className="num">{t('量变')}</th>
              <th className="num">{t('调后天数')}</th><th>{t('判定')}</th>
            </tr></thead>
            <tbody>
              {judged.map((r) => (
                <tr key={r.item_code}>
                  <td title={r.item_code}>{r.description}
                    <div className="muted" style={{ fontSize: 11 }}>{r.item_code}{r.item_group ? ` · ${r.item_group}` : ''}</div></td>
                  <td className="muted">{fmtDate(r.change_date)}</td>
                  <td className="num">{r.prev_p1 != null ? `${fmtNum(r.prev_p1, 2)} → ` : ''}<strong>{fmtNum(r.new_p1, 2)}</strong></td>
                  <td className="num">
                    {r.avg_price_before != null ? fmtNum(r.avg_price_before, 2) : '—'} → {r.avg_price_after != null ? fmtNum(r.avg_price_after, 2) : '—'}
                  </td>
                  <td className={'num' + (r.avg_price_after != null && r.avg_price_before != null && r.avg_price_after < r.avg_price_before ? ' neg' : '')}>
                    {r.avg_price_before != null && r.avg_price_after != null ? pct(Number(r.avg_price_after), Number(r.avg_price_before)) : '—'}
                  </td>
                  <td className="num">{r.daily_before.toFixed(1)} → {r.daily_after != null ? r.daily_after.toFixed(1) : '—'}</td>
                  <td className={'num' + (r.volDrop ? ' neg' : '')} style={{ fontWeight: 600 }}>
                    {r.daily_after != null && r.daily_before > 0 ? pct(r.daily_after, r.daily_before) : '—'}
                  </td>
                  <td className="num">{r.days_after}</td>
                  <td>
                    {r.status === 'good' && <span className="badge ok">{t('✅ 成功')}</span>}
                    {r.status === 'drop' && <span className="badge fail">{t('卖不动')}</span>}
                    {r.status === 'watch' && <span className="badge" style={{ color: 'var(--muted)', background: 'rgba(148,163,184,.14)' }}>{t('观察')}</span>}
                  </td>
                </tr>
              ))}
              {judged.length === 0 && <tr><td colSpan={9} className="muted">{t('该筛选下暂无调价商品')}</td></tr>}
            </tbody>
          </table>
        </div>
        <p className="muted" style={{ marginBottom: 0, fontSize: 12 }}>
          {t('口径:每商品最近一次 Price 1 修改(来自 AutoCount 字段级日志),对比调价日前 30 天 vs 调价日后(最多 30 天)的销售。')}{' '}
          {t('"实收均价" = 实际销售金额 ÷ 数量(含折扣后的真实成交价,比价目表更真);旧 Price 1 只有该商品此前也改过价时才显示。')}{' '}
          {t('调后天数太短的判定不稳,建议看满 14 天以上的。')}
        </p>
      </div>
    </>
  );
}
