#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把「每月自动产生报表」登记进 Windows 工作排程器（Task Scheduler）。

    python scripts/schedule_monthly.py            # 登记（或更新）排程：每月 1 号 08:00
    python scripts/schedule_monthly.py --day 2 --time 09:30
    python scripts/schedule_monthly.py --run-now  # 立刻跑一次，看排程会不会成功
    python scripts/schedule_monthly.py --status   # 看排程状态与上次结果
    python scripts/schedule_monthly.py --remove   # 取消排程

用 XML 登记而不是 schtasks 的命令列参数，是因为只有 XML 能设定
「错过时间就在下次开机后补跑」（StartWhenAvailable）；SERVER 若 1 号刚好关机也不会漏掉。
"""

import argparse
import subprocess
import sys
import tempfile
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TASK_NAME = "HomeWorks Monthly Report"


def task_xml(bat_path: Path, day: int, time_hhmm: str, workdir: Path) -> str:
    """产生工作排程器的任务定义（纯函数，方便测试）。"""
    hh, mm = time_hhmm.split(":")
    start = f"{date.today().isoformat()}T{int(hh):02d}:{int(mm):02d}:00"
    return f"""<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>HomeWorks：每月 {day} 号自动从 AutoCount 抓上个月数据并产生 Excel 月报</Description>
  </RegistrationInfo>
  <Triggers>
    <CalendarTrigger>
      <StartBoundary>{start}</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByMonth>
        <DaysOfMonth><Day>{day}</Day></DaysOfMonth>
        <Months><January/><February/><March/><April/><May/><June/><July/><August/>
                <September/><October/><November/><December/></Months>
      </ScheduleByMonth>
    </CalendarTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT2H</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>{bat_path}</Command>
      <Arguments>--scheduled</Arguments>
      <WorkingDirectory>{workdir}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
"""


def schtasks(*args, check=True):
    r = subprocess.run(["schtasks", *args], capture_output=True, text=True, errors="replace")
    if check and r.returncode != 0:
        sys.exit(f"schtasks 失败：{(r.stderr or r.stdout).strip()}\n"
                 "请检查：是不是在 Windows 上执行？若说「拒绝存取」，请用「以系统管理员身分执行」再试。")
    return r


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--day", type=int, default=1, help="每月几号（预设 1）")
    ap.add_argument("--time", default="08:00", help="几点执行，HH:MM（预设 08:00）")
    ap.add_argument("--run-now", action="store_true", help="立刻执行一次已登记的排程")
    ap.add_argument("--status", action="store_true", help="显示排程状态")
    ap.add_argument("--remove", action="store_true", help="取消排程")
    a = ap.parse_args()

    if sys.platform != "win32":
        sys.exit("这个脚本要在办公室那台 Windows（SERVER）上执行，它登记的是 Windows 工作排程器。")

    if a.remove:
        schtasks("/Delete", "/TN", TASK_NAME, "/F")
        print(f"已取消排程「{TASK_NAME}」。")
        return
    if a.status:
        r = schtasks("/Query", "/TN", TASK_NAME, "/V", "/FO", "LIST", check=False)
        print(r.stdout if r.returncode == 0 else f"没有登记排程「{TASK_NAME}」。双击 schedule_monthly.bat 登记。")
        return
    if a.run_now:
        schtasks("/Run", "/TN", TASK_NAME)
        print(f"已触发「{TASK_NAME}」，几分钟后看 logs\\ 里最新的档案与 output\\。")
        return

    if not (1 <= a.day <= 28):
        sys.exit("--day 请填 1～28（每个月都有的日子）。")
    if not (ROOT / "autocount.json").exists():
        sys.exit("还没连接 AutoCount（找不到 autocount.json）。请先双击 setup_autocount.bat。")

    xml = task_xml(ROOT / "run_monthly.bat", a.day, a.time, ROOT)
    with tempfile.NamedTemporaryFile("w", suffix=".xml", delete=False, encoding="utf-16") as f:
        f.write(xml)
        tmp = f.name
    try:
        schtasks("/Create", "/TN", TASK_NAME, "/XML", tmp, "/F")
    finally:
        Path(tmp).unlink(missing_ok=True)
    print(f"已登记排程「{TASK_NAME}」：每月 {a.day} 号 {a.time} 自动抓上个月并产生 Excel。")
    print(f"  报表会出现在 {ROOT / 'output'}；每次执行的纪录在 {ROOT / 'logs'}。")
    print("  电脑那天没开也没关系，下次开机会补跑。")
    print("  要现在测一次：python scripts\\schedule_monthly.py --run-now")


if __name__ == "__main__":
    main()
