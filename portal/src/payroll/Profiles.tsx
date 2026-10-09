// 薪资 · 员工薪资资料（照原系统「员工」页的栏位）。到职日在「打卡 → 设定」改，这里只看。
// 离职日 = 员工名单的最后上班日（存的时候资料库一起写 ops.staff.last_day）。
import { FormEvent, useState } from "react";
import { confirmPastLastDay } from "../api";
import { Empty, ErrorBox, Modal } from "../ui";
import { displayName, money, pay, Profile } from "../pay-api";

const CAT_LABEL: Record<Profile["category"], string> = { local: "本地（60 岁以下）", local60: "本地（60 岁以上）", foreign: "外劳" };

export function tags(p: Profile): string[] {
  const t = [CAT_LABEL[p.category]];
  t.push(p.no_epf ? "无 EPF" : "EPF");
  t.push(p.no_socso ? "无 SOCSO" : p.skbbk ? "SOCSO + SKBBK" : "SOCSO");
  t.push(p.no_eis || p.category !== "local" ? "无 EIS" : "EIS");
  if (p.comm_type === "percent") t.push(`佣金 ${p.comm_rate}%`);
  if (p.comm_type === "fixed") t.push(`固定佣金 RM${p.comm_rate}`);
  if (p.group_comm) t.push("团体佣金");
  if (p.comm_only) t.push("只拿佣金");
  if (p.comm_with_base) t.push("佣金月头发");
  return t;
}

export default function Profiles({ rows, canEdit, onChanged }: { rows: Profile[]; canEdit: boolean; onChanged: () => void }) {
  const [open, setOpen] = useState<Profile | null>(null);
  const [q, setQ] = useState("");
  const shown = rows.filter((p) => !q || (p.name + p.pay_name).toLowerCase().includes(q.toLowerCase()));
  const missing = rows.filter((p) => p.active && !p.has_profile).length;
  return (
    <>
      <div className="filters"><input className="search" placeholder="找员工" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      {missing > 0 && <p className="small late">{`${missing} 位在职员工还没填薪资资料，不会出现在每月计算里。`}</p>}
      {shown.length === 0 ? <Empty>没有员工。</Empty> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>员工</th><th className="num">底薪</th><th className="hide-sm">设定</th><th /></tr></thead>
            <tbody>
              {shown.map((p) => (
                <tr key={p.staff_id} className={p.active ? "" : "off"}>
                  <td><b>{displayName(p)}</b>{p.pay_name && <div className="muted small">{p.name}</div>}
                    <div className="muted small">{p.department_name}{!p.active && " · 已停用"}{p.leave_date && ` · 离职 ${p.leave_date}`}</div></td>
                  <td className="num">{p.has_profile ? (p.comm_only ? "无底薪" : money(p.base)) : <span className="late small">未填</span>}</td>
                  <td className="hide-sm small">{p.has_profile && tags(p).join(" · ")}</td>
                  <td>{canEdit && <a href="#" onClick={(e) => { e.preventDefault(); setOpen(p); }}>{p.has_profile ? "修改" : "填写"}</a>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open && <ProfileForm p={open} onClose={() => setOpen(null)} onSaved={() => { setOpen(null); onChanged(); }} />}
    </>
  );
}

function ProfileForm({ p, onClose, onSaved }: { p: Profile; onClose: () => void; onSaved: () => void }) {
  const [v, setV] = useState<Profile>(p);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof Profile>(k: K, x: Profile[K]) => setV({ ...v, [k]: x });
  const chk = (k: "skbbk" | "group_comm" | "comm_only" | "comm_with_base" | "epf_opt_in", label: string) => (
    <label className="check"><input type="checkbox" checked={!!v[k]} onChange={(e) => set(k, e.target.checked)} /> {label}</label>
  );
  const has = (k: "no_epf" | "no_socso" | "no_eis", label: string) => (
    <label className="check"><input type="checkbox" checked={!v[k]} onChange={(e) => set(k, !e.target.checked)} /> {label}</label>
  );
  async function submit(e: FormEvent) {
    e.preventDefault();
    // 离职日选了已经过了的日子：存了之后那个人马上进不了营运系统，先确认
    if (!confirmPastLastDay(p.name, v.leave_date, p.leave_date)) return;
    setBusy(true); setError("");
    try { await pay.saveProfile(v); onSaved(); } catch (err) { setError((err as Error).message); setBusy(false); }
  }
  return (
    <Modal title={`薪资资料：${p.name}`} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <div className="row">
          <label>工资单上的名字（选填）<input value={v.pay_name} onChange={(e) => set("pay_name", e.target.value)} placeholder={p.name} /></label>
          <label>手机（WhatsApp 工资单）<input value={v.phone} onChange={(e) => set("phone", e.target.value)} placeholder="012-3456789" /></label>
        </div>
        <div className="row">
          <label>底薪 RM<input type="number" step="0.01" min="0" value={v.comm_only ? 0 : v.base} disabled={v.comm_only}
                               onChange={(e) => set("base", Number(e.target.value))} /></label>
          <label>类别
            <select value={v.category} onChange={(e) => set("category", e.target.value as Profile["category"])}>
              {Object.entries(CAT_LABEL).map(([k, x]) => <option key={k} value={k}>{x}</option>)}
            </select>
          </label>
        </div>
        <div className="pay-checks">
          {has("no_epf", "缴 EPF")}{has("no_socso", "缴 SOCSO")}{chk("skbbk", "参加 SKBBK")}{has("no_eis", "缴 EIS")}
          {v.category === "foreign" && chk("epf_opt_in", "外劳自愿缴 EPF（11% / 13%）")}
        </div>
        <div className="row">
          <label>个人佣金
            <select value={v.comm_type} onChange={(e) => set("comm_type", e.target.value as Profile["comm_type"])}>
              <option value="none">没有</option><option value="percent">按销售额 %</option><option value="fixed">每月固定金额</option>
            </select>
          </label>
          {v.comm_type !== "none" && (
            <label>{v.comm_type === "percent" ? "抽成 %" : "每月 RM"}<input type="number" step="0.01" min="0" value={v.comm_rate}
                                                                       onChange={(e) => set("comm_rate", Number(e.target.value))} /></label>
          )}
        </div>
        <div className="pay-checks">
          {chk("group_comm", "有团体佣金")}{chk("comm_only", "无底薪、只拿佣金")}{chk("comm_with_base", "佣金跟底薪一起月头发（不是 15 号）")}
        </div>
        <div className="row">
          <label>到职日<input value={p.join_date || "（在「打卡 → 设定」填）"} disabled /></label>
          <label>离职日 = 最后上班日（选填）<input type="date" value={v.leave_date || ""} min={p.join_date || undefined}
                                                  onChange={(e) => set("leave_date", e.target.value || null)} /></label>
        </div>
        {/* 离职日就是员工名单的最后上班日（ops.staff.last_day），这里改了打卡设定也跟着改 */}
        {v.leave_date && <p className="muted small">和「打卡 → 设定」的最后上班日是同一个日期：过了这天员工就进不了营运系统（也看不到「我的工资单」，最后一张请用 WhatsApp 发），隔天自动停用；已经停用的人只有管理员能在「员工与权限」复职。</p>}
        <label>备注<input value={v.note} onChange={(e) => set("note", e.target.value)} /></label>
        <p className="muted small">PCB（月扣税）每月在计算页手动填，底薪超过设定的门槛才开放。到职 / 离职当月会按日历自动扣未在职的天数。</p>
        <ErrorBox error={error} />
        <div className="actions">
          <button type="button" className="ghost" onClick={onClose}>取消</button>
          <button disabled={busy}>{busy ? "储存中…" : "储存"}</button>
        </div>
      </form>
    </Modal>
  );
}
