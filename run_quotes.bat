@echo off
REM SERVER: push recent quotations to HomeWorks BI (Task Scheduler runs this daily).
cd /d "%~dp0"
python scripts\quote_push.py %*
