// The Live page's parsers (worker stream-json, ci.sh logs, lock holder files, flock waits)
// and GET /api/live end to end with a fake worker.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawn, execFile, execFileSync } = require('child_process');
const { startBoard, waitFor, tmpdir } = require('./helpers');
const live = require('../lib/live');

const CRIT = ['works'];
const j = o => JSON.stringify(o);

test('worker stream-json: last actions, running tool, last text, usage counted once per message', () => {
  const cwd = '/mnt/ue/wt/b1-x';
  const lines = [
    '# board: spawn claude -p ...',
    j({ type: 'system', subtype: 'init', cwd, model: 'opus' }),
    j({ type: 'assistant', timestamp: '2026-09-29T10:00:00Z', message: { id: 'm1', content: [{ type: 'text', text: 'Let me look.\nReading the build script first.' }], usage: { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 100, cache_creation_input_tokens: 10 } } }),
    j({ type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'Scripts/ci.sh --quick\necho done' } }], usage: { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 100, cache_creation_input_tokens: 10 } } }),
    j({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: 'PASS' }] }, timestamp: '2026-09-29T10:01:00Z' }),
    j({ type: 'assistant', message: { id: 'm2', content: [{ type: 'tool_use', id: 'b', name: 'Edit', input: { file_path: `${cwd}/Source/Tribulation/Ship.cpp`, old_string: 'a', new_string: 'b' } }], usage: { input_tokens: 1, output_tokens: 1 } } }),
    j({ type: 'assistant', message: { id: 'm3', content: [{ type: 'tool_use', id: 'c', name: 'TodoWrite', input: { todos: [{ content: 'x', status: 'completed' }, { content: 'y', activeForm: 'Writing the test', status: 'in_progress' }] } }], usage: { input_tokens: 1, output_tokens: 1 } } }),
    'not json at all',
  ];
  const st = live.parseWorkerLog(lines.join('\n'));
  const v = live.workerView(st);
  assert.deepStrictEqual(v.actions.map(a => a.summary), [
    'Bash: Scripts/ci.sh --quick …(+1 lines)', 'Edit: Source/Tribulation/Ship.cpp', 'Todo 1/2: Writing the test']);
  assert.deepStrictEqual(v.actions.map(a => a.running), [false, true, true]);
  assert.strictEqual(v.last_text.text, 'Reading the build script first.');
  assert.strictEqual(v.last_text.at, '2026-09-29T10:00:00Z');
  assert.strictEqual(v.usage.tokens_in, 7, 'm1 counted once');
  assert.strictEqual(v.usage.cache_read, 100);
  assert.strictEqual(v.usage.cache_write, 10);
  assert.strictEqual(v.usage.cost_usd, null);
  assert.ok(v.usage.tokens_out_est >= 4);
  // the result event carries the real totals
  live.feedWorkerLine(st, j({ type: 'result', subtype: 'success', total_cost_usd: 1.5, num_turns: 3, result: 'All done.\nSubmitted.', usage: { input_tokens: 9, output_tokens: 99, cache_read_input_tokens: 1, cache_creation_input_tokens: 2 } }));
  const v2 = live.workerView(st);
  assert.strictEqual(v2.usage.cost_usd, 1.5);
  assert.strictEqual(v2.usage.tokens_out, 99);
  assert.strictEqual(v2.last_text.text, 'Submitted.');
  // only the last N actions are kept
  for (let i = 0; i < 20; i++) live.feedWorkerLine(st, j({ type: 'assistant', message: { id: 'x' + i, content: [{ type: 'tool_use', id: 'x' + i, name: 'Read', input: { file_path: `/tmp/f${i}` } }] } }));
  assert.strictEqual(live.workerView(st, 3).actions.length, 3);
  assert.strictEqual(live.workerView(st, 3).actions[2].summary, 'Read: /tmp/f19');
});

test('codex --json log: commands, messages, token usage', () => {
  const st = live.parseWorkerLog([
    j({ type: 'item.started', item: { id: 'i1', type: 'command_execution', command: 'bash -lc "go test ./..."' } }),
    j({ type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: 'bash -lc "go test ./..."', exit_code: 0 } }),
    j({ type: 'item.started', item: { id: 'i2', type: 'command_execution', command: 'Scripts/ci.sh --quick' } }),
    j({ type: 'item.completed', item: { id: 'm', type: 'agent_message', text: 'Tests pass; running CI.' } }),
    j({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 50, output_tokens: 20 } }),
  ].join('\n'));
  const v = live.workerView(st);
  assert.deepStrictEqual(v.actions.map(a => [a.summary, a.running]), [['exec: bash -lc "go test ./..."', false], ['exec: Scripts/ci.sh --quick', true]]);
  assert.strictEqual(v.last_text.text, 'Tests pass; running CI.');
  assert.strictEqual(v.usage.tokens_in, 100);
  assert.strictEqual(v.usage.tokens_out, 20);
});

test('Follower reads only appended bytes, holds partial lines, restarts on truncate', () => {
  const dir = tmpdir('follow');
  const f = path.join(dir, 'a.log');
  fs.writeFileSync(f, 'one\ntwo\nthr');
  const fl = new live.Follower({ chunk: 4 });
  const mk = () => ({ lines: [] });
  const feed = (st, l) => st.lines.push(l);
  let st = fl.follow(f, mk, feed);
  assert.deepStrictEqual(st.lines, ['one', 'two']);
  fs.appendFileSync(f, 'ee\nfour\n');
  st = fl.follow(f, mk, feed);
  assert.deepStrictEqual(st.lines, ['one', 'two', 'three', 'four']);
  st = fl.follow(f, mk, feed);
  assert.strictEqual(st.lines.length, 4, 'nothing new, nothing re-read');
  fs.writeFileSync(f, 'new\n');
  st = fl.follow(f, mk, feed);
  assert.deepStrictEqual(st.lines, ['new'], 'truncated file starts over');
  // maxInitial: a big existing file is read from its tail only (first partial line dropped)
  const g = path.join(dir, 'b.log');
  fs.writeFileSync(g, Array.from({ length: 1000 }, (_, i) => `line ${i}`).join('\n') + '\n');
  const tail = new live.Follower({ maxInitial: 40 }).follow(g, mk, feed);
  assert.ok(tail.lines.length > 0 && tail.lines.length <= 5, String(tail.lines.length));
  assert.strictEqual(tail.lines[tail.lines.length - 1], 'line 999');
  assert.ok(tail.lines.every(l => /^line \d+$/.test(l)));
  assert.strictEqual(fl.follow(path.join(dir, 'missing.log'), mk, feed), null);
});

test('ci.sh logs: current stage, position in the plan, lock waits, summary and exit', () => {
  const log = [
    '$ Scripts/ci.sh --quick', '# cwd /mnt/ue/wt/b87', '# started 2026-09-29T23:07:03.927Z', '',
    '==> [lfs]', 'Content repo present', '', '==> [rules]', 'Rule scan passed', '', '==> [render-lock]', '== syntax', '  ok   bash -n x',
    '==> [editor-build]', '==> Running ShardPortal automation tests',
  ];
  let st = live.parseCiLog(log.join('\n'));
  assert.strictEqual(st.cmd, 'Scripts/ci.sh --quick');
  assert.strictEqual(st.started, '2026-09-29T23:07:03.927Z');
  assert.deepStrictEqual(st.stages, ['lfs', 'rules', 'render-lock', 'editor-build'], '"==> Running ..." is not a stage');
  const dir = tmpdir('ci');
  const script = path.join(dir, 'ci.sh');
  fs.writeFileSync(script, `#!/bin/bash
all_stages=(
  lfs rules render-lock stack-gate director-static editor-build game-build automation testmap client-check
  server-console hop-e2e chat
)
quick_stages=(lfs rules render-lock stack-gate editor-build game-build automation testmap hop-e2e)
full_stages=("\${all_stages[@]}")
`);
  const lists = live.ciStageLists(script);
  assert.strictEqual(lists.all.length, 13);
  assert.deepStrictEqual(live.ciPlan(lists, '--quick'), ['lfs', 'rules', 'render-lock', 'stack-gate', 'editor-build', 'game-build', 'automation', 'testmap', 'hop-e2e']);
  assert.strictEqual(live.ciPlan(lists, '').length, 9, 'quick is the default');
  assert.strictEqual(live.ciPlan(lists, '--full --keep-going').length, 13);
  assert.deepStrictEqual(live.ciPlan(lists, '--only chat,lfs'), ['lfs', 'chat'], 'only keeps the canonical order');
  assert.deepStrictEqual(live.ciPlan(lists, '--quick --skip=editor-build,game-build').slice(3, 5), ['stack-gate', 'automation']);
  assert.ok(live.isCiProc('/bin/bash Scripts/ci.sh --quick'));
  assert.ok(live.isCiProc('bash /mnt/ue/Tribulation/Scripts/ci.sh'));
  assert.ok(!live.isCiProc("/usr/bin/bash -c source x && eval 'Scripts/ci.sh --quick > /tmp/log 2>&1'"), 'a shell that runs ci.sh is not ci.sh');
  let v = live.ciView(st, live.ciPlan(lists, '--quick'));
  assert.strictEqual(v.stage, 'editor-build');
  assert.strictEqual(v.position, 5);
  assert.strictEqual(v.total, 9);
  assert.strictEqual(v.finished, false);
  // a lock wait inside a stage, then the acquisition
  live.feedCiLine(st, '==> [hop-e2e]');
  live.feedCiLine(st, 'ue-stack-gate: waiting for the Unreal stack gate, held by b98 (agent): test-creatures.sh');
  assert.deepStrictEqual(live.ciView(st, null).waiting.lock, 'stack');
  live.feedCiLine(st, 'ue-stack-gate: acquired after 40s');
  assert.strictEqual(live.ciView(st, null).waiting, null);
  live.feedCiLine(st, 'ue-render-lock: waiting for the rendered-Unreal lock, held by tester');
  assert.strictEqual(live.ciView(st, null).waiting.lock, 'render');
  // end of run: summary table and the board's exit line
  for (const l of ['', 'STAGE              RESULT DURATION   LOG', 'lfs                PASS   1s         Saved/CI/lfs.log', 'hop-e2e            FAIL   3m02s      Saved/CI/hop-e2e.log', '', '# exit 1 at 2026-09-29T23:40:00Z']) live.feedCiLine(st, l);
  v = live.ciView(st, null);
  assert.strictEqual(v.finished, true);
  assert.strictEqual(v.stage, null);
  assert.strictEqual(v.exit, '1');
  assert.deepStrictEqual(v.results['hop-e2e'], { result: 'FAIL', duration: '3m02s' });
});

test('holder files: key=value, JSON, empty; stale when the flock is free, held while flocked', async () => {
  const h = live.parseHolder(`version=1\ntoken=1-2\npid=${process.pid}\npids=11 12\nkind=agent\nowner=tester\nworktree=/mnt/ue/wt/tester\nwhat=playtest.sh p0 (offscreen)\nstarted_epoch=${Math.floor(Date.now() / 1000) - 90}\nstate=admitting\n`);
  assert.strictEqual(h.owner, 'tester');
  assert.strictEqual(h.what, 'playtest.sh p0 (offscreen)');
  assert.deepStrictEqual(h.pids, [11, 12]);
  assert.strictEqual(h.pid, process.pid);
  assert.ok(h.since_s >= 89 && h.since_s <= 92, String(h.since_s));
  assert.strictEqual(live.parseHolder('{"owner":"x","pid":5}').owner, 'x');
  assert.strictEqual(live.parseHolder('  \n'), null);
  assert.deepStrictEqual(live.parseHolder('just some text'), { text: 'just some text' });

  const dir = tmpdir('locks');
  fs.writeFileSync(path.join(dir, 'ue-render.lock'), '');
  fs.writeFileSync(path.join(dir, 'ue-render.holder'), 'owner=gone\nwhat=old run\npid=999999\n');
  let l = live.readLock(dir, 'ue-render');
  assert.strictEqual(l.held, false);
  assert.strictEqual(l.stale, true);
  assert.strictEqual(l.holder.pid_alive, false);
  assert.strictEqual(live.readLock(dir, 'ue-stack').held, false, 'no lock file = free');
  // hold it with flock(1), and wait on it from a second flock: the wait is found in the ps tree
  const lock = path.join(dir, 'ue-render.lock');
  const holder = spawn('flock', [lock, 'sleep', '30'], { stdio: 'ignore' });
  const waiter = spawn('bash', ['-c', `exec 9>"${lock}"; flock -w 30 9`], { stdio: 'ignore' });
  try {
    await waitFor(() => live.readLock(dir, 'ue-render').held === true, 5000, 100);
    l = live.readLock(dir, 'ue-render');
    assert.strictEqual(l.stale, false);
    const found = await waitFor(() => {
      const pt = live.parsePs(execFileSync('ps', ['-eo', 'pid=,ppid=,etimes=,args='], { encoding: 'utf8' }));
      const tree = [...pt.procs.values()].filter(p => p.pid === waiter.pid || p.ppid === waiter.pid);
      const w = live.lockWaits(pt, tree, dir);
      return w.length ? w : null;
    }, 5000, 100);
    assert.strictEqual(found[0].lock, 'render');
    assert.strictEqual(found[0].file, lock);
    // a wait on a lock outside the lock dir (e.g. a test's own temp lock) is not reported
    const pt = live.parsePs(execFileSync('ps', ['-eo', 'pid=,ppid=,etimes=,args='], { encoding: 'utf8' }));
    assert.strictEqual(live.lockWaits(pt, [...pt.procs.values()].filter(p => p.pid === waiter.pid), '/nonexistent').length, 0);
  } finally { holder.kill('SIGKILL'); waiter.kill('SIGKILL'); }
});

test('GET /api/live and bounty live: a working slot with its bounty, actions, progress, unread notes; queue and recent', async () => {
  const dir = tmpdir('live-cfg');
  fs.mkdirSync(path.join(dir, 'tester-logs'));
  fs.writeFileSync(path.join(dir, 'tester-logs', 'c1.log'), '==> cycle 1\n{"type":"assistant","message":{"id":"q","content":[{"type":"text","text":"Filed 2 bugs."}]}}\n');
  const t = await startBoard('live', { over: { live: { lock_dir: dir, stuck_minutes: 10, tester: { service: 'bb-live-test-nonexistent.service', timer: null, log_dir: path.join(dir, 'tester-logs') } } } });
  try {
    const { board, call } = t;
    const b = board.create({ criteria: CRIT, title: 'live one', project: 'scratch', description: 'mode:live', assignee_slot: 'fake-1', tier: 'A', priority: 'high' });
    const q = board.create({ criteria: CRIT, title: 'queued next', project: 'scratch', assignee_slot: 'fake-2', depends_on: [b.id] });
    board.ready(q.id);
    board.ready(b.id);
    await waitFor(() => board.raw(b.id).status === 'in_progress');
    const L = await waitFor(async () => {
      const r = await call('GET', '/live');
      const s = r.data.slots && r.data.slots.find(x => x.id === 'fake-1');
      return s && s.actions && s.actions.length >= 2 && s.progress ? r.data : null;
    }, 15000, 300);
    await call('POST', `/bounties/${b.id}/notes`, { text: 'hey, check the edge case' });
    const s = L.slots.find(x => x.id === 'fake-1');
    assert.strictEqual(s.state, 'working');
    assert.strictEqual(s.bounty.id, b.id);
    assert.strictEqual(s.bounty.tier, 'A');
    assert.strictEqual(s.bounty.priority, 'high');
    assert.strictEqual(s.attempt.number, 1);
    assert.strictEqual(s.pipeline.phase, 'in_progress');
    assert.match(s.progress.note, /looking at math.js/);
    assert.deepStrictEqual(s.actions.map(a => a.summary), ['Read: math.js', 'Bash: sleep 600']);
    assert.strictEqual(s.actions[1].running, true);
    assert.strictEqual(s.last_text.text, 'Reading the code first.');
    assert.strictEqual(s.usage.tokens_in, 15);
    assert.strictEqual(s.possibly_stuck, false);
    assert.strictEqual(L.slots.find(x => x.id === 'fake-2').state, 'idle');
    assert.deepStrictEqual(L.queue.find(x => x.slot === 'fake-2').ready.map(r => [r.id, r.waiting_on]), [[q.id, [b.id]]]);
    assert.strictEqual(L.queue.find(x => x.slot === 'fake-2').next, null, 'its dependency is not done');
    assert.strictEqual(L.locks.render.held, false);
    assert.ok(L.memory.available_mb > 0);
    assert.strictEqual(L.tester.running, false);
    assert.strictEqual(L.tester.latest_line, 'Filed 2 bugs.');
    assert.ok(Array.isArray(L.ci_runs) && Array.isArray(L.recent) && Array.isArray(L.pipeline));
    // unread notes show up after the cache expires
    await new Promise(r => setTimeout(r, 2100));
    const L2 = (await call('GET', '/live')).data;
    assert.strictEqual(L2.slots.find(x => x.id === 'fake-1').unread_notes, 1);
    // text form (what `bounty live` prints)
    const txt = await (await fetch(t.url + '/api/live?format=text')).text();
    assert.match(txt, /^LIVE /);
    assert.match(txt, new RegExp(`fake-1 +#${b.id} \\[A/high\\] live one`));
    assert.match(txt, /> Bash: sleep 600/);
    assert.match(txt, /1 unread note/);
    // async: a sync exec would block the server this test runs in-process
    const cli = await new Promise((resolve, reject) => execFile(path.join(__dirname, '..', 'bin', 'bounty'), ['live'], { env: { ...process.env, BOUNTY_URL: t.url, BOUNTY_SLOT: '', BOUNTY_ID: '' }, encoding: 'utf8' }, (e, out) => (e ? reject(e) : resolve(out))));
    assert.match(cli, /SLOTS/);
    assert.match(cli, /QUEUE/);
    // the page is served
    const page = await fetch(t.url + '/live');
    assert.strictEqual(page.status, 200);
    assert.match(await page.text(), /\/api\/live/);
  } finally { await t.s.close(); }
});
