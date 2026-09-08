# 月度电商报表 / Monthly E-Commerce Report

把每个月要整理的那几张表（Shopee / Lazada SKU 趋势、广告、直播、Top 10、销售汇总）
做成一个可重复执行的产生器：**每月只需要填数字，报表自动排版、自动算合计与图表。**

## 每月怎么做（3 步）

```bash
# 1. 复制模板，改成当月
cp data/_template.json data/2026-09.json

# 2. 编辑 data/2026-09.json，填入当月数字

# 3. 生成报表
python3 scripts/generate_report.py 2026-09
# → output/月度报表_2026-09.xlsx
```

不带月份参数时，会自动使用 `data/` 内最新的月份：

```bash
python3 scripts/generate_report.py
```

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
config.json                 # SKU 清单、渠道栏位、月份名称等设定
data/_template.json         # 每月数据模板（复制它开始）
data/2026-01.json … 08.json # 各月数据（2026-08 为完整示范）
scripts/generate_report.py  # 报表产生器
output/月度报表_2026-08.xlsx # 产出
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
pip install openpyxl
```

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
