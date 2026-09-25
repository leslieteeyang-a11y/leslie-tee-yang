@echo off
title HomeWorks - connect monthly report to BI (Supabase)
cd /d "%~dp0"
echo.
echo  HomeWorks - connect the monthly report to HomeWorks BI
echo  ------------------------------------------------------
echo  1. paste the Supabase service_role key
echo  2. test the connection
echo  3. push last month's report
echo.
where python >nul 2>nul
if errorlevel 1 (
    echo  [X] Python not found. Run setup_autocount.bat first.
    pause
    exit /b 1
)
python scripts\supabase_push.py --set-key
if errorlevel 1 goto end
for /f %%m in ('python -c "from datetime import date;t=date.today();y,m=(t.year,t.month-1) if t.month>1 else (t.year-1,12);print(f'{y}-{m:02d}')"') do set LASTM=%%m
echo.
echo  pushing %LASTM% ...
python scripts\supabase_push.py %LASTM%
:end
echo.
pause
