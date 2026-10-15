// 订货与 ETA · 供应商交期（从 BI 的订货页「供应商设定」搬进来，2026-10-16）：每家供应商的交期 / 安全 / 覆盖 / 订货周期，
// 品牌 → 默认供应商（没有采购纪录的商品按品牌归入）。看得到厂家的人可看；订货「可编辑」可改。
import { useCallback, useEffect, useState } from "react";
import { ErrorBox } from "../ui";
import { BrandRow, rpl, SupplierRow, Suppliers as SupplierData } from "../rpl-api";
import "../rpl.css";

type Edit = Partial<Record<"lead" | "safety" | "cover" | "cycle" | "note", string>> & { china?: boolean };
const day = (s: string | null | undefined) => (s ? s.slice(0, 10) : "—");

export default function Suppliers({ company }: { company: string }) {
  const [data, setData] = useState<SupplierData | null>(null);
  const [error, setError] = useState("");
  const [edit, setEdit] = useState<Record<string, Edit>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [onlyActive, setOnlyActive] = useState(true);
  const load = useCallback(() => {
    setError("");
    rpl.suppliers(company).then(setData).catch((e: Error) => setError(e.message));
  }, [company]);
  useEffect(load, [load]);
  if (!data) return error ? <ErrorBox error={error} /> : <p className="muted">载入中…</p>;

  const canEdit = data.can_edit;
  const shown = data.suppliers.filter((r) => !onlyActive || (r.po_24m ?? 0) > 0);
  const set = (code: string, k: keyof Edit, v: string | boolean) => setEdit({ ...edit, [code]: { ...(edit[code] ?? {}), [k]: v } });
  const num = (v: string | undefined, cur: number | null) => (v === undefined ? cur : v === "" ? null : Number(v));
  async function save(r: SupplierRow) {
    const e = edit[r.creditor_code] ?? {};
    setSaving(r.creditor_code); setError("");
    try {
      await rpl.saveSupplier({
        company, creditor_code: r.creditor_code,
        lead_days: num(e.lead, r.lead_override), safety_days: num(e.safety, r.safety_override), cover_days: num(e.cover, r.cover_override),
        is_china: e.china === undefined ? r.china_override : e.china,
        note: e.note === undefined ? r.note ?? "" : e.note, cycle_days: num(e.cycle, r.order_cycle_days),
      });
      const n = { ...edit }; delete n[r.creditor_code]; setEdit(n);
      load();
    } catch (err) { setError((err as Error).message); }
    setSaving(null);
  }
  return (
    <>
      <p className="muted small">
        每家供应商的交期（下单到到货）、安全天数（缓冲）、覆盖天数（一次订够卖多久）。默认值：中国供应商 60 / 14 / 30 天；本地供应商按历史实际交期（不足 7 天按 7）/ 7 / 30 天。
        {canEdit && "留空 = 用默认；填数字 = 覆盖。「中国」标记默认按 PO 名字里是否有 CS 编号判断，可手动改。"}
      </p>
      <BrandMap company={company} brands={data.brands} suppliers={data.suppliers} canEdit={canEdit} onSaved={load} />
      <div className="rpl-filters">
        <label className="check"><input type="checkbox" checked={onlyActive} onChange={(e) => setOnlyActive(e.target.checked)} /> 只看近 24 个月有采购的</label>
        <span className="muted small">{`${shown.length} 家`}</span>
      </div>
      <ErrorBox error={error} />
      <div className="table-wrap rpl-sup">
        <table>
          <thead><tr>
            <th>供应商</th><th>中国</th><th className="num hide-sm">24 月 PO</th><th className="hide-sm">最近 PO</th><th className="num hide-sm">历史交期</th>
            <th className="num hide-sm">短装率</th><th className="num">交期（天）</th><th className="num">安全（天）</th><th className="num">覆盖（天）</th>
            <th className="num">订货周期（天）</th><th>备注</th>{canEdit && <th className="rpl-sticky"></th>}
          </tr></thead>
          <tbody>{shown.map((r) => {
            const e = edit[r.creditor_code] ?? {};
            const dirty = Object.keys(e).length > 0;
            return (
              <tr key={r.creditor_code}>
                <td title={r.creditor_code}>{r.name}{r.po_name && r.po_name !== r.name && <div className="rpl-note">{r.po_name}</div>}</td>
                <td>{canEdit
                  ? <input type="checkbox" checked={e.china ?? r.is_china} onChange={(ev) => set(r.creditor_code, "china", ev.target.checked)} />
                  : (r.is_china ? "🇨🇳" : <span className="muted">—</span>)}</td>
                <td className="num hide-sm">{r.po_24m ?? 0}</td>
                <td className="muted hide-sm nowrap">{day(r.last_po)}</td>
                <td className="num muted hide-sm">{r.hist_lead_days != null ? `${r.hist_lead_days} 天（${r.n_rcv ?? 0} 单）` : "—"}</td>
                <td className={"num hide-sm" + (Number(r.short_pct) > 5 ? " rpl-neg" : " muted")} title="订了没到齐的比例（60 天前的旧单）">{r.short_pct != null ? `${r.short_pct}%` : "—"}</td>
                {canEdit ? (
                  <>
                    <td className="num"><input type="number" className="rpl-qty" placeholder={String(r.lead_days)} value={e.lead ?? (r.lead_override ?? "")} onChange={(ev) => set(r.creditor_code, "lead", ev.target.value)} /></td>
                    <td className="num"><input type="number" className="rpl-qty" placeholder={String(r.safety_days)} value={e.safety ?? (r.safety_override ?? "")} onChange={(ev) => set(r.creditor_code, "safety", ev.target.value)} /></td>
                    <td className="num"><input type="number" className="rpl-qty" placeholder={String(r.cover_days)} value={e.cover ?? (r.cover_override ?? "")} onChange={(ev) => set(r.creditor_code, "cover", ev.target.value)} /></td>
                    <td className="num"><input type="number" className="rpl-qty" placeholder="不设" title="每隔几天下一次单；设了以后到期会在补货建议提醒" value={e.cycle ?? (r.order_cycle_days ?? "")} onChange={(ev) => set(r.creditor_code, "cycle", ev.target.value)} /></td>
                    <td className="rpl-sup-note"><input value={e.note ?? (r.note ?? "")} maxLength={500} onChange={(ev) => set(r.creditor_code, "note", ev.target.value)} /></td>
                    <td className="rpl-sticky">{dirty && <button className="small" disabled={saving === r.creditor_code} onClick={() => save(r)}>储存</button>}</td>
                  </>
                ) : (
                  <>
                    <td className="num">{`${r.lead_days} 天`}</td>
                    <td className="num">{`${r.safety_days} 天`}</td>
                    <td className="num">{`${r.cover_days} 天`}</td>
                    <td className="num">{r.order_cycle_days != null ? `${r.order_cycle_days} 天` : "—"}</td>
                    <td className="muted">{r.note ?? ""}</td>
                  </>
                )}
              </tr>
            );
          })}</tbody>
        </table>
      </div>
    </>
  );
}

function BrandMap({ company, brands, suppliers, canEdit, onSaved }: { company: string; brands: BrandRow[]; suppliers: SupplierRow[]; canEdit: boolean; onSaved: () => void }) {
  const [edit, setEdit] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [error, setError] = useState("");
  const active = brands.filter((b) => b.active_count > 0);
  const shown = showAll ? active : active.slice(0, 12);
  async function save(b: BrandRow) {
    setSaving(b.item_type); setError("");
    try {
      await rpl.saveBrand({ company, item_type: b.item_type, supplier_code: edit[b.item_type] ?? b.supplier_code ?? "" });
      const n = { ...edit }; delete n[b.item_type]; setEdit(n);
      onSaved();
    } catch (e) { setError((e as Error).message); }
    setSaving(null);
  }
  return (
    <div className="card rpl-group">
      <h3>品牌 → 默认供应商 <span className="muted small">没有采购纪录的商品按品牌归入这里设的供应商；个别商品仍可在补货建议 ⚙ 单独指定</span></h3>
      <ErrorBox error={error} />
      <div className="table-wrap">
        <table>
          <thead><tr><th>品牌</th><th className="num">在售商品数</th><th>分配给供应商</th>{canEdit && <th></th>}</tr></thead>
          <tbody>
            {shown.map((b) => {
              const cur = edit[b.item_type] ?? (b.supplier_code ?? "");
              const dirty = edit[b.item_type] !== undefined && edit[b.item_type] !== (b.supplier_code ?? "");
              return (
                <tr key={b.item_type}>
                  <td><b>{b.item_type}</b></td>
                  <td className="num">{b.active_count}</td>
                  <td>{canEdit ? (
                    <select value={cur} onChange={(e) => setEdit({ ...edit, [b.item_type]: e.target.value })}>
                      <option value="">（不分配 — 按采购纪录）</option>
                      {suppliers.map((s) => <option key={s.creditor_code} value={s.creditor_code}>{s.name}{s.po_name && s.po_name !== s.name ? ` · ${s.po_name}` : ""}</option>)}
                    </select>
                  ) : (b.supplier_name ?? <span className="muted">—</span>)}</td>
                  {canEdit && <td>{dirty && <button className="small" disabled={saving === b.item_type} onClick={() => save(b)}>储存</button>}</td>}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {active.length > 12 && <button className="small ghost" onClick={() => setShowAll(!showAll)}>{showAll ? "收起" : `显示全部 ${active.length} 个品牌`}</button>}
    </div>
  );
}
