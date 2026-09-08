#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""月度电商报表生成器 / Monthly e-commerce report generator.

用法 Usage:
    python3 scripts/generate_report.py 2026-08
    python3 scripts/generate_report.py            # 使用 data/ 内最新的月份

读取 config.json 与 data/YYYY-MM.json，输出 output/月度报表_YYYY-MM.xlsx。
SKU 月度趋势表会自动汇总 data/ 目录内同一年份的所有月份文件。
"""

import json
import sys
from datetime import date
from pathlib import Path

from openpyxl import Workbook
from openpyxl.chart import LineChart, Reference
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
OUT_DIR = ROOT / "output"

FONT = "Arial"
THIN = Side(style="thin", color="000000")
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)
HEAD_FILL = PatternFill("solid", fgColor="D9D9D9")
TITLE_FILL = PatternFill("solid", fgColor="BFBFBF")
INT_FMT = "#,##0;-#,##0;;@"          # 0 显示为空白
INT_FMT_Z = "#,##0"                  # 0 照常显示
MONEY_FMT = "#,##0.00;-#,##0.00;;@"
MONEY_FMT_Z = "#,##0.00"
PCT_FMT = "0.00%"

MONTH_CN = {1: "1月", 2: "2月", 3: "3月", 4: "4月", 5: "5月", 6: "6月",
            7: "7月", 8: "8月", 9: "9月", 10: "10月", 11: "11月", 12: "12月"}


# ----------------------------------------------------------------- helpers
def load_config():
    return json.loads((ROOT / "config.json").read_text(encoding="utf-8"))


def load_month(month):
    path = DATA_DIR / f"{month}.json"
    if not path.exists():
        sys.exit(f"找不到数据文件 / data file not found: {path}")
    return json.loads(path.read_text(encoding="utf-8"))


def available_months(year):
    return sorted(p.stem for p in DATA_DIR.glob(f"{year}-[0-1][0-9].json"))


def style_cell(cell, *, bold=False, fmt=None, fill=None, align="center", size=10):
    cell.font = Font(name=FONT, bold=bold, size=size)
    cell.border = BORDER
    cell.alignment = Alignment(horizontal=align, vertical="center")
    if fmt:
        cell.number_format = fmt
    if fill:
        cell.fill = fill


def block_title(ws, row, col_start, col_end, text):
    ws.merge_cells(start_row=row, start_column=col_start, end_row=row, end_column=col_end)
    for c in range(col_start, col_end + 1):
        style_cell(ws.cell(row=row, column=c), bold=True, fill=TITLE_FILL)
    ws.cell(row=row, column=col_start).value = text


def set_widths(ws, widths, start_col=1):
    for i, w in enumerate(widths):
        ws.column_dimensions[get_column_letter(start_col + i)].width = w


# ------------------------------------------------------------ sheet: cover
def sheet_cover(wb, cfg, month, months_with_data):
    ws = wb.create_sheet("说明 Read me")
    ws.sheet_view.showGridLines = False
    set_widths(ws, [26, 86])
    y, m = month.split("-")
    rows = [
        ("报表月份 Report month", f"{y} 年 {MONTH_CN[int(m)]}  ({month})"),
        ("生成日期 Generated on", date.today().isoformat()),
        ("数据来源 Data source", f"data/{month}.json（本月明细） + data/{y}-*.json（SKU 全年趋势）"),
        ("金额单位 Currency", "RM（马币）"),
        ("已有数据的月份 Months on file", ", ".join(months_with_data)),
        ("", ""),
        ("每月更新步骤 Monthly steps", ""),
        ("1", "复制 data/_template.json 为 data/YYYY-MM.json（例如 data/2026-09.json）"),
        ("2", "把当月数字填进去：SKU 数量、广告、直播、Top 10、销售汇总两张表"),
        ("3", "执行：python3 scripts/generate_report.py YYYY-MM"),
        ("4", "在 output/ 取得 月度报表_YYYY-MM.xlsx"),
        ("", ""),
        ("工作表说明 Sheets", ""),
        ("Shopee SKU", "指定 SKU 的 Shopee 全年月度销量表 + 折线图（自动汇总各月数据文件）"),
        ("Lazada SKU", "指定 SKU 的 Lazada 全年月度销量表 + 折线图"),
        ("广告与直播", "Shopee Ads、Lazada Sponsored Affiliate、Shopee AMS、Live Sales"),
        ("Top 10", "当月销量上升 / 下降前十的 SKU（Lazada、Shopee 与合计）"),
        ("销售汇总-全品牌", "Sales Forecast Summary (All brand)"),
        ("销售汇总-Hemos", "Sales Forecast Summary (Hemos & Hemos X only)"),
        ("", ""),
        ("备注 Notes", "表内合计、百分比、平均单价皆为 Excel 公式，改动明细数字后会自动重算。"),
        ("", "数值为 0 或未填写的格子显示为空白；月度合计行的 0 会照常显示。"),
        ("", "SKU 趋势表的 SKU 清单在 config.json 的 sku_trend_list 内维护。"),
    ]
    ws["A1"] = f"月度电商报表 / Monthly E-Commerce Report — {month}"
    ws["A1"].font = Font(name=FONT, bold=True, size=16)
    ws.merge_cells("A1:B1")
    ws.row_dimensions[1].height = 24
    r = 3
    for label, value in rows:
        ws.cell(row=r, column=1, value=label).font = Font(name=FONT, bold=True, size=10)
        c = ws.cell(row=r, column=2, value=value)
        c.font = Font(name=FONT, size=10)
        c.alignment = Alignment(vertical="center", wrap_text=True)
        r += 1
    return ws


# --------------------------------------------------------- sheet: SKU 趋势
def sheet_sku_trend(wb, cfg, platform, monthly_docs):
    months = cfg["months"]
    skus = cfg["sku_trend_list"]
    ws = wb.create_sheet(f"{platform.capitalize()} SKU")
    set_widths(ws, [18] + [9] * 12)

    block_title(ws, 1, 1, 13, platform)

    ws.cell(row=2, column=1, value=cfg["year"])
    style_cell(ws.cell(row=2, column=1), bold=True, fill=HEAD_FILL)
    for i, mname in enumerate(months):
        ws.cell(row=2, column=2 + i, value=mname)
        style_cell(ws.cell(row=2, column=2 + i), bold=True, fill=HEAD_FILL)

    first_row = 3
    for r, sku in enumerate(skus, start=first_row):
        ws.cell(row=r, column=1, value=sku)
        style_cell(ws.cell(row=r, column=1), align="left")
        for i in range(12):
            key = f"{cfg['year']}-{i + 1:02d}"
            cell = ws.cell(row=r, column=2 + i)
            doc = monthly_docs.get(key)
            if doc is not None:
                cell.value = doc.get("sku_qty", {}).get(platform, {}).get(sku, 0)
            style_cell(cell, fmt=INT_FMT)
    last_row = first_row + len(skus) - 1

    total_row = last_row + 1
    ws.cell(row=total_row, column=1, value="TOTAL")
    style_cell(ws.cell(row=total_row, column=1), bold=True, align="left", fill=HEAD_FILL)
    for i in range(12):
        col = get_column_letter(2 + i)
        cell = ws.cell(row=total_row, column=2 + i,
                       value=f"=SUM({col}{first_row}:{col}{last_row})")
        style_cell(cell, bold=True, fmt=INT_FMT_Z, fill=HEAD_FILL)

    # 折线图：X 轴为 SKU，每个月一条线（与原报表一致）
    chart = LineChart()
    chart.title = platform
    chart.style = 2
    chart.height = 10
    chart.width = 30
    chart.y_axis.title = "QTY"
    data = Reference(ws, min_col=2, max_col=13, min_row=2, max_row=last_row)
    cats = Reference(ws, min_col=1, min_row=first_row, max_row=last_row)
    chart.add_data(data, titles_from_data=True, from_rows=False)
    chart.set_categories(cats)
    for s in chart.series:
        s.smooth = False
    ws.add_chart(chart, f"A{total_row + 2}")
    return ws


# ------------------------------------------------------------ sheet: 广告
def ads_block(ws, row, col, title, label, rows_data):
    """写一个 广告 区块，返回下一个可用行。"""
    c0 = col
    block_title(ws, row, c0, c0 + 3, title)
    headers = [label, "ADS GMV(RM)", "ADS EXPENSE(RM)", "%"]
    for i, h in enumerate(headers):
        ws.cell(row=row + 1, column=c0 + i, value=h)
        style_cell(ws.cell(row=row + 1, column=c0 + i), bold=True, fill=HEAD_FILL)

    first = row + 2
    for i, item in enumerate(rows_data):
        r = first + i
        gmv_c = get_column_letter(c0 + 1)
        exp_c = get_column_letter(c0 + 2)
        ws.cell(row=r, column=c0, value=item["period"])
        style_cell(ws.cell(row=r, column=c0), align="left")
        ws.cell(row=r, column=c0 + 1, value=item.get("gmv", 0))
        style_cell(ws.cell(row=r, column=c0 + 1), fmt=MONEY_FMT_Z)
        ws.cell(row=r, column=c0 + 2, value=item.get("expense", 0))
        style_cell(ws.cell(row=r, column=c0 + 2), fmt=MONEY_FMT_Z)
        ws.cell(row=r, column=c0 + 3, value=f"=IFERROR({exp_c}{r}/{gmv_c}{r},0)")
        style_cell(ws.cell(row=r, column=c0 + 3), fmt=PCT_FMT)
    last = first + len(rows_data) - 1

    tr = last + 1
    ws.cell(row=tr, column=c0, value="TOTAL")
    style_cell(ws.cell(row=tr, column=c0), bold=True, align="left", fill=HEAD_FILL)
    for off in (1, 2):
        cl = get_column_letter(c0 + off)
        ws.cell(row=tr, column=c0 + off, value=f"=SUM({cl}{first}:{cl}{last})")
        style_cell(ws.cell(row=tr, column=c0 + off), bold=True, fmt=MONEY_FMT_Z, fill=HEAD_FILL)
    gmv_c, exp_c = get_column_letter(c0 + 1), get_column_letter(c0 + 2)
    ws.cell(row=tr, column=c0 + 3, value=f"=IFERROR({exp_c}{tr}/{gmv_c}{tr},0)")
    style_cell(ws.cell(row=tr, column=c0 + 3), bold=True, fmt=PCT_FMT, fill=HEAD_FILL)
    return tr + 2


def sheet_ads(wb, cfg, month, doc):
    ws = wb.create_sheet("广告与直播")
    set_widths(ws, [16, 16, 18, 9, 3, 22, 16, 18, 9, 3, 14, 12])
    label = f"{month_label(month)}."
    ads = doc.get("ads", {})

    next_row = ads_block(ws, 1, 1, "SHOPEE ADS", label, ads.get("SHOPEE ADS", []))
    ads_block(ws, 1, 6, "LAZADA SPONSORED AFFILIATE", label,
              ads.get("LAZADA SPONSORED AFFILIATE", []))
    ads_block(ws, next_row, 1, "SHOPEE AMS", label, ads.get("SHOPEE AMS", []))

    # Live sales
    live = doc.get("live_sales", {})
    c0 = 11
    block_title(ws, 1, c0, c0 + 1, month_label(month))
    ws.cell(row=2, column=c0, value="LIVE SALES")
    ws.cell(row=2, column=c0 + 1, value="RM")
    for i in range(2):
        style_cell(ws.cell(row=2, column=c0 + i), bold=True, fill=HEAD_FILL)
    r = 3
    for ch in cfg["live_sales_channels"]:
        ws.cell(row=r, column=c0, value=ch)
        style_cell(ws.cell(row=r, column=c0), align="left")
        ws.cell(row=r, column=c0 + 1, value=live.get(ch, 0))
        style_cell(ws.cell(row=r, column=c0 + 1), fmt=MONEY_FMT_Z)
        r += 1
    cl = get_column_letter(c0 + 1)
    ws.cell(row=r, column=c0, value="TOTAL")
    style_cell(ws.cell(row=r, column=c0), bold=True, align="left", fill=HEAD_FILL)
    ws.cell(row=r, column=c0 + 1, value=f"=SUM({cl}3:{cl}{r - 1})")
    style_cell(ws.cell(row=r, column=c0 + 1), bold=True, fmt=MONEY_FMT_Z, fill=HEAD_FILL)
    return ws


# ----------------------------------------------------------- sheet: Top 10
def top_block(ws, col, title, label, items):
    c0 = col
    headers = [label, title, "LAZADA", "SHOPEE", "TOTAL (QTY)"]
    for i, h in enumerate(headers):
        ws.cell(row=1, column=c0 + i, value=h)
        style_cell(ws.cell(row=1, column=c0 + i), bold=True, fill=HEAD_FILL)
    for i, item in enumerate(items):
        r = 2 + i
        laz = get_column_letter(c0 + 2)
        sho = get_column_letter(c0 + 3)
        ws.cell(row=r, column=c0, value=i + 1)
        style_cell(ws.cell(row=r, column=c0), fmt=INT_FMT_Z)
        ws.cell(row=r, column=c0 + 1, value=item["sku"])
        style_cell(ws.cell(row=r, column=c0 + 1), align="left")
        ws.cell(row=r, column=c0 + 2, value=item.get("lazada", 0))
        style_cell(ws.cell(row=r, column=c0 + 2), fmt=INT_FMT_Z)
        ws.cell(row=r, column=c0 + 3, value=item.get("shopee", 0))
        style_cell(ws.cell(row=r, column=c0 + 3), fmt=INT_FMT_Z)
        ws.cell(row=r, column=c0 + 4, value=f"={laz}{r}+{sho}{r}")
        style_cell(ws.cell(row=r, column=c0 + 4), fmt=INT_FMT_Z)


def sheet_top10(wb, cfg, month, doc):
    ws = wb.create_sheet("Top 10")
    set_widths(ws, [12, 18, 11, 11, 13, 3, 12, 18, 11, 11, 13])
    label = f"{month_label(month)}."
    top_block(ws, 1, "TOP 10 UP", label, doc.get("top10_up", []))
    top_block(ws, 7, "TOP 10 DOWN", label, doc.get("top10_down", []))
    return ws


# -------------------------------------------------------- sheet: 销售汇总
def sheet_forecast(wb, cfg, month, rows_data, sheet_name, title):
    channels = cfg["forecast_channels"]
    ws = wb.create_sheet(sheet_name)
    ncol = 3 + len(channels) + 3          # Categories, QTY, channels..., Total, Contribution, Avg
    set_widths(ws, [18, 10] + [14] * len(channels) + [15, 13, 12])

    ws.merge_cells(start_row=1, start_column=1, end_row=1, end_column=ncol - 1)
    ws.cell(row=1, column=1, value=title).font = Font(name=FONT, bold=True, size=13)
    ws.cell(row=1, column=1).alignment = Alignment(horizontal="center")
    ws.merge_cells(start_row=2, start_column=1, end_row=2, end_column=ncol - 1)
    ws.cell(row=2, column=1, value=month_label(month)).font = Font(name=FONT, bold=True, size=11)
    ws.cell(row=2, column=1).alignment = Alignment(horizontal="center")

    headers = ["Categories", "QTY"] + [c["header"] for c in channels] + \
              ["Total RM", "Contribution", "Avg. Price"]
    for i, h in enumerate(headers):
        ws.cell(row=3, column=1 + i, value=h)
        style_cell(ws.cell(row=3, column=1 + i), bold=True, fill=HEAD_FILL)

    first = 4
    ch_first = get_column_letter(3)
    ch_last = get_column_letter(2 + len(channels))
    total_col = 3 + len(channels)
    total_cl = get_column_letter(total_col)
    contrib_col = total_col + 1
    avg_col = total_col + 2

    for i, item in enumerate(rows_data):
        r = first + i
        ws.cell(row=r, column=1, value=item["category"])
        style_cell(ws.cell(row=r, column=1), align="left")
        ws.cell(row=r, column=2, value=item.get("qty", 0))
        style_cell(ws.cell(row=r, column=2), fmt=INT_FMT_Z)
        for j, ch in enumerate(channels):
            cell = ws.cell(row=r, column=3 + j)
            if ch["key"] in item:
                cell.value = item[ch["key"]]
            style_cell(cell, fmt=MONEY_FMT)
        ws.cell(row=r, column=total_col, value=f"=SUM({ch_first}{r}:{ch_last}{r})")
        style_cell(ws.cell(row=r, column=total_col), bold=True, fmt=MONEY_FMT_Z)
    last = first + len(rows_data) - 1
    tr = last + 1

    ws.cell(row=tr, column=1, value="TOTAL")
    style_cell(ws.cell(row=tr, column=1), bold=True, align="left", fill=HEAD_FILL)
    for col in range(2, total_col + 1):
        cl = get_column_letter(col)
        fmt = INT_FMT_Z if col == 2 else MONEY_FMT_Z
        ws.cell(row=tr, column=col, value=f"=SUM({cl}{first}:{cl}{last})")
        style_cell(ws.cell(row=tr, column=col), bold=True, fmt=fmt, fill=HEAD_FILL)

    # Contribution 与 Avg. Price（放在合计行确定后，才能引用 $总额$）
    for r in range(first, tr + 1):
        bold = r == tr
        fill = HEAD_FILL if bold else None
        ws.cell(row=r, column=contrib_col,
                value=f"=IFERROR({total_cl}{r}/${total_cl}${tr},0)")
        style_cell(ws.cell(row=r, column=contrib_col), bold=bold, fmt=PCT_FMT, fill=fill)
        ws.cell(row=r, column=avg_col,
                value=f'=IFERROR({total_cl}{r}/B{r},"")')
        style_cell(ws.cell(row=r, column=avg_col), bold=bold, fmt=MONEY_FMT_Z, fill=fill)

    ws.cell(row=tr + 2, column=1,
            value=f"数据来源 / Source: data/{month}.json（由用户提供的当月实际数字）；"
                  f"Total RM = 各渠道加总，Contribution = Total RM ÷ 合计，Avg. Price = Total RM ÷ QTY。")
    ws.cell(row=tr + 2, column=1).font = Font(name=FONT, size=9, italic=True)
    return ws


# ------------------------------------------------------------------- main
def month_label(month):
    y, m = month.split("-")
    return f"{y} {['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'][int(m)-1]}"


def main():
    cfg = load_config()
    if len(sys.argv) > 1:
        month = sys.argv[1]
    else:
        months = available_months(cfg["year"])
        if not months:
            sys.exit("data/ 内没有任何数据文件")
        month = months[-1]

    doc = load_month(month)
    year = month.split("-")[0]
    monthly_docs = {}
    for m in available_months(int(year)):
        monthly_docs[m] = json.loads((DATA_DIR / f"{m}.json").read_text(encoding="utf-8"))

    wb = Workbook()
    wb.remove(wb.active)
    sheet_cover(wb, cfg, month, sorted(monthly_docs))
    for platform in cfg["sku_trend_platforms"]:
        sheet_sku_trend(wb, cfg, platform, monthly_docs)
    sheet_ads(wb, cfg, month, doc)
    sheet_top10(wb, cfg, month, doc)
    sheet_forecast(wb, cfg, month, doc.get("forecast_all", []),
                   "销售汇总-全品牌", "Sales Forecast Summary (All brand)")
    sheet_forecast(wb, cfg, month, doc.get("forecast_hemos", []),
                   "销售汇总-Hemos", "Sales Forecast Summary (Hemos & Hemos X only)")

    OUT_DIR.mkdir(exist_ok=True)
    out = OUT_DIR / f"月度报表_{month}.xlsx"
    wb.save(out)
    print(f"已生成 / written: {out}")


if __name__ == "__main__":
    main()
