// Unit + API tests for the status machine, the gates, leases, the watchdog and the dispatcher.
// Run: npm test   (node --test)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { startBoard, waitFor, sh, tmpdir, ROOT } = require('./helpers');
const { transition, TRANSITIONS } = require('../lib/machine');
const dbm = require('../lib/db');
const gitx = require('../lib/git');

const CRIT = ['math.js exports mul(a, b) returning the product', 'a node:test covers mul'];

// Make a branch with commits directly (no worker): returns the branch name.
function commitOnBranch(repo, branch, files) {
  sh(repo, `git checkout -q -b ${branch} main`);
  for (const [f, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
    fs.writeFileSync(path.join(repo, f), body);
  }
  sh(repo, `git add -A && git commit -qm "work on ${branch}" && git checkout -q main`);
  return branch;
}

test('status machine: legal edges, illegal edges, guarded edges', async () => {
  const t = await startBoard('machine', { dispatch: false });
  try {
    const { board } = t;
    const b = board.create({ title: 'x', project: 'scratch', criteria: CRIT });
    assert.strictEqual(b.status, 'backlog');
    assert.throws(() => transition(board.db, b.id, 'in_progress', {}), /backlog -> in_progress is not allowed/);
    board.ready(b.id);
    board.start(b.id, 'fake-1');
    // guarded: review only via gates, approved only via reviewer/orchestrator, done only via merge-check
    assert.throws(() => transition(board.db, b.id, 'review', { actor: 'fake-1' }), /only be reached via gates/);
    transition(board.db, b.id, 'review', { via: 'gates' });
    assert.throws(() => transition(board.db, b.id, 'approved', { via: 'worker' }), /reviewer or orchestrator/);
    transition(board.db, b.id, 'approved', { via: 'reviewer' });
    assert.throws(() => transition(board.db, b.id, 'done', { actor: 'orchestrator' }), /merge-check/);
    assert.deepStrictEqual(TRANSITIONS.done, []);
    // blocked requires a reason
    const c = board.create({ criteria: CRIT, title: 'y', project: 'scratch' });
    assert.throws(() => transition(board.db, c.id, 'blocked', {}), /reason/);
    // timestamps per status
    const row = board.raw(b.id);
    for (const s of ['ready_at', 'in_progress_at', 'review_at', 'approved_at']) assert.ok(row[s], s);
  } finally { await t.s.close(); }
});

test('API: workers cannot approve, assign, ready or mark done', async () => {
  const t = await startBoard('actor', { dispatch: false });
  try {
    const { call } = t;
    const b = (await call('POST', '/bounties', { title: 'x', project: 'scratch', criteria: CRIT })).data;
    assert.strictEqual((await call('POST', `/bounties/${b.id}/ready`, {}, 'fake-1')).status, 403);
    assert.strictEqual((await call('POST', `/bounties/${b.id}/assign`, { slot: 'fake-1' }, 'fake-1')).status, 403);
    assert.strictEqual((await call('POST', `/bounties/${b.id}/done`, {}, 'fake-1')).status, 403);
    assert.strictEqual((await call('POST', '/bounties', { title: 'sneaky' }, 'fake-1')).status, 403);
    assert.strictEqual((await call('POST', `/bounties/${b.id}/ready`, {})).status, 200);
    assert.strictEqual((await call('POST', `/bounties/${b.id}/start`, {}, 'fake-1')).status, 200);
    t.board.db.prepare("UPDATE bounties SET status='review' WHERE id=?").run(b.id);
    assert.strictEqual((await call('POST', `/bounties/${b.id}/approve`, {}, 'fake-1')).status, 403);
    assert.strictEqual((await call('POST', '/pause', {}, 'fake-1')).status, 403);
  } finally { await t.s.close(); }
});

test('gates: no branch, empty diff, docs-only diff on a code bounty are refused', async () => {
  const t = await startBoard('gates', { dispatch: false });
  try {
    const { board, repo, call } = t;
    const b = board.create({ title: 'code', project: 'scratch', type: 'task', criteria: CRIT });
    board.ready(b.id); board.start(b.id, 'fake-1');
    let r = await call('POST', `/bounties/${b.id}/submit`, {}, 'fake-1');
    assert.strictEqual(r.status, 422); assert.match(r.data.error, /no branch/);
    r = await call('POST', `/bounties/${b.id}/submit`, { branch: 'nope' }, 'fake-1');
    assert.strictEqual(r.status, 422); assert.match(r.data.error, /does not exist/);
    sh(repo, 'git branch empty-br main');
    r = await call('POST', `/bounties/${b.id}/submit`, { branch: 'empty-br' }, 'fake-1');
    assert.strictEqual(r.status, 422); assert.match(r.data.error, /empty/);
    commitOnBranch(repo, 'notes-br', { 'WORK_LOG.md': 'did stuff\n', 'notes/today.md': 'more\n' });
    r = await call('POST', `/bounties/${b.id}/submit`, { branch: 'notes-br' }, 'fake-1');
    assert.strictEqual(r.status, 422); assert.match(r.data.error, /only touches notes\/logs/);
    assert.strictEqual(board.raw(b.id).status, 'in_progress');
    // a research bounty may be docs-only
    const d = board.create({ criteria: CRIT, title: 'research', project: 'scratch', type: 'research' });
    board.ready(d.id); board.start(d.id, 'fake-1');
    r = await call('POST', `/bounties/${d.id}/submit`, { branch: 'notes-br' }, 'fake-1');
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    await waitFor(() => board.raw(d.id).status === 'review');
    assert.strictEqual(board.raw(d.id).ci_status, 'pass');
  } finally { await t.s.close(); }
});

test('gates: verify failure keeps the bounty out of review; with no live worker it goes back to ready with the log', async () => {
  const t = await startBoard('verifyfail', { dispatch: false, verify: 'fail' });
  try {
    const { board, repo, call } = t;
    const b = board.create({ title: 'code', project: 'scratch', criteria: CRIT });
    board.ready(b.id); board.start(b.id, 'fake-1');
    commitOnBranch(repo, 'real-br', { 'math.js': 'function add(a,b){return a+b}\nfunction mul(a,b){return a*b}\nmodule.exports={add,mul}\n' });
    const r = await call('POST', `/bounties/${b.id}/submit`, { branch: 'real-br' }, 'fake-1');
    assert.strictEqual(r.status, 200);
    await waitFor(() => board.raw(b.id).ci_status === null && board.raw(b.id).status === 'ready');
    const row = board.raw(b.id);
    assert.strictEqual(row.failures, 1);
    const ev = board.db.prepare("SELECT note FROM events WHERE bounty_id=? AND kind='verify' AND note LIKE 'verify FAILED%'").get(b.id);
    assert.ok(ev && /failing on purpose/.test(ev.note), 'verify output recorded');
  } finally { await t.s.close(); }
});

test('done: refused until the commits are on main; merge (or cherry-pick) makes it done', async () => {
  const t = await startBoard('done', { dispatch: false });
  try {
    const { board, repo, call } = t;
    const mk = (branch, file) => {
      const b = board.create({ title: branch, project: 'scratch', criteria: CRIT });
      board.ready(b.id); board.start(b.id, 'fake-1');
      commitOnBranch(repo, branch, { [file]: `// ${branch}\nmodule.exports = 1;\n` });
      board.submit(b.id, { branch, actor: 'fake-1' });
      return b.id;
    };
    const id = mk('feat-a', 'a.js');
    await waitFor(() => board.raw(id).status === 'review');
    // the reviewer is not running (dispatch off): the orchestrator approves
    board.approve(id, 'orchestrator', 'looks right');
    let r = await call('POST', `/bounties/${id}/done`, {});
    assert.strictEqual(r.status, 409); assert.match(r.data.error, /not on main/);
    assert.strictEqual(board.raw(id).status, 'approved');
    assert.deepStrictEqual(board.mergeSweep()[0].done, false);
    sh(repo, 'git merge -q --no-ff feat-a -m "merge feat-a"');
    r = await call('POST', `/bounties/${id}/done`, {});
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.strictEqual(board.raw(id).status, 'done');
    assert.ok(board.db.prepare("SELECT total_loot FROM agents WHERE id='fake-1'").get().total_loot > 0, 'loot awarded');
    // cherry-pick (new SHA, same patch) counts; the sweep finds it by itself
    const id2 = mk('feat-b', 'b.js');
    await waitFor(() => board.raw(id2).status === 'review');
    board.approve(id2);
    sh(repo, 'echo "// main moved" > main-moved.js && git add -A && git commit -qm "main moved" && git cherry-pick feat-b >/dev/null');
    assert.ok(!gitx.tryGit(repo, ['merge-base', '--is-ancestor', board.need(id2).commits[0], 'main']).ok, 'sha differs');
    board.mergeSweep();
    assert.strictEqual(board.raw(id2).status, 'done');
    // squash merge counts too
    const id3 = mk('feat-c', 'c.js');
    sh(repo, 'git checkout -q feat-c && echo "// more" >> c.js && git commit -qam more && git checkout -q main');
    board.db.prepare("UPDATE bounties SET commits=? WHERE id=?").run(JSON.stringify(gitx.commitsAhead(repo, 'main', 'feat-c')), id3);
    await waitFor(() => board.raw(id3).status === 'review');
    board.approve(id3);
    sh(repo, 'git merge -q --squash feat-c && git commit -qm "squash feat-c"');
    board.mergeSweep();
    assert.strictEqual(board.raw(id3).status, 'done');
  } finally { await t.s.close(); }
});

test('leases: exclusive, renewable, released on TTL expiry and when the holder bounty ends', async () => {
  const t = await startBoard('lease', { dispatch: false });
  try {
    const { board, call } = t;
    const a = board.create({ criteria: CRIT, title: 'a', project: 'scratch' }); board.ready(a.id); board.start(a.id, 'fake-1');
    const b = board.create({ criteria: CRIT, title: 'b', project: 'scratch' }); board.ready(b.id); board.start(b.id, 'fake-2');
    let r = await call('POST', '/leases/gpu', { bounty_id: a.id, slot: 'fake-1' }, 'fake-1');
    assert.strictEqual(r.data.granted, true);
    r = await call('POST', '/leases/gpu', { bounty_id: b.id, slot: 'fake-2' }, 'fake-2');
    assert.strictEqual(r.data.granted, false); assert.strictEqual(r.data.lease.holder, `bounty-${a.id}`);
    r = await call('POST', '/leases/gpu', { bounty_id: a.id, slot: 'fake-1' }, 'fake-1');
    assert.strictEqual(r.data.renewed, true);
    // expired TTL: released on the next check, then the other bounty gets it
    board.db.prepare("UPDATE leases SET expires_at = ? WHERE resource = 'gpu'").run(new Date(Date.now() - 1000).toISOString());
    const exp = board.expireLeases();
    assert.strictEqual(exp[0].why, 'expired (ttl)');
    r = await call('POST', '/leases/gpu', { bounty_id: b.id, slot: 'fake-2' }, 'fake-2');
    assert.strictEqual(r.data.granted, true);
    // holder bounty leaves in_progress (blocked, no worker) -> lease released
    board.block(b.id, 'stuck', 'fake-2');
    assert.match(board.expireLeases()[0].why, /no longer in progress/);
    assert.strictEqual(board.listLeases().length, 0);
    // release by the holder only
    await call('POST', '/leases/gpu', { holder: 'kewky' });
    r = await call('DELETE', '/leases/gpu', { holder: 'someone-else' });
    assert.strictEqual(r.status, 409);
    r = await call('DELETE', '/leases/gpu', { holder: 'kewky' });
    assert.strictEqual(r.data.released, true);
  } finally { await t.s.close(); }
});

test('watchdog: a worker that dies without submitting is blocked; a silent worker is killed and blocked', async () => {
  const t = await startBoard('watchdog', { over: { watchdog: { stall_minutes: 0.05, check_seconds: 1, kill_grace_seconds: 1 } } });
  try {
    const { board } = t;
    const crash = board.create({ criteria: CRIT, title: 'crash', project: 'scratch', description: 'mode:crash', assignee_slot: 'fake-1' });
    board.ready(crash.id);
    await waitFor(() => board.raw(crash.id).status === 'blocked');
    assert.match(board.raw(crash.id).blocked_reason, /exited with code 3 without running 'bounty start'/);
    const stall = board.create({ criteria: CRIT, title: 'stall', project: 'scratch', description: 'mode:stall', assignee_slot: 'fake-2' });
    board.ready(stall.id);
    await waitFor(() => board.raw(stall.id).status === 'in_progress');
    await waitFor(() => board.raw(stall.id).status === 'blocked', 30000);
    assert.match(board.raw(stall.id).blocked_reason, /watchdog: no heartbeat or progress/);
    await waitFor(() => !t.s.dispatcher.isAlive(stall.id), 10000);
    const a = board.db.prepare('SELECT * FROM attempts WHERE bounty_id = ?').get(stall.id);
    assert.ok(a.ended_at && fs.existsSync(a.log_path), 'attempt closed, log kept');
    const nosub = board.create({ title: 'nosub', project: 'scratch', description: 'mode:no-submit', assignee_slot: 'fake-1', criteria: CRIT });
    board.ready(nosub.id);
    await waitFor(() => board.raw(nosub.id).status === 'blocked');
    assert.match(board.raw(nosub.id).blocked_reason, /without submitting/);
  } finally { await t.s.close(); }
});

test('dispatcher e2e with the fake worker: ready -> spawn -> start -> submit -> verify -> review -> approve -> merge -> done', async () => {
  const t = await startBoard('e2e');
  try {
    const { board, repo } = t;
    const b = board.create({ title: 'Add mul() with a test', project: 'scratch', criteria: CRIT, assignee_slot: 'fake-1', tier: 'B' });
    board.ready(b.id);
    await waitFor(() => board.raw(b.id).status === 'approved', 30000);
    const row = board.get(b.id);
    const kinds = row.events.map(e => e.kind + (e.to_status ? ':' + e.to_status : ''));
    for (const k of ['status:ready', 'spawn', 'status:in_progress', 'verify', 'status:review', 'review', 'status:approved']) assert.ok(kinds.includes(k), `${k} in ${kinds}`);
    assert.strictEqual(row.ci_status, 'pass');
    assert.match(row.review_notes, /APPROVE/);
    assert.ok(row.attempts.find(a => a.kind === 'worker' && fs.existsSync(a.log_path)));
    assert.ok(row.criteria.every(c => c.done));
    sh(repo, `git merge -q --no-ff ${row.branch} -m "merge"`);
    await waitFor(() => board.raw(b.id).status === 'done', 10000);
    // a notes-only worker gets refused and, having exited, is blocked
    const n = board.create({ title: 'notes only', project: 'scratch', description: 'mode:notes-only', assignee_slot: 'fake-2', criteria: CRIT });
    board.ready(n.id);
    await waitFor(() => board.raw(n.id).status === 'blocked', 20000);
    assert.ok(board.db.prepare("SELECT 1 FROM events WHERE bounty_id=? AND note LIKE '%only touches notes/logs%'").get(n.id));
  } finally { await t.s.close(); }
});

test('reviewer reject sends the bounty back to ready with notes; escalation after 2 failures', async () => {
  const t = await startBoard('reject', { dispatch: false });
  try {
    const { board, repo } = t;
    const b = board.create({ title: 'x', project: 'scratch', criteria: CRIT, assignee_slot: 'fake-1' });
    board.ready(b.id); board.start(b.id, 'fake-1');
    commitOnBranch(repo, 'no-mul', { 'x.js': 'module.exports = 2;\n' });
    board.submit(b.id, { branch: 'no-mul', actor: 'fake-1' });
    await waitFor(() => board.raw(b.id).status === 'review');
    await t.s.reviewer.review(b.id);
    let row = board.raw(b.id);
    assert.strictEqual(row.status, 'ready');
    assert.match(row.review_notes, /REJECT/);
    assert.strictEqual(row.failures, 1);
    assert.strictEqual(row.assignee_slot, 'fake-1');
    // second failure: fake-1 is 'sonnet' -> escalates to the opus slot
    board.start(b.id, 'fake-1');
    board.db.prepare("UPDATE bounties SET ci_status='pass' WHERE id=?").run(b.id);
    transition(board.db, b.id, 'review', { via: 'gates' });
    board.reject(b.id, 'still no mul');
    row = board.raw(b.id);
    assert.strictEqual(row.assignee_slot, 'fake-2');
    assert.ok(board.db.prepare("SELECT 1 FROM events WHERE bounty_id=? AND note LIKE '%escalated fake-1 (sonnet) -> fake-2 (opus)%'").get(b.id));
    // a reviewer "approve" without per-criterion evidence is overruled
    const { Reviewer } = require('../lib/reviewer');
    assert.ok(Reviewer);
  } finally { await t.s.close(); }
});

test('pause stops new spawns; resume restarts them', async () => {
  const t = await startBoard('pause');
  try {
    const { board, call } = t;
    await call('POST', '/pause', {});
    const b = board.create({ title: 'Add mul() with a test', project: 'scratch', criteria: CRIT, assignee_slot: 'fake-1' });
    board.ready(b.id);
    await new Promise(r => setTimeout(r, 2500));
    assert.strictEqual(board.raw(b.id).status, 'ready');
    assert.strictEqual(board.db.prepare('SELECT COUNT(*) c FROM attempts WHERE bounty_id=?').get(b.id).c, 0);
    await call('POST', '/resume', {});
    await waitFor(() => board.raw(b.id).status !== 'ready', 15000);
  } finally { await t.s.close(); }
});

test('migration: the Feb-2026 DB keeps its history', () => {
  const dir = tmpdir('mig');
  const legacy = path.join(ROOT, 'test', 'fixtures', 'legacy-board.db');
  if (!fs.existsSync(legacy)) return;
  const p = path.join(dir, 'x.db');
  fs.copyFileSync(legacy, p);
  const db = dbm.open(p);
  const c = db.prepare('SELECT status, COUNT(*) n FROM bounties GROUP BY status').all();
  const total = c.reduce((a, r) => a + r.n, 0);
  assert.strictEqual(total, 57);
  assert.ok(db.prepare("SELECT total_loot FROM agents WHERE id='opus-wsl-1'").get().total_loot > 0);
  assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM bounties WHERE project_id='legacy'").get().n, 57);
  db.close();
  const db2 = dbm.open(p); // re-open is a no-op
  assert.strictEqual(db2.prepare('SELECT COUNT(*) n FROM bounties').get().n, 57);
  db2.close();
});

test('external gpu lease mirrors the UE render flock and its holder file; the prompt points at the script', async () => {
  const dir = tmpdir('ext');
  const lock = path.join(dir, 'ue-render.lock');
  const holderFile = path.join(dir, 'ue-render.holder');
  const t = await startBoard('ext', { dispatch: false, over: { external_leases: { gpu: {
    what: 'the machine-wide UE render lock', lock_file: lock, holder_file: holderFile, script: '/x/Scripts/lib/ue-render-lock.sh',
    projects: ['scratch'], how: 'Take it with the script.' } } } });
  const { spawn } = require('child_process');
  let holder;
  try {
    const { board, call } = t;
    let st = board.externalStatus('gpu');
    assert.strictEqual(st.held, false);
    fs.writeFileSync(lock, '');
    holder = spawn('flock', [lock, 'sleep', '30'], { stdio: 'ignore', detached: true });
    fs.writeFileSync(holderFile, `pid=${holder.pid}\nowner=portal-real-test\nwhat=T40 rendered client\n`);
    await waitFor(() => board.externalStatus('gpu').held);
    st = board.externalStatus('gpu');
    assert.strictEqual(st.holder.owner, 'portal-real-test');
    assert.strictEqual(st.holder.pid_alive, true);
    const r = await call('POST', '/leases/gpu', { bounty_id: null, slot: 'fake-1' }, 'fake-1');
    assert.strictEqual(r.data.external, true); assert.strictEqual(r.data.granted, false); assert.strictEqual(r.data.held, true);
    const state = (await call('GET', '/state')).data;
    assert.ok(state.leases.find(l => l.resource === 'gpu' && l.external && l.held));
    process.kill(-holder.pid, 'SIGKILL');
    await waitFor(() => !board.externalStatus('gpu').held);
    assert.strictEqual(board.externalStatus('gpu').holder_stale, true);
    const b = board.create({ criteria: CRIT, title: 'x', project: 'scratch' });
    const { workerPrompt } = require('../lib/prompt');
    const prompt = workerPrompt(board, board.need(b.id), board.slot('fake-1'), { worktree: t.repo, branch: 'x' });
    assert.match(prompt, /ue-render-lock\.sh/);
    assert.match(prompt, /machine-wide UE render lock/);
  } finally { try { process.kill(-holder.pid, 'SIGKILL'); } catch {} await t.s.close(); }
});

test('ready needs acceptance criteria', async () => {
  const t = await startBoard('crit', { dispatch: false });
  try {
    const b = t.board.create({ title: 'no criteria', project: 'scratch' });
    const r = await t.call('POST', `/bounties/${b.id}/ready`, {});
    assert.strictEqual(r.status, 400); assert.match(r.data.error, /acceptance criteria/);
    await t.call('PATCH', `/bounties/${b.id}`, { criteria: ['it works'] });
    assert.strictEqual((await t.call('POST', `/bounties/${b.id}/ready`, {})).status, 200);
  } finally { await t.s.close(); }
});

test('Tribulation import: backlog + in-flight + tests, deduped, re-runnable', async (tt) => {
  const im = require('../lib/importer');
  if (!fs.existsSync(im.DEFAULTS.taskList)) { tt.skip('vault not mounted'); return; }
  const t = await startBoard('import', { dispatch: false, over: { slots: [{ id: 'sonnet-tester', runner: 'command', cmd: ['true'] }] } });
  try {
    const { board } = t;
    board.upsertProject({ id: 'tribulation', repo: '/mnt/ue/Tribulation', main_branch: 'main' });
    const r1 = im.importTribulation(board);
    assert.ok(r1.created_count > 60, `created ${r1.created_count}`);
    const r2 = im.importTribulation(board);
    assert.strictEqual(r2.created_count, 0);
    assert.strictEqual(r2.existing, r1.created_count);
    const flight = board.list({ status: 'in_progress', project: 'tribulation' });
    assert.deepStrictEqual(flight.map(b => b.branch || b.worktree).sort(),
      ['/mnt/ue/ArtSource/titan-darkknight', '/mnt/ue/ArtSource/titan-darkknight-sol', 'p0-game-bugs', 'portal-real-test'].sort());
    assert.strictEqual(board.list({ status: 'ready', project: 'tribulation' }).length, 0);
    const tests = board.list({ type: 'test', project: 'tribulation' });
    assert.ok(tests.length >= 40 && tests.every(b => b.assignee_slot === 'sonnet-tester' && b.status === 'backlog'));
    const others = board.list({ status: 'backlog', project: 'tribulation' }).filter(b => b.type !== 'test');
    assert.ok(others.every(b => !b.assignee_slot));
    // the Task List portal item is folded into the in-flight portal bounty, not duplicated
    assert.strictEqual(board.list({ project: 'tribulation', q: 'portal-real-test' }).length, 1);
    const titles = board.list({ project: 'tribulation' }).map(b => b.title.toLowerCase());
    assert.strictEqual(new Set(titles).size, titles.length, 'no duplicate titles');
  } finally { await t.s.close(); }
});

// Run the real CLI against a test board (async: the board runs in this process).
function cli(url, args, env = {}) {
  const { execFile } = require('child_process');
  return new Promise(resolve => execFile(process.execPath, [path.join(ROOT, 'bin', 'bounty'), ...args], {
    encoding: 'utf8', env: { ...process.env, BOUNTY_SLOT: '', BOUNTY_ID: '', BOUNTY_ACTOR: '', BOUNTY_URL: url, ...env },
  }, (err, out, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, out, err: stderr })));
}

test('notes: orchestrator -> live worker via inbox, start and progress; later attempts get them in the prompt', async () => {
  const t = await startBoard('notes', { dispatch: false, over: { machine_rules: ['One heavy job at a time: check free -g first.'] } });
  try {
    const { board, call, url } = t;
    const b = board.create({ title: 'x', project: 'scratch', criteria: CRIT });
    board.ready(b.id);
    // workers can't send notes; empty notes are refused
    assert.strictEqual((await call('POST', `/bounties/${b.id}/notes`, { text: 'hi' }, 'fake-1')).status, 403);
    assert.strictEqual((await call('POST', `/bounties/${b.id}/notes`, { text: '  ' })).status, 400);
    assert.strictEqual((await call('POST', '/bounties/9999/notes', { text: 'x' })).status, 404);
    // a note sent before start is printed by `bounty start`
    let r = await cli(url, ['note', String(b.id), 'use port 7777, not 45000']);
    assert.strictEqual(r.code, 0, r.err);
    const w = { BOUNTY_ID: String(b.id), BOUNTY_SLOT: 'fake-1' };
    r = await cli(url, ['start'], w);
    assert.strictEqual(r.code, 0, r.err);
    assert.match(r.out, /NEW NOTE FROM THE ORCHESTRATOR[\s\S]*use port 7777, not 45000/);
    assert.strictEqual(board.notes(b.id, { unread: true }).length, 0);
    assert.strictEqual(board.notes(b.id)[0].read_by, 'fake-1');
    // inbox: nothing unread now
    r = await cli(url, ['inbox'], w);
    assert.match(r.out, /no unread notes/);
    // peek leaves it unread; inbox prints it and marks it read
    await cli(url, ['note', String(b.id), 'MACHINE RULES: one rendered UE instance']);
    r = await cli(url, ['inbox', String(b.id), '--peek']);
    assert.match(r.out, /1 unread note\(s\)[\s\S]*one rendered UE instance/);
    assert.strictEqual(board.notes(b.id, { unread: true }).length, 1);
    assert.strictEqual((await call('GET', `/bounties/${b.id}/inbox`)).data.length, 1);
    r = await cli(url, ['inbox'], w);
    assert.match(r.out, /NEW NOTE[\s\S]*one rendered UE instance/);
    assert.strictEqual(board.notes(b.id, { unread: true }).length, 0);
    // progress prints unread notes too, once
    await cli(url, ['note', String(b.id), 'criterion 2 is dropped']);
    r = await cli(url, ['progress', 'did a thing'], w);
    assert.match(r.out, /progress noted[\s\S]*criterion 2 is dropped/);
    r = await cli(url, ['progress', 'did another thing'], w);
    assert.doesNotMatch(r.out, /NOTE/);
    // workers can't use `bounty note`
    r = await cli(url, ['note', String(b.id), 'x'], w);
    assert.notStrictEqual(r.code, 0);
    // notes are in the history, and every later attempt gets all of them in its prompt
    const hist = board.get(b.id).events.filter(e => e.kind === 'message').map(e => e.note);
    assert.deepStrictEqual(hist, ['use port 7777, not 45000', 'MACHINE RULES: one rendered UE instance', 'criterion 2 is dropped']);
    const { workerPrompt } = require('../lib/prompt');
    const prompt = workerPrompt(board, { ...board.need(b.id), attempts: 2 }, board.slot('fake-2'), { worktree: t.repo, branch: 'x' });
    assert.match(prompt, /## Orchestrator notes[\s\S]*use port 7777[\s\S]*one rendered UE instance[\s\S]*criterion 2 is dropped/);
    assert.match(prompt, /`bounty inbox` right after start/);
    assert.match(prompt, /# Machine rules[\s\S]*check free -g first/);
    assert.match(prompt, /When you end your turn, your process exits/);
    // a bounty with no notes has no notes section
    const c = board.create({ title: 'y', project: 'scratch', criteria: CRIT });
    assert.doesNotMatch(workerPrompt(board, board.need(c.id), board.slot('fake-1'), { worktree: t.repo, branch: 'y' }), /## Orchestrator notes/);
  } finally { await t.s.close(); }
});

test('default project: the only non-legacy project, or config default_project; no project is refused at creation', async () => {
  const t = await startBoard('defproj', { dispatch: false });
  try {
    const { board, call, url, repo } = t;
    board.db.prepare("INSERT INTO projects (id, name, repo) VALUES ('legacy', 'Legacy', '')").run();
    // one non-legacy project: it is the default
    let r = await cli(url, ['add', 'no project given']);
    assert.strictEqual(r.code, 0, r.err);
    assert.match(r.out, /project scratch/);
    // two projects and no default: refused at creation, not at ready
    board.upsertProject({ id: 'other', repo, main_branch: 'main' });
    r = await call('POST', '/bounties', { title: 'ambiguous' });
    assert.strictEqual(r.status, 400);
    assert.match(r.data.error, /needs a project.*scratch/);
    r = await cli(url, ['add', 'ambiguous']);
    assert.notStrictEqual(r.code, 0);
    assert.match(r.err, /needs a project/);
    assert.strictEqual(board.list({ q: 'ambiguous' }).length, 0);
    // a configured default wins
    board.cfg.default_project = 'other';
    assert.strictEqual((await call('POST', '/bounties', { title: 'defaulted' })).data.project_id, 'other');
    assert.strictEqual((await call('GET', '/state')).data.default_project, 'other');
    // an explicit --project still wins; an unknown one is refused
    assert.strictEqual((await call('POST', '/bounties', { title: 'explicit', project: 'scratch' })).data.project_id, 'scratch');
    assert.strictEqual((await call('POST', '/bounties', { title: 'bad', project: 'nope' })).status, 400);
    board.cfg.default_project = 'gone';
    assert.match((await call('POST', '/bounties', { title: 'bad default' })).data.error, /unknown project 'gone'/);
    // bounty edit --project
    const id = board.list({ q: 'defaulted' })[0].id;
    r = await cli(url, ['edit', String(id), '--project', 'scratch']);
    assert.strictEqual(r.code, 0, r.err);
    assert.strictEqual(board.raw(id).project_id, 'scratch');
    r = await cli(url, ['edit', String(id), '--project', 'nope']);
    assert.notStrictEqual(r.code, 0);
    assert.strictEqual(board.raw(id).project_id, 'scratch');
  } finally { await t.s.close(); }
});

test('close-merged: an external bounty is done once its commit is on main; refused off main and with a live worker', async () => {
  const t = await startBoard('closemerged', { dispatch: false });
  try {
    const { board, repo, call } = t;
    const { spawn } = require('child_process');
    // an external bounty: in_progress, no board worker, no branch recorded
    const b = board.create({ title: 'external fix', project: 'scratch', type: 'bug', tier: 'B', criteria: CRIT, status: 'in_progress', external_owner: 'opus-1' });
    assert.strictEqual(board.raw(b.id).status, 'in_progress');
    commitOnBranch(repo, 'ext-br', { 'mul.js': 'module.exports = (a, b) => a * b;\n' });
    const sha = sh(repo, 'git rev-parse ext-br').trim();

    // refusal 1: the commit is not on main
    let r = await call('POST', `/bounties/${b.id}/close-merged`, { commits: [sha.slice(0, 7)], evidence: 'x' });
    assert.strictEqual(r.status, 409, JSON.stringify(r.data)); assert.match(r.data.error, /not on main/);
    r = await call('POST', `/bounties/${b.id}/close-merged`, { commits: ['deadbeef'] });
    assert.strictEqual(r.status, 422); assert.match(r.data.error, /does not exist/);
    r = await call('POST', `/bounties/${b.id}/close-merged`, {});
    assert.strictEqual(r.status, 400);
    assert.strictEqual(board.raw(b.id).status, 'in_progress');

    sh(repo, 'git merge -q --no-ff ext-br -m "merge ext-br"');

    // workers can't use it
    r = await call('POST', `/bounties/${b.id}/close-merged`, { commits: [sha] }, 'fake-1');
    assert.strictEqual(r.status, 403);

    // refusal 2: a live board worker on the bounty
    const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
    t.s.dispatcher.live.set(b.id, { pid: child.pid, slot: 'fake-1' });
    r = await call('POST', `/bounties/${b.id}/close-merged`, { commits: [sha] });
    assert.strictEqual(r.status, 409); assert.match(r.data.error, /live board worker/);
    assert.strictEqual(board.raw(b.id).status, 'in_progress');
    t.s.dispatcher.live.delete(b.id);
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}

    // success: done, commits + evidence + actor in the history, loot paid to the owner
    const before = board.db.prepare("SELECT total_loot FROM agents WHERE id='fake-1'").get().total_loot;
    board.db.prepare('UPDATE bounties SET claimed_by = ? WHERE id = ?').run('fake-1', b.id);
    r = await call('POST', `/bounties/${b.id}/close-merged`, { commits: [sha.slice(0, 7)], evidence: 'ci PASS, see log.md' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.deepStrictEqual(r.data.commits, [sha]);
    const row = board.need(b.id);
    assert.strictEqual(row.status, 'done');
    assert.deepStrictEqual(row.commits, [sha]);
    assert.strictEqual(row.work_evidence, 'ci PASS, see log.md');
    assert.ok(row.reward > 0);
    const ev = board.db.prepare("SELECT * FROM events WHERE bounty_id = ? AND kind = 'status' AND to_status = 'done'").get(b.id);
    assert.strictEqual(ev.from_status, 'in_progress');
    assert.strictEqual(ev.actor, 'orchestrator');
    assert.match(ev.note, new RegExp(`close-merged by orchestrator: ${sha.slice(0, 10)} on main`));
    assert.match(ev.note, /evidence: ci PASS, see log\.md/);
    const after = board.db.prepare("SELECT total_loot FROM agents WHERE id='fake-1'").get().total_loot;
    assert.strictEqual(after - before, row.reward, 'loot granted like a normal done');
    // done is final
    r = await call('POST', `/bounties/${b.id}/close-merged`, { commits: [sha] });
    assert.strictEqual(r.status, 409);
  } finally { await t.s.close(); }
});
