import { useEffect, useState } from 'react';
import { supabase, COMPANY } from '../lib/supabase';
import { fmtRM, fmtDate, fmtNum } from '../lib/format';
import { useLang, useT } from '../lib/i18n';

type Overdue = {
  debtor_code: string; debtor_name: string; sales_agent: string | null;
  overdue_amt: number; net_balance: number; oldest_overdue: string; oldest_days: number;
  shipped_30d: number; invoices_30d: number; last_ship: string;
};
type Decline = {
  debtor_code: string; debtor_name: string; sales_agent: string | null; debtor_type: string | null;
  net_prev: number; net_cur: number; change_pct: number; last_order: string | null;
};
type LowStock = {
  item_code: string; item_description: string; item_group: string | null;
  on_hand: number; daily_avg: number; days_left: number; qty_90d: number;
};
type Sync = { last_ok: string | null; last_fail: string | null; last_error: string | null };

function Section({ title, count, level, children, hint }: {
  title: string; count: number; level: 'red' | 'amber' | 'ok'; children: React.ReactNode; hint?: string;
}) {
  const t = useT();
  const [open, setOpen] = useState(true);
  const dot = level === 'red' ? '🔴' : level === 'amber' ? '🟡' : '🟢';
  return (
    <div className="card card-block">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}
           onClick={() => setOpen(!open)}>
        <span style={{ fontSize: 14 }}>{dot}</span>
        <h2 style={{ margin: 0, flex: 1 }}>{title}</h2>
        <span className={'badge ' + (count > 0 && level !== 'ok' ? 'fail' : 'ok')}>{t('{n} 项', { n: count })}</span>
        <span className="muted">{open ? '▾' : '▸'}</span>
      </div>
      {open && count > 0 && <div style={{ marginTop: 12 }}>{children}</div>}
      {open && count === 0 && <p className="muted" style={{ margin: '10px 0 0' }}>{t('没有需要处理的项目 👍')}</p>}
      {open && hint && <p className="muted" style={{ margin: '10px 0 0', fontSize: 12 }}>{hint}</p>}
    </div>
  );
}

export default function Alerts({ goTo }: { goTo: (tab: string) => void }) {
  const t = useT();
  const { lang } = useLang();
  const [overdue, setOverdue] = useState<Overdue[] | null>(null);
  const [decline, setDecline] = useState<Decline[] | null>(null);
  const [low, setLow] = useState<LowStock[] | null>(null);
  const [sync, setSync] = useState<Sync | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const [a, b, c, d] = await Promise.all([
        supabase.from('bi_alert_overdue_shipping').select('*').eq('company', COMPANY)
          .order('overdue_amt', { ascending: false }),
        supabase.from('bi_alert_customer_decline').select('*').eq('company', COMPANY)
          .order('net_prev', { ascending: false }),
        supabase.from('bi_alert_low_stock').select('*').eq('company', COMPANY)
          .gte('qty_90d', 30).order('days_left').order('qty_90d', { ascending: false }).limit(200),
        supabase.from('bi_alert_sync').select('*').maybeSingle(),
      ]);
      const failed = [a.error, b.error, c.error, d.error].filter(Boolean);
      setErr(failed.length ? failed.map((e) => e!.message).join(' / ') : null);
      setOverdue((a.data ?? []) as Overdue[]);
      setDecline((b.data ?? []) as Decline[]);
      setLow((c.data ?? []) as LowStock[]);
      setSync((d.data ?? null) as Sync | null);
    })();
  }, []);

  if (overdue === null || decline === null || low === null) return <div className="loading">{t('载入中…')}</div>;

  const zero = low.filter((r) => Number(r.on_hand) <= 0);
  const soon = low.filter((r) => Number(r.on_hand) > 0);
  const lastOk = sync?.last_ok ? new Date(sync.last_ok) : null;
  const staleHours = lastOk ? (Date.now() - lastOk.getTime()) / 36e5 : Infinity;
  const syncLevel: 'red' | 'amber' | 'ok' = staleHours > 36 ? 'red' : staleHours > 14 ? 'amber' : 'ok';

  return (
    <>
      {err && <div className="notice">{t('部分预警查询失败:')}{err}</div>}

      <div className="notice" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <span>{syncLevel === 'ok' ? '🟢' : syncLevel === 'amber' ? '🟡' : '🔴'}</span>
        <span>
          {t('数据更新于')} <strong>{lastOk ? lastOk.toLocaleString(lang === 'en' ? 'en-GB' : 'zh-CN', { hour12: false }) : t('未知')}</strong>
          {syncLevel !== 'ok' && <span className="neg">{t('(已超过 {h} 小时未同步,请检查服务器是否登录)', { h: Math.round(staleHours) })}</span>}
          {sync?.last_fail && sync.last_ok && new Date(sync.last_fail) > new Date(sync.last_ok) &&
            <span className="neg"> · {t('最近一次同步失败:')}{(sync.last_error ?? '').slice(0, 80)}</span>}
        </span>
        <span style={{ flex: 1 }} />
        <button className="btn" onClick={() => goTo('log')}>{t('同步日志')}</button>
      </div>

      <Section title={t('逾期欠款仍在继续发货')} count={overdue.length} level="red"
               hint={t('口径:有 >90 天(月结 30 天+60 天宽限)未收的发票,且近 30 天仍有新发票。平台/现金账户已排除。')}>
        <div className="table-scroll">
          <table className="data">
            <thead><tr>
              <th>{t('客户')}</th><th>{t('业务员')}</th><th className="num">{t('逾期金额')}</th><th className="num">{t('最久(天)')}</th>
              <th className="num">{t('近30天发货')}</th><th className="num">{t('净欠款')}</th><th>{t('最近发货')}</th>
            </tr></thead>
            <tbody>
              {overdue.map((r) => (
                <tr key={r.debtor_code}>
                  <td title={r.debtor_code}>{r.debtor_name}</td>
                  <td className="muted">{r.sales_agent ?? ''}</td>
                  <td className="num neg" style={{ fontWeight: 600 }}>{fmtRM(r.overdue_amt)}</td>
                  <td className="num">{r.oldest_days}</td>
                  <td className="num">{fmtRM(r.shipped_30d)} <span className="muted">{t('({n} 张)', { n: r.invoices_30d })}</span></td>
                  <td className="num">{fmtRM(r.net_balance)}</td>
                  <td className="muted">{fmtDate(r.last_ship)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button className="btn" style={{ marginTop: 10 }} onClick={() => goTo('ar')}>{t('查看应收账款明细 →')}</button>
      </Section>

      <Section title={t('重要客户订货明显下滑')} count={decline.length} level="amber"
               hint={t('口径:近 90 天订货比去年同期 90 天下降超过 30%,且去年同期至少 RM 5,000。')}>
        <div className="table-scroll">
          <table className="data">
            <thead><tr>
              <th>{t('客户')}</th><th>{t('类型')}</th><th>{t('业务员')}</th>
              <th className="num">{t('去年同期')}</th><th className="num">{t('近 90 天')}</th><th className="num">{t('变化')}</th><th>{t('最近下单')}</th>
            </tr></thead>
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
            </tbody>
          </table>
        </div>
      </Section>

      <Section title={t('库存告急 · 已断货 {a} · 即将断货 {b}', { a: zero.length, b: soon.length })} count={low.length}
               level={zero.length > 0 ? 'red' : 'amber'}
               hint={t('口径:近 90 天售出 ≥30 件的走量商品,按现存量 ÷ 日均销量算可售天数,<14 天列出;不含次品仓/展示仓。按紧急程度排序,最多显示 200 项。')}>
        <div className="table-scroll">
          <table className="data">
            <thead><tr>
              <th>{t('商品')}</th><th>{t('分组')}</th><th className="num">{t('现存')}</th><th className="num">{t('日均销量')}</th>
              <th className="num">{t('还能卖(天)')}</th><th className="num">{t('近90天售出')}</th>
            </tr></thead>
            <tbody>
              {low.map((r) => (
                <tr key={r.item_code}>
                  <td title={r.item_code}>{r.item_description}</td>
                  <td className="muted">{r.item_group ?? ''}</td>
                  <td className={'num' + (Number(r.on_hand) <= 0 ? ' neg' : '')} style={{ fontWeight: 600 }}>{fmtNum(r.on_hand)}</td>
                  <td className="num">{Number(r.daily_avg).toFixed(1)}</td>
                  <td className="num">
                    {Number(r.on_hand) <= 0
                      ? <span className="badge fail">{t('已断货')}</span>
                      : <span className={r.days_left < 7 ? 'neg' : ''}>{r.days_left}</span>}
                  </td>
                  <td className="num">{fmtNum(r.qty_90d)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button className="btn" style={{ marginTop: 10 }} onClick={() => goTo('stock')}>{t('查看库存 →')}</button>
      </Section>
    </>
  );
}
