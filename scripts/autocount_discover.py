#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""AutoCount 数据库结构探查。

在办公室那台连得到 AutoCount 的电脑上执行：

    python scripts/autocount_discover.py

会产生 discovery_<账套名>.txt，内含：
  - 销售单据、商品、客户等资料表的栏位清单与少量样本
  - 近半年有销售的客户账号（Debtor Code）+ 客户名称 → 用来填渠道对照
  - 商品类别栏的所有相异值 → 确认报表的 Sanitary / Lock / Kitchen 等类别
  - 品牌栏的所有相异值 → 确认 Hemos / Hemos X 的筛选条件

把这个档案给我，我就能把抓数的 SQL 依你们实际的账套结构定稿（不必猜表名栏名）。

档案只含结构与极少量样本，且已被 .gitignore 排除，不会被提交。
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from autocount_db import connect, fetch, load_autocount_config   # noqa: E402

INTEREST = ("invoice", "cashsale", "creditnote", "deliveryorder", "salesorder",
            "item", "debtor", "stock", "brand", "project", "salesagent",
            "department", "uom")
SAMPLE_ROWS = 3
MAX_SAMPLE_TABLES = 12
LOOKBACK_MONTHS = 6


def has_table(conn, table):
    _, rows = fetch(conn, """
        SELECT 1 FROM INFORMATION_SCHEMA.TABLES
        WHERE TABLE_TYPE = 'BASE TABLE' AND TABLE_NAME = ?
    """, (table,))
    return bool(rows)


def columns_of(conn, table):
    _, rows = fetch(conn, """
        SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = ?
    """, (table,))
    return {r[0] for r in rows}


def section_channels(conn, cfg, lines):
    """列出近半年有销售的客户账号，方便把渠道栏对上 Debtor Code。"""
    s = cfg["schema"]
    docs = [d for d in s["sales_documents"] if has_table(conn, d["header"])]
    if not docs:
        lines.append("（找不到设定里的销售单据表，请先依上面的表名清单修正 schema）")
        return
    parts = []
    for d in docs:
        parts.append(f"""SELECT h.{s['header_debtor']} AS Code, h.{s['header_key']} AS K
                         FROM [{d['header']}] h
                         WHERE h.{s['header_date']} >= DATEADD(month, -{LOOKBACK_MONTHS}, GETDATE())""")
    union = "\n        UNION ALL\n        ".join(parts)
    sql = f"""
        WITH d AS ({union})
        SELECT d.Code, COUNT(*) AS Docs
        FROM d GROUP BY d.Code ORDER BY COUNT(*) DESC
    """
    try:
        _, rows = fetch(conn, sql)
    except Exception as exc:                       # noqa: BLE001
        lines.append(f"（查询失败：{exc}）")
        return

    names = {}
    if has_table(conn, "Debtor"):
        cols = columns_of(conn, "Debtor")
        key = "AccNo" if "AccNo" in cols else ("DebtorCode" if "DebtorCode" in cols else None)
        name = "CompanyName" if "CompanyName" in cols else None
        if key and name:
            _, drows = fetch(conn, f"SELECT [{key}], [{name}] FROM [Debtor]")
            names = {r[0]: r[1] for r in drows}

    lines.append(f"近 {LOOKBACK_MONTHS} 个月有销售单据的客户账号（依单据数排序）：")
    lines.append(f"{'Debtor Code':<20} {'单据数':>8}  客户名称")
    for code, n in rows[:60]:
        lines.append(f"{str(code):<20} {n:>8}  {names.get(code, '')}")
    lines.append("")
    lines.append("→ 请把 Shopee / Lazada / Cash / 水工 / Southern / Tiktok / Shopify 各自对应的")
    lines.append("  Debtor Code 填进 autocount.json 的 channel_rules.map。")


def section_distinct(conn, table, column, title, lines):
    """列出某个栏位的所有相异值（用来确认类别与品牌栏）。"""
    if not has_table(conn, table) or column not in columns_of(conn, table):
        lines.append(f"（{table}.{column} 不存在，请依上面的栏位清单确认正确栏名）")
        return
    _, rows = fetch(conn, f"""
        SELECT [{column}], COUNT(*) FROM [{table}]
        WHERE [{column}] IS NOT NULL AND LTRIM(RTRIM([{column}])) <> ''
        GROUP BY [{column}] ORDER BY COUNT(*) DESC
    """)
    lines.append(f"{title}（{len(rows)} 个相异值）：")
    for v, n in rows[:80]:
        lines.append(f"    {str(v):<40} {n:>8} 项商品")


def main():
    cfg = load_autocount_config()
    conn = connect(cfg)
    db = cfg["connection"]["database"]
    out = Path(__file__).resolve().parent.parent / f"discovery_{db}.txt"
    lines = [f"AutoCount 结构探查 — 账套 {db}", "=" * 70, ""]

    cols, rows = fetch(conn, """
        SELECT TABLE_NAME, (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS c
                            WHERE c.TABLE_NAME = t.TABLE_NAME) AS n_cols
        FROM INFORMATION_SCHEMA.TABLES t
        WHERE TABLE_TYPE = 'BASE TABLE'
        ORDER BY TABLE_NAME
    """)
    all_tables = [r[0] for r in rows]
    lines.append(f"资料表总数：{len(all_tables)}")
    lines.append("")

    hits = [t for t in all_tables if any(k in t.lower() for k in INTEREST)]
    lines.append(f"与销售/商品相关的资料表（{len(hits)} 张）：")
    lines.append(", ".join(hits))
    lines += ["", "=" * 70, "栏位明细", "=" * 70, ""]

    for tbl in hits:
        cols, rows = fetch(conn, """
            SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, IS_NULLABLE
            FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = ?
            ORDER BY ORDINAL_POSITION
        """, (tbl,))
        lines.append(f"--- {tbl} ({len(rows)} 栏)")
        for name, dtype, length, nullable in rows:
            size = f"({length})" if length not in (None, -1) else ""
            lines.append(f"    {name:<32} {dtype}{size}")
        lines.append("")

    lines += ["=" * 70, f"样本资料（每张表 {SAMPLE_ROWS} 笔，仅供确认栏位含义）", "=" * 70, ""]
    for tbl in hits[:MAX_SAMPLE_TABLES]:
        try:
            cols, rows = fetch(conn, f"SELECT TOP {SAMPLE_ROWS} * FROM [{tbl}]")
        except Exception as exc:                   # noqa: BLE001
            lines.append(f"--- {tbl}: 读取失败 {exc}")
            continue
        lines.append(f"--- {tbl}")
        lines.append("    " + " | ".join(cols))
        for r in rows:
            lines.append("    " + " | ".join("" if v is None else str(v)[:40] for v in r))
        lines.append("")

    s = cfg["schema"]
    lines += ["=" * 70, "渠道对照：客户账号（Debtor）", "=" * 70, ""]
    section_channels(conn, cfg, lines)

    lines += ["", "=" * 70, "报表类别对照：商品类别栏", "=" * 70, ""]
    section_distinct(conn, s["item_table"], s["item_category"],
                     f"{s['item_table']}.{s['item_category']} 的相异值"
                     "（应该看得到 Sanitary / Lock / Kitchen / Fitting 等）", lines)

    lines += ["", "=" * 70, "品牌对照：Hemos 筛选条件", "=" * 70, ""]
    section_distinct(conn, s["item_table"], cfg["brand_filter"]["field"],
                     f"{s['item_table']}.{cfg['brand_filter']['field']} 的相异值"
                     "（应该看得到 Hemos / Hemos X）", lines)

    out.write_text("\n".join(lines), encoding="utf-8")
    print(f"已产生：{out}")
    print("把这个档案传给我，我就能把抓数 SQL 定稿。")


if __name__ == "__main__":
    main()
