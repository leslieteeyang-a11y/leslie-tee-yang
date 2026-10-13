// 厂家到货（一张厂家 DO / 装箱单）：#/purchasing/do/new 新开（选厂家 → 选 PO → 编辑），#/purchasing/do/<id> 打开。
// 草稿：每个型号填这批出货、分给各分店（同型号可拆），存草稿 / 确认。确认后只能改表头（DO 号、日期、ETA、货柜、备注、附件），
// 要改货品先「退回草稿」（订货可审批）。数量都不含单价。只有订货部（订货「可编辑」）开。
// SOP（使用者 2026-10-13）：上方显示第几步、等哪个部门（① 选 PO ② 出货数量 ③ 分配分店 ④ ETA ⑤ 确认 → ⑥ 点货（仓库部）→ ⑦ 厂家问题（采购））。
// 「这批的问题」：少发自动列出、先选厂家会补 / 取消 / 未决定（确认时套到自动产生的少发）；多发自动列出；来错的型号（搜我们的商品或
// 「不是我们的产品」、要厂家怎么处理）；缺零件 / 其他要补的。确认后可「📱 WhatsApp 发给厂家」。
// 拆档（2026-10-13，只搬程式码）：草稿资料列 doRows.ts、这批的问题 DoProblems.tsx、唯读 / 确认画面 DoViews.tsx、型号表 DoItemsTable.tsx。
import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import { api, BRANCH_LABEL, fmtDate, fmtQty, Me, Shipment, todayKL } from "../api";
import { go, replaceRoute, setLeaveGuard } from "../router";
import { ErrorBox, Modal } from "../ui";
import {
  Candidate, DO_ACTION_LABEL, DoFile, DoFull, DoSop, DoSupplier, downloadDoFile, isSheet, joinList, newClientKey,
  num, Outlet, podo, ui, uploadDoFile,
} from "../podo-api";
import { AskModal, DoStatusBadge, ErrorLines, EtaText, SopSteps } from "./common";
import { ImportPanel, ImportResult } from "./Import";
import { AddIssueModal, IssueTable } from "./Issues";
import { PoPicker, SupplierPicker } from "./Pickers";
import { readWorkbook, Sheet } from "./parse";
import { waIssuesText, WaModal } from "./whatsapp";
import { OwedHint, ProblemsPanel, ProblemSummary } from "./DoProblems";
import { AppliedView, ConfirmModal, ItemsView, ReceiptSummary } from "./DoViews";
import { HeadCard, ItemsTable } from "./DoSections";
import {
  allocByRemaining, allocSum, defaultRow, estimate, fullRow, PRow, prowsFromFull, r3, Row, rowsFromFull, Start, withShipped,
  xkey, XRow, xrowsFromFull,
} from "./doRows";

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
      <HeadCard head={head} setHead={setHead} touch={touch} infoEditable={infoEditable} busy={busy} full={full} ships={ships} ship={ship}
                files={files} setFiles={setFiles} onUpload={onUpload} draftEditable={draft && editable}
                onRead={draft && editable ? (f) => run("读取中…", async () => openSheet(f.name, await downloadDoFile(f))) : undefined} />

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
            <ItemsTable shown={shown} rows={rows} candMap={candMap} showCols={showCols} editable={editable} setRow={setRow}
                        totShipped={totShipped} totAlloc={totAlloc} />

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
