// The agent manifest: <board dir>/run/agents.json lists every process the board is responsible
// for (its own workers, plus agents an orchestrator registered by hand), and the one place that
// stops them. A process is only ever signalled when it is in the manifest AND its start time
// still matches the recorded one, so a reused pid (or anyone's own terminal session) is never hit.
//
// Lifecycle:
//   - a bounty reaches done or failed -> its worker and every agent registered with --bounty for
//     it are stopped (SIGTERM, then SIGKILL after stop_grace_seconds); orchestrators never are;
//   - the board has had nothing in in_progress/review/approved for idle_shutdown_minutes (paused
//     counts as idle) -> every non-orchestrator entry is stopped, however recently registered;
//   - `bounty cleanup` lists them all (dry run) and stops the stale ones with --kill.
// Entries are dropped once their process is gone (or its pid now belongs to someone else).
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { addEvent } = require('./db');

const KINDS = ['worker', 'orchestrator', 'bridge'];
const ACTIVE = ['in_progress', 'review', 'approved'];
const TERMINAL = ['done', 'failed'];

let clkTck = null;
function ticksPerSecond() {
  if (clkTck == null) {
    const r = spawnSync('getconf', ['CLK_TCK'], { encoding: 'utf8' });
    clkTck = Number(String(r.stdout || '').trim()) || 100;
  }
  return clkTck;
}
let bootMs = null;
function bootTime() {
  if (bootMs == null) {
    try { bootMs = Number(fs.readFileSync('/proc/stat', 'utf8').match(/^btime (\d+)/m)[1]) * 1000; } catch { bootMs = 0; }
  }
  return bootMs;
}

// /proc/<pid>/stat: comm may hold spaces and parens, so split after the last ')'.
function procStat(pid) {
  let s;
  try { s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); } catch { return null; }
  const f = s.slice(s.lastIndexOf(')') + 2).split(' ');
  const state = f[0];
  if (state === 'Z' || state === 'X') return null;
  return { pid: Number(pid), state, ppid: Number(f[1]), pgrp: Number(f[2]), start_time: Number(f[19]) };
}

function rssKb(pid) {
  try { const m = fs.readFileSync(`/proc/${pid}/status`, 'utf8').match(/^VmRSS:\s+(\d+)/m); return m ? Number(m[1]) : 0; } catch { return 0; }
}

// RSS of a process and all its descendants (an agent's tool shells, MCP servers, ...).
function treeRssKb(root) {
  const kids = new Map();
  let names = [];
  try { names = fs.readdirSync('/proc').filter(n => /^\d+$/.test(n)); } catch {}
  for (const n of names) {
    const st = procStat(n);
    if (!st) continue;
    if (!kids.has(st.ppid)) kids.set(st.ppid, []);
    kids.get(st.ppid).push(st.pid);
  }
  let total = 0;
  const todo = [root], seen = new Set();
  while (todo.length) {
    const p = todo.pop();
    if (seen.has(p)) continue;
    seen.add(p);
    total += rssKb(p);
    for (const c of kids.get(p) || []) todo.push(c);
  }
  return total;
}

class Agents {
  constructor(board) {
    this.board = board;
    this.cfg = board.cfg;
    this.dir = this.cfg.run_dir || path.join(path.dirname(this.cfg.db_path), 'run');
    this.file = path.join(this.dir, 'agents.json');
    this.graceMs = Number(this.cfg.stop_grace_seconds ?? this.cfg.watchdog?.kill_grace_seconds ?? 15) * 1000;
    this.idleMin = Number(this.cfg.idle_shutdown_minutes ?? 120);
    this.lastActive = Date.now(); // the idle clock starts when the board starts
    this.stopping = new Map(); // pid -> timer of the pending SIGKILL
  }

  // ---------- the file ----------
  read() {
    try { const j = JSON.parse(fs.readFileSync(this.file, 'utf8')); return Array.isArray(j.agents) ? j.agents : []; } catch { return []; }
  }
  write(list) {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ updated_at: new Date().toISOString(), agents: list }, null, 2) + '\n');
    fs.renameSync(tmp, this.file);
  }
  get(pid) { return this.read().find(e => e.pid === Number(pid)) || null; }

  // The recorded process is still the one running under that pid.
  same(e) {
    const st = procStat(e.pid);
    return !!st && st.start_time === e.start_time;
  }

  register({ pid, name, kind = 'worker', bounty = null, slot = null, attempt = null, source = 'registered', by = null }) {
    pid = Number(pid);
    if (!Number.isInteger(pid) || pid <= 1) throw httpError(`bad pid '${pid}'`, 400);
    if (!KINDS.includes(kind)) throw httpError(`kind must be one of ${KINDS.join(', ')}`, 400);
    if (!name || !String(name).trim()) throw httpError('an agent needs a --name', 400);
    if (bounty != null) {
      bounty = Number(bounty);
      if (!this.board.raw(bounty)) throw httpError(`bounty ${bounty} not found`, 404);
    }
    const st = procStat(pid);
    if (!st) throw httpError(`pid ${pid} is not running`, 404);
    const e = { pid, start_time: st.start_time, name: String(name).trim(), kind, source, bounty: bounty ?? null,
      slot: slot ?? null, attempt: attempt ?? null, registered_at: new Date().toISOString(), by: by ?? null };
    const list = this.read().filter(x => x.pid !== pid);
    list.push(e);
    this.write(list);
    if (bounty != null && source !== 'board') {
      addEvent(this.board.db, { bounty_id: bounty, actor: by || 'orchestrator', kind: 'note', note: `registered ${kind} '${e.name}' pid ${pid}; it is stopped when this bounty is done or failed` });
    }
    return e;
  }

  remove(pid) {
    const list = this.read();
    const rest = list.filter(e => e.pid !== Number(pid));
    if (rest.length !== list.length) this.write(rest);
  }

  // Drop entries whose process is gone or whose pid now belongs to another process.
  prune() {
    const list = this.read();
    const keep = list.filter(e => this.same(e) || this.stopping.has(e.pid));
    if (keep.length !== list.length) this.write(keep);
    return list.filter(e => !keep.includes(e));
  }

  // ---------- stopping ----------
  // SIGTERM (to the process group when the process leads one, else to the pid alone), then
  // SIGKILL after the grace period. The identity is checked before each signal.
  stop(e, reason, { bountyId = e.bounty, actor = 'board' } = {}) {
    const log = note => { if (bountyId) addEvent(this.board.db, { bounty_id: bountyId, actor, kind: 'note', note }); };
    const st = procStat(e.pid);
    if (!st || st.start_time !== e.start_time) {
      this.remove(e.pid);
      const why = st ? `pid ${e.pid} now belongs to another process (start time ${st.start_time}, recorded ${e.start_time}); not signalled` : `pid ${e.pid} already gone`;
      log(`${e.kind} '${e.name}': ${why}`);
      return { pid: e.pid, name: e.name, stopped: false, why };
    }
    const group = st.pgrp === e.pid;
    // Who is in the group now, by (pid, start time): if the leader exits inside the grace period,
    // only these processes, re-checked, are killed, never whatever later holds that pid or pgid.
    const members = group ? groupMembers(e.pid) : [];
    sig(e.pid, group, 'SIGTERM');
    log(`stopping ${e.kind} '${e.name}' (pid ${e.pid}): ${reason}; SIGTERM to ${group ? 'its process group' : 'the process'}, SIGKILL in ${this.graceMs / 1000} s if still running`);
    clearTimeout(this.stopping.get(e.pid));
    const t = setTimeout(() => {
      this.stopping.delete(e.pid);
      const now = procStat(e.pid);
      if (now && now.start_time === e.start_time) {
        // the leader is still the recorded process: the group id is still its group
        sig(e.pid, group && now.pgrp === e.pid, 'SIGKILL');
        log(`${e.kind} '${e.name}' (pid ${e.pid}) ignored SIGTERM; sent SIGKILL`);
      } else if (group) {
        // the leader is gone: SIGKILL each recorded member still running as itself in that group
        const left = killLeftovers(members, e.pid);
        if (left.length) log(`${e.kind} '${e.name}' (pid ${e.pid}) exited; sent SIGKILL to ${left.length} process(es) left in its group`);
      }
      if (!this.same(e)) this.remove(e.pid);
    }, this.graceMs);
    t.unref?.();
    this.stopping.set(e.pid, t);
    return { pid: e.pid, name: e.name, stopped: true, group };
  }

  stopPid(pid, reason, opts) {
    const e = this.get(pid);
    return e ? this.stop(e, reason, opts) : null;
  }

  // A bounty reached done or failed: stop its worker and the agents registered for it.
  onTerminal(bountyId) {
    const b = this.board.raw(bountyId);
    if (!b || !TERMINAL.includes(b.status)) return [];
    const out = [];
    for (const e of this.read()) {
      if (e.bounty !== Number(bountyId) || e.kind === 'orchestrator') continue;
      out.push(this.stop(e, `bounty #${bountyId} is ${b.status}`, { bountyId }));
    }
    return out;
  }

  // ---------- idle ----------
  boardIdle() {
    if (this.board.paused()) return true;
    const q = `SELECT COUNT(*) c FROM bounties WHERE status IN (${ACTIVE.map(() => '?').join(',')})`;
    return this.board.db.prepare(q).get(...ACTIVE).c === 0;
  }
  idleMs() {
    if (!this.boardIdle()) { this.lastActive = Date.now(); return 0; }
    return Date.now() - this.lastActive;
  }

  // Why an entry is stale, or null. Orchestrators are never stale.
  staleWhy(e, idleMs = this.idleMs()) {
    if (e.kind === 'orchestrator') return null;
    if (e.bounty != null) {
      const b = this.board.raw(e.bounty);
      if (!b) return `bounty #${e.bounty} is gone`;
      if (TERMINAL.includes(b.status)) return `bounty #${e.bounty} is ${b.status}`;
    }
    if (this.idleMin > 0) {
      const lim = this.idleMin * 60000;
      if (idleMs >= lim) return `board idle ${Math.round(idleMs / 60000)} min`;
    }
    return null;
  }

  // Every check: drop dead entries, then the idle shutdown.
  sweep() {
    this.prune();
    if (!(this.idleMin > 0)) return [];
    const idle = this.idleMs();
    if (idle < this.idleMin * 60000) return [];
    const out = [];
    for (const e of this.read()) {
      if (e.kind === 'orchestrator' || this.stopping.has(e.pid)) continue;
      out.push(this.stop(e, `idle shutdown: no bounty in progress, review or approved for ${Math.round(idle / 60000)} min`));
    }
    if (out.length) {
      addEvent(this.board.db, { actor: 'board', kind: 'note', note: `idle shutdown after ${Math.round(idle / 60000)} min idle: stopped ${out.filter(x => x.stopped).map(x => `${x.name} (pid ${x.pid})`).join(', ') || 'nothing (all gone)'}` });
      this.board.changed('agents', {});
    }
    return out;
  }

  // ---------- listing and cleanup ----------
  list() {
    this.prune();
    const idle = this.idleMs();
    const t = Date.now();
    return this.read().map(e => {
      const st = procStat(e.pid);
      const b = e.bounty != null ? this.board.raw(e.bounty) : null;
      const startedMs = st ? bootTime() + (st.start_time / ticksPerSecond()) * 1000 : null;
      const stale = this.staleWhy(e, idle);
      return { ...e, alive: !!st && st.start_time === e.start_time, bounty_status: b ? b.status : null,
        age_seconds: startedMs ? Math.max(0, Math.round((t - startedMs) / 1000)) : null,
        rss_kb: st ? treeRssKb(e.pid) : 0, stale: !!stale, stale_why: stale, stopping: this.stopping.has(e.pid) };
    });
  }

  // Dry run unless kill; kill stops the stale entries, all adds the non-stale non-orchestrator
  // ones, orchestrators only with orchestrators. Nothing outside the manifest is ever touched.
  cleanup({ kill = false, all = false, orchestrators = false, actor = 'orchestrator' } = {}) {
    const rows = this.list();
    const idle = this.idleMs();
    for (const r of rows) {
      const pick = r.kind === 'orchestrator' ? orchestrators && all : r.stale || all;
      r.action = pick ? (kill ? 'stop' : 'would stop') : 'keep';
      if (pick && kill) r.result = this.stop(r, `bounty cleanup by ${actor}${r.stale ? ` (${r.stale_why})` : ''}`, { actor });
    }
    if (kill && rows.some(r => r.action === 'stop')) {
      addEvent(this.board.db, { actor, kind: 'note', note: `bounty cleanup --kill${all ? ' --all' : ''}: stopped ${rows.filter(r => r.action === 'stop').map(r => `${r.name} (pid ${r.pid})`).join(', ')}` });
      this.board.changed('agents', {});
    }
    return { idle_minutes: Math.round(idle / 60000), idle_shutdown_minutes: this.idleMin, kill, all, agents: rows };
  }
}

// Processes in process group pgid, with their start times.
function groupMembers(pgid) {
  let names = [];
  try { names = fs.readdirSync('/proc').filter(n => /^\d+$/.test(n)); } catch {}
  const out = [];
  for (const n of names) {
    const st = procStat(n);
    if (st && st.pgrp === pgid) out.push({ pid: st.pid, start_time: st.start_time });
  }
  return out;
}

// SIGKILL each member that still runs as itself (same start time) in group pgid; returns those.
function killLeftovers(members, pgid) {
  const left = members.filter(m => { const st = procStat(m.pid); return !!st && st.start_time === m.start_time && st.pgrp === pgid; });
  for (const m of left) { try { process.kill(m.pid, 'SIGKILL'); } catch {} }
  return left;
}

function sig(pid, group, s) {
  if (group) { try { process.kill(-pid, s); return; } catch {} }
  try { process.kill(pid, s); } catch {}
}

function httpError(msg, code) {
  const { TransitionError } = require('./machine');
  return new TransitionError(msg, code);
}

module.exports = { Agents, procStat, treeRssKb, groupMembers, killLeftovers, KINDS, ACTIVE };
