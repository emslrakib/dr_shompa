@echo off
REM ============================================================
REM  Stops the DrShompa server — kills the node process that is
REM  listening on the configured port (default 5000).
REM ============================================================
setlocal

set PORT=5000
if exist ".env" (
  for /f "tokens=1,* delims==" %%a in ('findstr /b /i "PORT=" ".env" 2^>nul') do set PORT=%%b
)

echo Looking for a server listening on port %PORT% ...

set FOUND=0
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":%PORT%" ^| findstr "LISTENING"') do (
  echo Stopping process %%p ...
  taskkill /F /PID %%p >nul 2>nul
  set FOUND=1
)

if "%FOUND%"=="0" (
  echo No server was running on port %PORT%.
) else (
  echo Server stopped.
)

echo.
timeout /t 3 >nul
endlocal
