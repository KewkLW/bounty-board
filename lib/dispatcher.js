// The dispatcher: gives every slot its next ready bounty, spawns one fresh worker per bounty
// in the project's worktree, records cost/usage per attempt, and runs the watchdog, the lease
// expiry and the merge check.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { now, addEvent } = require('./db');
const { transition } = require('./machine');
const { workerPrompt } = require('./prompt');
const gitx = require('./git');

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); } catch { return false; }
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3);
    return state !== 'Z' && state !== 'X';
  } catch { return true; }
}

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 36).replace(/-+$/, '') || 'task';
}

function fill(tpl, vars) { return String(tpl).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m)); }

// Usage/cost from a worker log. Claude stream-json ends with a `result` event that carries the
// exact cost; codex --json reports tokens per turn (subscription; no $ figure).
function parseUsage(logPath, runner) {
  const u = { cost_usd: null, tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0 };
  let text;
  try { text = fs.readFileSync(logPath, 'utf8'); } catch { return u; }
  const seen = new Set();
  let result = null;
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue;
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    if (runner === 'claude' || ev.type === 'result' || ev.type === 'assistant') {
      if (ev.type === 'result') result = ev;
      else if (ev.type === 'assistant' && ev.message && ev.message.usage && !seen.has(ev.message.id)) {
        seen.add(ev.message.id);
        const mu = ev.message.usage;
        u.tokens_in += mu.input_tokens || 0; u.tokens_out += mu.output_tokens || 0;
        u.cache_read += mu.cache_read_input_tokens || 0; u.cache_write += mu.cache_creation_input_tokens || 0;
      }
    }
    if (ev.type === 'turn.completed' && ev.usage) {
      u.tokens_in += ev.usage.input_tokens || 0; u.tokens_out += ev.usage.output_tokens || 0;
      u.cache_read += ev.usage.cached_input_tokens || 0;
    }
  }
  if (result) {
    if (typeof result.total_cost_usd === 'number') u.cost_usd = result.total_cost_usd;
    const ru = result.usage || {};
    if (ru.input_tokens != null) {
      u.tokens_in = ru.input_tokens || 0; u.tokens_out = ru.output_tokens || 0;
      u.cache_read = ru.cache_read_input_tokens || 0; u.cache_write = ru.cache_creation_input_tokens || 0;
    }
  }
  return u;
}

class Dispatcher {
  constructor(board) {
    this.board = board;
    this.cfg = board.cfg;
    this.db = board.db;
    this.live = new Map(); // bountyId -> { attemptId, slot, pid, child, logPath, adopted, runner }
    this.spawning = new Set(); // slot ids mid-spawn
    this.spawningBounties = new Set();
    this.timers = [];
    board.dispatcher = this;
  }

  start() {
    this.adopt();
    const every = (sec, fn) => { const t = setInterval(() => { try { fn(); } catch (e) { console.error('[dispatcher]', e); } }, sec * 1000); t.unref?.(); this.timers.push(t); };
    every(this.cfg.tick_seconds, () => this.tick());
    every(this.cfg.watchdog.check_seconds, () => this.watchdog());
    every(this.cfg.merge_check_seconds, () => this.board.mergeSweep());
    setImmediate(() => this.tick());
  }

  stop() { this.stopped = true; for (const t of this.timers) clearInterval(t); this.timers = []; }

  isAlive(bountyId) { const w = this.live.get(Number(bountyId)); return !!w && pidAlive(w.pid); }
  hadWorker(bountyId) { return !!this.db.prepare("SELECT 1 FROM attempts WHERE bounty_id = ? AND kind = 'worker'").get(bountyId); }
  slotWorker(slotId) { for (const [bid, w] of this.live) if (w.slot === slotId) return { bountyId: bid, ...w }; return null; }
  running() { return this.live.size + this.spawning.size; }

  // Re-attach to workers that outlived a server restart (the unit uses KillMode=process).
  adopt() {
    const rows = this.db.prepare("SELECT * FROM attempts WHERE ended_at IS NULL AND kind = 'worker'").all();
    for (const a of rows) {
      if (pidAlive(a.pid)) {
        this.live.set(a.bounty_id, { attemptId: a.id, slot: a.slot, pid: a.pid, child: null, logPath: a.log_path, adopted: true, runner: a.runner });
        addEvent(this.db, { bounty_id: a.bounty_id, actor: 'dispatcher', kind: 'note', note: `re-attached to live worker pid ${a.pid} after a board restart` });
      } else {
        this.live.set(a.bounty_id, { attemptId: a.id, slot: a.slot, pid: a.pid, child: null, logPath: a.log_path, adopted: true, runner: a.runner });
        this.onExit(a.bounty_id, null, 'worker was gone after a board restart');
      }
    }
  }

  slotsState() {
    return this.cfg.slots.map(s => {
      const w = this.slotWorker(s.id);
      let bounty = null, attempt = null, usage = null;
      if (w) {
        bounty = this.db.prepare('SELECT id, ticket_id, title, status, ci_status, heartbeat_at, cost_usd FROM bounties WHERE id = ?').get(w.bountyId);
        attempt = this.db.prepare('SELECT id, started_at, log_path, model, pid FROM attempts WHERE id = ?').get(w.attemptId);
        usage = parseUsageCached(this, w);
      }
      const next = this.board.nextFor(s);
      const queued = this.db.prepare("SELECT COUNT(*) c FROM bounties WHERE assignee_slot = ? AND status = 'ready'").get(s.id).c;
      return {
        ...s, state: w ? 'working' : this.spawning.has(s.id) ? 'spawning' : 'idle', bounty, attempt, usage,
        next: next ? { id: next.id, title: next.title } : null, queued,
      };
    });
  }

  tick() {
    if (this.stopped || !this.db.open) return;
    // notice adopted workers that ended
    for (const [bid, w] of this.live) {
      if (!w.child && !pidAlive(w.pid)) this.onExit(bid, null, 'worker process ended');
    }
    if (this.board.paused()) return;
    for (const s of this.cfg.slots) {
      if (this.running() >= this.cfg.concurrency_cap) break;
      if (this.slotWorker(s.id) || this.spawning.has(s.id)) continue;
      const b = this.board.nextFor(s);
      if (!b || this.spawningBounties.has(b.id)) continue;
      this.spawning.add(s.id);
      this.spawningBounties.add(b.id);
      this.spawn(s, b).catch(e => {
        console.error('[dispatcher] spawn failed', e);
        try { transition(this.db, b.id, 'blocked', { actor: 'dispatcher', note: `spawn failed: ${e.message}` }); } catch {}
        this.board.changed('bounty', { id: b.id });
      }).finally(() => { this.spawning.delete(s.id); this.spawningBounties.delete(b.id); });
    }
  }

  async ensureWorktree(b, p, logFd) {
    if (b.worktree && fs.existsSync(b.worktree) && b.branch && gitx.branchExists(p.repo, b.branch)) {
      return { worktree: b.worktree, branch: b.branch, created: false };
    }
    const task = b.branch || `b${b.id}-${slug(b.title)}`;
    const wtPath = p.worktree_path ? fill(p.worktree_path, { task, branch: task })
      : path.join(path.dirname(p.repo), `${path.basename(p.repo)}-wt`, task);
    if (fs.existsSync(wtPath) && gitx.branchExists(p.repo, task)) return { worktree: wtPath, branch: task, created: false };
    const cmd = fill(p.worktree_cmd || 'git worktree add {path} -b {branch} {main}', { task, branch: task, path: wtPath, main: p.main_branch });
    fs.writeSync(logFd, `# board: creating worktree: (cd ${p.repo} && ${cmd})\n`);
    const code = await new Promise(resolve => {
      const c = spawn('bash', ['-lc', cmd], { cwd: p.repo, stdio: ['ignore', logFd, logFd] });
      c.on('error', () => resolve(-1));
      c.on('close', resolve);
    });
    if (code !== 0 || !fs.existsSync(wtPath)) throw new Error(`worktree command failed (exit ${code}): ${cmd}`);
    if (!gitx.branchExists(p.repo, task)) throw new Error(`worktree command did not create branch ${task}`);
    return { worktree: wtPath, branch: task, created: true };
  }

  buildCommand(slot, worktree) {
    const r = this.cfg.runners[slot.runner] || {};
    if (slot.runner === 'claude') {
      const args = ['-p', '--output-format', 'stream-json', '--verbose'];
      if (slot.model) args.push('--model', slot.model);
      if (slot.effort) args.push('--effort', slot.effort);
      args.push('--allowedTools', slot.allowed_tools || r.allowed_tools || 'Bash,Read,Grep,Glob,Edit,Write');
      for (const d of slot.add_dirs || r.add_dirs || []) args.push('--add-dir', d);
      return { bin: slot.bin || r.bin || 'claude', args };
    }
    if (slot.runner === 'codex') {
      const args = ['exec', '--json', ...(r.args || []), '-C', worktree];
      if (slot.model) args.push('-m', slot.model);
      if (slot.effort) args.push('-c', `model_reasoning_effort="${slot.effort}"`);
      args.push('-');
      return { bin: slot.bin || r.bin || 'codex', args };
    }
    if (slot.runner === 'command') {
      const [bin, ...args] = slot.cmd;
      return { bin, args };
    }
    throw new Error(`unknown runner '${slot.runner}'`);
  }

  async spawn(slot, b0) {
    if (this.stopped) return;
    const b = this.board.need(b0.id);
    const p = this.board.project(b.project_id);
    if (!p) throw new Error(`bounty ${b.id} has no project`);
    const attemptNo = (b.attempts || 0) + 1;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const logPath = path.join(this.cfg.logs_dir, `bounty-${b.id}-attempt-${attemptNo}-${slot.id}-${stamp}.log`);
    const promptPath = logPath.replace(/\.log$/, '.prompt.md');
    const logFd = fs.openSync(logPath, 'a');
    let wt;
    try {
      wt = await this.ensureWorktree(b, p, logFd);
    } catch (e) {
      fs.closeSync(logFd);
      transition(this.db, b.id, 'blocked', { actor: 'dispatcher', note: `${e.message} (log ${logPath})` });
      this.board.changed('bounty', { id: b.id });
      return;
    }
    // Re-check after the await: still ready, still ours, not paused.
    const fresh = this.board.raw(b.id);
    if (fresh.status !== 'ready' || this.board.paused()) { fs.closeSync(logFd); return; }
    this.db.prepare('UPDATE bounties SET worktree = ?, branch = ?, attempts = ?, assignee_slot = COALESCE(assignee_slot, ?), updated_at = ? WHERE id = ?')
      .run(wt.worktree, wt.branch, attemptNo, slot.id, now(), b.id);
    const prompt = workerPrompt(this.board, { ...b, attempts: attemptNo }, slot, wt);
    fs.writeFileSync(promptPath, prompt);
    const { bin, args } = this.buildCommand(slot, wt.worktree);
    fs.writeSync(logFd, `# board: spawn ${bin} ${args.map(a => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')} < ${promptPath}\n# cwd ${wt.worktree}\n`);
    const env = { ...process.env, BOUNTY_ID: String(b.id), BOUNTY_SLOT: slot.id, BOUNTY_ATTEMPT: String(attemptNo),
      BOUNTY_URL: `http://127.0.0.1:${this.cfg.port}`, PATH: `${this.cfg.bin_dir}:${process.env.PATH}` };
    delete env.CLAUDECODE; delete env.CLAUDE_CODE_ENTRYPOINT;
    const inFd = fs.openSync(promptPath, 'r');
    const child = spawn(bin, args, { cwd: wt.worktree, env, stdio: [inFd, logFd, logFd], detached: true });
    fs.closeSync(inFd); fs.closeSync(logFd);
    const attempt = this.db.prepare(`INSERT INTO attempts (bounty_id, slot, runner, model, effort, pid, started_at, log_path, prompt_path, kind)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'worker')`).run(b.id, slot.id, slot.runner, slot.model || null, slot.effort || null, child.pid || null, now(), logPath, promptPath);
    const attemptId = Number(attempt.lastInsertRowid);
    this.live.set(b.id, { attemptId, slot: slot.id, pid: child.pid, child, logPath, adopted: false, runner: slot.runner });
    child.on('error', err => {
      fs.appendFileSync(logPath, `\n# board: spawn error: ${err.message}\n`);
    });
    child.on('exit', (code, sig) => this.onExit(b.id, code == null ? (sig ? 128 : null) : code, sig ? `signal ${sig}` : null));
    this.db.prepare("UPDATE agents SET status='active', current_directive=?, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(b.title, slot.id);
    addEvent(this.db, { bounty_id: b.id, actor: 'dispatcher', kind: 'spawn',
      note: `attempt ${attemptNo}: ${slot.id} (${slot.runner}${slot.model ? ' ' + slot.model : ''}${slot.effort ? ', effort ' + slot.effort : ''}) pid ${child.pid} in ${wt.worktree} on ${wt.branch}${wt.created ? ' (new worktree)' : ''}; log ${logPath}` });
    this.board.changed('bounty', { id: b.id });
  }

  onExit(bountyId, code, why = null) {
    if (this.stopped || !this.db.open) return;
    const w = this.live.get(bountyId);
    if (!w) return;
    this.live.delete(bountyId);
    const usage = parseUsage(w.logPath, w.runner);
    this.db.prepare(`UPDATE attempts SET ended_at = ?, exit_code = ?, cost_usd = ?, tokens_in = ?, tokens_out = ?, cache_read = ?, cache_write = ? WHERE id = ?`)
      .run(now(), code, usage.cost_usd, usage.tokens_in, usage.tokens_out, usage.cache_read, usage.cache_write, w.attemptId);
    this.db.prepare('UPDATE bounties SET cost_usd = cost_usd + ?, tokens_in = tokens_in + ?, tokens_out = tokens_out + ? WHERE id = ?')
      .run(usage.cost_usd || 0, usage.tokens_in, usage.tokens_out, bountyId);
    this.db.prepare("UPDATE agents SET status='idle', current_directive=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(w.slot);
    const b = this.board.raw(bountyId);
    let outcome = b ? b.status : 'gone';
    const tag = `worker ${w.slot} (pid ${w.pid}) exited${code != null ? ` with code ${code}` : ''}${why ? ` (${why})` : ''}`;
    addEvent(this.db, { bounty_id: bountyId, actor: 'dispatcher', kind: 'exit',
      note: `${tag}; cost ${usage.cost_usd != null ? '$' + usage.cost_usd.toFixed(4) : 'n/a'}, tokens in ${usage.tokens_in} out ${usage.tokens_out} cache-read ${usage.cache_read}; log ${w.logPath}` });
    if (b) {
      try {
        if (b.status === 'in_progress' && b.ci_status !== 'running') {
          this.db.prepare('UPDATE bounties SET failures = failures + 1 WHERE id = ?').run(bountyId);
          this.board.penalize(w.slot, b);
          transition(this.db, bountyId, 'blocked', { actor: 'watchdog', note: `${tag} without submitting; log ${w.logPath}` });
          outcome = 'blocked (exited without submit)';
        } else if (b.status === 'ready') {
          this.db.prepare('UPDATE bounties SET failures = failures + 1 WHERE id = ?').run(bountyId);
          transition(this.db, bountyId, 'blocked', { actor: 'watchdog', note: `${tag} without running 'bounty start'; log ${w.logPath}` });
          outcome = 'blocked (never started)';
        } else if (b.status === 'in_progress') outcome = 'submitted (verifying)';
      } catch (e) { console.error('[dispatcher] onExit', e.message); }
    }
    this.db.prepare('UPDATE attempts SET outcome = ? WHERE id = ?').run(outcome, w.attemptId);
    this.board.expireLeases();
    this.board.changed('bounty', { id: bountyId });
    setImmediate(() => this.tick());
  }

  kill(bountyId, reason, actor = 'orchestrator') {
    const w = this.live.get(Number(bountyId));
    if (!w) return { killed: false, reason: 'no live worker' };
    const b = this.board.raw(bountyId);
    if (b && b.status === 'in_progress') {
      try {
        this.db.prepare('UPDATE bounties SET ci_status = CASE WHEN ci_status = \'running\' THEN NULL ELSE ci_status END WHERE id = ?').run(bountyId);
        transition(this.db, bountyId, 'blocked', { actor, note: `${reason}; log ${w.logPath}` });
      } catch {}
    }
    this.signal(w.pid);
    this.board.changed('bounty', { id: bountyId });
    return { killed: true, pid: w.pid };
  }

  signal(pid) {
    try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch {} }
    setTimeout(() => {
      if (pidAlive(pid)) { try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch {} } }
    }, this.cfg.watchdog.kill_grace_seconds * 1000).unref?.();
  }

  lastActivity(bountyId, w) {
    const b = this.board.raw(bountyId);
    const times = [];
    if (b && b.heartbeat_at) times.push(Date.parse(b.heartbeat_at));
    const a = this.db.prepare('SELECT started_at FROM attempts WHERE id = ?').get(w.attemptId);
    if (a) times.push(Date.parse(a.started_at));
    try { times.push(fs.statSync(w.logPath).mtimeMs); } catch {}
    return Math.max(...times);
  }

  watchdog() {
    const stallMs = this.cfg.watchdog.stall_minutes * 60000;
    for (const [bid, w] of [...this.live]) {
      if (!pidAlive(w.pid)) { if (!w.child) this.onExit(bid, null, 'worker process died'); continue; }
      const b = this.board.raw(bid);
      if (b && b.ci_status === 'running') continue; // the board is verifying; the worker may wait on it
      const idle = Date.now() - this.lastActivity(bid, w);
      if (idle > stallMs) {
        const mins = Math.round(idle / 60000);
        if (b && ['in_progress', 'ready'].includes(b.status)) {
          this.db.prepare('UPDATE bounties SET failures = failures + 1 WHERE id = ?').run(bid);
          this.board.penalize(w.slot, b);
          try { transition(this.db, bid, 'blocked', { actor: 'watchdog', note: `watchdog: no heartbeat or progress for ${mins} min; worker ${w.slot} pid ${w.pid} killed; log ${w.logPath}` }); } catch {}
        }
        addEvent(this.db, { bounty_id: bid, actor: 'watchdog', kind: 'note', note: `killing stalled worker pid ${w.pid} (${mins} min silent)` });
        this.signal(w.pid);
        this.board.changed('bounty', { id: bid });
      }
    }
    // In-progress bounties driven by the CLI outside the dispatcher: heartbeat only.
    const rows = this.db.prepare("SELECT * FROM bounties WHERE status = 'in_progress' AND heartbeat_at IS NOT NULL AND (ci_status IS NULL OR ci_status != 'running')").all();
    for (const b of rows) {
      if (this.live.has(b.id)) continue;
      const idle = Date.now() - Date.parse(b.heartbeat_at);
      if (idle > stallMs) {
        transition(this.db, b.id, 'blocked', { actor: 'watchdog', note: `watchdog: no heartbeat for ${Math.round(idle / 60000)} min (${b.claimed_by || 'unknown worker'}, not spawned by the board)` });
        this.board.changed('bounty', { id: b.id });
      }
    }
    this.board.expireLeases();
  }
}

// Live token counts for the dashboard, re-read at most every 20 s per worker.
function parseUsageCached(d, w) {
  const t = Date.now();
  if (w.child !== undefined) {
    const cur = d.live.get(w.bountyId);
    if (cur && cur._usageAt && t - cur._usageAt < 20000) return cur._usage;
    const u = parseUsage(w.logPath, w.runner);
    if (cur) { cur._usage = u; cur._usageAt = t; }
    return u;
  }
  return null;
}

module.exports = { Dispatcher, parseUsage, pidAlive, slug };
