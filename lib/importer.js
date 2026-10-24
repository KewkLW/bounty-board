// Import a project backlog into bounties from Markdown files.  Re-runnable: every item has a
// stable import_key, so a second run adds only what is new and never duplicates.
//
// Sources (configure paths via opts.paths):
//   taskList   — the live backlog Markdown; every unchecked "- [ ]" under "## LIVE BACKLOG"
//   audit      — an "Unfinished Work Audit" with "## By system" tables
//   queue      — a test queue Markdown (type test, assigned to opts.tester_slot)
//
// Customise the FOLD table below to map audit rows to their task-list counterparts.
const fs = require('fs');

// -- Replace these paths with your own project layout, or pass them via opts.paths. --
const DEFAULTS = {
  taskList: '/path/to/your/project/Task List.md',
  audit: '/path/to/your/project/Unfinished Work Audit.md',
  queue: '/path/to/your/project/QUEUE.md',
};

const STOP = new Set('the a an and or of to in on for with no not is are be it its as at by from that this only yet has have into via per any all one two up out so its them their they there what when than then also do does just'.split(' '));

function words(s) {
  return String(s).toLowerCase().replace(/`[^`]*`/g, m => m.replace(/[^a-z0-9]+/g, ' ')).replace(/[^a-z0-9]+/g, ' ').split(' ')
    .filter(w => w.length > 2 && !STOP.has(w)).map(w => w.replace(/(ies)$/, 'y').replace(/(s)$/, ''));
}
function key(s) { return words(s).slice(0, 10).join('-').slice(0, 80); }
function stripMd(s) { return String(s).replace(/\*\*/g, '').replace(/\[\[([^\]]+)\]\]/g, '$1').trim(); }
function titleOf(text) {
  const bold = text.match(/^\*\*([^*]+)\*\*/);
  if (bold) return stripMd(bold[1]).replace(/[:.]$/, '');
  const t = stripMd(text);
  const cut = t.search(/[:(;]|\. /);
  const s = cut > 12 ? t.slice(0, cut) : t;
  return s.length > 100 ? s.slice(0, 97).replace(/\s+\S*$/, '') + '...' : s;
}

// ---------- Task List: LIVE BACKLOG ----------
function parseTaskList(text) {
  const start = text.indexOf('## LIVE BACKLOG');
  if (start < 0) throw new Error('Task List: no "## LIVE BACKLOG" section');
  const rest = text.slice(start);
  const end = rest.search(/\n#\s|\n## (?!#)(?!LIVE)/);
  const body = end > 0 ? rest.slice(0, end) : rest;
  const items = [];
  let section = '', group = '';
  for (const line of body.split('\n')) {
    const h = line.match(/^###\s+(.+)/);
    if (h) { section = h[1].trim(); group = ''; continue; }
    const g = line.match(/^\*\*([^*]+)\*\*\s*$/);
    if (g) { group = g[1].trim(); continue; }
    const m = line.match(/^\s*- \[ \]\s+(.+)$/);
    if (!m) continue;
    const text2 = m[1].trim();
    // "No code yet" lists several systems in one line: one bounty each.
    if (/^No code yet/i.test(group) && text2.includes(';')) {
      for (const part of text2.split(';').map(s => s.trim()).filter(Boolean)) items.push({ section, group, text: part });
    } else items.push({ section, group, text: text2 });
  }
  return items;
}

function classify(it) {
  const s = `${it.section} ${it.group}`.toLowerCase();
  const t = it.text.toLowerCase();
  let type = 'task', tier = 'B', priority = 'normal';
  if (s.includes('missing core systems')) { tier = 'A'; priority = 'high'; }
  else if (s.includes('bugs on main')) { type = 'bug'; tier = 'B'; priority = 'high'; }
  else if (s.includes('half built')) { tier = 'B'; }
  else if (s.includes('no code yet')) { tier = 'A'; priority = 'low'; }
  else if (s.includes('tech debt')) { tier = 'C'; priority = 'low'; }
  if (/stale docs/.test(t)) type = 'docs';
  if (/\bart\b|blender/.test(t)) type = 'art';
  return { type, tier, priority };
}

// ---------- Audit: "By system" tables ----------
function parseAudit(text) {
  const start = text.indexOf('## By system');
  const body = start >= 0 ? text.slice(start) : text;
  const rows = [];
  let system = '';
  for (const line of body.split('\n')) {
    const h = line.match(/^###\s+(.+)/);
    if (h) { system = h[1].trim(); continue; }
    if (/^Nothing exists for keeps/i.test(line)) {
      rows.push({ system, where: '(no code)', what: line.trim(), size: 'L' });
      continue;
    }
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map(c => c.trim());
    if (cells.length < 3 || /^-+$/.test(cells[0].replace(/\s/g, '')) || cells[0] === 'Where') continue;
    rows.push({ system, where: cells[0], what: cells[1], size: cells[2] });
  }
  return rows;
}
function sizeTier(size) {
  const s = String(size).replace(/\s/g, '');
  if (/^L/.test(s)) return 'A';
  if (/M/.test(s)) return 'B';
  if (/^S/.test(s)) return 'C';
  return 'C';
}

// Hand-checked folds: audit rows whose work is already a Task List item.  Anything not listed
// here falls back to word overlap (scored), and anything below the bar becomes its own bounty.
// Format: [/audit row pattern/i, /task list pattern/i]  or  [/pattern/i, 'skip']  or  [/pattern/i, null]
//
// Example entries (replace with your own project's mappings):
//   [/login page/i, /User auth flow/i],       // audit row "login page" folds into "User auth flow"
//   [/Go tests/i, 'skip'],                     // skip this audit row entirely
const FOLD = [
  // Add your project-specific fold mappings here.
  // [/audit pattern/i, /task list pattern/i],
];

function foldTarget(row, tasks) {
  const blob = `${row.where} ${row.what}`;
  for (const [re, target] of FOLD) {
    if (!re.test(blob)) continue;
    if (target === 'skip') return 'skip';
    if (target === null) return null;
    const hit = tasks.find(t => target.test(stripMd(t.text)));
    if (hit) return hit;
  }
  // fallback: word overlap
  const w = new Set(words(blob));
  let best = null, bestScore = 0;
  for (const t of tasks) {
    const tw = new Set(words(t.text));
    let inter = 0; for (const x of tw) if (w.has(x)) inter++;
    const score = inter / Math.max(4, Math.min(tw.size, w.size));
    if (score > bestScore) { bestScore = score; best = t; }
  }
  return bestScore >= 0.5 ? best : null;
}

// ---------- QUEUE.md ----------
function parseQueue(text) {
  const out = [];
  let section = '';
  for (const line of text.split('\n')) {
    const h = line.match(/^##\s+(.+)/);
    if (h) { section = h[1].trim(); continue; }
    const m = line.match(/^\s*- \[([ x~])\]\s+(T\d+)\s+(.+)$/);
    if (m) out.push({ section, mark: m[1], id: m[2], text: m[3].trim() });
  }
  return out;
}

// ---------- in-flight work (tasks started outside the dispatcher) ----------
// Override this to seed bounties for work already underway before the board existed.
// Each entry becomes an in_progress bounty.  Example:
//   { import_key: 'inflight:my-branch', title: 'Fix the widget', type: 'bug', tier: 'A',
//     priority: 'high', branch: 'fix-widget', description: 'Started before the board.' }
function inFlight() {
  return [];
}

function importBacklog(board, opts = {}) {
  const src = { ...DEFAULTS, ...(opts.paths || {}) };
  const project = opts.project;
  if (!project) throw new Error("opts.project is required");
  if (!board.project(project)) throw new Error(`project '${project}' missing`);
  const testerSlot = opts.tester_slot || null;
  const tasks = parseTaskList(fs.readFileSync(src.taskList, 'utf8'));
  const audit = fs.existsSync(src.audit) ? parseAudit(fs.readFileSync(src.audit, 'utf8')) : [];
  const queue = fs.existsSync(src.queue) ? parseQueue(fs.readFileSync(src.queue, 'utf8')) : [];
  const flights = inFlight();
  const report = { created: [], existing: 0, folded: 0, skipped_audit: 0, tests: 0, inflight: 0 };

  // Fold audit rows into Task List items (or keep them as their own bounties).
  const extra = new Map(); // task -> [audit rows]
  const standalone = [];
  for (const r of audit) {
    const t = foldTarget(r, tasks);
    if (t === 'skip') { report.skipped_audit++; continue; }
    if (t) { if (!extra.has(t)) extra.set(t, []); extra.get(t).push(r); report.folded++; }
    else standalone.push(r);
  }

  const exists = k => board.db.prepare('SELECT id FROM bounties WHERE import_key = ?').get(k);
  const add = (d) => {
    const e = exists(d.import_key);
    if (e) { report.existing++; return e.id; }
    const b = board.create({ ...d, project }, 'importer');
    report.created.push({ id: b.id, key: d.import_key, status: b.status, title: b.title });
    return b.id;
  };
  const auditText = rows => rows.map(r => `- [audit, ${r.system}, size ${r.size}] ${stripMd(r.what)} (where: ${stripMd(r.where)})`).join('\n');

  // In-flight first (they absorb their Task List duplicate).
  const flightIds = {};
  for (const f of flights) {
    const foldTask = f.fold ? tasks.find(t => f.fold.test(stripMd(t.text))) : null;
    const rows = foldTask ? extra.get(foldTask) || [] : [];
    const desc = f.description + (foldTask ? `\n\nTask List: ${stripMd(foldTask.text)}` : '') + (rows.length ? `\n\nAudit (${src.audit}):\n${auditText(rows)}` : '');
    const { fold, ...d } = f;
    flightIds[f.import_key] = add({ ...d, description: desc, status: 'in_progress', tags: ['imported', 'in-flight'] });
    if (foldTask) foldTask.absorbed = true;
    report.inflight++;
  }

  for (const t of tasks) {
    if (t.absorbed) continue;
    const c = classify(t);
    const rows = extra.get(t) || [];
    const text = stripMd(t.text);
    const desc = `${text}\n\nSource: Task List LIVE BACKLOG, "${t.section}"${t.group ? ` / ${t.group}` : ''} (${src.taskList}).` +
      (rows.length ? `\n\nAudit detail (${src.audit}):\n${auditText(rows)}` : '') +
      '\n\nAcceptance criteria: to be written by the orchestrator before this goes ready.';
    const d = { import_key: `tasklist:${key(t.text)}`, title: titleOf(t.text), description: desc, ...c, tags: ['imported'] };
    if (/phase 3/i.test(text)) d.depends_on = [flightIds['inflight:titan-darkknight']].filter(Boolean);
    add(d);
  }

  for (const r of standalone) {
    const d = {
      import_key: `audit:${key(r.system)}:${key(r.where + ' ' + r.what)}`, title: `${r.system.split('/')[0].trim()}: ${titleOf(r.what)}`,
      description: `${stripMd(r.what)}\n\nWhere: ${stripMd(r.where)}\nSize: ${r.size}\nSource: Unfinished Work Audit, "${r.system}" (${src.audit}).\n\nAcceptance criteria: to be written by the orchestrator before this goes ready.`,
      type: 'task', tier: sizeTier(r.size), priority: 'normal', tags: ['imported', 'audit'],
    };
    add(d);
  }

  const queueDir = require('path').dirname(src.queue);
  for (const q of queue) {
    const pri = /^P0/.test(q.section) ? 'high' : /^P2/.test(q.section) ? 'low' : 'normal';
    add({
      import_key: `queue:${q.id}`, title: `${q.id} ${titleOf(q.text)}`, type: 'test', tier: 'C', priority: pri,
      assignee_slot: testerSlot, tags: ['imported', 'playtest'],
      description: `${q.id} ${q.text}\n\nSection: ${q.section}. Queue marker [${q.mark}]. Rules and setup: ${src.queue} (test the real build with real input through the playtest driver; results in ${queueDir}/results, bugs in BUGS.md). Owned by the tester for now; not ready on the board until the orchestrator switches it over.`,
      criteria: [`${q.id} run on the current main build with real input; PASS/FAIL recorded with evidence in ${queueDir}/results`, 'Every failure filed in BUGS.md (steps, expected, actual, screenshot/log paths, main commit)'],
    });
    report.tests++;
  }
  report.created_count = report.created.length;
  board.changed('import', { n: report.created_count });
  return report;
}

module.exports = { importBacklog, parseTaskList, parseAudit, parseQueue, foldTarget, DEFAULTS };
