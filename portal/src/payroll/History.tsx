// 薪资 · 历史（按年 / 月 / 员工查、汇出 CSV、看工资单）与设定（公司名称、参数）。
import { FormEvent, useCallback, useEffect, useState } from "react";
import { Empty, ErrorBox, Modal } from "../ui";
import { DEF_SET, PaySettings, r2 } from "./calc";
import { displayName, MON, money, pay, PayRecord, Profile, slipFromRecords, Slip } from "../pay-api";
import { PrintSlips, sendWhatsApp, SlipView } from "./Slip";

const COLS: [string, string][] = [["底薪", "base"], ["工作天", "workDays"], ["加班时数", "otHours"], ["加班", "otTotal"],
  ["未在职天", "absentDays"], ["未在职扣除", "absentDeduct"], ["无薪假天", "unpaidDays"], ["无薪假扣除", "unpaidDeduct"],
  ["法定薪金", "statWage"], ["EPF员工", "epfEmp"], ["EPF雇主", "epfEr"], ["SOCSO员工", "socsoEmp"], ["SOCSO雇主", "socsoEr"],
  ["EIS员工", "eisEmp"], ["EIS雇主", "eisEr"], ["PCB", "pcb"], ["预支", "advance"], ["月头佣金", "payComm"], ["底薪实收", "net"],
  ["销售额", "sales"], ["个人佣金", "commPersonal"], ["团体佣金", "commGroup"], ["包错货数", "wrongQty"], ["包错货扣", "wrongGoods"],
  ["迟到次数", "lateCount"], ["迟到扣", "lateDeduct"], ["其他扣款", "otherDeduct"], ["补发", "extraPay"], ["结欠", "spill"], ["佣金实发", "payout"]];

export function History({ profiles, canEdit, company }: { profiles: Profile[]; canEdit: boolean; company: string }) {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState("");
  const [sid, setSid] = useState("");
  const [rows, setRows] = useState<PayRecord[] | null>(null);
  const [error, setError] = useState("");
  const [slip, setSlip] = useState<{ s: Slip; phone: string } | null>(null);
  const [printing, setPrinting] = useState<Slip[] | null>(null);
  const load = useCallback(() => {
    setRows(null); setError("");
    pay.history({ year, month, staff_id: sid }).then(setRows).catch((e: Error) => setError(e.message));
  }, [year, month, sid]);
  useEffect(load, [load]);
  const phoneOf = (id: number) => profiles.find((p) => p.staff_id === id)?.phone || "";
  const slipOf = (r: PayRecord) => slipFromRecords(r.name, r.year, r.month,
    (rows || []).filter((x) => x.staff_id === r.staff_id && x.year === r.year && x.month === r.month));
  const sorted = [...(rows || [])].sort((a, b) => b.year - a.year || b.month - a.month || a.name.localeCompare(b.name) || a.type.localeCompare(b.type));
  const sum = sorted.reduce((a, r) => a + +r.pay, 0);

  function csv() {
    const used = COLS.filter(([, k]) => sorted.some((r) => +((r.result as unknown as Record<string, number>)[k] || 0) !== 0));
    const head = ["序号", "员工", "实收金额", "种类", "年", "月", ...used.map(([h]) => h), "状态", "备注"];
    const lines = sorted.map((r, i) => [i + 1, r.name, r2(+r.pay), r.type === "base" ? "底薪" : "佣金", r.year, r.month,
      ...used.map(([, k]) => (r.result as unknown as Record<string, number>)[k] ?? ""), r.status === "published" ? "已发布" : "草稿", r.remark]);
    lines.push(["", "合计", r2(sum)]);
    const text = [head, ...lines].map((l) => l.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\r\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(["﻿" + text], { type: "text/csv;charset=utf-8" }));
    a.download = `薪资记录_${year}${month ? "年" + String(month).padStart(2, "0") + "月" : "年"}.csv`;
    a.click();
  }
  async function remove(r: PayRecord) {
    if (!confirm(`删除 ${r.name} ${r.year}/${r.month} 的${r.type === "base" ? "底薪" : "佣金"}记录？`)) return;
    try { await pay.remove(r.id); load(); } catch (e) { setError((e as Error).message); }
  }

  return (
    <>
      <div className="filters">
        <input className="num-input" type="number" value={year} onChange={(e) => setYear(+e.target.value)} />
        <select className="pay-mon" value={month} onChange={(e) => setMonth(e.target.value)}>
          <option value="">全年</option>{MON.map((n, i) => <option key={i} value={i + 1}>{n}</option>)}
        </select>
        <select className="pay-mon" value={sid} onChange={(e) => setSid(e.target.value)}>
          <option value="">全部员工</option>{profiles.filter((p) => p.has_profile).map((p) => <option key={p.staff_id} value={p.staff_id}>{displayName(p)}</option>)}
        </select>
        <button className="ghost" disabled={!sorted.length} onClick={csv}>下载 CSV（Excel）</button>
      </div>
      <ErrorBox error={error} />
      {!rows ? (!error && <p className="muted">载入中…</p>) : sorted.length === 0 ? <Empty>没有记录。</Empty> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>员工</th><th>月份</th><th>种类</th><th className="num">实收</th><th>状态</th><th /></tr></thead>
            <tbody>
              {sorted.map((r) => (
                <tr key={r.id}>
                  <td><b>{r.name}</b>{r.remark && <div className="muted small">{r.remark}</div>}</td>
                  <td className="nowrap">{`${r.year} / ${r.month}`}</td>
                  <td>{r.type === "base" ? "底薪" : "佣金"}</td>
                  <td className="num">{money(r.pay)}</td>
                  <td><span className={"ap " + (r.status === "published" ? "approved" : "pending")}>{r.status === "published" ? "已发布" : "草稿"}</span></td>
                  <td className="nowrap">
                    <a href="#" onClick={(e) => { e.preventDefault(); const s = slipOf(r); if (s) setSlip({ s, phone: phoneOf(r.staff_id) }); }}>工资单</a>
                    {canEdit && <>{" · "}<a href="#" className="danger" onClick={(e) => { e.preventDefault(); remove(r); }}>删除</a></>}
                  </td>
                </tr>
              ))}
              <tr className="total"><td>合计</td><td /><td /><td className="num">{money(sum)}</td><td /><td /></tr>
            </tbody>
          </table>
        </div>
      )}
      {slip && (
        <Modal title="工资单" onClose={() => setSlip(null)} wide>
          <SlipView s={slip.s} company={company} />
          <div className="actions">
            <button className="ghost" onClick={() => { const err = sendWhatsApp(slip.s, company, slip.phone); if (err) alert(err); }}>WhatsApp 发给员工</button>
            <button onClick={() => setPrinting([slip.s])}>列印 / 存成 PDF</button>
          </div>
        </Modal>
      )}
      {printing && <PrintSlips slips={printing} company={company} onDone={() => setPrinting(null)} />}
    </>
  );
}

const PARAMS: [keyof PaySettings, string][] = [
  ["epfEmpLocal", "EPF 员工 %（本地）"], ["epfErLow", "EPF 雇主 %（薪金 ≤ 门槛）"], ["epfErHigh", "EPF 雇主 %（薪金 > 门槛）"],
  ["epfErThreshold", "EPF 雇主门槛 RM"], ["epfEmp60", "EPF 员工 %（60 岁以上）"], ["epfEr60", "EPF 雇主 %（60 岁以上）"],
  ["epfForeignErFlat", "外劳雇主 EPF 固定 RM"], ["pcbThreshold", "底薪超过多少才填 PCB"], ["wrongGoodsRate", "包错货每包扣 RM"],
  ["lateUnit", "迟到几次扣一次"], ["lateFraction", "每次扣几天（0.5 = 半天）"], ["lateNoGroup", "迟到几次团体佣金归零"],
];

export function Settings({ company, params, canEdit, onSaved }: {
  company: string; params: Partial<PaySettings>; canEdit: boolean; onSaved: () => void;
}) {
  const [co, setCo] = useState(company);
  const [v, setV] = useState<PaySettings>({ ...DEF_SET, ...params });
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(""); setNotice("");
    try {
      const changed: Partial<PaySettings> = {};
      for (const [k] of PARAMS) if (v[k] !== DEF_SET[k]) changed[k] = Number(v[k]);
      await pay.saveSetting({ company: co, params: changed });
      setNotice("已储存。");
      onSaved();
    } catch (err) { setError((err as Error).message); }
    setBusy(false);
  }
  return (
    <form className="form card" onSubmit={submit}>
      <label>公司名称（印在工资单上）<input value={co} onChange={(e) => setCo(e.target.value)} disabled={!canEdit} /></label>
      <div className="pay-params">
        {PARAMS.map(([k, label]) => (
          <label key={k}>{label}<input type="number" step="any" min="0" value={v[k]} disabled={!canEdit}
                                       onChange={(e) => setV({ ...v, [k]: Number(e.target.value) })} /></label>
        ))}
      </div>
      <p className="muted small">SOCSO / EIS 照官方缴费表（2026 年 6 月生效），EPF 照第三附表，不在这里改。改了参数只影响之后存档的记录，旧的记录不会变。</p>
      <ErrorBox error={error} />
      {notice && <div className="ok">{notice}</div>}
      {canEdit && <div className="actions"><button disabled={busy}>{busy ? "储存中…" : "储存"}</button></div>}
    </form>
  );
}
