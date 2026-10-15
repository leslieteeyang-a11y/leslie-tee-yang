// 订货与 ETA · 补货建议（从 BI 的订货页搬进来，2026-10-16）。
// 近 90 天卖 ≥ 门槛、或欠分行、或已经没货的商品，按品牌（或开单公司）分组，算还能卖几天、建议订量；可记已下单 / 暂不订、改商品设定。
// 看不到厂家的人（分行、门市、电商、物流）：没有供应商 / 厂号 / PO 号，只能按品牌分组；看不到进货单价的人：没有上次单价与采购额。
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { BRANCH_LABEL, fmtQty, fmtRM } from "../api";
import { Empty, ErrorBox } from "../ui";
import { getLang, tr } from "../i18n";
import { plusDays, rpl, RplMeta, RplRow, RplRows, SupplierRow, URGENCY_LABEL } from "../rpl-api";
import "../rpl.css";

const COMPANY_KEY = "hw-rpl-company";
const day = (s: string | null | undefined) => (s ? s.slice(0, 10) : "—");
const n1 = (v: number | string | null | undefined) => Number(v ?? 0).toFixed(1);
/** alert 与下载的 CSV 不在画面上，DOM 翻译层翻不到：英文模式自己先翻 */
const ui = (s: string) => (getLang() === "en" ? tr(s) : s);

export default function Replenish({ branchAll }: { branchAll: boolean }) {
  // 只有分店 ALL 的人能换分店；其他人一律用自己的分店（同一台电脑别人留下的分店不能拿来用，会被资料库拒绝）
  const [company, setCompany] = useState(() => { if (!branchAll) return ""; try { return localStorage.getItem(COMPANY_KEY) || ""; } catch { return ""; } });
  const [meta, setMeta] = useState<RplMeta | null>(null);
  const [minQ, setMinQ] = useState(30);
  const [cs, setCs] = useState("");
  const [data, setData] = useState<RplRows | null>(null);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  const [reloading, setReloading] = useState(false);
  const listKey = useRef("");

  // 页面设定（权限、厂号清单、该下单的供应商）：换公司或操作后重抓
  useEffect(() => {
    let alive = true;
    rpl.meta(company).then((m) => {
      if (!alive) return;
      setMeta(m);
      if (m.company !== company) { setCompany(m.company); try { localStorage.setItem(COMPANY_KEY, m.company); } catch { /* 忽略 */ } }
    }).catch((e: Error) => alive && setError(e.message));
    return () => { alive = false; };
  }, [company, tick]);
  // 清单：公司 / 门槛 / 厂号换了才清空重载；操作后（tick）在背景重抓，<Suggest> 留着（筛选、改过的数量、勾选都不丢）；先发后到的回应丢掉
  useEffect(() => {
    if (!company) return;
    let alive = true;
    const k = `${company}|${minQ}|${cs}`;
    if (listKey.current !== k) { listKey.current = k; setData(null); } else setReloading(true);
    setError("");
    rpl.rows({ company, min_q: minQ, cs_code: cs || undefined })
      .then((d) => { if (alive) setData(d); })
      .catch((e: Error) => { if (alive) setError(e.message); })
      .finally(() => { if (alive) setReloading(false); });
    return () => { alive = false; };
  }, [company, minQ, cs, tick]);

  if (!meta) return error ? <ErrorBox error={error} /> : <p className="muted">载入中…</p>;
  return (
    <>
      <div className="rpl-filters">
        {branchAll && meta.companies.length > 1 && (
          <select value={company} onChange={(e) => { setCompany(e.target.value); try { localStorage.setItem(COMPANY_KEY, e.target.value); } catch { /* 忽略 */ } }}>
            {meta.companies.map((c) => <option key={c} value={c}>{BRANCH_LABEL[c] ?? c}</option>)}
          </select>
        )}
        <label className="check">走量门槛
          <select value={minQ} onChange={(e) => setMinQ(Number(e.target.value))} title="近 90 天至少卖出这么多件才列出；欠分行或已经没货的商品不受门槛限制，一律列出">
            <option value={10}>90 天 ≥10 件 + 没货的</option>
            <option value={30}>90 天 ≥30 件 + 没货的</option>
            <option value={100}>90 天 ≥100 件 + 没货的</option>
          </select>
        </label>
        {meta.supplier && meta.cs_codes.length > 0 && (
          <select value={cs} onChange={(e) => setCs(e.target.value)}>
            <option value="">全部 CS 厂号</option>
            {meta.cs_codes.map((c) => {
              const n = minQ <= 10 ? c.loaded10 : minQ <= 30 ? c.loaded30 : c.loaded100;
              return <option key={c.cs_code} value={c.cs_code}>{`${c.cs_code}（${n > 0 ? n + " 项" : "0 项 · " + c.items + " 项未达门槛"}）`}</option>;
            })}
          </select>
        )}
        {meta.synced_at && <span className="muted small">{`库存同步 ${day(meta.synced_at)} ${meta.synced_at.slice(11, 16)}`}</span>}
        {reloading && <span className="muted small">更新中…</span>}
      </div>
      {meta.due_suppliers.length > 0 && (
        <p className="muted small">{`🔔 按订货周期，这几家该下单了：${meta.due_suppliers.map((s) => `${s.name}（距上次 ${s.days_since_po ?? "?"} 天 / 周期 ${s.order_cycle_days ?? "?"} 天）`).join(" · ")}`}</p>
      )}
      <ErrorBox error={error} />
      {data === null ? (!error && <p className="muted">载入中…（要几秒）</p>) : (
        <Suggest key={company + minQ + cs} company={company} meta={meta} data={data} cs={cs} minQ={minQ} onMinQ={setMinQ} onChanged={() => setTick((t) => t + 1)} />
      )}
      <p className="rpl-foot">
        口径：日均销量 = 近 90 天净销量 ÷ 90（分行提前预定的马桶 / 盆柜 / 水槽已剔除）；走量门槛只筛还有货的商品——欠分行或现存 ≤ 0 的一律列出（名单只含近 90 天有卖的商品）；
        现存 = 自有可卖库存（不含次品 / 展示仓，也不含 JB 仓——那是分行预定的货）；欠分行 = PRE (JB) 的负数，已直接加进建议订量并标「来不及」；在途 = 120 天内未收完的 PO。
        来不及 = 现存撑不到交期结束；该下单 = 现存 + 在途 ≤ 交期 + 安全天数。建议订量 =（交期 + 安全 + 覆盖）× 订货日均 + 欠分行 − 现存 − 在途；
        中国厂默认 60 + 14 + 30 天（每月都下单，单量只需覆盖到下一单）。订货日均 = 年均销速与去年同期取较大，「还能卖几天」仍按近 90 天算。
        资料是 AutoCount 每天同步的数字，不是即时的。
      </p>
    </>
  );
}

type Group = { key: string; name: string; china: boolean; billers: Set<string>; css: Set<string>; rows: RplRow[] };

function Suggest({ company, meta, data, cs, minQ, onMinQ, onChanged }: { company: string; meta: RplMeta; data: RplRows; cs: string; minQ: number; onMinQ: (q: number) => void; onChanged: () => void }) {
  const sup = meta.supplier;
  const prices = meta.prices;
  const canEdit = meta.can_edit;
  const [scope, setScope] = useState<"need" | "all">("need");
  const [groupBy, setGroupBy] = useState<"brand" | "sup">("brand");
  const [supFilter, setSupFilter] = useState("");
  const [q, setQ] = useState("");
  const [showHandled, setShowHandled] = useState(false);
  const [owedOnly, setOwedOnly] = useState(false);
  const [oosOnly, setOosOnly] = useState(false);
  const [qtyEdit, setQtyEdit] = useState<Record<string, string>>({});
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [openSetting, setOpenSetting] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const rows = data.rows;

  const keyOf = (r: RplRow) => groupBy === "brand" || !sup ? (r.item_type ?? "(无品牌)") : (r.supplier_code ?? "(none)");
  const nameOf = (r: RplRow) => groupBy === "brand" || !sup ? (r.item_type ?? "（无品牌）") : (r.supplier_name ?? "未知供应商（无采购记录）");

  const shown = useMemo(() => {
    const k = q.trim().toLowerCase();
    return rows.filter((r) =>
      (!owedOnly || Number(r.owed_branch) > 0) &&
      (!oosOnly || Number(r.on_hand) <= 0) &&
      (scope === "all" || r.urgency !== "ok") &&
      (showHandled || !r.action_status) &&
      (!supFilter || (r.supplier_code ?? "(none)") === supFilter) &&
      (!k || r.item_code.toLowerCase().includes(k) || r.description.toLowerCase().includes(k)));
  }, [rows, q, supFilter, showHandled, scope, owedOnly, oosOnly]);

  // 凑柜候选：同组、不紧急但 30 天内也要补的商品（只在「需要处理」视角，没勾「只看…」时）
  const fillMap = useMemo(() => {
    const m = new Map<string, RplRow[]>();
    if (scope === "all" || owedOnly || oosOnly) return m;
    const k = q.trim().toLowerCase();
    for (const r of rows) {
      if (!r.fill_candidate || r.action_status || r.urgency !== "ok") continue;  // 断货 / 来不及的已在上面的表
      if (supFilter && (r.supplier_code ?? "(none)") !== supFilter) continue;
      if (k && !r.item_code.toLowerCase().includes(k) && !r.description.toLowerCase().includes(k)) continue;
      const key = keyOf(r);
      const l = m.get(key) ?? []; l.push(r); m.set(key, l);
    }
    return m;
  }, [rows, scope, q, supFilter, groupBy, owedOnly, oosOnly, sup]); // eslint-disable-line react-hooks/exhaustive-deps

  const suppliers = useMemo(() => {
    const m = new Map<string, { name: string; n: number }>();
    if (!sup) return [] as [string, { name: string; n: number }][];
    for (const r of rows) {
      const key = r.supplier_code ?? "(none)";
      const cur = m.get(key) ?? { name: r.supplier_name ?? "未知供应商", n: 0 };
      cur.n++; m.set(key, cur);
    }
    return [...m.entries()].sort((a, b) => b[1].n - a[1].n);
  }, [rows, sup]);

  const groups = useMemo(() => {
    const m = new Map<string, Group>();
    for (const r of shown) {
      const key = keyOf(r);
      const g = m.get(key) ?? { key, name: nameOf(r), china: r.is_china, billers: new Set<string>(), css: new Set<string>(), rows: [] };
      g.rows.push(r);
      if (sup && groupBy === "brand" && r.supplier_name && !r.supplier_name.includes("未指定")) g.billers.add(r.supplier_name);
      if (r.cs_code) g.css.add(r.cs_code);
      m.set(key, g);
    }
    const score = (rs: RplRow[]) => rs.filter((r) => r.urgency !== "ok").length * 1000 + rs.length;
    return [...m.values()].sort((a, b) => score(b.rows) - score(a.rows));
  }, [shown, groupBy, sup]); // eslint-disable-line react-hooks/exhaustive-deps

  const qtyOf = (r: RplRow) => Number(qtyEdit[r.item_code] ?? r.suggest_qty);
  const totalNeed = rows.filter((r) => r.urgency !== "ok" && !r.action_status).length;
  const oosN = rows.filter((r) => Number(r.on_hand) <= 0).length;
  const owedN = rows.filter((r) => Number(r.owed_branch) > 0).length;
  const totalAmt = prices ? shown.reduce((s, r) => s + qtyOf(r) * Number(r.last_price ?? 0), 0) : null;

  async function act(item: string, action: "ordered" | "skip", qty: number | null, until: string | null) {
    setBusy(item); setError("");
    try { await rpl.action({ company, item_code: item, action, qty, until_date: until }); onChanged(); }
    catch (e) { setError((e as Error).message); }
    setBusy(null);
  }
  async function undo(id: number) {
    setError("");
    try { await rpl.undo(id); onChanged(); } catch (e) { setError((e as Error).message); }
  }

  function whatsappRows(list: RplRow[], groupName: string) {
    const d = new Date();
    const head = `${groupName} 订货 ${d.getDate()}/${d.getMonth() + 1}:`;
    const lines = list.map((r, i) => `${i + 1}. ${r.description} (${r.item_code}) ×${fmtQty(qtyOf(r))}${r.base_uom ? " " + r.base_uom : ""}`);
    navigator.clipboard?.writeText([head, ...lines].join("\n")).then(
      () => window.alert(ui(`已复制 ${list.length} 行 WhatsApp 格式，直接贴给供应商。`)),
      () => window.alert(ui("复制失败。")));
  }
  function exportRows(list: RplRow[], groupName: string) {
    const head = ["商品编码", "商品名称", "单位", "现存", "在途", "日均销量", "还能卖(天)", "建议订量", ...(prices ? ["上次单价"] : []), ...(sup ? ["供应商"] : [])].map(ui);
    const lines = list.map((r) => [r.item_code, r.description, r.base_uom ?? "", r.on_hand, r.transit_qty, r.daily_avg, r.days_left ?? "", qtyOf(r),
      ...(prices ? [r.last_price ?? ""] : []), ...(sup ? [r.supplier_name ?? ""] : [])]);
    const csv = String.fromCharCode(0xfeff) + [head, ...lines].map((a) => a.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${ui("订货单")}-${groupName.replace(/[\\/:*?"<>|]/g, "_")}-${plusDays(0)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  const csSel = cs ? meta.cs_codes.find((c) => c.cs_code === cs) : null;
  return (
    <>
      <div className="rpl-filters">
        <div className="tabs">
          <button className={scope === "need" ? "on" : ""} onClick={() => setScope("need")}>需要处理</button>
          <button className={scope === "all" ? "on" : ""} onClick={() => setScope("all")}>全部走量品</button>
        </div>
        {sup && (
          <div className="tabs">
            <button className={groupBy === "brand" ? "on" : ""} onClick={() => setGroupBy("brand")}>按品牌（厂）</button>
            <button className={groupBy === "sup" ? "on" : ""} onClick={() => setGroupBy("sup")}>按开单公司</button>
          </div>
        )}
        {sup && suppliers.length > 0 && (
          <select value={supFilter} onChange={(e) => setSupFilter(e.target.value)}>
            <option value="">全部供应商</option>
            {suppliers.map(([k, v]) => <option key={k} value={k}>{`${v.name}（${v.n}）`}</option>)}
          </select>
        )}
        <input className="search" type="search" placeholder="搜商品代号 / 品名…" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="check"><input type="checkbox" checked={showHandled} onChange={(e) => setShowHandled(e.target.checked)} /> 显示已处理</label>
        <label className="check"><input type="checkbox" checked={owedOnly} onChange={(e) => setOwedOnly(e.target.checked)} /> {`只看欠分行（${owedN}）`}</label>
        <label className="check"><input type="checkbox" checked={oosOnly} onChange={(e) => setOosOnly(e.target.checked)} /> {`只看没货（${oosN}）`}</label>
      </div>
      <p className="muted small">
        {`待处理 ${totalNeed} 项 · 当前显示 ${shown.length} 项${totalAmt != null ? ` · 建议采购额约 ${fmtRM(totalAmt)}` : ""}${data.capped ? " · 符合条件的超过 3000 项，只载入最急的 3000 项（请把门槛调高或先选厂号）" : ""}`}
      </p>
      {csSel && rows.length === 0 && (
        <p className="muted small">{`厂号 ${csSel.cs_code}：有 ${csSel.items} 个商品近 90 天有卖，但每个都不到门槛、也都还有货，所以没列出来。`}
          {minQ > 10 && csSel.loaded10 > 0 && <> <button className="small ghost" onClick={() => onMinQ(10)}>{`把走量门槛切到 10 就会出现 ${csSel.loaded10} 项`}</button></>}
        </p>
      )}
      <ErrorBox error={error} />
      {groups.length === 0 ? <Empty>没有需要处理的商品 👍</Empty> : groups.map((g) => {
        const isCollapsed = collapsed.has(g.key);
        const fill = fillMap.get(g.key) ?? [];
        const sel = [...g.rows, ...fill].filter((r) => checked.has(r.item_code));
        const exportList = sel.length ? sel : g.rows;
        const urgent = g.rows.filter((r) => r.urgency !== "ok").length;
        return (
          <div className="card rpl-group" key={g.key}>
            <div className="rpl-head">
              <span className="fold" onClick={() => { const s = new Set(collapsed); isCollapsed ? s.delete(g.key) : s.add(g.key); setCollapsed(s); }}>{isCollapsed ? "▸" : "▾"}</span>
              <h3>{g.name}</h3>
              {g.css.size > 0 && <span className="tag">{[...g.css].join(" / ")}</span>}
              <span className="muted small">{g.china ? `中国厂 · 交期 ${g.rows[0].lead_days} 天` : `交期 ${g.rows[0].lead_days} 天 + 安全 ${g.rows[0].safety_days} 天`}</span>
              {g.billers.size > 0 && <span className="muted small">{`开单：${[...g.billers].slice(0, 2).join("、")}${g.billers.size > 2 ? "…" : ""}`}</span>}
              {urgent > 0 && <span className="urg late">{`${urgent} 项紧急`}</span>}
              <span className="muted small">{`共 ${g.rows.length} 项${prices ? ` · 约 ${fmtRM(g.rows.reduce((s, r) => s + qtyOf(r) * Number(r.last_price ?? 0), 0))}` : ""}`}</span>
              <span className="spacer" />
              <button className="small ghost" onClick={() => whatsappRows(exportList, g.name)}>📱 WhatsApp</button>
              <button className="small ghost" onClick={() => exportRows(exportList, g.name)}>{sel.length ? `📋 导出订货单（已勾选 ${sel.length}）` : "📋 导出订货单（全部）"}</button>
            </div>
            {!isCollapsed && (
              <div className="table-wrap">
                <table>
                  <thead><tr>
                    <th></th><th>商品</th><th className="num">现存</th><th className="num hide-sm">在途</th><th className="num hide-sm">日均</th>
                    <th className="num">还能卖</th><th>状态</th><th className="num">建议订量</th>{prices && <th className="num hide-sm">上次单价</th>}{canEdit && <th>操作</th>}
                  </tr></thead>
                  <tbody>
                    {g.rows.map((r) => (
                      <Fragment key={r.item_code}>
                        <tr className={r.action_status ? "rpl-done" : undefined}>
                          <td><input type="checkbox" checked={checked.has(r.item_code)} onChange={(e) => {
                            const s = new Set(checked); e.target.checked ? s.add(r.item_code) : s.delete(r.item_code); setChecked(s);
                          }} /></td>
                          <td className="rpl-item">
                            <b>{r.item_code}</b> <span className="muted small">{r.base_uom}</span>
                            <div className="small">{r.description}</div>
                            <div className="rpl-note">
                              {[r.item_group, r.by_loc,
                                Number(r.q90_branch_excl) > 0 ? `分行预定 ${fmtQty(r.q90_branch_excl)} 件已剔除` : "",
                                sup && r.last_po_name && r.last_po_name !== r.supplier_name ? `上次 PO：${r.last_po_name}` : "",
                                r.last_receipt_date ? `最后进货 ${day(r.last_receipt_date)}` : ""].filter(Boolean).join(" · ")}
                            </div>
                          </td>
                          <td className={"num" + (Number(r.on_hand) <= 0 ? " rpl-neg" : "")}>
                            {fmtQty(r.on_hand)}
                            {Number(r.owed_branch) > 0 && <div className="rpl-neg small">{`欠分行 ${fmtQty(r.owed_branch)}`}</div>}
                            {Number(r.jb_reserved) > 0 && <div className="rpl-note">{`JB 留 ${fmtQty(r.jb_reserved)}`}</div>}
                          </td>
                          <td className="num hide-sm" title={r.transit_pos ?? ""}>
                            {Number(r.transit_qty) > 0 ? <>{fmtQty(r.transit_qty)}<div className="rpl-note">{day(r.transit_eta)}</div></> : <span className="muted">—</span>}
                          </td>
                          <td className="num hide-sm">{n1(r.daily_avg)}<div className="rpl-note" title="订货量按年均日销与去年同期取较大；近 90 天只用于断货预警">{`订货按 ${Number(r.order_rate).toFixed(2)}/天`}</div></td>
                          <td className="num">
                            {r.days_left == null ? "—" : <span className={r.days_left < r.lead_days ? "rpl-neg" : ""}>{`${r.days_left} 天`}</span>}
                            {Number(r.transit_qty) > 0 && r.days_left_incl_transit != null && <div className="rpl-note">{`含在途 ${r.days_left_incl_transit}`}</div>}
                          </td>
                          <td>
                            <span className={"urg " + r.urgency}>{URGENCY_LABEL[r.urgency]}</span>
                            {r.action_status === "ordered" && <div className="rpl-note">{`已下单 ${r.action_qty ? fmtQty(r.action_qty) : ""} · ${day(r.action_at)}`}</div>}
                            {r.action_status === "skip" && <div className="rpl-note">{r.until_date ? `暂不订至 ${day(r.until_date)}` : "暂不订"}</div>}
                            {r.action_note && <div className="rpl-note" title={r.action_note}>💬 {r.action_note.slice(0, 30)}</div>}
                          </td>
                          <td className="num">
                            <input className="rpl-qty" type="number" min={0} value={qtyEdit[r.item_code] ?? r.suggest_qty}
                                   onChange={(e) => setQtyEdit({ ...qtyEdit, [r.item_code]: e.target.value })} />
                            {r.min_order_qty ? <div className="rpl-note">{`起订 ${fmtQty(r.min_order_qty)}`}</div> : null}
                          </td>
                          {prices && <td className="num hide-sm">{r.last_price != null ? fmtRM(r.last_price) : <span className="muted">—</span>}
                            {r.last_po_date && <div className="rpl-note">{day(r.last_po_date)}</div>}</td>}
                          {canEdit && (
                            <td className="rpl-ops">
                              {!r.action_status && (
                                <>
                                  <button className="small" disabled={busy === r.item_code} onClick={() => act(r.item_code, "ordered", qtyOf(r), null)}>已下单</button>{" "}
                                  <button className="small ghost" disabled={busy === r.item_code} onClick={() => act(r.item_code, "skip", null, plusDays(14))}>暂不订（2 周）</button>{" "}
                                </>
                              )}
                              {r.action_status && r.action_id && <button className="small ghost" onClick={() => undo(r.action_id!)}>撤销</button>}{" "}
                              <button className="small ghost" onClick={() => setOpenSetting(openSetting === r.item_code ? null : r.item_code)} aria-label="商品设定">⚙</button>
                            </td>
                          )}
                        </tr>
                        {canEdit && openSetting === r.item_code && (
                          <tr><td colSpan={prices ? 10 : 9}>
                            <ItemSetting company={company} r={r} sup={sup} onSaved={() => { setOpenSetting(null); onChanged(); }} />
                          </td></tr>
                        )}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
                {fill.length > 0 && (
                  <details className="rpl-fill">
                    <summary>🚢 <b>{`凑柜建议：还有 ${fill.length} 项 30 天内也要补`}</b>{prices && <span className="muted">{`（约 ${fmtRM(fill.reduce((s, r) => s + qtyOf(r) * Number(r.last_price ?? 0), 0))} · 反正要订，顺这一柜省运费）`}</span>}</summary>
                    <table>
                      <thead><tr><th></th><th>商品</th><th className="num">现存</th><th className="num">日均</th><th className="num">还能卖</th><th className="num">建议订量</th>{prices && <th className="num">上次单价</th>}</tr></thead>
                      <tbody>
                        {fill.map((r) => (
                          <tr key={r.item_code}>
                            <td><input type="checkbox" checked={checked.has(r.item_code)} onChange={(e) => {
                              const s = new Set(checked); e.target.checked ? s.add(r.item_code) : s.delete(r.item_code); setChecked(s);
                            }} /></td>
                            <td><b>{r.item_code}</b><div className="small">{r.description}</div></td>
                            <td className="num">{fmtQty(r.on_hand)}</td>
                            <td className="num">{n1(r.daily_avg)}</td>
                            <td className="num">{`${r.days_left_incl_transit ?? r.days_left ?? "—"} 天`}</td>
                            <td className="num"><input className="rpl-qty" type="number" min={0} value={qtyEdit[r.item_code] ?? r.suggest_qty}
                                                       onChange={(e) => setQtyEdit({ ...qtyEdit, [r.item_code]: e.target.value })} /></td>
                            {prices && <td className="num">{r.last_price != null ? fmtRM(r.last_price) : "—"}</td>}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </details>
                )}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

// ⚙ 商品设定：供应商（看得到厂家的人）、起订量、包装数、不再提醒、备注、本次留言
function ItemSetting({ company, r, sup, onSaved }: { company: string; r: RplRow; sup: boolean; onSaved: () => void }) {
  const [supplier, setSupplier] = useState(r.supplier_code ?? "");
  const [moq, setMoq] = useState(r.min_order_qty?.toString() ?? "");
  const [pack, setPack] = useState(r.pack_size?.toString() ?? "");
  const [note, setNote] = useState(r.item_note ?? "");
  const [ex, setEx] = useState(r.exclude);
  const [actNote, setActNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [allSup, setAllSup] = useState<SupplierRow[]>([]);
  useEffect(() => {
    if (sup) rpl.suppliers(company).then((s) => setAllSup(s.suppliers)).catch(() => {});
  }, [company, sup]);
  async function save() {
    setSaving(true); setError("");
    try {
      await rpl.saveItem({ company, item_code: r.item_code, supplier_code: sup ? supplier : "", min_order_qty: moq || null,
        pack_size: pack || null, exclude: ex, note, action_note: actNote });
      onSaved();
    } catch (e) { setError((e as Error).message); setSaving(false); }
  }
  return (
    <div className="rpl-setting">
      <div className="rpl-note" style={{ width: "100%" }}>
        {`${r.item_code} · 近 90 天售 ${fmtQty(r.q90)}（近 30 天 ${fmtQty(r.q30)}）· 最后销售 ${day(r.last_sale)} · 24 个月采购 ${r.po_24m ?? 0} 次${sup && r.transit_pos ? ` · 在途 PO：${r.transit_pos}` : ""}`}
      </div>
      {sup && (
        <label>供应商
          <select value={supplier} onChange={(e) => setSupplier(e.target.value)}>
            <option value="">（按上次采购）</option>
            {allSup.map((s) => <option key={s.creditor_code} value={s.creditor_code}>{s.name}</option>)}
          </select>
        </label>
      )}
      <label>起订量<input type="number" className="rpl-qty" value={moq} onChange={(e) => setMoq(e.target.value)} /></label>
      <label>包装数<input type="number" className="rpl-qty" value={pack} onChange={(e) => setPack(e.target.value)} /></label>
      <label className="check"><input type="checkbox" checked={ex} onChange={(e) => setEx(e.target.checked)} /> 不再提醒此商品</label>
      <label className="grow">商品备注（长期）<input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} /></label>
      <label className="grow">本次留言<input value={actNote} onChange={(e) => setActNote(e.target.value)} maxLength={500} placeholder="例：已问供应商，下周到" /></label>
      <ErrorBox error={error} />
      <button disabled={saving} onClick={save}>{saving ? "储存中…" : "储存"}</button>
    </div>
  );
}
