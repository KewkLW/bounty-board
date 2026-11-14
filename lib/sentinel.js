// Sentinel: a read-only health scan across every board (bounty sentinel). Plain code: no model
// calls, no network. It reads each board's SQLite database (read-only, never immutable, so rows
// still in the WAL are seen) and the tails of its attempt logs, groups failures into issues with
// stable signatures, and writes issues.json, history.ndjson and report.html to its own out dir.
// Nothing is ever written inside a board dir; a board it cannot read becomes an issue.
//
// Live boards are in WAL mode: every handle is opened, queried with a few short .all() calls and
// closed at once, with no explicit transaction, so a scan never pins a snapshot that would block
// the board's checkpoint.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const registry = require('./registry');
const { sameProcess } = require('./proc');

const VERSION = 1;
const DEFAULT_SINCE_HOURS = 72;
const LOG_TAIL_BYTES = 32 * 1024;
const SAMPLE_MAX = 200;
const PENDING = ['ready', 'in_progress', 'blocked'];
const OK_OUTCOMES = ['review', 'approved', 'done', 'submitted (verifying)'];

function stateHome() { return process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'); }
function defaultOutDir() { return path.join(stateHome(), 'bounty-board', 'sentinel'); }
function defaultRegistryDir() { return path.join(stateHome(), 'totally-not-a-kanban', 'boards'); }

// Board timestamps are ISO (db.now()); a few columns use CURRENT_TIMESTAMP ("YYYY-MM-DD HH:MM:SS",
// UTC with no zone), which Date.parse would read as local time.
function ts(s) {
  if (s == null || s === '') return NaN;
  const v = String(s);
  return Date.parse(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(\.\d+)?$/.test(v) ? v.replace(' ', 'T') + 'Z' : v);
}
const iso = ms => new Date(ms).toISOString();
const day = ms => iso(ms).slice(0, 10);

// ---------- normalization, signatures, redaction ----------

// Error text with everything that varies between two runs of the same failure stripped:
// timestamps, uuids, paths, urls, hex, ids (pid 123, #12, thread ab12...), the slot names given,
// then bare numbers. Lower-cased, whitespace collapsed.
function normalize(text, { names = [] } = {}) {
  let s = redact(text);
  for (const n of [...names].filter(Boolean).sort((a, b) => b.length - a.length)) s = s.split(n).join('<slot>');
  s = s
    .replace(/\d{4}-\d\d-\d\d[T ]\d\d[:\-]\d\d[:\-]\d\d(?:[.\-]\d+)?(?:Z|[+-]\d\d:?\d\d)?/g, '<ts>')
    .replace(/\b\d{4}-\d\d-\d\d\b/g, '<date>')
    .replace(/\b\d\d:\d\d:\d\d(?:\.\d+)?\b/g, '<time>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"`<>)]+/gi, '<url>')
    .replace(/(^|[\s'"`(=:,\[])(?:~|\.{1,2})?(?:\/[^\s'"`:,()\[\]]+)+/g, '$1<path>')
    .replace(/\b[A-Za-z]:\\[^\s'"`]+/g, '<path>')
    .replace(/\b0x[0-9a-f]+\b/gi, '<hex>')
    .replace(/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,}\b/gi, '<hex>')
    .replace(/\b(pid|thread|attempt|bounty|port|id)[\s:=#-]*\d+\b/gi, '$1 <n>')
    .replace(/#\d+\b/g, '#<n>')
    .replace(/\d+(?:\.\d+)?/g, '<n>')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  return s.slice(0, 400);
}

function signature(cause, text, opts) {
  return crypto.createHash('sha256').update(`${cause}\n${normalize(text, opts)}`).digest('hex').slice(0, 16);
}

const SECRET_WORDS = 'password|passwd|passphrase|pwd|secret|client[_-]?secret|token|access[_-]?token|refresh[_-]?token|api[_-]?key|apikey|access[_-]?key|secret[_-]?key|private[_-]?key|auth|authorization';
const REDACTIONS = [
  [/-----BEGIN[A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END[A-Z0-9 ]*PRIVATE KEY-----|$)/g, '[REDACTED PRIVATE KEY]'],
  [/\bBearer\s+[A-Za-z0-9._~+\/=-]+/gi, 'Bearer [REDACTED]'],
  [/\bBasic\s+[A-Za-z0-9+\/=]{8,}/g, 'Basic [REDACTED]'],
  [/\bsk-ant-[A-Za-z0-9_-]{8,}/g, '[REDACTED KEY]'],
  [/\bsk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g, '[REDACTED KEY]'],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, '[REDACTED KEY]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '[REDACTED KEY]'],
  [/\bglpat-[A-Za-z0-9_-]{16,}/g, '[REDACTED KEY]'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, '[REDACTED KEY]'],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '[REDACTED KEY]'],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, '[REDACTED KEY]'],
  [/\bhf_[A-Za-z0-9]{30,}/g, '[REDACTED KEY]'],
  [/\b(?:npm|pypi)-[A-Za-z0-9_-]{30,}/g, '[REDACTED KEY]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[REDACTED JWT]'],
  // password=..., "api_key": "...", TOKEN: ..., --password ...
  [new RegExp(`((?:["']?)\\b[A-Za-z0-9_-]*(?:${SECRET_WORDS})["']?\\s*[=:]\\s*)(?!\\[REDACTED|Bearer\\b|Basic\\b)("[^"]*"|'[^']*'|[^\\s,;&'"]+)`, 'gi'), '$1[REDACTED]'],
  [new RegExp(`(--(?:${SECRET_WORDS})[\\s=]+)(\\S+)`, 'gi'), '$1[REDACTED]'],
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:\/@]+:)[^\s@\/]+@/gi, '$1[REDACTED]@'],
];

// Redact first (a private key block spans lines), then cut to SAMPLE_MAX: cutting first could leave
// half a key behind.
function redact(text) {
  let s = String(text || '');
  for (const [re, rep] of REDACTIONS) s = s.replace(re, rep);
  return s;
}
function sampleOf(text) {
  const home = os.homedir();
  let s = redact(text).split(home).join('~').replace(/\s+/g, ' ').trim();
  if (s.length > SAMPLE_MAX) s = s.slice(0, SAMPLE_MAX - 1) + '…';
  return s;
}

// ---------- boards ----------

function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }
function realish(p) {
  // realpath of p, or of its nearest existing ancestor joined with the rest (p may not exist yet)
  let cur = path.resolve(p);
  const rest = [];
  for (;;) {
    try { return path.join(fs.realpathSync(cur), ...rest); } catch {}
    const up = path.dirname(cur);
    if (up === cur) return path.join(cur, ...rest);
    rest.unshift(path.basename(cur));
    cur = up;
  }
}

// A board from its config dir (what the registry calls board_dir), a board.json, or a checkout
// holding config/board.json. Tolerant on purpose (not lib/config.load: that throws on a bad slot,
// applies this process's env and resolves against this checkout).
function resolveBoard(dir, entry = null) {
  const abs0 = path.resolve(dir);
  let cfgPath = null;
  if (/\.json$/.test(abs0) && fs.existsSync(abs0)) cfgPath = abs0;
  else if (fs.existsSync(path.join(abs0, 'board.json'))) cfgPath = path.join(abs0, 'board.json');
  else if (fs.existsSync(path.join(abs0, 'config', 'board.json'))) cfgPath = path.join(abs0, 'config', 'board.json');
  else if (entry && entry.port) {
    try {
      for (const f of fs.readdirSync(abs0).filter(f => f.endsWith('.json'))) {
        const j = readJson(path.join(abs0, f));
        if (j && Number(j.port) === Number(entry.port)) { cfgPath = path.join(abs0, f); break; }
      }
    } catch {}
  }
  const cfg = (cfgPath && readJson(cfgPath)) || {};
  const cfgDir = cfgPath ? path.dirname(cfgPath) : abs0;
  // config/board.json of a checkout resolves paths against the checkout (lib/config.js does the same)
  const base = path.basename(cfgDir) === 'config' && fs.existsSync(path.join(cfgDir, '..', 'server.js')) ? path.dirname(cfgDir) : cfgDir;
  const abs = p => (path.isAbsolute(p) ? p : path.resolve(base, p));
  let db = abs(cfg.db_path || 'data/bounty-board.db');
  if (!cfgPath && !fs.existsSync(db)) for (const c of ['board.db', 'data/board.db']) if (fs.existsSync(path.join(base, c))) db = path.join(base, c);
  const logs = abs(cfg.logs_dir || 'logs');
  const run = abs(cfg.run_dir || 'run');
  const label = (entry && entry.name) || cfg.name || cfg.default_project || path.basename(base);
  const protect = [...new Set([cfgDir, base, path.dirname(db), logs].map(realish))];
  return {
    label, config: cfgPath, base, db, logs, run, protect,
    port: (entry && entry.port) || cfg.port || null,
    stall_minutes: Number((cfg.watchdog || {}).stall_minutes) || 30,
    slots: (Array.isArray(cfg.slots) ? cfg.slots : []).map(x => x && (x.id || x.name)).filter(x => typeof x === 'string'),
    max_attempts: Number((cfg.retry || {}).max_attempts) || 4,
    entry,
  };
}

// Every board the registry lists (stopped ones too: their dbs still hold history) plus --board
// dirs, deduplicated by the real path of the db.
function discover({ registryDir, boards = [] }) {
  const out = [], seen = new Set();
  const add = b => { const k = realish(b.db); if (seen.has(k)) return; seen.add(k); out.push(b); };
  for (const e of registry.list(registryDir)) {
    if (!e.board_dir) {
      out.push({ label: e.name || `port ${e.port}`, port: e.port, db: `registry:${e.port}`, logs: '', run: '', protect: [], slots: [], stall_minutes: 30, entry: e, error: 'registry entry has no board_dir (a board from before board_dir was recorded?)' });
      continue;
    }
    add(resolveBoard(e.board_dir, e));
  }
  for (const d of boards) add(resolveBoard(d));
  return out;
}

function insideAny(p, dirs) {
  const r = realish(p);
  return dirs.find(d => r === d || r.startsWith(d.endsWith(path.sep) ? d : d + path.sep)) || null;
}

// ---------- the change fingerprint ----------

function statKey(f) { try { const s = fs.statSync(f); return `${s.size}:${Math.floor(s.mtimeMs)}`; } catch { return '-'; } }
// A missing -wal and an empty one hold the same rows: SQLite's read-only open of a cleanly closed WAL
// db leaves an empty -wal behind, which must not count as a change.
function walKey(f) { try { const s = fs.statSync(f); return s.size ? `${s.size}:${Math.floor(s.mtimeMs)}` : 'empty'; } catch { return 'empty'; } }

// Size and mtime of every source: each db and its -wal (never -shm, which readers touch) and every
// file in each logs dir, plus the set of boards found (a board added or removed is a change). Not the
// registry files' mtimes: a board rewrites its entry whenever its orchestrator's last_seen moves.
// Stats only: no row is read.
function fingerprint(boards, registryDir, opts) {
  const h = crypto.createHash('sha256');
  h.update(JSON.stringify({ v: VERSION, since: opts.sinceHours }));
  for (const b of boards) {
    h.update(`B ${b.label} ${b.db} ${b.logs} ${b.stall_minutes} ${(b.slots || []).join(',')} ${b.error || ''} ${statKey(b.db)} ${walKey(b.db + '-wal')}\n`);
    let names = [];
    try { names = fs.readdirSync(b.logs).sort(); } catch {}
    for (const n of names) h.update(`L ${n} ${statKey(path.join(b.logs, n))}\n`);
  }
  return h.digest('hex');
}

// ---------- reading one board ----------

function tailOf(file, bytes = LOG_TAIL_BYTES) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const n = Math.min(size, bytes);
    const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, size - n);
    return buf.toString('utf8');
  } catch { return null; } finally { if (fd != null) try { fs.closeSync(fd); } catch {} }
}

const ERRORISH = /\b(error|exception|fatal|traceback|panic|failed|failure|denied|refused|timed? ?out|not found|cannot|can't|unable|ENOENT|EACCES|EPERM|ECONN\w*|SIGKILL|SIGTERM|killed|rate.?limit|overloaded|quota)\b/i;

// The last line in a log tail that reads like an error: a JSON event that is an error (stream-json
// result with is_error, an error/turn.failed event), else a plain (stderr) line matching ERRORISH.
function errorLine(tail) {
  if (!tail) return null;
  const lines = tail.split('\n').map(l => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0 && i >= lines.length - 400; i--) {
    const l = lines[i];
    if (l.startsWith('{')) {
      let ev; try { ev = JSON.parse(l); } catch { continue; }
      if (ev && (ev.is_error === true || ev.type === 'error' || ev.type === 'turn.failed' || (ev.type === 'result' && /error/.test(String(ev.subtype || ''))))) {
        const m = (ev.error && (ev.error.message || ev.error)) || ev.message || ev.result || ev.subtype || ev.type;
        return String(typeof m === 'string' ? m : JSON.stringify(m)).slice(0, 600);
      }
      continue;
    }
    if (ERRORISH.test(l)) return l.slice(0, 600);
  }
  return null;
}

function quantiles(xs) {
  if (!xs.length) return { n: 0, p50: null, p90: null, max: null };
  const s = [...xs].sort((a, b) => a - b);
  const q = p => s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)];
  const r = v => Math.round(v * 10) / 10;
  return { n: s.length, p50: r(q(0.5)), p90: r(q(0.9)), max: r(s[s.length - 1]) };
}

// Minutes of [a, b] not covered by any of the busy intervals.
function uncovered(a, b, busy) {
  const iv = busy.map(([s, e]) => [Math.max(a, s), Math.min(b, e)]).filter(([s, e]) => e > s).sort((x, y) => x[0] - y[0]);
  let free = 0, cur = a;
  for (const [s, e] of iv) { if (s > cur) free += s - cur; cur = Math.max(cur, e); }
  if (b > cur) free += b - cur;
  return free / 60000;
}

// Sorted, merged copy of intervals [s, e] (e > s).
function union(iv) {
  const s = iv.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const [a, b] of s) { const l = out[out.length - 1]; if (l && a <= l[1]) l[1] = Math.max(l[1], b); else out.push([a, b]); }
  return out;
}
const clip = (iv, a, b) => iv.map(([s, e]) => [Math.max(s, a), Math.min(e, b)]).filter(([s, e]) => e > s);
const measureMin = iv => union(iv).reduce((x, [a, b]) => x + (b - a), 0) / 60000;

// How long an open attempt's log has been silent (its mtime; the attempt's start if there is no log).
function silence(a, nowMs) {
  let m = null;
  try { m = fs.statSync(a.log_path).mtimeMs; } catch {}
  return { minutes: (nowMs - (m != null ? m : ts(a.started_at))) / 60000, log: m != null ? 'present' : 'missing' };
}

// A presence note the board writes into its events (lib/orchestrator.js): online from a
// registration, offline when the board saw the process gone. null for any other note.
function presenceNote(e) {
  if (!e || e.bounty_id != null || e.kind && e.kind !== 'note') return null;
  const n = String(e.note || '');
  if (/^orchestrator '.*' registered/.test(n)) return { t: ts(e.at), online: true, src: 'event' };
  if (/^orchestrator '.*' \(pid [^)]*\) is offline/.test(n)) return { t: ts(e.at), online: false, src: 'event' };
  return null;
}

// What the sentinel saw of a presence at one run, kept in its own state.json so an offline spell
// between two scans (or on a board too old to write presence notes) is not lost once it is over.
// t: when that state began (an online orchestrator's since, an offline one's last_seen), else now.
// null when the presence has no usable since (an older registry entry): then it says nothing about
// when its state began.
function presenceObservation(p, nowMs) {
  const t = p.known ? ts(p.since) : NaN;
  return Number.isFinite(t) ? { t: Math.min(t, nowMs), online: p.online } : null;
}

// Offline intervals in [a, b] from presence transitions ({t, online}): the board's presence notes,
// the sentinel's earlier observations and the presence now. Before the first known transition the
// opposite state is assumed (an orchestrator registering was offline before; one going offline was
// online); with no transition at all there is no orchestrator, which is offline.
function offlineIntervals(transitions, a, b) {
  const tr = transitions.filter(x => Number.isFinite(x.t)).sort((x, y) => x.t - y.t || (x.online === y.online ? 0 : x.online ? 1 : -1));
  if (!tr.length) return [[a, b]];
  const out = [];
  let state = !tr[0].online, from = -Infinity;
  for (const x of tr) {
    if (x.online === state) continue;
    if (!state) out.push([from, x.t]);
    state = x.online; from = x.t;
  }
  if (!state) out.push([from, Infinity]);
  return union(clip(out, a, b));
}

// Total minutes where two interval lists overlap.
// The intervals where two interval lists overlap.
function overlap(xs, ys) {
  const out = [];
  for (const [a, b] of union(xs)) for (const [c, d] of union(ys)) { const s = Math.max(a, c), e = Math.min(b, d); if (e > s) out.push([s, e]); }
  return union(out);
}

function presenceOf(b, pending) {
  let p = b.entry ? b.entry.presence : null;
  if (!p) {
    const rec = readJson(path.join(b.run, 'orchestrator.json'));
    if (rec && rec.pid) {
      const online = sameProcess(rec.pid, rec.start_time);
      p = { name: rec.name, online, since: online ? rec.since : rec.last_seen, last_seen: rec.last_seen };
    }
  }
  // a presence object with registered false (a board that never had an orchestrator) is no presence
  if (p && (p.registered === false || (p.pid == null && p.name == null))) p = null;
  return { known: !!p, online: !!(p && p.online), name: p ? p.name || null : null, since: p ? p.since || null : null, pending };
}

// A board whose db has no -wal and no -shm is closed: everything is in the main file. A read-only
// open of it would make SQLite create both sidecars in the board's dir, so read a copy instead (in
// the system temp dir), unless the db changed or a -wal appeared while copying (a board starting up):
// then the original is opened read-only after all.
function snapshotCopy(file) {
  const side = () => fs.existsSync(file + '-wal') || fs.existsSync(file + '-shm');
  if (side()) return null;
  const before = statKey(file);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bounty-sentinel-'));
  const copy = path.join(dir, 'board.db');
  try { fs.copyFileSync(file, copy); } catch { fs.rmSync(dir, { recursive: true, force: true }); return null; }
  if (side() || statKey(file) !== before) { fs.rmSync(dir, { recursive: true, force: true }); return null; }
  return { path: copy, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// Read one board: open read-only (not immutable), a few bounded queries, close at once.
function readBoard(b, { sinceMs, busyTimeoutMs = 1500 }) {
  if (b.error) { const e = new Error(b.error); e.code = 'NO_BOARD_DIR'; throw e; }
  if (!fs.existsSync(b.db)) { const e = new Error(`board database missing: ${b.db}`); e.code = 'DB_MISSING'; throw e; }
  const snap = snapshotCopy(b.db);
  let db;
  try { db = new Database(snap ? snap.path : b.db, { readonly: true, fileMustExist: true, timeout: busyTimeoutMs }); }
  catch (e) { if (snap) snap.cleanup(); throw e; }
  try {
    const since = iso(sinceMs);
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
    for (const t of ['bounties', 'attempts', 'events']) if (!tables.has(t)) { const e = new Error(`no ${t} table (not a board database?)`); e.code = 'NOT_A_BOARD'; throw e; }
    const attempts = db.prepare(`SELECT id, bounty_id, slot, runner, model, started_at, ended_at, exit_code, log_path, cost_usd, tokens_in, tokens_out, kind, outcome
      FROM attempts WHERE started_at >= ? OR ended_at >= ? OR ended_at IS NULL`).all(since, since);
    const events = db.prepare(`SELECT id, bounty_id, at, actor, kind, to_status, substr(note, 1, 4000) note FROM events
      WHERE at >= ? AND kind IN ('status', 'exit', 'verify', 'review', 'note', 'spawn') ORDER BY id`).all(since);
    // each bounty's last status and last spawn before the window: its state when the window opened,
    // so a wait (or pending work) that began before --since is measured from when it really began
    const prior = db.prepare(`SELECT id, bounty_id, at, actor, kind, to_status FROM events WHERE id IN (
        SELECT MAX(id) FROM events WHERE at < ? AND kind = 'status' GROUP BY bounty_id
        UNION SELECT MAX(id) FROM events WHERE at < ? AND kind = 'spawn' GROUP BY bounty_id) ORDER BY id`).all(since, since);
    const bounties = db.prepare('SELECT id, status, attempts, failures, assignee_slot FROM bounties').all();
    // the board's last orchestrator presence note before the window: whether one was online when it opened
    const priorPresence = db.prepare(`SELECT id, at, note FROM events WHERE at < ? AND kind = 'note' AND bounty_id IS NULL
      AND (note LIKE 'orchestrator ''%'' registered%' OR note LIKE 'orchestrator ''%'' (pid %) is offline%') ORDER BY id DESC LIMIT 1`).all(since);
    return { attempts, events, prior, priorPresence, bounties, snapshot: !!snap };
  } finally { db.close(); if (snap) snap.cleanup(); }
}

// Turn one board's rows into signals and issue occurrences.
function analyze(b, rows, { nowMs, sinceMs, presenceLog = [] }) {
  const { attempts, events, bounties } = rows;
  const slotNames = [...new Set([...(b.slots || []), ...attempts.filter(a => a.kind !== 'review').map(a => a.slot)].filter(Boolean))];
  const nopts = { names: slotNames };
  const occ = [];
  const push = (cause, text, o) => occ.push({ cause, text: String(text || cause), board: b.label, signature: signature(cause, text || cause, nopts), title: `${cause.replace(/_/g, ' ')}: ${normalize(text || cause, nopts).slice(0, 90)}`, ...o });
  const evBy = new Map();
  for (const e of events) { if (!evBy.has(e.bounty_id)) evBy.set(e.bounty_id, []); evBy.get(e.bounty_id).push(e); }
  const workers = attempts.filter(a => a.kind !== 'review');
  const sig = { attempts: workers.filter(a => ts(a.started_at) >= sinceMs).length, broken: 0, stall_kills: 0, exits_without_submit: 0, never_started: 0, verify_failures: 0, reviewer_errors: 0, retry_cap_failures: 0 };

  // broken worker attempts
  for (const a of workers) {
    if (a.ended_at == null || ts(a.ended_at) < sinceMs) continue;
    const st = ts(a.started_at), en = ts(a.ended_at);
    const evs = (evBy.get(a.bounty_id) || []).filter(e => { const t = ts(e.at); return t >= st - 1000 && t <= en + 120000; });
    const stalled = evs.some(e => e.actor === 'watchdog' && /^(watchdog:|stopping stalled worker)/.test(e.note || ''));
    const outcome = String(a.outcome || '');
    let cause = null;
    if (stalled) { cause = 'watchdog_stall'; sig.stall_kills++; }
    else if (outcome.startsWith('blocked (exited without submit)')) { cause = 'exit_without_submit'; sig.exits_without_submit++; }
    else if (outcome.startsWith('blocked (never started)')) { cause = 'never_started'; sig.never_started++; }
    else if (a.exit_code != null && a.exit_code !== 0 && !OK_OUTCOMES.includes(outcome)) cause = 'worker_exit_error';
    if (!cause) continue;
    sig.broken++;
    const exitNote = (evs.find(e => e.kind === 'exit') || {}).note || '';
    const why = (exitNote.match(/exited(?: with code -?\d+)?(?: \(([^)]*)\))?/) || [])[1];
    const text = cause === 'watchdog_stall' ? 'no heartbeat or progress past the stall threshold'
      : errorLine(a.log_path ? tailOf(a.log_path) : null) || `exit code ${a.exit_code}${why ? ` (${why})` : ''}`;
    push(cause, text, { at: a.ended_at, bounty_id: a.bounty_id, slot: a.slot, runner: a.runner, model: a.model });
  }

  // verify failures, reviewer errors, retry-cap failures (from events)
  const reviewAttempt = bid => attempts.filter(a => a.kind === 'review' && a.bounty_id === bid).pop() || {};
  const lastWorker = bid => workers.filter(a => a.bounty_id === bid).pop() || {};
  for (const e of events) {
    const note = e.note || '';
    if (e.kind === 'verify' && /^verify (FAILED|crashed)/.test(note)) {
      sig.verify_failures++;
      const [head, ...tail] = note.split('\n');
      const crashed = /^verify crashed/.test(note);
      // a crash's error is its head line ('verify crashed: <message>'); a failure's is the last
      // error-like line of the output that follows, else its head (exit code and command)
      const line = crashed ? (head.replace(/^verify crashed:?\s*/, '') || 'verify crashed') : errorLine(tail.join('\n')) || head;
      const w = lastWorker(e.bounty_id);
      push(crashed ? 'verify_crashed' : 'verify_failed', line, { at: e.at, bounty_id: e.bounty_id, slot: w.slot, runner: w.runner, model: w.model });
    } else if (e.kind === 'review' && /^reviewer error:/.test(note)) {
      sig.reviewer_errors++;
      const r = reviewAttempt(e.bounty_id);
      push('reviewer_error', note.replace(/^reviewer error:\s*/, ''), { at: e.at, bounty_id: e.bounty_id, slot: r.slot || 'reviewer', runner: r.runner, model: r.model });
    } else if (e.kind === 'status' && e.to_status === 'failed' && /attempt cap/.test(note)) {
      sig.retry_cap_failures++;
      const w = lastWorker(e.bounty_id);
      push('retry_cap', 'attempt cap reached', { at: e.at, bounty_id: e.bounty_id, slot: w.slot, runner: w.runner, model: w.model });
    }
  }

  // Status timeline per bounty: its state when the window opened (rows.prior) then every status and
  // spawn event in the window, in id order.
  const tl = new Map();
  for (const e of [...(rows.prior || []), ...events.filter(e => e.kind === 'status' || e.kind === 'spawn')].sort((x, y) => x.id - y.id)) {
    if (!tl.has(e.bounty_id)) tl.set(e.bounty_id, []);
    tl.get(e.bounty_id).push(e);
  }
  const curStatus = new Map(bounties.map(x => [x.id, x.status]));

  // queue wait: each entry into ready until the first claim after it (the dispatcher's spawn, or
  // in_progress for a bounty started outside it). A wait counts when it ends in the window, measured
  // from its real start even if that was before --since.
  const waits = [], openWaits = [];
  for (const [bid, evs] of tl) {
    let readyAt = null;
    for (const e of evs) {
      if (e.kind === 'status' && e.to_status === 'ready') { if (readyAt == null) readyAt = ts(e.at); }
      else if ((e.kind === 'spawn' || (e.kind === 'status' && e.to_status === 'in_progress')) && readyAt != null) {
        if (ts(e.at) >= sinceMs) waits.push({ bid, from: readyAt, to: ts(e.at) });
        readyAt = null;
      }
      else if (e.kind === 'status' && e.to_status && e.to_status !== 'ready' && readyAt != null) readyAt = null;
    }
    if (readyAt != null && curStatus.get(bid) === 'ready') openWaits.push({ bid, from: readyAt, to: nowMs });
  }
  const queue_wait_min = quantiles(waits.map(w => (w.to - w.from) / 60000));
  queue_wait_min.waiting_now = openWaits.length;
  queue_wait_min.longest_waiting_now = openWaits.length ? Math.round(Math.max(...openWaits.map(w => (w.to - w.from) / 60000))) : null;

  // slots idle while ready work waited: the time (in the window) when at least one bounty was ready
  // and unclaimed, as one union, so two bounties waiting at once count once; minus each slot's busy time
  const readyIv = union(clip([...waits, ...openWaits].map(w => [w.from, w.to]), sinceMs, nowMs));
  const busyBy = {};
  for (const a of workers) (busyBy[a.slot] = busyBy[a.slot] || []).push([ts(a.started_at), a.ended_at ? ts(a.ended_at) : nowMs]);
  for (const s of b.slots || []) if (!busyBy[s]) busyBy[s] = [];
  const idleOf = busy => readyIv.reduce((acc, [f, t]) => acc + uncovered(f, t, busy), 0);
  const idle_while_ready = {};
  for (const s of Object.keys(busyBy)) {
    const m = idleOf(busyBy[s]);
    if (m >= 1 || !busyBy[s].length) idle_while_ready[s] = Math.round(m);
  }
  const ready_waiting_min = Math.round(measureMin(readyIv));
  // minutes in which ready work waited and no slot at all was running
  const board_idle_with_ready_min = Math.round(idleOf(Object.values(busyBy).flat()));

  // attempts per bounty (in the window)
  const per = {};
  for (const a of workers) if (ts(a.started_at) >= sinceMs) per[a.bounty_id] = (per[a.bounty_id] || 0) + 1;
  const counts = Object.values(per);
  const attempts_per_bounty = { bounties: counts.length, mean: counts.length ? Math.round(counts.reduce((x, y) => x + y, 0) / counts.length * 100) / 100 : null, max: counts.length ? Math.max(...counts) : null, retried: counts.filter(c => c > 1).length };

  // cost and tokens per slot per day
  const cost = {};
  for (const a of attempts) {
    const t = ts(a.started_at);
    if (!(t >= sinceMs)) continue;
    const k = `${day(t)}|${a.slot || '?'}`;
    const c = cost[k] = cost[k] || { day: day(t), slot: a.slot || '?', attempts: 0, cost_usd: 0, tokens_in: 0, tokens_out: 0 };
    c.attempts++; c.cost_usd += a.cost_usd || 0; c.tokens_in += a.tokens_in || 0; c.tokens_out += a.tokens_out || 0;
  }
  const cost_by_slot_day = Object.values(cost).map(c => ({ ...c, cost_usd: Math.round(c.cost_usd * 10000) / 10000 })).sort((x, y) => x.day.localeCompare(y.day) || x.slot.localeCompare(y.slot));

  // open attempts whose log has not grown past the stall threshold
  const stale_open = [];
  const watch = []; // open attempts not stale yet: the unchanged fast path re-checks them by time
  for (const a of workers.filter(a => a.ended_at == null)) {
    const q = silence(a, nowMs);
    if (q.minutes > b.stall_minutes) {
      stale_open.push({ bounty_id: a.bounty_id, slot: a.slot, minutes_silent: Math.round(q.minutes), log: q.log });
      push('stale_open_attempt', `open attempt log silent past the stall threshold (log ${q.log})`, { at: iso(nowMs), bounty_id: a.bounty_id, slot: a.slot, runner: a.runner, model: a.model });
    } else watch.push({ bounty_id: a.bounty_id, log_path: a.log_path || null, started_at: a.started_at });
  }

  // pending work with no orchestrator online. Pending time: the union (in the window) of every
  // bounty's spells in ready/in_progress/blocked from its status timeline. Offline time: since the
  // presence says it went offline, or the whole window when no orchestrator is registered at all
  // (an unknown presence is not an online one). The signal is their overlap.
  const pending = bounties.filter(x => PENDING.includes(x.status)).length;
  const pendIv = [];
  for (const x of bounties) {
    const evs = (tl.get(x.id) || []).filter(e => e.kind === 'status');
    if (!evs.length) { if (PENDING.includes(x.status)) pendIv.push([sinceMs, nowMs]); continue; }
    let from = null;
    for (const e of evs) {
      const t = ts(e.at), p = PENDING.includes(e.to_status);
      if (p && from == null) from = t;
      else if (!p && from != null) { pendIv.push([from, t]); from = null; }
    }
    if (from != null) pendIv.push([from, PENDING.includes(x.status) ? nowMs : Math.max(from, ts(evs[evs.length - 1].at))]);
  }
  const pendingIv = union(clip(pendIv, sinceMs, nowMs));
  const orch = presenceOf(b, pending);
  // Offline time over the whole window, not only the current spell: the board's presence notes (the
  // last one before the window says how it opened), what earlier sentinel runs saw, and now.
  const transitions = [...(rows.priorPresence || []).map(e => presenceNote({ ...e, kind: 'note', bounty_id: null })), ...events.map(presenceNote), ...(presenceLog || [])].filter(Boolean);
  // With no dated transition at all, the state now is the state of the whole window.
  const nowObs = presenceObservation(orch, nowMs);
  if (nowObs) transitions.push(nowObs);
  const offline = transitions.length ? offlineIntervals([...transitions, { t: nowMs, online: orch.online }], sinceMs, nowMs)
    : orch.online ? [] : [[sinceMs, nowMs]];
  orch.no_orchestrator_with_work = !orch.online && pending > 0;
  orch.pending_min = Math.round(measureMin(pendingIv));
  orch.offline_min = Math.round(measureMin(offline));
  const without = overlap(pendingIv, offline);
  orch.minutes_without = Math.round(measureMin(without));
  if (orch.no_orchestrator_with_work || orch.minutes_without >= 1)
    push('no_orchestrator', orch.known ? 'pending work with no orchestrator online' : 'pending work and no orchestrator registered', { at: iso(without.length ? without[without.length - 1][1] : nowMs), bounty_id: null, slot: null });

  // last 24 h, so the history can be compared day over day
  const d24 = nowMs - 86400000;
  const in24 = o => ts(o.at) >= d24;
  const last24h = {
    broken: occ.filter(o => in24(o) && ['watchdog_stall', 'exit_without_submit', 'never_started', 'worker_exit_error'].includes(o.cause)).length,
    verify_failures: occ.filter(o => in24(o) && /^verify_/.test(o.cause)).length,
    reviewer_errors: occ.filter(o => in24(o) && o.cause === 'reviewer_error').length,
    attempts: workers.filter(a => ts(a.started_at) >= d24).length,
    cost_usd: Math.round(attempts.filter(a => ts(a.started_at) >= d24).reduce((x, a) => x + (a.cost_usd || 0), 0) * 10000) / 10000,
    tokens_out: attempts.filter(a => ts(a.started_at) >= d24).reduce((x, a) => x + (a.tokens_out || 0), 0),
  };

  return {
    signals: { ...sig, queue_wait_min, attempts_per_bounty, cost_by_slot_day, idle_while_ready, ready_waiting_min, board_idle_with_ready_min, stale_open, orchestrator: orch, last24h },
    occurrences: occ,
    watch: { stall_minutes: b.stall_minutes, open: watch, online: orch.online },
  };
}

// ---------- issues ----------

function bump(m, k) { if (k) m[k] = (m[k] || 0) + 1; }

// Counts are recomputed from the sources on every run; only first_seen is carried from the last
// issues.json (adding per run would double-count overlapping windows). An issue no longer in the
// window stays with count 0, so it can be seen to have gone quiet.
function buildIssues(occ, prev = []) {
  const by = new Map();
  for (const o of occ) {
    let i = by.get(o.signature);
    if (!i) {
      i = { signature: o.signature, cause: o.cause, title: o.title, first_seen: o.at, last_seen: o.at, count: 0, boards: [], slots: {}, runners: {}, models: {}, example_bounty_ids: [], sample: sampleOf(o.text) };
      by.set(o.signature, i);
    }
    i.count++;
    if (ts(o.at) < ts(i.first_seen)) i.first_seen = o.at;
    if (ts(o.at) > ts(i.last_seen)) { i.last_seen = o.at; i.sample = sampleOf(o.text); }
    if (!i.boards.includes(o.board)) i.boards.push(o.board);
    bump(i.slots, o.slot); bump(i.runners, o.runner); bump(i.models, o.model);
    const ex = o.bounty_id != null ? `${o.board}#${o.bounty_id}` : null;
    if (ex && !i.example_bounty_ids.includes(ex) && i.example_bounty_ids.length < 5) i.example_bounty_ids.push(ex);
  }
  for (const p of prev || []) {
    const i = by.get(p.signature);
    if (i) { if (p.first_seen && ts(p.first_seen) < ts(i.first_seen)) i.first_seen = p.first_seen; }
    else by.set(p.signature, { ...p, count: 0, sample: sampleOf(p.sample || '') });
  }
  return [...by.values()].sort((a, b) => b.count - a.count || ts(b.last_seen) - ts(a.last_seen));
}

// ---------- the run ----------

function atomicWrite(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function readHistory(file, max = 2000) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const l of text.split('\n').slice(-max)) { if (!l.trim()) continue; try { out.push(JSON.parse(l)); } catch {} }
  return out;
}

class UsageError extends Error {}

// Signals that change with time alone, while no source does: an open attempt crossing the stall
// threshold, an orchestrator coming online or going offline (its registry entry and run record are
// not in the fingerprint). Re-checked from what the last full scan left in state.json, with stats
// and the presence only, no row read. Returns why a scan is due, or null.
function elapsedDue(boards, watch, nowMs) {
  if (!watch) return 'no watch list from the last scan';
  for (const b of boards) {
    const w = watch[b.db];
    if (!w) continue;
    for (const a of w.open || []) if (silence(a, nowMs).minutes > w.stall_minutes) return `open attempt on bounty ${a.bounty_id} went silent past the stall threshold`;
    if (presenceOf(b, 0).online !== w.online) return `orchestrator went ${w.online ? 'offline' : 'online'}`;
  }
  return null;
}

// Append one presence observation to a board's log in state.json (skipping a repeat of the last
// one); entries older than 30 days go, but the newest of those stays: it says how the window opened.
const PRESENCE_KEEP_MS = 30 * 86400000;
function recordPresence(log, obs, nowMs) {
  const l = Array.isArray(log) ? log.filter(x => x && Number.isFinite(x.t)) : [];
  if (obs) {
    const last = l[l.length - 1];
    if (!last || last.online !== obs.online || last.t !== obs.t) l.push({ t: obs.t, online: !!obs.online });
  }
  const old = l.filter(x => x.t < nowMs - PRESENCE_KEEP_MS);
  const keep = l.filter(x => x.t >= nowMs - PRESENCE_KEEP_MS);
  return [...old.slice(-1), ...keep].slice(-500);
}

function presenceLogs(boards, prev, nowMs) {
  const out = {};
  for (const b of boards) {
    const p = presenceOf(b, 0);
    out[b.db] = recordPresence((prev || {})[b.db], presenceObservation(p, nowMs), nowMs);
  }
  return out;
}

// opts: { registryDir, boards: [dir], out, sinceHours, force, now }
function run(opts = {}) {
  const nowMs = opts.now != null ? Number(opts.now) : Date.now();
  const registryDir = path.resolve(opts.registryDir || process.env.BOUNTY_REGISTRY_DIR || defaultRegistryDir());
  const sinceHours = opts.sinceHours != null ? Number(opts.sinceHours) : DEFAULT_SINCE_HOURS;
  if (!(sinceHours > 0)) throw new UsageError(`--since must be a positive number of hours`);
  const out = path.resolve(opts.out || defaultOutDir());
  const boards = discover({ registryDir, boards: opts.boards || [] });
  for (const b of boards) {
    const hit = insideAny(out, b.protect);
    if (hit) throw new UsageError(`refusing --out ${out}: it is inside a board dir (${hit}); the sentinel never writes inside a board`);
  }
  fs.mkdirSync(out, { recursive: true });
  const stateFile = path.join(out, 'state.json');
  const fp = fingerprint(boards, registryDir, { sinceHours });
  const prevState = readJson(stateFile) || {};
  const base = { at: iso(nowMs), version: VERSION, out, registry_dir: registryDir, since_hours: sinceHours, boards: boards.length };
  const due = prevState.fingerprint === fp ? elapsedDue(boards, prevState.watch, nowMs) : null;
  if (!opts.force && prevState.fingerprint === fp && !due) {
    // no row read: the presence is still observed (registry entry and run record only), and
    // report.html is rebuilt from the last scan's stored results plus the history up to now
    atomicWrite(stateFile, JSON.stringify({ ...prevState, checked_at: base.at, presence: presenceLogs(boards, prevState.presence, nowMs) }, null, 2) + '\n');
    fs.appendFileSync(path.join(out, 'history.ndjson'), JSON.stringify({ at: base.at, unchanged: true, boards: boards.length, last_scan: prevState.at || null }) + '\n');
    const res = { ...base, unchanged: true, last_scan: prevState.at || null, message: `no source db, WAL or log changed since the last run (${prevState.at}); nothing read (use --force to scan anyway)` };
    const lastBoards = readJson(path.join(out, 'boards.json'));
    const lastIssues = readJson(path.join(out, 'issues.json'));
    if (prevState.summary && lastBoards && lastIssues) {
      const history = readHistory(path.join(out, 'history.ndjson'));
      atomicWrite(path.join(out, 'report.html'), require('./sentinel-report').render({ summary: { ...prevState.summary, checked_at: base.at }, issues: lastIssues.issues || [], boards: lastBoards.boards || [], history }));
    }
    return res;
  }

  const sinceMs = nowMs - sinceHours * 3600000;
  const perBoard = [], occ = [], watch = {};
  for (const b of boards) {
    const row = { label: b.label, port: b.port, running: b.entry ? !b.entry.stopped : null, readable: true };
    try {
      const rows = readBoard(b, { sinceMs, busyTimeoutMs: opts.busyTimeoutMs });
      const a = analyze(b, rows, { nowMs, sinceMs, presenceLog: (prevState.presence || {})[b.db] });
      row.signals = a.signals;
      occ.push(...a.occurrences);
      watch[b.db] = a.watch;
    } catch (e) {
      row.readable = false;
      row.error = sampleOf(`${e.code || 'ERROR'}: ${e.message}`);
      const text = `${e.code || 'ERROR'}: ${e.message}`;
      occ.push({ cause: 'board_unreadable', text, board: b.label, signature: signature('board_unreadable', text), title: `board unreadable: ${normalize(text).slice(0, 90)}`, at: iso(nowMs), bounty_id: null, slot: null });
    }
    perBoard.push(row);
  }

  const prevIssues = (readJson(path.join(out, 'issues.json')) || {}).issues || [];
  const issues = buildIssues(occ, prevIssues);
  const sum = k => perBoard.reduce((x, r) => x + ((r.signals || {})[k] || 0), 0);
  const sum24 = k => Math.round(perBoard.reduce((x, r) => x + (((r.signals || {}).last24h || {})[k] || 0), 0) * 10000) / 10000;
  const summary = {
    ...base, unchanged: false, ...(due && !opts.force ? { rescan_reason: due } : {}),
    readable: perBoard.filter(r => r.readable).length,
    unreadable: perBoard.filter(r => !r.readable).length,
    issues_open: issues.filter(i => i.count > 0).length,
    occurrences: occ.length,
    attempts: sum('attempts'), broken: sum('broken'), stall_kills: sum('stall_kills'), exits_without_submit: sum('exits_without_submit'),
    verify_failures: sum('verify_failures'), reviewer_errors: sum('reviewer_errors'), retry_cap_failures: sum('retry_cap_failures'),
    stale_open: perBoard.reduce((x, r) => x + ((r.signals || {}).stale_open || []).length, 0),
    no_orchestrator_with_work: perBoard.filter(r => r.signals && r.signals.orchestrator.no_orchestrator_with_work).length,
    cost_usd: Math.round(perBoard.reduce((x, r) => x + ((r.signals || {}).cost_by_slot_day || []).reduce((y, c) => y + c.cost_usd, 0), 0) * 10000) / 10000,
    last24h: { broken: sum24('broken'), verify_failures: sum24('verify_failures'), reviewer_errors: sum24('reviewer_errors'), attempts: sum24('attempts'), cost_usd: sum24('cost_usd'), tokens_out: sum24('tokens_out') },
    top_issues: issues.filter(i => i.count > 0).slice(0, 5).map(i => ({ signature: i.signature, count: i.count, title: i.title })),
  };

  atomicWrite(path.join(out, 'issues.json'), JSON.stringify({ generated_at: base.at, since_hours: sinceHours, issues }, null, 2) + '\n');
  const hist = { at: base.at, boards: summary.boards, readable: summary.readable, unreadable: summary.unreadable, issues_open: summary.issues_open,
    attempts: summary.attempts, broken: summary.broken, stall_kills: summary.stall_kills, exits_without_submit: summary.exits_without_submit,
    verify_failures: summary.verify_failures, reviewer_errors: summary.reviewer_errors, retry_cap_failures: summary.retry_cap_failures,
    stale_open: summary.stale_open, no_orchestrator_with_work: summary.no_orchestrator_with_work, cost_usd: summary.cost_usd, last24h: summary.last24h,
    per_board: Object.fromEntries(perBoard.map(r => [r.label, r.readable ? { broken: r.signals.broken, last24h: r.signals.last24h, queue_p50: r.signals.queue_wait_min.p50, no_orch: r.signals.orchestrator.no_orchestrator_with_work } : { unreadable: true }])) };
  fs.appendFileSync(path.join(out, 'history.ndjson'), JSON.stringify(hist) + '\n');
  const history = readHistory(path.join(out, 'history.ndjson'));
  atomicWrite(path.join(out, 'report.html'), require('./sentinel-report').render({ summary, issues, boards: perBoard, history }));
  atomicWrite(path.join(out, 'boards.json'), JSON.stringify({ generated_at: base.at, boards: perBoard }, null, 2) + '\n');
  atomicWrite(stateFile, JSON.stringify({ at: base.at, checked_at: base.at, fingerprint: fp, watch, summary, presence: presenceLogs(boards, prevState.presence, nowMs) }, null, 2) + '\n');
  return summary;
}

function formatSummary(s) {
  if (s.unchanged) return `sentinel: ${s.boards} board(s); ${s.message}`;
  const l = [`sentinel: ${s.boards} board(s) scanned (${s.readable} readable, ${s.unreadable} unreadable), last ${s.since_hours} h`,
    `  issues ${s.issues_open} open from ${s.occurrences} occurrence(s); attempts ${s.attempts}, broken ${s.broken} (stall kills ${s.stall_kills}, exits without submit ${s.exits_without_submit})`,
    `  verify failures ${s.verify_failures}, reviewer errors ${s.reviewer_errors}, retry-cap failures ${s.retry_cap_failures}, stale open attempts ${s.stale_open}, boards with work and no orchestrator ${s.no_orchestrator_with_work}`,
    `  cost $${s.cost_usd.toFixed(2)} in the window; last 24 h: ${s.last24h.attempts} attempts, ${s.last24h.broken} broken, $${s.last24h.cost_usd.toFixed(2)}`];
  if (s.rescan_reason) l.push(`  sources unchanged, scanned because: ${s.rescan_reason}`);
  for (const i of s.top_issues) l.push(`  ${String(i.count).padStart(4)}  ${i.signature}  ${i.title}`);
  l.push(`  report: ${path.join(s.out, 'report.html')}`);
  return l.join('\n');
}

// ---------- --check-install ----------

function checkInstall({ out = defaultOutDir(), exec = require('child_process').spawnSync } = {}) {
  const r = { unit: 'bounty-sentinel.timer', installed: false, enabled: null, active: null, last_trigger: null, next_trigger: null, systemctl: true, error: null };
  const res = exec('systemctl', ['--user', 'show', 'bounty-sentinel.timer', '-p', 'LoadState,UnitFileState,ActiveState,LastTriggerUSec,NextElapseUSecRealtime'], { encoding: 'utf8', timeout: 5000 });
  if (res.error || res.status !== 0) { r.systemctl = !res.error; r.error = String(res.error ? res.error.message : (res.stderr || '').trim() || `exit ${res.status}`).slice(0, 200); }
  else {
    const kv = Object.fromEntries(String(res.stdout).split('\n').filter(Boolean).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    r.installed = kv.LoadState === 'loaded';
    r.enabled = kv.UnitFileState || null;
    r.active = kv.ActiveState === 'active';
    r.last_trigger = kv.LastTriggerUSec && kv.LastTriggerUSec !== 'n/a' && kv.LastTriggerUSec !== '0' ? kv.LastTriggerUSec : null;
    r.next_trigger = kv.NextElapseUSecRealtime && kv.NextElapseUSecRealtime !== 'n/a' ? kv.NextElapseUSecRealtime : null;
  }
  const hist = readHistory(path.join(out, 'history.ndjson'), 5);
  const st = readJson(path.join(out, 'state.json'));
  r.out = out;
  r.last_run = hist.length ? hist[hist.length - 1].at : null;
  r.last_checked = st ? st.checked_at || st.at : null;
  return r;
}

function formatCheck(r) {
  const l = [`timer ${r.unit}: ${r.installed ? 'installed' : 'NOT installed'}${r.installed ? `, ${r.active ? 'active' : 'NOT active'} (unit file ${r.enabled || '?'})` : ''}`];
  if (r.error) l.push(`  systemctl: ${r.error}`);
  if (r.last_trigger) l.push(`  last triggered: ${r.last_trigger}`);
  if (r.next_trigger) l.push(`  next: ${r.next_trigger}`);
  l.push(`  last full scan (${r.out}): ${r.last_run || 'never'}; last run of any kind: ${r.last_checked || 'never'}`);
  if (!r.installed) l.push('  install: see README "Sentinel" (systemd/bounty-sentinel.service + .timer)');
  return l.join('\n');
}

module.exports = {
  run, formatSummary, checkInstall, formatCheck, normalize, signature, redact, sampleOf, resolveBoard, discover, fingerprint,
  readBoard, analyze, buildIssues, errorLine, quantiles, defaultOutDir, defaultRegistryDir, UsageError, ts,
};
