// 拣货画面的小视窗：手动确认、略过、已拣好（缺货备注）、取消拣货、货架不够 / 单位跟货架帐不同
import { FormEvent, useState } from "react";
import { getLang, tr } from "../i18n";
import { ErrorBox, Modal } from "../ui";
import { qtyLabel } from "../wh-api";
import { Pick, PickBin, PickLine, pickUomDiff } from "../wh-pick-api";

const MANUAL_REASONS = ["没有条码", "条码坏了", "散装 / 零件", "整箱点数"];
const SKIP_REASONS = ["运费", "安装费", "不用出货", "服务 / 工钱"];

function Reasons({ list, onPick }: { list: string[]; onPick: (s: string) => void }) {
  return (
    <div className="pick-acts">
      {list.map((r) => <button key={r} type="button" className="ghost small" onClick={() => onPick(getLang() === "en" ? tr(r) : r)}>{r}</button>)}
    </div>
  );
}

/** 手动确认：没有条码的行（或条码坏了）直接填拣了几件；有对到商品、单位跟货架帐相同才可以选从哪个货架扣 */
export function ManualModal({ line, curBin, onClose, onSave }: {
  line: PickLine; curBin: { barcode: string; label: string } | null; onClose: () => void;
  onSave: (qty: number, reason: string, bin: string | null) => Promise<void>;
}) {
  const left = Math.max(0, Number(line.qty) - Number(line.picked));
  const [qty, setQty] = useState(String(left));
  const [reason, setReason] = useState("");
  const uomDiff = pickUomDiff(line);
  const binOpts = line.item_code && !uomDiff ? [
    ...(curBin && !line.bins.some((b) => b.barcode === curBin.barcode) ? [{ barcode: curBin.barcode, label: curBin.label }] : []),
    ...line.bins.map((b) => ({ barcode: b.barcode, label: `${b.location} · ${b.code} × ${qtyLabel(b.qty)}` })),
  ] : [];
  const [bin, setBin] = useState(line.item_code && !uomDiff && curBin ? curBin.barcode : "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError("");
    try { await onSave(Number(qty), reason.trim(), bin || null); } catch (err) { setError((err as Error).message); setBusy(false); }
  }
  return (
    <Modal title={`手动确认 · 第 ${line.line_no} 行`} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <p><b>{line.description}</b>{line.item_code && <><br /><span className="muted small">{line.item_code}</span></>}</p>
        <label>{`拣了几件（还差 ${qtyLabel(left)}）`}
          <input className="big-num" type="number" inputMode="decimal" min="0" step="any" value={qty} autoFocus
                 onChange={(e) => setQty(e.target.value)} required /></label>
        <label>原因
          <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="例：没有条码" required /></label>
        <Reasons list={MANUAL_REASONS} onPick={setReason} />
        {uomDiff && <p className="muted small">这行的单位跟货架上的不同，不能从货架扣。</p>}
        {binOpts.length > 0 && (
          <label>从哪个货架拿（选填）
            <select value={bin} onChange={(e) => setBin(e.target.value)}>
              <option value="">不从货架扣</option>
              {binOpts.map((b) => <option key={b.barcode} value={b.barcode}>{b.label}</option>)}
            </select></label>
        )}
        <ErrorBox error={error} />
        <div className="actions">
          <button type="button" className="ghost" onClick={onClose}>取消</button>
          <button disabled={busy || !reason.trim() || !(Number(qty) > 0)}>{busy ? "储存中…" : "确认"}</button>
        </div>
      </form>
    </Modal>
  );
}

/** 略过（运费、不用出货的）：要写原因 */
export function SkipModal({ line, onClose, onSave }: { line: PickLine; onClose: () => void; onSave: (reason: string) => Promise<void> }) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError("");
    try { await onSave(reason.trim()); } catch (err) { setError((err as Error).message); setBusy(false); }
  }
  return (
    <Modal title={`略过 · 第 ${line.line_no} 行`} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <p><b>{line.description}</b></p>
        <label>原因
          <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="例：运费" autoFocus required /></label>
        <Reasons list={SKIP_REASONS} onPick={setReason} />
        <p className="muted small">略过的行不用拣，也不算缺货。</p>
        <ErrorBox error={error} />
        <div className="actions">
          <button type="button" className="ghost" onClick={onClose}>取消</button>
          <button disabled={busy || !reason.trim()}>{busy ? "储存中…" : "略过这行"}</button>
        </div>
      </form>
    </Modal>
  );
}

/** 还有没拣够的行：写缺货备注才可以完成 */
export function DoneModal({ short, onClose, onSave }: {
  short: PickLine[]; onClose: () => void; onSave: (note: string) => Promise<void>;
}) {
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError("");
    try { await onSave(note.trim()); } catch (err) { setError((err as Error).message); setBusy(false); }
  }
  return (
    <Modal title="还没拣够" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <p className="late">{`还有 ${short.length} 行没拣够：`}</p>
        <ul className="list">
          {short.map((l) => (
            <li key={l.line_no}><span>{`#${l.line_no} ${l.item_code || l.description}`}</span>
              <span className="nowrap">{`${qtyLabel(l.picked)} / ${qtyLabel(l.qty)}`}</span></li>
          ))}
        </ul>
        <label>缺货备注（会给开单 / 送货的人看）
          <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} autoFocus
                    placeholder="例：HM-UB001 只剩 2 件，第 3 件下次补" required /></label>
        <ErrorBox error={error} />
        <div className="actions">
          <button type="button" className="ghost" onClick={onClose}>继续拣</button>
          <button disabled={busy || !note.trim()}>{busy ? "储存中…" : "就这样出货"}</button>
        </div>
      </form>
    </Modal>
  );
}

/** 取消整张拣货单：从货架扣的全部加回去 */
export function CancelModal({ p, onClose, onSave }: { p: Pick; onClose: () => void; onSave: (reason: string) => Promise<void> }) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError("");
    try { await onSave(reason.trim()); } catch (err) { setError((err as Error).message); setBusy(false); }
  }
  return (
    <Modal title={`取消拣货 · ${p.doc_no}`} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <p className="muted">从货架扣的数量会全部加回去（货要放回原来的货架）。取消后可以重新开始拣。</p>
        <label>原因
          <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="例：DO 取消了、拣错要重来" autoFocus required /></label>
        <ErrorBox error={error} />
        <div className="actions">
          <button type="button" className="ghost" onClick={onClose}>不要取消</button>
          <button className="danger-fill" disabled={busy || !reason.trim()}>{busy ? "储存中…" : "取消拣货"}</button>
        </div>
      </form>
    </Modal>
  );
}

/** 货架上不够：可以改选有货的货架（多半是拿错货架或忘了扫货架），或「不从货架扣」直接记。
 *  uom = DO 的单位跟货架帐（商品基本单位）不同：哪个货架都不能扣，只能「不从货架扣」 */
export function BinShortModal({ message, qty, bins, uom, onClose, onBin, onNoBin }: {
  message: string; qty: number; bins: PickBin[]; uom?: boolean; onClose: () => void; onBin: (b: PickBin) => void; onNoBin: () => void;
}) {
  const enough = uom ? [] : bins.filter((b) => Number(b.qty) >= qty);
  return (
    <Modal title={uom ? "单位跟货架上的不同" : "货架上不够"} onClose={onClose}>
      <p className="late">{message}</p>
      {uom && <p className="small">这行的单位跟货架上的不同，不能从货架扣；可以选「不从货架扣」记下拣货。</p>}
      {enough.length > 0 && (
        <>
          <p className="muted small">是从别的货架拿的吗？点那个货架：</p>
          <div className="pick-acts">
            {enough.map((b) => (
              <button key={b.id} className="bin-chip" onClick={() => onBin(b)}>{`${b.location} · ${b.code} × ${qtyLabel(b.qty)}`}</button>
            ))}
          </div>
        </>
      )}
      {!uom && <p className="muted small">可能是货架帐不准（上次没登记）。如果货真的拿到了，可以不从货架扣、直接记拣货，之后请主管去盘点这个货架。</p>}
      <div className="actions">
        <button className="ghost" onClick={onClose}>取消</button>
        <button onClick={onNoBin}>不从货架扣，直接记拣货</button>
      </div>
    </Modal>
  );
}
