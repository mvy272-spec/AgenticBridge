@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js 20 LTS or newer is not installed or is not in PATH.
    echo Download: https://nodejs.org/en/download
    pause
    exit /b 1
)

if "%BRIDGE_ROOT%"=="" set "BRIDGE_ROOT=C:\Users\HITLERV8\Downloads\Human Music Radio"
if "%BRIDGE_TOKEN%"=="" set "BRIDGE_TOKEN=CHANGE-ME-TO-A-LONG-RANDOM-TOKEN"

echo Starting Agent Bridge v3 on port 8080...
echo Stop the old Python bridge first with Ctrl+C.
node server.mjs
pause
