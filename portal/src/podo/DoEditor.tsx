// 厂家到货（一张厂家 DO / 装箱单）：#/purchasing/do/new 新开（选厂家 → 选 PO → 编辑），#/purchasing/do/<id> 打开。
// 草稿：每个型号填这批出货、分给各分店（同型号可拆），存草稿 / 确认。确认后只能改表头（DO 号、日期、ETA、货柜、备注、附件），
// 要改货品先「退回草稿」（订货可审批）。数量都不含单价。只有订货部（订货「可编辑」）开。
// SOP（使用者 2026-10-13）：上方显示第几步、等哪个部门（① 选 PO ② 出货数量 ③ 分配分店 ④ ETA ⑤ 确认 → ⑥ 点货（仓库部）→ ⑦ 厂家问题（采购））。
// 「这批的问题」：少发自动列出、先选厂家会补 / 取消 / 未决定（确认时套到自动产生的少发）；多发自动列出；来错的型号（搜我们的商品或
// 「不是我们的产品」、要厂家怎么处理）；缺零件 / 其他要补的。确认后可「📱 WhatsApp 发给厂家」。
import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import { BRANCH_LABEL, fmtDate, fmtQty, Me, Shipment, SHIPMENT_STATUS_LABEL, api, todayKL } from "../api";
import { go, replaceRoute, setLeaveGuard } from "../router";
import { ErrorBox, Modal } from "../ui";
import {
  Candidate, DECISION_LABEL, DO_ACTION_LABEL, DoFile, DoFull, DoPart, DoSop, DoSupplier, downloadDoFile, FILE_ACCEPT, Issue,
  IssueRequest, isSheet, joinList, newClientKey, num, Outlet, podo, requestLabel, ui, uploadDoFile,
} from "../podo-api";
import {
  AskModal, DoStatusBadge, ErrorLines, EtaText, FileList, OurItemPicker, outletName, Picked, RequestSelect, SopSteps,
} from "./common";
import { ImportPanel, ImportResult, OtherHit } from "./Import";
import { AddIssueModal, IssueTable, issueModel } from "./Issues";
import { PoPicker, SupplierPicker } from "./Pickers";
import { readWorkbook, Sheet } from "./parse";
import { WaModal, waIssuesText } from "./whatsapp";

interface Start { company: string; creditor_code: string; supplier_name: string; po_nos: string[] }
/** 对得上 PO 的型号（一个型号一行） */
interface Row {
  item_code: string;
  shipped: string;
  alloc: Record<string, string>;
  auto: boolean;                 // 只有一间分店订：分配跟著出货数量自动填
  src_code: string; src_desc: string; src_row: number | null;
  note: string;
  excel?: "hit" | "missing";
  showNote?: boolean;
  /** 少发先决定：空 = 未决定（确认时套到自动产生的少发） */
  short_decision: "" | "await" | "cancelled";
}
/** 对不上 PO 的行 = 来错的型号（确认时记成发错型号）。手动加的：own = true 我们的商品 / false 不是我们的产品 / null 还没选；
 *  Excel 读进来的：own = undefined（照 Excel 的写法） */
interface XRow {
  key: string; manual: boolean; shipped: string; src_code: string; src_desc: string; src_row: number | null; sheet?: string;
  expected_code: string; note: string; suggest: string[]; other?: OtherHit;
  own?: boolean | null; request: IssueRequest | "";
}
/** 缺零件 / 其他要补的（确认时记成厂家问题 kind = part） */
interface PRow { key: string; item_code: string; part_name: string; qty: string; request: IssueRequest | ""; note: string }

let xseq = 0;
const xkey = () => `x${++xseq}`;
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const allocSum = (r: Row) => r3(Object.values(r.alloc).reduce((s, v) => s + (num(v) || 0), 0));

export default function DoEditor({ me, idParam }: { me: Me; idParam: string }) {
  if (idParam === "new") return <DoNew me={me} />;
  const id = Number(idParam);
  if (!Number.isInteger(id) || id <= 0) return <ErrorBox error="找不到这张厂家 DO。" />;
  return <DoLoad me={me} id={id} />;
}

function BackLink() {
  return <p className="small"><a href="#/purchasing/do">← 厂家到货清单</a></p>;
}

function DoNew({ me }: { me: Me }) {
  const [company, setCompany] = useState(me.staff.branch === "ALL" ? "HOMEWORKSSB" : me.staff.branch);
  const [sup, setSup] = useState<DoSupplier | null>(null);
  const [factoryQ, setFactoryQ] = useState("");             // 用 CS 编号找到代理的：选 PO 时先只列这个 CS
  const [pos, setPos] = useState<string[] | null>(null);
  if (!sup)
    return <><BackLink /><SupplierPicker me={me} company={company} onCompany={setCompany}
                                         onPick={(s, fq) => { setSup(s); setFactoryQ(fq ?? ""); }} /></>;
  if (!pos)
    return (
      <>
        <BackLink />
        <PoPicker company={company} creditor={sup.creditor_code} supplierName={sup.supplier_name} selected={[]} okText="下一步"
                  initialQ={factoryQ} onOk={setPos} onBack={() => setSup(null)} />
      </>
    );
  return <DoPage me={me} initial={null}
                 start={{ company, creditor_code: sup.creditor_code, supplier_name: sup.supplier_name, po_nos: pos }} />;
}

function DoLoad({ me, id }: { me: Me; id: number }) {
  const [full, setFull] = useState<DoFull | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { podo.get(id).then(setFull).catch((e: Error) => setError(e.message)); }, [id]);
  if (!full) return <><BackLink />{error ? <ErrorBox error={error} /> : <p className="muted">载入中…</p>}</>;
  return <DoPage me={me} initial={full} />;
}

/** 伺服器回传新的整张 DO 就换掉编辑画面（草稿的输入状态从伺服器资料重来） */
function DoPage({ me, initial, start }: { me: Me; initial: DoFull | null; start?: Start }) {
  const [full, setFull] = useState<DoFull | null>(initial);
  const [flash, setFlash] = useState("");
  const [waAsk, setWaAsk] = useState(false);       // 刚确认：上方问要不要 WhatsApp 发给厂家
  const onFull = (f: DoFull, msg = "", wa = false) => {
    // 新开的第一次存：网址换成这张的号码（不触发重新载入）
    if (!full) replaceRoute(`/purchasing/do/${f.id}`);
    setFlash(msg);
    setWaAsk(wa);
    setFull(f);
  };
  return <DoForm key={full ? `${full.id}:${full.status}:${full.updated_at}` : "new"} me={me} full={full} start={start}
                 onFull={onFull} flash={flash} waAsk={waAsk} />;
}

function rowsFromFull(full: DoFull): Record<string, Row> {
  const out: Record<string, Row> = {};
  for (const c of full.candidates) out[c.item_code] = blankRow(c.item_code);
  const single = new Map(full.candidates.map((c) => [c.item_code, c.single_outlet]));
  for (const it of full.items) {
    if (!it.item_code) continue;
    const alloc = Object.fromEntries(Object.entries(it.alloc ?? {}).map(([k, v]) => [k, String(v)]));
    const s = single.get(it.item_code);
    const keys = Object.keys(alloc);
    out[it.item_code] = {
      item_code: it.item_code, shipped: String(it.shipped ?? 0), alloc,
      auto: !!s && (keys.length === 0 || (keys.length === 1 && keys[0] === s && Number(alloc[s]) === Number(it.shipped))),
      src_code: it.src_code ?? "", src_desc: it.src_desc ?? "", src_row: it.src_row ?? null, note: it.note ?? "",
      showNote: !!it.note, short_decision: it.short_decision ?? "",
    };
  }
  return out;
}

function xrowsFromFull(full: DoFull): XRow[] {
  return full.items.filter((it) => !it.item_code).map((it) => {
    const manual = it.src_row == null;
    // 手动加的：照存的 own；以前存的（没有 own）当「不是我们的产品」，照原本打的型号 / 品名
    const own = manual ? (typeof it.own === "boolean" ? it.own : (it.src_code || it.src_desc ? false : null)) : it.own;
    return {
      key: xkey(), manual, shipped: String(it.shipped ?? 0), src_code: it.src_code ?? "", src_desc: it.src_desc ?? "",
      src_row: it.src_row ?? null, expected_code: it.expected_code ?? "", note: it.note ?? "", suggest: [], own,
      request: it.request ?? "",
    };
  });
}

function prowsFromFull(full: DoFull): PRow[] {
  return (full.parts ?? []).map((x: DoPart) => ({
    key: xkey(), item_code: x.item_code ?? "", part_name: x.part_name ?? "", qty: String(x.qty ?? ""), request: x.request ?? "next",
    note: x.note ?? "",
  }));
}

function blankRow(code: string): Row {
  return { item_code: code, shipped: "0", alloc: {}, auto: false, src_code: "", src_desc: "", src_row: null, note: "", short_decision: "" };
}

/** 预估会记的少发 / 多发（与伺服器 ops_po_do_confirm 同规则）：这张在那几张 PO 出的先补别张 DO 的少发，还欠的跟已记过的比、只记差额；
 *  超出所选 PO 的先补别张 PO「厂家会补」的少发 */
function estimate(order: string[], rows: Record<string, Row>, candMap: Map<string, Candidate>) {
  return order.map((code) => {
    const c = candMap.get(code);
    const s = num(rows[code].shipped) || 0;
    const rem = c?.remaining ?? 0;
    const fill = Math.min(c?.fillable ?? 0, s, rem);
    const short = r3(Math.max(0, rem - s));
    const over = r3(Math.max(0, s - rem));
    return { c: code, rem, s, short, over, newShort: r3(Math.max(0, short - Math.max(0, (c?.flagged ?? 0) - fill))),
             newOver: r3(Math.max(0, over - (c?.await_elsewhere ?? 0))) };
  });
}
type Est = ReturnType<typeof estimate>[number];

/** 新的型号：出货预设 = 还可以出；只有一间分店订就先分给那间 */
function defaultRow(c: Candidate): Row {
  const s = c.remaining > 0 ? String(r3(c.remaining)) : "0";
  return withShipped({ ...blankRow(c.item_code), auto: !!c.single_outlet }, s, c);
}

function withShipped(r: Row, shipped: string, c?: Candidate): Row {
  const single = c?.single_outlet;
  if (single && (r.auto || Object.values(r.alloc).every((v) => !String(v).trim()))) {
    return { ...r, shipped, alloc: num(shipped) > 0 ? { [single]: shipped } : {}, auto: true };
  }
  return { ...r, shipped };
}

/** 照各分店还可以出的数量分配（出货 = 还可以出合计时才这样分） */
function allocByRemaining(r: Row, c?: Candidate): Row {
  if (!c) return r;
  const alloc: Record<string, string> = {};
  for (const [o, q] of Object.entries(c.by_outlet)) if (q.remaining > 0) alloc[o] = String(r3(q.remaining));
  return { ...r, alloc, auto: false };
}

/** 全到：出货 = 还可以出，分配照各分店未出（只有一间分店订的照样预填那间） */
function fullRow(r: Row, c?: Candidate): Row {
  const rem = c ? r3(Math.max(c.remaining, 0)) : 0;
  const x = withShipped({ ...r, alloc: {}, auto: !!c?.single_outlet }, String(rem), c);
  return c && !c.single_outlet && rem > 0 ? allocByRemaining(x, c) : x;
}

function DoForm({ me, full, start, onFull, flash, waAsk }: {
  me: Me; full: DoFull | null; start?: Start; onFull: (f: DoFull, msg?: string, wa?: boolean) => void; flash: string; waAsk: boolean;
}) {
  const draft = !full || full.status === "draft";
  const editable = !full || full.can_edit;                       // 草稿 + 有权限
  const infoEditable = !full || full.can_edit_info;
  const company = full?.company ?? start!.company;
  const creditor = full?.creditor_code ?? start!.creditor_code;
  const supplierName = full?.supplier_name || start?.supplier_name || creditor;
  const clientKey = useRef(newClientKey());

  const [head, setHead] = useState({
    do_no: full?.do_no ?? "", do_date: full?.do_date ?? "", eta: full?.eta ?? "",
    shipment_id: full?.shipment_id ? String(full.shipment_id) : "", remark: full?.remark ?? "",
  });
  const [files, setFiles] = useState<DoFile[]>(full?.files ?? []);
  const [poNos, setPoNos] = useState<string[]>(full?.po_nos ?? start!.po_nos);
  const [cands, setCands] = useState<Candidate[] | null>(full ? full.candidates : null);
  const [outlets, setOutlets] = useState<Outlet[]>(full?.outlets ?? []);
  const [rows, setRows] = useState<Record<string, Row>>(() => (full ? rowsFromFull(full) : {}));
  const [xrows, setXrows] = useState<XRow[]>(() => (full ? xrowsFromFull(full) : []));
  const [prows, setProws] = useState<PRow[]>(() => (full ? prowsFromFull(full) : []));
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState(flash.startsWith("!") ? flash.slice(1) : "");
  const [msg, setMsg] = useState(flash.startsWith("!") ? "" : flash);
  const [busy, setBusy] = useState("");
  const [ships, setShips] = useState<Shipment[]>([]);
  const [q, setQ] = useState("");
  const [onlyShipped, setOnlyShipped] = useState(false);
  const [onlyOrdered, setOnlyOrdered] = useState(false);         // 预设四间分店都显示（使用者 2026-10-13：一打开就显示四间分店）
  const [imp, setImp] = useState<{ name: string; sheets: Sheet[] } | null>(null);
  const [others, setOthers] = useState<Candidate[] | null>(null);
  const [pickPos, setPickPos] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [ask, setAsk] = useState<"cancel" | "reopen" | null>(null);
  const [addIssue, setAddIssue] = useState(false);
  const [wa, setWa] = useState(false);

  // 新开：读所选 PO 的型号
  useEffect(() => {
    if (full) return;
    podo.candidates(company, creditor, poNos, null).then((c) => {
      setOutlets(c.outlets);
      setCands(c.items);
      setRows(Object.fromEntries(c.items.map((it) => [it.item_code, defaultRow(it)])));
    }).catch((e: Error) => setError(e.message));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    api.shipments().then((s) => setShips(s.filter((x) => x.company === company))).catch(() => {});
  }, [company]);
  // 有改没存：关分页 / 重新整理、点分页 / 返回 / 侧栏换页前都先问
  useEffect(() => {
    if (!dirty) return;
    const on = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", on);
    setLeaveGuard(() => window.confirm(ui("有修改还没储存，确定离开？")));
    return () => { window.removeEventListener("beforeunload", on); setLeaveGuard(null); };
  }, [dirty]);

  const candMap = useMemo(() => new Map((cands ?? []).map((c) => [c.item_code, c])), [cands]);
  const order = useMemo(() => {
    const codes = (cands ?? []).map((c) => c.item_code);
    for (const k of Object.keys(rows)) if (!candMap.has(k)) codes.push(k);
    return codes;
  }, [cands, rows, candMap]);
  // 总部账套的 PO 替四间分店订（一打开就显示四间）；JB 账套整本属于 JB，只显示 JB（资料库也只收同公司的分店）
  const active = outlets.filter((o) => o.active && (company === "HOMEWORKSSB" || o.company === company));
  const used = useMemo(() => {
    const s = new Set<string>();
    (cands ?? []).forEach((c) => Object.keys(c.by_outlet).forEach((k) => s.add(k)));
    Object.values(rows).forEach((r) => Object.entries(r.alloc).forEach(([k, v]) => num(v) > 0 && s.add(k)));
    return s;
  }, [cands, rows]);
  // 「只显示有订的分店」：所选 PO 有订、或已经分了数量的分店
  const cols = active.filter((o) => !onlyOrdered || used.has(o.code));
  const showCols = cols.length ? cols : active;

  const touch = () => { setDirty(true); setMsg(""); };
  const setRow = (code: string, f: (r: Row) => Row) => { setRows((prev) => ({ ...prev, [code]: f(prev[code]) })); touch(); };
  const setX = (key: string, patch: Partial<XRow>) => { setXrows((prev) => prev.map((x) => (x.key === key ? { ...x, ...patch } : x))); touch(); };
  const setP = (key: string, patch: Partial<PRow>) => { setProws((prev) => prev.map((x) => (x.key === key ? { ...x, ...patch } : x))); touch(); };

  // ------------------------------------------------ 检查与储存
  function problems(strict: boolean): string[] {
    const out: string[] = [];
    for (const code of order) {
      const r = rows[code];
      const s = num(r.shipped);
      if (Number.isNaN(s)) { out.push(`型号 ${code} 的出货数量不是数字。`); continue; }
      if (Object.values(r.alloc).some((v) => Number.isNaN(num(v)))) { out.push(`型号 ${code} 的分配数量不是数字。`); continue; }
      const a = allocSum(r);
      if (strict && (s > 0 || a > 0) && a !== r3(s)) out.push(`型号 ${code} 出货 ${fmtQty(s)}，分到各分店的合计是 ${fmtQty(a)}：要相等才能确认。`);
    }
    xrows.forEach((x, i) => {
      if (Number.isNaN(num(x.shipped))) { out.push(`「${x.src_code || x.src_desc}」的数量不是数字。`); return; }
      if (!x.manual) return;
      const blank = x.own == null && !x.src_code.trim() && !x.src_desc.trim() && !x.shipped.trim() && !x.note.trim();
      if (blank) return;
      if (x.own == null) out.push(`来错的型号第 ${i + 1} 行：请从清单选我们的型号，或按「不是我们的产品」。`);
      else if (x.own === false && !x.src_desc.trim()) out.push("来错的型号「不是我们的产品」请填品名。");
      else if (strict && !(num(x.shipped) > 0)) out.push(`来错的型号第 ${i + 1} 行请填数量。`);
    });
    for (const x of prows) {
      if (!x.part_name.trim() && !x.item_code && !x.qty.trim() && !x.note.trim()) continue;
      if (!x.part_name.trim()) out.push("缺零件请填零件 / 东西名称。");
      else if (Number.isNaN(num(x.qty))) out.push(`缺零件「${x.part_name.trim()}」的数量不是数字。`);
      else if (!(num(x.qty) > 0)) out.push(`缺零件「${x.part_name.trim()}」请填数量。`);
    }
    if (strict && !poNos.length) out.push("请先选这张 DO 对应的 PO。");
    if (strict && !order.some((c) => num(rows[c].shipped) > 0) && !xrows.some((x) => num(x.shipped) > 0)) out.push("这张 DO 没有任何出货数量。");
    return out;
  }

  function itemsPayload() {
    const items: Record<string, unknown>[] = [];
    for (const code of order) {
      const r = rows[code];
      const s = num(r.shipped) || 0;
      // 出货 0 但选了「厂家会补 / 取消」也要送（整个型号都没出 = 全部少发）
      if (!(s > 0) && !r.note.trim() && !r.short_decision) continue;
      const alloc: Record<string, number> = {};
      for (const [o, v] of Object.entries(r.alloc)) if (num(v) > 0) alloc[o] = num(v);
      items.push({ item_code: code, shipped: s, alloc, src_code: r.src_code, src_desc: r.src_desc, src_row: r.src_row, note: r.note,
                   short_decision: r.short_decision || null });
    }
    for (const x of xrows) {
      if (!x.src_code.trim() && !x.src_desc.trim()) continue;
      items.push({ item_code: null, shipped: num(x.shipped) || 0, src_code: x.src_code, src_desc: x.src_desc, src_row: x.src_row,
                   expected_code: x.expected_code || null, note: x.note, request: x.request || null,
                   ...(typeof x.own === "boolean" ? { own: x.own } : {}) });
    }
    return items;
  }

  function partsPayload() {
    return prows.filter((x) => x.part_name.trim() || x.item_code || x.qty.trim() || x.note.trim()).map((x) => ({
      item_code: x.item_code || null, part_name: x.part_name.trim(), qty: num(x.qty) || 0, request: x.request || "next", note: x.note.trim(),
    }));
  }

  async function save(): Promise<DoFull> {
    const bad = problems(false);
    if (bad.length) throw new Error(bad[0]);
    const p: Record<string, unknown> = { ...head, files };
    if (full) p.id = full.id;
    else { p.client_key = clientKey.current; p.company = company; }
    if (draft) Object.assign(p, { creditor_code: creditor, po_nos: poNos, items: itemsPayload(), parts: partsPayload() });
    return podo.save(p);
  }

  async function run(label: string, f: () => Promise<void>) {
    setBusy(label);
    setError("");
    setMsg("");
    try { await f(); } catch (e) { setError((e as Error).message); }
    setBusy("");
  }
  const reload = async (id: number, m = "") => onFull(await podo.get(id), m);

  // ------------------------------------------------ PO、Excel、附件
  async function changePos(next: string[]) {
    const c = await podo.candidates(company, creditor, next, full?.id ?? null);
    const nr: Record<string, Row> = {};
    for (const it of c.items) nr[it.item_code] = rows[it.item_code] ?? defaultRow(it);
    const moved: XRow[] = [];
    const dropped: string[] = [];
    for (const [code, r] of Object.entries(rows)) {
      if (nr[code]) continue;
      if (r.src_row != null) {
        moved.push({ key: xkey(), manual: false, shipped: r.shipped, src_code: r.src_code || code, src_desc: r.src_desc, src_row: r.src_row,
                     expected_code: "", note: r.note, suggest: [], request: "" });
      } else if (num(r.shipped) > 0) dropped.push(code);
    }
    setPoNos(next);
    setOutlets(c.outlets);
    setCands(c.items);
    setRows(nr);
    if (moved.length) setXrows((prev) => [...prev, ...moved]);
    touch();
    if (dropped.length) setMsg(`这些型号不在新选的 PO 里，已拿掉：${joinList(dropped)}`);
  }

  async function loadOthers() {
    if (others) return;
    const ps = await podo.pos(company, creditor);
    const all = ps.filter((p) => !p.closed).map((p) => p.po_no);
    setOthers(all.length ? (await podo.candidates(company, creditor, all, full?.id ?? null)).items : []);
  }

  async function openSheet(name: string, blob: Blob) {
    let sheets: Sheet[];
    try {
      sheets = await readWorkbook(blob, name);
    } catch (e) {
      throw new Error(`读不了这个 Excel（${(e as Error).message}）。可以直接在下面填数量。`);
    }
    if (!sheets.some((s) => s.rows.length)) throw new Error("这个 Excel 是空的。");
    setImp({ name, sheets });
    loadOthers().catch(() => setOthers([]));
  }

  async function onUpload(e: ChangeEvent<HTMLInputElement>) {
    const list = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (!list.length) return;
    await run("上传中…", async () => {
      if (files.length + list.length > 10) throw new Error("附件最多 10 个。");
      const ym = todayKL().slice(0, 7);
      let sheetFile: File | null = null;
      for (const f of list) {
        const up = await uploadDoFile(company, ym, f);
        setFiles((prev) => [...prev, up]);
        touch();
        if (!sheetFile && isSheet(f.name)) sheetFile = f;
      }
      if (sheetFile && draft && editable) await openSheet(sheetFile.name, sheetFile);
      else setMsg("附件已上传，记得按「存」。");
    });
  }

  function applyImport(r: ImportResult) {
    const hit = new Map(r.res.matched.map((m) => [m.item_code, m]));
    const next: Record<string, Row> = {};
    for (const code of Object.keys(rows)) {
      const m = hit.get(code);
      const c = candMap.get(code);
      const cur = rows[code];
      if (m) {
        const ln = m.lines[0];
        next[code] = withShipped({ ...cur, src_code: ln.code || ln.model, src_desc: ln.desc, src_row: ln.row, excel: "hit",
                                   alloc: allocSum(cur) === r3(m.qty) ? cur.alloc : {}, auto: cur.auto || !!c?.single_outlet },
                                 String(m.qty), c);
      } else if (r.zeroMissing) {
        next[code] = { ...cur, shipped: "0", alloc: {}, auto: !!c?.single_outlet, src_code: "", src_desc: "", src_row: null, excel: "missing" };
      } else {
        next[code] = { ...cur, excel: undefined };
      }
    }
    setRows(next);
    setXrows((prev) => [
      ...prev.filter((x) => x.manual),
      ...r.res.unmatched.map((u) => ({
        key: xkey(), manual: false, shipped: String(u.qty), src_code: u.code || u.model,
        src_desc: (u.desc || u.texts.filter((t) => t !== u.code && t !== u.model).join(" ")).slice(0, 300),
        src_row: u.row, sheet: u.sheet, expected_code: "", note: "", suggest: u.suggest, other: r.other.get(u), request: "" as const,
      })),
    ]);
    setImp(null);
    touch();
    setMsg(`已套用 Excel：对上 ${r.res.matched.length} 个型号${r.res.unmatched.length ? `，对不上 ${r.res.unmatched.length} 行（在下面处理）` : ""}。记得按「存草稿」。`);
  }

  /** 对不上的行 → 就是某个型号（厂家写法不同）：数量并进那个型号。一定先问（使用者：一选整行就被并掉＝「一选就跳走」） */
  function mapX(x: XRow, code: string) {
    const cur = rows[code];
    if (!cur) return;
    // Excel 的行并进还没对上 Excel 的型号：出货 = Excel 的数量（原本的是预设）；其他（已对上 Excel、手动加的）：加上去
    const base = cur.src_row != null || x.manual ? num(cur.shipped) || 0 : 0;
    const total = r3(base + (num(x.shipped) || 0));
    const label = x.src_code || x.src_desc || "—";
    if (!window.confirm(ui(`把「${label}」并进 ${code}？${code} 的出货会变成 ${fmtQty(total)}，这一行拿掉。`))) return;
    const nr = withShipped({
      ...cur, src_code: cur.src_row != null ? cur.src_code : x.src_code, src_desc: cur.src_row != null ? cur.src_desc : x.src_desc,
      src_row: cur.src_row ?? x.src_row, excel: x.src_row != null ? "hit" : cur.excel,
    }, String(total), candMap.get(code));
    setRows({ ...rows, [code]: nr });
    setXrows(xrows.filter((y) => y.key !== x.key));
    touch();
  }

  // ------------------------------------------------ 批量小工具
  const bulk = (f: (r: Row, c?: Candidate) => Row) => {
    const next: Record<string, Row> = {};
    for (const [k, r] of Object.entries(rows)) next[k] = f(r, candMap.get(k));
    setRows(next);
    touch();
  };
  const fillRemaining = () => bulk(fullRow);
  const clearAll = () => bulk((r, c) => ({ ...r, shipped: "0", alloc: {}, auto: !!c?.single_outlet }));
  const allocAll = () => bulk((r, c) => (c && allocSum(r) === 0 && num(r.shipped) > 0 && r3(num(r.shipped)) === r3(c.remaining) ? allocByRemaining(r, c) : r));

  // ------------------------------------------------ 画面
  const shown = order.filter((code) => {
    const r = rows[code];
    const c = candMap.get(code);
    if (onlyShipped && !(num(r.shipped) > 0)) return false;
    const k = q.trim().toLowerCase();
    return !k || code.toLowerCase().includes(k) || (c?.description ?? "").toLowerCase().includes(k) || r.src_code.toLowerCase().includes(k);
  });
  const totShipped = r3(order.reduce((s, c) => s + (num(rows[c].shipped) || 0), 0));
  const totAlloc = (o: string) => r3(order.reduce((s, c) => s + (num(rows[c].alloc[o]) || 0), 0));
  const status = full?.status ?? "draft";
  const ship = ships.find((s) => String(s.id) === head.shipment_id);
  const est = estimate(order, rows, candMap);
  // SOP：草稿照画面上现在的内容算（还没存的也算）；确认后照资料库
  const sop: DoSop | null = draft && editable ? liveSop() : full?.sop ?? null;
  function liveSop(): DoSop {
    const shippedRows = order.filter((c) => num(rows[c].shipped) > 0);
    const done = {
      po: poNos.length > 0,
      shipped: shippedRows.length > 0 || xrows.some((x) => num(x.shipped) > 0),
      alloc: shippedRows.length > 0 && shippedRows.every((c) => allocSum(rows[c]) === r3(num(rows[c].shipped))),
      eta: !!(head.eta || ship?.eta),
      confirmed: false, received: false, decided: true,
    };
    const step = !done.po ? 1 : !done.shipped ? 2 : !done.alloc ? 3 : !done.eta ? 4 : 5;
    return { step, owner: "purchasing", done, decide_n: 0, draft_overdue: !!full?.sop?.draft_overdue };
  }
  const liveIssues = (full?.issues ?? []).filter((i) => i.status !== "void");
  // 点完货的 DO：WhatsApp 预设只发点货时 / 点货后记的（确认时的多半已经发过），勾了才连同确认时的
  const recvIds = new Set(full?.receipt?.issue_ids ?? []);
  const recvIssues = liveIssues.filter((i) => recvIds.has(i.id) || (!i.auto && !!full?.arrived_at && i.created_at > full.arrived_at));
  const splitWa = full?.status === "arrived" && recvIssues.length > 0 && recvIssues.length < liveIssues.length;

  return (
    <>
      <BackLink />
      <div className="page-head">
        <h2>
          {full ? (full.do_no || "（没填 DO 号）") : "新厂家到货"} <DoStatusBadge status={status} />
          {me.staff.branch === "ALL" && <span className="tag">{BRANCH_LABEL[company]}</span>}
        </h2>
      </div>
      <p className="muted">
        <b>{supplierName}</b>{` · ${creditor} · PO ${joinList(poNos)}`}
        {draft && editable && <>{" "}<button type="button" className="small ghost" onClick={() => setPickPos(true)}>改 PO</button></>}
      </p>
      {full?.status === "cancelled" && <div className="error">{`已取消 · ${full.cancelled_by_name ?? ""} · ${fmtDate(full.cancelled_at)}${full.cancel_reason ? " · " + full.cancel_reason : ""}`}</div>}
      {full?.status === "arrived" && <div className="ok">{`已到货 · ${full.arrived_by_name ?? ""} · ${fmtDate(full.arrived_at)}${full.arrive_note ? " · " + full.arrive_note : ""}`}</div>}
      {full?.status === "arrived" && full.receipt && <ReceiptSummary full={full} />}
      {full?.status === "confirmed" && <div className="ok">{`在路上（${full.confirmed_by_name ?? ""} · ${fmtDate(full.confirmed_at)} 确认）：分店在「在路上」看得到这张与 ETA。`}</div>}
      {sop && <SopSteps sop={sop} />}
      {waAsk && full && liveIssues.length > 0 && (
        <div className="podo-sum podo-wa-ask">
          <span>{`这批有 ${liveIssues.length} 笔厂家问题：要告诉厂家吗？`}</span>
          <button type="button" className="small" onClick={() => setWa(true)}>📱 WhatsApp 发给厂家</button>
        </div>
      )}
      {draft && editable && cands !== null && <OwedHint company={company} creditor={creditor} poNos={poNos} doId={full?.id ?? null} />}

      {full && (full.status === "confirmed" || full.status === "arrived") && (
        <p className="small">分店看到的 ETA：<EtaText eta={full.eta_effective} source={full.eta_source} arrived={full.status !== "confirmed"} /></p>
      )}

      {/* 表头 */}
      <div className="card podo-head">
        <fieldset className="plain" disabled={!infoEditable || !!busy}>
          <div className="row">
            <label>厂家 DO / 装箱单号<input value={head.do_no} onChange={(e) => { setHead({ ...head, do_no: e.target.value }); touch(); }} placeholder="例：FS-0901" /></label>
            <label>DO 日期<input type="date" value={head.do_date} onChange={(e) => { setHead({ ...head, do_date: e.target.value }); touch(); }} /></label>
            <label>预计到货（ETA）<input type="date" value={head.eta} onChange={(e) => { setHead({ ...head, eta: e.target.value }); touch(); }} /></label>
          </div>
          <div className="row">
            <label>货柜（可不选；货柜有 ETA 就以货柜为准）
              <select value={head.shipment_id} onChange={(e) => { setHead({ ...head, shipment_id: e.target.value }); touch(); }}>
                <option value="">（没有）</option>
                {full?.shipment_id && !ships.some((s) => s.id === full.shipment_id) && (
                  <option value={String(full.shipment_id)}>{full.shipment_name ?? `#${full.shipment_id}`}</option>
                )}
                {ships.map((s) => <option key={s.id} value={s.id}>{`${s.name}${s.eta ? " · ETA " + s.eta : ""} · ${SHIPMENT_STATUS_LABEL[s.status]}`}</option>)}
              </select>
            </label>
            <label>备注<input value={head.remark} onChange={(e) => { setHead({ ...head, remark: e.target.value }); touch(); }} /></label>
          </div>
          {ship?.eta && head.eta && ship.eta !== head.eta && <p className="muted small">{`挂了货柜：分店看到的 ETA 是货柜的 ${ship.eta}。`}</p>}
          <h3>附件（厂家 DO / 装箱单）</h3>
          <FileList files={files} onRemove={infoEditable ? (f) => { setFiles(files.filter((x) => x.path !== f.path)); touch(); } : undefined}
                    onRead={draft && editable ? (f) => run("读取中…", async () => openSheet(f.name, await downloadDoFile(f))) : undefined} />
          {infoEditable && (
            <label className="ghost file-btn">
              {busy === "上传中…" ? "上传中…" : "＋ 上传 Excel / PDF / 照片"}
              <input type="file" accept={FILE_ACCEPT} multiple hidden onChange={onUpload} />
            </label>
          )}
          {draft && editable && <p className="muted small">Excel（.xlsx / .xls / .csv）会自动读出每个型号的数量；PDF、照片先当附件，数量在下面自己填：到齐的型号按「全到」，少到的再改数字。</p>}
        </fieldset>
      </div>

      {/* 各型号 */}
      {draft ? (
        cands === null ? <p className="muted">{error ? "" : "载入中…"}</p> : (
          <div className="card podo-items">
            <h3>{`这批出货（${order.length} 个型号）`}</h3>
            {editable && (
              <div className="toolbar">
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="找型号 / 品名…" />
                <label className="check"><input type="checkbox" checked={onlyShipped} onChange={(e) => setOnlyShipped(e.target.checked)} /> 只看有出货的</label>
                <label className="check"><input type="checkbox" checked={onlyOrdered} onChange={(e) => setOnlyOrdered(e.target.checked)} /> 只显示有订的分店</label>
                <button type="button" className="small ghost" onClick={fillRemaining}>全部填还可以出的数量</button>
                <button type="button" className="small ghost" onClick={clearAll}>全部清零</button>
                <button type="button" className="small ghost" onClick={allocAll}>照各分店未出数量分配</button>
              </div>
            )}
            <div className="table-wrap flat">
              <table className="podo-table">
                <thead>
                  <tr>
                    <th className="sticky">型号 / 品名</th>
                    <th className="num">还可以出</th>
                    <th className="num">这批出货</th>
                    {showCols.map((o) => <th key={o.code} className="num"><span>{o.short_name || o.name}</span><br /><small>未出 / 分到</small></th>)}
                    <th>分配</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((code) => {
                    const r = rows[code];
                    const c = candMap.get(code);
                    const s = num(r.shipped);
                    const a = allocSum(r);
                    const rem = c?.remaining ?? 0;
                    const diff = r3((Number.isNaN(s) ? 0 : s) - a);
                    return (
                      <tr key={code} className={s > 0 ? "" : "podo-zero"}>
                        <td className="sticky">
                          <b>{code}</b> <small className="muted">{c?.uom}</small><br />
                          <small>{c?.description ?? ""}</small>
                          <div className="podo-tags">
                            {c && <small className="muted">{`PO ${joinList(c.po_nos)}`}</small>}
                            {r.excel === "hit" || (r.src_row != null && r.excel !== "missing")
                              ? <span className="tag">{r.src_code && r.src_code.toUpperCase() !== code.toUpperCase() ? `Excel 第 ${r.src_row} 行 · ${r.src_code}` : `Excel 第 ${r.src_row} 行`}</span>
                              : r.excel === "missing" ? <span className="tag warn">Excel 没有</span> : null}
                            {c && c.owed > 0 && <span className="tag warn">{`厂家欠 ${fmtQty(c.owed)}`}</span>}
                            {!c && <span className="tag warn">不在所选 PO</span>}
                          </div>
                          {editable && !r.showNote && (
                            <span className="podo-note-btn">
                              <button type="button" className="text-btn small" onClick={() => setRow(code, (x) => ({ ...x, showNote: true }))}>＋ 备注</button>
                              {!Number.isNaN(s) && r3(s) !== r3(rem) && <small className="muted">会带进厂家问题、印在给厂家的清单 / 讯息上</small>}
                            </span>
                          )}
                          {r.showNote && (editable
                            ? <>
                                <input className="podo-note" value={r.note} placeholder="备注（例：颜色不对）" aria-label={`${code} 备注`}
                                       onChange={(e) => setRow(code, (x) => ({ ...x, note: e.target.value }))} />
                                <small className="muted podo-note-hint">
                                  {!Number.isNaN(s) && r3(s) !== r3(rem) ? "会带进厂家问题、印在给厂家的清单 / 讯息上；仓库点货时也看得到。" : "仓库点货时看得到。"}
                                </small>
                              </>
                            : <small className="pre">{r.note}</small>)}
                        </td>
                        <td className="num">
                          <b>{fmtQty(rem)}</b>
                          {c && c.in_transit > 0 && <><br /><small className="muted">{`别张 DO 在路上 ${fmtQty(c.in_transit)}`}</small></>}
                          {c && c.received_do > 0 && <><br /><small className="amber">{`含这张已开 GRN 的 ${fmtQty(c.received_do)}`}</small></>}
                          {c && <><br /><small className="muted">{`订 ${fmtQty(c.ordered)} · 已收 ${fmtQty(c.received)}`}</small></>}
                        </td>
                        <td className="num">
                          <input className="podo-num" inputMode="decimal" value={r.shipped} disabled={!editable}
                                 onChange={(e) => setRow(code, (x) => withShipped(x, e.target.value, c))} aria-label={`${code} 出货`} />
                          {!Number.isNaN(s) && s > rem && <><br /><small className="late">{`多 ${fmtQty(r3(s - rem))}`}</small></>}
                          {!Number.isNaN(s) && s < rem && <><br /><small className="amber">{`少 ${fmtQty(r3(rem - s))}`}</small></>}
                          {editable && c && rem > 0 && (Number.isNaN(s) || r3(s) !== r3(rem)) && (
                            <><br /><button type="button" className="small ghost podo-full" onClick={() => setRow(code, (x) => fullRow(x, c))}>全到</button></>
                          )}
                        </td>
                        {showCols.map((o) => {
                          const bo = c?.by_outlet[o.code];
                          return (
                            <td key={o.code} className="num">
                              <small className="muted">{bo ? fmtQty(bo.remaining) : "—"}</small><br />
                              <input className="podo-num" inputMode="decimal" value={r.alloc[o.code] ?? ""} disabled={!editable}
                                     onChange={(e) => setRow(code, (x) => ({ ...x, alloc: { ...x.alloc, [o.code]: e.target.value }, auto: false }))}
                                     aria-label={`${code} ${o.short_name || o.name}`} />
                            </td>
                          );
                        })}
                        <td className="nowrap">
                          {Number.isNaN(s) ? <span className="late">不是数字</span>
                            : s === 0 && a === 0 ? <span className="muted">—</span>
                            : diff === 0 ? <span className="okc">✓</span>
                            : diff > 0 ? <span className="late">{`还差 ${fmtQty(diff)}`}</span>
                            : <span className="late">{`多分 ${fmtQty(-diff)}`}</span>}
                          {editable && c && !c.single_outlet && s > 0 && r3(s) === r3(c.remaining) && a === 0 && (
                            <><br /><button type="button" className="text-btn small" onClick={() => setRow(code, (x) => allocByRemaining(x, c))}>照未出分</button></>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr>
                    <td className="sticky"><b>合计</b></td><td></td>
                    <td className="num"><b>{fmtQty(totShipped)}</b></td>
                    {showCols.map((o) => <td key={o.code} className="num"><b>{fmtQty(totAlloc(o.code))}</b></td>)}
                    <td></td>
                  </tr>
                </tfoot>
              </table>
            </div>

            {/* 这批的问题：少发 / 多发自动列出，来错的型号、缺零件自己加 */}
            <ProblemsPanel
              editable={editable} company={company} order={order} rows={rows} candMap={candMap} est={est} xrows={xrows} prows={prows}
              poNos={poNos} others={others} busy={!!busy}
              setRow={setRow} setX={setX} setP={setP}
              setDecisionAll={(d) => {
                const next = { ...rows };
                for (const x of est) if (x.newShort > 0) next[x.c] = { ...next[x.c], short_decision: d };
                setRows(next);
                touch();
              }}
              addX={() => { setXrows([...xrows, { key: xkey(), manual: true, shipped: "", src_code: "", src_desc: "", src_row: null, expected_code: "", note: "", suggest: [], own: null, request: "" }]); touch(); }}
              dropX={(key) => { setXrows(xrows.filter((y) => y.key !== key)); touch(); }}
              addP={() => { setProws([...prows, { key: xkey(), item_code: "", part_name: "", qty: "", request: "next", note: "" }]); touch(); }}
              dropP={(key) => { setProws(prows.filter((y) => y.key !== key)); touch(); }}
              mapX={mapX}
              loadOthers={() => { loadOthers().catch(() => setOthers([])); }}
              addPos={(add) => run("读取中…", () => changePos([...new Set([...poNos, ...add])].sort()))}
            />
          </div>
        )
      ) : full && <ItemsView full={full} />}

      {/* 动作（固定在画面底部；错误与讯息放在这里才看得到） */}
      <div className="podo-actions">
        <div className="podo-msgs" aria-live="polite">
          <ErrorLines error={error} />
          {msg && <div className="ok">{msg}</div>}
          {dirty && !error && !msg && <p className="muted small">有修改还没储存。</p>}
        </div>
        {draft && editable && cands !== null && <ProblemSummary est={est} rows={rows} xrows={xrows} prows={prows} />}
        <div className="actions left">
          {draft && editable && (
            <>
              <button disabled={!!busy || cands === null} onClick={() => run("储存中…", async () => onFull(await save(), "已储存草稿。"))}>
                {busy === "储存中…" ? "储存中…" : "存草稿"}
              </button>
              <button disabled={!!busy || cands === null} onClick={() => {
                const bad = problems(true);
                if (bad.length) { setError(bad.slice(0, 5).join("\n")); return; }
                setError("");
                setConfirming(true);
              }}>确认（在路上）</button>
              {full && <button className="ghost danger" disabled={!!busy} onClick={() => setAsk("cancel")}>取消这张 DO</button>}
              {!full && <button className="ghost" disabled={!!busy} onClick={() => go("/purchasing/do")}>不存，离开</button>}
            </>
          )}
          {!draft && full && infoEditable && (
            <button disabled={!!busy} onClick={() => run("储存中…", async () => onFull(await save(), "已储存。"))}>
              {busy === "储存中…" ? "储存中…" : "存 DO 号 / ETA / 附件"}
            </button>
          )}
          {/* 货到了：仓库点每个型号实际收到几件（点完才算到货，少 / 坏 / 多 / 来错自动记进厂家问题） */}
          {full?.can_arrive && <button disabled={!!busy} onClick={() => go(`/purchasing/receive/${full.id}`)}>点货（货到了）</button>}
          {full?.can_reopen && <button className="ghost" disabled={!!busy} onClick={() => setAsk("reopen")}>退回草稿</button>}
        </div>
      </div>

      {full && full.status !== "draft" && full.status !== "cancelled" && (
        <>
          <div className="podo-group-head">
            <h3>{`厂家问题（${full.issues.length}）`}</h3>
            <span className="nowrap">
              {liveIssues.length > 0 && <button className="small ghost" onClick={() => setWa(true)}>📱 WhatsApp 发给厂家</button>}{" "}
              {full.can_add_issue && <button className="small" onClick={() => setAddIssue(true)}>＋ 记坏货 / 到货少 / 发错型号 / 缺零件</button>}
            </span>
          </div>
          {full.issues.length === 0 ? <p className="muted small">这张没有少发、多发、发错型号或缺零件。</p>
            : <IssueTable rows={full.issues} onChanged={() => { reload(full.id).catch((e: Error) => setError(e.message)); }} />}
        </>
      )}
      {full && full.applied.length > 0 && <AppliedView full={full} />}
      {full && full.history.length > 0 && (
        <details className="podo-history">
          <summary>{`纪录（${full.history.length}）`}</summary>
          <ul className="list">
            {full.history.map((h, n) => (
              <li key={n}>
                <span>{DO_ACTION_LABEL[h.action] ?? h.action}{typeof h.data?.reason === "string" && h.data.reason ? ` · ${h.data.reason}` : ""}{typeof h.data?.note === "string" && h.data.note ? ` · ${h.data.note}` : ""}</span>
                <span className="muted">{`${h.staff_name ?? ""} · ${fmtDate(h.at)}`}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {/* 弹窗 */}
      {imp && cands && (
        <ImportPanel fileName={imp.name} sheets={imp.sheets} cands={cands} others={others} onApply={applyImport}
                     onAddPos={(add) => run("读取中…", () => changePos([...new Set([...poNos, ...add])].sort()))}
                     onClose={() => setImp(null)} />
      )}
      {pickPos && (
        <Modal title="改 PO" onClose={() => setPickPos(false)} wide>
          <PoPicker company={company} creditor={creditor} supplierName={supplierName} selected={poNos} okText="确定"
                    onBack={() => setPickPos(false)}
                    onOk={(next) => { setPickPos(false); run("读取中…", () => changePos(next)); }} />
        </Modal>
      )}
      {confirming && cands && (
        <ConfirmModal order={order} rows={rows} xrows={xrows} prows={prows} est={est} outlets={active} hasEta={!!(head.eta || ship?.eta)}
                      hasNo={!!head.do_no.trim()} onClose={() => setConfirming(false)}
                      onOk={async (damaged) => {
                        const saved = await save();
                        let after: DoFull;
                        try {
                          after = await podo.confirm(saved.id);
                        } catch (e) {
                          onFull(saved, "!" + (e as Error).message);
                          return;
                        }
                        const fails: string[] = [];
                        for (const d of damaged) {
                          try { await podo.issueAdd({ do_id: after.id, kind: "damaged", item_code: d.item_code, qty: num(d.qty), note: d.note }); }
                          catch (e) { fails.push(`坏货没记到：${d.item_code}`, (e as Error).message); }
                        }
                        if (damaged.length) after = await podo.get(after.id);
                        onFull(after, fails.length ? "!" + fails.join("\n") : "已确认：分店在「在路上」看得到了。", true);
                      }} />
      )}
      {ask === "cancel" && full && (
        <AskModal title="取消这张 DO" message="取消后这张草稿不会再用（资料保留）。" label="原因（可空白）" okText="取消这张 DO" danger
                  onClose={() => setAsk(null)} onOk={async (t) => { await podo.cancel(full.id, t); await reload(full.id, "已取消。"); }} />
      )}
      {ask === "reopen" && full && (
        <AskModal title="退回草稿" okText="退回草稿" label="原因（可空白）"
                  message="退回后：分店的「在路上」会拿掉这张；这张自动产生、还没人处理的厂家问题会撤回（已决定或已处理的保留）。改好再确认一次。"
                  onClose={() => setAsk(null)} onOk={async (t) => { onFull(await podo.reopen(full.id, t), "已退回草稿。"); }} />
      )}
      {addIssue && full && (
        <AddIssueModal doFull={full} onClose={() => setAddIssue(false)}
                       onSaved={() => { setAddIssue(false); reload(full.id).catch((e: Error) => setError(e.message)); }} />
      )}
      {wa && full && (
        <WaModal title={`WhatsApp 发给厂家 · ${supplierName}`} onClose={() => setWa(false)}
                 toggle={splitWa ? { label: `连同确认时的问题（${liveIssues.length - recvIssues.length} 笔）`, hint: "确认时多半已经发过" } : undefined}
                 build={(l, all) => waIssuesText(l, (splitWa && !all ? recvIssues : liveIssues)
                   .map((i) => ({ ...i, do_no: full.do_no, do_date: full.do_date })))} />
      )}
    </>
  );
}

// ------------------------------------------------------------------ 草稿：这批的问题
// 少发 / 多发照表格自动列出（备注 = 那一行的备注，会带进厂家问题）；少发先选厂家会补 / 取消 / 未决定。
// 来错的型号：手动加的搜我们的商品或「不是我们的产品」（没有「就是 X」下拉：使用者一选整行被并掉）；Excel 对不上的行保留「就是 X？」，
// 但要再确认一次才并。缺零件 / 其他要补的：确认时变成厂家问题（不影响在路上与少发）。
function ProblemsPanel({ editable, company, order, rows, candMap, est, xrows, prows, poNos, others, busy, setRow, setX, setP,
  setDecisionAll, addX, dropX, addP, dropP, mapX, loadOthers, addPos }: {
  editable: boolean; company: string; order: string[]; rows: Record<string, Row>; candMap: Map<string, Candidate>; est: Est[];
  xrows: XRow[]; prows: PRow[]; poNos: string[]; others: Candidate[] | null; busy: boolean;
  setRow: (code: string, f: (r: Row) => Row) => void; setX: (key: string, patch: Partial<XRow>) => void;
  setP: (key: string, patch: Partial<PRow>) => void; setDecisionAll: (d: Row["short_decision"]) => void;
  addX: () => void; dropX: (key: string) => void; addP: () => void; dropP: (key: string) => void;
  mapX: (x: XRow, code: string) => void; loadOthers: () => void; addPos: (pos: string[]) => void;
}) {
  const shorts = est.filter((x) => x.short > 0);
  const overs = est.filter((x) => x.over > 0);
  const shipped = order.filter((c) => num(rows[c].shipped) > 0);
  const desc = (code: string) => candMap.get(code)?.description ?? "";
  const noteInput = (code: string) => (
    <input className="podo-note" value={rows[code].note} disabled={!editable} placeholder="备注（会带进厂家问题、给厂家的讯息）"
           aria-label={`问题备注 ${code}`} onChange={(e) => setRow(code, (x) => ({ ...x, note: e.target.value, showNote: true }))} />
  );
  // 手动加的行选了我们的型号：在别张还没到齐的 PO 上 → 提示加选那张 PO；就在所选的 PO → 提示直接填上面的表格
  const otherFor = (code: string) => {
    if (!code || rows[code] || !others) return null;
    const c = others.find((o) => o.item_code === code);
    const pos = (c?.po_nos ?? []).filter((p) => !poNos.includes(p));
    return pos.length ? pos : null;
  };

  return (
    <div className="podo-problems">
      <h3>这批的问题</h3>
      <p className="muted small">少发、多发照上面的出货数量自动列出；来错的型号、缺零件自己加。确认后都记进「厂家问题」，可以 WhatsApp 发给厂家。</p>

      <h4>{`少发（${shorts.length}）`}</h4>
      {shorts.length === 0 ? <p className="muted small">没有少发。</p> : (
        <>
          {editable && shorts.some((x) => x.newShort > 0) && (
            <div className="toolbar">
              <span className="small muted">全部：</span>
              <button type="button" className="small ghost" onClick={() => setDecisionAll("await")}>厂家会补</button>
              <button type="button" className="small ghost" onClick={() => setDecisionAll("cancelled")}>取消（下次再订）</button>
              <button type="button" className="small ghost" onClick={() => setDecisionAll("")}>未决定</button>
            </div>
          )}
          <ul className="list podo-prob-list">
            {shorts.map((x) => (
              <li key={x.c}>
                <span className="podo-prob-what">
                  <b>{x.c}</b> <small>{desc(x.c)}</small><br />
                  <small className="muted">{`还可以出 ${fmtQty(x.rem)} · 出 ${fmtQty(x.s)} · 少 ${fmtQty(x.short)}`}</small>
                  {x.newShort === 0 && <><br /><small className="muted">已记过（之前的少发还没补齐），不重复记</small></>}
                  {x.newShort > 0 && x.newShort < x.short && <><br /><small className="muted">{`新记 ${fmtQty(x.newShort)}（其余之前已记过）`}</small></>}
                </span>
                <span className="podo-prob-do">
                  {x.newShort > 0 && (
                    <select value={rows[x.c].short_decision} disabled={!editable} aria-label={`${x.c} 少发怎么处理`}
                            onChange={(e) => setRow(x.c, (r) => ({ ...r, short_decision: e.target.value as Row["short_decision"] }))}>
                      <option value="">未决定</option>
                      <option value="await">厂家会补</option>
                      <option value="cancelled">取消（下次再订）</option>
                    </select>
                  )}
                  {noteInput(x.c)}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      <h4>{`多发（${overs.length}）`}</h4>
      {overs.length === 0 ? <p className="muted small">没有多发。</p> : (
        <ul className="list podo-prob-list">
          {overs.map((x) => (
            <li key={x.c}>
              <span className="podo-prob-what">
                <b>{x.c}</b> <small>{desc(x.c)}</small><br />
                <small className="muted">{`还可以出 ${fmtQty(x.rem)} · 出 ${fmtQty(x.s)} · 多 ${fmtQty(x.over)}`}</small>
                {x.newOver < x.over && <><br /><small className="muted">{`先补厂家欠的 ${fmtQty(r3(x.over - x.newOver))}`}</small></>}
              </span>
              <span className="podo-prob-do">{noteInput(x.c)}</span>
            </li>
          ))}
        </ul>
      )}

      <h4>{`来错的型号（${xrows.length}）`}</h4>
      {xrows.length === 0 && <p className="muted small">收到不是这些 PO 的型号（例：订白色收到黑色）才加。Excel 里对不到 PO 的行也会列在这里。</p>}
      {xrows.map((x, i) => {
        const otherPos = x.manual && x.own ? otherFor(x.src_code) : null;
        const inTable = x.manual && x.own && !!rows[x.src_code];
        const excelPos = !x.manual && x.other && !rows[x.other.item_code] ? x.other.po_nos : null;
        const sugg = !x.manual ? [...new Set([...(x.other ? [x.other.item_code] : []), ...x.suggest])].filter((c) => rows[c]) : [];
        return (
          <div key={x.key} className="recv-wrong-card podo-wrong-card">
            <div className="recv-wrong-head">
              <b className="small">{x.manual ? `第 ${i + 1} 行` : x.sheet ? `${x.sheet} 第 ${x.src_row} 行` : `Excel 第 ${x.src_row} 行`}</b>
              {editable && <button type="button" className="small ghost danger" onClick={() => dropX(x.key)}>拿掉</button>}
            </div>
            <div className="wide pick-field">
              <span className="pick-label">收到的型号</span>
              {x.manual ? (
                <OurItemPicker company={company} disabled={!editable}
                               value={{ own: x.own ?? null, code: x.src_code, desc: x.src_desc }}
                               onChange={(v: Picked) => {
                                 setX(x.key, { own: v.own, src_code: v.code, src_desc: v.desc });
                                 if (v.own) loadOthers();
                               }} />
              ) : (
                <span className="podo-xsrc"><b>{x.src_code || "—"}</b> <small>{x.src_desc}</small></span>
              )}
            </div>
            {inTable && <p className="small amber wide">{`${x.src_code} 就在所选的 PO 里：直接在上面的表格填出货数量就好，不用记成来错。`}</p>}
            {inTable && editable && (
              <button type="button" className="small ghost wide-btn" onClick={() => mapX(x, x.src_code)}>{`并进上面的 ${x.src_code}`}</button>
            )}
            {(otherPos || excelPos) && (
              <p className="small late wide">
                {`这个型号在 ${joinList((otherPos ?? excelPos)!)} 有订，要加选那张 PO 吗？`}{" "}
                <button type="button" className="small ghost" disabled={!editable || busy} onClick={() => addPos((otherPos ?? excelPos)!)}>
                  {`加选 ${joinList((otherPos ?? excelPos)!)}`}
                </button>
              </p>
            )}
            <label>数量
              <input className="podo-num" inputMode="decimal" value={x.shipped} disabled={!editable} aria-label="来错数量"
                     onChange={(e) => setX(x.key, { shipped: e.target.value })} />
            </label>
            <label>本来应该是（可不填）
              <select value={x.expected_code} disabled={!editable} aria-label="本来应该是" onChange={(e) => setX(x.key, { expected_code: e.target.value })}>
                <option value="">—</option>
                {order.map((code) => <option key={code} value={code}>{code}</option>)}
              </select>
            </label>
            <label>要厂家怎么处理
              <RequestSelect kind="wrong" value={x.request} disabled={!editable} onChange={(v) => setX(x.key, { request: v })} />
            </label>
            <label className="wide">备注
              <input value={x.note} disabled={!editable} placeholder="例：订白色收到黑色，请换货" aria-label="来错备注"
                     onChange={(e) => setX(x.key, { note: e.target.value })} />
            </label>
            {!x.manual && editable && (sugg.length > 0 || order.length > 0) && (
              <div className="wide podo-same">
                <small className="muted">厂家写法不同、其实是同一个型号？</small>
                {sugg.map((c) => (
                  <button key={c} type="button" className="small ghost" onClick={() => mapX(x, c)}>{`就是 ${c}？`}</button>
                ))}
                <select value="" aria-label="就是哪个型号" onChange={(e) => e.target.value && mapX(x, e.target.value)}>
                  <option value="">就是…（选了会再问一次）</option>
                  {order.map((code) => <option key={code} value={code}>{`就是 ${code}（厂家写法不同）`}</option>)}
                </select>
              </div>
            )}
          </div>
        );
      })}
      {editable && <button type="button" className="small ghost" onClick={addX}>＋ 加一行来错的型号</button>}

      <h4>{`缺零件 / 其他要补的（${prows.length}）`}</h4>
      {prows.length === 0 && <p className="muted small">例：少了螺丝包、少一片玻璃。不影响在路上与少发的数量；确认后在「厂家问题」决定厂家会补或取消。</p>}
      {prows.map((x, i) => (
        <div key={x.key} className="recv-wrong-card podo-part-card">
          <div className="recv-wrong-head">
            <b className="small">{`第 ${i + 1} 行`}</b>
            {editable && <button type="button" className="small ghost danger" onClick={() => dropP(x.key)}>拿掉</button>}
          </div>
          <label>型号（可不选）
            <select value={x.item_code} disabled={!editable} aria-label="缺零件的型号" onChange={(e) => setP(x.key, { item_code: e.target.value })}>
              <option value="">—</option>
              {(shipped.length ? shipped : order).map((code) => <option key={code} value={code}>{code}</option>)}
            </select>
          </label>
          <label>缺的零件 / 东西
            <input value={x.part_name} disabled={!editable} placeholder="例：螺丝包" aria-label="缺的零件"
                   onChange={(e) => setP(x.key, { part_name: e.target.value })} />
          </label>
          <label>数量
            <input className="podo-num" inputMode="decimal" value={x.qty} disabled={!editable} aria-label="缺零件数量"
                   onChange={(e) => setP(x.key, { qty: e.target.value })} />
          </label>
          <label>要厂家怎么处理
            <RequestSelect kind="part" value={x.request} disabled={!editable} onChange={(v) => setP(x.key, { request: v })} />
          </label>
          <label className="wide">备注
            <input value={x.note} disabled={!editable} placeholder="例：每箱少 1 包" aria-label="缺零件备注"
                   onChange={(e) => setP(x.key, { note: e.target.value })} />
          </label>
        </div>
      ))}
      {editable && <button type="button" className="small ghost" onClick={addP}>＋ 加一行缺零件 / 其他要补的</button>}
    </div>
  );
}

/** 确认按钮上方的摘要：少发几个型号共几件（厂家会补 / 取消 / 未决定）、多发、来错、缺零件 */
function ProblemSummary({ est, rows, xrows, prows }: { est: Est[]; rows: Record<string, Row>; xrows: XRow[]; prows: PRow[] }) {
  const shorts = est.filter((x) => x.short > 0);
  const overs = est.filter((x) => x.over > 0);
  const fresh = shorts.filter((x) => x.newShort > 0);
  const dec = (d: Row["short_decision"]) => fresh.filter((x) => rows[x.c].short_decision === d).length;
  const wrongs = xrows.filter((x) => num(x.shipped) > 0);
  const parts = prows.filter((x) => x.part_name.trim());
  if (!shorts.length && !overs.length && !wrongs.length && !parts.length) return null;
  const sum = (xs: number[]) => fmtQty(r3(xs.reduce((s, x) => s + x, 0)));
  const known = shorts.length - fresh.length;
  return (
    <p className="small podo-prob-sum">
      {shorts.length > 0 && (
        <span className={dec("") ? "amber" : ""}>
          {`少发 ${shorts.length} 个型号共 ${sum(shorts.map((x) => x.short))} 件（厂家会补 ${dec("await")} / 取消 ${dec("cancelled")} / 未决定 ${dec("")}${known ? ` / 已记过 ${known}` : ""}）`}
        </span>
      )}
      {overs.length > 0 && <span>{`多发 ${overs.length} 个型号共 ${sum(overs.map((x) => x.over))} 件`}</span>}
      {wrongs.length > 0 && <span>{`来错的型号 ${wrongs.length} 行`}</span>}
      {parts.length > 0 && <span>{`缺零件 ${parts.length} 项`}</span>}
    </p>
  );
}

/** 开同一家厂的新厂家到货（选完 PO）：这家还欠的（少发未决定 / 厂家会补还没补齐、缺零件还没处理），同 CS 工厂的排前面 */
function OwedHint({ company, creditor, poNos, doId }: { company: string; creditor: string; poNos: string[]; doId: number | null }) {
  const [owed, setOwed] = useState<Issue[] | null>(null);
  const [facs, setFacs] = useState<string[]>([]);
  useEffect(() => {
    podo.issues({ status: "open", owed: true, company, creditor_code: creditor }).then(setOwed).catch(() => setOwed([]));
  }, [company, creditor]);
  const key = poNos.join(",");
  useEffect(() => {
    podo.pos(company, creditor)
      .then((ps) => setFacs([...new Set(ps.filter((p) => poNos.includes(p.po_no) && p.factory).map((p) => p.factory!))]))
      .catch(() => setFacs([]));
  }, [company, creditor, key]); // eslint-disable-line react-hooks/exhaustive-deps
  const list = (owed ?? []).filter((i) => i.do_id !== doId && Number(i.owed_qty) > 0)
    .sort((a, b) => Number(!facs.includes(a.factory ?? "")) - Number(!facs.includes(b.factory ?? "")));
  if (!list.length) return null;
  const same = list.filter((i) => i.factory && facs.includes(i.factory)).length;
  return (
    <div className="podo-sum warn podo-owed-hint">
      <b>{`这家还欠 ${list.length} 项`}</b>
      {facs.length > 0 && same > 0 && <>{" · "}<small>{`同一个工厂（${joinList(facs)}）的 ${same} 项排前面`}</small></>}
      <ul>
        {list.slice(0, 8).map((i) => (
          <li key={i.id}>
            {i.factory && <span className={"tag cs" + (facs.includes(i.factory) ? " hit" : "")}>{i.factory}</span>}
            <b>{issueModel(i)}</b>{` × ${fmtQty(i.owed_qty)}`}
            {" · "}<small className="muted">{`${i.kind === "part" ? "缺零件" : "少发"}${i.decision ? " · " + DECISION_LABEL[i.decision] : ""} · DO ${i.do_no || "#" + i.do_id}`}</small>
          </li>
        ))}
        {list.length > 8 && <li className="muted">{`还有 ${list.length - 8} 项`}</li>}
      </ul>
      <small>这批出了这些型号（同一张 PO）的话，确认时会自动补掉少发。 <a href="#/purchasing/issues">到厂家问题看 →</a></small>
    </div>
  );
}

// ------------------------------------------------------------------ 已到货：点货纪录的摘要（全文在 #/purchasing/receive/<id>）
function ReceiptSummary({ full }: { full: DoFull }) {
  const r = full.receipt!;
  const sum = (f: (x: (typeof r.items)[number]) => number) => r3(r.items.reduce((s, x) => s + f(x), 0));
  const good = sum((x) => Number(x.received));
  const damaged = sum((x) => Number(x.damaged));
  const short = sum((x) => Math.max(0, Number(x.shipped) - Number(x.received) - Number(x.damaged)));
  const over = sum((x) => Math.max(0, Number(x.received) + Number(x.damaged) - Number(x.shipped)));
  const wrong = r3(r.wrong.reduce((s, x) => s + Number(x.qty), 0));
  // 点货前记的坏货 / 到货少比点到的缺口多（要采购核对）
  const mism = sum((x) => Math.max(0, Number(x.prior?.damaged ?? 0) + Number(x.prior?.short ?? 0) - Math.max(0, Number(x.shipped) - Number(x.received))));
  // 点完货之后才补记的（手动、不是点货记的）
  const arrived = full.arrived_at ? new Date(full.arrived_at).getTime() : 0;
  const later = full.issues.filter((i) => !i.auto && i.status !== "void" && !r.issue_ids.includes(i.id) && new Date(i.created_at).getTime() > arrived);
  const laterOf = (k: string) => r3(later.filter((i) => i.kind === k).reduce((s, i) => s + Number(i.qty), 0));
  // 改了分店分配（只有一间分店、好货全给那间不算：那只是数量跟著好货变）
  const changed = r.items.filter((x) => {
    const a = normAlloc(x.alloc), p = normAlloc(x.planned);
    if (JSON.stringify(a) === JSON.stringify(p)) return false;
    return !(p.length === 1 && a.length <= 1 && (a.length === 0 || a[0][0] === p[0][0]));
  }).length;
  return (
    <div className="card podo-recv-sum">
      <b>点货纪录</b>
      <span>{`好货 ${fmtQty(good)}`}</span>
      {damaged > 0 && <span className="late">{`坏货 ${fmtQty(damaged)}`}</span>}
      {short > 0 && <span className="late">{`到货少 ${fmtQty(short)}`}</span>}
      {over > 0 && <span className="amber">{`多到 ${fmtQty(over)}`}</span>}
      {wrong > 0 && <span className="late">{`来错 ${fmtQty(wrong)}`}</span>}
      {damaged + short + over + wrong === 0 && <span className="okc">{later.length ? "点货时全部照 DO 到齐" : "全部照 DO 到齐"}</span>}
      {mism > 0 && <span className="amber">{`已记的比点到的多 ${fmtQty(mism)}`}</span>}
      {laterOf("damaged") > 0 && <span className="late">{`之后补记坏货 ${fmtQty(laterOf("damaged"))}`}</span>}
      {laterOf("short") > 0 && <span className="late">{`之后补记到货少 ${fmtQty(laterOf("short"))}`}</span>}
      {laterOf("wrong") > 0 && <span className="late">{`之后补记来错 ${fmtQty(laterOf("wrong"))}`}</span>}
      {changed > 0 && <span className="muted">{`${changed} 个型号改了分店分配`}</span>}
      <a href={`#/purchasing/receive/${full.id}`}>看点货纪录 →</a>
    </div>
  );
}

/** 分配比对用：拿掉 0、照分店代号排序 */
function normAlloc(a: Record<string, number> | null | undefined): [string, number][] {
  return Object.entries(a ?? {}).filter(([, v]) => Number(v) > 0).map(([k, v]): [string, number] => [k, Number(v)]).sort(([x], [y]) => x.localeCompare(y));
}

// ------------------------------------------------------------------ 已确认：唯读的型号表、分到哪几张 PO
function ItemsView({ full }: { full: DoFull }) {
  const items = full.items.filter((x) => x.item_code);
  const wrong = full.items.filter((x) => !x.item_code);
  const codes = full.outlets.filter((o) => items.some((x) => (x.alloc?.[o.code] ?? 0) > 0));
  return (
    <div className="card podo-items">
      <h3>{`这批出货（${items.length} 个型号）`}</h3>
      <div className="table-wrap flat">
        <table className="podo-table">
          <thead>
            <tr><th className="sticky">型号 / 品名</th><th className="num">出货</th>{codes.map((o) => <th key={o.code} className="num">{o.short_name || o.name}</th>)}</tr>
          </thead>
          <tbody>
            {items.map((x) => (
              <tr key={x.item_code!}>
                <td className="sticky">
                  <b>{x.item_code}</b> <small className="muted">{x.uom}</small><br /><small>{x.description}</small>
                  {x.src_row != null && <><br /><small className="muted">{x.src_code && x.src_code.toUpperCase() !== x.item_code!.toUpperCase() ? `Excel 第 ${x.src_row} 行 · ${x.src_code}` : `Excel 第 ${x.src_row} 行`}</small></>}
                  {x.note && <><br /><small className="pre">{`备注：${x.note}`}</small></>}
                </td>
                <td className="num"><b>{fmtQty(x.shipped)}</b></td>
                {codes.map((o) => <td key={o.code} className="num">{x.alloc?.[o.code] ? fmtQty(x.alloc[o.code]) : ""}</td>)}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td className="sticky"><b>合计</b></td>
              <td className="num"><b>{fmtQty(items.reduce((s, x) => s + Number(x.shipped), 0))}</b></td>
              {codes.map((o) => <td key={o.code} className="num"><b>{fmtQty(items.reduce((s, x) => s + Number(x.alloc?.[o.code] ?? 0), 0))}</b></td>)}
            </tr>
          </tfoot>
        </table>
      </div>
      {wrong.length > 0 && (
        <>
          <h3>{`来错的型号（${wrong.length}）`}</h3>
          <ul className="list">
            {wrong.map((x, n) => (
              <li key={n}>
                <span><b>{x.src_code || "—"}</b> <small>{x.src_desc}</small>{x.own === false && <small className="muted">{" · 不是我们的产品"}</small>}
                  {x.expected_code && <small className="muted">{` · 本来应该是 ${x.expected_code}`}</small>}
                  {x.request && <small className="muted">{` · 要厂家：${requestLabel("wrong", x.request)}`}</small>}
                  {x.note && <small className="muted">{` · ${x.note}`}</small>}</span>
                <span>{fmtQty(x.shipped)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {(full.parts ?? []).length > 0 && (
        <>
          <h3>{`缺零件 / 其他要补的（${full.parts!.length}）`}</h3>
          <ul className="list">
            {full.parts!.map((x, n) => (
              <li key={n}>
                <span><b>{`${x.item_code ? x.item_code + " " : ""}缺「${x.part_name}」`}</b>
                  {x.request && <small className="muted">{` · 要厂家：${requestLabel("part", x.request)}`}</small>}
                  {x.note && <small className="muted">{` · ${x.note}`}</small>}</span>
                <span>{fmtQty(x.qty)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function AppliedView({ full }: { full: DoFull }) {
  return (
    <details className="podo-history">
      <summary>{`记在哪几行 PO（${full.applied.length} 笔）`}</summary>
      <p className="muted small">确认时把每间分店的数量记在那间分店订的 PO 行（先开的单先记）；分店没订或订不够就记在同型号其他分店的 PO 行；再多就是多发。</p>
      <div className="table-wrap flat">
        <table>
          <thead><tr><th>型号</th><th>分店</th><th className="num">数量</th><th>PO</th><th>说明</th></tr></thead>
          <tbody>
            {full.applied.map((a, n) => (
              <tr key={n}>
                <td>{a.item_code}</td>
                <td>{outletName(full.outlets, a.outlet)}</td>
                <td className="num">{fmtQty(a.qty)}</td>
                <td>{a.po_no ?? "—"}</td>
                <td className="small muted">
                  {a.dtl_key == null ? "超出 PO（多发）" : a.line_outlet && a.line_outlet !== a.outlet ? `用 ${outletName(full.outlets, a.line_outlet)} 订的 PO 行` : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

// ------------------------------------------------------------------ 确认前：总览、预计的厂家问题、顺便记坏货
interface Damaged { item_code: string; qty: string; note: string }
function ConfirmModal({ order, rows, xrows, prows, est, outlets, hasEta, hasNo, onClose, onOk }: {
  order: string[]; rows: Record<string, Row>; xrows: XRow[]; prows: PRow[]; est: Est[]; outlets: Outlet[];
  hasEta: boolean; hasNo: boolean; onClose: () => void; onOk: (damaged: Damaged[]) => Promise<void>;
}) {
  const [damaged, setDamaged] = useState<Damaged[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const shipped = order.filter((c) => num(rows[c].shipped) > 0);
  const shorts = est.filter((x) => x.short > 0);
  const overs = est.filter((x) => x.over > 0);
  const wrongs = xrows.filter((x) => num(x.shipped) > 0);
  const parts = prows.filter((x) => x.part_name.trim());
  const decText = (code: string) => DECISION_LABEL[rows[code].short_decision || "pending"];
  const byOutlet = outlets.map((o) => ({ o, n: r3(order.reduce((s, c) => s + (num(rows[c].alloc[o.code]) || 0), 0)) })).filter((x) => x.n > 0);

  async function ok() {
    for (const d of damaged) {
      if (!d.item_code || !(num(d.qty) > 0)) return setError("坏货要选型号、填数量。");
      if (num(d.qty) > num(rows[d.item_code]?.shipped)) return setError(`坏货数量不能多过这张 DO 的出货数量（${fmtQty(num(rows[d.item_code]?.shipped))}）。`);
    }
    setBusy(true);
    setError("");
    try {
      await onOk(damaged);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  const list = (xs: Est[], f: (x: Est) => string) => (
    <ul className="list small">
      {xs.slice(0, 15).map((x) => <li key={x.c}><span>{x.c}</span><span>{f(x)}</span></li>)}
      {xs.length > 15 && <li><span className="muted">{`还有 ${xs.length - 15} 个`}</span></li>}
    </ul>
  );

  return (
    <Modal title="确认这张厂家 DO" onClose={onClose} wide>
      <p>{`${shipped.length} 个型号，共 ${fmtQty(r3(shipped.reduce((s, c) => s + num(rows[c].shipped), 0)))} 件。`}
        {byOutlet.map((x) => <span key={x.o.code} className="tag outlet">{`${x.o.short_name || x.o.name} ${fmtQty(x.n)}`}</span>)}
      </p>
      <p className="muted small">确认后：各分店在「在路上」看得到这批货与 ETA；下面的少发 / 多发 / 发错型号 / 缺零件会记到「厂家问题」（已记过的不会重复记），可以 WhatsApp 发给厂家。</p>
      {!hasEta && <div className="podo-sum warn">还没填 ETA：分店会看到「未填」。可以确认后再补。</div>}
      {!hasNo && <div className="podo-sum warn">还没填厂家 DO 号。</div>}
      {shorts.length > 0 && <><h3>{`少发（${shorts.length}）`}</h3>{list(shorts, (x) => `还可以出 ${fmtQty(x.rem)} · 出 ${fmtQty(x.s)} · 少 ${fmtQty(x.short)}`
        + (x.newShort === 0 ? " · 已记过" : (x.newShort < x.short ? ` · 新记 ${fmtQty(x.newShort)}` : "") + ` · ${decText(x.c)}`))}</>}
      {overs.length > 0 && <><h3>{`多发（${overs.length}）`}</h3>{list(overs, (x) => `还可以出 ${fmtQty(x.rem)} · 出 ${fmtQty(x.s)} · 多 ${fmtQty(x.over)}`
        + (x.newOver < x.over ? ` · 先补厂家欠的 ${fmtQty(r3(x.over - x.newOver))}` : ""))}</>}
      {wrongs.length > 0 && (
        <>
          <h3>{`发错型号（${wrongs.length}）`}</h3>
          <ul className="list small">
            {wrongs.map((x) => (
              <li key={x.key}>
                <span>{x.src_code || x.src_desc}{x.own === false && <small className="muted">{" · 不是我们的产品"}</small>}
                  {x.request && <small className="muted">{` · 要厂家：${requestLabel("wrong", x.request)}`}</small>}</span>
                <span>{fmtQty(num(x.shipped))}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {parts.length > 0 && (
        <>
          <h3>{`缺零件（${parts.length}）`}</h3>
          <ul className="list small">
            {parts.map((x) => (
              <li key={x.key}>
                <span>{`${x.item_code ? x.item_code + " " : ""}缺「${x.part_name.trim()}」`}
                  {x.request && <small className="muted">{` · 要厂家：${requestLabel("part", x.request)}`}</small>}</span>
                <span>{fmtQty(num(x.qty))}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <h3>坏货 / 破损（可不填，货到了再记也可以）</h3>
      {damaged.map((d, n) => (
        <div key={n} className="row podo-damaged">
          <select value={d.item_code} onChange={(e) => setDamaged(damaged.map((x, i) => (i === n ? { ...x, item_code: e.target.value } : x)))}>
            <option value="">（选型号）</option>
            {shipped.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <input className="podo-num" inputMode="decimal" placeholder="数量" value={d.qty}
                 onChange={(e) => setDamaged(damaged.map((x, i) => (i === n ? { ...x, qty: e.target.value } : x)))} />
          <input placeholder="备注" value={d.note} onChange={(e) => setDamaged(damaged.map((x, i) => (i === n ? { ...x, note: e.target.value } : x)))} />
          <button type="button" className="small ghost danger" onClick={() => setDamaged(damaged.filter((_, i) => i !== n))}>×</button>
        </div>
      ))}
      <button type="button" className="small ghost" onClick={() => setDamaged([...damaged, { item_code: "", qty: "", note: "" }])}>＋ 记一笔坏货</button>
      <ErrorBox error={error} />
      <div className="actions">
        <button type="button" className="ghost" onClick={onClose}>取消</button>
        <button type="button" disabled={busy} onClick={ok}>{busy ? "确认中…" : "确认（在路上）"}</button>
      </div>
    </Modal>
  );
}

