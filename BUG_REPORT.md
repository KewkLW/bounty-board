# Wasteland Bounty Board - Bug Report & Fixes

**Date**: February 16, 2026
**Status**: CRITICAL ISSUES FOUND - System partially broken

---

## Issues Identified

### 🔴 CRITICAL: Agent Registration Mismatch

**Problem**: Agents cannot claim bounties because their IDs don't match between registry and database.

**Root Cause**:
- `AgentRegistry` creates agent IDs in format: `{model}-{platform}-{instanceNum}` (e.g., `opus-wsl-1`)
- Database `agents` table has seed agents with different ID format: `agent-{name}-{number}` (e.g., `agent-codex-1`)
- When `agent-worker.js` tries to claim a bounty, it uses the registry ID, but the database doesn't have that agent registered
- The `/api/bounties/:id/claim` endpoint checks: `SELECT * FROM agents WHERE id = ?` and returns 404 if not found

**Current State**:
```
AgentRegistry:      opus-wsl-1, codex-wsl-1, sonnet-wsl-1, haiku-wsl-1, gemini-wsl-1
Database Agents:    agent-codex-1, agent-sonnet-2, agent-claude-o, agent-gpt-4, agent-llama-3, agent-haiku-1
Result:             NO MATCH → Agent claims fail with 404 "Agent not found"
```

**Evidence**:
```
Test 2: Claim bounty ERR_0099
  Status: 404
  Error: Agent not found
```

**Impact**:
- ❌ Agents cannot claim bounties
- ❌ Work queue remains stuck (bounties stay in "pending")
- ❌ System is non-functional for agent-driven workflows

**Fix Options**:

**Option A** (Recommended): Add agent self-registration to `agent-worker.js`
- When an agent starts, it registers itself in the database with its registry ID
- Handles agent creation/update atomically
- Agents are ephemeral anyway (created/destroyed per session)

**Option B**: Sync database agents to match registry format
- Delete old seed agents
- Regenerate with registry IDs
- Requires data migration

**Option C**: Create /api/agent/register endpoint
- Agents POST to register on startup
- Server handles creation/update of agent record
- More RESTful approach

**RECOMMENDED FIX**: Option A - Agent self-registration
- Simplest change
- Least disruptive
- Aligns with agent-worker.js being a standalone worker

---

### 🟡 SECONDARY: Server Listens on 0.0.0.0 vs localhost

**Problem**: Server is configured to listen on `0.0.0.0:3777`, but environment variable or WSL tests may expect `localhost:3777`

**Status**: NOT A BLOCKER
- Server does listen on correct addresses
- Both `0.0.0.0` and `localhost` work
- Minor logging/consistency issue only

---

## Summary of Fixes Needed

| Issue | Severity | Type | Fix |
|-------|----------|------|-----|
| Agent registration mismatch | CRITICAL | Bug | Add self-registration to agent-worker.js |
| Database/registry sync | CRITICAL | Architecture | Ensure agent exists in DB before claim |
| Error messaging | Medium | UX | Better error messages for missing agents |

---

## Testing Performed

✅ **Server Startup**: Works after database reset
✅ **API Endpoints**: Responding correctly
✅ **Database Schema**: Correct
✅ **HTML Pages**: Serving properly
✅ **Agent Worker Loop**: Running and attempting claims
❌ **Agent Claims**: FAILING - Agent not found in database
❌ **Bounty Completion**: Cannot complete if not claimed

---

## Next Steps

1. Implement agent self-registration in agent-worker.js
2. Test full claim → progress → complete workflow
3. Verify conductor can spawn multiple agents and work in parallel
4. Test leaderboard updates with agent XP
5. Verify WebSocket real-time updates

---
