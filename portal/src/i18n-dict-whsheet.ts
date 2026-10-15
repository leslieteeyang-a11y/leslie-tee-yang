// 介面用语：仓库 · 盘点单 + 按货架盘 + 盘点统计（2026-10-15，含 migration 20261017c 的资料库错误讯息）。
// 键 = 画面上整段中文（去头尾空白）；带数字 / 名称的句子在 PATTERNS_WHSHEET。
type T = (s: string) => string;

export const DICT_WHSHEET: Record<string, string> = {
  // 分页
  "每日盘点": "Daily count",
  "盘点单": "Count sheets",
  "盘点统计": "Count stats",
  "← 盘点单": "← Count sheets",
  // 范围 / 状态
  "选几个货架": "Selected shelves",
  "指定商品": "Selected items",
  "贴商品代号": "Paste item codes",
  "已结单": "Closed",
  "已结束": "Finished",
  "未盘": "Not counted",
  "差异": "Variance",
  "指派给我": "Assigned to me",
  // 按货架盘
  "每个货架都要填（没有就填 0）。": "Fill in every shelf (0 if none).",
  "第一次数的跟系统不一样，请再仔细数一次（包括别的货架、坏货、展示品有没有放错）。":
    "The first count didn't match the system — please count again carefully (check other shelves, defects and display stock).",
  "每个货架都要数，没有就填 0。系统数量故意不给看（盲盘）。":
    "Count every shelf, 0 if none. The system quantity is hidden on purpose (blind count).",
  "新加": "Added",
  "其他地方 / 地上": "Elsewhere / on the floor",
  "＋ 加一个货架": "＋ Add a shelf",
  "＋ 分货架数": "＋ Count by shelf",
  "扫货架条码，或打货架代号": "Scan the shelf barcode, or type the shelf code",
  "扫货架条码": "Scan shelf barcode",
  "加了货架之后，上面那格就是「其他地方 / 地上」。": "Once a shelf is added, the box above becomes \"Elsewhere / on the floor\".",
  // 每日盘点
  "指派给你的盘点单": "Count sheets assigned to you",
  // 清单
  "只看指派给我的": "Only mine",
  "＋ 建盘点单": "＋ New count sheet",
  "没有进行中的盘点单。按「＋ 建盘点单」指定要盘的仓位、货架或商品，再指派给同事。":
    "No open count sheets. Tap \"＋ New count sheet\" to pick a location, shelves or items and assign colleagues.",
  "没有进行中的盘点单。": "No open count sheets.",
  "AutoCount 挡不了出货：盘的时候请门市暂停这个仓位出货，或下班后盘。":
    "AutoCount can't block sales: ask the shop to pause issuing from this location while counting, or count after hours.",
  // 建单
  "建盘点单": "New count sheet",
  "名称": "Name",
  "要盘什么": "What to count",
  "AutoCount 在这个仓位有库存的（含负数）、货架上记了的、还没输入 AutoCount 要进这个仓位的商品，全部列进来。":
    "Lists every item with AutoCount stock at this location (including negative), every item recorded on its shelves, and incoming items not yet keyed into AutoCount.",
  "这个仓位还没有货架。请先在「货架」建货架，或改用「整个仓位」。":
    "This location has no shelves yet. Create shelves under \"Shelves\" first, or use \"Whole location\".",
  "（没分区）": "(no zone)",
  "全选": "Select all",
  "全不选": "Select none",
  "指派给（仓库「可编辑」以上的同事）": "Assign to (colleagues with warehouse Edit or above)",
  "这间分店没有可以指派的人。": "No one in this branch can be assigned.",
  "期限（选填）": "Due date (optional)",
  "例：下班后盘、先盘 A 区": "e.g. count after hours, zone A first",
  "建立盘点单": "Create count sheet",
  // 明细
  "确定结单？": "Close this count sheet?",
  "改指派 / 期限": "Assignees / due date",
  "结单": "Close sheet",
  "取消盘点单": "Cancel count sheet",
  "找商品代号、品名或货架": "Find item code, name or shelf",
  "都盘完了。": "All counted.",
  "没有符合的商品。": "No matching items.",
  "重盘 →": "Recount →",
  "主管看得到「实盘 / 应有 · 差」；盘点的人看不到系统数量（盲盘）。差异在「差异审核」处理。":
    "Managers see \"counted / expected · diff\"; counters don't see system quantities (blind count). Variances are handled in \"Variances\".",
  "改盘点单": "Edit count sheet",
  "指派给": "Assign to",
  "已经盘的照样有效，差异照样在「差异审核」。": "Counts already done stay valid; their variances stay in \"Variances\".",
  "原因": "Reason",
  "例：改天整个仓位一起盘": "e.g. will count the whole location another day",
  "不取消": "Keep",
  // 统计
  "近 30 天": "Last 30 days",
  "近 90 天": "Last 90 days",
  "近 180 天": "Last 180 days",
  "全部仓位": "All locations",
  "盘了几次": "Counts",
  "相符率": "Match rate",
  "差异几项": "Variances",
  "差异金额（成本，净额）": "Variance value (cost, net)",
  "这段时间没有盘点纪录。": "No counts in this period.",
  "常常不准的商品（前 20）": "Items often wrong (top 20)",
  "这段时间没有差异。": "No variances in this period.",
  "差异次数": "Times",
  "差异件数合计": "Units off (net)",
  "差异金额": "Variance value",
  "最近": "Last",
  "每个人": "By person",
  "盘点人": "Counter",
  "盘了几项": "Counted",
  "差异率": "Variance rate",
  "每月差异金额（近 12 个月）": "Variance value by month (last 12 months)",
  "净额": "Net",
  "多的少的加起来": "Over + short",
  "差额 = 实盘 − 应有（应有 = AutoCount 库存 + 还没输入 AutoCount 的搬动）；金额用盘点当下的单位成本算，负数 = 少了。要再数、主管按「请重盘」的那次不算。":
    "Diff = counted − expected (expected = AutoCount stock + moves not yet keyed in); value uses the unit cost at the time of the count, negative = short. First counts that needed a recount, and counts a manager sent back for recount, are left out.",
  // 资料库错误讯息
  "「其他地方 / 地上」的数量不能小于 0。": "\"Elsewhere / on the floor\" can't be less than 0.",
  "找不到这张盘点单。": "Count sheet not found.",
  "这张盘点单已经结束了，请回到盘点单清单。": "This count sheet has finished — go back to the count sheet list.",
  "请至少指派一个人。": "Assign at least one person.",
  "请填盘点单名称（80 个字以内）。": "Enter a name for the count sheet (up to 80 characters).",
  "期限不能早于今天。": "The due date can't be before today.",
  "备注太长（500 个字以内）。": "The note is too long (up to 500 characters).",
  "请选要盘的货架。": "Choose the shelves to count.",
  "选的货架上还没有记任何商品，请改用「整个仓位」或「贴商品代号」。":
    "No items are recorded on the chosen shelves yet — use \"Whole location\" or \"Paste item codes\" instead.",
  "请贴上要盘的商品代号。": "Paste the item codes to count.",
  "这张盘点单已经结束了，不能再改。": "This count sheet has finished and can't be changed.",
  "这张盘点单已经结束了。": "This count sheet has already finished.",
  "请写取消的原因。": "Please give a reason for cancelling.",
};

const LINE_ST: Record<string, string> = {
  未盘: "Not counted", 要再数: "Recount", 相符: "Match", 差异: "Variance", "差异 · 已调整": "Variance · adjusted", "差异 · 不调整": "Variance · not adjusted",
};

export const PATTERNS_WHSHEET: [RegExp, (m: RegExpMatchArray, t: T) => string][] = [
  [/^盘点单：(.+)$/, (m) => `Count sheet: ${m[1]}`],
  [/^各货架：(.+)$/, (m) => `By shelf: ${m[1].replace(/其他地方/g, "elsewhere").replace(/、/g, ", ")}`],
  [/^货架 (\S+) 数到几$/, (m) => `Shelf ${m[1]}: quantity counted`],
  [/^合计 (-?[\d.]+)( .+)?$/, (m) => `Total ${m[1]}${m[2] || ""}`],
  [/^(.+) 没有货架「(.+)」。$/, (m) => `${m[1]} has no shelf "${m[2]}".`],
  [/^货架 (\S+) 已经在上面了。$/, (m) => `Shelf ${m[1]} is already listed.`],
  [/^还有 (\d+) 项 →$/, (m) => `${m[1]} left →`],
  [/^选几个货架：(.+)$/, (m) => `Selected shelves: ${m[1].replace(/…（共 (\d+) 个）$/, "… ($1 in all)").replace(/、/g, ", ")}`],
  [/^已盘 (\d+) \/ (\d+)$/, (m) => `Counted ${m[1]} / ${m[2]}`],
  [/^要再数 (\d+)$/, (m) => `Recount ${m[1]}`],
  [/^差异 (\d+)$/, (m) => `Variance ${m[1]}`],
  [/^盘点人：(.+)$/, (m) => `Counted by: ${m[1].replace(/、/g, ", ")}`],
  [/^(\S+) 盘点 (\d\d-\d\d)$/, (m) => `${m[1]} count ${m[2]}`],
  [/^会列出选的货架上记过的商品。已选 (\d+) 个货架。$/, (m) => `Lists the items recorded on the chosen shelves. ${m[1]} shelf(s) selected.`],
  [/^(\S+) 区$/, (m) => `Zone ${m[1]}`],
  [/^(\d+) 种$/, (m) => `${m[1]} SKU${m[1] === "1" ? "" : "s"}`],
  [/^商品代号（一行一个，或从 Excel 整栏贴上）( · (\d+) 个)?$/, (m) => `Item codes (one per line, or paste a whole Excel column)${m[2] ? ` · ${m[2]}` : ""}`],
  [/^(\S+) 已经盘过（(.+)）。要重盘请主管在「差异审核」按「请重盘」。$/, (m) =>
    `${m[1]} was already counted (${LINE_ST[m[2]] || m[2]}). To recount, a manager taps "Recount" in Variances.`],
  [/^还有 (\d+) 项没盘完，结单后就算没盘。确定结单？$/, (m) => `${m[1]} item(s) not counted yet — they stay uncounted after closing. Close this count sheet?`],
  [/^(?:(.*) )?建于 (.+)$/, (m) => `${m[1] ? `${m[1]}, ` : ""}created ${m[2]}`],
  [/^(?:(.*) )?(结单|取消)于 (.+)$/, (m) => `${m[1] ? `${m[1]}, ` : ""}${m[2] === "结单" ? "closed" : "cancelled"} ${m[3]}`],
  [/^取消原因：(.+)$/, (m) => `Cancelled because: ${m[1]}`],
  [/^(.+)（帮忙）· (\d+)$/, (m) => `${m[1]} (helping) · ${m[2]}`],
  [/^未盘（(\d+)）$/, (m) => `Not counted (${m[1]})`],
  [/^已盘（(\d+)）$/, (m) => `Counted (${m[1]})`],
  [/^差异（(\d+)）$/, (m) => `Variance (${m[1]})`],
  [/^差 ([+-]?[\d.]+)$/, (m) => `diff ${m[1]}`],
  [/^(\d+) 个商品 × 仓位$/, (m) => `${m[1]} item × location pairs`],
  [/^相符 (\d+) 次$/, (m) => `${m[1]} matched`],
  [/^待审核 (\d+) · 已调整 (\d+) · 不调整 (\d+)$/, (m) => `to review ${m[1]} · adjusted ${m[2]} · not adjusted ${m[3]}`],
  [/^多的少的加起来 (.+)$/, (m) => `over + short ${m[1]}`],
  // 资料库错误讯息
  [/^货架 (\S+) 已经停用，请把数量填在「其他地方 \/ 地上」。$/, (m) => `Shelf ${m[1]} is inactive — put the quantity under "Elsewhere / on the floor".`],
  [/^货架 (\S+) 填了两次。$/, (m) => `Shelf ${m[1]} is listed twice.`],
  [/^请填货架 (\S+) 数到几（没有就填 0）。$/, (m) => `Enter the quantity counted on shelf ${m[1]} (0 if none).`],
  [/^货架 (.+) 上也记了这个商品，请关掉再打开一次，把这些货架也数进去。$/, (m) =>
    `Shelf ${m[1].replace(/、/g, ", ")} also has this item on record — close and reopen this item so those shelves are counted too.`],
  [/^这张盘点单是盘 (.+) 的，不是 (.+)。$/, (m) => `This count sheet is for ${m[1]}, not ${m[2]}.`],
  [/^(\S+) 不在这张盘点单上。$/, (m) => `${m[1]} is not on this count sheet.`],
  [/^(.+) 没有这间分店仓库「可编辑」的权限（或已离职），不能指派。$/, (m) =>
    `${m[1].replace(/、/g, ", ")} can't be assigned: no warehouse Edit access for this branch (or no longer employed).`],
  [/^未知的盘点范围：(.+)$/, (m) => `Unknown count scope: ${m[1]}`],
  [/^(.+) 没有要盘的商品（AutoCount 没有库存，货架上也没有）。$/, (m) => `${m[1]} has nothing to count (no AutoCount stock, nothing on its shelves).`],
  [/^选的货架不在 (.+) 或已经停用，请重新选。$/, (m) => `Some chosen shelves are not in ${m[1]} or are inactive — choose again.`],
  [/^找不到这些商品代号：(.+)。请改正后再建。$/, (m) => `These item codes weren't found: ${m[1].replace(/、/g, ", ")}. Fix them and try again.`],
  [/^一张盘点单最多 5,000 个商品（这次 (\d+) 个），请分成几张。$/, (m) => `A count sheet holds at most 5,000 items (this one has ${m[1]}) — split it into several.`],
  [/^找不到货架「(.+)」。$/, (m) => `Shelf "${m[1]}" not found.`],
  [/^货架 (\S+) 在 (.+)，不是 (.+)。$/, (m) => `Shelf ${m[1]} is in ${m[2]}, not ${m[3]}.`],
];
