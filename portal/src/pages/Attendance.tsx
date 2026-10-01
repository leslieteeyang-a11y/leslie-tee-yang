// 打卡模块：打卡 / 我的纪录 / 补卡 / 团队（主管、HR）/ 设定（HR）。路由 #/attendance/<分页>
import { useCallback, useState } from "react";
import { can, Me } from "../api";
import { go } from "../router";
import { Tabs } from "../ui";
import "../att.css";
import Today from "../att/Today";
import { DaysTable, MonthReport } from "../att/Records";
import Corrections from "../att/Corrections";
import Board from "../att/Board";
import Settings from "../att/Settings";

type Tab = "today" | "records" | "corrections" | "team" | "month" | "settings";

export default function Attendance({ me, sub }: { me: Me; sub?: string }) {
  const isHr = can(me, "hr", "edit");
  const isLead = isHr || can(me, "attendance", "approve");
  const tabs: [Tab, string][] = [["today", "打卡"], ["records", "我的纪录"], ["corrections", "补卡"]];
  if (isLead) tabs.push(["team", "团队今天"], ["month", "月报"]);
  if (isHr) tabs.push(["settings", "设定"]);
  const tab: Tab = tabs.some(([k]) => k === sub) ? (sub as Tab) : "today";
  const [startDate, setStartDate] = useState<string | null>(null);
  const started = useCallback(() => setStartDate(null), []);

  return (
    <>
      <div className="page-head"><h1>打卡</h1></div>
      <div className="filters"><Tabs value={tab} options={tabs} onChange={(k) => go(`/attendance/${k}`)} /></div>
      {tab === "today" && <Today me={me} />}
      {tab === "records" && <DaysTable onCorrect={(d) => { setStartDate(d); go("/attendance/corrections"); }} />}
      {tab === "corrections" && <Corrections me={me} isLead={isLead} isHr={isHr} startDate={startDate} onStarted={started} />}
      {tab === "team" && <Board />}
      {tab === "month" && <MonthReport />}
      {tab === "settings" && <Settings me={me} />}
    </>
  );
}
