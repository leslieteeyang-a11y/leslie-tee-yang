import { useEffect, useState } from "react";
import { api, can, Home, Me, Task } from "../api";
import { ErrorBox } from "../ui";

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
      {home && (
        <div className="kpis">
          <a className="kpi" href="#/tasks"><b>{home.my_open_tasks}</b><span>我的待办任务</span></a>
          <a className={"kpi" + (home.my_overdue ? " warn" : "")} href="#/tasks"><b>{home.my_overdue}</b><span>已逾期</span></a>
          <a className={"kpi" + (home.approvals_waiting ? " warn" : "")} href="#/approvals"><b>{home.approvals_waiting}</b><span>等我审批</span></a>
          <a className="kpi" href="#/approvals"><b>{home.my_pending_requests}</b><span>我的申请（待批）</span></a>
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
             href={["tasks", "approvals", "admin"].includes(m.key) ? `#/${m.key}` : `#/m/${m.key}`}>
            <b>{m.name}</b>
            <span>{m.description}</span>
            <small>{m.ready ? "已上线" : `第 ${m.phase} 阶段 · 规划中`}</small>
          </a>
        ))}
      </div>
    </>
  );
}
