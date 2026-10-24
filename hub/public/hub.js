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
  // Long text is clamped to 2 lines; what the user expanded (and Show all) survives the 30 s refresh.
  const opened = new Set();
  let needsAll = false;
  const NEEDS_CAP = 5;
  const clamp = (key, html, cls = '') => `<div class="hub-clamp${cls ? ' ' + cls : ''}${opened.has(key) ? ' open' : ''}" data-ck="${esc(key)}">${html}</div>
    <button type="button" class="hub-more" data-ck="${esc(key)}" aria-expanded="${opened.has(key)}" hidden>${opened.has(key) ? 'Show less' : 'Show more'}</button>`;
  // A clamp gets its expand control only when its text really runs past 2 lines (measured, so hidden
  // panels are measured again when their tab is shown).
  function fitClamps(root = document) {
    for (const el of root.querySelectorAll('.hub-clamp')) {
      if (!el.offsetParent) continue;
      const btn = el.nextElementSibling;
      const over = el.classList.contains('open') || el.scrollHeight > el.clientHeight + 2;
      if (btn && btn.classList.contains('hub-more')) btn.hidden = !over;
    }
  }

  function chip(b, board) {
    if (!b) return '<span class="st-chip st-missing">?</span>';
    return `<a class="st-chip st-${esc(b.status)}" href="${boardUrl(board)}/#b${b.id}" title="#${b.id} ${esc(b.title)} (${esc(b.status)})">#${b.id}</a>`;
  }
  // ---------- replies ----------
  // Every Needs you item has a reply box. State per bounty (`port-id`) lives here, so the typed text,
  // a send in flight and the sent message survive the 30 s refresh and show in both tabs.
  const replies = new Map();
  const rkey = (port, id) => `${port}-${id}`;
  const rstate = k => replies.get(k) || replies.set(k, { draft: '', sending: false, sent: null, error: null }).get(k);
  const clock = t => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  function replyBox(port, id, title) {
    const k = rkey(port, id);
    const r = rstate(k);
    const s = r.sent;
    const sent = s ? `<div class="hub-sent" tabindex="-1"><b>You:</b> <span class="hub-sent-text">${esc(s.text)}</span>
        <span class="st-sub">· ${esc(clock(s.at))}${s.unblocked ? ' · unblocked, leaves Needs you on the next refresh' : ''}${s.delivered ? ' · delivered' : ''}</span>
        ${s.delivered === false ? `<div class="hub-undelivered" title="${esc(s.delivery_error || '')}">saved on the board, not delivered live</div>` : ''}
        ${s.warn ? `<div class="hub-undelivered">${esc(s.warn)}</div>` : ''}</div>` : '';
    return `<div class="hub-reply-wrap" data-k="${k}">${sent}<form class="hub-reply" data-port="${port}" data-id="${id}"${s && s.unblocked ? ' hidden' : ''}>
      <input type="text" class="hub-reply-text" name="text" value="${esc(r.draft)}" placeholder="Reply to the agent" maxlength="4000"
        autocomplete="off" enterkeyhint="send" aria-label="Reply to #${id} ${esc(title)}"${r.sending ? ' disabled' : ''}>
      <div class="hub-reply-btns">
        <button type="submit" class="op-btn" data-act="send"${r.sending ? ' disabled' : ''}>Send</button>
        <button type="submit" class="op-btn ghost" data-act="done"${r.sending ? ' disabled' : ''} title="Sends your text, or &quot;Done&quot; when the box is empty, and unblocks it">Done, unblock it</button>
      </div>
      <div class="hub-reply-msg" role="status" aria-live="polite">${r.error ? `<span class="hub-reply-err">${esc(r.error)}</span>` : r.sending ? 'Sending...' : ''}</div>
    </form></div>`;
  }
  // Repaint one bounty's reply boxes in place (both tabs). focus: 'input' or 'sent' puts focus back
  // in the copy on the visible tab (a send disables the box, which drops focus).
  function paintReply(k, port, id, title, focus) {
    for (const w of document.querySelectorAll(`.hub-reply-wrap[data-k="${k}"]`)) w.outerHTML = replyBox(port, id, title);
    if (!focus) return;
    const fresh = [...document.querySelectorAll(`.hub-reply-wrap[data-k="${k}"]`)].find(x => !x.closest('[role=tabpanel]')?.hidden);
    const input = fresh && fresh.querySelector('.hub-reply:not([hidden]) .hub-reply-text:not([disabled])');
    (focus === 'input' && input ? input : fresh?.querySelector('.hub-sent') || input)?.focus();
  }
  async function sendReply(form, unblock) {
    const port = Number(form.dataset.port);
    const id = Number(form.dataset.id);
    const k = rkey(port, id);
    const r = rstate(k);
    if (r.sending) return;
    const hadFocus = form.contains(document.activeElement);
    const title = form.querySelector('.hub-reply-text').getAttribute('aria-label').replace(/^Reply to #\d+ /, '');
    const text = form.querySelector('.hub-reply-text').value.trim();
    r.draft = form.querySelector('.hub-reply-text').value;
    if (!text && !unblock) { r.error = 'Type a message first, or use Done.'; paintReply(k, port, id, title, hadFocus && 'input'); return; }
    r.sending = true; r.error = null;
    paintReply(k, port, id, title);
    let status = 0, body = null;
    try {
      const res = await fetch('/api/reply', { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-request': '1' },
        body: JSON.stringify({ port, bounty_id: id, text, unblock }) });
      status = res.status;
      body = await res.json().catch(() => null);
    } catch { body = null; }
    r.sending = false;
    if (body && body.saved) {
      r.sent = { text: body.text || text || 'Done', at: (body.note && body.note.created_at) || new Date().toISOString(), delivered: body.delivered,
        delivery_error: body.delivery_error || null, unblocked: unblock && status < 300, warn: status === 409 ? `Saved, but ${body.error || 'it was not blocked'}.` : null };
      r.draft = '';
      if (r.sent.unblocked) setTimeout(load, 2500);
    } else {
      const why = (body && body.error) || (status ? `The hub answered HTTP ${status}` : 'The hub did not answer');
      r.error = `Not sent: ${why.replace(/\.$/, '')}. Your text is kept; try again.`;
    }
    paintReply(k, port, id, title, hadFocus && (r.error || !r.sent.unblocked ? 'input' : 'sent'));
  }

  const empty = t => `<div class="st-panel st-empty">${t}</div>`;
  const nowGoal = b => (b.goals || []).find(g => g.now) || null;
  const dot = b => `<span class="hub-dot ${!b.online ? 'off' : b.idle ? 'idle' : 'on'}" aria-hidden="true"></span>`;

  // ---------- All ----------
  function renderNeedsYou(list) {
    if (!list.length) return empty('Nothing is waiting on you.');
    const shown = needsAll ? list : list.slice(0, NEEDS_CAP);
    return shown.map(x => `<div class="st-panel st-row hub-need"><div class="hub-need-body"><div class="hub-need-why">
      ${chip(x, { port: x.port })} <span class="hub-proj">${esc(x.board)}</span> ${esc(x.title)}
      ${clamp(`need-${x.port}-${x.id}`, esc(x.blocked_reason || 'blocked, no reason given'), 'st-sub hub-reason')}</div>
      ${replyBox(x.port, x.id, x.title)}</div>
    </div>`).join('') + (list.length > NEEDS_CAP ? `<button type="button" class="op-btn ghost hub-needs-all" aria-expanded="${needsAll}" aria-controls="hub-needs">${needsAll ? 'Show fewer' : `Show all ${list.length}`}</button>` : '');
  }

  function renderCard(b) {
    const g = nowGoal(b);
    const blocked = b.needs_human.length;
    const other = b.blocked_other.length;
    const state = !b.online ? `offline${b.offline_reason ? ' · ' + esc(b.offline_reason) : ''}` : b.paused ? 'paused' : b.idle ? 'idle' : 'working';
    return `<a href="#${tabKey(b)}" class="hub-card op-win${b.online ? '' : ' hub-offline'}" data-tab="${tabKey(b)}" style="--st-accent:${esc(b.accent)}">
      <div class="hub-card-head">${dot(b)}<span class="hub-card-name">${esc(b.name)}</span>
        ${blocked ? `<span class="hub-blocked" title="${blocked} waiting on you">${blocked} on you</span>` : ''}
        ${other ? `<span class="hub-blocked-other" title="${other} blocked for other reasons (crashes, agent notes)">${other} blocked</span>` : ''}</div>
      <div class="hub-card-state">${state}</div>
      ${b.note?.headline ? `<div class="hub-card-headline hub-clamp">${md(b.note.headline)}</div>` : b.online ? '<div class="hub-card-headline st-empty">No note from the orchestrator yet.</div>' : ''}
      ${g ? `<div class="hub-card-goal"><b>Now:</b> ${esc(g.id)} ${esc(g.name)}</div>
        <div class="st-bar"><span style="width:${g.pct}%"></span></div>
        <div class="st-road-meta">${g.done} of ${g.total} done</div>` : ''}
      ${b.online ? `<div class="hub-card-foot"><span><b>${b.working.length}</b> working</span><span><b>${b.open}</b> open</span>${b.note?.stale ? '<span class="hub-stale">note stale</span>' : ''}</div>` : ''}
    </a>`;
  }

  function renderAll(d) {
    return `<section><h2>Needs you <small>waiting on a person, every project</small></h2><div class="st-list" id="hub-needs">${renderNeedsYou(d.needs_you)}</div></section>
      <section><h2>Projects <small>${d.boards.length} registered</small></h2>
      <div class="hub-cards" id="hub-cards">${d.boards.length ? d.boards.map(renderCard).join('') : empty('No board has registered yet. Start a board and it shows up here.')}</div></section>`;
  }

  // ---------- one project ----------
  function renderNote(n, key) {
    if (!n) return empty('No note from the orchestrator yet.');
    return `<div class="st-panel st-note">
      ${n.stale ? `<div class="st-stale">This note is ${esc(ago(n.written_at))}. The orchestrator should update it every round.</div>` : ''}
      ${n.headline ? clamp(`head-${key}`, md(n.headline), 'st-headline') : ''}
      ${(n.body || []).length ? clamp(`note-${key}`, n.body.map(p => `<p>${md(p)}</p>`).join(''), 'hub-note-body') : ''}
    </div>`;
  }

  function renderItem(a, b) {
    return `<div class="st-panel st-row${a.needs_human ? ' hub-need' : ''}">
      ${chip(a, b)} ${esc(a.title)}
      <div class="st-sub">${esc(a.status)}${a.needs_human ? ' · <b class="hub-on-you">waiting on you</b>' : ''}</div>
      ${a.needs_human ? `<div class="hub-need-body"><div class="hub-need-why">` : ''}${a.blocked_reason ? clamp(`reason-${b.port}-${a.id}`, esc(a.blocked_reason), 'st-sub' + (a.needs_human ? ' hub-reason' : '')) : ''}
      ${a.needs_human ? `</div>${replyBox(b.port, a.id, a.title)}</div>` : ''}
    </div>`;
  }

  function renderAttention(b) {
    if (!b.attention.length) return empty('Nothing waiting on review or blocked.');
    const groups = [['Waiting on you', b.needs_human], ['Blocked', b.blocked_other], ['Review and approved', b.attention.filter(a => a.status !== 'blocked')]];
    return groups.filter(([, l]) => l.length).map(([t, l]) => `<h3 class="hub-group">${t} <small>${l.length}</small></h3>${l.map(a => renderItem(a, b)).join('')}`).join('');
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
      <section><h2>From the orchestrator <small>${esc(ago(b.note?.written_at))}</small></h2>${renderNote(b.note, b.port)}</section>
      <section><h2>Goals <small>a goal is reached only when its exit test is recorded</small></h2><div class="st-goals">${renderGoals(b)}</div></section>
      <section class="st-two">
        <div><h2>Working now</h2><div class="st-list">${b.working.length ? b.working.map(w => `<div class="st-panel st-row">
          ${chip(w.bounty, b)} <b>${esc(w.slot_name)}</b> ${esc(w.bounty.title)}
          <div class="st-sub">${esc(w.bounty.status.replace('_', ' '))}${w.started_at ? ' · started ' + esc(ago(w.started_at)) : ''}${w.heartbeat_at ? ' · heartbeat ' + esc(ago(w.heartbeat_at)) : ''}</div>
        </div>`).join('') : empty('No worker running.')}</div></div>
        <div><h2>Needs attention <small>blocked, review, approved</small></h2><div class="st-list">${renderAttention(b)}</div></div>
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
        ${t.board ? dot(t.board) : ''}<span>${esc(t.label)}</span>${t.count ? `<span class="hub-tab-count" aria-label="${t.count} waiting on you">${t.count}</span>` : ''}</button>`).join('');
    $('hub-panels').innerHTML = list.map(t => `<div role="tabpanel" id="panel-${t.key}" aria-labelledby="tab-${t.key}" class="st-wrap hub-panel" tabindex="0"
        ${t.key === selected ? '' : 'hidden'}${t.accent ? ` style="--st-accent:${esc(t.accent)}"` : ''}>${t.key === 'all' ? renderAll(d) : renderBoard(t.board)}</div>`).join('');
    if (hadFocus) $('tab-' + selected)?.focus();
    fitClamps();
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
    fitClamps();
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
  $('hub-panels').addEventListener('click', e => {
    const more = e.target.closest('.hub-more');
    if (more) {
      const k = more.dataset.ck;
      const box = more.previousElementSibling;
      const open = !opened.has(k);
      if (open) opened.add(k); else opened.delete(k);
      box.classList.toggle('open', open);
      more.setAttribute('aria-expanded', open);
      more.textContent = open ? 'Show less' : 'Show more';
      return;
    }
    if (e.target.closest('.hub-needs-all')) {
      needsAll = !needsAll;
      $('hub-needs').innerHTML = renderNeedsYou(data.needs_you);
      fitClamps($('hub-needs'));
      $('hub-needs').querySelector('.hub-needs-all')?.focus();
      return;
    }
  });
  $('hub-panels').addEventListener('submit', e => {
    const form = e.target.closest('.hub-reply');
    if (!form) return;
    e.preventDefault();
    sendReply(form, !!(e.submitter && e.submitter.dataset.act === 'done'));
  });
  $('hub-panels').addEventListener('input', e => {
    const input = e.target.closest('.hub-reply-text');
    if (!input) return;
    const form = input.form;
    const k = rkey(form.dataset.port, form.dataset.id);
    const r = rstate(k);
    r.draft = input.value;
    if (r.error) { r.error = null; for (const m of document.querySelectorAll(`.hub-reply-wrap[data-k="${k}"] .hub-reply-msg`)) m.textContent = ''; }
    for (const o of document.querySelectorAll(`.hub-reply-wrap[data-k="${k}"] .hub-reply-text`)) if (o !== input) o.value = input.value;
  });
  window.addEventListener('resize', () => fitClamps());
  document.fonts?.ready.then(() => fitClamps());
  $('hub-panels').addEventListener('click', e => { const c = e.target.closest('.hub-card'); if (c) { e.preventDefault(); select(c.dataset.tab, true); } });
  window.addEventListener('hashchange', () => { const k = location.hash.slice(1); if (k && k !== selected && document.getElementById('tab-' + k)) select(k); });

  async function load() {
    try {
      const r = await fetch('/api/hub', { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      data = await r.json();
      // Never repaint under someone typing a reply or while one is on its way; the next tick catches up.
      const box = document.activeElement && document.activeElement.closest('.hub-reply');
      const typing = box && box.querySelector('.hub-reply-text').value.trim();
      if (!typing && ![...replies.values()].some(x => x.sending)) render();
      $('hub-updated').textContent = `updated ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
    } catch (e) { $('hub-updated').textContent = 'hub unreachable'; }
  }

  load();
  setInterval(load, 30000);
})();
