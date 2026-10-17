// 中英双语：切到英文时，把画面上的中文介面文字换成英文。
//
// 做法：MutationObserver 看整个页面，文字节点（和 placeholder / title / aria-label）的内容
// **整段完全等于**字典里的某一句，或符合 PATTERNS 的格式，才换。员工自己输入的内容（任务标题、备注、
// PO 备注…）几乎不可能刚好整段等于介面用语，所以不会被乱翻。
// 从数据库来的文字（模块名称、部门名称、错误讯息）也在字典里，所以一起翻。
//
// 新增介面文字时：把中文原句加进 i18n-dict-*.ts；有带数字 / 名称的句子加进 i18n-patterns.ts。
// 切换语言会重新载入页面（最简单、不会留下半中半英的状态）。
import { DICT_A } from "./i18n-dict-a";
import { DICT_B } from "./i18n-dict-b";
import { DICT_DB } from "./i18n-dict-db";
import { PATTERNS } from "./i18n-patterns";
import { DICT_ATT } from "./i18n-dict-att";
import { PATTERNS_ATT } from "./i18n-patterns-att";
import { DICT_LEAVE, PATTERNS_LEAVE } from "./i18n-dict-leave";
import { DICT_WH, PATTERNS_WH } from "./i18n-dict-wh";
import { DICT_PAY, PATTERNS_PAY } from "./i18n-dict-pay";
import { DICT_MORE, PATTERNS_MORE } from "./i18n-dict-more";
import { DICT_DLV, PATTERNS_DLV } from "./i18n-dict-dlv";
import { DICT_PROFILE } from "./i18n-dict-profile";
import { DICT_PODO } from "./i18n-dict-podo";
import { DICT_RECV } from "./i18n-dict-recv";
import { DICT_SOP, PATTERNS_SOP } from "./i18n-dict-sop";
import { DICT_RPL, PATTERNS_RPL } from "./i18n-dict-rpl";
import { DICT_WHBIN, PATTERNS_WHBIN } from "./i18n-dict-whbin";
import { DICT_WHMAP, PATTERNS_WHMAP } from "./i18n-dict-whmap";
import { DICT_WHPICK, PATTERNS_WHPICK } from "./i18n-dict-whpick";
import { DICT_WHSHEET, PATTERNS_WHSHEET } from "./i18n-dict-whsheet";
import { DICT_WHOV, PATTERNS_WHOV } from "./i18n-dict-whov";
import { DICT_WHTAG, PATTERNS_WHTAG, PATTERNS_WHTAG_LAST } from "./i18n-dict-whtag";
import { DICT_WHEXTRA, PATTERNS_WHEXTRA } from "./i18n-dict-whextra";
import { DICT_RECVSCAN, PATTERNS_RECVSCAN } from "./i18n-dict-recvscan";
import { DICT_GATE, PATTERNS_GATE } from "./i18n-dict-gate";

export type Lang = "zh" | "en";
const KEY = "hw-lang";

export function getLang(): Lang {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "zh" || v === "en") return v;
  } catch { /* 无痕模式读不到就用预设 */ }
  return "zh";
}

export function setLang(l: Lang): void {
  try { localStorage.setItem(KEY, l); } catch { /* 忽略 */ }
  window.location.reload();
}

// DICT_GATE 放最前面：跟别的字典重复的字（全部、取消…）照原本的翻法
const DICT: Record<string, string> = { ...DICT_GATE, ...DICT_WHEXTRA, ...DICT_DLV, ...DICT_MORE, ...DICT_PAY, ...DICT_A, ...DICT_B, ...DICT_DB, ...DICT_ATT, ...DICT_LEAVE, ...DICT_WH, ...DICT_PROFILE, ...DICT_PODO, ...DICT_RECV, ...DICT_SOP, ...DICT_RPL, ...DICT_WHBIN, ...DICT_WHMAP, ...DICT_WHPICK, ...DICT_WHSHEET, ...DICT_WHOV, ...DICT_WHTAG, ...DICT_RECVSCAN };
// 顺序 = 先比对先赢：专用的（拣货、总览、查货多的那些）放最前面，比较宽的（盘点单：…、通用「…（N）」）放后面，
// whtag 的万用 pattern（PATTERNS_WHTAG_LAST）放最后，别的都对不到才用
const ALL_PATTERNS = [...PATTERNS_RECVSCAN, ...PATTERNS_WHPICK, ...PATTERNS_WHOV, ...PATTERNS_WHEXTRA,
  ...PATTERNS_DLV, ...PATTERNS_MORE, ...PATTERNS_PAY, ...PATTERNS, ...PATTERNS_ATT, ...PATTERNS_LEAVE, ...PATTERNS_WH, ...PATTERNS_SOP, ...PATTERNS_RPL,
  ...PATTERNS_WHBIN, ...PATTERNS_WHMAP, ...PATTERNS_WHSHEET, ...PATTERNS_WHTAG, ...PATTERNS_GATE, ...PATTERNS_WHTAG_LAST];
const CJK = /[㐀-鿿＀-￯　-〿]/;

/** 翻一段文字；不认识就原样返回。前后空白保留。 */
export function tr(text: string): string {
  if (!CJK.test(text)) return text;
  const lead = text.match(/^\s*/)![0];
  const trail = text.match(/\s*$/)![0];
  const core = text.trim();
  const hit = DICT[core];
  if (hit !== undefined) return lead + hit + trail;
  for (const [re, fn] of ALL_PATTERNS) {
    const m = core.match(re);
    if (m) return lead + fn(m, (s) => DICT[s] ?? s) + trail;
  }
  // 用「 · 」串起来的几段（例：免打卡范围 · 到职 2026-09-01）：每段各自翻
  if (core.includes(" · ")) {
    const parts = core.split(" · ");
    const out = parts.map((x) => tr(x));
    if (out.some((x, i) => x !== parts[i])) return lead + out.join(" · ") + trail;
  }
  return text;
}

const ATTRS = ["placeholder", "title", "aria-label"];

function translateNode(node: Node): void {
  // translate="no" 的区块（例：司机签收页自己带中 / 英 / 马来文）不翻
  const host = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element);
  if (host?.closest?.('[translate="no"]')) return;
  if (node.nodeType === Node.TEXT_NODE) {
    const v = node.nodeValue ?? "";
    const t = tr(v);
    if (t !== v) node.nodeValue = t;
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  const el = node as Element;
  if (el.tagName === "SCRIPT" || el.tagName === "STYLE") return;
  for (const a of ATTRS) {
    const v = el.getAttribute(a);
    if (v && CJK.test(v)) {
      const t = tr(v);
      if (t !== v) el.setAttribute(a, t);
    }
  }
  // 输入框里员工正在打的字不动（placeholder 上面已经翻了）
  if (el.tagName === "TEXTAREA") return;
  el.childNodes.forEach(translateNode);
}

/** 在 main.tsx 最早呼叫；中文模式什么都不做。 */
export function startI18n(): void {
  if (getLang() !== "en") return;
  document.documentElement.lang = "en";
  document.title = "HomeWorks Operations";
  const run = () => translateNode(document.body);
  new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === "characterData") translateNode(m.target);
      else if (m.type === "attributes") translateNode(m.target);
      else m.addedNodes.forEach(translateNode);
    }
  }).observe(document.body, {
    subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS,
  });
  run();
}
