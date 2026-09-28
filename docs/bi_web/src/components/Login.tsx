import { useState } from 'react';
import { supabase } from '../lib/supabase';
import { useT } from '../lib/i18n';

export default function Login() {
  const t = useT();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) setErr(error.message === 'Invalid login credentials' ? t('邮箱或密码不正确') : error.message);
    setBusy(false);
  }

  return (
    <div className="login-wrap">
      <form className="card login-card" onSubmit={submit}>
        <h1>{t('Homeworks BI 看板')}</h1>
        <div className="hint">{t('AutoCount 数据只读镜像 · 授权账号登录')}</div>
        <label>{t('邮箱')}</label>
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required />
        <label>{t('密码')}</label>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        <button className="btn primary" disabled={busy}>{busy ? t('登录中…') : t('登录')}</button>
        {err && <div className="err">{err}</div>}
      </form>
    </div>
  );
}
