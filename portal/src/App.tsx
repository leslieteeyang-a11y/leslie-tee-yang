import { useCallback, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./supabase";
import { api, BRANCH_LABEL, can, Me, moduleHref, ROLE_LABEL } from "./api";
import { go, useRoute } from "./router";
import Login from "./pages/Login";
import HomePage from "./pages/Home";
import Tasks from "./pages/Tasks";
import Approvals from "./pages/Approvals";
import Admin from "./pages/Admin";
import Planned from "./pages/Planned";
import Password from "./pages/Password";
import Purchasing from "./pages/Purchasing";
import Attendance from "./pages/Attendance";
import Leave from "./pages/Leave";
import Hr from "./pages/Hr";
import Warehouse from "./pages/Warehouse";
import Payroll from "./pages/Payroll";
import MyPay from "./pages/MyPay";
import MyProfile from "./pages/MyProfile";
import Join from "./pages/Join";
import JoinStatus from "./pages/JoinStatus";
import Delivery from "./pages/Delivery";
import { DriverPage } from "./dlv/DriverSign";
import { SyncNote } from "./sync";
import LangSwitch from "./LangSwitch";

const ICON: Record<string, string> = {
  dashboard: "⌂", tasks: "☑", approvals: "✎", purchasing: "⛴", attendance: "⏱", leave: "✈", warehouse: "▦", delivery: "⛟", sales: "¤",
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

  if (route.startsWith("/driver")) return <DriverPage key={route} />; // 司机签收连结：不用登入
  if (session === undefined) return <div className="center">载入中…</div>;
  if (route.startsWith("/join")) return <Join key={route} sessionEmail={session ? session.user.email || "—" : undefined} />;
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
      <JoinStatus email={session.user.email ?? ""} />
    );

  const visible = me.modules.filter((m) => m.level !== "none");
  const [, section, arg, arg2, arg3] = route.split("/");
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
      page = can(me, "admin", "approve") ? <Admin me={me} onChanged={loadMe} sub={arg} /> : <NoAccess />;
      break;
    case "purchasing":
      page = can(me, "purchasing", "view")
        ? <><SyncNote /><Purchasing me={me} sub={arg} arg1={arg2} arg2={arg3} /></>
        : <NoAccess />;
      break;
    case "attendance":
      page = can(me, "attendance", "view") ? <Attendance me={me} sub={arg} /> : <NoAccess />;
      break;
    case "leave":
      page = can(me, "leave", "view") ? <Leave me={me} /> : <NoAccess />;
      break;
    case "warehouse":
      page = can(me, "warehouse", "view") ? <><SyncNote /><Warehouse me={me} sub={arg} /></> : <NoAccess />;
      break;
    case "delivery":
      page = can(me, "delivery", "view") ? <Delivery me={me} sub={arg} /> : <NoAccess />;
      break;
    case "payroll":
      page = can(me, "payroll", "view") ? <Payroll me={me} sub={arg} /> : <NoAccess />;
      break;
    case "mypay":
      page = <MyPay />;
      break;
    case "profile":
      page = <MyProfile />;
      break;
    case "hr":
      page = can(me, "hr", "view") ? <Hr me={me} sub={arg} arg={arg2} /> : <NoAccess />;
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

  const active = (key: string) =>
    key === "dashboard" ? !section : section === key || (section === "m" && arg === key);

  return (
    <div className="layout">
      <header className="topbar">
        <button className="icon menu-btn" onClick={() => setMenuOpen(!menuOpen)} aria-label="选单">☰</button>
        <a href="#/" className="brand-small">HomeWorks 营运</a>
        <LangSwitch />
      </header>
      <nav className={"side" + (menuOpen ? " open" : "")}>
        <a href="#/" className="brand">
          <span className="logo">⌂</span>
          <span>HomeWorks<br /><small>营运系统</small></span>
        </a>
        {visible.map((m) => (
          <a key={m.key} href={moduleHref(m)} className={active(m.key) ? "on" : ""}>
            <span className="ico">{ICON[m.key] ?? "•"}</span>
            {m.name}
            {!m.ready && <span className="soon">规划中</span>}
          </a>
        ))}
        <div className="who">
          <b>{me.staff.name}</b>
          <span>{me.staff.department_name} · {ROLE_LABEL[me.staff.role]} · {BRANCH_LABEL[me.staff.branch]}</span>
          <span>
            <a href="#/profile">我的资料</a> · <a href="#/password">改密码</a> · <a href="#/" onClick={() => supabase.auth.signOut().then(() => go("/"))}>登出</a>
          </span>
          <LangSwitch />
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
