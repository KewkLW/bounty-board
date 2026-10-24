// The Needs you reply boxes in headless Chromium (playwright-core, system chromium): typing, Enter
// sends, an error keeps the text, "saved on the board, not delivered live", the Done flow by
// keyboard, the item leaving Needs you, and a 390 px phone layout. Screenshots go to $HUB_SHOTS_DIR.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpdir } = require('./helpers');
const { busyBoard, quietBoard, fakeBoard, registerFake, startHub } = require('./hub-fixtures');

const CHROMIUM = process.env.CHROMIUM || '/usr/bin/chromium';
let chromium = null;
try { ({ chromium } = require('playwright-core')); } catch {}
const skip = !chromium ? 'playwright-core is not installed' : !fs.existsSync(CHROMIUM) ? `no chromium at ${CHROMIUM}` : false;
const SHOTS = process.env.HUB_SHOTS_DIR;

test('hub page: reply box, Send, Done, errors kept inline, 390 px', { skip, timeout: 90000 }, async () => {
  const tmp = tmpdir('hubreplyui');
  const dir = path.join(tmp, 'boards');
  // The live hook "delivers" unless the text says nodeliver.
  const hook = path.join(tmp, 'hook.js');
  fs.writeFileSync(hook, "if (process.argv[2].includes('nodeliver')) { console.error('relay offline'); process.exit(1); }\n");
  const busy = await fakeBoard(busyBoard());
  const quiet = quietBoard();
  quiet.bounties[1].blocked_reason = 'Waiting on you: which label printer?';
  const arch = await fakeBoard(quiet);
  registerFake(dir, busy.port, { name: 'Rocket Garden', default_project: 'rocket', accent: '#bb9af7' });
  registerFake(dir, arch.port, { name: 'Archive Cleanup', default_project: 'archive', accent: '#e0af68' });
  const hub = await startHub(dir, { human_name: 'Test Human', on_reply: [process.execPath, hook, '{text}'] });
  const browser = await chromium.launch({ executablePath: CHROMIUM, headless: true, args: ['--no-sandbox'] });
  const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name), fullPage: true }); } };
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    if (!SHOTS) await ctx.route(url => !url.href.startsWith(hub.url), r => r.abort());
    const page = await ctx.newPage();
    await page.goto(hub.url + '/');
    await page.waitForSelector('#hub-needs .hub-reply');
    const box = (port, id, panel = '#panel-all') => page.locator(`${panel} .hub-reply-wrap[data-k="${port}-${id}"]`);
    const sensor = box(busy.port, 4);
    const printer = box(arch.port, 2);

    // Every Needs you item: a text box, Send, Done; the project tab's waiting-on-you item too.
    assert.strictEqual(await page.locator('#hub-needs .hub-need').count(), 2);
    for (const b of [sensor, printer, box(busy.port, 4, '#panel-p' + busy.port)]) {
      assert.strictEqual(await b.locator('input.hub-reply-text').count(), 1);
      assert.deepStrictEqual(await b.locator('button').allTextContents(), ['Send', 'Done, unblock it']);
    }
    assert.strictEqual(await page.locator(`#panel-p${busy.port} .hub-reply`).count(), 1, 'only the item waiting on a person gets a box');

    // A failing board: the error shows inline and the typed text is kept.
    const input = sensor.locator('input');
    await input.fill('plugged in, port 2');
    busy.fixture.reply_status = 500;
    await input.press('Enter');
    await sensor.locator('.hub-reply-err').waitFor();
    assert.match(await sensor.locator('.hub-reply-err').textContent(), /bad day.*Your text is kept/);
    assert.strictEqual(await sensor.locator('input').inputValue(), 'plugged in, port 2');
    assert.ok(await sensor.locator('input').evaluate(el => el === document.activeElement), 'focus is back in the box');
    await shot(page, 'reply-error.png');

    // Enter sends: the sent message and its time show, the box empties, the hook delivered it.
    delete busy.fixture.reply_status;
    await sensor.locator('input').press('Enter');
    await sensor.locator('.hub-sent').waitFor();
    const sent = (await sensor.locator('.hub-sent').textContent()).replace(/\s+/g, ' ');
    assert.match(sent, /You: plugged in, port 2 · \d{1,2}:\d{2}/);
    assert.match(sent, /delivered/);
    assert.strictEqual(await sensor.locator('input').inputValue(), '');
    assert.deepStrictEqual(busy.fixture.received.at(-1).body, { text: 'plugged in, port 2', from: 'Test Human', unblock: false });
    assert.strictEqual(busy.fixture.bounties[3].status, 'blocked', 'Send does not unblock');
    // The same message shows on the project tab's copy of the item.
    assert.match(await box(busy.port, 4, '#panel-p' + busy.port).locator('.hub-sent').textContent(), /plugged in, port 2/);

    // The hook fails: saved on the board, not delivered live; the reply itself succeeded.
    await sensor.locator('input').fill('nodeliver: second thought');
    await sensor.getByRole('button', { name: 'Send' }).click();
    await sensor.locator('.hub-sent', { hasText: 'second thought' }).waitFor();
    assert.match(await sensor.locator('.hub-undelivered').textContent(), /saved on the board, not delivered live/);
    await shot(page, 'reply-sent.png');

    // An empty Send asks for text and sends nothing.
    const n = busy.fixture.received.length;
    await sensor.getByRole('button', { name: 'Send' }).click();
    await sensor.locator('.hub-reply-err', { hasText: 'Type a message first' }).waitFor();
    assert.strictEqual(busy.fixture.received.length, n);

    // Keyboard: Tab from the box reaches Send, then Done; Enter on Done with an empty box sends "Done" and unblocks.
    await printer.locator('input').focus();
    await page.keyboard.press('Tab');
    assert.strictEqual(await page.evaluate(() => document.activeElement.textContent), 'Send');
    await page.keyboard.press('Tab');
    assert.strictEqual(await page.evaluate(() => document.activeElement.textContent), 'Done, unblock it');
    await page.keyboard.press('Enter');
    await printer.locator('.hub-sent').waitFor();
    assert.match((await printer.locator('.hub-sent').textContent()).replace(/\s+/g, ' '), /You: Done · .*unblocked, leaves Needs you on the next refresh/);
    assert.deepStrictEqual(arch.fixture.received.at(-1).body, { text: 'Done', from: 'Test Human', unblock: true });
    assert.ok(await printer.locator('form').isHidden(), 'nothing more to send once unblocked');
    await shot(page, 'reply-done.png');
    // The next refresh drops it from Needs you.
    await page.waitForFunction(() => document.querySelectorAll('#hub-needs .hub-need').length === 1, null, { timeout: 10000 });
    assert.match(await page.locator('#hub-needs .hub-need').textContent(), /Soil sensor/);
    await page.reload();
    await page.waitForSelector('#hub-needs .hub-need');
    assert.strictEqual(await page.locator('#hub-needs .hub-need').count(), 1, 'still gone after a reload');

    // Phone: 390 px, the box and both buttons fit, nothing scrolls sideways.
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    if (!SHOTS) await phone.route(url => !url.href.startsWith(hub.url), r => r.abort());
    const m = await phone.newPage();
    await m.goto(hub.url + '/');
    await m.waitForSelector('#hub-needs .hub-reply');
    await m.fill('#hub-needs .hub-reply-text', 'typed on the phone');
    const fit = await m.evaluate(() => ({
      width: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
      parts: [...document.querySelectorAll('#hub-needs .hub-reply input, #hub-needs .hub-reply button')].map(el => { const r = el.getBoundingClientRect(); return [r.left, r.right, r.height]; }),
    }));
    assert.ok(fit.width <= 390, `fits 390 px (scrollWidth ${fit.width})`);
    for (const [l, r, h] of fit.parts) { assert.ok(l >= 0 && r <= 390, `inside the screen (${l}..${r})`); assert.ok(h >= 40, `touch target ${h} px tall`); }
    await shot(m, 'reply-390.png');
    await m.tap(`#hub-needs .hub-reply button[data-act=send]`);
    await m.locator('#hub-needs .hub-sent', { hasText: 'typed on the phone' }).waitFor();
    assert.ok(await m.evaluate(() => document.documentElement.scrollWidth) <= 390);
    await phone.close();
  } finally {
    await browser.close();
    await hub.close(); await busy.close(); await arch.close();
  }
});
