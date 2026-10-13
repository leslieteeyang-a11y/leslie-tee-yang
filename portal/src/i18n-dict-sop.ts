// 介面用语：订货 SOP（2026-10-15）— 第几步 / 等哪个部门、这批的问题（少发先决定、来错的型号、缺零件）、要厂家怎么处理、
// WhatsApp 发给厂家、厂家还欠、进货待入 AutoCount / 待开进货单（开单部）。资料库错误讯息（20261015_ops_po_sop）在 i18n-dict-db.ts（固定句）与 i18n-patterns.ts（带名称 / 数字）。
type T = (s: string) => string;

export const DICT_SOP: Record<string, string> = {
  // SOP
  "选 PO": "Pick POs",
  "出货数量": "Shipped qty",
  "分配分店": "Allocate to outlets",
  "订货部": "Purchasing",
  "仓库部": "Warehouse",
  "等订货部": "Waiting on Purchasing",
  "等仓库部": "Waiting on Warehouse",
  "都做完了": "All done",
  "还没填 ETA（可以先确认，之后再补）": "No ETA yet (you can confirm now and add it later)",
  "草稿开了超过 24 小时还没确认": "Draft opened more than 24 hours ago and still not confirmed",
  "超过 24 小时没确认": "Not confirmed for 24h+",
  "厂家出货时由订货部开一张：① 选 PO → ② 出货数量（上传厂家 DO / 装箱单：Excel 自动读数量；PDF、照片当附件）→ ③ 分配分店 → ④ ETA → ⑤ 确认。":
    "Purchasing opens one when a supplier ships: ① pick POs → ② shipped qty (upload the supplier DO / packing list: Excel quantities are read automatically; PDFs and photos are attachments) → ③ allocate to outlets → ④ ETA → ⑤ confirm.",
  "确认后分店在「在路上」看得到 ETA；少发、多发、发错型号、缺零件自动记到「厂家问题」，可以 WhatsApp 发给厂家。":
    "Once confirmed, outlets see the ETA under \"In transit\"; short, over, wrong models and missing parts are logged under \"Supplier issues\" and can be sent to the supplier on WhatsApp.",
  "⑥ 货到了由仓库在「点货」填实际收到几件；⑦ 采购在「厂家问题」决定厂家会补或取消。":
    "⑥ When the goods arrive the warehouse enters what came in under \"Receive\"; ⑦ Purchasing decides in \"Supplier issues\" whether the supplier will send the rest or it's cancelled.",

  // 要厂家怎么处理 / 缺零件
  "缺零件": "Missing parts",
  "要厂家怎么处理": "What the supplier should do",
  "要厂家…": "Ask supplier…",
  "换成正确的型号": "Replace with the correct model",
  "退回厂家": "Return to supplier",
  "下次补上": "Send with next shipment",
  "下次补正确的": "Send the correct model next time",
  "我们留下（照价算）": "We keep them (bill at PO price)",
  "其他（写在备注）": "Other (see note)",
  "换新的": "Send replacements",
  "会印在给厂家的清单与 WhatsApp 讯息上（「要厂家：…」）。细节写在备注。":
    "Printed on the list and WhatsApp message to the supplier (\"Ask supplier: …\"). Put details in the note.",
  "厂家不补了：这笔缺零件标为已处理。": "The supplier won't send it: this missing part is marked resolved.",

  // 收到的型号：搜我们的商品
  "打型号或品名找我们的商品…": "Type a model or name to find our item…",
  "不是我们的产品": "Not our product",
  "· 不是我们的产品": "· not our product",
  "改选": "Change",
  "改成我们的型号": "Pick our model instead",
  "找不到我们的商品。": "None of our items match.",
  "厂家写的型号（可空白）": "Supplier's model (optional)",
  "厂家写的型号": "Supplier's model",
  "品名（必填）": "Item name (required)",
  "请从清单选我们的型号，或按「不是我们的产品」。": "Pick our model from the list, or tap \"Not our product\".",

  // 开单画面：这批的问题
  "这批的问题": "Problems in this shipment",
  "少发、多发照上面的出货数量自动列出；来错的型号、缺零件自己加。确认后都记进「厂家问题」，可以 WhatsApp 发给厂家。":
    "Short and over shipments are listed from the quantities above; add wrong models and missing parts yourself. Once confirmed they all go to \"Supplier issues\" and can be sent to the supplier on WhatsApp.",
  "没有少发。": "Nothing short-shipped.",
  "没有多发。": "Nothing over-shipped.",
  "全部：": "All:",
  "已记过（之前的少发还没补齐），不重复记": "Already logged (an earlier shortage not yet made up) — not logged again",
  "收到不是这些 PO 的型号（例：订白色收到黑色）才加。Excel 里对不到 PO 的行也会列在这里。":
    "Only add models that aren't on these POs (e.g. ordered white, got black). Excel rows that don't match the POs are listed here too.",
  "厂家写法不同、其实是同一个型号？": "Same model, just written differently by the supplier?",
  "就是…（选了会再问一次）": "It's actually… (asks again before merging)",
  "就是哪个型号": "Which model it really is",
  "＋ 加一行来错的型号": "+ Add a wrong model",
  "例：订白色收到黑色，请换货": "e.g. ordered white, got black — please exchange",
  "来错备注": "Wrong-model note",
  "例：少了螺丝包、少一片玻璃。不影响在路上与少发的数量；确认后在「厂家问题」决定厂家会补或取消。":
    "e.g. screw pack missing, one glass panel missing. Doesn't change in-transit or short-shipped quantities; after confirming, decide in \"Supplier issues\" whether the supplier will send it or it's cancelled.",
  "型号（可不选）": "Model (optional)",
  "缺的零件 / 东西": "Missing part / item",
  "缺的零件": "Missing part",
  "缺零件的型号": "Model with missing parts",
  "缺零件数量": "Missing part qty",
  "缺零件备注": "Missing part note",
  "例：螺丝包": "e.g. screw pack",
  "例：每箱少 1 包": "e.g. 1 pack short per carton",
  "＋ 加一行缺零件 / 其他要补的": "+ Add a missing part / other item",
  "会带进厂家问题、印在给厂家的清单 / 讯息上": "Goes into the supplier issue and the list / message to the supplier",
  "会带进厂家问题、印在给厂家的清单 / 讯息上；仓库点货时也看得到。":
    "Goes into the supplier issue and the list / message to the supplier; the warehouse also sees it when receiving.",
  "仓库点货时看得到。": "The warehouse sees it when receiving.",
  "备注（会带进厂家问题、给厂家的讯息）": "Note (goes into the supplier issue and message)",
  "这批出了这些型号（同一张 PO）的话，确认时会自动补掉少发。":
    "If this shipment includes these models (same PO), confirming makes up the shortage automatically.",
  "到厂家问题看 →": "See Supplier issues →",
  "确认后：各分店在「在路上」看得到这批货与 ETA；下面的少发 / 多发 / 发错型号 / 缺零件会记到「厂家问题」（已记过的不会重复记），可以 WhatsApp 发给厂家。":
    "After confirming: every outlet sees this shipment and its ETA under \"In transit\"; the short / over / wrong models / missing parts below are logged under \"Supplier issues\" (nothing is logged twice) and can be sent to the supplier on WhatsApp.",
  "＋ 记坏货 / 到货少 / 发错型号 / 缺零件": "+ Log damaged / short / wrong model / missing parts",
  "记坏货 / 到货少 / 发错型号 / 缺零件": "Log damaged / short / wrong model / missing parts",
  "＋ 记坏货 / 到货少 / 来错货 / 缺零件": "+ Log damaged / short / wrong items / missing parts",
  "这张没有少发、多发、发错型号或缺零件。": "No short, over, wrong-model or missing-part issues on this DO.",
  "缺零件 / 其他要补的（例：少了螺丝包、少一片玻璃）：不影响在路上与少发的数量，在厂家问题里决定厂家会补或取消。":
    "Missing parts / other items (e.g. screw pack missing, one glass panel missing): doesn't change in-transit or short-shipped quantities; decide in Supplier issues whether the supplier will send it or it's cancelled.",
  "备注与「要厂家怎么处理」会印在给厂家的清单与 WhatsApp 讯息上。":
    "The note and \"What the supplier should do\" are printed on the list and WhatsApp message to the supplier.",

  // WhatsApp
  "📱 WhatsApp 发给厂家": "📱 WhatsApp the supplier",
  "📱 WhatsApp 催货": "📱 WhatsApp a reminder",
  "WhatsApp 发给厂家": "WhatsApp the supplier",
  "WhatsApp 催货": "WhatsApp reminder",
  "讯息语言": "Message language",
  "讯息内容": "Message",
  "复制": "Copy",
  "📱 开 WhatsApp": "📱 Open WhatsApp",
  "已复制，可以贴到 WhatsApp。": "Copied — paste it into WhatsApp.",
  "复制不了：请长按讯息自己复制。": "Couldn't copy — long-press the message to copy it.",
  "讯息不含价格。按「开 WhatsApp」后自己选厂家的联络人；也可以先「复制」再贴上。讯息可以先改再送。":
    "The message has no prices. After \"Open WhatsApp\", pick the supplier's contact yourself — or \"Copy\" and paste it. You can edit the message before sending.",

  // 厂家问题页：厂家还欠、CS 工厂
  "厂家还欠": "Supplier still owes",
  "只看厂家还欠": "Only what the supplier still owes",
  "没有 CS 编号": "No CS number",
  "工厂": "Factory",
  "确认厂家 DO 时自动记：少发（所选 PO 还没出的 − 这批出货）、多发、发错型号、缺零件；坏货 / 破损、到货少点货时记或手动记。":
    "Logged automatically when a supplier DO is confirmed: short-shipped (still to ship on the chosen POs − this shipment), over-shipped, wrong models, missing parts; damaged and short-on-arrival are logged when receiving or by hand.",
  "要提醒厂家：「📱 WhatsApp 催货」（厂家还欠的）、勾选几笔发 WhatsApp，或下载 Excel / 打印（可存成 PDF），一个厂家一页。":
    "To chase a supplier: \"📱 WhatsApp a reminder\" (what they still owe), tick a few and WhatsApp them, or download Excel / print (can save as PDF), one supplier per page.",
  "搜厂家、CS 编号、型号、品名、零件、DO 号、PO 号…": "Search supplier, CS no., model, item, part, DO no., PO no.…",

  // 点货
  "放哪个仓位": "Put in location",
  "已点完货：这些问题之前已经记过，没有新增。": "Goods received: these issues were already logged — nothing new added.",
  "收到不是这张 DO 的型号（例：订白色收到黑色）：一种一行，搜我们的型号（会进仓库库存）或按「不是我们的产品」，填数量；知道本来应该是哪个型号就选。会记成「发错型号」给采购找厂家；备注会印在给厂家的清单 / 讯息上。":
    "Got a model that isn't on this DO (e.g. ordered white, got black): one row per model — search our model (it goes into stock) or tap \"Not our product\", enter the qty; pick what it should have been if you know. It's logged as a wrong model for Purchasing to take up with the supplier; the note is printed on the list / message to the supplier.",
  "备注（会给厂家看，例：外箱压坏、有拍照）": "Note (the supplier will see it, e.g. carton crushed, photo taken)",
  "每行的「＋ 备注」会带进厂家问题（到货少 / 坏货 / 多到），印在给厂家的清单与 WhatsApp 讯息上；只给自己人看的写在最下面的「整张备注」。":
    "Each row's \"+ Note\" goes into the supplier issue (short / damaged / extra) and is printed on the list and WhatsApp message to the supplier; put internal remarks in \"Note for the whole DO\" at the bottom.",
  "备注（会印在给厂家的清单 / 讯息上）": "Note (printed on the list / message to the supplier)",
  "整张备注（可空白，只给自己人看）": "Note for the whole DO (optional, internal only)",
  "开单时记的": "Logged by purchasing",
  "· 开单时记的": "· logged by purchasing",
  "（厂家写的型号）": "(the supplier's model)",
  "你点的数字跟下面的纪录不一样的话，用「＋ 记坏货 / 到货少 / 来错货」补记（会跟著调整进货待入 AutoCount）。":
    "If your count differs from the record below, add it with \"+ Damaged / short / wrong item\" (the goods-in lines are adjusted too).",
  "点完货之后补记：坏货 / 到货少会从还没输入 AutoCount 的进货扣掉；来错的货（我们的型号）会多一笔进货。补记的备注会印在给厂家的清单 / 讯息上。":
    "Added after receiving: damaged / short units are taken off the goods-in lines not yet keyed into AutoCount; a wrong item that is our model adds a goods-in line. The note is printed on the list / message to the supplier.",
  "这张已经点过货：这几件会从还没输入 AutoCount 的进货扣掉（已经输入的扣不到，要请仓库主管在 AutoCount 调整）。":
    "This DO has been received: these units are taken off the goods-in lines not yet keyed into AutoCount (lines already keyed in can't be changed here — ask the warehouse manager to adjust AutoCount).",
  "主要仓位": "the main location",
  "找不到我们的商品。AutoCount 今天才开的新型号要等隔天同步后才搜得到：请先联络开单部，不要急著选「不是我们的产品」（选了不会进库存）。":
    "None of our products match. Models created in AutoCount today only show up after the next day's sync: contact Billing first, and don't pick \"Not our product\" just for that (it won't go into stock).",
  "开进货单（GRN）": "Create GRN",
  "等开单部": "Waiting on Billing",
  "确认时多半已经发过": "probably already sent when confirmed",
  "点货后补记来错的货": "Wrong item logged after receiving",
  "确定后：这张 DO 算到货（各分店的「在路上」拿掉这张），下面的问题记进「厂家问题」给采购找厂家。点完不能撤回。":
    "After confirming: this DO counts as arrived (removed from every outlet's \"In transit\") and the issues below go to \"Supplier issues\" for Purchasing. This can't be undone.",
  "好货（和来错的我们的型号）马上算进仓库库存（查货、盘点的「应有」），开单部在 AutoCount 开好进货单（GRN）后按「已输入」。坏货不进库存。":
    "Good units (and wrong items that are our models) count in warehouse stock right away (Lookup, and \"expected\" in stock counts); Billing taps \"Keyed in\" after creating the GRN in AutoCount. Damaged units don't go into stock.",
  "都已经输入 AutoCount。": "All keyed into AutoCount.",
  "待开 GRN": "GRN to enter",
  "来错的货": "Wrong item",
  "到「待开进货单」输入 GRN →": "Enter the GRN under \"GRN to enter\" →",

  // 仓库：进货待入 AutoCount、待开进货单（开单部）
  "开单部": "Billing",
  "待开进货单": "GRN to enter",
  "进货": "Goods in",
  "未输入（搬动 / 进货）": "Not keyed in (moves / goods in)",
  "厂家到货 / PO": "Supplier delivery / PO",
  "点货后自动产生：货已经算进库存（查货、盘点的「应有」；点货时 AutoCount 就有进货单的不重复算）。开单部在 AutoCount 开进货单（GRN）后，在「待开进货单」填 GRN 号标已输入；不要当成搬动输入转仓单。按一批展开看明细。":
    "Created automatically after receiving: the goods already count in stock (Lookup, and \"expected\" in stock counts; units AutoCount already had a GRN for at receiving aren't counted twice). Billing enters the GRN number under \"GRN to enter\" after creating it in AutoCount — don't key these in as transfers. Open a batch to see its lines.",
  "PO / 分店": "PO / outlet",
  "取消进货": "Cancel goods in",
  "原因（必填，例：其实是样品、点货数错）": "Reason (required, e.g. it was a sample, miscounted)",
  "取消后这笔不算进库存，也不会出现在待开进货单（点货纪录不变）。只有点货记错才取消。":
    "Once cancelled this line no longer counts in stock and leaves \"GRN to enter\" (the receiving record stays). Only cancel if it was received in error.",
  "全部（含已取消）": "All (incl. cancelled)",
  "AutoCount 这张 PO 的这个型号已经全收：请先核对再开": "AutoCount has already fully received this model on this PO: check before creating a GRN",
  "仓库点完厂家的货，好货已经算进库存；请在 AutoCount 照这张清单开进货单（GRN），开好后填 GRN 号按「已输入」。":
    "The warehouse has received these supplier goods and the good units already count in stock. Create the Goods Received Note (GRN) in AutoCount from this list, then enter the GRN number and tap \"Keyed in\".",
  "标「AutoCount 可能已输入」「点货时 AutoCount 已经有」或「这张 PO 已经全收」的：请先在 AutoCount 核对，不要重复开；是的话直接按那一行的「标已输入」。":
    "Lines marked \"AutoCount may already have it\", \"AutoCount already had it at receiving\" or \"PO already fully received\": check AutoCount first and don't create a second GRN; if it's there, just tap \"Mark keyed in\" on that line.",
  "找型号、DO 号、厂家、PO、GRN 号…": "Find model, DO no., supplier, PO, GRN no.…",
  "没有待开的进货单。": "No GRNs to enter.",
  "AutoCount 进货单（GRN）号码": "AutoCount GRN number",
  "取消（点货记错）": "Cancel (received in error)",

  // 订货：PO 还没 ETA
  "只看还没 ETA（要问厂家）": "Only POs without an ETA (ask the supplier)",
  "中国货开单 30 天以上、本地货 7 天以上（120 天内），没填 ETA、没挂货柜，也还没有厂家到货：请问厂家什么时候出货，填进 PO 的 ETA。":
    "China POs open 30+ days and local POs 7+ days (within 120 days) with no ETA, no container and no supplier delivery yet: ask the supplier when it will ship and enter the PO's ETA.",

};

export const PATTERNS_SOP: [RegExp, (m: RegExpMatchArray, t: T) => string][] = [
  // SOP
  [/^第 (\d) 步：(.+)$/, (m, t) => `Step ${m[1]}: ${t(m[2])}`],
  [/^还有 (\d+) 个少发 \/ 缺零件要决定（厂家会补或取消）$/, (m) =>
    `${m[1]} short-shipped / missing part${m[1] === "1" ? "" : "s"} still to decide (supplier will send, or cancel)`],
  // 首页
  [/^(\d+) 张厂家到货草稿超过 24 小时还没确认$/, (m) =>
    `${m[1]} supplier delivery draft${m[1] === "1" ? "" : "s"} not confirmed after 24 hours`],
  [/^(\d+) 张 PO 还没 ETA，要问厂家$/, (m) => `${m[1]} PO${m[1] === "1" ? "" : "s"} without an ETA — ask the supplier`],
  [/^(\d+) 批厂家货待开进货单（GRN）$/, (m) => `${m[1]} supplier deliver${m[1] === "1" ? "y" : "ies"} waiting for a GRN`],
  [/^开单部还有 (\d+) 笔进货要在 AutoCount 开进货单（GRN）$/, (m) => `Billing still has ${m[1]} goods-in line${m[1] === "1" ? "" : "s"} to create a GRN for in AutoCount`],
  [/^开单部还有 (\d+) 笔进货要开 GRN$/, (m) => `Billing still has ${m[1]} goods-in line${m[1] === "1" ? "" : "s"} to create a GRN for`],
  [/^WhatsApp 催货 · (.+)$/, (m) => `WhatsApp reminder · ${m[1]}`],
  [/^WhatsApp 发给厂家 · (.+)$/, (m) => `WhatsApp to supplier · ${m[1]}`],
  [/^连同确认时的问题（(\d+) 笔）$/, (m) => `Include the ${m[1]} issue${m[1] === "1" ? "" : "s"} from confirmation`],
  // 要厂家怎么处理
  [/^要厂家：(.+)$/, (m, t) => `Ask supplier: ${t(m[1])}`],
  [/^· 要厂家：(.+)$/, (m, t) => `· ask supplier: ${t(m[1])}`],
  [/^· 进 (.+)$/, (m) => `· into ${m[1]}`],
  [/^(?:(\S+) )?缺「(.*)」$/, (m) => `${m[1] ? m[1] + " " : ""}missing "${m[2]}"`],
  // 开单画面
  [/^(.+) 备注$/, (m) => `${m[1]} note`],
  [/^(.+) 少发怎么处理$/, (m) => `${m[1]}: what to do about the shortage`],
  [/^问题备注 (.+)$/, (m) => `Issue note ${m[1]}`],
  [/^来错的型号（(\d+)）$/, (m) => `Wrong models (${m[1]})`],
  [/^缺零件 \/ 其他要补的（(\d+)）$/, (m) => `Missing parts / other items (${m[1]})`],
  [/^缺零件（(\d+)）$/, (m) => `Missing parts (${m[1]})`],
  [/^新记 ([\d.,]+)（其余之前已记过）$/, (m) => `${m[1]} newly logged (the rest was logged before)`],
  [/^先补厂家欠的 ([\d.,]+)$/, (m) => `${m[1]} first make up what the supplier owes`],
  [/^(.+) 就在所选的 PO 里：直接在上面的表格填出货数量就好，不用记成来错。$/, (m) =>
    `${m[1]} is on the chosen POs: just enter its shipped qty in the table above — no need to log it as wrong.`],
  [/^并进上面的 (.+)$/, (m) => `Merge into ${m[1]} above`],
  [/^这个型号在 (.+) 有订，要加选那张 PO 吗？$/, (m) => `This model is on order in ${m[1]} — add that PO?`],
  [/^来错的型号第 (\d+) 行：请从清单选我们的型号，或按「不是我们的产品」。$/, (m) =>
    `Wrong model row ${m[1]}: pick our model from the list, or tap "Not our product".`],
  [/^来错的型号第 (\d+) 行请填数量。$/, (m) => `Wrong model row ${m[1]}: enter the qty.`],
  [/^缺零件「(.*)」的数量不是数字。$/, (m) => `Missing part "${m[1]}": the qty isn't a number.`],
  [/^缺零件「(.*)」请填数量。$/, (m) => `Missing part "${m[1]}": enter the qty.`],
  [/^把「(.*)」并进 (.+)？(.+) 的出货会变成 ([\d.,]+)，这一行拿掉。$/, (m) =>
    `Merge "${m[1]}" into ${m[2]}? ${m[3]}'s shipped qty becomes ${m[4]} and this row is removed.`],
  [/^少发 (\d+) 个型号共 ([\d.,]+) 件（厂家会补 (\d+) \/ 取消 (\d+) \/ 未决定 (\d+)(?: \/ 已记过 (\d+))?）$/, (m) =>
    `Short-shipped: ${m[1]} model${m[1] === "1" ? "" : "s"}, ${m[2]} pcs (supplier will send ${m[3]} / cancel ${m[4]} / undecided ${m[5]}${m[6] ? ` / already logged ${m[6]}` : ""})`],
  [/^多发 (\d+) 个型号共 ([\d.,]+) 件$/, (m) => `Over-shipped: ${m[1]} model${m[1] === "1" ? "" : "s"}, ${m[2]} pcs`],
  [/^来错的型号 (\d+) 行$/, (m) => `Wrong models: ${m[1]} row${m[1] === "1" ? "" : "s"}`],
  [/^缺零件 (\d+) 项$/, (m) => `Missing parts: ${m[1]}`],
  [/^这批有 (\d+) 笔厂家问题：要告诉厂家吗？$/, (m) =>
    `This shipment has ${m[1]} supplier issue${m[1] === "1" ? "" : "s"} — tell the supplier?`],
  [/^这家还欠 (\d+) 项$/, (m) => `This supplier still owes ${m[1]} item${m[1] === "1" ? "" : "s"}`],
  [/^同一个工厂（(.+)）的 (\d+) 项排前面$/, (m) => `${m[2]} from the same factory (${m[1]}) listed first`],
  [/^还有 (\d+) 项$/, (m) => `${m[1]} more`],
  // 厂家问题页
  [/^厂家还欠 ([\d.,]+)$/, (m) => `supplier still owes ${m[1]}`],
  [/^少发 (\d+) 项共 ([\d.,]+) 件$/, (m) => `Short-shipped: ${m[1]} line${m[1] === "1" ? "" : "s"}, ${m[2]} pcs`],
  [/^(\d+) 笔少发 \/ 缺零件：厂家不补了，标为已处理。$/, (m) =>
    `${m[1]} short-shipped / missing part line${m[1] === "1" ? "" : "s"}: the supplier won't send them — marked resolved.`],
  // 点货
  [/^开单备注：([\s\S]+)$/, (m) => `Note from purchasing: ${m[1]}`],
  [/^来错的货第 (\d+) 行：请从清单选我们的型号，或按「不是我们的产品」。$/, (m) =>
    `Wrong items row ${m[1]}: pick our model from the list, or tap "Not our product".`],
  [/^来错的货第 (\d+) 行「不是我们的产品」请填品名。$/, (m) => `Wrong items row ${m[1]} ("Not our product"): enter the item name.`],
  [/^进货待入 AutoCount（(\d+)）$/, (m) => `Goods in, not yet in AutoCount (${m[1]})`],
  [/^进货待入 AutoCount（(\d+) 笔 · (\d+) 批厂家货）$/, (m) =>
    `Goods in, not yet in AutoCount (${m[1]} line${m[1] === "1" ? "" : "s"} · ${m[2]} deliver${m[2] === "1" ? "y" : "ies"})`],
  [/^· (\d+) 笔 · 共 ([\d.,]+) 件$/, (m) => `· ${m[1]} line${m[1] === "1" ? "" : "s"} · ${m[2]} pcs`],
  [/^待开 GRN (\d+)$/, (m) => `GRN to enter: ${m[1]}`],
  [/^点货时 AutoCount 已经有（GRN (.+)），没有重复算库存$/, (m) => `AutoCount already had it at receiving (GRN ${m[1]}) — not counted twice in stock`],
  [/^开单时记了来错的型号 (\d+) 行$/, (m) => `Purchasing logged ${m[1]} wrong-model row${m[1] === "1" ? "" : "s"}`],
  [/^开单时记的来错型号（(\d+) 行）已经带进下面：请照实际点到的数量改；是我们的型号会进仓库库存，没认出来的请选我们的型号或「不是我们的产品」；没收到就拿掉。$/, (m) =>
    `The ${m[1]} wrong-model row${m[1] === "1" ? "" : "s"} purchasing logged ${m[1] === "1" ? "is" : "are"} filled in below: change the qty to what you actually counted; our models go into stock; for unidentified ones pick our model or "Not our product"; remove any that didn't arrive.`],
  [/^开单时没认出来：(.+)。请选我们的型号，或按「不是我们的产品」；没收到就拿掉。$/, (m, t) =>
    `Not identified by purchasing: ${t(m[1])}. Pick our model or tap "Not our product"; remove it if it didn't arrive.`],
  [/^这 ([\d.,]+) 件已经输入 AutoCount（或点货时 AutoCount 就有），扣不到：请仓库主管在 AutoCount 调整库存（例：登记「报坏」）。$/, (m) =>
    `${m[1]} unit(s) were already keyed into AutoCount (or AutoCount already had them at receiving) and can't be taken off here: ask the warehouse manager to adjust AutoCount (e.g. log a "defect" move).`],
  [/^这张已经点过货：收到的我们的型号会多一笔进货待入 AutoCount（进 (.+)），开单部开 GRN。$/, (m, t) =>
    `This DO has been received: our model adds a goods-in line not yet in AutoCount (into ${t(m[1])}); Billing creates the GRN.`],
  // 资料库写进搬动备注的
  [/^取消：([\s\S]+)$/, (m) => `Cancelled: ${m[1]}`],
  [/^来错的货第 (\d+) 行：对不上开单时的那一行，请重新整理再点。$/, (m) =>
    `Wrong items row ${m[1]}: doesn't match the row purchasing logged — reload the page and try again.`],
  [/^来错的货第 (\d+) 行：开单时的同一行重复了。$/, (m) => `Wrong items row ${m[1]}: the same purchasing row appears twice.`],
  [/^没有这个仓位 (.+)。$/, (m) => `No such location ${m[1]}.`],
  [/^点货后补记坏货 ([\d.,]+)$/, (m) => `Damaged ${m[1]} logged after receiving`],
  [/^点货后补记到货少 ([\d.,]+)$/, (m) => `Short ${m[1]} logged after receiving`],
  [/^这些货已经算进仓库库存（查货、盘点的「应有」）；开单部在 AutoCount 开好进货单（GRN）后按「已输入」。还有 (\d+) 笔没输入。$/, (m) =>
    `These goods already count in warehouse stock (Lookup, and "expected" in stock counts); Billing taps "Keyed in" after creating the GRN in AutoCount. ${m[1]} not keyed in yet.`],
  // 仓库
  [/^点货 (.+)$/, (m) => `Received by ${m[1]}`],
  [/^给 (.+)$/, (m, t) => `for ${t(m[1])}`],
  [/^取消这 (\d+) 笔进货？取消后不算进库存，也不会出现在待开清单（点货纪录不变）。$/, (m) =>
    `Cancel ${m[1]} goods-in line${m[1] === "1" ? "" : "s"}? They'll no longer count in stock or show under "GRN to enter" (the receiving record stays).`],
  [/^已标已输入（(.+)）：(\d+) 笔。$/, (m) => `Marked keyed in (${m[1]}): ${m[2]} line${m[2] === "1" ? "" : "s"}.`],
  [/^已取消 (\d+) 笔。$/, (m) => `Cancelled ${m[1]} line${m[1] === "1" ? "" : "s"}.`],
  [/^(\d+) 笔待开$/, (m) => `${m[1]} to enter`],
  [/^AutoCount 可能已输入（GRN (.+)）：请核对，是的话按那一行的「标已输入」，不要重复开。$/, (m) =>
    `AutoCount may already have it (GRN ${m[1]}): check, and if so tap "Mark keyed in" on that line — don't create it twice.`],
  [/^AutoCount 可能已输入 ([\d.,]+) 件$/, (m) => `AutoCount may already have ${m[1]} pcs`],
  [/^点货时 AutoCount 已经有进货单（GRN (.+)）：没有重复算库存，请核对$/, (m) =>
    `AutoCount already had a GRN at receiving (GRN ${m[1]}): not counted twice in stock — please check`],
  [/^点货时 AutoCount 已经有进货单（GRN (.+)）：这几笔没有重复算库存，请核对后按那一行的「标已输入」。$/, (m) =>
    `AutoCount already had a GRN at receiving (GRN ${m[1]}): these lines aren't counted twice in stock — check, then tap "Mark keyed in" on that line.`],
  [/^(\d+) 笔的 PO 在 AutoCount 已经全收：请先核对再开，不要重复进货。$/, (m) =>
    `${m[1]} line${m[1] === "1" ? "'s PO is" : "s' POs are"} already fully received in AutoCount: check before creating a GRN — don't receive twice.`],
  [/^标已输入（(.+)）$/, (m) => `Mark keyed in (${m[1]})`],
];
