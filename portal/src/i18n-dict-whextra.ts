// 介面用语：登入纪录、查货补充（各分店、AutoCount 最近卖出 / 进货）、多行搬动、搬动筛选 / 导出（2026-10-15）。
// 键 = 画面上整段中文（去头尾空白）；带数字 / 名称的句子在 PATTERNS_WHEXTRA。资料库错误讯息也在这里。
type T = (s: string) => string;

export const DICT_WHEXTRA: Record<string, string> = {
  // 登入纪录（员工与权限）
  "登入纪录": "Login log", "打开系统": "Opened app",
  "每次按登入记一笔；之后每次打开系统也记一笔（同一人 10 分钟内只算一次）。纪录从这个功能上线才开始。只有管理员看得到。":
    "Every login is recorded; every time the app is opened afterwards is recorded too (once per person per 10 minutes). Records start from when this feature went live. Only admins can see this.",
  "找员工姓名…": "Find staff name…", "显示已停用 / 已离职": "Show deactivated / left", "没有符合的员工。": "No matching staff.",
  "员工": "Staff", "最后登入": "Last login", "最后打开系统": "Last opened", "今天": "Today", "近 30 天": "Last 30 days", "总共": "Total",
  "从没用过": "Never used", "还没有纪录。": "No records yet.", "最近 100 笔（马来西亚时间）": "Latest 100 (Malaysia time)",
  "时间": "Time", "种类": "Type", "装置": "Device", "手机": "Phone", "电脑": "Computer", "平板": "Tablet", "微信": "WeChat",
  "已离职": "Left", "关闭": "Close",
  // 查货补充
  "各分店合计 · AutoCount 最近卖出 / 进货": "By branch · AutoCount recent sales / receipts",
  "各分店（AutoCount 库存）": "By branch (AutoCount stock)", "AutoCount 没有这个商品的库存纪录。": "AutoCount has no stock record for this item.",
  "分店": "Branch", "自己的": "Own stock", "寄存在总部": "Held at HQ", "还欠": "Still owed", "总部": "HQ",
  "寄存在总部 = 分店的货已经到总部、还没送去（分店仓位 + PRE 仓位）；还欠 = 分店订了、还没到总部（PRE 仓位的负数）。":
    "Held at HQ = the branch's goods have arrived at HQ but not been sent yet (branch location + PRE location); still owed = ordered for the branch but not yet at HQ (negative PRE location).",
  "没有销售纪录。": "No sales records.", "没有进货纪录。": "No receipt records.",
  "发票": "Invoice", "现金单": "Cash sale", "退货单": "Credit note", "借项单": "Debit note",
  "AutoCount 每天同步的数字；只列数量，不列金额。": "AutoCount figures synced daily; quantities only, no amounts.",
  // 多行搬动
  "一次登记多个商品": "Record many items at once", "一次登记多个商品 →": "Record many items at once →", "＋ 多个商品": "+ Many items",
  "原因（必填，每个商品共用）": "Reason (required, shared by all items)", "备注（选填，每个商品共用）": "Note (optional, shared by all items)",
  "扫商品条码或打代号 / 品名，一个一个加": "Scan a barcode or type a code / name to add items one by one",
  "加": "Add", "从 Excel 贴上": "Paste from Excel", "读取": "Read", "取消": "Cancel", "拿掉": "Remove",
  "在 Excel 选两栏（商品代号、数量）复制，贴在这里。例：\nHM-UB001\t5\nST003\t2":
    "In Excel select two columns (item code, qty), copy and paste here. e.g.\nHM-UB001\t5\nST003\t2",
  "没有读到资料：请从 Excel 复制两栏（商品代号、数量）再贴上。": "Nothing read: copy two columns (item code, qty) from Excel and paste again.",
  "找不到这个商品": "Item not found", "（不从货架）": "(not from a bin)", "（不放货架）": "(not into a bin)",
  "从货架": "From bin", "到货架": "To bin", "数量": "Qty", "#": "#",
  "选了货架，货架上的数量会跟著变；这笔搬动取消时会自动还原。不选 = 只登记搬动。":
    "If you pick a bin, its quantity changes too; cancelling the move restores it. No bin = record the move only.",
  "找不到这个商品，请拿掉或另外扫正确的商品。": "Item not found. Remove it, or scan the correct item.",
  "每个商品各记一笔搬动，出现在「待输入 AutoCount」清单；有一行不对就整批都不存。":
    "Each item becomes one move in the \"To key into AutoCount\" list; if any row is wrong, nothing is saved.",
  "请至少加一个商品。": "Add at least one item.", "请选「到哪个仓位」。": "Pick the \"to\" location.", "一次最多 200 个商品，请分开登记。": "At most 200 items at a time; please split them up.",
  // 搬动筛选 / 导出
  "全部种类": "All types", "全部登记人": "Everyone", "登记人": "Recorded by", "商品代号 / 品名 / 单号": "Item code / name / doc no.",
  "清除筛选": "Clear filters", "准备中…": "Preparing…", "下载 Excel": "Download Excel", "搬动纪录": "Moves",
  "没有符合筛选的搬动。": "No moves match the filters.",
  "只列出最近 300 笔；要看更早的，请选日期区间（最多 2,000 笔）。": "Showing the latest 300 only; pick a date range to see older ones (up to 2,000).",
  "超过 2,000 笔，只列出最近 2,000 笔；请把日期区间缩小。": "More than 2,000 — showing the latest 2,000; please narrow the date range.",
  "调仓": "Transfer", "报坏": "Damaged", "展示": "Display", "样品": "Sample", "退货": "Return", "其他": "Other",
  "已取消": "Cancelled",
  // 资料库错误讯息
  "员工编号不对。": "Invalid staff ID.", "找不到这位员工。": "Staff member not found.",
  "资料格式不对，请重新整理网页再试。": "The data format is wrong; reload the page and try again.",
  "数量要是大于 0 的数字（最多两位小数）。": "Quantity must be a number above 0 (at most 2 decimals).",
  "这种搬动没有「从哪个仓位」，不能选从哪个货架拿。": "This kind of move has no \"from\" location, so you can't pick a bin to take from.",
  "这种搬动没有「到哪个仓位」，不能选放到哪个货架。": "This kind of move has no \"to\" location, so you can't pick a bin to put into.",
  "登记人不对，请重新选。": "Invalid \"recorded by\"; please pick again.", "开始日期不能晚于结束日期。": "The start date can't be after the end date.",
};

export const PATTERNS_WHEXTRA: [RegExp, (m: RegExpMatchArray, t: T) => string][] = [
  // 登入纪录
  [/^今天 (\d+) 人用过 · 近 30 天 (\d+) 人 · 从没用过 (\d+) 人（在职 (\d+) 人）$/,
    (m) => `${m[1]} used it today · ${m[2]} in the last 30 days · ${m[3]} never used (${m[4]} active staff)`],
  [/^打开 今天 (\d\d:\d\d)$/, (m) => `opened today ${m[1]}`],
  [/^打开 昨天 (\d\d:\d\d)$/, (m) => `opened yesterday ${m[1]}`],
  [/^打开 (.+)$/, (m) => `opened ${m[1]}`],
  [/^登入纪录：(.+)$/, (m) => `Login log: ${m[1]}`],
  [/^共 (\d+) 笔（马来西亚时间）$/, (m) => `${m[1]} records (Malaysia time)`],
  [/^未知的登入纪录种类：(.*)$/, (m) => `Unknown login record type: ${m[1]}`],
  // 查货补充
  [/^AutoCount 最近卖出（(\d+)）$/, (m) => `AutoCount recent sales (${m[1]})`],
  [/^AutoCount 最近进货（(\d+)）$/, (m) => `AutoCount recent receipts (${m[1]})`],
  // 多行搬动
  [/^商品（(\d+)）$/, (m) => `Items (${m[1]})`],
  [/^已加 (.+)$/, (m) => `Added ${m[1]}`],
  [/^读到 (\d+) 行；(\d+) 个商品代号找不到（红色），请拿掉或另外扫正确的商品。$/,
    (m) => `Read ${m[1]} rows; ${m[2]} item codes not found (red) — remove them or scan the correct items.`],
  [/^读到 (\d+) 行，都对到商品了。$/, (m) => `Read ${m[1]} rows; all matched to items.`],
  [/^从货架（(.+)）$/, (m) => `From bin (${m[1]})`],
  [/^到货架（(.+)）$/, (m) => `To bin (${m[1]})`],
  [/^第 (\d+) 行（(.*)）$/, (m) => `Row ${m[1]}${m[2] ? ` (${m[2]})` : ""}`],
  [/^登记 (\d+) 个商品$/, (m) => `Record ${m[1]} item${m[1] === "1" ? "" : "s"}`],
  [/^已登记 (\d+) 笔搬动，等负责人输入 AutoCount。$/, (m) => `Recorded ${m[1]} move${m[1] === "1" ? "" : "s"}; waiting for AutoCount entry.`],
  // 资料库（货架帐、日期）
  [/^日期「(.*)」不对，格式要是 YYYY-MM-DD。$/, (m) => `Date "${m[1]}" is invalid; use YYYY-MM-DD.`],
  [/^货架 (\S+) 上的 (\S+) 只有 (\S+) 件，不够拿 (\S+) 件。如果实际有货，请先盘点或请主管改数。$/,
    (m) => `Bin ${m[1]} only has ${m[3]} of ${m[2]}, not enough to take ${m[4]}. If the stock is really there, count it first or ask a manager to correct the number.`],
  [/^找不到货架「(.*)」。$/, (m) => `Bin "${m[1]}" not found.`],
  [/^货架 (\S+) 在 (.+)，不是 (.+)。$/, (m) => `Bin ${m[1]} is in ${m[2]}, not ${m[3]}.`],
  [/^货架 (\S+) 已经停用。$/, (m) => `Bin ${m[1]} is deactivated.`],
  [/^有好几个仓位都有货架 (\S+)，请先选仓位或扫货架条码。$/, (m) => `Several locations have bin ${m[1]}; pick the location first or scan the bin barcode.`],
];
