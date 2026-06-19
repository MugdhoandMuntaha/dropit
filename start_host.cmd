@echo off
title DropIt Host Server
echo ========================================================
echo               Starting DropIt Host Server               
echo ========================================================
echo.

:: Change directory to the folder where this script is saved
cd /d "%~dp0"

:: Smart folder detection: if package.json is not here, look for dropit folder
if not exist package.json (
    if exist dropit\package.json (
        cd dropit
    ) else if exist "c:\Users\Shah Md Al Junaid\Desktop\dropit\package.json" (
        cd /d "c:\Users\Shah Md Al Junaid\Desktop\dropit"
    )
)

:: Check if Node.js is installed and available in PATH
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not found on this system.
    echo Please install Node.js from https://nodejs.org/ and try again.
    echo.
    pause
    exit /b
)

:: Auto install packages if node_modules is missing
if not exist node_modules (
    echo [INFO] node_modules folder is missing. Installing dependencies...
    call npm install
    echo.
)

echo [INFO] Starting the server...
echo.
call npm start

:: Pause the window if the server crashes or exits
echo.
echo [INFO] Server stopped.
pause
