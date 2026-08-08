@echo off
title Lowkey Chopped Elite - Local Server
cd /d "%~dp0"

echo.
echo   ========================================
echo     LOWKEY CHOPPED ELITE - Local Server
echo   ========================================
echo.

:: Try Python 3 first
python --version >nul 2>&1
if %errorlevel% equ 0 (
    echo   [+] Using Python HTTP server
    echo   [+] Open http://localhost:8080 in your browser
    echo   [+] Press Ctrl+C to stop
    echo.
    start "" http://localhost:8080
    python -m http.server 8080
    goto :end
)

:: Try Python (maybe python3 alias)
python3 --version >nul 2>&1
if %errorlevel% equ 0 (
    echo   [+] Using Python3 HTTP server
    echo   [+] Open http://localhost:8080 in your browser
    echo   [+] Press Ctrl+C to stop
    echo.
    start "" http://localhost:8080
    python3 -m http.server 8080
    goto :end
)

:: Try npx
npx --version >nul 2>&1
if %errorlevel% equ 0 (
    echo   [+] Using npx http-server
    echo   [+] Open http://localhost:8080 in your browser
    echo   [+] Press Ctrl+C to stop
    echo.
    start "" http://localhost:8080
    npx http-server . -p 8080 -c-1
    goto :end
)

:: Nothing found - fallback
echo   [-] No server found! Install Python or Node.js.
echo   [-] Opening index.html directly...
echo.
start "" "%~dp0index.html"
pause

:end
