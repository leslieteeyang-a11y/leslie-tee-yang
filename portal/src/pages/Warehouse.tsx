// 仓库：查货（扫码）、每日小盘点、搬动登记、待开进货单（开单部）、差异审核、印条码。路由 #/warehouse/<分页>
// 对 AutoCount 仍是只读：搬动与盘点差异都变成清单，负责人在 AutoCount 输入后回来标「已输入 / 已调整」。
import { useEffect, useState } from "react";
import { BRANCH_LABEL, can, canCancelReceive, canGrn, canReceive, Me } from "../api";
import { go } from "../router";
import { ErrorBox, Tabs } from "../ui";
import "../att.css";
import "../wh.css";
import Labels from "../wh/Labels";
import LotView from "../wh/LotView";
import { Lookup } from "../wh/Lookup";
import { MovesTab } from "../wh/Moves";
import { CountTab } from "../wh/Count";
import { ReviewTab } from "../wh/Review";
import { AgedTab } from "../wh/Aged";
import { GrnTab } from "../wh/Grn";
import { StockTab } from "../wh/Stock";
import { SlowTab } from "../wh/Slow";
import { BinsTab } from "../wh/Bins";
import { MapLazy } from "../wh/MapLazy";
import { PickTab } from "../wh/Pick";
import { OverviewTab } from "../wh/Overview";
import { wh, WhMeta } from "../wh-api";


type Tab = "overview" | "lookup" | "stock" | "bins" | "map" | "count" | "moves" | "grn" | "review" | "aged" | "slow" | "labels" | "pick" | "lot";
const COMPANY_KEY = "hw-wh-company";

// arg = 网址第三段（#/warehouse/<分页>/<arg>），给分页里的子画面用（例：#/warehouse/bins/recon、#/warehouse/lot/L251015-0001）
export default function Warehouse({ me, sub, arg }: { me: Me; sub?: string; arg?: string }) {
  const [meta, setMeta] = useState<WhMeta | null>(null);
  const [error, setError] = useState("");
  const [company, setCompany] = useState(() => { try { return localStorage.getItem(COMPANY_KEY) || ""; } catch { return ""; } });
  useEffect(() => { wh.meta().then(setMeta).catch((e: Error) => setError(e.message)); }, []);
  if (!meta) return error ? <ErrorBox error={error} /> : <p className="muted">载入中…</p>;

  const co = meta.companies.includes(company) ? company : meta.companies[0];
  const canEdit = meta.level !== "view";
  const canApprove = meta.level === "approve";
  // 分页顺序照每天用的（2026-10-17 审查）：手机上前几个就是扫码、拣货、货架、盘点、搬动；宽表格的库存总表、地图往后
  const tabs: [Tab, string][] = [["overview", "总览"], ["lookup", "查货"]];
  tabs.push(["pick", "拣货"]);       // 照 DO 拣货 + 扫码核对（2026-10-15）
  tabs.push(["bins", "货架"]);       // 货架帐（2026-10-17）
  if (canEdit) tabs.push(["count", "盘点"]);
  tabs.push(["moves", "搬动"]);
  // 开单部（仓库只看）与仓库「可审批」：点货后的进货，在 AutoCount 开 GRN
  if (canGrn(me)) tabs.push(["grn", "待开进货单"]);
  if (canApprove) tabs.push(["review", "差异审核"]);
  tabs.push(["stock", "库存总表"]);   // 从 BI 搬进来（2026-10-16）
  tabs.push(["map", "地图"]);         // 货架地图（#/warehouse/map/<仓位>）
  tabs.push(["labels", "印条码"]);
  tabs.push(["aged", "旧货"]);
  tabs.push(["slow", "滞销品"]);     // 从 BI 搬进来（2026-10-16）
  // 网址没指定分页时：仓库可审批 = 总览；开单部 = 待开进货单；其他人 = 查货。指定了但没权限 → 总览（照旧）
  const home: Tab = canApprove ? "overview" : me.staff.department === "billing" && canGrn(me) ? "grn" : "lookup";
  // lot = 批次画面（扫箱贴 QR），不在分页列
  const tab: Tab = sub === "lot" ? "lot" : !sub ? home : tabs.some(([k]) => k === sub) ? (sub as Tab) : "overview";
  const locs = meta.locations.filter((l) => l.company === co);
  const pick = (c: string) => { setCompany(c); try { localStorage.setItem(COMPANY_KEY, c); } catch { /* 忽略 */ } };

  return (
    <>
      <div className="page-head">
        <h1>仓库</h1>
        {meta.companies.length > 1 && (
          <select value={co} onChange={(e) => pick(e.target.value)} className="narrow-select">
            {meta.companies.map((c) => <option key={c} value={c}>{BRANCH_LABEL[c] || c}</option>)}
          </select>
        )}
      </div>
      <div className="filters"><Tabs value={tab} options={tabs} onChange={(k) => go(`/warehouse/${k}`)} /></div>
      {tab === "overview" && <OverviewTab key={co} company={co} canEdit={canEdit} canApprove={canApprove} canGrn={canGrn(me)}
                                          canReceive={canReceive(me)} canTransit={can(me, "purchasing", "view")} />}
      {tab === "lookup" && <Lookup me={me} company={co} locs={locs.map((l) => l.code)} canEdit={canEdit} />}
      {tab === "count" && <CountTab company={co} locs={locs.filter((l) => l.counting).map((l) => l.code)}
                                    allLocs={locs.map((l) => l.code)} arg={arg} canApprove={canApprove} />}
      {tab === "moves" && <MovesTab me={me} company={co} locs={locs.map((l) => l.code)} canEdit={canEdit} canApprove={canApprove} />}
      {tab === "grn" && <GrnTab company={co} multi={meta.companies.length > 1} canCancel={canCancelReceive(me)} />}
      {tab === "review" && <ReviewTab company={co} meta={meta} onMeta={setMeta} />}
      {tab === "aged" && <AgedTab company={co} />}
      {tab === "stock" && <StockTab key={co + "|" + (arg ?? "")} company={co} arg={arg} />}
      {tab === "slow" && <SlowTab key={co} company={co} />}
      {tab === "bins" && <BinsTab key={co} company={co} level={meta.level} arg={arg} locs={locs.map((l) => l.code)} />}
      {tab === "map" && <MapLazy key={co} company={co} loc={arg} />}
      {tab === "pick" && <PickTab company={co} canEdit={canEdit} doc={arg} />}
      {tab === "labels" && <Labels company={co} locs={locs.map((l) => l.code)} arg={arg} />}
      {tab === "lot" && <LotView key={arg} lotNo={arg ?? ""} canEdit={canEdit} />}
    </>
  );
}
