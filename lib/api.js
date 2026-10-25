// HTTP API. The actor comes from the X-Bounty-Actor header (the CLI sends $BOUNTY_SLOT for
// workers, 'orchestrator' otherwise); worker slots can't take orchestrator actions.
const express = require('express');
const fs = require('fs');
const path = require('path');
const { TransitionError } = require('./machine');
const { TIER_REWARDS, TIER_NAMES, BONUSES } = require('./board');
const { Live, renderText } = require('./live');

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

// Animated Wasteland avatars for the slots; any other slot gets a generated badge.
const AVATAR_ALIAS = {
  'opus-1': 'opus-leader', 'opus-2': 'opus-coder', 'opus-3': 'mac-research', 'opus-4': 'gemini-wsl',
  'sonnet-tester': 'sonnet-research', 'codex-1': 'codex-wsl', 'codex-2': 'haiku-research',
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
  const live = new Live(board, dispatcher);
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
  r.get('/state', wrap(() => {
    const led = new Map(board.ledger().slots.map(s => [s.id, s]));
    const slots = (dispatcher ? dispatcher.slotsState() : board.cfg.slots).map(s => {
      const l = led.get(s.id) || {};
      return { ...s, record: { total_loot: l.total_loot || 0, missions_completed: l.missions_completed || 0, missions_failed: l.missions_failed || 0, streak: l.streak || 0, cost_usd: l.cost_usd || 0 } };
    });
    return {
      paused: board.paused(), cap: board.cfg.concurrency_cap, running: dispatcher ? dispatcher.running() : 0,
      slots, leases: board.listLeases(), stats: board.stats(),
      stall_minutes: board.cfg.watchdog.stall_minutes, default_project: board.defaultProject(),
    };
  }));
  // Live: what every slot is doing right now, verifies/CI stages, locks, tester, queue (read-only).
  r.get('/live', wrap(async (req, res) => {
    const L = await live.snapshot();
    if (req.query.format === 'text') { res.type('text').send(renderText(L) + '\n'); return; }
    return L;
  }));
  r.post('/pause', wrap(req => board.setPaused(true, actorOf(req))));
  r.post('/resume', wrap(req => board.setPaused(false, actorOf(req))));

  // ---- projects ----
  r.get('/projects', wrap(() => board.listProjects()));
  r.post('/projects', wrap(req => { board.requireOrchestrator(actorOf(req), 'project edit'); return board.upsertProject(req.body); }));

  // ---- bounties ----
  r.get('/bounties/stats', wrap(() => {
    const s = board.stats();
    return { ...s, pending: s.backlog + s.ready, active_agents: dispatcher ? dispatcher.live.size : 0, total_agents: board.cfg.slots.length };
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
  r.post('/bounties/:id/close-merged', wrap(req => board.closeMerged(Number(req.params.id), {
    commits: req.body.commits ?? req.body.commit, evidence: req.body.evidence, actor: actorOf(req),
  })));
  r.post('/bounties/:id/kill', wrap(req => {
    board.requireOrchestrator(actorOf(req), 'kill');
    if (!dispatcher) throw new TransitionError('no dispatcher', 500);
    return dispatcher.kill(Number(req.params.id), req.body.reason || 'killed by orchestrator', actorOf(req));
  }));
  // ---- notes from the human (the hub's reply box and Done button) ----
  // Writes need X-Board-Request: 1 and a JSON body: a page on another origin can't send either
  // without a CORS preflight, and the board answers no preflight. Workers can't pose as the human.
  const boardRequest = req => {
    if (req.get('X-Board-Request') !== '1' || !req.is('application/json')) {
      throw new TransitionError('this endpoint needs the header X-Board-Request: 1 and Content-Type: application/json', 403);
    }
    if (board.isWorker(actorOf(req))) throw new TransitionError('workers cannot send notes as the human', 403);
  };
  r.post('/bounties/:id/human-notes', wrap((req, res) => {
    boardRequest(req);
    const b = req.body || {};
    const out = board.humanNote(Number(req.params.id), { text: b.text, from: b.from, unblock: b.unblock === true });
    const body = { note: out.note, bounty: out.bounty };
    if (out.refused) { res.status(409).json({ error: out.refused, note_stored: true, ...body }); return; }
    if (b.unblock === true) body.unblocked = out.unblocked;
    return body;
  }));
  r.get('/human-notes', wrap(req => board.humanNotes({ unread: req.query.unread === '1' })));
  r.post('/human-notes/read', wrap(req => {
    boardRequest(req);
    const ids = (req.body || {}).ids;
    if (!Array.isArray(ids)) throw new TransitionError('ids must be an array of note ids', 400);
    return board.markHumanRead(ids);
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
    if (req.params.source !== 'backlog') throw new TransitionError('known import sources: backlog', 400);
    return importer.importBacklog(board, req.body || {});
  }));

  // ---- agents / leaderboard (the Wasteland pages) ----
  // Agents are the configured slots only; every number is derived from verified work
  // (board.ledger()), never from a stored counter.
  const agentsView = () => {
    const live = new Map((dispatcher ? dispatcher.slotsState() : []).map(s => [s.id, s]));
    const rows = new Map(board.db.prepare('SELECT * FROM agents').all().map(a => [a.id, a]));
    return board.ledger().slots.map(l => {
      const cfg = board.slot(l.id) || {};
      const row = rows.get(l.id) || {};
      const ls = live.get(l.id);
      const working = ls && ls.state === 'working';
      const total = l.missions_completed + l.missions_failed;
      return withAvatar({
        id: l.id, name: row.name || l.id.toUpperCase(), class: row.class || 'Scavenger', avatar_url: row.avatar_url || null,
        runner: cfg.runner, model: cfg.model, effort: cfg.effort,
        status: working ? 'active' : ls && ls.state === 'spawning' ? 'active' : 'idle',
        current_directive: working && ls.bounty ? `#${ls.bounty.id} ${ls.bounty.title}` : null,
        total_loot: l.total_loot, level: l.level, missions_completed: l.missions_completed, missions_failed: l.missions_failed,
        streak: l.streak, best_streak: l.best_streak, cost_usd: Math.round(l.cost_usd * 100) / 100, attempts: l.attempts,
        tokens_in: l.tokens_in, tokens_out: l.tokens_out, last_done_at: l.last_done_at,
        success_rate: total > 0 ? Math.round(l.missions_completed / total * 1000) / 10 : 0, total_missions: total,
        cost_per_done: l.missions_completed ? Math.round(l.cost_usd / l.missions_completed * 100) / 100 : null,
        dones: l.dones,
      });
    }).sort((x, y) => y.total_loot - x.total_loot || y.missions_completed - x.missions_completed || x.cost_usd - y.cost_usd || x.id.localeCompare(y.id));
  };
  // ---- the agent manifest (run/agents.json): processes the board may stop ----
  // A worker may register what it started for its own bounty; anything else is the orchestrator's.
  r.post('/agents/spawned', wrap(req => {
    const actor = actorOf(req), b = req.body || {};
    if (board.isWorker(actor)) {
      if (b.kind === 'orchestrator') throw new TransitionError('a worker cannot register an orchestrator', 403);
      if (b.bounty == null) throw new TransitionError('a worker registers agents with --bounty (its own)', 403);
    }
    return board.agents.register({ pid: b.pid, name: b.name, kind: b.kind || 'worker', bounty: b.bounty ?? null, by: actor });
  }));
  r.get('/agents/spawned', wrap(() => board.agents.list()));
  r.post('/agents/cleanup', wrap(req => {
    const actor = actorOf(req), b = req.body || {};
    if (b.kill) board.requireOrchestrator(actor, 'cleanup --kill');
    return board.agents.cleanup({ kill: !!b.kill, all: !!b.all, orchestrators: !!b.orchestrators, actor });
  }));
  r.get('/agents', wrap(() => agentsView()));
  r.get('/agents/leaderboard', wrap(() => agentsView()));
  // Registering an agent: only a configured slot id is accepted; anything else is refused.
  r.post('/agents', wrap(req => {
    const id = String((req.body || {}).id || '').trim();
    if (!id) throw new TransitionError('agent needs an id (a configured slot)', 400);
    board.registerAgent(id);
    return agentsView().find(a => a.id === id);
  }));
  r.get('/agents/:id', wrap(req => {
    if (!board.slot(req.params.id)) throw new TransitionError(`agent '${req.params.id}' not found (agents are the configured slots)`, 404);
    const a = agentsView().find(x => x.id === req.params.id);
    a.bounties = board.db.prepare('SELECT id, ticket_id, title, status FROM bounties WHERE assignee_slot = ? OR credited_slot = ? ORDER BY updated_at DESC LIMIT 20').all(a.id, a.id);
    a.recent_attempts = board.db.prepare("SELECT id, bounty_id, started_at, ended_at, outcome, cost_usd FROM attempts WHERE kind = 'worker' AND slot = ? ORDER BY id DESC LIMIT 20").all(a.id);
    return a;
  }));
  r.get('/tiers', wrap(() => ({ rewards: TIER_REWARDS, names: TIER_NAMES, bonuses: BONUSES })));

  return r;
}

module.exports = { makeApi, readLogText, avatarFor };
