#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""每月一键：从 AutoCount 抓数 → 产生 Excel 报表（也给 Windows 工作排程器用）。

    python scripts/run_monthly.py                 # 预设抓「上个月」
    python scripts/run_monthly.py 2026-09         # 指定月份
    python scripts/run_monthly.py --scheduled     # 排程模式：不等人按键，全部写进 logs/

排程时没有人在看萤幕，所以每次执行都写一份 logs/monthly_<月份>_<时间>.log，
成功或失败都看得到。config.json 的 report_delivery.copy_to 若有填，
产生好的 Excel 会再复制一份过去（例如 OneDrive / 共享资料夹），人不用登入 SERVER 拿档案。
"""

import json
import os
import shutil
import subprocess
import sys
from datetime import date, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LOG_DIR = ROOT / "logs"


def previous_month() -> str:
    t = date.today()
    y, m = (t.year, t.month - 1) if t.month > 1 else (t.year - 1, 12)
    return f"{y}-{m:02d}"


class Tee:
    """同时印到萤幕与 log 档。"""
    def __init__(self, path: Path):
        self.f = open(path, "a", encoding="utf-8")
    def write(self, s):
        sys.__stdout__.write(s); self.f.write(s); self.f.flush()
    def flush(self):
        sys.__stdout__.flush(); self.f.flush()


def run(script: str, month: str, log: Path):
    """执行子脚本，输出同时进萤幕与 log（子程序强制 UTF-8，避免中文在 Windows 主控台变乱码）。"""
    print(f"\n>>> {script} {month}")
    env = {**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"}
    p = subprocess.Popen([sys.executable, str(ROOT / "scripts" / script), month], cwd=ROOT, env=env,
                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                         encoding="utf-8", errors="replace")
    for line in p.stdout:
        print("    " + line.rstrip())
    if p.wait() != 0:
        sys.exit(f"{script} 执行失败（代码 {p.returncode}），已中止。细节在 {log}")


def deliver(out: Path, copy_to: str) -> None:
    """把报表复制到指定资料夹（可选）。失败只警告，不让整个流程算失败。"""
    if not copy_to:
        return
    try:
        dest = Path(copy_to)
        dest.mkdir(parents=True, exist_ok=True)
        shutil.copy2(out, dest / out.name)
        print(f"已复制一份到 {dest / out.name}")
    except OSError as e:
        print(f"[!] 复制到 {copy_to} 失败：{e}。报表仍在 {out}。请检查该资料夹是否存在、有没有写入权限。")


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    scheduled = "--scheduled" in sys.argv
    month = args[0] if args else previous_month()

    LOG_DIR.mkdir(exist_ok=True)
    log = LOG_DIR / f"monthly_{month}_{datetime.now():%Y%m%d_%H%M%S}.log"
    sys.stdout = sys.stderr = Tee(log)
    print(f"HomeWorks 月报  {datetime.now():%Y-%m-%d %H:%M}  月份 {month}  模式 {'排程' if scheduled else '手动'}")

    if not (ROOT / "autocount.json").exists():
        sys.exit("还没连接 AutoCount（找不到 autocount.json）。请先双击 setup_autocount.bat。")

    run("autocount_extract.py", month, log)
    run("generate_report.py", month, log)

    out = ROOT / "output" / f"月度报表_{month}.xlsx"
    print(f"\n完成。报表在 {out}")
    cfg = json.loads((ROOT / "config.json").read_text(encoding="utf-8"))
    deliver(out, (cfg.get("report_delivery") or {}).get("copy_to", ""))

    doc = json.loads((ROOT / "data" / f"{month}.json").read_text(encoding="utf-8"))
    if not doc.get("ads"):
        print(f"提醒：Shopee Ads / Lazada Affiliate / Live Sales 不在 AutoCount，"
              f"填进 data/{month}.json 后再跑一次 generate_report.py 即可。")


if __name__ == "__main__":
    main()
