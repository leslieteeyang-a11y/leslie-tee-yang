@echo off
title HomeWorks - diagnostics
cd /d "%~dp0"
set /p M=Month (YYYY-MM): 
python scripts\autocount_diag.py %M%
echo.
pause
