@echo off
cd /d "%~dp0"
title Bin Saad Billing - build the installer
echo.
echo  Bin Saad Billing - building the installer
echo  This needs the internet and takes a few minutes the first time.
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo  Node.js is not installed on this computer.
  echo  Install the LTS version from https://nodejs.org , restart the computer, then double-click this file again.
  pause
  exit /b 1
)
call npm install
if errorlevel 1 goto fail
call npm test
if errorlevel 1 goto fail
call npm run dist
if errorlevel 1 goto fail
echo.
echo  Done. The installer is inside the "dist" folder. Opening it now.
start "" "%~dp0dist"
pause
exit /b 0
:fail
echo.
echo  Something went wrong. Take a photo of this window and send it to the developer.
pause
exit /b 1
