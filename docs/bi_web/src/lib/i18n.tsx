import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { DICT } from '../i18n';

// 全站中 / 英切换。原始码里的文字维持中文,英文放 src/i18n/*.ts 字典(键 = 中文原文)。
// 用法: const t = useT(); t('本月净销售')  → 中文模式回原文,英文模式查字典(查不到就回中文,不会空白)。
// 带参数: t('本月 (至 {d} 日)', { d: 28 })  → 字典里英文也写 {d}。
// 组件外(常数、非 hook 函数)用 tr(lang, zh)。

export type Lang = 'zh' | 'en';
const KEY = 'bi_lang';

export function savedLang(): Lang {
  try { return localStorage.getItem(KEY) === 'en' ? 'en' : 'zh'; } catch { return 'zh'; }
}

export function tr(lang: Lang, zh: string, vars?: Record<string, string | number>): string {
  let s = lang === 'en' ? (DICT[zh] ?? zh) : zh;
  if (vars) Object.entries(vars).forEach(([k, v]) => { s = s.split(`{${k}}`).join(String(v)); });
  return s;
}

const Ctx = createContext<{ lang: Lang; setLang: (l: Lang) => void }>({ lang: 'zh', setLang: () => {} });

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(savedLang);
  const setLang = (l: Lang) => {
    setLangState(l);
    try { localStorage.setItem(KEY, l); } catch { /* 隐私模式没有 localStorage,只影响这次 */ }
  };
  useEffect(() => { document.documentElement.lang = lang === 'en' ? 'en' : 'zh-CN'; }, [lang]);
  return <Ctx.Provider value={{ lang, setLang }}>{children}</Ctx.Provider>;
}

export function useLang() { return useContext(Ctx); }

export function useT() {
  const { lang } = useLang();
  return (zh: string, vars?: Record<string, string | number>) => tr(lang, zh, vars);
}

export function LangToggle() {
  const { lang, setLang } = useLang();
  return (
    <div className="seg" title="Language / 语言">
      <button className={lang === 'zh' ? 'active' : ''} onClick={() => setLang('zh')}>中文</button>
      <button className={lang === 'en' ? 'active' : ''} onClick={() => setLang('en')}>EN</button>
    </div>
  );
}
