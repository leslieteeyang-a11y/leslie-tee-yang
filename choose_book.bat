@echo off
title HomeWorks - choose AutoCount account book
cd /d "%~dp0"
echo.
echo  HomeWorks - choose which AutoCount account book to use
echo  ------------------------------------------------------
echo  Pick the number of the account book from the list.
echo  Branch PC: pick the JB Southern book, then run setup_branch.bat again.
echo.
where python >nul 2>nul
if errorlevel 1 (
    echo  [X] Python not found. Run setup_autocount.bat first.
    pause
    exit /b 1
)
python scripts\autocount_setup.py --choose
echo.
pause
