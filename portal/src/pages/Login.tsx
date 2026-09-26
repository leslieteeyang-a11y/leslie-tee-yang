import { FormEvent, useState } from "react";
import { supabase } from "../supabase";

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim().toLowerCase(), password });
    setBusy(false);
    if (error) setError(error.message.includes("Invalid") ? "email 或密码不对。" : `登入失败：${error.message}`);
  }

  return (
    <div className="login">
      <form className="card" onSubmit={submit}>
        <div className="login-brand">
          <span className="logo">⌂</span>
          <div>
            <h1>HomeWorks 营运系统</h1>
            <p>员工登入（与 HomeWorks BI 同一组账号）</p>
          </div>
        </div>
        <label>Email<input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
        <label>密码<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
        {error && <div className="error">{error}</div>}
        <button disabled={busy}>{busy ? "登入中…" : "登入"}</button>
        <p className="hint">没有账号或忘记密码，请找管理员。</p>
      </form>
    </div>
  );
}
