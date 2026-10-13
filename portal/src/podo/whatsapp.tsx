// 发 WhatsApp 给厂家：把厂家问题整理成一段讯息（中文 / English 可切换），「复制」或开 https://wa.me/?text=…（自己选联络人）。
// 讯息写厂家 DO 号与我们的 PO 号、型号、品名、数量、要厂家怎么处理、备注。一律没有单价 / 金额（厂家问题 JSON 本来就不含价格）。
// 讯息不经过 DOM 翻译层（textarea 的内容不翻）：两种语言在这里各自组好。
import { useState } from "react";
import { fmtQty } from "../api";
import { getLang } from "../i18n";
import { Modal } from "../ui";
import { Issue, IssueKind, IssueRequest, requestLabel } from "../podo-api";

export type WaLang = "zh" | "en";
/** 讯息用到的厂家问题栏位 */
export type WaIssue = Pick<Issue, "kind" | "auto" | "item_code" | "received_code" | "description" | "qty" | "decision" | "note"
  | "status" | "do_id" | "do_no" | "do_date" | "po_nos"> & {
  request?: IssueRequest | null; part_name?: string; owed_qty?: number; factory?: string | null;
};

const LANG_KEY = "hw-wa-lang";
function initLang(): WaLang {
  try {
    const v = localStorage.getItem(LANG_KEY);
    if (v === "zh" || v === "en") return v;
  } catch { /* 读不到就照介面语言 */ }
  return getLang() === "en" ? "en" : "zh";
}

// 问题种类：手动记的少发 = 到货少、点货记的多发 = 多到（与 issueKindLabel 同规则）
const KIND_ZH: Record<string, string> = {
  short: "少发", short_m: "到货少", over: "多发", over_m: "多到", wrong: "来错的型号", damaged: "坏货", part: "缺零件",
};
const KIND_EN: Record<string, string> = {
  short: "Short-shipped", short_m: "Short on arrival", over: "Over-shipped", over_m: "Extra on arrival", wrong: "Wrong model",
  damaged: "Damaged", part: "Missing parts",
};
const kindKey = (i: Pick<WaIssue, "kind" | "auto">) => (i.kind === "short" || i.kind === "over") && !i.auto ? `${i.kind}_m` : i.kind;
const KIND_ORDER = ["short", "short_m", "part", "wrong", "damaged", "over", "over_m"];

const REQ_EN: Record<IssueRequest, string> = {
  replace: "please replace them with the correct model", return: "we will return them to you", next: "please send them with the next shipment",
  keep: "we will keep them (please bill at the PO price)", other: "see note",
};
function reqText(lang: WaLang, kind: IssueKind, r: IssueRequest): string {
  if (lang === "zh") return requestLabel(kind, r);
  if (kind === "wrong" && r === "next") return "please send the correct model with the next shipment";
  if (kind === "damaged" && r === "replace") return "please send replacements";
  return REQ_EN[r];
}

const q = (n: number | null | undefined) => fmtQty(Number(n ?? 0));
const sep = (lang: WaLang) => (lang === "zh" ? "、" : ", ");

/** 一笔问题写成一行（＋ 处理 / 备注） */
function issueLines(lang: WaLang, i: WaIssue, n: number, owed: boolean): string[] {
  const zh = lang === "zh";
  const code = i.item_code ?? "";
  const desc = (i.description ?? "").trim();
  const amount = owed ? Number(i.owed_qty ?? i.qty) : Number(i.qty);
  let what: string;
  if (i.kind === "wrong") {
    const got = [i.received_code, desc].filter(Boolean).join(" ");
    what = zh ? `收到 ${got || "（没写型号）"} × ${q(amount)}${code ? `（本来应该是 ${code}）` : ""}`
      : `received ${got || "(no model)"} × ${q(amount)}${code ? ` (should have been ${code})` : ""}`;
  } else if (i.kind === "part") {
    const head = [code, desc && desc !== code ? desc : ""].filter(Boolean).join(" ");
    what = zh ? `${head ? head + " " : ""}缺「${i.part_name ?? ""}」× ${q(amount)}` : `${head ? head + " " : ""}missing "${i.part_name ?? ""}" × ${q(amount)}`;
  } else {
    const head = [code, desc].filter(Boolean).join(" ");
    const tail = owed ? (zh ? `还欠 ${q(amount)}` : `${q(amount)} still owed`)
      : i.kind === "short" ? (zh ? `少 ${q(amount)}` : `${q(amount)} short`)
      : i.kind === "over" ? (zh ? `多 ${q(amount)}` : `${q(amount)} extra`)
      : (zh ? `坏 ${q(amount)}` : `${q(amount)} damaged`);
    what = `${head} — ${tail}`;
  }
  const out = [`${n}. ${what}`];
  // 处理：少发 / 缺零件看决定；其他看「要厂家怎么处理」。催货（owed）：厂家会补的请安排补上；还没决定的只问会不会补（不先替公司答应）
  let act = "";
  if (owed) {
    act = i.decision === "pending" ? (zh ? "请告诉我们会不会补" : "please let us know if you will send them")
      : (zh ? "请安排补上" : "please arrange to send them");
  } else if (i.kind === "short") {
    act = i.decision === "await" ? (zh ? "请下次补上" : "please send them with the next shipment")
      : i.decision === "cancelled" ? (zh ? "取消，不用补了" : "cancelled — no need to send")
      : (zh ? "请告诉我们会不会补" : "please let us know if you will send them");
  } else if (i.kind === "part" && i.decision === "cancelled") {
    act = zh ? "取消，不用补了" : "cancelled — no need to send";
  } else if (i.request) {
    act = reqText(lang, i.kind, i.request);
  } else if (i.kind === "part") {
    act = zh ? "请下次补上" : "please send them with the next shipment";
  }
  if (act) out.push(zh ? `   → 处理：${act}` : `   → ${act}`);
  if (owed && i.request && i.kind !== "short" && i.request !== "next") out.push(zh ? `   → 处理：${reqText(lang, i.kind, i.request)}` : `   → ${reqText(lang, i.kind, i.request)}`);
  if (i.note?.trim()) out.push(zh ? `   备注：${i.note.trim()}` : `   Note: ${i.note.trim()}`);
  return out;
}

/** 照 DO 分组（同一张厂家 DO 的问题写在一起，表头写厂家 DO 号与我们的 PO 号） */
function byDo(issues: WaIssue[]): WaIssue[][] {
  const m = new Map<string, WaIssue[]>();
  for (const i of issues) {
    const k = String(i.do_id ?? "-");
    const g = m.get(k);
    if (g) g.push(i); else m.set(k, [i]);
  }
  return [...m.values()];
}

function doHead(lang: WaLang, g: WaIssue[]): string[] {
  const zh = lang === "zh";
  const d = g[0];
  const pos = [...new Set(g.flatMap((i) => i.po_nos ?? []))].sort();
  const no = d.do_no || (zh ? "（没有号码）" : "(no number)");
  const out = [zh ? `厂家 DO：${no}${d.do_date ? `（${d.do_date}）` : ""}` : `Your DO: ${no}${d.do_date ? ` (${d.do_date})` : ""}`];
  if (pos.length) out.push(zh ? `我们的 PO：${pos.join(sep(lang))}` : `Our PO: ${pos.join(sep(lang))}`);
  return out;
}

/** 这批（或选的几笔）厂家问题 → 讯息 */
export function waIssuesText(lang: WaLang, issues: WaIssue[], factory?: string | null): string {
  const zh = lang === "zh";
  const list = issues.filter((i) => i.status !== "void");
  const out = [zh ? "您好，这里是 HomeWorks 订货部。" : "Hello, this is HomeWorks Purchasing."];
  if (factory) out.push(zh ? `工厂：${factory}` : `Factory: ${factory}`);
  if (!list.length) {
    out.push(zh ? "这批全部到齐，谢谢！" : "Everything in this shipment arrived complete. Thank you!");
    return out.join("\n");
  }
  for (const g of byDo(list)) {
    out.push("", ...doHead(lang, g), zh ? "这批货有以下问题：" : "This shipment has the following issues:");
    for (const k of KIND_ORDER) {
      const xs = g.filter((i) => kindKey(i) === k);
      if (!xs.length) continue;
      out.push("", zh ? `【${KIND_ZH[k]}】` : `[${KIND_EN[k]}]`);
      xs.forEach((i, n) => out.push(...issueLines(lang, i, n + 1, false)));
    }
  }
  out.push("", zh ? "麻烦确认，谢谢！" : "Please confirm. Thank you!");
  return out.join("\n");
}

/** 厂家还欠（少发未决定 / 厂家会补还没补齐、缺零件还没处理）→ 催货讯息 */
export function waOwedText(lang: WaLang, issues: WaIssue[], factory?: string | null): string {
  const zh = lang === "zh";
  const list = issues.filter((i) => Number(i.owed_qty ?? 0) > 0);
  const out = [zh ? "您好，这里是 HomeWorks 订货部。" : "Hello, this is HomeWorks Purchasing."];
  const ask = list.some((i) => i.decision === "pending");
  const send = list.some((i) => i.decision !== "pending");
  out.push(zh ? `以下货品还没补齐${factory ? `（工厂 ${factory}）` : ""}：${send ? "厂家会补的请安排补上，并告诉我们什么时候出货" : ""}${send && ask ? "；" : ""}${ask ? "标「请告诉我们会不会补」的请回覆会不会补" : ""}。`
    : `The following items are still outstanding${factory ? ` (factory ${factory})` : ""}.${send ? " Please arrange to send the ones marked \"please arrange to send them\" and let us know when they will ship." : ""}${ask ? " For the ones marked \"please let us know if you will send them\", please tell us whether you will send them." : ""}`);
  for (const g of byDo(list)) {
    out.push("", ...doHead(lang, g));
    g.forEach((i, n) => {
      const lines = issueLines(lang, i, n + 1, true);
      lines[0] += zh ? `（${KIND_ZH[kindKey(i)]}）` : ` (${KIND_EN[kindKey(i)].toLowerCase()})`;
      out.push(...lines);
    });
  }
  out.push("", zh ? "谢谢！" : "Thank you!");
  return out.join("\n");
}

export const waUrl = (text: string) => `https://wa.me/?text=${encodeURIComponent(text)}`;

/** 预览 + 中 / 英切换 + 复制 / 开 WhatsApp（讯息可以先改再送）。
 *  toggle：多一个勾选（例：点完货的 DO 预设只发点货时 / 之后记的问题，勾了才连同确认时的一起发）；build 的第二个参数 = 有没有勾 */
export function WaModal({ title, build, onClose, toggle }: {
  title: string; build: (l: WaLang, on: boolean) => string; onClose: () => void; toggle?: { label: string; hint?: string };
}) {
  const [lang, setLang] = useState<WaLang>(initLang);
  const [on, setOn] = useState(false);
  const [text, setText] = useState(() => build(initLang(), false));
  const [copied, setCopied] = useState("");
  const pick = (l: WaLang) => {
    setLang(l);
    try { localStorage.setItem(LANG_KEY, l); } catch { /* 忽略 */ }
    setText(build(l, on));
    setCopied("");
  };
  const flip = (v: boolean) => {
    setOn(v);
    setText(build(lang, v));
    setCopied("");
  };
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied("已复制，可以贴到 WhatsApp。");
    } catch {
      const ta = document.querySelector<HTMLTextAreaElement>("textarea.wa-text");
      ta?.select();
      setCopied(document.execCommand?.("copy") ? "已复制，可以贴到 WhatsApp。" : "复制不了：请长按讯息自己复制。");
    }
  }
  return (
    <Modal title={title} onClose={onClose} wide>
      <div className="wa-lang">
        <span className="small">讯息语言</span>
        <button type="button" translate="no" className={"small" + (lang === "zh" ? "" : " ghost")} onClick={() => pick("zh")}>中文</button>
        <button type="button" translate="no" className={"small" + (lang === "en" ? "" : " ghost")} onClick={() => pick("en")}>English</button>
      </div>
      {toggle && (
        <label className="check small wa-toggle">
          <input type="checkbox" checked={on} onChange={(e) => flip(e.target.checked)} /> {toggle.label}
          {toggle.hint && <small className="muted">{` · ${toggle.hint}`}</small>}
        </label>
      )}
      <textarea className="wa-text" rows={14} value={text} onChange={(e) => { setText(e.target.value); setCopied(""); }} aria-label="讯息内容" />
      <p className="muted small">讯息不含价格。按「开 WhatsApp」后自己选厂家的联络人；也可以先「复制」再贴上。讯息可以先改再送。</p>
      {copied && <div className="ok">{copied}</div>}
      <div className="actions">
        <button type="button" className="ghost" onClick={onClose}>关闭</button>
        <button type="button" className="ghost" onClick={copy}>复制</button>
        <button type="button" onClick={() => window.open(waUrl(text), "_blank", "noopener")}>📱 开 WhatsApp</button>
      </div>
    </Modal>
  );
}
