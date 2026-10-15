// 查货卡片里的一行：这个商品在各仓位的货架（应有 / 货架合计 / 未上架 / DO 待拣、货架小标签「A-R1-2 × 3」）。
// 这间公司还没建货架、或这个商品没有放在货架上 → 不显示。可编辑的人有「上架 / 拿下」连到货架分页。
import { useEffect, useState } from "react";
import { qtyLabel } from "../wh-api";
import { bins, ItemBins as ItemBinsData } from "../wh-bin-api";
import "../wh-bin.css";

export function ItemBins({ company, item_code, canEdit }: { company: string; item_code: string; canEdit: boolean }) {
  const [d, setD] = useState<ItemBinsData | null>(null);
  useEffect(() => {
    let alive = true;
    setD(null);
    bins.item(company, item_code).then((x) => alive && setD(x)).catch(() => alive && setD(null));
    return () => { alive = false; };
  }, [company, item_code]);
  const locs = (d?.locations ?? []).filter((l) => l.has_bins);
  if (!d || locs.length === 0) return null;
  const href = (loc: string) => `#/warehouse/bins/ops?item=${encodeURIComponent(d.item_code)}&loc=${encodeURIComponent(loc)}`;
  return (
    <div className="item-bins">
      <h3>货架</h3>
      {locs.map((l) => {
        const over = Number(l.shelved) > Math.max(Number(l.expected), 0);
        const dw = Number(l.do_unpicked ?? 0);
        const shown = l.bins.filter((b) => b.active);
        return (
          <div key={l.location} className="ib-loc">
            <div className="ib-head">
              <b>{l.location}</b>
              <span className="muted small">{`应有 ${qtyLabel(l.expected)} · 货架合计 ${qtyLabel(l.shelved)} · 未上架 ${qtyLabel(Math.max(0, Number(l.unshelved)))}${dw > 0 ? ` · DO 待拣 ${qtyLabel(dw)}` : ""}`}</span>
              {canEdit && <a className="ib-go" href={href(l.location)}>上架 / 拿下</a>}
            </div>
            {shown.length > 0 ? (
              <div className="ib-chips">
                {shown.map((b) => (
                  <span key={b.id} className={"bin-chip" + (Number(b.qty) > 0 ? "" : " zero")} title={Number(b.qty) > 0 ? undefined : "平常放这里"}>
                    {`${b.code} × ${qtyLabel(b.qty)}`}
                  </span>
                ))}
              </div>
            ) : <p className="muted small">还没放在货架上。</p>}
            {over && <p className="small late">{dw > 0 ? "货架合计比系统应有多，但有 DO 还没拣：拣完还多再去盘点。" : "货架合计比系统应有多：请去盘点这个商品。"}</p>}
          </div>
        );
      })}
    </div>
  );
}
