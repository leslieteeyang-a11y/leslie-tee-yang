// 仓库「今天」（仓库把关 2026-10-17）：今天要点货、复核、拣货、核对、上架、出车，照急迫排（逾期 → 今天 → 其他）。
// 每一项显示谁接了（拣货 = 开始拣的人、出车 = 开始装车的人、其他 = 按「我来」认领的人）；点进去直接做。
import { useCallback, useEffect, useState } from "react";
import { fmtQty } from "../api";
import { go } from "../router";
import { Empty, ErrorBox, Tabs } from "../ui";
import { gate, Today, TodayItem, TodayKind } from "../wh-gate-api";

const KIND_LABEL: Record<TodayKind, string> = {
  load: "出车", pick: "拣货", pick_check: "核对", receive: "点货", recv_review: "点货复核", putaway: "上架",
};
type Filter = "all" | "mine" | "open";

function href(i: TodayItem): string {
  switch (i.kind) {
    case "load": return "/delivery/runs";
    case "pick": return `/warehouse/pick/${encodeURIComponent(String(i.ref))}`;
    case "pick_check": return `/warehouse/gate/check`;
    case "receive": return `/purchasing/receive/${i.ref}`;
    case "recv_review": return "/warehouse/gate";
    case "putaway": return "/warehouse/putaway";
  }
}

export function TodayTab({ company }: { company: string }) {
  const [t, setT] = useState<Today | null>(null);
  const [error, setError] = useState("");
  const [f, setF] = useState<Filter>("all");
  const [busy, setBusy] = useState("");
  const load = useCallback(() => { setError(""); gate.today(company).then(setT).catch((e: Error) => setError(e.message)); }, [company]);
  useEffect(() => { setT(null); load(); }, [load]);

  async function claim(i: TodayItem, release: boolean) {
    setBusy(`${i.kind}:${i.ref}`); setError("");
    try { await gate.claim(i.kind as "receive" | "putaway" | "pick_check", Number(i.ref), release); load(); }
    catch (e) { setError((e as Error).message); }
    setBusy("");
  }

  if (!t) return error ? <ErrorBox error={error} /> : <p className="muted">载入中…</p>;
  const items = t.items.filter((i) => f === "all" || (f === "mine" ? i.who_id === t.me_id : !i.who_id));
  const late = t.items.filter((i) => i.late).length;
  const counts = (Object.keys(KIND_LABEL) as TodayKind[]).map((k) => [k, t.items.filter((i) => i.kind === k).length] as const).filter(([, n]) => n > 0);

  return (
    <>
      <div className="wh-today-sum">
        {late > 0 && <span className="tag late">{`逾期 ${late}`}</span>}
        {counts.map(([k, n]) => <span key={k} className="tag">{KIND_LABEL[k]} <b>{n}</b></span>)}
        <button className="ghost small" onClick={load}>重新整理</button>
      </div>
      <div className="filters">
        <Tabs value={f} onChange={(k) => setF(k as Filter)} options={[["all", "全部"], ["mine", "我接的"], ["open", "还没人接"]]} />
      </div>
      <ErrorBox error={error} />
      {!items.length ? <Empty>{f === "all" ? "今天的工作都做完了 👍" : "没有。"}</Empty> : (
        <ul className="list wh-today">
          {items.map((i) => {
            const claimable = i.kind === "receive" || i.kind === "putaway" || i.kind === "pick_check";
            const k = `${i.kind}:${i.ref}`;
            return (
              <li key={k} className={i.late ? "late-row" : i.today ? "warm-row" : ""}>
                <span className="main click" onClick={() => go(href(i))}>
                  <span>
                    <span className={"tag" + (i.late ? " late" : "")}>{KIND_LABEL[i.kind]}</span>{" "}
                    <b>{i.title}</b>
                    {i.sub && <span className="muted">{` · ${i.sub}`}</span>}
                  </span>
                  <span className="sub">
                    {i.late ? "逾期" : i.today ? "今天" : i.due ? `期限 ${i.due}` : ""}
                    {i.kind === "putaway" && i.n != null && ` · ${fmtQty(Number(i.n) - Number(i.done ?? 0))} 件 · ${i.location ?? ""}`}
                    {(i.kind === "pick" || i.kind === "load") && i.n != null && ` · ${fmtQty(Number(i.done ?? 0))} / ${fmtQty(Number(i.n))}`}
                    {i.kind === "receive" && i.n != null && ` · ${i.n} 个型号`}
                    {i.kind === "recv_review" && i.n != null && ` · ${i.n} 项差异`}
                  </span>
                </span>
                <span className="wh-today-who">
                  {i.who ? <span className={i.who_id === t.me_id ? "gate-ok" : "muted"}>{i.who_id === t.me_id ? "我接了" : `${i.who} 在做`}</span>
                    : <span className="muted">还没人接</span>}
                  {claimable && i.can && !i.who && <button className="small" disabled={busy === k} onClick={() => claim(i, false)}>我来</button>}
                  {claimable && i.who_id === t.me_id && <button className="small ghost" disabled={busy === k} onClick={() => claim(i, true)}>放掉</button>}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
