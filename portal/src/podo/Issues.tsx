// 厂家问题：少发 / 多发 / 发错型号 / 缺零件（确认 DO 时自动记）、坏货 / 到货少 / 来错（点货或手动记）。按厂家分组，代理底下再按
// CS 工厂分组；每组「厂家还欠」（少发未决定 / 厂家会补还没补齐、缺零件还没处理）可以 WhatsApp 催货。一次提醒一家：下载 Excel、打印（存 PDF）。
// 少发：之后同厂家的 DO 在那张 PO 出了这个型号会自动扣掉；要决定「厂家会补」（超出 PO 的也先补它）或「取消（下次再订）」。
// 缺零件跟少发一样选厂家会补 / 取消，但不影响在路上与少发数量。来错的型号、坏货、缺零件、多发可以记「要厂家怎么处理」。
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { BRANCH_LABEL, fmtDate, fmtQty, Me, todayKL } from "../api";
import { Empty, ErrorBox, Modal } from "../ui";
import { getLang } from "../i18n";
import {
  dateKL, DECISION_LABEL, DoHeader, Issue, ISSUE_KIND_LABEL, ISSUE_STATUS_LABEL, IssueKind, issueKindLabel, IssueRequest, joinList,
  num, podo, requestLabel, requestOptions, ui,
} from "../podo-api";
import { AskModal, IssueBadges, NOT_PICKED, OurItemPicker, Picked, RequestSelect } from "./common";
import { WaModal, waIssuesText, waOwedText } from "./whatsapp";

// ------------------------------------------------------------------ 共用：问题的文字
/** 型号栏：发错型号写「订 X 收到 Y」；缺零件写「X 缺「零件」」 */
export function issueModel(i: Pick<Issue, "kind" | "item_code" | "received_code"> & { part_name?: string }): string {
  if (i.kind === "part") return `${i.item_code ? i.item_code + " " : ""}缺「${i.part_name ?? ""}」`;
  if (i.kind !== "wrong") return i.item_code ?? "";
  if (i.item_code && i.received_code) return `订 ${i.item_code} 收到 ${i.received_code}`;
  if (i.received_code) return `收到 ${i.received_code}`;
  return i.item_code ? `订 ${i.item_code}` : "";
}

/** 处理栏：决定 / 状态 + 已补多少 + 处理说明 */
export function issueHandling(i: Issue): string {
  const parts: string[] = [];
  const decidable = i.kind === "short" || i.kind === "part";
  if (decidable && i.decision) parts.push(DECISION_LABEL[i.decision]);
  if (i.status !== "open" || !decidable) parts.push(ISSUE_STATUS_LABEL[i.status]);
  if (i.resolved_qty > 0) parts.push(`已补 ${fmtQty(i.resolved_qty)}`);
  if (i.action_note) parts.push(i.action_note);
  return parts.join(" · ");
}

const ISSUE_QTY = (i: Issue) => (i.status === "open" ? i.open_qty : i.qty);

// ------------------------------------------------------------------ 处理按钮
type Act = "await" | "cancel" | "pending" | "resolve" | "reopen" | "note" | "void" | "request";
export function IssueActions({ i, onDone }: { i: Issue; onDone: () => void }) {
  const [ask, setAsk] = useState<Act | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const run = async (a: Act, note?: string | null) => {
    await podo.issueSet([i.id], a, note);
    setAsk(null);
    onDone();
  };
  const now = (a: Act) => {
    setBusy(true);
    setError("");
    run(a).catch((e: Error) => setError(e.message)).finally(() => setBusy(false));
  };
  if (i.status === "void") return null;
  const short = i.kind === "short";
  const decidable = short || i.kind === "part";
  return (
    <div className="podo-acts">
      {i.status === "open" && decidable && i.decision !== "await" && <button className="small" disabled={busy} onClick={() => now("await")}>厂家会补</button>}
      {i.status === "open" && decidable && <button className="small ghost" disabled={busy} onClick={() => setAsk("cancel")}>取消（下次再订）</button>}
      {i.status === "open" && decidable && i.decision === "await" && i.resolved_qty === 0 &&
        <button className="small ghost" disabled={busy} onClick={() => now("pending")}>改回未决定</button>}
      {i.status === "open" && (!short || i.decision === "await") &&
        <button className="small ghost" disabled={busy} onClick={() => setAsk("resolve")}>已处理</button>}
      {i.status === "resolved" && <button className="small ghost" disabled={busy} onClick={() => now("reopen")}>重开</button>}
      {!short && requestOptions(i.kind).length > 0 &&
        <button className="small ghost" disabled={busy} onClick={() => setAsk("request")}>要厂家…</button>}
      <button className="small ghost" disabled={busy} onClick={() => setAsk("note")}>备注</button>
      {!i.auto && <button className="small ghost danger" disabled={busy} onClick={() => setAsk("void")}>作废</button>}
      <ErrorBox error={error} />
      {ask === "request" && (
        <RequestModal kind={i.kind} initial={i.request} onClose={() => setAsk(null)} onOk={(r) => run("request", r)} />
      )}
      {ask === "cancel" && (
        <AskModal title="取消（下次再订）" message={i.kind === "part" ? "厂家不补了：这笔缺零件标为已处理。" : "厂家不补了：这笔少发标为已处理，下次要的话另开 PO。"}
                  label="说明（可空白）"
                  okText="确定" onClose={() => setAsk(null)} onOk={(t) => run("cancel", t || null)} />
      )}
      {ask === "resolve" && (
        <AskModal title="标为已处理" label="怎么处理的（可空白，例：厂家退款 / 下一柜补）" okText="已处理"
                  onClose={() => setAsk(null)} onOk={(t) => run("resolve", t || null)} />
      )}
      {ask === "note" && (
        <AskModal title="备注" label="备注（会印在给厂家的清单上）" initial={i.note} okText="储存"
                  onClose={() => setAsk(null)} onOk={(t) => run("note", t)} />
      )}
      {ask === "void" && (
        <AskModal title="作废这笔" message="记错了才作废（不会出现在清单上）。" label="原因（可空白）" okText="作废" danger
                  onClose={() => setAsk(null)} onOk={(t) => run("void", t || null)} />
      )}
    </div>
  );
}

/** 改「要厂家怎么处理」 */
function RequestModal({ kind, initial, onClose, onOk }: {
  kind: IssueKind; initial: IssueRequest | null; onClose: () => void; onOk: (r: string) => Promise<void>;
}) {
  const [v, setV] = useState<IssueRequest | "">(initial ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try { await onOk(v); } catch (err) { setError((err as Error).message); setBusy(false); }
  }
  return (
    <Modal title="要厂家怎么处理" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label>要厂家怎么处理<RequestSelect kind={kind} value={v} onChange={setV} /></label>
        <p className="muted small">会印在给厂家的清单与 WhatsApp 讯息上（「要厂家：…」）。细节写在备注。</p>
        <ErrorBox error={error} />
        <div className="actions">
          <button type="button" className="ghost" onClick={onClose}>取消</button>
          <button disabled={busy}>{busy ? "处理中…" : "储存"}</button>
        </div>
      </form>
    </Modal>
  );
}

/** 问题表格（DO 画面与厂家问题页共用）。picked / onPick：多选批量处理 */
// 手机（≤ 640px）：表格变成卡片（徽章 + 型号 + 数量 / 还欠一行、DO / PO、按钮排在下面；podo.css 的 .podo-issues）
export function IssueTable({ rows, onChanged, showDo, picked, onPick }: {
  rows: Issue[]; onChanged: () => void; showDo?: boolean; picked?: Set<number>; onPick?: (id: number) => void;
}) {
  return (
    <div className="table-wrap podo-issues-wrap">
      <table className={"podo-issues" + (onPick ? " pick" : "")}>
        <thead>
          <tr>
            {onPick && <th></th>}
            <th>问题</th><th>型号 / 品名</th>{showDo && <th>DO / PO</th>}
            <th className="num">订 / 到</th><th className="num">数量</th><th>处理</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((i) => (
            <tr key={i.id} className={i.status === "open" ? "" : "inactive-soft"}>
              {onPick && (
                <td className="pi-pick"><input type="checkbox" checked={picked?.has(i.id) ?? false} onChange={() => onPick(i.id)} disabled={i.status === "void"}
                           aria-label={`选取 ${i.item_code ?? i.received_code}`} /></td>
              )}
              <td className="pi-kind"><IssueBadges i={i} /><br /><small className="muted">{fmtDate(i.created_at)}</small></td>
              <td className="pi-model">
                <b>{issueModel(i)}</b><br /><small>{i.description}</small>
                {i.note && <><br /><small className="pre">{`备注：${i.note}`}</small></>}
              </td>
              {showDo && (
                <td className="pi-do small">
                  {i.do_id && <a href={`#/purchasing/do/${i.do_id}`}>{i.do_no || `#${i.do_id}`}</a>}
                  {i.do_date && <span className="muted">{` · ${i.do_date}`}</span>}
                  <br /><span className="muted">{joinList(i.po_nos)}</span>
                  {i.factory && <><br /><span className="tag cs">{i.factory}</span></>}
                </td>
              )}
              <td className="num pi-ord">{i.ordered != null ? fmtQty(i.ordered) : "—"}<br /><small className="muted">{i.received != null ? fmtQty(i.received) : "—"}</small></td>
              <td className="num pi-qty">
                <b>{fmtQty(ISSUE_QTY(i))}</b>
                {i.resolved_qty > 0 && <><br /><small className="muted">{`共 ${fmtQty(i.qty)} · 已补 ${fmtQty(i.resolved_qty)}`}</small></>}
                {Number(i.owed_qty) > 0 && <><br /><small className="late">{`厂家还欠 ${fmtQty(i.owed_qty)}`}</small></>}
              </td>
              <td className="pi-act">
                {i.action_note && <small className="pre">{i.action_note}</small>}
                {i.resolutions.map((r, n) => (
                  <small key={n} className="muted podo-res">{`DO ${r.do_no || "#" + r.do_id} 补 ${fmtQty(r.qty)}`}</small>
                ))}
                <IssueActions i={i} onDone={onChanged} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ------------------------------------------------------------------ 手动记：坏货 / 到货少 / 发错型号 / 缺零件
/** 记问题要的那张 DO：DO 画面给整张 DoFull；点货画面（仓库看不到 ops_po_do_get）给点货资料的型号 */
export interface IssueDo {
  id: number;
  /** 搜我们的商品用（来错的型号）；没给 = 自己分店的公司 */
  company?: string;
  items: { item_code: string | null; description: string; shipped: number }[];
  candidates: { item_code: string }[];
  /** 已点货（arrived）：补记会调整进货待入 AutoCount；来错的货（我们的型号）可以选仓位（locations；没给 = 主要仓位） */
  status?: string; locations?: string[]; main_location?: string;
}
type AddResult = Issue & { stock_left?: number; move_id?: number | null };
type AddKind = "damaged" | "short" | "wrong" | "part";
export function AddIssueModal({ doFull, onClose, onSaved }: { doFull?: IssueDo; onClose: () => void; onSaved: (r: AddResult) => void }) {
  const [dos, setDos] = useState<DoHeader[] | null>(null);
  const [full, setFull] = useState<IssueDo | null>(doFull ?? null);
  const [kind, setKindRaw] = useState<AddKind>("damaged");
  const [f, setF] = useState({ item_code: "", qty: "", note: "", part_name: "" });
  const [pick, setPick] = useState<Picked>(NOT_PICKED);
  const [req, setReq] = useState<IssueRequest | "">("");
  const [loc, setLoc] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (doFull) return;
    podo.list({ status: "all" })
      .then((r) => setDos(r.filter((d) => d.can_add_issue)))
      .catch((e: Error) => setError(e.message));
  }, [doFull]);

  const setKind = (k: AddKind) => {
    setKindRaw(k);
    setReq(k === "part" ? "next" : "");
    setError("");
  };
  const pickDo = (id: string) => {
    setFull(null);
    setError("");
    if (id) podo.get(Number(id)).then(setFull).catch((e: Error) => setError(e.message));
  };
  const items = (full?.items ?? []).filter((x) => x.item_code && x.shipped > 0);
  const arrived = full?.status === "arrived";
  const mainLoc = full?.main_location || "";
  const codes = useMemo(() => {
    const s = new Set<string>();
    full?.candidates.forEach((c) => s.add(c.item_code));
    full?.items.forEach((x) => x.item_code && s.add(x.item_code));
    return [...s].sort();
  }, [full]);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!full) return setError("请先选厂家 DO。");
    const q = num(f.qty);
    if (kind === "part" && !f.part_name.trim()) return setError("请填缺的零件 / 东西名称。");
    if (kind === "wrong" && pick.own === null) return setError("请从清单选我们的型号，或按「不是我们的产品」。");
    if (kind === "wrong" && pick.own === false && !pick.desc.trim()) return setError("「不是我们的产品」请填品名。");
    if (!(q > 0)) return setError("请填数量。");
    setBusy(true);
    setError("");
    const base = { do_id: full.id, kind, qty: q, note: f.note };
    try {
      const r = await podo.issueAdd(
        kind === "short" ? { ...base, item_code: f.item_code }
          : kind === "damaged" ? { ...base, item_code: f.item_code, request: req || null }
          : kind === "part" ? { ...base, item_code: f.item_code || null, part_name: f.part_name.trim(), request: req || "next" }
          : { ...base, item_code: f.item_code || null, received_code: pick.code.trim(), description: pick.desc.trim(), own: pick.own,
              request: req || null, ...(arrived && pick.own && loc ? { location: loc } : {}) });
      onSaved(r);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal title="记坏货 / 到货少 / 发错型号 / 缺零件" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        {!doFull && (
          <label>哪一张厂家 DO
            <select onChange={(e) => pickDo(e.target.value)} defaultValue="" required>
              <option value="">{dos === null ? "载入中…" : "（选一张已确认 / 已到货的 DO）"}</option>
              {(dos ?? []).map((d) => (
                <option key={d.id} value={d.id}>{`${d.supplier_name || d.creditor_code} · ${d.do_no || "#" + d.id}${d.do_date ? " · " + d.do_date : ""}`}</option>
              ))}
            </select>
          </label>
        )}
        <div className="row podo-kinds">
          <label className="check"><input type="radio" checked={kind === "damaged"} onChange={() => setKind("damaged")} /> 坏货 / 破损</label>
          <label className="check"><input type="radio" checked={kind === "short"} onChange={() => setKind("short")} /> 到货少</label>
          <label className="check"><input type="radio" checked={kind === "wrong"} onChange={() => setKind("wrong")} /> 发错型号</label>
          <label className="check"><input type="radio" checked={kind === "part"} onChange={() => setKind("part")} /> 缺零件</label>
        </div>
        {kind === "short" && <p className="muted small">厂家 DO 写的比实际到的多：这几件不算在路上，厂家欠（跟少发一样选厂家会补或取消）。</p>}
        {kind === "part" && <p className="muted small">缺零件 / 其他要补的（例：少了螺丝包、少一片玻璃）：不影响在路上与少发的数量，在厂家问题里决定厂家会补或取消。</p>}
        {(kind === "damaged" || kind === "short") && (
          <label>型号
            <select value={f.item_code} onChange={set("item_code")} required disabled={!full}>
              <option value="">（选型号）</option>
              {items.map((x) => <option key={x.item_code!} value={x.item_code!}>{`${x.item_code} · ${x.description} · 出货 ${fmtQty(x.shipped)}`}</option>)}
            </select>
          </label>
        )}
        {kind === "part" && (
          <>
            <div className="row">
              <label>型号（可不选）
                <select value={f.item_code} onChange={set("item_code")} disabled={!full}>
                  <option value="">—</option>
                  {items.map((x) => <option key={x.item_code!} value={x.item_code!}>{`${x.item_code} · ${x.description}`}</option>)}
                </select>
              </label>
              <label>缺的零件 / 东西<input value={f.part_name} onChange={set("part_name")} placeholder="例：螺丝包" required /></label>
            </div>
          </>
        )}
        {kind === "wrong" && (
          <>
            <div className="pick-field">
              <span className="pick-label">收到的型号</span>
              <OurItemPicker company={full?.company ?? null} value={pick} onChange={setPick} disabled={!full} />
            </div>
            <label>本来应该是（可不填）
              <select value={f.item_code} onChange={set("item_code")} disabled={!full}>
                <option value="">—</option>
                {codes.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
          </>
        )}
        <div className="row">
          <label>数量<input inputMode="decimal" value={f.qty} onChange={set("qty")} required /></label>
          {kind !== "short" && <label>要厂家怎么处理<RequestSelect kind={kind} value={req} onChange={setReq} /></label>}
          {kind === "wrong" && arrived && pick.own && (full?.locations?.length ?? 0) > 0 && (
            <label>放哪个仓位
              <select value={loc || mainLoc} aria-label="放哪个仓位" onChange={(e) => setLoc(e.target.value)}>
                {full!.locations!.map((l) => <option key={l} value={l}>{l}</option>)}
              </select>
            </label>
          )}
        </div>
        {arrived && (kind === "damaged" || kind === "short") && (
          <p className="small amber">这张已经点过货：这几件会从还没输入 AutoCount 的进货扣掉（已经输入的扣不到，要请仓库主管在 AutoCount 调整）。</p>
        )}
        {arrived && kind === "wrong" && pick.own && (
          <p className="small amber">{`这张已经点过货：收到的我们的型号会多一笔进货待入 AutoCount（进 ${loc || mainLoc || "主要仓位"}），开单部开 GRN。`}</p>
        )}
        <label>备注<input value={f.note} onChange={set("note")}
                          placeholder={kind === "damaged" ? "例：2 个裂开，有拍照" : kind === "short" ? "例：少一箱" : kind === "part" ? "例：每箱少 1 包" : "例：订白色收到黑色"} /></label>
        <p className="muted small">备注与「要厂家怎么处理」会印在给厂家的清单与 WhatsApp 讯息上。</p>
        <ErrorBox error={error} />
        <div className="actions">
          <button type="button" className="ghost" onClick={onClose}>取消</button>
          <button disabled={busy || !full}>{busy ? "储存中…" : "记下来"}</button>
        </div>
      </form>
    </Modal>
  );
}

// ------------------------------------------------------------------ 厂家问题页
/** 一个厂家；代理（例 MULTI GLOBE）底下再按 CS 工厂分（subs，没有 CS 编号的 factory = null） */
interface Sub { factory: string | null; rows: Issue[] }
interface Group { key: string; company: string; creditor_code: string; supplier_name: string; rows: Issue[]; subs: Sub[] }

function groupBySupplier(rows: Issue[]): Group[] {
  const m = new Map<string, Group>();
  for (const i of rows) {
    const k = `${i.company}|${i.creditor_code}`;
    let g = m.get(k);
    if (!g) {
      g = { key: k, company: i.company, creditor_code: i.creditor_code, supplier_name: i.supplier_name, rows: [], subs: [] };
      m.set(k, g);
    }
    g.rows.push(i);
    const f = i.factory || null;
    const sb = g.subs.find((x) => x.factory === f);
    if (sb) sb.rows.push(i); else g.subs.push({ factory: f, rows: [i] });
  }
  // 有 CS 编号的工厂排前面（照编号），没有编号的放最后
  for (const g of m.values()) g.subs.sort((a, b) => (a.factory ?? "~").localeCompare(b.factory ?? "~"));
  return [...m.values()];
}

/** 厂家还欠：少发（未决定 / 厂家会补，还没补齐）、缺零件（还没处理） */
function OwedBox({ rows, onWa }: { rows: Issue[]; onWa: (owed: Issue[]) => void }) {
  const owed = rows.filter((i) => Number(i.owed_qty) > 0);
  if (!owed.length) return null;
  const shorts = owed.filter((i) => i.kind === "short");
  const parts = owed.filter((i) => i.kind === "part");
  const sum = (xs: Issue[]) => xs.reduce((s, i) => s + Number(i.owed_qty), 0);
  return (
    <div className="podo-owed">
      <div className="podo-owed-head">
        <span>
          <b>厂家还欠</b>
          {shorts.length > 0 && <span>{`少发 ${shorts.length} 项共 ${fmtQty(sum(shorts))} 件`}</span>}
          {parts.length > 0 && <span>{`缺零件 ${parts.length} 项`}</span>}
        </span>
        <button type="button" className="small" onClick={() => onWa(owed)}>📱 WhatsApp 催货</button>
      </div>
      <small className="muted podo-owed-list">
        {owed.slice(0, 8).map((i) => <span key={i.id}><span>{issueModel(i)}</span>{` × ${fmtQty(i.owed_qty)}`}</span>)}
        {owed.length > 8 && <span>{`还有 ${owed.length - 8} 项`}</span>}
      </small>
    </div>
  );
}

export default function IssuesTab({ me }: { me: Me }) {
  const [status, setStatus] = useState("open");
  const [kind, setKind] = useState("");
  const [company, setCompany] = useState("");
  const [owedOnly, setOwedOnly] = useState(false);
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<Issue[] | null>(null);
  const [error, setError] = useState("");
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [adding, setAdding] = useState(false);
  const [printing, setPrinting] = useState<Group[] | null>(null);
  const [bulk, setBulk] = useState<"cancel" | "resolve" | null>(null);
  const [busy, setBusy] = useState(false);
  const [wa, setWa] = useState<{ title: string; build: (l: "zh" | "en") => string } | null>(null);

  const load = useCallback(() => {
    setError("");
    podo.issues({ status, kind, company, q: query, owed: owedOnly })
      .then((r) => { setRows(r); setPicked(new Set()); })
      .catch((e: Error) => setError(e.message));
  }, [status, kind, company, query, owedOnly]);
  useEffect(() => { setRows(null); load(); }, [load]);

  const groups = useMemo(() => groupBySupplier(rows ?? []), [rows]);
  const pickedRows = (rows ?? []).filter((i) => picked.has(i.id));
  const allDecidable = pickedRows.length > 0 && pickedRows.every((i) => (i.kind === "short" || i.kind === "part") && i.status === "open");
  // 「已处理」与单笔同规则：少发要先选厂家会补（未决定的不能直接结案）
  const canResolve = pickedRows.length > 0 && pickedRows.every((i) => i.status === "open" && (i.kind !== "short" || i.decision === "await"));
  const oneSupplier = pickedRows.length > 0 && new Set(pickedRows.map((i) => `${i.company}|${i.creditor_code}`)).size === 1;
  const toggle = (id: number) => {
    const n = new Set(picked);
    if (n.has(id)) n.delete(id); else n.add(id);
    setPicked(n);
  };
  async function bulkRun(action: string, note?: string | null) {
    setBusy(true);
    setError("");
    try {
      await podo.issueSet([...picked], action, note);
      setBulk(null);
      load();
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  }
  const owedWa = (g: Group, sb: Sub | null, owed: Issue[]) => setWa({
    title: `WhatsApp 催货 · ${g.supplier_name || g.creditor_code}${sb?.factory ? " · " + sb.factory : ""}`,
    build: (l) => waOwedText(l, owed, sb?.factory),
  });

  return (
    <>
      <div className="page-head">
        <p className="muted">
          {"确认厂家 DO 时自动记：少发（所选 PO 还没出的 − 这批出货）、多发、发错型号、缺零件；坏货 / 破损、到货少点货时记或手动记。"}
          <br />{"少发：之后同一厂家的 DO 在那张 PO 出了这个型号会自动扣掉。请选「厂家会补」（超出 PO 的数量也会先补它）或「取消（下次再订）」。"}
          <br />{"要提醒厂家：「📱 WhatsApp 催货」（厂家还欠的）、勾选几笔发 WhatsApp，或下载 Excel / 打印（可存成 PDF），一个厂家一页。"}
        </p>
        <button onClick={() => setAdding(true)}>＋ 记坏货 / 到货少 / 发错型号 / 缺零件</button>
      </div>
      <form className="toolbar" onSubmit={(e) => { e.preventDefault(); setQuery(q.trim()); }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜厂家、CS 编号、型号、品名、零件、DO 号、PO 号…" />
        <button>搜寻</button>
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="open">未处理</option>
          <option value="resolved">已处理</option>
          <option value="all">全部（不含作废）</option>
          <option value="void">已作废</option>
        </select>
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">全部问题</option>
          {Object.entries(ISSUE_KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        {me.staff.branch === "ALL" && (
          <select value={company} onChange={(e) => setCompany(e.target.value)}>
            <option value="">全部分店</option>
            <option value="HOMEWORKSSB">{BRANCH_LABEL.HOMEWORKSSB}</option>
            <option value="HOMEWORKSSOUTHERN">{BRANCH_LABEL.HOMEWORKSSOUTHERN}</option>
          </select>
        )}
        <label className="check"><input type="checkbox" checked={owedOnly} onChange={(e) => setOwedOnly(e.target.checked)} /> 只看厂家还欠</label>
        <button type="button" className="ghost" disabled={!rows?.length} onClick={() => exportIssuesXlsx(groups).catch((e: Error) => setError(e.message))}>下载 Excel</button>
        <button type="button" className="ghost" disabled={!rows?.length} onClick={() => setPrinting(groups)}>打印</button>
      </form>
      <ErrorBox error={error} />
      {picked.size > 0 && (
        <div className="bulkbar">
          {`已选 ${picked.size} 笔`}
          {allDecidable && <button disabled={busy} onClick={() => bulkRun("await")}>厂家会补</button>}
          {allDecidable && <button className="ghost" disabled={busy} onClick={() => setBulk("cancel")}>取消（下次再订）</button>}
          {canResolve && <button className="ghost" disabled={busy} onClick={() => setBulk("resolve")}>已处理</button>}
          {oneSupplier && (
            <button className="ghost" onClick={() => setWa({
              title: `WhatsApp · ${pickedRows[0].supplier_name || pickedRows[0].creditor_code}`,
              build: (l) => waIssuesText(l, pickedRows),
            })}>📱 WhatsApp 发给厂家</button>
          )}
          <button className="ghost" onClick={() => setPicked(new Set())}>取消选取</button>
        </div>
      )}
      {rows === null ? <p className="muted">{error ? "" : "载入中…"}</p> : rows.length === 0 ? <Empty>没有厂家问题。</Empty> : (
        groups.map((g) => {
          const split = g.subs.length > 1 || !!g.subs[0]?.factory;
          return (
            <section key={g.key} className="podo-group">
              <div className="podo-group-head">
                <h3>
                  {g.supplier_name || g.creditor_code} <small className="muted">{g.creditor_code}</small>
                  {me.staff.branch === "ALL" && <span className="tag">{BRANCH_LABEL[g.company]}</span>}
                </h3>
                <span className="nowrap">
                  <small className="muted">{`${g.rows.length} 笔`}</small>{" "}
                  <button className="small ghost" onClick={() => exportIssuesXlsx([g]).catch((e: Error) => setError(e.message))}>Excel</button>{" "}
                  <button className="small ghost" onClick={() => setPrinting([g])}>打印</button>
                </span>
              </div>
              {!split && <OwedBox rows={g.rows} onWa={(owed) => owedWa(g, null, owed)} />}
              {split ? g.subs.map((sb) => (
                <div key={sb.factory ?? "-"} className="podo-factory">
                  <h4>
                    {sb.factory ? <span className="tag cs">{sb.factory}</span> : <span className="muted">没有 CS 编号</span>}
                    <small className="muted">{`${sb.rows.length} 笔`}</small>
                  </h4>
                  <OwedBox rows={sb.rows} onWa={(owed) => owedWa(g, sb, owed)} />
                  <IssueTable rows={sb.rows} onChanged={load} showDo picked={picked} onPick={toggle} />
                </div>
              )) : <IssueTable rows={g.rows} onChanged={load} showDo picked={picked} onPick={toggle} />}
            </section>
          );
        })
      )}
      {adding && <AddIssueModal onClose={() => setAdding(false)} onSaved={() => { setAdding(false); load(); }} />}
      {bulk === "cancel" && (
        <AskModal title="取消（下次再订）" message={`${picked.size} 笔少发 / 缺零件：厂家不补了，标为已处理。`} label="说明（可空白）" okText="确定"
                  onClose={() => setBulk(null)} onOk={(t) => bulkRun("cancel", t || null)} />
      )}
      {bulk === "resolve" && (
        <AskModal title="标为已处理" label="怎么处理的（可空白）" okText="已处理"
                  onClose={() => setBulk(null)} onOk={(t) => bulkRun("resolve", t || null)} />
      )}
      {printing && <PrintIssues groups={printing} onDone={() => setPrinting(null)} />}
      {wa && <WaModal title={wa.title} build={wa.build} onClose={() => setWa(null)} />}
    </>
  );
}

// ------------------------------------------------------------------ Excel / 打印
const HEAD = ["厂家", "工厂", "PO", "型号", "品名", "订", "到", "问题", "数量", "处理", "要厂家", "备注", "DO 号", "日期"];
// 「到」「处理」在共用字典里另有意思（To / Decision），表头的英文在这里自己给
const HEAD_EN = ["Supplier", "Factory", "PO", "Model", "Item", "Ordered", "Received", "Issue", "Qty", "Handling", "Ask supplier",
  "Note", "DO no.", "Date"];
const head = () => (getLang() === "en" ? HEAD_EN : HEAD);

function issueRow(i: Issue): (string | number)[] {
  return [
    i.supplier_name || i.creditor_code, i.factory ?? "", i.po_nos.join(", "), ui(issueModel(i)), i.description,
    i.ordered ?? "", i.received ?? "", ui(issueKindLabel(i)), ISSUE_QTY(i),
    issueHandling(i).split(" · ").map(ui).join(" · "), ui(requestLabel(i.kind, i.request)), i.note, i.do_no ?? "",
    i.do_date ?? dateKL(i.created_at),
  ];
}

async function exportIssuesXlsx(groups: Group[]): Promise<void> {
  const XLSX = await import("@e965/xlsx");
  const aoa: (string | number)[][] = [head()];
  for (const g of groups) for (const i of g.rows) aoa.push(issueRow(i));
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = [24, 8, 16, 22, 36, 8, 8, 12, 8, 28, 20, 30, 14, 12].map((wch) => ({ wch }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, ui("厂家问题").slice(0, 31));
  const who = groups.length === 1 ? `_${(groups[0].supplier_name || groups[0].creditor_code).replace(/[\\/:*?"<>|]+/g, " ").trim()}` : "";
  const out = XLSX.write(wb, { bookType: "xlsx", type: "array", compression: true }) as ArrayBuffer;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([out], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
  a.download = `${ui("厂家问题")}${who}_${todayKL()}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

/** 打印：一个厂家一页（横向 A4）。浏览器的列印可以「存成 PDF」 */
function PrintIssues({ groups, onDone }: { groups: Group[]; onDone: () => void }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setReady(true);
    const style = document.createElement("style");
    style.textContent = "@page { size: A4 landscape; margin: 10mm; }";
    document.head.appendChild(style);
    const done = () => onDone();
    window.addEventListener("afterprint", done);
    const t = setTimeout(() => window.print(), 300);
    return () => { clearTimeout(t); window.removeEventListener("afterprint", done); style.remove(); };
  }, [onDone]);
  if (!ready) return null;
  // 没有 CS 工厂的厂家不印「工厂」栏
  return createPortal(
    <div id="podo-print">
      {groups.map((g) => {
        const fac = g.rows.some((i) => i.factory);
        const cols = head().map((h, n) => ({ h, n })).filter(({ n }) => n > 0 && (fac || n !== 1));
        return (
          <section key={g.key} className="podo-print-group">
            <h2>{g.supplier_name || g.creditor_code} <small>{g.creditor_code}</small></h2>
            <p className="podo-print-sub">{`HomeWorks · 厂家问题清单 · ${todayKL()} · ${g.rows.length} 笔`}</p>
            <table>
              <thead translate="no"><tr>{cols.map(({ h }) => <th key={h}>{h}</th>)}</tr></thead>
              <tbody>
                {g.rows.map((i) => {
                  const r = issueRow(i);
                  return (
                    <tr key={i.id}>
                      {cols.map(({ n }) => <td key={n} className={[5, 6, 8].includes(n) ? "n" : ""}>{typeof r[n] === "number" ? fmtQty(r[n] as number) : r[n]}</td>)}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        );
      })}
    </div>,
    document.body,
  );
}
