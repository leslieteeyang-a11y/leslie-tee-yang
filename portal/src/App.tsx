import { useCallback, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./supabase";
import { api, BRANCH_LABEL, can, Me, ROLE_LABEL } from "./api";
import { go, useRoute } from "./router";
import Login from "./pages/Login";
import HomePage from "./pages/Home";
import Tasks from "./pages/Tasks";
import Approvals from "./pages/Approvals";
import Admin from "./pages/Admin";
import Planned from "./pages/Planned";
import Password from "./pages/Password";

const ICON: Record<string, string> = {
  dashboard: "⌂", tasks: "☑", approvals: "✎", purchasing: "⛴", warehouse: "▦", delivery: "⛟", sales: "¤",
  collection: "₪", commission: "%", hr: "☺", payroll: "▤", reports: "▥", admin: "⚙",
};

export default function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [error, setError] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const route = useRoute();

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);

  const loadMe = useCallback(() => {
    setError("");
    api.me().then(setMe).catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    if (session) loadMe();
    else setMe(undefined);
  }, [session?.user?.id, loadMe]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => setMenuOpen(false), [route]);

  if (session === undefined) return <div className="center">载入中…</div>;
  if (!session) return <Login />;
  if (error)
    return (
      <div className="center card narrow">
        <p className="error">{error}</p>
        <button onClick={loadMe}>重试</button> <button className="ghost" onClick={() => supabase.auth.signOut()}>登出</button>
      </div>
    );
  if (me === undefined) return <div className="center">载入中…</div>;
  if (me === null)
    return (
      <div className="center card narrow">
        <h2>还不能进入营运系统</h2>
        <p>你的账号（{session.user.email}）还没加入员工名单，或已停用。请找管理员在「员工与权限」把你加进去。</p>
        <button onClick={() => supabase.auth.signOut()}>登出</button>
      </div>
    );

  const visible = me.modules.filter((m) => m.level !== "none");
  const [, section, arg] = route.split("/");
  let page;
  switch (section || "") {
    case "":
      page = <HomePage me={me} />;
      break;
    case "tasks":
      page = can(me, "tasks", "view") ? <Tasks me={me} openId={arg ? Number(arg) : undefined} /> : <NoAccess />;
      break;
    case "approvals":
      page = can(me, "approvals", "view") ? <Approvals me={me} /> : <NoAccess />;
      break;
    case "admin":
      page = can(me, "admin", "approve") ? <Admin me={me} onChanged={loadMe} /> : <NoAccess />;
      break;
    case "password":
      page = <Password />;
      break;
    case "m": {
      const m = me.modules.find((x) => x.key === arg);
      page = m && m.level !== "none" ? <Planned module={m} /> : <NoAccess />;
      break;
    }
    default:
      page = <NoAccess />;
  }

  const href = (key: string) =>
    key === "dashboard" ? "#/" : ["tasks", "approvals", "admin"].includes(key) ? `#/${key}` : `#/m/${key}`;
  const active = (key: string) =>
    key === "dashboard" ? !section : section === key || (section === "m" && arg === key);

  return (
    <div className="layout">
      <header className="topbar">
        <button className="icon menu-btn" onClick={() => setMenuOpen(!menuOpen)} aria-label="选单">☰</button>
        <a href="#/" className="brand-small">HomeWorks 营运</a>
      </header>
      <nav className={"side" + (menuOpen ? " open" : "")}>
        <a href="#/" className="brand">
          <span className="logo">⌂</span>
          <span>HomeWorks<br /><small>营运系统</small></span>
        </a>
        {visible.map((m) => (
          <a key={m.key} href={href(m.key)} className={active(m.key) ? "on" : ""}>
            <span className="ico">{ICON[m.key] ?? "•"}</span>
            {m.name}
            {!m.ready && <span className="soon">规划中</span>}
          </a>
        ))}
        <div className="who">
          <b>{me.staff.name}</b>
          <span>{me.staff.department_name} · {ROLE_LABEL[me.staff.role]} · {BRANCH_LABEL[me.staff.branch]}</span>
          <span>
            <a href="#/password">改密码</a> · <a href="#/" onClick={() => supabase.auth.signOut().then(() => go("/"))}>登出</a>
          </span>
        </div>
      </nav>
      {menuOpen && <div className="scrim" onClick={() => setMenuOpen(false)} />}
      <main>{page}</main>
    </div>
  );
}

function NoAccess() {
  return (
    <div className="card narrow">
      <h2>没有权限</h2>
      <p>你没有这个页面的权限。需要的话请找管理员开通。</p>
      <a href="#/">回首页</a>
    </div>
  );
}
