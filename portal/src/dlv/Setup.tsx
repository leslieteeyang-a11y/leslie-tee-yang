// 送货安装 · 设定（可审批）：出发点（排路线从这里开始）、外包司机。员工司机在「员工与权限」管理。
import { useEffect, useState } from "react";
import { BRANCH_LABEL } from "../api";
import { dlv, DlvMeta, fmtPhone, geocode, parseCoords, STORE, ui } from "../dlv-api";
import { ErrorBox } from "../ui";

export function SetupTab({ meta, company, onChanged }: { meta: DlvMeta; company: string; onChanged: () => void }) {
  const store = STORE[company];
  const depot = meta.depot[store] ?? null;
  const [addr, setAddr] = useState(depot?.address ?? "");
  const [coords, setCoords] = useState(depot ? `${depot.lat}, ${depot.lng}` : "");
  const [dname, setDname] = useState("");
  const [dphone, setDphone] = useState("");
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState("");
  const [error, setError] = useState("");
  useEffect(() => { setAddr(depot?.address ?? ""); setCoords(depot ? `${depot.lat}, ${depot.lng}` : ""); }, [depot, store]);

  const staffDrivers = meta.drivers.filter((d) => d.kind === "staff" && (!d.store || d.store === store));
  const extDrivers = meta.drivers.filter((d) => d.kind === "ext" && (!d.store || d.store === store));

  async function run(f: () => Promise<unknown>, ok: string): Promise<boolean> {
    setBusy(true); setError(""); setInfo("");
    try { await f(); setInfo(ok); onChanged(); return true; }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); return false; }
    finally { setBusy(false); }
  }

  async function saveDepot() {
    let c: { lat: number; lng: number; approx?: boolean } | null = parseCoords(coords);
    if (!c && addr.trim()) {
      setBusy(true); setError(""); setInfo("找出发点的位置中…");
      try { c = await geocode(addr); } finally { setBusy(false); }
    }
    if (!c) { setError("找不到出发点的位置，请贴 Google Maps 坐标（在 Google Maps 长按那个地点就看得到）。"); setInfo(""); return; }
    if (c.approx) {
      // 只找到邮区中心：出发点要准，不自动存；把大概坐标放进去，请他贴准确的
      setCoords(`${c.lat}, ${c.lng}`); setInfo("");
      setError("只找到邮区的大概位置。请在 Google Maps 长按店的位置，把坐标贴进「坐标」再储存。");
      return;
    }
    const at = c;
    await run(() => dlv.setDepot(company, addr, at.lat, at.lng), "出发点已储存。");
  }

  function addDriver() {
    if (!dname.trim()) { setError("请填司机名字。"); return; }
    if (dphone.replace(/\D/g, "").length < 8) { setError("请填司机的手机号码（例：0123456789），WhatsApp 要用。"); return; }   // 细的检查在资料库（马来西亚 / 新加坡手机）
    run(() => dlv.saveDriver({ name: dname, phone: dphone, company }), "已新增外包司机，在「排单」的「选司机」就选得到。")
      .then((ok) => { if (ok) { setDname(""); setDphone(""); } });
  }

  return (
    <>
      <ErrorBox error={error} />
      {info && <p className="ok">{info}</p>}
      <section className="card">
        <h2>{`出发点（${BRANCH_LABEL[company] ?? company}）`}</h2>
        <p className="muted small">排最短路线从这里开始算；WhatsApp 清单的 Google Maps 全程路线也从这里出发。</p>
        <div className="form">
          <label>地址<input value={addr} onChange={(e) => {
            setAddr(e.target.value);
            // 改了地址：原本带入的坐标是旧地点的，清掉让它照新地址找（自己贴的坐标不动）
            if (depot && coords === `${depot.lat}, ${depot.lng}`) setCoords("");
          }} /></label>
          <label>坐标（选填；找不到时贴 Google Maps 的位置）
            <input value={coords} onChange={(e) => setCoords(e.target.value)} placeholder="1.5321, 103.6612" />
          </label>
        </div>
        <div className="actions left"><button disabled={busy} onClick={saveDepot}>储存出发点</button></div>
      </section>

      <section className="card">
        <h2>司机</h2>
        <h3>员工司机</h3>
        <p className="muted small">「送货安装」部门、有填手机号码的在职员工会自动列出；他们登入营运系统，在「我的送货」直接签收。要新增请到「员工与权限」。</p>
        {staffDrivers.length === 0 ? <p className="muted">还没有。</p> : (
          <ul className="list">{staffDrivers.map((d) => <li key={d.id}><span>{d.name}</span><span className="muted">{fmtPhone(d.phone)}</span></li>)}</ul>
        )}
        <h3>外包司机</h3>
        <p className="muted small">不是员工的司机：他们收到 WhatsApp 后用里面的签收连结，不用登入。</p>
        {extDrivers.length > 0 && (
          <ul className="list">
            {extDrivers.map((d) => (
              <li key={d.id}>
                <span>{d.name} <span className="muted">{fmtPhone(d.phone)}</span></span>
                <button className="ghost small" disabled={busy}
                        onClick={() => window.confirm(ui(`不再列出司机 ${d.name}？`))
                          && run(() => dlv.saveDriver({ id: d.id, name: d.name, phone: d.phone, company, active: false }), "已移除。")}>
                  移除
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="toolbar">
          <input placeholder="名字" value={dname} onChange={(e) => setDname(e.target.value)} />
          <input placeholder="手机号码" value={dphone} onChange={(e) => setDphone(e.target.value)} inputMode="tel" />
          <button disabled={busy} onClick={addDriver}>新增外包司机</button>
        </div>
      </section>
    </>
  );
}
