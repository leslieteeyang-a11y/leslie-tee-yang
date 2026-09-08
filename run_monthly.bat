@echo off
REM 每月自动产生电商月报（给 Windows 工作排程器用）
REM 排程建议：每月 1 号 08:00 执行，预设会抓刚结束的上个月。
cd /d "%~dp0"
python scripts\run_monthly.py %*
if errorlevel 1 (
    echo.
    echo 执行失败，请看上方讯息。
    pause
)
