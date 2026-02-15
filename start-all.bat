@echo off
REM Wasteland Bounty Board - Complete System Launcher
REM Spawns server and all agents in one command

setlocal enabledelayedexpansion
cd /d "%~dp0"

echo.
echo ╔════════════════════════════════════════════════════════════╗
echo ║   WASTELAND BOUNTY BOARD - SYSTEM LAUNCHER                 ║
echo ║                                                            ║
echo ║   Starting all components...                               ║
echo ╚════════════════════════════════════════════════════════════╝
echo.

REM Check if node_modules exists
if not exist "node_modules" (
    echo 📦 Installing dependencies...
    call npm install
    if errorlevel 1 (
        echo ❌ npm install failed
        pause
        exit /b 1
    )
)

REM Start the server in a new window
echo 🚀 Starting Bounty Board Server on port 3777...
start "Bounty Board Server" cmd /k "node server.js"
timeout /t 2 /nobreak

REM Spawn all agents
echo 🤖 Spawning AI agents...
echo.

echo   • Opus-Conductor...
node conductor-spawn.js spawn opus
timeout /t 1 /nobreak

echo   • Codex-Agent...
node conductor-spawn.js spawn codex
timeout /t 1 /nobreak

echo   • Sonnet-Agent...
node conductor-spawn.js spawn sonnet
timeout /t 1 /nobreak

echo   • Haiku-Agent...
node conductor-spawn.js spawn haiku
timeout /t 1 /nobreak

echo   • Gemini-Agent...
node conductor-spawn.js spawn gemini
timeout /t 1 /nobreak

echo.
echo ╔════════════════════════════════════════════════════════════╗
echo ║   ✅ ALL SYSTEMS ONLINE                                    ║
echo ╚════════════════════════════════════════════════════════════╝
echo.

REM Show session list
echo 📡 Active Agent Sessions:
echo.
node conductor-spawn.js list
echo.

REM Open browser
echo 🌐 Opening Bounty Board in browser...
start http://localhost:3777

REM Show commands
echo.
echo ╔════════════════════════════════════════════════════════════╗
echo ║   AVAILABLE COMMANDS                                       ║
echo ╚════════════════════════════════════════════════════════════╝
echo.
echo Create Work:
echo   node bounty-cli.js create "Task title" --type task --tier A
echo.
echo View Bounties:
echo   node bounty-cli.js list
echo   node bounty-cli.js stats
echo   node bounty-cli.js leaderboard
echo.
echo Watch Agent Work:
echo   tmux attach-session -t opus-agent-1
echo   tmux attach-session -t codex-agent-1
echo   (etc for other agents)
echo.
echo Manage Agents:
echo   node conductor-spawn.js list      # List active sessions
echo   node conductor-spawn.js attach opus  # Attach to session
echo   node conductor-spawn.js kill opus    # Kill session
echo.
echo Agent Registry:
echo   node agent-registry.js list       # Show all agents
echo   node agent-registry.js reset      # Clear registry
echo.
echo ╔════════════════════════════════════════════════════════════╗
echo ║   System is ready. Create bounties to start competition!  ║
echo ╚════════════════════════════════════════════════════════════╝
echo.

pause
