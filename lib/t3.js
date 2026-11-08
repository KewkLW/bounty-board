// T3's Effect JSON-RPC protocol (v2), authenticated with a scoped, expiring local CLI
// session. Credentials stay in memory, never in logs, prompts, manifests or command args.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { randomUUID } = require('crypto');
const WebSocket = require('ws');
const exec = promisify(execFile);

class T3 {
  constructor(config = {}) { this.config = config; this.pending = new Map(); this.serial = 0; this.sessions = new Set(); }
  async connect() {
    if (this.closed) throw new Error('T3 client is closed');
    if (this.socket?.readyState === WebSocket.OPEN) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.open().finally(() => { this.connecting = null; });
    return this.connecting;
  }
  async open() {
    const c = this.config;
    const base = c.base_dir || process.env.T3CODE_HOME || path.join(os.homedir(), '.t3');
    const origin = c.origin || JSON.parse(fs.readFileSync(path.join(base, 'userdata/server-runtime.json'), 'utf8')).origin;
    this.locationArgs = ['--base-dir', base];
    const issued = c.token ? null : JSON.parse((await exec(c.bin || 't3', ['auth', 'session', 'issue', ...this.locationArgs,
      '--scope', 'orchestration:read', '--scope', 'orchestration:operate', '--scope', 'settings:write',
      '--ttl', '1h', '--label', 'bounty-board t3 runner', '--json'], { timeout: 15000 })).stdout);
    const sessionId = issued?.sessionId;
    if (sessionId) this.sessions.add(sessionId);
    if (this.closed) { await this.revoke(sessionId); throw new Error('T3 client is closed'); }
    const token = c.token || issued?.token;
    if (!token) throw new Error('T3 CLI did not issue a bearer token');
    const url = new URL('/ws?orchestrationProtocol=2', origin.replace(/^http/, 'ws'));
    const ws = this.socket = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` }, handshakeTimeout: 10000 });
    ws.on('message', data => {
      let frames; try { frames = JSON.parse(data); } catch { return; }
      for (const f of Array.isArray(frames) ? frames : [frames]) {
        const p = this.pending.get(String(f.requestId));
        if (!p || p.socket !== ws) continue;
        if (f._tag === 'Exit') {
          this.pending.delete(String(f.requestId)); clearTimeout(p.timer);
          if (f.exit?._tag === 'Success') p.resolve(f.exit.value);
          else { const error = new Error(`T3 ${p.method} failed: ${JSON.stringify(f.exit?.cause || f.exit)}`); error.rpcCause = f.exit?.cause; p.reject(error); }
        }
      }
    });
    ws.on('error', () => {});
    ws.on('close', () => {
      for (const [id, p] of this.pending) {
        if (p.socket !== ws) continue;
        clearTimeout(p.timer); p.reject(new Error('T3 connection closed')); this.pending.delete(id);
      }
      if (this.socket === ws) clearTimeout(this.renewal);
      this.revoke(sessionId).catch(() => {});
    });
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    // Refresh before the scoped session expires. Next poll reconnects without
    // changing the owned thread ids or creating another provider turn.
    this.renewal = setTimeout(() => ws.close(), 55 * 60000); this.renewal.unref?.();
  }
  async call(method, payload) {
    await this.connect();
    const id = String(++this.serial), socket = this.socket;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ _tag: 'Interrupt', requestId: id }));
        reject(new Error(`T3 ${method} timed out`));
      }, this.config.timeout_ms || 15000);
      this.pending.set(id, { resolve, reject, timer, method, socket });
      socket.send(JSON.stringify({ _tag: 'Request', id, tag: method, payload, headers: [] }), error => {
        if (!error) return;
        clearTimeout(timer); this.pending.delete(id); reject(error);
      });
    });
  }
  async revoke(id) {
    if (!id || !this.sessions.delete(id)) return;
    await exec(this.config.bin || 't3', ['auth', 'session', 'revoke', ...this.locationArgs, id], { timeout: 15000 });
  }
  async close() {
    this.closed = true; clearTimeout(this.renewal); this.socket?.close();
    await this.connecting?.catch(() => {});
    await Promise.allSettled([...this.sessions].map(id => this.revoke(id)));
  }
  projection(threadId) { return this.call('orchestration.getThreadProjection', { threadId }); }
  interrupt(threadId, reason) { return this.call('orchestration.dispatchCommand', { type: 'thread.stop', commandId: randomUUID(), threadId, reason }); }
}

function selection(slot) {
  const t = slot.t3 || {};
  if (!t.provider || !t.model) throw new Error('t3 slot needs t3.provider (instance id) and t3.model');
  const runtime = t.runtime ?? 'full-access';
  // Installed T3 has no read-only execution mode. Never translate it into a mode
  // that can write. This check runs before any project/thread is created.
  if (!['full-access', 'approval-required', 'auto-accept-edits', 'auto'].includes(runtime)) throw new Error(`T3 does not support runtime '${runtime}'; read-only execution is unavailable in installed T3`);
  return { modelSelection: { instanceId: t.provider, model: t.model,
    options: [...(t.options || []), ...(t.effort ? [{ id: t.effort_option || (t.provider.startsWith('codex') ? 'reasoningEffort' : 'effort'), value: t.effort }] : [])] }, runtimeMode: runtime };
}

// Prefer the per-turn ledger; tokenUsage is a context snapshot, not a billable
// ledger. Never add snapshots across turns (that double-counts cached context).
function usage(projection) {
  const u = { cost_usd: null, tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0 };
  for (const turn of projection.providerTurns || []) {
    const t = turn.turnTokenUsage;
    if (!t || t.localCommand) continue;
    u.tokens_in += t.inputTokens || 0; u.tokens_out += t.outputTokens || 0;
    u.cache_read += t.cachedInputTokens || 0; u.cache_write += t.cacheCreationTokens || 0;
  }
  return u;
}

module.exports = { T3, selection, usage };
