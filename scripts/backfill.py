#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""补抓一段期间的月报（每个月 = 抓数 → Excel → 推 BI），用 AutoCount 的数取代手抄的旧档。

    python scripts/backfill.py 2026-01            # 2026-01 到上个月
    python scripts/backfill.py 2026-01 2026-06    # 指定起迄

每个月各自呼叫 run_monthly.py，所以 logs/ 里一个月一份纪录；
data/YYYY-MM.json 里手填的 ads / live_sales 会保留。
"""

import subprocess
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def previous_month(today: date | None = None) -> str:
    t = today or date.today()
    y, m = (t.year, t.month - 1) if t.month > 1 else (t.year - 1, 12)
    return f"{y}-{m:02d}"


def month_range(start: str, end: str) -> list[str]:
    """'2026-01','2026-03' → ['2026-01','2026-02','2026-03']（纯函数）。"""
    (y0, m0), (y1, m1) = (int(x) for x in start.split("-")), (int(x) for x in end.split("-"))
    out, y, m = [], y0, m0
    while (y, m) <= (y1, m1):
        out.append(f"{y}-{m:02d}")
        y, m = (y, m + 1) if m < 12 else (y + 1, 1)
    return out


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not args:
        sys.exit("用法：python scripts/backfill.py 2026-01 [2026-08]")
    months = month_range(args[0], args[1] if len(args) > 1 else previous_month())
    print(f"要补抓 {len(months)} 个月：{months[0]} ~ {months[-1]}")
    failed = []
    for m in months:
        r = subprocess.run([sys.executable, str(ROOT / "scripts" / "run_monthly.py"), m, "--scheduled"], cwd=ROOT)
        if r.returncode != 0:
            failed.append(m)
    if failed:
        sys.exit(f"这些月份失败：{failed}。细节在 logs/。")
    print(f"全部完成：{len(months)} 个月。")


if __name__ == "__main__":
    main()
