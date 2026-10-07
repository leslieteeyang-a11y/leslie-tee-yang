// 人事 · 资料缺漏：在职员工没填到职日 / 性别 / 手机 / 薪资资料、分店没有打卡点、接下来 60 天没有假日。
import { useEffect, useState } from "react";
import { BRANCH_LABEL } from "../api";
import { supabase } from "../supabase";
import { Empty, ErrorBox } from "../ui";

interface Gaps {
  staff: { id: number; name: string; branch: string; department_name: string; missing: string[] }[];
  no_fence: string[]; holidays_ahead: number; last_holiday: string | null;
}
const MISSING: Record<string, [string, string]> = {
  join_date: ["到职日", "#/attendance/settings"], gender: ["性别", "#/attendance/settings"],
  phone: ["手机", "#/admin"], pay: ["薪资资料", "#/payroll/staff"],
};

export default function HrGaps() {
  const [g, setG] = useState<Gaps | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    supabase.rpc("ops_hr_gaps").then(({ data, error: e }) => (e ? setError(e.message) : setG(data as Gaps)));
  }, []);
  if (!g) return error ? <ErrorBox error={error} /> : <p className="muted">载入中…</p>;
  const nothing = !g.staff.length && !g.no_fence.length && g.holidays_ahead > 0;
  return (
    <>
      {nothing && <Empty>资料都齐了。</Empty>}
      {g.no_fence.map((b) => (
        <p key={b} className="late">{`${BRANCH_LABEL[b] || b} 还没有打卡点，员工打不了卡。`} <a href="#/attendance/settings">去设定 →</a></p>
      ))}
      {g.holidays_ahead === 0 && (
        <p className="late">{`接下来 60 天没有设公共假日${g.last_holiday ? `（最后一个是 ${g.last_holiday}）` : ""}，假日会被当成缺勤。`}{" "}
          <a href="#/attendance/settings">去「一键带入公共假日」→</a></p>
      )}
      {g.staff.length > 0 && (
        <>
          <h2 className="section-title">{`员工资料没填齐（${g.staff.length} 人）`}</h2>
          <div className="table-wrap">
            <table>
              <thead><tr><th>员工</th><th>还没填</th></tr></thead>
              <tbody>
                {g.staff.map((s) => (
                  <tr key={s.id}>
                    <td><b>{s.name}</b><div className="muted small">{`${s.department_name} · ${BRANCH_LABEL[s.branch] || s.branch}`}</div></td>
                    <td>{s.missing.map((m, i) => (
                      <span key={m}>{i > 0 && " · "}<a href={MISSING[m]?.[1] ?? "#"}>{MISSING[m]?.[0] ?? m}</a></span>
                    ))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted small">到职日决定年假、病假天数；性别决定产假 / 陪产假；手机用来 WhatsApp 工资单；没有薪资资料的人不会出现在每月薪资计算。</p>
        </>
      )}
    </>
  );
}
