@echo off
title HomeWorks - connect monthly report to BI (Supabase)
cd /d "%~dp0"
echo.
echo  HomeWorks - connect the monthly report to HomeWorks BI
echo  ------------------------------------------------------
echo  1. paste the Supabase secret key (or press Enter to reuse the saved one)
echo  2. test the connection
echo  3. rebuild every month of this year from AutoCount and push to BI
echo.
where python >nul 2>nul
if errorlevel 1 (
    echo  [X] Python not found. Run setup_autocount.bat first.
    pause
    exit /b 1
)
python scripts\supabase_push.py --setup
echo.
pause
