// Renders the app icon (a glossy 8-ball on felt) with headless Chromium and writes
// icons/icon-180.png (apple-touch-icon) and icons/icon-512.png (manifest).
// Usage: node scripts/make-icons.mjs   (needs the globally installed playwright)

import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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

const drawIcon = `
function draw(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  document.body.appendChild(c);
  const g = c.getContext('2d');
  const s = size / 512;
  // Felt background with lamp light
  const bg = g.createRadialGradient(256*s, 200*s, 40*s, 256*s, 256*s, 380*s);
  bg.addColorStop(0, '#2f9a5c'); bg.addColorStop(0.6, '#1d6f40'); bg.addColorStop(1, '#0d3a21');
  g.fillStyle = bg; g.fillRect(0, 0, size, size);
  // Shadow
  g.fillStyle = 'rgba(0,0,0,0.45)';
  g.beginPath(); g.ellipse(276*s, 300*s, 170*s, 160*s, 0, 0, Math.PI*2); g.fill();
  // Ball body
  const r = 165*s, cx = 256*s, cy = 248*s;
  const body = g.createRadialGradient(cx - 60*s, cy - 70*s, 10*s, cx, cy, r);
  body.addColorStop(0, '#5a5a5a'); body.addColorStop(0.35, '#1c1c1c'); body.addColorStop(1, '#000');
  g.fillStyle = body; g.beginPath(); g.arc(cx, cy, r, 0, Math.PI*2); g.fill();
  // White number disc
  const dx = cx - 18*s, dy = cy - 22*s, dr = 74*s;
  const disc = g.createRadialGradient(dx - 20*s, dy - 20*s, 5*s, dx, dy, dr);
  disc.addColorStop(0, '#ffffff'); disc.addColorStop(1, '#d9d6cc');
  g.fillStyle = disc; g.beginPath(); g.ellipse(dx, dy, dr, dr*0.96, -0.3, 0, Math.PI*2); g.fill();
  g.fillStyle = '#111'; g.font = 'bold ' + Math.round(104*s) + 'px -apple-system, Helvetica, Arial, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('8', dx, dy + 6*s);
  // Specular highlight
  const sp = g.createRadialGradient(cx - 72*s, cy - 86*s, 2*s, cx - 72*s, cy - 86*s, 60*s);
  sp.addColorStop(0, 'rgba(255,255,255,0.85)'); sp.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = sp; g.beginPath(); g.arc(cx, cy, r, 0, Math.PI*2); g.fill();
  return c;
}`;

const browser = await playwright.chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage();
await page.setContent(`<html><body style="margin:0;background:#000"><script>${drawIcon}</script></body></html>`);
mkdirSync(join(root, 'icons'), { recursive: true });
for (const size of [180, 512]) {
  const b64 = await page.evaluate((sz) => draw(sz).toDataURL('image/png').split(',')[1], size);
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(root, `icons/icon-${size}.png`), Buffer.from(b64, 'base64'));
  console.log(`icons/icon-${size}.png`);
}
await browser.close();
