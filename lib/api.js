// HTTP API. The actor comes from the X-Bounty-Actor header (the CLI sends $BOUNTY_SLOT for
// workers, 'orchestrator' otherwise); worker slots can't take orchestrator actions.
const express = require('express');
const fs = require('fs');
const path = require('path');
const { TransitionError } = require('./machine');
const { TIER_REWARDS, TIER_NAMES, BONUSES } = require('./board');

function readLogText(logPath, runner) {
  const raw = fs.readFileSync(logPath, 'utf8');
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.startsWith('{')) { if (line.trim()) out.push(line); continue; }
    let ev; try { ev = JSON.parse(line); } catch { out.push(line); continue; }
    if (ev.type === 'assistant' && ev.message) {
      for (const c of ev.message.content || []) {
        if (c.type === 'text') out.push(`[assistant] ${c.text}`);
        else if (c.type === 'tool_use') out.push(`[tool ${c.name}] ${JSON.stringify(c.input).slice(0, 600)}`);
      }
    } else if (ev.type === 'user' && ev.message) {
      for (const c of ev.message.content || []) {
        if (c.type === 'tool_result') {
          const t = Array.isArray(c.content) ? c.content.map(x => x.text || '').join('') : String(c.content || '');
          out.push(`  -> ${t.slice(0, 800).replace(/\n/g, '\n     ')}`);
        }
      }
    } else if (ev.type === 'result') {
      out.push(`[result] ${ev.subtype} cost $${ev.total_cost_usd} turns ${ev.num_turns} duration ${Math.round((ev.duration_ms || 0) / 1000)}s\n${ev.result || ''}`);
    } else if (ev.type === 'system') {
      out.push(`[system ${ev.subtype || ''}] model ${ev.model || ''}`);
    } else if (ev.type === 'item.completed' && ev.item) {
      const it = ev.item;
      if (it.type === 'agent_message') out.push(`[assistant] ${it.text}`);
      else if (it.type === 'command_execution') out.push(`[cmd] ${it.command}\n  -> exit ${it.exit_code} ${String(it.aggregated_output || '').slice(0, 800)}`);
      else if (it.type === 'reasoning') out.push(`[reasoning] ${String(it.text || '').slice(0, 400)}`);
      else out.push(`[${it.type}] ${JSON.stringify(it).slice(0, 400)}`);
    } else if (ev.type === 'turn.completed') {
      out.push(`[turn] usage ${JSON.stringify(ev.usage)}`);
    }
  }
  return out.join('\n');
}

// Animated Wasteland avatars for the slots and the Feb-2026 crew; others get a generated badge.
const AVATAR_ALIAS = {
  'opus-1': 'opus-leader', 'opus-2': 'opus-coder', 'opus-3': 'mac-research', 'opus-4': 'gemini-wsl',
  'sonnet-tester': 'sonnet-research', 'codex-1': 'codex-wsl', 'codex-2': 'haiku-research',
  'opus-wsl-1': 'opus-leader', 'codex-wsl-1': 'codex-wsl', 'sonnet-wsl-1': 'sonnet-coder', 'haiku-wsl-1': 'haiku-research',
  'gemini-wsl-1': 'gemini-wsl', 'test-agent-opus': 'opus-coder',
};
function avatarFor(id) {
  if (AVATAR_ALIAS[id]) return `/avatars/${AVATAR_ALIAS[id]}.gif`;
  const hue = [...String(id)].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#1a1a1a"/><rect x="3" y="3" width="94" height="94" fill="none" stroke="hsl(${hue},70%,50%)" stroke-width="4"/><text x="50" y="66" text-anchor="middle" font-family="monospace" font-size="48" font-weight="bold" fill="hsl(${hue},70%,55%)">${String(id)[0].toUpperCase()}</text></svg>`;
  return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
}
const withAvatar = a => ({ ...a, avatar_url: a.avatar_url || avatarFor(a.id) });

function makeApi(board, dispatcher) {
  const r = express.Router();
  const actorOf = req => String(req.get('X-Bounty-Actor') || req.body?.actor || 'orchestrator');
  const wrap = fn => (req, res) => {
    try {
      const out = fn(req, res);
      if (out && typeof out.then === 'function') {
        out.then(v => { if (!res.headersSent) res.json(v); }).catch(e => sendErr(res, e));
      } else if (!res.headersSent) res.json(out);
    } catch (e) { sendErr(res, e); }
  };
  const sendErr = (res, e) => {
    const code = e instanceof TransitionError ? e.code : 500;
    if (code === 500) console.error('[api]', e);
    res.status(code).json({ error: e.message });
  };
  const hb = req => { const id = Number(req.params.id); if (id) board.heartbeat(id); };

  // ---- state ----
  r.get('/state', wrap(() => ({
    paused: board.paused(), cap: board.cfg.concurrency_cap, running: dispatcher ? dispatcher.running() : 0,
    slots: dispatcher ? dispatcher.slotsState() : board.cfg.slots, leases: board.listLeases(), stats: board.stats(),
    stall_minutes: board.cfg.watchdog.stall_minutes, default_project: board.defaultProject(),
  })));
  r.post('/pause', wrap(req => board.setPaused(true, actorOf(req))));
  r.post('/resume', wrap(req => board.setPaused(false, actorOf(req))));

  // ---- projects ----
  r.get('/projects', wrap(() => board.listProjects()));
  r.post('/projects', wrap(req => { board.requireOrchestrator(actorOf(req), 'project edit'); return board.upsertProject(req.body); }));

  // ---- bounties ----
  r.get('/bounties/stats', wrap(() => {
    const s = board.stats();
    const agents = board.db.prepare('SELECT COUNT(*) c FROM agents').get().c;
    return { ...s, pending: s.backlog + s.ready, active_agents: dispatcher ? dispatcher.live.size : 0, total_agents: board.cfg.slots.length, all_agents: agents };
  }));
  r.get('/bounties', wrap(req => board.list(req.query)));
  r.post('/bounties', wrap(req => {
    const actor = actorOf(req);
    if (board.isWorker(actor)) throw new TransitionError('workers add work with split, not add', 403);
    const b = board.create(req.body, actor);
    return b;
  }));
  r.get('/bounties/:id', wrap(req => board.get(Number(req.params.id))));
  r.patch('/bounties/:id', wrap(req => { board.requireOrchestrator(actorOf(req), 'edit'); return board.update(Number(req.params.id), req.body, actorOf(req)); }));
  r.post('/bounties/:id/assign', wrap(req => board.assign(Number(req.params.id), req.body.slot || null, actorOf(req))));
  r.post('/bounties/:id/ready', wrap(req => board.ready(Number(req.params.id), actorOf(req), req.body.note)));
  r.post('/bounties/:id/backlog', wrap(req => board.backlog(Number(req.params.id), actorOf(req), req.body.note)));
  // start and progress also hand the worker its unread orchestrator notes (and mark them read).
  const withInbox = (id, actor, out) => ({ ...out, unread_notes: board.takeInbox(id, actor) });
  r.post('/bounties/:id/start', wrap(req => { const id = Number(req.params.id); const out = board.start(id, actorOf(req)); return withInbox(id, actorOf(req), out); }));
  r.post('/bounties/:id/notes', wrap(req => board.note(Number(req.params.id), req.body.text ?? req.body.note, actorOf(req))));
  r.get('/bounties/:id/notes', wrap(req => board.notes(Number(req.params.id), { unread: req.query.unread === '1' })));
  r.get('/bounties/:id/inbox', wrap(req => { const id = Number(req.params.id); board.need(id); return board.notes(id, { unread: true }); }));
  r.post('/bounties/:id/inbox', wrap(req => { const id = Number(req.params.id); board.need(id); board.heartbeat(id); return board.takeInbox(id, actorOf(req)); }));
  r.post('/bounties/:id/heartbeat', wrap(req => { hb(req); return { ok: true }; }));
  r.post('/bounties/:id/progress', wrap(req => { const id = Number(req.params.id); const out = board.progress(id, req.body.note, actorOf(req), { check: req.body.check || [], percent: req.body.percent ?? null }); return withInbox(id, actorOf(req), out); }));
  r.post('/bounties/:id/block', wrap(req => board.block(Number(req.params.id), req.body.reason, actorOf(req))));
  r.post('/bounties/:id/split', wrap(req => { hb(req); return board.split(Number(req.params.id), req.body, actorOf(req)); }));
  r.post('/bounties/:id/submit', wrap(req => board.submit(Number(req.params.id), { branch: req.body.branch, actor: actorOf(req) })));
  r.post('/bounties/:id/approve', wrap(req => board.approve(Number(req.params.id), actorOf(req), req.body.notes)));
  r.post('/bounties/:id/reject', wrap(req => board.reject(Number(req.params.id), req.body.notes, actorOf(req))));
  r.post('/bounties/:id/fail', wrap(req => board.fail(Number(req.params.id), req.body.reason, actorOf(req))));
  r.post('/bounties/:id/done', wrap(req => {
    const actor = actorOf(req);
    board.requireOrchestrator(actor, 'done');
    const out = board.checkMerged(Number(req.params.id), `merge-check (asked by ${actor})`);
    if (!out.done) throw new TransitionError(`not done: ${out.reason}. A bounty is done only when its commits are on main.`, 409);
    return out;
  }));
  r.post('/bounties/:id/kill', wrap(req => {
    board.requireOrchestrator(actorOf(req), 'kill');
    if (!dispatcher) throw new TransitionError('no dispatcher', 500);
    return dispatcher.kill(Number(req.params.id), req.body.reason || 'killed by orchestrator', actorOf(req));
  }));
  r.get('/next', wrap(req => ({ next: board.next(String(req.query.slot || '')) })));

  // ---- leases ----
  r.get('/leases', wrap(() => { board.expireLeases(); return board.listLeases(); }));
  r.post('/leases/:resource', wrap(req => {
    const b = req.body || {};
    if (b.bounty_id) board.heartbeat(Number(b.bounty_id));
    return board.acquireLease(req.params.resource, { bounty_id: b.bounty_id ? Number(b.bounty_id) : null, slot: b.slot || null, holder: b.holder || null, ttl_min: b.ttl_min, note: b.note });
  }));
  r.delete('/leases/:resource', wrap(req => {
    const b = req.body || {};
    const force = !!b.force && !board.isWorker(actorOf(req));
    return board.releaseLease(req.params.resource, { holder: b.holder || null, bounty_id: b.bounty_id ? Number(b.bounty_id) : null, force });
  }));

  // ---- logs ----
  r.get('/attempts/:id/log', (req, res) => {
    const a = board.db.prepare('SELECT * FROM attempts WHERE id = ?').get(Number(req.params.id));
    if (!a || !a.log_path || !fs.existsSync(a.log_path)) return res.status(404).type('text').send('no log');
    if (req.query.format === 'raw') return res.type('text').sendFile(a.log_path);
    try { res.type('text').send(readLogText(a.log_path, a.runner)); } catch (e) { res.status(500).type('text').send(e.message); }
  });
  r.get('/attempts/:id/prompt', (req, res) => {
    const a = board.db.prepare('SELECT * FROM attempts WHERE id = ?').get(Number(req.params.id));
    if (!a || !a.prompt_path || !fs.existsSync(a.prompt_path)) return res.status(404).type('text').send('no prompt');
    res.type('text').sendFile(a.prompt_path);
  });
  r.get('/bounties/:id/verify-log', (req, res) => {
    const b = board.raw(Number(req.params.id));
    if (!b || !b.ci_log || !fs.existsSync(b.ci_log)) return res.status(404).type('text').send('no verify log');
    res.type('text').sendFile(b.ci_log);
  });

  // ---- import ----
  r.post('/import/:source', wrap(req => {
    board.requireOrchestrator(actorOf(req), 'import');
    const importer = require('./importer');
    if (req.params.source !== 'tribulation') throw new TransitionError('known import sources: tribulation', 400);
    return importer.importTribulation(board, req.body || {});
  }));

  // ---- agents / leaderboard (the Wasteland pages) ----
  r.get('/agents', wrap(() => board.db.prepare('SELECT * FROM agents ORDER BY total_loot DESC').all().map(withAvatar)));
  r.get('/agents/leaderboard', wrap(() => board.db.prepare(`SELECT *,
      CASE WHEN (missions_completed + missions_failed) > 0
        THEN ROUND(CAST(missions_completed AS REAL) / (missions_completed + missions_failed) * 100, 1) ELSE 0 END AS success_rate,
      missions_completed + missions_failed AS total_missions
    FROM agents ORDER BY total_loot DESC`).all().map(withAvatar)));
  r.get('/agents/:id', wrap(req => {
    const a = board.db.prepare('SELECT * FROM agents WHERE id = ?').get(req.params.id);
    if (!a) throw new TransitionError('agent not found', 404);
    a.bounties = board.db.prepare('SELECT id, ticket_id, title, status FROM bounties WHERE claimed_by = ? OR assignee_slot = ? ORDER BY updated_at DESC LIMIT 20').all(a.id, a.id);
    return a;
  }));
  r.get('/tiers', wrap(() => ({ rewards: TIER_REWARDS, names: TIER_NAMES, bonuses: BONUSES })));

  return r;
}

module.exports = { makeApi, readLogText, avatarFor };
