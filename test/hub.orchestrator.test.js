// The hub and orchestrator presence (bounty #7): every card and project tab shows the orchestrator
// with a green (online) or grey (offline) dot and "since", or says none was ever registered;
// require_orchestrator shows it in red; Start orchestrator runs spawn_orchestrator (argv, no shell,
// detached) and is hidden when not configured; a reply while the orchestrator is offline is saved and
// the page says nobody reads it live yet. API tests plus a headless Chromium check of the page.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpdir, waitFor } = require('./helpers');
const { procStat } = require('../lib/proc');
const { busyBoard, quietBoard, fakeBoard, deadPort, registerFake, startHub, presence, hoursAgo } = require('./hub-fixtures');

const CHROMIUM = process.env.CHROMIUM || '/usr/bin/chromium';
let chromium = null;
try { ({ chromium } = require('playwright-core')); } catch {}
const skipUi = !chromium ? 'playwright-core is not installed' : !fs.existsSync(CHROMIUM) ? `no chromium at ${CHROMIUM}` : false;
const SHOTS = process.env.HUB_SHOTS_DIR;

const hubPost = (url, p, body, headers = { 'x-hub-request': '1', 'content-type': 'application/json' }) =>
  fetch(url + p, { method: 'POST', headers, body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json() }));

// The spawn hook: writes its argv to $1 and exits (detached, so the test waits for the file).
function hookScript(dir) {
  const f = path.join(dir, 'spawn.js');
  fs.writeFileSync(f, "const [out, ...rest] = process.argv.slice(2); require('fs').writeFileSync(out, JSON.stringify(rest));\n");
  return f;
}

// Four boards: online orchestrator, offline one (required: red), none ever registered, and a stopped
// board whose registry entry holds this test process as a live orchestrator.
async function boards(dir) {
  const on = busyBoard('Rocket Garden');
  on.state.orchestrator = presence({ name: 'Conductor', since: hoursAgo(2) });
  const off = quietBoard('Archive Cleanup');
  off.state.orchestrator = presence({ name: 'Keeper', expected_name: 'Keeper', online: false, pid: 4343, since: hoursAgo(3), last_seen: hoursAgo(3), required: true, pending: 1,
    warning: "orchestrator 'Keeper' is offline (pid 4343 gone) and 1 bounty is ready, in progress or blocked" });
  const none = quietBoard('Fresh Board');
  none.state.orchestrator = presence({ name: null, expected_name: 'Pilot', online: false, pid: null, since: null, last_seen: null, start_time: null, registered: false, pending: 1 });
  const a = await fakeBoard(on), b = await fakeBoard(off), c = await fakeBoard(none);
  const gone = await deadPort();
  registerFake(dir, a.port, { name: 'Rocket Garden', default_project: 'rocket', board_dir: '/boards/rocket' });
  registerFake(dir, b.port, { name: 'Archive Cleanup', default_project: 'archive', board_dir: '/boards/archive' });
  registerFake(dir, c.port, { name: 'Fresh Board', default_project: 'fresh' });
  registerFake(dir, gone, { name: 'Gone Board', stopped_at: new Date().toISOString(),
    presence: presence({ name: 'Ghost', pid: process.pid, start_time: procStat(process.pid).start_time, online: true }) });
  return { a, b, c, gone, close: () => Promise.all([a.close(), b.close(), c.close()]) };
}

test('GET /api/hub: each board carries its orchestrator presence; a stopped board falls back to its registry entry, re-checked from the pid', async () => {
  const dir = path.join(tmpdir('huborch'), 'boards');
  const f = await boards(dir);
  const hub = await startHub(dir);
  try {
    const d = await (await fetch(hub.url + '/api/hub')).json();
    const by = Object.fromEntries(d.boards.map(b => [b.name, b.orchestrator]));
    assert.deepStrictEqual([by['Rocket Garden'].name, by['Rocket Garden'].online, by['Rocket Garden'].alarm], ['Conductor', true, false]);
    assert.deepStrictEqual([by['Archive Cleanup'].name, by['Archive Cleanup'].online, by['Archive Cleanup'].alarm], ['Keeper', false, true]);
    assert.deepStrictEqual([by['Fresh Board'].registered, by['Fresh Board'].expected_name, by['Fresh Board'].alarm], [false, 'Pilot', false]);
    assert.deepStrictEqual([by['Gone Board'].name, by['Gone Board'].online], ['Ghost', true], 'registry presence, pid + start time match');
    assert.strictEqual(d.spawn_orchestrator, false, 'no spawn hook configured');
    // A wrong start time in the registry: offline.
    registerFake(dir, f.gone, { name: 'Gone Board', stopped_at: new Date().toISOString(),
      presence: presence({ name: 'Ghost', pid: process.pid, start_time: procStat(process.pid).start_time + 5, online: true, last_seen: hoursAgo(1) }) });
    const d2 = await (await fetch(hub.url + '/api/hub')).json();
    const g = d2.boards.find(b => b.name === 'Gone Board').orchestrator;
    assert.deepStrictEqual([g.online, g.since], [false, g.last_seen]);
    // hub.json require_orchestrator: every board with work and no live orchestrator is red.
    await hub.close();
    const hub2 = await startHub(dir, { require_orchestrator: true });
    const d3 = await (await fetch(hub2.url + '/api/hub')).json();
    assert.strictEqual(d3.boards.find(b => b.name === 'Fresh Board').orchestrator.alarm, true);
    await hub2.close();
  } finally { await hub.close().catch(() => {}); await f.close(); }
});

test('POST /api/orchestrator/start: spawn_orchestrator argv with every placeholder, no shell, detached; 403/404/409', async () => {
  const tmp = tmpdir('hubspawn');
  const dir = path.join(tmp, 'boards');
  const out = path.join(tmp, 'argv.json');
  const hook = hookScript(tmp);
  const f = await boards(dir);
  let hub = await startHub(dir);
  try {
    // Not configured: 404, and the page is told to hide the button.
    assert.strictEqual((await hubPost(hub.url, '/api/orchestrator/start', { port: f.b.port })).status, 404);
    await hub.close();
    hub = await startHub(dir, { spawn_orchestrator: [process.execPath, hook, out, '{board}', '{project}', '{port}', '{name}', '{board_dir}', 'n={name};p={port}', "it's $(id) {nope}"] });
    assert.strictEqual((await (await fetch(hub.url + '/api/hub')).json()).spawn_orchestrator, true);
    assert.strictEqual((await hubPost(hub.url, '/api/orchestrator/start', { port: f.b.port }, { 'content-type': 'application/json' })).status, 403, 'needs X-Hub-Request');
    assert.strictEqual((await hubPost(hub.url, '/api/orchestrator/start', { port: 1 })).status, 404, 'only registered boards');
    assert.strictEqual((await hubPost(hub.url, '/api/orchestrator/start', { port: 'x' })).status, 400);
    const busy = await hubPost(hub.url, '/api/orchestrator/start', { port: f.a.port });
    assert.strictEqual(busy.status, 409, 'Conductor is online');
    assert.ok(!fs.existsSync(out));

    const r = await hubPost(hub.url, '/api/orchestrator/start', { port: f.b.port });
    assert.strictEqual(r.status, 202, JSON.stringify(r.body));
    assert.ok(r.body.started && r.body.pid > 0);
    await waitFor(() => fs.existsSync(out), 5000);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(out, 'utf8')),
      ['Archive Cleanup', 'archive', String(f.b.port), 'Keeper', '/boards/archive', `n=Keeper;p=${f.b.port}`, "it's $(id) {nope}"],
      'each placeholder filled, nothing interpreted by a shell');
    // None ever registered: {name} is the expected name.
    fs.rmSync(out);
    assert.strictEqual((await hubPost(hub.url, '/api/orchestrator/start', { port: f.c.port })).status, 202);
    await waitFor(() => fs.existsSync(out), 5000);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(out, 'utf8')).slice(3, 5), ['Pilot', '']);
    // A missing program is an error, not a crash.
    await hub.close();
    hub = await startHub(dir, { spawn_orchestrator: [path.join(tmp, 'no-such-program')] });
    const bad = await hubPost(hub.url, '/api/orchestrator/start', { port: f.b.port });
    assert.strictEqual(bad.status, 500);
    assert.match(bad.body.error, /not found/);
  } finally { await hub.close(); await f.close(); }
});

test('POST /api/reply while the orchestrator is offline: saved, and the answer says nobody reads it live', async () => {
  const dir = path.join(tmpdir('hubreplyoff'), 'boards');
  const f = await boards(dir);
  const hub = await startHub(dir);
  try {
    f.b.fixture.bounties[1].blocked_reason = 'Waiting on a human: which label printer?';
    let r = await hubPost(hub.url, '/api/reply', { port: f.b.port, bounty_id: 2, text: 'the blue one' });
    assert.strictEqual(r.status, 201);
    assert.deepStrictEqual([r.body.saved, r.body.orchestrator.online, r.body.orchestrator.name], [true, false, 'Keeper']);
    assert.strictEqual(f.b.fixture.received.length, 1, 'stored on the board');
    r = await hubPost(hub.url, '/api/reply', { port: f.a.port, bounty_id: 4, text: 'plugged in' });
    assert.deepStrictEqual([r.body.saved, r.body.orchestrator.online], [true, true]);
  } finally { await hub.close(); await f.close(); }
});

test('hub page: orchestrator dot, since, none registered, red when required, Start orchestrator, reply while offline (headless)', { skip: skipUi, timeout: 90000 }, async () => {
  const tmp = tmpdir('huborchui');
  const dir = path.join(tmp, 'boards');
  const out = path.join(tmp, 'argv.json');
  const f = await boards(dir);
  f.b.fixture.bounties[1].blocked_reason = 'Waiting on a human: which label printer?';
  let hub = await startHub(dir, { spawn_orchestrator: [process.execPath, hookScript(tmp), out, '{board}', '{name}'] });
  const browser = await chromium.launch({ executablePath: CHROMIUM, headless: true, args: ['--no-sandbox'] });
  const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name), fullPage: true }); } };
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    if (!SHOTS) await ctx.route(url => !url.href.startsWith(hub.url), r => r.abort());
    const page = await ctx.newPage();
    await page.goto(hub.url + '/');
    await page.waitForSelector('#hub-cards .hub-card .hub-orch');
    const cards = await page.$$eval('#hub-cards .hub-card', els => els.map(e => {
      const o = e.querySelector('.hub-orch');
      const dot = o.querySelector('.hub-orch-dot');
      return { name: e.querySelector('.hub-card-name').textContent, text: o.textContent.replace(/\s+/g, ' ').trim(),
        dot: dot.className, dotColor: getComputedStyle(dot).backgroundColor, color: getComputedStyle(o.querySelector('.hub-orch-name')).color,
        start: !!o.querySelector('.hub-start-orch'), alarm: o.classList.contains('hub-orch-alarm') };
    }));
    const by = Object.fromEntries(cards.map(c => [c.name, c]));
    assert.match(by['Rocket Garden'].text, /^Orchestrator: Conductor online since 2 h ago$/);
    assert.strictEqual(by['Rocket Garden'].dotColor, 'rgb(158, 206, 106)', 'green dot');
    assert.strictEqual(by['Rocket Garden'].start, false, 'no Start button while online');
    assert.match(by['Fresh Board'].text, /No orchestrator ever registered \(expected Pilot\)/);
    assert.strictEqual(by['Fresh Board'].dotColor, 'rgb(86, 95, 137)', 'grey dot');
    assert.strictEqual(by['Fresh Board'].start, true);
    assert.match(by['Archive Cleanup'].text, /Keeper offline since 3 h ago Start orchestrator ?orchestrator 'Keeper' is offline/);
    assert.ok(by['Archive Cleanup'].alarm, 'required + work waiting: red');
    assert.strictEqual(by['Archive Cleanup'].dotColor, 'rgb(247, 118, 142)');
    assert.strictEqual(by['Archive Cleanup'].color, 'rgb(247, 118, 142)');
    assert.match(by['Gone Board'].text, /Ghost online/, 'stopped board: the registry presence');
    await shot(page, 'hub-orchestrator-cards.png');

    // The project tab shows the same line.
    await page.click('#tab-p' + f.a.port);
    assert.match(await page.locator(`#panel-p${f.a.port} .hub-board-head .hub-orch`).textContent(), /Conductor\s+online since 2 h ago/);
    await page.click('#tab-p' + f.b.port);
    const panelOrch = page.locator(`#panel-p${f.b.port} .hub-board-head .hub-orch`);
    assert.match(await panelOrch.textContent(), /Keeper\s+offline since 3 h ago/);
    await shot(page, 'hub-orchestrator-tab-offline.png');

    // Start orchestrator: runs the hook with the board's values, stays on the tab, says what happened.
    await panelOrch.locator('.hub-start-orch').click();
    await page.waitForSelector(`#panel-p${f.b.port} .hub-orch-msg`);
    assert.match(await page.locator(`#panel-p${f.b.port} .hub-orch-msg`).textContent(), /Started \(pid \d+\)\. It shows online once it registers itself\./);
    await waitFor(() => fs.existsSync(out), 5000);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(out, 'utf8')), ['Archive Cleanup', 'Keeper']);
    assert.match(page.url(), new RegExp(`#p${f.b.port}$`));

    // A reply while Keeper is offline: saved, and the page says nobody is reading it live yet.
    const wrap = page.locator(`#panel-p${f.b.port} .hub-reply-wrap[data-k="${f.b.port}-2"]`);
    await wrap.locator('.hub-reply-text').fill('the blue one');
    await wrap.locator('[data-act=send]').click();
    await page.waitForSelector(`#panel-p${f.b.port} .hub-nobody`);
    assert.strictEqual(await page.locator(`#panel-p${f.b.port} .hub-nobody`).textContent(), 'Saved on the board. Keeper is offline, so nobody is reading it live yet.');
    assert.strictEqual(f.b.fixture.received.length, 1);
    await shot(page, 'hub-orchestrator-reply-offline.png');
    await ctx.close();

    // No spawn_orchestrator: no Start button anywhere.
    await hub.close();
    hub = await startHub(dir);
    const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 } });
    if (!SHOTS) await ctx2.route(url => !url.href.startsWith(hub.url), r => r.abort());
    const p2 = await ctx2.newPage();
    await p2.goto(hub.url + '/');
    await p2.waitForSelector('#hub-cards .hub-card .hub-orch');
    assert.strictEqual(await p2.locator('.hub-start-orch').count(), 0);
    assert.ok(await p2.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scroll at 390 px');
    await shot(p2, 'hub-orchestrator-phone.png');
  } finally { await browser.close(); await hub.close(); await f.close(); }
});
