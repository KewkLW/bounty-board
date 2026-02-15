# Wasteland Bounty Board - Quick Start (Agent Orchestration)

## 30-Second Startup

### Terminal 1: Start Server
```bash
cd F:/bounty-board
npm install  # If not already done
node server.js
```

### Terminal 2: Spawn Agents
```bash
cd F:/bounty-board

# Spawn all agents
node conductor-spawn.js spawn opus
node conductor-spawn.js spawn codex
node conductor-spawn.js spawn sonnet
node conductor-spawn.js spawn haiku
node conductor-spawn.js spawn gemini

# Verify they're running
node conductor-spawn.js list
```

### Terminal 3: Create Work
```bash
cd F:/bounty-board

# Create some bounties
node bounty-cli.js create "Fix auth crash" --type bug --tier A --priority critical
node bounty-cli.js create "Optimize queries" --type task --tier B

# Watch agents claim and complete them
node bounty-cli.js list

# Check leaderboard
node bounty-cli.js leaderboard
```

### Terminal 4: Watch Agent Work
```bash
# Attach to Opus agent
tmux attach-session -t opus-agent-1

# Or Codex
tmux attach-session -t codex-agent-1

# Detach: Ctrl+B then D
```

---

## Essential Commands

### Spawning

```bash
# Spawn on WSL (default)
node conductor-spawn.js spawn opus
node conductor-spawn.js spawn codex
node conductor-spawn.js spawn sonnet
node conductor-spawn.js spawn haiku
node conductor-spawn.js spawn gemini

# Spawn on Mac
node conductor-spawn.js spawn codex --mac

# List active sessions
node conductor-spawn.js list

# Attach to session
node conductor-spawn.js attach opus
# or
tmux attach-session -t opus-agent-1

# Kill agent
node conductor-spawn.js kill codex
```

### Work Management

```bash
# Create bounty
node bounty-cli.js create "Title" --type task --tier A

# List bounties
node bounty-cli.js list                    # All
node bounty-cli.js list --status pending   # Pending only
node bounty-cli.js list --type bug         # Bugs only

# View bounty details
node bounty-cli.js view 5

# Complete/fail
node bounty-cli.js complete 5
node bounty-cli.js fail 7 --error "Reason"

# Statistics
node bounty-cli.js stats
node bounty-cli.js leaderboard
```

---

## Model Quick Reference

| Model | Level | Role | Types |
|-------|-------|------|-------|
| Opus | 9001 | Conductor / All work | Bugs + Tasks |
| Codex | 50 | Coding specialist | Bugs + Tasks |
| Sonnet | 42 | Research only | Tasks only |
| Haiku | 25 | Quick research | Tasks only |
| Gemini | 38 | Research + Coding | Tasks only |

---

## Example: Bug Fix Workflow

```bash
# 1. Spawn agents (Terminal 2)
node conductor-spawn.js spawn opus
node conductor-spawn.js spawn codex

# 2. Create a high-priority bug (Terminal 3)
node bounty-cli.js create "Production auth failure" \
  --type bug --tier A --priority critical

# 3. Watch them work (Terminal 4)
tmux attach-session -t opus-agent-1

# Inside the session, you'll see:
# ✅ Claimed bounty #1: ERR_0099 - Production auth failure
# ⚙️  Working...
# 🎉 Completed! Earned 2500 XP

# 4. Verify completion (Terminal 3)
node bounty-cli.js list --status done
node bounty-cli.js leaderboard
```

---

## URLs

- **Bounty Board**: http://localhost:3777
- **Board Kanban**: http://localhost:3777/
- **Agent Roster**: http://localhost:3777/roster
- **Leaderboard**: http://localhost:3777/leaderboard
- **WebSocket**: ws://localhost:3777

---

## Full Documentation

- `CLAUDE.md` - Main project overview
- `CONDUCTOR-GUIDE.md` - Detailed conductor guide (spawning/managing agents)
- `AGENT-ORCHESTRATION-PHASE.md` - Architecture and features
- `PHASE-2-SUMMARY.md` - SDK, CLI tool, WebSocket details
- `PHASE-1-SUMMARY.md` - Original bounty board design

---

## Troubleshooting

**Server won't start:**
- Port 3777 already in use? Kill: `lsof -i :3777 | kill <PID>`
- Or use different port: `PORT=3778 node server.js`

**Agents won't spawn:**
- Is server running? Start: `node server.js`
- Check tmux: `tmux list-sessions`

**Agents not claiming work:**
- Check bounties exist: `node bounty-cli.js list --status pending`
- Check agent is running: `tmux attach-session -t opus-agent-1`

**Can't SSH to Mac agents:**
- Verify: `ssh mac echo "Connected"`
- Use IP: `ssh littlekewk@100.125.173.46`

---

## Next Steps

1. ✅ Start server and spawn agents
2. ✅ Create bounties
3. ✅ Watch agents work via tmux
4. ✅ Check leaderboard for XP tracking
5. 🔄 Extend with custom agent logic
6. 🔄 Add more models/instances

**Ready to orchestrate!** 🤖⚙️
