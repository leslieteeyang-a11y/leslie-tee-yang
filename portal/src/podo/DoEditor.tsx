// 厂家到货（一张厂家 DO / 装箱单）：#/purchasing/do/new 新开（选厂家 → 选 PO → 编辑），#/purchasing/do/<id> 打开。
// 草稿：每个型号填这批出货、分给各分店（同型号可拆），存草稿 / 确认。确认后只能改表头（DO 号、日期、ETA、货柜、备注、附件），
// 要改货品先「退回草稿」（订货可审批）。数量都不含单价。
import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import { BRANCH_LABEL, fmtDate, fmtQty, Me, Shipment, SHIPMENT_STATUS_LABEL, api, todayKL } from "../api";
import { go, replaceRoute, setLeaveGuard } from "../router";
import { ErrorBox, Modal } from "../ui";
import {
  Candidate, DO_ACTION_LABEL, DoFile, DoFull, DoSupplier, downloadDoFile, FILE_ACCEPT, isSheet, joinList, newClientKey, num,
  Outlet, podo, ui, uploadDoFile,
} from "../podo-api";
import { AskModal, DoStatusBadge, ErrorLines, EtaText, FileList, outletName } from "./common";
import { ImportPanel, ImportResult, OtherHit } from "./Import";
import { AddIssueModal, IssueTable } from "./Issues";
import { PoPicker, SupplierPicker } from "./Pickers";
import { readWorkbook, Sheet } from "./parse";

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
}
/** 对不上 PO 的行（确认时记成发错型号） */
interface XRow {
  key: string; manual: boolean; shipped: string; src_code: string; src_desc: string; src_row: number | null; sheet?: string;
  expected_code: string; note: string; suggest: string[]; other?: OtherHit;
}

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
  const onFull = (f: DoFull, msg = "") => {
    // 新开的第一次存：网址换成这张的号码（不触发重新载入）
    if (!full) replaceRoute(`/purchasing/do/${f.id}`);
    setFlash(msg);
    setFull(f);
  };
  return <DoForm key={full ? `${full.id}:${full.status}:${full.updated_at}` : "new"} me={me} full={full} start={start}
                 onFull={onFull} flash={flash} />;
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
      showNote: !!it.note,
    };
  }
  return out;
}

function xrowsFromFull(full: DoFull): XRow[] {
  return full.items.filter((it) => !it.item_code).map((it) => ({
    key: xkey(), manual: it.src_row == null, shipped: String(it.shipped ?? 0), src_code: it.src_code ?? "", src_desc: it.src_desc ?? "",
    src_row: it.src_row ?? null, expected_code: it.expected_code ?? "", note: it.note ?? "", suggest: [],
  }));
}

function blankRow(code: string): Row {
  return { item_code: code, shipped: "0", alloc: {}, auto: false, src_code: "", src_desc: "", src_row: null, note: "" };
}

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

function DoForm({ me, full, start, onFull, flash }: {
  me: Me; full: DoFull | null; start?: Start; onFull: (f: DoFull, msg?: string) => void; flash: string;
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
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState(flash.startsWith("!") ? flash.slice(1) : "");
  const [msg, setMsg] = useState(flash.startsWith("!") ? "" : flash);
  const [busy, setBusy] = useState("");
  const [ships, setShips] = useState<Shipment[]>([]);
  const [q, setQ] = useState("");
  const [onlyShipped, setOnlyShipped] = useState(false);
  const [allOutlets, setAllOutlets] = useState(false);
  const [imp, setImp] = useState<{ name: string; sheets: Sheet[] } | null>(null);
  const [others, setOthers] = useState<Candidate[] | null>(null);
  const [pickPos, setPickPos] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [ask, setAsk] = useState<"cancel" | "reopen" | "arrive" | null>(null);
  const [addIssue, setAddIssue] = useState(false);

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
  const active = outlets.filter((o) => o.active);
  const used = useMemo(() => {
    const s = new Set<string>();
    (cands ?? []).forEach((c) => Object.keys(c.by_outlet).forEach((k) => s.add(k)));
    Object.values(rows).forEach((r) => Object.entries(r.alloc).forEach(([k, v]) => num(v) > 0 && s.add(k)));
    return s;
  }, [cands, rows]);
  const cols = active.filter((o) => allOutlets || used.has(o.code));
  const showCols = cols.length ? cols : active;

  const touch = () => { setDirty(true); setMsg(""); };
  const setRow = (code: string, f: (r: Row) => Row) => { setRows((prev) => ({ ...prev, [code]: f(prev[code]) })); touch(); };
  const setX = (key: string, patch: Partial<XRow>) => { setXrows((prev) => prev.map((x) => (x.key === key ? { ...x, ...patch } : x))); touch(); };

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
    for (const x of xrows) if (Number.isNaN(num(x.shipped))) out.push(`「${x.src_code || x.src_desc}」的数量不是数字。`);
    if (strict && !poNos.length) out.push("请先选这张 DO 对应的 PO。");
    if (strict && !order.some((c) => num(rows[c].shipped) > 0) && !xrows.some((x) => num(x.shipped) > 0)) out.push("这张 DO 没有任何出货数量。");
    return out;
  }

  function itemsPayload() {
    const items: Record<string, unknown>[] = [];
    for (const code of order) {
      const r = rows[code];
      const s = num(r.shipped) || 0;
      if (!(s > 0) && !r.note.trim()) continue;
      const alloc: Record<string, number> = {};
      for (const [o, v] of Object.entries(r.alloc)) if (num(v) > 0) alloc[o] = num(v);
      items.push({ item_code: code, shipped: s, alloc, src_code: r.src_code, src_desc: r.src_desc, src_row: r.src_row, note: r.note });
    }
    for (const x of xrows) {
      if (!x.src_code.trim() && !x.src_desc.trim()) continue;
      items.push({ item_code: null, shipped: num(x.shipped) || 0, src_code: x.src_code, src_desc: x.src_desc, src_row: x.src_row,
                   expected_code: x.expected_code || null, note: x.note });
    }
    return items;
  }

  async function save(): Promise<DoFull> {
    const bad = problems(false);
    if (bad.length) throw new Error(bad[0]);
    const p: Record<string, unknown> = { ...head, files };
    if (full) p.id = full.id;
    else { p.client_key = clientKey.current; p.company = company; }
    if (draft) Object.assign(p, { creditor_code: creditor, po_nos: poNos, items: itemsPayload() });
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
                     expected_code: "", note: r.note, suggest: [] });
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
        src_row: u.row, sheet: u.sheet, expected_code: "", note: "", suggest: u.suggest, other: r.other.get(u),
      })),
    ]);
    setImp(null);
    touch();
    setMsg(`已套用 Excel：对上 ${r.res.matched.length} 个型号${r.res.unmatched.length ? `，对不上 ${r.res.unmatched.length} 行（在下面处理）` : ""}。记得按「存草稿」。`);
  }

  /** 对不上的 Excel 行 → 就是某个型号（厂家写法不同）：数量并进那个型号 */
  function mapX(x: XRow, code: string) {
    const cur = rows[code];
    if (!cur) return;
    const base = cur.src_row != null ? num(cur.shipped) || 0 : 0;
    const nr = withShipped({
      ...cur, src_code: cur.src_row != null ? cur.src_code : x.src_code, src_desc: cur.src_row != null ? cur.src_desc : x.src_desc,
      src_row: cur.src_row ?? x.src_row, excel: "hit",
    }, String(r3(base + (num(x.shipped) || 0))), candMap.get(code));
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
      {full?.status === "confirmed" && <div className="ok">{`在路上（${full.confirmed_by_name ?? ""} · ${fmtDate(full.confirmed_at)} 确认）：分店在「在路上」看得到这张与 ETA。`}</div>}

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
                <label className="check"><input type="checkbox" checked={allOutlets} onChange={(e) => setAllOutlets(e.target.checked)} /> 显示全部分店</label>
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
                          {editable && !r.showNote && <button type="button" className="text-btn small" onClick={() => setRow(code, (x) => ({ ...x, showNote: true }))}>＋ 备注</button>}
                          {r.showNote && (editable
                            ? <input className="podo-note" value={r.note} placeholder="备注（例：颜色不对）" onChange={(e) => setRow(code, (x) => ({ ...x, note: e.target.value }))} />
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

            {/* 对不上 PO 的行 */}
            {(xrows.length > 0 || editable) && (
              <>
                <h3>{`对不上 PO 的行（${xrows.length}）`}</h3>
                <p className="muted small">Excel 里对不到所选 PO 的型号。是同一个型号只是厂家写法不同 → 选「就是…」；真的发错 → 留著，确认时记成「发错型号」；不是货品（备注、空行）→ 拿掉。</p>
                {xrows.length > 0 && (
                  <div className="table-wrap flat">
                    <table>
                      <thead><tr><th>Excel 型号 / 品名</th><th className="num">数量</th><th>这一行是…</th><th className="hide-sm">备注</th><th></th></tr></thead>
                      <tbody>
                        {xrows.map((x) => (
                          <tr key={x.key}>
                            <td>
                              {x.manual && editable ? (
                                <>
                                  <input value={x.src_code} placeholder="收到的型号" onChange={(e) => setX(x.key, { src_code: e.target.value })} />
                                  <input value={x.src_desc} placeholder="品名" onChange={(e) => setX(x.key, { src_desc: e.target.value })} />
                                </>
                              ) : (
                                <>
                                  <b>{x.src_code || "—"}</b><br /><small>{x.src_desc}</small>
                                  {x.src_row != null && <><br /><small className="muted">{x.sheet ? `${x.sheet} 第 ${x.src_row} 行` : `Excel 第 ${x.src_row} 行`}</small></>}
                                </>
                              )}
                              {x.other && <><br /><small className="late">{`这个型号（${x.other.item_code}）在 ${joinList(x.other.po_nos)}，没有选进这张 DO`}</small></>}
                            </td>
                            <td className="num">
                              <input className="podo-num" inputMode="decimal" value={x.shipped} disabled={!editable}
                                     onChange={(e) => setX(x.key, { shipped: e.target.value })} aria-label="数量" />
                            </td>
                            <td>
                              <select value="" disabled={!editable} onChange={(e) => e.target.value && mapX(x, e.target.value)}>
                                <option value="">发错型号（不是我们订的）</option>
                                {order.map((code) => <option key={code} value={code}>{`就是 ${code}（厂家写法不同）`}</option>)}
                              </select>
                              {x.other && !rows[x.other.item_code] && (
                                <button type="button" className="small ghost" disabled={!editable || !!busy}
                                        onClick={() => run("读取中…", () => changePos([...new Set([...poNos, ...x.other!.po_nos])].sort()))}>
                                  {`加选 ${joinList(x.other.po_nos)}`}
                                </button>
                              )}
                              {[...new Set([...(x.other ? [x.other.item_code] : []), ...x.suggest])].filter((s) => rows[s]).map((s) => (
                                <button key={s} type="button" className="small ghost" disabled={!editable} onClick={() => mapX(x, s)}>{`就是 ${s}？`}</button>
                              ))}
                              <label className="small">本来应该是（可不填）
                                <select value={x.expected_code} disabled={!editable} onChange={(e) => setX(x.key, { expected_code: e.target.value })}>
                                  <option value="">—</option>
                                  {order.map((code) => <option key={code} value={code}>{code}</option>)}
                                </select>
                              </label>
                            </td>
                            <td className="hide-sm">
                              <input value={x.note} disabled={!editable} placeholder="例：订白色收到黑色" onChange={(e) => setX(x.key, { note: e.target.value })} />
                            </td>
                            <td>{editable && <button type="button" className="small ghost danger" onClick={() => { setXrows(xrows.filter((y) => y.key !== x.key)); touch(); }}>拿掉</button>}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {editable && (
                  <button type="button" className="small ghost" onClick={() => {
                    setXrows([...xrows, { key: xkey(), manual: true, shipped: "", src_code: "", src_desc: "", src_row: null, expected_code: "", note: "", suggest: [] }]);
                    touch();
                  }}>＋ 加一行发错型号</button>
                )}
              </>
            )}
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
          {full?.can_arrive && <button disabled={!!busy} onClick={() => setAsk("arrive")}>货到了（标记到货）</button>}
          {full?.can_reopen && <button className="ghost" disabled={!!busy} onClick={() => setAsk("reopen")}>退回草稿</button>}
        </div>
      </div>

      {full && full.status !== "draft" && full.status !== "cancelled" && (
        <>
          <div className="podo-group-head">
            <h3>{`厂家问题（${full.issues.length}）`}</h3>
            {full.can_add_issue && <button className="small" onClick={() => setAddIssue(true)}>＋ 记坏货 / 到货少 / 发错型号</button>}
          </div>
          {full.issues.length === 0 ? <p className="muted small">这张没有少发、多发或发错型号。</p>
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
        <ConfirmModal order={order} rows={rows} xrows={xrows} candMap={candMap} outlets={active} hasEta={!!(head.eta || ship?.eta)}
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
                        onFull(after, fails.length ? "!" + fails.join("\n") : "已确认：分店在「在路上」看得到了。");
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
      {ask === "arrive" && full && (
        <AskModal title="货到了" okText="标记到货" label="备注（可空白，例：少 1 箱、有破损已拍照）"
                  message="标记后这张从「在路上」拿掉（所有分店）。破损、少到的请另外记「坏货 / 到货少」。AutoCount 仍要照常开 GRN。"
                  onClose={() => setAsk(null)} onOk={async (t) => { await podo.arrive(full.id, t); await reload(full.id, "已标记到货。"); }} />
      )}
      {addIssue && full && (
        <AddIssueModal doFull={full} onClose={() => setAddIssue(false)}
                       onSaved={() => { setAddIssue(false); reload(full.id).catch((e: Error) => setError(e.message)); }} />
      )}
    </>
  );
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
          <h3>{`对不上 PO 的行（${wrong.length}）`}</h3>
          <ul className="list">
            {wrong.map((x, n) => (
              <li key={n}>
                <span><b>{x.src_code || "—"}</b> <small>{x.src_desc}</small>{x.expected_code && <small className="muted">{` · 本来应该是 ${x.expected_code}`}</small>}{x.note && <small className="muted">{` · ${x.note}`}</small>}</span>
                <span>{fmtQty(x.shipped)}</span>
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
function ConfirmModal({ order, rows, xrows, candMap, outlets, hasEta, hasNo, onClose, onOk }: {
  order: string[]; rows: Record<string, Row>; xrows: XRow[]; candMap: Map<string, Candidate>; outlets: Outlet[];
  hasEta: boolean; hasNo: boolean; onClose: () => void; onOk: (damaged: Damaged[]) => Promise<void>;
}) {
  const [damaged, setDamaged] = useState<Damaged[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const shipped = order.filter((c) => num(rows[c].shipped) > 0);
  // 预估会记的少发 / 多发（与伺服器同规则）：这张在那几张 PO 出的先补别张 DO 的少发，还欠的跟已记过的比、只记差额；
  // 超出所选 PO 的先补别张 PO「厂家会补」的少发
  const est = order.map((code) => {
    const c = candMap.get(code);
    const s = num(rows[code].shipped) || 0;
    const rem = c?.remaining ?? 0;
    const fill = Math.min(c?.fillable ?? 0, s, rem);
    const short = r3(Math.max(0, rem - s));
    const over = r3(Math.max(0, s - rem));
    return { c: code, rem, s, short, over, newShort: r3(Math.max(0, short - Math.max(0, (c?.flagged ?? 0) - fill))),
             newOver: r3(Math.max(0, over - (c?.await_elsewhere ?? 0))) };
  });
  const shorts = est.filter((x) => x.short > 0);
  const overs = est.filter((x) => x.over > 0);
  const wrongs = xrows.filter((x) => num(x.shipped) > 0);
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

  type Est = (typeof est)[number];
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
      <p className="muted small">确认后：各分店在「在路上」看得到这批货与 ETA；下面的少发 / 多发 / 发错型号会记到「厂家问题」（已记过的不会重复记）。</p>
      {!hasEta && <div className="podo-sum warn">还没填 ETA：分店会看到「未填」。可以确认后再补。</div>}
      {!hasNo && <div className="podo-sum warn">还没填厂家 DO 号。</div>}
      {shorts.length > 0 && <><h3>{`少发（${shorts.length}）`}</h3>{list(shorts, (x) => `还可以出 ${fmtQty(x.rem)} · 出 ${fmtQty(x.s)} · 少 ${fmtQty(x.short)}`
        + (x.newShort === 0 ? " · 已记过" : x.newShort < x.short ? ` · 新记 ${fmtQty(x.newShort)}` : ""))}</>}
      {overs.length > 0 && <><h3>{`多发（${overs.length}）`}</h3>{list(overs, (x) => `还可以出 ${fmtQty(x.rem)} · 出 ${fmtQty(x.s)} · 多 ${fmtQty(x.over)}`
        + (x.newOver < x.over ? ` · 先补厂家欠的 ${fmtQty(r3(x.over - x.newOver))}` : ""))}</>}
      {wrongs.length > 0 && (
        <>
          <h3>{`发错型号（${wrongs.length}）`}</h3>
          <ul className="list small">{wrongs.map((x) => <li key={x.key}><span>{x.src_code || x.src_desc}</span><span>{fmtQty(num(x.shipped))}</span></li>)}</ul>
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

