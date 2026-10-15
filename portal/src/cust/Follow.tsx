// 顾客资料 · 跟进：跟进提醒（约好的联络日、报价没成交、生日、新客回访、装修进度、潜在客；规则在资料库 bi_customer_followups）、
// 柜台快速登记、最近扫码登记的顾客
import { useEffect, useState } from "react";
import {
  cleanName, errText, fmtMember, fmtNum, fmtTime, FollowUp, num, Reason, rpc, Settings, Signup, STAGE_LABEL, STAGES, stageNext,
  t, Template, touch,
} from "../cust-api";
import { ConsentTag, MemberLink, WaButtons } from "./Common";

/** items = null：载入中。store：HQ / JB / "" = 两间门市 */
export function FollowUpList({ items, error, store, onStore, settings, templates, canEdit, onOpen, onTouched, onRetry }: {
  items: FollowUp[] | null; error: string; store: string; onStore: (s: string) => void; settings: Settings; templates: Template[];
  canEdit: boolean; onOpen: (id: string) => void; onTouched: () => void; onRetry: () => void;
}) {
  const [shown, setShown] = useState(20);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const done = (e: string) => { setErr(e); if (!e) onTouched(); };
  async function mark(id: string) {
    setBusy(id);
    const e = await touch(id);
    setBusy(null);
    done(e);
  }
  const label = (r: Reason) => {
    if (r.kind === "due") return r.days > 0 ? t("约好联络日已过 {d} 天", { d: r.days }) : t("今天约好联络");
    if (r.kind === "birthday") return r.days === 0 ? t("今天生日 🎂") : t("{d} 天后生日 🎂", { d: r.days });
    if (r.kind === "quote") return t("报价 {d} 天还没成交", { d: r.days });
    if (r.kind === "stage") return t("装修进度 {d} 天没更新", { d: r.days });
    if (r.kind === "new") return t("新客第 {d} 天,还没回来买第二次", { d: r.days });
    return t("潜在客,建档 {d} 天还没联络", { d: r.days });
  };
  return (
    <section className="card">
      <h2>{items === null ? t("跟进提醒") : t("跟进提醒({n} 位)", { n: fmtNum(items.length) })}</h2>
      <div className="toolbar">
        <div className="tabs cu-wrap">
          {[["", t("两间门市")], ["HQ", "HQ"], ["JB", "JB"]].map(([k, v]) => (
            <button key={k} className={store === k ? "on" : ""} onClick={() => { onStore(k); setShown(20); }}>{v}</button>
          ))}
        </div>
      </div>
      <p className="muted small">
        {t("{b} 天内生日、潜在客建档满 {l} 天没联络、约好的下次联络日到了、报价开出 {q} 天还没成交、装修进度 {s} 天没更新。按 WhatsApp 或「已联络」后就会从这里消失。", {
          b: settings.birthday_days, l: settings.lead_follow_days, q: settings.quote_follow_days, s: settings.stage_follow_days })}
        {" "}{t("新客买完第 7 天、第 21 天各提醒一次(回头的顾客有一半在 22 天内买第二次,过了 90 天就很难回来)。")}
      </p>
      {(err || error) && (
        <div className="error">{err || error}
          {!err && <> <button className="ghost" onClick={onRetry}>{t("重试")}</button></>}
        </div>
      )}
      {items === null && !error && <p className="muted">{t("载入中…")}</p>}
      {items !== null && items.length === 0 && <p className="muted">{t("目前没有要跟进的顾客 👍")}</p>}
      {items !== null && items.length > 0 && (
        <ul className="cu-fu">
          {items.slice(0, shown).map(({ c, reasons }) => (
            <li key={c.member_id}>
              <div className="cu-fu-who">
                <MemberLink id={c.member_id} onOpen={onOpen} /> <ConsentTag consent={c.consent} />
                {cleanName(c.name) && <MemberLink id={c.member_id} onOpen={onOpen}><b>{cleanName(c.name)}</b></MemberLink>}
              </div>
              <div className="cu-fu-why">
                {reasons.map((r) => <div key={r.kind}>{label(r)}</div>)}
                {reasons.some((r) => r.kind === "quote") && (
                  <div className="muted small">{t("未成交报价 RM {a}", { a: fmtNum(c.quote_amount, 2) })}</div>
                )}
                {reasons.some((r) => r.kind === "new") && c.categories.length > 0 && (
                  <div className="muted small">{t("买了:{c}", { c: c.categories.join(" / ") })}</div>
                )}
                {c.reno_stage && (
                  <div className="muted small">
                    {t("装修:{s}", { s: t(STAGE_LABEL[c.reno_stage] ?? c.reno_stage) })}
                    {stageNext(c.reno_stage, c.categories, settings).length > 0
                      && ` · ${t("可推荐 {c}", { c: stageNext(c.reno_stage, c.categories, settings).join(" / ") })}`}
                  </div>
                )}
                {c.note && <div className="muted small">{t("备注")}: {c.note}</div>}
              </div>
              <div className="cu-fu-act">
                <WaButtons id={c.member_id} name={cleanName(c.name)} templates={templates} canEdit={canEdit} onTouched={done} />
                {canEdit && (
                  <button className="ghost small" disabled={busy === c.member_id} onClick={() => mark(c.member_id)}>{t("已联络")}</button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {items !== null && items.length > shown && (
        <div className="actions left"><button className="ghost" onClick={() => setShown(shown + 50)}>{t("显示更多")}</button></div>
      )}
    </section>
  );
}

/** 手机版快速登记：电话 + 名字 + 生日 + 同意 + 装修阶段，只写有填的栏位（bi_customer_quick） */
export function QuickRegister({ onSaved, onOpen }: { onSaved: () => void; onOpen: (id: string) => void }) {
  const blank = { phone: "", name: "", bm: "", bd: "", consent: "", stage: "", area: "" };
  const [f, setF] = useState(blank);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; id?: string } | null>(null);
  const upd = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  async function save() {
    if (f.phone.replace(/\D/g, "").length < 8) { setMsg({ ok: false, text: t("请输入完整手机号") }); return; }
    if (!!f.bm !== !!f.bd) { setMsg({ ok: false, text: t("生日要月、日都填,或都不填") }); return; }
    setBusy(true);
    try {
      const r = await rpc<{ member_id: string }>("bi_customer_quick", {
        p_member: f.phone, p_name: f.name, p_birth_month: f.bm ? num(f.bm) : null, p_birth_day: f.bd ? num(f.bd) : null,
        p_consent: f.consent || null, p_reno_stage: f.stage || null, p_area: f.area,
      });
      setMsg({ ok: true, text: t("已登记 {p}。", { p: fmtMember(r.member_id) }), id: r.member_id });
      setF(blank);
      onSaved();
    } catch (e) {
      setMsg({ ok: false, text: errText(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="card cu-quick">
      <summary><b>{t("快速登记")}</b> <span className="muted small">{t("柜台 / 手机用,30 秒填完;只会补上有填的栏位")}</span></summary>
      <div className="cu-quick-grid">
        <label>{t("手机号码")}<input type="tel" inputMode="tel" value={f.phone} onChange={upd("phone")} placeholder="012-345 6789" /></label>
        <label>{t("名字")}<input value={f.name} onChange={upd("name")} /></label>
        <label>{t("生日(月 / 日)")}
          <span className="cu-row">
            <select value={f.bm} onChange={upd("bm")}>
              <option value="">{t("月")}</option>
              {Array.from({ length: 12 }, (_, i) => <option key={i} value={i + 1}>{i + 1}</option>)}
            </select>
            <select value={f.bd} onChange={upd("bd")}>
              <option value="">{t("日")}</option>
              {Array.from({ length: 31 }, (_, i) => <option key={i} value={i + 1}>{i + 1}</option>)}
            </select>
          </span>
        </label>
        <label>{t("同意收促销讯息")}
          <select value={f.consent} onChange={upd("consent")}>
            <option value="">{t("未确认")}</option>
            <option value="yes">{t("同意")}</option>
            <option value="no">{t("不同意")}</option>
          </select>
        </label>
        <label>{t("装修进度")}
          <select value={f.stage} onChange={upd("stage")}>
            <option value="">{t("不知道 / 不填")}</option>
            {STAGES.map(([k, v]) => <option key={k} value={k}>{t(v)}</option>)}
          </select>
        </label>
        <label>{t("地区")}<input value={f.area} onChange={upd("area")} /></label>
      </div>
      <div className="actions left">
        <button disabled={busy} onClick={save}>{t("储存")}</button>
        {msg?.id && <button className="ghost" onClick={() => onOpen(msg.id!)}>{t("打开这位顾客")}</button>}
      </div>
      {msg && <div className={msg.ok ? "ok" : "error"}>{msg.text}</div>}
    </details>
  );
}

/** 顾客扫 QR 登记（2026-10-06 起送出即生效）：列近 14 天扫码登记的顾客给店员跟进；改版前留下的待确认登记仍可确认 / 删掉 */
export function Signups({ canEdit, onDone, onOpen }: { canEdit: boolean; onDone: () => void; onOpen: (id: string) => void }) {
  const [rows, setRows] = useState<Signup[] | null>(null);
  const [err, setErr] = useState("");
  async function load() {
    try {
      setRows(await rpc<Signup[]>("bi_customer_signups") ?? []);
      setErr("");
    } catch (e) {
      setErr(errText(e));
    }
  }
  useEffect(() => { load(); }, []);

  async function handle(x: Signup, accept: boolean) {
    try {
      await rpc("bi_customer_signup_handle", { p_id: x.id, p_accept: accept });
      await load();
      if (accept) onDone();
    } catch (e) {
      setErr(errText(e));
    }
  }

  if (err) return <div className="error">{t("查询失败:")}{err}</div>;
  if (!rows || rows.length === 0) return null;
  return (
    <details className="card" open={rows.some((x) => x.status === "pending")}>
      <summary><b>{t("最近扫码登记的顾客({n} 位,近 14 天)", { n: rows.length })}</b></summary>
      <p className="muted small">
        {t("顾客扫 QR 送出就直接存进顾客资料:已有的名字 / 生日不会被盖掉,地址、电邮与同意收促销以顾客填的为准;每笔改动都在顾客的「修改纪录」。可以在这里打 WhatsApp 欢迎新顾客。")}
      </p>
      <div className="cu-scroll">
        <table>
          <thead>
            <tr><th>{t("时间")}</th><th>{t("电话 / 账号")}</th><th>{t("名字")}</th><th>{t("生日")}</th><th>{t("地址")}</th>
              <th>{t("同意收促销")}</th><th>{t("门市")}</th><th>{t("状态")}</th></tr>
          </thead>
          <tbody>
            {rows.map((x) => (
              <tr key={x.id}>
                <td className="nowrap">{fmtTime(x.created_at)}</td>
                <td className="nowrap"><MemberLink id={x.main_id} onOpen={onOpen} /></td>
                <td>{x.name}{x.current?.name && x.current.name !== x.name
                  ? <div className="muted small">{t("现有:{n}", { n: x.current.name })}</div> : null}</td>
                <td>{x.birth_month ? `${x.birth_month}/${x.birth_day}` : ""}</td>
                <td className="small cu-note">
                  {x.address ?? x.area}
                  {x.email && <div className="muted">{x.email}</div>}
                </td>
                <td>{x.consent ? t("同意") : t("不同意")}</td>
                <td>{x.store}</td>
                <td className="nowrap">
                  {x.status === "pending" && canEdit ? (
                    <>
                      <button className="small" onClick={() => handle(x, true)}>{t("确认")}</button>{" "}
                      <button className="ghost small" onClick={() => handle(x, false)}>{t("不是本人 / 删掉")}</button>
                    </>
                  ) : (
                    <>
                      <span className="muted small">
                        {x.status === "pending" ? t("待确认") : x.current?.last_contact_at ? t("已联络") : t("已登记")}{" "}
                      </span>
                      <button className="ghost small" onClick={() => onOpen(x.main_id)}>{t("打开这位顾客")}</button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
