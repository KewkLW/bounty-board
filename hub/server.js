// The hub: one page for every running board. Boards register themselves in the registry dir
// (lib/registry.js); the hub reads it on every request, fetches each board's API and status files
// from the server side (a browser cannot read eight other ports) and serves one JSON to its page.
//   node hub/server.js      port: $HUB_PORT, $PORT, config/hub.json "port", else 3770
const express = require('express');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { allowList } = require('../lib/allow');
const registry = require('../lib/registry');
const { registryDir, ROOT } = require('../lib/config');
const { computeGoals, noteView } = require('../lib/goals');

const DEFAULT_CIDRS = ['127.0.0.0/8', '::1/128', '100.64.0.0/10', 'fd7a:115c:a1e0::/48'];
const ATTENTION = ['blocked', 'review', 'approved'];
const OPEN = ['backlog', 'ready', 'in_progress', 'review', 'approved', 'blocked'];
// A blocked item is waiting on a person when its reason contains one of these (case-insensitive).
// config/hub.json "human_markers" adds to them (e.g. the user's name); everything else that is
// blocked (worker crashes, agent-to-agent notes) stays in its project tab, never in Needs you.
const HUMAN_MARKERS = ['waiting on', 'needs a human', 'blocked on a human', 'needs the user'];

function loadHubConfig(file) {
  const p = file || process.env.HUB_CONFIG || path.join(ROOT, 'config', 'hub.json');
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { if (file || process.env.HUB_CONFIG) throw e; }
  const port = process.env.HUB_PORT || process.env.PORT;
  return {
    port: port != null && port !== '' ? Number(port) : cfg.port ?? 3770,
    host: cfg.host || '0.0.0.0',
    allow_cidrs: cfg.allow_cidrs || DEFAULT_CIDRS,
    registry_dir: process.env.BOUNTY_REGISTRY_DIR || cfg.registry_dir || registryDir(),
    fetch_timeout_ms: cfg.fetch_timeout_ms ?? 3000,
    cache_ms: cfg.cache_ms ?? 5000,
    stopped_keep_days: cfg.stopped_keep_days ?? 7,
    human_markers: [...new Set(HUMAN_MARKERS.concat(cfg.human_markers || []).map(m => String(m).toLowerCase().trim()).filter(Boolean))],
  };
}

// Where the hub itself reaches a board: loopback unless the board bound one address.
function apiBase(e) {
  const h = !e.host || e.host === '0.0.0.0' || e.host === '::' ? '127.0.0.1' : e.host;
  return `http://${h.includes(':') ? `[${h}]` : h}:${e.port}`;
}

async function getJson(url, ms) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(ms), cache: 'no-store' });
    if (!r.ok) return { ok: false, status: r.status, data: null };
    return { ok: true, status: r.status, data: await r.json() };
  } catch (e) { return { ok: false, error: e.name === 'TimeoutError' ? 'timeout' : e.message, data: null }; }
}

function waitsOnHuman(reason, markers = HUMAN_MARKERS) {
  const r = String(reason || '').toLowerCase();
  return !!r && markers.some(m => r.includes(String(m).toLowerCase()));
}

// One board's summary for the hub: everything its own Status page shows, in one object.
async function boardView(e, cfg, now = Date.now()) {
  const base = apiBase(e);
  const view = {
    name: e.name, port: e.port, default_project: e.default_project || null, accent: e.accent || registry.DEFAULT_ACCENT,
    api: base, started_at: e.started_at || null, stopped_at: e.stopped_at || null,
    online: false, offline_reason: null, idle: true, paused: false,
    stats: null, note: null, goals: null, now_goal: null, working: [], attention: [], needs_human: [], blocked_other: [], recent: [], open: 0,
  };
  if (e.stopped) { view.offline_reason = e.stopped_at ? 'stopped' : 'process gone'; return view; }
  const ms = cfg.fetch_timeout_ms;
  const [stats, all, state, goals, notes] = await Promise.all([
    getJson(base + '/api/bounties/stats', ms), getJson(base + '/api/bounties', ms), getJson(base + '/api/state', ms),
    getJson(base + '/status-goals.json', ms), getJson(base + '/status-notes.json', ms),
  ]);
  if (!all.ok || !Array.isArray(all.data)) { view.offline_reason = all.error || `HTTP ${all.status}`; return view; }
  const bounties = all.data;
  const byId = new Map(bounties.map(b => [b.id, b]));
  view.online = true;
  view.stats = stats.data;
  view.paused = !!(state.data && state.data.paused);
  view.note = noteView(notes.data, now);
  view.goals = computeGoals(goals.data && goals.data.goals, bounties);
  const nowGoal = view.goals && view.goals.find(g => g.now);
  view.now_goal = nowGoal ? nowGoal.id : null;
  view.working = ((state.data && state.data.slots) || []).filter(s => s.bounty).map(s => {
    const b = byId.get(s.bounty.id) || s.bounty;
    return {
      slot: s.id, slot_name: s.name || s.id, model: s.model || null, state: s.state,
      bounty: { id: b.id, title: b.title, status: b.status }, heartbeat_at: s.bounty.heartbeat_at || b.heartbeat_at || null,
      started_at: (s.attempt && s.attempt.started_at) || null,
    };
  });
  const markers = cfg.human_markers || HUMAN_MARKERS;
  view.attention = bounties.filter(b => ATTENTION.includes(b.status)).map(b => ({
    id: b.id, title: b.title, status: b.status, project: b.project_id || null, blocked_reason: b.blocked_reason || null,
    needs_human: b.status === 'blocked' && waitsOnHuman(b.blocked_reason, markers),
  }));
  view.needs_human = view.attention.filter(a => a.needs_human);
  view.blocked_other = view.attention.filter(a => a.status === 'blocked' && !a.needs_human);
  const dayAgo = now - 864e5;
  view.recent = bounties.filter(b => b.status === 'done' && b.done_at && new Date(b.done_at).getTime() > dayAgo)
    .sort((a, b) => new Date(b.done_at) - new Date(a.done_at)).map(b => ({ id: b.id, title: b.title, done_at: b.done_at }));
  view.open = bounties.filter(b => OPEN.includes(b.status)).length;
  view.idle = view.working.length === 0;
  return view;
}

// Active boards first, then idle ones, then offline; by name within each.
const rank = b => (!b.online ? 2 : b.idle ? 1 : 0);
const byRank = (a, b) => rank(a) - rank(b) || String(a.name).localeCompare(String(b.name)) || a.port - b.port;

async function aggregate(cfg, now = Date.now()) {
  const keepMs = cfg.stopped_keep_days * 864e5;
  const entries = registry.list(cfg.registry_dir)
    .filter(e => !(e.stopped_at && now - new Date(e.stopped_at).getTime() > keepMs));
  const boards = (await Promise.all(entries.map(e => boardView(e, cfg, now)))).sort(byRank);
  const needs_you = boards.flatMap(b => b.needs_human.map(x => ({ ...x, board: b.name, port: b.port, project: x.project || b.default_project })));
  return { at: new Date(now).toISOString(), registry_dir: cfg.registry_dir, boards, needs_you };
}

function createHub(cfg = loadHubConfig()) {
  const app = express();
  const allowed = allowList(cfg.allow_cidrs);
  app.use((req, res, next) => (allowed(req.socket.remoteAddress) ? next() : res.status(403).send('forbidden')));

  // Several open tabs share one fan-out per cache window.
  let cached = null;
  const snapshot = () => {
    if (!cached || Date.now() - cached.at > cfg.cache_ms) {
      const p = aggregate(cfg);
      cached = { at: Date.now(), p };
      p.catch(() => { cached = null; });
    }
    return cached.p;
  };

  app.get('/api/hub', async (req, res) => {
    try {
      const data = await snapshot();
      // Links the browser follows: the board's port on whatever host the page was opened on.
      const host = req.hostname && req.hostname.includes(':') ? `[${req.hostname}]` : req.hostname || '127.0.0.1';
      const boards = data.boards.map(b => ({ ...b, url: `${req.protocol}://${host}:${b.port}` }));
      res.set('cache-control', 'no-store').json({ ...data, boards });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.get('/health', (req, res) => res.json({ ok: true }));
  app.use(express.static(path.join(__dirname, 'public')));
  // The default Omarchy theme, shared with the boards' default pages.
  const pub = path.join(ROOT, 'public');
  for (const f of ['op.css', 'op-theme.js', 'status.css']) app.get('/' + f, (req, res) => res.sendFile(path.join(pub, f)));
  app.use('/img', express.static(path.join(pub, 'img')));

  const server = http.createServer(app);
  return {
    app, server, cfg,
    listen: () => new Promise(resolve => server.listen(cfg.port, cfg.host, () => resolve(server.address().port))),
    close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

module.exports = { createHub, loadHubConfig, aggregate, boardView, apiBase, waitsOnHuman, HUMAN_MARKERS };

if (require.main === module) {
  const cfg = loadHubConfig();
  const hub = createHub(cfg);
  hub.listen().then(port => console.log(`TOTALLY NOT A KANBAN hub on http://${cfg.host}:${port}  (registry ${cfg.registry_dir})`));
  const bye = () => hub.close().then(() => process.exit(0));
  process.on('SIGTERM', bye);
  process.on('SIGINT', bye);
}
