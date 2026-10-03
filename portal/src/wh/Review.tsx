// 仓库 · 差异审核（可审批）：在 AutoCount 调整后标「已调整」，或「不调整」/「请重盘」；仓位设定。
import { useCallback, useEffect, useState } from "react";
import { Empty, ErrorBox, Modal, Tabs } from "../ui";
import { Count, COUNT_STATUS_LABEL, qtyLabel, whenLabel, wh, WhMeta } from "../wh-api";

export function ReviewTab({ company, meta, onMeta }: { company: string; meta: WhMeta; onMeta: (m: WhMeta) => void }) {
  const [status, setStatus] = useState<"variance" | "adjusted" | "ignored" | "all">("variance");
  const [rows, setRows] = useState<Count[] | null>(null);
  const [error, setError] = useState("");
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [doc, setDoc] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [settings, setSettings] = useState(false);

  const load = useCallback(() => {
    setRows(null); setError(""); setPicked(new Set());
    wh.counts({ company, status }).then(setRows).catch((e: Error) => setError(e.message));
  }, [company, status]);
  useEffect(load, [load]);

  async function review(action: "adjusted" | "ignored" | "recount") {
    setBusy(true); setError("");
    try { await wh.review([...picked], action, doc, note); setDoc(""); setNote(""); load(); }
    catch (e) { setError((e as Error).message); }
    setBusy(false);
  }
  const toggle = (id: number) => setPicked((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const sum = (rows || []).reduce((a, r) => a + Number(r.diff_value || 0), 0);

  function csv() {
    if (!rows) return;
    const head = ["日期", "仓位", "商品代号", "品名", "单位", "AutoCount", "未输入搬动", "应有", "实盘", "差额", "成本差额", "盘点人", "备注"];
    const lines = rows.map((r) => [r.count_date, r.location, r.item_code, r.description, r.uom, r.system_qty, r.pending_qty,
      r.expected_qty, r.qty, r.diff, r.diff_value, r.counted_by_name, r.note]);
    const text = [head, ...lines].map((l) => l.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\r\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(["﻿" + text], { type: "text/csv;charset=utf-8" }));
    a.download = `盘点差异_${company}_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
  }

  return (
    <>
      <div className="filters">
        <Tabs value={status} onChange={setStatus} options={[["variance", "待审核"], ["adjusted", "已调整"], ["ignored", "不调整"], ["all", "全部"]]} />
        <button className="ghost" disabled={!rows?.length} onClick={csv}>下载 CSV（Excel）</button>
        <button className="ghost" onClick={() => setSettings(true)}>仓位设定</button>
      </div>
      <ErrorBox error={error} />
      {!rows ? (!error && <p className="muted">载入中…</p>) : rows.length === 0 ? <Empty>{status === "variance" ? "没有待审核的差异。" : "没有纪录。"}</Empty> : (
        <div className="table-wrap">
          <table>
            <thead><tr>{status === "variance" && <th />}<th>商品</th><th>仓位</th><th className="num">应有</th><th className="num">实盘</th><th className="num">差额</th><th className="num hide-sm">成本差额</th><th className="hide-sm">盘点</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  {status === "variance" && <td><input type="checkbox" checked={picked.has(r.id)} onChange={() => toggle(r.id)} /></td>}
                  <td><b>{r.item_code}</b><div className="muted small">{r.description}</div>{r.note && <div className="small">{r.note}</div>}
                    {r.status !== "variance" && <div className="muted small">{`${COUNT_STATUS_LABEL[r.status]}${r.ac_doc ? ` · ${r.ac_doc}` : ""}${r.review_note ? ` · ${r.review_note}` : ""}`}</div>}</td>
                  <td>{r.location}</td>
                  <td className="num">{qtyLabel(r.expected_qty)}{Number(r.pending_qty) !== 0 && <div className="muted small">{`AC ${qtyLabel(r.system_qty)}`}</div>}</td>
                  <td className="num">{qtyLabel(r.qty)}{r.attempt === 1 && r.status === "variance" && <div className="muted small">未重数</div>}</td>
                  <td className={"num" + (Number(r.diff) ? " late" : "")}>{Number(r.diff) > 0 ? "+" : ""}{qtyLabel(r.diff)}</td>
                  <td className="num hide-sm">{Number(r.diff_value || 0).toFixed(2)}</td>
                  <td className="hide-sm small">{r.counted_by_name}<div className="muted">{whenLabel(r.counted_at)}</div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {rows && rows.length > 0 && <p className="muted small">{`成本差额合计 RM ${sum.toFixed(2)}（负数 = 少了）。差额 = 实盘 − 应有；应有 = AutoCount 库存 + 还没输入 AutoCount 的搬动。`}</p>}
      {status === "variance" && rows && rows.length > 0 && (
        <div className="card wh-bulk">
          <p className="small">{`选了 ${picked.size} 笔：在 AutoCount 开库存调整单（Stock Adjustment）后按「已调整」；查到原因不必调的按「不调整」并写原因；觉得数错了按「请重盘」（明天会再出现在清单）。`}</p>
          <div className="row">
            <input placeholder="AutoCount 调整单号（选填）" value={doc} onChange={(e) => setDoc(e.target.value)} />
            <input placeholder="原因 / 备注（不调整时必填）" value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          <div className="actions left">
            <button disabled={busy || !picked.size} onClick={() => review("adjusted")}>✓ 已调整</button>
            <button className="ghost" disabled={busy || !picked.size} onClick={() => review("ignored")}>不调整</button>
            <button className="ghost" disabled={busy || !picked.size} onClick={() => review("recount")}>请重盘</button>
          </div>
        </div>
      )}
      {settings && <LocationSettings company={company} meta={meta} onClose={() => setSettings(false)}
                                     onSaved={() => wh.meta().then(onMeta)} />}
    </>
  );
}

function LocationSettings({ company, meta, onClose, onSaved }: { company: string; meta: WhMeta; onClose: () => void; onSaved: () => void }) {
  const [error, setError] = useState("");
  const rows = meta.locations.filter((l) => l.company === company);
  const save = (p: Record<string, unknown>) => wh.saveLocation({ company, ...p }).then(onSaved).catch((e: Error) => setError(e.message));
  return (
    <Modal title="仓位设定" onClose={onClose}>
      <p className="muted small">每天每个仓位要盘几件；不用盘的仓位（例：EGO、JB RESER）取消勾选。</p>
      <ErrorBox error={error} />
      <div className="table-wrap flat">
        <table>
          <thead><tr><th>仓位</th><th>要盘点</th><th className="num">每天几件</th></tr></thead>
          <tbody>
            {rows.map((l) => (
              <tr key={l.code}>
                <td>{l.code}</td>
                <td><input type="checkbox" checked={l.counting} onChange={(e) => save({ code: l.code, counting: e.target.checked })} /></td>
                <td className="num"><input className="num-input" type="number" min="1" max="500" defaultValue={l.daily_target}
                                           onBlur={(e) => Number(e.target.value) !== l.daily_target && save({ code: l.code, daily_target: e.target.value })} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="actions"><button onClick={onClose}>完成</button></div>
    </Modal>
  );
}
