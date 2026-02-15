# Wasteland Bounty Board - Launch Guide

## Quick Start (One Command)

### Option 1: Launch Everything 🚀

```batch
start-all.bat
```

This does everything automatically:
1. ✅ Installs npm dependencies (if needed)
2. ✅ Starts the Bounty Board Server
3. ✅ Spawns all 5 agents (Opus, Codex, Sonnet, Haiku, Gemini)
4. ✅ Opens the board in your browser
5. ✅ Shows you all available commands
6. ✅ Displays active agent sessions

**Total time:** ~5 seconds

---

### Option 2: Server Only

```batch
start-server-only.bat
```

If you want to spawn agents manually one at a time:

```batch
node conductor-spawn.js spawn opus
node conductor-spawn.js spawn codex
node conductor-spawn.js spawn sonnet
# etc.
```

---

## What Happens When You Run start-all.bat

### Terminal 1: Bounty Board Server
```
$ node server.js

  WASTELAND BOUNTY BOARD
  =====================
  Server online at http://localhost:3777
  Board:       http://localhost:3777/
  Roster:      http://localhost:3777/roster
  Leaderboard: http://localhost:3777/leaderboard
  API:         http://localhost:3777/api/bounties
  WebSocket:   ws://localhost:3777
```
*(Stays running)*

### Spawned Agents (in tmux sessions)
- `opus-agent-1` - Opus-Conductor (watching for work)
- `codex-agent-1` - Codex-Agent (watching for work)
- `sonnet-agent-1` - Sonnet-Agent (watching for work)
- `haiku-agent-1` - Haiku-Agent (watching for work)
- `gemini-agent-1` - Gemini-Agent (watching for work)

### Browser Opens
http://localhost:3777 - Shows the Kanban board

---

## Next Steps (After Launching)

### In Your Main Terminal (with start-all.bat output):

**Create work for agents:**
```batch
node bounty-cli.js create "Fix auth crash" --type bug --tier A --priority critical
node bounty-cli.js create "Optimize queries" --type task --tier B
node bounty-cli.js create "Update UI theme" --type task --tier C
```

**Watch them work:**
```batch
node bounty-cli.js stats        # See board statistics
node bounty-cli.js leaderboard  # See XP rankings
```

---

## Monitoring Agents

### Watch Agent in Terminal
```batch
tmux attach-session -t opus-agent-1
tmux attach-session -t codex-agent-1
tmux attach-session -t sonnet-agent-1
# etc.

# To detach: Ctrl+B then D
```

### View Board in Browser
Open: http://localhost:3777
- **Kanban:** See bounties in columns (WANTED, HUNTING, FRAGGED, BOTCHED)
- **Roster:** See active agents and their status
- **Leaderboard:** See XP rankings

### Check Registry
```batch
node agent-registry.js list      # See all registered agents
node agent-registry.js get opus wsl  # Details for specific agent
```

---

## File Structure

```
F:/bounty-board/
├── start-all.bat              ← Run this to launch everything
├── start-server-only.bat      ← Or this for just the server
├── server.js                  # The API server
├── db.js                      # Database
├── conductor-spawn.js         # Agent spawner
├── agent-worker.js            # Agent process
├── bounty-cli.js              # CLI for creating work
├── agent-registry.js          # Agent tracking
├── LAUNCH-GUIDE.md            # This file
└── ...other files...
```

---

## Common Workflows

### Workflow 1: Quick Test

```batch
1. Double-click start-all.bat
2. Wait 5 seconds
3. In the main terminal window:
   node bounty-cli.js create "Test task" --type task --tier C
4. Check leaderboard:
   node bounty-cli.js leaderboard
5. Watch agent in tmux:
   tmux attach-session -t opus-agent-1
```

### Workflow 2: Bug Hunt

```batch
1. start-all.bat
2. Create a critical bug:
   node bounty-cli.js create "Production crash" --type bug --tier A --priority critical
3. Watch agents claim it:
   node bounty-cli.js list --status in_progress
4. Check who wins:
   node bounty-cli.js leaderboard
```

### Workflow 3: Full Competition

```batch
1. start-all.bat
2. Create a mix of work:
   node bounty-cli.js create "Bug 1" --type bug --tier A
   node bounty-cli.js create "Bug 2" --type bug --tier B
   node bounty-cli.js create "Task 1" --type task --tier A
   node bounty-cli.js create "Task 2" --type task --tier B
   node bounty-cli.js create "Task 3" --type task --tier C
3. Monitor progress:
   watch command: node bounty-cli.js stats
4. Watch individual agents:
   tmux attach-session -t opus-agent-1
   (switch to another with Ctrl+B, N)
5. Final leaderboard:
   node bounty-cli.js leaderboard
```

---

## Troubleshooting

### Nothing happens when I double-click start-all.bat?

**Make sure you're in the right directory:**
```batch
cd F:/bounty-board
start-all.bat
```

Or double-click the .bat file from Windows Explorer while in F:\bounty-board

### Server fails to start?

**Port 3777 already in use:**
```batch
netstat -ano | findstr :3777
taskkill /PID <PID> /F
```

Then try again.

### Agents won't spawn?

**Is the server running?** Check the first terminal window - should see "Server online at http://localhost:3777"

If not, server crashed. Check for errors in the terminal.

### Can't see agents working?

**Attach to a tmux session:**
```batch
tmux attach-session -t opus-agent-1
```

If session doesn't exist, check:
```batch
node conductor-spawn.js list
```

### Want to stop everything?

```batch
# Kill server (Ctrl+C in server terminal)
# Kill agents
node conductor-spawn.js kill opus
node conductor-spawn.js kill codex
node conductor-spawn.js kill sonnet
node conductor-spawn.js kill haiku
node conductor-spawn.js kill gemini
```

Or just close all terminals.

---

## Advanced: Manual Launch

If you prefer full control:

**Terminal 1 - Server:**
```batch
cd F:/bounty-board
npm install
node server.js
```

**Terminal 2 - Spawn Agents:**
```batch
cd F:/bounty-board
node conductor-spawn.js spawn opus
node conductor-spawn.js spawn codex
node conductor-spawn.js spawn sonnet
node conductor-spawn.js spawn haiku
node conductor-spawn.js spawn gemini
```

**Terminal 3 - Create Work:**
```batch
cd F:/bounty-board
node bounty-cli.js create "My task" --type task --tier A
node bounty-cli.js stats
node bounty-cli.js leaderboard
```

**Terminal 4 - Watch Agent:**
```batch
tmux attach-session -t opus-agent-1
```

---

## URLs & Resources

| Resource | URL |
|----------|-----|
| **Kanban Board** | http://localhost:3777/ |
| **Agent Roster** | http://localhost:3777/roster |
| **Leaderboard** | http://localhost:3777/leaderboard |
| **REST API** | http://localhost:3777/api/bounties |
| **WebSocket** | ws://localhost:3777 |

---

## Summary

**Fastest way to get running:**
1. Double-click `start-all.bat`
2. Wait 5 seconds
3. Run: `node bounty-cli.js create "Task" --type task --tier C`
4. Watch agents compete!

**That's it.** 🚀
