@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================================
echo  HomeWorks - 连接 AutoCount（双击即可，不用打指令）
echo ============================================================
echo.

where python >nul 2>nul
if errorlevel 1 (
    echo [X] 找不到 Python。请先到 https://www.python.org/downloads/ 安装，
    echo     安装时勾选「Add Python to PATH」，装完关掉这个视窗再双击一次。
    echo.
    pause
    exit /b 1
)

echo [1/3] 安装需要的套件（第一次会久一点）...
python -m pip install -q -r requirements.txt
if errorlevel 1 (
    echo [X] 套件安装失败。请把上面的讯息截图给 Claude。
    pause
    exit /b 1
)
echo       完成。
echo.

echo [2/3] 侦测 SQL Server 与账套...
echo       （提示要输入 Server 时，直接按 Enter 让它自动找；
echo         列出账套后，输入编号选你们的账套）
echo.
python scripts\autocount_setup.py
if errorlevel 1 (
    echo.
    echo [X] 连线设定没完成。请把上面的讯息截图给 Claude。
    pause
    exit /b 1
)
echo.

echo [3/3] 探查账套结构...
python scripts\autocount_discover.py
if errorlevel 1 (
    echo.
    echo [X] 探查失败。请把上面的讯息截图给 Claude。
    pause
    exit /b 1
)
echo.
echo ============================================================
echo  完成！接下来把 discovery 档案给 Claude：
echo    记事本会自动打开它 -> Ctrl+A 全选 -> Ctrl+C 复制 -> 贴到对话里
echo    （或者直接把这个资料夹里的 discovery_*.txt 拖进对话）
echo ============================================================
for %%f in (discovery_*.txt) do start notepad "%%f"
pause
