#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""一键：问月份 → 从 AutoCount 抓数 → 产生 Excel → 用 Excel 打开。

由 make_report.bat 呼叫。也可以直接带月份：python scripts/make_report.py 2026-08
"""

import os
import subprocess
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PY = sys.executable


def previous_month():
    t = date.today()
    y, m = (t.year, t.month - 1) if t.month > 1 else (t.year - 1, 12)
    return f"{y}-{m:02d}"


def run(args, fail_msg):
    r = subprocess.run([PY, *args], cwd=ROOT)
    if r.returncode != 0:
        print(f"\n[X] {fail_msg}\n    请把这个视窗整个截图给 Claude。")
        sys.exit(r.returncode)


def main():
    if os.name == "nt":
        os.system("")
    if not (ROOT / "autocount.json").exists():
        sys.exit("还没连接 AutoCount，请先双击 setup_autocount.bat。")

    month = sys.argv[1] if len(sys.argv) > 1 else ""
    while not month:
        month = input(f"要做哪个月的报表？（格式 YYYY-MM，直接 Enter = {previous_month()}）: ").strip() \
                or previous_month()
        if len(month) != 7 or month[4] != "-" or not month[:4].isdigit() or not month[5:].isdigit():
            print("  格式不对，例如 2026-08"); month = ""

    print(f"\n[1/2] 从 AutoCount 抓 {month} 的数据…")
    run(["scripts/autocount_extract.py", month], "抓数失败。")
    print(f"\n[2/2] 产生 Excel…")
    run(["scripts/generate_report.py", month], "产生报表失败。")

    out = ROOT / "output" / f"月度报表_{month}.xlsx"
    print(f"\n完成：{out}")
    print("提醒：Shopee Ads / Lazada Affiliate / Live Sales 不在 AutoCount，")
    print(f"      要另外填进 data/{month}.json 的 ads 与 live_sales，再跑一次本程式。")
    if out.exists() and os.name == "nt":
        os.startfile(out)                          # noqa: S606


if __name__ == "__main__":
    main()
