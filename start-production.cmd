@echo off
setlocal EnableExtensions
REM ============================================================
REM Starts DrShompa for IIS reverse-proxy hosting.
REM Run this from a Windows service manager (recommended) or an
REM elevated deployment terminal after production .env is configured.
REM ============================================================

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found in PATH.
  exit /b 1
)

if not exist "node_modules" (
  echo [ERROR] node_modules is missing. Run: npm.cmd ci --omit=dev
  exit /b 1
)

if not exist ".env" (
  echo [ERROR] .env is missing. Create it from .env.example and set production values.
  exit /b 1
)

set NODE_ENV=production
echo Starting DrShompa production server on the PORT configured in .env ...
node server.js
exit /b %ERRORLEVEL%