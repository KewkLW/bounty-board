// The hub page in headless Chromium (playwright-core, system chromium): the All tab, Needs you,
// tab switching by mouse and keyboard, and a 390 px phone layout without sideways scroll.
// Screenshots go to $HUB_SHOTS_DIR when it is set (the evidence for docs/evidence).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpdir } = require('./helpers');
const { busyBoard, quietBoard, fakeBoard, deadPort, registerFake, startHub } = require('./hub-fixtures');

const CHROMIUM = process.env.CHROMIUM || '/usr/bin/chromium';
let chromium = null;
try { ({ chromium } = require('playwright-core')); } catch {}
const skip = !chromium ? 'playwright-core is not installed' : !fs.existsSync(CHROMIUM) ? `no chromium at ${CHROMIUM}` : false;
const SHOTS = process.env.HUB_SHOTS_DIR;

test('hub page: All tab, Needs you, tabs by click and arrow keys, 390 px phone', { skip, timeout: 90000 }, async () => {
  const dir = path.join(tmpdir('hubui'), 'boards');
  const busy = await fakeBoard(busyBoard());
  const quiet = await fakeBoard(quietBoard());
  const gone = await deadPort();
  registerFake(dir, gone, { name: 'Gone Board' });
  registerFake(dir, quiet.port, { name: 'Archive Cleanup', default_project: 'archive', accent: '#e0af68' });
  registerFake(dir, busy.port, { name: 'Rocket Garden', default_project: 'rocket', accent: '#bb9af7' });
  const hub = await startHub(dir);
  const browser = await chromium.launch({ executablePath: CHROMIUM, headless: true, args: ['--no-sandbox'] });
  const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name), fullPage: true }); } };
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    // Only the hub itself: the CDN and web fonts are progressive enhancement, the layout is local CSS.
    if (!SHOTS) await ctx.route(url => !url.href.startsWith(hub.url), r => r.abort());
    const page = await ctx.newPage();
    await page.goto(hub.url + '/');
    await page.waitForSelector('#hub-cards .hub-card');

    // Tabs: All first, then projects with offline last.
    const tabs = await page.$$eval('[role=tablist] [role=tab]', els => els.map(e => [[...e.querySelectorAll('span:not(.hub-dot)')].map(x => x.textContent).join(' '), e.getAttribute('aria-selected'), e.tabIndex]));
    assert.deepStrictEqual(tabs, [['All 2', 'true', 0], ['Rocket Garden 1', 'false', -1], ['Archive Cleanup 1', 'false', -1], ['Gone Board', 'false', -1]]);

    // Needs you: every blocked item with its project and reason.
    const needs = await page.$$eval('#hub-needs .hub-need', els => els.map(e => e.textContent.replace(/\s+/g, ' ').trim()));
    assert.strictEqual(needs.length, 2);
    assert.match(needs[0], /#4 Rocket Garden G2\.2 Soil sensor needs the sensor plugged in by a human/);
    assert.match(needs[1], /#2 Archive Cleanup Label the boxes which label printer\?/);

    // Cards: headline, Now goal with its bar, working count, red blocked count; offline last.
    const cards = await page.$$eval('#hub-cards .hub-card', els => els.map(e => ({
      name: e.querySelector('.hub-card-name').textContent, text: e.textContent.replace(/\s+/g, ' '),
      bar: e.querySelector('.st-bar span')?.style.width ?? null, blocked: e.querySelector('.hub-blocked')?.textContent ?? null,
      blockedColor: e.querySelector('.hub-blocked') ? getComputedStyle(e.querySelector('.hub-blocked')).backgroundColor : null,
    })));
    assert.deepStrictEqual(cards.map(c => c.name), ['Rocket Garden', 'Archive Cleanup', 'Gone Board']);
    assert.match(cards[0].text, /Pump is in, sensor waits on a human/);
    assert.match(cards[0].text, /Now: G2 Self-watering/);
    assert.match(cards[0].text, /1 working/);
    assert.strictEqual(cards[0].bar, '0%');
    assert.strictEqual(cards[0].blocked, '1 blocked');
    assert.strictEqual(cards[0].blockedColor, 'rgb(247, 118, 142)', 'the blocked count is red');
    assert.match(cards[2].text, /offline/);
    await shot(page, 'hub-all-desktop.png');

    // Click a project tab: its panel, accent, link to the board.
    await page.click('#tab-p' + busy.port);
    const panel = page.locator('#panel-p' + busy.port);
    assert.ok(await panel.isVisible());
    assert.ok(await page.locator('#panel-all').isHidden());
    assert.strictEqual(await page.getAttribute('#tab-p' + busy.port, 'aria-selected'), 'true');
    const p = await panel.evaluate(el => ({
      accent: getComputedStyle(el).getPropertyValue('--st-accent').trim(), text: el.textContent.replace(/\s+/g, ' '),
      link: el.querySelector('.hub-links a').getAttribute('href'),
    }));
    assert.strictEqual(p.accent, '#bb9af7');
    assert.strictEqual(p.link, `http://127.0.0.1:${busy.port}/`);
    for (const s of ['From the orchestrator', 'The pump works.', 'First sprout', 'Reached', 'Self-watering', 'Now', 'Fern', 'G2.1 Water pump',
      'needs the sensor plugged in by a human', 'G2.3 Dashboard', 'G1.2 Gate: first sprout']) assert.ok(p.text.includes(s), `project tab shows "${s}"`);
    assert.ok(!p.text.includes('G1.1 Seed tray just now'), 'finished > 24 h ago is not in the recent list');
    assert.match(page.url(), new RegExp(`#p${busy.port}$`));
    await shot(page, 'hub-project-desktop.png');

    // Keyboard: arrows move focus and selection, wrapping; Home goes back to All.
    await page.focus('#tab-p' + busy.port);
    await page.keyboard.press('ArrowRight');
    assert.strictEqual(await page.evaluate(() => document.activeElement.id), 'tab-p' + quiet.port);
    assert.ok(await page.locator('#panel-p' + quiet.port).isVisible());
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    assert.strictEqual(await page.evaluate(() => document.activeElement.id), 'tab-all', 'wraps around');
    await page.keyboard.press('ArrowLeft');
    assert.strictEqual(await page.evaluate(() => document.activeElement.id), 'tab-p' + gone);
    assert.match(await page.locator('#panel-p' + gone).textContent(), /does not answer/);
    await page.keyboard.press('Home');
    assert.strictEqual(await page.getAttribute('#tab-all', 'aria-selected'), 'true');

    // A card opens its project tab.
    await page.click(`#hub-cards .hub-card[data-tab="p${quiet.port}"]`);
    assert.ok(await page.locator('#panel-p' + quiet.port).isVisible());

    // The selected tab survives a reload (the page refreshes every 30 s through the same render).
    await page.reload();
    await page.waitForSelector('[role=tab]');
    assert.strictEqual(await page.getAttribute('#tab-p' + quiet.port, 'aria-selected'), 'true');
    await ctx.close();

    // Phone: 390 px wide, nothing scrolls sideways, on All and on a project tab.
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    if (!SHOTS) await phone.route(url => !url.href.startsWith(hub.url), r => r.abort());
    const m = await phone.newPage();
    await m.goto(hub.url + '/');
    await m.waitForSelector('#hub-cards .hub-card');
    const width = () => m.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth));
    assert.ok(await width() <= 390, `All tab fits 390 px (scrollWidth ${await width()})`);
    await shot(m, 'hub-all-390.png');
    await m.click('#tab-p' + busy.port);
    assert.ok(await width() <= 390, `project tab fits 390 px (scrollWidth ${await width()})`);
    await shot(m, 'hub-project-390.png');
    await phone.close();
  } finally {
    await browser.close();
    await hub.close(); await busy.close(); await quiet.close();
  }
});
