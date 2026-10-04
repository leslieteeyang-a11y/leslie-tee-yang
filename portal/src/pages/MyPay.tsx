// 我的工资单（每位员工）：只看得到 HR 已发布的自己的工资单。路由 #/mypay
import { useEffect, useState } from "react";
import { Empty, ErrorBox, Modal } from "../ui";
import "../payroll.css";
import { MON, money, pay, PayRecord, Slip, slipFromRecords } from "../pay-api";
import { PrintSlips, SlipView } from "../payroll/Slip";

export default function MyPay() {
  const [data, setData] = useState<{ company: string; records: PayRecord[] } | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<Slip | null>(null);
  const [printing, setPrinting] = useState<Slip[] | null>(null);
  useEffect(() => { pay.my().then(setData).catch((e: Error) => setError(e.message)); }, []);
  if (!data) return error ? <ErrorBox error={error} /> : <p className="muted">载入中…</p>;
  const months = [...new Set(data.records.map((r) => `${r.year}-${r.month}`))].map((k) => {
    const [y, m] = k.split("-").map(Number);
    const recs = data.records.filter((r) => r.year === y && r.month === m);
    return { y, m, recs, s: slipFromRecords(recs[0].name, y, m, recs) };
  });
  return (
    <>
      <h1>我的工资单</h1>
      {months.length === 0 ? <Empty>还没有工资单。HR 发布后会出现在这里。</Empty> : (
        <ul className="list card">
          {months.map(({ y, m, recs, s }) => (
            <li key={`${y}-${m}`} className="click" onClick={() => s && setOpen(s)}>
              <span><b>{`${y} ${MON[m - 1]}`}</b>{" "}<span className="muted small">{recs.map((r) => r.type === "base" ? "底薪" : "佣金").join(" + ")}</span></span>
              <span className="nowrap">{money(recs.reduce((a, r) => a + +r.pay, 0))}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="muted small">有问题请找 HR。</p>
      {open && (
        <Modal title="工资单" onClose={() => setOpen(null)} wide>
          <SlipView s={open} company={data.company} />
          <div className="actions"><button onClick={() => setPrinting([open])}>列印 / 存成 PDF</button></div>
        </Modal>
      )}
      {printing && <PrintSlips slips={printing} company={data.company} onDone={() => setPrinting(null)} />}
    </>
  );
}
