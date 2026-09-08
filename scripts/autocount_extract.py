#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从 AutoCount 抓取某个月的数据，写成 data/YYYY-MM.json。

    python scripts/autocount_extract.py 2026-09
    python scripts/autocount_extract.py 2026-09 --dry-run   # 只印出 SQL，不连数据库

抓取范围：
    sku_qty         指定 SKU 的当月销量（Shopee / Lazada）
    top10_up/down   当月销量最高 / 最低的十个 SKU
    forecast_all    销售汇总（全品牌）：类别 × 渠道
    forecast_hemos  销售汇总（Hemos & Hemos X）

不抓（AutoCount 里没有，属 Shopee/Lazada 后台的广告与直播数据）：
    ads, live_sales —— 这两段若档案里已有数值会原样保留，不会被覆盖。
"""

import argparse
import calendar
import json
import sys
from collections import defaultdict
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from autocount_db import connect, fetch, load_autocount_config   # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"


# --------------------------------------------------------------- SQL 组装
def channel_case(cfg):
    """产生把单据归类到报表渠道栏的 SQL CASE 运算式。"""
    rules = cfg["channel_rules"]
    mode = rules["mode"]
    default = rules.get("default_channel", "cash")

    if mode == "custom_sql":
        return rules["custom_sql_case"]

    field = {"debtor": "h." + cfg["schema"]["header_debtor"],
             "project": "h.ProjNo",
             "salesagent": "h.Agent"}.get(mode)
    if not field:
        sys.exit(f"channel_rules.mode 不支援：{mode}")

    whens = []
    for chan, codes in rules["map"].items():
        if chan.startswith("_") or not codes:
            continue
        lst = ", ".join("'" + str(c).replace("'", "''") + "'" for c in codes)
        whens.append(f"WHEN {field} IN ({lst}) THEN '{chan}'")
    if not whens:
        sys.exit("channel_rules.map 里一个渠道都没设定，无法分辨渠道栏。")
    return "CASE " + " ".join(whens) + f" ELSE '{default}' END"


def line_source(cfg):
    """把 Invoice / CashSale / CreditNote 等单据合并成一张明细表。"""
    s = cfg["schema"]
    chan = channel_case(cfg)
    parts = []
    for doc in s["sales_documents"]:
        parts.append(f"""
        SELECT h.{s['header_date']} AS DocDate,
               ({chan}) AS Channel,
               d.{s['detail_item']} AS ItemCode,
               ({doc['sign']}) * d.{s['detail_qty']}    AS Qty,
               ({doc['sign']}) * d.{s['detail_amount']} AS Amount
        FROM [{doc['header']}] h
        JOIN [{doc['detail']}] d ON d.{s['header_key']} = h.{s['header_key']}""")
    return "\n        UNION ALL\n".join(parts)


def sql_summary(cfg, brand_only):
    s = cfg["schema"]
    brand = ""
    if brand_only:
        vals = ", ".join("'" + v.replace("'", "''") + "'"
                         for v in cfg["brand_filter"]["values"])
        brand = f"AND i.[{cfg['brand_filter']['field']}] IN ({vals})"
    return f"""
WITH lines AS ({line_source(cfg)}
)
SELECT ISNULL(i.[{s['item_category']}], '(未分类)') AS Category,
       l.Channel,
       SUM(l.Qty)    AS Qty,
       SUM(l.Amount) AS Amount
FROM lines l
LEFT JOIN [{s['item_table']}] i ON i.[{s['item_code']}] = l.ItemCode
WHERE l.DocDate >= ? AND l.DocDate <= ? {brand}
GROUP BY ISNULL(i.[{s['item_category']}], '(未分类)'), l.Channel
ORDER BY 1, 2
"""


def sql_item_qty(cfg):
    return f"""
WITH lines AS ({line_source(cfg)}
)
SELECT l.ItemCode, l.Channel, SUM(l.Qty) AS Qty
FROM lines l
WHERE l.DocDate >= ? AND l.DocDate <= ?
GROUP BY l.ItemCode, l.Channel
HAVING SUM(l.Qty) <> 0
ORDER BY 1
"""


# ----------------------------------------------------------------- 组装 JSON
def month_range(month):
    y, m = (int(x) for x in month.split("-"))
    return date(y, m, 1).isoformat(), date(y, m, calendar.monthrange(y, m)[1]).isoformat()


def build_forecast(rows, channels):
    """[(category, channel, qty, amount)] → 报表用的类别列表。"""
    by_cat = defaultdict(lambda: {"qty": 0, **{c: 0.0 for c in channels}})
    for cat, chan, qty, amt in rows:
        rec = by_cat[cat]
        rec["qty"] += int(qty or 0)
        if chan in channels:
            rec[chan] += float(amt or 0)
    out = []
    for cat in sorted(by_cat):
        rec = by_cat[cat]
        item = {"category": cat, "qty": rec["qty"]}
        for c in channels:
            if round(rec[c], 2):
                item[c] = round(rec[c], 2)
        out.append(item)
    return out


def build_month_doc(cfg, base_cfg, month, summary_all, summary_hemos, item_rows, existing):
    channels = [c["key"] for c in base_cfg["forecast_channels"]]
    platform_channels = cfg["sku_trend"]["platform_channels"]

    qty_by_item_chan = defaultdict(int)
    qty_by_item = defaultdict(int)
    for code, chan, qty in item_rows:
        code = (code or "").strip()
        qty_by_item_chan[(code, chan)] += int(qty or 0)
        qty_by_item[code] += int(qty or 0)

    sku_qty = {}
    for platform, chan in platform_channels.items():
        sku_qty[platform] = {sku: qty_by_item_chan.get((sku, chan), 0)
                             for sku in base_cfg["sku_trend_list"]}

    laz = cfg["sku_trend"]["platform_channels"].get("LAZADA", "lazada")
    sho = cfg["sku_trend"]["platform_channels"].get("SHOPEE", "shopee")
    sold = [(c, q) for c, q in qty_by_item.items() if q > 0]
    ranked = sorted(sold, key=lambda x: (-x[1], x[0]))
    n = int(cfg["top10"].get("count", 10))

    up = ranked[:n]
    up_codes = {c for c, _ in up}
    # 有销售的 SKU 少于 2n 时，避免同一个 SKU 同时出现在上升与下降榜
    down = sorted((p for p in ranked if p[0] not in up_codes),
                  key=lambda x: (x[1], x[0]))[:n]

    def top_rows(pairs):
        return [{"sku": c,
                 "lazada": qty_by_item_chan.get((c, laz), 0),
                 "shopee": qty_by_item_chan.get((c, sho), 0)} for c, _ in pairs]

    doc = {
        "month": month,
        "_产生方式": f"由 scripts/autocount_extract.py 于 {date.today().isoformat()} "
                     f"自 AutoCount 账套 {cfg['connection']['database']} 抓取。"
                     f"ads 与 live_sales 两段不在 AutoCount 内，需自 Shopee/Lazada 后台填入。",
        "sku_qty": sku_qty,
        "ads": existing.get("ads", {}),
        "live_sales": existing.get("live_sales", {}),
        "top10_up": top_rows(up),
        "top10_down": top_rows(down),
        "forecast_all": build_forecast(summary_all, channels),
        "forecast_hemos": build_forecast(summary_hemos, channels),
    }
    return doc


# ------------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("month", help="要抓取的月份，格式 YYYY-MM")
    ap.add_argument("--dry-run", action="store_true", help="只印出要执行的 SQL，不连数据库")
    args = ap.parse_args()

    cfg = load_autocount_config()
    base_cfg = json.loads((ROOT / "config.json").read_text(encoding="utf-8"))
    start, end = month_range(args.month)

    if args.dry_run:
        print("-- 销售汇总（全品牌） --", sql_summary(cfg, False), sep="\n")
        print("-- 销售汇总（Hemos） --", sql_summary(cfg, True), sep="\n")
        print("-- SKU 销量 --", sql_item_qty(cfg), sep="\n")
        print(f"-- 期间参数：{start} ~ {end}")
        return

    conn = connect(cfg)
    _, rows_all = fetch(conn, sql_summary(cfg, False), (start, end))
    _, rows_hemos = fetch(conn, sql_summary(cfg, True), (start, end))
    _, rows_item = fetch(conn, sql_item_qty(cfg), (start, end))

    path = DATA_DIR / f"{args.month}.json"
    existing = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    doc = build_month_doc(cfg, base_cfg, args.month, rows_all, rows_hemos, rows_item, existing)

    DATA_DIR.mkdir(exist_ok=True)
    path.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"已写入 / written: {path}")
    print(f"  销售汇总（全品牌）{len(doc['forecast_all'])} 个类别，"
          f"（Hemos）{len(doc['forecast_hemos'])} 个类别，SKU {len(rows_item)} 笔")
    if not doc["ads"]:
        print("  提醒：ads 与 live_sales 需自 Shopee/Lazada 后台填入后才会出现在报表上。")


if __name__ == "__main__":
    main()
