import { useEffect, useState } from 'react';
import { supabase, COMPANY } from '../lib/supabase';
import { fmtRM, fmtNum } from '../lib/format';
import { useT } from '../lib/i18n';

type Row = {
  item_code: string; item_description: string; item_group: string | null;
  base_uom: string | null; location: string; qty: number; total_cost?: number;
  price2?: number | null; price3?: number | null; price4?: number | null;
};

const PAGE = 100;

export default function StockPage({ showCost = true }: { showCost?: boolean }) {
  const t = useT();
  // 店长角色走无成本视图(bi_stock_qty),成本列在数据层就不可见
  const VIEW = showCost ? 'bi_stock' : 'bi_stock_qty';
  const COLS = 'item_code,item_description,item_group,base_uom,location,qty,price2,price3,price4' + (showCost ? ',total_cost' : '');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [count, setCount] = useState(0);
  const [negCount, setNegCount] = useState(0);
  const [page, setPage] = useState(0);
  const [q, setQ] = useState('');
  const [qInput, setQInput] = useState('');
  const [negOnly, setNegOnly] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const { count: nc } = await supabase.from(VIEW)
        .select('item_code', { count: 'exact', head: true })
        .eq('company', COMPANY).lt('qty', 0);
      setNegCount(nc ?? 0);
    })();
  }, []);

  useEffect(() => {
    (async () => {
      setRows(null);
      let query = supabase.from(VIEW)
        .select(COLS, { count: 'exact' })
        .eq('company', COMPANY);
      if (negOnly) query = query.lt('qty', 0);
      if (q) {
        // 与销售明细页同样的转义策略:模式加双引号,剥掉引号与反斜杠
        const safe = q.replace(/["\\]/g, '');
        const pat = `"%${safe}%"`;
        query = query.or(`item_code.ilike.${pat},item_description.ilike.${pat}`);
      }
      const { data, count: c, error } = await query
        .order('item_code').order('location')
        .range(page * PAGE, page * PAGE + PAGE - 1);
      setErr(error ? error.message : null);
      setRows((data ?? []) as Row[]);
      setCount(c ?? 0);
    })();
  }, [q, negOnly, page]);

  const pages = Math.max(1, Math.ceil(count / PAGE));

  // 客户端在当前页内做按商品小计(搜索型号时通常一页放得下)
  const grouped: { item: Row; locs: Row[]; total: number }[] = [];
  if (rows) {
    const map = new Map<string, Row[]>();
    for (const r of rows) {
      const list = map.get(r.item_code) ?? [];
      list.push(r);
      map.set(r.item_code, list);
    }
    for (const [, locs] of map) {
      grouped.push({ item: locs[0], locs, total: locs.reduce((s, r) => s + Number(r.qty), 0) });
    }
  }

  return (
    <>
      <div className="filters">
        <input placeholder={t('搜索商品编码 / 名称 / 型号…')} value={qInput}
               onChange={(e) => setQInput(e.target.value)}
               onKeyDown={(e) => { if (e.key === 'Enter') { setQ(qInput.trim()); setPage(0); } }} />
        <button className="btn" onClick={() => { setQ(qInput.trim()); setPage(0); }}>{t('搜索')}</button>
        <label className="muted" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input type="checkbox" checked={negOnly}
                 onChange={(e) => { setNegOnly(e.target.checked); setPage(0); }} />
          {t('只看负库存({n} 行)', { n: fmtNum(negCount) })}
        </label>
        <span className="muted">{t('{n} 行(商品×仓库)', { n: fmtNum(count) })}</span>
      </div>

      {err && <div className="notice">{t('查询失败:{err}', { err })}</div>}
      <div className="card">
        {rows === null ? (
          <div className="loading">{t('载入中…')}</div>
        ) : (
          <div className="table-scroll">
            <table className="data">
              <thead>
                <tr>
                  <th>{t('商品')}</th><th>{t('名称')}</th><th>{t('分组')}</th><th>{t('仓库')}</th>
                  <th className="num">{t('现存量')}</th><th className="num">{t('商品合计')}</th>
                  <th className="num">{t('门市价 P2')}</th><th className="num">P3</th><th className="num">P4</th>{showCost && <th className="num">{t('成本值')}</th>}
                </tr>
              </thead>
              <tbody>
                {grouped.map((g) =>
                  g.locs.map((r, i) => (
                    <tr key={r.item_code + '|' + r.location}>
                      <td>{i === 0 ? r.item_code : ''}</td>
                      <td title={r.item_code}>{i === 0 ? r.item_description ?? '' : ''}</td>
                      <td>{i === 0 ? r.item_group ?? '' : ''}</td>
                      <td>{r.location || t('(默认)')}</td>
                      <td className={'num' + (Number(r.qty) < 0 ? ' neg' : '')}>
                        {fmtNum(r.qty)}{r.base_uom ? ` ${r.base_uom}` : ''}
                      </td>
                      <td className="num" style={i === 0 ? { fontWeight: 600 } : undefined}>
                        {i === 0 ? fmtNum(g.total) : ''}
                      </td>
                      <td className="num">{i === 0 && r.price2 ? fmtNum(r.price2, 2) : ''}</td>
                      <td className="num muted">{i === 0 && r.price3 ? fmtNum(r.price3, 2) : ''}</td>
                      <td className="num muted">{i === 0 && r.price4 ? fmtNum(r.price4, 2) : ''}</td>
                      {showCost && <td className="num">{fmtRM(r.total_cost)}</td>}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
        <div className="pager">
          <button className="btn" disabled={page === 0} onClick={() => setPage(page - 1)}>{t('上一页')}</button>
          <span className="muted">{page + 1} / {pages}</span>
          <button className="btn" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>{t('下一页')}</button>
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          {showCost
            ? t('现存量按 AutoCount 库存流水(StockDTL)汇总,随每日同步更新;成本值为流水成本净额估算。')
            : t('现存量按 AutoCount 库存流水(StockDTL)汇总,随每日同步更新。')}
          {t('红色负数 = 负库存,建议在 AutoCount 中核查过账仓库。')}
        </p>
      </div>
    </>
  );
}
