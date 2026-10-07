// 员工与权限 · 加入申请：加入链接（邀请码）、开关、换新码；待批准的申请（选部门、分店后批准 / 拒绝）；最近处理过的。
import { useCallback, useEffect, useState } from "react";
import { BRANCH_LABEL, Me } from "../api";
import { supabase } from "../supabase";
import { Empty, ErrorBox, Modal } from "../ui";

interface Req {
  id: number; email: string; name: string; phone: string; gender: string | null; join_date: string | null;
  branch: string | null; note: string; status: string; created_at: string; decided_at: string | null;
  decide_note: string; decided_by_name?: string;
}
interface JoinData { setting: { code: string; enabled: boolean }; pending: Req[]; recent: Req[] }

async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}
const when = (s: string | null) => (s ? s.slice(0, 16).replace("T", " ") : "");

export default function JoinAdmin({ me, onChanged }: { me: Me; onChanged: () => void }) {
  const [d, setD] = useState<JoinData | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<Req | null>(null);
  const [copied, setCopied] = useState(false);
  const load = useCallback(() => { rpc<JoinData>("ops_join_list").then(setD).catch((e: Error) => setError(e.message)); }, []);
  useEffect(load, [load]);
  if (!d) return error ? <ErrorBox error={error} /> : <p className="muted">载入中…</p>;

  const link = `${window.location.origin}/#/join?c=${d.setting.code}`;
  async function setting(p: Record<string, unknown>, ask?: string) {
    if (ask && !confirm(ask)) return;
    try { await rpc("ops_join_setting_save", { p }); load(); } catch (e) { setError((e as Error).message); }
  }
  function copy() {
    navigator.clipboard?.writeText(link).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }).catch(() => {});
  }
  const share = `https://wa.me/?text=${encodeURIComponent(`HomeWorks 营运系统：请用手机打开这个链接，填资料申请账号（打卡、请假、工资单都在这里）\n${link}`)}`;

  return (
    <>
      <section className="card">
        <h2>加入链接</h2>
        {d.setting.enabled ? (
          <>
            <p className="muted small">发到员工群组。员工打开后自己填名字、email、密码，你在下面批准后他就能登入。</p>
            <div className="join-link"><code>{link}</code></div>
            <div className="actions left">
              <button onClick={copy}>{copied ? "已复制 ✓" : "复制链接"}</button>
              <a className="ghost-link" href={share} target="_blank" rel="noopener">WhatsApp 分享</a>
              <button className="ghost" onClick={() => setting({ new_code: true }, "换新链接后，旧链接马上失效。确定？")}>换新链接</button>
              <button className="ghost" onClick={() => setting({ enabled: false })}>暂停申请</button>
            </div>
          </>
        ) : (
          <>
            <p className="late">申请已暂停，链接打开会显示「已失效」。</p>
            <div className="actions left"><button onClick={() => setting({ enabled: true })}>重新开放申请</button></div>
          </>
        )}
      </section>
      <ErrorBox error={error} />
      <h2 className="section-title">{`等你批准（${d.pending.length}）`}</h2>
      {d.pending.length === 0 ? <Empty>没有新的申请。</Empty> : (
        <ul className="list card">
          {d.pending.map((r) => (
            <li key={r.id} className="click" onClick={() => setOpen(r)}>
              <span><b>{r.name}</b>{" "}<span className="muted small">{r.email}</span>
                <div className="muted small">{[r.branch ? BRANCH_LABEL[r.branch] : "", r.note, when(r.created_at)].filter(Boolean).join(" · ")}</div></span>
              <span className="go">→</span>
            </li>
          ))}
        </ul>
      )}
      {d.recent.length > 0 && (
        <>
          <h2 className="section-title">最近处理过</h2>
          <ul className="list card small">
            {d.recent.map((r) => (
              <li key={r.id}>
                <span><b>{r.name}</b>{" "}<span className="muted">{r.email}</span>{r.decide_note && <div className="muted">{r.decide_note}</div>}</span>
                <span className="nowrap"><span className={"ap " + (r.status === "approved" ? "approved" : "rejected")}>{r.status === "approved" ? "已批准" : "已拒绝"}</span>
                  <div className="muted">{r.decided_by_name}</div></span>
              </li>
            ))}
          </ul>
        </>
      )}
      {open && <Decide me={me} r={open} onClose={() => setOpen(null)} onDone={() => { setOpen(null); load(); onChanged(); }} />}
    </>
  );
}

function Decide({ me, r, onClose, onDone }: { me: Me; r: Req; onClose: () => void; onDone: () => void }) {
  const [dept, setDept] = useState("");
  const [branch, setBranch] = useState(r.branch || "HOMEWORKSSB");
  const [role, setRole] = useState("staff");
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function go(approve: boolean) {
    if (!approve && !confirm(`拒绝 ${r.name} 的申请？`)) return;
    setBusy(true); setError("");
    try {
      await rpc("ops_join_decide", { p: { id: r.id, approve, department: dept, branch, role, title, note } });
      onDone();
    } catch (e) { setError((e as Error).message); setBusy(false); }
  }
  return (
    <Modal title={`加入申请：${r.name}`} onClose={onClose}>
      <p className="small">{r.email}{r.phone && ` · ${r.phone}`}{r.gender && ` · ${r.gender === "M" ? "男" : "女"}`}{r.join_date && ` · 到职 ${r.join_date}`}</p>
      {r.note && <p className="muted small">{`备注：${r.note}`}</p>}
      <div className="form">
        <div className="row">
          <label>部门
            <select value={dept} onChange={(e) => setDept(e.target.value)}>
              <option value="">请选</option>
              {me.departments.map((x) => <option key={x.code} value={x.code}>{x.name}</option>)}
            </select>
          </label>
          <label>分店
            <select value={branch} onChange={(e) => setBranch(e.target.value)}>
              <option value="HOMEWORKSSB">{BRANCH_LABEL.HOMEWORKSSB}</option>
              <option value="HOMEWORKSSOUTHERN">{BRANCH_LABEL.HOMEWORKSSOUTHERN}</option>
            </select>
          </label>
        </div>
        <div className="row">
          <label>角色
            <select value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="staff">员工</option><option value="manager">主管</option>
            </select>
          </label>
          <label>职位（选填）<input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={60} /></label>
        </div>
        <label>给申请人的话（选填，拒绝时他看得到）<input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} /></label>
        <ErrorBox error={error} />
        <div className="actions">
          <button className="ghost danger" disabled={busy} onClick={() => go(false)}>拒绝</button>
          <button disabled={busy || !dept} onClick={() => go(true)}>{busy ? "处理中…" : "批准"}</button>
        </div>
      </div>
    </Modal>
  );
}
