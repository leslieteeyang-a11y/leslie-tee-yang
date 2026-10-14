// 顾客资料：几个页面共用的小元件（分级标签、同意标记、一键 WhatsApp）
import type { ReactNode } from "react";
import { Consent, fillTemplate, fmtMember, t, Template, Tier, TIER_LABEL, touch, waLink } from "../cust-api";

/** 顾客电话 / 账号：真的连结（键盘可以按、可以开新分页），点了走 onOpen（记下名单卷到哪里） */
export function MemberLink({ id, onOpen, children }: { id: string; onOpen: (id: string) => void; children?: ReactNode }) {
  return (
    <a href={`#/customers/c/${encodeURIComponent(id)}`} className="cu-link"
       onClick={(e) => {
         e.stopPropagation();   // 表格那一列自己也会打开
         if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || e.button !== 0) return;   // 开新分页 / 新视窗：交给浏览器
         e.preventDefault();
         onOpen(id);
       }}>
      {children ?? fmtMember(id)}
    </a>
  );
}

export function TierTag({ tier }: { tier: Tier }) {
  return <span className={`cu-tag cu-tier-${tier}`}>{t(TIER_LABEL[tier])}</span>;
}

export function ConsentTag({ consent }: { consent: Consent }) {
  if (consent === "yes") return <span className="cu-tag cu-yes" title={t("同意收促销")}>✓</span>;
  if (consent === "no") return <span className="cu-tag cu-no" title={t("不收促销")}>✕</span>;
  return null;
}

/** 一键 WhatsApp：每个范本一颗按钮，开 wa.me 并记下联络时间（只看的人只开 WhatsApp、不记）；
 *  onTouched(错误讯息)：空字串 = 已记下联络时间 */
export function WaButtons({ id, name, templates, canEdit, onTouched }: {
  id: string; name: string; templates: Template[]; canEdit: boolean; onTouched: (err: string) => void;
}) {
  if (!waLink(id)) return <span className="muted small">{t("账号型顾客没有电话,不能 WhatsApp")}</span>;
  const mark = () => { if (canEdit) touch(id).then(onTouched); };
  return (
    <span className="cu-wa">
      {templates.map((x) => (
        <a key={x.id} className="cu-btn" href={waLink(id, fillTemplate(x.body, name))} target="_blank" rel="noreferrer"
           onClick={(e) => { e.stopPropagation(); mark(); }} title={fillTemplate(x.body, name)}>
          WhatsApp · {x.title}
        </a>
      ))}
      <a className="cu-btn" href={waLink(id)} target="_blank" rel="noreferrer" onClick={(e) => { e.stopPropagation(); mark(); }}>
        {t("WhatsApp(空白)")}
      </a>
    </span>
  );
}
