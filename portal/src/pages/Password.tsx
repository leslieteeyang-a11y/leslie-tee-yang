import { FormEvent, useState } from "react";
import { supabase } from "../supabase";

export default function Password() {
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    setMsg("");
    setError("");
    if (pw.length < 8) return setError("密码至少 8 个字元。");
    if (pw !== pw2) return setError("两次输入的密码不一样。");
    const { error } = await supabase.auth.updateUser({ password: pw });
    if (error) return setError(`改密码失败：${error.message}`);
    setPw("");
    setPw2("");
    setMsg("密码已更新。下次登入请用新密码（HomeWorks BI 也是同一组密码）。");
  }

  return (
    <form className="card narrow" onSubmit={submit}>
      <h2>改密码</h2>
      <label>新密码<input type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} /></label>
      <label>再输入一次<input type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} /></label>
      {error && <div className="error">{error}</div>}
      {msg && <div className="ok">{msg}</div>}
      <button>更新密码</button>
    </form>
  );
}
