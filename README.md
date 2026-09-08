# 月度电商报表 / Monthly E-Commerce Report

把每个月要整理的那几张表（Shopee / Lazada SKU 趋势、广告、直播、Top 10、销售汇总）
做成一条可重复执行的流水线：**直接从 AutoCount 抓数 → 自动排版、自动算合计与图表 → 输出 Excel。**

## 每月怎么做

**接上 AutoCount 之后（建议）**——在办公室那台连得到 AutoCount 的电脑上：

```bat
run_monthly.bat
```

抓数 + 产生报表一步到位，也可以交给 Windows 工作排程器每月自动跑，
月报自己出现在 `output/`。设定方式见下一节。

**还没接 AutoCount 时**，也可以手动填数字：

```bash
cp data/_template.json data/2026-09.json     # 1. 复制模板
# 2. 编辑 data/2026-09.json，填入当月数字
python3 scripts/generate_report.py 2026-09   # 3. 生成报表
# → output/月度报表_2026-09.xlsx
```

不带月份参数时，`generate_report.py` 会自动使用 `data/` 内最新的月份。

## 从 AutoCount 自动抓数

报表的数字不必手打 —— `scripts/autocount_extract.py` 会直接连 AutoCount 的
SQL Server 账套，把当月的销售明细汇总成 `data/YYYY-MM.json`，接着
`scripts/generate_report.py` 产生 Excel。

### 装在哪里

AutoCount 装在你们办公室的 Windows 机器上，数据库在内网，所以**这套脚本必须
装在那台连得到 AutoCount 的电脑上**（或同一个内网的任一台电脑）。装好以后可以
完全自动，不需要人工介入。

### 安装（只做一次）

```bat
pip install openpyxl pyodbc
copy autocount.example.json autocount.json
```

编辑 `autocount.json`，填入：

| 项目 | 说明 |
|---|---|
| `connection` | SQL Server 位址、账套（database）、账号密码 |
| `schema` | AutoCount 的表名 / 栏名（各版本略有不同，用下面的探查脚本确认） |
| `channel_rules` | 报表的渠道栏（Shopee / Lazada / Cash / 水工 / Southern / Tiktok / Shopify）在 AutoCount 里怎么分辨 —— 通常是不同的客户账号（Debtor Code） |
| `brand_filter` | 第二张汇总表 (Hemos & Hemos X only) 的品牌筛选条件 |

`autocount.json` 内含密码，已被 `.gitignore` 排除，不会被提交。

### 先确认账套结构

```bat
python scripts\autocount_discover.py
```

会产生 `discovery_<账套名>.txt`，列出销售单据、商品、客户等资料表的栏位与少量
样本。依它的结果修正 `autocount.json` 的 `schema` 段即可。

### 每月执行

```bat
run_monthly.bat
```

预设抓「上个月」，抓完直接产生报表。指定月份：`run_monthly.bat 2026-09`。

**全自动**：把 `run_monthly.bat` 加进 Windows 工作排程器，设每月 1 号早上执行，
月报就会自动出现在 `output/`。

先看 SQL 不连数据库：

```bat
python scripts\autocount_extract.py 2026-09 --dry-run
```

### AutoCount 抓得到 / 抓不到什么

| 报表区块 | 来源 |
|---|---|
| Shopee / Lazada SKU 月度销量 | ✅ AutoCount（销售单据明细） |
| Top 10 上升 / 下降 | ✅ AutoCount（当月销量最高 / 最低的十个 SKU） |
| 销售汇总（全品牌 / Hemos） | ✅ AutoCount（类别 × 渠道） |
| Shopee Ads、Lazada Sponsored Affiliate、Shopee AMS | ❌ 在 Shopee / Lazada 卖家后台，不在 AutoCount |
| Live Sales | ❌ 同上 |

广告与直播那两段要自己填进 `data/YYYY-MM.json` 的 `ads` 与 `live_sales`；
抓数脚本**不会覆盖**这两段已填好的内容。

## 报表内容（工作表）

| 工作表 | 内容 |
|---|---|
| 说明 Read me | 报表月份、数据来源、每月更新步骤 |
| Shopee SKU | 指定 SKU 的 Shopee 全年月度销量表 + 折线图 |
| Lazada SKU | 指定 SKU 的 Lazada 全年月度销量表 + 折线图 |
| 广告与直播 | Shopee Ads、Lazada Sponsored Affiliate、Shopee AMS、Live Sales |
| Top 10 | 当月销量上升 / 下降前十 SKU（Lazada、Shopee、合计） |
| 销售汇总-全品牌 | Sales Forecast Summary (All brand) |
| 销售汇总-Hemos | Sales Forecast Summary (Hemos & Hemos X only) |

SKU 趋势表会自动读取 `data/` 内**同一年份的所有月份文件**，所以每加一个月，
Jan–Dec 的表和折线图就自动往前推进一格，不需要手动重打全年数据。

## 文件结构

```
autocount.example.json         # AutoCount 连线与栏位对应设定（复制为 autocount.json）
config.json                    # SKU 清单、渠道栏位、月份名称等设定
run_monthly.bat                # 每月一键（Windows 工作排程器用这个）
scripts/autocount_discover.py  # 探查 AutoCount 账套结构
scripts/autocount_extract.py   # 从 AutoCount 抓当月数据 → data/YYYY-MM.json
scripts/generate_report.py     # data/YYYY-MM.json → Excel 报表
scripts/run_monthly.py         # 抓数 + 产报表
data/_template.json            # 手动填数据时的模板
data/2026-01.json … 08.json    # 各月数据（2026-08 为完整示范）
output/月度报表_2026-08.xlsx    # 产出
```

## 设定 `config.json`

- `sku_trend_list`：趋势表要追踪的 SKU（增减 SKU 改这里，两张趋势表同步）
- `forecast_channels`：销售汇总的渠道栏（`key` 是 JSON 里用的键，`header` 是表头）
- `live_sales_channels`：Live Sales 的渠道
- `year` / `months`：年份与月份表头

## 数据填写规则

- 金额单位一律 **RM**；没有的渠道直接省略该键，表格显示空白。
- **合计、百分比、平均单价都是 Excel 公式**（`SUM`、`Total ÷ 合计`、`Total ÷ QTY`），
  在 Excel 里改动明细数字会自动重算，不必重跑脚本。
- 广告的 `%` = `ADS EXPENSE ÷ ADS GMV`，自动计算。
- Top 10 的 `TOTAL (QTY)` = `LAZADA + SHOPEE`，自动计算。
- 数值 0 或未填写显示为空白；月度 TOTAL 行的 0 会照常显示（与原报表一致）。

## 环境需求

```bash
pip install openpyxl        # 产生报表
pip install pyodbc          # 连 AutoCount 才需要
```

连 AutoCount 还需要 Microsoft 的 **ODBC Driver 17 for SQL Server**（Windows 上多半已随
SQL Server 装好；没有的话到微软官网下载）。

## 数据出处

`data/2026-01.json` … `data/2026-08.json` 的数字，来自用户提供的 2026 年 8 月纸本报表
（Shopee / Lazada SKU 月度表、Shopee Ads、Lazada Sponsored Affiliate、Shopee AMS、
Live Sales、Top 10 Up/Down、Sales Forecast Summary 两张表）。
2026-01 至 2026-07 只含 SKU 月度销量（纸本上只有这部分历史数据）。

## 待核对的一笔数字

`SHOPEE ADS` 四周的 ADS EXPENSE 加总为 **36,064.50**，但纸本 TOTAL 印的是 **36,064.70**，
相差 0.20 —— 推测是 `9~15` 那周应为 `8812.90` 而不是 `8812.70`（纸本该处不易辨认）。
请核对后修改 `data/2026-08.json`，报表的 TOTAL 是公式会自动更新。
除此之外，两张销售汇总的所有渠道合计、QTY、SKU 各月合计、Lazada 广告合计，
都与纸本报表**完全一致**。
