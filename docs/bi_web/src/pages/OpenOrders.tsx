import { useEffect, useState } from 'react';
import { supabase, COMPANY } from '../lib/supabase';
import { fmtRM, fmtDate, fmtNum } from '../lib/format';
import { useT } from '../lib/i18n';

type Row = {
  doc_no: string; doc_date: string; debtor_code: string; debtor_name: string;
  item_code: string; item_description: string;
  qty: number; transferred_qty: number; outstanding_qty: number;
  unit_price: number; outstanding_amount: number;
};

export default function OpenOrders() {
  const t = useT();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const { data, error } = await supabase.from('bi_open_orders').select('*')
        .eq('company', COMPANY)
        .order('doc_date', { ascending: true }).order('doc_no', { ascending: true });
      setErr(error ? error.message : null);
      setRows((data ?? []) as Row[]);
    })();
  }, []);

  if (rows === null) return <div className="loading">{t('载入中…')}</div>;
  if (err) return <div className="notice">{t('查询失败:')}{err}</div>;

  const total = rows.reduce((s, r) => s + Number(r.outstanding_amount ?? 0), 0);
  const orders = new Set(rows.map((r) => r.doc_no)).size;

  return (
    <div className="card">
      <h2>{t('未交销售订单 · {n} 张 SO / {m} 行 · 未交金额合计 {amt}', { n: orders, m: rows.length, amt: fmtRM(total) })}</h2>
      <div className="table-scroll">
        <table className="data">
          <thead>
            <tr>
              <th>{t('SO 单号')}</th><th>{t('日期')}</th><th>{t('客户')}</th><th>{t('商品')}</th>
              <th className="num">{t('订购')}</th><th className="num">{t('已交')}</th><th className="num">{t('未交')}</th>
              <th className="num">{t('单价')}</th><th className="num">{t('未交金额')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td>{r.doc_no}</td>
                <td>{fmtDate(r.doc_date)}</td>
                <td title={r.debtor_code}>{r.debtor_name}</td>
                <td title={r.item_code}>{r.item_description}</td>
                <td className="num">{fmtNum(r.qty)}</td>
                <td className="num">{fmtNum(r.transferred_qty)}</td>
                <td className="num" style={{ fontWeight: 600 }}>{fmtNum(r.outstanding_qty)}</td>
                <td className="num">{fmtNum(r.unit_price, 2)}</td>
                <td className="num">{fmtRM(r.outstanding_amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
