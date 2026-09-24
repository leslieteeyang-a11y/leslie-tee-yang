@echo off
title HomeWorks - monthly report
cd /d "%~dp0"
echo.
echo  HomeWorks - monthly report from AutoCount
echo  -----------------------------------------
echo.
where python >nul 2>nul
if errorlevel 1 (
    echo  [X] Python not found. Run setup_autocount.bat first.
    pause
    exit /b 1
)
python scripts\make_report.py %*
echo.
pause
