// 读厂家 DO 的 Excel / CSV：自动找表头与栏位（采购可以改），预览对到哪个型号，按「套用」才写进这张 DO。
import { useMemo, useState } from "react";
import { fmtQty } from "../api";
import { Modal } from "../ui";
import { Candidate, joinList } from "../podo-api";
import {
  allLines, colLetter, detectPlans, headerLabels, Line, matchLines, MatchResult, Plan, planForHeader, Role, Sheet,
} from "./parse";

export interface OtherHit { item_code: string; po_nos: string[] }
export interface ImportResult {
  res: MatchResult;
  zeroMissing: boolean;
  other: Map<Line, OtherHit>;
}

const ROLE_LABEL: Record<Role, string> = { code: "货号", model: "型号", desc: "品名", qty: "数量" };
const HOW_LABEL: Record<string, string> = { code: "货号相同", normalized: "去掉横线 / 空白后相同", text: "品名里有型号", description: "我们的品名里有厂家型号" };

export function ImportPanel({ fileName, sheets, cands, others, onApply, onAddPos, onClose }: {
  fileName: string; sheets: Sheet[]; cands: Candidate[]; others: Candidate[] | null;
  onApply: (r: ImportResult) => void; onAddPos: (poNos: string[]) => void; onClose: () => void;
}) {
  const [init] = useState(() => detectPlans(sheets));
  const [plans, setPlans] = useState<Plan[]>(init.plans);
  const [zeroMissing, setZeroMissing] = useState(true);

  const lines = useMemo(() => allLines(sheets, plans), [sheets, plans]);
  const res = useMemo(() => matchLines(lines, cands), [lines, cands]);
  // 对不上的行：是不是这个厂家其他（没选的）PO 上的型号
  const other = useMemo(() => {
    const m = new Map<Line, OtherHit>();
    if (!others?.length || !res.unmatched.length) return m;
    const chosen = new Set(cands.map((c) => c.item_code));
    const pool = others.filter((c) => !chosen.has(c.item_code));
    const r2 = matchLines(res.unmatched, pool);
    for (const mm of r2.matched) {
      const c = pool.find((x) => x.item_code === mm.item_code)!;
      for (const ln of mm.lines) m.set(ln, { item_code: mm.item_code, po_nos: c.po_nos });
    }
    return m;
  }, [others, res, cands]);
  const otherPos = useMemo(() => [...new Set([...other.values()].flatMap((o) => o.po_nos))].sort(), [other]);
  const hit = new Set(res.matched.map((m) => m.item_code));
  const missing = cands.filter((c) => !hit.has(c.item_code) && c.remaining > 0);
  const total = res.matched.reduce((s, m) => s + m.qty, 0);
  const lineHit = useMemo(() => {
    const m = new Map<Line, string>();
    for (const x of res.matched) for (const ln of x.lines) m.set(ln, x.item_code);
    return m;
  }, [res]);
  const hows = useMemo(() => new Map(res.matched.map((m) => [m.item_code, m.how])), [res]);

  const setPlan = (i: number, p: Plan) => setPlans(plans.map((x, n) => (n === i ? p : x)));

  return (
    <Modal title={`读取 ${fileName}`} onClose={onClose} wide>
      <p className="muted small">自动找表头、货号 / 型号与数量栏；不对的话在下面改。只有按「套用」才会改这张 DO 的出货数量。</p>
      {init.dups.map(([a, b]) => (
        <div key={a + "|" + b} className="podo-sum warn">
          {`「${b}」和「${a}」的型号一样（可能是 Invoice + Packing List 列同一批货），先只用「${a}」；真的是两批货再勾「${b}」。`}
        </div>
      ))}
      {sheets.map((sh, i) => {
        const p = plans[i];
        const labels = p.header >= 0 ? headerLabels(sh, p.header, p.headerRows) : (sh.rows[0] ?? []).map(() => "");
        const n = readCount(lines, sh.name);
        return (
          <div key={sh.name + i} className={"podo-sheet" + (p.use ? "" : " off")}>
            <div className="row-inline">
              <label className="check">
                <input type="checkbox" checked={p.use} disabled={p.header < 0 || p.cols.qty == null}
                       onChange={(e) => setPlan(i, { ...p, use: e.target.checked })} />
                <b>{sh.name}</b>
              </label>
              <span className="muted small">{p.header < 0 ? "找不到表头（数量栏）" : `读到 ${n} 行`}</span>
            </div>
            <div className="row-inline">
              <label className="inline">表头行
                <input type="number" min={1} max={sh.rows.length || 1} className="podo-num" value={p.header >= 0 ? p.header + 1 : ""}
                       onChange={(e) => {
                         const r = Number(e.target.value) - 1;
                         if (r >= 0 && r < sh.rows.length) setPlan(i, planForHeader(sh, r, p.headerRows));
                       }} />
              </label>
              <label className="check small">
                <input type="checkbox" checked={p.headerRows === 2} disabled={p.header < 0}
                       onChange={(e) => setPlan(i, planForHeader(sh, p.header, e.target.checked ? 2 : 1))} /> 两行表头
              </label>
              {p.header >= 0 && (["code", "model", "desc", "qty"] as Role[]).map((role) => (
                <label key={role} className="inline">{ROLE_LABEL[role]}
                  <select value={p.cols[role] ?? ""} onChange={(e) => {
                    const cols = { ...p.cols };
                    if (e.target.value === "") delete cols[role]; else cols[role] = Number(e.target.value);
                    setPlan(i, { ...p, cols, use: cols.qty != null });
                  }}>
                    <option value="">—</option>
                    {labels.map((l, c) => <option key={c} value={c}>{`${colLetter(c)}${l ? " · " + l.slice(0, 24) : ""}`}</option>)}
                  </select>
                </label>
              ))}
            </div>
          </div>
        );
      })}

      <div className={"podo-sum" + (res.unmatched.length ? " warn" : "")}>
        {`对上 ${res.matched.length} 个型号，共 ${fmtQty(total)} 件`}
        {res.unmatched.length > 0 && <b>{` · 对不上 ${res.unmatched.length} 行`}</b>}
      </div>
      {otherPos.length > 0 && (
        <div className="podo-sum warn">
          {`有 ${other.size} 行的型号在这个厂家其他 PO：${joinList(otherPos)}`}{" "}
          <button type="button" className="small" onClick={() => onAddPos(otherPos)}>加选这些 PO</button>
        </div>
      )}
      {lines.length > 0 && (
        <div className="table-wrap flat podo-preview">
          <table>
            <thead><tr><th>行</th><th>货号 / 型号</th><th className="hide-sm">品名</th><th className="num">数量</th><th>对上</th></tr></thead>
            <tbody>
              {lines.slice(0, 300).map((ln, n) => {
                const code = lineHit.get(ln);
                const u = code ? null : res.unmatched.find((x) => x.sheet === ln.sheet && x.row === ln.row);
                const o = u ? other.get(u) : undefined;
                return (
                  <tr key={n} className={code ? "" : "podo-miss"}>
                    <td className="nowrap small">{sheets.length > 1 ? `${ln.sheet}!${ln.row}` : ln.row}</td>
                    <td>{[ln.code, ln.model].filter(Boolean).join(" / ") || <span className="muted">—</span>}</td>
                    <td className="hide-sm small">{ln.desc}</td>
                    <td className="num">{fmtQty(ln.qty)}</td>
                    <td>
                      {code ? <><b>{code}</b><br /><small className="muted">{HOW_LABEL[hows.get(code) ?? "code"]}</small></>
                        : o ? <span className="late">{`在 ${joinList(o.po_nos)}（${o.item_code}）`}</span>
                        : <span className="late">{u?.suggest.length ? `对不上（可能是 ${joinList(u.suggest)}）` : "对不上"}</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {missing.length > 0 && (
        <div className="podo-missing">
          <label className="check">
            <input type="checkbox" checked={zeroMissing} onChange={(e) => setZeroMissing(e.target.checked)} />
            {`所选 PO 里还有 ${missing.length} 个型号 Excel 没有：出货填 0（确认时记成少发）`}
          </label>
          <small className="muted">{joinList(missing.slice(0, 12).map((c) => c.item_code))}{missing.length > 12 ? " …" : ""}</small>
        </div>
      )}
      <div className="actions">
        <button type="button" className="ghost" onClick={onClose}>取消</button>
        <button type="button" disabled={!lines.length} onClick={() => onApply({ res, zeroMissing, other })}>套用到这张 DO</button>
      </div>
    </Modal>
  );
}

function readCount(lines: Line[], sheet: string): number {
  return lines.filter((l) => l.sheet === sheet).length;
}
