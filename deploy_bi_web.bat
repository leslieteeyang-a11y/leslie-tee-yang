@echo off
title HomeWorks - put the new BI web page online (Vercel)
cd /d "%~dp0"
echo.
echo  HomeWorks - deploy the BI web page update (homeworks-bi.vercel.app)
echo  ------------------------------------------------------------------
echo  Keeps every page that is online now and only adds / replaces the
echo  files of this update. First time it asks for a Vercel token.
echo.
where python >nul 2>nul
if errorlevel 1 (
    echo  [X] Python not found. Run setup_autocount.bat first.
    pause
    exit /b 1
)
python scripts\deploy_bi_web.py %*
echo.
pause
