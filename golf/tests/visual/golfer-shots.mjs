// Screenshots of the golfer for visual review (Playwright + SwiftShader, no test runner).
// Usage: node tests/visual/golfer-shots.mjs [outDir] (default golf/screenshots/golfer, gitignored)
// For each case (club x look x hand) it renders the swing positions (address, half-way back, top,
// downswing, impact, follow-through, finish) down the line (the in-game TV view) and face on, on
// an iPhone landscape viewport, and tiles each case into one sheet (<case>.png, 4 x 4).

import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { extname, join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'); // golf/
const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require('playwright');
} catch {
  playwright = require('/opt/node22/lib/node_modules/playwright');
}
const outDir = resolve(process.argv[2] || join(root, 'screenshots', 'golfer'));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png' };

const POSES = ['address', 'P2', 'top', 'P5', 'P6', 'impact', 'P8', 'finish'];
const CASES = [
  { name: 'driver-tour', q: { look: 'tour', club: 'D' } },
  { name: '7iron-ladypro', q: { look: 'ladypro', club: '7i' } },
  { name: 'wedge-gent', q: { look: 'gent', club: 'SW' } },
  { name: 'putter-power', q: { look: 'power', club: 'P', power: '0.5' } },
  { name: '7iron-lefty-rising', q: { look: 'rising', club: '7i', handed: 'L' } },
];

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const file = join(root, decodeURIComponent(url.pathname));
    if (!file.startsWith(root)) throw new Error('bad path');
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
await mkdir(outDir, { recursive: true });
const browser = await playwright.chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
// iPhone landscape: the whole swing (club at the top, the finish) fits the frame.
const ctx = await browser.newContext({ viewport: { width: 852, height: 393 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await page.goto(`http://127.0.0.1:${server.address().port}/tests/visual/golfer-preview.html`);
await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 120000 });
for (const c of CASES) {
  const tiles = [];
  for (const cam of ['behind', 'face']) {
    for (const pose of POSES) {
      // replace: each case starts from the defaults (no power, shot or hand left by the case before).
      await page.evaluate((q) => window.__golfer.set(q, { replace: true }), { ...c.q, pose, cam, turn: '0', dist: cam === 'face' ? '5' : '5.2', fov: '34' });
      tiles.push(await page.screenshot({ type: 'png' }));
    }
  }
  // Tile in the page itself (no image library): 8 x 2 thumbnails.
  const sheet = await page.evaluate(async (pngs) => {
    const imgs = await Promise.all(pngs.map((b64) => new Promise((ok) => {
      const im = new Image();
      im.onload = () => ok(im);
      im.src = `data:image/png;base64,${b64}`;
    })));
    // 4 x 4 tiles: down the line (two rows), then face on; each tile the middle half of the frame.
    const w = 520;
    const sw = imgs[0].width * 0.5;
    const sx = imgs[0].width * 0.25;
    const h = Math.round((w * imgs[0].height) / sw);
    const cv = document.createElement('canvas');
    cv.width = w * 4;
    cv.height = h * 4;
    const g = cv.getContext('2d');
    imgs.forEach((im, i) => g.drawImage(im, sx, 0, sw, im.height, (i % 4) * w, Math.floor(i / 4) * h, w, h));
    return cv.toDataURL('image/png').split(',')[1];
  }, tiles.map((b) => b.toString('base64')));
  await writeFile(join(outDir, `${c.name}.png`), Buffer.from(sheet, 'base64'));
  console.log(`  ${c.name}.png`);
}
await browser.close();
server.close();
if (errors.length) {
  console.log('errors:', errors.slice(0, 5));
  process.exit(1);
}
console.log(`golfer screenshots in ${outDir}`);
