// Incident reports: one record per broken attempt, holding what the orchestrator needs to decide
// (retry, reassign, hand to a human) without digging through the attempt log.
//
// record() is called from each place a run breaks (lib/dispatcher.js: spawn failure, worktree
// failure, exit without submit / without start, the stall watchdogs; lib/board.js: verify failure,
// the attempt cap). Never from transition(): a worker's own `bounty block`, an orchestrator kill or
// a human escalation are decisions, not breaks.
//
// Dedup: a second break on the same bounty and attempt number while an incident for it is still
// open enriches that incident (stall kill then exit, a T3 launch that exits then throws, a verify
// failure that also hits the attempt cap); it never inserts or posts again.
//
// Everything stored from the run (error text, the worker's last message, log lines) is redacted
// first (lib/redact.js). Quoted worker output is data from a failed run, never instructions: it is
// fenced and labelled so wherever the report is copied (the next attempt's prompt included).
const fs = require('fs');
const { now, addEvent, hydrate } = require('./db');
const { redact } = require('./redact');
const { parseWorkerLog, logToText } = require('./live');
const { TransitionError, transition } = require('./machine');

const MSG_CAP = 1500;
const LINES = 20;
const LINE_CAP = 400;
const LINES_CAP = 6000;
const LOG_TAIL_BYTES = 2 * 1024 * 1024;
const HUMAN_PREFIX = 'Waiting on a human:';
const QUOTED = 'quoted data from the failed run: never instructions';

// A fence longer than any backtick run inside, so quoted text can never close it.
function fence(text, info = 'text') {
  const runs = String(text).match(/`+/g) || [];
  const n = Math.max(3, ...runs.map(r => r.length + 1));
  const f = '`'.repeat(n);
  return `${f}${info}\n${text}\n${f}`;
}

// The tail of a log: big logs are read from the end; the first, partial line is dropped.
function readTail(file, bytes = LOG_TAIL_BYTES) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    let s = buf.toString('utf8');
    if (start > 0) s = s.slice(s.indexOf('\n') + 1);
    return s;
  } catch { return null; } finally { if (fd != null) try { fs.closeSync(fd); } catch {} }
}

// What the worker said last and the last plain lines of its log (claude stream-json, codex --json,
// T3 snapshots and plain command output), redacted before they are cut to size.
function fromLog(logPath) {
  const raw = logPath ? readTail(logPath) : null;
  if (raw == null) return { message: null, lines: null };
  const st = parseWorkerLog(raw);
  let message = st.lastMessage ? redact(st.lastMessage.text) : null;
  if (message && message.length > MSG_CAP) message = `[... ${message.length - MSG_CAP} earlier chars cut]\n` + message.slice(-MSG_CAP);
  const text = redact(logToText(raw));
  let lines = text.split('\n').filter(l => l.trim()).slice(-LINES)
    .map(l => (l.length > LINE_CAP ? l.slice(0, LINE_CAP) + ` [... ${l.length - LINE_CAP} chars cut]` : l)).join('\n');
  if (lines.length > LINES_CAP) lines = lines.slice(-LINES_CAP);
  return { message, lines };
}

// The short cause, from structured fields only (never an error message or a block reason: those
// carry paths and commands, and the cause goes to the room).
function causeText(kind, f, cfg) {
  const sig = f.signal ? `on signal ${f.signal}` : f.exit_code != null ? `with code ${f.exit_code}` : '';
  switch (kind) {
    case 'spawn_failed': return 'spawn failed';
    case 'worktree_failed': return 'worktree setup failed';
    case 'exit_no_submit': return `exited ${sig ? sig + ' ' : ''}without submitting`;
    case 'verify_failed_exit': return `verify failed, then the worker exited ${sig ? sig + ' ' : ''}without resubmitting`;
    case 'never_started': return `exited ${sig ? sig + ' ' : ''}without running bounty start`;
    case 'exit': return `exited ${sig || ''}`.trim();
    case 'stalled': return `stalled ${f.stall_minutes} min, worker stopped`;
    case 'stalled_cli': return `no heartbeat for ${f.stall_minutes} min (not spawned by the board)`;
    case 'verify_failed': return `verify failed (exit ${f.exit_code}${f.timed_out ? ', timed out' : ''}) after the worker exited`;
    case 'attempt_cap': return `attempt cap ${cfg.retry.max_attempts} reached, bounty failed`;
    default: return kind;
  }
}

class Incidents {
  constructor(board) {
    this.board = board;
    this.db = board.db;
    this.cfg = board.cfg;
  }

  row(id) {
    const r = this.db.prepare('SELECT * FROM incidents WHERE id = ?').get(Number(id));
    if (r) { try { r.detail = JSON.parse(r.detail || '{}'); } catch { r.detail = {}; } }
    return r || null;
  }
  need(id) {
    const r = this.row(id);
    if (!r) throw new TransitionError(`incident ${id} not found`, 404);
    return r;
  }
  forAttempt(attemptId) {
    if (!attemptId) return null;
    const r = this.db.prepare('SELECT id FROM incidents WHERE attempt_id = ? ORDER BY id DESC LIMIT 1').get(attemptId);
    return r ? this.row(r.id) : null;
  }
  openCount() { return this.db.prepare("SELECT COUNT(*) c FROM incidents WHERE status = 'open'").get().c; }
  openFor(bountyId) { return this.db.prepare("SELECT id FROM incidents WHERE bounty_id = ? AND status = 'open' ORDER BY id").all(bountyId).map(r => this.row(r.id)); }

  // One record per broken attempt. Returns { incident, created }.
  record({ bounty, kind, attemptId = null, attemptNo = null, slot = null, worker = null, exitCode = null, signal = null,
    stallMinutes = null, timedOut = false, error = null, logPath = null, verifyLog = null, verifyTail = null } = {}) {
    const b = this.board.raw(bounty);
    if (!b) return { incident: null, created: false };
    const a = attemptId ? this.db.prepare('SELECT * FROM attempts WHERE id = ?').get(attemptId) : null;
    if (attemptNo == null) attemptNo = b.attempts || 0;
    slot = slot || (a && a.slot) || null;
    const s = slot ? this.board.slot(slot) : null;
    worker = worker || (s && (s.name || s.id)) || slot || b.claimed_by || 'unknown worker';
    logPath = logPath || (a && a.log_path) || null;
    const f = { exit_code: exitCode, signal, stall_minutes: stallMinutes, timed_out: !!timedOut };
    const cause = causeText(kind, f, this.cfg);
    const fields = { kind, ...f };
    if (error) fields.error = redact(String(error)).slice(0, 2000);
    if (verifyLog) fields.verify_log = verifyLog;
    if (verifyTail) fields.verify_tail = redact(String(verifyTail)).slice(-MSG_CAP);

    const open = this.db.prepare("SELECT id FROM incidents WHERE bounty_id = ? AND attempt_no = ? AND status = 'open' ORDER BY id DESC LIMIT 1").get(bounty, attemptNo);
    if (open) {
      const cur = this.row(open.id);
      const detail = cur.detail || {};
      detail.also = [...(detail.also || []), { ...fields, at: now() }].slice(-5);
      const patch = {
        cause: cur.cause.includes(cause) || detail.also.length > 4 ? cur.cause : redact(`${cur.cause}; then ${cause}`),
        attempt_id: cur.attempt_id || attemptId, slot: cur.slot || slot, log_path: cur.log_path || logPath,
        detail: JSON.stringify(detail), updated_at: now(),
      };
      this.db.prepare('UPDATE incidents SET cause=@cause, attempt_id=@attempt_id, slot=@slot, log_path=@log_path, detail=@detail, updated_at=@updated_at WHERE id=@id')
        .run({ ...patch, id: cur.id });
      this.refresh(cur.id);
      return { incident: this.row(cur.id), created: false };
    }
    const t = now();
    const r = this.db.prepare(`INSERT INTO incidents (bounty_id, attempt_no, attempt_id, slot, worker, cause, cause_kind, detail, log_path, created_at, updated_at, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`).run(bounty, attemptNo, attemptId, slot, redact(worker), redact(cause), kind, JSON.stringify(fields), logPath, t, t);
    const id = Number(r.lastInsertRowid);
    this.refresh(id);
    addEvent(this.db, { bounty_id: bounty, actor: 'board', kind: 'incident', note: `incident #${id}: ${cause} (attempt ${attemptNo}, ${worker}); bounty incident ${id}` });
    const inc = this.row(id);
    this.announce(inc);
    this.board.emit('incident', inc);
    this.board.changed('incident', { id, bounty });
    return { incident: inc, created: true };
  }

  // Re-read the log and the bounty into the stored report (after a merge the log has more to say).
  refresh(id) {
    const inc = this.row(id);
    if (!inc) return;
    this.db.prepare('UPDATE incidents SET report = ? WHERE id = ?').run(this.body(inc), id);
  }

  // The report body: everything needed to decide, redacted. The "Next" section is added when it
  // is shown (it depends on the bounty's status then, and the next worker's prompt leaves it out).
  body(inc) {
    const b = hydrate(this.board.raw(inc.bounty_id)) || { id: inc.bounty_id, title: '(bounty gone)', criteria: [] };
    const a = inc.attempt_id ? this.db.prepare('SELECT * FROM attempts WHERE id = ?').get(inc.attempt_id) : null;
    const s = inc.slot ? this.board.slot(inc.slot) : null;
    const d = inc.detail || {};
    const L = [];
    L.push(`**Incident #${inc.id}: bounty #${b.id} ${b.ticket_id || ''} "${b.title}"**`.replace('  ', ' '));
    L.push('');
    L.push(`- Bounty: #${b.id} "${b.title}" (project ${b.project_id || '-'}), status now ${b.status || '-'}${b.blocked_reason ? `: ${b.blocked_reason}` : ''}`);
    L.push(`- Worker: ${inc.worker}${inc.slot ? ` (slot ${inc.slot}${s ? `, runner ${s.runner}${s.model ? ', model ' + s.model : ''}` : ''})` : ' (no board slot)'}`);
    L.push(`- Attempt: ${inc.attempt_no} of ${this.cfg.retry.max_attempts} (failures so far: ${b.failures || 0})`);
    L.push(`- Cause: ${inc.cause}`);
    const facts = [];
    if (d.exit_code != null) facts.push(`exit code ${d.exit_code}`);
    if (d.signal) facts.push(`signal ${d.signal}`);
    if (d.stall_minutes != null) facts.push(`silent ${d.stall_minutes} min (stall limit ${this.cfg.watchdog.stall_minutes} min)`);
    for (const x of d.also || []) {
      if (x.exit_code != null && !facts.includes(`exit code ${x.exit_code}`)) facts.push(`then exit code ${x.exit_code}`);
      if (x.signal) facts.push(`then signal ${x.signal}`);
    }
    if (facts.length) L.push(`- Details: ${facts.join(', ')}`);
    const errs = [d.error, ...(d.also || []).map(x => x.error)].filter(Boolean);
    for (const e of errs) L.push(`- Error (${d.kind === 'worktree_failed' ? 'worktree' : 'spawn'}): ${e.split('\n')[0].slice(0, 600)}`);
    if (a) L.push(`- Attempt record: ${a.started_at} -> ${a.ended_at || 'still running'}, exit ${a.exit_code ?? '-'}${a.thread_id ? `, T3 thread ${a.thread_id}` : a.pid ? `, pid ${a.pid}` : ''}`);
    L.push(`- Log: ${inc.log_path || '(none: no board-spawned process)'}`);
    if (d.verify_log) L.push(`- Verify log: ${d.verify_log}`);
    L.push(`- Created: ${inc.created_at}`);

    const prog = this.db.prepare("SELECT at, actor, note FROM events WHERE bounty_id = ? AND kind = 'progress' ORDER BY id DESC LIMIT 1").get(inc.bounty_id);
    L.push('', '### Last progress note');
    L.push(prog ? `${prog.at} (${prog.actor || '?'}): ${redact(String(prog.note || '')).slice(0, 600)}` : '(none: the worker never reported progress)');
    L.push('', '### Acceptance criteria checks');
    const crit = b.criteria || [];
    if (!crit.length) L.push('(none)');
    crit.forEach((c, i) => L.push(`${i + 1}. [${c.done ? 'x' : ' '}] ${c.text}${c.note ? ` (worker's note: ${redact(String(c.note)).slice(0, 300)})` : ''}`));

    if (d.verify_tail) {
      L.push('', `### Verify output, last lines (${QUOTED})`, fence(d.verify_tail));
    }
    const { message, lines } = fromLog(inc.log_path);
    L.push('', `### The worker's last assistant message (${QUOTED})`);
    L.push(message ? fence(message) : '(none found in the log)');
    L.push('', `### Last ${LINES} log lines (${QUOTED})`);
    L.push(lines ? fence(lines) : '(no log)');
    return redact(L.join('\n'));
  }

  next(inc) {
    const b = this.board.raw(inc.bounty_id);
    const slots = this.cfg.slots.map(s => `${s.id} ${s.name}`).join(', ') || 'none configured';
    const capped = b && b.status === 'failed';
    return [
      '### Next (pick one)',
      `- Retry on the same slot: \`bounty retry ${inc.bounty_id}\` (optionally \`--note "what to do differently"\`)${capped ? `. Refused while the bounty is failed at the attempt cap; \`bounty ready ${inc.bounty_id}\` overrides the cap` : ''}`,
      `- Reassign to another slot: \`bounty retry ${inc.bounty_id} --slot SLOT\` (slots: ${slots})`,
      `- Hand to a human: \`bounty incident ${inc.id} --human "what the human must do"\` (blocks the bounty as "${HUMAN_PREFIX} ...", shown in the hub's Needs you list)`,
    ].join('\n');
  }

  // The full report as shown by `bounty incident ID` and GET /api/incidents/:id.
  render(inc) {
    const head = inc.status === 'open' ? `Status: OPEN since ${inc.created_at}`
      : `Status: resolved ${inc.resolved_at} by ${inc.resolved_by}: ${inc.choice}${inc.resolution ? ` (${inc.resolution})` : ''}`;
    return [inc.report || this.body(inc), '', head, '', this.next(inc)].join('\n');
  }

  view(inc, { full = false } = {}) {
    if (!inc) return null;
    const b = this.board.raw(inc.bounty_id);
    const out = {
      id: inc.id, bounty_id: inc.bounty_id, bounty_title: b ? b.title : null, bounty_status: b ? b.status : null,
      attempt: inc.attempt_no, attempt_id: inc.attempt_id, max_attempts: this.cfg.retry.max_attempts, failures: b ? b.failures : null,
      slot: inc.slot, worker: inc.worker, cause: inc.cause, cause_kind: inc.cause_kind, log_path: inc.log_path,
      created_at: inc.created_at, updated_at: inc.updated_at, age_seconds: Math.max(0, Math.round((Date.now() - Date.parse(inc.created_at)) / 1000)),
      status: inc.status, choice: inc.choice || null, resolution: inc.resolution || null, resolved_by: inc.resolved_by || null, resolved_at: inc.resolved_at || null,
    };
    if (full) { out.detail = inc.detail; out.report = this.render(inc); }
    return out;
  }

  list({ all = false, after = null, bounty = null } = {}) {
    let sql = 'SELECT id FROM incidents WHERE 1=1';
    const p = [];
    if (!all) sql += " AND status = 'open'";
    if (after != null) { sql += ' AND id > ?'; p.push(Number(after)); }
    if (bounty != null) { sql += ' AND bounty_id = ?'; p.push(Number(bounty)); }
    sql += ' ORDER BY id';
    return this.db.prepare(sql).all(...p).map(r => this.view(this.row(r.id)));
  }

  // The report the next attempt's worker gets: the latest incident of the attempt before it (or of
  // this attempt number when it broke before its process started).
  forPrompt(b, attemptNo) {
    const r = this.db.prepare(`SELECT id FROM incidents WHERE bounty_id = ? AND (attempt_no = ? OR (attempt_no = ? AND attempt_id IS NULL))
      ORDER BY id DESC LIMIT 1`).get(b.id, attemptNo - 1, attemptNo);
    if (!r) return null;
    const inc = this.row(r.id);
    return { incident: inc, text: inc.report || this.body(inc) };
  }

  resolve(ids, { choice, text = null, by }) {
    const t = now();
    const st = this.db.prepare("UPDATE incidents SET status = 'resolved', choice = ?, resolution = ?, resolved_by = ?, resolved_at = ?, updated_at = ? WHERE id = ? AND status = 'open'");
    const done = [];
    for (const id of ids) if (st.run(choice, text ? redact(String(text)).slice(0, 2000) : null, by, t, t, id).changes) done.push(id);
    for (const id of done) {
      const inc = this.row(id);
      addEvent(this.db, { bounty_id: inc.bounty_id, actor: by, kind: 'incident', note: `incident #${id} resolved by ${by}: ${choice}${text ? ` (${String(text).slice(0, 300)})` : ''}` });
      this.board.changed('incident', { id, bounty: inc.bounty_id });
    }
    return done;
  }

  // Who decided: the name the CLI sends (its $AGENT_NAME), else the online orchestrator, else the actor.
  who(actor, by) {
    if (by && String(by).trim()) return String(by).trim().slice(0, 80);
    try { const o = this.board.presence.status(); if (o.online && o.name) return o.name; } catch {}
    return actor || 'orchestrator';
  }

  // Decision 1 and 2: retry (same slot, or --slot SLOT) through the board's own requeue path.
  retry(bountyId, { note = null, slot = null, actor = 'orchestrator', by = null } = {}) {
    this.board.requireOrchestrator(actor, 'retry');
    const b = this.board.need(bountyId);
    if (slot && !this.board.slot(slot)) throw new TransitionError(`unknown slot '${slot}' (${this.cfg.slots.map(s => s.id).join(', ')})`, 400);
    if (this.board.workerAlive(bountyId)) throw new TransitionError(`bounty ${bountyId} still has a live worker (it is being stopped); retry once it is gone`, 409);
    if (b.status === 'failed') {
      throw new TransitionError(`bounty ${bountyId} is failed: the attempt cap (${this.cfg.retry.max_attempts}) is reached. Hand it to a human (bounty incident ID --human "...") or override the cap with bounty ready ${bountyId}`, 409);
    }
    if (!['blocked', 'ready'].includes(b.status)) throw new TransitionError(`bounty ${bountyId} is ${b.status}; retry works on a blocked bounty (or one the board already requeued)`, 409);
    const open = this.openFor(bountyId);
    const who = this.who(actor, by);
    const choice = slot ? `reassign to ${slot}` : 'retry';
    this.resolve(open.map(i => i.id), { choice, text: note, by: who });
    if (note && String(note).trim()) this.board.note(bountyId, `Retry after a broken attempt: ${String(note).trim()}`, actor);
    const why = `${choice} by ${who}${open.length ? ` (incident ${open.map(i => '#' + i.id).join(', ')})` : ''}`;
    if (b.status === 'blocked') {
      // The break already counted its failure; the cap and escalation still apply.
      this.board.requeue(bountyId, why, actor, { countFailure: false, slot });
    } else if (slot) {
      this.board.assign(bountyId, slot, actor);
    } else {
      addEvent(this.db, { bounty_id: bountyId, actor, kind: 'note', note: `${why}; the board had already requeued it` });
    }
    const cur = this.board.raw(bountyId);
    this.board.changed('bounty', { id: bountyId });
    return { bounty: { id: bountyId, status: cur.status, assignee_slot: cur.assignee_slot, attempts: cur.attempts, failures: cur.failures }, resolved: open.map(i => i.id), choice };
  }

  // Decision 3: hand the bounty to a human. The block reason starts with "Waiting on a human:",
  // one of the hub's human markers, so the bounty shows in the hub's Needs you list.
  human(id, { text, actor = 'orchestrator', by = null } = {}) {
    this.board.requireOrchestrator(actor, 'incident --human');
    const inc = this.need(id);
    const body = typeof text === 'string' ? text.trim() : '';
    if (!body) throw new TransitionError('--human needs the text the human should read (what they must do or decide)', 400);
    const b = this.board.need(inc.bounty_id);
    if (this.board.workerAlive(b.id)) throw new TransitionError(`bounty ${b.id} has a live worker; kill it first`, 409);
    if (['done', 'approved', 'review', 'in_progress'].includes(b.status)) throw new TransitionError(`bounty ${b.id} is ${b.status}; it is not waiting on this incident any more`, 409);
    const who = this.who(actor, by);
    const reason = `${HUMAN_PREFIX} ${body.slice(0, 1000)} (incident #${inc.id}: ${inc.cause})`;
    transition(this.db, b.id, 'blocked', { actor, note: reason, patch: { blocked_reason: reason } });
    const open = this.openFor(b.id).map(i => i.id);
    if (!open.includes(inc.id)) open.unshift(inc.id);
    this.resolve(open, { choice: 'hand to a human', text: body, by: who });
    this.board.changed('bounty', { id: b.id });
    return { incident: this.view(this.row(inc.id)), bounty: { id: b.id, status: 'blocked', blocked_reason: reason }, resolved: open };
  }

  // One short line per incident to the orchestrator in the project's room: no log paths, no worker text.
  announce(inc) {
    const room = this.board.room;
    if (!room || !room.enabled) return null;
    return room.incident({ id: inc.id, bounty: inc.bounty_id, worker: inc.worker, cause: inc.cause });
  }
}

module.exports = { Incidents, fence, causeText, fromLog, HUMAN_PREFIX };
