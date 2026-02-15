# Wasteland Bounty Board - Agent Naming & Registry

## The Problem

Previously, agent IDs were hardcoded:
- `opus-wsl-1` always spawned as "opus-wsl-1"
- But if you restarted or spawned multiple times, you'd get naming conflicts
- No persistent tracking of which agents you had

## The Solution: Agent Registry

A persistent registry (`agent-registry.json`) that ensures:
1. **Deterministic naming** - Same agent name every time
2. **Consistent IDs** - Agent keeps its identity across restarts
3. **Tracking** - Know which agents exist and their details
4. **Idempotency** - Spawning the same model twice returns the same agent

---

## How It Works

### Agent ID Format

```
{model}-{platform}-{instance}

Examples:
  opus-wsl-1      # Opus on WSL, first instance
  codex-mac-1     # Codex on Mac, first instance
  sonnet-wsl-1    # Sonnet on WSL, first instance
```

### Registry Structure

File: `.agent-registry.json`

```json
{
  "agents": {
    "opus-wsl": {
      "agentId": "opus-wsl-1",
      "agentName": "Opus-Conductor",
      "sessionName": "opus-agent-1",
      "model": "opus",
      "platform": "wsl",
      "instanceNum": 1,
      "createdAt": "2026-02-15T14:45:00.000Z"
    },
    "codex-mac": {
      "agentId": "codex-mac-1",
      "agentName": "Codex-Agent",
      "sessionName": "codex-agent-1",
      "model": "codex",
      "platform": "mac",
      "instanceNum": 1,
      "createdAt": "2026-02-15T14:46:30.000Z"
    }
  },
  "nextId": {
    "opus": 2,
    "codex": 2,
    "sonnet": 1
  }
}
```

---

## Usage

### Automatic (Built Into conductor-spawn.js)

When you spawn an agent, the registry is automatically used:

```bash
# First time spawning Opus on WSL
node conductor-spawn.js spawn opus
# Creates: opus-wsl-1

# If you spawn Opus on WSL again (after restart or in another terminal)
node conductor-spawn.js spawn opus
# Returns: opus-wsl-1 (SAME AGENT - consistent)

# But if you spawn on Mac
node conductor-spawn.js spawn opus --mac
# Creates: opus-mac-1 (DIFFERENT - because different platform)
```

### Manual (CLI Tool)

```bash
# List all registered agents
node agent-registry.js list

# Get details for a specific agent
node agent-registry.js get opus wsl

# Create/retrieve an agent
node agent-registry.js create codex mac

# Remove an agent
node agent-registry.js remove sonnet wsl

# Reset entire registry (use with caution!)
node agent-registry.js reset

# Export as JSON
node agent-registry.js export
```

---

## Example Workflow

### Session 1: Initial Spawn

```bash
$ node conductor-spawn.js spawn opus

🚀 Spawning OPUS agent on WSL...
   Session: opus-agent-1
   Agent ID: opus-wsl-1

✅ Agent registered with bounty board
```

Behind the scenes:
```json
{
  "agents": {
    "opus-wsl": {
      "agentId": "opus-wsl-1",
      "agentName": "Opus-Conductor",
      ...
    }
  }
}
```

### Session 2: Spawn Same Model on Different Platform

```bash
$ node conductor-spawn.js spawn opus --mac

🚀 Spawning OPUS agent on Mac...
   Session: opus-agent-1
   Agent ID: opus-mac-1

✅ Agent registered with bounty board
```

Registry now has:
```json
{
  "agents": {
    "opus-wsl": { "agentId": "opus-wsl-1", ... },
    "opus-mac": { "agentId": "opus-mac-1", ... }
  }
}
```

### Session 3: Spawn Opus WSL Again

```bash
$ node conductor-spawn.js spawn opus

✅ Session created: opus-agent-1
   Agent ID: opus-wsl-1
```

Returns the SAME agent (no new registration needed).

### Session 4: Check Registry

```bash
$ node agent-registry.js list

📋 AGENT REGISTRY

opus-wsl-1
  Name:     Opus-Conductor
  Session:  opus-agent-1
  Platform: wsl
  Created:  2026-02-15T14:45:00.000Z

opus-mac-1
  Name:     Opus-Conductor
  Session:  opus-agent-1
  Platform: mac
  Created:  2026-02-15T14:46:30.000Z
```

---

## Multiple Instances

If you enable multiple instances per model (edit `max_instances`):

```bash
# First Opus on WSL
$ node conductor-spawn.js spawn opus
# Creates: opus-wsl-1

# Second Opus on WSL (if max_instances: 2)
$ node conductor-spawn.js spawn opus
# Creates: opus-wsl-2

# Registry now shows:
# "nextId": { "opus": 3 }
# So next spawn would create opus-wsl-3
```

---

## Key Benefits

### 1. Deterministic Naming
Same agent model = same agent name, always.

```bash
# These always return the same agent
node conductor-spawn.js spawn opus
node conductor-spawn.js spawn opus
node conductor-spawn.js spawn opus
```

### 2. Persistence Across Restarts
Kill the agent, spawn it again, same ID:

```bash
$ node conductor-spawn.js spawn opus
# opus-wsl-1

$ node conductor-spawn.js kill opus

$ node conductor-spawn.js spawn opus
# opus-wsl-1 (SAME - registry ensures this)
```

### 3. Platform Separation
Different platform = different agent ID:

```bash
node conductor-spawn.js spawn opus       # opus-wsl-1
node conductor-spawn.js spawn opus --mac # opus-mac-1 (different!)
```

### 4. Full Audit Trail
See when each agent was created:

```bash
$ node agent-registry.js list
opus-wsl-1
  Created: 2026-02-15T14:45:00.000Z
```

---

## Registry Management

### View Current State

```bash
node agent-registry.js list
```

### Export for Backup

```bash
node agent-registry.js export > agent-backup.json
```

### Reset (Use Carefully!)

```bash
# This clears ALL agent registrations
# Next spawn will start fresh with -1 instance numbers
node agent-registry.js reset
```

---

## Integration with Bounty Board

When spawning, the registry ensures:
1. Agent gets consistent ID
2. Conductor registers with bounty board API
3. Future spawns re-use same ID

So when you do:
```bash
node bounty-cli.js leaderboard
```

You always see:
- `opus-wsl-1` (not sometimes `opus-wsl-1`, sometimes something else)
- Same name every time
- Consistent XP tracking

---

## Implementation Details

### Auto-Creation in conductor-spawn.js

```javascript
const { AgentRegistry } = require('./agent-registry');
const registry = new AgentRegistry();
const agentInfo = registry.getOrCreate(model, 'wsl');
// agentInfo.agentId  = "opus-wsl-1"
// agentInfo.agentName = "Opus-Conductor"
```

### Storage

Registry is stored in `.agent-registry.json` in the bounty-board directory:
```
F:/bounty-board/.agent-registry.json
```

This is a JSON file you can manually edit if needed.

---

## Troubleshooting

### Agent ID keeps changing

**Problem:** Spawn opus, get `opus-wsl-1`, restart, spawn again, get `opus-wsl-2`

**Solution:** Check `.agent-registry.json` exists and isn't being deleted. Registry must persist.

### Duplicate agents

**Problem:** Both `opus-wsl-1` and `opus-wsl-2` running

**Solution:** Check `max_instances` setting. By default it's 1, so you can only have one per platform.

### Want to reset

**Problem:** Need to clear all agent registrations

**Solution:**
```bash
node agent-registry.js reset
# Next spawn will start from instance 1 again
```

---

## Example: Monitoring Agent Consistency

```bash
#!/bin/bash
# Spawn agents
node conductor-spawn.js spawn opus
node conductor-spawn.js spawn codex
node conductor-spawn.js spawn sonnet

# Check registry
echo "=== Agent Registry ==="
node agent-registry.js list

# Get specific agent
echo ""
echo "=== Opus WSL Details ==="
node agent-registry.js get opus wsl

# Kill and respawn
echo ""
echo "=== Killing Opus ==="
node conductor-spawn.js kill opus

echo "=== Respawning Opus ==="
node conductor-spawn.js spawn opus

# Check if same ID
echo ""
echo "=== Verify Same ID ==="
node agent-registry.js get opus wsl
```

Output shows same `agentId` throughout.

---

## Summary

✅ Agent IDs are **persistent** (survive restarts)
✅ Agent names are **deterministic** (always the same)
✅ Registry is **tracked** (.agent-registry.json)
✅ Easy to **audit** (node agent-registry.js list)
✅ Easy to **manage** (registry CLI tool)

**Your agents now have consistent, trackable identities!**
