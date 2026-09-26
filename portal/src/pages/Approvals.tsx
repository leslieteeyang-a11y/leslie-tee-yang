import { FormEvent, useCallback, useEffect, useState } from "react";
import {
  api, Approval, APPROVAL_STATUS_LABEL, ApprovalKind, BRANCH_LABEL, can, DirectoryEntry, fmtDate, KIND_LABEL, Me,
} from "../api";
import { Empty, ErrorBox, Modal, Tabs } from "../ui";

type Scope = "todo" | "mine" | "all";

export default function Approvals({ me }: { me: Me }) {
  const [scope, setScope] = useState<Scope>("todo");
  const [rows, setRows] = useState<Approval[] | null>(null);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<Approval | null>(null);
  const [people, setPeople] = useState<DirectoryEntry[]>([]);

  const load = useCallback(() => {
    setError("");
    api.approvals(scope).then(setRows).catch((e: Error) => setError(e.message));
  }, [scope]);
  useEffect(load, [load]);
  useEffect(() => {
    api.directory().then(setPeople).catch(() => {});
  }, []);

  return (
    <>
      <div className="page-head">
        <h1>审批</h1>
        {can(me, "approvals", "edit") && <button onClick={() => setCreating(true)}>＋ 提出申请</button>}
      </div>
      <div className="filters">
        <Tabs value={scope} onChange={setScope} options={[["todo", "等我审批"], ["mine", "我提交的"], ["all", "全部"]]} />
      </div>
      <ErrorBox error={error} />
      {rows === null ? <p className="muted">载入中…</p> : rows.length === 0 ? (
        <Empty>{scope === "todo" ? "目前没有等你审批的申请。" : "没有申请。"}</Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>申请</th><th className="hide-sm">类别</th><th>金额</th><th>申请人</th><th className="hide-sm">日期</th><th>状态</th></tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id} className="click" onClick={() => setOpen(a)}>
                  <td><b>{a.title}</b></td>
                  <td className="hide-sm">{KIND_LABEL[a.kind]}</td>
                  <td className="num">{a.amount != null ? `RM ${Number(a.amount).toLocaleString("en-MY", { minimumFractionDigits: 2 })}` : ""}</td>
                  <td>{a.requested_by_name}<span className="muted"> · {a.department_name}</span></td>
                  <td className="hide-sm">{fmtDate(a.created_at)}</td>
                  <td><span className={"ap " + a.status}>{APPROVAL_STATUS_LABEL[a.status]}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {creating && (
        <ApprovalForm me={me} people={people} onClose={() => setCreating(false)}
                      onSaved={() => { setCreating(false); setScope("mine"); load(); }} />
      )}
      {open && <ApprovalDetail a={open} onClose={() => setOpen(null)} onChanged={() => { setOpen(null); load(); }} />}
    </>
  );
}

function ApprovalForm({ me, people, onClose, onSaved }: {
  me: Me; people: DirectoryEntry[]; onClose: () => void; onSaved: () => void;
}) {
  const [kind, setKind] = useState<ApprovalKind>("leave");
  const [title, setTitle] = useState("");
  const [detail, setDetail] = useState("");
  const [amount, setAmount] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [approver, setApprover] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const approvers = people.filter((p) => p.id !== me.staff.id && (p.role === "manager" || p.role === "admin")
    && (p.branch === "ALL" || me.staff.branch === "ALL" || p.branch === me.staff.branch));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const data: Record<string, string> = {};
    if (kind === "leave") {
      if (!from) {
        setBusy(false);
        return setError("请填请假开始日期。");
      }
      data.from = from;
      data.to = to || from;
    }
    try {
      await api.createApproval({
        kind, detail, data,
        title: title || (kind === "leave" ? `请假 ${data.from}${data.to !== data.from ? ` ~ ${data.to}` : ""}` : ""),
        amount: amount || null,
        approver_id: approver || null,
      });
      onSaved();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal title="提出申请" onClose={onClose}>
      <form onSubmit={submit} className="form">
        <label>类别
          <select value={kind} onChange={(e) => setKind(e.target.value as ApprovalKind)}>
            {Object.entries(KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        {kind === "leave" && (
          <div className="row">
            <label>从<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} required /></label>
            <label>到<input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></label>
          </div>
        )}
        <label>标题{kind === "leave" && <small className="muted">（可留空，自动用日期）</small>}
          <input value={title} onChange={(e) => setTitle(e.target.value)} required={kind !== "leave"}
                 placeholder={kind === "purchase" ? "例：买货架 2 个" : kind === "discount" ? "例：客户 ABC 浴室柜特价" : ""} />
        </label>
        <label>说明 / 原因<textarea rows={3} value={detail} onChange={(e) => setDetail(e.target.value)} /></label>
        {kind !== "leave" && (
          <label>金额（RM，选填）<input type="number" step="0.01" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
        )}
        <label>指定审批人（选填）
          <select value={approver} onChange={(e) => setApprover(e.target.value)}>
            <option value="">不指定：部门主管或管理层都可以批</option>
            {approvers.map((p) => <option key={p.id} value={p.id}>{p.name}{p.title ? ` · ${p.title}` : ""}</option>)}
          </select>
        </label>
        <ErrorBox error={error} />
        <div className="actions">
          <button type="button" className="ghost" onClick={onClose}>取消</button>
          <button disabled={busy}>{busy ? "送出中…" : "送出申请"}</button>
        </div>
      </form>
    </Modal>
  );
}

function ApprovalDetail({ a, onClose, onChanged }: { a: Approval; onClose: () => void; onChanged: () => void }) {
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function decide(d: string) {
    if (d === "rejected" && !note.trim()) return setError("驳回请写原因，让申请人知道。");
    setBusy(true);
    try {
      await api.decide(a.id, d, note);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal title={`#${a.id} ${a.title}`} onClose={onClose}>
      <dl>
        <dt>状态</dt><dd><span className={"ap " + a.status}>{APPROVAL_STATUS_LABEL[a.status]}</span></dd>
        <dt>类别</dt><dd>{KIND_LABEL[a.kind]}</dd>
        {a.kind === "leave" && a.data?.from && (<><dt>日期</dt><dd>{a.data.from}{a.data.to && a.data.to !== a.data.from ? ` ~ ${a.data.to}` : ""}</dd></>)}
        {a.amount != null && (<><dt>金额</dt><dd>RM {Number(a.amount).toLocaleString("en-MY", { minimumFractionDigits: 2 })}</dd></>)}
        <dt>申请人</dt><dd>{a.requested_by_name}（{a.department_name} · {BRANCH_LABEL[a.branch]}）· {fmtDate(a.created_at)}</dd>
        {a.approver_name && (<><dt>指定审批人</dt><dd>{a.approver_name}</dd></>)}
        {a.decided_by_name && (<><dt>处理</dt><dd>{a.decided_by_name} · {fmtDate(a.decided_at)}{a.decision_note && `：${a.decision_note}`}</dd></>)}
      </dl>
      {a.detail && <p className="pre">{a.detail}</p>}
      <ErrorBox error={error} />
      {a.can_decide && (
        <div className="form">
          <label>审批意见（驳回必填）<input value={note} onChange={(e) => setNote(e.target.value)} /></label>
          <div className="actions">
            <button className="ghost danger" disabled={busy} onClick={() => decide("rejected")}>驳回</button>
            <button disabled={busy} onClick={() => decide("approved")}>✓ 批准</button>
          </div>
        </div>
      )}
      {a.can_cancel && (
        <div className="actions">
          <button className="ghost danger" disabled={busy} onClick={() => decide("cancelled")}>撤回申请</button>
        </div>
      )}
    </Modal>
  );
}
