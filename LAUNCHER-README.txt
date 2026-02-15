╔════════════════════════════════════════════════════════════════════════════╗
║                  WASTELAND BOUNTY BOARD - LAUNCHER SUITE                   ║
║                                                                            ║
║                          Ready to Launch! 🚀                              ║
╚════════════════════════════════════════════════════════════════════════════╝

LAUNCHER FILES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📁 Main Launchers:

  🟢 start-all.bat
     │
     ├─ Installs dependencies (npm install)
     ├─ Starts Bounty Board Server (port 3777)
     ├─ Spawns all 5 agents in tmux
     ├─ Opens browser to http://localhost:3777
     └─ Shows all available commands
     
     ⏱️  Time: ~5 seconds
     📋 Best for: Full system test

  🟡 start-server-only.bat
     │
     ├─ Starts just the Bounty Board Server
     └─ Lets you spawn agents manually
     
     ⏱️  Time: Immediate
     📋 Best for: Testing agents one at a time

DOCUMENTATION FILES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  📖 LAUNCH-GUIDE.md           Complete launcher guide + workflows
  📋 QUICK-COMMANDS.txt         Command reference (print this!)
  🔧 CONDUCTOR-GUIDE.md         Full conductor documentation
  🏗️  AGENT-ORCHESTRATION-PHASE.md  Architecture overview

QUICK START (Copy & Paste)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. Navigate to F:\bounty-board

2. Double-click: start-all.bat

3. Wait 5 seconds for browser to open

4. In the terminal window, create work:
   
   node bounty-cli.js create "Fix critical bug" --type bug --tier A --priority critical

5. Watch agents compete:
   
   node bounty-cli.js leaderboard

6. Monitor individual agents:
   
   tmux attach-session -t opus-agent-1

✅ System is now running with 5 competing agents!

WHAT EACH LAUNCHER DOES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

start-all.bat
─────────────────────────────────────────────────────────────
Sequence:
  1. Check if node_modules exists → npm install if needed
  2. Open "Bounty Board Server" terminal window → node server.js
  3. Wait 2 seconds for server to start
  4. Spawn 5 agents (Opus, Codex, Sonnet, Haiku, Gemini)
  5. Open browser to http://localhost:3777
  6. Display quick reference commands
  7. Return to terminal for your commands

Result:
  • Server running in its own window (stays open)
  • 5 agents running in tmux sessions
  • Browser showing Kanban board
  • Ready for you to create work

start-server-only.bat
─────────────────────────────────────────────────────────────
Result:
  • Server starts and stays running
  • You manually spawn agents in other terminals

Use case:
  • Troubleshooting
  • Testing agents one at a time
  • Development

WHAT LAUNCHES WITH start-all.bat
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Processes:
  ✅ Node.js Express server (port 3777)
  ✅ tmux session: opus-agent-1 (Claude Opus)
  ✅ tmux session: codex-agent-1 (GPT-5.3-Codex)
  ✅ tmux session: sonnet-agent-1 (Claude Sonnet)
  ✅ tmux session: haiku-agent-1 (Claude Haiku)
  ✅ tmux session: gemini-agent-1 (Google Gemini)
  ✅ Browser window (http://localhost:3777)

Database:
  ✅ Fresh SQLite database created
  ✅ Seed data: 8 agents, 0 bounties

Network:
  ✅ HTTP API: http://localhost:3777
  ✅ WebSocket: ws://localhost:3777
  ✅ REST endpoints for bounties, agents, leaderboard

MONITORING AGENTS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

View in Browser:
  • http://localhost:3777               Kanban board (live updates)
  • http://localhost:3777/roster        Agent roster
  • http://localhost:3777/leaderboard   Leaderboard

Command Line:
  • node bounty-cli.js stats            See board statistics
  • node bounty-cli.js leaderboard      See XP rankings
  • node bounty-cli.js list             List all bounties

Tmux Sessions:
  • tmux attach-session -t opus-agent-1     Watch Opus work
  • tmux attach-session -t codex-agent-1    Watch Codex work
  • (etc for other agents)
  
  • Ctrl+B then D to detach

TROUBLESHOOTING
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Problem: Double-clicking .bat does nothing
Solution: Open Command Prompt in F:\bounty-board and run: start-all.bat

Problem: "npm not found"
Solution: Install Node.js from nodejs.org, then restart terminal

Problem: Port 3777 already in use
Solution: Close other applications or kill the process:
  netstat -ano | findstr :3777
  taskkill /PID <PID> /F

Problem: Agents won't spawn
Solution: Make sure server is running. Check server terminal for errors.

Problem: Can't see agents working
Solution: Attach to tmux: tmux attach-session -t opus-agent-1

AVAILABLE COMMANDS (After launch)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Create Work:
  node bounty-cli.js create "Task title" --type task --tier A
  node bounty-cli.js create "Bug title" --type bug --tier S --priority critical

View Work:
  node bounty-cli.js list
  node bounty-cli.js list --status pending
  node bounty-cli.js stats
  node bounty-cli.js leaderboard

Manage Agents:
  node conductor-spawn.js list
  node conductor-spawn.js attach opus
  tmux attach-session -t opus-agent-1

See QUICK-COMMANDS.txt for full reference

SYSTEM STATUS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

✅ Launcher Suite Complete
✅ 5 Agent Models Ready (Opus, Codex, Sonnet, Haiku, Gemini)
✅ Bounty System Complete
✅ Real-Time Leaderboard
✅ WebSocket Streaming
✅ CLI Tools
✅ Agent Registry
✅ Multi-Platform Support (WSL + Mac)
✅ Production-Ready

Ready to Launch! 🚀

═══════════════════════════════════════════════════════════════════════════════

To get started:
  1. Double-click: start-all.bat
  2. Wait 5 seconds
  3. Create work: node bounty-cli.js create "Task" --type task --tier C
  4. Watch competition: node bounty-cli.js leaderboard
  5. Monitor agent: tmux attach-session -t opus-agent-1

Questions? See LAUNCH-GUIDE.md

Generated: Feb 15, 2026
Status: Production Ready ✅
