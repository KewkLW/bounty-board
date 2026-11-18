// Status page: the project's goals, the orchestrator's latest note, and what is moving now.
// Reads the board API live plus two files the orchestrator keeps in the board's public dir:
//   status-goals.json  { "goals": [ { id, name, goal, test, state, when, evidence, gate, road | road_prefix } ] }
//   status-notes.json  { "written_at", "headline", "body": ["paragraph", ...] }
// A goal is "reached" only when the orchestrator records it (state "reached" with evidence) or its gate
// bounty is done. A road that is all done without that is shown as waiting on its exit test.
// Gaps: the gap ledger (GET /api/gaps): every gap a worker posed, the orchestrator's decision, what it
// did, why, and the bounty it became; open gaps first. A themed status.html without a #st-gaps slot
// gets the section added before "Finished"; a board without the gaps API shows nothing for it.
(() => {
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const md = s => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>');
  const ago = t => {
    if (!t) return '';
    const s = Math.max(0, (Date.now() - new Date(t).getTime()) / 1000);
    if (s < 90) return 'just now';
    if (s < 5400) return `${Math.round(s / 60)} min ago`;
    if (s < 129600) return `${Math.round(s / 3600)} h ago`;
    return `${Math.round(s / 86400)} d ago`;
  };
  const STALE_HOURS = 3;
  const OPEN = ['backlog', 'ready', 'in_progress', 'review', 'approved', 'blocked'];

  async function get(url) {
    try {
      const r = await fetch(url, { cache: 'no-store' });
      return r.ok ? await r.json() : null;
    } catch { return null; }
  }

  function chip(b) {
    if (!b) return '<span class="st-chip st-missing">?</span>';
    return `<a class="st-chip st-${esc(b.status)}" href="/#b${b.id}" title="#${b.id} ${esc(b.title)} (${esc(b.status)})">#${b.id}</a>`;
  }

  function roadOf(g, byId, all) {
    if (Array.isArray(g.road) && g.road.length) return g.road.map(x => byId.get(Number(typeof x === 'object' ? x.id : x)));
    if (g.road_prefix) return all.filter(b => b.title.startsWith(g.road_prefix)).sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }));
    return [];
  }

  function renderGoals(goals, byId, all) {
    if (!goals) return '<div class="st-panel st-empty">No goals file yet. The orchestrator writes <code>status-goals.json</code> in this board\'s public folder.</div>';
    let nowMarked = false;
    return goals.map(g => {
      const road = roadOf(g, byId, all);
      const done = road.filter(b => b && b.status === 'done').length;
      const gate = g.gate ? byId.get(Number(g.gate)) : null;
      let state = g.state || 'open';
      if (state !== 'closed' && gate && gate.status === 'done') state = 'reached';
      const roadDone = road.length > 0 && done === road.length;
      let label = { reached: 'Reached', closed: 'Not opened', open: 'Open' }[state] || state;
      if (state === 'open' && roadDone) label = 'Road done, exit test not recorded';
      const now = state === 'open' && !nowMarked;
      if (now) nowMarked = true;
      const pct = road.length ? Math.round(100 * done / road.length) : 0;
      const working = road.filter(b => b && b.status === 'in_progress');
      const blocked = road.filter(b => b && (b.status === 'blocked' || b.status === 'failed'));
      return `<div class="st-panel st-goal st-goal-${esc(state)}${now ? ' st-now' : ''}">
        <div class="st-goal-head">
          <span class="st-goal-id">${esc(g.id)}</span>
          <span class="st-goal-name">${esc(g.name)}</span>
          ${now ? '<span class="st-badge st-badge-now">Now</span>' : ''}
          <span class="st-badge st-badge-${esc(state)}">${esc(label)}</span>
        </div>
        ${g.goal ? `<div class="st-goal-goal">${md(g.goal)}</div>` : ''}
        ${g.test ? `<div class="st-goal-test"><b>Done when:</b> ${md(g.test)}</div>` : ''}
        ${state === 'reached' && (g.when || g.evidence) ? `<div class="st-goal-ev"><b>Reached${g.when ? ' ' + esc(g.when) : ''}:</b> ${md(g.evidence || (gate ? 'gate #' + gate.id + ' done' : ''))}</div>` : ''}
        ${road.length ? `<div class="st-bar"><span style="width:${pct}%"></span></div>
          <div class="st-road-meta">${done} of ${road.length} done${working.length ? ` · working: ${working.map(b => '#' + b.id).join(', ')}` : ''}${blocked.length ? ` · <span class="st-bad">stuck: ${blocked.map(b => '#' + b.id).join(', ')}</span>` : ''}${gate ? ` · gate ${chip(gate)}` : ''}</div>
          <div class="st-road">${road.map(b => b ? `<div class="st-step st-${esc(b.status)}">${chip(b)} <span>${esc(b.title)}</span> <i>${esc(b.status.replace('_', ' '))}</i></div>` : '').join('')}</div>` : ''}
      </div>`;
    }).join('');
  }

  function renderNote(n) {
    if (!n) return '<div class="st-panel st-empty">No note from the orchestrator yet.</div>';
    const stale = n.written_at && (Date.now() - new Date(n.written_at).getTime()) > STALE_HOURS * 3600e3;
    return `<div class="st-panel st-note">
      ${stale ? `<div class="st-stale">This note is ${esc(ago(n.written_at))}. The orchestrator should update it every round.</div>` : ''}
      ${n.headline ? `<div class="st-headline">${md(n.headline)}</div>` : ''}
      ${(n.body || []).map(p => `<p>${md(p)}</p>`).join('')}
    </div>`;
  }

  const DECISION = { now: 'Now', later: 'Later', rejected: 'Rejected' };
  const day = t => {
    if (!t) return '';
    const d = new Date(t);
    return isNaN(d) ? esc(t) : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  };

  // The Gaps section's container: the page's own, or one added before the last section (Finished).
  function gapsBox() {
    let box = $('st-gaps');
    if (box) return box;
    const wrap = document.querySelector('.st-wrap');
    if (!wrap) return null;
    const sec = document.createElement('section');
    sec.id = 'st-gaps-section';
    sec.innerHTML = '<h2>Gaps <small id="st-gcount">gaps workers posed, what the orchestrator decided and why</small></h2><div id="st-gaps" class="st-list"></div>';
    const recent = $('st-recent');
    const before = recent ? recent.closest('section') : null;
    wrap.insertBefore(sec, before && before.parentNode === wrap ? before : null);
    return $('st-gaps');
  }

  // A bounty chip, or a grey #id when this page does not know the bounty.
  const ref = (b, id) => (b && b.status ? chip(b) : `<span class="st-chip st-missing">#${esc(id)}</span>`);

  function renderGap(g, byId) {
    const from = byId.get(g.bounty_id) || g.bounty || { id: g.bounty_id };
    const into = g.new_bounty_id ? (byId.get(g.new_bounty_id) || g.new_bounty || { id: g.new_bounty_id }) : null;
    const open = g.status === 'open';
    const who = `${esc(g.from_name || g.from_actor)}${g.from_name && g.from_name !== g.from_actor ? ` <span class="st-gap-slot">${esc(g.from_actor)}</span>` : ''}`;
    return `<div class="st-panel st-gap${open ? ' st-gap-open' : ` st-gap-${esc(g.decision)}`}" data-gap="${esc(g.id)}">
      <div class="st-gap-head">
        <span class="st-gap-id">GAP #${esc(g.id)}</span>
        <span class="st-badge st-badge-gap-${open ? 'open' : esc(g.decision)}">${open ? 'Open: waiting on the orchestrator' : esc(DECISION[g.decision] || g.decision)}</span>
        <span class="st-gap-when">${day(g.created_at)}</span>
      </div>
      <div class="st-gap-who">asked by <b>${who}</b> on ${ref(from, g.bounty_id)} ${from.title ? esc(from.title) : ''}</div>
      <div class="st-gap-text">${esc(g.gap)}</div>
      <dl class="st-gap-dl">
        <dt>Why it matters</dt><dd>${esc(g.why)}</dd>
        ${g.suggestion ? `<dt>Suggested</dt><dd>${esc(g.suggestion)}</dd>` : ''}
        ${open ? '' : `<dt>Decision</dt><dd>${esc(DECISION[g.decision] || g.decision)} · ${esc(g.decided_by || '')}${g.decided_at ? ', ' + day(g.decided_at) : ''}</dd>
        <dt>Action</dt><dd>${esc(g.action)}</dd>
        <dt>Why</dt><dd>${esc(g.reason)}</dd>
        <dt>Became</dt><dd>${into ? `${ref(into, g.new_bounty_id)} ${into.title ? esc(into.title) : ''}` : '<span class="st-muted">no bounty</span>'}</dd>`}
      </dl>
    </div>`;
  }

  function renderGaps(gaps, byId) {
    const box = gapsBox();
    if (!box) return;
    if (!Array.isArray(gaps)) { box.innerHTML = '<div class="st-panel st-empty">This board has no gap ledger yet.</div>'; return; }
    const open = gaps.filter(g => g.status === 'open');
    const decided = gaps.filter(g => g.status !== 'open');
    const count = $('st-gcount');
    if (count) count.textContent = gaps.length ? `${open.length} open · ${decided.length} decided` : 'gaps workers posed, what the orchestrator decided and why';
    box.innerHTML = gaps.length ? [...open, ...decided].map(g => renderGap(g, byId)).join('')
      : '<div class="st-panel st-empty">No gaps posed. A worker that finds one files it with <code>bounty gap</code>; the orchestrator decides it here.</div>';
  }

  async function load() {
    const [stats, all, live, state, goalsFile, notes, gaps] = await Promise.all([
      get('/api/bounties/stats'), get('/api/bounties'), get('/api/live'), get('/api/state'),
      get('/status-goals.json'), get('/status-notes.json'), get('/api/gaps'),
    ]);
    if (!all) { $('st-updated').textContent = 'board unreachable'; return; }
    const byId = new Map(all.map(b => [b.id, b]));
    const s = stats || {};
    $('st-stats').innerHTML = [
      ['done', s.done], ['working', s.in_progress], ['ready', s.ready], ['review', (s.review || 0) + (s.approved || 0)],
      ['blocked', s.blocked], ['backlog', s.backlog], ['spent', s.total_cost_usd != null ? '$' + Math.round(s.total_cost_usd) : null],
    ].filter(([, v]) => v != null).map(([k, v]) => `<span class="st-stat"><b>${esc(v)}</b> ${k}</span>`).join('');

    $('st-note').innerHTML = renderNote(notes);
    if (notes?.written_at) $('st-notewhen').textContent = ago(notes.written_at);
    $('st-goals').innerHTML = renderGoals(goalsFile?.goals, byId, all);
    try { renderGaps(gaps, byId); } catch (e) { console.error('[status] gaps', e); }

    const names = new Map((state?.slots || []).map(x => [x.id, x.name]));
    const slots = (live?.slots || []).filter(x => x.bounty);
    $('st-running').innerHTML = slots.length ? slots.map(x => `<div class="st-panel st-row">
        ${chip(byId.get(x.bounty.id) || x.bounty)} <b>${esc(names.get(x.id) || x.name || x.id)}</b> ${esc(x.bounty.title)}
        <div class="st-sub">${esc(x.pipeline?.label || x.bounty.status)}${x.progress?.note ? ' · ' + esc(x.progress.note) + ' (' + esc(ago(x.progress.at)) + ')' : ''}</div>
      </div>`).join('') : '<div class="st-panel st-empty">No worker running.</div>';

    const attention = all.filter(b => ['review', 'approved', 'blocked'].includes(b.status));
    $('st-attention').innerHTML = attention.length ? attention.map(b => `<div class="st-panel st-row">
        ${chip(b)} ${esc(b.title)}
        <div class="st-sub">${esc(b.status)}${b.blocked_reason ? ' · ' + esc(b.blocked_reason) : ''}</div>
      </div>`).join('') : '<div class="st-panel st-empty">Nothing waiting on review or blocked.</div>';

    const dayAgo = Date.now() - 864e5;
    const recent = all.filter(b => b.status === 'done' && b.done_at && new Date(b.done_at).getTime() > dayAgo)
      .sort((a, b) => new Date(b.done_at) - new Date(a.done_at));
    $('st-mcount').textContent = recent.length ? `${recent.length}` : '';
    $('st-recent').innerHTML = recent.length ? recent.map(b => `<div class="st-line">${chip(b)} ${esc(b.title)} <span class="st-sub">${esc(ago(b.done_at))}</span></div>`).join('')
      : '<div class="st-panel st-empty">Nothing finished in the last 24 hours.</div>';

    const open = all.filter(b => OPEN.includes(b.status)).length;
    $('st-updated').textContent = `updated ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} · ${open} open`;
  }

  load();
  setInterval(load, 30000);
})();
