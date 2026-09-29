import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { LangProvider, savedLang, tr, type Lang } from '../lib/i18n';
import Login from '../components/Login';
import Loyalty from '../pages/Loyalty';
import '../styles.css';
import './loyalty.css';

// 顾客资料独立页(/loyalty.html,网址沿用积分时期):柜台只开这一页。登入与主看板共用同一个 Supabase session。
// 角色:owner / manager / sales 可看可改;汇出名单只给 owner / manager。

const ALLOWED = ['owner', 'manager', 'sales'];

function LoyaltyApp() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [role, setRole] = useState<string | null | undefined>(undefined);
  const [company, setCompany] = useState<string | null>(null);
  const [roleErr, setRoleErr] = useState<string | null>(null);
  const [lang, setLangState] = useState<Lang>(savedLang);
  const t = (zh: string) => tr(lang, zh);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) { setRole(undefined); return; }
    (async () => {
      const [r, c] = await Promise.all([supabase.rpc('bi_role'), supabase.rpc('bi_company')]);
      const e = r.error ?? c.error;
      setRoleErr(e ? e.message : null);
      setRole((r.data as string | null) ?? null);
      setCompany((c.data as string | null) ?? null);
    })();
  }, [session?.user?.id]);

  useEffect(() => { document.title = tr(lang, '顾客资料') + ' · Homeworks'; }, [lang]);

  function switchLang(l: Lang) {
    setLangState(l);
    try { localStorage.setItem('bi_lang', l); } catch { /* 隐私模式:只影响这次 */ }
  }

  if (session === undefined) return <div className="loading">{t('载入中…')}</div>;
  if (!session) return <Login />;

  const store = company === 'HOMEWORKSSOUTHERN' ? 'JB' : company === 'HOMEWORKSSB' ? 'HQ' : null;

  return (
    <div className="shell">
      <div className="topbar">
        <h1>{t('顾客资料')}</h1>
        <div className="spacer" />
        <span className="who">{session.user.email}{store ? ` · ${store}` : ''}</span>
        <div className="seg">
          <button className={lang === 'zh' ? 'active' : ''} onClick={() => switchLang('zh')}>中文</button>
          <button className={lang === 'en' ? 'active' : ''} onClick={() => switchLang('en')}>EN</button>
        </div>
        <a className="btn" href="/">{t('BI 看板')}</a>
        <button className="btn" onClick={() => supabase.auth.signOut()}>{t('登出')}</button>
      </div>
      {role === undefined && <div className="loading">{t('载入中…')}</div>}
      {roleErr && <div className="notice">{t('查询失败:')}{roleErr}</div>}
      {role !== undefined && !roleErr && !ALLOWED.includes(role ?? '') && (
        <div className="notice">{t('这个帐号没有顾客资料的权限,请老板在 BI 加上 owner / manager / sales 角色。')}</div>
      )}
      {role && ALLOWED.includes(role) && <Loyalty lang={lang} role={role} company={company} />}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <LangProvider>
      <LoyaltyApp />
    </LangProvider>
  </React.StrictMode>
);
