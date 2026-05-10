@echo off
REM Match by port only (no IP prefix), since the FetLife service binds 127.0.0.1
REM but the UI binds 0.0.0.0. The trailing space in ":3747 " keeps it from
REM accidentally matching ports like :37470, :47474, etc.
echo Stopping FetPost services...
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":3747 " ^| findstr LISTENING 2^>nul') do (
  taskkill /F /PID %%P >nul 2>&1 && echo   stopped FetLife service ^(pid %%P^)
)
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":4000 " ^| findstr LISTENING 2^>nul') do (
  taskkill /F /PID %%P >nul 2>&1 && echo   stopped UI ^(pid %%P^)
)
echo Done.
