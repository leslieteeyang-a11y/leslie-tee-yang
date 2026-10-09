// 我的资料（每位员工）：身份证 / 护照、生日、地址、紧急联络人、银行户口。路由 #/profile
// 表单 ProfileForm 也给人事「员工档案」用（HR 改员工的资料）。权限都在资料库检查：
// 银行两栏只有本人与管理薪资的人拿得到（can_bank = false 时回传里根本没有这两栏，也不能送）。
import { FormEvent, useEffect, useState } from "react";
import { api, BRANCH_LABEL, fmtDate, PROFILE_MISSING_LABEL, StaffProfile } from "../api";
import { ErrorBox } from "../ui";

const todayKL = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kuala_Lumpur" }).format(new Date());

/** MyKad 边打边排：只留数字、最多 12 位，排成 YYMMDD-PB-#### */
export function fmtMykad(s: string): string {
  const d = s.replace(/\D/g, "").slice(0, 12);
  if (d.length > 8) return `${d.slice(0, 6)}-${d.slice(6, 8)}-${d.slice(8)}`;
  if (d.length > 6) return `${d.slice(0, 6)}-${d.slice(6)}`;
  return d;
}

/** MyKad 前 6 位 = 生日（YYMMDD）。YY 大于今年两位数 → 19YY，否则 20YY（和资料库 ops.mykad_dob 同规则）；不是有效日期回传 "" */
export function mykadDob(s: string, today = todayKL()): string {
  const d = s.replace(/\D/g, "");
  if (d.length < 6) return "";
  const yy = Number(d.slice(0, 2)), mm = Number(d.slice(2, 4)), dd = Number(d.slice(4, 6));
  const y = (yy > Number(today.slice(2, 4)) ? 1900 : 2000) + yy;
  const dt = new Date(Date.UTC(y, mm - 1, dd));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mm - 1 || dt.getUTCDate() !== dd) return "";
  return dt.toISOString().slice(0, 10);
}

// 马来西亚常用银行（可以自己打别的）
const BANKS = ["Maybank", "CIMB Bank", "Public Bank", "RHB Bank", "Hong Leong Bank", "AmBank", "Bank Islam", "Bank Rakyat",
  "BSN", "Alliance Bank", "Affin Bank", "OCBC Bank", "UOB", "HSBC", "Standard Chartered", "Bank Muamalat", "Agrobank", "MBSB Bank"];

type Form = {
  id_type: "mykad" | "passport"; id_no: string; dob: string; address: string;
  emergency_name: string; emergency_relation: string; emergency_phone: string; bank_name: string; bank_account: string;
};
const formOf = (p: StaffProfile): Form => ({
  id_type: p.id_type || "mykad", id_no: p.id_no || "", dob: p.dob || "", address: p.address || "",
  emergency_name: p.emergency_name || "", emergency_relation: p.emergency_relation || "", emergency_phone: p.emergency_phone || "",
  bank_name: p.bank_name || "", bank_account: p.bank_account || "",
});

/** 档案表单。存好后回传新的档案（号码已由资料库整理过格式）。 */
export function ProfileForm({ p, onSaved, onCancel }: { p: StaffProfile; onSaved: (p: StaffProfile) => void; onCancel?: () => void }) {
  const [v, setV] = useState<Form>(() => formOf(p));
  // 生日跟着身份证自动带：一开始空白、或刚好等于身份证推出来的，就继续自动；员工自己改过生日就不再动
  const [dobAuto, setDobAuto] = useState(() => !p.dob || (p.id_type === "mykad" && mykadDob(p.id_no || "") === p.dob));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const ro = !p.can_edit;
  const set = (k: keyof Form) => (e: { target: { value: string } }) => setV({ ...v, [k]: e.target.value });

  function setIdNo(raw: string) {
    if (v.id_type === "passport") return setV({ ...v, id_no: raw.toUpperCase().replace(/\s/g, "") });
    const id_no = fmtMykad(raw);
    setV({ ...v, id_no, dob: dobAuto ? mykadDob(id_no) : v.dob });
  }
  function setIdType(t: Form["id_type"]) {
    // 换证件种类：号码重打；生日若是自动带的也清掉
    setV({ ...v, id_type: t, id_no: "", dob: dobAuto ? "" : v.dob });
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const body: Record<string, unknown> = {
      id_type: v.id_type, id_no: v.id_no, dob: v.dob, address: v.address,
      emergency_name: v.emergency_name, emergency_relation: v.emergency_relation, emergency_phone: v.emergency_phone,
    };
    if (p.can_bank) Object.assign(body, { bank_name: v.bank_name, bank_account: v.bank_account });   // 没权限不能送银行栏位
    try {
      onSaved(await api.saveProfile(p.staff_id, body));
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  const icDob = v.id_type === "mykad" ? mykadDob(v.id_no) : "";
  return (
    <form className="form" onSubmit={submit}>
      <fieldset disabled={ro || busy} className="plain">
        <h3>身份证</h3>
        <div className="row">
          <label>证件
            <select value={v.id_type} onChange={(e) => setIdType(e.target.value as Form["id_type"])}>
              <option value="mykad">MyKad（身份证）</option>
              <option value="passport">护照（外籍员工）</option>
            </select>
          </label>
          <label>{v.id_type === "mykad" ? "身份证号码" : "护照号码"}
            <input value={v.id_no} onChange={(e) => setIdNo(e.target.value)} autoComplete="off" maxLength={v.id_type === "passport" ? 20 : undefined}
                   inputMode={v.id_type === "mykad" ? "numeric" : "text"}
                   placeholder={v.id_type === "mykad" ? "900101-01-1234" : "A12345678"} />
          </label>
        </div>
        <div className="row">
          <label>生日
            <input type="date" value={v.dob} max={todayKL()} onChange={(e) => { setV({ ...v, dob: e.target.value }); setDobAuto(e.target.value === ""); }} />
          </label>
        </div>
        {v.id_type === "mykad" && icDob && v.dob === icDob && <p className="muted small">生日从身份证号码自动带入，不对可以改。</p>}
        {v.id_type === "mykad" && v.id_no.replace(/\D/g, "").length >= 6 && !icDob && (
          <p className="small late">身份证号码前 6 位不是有效的出生日期（YYMMDD）。</p>
        )}

        <h3>地址</h3>
        <label>住家地址<textarea rows={3} maxLength={300} value={v.address} onChange={set("address")}
                               placeholder="例：No. 12, Jalan Bakawali 3, Taman Johor Jaya, 81100 Johor Bahru" /></label>

        <h3>紧急联络人</h3>
        <div className="row">
          <label>名字<input value={v.emergency_name} maxLength={80} onChange={set("emergency_name")} /></label>
          <label>关系<input value={v.emergency_relation} maxLength={40} onChange={set("emergency_relation")} placeholder="例：太太、父亲" /></label>
          <label>电话<input type="tel" value={v.emergency_phone} onChange={set("emergency_phone")} placeholder="012-3456789" /></label>
        </div>

        {p.can_bank && (
          <>
            <h3>银行户口</h3>
            <div className="row">
              <label>银行<input value={v.bank_name} maxLength={80} list="hw-banks" onChange={set("bank_name")} placeholder="Maybank" /></label>
              <label>户口号码<input value={v.bank_account} inputMode="numeric" autoComplete="off" onChange={set("bank_account")} /></label>
            </div>
            <datalist id="hw-banks">{BANKS.map((b) => <option key={b} value={b} />)}</datalist>
            <p className="muted small">{p.self ? "发薪水用。只有你自己和管理薪资的人看得到。" : "只有本人和管理薪资的人看得到。"}</p>
          </>
        )}
      </fieldset>
      {ro && <p className="muted small">你只能查看这位员工的资料，要改请找有人事「可编辑」权限的人。</p>}
      {p.updated_at && <p className="muted small">{`最后更新 ${fmtDate(p.updated_at)}${p.updated_by_name ? ` · ${p.updated_by_name}` : ""}`}</p>}
      <ErrorBox error={error} />
      <div className="actions">
        {onCancel && <button type="button" className="ghost" onClick={onCancel}>{ro ? "关闭" : "取消"}</button>}
        {!ro && <button disabled={busy}>{busy ? "储存中…" : "储存"}</button>}
      </div>
    </form>
  );
}

/** 「还没填：证件号码、紧急联络人」 */
export function missingText(missing: string[]): string {
  return `还没填：${missing.map((m) => PROFILE_MISSING_LABEL[m] ?? m).join("、")}`;
}

export default function MyProfile() {
  const [p, setP] = useState<StaffProfile | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => { api.profile().then(setP).catch((e: Error) => setError(e.message)); }, []);
  if (!p) return error ? <ErrorBox error={error} /> : <p className="muted">载入中…</p>;
  return (
    <>
      <h1>我的资料</h1>
      <p className="muted">{[p.department_name, BRANCH_LABEL[p.branch] || p.branch, p.join_date && `到职 ${p.join_date}`].filter(Boolean).join(" · ")}</p>
      <p className="muted small">办 EPF / SOCSO、发薪水、有紧急状况时联络家人要用。只有你自己和 HR 看得到；银行户口只有你和管理薪资的人看得到。</p>
      {notice && <div className="ok">{notice}</div>}
      {p.missing.length > 0 && !notice && <p className="small late">{missingText(p.missing)}</p>}
      <section className="card narrow">
        <ProfileForm key={p.updated_at || "new"} p={p} onSaved={(x) => { setP(x); setNotice("已储存。"); window.scrollTo(0, 0); }} />
      </section>
      <p className="muted small">名字、手机、到职日要改请找 HR。</p>
    </>
  );
}
