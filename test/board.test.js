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
    await call('POST', '/leases/gpu', { holder: 'test-holder' });
    r = await call('DELETE', '/leases/gpu', { holder: 'someone-else' });
    assert.strictEqual(r.status, 409);
    r = await call('DELETE', '/leases/gpu', { holder: 'test-holder' });
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
    // the ledger: the merged bounty credits the slot whose real attempt did it; the notes-only one is a failure
    await waitFor(() => board.db.prepare("SELECT 1 FROM attempts WHERE bounty_id = ? AND ended_at IS NOT NULL").get(n.id));
    const led = Object.fromEntries(board.ledger().slots.map(s => [s.id, s]));
    assert.strictEqual(board.raw(b.id).credited_slot, 'fake-1');
    assert.ok(board.raw(b.id).credited_attempt, 'credited to a real attempt row');
    assert.strictEqual(led['fake-1'].missions_completed, 1);
    assert.ok(led['fake-1'].total_loot > 0);
    assert.strictEqual(led['fake-2'].missions_completed, 0);
    assert.strictEqual(led['fake-2'].missions_failed, 1);
    assert.strictEqual(led['fake-2'].total_loot, 0);
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
    fs.writeFileSync(holderFile, `pid=${holder.pid}\nowner=feat-branch\nwhat=render pass\n`);
    await waitFor(() => board.externalStatus('gpu').held);
    st = board.externalStatus('gpu');
    assert.strictEqual(st.holder.owner, 'feat-branch');
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

test('backlog import: tasks + audit + tests from fixture Markdown, deduped, re-runnable', async () => {
  const im = require('../lib/importer');
  const t = await startBoard('import', { dispatch: false, over: { slots: [{ id: 'tester-slot', name: 'Tester', runner: 'command', cmd: ['true'] }] } });
  try {
    const { board, dir } = t;
    board.upsertProject({ id: 'myproject', repo: t.repo, main_branch: 'main' });
    // Write fixture Markdown files
    const fixtures = path.join(dir, 'fixtures');
    fs.mkdirSync(fixtures, { recursive: true });
    fs.writeFileSync(path.join(fixtures, 'tasklist.md'), [
      '# Task List', '## LIVE BACKLOG', '### Missing core systems',
      '- [ ] User auth flow', '- [ ] Database migrations',
      '### Bugs on main', '- [ ] Fix crash on login', '- [ ] Null pointer in parser',
      '### Half built', '- [ ] Inventory system', '- [ ] Chat system',
      '### No code yet', '**No code yet**', '- [ ] Leaderboard; Achievements; Trading',
      '### Tech debt', '- [ ] Stale docs in README',
    ].join('\n'));
    fs.writeFileSync(path.join(fixtures, 'audit.md'), [
      '## By system', '### Auth', '| Where | What | Size |', '| --- | --- | --- |',
      '| src/auth.js | Login page missing | M |', '### Database', '| Where | What | Size |', '| --- | --- | --- |',
      '| src/db.js | No rollback support | L |',
    ].join('\n'));
    fs.writeFileSync(path.join(fixtures, 'queue.md'), [
      '## P0 Critical', '- [ ] T01 Login flow end to end', '- [ ] T02 Signup validation',
      '## P1 Normal', '- [ ] T03 Profile page renders', '- [ ] T04 Settings save',
    ].join('\n'));
    const paths = { taskList: path.join(fixtures, 'tasklist.md'), audit: path.join(fixtures, 'audit.md'), queue: path.join(fixtures, 'queue.md') };
    const r1 = im.importBacklog(board, { paths, project: 'myproject', tester_slot: 'tester-slot' });
    assert.ok(r1.created_count >= 10, `created ${r1.created_count}`);
    const r2 = im.importBacklog(board, { paths, project: 'myproject', tester_slot: 'tester-slot' });
    assert.strictEqual(r2.created_count, 0, 'second run creates nothing');
    assert.strictEqual(r2.existing, r1.created_count);
    const tests = board.list({ type: 'test', project: 'myproject' });
    assert.ok(tests.length === 4 && tests.every(b => b.assignee_slot === 'tester-slot' && b.status === 'backlog'));
    const others = board.list({ status: 'backlog', project: 'myproject' }).filter(b => b.type !== 'test');
    assert.ok(others.every(b => !b.assignee_slot));
    const titles = board.list({ project: 'myproject' }).map(b => b.title.toLowerCase());
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
    const b = board.create({ title: 'external fix', project: 'scratch', type: 'bug', tier: 'B', criteria: CRIT, status: 'in_progress', external_owner: 'external-worker-1' });
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

    // success: done, commits + evidence + actor in the history. The work was done off the board
    // (no slot attempt submitted it), so no slot is credited even though claimed_by names one.
    board.db.prepare('UPDATE bounties SET claimed_by = ? WHERE id = ?').run('fake-1', b.id);
    r = await call('POST', `/bounties/${b.id}/close-merged`, { commits: [sha.slice(0, 7)], evidence: 'ci PASS, see log.md' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.deepStrictEqual(r.data.commits, [sha]);
    const row = board.need(b.id);
    assert.strictEqual(row.status, 'done');
    assert.deepStrictEqual(row.commits, [sha]);
    assert.strictEqual(row.work_evidence, 'ci PASS, see log.md');
    assert.strictEqual(row.credited_slot, null);
    assert.strictEqual(r.data.credited, null);
    assert.strictEqual(r.data.reward, 0);
    const ev = board.db.prepare("SELECT * FROM events WHERE bounty_id = ? AND kind = 'status' AND to_status = 'done'").get(b.id);
    assert.strictEqual(ev.from_status, 'in_progress');
    assert.strictEqual(ev.actor, 'orchestrator');
    assert.match(ev.note, new RegExp(`close-merged by orchestrator: ${sha.slice(0, 10)} on main`));
    assert.match(ev.note, /evidence: ci PASS, see log\.md/);
    assert.match(ev.note, /no slot credited/);
    for (const a of (await call('GET', '/agents/leaderboard')).data) {
      assert.strictEqual(a.total_loot, 0, `${a.id} got loot for external work`);
      assert.strictEqual(a.missions_completed, 0);
    }
    assert.strictEqual(board.db.prepare("SELECT total_loot FROM agents WHERE id='fake-1'").get().total_loot, 0);
    assert.strictEqual(board.stats().total_loot_earned, 0);
    // done is final
    r = await call('POST', `/bounties/${b.id}/close-merged`, { commits: [sha] });
    assert.strictEqual(r.status, 409);
  } finally { await t.s.close(); }
});

// ---------- real agents only: slots, derived loot ----------

test('agents: the Feb-2026 and mock agents are purged; bounties keep the names as text; the migration re-runs as a no-op', async () => {
  const legacy = path.join(ROOT, 'test', 'fixtures', 'legacy-board.db');
  const dir = tmpdir('purge');
  const dbPath = path.join(dir, 'x.db');
  fs.copyFileSync(legacy, dbPath);
  {
    const raw = dbm.open(dbPath);
    raw.prepare("INSERT INTO agent_events (agentId, status, reason, timestamp) VALUES ('agent-gpt-4', 'active', 'mock', 1)").run();
    assert.ok(raw.prepare("SELECT COUNT(*) c FROM agent_status").get().c > 0);
    raw.close();
  }
  const { writeConfig } = require('./helpers');
  const { load } = require('../lib/config');
  const { Board } = require('../lib/board');
  const cfgPath = writeConfig(dir, { db_path: dbPath });
  const slotIds = ['fake-1', 'fake-2'];
  const check = board => {
    assert.deepStrictEqual(board.db.prepare('SELECT id FROM agents ORDER BY id').all().map(r => r.id), slotIds);
    assert.strictEqual(board.db.prepare(`SELECT COUNT(*) c FROM agent_status WHERE agentId NOT IN ('fake-1','fake-2')`).get().c, 0);
    assert.strictEqual(board.db.prepare(`SELECT COUNT(*) c FROM agent_events WHERE agentId NOT IN ('fake-1','fake-2')`).get().c, 0);
    // history kept: 57 legacy bounties, old agent names as plain text
    assert.strictEqual(board.db.prepare("SELECT COUNT(*) c FROM bounties WHERE project_id='legacy'").get().c, 57);
    const withName = board.db.prepare("SELECT id FROM bounties WHERE claimed_by = 'opus-wsl-1' LIMIT 1").get();
    assert.ok(withName, 'legacy bounty still names its old agent');
    // nothing crashes on the missing agent; legacy never counts
    assert.strictEqual(board.get(withName.id).claimed_by, 'opus-wsl-1');
    assert.ok(board.list({ project: 'legacy' }).length === 57);
    const st = board.stats();
    assert.strictEqual(st.total_loot_earned, 0);
    assert.strictEqual(st.done, 0, 'legacy dones are not in the header counts');
    assert.strictEqual(st.legacy_excluded, 57);
    for (const s of board.ledger().slots) assert.strictEqual(s.total_loot, 0);
  };
  const b1 = new Board(load(cfgPath));
  check(b1);
  assert.ok(JSON.parse(dbm.getMeta(b1.db, 'agents_purged')).agents >= 12);
  const again = b1.migrateAgents();
  assert.deepStrictEqual(again, { purged: { agents: 0, agent_status: 0, agent_events: 0 }, credited: 0 });
  b1.db.close();
  const b2 = new Board(load(cfgPath)); // a restart re-runs it
  check(b2);
  b2.db.close();
});

test('leaderboard: loot, dones, streaks come only from verified dones; failures and $ cost from attempts; counters rebuilt to match', async () => {
  const t = await startBoard('ledger', { dispatch: false });
  try {
    const { board, repo, call } = t;
    const { rewardFor, lootFor, BONUSES } = require('../lib/board');
    const attempt = (bid, slot, cost, ended = true) => Number(board.db.prepare(`INSERT INTO attempts (bounty_id, slot, runner, model, started_at, ended_at, cost_usd, kind, outcome)
      VALUES (?, ?, 'command', 'x', ?, ?, ?, 'worker', 'test')`).run(bid, slot, new Date(Date.now() - 60000).toISOString(), ended ? new Date().toISOString() : null, cost).lastInsertRowid);
    const work = (title, slot, branch, file, extra = {}) => {
      const b = board.create({ title, project: 'scratch', criteria: CRIT, assignee_slot: slot, tier: 'B', ...extra });
      board.ready(b.id);
      const aid = attempt(b.id, slot, 1.5, false);
      board.start(b.id, slot);
      commitOnBranch(repo, branch, { [file]: `// ${branch}\nmodule.exports = 1;\n` });
      board.submit(b.id, { branch, actor: slot });
      return { id: b.id, aid };
    };
    // 1) fake-1: a real done (submit -> verify -> approve -> merged to main)
    const A = work('real work', 'fake-1', 'real-a', 'ra.js');
    await waitFor(() => board.raw(A.id).status === 'review');
    board.db.prepare('UPDATE attempts SET ended_at = ? WHERE id = ?').run(new Date().toISOString(), A.aid);
    board.approve(A.id);
    sh(repo, 'git merge -q --no-ff real-a -m "merge real-a"');
    assert.strictEqual(board.checkMerged(A.id).done, true);
    // 2) fake-2: an attempt that got rejected (failure, costs $2)
    const B = work('rejected work', 'fake-2', 'rej-b', 'rb.js');
    await waitFor(() => board.raw(B.id).status === 'review');
    board.db.prepare('UPDATE attempts SET ended_at = ?, cost_usd = 2 WHERE id = ?').run(new Date().toISOString(), B.aid);
    board.reject(B.id, 'wrong');
    // 3) fake-2: approved but never merged: pending, earns nothing, not a failure yet
    const C = work('approved not merged', 'fake-2', 'nm-c', 'nc.js');
    await waitFor(() => board.raw(C.id).status === 'review');
    board.db.prepare('UPDATE attempts SET ended_at = ?, cost_usd = 0.25 WHERE id = ?').run(new Date().toISOString(), C.aid);
    board.approve(C.id);
    // 4) faked: a bounty forced to done by SQL (no verified path) and a legacy "done" naming fake-2
    const F = board.create({ title: 'faked', project: 'scratch', criteria: CRIT, tier: 'S' });
    board.db.prepare("UPDATE bounties SET status='done', done_at=?, claimed_by='fake-2', work_evidence='trust me, long evidence string that used to pass the old reviewer' WHERE id=?").run(new Date().toISOString(), F.id);
    board.db.prepare(`INSERT OR IGNORE INTO projects (id, name, repo) VALUES ('legacy', 'Legacy', '')`).run();
    board.db.prepare(`INSERT INTO bounties (project_id, title, type, tier, status, done_at, claimed_by, verified_by, commits, credited_slot, reward)
      VALUES ('legacy', 'old', 'task', 'S', 'done', ?, 'fake-2', 'merge-check', '["abc"]', 'fake-2', 5000)`).run(new Date().toISOString());
    // stored counters are not trusted
    board.db.prepare("UPDATE agents SET total_loot = 999999, missions_completed = 99 WHERE id = 'fake-2'").run();

    const lb = Object.fromEntries((await call('GET', '/agents/leaderboard')).data.map(a => [a.id, a]));
    assert.deepStrictEqual(Object.keys(lb).sort(), ['fake-1', 'fake-2']);
    const expA = lootFor(rewardFor('task', 'B'), true, 0);
    assert.strictEqual(expA, Math.floor(750 * BONUSES.FIRST_TRY_MULT));
    assert.strictEqual(lb['fake-1'].total_loot, expA);
    assert.strictEqual(lb['fake-1'].missions_completed, 1);
    assert.strictEqual(lb['fake-1'].missions_failed, 0);
    assert.strictEqual(lb['fake-1'].streak, 1);
    assert.strictEqual(lb['fake-1'].cost_usd, 1.5);
    assert.strictEqual(board.raw(A.id).credited_slot, 'fake-1');
    assert.strictEqual(board.raw(A.id).credited_attempt, A.aid);
    assert.strictEqual(lb['fake-2'].total_loot, 0, 'no loot from rejected, unmerged, faked or legacy work');
    assert.strictEqual(lb['fake-2'].missions_completed, 0);
    assert.strictEqual(lb['fake-2'].missions_failed, 1, 'the rejected attempt is a failure; the approved-unmerged one is pending');
    assert.strictEqual(lb['fake-2'].cost_usd, 2.25);
    const st = (await call('GET', '/state')).data;
    assert.strictEqual(st.stats.total_loot_earned, expA);
    assert.strictEqual(st.slots.find(s => s.id === 'fake-1').record.total_loot, expA);
    assert.strictEqual(st.slots.find(s => s.id === 'fake-2').record.cost_usd, 2.25);

    // the agents table's counters are rebuilt from history and match the derived ledger
    board.rebuildAgents();
    const led = board.ledger().slots;
    for (const s of led) {
      const row = board.db.prepare('SELECT * FROM agents WHERE id = ?').get(s.id);
      for (const k of ['total_loot', 'level', 'missions_completed', 'missions_failed', 'streak']) assert.strictEqual(row[k], s[k], `${s.id}.${k}`);
      assert.ok(Math.abs(row.cost_usd - s.cost_usd) < 1e-9);
    }
    // a failure resets the streak and costs half the base reward; a second done on a streak pays the bonus
    const D = work('second real', 'fake-1', 'real-d', 'rd.js', { tier: 'C' });
    await waitFor(() => board.raw(D.id).status === 'review');
    board.db.prepare('UPDATE attempts SET ended_at = ? WHERE id = ?').run(new Date().toISOString(), D.aid);
    board.approve(D.id);
    sh(repo, 'git merge -q --no-ff real-d -m "merge real-d"');
    const r = board.checkMerged(D.id);
    assert.strictEqual(r.reward, lootFor(rewardFor('task', 'C'), true, 1));
    assert.strictEqual(board.slotStats('fake-1').total_loot, expA + r.reward);
    assert.strictEqual(board.db.prepare("SELECT total_loot FROM agents WHERE id='fake-1'").get().total_loot, expA + r.reward);
  } finally { await t.s.close(); }
});

test('agents API: only configured slots exist; any other id is refused', async () => {
  const t = await startBoard('agentsapi', { dispatch: false });
  try {
    const { call, board } = t;
    assert.deepStrictEqual((await call('GET', '/agents')).data.map(a => a.id).sort(), ['fake-1', 'fake-2']);
    for (const id of ['agent-gpt-4', 'opus-wsl-1', 'Opus-Conductor', 'made-up']) {
      const r = await call('POST', '/agents', { id });
      assert.strictEqual(r.status, 403, id); assert.match(r.data.error, /not a configured slot/);
      assert.strictEqual((await call('GET', `/agents/${id}`)).status, 404);
      assert.throws(() => board.registerAgent(id), /not a configured slot/);
    }
    assert.strictEqual((await call('POST', '/agents', {})).status, 400);
    const ok = await call('POST', '/agents', { id: 'fake-1' });
    assert.strictEqual(ok.status, 200); assert.strictEqual(ok.data.id, 'fake-1'); assert.strictEqual(ok.data.total_loot, 0);
    const one = await call('GET', '/agents/fake-2');
    assert.strictEqual(one.status, 200); assert.strictEqual(one.data.total_loot, 0); assert.strictEqual(one.data.cost_usd, 0);
    assert.strictEqual(board.db.prepare('SELECT COUNT(*) c FROM agents').get().c, 2);
    // a worker actor that is not a slot gets no agent row by starting work either
    const b = board.create({ title: 'x', project: 'scratch', criteria: CRIT });
    board.ready(b.id); board.start(b.id, 'rogue-agent');
    assert.strictEqual(board.db.prepare('SELECT COUNT(*) c FROM agents').get().c, 2);
  } finally { await t.s.close(); }
});

test('close-merged: commits a slot submitted and the orchestrator merged credit that slot', async () => {
  const t = await startBoard('closemerged-slot', { dispatch: false });
  try {
    const { board, repo } = t;
    const b = board.create({ title: 'slot work', project: 'scratch', criteria: CRIT, assignee_slot: 'fake-2' });
    board.ready(b.id); board.start(b.id, 'fake-2');
    commitOnBranch(repo, 'slot-br', { 'sb.js': 'module.exports = 3;\n' });
    board.submit(b.id, { branch: 'slot-br', actor: 'fake-2' });
    await waitFor(() => board.raw(b.id).ci_status !== 'running');
    sh(repo, 'git merge -q --no-ff slot-br -m "merge slot-br"');
    const sha = sh(repo, 'git rev-parse slot-br').trim();
    const r = board.closeMerged(b.id, { commits: [sha], evidence: 'merged by hand' });
    assert.strictEqual(r.credited, 'fake-2');
    assert.ok(r.reward > 0);
    assert.strictEqual(board.slotStats('fake-2').total_loot, r.reward);
    assert.strictEqual(board.slotStats('fake-1').total_loot, 0);
  } finally { await t.s.close(); }
});

test('dispatcher: a slot with disabled_until in the future takes no work', async () => {
  const cmd = ['bash', path.join(ROOT, 'test', 'fake-worker.sh')];
  const t = await startBoard('bench', { dispatch: false, over: { slots: [
    { id: 'benched', name: 'Benched', runner: 'command', cmd, disabled_until: new Date(Date.now() + 3600e3).toISOString() },
    { id: 'expired', name: 'Expired', runner: 'command', cmd, disabled_until: new Date(Date.now() - 1000).toISOString() },
  ] } });
  try {
    const benched = t.board.create({ title: 'b', project: 'scratch', type: 'task', tier: 'C', criteria: CRIT, status: 'ready', assignee_slot: 'benched' });
    const expired = t.board.create({ title: 'e', project: 'scratch', type: 'task', tier: 'C', criteria: CRIT, status: 'ready', assignee_slot: 'expired' });
    t.s.dispatcher.tick();
    await new Promise(r => setTimeout(r, 1500));
    assert.equal(t.board.raw(benched.id).status, 'ready');
    assert.notEqual(t.board.raw(expired.id).status, 'ready');
  } finally { await t.s.close(); }
});

test('board restart re-queues verifies that were queued or running', async () => {
  const t = await startBoard('resume-verify', { dispatch: false });
  let id;
  try {
    const b = t.board.create({ title: 'r', project: 'scratch', type: 'task', tier: 'C', criteria: CRIT, status: 'in_progress' });
    id = b.id;
    t.board.db.prepare(`UPDATE bounties SET ci_status = 'running', ci_at = ? WHERE id = ?`).run(new Date().toISOString(), id);
  } finally { await t.s.close(); }
  const { Board } = require('../lib/board');
  const b2 = new Board(t.cfg);
  try {
    const queued = b2.verifyQueue.some(j => j.id === id) || b2.verifyActive.has(id);
    assert.ok(queued, 'restarted board re-queues the running verify');
  } finally { b2.verifyQueue.length = 0; b2.db.close(); }
});

test('dispatcher: a slot with worktree_root builds its worktree there and symlinks the usual path', async () => {
  const t = await startBoard('wtroot', { dispatch: false });
  try {
    const root = path.join(t.dir, 'otherdrive');
    fs.mkdirSync(root);
    t.board.upsertProject({ id: 'scratch', repo: t.repo, main_branch: 'main', worktree_cmd: 'git worktree add "$WORKTREE_ROOT/{task}" -b {branch} {main}',
      worktree_path: path.join(t.dir, 'wt', '{task}'), verify_cmd: './verify.sh', verify_timeout_min: 2 });
    fs.mkdirSync(path.join(t.dir, 'wt'), { recursive: true });
    const b = t.board.create({ title: 'on hdd', project: 'scratch', type: 'task', tier: 'C', criteria: CRIT, status: 'ready' });
    const logFd = fs.openSync(path.join(t.dir, 'wtroot.log'), 'a');
    const wt = await t.s.dispatcher.ensureWorktree(t.board.need(b.id), t.board.project('scratch'), logFd, { id: 'hdd-slot', worktree_root: root });
    fs.closeSync(logFd);
    assert.ok(fs.lstatSync(wt.worktree).isSymbolicLink(), 'usual path is a symlink');
    assert.equal(fs.realpathSync(wt.worktree), fs.realpathSync(path.join(root, wt.branch)));
    assert.ok(fs.existsSync(path.join(wt.worktree, 'math.js')));
  } finally { await t.s.close(); }
});
