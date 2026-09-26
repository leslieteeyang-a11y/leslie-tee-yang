import { FormEvent, useCallback, useEffect, useState } from "react";
import { api, BRANCH_LABEL, can, DirectoryEntry, fmtDate, Me, Priority, PRIORITY_LABEL, STATUS_LABEL, Task, TaskStatus } from "../api";
import { go } from "../router";
import { Empty, ErrorBox, Modal, Tabs } from "../ui";

type Scope = "mine" | "dept" | "all";
type StatusFilter = "open" | "done" | "all";

export default function Tasks({ me, openId }: { me: Me; openId?: number }) {
  const [scope, setScope] = useState<Scope>("mine");
  const [status, setStatus] = useState<StatusFilter>("open");
  const [rows, setRows] = useState<Task[] | null>(null);
  const [people, setPeople] = useState<DirectoryEntry[]>([]);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const canEdit = can(me, "tasks", "edit");

  const load = useCallback(() => {
    setError("");
    api.tasks(scope, status).then(setRows).catch((e: Error) => setError(e.message));
  }, [scope, status]);

  useEffect(load, [load]);
  useEffect(() => {
    api.directory().then(setPeople).catch(() => {});
  }, []);

  return (
    <>
      <div className="page-head">
        <h1>任务</h1>
        {canEdit && <button onClick={() => setCreating(true)}>＋ 新任务</button>}
      </div>
      <div className="filters">
        <Tabs value={scope} onChange={setScope}
              options={[["mine", "我的"], ["dept", `${me.staff.department_name}部门`], ["all", "全部"]]} />
        <Tabs value={status} onChange={setStatus} options={[["open", "未完成"], ["done", "已完成"], ["all", "全部"]]} />
      </div>
      <ErrorBox error={error} />
      {rows === null ? <p className="muted">载入中…</p> : rows.length === 0 ? <Empty>没有任务。</Empty> : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>任务</th><th>负责人</th><th className="hide-sm">部门</th><th>期限</th><th className="hide-sm">优先</th><th>状态</th></tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id} className="click" onClick={() => go(`/tasks/${t.id}`)}>
                  <td>
                    <b>{t.title}</b>
                    {t.ref_no && <span className="tag">{t.ref_no}</span>}
                    {t.comment_count > 0 && <span className="muted"> · 💬{t.comment_count}</span>}
                  </td>
                  <td>{t.assignee_name ?? <span className="muted">未指派</span>}</td>
                  <td className="hide-sm">{t.department_name}</td>
                  <td className={"nowrap" + (t.overdue ? " late" : "")}>{t.due_date?.slice(5) ?? ""}</td>
                  <td className="hide-sm"><span className={"pri " + t.priority}>{PRIORITY_LABEL[t.priority]}</span></td>
                  <td><span className={"st " + t.status}>{STATUS_LABEL[t.status]}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {creating && (
        <TaskForm me={me} people={people} onClose={() => setCreating(false)}
                  onSaved={(t) => { setCreating(false); load(); go(`/tasks/${t.id}`); }} />
      )}
      {openId && <TaskDetail id={openId} me={me} people={people} onClose={() => go("/tasks")} onChanged={load} />}
    </>
  );
}

function TaskForm({ me, people, task, onClose, onSaved }: {
  me: Me; people: DirectoryEntry[]; task?: Task; onClose: () => void; onSaved: (t: Task) => void;
}) {
  const [f, setF] = useState({
    title: task?.title ?? "",
    detail: task?.detail ?? "",
    department: task?.department ?? me.staff.department,
    assignee_id: task?.assignee_id ? String(task.assignee_id) : "",
    due_date: task?.due_date ?? "",
    priority: (task?.priority ?? "normal") as Priority,
    ref_no: task?.ref_no ?? "",
    branch: task?.branch ?? (me.staff.branch === "ALL" ? "HOMEWORKSSB" : me.staff.branch),
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  // 指派对象：同分店（或 ALL）的人；先列所选部门的人
  const candidates = people
    .filter((p) => p.branch === "ALL" || p.branch === f.branch)
    .sort((a, b) => Number(b.department === f.department) - Number(a.department === f.department));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const payload: Record<string, unknown> = { ...f, assignee_id: f.assignee_id || null, due_date: f.due_date || null };
      if (task) payload.id = task.id;
      else if (me.staff.branch !== "ALL") delete payload.branch;
      onSaved(await api.saveTask(payload as Partial<Task>));
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal title={task ? "修改任务" : "新任务"} onClose={onClose}>
      <form onSubmit={submit} className="form">
        <label>标题<input value={f.title} onChange={set("title")} required autoFocus placeholder="例：柜子到货请安排收货" /></label>
        <label>说明<textarea rows={4} value={f.detail} onChange={set("detail")} /></label>
        <div className="row">
          <label>负责部门
            <select value={f.department} onChange={set("department")}>
              {me.departments.map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}
            </select>
          </label>
          <label>指派给
            <select value={f.assignee_id} onChange={set("assignee_id")}>
              <option value="">（未指派）</option>
              {candidates.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}{p.title ? ` · ${p.title}` : ""} ({me.departments.find((d) => d.code === p.department)?.name})
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="row">
          <label>期限<input type="date" value={f.due_date} onChange={set("due_date")} /></label>
          <label>优先
            <select value={f.priority} onChange={set("priority")}>
              {Object.entries(PRIORITY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
        </div>
        <div className="row">
          <label>关联单号（选填）<input value={f.ref_no} onChange={set("ref_no")} placeholder="PO / DO / 发票号" /></label>
          {me.staff.branch === "ALL" && !task && (
            <label>分店
              <select value={f.branch} onChange={set("branch")}>
                <option value="HOMEWORKSSB">{BRANCH_LABEL.HOMEWORKSSB}</option>
                <option value="HOMEWORKSSOUTHERN">{BRANCH_LABEL.HOMEWORKSSOUTHERN}</option>
              </select>
            </label>
          )}
        </div>
        <ErrorBox error={error} />
        <div className="actions">
          <button type="button" className="ghost" onClick={onClose}>取消</button>
          <button disabled={busy}>{busy ? "储存中…" : "储存"}</button>
        </div>
      </form>
    </Modal>
  );
}

function TaskDetail({ id, me, people, onClose, onChanged }: {
  id: number; me: Me; people: DirectoryEntry[]; onClose: () => void; onChanged: () => void;
}) {
  const [t, setT] = useState<Task | null>(null);
  const [error, setError] = useState("");
  const [comment, setComment] = useState("");
  const [editing, setEditing] = useState(false);

  const load = useCallback(() => {
    api.task(id).then(setT).catch((e: Error) => setError(e.message));
  }, [id]);
  useEffect(load, [load]);

  async function setStatus(s: TaskStatus) {
    try {
      await api.saveTask({ id, status: s });
      load();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function addComment(e: FormEvent) {
    e.preventDefault();
    if (!comment.trim()) return;
    try {
      await api.commentTask(id, comment);
      setComment("");
      load();
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (editing && t)
    return <TaskForm me={me} people={people} task={t} onClose={() => setEditing(false)}
                     onSaved={() => { setEditing(false); load(); onChanged(); }} />;

  return (
    <Modal title={t ? `#${t.id} ${t.title}` : "任务"} onClose={onClose} wide>
      <ErrorBox error={error} />
      {!t ? <p className="muted">{error ? "" : "载入中…"}</p> : (
        <div className="detail">
          <dl>
            <dt>状态</dt><dd><span className={"st " + t.status}>{STATUS_LABEL[t.status]}</span></dd>
            <dt>负责人</dt><dd>{t.assignee_name ?? "未指派"}（{t.department_name}）</dd>
            <dt>期限</dt><dd className={t.overdue ? "late" : ""}>{t.due_date ?? "—"}{t.overdue && "（已逾期）"}</dd>
            <dt>优先</dt><dd>{PRIORITY_LABEL[t.priority]}</dd>
            {t.ref_no && (<><dt>关联单号</dt><dd>{t.ref_no}</dd></>)}
            <dt>开单</dt><dd>{t.created_by_name} · {fmtDate(t.created_at)} · {BRANCH_LABEL[t.branch]}</dd>
            {t.done_at && (<><dt>完成</dt><dd>{fmtDate(t.done_at)}</dd></>)}
          </dl>
          {t.detail && <p className="pre">{t.detail}</p>}
          {t.editable && (
            <div className="actions left">
              {t.status === "todo" && <button onClick={() => setStatus("doing")}>开始处理</button>}
              {(t.status === "todo" || t.status === "doing") && <button onClick={() => setStatus("done")}>✓ 完成</button>}
              {(t.status === "done" || t.status === "cancelled") && <button className="ghost" onClick={() => setStatus("todo")}>重新打开</button>}
              <button className="ghost" onClick={() => setEditing(true)}>修改</button>
              {t.status !== "cancelled" && t.status !== "done" && (
                <button className="ghost danger" onClick={() => setStatus("cancelled")}>取消任务</button>
              )}
            </div>
          )}
          <h3>留言</h3>
          {t.comments?.length ? (
            <ul className="comments">
              {t.comments.map((c) => (
                <li key={c.id}><b>{c.staff_name}</b> <span className="muted">{fmtDate(c.created_at)}</span><p className="pre">{c.body}</p></li>
              ))}
            </ul>
          ) : <p className="muted">还没有留言。</p>}
          <form onSubmit={addComment} className="comment-form">
            <input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="写留言，例如进度、问题…" />
            <button>送出</button>
          </form>
        </div>
      )}
    </Modal>
  );
}
