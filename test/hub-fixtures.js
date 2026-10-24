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
    { id: 4, title: 'G2.2 Soil sensor', status: 'blocked', blocked_reason: 'needs the sensor plugged in by a human', project_id: 'rocket' },
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

// Serve a fake board; `fixture` is read on every request so a test can change it.
async function fakeBoard(fixture) {
  const app = express();
  app.get('/api/bounties/stats', (req, res) => res.json(fixture.stats));
  app.get('/api/bounties', (req, res) => res.json(fixture.bounties));
  app.get('/api/state', (req, res) => res.json(fixture.state));
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

module.exports = { busyBoard, quietBoard, fakeBoard, deadPort, registerFake, startHub, hoursAgo };
