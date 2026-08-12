@echo off
chcp 65001 >nul
title Poogsin App Server - close this window to stop the app
cd /d "%~dp0"
echo.
echo   ================================================
echo      Starting the Poogsin app server...
echo.
echo      - The browser opens automatically in a few seconds.
echo      - If not, open  http://localhost:3000
echo      - To STOP the app: just close this black window.
echo   ================================================
echo.
start "" /min cmd /c "timeout /t 8 >nul & start http://localhost:3000"
call npm run dev
echo.
echo   (The server has stopped. You can close this window.)
pause
