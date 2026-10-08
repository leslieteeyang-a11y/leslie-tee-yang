// 送货安装 · 排单纪录：近 14 天每一趟、每站签收状态、司机备注与照片（照片用 1 小时有效的网址）。
import { useEffect, useState } from "react";
import { dlv, driverLink, fmtPhone, hhmmKL, Run, Stop } from "../dlv-api";
import { Empty, ErrorBox } from "../ui";

export function RunsTab({ company, canEdit, reloadKey, onLoad }: {
  company: string; canEdit: boolean; reloadKey: number; onLoad?: (stops: Stop[]) => void;
}) {
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [error, setError] = useState("");
  const load = () => { setError(""); dlv.runs(company, 14).then(setRuns).catch((e: Error) => setError(e.message)); };
  useEffect(() => { setRuns(null); load(); }, [company, reloadKey]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <div className="actions left">
        <button className="ghost small" onClick={load}>重新整理</button>
        <span className="muted small">司机每签收一站，这里就看得到（按「重新整理」）。</span>
      </div>
      <ErrorBox error={error} />
      {runs === null ? <p className="muted">载入中…</p>
        : runs.length === 0 ? <Empty>最近 14 天没有排单。</Empty>
        : runs.map((r) => <RunCard key={r.id} r={r} canEdit={canEdit} onLoad={onLoad} />)}
    </>
  );
}

export function RunCard({ r, canEdit, onLoad }: { r: Run; canEdit: boolean; onLoad?: (stops: Stop[]) => void }) {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [isOpen, setIsOpen] = useState(false);
  const [msg, setMsg] = useState("");
  const podOf = (k: string) => r.pods.find((p) => p.stop_key === k);
  const done = r.stops.filter((s) => podOf(s.key)?.status === "delivered").length;
  const failed = r.stops.filter((s) => podOf(s.key)?.status === "failed").length;

  // 打开时（以及按「重新整理」有新照片时）只要还没有网址的照片
  const paths = r.pods.flatMap((p) => p.photos);
  const pathKey = paths.join("|");
  useEffect(() => {
    if (!isOpen) return;
    const missing = paths.filter((p) => !urls[p]);
    if (!missing.length) return;
    dlv.photoUrls(missing).then((m) => setUrls((u) => ({ ...u, ...m }))).catch((err: Error) => setMsg(err.message));
  }, [isOpen, pathKey]); // eslint-disable-line react-hooks/exhaustive-deps

  async function copyLink() {
    if (!r.token) return;
    try { await navigator.clipboard.writeText(driverLink(r.token)); setMsg("司机签收连结已复制（排单后 3 天内有效）。"); }
    catch { setMsg(driverLink(r.token)); }
  }

  return (
    <details className="card dlv-run" onToggle={(e) => setIsOpen(e.currentTarget.open)}>
      <summary>
        <b>{r.run_date}</b> · {r.driver_name ?? "（没选司机）"} · <span>{`${r.stops.length} 站`}</span>
        {r.has_link && <> · <span className={"tag" + (done === r.stops.length ? " ok-tag" : "")}>{`已送达 ${done} / ${r.stops.length}`}</span></>}
        {failed > 0 && <> <span className="tag late">{`送不成 ${failed}`}</span></>}
      </summary>
      <p className="muted small">
        {`排单：${r.created_by ?? "—"}`}{r.driver_phone ? ` · ${fmtPhone(r.driver_phone)}` : ""}
        {r.has_link && !r.link_valid && " · "}{r.has_link && !r.link_valid && "签收连结已过期"}
      </p>
      {canEdit && (
        <div className="actions left">
          {onLoad && <button className="ghost small" onClick={() => onLoad(r.stops)}>载入到排单</button>}
          {r.token && r.link_valid && <button className="ghost small" onClick={copyLink}>复制司机签收连结</button>}
          {r.token && r.link_valid && <a className="small" href={`#/driver?t=${r.token}`} target="_blank" rel="noopener">打开签收页</a>}
        </div>
      )}
      {msg && <p className="muted small">{msg}</p>}
      <div className="table-wrap">
        <table>
          <tbody>
            {r.stops.map((s, i) => {
              const p = podOf(s.key);
              return (
                <tr key={s.key}>
                  <td>{i + 1}</td>
                  <td className="nowrap">{s.doc_no ?? "–"}</td>
                  <td>{s.name || fmtPhone(s.phone) || "–"}</td>
                  <td>
                    {!p ? <span className="muted small">{r.has_link ? "还没签收" : "这趟没有签收连结"}</span>
                      : <span className={"tag " + (p.status === "delivered" ? "ok-tag" : "late")}>
                          {p.status === "delivered" ? "已送达" : "送不成"}
                        </span>}
                    {p && <span className="muted small"> {hhmmKL(p.created_at)}</span>}
                    {p?.note && <div className="muted small">{p.note}</div>}
                  </td>
                  <td>
                    <div className="dlv-photos">
                      {p?.photos.map((ph) => urls[ph]
                        ? <a key={ph} href={urls[ph]} target="_blank" rel="noopener"><img src={urls[ph]} alt="" /></a>
                        : <span key={ph} className="muted">📷</span>)}
                      {/* 只看的人：连结还有效时看不到照片（路径里有连结代码），只显示张数 */}
                      {p && !p.photos.length && p.photo_count > 0 && <span className="muted small">{`📷 ${p.photo_count} 张`}</span>}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </details>
  );
}
