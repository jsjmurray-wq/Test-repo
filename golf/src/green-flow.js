// Flowing slope display for the green (pure, no DOM; architecture.md section 8.9).
//
// slopeField samples the green once per hole (gradient, height and an on-green mask on a grid in
// the green's own rotated frame, like meshes.greenReadMesh). FlowParticles then runs a few hundred
// deterministic particles downhill over it: each one moves at a speed that grows with the slope
// (so steep parts visibly race and flat parts barely creep), lives 2.5-4 s with a fade in and out,
// and respawns somewhere else on the green. writeQuads turns them into camera-relative streak
// quads (head at the particle, tail uphill, length with the speed, a minimum width on screen) for
// render.js's FLOW program. step() and writeQuads() allocate nothing.

import { mulberry32 } from './rng.js';
import { SURF } from './constants.js';

export const FLOW_FLOATS = 7; // per vertex: x, y, z (camera-relative), u (0 tail..1 head), v (-1..1), slope %, alpha
export const FLOW_MAX = 600;

// Grid over the green ellipse plus `pad` m: per node gx, gy (dz/dx, dz/dy), h (ground z), mask
// (1 on the green). Returns {cx, cy, c, s, ex, ey, nu, nv, res, data: Float32Array(nu*nv*4), area}.
export function slopeField(terrain, { pad = 1, res = 0.5 } = {}) {
  const g = terrain.green;
  if (!g) return null;
  const c = Math.cos(g.rot || 0);
  const s = Math.sin(g.rot || 0);
  const ex = g.rx + pad;
  const ey = g.ry + pad;
  const nu = Math.ceil((2 * ex) / res) + 1;
  const nv = Math.ceil((2 * ey) / res) + 1;
  const data = new Float32Array(nu * nv * 4);
  const gr = { x: 0, y: 0 };
  let area = 0;
  for (let jv = 0; jv < nv; jv++) {
    for (let ju = 0; ju < nu; ju++) {
      const lu = -ex + ju * res;
      const lv = -ey + jv * res;
      const x = g.cx + lu * c - lv * s;
      const y = g.cy + lu * s + lv * c;
      terrain.gradAt(x, y, gr);
      const on = terrain.surfaceAt(x, y) === SURF.GREEN ? 1 : 0;
      const k = (jv * nu + ju) * 4;
      data[k] = gr.x;
      data[k + 1] = gr.y;
      data[k + 2] = terrain.heightAt(x, y);
      data[k + 3] = on;
      area += on * res * res;
    }
  }
  return { cx: g.cx, cy: g.cy, c, s, ex, ey, nu, nv, res, data, area };
}

// Bilinear sample at world (x, y) into out {gx, gy, h, mask} (mask 0 off the grid).
export function sampleSlope(f, x, y, out) {
  const dx = x - f.cx;
  const dy = y - f.cy;
  const fu = (dx * f.c + dy * f.s + f.ex) / f.res;
  const fv = (-dx * f.s + dy * f.c + f.ey) / f.res;
  if (!(fu >= 0 && fv >= 0 && fu < f.nu - 1 && fv < f.nv - 1)) {
    out.gx = 0;
    out.gy = 0;
    out.h = 0;
    out.mask = 0;
    return out;
  }
  const iu = fu | 0;
  const iv = fv | 0;
  const tu = fu - iu;
  const tv = fv - iv;
  const d = f.data;
  const k00 = (iv * f.nu + iu) * 4;
  const k10 = k00 + 4;
  const k01 = k00 + f.nu * 4;
  const k11 = k01 + 4;
  const w00 = (1 - tu) * (1 - tv);
  const w10 = tu * (1 - tv);
  const w01 = (1 - tu) * tv;
  const w11 = tu * tv;
  out.gx = d[k00] * w00 + d[k10] * w10 + d[k01] * w01 + d[k11] * w11;
  out.gy = d[k00 + 1] * w00 + d[k10 + 1] * w10 + d[k01 + 1] * w01 + d[k11 + 1] * w11;
  out.h = d[k00 + 2] * w00 + d[k10 + 2] * w10 + d[k01 + 2] * w01 + d[k11 + 2] * w11;
  out.mask = d[k00 + 3] * w00 + d[k10 + 3] * w10 + d[k01 + 3] * w01 + d[k11 + 3] * w11;
  return out;
}

// Speed of a particle (m/s) on a slope of pct percent.
export function flowSpeed(pct) {
  return Math.min(1.2, Math.max(0.03, 0.3 * pct));
}

function putVertex(out, o, x, y, z, u, v, sl, a) {
  out[o] = x;
  out[o + 1] = y;
  out[o + 2] = z;
  out[o + 3] = u;
  out[o + 4] = v;
  out[o + 5] = sl;
  out[o + 6] = a;
  return o + FLOW_FLOATS;
}

export class FlowParticles {
  constructor(field, { count = null, seed = 7, density = 0.6 } = {}) {
    this.field = field;
    const n = count != null ? count : Math.round((field ? field.area : 0) * density);
    this.n = Math.max(0, Math.min(FLOW_MAX, n));
    this.rng = mulberry32(seed);
    this.x = new Float32Array(this.n);
    this.y = new Float32Array(this.n);
    this.z = new Float32Array(this.n);
    this.dx = new Float32Array(this.n); // unit downhill direction
    this.dy = new Float32Array(this.n);
    this.v = new Float32Array(this.n); // speed m/s
    this.pct = new Float32Array(this.n);
    this.age = new Float32Array(this.n);
    this.life = new Float32Array(this.n);
    this._s = { gx: 0, gy: 0, h: 0, mask: 0 };
    for (let i = 0; i < this.n; i++) {
      this._spawn(i);
      this.age[i] = this.rng() * this.life[i]; // staggered
    }
  }

  // A new particle at a random spot on the green.
  _spawn(i) {
    const f = this.field;
    const s = this._s;
    this.age[i] = 0;
    this.life[i] = 2.5 + 1.5 * this.rng();
    for (let tries = 0; tries < 12; tries++) {
      const lu = (this.rng() * 2 - 1) * f.ex;
      const lv = (this.rng() * 2 - 1) * f.ey;
      const x = f.cx + lu * f.c - lv * f.s;
      const y = f.cy + lu * f.s + lv * f.c;
      sampleSlope(f, x, y, s);
      if (s.mask > 0.99 || tries === 11) {
        this.x[i] = x;
        this.y[i] = y;
        this._orient(i);
        return;
      }
    }
  }

  // Direction, speed and height from the field at the particle's spot (sampled into this._s).
  _orient(i) {
    const s = this._s;
    const g = Math.hypot(s.gx, s.gy);
    this.pct[i] = g * 100;
    this.v[i] = flowSpeed(g * 100);
    this.dx[i] = g > 1e-6 ? -s.gx / g : 0;
    this.dy[i] = g > 1e-6 ? -s.gy / g : 0;
    this.z[i] = s.h;
  }

  step(dt) {
    if (!this.field || !(dt > 0)) return;
    const s = this._s;
    const d = Math.min(dt, 0.1);
    for (let i = 0; i < this.n; i++) {
      this.age[i] += d;
      this.x[i] += this.dx[i] * this.v[i] * d;
      this.y[i] += this.dy[i] * this.v[i] * d;
      sampleSlope(this.field, this.x[i], this.y[i], s);
      if (this.age[i] >= this.life[i] || s.mask < 0.5) {
        this._spawn(i);
        continue;
      }
      this._orient(i);
    }
  }

  // Alpha of particle i: fades in over 0.4 s and out over the last 0.7 s; nearly flat ground
  // (under 0.25%) shows none (no direction to show).
  alpha(i) {
    const a = this.age[i];
    const l = this.life[i];
    const fade = Math.min(1, a / 0.4, (l - a) / 0.7);
    return Math.max(0, fade) * Math.min(1, this.pct[i] / 0.25);
  }

  // Streak quads into out (FLOW_FLOATS per vertex, 4 vertices per particle: tail-left, tail-right,
  // head-left, head-right), camera-relative to eye. A streak is 0.18-0.75 m long with the speed
  // and at least minPx CSS px wide. lift raises it over the turf. Returns the particle count.
  writeQuads(out, eye, { pxPerRad = 900, minPx = 3, width = 0.035, lift = 0.02 } = {}) {
    const m = Math.min(this.n, (out.length / (4 * FLOW_FLOATS)) | 0);
    let o = 0;
    for (let i = 0; i < m; i++) {
      const hx = this.x[i];
      const hy = this.y[i];
      const hz = this.z[i] + lift;
      const len = Math.min(0.75, 0.18 + this.v[i] * 0.5);
      const ux = this.dx[i];
      const uy = this.dy[i];
      const dist = Math.hypot(hx - eye.x, hy - eye.y, hz - eye.z);
      const w = Math.max(width, ((minPx / pxPerRad) * dist) * 0.5);
      // Perpendicular (horizontal); a flat-ground particle with no direction gets an x/y cross.
      const px = ux || uy ? -uy * w : w;
      const py = ux || uy ? ux * w : 0;
      const tx = hx - ux * len;
      const ty = hy - uy * len;
      const a = this.alpha(i);
      const sl = this.pct[i];
      const z = hz - eye.z;
      const zt = z + (len * sl) / 100; // the tail lies uphill
      o = putVertex(out, o, tx - px - eye.x, ty - py - eye.y, zt, 0, -1, sl, a);
      o = putVertex(out, o, tx + px - eye.x, ty + py - eye.y, zt, 0, 1, sl, a);
      o = putVertex(out, o, hx - px - eye.x, hy - py - eye.y, z, 1, -1, sl, a);
      o = putVertex(out, o, hx + px - eye.x, hy + py - eye.y, z, 1, 1, sl, a);
    }
    return m;
  }
}

// Index buffer for n streak quads (two triangles each over 4 vertices).
export function flowIndices(n) {
  const idx = new Uint16Array(n * 6);
  for (let i = 0; i < n; i++) {
    const b = i * 4;
    idx.set([b, b + 1, b + 2, b + 1, b + 3, b + 2], i * 6);
  }
  return idx;
}
