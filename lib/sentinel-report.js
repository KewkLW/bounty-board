// report.html for bounty sentinel: one self-contained page (inline CSS, no scripts, no external
// requests). Issues ranked by count and recency, a table per board, the day-over-day trend.
const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const n = v => (v == null ? '–' : esc(v));
const money = v => (v == null ? '–' : `$${Number(v).toFixed(2)}`);
const top = (m, k = 3) => Object.entries(m || {}).sort((a, b) => b[1] - a[1]).slice(0, k).map(([x, c]) => `${esc(x)}&nbsp;×${c}`).join(', ') || '–';

function table(head, rows, cls = '') {
  if (!rows.length) return '<p class="none">none</p>';
  return `<table class="${cls}"><thead><tr>${head.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

// One point per UTC day: that day's last run (its last-24-h figures), so hourly runs do not stack.
function trend(history) {
  const byDay = new Map();
  // unchanged runs (no rows read) count as runs; the day's figures come from its last full scan
  for (const h of history) {
    if (!h || !h.at) continue;
    const d = h.at.slice(0, 10), cur = byDay.get(d) || { runs: 0 };
    byDay.set(d, h.unchanged ? { ...cur, runs: cur.runs + 1 } : { ...h, runs: cur.runs + 1 });
  }
  for (const [d, h] of byDay) if (!h.last24h) byDay.set(d, { ...h, last24h: {} });
  return [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(-30);
}

function bars(days, key, label) {
  if (!days.length) return '';
  const vals = days.map(([, h]) => Number(((h.last24h || {})[key]) || 0));
  const max = Math.max(1, ...vals);
  const w = 22, gap = 6, H = 80;
  const rects = vals.map((v, i) => {
    const h = Math.round((v / max) * H);
    return `<g><rect x="${i * (w + gap)}" y="${H - h}" width="${w}" height="${h}" rx="2"></rect><text x="${i * (w + gap) + w / 2}" y="${H + 12}" text-anchor="middle">${esc(days[i][0].slice(5))}</text><title>${esc(days[i][0])}: ${v}</title></g>`;
  }).join('');
  return `<figure><figcaption>${esc(label)} (last 24 h, per day)</figcaption><svg width="${days.length * (w + gap)}" height="${H + 16}" role="img" aria-label="${esc(label)}">${rects}</svg></figure>`;
}

function render({ summary: s, issues, boards, history }) {
  const days = trend(history || []);
  const issueRows = issues.map(i => [
    `<b>${n(i.count)}</b>`, `<code>${esc(i.signature)}</code>`, esc(i.title), esc(i.cause), esc((i.first_seen || '').slice(0, 16).replace('T', ' ')),
    esc((i.last_seen || '').slice(0, 16).replace('T', ' ')), esc((i.boards || []).join(', ')), top(i.slots), top(i.runners), top(i.models),
    esc((i.example_bounty_ids || []).join(', ')), `<span class="sample">${esc(i.sample)}</span>`,
  ]);
  const boardHtml = boards.map(b => {
    if (!b.readable) return `<section class="board bad"><h3>${esc(b.label)} <small>port ${n(b.port)}</small></h3><p>unreadable: ${esc(b.error)}</p></section>`;
    const g = b.signals, q = g.queue_wait_min, o = g.orchestrator, ap = g.attempts_per_bounty;
    const counters = table(['attempts', 'broken', 'stall kills', 'exits w/o submit', 'never started', 'verify failures', 'reviewer errors', 'retry-cap failures'],
      [[g.attempts, g.broken, g.stall_kills, g.exits_without_submit, g.never_started, g.verify_failures, g.reviewer_errors, g.retry_cap_failures].map(n)]);
    const queue = table(['queue wait n', 'p50 min', 'p90 min', 'max min', 'waiting now', 'longest waiting now (min)', 'bounties run', 'attempts/bounty mean', 'max', 'retried'],
      [[q.n, q.p50, q.p90, q.max, q.waiting_now, q.longest_waiting_now, ap.bounties, ap.mean, ap.max, ap.retried].map(n)]);
    const cost = table(['day', 'slot', 'attempts', 'cost', 'tokens in', 'tokens out'], g.cost_by_slot_day.map(c => [esc(c.day), esc(c.slot), n(c.attempts), money(c.cost_usd), n(c.tokens_in), n(c.tokens_out)]));
    const idle = table(['slot', 'idle minutes while work was ready'], Object.entries(g.idle_while_ready).sort((a, b) => b[1] - a[1]).map(([k, v]) => [esc(k), n(v)]));
    const stale = table(['bounty', 'slot', 'minutes silent', 'log'], g.stale_open.map(x => [n(x.bounty_id), esc(x.slot), n(x.minutes_silent), esc(x.log)]));
    const who = o.known ? 'no orchestrator online' : 'no orchestrator registered';
    const orch = o.online ? `online, ${o.pending} pending`
      : (o.no_orchestrator_with_work || o.minutes_without >= 1) ? `<span class="warn">${who}; ${o.pending} pending now; ${n(o.minutes_without)} min of pending work with none online in the window</span>`
      : `${who}, ${o.pending} pending`;
    return `<section class="board"><h3>${esc(b.label)} <small>port ${n(b.port)}${b.running === false ? ' · board stopped' : ''}</small></h3>
      <p>orchestrator: ${orch} · ready work waited ${n(g.ready_waiting_min)} min, with no slot running for ${n(g.board_idle_with_ready_min)} min of it</p>
      ${counters}${queue}<h4>Cost and tokens per slot per day</h4>${cost}<h4>Slots idle while ready work waited</h4>${idle}<h4>Open attempts with a silent log</h4>${stale}</section>`;
  }).join('\n');
  const trendRows = days.map(([d, h]) => [esc(d), n(h.runs), n(h.boards), n(h.issues_open), n((h.last24h || {}).attempts), n((h.last24h || {}).broken), n((h.last24h || {}).verify_failures), n((h.last24h || {}).reviewer_errors), money((h.last24h || {}).cost_usd), n(h.no_orchestrator_with_work), n(h.unreadable)]);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<title>Sentinel report ${esc(s.at)}</title>
<style>
:root{--bg:#14161c;--fg:#d8dae5;--mut:#8a90a6;--acc:#7aa2f7;--bad:#f7768e;--line:#2a2e3b}
body{background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif;margin:24px;max-width:1500px}
h1{font-size:20px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 8px;color:var(--acc)}h3{margin:18px 0 6px}h4{margin:12px 0 4px;color:var(--mut);font-weight:500}
small,.none{color:var(--mut)}table{border-collapse:collapse;margin:6px 0;width:auto}th,td{border:1px solid var(--line);padding:3px 7px;text-align:left;vertical-align:top}
th{background:#1c1f28;font-weight:600}code{font-size:12px}.sample{font-family:ui-monospace,monospace;font-size:12px;color:#c0caf5;word-break:break-word}
.kpi{display:flex;gap:12px;flex-wrap:wrap;margin:12px 0}.kpi div{background:#1c1f28;border:1px solid var(--line);border-radius:6px;padding:8px 12px}.kpi b{display:block;font-size:18px}
.board{border-top:1px solid var(--line);padding-top:4px}.bad h3,.warn{color:var(--bad)}svg rect{fill:var(--acc)}svg text{fill:var(--mut);font-size:9px}figure{display:inline-block;margin:6px 18px 6px 0}figcaption{color:var(--mut);font-size:12px}
</style></head><body>
<h1>Sentinel report</h1><small>generated ${esc(s.at)} · window ${esc(s.since_hours)} h · ${esc(s.boards)} board(s), ${esc(s.unreadable)} unreadable · read-only scan</small>
<div class="kpi"><div><b>${n(s.issues_open)}</b>open issues</div><div><b>${n(s.broken)}</b>broken attempts</div><div><b>${n(s.stall_kills)}</b>stall kills</div><div><b>${n(s.exits_without_submit)}</b>exits w/o submit</div><div><b>${n(s.verify_failures)}</b>verify failures</div><div><b>${n(s.reviewer_errors)}</b>reviewer errors</div><div><b>${n(s.stale_open)}</b>silent open attempts</div><div><b>${money(s.cost_usd)}</b>cost in window</div></div>
<h2>Issues (by count, then most recent)</h2>
${table(['count', 'signature', 'title', 'cause', 'first seen', 'last seen', 'boards', 'slots', 'runners', 'models', 'examples', 'sample (redacted)'], issueRows, 'issues')}
<h2>Day over day</h2>
${bars(days, 'broken', 'broken attempts')}${bars(days, 'attempts', 'attempts')}${bars(days, 'cost_usd', 'cost USD')}
${table(['day', 'runs', 'boards', 'open issues', 'attempts 24h', 'broken 24h', 'verify fail 24h', 'reviewer err 24h', 'cost 24h', 'no orchestrator', 'unreadable'], trendRows)}
<h2>Boards</h2>
${boardHtml}
</body></html>
`;
}

module.exports = { render, esc, trend };
