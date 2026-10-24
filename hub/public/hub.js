// Hub page: an All tab (every project at a glance, and everything blocked on a human), then one tab
// per board with that board's full status in its own accent color. Data: GET /api/hub, every 30 s.
// The selected tab lives in location.hash (#all, #p<port>) so a refresh keeps it.
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
  // Board links use the host this page was opened on (a phone over Tailscale, or localhost).
  const boardUrl = b => `${location.protocol}//${location.hostname.includes(':') ? `[${location.hostname}]` : location.hostname}:${b.port}`;
  const tabKey = b => 'p' + b.port;
  let data = null;
  let selected = (location.hash || '#all').slice(1);

  function chip(b, board) {
    if (!b) return '<span class="st-chip st-missing">?</span>';
    return `<a class="st-chip st-${esc(b.status)}" href="${boardUrl(board)}/#b${b.id}" title="#${b.id} ${esc(b.title)} (${esc(b.status)})">#${b.id}</a>`;
  }
  const empty = t => `<div class="st-panel st-empty">${t}</div>`;
  const nowGoal = b => (b.goals || []).find(g => g.now) || null;
  const dot = b => `<span class="hub-dot ${!b.online ? 'off' : b.idle ? 'idle' : 'on'}" aria-hidden="true"></span>`;

  // ---------- All ----------
  function renderNeedsYou(list) {
    if (!list.length) return empty('Nothing is blocked on you.');
    return list.map(x => `<div class="st-panel st-row hub-need">
      ${chip(x, { port: x.port })} <span class="hub-proj">${esc(x.board)}</span> ${esc(x.title)}
      <div class="st-sub hub-reason">${esc(x.blocked_reason || 'blocked, no reason given')}</div>
    </div>`).join('');
  }

  function renderCard(b) {
    const g = nowGoal(b);
    const blocked = b.needs_human.length;
    const state = !b.online ? `offline${b.offline_reason ? ' · ' + esc(b.offline_reason) : ''}` : b.paused ? 'paused' : b.idle ? 'idle' : 'working';
    return `<a href="#${tabKey(b)}" class="hub-card op-win${b.online ? '' : ' hub-offline'}" data-tab="${tabKey(b)}" style="--st-accent:${esc(b.accent)}">
      <div class="hub-card-head">${dot(b)}<span class="hub-card-name">${esc(b.name)}</span>
        ${blocked ? `<span class="hub-blocked" title="${blocked} blocked on a human">${blocked} blocked</span>` : ''}</div>
      <div class="hub-card-state">${state}</div>
      ${b.note?.headline ? `<div class="hub-card-headline">${md(b.note.headline)}</div>` : b.online ? '<div class="hub-card-headline st-empty">No note from the orchestrator yet.</div>' : ''}
      ${g ? `<div class="hub-card-goal"><b>Now:</b> ${esc(g.id)} ${esc(g.name)}</div>
        <div class="st-bar"><span style="width:${g.pct}%"></span></div>
        <div class="st-road-meta">${g.done} of ${g.total} done</div>` : ''}
      ${b.online ? `<div class="hub-card-foot"><span><b>${b.working.length}</b> working</span><span><b>${b.open}</b> open</span>${b.note?.stale ? '<span class="hub-stale">note stale</span>' : ''}</div>` : ''}
    </a>`;
  }

  function renderAll(d) {
    return `<section><h2>Needs you <small>blocked on a human, every project</small></h2><div class="st-list" id="hub-needs">${renderNeedsYou(d.needs_you)}</div></section>
      <section><h2>Projects <small>${d.boards.length} registered</small></h2>
      <div class="hub-cards" id="hub-cards">${d.boards.length ? d.boards.map(renderCard).join('') : empty('No board has registered yet. Start a board and it shows up here.')}</div></section>`;
  }

  // ---------- one project ----------
  function renderNote(n) {
    if (!n) return empty('No note from the orchestrator yet.');
    return `<div class="st-panel st-note">
      ${n.stale ? `<div class="st-stale">This note is ${esc(ago(n.written_at))}. The orchestrator should update it every round.</div>` : ''}
      ${n.headline ? `<div class="st-headline">${md(n.headline)}</div>` : ''}
      ${(n.body || []).map(p => `<p>${md(p)}</p>`).join('')}
    </div>`;
  }

  function renderGoals(b) {
    if (!b.goals) return empty('No goals file yet. The orchestrator writes <code>status-goals.json</code> in this board\'s public folder.');
    return b.goals.map(g => `<div class="st-panel st-goal st-goal-${esc(g.state)}${g.now ? ' st-now' : ''}">
      <div class="st-goal-head">
        <span class="st-goal-id">${esc(g.id)}</span>
        <span class="st-goal-name">${esc(g.name)}</span>
        ${g.now ? '<span class="st-badge st-badge-now">Now</span>' : ''}
        <span class="st-badge st-badge-${esc(g.state)}">${esc(g.label)}</span>
      </div>
      ${g.goal ? `<div class="st-goal-goal">${md(g.goal)}</div>` : ''}
      ${g.test ? `<div class="st-goal-test"><b>Done when:</b> ${md(g.test)}</div>` : ''}
      ${g.state === 'reached' && (g.when || g.evidence) ? `<div class="st-goal-ev"><b>Reached${g.when ? ' ' + esc(g.when) : ''}:</b> ${md(g.evidence || (g.gate ? 'gate #' + g.gate.id + ' done' : ''))}</div>` : ''}
      ${g.total ? `<div class="st-bar"><span style="width:${g.pct}%"></span></div>
        <div class="st-road-meta">${g.done} of ${g.total} done${g.working.length ? ` · working: ${g.working.map(i => '#' + i).join(', ')}` : ''}${g.stuck.length ? ` · <span class="st-bad">stuck: ${g.stuck.map(i => '#' + i).join(', ')}</span>` : ''}${g.gate ? ` · gate ${chip(g.gate, b)}` : ''}</div>
        <div class="st-road">${g.road.map(r => r ? `<div class="st-step st-${esc(r.status)}">${chip(r, b)} <span>${esc(r.title)}</span> <i>${esc(r.status.replace('_', ' '))}</i></div>` : '').join('')}</div>` : ''}
    </div>`).join('');
  }

  function renderBoard(b) {
    const url = boardUrl(b);
    const links = `<div class="hub-links"><a class="op-btn" href="${url}/">Open the board</a><a class="op-btn ghost" href="${url}/status.html">Its status page</a><a class="op-btn ghost" href="${url}/live">Live</a></div>`;
    if (!b.online) {
      return `<section><h2>${esc(b.name)}</h2>${links}${empty(`This board does not answer on port ${b.port}${b.offline_reason ? ` (${esc(b.offline_reason)})` : ''}.`)}</section>`;
    }
    const s = b.stats || {};
    const stats = [['done', s.done], ['working', s.in_progress], ['ready', s.ready], ['review', (s.review || 0) + (s.approved || 0)], ['blocked', s.blocked], ['backlog', s.backlog]]
      .filter(([, v]) => v != null).map(([k, v]) => `<span class="st-stat"><b>${esc(v)}</b> ${k}</span>`).join('');
    return `<section class="hub-board-head"><h2>${esc(b.name)} <small>port ${b.port}${b.paused ? ' · paused' : ''}</small></h2><div class="st-stats">${stats}</div>${links}</section>
      <section><h2>From the orchestrator <small>${esc(ago(b.note?.written_at))}</small></h2>${renderNote(b.note)}</section>
      <section><h2>Goals <small>a goal is reached only when its exit test is recorded</small></h2><div class="st-goals">${renderGoals(b)}</div></section>
      <section class="st-two">
        <div><h2>Working now</h2><div class="st-list">${b.working.length ? b.working.map(w => `<div class="st-panel st-row">
          ${chip(w.bounty, b)} <b>${esc(w.slot_name)}</b> ${esc(w.bounty.title)}
          <div class="st-sub">${esc(w.bounty.status.replace('_', ' '))}${w.started_at ? ' · started ' + esc(ago(w.started_at)) : ''}${w.heartbeat_at ? ' · heartbeat ' + esc(ago(w.heartbeat_at)) : ''}</div>
        </div>`).join('') : empty('No worker running.')}</div></div>
        <div><h2>Needs attention <small>review, approved, blocked</small></h2><div class="st-list">${b.attention.length ? b.attention.map(a => `<div class="st-panel st-row">
          ${chip(a, b)} ${esc(a.title)}
          <div class="st-sub">${esc(a.status)}${a.blocked_reason ? ' · ' + esc(a.blocked_reason) : ''}</div>
        </div>`).join('') : empty('Nothing waiting on review or blocked.')}</div></div>
      </section>
      <section><h2>Finished, last 24 h <small>${b.recent.length || ''}</small></h2>${b.recent.length ? b.recent.map(r => `<div class="st-line">${chip({ ...r, status: 'done' }, b)} ${esc(r.title)} <span class="st-sub">${esc(ago(r.done_at))}</span></div>`).join('') : empty('Nothing finished in the last 24 hours.')}</section>`;
  }

  // ---------- tabs ----------
  function tabs(d) {
    const all = [{ key: 'all', label: 'All', count: d.needs_you.length, accent: null, cls: '' }]
      .concat(d.boards.map(b => ({ key: tabKey(b), label: b.name, count: b.needs_human.length, accent: b.accent, cls: b.online ? '' : ' hub-tab-off', board: b })));
    if (!all.some(t => t.key === selected)) selected = 'all';
    return all;
  }

  function render() {
    const d = data;
    const list = tabs(d);
    const hadFocus = document.activeElement && document.activeElement.getAttribute('role') === 'tab';
    $('hub-tabs').innerHTML = list.map(t => `<button type="button" role="tab" id="tab-${t.key}" data-tab="${t.key}" aria-controls="panel-${t.key}"
        aria-selected="${t.key === selected}" tabindex="${t.key === selected ? 0 : -1}" class="hub-tab${t.cls}"${t.accent ? ` style="--st-accent:${esc(t.accent)}"` : ''}>
        ${t.board ? dot(t.board) : ''}<span>${esc(t.label)}</span>${t.count ? `<span class="hub-tab-count" aria-label="${t.count} blocked">${t.count}</span>` : ''}</button>`).join('');
    $('hub-panels').innerHTML = list.map(t => `<div role="tabpanel" id="panel-${t.key}" aria-labelledby="tab-${t.key}" class="st-wrap hub-panel" tabindex="0"
        ${t.key === selected ? '' : 'hidden'}${t.accent ? ` style="--st-accent:${esc(t.accent)}"` : ''}>${t.key === 'all' ? renderAll(d) : renderBoard(t.board)}</div>`).join('');
    if (hadFocus) $('tab-' + selected)?.focus();
    const online = d.boards.filter(b => b.online);
    const working = online.reduce((n, b) => n + b.working.length, 0);
    $('hub-stats').innerHTML = `<div class="op-stat"><div><span class="lbl">Boards up</span><span class="val">${online.length}/${d.boards.length}</span></div></div>
      <div class="op-stat"><div><span class="lbl">Working</span><span class="val">${working}</span></div></div>
      <div class="op-stat${d.needs_you.length ? ' alarm' : ''}"><div><span class="lbl">Needs you</span><span class="val">${d.needs_you.length}</span></div></div>`;
  }

  function select(key, focus) {
    selected = key;
    history.replaceState(null, '', '#' + key);
    for (const t of document.querySelectorAll('[role=tab]')) {
      const on = t.dataset.tab === key;
      t.setAttribute('aria-selected', on);
      t.tabIndex = on ? 0 : -1;
      if (on && focus) t.focus();
    }
    for (const p of document.querySelectorAll('[role=tabpanel]')) p.hidden = p.id !== 'panel-' + key;
    window.scrollTo(0, 0);
  }

  $('hub-tabs').addEventListener('click', e => { const t = e.target.closest('[role=tab]'); if (t) select(t.dataset.tab, true); });
  $('hub-tabs').addEventListener('keydown', e => {
    const list = [...document.querySelectorAll('[role=tab]')];
    const i = list.indexOf(document.activeElement);
    if (i < 0) return;
    const j = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1, Home: 0, End: list.length - 1 }[e.key];
    if (j == null) return;
    e.preventDefault();
    select(list[(j + list.length) % list.length].dataset.tab, true);
  });
  $('hub-panels').addEventListener('click', e => { const c = e.target.closest('.hub-card'); if (c) { e.preventDefault(); select(c.dataset.tab, true); } });
  window.addEventListener('hashchange', () => { const k = location.hash.slice(1); if (k && k !== selected && document.getElementById('tab-' + k)) select(k); });

  async function load() {
    try {
      const r = await fetch('/api/hub', { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      data = await r.json();
      render();
      $('hub-updated').textContent = `updated ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
    } catch (e) { $('hub-updated').textContent = 'hub unreachable'; }
  }

  load();
  setInterval(load, 30000);
})();
