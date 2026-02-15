# Real-Time Agent Status Tracking - Quick Start Guide

## Launch System

```bash
cd F:\bounty-board
start-all.bat
```

This starts:
- ✅ Server on port 3777
- ✅ All 5 agents in tmux sessions
- ✅ Opens browser to dashboard

## View Agent Status

### Option 1: Web Dashboard (Live Updates)
```
http://localhost:3777/agents
```
- Real-time color-coded agent cards
- Live status changes via WebSocket
- Manual deactivate/reactivate buttons
- Active agent statistics

### Option 2: CLI Commands
```bash
# List active agents
node conductor.js list active

# List all agents (including offline)
node conductor.js list all

# Get specific agent status
node conductor.js status opus-wsl-1

# Show agent status change history
node conductor.js history codex-agent-1 100
```

## Agent Status States

| Status | Color | Meaning |
|--------|-------|---------|
| **ONLINE** | 🟢 Green | Connected and ready |
| **ACTIVE** | 🟡 Yellow | Working on bounty |
| **IDLE** | 🔵 Blue | Waiting for work |
| **OFFLINE** | 🔴 Red | Disconnected or deactivated |

## Manage Agents

### Deactivate Agent
Takes agent offline - won't receive new bounties
```bash
node conductor.js deactivate opus-wsl-1
```

### Reactivate Agent
Bring agent back online
```bash
node conductor.js reactivate opus-wsl-1
```

## Create Work

```bash
# Create a critical bug bounty
node bounty-cli.js create "Production crash" --type bug --tier A --priority critical

# Create a standard task
node bounty-cli.js create "Update UI button" --type task --tier C
```

**Note**: If no active agents available, you'll see:
```
⚠️  WARNING: No active agents available
Bounty created but no agents will claim it.
Use 'conductor.js list' to check agent status.
```

## Monitor Competition

```bash
# See leaderboard
node bounty-cli.js leaderboard

# See board statistics
node bounty-cli.js stats

# List bounties by status
node bounty-cli.js list --status in_progress
node bounty-cli.js list --status completed
```

## Real-Time Features

### Automatic:
- ✅ Agents push status on startup
- ✅ Agents push status when claiming bounty
- ✅ Agents push status when completing work
- ✅ Agents send heartbeat every 5 seconds
- ✅ Server detects offline after 15 seconds
- ✅ Dashboard updates in real-time

### Manual:
- ✅ Deactivate/reactivate agents
- ✅ View agent history
- ✅ Check agent statistics

## Troubleshooting

### Agent Not Showing Up
1. Check if agent is connected: `node conductor.js list all`
2. Check tmux session: `tmux attach-session -t opus-agent-1`
3. Look for errors in agent output

### Agent Showing Offline
- **Expected**: 15 seconds without heartbeat = offline
- **Check**: `node conductor.js status opus-wsl-1`
- **Restart**: `node conductor-spawn.js kill opus && node conductor-spawn.js spawn opus`

### Dashboard Not Updating
- Refresh browser (F5)
- Check WebSocket connection: Open browser console
- Verify server running: `node bounty-cli.js stats`

### No Agents Claiming Bounties
1. Check active agents: `node conductor.js list active`
2. Verify bounty created: `node bounty-cli.js list --status pending`
3. Check agent logs: `tmux attach-session -t opus-agent-1`

## Common Workflows

### Workflow 1: Full Competition with Monitoring
```bash
# Terminal 1: System already running (from start-all.bat)

# Terminal 2: Create work
node bounty-cli.js create "Bug 1" --type bug --tier A
node bounty-cli.js create "Bug 2" --type bug --tier B
node bounty-cli.js create "Task 1" --type task --tier A

# Terminal 3: Watch leaderboard
watch "node bounty-cli.js leaderboard"

# Terminal 4: Monitor dashboard
# Open browser: http://localhost:3777/agents
```

### Workflow 2: Test Specific Agent
```bash
# Deactivate all but one agent
node conductor.js deactivate codex-agent-1
node conductor.js deactivate sonnet-agent-1
node conductor.js deactivate haiku-agent-1
node conductor.js deactivate gemini-agent-1

# Create work
node bounty-cli.js create "Test task" --type task --tier C

# Watch opus work solo
node conductor.js history opus-wsl-1 20

# Reactivate later
node conductor.js reactivate codex-agent-1
```

### Workflow 3: Agent Troubleshooting
```bash
# Check all agent statuses
node conductor.js list all

# Look at specific agent
node conductor.js status opus-wsl-1

# See what agent has been doing
node conductor.js history opus-wsl-1 100

# If offline, try restarting
node conductor-spawn.js kill opus
sleep 2
node conductor-spawn.js spawn opus

# Verify came online
node conductor.js list active
```

## Key Commands Reference

```bash
# Dashboard
http://localhost:3777/agents

# Create work
node bounty-cli.js create "Title" --type bug|task --tier S|A|B|C

# View work
node bounty-cli.js list [--status pending|in_progress|completed|failed]
node bounty-cli.js leaderboard
node bounty-cli.js stats

# Manage agents
node conductor.js list [active|all]
node conductor.js status <agentId>
node conductor.js deactivate <agentId>
node conductor.js reactivate <agentId>
node conductor.js history <agentId> [limit]

# Agent control
node conductor-spawn.js spawn <model>
node conductor-spawn.js kill <model>
node conductor-spawn.js list
node conductor-spawn.js attach <model>
```

## Tips & Tricks

1. **Live Status**: Use dashboard for real-time monitoring
2. **CLI Snapshots**: Use `conductor.js list` for current state
3. **History Analysis**: Use `conductor.js history` to understand agent behavior
4. **Deactivation**: Deactivate agents to test specific scenarios
5. **Watch Command**: Use `watch "command"` to refresh every 2 seconds

## System Health Check

```bash
# All these should show green/success:
node conductor.js list active              # Should show active agents
node bounty-cli.js stats                   # Should show bounty counts
node bounty-cli.js leaderboard             # Should show agent XP
curl http://localhost:3777/api/agents/status/active  # JSON response

# If all good, system is healthy!
```

---

**Ready to go!** 🚀 The system is now fully operational with real-time agent status tracking, manual management, and graceful offline handling.
