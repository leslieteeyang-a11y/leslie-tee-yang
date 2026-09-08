#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""AutoCount 数据库结构探查。

在办公室那台连得到 AutoCount 的电脑上执行：

    python scripts/autocount_discover.py

会产生 discovery_<账套名>.txt，内含销售单据、商品、客户等相关资料表的
栏位清单与少量样本资料。把这个档案给我，我就能把抓数的 SQL 依你们实际
的账套结构定稿（不必猜表名栏名）。

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

    out.write_text("\n".join(lines), encoding="utf-8")
    print(f"已产生：{out}")
    print("把这个档案传给我，我就能把抓数 SQL 定稿。")


if __name__ == "__main__":
    main()
