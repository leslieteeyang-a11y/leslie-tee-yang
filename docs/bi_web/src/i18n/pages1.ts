// 中文原文 → 英文。键必须与程式码里 t() 的字串一字不差。
// 范围:Dashboard / ProfitLoss / StockPage / ItemRanking
const d: Record<string, string> = {
  // 共用
  '载入中…': 'Loading…',
  '查询失败:{err}': 'Query failed: {err}',
  '查询失败,以下数字不可信:{err}': 'Query failed, the figures below are unreliable: {err}',
  '商品': 'Item',
  '数量': 'Qty',
  '净销售': 'Net sales',
  '毛利': 'Gross profit',
  '净利': 'Net profit',
  '销量': 'Qty sold',
  '销售额': 'Sales',
  '月份': 'Month',
  '年份': 'Year',
  '上一页': 'Prev',
  '下一页': 'Next',

  // Dashboard(总览)
  '本月净销售 ({ym})': 'Net sales this month ({ym})',
  '毛利 {v}': 'Gross profit {v}',
  '{y} 年累计净销售': '{y} YTD net sales',
  '累计毛利 {v}': 'YTD gross profit {v}',
  '毛利率 (今年, 销售口径)': 'GP margin (YTD, sales basis)',
  '毛利=金额−商品成本;无成本记录的行按 0 成本计,与损益页 GL 口径不同':
    'GP = amount − item cost; lines with no cost record count as zero cost, so this differs from the GL basis on the P&L page',
  '未交订单': 'Open orders',
  '{n} 行未交': '{n} open lines',
  '月度净销售与毛利(近 24 个月)': 'Monthly net sales & gross profit (last 24 months)',
  '{y} 年 Top 10 客户(净销售)': '{y} Top 10 customers (net sales)',
  '{y} 年 Top 10 商品(净销售)': '{y} Top 10 items (net sales)',
  '(无编码)': '(no code)',

  // ProfitLoss(损益)
  '{m}月': 'M{m}',
  '口径:总账 GLDTL 本位币;收入类科目按贷方为正显示。':
    'Basis: GL detail (GLDTL) in home currency; revenue accounts shown with credit as positive.',
  '{y} 年逐月净利': '{y} net profit by month',
  '{y} 年损益表(逐月)': '{y} P&L (monthly)',
  '项目': 'Line',
  '全年': 'Full year',
  '销售收入 (SA+SL)': 'Sales revenue (SA+SL)',
  '销售成本 (CO)': 'Cost of sales (CO)',
  '其他收入 (OI)': 'Other income (OI)',
  '费用 (EP)': 'Expenses (EP)',
  '税项 (TX)': 'Taxation (TX)',
  '单位:RM。此表为管理口径速览,精确到分的核对以 AutoCount 报表为准。':
    'Unit: RM. This is a management overview; for cent-level reconciliation refer to the AutoCount reports.',

  // StockPage(库存)
  '搜索商品编码 / 名称 / 型号…': 'Search item code / name / model…',
  '搜索': 'Search',
  '只看负库存({n} 行)': 'Negative stock only ({n} rows)',
  '{n} 行(商品×仓库)': '{n} rows (item × location)',
  '名称': 'Description',
  '分组': 'Group',
  '仓库': 'Location',
  '现存量': 'On hand',
  '商品合计': 'Item total',
  '门市价 P2': 'Retail price P2',
  '成本值': 'Cost value',
  '(默认)': '(default)',
  '现存量按 AutoCount 库存流水(StockDTL)汇总,随每日同步更新;成本值为流水成本净额估算。':
    'On-hand qty is summed from AutoCount stock transactions (StockDTL) and refreshed by the daily sync; cost value is an estimate from the net transaction cost. ',
  '现存量按 AutoCount 库存流水(StockDTL)汇总,随每日同步更新。':
    'On-hand qty is summed from AutoCount stock transactions (StockDTL) and refreshed by the daily sync. ',
  '红色负数 = 负库存,建议在 AutoCount 中核查过账仓库。':
    'Red negatives = negative stock; check the posting location in AutoCount.',

  // ItemRanking(商品排行)
  '口径:销售发票−贷项(CN);已剔除运费/代金券等虚拟项。':
    'Basis: Invoices − Credit Notes; shipping fees, vouchers and other virtual items excluded. ',
  '毛利=金额−商品成本。': 'GP = amount − item cost.',
  '该月无数据': 'No data for this month',
  '{m} 销量 Top 20': '{m} Top 20 by qty sold',
  '{m} 毛利 Top 20': '{m} Top 20 by gross profit',
  '{m} 销售额 Top 20': '{m} Top 20 by sales',
  '{m} 最低销量 20(当月有售出)': '{m} Bottom 20 by qty sold (sold this month)',
  '{m} 最低毛利 20': '{m} Bottom 20 by gross profit',
  '{m} 最低销售额 20': '{m} Bottom 20 by sales',
  '仅统计当月有正销量的商品;长期零销量的滞销品请结合库存页查看。':
    'Only items with positive qty sold this month; for long-term zero sellers see the Stock page.',
  '红色负数 = 当月亏本(退货冲销或售价低于成本),建议逐个核查定价。':
    'Red negatives = sold at a loss this month (returns or price below cost); review pricing item by item.',
  '红色负数 = 当月退货冲销大于销售。': 'Red negatives = returns exceeded sales this month.',
};
export default d;
