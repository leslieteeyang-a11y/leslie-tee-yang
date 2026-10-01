// 打卡主画面：今天的班表、上班 / 下班按钮、没打下班卡的补登、外勤签到。
import { FormEvent, useCallback, useEffect, useState } from "react";
import { Me } from "../api";
import { ErrorBox } from "../ui";
import Camera from "./Camera";
import { att, AttToday, distanceM, Fix, getFix, hhmm, mapLink, minsLabel, uploadPhoto, weekday } from "../att-api";

type Action = "in" | "out" | "checkin";

export default function Today({ me }: { me: Me }) {
  const [t, setT] = useState<AttToday | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [action, setAction] = useState<Action | null>(null);
  const [fix, setFix] = useState<Fix | null>(null);
  const [gpsMsg, setGpsMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [camError, setCamError] = useState("");
  const [purpose, setPurpose] = useState("");
  const [now, setNow] = useState(new Date());

  const load = useCallback(() => {
    att.today().then(setT).catch((e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 15000);
    return () => clearInterval(id);
  }, []);

  if (!t) return error ? <ErrorBox error={error} /> : <p className="muted">载入中…</p>;

  const r = t.record;
  const canIn = !t.open_shift && (!r?.clock_in || !!r.clock_out);
  const canOut = !!r?.clock_in && !r.clock_out;
  const s = t.schedule;
  const nearest = fix && t.fences.length
    ? t.fences.map((f) => ({ f, d: distanceM(fix, f) })).sort((a, b) => (a.d - a.f.radius) - (b.d - b.f.radius))[0]
    : null;

  // 按下按钮：先抓 GPS（上班、外勤一定要），再开相机
  async function begin(a: Action) {
    setError(""); setNotice(""); setCamError(""); setGpsMsg("");
    setAction(a);
    if (a === "out" && !t!.fences.length) return;
    setGpsMsg("正在读取你的位置…");
    try {
      const f = await getFix();
      setFix(f);
      setGpsMsg("");
    } catch (e) {
      setFix(null);
      setGpsMsg((e as Error).message);
    }
  }

  async function confirm(photo: Blob) {
    if (!action) return;
    if (action !== "out" && !fix && (action === "checkin" || (!t!.geofence_exempt && t!.fences.length))) {
      setCamError(gpsMsg || "还没有位置，请稍等或检查定位。");
      return;
    }
    setBusy(true);
    setCamError("");
    try {
      const path = await uploadPhoto(me.staff.id, t!.today, action === "checkin" ? "checkin" : action, photo);
      const p = { selfie: path, lat: fix?.lat ?? null, lng: fix?.lng ?? null };
      const next = action === "checkin"
        ? await att.fieldCheckin({ ...p, purpose })
        : await att.punch({ ...p, action });
      setT(next);
      const nr = next.record;
      setNotice(action === "checkin" ? "已签到。"
        : action === "out" ? `已打下班卡 ${hhmm(nr?.clock_out)}。`
        : nr?.lunch_in && !r?.lunch_in ? `欢迎回来，午休 ${hhmm(nr.lunch_out)}–${hhmm(nr.lunch_in)} 已记录。`
        : `已打上班卡 ${hhmm(nr?.clock_in)}。`);
      setAction(null);
      setPurpose("");
    } catch (e) {
      setCamError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <section className="card att-today">
        <div className="att-clock">
          <b>{hhmm(now.toISOString())}</b>
          <span>{t.today} {weekday(t.today)}</span>
        </div>
        <div className="att-sched">
          {s.workday ? (
            <span>{t.shift?.name}{` · ${s.start} – ${s.end}`}{s.lunch_in_due ? ` · 午休回来 ${s.lunch_in_due}` : ""}</span>
          ) : <span className="badge">{s.holiday || "今天休息"}</span>}
          {t.geofence_exempt ? <span className="muted small">免打卡范围（外勤）</span>
            : t.fences.length ? <span className="muted small">{"打卡点："}{t.fences.map((f, i) => <span key={i}>{i ? "、" : ""}{f.name}{`（${f.radius} 公尺内）`}</span>)}</span>
            : <span className="muted small">分店还没设打卡点，任何地方都能打卡。</span>}
        </div>
        <div className="att-punches">
          <Slot label="上班" ts={r?.clock_in} extra={r?.late_min ? `迟到 ${minsLabel(r.late_min)}` : r?.in_place || ""} warn={!!r?.late_min} />
          <Slot label="午休" ts={r?.lunch_out} to={r?.lunch_in}
                extra={r?.lunch_late_min ? `迟回 ${minsLabel(r.lunch_late_min)}` : ""} warn={!!r?.lunch_late_min} />
          <Slot label="下班" ts={r?.clock_out} extra={r?.early_min ? `早退 ${minsLabel(r.early_min)}` : r?.worked_min != null ? `工时 ${minsLabel(r.worked_min)}` : ""}
                warn={!!r?.early_min} />
        </div>
        <ErrorBox error={error} />
        {notice && <div className="ok">{notice}</div>}
        {t.open_shift ? null : (
          <div className="att-buttons">
            <button className="big" disabled={!canIn} onClick={() => begin("in")}>
              {r?.clock_out ? "上班（回来）" : "上班"}
            </button>
            <button className="big out" disabled={!canOut} onClick={() => begin("out")}>下班</button>
          </div>
        )}
        {canOut && !r?.lunch_out && s.lunch_in_due && (
          <p className="muted small">去吃午饭时按「下班」，回来按「上班」，系统会自动记成午休。</p>
        )}
        {t.pending_corrections > 0 && (
          <p className="small"><a href="#/attendance/corrections">{`你有 ${t.pending_corrections} 张补卡在审核中 →`}</a></p>
        )}
      </section>

      {t.open_shift && <SelfClose date={t.open_shift} onDone={(n) => { setT(n); setNotice("已补下班卡，已送主管审核。现在可以打今天的卡了。"); }} />}

      <section className="card">
        <div className="page-head">
          <h2>外勤签到</h2>
          <button className="ghost" onClick={() => begin("checkin")}>📍 签到</button>
        </div>
        <p className="muted small">在客户那里、工地、送货点时用：拍照 + 记录位置，不检查打卡范围。</p>
        {t.checkins.length > 0 && (
          <ul className="list">
            {t.checkins.map((c) => (
              <li key={c.id}>
                <span>{hhmm(c.at)} {c.purpose}</span>
                <a href={mapLink(c.lat, c.lng)!} target="_blank" rel="noreferrer">地图</a>
              </li>
            ))}
          </ul>
        )}
      </section>

      {action && (
        <Camera title={action === "in" ? "上班打卡" : action === "out" ? "下班打卡" : "外勤签到"}
                confirmLabel={action === "checkin" ? "确认签到" : action === "in" ? "确认上班" : "确认下班"}
                busy={busy} error={camError} onConfirm={confirm} onClose={() => setAction(null)}>
          <p className={"small " + (gpsMsg && !fix ? (gpsMsg.startsWith("正在") ? "muted" : "late") : "muted")}>
            {gpsMsg || (fix ? (nearest && !t.geofence_exempt && action === "in"
              ? (nearest.d <= nearest.f.radius
                ? `✓ 你在「${nearest.f.name}」范围内（约 ${Math.round(nearest.d)} 公尺）`
                : `✗ 你离「${nearest.f.name}」约 ${Math.round(nearest.d)} 公尺，超出 ${nearest.f.radius} 公尺范围`)
              : `已取得位置（精确度约 ${Math.round(fix.accuracy)} 公尺）`) : "")}
          </p>
          {action === "checkin" && (
            <label>事由（选填）<input value={purpose} maxLength={280} onChange={(e) => setPurpose(e.target.value)}
                                     placeholder="例：去客户家丈量浴室" /></label>
          )}
          {gpsMsg && !fix && !gpsMsg.startsWith("正在") && (
            <button className="ghost small-btn" onClick={() => begin(action)}>重新读取位置</button>
          )}
        </Camera>
      )}
    </>
  );
}

function Slot({ label, ts, to, extra, warn }: { label: string; ts?: string | null; to?: string | null; extra?: string; warn?: boolean }) {
  return (
    <div className="att-slot">
      <span>{label}</span>
      <b>{ts ? hhmm(ts) + (to !== undefined ? ` – ${to ? hhmm(to) : "…"}` : "") : "—"}</b>
      {extra && <small className={warn ? "late" : "muted"}>{extra}</small>}
    </div>
  );
}

// 之前某天没打下班卡：填下班时间 + 原因，立刻写入并送主管审核
function SelfClose({ date, onDone }: { date: string; onDone: (t: AttToday) => void }) {
  const [time, setTime] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      onDone(await att.selfClose({ date, time, reason }));
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }
  return (
    <section className="card warn-card">
      <h2>补下班卡</h2>
      <p><b>{`${date}（${weekday(date)}）`}</b></p>
      <p>{"那天有打上班卡、没打下班卡。先补上当天的下班时间，才能打今天的卡。补上后会送主管审核，被驳回就会还原。"}</p>
      <form className="form" onSubmit={submit}>
        <div className="row">
          <label>下班时间<input type="time" value={time} onChange={(e) => setTime(e.target.value)} required /></label>
          <label>原因<input value={reason} onChange={(e) => setReason(e.target.value)} required minLength={5}
                           placeholder="例：忘了打卡，当天 18:00 下班" /></label>
        </div>
        <ErrorBox error={error} />
        <div className="actions"><button disabled={busy}>{busy ? "送出中…" : "补下班卡"}</button></div>
      </form>
    </section>
  );
}
