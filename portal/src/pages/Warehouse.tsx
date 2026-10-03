// 仓库：查货（扫码）、每日小盘点、搬动登记、差异审核、印条码。路由 #/warehouse/<分页>
// 对 AutoCount 仍是只读：搬动与盘点差异都变成清单，负责人在 AutoCount 输入后回来标「已输入 / 已调整」。
import { useEffect, useState } from "react";
import { BRANCH_LABEL, Me } from "../api";
import { go } from "../router";
import { ErrorBox, Tabs } from "../ui";
import "../att.css";
import "../wh.css";
import Labels from "../wh/Labels";
import { Lookup } from "../wh/Lookup";
import { MovesTab } from "../wh/Moves";
import { CountTab } from "../wh/Count";
import { ReviewTab } from "../wh/Review";
import { wh, WhMeta } from "../wh-api";

type Tab = "lookup" | "count" | "moves" | "review" | "labels";
const COMPANY_KEY = "hw-wh-company";

export default function Warehouse({ me, sub }: { me: Me; sub?: string }) {
  const [meta, setMeta] = useState<WhMeta | null>(null);
  const [error, setError] = useState("");
  const [company, setCompany] = useState(() => { try { return localStorage.getItem(COMPANY_KEY) || ""; } catch { return ""; } });
  useEffect(() => { wh.meta().then(setMeta).catch((e: Error) => setError(e.message)); }, []);
  if (!meta) return error ? <ErrorBox error={error} /> : <p className="muted">载入中…</p>;

  const co = meta.companies.includes(company) ? company : meta.companies[0];
  const canEdit = meta.level !== "view";
  const canApprove = meta.level === "approve";
  const tabs: [Tab, string][] = [["lookup", "查货"]];
  if (canEdit) tabs.push(["count", "盘点"]);
  tabs.push(["moves", "搬动"]);
  if (canApprove) tabs.push(["review", "差异审核"]);
  tabs.push(["labels", "印条码"]);
  const tab: Tab = tabs.some(([k]) => k === sub) ? (sub as Tab) : "lookup";
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
      {tab === "lookup" && <Lookup me={me} company={co} locs={locs.map((l) => l.code)} canEdit={canEdit} />}
      {tab === "count" && <CountTab company={co} locs={locs.filter((l) => l.counting).map((l) => l.code)} />}
      {tab === "moves" && <MovesTab me={me} company={co} locs={locs.map((l) => l.code)} canEdit={canEdit} canApprove={canApprove} />}
      {tab === "review" && <ReviewTab company={co} meta={meta} onMeta={setMeta} />}
      {tab === "labels" && <Labels company={co} locs={locs.map((l) => l.code)} />}
    </>
  );
}
