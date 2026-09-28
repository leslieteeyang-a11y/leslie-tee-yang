// 中文原文 → 英文。键必须与程式码里 t() 的字串一字不差。
// 范围:src/pages/Manager.tsx(店长页:门店日报 / 业务员表现 / 客户跟进)与 src/components/SalesCompare.tsx(销售对比)。
const d: Record<string, string> = {
  // 共用
  '载入中…': 'Loading…',
  '查询失败:{e}': 'Query failed: {e}',
  '月份': 'Month',
  '销售额': 'Net sales',
  '发票数': 'Invoices',
  '占比': 'Share',
  '同比': 'YoY',
  '环比': 'MoM',
  '合计': 'Total',
  '业务员': 'Sales Agent',
  '客户': 'Customer',
  '类型': 'Type',
  '客户数': 'Customers',
  '、': ', ',

  // 渠道名(数据库值,显示时翻译)
  '门市现金': 'Walk-in cash',
  'B2B客户': 'B2B customers',
  '其他平台': 'Other platforms',
  '分行': 'Branch',
  '(未指定)': '(Unassigned)',

  // Manager 分页按钮
  '门店日报': 'Store Daily',
  '业务员表现': 'Agent Performance',
  '客户跟进': 'Customer Follow-up',

  // 门店日报
  '最近一天门店销售 ({d})': 'Latest day store sales ({d})',
  '{n} 单 · 全公司 {rm}': '{n} invoices · Company-wide {rm}',
  '本周门店销售 (周一起)': 'Store sales this week (from Mon)',
  '门市现金 + B2B 客户': 'Walk-in cash + B2B customers',
  '本月门店销售': 'Store sales this month',
  '上月同期 {a} · {p}(上月全月 {b})': 'Same period last month {a} · {p} (full last month {b})',
  '本月全公司销售': 'Company-wide sales this month',
  '含电商平台与分行': 'Incl. e-commerce platforms and Branch',
  '本月门店目标': 'Store target this month',
  '本月已过 {d}/{n} 天,按进度应完成 {rm}': 'Day {d} of {n} this month; on pace should be {rm}',
  '进度正常 ✅': 'On track ✅',
  '落后 {rm} ⚠️': 'Behind by {rm} ⚠️',
  '近 30 天销售趋势': 'Sales trend, last 30 days',
  '门店': 'Store',
  '全公司': 'Company-wide',
  '本月分渠道': 'This month by channel',
  '渠道': 'Channel',
  '本月至今': 'MTD',
  '上月同期': 'Same period last month',
  '去年同月同期': 'Same period last year',
  '门店销售 = 门市现金 + B2B 客户(不含电商平台、不含分行调拨)。金额为净销售(发票−贷项)。数据随每日同步更新(13:00 / 19:30)。':
    'Store sales = Walk-in cash + B2B customers (excl. e-commerce platforms and Branch transfers). Amounts are net sales (Invoice − Credit Note). Data refreshes with the daily sync (13:00 / 19:30).',

  // 业务员表现
  '口径:门市 + B2B 客户销售(不含电商/分行);按开单时选的业务员归属': 'Scope: Store + B2B customer sales (excl. e-commerce / Branch); attributed to the Sales Agent selected on the invoice',
  '默认每人月目标 {rm}': 'Default monthly target per agent {rm}',
  '目标达成': 'Target',
  '单数': 'Invoices',
  '平均单值': 'Avg. invoice',
  '上月': 'Last month',
  '目标 {rm}': 'Target {rm}',
  '"(未指定)" = 开单时没选业务员的单。这个数越大,归属越不准 — 请提醒店员开单时选好业务员。':
    '"(Unassigned)" = invoices with no Sales Agent selected. The larger this is, the less accurate the attribution — remind staff to select the Sales Agent when invoicing.',
  '目标达成按每人月目标 {rm}': 'Target achievement uses a monthly target of {rm} per agent',
  '(单独目标: {list})': ' (individual targets: {list})',
  '计算;当月绿色=已达标、红色=落后于日历进度。': '; for the current month green = achieved, red = behind calendar pace.',

  // 客户跟进
  '订货明显下滑的客户 · {n} 家': 'Declining customers · {n}',
  '(近 90 天比去年同期跌超 30%,去年同期 ≥ RM 5,000)': '(last 90 days down more than 30% vs same period last year; last year ≥ RM 5,000)',
  '去年同期': 'Same period last year',
  '近 90 天': 'Last 90 days',
  '变化': 'Change',
  '最近下单': 'Last order',
  '90 天无单': 'No order in 90 days',
  '没有明显下滑的客户 👍': 'No declining customers 👍',
  '沉睡客户 · {n} 家': 'Inactive customers · {n}',
  '(之前一年买过 ≥ RM 3,000,近 90 天没来买 — 安排回访)': '(bought ≥ RM 3,000 in the prior year, nothing in the last 90 days — schedule a follow-up)',
  '之前 12 个月购买': 'Prior 12 months',
  '最后购买': 'Last purchase',
  '已多久(天)': 'Days since',
  '没有沉睡客户 👍': 'No inactive customers 👍',

  // 销售对比
  '销售对比': 'Sales Comparison',
  '逐日累计': 'Daily cumulative',
  '按月对比': 'Monthly',
  '对比去年同月': 'vs same month last year',
  '对比上个月': 'vs last month',
  '{m}月': 'M{m}',
  '{y} 累计': '{y} YTD',
  '{y} 同期(1–{m}月)': '{y} same period (M1–M{m})',
  '{y} 全年': '{y} full year',
  '{d}日': 'D{d}',
  '第 {d} 日累计': 'Cumulative to day {d}',
  '本月': 'This month',
  '(至 {d} 日)': '(to day {d})',
  '去年同月': 'Same month last year',
  '上个月': 'Last month',
  '(同期至 {d} 日)': ' (to day {d})',
  '整月': 'Full month',
  '相同天数': 'same number of days',
  '相同月份区间': 'same month range',
  '曲线为月内逐日累计净销售(发票−贷项)。本期为当月时只画到今天,且增幅按对比期':
    'Lines show cumulative net sales within the month (Invoice − Credit Note). For the current month only up to today is drawn, and growth is measured against the comparison period over the ',
  '计算,避免整月对半月的失真。': ', avoiding a full month vs half month distortion.',
  '每月净销售(发票−贷项),浅蓝 = 所选年份,灰 = 上一年同月;累计同比按上一年':
    'Monthly net sales (Invoice − Credit Note); blue = selected year, grey = same month of the prior year. Cumulative YoY uses the prior year over the ',
  '计算。悬停柱子看该月同比。': '. Hover a bar for that month\'s YoY.',
};
export default d;
