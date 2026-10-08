// 送货 · 排单：整串 DO 单号 → 顾客与送货地址 → 找坐标、排最短路线 → 选司机 → WhatsApp 整张清单（含签收连结）。
// 只看的人（门市）用同一页查 DO 与地址，但不能改、不能排单。
import { useEffect, useRef, useState } from "react";
import {
  dlv, DlvMeta, driverLink, driverMessage, fmtLine, fmtPhone, geocode, Hit, newToken, orderStops, OSM_CREDIT, parseCoords, phoneOf,
  routeKm, splitDocNos, Stop, STORE, todayKL, toStop, ui,
} from "../dlv-api";
import { ErrorBox } from "../ui";

export function PlanTab({ meta, company, readOnly, onSent, seed, onSeedUsed }: {
  meta: DlvMeta; company: string; readOnly: boolean; onSent: () => void;
  seed?: Stop[] | null; onSeedUsed?: () => void;      // 从「排单纪录」载入一趟旧的排单
}) {
  const store = STORE[company];
  const depot = meta.depot[store] ?? null;
  const drivers = meta.drivers.filter((d) => !d.store || d.store === store);
  const [bulk, setBulk] = useState("");
  const [issues, setIssues] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [day, setDay] = useState(todayKL());
  const [dayDocs, setDayDocs] = useState<Hit[] | null>(null);
  const [stops, setStops] = useState<Stop[]>([]);
  const [driverKey, setDriverKey] = useState("");
  const [busy, setBusy] = useState("");
  const [info, setInfo] = useState("");
  const [error, setError] = useState("");
  // 已传出去的那一趟：同样的站与司机再按一次 WhatsApp / 复制，沿用同一个签收连结、不另存一趟（避免重复排单）
  const [sent, setSent] = useState<{ token: string; sig: string } | null>(null);
  // 讯息已经传出去、但还没存成功的连结：重按时沿用，存成功后之前传出去的那个连结就能用
  const pending = useRef<{ token: string; sig: string } | null>(null);
  const gen = useRef(0);   // 找位置要好几秒；中途换分店 / 清空 / 再排一次，旧的结果就丢掉
  const stopsRef = useRef<Stop[]>(stops);   // 「现在」画面上的清单（找完位置要合并回去）
  stopsRef.current = stops;

  // 换分店：清掉这次的排单（DO 属于某一间分店）
  useEffect(() => {
    gen.current++;
    setStops([]); setHits(null); setDayDocs(null); setIssues([]); setDriverKey(""); setSent(null); setBusy("");
  }, [company]);
  // 载入旧排单（放在换分店之后，才不会被清掉）
  useEffect(() => {
    if (!seed) return;
    gen.current++;
    setBusy("");   // 还在找位置的那一次作废，按钮要能按
    setStops(seed.map((s) => ({ ...s, geo: s.lat == null ? "todo" : s.geo === "approx" ? "approx" : "ok" })));
    setSent(null); setIssues([]);
    say(`已载入 ${seed.length} 站。可以改司机、增减站，再传一次。`);
    onSeedUsed?.();
  }, [seed]); // eslint-disable-line react-hooks/exhaustive-deps

  const say = (m: string) => { setInfo(m); setError(""); };
  const fail = (e: unknown) => { setError(e instanceof Error ? e.message : String(e)); setInfo(""); };

  function addStops(list: Hit[]): number {
    const add = list.filter((h) => !h.cancelled).map(toStop).filter((s) => !stops.some((x) => x.key === s.key));
    setStops((cur) => [...cur, ...add.filter((s) => !cur.some((x) => x.key === s.key))]);
    return add.length;
  }

  // 排路线 / 一键排单 / 传送中：查询与列出这天的 DO 先不能按（不然它们结束时会把「忙碌中」清掉，半路就能传出没排好的单）
  const working = busy === "plan" || busy === "bulk" || busy === "send";

  async function lookup() {
    if (!query.trim() || busy) return;
    setBusy("lookup"); setError("");
    const my = gen.current;
    try {
      const list = await dlv.lookup(company, query);
      if (gen.current !== my) return;     // 中途换了分店
      if (!list.length) { say(`找不到 ${query.trim()}。DO 每 15 分钟从 AutoCount 同步一次，刚开的单请稍后再查。`); setHits(null); return; }
      if (list.length === 1 && !list[0].cancelled && !readOnly) { addStops(list); setQuery(""); setHits(null); return; }
      setHits(list);
    } catch (e) { fail(e); } finally { setBusy(""); }
  }

  async function loadDay() {
    if (busy) return;
    setBusy("day"); setError("");
    const my = gen.current;
    try { const d = await dlv.docs(company, day); if (gen.current === my) setDayDocs(d); } catch (e) { fail(e); } finally { setBusy(""); }
  }

  function update(key: string, patch: Partial<Stop>) {
    setStops((cur) => cur.map((s) => (s.key === key ? { ...s, ...patch } : s)));
  }

  /** 改地址：有 DO 就只改这张 DO（同步不会盖掉）；没有 DO 或地址本来来自顾客资料，也存进顾客资料。
   *  有 DO 的站清空 = 取消手动地址，改回 DO / 顾客资料的地址（从资料库重新读）。 */
  async function saveAddress(s: Stop, address: string) {
    try {
      if (s.doc_no && !address.trim()) {
        await dlv.setAddress(company, s.doc_no, "");
        const h = (await dlv.lookup(company, s.doc_no)).find((x) => x.doc_no === s.doc_no);
        if (h) setStops((cur) => cur.map((x) => (x.key === s.key ? { ...toStop(h), dnote: x.dnote } : x)));
        say("已取消手动地址，改回 DO 的送货地址。");
        return;
      }
      if (s.doc_no) await dlv.setAddress(company, s.doc_no, address);
      if (s.member_id && (!s.doc_no || s.source === "profile" || !s.source)) await dlv.setCustomerAddress(s.member_id, address);
      update(s.key, { address, lat: null, lng: null, geo: "todo", source: s.doc_no ? "manual" : "profile" });
      say("地址已储存。按「排最短路线」会重新找位置。");
    } catch (e) { fail(e); }
  }

  /** 给司机的备注：有 DO 就存在那张 DO（下次查同一张单还在）；用电话加的站只留在这次排单 */
  async function saveNote(s: Stop, note: string) {
    try {
      if (s.doc_no) await dlv.setNote(company, s.doc_no, note);
      update(s.key, { dnote: note.trim() || null });
    } catch (e) { fail(e); }
  }

  async function saveCoords(s: Stop, text: string) {
    const c = parseCoords(text);
    if (!c) { setError("看不懂坐标。请贴 Google Maps 的连结，或像 1.5321, 103.6612 这样的数字。"); return; }
    try {
      if (s.address) await dlv.setGeo(s.address, c.lat, c.lng);
      update(s.key, { ...c, geo: "ok" });
      say("位置已储存。按「排最短路线」重新排顺序。");
    } catch (e) { fail(e); }
  }

  /** 一键排单：整串单号 → 查 DO 与顾客资料 → 找坐标 → 排最短顺序 */
  async function bulkPlan() {
    const nos = splitDocNos(bulk);
    if (!nos.length) { setError("请先输入今天要送的 DO 单号。"); return; }
    setBusy("bulk"); say(`查询 ${nos.length} 张单…`); setIssues([]);
    const my = gen.current;
    try {
      const rows = await dlv.lookupMany(company, nos);
      if (gen.current !== my) return;     // 中途换了分店 / 清空
      const out: string[] = [];
      const merged = [...stopsRef.current];
      for (const h of rows) {
        if (!h.found) { out.push(`${h.query}：找不到（刚开的单约 15 分钟后才查得到）`); continue; }
        if (h.cancelled) { out.push(`${h.doc_no ?? h.query}：这张 DO 已取消`); continue; }
        const st = toStop(h);
        if (!merged.some((x) => x.key === st.key)) merged.push(st);
      }
      const noAddr = merged.filter((x) => !x.address).map((x) => x.doc_no ?? x.name);
      if (noAddr.length) out.push(`没有地址，请在下面那格补上再按一次「排最短路线」：${noAddr.join(", ")}`);
      setIssues(out);
      setBulk("");
      await plan(merged);
    } catch (e) { fail(e); setBusy(""); }
  }

  /** 找坐标、排顺序。找位置要好几秒：结果按站 key 合并回「现在」的清单，中途改的地址、加减的站都不会被盖掉 */
  async function plan(list?: Stop[]) {
    const my = ++gen.current;
    if (list) { stopsRef.current = list; setStops(list); }
    setBusy("plan"); setError("");
    const todo = stopsRef.current.filter((s) => s.lat == null && s.address);
    const found = new Map<string, { address: string; lat: number | null; lng: number | null; geo: Stop["geo"] }>();
    for (let i = 0; i < todo.length; i++) {
      const s = todo[i];
      say(`找位置中… ${i + 1} / ${todo.length}`);
      const c = await geocode(s.address);
      if (gen.current !== my) return;          // 换了分店 / 清空 / 又按了一次
      found.set(s.key, c ? { address: s.address, lat: c.lat, lng: c.lng, geo: c.approx ? "approx" : "ok" }
                         : { address: s.address, lat: null, lng: null, geo: "none" });
      if (c && !c.approx) dlv.setGeo(s.address, c.lat, c.lng).catch(() => { /* 存不进去下次再找 */ });
    }
    const merged = stopsRef.current.map((s) => {
      const f = found.get(s.key);
      return f && f.address === s.address && s.lat == null ? { ...s, lat: f.lat, lng: f.lng, geo: f.geo } : s;
    });
    const result = orderStops(merged, depot);
    stopsRef.current = result;
    setStops(result);
    setBusy("");
    const missing = result.filter((s) => s.lat == null && s.geo === "none").length;
    const unsearched = result.filter((s) => s.lat == null && s.geo !== "none" && s.address).length;   // 找位置途中才加入的站
    const approx = result.filter((s) => s.geo === "approx").length;
    if (unsearched) { say(`已排好。有 ${unsearched} 站是途中才加入的，还没找位置，请再按一次「排最短路线」。`); return; }
    say(missing
      ? `已排好。${missing} 站找不到位置（排在最后），请贴 Google Maps 坐标或改地址后再按一次。`
      : approx
        ? `已排好。${approx} 站只找到邮区的大概位置，最好按「改位置」贴准确的 Google Maps 坐标。`
        : `已排好最短顺序（直线距离约 ${routeKm(result, depot).toFixed(0)} km）。可以用 ↑ ↓ 微调。`);
  }

  function move(i: number, d: number) {
    const j = i + d;
    if (j < 0 || j >= stops.length) return;
    const cur = [...stops];
    [cur[i], cur[j]] = [cur[j], cur[i]];
    setStops(cur);
  }

  const driver = drivers.find((d) => `${d.kind}:${d.id}` === driverKey) ?? null;
  const preview = driverMessage(stops, { date: todayKL(), driver: driver?.name ?? "-", store, depot });

  /** 传 WhatsApp / 复制：先产生签收连结放进讯息，再存进排单纪录。同样的站与司机再按一次就沿用同一个连结、不重复存。 */
  async function send(how: "wa" | "copy") {
    if (busy) return;
    if (how === "wa" && !driver && !window.confirm(ui("还没选司机。要直接打开 WhatsApp，自己挑要传给谁吗？"))) {
      setError("请先在「选司机」选一位。没有司机的话：员工司机请管理员在「员工与权限」设成「送货部」或「物流部」并填手机；外包司机在「设定」分页新增。");
      return;
    }
    const missing = stops.filter((s) => !s.address).length;
    if (missing && !window.confirm(ui(`有 ${missing} 站没有地址，还是要传给司机吗？`))) return;
    const sig = JSON.stringify([driverKey, stops.map((s) => [s.key, s.address, s.lat, s.lng, s.dnote])]);
    const again = sent?.sig === sig;
    const token = again ? sent!.token : pending.current?.sig === sig ? pending.current.token : newToken();
    if (!again) pending.current = { token, sig };
    const text = driverMessage(stops, { date: todayKL(), driver: driver?.name ?? "-", store, depot, link: driverLink(token) });
    if (how === "wa") {
      // 要在按钮当下打开（之后才 await），浏览器才不会挡弹出视窗
      window.open(`https://wa.me/${driver ? driver.phone : ""}?text=${encodeURIComponent(text)}`, "_blank", "noopener");
    } else {
      try { await navigator.clipboard.writeText(text); }
      catch { setError("浏览器不让复制，请用「WhatsApp 传给司机」。"); return; }
    }
    if (again) {
      say(how === "wa" ? "已再打开 WhatsApp（同一趟、同一个签收连结，没有另存一趟）。" : "清单已复制（同一趟、同一个签收连结）。");
      return;
    }
    setBusy("send");
    try {
      try {
        await dlv.saveRun({ company, driver_kind: driver?.kind ?? null, driver_id: driver?.id ?? null, stops, token });
      } catch (e) {
        // 上一次其实存进去了、只是没收到回应（断线）：同一个连结已经在资料库，当作成功
        if (!(e instanceof Error && /duplicate key|unique/i.test(e.message))) throw e;
      }
      pending.current = null;
      setSent({ token, sig });
      say(how === "wa" ? "已打开 WhatsApp，并存进排单纪录。司机按连结签收后，在「排单纪录」看进度和照片。"
                       : "清单已复制（含签收连结），可以贴到任何地方；也已存进排单纪录。");
      onSent();
    } catch (e) { fail(e); } finally { setBusy(""); }
  }

  return (
    <>
      {!readOnly && (
        <section className="card">
          <h2>今天要送的 DO 单号</h2>
          <textarea rows={4} value={bulk} onChange={(e) => setBulk(e.target.value)}
                    placeholder="一行一张，或用空格分开；只打数字也可以。例：DO-017707 17708 17709" />
          <div className="actions left">
            <button disabled={!!busy} onClick={bulkPlan}>一键排单</button>
            <span className="muted small">自动找出顾客资料与送货地址，排好最短路线；再选司机按 WhatsApp 就传出去。</span>
          </div>
          {issues.length > 0 && <ul className="dlv-issues">{issues.map((x) => <li key={x}>{x}</li>)}</ul>}
        </section>
      )}

      <div className="toolbar">
        <input placeholder="DO 单号或顾客电话" value={query} onChange={(e) => setQuery(e.target.value)}
               onKeyDown={(e) => { if (e.key === "Enter") lookup(); }} />
        <button disabled={!!busy} onClick={lookup}>{readOnly ? "查询" : "查询并加入"}</button>
        <input type="date" value={day} onChange={(e) => setDay(e.target.value)} />
        <button className="ghost" disabled={!!busy} onClick={loadDay}>列出这天的 DO</button>
      </div>
      <ErrorBox error={error} />
      {info && <p className="ok">{info}</p>}

      {hits && (
        <section className="card">
          <div className="dlv-head"><b>{`找到 ${hits.length} 笔`}</b><button className="ghost small" onClick={() => setHits(null)}>关闭</button></div>
          <ul className="list">
            {hits.map((h, i) => (
              <li key={i} className="dlv-hit">
                <span>
                  <b>{h.doc_no ?? "（顾客）"}</b> {toStop(h).name || h.debtor_name} <span className="muted">{fmtPhone(phoneOf(h.member_id))}</span>
                  <br /><span className="muted small">{h.address || "没有地址"}</span>
                  {h.delivery_note && <><br /><span className="small">⚠️ {h.delivery_note}</span></>}
                </span>
                {h.cancelled ? <span className="tag">已取消</span>
                  : !readOnly && <button className="small" disabled={working} onClick={() => addStops([h])}>加入</button>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {dayDocs && (
        <section className="card">
          <div className="dlv-head">
            <b>{`${day} 的 DO（${dayDocs.length} 张）`}</b>
            <span>
              {!readOnly && dayDocs.length > 0 && (
                <button className="small" disabled={working} onClick={() => say(`加入 ${addStops(dayDocs)} 张。`)}>全部加入</button>
              )} <button className="ghost small" onClick={() => setDayDocs(null)}>关闭</button>
            </span>
          </div>
          {dayDocs.length === 0 ? <p className="muted">这天没有 DO（或还没同步）。</p> : (
            <ul className="list">
              {dayDocs.map((h) => (
                <li key={h.doc_no!} className="dlv-hit">
                  <span><b>{h.doc_no}</b> {toStop(h).name || h.debtor_name}<br /><span className="muted small">{h.address || "没有地址"}</span></span>
                  {readOnly ? null : stops.some((s) => s.key === h.doc_no) ? <span className="muted small">已加入</span>
                    : <button className="small" disabled={working} onClick={() => addStops([h])}>加入</button>}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {stops.length > 0 && (
        <section className="card">
          <div className="table-wrap">
            <table className="dlv-stops">
              <thead><tr><th>#</th><th>单号</th><th>顾客 / 货品 / 备注</th><th>送货地址</th><th>位置</th><th /></tr></thead>
              <tbody>
                {stops.map((s, i) => (
                  <StopRow key={s.key} s={s} i={i} n={stops.length} readOnly={readOnly}
                           onMove={(d) => move(i, d)} onRemove={() => setStops(stops.filter((x) => x.key !== s.key))}
                           onAddress={(a) => saveAddress(s, a)} onNote={(x) => saveNote(s, x)} onCoords={(c) => saveCoords(s, c)} />
                ))}
              </tbody>
            </table>
          </div>
          {!readOnly && (
            <>
              <div className="actions left dlv-send">
                <button className="ghost" disabled={!!busy} onClick={() => plan()}>排最短路线</button>
                <select value={driverKey} onChange={(e) => setDriverKey(e.target.value)}>
                  <option value="">选司机</option>
                  {drivers.map((d) => (
                    <option key={`${d.kind}:${d.id}`} value={`${d.kind}:${d.id}`}>
                      {`${d.name} · ${fmtPhone(d.phone)}${d.kind === "ext" ? "（外包）" : ""}`}
                    </option>
                  ))}
                </select>
                <button disabled={!stops.length || !!busy} onClick={() => send("wa")}>WhatsApp 传给司机</button>
                <button className="ghost" disabled={!!busy} onClick={() => send("copy")}>复制清单</button>
                <button className="ghost" onClick={() => {
                  if (window.confirm(ui("清空这次的排单？"))) { gen.current++; setStops([]); setSent(null); setIssues([]); setBusy(""); }
                }}>清空</button>
              </div>
              {drivers.length === 0 && (
                <p className="muted small">还没有司机：员工司机请管理员在「员工与权限」设成「送货部」或「物流部」并填手机；外包司机在「设定」分页新增。</p>
              )}
              <p className="muted small">
                {`${stops.length} 站`}{routeKm(stops, depot) ? " · " : ""}{routeKm(stops, depot) ? `直线约 ${routeKm(stops, depot).toFixed(0)} km` : ""}
                {!depot && " · "}{!depot && "还没设出发点（在「设定」分页），路线从第一站开始排。"}
              </p>
              <details>
                <summary>预览给司机的讯息</summary>
                <pre className="dlv-pre">{preview}</pre>
              </details>
              <p className="muted small">{OSM_CREDIT}</p>
            </>
          )}
        </section>
      )}
    </>
  );
}

function StopRow({ s, i, n, readOnly, onMove, onRemove, onAddress, onNote, onCoords }: {
  s: Stop; i: number; n: number; readOnly: boolean; onMove: (d: number) => void; onRemove: () => void;
  onAddress: (a: string) => void; onNote: (x: string) => void; onCoords: (c: string) => void;
}) {
  const [addr, setAddr] = useState(s.address);
  const [note, setNote] = useState(s.dnote ?? "");
  const [coords, setCoords] = useState("");
  const [fix, setFix] = useState(false);
  useEffect(() => { setAddr(s.address); }, [s.address]);
  useEffect(() => { setFix(false); setCoords(""); }, [s.lat, s.lng]);
  useEffect(() => { setNote(s.dnote ?? ""); }, [s.dnote]);
  const src = s.source === "do" ? "地址来自 AutoCount 的 DO" : s.source === "manual" ? "已手动修改（只改这张 DO）"
    : s.source === "profile" ? "地址来自顾客资料" : "";
  return (
    <tr>
      <td>{i + 1}</td>
      <td className="nowrap">{s.doc_no ?? "–"}</td>
      <td className="dlv-cust">
        <b>{s.name || "–"}</b> <span className="muted small">{fmtPhone(s.phone)}</span>
        {s.lines?.length ? (
          <details className="dlv-lines">
            <summary>{`货品 ${s.lines.length} 项`}</summary>
            <ul>{s.lines.map((l, k) => <li key={k}>{fmtLine(l)}</li>)}</ul>
          </details>
        ) : s.items ? <div className="muted small">{s.items}</div> : null}
        {s.remark && <div className="muted small">📝 {s.remark}</div>}
        {readOnly ? (s.dnote && <div className="small">⚠️ {s.dnote}</div>) : (
          <>
            <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} className="dlv-note"
                      placeholder="给司机的备注：时间、地点、下货位置…" />
            {note.trim() !== (s.dnote ?? "") && <button className="small" onClick={() => onNote(note)}>储存备注</button>}
          </>
        )}
      </td>
      <td className="dlv-addr">
        {readOnly ? <span>{s.address || "没有地址"}</span> : (
          <>
            <textarea rows={2} value={addr} onChange={(e) => setAddr(e.target.value)} placeholder="没有地址，请填上" />
            {addr !== s.address && (addr.trim() || s.doc_no) && (
              <button className="small" onClick={() => onAddress(addr)}>{addr.trim() ? "储存地址" : "改回 DO 的地址"}</button>
            )}
          </>
        )}
        {src && addr === s.address && <div className="muted small">{src}</div>}
      </td>
      <td className="dlv-geo">
        {s.lat != null ? (s.geo === "approx" ? <span className="tag late">大概位置（邮区）</span> : <span className="tag ok-tag">✓ 有位置</span>)
          : s.geo === "none" ? <span className="tag late">找不到</span> : <span className="muted small">未找</span>}
        {s.lat != null && !readOnly && !fix && <button className="ghost small" onClick={() => setFix(true)}>改位置</button>}
        {(s.lat == null || fix) && !readOnly && (
          <div className="dlv-coords">
            <input placeholder="贴 Google Maps 坐标" value={coords} onChange={(e) => setCoords(e.target.value)} />
            <button className="small" onClick={() => onCoords(coords)}>OK</button>
          </div>
        )}
      </td>
      <td className="nowrap">
        {!readOnly && (
          <>
            <button className="ghost small" disabled={i === 0} onClick={() => onMove(-1)} aria-label="上移">↑</button>
            <button className="ghost small" disabled={i === n - 1} onClick={() => onMove(1)} aria-label="下移">↓</button>
          </>
        )}
        <button className="ghost small" onClick={onRemove} aria-label="移除">✕</button>
      </td>
    </tr>
  );
}
