// 仓库 · 旧货：① 入货超过 12 个月 ② 12 个月没卖出 ③ 两者都是。每天随 BI 同步更新（bi.fact_item_aging + 月销量）。
// 仓库「可查看」看清单；「可审批」看成本、选商品标处理方式（清货 / 促销 / 退供应商 / 报废 / 保留）与负责人。
import { useCallback, useEffect, useState } from "react";
import { api, DirectoryEntry } from "../api";
import { supabase } from "../supabase";
import { Empty, ErrorBox, Modal } from "../ui";
import { qtyLabel } from "../wh-api";

type Kind = "both" | "old" | "nosale";
interface AgedRow {
  item_code: string; description: string; item_group: string; item_type: string; last_receipt: string; months: number;
  on_hand: number; stock_value: number | null; sold12: number; last_sale_month: string | null; is_old: boolean; no_sale: boolean;
  action: string; note: string; owner_id: number | null; owner_name: string | null; locations: { location: string; qty: number }[];
}
interface Aged {
  show_cost: boolean; can_edit: boolean; total: number; rows: AgedRow[];
  summary: { old_n: number; nosale_n: number; both_n: number; both_open: number; old_v: number | null; nosale_v: number | null; both_v: number | null };
}
export const ACTION_LABEL: Record<string, string> = {
  none: "还没决定", clearance: "清货", promo: "促销", return: "退供应商", scrap: "报废", keep: "保留（会卖）",
};
async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}
const rm = (v: number | null | undefined) => v == null ? "" : "RM " + Number(v).toLocaleString("en-MY", { maximumFractionDigits: 0 });

export function AgedTab({ company }: { company: string }) {
  const [kind, setKind] = useState<Kind>("both");
  const [act, setAct] = useState("");
  const [q, setQ] = useState("");
  const [data, setData] = useState<Aged | null>(null);
  const [error, setError] = useState("");
  const [sel, setSel] = useState<string[]>([]);
  const [marking, setMarking] = useState(false);

  const load = useCallback(() => {
    setError("");
    rpc<Aged>("ops_wh_aged", { p: { company, kind, action: act, q } }).then((d) => { setData(d); setSel([]); })
      .catch((e: Error) => setError(e.message));
  }, [company, kind, act, q]);
  useEffect(() => { setData(null); const t = setTimeout(load, q ? 400 : 0); return () => clearTimeout(t); }, [load, q]);

  const s = data?.summary;
  const toggle = (c: string) => setSel((x) => (x.includes(c) ? x.filter((y) => y !== c) : [...x, c]));
  return (
    <>
      {s && (
        <div className="kpis">
          <button className={"kpi" + (kind === "both" ? " on" : "")} onClick={() => setKind("both")}>
            <b>{s.both_n}</b><span>③ 又旧又没卖</span>{s.both_v != null && <small>{rm(s.both_v)}</small>}</button>
          <button className={"kpi" + (kind === "old" ? " on" : "")} onClick={() => setKind("old")}>
            <b>{s.old_n}</b><span>① 入货超过 12 个月</span>{s.old_v != null && <small>{rm(s.old_v)}</small>}</button>
          <button className={"kpi" + (kind === "nosale" ? " on" : "")} onClick={() => setKind("nosale")}>
            <b>{s.nosale_n}</b><span>② 12 个月没卖出</span>{s.nosale_v != null && <small>{rm(s.nosale_v)}</small>}</button>
          <div className={"kpi" + (s.both_open ? " warn" : "")}><b>{s.both_open}</b><span>③ 还没决定怎么处理</span></div>
        </div>
      )}
      <div className="filters">
        <select className="narrow-select" value={act} onChange={(e) => setAct(e.target.value)}>
          <option value="">全部处理方式</option>
          {Object.entries(ACTION_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <input className="search" placeholder="找代号 / 品名 / 类别" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <ErrorBox error={error} />
      {!data ? (!error && <p className="muted">载入中…（要几秒）</p>) : data.rows.length === 0 ? <Empty>没有符合的商品。</Empty> : (
        <>
          {data.total > data.rows.length && <p className="muted small">{`共 ${data.total} 项，先列出最大的 ${data.rows.length} 项；用上面的搜寻缩小范围。`}</p>}
          <div className="table-wrap">
            <table>
              <thead><tr>
                {data.can_edit && <th />}
                <th>商品</th><th className="hide-sm">最后进货</th><th className="num">现有</th>
                {data.show_cost && <th className="num">成本</th>}<th className="num hide-sm">12 个月卖了</th>
                <th className="hide-sm">放在</th><th>处理</th>
              </tr></thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.item_code}>
                    {data.can_edit && <td><input type="checkbox" checked={sel.includes(r.item_code)} onChange={() => toggle(r.item_code)} /></td>}
                    <td><b>{r.item_code}</b><div className="muted small">{r.description}</div>
                      <div className="muted small">{[r.item_group, r.item_type].filter(Boolean).join(" · ")}</div></td>
                    <td className="hide-sm nowrap">{r.last_receipt}<div className="muted small">{`${r.months} 个月前`}</div></td>
                    <td className="num">{qtyLabel(r.on_hand)}</td>
                    {data.show_cost && <td className="num">{rm(r.stock_value)}</td>}
                    <td className="num hide-sm">{qtyLabel(r.sold12)}{r.last_sale_month && <div className="muted small">{`最后 ${r.last_sale_month.slice(0, 7)}`}</div>}</td>
                    <td className="hide-sm small">{r.locations.map((l) => `${l.location} ${qtyLabel(l.qty)}`).join(" · ")}</td>
                    <td className="small"><span className={"ap " + (r.action === "none" ? "pending" : "approved")}>{ACTION_LABEL[r.action] ?? r.action}</span>
                      {r.owner_name && <div className="muted">{r.owner_name}</div>}{r.note && <div className="muted">{r.note}</div>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.can_edit && (
            <div className="card pay-save">
              <button disabled={!sel.length} onClick={() => setMarking(true)}>{`标处理方式（已选 ${sel.length} 项）`}</button>
              <button className="ghost" onClick={() => setSel(sel.length === data.rows.length ? [] : data.rows.map((r) => r.item_code))}>
                {sel.length === data.rows.length ? "全部取消" : "全选这页"}</button>
            </div>
          )}
        </>
      )}
      <p className="muted small">资料每天跟 AutoCount 同步一次。成本 = AutoCount 库存成本；中国货（CSxxx）很多没有单价，成本是 0。包装材料、运费这类不卖的项目也会出现在「12 个月没卖」，可以标「保留」。</p>
      {marking && <MarkForm company={company} codes={sel} onClose={() => setMarking(false)} onSaved={() => { setMarking(false); load(); }} />}
    </>
  );
}

function MarkForm({ company, codes, onClose, onSaved }: { company: string; codes: string[]; onClose: () => void; onSaved: () => void }) {
  const [action, setAction] = useState("clearance");
  const [owner, setOwner] = useState("");
  const [note, setNote] = useState("");
  const [people, setPeople] = useState<DirectoryEntry[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.directory().then(setPeople).catch(() => {}); }, []);
  async function save() {
    setBusy(true); setError("");
    try {
      await rpc<number>("ops_wh_aged_save", { p: { company, item_codes: codes, action, owner_id: owner || null, note } });
      onSaved();
    } catch (e) { setError((e as Error).message); setBusy(false); }
  }
  return (
    <Modal title={`处理方式（${codes.length} 项）`} onClose={onClose}>
      <div className="form">
        <label>怎么处理
          <select value={action} onChange={(e) => setAction(e.target.value)}>
            {Object.entries(ACTION_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <label>负责人（选填）
          <select value={owner} onChange={(e) => setOwner(e.target.value)}>
            <option value="">—</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label>备注（选填）<input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="例：十一月门市清货价 RM 99" /></label>
        <ErrorBox error={error} />
        <div className="actions">
          <button className="ghost" onClick={onClose}>取消</button>
          <button disabled={busy} onClick={save}>{busy ? "储存中…" : "储存"}</button>
        </div>
      </div>
    </Modal>
  );
}
