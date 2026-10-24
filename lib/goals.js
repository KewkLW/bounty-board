// Goal roads for the hub: the same rules as public/status.js, computed on the server.
// A goal is "reached" only when the orchestrator records it (state "reached") or its gate bounty is
// done; a road that is all done without that is "road done, exit test not recorded". The first open
// goal is Now. Keep this in step with status.js (a themed board symlinks that file, so it stays as is).
const STALE_HOURS = 3;

function roadOf(g, byId, all) {
  if (Array.isArray(g.road) && g.road.length) return g.road.map(x => byId.get(Number(typeof x === 'object' && x ? x.id : x)) || null);
  if (g.road_prefix) return all.filter(b => String(b.title || '').startsWith(g.road_prefix)).sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }));
  return [];
}

const slim = b => (b ? { id: b.id, title: b.title, status: b.status } : null);

function computeGoals(goals, all) {
  if (!Array.isArray(goals)) return null;
  const byId = new Map(all.map(b => [b.id, b]));
  let nowMarked = false;
  return goals.map(g => {
    const road = roadOf(g, byId, all);
    const done = road.filter(b => b && b.status === 'done').length;
    const gate = g.gate ? byId.get(Number(g.gate)) || null : null;
    let state = g.state || 'open';
    if (state !== 'closed' && gate && gate.status === 'done') state = 'reached';
    const roadDone = road.length > 0 && done === road.length;
    let label = { reached: 'Reached', closed: 'Not opened', open: 'Open' }[state] || state;
    if (state === 'open' && roadDone) label = 'Road done, exit test not recorded';
    const now = state === 'open' && !nowMarked;
    if (now) nowMarked = true;
    return {
      id: g.id ?? null, name: g.name ?? null, goal: g.goal ?? null, test: g.test ?? null, when: g.when ?? null, evidence: g.evidence ?? null,
      state, label, now, road_done: roadDone,
      done, total: road.length, pct: road.length ? Math.round(100 * done / road.length) : 0,
      gate: slim(gate),
      road: road.map(slim),
      working: road.filter(b => b && b.status === 'in_progress').map(b => b.id),
      stuck: road.filter(b => b && (b.status === 'blocked' || b.status === 'failed')).map(b => b.id),
    };
  });
}

function noteView(n, now = Date.now()) {
  if (!n || typeof n !== 'object') return null;
  const t = n.written_at ? new Date(n.written_at).getTime() : NaN;
  return {
    headline: n.headline ?? null,
    body: Array.isArray(n.body) ? n.body : [],
    written_at: n.written_at ?? null,
    stale: Number.isFinite(t) ? now - t > STALE_HOURS * 3600e3 : false,
  };
}

module.exports = { computeGoals, noteView, STALE_HOURS };
