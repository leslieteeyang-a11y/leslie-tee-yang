// 补卡：申请（漏打 / 打错 / 外出公务）、主管 → HR 两段审核。证明（附件）必填。
import { FormEvent, useCallback, useEffect, useState } from "react";
import { fmtDate, Me } from "../api";
import { Empty, ErrorBox, Modal, Tabs } from "../ui";
import {
  att, Correction, CORR_STATUS_CLASS, CORR_STATUS_LABEL, hhmm, Punch, PUNCH_LABEL, shrinkImage, uploadPhoto, weekday,
} from "../att-api";
import { Photo } from "./Records";

type Scope = "mine" | "todo" | "team";

export default function Corrections({ me, isLead, isHr, startDate, onStarted }: {
  me: Me; isLead: boolean; isHr: boolean; startDate: string | null; onStarted: () => void;
}) {
  const [scope, setScope] = useState<Scope>(isLead ? "todo" : "mine");
  const [rows, setRows] = useState<Correction[] | null>(null);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState<string | null>(null);
  const [open, setOpen] = useState<Correction | null>(null);

  const load = useCallback(() => {
    setRows(null);
    setError("");
    att.corrections(scope).then(setRows).catch((e: Error) => setError(e.message));
  }, [scope]);
  useEffect(load, [load]);
  useEffect(() => {
    if (startDate) { setCreating(startDate); onStarted(); }
  }, [startDate, onStarted]);

  return (
    <>
      <div className="filters">
        <Tabs value={scope} onChange={setScope}
              options={isLead ? [["todo", "等我审核"], ["mine", "我的补卡"], ["team", "团队"]] : [["mine", "我的补卡"]]} />
        <button onClick={() => setCreating("")}>＋ 申请补卡</button>
      </div>
      <ErrorBox error={error} />
      {!rows ? (!error && <p className="muted">载入中…</p>) : rows.length === 0 ? (
        <Empty>{scope === "todo" ? "没有等你审核的补卡。" : "没有补卡纪录。"}</Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr>{scope !== "mine" && <th>员工</th>}<th>日期</th><th>补什么</th><th className="hide-sm">原因</th><th>状态</th></tr></thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id} className="click" onClick={() => setOpen(c)}>
                  {scope !== "mine" && <td><b>{c.staff_name}</b><div className="muted small">{c.department_name}</div></td>}
                  <td className="nowrap">{c.date} <span className="muted">{weekday(c.date)}</span></td>
                  <td>{what(c)}</td>
                  <td className="hide-sm">{c.reason}</td>
                  <td><span className={"ap " + CORR_STATUS_CLASS[c.status]}>{CORR_STATUS_LABEL[c.status]}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {creating !== null && (
        <CorrectionForm me={me} date={creating} onClose={() => setCreating(null)}
                        onSaved={() => { setCreating(null); setScope("mine"); load(); }} />
      )}
      {open && <CorrectionDetail c={open} isHr={isHr} onClose={() => setOpen(null)} onChanged={() => { setOpen(null); load(); }} />}
    </>
  );
}

function what(c: Correction): string {
  if (c.kind === "offsite") return "外出公务（整天）";
  return `${PUNCH_LABEL[c.punch!]} ${c.time}${c.self_closed ? "（自己补的下班卡）" : ""}`;
}

function CorrectionForm({ me, date, onClose, onSaved }: { me: Me; date: string; onClose: () => void; onSaved: () => void }) {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kuala_Lumpur" }).format(new Date());
  const [d, setD] = useState(date || today);
  const [kind, setKind] = useState<"punch" | "offsite">("punch");
  const [punch, setPunch] = useState<Punch>("clock_in");
  const [time, setTime] = useState("");
  const [reason, setReason] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    // 补卡一定要附证明（AttendX §3.2）；自己补下班卡（打卡页）不在这里，不用附
    if (!file) return setError("补卡要附证明（例：WhatsApp 截图、送货单照片）。");
    setBusy(true);
    setError("");
    try {
      const blob = file.type.startsWith("image/") ? await shrinkImage(file) : file;
      if (blob.size > 5 * 1024 * 1024) throw new Error("附件太大（上限 5 MB）。");
      const attachment = await uploadPhoto(me.staff.id, d, "doc", blob);
      await att.createCorrection({ date: d, kind, punch: kind === "punch" ? punch : null, time: kind === "punch" ? time : null,
                                   reason, attachment });
      onSaved();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal title="申请补卡" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <div className="row">
          <label>日期<input type="date" value={d} max={today} onChange={(e) => setD(e.target.value)} required /></label>
          <label>种类
            <select value={kind} onChange={(e) => setKind(e.target.value as "punch" | "offsite")}>
              <option value="punch">漏打 / 打错一个卡</option>
              <option value="offsite">外出公务（整天不在公司）</option>
            </select>
          </label>
        </div>
        {kind === "punch" ? (
          <div className="row">
            <label>补哪一个卡
              <select value={punch} onChange={(e) => setPunch(e.target.value as Punch)}>
                {Object.entries(PUNCH_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </label>
            <label>实际时间<input type="time" value={time} onChange={(e) => setTime(e.target.value)} required /></label>
          </div>
        ) : <p className="muted small">批准后，这天会按你的班表记成全天出勤（上下班、午休都按标准时间）。</p>}
        <label>原因<textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} required minLength={5}
                             placeholder="例：手机没电，08:25 到公司（有同事可证明）" /></label>
        <label>证明（必填）
          <input type="file" accept="image/*,application/pdf" onChange={(e) => { setFile(e.target.files?.[0] || null); setError(""); }} />
        </label>
        <p className="muted small">照片或 PDF，例：WhatsApp 截图、送货单、客户签收单。没有证明的补卡送不出去。</p>
        <p className="muted small">14 天以内的可以自己申请，交给 HR 审核。</p>
        <ErrorBox error={error} />
        <div className="actions">
          <button type="button" className="ghost" onClick={onClose}>取消</button>
          <button disabled={busy}>{busy ? "送出中…" : "送出申请"}</button>
        </div>
      </form>
    </Modal>
  );
}

function CorrectionDetail({ c, isHr, onClose, onChanged }: { c: Correction; isHr: boolean; onClose: () => void; onChanged: () => void }) {
  const [note, setNote] = useState("");
  const [time, setTime] = useState(c.time || "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const rec = c.recorded;

  async function run(f: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await f();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal title={`补卡 · ${c.staff_name} · ${c.date}`} onClose={onClose}>
      <dl>
        <dt>状态</dt><dd><span className={"ap " + CORR_STATUS_CLASS[c.status]}>{CORR_STATUS_LABEL[c.status]}</span></dd>
        <dt>补什么</dt><dd>{what(c)}</dd>
        {c.kind === "punch" && <><dt>原本纪录</dt><dd>{c.original ? hhmm(c.original) : "（没有）"}</dd></>}
        <dt>当天打卡</dt>
        <dd>{rec ? `上班 ${hhmm(rec.clock_in) || "—"} · 午休 ${rec.lunch_out ? `${hhmm(rec.lunch_out)}–${hhmm(rec.lunch_in)}` : "—"} · 下班 ${hhmm(rec.clock_out) || "—"}` : "（没有纪录）"}</dd>
        <dt>原因</dt><dd className="pre">{c.reason}</dd>
        <dt>申请</dt><dd>{fmtDate(c.created_at)}</dd>
        {c.hod_name && <><dt>主管</dt><dd>{c.hod_name}</dd></>}
        {c.decided_by_name && <><dt>处理</dt><dd>{c.decided_by_name} · {fmtDate(c.decided_at)}{c.decision_note && `：${c.decision_note}`}</dd></>}
      </dl>
      {c.attachment && <div className="shots"><figure><Photo path={c.attachment} /><figcaption>证明</figcaption></figure></div>}
      <ErrorBox error={error} />
      {c.can_decide && (
        <div className="form">
          {c.kind === "punch" && isHr && (
            <label>定案时间（HR 可以改）<input type="time" value={time} onChange={(e) => setTime(e.target.value)} /></label>
          )}
          <label>审核意见（驳回必填）<input value={note} onChange={(e) => setNote(e.target.value)} /></label>
          <div className="actions">
            <button className="ghost danger" disabled={busy}
                    onClick={() => note.trim() ? run(() => att.decide(c.id, "reject", note)) : setError("驳回请写原因，让申请人知道。")}>驳回</button>
            <button disabled={busy} onClick={() => run(() => att.decide(c.id, "approve", note, time !== c.time ? time : null))}>✓ 批准</button>
          </div>
        </div>
      )}
      {c.can_cancel && (
        <div className="actions"><button className="ghost danger" disabled={busy} onClick={() => run(() => att.cancel(c.id))}>撤回申请</button></div>
      )}
    </Modal>
  );
}
