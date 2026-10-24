// Canvas 2D renderer: a realistic bar table seen from directly above under a pool-table lamp.
//
// Static layer (cloth, cushions, rails, pockets, sights) is drawn once per setView/setCloth into an
// offscreen canvas. Per frame: blit the static layer, contact shadows, analytically shaded ball
// sprites (re-rendered only when a ball's orientation or lighting changed), overlays, cue.
//
// All static and overlay geometry is drawn in WORLD metres through the affine world -> device
// transform derived from view.toScreen, so rotated (portrait) and landscape views share one path.

import {
  BALL_R,
  BALL_COLORS,
  CLOTH_COLORS,
  HL,
  HW,
  CUSHION_DEPTH,
  RAIL_WIDTH,
  POCKET_VISUAL_R,
} from './constants.js';
import { TABLE } from './table.js';
import { quatRotateInv } from './vec.js';
import { traceAim, rayRails } from './aim.js';
import { mulberry32 } from './rng.js';

const TAU = Math.PI * 2;
const R = BALL_R;
const LAMP_H = 0.95; // lamp height above the balls (m)
const LAMP_X = 0.45; // the lamp is a row of shades spanning x in [-LAMP_X, LAMP_X]
const DISC_COS = Math.cos((31 * Math.PI) / 180); // number disc angular radius
const STRIPE_Z = 0.56; // stripe band half-height (unit sphere z): the disc fits inside the band
const GLYPH_H = 0.42; // half extent of the number glyph box on the sphere (unit coordinates)
const DOT_COS = Math.cos((6.5 * Math.PI) / 180); // cue-ball red dot
const DROP_T = 0.26; // pocket drop animation (s)
const Q_EPS = 0.0015; // quaternion change that triggers a sprite re-render
const L_EPS = 0.012; // light direction change that triggers a sprite re-render
const CUE_LEN = 1.47;
const FONT = '-apple-system, "SF Pro Display", "SF Pro", system-ui, "Helvetica Neue", Helvetica, Arial, sans-serif';
const WHITE = [247, 243, 232];
const INK = [24, 21, 19];
const DOT_RED = [196, 32, 36];

// ---------------------------------------------------------------------------------------------
// Small helpers

function makeCanvas(w, h) {
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = Math.max(1, w | 0);
    c.height = Math.max(1, h | 0);
    return c;
  }
  return new OffscreenCanvas(Math.max(1, w | 0), Math.max(1, h | 0));
}

function hexRgb(hex) {
  let h = String(hex).replace('#', '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const v = parseInt(h, 16) || 0;
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

function css(c, f = 1, a = 1) {
  const r = Math.max(0, Math.min(255, Math.round(c[0] * f)));
  const g = Math.max(0, Math.min(255, Math.round(c[1] * f)));
  const b = Math.max(0, Math.min(255, Math.round(c[2] * f)));
  return `rgba(${r},${g},${b},${a})`;
}

function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function roundRectPath(g, x, y, w, h, r) {
  g.moveTo(x + r, y);
  g.lineTo(x + w - r, y);
  g.arcTo(x + w, y, x + w, y + r, r);
  g.lineTo(x + w, y + h - r);
  g.arcTo(x + w, y + h, x + w - r, y + h, r);
  g.lineTo(x + r, y + h);
  g.arcTo(x, y + h, x, y + h - r, r);
  g.lineTo(x, y + r);
  g.arcTo(x, y, x + r, y, r);
  g.closePath();
}

function polyPath(g, pts) {
  g.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) g.lineTo(pts[i].x, pts[i].y);
  g.closePath();
}

// 2D value noise in [0,1] with smooth interpolation.
function makeNoise(seed) {
  const rng = mulberry32(seed);
  const vals = new Float32Array(256);
  const perm = new Uint8Array(512);
  for (let i = 0; i < 256; i++) {
    vals[i] = rng();
    perm[i] = i;
  }
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = perm[i];
    perm[i] = perm[j];
    perm[j] = t;
  }
  for (let i = 0; i < 256; i++) perm[256 + i] = perm[i];
  return (x, y) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const u = xf * xf * (3 - 2 * xf);
    const v = yf * yf * (3 - 2 * yf);
    const X = xi & 255;
    const Y = yi & 255;
    const a = vals[perm[X + perm[Y]]];
    const b = vals[perm[X + 1 + perm[Y]]];
    const c = vals[perm[X + perm[Y + 1]]];
    const d = vals[perm[X + 1 + perm[Y + 1]]];
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
}

// Visual pocket hole (centre + radius) for a table pocket.
function holeOf(p) {
  if (p.kind === 'corner') {
    return { id: p.id, x: p.x + p.dir.x * 0.05, y: p.y + p.dir.y * 0.05, r: POCKET_VISUAL_R, dir: p.dir };
  }
  // Side hole sits just behind the cushion nose line, where physics captures the ball.
  const r = POCKET_VISUAL_R * 0.98;
  return {
    id: p.id,
    x: p.mouth.x + p.dir.x * (r + 0.003),
    y: p.mouth.y + p.dir.y * (r + 0.003),
    r,
    dir: p.dir,
  };
}

// Cushion polygons: each rail nose segment plus the jaw facings at both ends, out to the rail.
function cushionPolys(table) {
  const jaws = table.cushions.filter((c) => c.kind === 'jaw');
  const find = (p) => jaws.find((j) => Math.hypot(j.a.x - p.x, j.a.y - p.y) < 1e-6);
  return table.cushions
    .filter((c) => c.kind === 'rail')
    .map((c) => {
      const back = (p) => ({ x: p.x - c.n.x * CUSHION_DEPTH, y: p.y - c.n.y * CUSHION_DEPTH });
      const ja = find(c.a);
      const jb = find(c.b);
      return { a: c.a, b: c.b, fa: ja ? ja.b : back(c.a), fb: jb ? jb.b : back(c.b), n: c.n };
    });
}

// Procedural wood strip for one rail: u (columns) along the rail, v (rows) from the inner edge
// (next to the cushion) to the outer edge. Grain, fibres and the rail's top profile are baked in.
function woodStrip(lenPx, widPx, ppm, seed) {
  const c = makeCanvas(lenPx, widPx);
  const g = c.getContext('2d');
  const img = g.createImageData(lenPx, widPx);
  const d = img.data;
  const n1 = makeNoise(seed);
  const n2 = makeNoise(seed * 3 + 1);
  const warp = new Float32Array(lenPx);
  const tone = new Float32Array(lenPx);
  for (let i = 0; i < lenPx; i++) {
    const x = i / ppm;
    warp[i] = 0.011 * n1(x * 2.1, 0.37) + 0.004 * n1(x * 8.3, 4.1) + 0.0012 * n1(x * 31, 9.7);
    tone[i] = 0.9 + 0.2 * n1(x * 1.3, 7.7);
  }
  const prof = new Float32Array(widPx);
  const sheen = new Float32Array(widPx);
  for (let j = 0; j < widPx; j++) {
    const t = (j + 0.5) / widPx; // 0 inner edge .. 1 outer edge
    let p = 1;
    if (t < 0.035) p *= 0.45 + 0.55 * (t / 0.035); // small step down to the cushion
    if (t > 0.78) {
      const k = (t - 0.78) / 0.22;
      p *= 1 - 0.6 * k * k; // outer round-over turning away from the lamp
    }
    prof[j] = p;
    sheen[j] =
      26 * Math.exp(-(((t - 0.3) / 0.15) ** 2)) +
      20 * Math.exp(-(((t - 0.8) / 0.035) ** 2)) +
      10 * Math.exp(-(((t - 0.05) / 0.015) ** 2));
  }
  const dark = [34, 17, 9];
  const mid = [74, 38, 20];
  const light = [116, 64, 33];
  for (let j = 0; j < widPx; j++) {
    const y = j / ppm;
    const pj = prof[j];
    const sj = sheen[j];
    let o = j * lenPx * 4;
    for (let i = 0; i < lenPx; i++, o += 4) {
      const x = i / ppm;
      const gpos = (y + warp[i]) * 150;
      const ring = gpos - Math.floor(gpos); // 0..1 within a growth ring
      const late = ring < 0.22 ? 1 - ring / 0.22 : ring > 0.9 ? (ring - 0.9) / 0.1 : 0; // dark latewood
      const fib = n2(x * 40, y * 900); // fine fibres stretched along the rail
      const pore = n2(x * 260 + 13, y * 1600) > 0.82 ? 0.75 : 1;
      let t = (0.55 + 0.35 * (fib - 0.5)) * tone[i] - 0.45 * late * late;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      let r;
      let gg;
      let b;
      if (t < 0.5) {
        const k = t * 2;
        r = dark[0] + (mid[0] - dark[0]) * k;
        gg = dark[1] + (mid[1] - dark[1]) * k;
        b = dark[2] + (mid[2] - dark[2]) * k;
      } else {
        const k = (t - 0.5) * 2;
        r = mid[0] + (light[0] - mid[0]) * k;
        gg = mid[1] + (light[1] - mid[1]) * k;
        b = mid[2] + (light[2] - mid[2]) * k;
      }
      const f = pj * pore;
      d[o] = r * f + sj;
      d[o + 1] = gg * f + sj * 0.8;
      d[o + 2] = b * f + sj * 0.62;
      d[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

// Fine cloth noise tile (device pixels). Fibres are slightly stretched along the table length.
function noiseTile(size, seed, alongX) {
  const c = makeCanvas(size, size);
  const g = c.getContext('2d');
  const img = g.createImageData(size, size);
  const d = img.data;
  const rng = mulberry32(seed);
  const raw = new Float32Array(size * size);
  for (let i = 0; i < raw.length; i++) raw[i] = rng() + rng() - 1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const j = alongX ? y * size + ((x + 1) % size) : ((y + 1) % size) * size + x;
      const n = raw[i] * 0.7 + raw[j] * 0.45;
      const o = i * 4;
      const v = n > 0 ? 255 : 0;
      d[o] = v;
      d[o + 1] = v;
      d[o + 2] = v;
      d[o + 3] = Math.min(255, Math.abs(n) * 46);
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

// ---------------------------------------------------------------------------------------------

export class Renderer {
  constructor(canvas, { table = TABLE, cloth = 'green' } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.table = table;
    this.clothHex = CLOTH_COLORS[cloth] || (String(cloth).startsWith('#') ? cloth : CLOTH_COLORS.green);
    this.view = null;
    this.dpr = 1;
    this.M = [1, 0, 0, 1, 0, 0];
    this.ppm = 1;
    this.holes = table.pockets.map(holeOf);
    this.cushions = cushionPolys(table);
    this.drops = [];
    this.entries = [];
    this.colors = BALL_COLORS.map(hexRgb);
    this.stats = { frameMs: 0, spriteMs: 0, sprites: 0 };
    this._c0 = [0, 0, 0];
    this._c1 = [0, 0, 0];
    this._c2 = [0, 0, 0];
    this._L = [0, 0, 1];
    this._list = [];
  }

  // ---- public API ---------------------------------------------------------------------------

  setView(view, dpr) {
    const winDpr = typeof window !== 'undefined' && window.devicePixelRatio ? window.devicePixelRatio : 1;
    const d = Math.min(3, Math.max(1, dpr || winDpr));
    this.view = view;
    this.dpr = d;
    const W = Math.max(1, Math.round(view.cssW * d));
    const H = Math.max(1, Math.round(view.cssH * d));
    if (this.canvas.width !== W) this.canvas.width = W;
    if (this.canvas.height !== H) this.canvas.height = H;
    if (this.canvas.style) {
      this.canvas.style.width = view.cssW + 'px';
      this.canvas.style.height = view.cssH + 'px';
    }
    const p0 = view.toScreen(0, 0);
    const px = view.toScreen(1, 0);
    const py = view.toScreen(0, 1);
    this.M = [(px.x - p0.x) * d, (px.y - p0.y) * d, (py.x - p0.x) * d, (py.y - p0.y) * d, p0.x * d, p0.y * d];
    this.ppm = view.scale * d;
    // Scale-dependent sprites and textures are reused when only the offset changed (e.g. Safari's
    // toolbar collapsing changes the height but not the scale).
    const M = this.M;
    const key = `${this.ppm.toFixed(4)}|${M[0].toFixed(4)}|${M[1].toFixed(4)}`;
    if (key !== this._geoKey) {
      this._geoKey = key;
      this._woodCache = null;
      this._buildBallGeometry();
      this._buildShadowSprites();
      this._buildCue();
    }
    this._buildStatic();
  }

  setCloth(name) {
    this.clothHex = CLOTH_COLORS[name] || (String(name).startsWith('#') ? name : CLOTH_COLORS.green);
    if (this.view) {
      this._buildStatic();
      this.entries.forEach((e) => e && (e.valid = false)); // rim reflections pick up the cloth colour
    }
  }

  onPocket(ev, ball) {
    const id = ev && ev.ball !== undefined ? ev.ball : ball ? ball.id : -1;
    const pocket = ev && ev.pocket !== undefined ? ev.pocket : ball ? ball.pocket : -1;
    const h = this.holes[pocket];
    if (!h || id < 0) return;
    let x0 = h.x;
    let y0 = h.y;
    if (ball && Number.isFinite(ball.x) && Math.hypot(ball.x - h.x, ball.y - h.y) < 0.2) {
      x0 = ball.x;
      y0 = ball.y;
    }
    this.drops = this.drops.filter((a) => a.id !== id);
    this.drops.push({ id, x0, y0, hole: h, t0: null, q: ball && ball.q ? ball.q.slice() : null });
  }

  reset() {
    this.drops.length = 0;
  }

  pocketAtScreen(sx, sy) {
    if (!this.view) return null;
    let best = null;
    let bestD = Infinity;
    for (const h of this.holes) {
      const p = this.view.toScreen(h.x, h.y);
      const d = Math.hypot(sx - p.x, sy - p.y);
      const rad = Math.max(22, h.r * this.view.scale * 1.4);
      if (d <= rad && d < bestD) {
        bestD = d;
        best = h.id;
      }
    }
    return best;
  }

  draw(scene) {
    if (!this.view || !this._static) return;
    const t0 = performance.now();
    this.stats.sprites = 0;
    this.stats.spriteMs = 0;
    const ctx = this.ctx;
    const time = scene && Number.isFinite(scene.time) ? scene.time : t0 / 1000;
    const balls = (scene && scene.balls) || [];
    const bih = scene && scene.ballInHand;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.drawImage(this._static, 0, 0);

    this._drawDrops(time);

    const list = this._list;
    list.length = 0;
    for (const b of balls) {
      if (!b || !b.on) continue;
      if (b.id === 0 && bih) continue;
      list.push(b);
    }
    for (const b of list) this._drawShadow(b.x, b.y, 1);
    if (bih) this._drawShadow(bih.x, bih.y, bih.dragging ? 1.6 : 1);
    for (const b of list) this._drawBall(b.id, b.x, b.y, b.q, 1);
    if (bih) {
      const cue = balls[0];
      this._drawBall(0, bih.x, bih.y, cue && cue.q, bih.dragging ? 1.06 : 1);
    }

    if (scene) {
      if (scene.pockets) this._drawPocketMarks(scene.pockets, time);
      if (scene.targets && scene.targets.length) this._drawTargets(scene.targets, balls, time);
      if (scene.guide) this._drawGuide(scene.guide, balls);
      if (bih) this._drawBallInHand(bih, time);
      if (scene.cue && scene.cue.visible !== false) this._drawCue(scene.cue);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    this.stats.frameMs = performance.now() - t0;
  }

  // ---- transforms ---------------------------------------------------------------------------

  _world(g) {
    const M = this.M;
    g.setTransform(M[0], M[1], M[2], M[3], M[4], M[5]);
  }

  _dev(x, y) {
    const M = this.M;
    return { x: M[0] * x + M[2] * y + M[4], y: M[1] * x + M[3] * y + M[5] };
  }

  // Unit vector toward the lamp (a row of shades along the table's centre line) from (x, y).
  _light(x, y, out) {
    const lx = (x < -LAMP_X ? -LAMP_X : x > LAMP_X ? LAMP_X : x) - x;
    const ly = -y;
    const l = Math.hypot(lx, ly, LAMP_H);
    out[0] = lx / l;
    out[1] = ly / l;
    out[2] = LAMP_H / l;
    return out;
  }

  // ---- static layer -------------------------------------------------------------------------

  _buildStatic() {
    const W = this.canvas.width;
    const H = this.canvas.height;
    if (!this._static || this._static.width !== W || this._static.height !== H) {
      this._static = makeCanvas(W, H);
    }
    const st = this._static;
    const g = st.getContext('2d');
    const ppm = this.ppm;
    const px = 1 / ppm;
    const world = () => this._world(g);
    const X0 = HL + CUSHION_DEPTH;
    const Y0 = HW + CUSHION_DEPTH;
    const X1 = X0 + RAIL_WIDTH;
    const Y1 = Y0 + RAIL_WIDTH;
    const CR = 0.045;
    const cloth = hexRgb(this.clothHex);
    const outer = () => roundRectPath(g, -X1, -Y1, 2 * X1, 2 * Y1, CR);

    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, W, H);
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';

    // Shadow of the whole table on the floor.
    g.save();
    world();
    g.shadowColor = 'rgba(0,0,0,0.55)';
    g.shadowBlur = Math.max(4, 0.03 * ppm);
    g.beginPath();
    outer();
    g.fillStyle = '#24140b';
    g.fill();
    g.restore();

    // Wooden rails: four mitred boards, each with its own grain.
    const rails = [
      { o: [-X1, Y0], u: [1, 0], v: [0, 1], len: 2 * X1, seed: 11, poly: [[-X0, Y0], [X0, Y0], [X1, Y1], [-X1, Y1]] },
      { o: [-X1, -Y0], u: [1, 0], v: [0, -1], len: 2 * X1, seed: 23, poly: [[-X0, -Y0], [X0, -Y0], [X1, -Y1], [-X1, -Y1]] },
      { o: [X0, -Y1], u: [0, 1], v: [1, 0], len: 2 * Y1, seed: 37, poly: [[X0, -Y0], [X0, Y0], [X1, Y1], [X1, -Y1]] },
      { o: [-X0, -Y1], u: [0, 1], v: [-1, 0], len: 2 * Y1, seed: 41, poly: [[-X0, -Y0], [-X0, Y0], [-X1, Y1], [-X1, -Y1]] },
    ];
    const stripW = Math.ceil(RAIL_WIDTH * ppm) + 1;
    for (const r of rails) {
      const wkey = `${r.seed}|${ppm.toFixed(4)}`;
      this._woodCache = this._woodCache || {};
      const strip =
        this._woodCache[wkey] || (this._woodCache[wkey] = woodStrip(Math.ceil(r.len * ppm) + 1, stripW, ppm, r.seed));
      g.save();
      world();
      g.beginPath();
      outer();
      g.clip();
      g.beginPath();
      polyPath(g, r.poly.map(([x, y]) => ({ x, y })));
      g.clip();
      g.transform(r.u[0] * px, r.u[1] * px, r.v[0] * px, r.v[1] * px, r.o[0], r.o[1]);
      g.drawImage(strip, 0, 0);
      g.restore();
    }
    // Mitre seams, outer edge line and a fine highlight just inside it.
    world();
    g.lineCap = 'round';
    g.strokeStyle = 'rgba(10,4,2,0.7)';
    g.lineWidth = 1.2 * px;
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        g.beginPath();
        g.moveTo(sx * X0, sy * Y0);
        g.lineTo(sx * (X1 - CR * 0.3), sy * (Y1 - CR * 0.3));
        g.stroke();
      }
    }
    g.beginPath();
    outer();
    g.lineWidth = 1.5 * px;
    g.strokeStyle = 'rgba(0,0,0,0.6)';
    g.stroke();

    // Cloth bed (also visible in the pocket throats).
    g.fillStyle = css(cloth);
    g.fillRect(-X0, -Y0, 2 * X0, 2 * Y0);
    const mottle = this._mottle || (this._mottle = this._makeMottle());
    g.save();
    g.imageSmoothingEnabled = true;
    g.globalAlpha = 0.9;
    g.drawImage(mottle, -X0, -Y0, 2 * X0, 2 * Y0);
    g.restore();
    const tile = noiseTile(Math.max(64, Math.round(42 * this.dpr)), 977, !this.view.rotated);
    const pattern = g.createPattern(tile, 'repeat');
    g.save();
    world();
    g.beginPath();
    g.rect(-X0, -Y0, 2 * X0, 2 * Y0);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = pattern;
    g.fill();
    g.restore();

    // Pocket liners (leather with stitching + chrome bead) and the holes.
    for (const h of this.holes) {
      const lr = h.r + (h.dir.x && h.dir.y ? 0.022 : 0.02);
      g.save();
      world();
      g.beginPath();
      outer();
      g.rect(-X0, -Y0, 2 * X0, 2 * Y0);
      g.clip('evenodd');
      // drop shadow of the liner onto the wood
      g.save();
      g.shadowColor = 'rgba(0,0,0,0.65)';
      g.shadowBlur = 0.008 * ppm;
      g.beginPath();
      g.arc(h.x, h.y, lr, 0, TAU);
      g.fillStyle = '#120a06';
      g.fill();
      g.restore();
      const lg = g.createRadialGradient(h.x, h.y, h.r * 0.98, h.x, h.y, lr);
      lg.addColorStop(0, '#0a0604');
      lg.addColorStop(0.3, '#2c1b10');
      lg.addColorStop(0.55, '#3a2416');
      lg.addColorStop(0.85, '#22140c');
      lg.addColorStop(1, '#0f0805');
      g.beginPath();
      g.arc(h.x, h.y, lr, 0, TAU);
      g.fillStyle = lg;
      g.fill();
      g.setLineDash([0.0035, 0.0028]);
      g.lineWidth = Math.max(0.7, 0.9 * this.dpr) * px;
      g.strokeStyle = 'rgba(214,176,120,0.42)';
      g.beginPath();
      g.arc(h.x, h.y, lr - 0.0065, 0, TAU);
      g.stroke();
      g.setLineDash([]);
      g.restore();

      world();
      const fx = h.x - h.dir.x * h.r * 0.4;
      const fy = h.y - h.dir.y * h.r * 0.4;
      const hg = g.createRadialGradient(fx, fy, 0, h.x, h.y, h.r);
      hg.addColorStop(0, '#000000');
      hg.addColorStop(0.6, '#020202');
      hg.addColorStop(0.86, '#0e0c0b');
      hg.addColorStop(0.95, '#2a2520');
      hg.addColorStop(1, '#5a554f');
      g.beginPath();
      g.arc(h.x, h.y, h.r, 0, TAU);
      g.fillStyle = hg;
      g.fill();
      // chrome bead around the hole, only on the rail part
      g.save();
      g.beginPath();
      outer();
      g.rect(-X0, -Y0, 2 * X0, 2 * Y0);
      g.clip('evenodd');
      const cg = g.createLinearGradient(h.x - h.dir.x * h.r, h.y - h.dir.y * h.r, h.x + h.dir.x * h.r, h.y + h.dir.y * h.r);
      cg.addColorStop(0, 'rgba(250,250,250,0.95)');
      cg.addColorStop(0.5, 'rgba(120,120,125,0.9)');
      cg.addColorStop(1, 'rgba(225,225,230,0.95)');
      g.beginPath();
      g.arc(h.x, h.y, h.r + 0.0012, 0, TAU);
      g.lineWidth = 0.0026;
      g.strokeStyle = cg;
      g.stroke();
      g.restore();
    }

    // Cushions: shadow on the bed under the nose, then the cloth-covered rubber.
    g.save();
    world();
    g.beginPath();
    g.rect(-X0, -Y0, 2 * X0, 2 * Y0);
    g.clip();
    g.shadowColor = 'rgba(0,0,0,0.6)';
    g.shadowBlur = Math.max(2, 0.009 * ppm);
    g.fillStyle = '#000';
    for (const c of this.cushions) {
      g.beginPath();
      polyPath(g, [c.a, c.b, c.fb, c.fa]);
      g.fill();
    }
    g.restore();
    for (const c of this.cushions) {
      world();
      g.beginPath();
      polyPath(g, [c.a, c.b, c.fb, c.fa]);
      const gr = g.createLinearGradient(
        c.a.x,
        c.a.y,
        c.a.x - c.n.x * CUSHION_DEPTH,
        c.a.y - c.n.y * CUSHION_DEPTH,
      );
      gr.addColorStop(0, css(cloth, 1.04));
      gr.addColorStop(0.07, css(cloth, 1.16));
      gr.addColorStop(0.22, css(cloth, 1.02));
      gr.addColorStop(0.75, css(cloth, 0.88));
      gr.addColorStop(1, css(cloth, 0.7));
      g.fillStyle = gr;
      g.fill();
      g.save();
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.fillStyle = pattern;
      g.fill();
      g.restore();
      // the rounded crest continues around the jaws into the facings
      g.save();
      g.clip();
      g.lineCap = 'round';
      g.strokeStyle = css(cloth, 1.18, 0.75);
      g.lineWidth = 0.006;
      g.beginPath();
      g.moveTo(c.fa.x, c.fa.y);
      g.lineTo(c.a.x, c.a.y);
      g.moveTo(c.b.x, c.b.y);
      g.lineTo(c.fb.x, c.fb.y);
      g.stroke();
      g.restore();
      // facings (rubber jaw faces seen edge-on)
      g.lineJoin = 'round';
      g.strokeStyle = 'rgba(0,0,0,0.45)';
      g.lineWidth = 1.1 * px;
      g.beginPath();
      g.moveTo(c.fa.x, c.fa.y);
      g.lineTo(c.a.x, c.a.y);
      g.moveTo(c.b.x, c.b.y);
      g.lineTo(c.fb.x, c.fb.y);
      g.stroke();
      // fine light line on the nose crest
      const ox = c.n.x * -0.0025;
      const oy = c.n.y * -0.0025;
      g.strokeStyle = 'rgba(255,255,255,0.10)';
      g.lineWidth = 1 * px;
      g.beginPath();
      g.moveTo(c.a.x + ox, c.a.y + oy);
      g.lineTo(c.b.x + ox, c.b.y + oy);
      g.stroke();
    }
    // Where the cushion meets the wood: a dark step.
    world();
    g.strokeStyle = 'rgba(0,0,0,0.55)';
    g.lineWidth = 1.4 * px;
    for (const c of this.cushions) {
      g.beginPath();
      g.moveTo(c.fa.x, c.fa.y);
      g.lineTo(c.fb.x, c.fb.y);
      g.stroke();
    }

    // Mother-of-pearl diamond sights in the middle of the rail.
    for (const dm of this.table.diamonds) {
      const out =
        dm.side === 'left' ? [0, 1] : dm.side === 'right' ? [0, -1] : dm.side === 'foot' ? [1, 0] : [-1, 0];
      const al = [-out[1], out[0]];
      const off = CUSHION_DEPTH + RAIL_WIDTH * 0.5;
      const cx = dm.x + out[0] * off;
      const cy = dm.y + out[1] * off;
      const a = 0.0105;
      const b = 0.0062;
      const pts = [
        { x: cx + al[0] * a, y: cy + al[1] * a },
        { x: cx + out[0] * b, y: cy + out[1] * b },
        { x: cx - al[0] * a, y: cy - al[1] * a },
        { x: cx - out[0] * b, y: cy - out[1] * b },
      ];
      world();
      g.save();
      g.shadowColor = 'rgba(0,0,0,0.5)';
      g.shadowBlur = Math.max(1, 0.0025 * ppm);
      g.beginPath();
      polyPath(g, pts);
      const pg = g.createLinearGradient(pts[0].x, pts[0].y, pts[2].x, pts[2].y);
      pg.addColorStop(0, '#f4efe4');
      pg.addColorStop(0.3, '#fffdf8');
      pg.addColorStop(0.55, '#d9e2ea');
      pg.addColorStop(0.75, '#f1e3ec');
      pg.addColorStop(1, '#e7e2d6');
      g.fillStyle = pg;
      g.fill();
      g.restore();
      g.beginPath();
      polyPath(g, pts);
      g.strokeStyle = 'rgba(40,20,10,0.55)';
      g.lineWidth = 0.8 * px;
      g.stroke();
    }

    // Foot spot.
    world();
    g.beginPath();
    g.arc(this.table.footSpot.x, this.table.footSpot.y, 0.0042, 0, TAU);
    g.fillStyle = 'rgba(255,255,255,0.28)';
    g.fill();

    // Lamp: warm pool of light over the centre, falling off toward the rails and corners.
    g.save();
    world();
    g.beginPath();
    outer();
    g.clip();
    g.scale(X1 * 1.02, Y1 * 1.32);
    const lamp = g.createRadialGradient(0, 0, 0, 0, 0, 1);
    lamp.addColorStop(0, 'rgba(255,240,205,0.12)');
    lamp.addColorStop(0.45, 'rgba(255,240,205,0.05)');
    lamp.addColorStop(0.7, 'rgba(0,0,0,0.06)');
    lamp.addColorStop(0.9, 'rgba(0,0,0,0.24)');
    lamp.addColorStop(1, 'rgba(0,0,0,0.4)');
    g.fillStyle = lamp;
    g.fillRect(-1.6, -1.6, 3.2, 3.2);
    g.restore();
    g.setTransform(1, 0, 0, 1, 0, 0);
  }

  _makeMottle() {
    const w = 44;
    const h = 22;
    const c = makeCanvas(w, h);
    const g = c.getContext('2d');
    const img = g.createImageData(w, h);
    const rng = mulberry32(4242);
    for (let i = 0; i < w * h; i++) {
      const n = rng() - 0.5;
      const o = i * 4;
      const v = n > 0 ? 255 : 0;
      img.data[o] = v;
      img.data[o + 1] = v;
      img.data[o + 2] = v;
      img.data[o + 3] = Math.abs(n) * 26;
    }
    g.putImageData(img, 0, 0);
    return c;
  }

  // ---- balls --------------------------------------------------------------------------------

  // Per-pixel geometry of a ball sprite for the current scale and orientation: for every pixel
  // of the disc, the WORLD-space surface normal, AA width, rim factors and coverage.
  _buildBallGeometry() {
    const rad = R * this.ppm;
    const S = Math.ceil(rad * 2 + 2);
    const c = S / 2;
    const [a, b, cc, d] = this.M;
    const det = a * d - b * cc;
    const idx = [];
    const nx = [];
    const ny = [];
    const nz = [];
    const aaw = [];
    const rim = [];
    const fres = [];
    const cov = [];
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const u = x + 0.5 - c;
        const v = y + 0.5 - c;
        const dd = Math.hypot(u, v);
        const k = clamp01(rad - dd + 0.5);
        if (k <= 0) continue;
        let su = u / rad;
        let sv = v / rad;
        const s2 = su * su + sv * sv;
        if (s2 > 0.985) {
          const f = Math.sqrt(0.985 / s2);
          su *= f;
          sv *= f;
        }
        // device offset -> world offset (inverse of the 2x2 part of M), in unit-sphere units
        const wx = (d * su - cc * sv) * (this.ppm / det);
        const wy = (-b * su + a * sv) * (this.ppm / det);
        const wz = Math.sqrt(Math.max(0, 1 - wx * wx - wy * wy));
        idx.push((y * S + x) * 4);
        nx.push(wx);
        ny.push(wy);
        nz.push(wz);
        aaw.push(1 / (rad * Math.max(wz, 0.22)));
        rim.push(0.45 + 0.55 * Math.pow(wz, 0.7));
        fres.push(0.7 * Math.pow(1 - wz, 2.5));
        cov.push(k);
      }
    }
    this.geo = {
      S,
      rad,
      n: idx.length,
      idx: Int32Array.from(idx),
      nx: Float32Array.from(nx),
      ny: Float32Array.from(ny),
      nz: Float32Array.from(nz),
      aaw: Float32Array.from(aaw),
      rim: Float32Array.from(rim),
      fres: Float32Array.from(fres),
      cov: Float32Array.from(cov),
    };
    this.entries = [];
    this._buildGlyphs(rad);
  }

  // Number glyph alpha maps (bilinear-sampled by the sphere shader).
  _buildGlyphs(rad) {
    const G = Math.max(28, Math.ceil(rad * 2 * GLYPH_H * 2.2));
    this.glyphN = G;
    this.glyphs = [];
    const c = makeCanvas(G, G);
    const g = c.getContext('2d', { willReadFrequently: true }) || c.getContext('2d');
    for (let n = 1; n <= 15; n++) {
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, G, G);
      const text = String(n);
      const fs = G * (n >= 10 ? 0.66 : 0.74);
      g.font = `700 ${fs}px ${FONT}`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillStyle = '#000';
      const w = g.measureText(text).width;
      const maxW = G * (n >= 10 ? 0.86 : 0.7);
      const sx = w > maxW ? maxW / w : 1;
      const under = n === 6 || n === 9;
      const yc = G * (under ? 0.47 : 0.53);
      g.setTransform(sx, 0, 0, 1, G / 2, yc);
      g.fillText(text, 0, 0);
      if (under) {
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.fillRect(G * 0.36, G * 0.84, G * 0.28, Math.max(1.5, G * 0.06));
      }
      const data = g.getImageData(0, 0, G, G).data;
      const a = new Float32Array(G * G);
      for (let i = 0; i < G * G; i++) a[i] = data[i * 4 + 3] / 255;
      this.glyphs[n] = a;
    }
  }

  _entry(id) {
    let e = this.entries[id];
    if (e) return e;
    const geo = this.geo;
    const canvas = makeCanvas(geo.S, geo.S);
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(geo.S, geo.S);
    for (let k = 0; k < geo.n; k++) img.data[geo.idx[k] + 3] = Math.round(geo.cov[k] * 255);
    e = { canvas, ctx, img, q: [2, 0, 0, 0], L: [0, 0, 0], valid: false };
    this.entries[id] = e;
    return e;
  }

  _ensureSprite(id, x, y, q) {
    const e = this._entry(id);
    const qq = q || IDENTITY_Q;
    const L = this._light(x, y, this._L);
    if (
      e.valid &&
      Math.abs(e.q[0] - qq[0]) + Math.abs(e.q[1] - qq[1]) + Math.abs(e.q[2] - qq[2]) + Math.abs(e.q[3] - qq[3]) <
        Q_EPS &&
      Math.abs(e.L[0] - L[0]) + Math.abs(e.L[1] - L[1]) < L_EPS
    ) {
      return e;
    }
    const t0 = performance.now();
    this._renderBall(id, qq, L, e);
    e.q[0] = qq[0];
    e.q[1] = qq[1];
    e.q[2] = qq[2];
    e.q[3] = qq[3];
    e.L[0] = L[0];
    e.L[1] = L[1];
    e.L[2] = L[2];
    e.valid = true;
    this.stats.sprites++;
    this.stats.spriteMs += performance.now() - t0;
    return e;
  }

  // Analytic sphere shader: world normal -> ball-local frame -> albedo (colour, stripe band,
  // number discs with printed numbers) -> lamp lighting (Lambert + ambient + specular + rim).
  _renderBall(id, q, L, e) {
    const geo = this.geo;
    const n = geo.n;
    const IDX = geo.idx;
    const NX = geo.nx;
    const NY = geo.ny;
    const NZ = geo.nz;
    const AAW = geo.aaw;
    const RIM = geo.rim;
    const FRES = geo.fres;
    const d = e.img.data;
    const c0 = quatRotateInv(q, 1, 0, 0, this._c0);
    const c1 = quatRotateInv(q, 0, 1, 0, this._c1);
    const c2 = quatRotateInv(q, 0, 0, 1, this._c2);
    const c0x = c0[0], c0y = c0[1], c0z = c0[2];
    const c1x = c1[0], c1y = c1[1], c1z = c1[2];
    const c2x = c2[0], c2y = c2[1], c2z = c2[2];
    const kind = id === 0 ? 0 : id >= 9 ? 2 : 1;
    const base = this.colors[id];
    const BR = base[0], BG = base[1], BB = base[2];
    const WR = id === 0 ? this.colors[0][0] : WHITE[0];
    const WG = id === 0 ? this.colors[0][1] : WHITE[1];
    const WB = id === 0 ? this.colors[0][2] : WHITE[2];
    const glyph = this.glyphs[id] || null;
    const GN = this.glyphN;
    const GK = (0.5 / GLYPH_H) * GN;
    const GO = 0.5 * GN - 0.5;
    const GMAX = GN - 1.001;
    const cl = hexRgb(this.clothHex);
    const ER = cl[0] * 0.55, EG = cl[1] * 0.55, EB = cl[2] * 0.55; // cloth seen in the rim
    const Lx = L[0], Ly = L[1], Lz = L[2];
    let hx = Lx, hy = Ly, hz = Lz + 1;
    const hl = Math.hypot(hx, hy, hz);
    hx /= hl;
    hy /= hl;
    hz /= hl;
    const dark = id === 8;
    const AMB = 0.2;
    const KD = 0.72;
    const SPEC = dark ? 1.15 : 1;
    for (let k = 0; k < n; k++) {
      const wx = NX[k], wy = NY[k], wz = NZ[k];
      const lx = wx * c0x + wy * c1x + wz * c2x;
      const ly = wx * c0y + wy * c1y + wz * c2y;
      const lz = wx * c0z + wy * c1z + wz * c2z;
      const aw = AAW[k];
      let r = WR, g = WG, b = WB;
      const ax = lx < 0 ? -lx : lx;
      if (kind === 0) {
        let t = (ax - DOT_COS) / (aw * 0.12) + 0.5;
        if (t > 0) {
          if (t > 1) t = 1;
          r += (DOT_RED[0] - r) * t;
          g += (DOT_RED[1] - g) * t;
          b += (DOT_RED[2] - b) * t;
        }
      } else {
        let f = 1;
        if (kind === 2) {
          const az = lz < 0 ? -lz : lz;
          f = (STRIPE_Z - az) / aw + 0.5;
          f = f < 0 ? 0 : f > 1 ? 1 : f;
        }
        let disc = (ax - DISC_COS) / (aw * 0.55) + 0.5;
        disc = disc < 0 ? 0 : disc > 1 ? 1 : disc;
        f *= 1 - disc;
        r = WR + (BR - WR) * f;
        g = WG + (BG - WG) * f;
        b = WB + (BB - WB) * f;
        if (disc > 0 && glyph) {
          let gx = (lx > 0 ? ly : -ly) * GK + GO;
          let gy = -lz * GK + GO;
          if (gx > 0 && gy > 0 && gx < GMAX && gy < GMAX) {
            const ix = gx | 0;
            const iy = gy | 0;
            gx -= ix;
            gy -= iy;
            const o = iy * GN + ix;
            const a0 = glyph[o] + (glyph[o + 1] - glyph[o]) * gx;
            const a1 = glyph[o + GN] + (glyph[o + GN + 1] - glyph[o + GN]) * gx;
            const a = (a0 + (a1 - a0) * gy) * disc;
            if (a > 0) {
              r += (INK[0] - r) * a;
              g += (INK[1] - g) * a;
              b += (INK[2] - b) * a;
            }
          }
        }
      }
      let dif = wx * Lx + wy * Ly + wz * Lz;
      if (dif < 0) dif = 0;
      const h = wx * hx + wy * hy + wz * hz;
      let sp = 0;
      if (h > 0.55) {
        const h2 = h * h;
        const h4 = h2 * h2;
        const h8 = h4 * h4;
        const h16 = h8 * h8;
        sp = 34 * h16;
        if (h > 0.95) {
          const h64 = h16 * h16 * h16 * h16;
          const hot = (h - 0.9938) * 300 + 0.5;
          sp += 150 * h64 + (hot <= 0 ? 0 : hot >= 1 ? 255 : hot * 255);
        }
        sp *= SPEC;
      }
      const sh = (AMB + KD * dif) * RIM[k];
      const fr = FRES[k];
      const o = IDX[k];
      d[o] = r * sh + sp + ER * fr;
      d[o + 1] = g * sh + sp + EG * fr;
      d[o + 2] = b * sh + sp + EB * fr;
    }
    e.ctx.putImageData(e.img, 0, 0);
  }

  _buildShadowSprites() {
    const N = 64;
    const c = makeCanvas(N, N);
    const g = c.getContext('2d');
    const gr = g.createRadialGradient(N / 2, N / 2, 0, N / 2, N / 2, N / 2);
    gr.addColorStop(0, 'rgba(0,0,0,0.6)');
    gr.addColorStop(0.4, 'rgba(0,0,0,0.5)');
    gr.addColorStop(0.62, 'rgba(0,0,0,0.26)');
    gr.addColorStop(0.82, 'rgba(0,0,0,0.08)');
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, N, N);
    this._shadowSprite = c;
    // contact occlusion ring just around the ball's silhouette
    const ao = makeCanvas(N, N);
    const ga = ao.getContext('2d');
    const ag = ga.createRadialGradient(N / 2, N / 2, 0, N / 2, N / 2, N / 2);
    ag.addColorStop(0, 'rgba(0,0,0,0.6)');
    ag.addColorStop(0.74, 'rgba(0,0,0,0.55)');
    ag.addColorStop(0.82, 'rgba(0,0,0,0.24)');
    ag.addColorStop(1, 'rgba(0,0,0,0)');
    ga.fillStyle = ag;
    ga.fillRect(0, 0, N, N);
    this._aoSprite = ao;
  }

  _drawShadow(x, y, k) {
    const ctx = this.ctx;
    const M = this.M;
    const L = this._light(x, y, this._L);
    const ox = (-L[0] / L[2]) * R * k;
    const oy = (-L[1] / L[2]) * R * k;
    const sx = x + ox * 1.1;
    const sy = y + oy * 1.1;
    const dx = M[0] * sx + M[2] * sy + M[4];
    const dy = M[1] * sx + M[3] * sy + M[5];
    let ex = M[0] * ox + M[2] * oy;
    let ey = M[1] * ox + M[3] * oy;
    const el = Math.hypot(ex, ey);
    if (el > 1e-6) {
      ex /= el;
      ey /= el;
    } else {
      ex = 1;
      ey = 0;
    }
    const across = 2.9 * R * this.ppm * (0.9 + 0.1 * k);
    const along = across * (1 + (0.6 * el) / (R * this.ppm));
    ctx.setTransform(ex * along, ey * along, -ey * across, ex * across, dx, dy);
    ctx.drawImage(this._shadowSprite, -0.5, -0.5, 1, 1);
    const cx = M[0] * x + M[2] * y + M[4];
    const cy = M[1] * x + M[3] * y + M[5];
    const s = 2.7 * R * this.ppm;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this._aoSprite, cx - s / 2, cy - s / 2, s, s);
  }

  _drawBall(id, x, y, q, scale) {
    const e = this._ensureSprite(id, x, y, q);
    const S = this.geo.S;
    const M = this.M;
    const dx = M[0] * x + M[2] * y + M[4];
    const dy = M[1] * x + M[3] * y + M[5];
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (scale === 1) {
      ctx.drawImage(e.canvas, Math.round(dx - S / 2), Math.round(dy - S / 2));
    } else {
      const s = S * scale;
      ctx.drawImage(e.canvas, dx - s / 2, dy - s / 2, s, s);
    }
  }

  _drawDrops(time) {
    if (!this.drops.length) return;
    const ctx = this.ctx;
    const S = this.geo.S;
    const keep = [];
    for (const a of this.drops) {
      if (a.t0 === null) a.t0 = time;
      const k = (time - a.t0) / DROP_T;
      if (k >= 1 || k < -0.5) continue;
      keep.push(a);
      const kk = k < 0 ? 0 : k;
      const m = 1 - (1 - Math.min(1, kk * 1.25)) ** 2; // slide in, decelerating
      const x = a.x0 + (a.hole.x - a.x0) * m;
      const y = a.y0 + (a.hole.y - a.y0) * m;
      const prev = this.entries[a.id];
      const e = this._ensureSprite(a.id, x, y, a.q || (prev && prev.valid ? prev.q.slice() : null));
      const sc = 1 - 0.42 * kk;
      const M = this.M;
      const dx = M[0] * x + M[2] * y + M[4];
      const dy = M[1] * x + M[3] * y + M[5];
      const s = S * sc;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = kk > 0.7 ? (1 - kk) / 0.3 : 1;
      ctx.drawImage(e.canvas, dx - s / 2, dy - s / 2, s, s);
      ctx.beginPath();
      ctx.arc(dx, dy, (s / 2) * 0.98 - 0.5, 0, TAU);
      ctx.fillStyle = `rgba(0,0,0,${Math.min(0.92, kk * 1.15)})`;
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    this.drops = keep;
  }

  // ---- overlays -----------------------------------------------------------------------------

  _strokeTwice(w, alpha, color) {
    const ctx = this.ctx;
    const s = this.view.scale;
    ctx.lineWidth = w + 1.6 / s;
    ctx.strokeStyle = 'rgba(0,0,0,0.26)';
    ctx.stroke();
    ctx.lineWidth = w;
    ctx.strokeStyle = color || `rgba(255,255,255,${alpha})`;
    ctx.stroke();
  }

  // Guide lines are clipped to the playing surface (plus the pocket mouths) so they never run
  // out over the rails.
  _drawGuide(gd, balls) {
    const ctx = this.ctx;
    const m = 0.035;
    const { HL: hl, HW: hw } = this.table;
    ctx.save();
    this._world(ctx);
    ctx.beginPath();
    ctx.rect(-hl - m, -hw - m, 2 * (hl + m), 2 * (hw + m));
    ctx.clip();
    this._drawGuideLines(gd, balls);
    ctx.restore();
  }

  _drawGuideLines(gd, balls) {
    const ctx = this.ctx;
    const s = this.view.scale;
    const tr = traceAim(balls, gd.x, gd.y, gd.angle, this.table.pockets);
    const dx = Math.cos(gd.angle);
    const dy = Math.sin(gd.angle);
    const lw = 1.3 / s;
    const maxLen = gd.length > 0 ? gd.length : Infinity;
    this._world(ctx);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.setLineDash([]);
    const start = R + 2 / s;
    if (tr.dist > maxLen) {
      // Limited guide: fade the line out before the first contact.
      if (maxLen > start) {
        const x1 = gd.x + dx * maxLen;
        const y1 = gd.y + dy * maxLen;
        const fg = ctx.createLinearGradient(gd.x, gd.y, x1, y1);
        fg.addColorStop(0, 'rgba(255,255,255,0.8)');
        fg.addColorStop(0.6, 'rgba(255,255,255,0.55)');
        fg.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.beginPath();
        ctx.moveTo(gd.x + dx * start, gd.y + dy * start);
        ctx.lineTo(x1, y1);
        ctx.lineWidth = lw;
        ctx.strokeStyle = fg;
        ctx.stroke();
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      return;
    }
    const gx = tr.ghost.x;
    const gy = tr.ghost.y;
    const end = tr.dist - R;
    if (end > start) {
      ctx.beginPath();
      ctx.moveTo(gd.x + dx * start, gd.y + dy * start);
      ctx.lineTo(gd.x + dx * end, gd.y + dy * end);
      this._strokeTwice(lw, 0.78);
    }
    // ghost ball
    ctx.beginPath();
    ctx.arc(gx, gy, R - lw * 0.5, 0, TAU);
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fill();
    this._strokeTwice(lw, 0.85);
    if (tr.type === 'ball') {
      const hit = balls.find((b) => b && b.id === tr.ball);
      if (hit) {
        const k = 1 - Math.min(1, tr.cut / (Math.PI / 2));
        const len = 0.35 * k * 0.8 + 0.1;
        const ox = tr.objDir.x;
        const oy = tr.objDir.y;
        ctx.beginPath();
        ctx.moveTo(hit.x + ox * (R + 2 / s), hit.y + oy * (R + 2 / s));
        ctx.lineTo(hit.x + ox * (R + len), hit.y + oy * (R + len));
        this._strokeTwice(lw * 1.1, tr.pocket !== null ? 0.95 : 0.72);
        // arrow head
        const ax = hit.x + ox * (R + len);
        const ay = hit.y + oy * (R + len);
        const hs = 5 / s;
        ctx.beginPath();
        ctx.moveTo(ax - ox * hs - oy * hs * 0.6, ay - oy * hs + ox * hs * 0.6);
        ctx.lineTo(ax, ay);
        ctx.lineTo(ax - ox * hs + oy * hs * 0.6, ay - oy * hs - ox * hs * 0.6);
        this._strokeTwice(lw * 1.1, tr.pocket !== null ? 0.95 : 0.72);
      }
      const cx = tr.cueDir.x;
      const cy = tr.cueDir.y;
      if (cx || cy) {
        ctx.setLineDash([5 / s, 4 / s]);
        ctx.beginPath();
        ctx.moveTo(gx + cx * (R + 2 / s), gy + cy * (R + 2 / s));
        ctx.lineTo(gx + cx * (R + 0.15), gy + cy * (R + 0.15));
        this._strokeTwice(lw * 0.9, 0.55);
        ctx.setLineDash([]);
      }
    } else if (tr.reflect) {
      const rx = tr.reflect.x;
      const ry = tr.reflect.y;
      const rr = rayRails(gx, gy, rx, ry);
      const len = Math.min(0.22, rr.t > 1e-3 ? rr.t : 0.22);
      ctx.setLineDash([5 / s, 4 / s]);
      ctx.beginPath();
      ctx.moveTo(gx + rx * (R + 2 / s), gy + ry * (R + 2 / s));
      ctx.lineTo(gx + rx * (R + len), gy + ry * (R + len));
      this._strokeTwice(lw * 0.9, 0.6);
      ctx.setLineDash([]);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  _drawTargets(targets, balls, time) {
    const ctx = this.ctx;
    const s = this.view.scale;
    const a = 0.22 + 0.22 * (0.5 + 0.5 * Math.sin(time * TAU * 1.1));
    this._world(ctx);
    ctx.setLineDash([]);
    for (const id of targets) {
      const b = balls.find((bb) => bb && bb.id === id);
      if (!b || !b.on) continue;
      ctx.beginPath();
      ctx.arc(b.x, b.y, R + 3 / s, 0, TAU);
      ctx.lineWidth = 1.5 / s;
      ctx.strokeStyle = `rgba(255,255,255,${a})`;
      ctx.stroke();
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  _drawPocketMarks(pk, time) {
    const ctx = this.ctx;
    const s = this.view.scale;
    const pulse = 0.5 + 0.5 * Math.sin(time * TAU * 1.3);
    this._world(ctx);
    ctx.setLineDash([]);
    for (const h of this.holes) {
      const called = pk.called === h.id;
      const sugg = !called && pk.suggested === h.id;
      if (called) {
        ctx.beginPath();
        ctx.arc(h.x, h.y, h.r * 0.95, 0, TAU);
        ctx.fillStyle = 'rgba(255,214,90,0.22)';
        ctx.fill();
        ctx.save();
        ctx.shadowColor = 'rgba(255,200,60,0.9)';
        ctx.shadowBlur = 10 * this.dpr;
        ctx.lineWidth = 3 / s;
        ctx.strokeStyle = 'rgba(255,222,110,1)';
        ctx.stroke();
        ctx.restore();
        // small marker dot toward the table
        ctx.beginPath();
        ctx.arc(h.x - h.dir.x * h.r * 0.25, h.y - h.dir.y * h.r * 0.25, 3.2 / s, 0, TAU);
        ctx.fillStyle = 'rgba(255,230,140,1)';
        ctx.fill();
      } else if (sugg) {
        ctx.beginPath();
        ctx.arc(h.x, h.y, h.r * 0.9, 0, TAU);
        ctx.lineWidth = 2 / s;
        ctx.strokeStyle = `rgba(255,222,110,${0.45 + 0.25 * pulse})`;
        ctx.stroke();
      }
      if (pk.selectable && !called) {
        ctx.beginPath();
        ctx.arc(h.x, h.y, h.r * (0.82 + 0.12 * pulse), 0, TAU);
        ctx.lineWidth = 1.6 / s;
        ctx.strokeStyle = `rgba(255,255,255,${0.35 + 0.35 * pulse})`;
        ctx.stroke();
      }
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  _drawBallInHand(bih, time) {
    const ctx = this.ctx;
    const s = this.view.scale;
    const col = bih.valid === false ? '255,82,70' : '84,228,128';
    this._world(ctx);
    ctx.setLineDash([]);
    ctx.lineCap = 'round';
    const rr = R * (bih.dragging ? 1.75 : 1.55);
    ctx.beginPath();
    ctx.arc(bih.x, bih.y, rr, 0, TAU);
    ctx.lineWidth = (bih.dragging ? 2.4 : 2) / s;
    ctx.strokeStyle = 'rgba(0,0,0,0.3)';
    ctx.lineWidth += 1.5 / s;
    ctx.stroke();
    ctx.lineWidth = (bih.dragging ? 2.4 : 2) / s;
    ctx.strokeStyle = `rgba(${col},0.95)`;
    ctx.stroke();
    if (!bih.dragging) {
      // four "move" chevrons around the ball
      const pulse = 0.5 + 0.5 * Math.sin(time * TAU * 0.9);
      const rad = R * 2.15 + (2 * pulse) / s;
      const hs = 4.5 / s;
      for (let i = 0; i < 4; i++) {
        const a = (i * Math.PI) / 2;
        const ux = Math.cos(a);
        const uy = Math.sin(a);
        const tx = bih.x + ux * (rad + hs);
        const ty = bih.y + uy * (rad + hs);
        ctx.beginPath();
        ctx.moveTo(tx - ux * hs - uy * hs, ty - uy * hs + ux * hs);
        ctx.lineTo(tx, ty);
        ctx.lineTo(tx - ux * hs + uy * hs, ty - uy * hs - ux * hs);
        ctx.lineWidth = 3.4 / s;
        ctx.strokeStyle = 'rgba(0,0,0,0.3)';
        ctx.stroke();
        ctx.lineWidth = 1.8 / s;
        ctx.strokeStyle = `rgba(${col},${0.6 + 0.35 * pulse})`;
        ctx.stroke();
      }
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  // ---- cue ----------------------------------------------------------------------------------

  // Pre-render the cue (horizontal, tip at x = 0) and its blurred shadow at device resolution.
  _buildCue() {
    const ppm = this.ppm;
    const Lp = Math.ceil(CUE_LEN * ppm) + 2;
    const Hp = Math.ceil(2 * 0.0152 * ppm) + 4;
    const yc = Hp / 2;
    const c = makeCanvas(Lp, Hp);
    const g = c.getContext('2d');
    const img = g.createImageData(Lp, Hp);
    const d = img.data;
    const nz1 = makeNoise(515);
    for (let i = 0; i < Lp; i++) {
      const um = (i + 0.5) / ppm;
      const rr = cueRadius(um) * ppm;
      if (rr <= 0) continue;
      for (let j = 0; j < Hp; j++) {
        const y = j + 0.5 - yc;
        const cov = clamp01(rr - Math.abs(y) + 0.5);
        if (cov <= 0) continue;
        let vn = y / rr;
        if (vn > 1) vn = 1;
        if (vn < -1) vn = -1;
        const nzz = Math.sqrt(1 - vn * vn);
        const th = Math.asin(vn);
        const m = cueMaterial(um, th, nz1);
        let r;
        let gg;
        let b;
        if (m.metal) {
          // stainless: reflect a bright lamp band and a dark room
          const env = 0.25 + 0.75 * Math.exp(-(((vn + 0.2) / 0.22) ** 2)) + 0.25 * Math.exp(-(((vn - 0.6) / 0.15) ** 2));
          r = m.c[0] * env + 40;
          gg = m.c[1] * env + 40;
          b = m.c[2] * env + 44;
        } else {
          const dif = 0.38 + 0.62 * nzz;
          const sp = m.gloss * (230 * Math.exp(-(((vn + 0.22) / 0.11) ** 2)) + 40 * Math.exp(-(((vn + 0.2) / 0.35) ** 2)));
          r = m.c[0] * dif + sp;
          gg = m.c[1] * dif + sp;
          b = m.c[2] * dif + sp;
        }
        const o = (j * Lp + i) * 4;
        d[o] = r;
        d[o + 1] = gg;
        d[o + 2] = b;
        d[o + 3] = cov * 255;
      }
    }
    g.putImageData(img, 0, 0);
    this._cue = { canvas: c, yc, Lp, Hp };
    // shadow: blurred silhouette
    const blur = Math.max(3, 0.006 * ppm);
    const mg = Math.ceil(blur * 2.5);
    const sc = makeCanvas(Lp + 2 * mg, Hp + 2 * mg);
    const sg = sc.getContext('2d');
    sg.shadowColor = 'rgba(0,0,0,0.5)';
    sg.shadowBlur = blur;
    sg.shadowOffsetX = 10000;
    sg.drawImage(c, mg - 10000, mg);
    this._cueShadow = { canvas: sc, mg };
  }

  _drawCue(cue) {
    const ctx = this.ctx;
    const M = this.M;
    const pull = clamp01(cue.pull || 0);
    const stroke = clamp01(cue.stroke || 0);
    const tipDist = R + (0.004 + pull * 0.25) * (1 - stroke);
    const wx = -Math.cos(cue.angle);
    const wy = -Math.sin(cue.angle);
    const tx = cue.x + wx * tipDist;
    const ty = cue.y + wy * tipDist;
    const tip = this._dev(tx, ty);
    let ux = M[0] * wx + M[2] * wy;
    let uy = M[1] * wx + M[3] * wy;
    const ul = Math.hypot(ux, uy) || 1;
    ux /= ul;
    uy /= ul;
    const px = -uy;
    const py = ux;
    // shadow: cast away from the lamp; the butt is raised so the offset grows along the cue
    const lgx = (cue.x < -LAMP_X ? -LAMP_X : cue.x > LAMP_X ? LAMP_X : cue.x) * 0.5;
    let sx = cue.x - lgx;
    let sy = cue.y;
    const sl = Math.hypot(sx, sy);
    const minOff = 0.35;
    if (sl < minOff * LAMP_H) {
      // still give the shadow a little offset (the lamp is a broad source) toward the near rail
      const f = sl > 1e-6 ? (minOff * LAMP_H) / sl : 0;
      if (f) {
        sx *= f;
        sy *= f;
      } else {
        sy = -minOff * LAMP_H;
      }
    }
    sx /= LAMP_H;
    sy /= LAMP_H;
    const sdx = M[0] * sx + M[2] * sy; // device px per metre of height
    const sdy = M[1] * sx + M[3] * sy;
    const slope = 0.1 / this.ppm; // height gained per device px along the cue
    const h0 = R * 1.2;
    const sh = this._cueShadow;
    ctx.setTransform(
      ux + sdx * slope,
      uy + sdy * slope,
      px,
      py,
      tip.x + sdx * h0,
      tip.y + sdy * h0,
    );
    ctx.drawImage(sh.canvas, -sh.mg, -this._cue.yc - sh.mg);
    ctx.setTransform(ux, uy, px, py, tip.x, tip.y);
    ctx.drawImage(this._cue.canvas, 0, -this._cue.yc);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }
}

const IDENTITY_Q = [1, 0, 0, 0];

// Cue profile (radius in metres) as a function of the distance from the tip.
function cueRadius(u) {
  if (u < 0 || u > CUE_LEN) return 0;
  if (u < 0.0035) {
    const k = (0.0035 - u) / 0.0035;
    return 0.0064 * Math.sqrt(Math.max(0, 1 - k * k * 0.85));
  }
  if (u < 0.011) return 0.0064;
  if (u < 0.036) return 0.00648;
  if (u < 0.3) return 0.0066 + (u - 0.036) * 0.0012;
  if (u < 0.74) return 0.00692 + ((u - 0.3) / 0.44) * 0.0038;
  if (u < 0.765) return 0.011;
  if (u < 1.08) return 0.0108 + ((u - 0.765) / 0.315) * 0.002;
  if (u < 1.095) return 0.0129;
  if (u < 1.355) return 0.0129 + ((u - 1.095) / 0.26) * 0.0012;
  if (u < 1.37) return 0.0142;
  if (u < 1.456) return 0.0142 + ((u - 1.37) / 0.086) * 0.0008;
  const k = (u - 1.456) / (CUE_LEN - 1.456);
  return 0.0148 * Math.sqrt(Math.max(0, 1 - k * k * 0.75));
}

// Albedo / material of the cue at distance u from the tip and angle th around it (top = 0).
function cueMaterial(u, th, noise) {
  if (u < 0.0028) return { c: [52, 104, 196], gloss: 0.05 }; // chalk
  if (u < 0.011) {
    const chalk = u < 0.0045 ? 0.6 : 0;
    return { c: mix([118, 78, 44], [60, 98, 170], chalk), gloss: 0.08 }; // leather tip
  }
  if (u < 0.036) return { c: [238, 233, 220], gloss: 0.45 }; // ferrule
  if (u < 0.74) {
    const gr = 0.94 + 0.06 * Math.sin(th * 26 + noise(u * 6, th * 3) * 6);
    return { c: [222 * gr, 196 * gr, 146 * gr], gloss: 0.35 }; // maple shaft
  }
  if (u < 0.765) {
    if (u < 0.744 || u > 0.761) return { c: [20, 20, 22], gloss: 0.5 }; // black rings
    return { c: [190, 192, 198], metal: true }; // stainless joint collar
  }
  const ebony = (k) => {
    const gr = 0.85 + 0.3 * noise(u * 30, th * 8 + k);
    return [34 * gr, 22 * gr, 16 * gr];
  };
  if (u < 1.08) {
    // forearm: ebony with four bird's-eye maple points (two visible), veneers and pearl inlays
    const s = (u - 0.765) / 0.315; // 0 at the joint .. 1 at the wrap
    const pw = s > 0.12 ? ((s - 0.12) / 0.88) * 0.62 : -1;
    for (const c0 of [-Math.PI / 4, Math.PI / 4]) {
      const dt = Math.abs(th - c0);
      if (pw > 0 && dt < pw) {
        if (dt > pw - 0.07) return { c: dt > pw - 0.035 ? [235, 228, 210] : [24, 20, 18], gloss: 0.55 };
        const bird = noise(u * 400, th * 40) > 0.78 ? 0.82 : 1;
        // pearl diamond inlay near the base of each point
        const du = Math.abs(u - 1.02) / 0.012;
        const dth = Math.abs(th - c0) / 0.2;
        if (du + dth < 1) return { c: [236, 238, 244], gloss: 0.8 };
        return { c: [214 * bird, 176 * bird, 118 * bird], gloss: 0.55 };
      }
    }
    return { c: ebony(0), gloss: 0.55 };
  }
  if (u < 1.095) {
    const k = (u - 1.08) / 0.015;
    return { c: k < 0.25 || k > 0.75 ? [20, 18, 16] : [228, 222, 206], gloss: 0.5 };
  }
  if (u < 1.355) {
    // Irish linen wrap
    const w = Math.sin(u * 2300 + th * 9) * Math.sin(u * 2300 - th * 9);
    const v = 30 + 10 * w + 6 * (noise(u * 900, th * 30) - 0.5);
    return { c: [v, v, v * 1.05], gloss: 0.04 };
  }
  if (u < 1.37) {
    const k = (u - 1.355) / 0.015;
    return { c: k < 0.25 || k > 0.75 ? [20, 18, 16] : [228, 222, 206], gloss: 0.5 };
  }
  if (u < 1.456) {
    // butt sleeve: ebony with a band of pearl diamonds
    const du = Math.abs(u - 1.41) / 0.01;
    const per = (Math.PI * 2) / 8;
    const tt = ((th % per) + per) % per;
    const dth = Math.abs(tt - per / 2) / 0.2;
    if (du + dth < 1) return { c: [236, 238, 244], gloss: 0.8 };
    if (Math.abs(u - 1.388) < 0.0012 || Math.abs(u - 1.432) < 0.0012) return { c: [210, 205, 190], gloss: 0.6 };
    return { c: ebony(5), gloss: 0.55 };
  }
  return { c: [14, 14, 14], gloss: 0.06 }; // rubber bumper
}
