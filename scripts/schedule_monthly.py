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
BRANCH_TASK = "HomeWorks Branch Actual"
QUOTES_TASK = "HomeWorks Quotes"


def task_xml(bat_path: Path, day: int, time_hhmm: str, workdir: Path, daily: bool = False, desc: str | None = None,
             repeat_minutes: int | None = None, repeat_hours: int = 14) -> str:
    """产生工作排程器的任务定义（纯函数，方便测试）。daily=True 时每天跑（分行当月进度、报价单用）；
    repeat_minutes 有值时，从开始时间起每 N 分钟再跑一次，持续 repeat_hours 小时（营业时间内同步 DO）。"""
    hh, mm = time_hhmm.split(":")
    start = f"{date.today().isoformat()}T{int(hh):02d}:{int(mm):02d}:00"
    if daily:
        desc = desc or "HomeWorks：每天自动从分行 AutoCount 抓上个月与本月至今的实际销售额推进 BI"
        schedule = "<ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>"
    else:
        desc = f"HomeWorks：每月 {day} 号自动从 AutoCount 抓上个月数据并产生 Excel 月报"
        schedule = f"""<ScheduleByMonth>
        <DaysOfMonth><Day>{day}</Day></DaysOfMonth>
        <Months><January/><February/><March/><April/><May/><June/><July/><August/>
                <September/><October/><November/><December/></Months>
      </ScheduleByMonth>"""
    repetition = (f"""<Repetition>
        <Interval>PT{repeat_minutes}M</Interval>
        <Duration>PT{repeat_hours}H</Duration>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>""" if repeat_minutes else "")
    return f"""<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>{desc}</Description>
  </RegistrationInfo>
  <Triggers>
    <CalendarTrigger>
      {repetition}
      <StartBoundary>{start}</StartBoundary>
      <Enabled>true</Enabled>
      {schedule}
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
    ap.add_argument("--branch", action="store_true", help="分行电脑用：登记「分行实际销售额」推送，而不是总部月报")
    ap.add_argument("--quotes", action="store_true", help="SERVER 用：登记每天推报价单进 BI（顾客资料页的报价没成交提醒）")
    a = ap.parse_args()
    global TASK_NAME
    bat = "run_quotes.bat" if a.quotes else "run_branch.bat" if a.branch else "run_monthly.bat"
    if a.branch:
        TASK_NAME = BRANCH_TASK
    if a.quotes:
        TASK_NAME = QUOTES_TASK

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

    xml = task_xml(ROOT / bat, a.day, a.time, ROOT, daily=a.branch or a.quotes,   # 分行、报价单每天跑
                   desc=("HomeWorks：营业时间每 15 分钟从 AutoCount 只读抓报价单与送货单 DO 推进 BI"
                         "（顾客资料的报价没成交提醒、送货排单）") if a.quotes else None,
                   repeat_minutes=15 if a.quotes else None)
    with tempfile.NamedTemporaryFile("w", suffix=".xml", delete=False, encoding="utf-16") as f:
        f.write(xml)
        tmp = f.name
    try:
        schtasks("/Create", "/TN", TASK_NAME, "/XML", tmp, "/F")
    finally:
        Path(tmp).unlink(missing_ok=True)
    if a.quotes:
        print(f"已登记排程「{TASK_NAME}」：每天 {a.time} 起 14 小时内每 15 分钟抓一次报价单与送货单 DO 推进 BI。"
              f"纪录在 {ROOT / 'logs'}（quotes_日期.log）。")
        print("  电脑那天没开也没关系，下次开机会补跑。")
        return
    if a.branch:
        print(f"已登记排程「{TASK_NAME}」：每天 {a.time} 自动抓上个月 + 本月至今的分行实际销售额并推进 BI。")
    else:
        print(f"已登记排程「{TASK_NAME}」：每月 {a.day} 号 {a.time} 自动抓上个月并产生 Excel。")
    if a.branch:
        print(f"  每次执行的纪录在 {ROOT / 'logs'}（branch_*.log）；结果看 BI 网页电商月报的「当月实际销售额」栏。")
    else:
        print(f"  报表会出现在 {ROOT / 'output'}；每次执行的纪录在 {ROOT / 'logs'}。")
    print("  电脑那天没开也没关系，下次开机会补跑。")
    print(f"  要现在测一次：python scripts\\schedule_monthly.py --run-now{' --branch' if a.branch else ''}")


if __name__ == "__main__":
    main()
