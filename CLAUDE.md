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
`data/2026-08.json` 在 git 里的版本是当初手抄纸本的对照值，只留作历史，SERVER 上会被
extract 覆盖成抓取值。以下是 2026-09-24/25 对账时查清的事实，留给以后判断差异用：
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
| `webapp/` | 营运入口网页（FastAPI + Jinja2；`charts.py` 是纯 SVG 图表）。`sources/` 是资料层：`__init__` 定义介面，`mock` 示范资料，`autocount` 只读实作 |
| `scripts/autocount_*.py` | 连线、侦测、探查、抓月报数据 |
| `scripts/generate_report.py` | `data/YYYY-MM.json` → `output/月度报表_YYYY-MM.xlsx` |
| `scripts/run_monthly.py` + `run_monthly.bat` | 抓数 + 产报表一步到位；`--scheduled` 给排程用，输出写 `logs/`，可依 `config.json` 的 `report_delivery.copy_to` 再复制一份 |
| `scripts/schedule_monthly.py` + `schedule_monthly.bat` | 用 XML 登记 Windows 工作排程器（每月 1 号 08:00，错过会补跑）；`--run-now` / `--status` / `--remove` |
| `config.json` | SKU 趋势清单、报表渠道栏 |
| `autocount.example.json` | 连线与对照设定模板 |
| `tests/` | `python -m pytest tests -q`，25 个测试：网页行为（示范资料）+ 抓数纯函数（分类、型号、Top 10），都不需 AutoCount |
| `README.md` | 使用者视角的完整说明 |

## 后续路线（使用者已同意的顺序）

1. ~~真实数据接通~~（已完成；月报已可由 `schedule_monthly.bat` 每月自动产生，2026-09-25）
2. ~~管理仪表板~~（已完成 v0.2：`/dashboard`，销售来自 Invoice+CashSale−CreditNote+DebitNote）
3. 登入与权限（开到办公室以外之前必须有）
4. 写入 AutoCount 的 POC：一条流程、测试账套、证明失败时不留半张单、重跑不重复过账

## 写码惯例

- Python 3.11+，型别标注，中文注释；错误讯息要告诉使用者**该检查什么**，不要只丢 traceback
- 合计 / 百分比在 Excel 里用公式，不写死数值
- 改动后跑测试；新功能补测试
- 提交讯息说明「为什么」，不只「做了什么」
