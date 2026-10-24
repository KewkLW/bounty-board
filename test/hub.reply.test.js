// POST /api/reply: the hub forwards a Needs you reply to a registered board's human-notes API and
// runs the on_reply hook (argv, no shell). Fake boards on ephemeral ports; the hook is a tiny node
// script that writes its argv to a file.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpdir } = require('./helpers');
const registry = require('../lib/registry');
const { loadHubConfig, fillArgv } = require('../hub/server');
const { busyBoard, quietBoard, fakeBoard, deadPort, registerFake, startHub } = require('./hub-fixtures');

const post = (url, body, headers = { 'x-hub-request': '1', 'content-type': 'application/json' }) =>
  fetch(url + '/api/reply', { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) })
    .then(async r => ({ status: r.status, body: await r.json() }));

// A hook script: writes JSON.stringify(process.argv.slice(2)) to $1, then exits with $2 (or sleeps).
function hookScript(dir) {
  const f = path.join(dir, 'hook.js');
  fs.writeFileSync(f, `const [out, mode, ...rest] = process.argv.slice(2);
require('fs').writeFileSync(out, JSON.stringify(rest));
if (mode === 'fail') { console.error('relay said no'); process.exit(3); }
if (mode === 'sleep') setTimeout(() => {}, 60000);\n`);
  return f;
}

test('hub config: human_name defaults to "human", on_reply off unless it is an argv array', () => {
  const dir = tmpdir('hubcfg');
  const f = path.join(dir, 'hub.json');
  fs.writeFileSync(f, '{}');
  let c = loadHubConfig(f);
  assert.deepStrictEqual([c.human_name, c.on_reply], ['human', null]);
  fs.writeFileSync(f, JSON.stringify({ human_name: ' Robin ', on_reply: 'notify-send {text}' }));
  c = loadHubConfig(f);
  assert.deepStrictEqual([c.human_name, c.on_reply], ['Robin', null], 'a shell string is not accepted');
  fs.writeFileSync(f, JSON.stringify({ on_reply: ['relay', '--to', '{orchestrator}', '{text}'] }));
  assert.deepStrictEqual(loadHubConfig(f).on_reply, ['relay', '--to', '{orchestrator}', '{text}']);
  assert.deepStrictEqual(fillArgv(['x', '{text}', 'id={id}', '{nope}'], { text: 'see {id} $(id)', id: 4 }), ['x', 'see {id} $(id)', 'id=4', '{nope}'],
    'one pass: placeholders inside the text stay literal; unknown braces stay as they are');
});

test('registry entry carries board.json "orchestrator"', () => {
  assert.strictEqual(registry.entryFor({ default_project: 'a', orchestrator: ' Conductor ' }, 4201).orchestrator, 'Conductor');
  assert.strictEqual(registry.entryFor({ default_project: 'a' }, 4202).orchestrator, null);
});

test('POST /api/reply: headers, unknown port, forwarding, 409, board down, no hook', async () => {
  const dir = path.join(tmpdir('hubreply'), 'boards');
  const busy = await fakeBoard(busyBoard());
  const gone = await deadPort();
  registerFake(dir, busy.port, { name: 'Rocket Garden', default_project: 'rocket' });
  registerFake(dir, gone, { name: 'Gone Board' });
  const hub = await startHub(dir, { human_name: 'Robin', on_reply: null });
  try {
    // 403 without the header or without a JSON body; nothing reaches the board.
    for (const h of [{ 'content-type': 'application/json' }, { 'x-hub-request': '1', 'content-type': 'text/plain' }, { 'x-hub-request': '0', 'content-type': 'application/json' }, { 'x-hub-request': '1' }]) {
      const r = await post(hub.url, { port: busy.port, bounty_id: 4, text: 'hi' }, h);
      assert.strictEqual(r.status, 403, JSON.stringify(h));
    }
    assert.strictEqual((busy.fixture.received || []).length, 0);
    assert.strictEqual((await post(hub.url, '{ nope')).status, 400, 'bad JSON');
    assert.strictEqual((await post(hub.url, { port: busy.port, bounty_id: 'x', text: 'hi' })).status, 400);
    assert.strictEqual((await post(hub.url, { port: busy.port, bounty_id: 4, text: '   ' })).status, 400, 'empty text without unblock');

    // Only registered boards: any other port is refused before anything is sent.
    const u = await post(hub.url, { port: hub.port, bounty_id: 4, text: 'hi' });
    assert.strictEqual(u.status, 404);
    assert.match(u.body.error, /no board is registered/);

    // Forwarded with X-Board-Request and the hub's human_name; the board's answer comes back.
    let r = await post(hub.url, { port: busy.port, bounty_id: 4, text: '  plugged in  ', unblock: false });
    assert.strictEqual(r.status, 201);
    assert.deepStrictEqual([r.body.saved, r.body.delivered, r.body.note.text, r.body.bounty], [true, null, 'plugged in', { id: 4, status: 'blocked' }], 'no hook: save only');
    let got = busy.fixture.received.at(-1);
    assert.strictEqual(got.headers['x-board-request'], '1');
    assert.deepStrictEqual([got.id, got.body], [4, { text: 'plugged in', from: 'Robin', unblock: false }]);

    // Done with an empty box sends "Done" with unblock; the item leaves Needs you.
    r = await post(hub.url, { port: busy.port, bounty_id: 4, text: '', unblock: true });
    assert.strictEqual(r.status, 201);
    assert.deepStrictEqual(busy.fixture.received.at(-1).body, { text: 'Done', from: 'Robin', unblock: true });
    assert.deepStrictEqual(r.body.bounty, { id: 4, status: 'ready' });
    const hubData = await (await fetch(hub.url + '/api/hub')).json();
    assert.deepStrictEqual(hubData.needs_you, [], 'gone from Needs you on the next refresh');

    // The board's errors pass through: 409 (not blocked, note still stored), 404 unknown bounty.
    r = await post(hub.url, { port: busy.port, bounty_id: 4, text: 'again', unblock: true });
    assert.deepStrictEqual([r.status, r.body.saved, !!r.body.note], [409, true, true]);
    r = await post(hub.url, { port: busy.port, bounty_id: 99, text: 'who?' });
    assert.deepStrictEqual([r.status, r.body.saved], [404, false]);

    // A registered board that does not answer: 502, nothing saved.
    r = await post(hub.url, { port: gone, bounty_id: 1, text: 'hello?' });
    assert.deepStrictEqual([r.status, r.body.saved], [502, false]);
    assert.match(r.body.error, /Gone Board did not answer/);
  } finally { await hub.close(); await busy.close(); }
});

test('POST /api/reply: on_reply argv with every placeholder, no shell; failure and timeout never fail the reply', async () => {
  const tmp = tmpdir('hubhook');
  const dir = path.join(tmp, 'boards');
  const hook = hookScript(tmp);
  const out = path.join(tmp, 'argv.json');
  const busy = await fakeBoard(busyBoard());
  const quiet = await fakeBoard(quietBoard());
  registerFake(dir, busy.port, { name: 'Rocket Garden', default_project: 'garden', orchestrator: 'Conductor' });
  registerFake(dir, quiet.port, { name: 'Archive Cleanup', default_project: 'archive' });
  const argv = mode => [process.execPath, hook, out, mode, '{board}', '{project}', '{port}', '{id}', '{title}', '{text}', '{unblock}', '{orchestrator}', 'b={board};id={id}'];
  let hub = await startHub(dir, { on_reply: argv('ok'), hook_timeout_ms: 800 });
  try {
    const nasty = `it's "done"; rm -rf $HOME $(id) \`x\` {id} | cat`;
    let r = await post(hub.url, { port: busy.port, bounty_id: 4, text: nasty, unblock: true });
    assert.strictEqual(r.status, 201);
    assert.deepStrictEqual([r.body.saved, r.body.delivered], [true, true]);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(out, 'utf8')),
      ['Rocket Garden', 'rocket', String(busy.port), '4', 'G2.2 Soil sensor', nasty, 'true', 'Conductor', 'b=Rocket Garden;id=4'],
      'each placeholder filled; the text arrives as one verbatim argument; {project} is the bounty\'s project');

    // No orchestrator in the registry entry: {orchestrator} is empty; {project} falls back to the board's default.
    quiet.fixture.bounties[1].project_id = undefined;
    fs.rmSync(out);
    r = await post(hub.url, { port: quiet.port, bounty_id: 2, text: 'the blue one' });
    assert.strictEqual(r.body.delivered, true);
    const a = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.deepStrictEqual([a[1], a[6], a[7]], ['archive', 'false', '']);

    // A failed board write runs no hook.
    fs.rmSync(out);
    r = await post(hub.url, { port: busy.port, bounty_id: 99, text: 'nobody' });
    assert.strictEqual(r.status, 404);
    assert.ok(!fs.existsSync(out), 'hook not run when the board did not store the note');
    await hub.close();

    // The hook fails: the reply still succeeds, saved but not delivered, with the reason.
    hub = await startHub(dir, { on_reply: argv('fail'), hook_timeout_ms: 800 });
    r = await post(hub.url, { port: quiet.port, bounty_id: 2, text: 'still here' });
    assert.deepStrictEqual([r.status, r.body.saved, r.body.delivered], [201, true, false]);
    assert.match(r.body.delivery_error, /exit code 3: relay said no/);
    await hub.close();

    // The hook hangs: killed at hook_timeout_ms, the reply still succeeds.
    hub = await startHub(dir, { on_reply: argv('sleep'), hook_timeout_ms: 500 });
    const t0 = Date.now();
    r = await post(hub.url, { port: quiet.port, bounty_id: 2, text: 'slow relay' });
    assert.deepStrictEqual([r.status, r.body.saved, r.body.delivered], [201, true, false]);
    assert.match(r.body.delivery_error, /timed out after 500 ms/);
    assert.ok(Date.now() - t0 < 5000);
    await hub.close();

    // A hook binary that does not exist.
    hub = await startHub(dir, { on_reply: [path.join(tmp, 'no-such-relay'), '{text}'] });
    r = await post(hub.url, { port: quiet.port, bounty_id: 2, text: 'anyone?' });
    assert.deepStrictEqual([r.status, r.body.saved, r.body.delivered], [201, true, false]);
    assert.match(r.body.delivery_error, /not found/);
    assert.strictEqual(quiet.fixture.received.length, 4, 'every reply was stored on the board');
  } finally { await hub.close(); await busy.close(); await quiet.close(); }
});
