// Import the Tribulation backlog into bounties. Re-runnable: every item has a stable import_key,
// so a second run adds only what is new and never duplicates.
//
// Sources:
//   vault Projects/Tribulation/Tribulation Task List.md       LIVE BACKLOG, every unchecked "- [ ]"
//   vault Projects/Tribulation/Tribulation Unfinished Work Audit.md   the "By system" tables
//   /mnt/ue/testlab/QUEUE.md                                   playtests (type test, sonnet-tester, backlog)
// Audit rows that describe the same work as a Task List item are folded into that item.
const fs = require('fs');

const VAULT = '/mnt/f/Obsidian/Vault/Projects/Tribulation';
const DEFAULTS = {
  taskList: `${VAULT}/Tribulation Task List.md`,
  audit: `${VAULT}/Tribulation Unfinished Work Audit.md`,
  queue: '/mnt/ue/testlab/QUEUE.md',
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
  if (/tripo creatures|\bart\b|blender/.test(t)) type = 'art';
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

// Hand-checked folds: audit rows whose work is already a Task List item. Anything not listed
// here falls back to word overlap (scored), and anything below the bar becomes its own bounty.
const FOLD = [
  [/portal-real-test/i, /portal fixes on/i],
  [/SetIdentityResolver|Control Room identity|placeholder `dev:character/i, /Identity: `\?Character=`/i],
  [/Proxy token/i, /Proxy token live refresh/i],
  [/hop-chaos\.sh` is not in CI|M4 \(Unreal-level chaos\)/i, /^Stale docs/i],
  [/LaunchSettings\.Damage/i, /Spell projectile damage/i],
  [/No PvP rules/i, /No PvP rules/i],
  [/ExcludeInstigatorTeam/i, /No PvP rules/i],
  [/ResistanceChannels/i, /Typed damage/i],
  [/Player melee exists only/i, /Titan helm\/steer\/melee/i],
  [/Splash damage/i, /Typed damage/i],
  [/ApplyDeathProgressionPenalty|GrantRespawnStarterKit|Full loot|death save's retry/i, /^Death:/i],
  [/one passenger seat|Director schema \(no ship tables\)|Banked turns deferred/i, /^Ships not persisted/i],
  [/RepDriverDisable/i, /Iris\/ReplicationGraph/i],
  [/TribulationMigrationServer/i, /test-planets\.sh stale/i],
  [/title-screen planet is a procedural stand-in/i, null],
  [/electric-dreams-pcg/i, /^Branches:/i],
  [/Riding on a moving object only works/i, /^Moving platforms/i],
  [/Taking the helm, steering and melee/i, /Titan helm\/steer\/melee/i],
  [/`\/withdraw` has no game|`\/finish` has no arena|Admin picks exist only/i, /^Tournament/i],
  [/revisit the max stake/i, null],
  [/No player-facing way to create, invite/i, /^Fellowship\/Allegiance/i],
  [/No player-facing way to swear/i, /^Fellowship\/Allegiance/i],
  [/Fellowship and Allegiance chat only reach/i, /^Fellowship\/Allegiance/i],
  [/ignore lists are not persisted|Streamer mode is only a hook/i, /^Chat: ignore lists/i],
  [/AnnounceScheduledReset/i, /^Criers/i],
  [/placeholder lead until quests exist/i, /^Criers/i],
  [/\*\*Herald\*\*/i, /Herald\/Chronicle\/Revelations/i],
  [/\*\*Spawn Director\*\*/i, /^Spawn Director/i],
  [/\*\*Cataclysm framework\*\*/i, /^cataclysm framework/i],
  [/Wall and ceiling climbing/i, /wall\/ceiling climbing/i],
  [/UEffectVisibilityComponent|Buffs, creature attacks, impacts and gun tracers/i, /Effect visibility only used/i],
  [/Nothing exists for keeps/i, /keeps\/siege/i],
  [/Assign\/Remove\/Reorder spell/i, /^Spell bar editing/i],
  [/`Transient` UI region/i, /LayeredUI `Transient`/i],
  [/Portal weights are placeholders/i, /LayeredUI `Transient`/i],
  [/Not in any CI stage/i, /^CI: add test-planets/i],
  [/Still exits 2 \("INCOMPLETE"\)/i, /test-planets\.sh stale/i],
  [/bot-moves/i, /^Branches:/i],
  [/Go tests/i, 'skip'],
  [/Out of date: says migrations/i, /^Stale docs/i],
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

// ---------- in-flight work (run outside the dispatcher today) ----------
function inFlight() {
  const briefs = '/mnt/ue/wt/briefs';
  return [
    {
      import_key: 'inflight:portal-real-test', title: 'Portals: real-game test + fix (T40-T46), merge portal-real-test',
      type: 'bug', tier: 'A', priority: 'high', branch: 'portal-real-test', worktree: '/mnt/ue/wt/portal-real-test',
      external_owner: 'opus worker (brief portal-real-test)',
      description: `In flight before the board existed (Opus, branch portal-real-test). Status: ${briefs}/portal-real-test-status.md.\nThe branch holds fixes for bugs that are live on main: gun fire doesn't break a portal channel, dead "E: Travel", vitals refill on every hop, stack weight lockout, frozen screen after a hop, buffs/vitals lost on logout save, TestZone gate A unreachable.`,
      criteria: ['T40-T46 from /mnt/ue/testlab/QUEUE.md pass in the real game (seat and offscreen), evidence recorded', 'Each listed portal bug has a fix on the branch and a test or playtest proving it', 'Scripts/ci.sh --quick passes on the branch'],
      fold: /portal fixes on/i,
    },
    {
      import_key: 'inflight:p0-game-bugs', title: 'P0 game bugs from tester triage (camera in hull, marker flip, switch hitch, -0 m)',
      type: 'bug', tier: 'A', priority: 'critical', branch: 'p0-game-bugs', worktree: '/mnt/ue/wt/p0-game-bugs',
      external_owner: 'opus worker (fix queue 2026-09-28 19:00)',
      description: `In flight before the board existed (Opus, branch p0-game-bugs). Fix queue: ${briefs}/fix-queue.md.`,
      criteria: ['Camera is not inside the ship hull after exiting (T07/T08)', 'The destination marker does not flip back to the planet just left when the owner flips A->B (T06/T07)', 'No 171/199 ms frame hitch at the A->B switch / sky commit (T06 boundary_cross_max_ms < 100)', 'The landed HUD never shows "ALTITUDE -0 m"', 'Scripts/ci.sh --quick passes on the branch'],
    },
    {
      import_key: 'inflight:titan-darkknight', title: 'Dark knight titan: Blender cleanup v1 (waiting on Kewky\'s review of the model view)',
      type: 'art', tier: 'A', priority: 'high', branch: null, worktree: '/mnt/ue/ArtSource/titan-darkknight',
      external_owner: 'opus worker (Blender, no repo commits in this phase)',
      description: `Phase 2 of the dark knight titan (Blender only, no Unreal, no repo commits). Result + changelog: ${briefs}/titan-darkknight-v1.md; inspection: ${briefs}/titan-darkknight-inspection.md. Waiting on Kewky's review of the model view in /mnt/ue/ArtSource/titan-darkknight/v1/.`,
      criteria: ['Kewky approves the model view (rest turnaround, parts, before/after test poses, deck close-up)', 'Rigid deck/ladders/gondola, re-weighted cloak/tabard chains, sockets as named empties, exported FBX for UE'],
    },
    {
      import_key: 'inflight:titan-darkknight-sol', title: 'Dark knight titan: Sol experiment (parallel Blender pass on the same source)',
      type: 'art', tier: 'B', priority: 'normal', branch: null, worktree: '/mnt/ue/ArtSource/titan-darkknight-sol',
      external_owner: 'codex Sol run (experiment)',
      description: `The experiment: the same phase-2 Blender brief run by Codex Sol. Brief ${briefs}/titan-darkknight-sol.md, result ${briefs}/titan-darkknight-sol-v1.md, renders /mnt/ue/ArtSource/titan-darkknight-sol/v1/. Compare with the Opus pass for Kewky.`,
      criteria: ['Model view delivered and compared against the Opus pass', 'Kewky picks which pass goes to the UE phase'],
    },
  ];
}

function importTribulation(board, opts = {}) {
  const src = { ...DEFAULTS, ...(opts.paths || {}) };
  const project = opts.project || 'tribulation';
  if (!board.project(project)) throw new Error(`project '${project}' missing`);
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
    if (/Titan phase 3/i.test(text)) d.depends_on = [flightIds['inflight:titan-darkknight']].filter(Boolean);
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

  for (const q of queue) {
    const pri = /^P0/.test(q.section) ? 'high' : /^P2/.test(q.section) ? 'low' : 'normal';
    add({
      import_key: `queue:${q.id}`, title: `${q.id} ${titleOf(q.text)}`, type: 'test', tier: 'C', priority: pri,
      assignee_slot: 'sonnet-tester', tags: ['imported', 'playtest'],
      description: `${q.id} ${q.text}\n\nSection: ${q.section}. Queue marker [${q.mark}]. Rules and setup: ${src.queue} (test the REAL build with REAL input through the playtest driver; results in /mnt/ue/testlab/results, bugs in BUGS.md). Owned by the systemd tester for now; not ready on the board until the orchestrator switches it over.`,
      criteria: [`${q.id} run on the current main build with real input; PASS/FAIL recorded with evidence in /mnt/ue/testlab/results`, 'Every failure filed in /mnt/ue/testlab/BUGS.md (steps, expected, actual, screenshot/log paths, main commit)'],
    });
    report.tests++;
  }
  report.created_count = report.created.length;
  board.changed('import', { n: report.created_count });
  return report;
}

module.exports = { importTribulation, parseTaskList, parseAudit, parseQueue, foldTarget, DEFAULTS };
