// 点货：厂家的货到了，仓库（或订货「可编辑」的人；确认这张 DO 的人自己也可以）点每个型号实际收到几件（好货、坏货），来错的货另外记，
// 好货分给各分店的数量由点货的人自己改（没动过分配的型号，好货一改就自动「少的先扣总部、多的放总部」），按「点完，货到了」→
// 这张 DO 算到货（各分店的「在路上」拿掉）；到货少 / 坏货 / 多到 / 来错自动记进「厂家问题」（采购照清单找厂家）。点完不能撤回。
// 预设：点货前已经记的坏货 / 到货少先填进去（好货 = 应到 − 已记的），资料库也只补记比已记的多出来的。
// #/purchasing/receive：待点货（ETA 近的在前）+ 最近点过（14 / 30 / 90 / 365 天、可搜寻）；#/purchasing/receive/<DO id>：点一张，或看点货纪录。
// 不含价格。看不到厂家的人（资料库已遮）：没有厂家、DO 号、PO 号、货柜、附件。分店栏由资料库给：总部账套四间、JB 账套只有 JB。
// 点完货：好货进仓库库存（进货待入 AutoCount，仓库搬动 kind = receive；查货、盘点的「应有」算进去），开单部开 GRN 后标已输入。
// 来错的货：搜我们的型号（进选的仓位）或「不是我们的产品」（不进库存）；要厂家怎么处理。开单时每行的备注显示给仓库看。
// 开单时记的来错型号（厂家 DO 对不上 PO 的行）预先带进「来错的货」（do_row：资料库跟确认时记的那笔对上，不重复记）：
// 是我们的型号的照点到的数量进库存；没认出来的要选我们的型号或「不是我们的产品」；没收到就拿掉。
// 点货的备注（每个型号、来错的货）会带进厂家问题、印在给厂家的清单 / 讯息上；内部的话写在「整张备注」。
// 拆档（2026-10-13，只搬程式码）：点货表单 RecvForm.tsx、点货纪录与进货待入 AutoCount RecvReceipt.tsx。
import { FormEvent, useCallback, useEffect, useState } from "react";
import { BRANCH_LABEL, can, fmtDate, fmtQty, Me, seesSupplier } from "../api";
import { go } from "../router";
import { Empty, ErrorBox } from "../ui";
import { joinList, podo, RecvFull, RecvList, RecvRow } from "../podo-api";
import { DoStatusBadge, EtaText, FileList, outletName, useOutlets } from "./common";
import { DAY_OPTIONS, doLabel, OutletCol, RecvForm } from "./RecvForm";
import { ReceiptView, SummaryTags } from "./RecvReceipt";

export default function ReceiveTab({ me, idParam }: { me: Me; idParam?: string }) {
  if (!idParam) return <RecvListView me={me} />;
  const id = Number(idParam);
  if (!Number.isInteger(id) || id <= 0) return <><BackLink /><ErrorBox error="找不到这张厂家 DO。" /></>;
  return <RecvLoad me={me} id={id} />;
}

function BackLink() {
  return <p className="small"><a href="#/purchasing/receive">← 点货清单</a></p>;
}

// ------------------------------------------------------------------ 清单
function RecvListView({ me }: { me: Me }) {
  const [company, setCompany] = useState("");
  const [days, setDays] = useState(14);
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [data, setData] = useState<RecvList | null>(null);
  const [error, setError] = useState("");
  const outlets = useOutlets();

  useEffect(() => {
    setData(null);
    setError("");
    podo.receiveList({ company, days, q: query }).then(setData).catch((e: Error) => setError(e.message));
  }, [company, days, query]);

  return (
    <>
      <p className="muted">
        {"厂家的货到了：点每个型号实际收到几件（好货、坏货），来错的货另外记；好货分给各分店的数量可以改。点完按「点完，货到了」。"}
        <br />{"到货少、坏货、多到、来错会自动记进「厂家问题」，采购照清单找厂家。"}
      </p>
      <form className="toolbar" onSubmit={(e: FormEvent) => { e.preventDefault(); setQuery(q.trim()); }}>
        {me.staff.branch === "ALL" && (
          <select value={company} onChange={(e) => setCompany(e.target.value)}>
            <option value="">全部分店</option>
            <option value="HOMEWORKSSB">{BRANCH_LABEL.HOMEWORKSSB}</option>
            <option value="HOMEWORKSSOUTHERN">{BRANCH_LABEL.HOMEWORKSSOUTHERN}</option>
          </select>
        )}
        <input value={q} onChange={(e) => setQ(e.target.value)}
               placeholder={seesSupplier(me) ? "找 DO 号 / 厂家 / PO / 型号…" : "找型号 / 品名…"} />
        <button type="submit" className="ghost">找</button>
        {query && <button type="button" className="ghost" onClick={() => { setQ(""); setQuery(""); }}>清除</button>}
      </form>
      <ErrorBox error={error} />
      {data === null ? <p className="muted">{error ? "" : "载入中…"}</p> : (
        <>
          <h3>{`待点货（${data.todo.length}）`}</h3>
          {data.todo.length === 0 ? <Empty>{query ? "找不到符合的厂家货。" : "没有要点的货。"}</Empty>
            : <RecvTable rows={data.todo} me={me} outlets={outlets} todo />}
          <div className="podo-group-head">
            <h3>{`最近点过（${data.done.length}）`}</h3>
            <select className="recv-days" value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="最近几天">
              {DAY_OPTIONS.map((n) => <option key={n} value={n}>{`最近 ${n} 天`}</option>)}
            </select>
          </div>
          {data.done.length === 0 ? <p className="muted small">{query ? "找不到符合的点货纪录。" : `最近 ${days} 天没有点过货。`}</p>
            : <RecvTable rows={data.done} me={me} outlets={outlets} />}
        </>
      )}
    </>
  );
}

function RecvTable({ rows, me, outlets, todo }: { rows: RecvRow[]; me: Me; outlets: OutletCol[]; todo?: boolean }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>厂家到货</th><th>ETA</th><th className="hide-sm">分到</th><th className="num">出货</th>
            <th>{todo ? "" : "点货"}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => (
            <tr key={d.id} className="click" onClick={() => go(`/purchasing/receive/${d.id}`)}>
              <td>
                <b>{doLabel(d)}</b>
                {me.staff.branch === "ALL" && <span className="tag">{BRANCH_LABEL[d.company]}</span>}
                {(d.supplier_name || d.creditor_code) && <><br /><span className="muted">{d.supplier_name || d.creditor_code}</span></>}
                {d.do_date && <><br /><small className="muted">{`DO 日期 ${d.do_date}`}</small></>}
              </td>
              <td className="nowrap">
                <EtaText eta={d.eta} source={d.eta_source} arrived={!todo} />
                {d.shipment_name && <><br /><small className="muted">{`柜 ${d.shipment_name}`}</small></>}
              </td>
              <td className="hide-sm">
                {d.outlets.map((o) => <span key={o} className="tag outlet">{outletName(outlets, o)}</span>)}
              </td>
              <td className="num">
                {fmtQty(d.shipped_total)}<br /><small className="muted">{`${d.item_count} 个型号`}</small>
              </td>
              <td className="nowrap">
                {todo ? <button className="small" onClick={(e) => { e.stopPropagation(); go(`/purchasing/receive/${d.id}`); }}>点货</button> : (
                  <>
                    {d.summary && <SummaryTags s={d.summary} unmatched={d.unmatched_count} />}
                    <br /><small className="muted">{`${d.arrived_by_name ?? ""} · ${fmtDate(d.arrived_at)}`}</small>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ------------------------------------------------------------------ 一张：载入
function RecvLoad({ me, id }: { me: Me; id: number }) {
  const [data, setData] = useState<RecvFull | null>(null);
  const [flash, setFlash] = useState("");
  const [error, setError] = useState("");
  const load = useCallback(() => podo.receiveGet(id).then(setData).catch((e: Error) => setError(e.message)), [id]);
  useEffect(() => { load(); }, [load]);
  if (!data) return <><BackLink />{error ? <ErrorBox error={error} /> : <p className="muted">载入中…</p>}</>;
  return (
    <>
      <BackLink />
      <RecvHead me={me} d={data} />
      {data.can_receive
        ? <RecvForm key={`${data.id}:${data.status}`} d={data}
                    onDone={(next, msg) => { setFlash(msg); setData(next); window.scrollTo(0, 0); }}
                    onRace={(msg) => { setFlash("!" + msg); load(); window.scrollTo(0, 0); }} />
        : <ReceiptView me={me} d={data} flash={flash} onChanged={() => { setFlash(""); load(); }} />}
    </>
  );
}

function RecvHead({ me, d }: { me: Me; d: RecvFull }) {
  return (
    <>
      <div className="page-head">
        <h2>
          {doLabel(d)} <DoStatusBadge status={d.status} />
          {me.staff.branch === "ALL" && <span className="tag">{BRANCH_LABEL[d.company]}</span>}
        </h2>
      </div>
      {(d.supplier_name || d.creditor_code) && (
        <p className="muted">
          <b>{d.supplier_name || d.creditor_code}</b>
          {d.creditor_code && d.supplier_name ? ` · ${d.creditor_code}` : ""}
          {d.po_nos.length > 0 ? ` · PO ${joinList(d.po_nos)}` : ""}
        </p>
      )}
      <p className="small">
        {"ETA "}<EtaText eta={d.eta} source={d.eta_source} arrived={d.status !== "confirmed"} />
        {d.shipment_name && <span className="tag">{`柜 ${d.shipment_name}`}</span>}
        {d.do_date && <small className="muted">{" · "}{`DO 日期 ${d.do_date}`}</small>}
      </p>
      {d.remark && <p className="small pre">{`备注：${d.remark}`}</p>}
      {d.files.length > 0 && (
        <details className="podo-history" open={d.can_receive}>
          <summary>{`厂家 DO / 装箱单（${d.files.length}）`}</summary>
          <FileList files={d.files} />
        </details>
      )}
      {can(me, "purchasing", "edit") && <p className="small"><a href={`#/purchasing/do/${d.id}`}>打开这张厂家到货 →</a></p>}
    </>
  );
}
