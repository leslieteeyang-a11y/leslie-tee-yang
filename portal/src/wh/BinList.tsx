// 仓库 · 货架 · 货架清单：按仓位 → 区 → 货架分组，每格 = 一层（代号、几种商品、件数、最后更新）。
// 点一格看货架明细（上面的商品、最近变动）；可审批：建货架 / 一次建很多 / 改备注 / 停用。勾选货架印标签（BinLabels）。
import { useEffect, useState } from "react";
import { go } from "../router";
import { Empty, ErrorBox, Modal } from "../ui";
import { qtyLabel, whenLabel } from "../wh-api";
import { BIN_LOG_LABEL, BinDetail, BinList, BinRow, bins } from "../wh-bin-api";
import { BinLabelBar } from "./BinLabels";
import { rememberLoc } from "./binLoc";

/** 「R1-R10, R12」→ R1…R10、R12；「1-4」→ 1…4；「A-D」→ A…D；逗号、顿号、换行分开 */
export function expandList(s: string): string[] {
  const out: string[] = [];
  for (const raw of s.split(/[,，、;；\n]+/)) {
    const t = raw.trim();
    if (!t) continue;
    const m = /^([A-Za-z]*)(\d+)\s*[-~～]\s*([A-Za-z]*)(\d+)$/.exec(t);
    if (m && (!m[3] || m[3].toUpperCase() === m[1].toUpperCase())) {
      const a = Number(m[2]), b = Number(m[4]);
      const w = m[2].startsWith("0") ? m[2].length : 0;
      if (b >= a && b - a < 500) { for (let i = a; i <= b; i++) out.push(m[1] + String(i).padStart(w, "0")); continue; }
    }
    const c = /^([A-Za-z])\s*[-~～]\s*([A-Za-z])$/.exec(t);
    if (c) {
      const a = c[1].toUpperCase().charCodeAt(0), b = c[2].toUpperCase().charCodeAt(0);
      if (b >= a) { for (let i = a; i <= b; i++) out.push(String.fromCharCode(i)); continue; }
    }
    out.push(t);
  }
  return [...new Set(out.map((x) => x.toUpperCase()))];
}

/** 跟资料库 ops.wh_bin_code 一样：区-货架-层（空的不放） */
export function binCode(zone: string, shelf: string, level: string): string {
  return [zone, shelf, level].map((x) => x.trim().toUpperCase()).filter(Boolean).join("-");
}

export function BinListView({ company, data, locs, canEdit, canApprove, inactive, setInactive, onChanged }: {
  company: string; data: BinList; locs: string[]; canEdit: boolean; canApprove: boolean;
  inactive: boolean; setInactive: (v: boolean) => void; onChanged: () => void;
}) {
  const binLocs = data.summary.map((s) => s.location);
  const [locF, setLocF] = useState(() => { const l = rememberLoc(company); return binLocs.includes(l) ? l : ""; });
  const [q, setQ] = useState("");
  const [selecting, setSelecting] = useState(false);
  const [sel, setSel] = useState<number[]>([]);
  const [detail, setDetail] = useState<number | null>(null);
  const [creating, setCreating] = useState<"one" | "bulk" | null>(null);
  const [notice, setNotice] = useState("");

  const Q = q.trim().toUpperCase();
  const rows = data.bins.filter((b) => (!locF || b.location === locF) && (!Q || b.code.includes(Q) || b.note.toUpperCase().includes(Q)));
  // 仓位 → 区 → 货架 → 层
  const groups = new Map<string, Map<string, Map<string, BinRow[]>>>();
  {
    const m = groups;
    for (const b of rows) {
      if (!m.has(b.location)) m.set(b.location, new Map());
      const z = m.get(b.location)!;
      if (!z.has(b.zone)) z.set(b.zone, new Map());
      const s = z.get(b.zone)!;
      if (!s.has(b.shelf)) s.set(b.shelf, []);
      s.get(b.shelf)!.push(b);
    }
  }
  const toggle = (id: number) => setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const selBins = data.bins.filter((b) => sel.includes(b.id));

  return (
    <>
      <div className="filters bin-toolbar">
        <label className="inline">仓位
          <select value={locF} onChange={(e) => { setLocF(e.target.value); if (e.target.value) rememberLoc(company, e.target.value); }}>
            <option value="">全部仓位</option>
            {binLocs.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
        </label>
        <input className="bin-search" placeholder="找货架代号…" value={q} onChange={(e) => setQ(e.target.value)} />
        {canApprove && <label className="check"><input type="checkbox" checked={inactive} onChange={(e) => setInactive(e.target.checked)} /> 显示停用的</label>}
        <div className="bin-toolbar-btns">
          {canApprove && <button onClick={() => setCreating("one")}>建货架</button>}
          {canApprove && <button className="ghost" onClick={() => setCreating("bulk")}>一次建很多</button>}
          {data.bins.length > 0 && <button className="ghost" onClick={() => { setSelecting(!selecting); setSel([]); }}>{selecting ? "不印了" : "印货架标签"}</button>}
        </div>
      </div>
      {notice && <div className="ok">{notice}</div>}
      {selecting && (
        <div className="bulkbar bin-printbar">
          <span>{`已选 ${sel.length} 个货架`}</span>
          <button className="ghost small" onClick={() => setSel([...new Set([...sel, ...rows.filter((b) => b.active).map((b) => b.id)])])}>全选（看得到的）</button>
          {sel.length > 0 && <button className="ghost small" onClick={() => setSel([])}>清除</button>}
          <BinLabelBar bins={selBins} company={company} />
        </div>
      )}
      {data.bins.length === 0 ? (
        <Empty>{canApprove ? "还没有货架。按「建货架」或「一次建很多」开始；已经有员工 WMS 的资料可以用「Excel 带入」。" : "还没有货架。请主管先建货架。"}</Empty>
      ) : rows.length === 0 ? <Empty>没有符合的货架。</Empty> : (
        [...groups.entries()].map(([loc, zones]) => {
          const s = data.summary.find((x) => x.location === loc);
          const list = data.bins.filter((b) => b.location === loc && b.active);
          return (
            <section key={loc} className="card bin-group">
              <div className="bin-group-head">
                <h2>{loc}</h2>
                <span className="muted small">{`${list.length} 个货架 · ${list.filter((b) => Number(b.qty) > 0).length} 个有货 · ${qtyLabel(list.reduce((a, b) => a + Number(b.qty), 0))} 件`}</span>
                {s && s.items_over > 0 && <a className="bin-flag late" href={`#/warehouse/bins/recon?loc=${encodeURIComponent(loc)}&f=over`}>{`货架比系统多 ${s.items_over} 项`}</a>}
                {s && s.items_unshelved > 0 && <a className="bin-flag amber" href={`#/warehouse/bins/recon?loc=${encodeURIComponent(loc)}&f=unshelved`}>{`未上架 ${s.items_unshelved} 项`}</a>}
              </div>
              {[...zones.entries()].map(([zone, shelves]) => (
                <div key={zone} className="bin-zone">
                  <h3>{zone ? `${zone} 区` : "（没分区）"}</h3>
                  {[...shelves.entries()].map(([shelf, cells]) => (
                    <div key={shelf} className="bin-shelf">
                      <div className="bin-shelf-name">{shelf}</div>
                      <div className="bin-cells">
                        {cells.map((b) => (
                          <button key={b.id} type="button"
                                  className={"bin-cell" + (Number(b.qty) > 0 ? "" : " empty") + (b.active ? "" : " off") + (sel.includes(b.id) ? " on" : "")}
                                  onClick={() => (selecting ? b.active && toggle(b.id) : setDetail(b.id))}>
                            {selecting && <input type="checkbox" readOnly checked={sel.includes(b.id)} disabled={!b.active} tabIndex={-1} />}
                            <b>{b.code}</b>
                            <span>{Number(b.qty) > 0 ? `${b.items} 种 · ${qtyLabel(b.qty)} 件` : "空"}</span>
                            {!b.active ? <small>已停用</small> : b.updated_at ? <small>{whenLabel(b.updated_at)}</small> : null}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              ))}
            </section>
          );
        })
      )}
      {detail != null && (
        <BinDetailModal company={company} id={detail} canEdit={canEdit} canApprove={canApprove} onClose={() => setDetail(null)}
                        onPrint={(id) => { setDetail(null); setSelecting(true); setSel([id]); }}
                        onChanged={onChanged} />
      )}
      {creating && (
        <CreateModal company={company} locs={locs} bulk={creating === "bulk"} defLoc={locF || binLocs[0] || locs[0] || ""}
                     onClose={() => setCreating(null)}
                     onDone={(msg) => { setCreating(null); setNotice(msg); onChanged(); }} />
      )}
    </>
  );
}

function BinDetailModal({ company, id, canEdit, canApprove, onClose, onPrint, onChanged }: {
  company: string; id: number; canEdit: boolean; canApprove: boolean; onClose: () => void; onPrint: (id: number) => void; onChanged: () => void;
}) {
  const [d, setD] = useState<BinDetail | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState("");
  const load = () => bins.get(company, "BIN:" + id).then((x) => { setD(x); setNote(x.note); }).catch((e: Error) => setError(e.message));
  useEffect(() => { load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function save(active?: boolean) {
    if (!d) return;
    setBusy(true); setError(""); setSaved("");
    try {
      await bins.save({ id: d.id, company, location: d.location, zone: d.zone, shelf: d.shelf, level: d.level, note, active: active ?? d.active });
      setSaved(active === undefined ? "已储存。" : active ? "已重新启用。" : "已停用。");
      await load();
      onChanged();
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  }

  return (
    <Modal title={d ? `货架 ${d.code}` : "货架"} onClose={onClose} wide>
      <ErrorBox error={error} />
      {saved && <div className="ok">{saved}</div>}
      {!d ? (!error && <p className="muted">载入中…</p>) : (
        <>
          <p className="muted">{[d.location, d.zone && `${d.zone} 区`, d.shelf, d.level && `第 ${d.level} 层`, !d.active && "已停用"].filter(Boolean).join(" · ")}</p>
          {d.note && !canApprove && <p className="small">{d.note}</p>}
          <h3>上面的商品</h3>
          {d.items.length === 0 ? <p className="muted">这个货架是空的。</p> : (
            <div className="table-wrap flat">
              <table>
                <thead><tr><th>商品</th><th className="num">数量</th><th className="hide-sm">更新</th></tr></thead>
                <tbody>
                  {d.items.map((x) => (
                    <tr key={x.item_code}>
                      <td><b>{x.item_code}</b><div className="muted small">{x.description}</div></td>
                      <td className="num">{Number(x.qty) > 0 ? <>{qtyLabel(x.qty)}{x.uom ? ` ${x.uom}` : ""}</> : <span className="muted small">平常放这里</span>}</td>
                      <td className="hide-sm muted small">{`${whenLabel(x.updated_at)}${x.updated_by_name ? ` · ${x.updated_by_name}` : ""}`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <h3>最近变动</h3>
          {d.log.length === 0 ? <p className="muted">还没有纪录。</p> : (
            <ul className="list bin-log">
              {d.log.map((g) => (
                <li key={g.id} className={g.reversed ? "undone" : ""}>
                  <span>
                    <b>{g.item_code}</b>{" "}<span>{BIN_LOG_LABEL[g.kind] ?? g.kind}</span>{" "}
                    <span className={Number(g.delta) < 0 ? "late" : "bin-plus"}>{Number(g.delta) > 0 ? `+${qtyLabel(g.delta)}` : qtyLabel(g.delta)}</span>
                    <span className="muted small">{` → ${qtyLabel(g.qty_after)}`}</span>
                    {g.note && g.note !== BIN_LOG_LABEL[g.kind] && <span className="muted small">{" · "}<span>{g.note}</span></span>}
                    {g.reversed && <span className="muted small">{" · "}<span>已冲回</span></span>}
                  </span>
                  <span className="muted small nowrap">{`${whenLabel(g.created_at)}${g.by_name ? ` · ${g.by_name}` : ""}`}</span>
                </li>
              ))}
            </ul>
          )}
          {canApprove && (
            <div className="form bin-edit">
              <label>备注
                <input value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder="例：放大件、靠门口" />
              </label>
              <div className="actions">
                {d.active
                  ? <button className="ghost danger" disabled={busy} onClick={() => save(false)}>停用这个货架</button>
                  : <button className="ghost" disabled={busy} onClick={() => save(true)}>重新启用</button>}
                <button disabled={busy || note === d.note} onClick={() => save()}>储存备注</button>
              </div>
              {d.active && <p className="muted small">停用前货架要先清空（移走或盘点成 0）。停用的货架不会出现在上架、地图，资料保留。</p>}
            </div>
          )}
          <div className="actions">
            {canEdit && d.active && <button className="ghost" onClick={() => go(`/warehouse/bins/ops?loc=${encodeURIComponent(d.location)}`)}>去上架 / 拿下</button>}
            {d.active && <button className="ghost" onClick={() => onPrint(d.id)}>印这个货架的标签</button>}
            <button className="ghost" onClick={onClose}>关闭</button>
          </div>
        </>
      )}
    </Modal>
  );
}

function CreateModal({ company, locs, bulk, defLoc, onClose, onDone }: {
  company: string; locs: string[]; bulk: boolean; defLoc: string; onClose: () => void; onDone: (msg: string) => void;
}) {
  const [loc, setLoc] = useState(defLoc);
  const [zone, setZone] = useState("");
  const [shelf, setShelf] = useState("");
  const [level, setLevel] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const shelves = bulk ? expandList(shelf) : [];
  const levels = bulk ? expandList(level) : [];
  const n = shelves.length * Math.max(levels.length, 1);
  const sample = bulk
    ? shelves.slice(0, 3).flatMap((s) => (levels.length ? levels.slice(0, 2) : [""]).map((l) => binCode(zone, s, l)))
    : [binCode(zone, shelf, level)];

  async function save() {
    setBusy(true); setError("");
    try {
      if (bulk) {
        const r = await bins.bulk({ company, location: loc, zone, shelves, levels });
        onDone(`新建 ${r.created} 个货架，已经有的 ${r.existed} 个跳过。`);
      } else {
        const b = await bins.save({ company, location: loc, zone, shelf, level, note });
        onDone(`已建货架 ${b.code}。`);
      }
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  }

  return (
    <Modal title={bulk ? "一次建很多货架" : "建货架"} onClose={onClose}>
      <div className="form">
        <label>仓位（AutoCount）
          <select value={loc} onChange={(e) => setLoc(e.target.value)}>
            {locs.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
        </label>
        <div className="row">
          <label>区（可空）<input value={zone} onChange={(e) => setZone(e.target.value)} placeholder="例：A" maxLength={12} /></label>
          <label>{bulk ? "货架（范围或清单）" : "货架（必填）"}<input value={shelf} onChange={(e) => setShelf(e.target.value)} placeholder={bulk ? "例：R1-R10 或 R1, R2, R5" : "例：R1"} /></label>
          <label>{bulk ? "层（可空，范围或清单）" : "层（可空）"}<input value={level} onChange={(e) => setLevel(e.target.value)} placeholder={bulk ? "例：1-4" : "例：2"} /></label>
        </div>
        {!bulk && <label>备注<input value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder="例：放大件、靠门口" /></label>}
        <p className="muted small">区、货架、层用短的字，不要有空格或减号（例：A、R3、2）。货架代号 = 区-货架-层。</p>
        {(bulk ? n > 0 : shelf.trim() !== "") && (
          <p className="bin-preview">{bulk ? `会建 ${n} 个货架，例：${sample.join("、")}${n > sample.length ? "…" : ""}` : `代号：${sample[0]}`}</p>
        )}
        {bulk && n > 500 && <p className="late small">一次最多建 500 个货架。</p>}
        <ErrorBox error={error} />
        <div className="actions">
          <button className="ghost" onClick={onClose}>取消</button>
          <button disabled={busy || !loc || (bulk ? n === 0 || n > 500 : !shelf.trim())} onClick={save}>{busy ? "储存中…" : bulk ? `建 ${n} 个货架` : "建货架"}</button>
        </div>
      </div>
    </Modal>
  );
}
