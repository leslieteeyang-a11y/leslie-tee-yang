// 送货安装 · 我的送货：员工司机登入就看得到派给自己、连结还有效的排单，直接签收（不用点 WhatsApp 里的连结）。
import { useEffect, useState } from "react";
import { dlv, Run } from "../dlv-api";
import { Empty, ErrorBox } from "../ui";
import { DriverSign } from "./DriverSign";

export function MineTab() {
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [pick, setPick] = useState<number | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { dlv.myRuns().then((r) => { setRuns(r); if (r.length) setPick(r[0].id); }).catch((e: Error) => setError(e.message)); }, []);
  if (error) return <ErrorBox error={error} />;
  if (!runs) return <p className="muted">载入中…</p>;
  if (!runs.length) return <Empty>现在没有派给你的送货。店里排好单、选你当司机后就会出现在这里。</Empty>;
  const run = runs.find((r) => r.id === pick) ?? runs[0];
  return (
    <>
      {runs.length > 1 && (
        <div className="toolbar">
          <select value={run.id} onChange={(e) => setPick(Number(e.target.value))}>
            {runs.map((r) => <option key={r.id} value={r.id}>{`${r.run_date} · ${r.stops.length} 站`}</option>)}
          </select>
        </div>
      )}
      {run.token && <DriverSign key={run.id} token={run.token} inApp />}
    </>
  );
}
