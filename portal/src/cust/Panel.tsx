// 顾客资料 · 一位顾客：基本资料（可编辑以上能改）、装修进度、报价单、购买历史、合并重复号码（可审批）、修改纪录
import { Fragment, useEffect, useRef, useState } from "react";
import {
  cleanName, CustRole, dbText, Detail, errText, fmtDay, fmtMember, fmtMoney, fmtNum, fmtTime, localISO, LogRow, num, rpc, Settings,
  STAGE_LABEL, STAGES, STORE, t, Template, tierOf, TYPES,
} from "../cust-api";
import { TierTag, WaButtons } from "./Common";

type Msg = { ok: boolean; text: string } | null;
const Note = ({ msg }: { msg: Msg }) => (msg ? <div className={msg.ok ? "ok" : "error"}>{msg.text}</div> : null);

export function CustomerPanel({ id, role, settings, templates, categoriesOf, onBack, onSaved, onOpen }: {
  id: string; role: CustRole; settings: Settings; templates: Template[]; categoriesOf: (id: string) => string[];
  onBack: () => void; onSaved: () => void; onOpen: (id: string) => void;
}) {
  const canEdit = role !== "viewer";
  const canManage = role === "owner" || role === "manager";
  const [d, setD] = useState<Detail | null>(null);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ name: "", bm: "", bd: "", area: "", address: "", ctype: "", note: "", consent: "", next: "" });
  // 员工改过、还没储存的栏位：重新载入（按 WhatsApp、改装修进度、合并之后）只保留这些，其他栏位照资料库
  // （不然储存会把资料库刚改的值盖回去，例：WhatsApp 后资料库清掉的「下次联络日」）
  const edited = useRef(new Set<keyof typeof form>());

  async function load() {
    try {
      const det = await rpc<Detail>("bi_customer", { p_member: id });
      setErr("");
      setD(det);
      const p = det.profile;
      const server = {
        name: p?.name ?? cleanName(det.docs[0]?.debtor_name), bm: p?.birth_month ? String(p.birth_month) : "",
        bd: p?.birth_day ? String(p.birth_day) : "", area: p?.area ?? "", address: p?.address ?? "",
        ctype: p?.customer_type ?? "", note: p?.note ?? "", consent: p?.consent ?? "", next: p?.next_contact ?? "",
      };
      setForm((cur) => {
        const out = { ...server };
        for (const k of edited.current) out[k] = cur[k];
        return out;
      });
    } catch (e) {
      setErr(errText(e));
    }
  }
  useEffect(() => { setD(null); load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const upd = (k: keyof typeof form) => (e: { target: { value: string } }) => {
    edited.current.add(k);
    setForm({ ...form, [k]: e.target.value });
  };

  async function save() {
    if (!!form.bm !== !!form.bd) { setMsg({ ok: false, text: t("生日要月、日都填,或都不填") }); return; }
    setBusy(true);
    try {
      await rpc("bi_customer_save", {
        p_member: d?.member_id ?? id, p_name: form.name, p_birth_month: form.bm ? num(form.bm) : null,
        p_birth_day: form.bd ? num(form.bd) : null, p_area: form.area, p_address: form.address,
        p_customer_type: form.ctype || null, p_note: form.note, p_consent: form.consent || null, p_next_contact: form.next || null,
      });
      setMsg({ ok: true, text: t("已储存。") });
      edited.current.clear();
      await load();
      onSaved();
    } catch (e) {
      setMsg({ ok: false, text: errText(e) });
    } finally {
      setBusy(false);
    }
  }

  async function setStage(stage: string) {
    try {
      await rpc("bi_customer_set_stage", { p_member: d?.member_id ?? id, p_stage: stage || null });
      setMsg({ ok: true, text: t("装修阶段已更新。") });
      await load();
      onSaved();
    } catch (e) {
      setMsg({ ok: false, text: errText(e) });
    }
  }

  const key = d?.member_id ?? id;
  const categories = categoriesOf(key);
  const docs = d?.docs ?? [];
  const stores = Array.from(new Set(docs.map((x) => STORE[x.company] ?? x.company))).sort().join(" + ");
  const spent = docs.reduce((s, x) => s + num(x.amount), 0);
  const cutoff = localISO(new Date(Date.now() - 365 * 86400000));
  const recent = docs.filter((x) => x.doc_date > cutoff);
  const tier = tierOf({
    last_date: docs[0]?.doc_date ?? null, spent_12m: recent.reduce((s, x) => s + num(x.amount), 0),
    doc_count_12m: recent.filter((x) => num(x.amount) > 0).length,
  }, settings);
  const p = d?.profile;

  return (
    <>
      <div className="toolbar"><button className="ghost" onClick={onBack}>{t("← 返回")}</button></div>
      <div className="card">
        <h2 className="cu-title">{form.name || fmtMember(key)} {d && <TierTag tier={tier} />}</h2>
        <div className="muted small">
          {fmtMember(key)}{stores ? ` · ${stores}` : ""}
          {docs.length ? ` · ${t("首次消费")} ${fmtDay(docs[docs.length - 1].doc_date)}` : ""}
          {d && !docs.length ? ` · ${t("还没有购买纪录")}` : ""}
          {p?.last_contact_at ? ` · ${t("上次联络")} ${fmtDay(localISO(new Date(p.last_contact_at)))}` : ""}
          {p?.email ? ` · ${p.email}` : ""}
        </div>
        {err && <div className="error">{t("查询失败:")}{err}</div>}
        {!d && !err && <p className="muted">{t("载入中…")}</p>}
        {d && (
          <>
            <div className="cu-wa-row">
              <WaButtons id={key} name={form.name} templates={templates} canEdit={canEdit}
                         onTouched={(e) => { if (e) setMsg({ ok: false, text: e }); else { load(); onSaved(); } }} />
            </div>
            <div className="kpis cu-kpis">
              <div className="kpi"><b>{fmtMoney(spent)}</b>
                <span>{t("累计消费")} · {t("{n} 张单", { n: fmtNum(docs.filter((x) => num(x.amount) > 0).length) })}</span></div>
              <div className="kpi"><b>{docs.length ? fmtDay(docs[0].doc_date) : "–"}</b>
                <span>{t("最后消费")}{docs[0]?.sales_agent ? ` · ${t("业务员 {a}", { a: docs[0].sales_agent })}` : ""}</span></div>
            </div>
            {!canEdit && <p className="muted small">{t("你的权限是「只看」:可以看,不能改。")}</p>}
            <fieldset className="plain cu-forms" disabled={!canEdit || busy}>
              <div className="form cu-form">
                <h3>{t("基本资料")}</h3>
                <label>{t("名字")}<input value={form.name} onChange={upd("name")} /></label>
                <label>{t("生日(月 / 日)")}
                  <span className="cu-row">
                    <select value={form.bm} onChange={upd("bm")}>
                      <option value="">{t("月")}</option>
                      {Array.from({ length: 12 }, (_, i) => <option key={i} value={i + 1}>{i + 1}</option>)}
                    </select>
                    <select value={form.bd} onChange={upd("bd")}>
                      <option value="">{t("日")}</option>
                      {Array.from({ length: 31 }, (_, i) => <option key={i} value={i + 1}>{i + 1}</option>)}
                    </select>
                  </span>
                </label>
                <label>{t("类型")}
                  <select value={form.ctype} onChange={upd("ctype")}>
                    <option value="">{t("请选择")}</option>
                    {TYPES.map((x) => <option key={x} value={x}>{t(x)}</option>)}
                  </select>
                </label>
                <label>{t("同意收促销讯息")}
                  <select value={form.consent} onChange={upd("consent")}>
                    <option value="">{t("未确认")}</option>
                    <option value="yes">{t("同意")}</option>
                    <option value="no">{t("不同意")}</option>
                  </select>
                </label>
                {p?.consent_at && (
                  <div className="muted small">{t("{w} 于 {d} 登记", { w: dbText(p.consent_by), d: fmtDay(localISO(new Date(p.consent_at))) })}</div>
                )}
              </div>
              <div className="form cu-form">
                <label>{t("地区(例:Skudai、Mount Austin、新加坡)")}<input value={form.area} onChange={upd("area")} /></label>
                <label>{t("地址(选填)")}<input value={form.address} onChange={upd("address")} /></label>
                <label>{t("备注(例:装修中、喜欢黑色款)")}<textarea value={form.note} onChange={upd("note")} rows={3} /></label>
                <label>{t("下次联络日期(到期会出现在跟进提醒)")}<input type="date" value={form.next} onChange={upd("next")} /></label>
                {canEdit && <div className="actions left"><button disabled={busy} onClick={save}>{t("储存")}</button></div>}
                {p?.updated_at && (
                  <div className="muted small">{t("上次修改")}: {fmtTime(p.updated_at)} {dbText(p.updated_by)}</div>
                )}
              </div>
            </fieldset>
            <Note msg={msg} />

            <StageBox stage={p?.reno_stage ?? ""} since={p?.reno_stage_at ?? null} settings={settings}
                      categories={categories} canEdit={canEdit} onChange={setStage} />

            {(d.quotes ?? []).length > 0 && (
              <>
                <h3>{t("报价单({n} 张)", { n: fmtNum((d.quotes ?? []).length) })}</h3>
                <div className="cu-scroll">
                  <table>
                    <thead>
                      <tr><th>{t("日期")}</th><th>{t("门市")}</th><th>{t("单号")}</th><th>{t("业务员")}</th><th>{t("货品")}</th>
                        <th className="num">{t("金额")}</th><th>{t("状态")}</th></tr>
                    </thead>
                    <tbody>
                      {(d.quotes ?? []).map((q) => (
                        <tr key={`${q.company}|${q.doc_no}`}>
                          <td className="nowrap">{fmtDay(q.doc_date)}</td>
                          <td>{STORE[q.company] ?? q.company}</td>
                          <td className="nowrap">{q.doc_no}</td>
                          <td>{q.sales_agent}</td>
                          <td className="muted small cu-wide">{q.items}</td>
                          <td className="num">{fmtNum(q.amount, 2)}</td>
                          <td className="nowrap">{q.transferred ? t("已转单") : q.bought_after ? t("之后有买") : <b>{t("未成交")}</b>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}

            <h3>{t("购买历史({n} 张单)", { n: fmtNum(docs.length) })}</h3>
            <div className="cu-scroll">
              <table>
                <thead>
                  <tr><th>{t("日期")}</th><th>{t("门市")}</th><th>{t("单号")}</th><th>{t("业务员")}</th><th className="num">{t("金额")}</th></tr>
                </thead>
                <tbody>
                  {docs.length === 0 && <tr><td colSpan={5} className="muted">{t("没有消费纪录")}</td></tr>}
                  {docs.map((x) => {
                    const k = `${x.company}|${x.doc_type}|${x.doc_no}`;
                    return (
                      <Fragment key={k}>
                        <tr className="click" onClick={() => setOpen(open === k ? null : k)}>
                          <td className="nowrap">{fmtDay(x.doc_date)}</td>
                          <td>{STORE[x.company] ?? x.company}</td>
                          <td className="nowrap">{open === k ? "▾ " : "▸ "}{x.doc_no}{x.doc_type === "CN" ? ` (${t("退货")})` : ""}</td>
                          <td>{x.sales_agent}</td>
                          <td className={"num" + (num(x.amount) < 0 ? " cu-neg" : "")}>{fmtNum(x.amount, 2)}</td>
                        </tr>
                        {open === k && (
                          <tr>
                            <td colSpan={5} className="cu-items">
                              <table>
                                <tbody>
                                  {x.items.map((it, i) => (
                                    <tr key={i}>
                                      <td className="nowrap">{it.item_code ?? ""}</td>
                                      <td>{it.description}</td>
                                      <td className="num">{fmtNum(it.qty)} {it.uom ?? ""}</td>
                                      <td className="num">{fmtNum(it.sub_total, 2)}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                              {x.debtor_name && <div className="muted small">{t("单上客户名称")}: {x.debtor_name} ({x.debtor_code})</div>}
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <MergeBox id={key} aliases={d.aliases ?? []} canManage={canManage}
                      onDone={(main) => { onSaved(); if (main !== key) onOpen(main); else load(); }} />
            <ChangeLog id={key} />
          </>
        )}
      </div>
    </>
  );
}

const FIELD_LABEL: Record<string, string> = {
  name: "名字", birth_month: "生日月", birth_day: "生日日", area: "地区", address: "地址", customer_type: "类型",
  note: "备注", consent: "同意收促销", next_contact: "下次联络", last_contact_at: "联络", reno_stage: "装修阶段", email: "电邮",
};

function fmtVal(k: string, v: unknown): string {
  if (v == null || v === "") return "–";
  if (k === "consent") return v === "yes" ? t("同意") : v === "no" ? t("不同意") : String(v);
  if (k === "reno_stage") return t(STAGE_LABEL[String(v)] ?? String(v));
  if (k === "last_contact_at") return fmtTime(String(v));
  if (k === "customer_type") return t(String(v));
  return String(v);
}

function StageBox({ stage, since, settings, categories, canEdit, onChange }: {
  stage: string; since: string | null; settings: Settings; categories: string[]; canEdit: boolean; onChange: (s: string) => void;
}) {
  const reco = settings.stage_reco?.[stage] ?? [];
  return (
    <div className="cu-box">
      <div className="toolbar">
        <b>{t("装修进度")}</b>
        <div className="tabs">
          {STAGES.map(([k, v]) => (
            <button key={k} className={stage === k ? "on" : ""} disabled={!canEdit}
                    onClick={() => onChange(stage === k ? "" : k)}>{t(v)}</button>
          ))}
        </div>
        {since && <span className="muted small">{t("{d} 更新", { d: fmtDay(localISO(new Date(since))) })}</span>}
      </div>
      {stage && reco.length > 0 && (
        <div className="small">
          {t("这个阶段可以推荐:")}{" "}
          {reco.map((c) => (
            <span key={c} className={"cu-tag " + (categories.includes(c) ? "cu-tier-normal" : "cu-tier-lead")}>
              {c}{categories.includes(c) ? ` ✓ ${t("买过")}` : ""}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function MergeBox({ id, aliases, canManage, onDone }: {
  id: string; aliases: string[]; canManage: boolean; onDone: (main: string) => void;
}) {
  const [other, setOther] = useState("");
  const [msg, setMsg] = useState<Msg>(null);
  if (!canManage && !aliases.length) return null;

  async function merge() {
    if (other.replace(/\D/g, "").length < 8 && !other.startsWith("A:")) { setMsg({ ok: false, text: t("请输入完整手机号") }); return; }
    if (!window.confirm(t("把 {o} 的购买纪录与资料合并到 {m}?之后两个号码都会显示成同一位顾客(可以再取消合并)。", {
      o: other, m: fmtMember(id) }))) return;
    try {
      await rpc("bi_customer_merge", { p_keep: id, p_drop: other });
      setOther("");
      setMsg({ ok: true, text: t("已合并。") });
      onDone(id);
    } catch (e) {
      setMsg({ ok: false, text: errText(e) });
    }
  }

  async function unmerge(a: string) {
    if (!window.confirm(t("取消合并 {a}?它的购买纪录会回到自己的号码(已合并过来的资料留在这里)。", { a: fmtMember(a) }))) return;
    try {
      await rpc("bi_customer_unmerge", { p_alias: a });
      setMsg({ ok: true, text: t("已取消合并。") });
      onDone(id);
    } catch (e) {
      setMsg({ ok: false, text: errText(e) });
    }
  }

  return (
    <div className="cu-box">
      <b>{t("合并重复顾客")}</b>
      {aliases.length > 0 && (
        <div className="small">
          {t("已合并进来的号码:")}{" "}
          {aliases.map((a) => (
            <span key={a} className="cu-alias">
              {fmtMember(a)}{canManage && <button className="ghost small" onClick={() => unmerge(a)}>{t("取消合并")}</button>}
            </span>
          ))}
        </div>
      )}
      {canManage && (
        <div className="toolbar">
          <input className="cu-short" placeholder={t("同一个人的另一个电话")} value={other} onChange={(e) => setOther(e.target.value)} />
          <button className="ghost" onClick={merge}>{t("合并进来")}</button>
        </div>
      )}
      <Note msg={msg} />
    </div>
  );
}

function ChangeLog({ id }: { id: string }) {
  const [rows, setRows] = useState<LogRow[] | null>(null);
  const [err, setErr] = useState("");
  async function load() {
    try {
      setRows(await rpc<LogRow[]>("bi_customer_log", { p_member: id }) ?? []);
      setErr("");
    } catch (e) {
      setErr(errText(e));
    }
  }
  const act: Record<string, string> = { insert: "建档", update: "修改", delete: "删除", merge: "合并", unmerge: "取消合并" };
  return (
    <details className="cu-log" onToggle={(e) => { if ((e.target as HTMLDetailsElement).open) load(); }}>
      <summary className="small">{t("修改纪录")}</summary>
      {err && <div className="error">{t("查询失败:")}{err}</div>}
      {rows && rows.length === 0 && <div className="muted small">{t("还没有纪录")}</div>}
      {rows && rows.length > 0 && (
        <div className="cu-scroll">
          <table>
            <thead><tr><th>{t("时间")}</th><th>{t("谁")}</th><th>{t("动作")}</th><th>{t("改了什么")}</th></tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td className="nowrap">{fmtTime(r.at)}</td>
                  <td>{dbText(r.by)}</td>
                  <td className="nowrap">{t(act[r.action] ?? r.action)}{r.member_id !== id ? ` (${fmtMember(r.member_id)})` : ""}</td>
                  <td className="small cu-wide">
                    {Object.entries(r.changes).map(([k, v]) => {
                      if (k === "merged" || k === "unmerged") return <div key={k}>{fmtMember(String(v))}</div>;
                      const [o, nv] = Array.isArray(v) ? v : [null, v];
                      return <div key={k}>{t(FIELD_LABEL[k] ?? k)}: {fmtVal(k, o)} → {fmtVal(k, nv)}</div>;
                    })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </details>
  );
}
