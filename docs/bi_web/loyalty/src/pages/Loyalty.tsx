import { Fragment, useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import { fmtRM, fmtNum, fmtDate } from '../lib/format';
import { Kpi } from '../components/ChartCard';
import { tr, type Lang } from '../lib/i18n';

// 顾客资料(2026-09-29 取代积分):门市散客用电话当顾客编号,总部 + JB 合并。购买历史从 bi.fact_sales 现算,
// 员工补的资料存 bi.customer_profile(RPC public.bi_customer*,migration customer_profiles)。
// 2026-09-30 第二版(migration customer_crm):跟进提醒、一键 WhatsApp(话术范本)、买了 A 没买 B、同意收促销
// (汇出与活动只收明确同意的)、顾客分级、促销活动成效、每月顾客报告。档名沿用 Loyalty.tsx / loyalty.html。
// 2026-10-05 第三版(migration customer_crm_v3_*):手机快速登记、顾客扫 QR 自己登记(店员确认)、报价没成交提醒、
// 装修进度 5 段 + 推荐类别、修改纪录、合并重复顾客。

type Consent = 'yes' | 'no' | null;
type Customer = {
  member_id: string; name: string | null; stores: string | null; first_date: string | null; last_date: string | null;
  doc_count: number; doc_count_12m: number; spent: number; spent_12m: number; categories: string[];
  birth_month: number | null; birth_day: number | null; area: string | null; address: string | null;
  customer_type: string | null; note: string | null; consent: Consent; next_contact: string | null;
  last_contact_at: string | null; profile_created_at: string | null; profile_updated_at: string | null;
  reno_stage?: string | null; reno_stage_at?: string | null; quote_open?: number; quote_amount?: number; quote_due?: string | null;
};
type Item = { item_code: string | null; description: string | null; qty: number; uom: string | null; sub_total: number };
type Doc = {
  company: string; doc_type: string; doc_no: string; doc_date: string; debtor_code: string; debtor_name: string | null;
  sales_agent: string | null; amount: number; items: Item[];
};
type Profile = {
  name: string | null; birth_month: number | null; birth_day: number | null; area: string | null; address: string | null;
  customer_type: string | null; note: string | null; consent: Consent; consent_at: string | null; consent_by: string | null;
  next_contact: string | null; last_contact_at: string | null; updated_at: string; updated_by: string | null;
  reno_stage?: string | null; reno_stage_at?: string | null; email?: string | null;
};
type Quote = {
  company: string; doc_no: string; doc_date: string; sales_agent: string | null; amount: number; transferred: boolean;
  items: string | null; bought_after: boolean;
};
type Detail = { member_id: string; profile: Profile | null; docs: Doc[]; aliases?: string[]; quotes?: Quote[] };
type Signup = {
  id: number; member_id: string; main_id: string; name: string | null; birth_month: number | null; birth_day: number | null;
  area: string | null; address?: string | null; email?: string | null; consent: boolean; store: string | null; created_at: string;
  status: 'pending' | 'confirmed' | 'rejected';
  current: {
    name: string | null; birth_month: number | null; birth_day: number | null; area: string | null; consent: Consent;
    last_contact_at?: string | null;
  } | null;
};
type LogRow = { at: string; by: string | null; action: string; changes: Record<string, unknown>; member_id: string };
type Missing = {
  company: string; doc_type: string; doc_no: string; doc_date: string; debtor_code: string;
  debtor_name: string | null; sales_agent: string | null; amount: number;
};
export type Settings = {
  vip_min_12m: number; regular_min_docs: number; lapsed_days: number; lead_follow_days: number; birthday_days: number;
  quote_follow_days: number; quote_max_days: number; stage_follow_days: number; stage_reco: Record<string, string[]>;
  updated_at?: string | null; updated_by?: string | null;
};
type Template = { id: number; title: string; body: string; sort: number };
type Campaign = {
  id: number; name: string; message: string | null; sent_on: string; created_by: string | null; members: number;
  buyers_30: number; revenue_30: number; buyers_60: number; revenue_60: number;
};
type Monthly = {
  month: string; active: number; new_customers: number; returning_customers: number;
  new_revenue: number; returning_revenue: number; lapsed: number;
};
type Agent = { agent: string; customers: number; returning_customers: number; new_customers: number; revenue: number };
type T = (zh: string, vars?: Record<string, string | number>) => string;

const n = (v: unknown) => Number(v ?? 0);
const STORE: Record<string, string> = { HOMEWORKSSB: 'HQ', HOMEWORKSSOUTHERN: 'JB' };
export const TYPES = ['屋主', '设计师', '承包商', '水工', '公司', '其他'];
export const DEFAULT_SETTINGS: Settings = {
  vip_min_12m: 10000, regular_min_docs: 2, lapsed_days: 365, lead_follow_days: 7, birthday_days: 7,
  quote_follow_days: 7, quote_max_days: 60, stage_follow_days: 30,
  stage_reco: { plan: ['SANITARY', 'KITCHEN'], rough: ['VALVE', 'FITTING'], tile: ['SANITARY', 'BUILDING'],
    install: ['LOCK', 'KITCHEN', 'ELECTRIC', 'GARDEN'], done: ['LOCK', 'GARDEN'] },
};
/** 装修进度 5 段(使用者 2026-10-05 选的),键存数据库、名称显示用 */
export const STAGES: [string, string][] = [
  ['plan', '规划中'], ['rough', '动工 / 水电'], ['tile', '泥水 / 贴砖'], ['install', '安装'], ['done', '完工'],
];
export const STAGE_LABEL: Record<string, string> = Object.fromEntries(STAGES);

/** 这个装修阶段推荐的类别里,顾客还没买过的(给店员开口推荐) */
export function stageNext(stage: string | null | undefined, bought: string[], s: Settings): string[] {
  if (!stage) return [];
  return (s.stage_reco?.[stage] ?? []).filter((c) => !bought.includes(c));
}

/** 60123456789 → 012-345 6789;6591234567 → +65 9123 4567;A:公司:代号 → 代号 (HQ) */
export function fmtMember(id: string): string {
  if (id.startsWith('A:')) {
    const [, co, code] = id.split(':');
    return `${code} (${STORE[co] ?? co})`;
  }
  if (id.startsWith('65') && id.length === 10) return `+65 ${id.slice(2, 6)} ${id.slice(6)}`;
  if (id.startsWith('60')) {
    const d = '0' + id.slice(2);
    if (d.startsWith('01')) return `${d.slice(0, 3)}-${d.slice(3, d.length - 4)} ${d.slice(-4)}`;
    return `${d.slice(0, 2)}-${d.slice(2)}`;
  }
  return id;
}

/** 给 WhatsApp 用的国际格式:60123456789 → +60123456789;账号型顾客没有电话 → 空 */
export function waNumber(id: string): string {
  return /^[0-9]+$/.test(id) ? `+${id}` : '';
}

/** 单据上的客户名称常夹着电话:「ZILONG (017-7000190)」→「ZILONG」 */
export function cleanName(raw: string | null | undefined): string {
  return (raw ?? '').replace(/[(（]?\s*\+?\d[\d\s-]{6,}\d\s*[)）]?/g, ' ').replace(/[()（）]\s*[)）]?/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

/** 范本的 {name} 换成顾客名字;没有名字时把「Hi {name}，」收成「Hi，」 */
export function fillTemplate(body: string, name: string): string {
  return body.replace(/\{name\}/g, name.trim()).replace(/[ \t]+([，,！!])/g, '$1');
}

/** wa.me 连结;账号型顾客(没有电话)回空字串 */
export function waLink(id: string, text?: string): string {
  if (!/^[0-9]+$/.test(id)) return '';
  return `https://wa.me/${id}` + (text ? `?text=${encodeURIComponent(text)}` : '');
}

/** 本地日期 yyyy-mm-dd(不用 toISOString,避免马来西亚早上 8 点前算成前一天) */
export function localISO(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function midnight(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function daysSince(d: string | null, today: Date = new Date()): number {
  if (!d) return Infinity;
  const at = d.length <= 10 ? new Date(d + 'T00:00:00') : new Date(d);
  return (midnight(today).getTime() - midnight(at).getTime()) / 86400000;
}

/** 离下一次生日还有几天(今天生日 = 0);2/29 在平年算 3/1 */
export function daysUntilBirthday(month: number, day: number, today: Date = new Date()): number {
  const t0 = midnight(today);
  let b = new Date(t0.getFullYear(), month - 1, day);
  if (b < t0) b = new Date(t0.getFullYear() + 1, month - 1, day);
  return Math.round((b.getTime() - t0.getTime()) / 86400000);
}

export type Tier = 'vip' | 'regular' | 'normal' | 'lapsed' | 'lead';
export const TIERS: Tier[] = ['vip', 'regular', 'normal', 'lapsed', 'lead'];
export const TIER_LABEL: Record<Tier, string> = { vip: 'VIP', regular: '常客', normal: '一般', lapsed: '流失', lead: '潜在客' };

/** 分级:没买过 = 潜在客;最后消费超过流失天数 = 流失;近 12 个月消费 ≥ 门槛 = VIP;近 12 个月单数 ≥ 门槛 = 常客;其余一般 */
export function tierOf(c: Pick<Customer, 'last_date' | 'spent_12m' | 'doc_count_12m'>, s: Settings, today: Date = new Date()): Tier {
  if (!c.last_date) return 'lead';
  if (daysSince(c.last_date, today) > s.lapsed_days) return 'lapsed';
  if (n(c.spent_12m) >= n(s.vip_min_12m)) return 'vip';
  if (n(c.doc_count_12m) >= n(s.regular_min_docs)) return 'regular';
  return 'normal';
}

export type Reason = { kind: 'due' | 'birthday' | 'lead' | 'quote' | 'stage'; days: number };
export type FollowUp = { c: Customer; reasons: Reason[] };

/** 跟进提醒:约好的联络日到了、生日快到(这段期间还没联络过)、潜在客建档后 N 天都没联络 */
export function followUps(list: Customer[], s: Settings, today: Date = new Date()): FollowUp[] {
  const iso = localISO(today);
  const out: FollowUp[] = [];
  for (const c of list) {
    const reasons: Reason[] = [];
    const contacted = daysSince(c.last_contact_at, today);
    if (c.next_contact && c.next_contact <= iso) reasons.push({ kind: 'due', days: daysSince(c.next_contact, today) });
    if (c.birth_month && c.birth_day) {
      const d = daysUntilBirthday(c.birth_month, c.birth_day, today);
      if (d <= s.birthday_days && !(contacted <= s.birthday_days - d)) reasons.push({ kind: 'birthday', days: d });
    }
    if (!c.last_date && c.profile_created_at && !c.last_contact_at && !(c.next_contact && c.next_contact > iso)
        && daysSince(c.profile_created_at, today) >= s.lead_follow_days) {
      reasons.push({ kind: 'lead', days: daysSince(c.profile_created_at, today) });
    }
    // 报价单开出 N 天还没成交(没转单、之后也没买),从该跟进的那天起还没联络过
    if (c.quote_due && (!c.last_contact_at || localISO(new Date(c.last_contact_at)) < c.quote_due)) {
      reasons.push({ kind: 'quote', days: daysSince(c.quote_due, today) + s.quote_follow_days });
    }
    // 装修进度太久没更新(完工的不追)
    if (c.reno_stage && c.reno_stage !== 'done' && c.reno_stage_at && daysSince(c.reno_stage_at, today) >= s.stage_follow_days
        && !(contacted < s.stage_follow_days)) {
      reasons.push({ kind: 'stage', days: daysSince(c.reno_stage_at, today) });
    }
    if (reasons.length) out.push({ c, reasons });
  }
  const order = { due: 0, quote: 50, birthday: 100, stage: 500, lead: 1000 };
  const rank = (x: FollowUp) => Math.min(...x.reasons.map((r) => order[r.kind] + (r.kind === 'birthday' ? r.days : 0)));
  return out.sort((a, b) => rank(a) - rank(b));
}

function csvCell(v: unknown): string {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadCsv(filename: string, header: string[], rows: unknown[][]) {
  const text = '﻿' + [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

type Filters = {
  q: string; store: string; recency: string; minSpent: string; category: string; notCategory: string; ctype: string;
  area: string; bmonth: string; tier: string; consent: string; stage: string;
};
const EMPTY: Filters = {
  q: '', store: '', recency: '', minSpent: '', category: '', notCategory: '', ctype: '', area: '', bmonth: '', tier: '', consent: '',
  stage: '',
};

export function applyFilters(list: Customer[], f: Filters, s: Settings = DEFAULT_SETTINGS): Customer[] {
  const text = f.q.trim().toLowerCase();
  const digits = f.q.replace(/\D/g, '').replace(/^0/, '');
  const min = n(f.minSpent);
  return list.filter((c) => {
    if (text && !((digits.length >= 4 && c.member_id.includes(digits)) || (c.name ?? '').toLowerCase().includes(text)
      || (c.note ?? '').toLowerCase().includes(text))) return false;
    if (f.store === 'HQ' && !(c.stores ?? '').includes('HQ')) return false;
    if (f.store === 'JB' && !(c.stores ?? '').includes('JB')) return false;
    if (f.store === 'both' && c.stores !== 'HQ + JB') return false;
    const age = daysSince(c.last_date);
    if (f.recency === '90' && age > 90) return false;
    if (f.recency === '180' && age > 180) return false;
    if (f.recency === '365' && age > 365) return false;
    if (f.recency === 'lapsed' && !(age > 365 && isFinite(age))) return false;
    if (f.recency === 'none' && isFinite(age)) return false;
    if (min && n(c.spent) < min) return false;
    if (f.category && !c.categories.includes(f.category)) return false;
    if (f.notCategory && c.categories.includes(f.notCategory)) return false;
    if (f.ctype === '-' ? c.customer_type : f.ctype && c.customer_type !== f.ctype) return false;
    if (f.area && !`${c.area ?? ''} ${c.address ?? ''}`.toLowerCase().includes(f.area.trim().toLowerCase())) return false;
    if (f.bmonth && c.birth_month !== n(f.bmonth)) return false;
    if (f.tier && tierOf(c, s) !== f.tier) return false;
    if (f.consent === 'yes' && c.consent !== 'yes') return false;
    if (f.consent === 'no' && c.consent !== 'no') return false;
    if (f.consent === 'unknown' && c.consent) return false;
    if (f.stage === 'quote' ? !n(c.quote_open) : f.stage === 'any' ? !c.reno_stage : f.stage && c.reno_stage !== f.stage) return false;
    return true;
  });
}

function TierTag({ tier, t }: { tier: Tier; t: T }) {
  return <span className={`lp-tag lp-tier-${tier}`}>{t(TIER_LABEL[tier])}</span>;
}

function ConsentTag({ consent, t }: { consent: Consent; t: T }) {
  if (consent === 'yes') return <span className="lp-tag lp-yes" title={t('同意收促销')}>✓</span>;
  if (consent === 'no') return <span className="lp-tag lp-no" title={t('不收促销')}>✕</span>;
  return null;
}

/** 一键 WhatsApp:每个范本一颗按钮,开 wa.me 并记下联络时间 */
function WaButtons({ id, name, templates, t, onTouched }: {
  id: string; name: string; templates: Template[]; t: T; onTouched: () => void;
}) {
  if (!waLink(id)) return <span className="muted" style={{ fontSize: 12 }}>{t('账号型顾客没有电话,不能 WhatsApp')}</span>;
  const touch = () => { supabase.rpc('bi_customer_touch', { p_member: id }).then(() => onTouched()); };
  return (
    <span className="lp-wa">
      {templates.map((x) => (
        <a key={x.id} className="btn" href={waLink(id, fillTemplate(x.body, name))} target="_blank" rel="noreferrer"
           onClick={(e) => { e.stopPropagation(); touch(); }} title={fillTemplate(x.body, name)}>
          WhatsApp · {x.title}
        </a>
      ))}
      <a className="btn" href={waLink(id)} target="_blank" rel="noreferrer" onClick={(e) => { e.stopPropagation(); touch(); }}>
        {t('WhatsApp(空白)')}
      </a>
    </span>
  );
}

export default function Loyalty({ lang, role }: { lang: Lang; role: string | null; company: string | null }) {
  const t: T = (zh, vars) => tr(lang, zh, vars);
  const canManage = role === 'owner' || role === 'manager';
  const isOwner = role === 'owner';

  const [list, setList] = useState<Customer[] | null>(null);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [f, setF] = useState<Filters>(EMPTY);
  const [sort, setSort] = useState<'recent' | 'spent' | 'name'>('recent');
  const [shown, setShown] = useState(100);
  const [sel, setSel] = useState<string | null>(null);
  const [newPhone, setNewPhone] = useState('');
  const [campKey, setCampKey] = useState(0);

  async function load() {
    const r = await supabase.rpc('bi_customers');
    setErr(r.error ? r.error.message : null);
    setList((r.data ?? []) as Customer[]);
  }
  async function loadSettings() {
    const [s, w] = await Promise.all([supabase.rpc('bi_customer_settings'), supabase.rpc('bi_wa_templates')]);
    if (s.data) {
      const d = s.data as Partial<Settings>;
      setSettings({ ...DEFAULT_SETTINGS, ...d, stage_reco: d.stage_reco ?? DEFAULT_SETTINGS.stage_reco });
    }
    setTemplates((w.data ?? []) as Template[]);
  }
  useEffect(() => { load(); loadSettings(); }, []);

  const set = (k: keyof Filters) => (e: { target: { value: string } }) => { setF({ ...f, [k]: e.target.value }); setShown(100); };
  const categories = useMemo(() => Array.from(new Set((list ?? []).flatMap((c) => c.categories))).sort(), [list]);
  const filtered = useMemo(() => {
    const out = applyFilters(list ?? [], f, settings);
    if (sort === 'spent') out.sort((a, b) => n(b.spent) - n(a.spent));
    else if (sort === 'name') out.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
    else out.sort((a, b) => ((a.last_date ?? '') < (b.last_date ?? '') ? 1 : (a.last_date ?? '') > (b.last_date ?? '') ? -1 : 0));
    return out;
  }, [list, f, sort, settings]);
  const agreed = useMemo(() => filtered.filter((c) => c.consent === 'yes'), [filtered]);
  const follow = useMemo(() => followUps(list ?? [], settings), [list, settings]);

  const month = new Date().getMonth() + 1;
  const totals = useMemo(() => {
    const all = list ?? [];
    const tiers: Record<Tier, number> = { vip: 0, regular: 0, normal: 0, lapsed: 0, lead: 0 };
    for (const c of all) tiers[tierOf(c, settings)] += 1;
    return {
      count: all.length,
      active: all.filter((c) => daysSince(c.last_date) <= 365).length,
      profiled: all.filter((c) => c.profile_updated_at).length,
      birthday: all.filter((c) => c.birth_month === month).length,
      consent: all.filter((c) => c.consent === 'yes').length,
      tiers,
    };
  }, [list, month, settings]);

  function exportCsv() {
    downloadCsv(`customers_${localISO()}.csv`,
      [t('电话(WhatsApp)'), t('电话'), t('名字'), t('分级'), t('类型'), t('地区'), t('地址'), t('生日'), t('门市'), t('首次消费'),
        t('最后消费'), t('单数'), t('累计消费'), t('近 12 个月'), t('买过类别'), t('备注')],
      agreed.map((c) => [waNumber(c.member_id), fmtMember(c.member_id), cleanName(c.name), t(TIER_LABEL[tierOf(c, settings)]),
        c.customer_type, c.area, c.address, c.birth_month ? `${c.birth_month}/${c.birth_day}` : '', c.stores, c.first_date,
        c.last_date, c.doc_count, n(c.spent).toFixed(2), n(c.spent_12m).toFixed(2), c.categories.join(' '), c.note]));
  }

  function open(id: string) {
    setSel(id);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function openNew() {
    const digits = newPhone.replace(/\D/g, '');
    if (digits.length < 8) return;
    open(newPhone.trim());
    setNewPhone('');
  }

  if (list === null) return <div className="loading">{t('载入中…')}</div>;

  return (
    <>
      {err && <div className="notice">{t('查询失败:')}{err}</div>}
      <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
        {t('门市顾客以电话认人,总部与 JB 合并;购买纪录每天中午从 AutoCount 同步。开单时客户名称写「名字 + 手机号」,顾客才会出现在这里。')}
      </p>

      <div className="grid-kpi">
        <Kpi label={t('顾客人数')} value={fmtNum(totals.count)} sub={t('近 12 个月有消费 {a} 位', { a: fmtNum(totals.active) })} />
        <Kpi label={t('已补资料')} value={fmtNum(totals.profiled)} sub={t('有填名字 / 生日 / 地区等')} />
        <Kpi label={t('同意收促销')} value={fmtNum(totals.consent)} sub={t('只有这些人会被汇出 / 放进活动')} />
        <Kpi label={t('待跟进')} value={fmtNum(follow.length)} sub={t('本月生日 {b} 位', { b: fmtNum(totals.birthday) })} />
      </div>

      {sel && (
        <CustomerPanel key={sel} id={sel} t={t} settings={settings} templates={templates} canManage={canManage}
                       categories={list.find((c) => c.member_id === sel)?.categories ?? []}
                       onClose={() => setSel(null)} onSaved={load} onOpen={open} />
      )}

      <QuickRegister t={t} onSaved={load} onOpen={open} />
      <Signups t={t} onDone={load} onOpen={open} />

      <FollowUpList items={follow} t={t} settings={settings} templates={templates} onOpen={open} onTouched={load} />

      <div className="card card-block">
        <h2>{t('顾客')}</h2>
        <div className="filters" style={{ marginBottom: 8 }}>
          <div className="seg">
            <button className={f.tier === '' ? 'active' : ''} onClick={() => setF({ ...f, tier: '' })}>{t('全部')}</button>
            {TIERS.map((x) => (
              <button key={x} className={f.tier === x ? 'active' : ''} onClick={() => { setF({ ...f, tier: x }); setShown(100); }}>
                {t(TIER_LABEL[x])} {fmtNum(totals.tiers[x])}
              </button>
            ))}
          </div>
          <span className="muted" style={{ fontSize: 12 }}>
            {t('VIP = 近 12 个月消费 ≥ RM{v};常客 = 近 12 个月 ≥ {d} 张单;流失 = 超过 {l} 天没来', {
              v: fmtNum(settings.vip_min_12m), d: settings.regular_min_docs, l: settings.lapsed_days })}
          </span>
        </div>
        <div className="filters" style={{ marginBottom: 8 }}>
          <input placeholder={t('电话、名字或备注')} value={f.q} onChange={set('q')} style={{ minWidth: 200 }} />
          <select value={f.store} onChange={set('store')}>
            <option value="">{t('全部门市')}</option>
            <option value="HQ">HQ</option>
            <option value="JB">JB</option>
            <option value="both">{t('两边都买过')}</option>
          </select>
          <select value={f.recency} onChange={set('recency')}>
            <option value="">{t('不限最后消费')}</option>
            <option value="90">{t('3 个月内来过')}</option>
            <option value="180">{t('6 个月内来过')}</option>
            <option value="365">{t('12 个月内来过')}</option>
            <option value="lapsed">{t('超过 12 个月没来')}</option>
            <option value="none">{t('还没买过')}</option>
          </select>
          <select value={f.category} onChange={set('category')}>
            <option value="">{t('买过:全部类别')}</option>
            {categories.map((c) => <option key={c} value={c}>{t('买过 {c}', { c })}</option>)}
          </select>
          <select value={f.notCategory} onChange={set('notCategory')}>
            <option value="">{t('没买过:不限')}</option>
            {categories.map((c) => <option key={c} value={c}>{t('没买过 {c}', { c })}</option>)}
          </select>
          <select value={f.ctype} onChange={set('ctype')}>
            <option value="">{t('全部类型')}</option>
            {TYPES.map((x) => <option key={x} value={x}>{t(x)}</option>)}
            <option value="-">{t('未分类')}</option>
          </select>
          <select value={f.consent} onChange={set('consent')}>
            <option value="">{t('同意收促销:不限')}</option>
            <option value="yes">{t('同意')}</option>
            <option value="no">{t('不同意')}</option>
            <option value="unknown">{t('未确认')}</option>
          </select>
          <select value={f.stage} onChange={set('stage')}>
            <option value="">{t('装修阶段:不限')}</option>
            {STAGES.map(([k, v]) => <option key={k} value={k}>{t(v)}</option>)}
            <option value="any">{t('有填装修阶段')}</option>
            <option value="quote">{t('有报价没成交')}</option>
          </select>
          <select value={f.bmonth} onChange={set('bmonth')}>
            <option value="">{t('生日月份')}</option>
            {Array.from({ length: 12 }, (_, i) => <option key={i} value={i + 1}>{t('{m} 月', { m: i + 1 })}</option>)}
          </select>
          <input placeholder={t('地区')} value={f.area} onChange={set('area')} style={{ width: 110 }} />
          <input placeholder={t('累计消费至少 RM')} value={f.minSpent} onChange={set('minSpent')} inputMode="numeric" style={{ width: 150 }} />
          <button className="btn" onClick={() => setF(EMPTY)}>{t('清除筛选')}</button>
        </div>
        <div className="filters" style={{ marginBottom: 8 }}>
          <div className="seg">
            <button className={sort === 'recent' ? 'active' : ''} onClick={() => setSort('recent')}>{t('最近消费')}</button>
            <button className={sort === 'spent' ? 'active' : ''} onClick={() => setSort('spent')}>{t('消费最多')}</button>
            <button className={sort === 'name' ? 'active' : ''} onClick={() => setSort('name')}>{t('名字')}</button>
          </div>
          <span className="muted lp-count" style={{ fontSize: 13 }}>
            {t('符合 {n} 位,其中同意收促销 {y} 位', { n: fmtNum(filtered.length), y: fmtNum(agreed.length) })}
          </span>
          {canManage && (
            <button className="btn primary" onClick={exportCsv} disabled={!agreed.length}>
              {t('汇出同意名单 {n} 位 (Excel)', { n: fmtNum(agreed.length) })}
            </button>
          )}
          <span className="spacer" style={{ flex: 1 }} />
          <input placeholder={t('新顾客电话')} value={newPhone} onChange={(e) => setNewPhone(e.target.value)}
                 onKeyDown={(e) => { if (e.key === 'Enter') openNew(); }} style={{ width: 150 }} />
          <button className="btn" onClick={openNew}>{t('新增顾客')}</button>
        </div>
        {canManage && <NewCampaign t={t} members={agreed.map((c) => c.member_id)} total={filtered.length}
                                   onCreated={() => setCampKey(campKey + 1)} />}
        <div className="table-scroll">
          <table className="data">
            <thead>
              <tr>
                <th>{t('电话 / 账号')}</th><th>{t('名字')}</th><th>{t('分级')}</th><th>{t('类型')}</th><th>{t('地区')}</th>
                <th>{t('门市')}</th><th>{t('最后消费')}</th><th className="num">{t('累计消费')}</th>
                <th className="num">{t('近 12 个月')}</th><th>{t('买过类别')}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && <tr><td colSpan={10} className="muted">{t('没有符合的顾客')}</td></tr>}
              {filtered.slice(0, shown).map((c) => (
                <tr key={c.member_id} className="lp-click" onClick={() => open(c.member_id)}>
                  <td style={{ whiteSpace: 'nowrap' }}>{fmtMember(c.member_id)} <ConsentTag consent={c.consent} t={t} /></td>
                  <td>{cleanName(c.name)}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <TierTag tier={tierOf(c, settings)} t={t} />
                    {n(c.quote_open) > 0 && <span className="lp-tag lp-quote">{t('报价 {n}', { n: n(c.quote_open) })}</span>}
                  </td>
                  <td>{c.customer_type ? t(c.customer_type) : ''}{c.reno_stage ? ` · ${t(STAGE_LABEL[c.reno_stage] ?? c.reno_stage)}` : ''}</td>
                  <td>{c.area}</td>
                  <td>{c.stores}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(c.last_date)}</td>
                  <td className="num">{fmtNum(c.spent, 2)}</td>
                  <td className={'num' + (n(c.spent_12m) ? '' : ' muted')}>{n(c.spent_12m) ? fmtNum(c.spent_12m, 2) : '–'}</td>
                  <td className="muted" style={{ fontSize: 12 }}>{c.categories.join(' · ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {filtered.length > shown && (
          <button className="btn" style={{ marginTop: 8 }} onClick={() => setShown(shown + 200)}>{t('显示更多')}</button>
        )}
      </div>

      {canManage && <Campaigns key={campKey} t={t} isOwner={isOwner} list={list} settings={settings} />}
      <MonthlyReport t={t} settings={settings} />
      {canManage && (
        <SettingsPanel t={t} isOwner={isOwner} settings={settings} templates={templates} onChanged={loadSettings} />
      )}
      <MissingPhone t={t} />
    </>
  );
}

function FollowUpList({ items, t, settings, templates, onOpen, onTouched }: {
  items: FollowUp[]; t: T; settings: Settings; templates: Template[]; onOpen: (id: string) => void; onTouched: () => void;
}) {
  const [shown, setShown] = useState(20);
  const label = (r: Reason) => {
    if (r.kind === 'due') return r.days > 0 ? t('约好联络日已过 {d} 天', { d: r.days }) : t('今天约好联络');
    if (r.kind === 'birthday') return r.days === 0 ? t('今天生日 🎂') : t('{d} 天后生日 🎂', { d: r.days });
    if (r.kind === 'quote') return t('报价 {d} 天还没成交', { d: r.days });
    if (r.kind === 'stage') return t('装修进度 {d} 天没更新', { d: r.days });
    return t('潜在客,建档 {d} 天还没联络', { d: r.days });
  };
  const touch = (id: string) => { supabase.rpc('bi_customer_touch', { p_member: id }).then(() => onTouched()); };
  return (
    <div className="card card-block">
      <h2>{t('跟进提醒({n} 位)', { n: fmtNum(items.length) })}</h2>
      <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
        {t('{b} 天内生日、潜在客建档满 {l} 天没联络、约好的下次联络日到了、报价开出 {q} 天还没成交、装修进度 {s} 天没更新。按 WhatsApp 或「已联络」后就会从这里消失。', {
          b: settings.birthday_days, l: settings.lead_follow_days, q: settings.quote_follow_days, s: settings.stage_follow_days })}
      </p>
      {items.length === 0 && <div className="muted">{t('目前没有要跟进的顾客 👍')}</div>}
      {items.length > 0 && (
        <div className="table-scroll">
          <table className="data">
            <thead>
              <tr><th>{t('电话 / 账号')}</th><th>{t('名字')}</th><th>{t('原因')}</th><th>{t('备注')}</th><th>{t('联络')}</th></tr>
            </thead>
            <tbody>
              {items.slice(0, shown).map(({ c, reasons }) => (
                <tr key={c.member_id}>
                  <td style={{ whiteSpace: 'nowrap' }} className="lp-click" onClick={() => onOpen(c.member_id)}>
                    {fmtMember(c.member_id)} <ConsentTag consent={c.consent} t={t} />
                  </td>
                  <td className="lp-click" onClick={() => onOpen(c.member_id)}>{cleanName(c.name)}</td>
                  <td>
                    {reasons.map((r) => <div key={r.kind}>{label(r)}</div>)}
                    {reasons.some((r) => r.kind === 'quote') && (
                      <div className="muted" style={{ fontSize: 12 }}>{t('未成交报价 RM {a}', { a: fmtNum(c.quote_amount, 2) })}</div>
                    )}
                    {c.reno_stage && (
                      <div className="muted" style={{ fontSize: 12 }}>
                        {t('装修:{s}', { s: t(STAGE_LABEL[c.reno_stage] ?? c.reno_stage) })}
                        {stageNext(c.reno_stage, c.categories, settings).length > 0
                          && ` · ${t('可推荐 {c}', { c: stageNext(c.reno_stage, c.categories, settings).join(' / ') })}`}
                      </div>
                    )}
                  </td>
                  <td className="muted" style={{ fontSize: 12, maxWidth: 260 }}>{c.note}</td>
                  <td>
                    <WaButtons id={c.member_id} name={cleanName(c.name)} templates={templates} t={t} onTouched={onTouched} />
                    <button className="btn" onClick={() => touch(c.member_id)}>{t('已联络')}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {items.length > shown && <button className="btn" style={{ marginTop: 8 }} onClick={() => setShown(shown + 50)}>{t('显示更多')}</button>}
    </div>
  );
}

function NewCampaign({ t, members, total, onCreated }: { t: T; members: string[]; total: number; onCreated: () => void }) {
  const [show, setShow] = useState(false);
  const [name, setName] = useState('');
  const [message, setMessage] = useState('');
  const [sentOn, setSentOn] = useState(localISO());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function create() {
    if (!name.trim()) { setMsg(t('活动要有名称')); return; }
    setBusy(true);
    const r = await supabase.rpc('bi_campaign_create', { p_name: name, p_message: message, p_sent_on: sentOn || null, p_members: members });
    setBusy(false);
    if (r.error) { setMsg(r.error.message); return; }
    setMsg(t('已建立活动,名单 {n} 位。', { n: fmtNum(n((r.data as { members: number }).members)) }));
    setName(''); setMessage('');
    setShow(false);
    onCreated();
  }

  if (!show) {
    return (
      <div className="filters" style={{ marginBottom: 8 }}>
        <button className="btn" disabled={!members.length} onClick={() => { setShow(true); setMsg(null); }}>
          {t('用这份名单建立促销活动')}
        </button>
        {msg && <span className="muted" style={{ fontSize: 13 }}>{msg}</span>}
      </div>
    );
  }
  return (
    <div className="lp-box">
      <h3 style={{ marginTop: 0 }}>{t('建立促销活动')}</h3>
      <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
        {t('会放进目前筛选结果里「同意收促销」的 {y} 位(另外 {x} 位未同意或未确认,不会放进去)。之后在「促销活动」看这批人发送后 30 / 60 天的消费。', {
          y: fmtNum(members.length), x: fmtNum(total - members.length) })}
      </p>
      <div className="lp-form" style={{ maxWidth: 520 }}>
        <label>{t('活动名称(例:10 月水龙头 8 折)')}</label>
        <input value={name} onChange={(e) => setName(e.target.value)} />
        <label>{t('发送日期')}</label>
        <input type="date" value={sentOn} onChange={(e) => setSentOn(e.target.value)} />
        <label>{t('讯息内容(选填,留底用)')}</label>
        <textarea rows={3} value={message} onChange={(e) => setMessage(e.target.value)} />
        <div className="lp-row">
          <button className="btn primary" disabled={busy || !members.length} onClick={create}>{t('建立')}</button>
          <button className="btn" onClick={() => setShow(false)}>{t('取消')}</button>
        </div>
      </div>
      {msg && <div className="notice" style={{ marginTop: 8 }}>{msg}</div>}
    </div>
  );
}

function CustomerPanel({ id, t, settings, templates, canManage, categories, onClose, onSaved, onOpen }: {
  id: string; t: T; settings: Settings; templates: Template[]; canManage: boolean; categories: string[];
  onClose: () => void; onSaved: () => void; onOpen: (id: string) => void;
}) {
  const [d, setD] = useState<Detail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ name: '', bm: '', bd: '', area: '', address: '', ctype: '', note: '', consent: '', next: '' });

  async function load() {
    const r = await supabase.rpc('bi_customer', { p_member: id });
    if (r.error) { setErr(r.error.message); return; }
    const det = r.data as Detail;
    setErr(null);
    setD(det);
    const p = det.profile;
    setForm({
      name: p?.name ?? cleanName(det.docs[0]?.debtor_name), bm: p?.birth_month ? String(p.birth_month) : '',
      bd: p?.birth_day ? String(p.birth_day) : '', area: p?.area ?? '', address: p?.address ?? '',
      ctype: p?.customer_type ?? '', note: p?.note ?? '', consent: p?.consent ?? '', next: p?.next_contact ?? '',
    });
  }
  useEffect(() => { load(); }, [id]);

  const upd = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  async function save() {
    if (!!form.bm !== !!form.bd) { setMsg(t('生日要月、日都填,或都不填')); return; }
    setBusy(true);
    const r = await supabase.rpc('bi_customer_save', {
      p_member: d?.member_id ?? id, p_name: form.name, p_birth_month: form.bm ? n(form.bm) : null,
      p_birth_day: form.bd ? n(form.bd) : null, p_area: form.area, p_address: form.address,
      p_customer_type: form.ctype || null, p_note: form.note, p_consent: form.consent || null, p_next_contact: form.next || null,
    });
    setBusy(false);
    if (r.error) { setMsg(r.error.message); return; }
    setMsg(t('已储存。'));
    await load();
    onSaved();
  }

  async function setStage(stage: string) {
    const r = await supabase.rpc('bi_customer_set_stage', { p_member: d?.member_id ?? id, p_stage: stage || null });
    if (r.error) { setMsg(r.error.message); return; }
    setMsg(t('装修阶段已更新。'));
    await load();
    onSaved();
  }

  const key = d?.member_id ?? id;
  const docs = d?.docs ?? [];
  const stores = Array.from(new Set(docs.map((x) => STORE[x.company] ?? x.company))).sort().join(' + ');
  const spent = docs.reduce((s, x) => s + n(x.amount), 0);
  const cutoff = localISO(new Date(Date.now() - 365 * 86400000));
  const recent = docs.filter((x) => x.doc_date > cutoff);
  const tier = tierOf({
    last_date: docs[0]?.doc_date ?? null, spent_12m: recent.reduce((s, x) => s + n(x.amount), 0),
    doc_count_12m: recent.filter((x) => n(x.amount) > 0).length,
  }, settings);
  const p = d?.profile;

  return (
    <div className="card card-block lp-panel">
      <div className="lp-head">
        <div>
          <h2 style={{ marginBottom: 2 }}>{form.name || fmtMember(key)} {d && <TierTag tier={tier} t={t} />}</h2>
          <div className="muted" style={{ fontSize: 13 }}>
            {fmtMember(key)}{stores ? ` · ${stores}` : ''}
            {docs.length ? ` · ${t('首次消费')} ${fmtDate(docs[docs.length - 1].doc_date)}` : ''}
            {d && !docs.length ? ` · ${t('还没有购买纪录')}` : ''}
            {p?.last_contact_at ? ` · ${t('上次联络')} ${new Date(p.last_contact_at).toLocaleDateString('en-MY')}` : ''}
            {p?.email ? ` · ${p.email}` : ''}
          </div>
        </div>
        <button className="btn" onClick={onClose}>{t('关闭')}</button>
      </div>

      {err && <div className="notice">{t('查询失败:')}{err}</div>}
      {!d && !err && <div className="loading">{t('载入中…')}</div>}

      {d && (
        <>
          <div style={{ marginBottom: 8 }}>
            <WaButtons id={key} name={form.name} templates={templates} t={t} onTouched={() => { load(); onSaved(); }} />
          </div>
          <div className="grid-kpi">
            <Kpi label={t('累计消费')} value={fmtRM(spent)} sub={t('{n} 张单', { n: fmtNum(docs.filter((x) => n(x.amount) > 0).length) })} />
            <Kpi label={t('最后消费')} value={docs.length ? fmtDate(docs[0].doc_date) : '–'} sub={docs[0]?.sales_agent ? t('业务员 {a}', { a: docs[0].sales_agent }) : ''} />
          </div>

          <div className="lp-forms">
            <div className="lp-form">
              <h3>{t('基本资料')}</h3>
              <label>{t('名字')}</label>
              <input value={form.name} onChange={upd('name')} />
              <label>{t('生日(月 / 日)')}</label>
              <div className="lp-row">
                <select value={form.bm} onChange={upd('bm')}>
                  <option value="">{t('月')}</option>
                  {Array.from({ length: 12 }, (_, i) => <option key={i} value={i + 1}>{i + 1}</option>)}
                </select>
                <select value={form.bd} onChange={upd('bd')}>
                  <option value="">{t('日')}</option>
                  {Array.from({ length: 31 }, (_, i) => <option key={i} value={i + 1}>{i + 1}</option>)}
                </select>
              </div>
              <label>{t('类型')}</label>
              <select value={form.ctype} onChange={upd('ctype')}>
                <option value="">{t('请选择')}</option>
                {TYPES.map((x) => <option key={x} value={x}>{t(x)}</option>)}
              </select>
              <label>{t('同意收促销讯息')}</label>
              <select value={form.consent} onChange={upd('consent')}>
                <option value="">{t('未确认')}</option>
                <option value="yes">{t('同意')}</option>
                <option value="no">{t('不同意')}</option>
              </select>
              {p?.consent_at && (
                <div className="muted" style={{ fontSize: 12 }}>
                  {t('{w} 于 {d} 登记', { w: p.consent_by ?? '', d: new Date(p.consent_at).toLocaleDateString('en-MY') })}
                </div>
              )}
            </div>
            <div className="lp-form">
              <h3>&nbsp;</h3>
              <label>{t('地区(例:Skudai、Mount Austin、新加坡)')}</label>
              <input value={form.area} onChange={upd('area')} />
              <label>{t('地址(选填)')}</label>
              <input value={form.address} onChange={upd('address')} />
              <label>{t('备注(例:装修中、喜欢黑色款)')}</label>
              <textarea value={form.note} onChange={upd('note')} rows={3} />
              <label>{t('下次联络日期(到期会出现在跟进提醒)')}</label>
              <input type="date" value={form.next} onChange={upd('next')} />
              <button className="btn primary" disabled={busy} onClick={save}>{t('储存')}</button>
              {p?.updated_at && (
                <div className="muted" style={{ fontSize: 12 }}>
                  {t('上次修改')}: {new Date(p.updated_at).toLocaleString('en-MY')} {p.updated_by ?? ''}
                </div>
              )}
            </div>
          </div>
          {msg && <div className="notice" style={{ marginTop: 8 }}>{msg}</div>}

          <StageBox t={t} stage={p?.reno_stage ?? ''} since={p?.reno_stage_at ?? null} settings={settings}
                    categories={categories} onChange={setStage} />

          {(d.quotes ?? []).length > 0 && (
            <>
              <h3>{t('报价单({n} 张)', { n: fmtNum((d.quotes ?? []).length) })}</h3>
              <div className="table-scroll">
                <table className="data">
                  <thead>
                    <tr><th>{t('日期')}</th><th>{t('门市')}</th><th>{t('单号')}</th><th>{t('业务员')}</th><th>{t('内容')}</th>
                      <th className="num">{t('金额')}</th><th>{t('状态')}</th></tr>
                  </thead>
                  <tbody>
                    {(d.quotes ?? []).map((q) => (
                      <tr key={`${q.company}|${q.doc_no}`}>
                        <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(q.doc_date)}</td>
                        <td>{STORE[q.company] ?? q.company}</td>
                        <td style={{ whiteSpace: 'nowrap' }}>{q.doc_no}</td>
                        <td>{q.sales_agent}</td>
                        <td className="muted" style={{ fontSize: 12 }}>{q.items}</td>
                        <td className="num">{fmtNum(q.amount, 2)}</td>
                        <td style={{ whiteSpace: 'nowrap' }}>
                          {q.transferred ? t('已转单') : q.bought_after ? t('之后有买') : <b>{t('未成交')}</b>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          <h3>{t('购买历史({n} 张单)', { n: fmtNum(docs.length) })}</h3>
          <div className="table-scroll">
            <table className="data">
              <thead>
                <tr>
                  <th>{t('日期')}</th><th>{t('门市')}</th><th>{t('单号')}</th><th>{t('业务员')}</th><th className="num">{t('金额')}</th>
                </tr>
              </thead>
              <tbody>
                {docs.length === 0 && <tr><td colSpan={5} className="muted">{t('没有消费纪录')}</td></tr>}
                {docs.map((x) => {
                  const k = `${x.company}|${x.doc_type}|${x.doc_no}`;
                  return (
                    <Fragment key={k}>
                      <tr className="lp-click" onClick={() => setOpen(open === k ? null : k)}>
                        <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(x.doc_date)}</td>
                        <td>{STORE[x.company] ?? x.company}</td>
                        <td style={{ whiteSpace: 'nowrap' }}>{open === k ? '▾ ' : '▸ '}{x.doc_no}{x.doc_type === 'CN' ? ` (${t('退货')})` : ''}</td>
                        <td>{x.sales_agent}</td>
                        <td className={'num' + (n(x.amount) < 0 ? ' neg' : '')}>{fmtNum(x.amount, 2)}</td>
                      </tr>
                      {open === k && (
                        <tr>
                          <td colSpan={5} className="lp-items">
                            <table className="data">
                              <tbody>
                                {x.items.map((it, i) => (
                                  <tr key={i}>
                                    <td style={{ whiteSpace: 'nowrap' }}>{it.item_code ?? ''}</td>
                                    <td>{it.description}</td>
                                    <td className="num" style={{ whiteSpace: 'nowrap' }}>{fmtNum(it.qty)} {it.uom ?? ''}</td>
                                    <td className="num">{fmtNum(it.sub_total, 2)}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                            {x.debtor_name && <div className="muted" style={{ fontSize: 12 }}>{t('单上客户名称')}: {x.debtor_name} ({x.debtor_code})</div>}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          <MergeBox t={t} id={key} aliases={d.aliases ?? []} canManage={canManage}
                    onDone={(main) => { onSaved(); if (main !== key) onOpen(main); else load(); }} />
          <ChangeLog t={t} id={key} />
        </>
      )}
    </div>
  );
}

const FIELD_LABEL: Record<string, string> = {
  name: '名字', birth_month: '生日月', birth_day: '生日日', area: '地区', address: '地址', customer_type: '类型',
  note: '备注', consent: '同意收促销', next_contact: '下次联络', last_contact_at: '联络', reno_stage: '装修阶段',
};

function fmtVal(k: string, v: unknown, t: T): string {
  if (v == null || v === '') return '–';
  if (k === 'consent') return v === 'yes' ? t('同意') : v === 'no' ? t('不同意') : String(v);
  if (k === 'reno_stage') return t(STAGE_LABEL[String(v)] ?? String(v));
  if (k === 'last_contact_at') return new Date(String(v)).toLocaleString('en-MY');
  if (k === 'customer_type') return t(String(v));
  return String(v);
}

function StageBox({ t, stage, since, settings, categories, onChange }: {
  t: T; stage: string; since: string | null; settings: Settings; categories: string[]; onChange: (s: string) => void;
}) {
  const reco = settings.stage_reco?.[stage] ?? [];
  return (
    <div className="lp-box">
      <div className="lp-row" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
        <b>{t('装修进度')}</b>
        <div className="seg lp-stages">
          {STAGES.map(([k, v]) => (
            <button key={k} className={stage === k ? 'active' : ''} onClick={() => onChange(stage === k ? '' : k)}>{t(v)}</button>
          ))}
        </div>
        {since && <span className="muted" style={{ fontSize: 12 }}>{t('{d} 更新', { d: new Date(since).toLocaleDateString('en-MY') })}</span>}
      </div>
      {stage && reco.length > 0 && (
        <div style={{ fontSize: 13 }}>
          {t('这个阶段可以推荐:')}{' '}
          {reco.map((c) => (
            <span key={c} className={'lp-tag ' + (categories.includes(c) ? 'lp-tier-normal' : 'lp-tier-lead')} style={{ marginRight: 4 }}>
              {c}{categories.includes(c) ? ` ✓ ${t('买过')}` : ''}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function MergeBox({ t, id, aliases, canManage, onDone }: {
  t: T; id: string; aliases: string[]; canManage: boolean; onDone: (main: string) => void;
}) {
  const [other, setOther] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  if (!canManage && !aliases.length) return null;

  async function merge() {
    if (other.replace(/\D/g, '').length < 8 && !other.startsWith('A:')) { setMsg(t('请输入完整手机号')); return; }
    if (!window.confirm(t('把 {o} 的购买纪录与资料合并到 {m}?之后两个号码都会显示成同一位顾客(可以再取消合并)。', {
      o: other, m: fmtMember(id) }))) return;
    const r = await supabase.rpc('bi_customer_merge', { p_keep: id, p_drop: other });
    if (r.error) { setMsg(r.error.message); return; }
    setOther('');
    setMsg(t('已合并。'));
    onDone(id);
  }

  async function unmerge(a: string) {
    if (!window.confirm(t('取消合并 {a}?它的购买纪录会回到自己的号码(已合并过来的资料留在这里)。', { a: fmtMember(a) }))) return;
    const r = await supabase.rpc('bi_customer_unmerge', { p_alias: a });
    if (r.error) { setMsg(r.error.message); return; }
    setMsg(t('已取消合并。'));
    onDone(id);
  }

  return (
    <div className="lp-box">
      <b>{t('合并重复顾客')}</b>
      {aliases.length > 0 && (
        <div style={{ fontSize: 13 }}>
          {t('已合并进来的号码:')}{' '}
          {aliases.map((a) => (
            <span key={a} style={{ marginRight: 8 }}>
              {fmtMember(a)}{canManage && <button className="btn" style={{ marginLeft: 4 }} onClick={() => unmerge(a)}>{t('取消合并')}</button>}
            </span>
          ))}
        </div>
      )}
      {canManage && (
        <div className="lp-row">
          <input placeholder={t('同一个人的另一个电话')} value={other} onChange={(e) => setOther(e.target.value)} style={{ maxWidth: 220 }} />
          <button className="btn" onClick={merge}>{t('合并进来')}</button>
        </div>
      )}
      {msg && <div className="muted" style={{ fontSize: 13 }}>{msg}</div>}
    </div>
  );
}

function ChangeLog({ t, id }: { t: T; id: string }) {
  const [rows, setRows] = useState<LogRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  async function load() {
    const r = await supabase.rpc('bi_customer_log', { p_member: id });
    setErr(r.error ? r.error.message : null);
    setRows((r.data ?? []) as LogRow[]);
  }
  const act: Record<string, string> = { insert: '建档', update: '修改', delete: '删除', merge: '合并', unmerge: '取消合并' };
  return (
    <details onToggle={(e) => { if ((e.target as HTMLDetailsElement).open) load(); }} style={{ marginTop: 8 }}>
      <summary className="muted" style={{ fontSize: 13 }}>{t('修改纪录')}</summary>
      {err && <div className="notice">{t('查询失败:')}{err}</div>}
      {rows && rows.length === 0 && <div className="muted" style={{ fontSize: 13 }}>{t('还没有纪录')}</div>}
      {rows && rows.length > 0 && (
        <div className="table-scroll">
          <table className="data">
            <thead><tr><th>{t('时间')}</th><th>{t('谁')}</th><th>{t('动作')}</th><th>{t('内容')}</th></tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td style={{ whiteSpace: 'nowrap' }}>{new Date(r.at).toLocaleString('en-MY')}</td>
                  <td>{r.by}</td>
                  <td>{t(act[r.action] ?? r.action)}{r.member_id !== id ? ` (${fmtMember(r.member_id)})` : ''}</td>
                  <td style={{ fontSize: 12 }}>
                    {Object.entries(r.changes).map(([k, v]) => {
                      if (k === 'merged' || k === 'unmerged') return <div key={k}>{fmtMember(String(v))}</div>;
                      const [o, nv] = Array.isArray(v) ? v : [null, v];
                      return <div key={k}>{t(FIELD_LABEL[k] ?? k)}: {fmtVal(k, o, t)} → {fmtVal(k, nv, t)}</div>;
                    })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </details>
  );
}

/** 手机版快速登记:电话 + 名字 + 生日 + 同意 + 装修阶段,只写有填的栏位(bi_customer_quick) */
function QuickRegister({ t, onSaved, onOpen }: { t: T; onSaved: () => void; onOpen: (id: string) => void }) {
  const blank = { phone: '', name: '', bm: '', bd: '', consent: '', stage: '', area: '' };
  const [f, setF] = useState(blank);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; id?: string } | null>(null);
  const upd = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  async function save() {
    if (f.phone.replace(/\D/g, '').length < 8) { setMsg({ text: t('请输入完整手机号') }); return; }
    if (!!f.bm !== !!f.bd) { setMsg({ text: t('生日要月、日都填,或都不填') }); return; }
    setBusy(true);
    const r = await supabase.rpc('bi_customer_quick', {
      p_member: f.phone, p_name: f.name, p_birth_month: f.bm ? n(f.bm) : null, p_birth_day: f.bd ? n(f.bd) : null,
      p_consent: f.consent || null, p_reno_stage: f.stage || null, p_area: f.area,
    });
    setBusy(false);
    if (r.error) { setMsg({ text: r.error.message }); return; }
    const id = (r.data as { member_id: string }).member_id;
    setMsg({ text: t('已登记 {p}。', { p: fmtMember(id) }), id });
    setF(blank);
    onSaved();
  }

  return (
    <details className="card card-block lp-quick">
      <summary><h2 style={{ display: 'inline' }}>{t('快速登记')}</h2>
        <span className="muted" style={{ fontSize: 13 }}> {t('柜台 / 手机用,30 秒填完;只会补上有填的栏位')}</span></summary>
      <div className="lp-quick-grid">
        <label>{t('手机号码')}<input type="tel" inputMode="tel" value={f.phone} onChange={upd('phone')} placeholder="012-345 6789" /></label>
        <label>{t('名字')}<input value={f.name} onChange={upd('name')} /></label>
        <label>{t('生日(月 / 日)')}
          <span className="lp-row">
            <select value={f.bm} onChange={upd('bm')}>
              <option value="">{t('月')}</option>
              {Array.from({ length: 12 }, (_, i) => <option key={i} value={i + 1}>{i + 1}</option>)}
            </select>
            <select value={f.bd} onChange={upd('bd')}>
              <option value="">{t('日')}</option>
              {Array.from({ length: 31 }, (_, i) => <option key={i} value={i + 1}>{i + 1}</option>)}
            </select>
          </span>
        </label>
        <label>{t('同意收促销讯息')}
          <select value={f.consent} onChange={upd('consent')}>
            <option value="">{t('未确认')}</option>
            <option value="yes">{t('同意')}</option>
            <option value="no">{t('不同意')}</option>
          </select>
        </label>
        <label>{t('装修进度')}
          <select value={f.stage} onChange={upd('stage')}>
            <option value="">{t('不知道 / 不填')}</option>
            {STAGES.map(([k, v]) => <option key={k} value={k}>{t(v)}</option>)}
          </select>
        </label>
        <label>{t('地区')}<input value={f.area} onChange={upd('area')} /></label>
      </div>
      <div className="lp-row" style={{ marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="btn primary" disabled={busy} onClick={save}>{t('储存')}</button>
        {msg && <span className="muted" style={{ fontSize: 13 }}>{msg.text}</span>}
        {msg?.id && <button className="btn" onClick={() => onOpen(msg.id!)}>{t('打开这位顾客')}</button>}
      </div>
    </details>
  );
}

/** 顾客扫 QR 登记(2026-10-06 起送出即生效):列近 14 天扫码登记的顾客给店员跟进;改版前留下的待确认登记仍可确认 / 删掉 */
function Signups({ t, onDone, onOpen }: { t: T; onDone: () => void; onOpen: (id: string) => void }) {
  const [rows, setRows] = useState<Signup[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  async function load() {
    const r = await supabase.rpc('bi_customer_signups');
    setErr(r.error ? r.error.message : null);
    setRows((r.data ?? []) as Signup[]);
  }
  useEffect(() => { load(); }, []);

  async function handle(x: Signup, accept: boolean) {
    const r = await supabase.rpc('bi_customer_signup_handle', { p_id: x.id, p_accept: accept });
    if (r.error) { setErr(r.error.message); return; }
    await load();
    if (accept) onDone();
  }

  if (err) return <div className="notice">{t('查询失败:')}{err}</div>;
  if (!rows || rows.length === 0) return null;
  return (
    <details className="card card-block" open={rows.some((x) => x.status === 'pending')}>
      <summary><h2 style={{ display: 'inline' }}>{t('最近扫码登记的顾客({n} 位,近 14 天)', { n: rows.length })}</h2></summary>
      <p className="muted" style={{ fontSize: 13 }}>
        {t('顾客扫 QR 送出就直接存进顾客资料:已有的名字 / 生日不会被盖掉,地址、电邮与同意收促销以顾客填的为准;每笔改动都在顾客的「修改纪录」。可以在这里打 WhatsApp 欢迎新顾客。')}
      </p>
      <div className="table-scroll">
        <table className="data">
          <thead>
            <tr><th>{t('时间')}</th><th>{t('电话 / 账号')}</th><th>{t('名字')}</th><th>{t('生日')}</th><th>{t('地址')}</th>
              <th>{t('同意收促销')}</th><th>{t('门市')}</th><th>{t('状态')}</th></tr>
          </thead>
          <tbody>
            {rows.map((x) => (
              <tr key={x.id}>
                <td style={{ whiteSpace: 'nowrap' }}>{new Date(x.created_at).toLocaleString('en-MY')}</td>
                <td style={{ whiteSpace: 'nowrap' }} className="lp-click" onClick={() => onOpen(x.main_id)}>{fmtMember(x.member_id)}</td>
                <td>{x.name}{x.current?.name && x.current.name !== x.name
                  ? <div className="muted" style={{ fontSize: 12 }}>{t('现有:{n}', { n: x.current.name })}</div> : null}</td>
                <td>{x.birth_month ? `${x.birth_month}/${x.birth_day}` : ''}</td>
                <td style={{ fontSize: 12, maxWidth: 260 }}>
                  {x.address ?? x.area}
                  {x.email && <div className="muted">{x.email}</div>}
                </td>
                <td>{x.consent ? t('同意') : t('不同意')}</td>
                <td>{x.store}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  {x.status === 'pending' ? (
                    <>
                      <button className="btn primary" onClick={() => handle(x, true)}>{t('确认')}</button>
                      <button className="btn" onClick={() => handle(x, false)}>{t('不是本人 / 删掉')}</button>
                    </>
                  ) : (
                    <>
                      <span className="muted" style={{ fontSize: 12 }}>
                        {x.current?.last_contact_at ? t('已联络') : t('已登记')}{' '}
                      </span>
                      <button className="btn" onClick={() => onOpen(x.main_id)}>{t('打开这位顾客')}</button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function pct(a: number, b: number): string {
  return b ? `${((a / b) * 100).toFixed(0)}%` : '–';
}

function Campaigns({ t, isOwner, list, settings }: { t: T; isOwner: boolean; list: Customer[]; settings: Settings }) {
  const [rows, setRows] = useState<Campaign[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    const r = await supabase.rpc('bi_campaigns');
    setErr(r.error ? r.error.message : null);
    setRows((r.data ?? []) as Campaign[]);
  }
  useEffect(() => { load(); }, []);

  async function exportMembers(c: Campaign) {
    const r = await supabase.rpc('bi_campaign_members', { p_id: c.id });
    if (r.error) { setErr(r.error.message); return; }
    const byId = new Map(list.map((x) => [x.member_id, x]));
    const ids = (r.data ?? []) as string[];
    downloadCsv(`campaign_${c.id}_${c.sent_on}.csv`,
      [t('电话(WhatsApp)'), t('电话'), t('名字'), t('分级'), t('最后消费'), t('近 12 个月')],
      ids.map((id) => {
        const x = byId.get(id);
        return [waNumber(id), fmtMember(id), cleanName(x?.name), x ? t(TIER_LABEL[tierOf(x, settings)]) : '', x?.last_date ?? '',
          n(x?.spent_12m).toFixed(2)];
      }));
  }

  async function remove(c: Campaign) {
    if (!window.confirm(t('删除活动「{n}」?名单与成效纪录都会删掉。', { n: c.name }))) return;
    const r = await supabase.rpc('bi_campaign_delete', { p_id: c.id });
    if (r.error) { setErr(r.error.message); return; }
    load();
  }

  const today = localISO();
  const ended = (c: Campaign, days: number) => localISO(new Date(new Date(c.sent_on + 'T00:00:00').getTime() + days * 86400000)) <= today;

  return (
    <div className="card card-block">
      <h2>{t('促销活动')}</h2>
      <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
        {t('成效 = 名单上的顾客在发送日之后 30 / 60 天内来买的人数与金额(含没看到讯息自己来的,当参考)。在上面「顾客」筛好名单后按「用这份名单建立促销活动」。')}
      </p>
      {err && <div className="notice">{t('查询失败:')}{err}</div>}
      {rows === null && !err && <div className="loading">{t('载入中…')}</div>}
      {rows && (
        <div className="table-scroll">
          <table className="data">
            <thead>
              <tr>
                <th>{t('发送日期')}</th><th>{t('活动')}</th><th className="num">{t('名单')}</th>
                <th className="num">{t('30 天内来买')}</th><th className="num">{t('30 天营业额')}</th>
                <th className="num">{t('60 天内来买')}</th><th className="num">{t('60 天营业额')}</th><th />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={8} className="muted">{t('还没有活动')}</td></tr>}
              {rows.map((c) => (
                <tr key={c.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(c.sent_on)}</td>
                  <td>{c.name}{c.message && <div className="muted" style={{ fontSize: 12 }}>{c.message}</div>}</td>
                  <td className="num">{fmtNum(c.members)}</td>
                  <td className="num">
                    {fmtNum(c.buyers_30)} ({pct(n(c.buyers_30), n(c.members))}){ended(c, 30) ? '' : ` · ${t('进行中')}`}
                  </td>
                  <td className="num">{fmtNum(c.revenue_30, 2)}</td>
                  <td className="num">
                    {fmtNum(c.buyers_60)} ({pct(n(c.buyers_60), n(c.members))}){ended(c, 60) ? '' : ` · ${t('进行中')}`}
                  </td>
                  <td className="num">{fmtNum(c.revenue_60, 2)}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="btn" onClick={() => exportMembers(c)}>{t('汇出名单')}</button>
                    {isOwner && <button className="btn" onClick={() => remove(c)}>{t('删除')}</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function MonthlyReport({ t, settings }: { t: T; settings: Settings }) {
  const [rows, setRows] = useState<Monthly[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [month, setMonth] = useState('');
  const [agents, setAgents] = useState<Agent[] | null>(null);

  async function load() {
    const r = await supabase.rpc('bi_customer_monthly', { p_months: 12 });
    setErr(r.error ? r.error.message : null);
    const data = ((r.data ?? []) as Monthly[]).slice().reverse();
    setRows(data);
    if (data.length) pick(data[0].month);
  }

  async function pick(m: string) {
    setMonth(m);
    setAgents(null);
    const from = new Date(m.slice(0, 10) + 'T00:00:00');
    const to = new Date(from.getFullYear(), from.getMonth() + 1, 0);
    const r = await supabase.rpc('bi_customer_agents', { p_from: localISO(from), p_to: localISO(to) });
    if (r.error) { setErr(r.error.message); return; }
    setAgents((r.data ?? []) as Agent[]);
  }

  return (
    <details className="card card-block" onToggle={(e) => { if ((e.target as HTMLDetailsElement).open && rows === null) load(); }}>
      <summary><h2 style={{ display: 'inline' }}>{t('每月顾客报告')}</h2></summary>
      <p className="muted" style={{ fontSize: 13 }}>
        {t('新客 = 那个月第一次买;回头客 = 以前买过、那个月又来;流失 = 最后一次消费满 {l} 天、在那个月变成流失的人数。只算门市散客,本月是到今天为止。', {
          l: settings.lapsed_days })}
      </p>
      {err && <div className="notice">{t('查询失败:')}{err}</div>}
      {rows === null && !err && <div className="loading">{t('载入中…')}</div>}
      {rows && (
        <div className="table-scroll">
          <table className="data">
            <thead>
              <tr>
                <th>{t('月份')}</th><th className="num">{t('来买的顾客')}</th><th className="num">{t('新客')}</th>
                <th className="num">{t('回头客')}</th><th className="num">{t('回头客占比')}</th>
                <th className="num">{t('新客营业额')}</th><th className="num">{t('回头客营业额')}</th><th className="num">{t('流失')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.month} className={'lp-click' + (r.month === month ? ' lp-sel' : '')} onClick={() => pick(r.month)}>
                  <td>{r.month.slice(0, 7)}</td>
                  <td className="num">{fmtNum(r.active)}</td>
                  <td className="num">{fmtNum(r.new_customers)}</td>
                  <td className="num">{fmtNum(r.returning_customers)}</td>
                  <td className="num">{pct(n(r.returning_customers), n(r.active))}</td>
                  <td className="num">{fmtNum(r.new_revenue, 2)}</td>
                  <td className="num">{fmtNum(r.returning_revenue, 2)}</td>
                  <td className="num">{fmtNum(r.lapsed)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {month && (
        <>
          <h3>{t('{m} 各业务员的顾客', { m: month.slice(0, 7) })}</h3>
          {agents === null && <div className="loading">{t('载入中…')}</div>}
          {agents && (
            <div className="table-scroll">
              <table className="data">
                <thead>
                  <tr>
                    <th>{t('业务员')}</th><th className="num">{t('顾客')}</th><th className="num">{t('回头客')}</th>
                    <th className="num">{t('新客')}</th><th className="num">{t('营业额')}</th>
                  </tr>
                </thead>
                <tbody>
                  {agents.length === 0 && <tr><td colSpan={5} className="muted">{t('这个月没有门市散客的单')}</td></tr>}
                  {agents.map((a) => (
                    <tr key={a.agent}>
                      <td>{a.agent}</td>
                      <td className="num">{fmtNum(a.customers)}</td>
                      <td className="num">{fmtNum(a.returning_customers)}</td>
                      <td className="num">{fmtNum(a.new_customers)}</td>
                      <td className="num">{fmtNum(a.revenue, 2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </details>
  );
}

function SettingsPanel({ t, isOwner, settings, templates, onChanged }: {
  t: T; isOwner: boolean; settings: Settings; templates: Template[]; onChanged: () => void;
}) {
  const [s, setS] = useState({
    vip: String(settings.vip_min_12m), docs: String(settings.regular_min_docs), lapsed: String(settings.lapsed_days),
    lead: String(settings.lead_follow_days), bday: String(settings.birthday_days),
    quote: String(settings.quote_follow_days), qmax: String(settings.quote_max_days), stage: String(settings.stage_follow_days),
    reco: Object.fromEntries(STAGES.map(([k]) => [k, (settings.stage_reco?.[k] ?? []).join(', ')])) as Record<string, string>,
  });
  const [msg, setMsg] = useState<string | null>(null);
  const [edit, setEdit] = useState<Template | null>(null);
  useEffect(() => {
    setS({
      vip: String(settings.vip_min_12m), docs: String(settings.regular_min_docs), lapsed: String(settings.lapsed_days),
      lead: String(settings.lead_follow_days), bday: String(settings.birthday_days),
      quote: String(settings.quote_follow_days), qmax: String(settings.quote_max_days), stage: String(settings.stage_follow_days),
      reco: Object.fromEntries(STAGES.map(([k]) => [k, (settings.stage_reco?.[k] ?? []).join(', ')])) as Record<string, string>,
    });
  }, [settings]);

  async function saveSettings() {
    const r = await supabase.rpc('bi_customer_set_settings', {
      p_vip_min_12m: n(s.vip), p_regular_min_docs: n(s.docs), p_lapsed_days: n(s.lapsed),
      p_lead_follow_days: n(s.lead), p_birthday_days: n(s.bday),
      p_quote_follow_days: n(s.quote), p_quote_max_days: n(s.qmax), p_stage_follow_days: n(s.stage),
      p_stage_reco: Object.fromEntries(Object.entries(s.reco).map(([k, v]) => [k,
        v.split(/[,，\s]+/).map((x) => x.trim().toUpperCase()).filter(Boolean)])),
    });
    setMsg(r.error ? r.error.message : t('已储存。'));
    if (!r.error) onChanged();
  }

  async function saveTemplate() {
    if (!edit) return;
    const r = await supabase.rpc('bi_wa_template_save', { p_id: edit.id || null, p_title: edit.title, p_body: edit.body, p_sort: n(edit.sort) });
    setMsg(r.error ? r.error.message : t('已储存。'));
    if (!r.error) { setEdit(null); onChanged(); }
  }

  async function removeTemplate(x: Template) {
    if (!window.confirm(t('删除范本「{n}」?', { n: x.title }))) return;
    const r = await supabase.rpc('bi_wa_template_delete', { p_id: x.id });
    setMsg(r.error ? r.error.message : null);
    if (!r.error) onChanged();
  }

  const upd = (k: Exclude<keyof typeof s, 'reco'>) => (e: { target: { value: string } }) => setS({ ...s, [k]: e.target.value });
  const origin = typeof location !== 'undefined' ? location.origin : 'https://homeworks-bi.vercel.app';

  return (
    <details className="card card-block">
      <summary><h2 style={{ display: 'inline' }}>{t('设定:分级门槛与 WhatsApp 范本')}</h2></summary>
      {msg && <div className="notice" style={{ marginTop: 8 }}>{msg}</div>}
      <div className="lp-forms">
        <div className="lp-form">
          <h3>{t('分级与提醒')}</h3>
          <label>{t('VIP:近 12 个月消费至少 (RM)')}</label>
          <input value={s.vip} onChange={upd('vip')} inputMode="numeric" disabled={!isOwner} />
          <label>{t('常客:近 12 个月至少几张单')}</label>
          <input value={s.docs} onChange={upd('docs')} inputMode="numeric" disabled={!isOwner} />
          <label>{t('流失:超过几天没来')}</label>
          <input value={s.lapsed} onChange={upd('lapsed')} inputMode="numeric" disabled={!isOwner} />
          <label>{t('潜在客:建档几天没联络就提醒')}</label>
          <input value={s.lead} onChange={upd('lead')} inputMode="numeric" disabled={!isOwner} />
          <label>{t('生日:提前几天提醒')}</label>
          <input value={s.bday} onChange={upd('bday')} inputMode="numeric" disabled={!isOwner} />
          <label>{t('报价:开出几天还没成交就提醒')}</label>
          <input value={s.quote} onChange={upd('quote')} inputMode="numeric" disabled={!isOwner} />
          <label>{t('报价:超过几天就不再追')}</label>
          <input value={s.qmax} onChange={upd('qmax')} inputMode="numeric" disabled={!isOwner} />
          <label>{t('装修进度:几天没更新就提醒')}</label>
          <input value={s.stage} onChange={upd('stage')} inputMode="numeric" disabled={!isOwner} />
          <h3 style={{ marginTop: 12 }}>{t('各装修阶段推荐的类别')}</h3>
          <div className="muted" style={{ fontSize: 12 }}>{t('填 AutoCount 的 Item Group,用逗号分开,例:SANITARY, KITCHEN')}</div>
          {STAGES.map(([k, v]) => (
            <Fragment key={k}>
              <label>{t(v)}</label>
              <input value={s.reco[k] ?? ''} disabled={!isOwner}
                     onChange={(e) => setS({ ...s, reco: { ...s.reco, [k]: e.target.value } })} />
            </Fragment>
          ))}
          {isOwner ? <button className="btn primary" onClick={saveSettings}>{t('储存')}</button>
            : <div className="muted" style={{ fontSize: 12 }}>{t('只有老板可以改')}</div>}
        </div>
        <div className="lp-form" style={{ maxWidth: 560 }}>
          <h3>{t('WhatsApp 范本')}</h3>
          <div className="muted" style={{ fontSize: 12 }}>{t('内容里的 {name} 会换成顾客名字。')}</div>
          {templates.map((x) => (
            <div key={x.id} className="lp-tpl">
              <b>{x.title}</b>
              <div className="muted" style={{ fontSize: 12, whiteSpace: 'pre-wrap' }}>{x.body}</div>
              <div className="lp-row">
                <button className="btn" onClick={() => setEdit({ ...x })}>{t('修改')}</button>
                <button className="btn" onClick={() => removeTemplate(x)}>{t('删除')}</button>
              </div>
            </div>
          ))}
          {!edit && <button className="btn" onClick={() => setEdit({ id: 0, title: '', body: 'Hi {name}，', sort: templates.length + 1 })}>{t('新增范本')}</button>}
          {edit && (
            <div className="lp-box">
              <label>{t('标题(按钮上显示)')}</label>
              <input value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} />
              <label>{t('内容')}</label>
              <textarea rows={4} value={edit.body} onChange={(e) => setEdit({ ...edit, body: e.target.value })} />
              <label>{t('排序')}</label>
              <input value={String(edit.sort)} onChange={(e) => setEdit({ ...edit, sort: n(e.target.value) })} inputMode="numeric" />
              <div className="lp-row">
                <button className="btn primary" onClick={saveTemplate}>{t('储存')}</button>
                <button className="btn" onClick={() => setEdit(null)}>{t('取消')}</button>
              </div>
            </div>
          )}
        </div>
        <div className="lp-form">
          <h3>{t('顾客自己登记的 QR')}</h3>
          <div className="muted" style={{ fontSize: 12 }}>
            {t('把下面网址做成 QR 贴在柜台;顾客填完会出现在「顾客自己登记,待确认」,店员确认后才生效。')}
          </div>
          {['HQ', 'JB'].map((st) => (
            <div key={st} style={{ fontSize: 13 }}>
              <b>{st}</b>: <a href={`${origin}/join.html?s=${st}`} target="_blank" rel="noreferrer">{`${origin}/join.html?s=${st}`}</a>
            </div>
          ))}
        </div>
      </div>
    </details>
  );
}

function MissingPhone({ t }: { t: T }) {
  const [rows, setRows] = useState<Missing[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    const r = await supabase.rpc('bi_customer_missing_phone', { p_days: 60 });
    setErr(r.error ? r.error.message : null);
    setRows((r.data ?? []) as Missing[]);
  }

  return (
    <details className="card card-block" onToggle={(e) => { if ((e.target as HTMLDetailsElement).open && rows === null) load(); }}>
      <summary><h2 style={{ display: 'inline' }}>{t('没抓到电话的门市单据(近 60 天)')}</h2></summary>
      <p className="muted" style={{ fontSize: 13 }}>
        {t('这些单的客户名称没有手机号(或号码少一位),顾客不会出现在名单里。请在 AutoCount 把客户名称改成「名字 + 手机号」,隔天同步后就会补上。')}
      </p>
      {err && <div className="notice">{t('查询失败:')}{err}</div>}
      {rows === null && !err && <div className="loading">{t('载入中…')}</div>}
      {rows && (
        <div className="table-scroll">
          <table className="data">
            <thead>
              <tr><th>{t('日期')}</th><th>{t('门市')}</th><th>{t('单号')}</th><th>{t('单上客户名称')}</th><th>{t('业务员')}</th><th className="num">{t('金额')}</th></tr>
            </thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={6} className="muted">{t('全部都有电话 👍')}</td></tr>}
              {rows.map((x) => (
                <tr key={`${x.company}|${x.doc_type}|${x.doc_no}`}>
                  <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(x.doc_date)}</td>
                  <td>{STORE[x.company] ?? x.company}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>{x.doc_no}</td>
                  <td>{x.debtor_name} <span className="muted">({x.debtor_code})</span></td>
                  <td>{x.sales_agent}</td>
                  <td className="num">{fmtNum(x.amount, 2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </details>
  );
}
