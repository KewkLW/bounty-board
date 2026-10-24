// The hub: the board registry, a real board registering itself, and GET /api/hub aggregating
// two fake boards (plus one that does not answer) on ephemeral ports.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { startBoard, waitFor, tmpdir, writeConfig, ROOT } = require('./helpers');
const registry = require('../lib/registry');
const { computeGoals, noteView } = require('../lib/goals');
const { loadHubConfig, waitsOnHuman, HUMAN_MARKERS } = require('../hub/server');
const { busyBoard, quietBoard, fakeBoard, deadPort, registerFake, startHub, hoursAgo } = require('./hub-fixtures');

const getHub = async url => (await fetch(url + '/api/hub')).json();

test('registry: atomic write, list, mark stopped, dead pid, junk files ignored', () => {
  const dir = path.join(tmpdir('reg'), 'boards');
  assert.deepStrictEqual(registry.list(dir), [], 'a missing dir is an empty list');
  const e = registry.register(dir, registry.entryFor({ default_project: 'alpha', host: '0.0.0.0' }, 4101, { name: 'Alpha' }));
  assert.strictEqual(e.name, 'Alpha');
  assert.strictEqual(e.accent, registry.DEFAULT_ACCENT, 'the default public dir has the default blue');
  assert.deepStrictEqual(fs.readdirSync(dir), ['4101.json'], 'no temp file left behind');
  fs.writeFileSync(path.join(dir, '4102.json'), '{ half written');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
  registry.register(dir, { ...e, port: 4103, pid: 999999999 });
  const l = registry.list(dir);
  assert.deepStrictEqual(l.map(x => [x.port, x.stopped]), [[4101, false], [4103, true]], 'bad JSON skipped; a dead pid counts as stopped');
  registry.unregister(dir, 4101, process.pid + 1);
  assert.strictEqual(registry.list(dir)[0].stopped, false, 'another process cannot mark it stopped');
  registry.unregister(dir, 4101);
  const after = registry.list(dir)[0];
  assert.ok(after.stopped && after.stopped_at, 'a clean exit marks the entry stopped');
});

test('registry: accent from board.json, else from the board\'s themed css', () => {
  const pub = tmpdir('accent');
  assert.strictEqual(registry.accentOf({ accent: '#123456' }, pub), '#123456');
  fs.writeFileSync(path.join(pub, 'op.css'), ':root {\n  --bg: #000;\n  --blue: #33ccaa;\n}\n');
  assert.strictEqual(registry.accentOf({}, pub), '#33ccaa');
  fs.writeFileSync(path.join(pub, 'op.css'), ':root { --accent: #ff7700; --blue: #33ccaa; }');
  assert.strictEqual(registry.accentOf({}, pub), '#ff7700');
});

test('a board registers itself on start and is marked stopped on close; configs need no new keys', async () => {
  const t = await startBoard('hubreg', { dispatch: false });
  let closed = false;
  try {
    const dir = t.cfg.registry_dir;
    const e = JSON.parse(fs.readFileSync(path.join(dir, `${t.cfg.port}.json`), 'utf8'));
    assert.strictEqual(e.port, t.cfg.port, 'registered with the real port, also when config says port 0');
    assert.strictEqual(e.pid, process.pid);
    assert.strictEqual(e.stopped_at, null);
    assert.ok(e.public_dir && e.accent && e.started_at);
    await t.s.close(); closed = true;
    assert.ok(JSON.parse(fs.readFileSync(path.join(dir, `${t.cfg.port}.json`), 'utf8')).stopped_at);
  } finally { if (!closed) await t.s.close(); }
});

test('node server.js registers itself, and SIGTERM marks it stopped (config without registry keys)', async () => {
  const dir = tmpdir('hubproc');
  const cfgPath = writeConfig(dir, { slots: [] });
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  delete cfg.registry_dir;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  const regDir = path.join(dir, 'state', 'totally-not-a-kanban', 'boards');
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, BOUNTY_CONFIG: cfgPath, BOUNTY_NO_SEED: '1', XDG_STATE_HOME: path.join(dir, 'state'), BOUNTY_REGISTRY_DIR: '' },
    stdio: 'ignore',
  });
  try {
    const e = await waitFor(() => registry.list(regDir).find(x => x.pid === child.pid), 15000);
    assert.ok(e.port > 0 && !e.stopped, 'registered under $XDG_STATE_HOME/totally-not-a-kanban/boards');
    child.kill('SIGTERM');
    await waitFor(() => registry.list(regDir).find(x => x.pid === child.pid && x.stopped_at), 10000);
  } finally { try { child.kill('SIGKILL'); } catch {} }
});

test('goal rules match status.js: gate done = reached, road done = exit test not recorded, first open = Now', () => {
  const all = [
    { id: 1, title: 'A.1', status: 'done' }, { id: 2, title: 'A.2', status: 'done' },
    { id: 3, title: 'B.1', status: 'done' }, { id: 4, title: 'C.1', status: 'in_progress' }, { id: 5, title: 'C.2', status: 'blocked' },
  ];
  const g = computeGoals([
    { id: 'A', state: 'open', gate: 2, road_prefix: 'A.' },
    { id: 'B', state: 'open', road: [3] },
    { id: 'C', state: 'open', road: [4, 5] },
    { id: 'D', state: 'closed', gate: 2, road: [] },
  ], all);
  assert.deepStrictEqual(g.map(x => [x.id, x.state, x.label, x.now]), [
    ['A', 'reached', 'Reached', false],
    ['B', 'open', 'Road done, exit test not recorded', true],
    ['C', 'open', 'Open', false],
    ['D', 'closed', 'Not opened', false],
  ]);
  assert.deepStrictEqual([g[2].done, g[2].total, g[2].pct, g[2].working, g[2].stuck], [0, 2, 0, [4], [5]]);
  assert.strictEqual(computeGoals(null, all), null);
  assert.strictEqual(noteView({ written_at: hoursAgo(4), headline: 'x' }).stale, true);
  assert.strictEqual(noteView({ written_at: hoursAgo(1), headline: 'x' }).stale, false);
});

test('GET /api/hub: two fake boards and an offline one; a new board appears without a hub restart', async () => {
  const dir = path.join(tmpdir('hubapi'), 'boards');
  const busy = await fakeBoard(busyBoard());
  const quiet = await fakeBoard(quietBoard());
  const gone = await deadPort();
  registerFake(dir, quiet.port, { name: 'Archive Cleanup', default_project: 'archive', accent: '#e0af68' });
  registerFake(dir, gone, { name: 'Gone Board' });
  const hub = await startHub(dir);
  try {
    let d = await getHub(hub.url);
    assert.deepStrictEqual(d.boards.map(b => [b.name, b.online]), [['Archive Cleanup', true], ['Gone Board', false]]);

    // Registered after the hub started: picked up on the next request.
    registerFake(dir, busy.port, { name: 'Rocket Garden', default_project: 'rocket', accent: '#bb9af7' });
    d = await getHub(hub.url);
    assert.deepStrictEqual(d.boards.map(b => b.name), ['Rocket Garden', 'Archive Cleanup', 'Gone Board'], 'working first, idle next, offline last');

    const r = d.boards[0];
    assert.strictEqual(r.url, `http://127.0.0.1:${busy.port}`);
    assert.strictEqual(r.accent, '#bb9af7');
    assert.strictEqual(r.stats.done, 2);
    assert.deepStrictEqual([r.note.headline, r.note.stale, !!r.note.written_at], ['Pump is in, sensor waits on a human', false, true]);
    assert.deepStrictEqual(r.goals.map(g => [g.id, g.state, g.now, g.done, g.total]), [['G1', 'reached', false, 2, 2], ['G2', 'open', true, 0, 4], ['G3', 'closed', false, 0, 0]]);
    assert.strictEqual(r.now_goal, 'G2');
    assert.deepStrictEqual(r.goals[1].working, [3]);
    assert.deepStrictEqual(r.goals[1].stuck, [4]);
    assert.deepStrictEqual(r.working.map(w => [w.slot, w.slot_name, w.bounty.id]), [['w-1', 'Fern', 3]]);
    assert.deepStrictEqual(r.attention.map(a => [a.id, a.status]), [[4, 'blocked'], [5, 'review']]);
    assert.strictEqual(r.attention[0].blocked_reason, 'Waiting on a human to plug in the sensor');
    assert.deepStrictEqual([r.needs_human.map(a => a.id), r.blocked_other.map(a => a.id)], [[4], []]);
    assert.deepStrictEqual(r.recent.map(x => x.id), [2], 'finished in the last 24 h only');
    assert.strictEqual(r.idle, false);

    const q = d.boards[1];
    assert.strictEqual(q.idle, true);
    assert.strictEqual(q.goals, null, 'no goals file');
    assert.strictEqual(q.note.stale, true, 'a note older than 3 h is stale');
    assert.deepStrictEqual([q.needs_human.length, q.blocked_other.map(a => a.id)], [0, [2]], 'a question with no human marker is not "needs you"');

    const g = d.boards[2];
    assert.deepStrictEqual([g.online, g.stats, g.working], [false, null, []]);
    assert.ok(g.offline_reason);

    assert.deepStrictEqual(d.needs_you.map(x => [x.board, x.project, x.id, x.blocked_reason]), [
      ['Rocket Garden', 'rocket', 4, 'Waiting on a human to plug in the sensor'],
    ]);

    // A board that stops answering shows as offline; one that exits cleanly too.
    await busy.close();
    d = await getHub(hub.url);
    assert.deepStrictEqual(d.boards.map(b => [b.name, b.online]), [['Archive Cleanup', true], ['Gone Board', false], ['Rocket Garden', false]]);
    registry.unregister(dir, quiet.port);
    d = await getHub(hub.url);
    const arch = d.boards.find(b => b.name === 'Archive Cleanup');
    assert.deepStrictEqual([arch.online, arch.offline_reason], [false, 'stopped']);
  } finally { await hub.close(); await quiet.close(); try { await busy.close(); } catch {} }
});

test('GET /api/hub reads a real board end to end', async () => {
  const t = await startBoard('hubreal', { dispatch: false });
  const hub = await startHub(t.cfg.registry_dir);
  try {
    const b = t.board.create({ title: 'stuck thing', project: 'scratch', criteria: ['x'] });
    t.board.block(b.id, 'needs a human login', 'orchestrator');
    const d = await getHub(hub.url);
    assert.strictEqual(d.boards.length, 1);
    const x = d.boards[0];
    assert.strictEqual(x.online, true);
    assert.strictEqual(x.stats.blocked, 1);
    assert.deepStrictEqual(d.needs_you.map(n => [n.id, n.blocked_reason]), [[b.id, 'needs a human login']]);
    assert.ok(x.working.length === 0 && x.idle);
  } finally { await hub.close(); await t.s.close(); }
});

test('Needs you: only blocked reasons with a human marker (case-insensitive), extendable in hub.json', async () => {
  assert.deepStrictEqual(HUMAN_MARKERS, ['waiting on', 'needs a human', 'blocked on a human', 'needs the user']);
  for (const r of ['WAITING ON the login', 'this needs a human', 'Blocked on a human: keys', 'needs the user to choose']) assert.ok(waitsOnHuman(r), r);
  for (const r of ['worker exited with code 1', 'worker-2: rebase first', '', null, 'which label printer?']) assert.ok(!waitsOnHuman(r), String(r));
  const tmp = tmpdir('hubmark');
  const f = path.join(tmp, 'hub.json');
  fs.writeFileSync(f, JSON.stringify({ human_markers: ['Test Human', 'label printer'] }));
  const c = loadHubConfig(f);
  assert.deepStrictEqual(c.human_markers, [...HUMAN_MARKERS, 'test human', 'label printer'], 'config adds to the defaults');
  assert.ok(waitsOnHuman('ask test human', c.human_markers));

  // End to end: the extra marker moves Archive Cleanup's question into Needs you.
  const dir = path.join(tmp, 'boards');
  const quiet = await fakeBoard(quietBoard());
  registerFake(dir, quiet.port, { name: 'Archive Cleanup', default_project: 'archive' });
  const hub = await startHub(dir, { human_markers: c.human_markers });
  try {
    const d = await getHub(hub.url);
    assert.deepStrictEqual(d.needs_you.map(x => x.id), [2]);
    assert.deepStrictEqual(d.boards[0].blocked_other, []);
  } finally { await hub.close(); await quiet.close(); }
});

test('registry names: board.json project name, else the title-cased default project, never a raw id', () => {
  assert.strictEqual(registry.entryFor({}, 4101, { name: 'Rocket Garden', defaultProject: 'rocket' }).name, 'Rocket Garden');
  assert.strictEqual(registry.entryFor({}, 4101, { name: 'rocket-garden', defaultProject: 'rocket-garden' }).name, 'Rocket Garden', 'a name equal to the id is title-cased');
  assert.strictEqual(registry.entryFor({ default_project: 'my_old-shed' }, 4101).name, 'My Old Shed');
  assert.strictEqual(registry.entryFor({ name: 'Override' }, 4101, { name: 'X', defaultProject: 'x' }).name, 'Override');
  assert.strictEqual(registry.entryFor({}, 4101).name, 'Board 4101');
});

test('hub config: default port 3770, loopback + Tailscale ranges, env overrides; outside addresses get 403', async () => {
  const save = { HUB_PORT: process.env.HUB_PORT, PORT: process.env.PORT, HUB_CONFIG: process.env.HUB_CONFIG };
  delete process.env.HUB_PORT; delete process.env.PORT;
  process.env.HUB_CONFIG = path.join(tmpdir('hubcfg'), 'missing.json');
  try {
    assert.throws(() => loadHubConfig(), /ENOENT/, 'an explicit config that is missing is an error');
    delete process.env.HUB_CONFIG;
    const c = loadHubConfig(path.join(ROOT, 'config', 'hub.example.json'));
    assert.strictEqual(c.port, 3770);
    assert.deepStrictEqual(c.allow_cidrs, ['127.0.0.0/8', '::1/128', '100.64.0.0/10', 'fd7a:115c:a1e0::/48']);
    process.env.HUB_PORT = '3799';
    assert.strictEqual(loadHubConfig(path.join(ROOT, 'config', 'hub.example.json')).port, 3799);
  } finally { for (const [k, v] of Object.entries(save)) { if (v == null) delete process.env[k]; else process.env[k] = v; } }
  const hub = await startHub(path.join(tmpdir('hub403'), 'boards'), { allow_cidrs: ['10.255.255.0/24'] });
  try { assert.strictEqual((await fetch(hub.url + '/api/hub')).status, 403); } finally { await hub.close(); }
});
