// 订货页「CS 厂号」下拉改列全部厂号并标件数(2026-10-14,Purchasing.tsx);键 = 中文原文
const cscode: Record<string, string> = {
  '{n} 项': '{n} items',
  '0 项 · {n} 项未达门槛': '0 shown · {n} below threshold',
  '0 项 · {n} 项近 90 天没卖': '0 shown · {n} not sold in 90 days',
  '0 项 · 商品已改挂别的厂号': '0 shown · items moved to other codes',
  '厂号 {c}:': 'CS code {c}: ',
  '有 {n} 个商品近 90 天有卖,但每个都不到门槛 {q} 件、也都还有货,所以没列出来。': '{n} items sold in the last 90 days, but none reached the {q}-unit threshold and all are still in stock, so none are listed.',
  '近 90 天至少卖出这么多件才列出;欠分行或已经没货(现存 ≤ 0)的商品不受门槛限制,一律列出': 'Items must sell at least this many units in 90 days to be listed; items owed to the branch or already out of stock (on hand ≤ 0) are always listed regardless',
  '走量门槛只筛还有货的商品——欠分行或现存 ≤ 0 的一律列出;': 'The volume threshold only filters items still in stock; items owed to the branch or with on-hand ≤ 0 are always listed;',
  '最近向这个厂号进货的 {n} 个商品,近 90 天都没卖出,分行也没预订(刚进的新货还没开卖时也会这样)。': 'The {n} items last bought under this code had no sales in the last 90 days and no branch backorders (new arrivals that have not started selling look like this too).',
  '这个厂号开过 PO,但它的商品后来都改向别的厂号下单了,现在没有商品挂在它名下。': 'This code has POs, but all its items have since been re-ordered under other codes, so no item is currently assigned to it.',
  '另有 {n} 项已手动设为排除。': '{n} more items are manually excluded.',
  '最近一张 PO 是 {d}。': 'Last PO on {d}.',
  '把门槛切到 {q}(会出现 {n} 项)': 'Switch threshold to {q} ({n} items will show)',
  '就算把门槛切到 10 也不会有商品出现。': 'Even at threshold 10 nothing would show.',
  '厂号清单读取失败(下拉暂时只列已载入商品的厂号):': 'Could not load the CS code list (the dropdown shows only codes of loaded items for now): ',
  '符合条件的商品超过 3000 行,只载入了最急的前 3000 行,还能卖比较久的商品没显示。请把走量门槛调高,或先选一个厂号。': 'More than 3,000 items match; only the 3,000 most urgent were loaded and the rest are hidden. Raise the volume threshold, or pick a CS code first.',
  '+ 没货的一律列出': '+ out-of-stock always listed',
  '没货的商品不管近 90 天卖多少,一律列出;要单独看就勾右边「只看没货」': 'Out-of-stock items are always listed no matter how few sold in 90 days; tick "Only out of stock" on the right to see just those',
  '现存 ≤ 0 的商品不受走量门槛限制,一律列出;勾选后只显示这些': 'Items with on-hand ≤ 0 bypass the volume threshold and are always listed; tick to show only those',
  '只看没货(现存 ≤ 0)({n})': 'Only out of stock (on hand ≤ 0) ({n})',
};
export default cscode;
