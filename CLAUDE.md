# HomeWorks 营运系统 — 给接手这个仓库的 Claude

这是 HomeWorks（Hemos 卫浴 / 门锁品牌，马来西亚）的营运系统，分支
`claude/monthly-data-prep-vtcnct`。使用者 Leslie 不写程式；你是开发者，
他是决策者与「手」。**用中文回覆。**

## 这台电脑是什么

若你在 Windows 上跑，这台很可能就是办公室里连得到 AutoCount 的机器。
AutoCount 2.2 Basic（64-bit）。数据库在 `SERVER\A2006`，三个账套：
`AED_HOMEWORKS`（HOMEWORKS SDN. BHD.，**报表用这个**）、`AED_HOMESOLUTIONS`、
`AED_HOMEGUARD`（HOMEGUARD SDN. BHD.，卖货给 HomeWorks 的公司）。
从客户端连需要 sa 密码；在 SERVER 本机跑 Windows 验证可通。
渠道靠客户账号（Debtor Code）分辨；订单逐笔含 SKU。
**已确认**：报表的「Southern」渠道 = 卖给 HOMEWORKS (SOUTHERN) SDN BHD（JB 分公司；
HOMEGUARD 账套内是 300-H002，HOMEWORKS 账套内的代号待 discovery）。

已从 discovery 确认的结构（AED_HOMEGUARD，三个账套结构相同）：单据表两字母命名
`IV`/`CS`/`CN`/`DO`/`SO`/`GR` + `DTL` 明细；`Item.ItemGroup`（nvarchar 8）、
品牌在 `Item.ItemType`（HEMOS / HOMEGUARD / TENON；`ItemBrand` 是空的）；库存流水
`StockDTL`（ItemCode/UOM/Location/Qty），仓库 HQ / JB / PRE (JB)；`ItemUOM.ReOLevel`
安全库存；`Debtor.AccNo`/`CompanyName`/`DebtorType`；`DODTL`/`SODTL`/`IVDTL` 都有
`TransferedQty`（已转出数量）。AED_HOMEWORKSSB 的 discovery（2026-09-24）已取得并填入 `autocount.example.json` / `config.json`：
渠道 Debtor Code（Shopee 300-S001/300-0004/3000-S009、Lazada = ECART 300-E001、
Tiktok 3000-T003、Cash 300-C001、Online 3000-C009、Southern 3000-H008、Shopify 3000-S011、
其余 = 水工）；ItemGroup 19 个值 → `config.json` 的 `category_map`；品牌 `ItemType` 为
HEMOS / HEMOSX；Referral = 客户 3000-C010「CASH (REFERRAL)」（已填入 referral）。
AED_HOMEWORKSSB 独有：仓库 HQ / SRGADING / JB / TP STORE / PRE (JB) / DEFECTS / DISPLAY /
EGO / JB RESER；`IV.UDF_ChannelId` / `IV.UDF_OrderId`（平台同步写入，可作渠道第二来源）、
`Item.UDF_SKU`（平台 SKU）；`TD_SG_*` 是 SiteGiant 同步表。有 `DN`/`DNDTL`（销售借项单，
很少用，多为冲销错开的 CN）→ 销售 = IV + CS − CN + DN，与 AutoCount 自家报表口径一致。
明细行 `AccNo` 可分辨收入科目（5000/5001/5100 = 销售）与手续费科目（6150 = 手续费）。

## 报表口径：以 AutoCount 为准（使用者 2026-09-25 决定）

**不再对纸本调数。** 纸本报表是员工手抄的快照，AutoCount 才是现况；抓出来多少就报多少。
手抄纸本的对照值已移到 `docs/paper_2026/`（只留历史，不进 ZIP）；`data/20*.json` 与
`output/` 不再进 git，SERVER 上的都是 AutoCount 抓取值，覆盖 ZIP 不会再冲掉它们。
初次安装或要重抓：`setup_bi.bat` / `backfill.bat`（`scripts/backfill.py`，逐月呼叫 run_monthly）。以下是 2026-09-24/25 对账时查清的事实，留给以后判断差异用：
- **未分类**（`(未分类)` 列）= 开单时没选商品代号的自由输入行（例：HEMOS BASIN CABINET
  C/W MIRROR BOX、HM-UB001 石盆、PROMOTION FILTER），8 月 25 行、RM 13,411.51，多为 Cash /
  水工。照实单独列出；要归类得请员工在 AutoCount 建商品代号（不是程式的事）。
- **STOCK A** 群组：8 月 123 件、金额 0，照实列（category_map 可设 null 拿掉）。
- **借项单 DN** 已并入销售口径（IV + CS − CN + DN），与 AutoCount 自家报表一致。
- **ONLINE（平台手续费）**：Shopee 每周一笔 ONLINE000002 汇总（每笔 −28k～−35k），8 月共
  −179,761；纸本印时只到 −108,729，因为最后两周还没过账。差异来自快照时间，不是程式。
- **Top 10**：只算 StockControl='T'、排除 `top10_exclude_groups`、用 `model_code_pattern`
  从 Description 抽型号合并、只看 Shopee + Lazada 销量排名。纸本 Top 10 的数字不是从
  AutoCount 来的，不必对。
- Shopee 还有一个客户 3000-S016「SHOPEE SINGAPORE (DIRECT)」（2026-09 出现），已加进 shopee。
对账工具：`diag.bat` → `scripts/autocount_diag.py`（[1] 渠道×单据、[3b] 未分类逐行、
[3c] 汇总原始行、[4b] 水工客户全清单、[6] 平台销量前 30 含型号）；Excel 说明页与 JSON 的
`_产生方式` 都印 `VERSION`，用来确认 SERVER 跑的是最新版。

## HomeWorks BI（Supabase）— 使用者另有一套 AutoCount → Supabase 的 BI 管线

Supabase 专案 `vwljnypzgfqhatkgulqs`（ap-southeast-1，https://vwljnypzgfqhatkgulqs.supabase.co）。
它的管线**不在 GitHub**（可能在 SERVER 本机），每天 04:05 UTC 以 Postgres 角色 `bi_sync` 同步：
`bi.fact_sales`（IV/CS/CN 明细，company = HOMEWORKSSB / HOMEWORKSSOUTHERN）、`dim_item`
（item_group / item_type）、`dim_customer`、`fact_stock`、AR/AP/GL/采购等；前端读 `public.bi_*`
视图（security_invoker + RLS：`bi_is_allowed()` 看 `bi.allowed_users`，`bi_company()` 限公司）。
**2026-10-15 起 BI 只开放给老板与店长**（另一个对话套的 migration `bi_owner_manager_only`：`bi_is_allowed` / `bi_role` / `bi_company` / `bi_me` 只认
role owner / manager，`bi_can_write` 只认 owner）；营运系统的顾客资料页走 `bi.crm_require`，不受影响。
渠道函数 `bi.sale_channel(debtor, type)` 与本专案的 channel_rules 口径不同（它把 Shopee SG /
NEST / CASH(ONLINE) 归「其他平台」，CASH(REFERRAL) 归门市现金）。
2026-09-25 核对 8 月：BI 的 CS、CN 与本专案分毫不差；IV 少 13,424.50 = 没商品代号的自由
输入行被它丢掉；BI 没抓 DN。
**接法（2026-09-25 建）**：本专案每月产生报表后，用 service_role 呼叫
`public.bi_report_upsert(company, month, doc)`（PostgREST `/rest/v1/rpc/`），落到
`bi.report_month` / `_category` / `_channel` / `_sku` / `_top10`（RLS 与其他 bi 表相同，
`bi_sync` 也可写），前端读 `public.bi_report_month_*`。金钥放 `autocount.json` 的 `supabase`
段（setup 会保留），用 `setup_bi.bat` 贴入。Migration：`monthly_report_tables`、`monthly_report_service_role_read`
（service_role 要能读 bi.report_month_* 才能过 `--check`）。新式 `sb_secret_` 金钥只放 apikey 标头。
**MCP 里有 Supabase 工具**（`mcp__Supabase__*`），可直接查表、建 migration；DDL 用
apply_migration，不要用 execute_sql。
**BI 网页**：Vercel 专案 `homeworks-bi`（team leslie-tee，Vite + React，非 git 部署），
2026-09-26 已加「电商月报」分页读 `bi_report_month_*`；改法与部署步骤见 `docs/bi_web/README.md`
（MCP `mcp__Vercel__*` 可读档案树、内容与建立部署；list_deployments 会 403，用 get_project 拿
latestDeployment）。

## HomeWorks 营运系统（员工各部门用，`portal/`）— 2026-09-26 起

使用者要把 UK Software 提案图上的「HomeWorks AI Program」自己做出来：一个入口给各部门员工用
（任务、审批、订货/ETA、仓库、送货、收款、佣金、HR、薪资、报表），之后再过账回 AutoCount。
**决定（2026-09-26）**：放在 Vercel（新专案 `homeworks-ops`，与 BI 的 `homeworks-bi` 分开）+ 同一个
Supabase 专案，员工在外面、在仓库用手机都能开；SERVER 上的 FastAPI 营运入口维持办公室内即时查 AutoCount。
- 资料在 schema `ops`（不开放给 PostgREST），前端只呼叫 `public.ops_*`（security definer，开头检查身分与模块权限）。
- 员工名单 `ops.staff` 与 `bi.allowed_users` **分开**：BI 的 `bi_is_allowed()` 只看有没有在名单，
  若把仓库/HR 员工加进 BI 名单，他们会看到财务数据。第一批 ops 名单从 BI 名单带入（owner → admin）。
- 权限：部门预设 `ops.dept_module` + 个人例外 `ops.staff_module`；四级 none/view/edit/approve；
  manager 自动把 edit 升 approve；分店 HOMEWORKSSB / HOMEWORKSSOUTHERN / ALL。
- **权限判断函数一律 `coalesce(..., false)`**：NULL 栏位（没指派人/审批人）会让 `not (...)` 变 NULL 而放行，
  本机测试抓到过一次。
- 开账号 / 重设密码：Edge Function `ops-account`（service role 只在函数里）。
- 测试：`portal/supabase/tests/run.sh`（本机 PostgreSQL，stub 掉 auth 与 bi）；前端 `npm run build`。
- 部署：非 git，Vercel MCP `create_deployment` 内嵌原始码（见 `portal/README.md`）。
- 已上线（第 1 阶段 · 地基）：首页、任务、审批、员工与权限。其余模块显示「规划中」。
- 已上线（第 2 阶段 · 订货与 ETA，2026-09-28）：`ops.po_track`（每张 PO 的状态 / ETA / 备注，key = company+po_no）、
  `ops.shipment`（货柜，一柜多张 PO）；视图 `ops.v_po_open(_line)` 读 `bi.fact_po_line`。有效 ETA = 货柜 > 采购填写 >
  AutoCount 预计交货日（晚于开单日才算）> 开单日 + 供应商交期（与 BI `bi_po_open` 同规则）。120 天以上且没人跟进的旧单
  预设隐藏（总部有 ~120 张多年没结的本地 PO）；可标「关闭」。只有订货「可编辑」看得到单价 / 金额。中国货（CSxxx 供应商）
  在 AutoCount 多数没有单价，金额为 0 是正常的。
- 已上线（打卡 + 补卡，2026-10-01，移植自使用者朋友给的 AttendX 白牌 HR 系统，规则见 AttendX docs/FEATURES-AND-RULES.md §2–3）：
  模块 `attendance`（所有部门「可编辑」= 打自己的卡；主管升「可审批」= 审自己部门补卡、看团队）；HR 设定要 `hr` ≥ 可编辑。
  `ops.attendance`（一人一天一笔：上班 / 午休 / 下班 + 自拍路径 + GPS）、`ops.punch_correction`（**只有 HR 审**，一层定案；使用者 2026-10-03 决定，migration `ops_att_hr_only`；直属主管只看得到团队出勤）、
  `ops.geofence`（打卡点，按分店）、`ops.hr_shift`（班别；2026-10-02 起 HomeWorks 实际时间 = 星期一到六 09:00–17:30、星期日休，migration `ops_att_hours`；**午休不定时段、一次一小时**（`ops_att_flex_lunch`：迟回 = 实际休息超过 lunch_end − lunch_start 的分钟数；星期五也一样一小时，`ops_att_no_friday` 拿掉了 AttendX 的星期五礼拜加时（friday_prayer 栏位保留但不用）；lunch_start 只当外出公务补卡的名义时间；打卡页有「午休下班」「午休上班」按键（`ops_att_lunch_buttons`，punch 动作 lunch_out / lunch_in；午休中不能直接下班），旧的「下班卡在 10:30–16:00 之间再打上班 = 吃饭回来」仍保留；整天的星期六也有午休）。「每月指定星期六」功能保留但没有班别使用，设定页自动隐藏）、
  `ops.holiday`、`ops.work_saturday`、`ops.field_checkin`；`ops.staff` 加 manager_id / shift / geofence_exempt / friday_prayer / join_date。
  自拍放 Storage 私有 bucket `ops-hr`（路径 `<staff_id>/…`，policy 呼叫 `public.ops_hr_file_ok`），前端压到 480px JPEG 约 30 KB。
  时间一律 Asia/Kuala_Lumpur；测试用 `ops.fake_now`（只在有 `ops_test_marker` schema 的本机测试库生效）。
  测试：`portal/supabase/tests/att_test.sql`（run.sh 会接著 ops_test.sql 跑）。「HR」= 对 `hr` 模块可审批的人（管理层预设有）。
  AttendX 原始码只在对话上传的 zip 里，没有放进 repo；之后的请假、加班、薪资照同样方式逐模块搬。
  **注意**：组织是 **Pro 方案**（2026-10-09 使用者截图：Infrastructure 页 org 标 PRO、磁碟 2 GB 会自动扩到 8 GB、运算 Nano；
  旧说法「免费方案上限 500 MB」不对）。运算 2026-10-09 08:24 UTC 由使用者从 Nano 换成 **Micro**（1 GB 记忆体，Pro 方案 Compute Credits 涵盖、
  不另收费；重启后 quote_push 08:30 同步正常、Postgres 日志无错误）。资料库 518 MB（2026-10-09，主要是 BI 资料），照片放 Storage 不占资料库。
- 已上线（请假，2026-10-03，参考 AttendX §7 简化）：模块 `leave`（所有部门可编辑 = 自己申请）+ `hr`「人事」页上线（请假审核 /
  纪录 / 假期余额 / 假别设定；打卡设定仍在打卡页）。`ops.leave_type`（年假、病假按劳工法 s.60E/60F 与年资：8/12/16、14/18/22，
  到职那年年假按月比例；住院 60、产假 98 日历天限女、陪产假 7 日历天限男且满 12 个月、婚假 3、丧假每次 3 日历天、无薪不设余额；
  HR 可改天数 / 半天 / 附件 / 启用）、`ops.leave_adjust`（结转、上线前已休，可正可负，要写原因）、`ops.leave_request`
  （full/am/pm；不能跨年；天数依员工班表算上班日，日历天假别算日历天；审核中也扣余额；批准时再查一次余额）。
  **只有 HR 批**（`ops.leave_can_decide` = att_is_hr、不能批自己）；员工可撤回审核中的、或开始前撤回已批的；已开始的只有 HR 能取消。
  打卡联动：`ops.att_stats` 回传 `leave`，整天假不算缺勤 / 迟到 / 早退，上午半天不算迟到、下午半天不算早退；月报加「请假」天数。
  `ops.staff.gender`（HR 在打卡设定填）。没填到职日 = 当第一年且不按比例。测试 `portal/supabase/tests/leave_test.sql`。
- 已上线（仓库第一版，2026-10-04；使用者决定先做仓库再做加班 / 薪资）：问题是「进货点得清、几个星期后就不准」、半年盘一次（5 人 3 天），
  系统里 HOMEWORKSSB 有 1,296 个 SKU×仓位库存为负数 → 漏记的是货进来后的搬动，所以**先做条码 + 流程，不上 RFID**（使用者问过 RFID，
  建议之后在 SRGADING 大货小规模试）。模块 `warehouse`（仓库部可编辑 = 盘点 / 登记搬动；主管、管理层可审批 = 标已输入、审差异；**库存成本 2026-10-16 起只给老板**，见下面「成本只给老板」）。
  `ops.wh_location`（从 bi.fact_stock 带入的仓位；要不要盘、每天几件）、`ops.wh_barcode`（纸箱原条码 → 商品）、`ops.wh_move`
  （调仓 / 报坏 / 展示 / 样品 / 退货 / 报废，pending → 负责人在 AutoCount 开单后标 done）、`ops.wh_count`（盲盘；应有 = AutoCount 库存
  + 还没输入的搬动；不符先请再数，第二次才算差异；审核 adjusted / ignored / 重盘）。每日清单：负库存 → 90 天销量 → 库存值，30 天内盘过跳过。
  **对 AutoCount 仍只读**：搬动、差异都是清单，员工手动在 AutoCount 输入。条码 = 商品代号的 Code 128（`src/wh/code128.ts`，已用 ZXing
  解码验证）；扫码：Android 用 BarcodeDetector，iPhone 动态载入 `@zxing/browser`；蓝牙扫描枪当键盘用。库存同步每天 09/12/15/18 点（KL）。
  测试 `portal/supabase/tests/wh_test.sql`。第二版待做：出货拣货扫码（要即时的订单资料）、进货对 PO 点收。
- 已上线（薪资，2026-10-04；把 HR 原本的独立薪资网页搬进来，原站 homeworks-payroll.vercel.app 先并行一个月）：模块 `payroll`
  **只有 hr 与 mgmt 部门**（migration `ops_payroll` 删掉其他部门的 dept_module）；员工在首页「我的工资单」（`#/mypay`，`ops_pay_my`）只看 HR 已发布的自己的单。
  计算 `src/payroll/calc.ts` 逐字移植原系统（EPF 第三附表、SOCSO 第 4 类 + SKBBK、EIS、加班 = 底薪 ÷ 工作天 ÷ 8 × 1.5、迟到每 3 次扣半天、
  迟到 ≥ 5 次团体佣金归零、包错货 RM10、不够扣记结欠）；`node scripts/payroll_parity.mjs <原 index.html>` 与原系统随机比对（10 万组 0 差异；
  原 HTML 不在 repo，含员工资料的 payroll-docs 也不要放进 repo）。计算在前端，结果连 inputs 存 `ops.pay_record`（staff+年+月+base/comm 唯一；
  改了就退回草稿）；`ops.pay_profile` 每人薪资资料、`ops.pay_setting` 参数。`ops.pay_att` 从打卡 / 请假带入：迟到次数 = 上班迟到 + 午休迟回天数，
  无薪假天数；缺勤（没打卡没请假）只显示、不自动扣（使用者决定）。加班时数先手填，等加班模块。不搬旧资料。测试 `portal/supabase/tests/pay_test.sql`。
  **正式环境分段套用**：`ops_payroll`（表）/ `_fn1` / `_fn2` / `_ready`。Supabase MCP 会把含 `delete` 的 migration 挡下（status cancelled），
  所以 `20261005_ops_payroll_delete.sql`（拿掉财务部的薪资权限 + HR 删单笔记录 `ops_pay_delete`）**还没套**；套好后把 `payroll/History.tsx` 的 `CAN_DELETE` 改 true。
  **手动计算**分页（`payroll/Manual.tsx`，2026-10-05 发薪前一天加）：员工没开账号 / 没打卡时 HR 用；名单与数字只存在浏览器 localStorage
  `hw-pay-manual`（不进资料库，有下载 / 载入备份 JSON），计算同样用 calc.ts，迟到与无薪假手填。
- 优化（2026-10-07，使用者选的）：migration `ops_todo_aged`（正式环境已套）。首页「今天要做」清单（`ops_home` 加 `po_arriving` 3 天内到货、
  `hr_gaps`、`holidays_ahead`）；人事「资料缺漏」分页（`ops_hr_gaps`：没填到职日 / 性别 / 手机 / 薪资资料、分店没打卡点、60 天内没假日）；
  仓库「旧货」分页（`ops.wh_aged_rows` 读 `bi.fact_item_aging` + `bi.mv_sales_item_month`；① 入货 > 12 个月 ② 12 个月没卖 ③ 两者；
  `ops.wh_aged_action` 记处理方式 / 负责人，仓库「可审批」才能填；成本只给老板）；盘点页可打品名搜寻；打卡设定「一键带入公共假日」
  （`att/HolidayImport.tsx` 内建 2026–2027 全国 + 柔佛名单，伊斯兰历 / 农历标「预计」，HR 勾选后才存）；员工与权限「从 Excel 一次开账号」
  （`pages/BulkStaff.tsx`，贴上 Excel 区块 → ops_staff_save → ops_att_staff_set → ops-account，不用新函数）。测试 `tests/todo_test.sql`。
- 员工自己申请加入（2026-10-08，使用者选「自己申请、你批准」）：migration `ops_join` + `ops_join_v2`（正式环境都已套）+ Edge Function
  `ops-join` v2（verify_jwt=false，靠邀请码；管理员动作用呼叫者 token 叫 RPC 验身分）。管理员在「员工与权限 → 加入申请」复制 / WhatsApp 分享
  `#/join?c=<12 码邀请码>`，可暂停或换新码（打开链接就先检查码）。员工不用登入填名字、email、自己的密码、手机、性别、到职日。
  **送出时不建账号**（第一版 email_confirm=true 当场建，程式审查抓到：拿到链接的人可用别人的 email 先占账号）：函数把密码做成 bcrypt 杂凑
  存 `join_request.pw_hash`，**批准时**（`ops-join` action decide → `ops_join_decide` → `ops_join_pw`）才用 `password_hash` 建账号，
  拒绝 = 清掉杂凑。email 已有登入账号（BI 用户）→ 先用他输入的密码 signInWithPassword 验证才收，不存杂凑、不改密码；没账号但在
  `bi.allowed_users` 的不收。同一 email 有待审申请不收（不覆盖）；同 IP 一小时 5 张。批准时已在名单：在职 = 连上（不动部门权限）、停用 = 复职。
  建账号失败在「最近处理过」可按「再试一次」（action account）。管理员批准前要确认是本人（画面有提示）。首页 `join_pending`。测试 `tests/join_test.sql`。
- **中英双语（2026-09-28）**：`portal/src/i18n*.ts` 是 DOM 翻译层，切到 EN 时 MutationObserver 只把「整段完全等于」
  字典键（去头尾空白）或符合 `i18n-patterns.ts` 格式的文字节点 / placeholder / title 换成英文，员工输入的资料不动。
  **新增介面文字一定要把中文原句加进 `i18n-dict-*.ts`**（带数字 / 名称的句子加 pattern；数据库错误讯息放 `i18n-dict-db.ts`），
  否则英文模式会漏翻。语言存 localStorage `hw-lang`，切换会重新载入。
- 送货（模块 key `delivery`；原名「送货安装」，使用者 2026-10-08：「只要送货，没有安装」→ 20261008c 一并把名称改成「送货」）（2026-10-08，使用者：「把送货功能跟员工多部门功能连在一起，不要分成两个地方」）：把 BI 顾客资料页里的送货排单 +
  司机签收拍照搬进来（另一个 Claude 对话在 BI 分支 `claude/pensive-fermi-gtqw9c` 做的，以 ZIP 交过来）。**资料不搬家**：DO（SERVER 的
  `quote_push.py` 每 15 分钟只读推 AutoCount DO，含 Deliver Address、全部明细、Remark1～4）、地址、备注、排单、签收都在 `bi.delivery_*`，
  这里加一层 `public.ops_dlv_*`（migration `20261008b_ops_delivery.sql`，**正式环境已套**，分三次：`ops_delivery` + 多人审查后的 `ops_delivery_review_fixes` + `ops_delivery_fixes2`，合起来 = 这个档；另外 BI 的 `bi_driver_run` 每站多回传 `geo`，migration `driver_run_geo`）改用 ops 权限：只看（销售）=
  查 DO / 看纪录；可编辑（送货、仓库）= 排单、改这张 DO 的地址 / 给司机的备注、存坐标；可审批 = 出发点、外包司机。分店照 `sees_company`。
  司机 = 送货部 / 物流部有手机号的在职员工（`ops.dlv_driver_dept`；`driver_staff_id`，登入后在「我的送货」签收）+ 外包司机 `bi.delivery_driver`（用 WhatsApp 里的连结
  `#/driver?t=<代码>`，不用登入，3 天有效；App.tsx 在登入前处理）。签收沿用 BI 的 anon 函数 `bi_driver_run` / `bi_driver_pod` 与私有 bucket
  `delivery-pod`；营运员工看照片靠 policy「delivery-pod ops read」（`ops_dlv_photo_ok`）。**照片路径 = `<连结代码>/…`，拿到路径就能用 anon 的 `bi_driver_pod` 假签收**，所以路径与照片跟连结代码同规则（`ops.dlv_full_access`）：可编辑、这趟的司机，或连结已过期；只看的人只拿 `photo_count`。查 DO 的函数不回 `note`（顾客资料内部备注）/ `amount` / `sales_agent` / `debtor_code`。首页计数以「同一天同一门市的站」算（`ops.dlv_stop_signed`），重复排的单不重复算；前端再按一次 WhatsApp 沿用同一个连结、不另存。`i18n.ts` 多了 `translate="no"`（司机签收页自带三语）。前端 `src/pages/Delivery.tsx`、`src/dlv/*`、
  `src/dlv-api.ts`、`src/dlv.css`、`src/i18n-dict-dlv.ts`；首页卡片 `dlv/HomeCard.tsx`（`ops_dlv_home`）。司机签收页自带中 / 英 / 马来文、不进字典。
  **已上线（2026-10-08）**：前端部署 `dpl_82vXLYdAsviB5ddPSYhMEwp7EQNf` READY 之后才套模块开关 `20261008c_ops_delivery_ready.sql`
  （= `ops_delivery_ready`，`ops.module.ready = true` + 名称「送货」）。合并后审查的修正：外包司机 store 为 NULL = 两间分店共用，只有分店 ALL
  的人能改（migration `20261008e_ops_dlv_driver_shared.sql` = `ops_dlv_driver_shared`，已套）；排路线 / 一键排单 / 传送中不能再查询或加站；
  存排单断线重按沿用同一个连结（`pending` ref，`duplicate key` 当成功）；OSM 标示 `OSM_CREDIT`；找不到的地址本次开网页不重问（`geoMiss`）。
  测试 `tests/dlv_test.sql`（BI 送货表的 stub 在 `stub_supabase.sql` 最后）。BI 那边的旧送货页（`/delivery.html`、`/driver.html`）先留着，
  两边资料相通；要不要关掉由使用者决定（BI 的 sales 角色在旧页仍拿得到签收连结，是 BI 原本的行为）。JB 没有 DO 资料 = JB 那台电脑没跑 `quote_push.py`。
  物流部排单（2026-10-08，部署 `dpl_AtyAWUqGApCCqQxVeVF4r2tB2Qdw`）：司机兼排单的人点「送货」只在今天真的有站要送（`ops_dlv_home.my_stops_left`，
  与 `ops_dlv_meta` 同时载入）才先开「我的送货」，不然开「排单」；可编辑的人看不到「设定」，提示改成请主管或管理层设定出发点 / 外包司机；
  换分店会清空排到一半的单，先 confirm。**出发点 HQ / JB 正式环境都还没设**（`bi.customer_settings.depot` 是空的），要可审批的人在「送货 → 设定」设一次。
  要让某位物流部同事管司机 / 出发点：给他个人例外「送货 = 可审批」，不要整个升主管（主管会把仓库、打卡等所有可编辑模块都升可审批）。
- **PostgREST「JWT issued at future」（PGRST303）**（2026-10-08）：PostgREST 闲置后偶尔把刚签发的 token 判成未来时间，回 401；
  同一个 token 几毫秒前才通过，不是员工装置时钟。这个 401 在执行 SQL 之前就挡下，所以 `portal/src/supabase.ts` 的 `global.fetch`
  与 Edge Function `ops-account` v5 / `ops-join` v3 的 `fetchRetry` 都对它等 1.5 秒重送一次（只限 /rest/v1/、文字 body）。
  **根治**：专案跑 PostgREST 14.5（`pg_stat_activity.application_name`），上游在 14.18（2026-09-10，#5196「Fix sporadic PGRST303」）修好。
  只能由使用者在 Supabase Dashboard → Project Settings → Infrastructure 按「Upgrade project」（in-place，会停机几分钟；MCP 没有升级工具，
  不要用 pause/restore：会停更久，且自订角色密码不会还原）。事前已查：唯一自订登入角色 `bi_sync` 密码已是 scram-sha-256（升级不会让它登不进去），
  没有 replication slot。避开 04:05 UTC（12:05 KL）BI 同步与上班打卡时间。升好后验证：application_name ≥ PostgREST 14.18、
  `bi.delivery_*` / BI 同步时间照常更新、首页与打卡能用。没提供升级或版本仍 < 14.18 → 开 Supabase 支援单引用 PostgREST #5196。
  2026-10-09 使用者截图确认：Infrastructure 页**没有** Service Versions / Upgrade project（= 目前没有可升级版本）→ 已给使用者英文支援单范本，等 Supabase 回覆。
  BI 网页没有这个重送，遇到时重新整理即可。
- 顾客资料（模块 key `customers`，2026-10-14，使用者：「我要把这个系统连接在员工多部门里面」→ 选「顾客资料」+「照部门权限」；另一个 Claude 对话在 BI 分支
  `claude/pensive-fermi-gtqw9c` 做的，以 ZIP 交过来，交接说明在那边 `docs/ops_customers/HANDOFF.md`）：把 BI 的顾客资料页（`/loyalty.html`）整页搬进来，
  `#/customers/<分页>`（跟进 / 顾客 / 促销活动 / 报告 / 设定），一位顾客 `#/customers/c/<顾客编号>`。**资料不搬家**：前端直接叫 BI 原本的
  `bi_customer*` / `bi_campaign*` / `bi_wa_template*`（`bi.customer_*` 表，两边同一份）。migration `20261016_ops_customers.sql`（= `ops_customers`，
  **正式环境 2026-10-14 已套**，23 个函数改写、只看名单 11 个）把这些函数开头的 `bi.customer_require` 换成 `bi.crm_require`：BI 名单照旧；营运系统员工看
  「顾客资料」模块权限（admin = owner：分级门槛、删活动；可审批 = manager：汇出同意名单 CSV、合并顾客、促销活动、WhatsApp 范本；可编辑 = sales：改资料、
  快速登记、联络、装修进度；只看 = 只能叫 migration 里 `v_read` 名单的读取函数）；**模块 `ready = false` 时营运系统员工一律没有**（`bi.crm_ops_role`），
  前端部署 READY 后才套 `20261016b_ops_customers_ready.sql`（= `ops_customers_ready`）。部门预设：销售 / 门市 = 可编辑、管理层 = 可审批，其他部门没有
  （送货部在「送货」看得到 DO 的顾客名字 / 电话 / 地址）；只看要用个人例外开。`public.bi_company()` 换成 `bi.crm_company()`（营运系统员工照自己的分店，
  只有「没抓到电话的单据」用到；顾客名单本来就是总部 + JB 合并）。送货的 `bi_delivery_*` 与 BI 送货页的 `bi_customer_set_address` / `_set_geo` 不动。
  前端 `src/pages/Customers.tsx`、`src/cust/*`、`src/cust-api.ts`、`src/cust.css`；**这页自己带中英文**（整页 `translate="no"`，`t()` 查 `src/cust/dict.ts`，
  大多照抄 BI 的英文字典；字典没有的退回营运系统字典 = 资料库错误讯息），新增这页的文字加进 `cust/dict.ts`。角色从 `ops_cust_role()` 拿（只决定按键，
  真正的检查在每个函数）。测试 `tests/cust_test.sql`（BI 权限函数与几个代表性顾客资料函数的 stub 在 `stub_supabase.sql` 最后）。BI 的 `/loyalty.html`
  先留着，两边相通。BI 那边以后改顾客资料函数要写 `bi.crm_require` / `bi.crm_company`（已写进 BI 分支的 CLAUDE.md）；重套 `20261016_ops_customers.sql`
  会把漏掉的改过来。
  **已上线（2026-10-15）**：前端部署 `dpl_HzebzMKPc348FPaFCqXSErTuud59` READY（122 个档全用 sha 参照）之后套了 `ops_customers_ready`。正式环境核对（交易回滚）：
  admin = owner、管理层主管 = manager、销售 = sales（只在营运系统、不在 BI 名单的门市员工看得到 8,064 位顾客、「没抓到电话的单据」只有总部 23 张）；
  送货 / 物流 / 采购 / 仓库 模块等级 none、叫顾客资料函数被挡（「你没有「顾客资料」模块的查看权限」）；`bi.crm_*` 与 `ops_cust_role` 的 md5 与本机一致。
  合并后另外审查（模拟资料截图 + 程式 / 安全审查）修了：**CSV 公式注入**（`cust-api.ts` `csvCell`：= + - @ Tab CR 开头的格子前面加 '，纯数字照原样；
  地址可由公开扫码登记页写入）、汇出的生日拆成生日月 / 生日日（Excel 会把 3/12 转成日期）、英文模式业务员「(空白)」、名单类型栏 / 门市 / 买过类别栏宽、
  报告选中月份加左边粗线。没修（之后再说）：手机 / 平板上表格要横向卷、英文的长标题与下拉选单被截、数字栏标题靠左。
  **第二版（2026-10-15，BI 分支 `docs/ops_customers/HANDOFF_v2.md`）**：使用者问「还可以怎么让我更能锁住老顾客？」→ 选新客 30 天回访、首页「今天要跟进」
  + 员工排行、登记送延长保修。migration `20261018_ops_customers_v2.sql`（正式环境已套 = `ops_customers_v2` + `_new_order` + `_registers_no_address`；里面
  `bi_customer_merge` 那段含删除语句，连接器会卡在确认，由使用者在 Supabase SQL Editor 套）：跟进提醒改在资料库算 `bi_customer_followups(p_store)`
  （顾客页「跟进」与首页卡片 `ops_cust_home()` 共用；新客只买过一次、第 7 / 21 天各一次、45 天后不追，刚到第 7 / 21 天的排前面；HQ / JB 照买过的门市，
  没买过的看报价单在哪间开，都没有的两边都列）；员工排行 `bi_customer_staff_board`（联络 / 补资料 / 取得同意都算「几位顾客」，合并搬过去的、只补送货地址的不算）+ 业务员
  新客 90 天回头率；延长保修（「Hemos 保修登记」）：`bi.customer_profile.warranty_at / _months / _by / _from` 在第一次登记时记下（之后改设定不影响），
  设定 `bi.customer_settings.warranty_months`（**0 = 不送，预设 0**）/ `warranty_back_days` 只有 admin 改（`bi_customer_set_warranty`）；只算 Hemos 产品：
  `bi_customer` 的购买明细多 `brand`（dim_item.item_type），顾客页只在有 HEMOS / HEMOSX 的单标 🛡️。BI 的扫码登记页 `/join.html` 读
  `bi_customer_signup_offer()`（anon），送出后照 `bi_customer_signup` 回传的实际月数显示。前端多 `src/cust/HomeCard.tsx`（首页）；测试 `tests/cust2_test.sql`。
  **营运系统前端已上线（2026-10-16）**：部署 `dpl_7ZLKpy1qZs416vabQ4LEqsQqbpiB`（180 个档，清单 `portal/deploy_manifest_20261016d.json`）；合并前核对正式环境
  这个 migration 的 11 个函数 md5 与本机一致（`bi_customer_merge` 只差 CRLF 换行，是 SQL Editor 贴上的），不用再套。
- **BI 的订货 / 库存 / 滞销品四页（2026-10-15 上线）**：老板 2026-10-14 决定「把订货、滞销品、库存这三个移到员工多部门功能那边，BI 那边去掉」；
  另一个 Claude 对话在 `claude/monthly-data-prep-vtcnct` 做好，以 patch（`docs/ops_handoff/0001-bi-pages-to-ops.patch`）交过来，`git am` 成 b9f9819。
  订货 →「补货建议」（`#/purchasing/replenish`）与「供应商交期」（`/leadtime`，只有看得到厂家的人有）；仓库 →「库存总表」（`/stock`）与「滞销品」（`/slow`）。
  **资料不搬家**：读 BI 同步进来的 `bi.*`，算法沿用 BI 视图（拆出 `bi.v_purchase_suggest` 只做计算，BI 原视图改读它、栏位不变）；已下单 / 暂不订 / 留言 / 商品设定写
  `bi.buyer_*`（与 BI 共用；撤销是软撤销 `undone_at`，因为 MCP 挡 delete）。权限照营运系统：看不到厂家（`ops.sees_supplier`）拿不到供应商 / 厂号 / 在途 PO 号 /
  **留言 / 商品备注 / 记录人**；看不到单价（`ops.sees_prices`）拿不到上次单价；库存成本只给老板（`ops.sees_cost`，2026-10-16 起）。前端 `src/rpl/*`、`src/rpl-api.ts`、`src/rpl.css`、
  `src/wh/Stock.tsx`、`src/wh/Slow.tsx`、`src/i18n-dict-rpl.ts`。Migration `20261016_ops_bi_pages.sql`（正式环境 `ops_bi_pages_1_views`～`6_grants`，对方套的）
  + 合并后审查修正 `20261016c_ops_bi_pages_fix.sql`（= `ops_bi_pages_7_fix`，已套，两个函数 md5 与本机一致）：留言三栏给看不到厂家的人回 null、
  `ops_wh_stock` 每行多回 `item_total`（商品全部仓位合计；原本是本页加总，分页切开或勾「只看负库存」时错）。测试 `tests/rpl_test.sql`。
  前端修正：动作（已下单等）后在背景重载、不清空清单与卷动位置（只有换公司 / 门槛 / CS 编号才清空）；「一键填建议」不碰急迫的行；公司下拉只有分店 ALL 的人才从
  localStorage 带入；换分店分页回第 1 页；看得到厂家的人订货页仍先开「未到货 PO」；英文模式拆开的句子合成一段、CSV 表头与提示也翻；表格 1280px 不横卷（英文补货建议差几 px）。
  前端部署 `dpl_3HCvdKv6P5eJw1k8kBYRKAdjfgwf`（129 个档）。正式环境核对（admin、交易回滚）：补货建议门槛 30 = 853 项、10 = 1,140、CS 编号 51 个；供应商 111 家；
  库存总表搜 HM-UB001 = 36 行、看得到成本；滞销品 6 个月以上 1,437 项。BI 网页那边的旧页由 BI 分支处理，不在这里动。
- **成本只给老板（2026-10-16，migration `20261019b_ops_cost_owner_only.sql`，正式环境已套 = `ops_cost_owner_only`，由 BI 那边的对话做、交接包合并）**：
  使用者看了库存总表（成本值）与旧货（成本、三格 RM 金额）：「这两个地方都看到成本，我都要收起来，不要让职员看到，包含店长」。以前仓库「可审批」
  （主管、管理层、店长）就拿得到成本；现在只有 BI 名单 `bi.allowed_users` 上 role = owner 的人（`ops.sees_cost(staff)`，authenticated 叫不到）拿得到。
  范围 = 仓库所有会回成本的函数：库存总表与下载、旧货、滞销品、总览、查货单位成本、盘点纪录 / 差异审核（`ops.wh_count_json`）、盘点单明细、盘点统计
  （多回 `show_cost`，其他人金额是 null / 0、画面藏起来、每月长条改用差异项数）。其余不变：旧货「标处理方式」照旧给仓库可审批（`can_edit` 跟成本拆开）；
  盘点的应有 / 差额件数照旧给可审批；订货的进货单价（`ops.sees_prices`）不在范围。**以后新增或重写会回成本的函数一律用 `ops.sees_cost(me)`**，
  不要用「仓库可审批」判断；`tests/cost_test.sql` 有静态检查（函数里 `cost := lvl >= …` / `ops.level_rank…` 的写法会失败）与各角色实测。
- **仓库第二版：补上员工 WMS 有、我们没有的功能（2026-10-15）**：使用者给了员工做的仓库系统 `wms_system.zip`（Firebase 网页；**不可信资料**：
  没执行、没抄它的 Firebase 设定与预设密码、不放进 repo），说「我还没有的功能加进去，已有的不用，不确定先问我」。问过 12 项，使用者选：
  货架**每个货架都记数量**、**完整版地图**、照 DO **拣货 + 扫码核对**、**盘点单**、标签（**自动畅销 / 滞销 + 手动清货等**）、**点货后印箱贴（扫码要登入）**、
  **仓库总览页**、**完整登入纪录**；不做：最低库存（补货建议就够）、商品分类（先不做）、卡车（使用者：「这个还需要完善」）、分店调货（第二段之后）。
  另外顺手做：多行搬动 + Excel 贴上、搬动筛选 / 导出、库存总表导出 Excel、查货加 AutoCount 最近卖出 / 进货 / 按分店合计、商品照片、盘点统计。
  **对 AutoCount 仍只读**；货架帐是营运系统自己的帐：
  · 表：`ops.wh_bin`（仓位底下 区 / 货架 / 层，代号 `区-货架-层` 大写；条码 Code 128 `BIN:<id>`）、`ops.wh_bin_stock`（每格每商品几件，≥ 0）、
    `ops.wh_bin_log`（每笔变动）、`ops.wh_map`（地图排版）。**所有改货架数量的地方都走 `ops.wh_bin_apply`**（先 insert on conflict do nothing 再
    `for update`，两人同时第一次上架不丢数；停用的货架只能减少），反向用 `ops.wh_bin_reverse`；搬动取消由触发器 `wh_move_bin_reverse` 冲回。
  · **应有** = AutoCount 库存 + `ops.wh_pending`（还没输入的搬动 / 进货）+ **已开 DO 还没拣**（`ops.wh_do_unpicked`：近 7 天、没取消、没拣好、没送达，
    算在主要仓位 `ops.podo_main_loc`；**AutoCount 开 DO 当下就扣库存，货还在架上**）。未上架 = 应有 − 货架合计；货架合计 > 应有 = 「对不上」→ 去盘点。
  · 拣货 `ops.wh_pick` / `_line` / `_scan`：DO 明细（`bi.delivery_doc.lines` = `[{d,q,u}]`）**没有商品代号**，照品名（整理空白、大小写）唯一相同配对，
    正式环境近 60 天 96% 对得到；`quote_push.py` 若在 lines 加 `c`（商品代号）会优先用它 = 100%。扫错 / 扫太多 / 货架不够回 `{ok:false, code}` 不报错；
    DO 单位跟商品基本单位不同（`ops.wh_pick_uom_diff`）不能从货架扣。已拣好的拣货单只有仓库「可审批」能取消。排单页显示「已拣好」（`ops_wh_pick_status`）。
  · 盘点单 `ops.wh_count_sheet` / `_line` + 按货架盘 `ops.wh_count_bin`（`ops.wh_count.sheet_id` 新栏位）；相符 / 差异定案时货架改成盘到的数；
    首页只提醒还有没盘的单（都盘完等主管结单就不提醒）；统计 `ops_wh_count_stats`（可审批）。
  · 标签 `ops.wh_tag` / `ops.wh_item_tag`：自动「畅销」= 近 90 天销量（`bi.mv_purchase_sold.q90`）前 5% 且 ≥ 10 件、「滞销」= 同滞销品页规则，每次现算；
    手动「清货」与自订（订货「可编辑」或仓库「可审批」；两间分店共用的标签只有分店 ALL 能改 / 停用）。照片 `ops.wh_item_photo` + Storage 私有 bucket `ops-wh`
    （`items/<公司>/<商品>/…`，policy 呼叫 `public.ops_wh_file_ok`）。箱贴批次 `ops.wh_lot`（`L<YYMMDD>-<流水>`，QR = `#/warehouse/lot/<批次>`，
    `ops.wh_resolve` 认得批次号 / 批次 QR = 那批的商品）、打印纪录 `ops.wh_label_print`（商品条码 / 箱贴 / 货架标签）。登入纪录 `ops.login_log`
    （login / open，同一人 10 分钟一笔；「员工与权限 → 登入纪录」只有管理员看）。
  · Migration（都已套到正式环境，2026-10-15）：`20261017_ops_wh_bins.sql`（= `ops_wh_bins_1`～`_3`）、`20261017b_ops_wh_pick.sql`（`ops_wh_pick_1`～`_3`）、
    `20261017c_ops_wh_count_sheet.sql`（`ops_wh_count_sheet_1`～`_2`）、`20261017d_ops_wh_tags_labels.sql`（`ops_wh_tags_labels_1`～`_3`）、
    `20261017e_ops_wh_extras.sql`（`ops_wh_extras_1`）、`20261017f_ops_wh_overview.sql`（`ops_wh_overview_1`）、`20261017g_ops_wh_perf.sql`（`ops_wh_perf`）；
    照「-- ====」合并成 ≤ 24 KB 一段套。**不能重跑的段**：bins §1（create table / sequence）、§2（create trigger）、count_sheet §1（create table、
    alter table add column）——要改函数就另开新 migration。套完 103 个函数 md5(prosrc) 与本机逐一相同。`20261017g` 是正式环境实测后加的效能修正：
    `bi.dim_item` 加两个只用内建函数的索引（`upper(item_code)`、整理过的品名），已开 DO 未拣整份 213 → 84 ms、单一商品 `ops.wh_do_unpicked_for` 6.8 ms
    （上架每行都要算应有；`authenticated` 的 statement_timeout 是 8 秒）。
  · 测试 `tests/bin_test.sql`、`map_test`、`binui_test`、`pick_test`、`sheet_test`、`overview_test`、`tag_test`、`extras_test`、`wms_fix_test`（审查修正）、
    `wms_perf_test`（单一商品版 = 整份清单，逐商品比对）。
  · 前端：`src/wh/` 的 Overview、Bins / BinOps / BinList / BinRecon / BinImport / BinLabels / ItemBins、Map / MapCanvas / MapLazy、Pick / PickDo / PickModals / PickTag、
    Count / CountBins / Sheets / SheetDetail / CountStats、ItemTags / ItemPhoto / BoxLabels / LotView / LabelLog、ItemMore / MoveBatch / MoveFilters / MoveBins；
    `src/pages/LoginLog.tsx`；API `wh-bin-api.ts`、`wh-pick-api.ts`、`wh-sheet-api.ts`、`wh-tag-api.ts`、`wh-extra-api.ts`、`wh-overview-api.ts`；
    字典 `i18n-dict-wh{bin,map,pick,sheet,tag,extra,ov}.ts`（**英文「货架」一律 bin**；建货架表单「区 / 货架 / 层」的货架那一排 = rack；
    `i18n.ts` 的 pattern 顺序：WHPICK、WHOV、WHEXTRA 放最前，whtag 的万用 `^(.+)（(\d+)）$` 放在 `PATTERNS_WHTAG_LAST` 排最后）。新套件 `qrcode-generator` 2.0.4。
    分页顺序：总览、查货、拣货、货架、盘点、搬动、待开进货单、差异审核、库存总表、地图、印条码、旧货、滞销品；预设：仓库可审批 → 总览、开单部 → 待开进货单、其他 → 查货。
    蓝牙扫描枪（键盘模式）在拣货页不用先点输入框。
  · 审查（多人 + 浏览器 e2e，9 个身分 × 31 个网址 × 手机 / 电脑 × 中英）修了：两人同时上架丢数、已开 DO 被列成「货架比系统多」、停用货架、撤销改由服务器照纪录冲回、
    DO 单位不同、已拣好取消权限、批次 QR 在上架 / 拣货 / 盘点也认得、Excel 带入 5,000 行超时（索引 + jsonb[]，不用 truncate）、连结带仓位 / 筛选 / 模式、英文用词等。
  · **前端已上线（2026-10-16）**：部署 `dpl_EvyoQXXEWd2UsFzfYEyHLV64KoY3`（179 个档，清单 `portal/deploy_manifest_20261016.json` = commit 91dfc0f；新 session 补传 11 个档后部署，`list_deployment_files` 核对 uid 与清单 SHA1 一致）。使用者 2026-10-16 回覆：① 物流部首页的「要拣的 DO」**保留**；② 建货架**不用细分到每一格**（层可以空着，只建 区-货架 就好；英文用词照旧）；③ **DO 通常隔天送** → 拣货的「今天要送」改成「今天 / 明天要送」= 昨天或今天开的 DO + 今天或明天的排单，排序今天的排单 → 明天的排单 → 其他（migration `20261018_ops_wh_pick_tomorrow.sql` = `ops_wh_pick_tomorrow`，已套，两个函数 md5 与本机一致；测试 `tests/pick_tomorrow_test.sql`；前端部署 `dpl_459N6AYQphA5jKHTCm6CML8ARLKT`，清单 `portal/deploy_manifest_20261016b.json`）；④ 同意让 SERVER 的 `quote_push.py` 在 DO 明细 lines 加商品代号 `c`（那支程式不在 repo，要使用者把档案传过来才能改；资料库那边已经认得 `c`）。货架清单的区改成可展开 / 收起（使用者 2026-10-16：区多了很乱，5 区 / 6 区 / 3 区按进去才看到货架）：预设收起、记在 localStorage `hw-bin-open:<公司>`、打字找货架时全部展开，「全部展开 / 全部收起」（`wh/BinList.tsx`、`wh/binLoc.ts`；部署 `dpl_3r12WNacJifFTkg7YdyN4soPG4AJ`，清单 `portal/deploy_manifest_20261016e.json`）。**2026-10-16 发现**：`bi.delivery_doc` 最后同步是 2026-10-14 13:00 UTC，SERVER 的 quote_push 可能停了。
- **仓库把关（2026-10-17，使用者：「进货和出货都有人把关，然后可以有效率的处理」，选了 8 项）**：migration `20261020_ops_wh_gate.sql`
  （**正式环境已套** = `ops_wh_gate_1`～`_4`，45 个函数 md5 与本机一致）。① 点货有差异（少 / 坏 / 多 / 来错）→ `ops.wh_recv_review` 等仓库「可审批」
  复核（点货的人不能复核自己），复核前开单部不能标「已输入」（触发器 `wh_move_gate`）；② 坏货 / 来错的货要拍照才能送出点货（`ops.wh_recv_photo`，
  bucket `ops-wh` 路径 `recv/<公司>/<do_id>/…`，照片是理赔证据、点完不能删；厂家问题页显示缩图）；③ 点完货的好货进「待上架」（`ops_wh_putaway`，扫货架 +
  打件数，走 `ops.wh_bin_apply` kind `putaway`；可写原因「不用上架」），超过 `putaway_days`（预设 2）天首页提醒，只算 2026-10-17 起的点货（`ops.wh_put_from`）；
  ④ 拣好的 DO 要另一个人盲核（`ops_wh_pick_check`，只给 DO 数量；不符回 `{ok:false,diffs}` 并记 `check_fails`，算在拣货的人身上）；⑤ 装车前扫 DO
  （`ops.dlv_load` / `_doc`；没拣好 / 没核对的不能装）；⑥ 出车要拍装车照（`ops_dlv_load_depart`，可审批的人可写原因强制出车）；⑦ 仓库「今天」分页
  （`ops_wh_today`，按急迫排序、「我来」认领 `ops.wh_claim`）；⑧「工作量」分页（`ops_wh_workload`，仓库可审批）。分店开关在仓库「复核 → 设定」
  （`ops.wh_gate`，没有那行 = 全开）。前端 `wh/Today|Gate|Putaway|Workload|PickCheck.tsx`、`dlv/Load.tsx`、`podo/RecvPhotos.tsx`、`wh-gate-api.ts`、
  `wh-gate.css`、`i18n-dict-gate.ts`；清单 `portal/deploy_manifest_20261017b.json`（192 个档；= 仓库把关 + 成本只给老板的前端。`20261017.json` 那份的档全部已上传 Vercel，`b` 多出的 11 个档（成本只给老板改到的 CountStats / SheetDetail / Aged / Stock / Slow / Review、wh-sheet / wh-overview / wh-tag api、i18n-dict-more / -whsheet）**还没上传**，部署前先照清单 sha 传这 11 个）。测试 `tests/gate_test.sql`
  （`po_do_test.sql` 开头把两间分店的点货复核 / 拍照关掉，旧测试照旧）。
  **前端还没上线**：2026-10-17 `create_deployment` 回 403（production 与 preview 都没有权限，之前可以），所以**三间分店的 4 个开关先全关**（旧画面不会拍照、
  不会复核，开着会卡住点货与开单部）。权限恢复后：用清单部署 → READY → 在「复核 → 设定」打开，或 `update ops.wh_gate set recv_review=true, recv_photo=true,
  pick_check=true, load_check=true`。仓库部只有 1 位在职：建议拣货核对由物流部同事做，或先关掉拣货核对。
- **KL Puchong 分店（2026-10-16，使用者：「全部功能，跟 JB 分店一样，它是其中一家分店」，Puchong 用店里自己的电脑开单）**：分店代号 `HOMEWORKSPUCHONG`
  （= `ops.staff.branch` / 各表 company；门市代号 `PUCHONG` 给送货 store / 出发点 / 外包司机），标签「Puchong 分店」。migration `20261019_ops_branch_puchong.sql`
  （= `ops_branch_puchong`，**正式环境已套**，17 个函数 md5 与本机一致）：所有只认两间分店的 check constraint 照原定义加第三间（DO 区块替换，名称不变）、
  17 个函数加第三间、`ops.outlet` PUCHONG 的 company / staff_branch 改成 HOMEWORKSPUCHONG（总部账套的 PUCHONG / PRE (PUCHONG) 仓位照旧算 Puchong 寄存，跟 JB 一样）、
  BI 同步接收 `bi_quote_upsert` / `bi_delivery_doc_upsert` 收 HOMEWORKSPUCHONG（替换公司清单）、`bi.delivery_driver.store` 收 PUCHONG。
  `ops_sync_status`：还没同步过的分店只给那间分店自己的人看（不然管理层一直看到「超过一天没更新」）。测试 `tests/puchong_test.sql`。
  前端（部署 `dpl_7FAEt934ripTuF2oMYLgFmL1wxuW`，清单 `portal/deploy_manifest_20261016c.json`）：`BRANCH_LABEL`、员工与权限 / 加入申请 / 自己申请的分店选单、
  打卡设定（打卡点、假日）、厂家到货清单与选厂家的公司选单、送货 `STORE`。**还没改（Puchong 有 AutoCount 资料后再做）**：任务 / 订货（未到货 PO、货柜、问题、点货）
  给分店 ALL 的人用的公司筛选、Excel 开账号认「Puchong」、箱贴的分店、顾客资料（BI 的门市只有 HQ / JB，`customer_signup.store` 也只有 HQ / JB）。
  **第二段（Puchong 电脑）**：AutoCount 资料（库存、PO、销售、DO）要在 Puchong 那台电脑跑 BI 同步 / `quote_push.py`，`autocount.json` 的 `supabase.company`
  填 `HOMEWORKSPUCHONG`；BI 管线（`bi.fact_*`）是否收第三间公司要在 BI 那边确认。在那之前 Puchong 员工能用：首页、任务、审批、打卡、请假、薪资、在路上（总部分给 Puchong 的货）。
- 物流部（2026-10-08，migration `20261008d_ops_logistics.sql` = `ops_logistics`，正式环境已套）：新部门 `logistics`「物流部」
  （送货可编辑 = 排单 / 当司机、仓库可编辑、订货只看 + 首页 / 任务 / 审批 / 打卡 / 请假）；「送货安装」部门改名「送货部」（代号仍是 `delivery`，
  模块名称改成「送货」）。员工司机改认送货部或物流部（`ops.dlv_driver_dept`，改了 `ops.dlv_drivers` 与 `ops_dlv_run_save`）。
  Excel 开账号「物流」→ logistics。测试在 `dlv_test.sql` 最后。首页「今天还没盘点」不提醒物流部（使用者 2026-10-09，migration
  `20261009_ops_home_no_count_logistics.sql` = `ops_home_no_count_logistics`，已套；最近 30 天自己盘过的物流部同事照样提醒）。
- **AttendX 功能比对（2026-10-09）**：AttendX 175 条规则，65 已有、15 使用者早先决定不要（主管先审、星期六半天、星期五礼拜、迟到按分钟扣、
  缺勤自动扣钱、对外接口），其余约 45 项问过使用者，**只选了 4 项**（migration `20261010_ops_profile_offboard.sql`；正式环境 2026-10-09
  分 4 段套用 `ops_profile_offboard_1`～`_4`（70 KB 一次送会被挡），套完 35 个函数的 md5(prosrc) 与本机逐一相同；前端部署
  `dpl_EsaHojiwXxeRMLLPxGSt2Dasxo6p` READY，90 个档 uid 与本机 SHA1 一致）：
  ① 最后上班日 `ops.staff.last_day`：隔天 00:00 KL 起 `ops.current_staff()` 找不到人；pg_cron `ops_staff_offboard`（16:05 UTC）把 active 改 false；
  出勤月报 / 看板 / `ops.pay_att` 算到最后上班日、之后月份不列；薪资「离职日」= last_day（`pay_profile.leave_date` 是同步副本）；自己的不能改、
  管理员的只有另一位管理员能动、至少留一位没有 last_day 的在职管理员（触发器 `staff_last_day_guard`）；停用时没填就记今天；复职清掉（离职月有薪资资料
  却没薪资纪录先挡）。只挡营运系统，BI 名单要另外移除（员工与权限会提醒）。② 补卡一定要附证明（`ops_att_self_close` 照 AttendX §2.5 免）。
  ③ 年假 `min_service_months = 3`：只挡开始日早于到职 + 3 个月的申请，天数照算；没填到职日先不挡（正式环境 8 人有 6 人没填）；HR 在假别设定可改每种假的月数。
  ④ 员工档案 `ops.staff_profile`（证件 MyKad/护照、生日由 MyKad 带出、地址、紧急联络人、银行）：本人全看全改（首页卡片 + `#/profile`），
  人事「只看」看非银行、「可编辑」改非银行（`#/hr/profiles`），银行只有本人与薪资 ≥ 可编辑；`ops_hr_gaps` 多 `id_no` / `emergency` / `bank`。
  测试 `tests/profile_test.sql`。使用者**没选**的（以后再提就照这份比对）：加班模块细节（先申请 / 星期日 2 倍公假 3 倍 / 餐费）、全勤奖、车贴、
  日薪合约工、PCB 自动、CP38、两间公司分开汇总与工资单抬头、会计分录、通知 / 推播 / 打卡提醒、公告、通讯录、培训、手册、强密码 / 忘记密码、
  紧急假 EL、补假 RL、年假结转、团队请假日历、老板免打卡。**已提醒使用者但未处理**：佣金没算进 EPF、佣金与加班没算进 SOCSO/EIS（照 HR 旧系统，
  建议问会计）；工资单抬头只有一个公司名（JB 员工印成 HOMEWORKS SDN BHD）。
- **订货升级第一段（2026-10-12 上线）：厂家到货 / 分到各分店 / 在路上 / 厂家问题**。migration `20261012_ops_po_do.sql`（89 KB，正式环境照
  「-- ====」分 5 段套用 `ops_po_do_1`～`_5`，每段 ≤ 24 KB；套完 39 个函数 md5(prosrc) 与本机一致）；前端部署 `dpl_CsgtXXzmFuCSi2YpUUkzJTvergXk` READY（101 个档 uid 与本机 SHA1 一致；新套件 `@e965/xlsx` 0.20.3）。
  使用者决定：所有厂家；厂家给装箱单 / DO 时由订货员开「厂家到货」（选厂家 → 选 PO → 上传厂家 DO（Excel / CSV 浏览器读；PDF / 照片先当附件，
  第三段用 AI 读，要使用者的 Anthropic API 金钥）→ 数量可改 → 每个型号显示出货总数与各分店订了多少，订货员自己分（同型号可按数量拆；
  只有一间分店订时预填）→ 填 ETA → 确认）。确认后：分店看「在路上」与 ETA（不含价格）；少发 / 多发 / 发错型号自动记成厂家问题，坏货 / 到货少
  手动记；少发每行选「厂家会补」或「取消（下次再订）」；问题清单按厂家分组，可下载 Excel、打印 / 存 PDF，一次提醒厂家。
  **分店 `ops.outlet`**：HQ（总部仓库 = 仓位 HQ + SRGADING，总部账套其他仓位也算总部）、BATU（Batu 店，与总部仓库分开；仓位 PRE (BATU) / BATU）、
  JB（PRE (JB) / JB / JB RESER；HOMEWORKSSOUTHERN 账套整本算 JB）、PUCHONG（KL Puchong，另一间公司 / 账套，但总部会开 PUCHONG / PRE (PUCHONG)
  仓位；`staff_branch` 还是空 = 第二段再把 Puchong 分店加进 ops.staff）。AutoCount 2026-10-12 还没有 BATU / PUCHONG 仓位（要等员工开）。
  **AutoCount 仓位惯例（使用者说明）**：JB = JB 一共订的数量；PRE (JB) 负数 = 还欠 JB；JB + PRE (JB) = 已到总部、还没送去 JB（寄存在总部）；
  送去 JB 时分行开 stock received、总部开单员开 stock issue（仓位 JB）。2026-10-12 正式数字：JB 351 个型号 13,039 件、PRE (JB) 236 个 −6,925、
  寄存总部 215 个 6,175 件。**在路上**：AutoCount「未到」要等 GRN 才减，所以自己记：同厂家同型号所有 PO 一起算（已收 T = 各 PO 行
  transferred 合计），每张已确认 / 已到货的 DO 有起算点（确认时的 T 扣掉 DO 日期之后的 GRN；退回草稿再确认沿用原起算点），照起算点顺序扣，
  坏货 / 到货少不算在路上，再摊回各 PO 行 / 分店；剩下未到 = AutoCount 未到 − 在路上（§3 有完整说明）。
  表：`ops.supplier_do`（draft → confirmed（在路上）→ arrived；草稿可 cancelled；已确认可由订货「可审批」退回草稿）、`ops.supplier_do_apply`
  （每个型号分给哪间分店、记在哪行 PO；退回草稿 void 不删）、`ops.supplier_issue`（short / over / wrong / damaged；少发 decision pending / await /
  cancelled；status open / resolved / void；后来的 DO 自动补「厂家会补」的少发）。权限：订货可编辑 = 开 DO / 处理问题；可审批 = 退回草稿；
  订货或仓库可编辑 = 标到货；订货只看 = 看在路上（JB 的人只看 JB）。档案 Storage 私有 bucket `ops-po`（`ops_po_file_ok`）。未到货 PO 清单多 `dos`。
  测试 `tests/po_do_test.sql`。正式环境最大厂家（89 张 PO、598 个型号全选）载入约 3 秒。厂家 DO 样本档只放 scratch，**不要放进 repo**。
  **第二段（还没做）**：分店在系统填要的型号 / 数量（自己寄存的货不用批；要总部自己的现货要总部店长 = 订货可审批批准）→ 总部按「已送出」
  （仓库 / 物流 / 总部开单员都可以）→ 分店按「已收到」；分店看得到总部仓库现货、在路上与 ETA、厂家问题，不看价格；Puchong 加进 ops.staff。
  **第三段**：AI 读 PDF / 照片的厂家 DO。使用者 2026-10-13 问「为什么要 API 金钥」后改口：不用 AI 读，从 PO 列出型号自己挑就好
  → **先不申请金钥、第三段搁置**（照片照样可上传当附件）。小地方还没改：新 DO 第一次存档前候选数量以今天计。
  **2026-10-13 追加**（前端 `dpl_HBDgtB9UAMd1q44Mora2GeA7rNqT` = 全到；CS 编号 + 厂家隐私 = `dpl_2Z8yEySjbRDKsA5KBTDNiA1t2xS6` READY，101 个档 uid 与本机一致）：
  ① 厂家到货每行「全到」按键（出货 = 还可以出，分配照各分店未出；`DoEditor.tsx` `fullRow`，「全部填」共用）。
  ② **CS 编号**：中国厂开在代理户口下（4000-M002 MULTI GLOBE 91 张未到 PO / 32 种 CS；MAIDEN SQUARE、CMG、SHADOW RHOMBUS 也是），
  CS 编号只写在 PO 厂家名称栏（常夹备注「CS028 (ETA)」「CS011(还没订）」）。`ops.podo_cs` 抽出（字首 CS、可有空白或 -、补到 3 位）；
  选厂家可打 CS 编号（cs28 = CS028）找到代理并把搜寻带到选 PO；选 PO 每张显示 CS 与名称栏备注、可搜寻。migration `20261013_ops_po_do_cs.sql` = `ops_po_do_cs`。
  ③ **厂家资料只给采购、管理层、仓库部看**（使用者：分行不知道厂家是谁，只要看得到产品来了多少与 ETA；总部门市、电商、物流也看不到）。
  `ops.sees_supplier` = 订货「可编辑」或 department = 'warehouse'（物流有仓库可编辑但不算）。其他人：未到货 PO / PO 明细 / 货柜
  资料库挡（`ops.require_supplier`）、画面没有这两个分页（`#/purchasing` 直接开在路上）；查 SKU 到货与仓库查商品的在途不回 PO 号 / 厂家 / 货柜；
  首页「三天内到货」不给；在路上只列型号、数量、ETA，搜寻只找型号 / 品名。看得到厂家的人在路上每行还要看得到那张 DO 的公司
  （JB 采购看总部分给 JB 的货一样没有厂家 / DO 号 / PO 号）。migration `20261013b_ops_supplier_privacy.sql` = `ops_supplier_privacy`（两个都已套，
  12 个函数 md5 与本机一致）。**第二段注意**：Batu 员工现在 branch 也是 HOMEWORKSSB，规则分不出总部与 Batu；Batu 的人只要不是采购 / 仓库部就看不到厂家。
- **订货 SOP + 仓库点货 + 开单部（2026-10-13 上线）**：migration `20261014_ops_po_receive.sql`（正式环境 `ops_po_receive_1`～`_3`）+
  `20261015_ops_po_sop.sql`（`ops_po_sop_1`～`_9`，照「-- ====」切；**要先套 20261014，套过 20261015 之后不要再重跑 20261014**）；
  套完 248 个 ops / public.ops_* 函数与本机比对，这两个 migration 碰到的全部一致（另外 9 个旧函数只差函数内的中文注解，正式环境当初套的是去掉注解的版本）。
  前端部署 `dpl_GGYYXrDRb8M4SWbVd6JDVhMZrtaS`（112 个档 uid 与本机 SHA1 一致）。**前端档案要 ≤ 约 35 KB**：Vercel MCP 上传要把整个档案的 base64
  写进一次呼叫，太大（DoEditor 79 KB、Receive 56 KB）或某些内容会被截断 / 挡下，所以拆成 `podo/doRows.ts`、`DoProblems.tsx`、`DoViews.tsx`、
  `DoSections.tsx`、`RecvForm.tsx`、`RecvReceipt.tsx`；真的传不上去的档可以在 `create_deployment` 用 `encoding: "utf-8"` 直接内嵌原始码（RecvForm.tsx 这次就是），
  部署后用 `list_deployment_files` 核对 uid。使用者决定：
  ① **只有订货部（采购）开厂家到货**（物流部改回订货「只看」、看不到厂家）；一步接一步：选 PO → 出货 → 分店（一打开就列四间分店；JB 账套只能分 JB，
  触发器 `supplier_do_outlet_guard`）→ ETA → 确认（订货部）→ 点货（仓库部）→ 厂家问题（采购决定）→ 进货待开 GRN（开单部）；`ops.podo_json.sop`
  回目前第几步、等哪个部门；草稿从开单起 24 小时没确认标红；首页提醒：`do_draft_stale`、`po_no_eta`（PO 没 ETA 要问厂家：中国货 ≥ 30 天、本地 ≥ 7 天、
  ≤ 120 天、没厂家到货 / 没 ETA / 没货柜；上线当天正式环境 69 张）、`po_issues_todo`、`do_to_count`、`grn_pending`。
  ② **「这批的问题」**（开单画面）：少发开单时就选厂家会补 / 取消 / 未决定（`items[].short_decision`）；来错的型号可搜我们的商品（`ops_po_item_search`）
  或「不是我们的产品」+ 要厂家怎么处理（`supplier_issue.request`：replace / return / next / keep / other）；缺零件 kind = `part`（`supplier_do.parts`，
  「下次补上」= 厂家会补）；厂家问题记 CS 工厂（`factory`）、`owed_qty`（厂家还欠）；问题页按厂家 → CS 工厂分组；**WhatsApp 讯息**中 / 英、写厂家 DO 号与我们的 PO 号、
  不含价格（`podo/whatsapp.tsx`，wa.me 自己选联络人）。
  ③ **仓库点货**（订货或仓库「可编辑」；不能再直接「标记到货」）：每个型号好货 / 坏货、改分店分配、来错的货；少 / 坏 / 多 / 来错自动记厂家问题。
  ④ **点货后库存跟著变（不写 AutoCount）**：点货产生 `ops.wh_move` kind = `receive`（pending，仓位照 `ops.podo_recv_loc`：总部 = PO 行仓位、其他分店 = PRE (分店)），
  `ops.wh_pending` 加进查商品 / 盘点「应有」；新部门 **开单部 `billing`**（仓库只看 + `ops.grn_can_mark`，看得到厂家）在「仓库 → 待开进货单」照单在 AutoCount 开 GRN、
  按已输入填 GRN 号；AutoCount 已有新 GRN 只提示「可能已输入」（`grn_avail` 先出先到），不自动标；点货时 AutoCount 已经有 GRN 的记 `pre_grn`（不重复算库存，还是等开单部核对后标已输入；使用者 2026-10-14 确认照这样做）。
  **扫码点货（2026-10-16，使用者：「40 件不要扫 40 次，扫一次就填总数」）**：点货页「开始扫码点货」（`podo/RecvScan.tsx`）→ 每个型号的好货先清空、坏货归 0，
  扫一个型号跳出视窗打一共收到几件（可「全到」、同型号分几箱可「加上去」），没扫到的送出时被「请填好货」挡下（没到要填 0）；认得 DO 型号代号、
  纸箱条码 / 箱贴批次（`ops_wh_item` → `ops.wh_resolve`，没有仓库权限就只认型号代号）、品名片段；不在这张 DO 的型号记进「来错的货」。只改前端、不动资料库。
  部署 `dpl_DgCVPzWxWajLSpY56yHbQX2JThYE`，清单 `portal/deploy_manifest_20261016f.json`。
  进货取消只有仓库「可审批」而且要写原因。单价只给订货「可编辑」与 admin（`ops.sees_prices`）。
  **Supabase MCP 也挡 `drop function`**（apply_migration 卡 60 秒后 cancelled）：所以 `ops_wh_move_mark` 旧的 3 个参数版本留著转接、新的 4 个参数版本参数全必填。
  **人手**（上线当天）：仓库部 1 位在职、开单部 0 位 → 开单部要先开账号（员工与权限 / 加入申请选「开单部」）才有人开 GRN；在那之前管理层（仓库可审批）也能标已输入。
- **配色与字体 = HomeWorks BI 同一套（2026-10-14 使用者：「根据 homeworks BI 的颜色和字体」；取代同日稍早的配色 A「清爽水青」，A 的部署 `dpl_3nCoCXPTTjdSateMaZA94UEL7iGP`）**：
  出处是 BI（Vercel `homeworks-bi`）`src/styles.css` 开头的注解「品牌主题:深蓝渐变暗色(依据用户提供的调色板规范)」——渐变 #111721 / #171D35 / #272D50、
  卡片 #20293E、点缀 #DBE8FA（按键底，上面的字 #111721）、次要文字 #94A3B8、警示 #EF4444、字 #FFFFFF、字体「卓健橄榄简体」（`'ZhuoJianJianTi', '卓健橄榄简体', system-ui…`，
  标题 32 / 正文 15）。BI 没有载入网页字体，只有装了这个字体的电脑才看得到，其他装置用内建字体；营运系统照做（`index.html` 不再载 Google Fonts）。
  BI 的 styles.css 只有开头约 1.5 KB 抓得到（MCP `get_deployment_file_contents` 会截断，repo 里也没有副本），所以元件细节（分页、表格、按键形状）是照调色板自己配的。
  BI 目标页的灯号固定色：绿 #22C55E、黄 #F59E0B（BI 的 `--good` 是浅蓝，不是绿）。
  全部颜色在 `portal/src/style.css` 的 `:root`（`color-scheme: dark`；`--grad` 页面渐层、`--nav`/`--nav-2` 侧栏、`--primary` #dbe8fa、**`--on-fill` #111721 = 亮色底（点缀、红、绿、橙）上的字**、
  `--card`、`--input`（输入框底比卡片深一阶）、`--text`、`--muted`、`--line`/`--line-strong`、`--soft`/`--tint`/`--hover`/`--track`、`--card-shadow`、`--backdrop`；
  状态：`--red` #f87171 是**字**（#EF4444 在卡片上对比只有 3.8）、`--red-fill` #ef4444 是**实心底**、`--green` #22c55e、`--amber` #f59e0b 与各自的 `-soft`；
  `--purple`/`--purple-soft` 发错型号、`--warm-row` / `--red-row` 要注意 / 逾期的列）。淡底色都是「颜色 × 透明度叠在卡片上」算好的不透明色（sticky 栏位要不透明）。
  **新画面不要写死颜色，一律用变数；按键底若不是 `--primary` 要自己设 `color`**（预设按键字是 `--on-fill` 深色，深色底会看不到）。
  `style.css` 档尾 `@media print` 把变数换回白底黑字；工资单（`.ps`）、条码标签（`.label`）在画面上是白纸、刻意不变。
  logo `public/icon.svg` = 浅蓝 #dbe8fa 方块 + 深蓝 #283060 房子（BI 的 theme-color 与图示线条色），`icon-192.png` 由 SVG 转出；BI 自己的图示是白底深蓝线条
  「斜屋顶 + 铁锤」（`favicon-48.png`，大图抓不全），使用者若要两边用同一个 logo，请他给原图档。theme-color / manifest #111721。
  前端部署 `dpl_9d5s3NpHtrzJtYoogFMtLWafrGtz`（112 个档 uid 与本机 SHA1 一致；`icon-192.png` 用 upng-js 压成 16 色、1 KB，原本 3 KB 的版本两次上传都失败、自己内嵌又少了 28 个字）。审查：截图 95 张 × 3 轮 + 实际印 PDF，多人审查逐条复核后修了 18 项（打印白纸、分页外框、内文连结底线、淡底灰字对比、红字 #fa7f7f 等），第三轮只剩 1 项已修。
- 路线图（AttendX 搬迁顺序，使用者 2026-10-01 选定）：打卡 + 补卡 ✓ → 请假 ✓ →（插队：仓库第一版 ✓）→ 薪资 ✓（移植 HR 原系统）→ 加班（按打卡自动算，接到薪资的加班时数）；其余：2 销售；
  3 仓库 + 送货（✓ 2026-10-08）；4 收款、佣金、报表；5 HR、薪资。**使用者决定（2026-09-26）：所有功能统一在营运系统，
  HR 打卡也做在 `portal/` 的 hr 模块**，不沿用 7 月建的 Vercel 专案 `hr-attendance-app`（Next.js，
  GitHub `leslieteeyang-a11y/hr-attendance-app`，没有环境变数 = 没接数据库，最后一次提交只是「Create page.tsx」，
  没有资料要搬）。那个专案与 repo 是否删除 / 暂停由使用者决定，未经同意不要动。

## 第一次打开时要做的事（照顺序）

（使用者也可能已经双击过 `setup_autocount.bat`（= 第 1、3、4 步）和 `make_report.bat`
（= 第 6 步）；先看有没有 `autocount.json`、`discovery_*.txt`、`output/月度报表_*.xlsx`。）

1. `python -m pip install -r requirements.txt`
2. `run_web.bat` → 浏览器开 http://localhost:8000 看到库存页（示范资料）即通过。
   确认后停掉它（关视窗或 Ctrl+C）。
3. `python scripts\autocount_setup.py` → 自动侦测 SQL Server、列账套让使用者选、
   写出 `autocount.json`。连不上时脚本会说该检查什么；**Server 名称照抄
   AutoCount 登入画面**。
4. `python scripts\autocount_discover.py` → 产生 `discovery_<账套>.txt`。
5. 读那个档案，依实际表名栏名修正 `autocount.json` 的 `schema`、
   `channel_rules.map`（哪个 Debtor Code 是 Shopee / Lazada / …）、`brand_filter`，
   以及 `webapp/sources/autocount.py` 的预设 SQL（可用 `autocount.json` 的
   `webapp.sql` 覆写而不改程式）。
6. `python scripts\autocount_extract.py 2026-08 --dry-run` 看 SQL，没问题再拿掉
   `--dry-run` 真的抓；接着 `python scripts\generate_report.py 2026-08`，
   把结果与 `data/2026-08.json`（纸本录入的对照值）比对。
7. 再开 `run_web.bat`，这次会自动接 AutoCount；确认库存与出货页有真实资料。

遇到错误自己处理；需要使用者决定的（选账套、密码、哪个客户对应哪个渠道）才问。

## 绝对不要做的事

- **不要对 AutoCount 写入任何东西**（INSERT / UPDATE / DELETE / 存储过程）。
  目前所有整合都是只读；写入要另开专案、用 AutoCount 官方 SDK、先在测试账套验证。
- 不要提交 `autocount.json`、`discovery_*.txt`（已在 .gitignore；内含密码 / 结构）。
- 不要把示范资料（`webapp/sources/mock.py`）的数字当成真实数据。

## 专案地图

| 路径 | 用途 |
|---|---|
| `webapp/` | 营运入口网页（FastAPI + Jinja2；`charts.py` 是纯 SVG 图表；`auth.py` 登入与 session）。`sources/` 是资料层：`__init__` 定义介面，`mock` 示范资料，`autocount` 只读实作 |
| `scripts/autocount_*.py` | 连线、侦测、探查、抓月报数据 |
| `scripts/generate_report.py` | `data/YYYY-MM.json` → `output/月度报表_YYYY-MM.xlsx` |
| `scripts/run_monthly.py` + `run_monthly.bat` | 抓数 + 产报表一步到位；`--scheduled` 给排程用，输出写 `logs/`，可依 `config.json` 的 `report_delivery.copy_to` 再复制一份 |
| `scripts/schedule_monthly.py` + `schedule_monthly.bat` | 用 XML 登记 Windows 工作排程器（每月 1 号 08:00，错过会补跑）；`--run-now` / `--status` / `--remove` |
| `scripts/supabase_push.py` + `setup_bi.bat` | 月报成品推进 HomeWorks BI（Supabase，见下节）；`--set-key` 贴金钥、`--check` 测连线、`YYYY-MM` 推送 |
| `config.json` | SKU 趋势清单、报表渠道栏 |
| `autocount.example.json` | 连线与对照设定模板 |
| `portal/` | 员工用营运系统（Vercel + Supabase `ops`，见上节与 `portal/README.md`） |
| `tests/` | `python -m pytest tests -q`，36 个测试：网页行为（示范资料）+ 登入流程（假 sign_in）+ 抓数纯函数（分类、型号、Top 10），都不需 AutoCount |
| `README.md` | 使用者视角的完整说明 |

## 后续路线（使用者已同意的顺序）

1. ~~真实数据接通~~（已完成。2026-09-25 排程已在 SERVER 登记并用 `--run-now` 验证成功；
   实际安装路径是 `C:\Homeworks\HomeWorks`（多一层），排程、output、logs 都在那里）
2. ~~管理仪表板~~（已完成 v0.2：`/dashboard`，销售来自 Invoice+CashSale−CreditNote+DebitNote）
3. ~~登入与权限~~（已完成 v0.3，2026-09-26：`webapp/auth.py`。用 Supabase Auth 密码登入
   → `rpc/bi_role` 查角色 → 只放行 `web.allowed_roles`（预设 owner，使用者本人）；HMAC 签章
   cookie，`cookie_secret` 存 autocount.json。中介层挡所有页面与 /api，只放行 /login /logout
   /health /static。测试 `tests/test_auth.py` 用假 sign_in。**开到办公室以外**还要做 HTTPS 与
   对外通道（建议 Cloudflare Tunnel），尚未做。）
4. 写入 AutoCount 的 POC：一条流程、测试账套、证明失败时不留半张单、重跑不重复过账

## 写码惯例

- Python 3.11+，型别标注，中文注释；错误讯息要告诉使用者**该检查什么**，不要只丢 traceback
- 合计 / 百分比在 Excel 里用公式，不写死数值
- 改动后跑测试；新功能补测试
- 提交讯息说明「为什么」，不只「做了什么」
