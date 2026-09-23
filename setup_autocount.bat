@echo off
title HomeWorks - AutoCount setup
cd /d "%~dp0"
echo.
echo  HomeWorks - AutoCount setup
echo  ---------------------------
echo.
where python >nul 2>nul
if errorlevel 1 (
    echo  [X] Python not found.
    echo      Install from https://www.python.org/downloads/
    echo      and tick "Add Python to PATH". Then run this file again.
    echo.
    pause
    exit /b 1
)
python scripts\setup_all.py
echo.
pause
