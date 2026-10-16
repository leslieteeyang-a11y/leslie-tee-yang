// 介面用语：订货 → 点货 → 扫码点货（podo/RecvScan.tsx，2026-10-16）。
type T = (s: string) => string;

export const DICT_RECVSCAN: Record<string, string> = {
  "▦ 开始扫码点货": "▦ Start scan receiving",
  "每个型号扫一次，再打一共收到几件。开始后每个型号的好货会先清空，没扫到的要自己填（没到就填 0）。":
    "Scan each model once, then type how many arrived in total. Starting clears every model's good qty; fill in any model you don't scan (0 if it didn't come).",
  "扫码，或打型号 / 品名": "Scan, or type a model / name",
  "还没点的型号，好货栏是空的": "Models not counted yet have an empty Good column",
  "只看还没点的": "Only not counted",
  "选这个 →": "Pick this →",
  "请填好货收到几件（没收到填 0）。": "Enter how many good pieces arrived (0 if none).",
  "坏货数量不是数字。": "Damaged quantity is not a number.",
  "好货一共收到几件": "Good pieces received in total",
  "坏货（没有就空着）": "Damaged (leave blank if none)",
  "加上去": "Add to it",
  "这个型号不在这张 DO 上，会记成「来错的货」。": "This model is not on this DO; it will be recorded as a wrong item.",
  "收到几件": "Quantity received",
  "请填收到几件。": "Enter the quantity received.",
  "记成来错的货": "Record as wrong item",
};

export const PATTERNS_RECVSCAN: [RegExp, (m: RegExpMatchArray, t: T) => string][] = [
  [/^已点 (\d+) \/ (\d+) 个型号$/, (m) => `Counted ${m[1]} / ${m[2]} models`],
  [/^这张 DO 没有「(.+)」。如果是来错的货，请在下面「来错的货」加一行；纸箱条码认不出来，可以到仓库「查货」把条码绑到商品。$/,
    (m) => `"${m[1]}" is not on this DO. If it is a wrong item, add a row under "Wrong items" below; if a carton barcode isn't recognised, link it to the item in Warehouse → Lookup.`],
  [/^(\S+)：好货 ([\d.,]+)、坏货 ([\d.,]+)$/, (m) => `${m[1]}: good ${m[2]}, damaged ${m[3]}`],
  [/^(\S+)：好货 ([\d.,]+)$/, (m) => `${m[1]}: good ${m[2]}`],
  [/^(\S+) 记进「来错的货」：([\d.,]+) 件$/, (m) => `${m[1]} recorded as a wrong item: ${m[2]} pcs`],
  [/^之前填了好货 ([\d.,]+) 件$/, (m) => `Already entered: ${m[1]} good`],
  [/^全到（([\d.,]+)）$/, (m) => `All arrived (${m[1]})`],
];
