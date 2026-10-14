@echo off
rem Builds the Windows installer: dist\MeetNotes Setup <version>.exe
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install Node.js 22 or newer from nodejs.org, then run this again.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Installing dependencies, this takes a few minutes the first time...
  call npm install
  if errorlevel 1 goto failed
)
echo Running tests...
call npm test
if errorlevel 1 goto failed
echo Building the installer...
call npm run dist -- --publish never
if errorlevel 1 goto failed
echo.
echo Done. The installer is in the dist folder.
start "" "%~dp0dist"
pause
exit /b 0

:failed
echo.
echo The build failed. On the company network, run these once in PowerShell, then open a new window and try again:
echo   npm config set cafile C:\dev\windows-certs.pem
echo   setx NODE_EXTRA_CA_CERTS "C:\dev\windows-certs.pem"
pause
exit /b 1
