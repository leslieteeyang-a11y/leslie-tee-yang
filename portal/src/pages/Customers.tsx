// 顾客资料：门市顾客以电话认人、总部与 JB 合并；跟进提醒、一键 WhatsApp、快速登记、扫码登记、促销活动、每月报告。
// 路由 #/customers/<分页>；一位顾客 #/customers/c/<顾客编号>（电话 60… 或账号 A:公司:代号）。
// 资料与 BI 的顾客资料页（loyalty.html）共用 bi.customer_*；权限 = 「顾客资料」模块（migration 20261016_ops_customers.sql）：
// 只看 = 看；可编辑 = 改资料、登记、联络；可审批 = 汇出、合并、活动、范本；管理员 = 分级门槛、删活动。
// 这一页自己带中英文（cust/dict.ts），所以整页 translate="no"。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Me } from "../api";
import { go } from "../router";
import { ErrorBox, Tabs } from "../ui";
import {
  custRole, CustRole, Customer, DEFAULT_SETTINGS, errText, fmtNum, FollowUp, followRows, Reason, rpc, Settings, storeOf, t, Template,
  daysSince,
} from "../cust-api";
import { CustomerList } from "../cust/List";
import { CustomerPanel } from "../cust/Panel";
import { FollowUpList, QuickRegister, Signups } from "../cust/Follow";
import { Campaigns, MissingPhone, MonthlyReport, StaffBoardBox } from "../cust/Reports";
import { SettingsTab } from "../cust/SettingsTab";
import "../cust.css";

type Tab = "follow" | "list" | "campaigns" | "report" | "setup";

export default function Customers({ me, sub, arg }: { me: Me; sub?: string; arg?: string }) {
  const [role, setRole] = useState<CustRole | null | undefined>(undefined);
  const [list, setList] = useState<Customer[] | null>(null);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [error, setError] = useState("");
  const [roleErr, setRoleErr] = useState("");
  const [settingsErr, setSettingsErr] = useState("");
  const [settingsLoaded, setSettingsLoaded] = useState(false);   // 还没拿到真的设定前，设定分页不给存（免得把预设值存回去）
  // 跟进提醒：资料库算好的（规则与首页同一套），预设只看自己门市（全部分店 = 两边）
  const [fstore, setFstore] = useState(() => storeOf(me.staff.branch));
  const [frows, setFrows] = useState<{ member_id: string; reasons: Reason[] }[] | null>(null);
  const [ferr, setFerr] = useState("");
  const fasked = useRef("");
  const fseq = useRef(0);   // 跟进提醒：连续重新载入时只收最后一次的回应（旧的比较晚回来不会盖掉新的）
  const lastTab = useRef<Tab>("follow");
  const scrollAt = useRef(0);        // 打开顾客前名单卷到哪里，回来时卷回去

  const load = useCallback(async () => {
    // bi_customers_all 回传一个 JSON 阵列：API 每次最多回 1,000 列，直接读 bi_customers 只会拿到前 1,000 位
    try {
      const r = await rpc<Customer[]>("bi_customers_all");
      setList((r ?? []).map((c) => ({ ...c, categories: c.categories ?? [] })));
      setError("");
    } catch (e) {
      setError(errText(e));
      setList((old) => old ?? []);
    }
  }, []);
  const loadSettings = useCallback(async () => {
    // 两个各自套用：范本拿不到不能连设定都丢掉（不然分级、提醒照预设值算）
    const [s, w] = await Promise.allSettled([rpc<Partial<Settings> | null>("bi_customer_settings"), rpc<Template[]>("bi_wa_templates")]);
    if (s.status === "fulfilled") {
      const v = s.value;
      if (v) setSettings({ ...DEFAULT_SETTINGS, ...v, stage_reco: v.stage_reco ?? DEFAULT_SETTINGS.stage_reco });
      setSettingsLoaded(true);
    }
    if (w.status === "fulfilled") setTemplates(w.value ?? []);
    const bad = [s, w].find((x) => x.status === "rejected") as PromiseRejectedResult | undefined;
    setSettingsErr(bad ? errText(bad.reason) : "");
  }, []);
  const loadFollow = useCallback(async (store: string) => {
    fasked.current = store;
    const n = ++fseq.current;
    try {
      const r = await followRows(store);
      if (fseq.current === n) { setFrows(r ?? []); setFerr(""); }
    } catch (e) {
      if (fseq.current === n) setFerr(errText(e));
    }
  }, []);
  useEffect(() => { setFrows(null); setFerr(""); loadFollow(fstore); }, [fstore, loadFollow]);
  // 存了资料 / 联络过：名单与跟进提醒一起重新载入
  const reload = useCallback(() => { load(); loadFollow(fasked.current); }, [load, loadFollow]);
  const loadAll = useCallback(() => {
    setRoleErr("");
    // 拿不到角色（断线等）不当成「没有权限」，给重试
    custRole().then((r) => setRole(r ?? null)).catch((e) => setRoleErr(errText(e)));
    load();
    loadSettings();
  }, [load, loadSettings]);
  useEffect(loadAll, [loadAll]);

  let memberId = "";
  if (sub === "c" && arg) {
    try { memberId = decodeURIComponent(arg); } catch { memberId = arg; }
  }
  // 从顾客回到名单：卷回原来的位置（名单一直挂着，筛选条件也还在）
  useEffect(() => {
    if (!memberId && scrollAt.current) {
      const y = scrollAt.current;
      scrollAt.current = 0;
      requestAnimationFrame(() => window.scrollTo({ top: y }));
    }
  }, [memberId]);

  const follow = useMemo<FollowUp[]>(() => {
    const byId = new Map((list ?? []).map((c) => [c.member_id, c]));
    return (frows ?? []).flatMap((r) => { const c = byId.get(r.member_id); return c ? [{ c, reasons: r.reasons }] : []; });
  }, [list, frows]);
  const totals = useMemo(() => {
    const all = list ?? [];
    const month = new Date().getMonth() + 1;
    return {
      count: all.length,
      active: all.filter((c) => daysSince(c.last_date) <= 365).length,
      profiled: all.filter((c) => c.profile_updated_at).length,
      birthday: all.filter((c) => c.birth_month === month).length,
      consent: all.filter((c) => c.consent === "yes").length,
    };
  }, [list]);

  if (roleErr) {
    return (
      <div translate="no">
        <ErrorBox error={t("查询失败:") + roleErr} />
        <button className="ghost" onClick={loadAll}>{t("重试")}</button>
      </div>
    );
  }
  if (role === undefined || list === null) {
    return <div translate="no">{error ? <ErrorBox error={error} /> : <p className="muted">{t("载入中…")}</p>}</div>;
  }
  if (role === null) {
    return (
      <div translate="no" className="card narrow">
        <h2>{t("没有权限")}</h2>
        <p>{t("你没有「顾客资料」的权限。需要的话请找管理员在「员工与权限」开通。")}</p>
        <ErrorBox error={error} />
      </div>
    );
  }

  const canEdit = role !== "viewer";
  const canManage = role === "owner" || role === "manager";
  const isOwner = role === "owner";
  const tabs: [Tab, string][] = [["follow", t("跟进")], ["list", t("顾客")]];
  if (canManage) tabs.push(["campaigns", t("促销活动")]);
  tabs.push(["report", t("报告")]);
  if (canManage) tabs.push(["setup", t("设定")]);

  const open = (id: string) => {
    if (!memberId) scrollAt.current = window.scrollY;
    go(`/customers/c/${encodeURIComponent(id)}`);
    // 在这一笔浏览纪录上做记号：「返回」只在这种纪录上用浏览器的上一页（直接开连结进来的就回分页，不会跳出营运系统）
    window.history.replaceState({ ...(window.history.state ?? {}), custFromPage: true }, "");
    window.scrollTo({ top: 0 });
  };
  const back = () => {
    if (window.history.state?.custFromPage) window.history.back();
    else go(`/customers/${lastTab.current}`);
  };
  const categoriesOf = (id: string) => list.find((c) => c.member_id === id)?.categories ?? [];
  if (!memberId && tabs.some(([k]) => k === sub)) lastTab.current = sub as Tab;
  else if (!memberId) lastTab.current = "follow";
  // 打开一位顾客时，原来的分页还挂着（藏起来），回来时筛选、捲动位置都在
  const tab: Tab = lastTab.current;

  return (
    <div translate="no">
      <div className="page-head">
        <h1>{t("顾客资料")}</h1>
      </div>
      <p className="muted small">
        {t("门市顾客以电话认人,总部与 JB 合并;购买纪录每天中午从 AutoCount 同步。开单时客户名称写「名字 + 手机号」,顾客才会出现在这里。")}
      </p>
      <ErrorBox error={error} />
      {settingsErr && <ErrorBox error={t("查询失败:") + settingsErr} />}
      {memberId && (
        <CustomerPanel key={memberId} id={memberId} role={role} settings={settings} templates={templates}
                       categoriesOf={categoriesOf} onBack={back} onSaved={reload} onOpen={open} />
      )}
      <div hidden={!!memberId}>
        {/* 藏起来时量不到宽度，「右边还有分页」的淡出提示会算错：回来时重新挂上 */}
        <div className="filters"><Tabs key={memberId ? "hidden" : "shown"} value={tab} options={tabs} onChange={(k) => go(`/customers/${k}`)} /></div>
        {(tab === "follow" || tab === "list") && (
          <div className="kpis">
            <div className="kpi"><b>{fmtNum(totals.count)}</b>
              <span>{t("顾客人数")} · {t("近 12 个月有消费 {a} 位", { a: fmtNum(totals.active) })}</span></div>
            <div className="kpi"><b>{fmtNum(totals.profiled)}</b><span>{t("已补资料")} · {t("有填名字 / 生日 / 地区等")}</span></div>
            <div className="kpi"><b>{fmtNum(totals.consent)}</b><span>{t("同意收促销")} · {t("只有这些人会被汇出 / 放进活动")}</span></div>
            <div className="kpi"><b>{frows === null ? "…" : fmtNum(follow.length)}</b>
              <span>{t("待跟进")} · {t("本月生日 {b} 位", { b: fmtNum(totals.birthday) })}</span></div>
          </div>
        )}
        {tab === "follow" && (
          <>
            {canEdit && <QuickRegister onSaved={reload} onOpen={open} />}
            <FollowUpList items={frows === null ? null : follow} error={ferr} store={fstore} onStore={setFstore} settings={settings}
                          templates={templates} canEdit={canEdit} onOpen={open} onTouched={reload}
                          onRetry={() => { setFrows(null); setFerr(""); loadFollow(fasked.current); }} />
            <Signups canEdit={canEdit} onDone={reload} onOpen={open} />
          </>
        )}
        {tab === "list" && (
          <CustomerList list={list} settings={settings} role={role} onOpen={open} />
        )}
        {tab === "campaigns" && <Campaigns isOwner={isOwner} list={list} settings={settings} />}
        {tab === "report" && (
          <>
            <StaffBoardBox />
            <MonthlyReport settings={settings} />
            <MissingPhone />
          </>
        )}
        {tab === "setup" && (
          <SettingsTab isOwner={isOwner} loaded={settingsLoaded} settings={settings} templates={templates} onChanged={loadSettings} />
        )}
      </div>
    </div>
  );
}
