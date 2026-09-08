#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""每月一键：从 AutoCount 抓数 → 产生 Excel 报表。

    python scripts/run_monthly.py            # 预设抓「上个月」
    python scripts/run_monthly.py 2026-09    # 指定月份

给 Windows 工作排程器用的话，请排程 run_monthly.bat（每月 1 号执行，
预设就会抓刚结束的上个月）。
"""

import subprocess
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def previous_month():
    t = date.today()
    y, m = (t.year, t.month - 1) if t.month > 1 else (t.year - 1, 12)
    return f"{y}-{m:02d}"


def run(script, month):
    print(f"\n>>> {script} {month}")
    r = subprocess.run([sys.executable, str(ROOT / "scripts" / script), month], cwd=ROOT)
    if r.returncode != 0:
        sys.exit(f"{script} 执行失败（代码 {r.returncode}），已中止。")


def main():
    month = sys.argv[1] if len(sys.argv) > 1 else previous_month()
    print(f"处理月份：{month}")
    run("autocount_extract.py", month)
    run("generate_report.py", month)
    print(f"\n完成。报表在 output/月度报表_{month}.xlsx")
    print("若广告与直播数据尚未填入 data/%s.json，补上后再跑一次 generate_report.py 即可。" % month)


if __name__ == "__main__":
    main()
