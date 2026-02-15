# Wasteland Bounty Board - Conductor Agent Spawning

## Overview

The Conductor (Opus) can now spawn and manage tmux sessions for each AI agent model:
- **Opus** - Orchestrator (Level 9001)
- **Sonnet** - Research & Testing (Level 42)
- **Haiku** - Quick Research (Level 25)
- **Codex** - Coding & Research (Level 50)
- **Gemini** - Research & Coding (Level 38)

Each agent runs in its own tmux session, auto-claims bounties, and completes work.

---

## Quick Start

### 1. Start the Bounty Board

```bash
cd F:/bounty-board
npm install
node server.js
```

Server runs on `http://localhost:3777` with WebSocket on `ws://localhost:3777`

### 2. Spawn Agents

```bash
# Spawn Opus agent (WSL)
node conductor-spawn.js spawn opus

# Spawn Codex agent (WSL)
node conductor-spawn.js spawn codex

# Spawn Sonnet agent (Mac)
node conductor-spawn.js spawn sonnet --mac

# Spawn Gemini agent (WSL)
node conductor-spawn.js spawn gemini
```

### 3. List Active Sessions

```bash
node conductor-spawn.js list
```

Output:
```
📡 ACTIVE AGENT SESSIONS

  opus-agent-1           [Opus-Conductor]
    → tmux attach-session -t opus-agent-1
  codex-agent-1          [Codex-Agent]
    → tmux attach-session -t codex-agent-1
```

### 4. Attach to an Agent

```bash
# Attach to Opus session
tmux attach-session -t opus-agent-1

# Or use the shortcut
node conductor-spawn.js attach opus
```

### 5. Create Work for Agents

```bash
# Create a high-tier bug bounty
node bounty-cli.js create "Fix production crash" --type bug --tier A --priority critical

# Create tasks
node bounty-cli.js create "Refactor auth system" --type task --tier A --priority high

# List pending work
node bounty-cli.js list --status pending

# View stats
node bounty-cli.js stats
```

### 6. Watch Agents Work

The agents will:
1. Auto-claim available bounties
2. Simulate work (progress: 25%, 50%, 75%, 100%)
3. Complete tasks and earn XP
4. Move to leaderboard

Watch the leaderboard update:
```bash
watch -n 1 'node bounty-cli.js leaderboard'
```

---

## Architecture

```
┌─────────────────────────────────────────────────┐
│ CONDUCTOR (You)                                 │
│ • node conductor-spawn.js spawn [model]         │
│ • node bounty-cli.js create "..."               │
│ • Monitor agents via tmux                       │
└──────────────┬──────────────────────────────────┘
               │
     ┌─────────┼──────────────┬──────────┐
     │         │              │          │
     ▼         ▼              ▼          ▼
  [tmux]   [tmux]         [SSH]      [SSH]
  Opus-1   Codex-1    Sonnet/WSL   Gemini/WSL
  (claude) (codex)    (claude)     (claude)
     │         │              │          │
     └─────────┴──────────────┴──────────┘
               │
               ▼
     BOUNTY BOARD SERVER (3777)
     • REST API
     • WebSocket
     • SQLite DB
     • Atomic claiming
```

---

## CLI Reference

### Spawn Commands

```bash
node conductor-spawn.js spawn <model> [--wsl|--mac]

Models:
  opus    - Opus-Conductor (Leader, all work types)
  sonnet  - Sonnet-Agent (Research only, no code)
  haiku   - Haiku-Agent (Quick research tasks)
  codex   - Codex-Agent (Coding + research)
  gemini  - Gemini-Agent (Research + coding)

Options:
  --wsl   - Spawn on local WSL (default)
  --mac   - Spawn on remote Mac via SSH

Examples:
  node conductor-spawn.js spawn opus
  node conductor-spawn.js spawn codex --mac
  node conductor-spawn.js spawn gemini --wsl
```

### Session Management

```bash
# List all active sessions
node conductor-spawn.js list

# Attach to a session
node conductor-spawn.js attach <model>
node conductor-spawn.js attach opus

# Kill a session
node conductor-spawn.js kill <model>
node conductor-spawn.js kill sonnet
```

---

## Agent Model Preferences

Each agent has preferred tier/type based on capability:

| Agent | Preferred Tiers | Types | Notes |
|-------|-----------------|-------|-------|
| Opus | S, A | tasks, bugs | Takes everything, strong |
| Sonnet | A, B, C | tasks only | Research focus, no code |
| Haiku | C, B | tasks only | Quick lightweight work |
| Codex | S, A, B | tasks, bugs | Coding specialist |
| Gemini | A, B | tasks only | Research + coding |

Agents will claim work matching their strengths first.

---

## Workflow Example

### Scenario: Fix a Production Bug

**Step 1: Create the bounty**
```bash
node bounty-cli.js create "Production auth failure" \
  --type bug --tier A --priority critical \
  --desc "Users can't log in after deploy"
```

**Step 2: Agents claim work**
- Opus and Codex see the high-tier bug
- Opus claims it first (faster)
- Works on it for ~10 seconds
- Completes and earns 2500 XP (tier A bug base + bonuses)

**Step 3: Monitor progress**
```bash
# Watch in real-time
node bounty-cli.js list --status in_progress

# Or tmux into the agent
tmux attach-session -t opus-agent-1
```

**Step 4: Verify completion**
```bash
node bounty-cli.js list --status done
node bounty-cli.js leaderboard
```

---

## Detailed Walkthrough

### Creating and Running Your First Agent

```bash
# 1. Terminal 1: Start bounty board server
cd F:/bounty-board
node server.js

# 2. Terminal 2: Spawn Opus agent
node conductor-spawn.js spawn opus

# Output:
# 🚀 Spawning OPUS agent on WSL...
#    Session: opus-agent-1
#    Agent ID: opus-wsl-1
#
# ✅ Session created: opus-agent-1
#    Location: WSL
#    Connect: tmux attach-session -t opus-agent-1
#    Model:   Opus-Conductor (Leader / Orchestrator)
#
# ✅ Agent registered with bounty board

# 3. Terminal 3: Create a bounty
node bounty-cli.js create "Test task" --type task --tier C

# 4. Terminal 2 (continued): Agent auto-claims and works
# Agent sees the bounty, claims it, simulates work, completes it

# 5. Terminal 3: Check results
node bounty-cli.js stats
node bounty-cli.js leaderboard

# 6. Terminal 4: Attach to agent session to watch
tmux attach-session -t opus-agent-1

# Inside tmux (shows agent work in progress):
# ⚙️  Working on TSK_2076: "Test task"
#    Tier: C | Reward: 150 XP
#    Progress: 25%
#    Progress: 50%
#    Progress: 75%
#    ✅ Work complete!
#
# 🎉 Completed! Earned 150 XP (base: 150)
#    Position: #1 of 8

# Detach: Ctrl+B then D
```

---

## Agent Session Details

### Session Names

Sessions are named: `{model}-agent-{number}`

Examples:
- `opus-agent-1`
- `codex-agent-1`
- `sonnet-agent-1`
- `gemini-agent-1`
- `haiku-agent-1`

**Note:** Only 1 of each model allowed. To spawn a second Codex, you'd need to modify `max_instances` in the code.

### Connecting to Sessions

**From Windows:**
```bash
tmux attach-session -t opus-agent-1
```

**From Mac:**
```bash
ssh mac "tmux attach-session -t opus-agent-1"
```

**From Phone (via Tailscale):**
```bash
# On iPhone via Blink or Termius
ssh kewkd@100.89.129.24       # Windows
tmux attach-session -t opus-agent-1

# Or Mac
ssh littlekewk@100.125.173.46 # Mac
tmux attach-session -t opus-agent-1
```

### Inside a Session

Once attached to a tmux session, you see:
- Agent ID and stats
- Bounties being claimed
- Progress updates
- XP earned

**Common tmux commands:**
- `Ctrl+B, D` - Detach (leave session running)
- `Ctrl+B, C` - New window
- `Ctrl+B, N` - Next window
- `Ctrl+B, P` - Previous window
- `Ctrl+B, [` - Enter copy/scroll mode (Page Up/Down)
- `Ctrl+B, ]` - Paste

---

## Spawning on Different Platforms

### WSL Agents (Local)

```bash
node conductor-spawn.js spawn opus
# or
node conductor-spawn.js spawn opus --wsl
```

- Runs on local Windows machine via WSL
- Uses `tmux` directly
- Session connects: `tmux attach-session -t {name}`

### Mac Agents (Remote)

```bash
node conductor-spawn.js spawn codex --mac
```

- Runs on remote Mac via SSH
- Requires `ssh mac` to be configured (Tailscale or LAN)
- Session connects: `ssh mac "tmux attach-session -t {name}"`

---

## Model Commands

Each model runs with specific CLI flags:

```
Opus:   claude --dangerously-skip-permissions --chrome codex --yolo
Sonnet: claude --dangerously-skip-permissions --chrome sonnet --yolo
Haiku:  claude --dangerously-skip-permissions --chrome haiku --yolo
Codex:  codex --yolo --model gpt-5.3-codex --reasoning-effort high
Gemini: gemini --yolo
```

These are automatically injected by the spawner—you don't need to type them.

---

## Troubleshooting

### Agent won't spawn

**Error: "address already in use"**
- The bounty board server isn't running
- Solution: `node server.js` in another terminal

**Error: "tmux: can't connect to /tmp/tmux-1000/default"**
- tmux server crashed
- Solution: `tmux kill-server` then try again

### Agent won't claim bounties

**Check agent status:**
```bash
node bounty-cli.js list --status pending
node bounty-cli.js stats
```

**Check if agent is running:**
```bash
tmux list-sessions
```

**If session exists but not working, attach and check:**
```bash
tmux attach-session -t opus-agent-1
```

### Can't SSH to Mac

**Test connectivity:**
```bash
ssh mac echo "Connected"
```

**If that fails:**
- Check Tailscale is running on both machines
- Verify SSH key auth: `ssh -i ~/.ssh/id_ed25519 littlekewk@100.125.173.46`

---

## Advanced: Creating Multiple Agents

Currently, only 1 of each model is allowed. To enable multiple instances:

**Edit `conductor-spawn.js`:**
```javascript
'opus': {
  // ...
  max_instances: 3,  // Change from 1 to 3
},
```

This allows spawning:
- `opus-agent-1`
- `opus-agent-2`
- `opus-agent-3`

---

## Integration with Bounty Board

The spawner automatically:
1. Creates tmux sessions
2. Registers agents with bounty board API
3. Sets session titles to show connect commands
4. Launches agents with correct CLI flags

Agents will then:
1. Poll bounty board for available work
2. Claim bounties matching their tier
3. Report progress
4. Complete tasks and earn XP

---

## Next Steps

1. **Spawn all agents:**
   ```bash
   node conductor-spawn.js spawn opus
   node conductor-spawn.js spawn codex
   node conductor-spawn.js spawn haiku
   node conductor-spawn.js spawn sonnet
   node conductor-spawn.js spawn gemini --mac
   ```

2. **Create work:**
   ```bash
   node bounty-cli.js create "Task 1" --type task --tier A
   node bounty-cli.js create "Bug fix" --type bug --tier B
   ```

3. **Watch them work:**
   ```bash
   node bounty-cli.js list
   node bounty-cli.js stats
   ```

4. **Monitor via tmux:**
   ```bash
   tmux attach-session -t opus-agent-1
   ```

---

## Summary

✅ Conductor can spawn agent sessions with one command
✅ Each agent runs in isolated tmux session
✅ Agents auto-claim and complete bounties
✅ You can watch them work via tmux
✅ Full integration with bounty-board API
✅ Support for WSL and Mac agents
✅ Only 1 of each model (configurable)

**The bounty board is now a complete agent orchestration platform!**
