// Assignment-only work and the gap ledger: a worker starts only the bounty assigned to its slot, `next`
// never hands a worker unassigned work, split and add are the orchestrator's, and a gap a worker finds
// goes to the orchestrator (open row, bounty event, room line, presence count) and is decided there
// with what was done and why. Also the Status page's Gaps section in headless Chromium.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { startBoard, waitFor, ROOT } = require('./helpers');
const { workerPrompt } = require('../lib/prompt');

const CRIT = ['math.js exports mul(a, b) returning the product'];
const REFUSED = /workers can't create work; file a gap request: bounty gap "what is missing" --why "why it matters"/;

function cli(url, args, env = {}) {
  const { execFile } = require('child_process');
  return new Promise(resolve => execFile(process.execPath, [path.join(ROOT, 'bin', 'bounty'), ...args], {
    encoding: 'utf8', env: { ...process.env, BOUNTY_SLOT: '', BOUNTY_ID: '', BOUNTY_ACTOR: '', BOUNTY_URL: url, ...env },
  }, (err, out, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, out, err: stderr })));
}

// A stand-in for roomd (POST /api/r/<id>/join|post); every post is recorded.
function fakeRoom(id = 'gap-room') {
  const posts = [], members = new Set();
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => body += d).on('end', () => {
      const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      const parts = req.url.split('?')[0].split('/').filter(Boolean);
      if (parts[2] !== id) return send(404, { error: 'unknown room' });
      if (req.method === 'GET') return send(200, { id, admin: 'Conductor' });
      const b = JSON.parse(body || '{}');
      if (parts[3] === 'join') { members.add(b.as); return send(200, {}); }
      if (parts[3] === 'post') {
        if (!members.has(b.as)) return send(403, { error: `'${b.as}' has not joined: room_join first` });
        posts.push(b); return send(200, { seq: posts.length });
      }
      return send(404, {});
    });
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${srv.address().port}/r/${id}/`, id, posts,
    close: () => new Promise(c => { srv.closeAllConnections?.(); srv.close(() => c()); }) })));
}

test('start: a worker starts only the bounty assigned to its slot; unassigned is 403 and nothing is self-assigned', async () => {
  const t = await startBoard('gap-start', { dispatch: false });
  try {
    const { board, call, url } = t;
    const b = board.create({ title: 'loose', project: 'scratch', criteria: CRIT, status: 'ready' });
    // board level
    assert.throws(() => board.start(b.id, 'fake-1'), e => e.code === 403 && e.message === `bounty ${b.id} is not assigned to you; the orchestrator assigns work (ask it)`);
    assert.strictEqual(board.raw(b.id).assignee_slot, null);
    assert.strictEqual(board.raw(b.id).status, 'ready');
    // the real CLI as that worker
    let r = await cli(url, ['start'], { BOUNTY_ID: String(b.id), BOUNTY_SLOT: 'fake-1' });
    assert.notStrictEqual(r.code, 0);
    assert.match(r.err, new RegExp(`403: bounty ${b.id} is not assigned to you; the orchestrator assigns work \\(ask it\\)`));
    assert.strictEqual(board.raw(b.id).status, 'ready');
    // assigned to the other slot: still refused
    board.assign(b.id, 'fake-2');
    assert.strictEqual((await call('POST', `/bounties/${b.id}/start`, {}, 'fake-1')).status, 409);
    // assigned to this slot: starts
    r = await cli(url, ['start'], { BOUNTY_ID: String(b.id), BOUNTY_SLOT: 'fake-2' });
    assert.strictEqual(r.code, 0, r.err);
    assert.strictEqual(board.raw(b.id).status, 'in_progress');
    assert.strictEqual(board.raw(b.id).claimed_by, 'fake-2');
  } finally { await t.s.close(); }
});

test('dispatcher: an assigned bounty is spawned and started; an autopilot slot\'s unassigned pick is assigned before its worker starts; autopilot off never gets unassigned work', async () => {
  const cmd = ['bash', path.join(ROOT, 'test', 'fake-worker.sh')];
  const t = await startBoard('gap-dispatch', { dispatch: false, over: { slots: [
    { id: 'manual', name: 'Manual', runner: 'command', cmd, autopilot: false },
    { id: 'auto', name: 'Auto', runner: 'command', cmd, autopilot: true },
  ] } });
  try {
    const { board, s } = t;
    const loose = board.create({ title: 'loose', project: 'scratch', criteria: CRIT, status: 'ready', description: 'mode:stall' });
    // planning: only the autopilot slot may take the unassigned bounty
    assert.strictEqual(board.nextFor(board.slot('manual')), null, 'autopilot: false gets no unassigned work');
    assert.strictEqual(board.nextFor(board.slot('auto')).id, loose.id, 'autopilot: true may pick unassigned work (the orchestrator\'s config choice)');
    let plan = s.dispatcher.plan();
    assert.deepStrictEqual(plan.map(p => [p.slot.id, p.bounty.id]), [['auto', loose.id]]);
    // an assigned bounty goes to its slot
    const mine = board.create({ title: 'mine', project: 'scratch', criteria: CRIT, status: 'ready', assignee_slot: 'manual', description: 'mode:stall' });
    plan = s.dispatcher.plan();
    assert.deepStrictEqual(plan.map(p => [p.slot.id, p.bounty.id]).sort(), [['auto', loose.id], ['manual', mine.id]].sort());
    // the real dispatcher spawns both; each fake worker runs `bounty start` and it is accepted
    s.dispatcher.tick();
    await waitFor(() => board.raw(loose.id).status === 'in_progress' && board.raw(mine.id).status === 'in_progress', 20000);
    assert.strictEqual(board.raw(loose.id).assignee_slot, 'auto', 'the dispatcher assigned the autopilot pick before spawning');
    assert.strictEqual(board.raw(loose.id).claimed_by, 'auto');
    assert.strictEqual(board.raw(mine.id).claimed_by, 'manual');
    assert.ok(!board.get(loose.id).events.some(e => /not assigned to you/.test(e.note || '')));
  } finally { await t.s.close(); }
});

test('next: a worker only ever gets bounties assigned to its slot, autopilot or not', async () => {
  const cmd = ['bash', path.join(ROOT, 'test', 'fake-worker.sh')];
  const t = await startBoard('gap-next', { dispatch: false, over: { slots: [
    { id: 'auto', name: 'Auto', runner: 'command', cmd, autopilot: true },
    { id: 'manual', name: 'Manual', runner: 'command', cmd },
  ] } });
  try {
    const { board, call, url } = t;
    const loose = board.create({ title: 'loose', project: 'scratch', criteria: CRIT, status: 'ready', priority: 'critical' });
    assert.strictEqual(board.next('auto'), null);
    assert.strictEqual((await call('GET', '/next?slot=auto', null, 'auto')).data.next, null);
    let r = await cli(url, ['next'], { BOUNTY_SLOT: 'auto' });
    assert.strictEqual(r.code, 0, r.err);
    assert.match(r.out, /no ready bounty assigned to auto/);
    assert.doesNotMatch(r.out, new RegExp(`#${loose.id}`));
    r = await cli(url, ['next'], { BOUNTY_SLOT: 'manual' });
    assert.match(r.out, /no ready bounty assigned to manual/);
    // once assigned, next names it (and tells the worker not to start it itself)
    const mine = board.create({ title: 'mine', project: 'scratch', criteria: CRIT, status: 'ready', assignee_slot: 'auto' });
    assert.strictEqual(board.next('auto').id, mine.id);
    r = await cli(url, ['next'], { BOUNTY_SLOT: 'auto' });
    assert.match(r.out, new RegExp(`next for auto: #${mine.id} mine`));
    assert.match(r.out, /Don't start it yourself/);
    assert.strictEqual(board.next('manual'), null);
  } finally { await t.s.close(); }
});

test('split and add: workers get 403 with how to file a gap; the orchestrator splits', async () => {
  const t = await startBoard('gap-split', { dispatch: false });
  try {
    const { board, call, url } = t;
    const b = board.create({ title: 'parent', project: 'scratch', criteria: CRIT, status: 'ready', assignee_slot: 'fake-1' });
    board.start(b.id, 'fake-1');
    const before = board.db.prepare('SELECT COUNT(*) c FROM bounties').get().c;
    // API
    let res = await call('POST', `/bounties/${b.id}/split`, { title: 'extra work' }, 'fake-1');
    assert.strictEqual(res.status, 403);
    assert.match(res.data.error, REFUSED);
    res = await call('POST', '/bounties', { title: 'extra work', project: 'scratch' }, 'fake-1');
    assert.strictEqual(res.status, 403);
    assert.match(res.data.error, REFUSED);
    // the real CLI as the worker
    const r = await cli(url, ['split', 'extra work', '--desc', 'found it'], { BOUNTY_ID: String(b.id), BOUNTY_SLOT: 'fake-1' });
    assert.notStrictEqual(r.code, 0);
    assert.match(r.err, /403: workers can't create work; file a gap request: bounty gap/);
    assert.strictEqual(board.db.prepare('SELECT COUNT(*) c FROM bounties').get().c, before, 'no bounty was created');
    // the orchestrator: API and CLI
    res = await call('POST', `/bounties/${b.id}/split`, { title: 'child via api' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.parent_id, b.id);
    assert.strictEqual(res.data.status, 'backlog');
    const o = await cli(url, ['split', 'child via cli', '--parent', String(b.id), '--desc', 'the orchestrator made it']);
    assert.strictEqual(o.code, 0, o.err);
    assert.match(o.out, new RegExp(`split #\\d+ from #${b.id}: child via cli \\[backlog\\]`));
    assert.deepStrictEqual(board.get(b.id).children.map(c => c.title), ['child via api', 'child via cli']);
  } finally { await t.s.close(); }
});

test('gaps: a worker files one (open, event, orchestrator notified, bounty unchanged); only the orchestrator decides, with action and why; the ledger shows it', async () => {
  const room = await fakeRoom();
  const t = await startBoard('gap-ledger', { dispatch: false, over: { orchestrator: 'Conductor', room: { id: room.id, url: room.url } } });
  try {
    const { board, call, url } = t;
    const b = board.create({ title: 'the bounty', project: 'scratch', criteria: CRIT, status: 'ready', assignee_slot: 'fake-1', description: 'do the thing' });
    board.start(b.id, 'fake-1');
    const other = board.create({ title: 'someone else', project: 'scratch', criteria: CRIT, status: 'ready', assignee_slot: 'fake-2' });
    const snap = id => { const x = board.raw(id); return { status: x.status, title: x.title, description: x.description, criteria: x.criteria, assignee_slot: x.assignee_slot, priority: x.priority, tier: x.tier }; };
    const before = snap(b.id);
    const bountiesBefore = board.db.prepare('SELECT COUNT(*) c FROM bounties').get().c;
    const w = { BOUNTY_ID: String(b.id), BOUNTY_SLOT: 'fake-1' };

    // filing: --why is required; the gap text too
    let r = await cli(url, ['gap', 'the importer drops BOM rows'], w);
    assert.notStrictEqual(r.code, 0); assert.match(r.err, /--why is required/);
    r = await cli(url, ['gap', '--why', 'x'], w);
    assert.notStrictEqual(r.code, 0); assert.match(r.err, /usage: bounty gap/);
    assert.strictEqual((await call('POST', `/bounties/${b.id}/gaps`, { gap: 'x' }, 'fake-1')).status, 400);
    // a worker files gaps only from its own bounty
    assert.strictEqual((await call('POST', `/bounties/${other.id}/gaps`, { gap: 'x', why: 'y' }, 'fake-1')).status, 403);

    r = await cli(url, ['gap', 'the importer drops rows with a BOM', '--why', 'half the March data is missing', '--suggest', 'strip the BOM in lib/importer.js'], w);
    assert.strictEqual(r.code, 0, r.err);
    assert.match(r.out, new RegExp(`gap #1 on #${b.id} posed to the orchestrator: the importer drops rows with a BOM`));
    assert.match(r.out, /Do not act on it/);
    const g = board.gaps.row(1);
    assert.strictEqual(g.status, 'open');
    assert.strictEqual(g.bounty_id, b.id);
    assert.strictEqual(g.from_actor, 'fake-1');
    assert.strictEqual(g.why, 'half the March data is missing');
    assert.strictEqual(g.suggestion, 'strip the BOM in lib/importer.js');
    assert.strictEqual(g.decision, null);
    // the bounty's scope and status did not change, and no work was created
    assert.deepStrictEqual(snap(b.id), before);
    assert.strictEqual(board.db.prepare('SELECT COUNT(*) c FROM bounties').get().c, bountiesBefore);
    // a bounty event records it (its own kind: not a note the worker's inbox would get)
    const ev = board.get(b.id).events.filter(e => e.kind === 'gap');
    assert.strictEqual(ev.length, 1);
    assert.strictEqual(ev[0].actor, 'fake-1');
    assert.match(ev[0].note, /gap #1 posed to the orchestrator \(not acted on\): the importer drops rows with a BOM/);
    assert.strictEqual(board.notes(b.id).length, 0, 'not an orchestrator note');
    // the orchestrator is notified: its room line, and the open count in its presence
    await waitFor(() => room.posts.length === 1, 5000);
    assert.strictEqual(room.posts[0].text, `@Conductor GAP #1 on #${b.id} from Alpha: a gap outside the bounty waits for your decision (not acted on). bounty gaps`);
    assert.doesNotMatch(room.posts[0].text, /BOM/, 'the gap text stays on the board');
    assert.strictEqual((await call('GET', '/orchestrator')).data.open_gaps, 1);
    assert.strictEqual((await call('GET', '/state')).data.orchestrator.open_gaps, 1);
    // workers can't list the ledger with the CLI or decide
    r = await cli(url, ['gaps'], w);
    assert.notStrictEqual(r.code, 0); assert.match(r.err, /'gaps' is an orchestrator command/);
    r = await cli(url, ['gap-decide', '1', '--decision', 'rejected', '--action', 'nothing', '--why', 'mine'], w);
    assert.notStrictEqual(r.code, 0); assert.match(r.err, /403: gap-decide is an orchestrator action/);
    assert.strictEqual((await call('POST', '/gaps/1/decide', { decision: 'later', action: 'a', reason: 'b' }, 'fake-1')).status, 403);
    assert.strictEqual(board.gaps.row(1).status, 'open');

    // the orchestrator's ledger
    r = await cli(url, ['gaps']);
    assert.strictEqual(r.code, 0, r.err);
    assert.match(r.out, /GAP #1 {2}OPEN .* from fake-1 \(Alpha\) on #\d+ the bounty\n {4}gap: the importer drops rows with a BOM\n {4}why: half the March data is missing\n {4}suggested: strip the BOM/);

    // deciding: action and why are required, "now" needs the bounty that fills it
    r = await cli(url, ['gap-decide', '1', '--decision', 'later', '--why', 'not now']);
    assert.notStrictEqual(r.code, 0); assert.match(r.err, /400: --action \(what was done\) is required/);
    r = await cli(url, ['gap-decide', '1', '--decision', 'later', '--action', 'noted']);
    assert.notStrictEqual(r.code, 0); assert.match(r.err, /400: --why \(the reason\) is required/);
    r = await cli(url, ['gap-decide', '1', '--decision', 'later', '--action', '--why', 'x']);
    assert.notStrictEqual(r.code, 0); assert.match(r.err, /400: --action/, 'a bare --action is missing, not "true"');
    r = await cli(url, ['gap-decide', '1', '--decision', 'now', '--action', 'made a bounty', '--why', 'blocks the report']);
    assert.notStrictEqual(r.code, 0); assert.match(r.err, /400: a "now" decision needs --bounty/);
    r = await cli(url, ['gap-decide', '1', '--decision', 'maybe', '--action', 'a', '--why', 'b']);
    assert.notStrictEqual(r.code, 0); assert.match(r.err, /400: --decision must be one of now, later, rejected/);
    assert.strictEqual((await call('POST', '/gaps/1/decide', { decision: 'now', action: 'a', reason: 'b', bounty: 9999 })).status, 400);
    assert.strictEqual((await call('POST', '/gaps/99/decide', { decision: 'later', action: 'a', reason: 'b' })).status, 404);
    assert.strictEqual(board.gaps.row(1).status, 'open');

    const fill = board.create({ title: 'Strip the BOM in the importer', project: 'scratch', criteria: CRIT, assignee_slot: 'fake-2' });
    r = await cli(url, ['gap-decide', '1', '--decision', 'now', '--bounty', String(fill.id), '--action', `made #${fill.id} for fake-2`, '--why', 'it blocks the March report']);
    assert.strictEqual(r.code, 0, r.err);
    assert.match(r.out, new RegExp(`gap #1 decided: now -> #${fill.id}; action: made #${fill.id} for fake-2; why: it blocks the March report`));
    const d = board.gaps.row(1);
    assert.deepStrictEqual([d.status, d.decision, d.action, d.reason, d.new_bounty_id, d.decided_by], ['decided', 'now', `made #${fill.id} for fake-2`, 'it blocks the March report', fill.id, 'orchestrator']);
    assert.ok(d.decided_at);
    assert.match(board.get(b.id).events.filter(e => e.kind === 'gap')[1].note, new RegExp(`gap #1 decided by orchestrator: now -> #${fill.id}; action: made #${fill.id} for fake-2; why: it blocks the March report`));
    assert.strictEqual((await call('GET', '/orchestrator')).data.open_gaps, 0);
    assert.deepStrictEqual(snap(b.id), before, 'deciding does not touch the bounty the gap came from either');

    // a second gap, decided "rejected"; and a third left open
    await call('POST', `/bounties/${b.id}/gaps`, { gap: 'rename the CLI', why: 'nicer' }, 'fake-1');
    await call('POST', '/gaps/2/decide', { decision: 'rejected', action: 'nothing', reason: 'out of the project\'s goals' });
    await call('POST', `/bounties/${b.id}/gaps`, { gap: 'tests are slow', why: 'ci takes 9 minutes' }, 'fake-1');

    // the ledger: API (open first), CLI --all and --json
    const all = (await call('GET', '/gaps')).data;
    assert.deepStrictEqual(all.map(x => [x.id, x.status, x.decision]), [[3, 'open', null], [2, 'decided', 'rejected'], [1, 'decided', 'now']]);
    assert.deepStrictEqual(all[2].new_bounty, { id: fill.id, title: 'Strip the BOM in the importer', status: 'backlog' });
    assert.strictEqual(all[2].from_name, 'Alpha');
    assert.deepStrictEqual((await call('GET', '/gaps?status=open')).data.map(x => x.id), [3]);
    r = await cli(url, ['gaps', '--all']);
    assert.strictEqual(r.code, 0, r.err);
    assert.match(r.out, new RegExp(`GAP #1 {2}decided: NOW[\\s\\S]*action: made #${fill.id} for fake-2\\n {4}reason: it blocks the March report\\n {4}bounty: #${fill.id} Strip the BOM in the importer \\[backlog\\]`));
    assert.match(r.out, /3 gaps, 1 open/);
    r = await cli(url, ['gaps', '--json']);
    assert.deepStrictEqual(JSON.parse(r.out).map(x => x.id), [3]);
    // the orchestrator's register output and status line say how many wait
    r = await cli(url, ['orchestrator', 'register', '--pid', String(process.pid), '--name', 'Conductor']);
    assert.strictEqual(r.code, 0, r.err);
    assert.match(r.out, /1 open gap request from workers waiting for a decision: bounty gaps/);
    r = await cli(url, ['orchestrator']);
    assert.match(r.out, /Conductor ONLINE .*\| 1 open gap \(bounty gaps\)/);
    await waitFor(() => room.posts.length === 3, 5000);
  } finally { await t.s.close(); await room.close(); }
});

test('worker prompt: the hard rules (assigned work only, never start/split/create, every gap through bounty gap, never acted on)', async () => {
  const t = await startBoard('gap-prompt', { dispatch: false });
  try {
    const { board } = t;
    const b = board.create({ title: 'x', project: 'scratch', criteria: CRIT, assignee_slot: 'fake-1' });
    const p = workerPrompt(board, { ...board.need(b.id), attempts: 1 }, board.slot('fake-1'), { worktree: t.repo, branch: 'x' });
    assert.match(p, /# Hard rules: assigned work only, gaps go to the orchestrator/);
    assert.match(p, new RegExp(`Work only on bounty #${b.id}, the bounty the orchestrator assigned to you\\. Never start, split or create any other work`));
    assert.match(p, /Every gap you find outside this bounty[^\n]*goes to the orchestrator through `bounty gap`[^\n]*Never act on a gap yourself/);
    assert.match(p, /4\. `bounty gap "<what is missing>" --why "<why it matters>"/);
    assert.doesNotMatch(p, /`bounty split "<title>"/, 'workers are no longer told to split');
  } finally { await t.s.close(); }
});

// The Status page's Gaps section: every gap with date, who asked, the gap, decision, action, why and the
// bounty it became; open first and highlighted; worker text escaped; no horizontal scroll at phone width.
// Screenshots go to $BOARD_SHOTS_DIR when it is set (evidence).
const CHROMIUM = process.env.CHROMIUM || '/usr/bin/chromium';
let chromium = null;
try { ({ chromium } = require('playwright-core')); } catch {}
const skip = !chromium ? 'playwright-core is not installed' : !fs.existsSync(CHROMIUM) ? `no chromium at ${CHROMIUM}` : false;

test('status page: the Gaps section lists the ledger, open first and highlighted, escaped, phone width', { skip, timeout: 120000 }, async () => {
  const t = await startBoard('gap-ui', { dispatch: false });
  const browser = await chromium.launch({ executablePath: CHROMIUM, headless: true, args: ['--no-sandbox'] });
  try {
    const { board } = t;
    const b = board.create({ title: 'Importer work', project: 'scratch', criteria: CRIT, status: 'ready', assignee_slot: 'fake-1' });
    const fill = board.create({ title: 'Strip the BOM', project: 'scratch', criteria: CRIT, assignee_slot: 'fake-2' });
    board.gaps.file(b.id, { gap: 'rows with a BOM are dropped', why: 'March data missing', suggestion: 'strip it' }, 'fake-1');
    board.gaps.decide(1, { decision: 'now', action: `made #${fill.id}`, reason: 'blocks the report', bounty: fill.id });
    board.gaps.file(b.id, { gap: '<img src=x onerror="window.pwned=1"> broken', why: 'xss check' }, 'fake-1');
    for (const vp of [{ width: 390, height: 844, tag: 'phone' }, { width: 1280, height: 900, tag: 'desktop' }]) {
      const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
      if (!process.env.BOARD_SHOTS_DIR) await ctx.route(u => !u.href.startsWith(t.url), r => r.abort());
      const page = await ctx.newPage();
      await page.goto(t.url + '/status.html');
      await page.waitForSelector('#st-gaps .st-gap');
      const cards = await page.$$eval('#st-gaps .st-gap', els => els.map(e => ({ id: e.dataset.gap, cls: e.className, text: e.innerText })));
      assert.deepStrictEqual(cards.map(c => c.id), ['2', '1'], 'open first');
      assert.match(cards[0].cls, /st-gap-open/);
      assert.match(cards[0].text, /Open: waiting on the orchestrator/i);
      assert.match(cards[0].text, /<img src=x onerror="window\.pwned=1"> broken/, 'shown as text');
      assert.strictEqual(await page.evaluate(() => window.pwned), undefined);
      assert.match(cards[1].text, /GAP #1/);
      assert.match(cards[1].text, /asked by Alpha fake-1 on #\d+ Importer work/);
      assert.match(cards[1].text, /rows with a BOM are dropped/);
      assert.match(cards[1].text, /DECISION\s+Now · orchestrator/i);
      assert.match(cards[1].text, new RegExp(`ACTION\\s+made #${fill.id}`, 'i'));
      assert.match(cards[1].text, /WHY\s+blocks the report/i);
      assert.match(cards[1].text, new RegExp(`BECAME\\s+#${fill.id} Strip the BOM`, 'i'));
      assert.match(await page.textContent('#st-gcount'), /1 open · 1 decided/);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(overflow <= 0, `no horizontal scroll at ${vp.width}px (overflow ${overflow})`);
      if (process.env.BOARD_SHOTS_DIR) {
        await page.locator('#st-gaps-section').screenshot({ path: path.join(process.env.BOARD_SHOTS_DIR, `status-gaps-${vp.tag}.png`) });
      }
      await ctx.close();
    }
    // a themed status.html (a board's own public_dir copy) without the slot still gets the section, before Finished
    const themed = fs.readFileSync(path.join(ROOT, 'public', 'status.html'), 'utf8').replace(/\s*<section id="st-gaps-section">.*?<\/section>/s, '');
    assert.doesNotMatch(themed, /st-gaps/);
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await ctx.route(u => !u.href.startsWith(t.url), r => r.abort());
    await ctx.route(t.url + '/status.html', r => r.fulfill({ contentType: 'text/html', body: themed }));
    const page = await ctx.newPage();
    await page.goto(t.url + '/status.html');
    await page.waitForSelector('#st-gaps .st-gap');
    const order = await page.$$eval('.st-wrap > section', els => els.map(e => e.id || e.querySelector('h2').textContent.trim().split(/\s/)[0]));
    assert.deepStrictEqual(order.slice(-2), ['st-gaps-section', 'Finished,']);
    await ctx.close();
  } finally { await browser.close(); await t.s.close(); }
});
