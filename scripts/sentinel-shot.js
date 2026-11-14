#!/usr/bin/env node
// Open a sentinel report.html headless (playwright-core + system chromium), fail on any request that
// is not file://, and screenshot it: node scripts/sentinel-shot.js REPORT.html OUT.png
const { chromium } = require('playwright-core');
(async () => {
  const [report, png] = process.argv.slice(2);
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/usr/bin/chromium', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const external = [];
  page.on('request', r => { if (!r.url().startsWith('file://')) external.push(r.url()); });
  await page.goto('file://' + require('path').resolve(report));
  const info = await page.evaluate(() => ({ title: document.title, issues: document.querySelectorAll('table.issues tbody tr').length, boards: document.querySelectorAll('section.board').length, bars: document.querySelectorAll('svg rect').length }));
  await page.screenshot({ path: png, fullPage: true });
  await browser.close();
  console.log(JSON.stringify({ ...info, external_requests: external.length }));
  if (external.length) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
