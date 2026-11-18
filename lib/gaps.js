// Gap requests: the ledger of gaps workers found and what the orchestrator did about them.
//
// A worker never creates work and never acts on a gap it finds outside its bounty. It poses the gap
// to the orchestrator (`bounty gap "what is missing" --why "why it matters" [--suggest "..."]`): an
// open row here, a 'gap' event on its bounty, a line to the orchestrator in the project's room and
// the open count in the orchestrator's presence (bounty orchestrator / status / live). Filing a gap
// never touches the bounty's scope or status.
//
// The orchestrator decides every gap (`bounty gap-decide ID --decision now|later|rejected --action
// "what was done" --why "reason" [--bounty NEW_ID]`): what it did and why are required, and `now`
// names the bounty that fills it. The Status page lists the whole ledger, open gaps first.
const { now, addEvent } = require('./db');
const { redact } = require('./redact');
const { TransitionError } = require('./machine');

const DECISIONS = ['now', 'later', 'rejected'];
const TEXT_CAP = 2000;

// Required free text: trimmed, redacted (worker-written text ends up on pages and in the room), capped.
function text(v, what, { required = true } = {}) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) {
    if (required) throw new TransitionError(`${what} is required`, 400);
    return null;
  }
  return redact(s).slice(0, TEXT_CAP);
}

class Gaps {
  constructor(board) {
    this.board = board;
    this.db = board.db;
  }

  row(id) { return this.db.prepare('SELECT * FROM gaps WHERE id = ?').get(Number(id)) || null; }
  need(id) {
    const r = this.row(id);
    if (!r) throw new TransitionError(`gap ${id} not found`, 404);
    return r;
  }
  openCount() { return this.db.prepare("SELECT COUNT(*) c FROM gaps WHERE status = 'open'").get().c; }

  // A worker (on its own bounty) or the orchestrator poses a gap. Nothing about the bounty changes.
  file(bountyId, { gap, why, suggestion } = {}, actor = 'orchestrator') {
    const b = this.board.need(bountyId);
    if (this.board.isWorker(actor) && b.assignee_slot !== actor) {
      throw new TransitionError(`bounty ${b.id} is not your bounty (${b.assignee_slot ? `assigned to ${b.assignee_slot}` : 'unassigned'}); file gaps from the bounty you were given`, 403);
    }
    const row = { gap: text(gap, 'the gap (what is missing)'), why: text(why, '--why (why it matters)'), suggestion: text(suggestion, 'suggestion', { required: false }) };
    const r = this.db.prepare(`INSERT INTO gaps (bounty_id, from_actor, created_at, gap, why, suggestion, status)
      VALUES (?, ?, ?, ?, ?, ?, 'open')`).run(b.id, String(actor), now(), row.gap, row.why, row.suggestion);
    const id = Number(r.lastInsertRowid);
    addEvent(this.db, { bounty_id: b.id, actor, kind: 'gap', note: `gap #${id} posed to the orchestrator (not acted on): ${row.gap}` });
    this.announce({ id, bounty: b.id, actor });
    this.board.changed('gap', { id, bounty: b.id });
    this.board.changed('bounty', { id: b.id });
    this.board.presence.status(); // the open count reaches the registry / hub right away
    return this.view(this.row(id));
  }

  // The orchestrator's decision: what it did and why, and for 'now' the bounty that fills the gap.
  decide(gapId, { decision, action, reason, bounty = null } = {}, actor = 'orchestrator') {
    this.board.requireOrchestrator(actor, 'gap-decide');
    const g = this.need(gapId);
    if (!DECISIONS.includes(decision)) throw new TransitionError(`--decision must be one of ${DECISIONS.join(', ')}`, 400);
    const act = text(action, '--action (what was done)');
    const why = text(reason, '--why (the reason)');
    let newId = null;
    if (bounty != null && bounty !== '') {
      newId = Number(String(bounty).replace(/^#/, ''));
      if (!Number.isInteger(newId) || newId <= 0) throw new TransitionError(`--bounty must be a bounty id, not '${bounty}'`, 400);
      if (!this.board.raw(newId)) throw new TransitionError(`--bounty ${newId}: bounty ${newId} not found`, 400);
    }
    if (decision === 'now' && !newId) throw new TransitionError('a "now" decision needs --bounty NEW_ID (the bounty that fills the gap)', 400);
    const was = g.status === 'decided' ? ` (was ${g.decision}${g.new_bounty_id ? ' #' + g.new_bounty_id : ''})` : '';
    const t = now();
    this.db.prepare(`UPDATE gaps SET status = 'decided', decision = ?, action = ?, reason = ?, new_bounty_id = ?, decided_by = ?, decided_at = ? WHERE id = ?`)
      .run(decision, act, why, newId, String(actor), t, g.id);
    addEvent(this.db, { bounty_id: g.bounty_id, actor, kind: 'gap',
      note: `gap #${g.id} decided ${was ? 'again ' : ''}by ${actor}: ${decision}${newId ? ` -> #${newId}` : ''}${was}; action: ${act}; why: ${why}` });
    this.board.changed('gap', { id: g.id, bounty: g.bounty_id });
    this.board.changed('bounty', { id: g.bounty_id });
    this.board.presence.status();
    return this.view(this.row(g.id));
  }

  // The ledger: open gaps first (oldest first, the queue), then decided ones (newest decision first).
  list({ status = null, bounty = null } = {}) {
    const where = [], params = {};
    if (status) { where.push('g.status = @status'); params.status = status; }
    if (bounty != null) { where.push('g.bounty_id = @bounty'); params.bounty = Number(bounty); }
    const rows = this.db.prepare(`SELECT g.id FROM gaps g ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY CASE g.status WHEN 'open' THEN 0 ELSE 1 END,
        CASE g.status WHEN 'open' THEN g.created_at END ASC,
        g.decided_at DESC, g.id DESC`).all(params);
    return rows.map(r => this.view(this.row(r.id)));
  }

  // A row plus who asked (slot name), the bounty it came from and the bounty it became.
  view(g) {
    if (!g) return null;
    const b = this.board.raw(g.bounty_id);
    const nb = g.new_bounty_id ? this.board.raw(g.new_bounty_id) : null;
    const s = this.board.slot(g.from_actor);
    return {
      ...g,
      from_name: s ? (s.name || s.id) : g.from_actor,
      from_worker: !!s,
      bounty: b ? { id: b.id, title: b.title, status: b.status } : null,
      new_bounty: nb ? { id: nb.id, title: nb.title, status: nb.status } : null,
    };
  }

  // One short line to the orchestrator in the project's room. No worker text goes in (the gap itself
  // is read with `bounty gaps`), the same rule as incident lines.
  announce({ id, bounty, actor }) {
    const room = this.board.room;
    if (!room || !room.enabled) return null;
    const s = this.board.slot(actor);
    return room.gap({ id, bounty, worker: s ? (s.name || s.id) : actor });
  }
}

module.exports = { Gaps, DECISIONS };
