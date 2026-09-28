import { FormEvent, useCallback, useEffect, useState } from "react";
import {
  api, BRANCH_LABEL, can, ETA_SOURCE_LABEL, fmtAgo, fmtDate, fmtQty, fmtRM, ItemEta, Me, PO_STATUS_LABEL, PoDetail, PoRow,
  PoStatus, Shipment, SHIPMENT_STATUS_LABEL, ShipmentStatus, SyncStatus,
} from "../api";
import { go } from "../router";
import { Empty, ErrorBox, Modal, Tabs } from "../ui";

type Tab = "po" | "shipments" | "item";

// 路由：#/purchasing（PO）、#/purchasing/shipments、#/purchasing/item、#/purchasing/po/<公司>/<PO 号>
export default function Purchasing({ me, sub, arg1, arg2 }: { me: Me; sub?: string; arg1?: string; arg2?: string }) {
  const tab: Tab = sub === "shipments" ? "shipments" : sub === "item" ? "item" : "po";
  const canEdit = can(me, "purchasing", "edit");
  return (
    <>
      <h1>订货与 ETA</h1>
      <div className="filters">
        <Tabs value={tab} onChange={(t) => go(t === "po" ? "/purchasing" : `/purchasing/${t}`)}
              options={[["po", "未到货 PO"], ["shipments", "货柜"], ["item", "查 SKU 到货"]]} />
      </div>
      <SyncNote />
      {tab === "po" && <PoTab me={me} canEdit={canEdit} />}
      {tab === "shipments" && <ShipmentTab me={me} canEdit={canEdit} />}
      {tab === "item" && <ItemTab />}
      {sub === "po" && arg1 && arg2 && (
        <PoDetailModal company={decodeURIComponent(arg1)} poNo={decodeURIComponent(arg2)}
                       onClose={() => go("/purchasing")} />
      )}
    </>
  );
}

// AutoCount 的 PO / 库存不是即时的：告诉员工资料更新到几点，免得以为系统错了
function SyncNote() {
  const [rows, setRows] = useState<SyncStatus[] | null>(null);
  useEffect(() => {
    api.syncStatus().then(setRows).catch(() => setRows(null));
  }, []);
  if (!rows || rows.length === 0) return null;
  const stale = rows.some((r) => !r.purchase || Date.now() - new Date(r.purchase).getTime() > 26 * 3600 * 1000);
  return (
    <p className={"muted small sync" + (stale ? " late" : "")}>
      AutoCount 资料更新：
      {rows.map((r, n) => (
        <span key={r.company}>
          {n > 0 && " · "}
          {rows.length > 1 && `${BRANCH_LABEL[r.company]} `}PO {fmtAgo(r.purchase)}、库存 {fmtAgo(r.stock)}
        </span>
      ))}
      {stale ? "（超过一天没更新，请通知管理员检查同步）" : "（刚在 AutoCount 做的单，要等下一次同步才会出现）"}
    </p>
  );
}

const poHref = (r: { company: string; po_no: string }) =>
  `/purchasing/po/${encodeURIComponent(r.company)}/${encodeURIComponent(r.po_no)}`;

function EtaCell({ r }: { r: Pick<PoRow, "eta" | "eta_source" | "overdue" | "days_late"> }) {
  return (
    <>
      <span className={r.overdue ? "late" : ""}>{r.eta}</span>
      {r.overdue && <span className="late"> · 迟 {r.days_late} 天</span>}
      <br /><small className="muted">{ETA_SOURCE_LABEL[r.eta_source]}</small>
    </>
  );
}

// ------------------------------------------------------------------ 未到货 PO
function PoTab({ me, canEdit }: { me: Me; canEdit: boolean }) {
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [company, setCompany] = useState("");
  const [status, setStatus] = useState("open");
  const [overdue, setOverdue] = useState(false);
  const [stale, setStale] = useState(false);
  const [china, setChina] = useState("");
  const [rows, setRows] = useState<PoRow[] | null>(null);
  const [error, setError] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [bulk, setBulk] = useState(false);

  const load = useCallback(() => {
    setError("");
    setRows(null);
    api.poList({ q: query, company, status, overdue, stale, china })
      .then((r) => { setRows(r); setPicked(new Set()); })
      .catch((e: Error) => setError(e.message));
  }, [query, company, status, overdue, stale, china]);
  useEffect(load, [load]);
  // 从明细弹窗改完回来时重新载入
  useEffect(() => {
    const on = () => { if (window.location.hash === "#/purchasing") load(); };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, [load]);

  const key = (r: PoRow) => `${r.company}|${r.po_no}`;
  const pickedRows = (rows ?? []).filter((r) => picked.has(key(r)));
  const pickedCompanies = new Set(pickedRows.map((r) => r.company));
  const showAmt = rows?.some((r) => r.open_amt != null);

  function toggle(r: PoRow) {
    const next = new Set(picked);
    if (next.has(key(r))) next.delete(key(r)); else next.add(key(r));
    setPicked(next);
  }

  return (
    <>
      <form className="toolbar" onSubmit={(e) => { e.preventDefault(); setQuery(q.trim()); }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜 PO 号、供应商、货柜、SKU、品名…" />
        <button>搜寻</button>
        {me.staff.branch === "ALL" && (
          <select value={company} onChange={(e) => setCompany(e.target.value)}>
            <option value="">全部分店</option>
            <option value="HOMEWORKSSB">{BRANCH_LABEL.HOMEWORKSSB}</option>
            <option value="HOMEWORKSSOUTHERN">{BRANCH_LABEL.HOMEWORKSSOUTHERN}</option>
          </select>
        )}
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="open">全部状态（不含关闭）</option>
          {Object.entries(PO_STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          <option value="all">全部（含关闭）</option>
        </select>
        <select value={china} onChange={(e) => setChina(e.target.value)}>
          <option value="">中国 + 本地</option>
          <option value="china">只看中国货</option>
          <option value="local">只看本地</option>
        </select>
        <label className="check"><input type="checkbox" checked={overdue} onChange={(e) => setOverdue(e.target.checked)} /> 只看逾期</label>
        <label className="check"><input type="checkbox" checked={stale} onChange={(e) => setStale(e.target.checked)} /> 含 120 天以上旧单</label>
      </form>
      <ErrorBox error={error} />
      {rows && (
        <p className="muted small">
          {rows.length} 张 PO · 逾期 {rows.filter((r) => r.overdue).length} 张
          {showAmt && ` · 未到货金额 ${fmtRM(rows.reduce((s, r) => s + Number(r.open_amt ?? 0), 0))}`}
          {!stale && " · 120 天以上没人跟进的旧单已隐藏"}
        </p>
      )}
      {canEdit && picked.size > 0 && (
        <div className="bulkbar">
          已选 {picked.size} 张
          {pickedCompanies.size > 1
            ? <span className="muted">（跨分店不能一起改）</span>
            : <button onClick={() => setBulk(true)}>批量更新（状态 / ETA / 货柜）</button>}
          <button className="ghost" onClick={() => setPicked(new Set())}>取消选取</button>
        </div>
      )}
      {rows === null ? <p className="muted">{error ? "" : "载入中…"}</p> : rows.length === 0 ? <Empty>没有符合的 PO。</Empty> : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                {canEdit && <th></th>}
                <th>PO / 供应商</th><th className="hide-sm">开单</th><th>ETA</th><th>状态</th>
                <th className="hide-sm">货柜</th><th className="num">未到</th>{showAmt && <th className="num hide-sm">金额</th>}
                <th className="hide-sm">备注</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={key(r)} className={"click" + (r.status === "closed" ? " inactive" : "")} onClick={() => go(poHref(r))}>
                  {canEdit && (
                    <td onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" checked={picked.has(key(r))} onChange={() => toggle(r)} aria-label={`选取 ${r.po_no}`} />
                    </td>
                  )}
                  <td>
                    <b>{r.po_no}</b>{r.is_china && <span className="tag">中国</span>}
                    {me.staff.branch === "ALL" && <span className="tag">{BRANCH_LABEL[r.company]}</span>}
                    <br /><span className="muted">{r.creditor_name}</span>
                  </td>
                  <td className="hide-sm nowrap">{r.po_date}<br /><small className="muted">{r.days_open} 天</small></td>
                  <td className="nowrap"><EtaCell r={r} /></td>
                  <td><span className={"po " + r.status}>{PO_STATUS_LABEL[r.status]}</span></td>
                  <td className="hide-sm">{r.shipment_name ?? ""}</td>
                  <td className="num">{fmtQty(r.open_qty)}<br /><small className="muted">{r.lines} 项</small></td>
                  {showAmt && <td className="num hide-sm">{fmtRM(r.open_amt)}</td>}
                  <td className="hide-sm remark">{r.remark}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {bulk && pickedRows.length > 0 && (
        <PoEditForm company={pickedRows[0].company} poNos={pickedRows.map((r) => r.po_no)} bulk
                    onClose={() => setBulk(false)} onSaved={() => { setBulk(false); load(); }} />
      )}
    </>
  );
}

// 单张或批量：批量时只送有改的栏位
function PoEditForm({ company, poNos, current, bulk, onClose, onSaved }: {
  company: string; poNos: string[]; current?: PoDetail; bulk?: boolean; onClose: () => void; onSaved: () => void;
}) {
  const [status, setStatus] = useState<string>(bulk ? "" : current?.status ?? "ordered");
  const [eta, setEta] = useState(bulk ? "" : current?.po_eta ?? "");
  const [clearEta, setClearEta] = useState(false);
  const [shipmentId, setShipmentId] = useState<string>(bulk ? "" : current?.shipment_id ? String(current.shipment_id) : "");
  const [remark, setRemark] = useState(bulk ? "" : current?.remark ?? "");
  const [ships, setShips] = useState<Shipment[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.shipments().then((s) => setShips(s.filter((x) => x.company === company))).catch(() => {});
  }, [company]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const p: Record<string, unknown> = {};
    if (bulk) {
      if (status) p.status = status;
      if (eta || clearEta) p.eta = clearEta ? "" : eta;
      if (shipmentId) p.shipment_id = shipmentId === "none" ? "" : shipmentId;
      if (remark.trim()) p.remark = remark;
      if (Object.keys(p).length === 0) return setError("没有要改的栏位。");
    } else {
      Object.assign(p, { status, eta, shipment_id: shipmentId, remark });
    }
    setBusy(true);
    setError("");
    try {
      await api.updatePos(company, poNos, p);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal title={bulk ? `批量更新 ${poNos.length} 张 PO` : `更新 ${poNos[0]}`} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        {bulk && <p className="muted">留空的栏位不会改。{poNos.join("、")}</p>}
        <div className="row">
          <label>状态
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              {bulk && <option value="">（不改）</option>}
              {Object.entries(PO_STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
          <label>预计到货日（ETA）
            <input type="date" value={eta} disabled={clearEta} onChange={(e) => setEta(e.target.value)} />
          </label>
        </div>
        {bulk && <label className="check"><input type="checkbox" checked={clearEta} onChange={(e) => setClearEta(e.target.checked)} /> 清掉手填的 ETA（回到 AutoCount / 交期推算）</label>}
        <label>货柜（挂上后 ETA 以货柜为准）
          <select value={shipmentId} onChange={(e) => setShipmentId(e.target.value)}>
            <option value={bulk ? "" : ""}>{bulk ? "（不改）" : "（没有）"}</option>
            {bulk && <option value="none">从货柜拿掉</option>}
            {ships.map((s) => <option key={s.id} value={s.id}>{s.name}{s.eta ? ` · ETA ${s.eta}` : ""} · {SHIPMENT_STATUS_LABEL[s.status]}</option>)}
          </select>
        </label>
        <label>备注{bulk && <small className="muted">（填了会覆盖每张的备注）</small>}
          <textarea rows={2} value={remark} onChange={(e) => setRemark(e.target.value)} placeholder="例：供应商说 10/15 出货；缺 2 项另补" />
        </label>
        <ErrorBox error={error} />
        <div className="actions">
          <button type="button" className="ghost" onClick={onClose}>取消</button>
          <button disabled={busy}>{busy ? "储存中…" : "储存"}</button>
        </div>
      </form>
    </Modal>
  );
}

function PoDetailModal({ company, poNo, onClose }: { company: string; poNo: string; onClose: () => void }) {
  const [po, setPo] = useState<PoDetail | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);

  const load = useCallback(() => {
    api.po(company, poNo).then(setPo).catch((e: Error) => setError(e.message));
  }, [company, poNo]);
  useEffect(load, [load]);

  if (editing && po)
    return <PoEditForm company={company} poNos={[poNo]} current={po}
                       onClose={() => setEditing(false)} onSaved={() => { setEditing(false); load(); }} />;

  const showPrice = po?.items.some((i) => i.unit_price != null);
  return (
    <Modal title={`${poNo}${po ? " · " + po.creditor_name : ""}`} onClose={onClose} wide>
      <ErrorBox error={error} />
      {!po ? <p className="muted">{error ? "" : "载入中…"}</p> : (
        <>
          <dl>
            <dt>状态</dt><dd><span className={"po " + po.status}>{PO_STATUS_LABEL[po.status]}</span></dd>
            <dt>ETA</dt><dd><EtaCell r={po} /></dd>
            <dt>开单</dt><dd>{po.po_date}（{po.days_open} 天前）· {BRANCH_LABEL[po.company]} · 入 {po.locations}</dd>
            <dt>供应商</dt><dd>{po.supplier_name}（{po.creditor_code}）{po.is_china && <span className="tag">中国</span>}</dd>
            {po.shipment_name && (<><dt>货柜</dt><dd>{po.shipment_name}{po.shipment_status && ` · ${SHIPMENT_STATUS_LABEL[po.shipment_status]}`}</dd></>)}
            {po.remark && (<><dt>备注</dt><dd className="pre">{po.remark}</dd></>)}
            {po.updated_by_name && (<><dt>最后更新</dt><dd>{po.updated_by_name} · {fmtDate(po.updated_at)}</dd></>)}
          </dl>
          {po.can_edit && (
            <div className="actions left">
              <button onClick={() => setEditing(true)}>更新状态 / ETA / 货柜</button>
            </div>
          )}
          <h3>未到货项目（{po.items.length}）</h3>
          <div className="table-wrap">
            <table>
              <thead><tr><th>SKU / 品名</th><th className="num">订</th><th className="num">已到</th><th className="num">未到</th>
                {showPrice && <th className="num hide-sm">单价</th>}{showPrice && <th className="num hide-sm">金额</th>}</tr></thead>
              <tbody>
                {po.items.map((i, n) => (
                  <tr key={n}>
                    <td><b>{i.item_code}</b> <span className="muted">{i.uom}</span><br /><small>{i.description}</small></td>
                    <td className="num">{fmtQty(i.qty)}</td><td className="num">{fmtQty(i.received)}</td>
                    <td className="num"><b>{fmtQty(i.open_qty)}</b></td>
                    {showPrice && <td className="num hide-sm">{fmtRM(i.unit_price)}</td>}
                    {showPrice && <td className="num hide-sm">{fmtRM(i.open_amt)}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {po.receipts.length > 0 && (
            <>
              <h3>已收货纪录（AutoCount）</h3>
              <ul className="list">
                {po.receipts.slice(0, 20).map((r, n) => (
                  <li key={n}><span>{r.rcv_date} · {r.doc_no}（{r.src}）· {r.item_code}</span><span>{fmtQty(r.qty)}</span></li>
                ))}
              </ul>
            </>
          )}
          {po.history.length > 0 && (
            <>
              <h3>更新纪录</h3>
              <ul className="list">
                {po.history.map((h, n) => (
                  <li key={n}><span>{h.staff_name} · {fmtDate(h.at)}</span><span className="muted">{describeChange(h.data)}</span></li>
                ))}
              </ul>
            </>
          )}
          {!po.can_edit && <p className="muted">你可以查看，但只有采购可以更新。有问题可以在「任务」开一张给采购。</p>}
        </>
      )}
    </Modal>
  );
}

function describeChange(d: Record<string, string>): string {
  const parts: string[] = [];
  if (d.status) parts.push(`状态→${PO_STATUS_LABEL[d.status as PoStatus] ?? d.status}`);
  if ("eta" in d) parts.push(d.eta ? `ETA→${d.eta}` : "清掉 ETA");
  if ("shipment_id" in d) parts.push(d.shipment_id ? "挂上货柜" : "拿掉货柜");
  if (d.remark) parts.push(`备注：${d.remark}`);
  return parts.join("，");
}

// ------------------------------------------------------------------ 货柜
function ShipmentTab({ me, canEdit }: { me: Me; canEdit: boolean }) {
  const [rows, setRows] = useState<Shipment[] | null>(null);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  const [edit, setEdit] = useState<Shipment | "new" | null>(null);

  const load = useCallback(() => {
    api.shipments(done).then(setRows).catch((e: Error) => setError(e.message));
  }, [done]);
  useEffect(load, [load]);

  return (
    <>
      <div className="page-head">
        <p className="muted">中国货一个货柜装好几张 PO。先在这里建货柜，再到「未到货 PO」勾选 PO → 批量挂上货柜。货柜 ETA 一改，柜里所有 PO 的 ETA 跟着变；货柜设为「已出海 / 已到港」时，柜里的 PO 状态也会跟着往前推。</p>
        {canEdit && <button onClick={() => setEdit("new")}>＋ 新货柜</button>}
      </div>
      <label className="check"><input type="checkbox" checked={done} onChange={(e) => setDone(e.target.checked)} /> 显示已入仓 / 取消的货柜</label>
      <ErrorBox error={error} />
      {rows === null ? <p className="muted">载入中…</p> : rows.length === 0 ? <Empty>还没有货柜。</Empty> : (
        <div className="tiles">
          {rows.map((s) => (
            <div key={s.id} className={"tile" + (s.overdue ? " warn" : "")}>
              <b>{s.name} <span className={"sh " + s.status}>{SHIPMENT_STATUS_LABEL[s.status]}</span></b>
              <span>
                ETA <b className={s.overdue ? "late" : ""}>{s.eta ?? "未填"}</b>{s.etd && ` · 出货 ${s.etd}`}
                {s.forwarder && <><br />货代：{s.forwarder}</>}
                {me.staff.branch === "ALL" && <><br />{BRANCH_LABEL[s.company]}</>}
                <br />PO：{s.po_nos.length ? s.po_nos.join("、") : "（还没挂）"}
                {s.po_count > s.open_po_count && <small className="muted">（{s.po_count - s.open_po_count} 张已到齐）</small>}
                {s.remark && <><br /><span className="muted">{s.remark}</span></>}
              </span>
              <small className="muted">{s.updated_by_name ? `${s.updated_by_name} · ${fmtDate(s.updated_at)}` : ""}</small>
              {canEdit && <button className="small ghost" onClick={() => setEdit(s)}>修改</button>}
            </div>
          ))}
        </div>
      )}
      {edit && <ShipmentForm me={me} ship={edit === "new" ? undefined : edit} onClose={() => setEdit(null)}
                             onSaved={() => { setEdit(null); load(); }} />}
    </>
  );
}

function ShipmentForm({ me, ship, onClose, onSaved }: { me: Me; ship?: Shipment; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({
    company: ship?.company ?? (me.staff.branch === "ALL" ? "HOMEWORKSSB" : me.staff.branch),
    name: ship?.name ?? "", forwarder: ship?.forwarder ?? "", etd: ship?.etd ?? "", eta: ship?.eta ?? "",
    status: (ship?.status ?? "booked") as ShipmentStatus, remark: ship?.remark ?? "",
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api.saveShipment(ship ? { ...f, id: ship.id } : f);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal title={ship ? `修改货柜 ${ship.name}` : "新货柜"} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <div className="row">
          <label>柜号 / 批次名<input value={f.name} onChange={set("name")} required autoFocus placeholder="例：CS065-1025 或 TCLU1234567" /></label>
          {me.staff.branch === "ALL" && !ship && (
            <label>公司
              <select value={f.company} onChange={set("company")}>
                <option value="HOMEWORKSSB">{BRANCH_LABEL.HOMEWORKSSB}</option>
                <option value="HOMEWORKSSOUTHERN">{BRANCH_LABEL.HOMEWORKSSOUTHERN}</option>
              </select>
            </label>
          )}
        </div>
        <div className="row">
          <label>出货日（ETD）<input type="date" value={f.etd} onChange={set("etd")} /></label>
          <label>到仓日（ETA）<input type="date" value={f.eta} onChange={set("eta")} /></label>
        </div>
        <div className="row">
          <label>状态
            <select value={f.status} onChange={set("status")}>
              {Object.entries(SHIPMENT_STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
          <label>货代<input value={f.forwarder} onChange={set("forwarder")} /></label>
        </div>
        <label>备注<textarea rows={2} value={f.remark} onChange={set("remark")} /></label>
        <ErrorBox error={error} />
        <div className="actions">
          <button type="button" className="ghost" onClick={onClose}>取消</button>
          <button disabled={busy}>{busy ? "储存中…" : "储存"}</button>
        </div>
      </form>
    </Modal>
  );
}

// ------------------------------------------------------------------ 查 SKU 到货
function ItemTab() {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<ItemEta[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function search(e: FormEvent) {
    e.preventDefault();
    if (q.trim().length < 2) return setError("请至少输入 2 个字。");
    setBusy(true);
    setError("");
    try {
      setRows(await api.itemEta(q.trim()));
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(false);
  }

  return (
    <>
      <form className="toolbar" onSubmit={search}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="输入 SKU 或品名，例：ST001174、RAXON HOSE" autoFocus />
        <button disabled={busy}>{busy ? "查询中…" : "查询"}</button>
      </form>
      <ErrorBox error={error} />
      {rows && (rows.length === 0 ? <Empty>找不到这个商品。</Empty> : (
        <div className="item-list">
          {rows.map((i) => (
            <div key={i.company + i.item_code} className="card">
              <b>{i.item_code}</b> <span className="muted">{i.uom} · {BRANCH_LABEL[i.company]}</span>
              <div>{i.description}</div>
              <div className="stock">
                现有库存 <b>{fmtQty(i.on_hand)}</b>
                {Object.keys(i.by_loc).length > 0 && (
                  <span className="muted">（{Object.entries(i.by_loc).map(([l, n]) => `${l} ${fmtQty(n)}`).join("、")}）</span>
                )}
              </div>
              {i.incoming.length === 0 ? <div className="muted">没有在路上的货。</div> : (
                <ul className="list">
                  {i.incoming.map((x, n) => (
                    <li key={n}>
                      <span>
                        <a href={`#${poHref({ company: i.company, po_no: x.po_no })}`}>{x.po_no}</a>
                        <span className="muted"> · {x.supplier_name}{x.shipment_name ? ` · 柜 ${x.shipment_name}` : ""} · {PO_STATUS_LABEL[x.status]}</span>
                      </span>
                      <span className={x.overdue ? "late" : ""}>
                        {fmtQty(x.open_qty)} 件 · {x.eta}{x.overdue ? "（已过期，待确认）" : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      ))}
    </>
  );
}
