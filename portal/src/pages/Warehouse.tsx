// 仓库：查货（扫码）、每日小盘点、搬动登记、差异审核、印条码。路由 #/warehouse/<分页>
// 对 AutoCount 仍是只读：搬动与盘点差异都变成清单，负责人在 AutoCount 输入后回来标「已输入 / 已调整」。
import { FormEvent, useCallback, useEffect, useState } from "react";
import { BRANCH_LABEL, Me } from "../api";
import { go } from "../router";
import { Empty, ErrorBox, Modal, Tabs } from "../ui";
import "../att.css";
import "../wh.css";
import { shrinkImage, uploadPhoto } from "../att-api";
import { ScanBox } from "../wh/Scanner";
import Labels, { addLabels } from "../wh/Labels";
import {
  Count, COUNT_STATUS_LABEL, CountList, FoundItem, ItemDetail, Move, MOVE_KIND_LABEL, MOVE_KIND_SHORT, MOVE_STATUS_LABEL,
  MoveKind, qtyLabel, whenLabel, wh, WhMeta,
} from "../wh-api";

type Tab = "lookup" | "count" | "moves" | "review" | "labels";
const COMPANY_KEY = "hw-wh-company";

export default function Warehouse({ me, sub }: { me: Me; sub?: string }) {
  const [meta, setMeta] = useState<WhMeta | null>(null);
  const [error, setError] = useState("");
  const [company, setCompany] = useState(() => { try { return localStorage.getItem(COMPANY_KEY) || ""; } catch { return ""; } });
  useEffect(() => { wh.meta().then(setMeta).catch((e: Error) => setError(e.message)); }, []);
  if (!meta) return error ? <ErrorBox error={error} /> : <p className="muted">载入中…</p>;

  const co = meta.companies.includes(company) ? company : meta.companies[0];
  const canEdit = meta.level !== "view";
  const canApprove = meta.level === "approve";
  const tabs: [Tab, string][] = [["lookup", "查货"]];
  if (canEdit) tabs.push(["count", "盘点"]);
  tabs.push(["moves", "搬动"]);
  if (canApprove) tabs.push(["review", "差异审核"]);
  tabs.push(["labels", "印条码"]);
  const tab: Tab = tabs.some(([k]) => k === sub) ? (sub as Tab) : "lookup";
  const locs = meta.locations.filter((l) => l.company === co);
  const pick = (c: string) => { setCompany(c); try { localStorage.setItem(COMPANY_KEY, c); } catch { /* 忽略 */ } };

  return (
    <>
      <div className="page-head">
        <h1>仓库</h1>
        {meta.companies.length > 1 && (
          <select value={co} onChange={(e) => pick(e.target.value)} className="narrow-select">
            {meta.companies.map((c) => <option key={c} value={c}>{BRANCH_LABEL[c] || c}</option>)}
          </select>
        )}
      </div>
      <div className="filters"><Tabs value={tab} options={tabs} onChange={(k) => go(`/warehouse/${k}`)} /></div>
      {tab === "lookup" && <Lookup me={me} company={co} locs={locs.map((l) => l.code)} canEdit={canEdit} />}
      {tab === "count" && <CountTab company={co} locs={locs.filter((l) => l.counting).map((l) => l.code)} />}
      {tab === "moves" && <MovesTab me={me} company={co} locs={locs.map((l) => l.code)} canEdit={canEdit} canApprove={canApprove} />}
      {tab === "review" && <ReviewTab company={co} meta={meta} onMeta={setMeta} />}
      {tab === "labels" && <Labels company={co} locs={locs.map((l) => l.code)} />}
    </>
  );
}

// ------------------------------------------------------------------ 查货
function Lookup({ me, company, locs, canEdit }: { me: Me; company: string; locs: string[]; canEdit: boolean }) {
  const [item, setItem] = useState<ItemDetail | null>(null);
  const [found, setFound] = useState<FoundItem[] | null>(null);
  const [unknown, setUnknown] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [moving, setMoving] = useState(false);
  const [notice, setNotice] = useState("");

  const open = useCallback(async (code: string) => {
    setError(""); setNotice(""); setBusy(true);
    try {
      const d = await wh.item(company, code);
      if (d.found) { setItem(d); setFound(null); setUnknown(""); }
      else {
        const f = await wh.find(company, code);
        setItem(null);
        if (f.length === 1) { setItem(await wh.item(company, f[0].item_code)); setFound(null); setUnknown(""); }
        else { setFound(f); setUnknown(f.length === 0 ? code : ""); }
      }
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  }, [company]);
  useEffect(() => { setItem(null); setFound(null); setUnknown(""); }, [company]);

  return (
    <>
      <ScanBox onCode={open} busy={busy} />
      <ErrorBox error={error} />
      {notice && <div className="ok">{notice}</div>}
      {busy && <p className="muted">查找中…</p>}
      {found && found.length > 0 && (
        <ul className="list wh-found">
          {found.map((f) => (
            <li key={f.item_code} className="click" onClick={() => open(f.item_code)}>
              <span><b>{f.item_code}</b>{" "}<span className="muted small">{f.description}</span></span>
              <span className="nowrap">{qtyLabel(f.qty)}{" "}<span className="muted small">{f.uom}</span></span>
            </li>
          ))}
        </ul>
      )}
      {unknown && <Unknown code={unknown} company={company} canEdit={canEdit} onBound={(c) => open(c)} />}
      {item && (
        <ItemCard d={item} canEdit={canEdit}
                  onMove={() => setMoving(true)}
                  onLabel={() => { addLabels([{ item_code: item.item_code, description: item.description, copies: 1 }]); setNotice("已加入「印条码」清单。"); }} />
      )}
      {moving && item && (
        <MoveForm me={me} company={company} locs={locs} itemCode={item.item_code} onClose={() => setMoving(false)}
                  onSaved={() => { setMoving(false); setNotice("已登记，等负责人输入 AutoCount。"); open(item.item_code); }} />
      )}
    </>
  );
}

function Unknown({ code, company, canEdit, onBound }: { code: string; company: string; canEdit: boolean; onBound: (code: string) => void }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<FoundItem[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    if (q.trim().length < 2) { setHits([]); return; }
    const t = setTimeout(() => wh.find(company, q).then(setHits).catch(() => setHits([])), 250);
    return () => clearTimeout(t);
  }, [q, company]);
  return (
    <section className="card warn-card">
      <p>{`找不到「${code}」。`}</p>
      {canEdit && (
        <>
          <p className="muted small">如果这是纸箱上原本的条码，可以绑定到商品，之后扫这个码就会直接找到。</p>
          <input placeholder="找要绑定的商品（代号或品名）" value={q} onChange={(e) => setQ(e.target.value)} />
          <ErrorBox error={error} />
          <ul className="list">
            {hits.map((h) => (
              <li key={h.item_code}>
                <span><b>{h.item_code}</b>{" "}<span className="muted small">{h.description}</span></span>
                <button className="small-btn" onClick={() => wh.bind(company, code, h.item_code).then(() => onBound(code))
                  .catch((e: Error) => setError(e.message))}>绑定</button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function ItemCard({ d, canEdit, onMove, onLabel }: { d: ItemDetail; canEdit: boolean; onMove: () => void; onLabel: () => void }) {
  const total = d.stock.reduce((a, s) => a + Number(s.qty), 0);
  const hasPending = d.stock.some((s) => Number(s.pending) !== 0);
  const showCost = d.stock.some((s) => s.unit_cost != null);
  return (
    <section className="card wh-item">
      <div className="page-head">
        <div>
          <h2>{d.item_code}</h2>
          <p className="muted">{d.description}</p>
          <p className="small muted">{[d.item_group, d.item_type, d.uom].filter(Boolean).join(" · ")}{!d.active && " · 已停用"}</p>
        </div>
        <div className="actions">
          {canEdit && <button onClick={onMove}>登记搬动</button>}
          <button className="ghost" onClick={onLabel}>印条码</button>
        </div>
      </div>
      <div className="table-wrap flat">
        <table>
          <thead><tr><th>仓位</th><th className="num">AutoCount</th>{hasPending && <th className="num">未输入的搬动</th>}{hasPending && <th className="num">应有</th>}{showCost && <th className="num hide-sm">单位成本</th>}</tr></thead>
          <tbody>
            {d.stock.map((s) => (
              <tr key={s.location}>
                <td>{s.location}</td>
                <td className={"num" + (Number(s.qty) < 0 ? " late" : "")}>{qtyLabel(s.qty)}</td>
                {hasPending && <td className="num">{Number(s.pending) ? (Number(s.pending) > 0 ? "+" : "") + qtyLabel(s.pending) : ""}</td>}
                {hasPending && <td className="num"><b>{qtyLabel(Number(s.qty) + Number(s.pending))}</b></td>}
                {showCost && <td className="num hide-sm">{s.unit_cost != null ? Number(s.unit_cost).toFixed(2) : ""}</td>}
              </tr>
            ))}
            <tr className="total"><td>合计</td><td className="num">{qtyLabel(total)}</td>{hasPending && <td />}{hasPending && <td />}{showCost && <td className="hide-sm" />}</tr>
          </tbody>
        </table>
      </div>
      {d.stock.some((s) => Number(s.qty) < 0) && <p className="small late">库存是负数：货从系统认为没有货的仓位出去了，请盘点这个仓位，并检查调仓有没有输入。</p>}
      {d.open_orders.length > 0 && (
        <>
          <h3>{`未出货订单（${d.open_orders.length}）`}</h3>
          <ul className="list">{d.open_orders.map((o) => <li key={o.doc_no}><span>{o.doc_no}{" "}<span className="muted small">{`${o.doc_date} · ${o.customer || ""}`}</span></span><span>{qtyLabel(o.qty)}</span></li>)}</ul>
        </>
      )}
      {d.incoming.length > 0 && (
        <>
          <h3>{`在途 PO（${d.incoming.length}）`}</h3>
          <ul className="list">{d.incoming.map((o) => <li key={o.po_no + o.location}><span>{o.po_no}{" "}<span className="muted small">{`${o.po_date} · ${o.supplier} → ${o.location}`}</span></span><span>{qtyLabel(o.qty)}</span></li>)}</ul>
        </>
      )}
      {d.moves.length > 0 && (
        <>
          <h3>最近搬动</h3>
          <ul className="list">{d.moves.map((m) => <li key={m.id}><span>{moveText(m)}{" "}<span className="muted small">{`${whenLabel(m.created_at)} · ${m.created_by_name}`}</span></span><span className={"ap " + (m.status === "pending" ? "pending" : m.status === "done" ? "approved" : "cancelled")}>{MOVE_STATUS_LABEL[m.status]}</span></li>)}</ul>
        </>
      )}
      {d.counts.length > 0 && (
        <>
          <h3>最近盘点</h3>
          <ul className="list">{d.counts.map((c) => <li key={c.id}><span>{`${c.location} · 数到 ${qtyLabel(c.qty)}`}{c.diff != null && Number(c.diff) !== 0 ? ` · 差 ${Number(c.diff) > 0 ? "+" : ""}${qtyLabel(c.diff)}` : ""}{" "}<span className="muted small">{`${whenLabel(c.counted_at)} · ${c.counted_by_name}`}</span></span><span className={"ap " + countClass(c)}>{COUNT_STATUS_LABEL[c.status]}</span></li>)}</ul>
        </>
      )}
      {d.barcodes.length > 0 && <p className="muted small">{`绑定的纸箱条码：${d.barcodes.join("、")}`}</p>}
    </section>
  );
}

function moveText(m: Move): string {
  const route = m.from_loc && m.to_loc ? `${m.from_loc} → ${m.to_loc}` : m.from_loc ? `${m.from_loc} →` : `→ ${m.to_loc}`;
  return `${MOVE_KIND_SHORT[m.kind]} ${qtyLabel(m.qty)} · ${route}`;
}
function countClass(c: Count): string {
  return c.status === "match" || c.status === "adjusted" ? "approved" : c.status === "variance" ? "rejected" : "cancelled";
}

// ------------------------------------------------------------------ 搬动登记
const DEFAULT_TO: Partial<Record<MoveKind, string>> = { defect: "DEFECTS", display: "DISPLAY" };

function MoveForm({ me, company, locs, itemCode, onClose, onSaved }: {
  me: Me; company: string; locs: string[]; itemCode?: string; onClose: () => void; onSaved: (m: Move) => void;
}) {
  const [code, setCode] = useState(itemCode || "");
  const [desc, setDesc] = useState("");
  const [kind, setKind] = useState<MoveKind>("transfer");
  const [qty, setQty] = useState("");
  const [from, setFrom] = useState(locs[0] || "");
  const [to, setTo] = useState("");
  const [note, setNote] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const needFrom = kind !== "return";
  const needTo = kind === "transfer" || kind === "return" || kind === "defect" || kind === "display";

  useEffect(() => {
    if (!code) { setDesc(""); return; }
    wh.item(company, code).then((d) => setDesc(d.found ? `${d.item_code} · ${d.description}` : "找不到这个商品")).catch(() => setDesc(""));
  }, [code, company]);
  useEffect(() => {
    const d = DEFAULT_TO[kind];
    if (d && locs.includes(d)) setTo(d);
    else if (kind === "transfer") setTo((t) => (t && t !== from ? t : locs.find((l) => l !== from) || ""));
  }, [kind]); // eslint-disable-line react-hooks/exhaustive-deps

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      let photo: string | null = null;
      if (file) {
        const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kuala_Lumpur" }).format(new Date());
        photo = await uploadPhoto(me.staff.id, today, "wh", await shrinkImage(file));
      }
      onSaved(await wh.saveMove({ company, item_code: code, qty, kind, from_loc: needFrom ? from : null,
                                  to_loc: needTo ? to : null, note, photo }));
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal title="登记搬动" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        {itemCode ? <p><b>{desc || itemCode}</b></p> : (
          <>
            <ScanBox onCode={setCode} placeholder="扫商品条码或打代号" />
            {code && <p className="small">{desc}</p>}
          </>
        )}
        <label>做什么
          <select value={kind} onChange={(e) => setKind(e.target.value as MoveKind)}>
            {Object.entries(MOVE_KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <div className="row">
          {needFrom && (
            <label>从哪个仓位
              <select value={from} onChange={(e) => setFrom(e.target.value)}>
                {locs.map((l) => <option key={l} value={l}>{l}</option>)}
              </select>
            </label>
          )}
          {needTo && (
            <label>到哪个仓位
              <select value={to} onChange={(e) => setTo(e.target.value)} required>
                <option value="">请选</option>
                {locs.filter((l) => l !== from || !needFrom).map((l) => <option key={l} value={l}>{l}</option>)}
              </select>
            </label>
          )}
          <label>数量<input type="number" inputMode="decimal" min="0.01" step="any" value={qty} onChange={(e) => setQty(e.target.value)} required /></label>
        </div>
        <label>{kind === "writeoff" || kind === "other" ? "原因（必填）" : "备注（选填）"}
          <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500}
                 placeholder={kind === "defect" ? "例：纸箱压坏、马桶裂" : kind === "return" ? "例：客户退货，单号…" : ""} /></label>
        <label>照片（选填）<input type="file" accept="image/*" capture="environment" onChange={(e) => setFile(e.target.files?.[0] || null)} /></label>
        <p className="muted small">登记后会出现在「搬动」的待输入清单，负责人在 AutoCount 开转仓 / 调整单后标「已输入」。还没输入前，盘点会自动把这笔算进去。</p>
        <ErrorBox error={error} />
        <div className="actions">
          <button type="button" className="ghost" onClick={onClose}>取消</button>
          <button disabled={busy || !code}>{busy ? "储存中…" : "登记"}</button>
        </div>
      </form>
    </Modal>
  );
}

function MovesTab({ me, company, locs, canEdit, canApprove }: {
  me: Me; company: string; locs: string[]; canEdit: boolean; canApprove: boolean;
}) {
  const [status, setStatus] = useState<"pending" | "done" | "all">("pending");
  const [rows, setRows] = useState<Move[] | null>(null);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [doc, setDoc] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setRows(null); setError(""); setPicked(new Set());
    wh.moves({ company, status }).then(setRows).catch((e: Error) => setError(e.message));
  }, [company, status]);
  useEffect(load, [load]);

  async function mark(action: "done" | "cancelled", ids: number[]) {
    setBusy(true); setError("");
    try { await wh.markMoves(ids, action, doc); setDoc(""); load(); } catch (e) { setError((e as Error).message); }
    setBusy(false);
  }
  const toggle = (id: number) => setPicked((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  return (
    <>
      <div className="filters">
        <Tabs value={status} onChange={setStatus} options={[["pending", "待输入 AutoCount"], ["done", "已输入"], ["all", "全部"]]} />
        {canEdit && <button onClick={() => setAdding(true)}>＋ 登记搬动</button>}
      </div>
      <ErrorBox error={error} />
      {!rows ? (!error && <p className="muted">载入中…</p>) : rows.length === 0 ? (
        <Empty>{status === "pending" ? "没有待输入的搬动。" : "没有纪录。"}</Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr>{canApprove && status === "pending" && <th />}<th>搬动</th><th className="hide-sm">登记</th><th>状态</th></tr></thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.id}>
                  {canApprove && status === "pending" && <td><input type="checkbox" checked={picked.has(m.id)} onChange={() => toggle(m.id)} /></td>}
                  <td><b>{m.item_code}</b>{" "}<span>{moveText(m)}</span>{" "}<span className="muted small">{m.uom}</span>
                    <div className="muted small">{m.description}</div>{m.note && <div className="small">{m.note}</div>}
                    <div className="muted small show-sm">{`${m.created_by_name} · ${whenLabel(m.created_at)}`}</div></td>
                  <td className="small nowrap hide-sm">{m.created_by_name}<div className="muted">{whenLabel(m.created_at)}</div></td>
                  <td>
                    <span className={"ap " + (m.status === "pending" ? "pending" : m.status === "done" ? "approved" : "cancelled")}>{MOVE_STATUS_LABEL[m.status]}</span>
                    {m.ac_doc && <div className="muted small">{m.ac_doc}</div>}
                    {m.status === "pending" && !canApprove && m.created_by === me.staff.id && (
                      <div><a href="#" className="small" onClick={(e) => { e.preventDefault(); mark("cancelled", [m.id]); }}>取消</a></div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {canApprove && status === "pending" && rows && rows.length > 0 && (
        <div className="actions left wh-bulk">
          <input placeholder="AutoCount 单号（选填，例：转仓单号）" value={doc} onChange={(e) => setDoc(e.target.value)} />
          <button disabled={busy || !picked.size} onClick={() => mark("done", [...picked])}>{`✓ 已输入 AutoCount（${picked.size}）`}</button>
          <button className="ghost danger" disabled={busy || !picked.size} onClick={() => mark("cancelled", [...picked])}>取消（登记错）</button>
        </div>
      )}
      {adding && <MoveForm me={me} company={company} locs={locs} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); load(); }} />}
    </>
  );
}

// ------------------------------------------------------------------ 每日小盘点
function CountTab({ company, locs }: { company: string; locs: string[] }) {
  const [loc, setLoc] = useState(() => { try { return localStorage.getItem("hw-wh-loc") || ""; } catch { return ""; } });
  const [data, setData] = useState<CountList | null>(null);
  const [error, setError] = useState("");
  const [counting, setCounting] = useState<{ code: string; desc: string; uom: string; recount?: boolean } | null>(null);
  const [notice, setNotice] = useState<[string, string] | null>(null);
  const location = locs.includes(loc) ? loc : locs[0] || "";

  const load = useCallback(() => {
    if (!location) return;
    setError("");
    wh.countList(company, location).then(setData).catch((e: Error) => setError(e.message));
  }, [company, location]);
  useEffect(() => { setData(null); load(); }, [load]);

  async function scan(code: string) {
    setNotice(null); setError("");
    try {
      const d = await wh.item(company, code);
      if (!d.found) { setError(`找不到「${code}」。可以到「查货」把纸箱条码绑定到商品。`); return; }
      setCounting({ code: d.item_code, desc: d.description, uom: d.uom, recount: data?.recount.includes(d.item_code) });
    } catch (e) { setError((e as Error).message); }
  }

  if (!locs.length) return <Empty>没有要盘点的仓位。</Empty>;
  const p = data?.progress;
  return (
    <>
      <div className="filters">
        <label className="inline">仓位
          <select value={location} onChange={(e) => { setLoc(e.target.value); try { localStorage.setItem("hw-wh-loc", e.target.value); } catch { /* 忽略 */ } }}>
            {locs.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
        </label>
        {p && <span className="muted small">{`近 30 天已盘 ${p.counted_30d} / ${p.items} 个商品`}</span>}
      </div>
      <ScanBox onCode={scan} placeholder="扫要盘的商品，或打代号" />
      <ErrorBox error={error} />
      {notice && <div className={notice[0]}>{notice[1]}</div>}
      {!data ? (!error && <p className="muted">载入中…</p>) : (
        <>
          {data.recount.length > 0 && (
            <section className="card warn-card">
              <b>要再数一次</b>
              <ul className="list">{data.recount.map((c) => <li key={c} className="click" onClick={() => scan(c)}><span>{c}</span><span className="late">再数 →</span></li>)}</ul>
            </section>
          )}
          <h2 className="section-title">{`今天要盘（${data.todo.length}）`}</h2>
          {data.todo.length === 0 ? <Empty>这个仓位今天的都盘完了，或 30 天内都盘过了。</Empty> : (
            <ul className="list card wh-todo">
              {data.todo.map((t) => (
                <li key={t.item_code} className="click" onClick={() => setCounting({ code: t.item_code, desc: t.description, uom: t.uom })}>
                  <span><b>{t.item_code}</b>{" "}<span className="muted small">{t.description}</span></span>
                  <span className="go">盘 →</span>
                </li>
              ))}
            </ul>
          )}
          <p className="muted small">系统每天挑一批：库存是负数的先盘，然后是卖得快、值钱的；30 天内盘过的不会再出现。看不到系统数量是故意的（盲盘），照实际数到的填。最好在早上开工前或同步之后马上盘。</p>
          {data.done_today.length > 0 && (
            <>
              <h2 className="section-title">{`今天已盘（${data.done_today.length}）`}</h2>
              <ul className="list card">
                {data.done_today.map((c) => (
                  <li key={c.id}><span><b>{c.item_code}</b>{` 数到 ${qtyLabel(c.qty)} ${c.uom || ""}`}{" "}<span className="muted small">{`${whenLabel(c.counted_at)} · ${c.counted_by_name}`}</span></span>
                    <span className={"ap " + countClass(c)}>{c.status === "variance" && c.attempt === 1 ? "要再数" : COUNT_STATUS_LABEL[c.status]}</span></li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
      {counting && (
        <CountForm company={company} location={location} item={counting} onClose={() => setCounting(null)}
                   onSaved={(r) => {
                     if (r === "recount") {
                       setCounting({ ...counting, recount: true });
                       setNotice(["error", `${counting.code} 跟系统不一样，请再仔细数一次（包括别的货架、坏货、展示品有没有放错）。`]);
                     } else {
                       setCounting(null);
                       setNotice(r === "match" ? ["ok", `✓ ${counting.code} 相符。`] : ["error", `${counting.code} 第二次还是不一样，已记录为差异，交给主管审核。`]);
                     }
                     load();
                   }} />
      )}
    </>
  );
}

function CountForm({ company, location, item, onClose, onSaved }: {
  company: string; location: string; item: { code: string; desc: string; uom: string; recount?: boolean };
  onClose: () => void; onSaved: (r: "match" | "recount" | "variance") => void;
}) {
  const [qty, setQty] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { setQty(""); setNote(""); setBusy(false); }, [item.recount]);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError("");
    try {
      const r = await wh.saveCount({ company, location, item_code: item.code, qty, note });
      onSaved(r.result);
    } catch (err) { setError((err as Error).message); setBusy(false); }
  }
  return (
    <Modal title={item.recount ? `再数一次 · ${location}` : `盘点 · ${location}`} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <p><b>{item.code}</b><br /><span className="muted">{item.desc}</span></p>
        {item.recount && <p className="late small">第一次数的跟系统不一样，请再仔细数一次。</p>}
        <label>{`实际数到几${item.uom ? `（${item.uom}）` : ""}`}
          <input className="big-num" type="number" inputMode="decimal" min="0" step="any" value={qty} autoFocus
                 onChange={(e) => setQty(e.target.value)} required /></label>
        <label>备注（选填）<input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="例：2 箱压坏、1 件在展示区" /></label>
        <ErrorBox error={error} />
        <div className="actions">
          <button type="button" className="ghost" onClick={onClose}>取消</button>
          <button disabled={busy || qty === ""}>{busy ? "储存中…" : "确认"}</button>
        </div>
      </form>
    </Modal>
  );
}

// ------------------------------------------------------------------ 差异审核（可审批）
function ReviewTab({ company, meta, onMeta }: { company: string; meta: WhMeta; onMeta: (m: WhMeta) => void }) {
  const [status, setStatus] = useState<"variance" | "adjusted" | "ignored" | "all">("variance");
  const [rows, setRows] = useState<Count[] | null>(null);
  const [error, setError] = useState("");
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [doc, setDoc] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [settings, setSettings] = useState(false);

  const load = useCallback(() => {
    setRows(null); setError(""); setPicked(new Set());
    wh.counts({ company, status }).then(setRows).catch((e: Error) => setError(e.message));
  }, [company, status]);
  useEffect(load, [load]);

  async function review(action: "adjusted" | "ignored" | "recount") {
    setBusy(true); setError("");
    try { await wh.review([...picked], action, doc, note); setDoc(""); setNote(""); load(); }
    catch (e) { setError((e as Error).message); }
    setBusy(false);
  }
  const toggle = (id: number) => setPicked((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const sum = (rows || []).reduce((a, r) => a + Number(r.diff_value || 0), 0);

  function csv() {
    if (!rows) return;
    const head = ["日期", "仓位", "商品代号", "品名", "单位", "AutoCount", "未输入搬动", "应有", "实盘", "差额", "成本差额", "盘点人", "备注"];
    const lines = rows.map((r) => [r.count_date, r.location, r.item_code, r.description, r.uom, r.system_qty, r.pending_qty,
      r.expected_qty, r.qty, r.diff, r.diff_value, r.counted_by_name, r.note]);
    const text = [head, ...lines].map((l) => l.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\r\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(["﻿" + text], { type: "text/csv;charset=utf-8" }));
    a.download = `盘点差异_${company}_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
  }

  return (
    <>
      <div className="filters">
        <Tabs value={status} onChange={setStatus} options={[["variance", "待审核"], ["adjusted", "已调整"], ["ignored", "不调整"], ["all", "全部"]]} />
        <button className="ghost" disabled={!rows?.length} onClick={csv}>下载 CSV（Excel）</button>
        <button className="ghost" onClick={() => setSettings(true)}>仓位设定</button>
      </div>
      <ErrorBox error={error} />
      {!rows ? (!error && <p className="muted">载入中…</p>) : rows.length === 0 ? <Empty>{status === "variance" ? "没有待审核的差异。" : "没有纪录。"}</Empty> : (
        <div className="table-wrap">
          <table>
            <thead><tr>{status === "variance" && <th />}<th>商品</th><th>仓位</th><th className="num">应有</th><th className="num">实盘</th><th className="num">差额</th><th className="num hide-sm">成本差额</th><th className="hide-sm">盘点</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  {status === "variance" && <td><input type="checkbox" checked={picked.has(r.id)} onChange={() => toggle(r.id)} /></td>}
                  <td><b>{r.item_code}</b><div className="muted small">{r.description}</div>{r.note && <div className="small">{r.note}</div>}
                    {r.status !== "variance" && <div className="muted small">{`${COUNT_STATUS_LABEL[r.status]}${r.ac_doc ? ` · ${r.ac_doc}` : ""}${r.review_note ? ` · ${r.review_note}` : ""}`}</div>}</td>
                  <td>{r.location}</td>
                  <td className="num">{qtyLabel(r.expected_qty)}{Number(r.pending_qty) !== 0 && <div className="muted small">{`AC ${qtyLabel(r.system_qty)}`}</div>}</td>
                  <td className="num">{qtyLabel(r.qty)}{r.attempt === 1 && r.status === "variance" && <div className="muted small">未重数</div>}</td>
                  <td className={"num" + (Number(r.diff) ? " late" : "")}>{Number(r.diff) > 0 ? "+" : ""}{qtyLabel(r.diff)}</td>
                  <td className="num hide-sm">{Number(r.diff_value || 0).toFixed(2)}</td>
                  <td className="hide-sm small">{r.counted_by_name}<div className="muted">{whenLabel(r.counted_at)}</div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {rows && rows.length > 0 && <p className="muted small">{`成本差额合计 RM ${sum.toFixed(2)}（负数 = 少了）。差额 = 实盘 − 应有；应有 = AutoCount 库存 + 还没输入 AutoCount 的搬动。`}</p>}
      {status === "variance" && rows && rows.length > 0 && (
        <div className="card wh-bulk">
          <p className="small">{`选了 ${picked.size} 笔：在 AutoCount 开库存调整单（Stock Adjustment）后按「已调整」；查到原因不必调的按「不调整」并写原因；觉得数错了按「请重盘」（明天会再出现在清单）。`}</p>
          <div className="row">
            <input placeholder="AutoCount 调整单号（选填）" value={doc} onChange={(e) => setDoc(e.target.value)} />
            <input placeholder="原因 / 备注（不调整时必填）" value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          <div className="actions left">
            <button disabled={busy || !picked.size} onClick={() => review("adjusted")}>✓ 已调整</button>
            <button className="ghost" disabled={busy || !picked.size} onClick={() => review("ignored")}>不调整</button>
            <button className="ghost" disabled={busy || !picked.size} onClick={() => review("recount")}>请重盘</button>
          </div>
        </div>
      )}
      {settings && <LocationSettings company={company} meta={meta} onClose={() => setSettings(false)}
                                     onSaved={() => wh.meta().then(onMeta)} />}
    </>
  );
}

function LocationSettings({ company, meta, onClose, onSaved }: { company: string; meta: WhMeta; onClose: () => void; onSaved: () => void }) {
  const [error, setError] = useState("");
  const rows = meta.locations.filter((l) => l.company === company);
  const save = (p: Record<string, unknown>) => wh.saveLocation({ company, ...p }).then(onSaved).catch((e: Error) => setError(e.message));
  return (
    <Modal title="仓位设定" onClose={onClose}>
      <p className="muted small">每天每个仓位要盘几件；不用盘的仓位（例：EGO、JB RESER）取消勾选。</p>
      <ErrorBox error={error} />
      <div className="table-wrap flat">
        <table>
          <thead><tr><th>仓位</th><th>要盘点</th><th className="num">每天几件</th></tr></thead>
          <tbody>
            {rows.map((l) => (
              <tr key={l.code}>
                <td>{l.code}</td>
                <td><input type="checkbox" checked={l.counting} onChange={(e) => save({ code: l.code, counting: e.target.checked })} /></td>
                <td className="num"><input className="num-input" type="number" min="1" max="500" defaultValue={l.daily_target}
                                           onBlur={(e) => Number(e.target.value) !== l.daily_target && save({ code: l.code, daily_target: e.target.value })} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="actions"><button onClick={onClose}>完成</button></div>
    </Modal>
  );
}
