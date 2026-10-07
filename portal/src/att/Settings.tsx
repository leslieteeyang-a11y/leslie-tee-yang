// 打卡设定（HR）：班别、打卡点、员工设定、每月上班星期六、假日。
import { FormEvent, useCallback, useEffect, useState } from "react";
import { BRANCH_LABEL, Me } from "../api";
import { Empty, ErrorBox, Modal } from "../ui";
import { HolidayImport } from "./HolidayImport";
import { att, AttSettings, AttStaff, Fence, getFix, mapLink, minsLabel, SAT_RULE_LABEL, Shift, weekday } from "../att-api";

export default function Settings({ me }: { me: Me }) {
  const [s, setS] = useState<AttSettings | null>(null);
  const [error, setError] = useState("");
  const [shift, setShift] = useState<Partial<Shift> | null>(null);
  const [fence, setFence] = useState<Partial<Fence> | null>(null);
  const [staff, setStaff] = useState<AttStaff | null>(null);

  const load = useCallback(() => {
    att.settings().then(setS).catch((e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);
  if (!s) return error ? <ErrorBox error={error} /> : <p className="muted">载入中…</p>;

  const shiftName = (code: string) => s.shifts.find((x) => x.code === code)?.name || code;
  const nameOf = (id: number | null) => s.staff.find((x) => x.id === id)?.name || "";
  const branches = me.staff.branch === "ALL" ? ["HOMEWORKSSB", "HOMEWORKSSOUTHERN"] : [me.staff.branch];

  return (
    <>
      <ErrorBox error={error} />
      <section className="card">
        <div className="page-head"><h2>打卡点（地理围栏）</h2><button className="ghost" onClick={() => setFence({ branch: branches[0], radius: 150, active: true })}>＋ 新打卡点</button></div>
        <p className="muted small">员工打上班卡时，要在自己分店任一个打卡点的范围内。分店没有打卡点 = 不检查。最方便的设法：人站在门市 / 仓库里，按「用我现在的位置」。</p>
        {s.fences.length === 0 ? <Empty>还没有打卡点。</Empty> : (
          <ul className="list">
            {s.fences.map((f) => (
              <li key={f.id}>
                <span><b>{f.name}</b> <span className="muted">{`· ${BRANCH_LABEL[f.branch!]} · ${f.radius} 公尺内${f.active ? "" : " · 已停用"}`}</span></span>
                <span className="nowrap"><a href={mapLink(f.lat, f.lng)!} target="_blank" rel="noreferrer">地图</a> · <a href="#" onClick={(e) => { e.preventDefault(); setFence(f); }}>修改</a></span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <div className="page-head"><h2>班别</h2><button className="ghost" onClick={() => setShift({ sat_rule: "every", start_time: "09:00", lunch_start: "12:30", lunch_end: "13:30", end_time: "17:30", sat_end: "17:30" })}>＋ 新班别</button></div>
        <p className="muted small">迟到、早退、午休迟回都按员工的班别算。</p>
        <ul className="list">
          {s.shifts.map((x) => (
            <li key={x.code}>
              <span><b>{x.name}</b> <span className="muted">{`· ${x.start_time}–${x.end_time} · 午休 ${minsLabel(lunchLen(x))} · `}{SAT_RULE_LABEL[x.sat_rule]}{x.sat_rule !== "none" ? `（到 ${x.sat_end}）` : ""}</span></span>
              <a href="#" onClick={(e) => { e.preventDefault(); setShift(x); }}>修改</a>
            </li>
          ))}
        </ul>
      </section>

      <section className="card">
        <h2>员工打卡设定</h2>
        <div className="table-wrap flat">
          <table>
            <thead><tr><th>员工</th><th>班别</th><th className="hide-sm">直属主管</th><th className="hide-sm">其他</th><th></th></tr></thead>
            <tbody>
              {s.staff.map((x) => (
                <tr key={x.id}>
                  <td><b>{x.name}</b><div className="muted small">{x.department_name} · {BRANCH_LABEL[x.branch]}</div></td>
                  <td>{shiftName(x.shift)}</td>
                  <td className="hide-sm">{nameOf(x.manager_id) || <span className="muted">部门主管</span>}</td>
                  <td className="hide-sm small">{[x.geofence_exempt && "免打卡范围", x.join_date && `到职 ${x.join_date}`, x.gender && (x.gender === "F" ? "女" : "男")].filter(Boolean).join(" · ")}</td>
                  <td><a href="#" onClick={(e) => { e.preventDefault(); setStaff(x); }}>修改</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <Saturdays s={s} onChanged={load} />
      <Holidays s={s} branches={branches} onChanged={load} />

      {shift && <ShiftForm s={shift} onClose={() => setShift(null)} onSaved={() => { setShift(null); load(); }} />}
      {fence && <FenceForm f={fence} branches={branches} onClose={() => setFence(null)} onSaved={() => { setFence(null); load(); }} />}
      {staff && <StaffForm x={staff} s={s} onClose={() => setStaff(null)} onSaved={() => { setStaff(null); load(); }} />}
    </>
  );
}

function lunchLen(x: Partial<Shift>): number {
  if (!x.lunch_start || !x.lunch_end) return 60;
  const mins = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  return mins(x.lunch_end) - mins(x.lunch_start);
}

function useSave(onSaved: () => void) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function save(f: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await f();
      onSaved();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return { error, busy, save, setError };
}

function ShiftForm({ s, onClose, onSaved }: { s: Partial<Shift>; onClose: () => void; onSaved: () => void }) {
  const [v, setV] = useState<Partial<Shift>>(s);
  const { error, busy, save } = useSave(onSaved);
  const set = (k: keyof Shift) => (e: { target: { value: string } }) => setV({ ...v, [k]: e.target.value });
  const isNew = !s.code;
  // 午休不定时段：只设长度；lunch_start 只是名义时间（外出公务补卡用），lunch_end = lunch_start + 长度
  const [len, setLen] = useState(lunchLen(s));
  const withLunch = (): Partial<Shift> => {
    const start = v.lunch_start || "12:30";
    const [h, m] = start.split(":").map(Number);
    const end = h * 60 + m + len;
    return { ...v, lunch_start: start, lunch_end: `${String(Math.floor(end / 60)).padStart(2, "0")}:${String(end % 60).padStart(2, "0")}` };
  };
  return (
    <Modal title={isNew ? "新班别" : `修改：${s.name}`} onClose={onClose}>
      <form className="form" onSubmit={(e: FormEvent) => { e.preventDefault(); save(() => att.saveShift(withLunch())); }}>
        <div className="row">
          <label>名称<input value={v.name || ""} onChange={set("name")} required /></label>
          {isNew && <label>代号（英文小写）<input value={v.code || ""} onChange={set("code")} required pattern="[a-z0-9_]{2,20}" placeholder="例：showroom" /></label>}
        </div>
        <div className="row">
          <label>上班<input type="time" value={v.start_time || ""} onChange={set("start_time")} required /></label>
          <label>下班<input type="time" value={v.end_time || ""} onChange={set("end_time")} required /></label>
        </div>
        <div className="row">
          <label>午休长度（分钟，时段自由）<input type="number" min={15} max={180} step={5} value={len} onChange={(e) => setLen(Number(e.target.value))} required /></label>
        </div>
        <div className="row">
          <label>星期六
            <select value={v.sat_rule} onChange={set("sat_rule")}>
              {Object.entries(SAT_RULE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </label>
          <label>星期六下班<input type="time" value={v.sat_end || ""} onChange={set("sat_end")} required /></label>
        </div>
        <ErrorBox error={error} />
        <div className="actions"><button type="button" className="ghost" onClick={onClose}>取消</button><button disabled={busy}>{busy ? "储存中…" : "储存"}</button></div>
      </form>
    </Modal>
  );
}

function FenceForm({ f, branches, onClose, onSaved }: { f: Partial<Fence>; branches: string[]; onClose: () => void; onSaved: () => void }) {
  const [v, setV] = useState<Partial<Fence>>(f);
  const [locating, setLocating] = useState(false);
  const { error, busy, save, setError } = useSave(onSaved);
  async function here() {
    setLocating(true);
    setError("");
    try {
      const fix = await getFix();
      setV({ ...v, lat: Number(fix.lat.toFixed(6)), lng: Number(fix.lng.toFixed(6)) });
      if (fix.accuracy > 100) setError(`这次定位误差约 ${Math.round(fix.accuracy)} 公尺，建议到户外或窗边再按一次。`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLocating(false);
    }
  }
  return (
    <Modal title={f.id ? `修改：${f.name}` : "新打卡点"} onClose={onClose}>
      <form className="form" onSubmit={(e: FormEvent) => { e.preventDefault(); save(() => att.saveFence(v)); }}>
        <div className="row">
          <label>名称<input value={v.name || ""} onChange={(e) => setV({ ...v, name: e.target.value })} required placeholder="例：总部门市" /></label>
          <label>分店
            <select value={v.branch} onChange={(e) => setV({ ...v, branch: e.target.value })}>
              {branches.map((b) => <option key={b} value={b}>{BRANCH_LABEL[b]}</option>)}
            </select>
          </label>
        </div>
        <div className="row">
          <label>纬度<input type="number" step="any" value={v.lat ?? ""} onChange={(e) => setV({ ...v, lat: Number(e.target.value) })} required /></label>
          <label>经度<input type="number" step="any" value={v.lng ?? ""} onChange={(e) => setV({ ...v, lng: Number(e.target.value) })} required /></label>
        </div>
        <div className="actions left">
          <button type="button" className="ghost" disabled={locating} onClick={here}>{locating ? "定位中…" : "📍 用我现在的位置"}</button>
          {v.lat != null && v.lng != null && <a href={mapLink(v.lat, v.lng)!} target="_blank" rel="noreferrer">在地图上确认</a>}
        </div>
        <label>范围（公尺，20 – 5000）<input type="number" min={20} max={5000} value={v.radius ?? 150} onChange={(e) => setV({ ...v, radius: Number(e.target.value) })} /></label>
        <label className="check"><input type="checkbox" checked={v.active ?? true} onChange={(e) => setV({ ...v, active: e.target.checked })} /> 使用中</label>
        <ErrorBox error={error} />
        <div className="actions"><button type="button" className="ghost" onClick={onClose}>取消</button><button disabled={busy}>{busy ? "储存中…" : "储存"}</button></div>
      </form>
    </Modal>
  );
}

function StaffForm({ x, s, onClose, onSaved }: { x: AttStaff; s: AttSettings; onClose: () => void; onSaved: () => void }) {
  const [v, setV] = useState(x);
  const { error, busy, save } = useSave(onSaved);
  return (
    <Modal title={`打卡设定：${x.name}`} onClose={onClose}>
      <form className="form" onSubmit={(e: FormEvent) => { e.preventDefault(); save(() => att.setStaff({ ...v, join_date: v.join_date || "", gender: v.gender || "" })); }}>
        <label>班别
          <select value={v.shift} onChange={(e) => setV({ ...v, shift: e.target.value })}>
            {s.shifts.map((h) => <option key={h.code} value={h.code}>{h.name}</option>)}
          </select>
        </label>
        <label>直属主管（看得到他的出勤）
          <select value={v.manager_id ?? ""} onChange={(e) => setV({ ...v, manager_id: e.target.value ? Number(e.target.value) : null })}>
            <option value="">不指定：同部门的主管</option>
            {s.staff.filter((p) => p.id !== x.id).map((p) => <option key={p.id} value={p.id}>{p.name} · {p.department_name}</option>)}
          </select>
        </label>
        <div className="row">
          <label>到职日（年假 / 病假按年资算；之前的日子不算缺勤）<input type="date" value={v.join_date || ""} onChange={(e) => setV({ ...v, join_date: e.target.value })} /></label>
          <label>性别（产假 / 陪产假用）
            <select value={v.gender || ""} onChange={(e) => setV({ ...v, gender: (e.target.value || null) as AttStaff["gender"] })}>
              <option value="">未填</option>
              <option value="F">女</option>
              <option value="M">男</option>
            </select>
          </label>
        </div>
        <label className="check"><input type="checkbox" checked={v.geofence_exempt} onChange={(e) => setV({ ...v, geofence_exempt: e.target.checked })} /> 免打卡范围（业务、司机、外勤；仍会记录位置）</label>
        <ErrorBox error={error} />
        <div className="actions"><button type="button" className="ghost" onClick={onClose}>取消</button><button disabled={busy}>{busy ? "储存中…" : "储存"}</button></div>
      </form>
    </Modal>
  );
}

function Saturdays({ s, onChanged }: { s: AttSettings; onChanged: () => void }) {
  const { error, save } = useSave(onChanged);
  if (!s.shifts.some((x) => x.sat_rule === "designated")) return null;
  return (
    <section className="card">
      <h2>每月上班的星期六</h2>
      <p className="muted small">「每月指定一个星期六」的班别，这一天上半天班；没改就是当月第一个星期六。</p>
      <ErrorBox error={error} />
      <ul className="list">
        {s.saturdays.map((m) => (
          <li key={m.ym}>
            <span>{m.ym}{m.custom ? "" : <span className="muted small">（预设）</span>}</span>
            <span className="nowrap">
              <select value={m.date} style={{ width: "auto" }} onChange={(e) => save(() => att.setSaturday(m.ym, e.target.value))}>
                {saturdaysOf(m.ym).map((d) => <option key={d} value={d}>{d.slice(5)} {weekday(d)}</option>)}
              </select>
              {m.custom && <> <a href="#" onClick={(e) => { e.preventDefault(); save(() => att.setSaturday(m.ym, null)); }}>还原</a></>}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function saturdaysOf(ym: string): string[] {
  const [y, m] = ym.split("-").map(Number);
  const out: string[] = [];
  for (let d = 1; d <= 31; d++) {
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCMonth() !== m - 1) break;
    if (dt.getUTCDay() === 6) out.push(dt.toISOString().slice(0, 10));
  }
  return out;
}

function Holidays({ s, branches, onChanged }: { s: AttSettings; branches: string[]; onChanged: () => void }) {
  const [date, setDate] = useState("");
  const [name, setName] = useState("");
  const [branch, setBranch] = useState("ALL");
  const { error, busy, save } = useSave(() => { setDate(""); setName(""); onChanged(); });
  const year = new Date().getFullYear();
  const list = s.holidays.filter((h) => h.date >= `${year}-01-01`);
  const [importing, setImporting] = useState(false);
  return (
    <section className="card">
      <div className="pay-top"><h2>公共假日</h2><button className="ghost" onClick={() => setImporting(true)}>一键带入公共假日</button></div>
      {importing && <HolidayImport existing={s.holidays} onClose={() => setImporting(false)} onDone={() => { setImporting(false); onChanged(); }} />}
      <p className="muted small">假日不算工作日（不算缺勤、迟到）。全国假日选「全部分店」；州属假日（例：柔佛）选该分店。</p>
      <form className="form" onSubmit={(e: FormEvent) => { e.preventDefault(); save(() => att.saveHoliday({ date, name, branch })); }}>
        <div className="row">
          <label>日期<input type="date" value={date} onChange={(e) => setDate(e.target.value)} required /></label>
          <label>名称<input value={name} onChange={(e) => setName(e.target.value)} required placeholder="例：屠妖节" /></label>
          <label>适用
            <select value={branch} onChange={(e) => setBranch(e.target.value)}>
              <option value="ALL">全部分店</option>
              {branches.map((b) => <option key={b} value={b}>{BRANCH_LABEL[b]}</option>)}
            </select>
          </label>
        </div>
        <ErrorBox error={error} />
        <div className="actions"><button disabled={busy}>新增假日</button></div>
      </form>
      {list.length === 0 ? <p className="muted small">{`${year} 年还没有设假日。`}</p> : (
        <ul className="list">
          {list.map((h) => (
            <li key={h.date + h.branch}>
              <span>{h.date} {weekday(h.date)} · <b>{h.name}</b> <span className="muted">· {h.branch === "ALL" ? "全部分店" : BRANCH_LABEL[h.branch]}</span></span>
              <a href="#" onClick={(e) => { e.preventDefault(); save(() => att.saveHoliday({ ...h, delete: true })); }}>删除</a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
