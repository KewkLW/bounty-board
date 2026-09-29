// Database: schema, migration from the Feb-2026 board, and small helpers.
// One process (the server) owns the DB; the CLI and workers talk to the server over HTTP.
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = 2;

const STATUSES = ['backlog', 'ready', 'in_progress', 'review', 'approved', 'done', 'blocked', 'failed'];
const TYPES = ['task', 'bug', 'test', 'research', 'art', 'docs'];
const TIERS = ['S', 'A', 'B', 'C'];
const PRIORITIES = ['critical', 'high', 'normal', 'low'];

const BOUNTIES_DDL = `
  CREATE TABLE bounties (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id TEXT UNIQUE,
    project_id TEXT REFERENCES projects(id),
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    criteria TEXT DEFAULT '[]',            -- JSON [{text, done, note}]
    type TEXT NOT NULL DEFAULT 'task' CHECK(type IN (${TYPES.map(t => `'${t}'`).join(',')})),
    tier TEXT NOT NULL DEFAULT 'C' CHECK(tier IN ('S','A','B','C')),
    priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('critical','high','normal','low')),
    status TEXT NOT NULL DEFAULT 'backlog' CHECK(status IN (${STATUSES.map(s => `'${s}'`).join(',')})),
    blocked_reason TEXT,
    parent_id INTEGER REFERENCES bounties(id),
    depends_on TEXT DEFAULT '[]',          -- JSON [bountyId]
    assignee_slot TEXT,
    external_owner TEXT,                   -- work tracked here but run outside the dispatcher
    branch TEXT,
    worktree TEXT,
    commits TEXT DEFAULT '[]',             -- JSON [sha] recorded at submit
    ci_status TEXT,                        -- null | running | pass | fail
    ci_log TEXT,
    ci_at TEXT,
    review_state TEXT,                     -- null | pending | running | done | error
    review_verdict TEXT,                   -- approve | reject
    review_notes TEXT,
    review_errors INTEGER DEFAULT 0,
    attempts INTEGER DEFAULT 0,
    failures INTEGER DEFAULT 0,
    cost_usd REAL DEFAULT 0,
    tokens_in INTEGER DEFAULT 0,
    tokens_out INTEGER DEFAULT 0,
    reward INTEGER NOT NULL DEFAULT 150,
    tags TEXT,
    import_key TEXT UNIQUE,
    heartbeat_at TEXT,
    -- per-status timestamps (latest entry into that status)
    backlog_at TEXT, ready_at TEXT, in_progress_at TEXT, review_at TEXT, approved_at TEXT,
    done_at TEXT, blocked_at TEXT, failed_at TEXT,
    -- kept from the Feb-2026 board (history)
    claimed_by TEXT,
    progress INTEGER DEFAULT 0,
    error_log TEXT,
    work_evidence TEXT,
    work_notes TEXT,
    verified_by TEXT,
    claimed_at TEXT,
    completed_at TEXT,
    verified_at TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`;

function now() { return new Date().toISOString(); }

function open(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
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
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT,
      repo TEXT NOT NULL,
      main_branch TEXT NOT NULL DEFAULT 'main',
      worktree_cmd TEXT,          -- run in repo; {task} {branch} {path} {main}
      worktree_path TEXT,         -- where the worktree lands; {task}
      verify_cmd TEXT,            -- run in the worktree
      verify_timeout_min INTEGER DEFAULT 90,
      rules TEXT DEFAULT '[]',    -- JSON [path] the worker must read first
      docs_only_types TEXT DEFAULT '["docs","research"]',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
  const v = Number((db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() || {}).value || 0);
  if (v >= SCHEMA_VERSION) { ensureAux(db); return; }

  db.pragma('foreign_keys = OFF');
  const tx = db.transaction(() => {
    if (tableExists(db, 'bounties')) {
      // Feb-2026 board: statuses pending/in_progress/review_needed/done/failed, types task/bug.
      db.exec(BOUNTIES_DDL.replace('CREATE TABLE bounties', 'CREATE TABLE bounties_new'));
      const oldCols = db.prepare('PRAGMA table_info(bounties)').all().map(c => c.name);
      const has = c => oldCols.includes(c);
      db.prepare(`INSERT OR IGNORE INTO projects (id, name, repo, main_branch) VALUES ('legacy', 'Legacy (Feb 2026 board)', '', 'main')`).run();
      const rows = db.prepare('SELECT * FROM bounties').all();
      const ins = db.prepare(`INSERT INTO bounties_new
        (id, ticket_id, project_id, title, description, type, tier, priority, status, blocked_reason, reward, tags,
         claimed_by, progress, error_log, work_evidence, work_notes, verified_by, claimed_at, completed_at, verified_at,
         in_progress_at, done_at, failed_at, blocked_at, backlog_at, created_at, updated_at)
        VALUES (@id, @ticket_id, 'legacy', @title, @description, @type, @tier, @priority, @status, @blocked_reason, @reward, @tags,
         @claimed_by, @progress, @error_log, @work_evidence, @work_notes, @verified_by, @claimed_at, @completed_at, @verified_at,
         @claimed_at, @done_at, @failed_at, @blocked_at, @backlog_at, @created_at, @updated_at)`);
      for (const r of rows) {
        let status = r.status, blocked_reason = null;
        if (status === 'pending') status = 'backlog';
        else if (status === 'in_progress' || status === 'review_needed') {
          blocked_reason = `legacy: was '${r.status}' on the Feb-2026 board when it was abandoned`;
          status = 'blocked';
        }
        ins.run({
          id: r.id, ticket_id: r.ticket_id, title: r.title, description: r.description || '',
          type: TYPES.includes(r.type) ? r.type : 'task', tier: r.tier || 'C', priority: r.priority || 'normal',
          status, blocked_reason, reward: r.reward || 150, tags: r.tags,
          claimed_by: r.claimed_by, progress: r.progress || 0, error_log: r.error_log,
          work_evidence: has('work_evidence') ? r.work_evidence : null, work_notes: has('work_notes') ? r.work_notes : null,
          verified_by: has('verified_by') ? r.verified_by : null, claimed_at: r.claimed_at, completed_at: r.completed_at,
          verified_at: has('verified_at') ? r.verified_at : null,
          done_at: status === 'done' ? (r.completed_at || r.updated_at) : null,
          failed_at: status === 'failed' ? r.updated_at : null,
          blocked_at: status === 'blocked' ? now() : null,
          backlog_at: status === 'backlog' ? r.created_at : null,
          created_at: r.created_at, updated_at: r.updated_at,
        });
      }
      db.exec('DROP TABLE bounties');
      db.exec('ALTER TABLE bounties_new RENAME TO bounties');
    } else {
      db.exec(BOUNTIES_DDL);
    }
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
  });
  tx();
  db.pragma('foreign_keys = ON');
  ensureAux(db);
}

function ensureAux(db) {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_bounties_status ON bounties(status);
    CREATE INDEX IF NOT EXISTS idx_bounties_project ON bounties(project_id);
    CREATE INDEX IF NOT EXISTS idx_bounties_slot ON bounties(assignee_slot);
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bounty_id INTEGER,
      at TEXT NOT NULL,
      actor TEXT,
      kind TEXT NOT NULL,          -- status | progress | note | message | verify | review | spawn | exit | lease | assign
      from_status TEXT,
      to_status TEXT,
      note TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_events_bounty ON events(bounty_id);
    CREATE TABLE IF NOT EXISTS attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bounty_id INTEGER NOT NULL,
      slot TEXT,
      runner TEXT,
      model TEXT,
      effort TEXT,
      pid INTEGER,
      started_at TEXT,
      ended_at TEXT,
      exit_code INTEGER,
      log_path TEXT,
      prompt_path TEXT,
      cost_usd REAL,
      tokens_in INTEGER,
      tokens_out INTEGER,
      cache_read INTEGER,
      cache_write INTEGER,
      kind TEXT DEFAULT 'worker',  -- worker | review
      outcome TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_attempts_bounty ON attempts(bounty_id);
    CREATE TABLE IF NOT EXISTS leases (
      resource TEXT PRIMARY KEY,
      bounty_id INTEGER,
      slot TEXT,
      holder TEXT,
      acquired_at TEXT,
      expires_at TEXT,
      note TEXT
    );
  `);
  // Orchestrator notes to a live worker are events of kind 'message'; read_at/read_by mark
  // when a worker saw them (bounty inbox / progress / start).
  const evCols = db.prepare('PRAGMA table_info(events)').all().map(c => c.name);
  if (!evCols.includes('read_at')) db.exec('ALTER TABLE events ADD COLUMN read_at TEXT');
  if (!evCols.includes('read_by')) db.exec('ALTER TABLE events ADD COLUMN read_by TEXT');
}

function getMeta(db, key, dflt = null) {
  const r = db.prepare('SELECT value FROM meta WHERE key=?').get(key);
  return r ? r.value : dflt;
}
function setMeta(db, key, value) {
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, String(value));
}

function addEvent(db, e) {
  db.prepare(`INSERT INTO events (bounty_id, at, actor, kind, from_status, to_status, note)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(e.bounty_id ?? null, now(), e.actor || null, e.kind,
    e.from_status || null, e.to_status || null, e.note == null ? null : String(e.note));
}

const JSON_FIELDS = ['criteria', 'depends_on', 'commits', 'tags'];
function hydrate(b) {
  if (!b) return b;
  for (const f of JSON_FIELDS) {
    try { b[f] = b[f] ? JSON.parse(b[f]) : []; } catch { b[f] = []; }
  }
  return b;
}

module.exports = { open, now, addEvent, getMeta, setMeta, hydrate, STATUSES, TYPES, TIERS, PRIORITIES, SCHEMA_VERSION };
