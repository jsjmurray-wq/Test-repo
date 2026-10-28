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
//     OOB > water > bunker > green > fringe > tee > areas > fairway > rough > outside; sgrid caches
//     it at 0.5 m.
//  5. Trees and objects (palms, saguaros, shrubs, gorse, rocks) are scattered from authored rows,
//     clusters and area densities with a seeded rng; dune grass goes to the visual-only `decor`.
//
// Version 2 (themed courses, docs/architecture.md section 8.2), all optional in a HoleDef:
//  * outside: 'rough'|'desert'|'fescue'|'waste'|'water' is what lies beyond the playing corridor,
//    i.e. beyond rough.w m (default 18) of rough round the fairways, rough.tee (default min(w, 8))
//    round the tee and rough.green (default w) round the green and fringe. The corridor edge
//    wanders by rough.wobble m (default 2.5); rough.relief m (default by kind) of extra small-scale
//    relief roughens the ground outside it. Distances to the fairways come from an exact Euclidean
//    distance transform of the fairway mask on the 1 m grid, so the edge is continuous round doglegs.
//  * outside: 'water' floods everything outside the corridor (and outside non-water areas) to
//    outsideWater {kind:'red', level:-1.2 (relative to the lowest centreline elevation), depth:2,
//    bank:8, sea:false}.
//  * water[].fill: 'outside' floods everything outside its polygon instead (island greens). Several
//    such entries together form an archipelago: a point is water when it lies outside all of their
//    polygons (and off the corridor land of outside: 'water'); the first entry gives kind, level,
//    depth, bank and sea. water[].sea marks an ocean for the renderer.
//  * areas[] paint surfaces ('waste'|'desert'|'fescue'|'bunker'|'rough'|'fairway') over the fairway,
//    rough and outside (later areas over earlier ones; tee, green, bunkers and water still win),
//    with an optional height offset dz eased in over `ease` m (default 3).
//  * bunkers[].pot: a deep (1.2-1.8 m) round bunker (shape, or r) whose face toward the green is a
//    steep revetted wall (0.35 m ramp) and whose back is a gentler entry.
//  * objects[] scatter themed objects; trees rows with `mix` still work, and forest.kind may give
//    the background woodland a kind or weight map.
//
// Local frames: at arc length s the frame is forward f = tangentAt(s) and right r = f x z-up =
// (fy, -fx). Authored features use (s, off) with off + to the right, or green-relative [r, f]
// (r = right, f = forward/away from the tee) measured from the green centre.

import { SURF, DEFAULT_CONDITIONS } from './constants.js';
import { smoothstep } from './vec3.js';
import { fbm2, valueNoise2 } from './noise.js';
import { buildPath } from './spline.js';
import { mulberry32 } from './rng.js';

const DEG = Math.PI / 180;
const FIELD_STEP = 2; // (s, lat, elevation) field spacing, m
const STAKE_GAP = 12; // m between OOB stakes
const LIP_W = 2; // m, width of the raised ring round a bunker (keep bunkers >= fringe + LIP_W off greens)
const POT_FACE = 0.35; // m, ramp of a pot bunker's revetted face (the 1 m grid smooths it to ~55 deg)
// The 1 m height grid spreads a pot's face up to a grid cell outside its outline; that steep band
// (gradient over POT_STEEP within POT_BAND m of the outline) is still the pot's face, so it counts
// as BUNKER (physics plays the revetted wall there; bake.js paints it sod).
const POT_BAND = 1.1;
const POT_STEEP = 0.7;
const MAX_OBJECTS = 5000; // per hole, safety cap on scattered objects
const MAX_DECOR = 8000; // per hole, dune-grass tufts
// HoleDef names: `outside` values and `areas[].surface` values.
const SURF_BY_NAME = { rough: SURF.ROUGH, desert: SURF.DESERT, fescue: SURF.FESCUE, waste: SURF.WASTE, water: SURF.WATER };
const AREA_SURF = {
  waste: SURF.WASTE, desert: SURF.DESERT, fescue: SURF.FESCUE, bunker: SURF.BUNKER, rough: SURF.ROUGH, fairway: SURF.FAIRWAY,
};
// Default extra relief (m) of the ground outside the corridor: stony desert, fescue dunes.
const OUTSIDE_RELIEF = { [SURF.DESERT]: 0.3, [SURF.FESCUE]: 0.5, [SURF.WASTE]: 0.1 };

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

// Exact 1D squared Euclidean distance transform (Felzenszwalb & Huttenlocher) of f (0 on the
// feature, a huge value elsewhere), n samples with stride `stride` from `off`, in place.
function edt1d(a, off, stride, n, f, d, v, z) {
  for (let q = 0; q < n; q++) f[q] = a[off + q * stride];
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let sp = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (sp <= z[k]) {
      k--;
      sp = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = sp;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
  for (let q = 0; q < n; q++) a[off + q * stride] = d[q];
}

// Euclidean distance (grid units) from every node of an nx*ny mask (1 = feature) to the nearest
// feature node; Infinity-free (a mask with no feature gives 1e9).
function distanceTransform(mask, nx, ny) {
  const BIG = 1e18;
  const a = new Float64Array(nx * ny);
  for (let k = 0; k < a.length; k++) a[k] = mask[k] ? 0 : BIG;
  const m = Math.max(nx, ny);
  const f = new Float64Array(m);
  const d = new Float64Array(m);
  const v = new Int32Array(m);
  const z = new Float64Array(m + 1);
  for (let j = 0; j < ny; j++) edt1d(a, j * nx, 1, nx, f, d, v, z);
  for (let i = 0; i < nx; i++) edt1d(a, i, nx, ny, f, d, v, z);
  const out = new Float32Array(nx * ny);
  for (let k = 0; k < a.length; k++) out[k] = a[k] >= BIG ? 1e9 : Math.sqrt(a[k]);
  return out;
}

// Weighted pick from a kind spec: a string, or a weight map such as {palm: 0.7, broad: 0.3}.
function pickKind(spec, rng) {
  if (typeof spec === 'string') return spec;
  const keys = Object.keys(spec || {});
  if (!keys.length) return 'broad';
  let total = 0;
  for (const k of keys) total += Math.max(0, spec[k]);
  let r = rng() * total;
  for (const k of keys) {
    r -= Math.max(0, spec[k]);
    if (r < 0) return k;
  }
  return keys[keys.length - 1];
}

// ---------------------------------------------------------------------------------------------

export function buildHole(def, { pinIndex = 0, seed = 1, course = null } = {}) {
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
  // Radius of the tee box's bounding circle: anything further from its centre is off the box.
  const teeR = Math.hypot(teeHW, teeHL);
  const nearTee = (x, y, r) => Math.abs(x - teeF.x) <= teeR + r && Math.abs(y - teeF.y) <= teeR + r;
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

  // ---- grid size (1 m nodes) ----
  const nx = maxX - minX + 1;
  const ny = maxY - minY + 1;

  // ---- the playing corridor and what lies outside it (themed courses) ----
  const outsideSurf = SURF_BY_NAME[def.outside] || SURF.ROUGH;
  const rdef = def.rough || {};
  const roughW = rdef.w == null ? 18 : rdef.w;
  const roughTee = rdef.tee == null ? Math.min(roughW, 8) : rdef.tee;
  const roughGreen = rdef.green == null ? roughW : rdef.green;
  const edgeWob = rdef.wobble == null ? 2.5 : rdef.wobble;
  const relief = rdef.relief == null ? OUTSIDE_RELIEF[outsideSurf] || 0 : rdef.relief;
  const hasCorridor = outsideSurf !== SURF.ROUGH;
  // Signed distance (m, negative inside) to the playing corridor at every 1 m node: the fairways
  // grown by the rough band, the tee box and the green with its fringe grown by their own bands,
  // plus a wandering edge. The fairway distance is an exact Euclidean distance transform of the
  // fairway mask, so the edge stays continuous round doglegs (where the centreline projection
  // jumps between branches). Between nodes it is bilinear, one function for surfaces and heights.
  let corGrid = null;
  if (hasCorridor) {
    const mask = new Uint8Array(nx * ny);
    for (let iy = 0; iy < ny; iy++) {
      for (let ix = 0; ix < nx; ix++) {
        fieldAt(minX + ix, minY + iy, fs, false);
        if (inFairway(fs.s, fs.lat)) mask[iy * nx + ix] = 1;
      }
    }
    corGrid = distanceTransform(mask, nx, ny);
    for (let iy = 0; iy < ny; iy++) {
      const y = minY + iy;
      for (let ix = 0; ix < nx; ix++) {
        const x = minX + ix;
        const k = iy * nx + ix;
        let d = corGrid[k] - roughW;
        if (nearTee(x, y, roughTee + d)) {
          const dt = teeOutside(x, y) - roughTee;
          if (dt < d) d = dt;
        }
        const dg = ellSd(gE, x, y) - fringe - roughGreen;
        if (dg < d) d = dg;
        corGrid[k] = d + edgeWob * (valueNoise2(x / 14, y / 14, nseed + 21) - 0.5) * 2;
      }
    }
  }
  function corridorSd(x, y) {
    let fx = x - minX;
    let fy = y - minY;
    fx = fx < 0 ? 0 : fx > nx - 1 ? nx - 1 : fx;
    fy = fy < 0 ? 0 : fy > ny - 1 ? ny - 1 : fy;
    const ix = Math.min(nx - 2, Math.floor(fx));
    const iy = Math.min(ny - 2, Math.floor(fy));
    const tx = fx - ix;
    const ty = fy - iy;
    const k = iy * nx + ix;
    const a = corGrid[k] + (corGrid[k + 1] - corGrid[k]) * tx;
    const b = corGrid[k + nx] + (corGrid[k + nx + 1] - corGrid[k + nx]) * tx;
    return a + (b - a) * ty;
  }

  // ---- areas: free-form surface paint [{surface, shape (with s/off or g) | poly | xy, dz, ease}] ----
  const areas = (def.areas || []).map((a) => {
    const surf = AREA_SURF[a.surface] || SURF.WASTE;
    let ells = null;
    let poly = null;
    let box;
    if (a.shape) {
      const fr = a.g ? (() => {
        const p = toWorld(gF, a.g[0], a.g[1]);
        return { ...gF, x: p.x, y: p.y };
      })() : frameAt(path, a.s || 0, a.off || 0);
      ells = a.shape.map((sp) => makeEllipse(fr, sp));
      const pts = [];
      for (const e of ells) pts.push({ x: e.cx - e.R, y: e.cy - e.R }, { x: e.cx + e.R, y: e.cy + e.R });
      box = bboxOf(pts, 0);
    } else {
      poly = a.xy ? a.xy.map(([x, y]) => ({ x, y })) : (a.poly || []).map(([s0, off]) => {
        const f = frameAt(path, s0, off);
        return { x: f.x, y: f.y };
      });
      box = poly.length ? bboxOf(poly, 0) : { minX: 1, minY: 1, maxX: 0, maxY: 0 };
    }
    return { surf, ells, poly, box, dz: a.dz || 0, ease: a.ease == null ? 3 : Math.max(0.1, a.ease) };
  });
  function areaInside(a, x, y) {
    if (!inBox(a.box, x, y)) return false;
    if (a.ells) {
      for (const e of a.ells) if (ellQ(e, x, y) < 1) return true;
      return false;
    }
    return a.poly.length >= 3 && pointInPoly(a.poly, x, y);
  }
  function areaSd(a, x, y) {
    if (a.ells) {
      let sd = Infinity;
      for (const e of a.ells) {
        const d = ellSd(e, x, y);
        if (d < sd) sd = d;
      }
      return sd;
    }
    return a.poly.length >= 3 ? polySd(a.poly, x, y) : Infinity;
  }

  // ---- water: polygons authored in (s, off); level relative to the base elevation ----
  function waterPoly(w) {
    const poly = w.xy
      ? w.xy.map(([x, y]) => ({ x, y }))
      : w.poly.map(([s0, off]) => {
        const f = frameAt(path, s0, off);
        return { x: f.x, y: f.y };
      });
    const cx = poly.reduce((a, p) => a + p.x, 0) / poly.length;
    const cy = poly.reduce((a, p) => a + p.y, 0) / poly.length;
    const sRef = w.xy ? path.project(cx, cy).s : w.poly.reduce((a, p) => a + p[0], 0) / w.poly.length;
    return { poly, level: prof(Math.min(L, Math.max(0, sRef))) + (w.level == null ? -1.2 : w.level) };
  }
  const waters = (def.water || []).filter((w) => w.fill !== 'outside').map((w) => {
    const { poly, level } = waterPoly(w);
    const bank = w.bank || 10;
    return { kind: w.kind || 'red', level, poly, bank, depth: w.depth || 1.4, sea: !!w.sea, box: bboxOf(poly, 0), bankBox: bboxOf(poly, bank + 1) };
  });

  // ---- flooding: everything outside the islands (water fill:'outside') and, for outside:'water',
  //      outside the corridor and its non-water areas, is one body of water ----
  const fillDefs = (def.water || []).filter((w) => w.fill === 'outside');
  const islands = fillDefs.map((w) => {
    const { poly, level } = waterPoly(w);
    return { poly, level, box: bboxOf(poly, 0) };
  });
  const floodOutside = outsideSurf === SURF.WATER;
  const landAreas = floodOutside ? areas : [];
  let flood = null;
  if (fillDefs.length || floodOutside) {
    const w0 = fillDefs[0] || def.outsideWater || {};
    let level;
    if (fillDefs.length) level = islands[0].level;
    else {
      let lo = Infinity;
      for (let s0 = 0; s0 <= L; s0 += 5) lo = Math.min(lo, prof(s0));
      level = lo + (w0.level == null ? -1.2 : w0.level);
    }
    flood = {
      kind: w0.kind || 'red', level, depth: w0.depth || 2, bank: w0.bank || 8, sea: !!w0.sea,
      water: { kind: w0.kind || 'red', level },
    };
  }
  // Signed distance to dry land (negative on land) and the matching exact wet test.
  function floodLandSd(x, y) {
    let d = Infinity;
    for (const isl of islands) {
      const sd = polySd(isl.poly, x, y);
      if (sd < d) d = sd;
    }
    if (floodOutside) {
      const c = corridorSd(x, y);
      if (c < d) d = c;
      for (const a of landAreas) {
        const sd = areaSd(a, x, y);
        if (sd < d) d = sd;
      }
    }
    return d;
  }
  function floodWet(x, y) {
    for (const isl of islands) if (inBox(isl.box, x, y) && pointInPoly(isl.poly, x, y)) return false;
    if (floodOutside) {
      if (corridorSd(x, y) <= 0) return false;
      for (const a of landAreas) if (areaInside(a, x, y)) return false;
    }
    return true;
  }

  // ---- bunkers: unions of ellipses, (s, off) anchored or green-relative (g:[r, f]) ----
  const bunkers = (def.bunkers || []).map((b) => {
    const fr = b.g ? (() => {
      const p = toWorld(gF, b.g[0], b.g[1]);
      return { ...gF, x: p.x, y: p.y };
    })() : frameAt(path, b.s, b.off || 0);
    const pot = !!b.pot;
    const shape = b.shape || [[0, 0, b.r || 2.4, b.r || 2.4, 0]];
    const ells = shape.map((sp) => makeEllipse(fr, sp));
    let minR = Infinity;
    for (const e of ells) minR = Math.min(minR, e.rx, e.ry);
    const pts = [];
    for (const e of ells) pts.push({ x: e.cx - e.R, y: e.cy - e.R }, { x: e.cx + e.R, y: e.cy + e.R });
    if (!pot) {
      const depth = b.depth || 0.7;
      return { ells, depth, ramp: Math.min(1.8, 0.6 * minR), lip: 0.12 + 0.2 * depth, box: bboxOf(pts, 0), lipBox: bboxOf(pts, LIP_W + 0.5) };
    }
    // Pot bunker: deep, with the steep revetted face toward the green (down the hole when the
    // green is far away) and a gentler sand slope at the back where the player walks in.
    const c = ells[0];
    let fx = fr.fx;
    let fy = fr.fy;
    const gdx = gF.x - c.cx;
    const gdy = gF.y - c.cy;
    const gl = Math.hypot(gdx, gdy);
    if (gl > 1 && gl < 80) {
      fx = gdx / gl;
      fy = gdy / gl;
    }
    const depth = Math.min(1.8, Math.max(1.2, b.depth || 1.5));
    return {
      ells, depth, pot, cx: c.cx, cy: c.cy, fx, fy,
      ramp: POT_FACE, rampBack: Math.max(POT_FACE, Math.min(2.2, 0.9 * minR)), lip: 0.06,
      box: bboxOf(pts, 0), lipBox: bboxOf(pts, LIP_W + 0.5),
    };
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
  const mounds = (def.mounds || []).map(([s0, off, r, h]) => {
    const f = frameAt(path, s0, off);
    return { x: f.x, y: f.y, r, h };
  });

  // ---- surface classification (exact edges) ----
  const gsurf = { x: 0, y: 0 };
  const potList = bunkers.filter((b) => b.pot);
  function surfaceAt(x, y) {
    if (x < minX || x > maxX || y < minY || y > maxY) return SURF.OOB;
    fieldAt(x, y, fs, false);
    if (oobSL(fs.s, fs.lat)) return SURF.OOB;
    for (const w of waters) if (inBox(w.box, x, y) && pointInPoly(w.poly, x, y)) return SURF.WATER;
    if (flood && floodWet(x, y)) return SURF.WATER;
    for (const b of bunkers) {
      if (!inBox(b.pot ? b.lipBox : b.box, x, y)) continue;
      for (const e of b.ells) if (ellQ(e, x, y) < 1) return SURF.BUNKER;
      if (b.pot && bunkerSd(b, x, y) < POT_BAND) {
        gradAt(x, y, gsurf);
        if (Math.hypot(gsurf.x, gsurf.y) > POT_STEEP) return SURF.BUNKER;
      }
    }
    if (inBox(gBoxM, x, y)) {
      if (ellQ(gE, x, y) <= 1) return SURF.GREEN;
      if (ellSd(gE, x, y) <= fringe) return SURF.FRINGE;
    }
    if (nearTee(x, y, 0) && teeOutside(x, y) <= 0) return SURF.TEE;
    for (let i = areas.length - 1; i >= 0; i--) if (areaInside(areas[i], x, y)) return areas[i].surf;
    if (inFairway(fs.s, fs.lat)) return SURF.FAIRWAY;
    if (hasCorridor && !floodOutside && corridorSd(x, y) > 0) return outsideSurf;
    return SURF.ROUGH;
  }
  // Inside a pot bunker (or on the steep band of its face just outside the outline)?
  function potAt(x, y) {
    for (const b of potList) {
      if (!inBox(b.lipBox, x, y)) continue;
      const sd = bunkerSd(b, x, y);
      if (sd < 0) return true;
      if (sd < POT_BAND) {
        gradAt(x, y, gsurf);
        if (Math.hypot(gsurf.x, gsurf.y) > POT_STEEP) return true;
      }
    }
    return false;
  }
  function isOOB(x, y) {
    if (x < minX || x > maxX || y < minY || y > maxY) return true;
    fieldAt(x, y, fs, false);
    return oobSL(fs.s, fs.lat);
  }
  function waterAt(x, y) {
    for (const w of waters) if (inBox(w.box, x, y) && pointInPoly(w.poly, x, y)) return { kind: w.kind, level: w.level };
    if (flood && floodWet(x, y)) return { kind: flood.kind, level: flood.level };
    return null;
  }

  // ---- 1 m height grid ----
  const heights = new Float32Array(nx * ny);
  const und = def.undulate == null ? 0.6 : def.undulate;
  const cor = def.corridor || {};
  const corW = cor.w == null ? 45 : cor.w;
  const corH = cor.h == null ? 5 : cor.h;
  const fb4 = { oct: 4, seed: nseed + 1 };
  const fb2 = { oct: 2, seed: nseed + 5 };
  const fbR = { oct: 2, seed: nseed + 23 };
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
      // Outside the corridor: stony desert or fescue dunes are lumpier than mown rough.
      if (relief > 0) {
        const cd = corridorSd(x, y);
        if (cd > 0) z += relief * (fbm2(x / 9, y / 9, fbR) - 0.5) * 2.4 * smoothstep(0, 6, cd);
      }
      for (const m of mounds) {
        const dx = x - m.x;
        const dy = y - m.y;
        const q = (dx * dx + dy * dy) / (m.r * m.r);
        if (q < 1) z += m.h * (1 - q) * (1 - q);
      }
      // Areas with a height offset (raised waste, sunken hollows), eased in from their edge.
      for (const a of areas) {
        if (!a.dz || !inBox(a.box, x, y)) continue;
        const sd = areaSd(a, x, y);
        if (sd < 0) z += a.dz * smoothstep(0, a.ease, -sd);
      }
      // Flattened, slightly raised tee box with soft shoulders.
      if (nearTee(x, y, 4)) {
        const to = teeOutside(x, y);
        if (to < 4) z += (teeZ - z) * (1 - smoothstep(0, 4, to));
      }
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
      // Flood water: the same bed and banks, measured from the edge of the dry land.
      if (flood) {
        const sd = floodLandSd(x, y);
        if (sd > 0) z = flood.level - flood.depth * smoothstep(0, 7, sd);
        else if (-sd < flood.bank) {
          const zb = flood.level - 0.12 * sd;
          z = zb + (z - zb) * smoothstep(0, flood.bank, -sd);
        }
      }
      // Bunkers: bowl of the given depth, raised lip ring just outside. A pot bunker's ramp runs
      // from its gentle back to the steep revetted face.
      for (const b of bunkers) {
        if (!inBox(b.lipBox, x, y)) continue;
        const sd = bunkerSd(b, x, y);
        if (sd < 0) {
          let ramp = b.ramp;
          if (b.pot) {
            const dx = x - b.cx;
            const dy = y - b.cy;
            const dl = Math.hypot(dx, dy);
            const t = (1 + (dl > 1e-6 ? (dx * b.fx + dy * b.fy) / dl : 0)) / 2;
            ramp = b.rampBack + (b.ramp - b.rampBack) * t * t;
          }
          z -= b.depth * smoothstep(0, ramp, -sd);
        } else if (sd < LIP_W) {
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

  // ---- trees and objects ----
  // Object kinds (HoleTerrain.trees entries {kind, x, y, z, trunkR, trunkH, canopy|null, hard?,
  // scale?, variant?}; canopy.cz is the absolute z of the canopy centre):
  //   pine, broad  trunk + canopy ellipsoid (the shipped trees)
  //   palm         thin 0.18 m trunk 8-12 m tall, crown of fronds at the top
  //   saguaro      a bare column (trunkR 0.25, 4-9 m, canopy null); its arms are visual only
  //   shrub, gorse no trunk, a low canopy that reaches into the ground (it catches rolling balls)
  //   rock         hard: true, trunkR = radius, trunkH = height, canopy null
  //   grass        dune-grass tufts, visual only: they go to `decor`, never to `trees`
  const rng = mulberry32(((def.n || 1) * 0x9e3779b1) ^ (seed >>> 0) ^ 0x5bd1e995);
  const trees = [];
  const decor = [];
  const HC = 8; // spatial-hash cell, m
  const hnx = Math.ceil((maxX - minX) / HC) + 1;
  const hny = Math.ceil((maxY - minY) / HC) + 1;
  const hash = Array.from({ length: hnx * hny }, () => []);
  let maxReach = 0;
  const NOGROW = new Set([SURF.WATER, SURF.BUNKER, SURF.FAIRWAY, SURF.GREEN, SURF.FRINGE, SURF.TEE]);
  const NOSHADE = new Set([SURF.FAIRWAY, SURF.GREEN, SURF.FRINGE, SURF.TEE]);
  // How far an object reaches from its axis (treesNear), and its footprint for spacing (a
  // saguaro's arms spread about a metre).
  const reachOf = (o) => (o.canopy ? Math.max(o.canopy.rx, o.trunkR) : o.trunkR);
  const footOf = (o) => (o.canopy ? o.canopy.rx : o.kind === 'saguaro' ? 1 : Math.max(0.3, o.trunkR));
  function cellsAround(x, y, r, fn) {
    const i0 = Math.max(0, Math.floor((x - r - minX) / HC));
    const i1 = Math.min(hnx - 1, Math.floor((x + r - minX) / HC));
    const j0 = Math.max(0, Math.floor((y - r - minY) / HC));
    const j1 = Math.min(hny - 1, Math.floor((y + r - minY) / HC));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (fn(hash[j * hnx + i]) === false) return;
  }
  // Dimensions of one object, drawn from the rng before the spot is checked (so the sequence does
  // not depend on the ground). Pine and broad draw exactly as the shipped course did.
  function shapeOf(kind) {
    switch (kind) {
      case 'pine':
        return { trunkR: 0.2 + rng() * 0.12, trunkH: 2.4 + rng() * 1.6, rx: 2 + rng() * 1.3, rz: 5 + rng() * 3 };
      case 'palm': {
        const trunkH = 8 + rng() * 4;
        const rx = 3 + rng() * 1.4;
        const rz = 1.3 + rng() * 0.6;
        // Fronds droop round the crown: the canopy centre sits just above the top of the trunk.
        return { trunkR: 0.18, trunkH, rx, rz, cz: trunkH + 0.2 * rz, scale: trunkH / 10, variant: rng() };
      }
      case 'saguaro': {
        const trunkH = 4 + rng() * 5;
        return { trunkR: 0.25, trunkH, rx: 0, rz: 0, noCanopy: true, scale: trunkH / 6.5, variant: rng() };
      }
      case 'shrub':
      case 'gorse': {
        const gorse = kind === 'gorse';
        const h = (gorse ? 1.0 : 0.9) + rng() * 0.6;
        const rx = (gorse ? 1.2 : 1) + rng();
        // The ellipsoid reaches 0.25 m into the ground so a rolling ball meets it.
        return { trunkR: 0, trunkH: 0, rx, rz: h / 2 + 0.25, cz: h / 2, scale: h, variant: rng() };
      }
      case 'rock': {
        const u = rng();
        const r = 0.35 + u * u;
        const hgt = r * (0.5 + 0.5 * rng());
        return { trunkR: r, trunkH: hgt, rx: 0, rz: 0, noCanopy: true, hard: true, scale: r, variant: rng() };
      }
      default: // 'broad' and anything unknown
        return { trunkR: 0.28 + rng() * 0.18, trunkH: 2.6 + rng() * 1.4, rx: 3.4 + rng() * 2.4, rz: 3.4 + rng() * 2 };
    }
  }
  const TALL = new Set(['pine', 'broad', 'palm']);
  function tryKind(kind, x, y) {
    if (x < minX + 2 || x > maxX - 2 || y < minY + 2 || y > maxY - 2) return false;
    if (kind === 'grass') return tryGrass(x, y);
    if (trees.length >= MAX_OBJECTS) return false;
    const t = shapeOf(kind);
    if (NOGROW.has(surfaceAt(x, y))) return false;
    // Keep canopies off the fairway, tee and green (and low objects out of their edges).
    const tall = TALL.has(kind);
    const c = tall ? Math.max(2, t.rx * 0.75) : Math.max(0.6, t.noCanopy ? (kind === 'saguaro' ? 1 : t.trunkR) : t.rx * 0.6);
    for (const [ox, oy] of [[c, 0], [-c, 0], [0, c], [0, -c]]) if (NOSHADE.has(surfaceAt(x + ox, y + oy))) return false;
    const foot = t.noCanopy ? (kind === 'saguaro' ? 1 : Math.max(0.3, t.trunkR)) : t.rx;
    let clash = false;
    cellsAround(x, y, 8, (cell) => {
      for (const o of cell) {
        if (Math.hypot(o.x - x, o.y - y) < 0.55 * (footOf(o) + foot)) {
          clash = true;
          return false;
        }
      }
      return true;
    });
    if (clash) return false;
    const z = heightAt(x, y);
    let tree;
    if (t.cz === undefined && !t.noCanopy) {
      // The shipped trees (and unknown kinds, which grow as broadleaves).
      tree = {
        x, y, z,
        trunkR: t.trunkR,
        trunkH: t.trunkH,
        canopy: { cz: z + t.trunkH + t.rz * 0.8, rx: t.rx, rz: t.rz },
        kind: kind === 'pine' ? 'pine' : 'broad',
      };
    } else {
      tree = { x, y, z, trunkR: t.trunkR, trunkH: t.trunkH, canopy: t.noCanopy ? null : { cz: z + t.cz, rx: t.rx, rz: t.rz }, kind };
      if (t.hard) tree.hard = true;
      tree.scale = t.scale;
      tree.variant = t.variant;
    }
    trees.push(tree);
    hash[Math.floor((y - minY) / HC) * hnx + Math.floor((x - minX) / HC)].push(tree);
    const reach = reachOf(tree);
    if (reach > maxReach) maxReach = reach;
    return true;
  }
  // The shipped tree rows: a pine with probability mix, else a broadleaf.
  function tryTree(x, y, mix) {
    if (x < minX + 2 || x > maxX - 2 || y < minY + 2 || y > maxY - 2) return false;
    return tryKind(rng() < mix ? 'pine' : 'broad', x, y);
  }
  function tryGrass(x, y) {
    if (decor.length >= MAX_DECOR) return false;
    const scale = 0.6 + rng() * 0.6;
    if (NOGROW.has(surfaceAt(x, y))) return false;
    decor.push({ kind: 'grass', x, y, z: heightAt(x, y), scale });
    return true;
  }
  // Rows and clusters: the shipped `trees` rows (mix) and v2 `objects` rows (kind) share them.
  function scatterRowOrCluster(td, place) {
    if (td.cluster) {
      const c = td.g ? toWorld(gF, td.g[0], td.g[1]) : frameAt(path, td.s, td.off || 0);
      const spread = td.spread || 8;
      let placed = 0;
      for (let k = 0; k < td.cluster * 3 && k < 200; k++) {
        const a = rng() * Math.PI * 2;
        const r = spread * Math.sqrt(rng());
        if (place(c.x + Math.cos(a) * r, c.y + Math.sin(a) * r)) placed++;
        if (td.countAll ? trees.filter((t) => Math.hypot(t.x - c.x, t.y - c.y) <= spread + 0.01).length >= td.cluster : placed >= td.cluster) break;
      }
    } else {
      const gap = td.gap || 10;
      const jit = td.jitter == null ? 3 : td.jitter;
      for (let s0 = td.from; s0 <= td.to; s0 += gap * (0.75 + 0.5 * rng())) {
        const f = frameAt(path, s0 + (rng() - 0.5) * jit, td.off + (rng() * 2 - 1) * jit);
        place(f.x, f.y);
      }
    }
  }
  for (const td of def.trees || []) {
    const mix = td.mix == null ? 0.5 : td.mix;
    // The shipped clusters count every tree within the spread, not only their own.
    scatterRowOrCluster(td.cluster ? { ...td, countAll: true } : td, (x, y) => tryTree(x, y, mix));
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
        if (keep < p) {
          if (forest.kind) tryKind(pickKind(forest.kind, rng), x, y);
          else tryTree(x, y, forest.mix);
        }
      }
    }
  }
  // Themed objects: rows, clusters and area scatter {kind, area, density (per 100 m2)}; area is a
  // surface name ('desert', 'fescue', 'waste', 'rough', 'outside', ...) or an index into areas[].
  for (const od of def.objects || []) {
    if (od.area != null) {
      const dens = Math.max(1e-3, od.density == null ? 0.2 : od.density);
      const sp = Math.max(1.5, 10 / Math.sqrt(dens));
      const target = typeof od.area === 'number' ? null : od.area === 'outside' ? outsideSurf : AREA_SURF[od.area] || SURF_BY_NAME[od.area];
      const ar = typeof od.area === 'number' ? areas[od.area] : null;
      if (!target && !ar) continue;
      for (let y0 = minY; y0 < maxY; y0 += sp) {
        for (let x0 = minX; x0 < maxX; x0 += sp) {
          const x = x0 + rng() * sp;
          const y = y0 + rng() * sp;
          const sf = surfaceAt(x, y);
          if (ar ? !(areaInside(ar, x, y) && sf === ar.surf) : sf !== target) continue;
          tryKind(pickKind(od.kind, rng), x, y);
        }
      }
    } else {
      scatterRowOrCluster(od, (x, y) => tryKind(pickKind(od.kind, rng), x, y));
    }
  }
  function treesNear(x, y, r) {
    const res = [];
    cellsAround(x, y, r + maxReach, (cell) => {
      for (const t of cell) if (Math.hypot(t.x - x, t.y - y) <= r + reachOf(t)) res.push(t);
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

  // Theme and conditions of the course this hole belongs to (Hollow Pines without one).
  const conditions = { ...DEFAULT_CONDITIONS, ...((course && course.conditions) || {}) };
  const waterList = waters.map((w) => ({ kind: w.kind, level: w.level, poly: w.poly, sea: w.sea, fill: 'inside' }));
  if (flood) {
    // One plane over the whole hole at the flood level (the land above it hides it); islands lists
    // the dry polygons of fill:'outside' water (none for outside:'water').
    waterList.push({
      kind: flood.kind, level: flood.level, sea: flood.sea, fill: 'outside',
      poly: [{ x: minX, y: minY }, { x: maxX, y: minY }, { x: maxX, y: maxY }, { x: minX, y: maxY }],
      islands: islands.map((i) => i.poly),
    });
  }

  return {
    n: def.n, par: def.par, name: def.name, si: def.si,
    courseId: (course && course.id) || 'pines',
    theme: (course && course.theme) || 'parkland',
    conditions,
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
    surfaceAt, isOOB, waterAt, potAt,
    waters: waterList,
    trees, treesNear, decor,
    stakes,
    raycast, aimPoint,
    grid: { nx, ny, minX, minY, step: 1, heights },
    sgrid: { nx: snx, ny: sny, minX, minY, step: sstep, data: sdata },
  };
}
