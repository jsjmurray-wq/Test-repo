// End-to-end smoke tests in Chromium with iPhone-like viewports (Playwright, no test runner).
// Usage: node tests/e2e.spec.mjs [--shots] [--soak]
//   --shots  save screenshots to golf/screenshots/ (gitignored) for visual review
//   --soak   also play a full autoplay round (?autoplay=1&fast=20) on every course
//            (?course=pines|desert|water|links|mixed, and mixed18 = ?course=mixed&holes=18;
//            --courses=a,b for a subset) on the dev and single-file builds, with the renderer's
//            peak draw calls and triangles
//   --soak-only  skip the UI flow (soak rounds only)
//   --customiser  only the Golfer customiser checks (golferCustomiser)
//   --golfer      only the golfer-in-play checks (golferPlay, section 9.7)
//   --crowd       only the spectator checks (crowdOnly, section 10; --vp= for some viewports)
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
const vpArg = process.argv.find((a) => a.startsWith('--vp=')); // --customiser --vp=iphone-portrait,...
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
    // (The ball leaves at the golfer's impact frame, a few slow SwiftShader frames after the tap.)
    check(await waitFor(page, () => window.__golf.game.phase === 'flight', 10000), 'second tap hits: the ball is in flight');
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

  // The golfer (section 9.7): at address, the swing following the swipe, the launch at impact,
  // the races, a left-hander and a putt (builds without him skip it).
  if (await page.evaluate(() => !!(window.__golf.debug && window.__golf.debug.golferState))) await golferPlay(page, tag, gl);

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
  // Golfer customiser (section 9, Customiser): its own page in this context (builds without it skip).
  // (The game page would keep rendering a round underneath, which under SwiftShader can hold the
  // customiser's later page loads past their timeout on the big foldable canvas: it is blanked first.)
  if (await page.evaluate(() => !!document.getElementById('customiser'))) {
    await page.goto('about:blank');
    await golferCustomiser(context, `${base}/${path}${query}`, tag, gl);
  }

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
  await golferAt(page, 'Red Mesa');
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
  // Green reading (section 8.9): the read card, the preview line, the read cameras, Aim at read
  // and a putt on the notch, on three greens (older builds skip it).
  if (await page.evaluate(() => !!document.getElementById('readcard'))) await greenReading(page, tag, vpw, vph);
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
  await golferAt(page, c.name);

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

// Green reading on three greens of the round in progress (a Mixed Eighteen on its back nine, so
// the holes come from different courses): the caddie's read card fills in, the dotted preview is
// drawn, Read shows the flowing streaks within the draw-call budget and each read camera keeps the
// ball and the cup on screen, Aim at read lines the putt up on a preview that drops, and a touch
// putt on the notch holes it or stops within 0.5 m. The Putt preview setting turns it off.
async function greenReading(page, tag, vpw, vph) {
  await page.evaluate(() => window.__golf.ui.setSetting('difficulty', 'easy'));
  const spots = [[6, 30], [9, 200], [4, 120]];
  let good = 0;
  for (let k = 0; k < spots.length; k++) {
    const st = await state(page);
    if (st.phase !== 'address') {
      await page.evaluate(() => {
        const g = window.__golf.game;
        window.__golf.debug.skipTo(Math.min(g.course.holes.length - 1, g.state.holeIndex + 1));
        if (window.__golf.game.phase === 'intro') window.__golf.game.skipIntro();
      });
      await waitFor(page, () => window.__golf.game.phase === 'address', 8000);
    }
    const [d, ang] = spots[k];
    await page.evaluate(({ d, ang }) => window.__golf.debug.placeOnGreen(d, ang), { d, ang });
    const hole = await page.evaluate(() => window.__golf.game.state.holeIndex + 1);
    const readIn = await waitFor(page, () => {
      const a = window.__golf.debug.aid();
      return a.read && a.preview && a.preview.count > 1;
    }, 20000);
    const a = await page.evaluate(() => window.__golf.debug.aid());
    check(readIn && /(Breaks ~|Straight)/.test(a.card.text) && /Aim /.test(a.card.text) && /plays \d/.test(a.card.text), `hole ${hole}: caddie read card ("${a.card && a.card.text}")`);
    check(a.preview && a.preview.count > 1 && a.level === 'full', `hole ${hole}: dotted preview line (${a.preview && a.preview.count} points, ${a.level})`);
    const layout = await page.evaluate(() => {
      const r = (id) => document.querySelector(id).getBoundingClientRect();
      const hit = (p, q) => Math.min(p.right, q.right) - Math.max(p.left, q.left) > 1 && Math.min(p.bottom, q.bottom) - Math.max(p.top, q.top) > 1;
      const card = r('#readcard');
      const pad = window.__golf.debug.padRect();
      const arc = r('#pad .arc');
      const landscape = document.body.dataset.layout === 'landscape';
      const padBox = { left: pad.x, top: pad.y, right: pad.x + pad.w, bottom: pad.y + pad.h };
      return { hits: ['#topbar', '#infocard', '#tools'].filter((id) => hit(card, r(id))), pad: landscape ? hit(card, padBox) : hit(card, arc), onScreen: card.left >= 0 && card.right <= innerWidth && card.bottom < innerHeight * 0.6 };
    });
    check(!layout.hits.length && !layout.pad && layout.onScreen, `hole ${hole}: read card clear of the HUD and the swing pad (${layout.hits.join(',')}${layout.pad ? ' pad' : ''})`);
    if (k === 0) await shot(page, tag, 'putt-preview');

    // Read: streaks and arrows; each camera keeps ball and cup in view within 30 draw calls.
    await page.locator('#tools [data-act="read"]').tap();
    check(await waitFor(page, () => window.__golf.view === 'read', 3000), `hole ${hole}: Read view`);
    await page.waitForTimeout(900);
    if (k === 0) await shot(page, tag, 'read-flow');
    for (const cam of ['ball', 'hole', 'overhead']) {
      await page.locator(`#read-cams [data-cam="${cam}"]`).tap();
      // The camera glides there (slow SwiftShader frames take a while): wait until it arrives.
      await waitFor(page, () => window.__golf.debug.aid().camSettled, 12000);
      await page.waitForTimeout(700);
      const v = await page.evaluate(() => {
        const g = window.__golf.game;
        const r = window.__golf.renderer;
        const b = g.state.hole.ball;
        const c = g.terrain.cup;
        const inView = (p) => {
          const q = r.project(p.x, p.y, p.z);
          return q.visible && q.sx > 0 && q.sx < window.__golf.cssW && q.sy > 0 && q.sy < window.__golf.cssH;
        };
        return { cam: window.__golf.debug.aid().cam, pressed: document.querySelector('#read-cams [aria-pressed="true"]')?.dataset.cam, ball: inView(b), cup: inView(c), dc: r.stats().drawCalls };
      });
      check(v.cam === cam && v.pressed === cam && v.ball && v.cup && v.dc <= 30, `hole ${hole}: ${cam} camera frames ball and cup (${v.ball}/${v.cup}, ${v.dc} draw calls)`);
      if (k === 0 && cam === 'hole') await shot(page, tag, 'read-behind-hole');
    }

    // Aim at read: back to the putt view, aimed on the read, the preview drops; putt on the notch.
    await page.locator('#readcard [data-act="aim-read"]').tap();
    const aimed = await waitFor(page, () => {
      const x = window.__golf.debug.aid();
      return x.view === 'play' && x.read && Math.abs(x.aimYaw - x.read.aimYaw) < 1e-6 && x.preview && x.preview.holed;
    }, 8000);
    check(aimed, `hole ${hole}: Aim at read lines up a preview that drops`);
    if (k === 0) await shot(page, tag, 'aimed-at-read');
    await page.waitForTimeout(300);
    const p = await page.evaluate(() => {
      const dbg = window.__golf.debug;
      return { pad: dbg.padRect(), power: window.__golf.targetPower };
    });
    const y0 = p.pad.y + p.pad.h * 0.25;
    const depth = await page.evaluate(({ pw, y }) => window.__golf.debug.depthForPower(pw, 'putt', y), { pw: p.power, y: y0 });
    await swipePutt(page, p.pad.x + p.pad.w * 0.5, y0, depth);
    await waitFor(page, () => window.__golf.game.phase === 'flight', 3000);
    await waitFor(page, () => window.__golf.game.phase !== 'flight', 20000);
    const res = await page.evaluate(() => {
      const g = window.__golf.game;
      const f = g.shot ? g.shot.result.final : g.state.hole.ball;
      const c = g.terrain.cup;
      return { phase: g.phase, outcome: g.shot ? g.shot.result.final.outcome : null, d: Math.hypot(f.x - c.x, f.y - c.y), power: g.shot ? g.shot.swing.power : null };
    });
    const ok = res.outcome === 'holed' || ['holed', 'scorecard'].includes(res.phase) || res.d <= 0.5;
    if (ok) good++;
    check(ok, `hole ${hole}: putt on the notch (power ${res.power && res.power.toFixed(3)} vs ${p.power.toFixed(3)}) ${res.outcome === 'holed' ? 'holed' : `stops ${res.d.toFixed(2)} m away`}`);
  }
  check(good === spots.length, `${good}/${spots.length} notch putts holed or within 0.5 m`);

  // Settings: Putt preview Off removes the line; Auto brings it back.
  await waitFor(page, () => ['address', 'holed', 'scorecard'].includes(window.__golf.game.phase), 8000);
  if ((await state(page)).phase !== 'address') {
    await page.evaluate(() => {
      const g = window.__golf.game;
      window.__golf.ui.hideScorecard();
      window.__golf.debug.skipTo(Math.min(g.course.holes.length - 1, g.state.holeIndex + 1));
      if (window.__golf.game.phase === 'intro') window.__golf.game.skipIntro();
    });
    await waitFor(page, () => window.__golf.game.phase === 'address', 8000);
  }
  await page.locator('#pause-btn').tap();
  await page.waitForTimeout(300);
  await page.locator('#pause [data-act="settings"]').tap();
  await page.waitForTimeout(300);
  const row = await page.evaluate(() => [...document.querySelectorAll('#settings [data-setting="puttAid"] button')].map((b) => b.textContent));
  check(row.join('|') === 'Auto|Full|Part|Off', `settings row Putt preview (${row.join('|')})`);
  await page.locator('#settings [data-setting="puttAid"] [data-v="off"]').tap();
  const off = await page.evaluate(() => window.__golf.ui.getSetting('puttAid'));
  check(off === 'off', 'Putt preview set to Off');
  if (SHOTS) await page.screenshot({ path: join(shotDir, `${tag}-settings-putt-preview.png`) });
  const sheetFits = await page.evaluate(() => {
    const s = document.querySelector('#settings .sheet').getBoundingClientRect();
    return document.documentElement.scrollWidth <= innerWidth + 1 && s.right <= innerWidth + 1;
  });
  check(sheetFits, 'settings sheet fits the screen with the new row');
  await page.locator('#settings .sheet [data-act="close"]').first().tap();
  await page.locator('#pause [data-act="unpause"]').tap().catch(() => {});
  await page.evaluate(() => window.__golf.debug.placeOnGreen(5, 0));
  check(await waitFor(page, () => {
    const a = window.__golf.debug.aid();
    return a.level === 'off' && !(window.__golf.lastScene.paths || []).length && a.read;
  }, 8000), 'Putt preview Off: no preview line (the read card stays)');
  await page.evaluate(() => {
    window.__golf.ui.setSetting('puttAid', 'auto');
    window.__golf.ui.setSetting('difficulty', 'normal');
  });
}

// ------------------------------------------------------------------ the golfer in play (section 9.7)
// One finger down `depth` px (the backswing), then onHold() while the finger rests at the bottom,
// then `up` = 'flick' (a strike) or 'lift' (released at the bottom: a cancel). Event times carry
// the real pause, so the swing interpreter sees a held backswing.
async function swingWithHold(page, x, y, depth, up, onHold) {
  const cdp = await page.context().newCDPSession(page);
  const tp = (px, py) => [{ x: px, y: py, id: 1, radiusX: 4, radiusY: 4, force: 1 }];
  let T = Date.now() / 1000;
  const move = async (px, py, dt) => {
    T += dt / 1000;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: tp(px, py), timestamp: T });
  };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: tp(x, y), timestamp: T });
  for (let i = 1; i <= 15; i++) await move(x, y + (depth * i) / 15, 20);
  const t0 = Date.now();
  if (onHold) await onHold();
  T += (Date.now() - t0) / 1000;
  await move(x, y + depth, 30);
  if (up === 'flick') for (let i = 1; i <= 4; i++) await move(x, y + depth - (0.45 * depth * i) / 4, 16);
  else await move(x, y + depth - 1, 300);
  T += 0.008;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [], timestamp: T });
  await cdp.detach();
}

const golfer = (page) => page.evaluate(() => window.__golf.debug.golferState());

// Mid-backswing HUD vs the golfer (review 4): his body's box on screen (debug.golferBox) clear of
// the live readout and of the target notch (a notch for a long shot: a short one's notch sits
// low on the power arc, over the golfer's side, a known gap); the arc mirrored for a left-hander
// (its notch and overswing on the open side); a landscape left-hander stands left of the pad.
async function golferHudClear(page, what) {
  const r = await page.evaluate(() => {
    const rect = (sel) => {
      const e = document.querySelector(sel);
      if (!e || getComputedStyle(e).display === 'none') return null;
      const b = e.getBoundingClientRect();
      return b.width > 0 ? { x0: b.left, y0: b.top, x1: b.right, y1: b.bottom } : null;
    };
    return {
      box: window.__golf.debug.golferBox(),
      readout: rect('#pad .pad-readout'),
      notch: window.__golf.ui._target >= 0.75 ? rect('#pad .arc-target') : null,
      tf: getComputedStyle(document.querySelector('#pad svg.arc')).transform,
      handed: window.__golf.debug.golferState().handed,
      land: document.body.dataset.layout === 'landscape',
      pad: window.__golf.debug.padRect(),
    };
  });
  const hit = (a, b) => !!(a && b && a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1);
  const fmt = (b) => (b ? `${Math.round(b.x0)}-${Math.round(b.x1)} x ${Math.round(b.y0)}-${Math.round(b.y1)}` : 'none');
  check(r.box && !hit(r.box, r.readout) && !hit(r.box, r.notch), `golfer: ${what}: the readout (${fmt(r.readout)}) and notch (${fmt(r.notch)}) clear of him (${fmt(r.box)})`);
  check((r.handed === 'L') === /matrix\(-1/.test(r.tf), `golfer: ${what}: the arc ${r.handed === 'L' ? 'mirrored' : 'as drawn'} (${r.tf})`);
  if (r.land && r.handed === 'L' && r.box) check(r.box.x1 < r.pad.x, `golfer: ${what}: a landscape left-hander stands left of the pad (${Math.round(r.box.x1)} < ${Math.round(r.pad.x)} px)`);
}

// After a shot: back at address (a water drop taken), the golfer placed at the new spot.
async function golferResolve(page, what) {
  const ok = await waitFor(page, () => ['address', 'decision', 'holed', 'scorecard'].includes(window.__golf.game.phase), 45000);
  if ((await state(page)).phase === 'decision') {
    await page.locator('#decision [data-dec="drop"]').tap();
    await waitFor(page, () => window.__golf.game.phase === 'address', 3000);
  }
  check(ok, `golfer: ${what} resolved`);
}

// Full-swing checks need the ball off the green (on it, a release at the bottom strokes a putt):
// moved back 60 m down the line from the cup when it is on the green.
async function offGreen(page) {
  if (!(await state(page)).putt) return;
  await page.evaluate(() => window.__golf.debug.placeNearCup(60));
  await waitFor(page, () => window.__golf.game.phase === 'address' && !window.__golf.game.isPutt && window.__golf.debug.golferState().state === 'address', 5000);
  await page.waitForTimeout(400);
}

// The golfer standing at the ball at address on this course: placed, drawn, holding the club.
async function golferAt(page, where) {
  if (!(await page.evaluate(() => !!(window.__golf.debug && window.__golf.debug.golferState)))) return;
  await waitFor(page, () => {
    const s = window.__golf.debug.golferState();
    return s.placed && (s.drawn || window.__golf.renderer.isNull);
  }, 5000);
  const s = await golfer(page);
  const st = await state(page);
  check(s.shown && s.placed && s.club === st.clubId && ['address', 'backswing'].includes(s.state), `golfer: at the ball on ${where} (${s.state}, ${s.club})`);
}

async function golferPlay(page, tag, gl) {
  await golferResolve(page, 'the previous shot');
  if ((await state(page)).phase !== 'address') return;
  await offGreen(page);
  await page.waitForTimeout(500);
  const isNull = await page.evaluate(() => !!window.__golf.renderer.isNull);

  // ---- at address: placed at the ball with the selected club, drawn, on his side of the ball
  let s = await golfer(page);
  let st = await state(page);
  const ch = await page.evaluate(() => window.__golf.debug.clubHead());
  check(s.shown && s.placed && s.state === 'address' && s.club === st.clubId && s.handed === 'R' && s.mirror === 1, `golfer: at address with the ${s.club} (${s.state}, ${s.handed})`);
  check(ch.dist < 0.06, `golfer: club head soled at the ball (${(ch.dist * 100).toFixed(1)} cm)`);
  if (gl && !isNull) {
    check(s.drawn, 'golfer: in the scene (scene.golfer)');
    const ball = await page.evaluate(() => {
      const b = window.__golf.game.ballPos();
      return window.__golf.renderer.project(b.x, b.y, b.z);
    });
    check(s.chest.visible && s.chest.sx < ball.sx - 20 && s.head.sy < ball.sy, `golfer: a right-hander stands left of the ball (chest ${Math.round(s.chest.sx)} px, ball ${Math.round(ball.sx)} px)`);
    // Draw calls with and without him, and the pixel on his chest against the background there.
    await page.evaluate(() => window.__golf.debug.freeze(true));
    await page.waitForTimeout(500);
    const withG = await page.evaluate(() => {
      const p = window.__golf.debug.golferState().chest;
      return { dc: window.__golf.renderer.stats().drawCalls, px: window.__golf.renderer.debugPixel(p.sx, p.sy), p };
    });
    await page.evaluate(() => window.__golf.debug.hideGolfer(true));
    await page.waitForTimeout(700);
    const without = await page.evaluate((p) => ({ dc: window.__golf.renderer.stats().drawCalls, px: window.__golf.renderer.debugPixel(p.sx, p.sy) }), withG.p);
    await page.evaluate(() => window.__golf.debug.hideGolfer(false));
    await page.waitForTimeout(400);
    await page.evaluate(() => window.__golf.debug.freeze(false));
    const diff = withG.px.slice(0, 3).reduce((a, v, i) => a + Math.abs(v - without.px[i]), 0);
    check(withG.dc - without.dc >= 1 && withG.dc <= 30, `golfer: his draw calls (${withG.dc} with him, ${without.dc} without)`);
    check(diff > 30, `golfer: his silhouette differs from the background (${withG.px.slice(0, 3).join(',')} vs ${without.px.slice(0, 3).join(',')})`);
  }
  await shot(page, tag, 'golfer-address');

  // ---- a held swipe: the backswing follows the gauge; the strike launches the ball at impact
  let pad = await page.evaluate(() => window.__golf.debug.padRect());
  const y0 = pad.y + pad.h * 0.2;
  const depth = await page.evaluate((y) => window.__golf.debug.depthForPower(0.8, 'full', y), y0);
  const strokes0 = st.strokes;
  let top = null;
  await swingWithHold(page, pad.x + pad.w * 0.5, y0, Math.min(depth, pad.h * 0.7), 'flick', async () => {
    await waitFor(page, () => window.__golf.debug.golferState().u > 1.2, 4000);
    await page.waitForTimeout(300);
    top = await page.evaluate(() => ({ g: window.__golf.debug.golferState(), power: window.__golf.swingPower, phase: window.__golf.game.phase }));
    await shot(page, tag, 'golfer-top');
    if (gl && !isNull) await golferHudClear(page, 'top of the backswing');
  });
  check(top && top.g.state === 'backswing' && top.phase === 'address' && Math.abs(top.g.power - top.power) < 1e-6 && top.g.u > 1.2, `golfer: the backswing follows the live power (${top && top.g.state}, power ${top && top.power && top.power.toFixed(2)}, u ${top && top.g.u.toFixed(2)})`);
  check(await waitFor(page, () => window.__golf.game.phase === 'flight', 5000), 'golfer: the swipe strikes');
  s = await golfer(page);
  const L = s.last || {};
  check(L.how === 'impact' && L.launchAt - L.strikeAt >= L.tImpact - 1e-6 && L.tImpact >= 0.2 && L.tImpact <= 0.34 && L.headErr < 0.02,
    `golfer: the ball leaves at the impact frame (${L.how}, ${((L.launchAt - L.strikeAt) * 1000).toFixed(0)} ms after the strike, downswing ${(L.tImpact * 1000).toFixed(0)} ms, club ${(L.headErr * 100).toFixed(2)} cm from the ball)`);
  st = await state(page);
  check(st.strokes === strokes0 + 1, `golfer: one stroke (${strokes0} -> ${st.strokes})`);
  await page.waitForTimeout(300);
  s = await golfer(page);
  check(['follow', 'finish'].includes(s.state) && s.shown, `golfer: follow-through while the ball flies (${s.state})`);
  await shot(page, tag, 'golfer-follow-through');
  await golferResolve(page, 'the golfer swing');
  if ((await state(page)).phase !== 'address') return;
  await waitFor(page, () => window.__golf.debug.golferState().state === 'address', 3000);
  s = await golfer(page);
  st = await state(page);
  const b2 = await page.evaluate(() => window.__golf.game.ballPos());
  const near = Math.hypot(s.pelvis.x - b2.x, s.pelvis.y - b2.y);
  check(s.placed && s.state === 'address' && s.club === st.clubId && near < 2, `golfer: steps up to the ball for the next shot (${near.toFixed(2)} m, ${s.club})`);

  // ---- a cancel (held at the bottom and lifted) eases back to address, no stroke
  await offGreen(page);
  st = await state(page);
  pad = await page.evaluate(() => window.__golf.debug.padRect());
  let held = null;
  await swingWithHold(page, pad.x + pad.w * 0.5, pad.y + pad.h * 0.2, Math.min(200, pad.h * 0.3), 'lift', async () => {
    await waitFor(page, () => window.__golf.debug.golferState().state === 'backswing', 3000);
    held = (await golfer(page)).state;
  });
  await page.waitForTimeout(300);
  s = await golfer(page);
  const st2 = await state(page);
  check(held === 'backswing' && ['cancel', 'address'].includes(s.state) && st2.strokes === st.strokes && st2.phase === 'address', `golfer: a cancelled swing eases back to address (${held} -> ${s.state}, ${st2.strokes} strokes)`);
  await waitFor(page, () => window.__golf.debug.golferState().state === 'address', 3000);

  // ---- races: a strike frozen before its impact frame (the frame clock stopped); a second swipe
  // is ignored; pausing strikes it at once (one stroke); the animation reaching impact later
  // launches nothing more. (Swipes: their speeds come from the event times, so a slow, loaded
  // SwiftShader cannot turn them into something else.)
  await page.evaluate(() => window.__golf.debug.freeze(true));
  const pen0 = await page.evaluate(() => window.__golf.game.state.hole.penalties || 0);
  pad = await page.evaluate(() => window.__golf.debug.padRect());
  const fx = pad.x + pad.w * 0.5;
  const fy = pad.y + pad.h * 0.2;
  const fd = Math.min(await page.evaluate((y) => window.__golf.debug.depthForPower(0.6, 'full', y), fy), pad.h * 0.7);
  await swingWithHold(page, fx, fy, fd, 'flick', null);
  await page.waitForTimeout(300);
  const pend = await page.evaluate(() => ({ pending: !!window.__golf.golfer.pending, phase: window.__golf.game.phase, strokes: window.__golf.game.state.hole.strokes, mode: window.__golf.input.mode }));
  check(pend.pending && pend.phase === 'address' && pend.strokes === st2.strokes && pend.mode === 'disabled', `golfer: a struck swing waits for its impact frame, input off (${JSON.stringify(pend)})`);
  await swingWithHold(page, fx, fy, fd, 'flick', null);
  await page.waitForTimeout(200);
  check((await state(page)).strokes === st2.strokes && (await page.evaluate(() => !!window.__golf.golfer.pending)), 'golfer: a second swipe during the downswing is ignored');
  await page.locator('#pause-btn').tap();
  await page.waitForTimeout(500);
  const flushed = await page.evaluate(() => ({ pending: !!window.__golf.golfer.pending, phase: window.__golf.game.phase, strokes: window.__golf.game.state.hole.strokes, how: window.__golf.golfer.last.how }));
  check(!flushed.pending && flushed.phase === 'flight' && flushed.strokes === st2.strokes + 1 && flushed.how === 'impact', `golfer: pausing mid-downswing strikes it once (${JSON.stringify(flushed)})`);
  await page.locator('#pause [data-act="unpause"]').tap();
  await page.evaluate(() => window.__golf.debug.freeze(false));
  await golferResolve(page, 'the paused swing');
  const after = await state(page);
  // (A penalty taken on the way, e.g. a water drop, adds its stroke: counted apart.)
  const pen = await page.evaluate(() => window.__golf.game.state.hole.penalties || 0);
  check(after.strokes - pen === st2.strokes + 1 - pen0 || ['holed', 'scorecard'].includes(after.phase), `golfer: still one stroke after the animation caught up (${after.strokes}, penalties ${pen0} -> ${pen})`);
  if (after.phase !== 'address') return;

  // ---- a left-hander: the mirror image, on the other side of the ball
  await page.evaluate(() => window.__golf.ui.setSetting('handed', 'L'));
  await waitFor(page, () => window.__golf.debug.golferState().handed === 'L', 3000);
  await page.waitForTimeout(600);
  s = await golfer(page);
  if (gl && !isNull) {
    const ball = await page.evaluate(() => {
      const b = window.__golf.game.ballPos();
      return window.__golf.renderer.project(b.x, b.y, b.z);
    });
    check(s.mirror === -1 && s.chest.sx > ball.sx + 20, `golfer: a left-hander stands right of the ball, mirrored (chest ${Math.round(s.chest.sx)} px, ball ${Math.round(ball.sx)} px)`);
  } else check(s.mirror === -1, 'golfer: a left-hander is mirrored');
  await shot(page, tag, 'golfer-lefty');
  if (gl && !isNull && !(await state(page)).putt) {
    // A left-hander's backswing (held, then let go at the bottom: a cancel, no stroke).
    const lp = await page.evaluate(() => window.__golf.debug.padRect());
    const ly = lp.y + lp.h * 0.2;
    const ld = Math.min(await page.evaluate((y) => window.__golf.debug.depthForPower(0.85, 'full', y), ly), lp.h * 0.7);
    await swingWithHold(page, lp.x + lp.w * 0.5, ly, ld, 'lift', async () => {
      await waitFor(page, () => window.__golf.debug.golferState().u > 1.2, 4000);
      await page.waitForTimeout(300);
      await shot(page, tag, 'golfer-lefty-top');
      await golferHudClear(page, 'a left-hander at the top');
    });
    await waitFor(page, () => window.__golf.debug.golferState().state === 'address', 3000);
  }
  await page.evaluate(() => window.__golf.ui.setSetting('handed', 'R'));
  await waitFor(page, () => window.__golf.debug.golferState().handed === 'R', 3000);

  // ---- a putt: the putter in his hands, the putting stroke, the ball rolls at its impact
  await page.evaluate(() => window.__golf.debug.placeNearCup(3));
  await waitFor(page, () => window.__golf.game.isPutt && window.__golf.debug.golferState().club === 'P', 4000);
  await page.waitForTimeout(800);
  s = await golfer(page);
  check(s.club === 'P' && s.kind === 'putt' && s.state === 'address' && s.placed, `golfer: putter in hand on the green (${s.club}, ${s.kind})`);
  await shot(page, tag, 'golfer-putt');
  const pp = await page.evaluate(() => {
    const g = window.__golf.game;
    const dbg = window.__golf.debug;
    return { pad: dbg.padRect(), depth: dbg.depthForPower(1 / g.puttRange, 'putt') }; // a 1 m putt: never holed from 3 m
  });
  await swipePutt(page, pp.pad.x + pp.pad.w * 0.5, pp.pad.y + pp.pad.h * 0.25, pp.depth);
  check(await waitFor(page, () => window.__golf.game.phase === 'flight', 5000), 'golfer: the putt is struck');
  s = await golfer(page);
  const P = s.last || {};
  check(P.kind === 'putt' && P.how === 'impact' && P.launchAt - P.strikeAt >= 0.3 && P.headErr < 0.02, `golfer: the putt rolls at the stroke's impact (${((P.launchAt - P.strikeAt) * 1000).toFixed(0)} ms, ${(P.headErr * 100).toFixed(2)} cm)`);
  await golferResolve(page, 'the putt');
}

// --golfer: a new round on Hollow Pines, then golferPlay (no other flows).
async function golferOnly(browser, base, path, vp, gl) {
  const query = gl ? '?test=1&quality=low&fast=8' : '?test=1&nogl=1&fast=8';
  console.log(`\n[${vp.name}] ${path}${query} golfer`);
  const tag = `${vp.name}-${path.replace(/\W+/g, '_')}`;
  const context = await browser.newContext({ ...vp });
  const page = await context.newPage();
  const errors = collectErrors(page);
  await page.goto(`${base}/${path}${query}`);
  await waitFor(page, () => !document.getElementById('menu').hidden, 15000);
  if (!(await page.evaluate(() => !!(window.__golf.debug && window.__golf.debug.golferState)))) {
    console.log('  (no golfer in this build: skipped)');
    await context.close();
    return;
  }
  await page.locator('#menu [data-act="new-round"]').tap();
  await waitFor(page, () => window.__golf.game && window.__golf.game.phase === 'intro', 8000);
  await page.touchscreen.tap(vp.viewport.width * 0.5, vp.viewport.height * 0.35);
  check(await waitFor(page, () => window.__golf.game.phase === 'address', 8000), 'golfer: address on the first tee');
  await golferAt(page, 'Hollow Pines');
  await golferPlay(page, tag, gl);
  check(errors.length === 0, `no console/page errors${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`);
  await context.close();
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
  // The golfer swung every bot shot, each launched at his impact frame (builds without him skip it).
  const gs = await page.evaluate(() => window.__golf.golfer && { count: window.__golf.golfer.count, last: window.__golf.golfer.last });
  if (gs && gs.count) check(gs.count.impact > 9 && !gs.count.watchdog && gs.last.headErr < 0.02, `${courseId}: the golfer struck ${gs.count.impact} shots at impact (${JSON.stringify(gs.count)})`);
  await page.waitForTimeout(500);
  if (SHOTS) await page.screenshot({ path: join(shotDir, `soak-${courseId}-${path.replace(/\W+/g, '_')}.png`) });
  check(errors.length === 0, `no errors during the ${courseId} soak${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`);
  await context.close();
}

// Golfer customiser (section 9, Customiser), on a new page of the same context (the saved look
// lives in its localStorage): the menu's Golfer button opens it over the live 3D preview (preview
// on top in portrait, on the left in landscape, nothing overlapping); a new figure, skin tone,
// height, hairstyle, hat colour, shirt and swing style show on the preview golfer at once; a drag
// turns him and a double tap zooms to his face; Try swing plays a swing through impact and back to
// address; Done saves (golf.golfer.v1) and the golfer in a new round wears the look; Cancel from
// the pause sheet changes nothing; a reload keeps the look; a preset; and with storage failing,
// Done still works for the session. Builds without the customiser (a stale dist/) skip it.
async function golferCustomiser(context, url, tag, gl) {
  const page = await context.newPage();
  const errors = collectErrors(page);
  await page.goto(url);
  check(await waitFor(page, () => !document.getElementById('menu').hidden, 15000), 'golfer: menu');
  await page.waitForTimeout(300);
  const studio = () => page.evaluate(() => window.__golf.debug.studio());
  const cz = (sel) => page.locator(`#customiser ${sel}`).first();
  const lookOf = (fields) => page.evaluate((f) => {
    const L = window.__golf.debug.studio().look || {};
    return Object.fromEntries(f.map((k) => [k, L[k]]));
  }, fields);
  const saved = () => page.evaluate(() => JSON.parse(localStorage.getItem('golf.golfer.v1') || 'null'));
  const shown = (sel) => page.evaluate((q) => {
    const el = document.querySelector(q);
    return !!el && !el.hidden && getComputedStyle(el).display !== 'none';
  }, sel);
  // A tab, waiting until its pane is the one shown (a lost tap is tapped again).
  const tab = async (id) => {
    for (let i = 0; i < 3; i++) {
      await cz(`[data-cz-tab="${id}"]`).tap();
      if (await waitFor(page, (t) => window.__golf.customiser.tab === t && !document.querySelector(`#customiser [data-cz-pane="${t}"]`).hidden, 3000, id)) return true;
    }
    return false;
  };

  // ---- open from the menu: layout
  await page.locator('#menu [data-act="golfer"]').tap();
  check(await waitFor(page, () => window.__golf.debug.studio().open && document.body.dataset.customiser === '1', 4000), "golfer: the menu's Golfer button opens the customiser");
  // Let the sheet's slide-in finish (slow SwiftShader frames hold CSS animations back).
  await page.evaluate(() => Promise.race([Promise.all(document.getElementById('customiser').getAnimations({ subtree: true }).map((a) => a.finished)), new Promise((r) => setTimeout(r, 5000))]));
  await page.waitForTimeout(300);
  const lay = await page.evaluate(() => {
    const r = (q) => document.querySelector(q).getBoundingClientRect();
    const st = r('#customiser .cz-stage');
    const pn = r('#customiser .cz-panel');
    const fr = window.__golf.customiser.frameRect;
    const land = document.body.dataset.layout === 'landscape';
    const panes = document.querySelector('#customiser .cz-panes');
    const inside = (b) => b.left >= -0.5 && b.top >= -0.5 && b.right <= innerWidth + 0.5 && b.bottom <= innerHeight + 0.5;
    const btns = [...document.querySelectorAll('#customiser [role="tab"], #customiser .cz-foot .btn, #customiser .cz-stage button')].map((b) => b.getBoundingClientRect());
    // The stage's buttons must not cover each other.
    const sb = [...document.querySelectorAll('#customiser .cz-stage button')].map((b) => b.getBoundingClientRect());
    let hits = 0;
    for (let i = 0; i < sb.length; i++) for (let j = i + 1; j < sb.length; j++) if (Math.min(sb[i].right, sb[j].right) - Math.max(sb[i].left, sb[j].left) > 1 && Math.min(sb[i].bottom, sb[j].bottom) - Math.max(sb[i].top, sb[j].top) > 1) hits++;
    return {
      land,
      overlap: land ? st.right - pn.left > 1 : st.bottom - pn.top > 1,
      menu: getComputedStyle(document.getElementById('menu')).display !== 'none',
      hscroll: panes.scrollWidth > panes.clientWidth + 1 || document.documentElement.scrollWidth > innerWidth + 1,
      buttons: btns.every((b) => inside(b) && b.height >= 36),
      frame: fr.w >= 150 && fr.h >= 150 && fr.y >= st.top - 0.5 && fr.y + fr.h <= st.bottom + 0.5,
      hits,
    };
  });
  check(!lay.overlap && !lay.menu && !lay.hscroll && lay.buttons && lay.frame && !lay.hits, `golfer: ${lay.land ? 'preview left, controls right' : 'preview on top, controls below'}, nothing overlaps (${JSON.stringify(lay)})`);
  if (gl) {
    const s = await studio();
    check(!!s.meshKey && s.state === 'address' && Math.abs(s.shift[0]) <= 1 && Math.abs(s.shift[1]) <= 1, `golfer: the 3D preview golfer at address, framed in the stage (shift ${s.shift.map((v) => v.toFixed(2))})`);
  }
  await shot(page, tag, 'golfer-body');

  // ---- Body: figure, skin tone, height (a slider drag: throttled rebuilds, the label at once)
  await cz('[data-cz-key="body"][data-cz-val="female"]').tap();
  await cz('[data-cz-key="skin"][data-cz-val="6"]').tap();
  await page.evaluate(() => {
    const s = document.querySelector('#customiser input[data-cz-key="height"]');
    for (const v of [172, 168, 166]) {
      s.value = String(v);
      s.dispatchEvent(new Event('input', { bubbles: true }));
    }
    s.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const hLabel = await page.evaluate(() => document.querySelector('#customiser [data-cz-value="height"]').textContent);
  check(await waitFor(page, () => {
    const L = window.__golf.debug.studio().look;
    return L.body === 'female' && L.skin === 6 && L.height === 166;
  }, 3000), `golfer: female figure, skin tone 7 and 166 cm on the preview ("${hLabel}")`);
  const fhRow = await shown('#customiser [data-cz-row="facialHair"]');
  check(!fhRow, 'golfer: no facial hair options for a female figure');

  // ---- Hair & Face: the camera goes to the face; a hairstyle
  await tab('face');
  await cz('[data-cz-key="hair"][data-cz-val="curly"]').tap();
  check(await waitFor(page, () => window.__golf.debug.studio().look.hair === 'curly' && window.__golf.customiser.view.zoom > 0.6, 6000), 'golfer: curly hair, and the Hair & Face tab zooms to the face');
  await page.waitForTimeout(600);
  await shot(page, tag, 'golfer-face');
  // A drag turns him; a double tap goes back to the full body.
  const box = await page.evaluate(() => {
    const f = window.__golf.customiser.frameRect;
    return { x: f.x + f.w / 2, y: f.y + f.h / 2 };
  });
  const yaw0 = await page.evaluate(() => window.__golf.customiser.view.yaw);
  await touchPath(page, [[box.x - 60, box.y], [box.x - 20, box.y, 30], [box.x + 20, box.y, 30], [box.x + 60, box.y, 30], [box.x + 70, box.y, 200]]);
  const yaw1 = await page.evaluate(() => window.__golf.customiser.view.yaw);
  check(Math.abs(yaw1 - yaw0) > 0.8, `golfer: a drag on the preview turns him (${(((yaw1 - yaw0) * 180) / Math.PI).toFixed(0)} deg)`);
  const T = Date.now() / 1000 + 1;
  await cdpTap(page, box.x, box.y, T);
  await cdpTap(page, box.x + 4, box.y, T + 0.15);
  check(await waitFor(page, () => window.__golf.customiser.view.zoom < 0.3, 6000), 'golfer: a double tap zooms back out to the full body');

  // ---- Clothes: hat colour, striped shirt (its stripe colour row appears)
  await tab('clothes');
  await cz('[data-cz-key="headwear"][data-cz-val="cap"]').tap();
  await cz('[data-cz-key="hatColor"][data-cz-val="#b51f2b"]').tap();
  await cz('[data-cz-key="shirt"][data-cz-val="striped"]').tap();
  const stripe = await page.evaluate(() => {
    const r = document.querySelector('#customiser [data-cz-row="shirtColor2"]');
    return !r.hidden && r.querySelector('.cz-label').textContent;
  });
  check(await waitFor(page, () => {
    const L = window.__golf.debug.studio().look;
    return L.hatColor === '#b51f2b' && L.shirt === 'striped' && L.headwear === 'cap';
  }, 3000) && stripe === 'Stripe colour', `golfer: red cap and a striped polo ("${stripe}" row)`);
  await page.waitForTimeout(400);
  await shot(page, tag, 'golfer-clothes');

  // ---- Swing: a style plays a swing at once; Try swing goes through impact and back to address
  await tab('swing');
  const n0 = await studio();
  await cz('[data-cz-key="swing"][data-cz-val="bigfinish"]').tap();
  check(await waitFor(page, (n) => window.__golf.debug.studio().look.swing === 'bigfinish' && window.__golf.debug.studio().swings > n, 3000, n0.swings), 'golfer: picking Big finish plays a swing');
  if (gl) {
    check(await waitFor(page, () => window.__golf.debug.studio().swing === 0, 40000), 'golfer: ... and he steps back to address');
    const n1 = await studio();
    await cz('.cz-stage [data-cz="try"]').tap();
    const busy = await page.evaluate(() => document.querySelector('#customiser .cz-stage [data-cz="try"]').dataset.busy);
    const hit = await waitFor(page, (n) => window.__golf.debug.studio().impacts > n, 30000, n1.impacts);
    check(hit && busy === '1', `golfer: Try swing strikes the ball (button busy while swinging: ${busy})`);
    await page.waitForTimeout(300);
    await shot(page, tag, 'golfer-swing');
    check(await waitFor(page, () => window.__golf.debug.studio().swing === 0 && window.__golf.debug.studio().state === 'address', 40000), 'golfer: Try swing ends back at address with the ball teed again');
  }

  // ---- Done: saved, the menu shows him, a new round's golfer wears the look
  const want = await lookOf(['body', 'skin', 'height', 'hair', 'headwear', 'hatColor', 'shirt', 'swing']);
  await cz('[data-cz="done"]').tap();
  check(await waitFor(page, () => document.getElementById('customiser').hidden && !document.body.dataset.customiser, 3000) && (await shown('#menu')), 'golfer: Done closes the customiser back to the menu');
  const sv = await saved();
  check(!!sv && Object.keys(want).every((k) => sv[k] === want[k]), `golfer: Done saves the look in golf.golfer.v1 (${sv && `${sv.body}, ${sv.hair}, ${sv.shirt}, ${sv.swing}`})`);
  const fullKey = sv ? Object.values(sv).join('|') : '';
  await page.locator('#menu [data-act="new-round"]').tap();
  await waitFor(page, () => window.__golf.game && window.__golf.game.phase === 'intro', 8000);
  await page.waitForTimeout(250);
  await page.touchscreen.tap(200, 200);
  check(await waitFor(page, () => window.__golf.game.phase === 'address', 8000), 'golfer: a new round reaches the first address');
  await page.waitForTimeout(600);
  const inGame = await page.evaluate((key) => {
    const d = window.__golf.debug;
    const L = d.golferLook ? d.golferLook() : null;
    const gs = window.__golf.golfer && window.__golf.golfer.scene;
    return { look: L, mesh: gs && gs.mesh ? gs.mesh.key.startsWith(`${key}#`) : null };
  }, fullKey);
  check(!!inGame.look && Object.keys(want).every((k) => inGame.look[k] === want[k]) && inGame.mesh !== false, `golfer: the in-game golfer wears the saved look (${inGame.look && `${inGame.look.body}, ${inGame.look.hair}`}; mesh ${inGame.mesh})`);
  await shot(page, tag, 'golfer-ingame');

  // ---- from the pause sheet; Cancel reverts
  await page.locator('#pause-btn').tap();
  await page.waitForTimeout(500);
  await page.locator('#pause [data-act="golfer"]').tap();
  check(await waitFor(page, () => window.__golf.debug.studio().open && document.getElementById('customiser').dataset.from === 'pause', 4000) && !(await shown('#pause')) && !(await shown('#hud')), 'golfer: the pause sheet opens it too (pause sheet and HUD hidden underneath)');
  const onClothes = await tab('clothes');
  const cs = await page.evaluate(() => ({ open: window.__golf.customiser.isOpen, tab: window.__golf.customiser.tab, flag: document.body.dataset.customiser || null, phase: window.__golf.game && window.__golf.game.phase, paused: window.__golf.paused }));
  check(onClothes, `golfer: the Clothes tab from the pause sheet (${JSON.stringify(cs)})`);
  await cz('[data-cz-key="shirtColor"][data-cz-val="#e5802e"]').tap();
  await cz('[data-cz-key="legwear"][data-cz-val="shorts"]').tap();
  check(await waitFor(page, () => window.__golf.debug.studio().look.legwear === 'shorts', 3000), 'golfer: changes show on the preview');
  await cz('[data-cz="cancel"]').tap();
  await page.waitForTimeout(400);
  const after = await page.evaluate(() => ({ L: window.__golf.debug.golferLook ? window.__golf.debug.golferLook() : null, paused: window.__golf.paused }));
  const sv2 = await saved();
  check(!(await page.evaluate(() => window.__golf.debug.studio().open)) && (await shown('#pause')) && after.paused && JSON.stringify(sv2) === JSON.stringify(sv) && (!after.L || after.L.legwear === sv.legwear), 'golfer: Cancel reverts (saved and in-game look unchanged, back on the pause sheet)');
  await page.locator('#pause [data-act="unpause"]').tap();
  await page.waitForTimeout(300);

  // ---- reload: the look persists; Escape cancels; a preset
  await page.reload();
  check(await waitFor(page, () => !document.getElementById('menu').hidden, 15000), 'golfer: menu after reload');
  const name = await page.evaluate(() => document.querySelector('#menu [data-golfer-name]').textContent);
  await page.locator('#menu [data-act="golfer"]').tap();
  await waitFor(page, () => window.__golf.debug.studio().open, 4000);
  const reL = await lookOf(Object.keys(want));
  check(Object.keys(want).every((k) => reL[k] === want[k]) && name === 'Custom golfer', `golfer: the look survives a reload (menu: "${name}")`);
  await page.keyboard.press('Escape');
  check(await waitFor(page, () => !window.__golf.debug.studio().open, 3000) && (await shown('#menu')) && !(await page.evaluate(() => window.__golf.paused)), 'golfer: Escape cancels back to the menu');
  await page.locator('#menu [data-act="golfer"]').tap();
  await waitFor(page, () => window.__golf.debug.studio().open, 4000);
  // (The presets row may still be scrolling the pill into view under a slow SwiftShader frame: a
  // tap that lands while it moves is tried once more.)
  const isPower = () => page.evaluate(() => document.querySelector('#customiser [data-cz-f="title"]').textContent === 'Power Hitter');
  for (let i = 0; i < 2 && !(await isPower()); i++) {
    await cz('[data-cz-preset="power"]').tap();
    await waitFor(page, () => document.querySelector('#customiser [data-cz-f="title"]').textContent === 'Power Hitter', 2000);
  }
  const title = await page.evaluate(() => document.querySelector('#customiser [data-cz-f="title"]').textContent);
  await cz('[data-cz="done"]').tap();
  await page.waitForTimeout(300);
  const sv3 = await saved();
  const name3 = await page.evaluate(() => document.querySelector('#menu [data-golfer-name]').textContent);
  check(title === 'Power Hitter' && sv3 && sv3.swing === 'bigfinish' && sv3.facialHair === 'beard' && name3 === 'Power Hitter', `golfer: a preset ("${title}") is saved and named on the menu ("${name3}")`);
  check(errors.length === 0, `golfer: no console/page errors${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`);
  await page.close();

  // ---- storage failing (private mode, quota): Done still works for the session
  const p2 = await context.newPage();
  const errs2 = collectErrors(p2);
  await p2.addInitScript(() => {
    const proto = Object.getPrototypeOf(window.localStorage);
    const set = proto.setItem;
    proto.setItem = function (k, v) {
      if (k === 'golf.golfer.v1') throw new Error('QuotaExceededError');
      return set.call(this, k, v);
    };
  });
  await p2.goto(url);
  await waitFor(p2, () => !document.getElementById('menu').hidden, 15000);
  await p2.locator('#menu [data-act="golfer"]').tap();
  await waitFor(p2, () => window.__golf.debug.studio().open, 4000);
  await p2.locator('#customiser [data-cz-preset="gent"]').first().tap();
  await p2.locator('#customiser [data-cz="done"]').first().tap();
  await p2.waitForTimeout(300);
  await p2.locator('#menu [data-act="golfer"]').tap();
  await waitFor(p2, () => window.__golf.debug.studio().open, 4000);
  const mem = await p2.evaluate(() => ({ L: window.__golf.debug.studio().look, stored: localStorage.getItem('golf.golfer.v1'), name: document.querySelector('#customiser [data-cz-f="title"]').textContent }));
  check(mem.L.shirt === 'vest' && mem.L.headwear === 'flatcap' && mem.name === 'Classic Gent', `golfer: with storage failing, the look is kept in memory for the session ("${mem.name}", stored: ${mem.stored ? 'stale copy' : 'none'})`);
  await p2.locator('#customiser [data-cz="cancel"]').first().tap();
  check(errs2.length === 0, `golfer: no errors when storage fails${errs2.length ? ': ' + errs2.slice(0, 3).join(' | ') : ''}`);
  await p2.close();
}

// ------------------------------------------------------------------ spectators (section 10)
// Galleries on every course (a par 3 each, so the grandstand too: 2 draw calls, the Light subset
// at quality=low), the green gallery from a putt, the Crowd setting (Off removes them, persisted)
// and a holed putt's cheer. Builds without spectators (a stale dist/) skip. Also alone: --crowd.
async function crowdOnly(browser, base, path, vp, gl) {
  const query = gl ? '?test=1&quality=low&fast=8' : '?test=1&nogl=1&fast=8';
  const tag = `${vp.name}-${path.replace(/\W+/g, '_')}`;
  const context = await browser.newContext({ ...vp });
  const page = await context.newPage();
  const errors = collectErrors(page);
  const vpw = vp.viewport.width;
  const vph = vp.viewport.height;
  const courses = [['pines', 2], ['desert', 6], ['water', 6], ['links', 7]];
  for (let k = 0; k < courses.length; k++) {
    const [course, hole] = courses[k];
    await page.goto(`${base}/${path}${query}&course=${course}&hole=${hole}`);
    await waitFor(page, () => !document.getElementById('menu').hidden, 15000);
    if (k === 0) {
      const has = await page.evaluate(() => !!(window.__golf.debug && window.__golf.debug.crowd));
      console.log(`\n[${vp.name}] ${path}${query} crowd${has ? '' : ' (no spectators in this build: skipped)'}`);
      if (!has) {
        await context.close();
        return;
      }
    }
    await page.locator('#menu [data-act="new-round"]').tap();
    await waitFor(page, () => window.__golf.game && window.__golf.game.phase === 'intro', 8000);
    await page.touchscreen.tap(vpw * 0.5, vph * 0.35);
    await waitFor(page, () => window.__golf.game.phase === 'address', 8000);
    await page.waitForTimeout(500);
    const c = await page.evaluate(() => window.__golf.debug.crowd());
    if (gl) {
      check(c.drawCalls === 2 && c.level === 'light' && c.people === c.nLight && c.people >= 40 && c.nFull >= 120, `crowd: ${course} ${hole}: galleries drawn (${c.drawCalls} draws, ${c.people} of ${c.nFull} people at quality=low, ${Math.round(c.tris / 1000)}k tris)`);
      check(c.stand && c.galleries.some((q) => q.kind === 'green') && c.galleries.some((q) => q.kind === 'tee'), `crowd: ${course} ${hole}: tee and green galleries${c.stand ? ' and a grandstand' : ''}`);
      const st = await page.evaluate(() => window.__golf.renderer.stats());
      check(st.drawCalls <= 30, `crowd: ${course} ${hole}: ${st.drawCalls} draw calls in all (budget 30)`);
    }
    await shot(page, tag, `crowd-${course}-tee`);
    // The green gallery behind a putt (played from the approach side, toward the back of the green).
    await page.evaluate(() => {
      const t = window.__golf.game.terrain;
      window.__golf.debug.placeOnGreen(7, (Math.atan2(t.tee.y - t.cup.y, t.tee.x - t.cup.x) * 180) / Math.PI);
    });
    await page.waitForTimeout(1200);
    await shot(page, tag, `crowd-${course}-green`);
  }
  // A lost WebGL context: the galleries come back with everything else.
  if (gl) {
    const lost = await page.evaluate(async () => {
      const ext = window.__golf.renderer.gl.getExtension('WEBGL_lose_context');
      if (!ext) return null;
      ext.loseContext();
      await new Promise((r) => setTimeout(r, 400));
      ext.restoreContext();
      return true;
    });
    if (lost) check(await waitFor(page, () => window.__golf.debug.crowd().drawCalls === 2 && window.__golf.debug.crowd().people > 0, 8000), 'crowd: galleries restored after a lost WebGL context');
  }
  // Settings: Crowd Off removes the spectators (and is saved), Full brings them back.
  await page.evaluate(() => window.__golf.ui.showSettings());
  await page.waitForTimeout(400);
  const seg = '#settings [data-setting="crowd"]';
  check(await page.isVisible(seg), 'crowd: Settings has a Crowd row');
  await page.locator(`${seg} button[data-v="off"]`).tap();
  // (Frames can take most of a second under SwiftShader: wait for one drawn with the setting.)
  if (gl) await waitFor(page, () => window.__golf.debug.crowd().drawCalls === 0, 6000);
  let c = await page.evaluate(() => ({ ...window.__golf.debug.crowd(), saved: JSON.parse(localStorage.getItem('golf.settings.v1') || '{}').crowd }));
  check(c.setting === 'off' && c.saved === 'off' && (!gl || (c.drawCalls === 0 && c.people === 0)), `crowd: Off removes them (${c.drawCalls} draws, saved "${c.saved}")`);
  await page.locator(`${seg} button[data-v="full"]`).tap();
  if (gl) await waitFor(page, () => window.__golf.debug.crowd().drawCalls === 2, 6000);
  c = await page.evaluate(() => window.__golf.debug.crowd());
  check(c.setting === 'full' && (!gl || c.drawCalls === 2), `crowd: Full brings them back (${c.drawCalls} draws, ${c.people} people)`);
  await page.locator('#settings [data-act="close"]').first().tap();
  await page.waitForTimeout(300);
  // A holed putt: the gallery cheers (the first stroke on a par 3 is an ace) as it drops.
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
    await waitFor(page, () => window.__golf.game.phase === 'flight', 5000);
    await waitFor(page, () => window.__golf.game.phase !== 'flight', 15000);
    holed = await page.evaluate(() => ['holed', 'scorecard'].includes(window.__golf.game.phase));
  }
  check(holed, 'crowd: short putt holed');
  await page.waitForTimeout(300);
  c = await page.evaluate(() => window.__golf.debug.crowd());
  const cheer = c.log.find((q) => q.name === 'cheer');
  check(!!cheer && (c.reaction.name === 'cheer' || c.log[c.log.length - 1].name === 'cheer'), `crowd: the holed putt gets a cheer (${c.log.map((q) => `${q.name}/${q.why}`).join(', ') || 'none'})`);
  await shot(page, tag, 'crowd-cheer');
  check(errors.length === 0, `crowd: no console/page errors${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`);
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
  if (args.has('--golfer')) {
    // Only the golfer-in-play checks (golferPlay) on a new round of each build and viewport.
    for (const t of targets) for (const vp of VIEWPORTS) await golferOnly(browser, base, t, vp, gl);
  } else if (args.has('--customiser')) {
    // Only the Golfer customiser checks (a fresh context per build and viewport).
    for (const t of targets) {
      for (const vp of VIEWPORTS.filter((v) => !vpArg || vpArg.slice(5).split(',').includes(v.name))) {
        const context = await browser.newContext({ ...vp });
        const probe = await context.newPage();
        await probe.goto(`${base}/${t}?test=1`);
        const has = await probe.evaluate(() => !!document.getElementById('customiser'));
        await probe.close();
        console.log(`\n[${vp.name}] ${t} golfer customiser${has ? '' : ' (not in this build: skipped)'}`);
        if (has) await golferCustomiser(context, `${base}/${t}${gl ? '?test=1&quality=low&fast=8' : '?test=1&nogl=1&fast=8'}`, `${vp.name}-${t.replace(/\W+/g, '_')}`, gl);
        await context.close();
      }
    }
  } else if (!args.has('--soak-only') && !args.has('--crowd')) for (const t of targets) for (const vp of VIEWPORTS) await smoke(browser, base, t, vp, gl);
  // Spectators (section 10): their own pass per build and viewport, after the UI flow (or alone).
  if (args.has('--crowd') || !(args.has('--soak-only') || args.has('--golfer') || args.has('--customiser'))) {
    for (const t of targets) for (const vp of VIEWPORTS.filter((v) => !vpArg || vpArg.slice(5).split(',').includes(v.name))) await crowdOnly(browser, base, t, vp, gl);
  }
  if (SOAK) for (const t of targets) for (const id of SOAK_COURSES) await soak(browser, base, t, gl, id);
} finally {
  await browser.close();
  server.close();
}
console.log(failures ? `\n${failures} check(s) failed` : '\nall e2e checks passed');
process.exit(failures ? 1 : 0);
