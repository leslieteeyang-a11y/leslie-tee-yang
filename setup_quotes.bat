@echo off
title HomeWorks - quotations and delivery orders to BI
cd /d "%~dp0"
echo.
echo  HomeWorks - quotations + delivery orders to BI (customer page)
echo  --------------------------------------------------------------
echo  1. read recent quotations and delivery orders from AutoCount (read only) and push them to BI
echo  2. register the Windows task "HomeWorks Quotes" (every 15 minutes, 07:00-21:00)
echo.
where python >nul 2>nul
if errorlevel 1 (
    echo  [X] Python not found. Run setup_autocount.bat first.
    pause
    exit /b 1
)
python scripts\quote_push.py
if errorlevel 1 goto fail
python scripts\quote_push.py --install --time 07:00
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
