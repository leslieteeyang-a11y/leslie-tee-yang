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
  `ops.attendance`（一人一天一笔：上班 / 午休 / 下班 + 自拍路径 + GPS）、`ops.punch_correction`（主管 → HR 两段；HR 可直接定案）、
  `ops.geofence`（打卡点，按分店）、`ops.hr_shift`（班别；2026-10-02 起 HomeWorks 实际时间 = 星期一到六 09:00–17:30、星期日休，migration `ops_att_hours`；**午休不定时段、一次一小时**（`ops_att_flex_lunch`：迟回 = 实际休息超过 lunch_end − lunch_start 的分钟数；星期五也一样一小时，`ops_att_no_friday` 拿掉了 AttendX 的星期五礼拜加时（friday_prayer 栏位保留但不用）；lunch_start 只当外出公务补卡的名义时间；打卡页有「午休下班」「午休上班」按键（`ops_att_lunch_buttons`，punch 动作 lunch_out / lunch_in；午休中不能直接下班），旧的「下班卡在 10:30–16:00 之间再打上班 = 吃饭回来」仍保留；整天的星期六也有午休）。「每月指定星期六」功能保留但没有班别使用，设定页自动隐藏）、
  `ops.holiday`、`ops.work_saturday`、`ops.field_checkin`；`ops.staff` 加 manager_id / shift / geofence_exempt / friday_prayer / join_date。
  自拍放 Storage 私有 bucket `ops-hr`（路径 `<staff_id>/…`，policy 呼叫 `public.ops_hr_file_ok`），前端压到 480px JPEG 约 30 KB。
  时间一律 Asia/Kuala_Lumpur；测试用 `ops.fake_now`（只在有 `ops_test_marker` schema 的本机测试库生效）。
  测试：`portal/supabase/tests/att_test.sql`（run.sh 会接著 ops_test.sql 跑）。管理层预设对「人事」可审批 → 店长批补卡一次定案。
  AttendX 原始码只在对话上传的 zip 里，没有放进 repo；之后的请假、加班、薪资照同样方式逐模块搬。
  **注意**：Supabase 资料库已 434 MB（免费方案上限 500 MB，主要是 BI 资料），照片放 Storage 不占资料库。
- **中英双语（2026-09-28）**：`portal/src/i18n*.ts` 是 DOM 翻译层，切到 EN 时 MutationObserver 只把「整段完全等于」
  字典键（去头尾空白）或符合 `i18n-patterns.ts` 格式的文字节点 / placeholder / title 换成英文，员工输入的资料不动。
  **新增介面文字一定要把中文原句加进 `i18n-dict-*.ts`**（带数字 / 名称的句子加 pattern；数据库错误讯息放 `i18n-dict-db.ts`），
  否则英文模式会漏翻。语言存 localStorage `hw-lang`，切换会重新载入。
- 路线图（AttendX 搬迁顺序，使用者 2026-10-01 选定）：打卡 + 补卡 ✓ → 请假 → 加班 → 薪资；其余：2 销售；
  3 仓库 + 送货安装；4 收款、佣金、报表；5 HR、薪资。**使用者决定（2026-09-26）：所有功能统一在营运系统，
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
