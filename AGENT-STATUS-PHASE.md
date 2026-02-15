# Phase 5: Real-Time Agent Status Tracking

**Requested**: Real-time active/idle/offline status + manual agent management
**Date Started**: February 15, 2026
**Target**: Complete status tracking with Conductor control

---

## Requirements Analysis

### Current Problem
- No real-time visibility into agent state
- Constant polling wastes resources
- No way to manually add/remove agents
- Offline detection relies on timeout

### User Request
1. **Live Status Updates**: Push-based instead of pull
2. **Four Status States**: online, active, idle, offline
3. **Active Agents Screen**: Visual management + manual control
4. **Conductor Control**: Same privileges as user
5. **Graceful Offline**: Handle PowerShell close properly

---

## Architecture

### Agent Lifecycle

```
┌─────────────────────────────────────────────────────────┐
│              AGENT LIFECYCLE STATES                      │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  STARTUP                                                 │
│    ↓                                                      │
│  [ONLINE] → Agent connects, registers status            │
│    ↓                                                      │
│  [IDLE] → Waiting for bounty                            │
│    ↓                                                      │
│  [ACTIVE] → Claimed bounty, working                     │
│    ↓                                                      │
│  [IDLE] → Completed bounty                              │
│    ↓ (repeat)                                            │
│                                                          │
│  SHUTDOWN                                                │
│    ← [OFFLINE] From any state (timeout or explicit)    │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

### Status Push Events

**From Agent to Server** (WebSocket):
```javascript
// Agent comes online
{
  type: 'agent:status:update',
  agentId: 'opus-wsl-1',
  status: 'online',
  timestamp: Date.now()
}

// Agent starts working
{
  type: 'agent:status:update',
  agentId: 'opus-wsl-1',
  status: 'active',
  bountyId: 14,
  timestamp: Date.now()
}

// Agent finishes work
{
  type: 'agent:status:update',
  agentId: 'opus-wsl-1',
  status: 'idle',
  timestamp: Date.now()
}

// Agent heartbeat (every 5s to detect crash)
{
  type: 'agent:heartbeat',
  agentId: 'opus-wsl-1',
  timestamp: Date.now()
}
```

**From Server to Clients** (WebSocket):
```javascript
// Broadcast status change
{
  type: 'agent_status_changed',
  agentId: 'opus-wsl-1',
  oldStatus: 'idle',
  newStatus: 'active',
  timestamp: Date.now()
}

// Agent went offline
{
  type: 'agent_offline',
  agentId: 'opus-wsl-1',
  reason: 'heartbeat_timeout|manual|crash',
  timestamp: Date.now()
}
```

---

## Implementation Plan

### Phase 5a: Database Schema Updates
**File**: `db.js`

Add agent status tracking:
```sql
CREATE TABLE agent_status (
  agentId TEXT PRIMARY KEY,
  status TEXT DEFAULT 'offline',  -- online, active, idle, offline
  lastSeen INTEGER,
  currentBountyId INTEGER,
  isActive BOOLEAN DEFAULT 0,     -- manually active/inactive
  createdAt INTEGER,
  updatedAt INTEGER
);

CREATE TABLE agent_events (
  id INTEGER PRIMARY KEY,
  agentId TEXT,
  status TEXT,
  bountyId INTEGER,
  reason TEXT,
  timestamp INTEGER
);
```

### Phase 5b: Server Status Tracking
**File**: `server.js` (new endpoints + WebSocket handlers)

```javascript
// Track agent heartbeats
const agentHeartbeats = new Map(); // agentId → lastSeen timestamp

// New endpoints
app.post('/api/agents/:id/status', (req, res) => {
  // Agent updates status
  const { status, bountyId, isActive } = req.body;
  updateAgentStatus(req.params.id, status, bountyId);
  broadcastAgentStatus(req.params.id, status);
  res.json({ ok: true });
});

app.get('/api/agents/active', (req, res) => {
  // Get only active agents
  res.json(getActiveAgents());
});

app.post('/api/agents/:id/deactivate', (req, res) => {
  // Conductor deactivates agent
  deactivateAgent(req.params.id);
  broadcastAgentStatus(req.params.id, 'offline');
  res.json({ ok: true });
});

// WebSocket handlers
ws.on('message', (data) => {
  const msg = JSON.parse(data);

  if (msg.type === 'agent:status:update') {
    agentHeartbeats.set(msg.agentId, Date.now());
    updateAgentStatus(msg.agentId, msg.status, msg.bountyId);
    broadcastToClients({
      type: 'agent_status_changed',
      agentId: msg.agentId,
      status: msg.status,
      timestamp: msg.timestamp
    });
  }

  if (msg.type === 'agent:heartbeat') {
    agentHeartbeats.set(msg.agentId, Date.now());
  }
});

// Offline detection: check heartbeats every 10s
setInterval(() => {
  const now = Date.now();
  const HEARTBEAT_TIMEOUT = 15000; // 15 seconds

  for (const [agentId, lastSeen] of agentHeartbeats.entries()) {
    if (now - lastSeen > HEARTBEAT_TIMEOUT) {
      updateAgentStatus(agentId, 'offline');
      agentHeartbeats.delete(agentId);
      broadcastToClients({
        type: 'agent_offline',
        agentId: agentId,
        reason: 'heartbeat_timeout',
        timestamp: now
      });
    }
  }
}, 10000);
```

### Phase 5c: Agent Status Reporting
**File**: `agent-worker.js` (new status push methods)

```javascript
class AgentWorker {
  constructor(agentId, serverUrl) {
    this.agentId = agentId;
    this.serverUrl = serverUrl;
    this.ws = new WebSocket(`ws://localhost:3777`);
  }

  async start() {
    // Connect and go online
    await this.pushStatus('online');
    await this.startHeartbeat();

    while (true) {
      // Try to claim a bounty
      const bounty = await this.claimBounty();
      if (bounty) {
        await this.pushStatus('active', bounty.id);
        await this.workOnBounty(bounty);
        await this.pushStatus('idle');
      } else {
        await this.sleep(2000);
      }
    }
  }

  async pushStatus(status, bountyId = null) {
    this.ws.send(JSON.stringify({
      type: 'agent:status:update',
      agentId: this.agentId,
      status: status,
      bountyId: bountyId,
      timestamp: Date.now()
    }));
  }

  async startHeartbeat() {
    setInterval(() => {
      this.ws.send(JSON.stringify({
        type: 'agent:heartbeat',
        agentId: this.agentId,
        timestamp: Date.now()
      }));
    }, 5000); // Every 5 seconds
  }

  async workOnBounty(bounty) {
    try {
      await this.reportProgress(bounty.id, 25);
      await this.sleep(1000);

      await this.reportProgress(bounty.id, 50);
      await this.sleep(1000);

      await this.reportProgress(bounty.id, 75);
      await this.sleep(1000);

      await this.completeBounty(bounty.id);
      await this.reportProgress(bounty.id, 100);
    } catch (err) {
      await this.failBounty(bounty.id);
    }
  }
}
```

### Phase 5d: Active Agents Management Screen
**File**: `views/agents.html` (new page)

```html
<!DOCTYPE html>
<html>
<head>
  <title>Active Agents - Wasteland Bounty Board</title>
  <style>
    .agent-card {
      border: 2px solid #00ff00;
      padding: 10px;
      margin: 10px;
      display: inline-block;
    }
    .status-online { color: #00ff00; }
    .status-active { color: #ffff00; }
    .status-idle { color: #0080ff; }
    .status-offline { color: #ff0000; }
    button.deactivate { background: #ff0000; }
  </style>
</head>
<body>
  <h1>🤖 Active Agents</h1>

  <div id="agents-container"></div>

  <script>
    let ws = new WebSocket(`ws://localhost:3777`);

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);

      if (msg.type === 'agent_status_changed') {
        updateAgentCard(msg.agentId, msg.status);
      }

      if (msg.type === 'agent_offline') {
        markAgentOffline(msg.agentId, msg.reason);
      }
    };

    async function loadAgents() {
      const res = await fetch('/api/agents/active');
      const agents = await res.json();

      agents.forEach(agent => {
        createAgentCard(agent);
      });
    }

    function createAgentCard(agent) {
      const card = document.createElement('div');
      card.className = 'agent-card';
      card.id = `agent-${agent.agentId}`;

      card.innerHTML = `
        <h3>${agent.agentId}</h3>
        <p class="status-${agent.status}">
          Status: ${agent.status.toUpperCase()}
        </p>
        <p>Last Seen: ${new Date(agent.lastSeen).toLocaleTimeString()}</p>
        <button onclick="deactivateAgent('${agent.agentId}')" class="deactivate">
          Deactivate
        </button>
      `;

      document.getElementById('agents-container').appendChild(card);
    }

    function updateAgentCard(agentId, status) {
      const card = document.getElementById(`agent-${agentId}`);
      if (card) {
        card.querySelector('p').className = `status-${status}`;
        card.querySelector('p').textContent = `Status: ${status.toUpperCase()}`;
      }
    }

    async function deactivateAgent(agentId) {
      await fetch(`/api/agents/${agentId}/deactivate`, { method: 'POST' });
    }

    async function markAgentOffline(agentId, reason) {
      updateAgentCard(agentId, 'offline');
    }

    loadAgents();
  </script>
</body>
</html>
```

### Phase 5e: Conductor Control System
**File**: `conductor.js` (new CLI for agent management)

```javascript
#!/usr/bin/env node

const fetch = require('node-fetch');

const AGENT_API = 'http://localhost:3777/api/agents';

async function listAgents() {
  const res = await fetch(`${AGENT_API}/active`);
  const agents = await res.json();

  console.log('📡 ACTIVE AGENTS\n');
  agents.forEach(agent => {
    console.log(`${agent.agentId.padEnd(20)} [${agent.status.toUpperCase()}]`);
  });
}

async function deactivateAgent(agentId) {
  const res = await fetch(`${AGENT_API}/${agentId}/deactivate`, {
    method: 'POST'
  });

  if (res.ok) {
    console.log(`✅ Deactivated: ${agentId}`);
  } else {
    console.error(`❌ Failed to deactivate: ${agentId}`);
  }
}

const command = process.argv[2];
const arg = process.argv[3];

if (command === 'list') {
  listAgents();
} else if (command === 'deactivate') {
  deactivateAgent(arg);
} else {
  console.log('Usage: conductor <list|deactivate> [agentId]');
}
```

### Phase 5f: Bounty Assignment Updates
**File**: `bounty-cli.js` (only assign to active agents)

```javascript
async function assignBountyToActiveAgent(bounty) {
  const res = await fetch('http://localhost:3777/api/agents/active');
  const activeAgents = await res.json();

  if (activeAgents.length === 0) {
    console.log('⚠️  No active agents available');
    return;
  }

  // Broadcast to all active agents
  activeAgents.forEach(agent => {
    console.log(`📢 Bounty ${bounty.id} available for ${agent.agentId}`);
  });
}
```

---

## Implementation Steps

### Step 1: Update Database Schema
- [ ] Add `agent_status` table
- [ ] Add `agent_events` table
- [ ] Migration script

### Step 2: Server Status Tracking
- [ ] Add status endpoints (`/api/agents/:id/status`, `/api/agents/active`)
- [ ] Add WebSocket handlers for status updates
- [ ] Add heartbeat timeout detection (10s check, 15s timeout)
- [ ] Add broadcast on status change

### Step 3: Agent Status Reporting
- [ ] Add `pushStatus()` to agent-worker.js
- [ ] Add heartbeat emission (every 5s)
- [ ] Update work lifecycle to push status changes
- [ ] Handle disconnection gracefully

### Step 4: Active Agents Screen
- [ ] Create `/views/agents.html`
- [ ] Real-time agent card updates via WebSocket
- [ ] Status color coding (green=online, yellow=active, blue=idle, red=offline)
- [ ] Deactivate button for manual control

### Step 5: Conductor Control
- [ ] Create `conductor.js` CLI tool
- [ ] `conductor list` - Show all active agents
- [ ] `conductor deactivate <agentId>` - Remove from active pool
- [ ] Offline detection integration

### Step 6: Bounty Assignment Updates
- [ ] Update bounty creation to only show available agents
- [ ] Update CLI to show "No active agents" message
- [ ] Limit assignments to active agents only

---

## Testing Plan

### Test 1: Agent Online Detection
```bash
1. Start server
2. Spawn agent
3. Observe: agent appears as 'online' in dashboard
4. Check: agent status in database shows 'online'
```

### Test 2: Active/Idle Transitions
```bash
1. Create bounty
2. Agent claims bounty
3. Observe: agent status changes to 'active'
4. Agent completes bounty
5. Observe: agent status changes to 'idle'
```

### Test 3: Offline Detection
```bash
1. Agent running
2. Kill agent process
3. Wait 15 seconds
4. Observe: agent marked 'offline'
5. Check: offline event in database
```

### Test 4: Manual Deactivation
```bash
1. Agent running (status: idle)
2. conductor deactivate opus-wsl-1
3. Observe: agent removed from active pool
4. Create new bounty
5. Verify: bounty NOT assigned to deactivated agent
```

### Test 5: Conductor Control
```bash
1. conductor list
2. Observe: shows only active agents with status
3. Deactivate agent
4. conductor list
5. Verify: agent no longer in list
```

---

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `db.js` | Modify | Add agent_status & agent_events tables |
| `server.js` | Modify | Add status endpoints + WebSocket handlers |
| `agent-worker.js` | Modify | Add status push methods |
| `views/agents.html` | Create | Agent management dashboard |
| `conductor.js` | Create | CLI for agent control |
| `bounty-cli.js` | Modify | Only assign to active agents |

---

## Success Criteria

- ✅ Agents push status on startup (online)
- ✅ Agents push status on claim (active)
- ✅ Agents push status on complete (idle)
- ✅ Server detects offline via heartbeat timeout
- ✅ Real-time dashboard shows agent status
- ✅ Conductor can deactivate agents
- ✅ Only active agents receive bounties
- ✅ Manual offline handling works
- ✅ All tests pass

---

## Estimated Timeline

- **Database Updates**: 30 min
- **Server Modifications**: 45 min
- **Agent Status Reporting**: 30 min
- **Dashboard UI**: 45 min
- **Conductor CLI**: 20 min
- **Testing**: 45 min

**Total**: ~3-4 hours

---

## Next: Start Phase 5a (Database Schema)

Ready to implement. Shall I proceed with:
1. Database schema updates?
2. Server endpoint implementation?
3. Full agent status system?

Just confirm and I'll build it out! 🚀
