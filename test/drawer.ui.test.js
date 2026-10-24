// The bounty detail drawer in headless Chromium: notes from the human show in their own block,
// apart from orchestrator notes. Screenshots go to $BOARD_SHOTS_DIR when it is set (evidence).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { startBoard } = require('./helpers');

const CHROMIUM = process.env.CHROMIUM || '/usr/bin/chromium';
let chromium = null;
try { ({ chromium } = require('playwright-core')); } catch {}
const skip = !chromium ? 'playwright-core is not installed' : !fs.existsSync(CHROMIUM) ? `no chromium at ${CHROMIUM}` : false;
const SHOTS = process.env.BOARD_SHOTS_DIR;

test('drawer: human notes are shown apart from orchestrator notes', { skip, timeout: 90000 }, async () => {
  const t = await startBoard('drawerui', { dispatch: false });
  const browser = await chromium.launch({ executablePath: CHROMIUM, headless: true, args: ['--no-sandbox'] });
  try {
    const { board } = t;
    const b = board.create({ title: 'Pick the pump', project: 'scratch', criteria: ['a pump is picked'] });
    board.note(b.id, 'orchestrator: check the datasheet first');
    board.humanNote(b.id, { text: 'Use the 12 V one.\nThe 5 V one is too weak.', from: 'kewk' });
    board.markHumanRead(board.humanNotes().map(n => n.id));
    board.humanNote(b.id, { text: 'second human reply' });

    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    // Only the board itself unless screenshots are wanted (then the CDN styles load too).
    if (!SHOTS) await ctx.route(url => !url.href.startsWith(t.url), r => r.abort());
    const page = await ctx.newPage();
    await page.goto(t.url + '/');
    await page.waitForFunction(() => typeof openBounty === 'function');
    await page.evaluate(id => openBounty(id), b.id);
    await page.waitForSelector('#human-notes .human-note');

    const human = await page.$$eval('#human-notes .human-note', els => els.map(e => e.textContent.replace(/\s+/g, ' ').trim()));
    assert.strictEqual(human.length, 2);
    assert.match(human[0], /kewk · worker UNREAD · orchestrator read ?Use the 12 V one\. The 5 V one is too weak\./);
    assert.match(human[1], /human · worker UNREAD · orchestrator UNREAD ?second human reply/);
    const head = await page.$eval('#human-notes', e => e.firstElementChild.textContent.replace(/\s+/g, ' ').trim());
    assert.match(head, /From the human \(2\)/);
    // the orchestrator note is in the worker-note box, not in the human block (and vice versa)
    const block = await page.$eval('#human-notes', e => e.textContent);
    assert.doesNotMatch(block, /check the datasheet/);
    const orchBox = await page.$eval('#e-note', e => e.closest('div.mt-4').textContent);
    assert.match(orchBox, /check the datasheet first/);
    assert.doesNotMatch(orchBox, /12 V/);
    // multi-line text keeps its line breaks in the DOM
    assert.match(await page.$eval('#human-notes .human-note .whitespace-pre-wrap', e => e.textContent), /12 V one\.\nThe 5 V/);
    if (SHOTS) {
      fs.mkdirSync(SHOTS, { recursive: true });
      await page.waitForTimeout(800);
      await page.screenshot({ path: path.join(SHOTS, 'drawer-human-notes.png'), fullPage: false });
    }
  } finally { await browser.close(); await t.s.close(); }
});
