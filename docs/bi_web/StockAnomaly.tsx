import { useEffect, useMemo, useState } from 'react';
import { supabase, COMPANY } from '../lib/supabase';
import { fmtNum } from '../lib/format';
import { Kpi } from '../components/ChartCard';

// 库存异常:读 public.bi_stock_anomaly(只列有问题的商品,各仓数量在 locs)。三种问题分开列,各自附处理方法:
//   A 服务项目仍在扣库存 → AutoCount 商品设定取消 Stock Control
//   B 仓位错配(某仓负数、别的仓有货)→ 照建议清单做 Stock Transfer
//   C 真正短少(全仓合计为负)→ 盘点后 Stock Adjustment
// 全部只读;BI 不写 AutoCount。

type Row = {
  item_code: string; item_description: string | null; item_group: string | null; base_uom: string | null;
  is_service: boolean; net_qty: number; min_qty: number; locs: Record<string, number>;
};
type Transfer = { item_code: string; item_description: string; from: string; to: string; qty: number };

const n = (v: unknown) => Number(v ?? 0);
const PAGE = 1000;

// 双语:仓库同事不一定看中文。字典放这里,切换存 localStorage(bi_lang)。
type Lang = 'zh' | 'en';
const T = {
  zh: {
    search: '搜商品代号 / 名称', note: '资料来自 BI 每天的同步;三张表都可下载 CSV 给员工照做。这页不会改 AutoCount。', fail: '查询失败:',
    kA: 'A 服务项目仍在扣库存', kAs: '取消 Stock Control 就不再累积', kB: 'B 仓位错配(货在别的仓)', kBs: (x: string) => `建议转仓 ${x} 笔`,
    kC: 'C 真正短少(全仓合计为负)', kCs: (x: string) => `合计 ${x} 件,要盘点`, items: '项',
    hB: (x: string) => `B · 仓位错配 → 建议 Stock Transfer 清单(${x} 笔)`, allTo: '全部目的仓', csv: '下载 CSV',
    bNote: '员工在 AutoCount 开 Stock Transfer:从 From 仓转到 To 仓,数量照表。做完隔天这里就会消失。',
    item: '商品', name: '名称', from: '从', to: '到', qty: '数量', locsNow: '目前各仓', noB: '没有仓位错配', only400: '只显示前 400 笔,完整清单请下载 CSV。',
    hC: (x: string) => `C · 真正短少 → 盘点清单(${x} 项)`, csvC: '下载盘点表 CSV',
    cNote: '系统说卖出去的比进来的多。请实地点数填 Counted 栏,核准后再做 Stock Adjustment。', group: '群组', locs: '各仓', net: '全仓合计', noC: '没有短少',
    hA: (x: string) => `A · 服务项目仍在扣库存(${x} 项)`,
    aNote: '手续费、运费、Voucher、安装这类不是货,却设了库存控制,每开一单就扣一件,把库存报表弄花。处理:AutoCount → Stock → Stock Item → 打开该商品 → 取消勾选 Stock Control(先把库存数调成 0)。',
    total: '合计', noA: '没有',
  },
  en: {
    search: 'Search item code / name', note: 'Data from the daily BI sync. Each table can be downloaded as CSV for staff. This page never changes AutoCount.', fail: 'Query failed: ',
    kA: 'A Service items still deducting stock', kAs: 'Untick Stock Control to stop it', kB: 'B Wrong location (stock is in another location)', kBs: (x: string) => `${x} transfers suggested`,
    kC: 'C Real shortage (all locations total < 0)', kCs: (x: string) => `${x} units in total, needs stock count`, items: 'items',
    hB: (x: string) => `B · Wrong location → suggested Stock Transfers (${x})`, allTo: 'All destinations', csv: 'Download CSV',
    bNote: 'Create a Stock Transfer in AutoCount from the From location to the To location with the qty shown. Once done, the row disappears after the next sync.',
    item: 'Item', name: 'Description', from: 'From', to: 'To', qty: 'Qty', locsNow: 'Current by location', noB: 'No location mismatch', only400: 'Showing first 400 rows; download the CSV for the full list.',
    hC: (x: string) => `C · Real shortage → stock count list (${x} items)`, csvC: 'Download count sheet CSV',
    cNote: 'The system shows more sold than received. Count physically, fill the Counted column, then post a Stock Adjustment after approval.', group: 'Group', locs: 'By location', net: 'Total', noC: 'No shortage',
    hA: (x: string) => `A · Service items still deducting stock (${x} items)`,
    aNote: 'Fees, shipping, vouchers and installation are not goods, but they have Stock Control on, so every document deducts one unit and pollutes the stock report. Fix: AutoCount → Stock → Stock Item → open the item → untick Stock Control (set its stock to 0 first).',
    total: 'Total', noA: 'None',
  },
} as const;
const savedLang = (): Lang => { try { return localStorage.getItem('bi_lang') === 'en' ? 'en' : 'zh'; } catch { return 'zh'; } };

function locsText(locs: Record<string, number>) {
  return Object.entries(locs).sort((a, b) => n(b[1]) - n(a[1]))
    .map(([l, q]) => `${l} ${fmtNum(q)}`).join(' · ');
}

function LocCells({ locs }: { locs: Record<string, number> }) {
  return (
    <td style={{ whiteSpace: 'nowrap' }}>
      {Object.entries(locs).sort((a, b) => n(b[1]) - n(a[1])).map(([l, q]) => (
        <span key={l} className={n(q) < 0 ? 'neg' : ''} style={{ marginRight: 10 }}>{l} <b>{fmtNum(q)}</b></span>
      ))}
    </td>
  );
}

function downloadCsv(name: string, header: string[], rows: (string | number)[][]) {
  const esc = (v: string | number) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = '﻿' + [header, ...rows].map((r) => r.map(esc).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = name; a.click();
  URL.revokeObjectURL(a.href);
}

// 仓位错配的建议转仓:每个负数仓,从库存最多的正数仓补,补到 0 为止
function suggestTransfers(r: Row): Transfer[] {
  const pos = Object.entries(r.locs).filter(([, q]) => n(q) > 0).map(([l, q]) => ({ l, q: n(q) })).sort((a, b) => b.q - a.q);
  const out: Transfer[] = [];
  Object.entries(r.locs).filter(([, q]) => n(q) < 0).forEach(([to, q]) => {
    let need = -n(q);
    for (const p of pos) {
      if (need <= 0) break;
      const take = Math.min(need, p.q);
      if (take > 0) { out.push({ item_code: r.item_code, item_description: r.item_description ?? '', from: p.l, to, qty: take }); p.q -= take; need -= take; }
    }
  });
  return out;
}

export default function StockAnomaly() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [toLoc, setToLoc] = useState('');
  const [lang, setLang] = useState<Lang>(savedLang);
  const t = T[lang];
  const switchLang = (l: Lang) => { setLang(l); try { localStorage.setItem('bi_lang', l); } catch { /* 隐私模式 */ } };

  useEffect(() => {
    (async () => {
      const all: Row[] = [];
      for (let i = 0; i < 20; i++) {                      // 最多 2 万列,足够
        const { data, error } = await supabase.from('bi_stock_anomaly')
          .select('item_code,item_description,item_group,base_uom,is_service,net_qty,min_qty,locs')
          .eq('company', COMPANY).order('item_code').range(i * PAGE, i * PAGE + PAGE - 1);
        if (error) { setErr(error.message); break; }
        const chunk = (data ?? []) as Row[];
        all.push(...chunk);
        if (chunk.length < PAGE) break;
      }
      setRows(all.map((r) => ({ ...r, net_qty: n(r.net_qty), min_qty: n(r.min_qty) })));
    })();
  }, []);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (rows ?? []).filter((r) => !s || r.item_code.toLowerCase().includes(s) || (r.item_description ?? '').toLowerCase().includes(s));
  }, [rows, q]);

  const service = filtered.filter((r) => r.is_service);
  const short = filtered.filter((r) => !r.is_service && r.net_qty < 0).sort((a, b) => a.net_qty - b.net_qty);
  const mismatch = filtered.filter((r) => !r.is_service && r.net_qty >= 0 && r.min_qty < 0);
  const transfers = useMemo(() => mismatch.flatMap(suggestTransfers), [mismatch]);
  const toLocs = Array.from(new Set(transfers.map((t) => t.to))).sort();
  const transfersShown = transfers.filter((t) => !toLoc || t.to === toLoc);
  const shortUnits = short.reduce((s, r) => s + r.net_qty, 0);

  if (rows === null) return <div className="loading">{lang === 'en' ? 'Loading…' : '载入中…'}</div>;

  return (
    <>
      <div className="filters">
        <input placeholder={t.search} value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="seg">
          <button className={lang === 'zh' ? 'active' : ''} onClick={() => switchLang('zh')}>中文</button>
          <button className={lang === 'en' ? 'active' : ''} onClick={() => switchLang('en')}>EN</button>
        </div>
        <span className="muted" style={{ fontSize: 12 }}>{t.note}</span>
      </div>
      {err && <div className="notice">{t.fail}{err}</div>}

      <div className="grid-kpi">
        <Kpi label={t.kA} value={`${fmtNum(service.length)} ${t.items}`} sub={t.kAs} />
        <Kpi label={t.kB} value={`${fmtNum(mismatch.length)} ${t.items}`} sub={t.kBs(fmtNum(transfers.length))} />
        <Kpi label={t.kC} value={`${fmtNum(short.length)} ${t.items}`} sub={t.kCs(fmtNum(shortUnits))} />
      </div>

      <div className="card card-block">
        <h2>{t.hB(fmtNum(transfersShown.length))}</h2>
        <div className="filters" style={{ marginBottom: 8 }}>
          <select value={toLoc} onChange={(e) => setToLoc(e.target.value)}>
            <option value="">{t.allTo}</option>
            {toLocs.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
          <button className="btn" onClick={() => downloadCsv(`stock_transfer_${COMPANY}_${toLoc || 'all'}.csv`,
            ['ItemCode', 'Description', 'FromLocation', 'ToLocation', 'Qty'],
            transfersShown.map((x) => [x.item_code, x.item_description, x.from, x.to, x.qty]))}>{t.csv}</button>
          <span className="muted" style={{ fontSize: 12 }}>{t.bNote}</span>
        </div>
        <div className="table-scroll">
          <table className="data">
            <thead><tr><th>{t.item}</th><th>{t.name}</th><th>{t.from}</th><th>{t.to}</th><th className="num">{t.qty}</th><th>{t.locsNow}</th></tr></thead>
            <tbody>
              {transfersShown.length === 0 && <tr><td colSpan={6} className="muted">{t.noB}</td></tr>}
              {transfersShown.slice(0, 400).map((x, i) => {
                const r = mismatch.find((m) => m.item_code === x.item_code)!;
                return (
                  <tr key={i}>
                    <td>{x.item_code}</td><td>{x.item_description}</td><td>{x.from}</td><td style={{ fontWeight: 600 }}>{x.to}</td>
                    <td className="num" style={{ fontWeight: 600 }}>{fmtNum(x.qty)}</td>
                    <LocCells locs={r.locs} />
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {transfersShown.length > 400 && <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>{t.only400}</p>}
      </div>

      <div className="card card-block">
        <h2>{t.hC(fmtNum(short.length))}</h2>
        <div className="filters" style={{ marginBottom: 8 }}>
          <button className="btn" onClick={() => downloadCsv(`stock_take_${COMPANY}.csv`,
            ['ItemCode', 'Description', 'Group', 'UOM', 'Locations', 'NetQty', 'Counted'],
            short.map((r) => [r.item_code, r.item_description ?? '', r.item_group ?? '', r.base_uom ?? '', locsText(r.locs), r.net_qty, '']))}>{t.csvC}</button>
          <span className="muted" style={{ fontSize: 12 }}>{t.cNote}</span>
        </div>
        <div className="table-scroll">
          <table className="data">
            <thead><tr><th>{t.item}</th><th>{t.name}</th><th>{t.group}</th><th>{t.locs}</th><th className="num">{t.net}</th></tr></thead>
            <tbody>
              {short.length === 0 && <tr><td colSpan={5} className="muted">{t.noC}</td></tr>}
              {short.map((r) => (
                <tr key={r.item_code}>
                  <td>{r.item_code}</td><td>{r.item_description}</td><td className="muted">{r.item_group}</td>
                  <LocCells locs={r.locs} />
                  <td className="num neg" style={{ fontWeight: 600 }}>{fmtNum(r.net_qty)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card card-block">
        <h2>{t.hA(fmtNum(service.length))}</h2>
        <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>{t.aNote}</p>
        <div className="table-scroll">
          <table className="data">
            <thead><tr><th>{t.item}</th><th>{t.name}</th><th>{t.group}</th><th>{t.locs}</th><th className="num">{t.total}</th></tr></thead>
            <tbody>
              {service.length === 0 && <tr><td colSpan={5} className="muted">{t.noA}</td></tr>}
              {service.map((r) => (
                <tr key={r.item_code}>
                  <td>{r.item_code}</td><td>{r.item_description}</td><td className="muted">{r.item_group}</td>
                  <LocCells locs={r.locs} />
                  <td className={'num' + (r.net_qty < 0 ? ' neg' : '')}>{fmtNum(r.net_qty)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
