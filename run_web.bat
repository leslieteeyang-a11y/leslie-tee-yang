@echo off
REM 启动 HomeWorks 营运入口（库存 / 出货跟踪）
REM 有 autocount.json 就接 AutoCount；没有就用内建示范资料。
REM 强制用示范资料：set HW_SOURCE=mock
cd /d "%~dp0"
echo 启动中… 浏览器开 http://localhost:8000  （同网络其他电脑用这台机器的 IP）
python -m uvicorn webapp.main:app --host 0.0.0.0 --port 8000
pause
