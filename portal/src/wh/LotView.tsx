// 批次画面（#/warehouse/lot/<批次号>）：扫箱贴上的 QR 打开。商品、数量、几箱、给哪间分店、点货日期 / 人、
// 厂家 DO 号（只给看得到厂家的人）、这个商品在这个仓位的货架、打印纪录；可以补印箱贴。
import { useEffect, useState } from "react";
import { fmtQty } from "../api";
import { ErrorBox } from "../ui";
import { whenLabel } from "../wh-api";
import { dateKL, LotDetail, whTag } from "../wh-tag-api";
import { BoxPreview, BoxSize, savedSize, SizePick, useBoxPrint } from "./BoxLabels";
import { ItemMedia } from "./ItemPhoto";
import "../wh-tag.css";

const MOVE_STATUS: Record<string, string> = { pending: "待开进货单（GRN）", done: "已输入 AutoCount", cancelled: "进货已取消" };

export default function LotView({ lotNo, canEdit }: { lotNo: string; canEdit: boolean }) {
  const [d, setD] = useState<LotDetail | null>(null);
  const [error, setError] = useState("");
  const [size, setSize] = useState<BoxSize>(savedSize);
  const [preview, setPreview] = useState(false);
  const bp = useBoxPrint();
  const load = () => whTag.lot(lotNo).then(setD).catch((e: Error) => setError(e.message));
  useEffect(() => { setD(null); setError(""); if (lotNo) load(); else setError("请扫箱贴上的 QR，或在「印条码 → 打印纪录」找批次。"); }, [lotNo]);

  if (!d) return <>{error ? <ErrorBox error={error} /> : <p className="muted">载入中…</p>}<p><a href="#/warehouse/labels/log">← 打印纪录</a></p></>;
  const unshelved = Number(d.expected) - Number(d.shelved);
  return (
    <>
      <p className="small"><a href="#/warehouse/labels/boxes">← 箱贴</a></p>
      <section className="card wht-lot">
        <div className="page-head">
          <div>
            <h2>{`批次 ${d.lot_no}`}</h2>
            <p><b className="wht-lot-code">{d.item_code}</b>{" "}<span>{d.description}</span></p>
          </div>
          {d.outlet_name && <span className="tag outlet wht-for">{`给 ${d.outlet_name}`}</span>}
        </div>
        <ItemMedia company={d.company} itemCode={d.item_code} canEdit={canEdit} />
        <dl className="wht-facts">
          <dt>数量</dt><dd>{`${fmtQty(d.qty)} ${d.uom ?? ""}`}</dd>
          <dt>几箱</dt><dd>{d.boxes}</dd>
          <dt>仓位</dt><dd>{d.location ?? "—"}</dd>
          <dt>点货日期</dt><dd>{[dateKL(d.received_at), d.received_by_name].filter(Boolean).join(" · ") || "—"}</dd>
          {d.do_no && <><dt>厂家 DO</dt><dd>{d.do_no}</dd></>}
          {d.supplier_name && <><dt>厂家</dt><dd>{d.supplier_name}</dd></>}
          {d.po_no && <><dt>PO</dt><dd>{d.po_no}</dd></>}
          {d.move_status && <><dt>进货</dt><dd>{MOVE_STATUS[d.move_status] ?? d.move_status}{d.move_ac_doc ? ` · ${d.move_ac_doc}` : ""}</dd></>}
          <dt>建批次</dt><dd>{[whenLabel(d.created_at), d.created_by_name].filter(Boolean).join(" · ")}</dd>
          {d.note && <><dt>备注</dt><dd className="pre">{d.note}</dd></>}
        </dl>
      </section>

      <section className="card">
        <h3>{`货架（${d.location ?? ""}）`}</h3>
        <p className="small">{`应有 ${fmtQty(d.expected)} · 货架上 ${fmtQty(d.shelved)}${unshelved > 0 ? ` · 未上架 ${fmtQty(unshelved)}` : ""}`}</p>
        {d.bins.length === 0 ? <p className="muted small">这个商品在这个仓位还没有放过货架。</p> : (
          <div className="wht-chips">
            {d.bins.map((b) => <span key={b.id} className={"wht-bin" + (Number(b.qty) > 0 ? "" : " zero")}>{Number(b.qty) > 0 ? `${b.code} × ${fmtQty(b.qty)}` : `${b.code}（平常放这里）`}</span>)}
          </div>
        )}
        {canEdit && unshelved > 0 && <p className="small"><a href={`#/warehouse/bins/ops?item=${encodeURIComponent(d.item_code)}`}>上架 →</a></p>}
      </section>

      <section className="card">
        <div className="wht-group-head">
          <h3>{`打印纪录（已印 ${d.printed} 张）`}</h3>
        </div>
        {d.prints.length === 0 ? <p className="muted small">还没印过。</p> : (
          <ul className="list">
            {d.prints.map((p) => (
              <li key={p.id}><span>{`${whenLabel(p.created_at)} · ${p.by_name ?? ""}`}</span><span className="small">{`${p.copies} 张 · ${sizeName(p.size)}`}</span></li>
            ))}
          </ul>
        )}
        {d.can_print && (
          <div className="filters">
            <SizePick size={size} onChange={setSize} />
            <button disabled={bp.printing} onClick={async () => { await bp.print([d], size); setTimeout(load, 800); }}>{`🖨 补印箱贴（${d.boxes} 张）`}</button>
            <button className="small ghost" onClick={() => setPreview(!preview)}>{preview ? "收起预览" : "预览"}</button>
          </div>
        )}
        {preview && <BoxPreview lot={d} size={size} />}
        <ErrorBox error={bp.error} />
      </section>
      {bp.portal}
    </>
  );
}

export function sizeName(s: string): string {
  return s === "big" ? "大箱 100×60mm" : s === "small" ? "小箱 50×30mm" : s;
}
