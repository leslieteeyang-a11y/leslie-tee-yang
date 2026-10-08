// 送货：排单（DO 单号 → 最短路线 → WhatsApp 司机）、排单纪录（签收进度与照片）、我的送货（员工司机签收）、设定。
// 路由 #/delivery/<分页>；司机不用登入的签收页是 #/driver?t=<代码>（App.tsx 在登入前处理）。
// 资料与 BI 顾客资料页的旧送货排单共用（bi.delivery_*），SERVER 每 15 分钟从 AutoCount 只读推 DO 进来。
import { useCallback, useEffect, useRef, useState } from "react";
import { BRANCH_LABEL, Me } from "../api";
import { go } from "../router";
import { fmtAgo } from "../sync";
import { ErrorBox, Tabs } from "../ui";
import { dlv, DlvMeta, Stop, ui } from "../dlv-api";
import { PlanTab } from "../dlv/Plan";
import { RunsTab } from "../dlv/Runs";
import { MineTab } from "../dlv/Mine";
import { SetupTab } from "../dlv/Setup";
import "../att.css";
import "../dlv.css";

type Tab = "plan" | "runs" | "mine" | "setup";
const COMPANY_KEY = "hw-dlv-company";

export default function Delivery({ me, sub }: { me: Me; sub?: string }) {
  const [meta, setMeta] = useState<DlvMeta | null>(null);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [seed, setSeed] = useState<Stop[] | null>(null);   // 从排单纪录载入一趟
  const [company, setCompany] = useState(() => { try { return localStorage.getItem(COMPANY_KEY) || ""; } catch { return ""; } });
  const [myLeft, setMyLeft] = useState<number | null>(null);   // 我是司机：今天还有几站要送
  const planCount = useRef(0);   // 排单分页上排到一半的站数（换分店会清空）
  // 物流部多半「会排单、也当司机」：今天真的有站要送才先开「我的送货」，不然开「排单」。
  // 「还有几站」跟设定一起拿（任何员工都能叫，不是司机就是 0），分页一开始就定好，不会先开排单再自己跳走
  const loadMeta = useCallback(() => {
    setError("");
    Promise.all([dlv.meta(), dlv.home().then((h) => h.my_stops_left).catch(() => 0)])
      .then(([m, left]) => { setMyLeft(left); setMeta(m); })
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(loadMeta, [loadMeta]);
  if (!meta) return error
    ? <><ErrorBox error={error} /><button className="ghost" onClick={loadMeta}>重试</button></>
    : <p className="muted">载入中…</p>;

  const co = meta.companies.includes(company) ? company : meta.companies[0];
  const canEdit = meta.level !== "view";
  const isDriver = meta.drivers.some((d) => d.kind === "staff" && d.id === me.staff.id);
  const tabs: [Tab, string][] = [["plan", canEdit ? "排单" : "查单"], ["runs", "排单纪录"]];
  if (isDriver) tabs.push(["mine", "我的送货"]);
  if (meta.level === "approve") tabs.push(["setup", "设定"]);
  const tab: Tab = tabs.some(([k]) => k === sub) ? (sub as Tab)
    : isDriver && !sub && (!canEdit || (myLeft ?? 0) > 0) ? "mine" : "plan";
  const pick = (c: string) => {
    if (c === co) return;
    if (planCount.current > 0 && !window.confirm(ui("换分店会清空这次排到一半的单，确定吗？"))) return;
    setCompany(c); try { localStorage.setItem(COMPANY_KEY, c); } catch { /* 忽略 */ }
  };

  return (
    <>
      <div className="page-head">
        <h1>送货</h1>
        {meta.companies.length > 1 && tab !== "mine" && (
          <select value={co} onChange={(e) => pick(e.target.value)} className="narrow-select">
            {meta.companies.map((c) => <option key={c} value={c}>{BRANCH_LABEL[c] || c}</option>)}
          </select>
        )}
      </div>
      <p className="muted small sync">
        {"AutoCount DO 更新："}{fmtAgo(meta.synced)}{"（营业时间每 15 分钟同步一次，刚开的 DO 稍等再查）"}
      </p>
      <div className="filters"><Tabs value={tab} options={tabs} onChange={(k) => go(`/delivery/${k}`)} /></div>
      {/* 排单一直挂着、只是藏起来：去「设定」加司机 / 出发点再回来，排到一半的单还在 */}
      <div hidden={tab !== "plan"}>
        <PlanTab meta={meta} company={co} readOnly={!canEdit} onSent={() => setReload((n) => n + 1)}
                 seed={seed} onSeedUsed={() => setSeed(null)} onCount={(n) => { planCount.current = n; }} />
      </div>
      {tab === "runs" && (
        <RunsTab company={co} canEdit={canEdit} reloadKey={reload}
                 onLoad={(stops) => { setSeed(stops); go("/delivery/plan"); }} />
      )}
      {tab === "mine" && <MineTab />}
      {tab === "setup" && <SetupTab meta={meta} company={co} onChanged={loadMeta} />}
    </>
  );
}
