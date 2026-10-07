// 一键带入马来西亚（全国 + 柔佛）公共假日：先列出来让 HR 勾选、改日期，再一笔一笔存进去。
// 伊斯兰历 / 农历 / 印度历的节日是预计日期（政府每年公布），带「预计」的一定要对一次。
// 名单 2026-10-07 整理；柔佛自 2025 年起周末是星期六、日。
import { useState } from "react";
import { Modal } from "../ui";
import { att, weekday } from "../att-api";

interface H { date: string; name: string; est?: boolean; off?: boolean; note?: string }
const LIST: H[] = [
  { date: "2026-11-08", name: "屠妖节 Deepavali", est: true },
  { date: "2026-11-09", name: "屠妖节补假（星期日）", est: true },
  { date: "2026-12-25", name: "圣诞节 Christmas" },
  { date: "2027-01-01", name: "元旦 New Year", off: true, note: "柔佛一般不放，确认后再勾" },
  { date: "2027-01-05", name: "登霄节 Israk & Mikraj", est: true, off: true, note: "只有部分州放，确认后再勾" },
  { date: "2027-01-22", name: "大宝森节 Thaipusam", est: true },
  { date: "2027-02-06", name: "农历新年第一天", est: true },
  { date: "2027-02-07", name: "农历新年第二天", est: true },
  { date: "2027-02-08", name: "农历新年补假 / 柔佛斋戒月首日 Awal Ramadan", est: true },
  { date: "2027-03-10", name: "开斋节 Hari Raya Aidilfitri", est: true },
  { date: "2027-03-11", name: "开斋节第二天", est: true },
  { date: "2027-03-23", name: "柔佛苏丹华诞 Hari Keputeraan Sultan Johor" },
  { date: "2027-05-01", name: "劳动节 Labour Day" },
  { date: "2027-05-17", name: "哈芝节 Hari Raya Haji", est: true },
  { date: "2027-05-20", name: "卫塞节 Wesak", est: true },
  { date: "2027-06-06", name: "回历新年 Awal Muharram", est: true },
  { date: "2027-06-07", name: "最高元首华诞 Agong's Birthday" },
  { date: "2027-08-15", name: "先知诞辰 Maulidur Rasul", est: true },
  { date: "2027-08-31", name: "国庆日 Hari Merdeka" },
  { date: "2027-09-16", name: "马来西亚日 Hari Malaysia" },
  { date: "2027-10-28", name: "屠妖节 Deepavali", est: true },
  { date: "2027-12-25", name: "圣诞节 Christmas" },
];

export function HolidayImport({ existing, onClose, onDone }: {
  existing: { date: string; branch: string }[]; onClose: () => void; onDone: () => void;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const has = (d: string) => existing.some((e) => e.date === d && e.branch === "ALL");
  const [rows, setRows] = useState(() => LIST.filter((h) => h.date >= today)
    .map((h) => ({ ...h, on: !h.off && !has(h.date) })));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (i: number, k: "date" | "name" | "on", v: string | boolean) =>
    setRows((r) => r.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
  const picked = rows.filter((r) => r.on && r.date && r.name.trim());

  async function run() {
    setBusy(true); setError("");
    try {
      for (const r of picked) await att.saveHoliday({ date: r.date, name: r.name.trim(), branch: "ALL" });
      onDone();
    } catch (e) { setError((e as Error).message); setBusy(false); }
  }
  return (
    <Modal title="带入公共假日（全国 + 柔佛）" onClose={onClose} wide>
      <p className="small late">标「预计」的是按伊斯兰历 / 农历推算的日期，政府公布后请对一次再存；补假也以公布为准。柔佛苏丹的「Hari Hol」等州属假日每年公布后再自己加。</p>
      <div className="table-wrap">
        <table>
          <thead><tr><th /><th>日期</th><th>名称</th><th /></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className={r.on ? "" : "off"}>
                <td><input type="checkbox" checked={r.on} onChange={(e) => set(i, "on", e.target.checked)} /></td>
                <td className="nowrap"><input type="date" value={r.date} onChange={(e) => set(i, "date", e.target.value)} />
                  <div className="muted small">{r.date && weekday(r.date)}</div></td>
                <td><input value={r.name} onChange={(e) => set(i, "name", e.target.value)} /></td>
                <td className="small nowrap">
                  {r.est && <span className="ap pending">预计</span>}
                  {has(r.date) && <span className="muted">{" 已经有"}</span>}
                  {r.note && <div className="muted">{r.note}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {error && <div className="error">{error}</div>}
      <div className="actions">
        <button className="ghost" onClick={onClose}>取消</button>
        <button disabled={busy || !picked.length} onClick={run}>{busy ? "存进去中…" : `存进去（${picked.length} 天，全部分店）`}</button>
      </div>
    </Modal>
  );
}
