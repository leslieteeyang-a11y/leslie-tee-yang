// 仓库 · 货架（2026-10-15，使用者看了员工的 WMS 后选「每个货架都记数量」）。路由 #/warehouse/bins/<子画面>[?item=…&loc=…]
//   ops    = 上架 / 拿下 / 移货架（可编辑；手机优先）；可审批多「改数」
//   list   = 货架清单（按仓位 → 区 → 货架）、货架明细、建货架、印货架标签
//   recon  = 对不上（货架比系统多）/ 未上架
//   import = Excel 带入货架数量（可审批，初次设定）
// 货架帐是营运系统自己记的，AutoCount 只知道仓位的总数（对 AutoCount 仍是只读）。
import { useCallback, useEffect, useRef, useState } from "react";
import { go } from "../router";
import { ErrorBox, Tabs } from "../ui";
import { BinList as BinListData, bins } from "../wh-bin-api";
import { BinOps } from "./BinOps";
import { BinListView } from "./BinList";
import { BinRecon } from "./BinRecon";
import { BinImport } from "./BinImport";
import "../wh-bin.css";

type View = "ops" | "list" | "recon" | "import";

/** 「ops?item=ST003&loc=HQ」→ ["ops", URLSearchParams] */
function splitArg(arg?: string): [string, URLSearchParams] {
  const s = arg || "";
  const i = s.indexOf("?");
  return i < 0 ? [s, new URLSearchParams()] : [s.slice(0, i), new URLSearchParams(s.slice(i + 1))];
}

export function BinsTab({ company, level, arg, locs }: {
  company: string; level: "view" | "edit" | "approve"; arg?: string;
  /** 这间公司所有仓位（建货架、Excel 带入用） */ locs: string[];
}) {
  const canEdit = level !== "view";
  const canApprove = level === "approve";
  const [view, params] = splitArg(arg);
  const views: [View, string][] = [];
  if (canEdit) views.push(["ops", "上架 / 拿下"]);
  views.push(["list", "货架清单"]);
  views.push(["recon", "对不上 / 未上架"]);
  if (canApprove) views.push(["import", "Excel 带入"]);
  const v: View = views.some(([k]) => k === view) ? (view as View) : views[0][0];

  // 货架清单整个公司载一次：各子画面共用（有货架的仓位、货架下拉、标签）
  const [data, setData] = useState<BinListData | null>(null);
  const [error, setError] = useState("");
  const [inactive, setInactive] = useState(false);
  const reload = useCallback(() => {
    setError("");
    return bins.list(company, undefined, inactive).then(setData).catch((e: Error) => setError(e.message));
  }, [company, inactive]);
  useEffect(() => { setData(null); reload(); }, [reload]);
  // 上架画面每做一个动作不必重载整个清单（手机上省流量）；换到别的子画面时才重载
  const stale = useRef(false);
  useEffect(() => { if (stale.current && v !== "ops") { stale.current = false; reload(); } }, [v, reload]);

  // 有货架的仓位（照 AutoCount 仓位的顺序）
  const binLocs = data ? data.summary.map((s) => s.location) : [];

  return (
    <div className="bins">
      <div className="filters bin-subtabs">
        <Tabs value={v} options={views} onChange={(k) => go(`/warehouse/bins/${k}`)} />
      </div>
      <ErrorBox error={error} />
      {!data ? (!error && <p className="muted">载入中…</p>) : (
        <>
          {v === "ops" && (
            <BinOps key={company + "|" + (params.get("item") || "") + "|" + (params.get("loc") || "")} company={company}
                    canApprove={canApprove} binLocs={binLocs} all={data.bins}
                    item={params.get("item") || ""} loc={params.get("loc") || ""} onChanged={() => { stale.current = true; }} />
          )}
          {v === "list" && (
            <BinListView company={company} data={data} locs={locs} canEdit={canEdit} canApprove={canApprove}
                         inactive={inactive} setInactive={setInactive} onChanged={reload} />
          )}
          {v === "recon" && <BinRecon key={company} company={company} binLocs={binLocs} canEdit={canEdit} />}
          {v === "import" && <BinImport key={company} company={company} locs={locs} onSaved={reload} />}
        </>
      )}
    </div>
  );
}
