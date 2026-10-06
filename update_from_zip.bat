@echo off
setlocal
title HomeWorks - update from zip
REM This file is itself inside the zip, so copying would overwrite it while it runs and the window
REM would vanish. First copy ourselves to %TEMP% and run that copy (it remembers this folder).
if /i not "%~1"=="--from-temp" (
    copy /y "%~f0" "%TEMP%\hw_update_run.bat" >nul
    call "%TEMP%\hw_update_run.bat" --from-temp "%~dp0"
    exit /b
)
cd /d "%~2"
set "DEST=C:\Homeworks\HomeWorks"
set "ZIP="
for /f "delims=" %%f in ('dir /b /o-d HomeWorks*.zip 2^>nul') do if not defined ZIP set "ZIP=%%f"
if not defined ZIP (
    echo [X] No HomeWorks*.zip found in %CD%. Put this file next to the zip.
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
echo Copying to %DEST% ...
REM /R overwrites read-only files, /C keeps going after an error (errors are shown, then checked below)
xcopy "%WORK%\HomeWorks\*" "%DEST%\" /E /Y /I /Q /R /C /H
echo Checking that every file was replaced ...
powershell -NoProfile -Command "$s='%WORK%\HomeWorks'; $d='%DEST%'; $bad=@(); Get-ChildItem -LiteralPath $s -Recurse -File | ForEach-Object { $t = Join-Path $d $_.FullName.Substring($s.Length+1); if (-not (Test-Path -LiteralPath $t) -or (Get-FileHash -LiteralPath $t).Hash -ne (Get-FileHash -LiteralPath $_.FullName).Hash) { $bad += $t } }; if ($bad.Count) { Write-Host '[X] These files were NOT updated (close any program or window using them, then run this again):'; $bad | ForEach-Object { Write-Host ('    ' + $_) }; exit 1 } else { Write-Host 'All files updated.' }"
if errorlevel 1 (
    echo.
    echo [X] Update incomplete. Copy this window's text to Claude.
    pause
    exit /b 1
)
rd /s /q "%WORK%" 2>nul
echo Updated %DEST% (your autocount.json, data, output and logs are kept).
echo Installed versions:
findstr /C:"VERSION = " "%DEST%\scripts\branch_actual.py" "%DEST%\scripts\quote_push.py"
echo.
echo Done. Branch PC: now double-click setup_branch.bat. SERVER: nothing else to do.
pause
