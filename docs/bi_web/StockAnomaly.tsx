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

  if (rows === null) return <div className="loading">载入中…</div>;

  return (
    <>
      <div className="filters">
        <input placeholder="搜商品代号 / 名称" value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="muted" style={{ fontSize: 12 }}>资料来自 BI 每天 04:05 UTC 的同步;三张表都可下载 CSV 给员工照做。这页不会改 AutoCount。</span>
      </div>
      {err && <div className="notice">查询失败:{err}</div>}

      <div className="grid-kpi">
        <Kpi label="A 服务项目仍在扣库存" value={fmtNum(service.length) + ' 项'} sub="取消 Stock Control 就不再累积" />
        <Kpi label="B 仓位错配(货在别的仓)" value={fmtNum(mismatch.length) + ' 项'} sub={`建议转仓 ${fmtNum(transfers.length)} 笔`} />
        <Kpi label="C 真正短少(全仓合计为负)" value={fmtNum(short.length) + ' 项'} sub={`合计 ${fmtNum(shortUnits)} 件,要盘点`} />
      </div>

      <div className="card card-block">
        <h2>B · 仓位错配 → 建议 Stock Transfer 清单({fmtNum(transfersShown.length)} 笔)</h2>
        <div className="filters" style={{ marginBottom: 8 }}>
          <select value={toLoc} onChange={(e) => setToLoc(e.target.value)}>
            <option value="">全部目的仓</option>
            {toLocs.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
          <button className="btn" onClick={() => downloadCsv(`stock_transfer_${COMPANY}_${toLoc || 'all'}.csv`,
            ['ItemCode', 'Description', 'FromLocation', 'ToLocation', 'Qty'],
            transfersShown.map((t) => [t.item_code, t.item_description, t.from, t.to, t.qty]))}>下载 CSV</button>
          <span className="muted" style={{ fontSize: 12 }}>员工在 AutoCount 开 Stock Transfer:从 From 仓转到 To 仓,数量照表。做完隔天这里就会消失。</span>
        </div>
        <div className="table-scroll">
          <table className="data">
            <thead><tr><th>商品</th><th>名称</th><th>从</th><th>到</th><th className="num">数量</th><th>目前各仓</th></tr></thead>
            <tbody>
              {transfersShown.length === 0 && <tr><td colSpan={6} className="muted">没有仓位错配</td></tr>}
              {transfersShown.slice(0, 400).map((t, i) => {
                const r = mismatch.find((x) => x.item_code === t.item_code)!;
                return (
                  <tr key={i}>
                    <td>{t.item_code}</td><td>{t.item_description}</td><td>{t.from}</td><td style={{ fontWeight: 600 }}>{t.to}</td>
                    <td className="num" style={{ fontWeight: 600 }}>{fmtNum(t.qty)}</td>
                    <LocCells locs={r.locs} />
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {transfersShown.length > 400 && <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>只显示前 400 笔,完整清单请下载 CSV。</p>}
      </div>

      <div className="card card-block">
        <h2>C · 真正短少 → 盘点清单({fmtNum(short.length)} 项)</h2>
        <div className="filters" style={{ marginBottom: 8 }}>
          <button className="btn" onClick={() => downloadCsv(`stock_take_${COMPANY}.csv`,
            ['ItemCode', 'Description', 'Group', 'UOM', 'Locations', 'NetQty', 'Counted'],
            short.map((r) => [r.item_code, r.item_description ?? '', r.item_group ?? '', r.base_uom ?? '', locsText(r.locs), r.net_qty, '']))}>下载盘点表 CSV</button>
          <span className="muted" style={{ fontSize: 12 }}>系统说卖出去的比进来的多。请实地点数填 Counted 栏,核准后再做 Stock Adjustment。</span>
        </div>
        <div className="table-scroll">
          <table className="data">
            <thead><tr><th>商品</th><th>名称</th><th>群组</th><th>各仓</th><th className="num">全仓合计</th></tr></thead>
            <tbody>
              {short.length === 0 && <tr><td colSpan={5} className="muted">没有短少</td></tr>}
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
        <h2>A · 服务项目仍在扣库存({fmtNum(service.length)} 项)</h2>
        <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
          手续费、运费、Voucher、安装这类不是货,却设了库存控制,每开一单就扣一件,把库存报表弄花。
          处理:AutoCount → Stock → Stock Item → 打开该商品 → 取消勾选 Stock Control(先把库存数调成 0)。
        </p>
        <div className="table-scroll">
          <table className="data">
            <thead><tr><th>商品</th><th>名称</th><th>群组</th><th>各仓</th><th className="num">合计</th></tr></thead>
            <tbody>
              {service.length === 0 && <tr><td colSpan={5} className="muted">没有</td></tr>}
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
