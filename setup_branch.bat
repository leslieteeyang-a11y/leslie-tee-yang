@echo off
title HomeWorks - branch actual sales to BI
cd /d "%~dp0"
echo.
echo  HomeWorks - branch (JB Southern / KL) actual sales to HomeWorks BI
echo  -----------------------------------------------------------------
echo  1. paste the Supabase secret key (or press Enter to reuse the saved one)
echo  2. test the connection
echo  3. push Jan .. this month, then register the daily schedule
echo  (which branch = read from the account book's company name: SOUTHERN or KL)
echo.
where python >nul 2>nul
if errorlevel 1 (
    echo  [X] Python not found. Run setup_autocount.bat first.
    pause
    exit /b 1
)
python scripts\supabase_push.py --setup-branch
if errorlevel 1 goto end
python scripts\schedule_monthly.py --branch
:end
echo.
pause
