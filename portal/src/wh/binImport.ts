// Excel / CSV 带入货架数量：认两种表（在浏览器读，不上传档案）。
//   ① 员工 WMS 的「库存导出」宽表：第一栏 SKU，之后每个货架一栏，栏名「A仓 / A区 / R1 / 第1层」，格子 = 那个货架的数量。
//      仓名让使用者对到 AutoCount 仓位；区去掉结尾「区」、「第1层」→ 1；0 或空白的格子略过（不然每个商品 × 每个货架都会多一笔 0）。
//   ② 长表：商品代号 | 区 | 货架 | 层 | 数量，或 商品代号 | 货架代号 | 数量（一行一个商品 × 货架；数量 0 = 改成 0）。
import type { Cell } from "../podo/parse";

export interface ImpRow {
  /** Excel 第几行 */ line: number;
  item: string;
  /** WMS 的「仓」名（宽表才有） */ wh?: string;
  zone: string; shelf: string; level: string;
  /** 长表直接给货架代号（例 A-R1-2） */ bin?: string;
  qty: number;
  /** 读表时就知道有错（数量不是数字、没有货架） */ err?: string;
}
export interface Parsed {
  kind: "wms" | "long";
  rows: ImpRow[];
  /** WMS 的仓名（照出现顺序） */ warehouses: string[];
  /** 略过的格子（0 / 空白） */ skipped: number;
}

const text = (c: Cell | undefined): string => (c == null ? "" : String(c).trim());

/** 区 / 货架 / 层：去掉「区」「第…层」，拿掉空格、斜线、减号、冒号（货架代号用 - 连接），英文转大写 */
export function normPart(s: string, kind: "zone" | "shelf" | "level"): string {
  let v = s.normalize("NFKC").trim();
  if (kind === "zone") v = v.replace(/\s*区$/, "");
  if (kind === "level") { const m = /^第?\s*(.+?)\s*层$/.exec(v); if (m) v = m[1]; }
  return v.replace(/[\s\-/:]+/g, "").toUpperCase();
}

/** 数字：接受 1,234、全形数字；不是数字回传 NaN；空白回传 null */
function num(c: Cell | undefined): number | null {
  if (c == null) return null;
  if (typeof c === "number") return c;
  const s = c.normalize("NFKC").replace(/,/g, "").trim();
  if (!s) return null;
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : NaN;
}

const RE_ITEM = /^(sku|商品代号|商品编号|商品编码|商品|产品编号|产品代号|代号|item\s*code|itemcode|item\s*no\.?|item)$/i;
const RE_ZONE = /^(区|zone)$/i;
const RE_SHELF = /^(货架|shelf|rack)$/i;
const RE_LEVEL = /^(层|level|tier)$/i;
const RE_BIN = /^(货架代号|货架位置|bin|bin\s*code|location\s*code)$/i;
const RE_QTY = /^(数量|qty|quantity|库存|数目)$/i;

/** WMS 位置栏名「A仓 / A区 / R1 / 第1层」→ [仓, 区, 货架, 层]；不是就 null */
export function wmsColumn(h: string): [string, string, string, string] | null {
  if (!h.includes("/")) return null;
  const p = h.split("/").map((x) => x.trim());
  if ((p.length !== 4 && p.length !== 3) || p.some((x) => !x)) return null;
  return [p[0], p[1], p[2], p[3] ?? ""];
}

/** 找表头（前 15 行里有「SKU / 商品代号」那一行）→ 读成一行一个商品 × 货架 */
export function parseBinSheet(rows: Cell[][]): Parsed | string {
  for (let h = 0; h < Math.min(rows.length, 15); h++) {
    const head = rows[h].map(text);
    const itemCol = head.findIndex((x) => RE_ITEM.test(x));
    if (itemCol < 0) continue;
    const wmsCols = head.map((x, i) => [i, wmsColumn(x)] as const).filter((x) => x[1] != null) as [number, [string, string, string, string]][];
    const out: ImpRow[] = [];
    let skipped = 0;
    if (wmsCols.length > 0) {
      const warehouses = [...new Set(wmsCols.map(([, p]) => p[0]))];
      for (let r = h + 1; r < rows.length; r++) {
        const item = text(rows[r][itemCol]);
        if (!item) continue;
        for (const [c, p] of wmsCols) {
          const q = num(rows[r][c]);
          if (q == null || q === 0 || Number.isNaN(q)) { skipped++; continue; }
          out.push({ line: r + 1, item, wh: p[0], zone: normPart(p[1], "zone"), shelf: normPart(p[2], "shelf"), level: normPart(p[3], "level"),
                     qty: q, err: q < 0 ? "数量不对" : undefined });
        }
      }
      return { kind: "wms", rows: out, warehouses, skipped };
    }
    const col = (re: RegExp) => head.findIndex((x) => re.test(x));
    const zc = col(RE_ZONE), sc = col(RE_SHELF), lc = col(RE_LEVEL), bc = col(RE_BIN), qc = col(RE_QTY);
    if (qc < 0 || (sc < 0 && bc < 0)) {
      return "认不出这个表：要有「商品代号」「数量」，加上「区 / 货架 / 层」或「货架代号」这几栏；或是员工 WMS 的「库存导出」。可以先下载范本照着填。";
    }
    for (let r = h + 1; r < rows.length; r++) {
      const item = text(rows[r][itemCol]);
      if (!item) continue;
      const q = num(rows[r][qc]);
      if (q == null) { skipped++; continue; }
      const shelf = sc >= 0 ? normPart(text(rows[r][sc]), "shelf") : "";
      const bin = bc >= 0 ? text(rows[r][bc]).toUpperCase() : "";
      out.push({
        line: r + 1, item, qty: q,
        zone: zc >= 0 ? normPart(text(rows[r][zc]), "zone") : "", shelf, level: lc >= 0 ? normPart(text(rows[r][lc]), "level") : "",
        bin: shelf ? undefined : bin || undefined,
        err: Number.isNaN(q) || q < 0 ? "数量不对" : !shelf && !bin ? "没有货架" : undefined,
      });
    }
    return { kind: "long", rows: out, warehouses: [], skipped };
  }
  return "找不到表头：第一列（或前几列）要有「SKU」或「商品代号」。可以先下载范本照着填。";
}

/** 这一行的货架代号（跟资料库 ops.wh_bin_code 一样） */
export function rowBin(r: ImpRow): string {
  return r.bin ?? [r.zone, r.shelf, r.level].filter(Boolean).join("-");
}

/** 下载长表范本 */
export async function downloadTemplate(): Promise<void> {
  const XLSX = await import("@e965/xlsx");
  const ws = XLSX.utils.aoa_to_sheet([
    ["商品代号", "区", "货架", "层", "数量"],
    ["HM-UB001", "A", "R1", "1", 12],
    ["HM-UB001", "A", "R2", "", 5],
    ["ST-0002", "B", "R1", "3", 40],
  ]);
  ws["!cols"] = [18, 8, 10, 8, 10].map((wch) => ({ wch }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "货架数量");
  const out = XLSX.write(wb, { bookType: "xlsx", type: "array", compression: true }) as ArrayBuffer;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([out], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
  a.download = "货架数量范本.xlsx";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
