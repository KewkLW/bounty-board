const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'bounty-board.db'));

// Enable WAL mode for better concurrent access
db.pragma('journal_mode = WAL');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    class TEXT DEFAULT 'Scavenger',
    level INTEGER DEFAULT 1,
    avatar_url TEXT,
    status TEXT DEFAULT 'idle' CHECK(status IN ('active', 'idle', 'repairing', 'offline')),
    total_loot INTEGER DEFAULT 0,
    missions_completed INTEGER DEFAULT 0,
    missions_failed INTEGER DEFAULT 0,
    current_directive TEXT,
    streak INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS bounties (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id TEXT UNIQUE,
    title TEXT NOT NULL,
    description TEXT,
    type TEXT NOT NULL CHECK(type IN ('task', 'bug')),
    tier TEXT NOT NULL DEFAULT 'C' CHECK(tier IN ('S', 'A', 'B', 'C')),
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'in_progress', 'done', 'failed')),
    priority TEXT DEFAULT 'normal' CHECK(priority IN ('critical', 'high', 'normal', 'low')),
    reward INTEGER NOT NULL DEFAULT 150,
    tags TEXT, -- JSON array of tags
    claimed_by TEXT,
    progress INTEGER DEFAULT 0, -- 0-100
    error_log TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    claimed_at DATETIME,
    completed_at DATETIME,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (claimed_by) REFERENCES agents(id)
  );

  CREATE INDEX IF NOT EXISTS idx_bounties_status ON bounties(status);
  CREATE INDEX IF NOT EXISTS idx_bounties_type ON bounties(type);
  CREATE INDEX IF NOT EXISTS idx_bounties_claimed_by ON bounties(claimed_by);
  CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);

  CREATE TABLE IF NOT EXISTS agent_status (
    agentId TEXT PRIMARY KEY,
    status TEXT DEFAULT 'offline' CHECK(status IN ('online', 'active', 'idle', 'offline')),
    lastSeen INTEGER,
    currentBountyId INTEGER,
    isActive BOOLEAN DEFAULT 1,
    createdAt INTEGER,
    updatedAt INTEGER,
    FOREIGN KEY (currentBountyId) REFERENCES bounties(id)
  );

  CREATE TABLE IF NOT EXISTS agent_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agentId TEXT NOT NULL,
    status TEXT NOT NULL,
    bountyId INTEGER,
    reason TEXT,
    timestamp INTEGER,
    FOREIGN KEY (agentId) REFERENCES agents(id),
    FOREIGN KEY (bountyId) REFERENCES bounties(id)
  );

  CREATE INDEX IF NOT EXISTS idx_agent_status_agentId ON agent_status(agentId);
  CREATE INDEX IF NOT EXISTS idx_agent_events_agentId ON agent_events(agentId);
  CREATE INDEX IF NOT EXISTS idx_agent_events_timestamp ON agent_events(timestamp);
`);

// Tier reward mapping
const TIER_REWARDS = {
  bug: { S: 5000, A: 2500, B: 1000, C: 250 },
  task: { S: 5000, A: 2000, B: 750, C: 150 }
};

const TIER_NAMES = {
  bug: { S: 'KILL ORDER', A: 'WANTED: DEAD', B: 'BOUNTY POSTED', C: 'PEST CONTROL' },
  task: { S: 'BLACK OPS', A: 'MERC CONTRACT', B: 'SALVAGE RUN', C: 'SCRAP WORK' }
};

// Bonus multipliers
const BONUSES = {
  FIRST_BLOOD_MINUTES: 10,
  FIRST_BLOOD_MULT: 1.2,
  FLAWLESS_MULT: 1.25,
  STREAK_MULT: 0.1, // per consecutive success
  BOTCH_PENALTY: 0.5
};

// Generate ticket ID
function generateTicketId(type) {
  const prefix = type === 'bug' ? 'ERR' : 'TSK';
  const num = Math.floor(Math.random() * 9000) + 1000;
  return `${prefix}_${num}`;
}

// Seed sample data if empty
function seedData() {
  const agentCount = db.prepare('SELECT COUNT(*) as count FROM agents').get().count;
  if (agentCount > 0) return;

  const insertAgent = db.prepare(`
    INSERT INTO agents (id, name, class, level, avatar_url, status, total_loot, missions_completed, missions_failed, current_directive, streak)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const agents = [
    ['agent-codex-1', 'Agent-Codex-1', 'Hunter', 50, null, 'active', 54000, 142, 3, 'Refactoring combat loop systems', 12],
    ['agent-sonnet-2', 'Agent-Sonnet-2', 'Siren', 42, null, 'active', 42300, 118, 8, 'Deploying Neural Net v2.1', 5],
    ['agent-llama-3', 'Agent-Llama-3', 'Commando', 38, null, 'active', 38100, 95, 12, 'Scraping Sector 7 Data Nodes', 3],
    ['agent-gpt-4', 'Agent-GPT-4', 'Engineer', 30, null, 'idle', 22450, 64, 18, null, 0],
    ['agent-claude-o', 'Agent-Claude-O', 'Recon', 25, null, 'idle', 18900, 48, 15, null, 0],
    ['agent-haiku-1', 'Agent-Haiku-1', 'Scout', 15, null, 'repairing', 8200, 22, 8, 'Diagnostic: Logic loop failure', 0],
  ];

  const insertMany = db.transaction(() => {
    for (const a of agents) insertAgent.run(...a);
  });
  insertMany();

  const insertBounty = db.prepare(`
    INSERT INTO bounties (ticket_id, title, description, type, tier, status, priority, reward, tags, claimed_by, progress, error_log)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const bounties = [
    // PENDING - Bug Bounties
    ['ERR_0099', 'Fix Memory Leak in Render Loop', 'Memory consumption grows unbounded after 2h runtime. Agent keeps walking into lava at sector 7.', 'bug', 'S', 'pending', 'critical', 5000, '["memory","critical","rendering"]', null, 0, null],
    ['ERR_0134', 'Texture Clipping on Character Models', 'Visual artifacts on character models during combat animations.', 'bug', 'B', 'pending', 'normal', 1000, '["visual","collision"]', null, 0, null],
    // PENDING - Task Bounties
    ['TSK_2001', 'Refactor Agent Pathfinding', 'Current pathfinding is O(n^2). Needs optimization for large maps.', 'task', 'A', 'pending', 'high', 2000, '["pathfinding","optimization"]', null, 0, null],
    ['TSK_2002', 'Optimize Database Queries', 'Batch queries for the loot table are slow under load.', 'task', 'B', 'pending', 'normal', 750, '["database","performance"]', null, 0, null],
    ['TSK_2003', 'Weapon Stats UI Update', 'Redesign the weapon stats panel with new tier badges.', 'task', 'C', 'pending', 'low', 150, '["ui","frontend"]', null, 0, null],
    // IN PROGRESS
    ['TSK_3001', 'Deploying Neural Net v2.1', 'Compile and deploy updated neural net weights to production.', 'task', 'A', 'in_progress', 'high', 2000, '["ai","deployment"]', 'agent-sonnet-2', 75, null],
    ['TSK_3002', 'Inventory System Logic', 'Rewrite inventory management with proper state machine.', 'task', 'B', 'in_progress', 'normal', 750, '["backend","state"]', 'agent-llama-3', 33, null],
    // DONE
    ['TSK_4001', 'Deploy Hotfix v1.4.2', 'Emergency patch for the loot box randomizer.', 'task', 'A', 'done', 'critical', 2000, '["deployment","hotfix"]', 'agent-codex-1', 100, null],
    ['ERR_0088', 'Fix Null Pointer in Parser', 'Parser crashes on malformed JSON input from external API.', 'bug', 'A', 'done', 'high', 2500, '["parser","crash"]', 'agent-sonnet-2', 100, null],
    ['TSK_4002', 'Setup CI Pipeline', 'Configure GitHub Actions for automated testing and deployment.', 'task', 'B', 'done', 'normal', 750, '["devops","ci"]', 'agent-codex-1', 100, null],
    // FAILED
    ['TSK_5001', 'API Connection Retry Logic', 'Implement exponential backoff for external API failures.', 'task', 'B', 'failed', 'normal', 750, '["api","networking"]', 'agent-codex-1', 45, '> Error: Timeout 5003\n> Retries: 0/5\n> Trace: null pointer'],
    ['ERR_0201', 'Legacy Physics Engine Port', 'Port legacy physics engine to new framework. Code is cursed.', 'bug', 'A', 'failed', 'high', 2500, '["physics","legacy"]', 'agent-gpt-4', 12, '> Fatal: Stack overflow in recursive collision\n> "This code is cursed. Do not touch." - Dev 04'],
  ];

  const insertBounties = db.transaction(() => {
    for (const b of bounties) insertBounty.run(...b);
  });
  insertBounties();

  console.log('Database seeded with sample data');
}

seedData();

// Agent Status Management
function getAgentStatus(agentId) {
  return db.prepare('SELECT * FROM agent_status WHERE agentId = ?').get(agentId);
}

function updateAgentStatus(agentId, status, bountyId = null) {
  const now = Date.now();
  const existing = getAgentStatus(agentId);

  if (existing) {
    db.prepare(`
      UPDATE agent_status
      SET status = ?, lastSeen = ?, currentBountyId = ?, updatedAt = ?
      WHERE agentId = ?
    `).run(status, now, bountyId, now, agentId);
  } else {
    db.prepare(`
      INSERT INTO agent_status (agentId, status, lastSeen, currentBountyId, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(agentId, status, now, bountyId, now, now);
  }

  // Log event
  db.prepare(`
    INSERT INTO agent_events (agentId, status, bountyId, timestamp)
    VALUES (?, ?, ?, ?)
  `).run(agentId, status, bountyId, now);

  return getAgentStatus(agentId);
}

function getActiveAgents() {
  return db.prepare(`
    SELECT s.*, a.name, a.class
    FROM agent_status s
    LEFT JOIN agents a ON s.agentId = a.id
    WHERE s.isActive = 1 AND s.status != 'offline'
    ORDER BY s.lastSeen DESC
  `).all();
}

function getAllAgents() {
  return db.prepare(`
    SELECT s.*, a.name, a.class
    FROM agent_status s
    LEFT JOIN agents a ON s.agentId = a.id
    ORDER BY s.lastSeen DESC
  `).all();
}

function deactivateAgent(agentId) {
  db.prepare('UPDATE agent_status SET isActive = 0 WHERE agentId = ?').run(agentId);
  updateAgentStatus(agentId, 'offline');
  return getAgentStatus(agentId);
}

function reactivateAgent(agentId) {
  db.prepare('UPDATE agent_status SET isActive = 1 WHERE agentId = ?').run(agentId);
  return getAgentStatus(agentId);
}

function markAgentOffline(agentId, reason = 'heartbeat_timeout') {
  const status = updateAgentStatus(agentId, 'offline');
  if (status) {
    db.prepare(`
      INSERT INTO agent_events (agentId, status, reason, timestamp)
      VALUES (?, ?, ?, ?)
    `).run(agentId, 'offline', reason, Date.now());
  }
  return status;
}

function getAgentEventHistory(agentId, limit = 100) {
  return db.prepare(`
    SELECT * FROM agent_events
    WHERE agentId = ?
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(agentId, limit);
}

module.exports = {
  db,
  TIER_REWARDS,
  TIER_NAMES,
  BONUSES,
  generateTicketId,
  // Status management
  getAgentStatus,
  updateAgentStatus,
  getActiveAgents,
  getAllAgents,
  deactivateAgent,
  reactivateAgent,
  markAgentOffline,
  getAgentEventHistory
};
