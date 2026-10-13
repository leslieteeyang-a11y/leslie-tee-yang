// 介面用语：订货 → 点货（货到了由仓库点数量）、物流部开厂家到货（2026-10-14）。
// 带数字 / 名称的句子在 i18n-patterns.ts；资料库错误讯息在 i18n-dict-db.ts。
export const DICT_RECV: Record<string, string> = {
  // 分页 / 按钮
  "点货": "Receive",
  "点货（货到了）": "Receive (goods arrived)",
  "点完，货到了": "Done — goods arrived",
  "确定，货到了": "Confirm — goods arrived",
  "再检查一下": "Let me check again",
  "回点货清单": "Back to receiving list",
  "← 点货清单": "← Receiving list",
  "全部照应到": "Set all to expected",
  "照原分配": "Use original split",
  "少的先扣总部": "Take the shortfall from HQ first",
  "多的放总部": "Put the extra in HQ",
  "只看有改的": "Only changed rows",
  "＋ 加一行来错的货": "+ Add a wrong item",
  "＋ 记坏货 / 到货少 / 来错货": "+ Log damaged / short / wrong items",
  "打开这张厂家到货 →": "Open this supplier delivery →",
  "看点货纪录 →": "View count record →",
  "到「厂家问题」处理（厂家会补 / 取消 / 已处理）→": "Handle it in \"Supplier issues\" (supplier will send / cancel / resolved) →",
  // 表头 / 栏位
  "应到": "Expected",
  "好货": "Good",
  "好货分到": "good to",
  "分到": "To outlets",
  "结果": "Result",
  "多到": "Extra",
  "来错": "Wrong item",
  "本来应该是": "Should have been",
  "来错数量": "Wrong item qty",
  "整张备注（可空白）": "Note for the whole delivery (optional)",
  "备注（例：外箱压坏、有拍照）": "Note (e.g. carton crushed, photo taken)",
  "例：外箱湿了、司机晚到": "e.g. cartons wet, driver came late",
  "点货纪录": "Count record",
  "已点货": "Received",
  "点货时记的": "from the count",
  "全部到齐": "All arrived",
  "全部照 DO 到齐": "Everything arrived as per the DO",
  "还没填好货": "Good qty missing",
  // 说明
  "厂家的货到了：点每个型号实际收到几件（好货、坏货），来错的货另外记；好货分给各分店的数量可以改。点完按「点完，货到了」。":
    "When a supplier's goods arrive: count how many of each model actually came (good and damaged) and log wrong items separately; you can change how the good units are split between outlets. When you're done, press \"Done — goods arrived\".",
  "到货少、坏货、多到、来错会自动记进「厂家问题」，采购照清单找厂家。":
    "Short, damaged, extra and wrong items are logged under \"Supplier issues\" automatically, and purchasing follows up with the supplier from that list.",
  "好货预设 = 应到；有坏的填坏货（坏货不分给分店）。好货一定要分完：各分店合计 = 好货。灰字「原」是确认时的分配。":
    "Good starts at the expected qty; enter broken units under Damaged (damaged units aren't allocated). All good units must be allocated: the outlet total must equal Good. The grey \"was\" figure is the split set when the DO was confirmed.",
  "收到不是这张 DO 的型号（例：订白色收到黑色）：一种一行，填收到的型号和数量；知道本来应该是哪个型号就选。会记成「发错型号」给采购找厂家。":
    "Got a model that isn't on this DO (e.g. ordered white, got black)? One row per model: enter the model received and the qty, and pick what it should have been if you know. It's logged as \"Wrong model\" for purchasing to take up with the supplier.",
  "确定后：这张 DO 算到货（各分店的「在路上」拿掉这张），下面的问题记进「厂家问题」给采购找厂家。点完不能撤回；AutoCount 仍要照常开 GRN。":
    "After confirming: this DO counts as arrived (it leaves every outlet's \"In transit\"), and the issues below are logged under \"Supplier issues\" for purchasing to take up with the supplier. This can't be undone; still make the GRN in AutoCount as usual.",
  "全部照 DO 到齐，没有要记的厂家问题。": "Everything arrived as per the DO — no supplier issues to log.",
  "货到了由仓库在「点货」填实际收到几件；到货少、坏货、来错也会记到「厂家问题」。":
    "When goods arrive, the warehouse enters what actually came under \"Receive\"; short, damaged and wrong items are logged under \"Supplier issues\" too.",
  "只显示有订的分店": "Only outlets that ordered",
  // 清单 / 状态
  "没有要点的货。": "Nothing to receive.",
  "点货还没送出。": "The count hasn't been submitted yet.",
  "点货还没送出，确定离开？": "The count hasn't been submitted. Leave anyway?",
  "已点完货：全部到齐。": "Goods received: everything arrived as listed.",
  "这张厂家 DO 还没确认（草稿），不能点货。": "This supplier DO isn't confirmed yet (draft), so it can't be received.",
  "这张厂家 DO 已取消。": "This supplier DO was cancelled.",
  "这张是以前直接「标记到货」的，没有点货纪录。": "This one was marked arrived directly (before counting was added), so there's no count record.",
  "这张没有厂家问题。": "No supplier issues on this one.",
  // 2026-10-14 审查后：搜寻、天数、点货前已记的、多寄的坏件、确认的人不能自己点
  "找 DO 号 / 厂家 / PO / 型号…": "Find DO no. / supplier / PO / model…",
  "清除": "Clear",
  "找不到符合的厂家货。": "No matching supplier deliveries.",
  "找不到符合的点货纪录。": "No matching count records.",
  "最近几天": "How many days back",
  "点货时全部到齐": "All arrived at the count",
  "点货时全部照 DO 到齐": "Everything arrived as per the DO at the count",
  "你确认的：请仓库同事点": "You confirmed it — ask a warehouse colleague to count it",
  "点货后补记": "added after the count",
  "好货改少了，没动过分配的型号会自动从总部先扣（多了放总部）；要别的分法直接改分店的数字。":
    "When you lower Good, models whose split you haven't touched take the shortfall from HQ first (extras go to HQ); to split differently, just change the outlet numbers.",
  "有型号点货前已经记了坏货 / 到货少：已先填进好货、坏货，实际不同请改。":
    "Some models already had damaged / short units logged before the count: they're pre-filled in Good and Damaged — change them if what you find is different.",
  "点货前记的比点到的多：点完后请采购到「厂家问题」核对，多记的作废。":
    "More was logged before the count than you found missing: after submitting, ask purchasing to check under \"Supplier issues\" and void the extra.",
  "点货前记的坏货 / 到货少比点到的多：请采购到「厂家问题」核对，多记的作废。":
    "More damaged / short units were logged before the count than were found missing: purchasing should check under \"Supplier issues\" and void the extra.",
  "总部送货去分店时照这里分；少到的件数算在被减的分店，下一张厂家到货会预设分给它。":
    "HQ delivers to the outlets using this split; units still missing count against the outlet that got fewer, and the next supplier delivery is pre-allocated to it.",
  "你点的数字跟下面的纪录不一样的话，用「＋ 记坏货 / 到货少 / 来错货」补记。":
    "If your count differs from the record below, add the difference with \"+ Log damaged / short / wrong items\".",
  "这张厂家 DO 是你确认的：请仓库的同事点货（确认和点货分开，少了、坏了才有人核对）。":
    "You confirmed this supplier DO, so a warehouse colleague has to count it (confirming and counting are kept apart so short or damaged goods get a second check).",
  "货到了由仓库的同事在「点货」点数量（确认这张的人不能自己点）。":
    "When the goods arrive, a warehouse colleague counts them under \"Receive\" (whoever confirmed this DO can't count it).",
};
