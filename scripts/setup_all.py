#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""一键：装套件 → 侦测 SQL Server 与账套 → 探查账套结构 → 用记事本打开结果。

由 setup_autocount.bat 呼叫（那个 .bat 刻意只含英文，避免命令视窗因编码问题闪退）。
"""

import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PY = sys.executable


def step(n, text):
    print(f"\n[{n}/3] {text}")


def run(args, fail_msg):
    r = subprocess.run([PY, *args], cwd=ROOT)
    if r.returncode != 0:
        print(f"\n[X] {fail_msg}\n    请把这个视窗整个截图给 Claude。")
        sys.exit(r.returncode)


def main():
    if os.name == "nt":
        os.system("")                     # 让 Windows 命令视窗正确显示 UTF-8
    print("=" * 60)
    print(" HomeWorks — 连接 AutoCount（不用打指令，照提示回答就好）")
    print("=" * 60)

    step(1, "安装需要的套件（第一次会久一点）…")
    run(["-m", "pip", "install", "-q", "-r", "requirements.txt"], "套件安装失败。")
    print("      完成。")

    step(2, "侦测 SQL Server 与账套…")
    print("      提示要输入 Server 时：直接按 Enter 让它自动找。")
    print("      列出账套后：输入编号，按 Enter。")
    run(["scripts/autocount_setup.py"], "连线设定没完成。")

    step(3, "探查账套结构…")
    run(["scripts/autocount_discover.py"], "探查失败。")

    files = sorted(ROOT.glob("discovery_*.txt"))
    print("\n" + "=" * 60)
    print(" 完成！接下来把 discovery 档案给 Claude：")
    print("   记事本会自动打开它 → Ctrl+A 全选 → Ctrl+C 复制 → 贴到对话里")
    print("   （或者直接把这个资料夹里的 discovery_*.txt 拖进对话）")
    print("=" * 60)
    if files and os.name == "nt":
        os.startfile(files[-1])           # noqa: S606 — 用预设程式（记事本）打开


if __name__ == "__main__":
    main()
