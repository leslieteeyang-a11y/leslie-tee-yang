// 首页的顾客提醒：今天要跟进几位（自己门市；规则与「顾客资料 → 跟进」同一套，资料库 ops_cust_home 算）、这个月我联络 / 补资料了几位
import { useEffect, useState } from "react";
import { can, Me } from "../api";
import { CustHome, fmtNum, rpc, t } from "../cust-api";

const KIND: [keyof CustHome["by_kind"], string][] = [
  ["due", "约好联络 {n}"], ["quote", "报价没成交 {n}"], ["birthday", "生日 {n}"], ["new", "新客回访 {n}"], ["stage", "装修进度 {n}"],
  ["lead", "潜在客 {n}"],
];

export function CustomersHomeCard({ me }: { me: Me }) {
  const [h, setH] = useState<CustHome | null>(null);
  const show = can(me, "customers", "view");
  useEffect(() => {
    if (show) rpc<CustHome | null>("ops_cust_home").then(setH).catch(() => { /* 首页不因这张卡出错 */ });
  }, [show]);
  if (!h) return null;
  const parts = KIND.filter(([k]) => (h.by_kind[k] ?? 0) > 0).map(([k, label]) => t(label, { n: fmtNum(h.by_kind[k]) }));
  return (
    <a className={"card att-home" + (h.total > 0 ? " warn" : "")} href="#/customers/follow" translate="no">
      <span>
        <b>{"☏ "}{h.total > 0 ? t("今天要跟进 {n} 位顾客", { n: fmtNum(h.total) }) : t("顾客跟进")}</b>
        {h.store && <span className="muted">{` · ${h.store}`}</span>}<br />
        {parts.length > 0 && <span className="late">{parts.join(" · ")}</span>}
        {parts.length > 0 && <br />}
        <span className="muted">{t("这个月你联络了 {c} 位、补资料 {r} 位", { c: fmtNum(h.my_contacts), r: fmtNum(h.my_registered) })}</span>
      </span>
      <span className="go">{h.total > 0 ? t("去跟进 →") : t("看 →")}</span>
    </a>
  );
}
