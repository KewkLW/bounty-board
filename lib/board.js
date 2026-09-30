// The board: every operation on bounties, projects, leases and the pause switch.
// HTTP (lib/api.js), the dispatcher and the tests all go through this class.
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const dbm = require('./db');
const { transition, TransitionError } = require('./machine');
const gitx = require('./git');
const { spawnSync } = require('child_process');

const { now, addEvent, hydrate, TYPES, TIERS, PRIORITIES } = dbm;

// Loot tables (the Wasteland economy from the original board).
const TIER_REWARDS = {
  bug: { S: 5000, A: 2500, B: 1000, C: 250 },
  task: { S: 5000, A: 2000, B: 750, C: 150 },
};
const TIER_NAMES = {
  bug: { S: 'KILL ORDER', A: 'WANTED: DEAD', B: 'BOUNTY POSTED', C: 'PEST CONTROL' },
  task: { S: 'BLACK OPS', A: 'MERC CONTRACT', B: 'SALVAGE RUN', C: 'SCRAP WORK' },
  test: { S: 'FIELD TRIAL', A: 'LIVE FIRE', B: 'RANGE DAY', C: 'DRY RUN' },
  research: { S: 'DEEP RECON', A: 'RECON', B: 'SCOUTING', C: 'LOOKOUT' },
  art: { S: 'MASTERWORK', A: 'COMMISSION', B: 'SKETCH RUN', C: 'DOODLE' },
  docs: { S: 'ARCHIVE', A: 'DOSSIER', B: 'FIELD NOTES', C: 'SCRAWL' },
};
const BONUSES = { FIRST_TRY_MULT: 1.25, STREAK_MULT: 0.1, STREAK_CAP: 2.0, BOTCH_PENALTY: 0.5 };
const TICKET_PREFIX = { bug: 'ERR', task: 'TSK', test: 'TST', research: 'RSH', art: 'ART', docs: 'DOC' };
const PRIORITY_ORDER = "CASE b.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END";
const TIER_ORDER = "CASE b.tier WHEN 'S' THEN 0 WHEN 'A' THEN 1 WHEN 'B' THEN 2 ELSE 3 END";
const SLOT_CLASS = { opus: 'Commando', sonnet: 'Recon', haiku: 'Scout', codex: 'Hunter' };

function rewardFor(type, tier) {
  const table = TIER_REWARDS[type] || TIER_REWARDS.task;
  return table[tier] || 150;
}

class Board extends EventEmitter {
  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.db = dbm.open(cfg.db_path);
    fs.mkdirSync(cfg.logs_dir, { recursive: true });
    this.dispatcher = null;   // set by the dispatcher (liveness of workers)
    this.reviewer = null;     // set by the reviewer (review queue)
    this.verifyQueue = [];
    this.verifyRunning = 0;
    this.verifyActive = new Map(); // bountyId -> { id, started, logPath } for the Live page
    this.seedSlots();
    this.migrateAgents();
    this.resumeVerifies();
  }

  // The verify queue lives in memory, so a board restart used to drop every queued or running
  // verify and leave those bounties 'verifying' forever. Re-queue them (oldest first) on startup.
  resumeVerifies() {
    const rows = this.db.prepare(`SELECT id, worktree, project_id FROM bounties
      WHERE status = 'in_progress' AND ci_status = 'running' ORDER BY ci_at, id`).all();
    for (const r of rows) {
      const p = this.project(r.project_id);
      if (!p) continue;
      const dir = r.worktree && fs.existsSync(r.worktree) ? r.worktree : p.repo;
      this.verifyQueue.push({ id: r.id, dir, actor: 'board' });
      addEvent(this.db, { bounty_id: r.id, actor: 'board', kind: 'verify', note: 'verify re-queued after a board restart' });
    }
    if (rows.length) setImmediate(() => this.pumpVerify());
  }

  // ---------- helpers ----------
  slot(id) { return this.cfg.slots.find(s => s.id === id) || null; }
  isWorker(actor) { return !!this.slot(actor); }
  changed(kind, data = {}) {
    if (kind === 'bounty') this.scheduleRebuild();
    this.emit('changed', { kind, ...data });
  }
  raw(id) { return this.db.prepare('SELECT * FROM bounties WHERE id = ?').get(id); }
  need(id) {
    const b = this.raw(id);
    if (!b) throw new TransitionError(`bounty ${id} not found`, 404);
    return hydrate(b);
  }
  project(id) {
    const p = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
    if (p) { try { p.rules = JSON.parse(p.rules || '[]'); } catch { p.rules = []; } try { p.docs_only_types = JSON.parse(p.docs_only_types || '[]'); } catch { p.docs_only_types = []; } }
    return p;
  }
  workerAlive(bountyId) { return this.dispatcher ? this.dispatcher.isAlive(bountyId) : false; }

  seedSlots() {
    for (const s of this.cfg.slots) this.registerAgent(s.id);
  }

  // The only way an agent row comes to exist: a configured dispatcher slot. Anything else is refused.
  registerAgent(id) {
    const s = this.slot(id);
    if (!s) throw new TransitionError(`'${id}' is not a configured slot (${this.cfg.slots.map(x => x.id).join(', ')}); only slots can be agents`, 403);
    const cls = SLOT_CLASS[s.model] || SLOT_CLASS[s.runner] || 'Scavenger';
    this.db.prepare(`INSERT OR IGNORE INTO agents (id, name, class, level, status) VALUES (?, ?, ?, 1, 'idle')`).run(s.id, s.id.toUpperCase(), cls);
    return this.db.prepare('SELECT * FROM agents WHERE id = ?').get(s.id);
  }

  // Re-runnable at every start: drop non-slot agents; once, credit verified dones that predate the
  // credited_slot column; then rebuild the agents' counters from history.
  migrateAgents() {
    const purged = dbm.purgeNonSlotAgents(this.db, this.cfg.slots.map(s => s.id));
    let credited = 0;
    if (!dbm.getMeta(this.db, 'credit_backfill_v1')) {
      const back = this.db.prepare(`SELECT * FROM bounties WHERE status = 'done' AND project_id != 'legacy' AND credited_slot IS NULL
        AND (verified_by = 'merge-check' OR verified_by LIKE 'close-merged%')`).all();
      for (const b of back) {
        const c = this.creditFor(hydrate(b), { via: b.verified_by === 'merge-check' ? 'merge-check' : 'close-merged', checkCommits: false });
        if (c) { this.db.prepare('UPDATE bounties SET credited_slot = ?, credited_attempt = ? WHERE id = ?').run(c.slot, c.attempt, b.id); credited++; }
      }
      dbm.setMeta(this.db, 'credit_backfill_v1', JSON.stringify({ at: now(), checked: back.length, credited }));
    }
    this.rebuildAgents();
    return { purged, credited };
  }

  // ---------- projects ----------
  listProjects() {
    return this.db.prepare('SELECT * FROM projects ORDER BY id').all().map(p => this.project(p.id));
  }
  upsertProject(p) {
    if (!p.id || !p.repo) throw new TransitionError('project needs id and repo', 400);
    const cur = this.project(p.id) || {};
    const row = {
      id: p.id, name: p.name ?? cur.name ?? p.id, repo: p.repo, main_branch: p.main_branch ?? cur.main_branch ?? 'main',
      worktree_cmd: p.worktree_cmd ?? cur.worktree_cmd ?? 'git worktree add {path} -b {branch} {main}',
      worktree_path: p.worktree_path ?? cur.worktree_path ?? null,
      verify_cmd: p.verify_cmd ?? cur.verify_cmd ?? null,
      verify_timeout_min: p.verify_timeout_min ?? cur.verify_timeout_min ?? 90,
      rules: JSON.stringify(p.rules ?? cur.rules ?? []),
      docs_only_types: JSON.stringify(p.docs_only_types ?? cur.docs_only_types ?? ['docs', 'research']),
    };
    this.db.prepare(`INSERT INTO projects (id, name, repo, main_branch, worktree_cmd, worktree_path, verify_cmd, verify_timeout_min, rules, docs_only_types)
      VALUES (@id, @name, @repo, @main_branch, @worktree_cmd, @worktree_path, @verify_cmd, @verify_timeout_min, @rules, @docs_only_types)
      ON CONFLICT(id) DO UPDATE SET name=@name, repo=@repo, main_branch=@main_branch, worktree_cmd=@worktree_cmd,
        worktree_path=@worktree_path, verify_cmd=@verify_cmd, verify_timeout_min=@verify_timeout_min, rules=@rules,
        docs_only_types=@docs_only_types`).run(row);
    this.changed('project', { id: p.id });
    return this.project(p.id);
  }

  // The project a bounty gets when none is given: config default_project, else the only
  // non-legacy project, else none (create then refuses).
  defaultProject() {
    const d = this.cfg.default_project;
    if (d) return d;
    const ids = this.db.prepare("SELECT id FROM projects WHERE id != 'legacy'").all().map(r => r.id);
    return ids.length === 1 ? ids[0] : null;
  }

  // ---------- read ----------
  get(id) {
    const b = this.need(id);
    b.events = this.db.prepare('SELECT * FROM events WHERE bounty_id = ? ORDER BY id').all(id);
    b.attempts = this.db.prepare('SELECT * FROM attempts WHERE bounty_id = ? ORDER BY id').all(id);
    b.children = this.db.prepare('SELECT id, title, status FROM bounties WHERE parent_id = ? ORDER BY id').all(id);
    b.tier_name = (TIER_NAMES[b.type] || TIER_NAMES.task)[b.tier];
    b.worker_alive = this.workerAlive(id);
    return b;
  }

  list(f = {}) {
    let sql = `SELECT b.* FROM bounties b WHERE 1=1`;
    const params = {};
    for (const k of ['status', 'type', 'tier', 'priority']) {
      if (f[k]) {
        const vals = String(f[k]).split(',');
        sql += ` AND b.${k} IN (${vals.map((v, i) => `@${k}${i}`).join(',')})`;
        vals.forEach((v, i) => { params[`${k}${i}`] = v; });
      }
    }
    if (f.project) { sql += ' AND b.project_id = @project'; params.project = f.project; }
    if (f.slot) {
      if (f.slot === 'none') sql += ' AND b.assignee_slot IS NULL';
      else { sql += ' AND b.assignee_slot = @slot'; params.slot = f.slot; }
    }
    if (f.parent) { sql += ' AND b.parent_id = @parent'; params.parent = Number(f.parent); }
    if (f.q) { sql += ' AND (b.title LIKE @q OR b.description LIKE @q OR b.ticket_id LIKE @q)'; params.q = `%${f.q}%`; }
    sql += ` ORDER BY ${PRIORITY_ORDER}, ${TIER_ORDER}, b.id`;
    if (f.limit) { sql += ' LIMIT @limit'; params.limit = Number(f.limit); }
    return this.db.prepare(sql).all(params).map(b => {
      hydrate(b);
      b.tier_name = (TIER_NAMES[b.type] || TIER_NAMES.task)[b.tier];
      return b;
    });
  }

  // Header numbers: the legacy (Feb-2026) project is left out; loot is the slots' derived loot.
  stats() {
    const s = this.db.prepare(`SELECT COUNT(*) total,
      ${dbm.STATUSES.map(st => `COALESCE(SUM(CASE WHEN status='${st}' THEN 1 ELSE 0 END), 0) AS ${st}`).join(', ')},
      COALESCE(SUM(CASE WHEN type='bug' AND status NOT IN ('done','failed') AND priority IN ('critical','high') THEN 1 ELSE 0 END), 0) critical_bugs,
      COALESCE(SUM(CASE WHEN status='done' AND credited_slot IS NOT NULL THEN 1 ELSE 0 END), 0) done_credited,
      ROUND(COALESCE(SUM(cost_usd), 0), 2) total_cost_usd
      FROM bounties WHERE project_id IS NULL OR project_id != 'legacy'`).get();
    const led = this.ledger();
    s.total_loot_earned = led.slots.reduce((a, x) => a + x.total_loot, 0);
    s.slot_cost_usd = Math.round(led.slots.reduce((a, x) => a + x.cost_usd, 0) * 100) / 100;
    s.legacy_excluded = this.db.prepare("SELECT COUNT(*) c FROM bounties WHERE project_id = 'legacy'").get().c;
    return s;
  }

  // ---------- create / edit ----------
  create(d, actor = 'orchestrator') {
    if (!d.title || !String(d.title).trim()) throw new TransitionError('title is required', 400);
    const type = d.type || 'task';
    if (!TYPES.includes(type)) throw new TransitionError(`type must be one of ${TYPES.join(', ')}`, 400);
    const tier = d.tier || 'C';
    if (!TIERS.includes(tier)) throw new TransitionError('tier must be S/A/B/C', 400);
    const priority = d.priority || 'normal';
    if (!PRIORITIES.includes(priority)) throw new TransitionError(`priority must be one of ${PRIORITIES.join(', ')}`, 400);
    const project_id = d.project || d.project_id || this.defaultProject();
    if (!project_id) {
      const known = this.listProjects().map(p => p.id).filter(id => id !== 'legacy');
      throw new TransitionError(`a bounty needs a project: pass --project (known: ${known.join(', ') || 'none; add one with bounty project add'}), or set default_project in config/board.json`, 400);
    }
    if (!this.project(project_id)) throw new TransitionError(`unknown project '${project_id}'`, 400);
    if (d.assignee_slot && !this.slot(d.assignee_slot)) throw new TransitionError(`unknown slot '${d.assignee_slot}'`, 400);
    const criteria = normCriteria(d.criteria);
    const t = now();
    const status = d.status || 'backlog';
    if (!['backlog', 'ready', 'in_progress', 'blocked'].includes(status)) throw new TransitionError('new bounties start in backlog, ready, in_progress or blocked', 400);
    if (status === 'ready') this.checkReadyable({ project_id, criteria });
    const r = this.db.prepare(`INSERT INTO bounties (project_id, title, description, criteria, type, tier, priority, status,
        blocked_reason, parent_id, depends_on, assignee_slot, external_owner, branch, worktree, reward, tags, import_key,
        ${status}_at, created_at, updated_at, claimed_by, claimed_at)
      VALUES (@project_id, @title, @description, @criteria, @type, @tier, @priority, @status, @blocked_reason, @parent_id,
        @depends_on, @assignee_slot, @external_owner, @branch, @worktree, @reward, @tags, @import_key, @t, @t, @t, @claimed_by, @claimed_at)`)
      .run({
        project_id, title: String(d.title).trim(), description: d.description || '', criteria: JSON.stringify(criteria),
        type, tier, priority, status, blocked_reason: d.blocked_reason || null, parent_id: d.parent_id || null,
        depends_on: JSON.stringify((d.depends_on || []).map(Number)), assignee_slot: d.assignee_slot || null,
        external_owner: d.external_owner || null, branch: d.branch || null, worktree: d.worktree || null,
        reward: rewardFor(type, tier), tags: d.tags ? JSON.stringify(d.tags) : null, import_key: d.import_key || null, t,
        claimed_by: status === 'in_progress' ? (d.external_owner || d.assignee_slot || null) : null,
        claimed_at: status === 'in_progress' ? t : null,
      });
    const id = Number(r.lastInsertRowid);
    this.db.prepare('UPDATE bounties SET ticket_id = ? WHERE id = ?').run(`${TICKET_PREFIX[type]}_${String(id).padStart(4, '0')}`, id);
    addEvent(this.db, { bounty_id: id, actor, kind: 'status', to_status: status, note: d.parent_id ? `split from #${d.parent_id}` : 'created' });
    this.changed('bounty', { id });
    return this.get(id);
  }

  update(id, d, actor = 'orchestrator') {
    const b = this.need(id);
    const cols = {};
    if (d.title != null) cols.title = String(d.title);
    if (d.description != null) cols.description = String(d.description);
    if (d.criteria != null) cols.criteria = JSON.stringify(normCriteria(d.criteria));
    if (d.type != null) { if (!TYPES.includes(d.type)) throw new TransitionError('bad type', 400); cols.type = d.type; }
    if (d.tier != null) { if (!TIERS.includes(d.tier)) throw new TransitionError('bad tier', 400); cols.tier = d.tier; }
    if (d.priority != null) { if (!PRIORITIES.includes(d.priority)) throw new TransitionError('bad priority', 400); cols.priority = d.priority; }
    if (d.depends_on != null) cols.depends_on = JSON.stringify(d.depends_on.map(Number));
    if (d.project_id != null || d.project != null) {
      const p = d.project_id ?? d.project;
      if (!this.project(p)) throw new TransitionError(`unknown project '${p}'`, 400);
      cols.project_id = p;
    }
    if (d.external_owner !== undefined) cols.external_owner = d.external_owner;
    if (cols.type || cols.tier) cols.reward = rewardFor(cols.type || b.type, cols.tier || b.tier);
    if (!Object.keys(cols).length) return this.get(id);
    cols.updated_at = now();
    this.db.prepare(`UPDATE bounties SET ${Object.keys(cols).map(k => `${k} = @${k}`).join(', ')} WHERE id = @__id`).run({ ...cols, __id: id });
    addEvent(this.db, { bounty_id: id, actor, kind: 'note', note: `edited: ${Object.keys(cols).filter(k => k !== 'updated_at').join(', ')}` });
    this.changed('bounty', { id });
    return this.get(id);
  }

  // ---------- orchestrator controls ----------
  requireOrchestrator(actor, what) {
    if (this.isWorker(actor)) throw new TransitionError(`${what} is an orchestrator action; workers (${actor}) can't do it`, 403);
  }

  assign(id, slotId, actor = 'orchestrator') {
    this.requireOrchestrator(actor, 'assign');
    const b = this.need(id);
    if (slotId && !this.slot(slotId)) throw new TransitionError(`unknown slot '${slotId}'`, 400);
    if (this.workerAlive(id)) throw new TransitionError(`bounty ${id} has a live worker; kill it first`, 409);
    this.db.prepare('UPDATE bounties SET assignee_slot = ?, updated_at = ? WHERE id = ?').run(slotId || null, now(), id);
    addEvent(this.db, { bounty_id: id, actor, kind: 'assign', note: `${b.assignee_slot || 'unassigned'} -> ${slotId || 'unassigned'}` });
    this.changed('bounty', { id });
    return this.get(id);
  }

  checkReadyable(b) {
    if (!b.project_id) throw new TransitionError('a bounty needs a project before it can be ready', 400);
    const p = this.project(b.project_id);
    if (!p || !p.repo) throw new TransitionError(`project '${b.project_id}' has no repo`, 400);
    const crit = Array.isArray(b.criteria) ? b.criteria : JSON.parse(b.criteria || '[]');
    if (!crit.length) throw new TransitionError('write the acceptance criteria before a bounty goes ready (bounty edit / the board UI)', 400);
  }

  ready(id, actor = 'orchestrator', note = null) {
    this.requireOrchestrator(actor, 'ready');
    const b = this.need(id);
    this.checkReadyable(b);
    if (this.workerAlive(id)) throw new TransitionError(`bounty ${id} has a live worker; kill it first`, 409);
    const r = transition(this.db, id, 'ready', { actor, note });
    this.changed('bounty', { id });
    return r;
  }

  backlog(id, actor = 'orchestrator', note = null) {
    this.requireOrchestrator(actor, 'backlog');
    if (this.workerAlive(id)) throw new TransitionError(`bounty ${id} has a live worker; kill it first`, 409);
    const r = transition(this.db, id, 'backlog', { actor, note });
    this.changed('bounty', { id });
    return r;
  }

  fail(id, reason, actor = 'orchestrator') {
    this.requireOrchestrator(actor, 'fail');
    const r = transition(this.db, id, 'failed', { actor, note: reason || 'failed by orchestrator' });
    this.changed('bounty', { id });
    return r;
  }

  approve(id, actor = 'orchestrator', notes = null) {
    this.requireOrchestrator(actor, 'approve');
    const b = this.need(id);
    if (b.status !== 'review') throw new TransitionError(`bounty ${id} is ${b.status}; approve works on review`, 409);
    const r = transition(this.db, id, 'approved', {
      actor, via: 'orchestrator', note: notes || 'approved by orchestrator',
      patch: { review_verdict: 'approve', review_state: 'done', review_notes: [b.review_notes, notes && `orchestrator: ${notes}`].filter(Boolean).join('\n\n') || null },
    });
    this.changed('bounty', { id });
    return r;
  }

  reject(id, notes, actor = 'orchestrator') {
    this.requireOrchestrator(actor, 'reject');
    const b = this.need(id);
    if (!['review', 'approved'].includes(b.status)) throw new TransitionError(`bounty ${id} is ${b.status}; reject works on review/approved`, 409);
    if (!notes) throw new TransitionError('reject needs notes for the next worker', 400);
    this.db.prepare('UPDATE bounties SET review_verdict = ?, review_notes = ?, review_state = ? WHERE id = ?')
      .run('reject', `orchestrator: ${notes}`, 'done', id);
    return this.requeue(id, `rejected by ${actor}: ${notes}`, actor);
  }

  // A failed attempt goes back to ready for a fresh worker, with escalation and a retry cap.
  requeue(id, reason, actor = 'board') {
    const b = this.need(id);
    const failures = (b.failures || 0) + 1;
    this.db.prepare('UPDATE bounties SET failures = ? WHERE id = ?').run(failures, id);
    const tries = Math.max(b.attempts || 0, failures);
    if (tries >= this.cfg.retry.max_attempts) {
      const r = transition(this.db, id, 'failed', { actor, note: `${reason}; attempt cap ${this.cfg.retry.max_attempts} reached` });
      this.changed('bounty', { id });
      return r;
    }
    let slotNote = '';
    const cur = this.slot(b.assignee_slot);
    if (cur && failures >= this.cfg.retry.escalate_after_failures) {
      const target = this.cfg.retry.escalate_model[cur.model];
      if (target) {
        const pick = this.leastBusySlot(s => s.model === target);
        if (pick) {
          this.db.prepare('UPDATE bounties SET assignee_slot = ? WHERE id = ?').run(pick.id, id);
          slotNote = `; escalated ${cur.id} (${cur.model}) -> ${pick.id} (${target}) after ${failures} failures`;
          addEvent(this.db, { bounty_id: id, actor, kind: 'assign', note: slotNote.slice(2) });
        }
      }
    }
    const r = transition(this.db, id, 'ready', { actor, note: reason + slotNote, patch: { ci_status: null, review_state: null } });
    this.changed('bounty', { id });
    return r;
  }

  leastBusySlot(pred) {
    const cands = this.cfg.slots.filter(pred);
    if (!cands.length) return null;
    const load = s => this.db.prepare("SELECT COUNT(*) c FROM bounties WHERE assignee_slot = ? AND status IN ('ready','in_progress')").get(s.id).c;
    return cands.map(s => ({ s, l: load(s) })).sort((a, b) => a.l - b.l)[0].s;
  }

  // ---------- orchestrator -> worker notes ----------
  // A note is an event of kind 'message' in the bounty history. The live worker reads unread
  // notes with `bounty inbox` (and gets them in the output of start/progress); every later
  // attempt gets all of them in its prompt.
  note(id, text, actor = 'orchestrator') {
    this.requireOrchestrator(actor, 'note');
    this.need(id);
    if (!text || !String(text).trim()) throw new TransitionError('note needs text', 400);
    const r = this.db.prepare(`INSERT INTO events (bounty_id, at, actor, kind, note) VALUES (?, ?, ?, 'message', ?)`)
      .run(id, now(), actor, String(text).trim());
    this.changed('bounty', { id });
    return this.db.prepare('SELECT * FROM events WHERE id = ?').get(Number(r.lastInsertRowid));
  }

  notes(id, { unread = false } = {}) {
    return this.db.prepare(`SELECT * FROM events WHERE bounty_id = ? AND kind = 'message' ${unread ? 'AND read_at IS NULL' : ''} ORDER BY id`).all(id);
  }

  // Unread notes, marked read by the reader.
  takeInbox(id, actor) {
    const rows = this.notes(id, { unread: true });
    if (rows.length) {
      const t = now();
      const mark = this.db.prepare('UPDATE events SET read_at = ?, read_by = ? WHERE id = ?');
      for (const e of rows) { mark.run(t, actor || null, e.id); e.read_at = t; e.read_by = actor || null; }
      this.changed('bounty', { id });
    }
    return rows;
  }

  // ---------- worker protocol ----------
  start(id, actor) {
    const b = this.need(id);
    if (this.isWorker(actor) && b.assignee_slot && b.assignee_slot !== actor) {
      throw new TransitionError(`bounty ${id} is assigned to ${b.assignee_slot}, not ${actor}`, 409);
    }
    const t = now();
    const patch = { heartbeat_at: t, claimed_by: actor || b.assignee_slot, claimed_at: t, progress: 0 };
    if (!b.assignee_slot && this.isWorker(actor)) patch.assignee_slot = actor;
    const r = transition(this.db, id, 'in_progress', { actor, note: 'started', patch });
    if (this.isWorker(actor)) {
      this.db.prepare("UPDATE agents SET status='active', current_directive=?, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(b.title, actor);
    }
    this.changed('bounty', { id });
    return r;
  }

  heartbeat(id) {
    this.db.prepare('UPDATE bounties SET heartbeat_at = ? WHERE id = ?').run(now(), id);
  }

  progress(id, note, actor, { check = [], percent = null } = {}) {
    const b = this.need(id);
    if (!['in_progress', 'blocked'].includes(b.status)) throw new TransitionError(`bounty ${id} is ${b.status}, not in progress`, 409);
    const criteria = b.criteria;
    for (const i of check) {
      const idx = Number(i) - 1;
      if (!criteria[idx]) throw new TransitionError(`no acceptance criterion #${i}`, 400);
      criteria[idx].done = true;
      if (note) criteria[idx].note = note;
    }
    const t = now();
    this.db.prepare('UPDATE bounties SET heartbeat_at = ?, updated_at = ?, criteria = ?, progress = COALESCE(?, progress) WHERE id = ?')
      .run(t, t, JSON.stringify(criteria), percent, id);
    addEvent(this.db, { bounty_id: id, actor, kind: 'progress', note: (check.length ? `[checked ${check.join(',')}] ` : '') + (note || '') });
    this.changed('bounty', { id });
    return this.get(id);
  }

  block(id, reason, actor) {
    if (!reason) throw new TransitionError('block needs a reason', 400);
    const r = transition(this.db, id, 'blocked', { actor, note: reason, patch: { blocked_reason: reason } });
    this.changed('bounty', { id });
    return r;
  }

  split(id, d, actor) {
    const parent = this.need(id);
    return this.create({
      ...d, project: d.project || parent.project_id, parent_id: id, status: 'backlog',
      type: d.type || parent.type, tier: d.tier || 'C', priority: d.priority || parent.priority,
    }, actor);
  }

  next(slotId) {
    const s = this.slot(slotId);
    if (!s) throw new TransitionError(`unknown slot '${slotId}'`, 400);
    return this.nextFor(s);
  }

  // The next bounty a slot would take: ready, assigned to it (or unassigned with autopilot),
  // every dependency done, no live worker.
  nextFor(s) {
    const rows = this.db.prepare(`SELECT b.* FROM bounties b WHERE b.status = 'ready'
        AND (b.assignee_slot = @slot ${s.autopilot ? 'OR b.assignee_slot IS NULL' : ''})
        ORDER BY (b.assignee_slot IS NULL), ${PRIORITY_ORDER}, ${TIER_ORDER}, b.id`).all({ slot: s.id });
    for (const b of rows) {
      hydrate(b);
      if (s.types && !s.types.includes(b.type)) continue;
      if (this.workerAlive(b.id)) continue;
      const deps = b.depends_on || [];
      if (deps.length) {
        const open = this.db.prepare(`SELECT COUNT(*) c FROM bounties WHERE id IN (${deps.map(() => '?').join(',')}) AND status != 'done'`).get(...deps).c;
        if (open) continue;
      }
      return b;
    }
    return null;
  }

  // ---------- submit gates ----------
  // Synchronous part: branch, real diff, not notes-only. Then verify runs in the background and,
  // on pass, the bounty moves to review and the reviewer picks it up.
  submit(id, { branch, actor } = {}) {
    const b = this.need(id);
    if (b.status !== 'in_progress') throw new TransitionError(`bounty ${id} is ${b.status}; submit works on in_progress`, 409);
    if (b.ci_status === 'running') throw new TransitionError(`bounty ${id} is already being verified`, 409);
    if (this.isWorker(actor) && b.assignee_slot && b.assignee_slot !== actor) throw new TransitionError(`bounty ${id} belongs to ${b.assignee_slot}`, 403);
    const p = this.project(b.project_id);
    if (!p || !p.repo) throw new TransitionError(`bounty ${id} has no project repo`, 400);
    const br = branch || b.branch;
    const fail = (msg, code = 422) => {
      addEvent(this.db, { bounty_id: id, actor, kind: 'verify', note: `submit refused: ${msg}` });
      this.changed('bounty', { id });
      throw new TransitionError(`submit refused: ${msg}`, code);
    };
    if (!br) fail('no branch; submit needs the branch with your commits');
    if (!gitx.branchExists(p.repo, br)) fail(`branch '${br}' does not exist in ${p.repo}`);
    if (!gitx.branchExists(p.repo, p.main_branch)) fail(`main branch '${p.main_branch}' missing in ${p.repo}`, 500);
    const files = gitx.changedFiles(p.repo, p.main_branch, br);
    if (files.length === 0) fail(`the diff of '${br}' against ${p.main_branch} is empty (commit your work)`);
    const commits = gitx.commitsAhead(p.repo, p.main_branch, br);
    if (commits.length === 0) fail(`'${br}' has no commits that ${p.main_branch} lacks`);
    if (gitx.notesOnly(files) && !(p.docs_only_types || []).includes(b.type)) {
      fail(`the diff only touches notes/logs (${files.slice(0, 5).join(', ')}${files.length > 5 ? ', ...' : ''}); a ${b.type} bounty needs real changes`);
    }
    const wt = b.worktree && fs.existsSync(b.worktree) ? b.worktree : null;
    this.db.prepare(`UPDATE bounties SET branch = ?, commits = ?, ci_status = 'running', ci_log = NULL, ci_at = ?, heartbeat_at = ?,
      review_state = NULL, review_verdict = NULL, progress = 100, updated_at = ? WHERE id = ?`)
      .run(br, JSON.stringify(commits), now(), now(), now(), id);
    addEvent(this.db, { bounty_id: id, actor, kind: 'verify', note: `submitted ${br}: ${commits.length} commit(s), ${files.length} file(s); verify queued` });
    this.verifyQueue.push({ id, dir: wt || p.repo, actor });
    this.changed('bounty', { id });
    setImmediate(() => this.pumpVerify());
    return { accepted: true, id, branch: br, commits, files: files.length, verify: p.verify_cmd || '(none configured)' };
  }

  async pumpVerify() {
    while (this.verifyRunning < this.cfg.verify_concurrency && this.verifyQueue.length) {
      const job = this.verifyQueue.shift();
      this.verifyRunning++;
      this.verifyActive.set(job.id, { id: job.id, started: now(), logPath: null });
      this.runVerify(job).catch(e => {
        addEvent(this.db, { bounty_id: job.id, actor: 'board', kind: 'verify', note: `verify crashed: ${e.message}` });
      }).finally(() => { this.verifyRunning--; this.verifyActive.delete(job.id); this.pumpVerify(); });
    }
  }

  async runVerify({ id, dir, actor }) {
    const b = this.need(id);
    const p = this.project(b.project_id);
    const logPath = path.join(this.cfg.logs_dir, `bounty-${id}-verify-${Date.now()}.log`);
    const act = this.verifyActive.get(id);
    if (act) act.logPath = logPath;
    let result;
    if (!p.verify_cmd) {
      fs.writeFileSync(logPath, '# project has no verify command; gate passes on the diff checks alone\n');
      result = { code: 0, tail: '', timedOut: false };
    } else {
      // Verify the committed branch tip, not whatever is uncommitted. Use the bounty's worktree
      // when it sits on the tip; otherwise a throwaway detached worktree of the tip.
      const br = gitx.revParse(p.repo, b.branch);
      const head = gitx.tryGit(dir, ['rev-parse', 'HEAD']);
      const dirty = gitx.tryGit(dir, ['status', '--porcelain', '--untracked-files=no']);
      let runDir = dir, tmp = null;
      if (!(head.ok && head.out.trim() === br && dirty.ok && !dirty.out.trim())) {
        tmp = path.join(this.cfg.logs_dir, `verify-wt-${id}-${Date.now()}`);
        const add = gitx.tryGit(p.repo, ['worktree', 'add', '--detach', tmp, br]);
        if (!add.ok) throw new Error(`could not create a verify worktree: ${add.out}`);
        runDir = tmp;
        fs.writeFileSync(logPath, `# verifying ${b.branch} @ ${br} in a detached worktree ${tmp} (the bounty worktree is not clean at the tip)\n`);
      }
      try {
        result = await gitx.runLogged(p.verify_cmd, runDir, logPath, p.verify_timeout_min || 90, { BOUNTY_ID: String(id) });
      } finally {
        if (tmp) gitx.tryGit(p.repo, ['worktree', 'remove', '--force', tmp]);
      }
    }
    if (!this.db.open) return;
    const cur = this.need(id);
    if (cur.status !== 'in_progress' || cur.ci_status !== 'running') return; // superseded (killed/blocked meanwhile)
    const pass = result.code === 0;
    const summary = pass ? 'verify passed' : `verify FAILED (exit ${result.code}${result.timedOut ? ', timed out' : ''})`;
    this.db.prepare('UPDATE bounties SET ci_status = ?, ci_log = ?, ci_at = ? WHERE id = ?').run(pass ? 'pass' : 'fail', logPath, now(), id);
    addEvent(this.db, { bounty_id: id, actor: 'board', kind: 'verify', note: `${summary}: ${p.verify_cmd || '(none)'}; log ${logPath}${pass ? '' : '\n' + String(result.tail).slice(-1500)}` });
    if (pass) {
      transition(this.db, id, 'review', { actor: 'board', via: 'gates', note: 'gates passed: branch, real diff, verify', patch: { review_state: 'pending' } });
      this.changed('bounty', { id });
      if (this.reviewer) setImmediate(() => this.reviewer.pump());
    } else if (this.workerAlive(id)) {
      // The worker is still here: it gets to fix and resubmit.
      this.changed('bounty', { id });
    } else {
      this.requeue(id, `verify failed after the worker exited (log ${logPath})`, 'board');
    }
  }

  // ---------- review results (from lib/reviewer.js) ----------
  applyReview(id, { verdict, notes }) {
    const b = this.need(id);
    if (b.status !== 'review') return b;
    if (verdict === 'approve') {
      const r = transition(this.db, id, 'approved', { actor: 'reviewer', via: 'reviewer', note: 'reviewer approved', patch: { review_state: 'done', review_verdict: 'approve', review_notes: notes } });
      this.changed('bounty', { id });
      return r;
    }
    this.db.prepare("UPDATE bounties SET review_state = 'done', review_verdict = 'reject', review_notes = ? WHERE id = ?").run(notes, id);
    return this.requeue(id, `reviewer rejected: ${String(notes).slice(0, 400)}`, 'reviewer');
  }

  // ---------- done: only when the work is on main ----------
  checkMerged(id, actor = 'merge-check') {
    const b = this.need(id);
    if (b.status !== 'approved') throw new TransitionError(`bounty ${id} is ${b.status}; only approved bounties can become done`, 409);
    const p = this.project(b.project_id);
    const res = gitx.mergedIntoMain(p.repo, p.main_branch, b.commits, b.branch);
    if (!res.merged) {
      return { done: false, reason: `not merged: ${res.reason}` };
    }
    const credit = this.creditFor(b, { via: 'merge-check' });
    const reward = this.rewardPreview(b, credit);
    transition(this.db, id, 'done', {
      actor, via: 'merge-check', note: `commits on ${p.main_branch} (${res.how}); ${credit ? `+$${reward} loot to ${credit.slot}` : 'no slot credited'}`,
      patch: { reward: credit ? reward : b.reward, completed_at: now(), verified_by: 'merge-check', verified_at: now(),
        credited_slot: credit ? credit.slot : null, credited_attempt: credit ? credit.attempt : null },
    });
    this.changed('bounty', { id });
    this.rebuildAgents();
    return { done: true, how: res.how, reward: credit ? reward : 0, credited: credit ? credit.slot : null };
  }

  // Work done off the board (an external bounty, or a branch the orchestrator merged itself):
  // the orchestrator names the commit(s) on main and the board checks them. No review/approve.
  closeMerged(id, { commits, evidence = '', actor = 'orchestrator' } = {}) {
    this.requireOrchestrator(actor, 'close-merged');
    const b = this.need(id);
    if (b.status === 'done') throw new TransitionError(`bounty ${id} is already done`, 409);
    if (b.status === 'failed') throw new TransitionError(`bounty ${id} is failed; move it back to ready first`, 409);
    if (this.workerAlive(id)) throw new TransitionError(`bounty ${id} has a live board worker; let it submit (or kill it) instead of close-merged`, 409);
    if (b.ci_status === 'running') throw new TransitionError(`bounty ${id} has a verify running; wait for it`, 409);
    const shas = [].concat(commits || []).map(c => String(c).trim()).filter(Boolean);
    if (shas.length === 0) throw new TransitionError('close-merged needs at least one --commit SHA', 400);
    const p = this.project(b.project_id);
    if (!p) throw new TransitionError(`bounty ${id} has no project`, 409);
    const full = [];
    for (const c of shas) {
      if (/^-/.test(c)) throw new TransitionError(`bad commit '${c}'`, 400);
      const sha = gitx.revParse(p.repo, c);
      if (!sha) throw new TransitionError(`commit ${c} does not exist in ${p.repo}`, 422);
      if (!gitx.tryGit(p.repo, ['merge-base', '--is-ancestor', sha, p.main_branch]).ok) {
        throw new TransitionError(`commit ${c} (${sha.slice(0, 10)}) is not on ${p.main_branch} in ${p.repo}; merge it first`, 409);
      }
      full.push(sha);
    }
    const commitsAll = [...new Set([...(b.commits || []), ...full])];
    // Credit only a slot whose board attempt submitted commits that are now on main; work done
    // off the board (no slot submit) credits nobody.
    const credit = this.creditFor(b, { via: 'close-merged', checkCommits: true });
    const reward = this.rewardPreview(b, credit);
    const ev = String(evidence || '').trim();
    const note = `close-merged by ${actor}: ${full.map(c => c.slice(0, 10)).join(' ')} on ${p.main_branch}; ${credit ? `+$${reward} loot to ${credit.slot}` : 'no slot credited (work done off the board)'}${ev ? `\nevidence: ${ev}` : ''}`;
    transition(this.db, id, 'done', {
      actor, via: 'close-merged', note,
      patch: { reward: credit ? reward : b.reward, commits: JSON.stringify(commitsAll), completed_at: now(), verified_by: `close-merged (${actor})`, verified_at: now(), work_evidence: ev || null,
        credited_slot: credit ? credit.slot : null, credited_attempt: credit ? credit.attempt : null },
    });
    this.changed('bounty', { id });
    this.rebuildAgents();
    return { done: true, how: 'close-merged', reward: credit ? reward : 0, credited: credit ? credit.slot : null, commits: full };
  }

  mergeSweep() {
    const rows = this.db.prepare("SELECT id FROM bounties WHERE status = 'approved'").all();
    const out = [];
    for (const { id } of rows) {
      try { out.push({ id, ...this.checkMerged(id) }); } catch (e) { out.push({ id, error: e.message }); }
    }
    return out;
  }

  // ---------- loot: derived from verified work only ----------
  // Nothing here trusts a stored counter. A slot earns a bounty's reward only when that bounty
  // reached done through the merge check or close-merged (commits on the project's main), and
  // only the slot whose attempt produced the work (credited_slot, set when it went done).
  // Every other finished worker attempt of a slot is a failure: it resets the streak and costs
  // half the bounty's base reward. Cost is the real $ from the slot's attempts. The legacy
  // (Feb-2026) project never counts. The agents table's counters are a cache rebuilt from this.

  // Which slot (and attempt) produced the work of bounty b, or null.
  // The producer is the slot that last submitted the bounty's branch (the submit event's actor);
  // its attempt is the one running at that submit. close-merged with checkCommits also needs the
  // commits that submit recorded to be on main, otherwise the merged work is not the slot's.
  creditFor(b, { via, checkCommits = false } = {}) {
    if (!b || b.project_id === 'legacy') return null;
    const subs = this.db.prepare(`SELECT actor, at FROM events WHERE bounty_id = ? AND kind = 'verify' AND note LIKE 'submitted %' ORDER BY id DESC`).all(b.id);
    const sub = subs.find(e => this.slot(e.actor));
    if (!sub) return null;
    if (via === 'close-merged' && checkCommits) {
      const p = this.project(b.project_id);
      if (!p || !(b.commits || []).length) return null;
      if (!gitx.mergedIntoMain(p.repo, p.main_branch, b.commits, b.branch).merged) return null;
    }
    const att = this.db.prepare(`SELECT id FROM attempts WHERE bounty_id = ? AND kind = 'worker' AND slot = ? AND started_at <= ?
      ORDER BY started_at DESC, id DESC LIMIT 1`).get(b.id, sub.actor, sub.at);
    return { slot: sub.actor, attempt: att ? att.id : null };
  }

  // The ledger: every slot's loot, dones, failures, streak and cost, replayed from history.
  ledger() {
    const ids = this.cfg.slots.map(s => s.id);
    const known = new Set(ids);
    const slots = new Map(ids.map(id => [id, {
      id, total_loot: 0, level: 1, missions_completed: 0, missions_failed: 0, streak: 0, best_streak: 0,
      cost_usd: 0, attempts: 0, tokens_in: 0, tokens_out: 0, last_done_at: null, dones: [],
    }]));
    const dones = this.db.prepare(`SELECT id, ticket_id, title, type, tier, failures, done_at, credited_slot, credited_attempt
      FROM bounties WHERE status = 'done' AND project_id != 'legacy' AND credited_slot IS NOT NULL
        AND (verified_by = 'merge-check' OR verified_by LIKE 'close-merged%') AND commits IS NOT NULL AND commits != '[]'`).all();
    const credited = new Set(dones.filter(d => d.credited_attempt).map(d => d.credited_attempt));
    const atts = this.db.prepare(`SELECT a.id, a.bounty_id, a.slot, a.started_at, a.ended_at, a.cost_usd, a.tokens_in, a.tokens_out,
        b.status AS bstatus, b.type, b.tier
      FROM attempts a JOIN bounties b ON b.id = a.bounty_id
      WHERE a.kind = 'worker' AND (b.project_id IS NULL OR b.project_id != 'legacy') ORDER BY a.id`).all();
    const latest = new Map();
    for (const a of atts) latest.set(a.bounty_id, a.id);
    const failAt = this.db.prepare(`SELECT at FROM events WHERE bounty_id = ? AND kind = 'status'
      AND to_status IN ('ready', 'blocked', 'failed', 'backlog', 'done') AND at >= ? ORDER BY id LIMIT 1`);
    const timeline = [];
    const othersOn = new Map(); // bounty -> attempts that are not its credited one
    for (const a of atts) {
      if (!known.has(a.slot)) continue;
      const s = slots.get(a.slot);
      s.attempts++; s.cost_usd += a.cost_usd || 0; s.tokens_in += a.tokens_in || 0; s.tokens_out += a.tokens_out || 0;
      if (credited.has(a.id)) continue;
      othersOn.set(a.bounty_id, (othersOn.get(a.bounty_id) || 0) + 1);
      if (!a.ended_at) continue;                                        // still running
      if (['in_progress', 'review', 'approved'].includes(a.bstatus) && latest.get(a.bounty_id) === a.id) continue; // its submit is still in the gates/review
      // A failure dates from when the board gave up on it (requeue/block/fail), not from the exit.
      const ev = failAt.get(a.bounty_id, a.started_at);
      const at = ev && ev.at > a.ended_at ? ev.at : a.ended_at;
      timeline.push({ at, kind: 'fail', slot: a.slot, base: rewardFor(a.type, a.tier), bounty_id: a.bounty_id, attempt: a.id });
    }
    for (const d of dones) {
      if (!known.has(d.credited_slot)) continue;
      timeline.push({ at: d.done_at, kind: 'done', slot: d.credited_slot, base: rewardFor(d.type, d.tier), bounty: d });
    }
    timeline.sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : x.kind === y.kind ? 0 : x.kind === 'fail' ? -1 : 1));
    const earned = {};
    for (const e of timeline) {
      const s = slots.get(e.slot);
      if (e.kind === 'fail') {
        s.total_loot = Math.max(0, s.total_loot - Math.floor(e.base * BONUSES.BOTCH_PENALTY));
        s.missions_failed++; s.streak = 0;
      } else {
        const firstTry = !(e.bounty.failures > 0) && !othersOn.get(e.bounty.id);
        const reward = lootFor(e.base, firstTry, s.streak);
        s.total_loot += reward; s.missions_completed++; s.streak++; s.best_streak = Math.max(s.best_streak, s.streak);
        s.last_done_at = e.at;
        earned[e.bounty.id] = reward;
        s.dones.push({ id: e.bounty.id, ticket_id: e.bounty.ticket_id, title: e.bounty.title, reward, first_try: firstTry, done_at: e.at });
      }
    }
    for (const s of slots.values()) { s.level = levelFor(s.total_loot); s.cost_usd = Math.round(s.cost_usd * 10000) / 10000; }
    return { slots: [...slots.values()], earned };
  }

  slotStats(id) { return this.ledger().slots.find(s => s.id === id) || null; }

  // The reward a slot gets for b going done now (its streak so far, first try or not).
  rewardPreview(b, credit) {
    const base = rewardFor(b.type, b.tier);
    if (!credit) return 0;
    const s = this.slotStats(credit.slot);
    const others = this.db.prepare("SELECT COUNT(*) c FROM attempts WHERE bounty_id = ? AND kind = 'worker' AND id IS NOT ?").get(b.id, credit.attempt).c;
    return lootFor(base, !(b.failures > 0) && others === 0, s ? s.streak : 0);
  }

  // Rebuild the agents table's counters (a cache for old readers) from the ledger.
  rebuildAgents() {
    if (!this.db.open) return null;
    const led = this.ledger();
    const up = this.db.prepare(`UPDATE agents SET total_loot = @total_loot, level = @level, missions_completed = @missions_completed,
      missions_failed = @missions_failed, streak = @streak, cost_usd = @cost_usd WHERE id = @id`);
    this.db.transaction(() => { for (const s of led.slots) up.run(s); })();
    return led;
  }

  scheduleRebuild() {
    if (this._rebuildPending) return;
    this._rebuildPending = true;
    setImmediate(() => { this._rebuildPending = false; try { this.rebuildAgents(); } catch (e) { console.error('[ledger]', e.message); } });
  }

  // ---------- leases (GPU etc.) ----------
  // Board leases live in the leases table. An "external" lease (config external_leases) is a
  // view of a lock something else owns, e.g. the machine-wide UE render flock: the board reads
  // its state and holder file and tells workers how to take it; it never runs a second lock.
  external(resource) { return (this.cfg.external_leases || {})[resource] || null; }

  externalStatus(resource) {
    const e = this.external(resource);
    if (!e) return null;
    const out = { resource, external: true, what: e.what, how: e.how, script: e.script, lock_file: e.lock_file, held: false, holder: null };
    if (e.lock_file && fs.existsSync(e.lock_file)) {
      const r = spawnSync('flock', ['-n', e.lock_file, 'true'], { timeout: 3000 });
      out.held = r.status !== 0;
    }
    const cands = [].concat(e.holder_file || [], e.lock_file ? [e.lock_file + '.holder', e.lock_file.replace(/\.lock$/, '.holder'), e.lock_file.replace(/\.lock$/, '.holder.json')] : []);
    for (const f of cands) {
      let raw; try { raw = fs.readFileSync(f, 'utf8'); } catch { continue; }
      if (!raw.trim()) continue;
      let h = null;
      try { h = JSON.parse(raw); } catch {
        h = {};
        for (const line of raw.split('\n')) { const m = line.match(/^\s*([\w.-]+)\s*[=:]\s*(.*)$/); if (m) h[m[1].toLowerCase()] = m[2].trim(); }
        if (!Object.keys(h).length) h = { text: raw.trim() };
      }
      const pid = Number(h.pid || 0);
      out.holder = { ...h, file: f, pid_alive: pid ? require('./dispatcher').pidAlive(pid) : null };
      break;
    }
    if (!out.held) out.holder_stale = !!out.holder; // a holder file without the flock is stale
    return out;
  }

  externalsFor(projectId) {
    return Object.entries(this.cfg.external_leases || {})
      .filter(([, e]) => !e.projects || e.projects.includes(projectId)).map(([k, e]) => ({ resource: k, ...e }));
  }

  listLeases() {
    const rows = this.db.prepare('SELECT * FROM leases ORDER BY resource').all();
    for (const k of Object.keys(this.cfg.external_leases || {})) rows.push(this.externalStatus(k));
    return rows;
  }

  acquireLease(resource, { bounty_id = null, slot = null, holder = null, ttl_min = null, note = null } = {}) {
    if (this.external(resource)) {
      const st = this.externalStatus(resource);
      if (bounty_id) addEvent(this.db, { bounty_id, actor: slot || holder, kind: 'lease', note: `asked for '${resource}' (external lock, ${st.held ? 'held' : 'free'}); pointed at ${st.script}` });
      return { granted: false, external: true, ...st };
    }
    this.expireLeases();
    const cur = this.db.prepare('SELECT * FROM leases WHERE resource = ?').get(resource);
    const ttl = Number(ttl_min || this.cfg.leases.default_ttl_minutes);
    const t = new Date();
    const exp = new Date(t.getTime() + ttl * 60000).toISOString();
    const who = holder || (bounty_id ? `bounty-${bounty_id}` : slot || 'orchestrator');
    if (cur && cur.holder !== who) {
      return { granted: false, lease: cur };
    }
    this.db.prepare(`INSERT INTO leases (resource, bounty_id, slot, holder, acquired_at, expires_at, note) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(resource) DO UPDATE SET expires_at = excluded.expires_at, note = COALESCE(excluded.note, leases.note)`)
      .run(resource, bounty_id, slot, who, t.toISOString(), exp, note);
    if (!cur) addEvent(this.db, { bounty_id, actor: slot || who, kind: 'lease', note: `took lease '${resource}' (ttl ${ttl} min)` });
    this.changed('lease', { resource });
    return { granted: true, renewed: !!cur, lease: this.db.prepare('SELECT * FROM leases WHERE resource = ?').get(resource) };
  }

  releaseLease(resource, { holder = null, bounty_id = null, force = false, reason = 'released' } = {}) {
    if (this.external(resource)) return { released: false, external: true, ...this.externalStatus(resource) };
    const cur = this.db.prepare('SELECT * FROM leases WHERE resource = ?').get(resource);
    if (!cur) return { released: false, reason: 'not held' };
    const who = holder || (bounty_id ? `bounty-${bounty_id}` : null);
    if (!force && who && cur.holder !== who) throw new TransitionError(`lease '${resource}' is held by ${cur.holder}, not ${who}`, 409);
    this.db.prepare('DELETE FROM leases WHERE resource = ?').run(resource);
    addEvent(this.db, { bounty_id: cur.bounty_id, actor: who || 'orchestrator', kind: 'lease', note: `lease '${resource}' ${reason}` });
    this.changed('lease', { resource });
    return { released: true, lease: cur };
  }

  // A lease ends when its TTL passes, or when its holder is a bounty whose worker is gone and
  // that is no longer in progress.
  expireLeases() {
    const out = [];
    for (const l of this.db.prepare('SELECT * FROM leases').all()) {
      let why = null;
      if (new Date(l.expires_at).getTime() < Date.now()) why = 'expired (ttl)';
      else if (l.bounty_id) {
        const b = this.raw(l.bounty_id);
        const hadWorker = this.dispatcher && this.dispatcher.hadWorker(l.bounty_id);
        if (!b || (b.status !== 'in_progress' && !this.workerAlive(l.bounty_id))) why = 'expired (holder bounty no longer in progress)';
        else if (hadWorker && !this.workerAlive(l.bounty_id)) why = 'expired (holder worker died)';
      }
      if (why) { this.releaseLease(l.resource, { force: true, reason: why }); out.push({ resource: l.resource, why }); }
    }
    return out;
  }

  // ---------- pause switch ----------
  paused() { return dbm.getMeta(this.db, 'paused', '0') === '1'; }
  setPaused(v, actor = 'orchestrator') {
    this.requireOrchestrator(actor, v ? 'pause' : 'resume');
    dbm.setMeta(this.db, 'paused', v ? '1' : '0');
    addEvent(this.db, { actor, kind: 'note', note: v ? 'dispatcher paused' : 'dispatcher resumed' });
    this.changed('pause', { paused: v });
    return { paused: v };
  }
}

function levelFor(loot) { return Math.max(1, Math.floor(Math.sqrt(loot / 250)) + 1); }

// Loot for one verified done: base reward, x1.25 on the first try, x(1 + 0.1 per streak) capped at x2.
function lootFor(base, firstTry, streak) {
  let r = base;
  if (firstTry) r = Math.floor(r * BONUSES.FIRST_TRY_MULT);
  return Math.floor(r * Math.min(1 + (streak || 0) * BONUSES.STREAK_MULT, BONUSES.STREAK_CAP));
}

function normCriteria(c) {
  if (!c) return [];
  if (typeof c === 'string') c = c.split('\n').map(s => s.replace(/^\s*-\s*(\[[ xX]\]\s*)?/, '').trim()).filter(Boolean);
  return c.map(x => (typeof x === 'string' ? { text: x, done: false } : { text: String(x.text), done: !!x.done, note: x.note || undefined }));
}

module.exports = { Board, TIER_REWARDS, TIER_NAMES, BONUSES, rewardFor, levelFor, lootFor, TransitionError, normCriteria };
