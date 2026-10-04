// 薪资（HR、管理层）：每月计算、员工薪资资料、历史、设定。路由 #/payroll/<分页>
// 计算规则原样移植自 HR 原本的薪资系统（src/payroll/calc.ts）。
import { useCallback, useEffect, useState } from "react";
import { Me } from "../api";
import { go } from "../router";
import { ErrorBox, Tabs } from "../ui";
import "../att.css";
import "../payroll.css";
import { pay, PayMeta, settingsOf } from "../pay-api";
import Month from "../payroll/Month";
import Profiles from "../payroll/Profiles";
import { History, Settings } from "../payroll/History";

type Tab = "month" | "staff" | "history" | "settings";

export default function Payroll({ sub }: { me: Me; sub?: string }) {
  const [meta, setMeta] = useState<PayMeta | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(() => { pay.meta().then(setMeta).catch((e: Error) => setError(e.message)); }, []);
  useEffect(load, [load]);
  if (!meta) return error ? <ErrorBox error={error} /> : <p className="muted">载入中…</p>;
  const canEdit = meta.level !== "view";
  const tabs: [Tab, string][] = [["month", "每月计算"], ["staff", "员工薪资资料"], ["history", "历史"], ["settings", "设定"]];
  const tab: Tab = tabs.some(([k]) => k === sub) ? (sub as Tab) : "month";
  return (
    <>
      <div className="page-head"><h1>薪资</h1></div>
      <div className="filters"><Tabs value={tab} options={tabs} onChange={(k) => go(`/payroll/${k}`)} /></div>
      {tab === "month" && <Month canEdit={canEdit} set={settingsOf(meta)} company={meta.setting.company} />}
      {tab === "staff" && <Profiles rows={meta.profiles} canEdit={canEdit} onChanged={load} />}
      {tab === "history" && <History profiles={meta.profiles} canEdit={canEdit} company={meta.setting.company} />}
      {tab === "settings" && <Settings company={meta.setting.company} params={meta.setting.params} canEdit={canEdit} onSaved={load} />}
    </>
  );
}
