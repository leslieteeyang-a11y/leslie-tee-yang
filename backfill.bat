@echo off
title HomeWorks - backfill months from AutoCount
cd /d "%~dp0"
set /p START=Start month (YYYY-MM, e.g. 2026-01): 
python scripts\backfill.py %START%
echo.
pause
