@echo off
title HomeWorks - schedule monthly report
cd /d "%~dp0"
echo.
echo  HomeWorks - register the monthly report in Windows Task Scheduler
echo  ----------------------------------------------------------------
echo.
where python >nul 2>nul
if errorlevel 1 (
    echo  [X] Python not found. Run setup_autocount.bat first.
    pause
    exit /b 1
)
python scripts\schedule_monthly.py %*
echo.
pause
