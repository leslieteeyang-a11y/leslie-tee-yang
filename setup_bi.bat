@echo off
title HomeWorks - connect monthly report to BI (Supabase)
cd /d "%~dp0"
echo.
echo  HomeWorks - connect the monthly report to HomeWorks BI
echo  ------------------------------------------------------
echo  1. paste the Supabase service_role key
echo  2. test the connection
echo  3. rebuild every month of this year from AutoCount and push to BI
echo.
where python >nul 2>nul
if errorlevel 1 (
    echo  [X] Python not found. Run setup_autocount.bat first.
    pause
    exit /b 1
)
python scripts\supabase_push.py --set-key
if errorlevel 1 goto end
for /f %%y in ('python -c "from datetime import date;print(date.today().year)"') do set YEAR=%%y
echo.
echo  rebuilding %YEAR%-01 .. last month (about 1 minute per month) ...
python scripts\backfill.py %YEAR%-01
:end
echo.
pause
