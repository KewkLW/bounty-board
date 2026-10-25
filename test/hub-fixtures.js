// Hub test fixtures: a fake board (canned board API + status files on an ephemeral port), a port
// nobody answers on, and a hub on an ephemeral port reading a temp registry dir.
const express = require('express');
const http = require('http');
const net = require('net');
const registry = require('../lib/registry');
const { createHub, loadHubConfig } = require('../hub/server');

const hoursAgo = h => new Date(Date.now() - h * 3600e3).toISOString();

// A board with work in every state: two goals (the first reached by its gate), a worker on a named
// slot, a blocked bounty with a reason, one in review, one finished an hour ago.
function busyBoard(name = 'Rocket Garden') {
  const bounties = [
    { id: 1, title: 'G1.1 Seed tray', status: 'done', done_at: hoursAgo(30), project_id: 'rocket' },
    { id: 2, title: 'G1.2 Gate: first sprout', status: 'done', done_at: hoursAgo(1), project_id: 'rocket' },
    { id: 3, title: 'G2.1 Water pump', status: 'in_progress', project_id: 'rocket' },
    { id: 4, title: 'G2.2 Soil sensor', status: 'blocked', blocked_reason: 'Waiting on a human to plug in the sensor', project_id: 'rocket' },
    { id: 5, title: 'G2.3 Dashboard', status: 'review', project_id: 'rocket' },
    { id: 6, title: 'G2.4 Harvest', status: 'ready', project_id: 'rocket' },
  ];
  return {
    name,
    bounties,
    stats: { done: 2, in_progress: 1, ready: 1, review: 1, approved: 0, blocked: 1, backlog: 0 },
    state: { paused: false, slots: [
      { id: 'w-1', name: 'Fern', model: 'opus', state: 'working', bounty: { id: 3, title: 'G2.1 Water pump', status: 'in_progress', heartbeat_at: hoursAgo(0.1) }, attempt: { started_at: hoursAgo(0.5) } },
      { id: 'w-2', name: 'Moss', model: 'sonnet', state: 'idle', bounty: null },
    ] },
    goals: { goals: [
      { id: 'G1', name: 'First sprout', goal: 'a seed grows', test: 'a photo of the sprout', state: 'open', gate: 2, road_prefix: 'G1.' },
      { id: 'G2', name: 'Self-watering', goal: 'the garden waters itself', test: 'a week without a human', state: 'open', road: [3, 4, 5, 6] },
      { id: 'G3', name: 'Market stall', state: 'closed', road: [] },
    ] },
    notes: { written_at: hoursAgo(0.5), headline: 'Pump is in, sensor waits on a human', body: ['The **pump** works.'] },
  };
}

function quietBoard(name = 'Archive Cleanup') {
  return {
    name,
    bounties: [{ id: 1, title: 'Sort the shelves', status: 'done', done_at: hoursAgo(48), project_id: 'archive' },
      { id: 2, title: 'Label the boxes', status: 'blocked', blocked_reason: 'which label printer?', project_id: 'archive' }],
    stats: { done: 1, in_progress: 0, ready: 0, review: 0, approved: 0, blocked: 1, backlog: 0 },
    state: { paused: false, slots: [{ id: 'q-1', name: 'Dust', state: 'idle', bounty: null }] },
    goals: null,
    notes: { written_at: hoursAgo(5), headline: 'Waiting on a printer answer', body: [] },
  };
}

// A board whose blocked items are mostly not for a person (worker crashes, agent notes), plus
// seven that are, one of them with a 2,000-character reason: the page must keep all of it in check.
function floodBoard(name = 'Wall Of Text') {
  const wall = 'Waiting on you: ' + 'the deploy key was rotated and the old one still sits in the vault, so every run fails at the same step. '.repeat(20).slice(0, 1984);
  const bounties = [{ id: 1, title: 'Huge reason', status: 'blocked', blocked_reason: wall, project_id: 'wall' }];
  for (let i = 2; i <= 7; i++) bounties.push({ id: i, title: `Human thing ${i}`, status: 'blocked', blocked_reason: `needs the user to pick option ${i}`, project_id: 'wall' });
  bounties.push({ id: 8, title: 'Crashed run', status: 'blocked', blocked_reason: 'worker exited with code 1 before submit', project_id: 'wall' });
  bounties.push({ id: 9, title: 'Agent note', status: 'blocked', blocked_reason: 'worker-2: rebase onto #12 first', project_id: 'wall' });
  return {
    name, bounties,
    stats: { done: 0, in_progress: 0, ready: 0, review: 0, approved: 0, blocked: 9, backlog: 0 },
    state: { paused: false, slots: [] },
    goals: null,
    notes: { written_at: hoursAgo(0.2), headline: 'A very long headline. '.repeat(30), body: ['A long paragraph. '.repeat(80), 'Second paragraph.'] },
  };
}

// Serve a fake board; `fixture` is read on every request so a test can change it.
async function fakeBoard(fixture) {
  const app = express();
  app.get('/api/bounties/stats', (req, res) => res.json(fixture.stats));
  app.get('/api/bounties', (req, res) => res.json(fixture.bounties));
  app.get('/api/bounties/:id', (req, res) => {
    const b = fixture.bounties.find(x => x.id === Number(req.params.id));
    return b ? res.json(b) : res.status(404).json({ error: 'not found' });
  });
  // The board's human-notes contract (bounty #2): X-Board-Request: 1, 400 empty, 404 unknown,
  // 409 unblock on a bounty that is not blocked (the note is still stored). Every call lands in
  // fixture.received; fixture.reply_status forces a failure.
  app.post('/api/bounties/:id/human-notes', express.json(), (req, res) => {
    fixture.received = fixture.received || [];
    fixture.received.push({ id: Number(req.params.id), headers: req.headers, body: req.body });
    if (fixture.reply_status) return res.status(fixture.reply_status).json({ error: 'board is having a bad day' });
    if (req.get('x-board-request') !== '1') return res.status(403).json({ error: 'forbidden' });
    const text = String((req.body && req.body.text) || '').trim();
    if (!text) return res.status(400).json({ error: 'text is required' });
    const b = fixture.bounties.find(x => x.id === Number(req.params.id));
    if (!b) return res.status(404).json({ error: 'not found' });
    const note = { id: (fixture.notes_stored = (fixture.notes_stored || 0) + 1), bounty_id: b.id, text, from: req.body.from || 'human', created_at: new Date().toISOString() };
    if (req.body.unblock && b.status !== 'blocked') return res.status(409).json({ error: `#${b.id} is not blocked`, note, bounty: { id: b.id, status: b.status } });
    if (req.body.unblock) { b.status = 'ready'; b.blocked_reason = null; }
    res.status(201).json({ note, bounty: { id: b.id, status: b.status } });
  });
  app.get('/api/state', (req, res) => res.json(fixture.state));
  // Orchestrator presence (bounty #7): the same object as /api/state's "orchestrator".
  app.get('/api/orchestrator', (req, res) => (fixture.state && fixture.state.orchestrator ? res.json(fixture.state.orchestrator) : res.status(404).json({ error: 'no presence on this board' })));
  app.get('/status-goals.json', (req, res) => (fixture.goals ? res.json(fixture.goals) : res.status(404).end()));
  app.get('/status-notes.json', (req, res) => (fixture.notes ? res.json(fixture.notes) : res.status(404).end()));
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return { port, fixture, close: () => new Promise(r => { server.closeAllConnections(); server.close(r); }) };
}

// A port that was free a moment ago and has nobody listening now.
async function deadPort() {
  const s = net.createServer();
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  const port = s.address().port;
  await new Promise(r => s.close(r));
  return port;
}

function registerFake(dir, port, extra = {}) {
  return registry.register(dir, { name: extra.name || `board ${port}`, port, host: '127.0.0.1', default_project: extra.default_project || null,
    public_dir: null, accent: extra.accent || '#7aa2f7', pid: process.pid, started_at: new Date().toISOString(), stopped_at: null, ...extra });
}

async function startHub(dir, over = {}) {
  process.env.BOUNTY_REGISTRY_DIR = dir;
  const cfg = { ...loadHubConfig(), port: 0, host: '127.0.0.1', allow_cidrs: ['127.0.0.0/8', '::1/128'], registry_dir: dir, cache_ms: 0, fetch_timeout_ms: 1500, ...over };
  delete process.env.BOUNTY_REGISTRY_DIR;
  const hub = createHub(cfg);
  const port = await hub.listen();
  return { hub, port, url: `http://127.0.0.1:${port}`, close: () => hub.close() };
}

// A presence object as a board's /api/state and /api/orchestrator return it.
function presence(over = {}) {
  return { name: 'Conductor', expected_name: 'Conductor', online: true, pid: 4242, since: hoursAgo(2), last_seen: new Date().toISOString(),
    start_time: 1, registered: true, required: false, pending: 2, warning: null, ...over };
}

module.exports = { presence, busyBoard, quietBoard, floodBoard, fakeBoard, deadPort, registerFake, startHub, hoursAgo };
