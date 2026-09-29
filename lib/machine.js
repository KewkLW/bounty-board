// The bounty status machine. Every status change in the board goes through transition().
//
//   backlog -> ready -> in_progress -> review -> approved -> done
//   plus blocked (with a reason) and failed.
//
// Three edges are "guarded": only a specific internal path may take them, never a caller's say-so.
//   -> review    only through the submit gates (branch, real diff, verify command)
//   -> approved  only from the reviewer or the orchestrator (never the worker that did the work)
//   -> done      only from the merge check (the recorded commits are reachable from main), or from
//                close-merged: the orchestrator names the commit(s) and the board checks they are on
//                main. That is the one path to done from outside approved (work done off the board).
const { now, addEvent, STATUSES } = require('./db');

const TRANSITIONS = {
  backlog: ['ready', 'blocked', 'failed'],
  ready: ['backlog', 'in_progress', 'blocked', 'failed'],
  in_progress: ['review', 'blocked', 'failed', 'ready', 'backlog'],
  review: ['approved', 'ready', 'blocked', 'failed'],
  approved: ['done', 'ready', 'blocked'],
  blocked: ['backlog', 'ready', 'in_progress', 'failed'],
  failed: ['backlog', 'ready'],
  done: [],
};

const GUARDS = {
  review: ['gates'],
  approved: ['reviewer', 'orchestrator'],
  done: ['merge-check', 'close-merged'],
};

// close-merged may finish a bounty from any open status (its work was merged outside the board).
const CLOSE_MERGED_FROM = ['backlog', 'ready', 'in_progress', 'review', 'approved', 'blocked'];

class TransitionError extends Error {
  constructor(msg, code = 409) { super(msg); this.code = code; }
}

function canTransition(from, to) {
  return (TRANSITIONS[from] || []).includes(to);
}

// patch: extra columns to set in the same UPDATE. via: which internal path is asking.
function transition(db, id, to, { actor = null, via = null, note = null, patch = {} } = {}) {
  if (!STATUSES.includes(to)) throw new TransitionError(`unknown status '${to}'`, 400);
  const b = db.prepare('SELECT id, status FROM bounties WHERE id = ?').get(id);
  if (!b) throw new TransitionError(`bounty ${id} not found`, 404);
  if (b.status === to && to !== 'blocked') return b; // idempotent (blocked may update its reason)
  const closeMerged = to === 'done' && via === 'close-merged' && CLOSE_MERGED_FROM.includes(b.status);
  if (b.status !== to && !closeMerged && !canTransition(b.status, to)) {
    throw new TransitionError(`bounty ${id}: ${b.status} -> ${to} is not allowed`);
  }
  const guard = GUARDS[to];
  if (guard && !guard.includes(via)) {
    throw new TransitionError(`bounty ${id}: '${to}' can only be reached via ${guard.join(' or ')} (not by request)`, 403);
  }
  if (to === 'blocked' && !(patch.blocked_reason || note)) {
    throw new TransitionError('blocked needs a reason', 400);
  }
  const t = now();
  const cols = { ...patch, status: to, updated_at: t, [`${to}_at`]: t };
  if (to === 'blocked') cols.blocked_reason = patch.blocked_reason || note;
  else if (!('blocked_reason' in patch)) cols.blocked_reason = null;
  const keys = Object.keys(cols);
  db.prepare(`UPDATE bounties SET ${keys.map(k => `${k} = @${k}`).join(', ')} WHERE id = @__id`)
    .run({ ...cols, __id: id });
  addEvent(db, { bounty_id: id, actor, kind: 'status', from_status: b.status, to_status: to, note: note || cols.blocked_reason || null });
  return db.prepare('SELECT * FROM bounties WHERE id = ?').get(id);
}

module.exports = { TRANSITIONS, GUARDS, CLOSE_MERGED_FROM, transition, canTransition, TransitionError };
