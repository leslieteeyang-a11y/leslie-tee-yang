// 仓库 · 搬动纪录的筛选（日期区间、种类、登记人、商品 / 品名 / 单号）与下载 Excel（2026-10-15）。
// 没有日期区间 = 最近 300 笔；有日期区间最多 2,000 笔（资料库 ops_wh_moves）。Excel 就是画面上这份清单（含进货）。
import { useEffect, useState } from "react";
import { todayKL } from "../api";
import { getLang, tr } from "../i18n";
import { Move, MOVE_KIND_SHORT, MOVE_STATUS_LABEL } from "../wh-api";
import { EMPTY_FILTER, MOVE_LIMIT, MOVE_LIMIT_RANGE, MoveFilter, whx } from "../wh-extra-api";
import "../wh-extra.css";

export function MoveFilterBar({ company, value, onChange, onExport, exporting, canExport }: {
  company: string; value: MoveFilter; onChange: (f: MoveFilter) => void; onExport: () => void; exporting: boolean; canExport: boolean;
}) {
  const [people, setPeople] = useState<{ id: number; name: string; n: number }[]>([]);
  const [q, setQ] = useState(value.q);
  useEffect(() => { whx.movePeople(company).then(setPeople).catch(() => setPeople([])); }, [company]);
  useEffect(() => { setQ(value.q); }, [value.q]);
  useEffect(() => {
    if (q.trim() === value.q.trim()) return;
    const t = setTimeout(() => onChange({ ...value, q }), 450);
    return () => clearTimeout(t);
  }, [q]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k: keyof MoveFilter) => (e: { target: { value: string } }) => onChange({ ...value, [k]: e.target.value });
  const active = Object.values(value).some((v) => v.trim() !== "");
  return (
    <div className="mf-bar">
      <label className="mf-date">从<input type="date" value={value.from} max={value.to || undefined} onChange={set("from")} /></label>
      <label className="mf-date">到<input type="date" value={value.to} min={value.from || undefined} onChange={set("to")} /></label>
      <select value={value.move_kind} onChange={set("move_kind")} aria-label="种类">
        <option value="">全部种类</option>
        {Object.entries(MOVE_KIND_SHORT).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
      </select>
      <select value={value.created_by} onChange={set("created_by")} aria-label="登记人">
        <option value="">全部登记人</option>
        {people.map((p) => <option key={p.id} value={String(p.id)}>{`${p.name} (${p.n})`}</option>)}
      </select>
      <input type="search" className="mf-q" placeholder="商品代号 / 品名 / 单号" value={q} onChange={(e) => setQ(e.target.value)}
             onKeyDown={(e) => { if (e.key === "Enter") onChange({ ...value, q }); }} />
      {active && <button type="button" className="ghost small" onClick={() => { setQ(""); onChange(EMPTY_FILTER); }}>清除筛选</button>}
      <button type="button" className="ghost small" onClick={onExport} disabled={exporting || !canExport}>{exporting ? "准备中…" : "下载 Excel"}</button>
    </div>
  );
}

/** 清单到上限时的提示（没有就空字串） */
export function limitNote(f: MoveFilter, n: number): string {
  const range = !!(f.from || f.to);
  if (!range && n >= MOVE_LIMIT) return "只列出最近 300 笔；要看更早的，请选日期区间（最多 2,000 笔）。";
  if (range && n >= MOVE_LIMIT_RANGE) return "超过 2,000 笔，只列出最近 2,000 笔；请把日期区间缩小。";
  return "";
}

const kl = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kuala_Lumpur", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
function klTime(ts: string | null | undefined): string {
  if (!ts) return "";
  const p = Object.fromEntries(kl.formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

const HEAD = ["登记时间", "种类", "商品代号", "品名", "数量", "单位", "从仓位", "到仓位", "状态", "AutoCount 单号", "登记人", "处理人",
  "处理时间", "备注", "厂家 DO", "PO", "分店"];
const HEAD_EN = ["Recorded", "Type", "Item code", "Description", "Qty", "UOM", "From location", "To location", "Status", "AutoCount doc no.",
  "Recorded by", "Handled by", "Handled at", "Note", "Supplier DO", "PO", "Branch"];

/** 下载 Excel：搬动 + 进货（新的在前） */
export async function exportMovesXlsx(rows: Move[], company: string, f: MoveFilter): Promise<void> {
  const XLSX = await import("@e965/xlsx");
  const en = getLang() === "en";
  const L = (s: string) => (en ? tr(s) : s);
  const aoa: (string | number)[][] = [en ? HEAD_EN : HEAD];
  const sorted = [...rows].sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : b.id - a.id));
  for (const m of sorted) {
    aoa.push([
      klTime(m.created_at), L(MOVE_KIND_SHORT[m.kind] || m.kind), m.item_code, m.description || "", Number(m.qty), m.uom || "",
      m.from_loc || "", m.to_loc || "", L(m.kind === "receive" && m.status === "pending" ? "待开 GRN" : MOVE_STATUS_LABEL[m.status]),
      m.ac_doc || "", m.created_by_name || "", m.done_by_name || "", klTime(m.done_at), m.note || "",
      m.do_no || "", m.po_no || "", m.outlet || "",
    ]);
  }
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = [17, 8, 16, 36, 8, 7, 12, 12, 16, 18, 14, 14, 17, 30, 14, 12, 8].map((wch) => ({ wch }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, L("搬动纪录").slice(0, 31));
  const range = f.from || f.to ? `_${f.from || ""}~${f.to || todayKL()}` : `_${todayKL()}`;
  const out = XLSX.write(wb, { bookType: "xlsx", type: "array", compression: true }) as ArrayBuffer;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([out], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
  a.download = `${L("搬动纪录")}_${company}${range}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
