// Fixture boards for the sentinel tests (and the scratch-board QA): a board dir with board.json,
// a real board database (lib/db.js schema) and attempt logs, seeded with failures.
const fs = require('fs');
const path = require('path');
const dbm = require('../lib/db');

const H = 3600000;

// seed: { now, slots: [..], failures: true } -> { dir, db, logs }
function makeBoard(dir, { name = 'Fixture Board', port = 4901, now = Date.now(), slots = ['alpha-1', 'beta-1'], seed = true, stallMinutes = 30, keepOpen = false } = {}) {
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
  const cfg = { name, port, db_path: 'data/board.db', logs_dir: 'logs', watchdog: { stall_minutes: stallMinutes }, retry: { max_attempts: 3 }, slots: slots.map(s => ({ id: s, name: s })) };
  fs.writeFileSync(path.join(dir, 'board.json'), JSON.stringify(cfg, null, 2));
  const dbPath = path.join(dir, 'data', 'board.db');
  const db = dbm.open(dbPath);
  const t = ms => new Date(now - ms).toISOString();
  const logs = path.join(dir, 'logs');
  let n = 0;
  const bounty = (status, extra = {}) => Number(db.prepare(`INSERT INTO bounties (title, status, attempts, failures, assignee_slot) VALUES (?, ?, ?, ?, ?)`)
    .run(`fixture ${++n}`, status, extra.attempts || 0, extra.failures || 0, extra.slot || null).lastInsertRowid);
  const ev = (bid, at, kind, o = {}) => db.prepare('INSERT INTO events (bounty_id, at, actor, kind, to_status, note) VALUES (?, ?, ?, ?, ?, ?)').run(bid, at, o.actor || 'board', kind, o.to || null, o.note || null);
  const attempt = (bid, o) => {
    const log = path.join(logs, `bounty-${bid}-attempt-${o.slot}-${o.tag || 'x'}.log`);
    if (o.log != null) fs.writeFileSync(log, o.log);
    const id = Number(db.prepare(`INSERT INTO attempts (bounty_id, slot, runner, model, started_at, ended_at, exit_code, log_path, cost_usd, tokens_in, tokens_out, kind, outcome)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(bid, o.slot, o.runner || 'claude', o.model || 'opus', o.start, o.end || null, o.code ?? null, log,
      o.cost ?? 0.5, o.tin ?? 1000, o.tout ?? 200, o.kind || 'worker', o.outcome || null).lastInsertRowid);
    if (o.mtime != null) fs.utimesSync(log, new Date(o.mtime), new Date(o.mtime));
    return { id, log };
  };
  if (seed) {
    const [s1, s2] = slots;
    // 1: exits without submit twice, same error with different numbers and paths
    const b1 = bounty('blocked', { attempts: 2, failures: 2, slot: s1 });
    ev(b1, t(10 * H), 'status', { to: 'ready' });
    ev(b1, t(9 * H), 'spawn');
    attempt(b1, { slot: s1, start: t(9 * H), end: t(8 * H), code: 1, outcome: 'blocked (exited without submit)', tag: 'a',
      log: '{"type":"system"}\nError: ENOENT: no such file or directory, open \'/home/someone/work/x-17/build/out-4411.json\' at 2026-11-01T10:00:00Z\n' });
    ev(b1, t(8 * H), 'exit', { actor: 'dispatcher', note: `worker ${s1} (pid 4242) exited with code 1; log /tmp/x.log` });
    ev(b1, t(8 * H), 'status', { to: 'blocked', actor: 'watchdog', note: `worker ${s1} (pid 4242) exited with code 1 without submitting` });
    ev(b1, t(7 * H), 'status', { to: 'ready' });
    ev(b1, t(5 * H), 'spawn');
    attempt(b1, { slot: s2 || s1, start: t(5 * H), end: t(4 * H), code: 1, outcome: 'blocked (exited without submit)', tag: 'b',
      log: 'some chatter\nError: ENOENT: no such file or directory, open \'/var/tmp/other-9/out-12.json\' at 2026-11-13T22:41:07.123Z\n' });
    // 2: watchdog stall kill
    const b2 = bounty('blocked', { attempts: 1, failures: 1, slot: s1 });
    ev(b2, t(6 * H), 'status', { to: 'ready' });
    ev(b2, t(6 * H - 60000), 'spawn');
    attempt(b2, { slot: s1, start: t(6 * H - 60000), end: t(5 * H), code: 143, outcome: 'blocked', tag: 'c', log: 'working\n' });
    ev(b2, t(5 * H + 30000), 'status', { to: 'blocked', actor: 'watchdog', note: `watchdog: no heartbeat or progress for 31 min; worker ${s1} pid 999 killed; log /x` });
    // 3: verify failed, then passed, then a reviewer error, with a secret in the verify tail
    const b3 = bounty('review', { attempts: 1, slot: s2 || s1 });
    ev(b3, t(3 * H), 'status', { to: 'ready' });
    ev(b3, t(2 * H), 'spawn');
    attempt(b3, { slot: s2 || s1, start: t(2 * H), end: t(1 * H), code: 0, outcome: 'review', tag: 'd', log: 'ok\n', cost: 1.25 });
    ev(b3, t(90 * 60000), 'verify', { note: 'verify FAILED (exit 1): npm test; log /tmp/v.log\nnot ok 3 - math\nError: expected 5, got 4 with token=sk-ant-api03-SECRETSECRETSECRET1234 Authorization: Bearer abc.def.ghi' });
    ev(b3, t(50 * 60000), 'review', { actor: 'reviewer', note: 'reviewer error: no verdict from the reviewer (exit 1); log /tmp/r-55.log' });
    attempt(b3, { slot: 'reviewer', runner: 'codex', model: 'gpt-x', kind: 'review', start: t(55 * 60000), end: t(50 * 60000), code: 1, outcome: 'error', tag: 'r', log: '' });
    // 4: retry cap
    const b4 = bounty('failed', { attempts: 3, failures: 3, slot: s1 });
    ev(b4, t(2 * H), 'status', { to: 'failed', note: 'verify failed after the worker exited (log /x); attempt cap 3 reached' });
    // 5: an open attempt whose log went silent
    const b5 = bounty('in_progress', { attempts: 1, slot: s1 });
    ev(b5, t(3 * H), 'status', { to: 'ready' });
    ev(b5, t(3 * H - 120000), 'spawn');
    attempt(b5, { slot: s1, start: t(3 * H - 120000), tag: 'e', log: 'started\n', mtime: now - 2 * H });
    // 6: ready and still waiting
    const b6 = bounty('ready');
    ev(b6, t(30 * 60000), 'status', { to: 'ready' });
  }
  if (keepOpen) return { dir, dbPath, db, logs };
  db.close();
  return { dir, dbPath, logs };
}

function writeRegistry(regDir, boards) {
  fs.mkdirSync(regDir, { recursive: true });
  for (const b of boards) {
    fs.writeFileSync(path.join(regDir, `${b.port}.json`), JSON.stringify({ name: b.name, port: b.port, board_dir: b.dir, pid: 0, presence: b.presence || null, started_at: new Date().toISOString(), stopped_at: null }, null, 2));
  }
}

module.exports = { makeBoard, writeRegistry };
