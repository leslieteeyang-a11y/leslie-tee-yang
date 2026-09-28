@echo off
REM Branch PC: push last month's actual branch sales to HomeWorks BI (Task Scheduler runs this).
cd /d "%~dp0"
python scripts\branch_actual.py --scheduled
