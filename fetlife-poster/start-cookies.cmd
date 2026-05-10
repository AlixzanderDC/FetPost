@echo off
REM Called by the FetPost UI when you click "Refresh cookies" for an account.
REM Opens a Chrome window where you log into FetLife manually; cookies are then saved.
cd /d "%~dp0"
node --env-file=..\.env src\setup-cookies.js
