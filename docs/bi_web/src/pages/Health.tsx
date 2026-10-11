import { Fragment, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { fmtNum, fmtCompact } from '../lib/format';
import { useT } from '../lib/i18n';

// 「健康体检」分页(2026-10-10):读 public.bi_healthcheck(= bi.healthcheck_snapshot,每 3 小时由 bi.refresh_healthcheck() 重算,
// 口径见 docs/health_check_2026-10.md 与 docs/bi_sql/healthcheck_snapshot.sql)。快照只存「基础值」,比率与红黄绿都在这里算,
// 改门槛不用动资料库。只有老板看得到(RLS)。三列:总行(对外口径,剔除卖给分行)、分行 JB、集团(总行对外 + 分行)。

type M = Record<string, number | null>;
type All = Record<string, M>;
type St = 'g' | 'y' | 'r' | 'i'; // 绿 / 黄 / 红 / 只供参考
type Cell = { text: string; sub?: string; st: St };
type T = (zh: string, vars?: Record<string, string | number>) => string;
type Metric = { label: string; ref: string; note?: string; cell: (m: M, c: string, all: All) => Cell | null };
type Section = { title: string; metrics: Metric[] };

const HQ = 'HOMEWORKSSB';
const BR = 'HOMEWORKSSOUTHERN';
const GP = 'GROUP';
const COLS = [HQ, BR, GP];
// 集团列快照里没有、但可以直接把总行 + 分行相加的键
const EXTRA = ['stock_snap_now', 'stock_snap_30', 'll_neg', 'quote_open', 'quote_won', 'agent_hit', 'agent_n',
  'cust_new_sales_l12', 'cust_lost_sales', 'named_l12'];
const DOT: Record<St, string> = { g: '🟢', y: '🟡', r: '🔴', i: '⚪' };

const n = (v: unknown): number | null => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const add = (a: number | null, b: number | null) => (a == null && b == null ? null : (a ?? 0) + (b ?? 0));
const div = (a: number | null, b: number | null) => (a == null || b == null || b === 0 ? null : a / b);
const chg = (cur: number | null, base: number | null) =>
  cur == null || base == null || base === 0 ? null : (cur - base) / Math.abs(base);
const rm = (v: number | null) => (v == null ? '—' : 'RM ' + fmtCompact(Math.round(v)));
const pct = (v: number | null, d = 1) => (v == null ? '—' : (v * 100).toFixed(d) + '%');
const sgn = (v: number | null) => (v == null ? '—' : (v >= 0 ? '+' : '') + (v * 100).toFixed(1) + '%');
const fx = (v: number | null, d = 1) => (v == null ? '—' : v.toFixed(d));
const band = (v: number | null, good: (x: number) => boolean, warn: (x: number) => boolean): St =>
  v == null ? 'i' : good(v) ? 'g' : warn(v) ? 'y' : 'r';

// 总账损益 = 收入 + 其他收入 − 销货成本(AutoCount Basic 里其实是采购额)− 费用 − 税。集团 = 总行 + 分行(内部买卖互相抵销)
function profit(m: M, sfx: string): number | null {
  const r = n(m['rev_' + sfx]);
  if (r == null) return null;
  return r + (n(m['oi_' + sfx]) ?? 0) - (n(m['co_' + sfx]) ?? 0) - (n(m['ep_' + sfx]) ?? 0) - (n(m['tx_' + sfx]) ?? 0);
}
const profitOf = (c: string, all: All, sfx: string) =>
  c === GP ? add(profit(all[HQ] ?? {}, sfx), profit(all[BR] ?? {}, sfx)) : profit(all[c] ?? {}, sfx);
function ebitda(m: M): number | null {
  const r = n(m['rev_l12']);
  if (r == null) return null;
  return r + (n(m['oi_l12']) ?? 0) - (n(m['co_l12']) ?? 0) - (n(m['ep_l12']) ?? 0) + (n(m['dep_l12']) ?? 0) + (n(m['int_l12']) ?? 0);
}
const ebitdaOf = (c: string, all: All) => (c === GP ? add(ebitda(all[HQ] ?? {}), ebitda(all[BR] ?? {})) : ebitda(all[c] ?? {}));
const dso = (m: M) => div(n(m['ar_inv']), div(n(m['credit_90']), 90));
const dio = (m: M) => div(n(m['stock_cost']), div(n(m['purch_l12']), 365));
const dpo = (m: M) => div(n(m['ap_inv']), div(n(m['purch_l12']), 365));

function buildSections(t: T): Section[] {
  // 本期 vs 基期:good / warn 是「变动率」门槛
  const yoy = (cur: number | null, base: number | null, good: number, warn: number,
               fmt: (v: number | null) => string, subZh: string): Cell | null => {
    if (cur == null) return null;
    const c = chg(cur, base);
    return { text: fmt(cur), sub: t(subZh, { v: fmt(base), p: sgn(c) }), st: band(c, (x) => x >= good, (x) => x >= warn) };
  };
  const cnt = (v: number | null) => (v == null ? '—' : fmtNum(v));
  return [
    { title: '① 成长', metrics: [
      { label: '对外销售 YTD(可比口径)', ref: '年增 8～15% 健康,>20% 高速', note: '剔除平台费 CN 行(ONLINE%);总行剔除卖给分行的部分',
        cell: (m) => yoy(n(m['sales_ytd']), n(m['sales_ly_ytd']), 0.08, 0, rm, '去年同期 {v} · {p}') },
      { label: '滚动 12 个月销售', ref: '同上',
        cell: (m) => yoy(n(m['sales_l12']), n(m['sales_p12']), 0.08, 0, rm, '上一个 12 个月 {v} · {p}') },
      { label: '近 3 个月 vs 前 3 个月', ref: '环比持平或上升',
        cell: (m) => { const c = chg(n(m['sales_l3']), n(m['sales_p3'])); if (c == null) return null;
          return { text: sgn(c), sub: t('近 3 个月 {v} · 比去年同季 {p}', { v: rm(n(m['sales_l3'])), p: sgn(chg(n(m['sales_l3']), n(m['sales_ly3']))) }),
                   st: band(c, (x) => x >= 0, (x) => x >= -0.05) }; } },
      { label: '订单数(近 12 个月)', ref: '与销售同向增长',
        cell: (m) => yoy(n(m['orders_l12']), n(m['orders_p12']), 0.05, 0, cnt, '上一个 12 个月 {v} · {p}') },
      { label: '客单价(近 12 个月)', ref: '年变动在 ±5% 内',
        cell: (m) => { const a = div(n(m['sales_l12']), n(m['orders_l12'])), b = div(n(m['sales_p12']), n(m['orders_p12'])); if (a == null) return null;
          const c = chg(a, b);
          return { text: 'RM ' + fmtNum(a), sub: t('上一个 12 个月 RM {v} · {p}', { v: fmtNum(b ?? 0), p: sgn(c) }), st: band(c, (x) => x >= -0.05, (x) => x >= -0.1) }; } },
      { label: '平台商品销售 YTD', ref: '与总体同向;单一平台连续萎缩 >30% 属渠道流失', note: '只有总行有平台客户',
        cell: (m) => yoy(n(m['plat_goods_ytd']), n(m['plat_goods_ly_ytd']), 0.08, 0, rm, '去年同期 {v} · {p}') },
      { label: '业务员月目标达标(近 3 个月)', ref: '50～70% 的业务员-月达标', note: '只算月销售 >5 万、有目标的业务员(目标在门店页设定)',
        cell: (m) => { const h = n(m['agent_hit']), a = n(m['agent_n']); if (!a) return null; const r = div(h, a);
          return { text: `${fmtNum(h ?? 0)}/${fmtNum(a)}`, sub: pct(r, 0), st: band(r, (x) => x >= 0.5, (x) => x >= 0.3) }; } },
    ] },
    { title: '② 获利', metrics: [
      { label: '商品毛利率(销售口径,近 12 个月)', ref: '卫浴品牌零售 35～45%', note: '零成本行(如对分行调拨)会虚抬毛利,看旁边的占比',
        cell: (m) => { const v = div(n(m['gp_l12']), n(m['gnet_l12'])); if (v == null) return null;
          return { text: pct(v), sub: t('上一个 12 个月 {p} · 零成本行占 {z}', { p: pct(div(n(m['gp_p12']), n(m['gnet_p12']))), z: pct(div(n(m['zero_cost_l12']), n(m['goods_l12'])), 0) }),
                   st: band(v, (x) => x >= 0.4, (x) => x >= 0.3) }; } },
      { label: '总账净利 YTD', ref: '净利率 5～10%,>10% 优秀', note: '完整月累计;折旧 / 贷款利息 / 董事花红只在 12 月入账,全年会再低几点',
        cell: (m, c, all) => { const p = profitOf(c, all, 'ytd'); if (p == null) return null;
          const mg = div(p, n(m['rev_ytd'])); const ly = div(profitOf(c, all, 'ly_ytd'), n(m['rev_ly_ytd']));
          return { text: rm(p), sub: t('净利率 {m} · 去年同期 {l}', { m: pct(mg), l: pct(ly) }), st: band(mg, (x) => x >= 0.05, (x) => x >= 0) }; } },
      { label: '费用率 YTD(总账费用 ÷ 对外收入)', ref: '零售批发混合 20～30%',
        cell: (m) => { const v = div(n(m['ep_ytd']), n(m['rev_ext_ytd'])); if (v == null) return null;
          return { text: pct(v), sub: t('去年同期 {p}', { p: pct(div(n(m['ep_ly_ytd']), n(m['rev_ext_ly_ytd']))) }), st: band(v, (x) => x <= 0.25, (x) => x <= 0.3) }; } },
      { label: '平台费率 YTD(总账手续费 ÷ 平台商品销售)', ref: '佣金+手续费 8～12%;含广告 / 联盟 / 优惠券 15～22%',
        cell: (m) => { const v = div(n(m['plat_fee_ytd']), n(m['plat_goods_ytd'])); if (v == null) return null;
          return { text: pct(v), sub: t('去年同期 {p}', { p: pct(div(n(m['plat_fee_ly_ytd']), n(m['plat_goods_ly_ytd']))) }), st: band(v, (x) => x <= 0.15, (x) => x <= 0.22) }; } },
      { label: '平台扣费后毛利率 YTD', ref: '25～35% 才够覆盖运费、包装、人工',
        cell: (m) => { const g = n(m['plat_gp_ytd']), f = n(m['plat_fee_ytd']), s = n(m['plat_goods_ytd']); if (g == null || !s) return null;
          const v = (g - (f ?? 0)) / s;
          return { text: pct(v), sub: t('商品毛利 {g} − 平台费 {f}', { g: rm(g), f: rm(f) }), st: band(v, (x) => x >= 0.25, (x) => x >= 0.15) }; } },
      { label: '盈亏平衡月销售(总账)', ref: '安全边际 >25% 健康,<10% 危险', note: '近 12 个月总账毛利率与月均费用;集团不适用',
        cell: (m, c) => { if (c === GP) return null;
          const r12 = n(m['rev_l12']), co = n(m['co_l12']), ep = n(m['ep_l12']), r3 = div(n(m['rev_l3']), 3);
          if (!r12 || ep == null || r3 == null) return null;
          const gm = (r12 - (co ?? 0)) / r12; if (gm <= 0) return { text: '—', sub: t('毛利率为负'), st: 'r' };
          const be = ep / 12 / gm; const sm = (r3 - be) / r3;
          return { text: rm(be), sub: t('近 3 个月月均收入 {v} · 安全边际 {p}', { v: rm(r3), p: pct(sm, 0) }), st: band(sm, (x) => x >= 0.25, (x) => x >= 0.1) }; } },
    ] },
    { title: '③ 现金与偿债', metrics: [
      { label: '账面净现金', ref: '为正且不低于年初', note: '银行 + 现金科目累计余额,含透支 / 卡户抵减',
        cell: (m) => { const v = n(m['net_cash']); if (v == null) return null; const y0 = n(m['net_cash_y0']);
          return { text: rm(v), sub: t('年初 {a} · 月初 {b}', { a: rm(y0), b: rm(n(m['net_cash_m0'])) }), st: v <= 0 ? 'r' : y0 != null && v < y0 ? 'y' : 'g' }; } },
      { label: '现金跑道', ref: '3～6 个月营运费用', note: '正余额账户 ÷ 近 12 个月月均费用',
        cell: (m) => { const e = div(n(m['ep_l12']), 12); const v = div(n(m['cash_pos']), e); if (v == null) return null;
          return { text: t('{n} 个月', { n: fx(v) }), sub: t('正余额账户 {v} · 月均费用 {e}', { v: rm(n(m['cash_pos'])), e: rm(e) }), st: band(v, (x) => x >= 6, (x) => x >= 3) }; } },
      { label: '有息负债', ref: '净负债／EBITDA <2.5 倍', note: '定期贷款 + 租购 + 透支;EBITDA 用近 12 个月总账',
        cell: (m, c, all) => { const d = -((n(m['loans_cl_neg']) ?? 0) + (n(m['ll_neg']) ?? 0) + (n(m['cash_neg']) ?? 0));
          const nd = d - (n(m['cash_pos']) ?? 0); const e = ebitdaOf(c, all); const r = e != null && e > 0 ? nd / e : null;
          return { text: rm(d), sub: t('净负债 {v} · 净负债／EBITDA {r} 倍', { v: rm(nd), r: fx(r, 2) }),
                   st: e != null && e <= 0 ? 'r' : nd <= 0 ? 'g' : band(r, (x) => x <= 2.5, (x) => x <= 3.5) }; } },
      { label: '利息保障倍数(近 12 个月)', ref: '>4 倍', note: 'EBIT ÷ 利息',
        cell: (m, c, all) => { const i = n(m['int_l12']); const e = ebitdaOf(c, all); if (!i || i <= 0 || e == null) return null;
          const v = (e - (n(m['dep_l12']) ?? 0)) / i;
          return { text: t('{x} 倍', { x: fx(v) }), sub: t('利息 {v}', { v: rm(i) }), st: band(v, (x) => x >= 4, (x) => x >= 2) }; } },
      { label: '流动比率 / 速动比率', ref: '流动 1.5～2.5,速动 0.8～1.2', note: '总账流动资产 ÷ 流动负债;集团不适用(内部往来未抵销)',
        cell: (m, c) => { if (c === GP) return null;
          const stock = n(m['stock_cost']) ?? 0;
          const ca = (n(m['cash_pos']) ?? 0) + (n(m['ar_gl_pos']) ?? 0) + stock + (n(m['ca_other_pos']) ?? 0) + (n(m['ap_gl_prepaid']) ?? 0);
          const cl = -((n(m['cash_neg']) ?? 0) + (n(m['ap_gl_neg']) ?? 0) + (n(m['cl_other_neg']) ?? 0) + (n(m['ar_gl_neg']) ?? 0));
          if (cl <= 0) return null;
          const cur = ca / cl, q = (ca - stock) / cl;
          return { text: `${fx(cur, 2)} / ${fx(q, 2)}`, sub: t('流动资产 {a} · 流动负债 {b}', { a: rm(ca), b: rm(cl) }),
                   st: cur >= 1.5 && q >= 0.8 ? 'g' : cur >= 1 && q >= 0.5 ? 'y' : 'r' }; } },
      { label: '净现金年初至今变动', ref: '加回本金与资本开支后应 ≥ 净利的 70～100%', note: '这里只加回资本开支,没加回贷款本金偿还,所以偏低',
        cell: (m, c, all) => { const v = n(m['net_cash']), y0 = n(m['net_cash_y0']); if (v == null || y0 == null) return null;
          const d = v - y0 + (n(m['capex_ytd']) ?? 0); const p = profitOf(c, all, 'ytd');
          return { text: rm(v - y0), sub: t('加回资本开支 {v} = 净利的 {p}', { v: rm(d), p: pct(div(d, p), 0) }), st: 'i' }; } },
      { label: '现金转换周期 CCC', ref: '60～120 天;进口自有品牌可到 150', note: 'DSO(B2B 应收)+ DIO(库存)− DPO(应付)',
        cell: (m) => { const a = dso(m), b = dio(m), d = dpo(m); if (b == null) return null; const v = (a ?? 0) + b - (d ?? 0);
          return { text: t('{n} 天', { n: fmtNum(Math.round(v)) }), sub: `DSO ${fx(a, 0)} + DIO ${fx(b, 0)} − DPO ${fx(d, 0)}`, st: band(v, (x) => x <= 120, (x) => x <= 180) }; } },
    ] },
    { title: '④ 应收', metrics: [
      { label: 'B2B 应收天数 DSO', ref: '30～45 天', note: '应收发票 ÷ 近 90 天赊销日均(剔平台、现金柜台、分行)',
        cell: (m) => { const v = dso(m); if (v == null) return null;
          return { text: t('{n} 天', { n: fx(v) }), sub: t('应收发票 {v}', { v: rm(n(m['ar_inv'])) }), st: band(v, (x) => x <= 45, (x) => x <= 60) }; } },
      { label: '逾期 >60 天占比', ref: '>60 天 <10%',
        cell: (m) => { const v = div(n(m['ar_over60']), n(m['ar_inv'])); if (v == null) return null;
          return { text: pct(v), sub: t('>90 天 {a} · >1 年 {b}', { a: rm(n(m['ar_over90'])), b: rm(n(m['ar_over365'])) }), st: band(v, (x) => x <= 0.1, (x) => x <= 0.2) }; } },
      { label: '应收集中度(前 10 大)', ref: '<50% 分散', note: '集团不适用',
        cell: (m, c) => { if (c === GP) return null; const v = div(n(m['ar_top10']), n(m['ar_pos_total'])); if (v == null) return null;
          return { text: pct(v, 0), st: band(v, (x) => x <= 0.5, (x) => x <= 0.7) }; } },
      { label: '未核销收款', ref: '现金柜台应接近 0', note: '总行 = 现金柜台客户(CASH)的未核销收款;分行 = 全部未核销收款,多为客户订金(正常)',
        cell: (m, c) => { if (c === GP) return null; const v = c === HQ ? n(m['cash_counter_unapplied']) : n(m['deposits_rp']); if (v == null) return null;
          const a = Math.abs(v);
          return { text: rm(a), sub: c === HQ ? t('现金柜台') : t('多为订金'), st: c === HQ ? band(a, (x) => x <= 10000, (x) => x <= 50000) : 'i' }; } },
      { label: '分行欠总行', ref: '集团内往来,风险性质不同',
        cell: (m, c) => { if (c !== HQ) return null; const v = n(m['ar_h008']); if (v == null) return null; return { text: rm(v), st: 'i' }; } },
    ] },
    { title: '⑤ 库存', metrics: [
      { label: '库存成本(正库存)', ref: '库存增速不应高于销售', note: '不含次品 / 展示仓与虚拟商品;变化率用每日快照',
        cell: (m) => { const v = n(m['stock_cost']); if (v == null) return null; const c = chg(n(m['stock_snap_now']), n(m['stock_snap_30']));
          return { text: rm(v), sub: t('30 天变化 {p}', { p: sgn(c) }), st: band(c, (x) => x <= 0, (x) => x <= 0.05) }; } },
      { label: '库存天数 DIO / 周转', ref: '90～150 天 / 2.5～4 次', note: '按近 12 个月总账采购额(AutoCount Basic 没有存货科目)',
        cell: (m) => { const v = dio(m); if (v == null) return null;
          return { text: t('{n} 天', { n: fmtNum(Math.round(v)) }), sub: t('周转 {x} 次／年', { x: fx(365 / v) }), st: band(v, (x) => x <= 150, (x) => x <= 200) }; } },
      { label: '库存 ÷ 月商品销售(近 3 个月)', ref: '3～5 个月',
        cell: (m) => { const v = div(n(m['stock_cost']), div(n(m['gnet_l3']), 3)); if (v == null) return null;
          return { text: t('{n} 个月', { n: fx(v) }), st: band(v, (x) => x <= 5, (x) => x <= 7) }; } },
      { label: '呆滞库存(180 天无销售)', ref: '<10%,>15% 要清仓',
        cell: (m) => { const v = n(m['dead_180']); if (v == null) return null; const p = div(v, n(m['aging_total']));
          return { text: rm(v), sub: t('占 {p} · 从未售出 {v}', { p: pct(p, 0), v: rm(n(m['never_sold'])) }), st: band(p, (x) => x <= 0.1, (x) => x <= 0.15) }; } },
      { label: '缺货暴露', ref: '断货品项占销售 <10%', note: '30 天内断货的品项占近 90 天商品销售',
        cell: (m) => { const v = div(n(m['low_s90']), n(m['goods_90'])); if (v == null) return null;
          return { text: pct(v, 0), sub: t('{n} 项 30 天内断货', { n: fmtNum(n(m['low_n']) ?? 0) }), st: band(v, (x) => x <= 0.1, (x) => x <= 0.2) }; } },
      { label: '负库存', ref: '应为 0',
        cell: (m) => { const v = n(m['neg_rows']); if (v == null) return null;
          return { text: t('{n} 行', { n: fmtNum(v) }), sub: t('残留成本 {v}', { v: rm(n(m['neg_cost'])) }), st: band(v, (x) => x === 0, (x) => x <= 50) }; } },
      { label: '商品退货率(近 12 个月)', ref: '<2% 良好',
        cell: (m) => { const v = div(n(m['goods_cn_l12']), n(m['goods_l12'])); if (v == null) return null;
          return { text: pct(v), sub: t('上一个 12 个月 {p}', { p: pct(div(n(m['goods_cn_p12']), n(m['goods_p12']))) }), st: band(v, (x) => x <= 0.02, (x) => x <= 0.04) }; } },
    ] },
    { title: '⑥ 客户与渠道', metrics: [
      { label: '平台占比(商品口径,近 12 个月)', ref: '任一渠道 <35～40%', note: '只有总行有平台客户',
        cell: (m) => { const v = div(n(m['plat_goods_l12']), n(m['goods_l12'])); if (v == null) return null;
          return { text: pct(v, 0), st: band(v, (x) => x <= 0.4, (x) => x <= 0.55) }; } },
      { label: '活跃具名客户(近 12 个月)', ref: '不减少', note: '总行 = B2B 客户(剔平台、现金柜台、分行);分行 = 全部具名客户',
        cell: (m) => yoy(n(m['cust_active_l12']), n(m['cust_active_p12']), 0, -0.05, cnt, '上一个 12 个月 {v} · {p}') },
      { label: '客户留存率', ref: '留存 >75%', note: '只评总行 B2B;零售装修客多为一次性,分行 / 集团只供参考',
        cell: (m, c) => { const v = div(n(m['cust_retained']), n(m['cust_active_p12'])); if (v == null) return null;
          return { text: pct(v, 0), sub: t('流失 {n} 家(原贡献 {v})', { n: fmtNum(n(m['cust_lost']) ?? 0), v: rm(n(m['cust_lost_sales'])) }), st: c === HQ ? band(v, (x) => x >= 0.75, (x) => x >= 0.6) : 'i' }; } },
      { label: '新客贡献(近 12 个月)', ref: '成熟 B2B 10～30%;新店 >50% 正常',
        cell: (m) => { const v = div(n(m['cust_new_sales_l12']), n(m['named_l12'])); if (v == null) return null;
          return { text: pct(v, 0), sub: t('{n} 家新客 · {v}', { n: fmtNum(n(m['cust_new_l12']) ?? 0), v: rm(n(m['cust_new_sales_l12'])) }), st: 'i' }; } },
      { label: '客户集中度(前 10 大)', ref: '<50% 分散', note: '集团不适用',
        cell: (m, c) => { if (c === GP) return null; const v = div(n(m['top10_l12']), n(m['named_l12'])); if (v == null) return null;
          return { text: pct(v, 0), st: band(v, (x) => x <= 0.5, (x) => x <= 0.7) }; } },
    ] },
    { title: '⑦ 应付与采购', metrics: [
      { label: '应付发票未付', ref: '>90 天 <25%',
        cell: (m) => { const v = n(m['ap_inv']); if (v == null) return null; const p = div(n(m['ap_over90']), v);
          return { text: rm(v), sub: t('>90 天占 {p} · 关联公司 HOMEGUARD {v}', { p: pct(p, 0), v: rm(n(m['ap_related'])) }), st: band(p, (x) => x <= 0.25, (x) => x <= 0.5) }; } },
      { label: '应付天数 DPO', ref: '本地供应商 30～60 天', note: '应付发票 ÷ 近 12 个月采购日均',
        cell: (m) => { const v = dpo(m); if (v == null) return null;
          return { text: t('{n} 天', { n: fx(v) }), st: v >= 30 && v <= 60 ? 'g' : v >= 20 && v <= 90 ? 'y' : 'r' }; } },
      { label: '供应商预付(未核销付款)', ref: '进口订金正常,但须核销',
        cell: (m) => { const v = n(m['ap_unapplied']); if (v == null) return null;
          return { text: rm(-v), sub: t('净应付 {v}', { v: rm(n(m['ap_net'])) }), st: 'i' }; } },
      { label: '未交采购单', ref: '逾期未交 <10%',
        cell: (m) => { const v = n(m['open_po_n']); if (v == null) return null; const o = n(m['open_po_old_n']); const p = div(o, v);
          return { text: t('{n} 张', { n: fmtNum(v) }), sub: t('金额 {v} · 逾一年 {o} 张', { v: rm(n(m['open_po'])), o: fmtNum(o ?? 0) }),
                   st: v === 0 ? 'g' : band(p, (x) => x <= 0.1, (x) => x <= 0.3) }; } },
      { label: '未交付订单积压', ref: '≤ 1～1.5 个月销售', note: '积压金额 ÷ 近 3 个月周均销售',
        cell: (m) => { const v = n(m['backlog']); if (v == null) return null; const w = div(v, div(n(m['sales_l3']), 13));
          return { text: rm(v), sub: t('≈ {w} 周销售 · >90 天占 {p}', { w: fx(w), p: pct(div(n(m['backlog_over90']), v), 0) }), st: band(w, (x) => x <= 6, (x) => x <= 8) }; } },
      { label: '报价转单率', ref: '40～60%',
        cell: (m) => { const w = n(m['quote_won']), o = n(m['quote_open']); if (w == null && o == null) return null;
          const v = div(w ?? 0, (w ?? 0) + (o ?? 0));
          return { text: pct(v, 0), sub: t('未转单 {v}', { v: rm(o) }), st: band(v, (x) => x >= 0.4, (x) => x >= 0.3) }; } },
    ] },
    { title: '⑧ 人效与费用', metrics: [
      { label: '人力成本率 YTD', ref: '8～12%', note: '薪资、EPF / SOCSO、津贴、花红、佣金、董事酬劳 ÷ 对外收入',
        cell: (m) => { const v = div(n(m['staff_ytd']), n(m['rev_ext_ytd'])); if (v == null) return null;
          return { text: pct(v), sub: t('去年同期 {p}', { p: pct(div(n(m['staff_ly_ytd']), n(m['rev_ext_ly_ytd']))) }), st: band(v, (x) => x <= 0.12, (x) => x <= 0.15) }; } },
      { label: '广告费率 YTD', ref: '2～5%',
        cell: (m) => { const v = div(n(m['adv_ytd']), n(m['rev_ext_ytd'])); if (v == null) return null;
          return { text: pct(v), sub: t('去年同期 {p}', { p: pct(div(n(m['adv_ly_ytd']), n(m['rev_ext_ly_ytd']))) }), st: band(v, (x) => x <= 0.05, (x) => x <= 0.08) }; } },
      { label: '佣金率 YTD', ref: '<3%(已计入人力成本)',
        cell: (m) => { const v = div(n(m['comm_ytd']), n(m['rev_ext_ytd'])); if (v == null) return null;
          return { text: pct(v), sub: rm(n(m['comm_ytd'])), st: band(v, (x) => x <= 0.03, (x) => x <= 0.06) }; } },
      { label: '租金 / 运输费率 YTD', ref: '租金 3～6%',
        cell: (m) => { const r = div(n(m['rent_ytd']), n(m['rev_ext_ytd'])), tr = div(n(m['trans_ytd']), n(m['rev_ext_ytd']));
          if (r == null && tr == null) return null; return { text: `${pct(r)} / ${pct(tr)}`, st: 'i' }; } },
      { label: '经营杠杆 YTD', ref: '收入增速 > 费用增速',
        cell: (m) => { const rg = chg(n(m['rev_ext_ytd']), n(m['rev_ext_ly_ytd'])), eg = chg(n(m['ep_ytd']), n(m['ep_ly_ytd']));
          if (rg == null || eg == null) return null;
          return { text: t('收入 {a} vs 费用 {b}', { a: sgn(rg), b: sgn(eg) }), st: rg >= eg ? 'g' : rg >= eg - 0.1 ? 'y' : 'r' }; } },
    ] },
  ];
}

export default function Health() {
  const t = useT();
  const [all, setAll] = useState<All | null>(null);
  const [meta, setMeta] = useState<{ asOf: string; at: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    supabase.from('bi_healthcheck').select('company,as_of,m,refreshed_at').then(({ data, error }) => {
      if (error) { setErr(error.message); return; }
      const rows = (data ?? []) as { company: string; as_of: string; m: M | null; refreshed_at: string }[];
      const a: All = {};
      rows.forEach((r) => { a[r.company] = r.m ?? {}; });
      if (a[HQ] && a[BR]) {
        const g: M = { ...(a[GP] ?? {}) };
        EXTRA.forEach((k) => { if (g[k] == null) g[k] = add(n(a[HQ][k]), n(a[BR][k])); });
        a[GP] = g;
      }
      setAll(a);
      if (rows[0]) setMeta({ asOf: String(rows[0].as_of), at: new Date(String(rows[0].refreshed_at)).toLocaleString('en-MY', { hour12: false }) });
    });
  }, []);

  if (err) return <div className="notice">{t('查询失败(此页仅老板账号可看):')}{err}</div>;
  if (!all) return <div className="loading">{t('载入中…')}</div>;
  if (!all[HQ]) return <div className="notice">{t('快照还没有产生:请等排程(每 3 小时)跑过 bi.refresh_healthcheck(),或在 Supabase 手动执行一次。')}</div>;

  const sections = buildSections(t);
  const colLabel: Record<string, string> = { [HQ]: t('总行'), [BR]: t('分行 JB'), [GP]: t('集团') };
  const cells = sections.map((s) => s.metrics.map((mt) => COLS.map((c) => (all[c] ? mt.cell(all[c], c, all) : null))));
  const counts = COLS.map((_, ci) => {
    const k = { g: 0, y: 0, r: 0 };
    cells.forEach((s) => s.forEach((row) => { const cell = row[ci]; if (cell && cell.st !== 'i') k[cell.st]++; }));
    return k;
  });

  return (
    <>
      <div className="notice" style={{ marginBottom: 14 }}>
        🩺 <strong>{t('公司健康体检')}</strong> · {t('数据截至 {d}', { d: meta?.asOf ?? '' })} · {t('最后重算 {t}', { t: meta?.at ?? '' })} · {t('每 3 小时随同步重算。')}
        {t('参考区间是同规模马来西亚卫浴 / 五金零售批发商的常见范围,供判断方向用,不是官方标准;口径见 docs/health_check_2026-10.md。')}
      </div>

      <div className="grid-kpi">
        {COLS.map((c, i) => (
          <div className="card kpi" key={c}>
            <div className="label">{colLabel[c]}</div>
            <div className="value" style={{ fontSize: 20 }}>🟢 {counts[i].g} · 🟡 {counts[i].y} · 🔴 {counts[i].r}</div>
            <div className="sub" style={{ fontSize: 12 }}>
              {c === GP ? t('总行对外 + 分行,内部交易已抵销') : c === HQ ? t('对外口径(剔除卖给分行)') : t('分行账套全部')}
            </div>
          </div>
        ))}
      </div>

      <div className="table-scroll">
        <table className="data">
          <thead>
            <tr><th>{t('指标')}</th>{COLS.map((c) => <th key={c}>{colLabel[c]}</th>)}<th>{t('参考区间')}</th></tr>
          </thead>
          <tbody>
            {sections.map((s, si) => (
              <Fragment key={s.title}>
                <tr><td colSpan={5} style={{ paddingTop: 16, fontWeight: 600, color: 'var(--ink-2)' }}>{t(s.title)}</td></tr>
                {s.metrics.map((mt, mi) => (
                  <tr key={mt.label}>
                    <td>{t(mt.label)}{mt.note && <div className="muted" style={{ fontSize: 11 }}>{t(mt.note)}</div>}</td>
                    {COLS.map((c, ci) => {
                      const cell = cells[si][mi][ci];
                      return (
                        <td key={c} style={{ whiteSpace: 'nowrap' }}>
                          {cell ? <>{DOT[cell.st]} {cell.text}{cell.sub && <div className="muted" style={{ fontSize: 11 }}>{cell.sub}</div>}</>
                                : <span className="muted">—</span>}
                        </td>
                      );
                    })}
                    <td className="muted" style={{ fontSize: 12 }}>{t(mt.ref)}</td>
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>

      <p className="muted" style={{ fontSize: 12 }}>
        {t('读法:先看红色,再看与去年 / 上期的方向;⚪ 只供参考不评分。')}
        {t('口径陷阱:2026 年起平台费以 CN 行冲销售,所有同比已剔除;总账「销货成本」其实是当期采购额,月度毛利率不可看;总行对分行的零成本调拨会虚抬销售口径毛利;分行总账采购远大于销售口径成本(SO/DO 未转发票),分行利润以总账为下限、销售口径为上限;折旧 / 利息 / 董事花红只在 12 月入账。')}
      </p>
    </>
  );
}
