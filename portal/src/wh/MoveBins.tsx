// 仓库 · 单笔「登记搬动」的货架栏（选填，2026-10-15 审查后加）：从哪个货架拿（来源仓位里放这个商品、还有货的货架）、
// 放到哪个货架（目的仓位里启用中的货架；这个商品已经放的排前面）。有选 = MoveForm 改用多行搬动的资料库函数送一行，货架帐一起变。
import { useEffect, useState } from "react";
import { qtyLabel } from "../wh-api";
import { BinRow, bins, ItemBins } from "../wh-bin-api";

export function MoveBins({ company, item, fromLoc, toLoc, fromBin, toBin, onFrom, onTo }: {
  company: string;
  /** 已经对到的商品代号（还没对到 = 空） */ item: string;
  /** 这种搬动没有「从 / 到」= 空字串 */ fromLoc: string; toLoc: string;
  /** 货架条码 BIN:<id>；空 = 不从货架 / 不放货架 */ fromBin: string; toBin: string;
  onFrom: (v: string) => void; onTo: (v: string) => void;
}) {
  const [ib, setIb] = useState<ItemBins | null>(null);
  const [toAll, setToAll] = useState<BinRow[]>([]);
  useEffect(() => {
    setIb(null);
    if (!item) return;
    let alive = true;
    bins.item(company, item).then((r) => alive && setIb(r)).catch(() => alive && setIb(null));
    return () => { alive = false; };
  }, [company, item]);
  useEffect(() => {
    setToAll([]);
    if (!toLoc) return;
    let alive = true;
    bins.list(company, toLoc).then((r) => alive && setToAll(r.bins.filter((b) => b.active))).catch(() => alive && setToAll([]));
    return () => { alive = false; };
  }, [company, toLoc]);

  const at = (loc: string) => (ib && loc ? ib.locations.find((l) => l.location === loc)?.bins ?? [] : []);
  const fromOpts = item ? at(fromLoc).filter((b) => b.active && Number(b.qty) > 0) : [];
  const mine = at(toLoc).filter((b) => b.active);
  const toOpts = item ? [...mine.map((b) => ({ id: b.id, barcode: b.barcode, label: Number(b.qty) > 0 ? `${b.code} · ${qtyLabel(b.qty)}` : b.code })),
    ...toAll.filter((b) => !mine.some((m) => m.id === b.id)).map((b) => ({ id: b.id, barcode: b.barcode, label: b.code }))] : [];
  if (!fromOpts.length && !toOpts.length) return null;

  return (
    <>
      <div className="row">
        {fromOpts.length > 0 && (
          <label>{`从货架（${fromLoc}）`}
            <select value={fromBin} onChange={(e) => onFrom(e.target.value)}>
              <option value="">（不从货架）</option>
              {fromOpts.map((b) => <option key={b.id} value={b.barcode}>{`${b.code} · ${qtyLabel(b.qty)}`}</option>)}
            </select>
          </label>
        )}
        {toOpts.length > 0 && (
          <label>{`到货架（${toLoc}）`}
            <select value={toBin} onChange={(e) => onTo(e.target.value)}>
              <option value="">（不放货架）</option>
              {toOpts.map((b) => <option key={b.id} value={b.barcode}>{b.label}</option>)}
            </select>
          </label>
        )}
      </div>
      {fromOpts.length > 0 && !fromBin && <p className="small amber">这个商品有放在货架上；没选货架就不会从货架扣，货架帐会对不上。</p>}
      <p className="muted small">选了货架，货架上的数量会跟著变；这笔搬动取消时会自动还原。不选 = 只登记搬动。</p>
    </>
  );
}
