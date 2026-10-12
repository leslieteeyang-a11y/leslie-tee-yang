// 厂家到货清单：草稿 / 在路上 / 已到货 / 已取消。点一张进编辑画面（#/purchasing/do/<id>）。
import { useCallback, useEffect, useState } from "react";
import { BRANCH_LABEL, fmtDate, fmtQty, Me } from "../api";
import { go } from "../router";
import { Empty, ErrorBox } from "../ui";
import { DO_STATUS_LABEL, DoHeader, joinList, podo } from "../podo-api";
import { DoStatusBadge, EtaText } from "./common";

export default function DoList({ me }: { me: Me }) {
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("open");
  const [company, setCompany] = useState("");
  const [rows, setRows] = useState<DoHeader[] | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    setError("");
    setRows(null);
    podo.list({ status, q: query, company }).then(setRows).catch((e: Error) => setError(e.message));
  }, [status, query, company]);
  useEffect(load, [load]);

  return (
    <>
      <div className="page-head">
        <p className="muted">
          {"厂家出货时开一张：选厂家 → 选 PO → 上传厂家 DO / 装箱单（Excel 自动读数量；PDF、照片当附件，数量自己填）→ 每个型号分给各分店 → 确认。"}
          <br />{"确认后分店在「在路上」看得到 ETA；少发、多发、发错型号自动记到「厂家问题」。"}
        </p>
        <button onClick={() => go("/purchasing/do/new")}>＋ 新厂家到货</button>
      </div>
      <form className="toolbar" onSubmit={(e) => { e.preventDefault(); setQuery(q.trim()); }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜 DO 号、厂家、PO 号、型号…" />
        <button>搜寻</button>
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="open">草稿 + 在路上</option>
          {Object.entries(DO_STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          <option value="all">全部</option>
        </select>
        {me.staff.branch === "ALL" && (
          <select value={company} onChange={(e) => setCompany(e.target.value)}>
            <option value="">全部分店</option>
            <option value="HOMEWORKSSB">{BRANCH_LABEL.HOMEWORKSSB}</option>
            <option value="HOMEWORKSSOUTHERN">{BRANCH_LABEL.HOMEWORKSSOUTHERN}</option>
          </select>
        )}
      </form>
      <ErrorBox error={error} />
      {rows === null ? <p className="muted">{error ? "" : "载入中…"}</p> : rows.length === 0 ? <Empty>没有厂家到货。</Empty> : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>DO / 厂家</th><th>ETA</th><th>状态</th><th className="hide-sm">PO</th>
                <th className="num">出货</th><th className="num hide-sm">问题</th><th className="hide-sm">更新</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.id} className={"click" + (d.status === "cancelled" ? " inactive" : "")} onClick={() => go(`/purchasing/do/${d.id}`)}>
                  <td>
                    <b>{d.do_no || "（没填 DO 号）"}</b>
                    {me.staff.branch === "ALL" && <span className="tag">{BRANCH_LABEL[d.company]}</span>}
                    {d.files.length > 0 && <span className="tag">{`附件 ${d.files.length}`}</span>}
                    <br /><span className="muted">{d.supplier_name || d.creditor_code}</span>
                    {d.do_date && <><br /><small className="muted">{`DO 日期 ${d.do_date}`}</small></>}
                  </td>
                  <td className="nowrap">
                    <EtaText eta={d.eta_effective} source={d.eta_source} arrived={d.status !== "confirmed"} />
                    {d.shipment_name && <><br /><small className="muted">{`柜 ${d.shipment_name}`}</small></>}
                  </td>
                  <td><DoStatusBadge status={d.status} /></td>
                  <td className="hide-sm small">{joinList(d.po_nos)}</td>
                  <td className="num">
                    {fmtQty(d.shipped_total)}<br />
                    <small className="muted">{`${d.item_count} 个型号`}</small>
                    {d.unmatched_count > 0 && <><br /><small className="late">{`对不上 ${d.unmatched_count} 行`}</small></>}
                  </td>
                  <td className="num hide-sm">{d.issue_open > 0 ? <span className="badge">{`${d.issue_open} 未处理`}</span> : ""}</td>
                  <td className="hide-sm small muted">{d.updated_by_name}<br />{fmtDate(d.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
