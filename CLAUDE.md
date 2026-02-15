# Wasteland Bounty Board - Project Handoff

## Quick Start

```bash
cd F:\bounty-board
node server.js
# Server runs on http://localhost:3777
```

**Pages:**
- Board (Kanban): http://localhost:3777/
- Agent Roster: http://localhost:3777/roster
- Leaderboard: http://localhost:3777/leaderboard

## What This Is

A **free, local, agent-driven task/bug tracking system** styled as a post-apocalyptic "Wasteland Bounty Board" (Borderlands/Fallout/Akira/Arc Raiders aesthetic). It serves as a **work queue** for AI agents:

- A **conductor** (orchestrator) adds tasks and bugs as "bounties"
- **Agents** claim bounties atomically, mark progress, complete, or fail them
- Two bounty types: **Bug Bounties** (red) and **Task Bounties** (cyan) on the same board
- Tiered XP reward system with bonus multipliers
- SQLite database with WAL mode for concurrent agent access

## Why This Exists — Replacing Jira

We evaluated multiple options for agent task tracking and bug tracking:

### What we rejected and why
- **Jira**: API rate limits are restrictive for agent-driven workflows where multiple agents are constantly polling, claiming, and updating tasks. Also costs money at scale.
- **Linear**: Good API, but not free. Costs money — that was the dealbreaker.
- **Any hosted SaaS**: Introduces external dependencies, API limits, auth complexity, network latency, and recurring costs. Overkill when all we need is a local work queue.

### What we actually need
The requirement is simple — **not a project management tool**, just a work queue:
1. A **conductor** (Opus-Leader, the orchestrator agent) adds tasks and bugs
2. **Agents** can claim tasks atomically (no two agents grab the same task)
3. Agents mark tasks as in-progress, report progress %, mark done, or report failure
4. Same system handles both bugs and tasks on one board
5. Must be **free, local, zero-dependency** — no cloud services, no API keys, no rate limits

### Why SQLite
- **Zero cost** — no hosted DB, no subscriptions
- **Zero config** — single file (`bounty-board.db`), auto-created on first run
- **WAL mode** — enables concurrent reads from multiple agents without blocking
- **Atomic claiming** — `UPDATE bounties SET status='in_progress', claimed_by=? WHERE id=? AND status='pending'` — if two agents race to claim the same bounty, only one wins (changes=1), the other gets changes=0 and knows it lost. No distributed locks needed.
- **No network** — agents hit localhost, so zero latency, no auth tokens, no rate limits
- **Portable** — the entire database is one file you can copy, back up, or reset by deleting

### How agents interact with it
The pattern is simple REST calls that any agent can make:
```
Conductor creates bounty  →  POST /api/bounties {title, type, tier}
Agent claims it            →  POST /api/bounties/:id/claim {agent_id}
Agent reports progress     →  POST /api/bounties/:id/progress {progress: 50}
Agent completes it         →  POST /api/bounties/:id/complete
Agent fails it             →  POST /api/bounties/:id/fail {error_log}
Conductor retries failed   →  POST /api/bounties/:id/retry
```

The atomic claim is the key design — when an agent POSTs to `/claim`, the SQL uses `WHERE status='pending'` so if the bounty was already claimed by another agent between the time the first agent saw it and tried to claim it, the UPDATE affects 0 rows and returns a 409 Conflict. No race conditions, no distributed locking, just SQLite doing what it does best.

### The bounty board metaphor
Instead of dry "tickets" and "sprints", the system uses a post-apocalyptic bounty board metaphor:
- Tasks = **Contracts** (cyan/blue)
- Bugs = **Bug Bounties** (red)
- Kanban columns = **WANTED** → **HUNTING** → **FRAGGED** → **BOTCHED**
- XP rewards with tiers (S/A/B/C) incentivize agents to take on harder work
- Streak bonuses reward consistency, botch penalties discourage sloppy work
- The leaderboard creates healthy competition between agents

### Design Decision: One Board, Two Types
We discussed whether bugs and tasks should live on separate boards. The decision was to keep them on **one unified board** with visual differentiation:
- Bugs get a dedicated **BUG TRACKER** column (red, dashed border) for pending bugs
- Tasks get the **WANTED** column (cyan) for pending tasks
- Once claimed, both flow through the same **HUNTING** → **FRAGGED** / **BOTCHED** pipeline
- Filter bar lets you toggle between ALL BOUNTIES / BUG HUNTS / CONTRACTS
- This mirrors how agents actually work — they don't care if they're fixing a bug or building a feature, they just pick up the next bounty. The unified view gives the conductor full visibility.

## Architecture

```
F:\bounty-board\
  db.js              # SQLite schema, seed data, tier constants
  server.js          # Express REST API (port 3777)
  bounty-board.db    # SQLite database (auto-created)
  update-agents.js   # One-off script that loaded real agent names
  public/
    index.html       # Kanban board (WANTED / BUG TRACKER / HUNTING / FRAGGED / BOTCHED)
    roster.html      # Active Agent Roster (card grid with status)
    leaderboard.html # Scavenger Leaderboard (ranked by XP)
    avatars.js       # Avatar system: GIF-first with SVG fallback
    avatars/         # Grok-generated animated GIF avatars per agent
  avatars/           # Source MP4s from Grok + converted GIFs (not served)
  *.html (root)      # Original Stitch MCP reference designs (not served)
```

**Stack:** Express.js, better-sqlite3, Tailwind CSS (CDN), vanilla JS. No build step.

## Tech: Database Schema

### agents table
| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PK | e.g. `opus-leader` |
| name | TEXT | Display name e.g. `Opus-Leader` |
| class | TEXT | Role description e.g. `Leader / Orchestrator` |
| level | INTEGER | Agent level (Opus agents are 9001) |
| avatar_url | TEXT | Currently unused (GIFs served via filesystem convention) |
| status | TEXT | `active` / `idle` / `repairing` / `offline` |
| total_loot | INTEGER | Cumulative XP earned |
| missions_completed | INTEGER | |
| missions_failed | INTEGER | |
| current_directive | TEXT | What they're working on (null if idle) |
| streak | INTEGER | Consecutive successes (resets on fail) |

### bounties table
| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | Auto-increment |
| ticket_id | TEXT UNIQUE | `ERR_XXXX` (bugs) or `TSK_XXXX` (tasks) |
| title | TEXT | |
| description | TEXT | |
| type | TEXT | `task` or `bug` |
| tier | TEXT | `S` / `A` / `B` / `C` |
| status | TEXT | `pending` / `in_progress` / `done` / `failed` |
| priority | TEXT | `critical` / `high` / `normal` / `low` |
| reward | INTEGER | XP value (auto-calculated from tier) |
| tags | TEXT | JSON array of strings |
| claimed_by | TEXT FK | References agents.id |
| progress | INTEGER | 0-100 |
| error_log | TEXT | Failure details |
| claimed_at | DATETIME | |
| completed_at | DATETIME | |

## Tech: REST API

All endpoints at `http://localhost:3777/api/`:

### Bounties
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/bounties?status=&type=&tier=` | List bounties (filterable) |
| GET | `/api/bounties/stats` | Board statistics |
| POST | `/api/bounties` | Create bounty `{title, type, tier?, priority?, description?, tags?}` |
| POST | `/api/bounties/:id/claim` | Claim bounty `{agent_id}` (atomic - WHERE status='pending') |
| POST | `/api/bounties/:id/progress` | Update progress `{progress: 0-100}` |
| POST | `/api/bounties/:id/complete` | Mark done (auto-calculates XP bonuses) |
| POST | `/api/bounties/:id/fail` | Mark failed `{error_log?}` (applies botch penalty) |
| POST | `/api/bounties/:id/retry` | Reset failed bounty to pending |

### Agents
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/agents?status=` | List agents |
| GET | `/api/agents/leaderboard` | Ranked by XP with success_rate |
| GET | `/api/agents/:id` | Agent details + their bounties |
| POST | `/api/agents` | Register agent `{id, name, class?}` |

### Meta
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/tiers` | Tier rewards, names, and bonus config |

## Tech: Tier & Reward System

### Tier Rewards (XP)
| Tier | Bug Name | Bug XP | Task Name | Task XP |
|------|----------|--------|-----------|---------|
| S | KILL ORDER | $5,000 | BLACK OPS | $5,000 |
| A | WANTED: DEAD | $2,500 | MERC CONTRACT | $2,000 |
| B | BOUNTY POSTED | $1,000 | SALVAGE RUN | $750 |
| C | PEST CONTROL | $250 | SCRAP WORK | $150 |

### Tier Design Rationale
The tiers were designed around coding best practices and real-world bug/task severity:

**Bug tiers** (based on bug assignment best practices):
- **S - KILL ORDER ($5,000)**: Production-down, security vulnerability, data loss. Must be fixed immediately. Maps to P0/Sev1 in traditional systems.
- **A - WANTED: DEAD ($2,500)**: Major functionality broken, significant user impact, no workaround. Maps to P1/Sev2.
- **B - BOUNTY POSTED ($1,000)**: Feature partially broken, workaround exists, moderate user impact. Maps to P2/Sev3.
- **C - PEST CONTROL ($250)**: Minor issue, cosmetic, edge case. Low impact. Maps to P3/Sev4.

**Task tiers** (based on engineering complexity/impact):
- **S - BLACK OPS ($5,000)**: Architecture-level changes, critical deployments, security overhauls. Requires senior/lead-level capability.
- **A - MERC CONTRACT ($2,000)**: Significant feature work, complex refactors, cross-system changes. Requires strong coding ability.
- **B - SALVAGE RUN ($750)**: Standard feature work, moderate refactors, API integrations. Bread-and-butter dev work.
- **C - SCRAP WORK ($150)**: Simple tasks, boilerplate, documentation, config changes, minor UI tweaks.

Bugs are intentionally priced higher than equivalent-tier tasks because bug fixes are reactive (firefighting) while tasks are proactive (building). The XP differential incentivizes agents to prioritize bugs.

### Bonus Multipliers
- **First Blood**: +20% if completed within 10 minutes of claiming. Rewards fast turnaround on quick fixes.
- **Streak Bonus**: +10% per consecutive success (capped at 2x). Rewards reliability and consistency.
- **Botch Penalty**: -50% of bounty reward deducted from agent's total loot on failure. Discourages agents from claiming work they can't handle — better to leave it for a more capable agent than to botch it and lose XP.

## Tech: Avatar System

`public/avatars.js` provides a dual-layer avatar system:

1. **Primary: Animated GIFs** - Grok-generated video avatars converted to GIF, stored at `public/avatars/{agent-id}.gif`. Served statically by Express.
2. **Fallback: Procedural SVGs** - Generated client-side with unique visual identity per agent (colors, symbols, animations). Used if no GIF exists.

**API:**
```javascript
AgentAvatars.getUrl(agentId, size)     // GIF URL if available, else SVG data URL
AgentAvatars.getGifUrl(agentId)        // GIF URL or null
AgentAvatars.getDataUrl(agentId, size) // SVG data URL (always works)
AgentAvatars.hasGif(agentId)           // boolean
```

### Current Agent-to-GIF Mapping
| Agent ID | GIF Source | Visual |
|----------|-----------|--------|
| opus-leader | a4e15b6f | Cracked fire skull, burning commander |
| opus-coder | 7b368cd6 | Glowing-eyed rage face, power level >9001 |
| codex-wsl | 8aba5fa8 | Terminal portrait with `codex>` prompt |
| sonnet-coder | b5cc11b9 | Teal pixel boy with electric hair |
| mac-research | 39a6d700 | Blue pixel face, clean minimal |
| gemini-wsl | ae585a67 | Pink/yellow dual pixel character |
| sonnet-research | 07119f2a | Purple orb (Gemini CLI style) |
| haiku-research | 66f44da2 | Dark-haired pixel kid |

### Spare GIFs (unmapped, in avatars/gifs/)
10 additional Grok-generated GIFs available for future agents. See `avatars/thumbs/` for PNG previews of each.

## Current Agents

| ID | Name | Class | Level | Status |
|----|------|-------|-------|--------|
| opus-leader | Opus-Leader | Leader / Orchestrator | 9001 | active |
| opus-coder | Opus-Coder | Heavy Coding / Debugging | 9001 | active |
| codex-wsl | Codex-WSL | Research / Search / Coding | 50 | active |
| sonnet-coder | Sonnet-Coder | Low-Level Coding / Testing | 42 | active |
| mac-research | Mac-Research | Research / Search / Coding | 40 | idle |
| sonnet-research | Sonnet-Research | Research / Analysis | 35 | idle |
| gemini-wsl | Gemini-WSL | Research | 38 | active |
| haiku-research | Haiku-Research | Research / Web Search | 25 | active |

## Frontend Details

All pages use Tailwind CSS via CDN, Space Grotesk + Permanent Marker fonts, Material Icons. No build step required.

- **index.html (Board)**: 5-column kanban. Filter bar (ALL/BUG HUNTS/CONTRACTS). New Bounty modal with type/tier/priority. Stats header. Auto-refreshes every 5 seconds.
- **roster.html**: Card grid with animated GIF portraits. Filter by status (ALL/ACTIVE/IDLE/REPAIRING). Shows directives, stats, action buttons (PING UNIT / MAINTENANCE / ASSIGN TASK).
- **leaderboard.html**: #1 gets LEGENDARY card with glowing border. #2-3 get larger cards. #4+ compact rows. Shows loot, success rate, streak.
- All pages share a bottom nav bar linking to each other.

## Stitch MCP Project

Design reference project ID: `6696700284273867681` (title: "Agent Task Queue - Kanban Board"). Contains 3 generated screens used as visual reference. The Stitch-generated HTML files in the project root are reference designs only (not served).

## Example: Agent Workflow via API

```bash
# Conductor creates a bounty
curl -X POST http://localhost:3777/api/bounties \
  -H "Content-Type: application/json" \
  -d '{"title":"Fix auth token refresh","type":"bug","tier":"A","priority":"high"}'

# Agent claims it
curl -X POST http://localhost:3777/api/bounties/13/claim \
  -H "Content-Type: application/json" \
  -d '{"agent_id":"codex-wsl"}'

# Agent updates progress
curl -X POST http://localhost:3777/api/bounties/13/progress \
  -H "Content-Type: application/json" \
  -d '{"progress":75}'

# Agent completes it (XP auto-calculated with bonuses)
curl -X POST http://localhost:3777/api/bounties/13/complete

# Or if it fails...
curl -X POST http://localhost:3777/api/bounties/13/fail \
  -H "Content-Type: application/json" \
  -d '{"error_log":"Stack overflow in recursive auth check"}'
```

## Known Quirks / Gotchas

1. **SQLite string literals**: Use single quotes in SQL CASE statements, not double quotes. Double quotes are for identifiers in SQLite.
2. **FOREIGN KEY on agent delete**: Must `UPDATE bounties SET claimed_by = NULL` before deleting agents, or FK constraint fails.
3. **PowerShell heredocs**: Complex multi-line node scripts fail via PowerShell. Write to `.js` files and run with `node` instead.
4. **Seed data**: Only runs if agents table is empty. To reset, delete `bounty-board.db` and restart.
5. **Avatar GIFs**: Converted from MP4 at 15fps, 280px wide, palette-optimized. The `avatars/` folder at project root has source MP4s and all converted GIFs. `public/avatars/` has only the 8 mapped agent GIFs.

## New in Phase 3 - Agent Orchestration (Feb 15, 2026)

### ✅ Conductor Agent Spawner (conductor-spawn.js)
- Spawn isolated tmux sessions for each agent model
- Models: Opus, Codex, Sonnet, Haiku, Gemini
- Only 1 active per model
- Commands: `spawn`, `list`, `attach`, `kill`
- Automatic agent registration with bounty board
- Session titles show connection commands
- Support for WSL and Mac (SSH) agents

### ✅ Agent Worker Process (agent-worker.js)
- Runs inside each tmux session
- Auto-claims available bounties
- Tier-aware (agents pick work matching their capability)
- Progress reporting (25%, 50%, 75%, 100%)
- XP reward collection with bonuses
- Graceful shutdown handling

### ✅ Conductor Guides
- `CONDUCTOR-GUIDE.md` - Complete user guide for spawning and managing agents
- `AGENT-ORCHESTRATION-PHASE.md` - Architecture and decision summary
- Full workflow examples
- Troubleshooting guide

## New in Phase 2 (Feb 15, 2026)

### ✅ Agent SDK (agent-sdk.js)
- **BountyBoardClient** class for agents to use in their code
- Methods: `claimAvailableBounty()`, `claimBounty()`, `reportProgress()`, `completeBounty()`, `failBounty()`, `retryBounty()`
- **Atomic claiming with retry logic** — on 409 conflict, auto-retries with exponential backoff
- Full JSDoc documentation
- Production-ready error handling

### ✅ CLI Tool (bounty-cli.js)
- Commands: `list`, `create`, `view`, `complete`, `fail`, `stats`, `leaderboard`
- Conductor can manage bounties from terminal without UI
- Examples:
  ```bash
  node bounty-cli.js create "Fix crash" --type bug --tier A --priority critical
  node bounty-cli.js list --status pending
  node bounty-cli.js stats
  node bounty-cli.js leaderboard
  ```

### ✅ WebSocket Real-Time Updates (server.js)
- Replaces polling — clients connect via `ws://localhost:3777`
- Broadcast events: `bounty_claimed`, `bounty_completed`, `bounty_failed`, `init`
- Clients receive instant updates on board state changes
- Front-end can remove 5-second polling loop

### ✅ Agent Example (examples/agent-example.js)
- Shows how agents use the SDK
- Includes worker loop, conductor mode, monitor mode
- Ready to run: `AGENT_ID=codex-wsl node examples/agent-example.js worker`

## What's Next / Ideas

- [ ] Update frontend (index.html, roster.html) to use WebSocket instead of polling
- [ ] Wire up actual agent integration (agents POST to the API during task execution)
- [ ] Sound effects / notification system for new bounties and completions
- [ ] Dark/light theme toggle (currently dark only)
- [ ] Bounty detail/history modal on click
- [ ] Agent profile page linked from avatar clicks
- [ ] Deploy the remaining 10 spare GIF avatars when new agents are added
- [ ] Agent introspection — agents can query their own capabilities and automatically pick suitable bounties
- [ ] Difficulty estimation — auto-estimate bounty difficulty and suggest tier to conductor
- [ ] Bounty dependencies — some bounties can depend on others (e.g., "Fix authentication" before "Add 2FA")
