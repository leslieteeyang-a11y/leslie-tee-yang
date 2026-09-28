import { useEffect, useState } from 'react';
import { supabase, COMPANY } from '../lib/supabase';
import { fmtRM, fmtDate, fmtNum } from '../lib/format';
import { useT } from '../lib/i18n';

type Line = {
  doc_type: string; doc_no: string; doc_date: string;
  debtor_code: string; debtor_name: string; sales_agent: string | null;
  item_code: string | null; item_description: string | null;
  qty: number; uom: string | null; unit_price: number; sub_total: number; profit?: number;
};

const PAGE = 50;

export default function SalesLines({ showProfit = true }: { showProfit?: boolean }) {
  const t = useT();
  const VIEW = showProfit ? 'bi_sales_lines' : 'bi_sales_lines_nc';
  const COLS = 'doc_type,doc_no,doc_date,debtor_code,debtor_name,sales_agent,item_code,item_description,qty,uom,unit_price,sub_total' + (showProfit ? ',profit' : '');
  const [rows, setRows] = useState<Line[] | null>(null);
  const [count, setCount] = useState(0);
  const [page, setPage] = useState(0);
  const [month, setMonth] = useState<string>(''); // 'YYYY-MM' 或 ''
  const [docType, setDocType] = useState<string>('');
  const [q, setQ] = useState('');
  const [qInput, setQInput] = useState('');
  const [months, setMonths] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      // 月份列表也要按角色选视图:manager/sales 查 bi_sales_monthly 只会得到 0 行
      const { data } = await supabase.from(showProfit ? 'bi_sales_monthly' : 'bi_sales_monthly_nc').select('yr,mth')
        .eq('company', COMPANY).order('yr', { ascending: false }).order('mth', { ascending: false });
      setMonths((data ?? []).map((r) => `${r.yr}-${String(r.mth).padStart(2, '0')}`));
    })();
  }, [showProfit]);

  useEffect(() => {
    (async () => {
      setRows(null);
      let query = supabase.from(VIEW)
        .select(COLS, { count: 'exact' })
        .eq('company', COMPANY);
      if (month) {
        const [y, m] = month.split('-').map(Number);
        const from = `${y}-${String(m).padStart(2, '0')}-01`;
        const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
        query = query.gte('doc_date', from).lt('doc_date', next);
      }
      if (docType) query = query.eq('doc_type', docType);
      if (q) {
        // PostgREST 逻辑树里逗号/括号是分隔符:模式加双引号包裹,并剥掉输入中的引号与反斜杠
        const safe = q.replace(/["\\]/g, '');
        const pat = `"%${safe}%"`;
        query = query.or(
          `debtor_name.ilike.${pat},item_description.ilike.${pat},doc_no.ilike.${pat},item_code.ilike.${pat}`
        );
      }
      const { data, count: c, error } = await query
        .order('doc_date', { ascending: false }).order('doc_no', { ascending: false })
        .range(page * PAGE, page * PAGE + PAGE - 1);
      setErr(error ? error.message : null);
      setRows((data ?? []) as Line[]);
      setCount(c ?? 0);
    })();
  }, [month, docType, q, page]);

  const pages = Math.max(1, Math.ceil(count / PAGE));

  return (
    <>
      <div className="filters">
        <label className="muted">{t('月份')}</label>
        <select value={month} onChange={(e) => { setMonth(e.target.value); setPage(0); }}>
          <option value="">{t('全部')}</option>
          {months.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <label className="muted">{t('类型')}</label>
        <select value={docType} onChange={(e) => { setDocType(e.target.value); setPage(0); }}>
          <option value="">IV + CN</option>
          <option value="IV">{t('IV 发票')}</option>
          <option value="CN">{t('CN 贷项')}</option>
        </select>
        <input placeholder={t('搜索客户 / 商品 / 单号…')} value={qInput}
               onChange={(e) => setQInput(e.target.value)}
               onKeyDown={(e) => { if (e.key === 'Enter') { setQ(qInput.trim()); setPage(0); } }} />
        <button className="btn" onClick={() => { setQ(qInput.trim()); setPage(0); }}>{t('搜索')}</button>
        <span className="muted">{t('{n} 行', { n: fmtNum(count) })}</span>
      </div>

      {err && <div className="notice">{t('查询失败:')}{err}</div>}
      <div className="card">
        {rows === null ? (
          <div className="loading">{t('载入中…')}</div>
        ) : (
          <div className="table-scroll">
            <table className="data">
              <thead>
                <tr>
                  <th>{t('日期')}</th><th>{t('单号')}</th><th>{t('客户')}</th><th>{t('商品')}</th>
                  <th className="num">{t('数量')}</th><th className="num">{t('单价')}</th>
                  <th className="num">{t('金额')}</th>{showProfit && <th className="num">{t('毛利')}</th>}<th>{t('业务员')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    <td>{fmtDate(r.doc_date)}</td>
                    <td>{r.doc_no}{r.doc_type === 'CN' ? <span className="badge fail" style={{ marginLeft: 6 }}>CN</span> : null}</td>
                    <td title={r.debtor_code}>{r.debtor_name}</td>
                    <td title={r.item_code ?? ''}>{r.item_description ?? r.item_code ?? ''}</td>
                    <td className="num">{fmtNum(r.qty, 0)}{r.uom ? ` ${r.uom}` : ''}</td>
                    <td className="num">{fmtNum(r.unit_price, 2)}</td>
                    <td className={'num' + (Number(r.sub_total) < 0 ? ' neg' : '')}>{fmtRM(r.sub_total)}</td>
                    {showProfit && <td className={'num' + (Number(r.profit) < 0 ? ' neg' : '')}>{fmtRM(r.profit)}</td>}
                    <td>{r.sales_agent ?? ''}</td>
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
      </div>
    </>
  );
}
