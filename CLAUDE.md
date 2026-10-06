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
渠道函数 `bi.sale_channel(debtor, type)` 与本专案的 channel_rules 口径不同（它把 Shopee SG /
NEST / CASH(ONLINE) 归「其他平台」，CASH(REFERRAL) 归门市现金）。
2026-09-25 核对 8 月：BI 的 CS、CN 与本专案分毫不差；IV 少 13,424.50 = 没商品代号的自由
输入行被它丢掉；BI 没抓 DN。
**接法（2026-09-25 建）**：本专案每月产生报表后，用 service_role 呼叫
`public.bi_report_upsert(company, month, doc)`（PostgREST `/rest/v1/rpc/`），落到
`bi.report_month` / `_category` / `_channel` / `_sku` / `_top10`（RLS 与其他 bi 表相同，
`bi_sync` 也可写），前端读 `public.bi_report_month_*`。金钥放 `autocount.json` 的 `supabase`
段（setup 会保留），用 `setup_bi.bat` 贴入。Migration：`monthly_report_tables`、`monthly_report_service_role_read`
、`report_status_rpc`（`public.bi_report_status(p_company)` 只给 service_role，`--check` 用它数月份；
视图 `public.bi_report_month` 靠 `bi_is_allowed()` 放行，service_role 读永远 0 行）。新式 `sb_secret_`
金钥只放 apikey 标头；贴金钥用 getpass 不回显（2026-09-28 有一把因截图外泄而轮换）。
**MCP 里有 Supabase 工具**（`mcp__Supabase__*`），可直接查表、建 migration；DDL 用
apply_migration，不要用 execute_sql。
**分行实际销售额**（2026-09-28）：使用者要在电商月报 Southern 旁多一栏「当月实际销售额」= 分行
JB Southern 账套的 SO 全部 + 非 SO 转来的 IV − CN，三者都排除 SalesAgent 空白的单。BI 的管线没有
SO，分行账套也不在 SERVER（在使用者用 AnyDesk 连的那台分行电脑），所以 `scripts/branch_actual.py`
要装在分行电脑上跑（`setup_branch.bat` = 挡总公司账套（`preferred_database`，请用 `choose_book.bat`
= `autocount_setup.py --choose` 改选）+ 自动填 `supabase.company` = HOMEWORKSSOUTHERN + 贴金钥 +
今年各月 backfill + `schedule_monthly.py --branch` 登记「HomeWorks Branch Actual」排程 →
`run_branch.bat`）。**分行账套在分行电脑本机 `(local)\A2006`，公司名 HOMEWORKS (SOUTHERN) SDN. BHD.，库名 **AED_HOMEWORKSSBJB**（2026-09-28 setup 确认，
375 张表）**，所以分行流程改用账套里的公司名称
（`autocount_db.book_company_name`，读 Profile/CompanyProfile.CompanyName）含 SOUTHERN 来判断，
读不到才退回看库名。落到 `bi.branch_actual_month`（scope ×
category）与 `bi.branch_actual_meta`（各 agent 明细），RPC `public.bi_branch_actual_upsert`，视图
`public.bi_branch_actual_month`；migration `branch_actual_month_by_category`。**分行页（2026-09-28 晚）**：使用者要「把这个列表放在 JB 里面给店长看」→ BI 网页新增分页 `实际销售`
（`src/pages/BranchActual.tsx`，App.tsx 的 `branch` tab，MANAGER_TABS 含它，只在 COMPANY=HOMEWORKSSOUTHERN 显示；
店长帐号 homeworksjb.manager@hotmail.com role manager）：KPI、按类别、各 agent（`branch_actual_meta.detail.agents`，
IV 列的 `direct` = 非SO发票，b 版脚本才有）、逐月长条图。视图 migration `branch_actual_views_company_scope`
加了 `bi_company()` 公司过滤。脚本 b 版（`branch-2026-09-28b`）：`--scheduled` 推上个月 + 本月至今、
`--backfill` 到本月、排程 `--branch` 改每天（`task_xml(daily=True)`）；分行电脑要重跑一次 setup_branch.bat 才会换成 b 版与每天排程。
**2026-09-28 分行电脑已装好并推完 1～8 月**（8 月全品牌实际销售额 1,355,211.54 = SO 1,219,856.37 +
非 SO 发票 152,450.50 − 贷项 17,095.33），排程「HomeWorks Branch Actual」已登记。分行 8 月发票 agent：
HQ 330k、EMILY 238k、JC 175k、MAX 144k、WEILUN 77k、AMY 2k、空白 13k。
**广告 / 直播数字改在 BI 填（2026-09-28 晚）**：migration `report_ads_rpc`：`bi_report_set_ads(company, month, ads, live_sales)`
（authenticated，函数内检查 `bi_role()='owner'`）、`bi_report_get_ads`（service_role）、`bi_report_upsert` 改成新推来的 ads 为空 /
live_sales 全 0 时保留旧值。前端 `src/components/AdsEditor.tsx`（EcomReport 的 `canEdit` prop，App 传 owner）。SERVER 端
`supabase_push.pull_ads/merge_ads`，`run_monthly` 在 extract 之后、generate 之前拉回 data JSON。使用者说这个填写页「不用给分行看」。
**仓库整理（2026-09-28 晚，使用者最烦的问题）**：HQ = 总行门店仓库，SRGADING = 全公司大仓。BI fact_stock 显示 HQ 有 537 项负数，
其中 440 项在 SRGADING 有同量正数 → 货从大仓搬到门店没开 Stock Transfer；负数最大的 VOUCHER / SHIPPING FEE / ONLINE000001
是服务项目却有 Stock Control；真正全仓合计为负的实体商品约 104 项（Sanitary 51、Lock 18、Fitting 18…，约 1,000 件）。
做了 BI 分页「库存异常」（`src/pages/StockAnomaly.tsx`，视图 `public.bi_stock_anomaly`，migration `stock_anomaly_view`，
服务群组 = ONLINE/SHIP FEE/PAY FEE/TRAN FEE/SERV FEE/INSTALL/TRANSPOR）：A 服务项目 → 取消 Stock Control；B 仓位错配 →
建议转仓清单 CSV（每个负数仓从库存最多的正数仓补）；C 真正短少 → 盘点表 CSV。整理顺序：定仓位规则 → 关服务项目库存控制 →
照清单转仓 → 分仓盘点 → 每周看这页。**写入 AutoCount 的第一条流程改为「盘点差异 → Stock Adjustment」**（比 SO 有用）；
API 是 AutoCount 2.0 选购模组，使用者要先看授权画面 + 建测试账套 AED_HOMEWORKSSB_TEST + 跑 `check_sdk.bat`。
**顾客资料（2026-09-29，取代前一天的顾客积分）**：使用者说「积分我不要，主要是要有一个地方记录顾客讯息，将来可能做促销」。
积分的表 / 函数已删（loyalty_txn 当时 0 笔）。门市散客（HQ debtor_type RETAIL；JB RETAIL + 空白，`bi.customer_eligible`）两边合并，
**顾客编号 = 电话**（`bi.customer_phone` 从单据客户名称抽手机号统一成 60… / 65…，抽不到用客户主档名称，再不行且不是 CASH 共用账号
就用 `A:公司:客户代号`）；购买历史从 `bi.fact_sales` 全部历史现算（视图 `bi.customer_doc`，HQ 2022-06 起、JB 2024-03 起），约 7,800 位。
员工补的资料存 `bi.customer_profile`（名字、生日月 / 日、地区、地址、类型 屋主 / 设计师 / 承包商 / 水工 / 公司 / 其他、备注；使用者没选
「同意收促销」栏位）。RPC：`bi_customers()`（全体清单约 1.6 秒，前端筛选：门市、最后消费、买过类别=item_group、类型、生日月、地区、
累计消费）、`bi_customer(p_member)`、`bi_customer_save(...)`（没买过的潜在客也能新增）、`bi_customer_missing_phone(days)`；
owner / manager / sales 可看可改，**汇出 CSV 只给 owner / manager**（前端控制）。AutoCount 不写入。Migration `customer_profiles`
（+ `_faster_list`、`customer_doc_parse_names_once`），留底 `docs/bi_web/customer_profiles.sql`。前端沿用 `/loyalty.html` 网址与档名
（`docs/bi_web/loyalty/`）；Claude 的 Vercel 连接器能读不能建部署（403），
由使用者在 SERVER 双击 `deploy_bi_web.bat`（金钥在 SERVER 的 `vercel_token.json`）。第一版 9/29 已上线（dpl_FUEcJLa8hZsd9ZR41g6nADgNocYz）。
**顾客资料第二版（2026-09-30，migration `customer_crm`，留底 `docs/bi_web/customer_crm.sql`）**，使用者 7 项全选：
跟进提醒（7 天内生日、潜在客建档 7 天没联络、员工自订「下次联络日」到期；按 WhatsApp / 已联络 → `bi_customer_touch` 记
`last_contact_at` 就消失）、一键 WhatsApp（范本 `bi.customer_wa_template`，`{name}` 换名字，wa.me 连结）、买了 A 没买 B（前端筛选）、
同意收促销 `consent` = yes / no / null(未确认)，**汇出 CSV 与建活动只收 yes**（`bi_campaign_create` 在数据库端再过滤一次）、分级
（前端 `tierOf`：没买过 = 潜在客；超过 365 天 = 流失；近 12 个月 ≥ RM10,000 = VIP；近 12 个月 ≥ 2 张单 = 常客；其余一般；门槛存
`bi.customer_settings`，owner 可改）、促销活动（`bi.customer_campaign(_member)`，成效 = 名单上的人发送后 30 / 60 天的消费）、每月顾客报告
（`bi_customer_monthly` 新客 / 回头客 / 流失、`bi_customer_agents` 各业务员）。`bi_customer_save` 改成 10 个参数（旧 8 参数版已删，
第二版网页上线前线上页的「储存」会失败）。overlay 以 dpl_FUEcJLa8hZsd9ZR41g6nADgNocYz 为底，只换 Loyalty.tsx / loyalty.ts / loyalty.css。
**顾客资料第三版（2026-10-05/06，migration `customer_crm_v3_*`，留底 `docs/bi_web/customer_crm_v3.sql`）**：第二版上线 5 天只有 1 位顾客
补资料、0 位标同意，使用者选了 6 项：手机快速登记（`bi_customer_quick`，只写有填的栏位）、顾客扫 QR 自己登记（公开页
`/join.html?s=HQ|JB`，anon 只能呼叫 `bi_customer_signup`，进 `bi.customer_signup` 待确认，**店员确认后才生效**，10 分钟 30 笔上限；
海报 `docs/bi_web/qr/join_qr_*.png`）、报价没成交提醒（**Quotation**，`scripts/quote_push.py` 只读 QT/QTDTL 近 120 天 → `bi_quote_upsert`
（service_role）→ `bi.quote_open` / 视图 `bi.customer_quote`；开出 7 天没转单、之后也没买 → 跟进提醒；SERVER 用 `setup_quotes.bat` 登记每天
「HomeWorks Quotes」排程，分行跟着 `branch_actual.py --scheduled` 每天推）、装修进度 5 段（plan/rough/tile/install/done，`stage_reco`
各段推荐类别，30 天没更新提醒）、修改纪录（触发器写 `bi.customer_profile_log`，`bi_customer_log`）、合并重复顾客（`bi.customer_alias`，
`customer_key` / `customer_doc` 先换成主号码；`bi_customer_merge` / `_unmerge` 只给 owner / manager）。
**Supabase 连接器遇到含 DROP / DELETE 的变更会卡在确认、60 秒过期（使用者那边看不到提示）**：这类 SQL 改请使用者贴进
Supabase SQL Editor（https://supabase.com/dashboard/project/vwljnypzgfqhatkgulqs/sql/new）按 Run → Run query；SQL 要直接贴在对话里
（传档给使用者会打不开）。第三版最后一批就是这样在 2026-10-06 套用完成。**线上 10/01 被使用者从自己电脑的原始码重新部署（dpl_HaQ2nQP5AqCakeHKCdYfWZzzmGD3），那份原始码没有顾客资料页，
loyalty.html 从那天起 404**；overlay 改以它为底把整组顾客页加回去。以后使用者若再从电脑部署，要先把 `docs/bi_web/loyalty/` 的档案
放进那份原始码，否则顾客页又会消失。2026-10-06 第三版已由 deploy_bi_web.bat 上线（dpl_J5mNzgqdWhDubpFU7CHTs1NgK5Dk）。同日使用者要求登记页「住哪一区」改成
**送货地址**（员工送货用）：`bi.customer_signup.address`，RPC `bi_customer_signup` 多一个 8 参数版（`p_address` 无预设值，旧 7 参数版保留），
确认时地址以顾客新填的为准；overlay 以 dpl_J5mN… 为底，只换 join 两档、Loyalty.tsx、loyalty.ts。同日再加**电邮**（`customer_signup.email`、`customer_profile.email`，
9 参数版 `bi_customer_signup`（`p_email`）、确认时电邮以顾客新填的为准），登记成功后 4 秒自动带到 **www.hemos.com.my**（也有按钮）。（已上线 dpl_EiyNVLR3WZTKpQsZJtUKhewNXj1T）
**同日使用者改主意：扫码登记不用店员确认，送出即生效**（migration `customer_signup_auto_confirm`：`bi.customer_signup_apply(id, actor)`
共用写入规则，9 参数版 `bi_customer_signup` 送出就套用、status = confirmed、handled_by = 「顾客自己扫码登记（HQ/JB）」；被乱填的风险靠
修改纪录追查）。`bi_customer_signups` 改列「旧的待确认 + 近 14 天扫码登记」，前端改成「最近扫码登记的顾客」给店员跟进。
**PostgREST 每次最多回 1,000 列**：前端直接读 `bi_customers()` 只拿到前 1,000 位（实际 7,921 位，2026-10-06 使用者截图发现）。
改读 `bi_customers_all()`（回传一个 jsonb 阵列、`jsonb_strip_nulls`），旧函数保留作退路。以后任何会超过 1,000 列的 RPC 都要这样包。
**送货排单（2026-10-06，migration `delivery_planner` + `delivery_docs_by_date`，留底 `docs/bi_web/delivery.sql`）**：使用者要输入单号看顾客地址、
排最快路线、一键传司机。选择：单据 = **DO**；地址**只用顾客资料**（`customer_profile.address`，新增 lat / lng / geo_query）；**免费排路线**
（前端 `src/pages/Delivery.tsx`：OpenStreetMap Nominatim 找坐标、每秒 1 次，找到存回顾客资料；最近邻 + 2-opt 直线距离；找不到可贴 Google Maps
坐标）；**WhatsApp 整张清单给司机**（每站 Waze 连结 + Google Maps 全程连结，一段最多 9 个中途站）。DO 由 `quote_push.py` 只读推（`bi_delivery_doc_upsert`
用 upsert、取消的标 cancelled，**不含删除语句**），排程「HomeWorks Quotes」改成 07:00 起 14 小时内每 15 分钟一次（`task_xml(repeat_minutes=15)`）；
分行电脑也要跑一次 `setup_quotes.bat`。RPC：`bi_delivery_lookup`（DO 单号可只打数字尾码，或打电话）、`bi_delivery_docs(date)`、`bi_customer_set_address`、
`bi_customer_set_geo`、`bi_delivery_settings`（出发点 `customer_settings.depot` + 司机 `bi.delivery_driver`）、`bi_delivery_set_depot` / `_driver_save`
（owner / manager）、`bi_delivery_run_save` / `bi_delivery_runs`（`bi.delivery_run` 排单纪录）。依 `bi_company()` 限分行。同日（已上线 dpl_8wz78nikWfMpDgAiTXVwWUTK5N6X）使用者要「只输入今天要送的单号，系统自动排路线给顾客资料」→
**一键排单**：整串贴 DO 单号（空白 / 换行 / 逗号分开，只打数字尾码也可）→ `bi_delivery_lookup_many(text[])`（每个单号一笔、找不到 found=false）→
自动找坐标、排顺序，列出找不到 / 已取消 / 没地址的单；另有**独立页 `/delivery.html`**（`src/delivery/main.tsx`，顾客资料页右上也有按钮），
按顾客名字开 `loyalty.html#m=<编号>`。实测 HQ 的 DO 单号格式 `DO-017707`，近 60 天 979 张，只有约 200 张客户名称带电话，其余多是有账号的
水工 / 承包商（编号 `A:HOMEWORKSSB:300-xxxx`）；顾客资料地址当时 0 笔。使用者随后同意**从 DO 读送货地址**（「如果有修改，就手动修改」）：
`quote_push.py` 读 DO 表头 DeliverAddr1～4 + DeliverPostCode（不用 CONCAT_WS，旧 SQL Server 没有；不用发票地址），migration `delivery_do_address`：
地址顺序 **手动改过的（只改那张 DO，`address_override`，同步不盖）> DO 的 Deliver Address > 顾客资料**（承包商每张 DO 可能是不同工地，所以单据优先），
坐标改存 `bi.geo_cache`（按地址），视图 `bi.delivery_doc_full`。
**BI 网页**：Vercel 专案 `homeworks-bi`（team leslie-tee，Vite + React，非 git 部署），
2026-09-26 已加「电商月报」分页读 `bi_report_month_*`；改法与部署步骤见 `docs/bi_web/README.md`
（MCP `mcp__Vercel__*` 可读档案树、内容与建立部署；list_deployments 会 403，用 get_project 拿
latestDeployment）。

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
| `scripts/supabase_push.py` + `setup_bi.bat` | 月报成品推进 HomeWorks BI（Supabase，见下节）；`--set-key` 贴金钥、`--check` 测连线、`YYYY-MM` 推送、`--setup-branch` 分行流程 |
| `scripts/branch_actual.py` + `setup_branch.bat` / `run_branch.bat` | 分行电脑用：分行当月实际销售额 → BI（见下节）；排程模式顺便推分行报价单 |
| `scripts/quote_push.py` + `setup_quotes.bat` / `run_quotes.bat` | 报价单（Quotation）与送货单（DO）只读 → BI，给报价没成交提醒与送货排单；排程「HomeWorks Quotes」营业时间每 15 分钟（SERVER 与分行电脑各登记一次） |
| `scripts/deploy_bi_web.py` + `deploy_bi_web.bat` | BI 网页（Vercel homeworks-bi）改版上线：用使用者自己的 Vercel 金钥（`vercel_token.json`，不进 git），线上档原样引用、只传改版目录（预设 `docs/bi_web/loyalty/`）的档；`overlay.json` 写明换掉哪些线上档与当初的底，线上被改过就停；`--check` 只检查、`--set-key` 换金钥 |
| `config.json` | SKU 趋势清单、报表渠道栏 |
| `autocount.example.json` | 连线与对照设定模板 |
| `tests/` | `python -m pytest tests -q`，77 个测试：网页行为（示范资料）+ 登入流程（假 sign_in）+ 抓数纯函数（分类、型号、Top 10）+ BI 网页部署（假 Vercel），都不需 AutoCount 或网路 |
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
5. **2026-09-28 使用者决定**：BI 网页「够用了」，本机营运网页（webapp/、localhost:8000）不再投入，
   Cloudflare Tunnel / HTTPS 对外通道因此不做。webapp 保留但不加功能；新功能一律做在 BI（Supabase + Vercel）。
   分行电脑与 SERVER 都已用 `update_from_zip.bat` 更新到 d 版（2026-09-28 晚）；分行排程已改每天，BI 有 2026-09 至今
   （9/28 时 1,046,421.66）与各 agent 的 direct。以后更新程式：下载 ZIP → 双击 update_from_zip.bat（Windows 的
   Extract All 不会真的取代旧档，别再用）。

## 写码惯例

- Python 3.11+，型别标注，中文注释；错误讯息要告诉使用者**该检查什么**，不要只丢 traceback
- 合计 / 百分比在 Excel 里用公式，不写死数值
- 改动后跑测试；新功能补测试
- 提交讯息说明「为什么」，不只「做了什么」
