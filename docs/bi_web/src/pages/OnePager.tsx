import { useEffect, useState } from 'react';
import { supabase, COMPANY } from '../lib/supabase';
import { fmtRM, fmtNum } from '../lib/format';
import { useT } from '../lib/i18n';

type Op = Record<string, string | number | null>;
type ChMonth = { yr: number; mth: number; channel: string; net: number };
type Alerts = { decline: number; low: number; overdue: number };

const num = (v: string | number | null | undefined) => Number(v ?? 0);
const pctStr = (cur: number, base: number) =>
  base ? `${cur >= base ? '+' : ''}${(((cur - base) / Math.abs(base)) * 100).toFixed(1)}%` : '—';

function Item({ label, value, sub, warn }: { label: string; value: string; sub?: string; warn?: boolean }) {
  return (
    <div className="card kpi">
      <div className="label">{label}</div>
      <div className={'value' + (warn ? ' neg' : '')} style={{ fontSize: 22 }}>{value}</div>
      {sub && <div className="sub" style={{ fontSize: 12 }}>{sub}</div>}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="card-block">
      <h2 style={{ fontSize: 14, color: 'var(--muted)', margin: '0 0 8px', fontWeight: 600 }}>{title}</h2>
      <div className="grid-kpi" style={{ marginBottom: 0 }}>{children}</div>
    </div>
  );
}

export default function OnePager() {
  const t = useT();
  const [op, setOp] = useState<Op | null>(null);
  const [ch, setCh] = useState<ChMonth[]>([]);
  const [al, setAl] = useState<Alerts>({ decline: 0, low: 0, overdue: 0 });
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const [a, b, c, d, e] = await Promise.all([
        supabase.from('bi_onepager').select('*').maybeSingle(),
        supabase.from('bi_mgr_channel_month').select('yr,mth,channel,net').eq('company', COMPANY),
        supabase.from('bi_alert_customer_decline').select('debtor_code', { count: 'exact', head: true }).eq('company', COMPANY),
        supabase.from('bi_alert_low_stock').select('item_code', { count: 'exact', head: true }).eq('company', COMPANY).gte('qty_90d', 30),
        supabase.from('bi_alert_overdue_shipping').select('debtor_code', { count: 'exact', head: true }).eq('company', COMPANY),
      ]);
      setErr(a.error ? a.error.message : null);
      setOp((a.data ?? null) as Op | null);
      setCh((b.data ?? []).map((r) => ({ ...r, net: Number(r.net) })) as ChMonth[]);
      setAl({ decline: c.count ?? 0, low: d.count ?? 0, overdue: e.count ?? 0 });
    })();
  }, []);

  if (op === null && !err) return <div className="loading">{t('载入中…')}</div>;
  if (err || !op) return <div className="notice">{t('查询失败(此页仅老板账号可看):')}{err}</div>;

  const ytdNet = num(op.ytd_net), ytdProfit = num(op.ytd_profit);
  const lyNet = num(op.ly_ytd_net), lyProfit = num(op.ly_ytd_profit);
  const gm = ytdNet ? (ytdProfit / ytdNet) * 100 : 0;
  const gmLy = lyNet ? (lyProfit / lyNet) * 100 : 0;
  const rev12 = num(op.rev12), co12 = num(op.co12), ep12 = num(op.ep12);
  const gmGl = rev12 ? (rev12 - co12) / rev12 : 0;
  const breakeven = gmGl ? (ep12 / 12) / gmGl : 0;
  const rev3 = num(op.rev3avg);
  const margin = rev3 ? ((rev3 - breakeven) / rev3) * 100 : 0;
  const stock = num(op.stock_cost), cost12 = num(op.m12_cost);
  const turnDays = cost12 ? (stock / cost12) * 365 : 0;
  const gmroi = stock ? num(op.m12_profit) / stock : 0;
  const dead = num(op.dead_value);
  const ret12 = num(op.m12_iv_goods) ? (num(op.m12_cn_goods) / num(op.m12_iv_goods)) * 100 : 0;
  const retP12 = num(op.p12_iv_goods) ? (num(op.p12_cn_goods) / num(op.p12_iv_goods)) * 100 : 0;
  const m12all = num(op.m12_net_all);
  const h008Pct = m12all ? (num(op.m12_net_h008) / m12all) * 100 : 0;
  const platPct = m12all ? (num(op.m12_net_platform) / m12all) * 100 : 0;
  // 本月渠道
  const now = new Date(); const cy = now.getFullYear(), cm = now.getMonth() + 1;
  const chThis = ch.filter((r) => r.yr === cy && r.mth === cm);
  const chTop = [...chThis].sort((a, b) => b.net - a.net).slice(0, 4);

  return (
    <>
      <div className="notice" style={{ marginBottom: 14 }}>
        📄 <strong>{t('每月一页纸')}</strong> · {t('数据截至 {d}', { d: String(op.as_of) })} · {t('全部指标随每日同步自动更新。')}
        {t('销售/毛利均')}<strong>{t('剔除分行 HOMEWORKS SOUTHERN')}</strong>{t('(其发票多为零成本,会虚抬毛利)。')}
      </div>

      <Section title={t('① 财务健康')}>
        <Item label={t('账面净现金')} value={fmtRM(num(op.net_cash))}
              sub={t('正余额账户合计 {v}(含透支/卡户抵减)', { v: fmtRM(num(op.pos_cash)) })} />
        <Item label={t('盈亏平衡月销售')} value={fmtRM(breakeven)}
              sub={t('近 3 个月月均收入 {v} · 安全边际 {p}%', { v: fmtRM(rev3), p: margin.toFixed(0) })} warn={margin < 15} />
        <Item label={t('今年净销售(剔分行)')} value={fmtRM(ytdNet)}
              sub={t('去年同期 {v} · {p}', { v: fmtRM(lyNet), p: pctStr(ytdNet, lyNet) })} warn={ytdNet < lyNet} />
        <Item label={t('毛利率(销售口径,剔分行)')} value={gm.toFixed(1) + '%'}
              sub={t('去年同期 {p}% · 账面口径,零成本行按0成本', { p: gmLy.toFixed(1) })} warn={gm < gmLy - 1} />
      </Section>

      <Section title={t('② 生意结构(近 12 个月)')}>
        <Item label={t('商品退货率')} value={ret12.toFixed(1) + '%'}
              sub={t('上一个 12 个月 {p}%', { p: retP12.toFixed(1) })} warn={ret12 > retP12 * 1.5} />
        <Item label={t('分行依赖度')} value={h008Pct.toFixed(0) + '%'} sub={t('分行占总出货比例')} warn={h008Pct > 50} />
        <Item label={t('电商平台占比')} value={platPct.toFixed(0) + '%'} sub={t('Shopee/Lazada/TikTok 等合计')} />
        <Item label={t('本月渠道 Top')} value={chTop.length ? t(chTop[0].channel) : '—'}
              sub={chTop.map((r) => `${t(r.channel)} ${fmtNum(Math.round(r.net / 1000))}k`).join(' · ')} />
      </Section>

      <Section title={t('③ 库存效率')}>
        <Item label={t('库存成本(正库存)')} value={fmtRM(stock)} sub={t('不含次品/展示仓与虚拟商品')} />
        <Item label={t('库存周转')} value={turnDays ? t('{n} 天', { n: Math.round(turnDays) }) : '—'}
              sub={t('按账面销售成本;零成本发票会使此数偏大')} warn={turnDays > 300} />
        <Item label="GMROI" value={gmroi.toFixed(2)} sub={t('每 RM1 库存一年赚的毛利(账面口径)')} warn={gmroi < 1} />
        <Item label={t('真正滞销资金')} value={fmtRM(dead)}
              sub={t('半年没进货且半年零销售 · 占库存 {p}%', { p: stock ? ((dead / stock) * 100).toFixed(0) : 0 })} warn={dead / (stock || 1) > 0.25} />
      </Section>

      <Section title={t('④ 收付与风险')}>
        <Item label={t('外部客户应收')} value={fmtRM(num(op.ar_external))}
              sub={t('其中 >60 天 {v}', { v: fmtRM(num(op.ar_over60)) })} warn={num(op.ar_over60) > num(op.ar_external) * 0.2} />
        <Item label={t('分行欠款')} value={fmtRM(num(op.ar_h008))} sub={t('集团内往来,风险性质不同')} />
        <Item label={t('净应付供应商')} value={fmtRM(num(op.ap_net))}
              sub={num(op.ap_net) < 0 ? t('负数 = 付款先于发票入账(预付状态)') : t('发票未付 {v}', { v: fmtRM(num(op.ap_invoices)) })} />
        <Item label={t('今日预警')} value={t('{n} 项', { n: al.overdue + al.decline })}
              sub={t('逾期仍发货 {a} · 客户下滑 {b} · 库存告急 {c}', { a: al.overdue, b: al.decline, c: al.low })} warn={al.overdue > 0} />
      </Section>

      <p className="muted" style={{ fontSize: 12 }}>
        {t('阅读法:每月只看变化——红色的先问为什么。盈亏平衡与毛利率用总账口径(未经存货调整);')}
        {t('库存周转/GMROI 受零成本发票影响偏乐观,趋势比绝对值可靠(每日快照已开始积累,下月起可看环比)。')}
      </p>
    </>
  );
}
