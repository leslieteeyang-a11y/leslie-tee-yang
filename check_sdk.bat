@echo off
setlocal
title HomeWorks - AutoCount SDK check
echo.
echo  HomeWorks - AutoCount SDK / API readiness check (read-only)
echo  ----------------------------------------------------------
echo.
echo [1] AutoCount install folders:
for /d %%d in ("C:\Program Files\AutoCount*" "C:\Program Files (x86)\AutoCount*") do if exist "%%~d" echo     %%~d
echo.
echo [2] API assemblies (need AutoCount.Data / Authentication / Invoicing / MainEntry):
for /d %%d in ("C:\Program Files\AutoCount*" "C:\Program Files (x86)\AutoCount*") do (
    for /r "%%~d" %%f in (AutoCount.Data.dll AutoCount.Authentication.dll AutoCount.Invoicing.dll AutoCount.MainEntry.dll AutoCount.Stock.dll) do if exist "%%~f" echo     %%~f
)
echo.
echo [3] .NET Framework compiler on this PC (used to build the tiny bridge program):
if exist "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe" (echo     found: C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe) else (echo     [X] csc.exe not found)
echo.
echo [4] Python bitness (must be 64-bit to match AutoCount 64-bit):
python -c "import struct,sys; print('     Python', sys.version.split()[0], struct.calcsize('P')*8, 'bit')"
echo.
echo [5] SQL Server account books on this PC (test book must NOT be the live one):
python -c "import pyodbc; c=pyodbc.connect('DRIVER={ODBC Driver 17 for SQL Server};SERVER=.\\A2006;Trusted_Connection=yes',timeout=5); print('    ', [r[0] for r in c.execute(\"select name from sys.databases where name like 'AED%'\")])" 2>nul || echo     (could not list with Windows auth - fine, the setup script knows the password)
echo.
echo Please screenshot this whole window.
pause
