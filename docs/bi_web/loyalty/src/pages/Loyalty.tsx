import { Fragment, useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import { fmtRM, fmtNum, fmtDate } from '../lib/format';
import { Kpi } from '../components/ChartCard';
import { tr, type Lang } from '../lib/i18n';

// 顾客积分:门市散客用电话当会员号,总部 + JB 合并。积分由 bi.fact_sales 现算(public.bi_loyalty_* RPC,
// migration loyalty_points);兑换 / 调整存 bi.loyalty_txn。AutoCount 不写入:兑换后店员照常在 AutoCount 开单给折扣。

type Member = {
  member_id: string; name: string | null; stores: string | null; first_date: string; last_date: string;
  doc_count: number; spent: number; earned: number; returned: number; redeemed: number; adjusted: number;
  expired: number; balance: number; expiring_soon: number; next_expiry: string | null;
};
type Item = { item_code: string | null; description: string | null; qty: number; uom: string | null; sub_total: number };
type Doc = {
  company: string; doc_type: string; doc_no: string; doc_date: string; debtor_code: string; debtor_name: string | null;
  sales_agent: string | null; amount: number; points: number; items: Item[];
};
type Txn = {
  id: number; member_id: string; kind: 'redeem' | 'adjust'; points: number; rm_value: number | null; company: string | null;
  doc_no: string | null; note: string | null; created_at: string; created_by: string;
  voided_at: string | null; voided_by: string | null; void_reason: string | null;
};
type Settings = {
  start_date: string; earn_points_per_rm: number; redeem_points_per_rm: number; expiry_months: number;
  min_redeem_points: number; updated_at: string; updated_by: string | null;
};
type Summary = Pick<Member, 'member_id' | 'earned' | 'returned' | 'redeemed' | 'adjusted' | 'expired' | 'balance' | 'expiring_soon' | 'next_expiry'>;
type Detail = { member_id: string; summary: Summary | null; docs: Doc[]; txns: Txn[]; settings: Settings };
type Missing = {
  company: string; doc_type: string; doc_no: string; doc_date: string; debtor_code: string;
  debtor_name: string | null; sales_agent: string | null; amount: number;
};

const n = (v: unknown) => Number(v ?? 0);
const STORE: Record<string, string> = { HOMEWORKSSB: 'HQ', HOMEWORKSSOUTHERN: 'JB' };

/** 60123456789 → 012-345 6789;6591234567 → +65 9123 4567;A:公司:代号 → 账号 代号 */
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

export default function Loyalty({ lang, role, company }: { lang: Lang; role: string | null; company: string | null }) {
  const t = (zh: string, vars?: Record<string, string | number>) => tr(lang, zh, vars);
  const isOwner = role === 'owner';
  const canVoid = role === 'owner' || role === 'manager';

  const [settings, setSettings] = useState<Settings | null>(null);
  const [members, setMembers] = useState<Member[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<'recent' | 'points' | 'expiring'>('recent');
  const [shown, setShown] = useState(100);
  const [sel, setSel] = useState<string | null>(null);

  async function loadMembers() {
    const [m, s] = await Promise.all([
      supabase.rpc('bi_loyalty_members', { p_search: null, p_limit: 5000 }),
      supabase.rpc('bi_loyalty_settings'),
    ]);
    const e = m.error ?? s.error;
    setErr(e ? e.message : null);
    setMembers((m.data ?? []) as Member[]);
    if (s.data) setSettings(s.data as Settings);
  }
  useEffect(() => { loadMembers(); }, []);

  const filtered = useMemo(() => {
    const list = members ?? [];
    const text = q.trim().toLowerCase();
    const digits = q.replace(/\D/g, '');
    const hit = !text ? list : list.filter((m) =>
      (digits.length >= 4 && m.member_id.includes(digits.replace(/^0/, ''))) ||
      (m.name ?? '').toLowerCase().includes(text) ||
      m.member_id.toLowerCase().includes(text));
    const out = hit.slice();
    if (sort === 'points') out.sort((a, b) => n(b.balance) - n(a.balance));
    else if (sort === 'expiring') out.sort((a, b) => n(b.expiring_soon) - n(a.expiring_soon) || n(b.balance) - n(a.balance));
    else out.sort((a, b) => (a.last_date < b.last_date ? 1 : a.last_date > b.last_date ? -1 : 0));
    return out;
  }, [members, q, sort]);

  const perRM = n(settings?.redeem_points_per_rm) || 100;
  const totals = useMemo(() => {
    const list = members ?? [];
    return {
      count: list.length,
      active: list.filter((m) => n(m.balance) > 0).length,
      balance: list.reduce((s, m) => s + n(m.balance), 0),
      soon: list.reduce((s, m) => s + n(m.expiring_soon), 0),
    };
  }, [members]);

  if (members === null) return <div className="loading">{t('载入中…')}</div>;

  return (
    <>
      {err && <div className="notice">{t('查询失败:')}{err}</div>}

      {settings && (
        <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
          {t('规则:消费 RM1 = {e} 分 · {r} 分折抵 RM1 · 积分 {m} 个月后过期 · 从 {d} 起算 · 退货扣回积分', {
            e: fmtNum(settings.earn_points_per_rm, 0), r: fmtNum(settings.redeem_points_per_rm, 0),
            m: settings.expiry_months, d: fmtDate(settings.start_date),
          })}
          <br />
          {t('资料每天中午从 AutoCount 同步一次:今天买的,明天才看得到积分。开单时客户名称要写「名字 + 手机号」,顾客才拿得到积分。')}
        </p>
      )}

      <div className="grid-kpi">
        <Kpi label={t('会员人数')} value={fmtNum(totals.count)} sub={t('其中 {a} 人有积分', { a: fmtNum(totals.active) })} />
        <Kpi label={t('流通中积分')} value={fmtNum(totals.balance)} sub={t('约值 {v}', { v: fmtRM(totals.balance / perRM) })} />
        <Kpi label={t('60 天内到期')} value={fmtNum(totals.soon)} sub={t('约值 {v}', { v: fmtRM(totals.soon / perRM) })} />
      </div>

      {sel && (
        <MemberPanel
          key={sel} id={sel} t={t} isOwner={isOwner} canVoid={canVoid} company={company}
          onClose={() => setSel(null)} onChanged={loadMembers}
        />
      )}

      <div className="card card-block">
        <h2>{t('会员')}</h2>
        <div className="filters" style={{ marginBottom: 8 }}>
          <input
            placeholder={t('输入电话或名字')} value={q} inputMode="search"
            onChange={(e) => { setQ(e.target.value); setShown(100); }}
            style={{ minWidth: 220 }}
          />
          <div className="seg">
            <button className={sort === 'recent' ? 'active' : ''} onClick={() => setSort('recent')}>{t('最近消费')}</button>
            <button className={sort === 'points' ? 'active' : ''} onClick={() => setSort('points')}>{t('积分最多')}</button>
            <button className={sort === 'expiring' ? 'active' : ''} onClick={() => setSort('expiring')}>{t('快到期')}</button>
          </div>
          <span className="muted" style={{ fontSize: 13 }}>{t('{n} 位', { n: fmtNum(filtered.length) })}</span>
        </div>
        <div className="table-scroll">
          <table className="data">
            <thead>
              <tr>
                <th>{t('电话 / 账号')}</th><th>{t('名字')}</th><th>{t('门市')}</th><th>{t('最后消费')}</th>
                <th className="num">{t('累计消费')}</th><th className="num">{t('积分')}</th>
                <th className="num">{t('可折抵')}</th><th className="num">{t('60 天内到期')}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && <tr><td colSpan={8} className="muted">{t('找不到符合的会员')}</td></tr>}
              {filtered.slice(0, shown).map((m) => (
                <tr key={m.member_id} className="lp-click" onClick={() => { setSel(m.member_id); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>
                  <td style={{ whiteSpace: 'nowrap' }}>{fmtMember(m.member_id)}</td>
                  <td>{m.name}</td>
                  <td>{m.stores}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(m.last_date)}</td>
                  <td className="num">{fmtNum(m.spent, 2)}</td>
                  <td className="num" style={{ fontWeight: 600 }}>{fmtNum(m.balance)}</td>
                  <td className="num">{fmtNum(n(m.balance) / perRM, 2)}</td>
                  <td className={'num' + (n(m.expiring_soon) ? '' : ' muted')}>{n(m.expiring_soon) ? fmtNum(m.expiring_soon) : '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {filtered.length > shown && (
          <button className="btn" style={{ marginTop: 8 }} onClick={() => setShown(shown + 200)}>{t('显示更多')}</button>
        )}
      </div>

      <MissingPhone t={t} />

      {isOwner && settings && <SettingsEditor t={t} settings={settings} onSaved={loadMembers} />}
    </>
  );
}

type T = (zh: string, vars?: Record<string, string | number>) => string;

function MemberPanel({ id, t, isOwner, canVoid, company, onClose, onChanged }: {
  id: string; t: T; isOwner: boolean; canVoid: boolean; company: string | null;
  onClose: () => void; onChanged: () => void;
}) {
  const [d, setD] = useState<Detail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // 兑换表单
  const [pts, setPts] = useState('');
  const [store, setStore] = useState(company ?? '');
  const [docNo, setDocNo] = useState('');
  const [note, setNote] = useState('');
  // owner 手动调整
  const [adjPts, setAdjPts] = useState('');
  const [adjNote, setAdjNote] = useState('');

  async function load() {
    const r = await supabase.rpc('bi_loyalty_member', { p_member: id });
    if (r.error) { setErr(r.error.message); return; }
    setErr(null);
    setD(r.data as Detail);
  }
  useEffect(() => { load(); }, [id]);

  const s = d?.summary;
  const st = d?.settings;
  const perRM = n(st?.redeem_points_per_rm) || 100;
  const bal = n(s?.balance);
  const want = Math.floor(n(pts));
  const stores = Array.from(new Set((d?.docs ?? []).map((x) => STORE[x.company] ?? x.company))).sort().join(' + ');

  async function redeem() {
    if (!st) return;
    if (!want || want < n(st.min_redeem_points)) { setMsg(t('一次最少兑换 {m} 分', { m: st.min_redeem_points })); return; }
    if (want > bal) { setMsg(t('积分不足:目前只有 {b} 分', { b: fmtNum(bal) })); return; }
    if (!company && !store) { setMsg(t('请选择在哪一间门市兑换')); return; }
    const rm = fmtRM(want / perRM);
    if (!window.confirm(t('确认兑换 {p} 分 = 折抵 {rm}?\n兑换后请在 AutoCount 开单时给顾客 {rm} 折扣。', { p: fmtNum(want), rm }))) return;
    setBusy(true);
    const r = await supabase.rpc('bi_loyalty_redeem', {
      p_member: id, p_points: want, p_company: company ? null : store, p_doc_no: docNo || null, p_note: note || null,
    });
    setBusy(false);
    if (r.error) { setMsg(r.error.message); return; }
    setMsg(t('已兑换 {p} 分,折抵 {rm}。剩余 {b} 分。', { p: fmtNum(want), rm, b: fmtNum(n((r.data as { balance_after: number }).balance_after)) }));
    setPts(''); setDocNo(''); setNote('');
    await load();
    onChanged();
  }

  async function adjust() {
    const p = Math.trunc(n(adjPts));
    if (!p) { setMsg(t('调整分数不能是 0')); return; }
    if (!adjNote.trim()) { setMsg(t('手动调整一定要写原因')); return; }
    if (!window.confirm(t('确认调整 {p} 分?', { p: (p > 0 ? '+' : '') + fmtNum(p) }))) return;
    setBusy(true);
    const r = await supabase.rpc('bi_loyalty_adjust', { p_member: id, p_points: p, p_note: adjNote.trim() });
    setBusy(false);
    if (r.error) { setMsg(r.error.message); return; }
    setMsg(t('已调整。')); setAdjPts(''); setAdjNote('');
    await load();
    onChanged();
  }

  async function voidTxn(x: Txn) {
    const reason = window.prompt(t('作废这笔 {p} 分的纪录,原因?', { p: fmtNum(x.points) }));
    if (!reason || !reason.trim()) return;
    setBusy(true);
    const r = await supabase.rpc('bi_loyalty_void', { p_id: x.id, p_reason: reason.trim() });
    setBusy(false);
    if (r.error) { setMsg(r.error.message); return; }
    setMsg(t('已作废。'));
    await load();
    onChanged();
  }

  return (
    <div className="card card-block lp-panel">
      <div className="lp-head">
        <div>
          <h2 style={{ marginBottom: 2 }}>{d?.docs[0]?.debtor_name ?? fmtMember(id)}</h2>
          <div className="muted" style={{ fontSize: 13 }}>
            {fmtMember(id)}{stores ? ` · ${stores}` : ''}
            {d?.docs.length ? ` · ${t('首次消费')} ${fmtDate(d.docs[d.docs.length - 1].doc_date)}` : ''}
          </div>
        </div>
        <button className="btn" onClick={onClose}>{t('关闭')}</button>
      </div>

      {err && <div className="notice">{t('查询失败:')}{err}</div>}
      {!d && !err && <div className="loading">{t('载入中…')}</div>}

      {d && (
        <>
          <div className="grid-kpi">
            <Kpi label={t('积分余额')} value={fmtNum(bal)} sub={t('可折抵 {v}', { v: fmtRM(bal / perRM) })} />
            <Kpi label={t('累计赚到')} value={fmtNum(s?.earned)}
                 sub={t('退货扣 {r} · 已兑换 {u} · 过期 {x}', { r: fmtNum(s?.returned), u: fmtNum(s?.redeemed), x: fmtNum(s?.expired) })
                   + (n(s?.adjusted) ? ' · ' + t('调整 {a}', { a: fmtNum(s?.adjusted) }) : '')} />
            <Kpi label={t('60 天内到期')} value={fmtNum(s?.expiring_soon)}
                 sub={s?.next_expiry ? t('最早一批 {d} 到期', { d: fmtDate(s.next_expiry) }) : t('没有待到期的积分')} />
          </div>

          <div className="lp-forms">
            <div className="lp-form">
              <h3>{t('兑换积分')}</h3>
              <label>{t('兑换分数')}</label>
              <div className="lp-row">
                <input type="number" min={0} step={1} value={pts} onChange={(e) => setPts(e.target.value)} placeholder={String(st?.min_redeem_points ?? '')} />
                <button className="btn" type="button" onClick={() => setPts(String(Math.floor(bal / perRM) * perRM))}>{t('全部')}</button>
              </div>
              <div className="muted" style={{ fontSize: 13 }}>
                {want ? t('= 折抵 {v}', { v: fmtRM(want / perRM) }) : t('每 {r} 分折抵 RM1,一次最少 {m} 分', { r: fmtNum(perRM), m: fmtNum(st?.min_redeem_points) })}
              </div>
              {!company && (
                <>
                  <label>{t('兑换门市')}</label>
                  <select value={store} onChange={(e) => setStore(e.target.value)}>
                    <option value="">{t('请选择')}</option>
                    <option value="HOMEWORKSSB">HQ</option>
                    <option value="HOMEWORKSSOUTHERN">JB</option>
                  </select>
                </>
              )}
              <label>{t('AutoCount 单号(选填)')}</label>
              <input value={docNo} onChange={(e) => setDocNo(e.target.value)} placeholder="CS-000123" />
              <label>{t('备注(选填)')}</label>
              <input value={note} onChange={(e) => setNote(e.target.value)} />
              <button className="btn primary" disabled={busy || bal < n(st?.min_redeem_points)} onClick={redeem}>{t('确认兑换')}</button>
            </div>

            {isOwner && (
              <div className="lp-form">
                <h3>{t('手动调整(只有老板)')}</h3>
                <label>{t('分数(扣分写负数)')}</label>
                <input type="number" step={1} value={adjPts} onChange={(e) => setAdjPts(e.target.value)} placeholder="+500 / -200" />
                <label>{t('原因(必填)')}</label>
                <input value={adjNote} onChange={(e) => setAdjNote(e.target.value)} placeholder={t('例:补登漏掉的单、生日赠分')} />
                <button className="btn" disabled={busy} onClick={adjust}>{t('确认调整')}</button>
              </div>
            )}
          </div>
          {msg && <div className="notice" style={{ marginTop: 8 }}>{msg}</div>}

          <h3>{t('兑换 / 调整纪录')}</h3>
          <div className="table-scroll">
            <table className="data">
              <thead>
                <tr>
                  <th>{t('时间')}</th><th>{t('类型')}</th><th className="num">{t('分数')}</th><th className="num">{t('折抵')}</th>
                  <th>{t('门市')}</th><th>{t('单号')}</th><th>{t('经手人')}</th><th>{t('备注')}</th><th></th>
                </tr>
              </thead>
              <tbody>
                {d.txns.length === 0 && <tr><td colSpan={9} className="muted">{t('还没有兑换过')}</td></tr>}
                {d.txns.map((x) => (
                  <tr key={x.id} className={x.voided_at ? 'lp-void' : ''}>
                    <td style={{ whiteSpace: 'nowrap' }}>{new Date(x.created_at).toLocaleString('en-MY', { dateStyle: 'short', timeStyle: 'short' })}</td>
                    <td>{x.kind === 'redeem' ? t('兑换') : t('调整')}{x.voided_at ? ` (${t('已作废')})` : ''}</td>
                    <td className={'num' + (x.points < 0 ? ' neg' : '')}>{fmtNum(x.points)}</td>
                    <td className="num">{x.rm_value != null ? fmtNum(x.rm_value, 2) : ''}</td>
                    <td>{x.company ? STORE[x.company] ?? x.company : ''}</td>
                    <td>{x.doc_no}</td>
                    <td className="muted" style={{ fontSize: 12 }}>{x.created_by}</td>
                    <td>{x.voided_at ? `${t('作废原因')}: ${x.void_reason ?? ''}` : x.note}</td>
                    <td>{canVoid && !x.voided_at && <button className="btn" disabled={busy} onClick={() => voidTxn(x)}>{t('作废')}</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h3>{t('购买历史({n} 张单)', { n: fmtNum(d.docs.length) })}</h3>
          <div className="table-scroll">
            <table className="data">
              <thead>
                <tr>
                  <th>{t('日期')}</th><th>{t('门市')}</th><th>{t('单号')}</th><th>{t('业务员')}</th>
                  <th className="num">{t('金额')}</th><th className="num">{t('积分')}</th>
                </tr>
              </thead>
              <tbody>
                {d.docs.length === 0 && <tr><td colSpan={6} className="muted">{t('没有消费纪录')}</td></tr>}
                {d.docs.map((x) => {
                  const k = `${x.company}|${x.doc_type}|${x.doc_no}`;
                  return (
                    <Fragment key={k}>
                      <tr className="lp-click" onClick={() => setOpen(open === k ? null : k)}>
                        <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(x.doc_date)}</td>
                        <td>{STORE[x.company] ?? x.company}</td>
                        <td style={{ whiteSpace: 'nowrap' }}>{open === k ? '▾ ' : '▸ '}{x.doc_no}{x.doc_type === 'CN' ? ` (${t('退货')})` : ''}</td>
                        <td>{x.sales_agent}</td>
                        <td className={'num' + (n(x.amount) < 0 ? ' neg' : '')}>{fmtNum(x.amount, 2)}</td>
                        <td className={'num' + (n(x.points) < 0 ? ' neg' : '')}>{fmtNum(x.points)}</td>
                      </tr>
                      {open === k && (
                        <tr>
                          <td colSpan={6} className="lp-items">
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
        </>
      )}
    </div>
  );
}

function MissingPhone({ t }: { t: T }) {
  const [rows, setRows] = useState<Missing[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    const r = await supabase.rpc('bi_loyalty_missing_phone', { p_days: 60 });
    setErr(r.error ? r.error.message : null);
    setRows((r.data ?? []) as Missing[]);
  }

  return (
    <details className="card card-block" onToggle={(e) => { if ((e.target as HTMLDetailsElement).open && rows === null) load(); }}>
      <summary><h2 style={{ display: 'inline' }}>{t('没抓到电话的门市单据(近 60 天)')}</h2></summary>
      <p className="muted" style={{ fontSize: 13 }}>
        {t('这些单的客户名称没有手机号(或号码少一位),顾客拿不到积分。请在 AutoCount 把客户名称改成「名字 + 手机号」,隔天同步后积分就会补上。')}
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

function SettingsEditor({ t, settings, onSaved }: { t: T; settings: Settings; onSaved: () => void }) {
  const [earn, setEarn] = useState(String(settings.earn_points_per_rm));
  const [redeem, setRedeem] = useState(String(settings.redeem_points_per_rm));
  const [months, setMonths] = useState(String(settings.expiry_months));
  const [minR, setMinR] = useState(String(settings.min_redeem_points));
  const [start, setStart] = useState(fmtDate(settings.start_date));
  const [msg, setMsg] = useState<string | null>(null);

  async function save() {
    if (!window.confirm(t('改规则会让所有会员的积分重新计算,确定?'))) return;
    const r = await supabase.rpc('bi_loyalty_set_settings', {
      p_earn_points_per_rm: n(earn), p_redeem_points_per_rm: n(redeem), p_expiry_months: Math.trunc(n(months)),
      p_min_redeem_points: Math.trunc(n(minR)), p_start_date: start,
    });
    if (r.error) { setMsg(r.error.message); return; }
    setMsg(t('已储存。'));
    onSaved();
  }

  return (
    <details className="card card-block">
      <summary><h2 style={{ display: 'inline' }}>{t('积分规则(只有老板能改)')}</h2></summary>
      <div className="lp-form" style={{ maxWidth: 360 }}>
        <label>{t('每 RM1 得几分')}</label>
        <input type="number" step="0.1" min={0} value={earn} onChange={(e) => setEarn(e.target.value)} />
        <label>{t('几分折抵 RM1')}</label>
        <input type="number" step={1} min={1} value={redeem} onChange={(e) => setRedeem(e.target.value)} />
        <label>{t('积分几个月后过期')}</label>
        <input type="number" step={1} min={1} value={months} onChange={(e) => setMonths(e.target.value)} />
        <label>{t('一次最少兑换几分')}</label>
        <input type="number" step={1} min={1} value={minR} onChange={(e) => setMinR(e.target.value)} />
        <label>{t('从哪一天的消费开始算')}</label>
        <input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
        <button className="btn primary" onClick={save}>{t('储存')}</button>
        {msg && <div className="notice">{msg}</div>}
        <div className="muted" style={{ fontSize: 12 }}>
          {t('上次修改')}: {new Date(settings.updated_at).toLocaleString('en-MY')} {settings.updated_by ?? ''}
        </div>
      </div>
    </details>
  );
}
