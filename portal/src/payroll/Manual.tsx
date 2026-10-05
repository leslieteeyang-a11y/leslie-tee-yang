// 薪资 · 手动计算（2026-10-05 使用者要求）：员工还没全部开账号、没有打卡资料时，HR 先用这页算薪水。
// 名单与数字只存在这台电脑的浏览器（localStorage），不进资料库；计算规则与「每月计算」相同（calc.ts）。
// 可以列印工资单、WhatsApp、下载 CSV，另可下载 / 载入备份档，换电脑或清浏览器前先备份。
import { ChangeEvent, FormEvent, useEffect, useState } from "react";
import { Empty, Modal, Tabs } from "../ui";
import { calcBase, calcComm, Category, CommType, needsBase, needsComm, PayEmp, PaySettings, r2, workDays } from "./calc";
import { MON, money, PayType, Slip, slipModel } from "../pay-api";
import { PrintSlips, sendWhatsApp, SlipView } from "./Slip";
import { COLS } from "./History";

interface Person {
  id: string; name: string; phone: string; base: number; category: Category;
  skbbk: boolean; noEpf: boolean; noSocso: boolean; noEis: boolean; epfOptIn: boolean;
  commType: CommType; commRate: number; groupComm: boolean; commOnly: boolean; commWithBase: boolean;
}
type Inputs = Record<string, string>;
interface MonthData { wd: string; base: Record<string, Inputs>; comm: Record<string, Inputs> }
interface Store { people: Person[]; months: Record<string, MonthData> }

const KEY = "hw-pay-manual";
const blank = (): Person => ({
  id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: "", phone: "", base: 0, category: "local",
  skbbk: true, noEpf: false, noSocso: false, noEis: false, epfOptIn: false,
  commType: "none", commRate: 0, groupComm: false, commOnly: false, commWithBase: false,
});
function loadStore(): Store {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || "null");
    if (s && Array.isArray(s.people) && s.months) return s;
  } catch { /* 读不到就从空的开始 */ }
  return { people: [], months: {} };
}
const empOf = (p: Person): PayEmp => ({
  base: p.commOnly ? 0 : +p.base || 0, category: p.category, skbbk: p.skbbk, noEpf: p.noEpf, noSocso: p.noSocso, noEis: p.noEis,
  epfOptIn: p.epfOptIn, commType: p.commType, commRate: +p.commRate || 0, groupComm: p.groupComm, commOnly: p.commOnly,
  commWithBase: p.commWithBase,
});

export default function Manual({ set, company }: { set: PaySettings; company: string }) {
  const now = new Date();
  const [store, setStore] = useState<Store>(loadStore);
  const [saveErr, setSaveErr] = useState(false);
  const [y, setY] = useState(now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear());
  const [m, setM] = useState(now.getMonth() === 0 ? 12 : now.getMonth());     // 预设上个月
  const [type, setType] = useState<PayType>("base");
  const [editing, setEditing] = useState<Person | null>(null);
  const [slip, setSlip] = useState<{ s: Slip; phone: string } | null>(null);
  const [printing, setPrinting] = useState<Slip[] | null>(null);

  useEffect(() => {
    try { localStorage.setItem(KEY, JSON.stringify(store)); setSaveErr(false); } catch { setSaveErr(true); }
  }, [store]);

  const mk = `${y}-${m}`;
  const md: MonthData = store.months[mk] || { wd: "", base: {}, comm: {} };
  const workd = +md.wd || workDays(y, m);
  const setMonth = (f: (d: MonthData) => MonthData) => setStore((s) => ({ ...s, months: { ...s.months, [mk]: f(s.months[mk] || { wd: "", base: {}, comm: {} }) } }));
  const edit = (id: string, k: string, v: string) =>
    setMonth((d) => ({ ...d, [type]: { ...d[type], [id]: { ...d[type][id], [k]: v } } }));

  const calcOf = (p: Person, t: PayType) => {
    const i = { ...(md[t][p.id] || {}), year: y, month: m, workDays: workd };
    return t === "base" ? calcBase(empOf(p), i, set) : calcComm(empOf(p), i, set);
  };
  const pool = store.people.filter((p) => (type === "base" ? needsBase(empOf(p)) : needsComm(empOf(p))));
  const results = pool.map((p) => ({ p, c: calcOf(p, type) }));
  const total = results.reduce((a, { c }) => a + ("net" in c ? c.net : c.payout), 0);
  const er = results.reduce((a, { c }) => a + ("net" in c ? c.epfEr + c.socsoEr + c.eisEr : 0), 0);
  // 工资单：这个月有输入过（或本来就该算）的部分都放进去
  const slipOf = (p: Person) => {
    const e = empOf(p);
    const b = needsBase(e) ? calcBase(e, { ...(md.base[p.id] || {}), year: y, month: m, workDays: workd }, set) : undefined;
    const c = needsComm(e) ? calcComm(e, { ...(md.comm[p.id] || {}), year: y, month: m, workDays: workd }, set) : undefined;
    return slipModel(p.name, y, m, b, c);
  };

  function savePerson(p: Person) {
    setStore((s) => ({ ...s, people: s.people.some((x) => x.id === p.id) ? s.people.map((x) => (x.id === p.id ? p : x)) : [...s.people, p] }));
    setEditing(null);
  }
  function removePerson(p: Person) {
    if (!confirm(`从手动名单拿掉 ${p.name}？`)) return;
    setStore((s) => ({ ...s, people: s.people.filter((x) => x.id !== p.id) }));
    setEditing(null);
  }
  function csv() {
    const rows = results.map(({ p, c }) => ({ p, c: c as unknown as Record<string, number> }));
    const used = COLS.filter(([, k]) => rows.some(({ c }) => +(c[k] || 0) !== 0));
    const head = ["序号", "员工", "实收金额", "种类", "年", "月", ...used.map(([h]) => h), "备注"];
    const lines: (string | number)[][] = rows.map(({ p, c }, i) => [i + 1, p.name, r2(type === "base" ? c.net : c.payout),
      type === "base" ? "底薪" : "佣金", y, m, ...used.map(([, k]) => c[k] ?? ""), md[type][p.id]?.remark || ""]);
    lines.push(["", "合计", r2(total)]);
    const text = [head, ...lines].map((l) => l.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\r\n");
    download(new Blob(["﻿" + text], { type: "text/csv;charset=utf-8" }),
      `手动薪资_${y}年${String(m).padStart(2, "0")}月_${type === "base" ? "底薪" : "佣金"}.csv`);
  }
  function backup() {
    download(new Blob([JSON.stringify(store, null, 1)], { type: "application/json" }), `手动薪资备份_${new Date().toISOString().slice(0, 10)}.json`);
  }
  function restore(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    f.text().then((t) => {
      const s = JSON.parse(t);
      if (!s || !Array.isArray(s.people) || !s.months) throw new Error();
      if (confirm(`载入备份：${s.people.length} 位员工。这台电脑现在的手动资料会被取代。确定？`)) setStore(s);
    }).catch(() => alert("这个档案不是手动薪资的备份档。"));
  }
  const field = (p: Person, k: string, label: string, disabled = false) => (
    <label key={k}>{label}
      <input type="number" inputMode="decimal" step="any" disabled={disabled}
             value={md[type][p.id]?.[k] ?? ""} onChange={(e) => edit(p.id, k, e.target.value)} />
    </label>
  );

  return (
    <>
      <p className="small late">这页的资料只存在这台电脑的浏览器，不会进系统。换电脑或清浏览器前，先按下面的「下载备份」。</p>
      {saveErr && <p className="error">浏览器存不了资料（可能是无痕模式）。关掉这页前请先下载备份。</p>}
      <div className="filters">
        <Tabs value={type} onChange={setType} options={[["base", "底薪（月头）"], ["comm", "佣金（15 号）"]]} />
        <select className="pay-mon" value={m} onChange={(e) => setM(+e.target.value)}>{MON.map((n, i) => <option key={i} value={i + 1}>{n}</option>)}</select>
        <input className="num-input" type="number" value={y} onChange={(e) => setY(+e.target.value)} />
        <label className="inline">工作天数<input className="num-input" type="number" step="any" value={md.wd} placeholder={String(workDays(y, m))}
                                             onChange={(e) => setMonth((d) => ({ ...d, wd: e.target.value }))} /></label>
        <button onClick={() => setEditing(blank())}>＋ 加员工</button>
      </div>
      <div className="pay-totbar">
        <div><span>{`${MON[m - 1]} ${type === "base" ? "底薪实收" : "佣金实发"}合计 · ${pool.length} 人`}</span><b>{money(total)}</b></div>
        {type === "base" && <div><span>雇主 EPF + SOCSO + EIS</span><b>{money(er)}</b></div>}
      </div>
      {store.people.length === 0 ? <Empty>还没有员工。按「＋ 加员工」输入名字和底薪。</Empty>
        : pool.length === 0 ? <Empty>这一页没有适用的员工（只拿佣金的人在「佣金」页）。</Empty> : results.map(({ p, c }) => {
          const bits: string[] = [];
          if ("net" in c) {
            if (c.unpaidDeduct) bits.push(`无薪假 −${money(c.unpaidDeduct)}`);
            if (c.otTotal) bits.push(`加班 +${money(c.otTotal)}`);
            bits.push(`EPF ${money(c.epfEmp)} · SOCSO ${money(c.socsoEmp)} · EIS ${money(c.eisEmp)}`);
          } else {
            if (c.groupVoided) bits.push(`迟到满 ${set.lateNoGroup} 次，团体佣金归零`);
            if (c.lateDeduct) bits.push(`迟到扣 ${money(c.lateDeduct)}`);
            if (c.spill) bits.push(`不够扣，结欠 ${money(c.spill)}`);
          }
          return (
            <section key={p.id} className="card pay-row">
              <div className="pay-top">
                <div>
                  <b>{p.name}</b>
                  <div className="muted small">{p.commOnly ? "无底薪" : `底薪 ${money(p.base)}`}</div>
                </div>
                <div className="pay-amt">{money("net" in c ? c.net : c.payout)}</div>
              </div>
              <div className="pay-in">
                {type === "base" ? <>
                  {field(p, "otHours", "加班时数")}{field(p, "unpaidDays", "无薪假天")}
                  {field(p, "pcb", "PCB", (+p.base || 0) <= set.pcbThreshold)}{field(p, "advance", "预支（负数 = 补发）")}
                  {p.commWithBase && (p.commType === "percent" ? field(p, "baseSales", `销售额 × ${p.commRate}%`) : field(p, "basePayComm", "佣金 RM"))}
                </> : <>
                  {p.commType === "percent" && field(p, "sales", `销售额 × ${p.commRate}%`)}
                  {p.groupComm && field(p, "commGroup", "团体佣金")}
                  {field(p, "wrongQty", "包错货（包）")}{field(p, "lateCount", "迟到次数")}{field(p, "otherDeduct", "其他扣（负数 = 补发）")}
                </>}
                <label className="wide">备注<input value={md[type][p.id]?.remark ?? ""} maxLength={500}
                                                 onChange={(e) => edit(p.id, "remark", e.target.value)} /></label>
              </div>
              {bits.length > 0 && <div className="muted small">{bits.join(" · ")}</div>}
              <div className="actions left">
                <button className="ghost small-btn" onClick={() => { const s = slipOf(p); if (s) setSlip({ s, phone: p.phone }); }}>工资单</button>
                <button className="ghost small-btn" onClick={() => setEditing(p)}>改资料</button>
              </div>
            </section>
          );
        })}
      <div className="card pay-save">
        <button className="ghost" disabled={!pool.length}
                onClick={() => setPrinting(store.people.map(slipOf).filter((s): s is Slip => !!s))}>列印本月全部工资单</button>
        <button className="ghost" disabled={!pool.length} onClick={csv}>下载 CSV（Excel）</button>
        <button className="ghost" onClick={backup}>下载备份</button>
        <label className="ghost file-btn">载入备份<input type="file" accept="application/json,.json" hidden onChange={restore} /></label>
        <p className="muted small">数字一改就自动存在这台电脑。计算规则和「每月计算」一样（EPF、SOCSO、EIS、加班、迟到、包错货），但迟到、无薪假要自己填。</p>
      </div>
      {editing && <PersonForm p={editing} isNew={!store.people.some((x) => x.id === editing.id)} onSave={savePerson}
                              onRemove={removePerson} onClose={() => setEditing(null)} />}
      {slip && (
        <Modal title="工资单" onClose={() => setSlip(null)} wide>
          <SlipView s={slip.s} company={company} />
          <div className="actions">
            <button className="ghost" onClick={() => { const err = sendWhatsApp(slip.s, company, slip.phone); if (err) alert(err); }}>WhatsApp 发给员工</button>
            <button onClick={() => setPrinting([slip.s])}>列印 / 存成 PDF</button>
          </div>
        </Modal>
      )}
      {printing && <PrintSlips slips={printing} company={company} onDone={() => setPrinting(null)} />}
    </>
  );
}

function download(b: Blob, name: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(b);
  a.download = name;
  a.click();
}

function PersonForm({ p, isNew, onSave, onRemove, onClose }: {
  p: Person; isNew: boolean; onSave: (p: Person) => void; onRemove: (p: Person) => void; onClose: () => void;
}) {
  const [v, setV] = useState<Person>(p);
  const set = <K extends keyof Person>(k: K, x: Person[K]) => setV({ ...v, [k]: x });
  const chk = (k: "skbbk" | "groupComm" | "commOnly" | "commWithBase" | "epfOptIn", label: string) => (
    <label className="check"><input type="checkbox" checked={v[k]} onChange={(e) => set(k, e.target.checked)} /> {label}</label>
  );
  const has = (k: "noEpf" | "noSocso" | "noEis", label: string) => (
    <label className="check"><input type="checkbox" checked={!v[k]} onChange={(e) => set(k, !e.target.checked)} /> {label}</label>
  );
  function submit(e: FormEvent) {
    e.preventDefault();
    if (!v.name.trim()) return;
    onSave({ ...v, name: v.name.trim(), base: Math.max(0, +v.base || 0), commRate: Math.max(0, +v.commRate || 0) });
  }
  return (
    <Modal title={isNew ? "加员工（手动计算）" : `改资料：${p.name}`} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <div className="row">
          <label>名字（印在工资单上）<input value={v.name} onChange={(e) => set("name", e.target.value)} required autoFocus /></label>
          <label>手机（WhatsApp 工资单）<input value={v.phone} onChange={(e) => set("phone", e.target.value)} placeholder="012-3456789" /></label>
        </div>
        <div className="row">
          <label>底薪 RM<input type="number" step="0.01" min="0" value={v.commOnly ? 0 : v.base} disabled={v.commOnly}
                               onChange={(e) => set("base", Number(e.target.value))} /></label>
          <label>类别
            <select value={v.category} onChange={(e) => set("category", e.target.value as Category)}>
              <option value="local">本地（60 岁以下）</option><option value="local60">本地（60 岁以上）</option><option value="foreign">外劳</option>
            </select>
          </label>
        </div>
        <div className="pay-checks">
          {has("noEpf", "缴 EPF")}{has("noSocso", "缴 SOCSO")}{chk("skbbk", "参加 SKBBK")}{has("noEis", "缴 EIS")}
          {v.category === "foreign" && chk("epfOptIn", "外劳自愿缴 EPF（11% / 13%）")}
        </div>
        <div className="row">
          <label>个人佣金
            <select value={v.commType} onChange={(e) => set("commType", e.target.value as CommType)}>
              <option value="none">没有</option><option value="percent">按销售额 %</option><option value="fixed">每月固定金额</option>
            </select>
          </label>
          {v.commType !== "none" && (
            <label>{v.commType === "percent" ? "抽成 %" : "每月 RM"}<input type="number" step="0.01" min="0" value={v.commRate}
                                                                       onChange={(e) => set("commRate", Number(e.target.value))} /></label>
          )}
        </div>
        <div className="pay-checks">
          {chk("groupComm", "有团体佣金")}{chk("commOnly", "无底薪、只拿佣金")}{chk("commWithBase", "佣金跟底薪一起月头发（不是 15 号）")}
        </div>
        <div className="actions">
          {!isNew && <button type="button" className="ghost danger" onClick={() => onRemove(p)}>从名单拿掉</button>}
          <button type="button" className="ghost" onClick={onClose}>取消</button>
          <button>储存</button>
        </div>
      </form>
    </Modal>
  );
}
