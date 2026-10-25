// The agent manifest and lifecycle (lib/agents.js) with real child processes: workers and
// registered agents stopped when their bounty is done/failed, the pid identity check, the idle
// shutdown and `bounty cleanup`. Every child a test starts is killed by its own pid at the end.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { startBoard, waitFor, sh, ROOT } = require('./helpers');
const { procStat } = require('../lib/agents');

const CRIT = ['math.js exports mul(a, b) returning the product', 'a node:test covers mul'];
const alive = pid => !!procStat(pid);

// A child the test owns. detached: its own process group, like a board worker.
const mine = [];
function child(cmd = 'sleep 600', { detached = true } = {}) {
  const c = spawn('bash', ['-c', cmd], { detached, stdio: 'ignore' });
  mine.push(c.pid);
  return c.pid;
}
function killMine() {
  while (mine.length) { const p = mine.pop(); try { process.kill(-p, 'SIGKILL'); } catch {} try { process.kill(p, 'SIGKILL'); } catch {} }
}

function cli(url, args, env = {}) {
  return new Promise(resolve => execFile(process.execPath, [path.join(ROOT, 'bin', 'bounty'), ...args],
    { env: { ...process.env, BOUNTY_URL: url, BOUNTY_SLOT: '', BOUNTY_ID: '', ...env } },
    (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr })));
}

const manifest = t => JSON.parse(fs.readFileSync(path.join(t.dir, 'run', 'agents.json'), 'utf8')).agents;
const notes = (t, id) => t.board.db.prepare('SELECT note FROM events WHERE bounty_id IS ? ORDER BY id').all(id).map(e => e.note).join('\n');

test('board worker: stopped (process group) when its bounty is merged and done; manifest entry recorded then dropped', async () => {
  const t = await startBoard('agents-done');
  try {
    const { board, repo } = t;
    const b = board.create({ title: 'Add mul() with a test', project: 'scratch', criteria: CRIT, assignee_slot: 'fake-1', description: 'mode:linger' });
    board.ready(b.id);
    await waitFor(() => board.raw(b.id).status === 'approved', 30000);
    const att = board.get(b.id).attempts.find(a => a.kind === 'worker');
    assert.ok(alive(att.pid), 'the lingering worker is still running after its submit');
    const e = manifest(t).find(x => x.pid === att.pid);
    assert.ok(e, 'worker is in run/agents.json');
    assert.strictEqual(e.kind, 'worker'); assert.strictEqual(e.source, 'board');
    assert.strictEqual(e.slot, 'fake-1'); assert.strictEqual(e.bounty, b.id); assert.strictEqual(e.attempt, 1);
    assert.strictEqual(e.start_time, procStat(att.pid).start_time);
    sh(repo, `git merge -q --no-ff ${board.raw(b.id).branch} -m "merge"`);
    await waitFor(() => board.raw(b.id).status === 'done', 10000);
    await waitFor(() => !alive(att.pid), 10000);
    assert.match(notes(t, b.id), /stopping worker 'Alpha' \(pid \d+\): bounty #\d+ is done; SIGTERM to its process group/);
    await waitFor(() => !manifest(t).some(x => x.pid === att.pid), 5000);
    assert.strictEqual(board.raw(b.id).status, 'done', 'the exit does not move a done bounty');
  } finally { killMine(); await t.s.close(); }
});

test('registered agents: stopped when their bounty is done (close-merged); orchestrators and other bounties untouched; TERM-ignorers get KILL', async () => {
  const t = await startBoard('agents-reg', { dispatch: false });
  try {
    const { board, repo, call } = t;
    const b = board.create({ title: 'external', project: 'scratch', criteria: CRIT });
    const other = board.create({ title: 'other', project: 'scratch', criteria: CRIT });
    const helper = child('sleep 600');
    const stubborn = child('trap "" TERM; sleep 600 & wait');
    const orch = child('sleep 600');
    const elsewhere = child('sleep 600');
    for (const [pid, name, kind, bounty] of [[helper, 'Helper', 'worker', b.id], [stubborn, 'Bridge', 'bridge', b.id], [orch, 'Boss', 'orchestrator', b.id], [elsewhere, 'Other', 'worker', other.id]]) {
      const r = await cli(t.url, ['agents', 'register', '--pid', String(pid), '--name', name, '--kind', kind, '--bounty', String(bounty)]);
      assert.strictEqual(r.code, 0, r.stderr);
    }
    assert.strictEqual(manifest(t).length, 4);
    // a worker slot may register only for a bounty, and never an orchestrator
    assert.strictEqual((await call('POST', '/agents/spawned', { pid: helper, name: 'x', kind: 'orchestrator', bounty: b.id }, 'fake-1')).status, 403);
    assert.strictEqual((await call('POST', '/agents/spawned', { pid: 999999999, name: 'x' })).status, 404, 'a pid that is not running');
    sh(repo, 'git checkout -q -b ext && echo x > ext.js && git add -A && git commit -qm ext && git checkout -q main && git merge -q --no-ff ext -m m');
    const sha = sh(repo, 'git rev-parse ext').trim();
    assert.strictEqual((await call('POST', `/bounties/${b.id}/close-merged`, { commits: [sha] })).status, 200);
    await waitFor(() => !alive(helper), 5000);
    assert.ok(alive(stubborn), 'ignores SIGTERM: still up inside the grace period');
    await waitFor(() => !alive(stubborn), 5000); // stop_grace_seconds defaults to the watchdog grace (1 s here)
    assert.ok(alive(orch), 'an orchestrator is never stopped by bounty completion');
    assert.ok(alive(elsewhere), 'an agent of another bounty is untouched');
    const n = notes(t, b.id);
    assert.match(n, /stopping worker 'Helper'/);
    assert.match(n, /bridge 'Bridge' \(pid \d+\) ignored SIGTERM; sent SIGKILL/);
    // failed works the same way
    board.fail(other.id, 'not needed');
    await waitFor(() => !alive(elsewhere), 5000);
    // dead entries are dropped (once the grace timer of a stop has run)
    await waitFor(() => { board.agents.prune(); return manifest(t).map(e => e.name).join() === 'Boss'; }, 5000);
  } finally { killMine(); await t.s.close(); }
});

test('identity check: a recorded pid whose start time no longer matches is never signalled', async () => {
  const t = await startBoard('agents-reuse', { dispatch: false });
  try {
    const { board } = t;
    const b = board.create({ title: 'x', project: 'scratch', criteria: CRIT });
    const victim = child('sleep 600');
    board.agents.register({ pid: victim, name: 'Old', kind: 'worker', bounty: b.id });
    // Simulate pid reuse: the manifest says the recorded process started at another time.
    const file = path.join(t.dir, 'run', 'agents.json');
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    j.agents[0].start_time -= 12345;
    fs.writeFileSync(file, JSON.stringify(j));
    board.fail(b.id, 'done with it');
    await new Promise(r => setTimeout(r, 1500)); // past the grace period
    assert.ok(alive(victim), 'the process now holding that pid is untouched');
    assert.match(notes(t, b.id), /pid \d+ now belongs to another process .*not signalled/);
    assert.strictEqual(manifest(t).length, 0, 'the stale entry is dropped');
    // and cleanup --kill --all does not touch it either (it is no longer ours)
    j.agents[0].bounty = null; fs.writeFileSync(file, JSON.stringify(j));
    const r = await cli(t.url, ['cleanup', '--kill', '--all', '--json']);
    assert.strictEqual(JSON.parse(r.stdout).agents.length, 0);
    await new Promise(r2 => setTimeout(r2, 1200));
    assert.ok(alive(victim));
  } finally { killMine(); await t.s.close(); }
});

test('idle shutdown: no active bounty (or paused) for idle_shutdown_minutes stops every non-orchestrator agent', async () => {
  const t = await startBoard('agents-idle', { dispatch: false, over: { idle_shutdown_minutes: 0.02 } }); // 1.2 s
  try {
    const { board } = t;
    const b = board.create({ title: 'busy', project: 'scratch', criteria: CRIT });
    board.ready(b.id); board.start(b.id, 'fake-1'); // in_progress: the board is not idle
    const w = child('sleep 600'), br = child('sleep 600'), o = child('sleep 600');
    board.agents.register({ pid: w, name: 'Hand', kind: 'worker' });
    board.agents.register({ pid: br, name: 'Cloud', kind: 'bridge' });
    board.agents.register({ pid: o, name: 'Boss', kind: 'orchestrator' });
    await new Promise(r => setTimeout(r, 1500));
    assert.deepStrictEqual(board.agents.sweep(), [], 'a bounty in progress keeps the board busy');
    assert.ok(alive(w) && alive(br));
    board.setPaused(true); // paused counts as idle
    await new Promise(r => setTimeout(r, 1500));
    const out = board.agents.sweep();
    assert.deepStrictEqual(out.map(x => x.name).sort(), ['Cloud', 'Hand']);
    await waitFor(() => !alive(w) && !alive(br), 5000);
    assert.ok(alive(o), 'orchestrators are never idle-stopped');
    assert.match(notes(t, null), /idle shutdown after \d+ min idle: stopped .*Hand.*Cloud|idle shutdown after \d+ min idle: stopped .*Cloud.*Hand/);
  } finally { killMine(); await t.s.close(); }
});

test('idle shutdown runs on the dispatcher timer and 0 disables it', async () => {
  const on = await startBoard('agents-idle-timer', { over: { idle_shutdown_minutes: 0.02 } });
  const off = await startBoard('agents-idle-off', { over: { idle_shutdown_minutes: 0 } });
  try {
    const a = child('sleep 600'), z = child('sleep 600');
    on.board.agents.register({ pid: a, name: 'A', kind: 'bridge' });
    off.board.agents.register({ pid: z, name: 'Z', kind: 'bridge' });
    await waitFor(() => !alive(a), 10000);
    await new Promise(r => setTimeout(r, 1500));
    assert.ok(alive(z), 'idle_shutdown_minutes 0: nothing is stopped');
  } finally { killMine(); await on.s.close(); await off.s.close(); }
});

test('bounty cleanup: dry run lists, --kill stops the stale, --all the rest; an unregistered process survives --kill --all', async () => {
  const t = await startBoard('agents-cleanup', { dispatch: false });
  try {
    const { board } = t;
    const gone = board.create({ title: 'finished', project: 'scratch', criteria: CRIT });
    const open = board.create({ title: 'open', project: 'scratch', criteria: CRIT });
    const stale = child('sleep 600'), fresh = child('sleep 600'), bridge = child('sleep 600'), boss = child('sleep 600');
    const stranger = child('sleep 600'); // never registered: someone's own terminal session
    const notLeader = child('sleep 600', { detached: false }); // shares the test runner's process group
    board.agents.register({ pid: stale, name: 'Stale', kind: 'worker', bounty: gone.id });
    board.agents.register({ pid: fresh, name: 'Fresh', kind: 'worker', bounty: open.id });
    board.agents.register({ pid: bridge, name: 'RemoteBridge', kind: 'bridge' });
    board.agents.register({ pid: boss, name: 'Boss', kind: 'orchestrator' });
    board.agents.register({ pid: notLeader, name: 'InMyGroup', kind: 'worker' });
    // the bounty is failed while the board is told not to stop anything yet: simulate by
    // flipping the status directly (no hook), so the entry is stale but still running.
    board.db.prepare("UPDATE bounties SET status = 'failed' WHERE id = ?").run(gone.id);

    // dry run (default): lists everything, stops nothing
    let r = await cli(t.url, ['cleanup']);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, /Agents \(4, \d+ MB\)/);
    assert.match(r.stdout, /Bridge sessions \(1, \d+ MB\)/);
    assert.match(r.stdout, /RemoteBridge/);
    assert.match(r.stdout, /Stale .*#\d+ failed .*STALE: bounty #\d+ is failed .*would stop/);
    assert.match(r.stdout, /dry run: 1 would be stopped/);
    assert.doesNotMatch(r.stdout, new RegExp(`^${stranger}\\b`, 'm'), 'unregistered processes are not listed');
    const j = JSON.parse((await cli(t.url, ['cleanup', '--json'])).stdout);
    const s = j.agents.find(a => a.name === 'Stale');
    assert.ok(s.rss_kb > 0 && s.age_seconds >= 0 && s.bounty_status === 'failed' && s.stale);
    await new Promise(r2 => setTimeout(r2, 300));
    assert.ok([stale, fresh, bridge, boss].every(alive), 'dry run stops nothing');

    // --kill: only the stale one
    r = await cli(t.url, ['cleanup', '--kill']);
    assert.match(r.stdout, /stopped 1/);
    await waitFor(() => !alive(stale), 5000);
    assert.ok([fresh, bridge, boss].every(alive));

    // --kill --all: every non-orchestrator entry; never the unregistered process or the test runner
    r = await cli(t.url, ['cleanup', '--kill', '--all']);
    assert.strictEqual(r.code, 0, r.stderr);
    await waitFor(() => !alive(fresh) && !alive(bridge) && !alive(notLeader), 5000);
    await new Promise(r2 => setTimeout(r2, 1300)); // past the SIGKILL grace
    assert.ok(alive(stranger), 'an unregistered process survives cleanup --kill --all');
    assert.ok(alive(boss), 'orchestrators need --orchestrators too');
    assert.ok(alive(process.pid));
    // a worker slot cannot kill
    assert.strictEqual((await t.call('POST', '/agents/cleanup', { kill: true }, 'fake-1')).status, 403);
    r = await cli(t.url, ['cleanup', '--kill', '--all', '--orchestrators']);
    await waitFor(() => !alive(boss), 5000);
    assert.ok(alive(stranger));
  } finally { killMine(); await t.s.close(); }
});

test('config: idle_shutdown_minutes and stop_grace_seconds defaults, run_dir next to the config', async () => {
  const { load } = require('../lib/config');
  const { tmpdir, writeConfig } = require('./helpers');
  const dir = tmpdir('agents-cfg');
  const cfg = load(writeConfig(dir, { watchdog: undefined }));
  assert.strictEqual(cfg.idle_shutdown_minutes, 120);
  assert.strictEqual(cfg.stop_grace_seconds, 15);
  assert.strictEqual(cfg.run_dir, path.join(dir, 'run'));
});
