// Shared room behaviour (symlinked into every room's public/). The page speaks as the human (AGENT_ROOMS_HUMAN).
(() => {
  const rid = location.pathname.split('/').filter(Boolean)[1];
  const api = `/api/r/${encodeURIComponent(rid)}`;
  const $ = (id) => document.getElementById(id);
  const log = $('log');
  let room = null, last = 0, human = 'Human', kinds = {};

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const initials = (n) => (n.match(/[A-Z0-9]/g) || [n[0]]).slice(-2).join('').toUpperCase();

  // Small markdown: ``` fences, `code`, **bold**, *em*, [text](url), bare urls, - lists, @mentions.
  function md(src) {
    const parts = String(src).split(/```(?:[\w-]*)\n?([\s\S]*?)```/g);
    let out = '';
    parts.forEach((p, i) => {
      if (i % 2) { out += `<pre><code>${esc(p.replace(/\n$/, ''))}</code></pre>`; return; }
      const blocks = p.split(/\n{2,}/);
      for (const b of blocks) {
        if (!b.trim()) continue;
        const lines = b.split('\n');
        if (lines.every((l) => /^\s*[-*] /.test(l))) {
          out += '<ul>' + lines.map((l) => `<li>${inline(l.replace(/^\s*[-*] /, ''))}</li>`).join('') + '</ul>';
        } else {
          out += `<p>${lines.map(inline).join('<br>')}</p>`;
        }
      }
    });
    return out;
  }
  // Generated markup (code spans, links) is stashed behind \u0000N\u0000 placeholders as soon as it is made, so no later
  // pass ever re-scans HTML it did not write: a URL inside an href can't be matched again and break out of the attribute.
  function inline(s) {
    const slots = [];
    const stash = (html) => { slots.push(html); return `\u0000${slots.length - 1}\u0000`; };
    const link = (href, text) => stash(`<a href="${href}" target="_blank" rel="noopener">${text}</a>`);
    s = esc(s).replace(/\u0000/g, '').replace(/`([^`]+)`/g, (_, c) => stash(`<code>${c}</code>`));
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)\u0000]+)\)/g, (_, t, u) => link(u, t))
      .replace(/(^|[\s(])(https?:\/\/[^\s<)\u0000]+)/g, (_, pre, u) => pre + link(u, u))
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|\W)\*([^*\s][^*]*)\*(?=\W|$)/g, '$1<em>$2</em>')
      .replace(/(^|[^\w])@([A-Za-z0-9][\w.-]*)/g, '$1<span class="at">@$2</span>');
    for (let n = 0; n < 4 && s.includes('\u0000'); n++) s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => slots[i]);
    return s;
  }

  const KINDS = ['admin', 'human', 'agent', 'interactive', 'board'];
  function kindOf(name) { return name === 'system' ? 'system' : (KINDS.includes(kinds[name]) ? kinds[name] : 'agent'); }

  function asksBox() {
    let box = $('asks');
    if (!box) {
      box = document.createElement('section');
      box.id = 'asks'; box.className = 'asks'; box.setAttribute('aria-label', 'Waiting on you');
      const body = document.querySelector('main.body');
      body.parentNode.insertBefore(box, body);
      box.addEventListener('click', async (e) => {
        const btn = e.target.closest('button[data-seq]');
        if (!btn) return;
        const li = btn.closest('li');
        const typed = li.querySelector('input').value.trim();
        const text = btn.dataset.kind === 'done' ? (typed || 'done') : `can't now${typed ? ': ' + typed : ''}`;
        btn.disabled = true;
        try {
          await j(`${api}/answer`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Room-Request': '1', 'X-Room-Web': '1' },
            body: JSON.stringify({ seq: Number(btn.dataset.seq), text }) });
          refreshRoom();
        } catch (err) { btn.disabled = false; li.querySelector('.ask-err').textContent = err.message; }
      });
    }
    return box;
  }

  function renderAsks(asks) {
    const box = asksBox();
    const open = Object.entries(asks || {}).sort((a, b) => a[0] - b[0]);
    const keep = {};
    box.querySelectorAll('li').forEach((li) => { keep[li.dataset.seq] = li.querySelector('input').value; });
    box.hidden = !open.length;
    box.innerHTML = open.length ? `<h2>Waiting on you</h2><ul>${open.map(([seq, a]) => `
      <li data-seq="${esc(seq)}"><div class="ask-head"><b>${esc(a.from)}</b> <span class="when">${esc(a.at.slice(11, 16))}</span></div>
        <div class="ask-text">${inline(a.text)}</div>
        <div class="ask-act"><input placeholder="optional reply" value="${esc(keep[seq] || '')}">
          <button data-seq="${esc(seq)}" data-kind="done" class="ask-done">Done</button>
          <button data-seq="${esc(seq)}" data-kind="no" class="ask-no">Can't now</button></div>
        <div class="ask-err"></div></li>`).join('')}</ul>` : '';
    if (open.length > (renderAsks.last || 0) && document.hidden) document.title = `(${open.length}) ${room.name}`;
    renderAsks.last = open.length;
  }

  function renderRoom(v) {
    room = v; human = v.human;
    kinds = Object.fromEntries(v.members.map((m) => [m.name, m.kind]));
    document.title = v.name;
    $('room-name').textContent = v.name;
    $('room-purpose').textContent = v.closed ? `Closed ${v.closed.replace('T', ' ')}. ${v.summary || ''}` : v.purpose;
    $('brief-box').hidden = !v.brief;
    $('brief').innerHTML = md(v.brief || '');
    $('pin-list').innerHTML = (v.pins || []).map((p) => `<li>📌 ${inline(p.text)}<span class="by">${esc(p.by)} · ${esc(p.at.slice(11, 16))}</span></li>`).join('');
    pinCount((v.pins || []).length);
    $('member-list').innerHTML = v.members.map((m) => {
      const sub = m.status_text || m.role || '';
      const st = m.status && m.presence !== 'invited' ? `${m.status}: ` : (m.presence === 'invited' ? 'invited · ' : '');
      return `<li class="member k-${esc(m.kind)}" data-presence="${esc(m.presence)}" data-name="${esc(m.name)}" title="${esc(m.presence)}${m.last_seen ? ', last seen ' + esc(m.last_seen.slice(11, 16)) : ''}">
        <span class="portrait" data-name="${esc(m.name)}">${esc(initials(m.name))}<span class="dot"></span></span>
        <span class="name">${esc(m.name)}${m.model ? `<span class="model">${esc(m.model)}</span>` : ''}</span>
        <span class="sub">${esc(st + sub)}</span></li>`;
    }).join('');
    $('text').disabled = $('send').disabled = !!v.closed;
    renderAsks(v.asks);
    if (mentionBox && !mentionBox.hidden) mentionUpdate();
  }

  // @name autocomplete in the message box, from the room's members (same name rule as the @mention render above).
  const PRESENCE_RANK = { online: 0, idle: 1, away: 2, left: 3, invited: 4 };
  let mentionBox = null, mentionAt = -1, mentionItems = [], mentionSel = 0;
  function mentionMatches(members, frag) {
    const f = frag.toLowerCase();
    const tier = (n) => (n.toLowerCase().startsWith(f) ? 0 : n.toLowerCase().includes(f) ? 1 : -1);
    return members.filter((m) => m.name !== 'system' && tier(m.name) >= 0)
      .map((m, i) => ({ m, i, t: tier(m.name), p: PRESENCE_RANK[m.presence] ?? 5, h: m.kind === 'human' ? 1 : 0 }))
      .sort((a, b) => a.t - b.t || a.h - b.h || a.p - b.p || a.i - b.i).slice(0, 8).map((x) => x.m);
  }
  function mentionEl() {
    if (!mentionBox) {
      mentionBox = document.createElement('ul');
      mentionBox.id = 'mention-list'; mentionBox.className = 'mention-list'; mentionBox.hidden = true;
      mentionBox.setAttribute('role', 'listbox'); mentionBox.setAttribute('aria-label', 'Mention a member');
      $('say').appendChild(mentionBox);
      // keep focus in the box on mouse and touch; insert on click/tap
      mentionBox.addEventListener('pointerdown', (e) => e.preventDefault());
      mentionBox.addEventListener('mousedown', (e) => e.preventDefault());
      mentionBox.addEventListener('click', (e) => {
        const li = e.target.closest('li[data-i]');
        if (li) mentionPick(Number(li.dataset.i));
      });
    }
    return mentionBox;
  }
  function mentionClose() { if (mentionBox) mentionBox.hidden = true; mentionItems = []; mentionAt = -1; $('text').removeAttribute('aria-activedescendant'); }
  function mentionUpdate() {
    const t = $('text');
    if (!room || t.disabled || t.selectionStart !== t.selectionEnd) return mentionClose();
    const before = t.value.slice(0, t.selectionStart);
    const hit = before.match(/(^|[^\w])@([\w.-]*)$/);
    if (!hit) return mentionClose();
    const items = mentionMatches(room.members, hit[2]);
    if (!items.length) return mentionClose();
    const prev = mentionItems[mentionSel] && mentionItems[mentionSel].name;
    mentionAt = before.length - hit[2].length - 1;
    mentionItems = items;
    mentionSel = Math.max(0, items.findIndex((m) => m.name === prev));
    const box = mentionEl();
    box.innerHTML = items.map((m, i) => `<li id="mention-${i}" role="option" data-i="${i}" aria-selected="${i === mentionSel}"
        class="member k-${esc(m.kind)}${i === mentionSel ? ' sel' : ''}" data-presence="${esc(m.presence)}" data-name="${esc(m.name)}">
        <span class="portrait" data-name="${esc(m.name)}">${esc(initials(m.name))}<span class="dot"></span></span>
        <span class="name">${esc(m.name)}</span><span class="sub">${esc(m.role || m.kind || '')}</span></li>`).join('');
    box.hidden = false;
    t.setAttribute('aria-activedescendant', `mention-${mentionSel}`);
  }
  function mentionMove(d) {
    mentionSel = (mentionSel + d + mentionItems.length) % mentionItems.length;
    mentionBox.querySelectorAll('li').forEach((li, i) => {
      li.classList.toggle('sel', i === mentionSel); li.setAttribute('aria-selected', i === mentionSel);
      if (i === mentionSel) li.scrollIntoView({ block: 'nearest' });
    });
    $('text').setAttribute('aria-activedescendant', `mention-${mentionSel}`);
  }
  function mentionPick(i) {
    const t = $('text'), m = mentionItems[i];
    if (!m || mentionAt < 0) return;
    const end = t.selectionStart + (t.value.slice(t.selectionStart).match(/^[\w.-]*/) || [''])[0].length;
    const ins = `@${m.name} `;
    t.value = t.value.slice(0, mentionAt) + ins + t.value.slice(end).replace(/^ /, '');
    const caret = mentionAt + ins.length;
    t.focus(); t.setSelectionRange(caret, caret);
    mentionClose();
    t.dispatchEvent(new Event('input'));
  }

  // Chat / Pinned tabs at the top of the chat panel: the brief and pins live in their own tab, not above the chat.
  function setupTabs() {
    const chat = document.querySelector('.chat'), pins = $('pins');
    const bar = document.createElement('nav');
    bar.className = 'tabs'; bar.setAttribute('role', 'tablist');
    bar.innerHTML = `<button type="button" role="tab" data-tab="chat">Chat</button>
      <button type="button" role="tab" data-tab="pins">Pinned <span id="pin-count" class="count"></span></button>`;
    chat.insertBefore(bar, chat.firstChild);
    chat.insertBefore(pins, bar.nextSibling);
    $('brief-box').open = true;
    bar.addEventListener('click', (e) => { const b = e.target.closest('button[data-tab]'); if (b) showTab(b.dataset.tab); });
    showTab(location.hash === '#pins' ? 'pins' : 'chat');
  }
  function showTab(tab) {
    const chat = document.querySelector('.chat');
    chat.dataset.tab = tab;
    chat.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', b.dataset.tab === tab));
    if (tab === 'pins') { chat.querySelector('[data-tab="pins"]').classList.remove('fresh'); pinCount.seen = pinCount.n; }
    else { log.scrollTop = log.scrollHeight; $('jump').hidden = true; }
    history.replaceState(null, '', tab === 'pins' ? '#pins' : location.pathname + location.search);
  }
  function pinCount(n) {
    pinCount.n = n;
    $('pin-count').textContent = n || '';
    if (pinCount.seen === undefined) pinCount.seen = n;
    const onPins = document.querySelector('.chat').dataset.tab === 'pins';
    if (onPins) pinCount.seen = n;
    document.querySelector('.tabs [data-tab="pins"]').classList.toggle('fresh', n > pinCount.seen);
  }

  function addMessages(msgs) {
    if (!msgs.length) return;
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
    let prev = log.lastElementChild;
    for (const m of msgs) {
      if (m.seq <= last) continue;
      last = m.seq;
      const li = document.createElement('li');
      const k = kindOf(m.from);
      if (m.kind === 'system' || m.kind === 'pin') {
        li.className = `msg system ${m.kind === 'pin' ? 'pin' : ''}`;
        li.innerHTML = `<div class="md">${inline(m.text)}</div>`;
      } else {
        const cont = prev && prev.dataset.from === m.from && !prev.classList.contains('system');
        const mention = (m.mentions || []).some((n) => n.toLowerCase() === human.toLowerCase());
        li.className = `msg k-${k}${cont ? ' cont' : ''}${mention ? ' mention' : ''}${m.kind === 'ask' ? ' ask' : ''}`;
        li.dataset.from = m.from;
        li.innerHTML = `<span class="portrait" data-name="${esc(m.from)}">${esc(initials(m.from))}</span>
          <div><div class="head"><span class="who k-${k}">${esc(m.from)}</span><span class="when">${esc(m.at.slice(11, 16))}</span></div>
          <div class="md">${md(m.text)}</div></div>`;
      }
      li.dataset.seq = m.seq;
      log.appendChild(li);
      prev = li;
    }
    if (atBottom) log.scrollTop = log.scrollHeight; else $('jump').hidden = false;
  }

  async function j(url, opts) {
    const r = await fetch(url, opts);
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || r.statusText);
    return body;
  }
  const conn = (s, t) => { $('conn').className = `conn ${s}`; $('conn').textContent = t; };

  async function refreshRoom() {
    try { renderRoom(await j(`${api}?me=${encodeURIComponent(human)}`)); } catch (e) { conn('down', e.message); }
  }

  async function loop() {
    for (;;) {
      try {
        const w = await j(`${api}/wait?since=${last}&timeout=25`);
        conn('live', 'live');
        if (w.messages.length) {
          const fresh = w.messages.filter((m) => m.kind !== 'msg' || m.reply_to);
          addMessages(w.messages);
          if (fresh.length) refreshRoom();
        }
      } catch (e) {
        conn('down', 'reconnecting');
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }

  $('say').addEventListener('submit', async (e) => {
    e.preventDefault();
    mentionClose();
    const text = $('text').value.trim();
    if (!text) return;
    $('send').disabled = true;
    try {
      await j(`${api}/post`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Room-Request': '1', 'X-Room-Web': '1' },
        body: JSON.stringify({ text }) });
      $('text').value = ''; $('say-error').hidden = true; autosize();
    } catch (err) {
      $('say-error').textContent = `Not sent: ${err.message}`; $('say-error').hidden = false;
    } finally { $('send').disabled = false; $('text').focus(); }
  });
  $('text').addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    if (mentionBox && !mentionBox.hidden && mentionItems.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); mentionMove(e.key === 'ArrowDown' ? 1 : -1); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); mentionPick(mentionSel); return; }
      if (e.key === 'Escape') { e.preventDefault(); mentionClose(); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('say').requestSubmit(); }
  });
  const autosize = () => { const t = $('text'); t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, innerHeight * 0.3) + 'px'; };
  $('text').addEventListener('input', () => { autosize(); mentionUpdate(); });
  $('text').addEventListener('click', mentionUpdate);
  $('text').addEventListener('keyup', (e) => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) mentionUpdate(); });
  $('text').addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== $('text')) mentionClose(); }, 150));
  $('jump').addEventListener('click', () => { log.scrollTop = log.scrollHeight; $('jump').hidden = true; });
  log.addEventListener('scroll', () => { if (log.scrollHeight - log.scrollTop - log.clientHeight < 80) $('jump').hidden = true; });
  $('toggle-members').addEventListener('click', () => {
    const open = $('members').classList.toggle('open');
    $('toggle-members').setAttribute('aria-expanded', open);
  });

  setupTabs();
  (async () => {
    await refreshRoom();
    try { addMessages(await j(`${api}/messages?since=0&limit=500`)); log.scrollTop = log.scrollHeight; } catch (e) { conn('down', e.message); }
    setInterval(refreshRoom, 10000);
    loop();
  })();
})();
