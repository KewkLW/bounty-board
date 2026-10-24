// Totally not a Kanban: the task system every agent is accountable to.
// HTTP + WebSocket on :3777, the dispatcher, the reviewer, all in one process.
const express = require('express');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');
const { load } = require('./lib/config');
const { Board } = require('./lib/board');
const { Dispatcher } = require('./lib/dispatcher');
const { Reviewer } = require('./lib/reviewer');
const { makeApi } = require('./lib/api');
const { allowList } = require('./lib/allow');
const registry = require('./lib/registry');

// Optional: seed a default project from config.  Set "seed_project" in board.json to auto-create
// a project on first boot.  Example:
//   "seed_project": { "id": "my-project", "repo": "/path/to/repo", "main_branch": "main",
//     "verify_cmd": "npm test", "verify_timeout_min": 30 }


function createServer(cfg, { dispatch = true, seed = true } = {}) {
  const board = new Board(cfg);
  if (seed && cfg.seed_project && !board.project(cfg.seed_project.id) && !process.env.BOUNTY_NO_SEED) board.upsertProject(cfg.seed_project);
  const dispatcher = new Dispatcher(board);
  const reviewer = new Reviewer(board);

  const app = express();
  const allowed = cfg.allow_cidrs ? allowList(cfg.allow_cidrs) : () => true;
  app.use((req, res, next) => (allowed(req.socket.remoteAddress) ? next() : res.status(403).send('forbidden')));
  app.use(express.json({ limit: '2mb' }));
  app.use('/api', makeApi(board, dispatcher));
  // A board instance may serve its own themed copy of the UI (config public_dir); default is ./public.
  const pub = cfg.public_dir ? path.resolve(cfg.public_dir) : path.join(__dirname, 'public');
  app.use(express.static(pub));
  app.get('/roster', (req, res) => res.sendFile(path.join(pub, 'roster.html')));
  app.get('/live', (req, res) => res.sendFile(path.join(pub, 'live.html')));
  app.get('/leaderboard', (req, res) => res.sendFile(path.join(pub, 'leaderboard.html')));
  app.get('/health', (req, res) => res.json({ ok: true, paused: board.paused() }));

  const server = http.createServer(app);
  const wss = new WebSocket.Server({ server });
  wss.on('connection', (ws, req) => { if (!allowed(req.socket.remoteAddress)) ws.close(); });
  let pending = null;
  board.on('changed', ev => {
    pending = pending || [];
    pending.push(ev);
    if (pending.length > 1) return;
    setTimeout(() => {
      const msg = JSON.stringify({ type: 'changed', events: pending, at: new Date().toISOString() });
      pending = null;
      for (const c of wss.clients) if (c.readyState === WebSocket.OPEN) c.send(msg);
    }, 250);
  });

  function listen() {
    return new Promise(resolve => server.listen(cfg.port, cfg.host, () => {
      cfg.port = server.address().port;
      // Tell the hub this board is up (a config built without load() has no registry_dir: skip).
      if (cfg.registry_dir) {
        try {
          const proj = board.project(board.defaultProject()) || {};
          registry.register(cfg.registry_dir, registry.entryFor(cfg, cfg.port, { name: proj.name, defaultProject: board.defaultProject(), publicDir: pub }));
        } catch (e) { console.error('[registry]', e.message); }
      }
      if (dispatch) { dispatcher.start(); reviewer.start(); }
      resolve(server.address().port);
    }));
  }
  function close() {
    dispatcher.stop(); reviewer.stop();
    if (cfg.registry_dir) { try { registry.unregister(cfg.registry_dir, cfg.port); } catch {} }
    for (const c of wss.clients) c.terminate();
    return new Promise(resolve => server.close(() => { board.db.close(); resolve(); }));
  }
  return { app, server, board, dispatcher, reviewer, listen, close };
}

module.exports = { createServer, allowList };

if (require.main === module) {
  const cfg = load();
  const s = createServer(cfg);
  s.listen().then(port => {
    console.log(`TOTALLY NOT A KANBAN on http://${cfg.host}:${port}  (db ${cfg.db_path}, logs ${cfg.logs_dir}, ${cfg.slots.length} slots, cap ${cfg.concurrency_cap}${s.board.paused() ? ', PAUSED' : ''})`);
  });
  const bye = () => { console.log('shutting down (workers keep running; they are re-attached on start)'); s.close().then(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); };
  process.on('SIGTERM', bye);
  process.on('SIGINT', bye);
}
