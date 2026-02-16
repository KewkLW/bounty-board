const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const { execSync } = require('child_process');
const {
  db,
  TIER_REWARDS,
  TIER_NAMES,
  BONUSES,
  generateTicketId,
  getAgentStatus,
  updateAgentStatus,
  getActiveAgents,
  getAllAgents,
  deactivateAgent,
  reactivateAgent,
  markAgentOffline,
  getAgentEventHistory
} = require('./db');

// GitHub configuration
const GITHUB_REPO = 'https://github.com/KewkLW/bounty-board';

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3777;

// Track connected WebSocket clients
const wsClients = new Set();
// Track agent heartbeats for offline detection
const agentHeartbeats = new Map(); // agentId → lastSeen timestamp

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ========== WEBSOCKET REAL-TIME UPDATES ==========

// Broadcast updates to all connected clients
function broadcastUpdate(type, data) {
  const message = JSON.stringify({ type, timestamp: new Date().toISOString(), data });
  wsClients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    }
  });
}

// WebSocket connection handler
wss.on('connection', (ws) => {
  wsClients.add(ws);
  console.log(`[WS] Client connected. Total: ${wsClients.size}`);

  ws.on('close', () => {
    wsClients.delete(ws);
    console.log(`[WS] Client disconnected. Total: ${wsClients.size}`);
  });

  ws.on('error', (err) => {
    console.error(`[WS] Error:`, err.message);
    wsClients.delete(ws);
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);

      // Handle agent status updates
      if (msg.type === 'agent:status:update') {
        agentHeartbeats.set(msg.agentId, Date.now());
        const agentStatus = updateAgentStatus(msg.agentId, msg.status, msg.bountyId);

        // Broadcast status change to all clients
        broadcastUpdate('agent_status_changed', {
          agentId: msg.agentId,
          status: msg.status,
          oldStatus: msg.oldStatus,
          bountyId: msg.bountyId,
          timestamp: msg.timestamp
        });
      }

      // Handle agent heartbeats
      if (msg.type === 'agent:heartbeat') {
        agentHeartbeats.set(msg.agentId, Date.now());
      }
    } catch (err) {
      console.error('[WS] Error processing message:', err.message);
    }
  });

  // Send initial data
  try {
    const stats = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress,
        SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as done,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
      FROM bounties
    `).get();

    ws.send(JSON.stringify({
      type: 'init',
      data: stats,
      timestamp: new Date().toISOString(),
    }));
  } catch (err) {
    console.error('[WS] Error sending init data:', err.message);
  }
});

// ========== AGENT ENDPOINTS ==========

// GET /api/agents/:id - Get agent details
app.get('/api/agents/:id', (req, res) => {
  const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  res.json(agent);
});

// POST /api/agents/register - Register a new agent or update existing
app.post('/api/agents/register', (req, res) => {
  const { agent_id, agent_name, class: agentClass, level } = req.body;
  if (!agent_id || !agent_name) return res.status(400).json({ error: 'agent_id and agent_name are required' });

  try {
    const upsert = db.transaction(() => {
      // Check if agent exists
      const existing = db.prepare('SELECT * FROM agents WHERE id = ?').get(agent_id);

      if (existing) {
        // Update existing agent
        db.prepare(`
          UPDATE agents SET name = ?, class = ?, level = ?, status = 'idle', updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(agent_name, agentClass || 'Unknown', level || 1, agent_id);
      } else {
        // Create new agent
        db.prepare(`
          INSERT INTO agents (id, name, class, level, status, total_loot, missions_completed, missions_failed, streak)
          VALUES (?, ?, ?, ?, 'idle', 0, 0, 0, 0)
        `).run(agent_id, agent_name, agentClass || 'Unknown', level || 1);
      }

      return db.prepare('SELECT * FROM agents WHERE id = ?').get(agent_id);
    });

    const agent = upsert();
    res.status(200).json({ message: 'Agent registered', agent });
  } catch (err) {
    console.error('Error registering agent:', err);
    res.status(500).json({ error: err.message });
  }
});

// ========== REVIEW ENDPOINTS ==========

// GET /api/bounties/review - Get bounties pending review
app.get('/api/bounties/review', (req, res) => {
  const pending = db.prepare(`
    SELECT b.*, a.name as agent_name
    FROM bounties b
    LEFT JOIN agents a ON b.claimed_by = a.id
    WHERE b.status = 'review_needed'
    ORDER BY b.updated_at DESC
  `).all();

  res.json(pending);
});

// GET /api/bounties/:id/review - Get work evidence for review
app.get('/api/bounties/:id/review', (req, res) => {
  const bounty = db.prepare(`
    SELECT b.*, a.name as agent_name
    FROM bounties b
    LEFT JOIN agents a ON b.claimed_by = a.id
    WHERE b.id = ? AND b.status = 'review_needed'
  `).get(req.params.id);

  if (!bounty) return res.status(404).json({ error: 'Bounty not found or not pending review' });

  res.json({
    bounty_id: bounty.id,
    ticket_id: bounty.ticket_id,
    title: bounty.title,
    agent: bounty.agent_name,
    work_evidence: bounty.work_evidence,
    work_notes: bounty.work_notes,
    progress: bounty.progress,
    time_to_complete: bounty.claimed_at ? Math.floor((new Date(bounty.updated_at) - new Date(bounty.claimed_at)) / 1000) + 's' : 'unknown',
  });
});

// ========== BOUNTY ENDPOINTS ==========

// GET /api/bounties - List all bounties with optional filters
app.get('/api/bounties', (req, res) => {
  const { status, type, tier } = req.query;
  let sql = 'SELECT b.*, a.name as agent_name FROM bounties b LEFT JOIN agents a ON b.claimed_by = a.id WHERE 1=1';
  const params = [];

  if (status) { sql += ' AND b.status = ?'; params.push(status); }
  if (type) { sql += ' AND b.type = ?'; params.push(type); }
  if (tier) { sql += ' AND b.tier = ?'; params.push(tier); }

  sql += " ORDER BY CASE b.status WHEN 'pending' THEN 1 WHEN 'in_progress' THEN 2 WHEN 'done' THEN 3 WHEN 'failed' THEN 4 END, b.created_at DESC";

  try {
    const bounties = db.prepare(sql).all(...params);

    // Enrich with tier names and parse tags
    const enriched = bounties.map(b => ({
      ...b,
      tier_name: TIER_NAMES[b.type]?.[b.tier] || 'UNKNOWN',
      tags: b.tags ? JSON.parse(b.tags) : [],
    }));

    res.json(enriched);
  } catch (err) {
    console.error('Error fetching bounties:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/bounties/stats - Board statistics
app.get('/api/bounties/stats', (req, res) => {
  const stats = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
      SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress,
      SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as done,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
      SUM(CASE WHEN type = 'bug' AND status = 'pending' AND priority = 'critical' THEN 1 ELSE 0 END) as critical_bugs,
      SUM(CASE WHEN status = 'done' THEN reward ELSE 0 END) as total_loot_earned
    FROM bounties
  `).get();

  const activeAgents = db.prepare("SELECT COUNT(*) as count FROM agents WHERE status = 'active'").get().count;
  const totalAgents = db.prepare("SELECT COUNT(*) as count FROM agents").get().count;

  res.json({ ...stats, active_agents: activeAgents, total_agents: totalAgents });
});

// POST /api/bounties - Create a new bounty (conductor)
app.post('/api/bounties', (req, res) => {
  const { title, description, type, tier, priority, tags } = req.body;
  if (!title || !type) return res.status(400).json({ error: 'title and type are required' });

  const validTier = tier || 'C';
  const reward = TIER_REWARDS[type]?.[validTier] || 150;
  const ticketId = generateTicketId(type);

  const result = db.prepare(`
    INSERT INTO bounties (ticket_id, title, description, type, tier, priority, reward, tags)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(ticketId, title, description || '', type, validTier, priority || 'normal', reward, tags ? JSON.stringify(tags) : null);

  const bounty = db.prepare('SELECT * FROM bounties WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json({ ...bounty, tier_name: TIER_NAMES[type]?.[validTier] });
});

// POST /api/bounties/:id/claim - Agent claims a bounty (atomic)
app.post('/api/bounties/:id/claim', (req, res) => {
  const { agent_id } = req.body;
  if (!agent_id) return res.status(400).json({ error: 'agent_id is required' });

  const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(agent_id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  const claim = db.transaction(() => {
    const result = db.prepare(`
      UPDATE bounties
      SET status = 'in_progress', claimed_by = ?, claimed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'pending'
    `).run(agent_id, req.params.id);

    if (result.changes === 0) return null;

    // Update agent status
    db.prepare(`
      UPDATE agents SET status = 'active', current_directive = (
        SELECT title FROM bounties WHERE id = ?
      ), updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(req.params.id, agent_id);

    return db.prepare('SELECT b.*, a.name as agent_name FROM bounties b LEFT JOIN agents a ON b.claimed_by = a.id WHERE b.id = ?').get(req.params.id);
  });

  const bounty = claim();
  if (!bounty) return res.status(409).json({ error: 'Bounty already claimed or not found' });

  // Broadcast claim event
  broadcastUpdate('bounty_claimed', {
    bounty_id: bounty.id,
    ticket_id: bounty.ticket_id,
    agent_id: bounty.claimed_by,
    agent_name: bounty.agent_name,
  });

  res.json(bounty);
});

// POST /api/bounties/:id/progress - Update progress
app.post('/api/bounties/:id/progress', (req, res) => {
  const { progress } = req.body;
  if (progress === undefined) return res.status(400).json({ error: 'progress is required (0-100)' });

  db.prepare('UPDATE bounties SET progress = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(Math.min(100, Math.max(0, progress)), req.params.id);

  const bounty = db.prepare('SELECT * FROM bounties WHERE id = ?').get(req.params.id);
  res.json(bounty);
});

// POST /api/bounties/:id/submit-pr - Agent submits GitHub PR for review
app.post('/api/bounties/:id/submit-pr', (req, res) => {
  const { agent_id, pr_url, pr_number, evidence, notes } = req.body;
  if (!pr_url && !pr_number) return res.status(400).json({ error: 'pr_url or pr_number is required' });

  try {
    const fullPrUrl = pr_number ? `${GITHUB_REPO}/pull/${pr_number}` : pr_url;

    db.prepare(`
      UPDATE bounties SET
        work_evidence = ?, work_notes = ?, status = 'review_needed',
        progress = 100, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND claimed_by = ?
    `).run(`PR: ${fullPrUrl}\n${evidence || 'See PR for details'}`, notes || '', req.params.id, agent_id);

    const bounty = db.prepare('SELECT * FROM bounties WHERE id = ?').get(req.params.id);
    res.json({
      message: 'PR submitted for review',
      pr_url: fullPrUrl,
      bounty
    });
  } catch (err) {
    console.error('Error submitting PR:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/bounties/:id/submit-work - Agent submits work evidence for review
app.post('/api/bounties/:id/submit-work', (req, res) => {
  const { agent_id, evidence, notes } = req.body;
  if (!evidence) return res.status(400).json({ error: 'evidence is required' });

  try {
    db.prepare(`
      UPDATE bounties SET
        work_evidence = ?, work_notes = ?, status = 'review_needed',
        progress = 100, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND claimed_by = ?
    `).run(evidence, notes || '', req.params.id, agent_id);

    const bounty = db.prepare('SELECT * FROM bounties WHERE id = ?').get(req.params.id);
    res.json({ message: 'Work submitted for review', bounty });
  } catch (err) {
    console.error('Error submitting work:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/bounties/:id/verify - Conductor verifies and approves work
app.post('/api/bounties/:id/verify', (req, res) => {
  const { verified_by, approved } = req.body;
  if (!verified_by) return res.status(400).json({ error: 'verified_by is required' });

  const verify = db.transaction(() => {
    const bounty = db.prepare("SELECT * FROM bounties WHERE id = ? AND status = 'review_needed'").get(req.params.id);
    if (!bounty) return null;

    if (!approved) {
      // Reject work - back to in_progress
      db.prepare(`
        UPDATE bounties SET status = 'in_progress', verified_by = ?, verified_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(verified_by, req.params.id);
      return { status: 'rejected' };
    }

    // Approve work and award XP
    let finalReward = bounty.reward;
    const claimedAt = new Date(bounty.claimed_at);
    const now = new Date();
    const minutesElapsed = (now - claimedAt) / 60000;

    if (minutesElapsed <= BONUSES.FIRST_BLOOD_MINUTES) {
      finalReward = Math.floor(finalReward * BONUSES.FIRST_BLOOD_MULT);
    }

    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(bounty.claimed_by);
    if (agent) {
      const streakBonus = 1 + (agent.streak * BONUSES.STREAK_MULT);
      finalReward = Math.floor(finalReward * Math.min(streakBonus, 2.0));

      db.prepare(`
        UPDATE agents SET
          total_loot = total_loot + ?,
          missions_completed = missions_completed + 1,
          streak = streak + 1,
          status = 'idle',
          current_directive = NULL,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(finalReward, bounty.claimed_by);
    }

    db.prepare(`
      UPDATE bounties SET
        status = 'done', reward = ?, verified_by = ?, verified_at = CURRENT_TIMESTAMP,
        completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(finalReward, verified_by, req.params.id);

    return { status: 'approved', reward: finalReward };
  });

  const result = verify();
  if (!result) return res.status(404).json({ error: 'Bounty not found or not awaiting review' });
  res.json(result);
});

// POST /api/bounties/:id/complete - Mark bounty as done (auto-verify for now)
app.post('/api/bounties/:id/complete', (req, res) => {
  const complete = db.transaction(() => {
    const bounty = db.prepare("SELECT * FROM bounties WHERE id = ? AND status = 'in_progress'").get(req.params.id);
    if (!bounty) return null;

    // Calculate bonus XP
    let finalReward = bounty.reward;
    const claimedAt = new Date(bounty.claimed_at);
    const now = new Date();
    const minutesElapsed = (now - claimedAt) / 60000;

    // First Blood bonus
    if (minutesElapsed <= BONUSES.FIRST_BLOOD_MINUTES) {
      finalReward = Math.floor(finalReward * BONUSES.FIRST_BLOOD_MULT);
    }

    // Get agent streak for streak bonus
    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(bounty.claimed_by);
    if (agent) {
      const streakBonus = 1 + (agent.streak * BONUSES.STREAK_MULT);
      finalReward = Math.floor(finalReward * Math.min(streakBonus, 2.0)); // cap at 2x

      // Update agent stats
      db.prepare(`
        UPDATE agents SET
          total_loot = total_loot + ?,
          missions_completed = missions_completed + 1,
          streak = streak + 1,
          status = 'idle',
          current_directive = NULL,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(finalReward, bounty.claimed_by);
    }

    // Mark bounty done with auto-verification
    db.prepare(`
      UPDATE bounties SET
        status = 'done', progress = 100, reward = ?,
        completed_at = CURRENT_TIMESTAMP, verified_by = ?, verified_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(finalReward, bounty.claimed_by, bounty.id);

    return db.prepare('SELECT b.*, a.name as agent_name FROM bounties b LEFT JOIN agents a ON b.claimed_by = a.id WHERE b.id = ?').get(bounty.id);
  });

  const result = complete();
  if (!result) return res.status(404).json({ error: 'Bounty not found or not in progress' });

  // Broadcast completion event
  broadcastUpdate('bounty_completed', {
    bounty_id: result.id,
    ticket_id: result.ticket_id,
    agent_id: result.claimed_by,
    agent_name: result.agent_name,
    reward: result.reward,
  });

  res.json(result);
});

// POST /api/bounties/:id/fail - Mark bounty as failed
app.post('/api/bounties/:id/fail', (req, res) => {
  const { error_log } = req.body;

  const fail = db.transaction(() => {
    const bounty = db.prepare('SELECT * FROM bounties WHERE id = ? AND status = "in_progress"').get(req.params.id);
    if (!bounty) return null;

    // Apply botch penalty
    const penalty = Math.floor(bounty.reward * BONUSES.BOTCH_PENALTY);
    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(bounty.claimed_by);
    if (agent) {
      db.prepare(`
        UPDATE agents SET
          total_loot = MAX(0, total_loot - ?),
          missions_failed = missions_failed + 1,
          streak = 0,
          status = 'idle',
          current_directive = NULL,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(penalty, bounty.claimed_by);
    }

    db.prepare(`
      UPDATE bounties SET
        status = 'failed', error_log = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(error_log || 'No error log provided', bounty.id);

    return db.prepare('SELECT b.*, a.name as agent_name FROM bounties b LEFT JOIN agents a ON b.claimed_by = a.id WHERE b.id = ?').get(bounty.id);
  });

  const result = fail();
  if (!result) return res.status(404).json({ error: 'Bounty not found or not in progress' });

  // Broadcast failure event
  broadcastUpdate('bounty_failed', {
    bounty_id: result.id,
    ticket_id: result.ticket_id,
    agent_id: result.claimed_by,
    agent_name: result.agent_name,
    error_log: result.error_log,
  });

  res.json(result);
});

// POST /api/bounties/:id/retry - Retry a failed bounty (resets to pending)
app.post('/api/bounties/:id/retry', (req, res) => {
  db.prepare(`
    UPDATE bounties SET
      status = 'pending', claimed_by = NULL, progress = 0, error_log = NULL,
      claimed_at = NULL, completed_at = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'failed'
  `).run(req.params.id);

  const bounty = db.prepare('SELECT * FROM bounties WHERE id = ?').get(req.params.id);
  if (!bounty) return res.status(404).json({ error: 'Bounty not found' });
  res.json(bounty);
});

// ========== AGENT ENDPOINTS ==========

// GET /api/agents - List all agents
app.get('/api/agents', (req, res) => {
  const { status } = req.query;
  let sql = 'SELECT * FROM agents';
  const params = [];
  if (status) { sql += ' WHERE status = ?'; params.push(status); }
  sql += ' ORDER BY total_loot DESC';
  res.json(db.prepare(sql).all(...params));
});

// GET /api/agents/leaderboard - Leaderboard with success rate
app.get('/api/agents/leaderboard', (req, res) => {
  const agents = db.prepare(`
    SELECT *,
      CASE WHEN (missions_completed + missions_failed) > 0
        THEN ROUND(CAST(missions_completed AS REAL) / (missions_completed + missions_failed) * 100, 1)
        ELSE 0
      END as success_rate,
      missions_completed + missions_failed as total_missions
    FROM agents
    ORDER BY total_loot DESC
  `).all();

  res.json(agents);
});

// GET /api/agents/:id - Single agent details
app.get('/api/agents/:id', (req, res) => {
  const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  // Get their bounties
  const bounties = db.prepare('SELECT * FROM bounties WHERE claimed_by = ? ORDER BY updated_at DESC LIMIT 20').all(req.params.id);
  res.json({ ...agent, bounties });
});

// POST /api/agents - Register a new agent
app.post('/api/agents', (req, res) => {
  const { id, name, class: agentClass } = req.body;
  if (!id || !name) return res.status(400).json({ error: 'id and name are required' });

  try {
    db.prepare('INSERT INTO agents (id, name, class) VALUES (?, ?, ?)').run(id, name, agentClass || 'Scavenger');
    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(id);
    res.status(201).json(agent);
  } catch (e) {
    res.status(409).json({ error: 'Agent ID already exists' });
  }
});

// ========== TIER INFO ==========
app.get('/api/tiers', (req, res) => {
  res.json({ rewards: TIER_REWARDS, names: TIER_NAMES, bonuses: BONUSES });
});

// ========== AGENT STATUS ENDPOINTS ==========

// GET /api/agents/status/active - Get only active agents with real-time status
app.get('/api/agents/status/active', (req, res) => {
  try {
    const agents = getActiveAgents();
    res.json(agents);
  } catch (err) {
    console.error('Error fetching active agents:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/agents/status/all - Get all agents with their status
app.get('/api/agents/status/all', (req, res) => {
  try {
    const agents = getAllAgents();
    res.json(agents);
  } catch (err) {
    console.error('Error fetching all agents:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/agents/:id/status - Get specific agent status
app.get('/api/agents/:id/status', (req, res) => {
  try {
    const status = getAgentStatus(req.params.id);
    if (!status) {
      return res.status(404).json({ error: 'Agent status not found' });
    }
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/agents/:id/status - Update agent status
app.post('/api/agents/:id/status', (req, res) => {
  const { status, bountyId } = req.body;
  if (!status) return res.status(400).json({ error: 'status is required' });

  try {
    const result = updateAgentStatus(req.params.id, status, bountyId);
    agentHeartbeats.set(req.params.id, Date.now());

    // Broadcast to all connected clients
    broadcastUpdate('agent_status_changed', {
      agentId: req.params.id,
      status: status,
      bountyId: bountyId,
      timestamp: new Date().toISOString()
    });

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/agents/:id/deactivate - Deactivate agent (conductor control)
app.post('/api/agents/:id/deactivate', (req, res) => {
  try {
    const result = deactivateAgent(req.params.id);
    agentHeartbeats.delete(req.params.id);

    // Broadcast offline status
    broadcastUpdate('agent_offline', {
      agentId: req.params.id,
      reason: 'manual',
      timestamp: new Date().toISOString()
    });

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/agents/:id/reactivate - Reactivate agent
app.post('/api/agents/:id/reactivate', (req, res) => {
  try {
    const result = reactivateAgent(req.params.id);
    agentHeartbeats.set(req.params.id, Date.now());

    // Broadcast online status
    broadcastUpdate('agent_online', {
      agentId: req.params.id,
      timestamp: new Date().toISOString()
    });

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/agents/:id/events - Get agent status event history
app.get('/api/agents/:id/events', (req, res) => {
  const { limit } = req.query;
  try {
    const events = getAgentEventHistory(req.params.id, parseInt(limit) || 100);
    res.json(events);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== SERVE FRONTEND ==========
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/roster', (req, res) => res.sendFile(path.join(__dirname, 'public', 'roster.html')));
app.get('/leaderboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'leaderboard.html')));
app.get('/agents', (req, res) => res.sendFile(path.join(__dirname, 'public', 'agents.html')));

// ========== HEARTBEAT TIMEOUT DETECTION ==========

// Check for offline agents every 10 seconds
setInterval(() => {
  const now = Date.now();
  const HEARTBEAT_TIMEOUT = 15000; // 15 seconds

  for (const [agentId, lastSeen] of agentHeartbeats.entries()) {
    if (now - lastSeen > HEARTBEAT_TIMEOUT) {
      console.log(`[MONITOR] Agent ${agentId} heartbeat timeout - marking offline`);
      markAgentOffline(agentId, 'heartbeat_timeout');
      agentHeartbeats.delete(agentId);

      // Broadcast offline event
      broadcastUpdate('agent_offline', {
        agentId: agentId,
        reason: 'heartbeat_timeout',
        timestamp: new Date().toISOString()
      });
    }
  }
}, 10000);

// Initialize agent_status table with all agents from agents table on startup
function initializeAgentRegistry() {
  try {
    const agents = db.prepare('SELECT id, name, class FROM agents').all();
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO agent_status
      (agentId, status, isActive, currentBountyId, lastSeen, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const now = new Date().toISOString();
    agents.forEach(agent => {
      stmt.run(
        agent.id,
        'idle',
        1,
        null,
        now,
        now,
        now
      );
    });

    console.log(`✓ Initialized ${agents.length} agents in status registry`);
  } catch (err) {
    console.error('Error initializing agent registry:', err.message);
  }
}

// Initialize on startup
initializeAgentRegistry();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  WASTELAND BOUNTY BOARD`);
  console.log(`  =====================`);
  console.log(`  Server online at http://localhost:${PORT}`);
  console.log(`  Board:       http://localhost:${PORT}/`);
  console.log(`  Roster:      http://localhost:${PORT}/roster`);
  console.log(`  Leaderboard: http://localhost:${PORT}/leaderboard`);
  console.log(`  API:         http://localhost:${PORT}/api/bounties`);
  console.log(`  WebSocket:   ws://localhost:${PORT}`);
  console.log(`  CLI:         node bounty-cli.js [command]\n`);
});
