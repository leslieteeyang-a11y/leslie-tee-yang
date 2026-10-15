// 员工与权限 · 登入纪录（2026-10-15）：每人最后登入 / 最后打开系统、今天 / 近 30 天 / 总共几次；点一个人看最近 100 笔。
// 只有管理员（「员工与权限」）看得到，资料库 ops_login_log 也是同样的检查。
import { useEffect, useState } from "react";
import { BRANCH_LABEL, todayKL } from "../api";
import { Empty, ErrorBox, Modal } from "../ui";
import { LoginLogDetail, LoginLogList, LoginStaffRow, uaLabel, whx } from "../wh-extra-api";
import "../wh-extra.css";

const KIND_LABEL = { login: "登入", open: "打开系统" } as const;
const klFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kuala_Lumpur", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
function klParts(ts: string) {
  return Object.fromEntries(klFmt.formatToParts(new Date(ts)).map((x) => [x.type, x.value])) as Record<string, string>;
}
/** 今天 09:05 / 昨天 18:20 / 10-03 09:05 / 2025-12-30（马来西亚时间） */
function whenShort(ts: string | null, today: string): string {
  if (!ts) return "";
  const p = klParts(ts);
  const day = `${p.year}-${p.month}-${p.day}`;
  const yest = new Date(Date.parse(today + "T00:00:00Z") - 86400000).toISOString().slice(0, 10);
  if (day === today) return `今天 ${p.hour}:${p.minute}`;
  if (day === yest) return `昨天 ${p.hour}:${p.minute}`;
  if (p.year === today.slice(0, 4)) return `${p.month}-${p.day} ${p.hour}:${p.minute}`;
  return day;
}
/** 今年：10-03 09:05；其他年份：2025-12-30 09:05 */
function whenFull(ts: string, today: string): string {
  const p = klParts(ts);
  return p.year === today.slice(0, 4) ? `${p.month}-${p.day} ${p.hour}:${p.minute}` : `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

export default function LoginLog() {
  const [d, setD] = useState<LoginLogList | null>(null);
  const [error, setError] = useState("");
  const [q, setQ] = useState("");
  const [showOff, setShowOff] = useState(false);
  const [open, setOpen] = useState<LoginStaffRow | null>(null);
  useEffect(() => { whx.loginLog().then(setD).catch((e: Error) => setError(e.message)); }, []);

  const today = d?.today || todayKL();
  const active = d ? d.staff.filter((s) => s.active && !s.left) : [];
  const word = q.trim().toLowerCase();
  const rows = d ? d.staff.filter((s) => (showOff || (s.active && !s.left)) && (!word || s.name.toLowerCase().includes(word))) : [];
  // 「从没用过」= 一笔纪录都没有（纪录从这个功能上线才开始记；之前就登入、之后只有「打开系统」的人，最后登入显示 —）
  const summary = `今天 ${active.filter((s) => s.today > 0).length} 人用过 · 近 30 天 ${active.filter((s) => s.d30 > 0).length} 人 · 从没用过 ${active.filter((s) => !s.last_at).length} 人（在职 ${active.length} 人）`;

  return (
    <>
      <p className="muted">每次按登入记一笔；之后每次打开系统也记一笔（同一人 10 分钟内只算一次）。纪录从这个功能上线才开始。只有管理员看得到。</p>
      <ErrorBox error={error} />
      {!d ? (!error && <p className="muted">载入中…</p>) : (
        <>
          <p className="lg-sum">{summary}</p>
          <div className="toolbar">
            <input type="search" placeholder="找员工姓名…" value={q} onChange={(e) => setQ(e.target.value)} />
            <label className="check"><input type="checkbox" checked={showOff} onChange={(e) => setShowOff(e.target.checked)} /> 显示已停用 / 已离职</label>
          </div>
          {rows.length === 0 ? <Empty>没有符合的员工。</Empty> : (
            <div className="table-wrap">
              <table className="lg-table">
                <thead><tr>
                  <th>员工</th><th>最后登入</th><th className="hide-sm">最后打开系统</th>
                  <th className="num">今天</th><th className="num">近 30 天</th><th className="num hide-sm">总共</th>
                </tr></thead>
                <tbody>
                  {rows.map((s) => (
                    <tr key={s.id} className={"click" + (s.active && !s.left ? "" : " inactive")} onClick={() => setOpen(s)}>
                      <td><b>{s.name}</b>
                        {s.left ? <span className="tag">已离职</span> : !s.active && <span className="tag">已停用</span>}
                        <div className="muted small">{[s.department_name || s.department, BRANCH_LABEL[s.branch] || s.branch].join(" · ")}</div></td>
                      <td className="nowrap small">{s.last_login ? whenShort(s.last_login, today) : <span className="muted">{s.last_at ? "—" : "从没用过"}</span>}
                        {s.last_open && <div className="muted show-sm">{`打开 ${whenShort(s.last_open, today)}`}</div>}</td>
                      <td className="nowrap small hide-sm">{s.last_open ? whenShort(s.last_open, today) : <span className="muted">—</span>}</td>
                      <td className={"num" + (s.today > 0 ? " lg-hot" : " muted")}>{s.today}</td>
                      <td className="num">{s.d30}</td>
                      <td className="num hide-sm">{s.total}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      {open && <Detail staff={open} today={today} onClose={() => setOpen(null)} />}
    </>
  );
}

function Detail({ staff, today, onClose }: { staff: LoginStaffRow; today: string; onClose: () => void }) {
  const [d, setD] = useState<LoginLogDetail | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { whx.loginDetail(staff.id).then(setD).catch((e: Error) => setError(e.message)); }, [staff.id]);
  return (
    <Modal title={`登入纪录：${staff.name}`} onClose={onClose} wide>
      <ErrorBox error={error} />
      {!d ? (!error && <p className="muted">载入中…</p>) : d.rows.length === 0 ? <Empty>还没有纪录。</Empty> : (
        <>
          <p className="muted small">{d.rows.length >= 100 ? "最近 100 笔（马来西亚时间）" : `共 ${d.rows.length} 笔（马来西亚时间）`}</p>
          <div className="table-wrap flat lg-detail">
            <table>
              <thead><tr><th>时间</th><th>种类</th><th>装置</th></tr></thead>
              <tbody>
                {d.rows.map((r) => (
                  <tr key={r.id}>
                    <td className="nowrap">{whenFull(r.at, today)}</td>
                    <td><span className={"lg-kind k-" + r.kind}>{KIND_LABEL[r.kind]}</span></td>
                    <td title={r.ua}>{uaLabel(r.ua)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <div className="actions"><button className="ghost" onClick={onClose}>关闭</button></div>
    </Modal>
  );
}
