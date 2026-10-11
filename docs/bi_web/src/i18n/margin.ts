// 中文原文 → 英文。键必须与程式码里 t() 的字串一字不差。
// 范围:src/pages/Margin.tsx(毛利分析,只给 owner 看)。
// 别的字典已经有的键(core:载入中… / 查询失败: / 商品 / 数量 / 群组 / 商品排行;manager / pages2:本月至今、上个月、渠道、
// 业务员、(未指定)、渠道名;pages1:项目;purchasing:行数、品牌;ecom:类别、按类别;loyalty:近 12 个月)不再重复放,
// 免得合并进 DICT 时把别页的英文盖掉。与 health.ts 重复的「可信毛利率」「口径说明」英文一字不差。
const d: Record<string, string> = {
  // 分页名(App 整合时用)
  '毛利分析': 'Margins',

  // 期间 / 开关
  '近 3 个月': 'Last 3 months',
  '今年至今': 'Year to date',
  '含分行': 'Incl. branch',
  '不含分行': 'Excl. branch',
  '期间 {a} ~ {b}': 'Period {a} ~ {b}',
  '数据更新于 {d}': 'Data refreshed {d}',
  '没有资料': 'No data',
  '这家公司在这段期间没有销售明细(BI 只有总部与 JB Southern 的发票明细;KL 目前只有分行电脑推的「实际销售」),所以算不出毛利。':
    'This company has no sales lines for this period (BI only holds invoice lines for HQ and JB Southern; KL only has the "Actual sales" pushed from the branch PC), so margins cannot be calculated.',

  // KPI
  '销售净额': 'Net sales',
  '商品 {a} · 服务/费用 {b} · 无代号 {c}': 'Goods {a} · Services/fees {b} · No item code {c}',
  '可信毛利': 'Reliable gross profit',
  '只算有成本的商品行(销售 {v})': 'Goods lines with a cost only (sales {v})',
  '可信毛利率': 'Reliable gross margin',
  '账面毛利率 {p}(没成本的行当 0 成本,会偏高)': 'Book margin {p} (lines without cost counted as zero cost, so it reads too high)',
  '没成本的销售额': 'Sales without cost',
  '占商品销售 {p} · {a} 行 / {b} 个商品': '{p} of goods sales · {a} lines / {b} items',
  '请会计在 AutoCount 补成本价': 'Ask accounts to fill in the cost in AutoCount',
  '没成本的金额里,{p} 来自「分行」渠道(总部开给 HOMEWORKS (SOUTHERN) 的整批调拨发票)。按「不含分行」可以看对外生意的毛利。':
    '{p} of the no-cost amount comes from the "Branch" channel (bulk transfer invoices from HQ to HOMEWORKS (SOUTHERN)). Choose "Excl. branch" to see the margin on external business.',

  // 趋势
  '近 12 个月可信毛利率': 'Reliable gross margin, last 12 months',
  '没成本占商品销售': 'No-cost share of goods sales',
  '实线是只算有成本行的毛利率;虚线是没成本的销售占比——虚线越高,那个月的毛利率越不可靠。本月只到今天。':
    'Solid line: margin on lines with a cost. Dashed line: share of sales without cost — the higher it is, the less reliable that month\'s margin. This month runs to today only.',

  // 维度表
  '按渠道': 'By channel',
  '按业务员': 'By sales agent',
  '按品牌': 'By brand',
  '商品销售': 'Goods sales',
  '扣费后毛利率': 'Margin after fees',
  '占总毛利': 'Share of profit',
  '没成本占比': 'No-cost share',
  '只看前 {n} 个': 'Show top {n} only',
  '显示全部 {n} 个': 'Show all {n}',
  '(未分类)': '(Unclassified)',
  '(未分组)': '(No group)',
  '(未设品牌)': '(No brand)',

  // 商品排行
  '卖得多但毛利率低': 'Big sellers, low margin',
  '毛利为负': 'Negative margin',
  '赚钱但被忽略': 'Profitable but overlooked',
  '没成本(给会计)': 'No cost (for accounts)',
  '销售 (RM)': 'Sales (RM)',
  '成本 (RM)': 'Cost (RM)',
  '毛利 (RM)': 'Profit (RM)',
  '毛利率': 'Margin',
  '均价 / 均成本': 'Avg price / avg cost',
  '没有符合条件的商品': 'No matching items',
  '另有没成本 {v}': 'plus {v} without cost',
  '有成本的销售额前 100 名里,毛利率最低的 {n} 个。红色 = 亏钱,或低于公司平均毛利率的一半({p})。':
    'Among the top 100 items by sales with a cost, the {n} with the lowest margin. Red = losing money, or below half the company average margin ({p}).',
  '有成本的销售扣掉成本后是负数(卖一件亏一件)。售价 0 的赠品(例如 STOCK A 群组)也会出现在这里——那是送出去的货的成本。':
    'Sales with a cost that come out negative after cost (every unit loses money). Free gifts sold at 0 (e.g. the STOCK A group) also show here — that is the cost of goods given away.',
  '毛利率比公司平均高 30% 以上、有成本的销售至少 RM 300,但销售额不在前 100 名的商品——可以考虑多推、放首页或给业务员奖励。':
    'Items whose margin is at least 30% above the company average, with at least RM 300 of sales with a cost, but not in the top 100 by sales — consider pushing them, featuring them, or rewarding salespeople for them.',

  // 没成本
  '下载商品清单 CSV': 'Download item list CSV',
  '准备中…': 'Preparing…',
  '下载明细(含单号)CSV': 'Download lines (with doc no.) CSV',
  '明细 CSV 列出每一张没成本(或成本正负号填错)的发票行,会计照单号在 AutoCount 打开补成本;补好后隔天这里就会变少。':
    'The lines CSV lists every invoice line without cost (or with a cost of the wrong sign); accounts can open each document in AutoCount by its number and fix the cost. Fixed lines drop off here the next day.',
  '没成本数量': 'Qty without cost',
  '没成本销售额 (RM)': 'Sales without cost (RM)',
  '参考单位成本': 'Reference unit cost',
  '估计漏算成本 (RM)': 'Estimated missing cost (RM)',
  '这段期间没有没成本的商品行': 'No goods lines without cost in this period',
  '没有参考': 'No reference',
  '只显示前 100 个,完整清单请下载 CSV。': 'Showing the first 100 only; download the CSV for the full list.',
  '参考单位成本 = 同一商品近 12 个月有成本的行的平均成本;估计漏算成本 = 参考单位成本 × 没成本数量(单位不同时只是粗估)。':
    'Reference unit cost = average cost of the same item on lines with a cost over the last 12 months; estimated missing cost = reference unit cost × qty without cost (only a rough estimate when units differ).',

  // 服务 / 费用
  '服务 / 费用与没有商品代号的行(不算进商品毛利率)': 'Services / fees and lines without an item code (excluded from goods margin)',
  '净额 (RM)': 'Net (RM)',
  '(没有商品代号的自由输入行)': '(Free-text lines without an item code)',
  '这些行本来就没有进货成本(平台手续费、Voucher、运费、安装、转账费、代收的 GST / 运费等),或是开单时没选商品代号的自由输入行,所以单独列出,不混进商品毛利率。':
    'These lines have no purchase cost by nature (platform fees, vouchers, shipping, installation, transaction fees, GST / delivery collected on behalf, etc.), or are free-text lines entered without an item code, so they are listed separately and kept out of the goods margin.',

  // 口径
  '口径说明': 'Definitions',   // 与 health.ts 相同,合并顺序不影响
  '销售净额 = 发票 + 现金单 − 贷项单(CN)的明细合计,与总览页相同。数字每 2 小时重算一次(每逢双数小时的第 45 分),最多慢 2 小时。':
    'Net sales = invoice + cash sale − credit note (CN) lines, the same as the Overview page. Recalculated every 2 hours (at minute 45 of every even hour), so up to 2 hours behind.',
  '可信毛利 / 可信毛利率只算「有成本」的商品行(成本 ≠ 0 且正负号跟销售一样)。成本 = 0 的商品行另列为「没成本」,不混进毛利率,否则毛利率会被灌高。':
    'Reliable profit / margin only count goods lines that have a cost (cost ≠ 0 with the same sign as the sale). Goods lines with cost = 0 are shown separately as "no cost" and kept out of the margin, otherwise the margin would be inflated.',
  '成本跟销售正负相反的行(例如发票卖 RM 212、成本却是 −0.92)是成本算错,也归到「没成本」,一样列给会计修。':
    'Lines whose cost has the opposite sign to the sale (e.g. an invoice line sold at RM 212 with a cost of −0.92) have a wrong cost; they are also counted as "no cost" and listed for accounts to fix.',
  '服务 / 费用群组(ONLINE、SHIP FEE、PAY FEE、TRAN FEE、SERV FEE、INSTALL、TRANSPOR、DELIVERY、SERV INC、CARD INT、GST)与没有商品代号的行另外列,不算商品毛利率。':
    'Service / fee groups (ONLINE, SHIP FEE, PAY FEE, TRAN FEE, SERV FEE, INSTALL, TRANSPOR, DELIVERY, SERV INC, CARD INT, GST) and lines without an item code are listed separately and excluded from the goods margin.',
  '为什么总部有那么多成本 = 0 的行:按行数算,大部分是网店订单里的运费行(ONLINE SHIPPING FEES 等服务项目,本来就没成本,这页已分开);按金额算,大部分是开给分行 HOMEWORKS (SOUTHERN) 的整批调拨发票,其次是 SAMPLE 样品与新商品。':
    'Why HQ has so many cost = 0 lines: by line count, most are shipping lines on online orders (ONLINE SHIPPING FEES and similar service items, which have no cost by nature and are separated here); by amount, most are bulk transfer invoices to the branch HOMEWORKS (SOUTHERN), followed by SAMPLE items and new items.',
  '没成本的商品行有两种:同一个月别张发票有成本(单据问题,例如货先用 DO 出库、发票由 DO 转入,成本留在 DO),以及整个月都没有成本(新商品或样品,开单时还没有进货成本)。请会计用明细 CSV 逐张核对。':
    'Goods lines without cost come in two kinds: the item has a cost on other invoices in the same month (a document issue, e.g. goods left on a DO and the invoice was transferred from the DO, so the cost stayed on the DO), or the item has no cost all month (new items or samples with no purchase cost yet when invoiced). Ask accounts to check each one using the lines CSV.',
  '「不含分行」= 剔除总部开给分行的集团内调拨发票,只看对外生意。':
    '"Excl. branch" = leave out HQ\'s intra-group transfer invoices to the branch and look at external business only.',

  // 审查后修正(2026-10-10)
  '扣费净额': 'Fees net',
  '本月的平台手续费还没过账完(Shopee 每周汇总过账一次),所以「本月至今」不显示扣费后毛利率。请看「上个月」或「近 3 个月」。':
    'This month\'s platform fees are not fully posted yet (Shopee posts them as one weekly summary), so "MTD" does not show the margin after fees. See "Last month" or "Last 3 months".',
  '扣费净额 = 平台手续费(ONLINE000002)、Voucher 折扣、刷卡 / 转账费(负数),加上网店向客人收的运费(正数);代收的 GST、运费、刷卡利息、运输费、安装费不算。扣费后毛利率 ≈ 可信毛利率 + 扣费净额 ÷ 商品销售,是估计值;手续费是汇总过账,期间越短越不准。':
    'Fees net = platform fees (ONLINE000002), voucher discounts and card / transfer fees (negative), plus shipping charged to online customers (positive); GST, delivery, card interest, transport and installation collected on behalf are left out. Margin after fees ≈ reliable margin + fees net ÷ goods sales — an estimate; fees are posted in batches, so the shorter the period, the less accurate it is.',
  '这个账套的客户代号没有对应到渠道(渠道规则只认总部的客户代号),也没有平台手续费,所以不分渠道、不算扣费后毛利率,请看按业务员。':
    'This company\'s customer codes are not mapped to channels (the channel rules only know HQ customer codes) and it has no platform fees, so there is no channel breakdown or margin after fees here — see By sales agent.',
  '没成本的商品共 {b} 个,这里和商品清单 CSV 只列没成本金额最高的 {a} 个。要看全部,请缩短期间,或下载明细 CSV。':
    '{b} items have no cost; this list and the item CSV only include the {a} with the largest no-cost sales. To see them all, shorten the period or download the lines CSV.',
  '明细超过 {n} 行,CSV 只有日期最早的 {n} 行。请缩短期间分次下载。':
    'More than {n} lines; the CSV only has the earliest {n} by date. Shorten the period and download in parts.',
};
export default d;
