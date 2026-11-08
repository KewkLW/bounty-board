// The project's agent room: resolving it (board.json "room", the AGENT ROOM: rule, neither), the finish
// report's text for every outcome, the idle/not-idle tail, and posting through a fake room server
// (join on first post, failures logged and never blocking the board).
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const room = require('../lib/room');
const { startBoard, waitFor } = require('./helpers');

const CRIT = ['works'];
const RULE = "AGENT ROOM: this project's chat room is `scratch-room` (http://myhost.example.ts.net:3396/r/scratch-room/), shared with the orchestrator (Conductor), the other workers and Kewk.";

// A stand-in for roomd: the same POST /api/r/<id>/<action> contract (X-Room-Request: 1, JSON body),
// members must have joined before they post. `fail` makes every post answer that status.
function fakeRoom({ id = 'scratch-room', admin = 'Conductor', joined = [], fail = null } = {}) {
  const posts = [], requests = [];
  const members = new Set(joined);
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => body += d).on('end', () => {
      const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      const parts = req.url.split('?')[0].split('/').filter(Boolean);
      requests.push({ method: req.method, path: req.url, headers: req.headers, body });
      if (parts[0] !== 'api' || parts[1] !== 'r' || parts[2] !== id) return send(404, { error: 'unknown room' });
      if (req.method === 'GET' && parts.length === 3) return send(200, { id, admin, members: [] });
      if (req.method !== 'POST') return send(404, { error: 'unknown endpoint' });
      if (req.headers['x-room-request'] !== '1' || !/application\/json/.test(req.headers['content-type'] || '')) return send(403, { error: 'needs X-Room-Request: 1 and a JSON body' });
      const b = JSON.parse(body || '{}');
      if (parts[3] === 'join') { members.add(b.as); return send(200, { joined: b.as }); }
      if (parts[3] === 'post') {
        if (fail) return send(fail, { error: 'boom' });
        if (!members.has(b.as)) return send(403, { error: `'${b.as}' has not joined ${id}: room_join first` });
        posts.push(b);
        return send(200, { seq: posts.length });
      }
      return send(404, { error: 'unknown endpoint' });
    });
  });
  return new Promise(resolve => srv.listen(0, '127.0.0.1', () => {
    const port = srv.address().port;
    resolve({ id, port, url: `http://127.0.0.1:${port}/r/${id}/`, posts, requests, members,
      close: () => new Promise(r => { srv.closeAllConnections?.(); srv.close(() => r()); }) });
  }));
}

const quietLog = () => { const lines = []; return { lines, error: m => lines.push(m) }; };

test('room resolution: the board.json setting, else the AGENT ROOM: rule, else none', () => {
  const set = room.resolve({ room: { id: 'garden', url: 'http://127.0.0.1:3400/r/garden/' }, machine_rules: [RULE] });
  assert.deepStrictEqual(set, { id: 'garden', url: 'http://127.0.0.1:3400/r/garden/', port: 3400, api: 'http://127.0.0.1:3400', as: null });
  const fromRule = room.resolve({ machine_rules: ['Never push to main.', RULE] });
  assert.strictEqual(fromRule.id, 'scratch-room');
  assert.strictEqual(fromRule.url, 'http://myhost.example.ts.net:3396/r/scratch-room/');
  assert.strictEqual(fromRule.api, 'http://127.0.0.1:3396', 'posts go over loopback');
  assert.strictEqual(room.resolve({ room: { id: 'bare' } }).url, 'http://127.0.0.1:3396/r/bare/', 'url defaults to the local room server');
  assert.strictEqual(room.resolve({ machine_rules: ['Never push to main.'] }), null);
  assert.strictEqual(room.resolve({}), null);
  assert.strictEqual(room.resolve({ room: {} }), null);
});

test('poster name matches the member roomctl board-sync invites for the board', () => {
  assert.strictEqual(room.posterName({ name: 'Totally not a Kanban!' }), 'Totally not a Kanban');
  assert.strictEqual(room.posterName({ default_project: 'my-garden_v2' }), 'My Garden V2');
  assert.strictEqual(room.posterName({ port: 3777 }), 'Board 3777');
  assert.strictEqual(room.posterName({ name: 'X', room_resolved: { as: 'Board Bot' } }), 'Board Bot');
});

test('finish report text for every outcome, and the idle tail', () => {
  const base = { orchestrator: 'Conductor', worker: 'Alpha', slot: 'fake-1', id: 12, title: 'Add mul() with a test' };
  const text = (b, ctx, idle = false) => room.reportText({ ...base, outcome: room.outcomeOf(b, ctx), idle });
  assert.strictEqual(text({ status: 'review' }, {}),
    '@Conductor Alpha (fake-1) finished #12 Add mul() with a test: submitted.');
  assert.strictEqual(text({ status: 'approved' }, {}, true),
    "@Conductor Alpha (fake-1) finished #12 Add mul() with a test: submitted. Alpha is idle: what's next?");
  assert.strictEqual(text({ status: 'in_progress', ci_status: 'running' }, {}),
    '@Conductor Alpha (fake-1) finished #12 Add mul() with a test: submitted, verifying.');
  assert.strictEqual(text({ status: 'blocked' }, { code: 1, before: { status: 'in_progress', ci_status: 'fail' } }, true),
    "@Conductor Alpha (fake-1) finished #12 Add mul() with a test: verify failed. Alpha is idle: what's next?");
  assert.strictEqual(text({ status: 'blocked' }, { code: 0, before: { status: 'in_progress', ci_status: null } }),
    '@Conductor Alpha (fake-1) finished #12 Add mul() with a test: exited without submitting.');
  assert.strictEqual(text({ status: 'blocked' }, { code: 137, why: 'signal SIGKILL', before: { status: 'in_progress' } }),
    '@Conductor Alpha (fake-1) finished #12 Add mul() with a test: exited without submitting (signal SIGKILL).');
  assert.strictEqual(text({ status: 'blocked' }, { code: 2, before: { status: 'in_progress' } }),
    '@Conductor Alpha (fake-1) finished #12 Add mul() with a test: failed (exit 2, not submitted).');
  assert.strictEqual(text({ status: 'blocked' }, { code: 3, before: { status: 'ready' } }),
    '@Conductor Alpha (fake-1) finished #12 Add mul() with a test: failed (never ran bounty start).');
  assert.strictEqual(text({ status: 'blocked', blocked_reason: 'needs a GPU decision.' }, { before: { status: 'blocked' } }),
    '@Conductor Alpha (fake-1) finished #12 Add mul() with a test: blocked: needs a GPU decision.');
  assert.strictEqual(text({ status: 'blocked', blocked_reason: 'killed: wrong approach; log /tmp/logs/bounty-12.log' }, { before: { status: 'blocked' } }),
    '@Conductor Alpha (fake-1) finished #12 Add mul() with a test: blocked: killed: wrong approach.');
  assert.strictEqual(text({ status: 'failed' }, { before: { status: 'failed' } }),
    '@Conductor Alpha (fake-1) finished #12 Add mul() with a test: failed.');
  // the orchestrator is the only one addressed: a worker @mention would become a note on its bounty
  assert.strictEqual((text({ status: 'review' }, {}, true).match(/@/g) || []).length, 1);
});

test('RoomClient: posts with the room headers, joins on the first refused post, asks the room for its admin', async () => {
  const fr = await fakeRoom({ admin: 'RoomAdmin' });
  try {
    const cfg = { name: 'Scratch Board', room_resolved: room.normalize(fr.id, fr.url) };
    const c = new room.RoomClient(cfg, { log: quietLog() });
    const sent = await c.report({ worker: 'Alpha', slot: 'fake-1', id: 1, title: 'x', outcome: 'submitted', idle: true });
    assert.strictEqual(sent, "@RoomAdmin Alpha (fake-1) finished #1 x: submitted. Alpha is idle: what's next?");
    assert.deepStrictEqual(fr.posts, [{ as: 'Scratch Board', text: sent }]);
    assert.ok(fr.requests.some(r => r.path.endsWith('/join')), 'joined after the 403');
    const post = fr.requests.filter(r => r.path.endsWith('/post')).pop();
    assert.strictEqual(post.headers['x-room-request'], '1');
    // board.json "orchestrator" wins over the room admin
    const c2 = new room.RoomClient({ ...cfg, orchestrator: 'Conductor' }, { log: quietLog() });
    assert.match(await c2.report({ worker: 'Bravo', slot: 'fake-2', id: 2, title: 'y', outcome: 'blocked', idle: false }), /^@Conductor Bravo \(fake-2\) finished #2 y: blocked\.$/);
  } finally { await fr.close(); }
});

test('RoomClient: a refused, failing or unreachable room is logged and never throws; no room means no request', async () => {
  const fr = await fakeRoom({ joined: ['Scratch Board'], fail: 500 });
  const log = quietLog();
  try {
    const cfg = { name: 'Scratch Board', orchestrator: 'Conductor', room_resolved: room.normalize(fr.id, fr.url) };
    const c = new room.RoomClient(cfg, { log });
    assert.strictEqual(await c.report({ worker: 'A', slot: 's', id: 1, title: 't', outcome: 'submitted' }), null);
    assert.match(log.lines[0], /\[room\] report to scratch-room failed: .*500 boom/);
  } finally { await fr.close(); }
  // nothing listens there now
  const gone = new room.RoomClient({ orchestrator: 'Conductor', room_resolved: room.normalize('scratch-room', fr.url) }, { log, timeoutMs: 1000 });
  assert.strictEqual(await gone.report({ worker: 'A', slot: 's', id: 1, title: 't', outcome: 'submitted' }), null);
  assert.strictEqual(log.lines.length, 2);
  const none = new room.RoomClient({ orchestrator: 'Conductor', room_resolved: null }, { log });
  assert.strictEqual(none.enabled, false);
  assert.strictEqual(none.report({ worker: 'A', slot: 's', id: 1, title: 't', outcome: 'submitted' }), null);
});

test('board: one report per ended attempt, "what\'s next" only when the slot gets nothing; Chat tab API', async () => {
  const fr = await fakeRoom();
  const t = await startBoard('room', { over: { name: 'Scratch Board', orchestrator: 'Conductor', room: { id: fr.id, url: fr.url },
    slots: [{ id: 'fake-1', name: 'Alpha', runner: 'command', model: 'sonnet', cmd: ['bash', require('path').join(__dirname, 'fake-worker.sh')] }] } });
  try {
    const { board, call } = t;
    const api = (await call('GET', '/room')).data;
    assert.deepStrictEqual(api.room, { id: fr.id, url: fr.url, port: fr.port, as: 'Scratch Board' });
    // two bounties for one slot: when the first ends, the dispatcher hands the slot the second
    const first = board.create({ criteria: CRIT, title: 'crashes', project: 'scratch', description: 'mode:crash', assignee_slot: 'fake-1', priority: 'high' });
    const second = board.create({ criteria: CRIT, title: 'Add mul() with a test', project: 'scratch', assignee_slot: 'fake-1' });
    board.ready(first.id); board.ready(second.id);
    await waitFor(() => fr.posts.length >= 2, 40000);
    await new Promise(r => setTimeout(r, 1500));
    assert.strictEqual(fr.posts.length, 2, 'one message per attempt: ' + JSON.stringify(fr.posts));
    assert.ok(fr.posts.every(p => p.as === 'Scratch Board'));
    assert.strictEqual(fr.posts[0].text, `@Conductor Alpha (fake-1) finished #${first.id} crashes: failed (never ran bounty start).`);
    assert.strictEqual(fr.posts[1].text, `@Conductor Alpha (fake-1) finished #${second.id} Add mul() with a test: submitted. Alpha is idle: what's next?`);
    // a room that answers 500 does not hold the board up: the next bounty still dispatches and finishes
    fr.members.clear();
    const fail = await fakeRoom({ id: fr.id, fail: 500 });
    board.room.room = room.normalize(fail.id, fail.url);
    try {
      const third = board.create({ criteria: CRIT, title: 'no submit', project: 'scratch', description: 'mode:no-submit', assignee_slot: 'fake-1' });
      board.ready(third.id);
      await waitFor(() => board.raw(third.id).status === 'blocked', 30000);
      await waitFor(() => fail.requests.some(r => r.path.endsWith('/post')), 10000);
      assert.strictEqual(fail.posts.length, 0);
      assert.strictEqual((await call('GET', '/state')).status, 200, 'the board still answers');
    } finally { await fail.close(); }
  } finally { await t.s.close(); await fr.close(); }
});

test('board: a verify that fails while the worker waits is reported as verify failed', async () => {
  const fr = await fakeRoom({ joined: ['Scratch'] });
  const t = await startBoard('room-vf', { verify: 'fail', over: { orchestrator: 'Conductor', room: { id: fr.id, url: fr.url } } });
  try {
    const b = t.board.create({ criteria: CRIT, title: 'Add mul() with a test', project: 'scratch', assignee_slot: 'fake-2' });
    t.board.ready(b.id);
    await waitFor(() => fr.posts.length >= 1, 40000);
    assert.match(fr.posts[0].text, new RegExp(`^@Conductor Bravo \\(fake-2\\) finished #${b.id} Add mul\\(\\) with a test: verify failed\\.`));
  } finally { await t.s.close(); await fr.close(); }
});

test('board: no room configured, no Chat tab and no post', async () => {
  const fr = await fakeRoom({ joined: ['Scratch'] });
  const t = await startBoard('room-none', { over: { orchestrator: 'Conductor' } });
  try {
    assert.deepStrictEqual((await t.call('GET', '/room')).data, { room: null });
    assert.strictEqual(t.board.room.enabled, false);
    const b = t.board.create({ criteria: CRIT, title: 'crashes', project: 'scratch', description: 'mode:crash', assignee_slot: 'fake-1' });
    t.board.ready(b.id);
    await waitFor(() => t.board.raw(b.id).status === 'blocked', 20000);
    assert.strictEqual(fr.requests.length, 0);
    const page = await fetch(t.url + '/chat');
    assert.strictEqual(page.status, 200);
    assert.match(await page.text(), /id="ch-frame"/);
  } finally { await t.s.close(); await fr.close(); }
});

// Regression (b8 review): "what's next" must follow the tick's real plan. Slots dispatch in board.json
// order up to the cap, so an earlier idle slot can take the last free place or the same unassigned
// bounty, and the slot that just finished stays idle.
test('idle tail follows the tick plan: an earlier slot takes the cap or the shared bounty', () => {
  const { Dispatcher } = require('../lib/dispatcher');
  const slots = [{ id: 'early', name: 'Early', autopilot: true }, { id: 'late', name: 'Late', autopilot: true }];
  const make = ({ cap, live = [], next }) => {
    const reports = [];
    const d = Object.create(Dispatcher.prototype);
    Object.assign(d, {
      stopped: false, live: new Map(live), spawning: new Set(), spawningBounties: new Set(),
      cfg: { slots, concurrency_cap: cap },
      board: {
        paused: () => false, nextFor: s => next[s.id] || null,
        slot: id => slots.find(s => s.id === id), raw: id => ({ id, title: 'Add mul()', status: 'in_progress', ci_status: 'running' }),
        room: { enabled: true, report: r => { reports.push(r); return r; } },
      },
    });
    return { d, reports };
  };
  const X = { id: 7, title: 'x' }, Y = { id: 8, title: 'y' };
  // one free place under the cap: the earlier slot takes it, the finishing one is idle
  let { d, reports } = make({ cap: 2, live: [[99, { slot: 'other', pid: 1 }]], next: { early: X, late: Y } });
  assert.deepStrictEqual(d.plan().map(p => [p.slot.id, p.bounty.id]), [['early', 7]]);
  assert.strictEqual(d.willDispatch(slots[1]), false);
  d.reportToRoom(5, 'late');
  assert.strictEqual(reports[0].idle, true);
  assert.match(room.reportText({ orchestrator: 'Conductor', ...reports[0] }), /Late is idle: what's next\?$/);
  // both see the same unassigned bounty: the earlier slot gets it, the later one is idle
  ({ d, reports } = make({ cap: 4, next: { early: X, late: X } }));
  assert.deepStrictEqual(d.plan().map(p => p.slot.id), ['early']);
  d.reportToRoom(5, 'late');
  assert.strictEqual(reports[0].idle, true);
  // room under the cap and a bounty of its own: the finishing slot gets the next one, no "what's next"
  ({ d, reports } = make({ cap: 2, next: { early: X, late: Y } }));
  assert.deepStrictEqual(d.plan().map(p => p.slot.id), ['early', 'late']);
  d.reportToRoom(5, 'late');
  assert.strictEqual(reports[0].idle, false);
  assert.doesNotMatch(room.reportText({ orchestrator: 'Conductor', ...reports[0] }), /what's next/);
});
