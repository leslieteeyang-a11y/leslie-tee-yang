import { useEffect, useState } from "react";
import { api, can, Home, Me, moduleHref, Task } from "../api";
import { ErrorBox } from "../ui";
import { canPromptInstall, dismissHint, hintDismissed, isIos, isStandalone, onInstallChange, promptInstall } from "../install";

// 首页提示：把系统加到手机主画面（已安装、已关掉提示就不显示）
function InstallHint() {
  const [, force] = useState(0);
  const [hidden, setHidden] = useState(() => isStandalone() || hintDismissed());
  useEffect(() => onInstallChange(() => force((n) => n + 1)), []);
  if (hidden) return null;
  const close = () => { dismissHint(); setHidden(true); };
  return (
    <section className="card install">
      <div>
        <b>把营运系统加到手机主画面</b>
        <p className="muted small">
          {canPromptInstall()
            ? "像 App 一样一点就开，不用记网址。"
            : isIos()
              ? "用 Safari 打开这个网页 → 点下方「分享」按钮 → 选「加入主画面」。"
              : "用 Chrome 打开 → 点右上角 ⋮ → 选「加到主画面」或「安装应用程式」。"}
        </p>
      </div>
      <div className="actions">
        {canPromptInstall() && <button onClick={() => promptInstall().then((ok) => ok && setHidden(true))}>加到主画面</button>}
        <button className="ghost" onClick={close}>不用了</button>
      </div>
    </section>
  );
}

export default function HomePage({ me }: { me: Me }) {
  const [home, setHome] = useState<Home | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    api.home().then(setHome).catch((e: Error) => setError(e.message));
    if (can(me, "tasks", "view")) api.tasks("mine", "open").then((t) => setTasks(t.slice(0, 8))).catch(() => {});
  }, [me]);

  const hour = new Date().getHours();
  const hello = hour < 12 ? "早安" : hour < 18 ? "午安" : "晚安";
  const modules = me.modules.filter((m) => m.level !== "none" && m.key !== "dashboard");

  return (
    <>
      <h1>{hello}，{me.staff.name}</h1>
      <ErrorBox error={error} />
      <InstallHint />
      {home && (
        <div className="kpis">
          <a className="kpi" href="#/tasks"><b>{home.my_open_tasks}</b><span>我的待办任务</span></a>
          <a className={"kpi" + (home.my_overdue ? " warn" : "")} href="#/tasks"><b>{home.my_overdue}</b><span>已逾期</span></a>
          <a className={"kpi" + (home.approvals_waiting ? " warn" : "")} href="#/approvals"><b>{home.approvals_waiting}</b><span>等我审批</span></a>
          <a className="kpi" href="#/approvals"><b>{home.my_pending_requests}</b><span>我的申请（待批）</span></a>
          {home.po_overdue != null && (
            <a className={"kpi" + (home.po_overdue ? " warn" : "")} href="#/purchasing"><b>{home.po_overdue}</b><span>PO 已过预计到货日</span></a>
          )}
          <a className="kpi" href="#/tasks"><b>{home.dept_open_tasks}</b><span>{me.staff.department_name}部门未完成</span></a>
        </div>
      )}

      {tasks.length > 0 && (
        <section className="card">
          <h2>我的待办</h2>
          <ul className="list">
            {tasks.map((t) => (
              <li key={t.id}>
                <a href={`#/tasks/${t.id}`}>{t.title}</a>
                <span className={"due" + (t.overdue ? " late" : "")}>{t.due_date ? `期限 ${t.due_date}` : ""}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <h2 className="section-title">模块</h2>
      <div className="tiles">
        {modules.map((m) => (
          <a key={m.key} className={"tile" + (m.ready ? "" : " planned")}
             href={moduleHref(m)}>
            <b>{m.name}</b>
            <span>{m.description}</span>
            <small>{m.ready ? "已上线" : `第 ${m.phase} 阶段 · 规划中`}</small>
          </a>
        ))}
      </div>
    </>
  );
}
