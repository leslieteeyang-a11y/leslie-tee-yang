// 请假（所有员工）：我的假期余额、申请请假、我的假单。HR 审批在「人事」。
import { FormEvent, useCallback, useEffect, useState } from "react";
import { fmtDate, Me } from "../api";
import { Empty, ErrorBox, Modal } from "../ui";
import "../att.css";
import "../leave.css";
import { shrinkImage, uploadPhoto, weekday } from "../att-api";
import { Photo } from "../att/Records";
import {
  Balance, dateRange, daysLabel, leave, LeaveHome, LeavePart, LeaveRequest, LeaveType, LEAVE_STATUS_LABEL,
} from "../leave-api";

export default function Leave({ me }: { me: Me }) {
  const [data, setData] = useState<LeaveHome | null>(null);
  const [error, setError] = useState("");
  const [applying, setApplying] = useState(false);
  const [open, setOpen] = useState<LeaveRequest | null>(null);
  const [notice, setNotice] = useState("");

  const load = useCallback(() => {
    leave.home().then(setData).catch((e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  if (!data) return error ? <ErrorBox error={error} /> : <p className="muted">载入中…</p>;

  return (
    <>
      <div className="page-head">
        <h1>请假</h1>
        <button onClick={() => { setNotice(""); setApplying(true); }}>＋ 申请请假</button>
      </div>
      {notice && <div className="ok">{notice}</div>}
      <ErrorBox error={error} />

      <h2 className="section-title">{`${data.year} 年假期余额`}</h2>
      <BalanceCards balances={data.balances} />
      {!data.join_date && <p className="muted small">HR 还没填你的到职日，年假 / 病假先按第一年计算。</p>}
      {/* 到职未满几个月的假别（例：年假 3 个月）：天数照算，但要到那天才能请 */}
      {data.types.filter((t) => notYet(t, data.today)).map((t) => (
        <p key={t.code} className="small late">{serviceHint(t)}</p>
      ))}

      <h2 className="section-title">我的假单</h2>
      <LeaveTable rows={data.requests} onOpen={setOpen} empty="还没有请过假。" />

      {applying && (
        <LeaveForm me={me} types={data.types} today={data.today} balances={data.balances}
                   onClose={() => setApplying(false)}
                   onSaved={(r) => { setApplying(false); setNotice(`已送出：${r.type_name} ${daysLabel(r.days)} 天，等 HR 审核。`); load(); }} />
      )}
      {open && <LeaveDetail r={open} onClose={() => setOpen(null)} onChanged={() => { setOpen(null); load(); }} />}
    </>
  );
}

/** 这个假别在 day 那天还不能请（到职未满 min_service_months）；没有 available_from = 不限 */
function notYet(t: LeaveType, day: string): boolean {
  return !!t.available_from && day < t.available_from;
}
function serviceHint(t: LeaveType): string {
  return `到职满 ${t.min_service_months} 个月（${t.available_from}）后才能请${t.name}`;
}

export function BalanceCards({ balances }: { balances: Balance[] }) {
  const shown = balances.filter((b) => b.entitled !== null || b.used > 0 || b.pending > 0);
  return (
    <div className="lv-cards">
      {shown.map((b) => (
        <div key={b.type} className={"lv-card" + (b.balance !== null && b.balance <= 0 && b.entitled ? " empty" : "")}>
          <span>{b.name}</span>
          {b.balance === null
            ? <><b>{daysLabel(b.used)}</b><small>{"已用（不设上限）"}</small></>
            : <><b>{daysLabel(b.balance)}</b>
                <small>{`应得 ${daysLabel(Number(b.entitled) + Number(b.adjust))} · 已用 ${daysLabel(b.used)}`}{b.pending > 0 ? ` · 审核中 ${daysLabel(b.pending)}` : ""}</small></>}
        </div>
      ))}
    </div>
  );
}

export function LeaveTable({ rows, onOpen, empty, showStaff }: {
  rows: LeaveRequest[]; onOpen: (r: LeaveRequest) => void; empty: string; showStaff?: boolean;
}) {
  if (rows.length === 0) return <Empty>{empty}</Empty>;
  return (
    <div className="table-wrap">
      <table>
        <thead><tr>{showStaff && <th>员工</th>}<th>假别</th><th>日期</th><th className="num">天数</th><th className="hide-sm">原因</th><th>状态</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="click" onClick={() => onOpen(r)}>
              {showStaff && <td><b>{r.staff_name}</b><div className="muted small">{r.department_name}</div></td>}
              <td className="nowrap">{r.type_name}</td>
              <td className="nowrap">{dateRange(r)}</td>
              <td className="num">{daysLabel(r.days)}</td>
              <td className="hide-sm">{r.reason}</td>
              <td><span className={"ap " + r.status}>{LEAVE_STATUS_LABEL[r.status]}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 申请表；HR 代填时传 staff（帮员工登记纸本 MC 等） */
export function LeaveForm({ me, types, today, balances, staff, onClose, onSaved }: {
  me: Me; types: LeaveType[]; today: string; balances?: Balance[]; staff?: { id: number; name: string };
  onClose: () => void; onSaved: (r: LeaveRequest) => void;
}) {
  const [type, setType] = useState(types[0]?.code || "");
  const [start, setStart] = useState(today);
  const [end, setEnd] = useState(today);
  const [part, setPart] = useState<LeavePart>("full");
  const [reason, setReason] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [days, setDays] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const lt = types.find((t) => t.code === type);
  const bal = balances?.find((b) => b.type === type);
  const half = part !== "full";

  useEffect(() => {
    if (!lt?.half_day && part !== "full") setPart("full");
  }, [lt, part]);
  useEffect(() => {
    if (end < start || half) setEnd(start);
  }, [start, end, half]);
  useEffect(() => {
    setDays(null);
    if (!type || !start) return;
    const t = setTimeout(() => {
      leave.preview({ type, start_date: start, end_date: half ? start : end, part, staff_id: staff?.id ?? null })
        .then((r) => setDays(r.days)).catch(() => setDays(null));
    }, 250);
    return () => clearTimeout(t);
  }, [type, start, end, part, half, staff]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      let attachment: string | null = null;
      if (file) {
        const blob = file.type.startsWith("image/") ? await shrinkImage(file) : file;
        if (blob.size > 5 * 1024 * 1024) throw new Error("附件太大（上限 5 MB）。");
        attachment = await uploadPhoto(me.staff.id, "leave", start, blob);
      }
      onSaved(await leave.apply({ type, start_date: start, end_date: half ? start : end, part, reason, attachment,
                                  staff_id: staff?.id ?? null }));
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal title={staff ? `帮 ${staff.name} 请假` : "申请请假"} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label>假别
          <select value={type} onChange={(e) => setType(e.target.value)} required>
            {types.map((t) => <option key={t.code} value={t.code}>{t.name}</option>)}
          </select>
        </label>
        {lt?.note && <p className="muted small">{lt.note}</p>}
        {bal && bal.balance !== null && <p className="small">{`还可以请 ${daysLabel(Number(bal.balance))} 天`}</p>}
        {lt && notYet(lt, start) && <p className="small late">{serviceHint(lt)}</p>}
        {lt?.half_day && (
          <label>时段
            <select value={part} onChange={(e) => setPart(e.target.value as LeavePart)}>
              <option value="full">整天</option>
              <option value="am">上午半天</option>
              <option value="pm">下午半天</option>
            </select>
          </label>
        )}
        <div className="row">
          <label>{half ? "日期" : "开始日期"}<input type="date" value={start} onChange={(e) => setStart(e.target.value)} required /></label>
          {!half && <label>结束日期<input type="date" value={end} min={start} onChange={(e) => setEnd(e.target.value)} required /></label>}
        </div>
        <p className="small">
          {days == null ? <span className="muted">计算天数中…</span>
            : <>{`共 ${daysLabel(days)} 天`}<span className="muted">{lt?.calendar_days ? "（按日历天算）" : "（星期日、公共假期不算）"}</span></>}
          {!half && start && <span className="muted">{` · ${weekday(start)}${end !== start ? ` 到 ${weekday(end)}` : ""}`}</span>}
        </p>
        <label>原因{lt?.need_attachment ? "" : "（选填）"}
          <textarea rows={2} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder="例：家里有事、看医生" />
        </label>
        <label>{lt?.need_attachment ? "证明（必附：照片或 PDF，例：医生证明 MC）" : "证明（选填：照片或 PDF）"}
          <input type="file" accept="image/*,application/pdf" onChange={(e) => setFile(e.target.files?.[0] || null)}
                 required={!!lt?.need_attachment} />
        </label>
        <p className="muted small">送出后由 HR 审核；审核中的天数会先从余额扣掉。</p>
        <ErrorBox error={error} />
        <div className="actions">
          <button type="button" className="ghost" onClick={onClose}>取消</button>
          <button disabled={busy || days === 0 || (!!lt && notYet(lt, start))}>{busy ? "送出中…" : "送出申请"}</button>
        </div>
      </form>
    </Modal>
  );
}

export function LeaveDetail({ r, onClose, onChanged }: { r: LeaveRequest; onClose: () => void; onChanged: () => void }) {
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

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
    <Modal title={`${r.type_name} · ${r.staff_name}`} onClose={onClose}>
      <dl>
        <dt>状态</dt><dd><span className={"ap " + r.status}>{LEAVE_STATUS_LABEL[r.status]}</span></dd>
        <dt>日期</dt><dd>{dateRange(r)}</dd>
        <dt>天数</dt><dd>{daysLabel(r.days)}</dd>
        {r.reason && <><dt>原因</dt><dd className="pre">{r.reason}</dd></>}
        <dt>申请</dt><dd>{fmtDate(r.created_at)}{r.created_by_name ? `（${r.created_by_name} 代填）` : ""}</dd>
        {r.decided_at && <><dt>处理</dt><dd>{r.decided_by_name ? `${r.decided_by_name} · ` : ""}{fmtDate(r.decided_at)}{r.decision_note && `：${r.decision_note}`}</dd></>}
      </dl>
      {r.attachment && <div className="shots"><figure><Photo path={r.attachment} /><figcaption>证明</figcaption></figure></div>}
      <ErrorBox error={error} />
      {(r.can_decide || (r.can_cancel && r.status === "approved")) && (
        <label className="form">审核意见（驳回 / 取消时写给申请人看）<input value={note} onChange={(e) => setNote(e.target.value)} /></label>
      )}
      <div className="actions">
        {r.can_cancel && (
          <button className="ghost danger" disabled={busy} onClick={() => run(() => leave.cancel(r.id, note))}>
            {r.status === "pending" ? "撤回申请" : "取消这张假"}
          </button>
        )}
        {r.can_decide && <>
          <button className="ghost danger" disabled={busy}
                  onClick={() => note.trim() ? run(() => leave.decide(r.id, "reject", note)) : setError("驳回请写原因，让申请人知道。")}>驳回</button>
          <button disabled={busy} onClick={() => run(() => leave.decide(r.id, "approve", note))}>✓ 批准</button>
        </>}
      </div>
    </Modal>
  );
}
