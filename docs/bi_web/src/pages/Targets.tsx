import { useEffect, useMemo, useState } from 'react';
import { supabase, COMPANY, COMPANIES } from '../lib/supabase';
import { fmtRM, fmtDate } from '../lib/format';
import { useT } from '../lib/i18n';

// 「目标」分页:老板给每家公司(总目标)与每个渠道设定月目标,这里显示进度并预测月底能否达标。
// 资料:public.bi_targets_progress(security_invoker;店长只看到自己公司,没有成本 / 毛利栏)。
//   目标存在 bi.target_month,只能经 RPC bi_target_set / bi_target_copy_prev 写入(函数内检查 owner)。
// 注意:bi.app_setting 的 store_month_target 是「门店」分页的门市目标(门市现金 + B2B),跟这里的公司总目标无关,
//   这页只用一行字把它显示出来避免混淆,不读也不写它。

type Row = {
  company: string; month: string; scope: 'company' | 'channel'; scope_key: string; src: string;
  target: number | null; actual: number | null; pct: number | null;
  days_in_month: number; elapsed_days: number; remaining_days: number; as_of: string | null;
  proj_linear: number | null; proj_pct: number | null; proj_ly: number | null; proj_ly_pct: number | null;
  need_per_day: number | null; ly_full: number | null; ly_mtd: number | null; avg3: number | null;
  branch_actual: number | null; branch_as_of: string | null; branch_channel_actual: number | null;
  target_updated_at: string | null;
  // targets_fix1 加的栏位:预测用到哪一天、预测方法、分行电脑推送的是不是 0 张单
  proj_through: string | null;
  proj_method: 'linear' | 'avg3' | 'channels' | 'channels_avg3' | 'actual' | null;
  branch_empty: boolean | null;
};

const NUM_KEYS = ['target', 'actual', 'pct', 'proj_linear', 'proj_pct', 'proj_ly', 'proj_ly_pct', 'need_per_day',
  'ly_full', 'ly_mtd', 'avg3', 'branch_actual', 'branch_channel_actual'] as const;

// 渠道名与 bi.sale_channel() 的回传值一致(资料库值,不可翻译);显示时才经 t()
const CH_ORDER = ['门市现金', 'B2B客户', 'Shopee', 'Lazada', 'TikTok', '其他平台', '分行'];
// 实际已扣平台手续费(ONLINE 贷项)的渠道
const PLATFORM_CH = ['Shopee', 'Lazada', 'TikTok'];
const COMPANY_ORDER = Object.keys(COMPANIES);
// 灯号用固定色:线上 styles.css 的 --good 是浅蓝(#dbe8fa,跟 --accent 同色),不是绿色,不能拿来当绿灯
const GREEN = '#22c55e';
const YELLOW = '#f59e0b';

const toNum = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));
// 无条件舍去到整数:让文字跟灯号门槛一致(99.6% 显示 99%、配黄灯;不会出现「100%」配黄灯)。+1e-6 防浮点误差(0.29*100 = 28.999…)
const pctText = (x: number | null) => (x === null || !isFinite(x) ? '—' : `${Math.floor(x * 100 + 1e-6)}%`);
/** 'YYYY-MM-DD' → 日(数字) */
const dayOf = (d: string | null) => (d ? Number(d.slice(8, 10)) : null);
const rm = (x: number | null) => (x === null ? '—' : fmtRM(x));

/** 马来西亚时间的「本月」往后 offset 个月,回传 'YYYY-MM-01' */
function myMonth(offset = 0): string {
  const ym = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kuala_Lumpur', year: 'numeric', month: '2-digit' })
    .format(new Date()); // 例:2026-10
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + offset, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
}
const shiftMonth = (month: string, offset: number) => {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + offset, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
};

/** 输入金额:接受 1,500,000 / 1500000 / 1.5m / 800k / 80万;空白 = 0(= 删除目标)。看不懂回 null */
function parseAmount(s: string): number | null {
  const v = s.replace(/[,\s]/g, '').replace(/^RM/i, '');
  if (v === '') return 0;
  const m = v.match(/^(\d+(?:\.\d+)?)(k|m|万)?$/i);
  if (!m) return null;
  const mult = !m[2] ? 1 : m[2] === '万' ? 10000 : m[2].toLowerCase() === 'k' ? 1000 : 1000000;
  return Math.round(Number(m[1]) * mult * 100) / 100;
}

/** 灯号:预测达成率 ≥100% 绿、90～100% 黄、<90% 红 */
function light(p: number | null): { color: string; label: string } | null {
  if (p === null || !isFinite(p)) return null;
  if (p >= 1) return { color: GREEN, label: '可达标' };
  if (p >= 0.9) return { color: YELLOW, label: '接近' };
  return { color: 'var(--critical)', label: '落后' };
}

function Dot({ color }: { color: string }) {
  return <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 5, background: color, marginRight: 6, verticalAlign: 'middle' }} />;
}

/** 进度条:实心 = 达成率;细竖线 = 日历进度(已过天数 / 当月天数) */
function ProgressBar({ pct, pace, color }: { pct: number | null; pace?: number; color: string }) {
  const w = pct === null ? 0 : Math.max(0, Math.min(100, pct * 100));
  return (
    <div style={{ position: 'relative', height: 10, borderRadius: 5, background: 'var(--border)', overflow: 'hidden', minWidth: 60 }}>
      <div style={{ width: `${w}%`, height: '100%', background: color, borderRadius: 5 }} />
      {pace !== undefined && pace > 0 && pace < 1 && (
        <div style={{ position: 'absolute', top: 0, bottom: 0, left: `${pace * 100}%`, width: 2, background: 'var(--ink)', opacity: 0.6 }} />
      )}
    </div>
  );
}

const inputStyle = {
  background: 'var(--page)', color: 'var(--ink)', border: '1px solid var(--border)', borderRadius: 6,
  padding: '4px 8px', fontFamily: 'inherit', fontSize: 12.5, width: 110, boxSizing: 'border-box', textAlign: 'right',
} as const;

/** 目标金额输入框 + 储存(只有 canEdit 才会出现);储存后呼叫 onSaved 重新载入 */
function TargetInput({ company, month, scope, scopeKey, value, onSaved }: {
  company: string; month: string; scope: 'company' | 'channel'; scopeKey: string; value: number | null; onSaved: () => void;
}) {
  const t = useT();
  // 显示原值(到分),不四舍五入成整数:否则 1500000.50 会显示 1500001,没改也会让「储存」亮起
  const shown = value ? String(Math.round(value * 100) / 100) : '';
  const [v, setV] = useState(shown);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { setV(shown); setErr(null); }, [shown, month, company]);
  const parsed = parseAmount(v);
  // 「格式看不懂」跟「没改」分开:看不懂时直接在输入框旁提示,不要只是把储存按钮变灰
  const invalid = parsed === null;
  const dirty = parsed !== null && parsed !== (value ?? 0);

  async function save() {
    if (parsed === null) { setErr(t('看不懂这个金额')); return; }
    setBusy(true); setErr(null);
    const { error } = await supabase.rpc('bi_target_set', {
      p_company: company, p_month: month, p_scope: scope, p_scope_key: scopeKey, p_amount: parsed,
    });
    setBusy(false);
    if (error) { setErr(t('储存失败:{err}', { err: error.message })); return; }
    onSaved();
  }

  return (
    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
      <input style={inputStyle} inputMode="decimal" value={v} placeholder={t('未设定')}
             onChange={(e) => setV(e.target.value)}
             onKeyDown={(e) => { if (e.key === 'Enter' && dirty && !busy) save(); }}
             title={t('可输入 1500000、1.5m、800k 或 80万;清空后储存 = 删除目标')} />
      <button className="btn primary" style={{ padding: '3px 10px' }} disabled={!dirty || busy} onClick={save}>
        {busy ? t('储存中…') : t('储存')}
      </button>
      {invalid && <span className="err" style={{ fontSize: 12 }}>{t('看不懂这个金额')} · {t('可输入 1500000、1.5m、800k 或 80万')}</span>}
      {!invalid && err && <span className="err" style={{ fontSize: 12 }}>{err}</span>}
    </span>
  );
}

export default function Targets({ canEdit }: { canEdit: boolean }) {
  const t = useT();
  const [cur] = useState(() => myMonth(0));       // 马来西亚时间本月(挂载时冻结)
  const [sel, setSel] = useState(() => myMonth(0));
  const [rows, setRows] = useState<Row[] | null>(null);
  const [storeTarget, setStoreTarget] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [copyMsg, setCopyMsg] = useState<string | null>(null);
  const [copying, setCopying] = useState(false);

  const from = shiftMonth(cur, -6);
  const to = shiftMonth(cur, 1);
  const monthOptions = useMemo(() => {
    const list: string[] = [];
    for (let i = 1; i >= -6; i--) list.push(shiftMonth(cur, i));
    return list;
  }, [cur]);

  useEffect(() => {
    (async () => {
      // 一次取回:所有看得到的公司的「公司总目标」列 + 目前公司(COMPANY)的渠道列,近 6 个月到下个月
      const [p, s] = await Promise.all([
        supabase.from('bi_targets_progress').select('*')
          .gte('month', from).lte('month', to)
          .or(`scope.eq.company,company.eq.${COMPANY}`),
        supabase.from('bi_app_setting').select('value_num').eq('company', COMPANY).eq('key', 'store_month_target').maybeSingle(),
      ]);
      setErr(p.error ? p.error.message : null);
      const list = ((p.data ?? []) as Record<string, unknown>[]).map((r) => {
        const o = { ...r } as Record<string, unknown>;
        NUM_KEYS.forEach((k) => { o[k] = toNum(r[k]); });
        o.days_in_month = Number(r.days_in_month); o.elapsed_days = Number(r.elapsed_days); o.remaining_days = Number(r.remaining_days);
        return o as unknown as Row;
      });
      setRows(list);
      setStoreTarget(s.data?.value_num !== undefined && s.data?.value_num !== null ? Number(s.data.value_num) : null);
    })();
  }, [reload]);

  const mode: 'past' | 'current' | 'future' = sel < cur ? 'past' : sel > cur ? 'future' : 'current';

  const cards = useMemo(() => (rows ?? [])
    .filter((r) => r.scope === 'company' && r.month === sel)
    .sort((a, b) => {
      const ia = COMPANY_ORDER.indexOf(a.company), ib = COMPANY_ORDER.indexOf(b.company);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.company.localeCompare(b.company);
    }), [rows, sel]);

  const total = useMemo(() => (rows ?? []).find((r) => r.scope === 'company' && r.company === COMPANY && r.month === sel) ?? null, [rows, sel]);
  const channels = useMemo(() => (rows ?? [])
    .filter((r) => r.scope === 'channel' && r.company === COMPANY && r.month === sel)
    .sort((a, b) => {
      const ia = CH_ORDER.indexOf(a.scope_key), ib = CH_ORDER.indexOf(b.scope_key);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.scope_key.localeCompare(b.scope_key);
    }), [rows, sel]);

  // 近 6 个月历史(目前公司):公司总目标达成 + 渠道达标数
  const history = useMemo(() => {
    const list = rows ?? [];
    return monthOptions.filter((m) => m <= cur).map((m) => {
      const tot = list.find((r) => r.scope === 'company' && r.company === COMPANY && r.month === m);
      const chs = list.filter((r) => r.scope === 'channel' && r.company === COMPANY && r.month === m && r.target !== null);
      const hit = chs.filter((r) => (r.actual ?? 0) >= (r.target ?? 0)).length;
      return { month: m, tot, chTargets: chs.length, chHit: hit };
    });
  }, [rows, monthOptions, cur]);

  const chTargetSum = channels.reduce((s, r) => s + (r.target ?? 0), 0);
  const chTargetN = channels.filter((r) => r.target !== null).length;
  const reloadAll = () => setReload((x) => x + 1);

  // 对每一家看得到的公司各呼叫一次 bi_target_copy_prev(上个月没目标的公司回 source = 0,不算错误)
  async function copyPrev() {
    setCopying(true); setCopyMsg(null);
    const prev = shiftMonth(sel, -1);
    const parts: string[] = [];
    let any = false;
    for (const c of cards.map((r) => r.company)) {
      const { data, error } = await supabase.rpc('bi_target_copy_prev', { p_company: c, p_month: sel });
      const name = t(COMPANIES[c] ?? c);
      if (error) { parts.push(`${name}: ${error.message}`); continue; }
      const d = data as { source?: number; copied?: number; skipped?: number } | null;
      if (!d?.source) continue;
      any = true;
      parts.push(t('{c}:复制 {n} 笔,已存在 {s} 笔未覆盖', { c: name, n: d.copied ?? 0, s: d.skipped ?? 0 }));
    }
    setCopying(false);
    if (!any && !parts.length) parts.push(t('{m} 没有任何目标可以复制', { m: prev.slice(0, 7) }));
    setCopyMsg(parts.join(' · '));
    reloadAll();
  }

  if (rows === null) return <div className="loading">{t('载入中…')}</div>;
  if (err) return <div className="notice">{t('查询失败:{e}', { e: err })}</div>;
  if (rows.length === 0) {
    return <div className="notice">{t('看不到任何目标资料:这个帐号可能不在白名单,或销售资料还没同步。')}</div>;
  }

  const selLabel = (m: string) => m.slice(0, 7) + (m === cur ? ` ${t('(本月)')}` : m === shiftMonth(cur, -1) ? ` ${t('(上个月)')}` : m === shiftMonth(cur, 1) ? ` ${t('(下个月)')}` : '');
  const companyName = (c: string) => t(COMPANIES[c] ?? c);

  return (
    <>
      <div className="filters">
        <label className="muted">{t('月份')}</label>
        <select value={sel} onChange={(e) => { setSel(e.target.value); setCopyMsg(null); }}>
          {monthOptions.map((m) => <option key={m} value={m}>{selLabel(m)}</option>)}
        </select>
        {canEdit && (
          <button className="btn" disabled={copying} onClick={copyPrev}>
            {copying ? t('复制中…') : t('把上个月目标复制到 {m}', { m: sel.slice(0, 7) })}
          </button>
        )}
        {copyMsg && <span className="muted" style={{ fontSize: 12.5 }}>{copyMsg}</span>}
      </div>

      {/* ---------- 各分行本月 ---------- */}
      <div className="card-block">
        <h2 style={{ fontSize: 14, color: 'var(--muted)', margin: '0 0 8px', fontWeight: 600 }}>
          {mode === 'current' ? t('各分行本月进度') : mode === 'past' ? t('各分行 {m} 达成', { m: sel.slice(0, 7) }) : t('各分行 {m} 目标', { m: sel.slice(0, 7) })}
        </h2>
        <div className="grid-kpi" style={{ marginBottom: 0 }}>
          {cards.map((r) => {
            const shown = mode === 'past' ? r.pct : r.proj_pct;
            const lt = mode === 'future' ? null : light(shown);
            const pace = mode === 'current' && r.days_in_month ? r.elapsed_days / r.days_in_month : undefined;
            const barColor = lt ? lt.color : 'var(--accent)';
            return (
              <div key={r.company} className="card" style={{ padding: 14 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
                  <strong style={{ fontSize: 15 }}>{companyName(r.company)}</strong>
                  {lt && <span style={{ fontSize: 12.5 }}><Dot color={lt.color} />{t(lt.label)}</span>}
                </div>
                <div className="muted" style={{ fontSize: 12, margin: '6px 0 2px' }}>{t('目标')}</div>
                <div style={{ fontSize: 18, fontWeight: 650 }}>
                  {r.target !== null ? fmtRM(r.target) : <span className="muted" style={{ fontSize: 14, fontWeight: 400 }}>{t('未设定')}</span>}
                </div>
                {mode !== 'future' && (
                  <>
                    <div className="muted" style={{ fontSize: 12, margin: '8px 0 2px' }}>
                      {mode === 'current' ? t('至今') : t('实际')}
                      {r.as_of && mode === 'current' ? ` · ${t('资料截至 {d}', { d: fmtDate(r.as_of).slice(5) })}` : ''}
                    </div>
                    <div style={{ fontSize: 16, fontWeight: 600 }}>
                      {r.actual !== null ? fmtRM(r.actual) : <span className="muted" style={{ fontSize: 13, fontWeight: 400 }}>
                        {r.branch_empty
                          ? t('分行电脑有推送(推送于 {d}),但内容是 0 张单;如果不是真的没有业绩,请到分行电脑确认选的账套', { d: r.branch_as_of ? fmtDate(r.branch_as_of).slice(5) : '—' })
                          : r.src === 'branch' ? t('分行电脑还没有推送这个月的资料') : t('还没有资料')}</span>}
                      {r.target !== null && r.actual !== null && <span className="muted" style={{ fontSize: 12.5, fontWeight: 400 }}> · {pctText(r.pct)}</span>}
                    </div>
                    {r.target !== null && r.actual !== null && <div style={{ margin: '8px 0 4px' }}><ProgressBar pct={r.pct} pace={pace} color={barColor} /></div>}
                  </>
                )}
                {mode === 'current' && r.actual !== null && (
                  <div style={{ fontSize: 12.5, marginTop: 6, lineHeight: 1.6 }}>
                    <div>{t('预测月底')} <strong>{rm(r.proj_linear)}</strong>{r.target !== null && r.proj_linear !== null && <> · {pctText(r.proj_pct)}</>}</div>
                    {r.proj_linear === null
                      ? <div className="muted">{t('月初完整的资料还太少,暂不预测')}</div>
                      : r.proj_through && (
                        <div className="muted">
                          {r.proj_method === 'channels' || r.proj_method === 'channels_avg3'
                            ? t('各渠道预测相加,日均算到 {d} 号', { d: dayOf(r.proj_through) ?? '' })
                            : t('按 1～{d} 号的日均推算', { d: dayOf(r.proj_through) ?? '' })}
                          {r.proj_method === 'channels_avg3' && <> · {t('「分行」渠道(月中才开的集团内大单)按近 3 个月平均估')}</>}
                        </div>
                      )}
                    {r.proj_ly !== null && <div className="muted">{t('按去年同月走势')} {rm(r.proj_ly)}{r.target !== null && <> · {pctText(r.proj_ly_pct)}</>}</div>}
                    {r.need_per_day !== null && r.target !== null && (
                      <div>{(r.actual ?? 0) >= r.target ? <span style={{ color: GREEN }}>{t('已达标 ✅')}</span>
                        : t('剩 {d} 天,每天还需 {rm}', { d: r.remaining_days, rm: fmtRM(r.need_per_day) })}</div>
                    )}
                  </div>
                )}
                {mode === 'future' && r.target !== null && r.need_per_day !== null && (
                  <div className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>{t('平均每天需 {rm}', { rm: fmtRM(r.need_per_day) })}</div>
                )}
                <div className="muted" style={{ fontSize: 12, marginTop: 6, lineHeight: 1.5 }}>
                  {t('参考:去年同月 {a} · 近 3 个月平均 {b}', { a: rm(r.ly_full), b: rm(r.avg3) })}
                  {r.src === 'sales' && r.branch_actual !== null && (
                    <div>{t('分行电脑「实际销售」(SO 口径){rm},推送于 {d}', { rm: fmtRM(r.branch_actual), d: r.branch_as_of ? fmtDate(r.branch_as_of).slice(5) : '—' })}</div>
                  )}
                  {r.src === 'branch' && <div>{t('资料来自分行电脑推送的「实际销售」(SO + 非SO发票 − 贷项)')}</div>}
                  {(r.branch_channel_actual ?? 0) > 0 && (
                    <div>{t('其中卖给分行 {rm}(集团内)', { rm: fmtRM(r.branch_channel_actual) })}</div>
                  )}
                </div>
                {canEdit && (
                  <div style={{ marginTop: 8 }}>
                    <TargetInput company={r.company} month={sel} scope="company" scopeKey="ALL" value={r.target} onSaved={reloadAll} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {storeTarget !== null && (
        <p className="muted" style={{ fontSize: 12, margin: '0 0 12px' }}>
          {t('门店分页的门市目标:{rm}(只算门市现金 + B2B 客户,在门店分页使用,与这里的公司总目标不同)', { rm: fmtRM(storeTarget) })}
        </p>
      )}

      {/* ---------- 渠道目标 ---------- */}
      <div className="card card-block">
        <h2>{t('渠道目标')} · {companyName(COMPANY)} · {sel.slice(0, 7)}</h2>
        {channels.length === 0 ? (
          <div className="notice">{total?.src === 'branch'
            ? t('这家分行的资料来自分行电脑推送,只有公司总目标,没有渠道。')
            : t('这个月没有渠道资料。')}</div>
        ) : (
          <div className="table-scroll">
            <table className="data">
              <thead>
                <tr>
                  <th>{t('渠道')}</th>
                  <th className="num">{t('目标')}</th>
                  {mode !== 'future' && <th className="num">{mode === 'current' ? t('至今') : t('实际')}</th>}
                  {mode !== 'future' && <th style={{ minWidth: 110 }}>{t('达成率')}</th>}
                  {mode === 'current' && <th className="num">{t('预测月底')}</th>}
                  {mode === 'current' && <th className="num">{t('预测达成')}</th>}
                  {mode === 'current' && <th className="num">{t('按去年走势')}</th>}
                  {mode !== 'past' && <th className="num">{mode === 'current' ? t('每天还需') : t('平均每天需')}</th>}
                  <th className="num">{t('去年同月')}</th>
                  <th className="num">{t('近 3 个月平均')}</th>
                  {canEdit && <th>{t('设定目标')}</th>}
                </tr>
              </thead>
              <tbody>
                {channels.map((r) => {
                  const lt = mode === 'current' ? light(r.proj_pct) : mode === 'past' ? light(r.pct) : null;
                  const pace = mode === 'current' && r.days_in_month ? r.elapsed_days / r.days_in_month : undefined;
                  return (
                    <tr key={r.scope_key}>
                      <td>{t(r.scope_key)}</td>
                      <td className="num" style={{ fontWeight: 600 }}>{r.target !== null ? fmtRM(r.target) : <span className="muted" style={{ fontWeight: 400 }}>{t('未设定')}</span>}</td>
                      {mode !== 'future' && <td className={'num' + ((r.actual ?? 0) < 0 ? ' neg' : '')}>{rm(r.actual)}</td>}
                      {mode !== 'future' && (
                        <td>
                          {r.target !== null && r.actual !== null ? (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                              <div style={{ flex: 1 }}><ProgressBar pct={r.pct} pace={pace} color={lt ? lt.color : 'var(--accent)'} /></div>
                              <span style={{ fontSize: 12, minWidth: 36, textAlign: 'right' }}>{pctText(r.pct)}</span>
                            </div>
                          ) : <span className="muted">—</span>}
                        </td>
                      )}
                      {mode === 'current' && (
                        <td className="num">
                          {rm(r.proj_linear)}
                          {r.proj_method === 'avg3' ? (
                            <div className="muted" style={{ fontSize: 11 }}>{t('按近 3 个月平均')}</div>
                          ) : r.proj_linear !== null && r.proj_through && total?.proj_through && r.proj_through < total.proj_through ? (
                            <div className="muted" style={{ fontSize: 11 }}>{t('晚入账,算到 {d} 号', { d: dayOf(r.proj_through) ?? '' })}</div>
                          ) : null}
                        </td>
                      )}
                      {mode === 'current' && (
                        <td className="num">{lt ? <><Dot color={lt.color} />{pctText(r.proj_pct)}</> : <span className="muted">—</span>}</td>
                      )}
                      {mode === 'current' && <td className="num muted">{rm(r.proj_ly)}</td>}
                      {mode !== 'past' && (
                        <td className="num">{r.target === null ? <span className="muted">—</span>
                          : (r.actual ?? 0) >= r.target && mode === 'current' ? <span style={{ color: GREEN }}>{t('已达标')}</span>
                          : rm(r.need_per_day)}</td>
                      )}
                      <td className="num muted">{rm(r.ly_full)}</td>
                      <td className="num muted">{rm(r.avg3)}</td>
                      {canEdit && (
                        <td><TargetInput company={COMPANY} month={sel} scope="channel" scopeKey={r.scope_key} value={r.target} onSaved={reloadAll} /></td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
              {total && (
                <tfoot>
                  <tr style={{ fontWeight: 650 }}>
                    <td>{t('公司合计')}</td>
                    <td className="num">{total.target !== null ? fmtRM(total.target) : <span className="muted" style={{ fontWeight: 400 }}>{t('未设定')}</span>}</td>
                    {mode !== 'future' && <td className="num">{rm(total.actual)}</td>}
                    {mode !== 'future' && <td>{total.target !== null && total.actual !== null ? pctText(total.pct) : ''}</td>}
                    {mode === 'current' && <td className="num">{rm(total.proj_linear)}</td>}
                    {mode === 'current' && <td className="num">{total.target !== null ? pctText(total.proj_pct) : ''}</td>}
                    {mode === 'current' && <td className="num muted">{rm(total.proj_ly)}</td>}
                    {mode !== 'past' && <td className="num">{total.target !== null ? rm(total.need_per_day) : ''}</td>}
                    <td className="num muted">{rm(total.ly_full)}</td>
                    <td className="num muted">{rm(total.avg3)}</td>
                    {canEdit && <td />}
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        )}
        {channels.some((r) => PLATFORM_CH.includes(r.scope_key)) && (
          <p className="muted" style={{ fontSize: 12, margin: '8px 0 0' }}>
            {t('Shopee / Lazada / TikTok 的实际已扣平台手续费(ONLINE 贷项,每周或每月一笔,常事后补登、日期往回填),设目标请用同一口径;去年同月、近 3 个月平均也是扣过的。')}
          </p>
        )}
        {chTargetN > 0 && (
          <p className="muted" style={{ fontSize: 12, margin: '8px 0 0' }}>
            {t('已设 {n} 个渠道目标,合计 {a}', { n: chTargetN, a: fmtRM(chTargetSum) })}
            {total?.target !== null && total?.target !== undefined && Math.abs(chTargetSum - total.target) >= 1 && (
              <span style={{ color: YELLOW }}> · {t('与公司总目标 {b} 相差 {d}', { b: fmtRM(total.target), d: fmtRM(chTargetSum - total.target) })}</span>
            )}
          </p>
        )}
      </div>

      {/* ---------- 近 6 个月达成 ---------- */}
      <div className="card card-block">
        <h2>{t('近 6 个月达成')} · {companyName(COMPANY)}</h2>
        <div className="table-scroll">
          <table className="data">
            <thead>
              <tr>
                <th>{t('月份')}</th><th className="num">{t('公司目标')}</th><th className="num">{t('实际')}</th>
                <th style={{ minWidth: 110 }}>{t('达成率')}</th><th className="num">{t('渠道达标')}</th>
              </tr>
            </thead>
            <tbody>
              {history.map((h) => {
                const r = h.tot;
                const isCur = h.month === cur;
                const lt = r ? light(isCur ? r.proj_pct : r.pct) : null;
                return (
                  <tr key={h.month} style={h.month === sel ? { fontWeight: 650 } : undefined}>
                    <td>{h.month.slice(0, 7)}{isCur ? ` ${t('(至今)')}` : ''}</td>
                    <td className="num">{r?.target != null ? fmtRM(r.target) : <span className="muted">{t('未设定')}</span>}</td>
                    <td className="num">{rm(r?.actual ?? null)}</td>
                    <td>
                      {r && r.target !== null && r.actual !== null ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <div style={{ flex: 1 }}><ProgressBar pct={r.pct} color={lt ? lt.color : 'var(--accent)'} /></div>
                          <span style={{ fontSize: 12, minWidth: 36, textAlign: 'right' }}>{pctText(r.pct)}</span>
                        </div>
                      ) : <span className="muted">—</span>}
                    </td>
                    <td className="num">{h.chTargets ? `${h.chHit} / ${h.chTargets}` : <span className="muted">—</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <p className="muted" style={{ fontSize: 12 }}>
        {t('口径:实际 = 净销售(发票 + 现金单 − 贷项),渠道按客户代号分类,与门店分页相同;Shopee / Lazada / TikTok 已扣平台手续费;总部的公司合计含卖给分行的货。KL 等分行电脑推送的公司用「实际销售」(SO + 非SO发票 − 贷项)。')}
        {' '}{t('预测月底 = 到昨天为止的日均 × 当月天数:今天的单一天只同步 4 次、还没进完,不算进预测(「至今」有含);Shopee / Lazada / TikTok 的发票晚 2 天入账,算到各自最后有单的那天;「分行」渠道是月中才开的集团内大单,按「至今」与「近 3 个月平均」取大的估;公司合计 = 各渠道预测相加。')}
        {' '}{t('灯号:预测达成 ≥100% 绿、90～100% 黄、<90% 红;进度条上的细线 = 日历进度。')}
        {' '}{t('「按去年走势」= 至今 × 去年同月整月 ÷ 去年同月同期(公司合计把分行以外的渠道合起来算),月初或去年同期特别淡 / 旺时会偏离,仅供参考。数字每 2 小时更新一次。')}
      </p>
    </>
  );
}
