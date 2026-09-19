@echo off
REM ============================================================
REM  Dr. Arefin Zannat Sompa - website + appointment API
REM  Double-click this file to start the server (npm is not needed).
REM ============================================================
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found in PATH.
  echo         Install it from https://nodejs.org/ and try again.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo [ERROR] The node_modules folder is missing.
  echo         Run this once in this folder:  npm.cmd install
  echo.
  pause
  exit /b 1
)

if not exist ".env" (
  echo [WARNING] .env was not found - the database connection will fail.
  echo           Copy .env.example to .env and fill in your SQL Server details.
  echo.
)

echo Starting the server... the website opens at http://localhost:5000
echo Press Ctrl+C to stop the server.
echo.

node server.js

echo.
echo Server stopped.
pause
