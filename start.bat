@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies, this takes a few minutes the first time...
  call npm install
  if errorlevel 1 (
    echo Install failed. Check that Node.js 22 or newer is installed.
    pause
    exit /b 1
  )
)
call npm start
