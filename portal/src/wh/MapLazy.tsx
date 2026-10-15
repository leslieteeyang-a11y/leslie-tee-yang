// 仓库地图点到才下载（SVG 画布与拖拉程式不拖慢其他仓库分页）
import { lazy, Suspense } from "react";

const MapTab = lazy(() => import("./Map"));

export function MapLazy(props: { company: string; loc?: string }) {
  return <Suspense fallback={<p className="muted">载入中…</p>}><MapTab {...props} /></Suspense>;
}
