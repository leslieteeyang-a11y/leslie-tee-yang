@echo off
title HomeWorks - quotations to BI
cd /d "%~dp0"
echo.
echo  HomeWorks - quotation reminder (customer page)
echo  ----------------------------------------------
echo  1. read recent quotations from AutoCount (read only) and push them to BI
echo  2. register the daily Windows task "HomeWorks Quotes" (12:30 every day)
echo.
where python >nul 2>nul
if errorlevel 1 (
    echo  [X] Python not found. Run setup_autocount.bat first.
    pause
    exit /b 1
)
python scripts\quote_push.py
if errorlevel 1 goto fail
python scripts\schedule_monthly.py --quotes --time 12:30
if errorlevel 1 goto fail
echo.
echo  Done.
pause
exit /b 0
:fail
echo.
echo  [X] Something went wrong above. Copy this window's text to Claude.
pause
exit /b 1
