// End-to-end smoke tests in Chromium with iPhone-like viewports (Playwright, no test runner).
// Usage: node tests/e2e.spec.mjs [--shots] [--soak]
//   --shots  save screenshots to golf/screenshots/ (gitignored) for visual review
//   --soak   also play a full autoplay round (?autoplay=1&fast=20) on every course
//            (?course=pines|desert|water|links|mixed, and mixed18 = ?course=mixed&holes=18;
//            --courses=a,b for a subset) on the dev and single-file builds, with the renderer's
//            peak draw calls and triangles
//   --soak-only  skip the UI flow (soak rounds only)
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
const SOAK = args.has('--soak') || args.has('--soak-only');
// --soak plays a full autoplay round on every course (or --courses=desert,links only).
const coursesArg = process.argv.find((a) => a.startsWith('--courses='));
const SOAK_COURSES = coursesArg ? coursesArg.slice(10).split(',') : ['pines', 'desert', 'water', 'links', 'mixed', 'mixed18'];
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

// A tap with an explicit event time (seconds, the CDP clock): the tap meter times its two taps on
// the events' own clock, so under a loaded SwiftShader (frames of a second) the gap between them
// must not depend on how long the page took. Returns the time used.
async function cdpTap(page, x, y, T = Date.now() / 1000) {
  const cdp = await page.context().newCDPSession(page);
  const tp = [{ x, y, id: 1, radiusX: 4, radiusY: 4, force: 1 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: tp, timestamp: T });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [], timestamp: T + 0.04 });
  await cdp.detach();
  return T;
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

// Full swing the way a thumb really does it (version 2 gesture, section 8.1): down `depth` px,
// then a short quick flick up (45% of the depth, ~65 ms) that stops well short of the start
// point, lifted at the top of the flick.
async function flickSwing(page, x, y, depth) {
  const pts = [[x, y]];
  const n = 15;
  for (let i = 1; i <= n; i++) pts.push([x, y + (depth * i) / n, 20]);
  pts.push([x, y + depth, 60]);
  for (let i = 1; i <= 4; i++) pts.push([x, y + depth - (0.45 * depth * i) / 4, 16]);
  await touchPath(page, pts);
}

// Backswing, then hold still at the bottom and lift: cancels (not a stroke).
async function holdAndLift(page, x, y, depth) {
  const pts = [[x, y]];
  for (let i = 1; i <= 10; i++) pts.push([x, y + (depth * i) / 10, 25]);
  pts.push([x, y + depth - 1, 300]);
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
    for (const id of ['#topbar', '#infocard', '#tools', '#club', '#shot', '#putt-range']) {
      const el = document.querySelector(id);
      if (!el || el.offsetParent === null) continue;
      const r = el.getBoundingClientRect();
      const inPad = (id === '#club' || id === '#shot' || id === '#putt-range') && !landscape;
      if (inPad ? hit(r, arc) : hit(r, padBox)) hits.push(id);
    }
    return hits;
  });
  check(overlap.length === 0, `HUD panels clear of the swing pad${overlap.length ? ': ' + overlap.join(', ') : ''}`);

  // Tee shot: drag down then flick up in the pad. Builds with the version 2 gesture (they expose
  // debug.depthForPower) get a short flick that never returns to the start point; older builds
  // (a stale dist/) the classic swipe through it.
  const pad = await page.evaluate(() => window.__golf.debug.padRect());
  const v2 = await page.evaluate(() => typeof window.__golf.debug.depthForPower === 'function');
  const sx = pad.x + pad.w * 0.5;
  const sy = pad.y + pad.h * 0.22;
  const depth = Math.min(200, pad.h * 0.3);
  if (v2) {
    check(await page.evaluate(() => getComputedStyle(document.querySelector('#pad .arc-target')).display !== 'none'), 'power arc shows the target notch');
    await flickSwing(page, sx, sy, depth);
  } else {
    await swipeSwing(page, sx, sy, depth);
  }
  check(await waitFor(page, () => window.__golf.game.phase === 'flight', 3000), `${v2 ? 'short flick' : 'swipe'} swings: the ball is in flight`);
  await page.waitForTimeout(350);
  await shot(page, tag, 'flight');
  const ended = await waitFor(page, () => ['address', 'decision'].includes(window.__golf.game.phase), 45000);
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
    const p = await page.evaluate(() => {
      const g = window.__golf.game;
      const dbg = window.__golf.debug;
      const power = (g.distanceToCup() + 0.35) / g.puttRange;
      // The putt travel comes from the page (input.js depthForPower); older builds used 0.3 x pad.
      const depth = dbg.depthForPower ? dbg.depthForPower(power, 'putt') : power * 0.3 * dbg.padRect().h;
      return { pad: dbg.padRect(), depth };
    });
    await swipePutt(page, p.pad.x + p.pad.w * 0.5, p.pad.y + p.pad.h * 0.25, p.depth);
    await waitFor(page, () => window.__golf.game.phase === 'flight', 3000);
    await waitFor(page, () => window.__golf.game.phase !== 'flight', 15000);
    holed = await page.evaluate(() => ['holed', 'scorecard'].includes(window.__golf.game.phase));
  }
  check(holed, 'short putt holed');
  await page.waitForTimeout(250);
  await shot(page, tag, 'holed');
  check(await waitFor(page, () => !document.getElementById('scorecard').hidden, 8000), 'scorecard shows after the hole');
  await page.waitForTimeout(900);
  await shot(page, tag, 'scorecard');
  const card1 = (await state(page)).card[0];
  check(card1 >= 2, `hole 1 recorded on the card (${card1})`);

  await page.locator('#scorecard [data-act="next-hole"]').tap();
  check(await waitFor(page, () => window.__golf.game.state.holeIndex === 1 && document.querySelector('[data-f="hole"]').textContent === '2', 5000), 'next hole is hole 2');
  await page.touchscreen.tap(vpw * 0.5, vph * 0.35);
  await waitFor(page, () => window.__golf.game.phase === 'address', 5000);
  await page.waitForTimeout(400);

  if (v2) {
    // Holding at the bottom and lifting cancels, with a hint, and is not a stroke.
    const p2 = await page.evaluate(() => window.__golf.debug.padRect());
    await holdAndLift(page, p2.x + p2.w * 0.5, p2.y + p2.h * 0.22, Math.min(200, p2.h * 0.3));
    await page.waitForTimeout(400);
    const c = await page.evaluate(() => ({ phase: window.__golf.game.phase, strokes: window.__golf.game.state.hole.strokes, toast: document.getElementById('toast').textContent }));
    check(c.phase === 'address' && c.strokes === 0 && /Swing cancelled/.test(c.toast), `hold and lift cancels the swing (${c.phase}, ${c.strokes} strokes, "${c.toast}")`);

    // Tap meter: Settings "Swing control: Tap meter"; tap to start the bar, tap again to hit.
    await page.evaluate(() => window.__golf.ui.setSetting('swing', 'tap'));
    const hint = await page.evaluate(() => document.querySelector('[data-f="hint"]').textContent);
    check(/Tap to start/.test(hint), `tap meter hint ("${hint}")`);
    const tx = p2.x + p2.w * 0.5;
    const ty = p2.y + p2.h * 0.3;
    // Both taps carry explicit event times 600 ms apart (the meter's clock), so the struck power
    // (from the event times, lastSwing) is the same however slowly the frames come.
    const T0 = await cdpTap(page, tx, ty);
    // The gauge fills on the next rendered frame(s): poll instead of sampling once after a sleep.
    check(await waitFor(page, () => document.getElementById('pad').dataset.state === 'swing' && window.__golf.swingPower > 0.1, 2200), 'tap meter fills');
    await cdpTap(page, tx, ty, T0 + 0.6);
    check(await waitFor(page, () => window.__golf.game.phase === 'flight', 5000), 'second tap hits: the ball is in flight');
    const ls = await page.evaluate(() => window.__golf.lastSwing && window.__golf.lastSwing.sw);
    check(ls && ls.label === 'Tap swing' && ls.power > 0.42 && ls.power < 0.62 && ls.startDir === 0, `tap swing 0.6 s after the first tap (power ${ls && ls.power.toFixed(2)})`);
    await page.evaluate(() => window.__golf.ui.setSetting('swing', 'swipe'));
    check(await waitFor(page, () => ['address', 'decision'].includes(window.__golf.game.phase), 45000), 'tap shot resolved');
    if ((await state(page)).phase === 'decision') {
      await page.locator('#decision [data-dec="drop"]').tap();
      await waitFor(page, () => window.__golf.game.phase === 'address', 3000);
    }
    await page.waitForTimeout(400);
  }

  // Pause sheet opens and closes.
  await page.locator('#pause-btn').tap();
  await page.waitForTimeout(700); // let the sheet's fade-in finish before the screenshot
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

  // Version 2 (sections 8.4 and 8.5): pick a course on the menu, play a special shot from the
  // shot sheet, and resume that course. Builds without the course picker (a stale dist/) skip it.
  if (await page.evaluate(() => !!document.querySelector('#menu [data-course]'))) await coursesAndShots(page, tag, vpw, vph);

  check(errors.length === 0, `no console/page errors${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`);
  await context.close();
}

// Course picker -> new round on Red Mesa -> stinger off the tee from the shot sheet -> its toast;
// then the ?course= parameter and resuming the desert round.
async function coursesAndShots(page, tag, vpw, vph) {
  await page.locator('#pause-btn').tap();
  await page.waitForTimeout(400);
  await page.locator('#pause [data-act="quit"]').tap();
  check(await waitFor(page, () => !document.getElementById('menu').hidden, 5000), 'quit to the menu');
  const cards = await page.locator('#menu [data-course]').count();
  check(cards === 5, `menu shows the four course cards and Mixed Nine (${cards})`);
  await page.locator('#menu [data-course="desert"]').tap();
  await page.waitForTimeout(600);
  const picked = await page.evaluate(() => ({
    checked: document.querySelector('#menu [data-course="desert"]').getAttribute('aria-checked'),
    title: document.querySelector('[data-f="courseName"]').textContent,
  }));
  check(picked.checked === 'true' && picked.title === 'Red Mesa', `course card selects Red Mesa ("${picked.title}")`);
  await shot(page, tag, 'menu-courses');
  await page.locator('#menu [data-act="new-round"]').tap();
  check(await waitFor(page, () => window.__golf.game && window.__golf.game.phase === 'intro' && window.__golf.game.course.id === 'desert', 8000), 'new round starts on the picked course');
  const intro = await page.evaluate(() => document.querySelector('[data-f="introCourse"]').textContent);
  check(intro === 'Red Mesa', `hole intro names the course ("${intro}")`);
  await page.touchscreen.tap(vpw * 0.5, vph * 0.35);
  check(await waitFor(page, () => window.__golf.game.phase === 'address', 12000), 'address on Red Mesa hole 1');
  await page.waitForTimeout(400);

  // Shot chip -> sheet of the driver's shots -> Stinger.
  await page.locator('#shot').tap();
  check(await waitFor(page, () => !document.getElementById('shots').hidden, 3000), 'shot chip opens the shot sheet');
  await page.waitForTimeout(700);
  const opts = await page.evaluate(() => [...document.querySelectorAll('#shots .shot-opt')].map((b) => b.dataset.shot));
  check(opts.join() === 'normal,draw,cut,stinger', `driver shots: ${opts.join(', ')}`);
  const clear = await page.evaluate(() => {
    const pad = window.__golf.debug.padRect();
    const r = document.querySelector('#shots .shot-sheet').getBoundingClientRect();
    return Math.min(r.right, pad.x + pad.w) - Math.max(r.left, pad.x) <= 2 || Math.min(r.bottom, pad.y + pad.h) - Math.max(r.top, pad.y) <= 2;
  });
  check(clear, 'shot sheet stays clear of the swing pad');
  await shot(page, tag, 'shot-sheet');
  await page.locator('#shots [data-shot="stinger"]').tap();
  check(await waitFor(page, () => document.getElementById('shots').hidden && window.__golf.game.shotType === 'stinger', 3000), 'picking Stinger closes the sheet and selects it');
  const chip = await page.evaluate(() => ({ text: document.querySelector('[data-f="shotName"]').textContent, special: document.getElementById('shot').dataset.special }));
  check(chip.text === 'Stinger' && chip.special === '1', `shot chip reads "${chip.text}"`);
  await page.waitForTimeout(400);
  const pad = await page.evaluate(() => window.__golf.debug.padRect());
  const depth = await page.evaluate(() => window.__golf.debug.depthForPower(1, 'full'));
  await flickSwing(page, pad.x + pad.w * 0.5, pad.y + pad.h * 0.2, Math.min(depth, pad.h * 0.7));
  check(await waitFor(page, () => window.__golf.game.phase === 'flight', 3000), 'the stinger is struck');
  const flight = await page.evaluate(() => ({ shot: window.__golf.game.shot.swing.shot, apex: window.__golf.game.shot.result.apex, after: window.__golf.game.shotType }));
  check(flight.shot === 'stinger' && flight.apex < 15 && flight.after === 'normal', `stinger flies low (apex ${flight.apex.toFixed(1)} m) and the shot resets`);
  // (Generous: SwiftShader on a loaded machine draws a frame a second; the flight plays in real time.)
  check(await waitFor(page, () => ['address', 'decision'].includes(window.__golf.game.phase), 45000), 'stinger resolved');
  const toast = await page.evaluate(() => document.getElementById('toast').textContent);
  check(/Driver Stinger/.test(toast), `toast names the shot ("${toast}")`);
  await shot(page, tag, 'after-stinger');
  if ((await state(page)).phase === 'decision') {
    await page.locator('#decision [data-dec="drop"]').tap();
    await waitFor(page, () => window.__golf.game.phase === 'address', 3000);
  }

  // ?course= picks the course on load; Resume still returns to the saved desert round.
  const url = new URL(page.url());
  url.searchParams.set('course', 'links');
  await page.goto(url.toString());
  check(await waitFor(page, () => !document.getElementById('menu').hidden, 15000), 'menu after ?course=links');
  const sel = await page.evaluate(() => ({ links: document.querySelector('#menu [data-course="links"]').getAttribute('aria-checked'), sub: document.querySelector('[data-f="resumeSub"]').textContent }));
  check(sel.links === 'true', '?course=links selects Kittiwake Links');
  check(/Red Mesa/.test(sel.sub), `resume names the saved course ("${sel.sub}")`);
  await page.locator('#menu [data-act="resume"]').tap();
  check(await waitFor(page, () => window.__golf.game && window.__golf.game.phase && window.__golf.game.course.id === 'desert', 8000), 'resume restores the desert round');
  await page.waitForTimeout(300);

  // The other two new courses: a round on each with a special shot, saved, reloaded and resumed.
  await courseRound(page, tag, vpw, vph, { id: 'water', name: 'Coral Cay', theme: 'tropical', shot: 'draw' });
  await courseRound(page, tag, vpw, vph, { id: 'links', name: 'Kittiwake Links', theme: 'links', shot: 'cut' });
  // The mixed round: nine random holes across the courses (builds without the card skip it).
  await mixedRound(page, tag, vpw, vph);
  // Mixed Eighteen: the 9 | 18 switch, the back nine and its scorecard (older builds skip it).
  await mixed18Round(page, tag, vpw, vph);
}

// Menu -> the Mixed Nine card -> new round: the hole is one of the four courses' (the intro names
// it, the theme is its course's), the card has a Course row, a flick plays the tee shot, and a
// reload resumes the same nine holes on the same hole.
async function mixedRound(page, tag, vpw, vph) {
  await page.locator('#pause-btn').tap();
  await page.waitForTimeout(400);
  await page.locator('#pause [data-act="quit"]').tap();
  check(await waitFor(page, () => !document.getElementById('menu').hidden, 5000), 'quit to the menu (mixed)');
  const card = page.locator('#menu [data-course="mixed"]');
  if (!(await card.count())) {
    console.log('  (no Mixed Nine card in this build: skipped)');
    return;
  }
  await card.tap({ position: { x: 24, y: 24 } }); // the thumbnail (clear of the 9 | 18 switch)
  await page.waitForTimeout(400);
  const menu = await page.evaluate(() => ({ title: document.querySelector('[data-f="courseName"]').textContent, meta: document.querySelector('#menu [data-course="mixed"] .cc-meta').textContent }));
  check(menu.title === 'Mixed Nine' && /Par 36/.test(menu.meta), `the Mixed Nine card is selected ("${menu.title}", "${menu.meta}")`);
  await shot(page, tag, 'menu-mixed');
  await page.locator('#menu [data-act="new-round"]').tap();
  check(await waitFor(page, () => window.__golf.game && window.__golf.game.phase === 'intro' && window.__golf.game.course.id === 'mixed', 8000), 'new mixed round');
  const m = await page.evaluate(() => {
    const g = window.__golf.game;
    const names = { pines: 'Hollow Pines', desert: 'Red Mesa', water: 'Coral Cay', links: 'Kittiwake Links' };
    return {
      intro: document.querySelector('[data-f="introCourse"]').textContent,
      hole: document.querySelector('[data-f="introHole"]').textContent,
      src: names[g.courseOf(0).id],
      srcN: g.terrain.n,
      courses: [...new Set(g.state.mix.map((p) => p.courseId))].length,
      par: g.state.card.holes.reduce((a, h) => a + h.par, 0),
    };
  });
  check(m.intro === `${m.src} · No. ${m.srcN}` && m.hole === '1', `the intro names the hole's own course ("${m.intro}", hole ${m.hole})`);
  check(m.courses === 4 && m.par === 36, `the nine come from all four courses, par ${m.par}`);
  await shot(page, tag, 'mixed-intro');
  await page.touchscreen.tap(vpw * 0.5, vph * 0.35);
  check(await waitFor(page, () => window.__golf.game.phase === 'address', 12000), 'address on the mixed hole 1');
  await page.waitForTimeout(400);
  const th = await page.evaluate(() => ({ terrain: window.__golf.game.terrain.theme, want: window.__golf.game.courseOf().theme, renderer: window.__golf.renderer.theme && window.__golf.renderer.theme.id }));
  check(th.terrain === th.want && (th.renderer === undefined || th.renderer === th.want), `the mixed hole plays and renders its course's theme (${th.terrain}/${th.renderer})`);
  const chips = await page.evaluate(() => {
    const a = window.__golf;
    a.ui.showScorecard(a.game.state.card, { current: 0 });
    const n = document.querySelectorAll('#scorecard .from-chip').length;
    a.ui.hideScorecard();
    return n;
  });
  check(chips === 9, `the scorecard shows each hole's course (${chips} chips)`);
  const pad = await page.evaluate(() => window.__golf.debug.padRect());
  const p = await page.evaluate(() => Math.min(1, window.__golf.targetPower ?? 1));
  const depth = await page.evaluate((pw) => window.__golf.debug.depthForPower(pw, 'full'), p);
  await flickSwing(page, pad.x + pad.w * 0.5, pad.y + pad.h * 0.2, Math.min(depth, pad.h * 0.7));
  check(await waitFor(page, () => window.__golf.game.phase === 'flight', 3000), 'mixed tee shot struck');
  check(await waitFor(page, () => ['address', 'decision', 'holed', 'scorecard'].includes(window.__golf.game.phase), 45000), 'mixed tee shot resolved');
  if ((await state(page)).phase === 'decision') {
    await page.locator('#decision [data-dec="drop"]').tap();
    await waitFor(page, () => window.__golf.game.phase === 'address', 3000);
  }
  await page.waitForTimeout(300);
  const before = await page.evaluate(() => ({ ...window.__golf.debug.state(), mix: JSON.stringify(window.__golf.game.state.mix) }));
  await page.reload();
  check(await waitFor(page, () => !document.getElementById('menu').hidden, 15000), 'menu after reload (mixed)');
  const sub = await page.evaluate(() => document.querySelector('[data-f="resumeSub"]').textContent);
  check(sub.startsWith('Mixed Nine'), `resume names the mixed round ("${sub}")`);
  await page.locator('#menu [data-act="resume"]').tap();
  check(await waitFor(page, () => window.__golf.game && window.__golf.game.phase && window.__golf.game.course.id === 'mixed', 8000), 'resume restores the mixed round');
  const after = await page.evaluate(() => ({ ...window.__golf.debug.state(), mix: JSON.stringify(window.__golf.game.state.mix) }));
  check(after.mix === before.mix && after.hole === before.hole && after.strokes === before.strokes && after.theme === before.theme, `the same nine holes resume on hole ${after.hole + 1} with ${after.strokes} stroke(s) (${after.holeCourseId})`);
  await page.waitForTimeout(300);
}

// Menu -> the mixed card's "18 holes" -> new round of 18 (par 72, all four courses) -> the debug
// hook records holes 1-8 -> a real touch putt holes the 9th -> the scorecard (two blocks in
// portrait, one row in landscape, re-laid out on rotation) has Out / In / Tot -> Next hole is the
// 10th -> reload -> Resume picks up the same eighteen on the 10th.
async function mixed18Round(page, tag, vpw, vph) {
  await page.locator('#pause-btn').tap();
  await page.waitForTimeout(400);
  await page.locator('#pause [data-act="quit"]').tap();
  check(await waitFor(page, () => !document.getElementById('menu').hidden, 5000), 'quit to the menu (mixed 18)');
  const pill = page.locator('#menu [data-mix="mixed18"]');
  if (!(await pill.count())) {
    console.log('  (no 9 | 18 switch in this build: Mixed Eighteen skipped)');
    return;
  }
  await pill.tap();
  await page.waitForTimeout(400);
  const menu = await page.evaluate(() => ({
    title: document.querySelector('[data-f="courseName"]').textContent,
    meta: document.querySelector('#menu [data-course="mixed"] .cc-meta').textContent,
    pressed: document.querySelector('#menu [data-mix="mixed18"]').getAttribute('aria-pressed'),
    cards: document.querySelectorAll('#menu [data-course]').length,
    sel: window.__golf.ui.selectedCourse,
  }));
  check(menu.title === 'Mixed Eighteen' && /Par 72/.test(menu.meta) && menu.pressed === 'true' && menu.cards === 5 && menu.sel === 'mixed18',
    `the 18 holes switch selects Mixed Eighteen ("${menu.title}", "${menu.meta}", ${menu.cards} cards)`);
  await shot(page, tag, 'menu-mixed18');
  await page.locator('#menu [data-act="new-round"]').tap();
  check(await waitFor(page, () => window.__golf.game && window.__golf.game.phase === 'intro' && window.__golf.game.course.id === 'mixed18', 8000), 'new Mixed Eighteen round');
  const m = await page.evaluate(() => {
    const g = window.__golf.game;
    return {
      picks: g.state.mix.length,
      courses: new Set(g.state.mix.map((p) => p.courseId)).size,
      par: g.state.card.holes.reduce((a, h) => a + h.par, 0),
      hole: document.querySelector('[data-f="introHole"]').textContent,
    };
  });
  check(m.picks === 18 && m.courses === 4 && m.par === 72 && m.hole === '1', `eighteen holes from all four courses, par ${m.par}, intro hole ${m.hole}`);
  // Holes 1-8 recorded by the debug hook; the 9th is played for real.
  await page.evaluate(() => window.__golf.debug.skipTo(8, [0, -1, 1, 0, 0, 2, 0, 1]));
  check(await waitFor(page, () => window.__golf.game.state.holeIndex === 8 && window.__golf.game.phase === 'intro', 5000), 'skipped to hole 9');
  await page.touchscreen.tap(vpw * 0.5, vph * 0.35);
  check(await waitFor(page, () => window.__golf.game.phase === 'address', 12000), 'address on hole 9');
  let holed = false;
  for (let tryN = 0; tryN < 3 && !holed; tryN++) {
    await page.evaluate(() => window.__golf.debug.placeNearCup(0.6));
    await page.waitForTimeout(600);
    const p = await page.evaluate(() => {
      const g = window.__golf.game;
      const dbg = window.__golf.debug;
      return { pad: dbg.padRect(), depth: dbg.depthForPower((g.distanceToCup() + 0.35) / g.puttRange, 'putt') };
    });
    await swipePutt(page, p.pad.x + p.pad.w * 0.5, p.pad.y + p.pad.h * 0.25, p.depth);
    await waitFor(page, () => window.__golf.game.phase === 'flight', 3000);
    await waitFor(page, () => window.__golf.game.phase !== 'flight', 15000);
    holed = await page.evaluate(() => ['holed', 'scorecard'].includes(window.__golf.game.phase));
  }
  check(holed, 'hole 9 holed with a touch putt');
  check(await waitFor(page, () => !document.getElementById('scorecard').hidden, 8000), 'the scorecard shows after hole 9');
  await page.waitForTimeout(700);
  const cardInfo = () => page.evaluate(() => {
    const sc = document.getElementById('scorecard');
    const t = sc.querySelector('table.sc');
    const r = sc.querySelector('.card').getBoundingClientRect();
    const g = window.__golf.game;
    const tot = (cls) => [...t.querySelectorAll(`tr.${cls} td.tot`)].map((d) => d.textContent);
    return {
      phase: g.phase,
      holes: sc.dataset.holes,
      layout: sc.dataset.cardLayout,
      bodyLayout: document.body.dataset.layout,
      heads: tot('r-hole'),
      scores: tot('r-score'),
      chips: sc.querySelectorAll('.from-chip').length,
      rows: t.querySelectorAll('tr.r-hole').length,
      front: g.state.card.holes.slice(0, 9).reduce((a, h) => a + h.strokes, 0),
      out: g.totals().out.strokes,
      overflow: t.scrollWidth - t.parentElement.clientWidth,
      fits: r.left >= -1 && r.top >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1,
    };
  });
  let c = await cardInfo();
  const want = (k) => (k.bodyLayout === 'landscape' ? { layout: 'row', rows: 1 } : { layout: 'split', rows: 2 });
  check(c.phase === 'scorecard' && c.holes === '18', `an 18-hole scorecard after the 9th, not the end (${c.phase}, ${c.holes})`);
  check(c.heads.join() === 'Out,In,Tot' && c.chips === 18, `Out / In / Tot columns and 18 course chips (${c.heads.join()}, ${c.chips})`);
  check(c.scores[0] === String(c.front) && c.front === c.out && c.scores[1] === '' && c.scores[2] === c.scores[0], `Out ${c.scores[0]} = holes 1-9 (${c.front}), In empty, Tot = Out (${c.scores.join('/')})`);
  check(c.layout === want(c).layout && c.rows === want(c).rows, `the card is laid out as ${c.layout} with ${c.rows} hole row(s) in ${c.bodyLayout}`);
  check(c.overflow <= 1 && c.fits, `the 18-hole card fits the screen (overflow ${c.overflow} px)`);
  await shot(page, tag, 'mixed18-scorecard');
  // Rotate with the card open: it re-lays itself out (split <-> row); then back.
  await page.setViewportSize({ width: vph, height: vpw });
  await page.waitForTimeout(700);
  const rc = await cardInfo();
  check(rc.layout === want(rc).layout && rc.rows === want(rc).rows && rc.overflow <= 1, `rotated (${rc.bodyLayout}): the card is ${rc.layout} with ${rc.rows} hole row(s)`);
  await shot(page, tag, 'mixed18-scorecard-rotated');
  await page.setViewportSize({ width: vpw, height: vph });
  await page.waitForTimeout(700);
  c = await cardInfo();
  check(c.layout === want(c).layout, `rotated back: ${c.layout}`);
  await page.locator('#scorecard [data-act="next-hole"]').tap();
  check(await waitFor(page, () => window.__golf.game.state.holeIndex === 9 && document.querySelector('[data-f="hole"]').textContent === '10', 5000), 'Next hole is hole 10');
  const ten = await page.evaluate(() => {
    const g = window.__golf.game;
    const names = { pines: 'Hollow Pines', desert: 'Red Mesa', water: 'Coral Cay', links: 'Kittiwake Links' };
    return { hole: document.querySelector('[data-f="introHole"]').textContent, intro: document.querySelector('[data-f="introCourse"]').textContent, want: `${names[g.courseOf(9).id]} · No. ${g.terrain.n}` };
  });
  check(ten.hole === '10' && ten.intro === ten.want, `the intro shows hole 10 and its course ("${ten.intro}")`);
  await page.waitForTimeout(300);
  const before = await page.evaluate(() => ({ ...window.__golf.debug.state(), mix: JSON.stringify(window.__golf.game.state.mix) }));
  await page.reload();
  check(await waitFor(page, () => !document.getElementById('menu').hidden, 15000), 'menu after reload (mixed 18)');
  const sub = await page.evaluate(() => document.querySelector('[data-f="resumeSub"]').textContent);
  check(sub === 'Mixed Eighteen · Hole 10', `resume names the round ("${sub}")`);
  await page.locator('#menu [data-act="resume"]').tap();
  check(await waitFor(page, () => window.__golf.game && window.__golf.game.phase && window.__golf.game.course.id === 'mixed18', 8000), 'resume restores Mixed Eighteen');
  const after = await page.evaluate(() => ({ ...window.__golf.debug.state(), mix: JSON.stringify(window.__golf.game.state.mix) }));
  check(after.mix === before.mix && after.hole === 9 && after.holes === 18 && after.card.slice(0, 9).join() === before.card.slice(0, 9).join(),
    `the same eighteen resume on hole ${after.hole + 1} with holes 1-9 kept (${after.card.slice(0, 9).join(' ')})`);
  await page.waitForTimeout(300);
}

// Menu -> pick a course -> new round -> tee shot with a special shot picked on the sheet (a draw
// or cut shows its curved preview) -> toast names it -> reload -> Resume restores that course's
// round (same hole, strokes, theme).
async function courseRound(page, tag, vpw, vph, c) {
  await page.locator('#pause-btn').tap();
  await page.waitForTimeout(400);
  await page.locator('#pause [data-act="quit"]').tap();
  check(await waitFor(page, () => !document.getElementById('menu').hidden, 5000), `quit to the menu (${c.id})`);
  await page.locator(`#menu [data-course="${c.id}"]`).tap();
  await page.waitForTimeout(400);
  const title = await page.evaluate(() => document.querySelector('[data-f="courseName"]').textContent);
  check(title === c.name, `course card selects ${c.name} ("${title}")`);
  await page.locator('#menu [data-act="new-round"]').tap();
  check(await waitFor(page, (id) => window.__golf.game && window.__golf.game.phase === 'intro' && window.__golf.game.course.id === id, 8000, c.id), `new round on ${c.name}`);
  const intro = await page.evaluate(() => document.querySelector('[data-f="introCourse"]').textContent);
  check(intro === c.name, `hole intro names ${c.name} ("${intro}")`);
  await page.touchscreen.tap(vpw * 0.5, vph * 0.35);
  check(await waitFor(page, () => window.__golf.game.phase === 'address', 12000), `address on ${c.name} hole 1`);
  await page.waitForTimeout(400);
  const theme = await page.evaluate(() => ({ terrain: window.__golf.game.terrain.theme, renderer: window.__golf.renderer.theme && window.__golf.renderer.theme.id }));
  check(theme.terrain === c.theme && (theme.renderer === undefined || theme.renderer === c.theme), `${c.name} plays and renders the ${c.theme} theme (${theme.terrain}/${theme.renderer})`);

  await page.locator('#shot').tap();
  await waitFor(page, () => !document.getElementById('shots').hidden, 3000);
  await page.waitForTimeout(600);
  await page.locator(`#shots [data-shot="${c.shot}"]`).tap();
  check(await waitFor(page, (s) => document.getElementById('shots').hidden && window.__golf.game.shotType === s, 3000, c.shot), `${c.shot} selected from the sheet`);
  await page.waitForTimeout(500);
  // The next frames draw it (the first one simulates the intended flight; SwiftShader frames are slow).
  const pv = await waitFor(page, () => {
    const s = window.__golf.lastScene;
    return !!(s && s.trail && s.trail.count > 2 && s.aim && s.aim.ring);
  }, 8000);
  check(pv, `${c.shot}: curved aim preview with a landing ring`);
  await shot(page, tag, `${c.id}-${c.shot}`);
  const pad = await page.evaluate(() => window.__golf.debug.padRect());
  const p = await page.evaluate(() => Math.min(1, window.__golf.targetPower ?? 1));
  const depth = await page.evaluate((pw) => window.__golf.debug.depthForPower(pw, 'full'), p);
  await flickSwing(page, pad.x + pad.w * 0.5, pad.y + pad.h * 0.2, Math.min(depth, pad.h * 0.7));
  check(await waitFor(page, () => window.__golf.game.phase === 'flight', 3000), `${c.shot} struck with a short flick`);
  const sw = await page.evaluate(() => window.__golf.game.shot.swing.shot);
  check(sw === c.shot, `the swing plays the ${c.shot} (${sw})`);
  check(await waitFor(page, () => ['address', 'decision', 'holed', 'scorecard'].includes(window.__golf.game.phase), 45000), `${c.shot} resolved`);
  // The shot toast's first segment (its bold tab) is "<club> <Shot>", e.g. "Driver Draw" or "3W Cut";
  // a rule message (water, OB) may follow it in a toast of its own.
  const shotName = c.shot[0].toUpperCase() + c.shot.slice(1);
  const tabs = await page.evaluate(() => [...document.querySelectorAll('#toast .toast b')].map((b) => b.textContent));
  check(tabs.some((t) => t.endsWith(` ${shotName}`)), `toast names the ${c.shot} ("${tabs.join(' | ')}")`);
  await shot(page, tag, `${c.id}-after-${c.shot}`);
  if ((await state(page)).phase === 'decision') {
    await page.locator('#decision [data-dec="drop"]').tap();
    await waitFor(page, () => window.__golf.game.phase === 'address', 3000);
  }
  await page.waitForTimeout(300);

  const before = await state(page);
  await page.reload();
  check(await waitFor(page, () => !document.getElementById('menu').hidden, 15000), `menu after reload (${c.id})`);
  const sub = await page.evaluate(() => document.querySelector('[data-f="resumeSub"]').textContent);
  check(sub.startsWith(c.name), `resume names ${c.name} ("${sub}")`);
  await page.locator('#menu [data-act="resume"]').tap();
  check(await waitFor(page, (id) => window.__golf.game && window.__golf.game.phase && window.__golf.game.course.id === id, 8000, c.id), `resume restores the ${c.id} round`);
  const after = await state(page);
  const th = await page.evaluate(() => window.__golf.game.terrain.theme);
  check(after.hole === before.hole && after.strokes === before.strokes && th === c.theme, `${c.name} resumes on hole ${after.hole + 1} with ${after.strokes} stroke(s), ${th} theme`);
  await page.waitForTimeout(300);
}

// A full autoplay round on one course (?course=ID); the renderer's draw calls and triangles are
// sampled every half second (the most seen is reported against the 30-draw budget).
async function soak(browser, base, path, gl, courseId) {
  const holes = courseId === 'mixed18' ? 18 : 9;
  const courseQ = courseId === 'mixed18' ? 'mixed&holes=18' : courseId;
  const query = `?autoplay=1&fast=20&course=${courseQ}${gl ? '&quality=low' : '&nogl=1'}`;
  console.log(`\n[soak] ${path}${query}`);
  const context = await browser.newContext({ ...VIEWPORTS[0] });
  const page = await context.newPage();
  const errors = collectErrors(page);
  const t0 = Date.now();
  await page.goto(`${base}/${path}${query}`);
  if (holes === 18) {
    // A build from before Mixed Eighteen ignores &holes=18 (a stale dist/): skip, as the UI flow does.
    await waitFor(page, () => !!(window.__golf && window.__golf.game), 30000);
    if ((await page.evaluate(() => window.__golf.game && window.__golf.game.course.id)) !== 'mixed18') {
      console.log('  (no Mixed Eighteen in this build: skipped)');
      await context.close();
      return;
    }
  }
  await page.evaluate(() => {
    const m = (window.__golfPerf = { draws: 0, tris: 0, holes: new Set() });
    setInterval(() => {
      const a = window.__golf;
      if (!a || !a.game || !a.renderer) return;
      const s = a.renderer.stats();
      m.draws = Math.max(m.draws, s.drawCalls);
      m.tris = Math.max(m.tris, s.tris);
      m.holes.add(a.game.state.holeIndex);
    }, 500);
  });
  const done = await waitFor(page, () => !!globalThis.__golfDone, holes === 18 ? 1800000 : 900000);
  const info = await page.evaluate(() => globalThis.__golfDone || (window.__golf.game && window.__golf.game.phase));
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  check(done && info.played === holes && info.course === courseId, `autoplay finished ${holes} holes on ${courseId} (${JSON.stringify(info)}, ${secs} s)`);
  const perf = await page.evaluate(() => ({ draws: window.__golfPerf.draws, tris: window.__golfPerf.tris, holes: window.__golfPerf.holes.size }));
  if (gl) check(perf.draws > 5 && perf.draws <= 30, `${courseId}: at most ${perf.draws} draw calls (budget 30), ${Math.round(perf.tris / 1000)}k tris at most, over ${perf.holes} holes`);
  await page.waitForTimeout(500);
  if (SHOTS) await page.screenshot({ path: join(shotDir, `soak-${courseId}-${path.replace(/\W+/g, '_')}.png`) });
  check(errors.length === 0, `no errors during the ${courseId} soak${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`);
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
  if (!args.has('--soak-only')) for (const t of targets) for (const vp of VIEWPORTS) await smoke(browser, base, t, vp, gl);
  if (SOAK) for (const t of targets) for (const id of SOAK_COURSES) await soak(browser, base, t, gl, id);
} finally {
  await browser.close();
  server.close();
}
console.log(failures ? `\n${failures} check(s) failed` : '\nall e2e checks passed');
process.exit(failures ? 1 : 0);
