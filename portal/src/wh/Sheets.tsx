// 仓库 · 盘点单清单（#/warehouse/count/sheets）：进行中 / 已结束；主管（仓库可审批）建盘点单：
// 仓位 + 范围（整个仓位 / 选几个货架 / 贴商品代号）+ 指派人 + 期限。员工点进去用手机盲盘。
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { getLang } from "../i18n";
import { go } from "../router";
import { Empty, ErrorBox, Modal, Tabs } from "../ui";
import { BinRow, bins as binApi } from "../wh-bin-api";
import { SCOPE_LABEL, SHEET_STATUS_LABEL, Sheet, SheetScope, SheetStaff, binsShort, sheets } from "../wh-sheet-api";
import "../wh-sheet.css";

export const AC_WARN = "AutoCount 挡不了出货：盘的时候请门市暂停这个仓位出货，或下班后盘。已开、还没拣的 DO 已经算进应有：货还在货架上就照数，已经拣好放在出货区的不要算。";

export default function SheetsTab({ company, locs, canApprove }: { company: string; locs: string[]; canApprove: boolean }) {
  const [status, setStatus] = useState<"open" | "done" | "all">("open");
  const [mine, setMine] = useState(false);
  const [rows, setRows] = useState<Sheet[] | null>(null);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);

  const load = useCallback(() => {
    setRows(null); setError("");
    sheets.list(company, status, mine).then(setRows).catch((e: Error) => setError(e.message));
  }, [company, status, mine]);
  useEffect(load, [load]);

  return (
    <>
      <div className="filters ws-bar">
        <Tabs value={status} onChange={setStatus} options={[["open", "进行中"], ["done", "已结束"], ["all", "全部"]]} />
        <label className="check ws-fixed"><input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} />只看指派给我的</label>
        {canApprove && <button onClick={() => setCreating(true)}>＋ 建盘点单</button>}
      </div>
      <ErrorBox error={error} />
      {!rows ? (!error && <p className="muted">载入中…</p>) : rows.length === 0 ? (
        <Empty>{status === "open" ? (canApprove ? "没有进行中的盘点单。按「＋ 建盘点单」指定要盘的仓位、货架或商品，再指派给同事。" : "没有进行中的盘点单。") : "没有纪录。"}</Empty>
      ) : (
        <div className="ws-cards">
          {rows.map((s) => <SheetCard key={s.id} s={s} />)}
        </div>
      )}
      {creating && <CreateSheet company={company} locs={locs} onClose={() => setCreating(false)}
                                onCreated={(s) => { setCreating(false); go(`/warehouse/count/${s.id}`); }} />}
    </>
  );
}

function SheetCard({ s }: { s: Sheet }) {
  const pct = s.total ? Math.round((s.done / s.total) * 100) : 0;
  const people = [...s.assignees, ...s.helpers].map((p) => `${p.name} ${p.n}`).join("、");
  return (
    <a className="card ws-card" href={`#/warehouse/count/${s.id}`}>
      <div className="ws-card-head">
        <b>{s.title}</b>
        {s.mine && s.status === "open" && <span className="tag">指派给我</span>}
        <span className={"ap " + (s.status === "open" ? "pending" : s.status === "closed" ? "approved" : "cancelled")}>{SHEET_STATUS_LABEL[s.status]}</span>
      </div>
      <div className="muted small">{`${s.location} · ${SCOPE_LABEL[s.scope]}${s.scope === "bins" ? binsShort(s.bins, 4) : ""}`}</div>
      <div className="ws-progress" aria-hidden="true"><span style={{ width: `${pct}%` }} /></div>
      <div className="ws-nums small">
        <span>{`已盘 ${s.done} / ${s.total}`}</span>
        {s.recount > 0 && <span className="amber">{`要再数 ${s.recount}`}</span>}
        {s.variance > 0 && <span className="late">{`差异 ${s.variance}`}</span>}
        {s.due_date && <span className={s.overdue ? "late" : "muted"}>{`期限 ${s.due_date}`}</span>}
      </div>
      {people && <div className="muted small">{`盘点人：${people}`}</div>}
    </a>
  );
}

// ------------------------------------------------------------ 建盘点单
function CreateSheet({ company, locs, onClose, onCreated }: {
  company: string; locs: string[]; onClose: () => void; onCreated: (s: Sheet) => void;
}) {
  const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);   // 马来西亚日期
  const [location, setLocation] = useState(locs[0] || "");
  const [title, setTitle] = useState("");
  const [scope, setScope] = useState<SheetScope>("location");
  const [binList, setBinList] = useState<BinRow[] | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [itemsText, setItemsText] = useState("");
  const [staff, setStaff] = useState<SheetStaff[] | null>(null);
  const [assignees, setAssignees] = useState<Set<number>>(new Set());
  const [due, setDue] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => { sheets.staff(company).then(setStaff).catch((e: Error) => setError(e.message)); }, [company]);
  useEffect(() => {
    setBinList(null); setPicked(new Set());
    if (scope === "bins" && location) binApi.list(company, location).then((d) => setBinList(d.bins)).catch((e: Error) => setError(e.message));
  }, [company, location, scope]);

  const codes = useMemo(() => [...new Set(itemsText.split(/[\s,;，、]+/).map((x) => x.trim()).filter(Boolean))], [itemsText]);
  const zones = useMemo(() => {
    const m = new Map<string, BinRow[]>();
    for (const b of binList || []) m.set(b.zone, [...(m.get(b.zone) || []), b]);
    return [...m.entries()];
  }, [binList]);
  // 没填名称就用这个（英文模式存英文，免得资料是中文）
  const defTitle = getLang() === "en" ? `${location} count ${today.slice(5)}` : `${location} 盘点 ${today.slice(5)}`;

  const toggle = (set: Set<number>, id: number) => { const n = new Set(set); n.has(id) ? n.delete(id) : n.add(id); return n; };

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (scope === "bins" && picked.size === 0) { setError("请选要盘的货架。"); return; }
    if (scope === "items" && codes.length === 0) { setError("请贴上要盘的商品代号。"); return; }
    if (assignees.size === 0) { setError("请至少指派一个人。"); return; }
    setBusy(true);
    try {
      const s = await sheets.create({
        company, location, title: title.trim() || defTitle, scope, due_date: due || null, note,
        bins: scope === "bins" ? [...picked] : undefined, items: scope === "items" ? codes : undefined,
        assignees: [...assignees],
      });
      onCreated(s);
    } catch (err) { setError((err as Error).message); setBusy(false); }
  }

  return (
    <Modal title="建盘点单" onClose={onClose} wide>
      <form className="form" onSubmit={submit}>
        <div className="row">
          <label>仓位
            <select value={location} onChange={(e) => setLocation(e.target.value)}>
              {locs.map((l) => <option key={l} value={l}>{l}</option>)}
            </select>
          </label>
          <label>名称<input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} placeholder={defTitle} /></label>
        </div>
        <div>
          <div className="small muted ws-label">要盘什么</div>
          {/* ui.tsx 的 Tabs 按键没有 type="button"：放在 form 里按一下会送出表单，所以挡掉预设动作 */}
          <div onClick={(e) => e.preventDefault()}>
            <Tabs value={scope} onChange={setScope} options={[["location", "整个仓位"], ["bins", "选几个货架"], ["items", "贴商品代号"]]} />
          </div>
        </div>
        {scope === "location" && <p className="small muted">AutoCount 在这个仓位有库存的（含负数）、货架上记了的、还没输入 AutoCount 要进这个仓位的商品，全部列进来。</p>}
        {scope === "bins" && (
          !binList ? <p className="muted small">载入中…</p> : binList.length === 0 ? <p className="small muted">这个仓位还没有货架。请先在「货架」建货架，或改用「整个仓位」。</p> : (
            <div className="ws-binpick">
              <p className="small muted">{`会列出选的货架上记过的商品。已选 ${picked.size} 个货架。`}</p>
              {zones.map(([z, bs]) => (
                <div key={z} className="ws-zone">
                  <div className="ws-zone-head">
                    <b>{z ? `${z} 区` : "（没分区）"}</b>
                    <button type="button" className="ghost small" onClick={() => setPicked((p) => {
                      const n = new Set(p); const all = bs.every((b) => n.has(b.id));
                      bs.forEach((b) => (all ? n.delete(b.id) : n.add(b.id))); return n;
                    })}>{bs.every((b) => picked.has(b.id)) ? "全不选" : "全选"}</button>
                  </div>
                  <div className="ws-chips">
                    {bs.map((b) => (
                      <label key={b.id} className={"ws-chip" + (picked.has(b.id) ? " on" : "")}>
                        <input type="checkbox" checked={picked.has(b.id)} onChange={() => setPicked((p) => toggle(p, b.id))} />
                        <span>{b.code}</span><small>{`${b.items} 种`}</small>
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )
        )}
        {scope === "items" && (
          <label>{`商品代号（一行一个，或从 Excel 整栏贴上）${codes.length ? ` · ${codes.length} 个` : ""}`}
            <textarea rows={5} value={itemsText} onChange={(e) => setItemsText(e.target.value)} placeholder={"HM-UB001\nHM-WC300"} />
          </label>
        )}
        <div>
          <div className="small muted ws-label">指派给（仓库「可编辑」以上的同事）</div>
          {!staff ? <p className="muted small">载入中…</p> : staff.length === 0 ? <p className="small muted">这间分店没有可以指派的人。</p> : (
            <div className="ws-chips">
              {staff.map((p) => (
                <label key={p.id} className={"ws-chip" + (assignees.has(p.id) ? " on" : "")}>
                  <input type="checkbox" checked={assignees.has(p.id)} onChange={() => setAssignees((a) => toggle(a, p.id))} />
                  <span>{p.name}</span>{p.department !== "warehouse" && p.department_name && <small>{p.department_name}</small>}
                </label>
              ))}
            </div>
          )}
        </div>
        <div className="row">
          <label>期限（选填）<input type="date" value={due} min={today} onChange={(e) => setDue(e.target.value)} /></label>
          <label>备注（选填）<input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="例：下班后盘、先盘 A 区" /></label>
        </div>
        <p className="ws-warn small">{AC_WARN}</p>
        <ErrorBox error={error} />
        <div className="actions">
          <button type="button" className="ghost" onClick={onClose}>取消</button>
          <button disabled={busy}>{busy ? "储存中…" : "建立盘点单"}</button>
        </div>
      </form>
    </Modal>
  );
}
