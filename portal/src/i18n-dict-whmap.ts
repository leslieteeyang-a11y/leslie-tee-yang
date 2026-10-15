// 介面用语：仓库地图（wh/Map.tsx、wh/MapCanvas.tsx，2026-10-15）。键 = 画面上整段中文（去头尾空白）。
type T = (s: string) => string;
const pl = (n: string, one: string, many: string) => (n === "1" ? one : many);

export const DICT_WHMAP: Record<string, string> = {
  "地图": "Map",
  "请先在「货架」建货架。": "Set up shelves in the \"Shelves\" tab first.",
  "去建货架": "Set up shelves",
  "商品代号或品名，按 Enter": "Item code or name",
  "找商品": "Find item",
  "扫商品条码": "Scan item barcode",
  "缩小": "Zoom out", "放大": "Zoom in", "置中": "Fit",
  "编辑排版": "Edit layout",
  "已储存": "Saved",
  "最近：": "Recent:",
  "别的仓位也有：": "Also in other locations:",
  "这个商品没有放在货架上": "This item isn't on any shelf",
  "找不到这个商品": "Item not found",
  "（不分层）": "(no levels)",
  "（空）": "(empty)",
  "按住拖动地图 · 滚轮缩放 · 点货架看商品": "Drag to pan · scroll to zoom · click a shelf to see items",
  "单指拖动 · 双指缩放 · 点货架看商品": "Drag to pan · pinch to zoom · tap a shelf",
  "拖方块改位置 · 拖右下角改大小 · 放开就存": "Drag a block to move · drag its corner to resize · saves when you let go",
  // 资料库错误讯息（ops_wh_map_*）
  "地图资料不对。": "The map data is invalid.",
};

// 一段「A区 R1 → 第 2 层 3 件」
function binEn(seg: string): string {
  const m = seg.match(/^(?:(\S+)区 )?(\S+)(?: → 第 (\S+) 层)? ([\d.,]+) 件$/);
  if (!m) return seg;
  return `${m[1] ? `Zone ${m[1]} ` : ""}${m[2]}${m[3] ? ` → level ${m[3]}` : ""}: ${m[4]} pcs`;
}

export const PATTERNS_WHMAP: [RegExp, (m: RegExpMatchArray, t: T) => string][] = [
  [/^(\d+) 个货架$/, (m) => `${m[1]} ${pl(m[1], "shelf", "shelves")}`],
  [/^货架 (\S+)$/, (m) => `Shelf ${m[1]}`],
  [/^(\d+) 层$/, (m) => `${m[1]} ${pl(m[1], "level", "levels")}`],
  [/^第 (\S+) 层$/, (m) => `Level ${m[1]}`],
  [/^(\d+) 种$/, (m) => `${m[1]} ${pl(m[1], "SKU", "SKUs")}`],
  [/^(.+) — (\S{1,12})区$/, (m) => `${m[1]} — Zone ${m[2]}`],
  [/^(\S{1,12})区$/, (m) => `Zone ${m[1]}`],
  [/^找到 (\d+) 个商品，请选一个：$/, (m) => `Found ${m[1]} items, pick one:`],
  [/^📍 找到 (.+?)：(.+)$/, (m) => `📍 Found ${m[1]}: ${m[2].split("；").map(binEn).join("; ")}`],
  [/^(.+) 不在 (.+) 的货架上，在别的仓位：$/, (m) => `${m[1]} isn't on the ${m[2]} shelves; it's in:`],
  [/^(.+)（([\d.,]+) 件）$/, (m) => `${m[1]} (${m[2]} pcs)`],
  [/^(.+) 还没有货架。$/, (m) => `${m[1]} has no shelves yet.`],
];
