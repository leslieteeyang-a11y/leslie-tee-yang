// 顾客资料 · 顾客名单：分级、筛选（买过 / 没买过某类别、生日月、同意收促销…）、汇出同意名单、用名单建促销活动
import { useMemo, useState } from "react";
import {
  applyFilters, cleanName, CustRole, Customer, downloadCsv, EMPTY_FILTERS, Filters, fmtDay, fmtMember, fmtNum, localISO, num,
  rpc, Settings, STAGE_LABEL, STAGES, t, Tier, TIER_LABEL, tierOf, TIERS, TYPES, waNumber, errText,
} from "../cust-api";
import { ConsentTag, MemberLink, TierTag } from "./Common";

export function CustomerList({ list, settings, role, onOpen }: {
  list: Customer[]; settings: Settings; role: CustRole; onOpen: (id: string) => void;
}) {
  const canManage = role === "owner" || role === "manager";
  const canEdit = role !== "viewer";
  const [f, setF] = useState<Filters>(EMPTY_FILTERS);
  const [sort, setSort] = useState<"recent" | "spent" | "name">("recent");
  const [shown, setShown] = useState(100);
  const [newPhone, setNewPhone] = useState("");

  const set = (k: keyof Filters) => (e: { target: { value: string } }) => { setF({ ...f, [k]: e.target.value }); setShown(100); };
  const categories = useMemo(() => Array.from(new Set(list.flatMap((c) => c.categories))).sort(), [list]);
  const filtered = useMemo(() => {
    const out = applyFilters(list, f, settings);
    if (sort === "spent") out.sort((a, b) => num(b.spent) - num(a.spent));
    else if (sort === "name") out.sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
    else out.sort((a, b) => ((a.last_date ?? "") < (b.last_date ?? "") ? 1 : (a.last_date ?? "") > (b.last_date ?? "") ? -1 : 0));
    return out;
  }, [list, f, sort, settings]);
  const agreed = useMemo(() => filtered.filter((c) => c.consent === "yes"), [filtered]);
  const tiers = useMemo(() => {
    const out: Record<Tier, number> = { vip: 0, regular: 0, normal: 0, lapsed: 0, lead: 0 };
    for (const c of list) out[tierOf(c, settings)] += 1;
    return out;
  }, [list, settings]);

  function exportCsv() {
    downloadCsv(`customers_${localISO()}.csv`,
      [t("电话(WhatsApp)"), t("电话"), t("名字"), t("分级"), t("类型"), t("地区"), t("地址"), t("生日月"), t("生日日"), t("门市"), t("首次消费"),
        t("最后消费"), t("单数"), t("累计消费"), t("近 12 个月"), t("买过类别"), t("备注")],
      agreed.map((c) => [waNumber(c.member_id), fmtMember(c.member_id), cleanName(c.name), t(TIER_LABEL[tierOf(c, settings)]),
        c.customer_type, c.area, c.address, c.birth_month ?? "", c.birth_day ?? "", c.stores, c.first_date,
        c.last_date, c.doc_count, num(c.spent).toFixed(2), num(c.spent_12m).toFixed(2), c.categories.join(" "), c.note]));
  }

  function openNew() {
    const digits = newPhone.replace(/\D/g, "");
    if (digits.length < 8) return;
    onOpen(newPhone.trim().startsWith("+") ? "+" + digits : digits);
    setNewPhone("");
  }

  return (
    <>
      <div className="toolbar">
        <div className="tabs cu-wrap">
          <button className={f.tier === "" ? "on" : ""} onClick={() => setF({ ...f, tier: "" })}>{t("全部")}</button>
          {TIERS.map((x) => (
            <button key={x} className={f.tier === x ? "on" : ""} onClick={() => { setF({ ...f, tier: x }); setShown(100); }}>
              {t(TIER_LABEL[x])} {fmtNum(tiers[x])}
            </button>
          ))}
        </div>
      </div>
      <p className="muted small">
        {t("VIP = 近 12 个月消费 ≥ RM{v};常客 = 近 12 个月 ≥ {d} 张单;流失 = 超过 {l} 天没来", {
          v: fmtNum(settings.vip_min_12m), d: settings.regular_min_docs, l: settings.lapsed_days })}
      </p>
      <div className="toolbar cu-filters">
        <input placeholder={t("电话、名字或备注")} value={f.q} onChange={set("q")} />
        <select value={f.store} onChange={set("store")}>
          <option value="">{t("全部门市")}</option>
          <option value="HQ">HQ</option>
          <option value="JB">JB</option>
          <option value="both">{t("两边都买过")}</option>
        </select>
        <select value={f.recency} onChange={set("recency")}>
          <option value="">{t("不限最后消费")}</option>
          <option value="90">{t("3 个月内来过")}</option>
          <option value="180">{t("6 个月内来过")}</option>
          <option value="365">{t("12 个月内来过")}</option>
          <option value="lapsed">{t("超过 12 个月没来")}</option>
          <option value="none">{t("还没买过")}</option>
        </select>
        <select className="cu-cat" value={f.category} onChange={set("category")}>
          <option value="">{t("买过:全部类别")}</option>
          {categories.map((c) => <option key={c} value={c}>{t("买过 {c}", { c })}</option>)}
        </select>
        <select className="cu-cat" value={f.notCategory} onChange={set("notCategory")}>
          <option value="">{t("没买过:不限")}</option>
          {categories.map((c) => <option key={c} value={c}>{t("没买过 {c}", { c })}</option>)}
        </select>
        <select value={f.ctype} onChange={set("ctype")}>
          <option value="">{t("全部类型")}</option>
          {TYPES.map((x) => <option key={x} value={x}>{t(x)}</option>)}
          <option value="-">{t("未分类")}</option>
        </select>
        <select value={f.consent} onChange={set("consent")}>
          <option value="">{t("同意收促销:不限")}</option>
          <option value="yes">{t("同意")}</option>
          <option value="no">{t("不同意")}</option>
          <option value="unknown">{t("未确认")}</option>
        </select>
        <select value={f.stage} onChange={set("stage")}>
          <option value="">{t("装修阶段:不限")}</option>
          {STAGES.map(([k, v]) => <option key={k} value={k}>{t(v)}</option>)}
          <option value="any">{t("有填装修阶段")}</option>
          <option value="quote">{t("有报价没成交")}</option>
        </select>
        <select value={f.bmonth} onChange={set("bmonth")}>
          <option value="">{t("生日月份")}</option>
          {Array.from({ length: 12 }, (_, i) => <option key={i} value={i + 1}>{t("{m} 月", { m: i + 1 })}</option>)}
        </select>
        <input className="cu-short" placeholder={t("地区")} value={f.area} onChange={set("area")} />
        <input className="cu-short" placeholder={t("累计消费至少 RM")} value={f.minSpent} onChange={set("minSpent")} inputMode="numeric" />
        <button className="ghost" onClick={() => setF(EMPTY_FILTERS)}>{t("清除筛选")}</button>
      </div>
      <div className="toolbar">
        <div className="tabs cu-wrap">
          <button className={sort === "recent" ? "on" : ""} onClick={() => setSort("recent")}>{t("最近消费")}</button>
          <button className={sort === "spent" ? "on" : ""} onClick={() => setSort("spent")}>{t("消费最多")}</button>
          <button className={sort === "name" ? "on" : ""} onClick={() => setSort("name")}>{t("名字")}</button>
        </div>
        <span className="muted small">
          {t("符合 {n} 位,其中同意收促销 {y} 位", { n: fmtNum(filtered.length), y: fmtNum(agreed.length) })}
        </span>
        {canManage && (
          <button onClick={exportCsv} disabled={!agreed.length}>
            {t("汇出同意名单 {n} 位 (Excel)", { n: fmtNum(agreed.length) })}
          </button>
        )}
        {canEdit && (
          <span className="cu-new">
            <input placeholder={t("新顾客电话")} value={newPhone} onChange={(e) => setNewPhone(e.target.value)} inputMode="tel"
                   onKeyDown={(e) => { if (e.key === "Enter") openNew(); }} />
            <button className="ghost" onClick={openNew}>{t("新增顾客")}</button>
          </span>
        )}
      </div>
      {canManage && <NewCampaign members={agreed.map((c) => c.member_id)} total={filtered.length} />}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{t("电话 / 账号")}</th><th>{t("名字")}</th><th>{t("分级")}</th><th>{t("类型")}</th><th>{t("地区")}</th>
              <th>{t("门市")}</th><th>{t("最后消费")}</th><th className="num">{t("累计消费")}</th>
              <th className="num">{t("近 12 个月")}</th><th>{t("买过类别")}</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && <tr><td colSpan={10} className="muted">{t("没有符合的顾客")}</td></tr>}
            {filtered.slice(0, shown).map((c) => (
              <tr key={c.member_id} className="click" onClick={() => onOpen(c.member_id)}>
                <td className="nowrap"><MemberLink id={c.member_id} onOpen={onOpen} /> <ConsentTag consent={c.consent} /></td>
                <td>{cleanName(c.name)}</td>
                <td className="nowrap">
                  <TierTag tier={tierOf(c, settings)} />
                  {num(c.quote_open) > 0 && <span className="cu-tag cu-quote">{t("报价 {n}", { n: num(c.quote_open) })}</span>}
                </td>
                <td className="cu-type">{c.customer_type ? t(c.customer_type) : ""}{c.reno_stage ? ` · ${t(STAGE_LABEL[c.reno_stage] ?? c.reno_stage)}` : ""}</td>
                <td>{c.area}</td>
                <td className="nowrap">{c.stores}</td>
                <td className="nowrap">{fmtDay(c.last_date)}</td>
                <td className="num">{fmtNum(c.spent, 2)}</td>
                <td className={"num" + (num(c.spent_12m) ? "" : " muted")}>{num(c.spent_12m) ? fmtNum(c.spent_12m, 2) : "–"}</td>
                <td className="muted small cu-cats">{c.categories.join(" · ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {filtered.length > shown && (
        <div className="actions left"><button className="ghost" onClick={() => setShown(shown + 200)}>{t("显示更多")}</button></div>
      )}
    </>
  );
}

function NewCampaign({ members, total }: { members: string[]; total: number }) {
  const [show, setShow] = useState(false);
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const [sentOn, setSentOn] = useState(localISO());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function create() {
    if (!name.trim()) { setMsg({ ok: false, text: t("活动要有名称") }); return; }
    setBusy(true);
    try {
      const r = await rpc<{ members: number }>("bi_campaign_create",
        { p_name: name, p_message: message, p_sent_on: sentOn || null, p_members: members });
      setMsg({ ok: true, text: t("已建立活动,名单 {n} 位。", { n: fmtNum(num(r.members)) }) });
      setName(""); setMessage("");
      setShow(false);
    } catch (e) {
      setMsg({ ok: false, text: errText(e) });
    } finally {
      setBusy(false);
    }
  }

  const note = msg && <div className={msg.ok ? "ok" : "error"}>{msg.text}</div>;
  if (!show) {
    return (
      <>
        <div className="toolbar">
          <button className="ghost" disabled={!members.length} onClick={() => { setShow(true); setMsg(null); }}>
            {t("用这份名单建立促销活动")}
          </button>
        </div>
        {note}
      </>
    );
  }
  return (
    <div className="card">
      <h3 className="cu-h3">{t("建立促销活动")}</h3>
      <p className="muted small">
        {t("会放进目前筛选结果里「同意收促销」的 {y} 位(另外 {x} 位未同意或未确认,不会放进去)。之后在「促销活动」看这批人发送后 30 / 60 天的消费。", {
          y: fmtNum(members.length), x: fmtNum(total - members.length) })}
      </p>
      <div className="form cu-narrow">
        <label>{t("活动名称(例:10 月水龙头 8 折)")}<input value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label>{t("发送日期")}<input type="date" value={sentOn} onChange={(e) => setSentOn(e.target.value)} /></label>
        <label>{t("讯息内容(选填,留底用)")}<textarea rows={3} value={message} onChange={(e) => setMessage(e.target.value)} /></label>
        <div className="actions left">
          <button disabled={busy || !members.length} onClick={create}>{t("建立")}</button>
          <button className="ghost" onClick={() => setShow(false)}>{t("取消")}</button>
        </div>
      </div>
      {note}
    </div>
  );
}
