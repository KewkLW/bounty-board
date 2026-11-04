// The Chat tab in the bottom dock: shown only when this board has an agent room (GET /api/room).
(function () {
  const links = document.querySelectorAll('[data-chat-tab]');
  if (!links.length) return;
  fetch('/api/room').then(r => r.json()).then(d => {
    if (d && d.room) for (const a of links) a.style.display = '';
  }).catch(() => {});
})();
