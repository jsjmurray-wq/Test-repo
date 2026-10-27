// Hole terrain: turns a HoleDef (course.js) into the HoleTerrain contract of architecture.md §3.
//
// Pipeline (all deterministic):
//  1. Centreline spline (spline.js) and a 2 m field of (s, lat, base elevation) over the bounds.
//     The elevation profile is a monotone cubic Hermite along s. Far from the path the projection
//     can jump between two branches of a dogleg (the medial axis), so the base elevation is blended
//     toward a box-blurred copy there; near the path it is used raw.
//  2. A 1 m height grid F = surround S (base + corridor hills + fbm undulation + mounds + flattened
//     tee) blended into the analytic green G, then water beds/banks and bunker bowls with lips.
//  3. heightAt = bilinear(F) + m * (G - bilinear(G)), where m = 1 on the green and fringe and fades
//     to 0 just outside. On the green every surrounding grid node has F == G, so the result is G
//     exactly (analytic), while the expression is continuous everywhere by construction.
//  4. surfaceAt is computed analytically (exact ellipse / polygon edges) with the priority
//     OOB > water > bunker > green > fringe > tee > fairway > rough; sgrid caches it at 0.5 m.
//
// Local frames: at arc length s the frame is forward f = tangentAt(s) and right r = f x z-up =
// (fy, -fx). Authored features use (s, off) with off + to the right, or green-relative [r, f]
// (r = right, f = forward/away from the tee) measured from the green centre.

import { SURF } from './constants.js';
import { smoothstep } from './vec3.js';
import { fbm2, valueNoise2 } from './noise.js';
import { buildPath } from './spline.js';
import { mulberry32 } from './rng.js';

const DEG = Math.PI / 180;
const FIELD_STEP = 2; // (s, lat, elevation) field spacing, m
const STAKE_GAP = 12; // m between OOB stakes
const LIP_W = 2; // m, width of the raised ring round a bunker (keep bunkers >= fringe + LIP_W off greens)

// ---------------------------------------------------------------------------------------------
// Small helpers

// Monotone cubic Hermite (Fritsch-Carlson) through [[s, z], ...]; zero slope at both ends and
// constant beyond them, so the elevation never overshoots the authored heights.
export function makeProfile(pts) {
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const n = xs.length;
  if (n === 1) return () => ys[0];
  const d = [];
  for (let k = 0; k < n - 1; k++) d.push((ys[k + 1] - ys[k]) / (xs[k + 1] - xs[k]));
  const m = new Array(n).fill(0);
  for (let k = 1; k < n - 1; k++) m[k] = d[k - 1] * d[k] <= 0 ? 0 : (d[k - 1] + d[k]) / 2;
  for (let k = 0; k < n - 1; k++) {
    if (d[k] === 0) {
      m[k] = 0;
      m[k + 1] = 0;
      continue;
    }
    const a = m[k] / d[k];
    const b = m[k + 1] / d[k];
    const h = a * a + b * b;
    if (h > 9) {
      const t = 3 / Math.sqrt(h);
      m[k] = t * a * d[k];
      m[k + 1] = t * b * d[k];
    }
  }
  return (s) => {
    if (s <= xs[0]) return ys[0];
    if (s >= xs[n - 1]) return ys[n - 1];
    let k = 0;
    while (k < n - 2 && s > xs[k + 1]) k++;
    const h = xs[k + 1] - xs[k];
    const t = (s - xs[k]) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[k] + (t3 - 2 * t2 + t) * h * m[k] + (-2 * t3 + 3 * t2) * ys[k + 1] + (t3 - t2) * h * m[k + 1];
  };
}

// Piecewise-linear lookup in [[s, v], ...], clamped at the ends.
function interpTable(tab, s, dflt) {
  if (!tab || !tab.length) return dflt;
  if (typeof tab === 'number') return tab;
  if (s <= tab[0][0]) return tab[0][1];
  for (let i = 1; i < tab.length; i++) {
    if (s <= tab[i][0]) {
      const t = (s - tab[i - 1][0]) / (tab[i][0] - tab[i - 1][0]);
      return tab[i - 1][1] + (tab[i][1] - tab[i - 1][1]) * t;
    }
  }
  return tab[tab.length - 1][1];
}

// Frame at arc length s, origin shifted `off` metres to the right.
function frameAt(path, s, off = 0) {
  const p = path.pointAt(s);
  const t = path.tangentAt(s);
  return { x: p.x + t.y * off, y: p.y - t.x * off, fx: t.x, fy: t.y, rx: t.y, ry: -t.x };
}

const toWorld = (fr, r, f) => ({ x: fr.x + fr.rx * r + fr.fx * f, y: fr.y + fr.ry * r + fr.fy * f });

// Ellipse [r, f, rx, ry, rotDeg] in a frame: rx is the semi-axis along the frame's right vector
// rotated counter-clockwise (seen from above) by rotDeg; ry is perpendicular to it.
function makeEllipse(fr, spec) {
  const [r, f, rx, ry, rot = 0] = spec;
  const c = toWorld(fr, r, f);
  const ang = Math.atan2(fr.ry, fr.rx) + rot * DEG;
  return { cx: c.x, cy: c.y, rx, ry, ang, ca: Math.cos(ang), sa: Math.sin(ang), R: Math.max(rx, ry) };
}

// Normalised ellipse radius: < 1 inside.
function ellQ(e, x, y) {
  const dx = x - e.cx;
  const dy = y - e.cy;
  const u = (dx * e.ca + dy * e.sa) / e.rx;
  const v = (-dx * e.sa + dy * e.ca) / e.ry;
  return Math.sqrt(u * u + v * v);
}

// Radial signed distance to the ellipse edge (exact for circles, close for mild ellipses):
// the distance from the point to the edge along the ray from the centre. Negative inside.
function ellSd(e, x, y) {
  const dx = x - e.cx;
  const dy = y - e.cy;
  const q = ellQ(e, x, y);
  if (q < 1e-9) return -Math.min(e.rx, e.ry);
  return Math.hypot(dx, dy) * (1 - 1 / q);
}

function pointInPoly(poly, x, y) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

// Signed distance to a polygon (negative inside).
function polySd(poly, x, y) {
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j];
    const b = poly[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    let t = l2 > 0 ? ((x - a.x) * dx + (y - a.y) * dy) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ex = a.x + dx * t - x;
    const ey = a.y + dy * t - y;
    const d = ex * ex + ey * ey;
    if (d < best) best = d;
  }
  const d = Math.sqrt(best);
  return pointInPoly(poly, x, y) ? -d : d;
}

function bboxOf(pts, pad) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
}

const inBox = (b, x, y) => x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY;

// Separable box blur (radius r, in place via a scratch row) on an nx*ny field.
function boxBlur(src, nx, ny, r) {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += src[y * nx + Math.min(nx - 1, Math.max(0, x + k))];
      tmp[y * nx + x] = sum / (2 * r + 1);
    }
  }
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += tmp[Math.min(ny - 1, Math.max(0, y + k)) * nx + x];
      out[y * nx + x] = sum / (2 * r + 1);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------

export function buildHole(def, { pinIndex = 0, seed = 1 } = {}) {
  const nseed = (def.n || 1) * 1013 + 7; // terrain shape is part of the design: fixed per hole
  const path = buildPath(def.path);
  const L = path.length;
  const prof = makeProfile(def.elev && def.elev.length ? def.elev : [[0, 0]]);

  // ---- bounds (integer-aligned so the 1 m grid and the 2 m field share nodes) ----
  const margin = (def.bounds && def.bounds.margin) || 70;
  const pathPts = [];
  for (let s = 0; s <= L; s += 5) pathPts.push(path.pointAt(s));
  pathPts.push(path.pointAt(L));
  const bb = bboxOf(pathPts, margin);
  const minX = Math.floor(bb.minX);
  const minY = Math.floor(bb.minY);
  const maxX = Math.ceil(bb.maxX);
  const maxY = Math.ceil(bb.maxY);
  const bounds = { minX, minY, maxX, maxY };

  // ---- 2 m field: s, lat, base elevation ----
  const nx2 = Math.ceil((maxX - minX) / FIELD_STEP) + 1;
  const ny2 = Math.ceil((maxY - minY) / FIELD_STEP) + 1;
  const S2 = new Float32Array(nx2 * ny2);
  const L2 = new Float32Array(nx2 * ny2);
  const Eraw = new Float32Array(nx2 * ny2);
  const D2 = new Float32Array(nx2 * ny2);
  const pr = { s: 0, lat: 0, dist: 0 };
  for (let j = 0; j < ny2; j++) {
    for (let i = 0; i < nx2; i++) {
      const k = j * nx2 + i;
      path.projectInto(minX + i * FIELD_STEP, minY + j * FIELD_STEP, pr);
      S2[k] = pr.s;
      L2[k] = pr.lat;
      Eraw[k] = prof(pr.s);
      D2[k] = pr.dist;
    }
  }
  const Eblur = boxBlur(boxBlur(Eraw, nx2, ny2, 4), nx2, ny2, 4);
  const E2 = new Float32Array(nx2 * ny2);
  for (let k = 0; k < E2.length; k++) E2[k] = Eraw[k] + (Eblur[k] - Eraw[k]) * smoothstep(25, 50, D2[k]);

  const fs = { s: 0, lat: 0, e: 0 };
  function fieldAt(x, y, out, withE) {
    let fx = (x - minX) / FIELD_STEP;
    let fy = (y - minY) / FIELD_STEP;
    fx = fx < 0 ? 0 : fx > nx2 - 1 ? nx2 - 1 : fx;
    fy = fy < 0 ? 0 : fy > ny2 - 1 ? ny2 - 1 : fy;
    const ix = Math.min(nx2 - 2, Math.floor(fx));
    const iy = Math.min(ny2 - 2, Math.floor(fy));
    const tx = fx - ix;
    const ty = fy - iy;
    const k = iy * nx2 + ix;
    const w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty), w01 = (1 - tx) * ty, w11 = tx * ty;
    out.s = S2[k] * w00 + S2[k + 1] * w10 + S2[k + nx2] * w01 + S2[k + nx2 + 1] * w11;
    out.lat = L2[k] * w00 + L2[k + 1] * w10 + L2[k + nx2] * w01 + L2[k + nx2 + 1] * w11;
    if (withE) out.e = E2[k] * w00 + E2[k + 1] * w10 + E2[k + nx2] * w01 + E2[k + nx2 + 1] * w11;
    return out;
  }

  // ---- tee box ----
  const tdef = def.tee || {};
  const teeS = tdef.s || 0;
  const teeF = frameAt(path, teeS, tdef.off || 0);
  const teeHW = (tdef.w || 8) / 2;
  const teeHL = (tdef.l || 14) / 2;
  const teeZ = prof(teeS) + (tdef.raise == null ? 0.4 : tdef.raise);
  function teeOutside(x, y) {
    const dx = x - teeF.x;
    const dy = y - teeF.y;
    const u = Math.abs(dx * teeF.rx + dy * teeF.ry) - teeHW;
    const v = Math.abs(dx * teeF.fx + dy * teeF.fy) - teeHL;
    return Math.hypot(Math.max(u, 0), Math.max(v, 0)) + Math.min(Math.max(u, v), 0);
  }

  // ---- green (analytic) ----
  const gd = def.green;
  const gF = frameAt(path, L);
  const gE = makeEllipse(gF, [0, 0, gd.rx, gd.ry, gd.rot || 0]);
  const fringe = gd.fringe == null ? 1.2 : gd.fringe;
  const gZ = prof(L) + (gd.raise || 0);
  const gSlopeDir = ((gd.slope ? gd.slope[0] : 270) * DEG);
  const gSlope = (gd.slope ? gd.slope[1] : 1) / 100;
  const gsr = Math.cos(gSlopeDir) * gSlope;
  const gsf = Math.sin(gSlopeDir) * gSlope;
  const tiers = (gd.tiers || []).map((t) => ({ c: Math.cos(t.angle * DEG), s: Math.sin(t.angle * DEG), at: t.at || 0, h: t.h, w: t.w || 5 }));
  const bumps = gd.bumps || [];
  // Green height in the green frame (r right, f forward). Plane falls toward slope[0] (degrees,
  // 0 = right, 90 = back of the green, 270 = front), tiers step up by h across a band of half width
  // w along their angle, bumps are Gaussians [r, f, radius, h].
  function greenZ(x, y) {
    const dx = x - gF.x;
    const dy = y - gF.y;
    const r = dx * gF.rx + dy * gF.ry;
    const f = dx * gF.fx + dy * gF.fy;
    let z = gZ - (r * gsr + f * gsf);
    for (const t of tiers) z += t.h * (smoothstep(t.at - t.w, t.at + t.w, r * t.c + f * t.s) - 0.5);
    for (const b of bumps) {
      const er = r - b[0];
      const ef = f - b[1];
      z += b[3] * Math.exp(-(er * er + ef * ef) / (b[2] * b[2]));
    }
    return z;
  }
  const gBoxM = { minX: gF.x - gE.R - fringe - 4, minY: gF.y - gE.R - fringe - 4, maxX: gF.x + gE.R + fringe + 4, maxY: gF.y + gE.R + fringe + 4 };
  const gBoxW = { minX: gF.x - gE.R - fringe - 16, minY: gF.y - gE.R - fringe - 16, maxX: gF.x + gE.R + fringe + 16, maxY: gF.y + gE.R + fringe + 16 };
  // Blend of the green into its surroundings (w) and the analytic-correction mask (m). w stays 1
  // for 2.5 m beyond m's support so every grid node around an m == 1 point is pure green.
  const greenW = (sd) => 1 - smoothstep(fringe + 3, fringe + 12, sd);
  const greenM = (sd) => 1 - smoothstep(fringe + 0.5, fringe + 2.5, sd);

  const pinSpecs = gd.pins && gd.pins.length ? gd.pins : [[0, 0]];
  const pinsWorld = pinSpecs.map((p) => toWorld(gF, p[0], p[1]));

  // ---- fairways: precomputed left/right edges (lat) per metre of s ----
  const fwDefs = Array.isArray(def.fairway) ? def.fairway : def.fairway ? [def.fairway] : [];
  const fairways = fwDefs.map((fw, idx) => {
    const n = Math.ceil(fw.to - fw.from) + 2;
    const Le = new Float32Array(n);
    const Re = new Float32Array(n);
    const wob = fw.wobble == null ? 2 : fw.wobble;
    for (let k = 0; k < n; k++) {
      const s = fw.from + k;
      const hw = interpTable(fw.width, s, 30) / 2;
      const cap = Math.min(hw, 14);
      let f = 1;
      const a = s - fw.from;
      const b = fw.to - s;
      if (a < cap) f = Math.sqrt(Math.max(0, 1 - ((cap - a) / cap) ** 2));
      if (b < cap) f = Math.min(f, Math.sqrt(Math.max(0, 1 - ((cap - b) / cap) ** 2)));
      const wl = wob * (valueNoise2(s / 15, 3.7 + idx * 13, nseed) - 0.5) * 2;
      const wr = wob * (valueNoise2(s / 15, 9.1 + idx * 13, nseed) - 0.5) * 2;
      const sh = interpTable(fw.shift, s, 0);
      Le[k] = sh - Math.max(0, hw + wl) * f;
      Re[k] = sh + Math.max(0, hw + wr) * f;
    }
    return { from: fw.from, to: fw.to, n, Le, Re };
  });
  function inFairway(s, lat) {
    for (const fw of fairways) {
      if (s < fw.from || s > fw.to) continue;
      const f = s - fw.from;
      const k = Math.min(fw.n - 2, Math.floor(f));
      const t = f - k;
      const l = fw.Le[k] + (fw.Le[k + 1] - fw.Le[k]) * t;
      const r = fw.Re[k] + (fw.Re[k + 1] - fw.Re[k]) * t;
      if (lat >= l && lat <= r) return true;
    }
    return false;
  }

  // ---- out of bounds lines ----
  const ob = def.ob || {};
  const obL = ob.left == null ? null : ob.left;
  const obR = ob.right == null ? null : ob.right;
  const obFrom = ob.from == null ? -Infinity : ob.from;
  const obTo = ob.to == null ? Infinity : ob.to;
  const oobSL = (s, lat) => s >= obFrom && s <= obTo && ((obL !== null && lat < -obL) || (obR !== null && lat > obR));

  // ---- water: polygons authored in (s, off); level relative to the base elevation ----
  const waters = (def.water || []).map((w) => {
    const poly = w.xy
      ? w.xy.map(([x, y]) => ({ x, y }))
      : w.poly.map(([s, off]) => {
        const f = frameAt(path, s, off);
        return { x: f.x, y: f.y };
      });
    const cx = poly.reduce((a, p) => a + p.x, 0) / poly.length;
    const cy = poly.reduce((a, p) => a + p.y, 0) / poly.length;
    const sRef = w.xy ? path.project(cx, cy).s : w.poly.reduce((a, p) => a + p[0], 0) / w.poly.length;
    const level = prof(Math.min(L, Math.max(0, sRef))) + w.level;
    const bank = w.bank || 10;
    return { kind: w.kind || 'red', level, poly, bank, depth: w.depth || 1.4, box: bboxOf(poly, 0), bankBox: bboxOf(poly, bank + 1) };
  });

  // ---- bunkers: unions of ellipses, (s, off) anchored or green-relative (g:[r, f]) ----
  const bunkers = (def.bunkers || []).map((b) => {
    const fr = b.g ? (() => {
      const p = toWorld(gF, b.g[0], b.g[1]);
      return { ...gF, x: p.x, y: p.y };
    })() : frameAt(path, b.s, b.off || 0);
    const ells = b.shape.map((sp) => makeEllipse(fr, sp));
    let minR = Infinity;
    for (const e of ells) minR = Math.min(minR, e.rx, e.ry);
    const pts = [];
    for (const e of ells) pts.push({ x: e.cx - e.R, y: e.cy - e.R }, { x: e.cx + e.R, y: e.cy + e.R });
    const depth = b.depth || 0.7;
    return { ells, depth, ramp: Math.min(1.8, 0.6 * minR), lip: 0.12 + 0.2 * depth, box: bboxOf(pts, 0), lipBox: bboxOf(pts, LIP_W + 0.5) };
  });
  function bunkerSd(b, x, y) {
    let sd = Infinity;
    for (const e of b.ells) {
      const d = ellSd(e, x, y);
      if (d < sd) sd = d;
    }
    return sd;
  }

  // ---- mounds [s, off, radius, height] ----
  const mounds = (def.mounds || []).map(([s, off, r, h]) => {
    const f = frameAt(path, s, off);
    return { x: f.x, y: f.y, r, h };
  });

  // ---- surface classification (exact edges) ----
  function surfaceAt(x, y) {
    if (x < minX || x > maxX || y < minY || y > maxY) return SURF.OOB;
    fieldAt(x, y, fs, false);
    if (oobSL(fs.s, fs.lat)) return SURF.OOB;
    for (const w of waters) if (inBox(w.box, x, y) && pointInPoly(w.poly, x, y)) return SURF.WATER;
    for (const b of bunkers) {
      if (!inBox(b.box, x, y)) continue;
      for (const e of b.ells) if (ellQ(e, x, y) < 1) return SURF.BUNKER;
    }
    if (inBox(gBoxM, x, y)) {
      if (ellQ(gE, x, y) <= 1) return SURF.GREEN;
      if (ellSd(gE, x, y) <= fringe) return SURF.FRINGE;
    }
    if (teeOutside(x, y) <= 0) return SURF.TEE;
    if (inFairway(fs.s, fs.lat)) return SURF.FAIRWAY;
    return SURF.ROUGH;
  }
  function isOOB(x, y) {
    if (x < minX || x > maxX || y < minY || y > maxY) return true;
    fieldAt(x, y, fs, false);
    return oobSL(fs.s, fs.lat);
  }
  function waterAt(x, y) {
    for (const w of waters) if (inBox(w.box, x, y) && pointInPoly(w.poly, x, y)) return { kind: w.kind, level: w.level };
    return null;
  }

  // ---- 1 m height grid ----
  const nx = maxX - minX + 1;
  const ny = maxY - minY + 1;
  const heights = new Float32Array(nx * ny);
  const und = def.undulate == null ? 0.6 : def.undulate;
  const cor = def.corridor || {};
  const corW = cor.w == null ? 45 : cor.w;
  const corH = cor.h == null ? 5 : cor.h;
  const fb4 = { oct: 4, seed: nseed + 1 };
  const fb2 = { oct: 2, seed: nseed + 5 };
  for (let iy = 0; iy < ny; iy++) {
    const y = minY + iy;
    for (let ix = 0; ix < nx; ix++) {
      const x = minX + ix;
      fieldAt(x, y, fs, true);
      const s = fs.s;
      const ds = s < 0 ? s : s > L ? s - L : 0;
      const d = Math.sqrt(fs.lat * fs.lat + ds * ds);
      let z = fs.e;
      // Corridor hills: the land rises beyond the playing corridor and wraps round both ends.
      if (d > corW) z += corH * smoothstep(corW, corW + 60, d) * (0.5 + fbm2(x / 110, y / 110, fb2));
      // Rolling undulation plus a fine ripple.
      z += und * (fbm2(x / 45, y / 45, fb4) - 0.5) * 2.4 + 0.08 * (valueNoise2(x / 7, y / 7, nseed + 2) - 0.5) * 2;
      for (const m of mounds) {
        const dx = x - m.x;
        const dy = y - m.y;
        const q = (dx * dx + dy * dy) / (m.r * m.r);
        if (q < 1) z += m.h * (1 - q) * (1 - q);
      }
      // Flattened, slightly raised tee box with soft shoulders.
      const to = teeOutside(x, y);
      if (to < 4) z += (teeZ - z) * (1 - smoothstep(0, 4, to));
      // Blend into the analytic green.
      if (inBox(gBoxW, x, y)) {
        const w = greenW(ellSd(gE, x, y));
        if (w > 0) z += (greenZ(x, y) - z) * w;
      }
      // Water: bed below the level inside, banks easing back to the terrain outside.
      for (const w of waters) {
        if (!inBox(w.bankBox, x, y)) continue;
        const sd = polySd(w.poly, x, y);
        if (sd < 0) z = w.level - w.depth * smoothstep(0, 7, -sd);
        else if (sd < w.bank) {
          const zb = w.level + 0.12 * sd;
          z = zb + (z - zb) * smoothstep(0, w.bank, sd);
        }
      }
      // Bunkers: bowl of the given depth, raised lip ring just outside.
      for (const b of bunkers) {
        if (!inBox(b.lipBox, x, y)) continue;
        const sd = bunkerSd(b, x, y);
        if (sd < 0) z -= b.depth * smoothstep(0, b.ramp, -sd);
        else if (sd < LIP_W) {
          const t = sd / LIP_W;
          z += b.lip * 4 * t * (1 - t);
        }
      }
      heights[iy * nx + ix] = z;
    }
  }

  function bilinear(x, y) {
    let fx = x - minX;
    let fy = y - minY;
    fx = fx < 0 ? 0 : fx > nx - 1 ? nx - 1 : fx;
    fy = fy < 0 ? 0 : fy > ny - 1 ? ny - 1 : fy;
    const ix = Math.min(nx - 2, Math.floor(fx));
    const iy = Math.min(ny - 2, Math.floor(fy));
    const tx = fx - ix;
    const ty = fy - iy;
    const k = iy * nx + ix;
    const a = heights[k] + (heights[k + 1] - heights[k]) * tx;
    const b = heights[k + nx] + (heights[k + nx + 1] - heights[k + nx]) * tx;
    return a + (b - a) * ty;
  }
  // Bilinear interpolation of the analytic green function over the same grid cell.
  function bilinearGreen(x, y) {
    let fx = x - minX;
    let fy = y - minY;
    fx = fx < 0 ? 0 : fx > nx - 1 ? nx - 1 : fx;
    fy = fy < 0 ? 0 : fy > ny - 1 ? ny - 1 : fy;
    const ix = Math.min(nx - 2, Math.floor(fx));
    const iy = Math.min(ny - 2, Math.floor(fy));
    const tx = fx - ix;
    const ty = fy - iy;
    const x0 = minX + ix;
    const y0 = minY + iy;
    const a = greenZ(x0, y0) + (greenZ(x0 + 1, y0) - greenZ(x0, y0)) * tx;
    const b = greenZ(x0, y0 + 1) + (greenZ(x0 + 1, y0 + 1) - greenZ(x0, y0 + 1)) * tx;
    return a + (b - a) * ty;
  }

  function heightAt(x, y) {
    const h = bilinear(x, y);
    if (!inBox(gBoxM, x, y)) return h;
    const m = greenM(ellSd(gE, x, y));
    if (m <= 0) return h;
    return h + m * (greenZ(x, y) - bilinearGreen(x, y));
  }

  // Central differences (2 cm baseline): exact for the analytic green to ~1e-6 and the true
  // derivative inside each bilinear cell.
  const GE = 0.01;
  function gradAt(x, y, out = { x: 0, y: 0 }) {
    out.x = (heightAt(x + GE, y) - heightAt(x - GE, y)) / (2 * GE);
    out.y = (heightAt(x, y + GE) - heightAt(x, y - GE)) / (2 * GE);
    return out;
  }
  const gtmp = { x: 0, y: 0 };
  function normalAt(x, y, out = { x: 0, y: 0, z: 1 }) {
    gradAt(x, y, gtmp);
    const l = Math.hypot(gtmp.x, gtmp.y, 1);
    out.x = -gtmp.x / l;
    out.y = -gtmp.y / l;
    out.z = 1 / l;
    return out;
  }

  // ---- surface grid (0.5 m cells; cell (i, j) covers [minX + i*0.5, minX + (i+1)*0.5) and holds
  //      the surface at its centre) ----
  const sstep = 0.5;
  const snx = Math.ceil((maxX - minX) / sstep);
  const sny = Math.ceil((maxY - minY) / sstep);
  const sdata = new Uint8Array(snx * sny);
  for (let j = 0; j < sny; j++) {
    const y = minY + (j + 0.5) * sstep;
    for (let i = 0; i < snx; i++) sdata[j * snx + i] = surfaceAt(minX + (i + 0.5) * sstep, y);
  }

  // ---- trees ----
  const rng = mulberry32(((def.n || 1) * 0x9e3779b1) ^ (seed >>> 0) ^ 0x5bd1e995);
  const trees = [];
  const HC = 8; // spatial-hash cell, m
  const hnx = Math.ceil((maxX - minX) / HC) + 1;
  const hny = Math.ceil((maxY - minY) / HC) + 1;
  const hash = Array.from({ length: hnx * hny }, () => []);
  let maxCanopy = 0;
  const NOGROW = new Set([SURF.WATER, SURF.BUNKER, SURF.FAIRWAY, SURF.GREEN, SURF.FRINGE, SURF.TEE]);
  const NOSHADE = new Set([SURF.FAIRWAY, SURF.GREEN, SURF.FRINGE, SURF.TEE]);
  function cellsAround(x, y, r, fn) {
    const i0 = Math.max(0, Math.floor((x - r - minX) / HC));
    const i1 = Math.min(hnx - 1, Math.floor((x + r - minX) / HC));
    const j0 = Math.max(0, Math.floor((y - r - minY) / HC));
    const j1 = Math.min(hny - 1, Math.floor((y + r - minY) / HC));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (fn(hash[j * hnx + i]) === false) return;
  }
  function tryTree(x, y, mix) {
    if (x < minX + 2 || x > maxX - 2 || y < minY + 2 || y > maxY - 2) return false;
    const pine = rng() < mix;
    const t = pine
      ? { trunkR: 0.2 + rng() * 0.12, trunkH: 2.4 + rng() * 1.6, rx: 2 + rng() * 1.3, rz: 5 + rng() * 3 }
      : { trunkR: 0.28 + rng() * 0.18, trunkH: 2.6 + rng() * 1.4, rx: 3.4 + rng() * 2.4, rz: 3.4 + rng() * 2 };
    if (NOGROW.has(surfaceAt(x, y))) return false;
    const c = Math.max(2, t.rx * 0.75);
    for (const [ox, oy] of [[c, 0], [-c, 0], [0, c], [0, -c]]) if (NOSHADE.has(surfaceAt(x + ox, y + oy))) return false;
    let clash = false;
    cellsAround(x, y, 8, (cell) => {
      for (const o of cell) {
        if (Math.hypot(o.x - x, o.y - y) < 0.55 * (o.canopy.rx + t.rx)) {
          clash = true;
          return false;
        }
      }
      return true;
    });
    if (clash) return false;
    const z = heightAt(x, y);
    const tree = {
      x, y, z,
      trunkR: t.trunkR,
      trunkH: t.trunkH,
      canopy: { cz: z + t.trunkH + t.rz * 0.8, rx: t.rx, rz: t.rz },
      kind: pine ? 'pine' : 'broad',
    };
    trees.push(tree);
    hash[Math.floor((y - minY) / HC) * hnx + Math.floor((x - minX) / HC)].push(tree);
    if (t.rx > maxCanopy) maxCanopy = t.rx;
    return true;
  }
  for (const td of def.trees || []) {
    const mix = td.mix == null ? 0.5 : td.mix;
    if (td.cluster) {
      const c = frameAt(path, td.s, td.off);
      const spread = td.spread || 8;
      for (let k = 0; k < td.cluster * 3 && k < 200; k++) {
        const a = rng() * Math.PI * 2;
        const r = spread * Math.sqrt(rng());
        tryTree(c.x + Math.cos(a) * r, c.y + Math.sin(a) * r, mix);
        if (trees.filter((t) => Math.hypot(t.x - c.x, t.y - c.y) <= spread + 0.01).length >= td.cluster) break;
      }
    } else {
      const gap = td.gap || 10;
      const jit = td.jitter == null ? 3 : td.jitter;
      for (let s = td.from; s <= td.to; s += gap * (0.75 + 0.5 * rng())) {
        const f = frameAt(path, s + (rng() - 0.5) * jit, td.off + (rng() * 2 - 1) * jit);
        tryTree(f.x, f.y, mix);
      }
    }
  }
  // Background woodland: jittered grid, clumped by noise, only well outside the playing corridor.
  const forest = def.forest === false ? null : { inner: 42, density: 0.75, mix: 0.5, spacing: 10, ...(def.forest || {}) };
  if (forest) {
    const sp = forest.spacing;
    for (let y0 = minY; y0 < maxY; y0 += sp) {
      for (let x0 = minX; x0 < maxX; x0 += sp) {
        const x = x0 + rng() * sp;
        const y = y0 + rng() * sp;
        const keep = rng();
        fieldAt(x, y, fs, false);
        const ds = fs.s < 0 ? fs.s : fs.s > L ? fs.s - L : 0;
        const d = Math.hypot(fs.lat, ds);
        const clump = valueNoise2(x / 40, y / 40, nseed + 9);
        const p = forest.density * smoothstep(forest.inner, forest.inner + 25, d) * (clump > 0.45 ? 1 : 0.2);
        if (keep < p) tryTree(x, y, forest.mix);
      }
    }
  }
  function treesNear(x, y, r) {
    const res = [];
    cellsAround(x, y, r + maxCanopy, (cell) => {
      for (const t of cell) if (Math.hypot(t.x - x, t.y - y) <= r + t.canopy.rx) res.push(t);
    });
    return res;
  }

  // ---- OOB stakes every ~12 m along each OB line ----
  const stakes = [];
  for (const [lim, sign] of [[obL, -1], [obR, 1]]) {
    if (lim === null) continue;
    const s0 = Math.max(obFrom, -margin);
    const s1 = Math.min(obTo, L + margin);
    let prev = null;
    let acc = STAKE_GAP;
    for (let s = s0; s <= s1; s += 0.5) {
      const f = frameAt(path, s, sign * lim);
      if (prev) acc += Math.hypot(f.x - prev.x, f.y - prev.y);
      prev = f;
      if (acc >= STAKE_GAP && f.x > minX && f.x < maxX && f.y > minY && f.y < maxY) {
        stakes.push({ x: f.x, y: f.y, z: heightAt(f.x, f.y) });
        acc = 0;
      }
    }
  }

  // ---- key points ----
  const pin = pinsWorld[((pinIndex % pinsWorld.length) + pinsWorld.length) % pinsWorld.length];
  const cup = { x: pin.x, y: pin.y, z: heightAt(pin.x, pin.y) };
  const tee = { x: teeF.x, y: teeF.y, z: heightAt(teeF.x, teeF.y) };
  const greenCenter = { x: gF.x, y: gF.y, z: heightAt(gF.x, gF.y) };

  // Dogleg corners (arc lengths): authored, else interior control points that turn > 10 degrees.
  let corners = def.corners;
  if (!corners) {
    corners = [];
    const P = def.path;
    for (let i = 1; i < P.length - 1; i++) {
      const a1 = Math.atan2(P[i][1] - P[i - 1][1], P[i][0] - P[i - 1][0]);
      const a2 = Math.atan2(P[i + 1][1] - P[i][1], P[i + 1][0] - P[i][0]);
      let da = Math.abs(a2 - a1);
      if (da > Math.PI) da = 2 * Math.PI - da;
      if (da > 10 * DEG) corners.push(path.project(P[i][0], P[i][1]).s);
    }
  }
  corners = corners.slice().sort((a, b) => a - b);

  // Default target. Within ~235 m of the cup: the cup. Otherwise the next dogleg corner ahead if it
  // is within ~260 m; if that corner is out of reach, the centreline point ~245 m away (short of
  // the corner); with no corner left ahead, the cup.
  function aimPoint(from) {
    const dCup = Math.hypot(cup.x - from.x, cup.y - from.y);
    if (dCup <= 235) return { x: cup.x, y: cup.y };
    const s0 = path.project(from.x, from.y).s;
    for (const sc of corners) {
      if (sc <= s0 + 40 || sc >= L - 30) continue;
      const c = path.pointAt(sc);
      if (Math.hypot(c.x - from.x, c.y - from.y) <= 260) return { x: c.x, y: c.y };
      let s = Math.max(0, s0);
      while (s < sc) {
        const p = path.pointAt(s);
        if (Math.hypot(p.x - from.x, p.y - from.y) >= 245) return { x: p.x, y: p.y };
        s += 2;
      }
      return { x: c.x, y: c.y };
    }
    return { x: cup.x, y: cup.y };
  }

  // Terrain ray intersection: adaptive march (step half the height above ground) then bisection.
  // dir need not be unit; t is in units of dir, the hit point is origin + dir * t.
  function raycast(o, d, maxT = 3000) {
    const dl = Math.hypot(d.x, d.y, d.z) || 1;
    const above = (t) => o.z + d.z * t - heightAt(o.x + d.x * t, o.y + d.y * t);
    let t = 0;
    let f = above(0);
    if (f <= 0) return { x: o.x, y: o.y, z: heightAt(o.x, o.y), t: 0 };
    while (t < maxT) {
      const step = Math.min(10, Math.max(0.2, f * 0.5)) / dl;
      const t1 = Math.min(maxT, t + step);
      const f1 = above(t1);
      if (f1 <= 0) {
        let a = t;
        let b = t1;
        for (let k = 0; k < 24; k++) {
          const mid = (a + b) / 2;
          if (above(mid) > 0) a = mid;
          else b = mid;
        }
        const x = o.x + d.x * b;
        const y = o.y + d.y * b;
        return { x, y, z: heightAt(x, y), t: b };
      }
      if (t1 >= maxT) break;
      t = t1;
      f = f1;
    }
    return null;
  }

  return {
    n: def.n, par: def.par, name: def.name, si: def.si,
    lengthM: L,
    bounds,
    tee, cup, greenCenter,
    // rot: world angle (radians, counter-clockwise from +x) of the rx semi-axis.
    green: { cx: gF.x, cy: gF.y, rx: gd.rx, ry: gd.ry, rot: gE.ang, fringe },
    pins: pinsWorld.map((p) => ({ x: p.x, y: p.y, z: heightAt(p.x, p.y) })),
    pinIndex,
    path,
    corners,
    heightAt, gradAt, normalAt,
    surfaceAt, isOOB, waterAt,
    waters: waters.map((w) => ({ kind: w.kind, level: w.level, poly: w.poly })),
    trees, treesNear,
    stakes,
    raycast, aimPoint,
    grid: { nx, ny, minX, minY, step: 1, heights },
    sgrid: { nx: snx, ny: sny, minX, minY, step: sstep, data: sdata },
  };
}
