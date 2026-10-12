// 厂家到货 / 厂家问题 / 在路上 共用的小元件
import { FormEvent, useEffect, useState } from "react";
import { todayKL } from "../api";
import { ErrorBox, Modal } from "../ui";
import {
  DECISION_LABEL, DO_ETA_SOURCE_LABEL, DO_STATUS_LABEL, DoFile, DoStatus, fileExt, fmtSize, Issue, issueKindLabel,
  ISSUE_STATUS_LABEL, isSheet, openDoFile, Outlet, podo,
} from "../podo-api";

export function DoStatusBadge({ status }: { status: DoStatus }) {
  return <span className={"dos " + status}>{DO_STATUS_LABEL[status]}</span>;
}

export function IssueBadges({ i }: { i: Issue }) {
  return (
    <>
      <span className={"isk " + i.kind}>{issueKindLabel(i)}</span>
      {i.kind === "short" && i.decision && i.status !== "void" && (
        <span className={"isd " + i.decision}>{DECISION_LABEL[i.decision]}</span>
      )}
      {i.status !== "open" && <span className={"iss " + i.status}>{ISSUE_STATUS_LABEL[i.status]}</span>}
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
