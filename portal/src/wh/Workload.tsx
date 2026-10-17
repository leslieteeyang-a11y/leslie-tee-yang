// 每人工作量（仓库把关 2026-10-17，仓库可审批）：点货、拣货、核对、上架、装车、出车各几件，平均时间，核对不符次数。
// 给主管每周看：谁做得多、谁常被核对出错（错的次数算在拣货的人身上）。
import { useCallback, useEffect, useState } from "react";
import { fmtQty, todayKL } from "../api";
import { Empty, ErrorBox } from "../ui";
import { gate, WorkRow } from "../wh-gate-api";

const shift = (d: string, n: number) => {
  const t = new Date(d + "T00:00:00Z");
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};
const mins = (m: number | null) => (m == null ? "—" : m >= 60 ? `${Math.floor(m / 60)} 小时 ${m % 60} 分` : `${m} 分`);

export function WorkloadTab({ company }: { company: string }) {
  const [to, setTo] = useState(todayKL());
  const [from, setFrom] = useState(shift(todayKL(), -6));
  const [rows, setRows] = useState<WorkRow[] | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(() => {
    setError("");
    gate.workload(company, from, to).then((r) => setRows(r.rows)).catch((e: Error) => setError(e.message));
  }, [company, from, to]);
  useEffect(() => { setRows(null); load(); }, [load]);
  const week = (n: number) => { const t = shift(todayKL(), -7 * n); setTo(t); setFrom(shift(t, -6)); };

  return (
    <>
      <div className="toolbar gate-work-bar">
        <label>从<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label>到<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <button className="ghost small" onClick={() => week(0)}>近 7 天</button>
        <button className="ghost small" onClick={() => week(1)}>上一周</button>
      </div>
      <p className="muted small">平均时间：点货 = 按「我来」到点完；拣货 = 开始拣到「已拣好」（超过 8 小时的不算）。核对不符算在拣货的人身上。</p>
      <ErrorBox error={error} />
      {rows === null ? (!error && <p className="muted">载入中…</p>) : !rows.length ? <Empty>这段时间没有纪录。</Empty> : (
        <div className="table-wrap">
          <table className="gate-work">
            <thead>
              <tr>
                <th>同事</th><th className="num">点货（张 / 型号）</th><th className="num">点货平均</th>
                <th className="num">拣货（张 / 行）</th><th className="num">拣货平均</th><th className="num">核对不符</th>
                <th className="num">撤销扫码</th><th className="num">帮人核对</th><th className="num">上架（笔 / 件）</th>
                <th className="num">装车</th><th className="num">出车</th><th className="num">点货复核</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.staff_id}>
                  <td className="nowrap"><b>{r.name}</b></td>
                  <td className="num">{`${r.recv_dos} / ${r.recv_lines}`}</td>
                  <td className="num">{mins(r.recv_min)}</td>
                  <td className="num">{`${r.picks} / ${r.pick_lines}`}</td>
                  <td className="num">{mins(r.pick_min)}</td>
                  <td className={"num" + (r.pick_fails ? " late" : "")}>{r.pick_fails}</td>
                  <td className="num">{r.undo}</td>
                  <td className="num">{r.checks}</td>
                  <td className="num">{`${r.put_n} / ${fmtQty(r.put_qty)}`}</td>
                  <td className="num">{r.loads}</td>
                  <td className="num">{r.departs}</td>
                  <td className="num">{r.reviews}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
