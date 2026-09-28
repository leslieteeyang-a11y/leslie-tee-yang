@echo off
setlocal
title HomeWorks - update from zip
cd /d "%~dp0"
set "DEST=C:\Homeworks\HomeWorks"
set "ZIP="
for /f "delims=" %%f in ('dir /b /o-d HomeWorks*.zip 2^>nul') do if not defined ZIP set "ZIP=%%f"
if not defined ZIP (
    echo [X] No HomeWorks*.zip found in this folder. Put this file next to the zip.
    pause
    exit /b 1
)
echo Newest zip here: %ZIP%
set "WORK=%TEMP%\hw_update"
rd /s /q "%WORK%" 2>nul
powershell -NoProfile -Command "Expand-Archive -LiteralPath '%CD%\%ZIP%' -DestinationPath '%WORK%' -Force"
if errorlevel 1 (
    echo [X] Unzip failed.
    pause
    exit /b 1
)
if not exist "%DEST%" mkdir "%DEST%"
xcopy "%WORK%\HomeWorks\*" "%DEST%\" /E /Y /I /Q >nul
if errorlevel 1 (
    echo [X] Copy to %DEST% failed.
    pause
    exit /b 1
)
rd /s /q "%WORK%" 2>nul
echo Updated %DEST% (your autocount.json, data, output and logs are kept).
echo Installed version:
findstr /C:"VERSION = " "%DEST%\scripts\branch_actual.py"
echo.
echo Done. Branch PC: now double-click setup_branch.bat. SERVER: nothing else to do.
pause
