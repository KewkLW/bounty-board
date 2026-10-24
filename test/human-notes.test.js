// Notes from the human: POST /api/bounties/:id/human-notes, GET /api/human-notes,
// POST /api/human-notes/read, the worker inbox/prompt and `bounty replies`.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { execFile } = require('child_process');
const { startBoard, ROOT } = require('./helpers');
const { workerPrompt } = require('../lib/prompt');

const CRIT = ['math.js exports mul(a, b) returning the product'];

function cli(url, args, env = {}) {
  return new Promise(resolve => execFile(process.execPath, [path.join(ROOT, 'bin', 'bounty'), ...args], {
    encoding: 'utf8', env: { ...process.env, BOUNTY_SLOT: '', BOUNTY_ID: '', BOUNTY_ACTOR: '', BOUNTY_URL: url, ...env },
  }, (err, out, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, out, err: stderr })));
}

// A request the way the hub sends it: JSON plus X-Board-Request: 1.
async function hcall(url, method, p, body, headers = {}) {
  const r = await fetch(url + '/api' + p, {
    method, headers: { 'content-type': 'application/json', 'x-board-request': '1', ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data, headers: r.headers };
}

test('human-notes API: header check, 400/404/409, unblock, list and read marks', async () => {
  const t = await startBoard('human-api', { dispatch: false });
  try {
    const { board, url, call } = t;
    const b = board.create({ title: 'needs a decision', project: 'scratch', criteria: CRIT });
    const p = `/bounties/${b.id}/human-notes`;

    // 403: no X-Board-Request header (the helper's call() sends JSON but not the header)
    let r = await call('POST', p, { text: 'hi' });
    assert.strictEqual(r.status, 403);
    assert.match(r.data.error, /X-Board-Request/);
    // 403: the header but a form/text body (what a cross-origin page can send without preflight)
    r = await hcall(url, 'POST', p, 'text=hi', { 'content-type': 'text/plain' });
    assert.strictEqual(r.status, 403);
    r = await hcall(url, 'POST', p, 'text=hi', { 'content-type': 'application/x-www-form-urlencoded' });
    assert.strictEqual(r.status, 403);
    // 403: wrong header value
    r = await hcall(url, 'POST', p, { text: 'hi' }, { 'x-board-request': 'yes' });
    assert.strictEqual(r.status, 403);
    // 403: a worker slot can't pose as the human
    r = await hcall(url, 'POST', p, { text: 'hi' }, { 'x-bounty-actor': 'fake-1' });
    assert.strictEqual(r.status, 403);
    // the board allows no CORS preflight
    const pre = await fetch(url + '/api' + p, { method: 'OPTIONS', headers: { origin: 'http://evil.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,x-board-request' } });
    assert.strictEqual(pre.headers.get('access-control-allow-origin'), null);
    assert.strictEqual(pre.headers.get('access-control-allow-headers'), null);
    assert.strictEqual(board.humanNotes().length, 0, 'nothing stored by refused requests');

    // 404 unknown bounty; 400 empty / whitespace / missing / too long text
    assert.strictEqual((await hcall(url, 'POST', '/bounties/9999/human-notes', { text: 'x' })).status, 404);
    assert.strictEqual((await hcall(url, 'POST', p, { text: '' })).status, 400);
    assert.strictEqual((await hcall(url, 'POST', p, { text: '   ' })).status, 400);
    assert.strictEqual((await hcall(url, 'POST', p, {})).status, 400);
    assert.strictEqual((await hcall(url, 'POST', p, { text: 42 })).status, 400);
    assert.strictEqual((await hcall(url, 'POST', p, { text: 'x'.repeat(4001) })).status, 400);
    assert.strictEqual((await hcall(url, 'POST', p, { text: 'y'.repeat(4000) })).status, 200, '4000 chars is allowed');

    // 200: stored as kind human, actor human:<from>; default from is "human"
    r = await hcall(url, 'POST', p, { text: 'use the blue one', from: 'kewk' });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.data.bounty, { id: b.id, status: 'backlog' });
    assert.strictEqual(r.data.note.text, 'use the blue one');
    assert.strictEqual(r.data.note.from, 'kewk');
    assert.strictEqual(r.data.note.read, false);
    const ev = board.get(b.id).events.find(e => e.id === r.data.note.id);
    assert.strictEqual(ev.kind, 'human');
    assert.strictEqual(ev.actor, 'human:kewk');
    r = await hcall(url, 'POST', p, { text: 'anonymous' });
    assert.strictEqual(r.data.note.from, 'human');
    assert.strictEqual(board.get(b.id).events.find(e => e.id === r.data.note.id).actor, 'human:human');

    // 409: unblock asked but the bounty isn't blocked; the note is still stored and the response says so
    r = await hcall(url, 'POST', p, { text: 'go ahead', from: 'kewk', unblock: true });
    assert.strictEqual(r.status, 409);
    assert.match(r.data.error, /not blocked; the note is stored/);
    assert.strictEqual(r.data.note_stored, true);
    assert.strictEqual(r.data.note.text, 'go ahead');
    assert.deepStrictEqual(r.data.bounty, { id: b.id, status: 'backlog' });
    assert.ok(board.get(b.id).events.some(e => e.kind === 'human' && e.note === 'go ahead'));

    // unblock: blocked -> ready, the status event records the human
    board.ready(b.id);
    board.start(b.id, 'fake-1');
    board.block(b.id, 'which colour?', 'fake-1');
    r = await hcall(url, 'POST', p, { text: 'blue. carry on', from: 'kewk', unblock: true });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.data.bounty, { id: b.id, status: 'ready' });
    assert.strictEqual(r.data.unblocked, true);
    const cur = board.get(b.id);
    assert.strictEqual(cur.status, 'ready');
    assert.strictEqual(cur.blocked_reason, null);
    const st = cur.events.filter(e => e.kind === 'status').pop();
    assert.strictEqual(st.from_status, 'blocked');
    assert.strictEqual(st.to_status, 'ready');
    assert.strictEqual(st.actor, 'human:kewk');
    assert.match(st.note, /unblocked by the human \(kewk\)/);
    // unblock: false on a non-blocked bounty is just a note
    assert.strictEqual((await hcall(url, 'POST', p, { text: 'fyi', unblock: false })).status, 200);

    // GET /human-notes: newest first, with bounty id, title, project, text, from, created_at, read
    const other = board.create({ title: 'second', project: 'scratch', criteria: CRIT });
    await hcall(url, 'POST', `/bounties/${other.id}/human-notes`, { text: 'newest', from: 'kewk' });
    r = await call('GET', '/human-notes?unread=1');
    assert.strictEqual(r.status, 200);
    const all = r.data;
    assert.strictEqual(all[0].text, 'newest');
    assert.strictEqual(all[0].bounty_id, other.id);
    assert.strictEqual(all[0].title, 'second');
    assert.strictEqual(all[0].project, 'scratch');
    assert.strictEqual(all[0].from, 'kewk');
    assert.ok(all[0].created_at);
    assert.strictEqual(all[0].read, false);
    for (let i = 1; i < all.length; i++) assert.ok(all[i - 1].id > all[i].id, 'newest first');
    const n = all.length;
    assert.strictEqual(n, 7);

    // POST /human-notes/read: needs the header; marks only what it's given
    assert.strictEqual((await call('POST', '/human-notes/read', { ids: [all[0].id] })).status, 403);
    assert.strictEqual((await hcall(url, 'POST', '/human-notes/read', { ids: 'x' })).status, 400);
    r = await hcall(url, 'POST', '/human-notes/read', { ids: [all[0].id, all[1].id] });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.marked, 2);
    assert.strictEqual((await call('GET', '/human-notes?unread=1')).data.length, n - 2);
    const listed = (await call('GET', '/human-notes')).data;
    assert.strictEqual(listed.length, n);
    assert.strictEqual(listed.find(x => x.id === all[0].id).read, true);
    // marking again is a no-op
    assert.strictEqual((await hcall(url, 'POST', '/human-notes/read', { ids: [all[0].id] })).data.marked, 0);
  } finally { await t.s.close(); }
});

test('allow_cidrs applies to the human-notes endpoints', async () => {
  const t = await startBoard('human-cidr', { dispatch: false, over: { allow_cidrs: ['10.255.255.0/24'] } });
  try {
    const b = t.board.create({ title: 'x', project: 'scratch', criteria: CRIT });
    assert.strictEqual((await hcall(t.url, 'POST', `/bounties/${b.id}/human-notes`, { text: 'hi' })).status, 403);
    assert.strictEqual((await hcall(t.url, 'GET', '/human-notes')).status, 403);
    assert.strictEqual(t.board.humanNotes().length, 0);
  } finally { await t.s.close(); }
});

test('human notes reach workers: live inbox/progress and the prompt of a later worker; the orchestrator read mark is separate', async () => {
  const t = await startBoard('human-worker', { dispatch: false });
  try {
    const { board, url } = t;
    const b = board.create({ title: 'x', project: 'scratch', criteria: CRIT });
    board.ready(b.id);
    const w = { BOUNTY_ID: String(b.id), BOUNTY_SLOT: 'fake-1' };
    let r = await cli(url, ['start'], w);
    assert.strictEqual(r.code, 0, r.err);

    // a live worker sees it on its next inbox, under its own header
    await hcall(url, 'POST', `/bounties/${b.id}/human-notes`, { text: 'ship the small version first', from: 'kewk' });
    await cli(url, ['note', String(b.id), 'orchestrator says hi']);
    r = await cli(url, ['inbox'], w);
    assert.strictEqual(r.code, 0, r.err);
    assert.match(r.out, /NEW NOTE FROM THE ORCHESTRATOR[\s\S]*orchestrator says hi/);
    assert.match(r.out, /NEW MESSAGE FROM THE HUMAN[\s\S]*kewk\] ship the small version first/);
    assert.strictEqual(board.notes(b.id, { unread: true }).length, 0);
    // the worker reading it doesn't mark it read for the orchestrator
    assert.strictEqual(board.humanNotes({ unread: true }).length, 1);
    r = await cli(url, ['inbox'], w);
    assert.match(r.out, /no unread notes/);

    // and on its next progress
    await hcall(url, 'POST', `/bounties/${b.id}/human-notes`, { text: 'also add a test', from: 'kewk' });
    r = await cli(url, ['progress', 'did a thing'], w);
    assert.match(r.out, /progress noted[\s\S]*FROM THE HUMAN[\s\S]*also add a test/);
    assert.doesNotMatch(r.out, /FROM THE ORCHESTRATOR/);

    // peek shows it labelled
    await hcall(url, 'POST', `/bounties/${b.id}/human-notes`, { text: 'peeked', from: 'kewk' });
    r = await cli(url, ['inbox', String(b.id), '--peek']);
    assert.match(r.out, /FROM THE HUMAN kewk\] peeked/);

    // a worker spawned later gets every human note in its prompt, labelled, separate from orchestrator notes
    const prompt = workerPrompt(board, { ...board.need(b.id), attempts: 2 }, board.slot('fake-2'), { worktree: t.repo, branch: 'x' });
    assert.match(prompt, /## Orchestrator notes[^\n]*\n- [^\n]*orchestrator says hi/);
    assert.match(prompt, /## Messages from the human[^\n]*\n[\s\S]*\(from the human, kewk\): ship the small version first[\s\S]*also add a test[\s\S]*peeked/);
    const orchSection = prompt.split('## Orchestrator notes')[1].split('## Messages from the human')[0];
    assert.doesNotMatch(orchSection, /ship the small version/);
    // a bounty with no human notes has no human section
    const c = board.create({ title: 'y', project: 'scratch', criteria: CRIT });
    assert.doesNotMatch(workerPrompt(board, board.need(c.id), board.slot('fake-1'), { worktree: t.repo, branch: 'y' }), /## Messages from the human/);

    // bounty show and bounty log list them
    r = await cli(url, ['show', String(b.id)]);
    assert.match(r.out, /Messages from the human:[\s\S]*kewk \(unread by the orchestrator\): ship the small version first/);
    const logPath = path.join(t.dir, 'attempt.log');
    require('fs').writeFileSync(logPath, 'worker transcript line\n');
    board.db.prepare("INSERT INTO attempts (bounty_id, slot, kind, log_path, started_at) VALUES (?, 'fake-1', 'worker', ?, ?)").run(b.id, logPath, new Date().toISOString());
    r = await cli(url, ['log', String(b.id)]);
    assert.strictEqual(r.code, 0, r.err);
    assert.match(r.out, /messages from the human on #\d+[\s\S]*kewk\] also add a test[\s\S]*end of messages[\s\S]*worker transcript line/);
    r = await cli(url, ['log', String(b.id), '--raw']);
    assert.doesNotMatch(r.out, /messages from the human/);
  } finally { await t.s.close(); }
});

test('bounty replies: prints unread human notes and marks them read; --peek and --all; documented in help', async () => {
  const t = await startBoard('human-cli', { dispatch: false });
  try {
    const { board, url } = t;
    const a = board.create({ title: 'first bounty', project: 'scratch', criteria: CRIT });
    const b = board.create({ title: 'second bounty', project: 'scratch', criteria: CRIT });

    let r = await cli(url, ['replies']);
    assert.strictEqual(r.code, 0, r.err);
    assert.match(r.out, /no unread messages from the human/);

    await hcall(url, 'POST', `/bounties/${a.id}/human-notes`, { text: 'older reply', from: 'kewk' });
    await hcall(url, 'POST', `/bounties/${b.id}/human-notes`, { text: 'newer reply\nsecond line' });

    // --peek: printed, still unread
    r = await cli(url, ['replies', '--peek']);
    assert.strictEqual(r.code, 0, r.err);
    assert.match(r.out, /2 messages from the human \(unread\), newest first \(peek; nothing marked read\)/);
    assert.match(r.out, new RegExp(`#${b.id} scratch  \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d  from human  \\(new\\)  second bounty\\n    newer reply\\n    second line`));
    assert.match(r.out, new RegExp(`#${a.id} scratch  [^\\n]*from kewk[^\\n]*first bounty\\n    older reply`));
    assert.ok(r.out.indexOf('newer reply') < r.out.indexOf('older reply'), 'newest first');
    assert.strictEqual(board.humanNotes({ unread: true }).length, 2);

    // default: printed and marked read
    r = await cli(url, ['replies']);
    assert.match(r.out, /2 messages from the human \(unread\), newest first; 2 marked read/);
    assert.match(r.out, /older reply/);
    assert.strictEqual(board.humanNotes({ unread: true }).length, 0);
    r = await cli(url, ['replies']);
    assert.match(r.out, /no unread messages from the human/);

    // --all: read ones too (no "(new)" mark); a new unread one is shown as new and marked read
    await hcall(url, 'POST', `/bounties/${a.id}/human-notes`, { text: 'third', from: 'kewk' });
    r = await cli(url, ['replies', '--all', '--peek']);
    assert.match(r.out, /3 messages from the human, newest first \(peek/);
    assert.match(r.out, /\(new\)  first bounty\n    third/);
    assert.match(r.out, /from kewk  first bounty\n    older reply/);
    assert.strictEqual(board.humanNotes({ unread: true }).length, 1);
    r = await cli(url, ['replies', '--all']);
    assert.match(r.out, /3 messages from the human, newest first; 1 marked read/);
    assert.strictEqual(board.humanNotes({ unread: true }).length, 0);

    // --json
    r = await cli(url, ['replies', '--all', '--json']);
    const j = JSON.parse(r.out);
    assert.strictEqual(j.length, 3);
    assert.deepStrictEqual(Object.keys(j[0]).filter(k => ['bounty_id', 'title', 'project', 'text', 'from', 'created_at', 'read'].includes(k)).sort(),
      ['bounty_id', 'created_at', 'from', 'project', 'read', 'text', 'title']);

    // workers can't read the orchestrator's replies
    r = await cli(url, ['replies'], { BOUNTY_ID: String(a.id), BOUNTY_SLOT: 'fake-1' });
    assert.notStrictEqual(r.code, 0);

    // help documents it
    r = await cli(url, ['help']);
    assert.match(r.out, /bounty replies \[--all\] \[--peek\]/);
    assert.match(r.out, /--peek marks nothing read/);
  } finally { await t.s.close(); }
});
