// Opt-in installed-T3 acceptance check. No T3 installation/config changes; only
// this script's scratch project/threads are created, interrupted and deleted.
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { execFileSync } = require('child_process');
const { T3 } = require('../lib/t3');
const { makeRepo, writeConfig, tmpdir, sh, waitFor } = require('../test/helpers');
const { load } = require('../lib/config');
const { createServer } = require('../server');

(async () => {
  const dir = tmpdir('b9-installed');
  const runtimeFile = path.join(process.env.HOME, '.t3/userdata/server-runtime.json');
  const before = JSON.parse(fs.readFileSync(runtimeFile));
  console.log(JSON.stringify({ at: new Date().toISOString(), scratch: dir, before_pid: before.pid }));
  const c = new T3(); const projectId = randomUUID(), threads = new Set();
  let s, created = false;
  try {
    const repo = makeRepo(path.join(dir, 'repo'));
    process.env.BOUNTY_NO_SEED = '1';
    process.env.BOUNTY_REGISTRY_DIR = path.join(dir, 'registry');
    const cfg = load(writeConfig(dir, { slots: [{ id: 't3-e2e', name: 'B9 Scratch', runner: 't3', t3: {
      provider: 'codex', model: 'gpt-6.1-sol', effort: 'low', runtime: 'full-access', project_id: projectId } }],
      run_dir: path.join(dir, 'run'), runners: { t3: {} }, tick_seconds: 0.25, merge_check_seconds: 0.5,
      watchdog: { stall_minutes: 5, check_seconds: 0.25, kill_grace_seconds: 1 }, idle_shutdown_minutes: 0 }));
    await c.call('projects.mutate', { type: 'project.create', commandId: randomUUID(), projectId, title: 'B9 runner scratch', workspaceRoot: repo });
    created = true;
    s = createServer(cfg); const port = await s.listen();
    if (port >= 3770 && port <= 3799) throw new Error('ephemeral port unexpectedly in forbidden range');
    console.log(JSON.stringify({ board_port: port, registry: cfg.registry_dir, project_id: projectId, board_pid: process.pid }));
    s.board.upsertProject({ id: 'scratch', repo, main_branch: 'main', worktree_cmd: 'git worktree add {path} -b {branch} {main}',
      worktree_path: path.join(dir, 'wt', '{task}'), verify_cmd: './verify.sh', verify_timeout_min: 2 });
    const b = s.board.create({ title: 'Implement multiply', project: 'scratch', criteria: ['math exports mul and a passing test'], assignee_slot: 't3-e2e',
      description: 'Scratch acceptance test. Use only the private bounty CLI specified below. Run start, inbox and progress. Add mul(a,b) returning a*b to math.js and a test; run ./verify.sh; commit. Submit using --no-wait. SPECIAL TEST INSTRUCTION overriding the usual exit instruction: after successful submit call the shell tool with sleep 300, no output; stay there until the board interrupts the thread. Do not modify or communicate with any other board, room or project.' });
    s.board.ready(b.id);
    const w = await waitFor(() => s.dispatcher.live.get(b.id), 30000); threads.add(w.threadId);
    await waitFor(() => !w.launching, 30000);
    console.log('SUCCESS_THREAD ' + w.threadId);
    console.log('CLI_LIST ' + execFileSync('t3', ['thread', 'list', '--project', projectId, '--json'], { encoding: 'utf8' }));
    await waitFor(() => ['review', 'approved'].includes(s.board.raw(b.id).status), 300000, 500);
    const state = await (await fetch(`http://127.0.0.1:${port}/api/live`)).json();
    console.log('LIVE ' + JSON.stringify({ slot: state.slots[0], heartbeat: s.board.raw(b.id).heartbeat_at }));
    await waitFor(() => s.board.raw(b.id).status === 'approved', 30000);
    // The scratch orchestrator merges only the scratch repo, just like the real board's merge gate.
    sh(repo, `git merge -q --no-ff ${s.board.raw(b.id).branch} -m scratch-merge`);
    await waitFor(() => s.board.raw(b.id).status === 'done', 15000);
    await waitFor(() => !s.dispatcher.live.has(b.id), 30000);
    const ended = await c.projection(w.threadId);
    console.log('DONE ' + JSON.stringify({ bounty: s.board.raw(b.id), attempt: s.board.get(b.id).attempts.filter(x => x.kind === 'worker'),
      runs: ended.runs.map(x => ({ id: x.id, status: x.status })), events: s.board.db.prepare('SELECT at,actor,kind,to_status,note FROM events WHERE bounty_id=?').all(b.id) }));
    // Genuine inactivity: the tool sleeps silently; no fake clock or mutated T3 state.
    const stall = s.board.create({ title: 'Stall and retry', project: 'scratch', criteria: ['observe interruption'], assignee_slot: 't3-e2e',
      description: 'Scratch watchdog acceptance test. Use only private bounty CLI below. Run start, inbox, then progress with exactly STALL_READY, then immediately invoke shell sleep 300. Do not submit, edit files, ask questions, use any room, or print output during the sleep. The scratch orchestrator expects to interrupt you.' });
    s.board.ready(stall.id);
    const sw = await waitFor(() => s.dispatcher.live.get(stall.id), 30000); threads.add(sw.threadId);
    await waitFor(() => s.board.db.prepare("SELECT 1 FROM events WHERE bounty_id=? AND kind='progress' AND note LIKE '%STALL_READY%'").get(stall.id), 120000, 250);
    cfg.watchdog.stall_minutes = 0.05;
    console.log('STALL_ARMED ' + JSON.stringify({ at: new Date().toISOString(), thread: sw.threadId, limit_seconds: 3 }));
    await waitFor(() => !s.dispatcher.live.has(stall.id), 30000, 100);
    console.log('STALLED ' + JSON.stringify({ bounty: s.board.raw(stall.id), runs: (await c.projection(sw.threadId)).runs.map(x => ({ id: x.id, status: x.status })) }));
    cfg.watchdog.stall_minutes = 5;
    s.board.requeue(stall.id, 'scratch orchestrator retry after watchdog block');
    const retry = await waitFor(() => s.dispatcher.live.get(stall.id), 30000); threads.add(retry.threadId);
    await waitFor(() => !retry.launching, 30000);
    console.log('RETRY ' + JSON.stringify({ thread: retry.threadId, previous_thread: sw.threadId, attempt: s.board.raw(stall.id).attempts }));
    s.dispatcher.kill(stall.id, 'scratch test cleanup');
    await waitFor(() => !s.dispatcher.live.has(stall.id), 30000);
    console.log('STALL_EVENTS ' + JSON.stringify(s.board.db.prepare('SELECT at,actor,kind,to_status,note FROM events WHERE bounty_id=?').all(stall.id)));
  } finally {
    if (s) {
      // Stop dispatch before cleanup; only threads from this scratch DB are owned.
      s.dispatcher.stop();
      for (const a of s.board.db.prepare("SELECT thread_id FROM attempts WHERE runner='t3'").all()) if (a.thread_id) threads.add(a.thread_id);
    }
    const cleanupErrors = [];
    for (const threadId of threads) {
      try {
      await c.interrupt(threadId, 'b9 scratch cleanup');
      await c.call('orchestration.dispatchCommand', { type: 'thread.delete', commandId: randomUUID(), threadId });
      console.log('REMOVED_THREAD ' + threadId);
      } catch (e) { cleanupErrors.push(e.message); }
    }
    if (created) { try { console.log('CLI_AFTER_REMOVAL ' + execFileSync('t3', ['thread', 'list', '--project', projectId, '--json'], { encoding: 'utf8' })); await c.call('projects.mutate', { type: 'project.delete', commandId: randomUUID(), projectId, force: true }); console.log('REMOVED_PROJECT ' + projectId); } catch (e) { cleanupErrors.push(e.message); } }
    if (s) await s.close();
    await c.close();
    const after = JSON.parse(fs.readFileSync(runtimeFile));
    console.log(JSON.stringify({ after_pid: after.pid, unchanged: before.pid === after.pid, scratch_board_stopped: true, at: new Date().toISOString() }));
    if (cleanupErrors.length) throw new Error('Scratch cleanup errors: ' + cleanupErrors.join('; '));
    if (before.pid !== after.pid) throw new Error('installed server PID changed');
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
