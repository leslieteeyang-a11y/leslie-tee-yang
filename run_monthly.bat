@echo off
REM Monthly report: pull last month from AutoCount and build the Excel.
REM Used by Windows Task Scheduler (see schedule_monthly.bat). No pause here:
REM a scheduled task must never wait for a key press. Output goes to logs\.
cd /d "%~dp0"
python scripts\run_monthly.py %*
