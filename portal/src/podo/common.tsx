// 厂家到货 / 厂家问题 / 在路上 共用的小元件
import { FormEvent, useEffect, useState } from "react";
import { todayKL } from "../api";
import { ErrorBox, Modal } from "../ui";
import {
  DECISION_LABEL, DO_ETA_SOURCE_LABEL, DO_STATUS_LABEL, DoFile, DoSop, DoStatus, fileExt, fmtSize, Issue, IssueKind, issueKindLabel,
  IssueRequest, ISSUE_STATUS_LABEL, isSheet, openDoFile, Outlet, OurItem, podo, requestLabel, requestOptions, SOP_OWNER_LABEL,
  SOP_STEPS,
} from "../podo-api";

export function DoStatusBadge({ status }: { status: DoStatus }) {
  return <span className={"dos " + status}>{DO_STATUS_LABEL[status]}</span>;
}

export function IssueBadges({ i }: { i: Pick<Issue, "kind" | "auto" | "decision" | "status"> & { request?: IssueRequest | null } }) {
  return (
    <>
      <span className={"isk " + i.kind}>{issueKindLabel(i)}</span>
      {(i.kind === "short" || i.kind === "part") && i.decision && i.status !== "void" && (
        <span className={"isd " + i.decision}>{DECISION_LABEL[i.decision]}</span>
      )}
      {i.status !== "open" && <span className={"iss " + i.status}>{ISSUE_STATUS_LABEL[i.status]}</span>}
      {i.request && i.status !== "void" && <span className="isr">{`要厂家：${requestLabel(i.kind, i.request)}`}</span>}
    </>
  );
}

/** 要厂家怎么处理（少发没有：少发看「厂家会补 / 取消」）。空 = 还没指定 */
export function RequestSelect({ kind, value, onChange, disabled, label = "要厂家怎么处理" }: {
  kind: IssueKind; value: IssueRequest | "" | null | undefined; onChange: (v: IssueRequest | "") => void; disabled?: boolean; label?: string;
}) {
  return (
    <select value={value ?? ""} disabled={disabled} aria-label={label} onChange={(e) => onChange(e.target.value as IssueRequest | "")}>
      <option value="">—</option>
      {requestOptions(kind).map((r) => <option key={r} value={r}>{requestLabel(kind, r)}</option>)}
    </select>
  );
}

/** 「收到的型号」：打型号或品名搜我们的商品（选了 own = true、带出品名）；或按「不是我们的产品」（own = false，自己打型号 / 品名，品名必填）。
 *  own = null = 还没选（打的字不算，要从清单选）。seed = 开单时厂家 DO 上的写法（搜寻框先填型号；按「不是我们的产品」带进去）。
 *  在搜寻框按 Enter 不会送出表单：只有一笔结果就选那笔。 */
export interface Picked { own: boolean | null; code: string; desc: string }
export const NOT_PICKED: Picked = { own: null, code: "", desc: "" };
export function OurItemPicker({ company, value, onChange, disabled, seed }: {
  company: string | null; value: Picked; onChange: (v: Picked) => void; disabled?: boolean; seed?: { code: string; desc: string };
}) {
  const [q, setQ] = useState(() => seed?.code || "");
  const [hits, setHits] = useState<OurItem[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (value.own !== null) return;
    const k = q.trim();
    if (!k) { setHits(null); return; }
    let live = true;
    const t = setTimeout(() => {
      podo.itemSearch(company, k).then((r) => { if (live) setHits(r); }).catch((e: Error) => { if (live) setError(e.message); });
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [q, company, value.own]);

  if (value.own === true)
    return (
      <div className="our-pick chosen">
        <span><b>{value.code}</b> <small>{value.desc}</small></span>
        {!disabled && <button type="button" className="text-btn small" onClick={() => { setQ(value.code); setHits(null); onChange(NOT_PICKED); }}>改选</button>}
      </div>
    );
  if (value.own === false)
    return (
      <div className="our-pick">
        <span className="our-pick-head">
          <span className="tag warn">不是我们的产品</span>
          {!disabled && <button type="button" className="text-btn small" onClick={() => { setQ(value.code); onChange(NOT_PICKED); }}>改成我们的型号</button>}
        </span>
        <input value={value.code} disabled={disabled} placeholder="厂家写的型号（可空白）" aria-label="厂家写的型号"
               onChange={(e) => onChange({ ...value, code: e.target.value })} />
        <input value={value.desc} disabled={disabled} placeholder="品名（必填）" aria-label="品名（必填）"
               onChange={(e) => onChange({ ...value, desc: e.target.value })} />
      </div>
    );
  return (
    <div className="our-pick">
      <input value={q} disabled={disabled} placeholder="打型号或品名找我们的商品…" aria-label="收到的型号"
             onChange={(e) => { setQ(e.target.value); setError(""); }}
             onKeyDown={(e) => {
               if (e.key !== "Enter") return;
               e.preventDefault();          // 在表单里按 Enter / 手机「前往」不要送出整张表单
               if (hits && hits.length === 1) onChange({ own: true, code: hits[0].item_code, desc: hits[0].description });
             }} />
      {hits && hits.length > 0 && (
        <ul className="our-pick-list">
          {hits.map((h) => (
            <li key={h.item_code}>
              <button type="button" disabled={disabled} onClick={() => onChange({ own: true, code: h.item_code, desc: h.description })}>
                <b>{h.item_code}</b> <small>{h.description}</small>
              </button>
            </li>
          ))}
        </ul>
      )}
      {hits && hits.length === 0 && (
        <small className="muted">找不到我们的商品。AutoCount 今天才开的新型号要等隔天同步后才搜得到：请先联络开单部，不要急著选「不是我们的产品」（选了不会进库存）。</small>
      )}
      <button type="button" className="text-btn small our-pick-not" disabled={disabled}
              onClick={() => onChange({ own: false, code: q.trim() || seed?.code || "", desc: seed?.desc ?? "" })}>不是我们的产品</button>
      <ErrorBox error={error} />
    </div>
  );
}

/** SOP：现在在第几步、等哪个部门；做完的打勾。草稿超过 24 小时还没确认标红 */
const STEP_DEPT = ["订货部", "订货部", "订货部", "订货部", "订货部", "仓库部", "订货部"];
export function SopSteps({ sop }: { sop: DoSop }) {
  if (sop.step == null) return null;
  const d = sop.done;
  const done = [d.po, d.shipped, d.alloc, d.eta, d.confirmed, d.received, d.received && d.decided];
  const cur = sop.step;
  const grn = Number(sop.grn_n ?? 0);
  return (
    <div className={"card sop" + (sop.draft_overdue ? " overdue" : "")}>
      <ol className="sop-steps">
        {SOP_STEPS.map((label, i) => (
          <li key={i} className={(done[i] ? "done" : cur > i + 1 ? "skip" : "") + (cur === i + 1 ? " cur" : "")}>
            <span className="n">{done[i] ? "✓" : String(i + 1)}</span>
            <span className="t">{label}</span>
            <small className="muted">{STEP_DEPT[i]}</small>
          </li>
        ))}
      </ol>
      <p className="small sop-now">
        {cur >= 8 && grn > 0 ? (
          <>
            <b>{`第 8 步：开进货单（GRN）`}</b>
            <span className="tag">{SOP_OWNER_LABEL.billing}</span>
            <span className="amber">{`开单部还有 ${grn} 笔进货要在 AutoCount 开进货单（GRN）`}</span>
          </>
        ) : cur >= 8 ? <span className="okc">都做完了</span> : (
          <>
            <b>{`第 ${cur} 步：${SOP_STEPS[cur - 1]}`}</b>
            {sop.owner && <span className="tag">{SOP_OWNER_LABEL[sop.owner]}</span>}
            {cur === 7 && sop.decide_n > 0 && <span className="late">{`还有 ${sop.decide_n} 个少发 / 缺零件要决定（厂家会补或取消）`}</span>}
            {cur === 5 && !d.eta && <span className="amber">还没填 ETA（可以先确认，之后再补）</span>}
            {cur === 7 && grn > 0 && <span className="muted">{`开单部还有 ${grn} 笔进货要开 GRN`}</span>}
          </>
        )}
        {sop.draft_overdue && <span className="late">草稿开了超过 24 小时还没确认</span>}
      </p>
    </div>
  );
}

/** 清单里的一行小字：第几步 · 等哪个部门 */
export function SopLine({ sop }: { sop?: DoSop }) {
  if (!sop || sop.step == null) return null;
  return (
    <>
      <br />
      <small className={sop.draft_overdue ? "late" : "muted"}>
        {sop.step >= 8 ? (Number(sop.grn_n ?? 0) > 0 ? "第 8 步：开进货单（GRN）" : "都做完了") : `第 ${sop.step} 步：${SOP_STEPS[sop.step - 1]}`}
      </small>
      {sop.owner && (sop.step < 8 || Number(sop.grn_n ?? 0) > 0) && <><br /><small className="muted">{SOP_OWNER_LABEL[sop.owner]}</small></>}
      {sop.draft_overdue && <><br /><span className="tag warn">超过 24 小时没确认</span></>}
    </>
  );
}

/** 几个问题一起显示：一行一个框（英文模式才能逐行翻） */
export function ErrorLines({ error }: { error: string }) {
  const lines = error.split("\n").map((x) => x.trim()).filter(Boolean);
  return <>{lines.map((x, n) => <div key={n} className="error">{x}</div>)}</>;
}

/** ETA：过了还没到 → 红字 */
export function EtaText({ eta, source, arrived }: { eta: string | null; source?: string | null; arrived?: boolean }) {
  if (!eta) return <span className="muted">未填</span>;
  const late = !arrived && eta < todayKL();
  return (
    <>
      <span className={late ? "late" : ""}>{eta}</span>
      {source && <small className="muted">{` · ${DO_ETA_SOURCE_LABEL[source] ?? source}`}</small>}
      {late && <small className="late">{" · 已过 ETA"}</small>}
    </>
  );
}

/** 一个小问题框：写原因 / 备注后按确定（不用 window.prompt，英文模式才翻得到） */
export function AskModal({ title, message, label, initial = "", required, okText, danger, onClose, onOk }: {
  title: string; message?: string; label?: string; initial?: string; required?: boolean; okText: string; danger?: boolean;
  onClose: () => void; onOk: (text: string) => Promise<void>;
}) {
  const [text, setText] = useState(initial);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (required && !text.trim()) return setError("请填写。");
    setBusy(true);
    setError("");
    try {
      await onOk(text.trim());
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }
  return (
    <Modal title={title} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        {message && <p className="pre">{message}</p>}
        {label && <label>{label}<textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} autoFocus /></label>}
        <ErrorBox error={error} />
        <div className="actions">
          <button type="button" className="ghost" onClick={onClose}>取消</button>
          <button className={danger ? "danger-solid" : ""} disabled={busy}>{busy ? "处理中…" : okText}</button>
        </div>
      </form>
    </Modal>
  );
}

const FILE_ICON: Record<string, string> = { xlsx: "▦", xls: "▦", csv: "▦", pdf: "▤" };

/** 附件清单：点档名开新分页（私有档案换成 1 小时的网址）；Excel 可以「读数量」 */
export function FileList({ files, onRemove, onRead }: {
  files: DoFile[]; onRemove?: (f: DoFile) => void; onRead?: (f: DoFile) => void;
}) {
  const [error, setError] = useState("");
  if (!files.length) return <p className="muted small">还没有附件。</p>;
  return (
    <>
      <ul className="list podo-files">
        {files.map((f) => (
          <li key={f.path}>
            <span>
              <span className="ico">{FILE_ICON[fileExt(f.name)] ?? "▣"}</span>{" "}
              <button type="button" className="text-btn" onClick={() => openDoFile(f).catch((e: Error) => setError(e.message))}>
                {f.name}
              </button>
              {f.size ? <small className="muted">{` · ${fmtSize(f.size)}`}</small> : null}
            </span>
            <span className="nowrap">
              {onRead && isSheet(f.name) && <button type="button" className="small ghost" onClick={() => onRead(f)}>读数量</button>}
              {onRemove && <button type="button" className="small ghost danger" onClick={() => onRemove(f)} aria-label="拿掉附件">×</button>}
            </span>
          </li>
        ))}
      </ul>
      <ErrorBox error={error} />
    </>
  );
}

// 分店清单（少变动：开一次页面只读一次）
let outletCache: Promise<Outlet[]> | null = null;
export function useOutlets(): Outlet[] {
  const [rows, setRows] = useState<Outlet[]>([]);
  useEffect(() => {
    if (!outletCache) outletCache = podo.outlets().catch((e) => { outletCache = null; throw e; });
    outletCache.then(setRows).catch(() => {});
  }, []);
  return rows;
}

export function outletName(outlets: { code: string; short_name?: string; name: string }[], code: string): string {
  const o = outlets.find((x) => x.code === code);
  return o ? o.short_name || o.name : code;
}
