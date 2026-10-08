// 员工自己申请加入（不用登入）：#/join?c=<邀请码>。送到 Edge Function ops-join，管理员在「员工与权限 → 加入申请」批准，
// 批准时才建登入账号（用申请人自己设的密码）。
import { FormEvent, useEffect, useState } from "react";
import { supabase } from "../supabase";
import { ErrorBox } from "../ui";
import LangSwitch from "../LangSwitch";
import "../extra.css";

function codeFromHash(): string {
  const q = window.location.hash.split("?")[1] || "";
  return new URLSearchParams(q).get("c") || "";
}

// functions.invoke 的错误：伺服器有回 JSON 就拿 error 栏位；断线 / 逾时时 context 不是 Response
async function fnError(err: unknown): Promise<string> {
  const ctx = (err as { context?: unknown }).context;
  if (ctx instanceof Response) {
    const body = await ctx.json().catch(() => null);
    if (body?.error) return String(body.error);
  }
  return "网路有问题，请再按一次。";
}

const toLogin = () => { window.location.hash = "#/"; };

export default function Join({ sessionEmail }: { sessionEmail?: string }) {
  const [code] = useState(codeFromHash);
  const [valid, setValid] = useState<boolean | null>(null);
  const [f, setF] = useState({ name: "", email: "", password: "", password2: "", phone: "", gender: "", join_date: "", branch: "", note: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ existing: boolean } | null>(null);
  const set = (k: keyof typeof f, v: string) => setF({ ...f, [k]: v });

  useEffect(() => {
    if (!code || sessionEmail) return;
    supabase.functions.invoke("ops-join", { body: { action: "check", code } })
      .then(({ data, error: err }) => setValid(err ? true : !!(data as { ok?: boolean })?.ok)); // 查不到就先让他填，送出时再检查
  }, [code, sessionEmail]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (f.password.length < 8) { setError("密码至少 8 个字。"); return; }
    if (f.password !== f.password2) { setError("两次输入的密码不一样。"); return; }
    setBusy(true);
    try {
      const { password2: _skip, ...body } = f;
      const { data, error: err } = await supabase.functions.invoke("ops-join", { body: { ...body, action: "submit", code } });
      if (err) { setError(await fnError(err)); return; }
      setDone({ existing: !!(data as { existing?: boolean })?.existing });
    } catch {
      setError("网路有问题，请再按一次。");
    } finally {
      setBusy(false);
    }
  }

  if (sessionEmail) {
    return (
      <div className="center card narrow">
        <h2>你已经登入了</h2>
        <p>{`目前登入的是 ${sessionEmail}。要帮另一个人申请，请先登出。`}</p>
        <button onClick={toLogin}>进入系统</button>{" "}
        <button className="ghost" onClick={() => supabase.auth.signOut()}>登出</button>
      </div>
    );
  }
  if (!code || valid === false) {
    return (
      <div className="center card narrow">
        <h2>加入 HomeWorks 营运系统</h2>
        <p>{code ? "这个加入链接已经失效。请向管理员要新的链接。" : "这个链接不完整。请向管理员要「加入链接」，从链接直接打开。"}</p>
        <button className="ghost" onClick={toLogin}>已经有账号？去登入</button>
      </div>
    );
  }
  if (valid === null) return <div className="center">载入中…</div>;
  if (done) {
    return (
      <div className="center card narrow">
        <h2>申请已送出 ✓</h2>
        <p>{done.existing ? "管理员批准后，用你原本的密码登入。"
                           : "管理员批准后，就可以用这个 email 和你刚才设的密码登入。批准前还不能登入。"}</p>
        <button onClick={toLogin}>去登入</button>
      </div>
    );
  }
  return (
    <div className="login join">
      <form className="card form" onSubmit={submit}>
        <h1>加入 HomeWorks</h1>
        <p className="muted small">填好送出，管理员批准后就能用手机打卡、请假、看工资单。</p>
        <label>名字（跟 IC 一样）<input value={f.name} onChange={(e) => set("name", e.target.value)} required maxLength={80} autoComplete="name" /></label>
        <label>Email（以后用来登入）<input type="email" value={f.email} onChange={(e) => set("email", e.target.value)} required autoComplete="email" /></label>
        <div className="row">
          <label>设一个密码（至少 8 个字）<input type="password" value={f.password} onChange={(e) => set("password", e.target.value)} required minLength={8} autoComplete="new-password" /></label>
          <label>再输入一次密码<input type="password" value={f.password2} onChange={(e) => set("password2", e.target.value)} required autoComplete="new-password" /></label>
        </div>
        <div className="row">
          <label>手机（WhatsApp）<input value={f.phone} onChange={(e) => set("phone", e.target.value)} placeholder="012-3456789" autoComplete="tel" /></label>
          <label>性别
            <select value={f.gender} onChange={(e) => set("gender", e.target.value)} required>
              <option value="">—</option><option value="M">男</option><option value="F">女</option>
            </select>
          </label>
        </div>
        <div className="row">
          <label>到职日（开始上班那天）<input type="date" value={f.join_date} onChange={(e) => set("join_date", e.target.value)} /></label>
          <label>在哪里上班
            <select value={f.branch} onChange={(e) => set("branch", e.target.value)}>
              <option value="">—</option><option value="HOMEWORKSSB">总行</option><option value="HOMEWORKSSOUTHERN">JB 分店</option>
            </select>
          </label>
        </div>
        <label>备注（选填，例：部门、职位）<input value={f.note} onChange={(e) => set("note", e.target.value)} maxLength={300} placeholder="例：仓库 · 司机" /></label>
        <ErrorBox error={error} />
        <div className="actions"><button disabled={busy}>{busy ? "送出中…" : "送出申请"}</button></div>
        <p className="hint"><a href="#/">已经有账号？去登入</a></p>
        <LangSwitch className="light" />
      </form>
    </div>
  );
}
