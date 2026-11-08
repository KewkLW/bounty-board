const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { promisify } = require('util');
const exec = promisify(require('child_process').execFile);
const { WebSocketServer } = require('ws');
const { startBoard, waitFor } = require('./helpers');
const { createServer } = require('../server');
const { selection, usage } = require('../lib/t3');
const { transition } = require('../lib/machine');

async function fake() {
  const requests = [], threads = new Map(), faults = {};
  const ws = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise(r => ws.once('listening', r));
  ws.on('connection', (socket, req) => {
    assert.equal(req.headers.authorization, 'Bearer fake-test-token');
    assert.equal(req.url, '/ws?orchestrationProtocol=2');
    socket.on('message', async data => {
      const f = JSON.parse(data); requests.push(f);
      if (f._tag !== 'Request') return;
      let value;
      const p = f.payload;
      const fail = name => socket.send(JSON.stringify({ _tag: 'Exit', requestId: f.id, exit: { _tag: 'Failure', cause: [{ _tag: 'Fail', error: { name } }] } }));
      if (f.tag === 'orchestration.launchThread' && faults.launch === 'reject') {
        fail('InvalidProjectError'); return;
      }
      if (f.tag === 'orchestration.getThreadProjection' && faults.projection) { fail('TemporaryFailure'); return; }
      if ((f.tag === 'orchestration.getThreadProjection' && !threads.has(p.threadId)) || (p.type === 'thread.stop' && (faults.interrupt || !threads.has(p.threadId)))) {
        if (faults.interrupt) faults.interrupt--;
        const error = f.tag === 'orchestration.getThreadProjection' ? { name: 'ProjectionStoreThreadNotFoundError' } : { name: 'TemporaryFailure' };
        socket.send(JSON.stringify({ _tag: 'Exit', requestId: f.id, exit: { _tag: 'Failure', cause: [{ _tag: 'Fail', error }] } }));
        return;
      }
      if (f.tag === 'orchestration.launchThread') {
        const projection = { thread: { id: p.threadId }, runs: [{ id: 'run-1', status: 'running' }], providerTurns: [], messages: [], visibleTurnItems: [], updatedAt: new Date().toISOString() };
        threads.set(p.threadId, projection); value = { threadId: p.threadId, projection, resumed: false };
        // Simulate a committed launch whose acknowledgement was lost.
        if (faults.launch === 'disconnect') { socket.terminate(); return; }
      } else if (f.tag === 'orchestration.getThreadProjection') value = threads.get(p.threadId);
      else if (p.type === 'thread.stop') {
        const t = threads.get(p.threadId); t.runs[0].status = 'interrupted'; t.updatedAt = new Date().toISOString(); value = { sequence: 1 };
      }
      socket.send(JSON.stringify({ _tag: 'Exit', requestId: f.id, exit: { _tag: 'Success', value } }));
    });
  });
  return { requests, threads, faults, disconnect: () => { for (const s of ws.clients) s.terminate(); }, config: { origin: `http://127.0.0.1:${ws.address().port}`, token: 'fake-test-token' },
    close: async () => { for (const s of ws.clients) s.terminate(); await new Promise(r => ws.close(r)); } };
}
const slot = { id: 't3-1', name: 'Nord', runner: 't3', t3: { provider: 'claudeAgent', model: 'claude-opus-5-5', effort: 'medium', runtime: 'full-access', project_id: 'scratch-project' } };
async function setup(tag, over = {}) {
  const f = await fake();
  const t = await startBoard(tag, { dispatch: false, over: { slots: [slot], runners: { t3: f.config }, ...over } });
  const d = t.s.dispatcher;
  const add = async title => {
    const b = t.board.create({ title, project: 'scratch', assignee_slot: slot.id, criteria: ['implemented and tested'] });
    t.board.ready(b.id); await d.spawn(t.cfg.slots[0], b);
    return { b, w: d.live.get(b.id), launch: f.requests.filter(r => r.tag === 'orchestration.launchThread').at(-1).payload };
  };
  return { ...t, f, d, add, finish: async () => { await t.s.close(); await f.close(); } };
}

test('T3: config, title, worktree, private CLI identity, activity, tokens, logs and turn exit', async () => {
  const t = await setup('t3-main');
  try {
    const { b, w, launch } = await t.add('thread work');
    assert.equal(launch.title, `Nord #${b.id}`);
    assert.deepEqual(launch.modelSelection, { instanceId: 'claudeAgent', model: 'claude-opus-5-5', options: [{ id: 'effort', value: 'medium' }] });
    assert.equal(launch.runtimeMode, 'full-access');
    assert.equal(launch.workspaceStrategy.type, 'existing_worktree');
    assert.equal(launch.workspaceStrategy.worktreePath, t.board.raw(b.id).worktree);
    const wrapper = w.logPath.replace(/\.log$/, '.bounty');
    assert.match(launch.initialMessage.text, /This T3 thread has no board environment/);
    assert.ok(launch.initialMessage.text.includes('`' + wrapper + ' start`'));
    assert.ok(!launch.initialMessage.text.includes('already set in your environment'));
    const cli = async args => {
      try { return { code: 0, ...(await exec(wrapper, args, { env: { ...process.env, BOUNTY_SLOT: 'wrong', BOUNTY_URL: 'http://127.0.0.1:1' } })) }; }
      catch (e) { return { code: e.code, stderr: e.stderr }; }
    };
    assert.equal((await cli(['start'])).code, 0);
    assert.equal(t.board.raw(b.id).claimed_by, slot.id);
    assert.equal((await cli(['progress', 'working through T3'])).code, 0);
    for (const cmd of ['ready', 'approve', 'done']) {
      const r = await cli([cmd, String(b.id)]); assert.notEqual(r.code, 0); assert.match(r.stderr, /worker|orchestrator/i);
    }
    const p = t.f.threads.get(w.threadId);
    p.updatedAt = new Date(Date.now() + 100).toISOString();
    p.providerTurns = [{ id: 'turn-1', tokenUsage: { usedTokens: 90000, inputTokens: 90000 }, turnTokenUsage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 30, cacheCreationTokens: 4 } }];
    p.messages = [{ id: 'm1', role: 'assistant', text: 'editing the implementation' }];
    p.visibleTurnItems = [{ sourceItemId: 'cmd', item: { id: 'cmd', type: 'command_execution', input: 'npm test', status: 'running' } }];
    t.d.t3.poll(b.id, w); await waitFor(() => w.usage?.tokens_in === 100);
    assert.equal(t.board.raw(b.id).heartbeat_at, p.updatedAt);
    assert.equal(t.d.lastActivity(b.id, w), Date.parse(p.updatedAt));
    const mtime = fs.statSync(w.logPath).mtimeMs;
    t.d.t3.poll(b.id, w); await waitFor(() => !w.polling);
    assert.equal(fs.statSync(w.logPath).mtimeMs, mtime, 'unchanged poll must not fake activity');
    assert.equal(t.d.slotsState()[0].usage.tokens_out, 20);
    const live = (await t.call('GET', '/live')).data;
    assert.equal(live.slots[0].thread_id, w.threadId);
    assert.equal(live.slots[0].usage.tokens_in, 100);
    assert.equal(live.slots[0].usage.cost_usd, null);
    assert.equal(live.slots[0].actions[0].summary, 'exec: npm test');
    assert.equal(live.slots[0].actions[0].running, true);
    assert.equal(live.slots[0].last_text.text, 'editing the implementation');
    assert.match((await t.call('GET', `/attempts/${w.attemptId}/log`)).data.text || JSON.stringify((await t.call('GET', `/attempts/${w.attemptId}/log`)).data), /editing/);
    p.runs[0].status = 'completed'; p.updatedAt = new Date().toISOString();
    t.d.t3.poll(b.id, w); await waitFor(() => !t.d.live.has(b.id));
    assert.equal(t.board.raw(b.id).status, 'blocked', 'finished without submit follows ordinary exit logic');
    const a = t.board.get(b.id).attempts[0];
    assert.equal(a.thread_id, w.threadId); assert.equal(a.pid, null);
    assert.equal(a.tokens_in, 100); assert.equal(a.tokens_out, 20); assert.equal(a.cache_read, 30); assert.equal(a.cost_usd, null);
    assert.equal(t.board.raw(b.id).tokens_in, 100);
    assert.ok(!t.board.agents.read().some(e => e.thread_id === w.threadId));
  } finally { await t.finish(); }
});

test('T3: rejected launch with confirmed absence closes attempt and manifest, and the slot can retry', async () => {
  const t = await setup('t3-launch-rejected');
  try {
    t.f.faults.launch = 'reject';
    const b = t.board.create({ title: 'rejected project', project: 'scratch', criteria: ['retry'], assignee_slot: slot.id });
    t.board.ready(b.id); t.d.tick();
    await waitFor(() => t.board.raw(b.id).status === 'blocked' && !t.d.spawning.size);
    const a = t.board.get(b.id).attempts[0];
    assert.match(t.board.raw(b.id).blocked_reason, /InvalidProjectError/);
    assert.ok(a.ended_at);
    assert.equal(a.exit_code, 1);
    assert.match(a.outcome, /never started/);
    assert.equal(t.d.live.size, 0);
    assert.equal(t.board.agents.read().length, 0);
    assert.equal(t.f.threads.size, 0);
    assert.equal(t.d.slotsState()[0].state, 'idle');
    assert.ok(t.f.requests.some(r => r.tag === 'orchestration.getThreadProjection' && r.payload.threadId === a.thread_id));
    delete t.f.faults.launch;
    t.board.ready(b.id); t.d.tick();
    const next = await waitFor(() => t.d.live.get(b.id));
    await waitFor(() => !next.launching);
    assert.notEqual(next.threadId, a.thread_id);
    assert.equal(t.board.get(b.id).attempts.length, 2);
    await t.d.t3.stop(next, 'test cleanup');
  } finally { await t.finish(); }
});

test('T3: lost launch acknowledgement interrupts the committed thread before releasing ownership', async () => {
  const t = await setup('t3-launch-lost');
  try {
    t.f.faults.launch = 'disconnect';
    const b = t.board.create({ title: 'lost acknowledgement', project: 'scratch', criteria: ['stop'], assignee_slot: slot.id });
    t.board.ready(b.id); t.d.tick();
    await waitFor(() => t.board.raw(b.id).status === 'blocked' && !t.d.spawning.size);
    const a = t.board.get(b.id).attempts[0];
    assert.equal(t.f.threads.get(a.thread_id).runs[0].status, 'interrupted');
    assert.ok(a.ended_at);
    assert.equal(t.d.live.size, 0);
    assert.equal(t.board.agents.read().length, 0);
    assert.equal(t.f.requests.filter(r => r.tag === 'orchestration.launchThread').length, 1);
  } finally { await t.finish(); }
});

test('T3: uncertain launch and unavailable reconciliation retain ownership until interrupt retry succeeds', async () => {
  const t = await setup('t3-launch-uncertain');
  try {
    t.f.faults.launch = 'disconnect'; t.f.faults.interrupt = 1; t.f.faults.projection = true;
    const b = t.board.create({ title: 'uncertain launch', project: 'scratch', criteria: ['retain'], assignee_slot: slot.id });
    t.board.ready(b.id); t.d.tick();
    await waitFor(() => t.board.raw(b.id).status === 'blocked' && !t.d.spawning.size);
    const w = t.d.live.get(b.id);
    assert.ok(w);
    assert.equal(t.f.threads.get(w.threadId).runs[0].status, 'running');
    assert.equal(t.board.get(b.id).attempts[0].ended_at, null);
    assert.equal(t.board.get(b.id).attempts[0].thread_stop_reason, 'T3 launch failed');
    assert.ok(t.board.agents.read().some(a => a.thread_id === w.threadId));
    assert.equal(t.d.slotsState()[0].state, 'working');
    delete t.f.faults.projection;
    t.d.t3.poll(b.id, w);
    await waitFor(() => !t.d.live.has(b.id));
    assert.equal(t.f.threads.get(w.threadId).runs[0].status, 'interrupted');
    assert.ok(t.board.get(b.id).attempts[0].ended_at);
    assert.equal(t.board.agents.read().length, 0);
    assert.equal(t.f.requests.filter(r => r.tag === 'orchestration.launchThread').length, 1);
  } finally { await t.finish(); }
});

test('T3: stall interrupts, existing block/requeue/escalation retries into a fresh thread', async () => {
  const t = await setup('t3-stall', { watchdog: { stall_minutes: 0.001, check_seconds: 1, kill_grace_seconds: 1 },
    slots: [slot, { ...slot, id: 't3-2', name: 'Everforest', t3: { ...slot.t3, model: 'bigger' } }],
    retry: { max_attempts: 4, escalate_after_failures: 2, escalate_model: { 'claude-opus-5-5': 'bigger' } } });
  try {
    const { b, w } = await t.add('stall');
    t.board.start(b.id, slot.id);
    w.lastActivity = Date.now() - 60000;
    t.f.threads.get(w.threadId).updatedAt = new Date(w.lastActivity).toISOString();
    t.d.watchdog(); await waitFor(() => !t.d.live.has(b.id));
    assert.equal(t.board.raw(b.id).status, 'blocked');
    assert.match(t.board.raw(b.id).blocked_reason, /watchdog/);
    assert.equal(t.f.requests.filter(r => r.payload.type === 'thread.stop').length, 1);
    t.board.requeue(b.id, 'retry stalled thread');
    assert.equal(t.board.raw(b.id).assignee_slot, 't3-2');
    await t.d.spawn(t.cfg.slots[1], t.board.need(b.id));
    const next = t.d.live.get(b.id);
    assert.notEqual(next.threadId, w.threadId);
    assert.equal(t.board.raw(b.id).attempts, 2);
    await t.d.t3.stop(next, 'test end');
  } finally { await t.finish(); }
});

test('T3: done, failed, kill, cleanup and idle shutdown interrupt only owned threads', async () => {
  const t = await setup('t3-stops', { idle_shutdown_minutes: 0.00001 });
  try {
    for (const mode of ['done', 'failed', 'kill', 'cleanup', 'idle']) {
      const { b, w } = await t.add(mode); t.board.start(b.id, slot.id);
      const before = t.f.requests.filter(r => r.payload.type === 'thread.stop').length;
      if (mode === 'failed') t.board.fail(b.id, 'test fail');
      if (mode === 'done') { transition(t.board.db, b.id, 'done', { via: 'close-merged' }); t.board.agents.onTerminal(b.id); }
      if (mode === 'kill') assert.equal(t.d.kill(b.id, 'test kill').thread_id, w.threadId);
      if (mode === 'cleanup') t.board.agents.cleanup({ kill: true, all: true });
      if (mode === 'idle') { t.board.setPaused(true); t.board.agents.lastActive = Date.now() - 60000; t.board.agents.sweep(); }
      await waitFor(() => !t.d.live.has(b.id));
      assert.equal(t.f.requests.filter(r => r.payload.type === 'thread.stop').length, before + 1);
      assert.equal(t.f.requests.filter(r => r.payload.type === 'thread.stop').at(-1).payload.threadId, w.threadId);
      if (mode === 'idle') t.board.setPaused(false);
    }
  } finally { await t.finish(); }
});

test('T3: board restart reattaches by thread id and records final usage once', async () => {
  const t = await setup('t3-restart'); let restarted;
  try {
    const { b, w } = await t.add('restart'); t.board.start(b.id, slot.id);
    // Close without the helpers' intentional worker cleanup, as the real server does.
    t.d.stop(); await t.s.closePreservingWorkers();
    restarted = createServer(t.cfg, { dispatch: false }); await restarted.listen();
    restarted.dispatcher.adopt();
    const adopted = restarted.dispatcher.live.get(b.id);
    assert.equal(adopted.threadId, w.threadId);
    assert.equal(adopted.pid, null);
    assert.equal(restarted.board.agents.read()[0].thread_id, w.threadId);
    assert.equal(t.f.requests.filter(r => r.payload.type === 'thread.stop').length, 0);
    const p = t.f.threads.get(w.threadId);
    p.providerTurns = [{ turnTokenUsage: { inputTokens: 50, outputTokens: 5 } }]; p.runs[0].status = 'failed';
    restarted.dispatcher.t3.poll(b.id, adopted);
    await waitFor(() => !restarted.dispatcher.live.has(b.id));
    assert.equal(restarted.board.raw(b.id).tokens_in, 50);
    assert.equal(restarted.board.get(b.id).attempts[0].ended_at != null, true);
    assert.equal(t.f.requests.filter(r => r.tag === 'orchestration.launchThread').length, 1);
  } finally { if (restarted) await restarted.close(); await t.f.close(); }
});

test('T3: runtime validation fails closed; effort option ids and turn ledger avoid snapshot double counting', () => {
  assert.throws(() => selection({ ...slot, t3: { ...slot.t3, runtime: 'read-only' } }), /read-only execution is unavailable/);
  assert.equal(selection({ t3: { provider: 'codex', model: 'gpt', effort: 'high', runtime: 'approval-required' } }).modelSelection.options[0].id, 'reasoningEffort');
  assert.deepEqual(usage({ providerTurns: [{ tokenUsage: { inputTokens: 5000 } }, { turnTokenUsage: { inputTokens: 10, outputTokens: 2 } }] }),
    { cost_usd: null, tokens_in: 10, tokens_out: 2, cache_read: 0, cache_write: 0 });
});


test('T3: unsupported read-only dispatch blocks with an explicit reason and creates no thread', async () => {
  const t = await setup('t3-readonly', { slots: [{ ...slot, t3: { ...slot.t3, runtime: 'read-only' } }] });
  try {
    const b = t.board.create({ title: 'read only', project: 'scratch', criteria: ['safe'], assignee_slot: slot.id });
    t.board.ready(b.id); t.d.tick();
    await waitFor(() => t.board.raw(b.id).status === 'blocked');
    assert.match(t.board.raw(b.id).blocked_reason, /read-only execution is unavailable/);
    assert.equal(t.f.requests.length, 0);
    assert.equal(t.d.live.size, 0);
  } finally { await t.finish(); }
});

test('T3: a reconnect preserves ownership; a failed kill interrupt retries before releasing the slot', async () => {
  const t = await setup('t3-reconnect');
  try {
    const { b, w } = await t.add('connection'); t.board.start(b.id, slot.id);
    t.f.disconnect();
    await new Promise(r => setTimeout(r, 20));
    t.d.t3.poll(b.id, w); await waitFor(() => !w.polling);
    assert.equal(t.d.live.get(b.id).threadId, w.threadId);
    assert.equal(t.f.requests.filter(r => r.tag === 'orchestration.launchThread').length, 1);
    t.f.faults.interrupt = 1;
    t.d.kill(b.id, 'retry kill');
    await waitFor(() => !w.stopPromise);
    assert.ok(t.d.live.has(b.id), 'failed interrupt must keep the slot owned');
    t.d.t3.poll(b.id, w);
    await waitFor(() => !t.d.live.has(b.id));
    assert.equal(t.f.requests.filter(r => r.payload.type === 'thread.stop').length, 2);
    assert.equal(t.board.raw(b.id).status, 'blocked');
  } finally { await t.finish(); }
});

test('T3: a deleted thread ends its attempt; a finished turn frees the slot for queued work', async () => {
  const t = await setup('t3-next');
  try {
    const { b, w } = await t.add('first'); t.board.start(b.id, slot.id);
    const next = t.board.create({ title: 'second', project: 'scratch', criteria: ['next'], assignee_slot: slot.id });
    t.board.ready(next.id);
    t.f.threads.get(w.threadId).runs[0].status = 'completed';
    t.d.t3.poll(b.id, w);
    const nw = await waitFor(() => t.d.live.get(next.id));
    await waitFor(() => !nw.launching);
    assert.notEqual(nw.threadId, w.threadId);
    t.f.threads.delete(nw.threadId);
    t.d.t3.poll(next.id, nw);
    await waitFor(() => !t.d.live.has(next.id));
    assert.equal(t.board.raw(next.id).status, 'blocked');
    assert.match(t.board.get(next.id).attempts[0].outcome, /never started/);
  } finally { await t.finish(); }
});


test('T3: an unacknowledged interrupt survives a board restart', async () => {
  const t = await setup('t3-pending-stop'); let restarted;
  try {
    const { b, w } = await t.add('pending stop'); t.board.start(b.id, slot.id);
    t.f.faults.interrupt = 1;
    t.d.kill(b.id, 'persistent stop');
    await waitFor(() => !w.stopPromise);
    assert.ok(t.d.live.has(b.id));
    assert.match(t.board.get(b.id).attempts[0].thread_stop_reason, /persistent stop/);
    await t.s.closePreservingWorkers();
    restarted = createServer(t.cfg, { dispatch: false }); await restarted.listen();
    restarted.dispatcher.adopt();
    const adopted = restarted.dispatcher.live.get(b.id);
    assert.match(adopted.stopReason, /persistent stop/);
    restarted.dispatcher.t3.poll(b.id, adopted);
    await waitFor(() => !restarted.dispatcher.live.has(b.id));
    assert.equal(t.f.requests.filter(r => r.payload?.type === 'thread.stop').length, 2);
  } finally { if (restarted) await restarted.close(); await t.f.close(); }
});

test('T3: per-bounty runtime persists across restart, overrides slot, and only orchestrator can change it', async () => {
  const t = await setup('t3-runtime-override'); let restarted;
  try {
    const created = await t.call('POST', '/bounties', { title: 'runtime override', project: 'scratch', criteria: ['safe'], assignee_slot: slot.id, t3_runtime: 'approval-required' });
    assert.equal(created.status, 200);
    const id = created.data.id;
    assert.equal(created.data.t3_runtime, 'approval-required');
    const denied = await t.call('PATCH', `/bounties/${id}`, { t3_runtime: 'full-access' }, slot.id);
    assert.equal(denied.status, 403);
    assert.equal((await t.call('PATCH', `/bounties/${id}`, { t3_runtime: null }, slot.id)).status, 403);
    assert.equal((await t.call('POST', '/bounties', { title: 'worker override', t3_runtime: 'full-access' }, slot.id)).status, 403);
    assert.equal((await t.call('PATCH', `/bounties/${id}`, { t3_runtime: 42 })).status, 400);
    t.d.stop(); await t.s.closePreservingWorkers();
    restarted = createServer(t.cfg, { dispatch: false }); await restarted.listen();
    assert.equal(restarted.board.raw(id).t3_runtime, 'approval-required');
    restarted.board.ready(id);
    await restarted.dispatcher.spawn(t.cfg.slots[0], restarted.board.need(id));
    assert.equal(t.f.requests.filter(r => r.tag === 'orchestration.launchThread').at(-1).payload.runtimeMode, 'approval-required');
    const w = restarted.dispatcher.live.get(id);
    await restarted.dispatcher.t3.stop(w, 'test finished');
    assert.equal(restarted.board.raw(id).status, 'blocked');
    restarted.board.update(id, { t3_runtime: null });
    restarted.board.ready(id);
    await restarted.dispatcher.spawn(t.cfg.slots[0], restarted.board.need(id));
    assert.equal(t.f.requests.filter(r => r.tag === 'orchestration.launchThread').at(-1).payload.runtimeMode, 'full-access');
    await restarted.dispatcher.t3.stop(restarted.dispatcher.live.get(id), 'test cleanup');
  } finally { if (restarted) await restarted.close(); else await t.s.close(); await t.f.close(); }
});

for (const runtime of ['read-only', 'unknown-mode', '']) {
  test(`T3: per-bounty ${runtime} overrides full-access and blocks without launching`, async () => {
    const t = await setup('t3-bounty-runtime-refused');
    try {
      const b = t.board.create({ title: 'fail closed', project: 'scratch', criteria: ['safe'], assignee_slot: slot.id, t3_runtime: runtime });
      t.board.ready(b.id); t.d.tick();
      await waitFor(() => t.board.raw(b.id).status === 'blocked');
      assert.match(t.board.raw(b.id).blocked_reason, /T3 does not support runtime/);
      assert.equal(t.f.requests.length, 0);
      assert.equal(t.d.live.size, 0);
    } finally { await t.finish(); }
  });
}

test('T3: CLI add/edit set and clear the per-bounty runtime', async () => {
  const t = await setup('t3-runtime-cli');
  try {
    const cli = args => exec(process.execPath, [require('path').join(__dirname, '../bin/bounty'), ...args], {
      env: { ...process.env, BOUNTY_URL: t.url, BOUNTY_SLOT: '', BOUNTY_ID: '', BOUNTY_ACTOR: 'orchestrator' }
    });
    await cli(['add', 'CLI runtime', '--project', 'scratch', '--t3-runtime', 'auto']);
    const b = t.board.list()[0];
    assert.equal(b.t3_runtime, 'auto');
    await cli(['edit', String(b.id), '--t3-runtime', 'approval-required']);
    assert.equal(t.board.raw(b.id).t3_runtime, 'approval-required');
    await cli(['edit', String(b.id), '--t3-runtime', 'default']);
    assert.equal(t.board.raw(b.id).t3_runtime, null);
  } finally { await t.finish(); }
});

test('T3: board project mapping wins over slot and defaults; slot wins over defaults; defaults last', async () => {
  const projectFor = async (slotT3, t3Over, tag) => {
    const { project_id, ...rest } = slot.t3;
    const t = await setup(tag, { slots: [{ ...slot, t3: { ...rest, ...slotT3 } }] });
    try {
      Object.assign(t.cfg.runners.t3, t3Over);
      const { w, launch } = await t.add('mapped');
      await waitFor(() => !w.launching);
      await t.d.t3.stop(w, 'test cleanup');
      return launch.projectId;
    } finally { await t.finish(); }
  };
  const map = { projects: { scratch: 't3-scratch' }, defaults: { project_id: 't3-default' } };
  assert.equal(await projectFor({ project_id: 't3-slot' }, map, 't3-proj-map'), 't3-scratch');
  assert.equal(await projectFor({ project_id: 't3-slot' }, { projects: { other: 't3-other' }, defaults: { project_id: 't3-default' } }, 't3-proj-slot'), 't3-slot');
  assert.equal(await projectFor({}, { projects: { other: 't3-other' }, defaults: { project_id: 't3-default' } }, 't3-proj-default'), 't3-default');
  assert.equal(await projectFor({ project_id: '' }, { projects: { scratch: '' }, defaults: { project_id: 't3-default' } }, 't3-proj-empty'), 't3-default');
});

test('T3: two board projects on one slot start threads in their own T3 projects', async () => {
  const t = await setup('t3-proj-two');
  try {
    t.cfg.runners.t3.projects = { scratch: 't3-scratch', second: 't3-second' };
    t.board.upsertProject({ ...t.board.project('scratch'), id: 'second', name: 'second' });
    const a = await t.add('first board project');
    await waitFor(() => !a.w.launching);
    assert.equal(a.launch.projectId, 't3-scratch');
    await t.d.t3.stop(a.w, 'test cleanup');
    await waitFor(() => !t.d.live.has(a.b.id));
    const b = t.board.create({ title: 'second board project', project: 'second', assignee_slot: slot.id, criteria: ['own T3 project'] });
    t.board.ready(b.id); t.d.tick();
    const w = await waitFor(() => t.d.live.get(b.id));
    await waitFor(() => !w.launching);
    const launch = t.f.requests.filter(r => r.tag === 'orchestration.launchThread').at(-1).payload;
    assert.equal(launch.threadId, w.threadId);
    assert.equal(launch.projectId, 't3-second');
    await t.d.t3.stop(w, 'test cleanup');
  } finally { await t.finish(); }
});

test('T3: no resolvable T3 project blocks with a clear reason and creates no thread', async () => {
  const { project_id, ...rest } = slot.t3;
  const t = await setup('t3-proj-none', { slots: [{ ...slot, t3: rest }] });
  try {
    t.cfg.runners.t3.projects = { other: 't3-other', scratch: '' };
    const b = t.board.create({ title: 'no T3 project', project: 'scratch', criteria: ['safe'], assignee_slot: slot.id });
    t.board.ready(b.id); t.d.tick();
    await waitFor(() => t.board.raw(b.id).status === 'blocked' && !t.d.spawning.size);
    assert.match(t.board.raw(b.id).blocked_reason, /no T3 project for board project 'scratch': set runners\.t3\.projects\["scratch"\], the slot's t3\.project_id or runners\.t3\.defaults\.project_id/);
    assert.equal(t.f.requests.length, 0);
    assert.equal(t.f.threads.size, 0);
    assert.equal(t.d.live.size, 0);
    assert.equal(t.board.get(b.id).attempts.length, 0);
  } finally { await t.finish(); }
});
