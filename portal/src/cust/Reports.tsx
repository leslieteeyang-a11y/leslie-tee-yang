// 顾客资料 · 促销活动（可审批：成效、汇出名单；管理员可删）、每月顾客报告、没抓到电话的门市单据
import { useEffect, useRef, useState } from "react";
import {
  Agent, Campaign, cleanName, Customer, downloadCsv, errText, fmtDay, fmtMember, fmtNum, localISO, Missing, Monthly, num, pct,
  rpc, Settings, STORE, t, TIER_LABEL, tierOf, waNumber,
} from "../cust-api";

export function Campaigns({ isOwner, list, settings }: { isOwner: boolean; list: Customer[]; settings: Settings }) {
  const [rows, setRows] = useState<Campaign[] | null>(null);
  const [err, setErr] = useState("");

  async function load() {
    try {
      setRows(await rpc<Campaign[]>("bi_campaigns") ?? []);
      setErr("");
    } catch (e) {
      setErr(errText(e));
    }
  }
  useEffect(() => { load(); }, []);

  async function exportMembers(c: Campaign) {
    try {
      const ids = await rpc<string[]>("bi_campaign_members", { p_id: c.id }) ?? [];
      const byId = new Map(list.map((x) => [x.member_id, x]));
      downloadCsv(`campaign_${c.id}_${c.sent_on}.csv`,
        [t("电话(WhatsApp)"), t("电话"), t("名字"), t("分级"), t("最后消费"), t("近 12 个月")],
        ids.map((id) => {
          const x = byId.get(id);
          return [waNumber(id), fmtMember(id), cleanName(x?.name), x ? t(TIER_LABEL[tierOf(x, settings)]) : "", x?.last_date ?? "",
            num(x?.spent_12m).toFixed(2)];
        }));
    } catch (e) {
      setErr(errText(e));
    }
  }

  async function remove(c: Campaign) {
    if (!window.confirm(t("删除活动「{n}」?名单与成效纪录都会删掉。", { n: c.name }))) return;
    try {
      await rpc("bi_campaign_delete", { p_id: c.id });
      load();
    } catch (e) {
      setErr(errText(e));
    }
  }

  const today = localISO();
  const ended = (c: Campaign, days: number) => localISO(new Date(new Date(c.sent_on + "T00:00:00").getTime() + days * 86400000)) <= today;

  return (
    <section className="card">
      <h2>{t("促销活动")}</h2>
      <p className="muted small">
        {t("成效 = 名单上的顾客在发送日之后 30 / 60 天内来买的人数与金额(含没看到讯息自己来的,当参考)。在「顾客」分页筛好名单后按「用这份名单建立促销活动」。")}
      </p>
      {err && <div className="error">{t("查询失败:")}{err}</div>}
      {rows === null && !err && <p className="muted">{t("载入中…")}</p>}
      {rows && (
        <div className="cu-scroll">
          <table>
            <thead>
              <tr>
                <th>{t("发送日期")}</th><th>{t("活动")}</th><th className="num">{t("名单")}</th>
                <th className="num">{t("30 天内来买")}</th><th className="num">{t("30 天营业额")}</th>
                <th className="num">{t("60 天内来买")}</th><th className="num">{t("60 天营业额")}</th><th />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={8} className="muted">{t("还没有活动")}</td></tr>}
              {rows.map((c) => (
                <tr key={c.id}>
                  <td className="nowrap">{fmtDay(c.sent_on)}</td>
                  <td>{c.name}{c.message && <div className="muted small">{c.message}</div>}</td>
                  <td className="num">{fmtNum(c.members)}</td>
                  <td className="num">
                    {fmtNum(c.buyers_30)} ({pct(num(c.buyers_30), num(c.members))}){ended(c, 30) ? "" : ` · ${t("进行中")}`}
                  </td>
                  <td className="num">{fmtNum(c.revenue_30, 2)}</td>
                  <td className="num">
                    {fmtNum(c.buyers_60)} ({pct(num(c.buyers_60), num(c.members))}){ended(c, 60) ? "" : ` · ${t("进行中")}`}
                  </td>
                  <td className="num">{fmtNum(c.revenue_60, 2)}</td>
                  <td className="nowrap">
                    <button className="ghost small" onClick={() => exportMembers(c)}>{t("汇出名单")}</button>{" "}
                    {isOwner && <button className="ghost small danger" onClick={() => remove(c)}>{t("删除")}</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function MonthlyReport({ settings }: { settings: Settings }) {
  const [rows, setRows] = useState<Monthly[] | null>(null);
  const [err, setErr] = useState("");
  const [month, setMonth] = useState("");
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [agentsErr, setAgentsErr] = useState("");

  const asked = useRef("");   // 最后点的月份：快速连点时，旧月份晚回来的结果丢掉
  async function pick(m: string) {
    asked.current = m;
    setMonth(m);
    setAgents(null);
    setAgentsErr("");
    const from = new Date(m.slice(0, 10) + "T00:00:00");
    const to = new Date(from.getFullYear(), from.getMonth() + 1, 0);
    try {
      const r = await rpc<Agent[]>("bi_customer_agents", { p_from: localISO(from), p_to: localISO(to) });
      if (asked.current === m) setAgents(r ?? []);
    } catch (e) {
      if (asked.current === m) setAgentsErr(errText(e));
    }
  }
  useEffect(() => {
    rpc<Monthly[]>("bi_customer_monthly", { p_months: 12 })
      .then((r) => {
        const data = (r ?? []).slice().reverse();
        setRows(data);
        if (data.length) pick(data[0].month);
      })
      .catch((e) => setErr(errText(e)));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <section className="card">
      <h2>{t("每月顾客报告")}</h2>
      <p className="muted small">
        {t("新客 = 那个月第一次买;回头客 = 以前买过、那个月又来;流失 = 最后一次消费满 {l} 天、在那个月变成流失的人数。只算门市散客,本月是到今天为止。", {
          l: settings.lapsed_days })}
      </p>
      {err && <div className="error">{t("查询失败:")}{err}</div>}
      {rows === null && !err && <p className="muted">{t("载入中…")}</p>}
      {rows && (
        <div className="cu-scroll">
          <table>
            <thead>
              <tr>
                <th>{t("月份")}</th><th className="num">{t("来买的顾客")}</th><th className="num">{t("新客")}</th>
                <th className="num">{t("回头客")}</th><th className="num">{t("回头客占比")}</th>
                <th className="num">{t("新客营业额")}</th><th className="num">{t("回头客营业额")}</th><th className="num">{t("流失")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.month} className={"click" + (r.month === month ? " cu-sel" : "")} onClick={() => pick(r.month)}>
                  <td className="nowrap">{r.month.slice(0, 7)}</td>
                  <td className="num">{fmtNum(r.active)}</td>
                  <td className="num">{fmtNum(r.new_customers)}</td>
                  <td className="num">{fmtNum(r.returning_customers)}</td>
                  <td className="num">{pct(num(r.returning_customers), num(r.active))}</td>
                  <td className="num">{fmtNum(r.new_revenue, 2)}</td>
                  <td className="num">{fmtNum(r.returning_revenue, 2)}</td>
                  <td className="num">{fmtNum(r.lapsed)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {month && (
        <>
          <h3>{t("{m} 各业务员的顾客", { m: month.slice(0, 7) })}</h3>
          {agentsErr && <div className="error">{t("查询失败:")}{agentsErr}</div>}
          {agents === null && !agentsErr && <p className="muted">{t("载入中…")}</p>}
          {agents && (
            <div className="cu-scroll">
              <table>
                <thead>
                  <tr>
                    <th>{t("业务员")}</th><th className="num">{t("顾客")}</th><th className="num">{t("回头客")}</th>
                    <th className="num">{t("新客")}</th><th className="num">{t("营业额")}</th>
                  </tr>
                </thead>
                <tbody>
                  {agents.length === 0 && <tr><td colSpan={5} className="muted">{t("这个月没有门市散客的单")}</td></tr>}
                  {agents.map((a) => (
                    <tr key={a.agent}>
                      <td>{a.agent === "(空白)" ? t("(空白)") : a.agent}</td>
                      <td className="num">{fmtNum(a.customers)}</td>
                      <td className="num">{fmtNum(a.returning_customers)}</td>
                      <td className="num">{fmtNum(a.new_customers)}</td>
                      <td className="num">{fmtNum(a.revenue, 2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}

export function MissingPhone() {
  const [rows, setRows] = useState<Missing[] | null>(null);
  const [err, setErr] = useState("");

  async function load() {
    try {
      setRows(await rpc<Missing[]>("bi_customer_missing_phone", { p_days: 60 }) ?? []);
      setErr("");
    } catch (e) {
      setErr(errText(e));
    }
  }

  return (
    <details className="card" onToggle={(e) => { if ((e.target as HTMLDetailsElement).open && rows === null) load(); }}>
      <summary><b>{t("没抓到电话的门市单据(近 60 天)")}</b></summary>
      <p className="muted small">
        {t("这些单的客户名称没有手机号(或号码少一位),顾客不会出现在名单里。请在 AutoCount 把客户名称改成「名字 + 手机号」,隔天同步后就会补上。")}
      </p>
      {err && <div className="error">{t("查询失败:")}{err}</div>}
      {rows === null && !err && <p className="muted">{t("载入中…")}</p>}
      {rows && (
        <div className="cu-scroll">
          <table>
            <thead>
              <tr><th>{t("日期")}</th><th>{t("门市")}</th><th>{t("单号")}</th><th>{t("单上客户名称")}</th><th>{t("业务员")}</th><th className="num">{t("金额")}</th></tr>
            </thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={6} className="muted">{t("全部都有电话 👍")}</td></tr>}
              {rows.map((x) => (
                <tr key={`${x.company}|${x.doc_type}|${x.doc_no}`}>
                  <td className="nowrap">{fmtDay(x.doc_date)}</td>
                  <td>{STORE[x.company] ?? x.company}</td>
                  <td className="nowrap">{x.doc_no}</td>
                  <td>{x.debtor_name} <span className="muted">({x.debtor_code})</span></td>
                  <td>{x.sales_agent}</td>
                  <td className="num">{fmtNum(x.amount, 2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </details>
  );
}
