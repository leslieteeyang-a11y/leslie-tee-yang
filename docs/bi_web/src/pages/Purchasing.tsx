import { Fragment, useEffect, useMemo, useState } from 'react';
import { supabase, COMPANY } from '../lib/supabase';
import { fmtRM, fmtDate, fmtNum } from '../lib/format';
import { useLang, useT } from '../lib/i18n';

type Suggest = {
  item_code: string; description: string; item_group: string | null; base_uom: string | null;
  q90: number; q90_branch_excl: number; q30: number; last_sale: string | null; daily_avg: number;
  on_hand: number; by_loc: string | null; transit_qty: number; transit_eta: string | null; transit_pos: string | null;
  supplier_code: string | null; supplier_name: string | null; last_po_name: string | null;
  last_price: number | null; last_po_date: string | null; po_24m: number | null;
  is_china: boolean; lead_days: number; safety_days: number; cover_days: number;
  min_order_qty: number | null; pack_size: number | null; exclude: boolean; item_note: string | null;
  last_receipt_date: string | null;
  action_id: number | null; action: string | null; action_qty: number | null; until_date: string | null;
  action_note: string | null; action_by: string | null; action_at: string | null;
  days_left: number | null; days_left_incl_transit: number | null; reorder_days: number; raw_qty: number;
  action_status: 'skip' | 'ordered' | null; need_order: boolean;
  urgency: 'out' | 'late' | 'now' | 'ok'; est_out_date: string; suggest_qty: number;
  q90_ly: number; daily_ly: number; fill_candidate: boolean;
  q365: number; daily_year: number; order_rate: number;
  item_type: string | null; cs_code: string | null;
  jb_reserved: number; owed_branch: number; branch_short: boolean;
};
type DueSup = { creditor_code: string; name: string; days_since_po: number | null; order_cycle_days: number | null };
type PoOpen = {
  po_no: string; po_date: string; creditor_code: string; supplier_name: string; is_china: boolean | null;
  item_code: string; description: string; item_group: string | null; location: string | null; uom: string | null;
  qty: number; transferred_qty: number; open_qty: number; unit_price: number | null; open_amt: number;
  expected_date: string; days_open: number; overdue: boolean; stale: boolean;
};
type Supplier = {
  creditor_code: string; name: string; currency: string | null; is_active: boolean | null; po_name: string | null;
  po_24m: number | null; last_po: string | null; n_rcv: number | null; hist_lead_days: number | null;
  is_china: boolean; lead_days: number; safety_days: number; cover_days: number;
  lead_override: number | null; safety_override: number | null; cover_override: number | null; china_override: boolean | null;
  note: string | null; updated_by: string | null; updated_at: string | null;
  order_cycle_days: number | null; order_due: boolean | null; days_since_po: number | null; short_pct: number | null;
};

// 显示时再经 t() 翻译,这里保留中文作字典键
const URG_LABEL: Record<string, string> = { out: '已断货', late: '来不及', now: '该下单', ok: '正常' };
const URG_CLASS: Record<string, string> = { out: 'urg-out', late: 'urg-late', now: 'urg-now', ok: 'urg-ok' };
const inputStyle = {
  background: 'var(--page)', color: 'var(--ink)', border: '1px solid var(--border)',
  borderRadius: 6, padding: '4px 6px', fontFamily: 'inherit', fontSize: 12.5,
} as const;

function todayPlus(days: number) {
  const d = new Date(); d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

/* ---------------- 补货建议 ---------------- */
function SuggestTab({ canWrite }: { canWrite: boolean }) {
  const t = useT();
  const { lang } = useLang(); // useT 每次 render 回新函数,memo 依赖改用 lang
  const [rows, setRows] = useState<Suggest[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [minQ, setMinQ] = useState(30);
  const [scope, setScope] = useState<'need' | 'all'>('need');
  const [showHandled, setShowHandled] = useState(false);
  const [q, setQ] = useState('');
  const [supFilter, setSupFilter] = useState('');
  const [qtyEdit, setQtyEdit] = useState<Record<string, string>>({});
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [openSetting, setOpenSetting] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [fillOpen, setFillOpen] = useState<Set<string>>(new Set());
  const [groupBy, setGroupBy] = useState<'sup' | 'brand'>('brand'); // 品牌=中国厂,是真正的供应商;户口只是开单公司
  const [csFilter, setCsFilter] = useState('');
  const [owedOnly, setOwedOnly] = useState(false); // 只看分行预定但我们未有货的
  const keyOf = (r: Suggest) => groupBy === 'brand' ? (r.item_type ?? '(无品牌)') : (r.supplier_code ?? '(none)');
  const nameOf = (r: Suggest) => groupBy === 'brand' ? (r.item_type ?? t('(无品牌)')) : (r.supplier_name ?? t('未知供应商(无采购记录)'));

  const [dueSups, setDueSups] = useState<DueSup[]>([]);
  useEffect(() => {
    (async () => {
      setRows(null);
      // 全量取(含"正常"状态)——凑柜清单需要不紧急但快要补的商品
      const [a, b] = await Promise.all([
        supabase.from('bi_purchase_suggest').select('*').eq('company', COMPANY).eq('exclude', false)
          .or(`q90.gte.${minQ},owed_branch.gt.0`)
          .order('days_left', { nullsFirst: true }).limit(1000),
        supabase.from('bi_supplier').select('creditor_code,name,days_since_po,order_cycle_days').eq('company', COMPANY).eq('order_due', true),
      ]);
      setErr(a.error ? a.error.message : null);
      setRows((a.data ?? []) as Suggest[]);
      setDueSups((b.data ?? []) as DueSup[]);
    })();
  }, [minQ, tick]);

  const shown = useMemo(() => {
    if (!rows) return [];
    const k = q.trim().toLowerCase();
    return rows.filter((r) =>
      (!owedOnly || Number(r.owed_branch) > 0) &&
      (scope === 'all' || r.urgency !== 'ok') &&
      (showHandled || !r.action_status) &&
      (!supFilter || (r.supplier_code ?? '(none)') === supFilter) &&
      (!csFilter || r.cs_code === csFilter) &&
      (!k || r.item_code.toLowerCase().includes(k) || r.description.toLowerCase().includes(k)));
  }, [rows, q, supFilter, showHandled, scope, csFilter, owedOnly]);

  const csList = useMemo(() => {
    const s = new Set<string>();
    for (const r of rows ?? []) if (r.cs_code) s.add(r.cs_code);
    return [...s].sort((a, b) => Number(a.replace('CS', '')) - Number(b.replace('CS', '')));
  }, [rows]);

  // 凑柜候选:同组、不紧急但 30 天内也要补的商品(仅"需要处理"视角下展示)
  const fillMap = useMemo(() => {
    const m = new Map<string, Suggest[]>();
    if (scope === 'all' || !rows) return m;
    const k = q.trim().toLowerCase();
    for (const r of rows) {
      if (!r.fill_candidate || r.action_status) continue;
      if (csFilter && r.cs_code !== csFilter) continue;
      if (k && !r.item_code.toLowerCase().includes(k) && !r.description.toLowerCase().includes(k)) continue;
      const key = keyOf(r);
      const l = m.get(key) ?? []; l.push(r); m.set(key, l);
    }
    return m;
  }, [rows, scope, q, csFilter, groupBy]);

  const suppliers = useMemo(() => {
    const m = new Map<string, { name: string; n: number }>();
    for (const r of rows ?? []) {
      const key = r.supplier_code ?? '(none)';
      const cur = m.get(key) ?? { name: r.supplier_name ?? t('未知供应商'), n: 0 };
      cur.n++; m.set(key, cur);
    }
    return [...m.entries()].sort((a, b) => b[1].n - a[1].n);
  }, [rows, lang]);

  const groups = useMemo(() => {
    const m = new Map<string, { name: string; china: boolean; billers: Set<string>; css: Set<string>; rows: Suggest[] }>();
    for (const r of shown) {
      const key = keyOf(r);
      const g = m.get(key) ?? { name: nameOf(r), china: r.is_china, billers: new Set<string>(), css: new Set<string>(), rows: [] };
      g.rows.push(r);
      if (groupBy === 'brand' && r.supplier_name && !r.supplier_name.includes('未指定')) g.billers.add(r.supplier_name);
      if (r.cs_code) g.css.add(r.cs_code);
      m.set(key, g);
    }
    // 紧急的排前面:按 out/late 数量
    const score = (rs: Suggest[]) => rs.filter((r) => r.urgency !== 'ok').length * 1000 + rs.length;
    return [...m.entries()].sort((a, b) => score(b[1].rows) - score(a[1].rows));
  }, [shown, groupBy, lang]);

  const qtyOf = (r: Suggest) => Number(qtyEdit[r.item_code] ?? r.suggest_qty);

  async function act(item: string, action: 'ordered' | 'skip' | 'note', qty: number | null, until: string | null, note: string | null) {
    setBusy(item);
    const { error } = await supabase.rpc('bi_add_item_action', {
      p_item_code: item, p_action: action, p_qty: qty, p_until_date: until, p_note: note, p_company: COMPANY,
    });
    setBusy(null);
    if (error) { window.alert(t('保存失败: ') + error.message); return; }
    setTick((t) => t + 1);
  }
  async function undo(id: number) {
    const { error } = await supabase.rpc('bi_delete_item_action', { p_id: id });
    if (error) { window.alert(t('撤销失败: ') + error.message); return; }
    setTick((t) => t + 1);
  }

  function whatsappRows(list: Suggest[], supplierName: string) {
    const d = new Date();
    const head = t('{sup} 订货 {d}/{m}:', { sup: supplierName, d: d.getDate(), m: d.getMonth() + 1 });
    const lines = list.map((r, i) => `${i + 1}. ${r.description} (${r.item_code}) ×${fmtNum(qtyOf(r))}${r.base_uom ? ' ' + r.base_uom : ''}`);
    const txt = [head, ...lines].join('\n');
    navigator.clipboard?.writeText(txt).then(
      () => window.alert(t('已复制 {n} 行 WhatsApp 格式,直接粘贴发给供应商', { n: list.length })),
      () => window.alert(t('复制失败')));
  }

  function exportRows(list: Suggest[], supplierName: string) {
    const head = [t('商品编码'), t('商品名称'), t('单位'), t('现存'), t('在途'), t('日均销量'), t('还能卖(天)'), t('建议订量'), t('上次单价'), t('供应商')];
    const lines = list.map((r) => [r.item_code, r.description, r.base_uom ?? '', r.on_hand, r.transit_qty, r.daily_avg,
      r.days_left ?? '', qtyOf(r), r.last_price ?? '', r.supplier_name ?? '']);
    const tsv = [head, ...lines].map((a) => a.join('\t')).join('\n');
    navigator.clipboard?.writeText(tsv).then(
      () => window.alert(t('已复制 {n} 行到剪贴板(可直接贴到 Excel / WhatsApp)', { n: list.length })),
      () => window.alert(t('复制失败,请用下载'))
    );
    const csv = '﻿' + [head, ...lines].map((a) => a.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${t('订货单')}-${supplierName.replace(/[\\/:*?"<>|]/g, '_')}-${todayPlus(0)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  const totalNeed = (rows ?? []).filter((r) => r.urgency !== 'ok' && !r.action_status).length;
  const totalAmt = shown.reduce((s, r) => s + qtyOf(r) * Number(r.last_price ?? 0), 0);

  return (
    <>
      <div className="filters">
        <div className="seg">
          <button className={scope === 'need' ? 'active' : ''} onClick={() => setScope('need')}>{t('需要处理')}</button>
          <button className={scope === 'all' ? 'active' : ''} onClick={() => setScope('all')}>{t('全部走量品')}</button>
        </div>
        <div className="seg">
          <button className={groupBy === 'brand' ? 'active' : ''} onClick={() => setGroupBy('brand')}>{t('按品牌(厂)')}</button>
          <button className={groupBy === 'sup' ? 'active' : ''} onClick={() => setGroupBy('sup')}>{t('按开单公司')}</button>
        </div>
        {csList.length > 0 && (
          <select value={csFilter} onChange={(e) => setCsFilter(e.target.value)}>
            <option value="">{t('全部 CS 厂号')}</option>
            {csList.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        )}
        <label className="muted">{t('走量门槛')}</label>
        <select value={minQ} onChange={(e) => setMinQ(Number(e.target.value))}>
          <option value={10}>{t('90 天 ≥{n} 件', { n: 10 })}</option>
          <option value={30}>{t('90 天 ≥{n} 件', { n: 30 })}</option>
          <option value={100}>{t('90 天 ≥{n} 件', { n: 100 })}</option>
        </select>
        <select value={supFilter} onChange={(e) => setSupFilter(e.target.value)}>
          <option value="">{t('全部供应商')}</option>
          {suppliers.map(([k, v]) => <option key={k} value={k}>{v.name} ({v.n})</option>)}
        </select>
        <input placeholder={t('搜索商品编码 / 名称…')} value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="muted" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input type="checkbox" checked={showHandled} onChange={(e) => setShowHandled(e.target.checked)} />{t('显示已处理')}
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#f59e0b', fontSize: 13 }}>
          <input type="checkbox" checked={owedOnly} onChange={(e) => setOwedOnly(e.target.checked)} />
          {t('只看欠分行未有货({n})', { n: (rows ?? []).filter((r) => Number(r.owed_branch) > 0).length })}
        </label>
        <span className="muted">{t('待处理')} <strong className="neg">{totalNeed}</strong> {t('项 · 当前显示 {m} 项 · 建议采购额约 {amt}', { m: shown.length, amt: fmtRM(totalAmt) })}</span>
      </div>

      {err && <div className="notice">{t('查询失败:')}{err}</div>}
      {dueSups.length > 0 && (
        <div className="notice" style={{ borderColor: '#f59e0b' }}>
          {t('🔔 按订货周期,这几家该下单了:')}{dueSups.map((s) => t('{name}(距上次 {d} 天/周期 {c} 天)', { name: s.name, d: s.days_since_po ?? '?', c: s.order_cycle_days ?? '?' })).join(' · ')}
        </div>
      )}
      {rows === null ? <div className="loading">{t('载入中…')}</div> : groups.length === 0 ? (
        <div className="card"><p className="muted" style={{ margin: 0 }}>{t('没有需要处理的商品 👍')}</p></div>
      ) : groups.map(([key, g]) => {
        const isCollapsed = collapsed.has(key);
        const fill = fillMap.get(key) ?? [];
        const candidates = [...g.rows, ...fill];
        const sel = candidates.filter((r) => checked.has(r.item_code));
        const exportList = sel.length ? sel : g.rows;
        return (
          <div className="card card-block" key={key}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span style={{ cursor: 'pointer' }} className="muted" onClick={() => {
                const s = new Set(collapsed); isCollapsed ? s.delete(key) : s.add(key); setCollapsed(s);
              }}>{isCollapsed ? '▸' : '▾'}</span>
              <h2 style={{ margin: 0 }}>{g.name}</h2>
              {g.css.size > 0 && <span className="badge ok">{[...g.css].join(' / ')}</span>}
              {g.china && <span className="muted" style={{ fontSize: 12 }}>{t('中国厂 · 交期 {d} 天', { d: g.rows[0].lead_days })}</span>}
              {!g.china && <span className="muted" style={{ fontSize: 12 }}>{t('交期 {d} 天 + 安全 {s} 天', { d: g.rows[0].lead_days, s: g.rows[0].safety_days })}</span>}
              {groupBy === 'brand' && g.billers.size > 0 && (
                <span className="muted" style={{ fontSize: 11 }}>{t('开单:')}{[...g.billers].slice(0, 2).join(t('、'))}{g.billers.size > 2 ? '…' : ''}</span>
              )}
              <span className="badge fail">{t('{n} 项紧急', { n: g.rows.filter((r) => r.urgency !== 'ok').length })}</span>
              <span className="muted" style={{ fontSize: 12 }}>{t('共 {n} 项 · 约 {amt}', { n: g.rows.length, amt: fmtRM(g.rows.reduce((s, r) => s + qtyOf(r) * Number(r.last_price ?? 0), 0)) })}</span>
              <span style={{ flex: 1 }} />
              <button className="btn" onClick={() => whatsappRows(exportList, g.name)}>📱 WhatsApp</button>
              <button className="btn" onClick={() => exportRows(exportList, g.name)}>
                {t('📋 导出订货单')}{sel.length ? t('(已勾选 {n})', { n: sel.length }) : t('(全部)')}
              </button>
            </div>
            {!isCollapsed && (
              <div className="table-scroll" style={{ marginTop: 10 }}>
                <table className="data">
                  <thead><tr>
                    <th></th><th>{t('商品')}</th><th className="num">{t('现存')}</th><th className="num">{t('在途')}</th>
                    <th className="num">{t('日均')}</th><th className="num">{t('还能卖')}</th><th>{t('状态')}</th>
                    <th className="num">{t('建议订量')}</th><th className="num">{t('上次单价')}</th>{canWrite && <th>{t('操作')}</th>}
                  </tr></thead>
                  <tbody>
                    {g.rows.map((r) => (
                      <Fragment key={r.item_code}>
                        <tr style={r.action_status ? { opacity: 0.55 } : undefined}>
                          <td><input type="checkbox" checked={checked.has(r.item_code)} onChange={(e) => {
                            const s = new Set(checked); e.target.checked ? s.add(r.item_code) : s.delete(r.item_code); setChecked(s);
                          }} /></td>
                          <td title={`${r.item_code}${r.by_loc ? ' · ' + r.by_loc : ''}${r.last_receipt_date ? ' · ' + t('最后进货') + ' ' + fmtDate(r.last_receipt_date) : ''}`}>
                            {r.description}
                            <div className="muted" style={{ fontSize: 11 }}>
                              {r.item_code}{r.item_group ? ` · ${r.item_group}` : ''}
                              {r.by_loc ? ` · ${r.by_loc}` : ''}
                              {r.q90_branch_excl > 0 ? ' · ' + t('分行预定 {n} 件已剔除', { n: fmtNum(r.q90_branch_excl) }) : ''}
                              {r.last_po_name && r.last_po_name !== r.supplier_name ? ' · ' + t('上次 PO: ') + r.last_po_name : ''}
                            </div>
                          </td>
                          <td className={'num' + (Number(r.on_hand) <= 0 ? ' neg' : '')} style={{ fontWeight: 600 }}>
                            {fmtNum(r.on_hand)}
                            {Number(r.owed_branch) > 0 && <div className="neg" style={{ fontSize: 11, fontWeight: 600 }}>{t('欠分行 {n}', { n: fmtNum(r.owed_branch) })}</div>}
                            {Number(r.jb_reserved) > 0 && <div className="muted" style={{ fontSize: 11 }}>{t('JB 留 {n}', { n: fmtNum(r.jb_reserved) })}</div>}
                          </td>
                          <td className="num" title={r.transit_pos ?? ''}>
                            {Number(r.transit_qty) > 0 ? <>{fmtNum(r.transit_qty)}<div className="muted" style={{ fontSize: 11 }}>{fmtDate(r.transit_eta)}</div></> : <span className="muted">—</span>}
                          </td>
                          <td className="num">{Number(r.daily_avg).toFixed(1)}
                            <div className="muted" style={{ fontSize: 11 }} title={t('订货量按年均日销(近一年÷上市天数)与去年同期未来窗口取较大——近 90 天只用于断货预警,避免旺季 3 个月把订量抬虚')}>{t('订货按 {r}/天', { r: Number(r.order_rate).toFixed(2) })}</div>
                          </td>
                          <td className="num">
                            {r.days_left == null ? '—' : <span className={r.days_left < r.lead_days ? 'neg' : ''}>{t('{d} 天', { d: r.days_left })}</span>}
                            {Number(r.transit_qty) > 0 && r.days_left_incl_transit != null && <div className="muted" style={{ fontSize: 11 }}>{t('含在途 {d}', { d: r.days_left_incl_transit })}</div>}
                          </td>
                          <td>
                            <span className={'badge ' + URG_CLASS[r.urgency]}>{t(URG_LABEL[r.urgency])}</span>
                            {r.action_status === 'ordered' && <div className="muted" style={{ fontSize: 11 }}>{t('已下单')} {r.action_qty ? fmtNum(r.action_qty) : ''} · {fmtDate(r.action_at)}</div>}
                            {r.action_status === 'skip' && <div className="muted" style={{ fontSize: 11 }}>{t('暂不订')}{r.until_date ? ' ' + t('至 {d}', { d: fmtDate(r.until_date) }) : ''}</div>}
                            {r.action_note && <div className="muted" style={{ fontSize: 11 }} title={r.action_note}>💬 {r.action_note.slice(0, 30)}</div>}
                          </td>
                          <td className="num">
                            <input type="number" min={0} style={{ ...inputStyle, width: 70, textAlign: 'right' }}
                                   value={qtyEdit[r.item_code] ?? r.suggest_qty}
                                   onChange={(e) => setQtyEdit({ ...qtyEdit, [r.item_code]: e.target.value })} />
                            {r.min_order_qty ? <div className="muted" style={{ fontSize: 11 }}>{t('起订 {n}', { n: fmtNum(r.min_order_qty) })}</div> : null}
                          </td>
                          <td className="num">{r.last_price != null ? fmtNum(r.last_price, 2) : <span className="muted">—</span>}
                            {r.last_po_date && <div className="muted" style={{ fontSize: 11 }}>{fmtDate(r.last_po_date)}</div>}</td>
                          {canWrite && (
                          <td style={{ whiteSpace: 'nowrap' }}>
                            {!r.action_status && (
                              <>
                                <button className="btn" disabled={busy === r.item_code} style={{ padding: '3px 8px', fontSize: 12 }}
                                        onClick={() => act(r.item_code, 'ordered', qtyOf(r), null, null)}>{t('已下单')}</button>{' '}
                                <button className="btn" disabled={busy === r.item_code} style={{ padding: '3px 8px', fontSize: 12 }}
                                        onClick={() => act(r.item_code, 'skip', null, todayPlus(14), null)}>{t('暂不订(2周)')}</button>{' '}
                              </>
                            )}
                            {r.action_status && r.action_id && (
                              <button className="btn" style={{ padding: '3px 8px', fontSize: 12 }} onClick={() => undo(r.action_id!)}>{t('撤销')}</button>
                            )}{' '}
                            <button className="btn" style={{ padding: '3px 8px', fontSize: 12 }}
                                    onClick={() => setOpenSetting(openSetting === r.item_code ? null : r.item_code)}>⚙</button>
                          </td>
                          )}
                        </tr>
                        {canWrite && openSetting === r.item_code && (
                          <tr><td colSpan={canWrite ? 10 : 9} style={{ background: 'rgba(219,232,250,.04)' }}>
                            <ItemSetting r={r} canWrite={canWrite} suppliers={suppliers} onSaved={() => { setOpenSetting(null); setTick((t) => t + 1); }} />
                          </td></tr>
                        )}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
                {fill.length > 0 && (
                  <div style={{ marginTop: 10, borderTop: '1px dashed var(--baseline)', paddingTop: 8 }}>
                    <div style={{ cursor: 'pointer', fontSize: 13 }} onClick={() => {
                      const s = new Set(fillOpen); s.has(key) ? s.delete(key) : s.add(key); setFillOpen(s);
                    }}>
                      <span className="muted">{fillOpen.has(key) ? '▾' : '▸'}</span> 🚢 <strong>{t('凑柜建议')}</strong>{t(':还有 {n} 项 30 天内也要补', { n: fill.length })}
                      <span className="muted">{t('(约 {amt} · 反正要订,顺这一柜省运费)', { amt: fmtRM(fill.reduce((s, r) => s + qtyOf(r) * Number(r.last_price ?? 0), 0)) })}</span>
                    </div>
                    {fillOpen.has(key) && (
                      <table className="data" style={{ marginTop: 6, fontSize: 12 }}>
                        <thead><tr><th></th><th>{t('商品')}</th><th className="num">{t('现存')}</th><th className="num">{t('日均')}</th><th className="num">{t('还能卖')}</th><th className="num">{t('建议订量')}</th><th className="num">{t('上次单价')}</th></tr></thead>
                        <tbody>
                          {fill.map((r) => (
                            <tr key={r.item_code}>
                              <td><input type="checkbox" checked={checked.has(r.item_code)} onChange={(e) => {
                                const s = new Set(checked); e.target.checked ? s.add(r.item_code) : s.delete(r.item_code); setChecked(s);
                              }} /></td>
                              <td title={r.item_code}>{r.description}<span className="muted" style={{ fontSize: 11 }}> · {r.item_code}</span></td>
                              <td className="num">{fmtNum(r.on_hand)}</td>
                              <td className="num">{Number(r.daily_avg).toFixed(1)}</td>
                              <td className="num">{t('{d} 天', { d: r.days_left_incl_transit ?? r.days_left ?? '—' })}</td>
                              <td className="num">
                                <input type="number" min={0} style={{ ...inputStyle, width: 64, textAlign: 'right' }}
                                       value={qtyEdit[r.item_code] ?? r.suggest_qty}
                                       onChange={(e) => setQtyEdit({ ...qtyEdit, [r.item_code]: e.target.value })} />
                              </td>
                              <td className="num">{r.last_price != null ? fmtNum(r.last_price, 2) : '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
      <p className="muted" style={{ fontSize: 12 }}>
        {t('口径:日均销量 = 近 90 天净销量 ÷ 90(分行提前预定的马桶/盆柜/水槽已剔除);')}
        <strong>{t('现存 = 自有可卖库存')}</strong>{t('(不含次品/展示仓,也不含 JB 仓——那是分行预定的货);')}
        <strong>{t('欠分行')}</strong>{t(' = PRE (JB) 的负数,即分行预定了但我们还没货,已直接加进建议订量并标"来不及";在途 = 120 天内未收完的 PO。')}
        <strong>{t('来不及')}</strong>{t(' = 现存撑不到交期结束;')}<strong>{t('该下单')}</strong>{t(' = 现存+在途 ≤ 交期+安全天数。')}
        {t('建议订量 = (交期+安全+覆盖) × ')}<strong>{t('订货日均')}</strong>{t(' + 欠分行 − 现存 − 在途;中国厂默认 60+14+')}<strong>30</strong>{t('(每月都下单,单量只需覆盖到下一单,卖爆了随时加单);')}
        <strong>{t('订货日均 = 年均销速')}</strong>{t('(近一年÷上市天数)与去年同期未来窗口取较大——近 3 个月的旺季不会把订量抬虚,"还能卖几天"仍按近 90 天算以免断货预警迟钝。')}
      </p>
    </>
  );
}

function ItemSetting({ r, canWrite, suppliers, onSaved }: {
  r: Suggest; canWrite: boolean; suppliers: [string, { name: string; n: number }][]; onSaved: () => void;
}) {
  const t = useT();
  const [sup, setSup] = useState(r.supplier_code ?? '');
  const [moq, setMoq] = useState(r.min_order_qty?.toString() ?? '');
  const [pack, setPack] = useState(r.pack_size?.toString() ?? '');
  const [note, setNote] = useState(r.item_note ?? '');
  const [ex, setEx] = useState(r.exclude);
  const [actNote, setActNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [allSup, setAllSup] = useState<{ creditor_code: string; name: string }[]>([]);
  useEffect(() => {
    supabase.from('bi_supplier').select('creditor_code,name').eq('company', COMPANY).order('name')
      .then(({ data }) => setAllSup((data ?? []) as { creditor_code: string; name: string }[]));
  }, []);
  async function save() {
    setSaving(true);
    const { error } = await supabase.rpc('bi_upsert_item_setting', {
      p_item_code: r.item_code, p_supplier_code: sup || null,
      p_min_order_qty: moq ? Number(moq) : null, p_pack_size: pack ? Number(pack) : null,
      p_exclude: ex, p_note: note || null, p_company: COMPANY,
    });
    if (!error && actNote.trim()) {
      await supabase.rpc('bi_add_item_action', { p_item_code: r.item_code, p_action: 'note', p_qty: null, p_until_date: null, p_note: actNote.trim(), p_company: COMPANY });
    }
    setSaving(false);
    if (error) { window.alert(t('保存失败: ') + error.message); return; }
    onSaved();
  }
  return (
    <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'end', padding: '6px 4px', fontSize: 12.5 }}>
      <div className="muted" style={{ width: '100%' }}>
        {t('{code} · 近 90 天售 {q90}(近 30 天 {q30}) · 最后销售 {d} · 24 个月采购 {n} 次', {
          code: r.item_code, q90: fmtNum(r.q90), q30: fmtNum(r.q30), d: fmtDate(r.last_sale), n: r.po_24m ?? 0,
        })}
        {r.transit_pos ? ' · ' + t('在途 PO: ') + r.transit_pos : ''}
      </div>
      <label>{t('供应商')}<br />
        <select value={sup} onChange={(e) => setSup(e.target.value)} style={inputStyle} disabled={!canWrite}>
          <option value="">{t('(按上次采购)')}</option>
          {(allSup.length ? allSup : suppliers.map(([k, v]) => ({ creditor_code: k, name: v.name }))).map((s) => (
            <option key={s.creditor_code} value={s.creditor_code}>{s.name}</option>))}
        </select></label>
      <label>{t('起订量')}<br /><input type="number" value={moq} onChange={(e) => setMoq(e.target.value)} style={{ ...inputStyle, width: 80 }} disabled={!canWrite} /></label>
      <label>{t('包装数')}<br /><input type="number" value={pack} onChange={(e) => setPack(e.target.value)} style={{ ...inputStyle, width: 80 }} disabled={!canWrite} /></label>
      <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <input type="checkbox" checked={ex} onChange={(e) => setEx(e.target.checked)} disabled={!canWrite} />{t('不再提醒此商品')}</label>
      <label style={{ flex: 1, minWidth: 180 }}>{t('商品备注(长期)')}<br /><input value={note} onChange={(e) => setNote(e.target.value)} style={{ ...inputStyle, width: '100%' }} disabled={!canWrite} /></label>
      <label style={{ flex: 1, minWidth: 180 }}>{t('本次留言')}<br /><input value={actNote} onChange={(e) => setActNote(e.target.value)} placeholder={t('例:已问供应商,下周到')} style={{ ...inputStyle, width: '100%' }} disabled={!canWrite} /></label>
      {canWrite && <button className="btn primary" disabled={saving} onClick={save}>{saving ? t('保存中…') : t('保存')}</button>}
    </div>
  );
}

/* ---------------- 到货跟踪 ---------------- */
function PoOpenTab() {
  const t = useT();
  const [rows, setRows] = useState<PoOpen[] | null>(null);
  const [showStale, setShowStale] = useState(false);
  const [q, setQ] = useState('');
  useEffect(() => {
    supabase.from('bi_po_open').select('*').eq('company', COMPANY).order('expected_date').limit(1000)
      .then(({ data }) => setRows((data ?? []) as PoOpen[]));
  }, []);
  if (rows === null) return <div className="loading">{t('载入中…')}</div>;
  const k = q.trim().toLowerCase();
  const live = rows.filter((r) => !r.stale && (!k || r.po_no.toLowerCase().includes(k) || r.supplier_name?.toLowerCase().includes(k) || r.description?.toLowerCase().includes(k) || r.item_code.toLowerCase().includes(k)));
  const stale = rows.filter((r) => r.stale);
  const overdue = live.filter((r) => r.overdue);
  const byPo = new Map<string, PoOpen[]>();
  for (const r of live) { const l = byPo.get(r.po_no) ?? []; l.push(r); byPo.set(r.po_no, l); }
  return (
    <>
      <div className="grid-kpi">
        <div className="card kpi"><div className="label">{t('在途采购单')}</div><div className="value">{t('{n} 张', { n: byPo.size })}</div><div className="sub">{t('{n} 行 · {amt}', { n: live.length, amt: fmtRM(live.reduce((s, r) => s + Number(r.open_amt), 0)) })}</div></div>
        <div className="card kpi"><div className="label">{t('已过预计到货日')}</div><div className={'value' + (overdue.length ? ' neg' : '')}>{t('{n} 张', { n: new Set(overdue.map((r) => r.po_no)).size })}</div><div className="sub">{t('{n} 行未到 · 请催货', { n: overdue.length })}</div></div>
        <div className="card kpi"><div className="label">{t('陈旧未关闭(>120 天)')}</div><div className="value">{t('{n} 张', { n: new Set(stale.map((r) => r.po_no)).size })}</div><div className="sub">{t('不计入在途 · 建议在 AutoCount 关掉')}</div></div>
      </div>
      <div className="filters">
        <input placeholder={t('搜索 PO 号 / 供应商 / 商品…')} value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="muted" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input type="checkbox" checked={showStale} onChange={(e) => setShowStale(e.target.checked)} />{t('显示陈旧 PO 清单')}
        </label>
      </div>
      <div className="card card-block">
        <div className="table-scroll">
          <table className="data">
            <thead><tr><th>PO</th><th>{t('下单日')}</th><th>{t('供应商')}</th><th>{t('商品')}</th><th className="num">{t('订购')}</th><th className="num">{t('已到')}</th><th className="num">{t('未到')}</th><th className="num">{t('金额')}</th><th>{t('预计到货')}</th><th className="num">{t('已等(天)')}</th></tr></thead>
            <tbody>
              {[...byPo.entries()].map(([po, ls]) => ls.map((r, i) => (
                <tr key={po + r.item_code + i} className={r.overdue ? 'row-overdue' : undefined}>
                  <td>{i === 0 ? po : ''}</td>
                  <td className="muted">{i === 0 ? fmtDate(r.po_date) : ''}</td>
                  <td>{i === 0 ? <>{r.supplier_name}{r.is_china ? <span className="muted"> · {t('中国')}</span> : null}</> : ''}</td>
                  <td title={r.item_code}>{r.description}</td>
                  <td className="num">{fmtNum(r.qty)}</td>
                  <td className="num muted">{fmtNum(r.transferred_qty)}</td>
                  <td className="num" style={{ fontWeight: 600 }}>{fmtNum(r.open_qty)}</td>
                  <td className="num">{fmtRM(r.open_amt)}</td>
                  <td className={r.overdue ? 'neg' : ''}>{fmtDate(r.expected_date)}{r.overdue ? ' ⚠' : ''}</td>
                  <td className="num">{r.days_open}</td>
                </tr>
              )))}
              {live.length === 0 && <tr><td colSpan={10} className="muted">{t('没有在途采购')}</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      {showStale && (
        <div className="card card-block">
          <h2>{t('陈旧未关闭 PO(下单超过 120 天仍未收完)· {n} 行', { n: stale.length })}</h2>
          <div className="table-scroll">
            <table className="data">
              <thead><tr><th>PO</th><th>{t('下单日')}</th><th>{t('供应商')}</th><th>{t('商品')}</th><th className="num">{t('未到')}</th><th className="num">{t('天数')}</th></tr></thead>
              <tbody>{stale.map((r, i) => (
                <tr key={r.po_no + i}><td>{r.po_no}</td><td className="muted">{fmtDate(r.po_date)}</td><td>{r.supplier_name}</td><td title={r.item_code}>{r.description}</td><td className="num">{fmtNum(r.open_qty)}</td><td className="num">{r.days_open}</td></tr>
              ))}</tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}

/* ---------------- 品牌 → 供应商分配 ---------------- */
type BrandRow = { item_type: string; item_count: number; active_count: number; supplier_code: string | null; supplier_name: string | null };

function BrandMap({ canWrite, suppliers }: { canWrite: boolean; suppliers: Supplier[] }) {
  const t = useT();
  const [brands, setBrands] = useState<BrandRow[] | null>(null);
  const [edit, setEdit] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [showAll, setShowAll] = useState(false);
  useEffect(() => {
    supabase.from('bi_brands').select('*').eq('company', COMPANY).gt('active_count', 0)
      .order('active_count', { ascending: false })
      .then(({ data }) => setBrands((data ?? []) as BrandRow[]));
  }, [tick]);
  if (brands === null) return null;
  const shown = showAll ? brands : brands.slice(0, 12);
  async function save(b: BrandRow) {
    const code = edit[b.item_type] ?? b.supplier_code ?? '';
    setSaving(b.item_type);
    const { error } = await supabase.rpc('bi_upsert_brand_supplier', { p_item_type: b.item_type, p_supplier_code: code || null, p_company: COMPANY });
    setSaving(null);
    if (error) { window.alert(t('保存失败: ') + error.message); return; }
    const n = { ...edit }; delete n[b.item_type]; setEdit(n);
    setTick((t) => t + 1);
  }
  return (
    <div className="card card-block">
      <h2>{t('品牌 → 默认供应商')} <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>
        {t('没有采购记录的商品按品牌归入这里设的供应商;个别商品仍可在补货页 ⚙ 单独指定')}</span></h2>
      <div className="table-scroll">
        <table className="data">
          <thead><tr><th>{t('品牌')}</th><th className="num">{t('在售商品数')}</th><th>{t('分配给供应商')}</th>{canWrite && <th></th>}</tr></thead>
          <tbody>
            {shown.map((b) => {
              const cur = edit[b.item_type] ?? (b.supplier_code ?? '');
              const dirty = edit[b.item_type] !== undefined && edit[b.item_type] !== (b.supplier_code ?? '');
              return (
                <tr key={b.item_type}>
                  <td style={{ fontWeight: 600 }}>{b.item_type}</td>
                  <td className="num">{fmtNum(b.active_count)}</td>
                  <td>
                    {canWrite ? (
                      <select value={cur} onChange={(e) => setEdit({ ...edit, [b.item_type]: e.target.value })} style={inputStyle}>
                        <option value="">{t('(不分配 — 按采购记录)')}</option>
                        {suppliers.map((s) => <option key={s.creditor_code} value={s.creditor_code}>{s.name}{s.po_name && s.po_name !== s.name ? ` · ${s.po_name}` : ''}</option>)}
                      </select>
                    ) : (b.supplier_name ?? <span className="muted">—</span>)}
                  </td>
                  {canWrite && <td>{dirty && <button className="btn primary" disabled={saving === b.item_type} onClick={() => save(b)} style={{ padding: '3px 8px', fontSize: 12 }}>{t('保存')}</button>}</td>}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {brands.length > 12 && (
        <button className="btn" style={{ marginTop: 8 }} onClick={() => setShowAll(!showAll)}>
          {showAll ? t('收起') : t('显示全部 {n} 个品牌', { n: brands.length })}
        </button>
      )}
    </div>
  );
}

/* ---------------- 供应商设定 ---------------- */
function SupplierTab({ canWrite }: { canWrite: boolean }) {
  const t = useT();
  const [rows, setRows] = useState<Supplier[] | null>(null);
  const [edit, setEdit] = useState<Record<string, Partial<Record<'lead' | 'safety' | 'cover' | 'cycle' | 'note', string>> & { china?: boolean }>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [onlyActive, setOnlyActive] = useState(true);
  useEffect(() => {
    supabase.from('bi_supplier').select('*').eq('company', COMPANY).order('po_24m', { ascending: false, nullsFirst: false }).order('name')
      .then(({ data }) => setRows((data ?? []) as Supplier[]));
  }, [tick]);
  if (rows === null) return <div className="loading">{t('载入中…')}</div>;
  const shown = rows.filter((r) => !onlyActive || (r.po_24m ?? 0) > 0);
  async function save(r: Supplier) {
    const e = edit[r.creditor_code] ?? {};
    const num = (v: string | undefined, cur: number | null) => v === undefined ? cur : (v === '' ? null : Number(v));
    setSaving(r.creditor_code);
    const { error } = await supabase.rpc('bi_upsert_supplier_setting', {
      p_creditor_code: r.creditor_code,
      p_lead_days: num(e.lead, r.lead_override), p_safety_days: num(e.safety, r.safety_override), p_cover_days: num(e.cover, r.cover_override),
      p_is_china: e.china === undefined ? r.china_override : e.china,
      p_note: e.note === undefined ? r.note : (e.note || null),
      p_cycle_days: num(e.cycle, r.order_cycle_days), p_company: COMPANY,
    });
    setSaving(null);
    if (error) { window.alert(t('保存失败: ') + error.message); return; }
    const n = { ...edit }; delete n[r.creditor_code]; setEdit(n);
    setTick((t) => t + 1);
  }
  const set = (code: string, k: string, v: string | boolean) => setEdit({ ...edit, [code]: { ...(edit[code] ?? {}), [k]: v } });
  return (
    <>
      <div className="notice">
        {t('每家供应商的')}<strong>{t('交期')}</strong>{t('(下单到到货)、')}<strong>{t('安全天数')}</strong>{t('(缓冲)、')}<strong>{t('覆盖天数')}</strong>{t('(一次订够卖多久)。')}
        {t('默认值:中国供应商 60 / 14 / 30 天;本地供应商按历史实际交期(不足 7 天按 7)/ 7 / 30 天。')}
        {canWrite && <>{t('留空 = 用默认;填数字 = 覆盖。"中国"标记默认按 PO 名字里是否有 CS 编号判断,可手动改。')}</>}
      </div>
      <BrandMap canWrite={canWrite} suppliers={rows} />
      <div className="filters">
        <label className="muted" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input type="checkbox" checked={onlyActive} onChange={(e) => setOnlyActive(e.target.checked)} />{t('只看近 24 个月有采购的')}
        </label>
        <span className="muted">{t('{n} 家', { n: shown.length })}</span>
      </div>
      <div className="card">
        <div className="table-scroll">
          <table className="data">
            <thead><tr><th>{t('供应商')}</th><th>{t('中国')}</th><th className="num">{t('24月PO')}</th><th>{t('最近PO')}</th><th className="num">{t('历史交期')}</th><th className="num">{t('短装率')}</th><th className="num">{t('交期(天)')}</th><th className="num">{t('安全(天)')}</th><th className="num">{t('覆盖(天)')}</th><th className="num">{t('订货周期(天)')}</th><th>{t('备注')}</th>{canWrite && <th></th>}</tr></thead>
            <tbody>{shown.map((r) => {
              const e = edit[r.creditor_code] ?? {};
              const dirty = Object.keys(e).length > 0;
              return (
                <tr key={r.creditor_code}>
                  <td title={r.creditor_code}>{r.name}{r.po_name && r.po_name !== r.name ? <div className="muted" style={{ fontSize: 11 }}>{r.po_name}</div> : null}</td>
                  <td>{canWrite
                    ? <input type="checkbox" checked={e.china ?? r.is_china} onChange={(ev) => set(r.creditor_code, 'china', ev.target.checked)} />
                    : (r.is_china ? '🇨🇳' : <span className="muted">—</span>)}</td>
                  <td className="num">{r.po_24m ?? 0}</td>
                  <td className="muted">{fmtDate(r.last_po)}</td>
                  <td className="num muted">{r.hist_lead_days != null ? t('{d} 天 ({n} 单)', { d: r.hist_lead_days, n: r.n_rcv ?? 0 }) : '—'}</td>
                  <td className={'num' + (Number(r.short_pct) > 5 ? ' neg' : ' muted')} title={t('订了没到齐的比例(60 天前的旧单)')}>
                    {r.short_pct != null ? `${r.short_pct}%` : '—'}
                  </td>
                  {canWrite ? (
                    <>
                      <td className="num"><input type="number" style={{ ...inputStyle, width: 64, textAlign: 'right' }} placeholder={String(r.lead_days)}
                                                 value={e.lead ?? (r.lead_override ?? '')} onChange={(ev) => set(r.creditor_code, 'lead', ev.target.value)} /></td>
                      <td className="num"><input type="number" style={{ ...inputStyle, width: 64, textAlign: 'right' }} placeholder={String(r.safety_days)}
                                                 value={e.safety ?? (r.safety_override ?? '')} onChange={(ev) => set(r.creditor_code, 'safety', ev.target.value)} /></td>
                      <td className="num"><input type="number" style={{ ...inputStyle, width: 64, textAlign: 'right' }} placeholder={String(r.cover_days)}
                                                 value={e.cover ?? (r.cover_override ?? '')} onChange={(ev) => set(r.creditor_code, 'cover', ev.target.value)} /></td>
                      <td className="num"><input type="number" style={{ ...inputStyle, width: 64, textAlign: 'right' }} placeholder={t('不设')}
                                                 title={t('每隔几天下一次单;设了以后到期会在补货页提醒')}
                                                 value={e.cycle ?? (r.order_cycle_days ?? '')} onChange={(ev) => set(r.creditor_code, 'cycle', ev.target.value)} /></td>
                      <td><input style={{ ...inputStyle, width: 160 }} value={e.note ?? (r.note ?? '')} onChange={(ev) => set(r.creditor_code, 'note', ev.target.value)} /></td>
                      <td>{dirty && <button className="btn primary" disabled={saving === r.creditor_code} onClick={() => save(r)} style={{ padding: '3px 8px', fontSize: 12 }}>{t('保存')}</button>}</td>
                    </>
                  ) : (
                    <>
                      <td className="num">{t('{d} 天', { d: r.lead_days })}</td>
                      <td className="num">{t('{d} 天', { d: r.safety_days })}</td>
                      <td className="num">{t('{d} 天', { d: r.cover_days })}</td>
                      <td className="num">{r.order_cycle_days != null ? t('{d} 天', { d: r.order_cycle_days }) : '—'}</td>
                      <td className="muted">{r.note ?? ''}</td>
                    </>
                  )}
                </tr>
              );
            })}</tbody>
          </table>
        </div>
      </div>
    </>
  );
}

export default function Purchasing({ canWrite }: { canWrite: boolean }) {
  const t = useT();
  const [sub, setSub] = useState<'suggest' | 'po' | 'sup'>('suggest');
  return (
    <>
      <div className="seg" style={{ marginBottom: 14 }}>
        <button className={sub === 'suggest' ? 'active' : ''} onClick={() => setSub('suggest')}>{t('补货建议')}</button>
        <button className={sub === 'po' ? 'active' : ''} onClick={() => setSub('po')}>{t('到货跟踪')}</button>
        <button className={sub === 'sup' ? 'active' : ''} onClick={() => setSub('sup')}>{t('供应商设定')}</button>
      </div>
      {sub === 'suggest' && <SuggestTab canWrite={canWrite} />}
      {sub === 'po' && <PoOpenTab />}
      {sub === 'sup' && <SupplierTab canWrite={canWrite} />}
    </>
  );
}
