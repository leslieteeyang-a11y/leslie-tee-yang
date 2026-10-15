// 顾客资料 · 设定（可审批）：分级门槛与提醒天数（只有管理员能改）、WhatsApp 范本、顾客扫码登记的 QR 网址
import { Fragment, useEffect, useRef, useState } from "react";
import { BI_SITE, errText, num, rpc, Settings, STAGES, t, Template } from "../cust-api";

type Msg = { ok: boolean; text: string } | null;

function toForm(s: Settings) {
  return {
    vip: String(s.vip_min_12m), docs: String(s.regular_min_docs), lapsed: String(s.lapsed_days),
    lead: String(s.lead_follow_days), bday: String(s.birthday_days),
    quote: String(s.quote_follow_days), qmax: String(s.quote_max_days), stage: String(s.stage_follow_days),
    reco: Object.fromEntries(STAGES.map(([k]) => [k, (s.stage_reco?.[k] ?? []).join(", ")])) as Record<string, string>,
  };
}

export function SettingsTab({ isOwner, loaded, settings, templates, onChanged }: {
  isOwner: boolean; loaded: boolean; settings: Settings; templates: Template[]; onChanged: () => void;
}) {
  const [s, setS] = useState(() => toForm(settings));
  const [msg, setMsg] = useState<Msg>(null);
  const [edit, setEdit] = useState<Template | null>(null);
  const [busy, setBusy] = useState(false);
  const dirty = useRef(false);   // 门槛改了还没存：存范本后重新载入设定时不盖掉
  useEffect(() => { if (!dirty.current) setS(toForm(settings)); }, [settings]);
  // 登记送延长保修（月数 0 = 不送）：跟上面的门槛分开存
  const [w, setW] = useState({ months: String(settings.warranty_months ?? 0), back: String(settings.warranty_back_days ?? 90) });
  const wDirty = useRef(false);
  useEffect(() => {
    if (!wDirty.current) setW({ months: String(settings.warranty_months ?? 0), back: String(settings.warranty_back_days ?? 90) });
  }, [settings]);
  const saveWarranty = () => run(async () => {
    await rpc("bi_customer_set_warranty", { p_months: num(w.months), p_back_days: num(w.back) });
    wDirty.current = false;
  });

  async function run(f: () => Promise<unknown>): Promise<boolean> {
    setBusy(true); setMsg(null);
    try { await f(); setMsg({ ok: true, text: t("已储存。") }); onChanged(); return true; }
    catch (e) { setMsg({ ok: false, text: errText(e) }); return false; }
    finally { setBusy(false); }
  }

  const saveSettings = () => run(async () => {
    await rpc("bi_customer_set_settings", {
      p_vip_min_12m: num(s.vip), p_regular_min_docs: num(s.docs), p_lapsed_days: num(s.lapsed),
      p_lead_follow_days: num(s.lead), p_birthday_days: num(s.bday),
      p_quote_follow_days: num(s.quote), p_quote_max_days: num(s.qmax), p_stage_follow_days: num(s.stage),
      p_stage_reco: Object.fromEntries(Object.entries(s.reco).map(([k, v]) => [k,
        v.split(/[,，\s]+/).map((x) => x.trim().toUpperCase()).filter(Boolean)])),
    });
    dirty.current = false;
  });

  async function saveTemplate() {
    if (!edit) return;
    const e = edit;
    if (await run(() => rpc("bi_wa_template_save", { p_id: e.id || null, p_title: e.title, p_body: e.body, p_sort: num(e.sort) }))) {
      setEdit(null);
    }
  }

  function removeTemplate(x: Template) {
    if (!window.confirm(t("删除范本「{n}」?", { n: x.title }))) return;
    run(() => rpc("bi_wa_template_delete", { p_id: x.id }));
  }

  const upd = (k: Exclude<keyof typeof s, "reco">) => (e: { target: { value: string } }) => {
    dirty.current = true;
    setS({ ...s, [k]: e.target.value });
  };
  const field = (label: string, k: Exclude<keyof typeof s, "reco">) => (
    <label>{t(label)}<input value={s[k]} onChange={upd(k)} inputMode="numeric" /></label>
  );

  return (
    <>
      {msg && <div className={msg.ok ? "ok" : "error"}>{msg.text}</div>}
      <div className="cu-forms">
        <section className="card cu-form">
          <h2>{t("分级与提醒")}</h2>
          {!loaded && <p className="muted small">{t("载入中…")}</p>}
          <fieldset className="plain" disabled={!isOwner || busy || !loaded}>
            {field("VIP:近 12 个月消费至少 (RM)", "vip")}
            {field("常客:近 12 个月至少几张单", "docs")}
            {field("流失:超过几天没来", "lapsed")}
            {field("潜在客:建档几天没联络就提醒", "lead")}
            {field("生日:提前几天提醒", "bday")}
            {field("报价:开出几天还没成交就提醒", "quote")}
            {field("报价:超过几天就不再追", "qmax")}
            {field("装修进度:几天没更新就提醒", "stage")}
            <h3>{t("各装修阶段推荐的类别")}</h3>
            <div className="muted small">{t("填 AutoCount 的 Item Group,用逗号分开,例:SANITARY, KITCHEN")}</div>
            {STAGES.map(([k, v]) => (
              <Fragment key={k}>
                <label>{t(v)}
                  <input value={s.reco[k] ?? ""} onChange={(e) => { dirty.current = true; setS({ ...s, reco: { ...s.reco, [k]: e.target.value } }); }} />
                </label>
              </Fragment>
            ))}
            {isOwner && <div className="actions left"><button onClick={saveSettings}>{t("储存")}</button></div>}
          </fieldset>
          {!isOwner && <p className="muted small">{t("只有管理员可以改分级门槛与提醒天数。")}</p>}
        </section>

        <section className="card cu-form">
          <h2>{t("WhatsApp 范本")}</h2>
          <div className="muted small">{t("内容里的 {name} 会换成顾客名字。")}</div>
          {templates.map((x) => (
            <div key={x.id} className="cu-tpl">
              <b>{x.title}</b>
              <div className="muted small pre">{x.body}</div>
              <div className="actions left">
                <button className="ghost small" disabled={busy} onClick={() => setEdit({ ...x })}>{t("修改")}</button>
                <button className="ghost small danger" disabled={busy} onClick={() => removeTemplate(x)}>{t("删除")}</button>
              </div>
            </div>
          ))}
          {!edit && (
            <div className="actions left">
              <button className="ghost" onClick={() => setEdit({ id: 0, title: "", body: "Hi {name}，", sort: templates.length + 1 })}>
                {t("新增范本")}
              </button>
            </div>
          )}
          {edit && (
            <div className="form cu-box">
              <label>{t("标题(按钮上显示)")}<input value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} /></label>
              <label>{t("内容")}<textarea rows={4} value={edit.body} onChange={(e) => setEdit({ ...edit, body: e.target.value })} /></label>
              <label>{t("排序")}
                <input value={String(edit.sort)} onChange={(e) => setEdit({ ...edit, sort: num(e.target.value) })} inputMode="numeric" />
              </label>
              <div className="actions left">
                <button disabled={busy} onClick={saveTemplate}>{t("储存")}</button>
                <button className="ghost" onClick={() => setEdit(null)}>{t("取消")}</button>
              </div>
            </div>
          )}
        </section>

        <section className="card cu-form">
          <h2>{t("登记送延长保修")}</h2>
          <div className="muted small">
            {t("填 0 = 不送。填了月数,顾客扫码登记页会写「登记即享 Hemos 产品保修延长 N 个月」;顾客扫码(或店员在顾客页按「登记延长保修」)就记下来,登记前 N 天内与之后买的 Hemos 产品都算。已登记的顾客以登记当时的月数与起算日为准,之后改设定不影响。")}
          </div>
          <fieldset className="plain" disabled={!isOwner || busy || !loaded}>
            <label>{t("延长几个月(0 = 不送)")}
              <input value={w.months} inputMode="numeric" onChange={(e) => { wDirty.current = true; setW({ ...w, months: e.target.value }); }} />
            </label>
            <label>{t("登记前几天内的购买也算")}
              <input value={w.back} inputMode="numeric" onChange={(e) => { wDirty.current = true; setW({ ...w, back: e.target.value }); }} />
            </label>
            {isOwner && <div className="actions left"><button onClick={saveWarranty}>{t("储存")}</button></div>}
          </fieldset>
          {!isOwner && <p className="muted small">{t("只有管理员可以改。")}</p>}
        </section>

        <section className="card cu-form">
          <h2>{t("顾客自己登记的 QR")}</h2>
          <div className="muted small">
            {t("把下面网址做成 QR 贴在柜台;顾客扫码填完就直接存进顾客资料,在「跟进」分页的「最近扫码登记的顾客」看得到。")}
          </div>
          {["HQ", "JB"].map((st) => (
            <div key={st} className="small">
              <b>{st}</b>: <a href={`${BI_SITE}/join.html?s=${st}`} target="_blank" rel="noreferrer">{`${BI_SITE}/join.html?s=${st}`}</a>
            </div>
          ))}
        </section>
      </div>
    </>
  );
}
