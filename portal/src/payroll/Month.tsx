// 薪资 · 每月计算（照原系统「整月批量」）：底薪（月头）/ 佣金（15 号）两种；迟到次数、无薪假天数从打卡与请假自动带入。
import { useCallback, useEffect, useMemo, useState } from "react";
import { Empty, ErrorBox, Modal, Tabs } from "../ui";
import { calcBase, calcComm, inMonth, needsBase, needsComm, PaySettings, r2, workDays } from "./calc";
import { displayName, empOf, MON, money, MonthRow, pay, PayType, slipModel, Slip } from "../pay-api";
import { PrintSlips, sendWhatsApp, SlipView } from "./Slip";

type Inputs = Record<string, string>;
const BASE_KEYS = ["otHours", "unpaidDays", "pcb", "advance", "baseSales", "basePayComm"];
const COMM_KEYS = ["sales", "commGroup", "wrongQty", "lateCount", "otherDeduct"];

export default function Month({ canEdit, set, company }: { canEdit: boolean; set: PaySettings; company: string }) {
  const now = new Date();
  const [y, setY] = useState(now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear());
  const [m, setM] = useState(now.getMonth() === 0 ? 12 : now.getMonth());     // 预设上个月
  const [type, setType] = useState<PayType>("base");
  const [rows, setRows] = useState<MonthRow[] | null>(null);
  const [inp, setInp] = useState<Record<number, Inputs>>({});
  const [wd, setWd] = useState("");
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [slip, setSlip] = useState<{ s: Slip; phone: string } | null>(null);
  const [printing, setPrinting] = useState<Slip[] | null>(null);

  const load = useCallback(() => {
    setRows(null); setError(""); setDirty(false);
    pay.month(y, m).then((d) => {
      setRows(d.rows);
      const next: Record<number, Inputs> = {};
      let w = "";
      for (const r of d.rows) {
        const rec = r.records[type];
        const v: Inputs = {};
        if (rec) {
          for (const [k, x] of Object.entries(rec.inputs)) v[k] = x == null ? "" : String(x);
          if (!w && rec.inputs.workDays) w = String(rec.inputs.workDays);
        } else if (type === "base") {
          if (r.att.unpaid_days) v.unpaidDays = String(r.att.unpaid_days);
          if (r.comm_with_base && r.comm_type === "fixed") v.basePayComm = String(r.comm_rate);
        } else {
          const late = r.att.late_days + r.att.lunch_late_days;
          if (late) v.lateCount = String(late);
        }
        next[r.staff_id] = v;
      }
      setInp(next);
      setWd(w);
    }).catch((e: Error) => setError(e.message));
  }, [y, m, type]);
  useEffect(load, [load]);

  const pool = useMemo(() => (rows || []).filter((r) => {
    const e = empOf(r);
    return (r.records[type] || inMonth(e, y, m)) && (type === "base" ? needsBase(e) : needsComm(e));
  }), [rows, type, y, m]);

  const workd = +wd || workDays(y, m);
  const calc = (r: MonthRow) => {
    const rec = r.records[type];
    const e = empOf(r, rec ? (rec.result as { base: number }).base : null);     // 改旧月份用当时的底薪
    const i = { ...inp[r.staff_id], year: y, month: m, workDays: workd };
    return type === "base" ? calcBase(e, i, set) : calcComm(e, i, set);
  };
  const results = pool.map((r) => ({ r, c: calc(r) }));
  const total = results.reduce((a, { c }) => a + ("net" in c ? c.net : c.payout), 0);
  const er = type === "base" ? results.reduce((a, { c }) => a + ("net" in c ? c.epfEr + c.socsoEr + c.eisEr : 0), 0) : 0;
  const saved = pool.filter((r) => r.records[type]).length;
  const drafts = (rows || []).flatMap((r) => Object.values(r.records)).filter((x) => x && x.status === "draft").length;
  const published = (rows || []).flatMap((r) => Object.values(r.records)).filter((x) => x && x.status === "published").length;

  function edit(id: number, k: string, v: string) {
    setInp((s) => ({ ...s, [id]: { ...s[id], [k]: v } }));
    setDirty(true);
  }
  async function saveAll() {
    setBusy(true); setError(""); setNotice("");
    try {
      const keys = type === "base" ? BASE_KEYS : COMM_KEYS;
      const records = results.map(({ r, c }) => {
        const inputs: Record<string, string | number> = { workDays: workd };
        for (const k of [...keys, "remark"]) if ((inp[r.staff_id] || {})[k] != null && inp[r.staff_id][k] !== "") inputs[k] = inp[r.staff_id][k];
        return { staff_id: r.staff_id, type, inputs, result: c, pay: "net" in c ? c.net : c.payout, remark: inp[r.staff_id]?.remark || "" };
      });
      const n = await pay.save({ year: y, month: m, records });
      setNotice(`已存 ${n} 笔（没有改动的不会重存）。确认没问题后按「发布」，员工才看得到工资单。`);
      load();
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  }
  async function publish(on: boolean) {
    setBusy(true); setError(""); setNotice("");
    try {
      const n = await pay.publish(y, m, on);
      setNotice(on ? `已发布 ${n} 笔，员工可以在「我的工资单」看到。` : `已收回 ${n} 笔。`);
      load();
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  }
  const slipOf = (r: MonthRow) => slipModel(displayName(r), y, m, r.records.base?.result as never, r.records.comm?.result as never);
  const field = (r: MonthRow, k: string, label: string, disabled = false) => (
    <label key={k}>{label}
      <input type="number" inputMode="decimal" step="any" disabled={!canEdit || disabled}
             value={inp[r.staff_id]?.[k] ?? ""} onChange={(e) => edit(r.staff_id, k, e.target.value)} />
    </label>
  );

  return (
    <>
      <div className="filters">
        <Tabs value={type} onChange={(t) => { if (!dirty || confirm("这页还没存，换页会清掉。确定？")) setType(t); }}
              options={[["base", "底薪（月头）"], ["comm", "佣金（15 号）"]]} />
        <select className="pay-mon" value={m} onChange={(e) => setM(+e.target.value)}>{MON.map((n, i) => <option key={i} value={i + 1}>{n}</option>)}</select>
        <input className="num-input" type="number" value={y} onChange={(e) => setY(+e.target.value)} />
        <label className="inline">工作天数<input className="num-input" type="number" step="any" value={wd} placeholder={String(workDays(y, m))}
                                             onChange={(e) => { setWd(e.target.value); setDirty(true); }} disabled={!canEdit} /></label>
      </div>
      <ErrorBox error={error} />
      {notice && <div className="ok">{notice}</div>}
      {!rows ? (!error && <p className="muted">载入中…</p>) : (
        <>
          <div className="pay-totbar">
            <div><span>{`${MON[m - 1]} ${type === "base" ? "底薪实收" : "佣金实发"}合计 · ${pool.length} 人`}</span><b>{money(total)}</b></div>
            {type === "base" && <div><span>雇主 EPF + SOCSO + EIS</span><b>{money(er)}</b></div>}
            <div className="muted small">{`已存 ${saved} / ${pool.length} 人 · 草稿 ${drafts} 笔 · 已发布 ${published} 笔`}</div>
          </div>
          {pool.length === 0 ? <Empty>这个月没有适用的员工。先到「员工薪资资料」填底薪。</Empty> : results.map(({ r, c }) => {
            const rec = r.records[type];
            const bits: string[] = [];
            if ("net" in c) {
              if (c.absentDeduct) bits.push(`未在职 ${c.absentDays} 天 −${money(c.absentDeduct)}`);
              if (c.unpaidDeduct) bits.push(`无薪假 −${money(c.unpaidDeduct)}`);
              if (c.otTotal) bits.push(`加班 +${money(c.otTotal)}`);
              bits.push(`EPF ${money(c.epfEmp)} · SOCSO ${money(c.socsoEmp)} · EIS ${money(c.eisEmp)}`);
            } else {
              if (c.groupVoided) bits.push(`迟到满 ${set.lateNoGroup} 次，团体佣金归零`);
              if (c.lateDeduct) bits.push(`迟到扣 ${money(c.lateDeduct)}`);
              if (c.spill) bits.push(`不够扣，结欠 ${money(c.spill)}`);
            }
            const att = r.att;
            return (
              <section key={r.staff_id} className={"card pay-row" + (rec ? " saved" : "")}>
                <div className="pay-top">
                  <div>
                    <b>{displayName(r)}</b>
                    <div className="muted small">{r.comm_only ? "无底薪" : `底薪 ${money(rec ? (rec.result as { base: number }).base : r.base)}`}
                      {rec && <span className={"ap " + (rec.status === "published" ? "approved" : "pending")}>{rec.status === "published" ? "已发布" : "草稿"}</span>}</div>
                    <div className="muted small">{`打卡：迟到 ${att.late_days} 天 · 午休迟回 ${att.lunch_late_days} 天 · 无薪假 ${att.unpaid_days} 天`}
                      {att.absent_days > 0 && <span className="late">{` · 缺勤 ${att.absent_days} 天（没打卡也没请假，没有自动扣）`}</span>}</div>
                  </div>
                  <div className="pay-amt">{money("net" in c ? c.net : c.payout)}</div>
                </div>
                <div className="pay-in">
                  {type === "base" ? <>
                    {field(r, "otHours", "加班时数")}{field(r, "unpaidDays", "无薪假天")}
                    {field(r, "pcb", "PCB", (+r.base || 0) <= set.pcbThreshold)}{field(r, "advance", "预支（负数 = 补发）")}
                    {r.comm_with_base && (r.comm_type === "percent" ? field(r, "baseSales", `销售额 × ${r.comm_rate}%`) : field(r, "basePayComm", "佣金 RM"))}
                  </> : <>
                    {r.comm_type === "percent" && field(r, "sales", `销售额 × ${r.comm_rate}%`)}
                    {r.group_comm && field(r, "commGroup", "团体佣金")}
                    {field(r, "wrongQty", "包错货（包）")}{field(r, "lateCount", "迟到次数")}{field(r, "otherDeduct", "其他扣（负数 = 补发）")}
                  </>}
                  <label className="wide">备注<input value={inp[r.staff_id]?.remark ?? ""} disabled={!canEdit} maxLength={500}
                                                   onChange={(e) => edit(r.staff_id, "remark", e.target.value)} /></label>
                </div>
                {bits.length > 0 && <div className="muted small">{bits.join(" · ")}</div>}
                {(r.records.base || r.records.comm) && (
                  <div className="actions left"><button className="ghost small-btn" onClick={() => { const s = slipOf(r); if (s) setSlip({ s, phone: r.phone }); }}>工资单</button></div>
                )}
              </section>
            );
          })}
          {canEdit && pool.length > 0 && (
            <div className="card pay-save">
              <button disabled={busy} onClick={saveAll}>{busy ? "处理中…" : `全部存档（${pool.length} 人）`}</button>
              <button className="ghost" disabled={busy || dirty || !drafts} onClick={() => publish(true)}>{`发布（${drafts} 笔草稿）`}</button>
              <button className="ghost" disabled={busy || !published} onClick={() => publish(false)}>收回发布</button>
              <button className="ghost" disabled={!rows.some((r) => r.records.base || r.records.comm)}
                      onClick={() => setPrinting(rows.map(slipOf).filter((s): s is Slip => !!s))}>列印本月全部工资单</button>
              {dirty && <p className="late small">这页有改动还没存。存了才能发布。</p>}
              <p className="muted small">迟到次数（上班迟到 + 午休迟回）和无薪假天数是从打卡、请假带进来的，可以改。已存过的人显示存档时的数字。存档后改动会退回草稿，要重新发布。</p>
            </div>
          )}
        </>
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

export const payOf = (x: { net?: number; payout?: number }) => r2(x.net ?? x.payout ?? 0);
