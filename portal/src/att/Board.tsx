// 团队看板：某一天每个人的打卡状态（主管 / HR 用）。
import { useEffect, useState } from "react";
import { Empty, ErrorBox } from "../ui";
import { att, BoardRow, hhmm, mapLink } from "../att-api";
import { DayDetail, DayTags, Photo } from "./Records";

function status(r: BoardRow, today: string): [string, string] {
  if (r.clock_out) return ["已下班", "done"];
  if (r.lunch_out && !r.lunch_in) return ["午休中", "doing"];
  if (r.clock_in) return ["上班中", "on"];
  if (!r.workday) return ["休息", "muted"];
  return r.date < today ? ["缺勤", "late"] : ["还没打卡", "late"];
}

export default function Board() {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kuala_Lumpur" }).format(new Date());
  const [date, setDate] = useState(today);
  const [rows, setRows] = useState<BoardRow[] | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<BoardRow | null>(null);

  useEffect(() => {
    setRows(null);
    setError("");
    att.board(date).then((b) => setRows(b.rows)).catch((e: Error) => setError(e.message));
  }, [date]);

  const counts = (rows || []).reduce((a, r) => {
    const [s] = status(r, today);
    a[s] = (a[s] || 0) + 1;
    if (r.late_min) a.late = (a.late || 0) + 1;
    return a;
  }, {} as Record<string, number>);

  return (
    <>
      <div className="filters">
        <input type="date" value={date} max={today} onChange={(e) => e.target.value && setDate(e.target.value)} style={{ width: "auto" }} />
        {rows && (
          <span className="muted small">
            {`上班中 ${(counts["上班中"] || 0) + (counts["午休中"] || 0)} · 已下班 ${counts["已下班"] || 0} · `}
            <span className={counts["还没打卡"] || counts["缺勤"] ? "late" : ""}>{`没打卡 ${(counts["还没打卡"] || 0) + (counts["缺勤"] || 0)}`}</span>
            {` · 迟到 ${counts.late || 0}`}
          </span>
        )}
      </div>
      <ErrorBox error={error} />
      {!rows ? (!error && <p className="muted">载入中…</p>) : rows.length === 0 ? <Empty>没有可以看的员工。</Empty> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>员工</th><th>状态</th><th>上班</th><th className="hide-sm">午休</th><th>下班</th><th className="hide-sm">外勤</th></tr></thead>
            <tbody>
              {rows.map((r) => {
                const [s, c] = status(r, today);
                return (
                  <tr key={r.staff_id} className="click" onClick={() => setOpen(r)}>
                    <td><b>{r.name}</b><div className="muted small">{r.department_name}</div></td>
                    <td><span className={"dtag " + c}>{s}</span></td>
                    <td className="nowrap">
                      {r.selfie_in && <span className="thumb"><Photo path={r.selfie_in} /></span>}
                      {hhmm(r.clock_in)} <DayTags d={{ ...r, checkins: 0, missing_out: false, source: undefined, workday: true }} />
                    </td>
                    <td className="hide-sm nowrap">{r.lunch_out ? `${hhmm(r.lunch_out)}–${hhmm(r.lunch_in)}` : ""}</td>
                    <td>{hhmm(r.clock_out)}</td>
                    <td className="hide-sm">
                      {r.checkins.map((k, i) => (
                        <div key={i} className="small">
                          <a href={mapLink(k.lat, k.lng)!} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
                            {hhmm(k.at)}</a> {k.purpose}
                        </div>
                      ))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {open && <DayDetail d={{ ...open, checkins: open.checkins.length }} name={open.name} onClose={() => setOpen(null)} />}
    </>
  );
}
