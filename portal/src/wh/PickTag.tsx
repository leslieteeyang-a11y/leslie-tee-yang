// 送货 · 排单画面用：DO 号旁边的「已备好 / 备货中」小标签（仓库或送货「只看」以上叫得到 ops_wh_pick_status）。
// 读不到（没有权限、网路问题）就不显示，不影响排单。
import { useEffect, useState } from "react";
import { pick, PickStatusMap } from "../wh-pick-api";
import "../wh-pick.css";

/** 这些 DO 的备货进度；单号一样就不重读（每 60 秒自动更新一次） */
export function usePickStatus(company: string, docNos: (string | null | undefined)[]): PickStatusMap {
  const [map, setMap] = useState<PickStatusMap>({});
  const key = Array.from(new Set(docNos.filter((x): x is string => !!x))).sort().join("|");
  useEffect(() => {
    if (!key) { setMap({}); return; }
    let alive = true;
    const get = () => pick.status(company, key.split("|")).then((m) => { if (alive) setMap(m || {}); }).catch(() => { /* 不显示 */ });
    get();
    const t = window.setInterval(get, 60000);
    return () => { alive = false; window.clearInterval(t); };
  }, [company, key]);
  return map;
}

export function PickTag({ s }: { s?: PickStatusMap[string] }) {
  if (!s) return null;
  return s.status === "done" ? <span className="pk done">已备好</span> : <span className="pk picking">备货中</span>;
}
