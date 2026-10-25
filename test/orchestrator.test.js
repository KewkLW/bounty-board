// Orchestrator presence (lib/orchestrator.js) with real child processes: register, online from the
// pid, process exit -> offline, the pid reuse guard, replacement by a new orchestrator (the old one
// is not signalled), the API (/api/orchestrator, /api/state, /api/live), the registry entry, the CLI
// (status, register with the default pid) and the startup warning. Every child a test starts is
// killed by its own pid at the end.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { startBoard, waitFor, ROOT } = require('./helpers');
const { load } = require('../lib/config');
const { createServer } = require('../server');
const registry = require('../lib/registry');
const { procStat } = require('../lib/proc');

const CRIT = ['math.js exports mul(a, b) returning the product', 'a node:test covers mul'];
const alive = pid => !!procStat(pid);
const KEYS = ['name', 'expected_name', 'online', 'pid', 'since', 'last_seen'];

const mine = [];
function child(cmd = 'sleep 600') {
  const c = spawn('bash', ['-c', cmd], { detached: true, stdio: 'ignore' });
  mine.push(c.pid);
  return c;
}
function killMine() {
  while (mine.length) { const p = mine.pop(); try { process.kill(-p, 'SIGKILL'); } catch {} try { process.kill(p, 'SIGKILL'); } catch {} }
}
const exited = c => new Promise(r => (c.exitCode !== null || c.signalCode !== null ? r() : c.once('exit', r)));

function cli(url, args, env = {}) {
  return new Promise(resolve => execFile(process.execPath, [path.join(ROOT, 'bin', 'bounty'), ...args],
    { env: { ...process.env, BOUNTY_URL: url, BOUNTY_SLOT: '', BOUNTY_ID: '', AGENT_NAME: '', ...env } },
    (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr })));
}
const runDir = t => path.join(t.dir, 'run');
const manifest = t => JSON.parse(fs.readFileSync(path.join(runDir(t), 'agents.json'), 'utf8')).agents;
const regEntry = t => registry.list(t.cfg.registry_dir).find(e => e.port === t.cfg.port);
const boardNotes = t => t.board.db.prepare('SELECT note FROM events WHERE bounty_id IS NULL ORDER BY id').all().map(e => e.note).join('\n');

test('register, online from the pid; the same object in /api/orchestrator, /api/state, /api/live and the registry entry; exit -> offline at once', async () => {
  const t = await startBoard('orch-online', { dispatch: false, over: { orchestrator: 'Conductor' } });
  try {
    const { call } = t;
    // Nobody registered yet: says so, with the expected name from board.json.
    let o = (await call('GET', '/orchestrator')).data;
    assert.deepStrictEqual(KEYS.map(k => o[k]), [null, 'Conductor', false, null, null, null]);
    assert.strictEqual(o.registered, false);
    assert.match((await cli(t.url, ['orchestrator'])).stdout, /orchestrator: none registered \(expected 'Conductor'\)/);

    const c = child();
    const r = await cli(t.url, ['orchestrator', 'register', '--name', 'Conductor', '--pid', String(c.pid)]);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`registered orchestrator 'Conductor' pid ${c.pid}: online`));
    o = (await call('GET', '/orchestrator')).data;
    assert.deepStrictEqual([o.name, o.expected_name, o.online, o.pid, o.registered], ['Conductor', 'Conductor', true, c.pid, true]);
    assert.ok(Date.parse(o.since) <= Date.now() && Date.parse(o.last_seen) >= Date.parse(o.since));
    assert.strictEqual(o.start_time, procStat(c.pid).start_time);
    const e = manifest(t).find(x => x.pid === c.pid);
    assert.deepStrictEqual([e.kind, e.name], ['orchestrator', 'Conductor'], 'it is in the agent manifest too');

    // The same object everywhere (online, name, pid, since).
    const pick = x => ({ name: x.name, expected_name: x.expected_name, online: x.online, pid: x.pid, since: x.since });
    const state = (await call('GET', '/state')).data.orchestrator;
    const live = (await call('GET', '/live')).data.orchestrator;
    assert.deepStrictEqual(pick(state), pick(o));
    assert.deepStrictEqual(pick(live), pick(o));
    await waitFor(() => regEntry(t).presence && regEntry(t).presence.online === true, 5000);
    assert.deepStrictEqual(pick(regEntry(t).presence), pick(o), 'the board rewrote its hub registry entry');
    const text = await (await fetch(t.url + '/api/live?format=text')).text();
    assert.match(text, new RegExp(`orchestrator: Conductor ONLINE \\(pid ${c.pid}, since`));
    const st = await cli(t.url, ['orchestrator']);
    assert.match(st.stdout, new RegExp(`orchestrator: Conductor ONLINE \\(pid ${c.pid}, since \\d+s ago\\)`));
    assert.deepStrictEqual(pick(JSON.parse((await cli(t.url, ['orchestrator', '--json'])).stdout)), pick(o));
    assert.match((await cli(t.url, ['status'])).stdout, /orchestrator: Conductor ONLINE/);

    // The process exits: offline on the very next read, since = last seen; nothing else had to happen.
    process.kill(c.pid, 'SIGKILL');
    await exited(c);
    o = (await call('GET', '/orchestrator')).data;
    assert.deepStrictEqual([o.name, o.online, o.pid], ['Conductor', false, c.pid]);
    assert.strictEqual(o.since, o.last_seen);
    assert.ok(Date.parse(o.last_seen) <= Date.now());
    assert.strictEqual((await call('GET', '/state')).data.orchestrator.online, false);
    assert.strictEqual((await call('GET', '/live')).data.orchestrator.online, false);
    assert.match((await cli(t.url, ['orchestrator'])).stdout, new RegExp(`Conductor OFFLINE \\(pid ${c.pid} gone, last seen`));
    await waitFor(() => regEntry(t).presence.online === false, 5000);
    assert.match(boardNotes(t), /orchestrator 'Conductor' registered, pid \d+[\s\S]*orchestrator 'Conductor' \(pid \d+\) is offline: its process is gone/);
  } finally { killMine(); await t.s.close(); }
});

test('pid reuse guard: a recorded pid whose start time does not match is offline (board and registry)', async () => {
  const t = await startBoard('orch-reuse', { dispatch: false });
  try {
    const c = child();
    assert.strictEqual((await t.call('POST', '/orchestrator', { pid: c.pid, name: 'Marshal' })).data.online, true);
    // Same pid, another process: rewrite the recorded start time in both files.
    for (const f of ['orchestrator.json', 'agents.json']) {
      const p = path.join(runDir(t), f);
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (j.agents) j.agents.forEach(a => { a.start_time -= 7; }); else j.start_time -= 7;
      fs.writeFileSync(p, JSON.stringify(j));
    }
    const o = (await t.call('GET', '/orchestrator')).data;
    assert.ok(alive(c.pid), 'the pid itself still runs');
    assert.deepStrictEqual([o.name, o.online, o.pid], ['Marshal', false, c.pid]);
    // The hub's view of a registry entry re-checks the pid the same way.
    const p = { name: 'Marshal', online: true, pid: c.pid, start_time: procStat(c.pid).start_time, since: 'a', last_seen: 'b' };
    assert.strictEqual(registry.livePresence(p).online, true);
    assert.deepStrictEqual([registry.livePresence({ ...p, start_time: p.start_time + 1 }).online, registry.livePresence({ ...p, start_time: p.start_time + 1 }).since], [false, 'b']);
  } finally { killMine(); await t.s.close(); }
});

test('a new orchestrator replaces the previous entry, which is not signalled; workers cannot register one', async () => {
  const t = await startBoard('orch-replace', { dispatch: false });
  try {
    const a = child('trap "echo TERM >> ' + path.join(t.dir, 'a.signals') + '" TERM; sleep 600 & wait');
    const b = child();
    assert.strictEqual((await cli(t.url, ['orchestrator', 'register', '--name', 'Old', '--pid', String(a.pid)])).code, 0);
    // The other route (the agent manifest CLI) replaces it just the same.
    const r = await cli(t.url, ['agents', 'register', '--pid', String(b.pid), '--name', 'New', '--kind', 'orchestrator']);
    assert.strictEqual(r.code, 0, r.stderr);
    const o = (await t.call('GET', '/orchestrator')).data;
    assert.deepStrictEqual([o.name, o.pid, o.online], ['New', b.pid, true]);
    const orchs = manifest(t).filter(e => e.kind === 'orchestrator');
    assert.deepStrictEqual(orchs.map(e => e.name), ['New'], 'one orchestrator per board');
    await new Promise(res => setTimeout(res, 500));
    assert.ok(alive(a.pid), 'the replaced orchestrator is still running');
    assert.ok(!fs.existsSync(path.join(t.dir, 'a.signals')), 'and got no signal');
    assert.match(boardNotes(t), /orchestrator 'New' registered, pid \d+; replaces 'Old' \(pid \d+, still running, not signalled\)/);

    // Workers: 403 on the API, refused by the CLI.
    assert.strictEqual((await t.call('POST', '/orchestrator', { pid: a.pid, name: 'x' }, 'fake-1')).status, 403);
    const w = await cli(t.url, ['orchestrator', 'register', '--pid', String(a.pid), '--name', 'x'], { BOUNTY_SLOT: 'fake-1' });
    assert.notStrictEqual(w.code, 0);
    assert.match(w.stderr, /for the orchestrator; you are worker fake-1/);
    assert.strictEqual((await t.call('POST', '/orchestrator', { pid: 999999999, name: 'x' })).status, 404, 'a pid that is not running');
    assert.strictEqual((await t.call('POST', '/orchestrator', { pid: b.pid })).status, 400, 'no name and no board.json orchestrator');
  } finally { killMine(); await t.s.close(); }
});

test('bounty orchestrator register: pid defaults to the calling agent process (first non-shell ancestor), never a sub-shell; name from $AGENT_NAME', async () => {
  const t = await startBoard('orch-default', { dispatch: false, over: { orchestrator: 'Expected' } });
  try {
    // A fake agent (node), running the CLI the way agents do: a shell inside a shell.
    const out = path.join(t.dir, 'cli.out');
    const inner = `node ${JSON.stringify(path.join(ROOT, 'bin', 'bounty'))} orchestrator register > ${JSON.stringify(out)} 2>&1`;
    const agentJs = `require('child_process').execFileSync('bash', ['-c', ${JSON.stringify(`bash -c ${JSON.stringify(inner)}`)}], { stdio: 'inherit' }); setInterval(() => {}, 1000);`;
    const agent = spawn(process.execPath, ['-e', agentJs], { detached: true, stdio: 'ignore',
      env: { ...process.env, BOUNTY_URL: t.url, BOUNTY_SLOT: '', BOUNTY_ID: '', AGENT_NAME: 'Rook' } });
    mine.push(agent.pid);
    await waitFor(() => fs.existsSync(out) && fs.readFileSync(out, 'utf8').includes('registered'), 10000);
    assert.match(fs.readFileSync(out, 'utf8'), new RegExp(`registered orchestrator 'Rook' pid ${agent.pid} \\(node[^)]*\\): online`));
    const o = (await t.call('GET', '/orchestrator')).data;
    assert.deepStrictEqual([o.name, o.expected_name, o.pid, o.online], ['Rook', 'Expected', agent.pid, true]);
    // Without --name and $AGENT_NAME: the board's expected name.
    const c = child();
    assert.strictEqual((await cli(t.url, ['orchestrator', 'register', '--pid', String(c.pid)])).code, 0);
    assert.strictEqual((await t.call('GET', '/orchestrator')).data.name, 'Expected');
    assert.match((await cli(t.url, ['help'])).stdout, /bounty orchestrator register \[--name N\] \[--pid P\][\s\S]*never a sub-shell \$\$/);
  } finally { killMine(); await t.s.close(); }
});

test('board startup warns when work waits and no orchestrator is registered; require_orchestrator is reported', async () => {
  const t = await startBoard('orch-warn', { dispatch: false, over: { require_orchestrator: true } });
  const logged = [];
  const orig = console.warn;
  let s2 = null;
  try {
    // An empty board: no warning.
    assert.strictEqual((await t.call('GET', '/orchestrator')).data.warning, null);
    const b = t.board.create({ title: 'Add mul()', project: 'scratch', criteria: CRIT });
    t.board.ready(b.id);
    let o = (await t.call('GET', '/orchestrator')).data;
    assert.deepStrictEqual([o.required, o.pending], [true, 1]);
    assert.match(o.warning, /no orchestrator registered and 1 bounty is ready, in progress or blocked/);
    await t.s.close();

    // Restart on the same board dir: the startup log says it.
    console.warn = (...a) => { logged.push(a.join(' ')); };
    s2 = createServer(load(path.join(t.dir, 'board.json')), { dispatch: false });
    await s2.listen();
    console.warn = orig;
    assert.ok(logged.some(l => /^\[orchestrator\] WARNING: no orchestrator registered and 1 bounty is ready, in progress or blocked/.test(l)), logged.join('\n'));
    // Registered and online: no warning; the registry entry says required.
    const c = child();
    o = s2.board.presence.register({ pid: c.pid, name: 'Marshal' });
    assert.deepStrictEqual([o.online, o.warning, o.required], [true, null, true]);
    const e = registry.list(s2.board.cfg.registry_dir).find(x => x.port === s2.board.cfg.port);
    assert.deepStrictEqual([e.presence.name, e.presence.required, e.board_dir], ['Marshal', true, t.dir]);
  } finally { console.warn = orig; killMine(); if (s2) await s2.close(); }
});
