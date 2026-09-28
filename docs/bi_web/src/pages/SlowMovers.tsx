import { useEffect, useState } from 'react';
import { supabase, COMPANY } from '../lib/supabase';
import { fmtRM, fmtDate, fmtNum } from '../lib/format';
import { useT } from '../lib/i18n';

type Row = {
  item_code: string; item_description: string; item_group: string | null;
  last_receipt_date: string; months_since: number;
  on_hand: number; stock_value?: number; sold_since: number;
};

const PAGE = 50;

function AgingTable({ title, minMonths, maxMonths, hint, showCost = true }: {
  title: string; minMonths: number; maxMonths?: number; hint?: string; showCost?: boolean;
}) {
  const t = useT();
  const VIEW = showCost ? 'bi_slow_stock' : 'bi_slow_stock_nc';
  const COLS = 'item_code,item_description,item_group,last_receipt_date,months_since,on_hand,sold_since' + (showCost ? ',stock_value' : '');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [count, setCount] = useState(0);
  const [page, setPage] = useState(0);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      setRows(null);
      let query = supabase.from(VIEW)
        .select(COLS, { count: 'exact' })
        .eq('company', COMPANY)
        .gte('months_since', minMonths);
      if (maxMonths !== undefined) query = query.lt('months_since', maxMonths);
      const { data, count: c, error } = await query
        .order(showCost ? 'stock_value' : 'on_hand', { ascending: false }).order('item_code')
        .range(page * PAGE, page * PAGE + PAGE - 1);
      setErr(error ? error.message : null);
      setRows((data ?? []) as Row[]);
      setCount(c ?? 0);
    })();
  }, [page, minMonths, maxMonths]);

  const pages = Math.max(1, Math.ceil(count / PAGE));

  return (
    <div className="card card-block">
      <h2>{title} <span className="muted" style={{ fontWeight: 400 }}>· {t('{n} 个商品', { n: fmtNum(count) })}</span></h2>
      {err && <div className="notice">{t('查询失败:')}{err}</div>}
      {rows === null ? (
        <div className="loading">{t('载入中…')}</div>
      ) : (
        <div className="table-scroll">
          <table className="data">
            <thead>
              <tr>
                <th>{t('商品')}</th><th>{t('分组')}</th><th>{t('最后进货')}</th>
                <th className="num">{t('距今(月)')}</th><th className="num">{t('现存量')}</th>
                {showCost && <th className="num">{t('库存成本值')}</th>}<th className="num">{t('进货后已售')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={7} className="muted">{t('没有符合条件的商品 🎉')}</td></tr>}
              {rows.map((r) => (
                <tr key={r.item_code}>
                  <td title={r.item_code}>{r.item_description}</td>
                  <td>{r.item_group ?? ''}</td>
                  <td>{fmtDate(r.last_receipt_date)}</td>
                  <td className="num" style={{ fontWeight: 600 }}>{r.months_since}</td>
                  <td className="num">{fmtNum(r.on_hand)}</td>
                  {showCost && <td className="num">{fmtRM(r.stock_value)}</td>}
                  <td className="num">
                    {Number(r.sold_since) === 0
                      ? <span className="badge fail">{t('零动销')}</span>
                      : fmtNum(r.sold_since)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="pager">
        <button className="btn" disabled={page === 0} onClick={() => setPage(page - 1)}>{t('上一页')}</button>
        <span className="muted">{page + 1} / {pages}</span>
        <button className="btn" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>{t('下一页')}</button>
      </div>
      {hint && <p className="muted" style={{ marginBottom: 0 }}>{hint}</p>}
    </div>
  );
}

export default function SlowMovers({ showCost = true }: { showCost?: boolean }) {
  const t = useT();
  return (
    <>
      <div className="notice">
        {t('口径:距')}<strong>{t('最后一次进货')}</strong>
        {t('(收货单 GR / 采购发票 PI / 期初 OB,不含仓库调拨)已超过 3 / 6 个月,且目前仍有现存量的商品;"进货后已售" = 最后进货日之后的销售出库量,')}
        <span className="neg">{t('零动销')}</span>{' '}{t('= 进货后一件都没卖出。')}
        {t('按{k}从高到低排列。', { k: t(showCost ? '库存成本值' : '现存量') })}
      </div>
      <AgingTable title={t('超过 6 个月还没售完')} minMonths={6} showCost={showCost}
                  hint={t('压钱最久的库存——优先考虑促销/清仓/退供应商。')} />
      <AgingTable title={t('超过 3 个月(3-6 个月)还没售完')} minMonths={3} maxMonths={6} showCost={showCost}
                  hint={t('进入预警区——观察动销,必要时调价。')} />
    </>
  );
}
