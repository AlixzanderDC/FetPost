@echo off
REM Called by the FetPost UI when you click "Refresh cookies" for an account.
REM First arg (optional): accountId to target. If omitted, all accounts are processed.
cd /d "%~dp0"
node --env-file=..\.env src\setup-cookies.js %*
