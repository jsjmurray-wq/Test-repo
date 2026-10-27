// End-to-end smoke tests in Chromium with iPhone-like viewports (Playwright, no test runner).
// Usage: node tests/e2e.spec.mjs [--shots] [--soak]
//   --shots  save screenshots to golf/screenshots/ (gitignored) for visual review
//   --soak   also play a full 9-hole autoplay round (?autoplay=1&fast=20) on the dev and
//            single-file builds
// WebGL comes from SwiftShader when available (renderer checks run); otherwise the flow runs
// logic-only with ?nogl=1. Exits non-zero on any failure.

import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'); // golf/
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
const CHROME = '/opt/pw-browsers/chromium';
const GL_ARGS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
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

// One finger along a list of [x, y, dtMs] points with real touch events (CDP), so the page sees
// pointerdown / pointermove / pointerup exactly like iOS Safari would produce them. Every event
// carries an explicit timestamp: under SwiftShader a frame can take most of a second, and the
// swing interpreter reads speeds and tempo from event.timeStamp, so the gesture's timeline must
// not depend on how long the page took to process each event.
async function touchPath(page, pts) {
  const cdp = await page.context().newCDPSession(page);
  const tp = (x, y) => [{ x, y, id: 1, radiusX: 4, radiusY: 4, force: 1 }];
  let T = Date.now() / 1000;
  const [x0, y0] = pts[0];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: tp(x0, y0), timestamp: T });
  for (let i = 1; i < pts.length; i++) {
    const [x, y, dt] = pts[i];
    T += (dt || 8) / 1000;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: tp(x, y), timestamp: T });
  }
  T += 0.008;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [], timestamp: T });
  await cdp.detach();
}

// Full swing: down `depth` px over 300 ms, a short hold at the top, then a smooth fast swipe up
// (150 ms) through the start point.
async function swipeSwing(page, x, y, depth) {
  const pts = [[x, y]];
  const n = 15;
  for (let i = 1; i <= n; i++) pts.push([x, y + (depth * i) / n, 20]);
  pts.push([x, y + depth, 60]);
  for (let i = 1; i <= 6; i++) pts.push([x, y + depth - ((depth + 50) * i) / 6, 25]);
  await touchPath(page, pts);
}

// Putt: drag down `depth` px over 200 ms and release at the bottom.
async function swipePutt(page, x, y, depth) {
  const pts = [[x, y]];
  const n = 10;
  for (let i = 1; i <= n; i++) pts.push([x, y + (depth * i) / n, 20]);
  pts.push([x, y + depth, 120]);
  await touchPath(page, pts);
}

async function waitFor(page, fn, timeout, arg) {
  try {
    await page.waitForFunction(fn, arg, { timeout, polling: 50 });
    return true;
  } catch {
    return false;
  }
}

const state = (page) => page.evaluate(() => window.__golf.debug.state());
const shot = async (page, tag, name) => SHOTS && page.screenshot({ path: join(shotDir, `${tag}-${name}.png`) });

async function probeWebGL(browser) {
  const page = await browser.newPage();
  const ok = await page.evaluate(() => {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  });
  await page.close();
  return ok;
}

function collectErrors(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  return errors;
}

async function smoke(browser, base, path, vp, gl) {
  const query = gl ? '?test=1&quality=low&fast=8' : '?test=1&nogl=1&fast=8';
  console.log(`\n[${vp.name}] ${path}${query}`);
  const tag = `${vp.name}-${path.replace(/\W+/g, '_')}`;
  const context = await browser.newContext({ ...vp });
  const page = await context.newPage();
  const errors = collectErrors(page);
  await page.goto(`${base}/${path}${query}`);
  check(await waitFor(page, () => !document.getElementById('menu').hidden, 15000), 'menu visible on load');
  await page.waitForTimeout(400);
  await shot(page, tag, 'menu');

  if (gl) {
    const r = await page.evaluate(() => ({ ok: window.__golf.renderer.ok, isNull: !!window.__golf.renderer.isNull }));
    check(r.ok && !r.isNull, 'WebGL renderer is up');
  }

  // New round through the real menu button; skip the intro flyover with a tap.
  await page.locator('#menu [data-act="new-round"]').tap();
  check(await waitFor(page, () => window.__golf.game && window.__golf.game.phase === 'intro', 8000), 'new round starts with the hole intro');
  await page.waitForTimeout(250);
  await shot(page, tag, 'intro');
  const vpw = vp.viewport.width;
  const vph = vp.viewport.height;
  await page.touchscreen.tap(vpw * 0.5, vph * 0.35);
  check(await waitFor(page, () => window.__golf.game.phase === 'address', 5000), 'tap skips the intro to the address');
  await page.waitForTimeout(500);
  await shot(page, tag, 'address');

  if (gl) {
    const r = await page.evaluate(() => ({ st: window.__golf.renderer.stats(), sky: window.__golf.debug.skyPixel() }));
    check(r.st.drawCalls > 5, `scene draws (${r.st.drawCalls} draw calls, ${Math.round(r.st.tris / 1000)}k tris)`);
    check(r.sky[0] + r.sky[1] + r.sky[2] > 60, `sky pixel is not black (${r.sky.join(',')})`);
  }

  // HUD and swing pad must not overlap. The pad is the lower part (portrait) or the lower right
  // (landscape) of the screen; in portrait the club picker deliberately sits at the bottom of the
  // pad, so there it only has to stay clear of the power arc.
  const overlap = await page.evaluate(() => {
    const pad = window.__golf.debug.padRect();
    const arc = document.querySelector('#pad .arc').getBoundingClientRect();
    const hits = [];
    const hit = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 2 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 2;
    const padBox = { left: pad.x, top: pad.y, right: pad.x + pad.w, bottom: pad.y + pad.h };
    const landscape = document.body.dataset.layout === 'landscape';
    for (const id of ['#topbar', '#infocard', '#tools', '#club', '#putt-range']) {
      const el = document.querySelector(id);
      if (!el || el.offsetParent === null) continue;
      const r = el.getBoundingClientRect();
      const inPad = (id === '#club' || id === '#putt-range') && !landscape;
      if (inPad ? hit(r, arc) : hit(r, padBox)) hits.push(id);
    }
    return hits;
  });
  check(overlap.length === 0, `HUD panels clear of the swing pad${overlap.length ? ': ' + overlap.join(', ') : ''}`);

  // Tee shot: drag down then flick up in the pad.
  const pad = await page.evaluate(() => window.__golf.debug.padRect());
  const sx = pad.x + pad.w * 0.5;
  const sy = pad.y + pad.h * 0.22;
  const depth = Math.min(200, pad.h * 0.3);
  await swipeSwing(page, sx, sy, depth);
  check(await waitFor(page, () => window.__golf.game.phase === 'flight', 3000), 'swipe swings: the ball is in flight');
  await page.waitForTimeout(350);
  await shot(page, tag, 'flight');
  const ended = await waitFor(page, () => ['address', 'decision'].includes(window.__golf.game.phase), 20000);
  let st = await state(page);
  check(ended && st.strokes >= 1, `shot resolved back to ${st.phase} with ${st.strokes} stroke(s)`);
  if (st.phase === 'decision') {
    await page.locator('#decision [data-dec="drop"]').tap();
    await waitFor(page, () => window.__golf.game.phase === 'address', 3000);
  }
  await page.waitForTimeout(1200); // let the result toast show
  await shot(page, tag, 'after-shot');

  // Short putt: place the ball 0.6 m from the cup and roll it in (retry if it lips out).
  let holed = false;
  for (let tryN = 0; tryN < 3 && !holed; tryN++) {
    await page.evaluate(() => window.__golf.debug.placeNearCup(0.6));
    await page.waitForTimeout(600);
    st = await state(page);
    if (tryN === 0) {
      check(st.putt, 'putter selected on the green');
      await shot(page, tag, 'putt');
    }
    const p = await page.evaluate(() => ({ pad: window.__golf.debug.padRect(), range: window.__golf.game.puttRange, d: window.__golf.game.distanceToCup() }));
    const power = (p.d + 0.35) / p.range;
    await swipePutt(page, p.pad.x + p.pad.w * 0.5, p.pad.y + p.pad.h * 0.25, power * 0.3 * p.pad.h);
    await waitFor(page, () => window.__golf.game.phase === 'flight', 3000);
    await waitFor(page, () => window.__golf.game.phase !== 'flight', 15000);
    holed = await page.evaluate(() => ['holed', 'scorecard'].includes(window.__golf.game.phase));
  }
  check(holed, 'short putt holed');
  await page.waitForTimeout(250);
  await shot(page, tag, 'holed');
  check(await waitFor(page, () => !document.getElementById('scorecard').hidden, 8000), 'scorecard shows after the hole');
  await page.waitForTimeout(400);
  await shot(page, tag, 'scorecard');
  const card1 = (await state(page)).card[0];
  check(card1 >= 2, `hole 1 recorded on the card (${card1})`);

  await page.locator('#scorecard [data-act="next-hole"]').tap();
  check(await waitFor(page, () => window.__golf.game.state.holeIndex === 1 && document.querySelector('[data-f="hole"]').textContent === '2', 5000), 'next hole is hole 2');
  await page.touchscreen.tap(vpw * 0.5, vph * 0.35);
  await waitFor(page, () => window.__golf.game.phase === 'address', 5000);
  await page.waitForTimeout(400);

  // Pause sheet opens and closes.
  await page.locator('#pause-btn').tap();
  await page.waitForTimeout(250);
  check(await page.isVisible('#pause'), 'pause sheet opens');
  await shot(page, tag, 'pause');
  await page.locator('#pause [data-act="unpause"]').tap();
  await page.waitForTimeout(250);
  check(!(await page.isVisible('#pause')) && !(await page.evaluate(() => window.__golf.paused)), 'pause sheet closes and play resumes');

  // Reload and resume: the saved round comes back on the same hole with the same card.
  const before = await state(page);
  await page.reload();
  check(await waitFor(page, () => !document.getElementById('menu').hidden, 15000), 'menu after reload');
  check(await page.isVisible('#menu [data-act="resume"]'), 'resume offered after reload');
  await page.locator('#menu [data-act="resume"]').tap();
  check(await waitFor(page, () => window.__golf.game && window.__golf.game.phase, 5000), 'resume restores the round');
  const after = await state(page);
  check(
    after.hole === before.hole && after.strokes === before.strokes && after.card[0] === before.card[0],
    `resume restores hole/strokes/card (hole ${after.hole + 1}, ${after.strokes} strokes, hole 1: ${after.card[0]})`,
  );
  await page.waitForTimeout(300);
  check(errors.length === 0, `no console/page errors${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`);
  await context.close();
}

async function soak(browser, base, path, gl) {
  const query = `?autoplay=1&fast=20${gl ? '&quality=low' : '&nogl=1'}`;
  console.log(`\n[soak] ${path}${query}`);
  const context = await browser.newContext({ ...VIEWPORTS[0] });
  const page = await context.newPage();
  const errors = collectErrors(page);
  const t0 = Date.now();
  await page.goto(`${base}/${path}${query}`);
  const done = await waitFor(page, () => !!globalThis.__golfDone, 600000);
  const info = await page.evaluate(() => globalThis.__golfDone || (window.__golf.game && window.__golf.game.phase));
  check(done && info.played === 9, `autoplay finished 9 holes (${JSON.stringify(info)}, ${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  await page.waitForTimeout(500);
  if (SHOTS) await page.screenshot({ path: join(shotDir, `soak-${path.replace(/\W+/g, '_')}.png`) });
  check(errors.length === 0, `no errors during soak${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`);
  await context.close();
}

const server = await serve();
const base = `http://127.0.0.1:${server.address().port}`;
if (SHOTS) await mkdir(shotDir, { recursive: true });
const browser = await playwright.chromium.launch({ executablePath: CHROME, args: GL_ARGS });
try {
  const gl = await probeWebGL(browser);
  console.log(gl ? 'WebGL available (SwiftShader): full renderer checks' : 'WebGL unavailable: logic-only run with ?nogl=1');
  const targets = ['index.html'];
  if (existsSync(join(root, 'dist/golf.html'))) targets.push('dist/golf.html');
  for (const t of targets) for (const vp of VIEWPORTS) await smoke(browser, base, t, vp, gl);
  if (SOAK) for (const t of targets) await soak(browser, base, t, gl);
} finally {
  await browser.close();
  server.close();
}
console.log(failures ? `\n${failures} check(s) failed` : '\nall e2e checks passed');
process.exit(failures ? 1 : 0);
