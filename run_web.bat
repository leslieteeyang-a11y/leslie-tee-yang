@echo off
REM Start the HomeWorks operations portal (inventory / deliveries / dashboard).
REM Uses AutoCount when autocount.json exists, otherwise built-in demo data.
REM Force demo data: set HW_SOURCE=mock
cd /d "%~dp0"
python -m pip install -q -r requirements.txt
echo Starting... open http://localhost:8000 in the browser (other PCs: use this machine's IP)
python -m uvicorn webapp.main:app --host 0.0.0.0 --port 8000
pause
