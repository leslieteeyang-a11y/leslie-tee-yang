// 「AutoCount 资料更新到几点」：PO / 库存不是即时的，告诉员工，免得把「还没同步」误会成「系统错了」
import { useEffect, useState } from "react";
import { BRANCH_LABEL } from "./api";
import { supabase } from "./supabase";
import "./extra.css";

interface SyncStatus {
  company: string;
  purchase: string | null;   // PO 最后一次从 AutoCount 同步成功的时间
  stock: string | null;      // 库存
}

/** 「今天 15:05」「昨天 12:05」「9/25 12:05」 */
export function fmtAgo(s: string | null | undefined): string {
  if (!s) return "未知";
  const d = new Date(s);
  const now = new Date();
  const hm = d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86400000);
  if (diff === 0) return `今天 ${hm}`;
  if (diff === 1) return `昨天 ${hm}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

export function SyncNote() {
  const [rows, setRows] = useState<SyncStatus[] | null>(null);
  useEffect(() => {
    supabase.rpc("ops_sync_status").then(({ data, error }) => setRows(error ? null : (data as SyncStatus[])));
  }, []);
  if (!rows || rows.length === 0) return null;
  const stale = rows.some((r) => !r.purchase || Date.now() - new Date(r.purchase).getTime() > 26 * 3600 * 1000);
  return (
    <p className={"muted small sync" + (stale ? " late" : "")}>
      AutoCount 资料更新：
      {rows.map((r, n) => (
        <span key={r.company}>
          {n > 0 && " · "}
          {rows.length > 1 && `${BRANCH_LABEL[r.company]} `}PO {fmtAgo(r.purchase)}、库存 {fmtAgo(r.stock)}
        </span>
      ))}
      {stale ? "（超过一天没更新，请通知管理员检查同步）" : "（刚在 AutoCount 做的单，要等下一次同步才会出现）"}
    </p>
  );
}
