// 介面用语：仓库的商品标签、商品照片、入库箱贴（批次）、打印纪录、库存总表下载（2026-10-15）。键 = 画面上整段中文（去头尾空白）。
type T = (s: string) => string;

export const DICT_WHTAG: Record<string, string> = {
  // 标签
  "标签": "Tags", "全部标签": "All tags", "管理标签": "Manage tags", "改标签": "Edit tags", "商品标签": "Item tags",
  "拿掉这个标签": "Remove this tag", "加标签": "Add tag", "＋ 标签": "＋ Tag", "没有标签": "No tags", "建标签": "Create tag",
  "新标签名称（最多 10 个字）": "New tag name (max 10 characters)", "颜色": "Colour", "手动": "Manual",
  "自动（近 90 天销量前 5%、≥ 10 件）": "Automatic (top 5% by 90-day sales, ≥ 10 pcs)",
  "自动（最后进货满 6 个月还有货）": "Automatic (last received 6+ months ago, still in stock)",
  "「畅销」「滞销」是系统每天照销量 / 最后进货日自动标的（只能改颜色或停用）；其他是手动标的。停用的标签不显示，也不能再标。":
    "\"Best seller\" and \"Slow mover\" are tagged automatically from sales / last receiving date (you can only change their colour or turn them off); the others are tagged by hand. Inactive tags are hidden and can't be used.",
  "畅销": "Best seller", "滞销": "Slow mover",
  "红": "Red", "橙": "Orange", "绿": "Green", "蓝": "Blue", "紫": "Purple", "灰": "Grey",
  "标签：「畅销」= 近 90 天销量在这间分店前 5% 而且至少 10 件；「滞销」= 最后进货满 6 个月还有库存（与「滞销品」同一条规则），都是系统自动标的。其他标签由采购或仓库主管手动标。":
    "Tags: \"Best seller\" = top 5% of this branch by 90-day sales and at least 10 pcs; \"Slow mover\" = last received 6+ months ago and still in stock (same rule as Slow movers). Both are automatic; other tags are set by purchasing or the warehouse supervisor.",
  // 库存总表下载
  "⬇ 下载 Excel": "⬇ Download Excel", "准备中…": "Preparing…", "商品代号": "Item code",
  // 照片
  "确定拿掉这张照片？": "Remove this photo?", "看大图": "View larger", "📷 换照片": "📷 Replace photo",
  "拿掉照片": "Remove photo",
  "读不到这张照片，请换一张（JPG / PNG）。": "Can't read this photo — please use another one (JPG / PNG).",
  "照片压缩失败，请再试一次。": "Couldn't shrink the photo — please try again.", "照片读不到。": "Can't load the photo.",
  // 印条码的子画面
  "商品条码": "Item barcodes", "箱贴": "Box labels", "打印纪录": "Print log", "货架标签": "Bin labels",
  // 箱贴
  "大箱 100×60mm": "Large box 100×60mm", "小箱 50×30mm": "Small box 50×30mm", "尺寸": "Size", "箱数": "Boxes",
  "搜商品 / 批次号 / 厂家 DO 号…": "Search item / lot no. / supplier DO no.…",
  "只看这张厂家到货": "Only this supplier delivery",
  "这张厂家到货没有进货（还没点货，或进货都取消了）。": "This supplier delivery has no goods in (not counted yet, or all cancelled).",
  "最近 14 天没有点货的进货。下面可以手动建批次。": "Nothing received in the last 14 days. You can create a lot by hand below.",
  "最近 14 天点货的进货。勾选要印的，填几箱，按「建批次并列印」。": "Goods received in the last 14 days. Tick the ones to print, fill in the number of boxes, then press \"Create lots & print\".",
  "同一笔进货再按一次 = 同一个批次号（只改箱数），不会多出批次。": "Pressing again for the same goods-in keeps the same lot number (only the box count changes) — no duplicate lots.",
  "印箱贴要仓库或订货「可编辑」。": "Printing box labels needs Warehouse or Purchasing \"Edit\".",
  "列印时在浏览器的列印设定把「边界 / Margins」设成「无 / None」、缩放 100%，纸张选标签的尺寸。箱贴上的 QR 用手机扫会开这个批次（要先登入营运系统）。":
    "When printing, set Margins to None and scale to 100% in the browser's print settings, and pick the label size as paper. Scanning the QR on a box label with a phone opens the lot (you need to be logged in to Operations).",
  "手动建批次（没有点货纪录的货，例：客户退货、旧货重新贴）": "Create a lot by hand (goods without a receiving record, e.g. customer returns, relabelling old stock)",
  "扫或打商品代号": "Scan or type the item code", "换商品": "Change item", "给哪间分店": "For which branch", "（不写）": "(none)",
  "备注（选填，只在批次页看得到）": "Note (optional, only shown on the lot page)", "🖨 建批次并列印": "🖨 Create lot & print",
  // 批次画面
  "待开进货单（GRN）": "Waiting for GRN", "已输入 AutoCount": "Entered in AutoCount", "进货已取消": "Goods-in cancelled",
  "请扫箱贴上的 QR，或在「印条码 → 打印纪录」找批次。": "Scan the QR on the box label, or find the lot under Labels → Print log.",
  "← 打印纪录": "← Print log", "← 箱贴": "← Box labels", "几箱": "Boxes", "建批次": "Lot created", "PO": "PO",
  "这个商品在这个仓位还没有放过货架。": "This item hasn't been put on a bin in this location yet.",
  "上架 →": "Put away →", "点货日期": "Received", "商品数": "Items", "还没印过。": "Not printed yet.", "预览": "Preview", "收起预览": "Hide preview",
  // 打印纪录
  "A4 24 格": "A4 24-up", "A4 21 格": "A4 21-up", "标签机 50×30mm": "Label printer 50×30mm",
  "已加入「商品条码」清单。": "Added to the item barcode list.", "去印 →": "Go print →",
  "搜商品 / 品名 / 批次号 / 货架 / 印的人…": "Search item / description / lot no. / bin / printed by…",
  "全部种类": "All types", "没有打印纪录。": "No print records.", "时间": "Time", "内容": "Content", "印的人": "Printed by",
  "补印": "Reprint", "去货架清单": "Go to bin list",   // 不要用「到货架」当键：那是上架 / 移货架画面的「目的货架」（To bin）
  "这笔进货已取消": "This goods-in was cancelled",
  // 点货完成画面
  "🏷 印箱贴": "🏷 Print box labels",
  "批次号、给哪间分店、建议货架、QR（扫了开批次页）": "Lot no., branch, suggested bin, QR (scan to open the lot page)",
  // 资料库错误讯息
  "标商品标签要订货「可编辑」或仓库「可审批」，请找管理员开通。": "Tagging items needs Purchasing \"Edit\" or Warehouse \"Approve\" — ask an admin to grant it.",
  "请填标签名称。": "Enter a tag name.", "标签名称最多 10 个字。": "Tag names can be at most 10 characters.",
  "颜色不对，请重新选。": "Invalid colour — please pick again.", "标签最多 50 个，请先停用用不到的。": "At most 50 tags — turn off the ones you don't use first.",
  "没有这个标签。": "No such tag.", "请选商品。": "Pick an item.", "一次最多 500 个商品。": "At most 500 items at a time.",
  "一次最多 2,000 个商品。": "At most 2,000 items at a time.",
  "照片还没上传成功，请再拍一次。": "The photo hasn't finished uploading — please take it again.",
  "印箱贴要仓库或订货「可编辑」，请找管理员开通。": "Printing box labels needs Warehouse or Purchasing \"Edit\" — ask an admin to grant it.",
  "请先勾选要印箱贴的进货。": "Tick the goods-in to print box labels for first.", "一次最多 200 个批次。": "At most 200 lots at a time.",
  "箱数要 1 到 999。": "Boxes must be 1 to 999.", "找不到这笔进货。": "Goods-in not found.", "没有这间分店。": "No such branch.",
  "一次最多记 500 行。": "At most 500 rows at a time.", "请填商品代号。": "Enter the item code.", "找不到货架。": "Bin not found.",
  "日期格式不对，请重新选日期。": "Invalid date — please pick the date again.",
};

export const PATTERNS_WHTAG: [RegExp, (m: RegExpMatchArray, t: T) => string][] = [
  // 箱贴上的字（列印的箱贴跟著画面语言）
  [/^批次 (L\d{6}-\d+)$/, (m) => `Lot ${m[1]}`],
  [/^点货日期 (\d{4}-\d{2}-\d{2})?$/, (m) => `Received ${m[1] ?? ""}`],
  [/^第 (\d+) \/ (\d+) 箱$/, (m) => `Box ${m[1]} / ${m[2]}`],
  [/^货架 (\S+)$/, (m) => `Bin ${m[1]}`],
  // 箱贴：选进货
  [/^厂家 DO (.+)$/, (m) => `Supplier DO ${m[1]}`],
  [/^厂家到货 #(\d+)$/, (m) => `Supplier delivery #${m[1]}`],
  [/^(L\d{6}-\d+) · 已印 (\d+) 张$/, (m) => `${m[1]} · ${m[2]} printed`],
  [/^🖨 建批次并列印（(\d+) 个商品、(\d+) 张）$/, (m) => `🖨 Create lots & print (${m[1]} items, ${m[2]} labels)`],
  [/^已建 (\d+) 个批次：$/, (m) => `${m[1]} lot(s) created:`],
  [/^这张厂家到货是「(.+)」的。$/, (m, t) => `This supplier delivery belongs to ${t(m[1])}.`],
  // 批次画面
  [/^货架（(.*)）$/, (m) => `Bins (${m[1]})`],
  [/^应有 (\S+) · 货架上 (\S+)(?: · 未上架 (\S+))?$/, (m) => `Expected ${m[1]} · on bins ${m[2]}${m[3] ? ` · not on bins ${m[3]}` : ""}`],
  [/^(\S+)（平常放这里）$/, (m) => `${m[1]} (usual spot)`],
  [/^打印纪录（已印 (\d+) 张）$/, (m) => `Print log (${m[1]} printed)`],
  [/^(\d+) 张 · (.+)$/, (m, t) => `${m[1]} ${m[1] === "1" ? "label" : "labels"} · ${t(m[2])}`],
  [/^🖨 补印箱贴（(\d+) 张）$/, (m) => `🖨 Reprint box labels (${m[1]})`],
  // 打印纪录
  [/^([\d.,]+) 件 · (\d+) 箱(?: · (.+))?$/, (m) => `${m[1]} pcs · ${m[2]} ${m[2] === "1" ? "box" : "boxes"}${m[3] ? ` · ${m[3]}` : ""}`],
  [/^(箱贴|商品条码|货架标签) × (\d+)$/, (m, t) => `${t(m[1])} × ${m[2]}`],
  [/^(\d+) 笔$/, (m) => `${m[1]} records`],
  // 下载 Excel 超过上限
  [/^只下载了前 (\d+) 行（共 (\d+) 行），请加筛选条件再下载。$/, (m) => `Only the first ${m[1]} rows were downloaded (of ${m[2]}) — add filters and download again.`],
  // 照片
  [/^照片上传失败：(.+)$/, (m) => `Photo upload failed: ${m[1]}`],
  // 资料库错误讯息
  [/^「(.+)」是系统照销量 \/ 最后进货日自动标的，不能手动标或拿掉。$/, (m, t) => `"${t(m[1])}" is tagged automatically from sales / last receiving date — it can't be set or removed by hand.`],
  [/^标签「(.+)」已经停用。$/, (m, t) => `Tag "${t(m[1])}" is turned off.`],
  [/^找不到商品「(.*)」。$/, (m) => `Item "${m[1]}" not found.`],
  [/^这笔进货（(.+)）已经取消，不能印箱贴。$/, (m) => `This goods-in (${m[1]}) was cancelled — box labels can't be printed.`],
  [/^找不到批次「(.*)」。请检查箱贴上的批次号。$/, (m) => `Lot "${m[1]}" not found. Check the lot number on the box label.`],
  [/^找不到批次「(.*)」。$/, (m) => `Lot "${m[1]}" not found.`],
  [/^未知的标签种类：(.*)$/, (m) => `Unknown label type: ${m[1]}`],
  [/^第 (\d+) 行：(.+)$/, (m, t) => `Row ${m[1]}: ${t(m[2])}`],
];

/** 万用的「名称（数字）」：会抢走别的字典更专门的 pattern（例：AutoCount 最近卖出（3）），
 *  所以单独拿出来，i18n.ts 要把它放在 ALL_PATTERNS 的最后 */
export const PATTERNS_WHTAG_LAST: [RegExp, (m: RegExpMatchArray, t: T) => string][] = [
  [/^(.+)（(\d+)）$/, (m, t) => `${t(m[1])} (${m[2]})`],
];
