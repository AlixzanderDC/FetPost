@echo off
cd /d "%~dp0"

if not exist .env (
  echo .env not found. Run setup.cmd first.
  exit /b 1
)

REM ---- Stop any previous instance still holding the ports (UI binds 0.0.0.0, so match port-only) ----
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":3747 " ^| findstr LISTENING 2^>nul') do taskkill /F /PID %%P >nul 2>&1
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":4000 " ^| findstr LISTENING 2^>nul') do taskkill /F /PID %%P >nul 2>&1

echo Starting FetLife service...
start "FetPost — FetLife service" /min cmd /c "cd /d %~dp0fetlife-poster && node --env-file=..\.env src\server.js"

REM Give the FetLife service a moment to bind its port before the UI tries to reach it.
timeout /t 4 /nobreak >nul

echo Starting UI...
start "FetPost — UI" /min cmd /c "cd /d %~dp0nexuspost-ui && node --env-file=..\.env src\server.js"

timeout /t 3 /nobreak >nul
echo.
echo FetPost is running at http://127.0.0.1:4000
echo Two minimized command windows are doing the work — leave them open.
echo Run stop.cmd to shut everything down.
echo.
start "" "http://127.0.0.1:4000"
