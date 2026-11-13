// The project's agent room (the rooms server in rooms/, roomd on :3396): which room this board belongs to,
// the Chat tab's target, and the report the board posts there when a worker's attempt ends.
//
// board.json "room": { "id": "<room id>", "url": "http://127.0.0.1:3396/r/<id>/", "as": "<poster name>" }
// (url and as optional). Without it, the room comes from the `AGENT ROOM:` machine rule that
// `roomctl board-sync` writes. With neither, the board has no room: no Chat tab, no reports.

const RULE_TAG = 'AGENT ROOM:';
const DEFAULT_PORT = 3396;

// "my-garden_v2" -> "My Garden V2" (the same fallback the hub uses for an unnamed board).
const titleCase = id => String(id).split(/[-_\s]+/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ');

function normalize(id, url, as = null) {
  id = String(id || '').trim();
  if (!id) return null;
  let u = null;
  try { u = new URL(url || `http://127.0.0.1:${DEFAULT_PORT}/r/${encodeURIComponent(id)}/`); } catch { return null; }
  const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
  return {
    id,
    url: `${u.protocol}//${u.host}/r/${encodeURIComponent(id)}/`,
    port,
    // The board runs on the room server's machine: post over loopback when the URL names a host
    // (the rule carries the tailnet name, which the server also accepts, but loopback needs no DNS).
    api: `${u.protocol}//127.0.0.1:${port}`,
    as: as && String(as).trim() ? String(as).trim() : null,
  };
}

// The rule: AGENT ROOM: this project's chat room is `<id>` (http://<host>:<port>/r/<id>/), ...
function fromRule(rules) {
  const rule = (rules || []).find(r => typeof r === 'string' && r.startsWith(RULE_TAG));
  if (!rule) return null;
  const id = (rule.match(/`([^`]+)`/) || [])[1];
  const url = (rule.match(/\((https?:\/\/[^)\s]+\/r\/[^)\s]+)\)/) || [])[1];
  return id ? normalize(id, url) : null;
}

function resolve(cfg) {
  const r = cfg.room;
  if (r && typeof r === 'object' && r.id) return normalize(r.id, r.url, r.as);
  return fromRule(cfg.machine_rules);
}

// Who the board posts as: room.as, else the member name `roomctl board-sync` invites for the board
// (board.json "name", else the title-cased default_project, else "Board <port>", cut to a room name).
function posterName(cfg) {
  if (cfg.room_resolved && cfg.room_resolved.as) return cfg.room_resolved.as;
  const proj = cfg.default_project;
  const n = (typeof cfg.name === 'string' && cfg.name) || (proj ? titleCase(proj) : '') || `Board ${cfg.port ?? ''}`.trim();
  return n.replace(/[^A-Za-z0-9 ._-]/g, '').replace(/^[ ._-]+|[ ._-]+$/g, '').slice(0, 40) || 'Board';
}

// What an ended attempt amounts to, from the bounty as the dispatcher left it (after its own transitions).
function outcomeOf(b, { code = null, why = null, before = null } = {}) {
  if (!b) return 'bounty gone';
  const st = b.status;
  if (['review', 'approved', 'done'].includes(st)) return 'submitted';
  if (st === 'in_progress' && b.ci_status === 'running') return 'submitted, verifying';
  // The dispatcher blocks an in_progress bounty whose worker exited; read what it was before that.
  const prev = before || {};
  if (prev.status === 'in_progress' && prev.ci_status === 'fail') return 'verify failed';
  if (prev.status === 'ready') return 'failed (never ran bounty start)';
  if (prev.status === 'in_progress') {
    if (code != null && code !== 0 && code < 128) return `failed (exit ${code}, not submitted)`;
    return `exited without submitting${why ? ` (${why})` : ''}`;
  }
  if (st === 'blocked') {
    const note = (b.blocked_reason || '').replace(/[;,]?\s*\(?log \/\S+\)?/g, '').trim(); // log paths stay on the board
    return note ? `blocked: ${note.length > 160 ? note.slice(0, 157) + '...' : note}` : 'blocked';
  }
  if (st === 'ready') return 'requeued';
  return st;
}

// "@<Orchestrator> <Worker> (<slot>) finished #<id> <title>: <outcome>." [+ " <Worker> is idle: what's next?"]
function reportText({ orchestrator, worker, slot, id, title, outcome, idle }) {
  const t = String(title || '').trim();
  let s = `@${orchestrator} ${worker} (${slot}) finished #${id} ${t}: ${String(outcome).replace(/[.\s]+$/, '')}.`;
  if (idle) s += ` ${worker} is idle: what's next?`;
  return s;
}

class RoomClient {
  constructor(cfg, { timeoutMs = 5000, log = console } = {}) {
    this.cfg = cfg;
    this.room = cfg.room_resolved || null;
    this.timeoutMs = timeoutMs;
    this.log = log;
    this.admin = null; // the room's admin, when board.json names no orchestrator
    this.pending = new Set();
  }

  get enabled() { return !!this.room; }
  get as() { return posterName(this.cfg); }

  async call(method, sub, body) {
    const url = `${this.room.api}/api/r/${encodeURIComponent(this.room.id)}${sub ? '/' + sub : ''}`;
    const r = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json', 'X-Room-Request': '1' } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = { error: text }; }
    if (!r.ok) { const e = new Error(`${method} ${url}: ${r.status} ${data.error || text}`); e.status = r.status; e.body = data; throw e; }
    return data;
  }

  async orchestrator() {
    if (this.cfg.orchestrator) return this.cfg.orchestrator;
    if (!this.admin) this.admin = (await this.call('GET', '')).admin || null;
    return this.admin || 'orchestrator';
  }

  // Post as the board's member; the first post joins the room (invited by roomctl board-sync).
  async post(text) {
    const as = this.as;
    try { return await this.call('POST', 'post', { as, text }); }
    catch (e) {
      if (e.status !== 403 || !/not joined/.test(String(e.body && e.body.error))) throw e;
      await this.call('POST', 'join', { as });
      return this.call('POST', 'post', { as, text });
    }
  }

  // Fire and forget: a room that is down, refuses or times out is logged and never blocks the board.
  report(fields) {
    if (!this.enabled) return null;
    const p = (async () => {
      const text = reportText({ ...fields, orchestrator: fields.orchestrator || await this.orchestrator() });
      await this.post(text);
      return text;
    })().catch(e => { this.log.error(`[room] report to ${this.room.id} failed: ${e.message}`); return null; })
      .finally(() => this.pending.delete(p));
    this.pending.add(p);
    return p;
  }

  idle() { return Promise.all([...this.pending]); }
}

module.exports = { RULE_TAG, resolve, fromRule, normalize, posterName, outcomeOf, reportText, RoomClient, titleCase };
