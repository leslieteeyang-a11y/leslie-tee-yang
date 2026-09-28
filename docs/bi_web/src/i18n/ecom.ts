// 中文原文 → 英文。键必须与程式码里 t() 的字串一字不差。
// 范围:电商月报(EcomReport)、广告 / 直播数字填写(AdsEditor)、分行实际销售(BranchActual)。
const d: Record<string, string> = {
  // 共用
  '载入中…': 'Loading…',
  '更新于': 'Updated',
  '查询失败:{err}': 'Query failed: {err}',
  '该月无数据': 'No data for this month',
  '当月实际销售额': 'Actual sales this month',

  // EcomReport
  '水工': 'Plumbers',
  '期间': 'Period',
  'SO 全部 {so}（未转发票 {open}）+ 非SO发票 {direct}（发票全部 {iv}）− 贷项 {cn}':
    'All SO {so} (not yet invoiced {open}) + invoices not from SO {direct} (all invoices {iv}) − credit notes {cn}',
  '分行（JB Southern 账套）当月实际销售额：SO 全部 + 非SO发票 − 贷项，排除 agent 空白；不计入 Total':
    'Branch (JB Southern book) actual sales this month: all SO + invoices not from SO − credit notes, excluding blank agent; not included in Total',
  '「当月实际销售额」这栏还没有资料：分行电脑上跑 setup_branch.bat 之后才会有。':
    'The "Actual sales this month" column has no data yet: it appears after setup_branch.bat has been run on the branch PC.',
  '还没有电商月报资料{err}。请在 SERVER 上执行 setup_bi.bat 或 backfill.bat 推送。':
    'No e-commerce monthly report data yet{err}. Run setup_bi.bat or backfill.bat on SERVER to push it.',
  'SKU 月度销量': 'Monthly SKU sales qty',
  '追踪 SKU 合计销量趋势': 'Tracked SKUs total qty trend',
  'Shopee Ads / Lazada Sponsored Affiliate / Live Sales 不在 AutoCount 里,这个月还没填(老板点上面「填写广告 / 直播数字」即可)。':
    'Shopee Ads / Lazada Sponsored Affiliate / Live Sales are not in AutoCount and have not been entered for this month (owner: click "Enter ads / live-sales figures" above).',
  '口径:销售 = 发票 + 现销 − 贷项 + 借项,按商品群组与客户账号分类,与 Excel 月报完全一致;「(未分类)」= 开单时没选商品代号的行。':
    'Definition: sales = Invoice + Cash Sale − Credit Note + Debit Note, grouped by item group and debtor account, identical to the Excel monthly report; "(Uncategorised)" = lines entered without an item code.',
  'Top 10 只看 Shopee + Lazada 销量,按型号合并。「当月实际销售额」= 分行 JB Southern 账套：Sales Order 全部 + 不是从 SO 转来的发票 − 贷项,排除 agent 空白的单,不计入 Total。':
    'Top 10 counts Shopee + Lazada qty only, merged by model code. "Actual sales this month" = branch JB Southern book: all Sales Orders + invoices not transferred from SO − credit notes, excluding documents with a blank agent; not included in Total.',

  // AdsEditor
  '储存失败:{err}': 'Save failed: {err}',
  '已储存,Excel 月报下次产生时会自动带入。': 'Saved. It will be included the next time the Excel monthly report is generated.',
  '填写 {m} 的广告 / 直播数字': 'Enter ads / live-sales figures for {m}',
  'Shopee Ads、Lazada Affiliate、Shopee AMS、Live Sales 不在 AutoCount,由这里填':
    'Shopee Ads, Lazada Affiliate, Shopee AMS and Live Sales are not in AutoCount; enter them here',
  '填写广告 / 直播数字': 'Enter ads / live-sales figures',
  '期间(日)': 'Period (days)',
  '花费 (RM)': 'Expense (RM)',
  '删除这一行': 'Delete this row',
  '+ 加一行': '+ Add row',
  'LIVE SALES(整月,RM)': 'LIVE SALES (whole month, RM)',
  '储存中…': 'Saving…',
  '储存': 'Save',
  '关闭': 'Close',

  // BranchActual
  '还没有分行实际销售额资料{err}。请在分行电脑上执行 setup_branch.bat 推送。':
    'No branch actual sales data yet{err}. Run setup_branch.bat on the branch PC to push it.',
  '分行账套': 'Branch book',
  '= SO 全部 + 非SO发票 − 贷项;排除 agent 空白': '= all SO + invoices not from SO − credit notes; excluding blank agent',
  'Sales Order 全部': 'All Sales Orders',
  '其中未转发票 {v}': 'of which not yet invoiced {v}',
  '非 SO 转来的发票': 'Invoices not from SO',
  '发票全部 {v}(含转自 SO 的)': 'All invoices {v} (incl. those transferred from SO)',
  '贷项 (Credit Note)': 'Credit Notes',
  '排除 agent 空白:{list}': 'Excluding blank agent: {list}',
  '无': 'none',
  '按类别': 'By category',
  '类别': 'Category',
  'SO 全部': 'All SO',
  '其中未转发票': 'Not yet invoiced',
  '非SO发票': 'Invoices not from SO',
  '发票全部': 'All invoices',
  '贷项': 'Credit notes',
  '实际销售额': 'Actual sales',
  '占比': 'Share',
  '各 Sales Agent': 'By Sales Agent',
  '(全品牌)': ' (All brands)',
  'SO 单数': 'SO count',
  '发票单数': 'Invoice count',
  '该月无 agent 明细': 'No agent breakdown for this month',
  'SO {so} + 非SO发票 {direct} − 贷项 {cn}': 'SO {so} + invoices not from SO {direct} − credit notes {cn}',
  '(agent 空白,已排除)': '(blank agent, excluded)',
  '各 agent 的实际销售额要分行电脑更新到新版脚本后才会有(需要「非SO发票」按 agent 拆分);表里的发票全部含转自 SO 的发票。':
    'Actual sales per agent is available only after the branch PC is updated to the new script (it needs "invoices not from SO" split by agent); "All invoices" in this table includes invoices transferred from SO.',
  '逐月实际销售额': 'Monthly actual sales',
  '口径:Sales Order 全部(含未转发票的部分)+ 不是从 SO 转来的 Invoice − Credit Note;三种单据都排除 Sales Agent 空白的单。':
    'Definition: all Sales Orders (incl. the part not yet invoiced) + Invoices not transferred from SO − Credit Notes; all three document types exclude documents with a blank Sales Agent.',
};
export default d;
