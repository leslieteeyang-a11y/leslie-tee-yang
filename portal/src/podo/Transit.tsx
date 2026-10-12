// 在路上：已确认、还没到货的厂家 DO，按分店列出每个型号分给这间分店几件与 ETA。不含价格。
// 总部 / 全部分店的人看全部分店；JB 的人只看 JB（资料库 ops_po_transit 已经过滤）。仓库可以在这里「货到了」。
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { BRANCH_LABEL, can, fmtQty, Me } from "../api";
import { Empty, ErrorBox } from "../ui";
import { joinList, podo, Transit, TransitRow } from "../podo-api";
import { AskModal, EtaText } from "./common";

interface DoGroup { do_id: number; head: TransitRow; rows: TransitRow[] }
interface OutletGroup { code: string; name: string; dos: DoGroup[]; qty: number }

export default function TransitTab({ me }: { me: Me }) {
  const [outlet, setOutlet] = useState("");
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [data, setData] = useState<Transit | null>(null);
  const [error, setError] = useState("");
  const [arrive, setArrive] = useState<TransitRow | null>(null);
  const canOpen = can(me, "purchasing", "edit");

  const load = useCallback(() => {
    setError("");
    podo.transit({ outlet, q: query }).then(setData).catch((e: Error) => setError(e.message));
  }, [outlet, query]);
  useEffect(() => { setData(null); load(); }, [load]);

  const groups = useMemo(() => {
    const out: OutletGroup[] = [];
    for (const r of data?.rows ?? []) {
      let g = out.find((x) => x.code === r.outlet);
      if (!g) { g = { code: r.outlet, name: r.outlet_name, dos: [], qty: 0 }; out.push(g); }
      let d = g.dos.find((x) => x.do_id === r.do_id);
      if (!d) { d = { do_id: r.do_id, head: r, rows: [] }; g.dos.push(d); }
      d.rows.push(r);
      g.qty += Number(r.qty);
    }
    return out;
  }, [data]);

  const search = (e: FormEvent) => { e.preventDefault(); setQuery(q.trim()); };

  return (
    <>
      <p className="muted">厂家已经出货、还没到的货（采购确认了厂家 DO）。数量是分给这间分店的件数；ETA 以货柜为准，没挂货柜就是厂家 DO 的 ETA。</p>
      <form className="toolbar" onSubmit={search}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜型号、品名、厂家、DO 号、PO 号…" />
        <button>搜寻</button>
        {data && data.outlets.length > 1 && (
          <select value={outlet} onChange={(e) => setOutlet(e.target.value)}>
            <option value="">全部分店</option>
            {data.outlets.map((o) => <option key={o.code} value={o.code}>{o.name}</option>)}
          </select>
        )}
      </form>
      <ErrorBox error={error} />
      {data === null ? <p className="muted">{error ? "" : "载入中…"}</p> : groups.length === 0 ? <Empty>没有在路上的货。</Empty> : (
        groups.map((g) => (
          <section key={g.code} className="podo-group">
            <div className="podo-group-head">
              <h3>{g.name}</h3>
              <small className="muted">{`${g.dos.length} 张 DO · ${fmtQty(g.qty)} 件`}</small>
            </div>
            <div className="table-wrap">
              <table>
                <thead><tr><th>型号 / 品名</th><th className="num">数量</th><th className="hide-sm">PO</th></tr></thead>
                <tbody>
                  {g.dos.map((d) => (
                    <DoRows key={d.do_id} d={d} canOpen={canOpen} showCompany={me.staff.branch === "ALL"} onArrive={setArrive} />
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ))
      )}
      {arrive && (
        <AskModal title="货到了" okText="标记到货" label="备注（可空白，例：少 1 箱、有破损已拍照）"
                  message={`DO ${arrive.do_no || "#" + arrive.do_id}（${arrive.supplier_name}）整张标记到货，所有分店的「在路上」都会拿掉这张。`}
                  onClose={() => setArrive(null)}
                  onOk={async (t) => { await podo.arrive(arrive.do_id, t); setArrive(null); load(); }} />
      )}
    </>
  );
}

function DoRows({ d, canOpen, showCompany, onArrive }: {
  d: DoGroup; canOpen: boolean; showCompany: boolean; onArrive: (r: TransitRow) => void;
}) {
  const h = d.head;
  const label = h.do_no || `#${h.do_id}`;
  return (
    <>
      <tr className="podo-do-row">
        <td colSpan={3}>
          <div className="podo-do-head">
            <span>
              {canOpen ? <a href={`#/purchasing/do/${h.do_id}`}><b>{`DO ${label}`}</b></a> : <b>{`DO ${label}`}</b>}
              <span className="muted">{` · ${h.supplier_name || h.creditor_code}`}</span>
              {showCompany && <span className="tag">{BRANCH_LABEL[h.company]}</span>}
              {h.shipment_name && <span className="tag">{`柜 ${h.shipment_name}`}</span>}
              <br />
              <span className="small">ETA <EtaText eta={h.eta} source={h.eta_source} /></span>
            </span>
            {h.can_arrive && <button className="small" onClick={() => onArrive(h)}>货到了</button>}
          </div>
        </td>
      </tr>
      {d.rows.map((r) => (
        <tr key={`${r.do_id}-${r.item_code}`}>
          <td><b>{r.item_code}</b><br /><small>{r.description}</small></td>
          <td className="num"><b>{fmtQty(r.qty)}</b> <small className="muted">{r.uom}</small></td>
          <td className="hide-sm small muted">{joinList(r.po_nos)}</td>
        </tr>
      ))}
    </>
  );
}
