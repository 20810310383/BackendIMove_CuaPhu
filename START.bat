@echo off
chcp 65001 >nul
cd /d "%~dp0"
title TH79 iMove Backend V5.8

echo =====================================================
echo   TH79 iMove Backend V5.8
echo =====================================================
echo.

if not exist ".env" (
  echo [ERROR] Chua co file .env
  echo Copy .env.example thanh .env va dien MongoDB/JWT/KYC config.
  pause
  exit /b 1
)

set NEED_NPM_INSTALL=0
if not exist "node_modules" set NEED_NPM_INSTALL=1
if exist "node_modules" (
  node -e "require.resolve('socket.io')" >nul 2>&1
  if errorlevel 1 set NEED_NPM_INSTALL=1
)

if "%NEED_NPM_INSTALL%"=="1" (
  echo [SETUP] Dang cai/cap nhat npm dependencies cho V5.8...
  call npm install
  if errorlevel 1 (
    echo [ERROR] npm install that bai.
    pause
    exit /b 1
  )
)

echo [START] Core API + GPS + Matching + Realtime + JWT + KYC + LAN Discovery...
node src\server.js
pause
