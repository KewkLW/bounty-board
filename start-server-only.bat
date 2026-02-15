@echo off
REM Start just the Bounty Board Server
REM (Useful if you want to spawn agents manually)

cd /d "%~dp0"

echo.
echo ╔════════════════════════════════════════════════════════════╗
echo ║   WASTELAND BOUNTY BOARD - SERVER ONLY                     ║
echo ╚════════════════════════════════════════════════════════════╝
echo.

if not exist "node_modules" (
    echo 📦 Installing dependencies...
    call npm install
)

echo 🚀 Starting server on http://localhost:3777
echo.
echo In another terminal, spawn agents:
echo   node conductor-spawn.js spawn opus
echo   node conductor-spawn.js spawn codex
echo   etc.
echo.
echo Press Ctrl+C to stop the server.
echo.

node server.js

pause
