// bounty sentinel: the read-only health scan. Fixture boards in temp dirs; no server, no network.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const Database = require('better-sqlite3');
const s = require('../lib/sentinel');
const { makeBoard, writeRegistry } = require('./sentinel-fixtures');

const BIN = path.join(__dirname, '..', 'bin', 'bounty');
const tmp = tag => fs.mkdtempSync(path.join(process.env.BOUNTY_TEST_TMP || os.tmpdir(), `bb-sentinel-${tag}-`));
const cli = (args, env = {}) => spawnSync(process.execPath, [BIN, 'sentinel', ...args], { encoding: 'utf8', env: { ...process.env, BOUNTY_SLOT: '', BOUNTY_URL: 'http://127.0.0.1:9', ...env } });
const issues = out => JSON.parse(fs.readFileSync(path.join(out, 'issues.json'), 'utf8')).issues;

// name -> size:mtime of every file under dir
function snapshot(dir) {
  const out = {};
  const walk = d => { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); const st = fs.statSync(p); if (st.isDirectory()) walk(p); else out[path.relative(dir, p)] = `${st.size}:${st.mtimeMs}`; } };
  walk(dir);
  return out;
}

test('signature: the same failure with other numbers, paths, ids, timestamps and slots hashes the same', () => {
  const a = "worker alpha-1 (pid 4242) exited with code 1: Error: ENOENT, open '/home/a/work/x-17/build/out-4411.json' at 2026-11-01T10:00:00Z (thread 9f3a2b7c1d, #12)";
  const b = "worker beta-2 (pid 77) exited with code 1: Error: ENOENT, open '/var/tmp/other/out-12.json' at 2026-11-13T22:41:07.123Z (thread 0badc0ffee11, #340)";
  const opts = { names: ['alpha-1', 'beta-2'] };
  assert.strictEqual(s.signature('exit_without_submit', a, opts), s.signature('exit_without_submit', b, opts));
  assert.strictEqual(s.normalize(a, opts), s.normalize(b, opts));
  assert.ok(!/\d/.test(s.normalize(a, opts).replace(/<\w+>/g, '')), 'no digits survive normalization');
  assert.notStrictEqual(s.signature('verify_failed', a, opts), s.signature('exit_without_submit', a, opts), 'cause class is part of the signature');
  assert.notStrictEqual(s.signature('exit_without_submit', 'Error: EACCES permission denied'), s.signature('exit_without_submit', 'Error: ENOENT no such file'));
  // uuids, hex, urls, a Windows path
  assert.strictEqual(s.normalize('id 1b4e28ba-2fa1-11d2-883f-0016d3cca427 at 0xdeadbeef from https://x.example/a/b?c=1 in C:\\a\\b.txt'),
    s.normalize('id 9c4e28ba-2fa1-11d2-883f-0016d3cca999 at 0x1 from https://y.example/z in D:\\q.txt'));
});

test('redaction: provider keys, Bearer tokens, password= style assignments and private key blocks', () => {
  const raw = [
    'Authorization: Bearer eyJhbGciOi.abcdefghijk.lmnopqrstuv',
    'key sk-ant-api03-AbCdEfGhIjKlMnOpQrSt-uvwx and sk-proj-ABCDEFGHIJKLMNOPQRST1234',
    'ghp_abcdefghijklmnopqrstuvwxyz0123 AKIAABCDEFGHIJKLMNOP xoxb-1234567890-abcdefghij',
    'password=hunter2 PASSWD: "s3cret" {"api_key": "zzz-123"} DB_TOKEN=abc123 --password p4ss https://user:pw1@host.example/x',
    '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\nAAAABG5vbmUAAAAEbm9uZQ\n-----END OPENSSH PRIVATE KEY-----',
  ].join('\n');
  const r = s.redact(raw);
  for (const secret of ['eyJhbGciOi', 'AbCdEfGhIj', 'ABCDEFGHIJKLMNOPQRST1234', 'ghp_abc', 'AKIAABCD', 'xoxb-123', 'hunter2', 's3cret', 'zzz-123', 'abc123', 'p4ss', 'pw1', 'b3BlbnNzaC1', 'AAAABG5v'])
    assert.ok(!r.includes(secret), `${secret} redacted in: ${r}`);
  assert.match(r, /\[REDACTED PRIVATE KEY\]/);
  // a sample is redacted before it is cut, and never longer than 200 chars
  const long = `${'x'.repeat(180)} -----BEGIN RSA PRIVATE KEY-----\n${'A'.repeat(500)}\n-----END RSA PRIVATE KEY----- password=hunter2`;
  const sm = s.sampleOf(long);
  assert.ok(sm.length <= 200, `sample ${sm.length} chars`);
  assert.ok(!/AAAA|hunter2/.test(sm));
  // the title (normalized text) is redacted too
  assert.ok(!/hunter2|sk-ant/.test(s.normalize('password=hunter2 sk-ant-api03-AAAAAAAAAAAAAAAA')));
});

test('a full scan of two fixture boards: issues, signals, outputs, nothing written inside the boards', () => {
  const root = tmp('full');
  const now = Date.now();
  const A = makeBoard(path.join(root, 'boards', 'a'), { name: 'Board A', port: 4901, now });
  const B = makeBoard(path.join(root, 'boards', 'b'), { name: 'Board B', port: 4902, now, slots: ['gamma-1'] });
  const reg = path.join(root, 'registry');
  writeRegistry(reg, [{ name: 'Board A', port: 4901, dir: A.dir, presence: { name: 'Orch', online: false, pid: 1, start_time: 1, since: new Date(now - 3600e3).toISOString() } }]);
  const out = path.join(root, 'out');
  const before = { a: snapshot(A.dir), b: snapshot(B.dir) };
  const r = cli(['--registry-dir', reg, '--board', B.dir, '--out', out, '--json']);
  assert.strictEqual(r.status, 0, r.stderr);
  const sum = JSON.parse(r.stdout);
  assert.strictEqual(sum.boards, 2);
  assert.strictEqual(sum.readable, 2);
  assert.strictEqual(sum.broken, 6, 'two exits without submit + one stall kill, per board');
  assert.strictEqual(sum.stall_kills, 2);
  assert.strictEqual(sum.exits_without_submit, 4);
  assert.strictEqual(sum.verify_failures, 2);
  assert.strictEqual(sum.reviewer_errors, 2);
  assert.strictEqual(sum.retry_cap_failures, 2);
  assert.strictEqual(sum.stale_open, 2);
  assert.strictEqual(sum.no_orchestrator_with_work, 1, 'only the registered board knows its presence');

  // nothing inside a board changed; the only new files SQLite itself may create are the empty
  // -wal/-shm of a read-only open on a cleanly closed WAL db (a live board already has them)
  for (const [k, B0] of [['a', A], ['b', B]]) {
    const after = snapshot(B0.dir);
    for (const [f, v] of Object.entries(before[k])) assert.strictEqual(after[f], v, `${k}/${f} unchanged`);
    const added = Object.keys(after).filter(f => !(f in before[k]));
    assert.deepStrictEqual(added.filter(f => !/^data\/board\.db-(wal|shm)$/.test(f)), [], `no other files added in ${k}`);
    assert.strictEqual(fs.statSync(path.join(B0.dir, 'data', 'board.db-wal')).size, 0);
  }

  const is = issues(out);
  const exitIssue = is.find(i => i.cause === 'exit_without_submit');
  assert.strictEqual(exitIssue.count, 4, 'the same ENOENT with other numbers/paths groups into one issue across both boards');
  assert.deepStrictEqual(exitIssue.boards.sort(), ['Board A', 'Board B']);
  assert.ok(exitIssue.slots['alpha-1'] && exitIssue.slots['beta-1'] && exitIssue.slots['gamma-1']);
  assert.deepStrictEqual(exitIssue.runners, { claude: 4 });
  assert.ok(exitIssue.example_bounty_ids.length >= 1);
  for (const k of ['signature', 'title', 'first_seen', 'last_seen', 'count', 'boards', 'slots', 'example_bounty_ids', 'sample']) assert.ok(k in exitIssue, k);
  assert.strictEqual(is[0].signature, exitIssue.signature, 'ranked by count');
  for (const i of is) {
    assert.ok(i.sample.length <= 200);
    assert.ok(!/sk-ant|SECRETSECRET|abc\.def\.ghi/.test(JSON.stringify(i)), 'no secret in an issue');
  }
  assert.ok(is.some(i => i.cause === 'watchdog_stall'));
  assert.ok(is.some(i => i.cause === 'verify_failed'));
  assert.ok(is.some(i => i.cause === 'reviewer_error' && i.slots.reviewer && i.runners.codex));
  assert.ok(is.some(i => i.cause === 'retry_cap'));
  assert.ok(is.some(i => i.cause === 'stale_open_attempt'));

  const boards = JSON.parse(fs.readFileSync(path.join(out, 'boards.json'), 'utf8')).boards;
  const a = boards.find(b => b.label === 'Board A').signals;
  assert.strictEqual(a.queue_wait_min.n, 5);
  assert.strictEqual(a.queue_wait_min.max, 120);
  assert.strictEqual(a.queue_wait_min.p50, 60);
  assert.strictEqual(a.queue_wait_min.waiting_now, 1);
  assert.ok(a.attempts_per_bounty.max === 2 && a.attempts_per_bounty.retried === 1);
  const day = new Date(now).toISOString().slice(0, 10);
  const c = a.cost_by_slot_day.filter(x => x.slot === 'beta-1');
  assert.ok(c.length >= 1 && c.reduce((x, y) => x + y.cost_usd, 0) === 1.75, JSON.stringify(a.cost_by_slot_day));
  assert.ok(a.cost_by_slot_day.some(x => x.slot === 'reviewer'));
  assert.ok(a.cost_by_slot_day.every(x => /^\d{4}-\d\d-\d\d$/.test(x.day)) && a.cost_by_slot_day.some(x => x.day <= day));
  assert.ok(a.idle_while_ready['beta-1'] > 0, 'beta-1 sat idle while bounty 1 waited');
  assert.strictEqual(a.stale_open[0].bounty_id, 5);
  assert.ok(a.stale_open[0].minutes_silent >= 119);
  assert.strictEqual(a.orchestrator.no_orchestrator_with_work, true);
  assert.ok(a.orchestrator.minutes_without >= 59);

  const hist = fs.readFileSync(path.join(out, 'history.ndjson'), 'utf8').trim().split('\n');
  assert.strictEqual(hist.length, 1);
  assert.strictEqual(JSON.parse(hist[0]).broken, 6);
  const html = fs.readFileSync(path.join(out, 'report.html'), 'utf8');
  assert.ok(!/(src|href)\s*=\s*["']?(https?:)?\/\//i.test(html), 'no external requests');
  assert.ok(!/<script|<link|@import|url\(/i.test(html));
  assert.match(html, /Day over day/);
  assert.match(html, /Board B/);
  assert.ok(html.includes(exitIssue.signature));
});

test('--out inside a board dir is refused and nothing is written', () => {
  const root = tmp('refuse');
  const A = makeBoard(path.join(root, 'a'), { name: 'A', port: 4911 });
  const reg = path.join(root, 'reg');
  writeRegistry(reg, [{ name: 'A', port: 4911, dir: A.dir }]);
  const before = snapshot(A.dir);
  for (const out of [path.join(A.dir, 'sentinel'), path.join(A.dir, 'data', 'x', 'y'), path.join(A.dir, 'logs'), A.dir]) {
    const r = cli(['--registry-dir', reg, '--out', out]);
    assert.strictEqual(r.status, 2, `refused ${out}`);
    assert.match(r.stderr, /inside a board dir/);
  }
  // a symlink pointing into the board is refused too
  const link = path.join(root, 'link');
  fs.symlinkSync(A.dir, link);
  assert.strictEqual(cli(['--registry-dir', reg, '--out', path.join(link, 'out')]).status, 2);
  // and a --board dir counts like a registered one
  assert.strictEqual(cli(['--registry-dir', path.join(root, 'none'), '--board', A.dir, '--out', path.join(A.dir, 'o')]).status, 2);
  assert.deepStrictEqual(snapshot(A.dir), before);
  // a db_path outside the board dir protects that dir too
  const ext = path.join(root, 'ext');
  fs.mkdirSync(path.join(root, 'c'));
  fs.writeFileSync(path.join(root, 'c', 'board.json'), JSON.stringify({ port: 4912, db_path: path.join(ext, 'b.db'), logs_dir: path.join(ext, 'logs') }));
  assert.strictEqual(cli(['--registry-dir', path.join(root, 'none'), '--board', path.join(root, 'c'), '--out', path.join(ext, 'out')]).status, 2);
});

test('unchanged sources: the second run reads no rows; --force does; a change triggers a scan', () => {
  const root = tmp('fast');
  const A = makeBoard(path.join(root, 'a'), { name: 'A', port: 4921 });
  const out = path.join(root, 'out');
  const args = ['--registry-dir', path.join(root, 'none'), '--board', A.dir, '--out', out, '--json'];
  const r1 = JSON.parse(cli(args).stdout);
  assert.strictEqual(r1.unchanged, false);
  // make the db unreadable without touching its size or mtime: a run that read rows would see it
  fs.chmodSync(A.dbPath, 0o000);
  try {
    const r2 = cli(args);
    assert.strictEqual(r2.status, 0);
    const j2 = JSON.parse(r2.stdout);
    assert.strictEqual(j2.unchanged, true, r2.stdout);
    assert.match(j2.message, /no source db, WAL or log changed/);
    assert.strictEqual(fs.readFileSync(path.join(out, 'history.ndjson'), 'utf8').trim().split('\n').length, 1, 'no history line for an unchanged run');
    const human = cli(args.filter(a => a !== '--json'));
    assert.match(human.stdout, /nothing read/);
    if (process.getuid && process.getuid() !== 0) {
      const r3 = JSON.parse(cli([...args, '--force']).stdout);
      assert.strictEqual(r3.unchanged, false);
      assert.strictEqual(r3.unreadable, 1, '--force read the (now unreadable) db');
    }
  } finally { fs.chmodSync(A.dbPath, 0o644); }
  // a log that grows counts as a change
  // the --force run above stored the fingerprint again, so this is unchanged
  assert.strictEqual(JSON.parse(cli(args).stdout).unchanged, true);
  fs.appendFileSync(path.join(A.logs, fs.readdirSync(A.logs)[0]), 'more\n');
  assert.strictEqual(JSON.parse(cli(args).stdout).unchanged, false);
  assert.strictEqual(JSON.parse(cli(args).stdout).unchanged, true, 'the empty -wal SQLite leaves behind is not a change');
});

test('WAL: a scan sees rows still in the WAL while a writer holds the db open, and the writer can checkpoint after', () => {
  const root = tmp('wal');
  const A = makeBoard(path.join(root, 'a'), { name: 'A', port: 4931, seed: false });
  const w = new Database(A.dbPath);
  w.pragma('journal_mode = WAL');
  w.pragma('wal_autocheckpoint = 0');
  const now = new Date().toISOString();
  const bid = Number(w.prepare("INSERT INTO bounties (title, status) VALUES ('wal', 'blocked')").run().lastInsertRowid);
  for (let i = 0; i < 5; i++) w.prepare(`INSERT INTO attempts (bounty_id, slot, runner, model, started_at, ended_at, exit_code, cost_usd, kind, outcome)
    VALUES (?, 'walslot', 'claude', 'opus', ?, ?, 1, 0.1, 'worker', 'blocked (exited without submit)')`).run(bid, now, now);
  assert.ok(fs.statSync(A.dbPath + '-wal').size > 0, 'rows are in the WAL');
  const r = cli(['--registry-dir', path.join(root, 'none'), '--board', A.dir, '--out', path.join(root, 'out'), '--json']);
  assert.strictEqual(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.strictEqual(j.readable, 1);
  assert.strictEqual(j.attempts, 5, 'saw the five attempts still in the WAL');
  assert.strictEqual(j.exits_without_submit, 5);
  const cp = w.pragma('wal_checkpoint(TRUNCATE)')[0];
  assert.strictEqual(cp.busy, 0, 'nothing held a read transaction');
  assert.strictEqual(fs.statSync(A.dbPath + '-wal').size, 0, 'checkpoint truncated the WAL');
  w.close();
});

test('a locked, missing or foreign board db becomes an issue, not a crash; the run still exits 0', () => {
  const root = tmp('bad');
  const L = makeBoard(path.join(root, 'locked'), { name: 'Locked', port: 4941 });
  const G = makeBoard(path.join(root, 'good'), { name: 'Good', port: 4942 });
  const M = path.join(root, 'missing');
  fs.mkdirSync(M);
  fs.writeFileSync(path.join(M, 'board.json'), JSON.stringify({ name: 'Missing', port: 4943, db_path: 'data/board.db' }));
  const F = path.join(root, 'foreign');
  fs.mkdirSync(path.join(F, 'data'), { recursive: true });
  fs.writeFileSync(path.join(F, 'board.json'), JSON.stringify({ name: 'Foreign', port: 4944, db_path: 'data/board.db' }));
  const f = new Database(path.join(F, 'data', 'board.db')); f.exec('CREATE TABLE t (x)'); f.close();
  const reg = path.join(root, 'reg');
  writeRegistry(reg, [{ name: 'Locked', port: 4941, dir: L.dir }, { name: 'Good', port: 4942, dir: G.dir }, { name: 'Missing', port: 4943, dir: M }, { name: 'Foreign', port: 4944, dir: F }]);
  // an exclusive writer: no reader gets in
  const w = new Database(L.dbPath);
  w.pragma('locking_mode = EXCLUSIVE');
  w.prepare("INSERT INTO bounties (title) VALUES ('lock')").run();
  try {
    const out = path.join(root, 'out');
    const t0 = Date.now();
    const r = cli(['--registry-dir', reg, '--out', out, '--json']);
    assert.ok(Date.now() - t0 < 20000, 'the busy timeout is short');
    assert.strictEqual(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.strictEqual(j.boards, 4);
    assert.strictEqual(j.readable, 1);
    assert.strictEqual(j.unreadable, 3);
    const un = issues(out).filter(i => i.cause === 'board_unreadable');
    const text = JSON.stringify(un);
    assert.match(text, /locked|busy/i);
    assert.match(text, /DB_MISSING/);
    assert.match(text, /NOT_A_BOARD/);
    assert.deepStrictEqual(un.flatMap(i => i.boards).sort(), ['Foreign', 'Locked', 'Missing']);
    assert.ok(fs.existsSync(path.join(out, 'report.html')));
    assert.ok(!fs.existsSync(path.join(M, 'data')), 'nothing created for the missing db');
    const human = cli(['--registry-dir', reg, '--out', out, '--force']);
    assert.strictEqual(human.status, 0);
    assert.match(human.stdout, /3 unreadable/);
  } finally { w.close(); }
});

test('issues keep first_seen across runs, counts are recomputed, a quiet issue stays with count 0', () => {
  const prev = [{ signature: 'aaaa', cause: 'x', title: 'x', first_seen: '2026-01-01T00:00:00.000Z', last_seen: '2026-01-02T00:00:00.000Z', count: 9, boards: ['B'], slots: {}, runners: {}, models: {}, example_bounty_ids: [], sample: 'password=zz' },
    { signature: s.signature('verify_failed', 'boom'), first_seen: '2026-02-01T00:00:00.000Z', count: 50 }];
  const occ = [1, 2].map(n => ({ cause: 'verify_failed', text: 'boom', board: 'B', signature: s.signature('verify_failed', 'boom'), title: 't', at: `2026-11-1${n}T00:00:00.000Z`, bounty_id: n, slot: 's' }));
  const is = s.buildIssues(occ, prev);
  const v = is.find(i => i.cause === 'verify_failed');
  assert.strictEqual(v.count, 2, 'recomputed, not added to the previous 50');
  assert.strictEqual(v.first_seen, '2026-02-01T00:00:00.000Z');
  assert.strictEqual(v.last_seen, '2026-11-12T00:00:00.000Z');
  const q = is.find(i => i.signature === 'aaaa');
  assert.strictEqual(q.count, 0);
  assert.ok(!q.sample.includes('zz'));
  assert.strictEqual(is[0], v);
});

test('--check-install reads systemctl and the last run; tolerates no systemctl', () => {
  const root = tmp('check');
  const out = path.join(root, 'out');
  fs.mkdirSync(out);
  fs.writeFileSync(path.join(out, 'history.ndjson'), JSON.stringify({ at: '2026-11-14T10:00:00.000Z' }) + '\n');
  const ok = s.checkInstall({ out, exec: (cmd, args) => {
    assert.deepStrictEqual([cmd, args[0], args[1], args[2]], ['systemctl', '--user', 'show', 'bounty-sentinel.timer']);
    return { status: 0, stdout: 'LoadState=loaded\nUnitFileState=enabled\nActiveState=active\nLastTriggerUSec=Fri 2026-11-14 10:00:01 UTC\nNextElapseUSecRealtime=Fri 2026-11-14 11:00:00 UTC\n' };
  } });
  assert.strictEqual(ok.installed, true);
  assert.strictEqual(ok.active, true);
  assert.strictEqual(ok.enabled, 'enabled');
  assert.match(ok.last_trigger, /10:00:01/);
  assert.strictEqual(ok.last_run, '2026-11-14T10:00:00.000Z');
  assert.match(s.formatCheck(ok), /installed, active/);
  const none = s.checkInstall({ out, exec: () => ({ status: 0, stdout: 'LoadState=not-found\nUnitFileState=\nActiveState=inactive\nLastTriggerUSec=n/a\n' }) });
  assert.strictEqual(none.installed, false);
  assert.match(s.formatCheck(none), /NOT installed/);
  const noSys = s.checkInstall({ out, exec: () => ({ error: new Error('spawn systemctl ENOENT') }) });
  assert.strictEqual(noSys.installed, false);
  assert.strictEqual(noSys.systemctl, false);
  // the real command runs and exits 0 whatever the machine has
  const r = cli(['--check-install', '--out', out, '--json']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok('installed' in JSON.parse(r.stdout));
});

test('default out dir follows XDG_STATE_HOME, else ~/.local/state', () => {
  const old = process.env.XDG_STATE_HOME;
  try {
    process.env.XDG_STATE_HOME = '/x/state';
    assert.strictEqual(s.defaultOutDir(), path.join('/x/state', 'bounty-board', 'sentinel'));
    delete process.env.XDG_STATE_HOME;
    assert.strictEqual(s.defaultOutDir(), path.join(os.homedir(), '.local', 'state', 'bounty-board', 'sentinel'));
  } finally { if (old === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = old; }
  const root = tmp('xdg');
  const A = makeBoard(path.join(root, 'a'), { name: 'A', port: 4951 });
  const r = cli(['--registry-dir', path.join(root, 'none'), '--board', A.dir, '--json'], { XDG_STATE_HOME: path.join(root, 'state') });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(root, 'state', 'bounty-board', 'sentinel', 'report.html')));
});

test('systemd: a generic oneshot service and an hourly persistent timer', () => {
  const dir = path.join(__dirname, '..', 'systemd');
  const svc = fs.readFileSync(path.join(dir, 'bounty-sentinel.service'), 'utf8');
  const tim = fs.readFileSync(path.join(dir, 'bounty-sentinel.timer'), 'utf8');
  assert.match(svc, /^Type=oneshot$/m);
  assert.match(svc, /^ExecStart=.*bin\/bounty sentinel$/m);
  assert.match(tim, /^OnCalendar=hourly$/m);
  assert.match(tim, /^Persistent=true$/m);
  assert.match(tim, /^WantedBy=timers\.target$/m);
  for (const t of [svc, tim]) assert.ok(!/\/home\/|\/mnt\//.test(t), 'generic paths only (%h)');
});
