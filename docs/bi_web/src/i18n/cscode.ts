// 订货页「CS 厂号」下拉改列全部厂号并标件数(2026-10-14,Purchasing.tsx);键 = 中文原文
const cscode: Record<string, string> = {
  '{n} 项': '{n} items',
  '0 项 · {n} 项未达门槛': '0 shown · {n} below threshold',
  '0 项 · {n} 项近 90 天没卖': '0 shown · {n} not sold in 90 days',
  '0 项 · 商品已改挂别的厂号': '0 shown · items moved to other codes',
  '厂号 {c}:': 'CS code {c}: ',
  '有 {n} 个商品近 90 天有卖,但每个都不到门槛 {q} 件,所以没列出来。': '{n} items sold in the last 90 days, but none reached the {q}-unit threshold, so none are listed.',
  '最近向这个厂号进货的 {n} 个商品,近 90 天都没卖出,分行也没预订(刚进的新货还没开卖时也会这样)。': 'The {n} items last bought under this code had no sales in the last 90 days and no branch backorders (new arrivals that have not started selling look like this too).',
  '这个厂号开过 PO,但它的商品后来都改向别的厂号下单了,现在没有商品挂在它名下。': 'This code has POs, but all its items have since been re-ordered under other codes, so no item is currently assigned to it.',
  '另有 {n} 项已手动设为排除。': '{n} more items are manually excluded.',
  '最近一张 PO 是 {d}。': 'Last PO on {d}.',
  '把门槛切到 {q}(会出现 {n} 项)': 'Switch threshold to {q} ({n} items will show)',
  '就算把门槛切到 10 也不会有商品出现。': 'Even at threshold 10 nothing would show.',
  '厂号清单读取失败(下拉暂时只列已载入商品的厂号):': 'Could not load the CS code list (the dropdown shows only codes of loaded items for now): ',
  '符合条件的商品超过 1000 行,只载入了最急的前 1000 行,还能卖比较久的商品没显示。请把走量门槛调高,或先选一个厂号(选了厂号就不受 1000 行限制)。': 'More than 1,000 items match; only the 1,000 most urgent were loaded and the rest are hidden. Raise the volume threshold, or pick a CS code first (a code filter is not capped).',
};
export default cscode;
