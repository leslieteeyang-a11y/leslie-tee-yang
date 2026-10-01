// 出勤纪录：某人某月逐日（含照片、地图）、团队月统计（可下载 CSV）。
import { useEffect, useState } from "react";
import { Empty, ErrorBox, Modal } from "../ui";
import { getLang, tr } from "../i18n";
import { att, AttRecord, hhmm, mapLink, minsLabel, MonthRow, photoUrl, shiftMonth, thisMonth, weekday } from "../att-api";

export function MonthPicker({ ym, onChange }: { ym: string; onChange: (ym: string) => void }) {
  return (
    <div className="month-pick">
      <button className="ghost" onClick={() => onChange(shiftMonth(ym, -1))} aria-label="上个月">‹</button>
      <b>{ym}</b>
      <button className="ghost" disabled={ym >= thisMonth()} onClick={() => onChange(shiftMonth(ym, 1))} aria-label="下个月">›</button>
    </div>
  );
}

/** 当天的标记：迟到、早退、漏打…（没有纪录的工作日 = 缺勤） */
export function DayTags({ d, today }: { d: AttRecord; today?: string }) {
  const tags: [string, string][] = [];
  if (!d.workday) tags.push([d.holiday || "休息日", "muted"]);
  if (d.workday && !d.clock_in && today && d.date < today) tags.push(["缺勤", "late"]);
  if (d.late_min) tags.push([`迟到 ${minsLabel(d.late_min)}`, "late"]);
  if (d.lunch_late_min) tags.push([`午休迟回 ${minsLabel(d.lunch_late_min)}`, "late"]);
  if (d.early_min) tags.push([`早退 ${minsLabel(d.early_min)}`, "late"]);
  if (d.missing_out) tags.push(["漏打下班卡", "late"]);
  if (d.source === "correction") tags.push(["补卡", "tag"]);
  if (typeof d.checkins === "number" && d.checkins) tags.push([`外勤 ${d.checkins}`, "tag"]);
  return <>{tags.map(([t, c]) => <span key={t} className={"dtag " + c}>{t}</span>)}</>;
}

export function DaysTable({ staffId, initialYm, onCorrect }: {
  staffId?: number; initialYm?: string; onCorrect?: (date: string) => void;
}) {
  const [ym, setYm] = useState(initialYm || thisMonth());
  const [data, setData] = useState<{ staff: { name: string; shift: string }; days: AttRecord[] } | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<AttRecord | null>(null);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kuala_Lumpur" }).format(new Date());

  useEffect(() => {
    setData(null);
    setError("");
    att.days(ym, staffId).then(setData).catch((e: Error) => setError(e.message));
  }, [ym, staffId]);

  const sum = (data?.days || []).reduce((a, d) => ({
    late: a.late + (d.late_min ? 1 : 0), worked: a.worked + (d.worked_min || 0),
    absent: a.absent + (d.workday && !d.clock_in && d.date < today ? 1 : 0),
  }), { late: 0, worked: 0, absent: 0 });

  return (
    <>
      <div className="filters">
        <MonthPicker ym={ym} onChange={setYm} />
        {data && <span className="muted small">{data.staff.shift}{` · 迟到 ${sum.late} 天 · 缺勤 ${sum.absent} 天 · 工时 ${minsLabel(sum.worked)}`}</span>}
      </div>
      <ErrorBox error={error} />
      {!data ? (!error && <p className="muted">载入中…</p>) : data.days.length === 0 ? <Empty>这个月没有纪录。</Empty> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>日期</th><th>上班</th><th className="hide-sm">午休</th><th>下班</th><th className="hide-sm">工时</th><th></th></tr></thead>
            <tbody>
              {data.days.map((d) => (
                <tr key={d.date} className={"click" + (d.workday ? "" : " off")} onClick={() => setOpen(d)}>
                  <td className="nowrap">{d.date.slice(5)} <span className="muted">{weekday(d.date)}</span></td>
                  <td>{hhmm(d.clock_in)}</td>
                  <td className="hide-sm nowrap">{d.lunch_out ? `${hhmm(d.lunch_out)}–${hhmm(d.lunch_in)}` : ""}</td>
                  <td>{hhmm(d.clock_out)}</td>
                  <td className="hide-sm">{minsLabel(d.worked_min)}</td>
                  <td><DayTags d={d} today={today} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open && <DayDetail d={open} name={data?.staff.name || ""} onClose={() => setOpen(null)}
                          onCorrect={onCorrect && open.date <= today ? () => { onCorrect(open.date); setOpen(null); } : undefined} />}
    </>
  );
}

export function DayDetail({ d, name, onClose, onCorrect }: { d: AttRecord; name: string; onClose: () => void; onCorrect?: () => void }) {
  const shots: [string, string | null | undefined, string | null][] = [
    ["上班", d.selfie_in, d.clock_in], ["午休开始", d.selfie_lunch_out, d.lunch_out],
    ["午休回来", d.selfie_lunch_in, d.lunch_in], ["下班", d.selfie_out, d.clock_out],
  ];
  return (
    <Modal title={`${name} · ${d.date} ${weekday(d.date)}`} onClose={onClose} wide>
      <p className="muted small">
        {d.workday ? `班表 ${d.start} – ${d.end}` : d.holiday || "休息日"}
        {d.in_place ? ` · 打卡地点：${d.in_place}` : ""}
        {d.worked_min != null ? ` · 工时 ${minsLabel(d.worked_min)}` : ""}
      </p>
      <p><DayTags d={d} /></p>
      <div className="shots">
        {shots.map(([label, path, ts]) => ts ? (
          <figure key={label}>
            <Photo path={path} />
            <figcaption>{label} {hhmm(ts)}</figcaption>
          </figure>
        ) : null)}
      </div>
      <p className="small">
        {mapLink(d.in_lat, d.in_lng) && <a href={mapLink(d.in_lat, d.in_lng)!} target="_blank" rel="noreferrer">上班位置地图</a>}
        {mapLink(d.out_lat, d.out_lng) && <> · <a href={mapLink(d.out_lat, d.out_lng)!} target="_blank" rel="noreferrer">下班位置地图</a></>}
      </p>
      {onCorrect && <div className="actions"><button className="ghost" onClick={onCorrect}>这天要补卡</button></div>}
    </Modal>
  );
}

export function Photo({ path }: { path: string | null | undefined }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let on = true;
    photoUrl(path).then((u) => on && setUrl(u));
    return () => { on = false; };
  }, [path]);
  if (!path) return <div className="photo none">没有照片</div>;
  return url ? <a href={url} target="_blank" rel="noreferrer"><img className="photo" src={url} alt="" loading="lazy" /></a>
    : <div className="photo none">…</div>;
}

// ------------------------------------------------------------ 团队月统计
export function MonthReport() {
  const [ym, setYm] = useState(thisMonth());
  const [rows, setRows] = useState<MonthRow[] | null>(null);
  const [error, setError] = useState("");
  const [person, setPerson] = useState<MonthRow | null>(null);

  useEffect(() => {
    setRows(null);
    att.month(ym).then(setRows).catch((e: Error) => setError(e.message));
  }, [ym]);

  function csv() {
    if (!rows) return;
    const head = ["员工", "部门", "工作日", "出勤", "缺勤", "迟到天数", "迟到分钟", "午休迟回天数", "午休迟回分钟", "早退天数", "漏打下班卡", "工时(小时)"];
    const lines = rows.map((r) => [r.name, r.department_name, r.workdays, r.present, r.absent, r.late_days, r.late_min,
      r.lunch_late_days, r.lunch_late_min, r.early_days, r.missing_out, (r.worked_min / 60).toFixed(2)]);
    const T = (s: string) => (getLang() === "en" ? tr(s) : s);
    const text = [head.map(T), ...lines].map((l) => l.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\r\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(["﻿" + text], { type: "text/csv;charset=utf-8" }));
    a.download = `${T("出勤月报")}_${ym}.csv`;
    a.click();
  }

  return (
    <>
      <div className="filters">
        <MonthPicker ym={ym} onChange={setYm} />
        <button className="ghost" disabled={!rows?.length} onClick={csv}>下载 CSV（Excel）</button>
      </div>
      <ErrorBox error={error} />
      {!rows ? (!error && <p className="muted">载入中…</p>) : rows.length === 0 ? <Empty>没有资料。</Empty> : (
        <div className="table-wrap">
          <table>
            <thead><tr>
              <th>员工</th><th className="num">工作日</th><th className="num">出勤</th><th className="num">缺勤</th>
              <th className="num">迟到</th><th className="num hide-sm">午休迟回</th><th className="num hide-sm">早退</th>
              <th className="num hide-sm">漏打</th><th className="num hide-sm">工时</th>
            </tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.staff_id} className="click" onClick={() => setPerson(r)}>
                  <td><b>{r.name}</b><span className="muted"> · {r.department_name}</span></td>
                  <td className="num">{r.workdays}</td>
                  <td className="num">{r.present}</td>
                  <td className={"num" + (r.absent ? " late" : "")}>{r.absent}</td>
                  <td className={"num" + (r.late_days ? " late" : "")}>{r.late_days ? `${r.late_days} 天 / ${minsLabel(r.late_min)}` : 0}</td>
                  <td className="num hide-sm">{r.lunch_late_days ? `${r.lunch_late_days} 天 / ${minsLabel(r.lunch_late_min)}` : 0}</td>
                  <td className="num hide-sm">{r.early_days}</td>
                  <td className={"num hide-sm" + (r.missing_out ? " late" : "")}>{r.missing_out}</td>
                  <td className="num hide-sm">{minsLabel(r.worked_min)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted small">缺勤 = 工作日没有上班卡（之后请假模块上线后会扣掉请假日）。点员工看逐日纪录与照片。</p>
      {person && (
        <Modal title={person.name} onClose={() => setPerson(null)} wide>
          <DaysTable staffId={person.staff_id} initialYm={ym} />
        </Modal>
      )}
    </>
  );
}
