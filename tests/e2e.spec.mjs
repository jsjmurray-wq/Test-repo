// End-to-end smoke tests in Chromium with iPhone-like viewports (Playwright, no test runner).
// Usage: node tests/e2e.spec.mjs [--shots] [--soak]
//   --shots  save screenshots to ./screenshots/ for visual review
//   --soak   also run a full CPU-vs-CPU rack (?autoplay=hard) on the dev and single-file builds
// Exits non-zero on any failure.

import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require('playwright');
} catch {
  playwright = require('/opt/node22/lib/node_modules/playwright');
}

const args = new Set(process.argv.slice(2));
const SHOTS = args.has('--shots');
const SOAK = args.has('--soak');
const shotDir = join(root, 'screenshots');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
};

function serve() {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      let p = decodeURIComponent(url.pathname);
      if (p.endsWith('/')) p += 'index.html';
      const file = join(root, p);
      if (!file.startsWith(root)) throw new Error('bad path');
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

const VIEWPORTS = [
  { name: 'iphone-portrait', viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  { name: 'iphone-landscape', viewport: { width: 852, height: 393 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  { name: 'foldable-open', viewport: { width: 900, height: 1000 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
];

let failures = 0;
function check(cond, msg) {
  if (cond) console.log(`  ok   ${msg}`);
  else {
    failures++;
    console.log(`  FAIL ${msg}`);
  }
}

async function touchDrag(page, x0, y0, x1, y1, steps = 12) {
  const cdp = await page.context().newCDPSession(page);
  const pt = (x, y) => [{ x, y, id: 1, radiusX: 4, radiusY: 4, force: 1 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(x0, y0) });
  for (let i = 1; i <= steps; i++) {
    const x = x0 + ((x1 - x0) * i) / steps;
    const y = y0 + ((y1 - y0) * i) / steps;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt(x, y) });
    await page.waitForTimeout(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

async function waitFor(page, fn, timeout, arg) {
  try {
    await page.waitForFunction(fn, arg, { timeout, polling: 100 });
    return true;
  } catch {
    return false;
  }
}

async function smoke(browser, base, path, vp) {
  console.log(`\n[${vp.name}] ${path}`);
  const context = await browser.newContext({ ...vp });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  await page.goto(`${base}/${path}`);
  await page.waitForTimeout(600);
  check(await page.isVisible('#menu'), 'menu visible on load');
  if (SHOTS) await page.screenshot({ path: join(shotDir, `${vp.name}-${path.replace(/\W+/g, '_')}-menu.png`) });

  // Start a game vs the computer through the real menu button.
  const startBtn = page.locator('[data-action="play-cpu"], #play-cpu, button:has-text("Play vs Computer")').first();
  await startBtn.tap();
  const started = await waitFor(page, () => window.__pool && window.__pool.game && window.__pool.game.phase === 'aim', 8000);
  check(started, 'game started and reached aim phase');
  await page.waitForTimeout(300);

  const human = await page.evaluate(() => {
    const g = window.__pool.game;
    return g.state.players[g.state.turn].kind === 'human';
  });
  if (human) {
    // Human breaks: pull the power bar all the way down and release.
    const box = await page.locator('#power').boundingBox();
    check(!!box && box.height > 80, `power bar has usable size (${box && Math.round(box.height)}px)`);
    if (box) await touchDrag(page, box.x + box.width / 2, box.y + 8, box.x + box.width / 2, box.y + box.height - 4);
  } else {
    console.log('  (CPU won the toss and breaks)');
  }
  const rolling = await waitFor(page, () => window.__pool.game.phase === 'rolling', 8000);
  check(rolling, 'a shot was played (balls rolling)');
  await page.waitForTimeout(700);
  if (SHOTS) await page.screenshot({ path: join(shotDir, `${vp.name}-${path.replace(/\W+/g, '_')}-rolling.png`) });
  const rested = await waitFor(page, () => window.__pool.game.phase !== 'rolling', 70000);
  check(rested, 'balls came to rest and the shot resolved');
  const moved = await page.evaluate(() => {
    const g = window.__pool.game;
    return g.state.shotNo > 0 || g.state.rackNo > 1;
  });
  check(moved, 'game state advanced');
  await page.waitForTimeout(1500);
  if (SHOTS) await page.screenshot({ path: join(shotDir, `${vp.name}-${path.replace(/\W+/g, '_')}-after.png`) });

  // Pause sheet opens and closes.
  const pauseBtn = page.locator('#pause-btn, [data-action="pause"]').first();
  if (await pauseBtn.count()) {
    await pauseBtn.tap();
    await page.waitForTimeout(250);
    check(await page.isVisible('#pause'), 'pause sheet opens');
    if (SHOTS) await page.screenshot({ path: join(shotDir, `${vp.name}-${path.replace(/\W+/g, '_')}-pause.png`) });
    await page.locator('#pause [data-action="resume"], #pause button:has-text("Resume")').first().tap();
    await page.waitForTimeout(250);
  }
  check(errors.length === 0, `no console/page errors${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`);
  await context.close();
}

async function soak(browser, base, path) {
  console.log(`\n[soak] ${path}?autoplay=hard`);
  const context = await browser.newContext({ ...VIEWPORTS[0] });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));
  await page.goto(`${base}/${path}?autoplay=hard`);
  const done = await waitFor(page, () => window.__poolDone === true, 300000);
  const info = await page.evaluate(() => {
    const g = window.__pool && window.__pool.game;
    return g ? { phase: g.phase, shots: g.state.shotNo, score: g.match.score } : null;
  });
  check(done, `CPU vs CPU rack finished (${JSON.stringify(info)})`);
  if (SHOTS) await page.screenshot({ path: join(shotDir, `soak-${path.replace(/\W+/g, '_')}.png`) });
  check(errors.length === 0, `no errors during soak${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`);
  await context.close();
}

const server = await serve();
const base = `http://127.0.0.1:${server.address().port}`;
if (SHOTS) await mkdir(shotDir, { recursive: true });
const browser = await playwright.chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
try {
  const targets = ['index.html'];
  if (existsSync(join(root, 'dist/pool8.html'))) targets.push('dist/pool8.html');
  for (const t of targets) for (const vp of VIEWPORTS) await smoke(browser, base, t, vp);
  if (SOAK) for (const t of targets) await soak(browser, base, t);
} finally {
  await browser.close();
  server.close();
}
console.log(failures ? `\n${failures} check(s) failed` : '\nall e2e checks passed');
process.exit(failures ? 1 : 0);
