// Orchestrator presence: who orchestrates this board, and is it running right now.
//
// The orchestrator registers itself (`bounty orchestrator register`, or `bounty agents register
// --kind orchestrator`): its pid and that pid's start time go in the agent manifest
// (run/agents.json) and in run/orchestrator.json, which survives the process so the board can say
// who was there and when it was last seen. One orchestrator per board: a new registration replaces
// the previous one, which is never signalled.
//
// Online is computed from the pid alone, on every read: the pid runs and its start time is the
// recorded one. A dead pid, or a pid that now belongs to another process, is offline at once.
// The board's own name for its orchestrator (board.json "orchestrator") is only the expected name.
const fs = require('fs');
const path = require('path');
const { addEvent } = require('./db');
const { sameProcess } = require('./proc');

const PENDING = ['ready', 'in_progress', 'blocked'];
const SEEN_WRITE_MS = 15000; // while online, last_seen is persisted at most this often

class Presence {
  constructor(board) {
    this.board = board;
    this.cfg = board.cfg;
    this.file = path.join(board.agents.dir, 'orchestrator.json');
    this.lastKey = null;
    this.lastWarning = null;
    this.listeners = [];
  }

  expectedName() {
    const n = this.cfg.orchestrator;
    return typeof n === 'string' && n.trim() ? n.trim() : null;
  }

  read() {
    try { const j = JSON.parse(fs.readFileSync(this.file, 'utf8')); return j && j.pid ? j : null; } catch { return null; }
  }
  write(rec) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(rec, null, 2) + '\n');
    fs.renameSync(tmp, this.file);
  }

  // Register the orchestrator (the default name is board.json "orchestrator").
  register({ pid, name, by = null } = {}) {
    name = (name && String(name).trim()) || this.expectedName();
    this.board.agents.register({ pid, name, kind: 'orchestrator', by });
    return this.status();
  }

  // Called by the manifest when an orchestrator entry is written (any route).
  recorded(e) {
    const prev = this.read();
    const now = new Date().toISOString();
    this.write({ name: e.name, pid: e.pid, start_time: e.start_time, since: e.registered_at || now, last_seen: now, by: e.by || null });
    const was = prev && prev.pid !== e.pid ? `; replaces '${prev.name}' (pid ${prev.pid}${sameProcess(prev.pid, prev.start_time) ? ', still running, not signalled' : ', offline'})` : '';
    addEvent(this.board.db, { actor: e.by || 'orchestrator', kind: 'note', note: `orchestrator '${e.name}' registered, pid ${e.pid}${was}` });
    this.status();
  }

  // The newest live orchestrator entry in the manifest (one per board, but a manifest written
  // before presence existed may hold several).
  liveEntry() {
    return this.board.agents.read()
      .filter(e => e.kind === 'orchestrator' && sameProcess(e.pid, e.start_time))
      .sort((a, b) => String(b.registered_at || '').localeCompare(String(a.registered_at || '')))[0] || null;
  }

  pending() {
    const q = `SELECT COUNT(*) c FROM bounties WHERE status IN (${PENDING.map(() => '?').join(',')})`;
    return this.board.db.prepare(q).get(...PENDING).c;
  }

  // {name, expected_name, online, pid, since, last_seen} plus start_time, registered, required,
  // pending and warning. since: when it came online (registered), or when it was last seen alive
  // once offline. Re-checked on every call.
  status() {
    let rec = this.read();
    const live = this.liveEntry();
    // A live manifest entry the record does not know (a manifest from before presence existed) is
    // adopted unless the recorded orchestrator itself still runs (it is the newer registration).
    if (live && !(rec && rec.pid === live.pid && rec.start_time === live.start_time) && !(rec && sameProcess(rec.pid, rec.start_time))) {
      const now = new Date().toISOString();
      rec = { name: live.name, pid: live.pid, start_time: live.start_time, since: live.registered_at || now, last_seen: now, by: live.by || null };
      this.write(rec);
    }
    const now = Date.now();
    const online = !!rec && sameProcess(rec.pid, rec.start_time);
    if (online && now - Date.parse(rec.last_seen || 0) > SEEN_WRITE_MS) { rec.last_seen = new Date(now).toISOString(); this.write(rec); }
    const pending = this.pending();
    const s = {
      name: rec ? rec.name : null,
      expected_name: this.expectedName(),
      online,
      pid: rec ? rec.pid : null,
      since: rec ? (online ? rec.since : rec.last_seen) : null,
      last_seen: rec ? (online ? new Date(now).toISOString() : rec.last_seen) : null,
      start_time: rec ? rec.start_time : null,
      registered: !!rec,
      required: !!this.cfg.require_orchestrator,
      pending,
      warning: null,
    };
    if (!online && pending > 0) {
      const work = `${pending} ${pending === 1 ? 'bounty is' : 'bounties are'} ready, in progress or blocked`;
      s.warning = rec ? `orchestrator '${rec.name}' is offline (pid ${rec.pid} gone since ${rec.last_seen}) and ${work}`
        : `no orchestrator registered and ${work}; the orchestrator runs \`bounty orchestrator register\``;
    }
    this.transition(s);
    return s;
  }

  // State changes (registered, online, offline, a new pid) reach the WebSocket and the registry.
  transition(s) {
    const key = `${s.registered}:${s.online}:${s.pid}:${s.name}`;
    if (this.lastKey !== null && key !== this.lastKey) {
      this.board.changed('orchestrator', { online: s.online, name: s.name });
      if (this.lastKey.split(':')[1] === 'true' && !s.online) {
        addEvent(this.board.db, { actor: 'board', kind: 'note', note: `orchestrator '${s.name}' (pid ${s.pid}) is offline: its process is gone` });
      }
    }
    const changed = key !== this.lastKey;
    this.lastKey = key;
    if (s.warning && this.lastWarning === null && this.started) console.warn(`[orchestrator] WARNING: ${s.warning}`);
    this.lastWarning = s.warning;
    if (changed) for (const fn of this.listeners) { try { fn(s); } catch (e) { console.error('[orchestrator]', e.message); } }
  }

  onChange(fn) { this.listeners.push(fn); }

  // Board startup: a clear warning when work is waiting and nobody orchestrates it.
  startupCheck(log = console.warn) {
    const s = this.status();
    this.started = true;
    if (s.warning) log(`[orchestrator] WARNING: ${s.warning}`);
    return s;
  }
}

module.exports = { Presence, PENDING };
