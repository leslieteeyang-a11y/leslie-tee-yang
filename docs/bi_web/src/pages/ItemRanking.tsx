import { useEffect, useState } from 'react';
import { supabase, COMPANY } from '../lib/supabase';
import { fmtRM, fmtNum } from '../lib/format';
import { useT } from '../lib/i18n';

type Row = {
  item_code: string; item_description: string | null; item_group: string | null;
  qty: number; net: number; profit?: number;
};

function prevMonth(): string {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function RankTable({ title, rows, hint, showProfit = true }: { title: string; rows: Row[]; hint?: string; showProfit?: boolean }) {
  const t = useT();
  return (
    <div className="card card-block">
      <h2>{title}</h2>
      <div className="table-scroll">
        <table className="data">
          <thead>
            <tr>
              <th>#</th><th>{t('商品')}</th>
              <th className="num">{t('销量')}</th><th className="num">{t('销售额')}</th>{showProfit && <th className="num">{t('毛利')}</th>}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={showProfit ? 5 : 4} className="muted">{t('该月无数据')}</td></tr>
            )}
            {rows.map((r, i) => (
              <tr key={r.item_code}>
                <td className="muted">{i + 1}</td>
                <td title={r.item_code}>
                  {r.item_description ?? r.item_code}
                  {r.item_group ? <span className="muted"> · {r.item_group}</span> : null}
                </td>
                <td className={'num' + (Number(r.qty) < 0 ? ' neg' : '')}>{fmtNum(r.qty)}</td>
                <td className={'num' + (Number(r.net) < 0 ? ' neg' : '')}>{fmtRM(r.net)}</td>
                {showProfit && (
                  <td className={'num' + (Number(r.profit) < 0 ? ' neg' : '')} style={{ fontWeight: 600 }}>
                    {fmtRM(r.profit)}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {hint && <p className="muted" style={{ marginBottom: 0 }}>{hint}</p>}
    </div>
  );
}

export default function ItemRanking({ showProfit = true }: { showProfit?: boolean }) {
  const t = useT();
  const VIEW = showProfit ? 'bi_item_rank_m' : 'bi_item_rank_m_nc';
  const COLS = 'item_code,item_description,item_group,qty,net' + (showProfit ? ',profit' : '');
  const [month, setMonth] = useState<string>(prevMonth());
  const [months, setMonths] = useState<string[]>([]);
  const [topQty, setTopQty] = useState<Row[]>([]);
  const [topProfit, setTopProfit] = useState<Row[]>([]);
  const [lowQty, setLowQty] = useState<Row[]>([]);
  const [lowProfit, setLowProfit] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      // 月份列表也要按角色选视图:manager/sales 查 bi_sales_monthly 只会得到 0 行
      const { data } = await supabase.from(showProfit ? 'bi_sales_monthly' : 'bi_sales_monthly_nc').select('yr,mth')
        .eq('company', COMPANY).order('yr', { ascending: false }).order('mth', { ascending: false });
      const list = (data ?? []).map((r) => `${r.yr}-${String(r.mth).padStart(2, '0')}`);
      setMonths(list);
      // 默认上个月;若上个月无数据(如月初),落到最近有数据的月份
      if (list.length && !list.includes(prevMonth())) setMonth(list[0]);
    })();
  }, [showProfit]);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const [y, m] = month.split('-').map(Number);
      const base = () => supabase.from(VIEW)
        .select(COLS)
        .eq('company', COMPANY).eq('yr', y).eq('mth', m);
      const [a, b, c, d] = await Promise.all([
        base().order('qty', { ascending: false }).limit(20),
        showProfit ? base().order('profit', { ascending: false }).limit(20) : base().order('net', { ascending: false }).limit(20),
        base().gt('qty', 0).order('qty', { ascending: true }).limit(20),
        showProfit ? base().order('profit', { ascending: true }).limit(20) : base().order('net', { ascending: true }).limit(20),
      ]);
      const failed = [a.error, b.error, c.error, d.error].filter(Boolean);
      setErr(failed.length ? failed.map((e) => e!.message).join(' / ') : null);
      const cast = (x: { data: unknown }) => ((x.data ?? []) as Row[]);
      setTopQty(cast(a)); setTopProfit(cast(b)); setLowQty(cast(c)); setLowProfit(cast(d));
      setLoading(false);
    })();
  }, [month]);

  return (
    <>
      <div className="filters">
        <label className="muted">{t('月份')}</label>
        <select value={month} onChange={(e) => setMonth(e.target.value)}>
          {!months.includes(month) && <option value={month}>{month}</option>}
          {months.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <span className="muted">
          {t('口径:销售发票−贷项(CN);已剔除运费/代金券等虚拟项。')}{showProfit ? t('毛利=金额−商品成本。') : ''}
        </span>
      </div>

      {err && <div className="notice">{t('查询失败:{err}', { err })}</div>}
      {loading ? (
        <div className="loading">{t('载入中…')}</div>
      ) : (
        <>
          <div className="two-col">
            <RankTable title={t('{m} 销量 Top 20', { m: month })} rows={topQty} showProfit={showProfit} />
            <RankTable title={showProfit ? t('{m} 毛利 Top 20', { m: month }) : t('{m} 销售额 Top 20', { m: month })} rows={topProfit} showProfit={showProfit} />
          </div>
          <div className="two-col">
            <RankTable title={t('{m} 最低销量 20(当月有售出)', { m: month })} rows={lowQty} showProfit={showProfit}
                       hint={t('仅统计当月有正销量的商品;长期零销量的滞销品请结合库存页查看。')} />
            <RankTable title={showProfit ? t('{m} 最低毛利 20', { m: month }) : t('{m} 最低销售额 20', { m: month })} rows={lowProfit} showProfit={showProfit}
                       hint={showProfit ? t('红色负数 = 当月亏本(退货冲销或售价低于成本),建议逐个核查定价。') : t('红色负数 = 当月退货冲销大于销售。')} />
          </div>
        </>
      )}
    </>
  );
}
