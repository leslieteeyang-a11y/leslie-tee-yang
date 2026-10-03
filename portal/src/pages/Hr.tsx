// 人事（HR）：请假审批、请假纪录、假期余额（含调整、代填）、假别设定。打卡设定仍在「打卡 → 设定」。
// 路由 #/hr/<分页>
import { FormEvent, useCallback, useEffect, useState } from "react";
import { can, Me } from "../api";
import { go } from "../router";
import { Empty, ErrorBox, Modal, Tabs } from "../ui";
import "../att.css";
import "../leave.css";
import { MonthPicker } from "../att/Records";
import { thisMonth } from "../att-api";
import {
  Balance, daysLabel, leave, LeaveRequest, LeaveType, StaffBalances,
} from "../leave-api";
import { BalanceCards, LeaveDetail, LeaveForm, LeaveTable } from "./Leave";

type Tab = "todo" | "records" | "balances" | "types";

export default function Hr({ me, sub }: { me: Me; sub?: string }) {
  const canEdit = can(me, "hr", "edit");
  const tabs: [Tab, string][] = [["todo", "请假审核"], ["records", "请假纪录"], ["balances", "假期余额"], ["types", "假别设定"]];
  const tab: Tab = tabs.some(([k]) => k === sub) ? (sub as Tab) : "todo";
  return (
    <>
      <div className="page-head">
        <h1>人事</h1>
        {can(me, "hr", "edit") && <a href="#/attendance/settings" className="small">打卡设定（班别、打卡点、员工资料）→</a>}
      </div>
      <div className="filters"><Tabs value={tab} options={tabs} onChange={(k) => go(`/hr/${k}`)} /></div>
      {tab === "todo" && <Requests scope="todo" />}
      {tab === "records" && <Requests scope="all" />}
      {tab === "balances" && <Balances me={me} canEdit={canEdit} />}
      {tab === "types" && <Types canEdit={can(me, "hr", "approve")} />}
    </>
  );
}

function Requests({ scope }: { scope: "todo" | "all" }) {
  const [ym, setYm] = useState(thisMonth());
  const [rows, setRows] = useState<LeaveRequest[] | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<LeaveRequest | null>(null);

  const load = useCallback(() => {
    setRows(null);
    setError("");
    leave.list(scope === "todo" ? { scope } : { scope, ym }).then(setRows).catch((e: Error) => setError(e.message));
  }, [scope, ym]);
  useEffect(load, [load]);

  return (
    <>
      {scope === "all" && <div className="filters"><MonthPicker ym={ym} onChange={setYm} /></div>}
      <ErrorBox error={error} />
      {!rows ? (!error && <p className="muted">载入中…</p>)
        : <LeaveTable rows={rows} onOpen={setOpen} showStaff
                      empty={scope === "todo" ? "没有等你审核的请假。" : "这个月没有请假纪录。"} />}
      {open && <LeaveDetail r={open} onClose={() => setOpen(null)} onChanged={() => { setOpen(null); load(); }} />}
    </>
  );
}

function Balances({ me, canEdit }: { me: Me; canEdit: boolean }) {
  const thisYear = Number(thisMonth().slice(0, 4));
  const [year, setYear] = useState(thisYear);
  const [rows, setRows] = useState<StaffBalances[] | null>(null);
  const [types, setTypes] = useState<LeaveType[]>([]);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<StaffBalances | null>(null);
  const [q, setQ] = useState("");

  const load = useCallback(() => {
    setError("");
    leave.balances(year).then((d) => {
      setRows(d.rows);
      setOpen((o) => (o ? d.rows.find((r) => r.staff_id === o.staff_id) || null : null));
    }).catch((e: Error) => setError(e.message));
  }, [year]);
  useEffect(load, [load]);
  useEffect(() => { leave.types().then(setTypes).catch(() => {}); }, []);

  const pick = (b: Balance[], code: string) => b.find((x) => x.type === code);
  const shown = (rows || []).filter((r) => !q || r.name.toLowerCase().includes(q.toLowerCase()));

  return (
    <>
      <div className="filters">
        <div className="month-pick">
          <button className="ghost" onClick={() => setYear(year - 1)} aria-label="上一年">‹</button>
          <b>{year}</b>
          <button className="ghost" disabled={year > thisYear} onClick={() => setYear(year + 1)} aria-label="下一年">›</button>
        </div>
        <input className="search" placeholder="找员工" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <ErrorBox error={error} />
      {!rows ? (!error && <p className="muted">载入中…</p>) : shown.length === 0 ? <Empty>没有员工。</Empty> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>员工</th><th className="num">年资</th><th className="num">年假剩</th><th className="num">病假剩</th><th className="num hide-sm">无薪假已用</th></tr></thead>
            <tbody>
              {shown.map((r) => {
                const al = pick(r.balances, "annual"), sl = pick(r.balances, "sick"), ul = pick(r.balances, "unpaid");
                return (
                  <tr key={r.staff_id} className="click" onClick={() => setOpen(r)}>
                    <td><b>{r.name}</b><div className="muted small">{r.department_name}</div></td>
                    <td className="num">{r.join_date ? `${r.years} 年` : <span className="late small">没填到职日</span>}</td>
                    <td className="num">{al ? daysLabel(al.balance) : "—"}</td>
                    <td className="num">{sl ? daysLabel(sl.balance) : "—"}</td>
                    <td className="num hide-sm">{ul ? daysLabel(ul.used) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted small">年假：未满 2 年 8 天、2–5 年 12 天、5 年以上 16 天（到职那年按月比例）；病假：14 / 18 / 22 天（劳工法）。剩余 = 应得 + 调整 − 已批 − 审核中。点员工可以调整或帮他请假。</p>
      {open && <StaffLeave me={me} s={open} year={year} types={types} canEdit={canEdit}
                           onClose={() => setOpen(null)} onChanged={load} />}
    </>
  );
}

function StaffLeave({ me, s, year, types, canEdit, onClose, onChanged }: {
  me: Me; s: StaffBalances; year: number; types: LeaveType[]; canEdit: boolean; onClose: () => void; onChanged: () => void;
}) {
  const [adjusting, setAdjusting] = useState(false);
  const [filing, setFiling] = useState(false);
  const [notice, setNotice] = useState("");
  const typeName = (c: string) => types.find((t) => t.code === c)?.name || c;
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kuala_Lumpur" }).format(new Date());
  const usable = types.filter((t) => t.active && (!t.gender || !s.gender || t.gender === s.gender));

  return (
    <Modal title={`${s.name} · ${year}`} onClose={onClose} wide>
      <p className="muted small">
        {s.join_date ? <><span>{`到职 ${s.join_date}`}</span>{" · "}<span>{`年资 ${s.years} 年`}</span></> : "没填到职日（年假 / 病假先按第一年算）"}
        {" · "}<span>{s.gender === "F" ? "女" : s.gender === "M" ? "男" : "性别未填"}</span>
      </p>
      {notice && <div className="ok">{notice}</div>}
      <BalanceCards balances={s.balances} />
      {s.adjustments.length > 0 && (
        <>
          <h3>调整纪录</h3>
          <ul className="list">
            {s.adjustments.map((a) => (
              <li key={a.id}>
                <span>{`${typeName(a.type)} ${a.days > 0 ? "+" : ""}${daysLabel(a.days)} 天`}<span className="muted">{" · "}{a.note}</span></span>
                <span className="muted small">{a.by}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {canEdit && (
        <div className="actions left">
          <button className="ghost" onClick={() => setAdjusting(true)}>调整天数</button>
          <button onClick={() => setFiling(true)}>帮他请假</button>
        </div>
      )}
      {adjusting && (
        <AdjustForm staffId={s.staff_id} year={year} types={types.filter((t) => t.rule !== "none")}
                    onClose={() => setAdjusting(false)}
                    onSaved={() => { setAdjusting(false); setNotice("已调整。"); onChanged(); }} />
      )}
      {filing && (
        <LeaveForm me={me} types={usable} today={today} balances={s.balances} staff={{ id: s.staff_id, name: s.name }}
                   onClose={() => setFiling(false)}
                   onSaved={(r) => { setFiling(false); setNotice(`已登记：${r.type_name} ${daysLabel(r.days)} 天，请到「请假审核」批准。`); onChanged(); }} />
      )}
    </Modal>
  );
}

function AdjustForm({ staffId, year, types, onClose, onSaved }: {
  staffId: number; year: number; types: LeaveType[]; onClose: () => void; onSaved: () => void;
}) {
  const [type, setType] = useState(types[0]?.code || "annual");
  const [days, setDays] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await leave.adjust({ staff_id: staffId, year, type, days, note });
      onSaved();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }
  return (
    <Modal title={`调整 ${year} 年假期`} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <div className="row">
          <label>假别
            <select value={type} onChange={(e) => setType(e.target.value)}>
              {types.map((t) => <option key={t.code} value={t.code}>{t.name}</option>)}
            </select>
          </label>
          <label>天数（加用正数、扣用负数）<input type="number" step="0.5" value={days} onChange={(e) => setDays(e.target.value)} required /></label>
        </div>
        <label>原因<input value={note} onChange={(e) => setNote(e.target.value)} required placeholder="例：2025 年结转 3 天 / 系统上线前已休 2 天" /></label>
        <p className="muted small">上年没休完要带过来、系统上线前已经休的天数，都在这里调整。每一笔都会留纪录。</p>
        <ErrorBox error={error} />
        <div className="actions">
          <button type="button" className="ghost" onClick={onClose}>取消</button>
          <button disabled={busy}>{busy ? "储存中…" : "储存"}</button>
        </div>
      </form>
    </Modal>
  );
}

const RULE_LABEL: Record<LeaveType["rule"], string> = {
  annual: "劳工法（按年资）", sick: "劳工法（按年资）", fixed: "每年固定天数", none: "不设余额",
};

function Types({ canEdit }: { canEdit: boolean }) {
  const [rows, setRows] = useState<LeaveType[] | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<LeaveType | null>(null);
  const load = useCallback(() => { leave.types().then(setRows).catch((e: Error) => setError(e.message)); }, []);
  useEffect(load, [load]);
  return (
    <>
      <ErrorBox error={error} />
      {!rows ? (!error && <p className="muted">载入中…</p>) : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>假别</th><th>天数</th><th className="hide-sm">规则</th><th className="hide-sm">说明</th><th></th></tr></thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.code} className={t.active ? "" : "off"}>
                  <td><b>{t.name}</b>{!t.active && <span className="muted small">{" · 停用"}</span>}</td>
                  <td>{t.rule === "annual" ? "8 / 12 / 16" : t.rule === "sick" ? "14 / 18 / 22"
                       : t.rule === "none" ? (Number(t.days) > 0 ? `每次最多 ${daysLabel(t.days)}` : "不限") : daysLabel(t.days)}</td>
                  <td className="hide-sm small">{RULE_LABEL[t.rule]}{t.half_day ? " · 可请半天" : ""}{t.calendar_days ? " · 日历天" : ""}{t.need_attachment ? " · 要附证明" : ""}</td>
                  <td className="hide-sm small muted">{t.note}</td>
                  <td>{canEdit && <a href="#" onClick={(e) => { e.preventDefault(); setOpen(t); }}>修改</a>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!canEdit && <p className="muted small">只有人事「可审批」的人能改假别。</p>}
      {open && <TypeForm t={open} onClose={() => setOpen(null)} onSaved={() => { setOpen(null); load(); }} />}
    </>
  );
}

function TypeForm({ t, onClose, onSaved }: { t: LeaveType; onClose: () => void; onSaved: () => void }) {
  const [v, setV] = useState(t);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await leave.saveType({ code: v.code, name: v.name, days: v.days, half_day: v.half_day,
                             need_attachment: v.need_attachment, active: v.active, note: v.note });
      onSaved();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }
  return (
    <Modal title={`假别：${t.name}`} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label>名称<input value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} required /></label>
        {(t.rule === "fixed" || t.rule === "none") && (
          <label>{t.rule === "fixed" ? "每年天数" : "每次最多几天（0 = 不限）"}
            <input type="number" step="0.5" min="0" value={v.days} onChange={(e) => setV({ ...v, days: Number(e.target.value) })} />
          </label>
        )}
        {(t.rule === "annual" || t.rule === "sick") && <p className="muted small">天数按劳工法与年资自动计算，不能在这里改；个别员工可在「假期余额」调整。</p>}
        <label>说明（员工申请时看得到）<input value={v.note} onChange={(e) => setV({ ...v, note: e.target.value })} /></label>
        <label className="check"><input type="checkbox" checked={v.half_day} onChange={(e) => setV({ ...v, half_day: e.target.checked })} /> 可以请半天</label>
        <label className="check"><input type="checkbox" checked={v.need_attachment} onChange={(e) => setV({ ...v, need_attachment: e.target.checked })} /> 一定要附证明</label>
        <label className="check"><input type="checkbox" checked={!!v.active} onChange={(e) => setV({ ...v, active: e.target.checked })} /> 启用</label>
        <ErrorBox error={error} />
        <div className="actions">
          <button type="button" className="ghost" onClick={onClose}>取消</button>
          <button disabled={busy}>{busy ? "储存中…" : "储存"}</button>
        </div>
      </form>
    </Modal>
  );
}
