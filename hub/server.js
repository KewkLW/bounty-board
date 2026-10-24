// The hub: one page for every running board. Boards register themselves in the registry dir
// (lib/registry.js); the hub reads it on every request, fetches each board's API and status files
// from the server side (a browser cannot read eight other ports) and serves one JSON to its page.
//   node hub/server.js      port: $HUB_PORT, $PORT, config/hub.json "port", else 3770
const express = require('express');
const fs = require('fs');
const http = require('http');
const { execFile } = require('child_process');
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
    // Replies from the Needs you boxes: signed with human_name; on_reply (argv array, no shell) delivers them live.
    human_name: typeof cfg.human_name === 'string' && cfg.human_name.trim() ? cfg.human_name.trim() : 'human',
    on_reply: Array.isArray(cfg.on_reply) && cfg.on_reply.length && cfg.on_reply.every(a => typeof a === 'string') ? cfg.on_reply : null,
    reply_timeout_ms: cfg.reply_timeout_ms ?? 5000,
    hook_timeout_ms: cfg.hook_timeout_ms ?? 15000,
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
// on_reply: each argv element gets its placeholders filled in one pass (a {text} holding "{id}" stays
// literal) and runs with execFile, never a shell. Resolves {ok, error}; never rejects.
const PLACEHOLDER = /\{(board|project|port|id|title|text|unblock|orchestrator)\}/g;
const fillArgv = (argv, vals) => argv.map(a => a.replace(PLACEHOLDER, (m, k) => String(vals[k] ?? '')));

function runHook(argv, ms) {
  return new Promise(resolve => {
    try {
      execFile(argv[0], argv.slice(1), { timeout: ms, killSignal: 'SIGKILL', maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
        if (!err) return resolve({ ok: true });
        const why = err.killed ? `timed out after ${ms} ms` : err.code === 'ENOENT' ? `${argv[0]}: not found` : typeof err.code === 'number' ? `exit code ${err.code}` : err.message;
        const tail = String(stderr || '').trim().split('\n').pop();
        resolve({ ok: false, error: tail ? `${why}: ${tail.slice(0, 200)}` : why });
      });
    } catch (e) { resolve({ ok: false, error: e.message }); }
  });
}

// POST /api/reply {port, bounty_id, text, unblock}: forward a reply to a registered board's
// human-notes API, then run on_reply. Returns [status, body].
async function reply(cfg, body) {
  const port = Number(body && body.port);
  const id = Number(body && body.bounty_id);
  if (!Number.isInteger(port) || port <= 0 || !Number.isInteger(id) || id <= 0) return [400, { error: 'port and bounty_id must be positive integers' }];
  if (body.text != null && typeof body.text !== 'string') return [400, { error: 'text must be a string' }];
  if (body.unblock != null && typeof body.unblock !== 'boolean') return [400, { error: 'unblock must be true or false' }];
  const unblock = !!body.unblock;
  let text = String(body.text || '').trim();
  if (!text && unblock) text = 'Done';
  if (!text) return [400, { error: 'type a message first' }];
  const entry = registry.list(cfg.registry_dir).find(e => e.port === port);
  if (!entry) return [404, { error: `no board is registered on port ${port}` }];
  const base = apiBase(entry);
  let status, out;
  try {
    const r = await fetch(`${base}/api/bounties/${id}/human-notes`, {
      method: 'POST', signal: AbortSignal.timeout(cfg.reply_timeout_ms),
      headers: { 'content-type': 'application/json', 'x-board-request': '1' },
      body: JSON.stringify({ text, from: cfg.human_name, unblock }),
    });
    status = r.status;
    try { out = await r.json(); } catch { out = { error: `board answered HTTP ${status}` }; }
  } catch (e) {
    return [502, { error: `${entry.name || 'the board'} did not answer${e.name === 'TimeoutError' ? ' in time' : ''}`, saved: false }];
  }
  // 409 = unblock asked on a bounty that is not blocked; the board still stored the note.
  const saved = (status >= 200 && status < 300) || (status === 409 && !!(out && out.note));
  const res = { ...(out && typeof out === 'object' ? out : {}), saved, delivered: null, text, unblock };
  if (!saved) return [status, res];
  if (cfg.on_reply) {
    const b = await getJson(`${base}/api/bounties/${id}`, cfg.fetch_timeout_ms);
    const argv = fillArgv(cfg.on_reply, {
      board: entry.name, project: (b.data && b.data.project_id) || entry.default_project, port, id,
      title: b.data && b.data.title, text, unblock: String(unblock), orchestrator: entry.orchestrator,
    });
    const h = await runHook(argv, cfg.hook_timeout_ms);
    res.delivered = h.ok;
    if (!h.ok) res.delivery_error = h.error;
  }
  return [status, res];
}

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
  // The page's reply boxes post here, never to a board: a custom header and a JSON body, so a
  // cross-site form or plain link cannot trigger it; only registered boards' ports are reachable.
  app.post('/api/reply', (req, res, next) => {
    if (req.get('x-hub-request') !== '1' || !req.is('application/json')) return res.status(403).json({ error: 'needs X-Hub-Request: 1 and a JSON body' });
    next();
  }, express.json({ limit: '64kb' }), async (req, res) => {
    const [status, body] = await reply(cfg, req.body);
    if (body.saved) cached = null;
    res.status(status).json(body);
  }, (err, req, res, next) => res.status(400).json({ error: 'bad JSON: ' + err.message }));
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

module.exports = { createHub, loadHubConfig, aggregate, boardView, apiBase, waitsOnHuman, fillArgv, reply, HUMAN_MARKERS };

if (require.main === module) {
  const cfg = loadHubConfig();
  const hub = createHub(cfg);
  hub.listen().then(port => console.log(`TOTALLY NOT A KANBAN hub on http://${cfg.host}:${port}  (registry ${cfg.registry_dir})`));
  const bye = () => hub.close().then(() => process.exit(0));
  process.on('SIGTERM', bye);
  process.on('SIGINT', bye);
}
