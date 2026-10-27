// Renders the app icon (a green with a flag and a ball under an evening sky) with headless
// Chromium and writes icons/icon-180.png (apple-touch-icon) and icons/icon-512.png (manifest).
// Usage: node scripts/make-icons.mjs   (needs the globally installed playwright)

/* global draw */ // defined inside the page by drawIcon
import { mkdirSync, writeFileSync } from 'node:fs';
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

// Everything is authored on a 512 grid and scaled by s.
const drawIcon = `
function draw(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  document.body.appendChild(c);
  const g = c.getContext('2d');
  const s = size / 512;
  // Sky: deep blue to a warm horizon.
  const sky = g.createLinearGradient(0, 0, 0, 300*s);
  sky.addColorStop(0, '#0d3b66'); sky.addColorStop(0.65, '#3f86b8'); sky.addColorStop(1, '#f2c27b');
  g.fillStyle = sky; g.fillRect(0, 0, size, size);
  // Distant tree line.
  g.fillStyle = '#1d4a33';
  g.beginPath(); g.moveTo(0, 300*s);
  for (let x = 0; x <= 512; x += 16) g.lineTo(x*s, (282 - 14*Math.abs(Math.sin(x*0.07)) - 8*Math.abs(Math.sin(x*0.19)))*s);
  g.lineTo(512*s, 320*s); g.lineTo(0, 320*s); g.fill();
  // Fairway / green: a wide ellipse in perspective with mowing stripes.
  const turf = g.createLinearGradient(0, 290*s, 0, 512*s);
  turf.addColorStop(0, '#5fae3f'); turf.addColorStop(1, '#2f7a2a');
  g.fillStyle = turf; g.fillRect(0, 296*s, size, size);
  g.save(); g.beginPath(); g.rect(0, 296*s, size, size); g.clip();
  g.fillStyle = 'rgba(255,255,255,0.06)';
  for (let i = -4; i < 8; i += 2) {
    g.beginPath();
    g.moveTo((256 + i*70)*s, 296*s); g.lineTo((256 + (i+1)*70)*s, 296*s);
    g.lineTo((256 + (i+1)*260)*s, 512*s); g.lineTo((256 + i*260)*s, 512*s); g.fill();
  }
  g.restore();
  // Putting green.
  const gr = g.createRadialGradient(300*s, 330*s, 10*s, 300*s, 336*s, 170*s);
  gr.addColorStop(0, '#8fd862'); gr.addColorStop(1, '#5aa83c');
  g.fillStyle = gr; g.beginPath(); g.ellipse(300*s, 338*s, 168*s, 46*s, 0, 0, Math.PI*2); g.fill();
  // Cup.
  g.fillStyle = '#123'; g.beginPath(); g.ellipse(318*s, 340*s, 16*s, 5*s, 0, 0, Math.PI*2); g.fill();
  // Flagstick and flag.
  g.fillStyle = '#f4f4f4'; g.fillRect(315*s, 120*s, 6*s, 220*s);
  const fl = g.createLinearGradient(321*s, 0, 420*s, 0);
  fl.addColorStop(0, '#e2312b'); fl.addColorStop(1, '#ff5a3c');
  g.fillStyle = fl; g.beginPath();
  g.moveTo(321*s, 122*s); g.quadraticCurveTo(372*s, 132*s, 420*s, 150*s);
  g.quadraticCurveTo(372*s, 168*s, 321*s, 186*s); g.closePath(); g.fill();
  // Ball with a soft shadow and dimples suggested by a radial gradient.
  g.fillStyle = 'rgba(0,0,0,0.28)';
  g.beginPath(); g.ellipse(176*s, 452*s, 74*s, 16*s, 0, 0, Math.PI*2); g.fill();
  const b = g.createRadialGradient(150*s, 360*s, 6*s, 172*s, 392*s, 70*s);
  b.addColorStop(0, '#ffffff'); b.addColorStop(0.7, '#e9edf0'); b.addColorStop(1, '#b8c2ca');
  g.fillStyle = b; g.beginPath(); g.arc(172*s, 392*s, 66*s, 0, Math.PI*2); g.fill();
  g.fillStyle = 'rgba(120,135,150,0.18)';
  for (let i = 0; i < 26; i++) {
    const a = i * 2.4, r = 14 + (i % 5) * 10;
    g.beginPath(); g.arc((172 + Math.cos(a)*r)*s, (398 + Math.sin(a)*r*0.9)*s, 4.2*s, 0, Math.PI*2); g.fill();
  }
  return c;
}`;

const browser = await playwright.chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage();
await page.setContent(`<html><body style="margin:0;background:#000"><script>${drawIcon}</script></body></html>`);
mkdirSync(join(root, 'icons'), { recursive: true });
for (const size of [180, 512]) {
  const b64 = await page.evaluate((sz) => draw(sz).toDataURL('image/png').split(',')[1], size);
  writeFileSync(join(root, `icons/icon-${size}.png`), Buffer.from(b64, 'base64'));
  console.log(`icons/icon-${size}.png`);
}
await browser.close();
