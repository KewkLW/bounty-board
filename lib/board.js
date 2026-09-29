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
    this.seedSlots();
  }

  // ---------- helpers ----------
  slot(id) { return this.cfg.slots.find(s => s.id === id) || null; }
  isWorker(actor) { return !!this.slot(actor); }
  changed(kind, data = {}) { this.emit('changed', { kind, ...data }); }
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
    const ins = this.db.prepare(`INSERT OR IGNORE INTO agents (id, name, class, level, status) VALUES (?, ?, ?, 1, 'idle')`);
    for (const s of this.cfg.slots) {
      const cls = SLOT_CLASS[s.model] || SLOT_CLASS[s.runner] || 'Scavenger';
      ins.run(s.id, s.id.toUpperCase(), cls);
    }
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

  stats() {
    const s = this.db.prepare(`SELECT COUNT(*) total,
      ${dbm.STATUSES.map(st => `SUM(CASE WHEN status='${st}' THEN 1 ELSE 0 END) AS ${st}`).join(', ')},
      SUM(CASE WHEN type='bug' AND status NOT IN ('done','failed') AND priority IN ('critical','high') THEN 1 ELSE 0 END) critical_bugs,
      SUM(CASE WHEN status='done' THEN reward ELSE 0 END) total_loot_earned,
      ROUND(SUM(cost_usd), 2) total_cost_usd
      FROM bounties`).get();
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
    const project_id = d.project || d.project_id || null;
    if (project_id && !this.project(project_id)) throw new TransitionError(`unknown project '${project_id}'`, 400);
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
    this.penalize(b.claimed_by || b.assignee_slot, b);
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
      this.runVerify(job).catch(e => {
        addEvent(this.db, { bounty_id: job.id, actor: 'board', kind: 'verify', note: `verify crashed: ${e.message}` });
      }).finally(() => { this.verifyRunning--; this.pumpVerify(); });
    }
  }

  async runVerify({ id, dir, actor }) {
    const b = this.need(id);
    const p = this.project(b.project_id);
    const logPath = path.join(this.cfg.logs_dir, `bounty-${id}-verify-${Date.now()}.log`);
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
    const reward = this.award(b);
    transition(this.db, id, 'done', {
      actor, via: 'merge-check', note: `commits on ${p.main_branch} (${res.how}); +$${reward} loot to ${b.claimed_by || '?'}`,
      patch: { reward, completed_at: now(), verified_by: 'merge-check', verified_at: now() },
    });
    this.changed('bounty', { id });
    return { done: true, how: res.how, reward };
  }

  mergeSweep() {
    const rows = this.db.prepare("SELECT id FROM bounties WHERE status = 'approved'").all();
    const out = [];
    for (const { id } of rows) {
      try { out.push({ id, ...this.checkMerged(id) }); } catch (e) { out.push({ id, error: e.message }); }
    }
    return out;
  }

  // ---------- loot ----------
  award(b) {
    let reward = rewardFor(b.type, b.tier);
    if ((b.failures || 0) === 0) reward = Math.floor(reward * BONUSES.FIRST_TRY_MULT);
    const agent = b.claimed_by && this.db.prepare('SELECT * FROM agents WHERE id = ?').get(b.claimed_by);
    if (agent) {
      reward = Math.floor(reward * Math.min(1 + agent.streak * BONUSES.STREAK_MULT, BONUSES.STREAK_CAP));
      const loot = agent.total_loot + reward;
      this.db.prepare(`UPDATE agents SET total_loot = ?, level = ?, missions_completed = missions_completed + 1, streak = streak + 1,
        updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(loot, levelFor(loot), agent.id);
    }
    return reward;
  }

  penalize(agentId, b) {
    if (!agentId) return;
    const agent = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId);
    if (!agent) return;
    const pen = Math.floor(rewardFor(b.type, b.tier) * BONUSES.BOTCH_PENALTY);
    const loot = Math.max(0, agent.total_loot - pen);
    this.db.prepare(`UPDATE agents SET total_loot = ?, level = ?, missions_failed = missions_failed + 1, streak = 0,
      updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(loot, levelFor(loot), agentId);
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

function normCriteria(c) {
  if (!c) return [];
  if (typeof c === 'string') c = c.split('\n').map(s => s.replace(/^\s*-\s*(\[[ xX]\]\s*)?/, '').trim()).filter(Boolean);
  return c.map(x => (typeof x === 'string' ? { text: x, done: false } : { text: String(x.text), done: !!x.done, note: x.note || undefined }));
}

module.exports = { Board, TIER_REWARDS, TIER_NAMES, BONUSES, rewardFor, TransitionError, normCriteria };
