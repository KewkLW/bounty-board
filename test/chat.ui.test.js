// The Chat tab in headless Chromium: the dock link on every page when the board has a room (and not
// without one), chat.html framing the room page full height at desktop and phone width, and a
// loopback room URL rewritten to the host the page was opened on (the tailnet from a phone).
// A fake room page stands in for roomd. Screenshots go to $BOARD_SHOTS_DIR when it is set (evidence).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { startBoard } = require('./helpers');

const CHROMIUM = process.env.CHROMIUM || '/usr/bin/chromium';
let chromium = null;
try { ({ chromium } = require('playwright-core')); } catch {}
const skip = !chromium ? 'playwright-core is not installed' : !fs.existsSync(CHROMIUM) ? `no chromium at ${CHROMIUM}` : false;
const SHOTS = process.env.BOARD_SHOTS_DIR;
const PAGES = ['/', '/live', '/status.html', '/roster', '/leaderboard'];

function fakeRoomPage(id) {
  const html = `<!doctype html><html><body style="margin:0;height:100vh;display:flex;background:#20141a;color:#f3e6d0;font:14px sans-serif">
<aside id="members" style="width:180px;padding:12px;border-right:1px solid #634">Members<br>Conductor<br>Scratch Board<br>Alpha</aside>
<main style="flex:1;display:flex;flex-direction:column"><div id="log" style="flex:1;padding:12px">@Conductor Alpha (fake-1) finished #1 Add mul(): submitted. Alpha is idle: what's next?</div>
<input id="msg" placeholder="Message the room (@ to mention)" style="margin:12px;padding:10px"></main></body></html>`;
  const srv = http.createServer((req, res) => {
    if (req.url.startsWith(`/r/${id}/`)) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(html); }
    res.writeHead(404); res.end();
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${srv.address().port}/r/${id}/`, close: () => new Promise(c => srv.close(c)) })));
}

test('chat tab: dock link on every page, the room framed full height on desktop and phone', { skip, timeout: 120000 }, async () => {
  const fr = await fakeRoomPage('scratch-room');
  const t = await startBoard('chatui', { dispatch: false, over: { name: 'Scratch Board', room: { id: 'scratch-room', url: fr.url } } });
  const browser = await chromium.launch({ executablePath: CHROMIUM, headless: true, args: ['--no-sandbox'] });
  try {
    for (const vp of [{ width: 1280, height: 900, tag: 'desktop' }, { width: 390, height: 844, tag: 'phone' }]) {
      const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
      if (!SHOTS) await ctx.route(u => !u.href.startsWith(t.url) && !u.href.startsWith(fr.url), r => r.abort());
      const page = await ctx.newPage();
      for (const p of PAGES) {
        await page.goto(t.url + p);
        const link = page.locator('.op-dock a[data-chat-tab]');
        await link.waitFor({ state: 'visible', timeout: 10000 });
        assert.strictEqual(await link.getAttribute('href'), '/chat.html', p);
        // next to Status
        const order = await page.$$eval('.op-dock a', as => as.map(a => a.textContent.trim()));
        assert.ok(order.findIndex(x => /Chat$/.test(x)) === order.findIndex(x => /Status$/.test(x)) + 1, `${p}: ${order}`);
      }
      await page.goto(t.url + '/chat.html');
      const frame = page.locator('#ch-frame');
      await frame.waitFor({ state: 'visible' });
      assert.strictEqual(await frame.getAttribute('src'), fr.url);
      const inner = page.frameLocator('#ch-frame');
      await inner.locator('#members').waitFor();
      assert.match(await inner.locator('#log').textContent(), /what's next\?/);
      const box = await frame.boundingBox();
      const dock = await page.locator('.op-dock').boundingBox();
      assert.strictEqual(Math.round(box.width), vp.width, 'full width');
      assert.ok(box.y <= 40, `starts under the bar (${box.y})`);
      assert.ok(box.y + box.height <= dock.y + 1, `ends above the dock (${box.y + box.height} vs ${dock.y})`);
      assert.ok(box.height >= vp.height - 140, `fills the height (${box.height} of ${vp.height})`);
      assert.ok(await page.locator('.op-dock a.on[data-chat-tab]').isVisible(), 'Chat is the active tab');
      // the six dock items fit the phone width
      assert.ok(dock.x >= 0 && dock.x + dock.width <= vp.width, 'dock fits');
      if (SHOTS) {
        fs.mkdirSync(SHOTS, { recursive: true });
        await page.waitForTimeout(800);
        await page.screenshot({ path: path.join(SHOTS, `chat-${vp.tag}.png`) });
      }
      // opened over the tailnet: a loopback room URL follows the page's host
      const swapped = await page.evaluate(() => [
        roomSrc({ url: 'http://127.0.0.1:3396/r/x/' }, { hostname: 'box.example.ts.net' }),
        roomSrc({ url: 'http://127.0.0.1:3396/r/x/' }, { hostname: '100.101.102.103' }),
        roomSrc({ url: 'http://127.0.0.1:3396/r/x/' }, { hostname: 'localhost' }),
        roomSrc({ url: 'http://box.example.ts.net:3396/r/x/' }, { hostname: '127.0.0.1' }),
      ]);
      assert.deepStrictEqual(swapped, ['http://box.example.ts.net:3396/r/x/', 'http://100.101.102.103:3396/r/x/',
        'http://127.0.0.1:3396/r/x/', 'http://box.example.ts.net:3396/r/x/']);
      await ctx.close();
    }
  } finally { await browser.close(); await t.s.close(); await fr.close(); }
});

test('chat tab: hidden on every page when the board has no room', { skip, timeout: 60000 }, async () => {
  const t = await startBoard('chatui-none', { dispatch: false });
  const browser = await chromium.launch({ executablePath: CHROMIUM, headless: true, args: ['--no-sandbox'] });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await ctx.route(u => !u.href.startsWith(t.url), r => r.abort());
    const page = await ctx.newPage();
    for (const p of PAGES) {
      await page.goto(t.url + p);
      await page.waitForLoadState('networkidle');
      assert.strictEqual(await page.locator('.op-dock a[data-chat-tab]').isVisible(), false, p);
    }
    await page.goto(t.url + '/chat.html');
    await page.locator('#ch-empty').waitFor({ state: 'visible' });
    assert.strictEqual(await page.locator('#ch-frame').isVisible(), false);
  } finally { await browser.close(); await t.s.close(); }
});
