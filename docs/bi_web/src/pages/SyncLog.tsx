import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { fmtNum } from '../lib/format';
import { useLang, useT } from '../lib/i18n';

type Row = {
  id: number; step: string; started_at: string; finished_at: string | null;
  rows: number; ok: boolean; error: string | null;
};

export default function SyncLog() {
  const t = useT();
  const { lang } = useLang();
  const locale = lang === 'en' ? 'en-MY' : 'zh-CN';
  const [rows, setRows] = useState<Row[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const { data, error } = await supabase.from('bi_sync_log').select('*');
      setErr(error ? error.message : null);
      setRows((data ?? []) as Row[]);
    })();
  }, []);

  if (rows === null) return <div className="loading">{t('载入中…')}</div>;
  if (err) return <div className="notice">{t('查询失败:')}{err}</div>;

  const lastOk = rows.find((r) => r.ok && r.step.endsWith(':reconcile'));

  return (
    <div className="card">
      <h2>
        {t('同步日志(最近 {n} 条)', { n: rows.length })}
        {lastOk && (
          <span className="muted" style={{ fontWeight: 400, marginLeft: 10 }}>
            {t('最近一次成功对账:')}{new Date(lastOk.finished_at ?? lastOk.started_at).toLocaleString(locale)}
          </span>
        )}
      </h2>
      <div className="table-scroll">
        <table className="data">
          <thead>
            <tr>
              <th>#</th><th>{t('步骤')}</th><th>{t('开始时间')}</th><th className="num">{t('耗时')}</th>
              <th className="num">{t('行数')}</th><th>{t('状态')}</th><th>{t('错误')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const secs = r.finished_at
                ? ((new Date(r.finished_at).getTime() - new Date(r.started_at).getTime()) / 1000).toFixed(1) + 's'
                : '';
              return (
                <tr key={r.id}>
                  <td className="muted">{r.id}</td>
                  <td>{r.step}</td>
                  <td>{new Date(r.started_at).toLocaleString(locale)}</td>
                  <td className="num">{secs}</td>
                  <td className="num">{fmtNum(r.rows)}</td>
                  <td>{r.ok ? <span className="badge ok">{t('成功')}</span> : <span className="badge fail">{t('失败')}</span>}</td>
                  <td className="muted" title={r.error ?? ''}>{(r.error ?? '').slice(0, 60)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
