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
  assert.strictEqual(sum.no_orchestrator_with_work, 2, 'board A: registered offline; board B: no orchestrator registered at all');

  // nothing inside a board changed or was added: a closed board (no -wal/-shm) is read from a copy,
  // so SQLite does not create its sidecars next to the board's db either
  for (const [k, B0] of [['a', A], ['b', B]]) assert.deepStrictEqual(snapshot(B0.dir), before[k], `board ${k} untouched`);

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
    const hl = fs.readFileSync(path.join(out, 'history.ndjson'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.strictEqual(hl.length, 2, 'one history line per run');
    assert.strictEqual(hl[1].unchanged, true);
    assert.strictEqual(hl[1].broken, undefined, 'an unchanged run carries no figures (it read nothing)');
    // report.html is rebuilt on the fast path from the stored results and the history so far
    const html = fs.readFileSync(path.join(out, 'report.html'), 'utf8');
    assert.ok(html.includes(`checked ${j2.at}`), 'the report says when it was last checked');
    assert.ok(html.includes(`last full scan ${r1.at}`));
    assert.ok(html.includes(`<td>${j2.at.slice(0, 10)}</td><td>2</td>`), 'the trend row for today counts both runs');
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
  assert.strictEqual(JSON.parse(cli(args).stdout).unchanged, true);
  // an empty -wal (what a reader of a cleanly closed WAL db can leave behind) is not a change
  fs.writeFileSync(A.dbPath + '-wal', '');
  assert.strictEqual(JSON.parse(cli(args).stdout).unchanged, true, 'empty -wal is the same as none');
  // a registry entry rewritten (an orchestrator's last_seen moves every few seconds) is not a change
  const reg = path.join(root, 'reg');
  writeRegistry(reg, [{ name: 'A', port: 4921, dir: A.dir, presence: { name: 'o', online: false, last_seen: '2026-11-01T00:00:00Z' } }]);
  const rargs = ['--registry-dir', reg, '--out', path.join(root, 'out2'), '--json'];
  assert.strictEqual(JSON.parse(cli(rargs).stdout).unchanged, false);
  writeRegistry(reg, [{ name: 'A', port: 4921, dir: A.dir, presence: { name: 'o', online: false, last_seen: '2026-11-02T00:00:00Z' } }]);
  fs.utimesSync(path.join(reg, '4921.json'), new Date(), new Date(Date.now() + 5000));
  assert.strictEqual(JSON.parse(cli(rargs).stdout).unchanged, true, 'registry rewrite alone is not a change');
  // a new board in the registry is
  const B = makeBoard(path.join(root, 'b'), { name: 'B', port: 4922 });
  writeRegistry(reg, [{ name: 'A', port: 4921, dir: A.dir }, { name: 'B', port: 4922, dir: B.dir }]);
  assert.strictEqual(JSON.parse(cli(rargs).stdout).unchanged, false, 'a board added is a change');
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

test('signals: a configured slot that never ran counts as idle; in_progress without spawn is a claim; an entry without board_dir is an issue', () => {
  const now = Date.parse('2026-11-14T12:00:00Z');
  const t = m => new Date(now - m * 60000).toISOString();
  const board = { label: 'X', stall_minutes: 30, slots: ['busy-1', 'never-1'], run: '/nonexistent', entry: null };
  const rows = {
    attempts: [{ id: 1, bounty_id: 2, slot: 'busy-1', runner: 'claude', model: 'm', started_at: t(100), ended_at: t(40), exit_code: 0, kind: 'worker', outcome: 'review' }],
    events: [
      { id: 1, bounty_id: 1, at: t(120), kind: 'status', to_status: 'ready' },
      { id: 2, bounty_id: 1, at: t(60), kind: 'status', to_status: 'in_progress' },   // claimed by hand, no spawn
      { id: 3, bounty_id: 1, at: t(50), kind: 'status', to_status: 'ready' },
      { id: 4, bounty_id: 1, at: t(20), kind: 'spawn' },
      { id: 5, bounty_id: 2, at: t(110), kind: 'status', to_status: 'ready' },
      { id: 6, bounty_id: 2, at: t(100), kind: 'spawn' },
    ],
    bounties: [{ id: 1, status: 'in_progress' }, { id: 2, status: 'review' }],
  };
  const a = s.analyze(board, rows, { nowMs: now, sinceMs: now - 72 * 3600000 });
  const q = a.signals.queue_wait_min;
  assert.strictEqual(q.n, 3, 'ready->in_progress, ready->spawn, ready->spawn');
  assert.strictEqual(q.max, 60, 'the second wait is measured from the second ready, not the first');
  // waits 120->60, 50->20 and 110->100 overlap: their union is 120->60 plus 50->20, 90 minutes
  assert.strictEqual(a.signals.ready_waiting_min, 90);
  assert.strictEqual(a.signals.idle_while_ready['never-1'], 90, 'never-1 idle through the union of the waits');
  assert.strictEqual(a.signals.idle_while_ready['busy-1'], 20 + 20, 'busy-1 idle only outside its attempt (100->40)');

  const root = tmp('nodir');
  const reg = path.join(root, 'reg');
  fs.mkdirSync(reg);
  fs.writeFileSync(path.join(reg, '4999.json'), JSON.stringify({ name: 'Old', port: 4999, pid: 0, stopped_at: '2026-01-01T00:00:00Z' }));
  const out = path.join(root, 'out');
  const r = cli(['--registry-dir', reg, '--out', out, '--json']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(JSON.parse(r.stdout).unreadable, 1);
  assert.ok(issues(out).some(i => i.cause === 'board_unreadable' && /NO_BOARD_DIR/.test(i.sample)));
});

test('report trend: unchanged runs count as runs, the day keeps its last full scan figures', () => {
  const { trend } = require('../lib/sentinel-report');
  const d = trend([
    { at: '2026-11-13T10:00:00Z', last24h: { broken: 4 } },
    { at: '2026-11-13T11:00:00Z', unchanged: true },
    { at: '2026-11-14T09:00:00Z', unchanged: true },
  ]);
  assert.deepStrictEqual(d.map(([k, h]) => [k, h.runs, h.last24h.broken]), [['2026-11-13', 2, 4], ['2026-11-14', 1, undefined]]);
});

test('signals: overlapping ready waits count once; waits and pending work crossing --since are measured from when they began', () => {
  const now = Date.parse('2026-11-14T12:00:00Z');
  const t = m => new Date(now - m * 60000).toISOString();
  const board = { label: 'X', stall_minutes: 30, slots: ['s-1', 's-2'], run: '/nonexistent', entry: null };
  const sinceMs = now - 120 * 60000;   // a 2 h window
  const rows = {
    attempts: [{ id: 1, bounty_id: 3, slot: 's-1', runner: 'claude', model: 'm', started_at: t(150), ended_at: t(90), exit_code: 0, kind: 'worker', outcome: 'review' }],
    // bounty 3 went ready at 200 (before the window) and was spawned at 150 (also before): no wait in the window
    // bounty 4 went ready at 180 (before the window), claimed at 100: a 80 min wait that ends in the window
    // bounty 5 went ready at 300 (before the window) and still waits
    prior: [
      { id: 1, bounty_id: 3, at: t(200), kind: 'status', to_status: 'ready' },
      { id: 2, bounty_id: 3, at: t(150), kind: 'spawn' },
      { id: 3, bounty_id: 4, at: t(180), kind: 'status', to_status: 'ready' },
      { id: 4, bounty_id: 5, at: t(300), kind: 'status', to_status: 'ready' },
    ],
    events: [
      { id: 10, bounty_id: 4, at: t(100), kind: 'spawn' },
      { id: 11, bounty_id: 4, at: t(100), kind: 'status', to_status: 'in_progress' },
      { id: 12, bounty_id: 4, at: t(40), kind: 'status', to_status: 'review' },
      // two bounties ready together for the same 60 minutes
      { id: 13, bounty_id: 6, at: t(70), kind: 'status', to_status: 'ready' },
      { id: 14, bounty_id: 7, at: t(70), kind: 'status', to_status: 'ready' },
      { id: 15, bounty_id: 6, at: t(10), kind: 'spawn' },
      { id: 16, bounty_id: 7, at: t(10), kind: 'spawn' },
    ],
    bounties: [{ id: 3, status: 'review' }, { id: 4, status: 'review' }, { id: 5, status: 'ready' }, { id: 6, status: 'in_progress' }, { id: 7, status: 'in_progress' }],
  };
  const a = s.analyze(board, rows, { nowMs: now, sinceMs }).signals;
  const q = a.queue_wait_min;
  assert.strictEqual(q.n, 3, 'bounty 4 (began before --since) and bounties 6 and 7; not bounty 3 (ended before)');
  assert.strictEqual(q.max, 80, 'bounty 4 is measured from its ready before the window');
  assert.strictEqual(q.waiting_now, 1);
  assert.strictEqual(q.longest_waiting_now, 300, 'bounty 5 waits since before the window');
  // ready time in the window: bounty 5 waits through all of it, so the union is the whole 120 minutes
  assert.strictEqual(a.ready_waiting_min, 120);
  assert.strictEqual(a.idle_while_ready['s-2'], 120, 'a slot that never ran: idle the whole window, not 120+80+60+60');
  assert.strictEqual(a.idle_while_ready['s-1'], 120 - 30, 's-1 ran 120->90 of the window');
  assert.strictEqual(a.board_idle_with_ready_min, 90);

  // the two simultaneous 60 min waits alone: 60 idle minutes, not 120
  const two = { attempts: [], prior: [], events: rows.events.filter(e => e.bounty_id >= 6), bounties: rows.bounties.filter(x => x.id >= 6) };
  const b = s.analyze(board, two, { nowMs: now, sinceMs }).signals;
  assert.strictEqual(b.ready_waiting_min, 60);
  assert.strictEqual(b.idle_while_ready['s-2'], 60);
  assert.strictEqual(b.board_idle_with_ready_min, 60);
});

test('signals: no-orchestrator time is the overlap of pending work and offline time; an unregistered orchestrator is offline', () => {
  const now = Date.parse('2026-11-14T12:00:00Z');
  const t = m => new Date(now - m * 60000).toISOString();
  const sinceMs = now - 72 * 3600000;
  const offline = since => ({ label: 'X', stall_minutes: 30, slots: [], run: '/nonexistent', entry: { presence: { name: 'o', online: false, since } } });
  // work became ready 5 minutes ago; the orchestrator went offline 3 h ago
  const five = { attempts: [], prior: [], events: [{ id: 1, bounty_id: 1, at: t(5), kind: 'status', to_status: 'ready' }], bounties: [{ id: 1, status: 'ready' }] };
  let o = s.analyze(offline(t(180)), five, { nowMs: now, sinceMs });
  assert.strictEqual(o.signals.orchestrator.no_orchestrator_with_work, true);
  assert.strictEqual(o.signals.orchestrator.minutes_without, 5, 'not the 180 minutes it has been offline');
  assert.ok(o.occurrences.some(x => x.cause === 'no_orchestrator'));
  // offline 3 h ago, work pending 10 h (since before a 2 h window): the overlap is 120 minutes in a 2 h window, 180 in 72 h
  const long = { attempts: [], prior: [{ id: 1, bounty_id: 1, at: t(600), kind: 'status', to_status: 'ready' }], events: [], bounties: [{ id: 1, status: 'ready' }] };
  assert.strictEqual(s.analyze(offline(t(180)), long, { nowMs: now, sinceMs: now - 120 * 60000 }).signals.orchestrator.minutes_without, 120);
  assert.strictEqual(s.analyze(offline(t(180)), long, { nowMs: now, sinceMs }).signals.orchestrator.minutes_without, 180);
  // pending 60->30 only (then done), offline the whole time: 30 minutes, nothing pending now, still an issue
  const past = { attempts: [], prior: [], events: [{ id: 1, bounty_id: 1, at: t(60), kind: 'status', to_status: 'ready' }, { id: 2, bounty_id: 1, at: t(30), kind: 'status', to_status: 'done' }], bounties: [{ id: 1, status: 'done' }] };
  o = s.analyze(offline(t(1000)), past, { nowMs: now, sinceMs });
  assert.strictEqual(o.signals.orchestrator.no_orchestrator_with_work, false);
  assert.strictEqual(o.signals.orchestrator.minutes_without, 30);
  // no presence at all (no registry presence, no run/orchestrator.json): offline, not unknown
  const none = { label: 'X', stall_minutes: 30, slots: [], run: '/nonexistent', entry: null };
  o = s.analyze(none, five, { nowMs: now, sinceMs });
  assert.strictEqual(o.signals.orchestrator.known, false);
  assert.strictEqual(o.signals.orchestrator.no_orchestrator_with_work, true);
  assert.strictEqual(o.signals.orchestrator.minutes_without, 5);
  assert.ok(o.occurrences.some(x => x.cause === 'no_orchestrator' && /no orchestrator registered/.test(x.text)));
  // an online orchestrator: none
  const st = require('../lib/proc').procStat(process.pid);
  const online = { label: 'X', stall_minutes: 30, slots: [], run: '/nonexistent', entry: { presence: { name: 'o', online: true, pid: process.pid, start_time: st.start_time, since: t(10) } } };
  o = s.analyze(online, five, { nowMs: now, sinceMs });
  assert.strictEqual(o.signals.orchestrator.minutes_without, 0);
  assert.ok(!o.occurrences.some(x => x.cause === 'no_orchestrator'));
});

test('fast path: with no source changed, an open attempt crossing the stall threshold or an orchestrator coming online still triggers a scan', () => {
  const root = tmp('elapsed');
  const now = Date.now();
  const A = makeBoard(path.join(root, 'a'), { name: 'A', port: 4941, seed: false, stallMinutes: 30, keepOpen: true });
  const bid = Number(A.db.prepare("INSERT INTO bounties (title, status) VALUES ('x', 'in_progress')").run().lastInsertRowid);
  A.db.prepare("INSERT INTO events (bounty_id, at, actor, kind, to_status) VALUES (?, ?, 'board', 'status', 'in_progress')").run(bid, new Date(now - 5 * 60000).toISOString());
  const log = path.join(A.logs, 'open.log');
  fs.writeFileSync(log, 'working\n');
  fs.utimesSync(log, new Date(now - 5 * 60000), new Date(now - 5 * 60000));
  A.db.prepare("INSERT INTO attempts (bounty_id, slot, runner, started_at, log_path, kind) VALUES (?, 'alpha-1', 'claude', ?, ?, 'worker')").run(bid, new Date(now - 5 * 60000).toISOString(), log);
  A.db.close();
  const reg = path.join(root, 'reg');
  const offline = { name: 'o', online: false, pid: 1, start_time: 1, since: new Date(now - 3600e3).toISOString() };
  writeRegistry(reg, [{ name: 'A', port: 4941, dir: A.dir, presence: offline }]);
  const out = path.join(root, 'out');
  const opts = { registryDir: reg, out };
  const r1 = s.run({ ...opts, now });
  assert.strictEqual(r1.unchanged, false);
  assert.strictEqual(r1.stale_open, 0, 'log written 5 minutes ago');
  assert.strictEqual(s.run({ ...opts, now: now + 10 * 60000 }).unchanged, true, '15 minutes silent: still under the threshold, nothing read');
  // 40 minutes later: no file changed, but the attempt is now past the 30 min threshold
  const r3 = s.run({ ...opts, now: now + 35 * 60000 });
  assert.strictEqual(r3.unchanged, false);
  assert.match(r3.rescan_reason, /stall threshold/);
  assert.strictEqual(r3.stale_open, 1);
  assert.ok(issues(out).some(i => i.cause === 'stale_open_attempt' && i.count === 1));
  assert.strictEqual(s.run({ ...opts, now: now + 36 * 60000 }).unchanged, true, 'already reported: back to the fast path');
  // the orchestrator comes online: only the registry entry changed, which the fingerprint ignores
  const st = require('../lib/proc').procStat(process.pid);
  writeRegistry(reg, [{ name: 'A', port: 4941, dir: A.dir, presence: { name: 'o', online: true, pid: process.pid, start_time: st.start_time, since: new Date(now + 36 * 60000).toISOString() } }]);
  const r5 = s.run({ ...opts, now: now + 37 * 60000 });
  assert.strictEqual(r5.unchanged, false);
  assert.match(r5.rescan_reason, /went online/);
  assert.strictEqual(r5.no_orchestrator_with_work, 0);
  const b5 = JSON.parse(fs.readFileSync(path.join(out, 'boards.json'), 'utf8')).boards[0].signals.orchestrator;
  assert.strictEqual(b5.minutes_without, 41, 'online now, but pending work waited -5..+36 with none online: not lost');
  assert.strictEqual(s.run({ ...opts, now: now + 38 * 60000 }).unchanged, true);
  // and goes offline again (its pid gone): a scan, and the pending work without it is an issue again
  writeRegistry(reg, [{ name: 'A', port: 4941, dir: A.dir, presence: { ...offline, since: new Date(now + 38 * 60000).toISOString() } }]);
  const r7 = s.run({ ...opts, now: now + 50 * 60000 });
  assert.strictEqual(r7.unchanged, false);
  assert.match(r7.rescan_reason, /went offline/);
  assert.strictEqual(r7.no_orchestrator_with_work, 1);
  const b7 = JSON.parse(fs.readFileSync(path.join(out, 'boards.json'), 'utf8')).boards[0].signals.orchestrator;
  assert.strictEqual(b7.minutes_without, 53, 'pending from -5 the whole time; offline -5..+36 (seen by the first runs, kept though it came online since) and +38..+50');
  assert.strictEqual(s.run({ ...opts, now: now + 51 * 60000 }).unchanged, true);
});

test('signals: offline spells earlier in the window count while the orchestrator is online now (board presence notes and the note before the window)', () => {
  const now = Date.parse('2026-11-14T12:00:00Z');
  const t = m => new Date(now - m * 60000).toISOString();
  const sinceMs = now - 72 * 3600000;
  const st = require('../lib/proc').procStat(process.pid);
  const online = since => ({ label: 'X', stall_minutes: 30, slots: [], run: '/nonexistent', entry: { presence: { name: 'o', online: true, pid: process.pid, start_time: st.start_time, since } } });
  const note = (id, m, n) => ({ id, bounty_id: null, at: t(m), actor: 'board', kind: 'note', note: n });
  // pending since 300 min ago; online until the board saw it gone 240 min ago, registered again 120 min ago
  const rows = { attempts: [], prior: [], priorPresence: [],
    events: [{ id: 1, bounty_id: 1, at: t(300), kind: 'status', to_status: 'ready' }, note(2, 240, "orchestrator 'o' (pid 7) is offline: its process is gone"), note(3, 120, "orchestrator 'o' registered, pid 8")],
    bounties: [{ id: 1, status: 'ready' }] };
  let o = s.analyze(online(t(120)), rows, { nowMs: now, sinceMs }).signals.orchestrator;
  assert.strictEqual(o.online, true);
  assert.strictEqual(o.no_orchestrator_with_work, false, 'online now');
  assert.strictEqual(o.minutes_without, 120, 'the 240..120 spell is kept');
  const occ = s.analyze(online(t(120)), rows, { nowMs: now, sinceMs }).occurrences.filter(x => x.cause === 'no_orchestrator');
  assert.strictEqual(occ.length, 1);
  assert.strictEqual(occ[0].at, t(120), 'last seen when the spell ended, not at every later scan');
  // the window opens after the registration that started the spell: the last note before it says how it opened
  const r2 = { attempts: [], prior: [{ id: 1, bounty_id: 1, at: t(600), kind: 'status', to_status: 'ready' }], events: [], bounties: [{ id: 1, status: 'ready' }],
    priorPresence: [note(9, 500, "orchestrator 'o' (pid 7) is offline: its process is gone")] };
  o = s.analyze(online(t(30)), r2, { nowMs: now, sinceMs: now - 120 * 60000 }).signals.orchestrator;
  assert.strictEqual(o.minutes_without, 90, 'offline when the 2 h window opened, online 30 min ago');
  r2.priorPresence = [note(9, 500, "orchestrator 'o' registered, pid 7")];
  o = s.analyze(online(t(500)), r2, { nowMs: now, sinceMs: now - 120 * 60000 }).signals.orchestrator;
  assert.strictEqual(o.minutes_without, 0, 'online the whole window');
  // the sentinel's own earlier observations count too (a board too old to write presence notes)
  const bare = { attempts: [], prior: [{ id: 1, bounty_id: 1, at: t(600), kind: 'status', to_status: 'ready' }], events: [], bounties: [{ id: 1, status: 'ready' }] };
  o = s.analyze(online(t(30)), bare, { nowMs: now, sinceMs: now - 300 * 60000, presenceLog: [{ t: now - 400 * 60000, online: true }, { t: now - 200 * 60000, online: false }] }).signals.orchestrator;
  assert.strictEqual(o.minutes_without, 170, 'seen offline from 200 min ago until it came online 30 min ago');
  assert.strictEqual(o.offline_min, 170);
  // an offline presence with no usable since (an older registry entry) and nothing else known: offline the whole window
  const nosince = { label: 'X', stall_minutes: 30, slots: [], run: '/nonexistent', entry: { presence: { name: 'o', online: false, since: null } } };
  o = s.analyze(nosince, bare, { nowMs: now, sinceMs: now - 300 * 60000 }).signals.orchestrator;
  assert.strictEqual(o.minutes_without, 300);
  // the shape a board writes when nobody ever registered (registered: false, no pid or name) is no orchestrator registered
  const never = { label: 'X', stall_minutes: 30, slots: [], run: '/nonexistent', entry: { presence: { name: null, expected_name: 'o', online: false, pid: null, since: null, last_seen: null, registered: false } } };
  const nv = s.analyze(never, bare, { nowMs: now, sinceMs: now - 300 * 60000 });
  assert.strictEqual(nv.signals.orchestrator.known, false);
  assert.strictEqual(nv.signals.orchestrator.minutes_without, 300);
  assert.ok(nv.occurrences.some(x => x.cause === 'no_orchestrator' && /no orchestrator registered/.test(x.text) && x.at === new Date(now).toISOString()), 'still offline: last seen now');
  // ... unless a presence note dates it: offline only from the note on
  o = s.analyze(nosince, { ...bare, events: [note(5, 100, "orchestrator 'o' (pid 7) is offline: its process is gone")] }, { nowMs: now, sinceMs: now - 300 * 60000 }).signals.orchestrator;
  assert.strictEqual(o.minutes_without, 100);
});

test('verify crashes hash their real error: different errors are different issues, the same one with other numbers is one', () => {
  const now = Date.parse('2026-11-14T12:00:00Z');
  const b = { label: 'X', stall_minutes: 30, slots: [], run: '/nonexistent', entry: null };
  const crash = (id, n) => ({ id, bounty_id: id, at: new Date(now - id * 60000).toISOString(), actor: 'board', kind: 'verify', note: n });
  const rows = { attempts: [], prior: [], bounties: [], events: [
    crash(1, 'verify crashed: ENOSPC: no space left on device, write'), crash(2, 'verify crashed: SqliteError: database is locked'),
    crash(3, 'verify crashed: ENOSPC: no space left on device, write'), crash(4, 'verify FAILED (exit 1): npm test; log /tmp/a/v-123.log'),
    crash(5, 'verify FAILED (exit 2): npm test; log /tmp/b/v-456.log')] };
  const occ = s.analyze(b, rows, { nowMs: now, sinceMs: now - 3600e3 }).occurrences;
  const sig = cause => [...new Set(occ.filter(o => o.cause === cause).map(o => o.signature))];
  assert.strictEqual(sig('verify_crashed').length, 2, 'ENOSPC and database locked are two issues');
  assert.ok(occ.some(o => o.cause === 'verify_crashed' && /no space left/.test(o.title)));
  assert.ok(occ.some(o => o.cause === 'verify_crashed' && /database is locked/.test(o.title)));
  assert.strictEqual(occ.filter(o => o.cause === 'verify_crashed').length, 3);
  assert.strictEqual(sig('verify_failed').length, 1, 'the same failure with another exit code and log path');
});

test('readBoard: the last presence note before the window is read from the db', () => {
  const root = tmp('prior-presence');
  const A = makeBoard(path.join(root, 'a'), { name: 'A', port: 4951, seed: false, keepOpen: true });
  const now = Date.now(), at = m => new Date(now - m * 60000).toISOString();
  const ins = A.db.prepare("INSERT INTO events (bounty_id, at, actor, kind, note) VALUES (NULL, ?, 'board', 'note', ?)");
  ins.run(at(600), "orchestrator 'o' registered, pid 7");
  ins.run(at(500), "orchestrator 'o' (pid 7) is offline: its process is gone");
  ins.run(at(400), 'idle shutdown after 30 min idle: stopped nothing (all gone)');
  ins.run(at(10), "orchestrator 'o' registered, pid 8");
  A.db.close();
  const b = s.resolveBoard(A.dir);
  const rows = s.readBoard(b, { sinceMs: now - 120 * 60000 });
  assert.deepStrictEqual(rows.priorPresence.map(e => e.note), ["orchestrator 'o' (pid 7) is offline: its process is gone"]);
  assert.ok(rows.events.some(e => /registered, pid 8/.test(e.note)));
});
