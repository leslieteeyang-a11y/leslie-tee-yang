// 订货页「CS 厂号」下拉改列全部厂号并标件数(2026-10-14,Purchasing.tsx);键 = 中文原文
const cscode: Record<string, string> = {
  '{n} 项': '{n} items',
  '0 项 · {n} 项未达门槛': '0 · {n} below threshold',
  '0 项 · {n} 项无销售': '0 · {n} with no sales',
  '0 项': '0 items',
  '厂号 {c}:': 'Factory {c}: ',
  '有 {n} 个商品在候选名单,但近 90 天销量都低于门槛 {q} 件。': '{n} items are on the candidate list, but none sold ≥{q} units in the last 90 days.',
  '最近一张 PO 挂这个厂号的 {n} 个商品,近 90 天都没有销售,也不欠分行。': 'The {n} items whose latest PO carries this code had no sales in the last 90 days and are not owed to the branch.',
  '没有任何商品的最近一张 PO 挂这个厂号。': 'No item has this code on its latest PO.',
  '最近 PO {d}。': 'Last PO {d}.',
  '把门槛切到 10(会出现 {n} 项)': 'Switch threshold to 10 ({n} items will show)',
  '门槛切到 10 也不够。': 'Even threshold 10 shows nothing.',
  '已达 1000 行载入上限,排在后面的商品没载入:请提高走量门槛,或先选一个厂号(选厂号时在伺服器端过滤,不受上限影响)。': 'Reached the 1,000-row load limit; items further down were not loaded. Raise the volume threshold, or pick a factory code first (that filter runs on the server and is not capped).',
};
export default cscode;
