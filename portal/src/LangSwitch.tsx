import { getLang, setLang } from "./i18n";

// 「中文 | EN」切换；两个字都不在字典里，所以不会被翻掉
export default function LangSwitch({ className = "" }: { className?: string }) {
  const lang = getLang();
  return (
    <span className={"lang " + className}>
      <button type="button" className={lang === "zh" ? "on" : ""} onClick={() => lang !== "zh" && setLang("zh")}>中文</button>
      <button type="button" className={lang === "en" ? "on" : ""} onClick={() => lang !== "en" && setLang("en")}>EN</button>
    </span>
  );
}
