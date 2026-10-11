// 中文原文 → 英文。键必须与程式码里 t() 的字串一字不差。
// 范围:src/pages/Targets.tsx(目标设定与追踪)。
const d: Record<string, string> = {
  // 分页名(App.tsx 的分页按钮若用 t('目标'))
  '目标': 'Target',

  // 共用
  '载入中…': 'Loading…',
  '查询失败:{e}': 'Query failed: {e}',
  '月份': 'Month',
  '储存': 'Save',
  '储存中…': 'Saving…',
  '储存失败:{err}': 'Save failed: {err}',
  '未设定': 'Not set',
  '至今': 'MTD',
  '实际': 'Actual',
  '渠道': 'Channel',
  '达成率': 'Achieved',
  '去年同月': 'Same month last year',
  '近 3 个月平均': 'Last 3-month avg.',
  '(本月)': '(this month)',
  '(上个月)': '(last month)',
  '(下个月)': '(next month)',
  '(至今)': '(to date)',

  // 渠道名(资料库值,显示时翻译;与 manager.ts 相同)
  '门市现金': 'Walk-in cash',
  'B2B客户': 'B2B customers',
  '其他平台': 'Other platforms',
  '分行': 'Branch',

  // 输入目标
  '看不懂这个金额': 'Cannot read this amount',
  '可输入 1500000、1.5m、800k 或 80万': 'try 1500000, 1.5m, 800k or 80万 (= 800k)',
  '可输入 1500000、1.5m、800k 或 80万;清空后储存 = 删除目标': 'Enter 1500000, 1.5m, 800k or 80万 (= 800k); clear and save to delete the target',
  '设定目标': 'Set target',

  // 复制上个月
  '复制中…': 'Copying…',
  '把上个月目标复制到 {m}': "Copy last month's targets to {m}",
  '{c}:复制 {n} 笔,已存在 {s} 笔未覆盖': '{c}: copied {n}, {s} already set (kept)',
  '{m} 没有任何目标可以复制': '{m} has no targets to copy',

  // 空资料
  '看不到任何目标资料:这个帐号可能不在白名单,或销售资料还没同步。': 'No target data visible: this account may not be on the allow list, or sales data has not synced yet.',

  // 各分行卡片
  '各分行本月进度': 'Progress this month by company',
  '各分行 {m} 达成': 'Achievement by company, {m}',
  '各分行 {m} 目标': 'Targets by company, {m}',
  '可达标': 'On track',
  '接近': 'Close',
  '落后': 'Behind',
  '资料截至 {d}': 'data to {d}',
  '分行电脑还没有推送这个月的资料': 'The branch PC has not pushed data for this month yet',
  '分行电脑有推送(推送于 {d}),但内容是 0 张单;如果不是真的没有业绩,请到分行电脑确认选的账套':
    'The branch PC pushed data ({d}) but it contained 0 documents; unless there really were no sales, please check which AutoCount book the branch PC uses',
  '还没有资料': 'No data yet',
  '预测月底': 'Month-end forecast',
  '月初完整的资料还太少,暂不预测': 'Too few complete days this early in the month to forecast',
  '各渠道预测相加,日均算到 {d} 号': 'sum of channel forecasts; daily average up to day {d}',
  '按 1～{d} 号的日均推算': 'daily average of days 1–{d}',
  '「分行」渠道(月中才开的集团内大单)按近 3 个月平均估': '"Branch" channel (large intra-group invoice mid-month) estimated from the last 3-month avg.',
  '按去年同月走势': 'Using last year\'s pattern',
  '已达标 ✅': 'Target reached ✅',
  '剩 {d} 天,每天还需 {rm}': '{d} days left, need {rm} per day',
  '平均每天需 {rm}': 'Need {rm} per day on average',
  '参考:去年同月 {a} · 近 3 个月平均 {b}': 'Reference: same month last year {a} · last 3-month avg. {b}',
  '分行电脑「实际销售」(SO 口径){rm},推送于 {d}': 'Branch PC "Actual sales" (SO basis) {rm}, pushed {d}',
  '资料来自分行电脑推送的「实际销售」(SO + 非SO发票 − 贷项)': 'Data is the "Actual sales" pushed from the branch PC (SO + non-SO invoices − credit notes)',
  '其中卖给分行 {rm}(集团内)': 'incl. sales to branches {rm} (intra-group)',
  '门店分页的门市目标:{rm}(只算门市现金 + B2B 客户,在门店分页使用,与这里的公司总目标不同)':
    'Store target on the Store tab: {rm} (walk-in cash + B2B customers only, used on the Store tab; different from the company targets here)',

  // 渠道目标表
  '渠道目标': 'Channel targets',
  '这家分行的资料来自分行电脑推送,只有公司总目标,没有渠道。': 'This branch\'s data comes from the branch PC, so it has a company target only, no channels.',
  '这个月没有渠道资料。': 'No channel data for this month.',
  '预测达成': 'Forecast vs target',
  '按去年走势': 'Last year\'s pattern',
  '每天还需': 'Needed per day',
  '平均每天需': 'Avg. per day needed',
  '已达标': 'Reached',
  '公司合计': 'Company total',
  '按近 3 个月平均': 'from last 3-month avg.',
  '晚入账,算到 {d} 号': 'posted late; up to day {d}',
  'Shopee / Lazada / TikTok 的实际已扣平台手续费(ONLINE 贷项,每周或每月一笔,常事后补登、日期往回填),设目标请用同一口径;去年同月、近 3 个月平均也是扣过的。':
    'Shopee / Lazada / TikTok actuals are net of platform fees (ONLINE credit notes, one per week or month, often posted later and back-dated); set targets on the same basis. The same-month-last-year and 3-month-avg. references are net of fees too.',
  '已设 {n} 个渠道目标,合计 {a}': '{n} channel targets set, total {a}',
  '与公司总目标 {b} 相差 {d}': 'differs from the company target {b} by {d}',

  // 近 6 个月
  '近 6 个月达成': 'Achievement, last 6 months',
  '公司目标': 'Company target',
  '渠道达标': 'Channels on target',

  // 说明
  '口径:实际 = 净销售(发票 + 现金单 − 贷项),渠道按客户代号分类,与门店分页相同;Shopee / Lazada / TikTok 已扣平台手续费;总部的公司合计含卖给分行的货。KL 等分行电脑推送的公司用「实际销售」(SO + 非SO发票 − 贷项)。':
    'Basis: actual = net sales (invoices + cash sales − credit notes); channels by customer code, same as the Store tab; Shopee / Lazada / TikTok are net of platform fees; the HQ company total includes goods sold to branches. Companies pushed from a branch PC (e.g. KL) use "Actual sales" (SO + non-SO invoices − credit notes).',
  '预测月底 = 到昨天为止的日均 × 当月天数:今天的单一天只同步 4 次、还没进完,不算进预测(「至今」有含);Shopee / Lazada / TikTok 的发票晚 2 天入账,算到各自最后有单的那天;「分行」渠道是月中才开的集团内大单,按「至今」与「近 3 个月平均」取大的估;公司合计 = 各渠道预测相加。':
    'Month-end forecast = daily average up to yesterday × days in month: today\'s sales sync only 4 times a day and are not complete, so they are left out of the forecast (MTD does include them). Shopee / Lazada / TikTok invoices are posted 2 days late, so each uses its own last day with sales. The "Branch" channel is a large intra-group invoice issued mid-month, estimated as the larger of MTD and the last 3-month avg. Company total = sum of channel forecasts.',
  '灯号:预测达成 ≥100% 绿、90～100% 黄、<90% 红;进度条上的细线 = 日历进度。':
    'Lights: forecast ≥100% green, 90–100% yellow, <90% red. The thin line on a bar = calendar progress.',
  '「按去年走势」= 至今 × 去年同月整月 ÷ 去年同月同期(公司合计把分行以外的渠道合起来算),月初或去年同期特别淡 / 旺时会偏离,仅供参考。数字每 2 小时更新一次。':
    '"Last year\'s pattern" = MTD × same month last year (full) ÷ same month last year to the same day (the company total pools all channels except Branch); early in the month, or if last year\'s first days were unusually slow / busy, it can be off — for reference only. Numbers refresh every 2 hours.',
};
export default d;
