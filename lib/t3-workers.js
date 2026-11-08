const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { T3, selection, usage } = require('./t3');
const { now, addEvent } = require('./db');

// Thread ownership belongs to this board's manifest; the T3 server process is
// never owned or signalled by the board.
class T3Workers {
  constructor(dispatcher) {
    this.d = dispatcher;
    this.client = new T3(dispatcher.cfg.runners.t3 || {});
  }
  attach(a, adopted = true) {
    const w = { attemptId: a.id, slot: a.slot, pid: null, child: null, logPath: a.log_path,
      runner: 't3', threadId: a.thread_id, stopReason: a.thread_stop_reason || null, adopted, lastActivity: Date.parse(a.started_at), usage: null };
    this.d.live.set(a.bounty_id, w);
    this.d.board.agents.registerThread({ thread_id: a.thread_id, name: this.d.board.slot(a.slot)?.name || a.slot,
      bounty: a.bounty_id, slot: a.slot, attempt: this.d.board.raw(a.bounty_id)?.attempts });
    if (adopted) addEvent(this.d.db, { bounty_id: a.bounty_id, actor: 'dispatcher', kind: 'note', note: `re-attached to T3 thread ${a.thread_id} after a board restart` });
    return w;
  }
  async spawn(slot, b, wt, attemptNo, logPath, promptPath, prompt) {
    const t = { ...(this.d.cfg.runners.t3?.defaults || {}), ...slot.t3 };
    if (b.t3_runtime != null) t.runtime = b.t3_runtime;
    const spec = selection({ ...slot, t3: t });
    if (!t.project_id) throw new Error('t3 slot needs t3.project_id (an existing T3 project)');
    const threadId = randomUUID();
    // A per-attempt CLI supplies identity without changing a shared provider's env.
    // It preserves the existing X-Bounty-Actor slot restrictions on the board API.
    const wrapper = logPath.replace(/\.log$/, '.bounty');
    const q = x => "'" + String(x).replace(/'/g, "'\\''") + "'";
    fs.writeFileSync(wrapper, `#!/bin/sh\nexport BOUNTY_ID=${q(b.id)} BOUNTY_SLOT=${q(slot.id)} BOUNTY_ATTEMPT=${q(attemptNo)} BOUNTY_URL=${q(`http://127.0.0.1:${this.d.cfg.port}`)}\nexec ${q(process.execPath)} ${q(path.join(this.d.cfg.bin_dir, 'bounty'))} "$@"\n`, { mode: 0o700 });
    prompt = prompt.replace(/BOUNTY_ID=.*?are already set in your environment, so the commands below act on this bounty\./,
      `This T3 thread has no board environment. For EVERY bounty command use the private CLI at ${wrapper}; it supplies this attempt's board URL, bounty id and slot identity.`)
      .replace(`\`${path.join(this.d.cfg.bin_dir, 'bounty')}\` (also \`bounty\` on PATH)`, `\`${wrapper}\``)
      .replace(/`bounty(?=\s|`)/g, '`' + wrapper);
    fs.writeFileSync(promptPath, prompt);
    fs.appendFileSync(logPath, `# board: T3 thread ${threadId}, ${t.provider}/${t.model}, runtime ${t.runtime || 'full-access'}\n# cwd ${wt.worktree}\n`);
    const result = this.d.db.prepare(`INSERT INTO attempts (bounty_id, slot, runner, model, effort, thread_id, started_at, log_path, prompt_path, kind)
      VALUES (?, ?, 't3', ?, ?, ?, ?, ?, ?, 'worker')`).run(b.id, slot.id, t.model, t.effort || null, threadId, now(), logPath, promptPath);
    const w = this.attach({ id: Number(result.lastInsertRowid), slot: slot.id, bounty_id: b.id, thread_id: threadId, log_path: logPath, started_at: now() }, false);
    w.launching = true;
    try {
      const launched = await this.client.call('orchestration.launchThread', { commandId: randomUUID(), threadId,
        projectId: t.project_id, title: `${slot.name} #${b.id}`, generateTitle: false, ...spec, interactionMode: t.interaction || 'default',
        workspaceStrategy: { type: 'existing_worktree', worktreePath: wt.worktree, branch: wt.branch },
        initialMessage: { text: prompt, attachments: [] } });
      addEvent(this.d.db, { bounty_id: b.id, actor: 'dispatcher', kind: 'spawn', note: `attempt ${attemptNo}: ${slot.id} (t3 ${t.model}, effort ${t.effort || 'default'}) thread ${threadId} in ${wt.worktree}; log ${logPath}` });
      this.d.db.prepare("UPDATE agents SET status='active', current_directive=?, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(b.title, slot.id);
      if (launched.projection) this.update(b.id, w, launched.projection);
      this.d.board.changed('bounty', { id: b.id });
    } catch (e) {
      // A timeout may mean launch committed. Keep the predetermined thread id
      // owned and interrupt it before releasing the slot; never orphan a turn.
      fs.appendFileSync(logPath, `# board: T3 launch error: ${e.message}\n`);
      await this.stop(w, 'T3 launch failed').catch(() => {});
      throw e;
    } finally { w.launching = false; }
  }
  update(bid, w, p) {
    if (this.d.stopped || !this.d.db.open || this.d.live.get(bid) !== w) return;
    w.lastError = null;
    w.contextUsage = p.providerTurns?.at(-1)?.tokenUsage || null;
    const ledgers = (p.providerTurns || []).map(t => t.turnTokenUsage).filter(Boolean);
    w.usageStatus = !ledgers.length ? 'pending' : ledgers.some(t => t.usageStatus !== 'complete') ? 'partial' : 'complete';
    const at = Date.parse(p.updatedAt);
    if (Number.isFinite(at)) {
      w.lastActivity = Math.max(w.lastActivity || 0, at);
      this.d.db.prepare('UPDATE bounties SET heartbeat_at = CASE WHEN heartbeat_at IS NULL OR heartbeat_at < ? THEN ? ELSE heartbeat_at END WHERE id = ?').run(p.updatedAt, p.updatedAt, bid);
    }
    w.usage = usage(p);
    this.d.db.prepare('UPDATE attempts SET tokens_in=?, tokens_out=?, cache_read=?, cache_write=? WHERE id=?')
      .run(w.usage.tokens_in, w.usage.tokens_out, w.usage.cache_read, w.usage.cache_write, w.attemptId);
    const run = p.runs?.at(-1);
    w.threadState = run?.status || 'starting';
    // Polling does not create activity. Only changed thread data touches the log.
    w.logSeen ||= new Map();
    const changed = (kind, values) => values.filter(value => {
      const key = `${kind}:${value.id || value.sourceItemId}`, text = JSON.stringify(value);
      if (w.logSeen.get(key) === text) return false;
      w.logSeen.set(key, text); return true;
    });
    const messages = changed('message', (p.messages || []).filter(m => m.role !== 'user'));
    const items = changed('item', p.visibleTurnItems || []);
    const signature = JSON.stringify([p.updatedAt, w.threadState, w.usage, w.contextUsage]);
    if (signature !== w.snapshot || messages.length || items.length) {
      fs.appendFileSync(w.logPath, JSON.stringify({ type: 't3.snapshot', timestamp: p.updatedAt, thread_id: w.threadId,
        state: w.threadState, usage: w.usage, usage_status: w.usageStatus, context_usage: w.contextUsage, messages, items }) + '\n');
      w.snapshot = signature;
    }
    if (run && ['completed', 'failed', 'interrupted', 'cancelled', 'rolled_back'].includes(run.status)) {
      this.d.onExit(bid, run.status === 'completed' ? 0 : 1, `T3 turn ${run.status}; thread ${w.threadId}`);
    } else if (['done', 'failed'].includes(this.d.board.raw(bid)?.status)) {
      this.d.stopWorker(w, 'bounty is terminal after re-attach');
    }
  }
  poll(bid, w) {
    if (w.polling || w.launching || !w.threadId) return;
    if (w.stopReason && !w.stopPromise) this.d.stopWorker(w, w.stopReason);
    w.polling = true;
    this.client.projection(w.threadId).then(p => this.update(bid, w, p)).catch(e => {
      // An unreachable server is not proof the thread exited. The watchdog still
      // uses the last real event and retries interrupts until T3 is reachable.
      w.lastError = e.message;
      if (e.rpcCause && JSON.stringify(e.rpcCause).includes('ProjectionStoreThreadNotFoundError')) this.d.onExit(bid, null, 'T3 thread no longer exists');
    }).finally(() => { w.polling = false; });
  }
  async stop(w, reason) {
    if (w.stopPromise) return w.stopPromise;
    w.stopReason = reason;
    if (this.d.db.open) this.d.db.prepare('UPDATE attempts SET thread_stop_reason = ? WHERE id = ?').run(reason, w.attemptId);
    w.stopPromise = this.client.interrupt(w.threadId, reason).then(async () => {
      const p = await this.client.projection(w.threadId);
      const entry = [...this.d.live].find(([, x]) => x === w);
      if (entry) this.update(entry[0], w, p);
    }).finally(() => { w.stopPromise = null; });
    return w.stopPromise;
  }
  close() { this.client.close().catch(() => {}); }
}
module.exports = { T3Workers };
