// 仓库 · 拣货清单（照 DO 拣货 + 扫码核对，2026-10-15）。#/warehouse/pick = 清单；#/warehouse/pick/<DO 号> = 拣货画面（PickDo）；
// #/warehouse/pick/today = 清单，固定从「今天要送 · 待拣」开始（首页 / 总览的「今天要拣的 DO」用，不改记住的筛选）。
// DO 每 15 分钟从 AutoCount 同步；今天的排单（送货 → 排单）里的 DO 排最前面。只看的人看进度，可编辑的人拣货。
import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { Empty, ErrorBox, Tabs } from "../ui";
import { qtyLabel, whenLabel } from "../wh-api";
import { openPick, pick, PICK_STATUS_LABEL, PickFilter, PickList, PickRow, PickWhen, runLabel } from "../wh-pick-api";
import { PickDo } from "./PickDo";
import "../wh-pick.css";

const WHEN_KEY = "hw-pick-when";
const STATUS_KEY = "hw-pick-status";
function saved<T extends string>(key: string, ok: T[], dflt: T): T {
  try { const v = localStorage.getItem(key) as T | null; return v && ok.includes(v) ? v : dflt; } catch { return dflt; }
}
function keep(key: string, v: string) {
  try { localStorage.setItem(key, v); } catch { /* 无痕模式存不了就算了 */ }
}

/** doc / arg = 网址第三段：「today」= 清单从今天要送 · 待拣开始；其他 = DO 号，开拣货画面 */
export function PickTab({ company, canEdit, doc, arg }: { company: string; canEdit: boolean; doc?: string; arg?: string }) {
  const a = arg ?? doc;
  if (a && a !== "today") {
    let no = a;
    try { no = decodeURIComponent(a); } catch { /* 不是编码过的就照原样 */ }
    return <PickDo key={company + "|" + no} company={company} docNo={no} />;
  }
  // key：从清单再点「今天要拣」时重新从今天 · 待拣开始
  return <PickListView key={a || "list"} company={company} canEdit={canEdit} today={a === "today"} />;
}

function PickListView({ company, canEdit, today }: { company: string; canEdit: boolean; today: boolean }) {
  // today：只是这次的起始筛选，不写进 localStorage（使用者自己按分页才记）
  const [when, setWhen] = useState<PickWhen>(() => (today ? "today" : saved(WHEN_KEY, ["today", "week", "all"], "today")));
  const [status, setStatus] = useState<PickFilter>(() => (today ? "todo" : saved(STATUS_KEY, ["todo", "done", "all"], "todo")));
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [data, setData] = useState<PickList | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);

  // 流水号：连按分页时，先发后到的旧回应不盖掉新的清单
  const load = useCallback(() => {
    const n = ++seq.current;
    setBusy(true); setError("");
    pick.list({ company, when, status, q: query })
      .then((d) => { if (n === seq.current) setData(d); })
      .catch((e: Error) => { if (n === seq.current) setError(e.message); })
      .finally(() => { if (n === seq.current) setBusy(false); });
  }, [company, when, status, query]);
  useEffect(() => { load(); }, [load]);

  function search(e: FormEvent) {
    e.preventDefault();
    const v = q.trim();
    // 打完整的 DO 号（扫 DO 上的条码）直接开
    const hit = data?.rows.find((r) => r.doc_no.toUpperCase() === v.toUpperCase());
    if (hit) { openPick(hit.doc_no); return; }
    setQuery(v);
  }

  const s = data?.summary;
  return (
    <>
      <div className="pick-filters">
        <Tabs value={when} options={[["today", "今天要送"], ["week", "这星期"], ["all", "全部"]]}
              onChange={(v) => { setWhen(v); keep(WHEN_KEY, v); }} />
        <Tabs value={status} options={[["todo", "待拣"], ["done", "已拣好"], ["all", "全部"]]}
              onChange={(v) => { setStatus(v); keep(STATUS_KEY, v); }} />
        <button className="ghost small" onClick={load} disabled={busy}>重新整理</button>
      </div>
      <form className="pick-search" onSubmit={search}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="找 DO 号或顾客名" enterKeyHint="search" />
        <button disabled={busy}>找</button>
        {query && <button type="button" className="ghost" onClick={() => { setQ(""); setQuery(""); }}>清除</button>}
      </form>
      {s && (
        <p className="pick-sum">
          <span>{`今天要送 ${s.today} 张`}</span>
          <span>{`今天已拣好 ${s.today_done} 张`}</span>
          <span>{`拣货中 ${s.picking} 张`}</span>
          {data?.synced && <span>{`DO 同步：${whenLabel(data.synced)}`}</span>}
        </p>
      )}
      {query && <p className="muted small">{`搜寻「${query}」（近 60 天）`}</p>}
      <ErrorBox error={error} />
      {!data ? (!error && <p className="muted">载入中…</p>) : data.rows.length === 0 ? (
        <Empty>{status === "done" ? "还没有拣好的 DO。" : "没有要拣的 DO。"}<br />
          <span className="small">DO 每 15 分钟从 AutoCount 同步一次；今天要送的排单在「送货 → 排单」。</span></Empty>
      ) : (
        <ul className="list card pick-list">
          {data.rows.map((r) => <Row key={r.doc_no} r={r} />)}
        </ul>
      )}
      {data && data.rows.length >= 300 && <p className="muted small">只列前 300 张，请用搜寻找。</p>}
      {!canEdit && data && data.rows.length > 0 && <p className="muted small">你是「只看」：可以看进度，拣货要仓库「可编辑」。</p>}
    </>
  );
}

function Row({ r }: { r: PickRow }) {
  const pct = r.total > 0 ? Math.min(100, (r.picked / r.total) * 100) : 0;
  return (
    <li className="click" onClick={() => openPick(r.doc_no)}>
      <span className="main">
        <div>
          <b>{r.doc_no}</b>
          {r.cancelled ? <span className="pk cancelled">DO 已取消</span>
            : r.status ? <span className={"pk " + r.status}>{PICK_STATUS_LABEL[r.status]}</span>
            : <span className="pk">待拣</span>}
          {r.run && <span className={"pk " + (r.run.today ? "today" : "run")}>{runLabel(r.run)}</span>}
          {r.delivered && <span className="pk done">已送达</span>}
        </div>
        <span className="sub">{`${r.debtor_name || "—"} · ${r.doc_date} · ${r.lines} 行`}</span>
      </span>
      <span className="pick-prog">
        <span className={"pk-bar" + (r.status === "done" ? " full" : "")}><i style={{ width: `${r.status === "done" ? 100 : pct}%` }} /></span>
        <span>{`${qtyLabel(r.picked)} / ${qtyLabel(r.total)}`}</span>
      </span>
    </li>
  );
}
