// Spectator galleries (docs/architecture.md section 10). Pure: no DOM, no GL.
//
// buildCrowd(terrain, {seed, finishing, theme}) lays out one hole's galleries, TV-tournament style:
// rope lines (stakes + ropes) round the green surround (open in front, where approaches come in),
// round the sides and back of the tee box, along both sides of the fairway landing zone(s) on par 4s
// and 5s, and a small grandstand facing the green on par 3s and on the finishing hole(s). People
// stand behind the ropes in loose clusters one to four deep (seated in the grandstand). Nobody
// stands in play (fairway, green, fringe, tee, bunker, water, out of bounds, or within 2 m of the
// mown areas and 1.5 m of sand and water), on slopes steeper than ~17 deg, against a trunk or in a
// bush, or inside the address-view corridor (tee -> the aim points -> cup, `corridorFor`).
// Deterministic per seed (crowdSeed(courseId, holeNumber)).
//
// Result (CrowdLayout):
//   people     Float32Array(nFull * PERSON_FLOATS): per person
//                [x, y, z, yaw,  heightScale, seed 0..1, flags, skin,  shirt, legs, hat, hair]
//              colours packed as 8:8:8 sRGB integers (r * 65536 + g * 256 + b); flags = sit (1)
//              + hat kind * 2 (HAT) + parasol * 16 + long sleeves * 32 + shorts * 64 + idle pose
//              * 128 (0 arms down, 1 folded, 2 hands clasped, 3 holding something). The Light
//              subset is the first nLight people, so a lighter crowd is a shorter draw.
//   nFull, nLight, ropes [{pts: [{x, y, z}], kind}], stand {x, y, z, yaw, w, rows, rowD, rise,
//   ground, seats} | null, galleries [{kind: 'tee'|'fairway'|'green'|'stand', x, y, z, nFull,
//   nLight, r}], corridor (corridorFor), seed, finishing.
//
// crowdCount(layout, level) -> people drawn for 'off' | 'light' | 'full'.
// crowdShadowBake(bake, layout, n, sunDir) -> a copy of bakeTerrainColor's texture data with soft
//   sun shadows of the first n people and of the grandstand (the renderer uploads it as the hole's
//   ground colour while the crowd is shown).
//
// Reactions. planReactions(shot, {terrain, par, fromTee}) maps one played shot (game.shot: the
// result is known at the strike) to the reactions it earns and the shot event each waits for:
//   holed: a cheer (ace, eagle, chip-in, birdie, a long putt) or applause (par; polite otherwise);
//   lip-out, flagstick, near miss (a putt from 2.5 m+ stopping within 35 cm), a tree: 'ooh';
//   water, out of bounds: a groan; a bunker near the green: a muted groan;
//   onto the green: applause by how close (an 'ooh' first when it stops within 1.2 m);
//   a tee shot in the fairway: the tee gallery's "good shot" applause (and the landing zone's).
// CrowdReactions runs them: startShot(shot, ctx), shotEvent(ev, now), trigger(type, opts, now),
// update(now, ball, dt) -> {u, look}. Two reaction slots (the newest and the one it replaces,
// which fades out) go to the shader as uniforms u = Float32Array(16): per slot (type, t0, x, y),
// (radius, strength, duration, floor). Each person joins with probability strength (falling off
// beyond radius to `floor` far away), after a personal delay, for a personal duration. `fired`
// lists the reactions started by the last update (for the sound); `log` the recent ones (tests).
// look = the attention point (the ball, smoothed) the heads turn to.

import { SURF } from './constants.js';
import { mulberry32 } from './rng.js';
import { valueNoise2 } from './noise.js';
import { SKIN_TONES, HAIR_COLORS, hexToRgb } from './golfer.js';

export const CROWD_LEVELS = ['off', 'light', 'full'];
export const PERSON_FLOATS = 12;
export const MAX_PEOPLE = 250;
export const MIN_LIGHT = 40;
export const REACT = Object.freeze({ idle: 0, clap: 1, cheer: 2, ooh: 3, groan: 4 });
export const REACT_NAMES = ['idle', 'clap', 'cheer', 'ooh', 'groan'];
export const HAT = Object.freeze({ none: 0, cap: 1, bucket: 2, sun: 3, flat: 4, beanie: 5 });
// Address-view corridor: half-width near the ball, its growth per metre down the line and its cap,
// and how far it reaches back behind the tee (past the address camera).
export const CORRIDOR = Object.freeze({ near: 9, grow: 0.025, max: 14, back: 9 });
export const FRONT_HALF = (55 * Math.PI) / 180; // the open approach in front of each green
export const MAX_SLOPE = 0.3; // ground gradient a spectator may stand on
const STAKE_GAP = 4.6;
const ROW_D = 0.78;
const SPACING = 0.74;

const FORBID = new Set([SURF.TEE, SURF.FAIRWAY, SURF.FRINGE, SURF.GREEN, SURF.BUNKER, SURF.WATER, SURF.OOB]);
const MOWN = new Set([SURF.TEE, SURF.FAIRWAY, SURF.FRINGE, SURF.GREEN]);
const WET = new Set([SURF.BUNKER, SURF.WATER, SURF.OOB]);

// ------------------------------------------------------------------ wardrobe per theme
// sRGB hex lists; hats as weights by kind; probabilities of a parasol, long sleeves, shorts.
const WARDROBE = {
  parkland: {
    shirts: ['#f2f2ee', '#1f2d52', '#8dbfe6', '#e8b4c0', '#b8bcc2', '#2f5d3a', '#6a1e2d', '#f1e2a2', '#26272b', '#ece4d0', '#b51f2b', '#4a6fa5', '#d9d9d2'],
    legs: ['#c8b48a', '#1f2d52', '#6b6e72', '#26272b', '#d9d2bf', '#3d5a80', '#8a7a5a'],
    hats: { 0: 0.42, 1: 0.42, 2: 0.06, 3: 0.04, 4: 0.06 },
    hatCols: { 1: ['#f2f2ee', '#1f2d52', '#26272b', '#b51f2b', '#c8b48a', '#2f5d3a'], 2: ['#c8b48a', '#f2f2ee', '#1f2d52'], 3: ['#d8c08a', '#ece4d0'], 4: ['#6e5a46', '#585c5e', '#7a6a50'], 5: ['#1f2d52'] },
    canopy: ['#1f2d52', '#2f5d3a', '#f2f2ee', '#b51f2b'],
    parasol: 0.03, longSleeve: 0.35, shorts: 0.22,
  },
  desert: {
    shirts: ['#f4f2ea', '#e7d8bd', '#a9cbe8', '#f0a58c', '#5fb3b3', '#d6d8d2', '#f2c96b', '#1f2d52', '#b45a3c', '#ffffff', '#e8b4c0'],
    legs: ['#d9c9a3', '#f2efe6', '#c8b48a', '#1f2d52', '#9a8d74', '#6b6e72'],
    hats: { 0: 0.16, 1: 0.44, 2: 0.08, 3: 0.32 },
    hatCols: { 1: ['#f2f2ee', '#1f2d52', '#c8b48a', '#b45a3c', '#26272b'], 2: ['#e7d8bd', '#f2f2ee'], 3: ['#d8c08a', '#efe6cf', '#f4f2ea', '#c9a46a'] },
    canopy: ['#f4f2ea', '#e7d8bd', '#a9cbe8', '#f0a58c'],
    parasol: 0.12, longSleeve: 0.08, shorts: 0.62,
  },
  tropical: {
    shirts: ['#ffffff', '#f07a63', '#2fb3b8', '#f3cf45', '#e85d8e', '#9ccc45', '#8dbfe6', '#1f2d52', '#f5a13a', '#7fd1c7', '#f2f2ee'],
    legs: ['#f2efe6', '#d9c9a3', '#1f2d52', '#c8b48a', '#7fa6c9', '#e9e1cf'],
    hats: { 0: 0.25, 1: 0.3, 2: 0.1, 3: 0.35 },
    hatCols: { 1: ['#ffffff', '#1f2d52', '#2fb3b8', '#f07a63'], 2: ['#f2efe6', '#d9c9a3'], 3: ['#dcc489', '#e8d9a8', '#cfae6c'] },
    canopy: ['#ffffff', '#f07a63', '#2fb3b8', '#f3cf45', '#e85d8e'],
    parasol: 0.14, longSleeve: 0.04, shorts: 0.75,
  },
  links: {
    shirts: ['#1f2d52', '#1f4a33', '#b51f2b', '#e9c23a', '#3a3d42', '#2a57bd', '#6a1e2d', '#5b6236', '#e5802e', '#e9e9e4', '#2b5f6b'],
    legs: ['#1f2d52', '#3a3d42', '#1e1f23', '#b8a77f', '#4a4f3a', '#5a5d60'],
    hats: { 0: 0.14, 1: 0.16, 2: 0.3, 4: 0.24, 5: 0.16 },
    hatCols: { 1: ['#1f2d52', '#26272b', '#f2f2ee', '#b51f2b'], 2: ['#b8a77f', '#1f2d52', '#3a4a3a', '#e9e9e4'], 4: ['#6e5a46', '#585c5e', '#7a6a50', '#4b4b44'], 5: ['#1f2d52', '#26272b', '#b51f2b', '#1f4a33', '#6b6e72'] },
    canopy: ['#1f2d52', '#1f4a33', '#b51f2b', '#26272b', '#e9e9e4'],
    parasol: 0.1, longSleeve: 0.97, shorts: 0.02,
  },
};
const HAIR_W = { black: 0.17, darkbrown: 0.25, brown: 0.18, lightbrown: 0.1, blonde: 0.08, platinum: 0.01, auburn: 0.02, ginger: 0.02, grey: 0.12, white: 0.05 };

export function packColor(rgb) {
  const q = (v) => Math.max(0, Math.min(255, Math.round(v * 255)));
  return q(rgb[0]) * 65536 + q(rgb[1]) * 256 + q(rgb[2]);
}
export function unpackColor(v) {
  const r = Math.floor(v / 65536);
  const g = Math.floor((v - r * 65536) / 256);
  return [r / 255, g / 255, (v - r * 65536 - g * 256) / 255];
}

// Seed for a hole's gallery: the course and the hole's own number (a Mixed round's hole keeps it).
export function crowdSeed(courseId, n) {
  let h = 2166136261;
  const s = `${courseId || 'pines'}:${n | 0}`;
  for (let k = 0; k < s.length; k++) h = Math.imul(h ^ s.charCodeAt(k), 16777619);
  return h >>> 0;
}

export function crowdCount(layout, level) {
  if (!layout || level === 'off') return 0;
  return level === 'light' ? layout.nLight : layout.nFull;
}

// ------------------------------------------------------------------ geometry helpers
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 1e-9 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  return { d: Math.hypot(px - (ax + dx * t), py - (ay + dy * t)), t, along: t * Math.sqrt(l2) };
}

// The address-view corridor of a hole: the polyline from behind the tee through the course's aim
// points to the cup, with its half-width (CORRIDOR). {pts: [{x, y}], back}
export function corridorFor(terrain) {
  const T = terrain;
  const pts = [];
  const tee = T.tee;
  let p = { x: tee.x, y: tee.y };
  const a1 = T.aimPoint(p);
  let dx = a1.x - tee.x;
  let dy = a1.y - tee.y;
  const l = Math.hypot(dx, dy) || 1;
  dx /= l;
  dy /= l;
  pts.push({ x: tee.x - dx * CORRIDOR.back, y: tee.y - dy * CORRIDOR.back });
  pts.push({ x: tee.x, y: tee.y });
  for (let k = 0; k < 4; k++) {
    const a = T.aimPoint(p);
    pts.push({ x: a.x, y: a.y });
    if (Math.hypot(a.x - T.cup.x, a.y - T.cup.y) < 1) break;
    p = a;
  }
  const last = pts[pts.length - 1];
  if (Math.hypot(last.x - T.cup.x, last.y - T.cup.y) > 1) pts.push({ x: T.cup.x, y: T.cup.y });
  return { pts };
}

// Distance from (x, y) to the corridor minus its half-width there (< 0: inside).
export function corridorClearance(corr, x, y) {
  let best = Infinity;
  let run = 0; // distance down the line from the tee (the first segment is behind it)
  const P = corr.pts;
  for (let k = 0; k + 1 < P.length; k++) {
    const a = P[k];
    const b = P[k + 1];
    const s = segDist(x, y, a.x, a.y, b.x, b.y);
    const down = k === 0 ? 0 : run + s.along;
    const hw = k <= 1 ? Math.min(CORRIDOR.max, CORRIDOR.near + CORRIDOR.grow * down) : CORRIDOR.near;
    best = Math.min(best, s.d - hw);
    if (k > 0) run += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return best;
}

// ------------------------------------------------------------------ ground checks
function makeGround(T, stand) {
  const sg = T.sgrid;
  const b = T.bounds;
  const surf = (x, y) => {
    const i = Math.floor((x - sg.minX) / sg.step);
    const j = Math.floor((y - sg.minY) / sg.step);
    if (i < 0 || j < 0 || i >= sg.nx || j >= sg.ny) return SURF.OOB;
    return sg.data[j * sg.nx + i];
  };
  const grad = { x: 0, y: 0 };
  // Spectator ground at (x, y): allowed surface, margins round play and hazards, gentle slope,
  // in bounds and clear of trunks, bushes, rocks and low canopies.
  const ok = (x, y, { slope = MAX_SLOPE, trees = true, margin = 1 } = {}) => {
    if (x < b.minX + 6 || y < b.minY + 6 || x > b.maxX - 6 || y > b.maxY - 6) return false;
    if (FORBID.has(surf(x, y))) return false;
    if (T.isOOB && T.isOOB(x, y)) return false;
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      const c = Math.cos(a);
      const s = Math.sin(a);
      if (MOWN.has(surf(x + c * 2.1 * margin, y + s * 2.1 * margin))) return false;
      if (WET.has(surf(x + c * 1.5 * margin, y + s * 1.5 * margin))) return false;
    }
    if (slope < 9) {
      const g = T.gradAt ? T.gradAt(x, y, grad) : grad;
      if (Math.hypot(g.x, g.y) > slope) return false;
    }
    if (trees && T.treesNear) {
      const z = T.heightAt(x, y);
      for (const t of T.treesNear(x, y, 1.5)) {
        const d = Math.hypot(t.x - x, t.y - y);
        let clear;
        switch (t.kind) {
          case 'shrub':
          case 'gorse':
            clear = (t.canopy ? t.canopy.rx : 1.2) + 0.3;
            break;
          case 'rock':
            clear = (t.trunkR || 0.6) + 0.4;
            break;
          case 'saguaro':
            clear = 1.3;
            break;
          default:
            clear = (t.trunkR || 0.25) + 0.45;
        }
        if (d < clear) return false;
        const c = t.canopy;
        if (c && t.kind !== 'shrub' && t.kind !== 'gorse' && c.cz - c.rz < z + 2.1 && d < c.rx * 0.85) return false;
      }
    }
    if (stand && inStand(stand, x, y, 1.2)) return false;
    return true;
  };
  return { surf, ok };
}

// Is (x, y) within pad m of the grandstand's footprint?
function inStand(st, x, y, pad = 0) {
  const fx = Math.cos(st.yaw);
  const fy = Math.sin(st.yaw);
  const dx = x - st.x;
  const dy = y - st.y;
  const along = dx * -fy + dy * fx; // u axis
  const depth = -(dx * fx + dy * fy); // away from the field
  return Math.abs(along) <= st.w / 2 + pad && depth >= -pad && depth <= st.rows * st.rowD + 0.2 + pad;
}

// ------------------------------------------------------------------ galleries
// Candidate spots behind a rope: for each span between stakes, people every SPACING m in rows
// ROW_D apart on the side `out(x, y)` points to. Pushes {x, y, z, yaw, w, row} to `into`.
function spotsBehind(T, G, rope, out, face, rows, weightAt, rng, corr, into) {
  const P = rope.pts;
  for (let k = 0; k + 1 < P.length; k++) {
    const a = P[k];
    const b = P[k + 1];
    const L = Math.hypot(b.x - a.x, b.y - a.y);
    const n = Math.max(1, Math.round(L / SPACING));
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      const x0 = a.x + (b.x - a.x) * t;
      const y0 = a.y + (b.y - a.y) * t;
      const o = out(x0, y0);
      for (let r = 0; r < rows; r++) {
        const d = 0.75 + r * ROW_D + (rng() - 0.5) * 0.22;
        const sh = (rng() - 0.5) * 0.24 + (r % 2 ? SPACING * 0.5 : 0);
        const x = x0 + o.x * d - o.y * sh;
        const y = y0 + o.y * d + o.x * sh;
        if (!G.ok(x, y)) continue;
        if (corridorClearance(corr, x, y) < 0.5) continue;
        const w = weightAt(x, y, r);
        if (w <= 0) continue;
        into.push({ x, y, z: T.heightAt(x, y), yaw: face(x, y) + (rng() - 0.5) * 0.5, w, row: r });
      }
    }
  }
}

// Split a run of candidate stake points (null = a gap) into ropes of 2+ stakes no more than
// maxGap m apart.
function ropesFrom(points, maxGap, kind) {
  const ropes = [];
  let cur = [];
  const flush = () => {
    if (cur.length >= 2) ropes.push({ pts: cur, kind });
    cur = [];
  };
  for (const p of points) {
    if (!p) {
      flush();
      continue;
    }
    const last = cur[cur.length - 1];
    if (last && Math.hypot(p.x - last.x, p.y - last.y) > maxGap) flush();
    cur.push(p);
  }
  flush();
  return ropes;
}

function ellipseR(g, ang) {
  const a = ang - g.rot;
  const c = Math.cos(a) / g.rx;
  const s = Math.sin(a) / g.ry;
  return 1 / Math.sqrt(c * c + s * s);
}

// Direction the approach comes into the green from (unit, pointing toward the green).
function approachDir(T) {
  const g = T.green;
  const L = T.path.length;
  const pa = T.path.pointAt(Math.max(0, L - 70));
  let dx = g.cx - pa.x;
  let dy = g.cy - pa.y;
  const l = Math.hypot(dx, dy) || 1;
  dx /= l;
  dy /= l;
  return { x: dx, y: dy };
}

function greenRopes(T, G, rng, seed) {
  const g = T.green;
  const din = approachDir(T);
  const cosFront = Math.cos(FRONT_HALF);
  const pts = [];
  let ang = Math.atan2(din.y, din.x); // start behind the green, go round
  const end = ang + Math.PI * 2;
  while (ang < end) {
    const ux = Math.cos(ang);
    const uy = Math.sin(ang);
    const re = ellipseR(g, ang);
    const front = -(ux * din.x + uy * din.y) > cosFront;
    let stakeAt = null;
    if (!front) {
      const r0 = re + (g.fringe || 1.2) + 7 + 2.5 * valueNoise2(ang * 1.7, 0.5, seed & 0xffff);
      for (let r = r0; r < r0 + 14; r += 1) {
        const x = g.cx + ux * r;
        const y = g.cy + uy * r;
        if (G.ok(x, y, { slope: 0.42, margin: 0.8 }) && G.ok(x + ux * 1.4, y + uy * 1.4) && G.ok(x + ux * 2.4, y + uy * 2.4)) {
          stakeAt = { x, y, z: T.heightAt(x, y) };
          break;
        }
      }
    }
    pts.push(stakeAt);
    ang += STAKE_GAP / (re + 12);
  }
  return ropesFrom(pts, 7.5, 'green');
}

// The tee box in its own frame (forward f along the hole, right r): extents from the TEE cells.
function teeBox(T, G) {
  const tg = T.path.tangentAt(0);
  const fl = Math.hypot(tg.x, tg.y) || 1;
  const f = { x: tg.x / fl, y: tg.y / fl };
  const r = { x: f.y, y: -f.x };
  let a0 = -6;
  let a1 = 6;
  let l0 = -4.5;
  let l1 = 4.5;
  let n = 0;
  const t = T.tee;
  for (let y = t.y - 26; y <= t.y + 26; y += 0.5) {
    for (let x = t.x - 26; x <= t.x + 26; x += 0.5) {
      if (G.surf(x, y) !== SURF.TEE) continue;
      const dx = x - t.x;
      const dy = y - t.y;
      const a = dx * f.x + dy * f.y;
      const l = dx * r.x + dy * r.y;
      if (!n) {
        a0 = a1 = a;
        l0 = l1 = l;
      }
      n++;
      a0 = Math.min(a0, a);
      a1 = Math.max(a1, a);
      l0 = Math.min(l0, l);
      l1 = Math.max(l1, l);
    }
  }
  return { f, r, a0, a1, l0, l1 };
}

function teeRopes(T, G, box) {
  const { f, r } = box;
  const t = T.tee;
  const P = (a, l) => ({ x: t.x + f.x * a + r.x * l, y: t.y + f.y * a + r.y * l });
  const lL = Math.min(box.l0 - 4.6, -9.2);
  const lR = Math.max(box.l1 + 4.6, 9.2);
  const aB = box.a0 - 5.5;
  const aF = box.a1 + 20; // the sides run on down the chute, framing the tee shot
  const line = [];
  const seg = (p, q) => {
    const L = Math.hypot(q.x - p.x, q.y - p.y);
    const n = Math.max(1, Math.round(L / STAKE_GAP));
    for (let k = 0; k <= n; k++) {
      if (k === 0 && line.length) continue;
      const x = p.x + ((q.x - p.x) * k) / n;
      const y = p.y + ((q.y - p.y) * k) / n;
      line.push(G.ok(x, y, { slope: 0.45, margin: 0.8 }) ? { x, y, z: T.heightAt(x, y) } : null);
    }
  };
  seg(P(aF, lL), P(aB, lL));
  seg(P(aB, lL), P(aB, lR));
  seg(P(aB, lR), P(aF, lR));
  return ropesFrom(line, 6.5, 'tee');
}

// Lateral distance (m) from the centreline at arc length s to the fairway's edge on `side`
// (+1 right, -1 left), or null where there is no fairway (a forced carry).
function fairwayEdge(T, G, s, side) {
  const c = T.path.pointAt(s);
  const tg = T.path.tangentAt(s);
  const tl = Math.hypot(tg.x, tg.y) || 1;
  const rx = tg.y / tl;
  const ry = -tg.x / tl;
  let edge = null;
  for (let lat = -30; lat <= 60; lat += 1) {
    const x = c.x + rx * lat * side;
    const y = c.y + ry * lat * side;
    if (G.surf(x, y) === SURF.FAIRWAY) edge = lat;
  }
  return edge == null ? null : { edge, c, rx: rx * side, ry: ry * side };
}

function fairwayRopes(T, G, zones) {
  const ropes = [];
  for (const z of zones) {
    for (const side of [-1, 1]) {
      const line = [];
      for (let s = z.s0; s <= z.s1; s += STAKE_GAP) {
        const e = fairwayEdge(T, G, s, side);
        let p = null;
        if (e) {
          for (let lat = e.edge + 8; lat < e.edge + 18; lat += 1) {
            const x = e.c.x + e.rx * lat;
            const y = e.c.y + e.ry * lat;
            if (G.ok(x, y, { slope: 0.42, margin: 0.8 }) && G.ok(x + e.rx * 1.4, y + e.ry * 1.4) && G.ok(x + e.rx * 2.4, y + e.ry * 2.4)) {
              p = { x, y, z: T.heightAt(x, y), ox: e.rx, oy: e.ry };
              break;
            }
          }
        }
        line.push(p);
      }
      for (const rp of ropesFrom(line, 8, 'fairway')) {
        rp.side = side;
        ropes.push(rp);
      }
    }
  }
  return ropes;
}

// A small grandstand facing the green, behind or beside it, on ground it can stand on.
function placeStand(T, G, corr) {
  const g = T.green;
  const din = approachDir(T);
  const W = 13;
  const ROWS = 5;
  const RD = 0.85;
  const RISE = 0.42;
  const D = ROWS * RD + 0.3;
  let best = null;
  const base = Math.atan2(din.y, din.x);
  for (let k = 0; k < 36; k++) {
    const ang = base + ((k % 2 ? 1 : -1) * Math.ceil(k / 2) * Math.PI) / 18;
    const ux = Math.cos(ang);
    const uy = Math.sin(ang);
    const back = ux * din.x + uy * din.y; // 1 = right behind the green
    if (back < Math.cos(Math.PI - 75 * (Math.PI / 180))) continue; // never in front
    const re = ellipseR(g, ang) + (g.fringe || 1.2);
    for (const gap of [13, 16, 19, 23, 27, 32]) {
      const x = g.cx + ux * (re + gap);
      const y = g.cy + uy * (re + gap);
      const yaw = Math.atan2(-uy, -ux); // facing the green
      const fx = Math.cos(yaw);
      const fy = Math.sin(yaw);
      // Footprint samples (along u, depth w away from the field).
      let ok = true;
      let zMin = Infinity;
      let zMax = -Infinity;
      let zFront = -Infinity;
      const ground = [];
      for (let a = -W / 2 - 0.5; a <= W / 2 + 0.51 && ok; a += 1) {
        for (let d = -0.6; d <= D + 0.61 && ok; d += 0.9) {
          const sx = x + -fy * a - fx * d;
          const sy = y + fx * a - fy * d;
          if (!G.ok(sx, sy, { slope: 9, margin: 0.6 }) || corridorClearance(corr, sx, sy) < 2) ok = false;
          else {
            const z = T.heightAt(sx, sy);
            zMin = Math.min(zMin, z);
            zMax = Math.max(zMax, z);
            if (d < 0.5) zFront = Math.max(zFront, z);
            // The ground may not reach the tier above it.
            if (z > zFront + Math.floor(Math.max(0, d) / RD) * RISE + 0.25 + 2.0) ok = false;
          }
        }
      }
      if (!ok || zMax - zMin > 2.4) continue;
      const score = gap + 14 * (1 - back) + (zMax - zMin) * 3;
      if (!best || score < best.score) {
        const corner = (a, d) => T.heightAt(x + -fy * a - fx * d, y + fx * a - fy * d);
        let z0 = zFront + 0.25;
        // Lift the deck until every tier clears the ground under it.
        for (let d = 0; d <= D; d += 0.4) {
          for (let a = -W / 2; a <= W / 2; a += 1) {
            const zz = corner(a, d);
            const need = zz + 0.12 - Math.floor(d / RD) * RISE;
            if (need > z0) z0 = need;
          }
        }
        ground.push(corner(-W / 2, 0), corner(W / 2, 0), corner(-W / 2, D), corner(W / 2, D));
        best = { score, st: { x, y, z: z0, yaw, w: W, rows: ROWS, rowD: RD, rise: RISE, ground } };
      }
      break; // the nearest valid gap at this angle
    }
  }
  return best ? best.st : null;
}

// ------------------------------------------------------------------ appearance
function pickW(weights, rng) {
  let tot = 0;
  for (const k in weights) tot += weights[k];
  let u = rng() * tot;
  for (const k in weights) {
    u -= weights[k];
    if (u <= 0) return k;
  }
  return Object.keys(weights)[0];
}
const pick = (list, rng) => list[Math.floor(rng() * list.length) % list.length];
const jitter = (rgb, rng, k) => rgb.map((v) => Math.max(0, Math.min(1, v * (1 + (rng() - 0.5) * k))));

const HAIR_BY_ID = Object.fromEntries(HAIR_COLORS.map((h) => [h.id, h.hex]));

function dressPerson(out, o, spot, wd, rng, sit) {
  const kid = !sit && rng() < 0.04;
  const female = rng() < 0.4;
  let H = (female ? 1.65 : 1.77) + (rng() + rng() + rng() - 1.5) * 0.09;
  if (kid) H = 1.12 + rng() * 0.3;
  const skin = jitter(hexToRgb(SKIN_TONES[Math.floor(rng() * SKIN_TONES.length) % SKIN_TONES.length].hex), rng, 0.06);
  const shirt = jitter(hexToRgb(pick(wd.shirts, rng)), rng, 0.1);
  const legs = jitter(hexToRgb(pick(wd.legs, rng)), rng, 0.1);
  const old = !kid && rng() < 0.22;
  let hair = hexToRgb(HAIR_BY_ID[old ? (rng() < 0.6 ? 'grey' : 'white') : pickW(HAIR_W, rng)] || '#3a281d');
  if (!female && !kid && rng() < (old ? 0.3 : 0.06)) hair = skin; // bald
  const hat = Number(pickW(wd.hats, rng));
  const hatCols = wd.hatCols[hat] || wd.hatCols[1] || ['#f2f2ee'];
  const para = !sit && !kid && rng() < wd.parasol ? 1 : 0;
  const hatCol = para && hat === 0 ? hexToRgb(pick(wd.canopy, rng)) : jitter(hexToRgb(pick(hatCols, rng)), rng, 0.08);
  const longS = rng() < wd.longSleeve ? 1 : 0;
  const shorts = !longS && rng() < wd.shorts ? 1 : rng() < wd.shorts * 0.25 ? 1 : 0;
  const iu = rng();
  const idle = iu < 0.36 ? 0 : iu < 0.62 ? 1 : iu < 0.76 ? 2 : 3;
  const flags = (sit ? 1 : 0) + hat * 2 + para * 16 + longS * 32 + shorts * 64 + idle * 128;
  out[o] = spot.x;
  out[o + 1] = spot.y;
  out[o + 2] = spot.z;
  out[o + 3] = spot.yaw;
  out[o + 4] = H / 1.75;
  out[o + 5] = rng();
  out[o + 6] = flags;
  out[o + 7] = packColor(skin);
  out[o + 8] = packColor(shirt);
  out[o + 9] = packColor(legs);
  out[o + 10] = packColor(hatCol);
  out[o + 11] = packColor(hair);
}

// ------------------------------------------------------------------ layout
export function buildCrowd(terrain, { seed = 1, finishing = null, theme = null } = {}) {
  const T = terrain;
  const rng = mulberry32(seed >>> 0 || 1);
  const th = theme || T.theme || 'parkland';
  const wd = WARDROBE[th] || WARDROBE.parkland;
  const fin = finishing == null ? T.n === 9 : !!finishing;
  const par3 = T.par === 3;
  const corr = corridorFor(T);
  const G0 = makeGround(T, null);
  const stand = par3 || fin ? placeStand(T, G0, corr) : null;
  const G = stand ? makeGround(T, stand) : G0;
  const noiseSeed = seed & 0xffff;
  const cluster = (x, y) => {
    const v = valueNoise2(x / 9, y / 9, noiseSeed);
    return 0.12 + v * v * 1.6;
  };
  const ROWW = [1, 0.75, 0.5, 0.3];

  // Ropes and candidate spots per gallery.
  const g = T.green;
  const greenR = greenRopes(T, G, rng, seed);
  const box = teeBox(T, G);
  const teeR = teeRopes(T, G, box);
  const zones = [];
  const L = T.lengthM || T.path.length;
  if (!par3) {
    const s0 = Math.min(L - 120, Math.max(175, L * 0.52));
    zones.push({ s0, s1: Math.min(L - 85, s0 + 95) });
    if (T.par >= 5 && L - 165 > zones[0].s1 + 35) zones.push({ s0: L - 165, s1: L - 110 });
  }
  const fairR = zones.length ? fairwayRopes(T, G, zones.filter((z) => z.s1 > z.s0 + 10)) : [];

  const cand = { green: [], tee: [], fairway: [], stand: [] };
  const toGreen = (x, y) => Math.atan2(g.cy - y, g.cx - x);
  for (const rp of greenR) {
    spotsBehind(T, G, rp, (x, y) => {
      const dx = x - g.cx;
      const dy = y - g.cy;
      const l = Math.hypot(dx, dy) || 1;
      return { x: dx / l, y: dy / l };
    }, toGreen, 4, (x, y, r) => cluster(x, y) * ROWW[r], rng, corr, cand.green);
  }
  const t = T.tee;
  const teeFocus = { x: t.x + box.f.x * 6, y: t.y + box.f.y * 6 };
  for (const rp of teeR) {
    spotsBehind(T, G, rp, (x, y) => {
      // Away from the tee box: sideways along the sides, backwards behind it.
      const dx = x - t.x;
      const dy = y - t.y;
      const a = dx * box.f.x + dy * box.f.y;
      const l = dx * box.r.x + dy * box.r.y;
      if (a < box.a0 - 4) return { x: -box.f.x, y: -box.f.y };
      const s = l > 0 ? 1 : -1;
      return { x: box.r.x * s, y: box.r.y * s };
    }, (x, y) => Math.atan2(teeFocus.y - y, teeFocus.x - x), 3, (x, y, r) => cluster(x, y) * ROWW[r], rng, corr, cand.tee);
  }
  for (const rp of fairR) {
    const o0 = rp.pts[0];
    // Facing the fairway, turned a little back toward the tee (they watch the drives come in).
    const tg = T.path.tangentAt(T.path.project(o0.x, o0.y).s);
    const turn = Math.sign(-o0.ox * -tg.y + o0.oy * -tg.x) * 0.35;
    const face = Math.atan2(-o0.oy, -o0.ox) + turn;
    spotsBehind(T, G, rp, () => ({ x: o0.ox, y: o0.oy }), () => face, 3, (x, y, r) => cluster(x, y) * ROWW[r] * 0.9, rng, corr, cand.fairway);
  }
  if (stand) {
    const fx = Math.cos(stand.yaw);
    const fy = Math.sin(stand.yaw);
    const n = Math.floor((stand.w - 0.9) / 0.62);
    for (let k = 0; k < stand.rows; k++) {
      for (let j = 0; j < n; j++) {
        const a = -stand.w / 2 + 0.45 + j * 0.62 + 0.31;
        const d = (k + 1) * stand.rowD - 0.27;
        const x = stand.x + -fy * a - fx * d;
        const y = stand.y + fx * a - fy * d;
        cand.stand.push({ x, y, z: stand.z + k * stand.rise, yaw: stand.yaw + (rng() - 0.5) * 0.3, w: 0.6 + 0.4 * cluster(x * 3, y * 3), row: k, sit: true });
      }
    }
    stand.seats = cand.stand.length;
  }

  // Quotas (Full, Light) per gallery; what one cannot fill goes to the others.
  const Q = par3
    ? { green: [125, 44], tee: [55, 20], fairway: [0, 0], stand: [62, 22] }
    : { green: [100, 36], tee: [45, 16], fairway: [52, 18], stand: [64, 22] };
  if (fin) Q.green = [Q.green[0] + 20, Q.green[1] + 6];
  if (!stand) Q.stand = [0, 0];
  let totF = 0;
  for (const k in Q) totF += Q[k][0];
  if (totF > MAX_PEOPLE) for (const k in Q) Q[k] = [Math.floor((Q[k][0] * MAX_PEOPLE) / totF), Q[k][1]];
  // Weighted sampling without replacement (exponential races): smallest key first.
  const order = {};
  for (const k in cand) {
    for (const c of cand[k]) c.key = -Math.log(Math.max(1e-12, rng())) / c.w;
    order[k] = cand[k].slice().sort((a, b) => a.key - b.key);
  }
  const take = { green: [0, 0], tee: [0, 0], fairway: [0, 0], stand: [0, 0] };
  for (const lv of [0, 1]) {
    let spare = 0;
    for (const k in Q) {
      const n = Math.min(Q[k][lv], order[k].length);
      take[k][lv] = n;
      spare += Q[k][lv] - n;
    }
    // Hand the shortfall to galleries with candidates left, biggest first.
    for (const k of ['green', 'tee', 'fairway', 'stand']) {
      if (spare <= 0) break;
      const room = order[k].length - take[k][lv];
      const add = Math.min(room, spare);
      take[k][lv] += add;
      spare -= add;
    }
  }
  // Light must not exceed Full; Full at most MAX_PEOPLE in all.
  let nFull = 0;
  for (const k in take) {
    take[k][1] = Math.min(take[k][1], take[k][0]);
    nFull += take[k][0];
  }
  while (nFull > MAX_PEOPLE) {
    const k = Object.keys(take).sort((a, b) => take[b][0] - take[a][0])[0];
    take[k][0]--;
    take[k][1] = Math.min(take[k][1], take[k][0]);
    nFull--;
  }
  const lightList = [];
  const restList = [];
  for (const k of ['green', 'tee', 'fairway', 'stand']) {
    const list = order[k];
    for (let i = 0; i < take[k][0]; i++) (i < take[k][1] ? lightList : restList).push({ c: list[i], k });
  }
  const all = lightList.concat(restList);
  const people = new Float32Array(all.length * PERSON_FLOATS);
  const dress = mulberry32((seed ^ 0x5bd1e995) >>> 0);
  all.forEach(({ c }, i) => dressPerson(people, i * PERSON_FLOATS, c, wd, dress, !!c.sit));

  // Gallery summaries (centroid, counts, extent) for the sound and the tests.
  const galleries = [];
  for (const k of ['tee', 'fairway', 'green', 'stand']) {
    const sel = all.filter((p) => p.k === k);
    if (!sel.length) continue;
    let x = 0;
    let y = 0;
    let z = 0;
    for (const { c } of sel) {
      x += c.x;
      y += c.y;
      z += c.z;
    }
    x /= sel.length;
    y /= sel.length;
    z /= sel.length;
    let r = 0;
    for (const { c } of sel) r = Math.max(r, Math.hypot(c.x - x, c.y - y));
    galleries.push({ kind: k, x, y, z, nFull: sel.length, nLight: lightList.filter((p) => p.k === k).length, r });
  }
  const ropes = [...greenR, ...teeR, ...fairR].map((rp) => ({ kind: rp.kind, pts: rp.pts.map((p) => ({ x: p.x, y: p.y, z: p.z })) }));
  return { people, nFull: all.length, nLight: lightList.length, ropes, stand, galleries, corridor: corr, seed, finishing: fin, theme: th };
}

// ------------------------------------------------------------------ baked shadows
// Soft sun shadows of the first n people (and the grandstand) darkened into a copy of the hole's
// ground colour texture (bake.js layout: RGBA, 0.5 m texels from minX/minY).
export function crowdShadowBake(bake, layout, n, sunDir) {
  const data = new Uint8Array(bake.data);
  if (!layout || n <= 0) return data;
  const W = bake.width;
  const H = bake.height;
  const st = bake.step;
  const sl = Math.hypot(sunDir.x, sunDir.y) || 1;
  const k = sl / Math.max(0.2, sunDir.z); // shadow length per metre of height
  const sx = -sunDir.x / sl;
  const sy = -sunDir.y / sl;
  const shade = new Float32Array(W * H);
  const disc = (cx, cy, r, s) => {
    const i0 = Math.max(0, Math.floor((cx - r - bake.minX) / st));
    const i1 = Math.min(W - 1, Math.ceil((cx + r - bake.minX) / st));
    const j0 = Math.max(0, Math.floor((cy - r - bake.minY) / st));
    const j1 = Math.min(H - 1, Math.ceil((cy + r - bake.minY) / st));
    for (let j = j0; j <= j1; j++) {
      const wy = bake.minY + (j + 0.5) * st;
      for (let i = i0; i <= i1; i++) {
        const wx = bake.minX + (i + 0.5) * st;
        const d = Math.hypot(wx - cx, wy - cy) / r;
        if (d < 1) {
          const f = s * (1 - d * d);
          const q = j * W + i;
          shade[q] = Math.max(shade[q], f);
        }
      }
    }
  };
  const P = layout.people;
  for (let p = 0; p < Math.min(n, layout.nFull); p++) {
    const o = p * PERSON_FLOATS;
    if (P[o + 6] % 2 >= 1) continue; // seated: the grandstand's shadow covers them
    const h = 1.75 * P[o + 4];
    const len = Math.min(4, h * k);
    // A body-wide streak from the feet away from the sun.
    for (let t = 0.15; t <= 1.0001; t += 0.28) disc(P[o] + sx * len * t * 0.8, P[o + 1] + sy * len * t * 0.8, 0.42, 0.36 * (1.1 - 0.4 * t));
  }
  const S = layout.stand;
  if (S) {
    const fx = Math.cos(S.yaw);
    const fy = Math.sin(S.yaw);
    const D = S.rows * S.rowD;
    const hTop = (S.rows - 1) * S.rise + 1.6 + (S.z - Math.min(...S.ground));
    for (let a = -S.w / 2; a <= S.w / 2; a += 0.8) {
      for (let d = 0; d <= D; d += 0.8) {
        const hh = Math.min(hTop, (d / D) * hTop + 0.8);
        for (let t = 0; t <= 1; t += 0.34) {
          const x = S.x + -fy * a - fx * d + sx * hh * k * t;
          const y = S.y + fx * a - fy * d + sy * hh * k * t;
          disc(x, y, 1.1, 0.5);
        }
      }
    }
  }
  for (let q = 0; q < W * H; q++) {
    const s = shade[q];
    if (s <= 0) continue;
    const m = 1 - Math.min(0.55, s);
    data[q * 4] = Math.round(data[q * 4] * m);
    data[q * 4 + 1] = Math.round(data[q * 4 + 1] * m);
    data[q * 4 + 2] = Math.round(data[q * 4 + 2] * m);
  }
  return data;
}

// ------------------------------------------------------------------ reactions
const SURF_GREEN = new Set([SURF.GREEN, SURF.FRINGE]);

// The reactions a shot earns, each waiting for a shot event (`on`: the first event of that
// type; 'launch' fires at the strike) plus `delay` s: [{on, type, strength, x, y, radius, floor,
// dur, delay, why}]. ctx = {terrain, par, fromTee}.
export function planReactions(shot, { terrain, par, fromTee = false } = {}) {
  const out = [];
  if (!shot || !shot.result || !terrain) return out;
  const T = terrain;
  const res = shot.resolution || {};
  const R = shot.result;
  const evs = R.events || [];
  const cup = T.cup;
  const from = shot.from || T.tee;
  const putt = !!(shot.launch && shot.launch.mode === 'roll');
  const startD = Math.hypot(from.x - cup.x, from.y - cup.y);
  const fin = R.final || from;
  const finD = Math.hypot(fin.x - cup.x, fin.y - cup.y);
  const P = par || T.par || 4;
  const has = (type) => evs.some((e) => e.type === type);
  const first = (type) => evs.find((e) => e.type === type);
  const add = (on, type, strength, x, y, why, o = {}) =>
    out.push({ on, type, strength, x, y, radius: o.radius || 45, floor: o.floor ?? 0.06, dur: o.dur || (type === REACT.cheer ? 4.6 : type === REACT.clap ? 2.6 : type === REACT.ooh ? 1.5 : 2.0), delay: o.delay || 0, why });
  if (res.holed) {
    const strokes = res.strokes || 1;
    const toPar = strokes - P;
    if (strokes === 1) add('cup', REACT.cheer, 1, cup.x, cup.y, 'ace', { floor: 0.45, dur: 6, radius: 60 });
    else if (toPar <= -2) add('cup', REACT.cheer, 1, cup.x, cup.y, 'eagle', { floor: 0.35, dur: 5.5, radius: 55 });
    else if (!putt) add('cup', REACT.cheer, 0.95, cup.x, cup.y, 'holed out', { floor: 0.3, dur: 5, radius: 55 });
    else if (toPar === -1) add('cup', REACT.cheer, 0.9, cup.x, cup.y, 'birdie', { floor: 0.25, dur: 4.6 });
    else if (startD >= 6) add('cup', REACT.cheer, 0.8, cup.x, cup.y, 'long putt', { floor: 0.2, dur: 4.2 });
    else if (toPar === 0) add('cup', REACT.clap, 0.75, cup.x, cup.y, 'par', { dur: 2.8 });
    else add('cup', REACT.clap, startD < 1.5 ? 0.35 : 0.45, cup.x, cup.y, 'holed', { dur: 2.2 });
    return out;
  }
  const outcome = res.outcome || (R.final && R.final.outcome) || 'rest';
  if (outcome === 'water') {
    const w = R.waterEntry || fin;
    add('water', REACT.groan, 0.8, w.x, w.y, 'water', { radius: 70, floor: 0.12 });
    return out;
  }
  if (outcome === 'ob') {
    add('rest', REACT.groan, 0.6, fin.x, fin.y, 'out of bounds', { radius: 70, floor: 0.1 });
    return out;
  }
  const lip = first('lipout');
  const pin = first('pin');
  if (lip) add('lipout', REACT.ooh, 0.95, cup.x, cup.y, 'lip out', { floor: 0.12, dur: 1.7 });
  else if (pin) add('pin', REACT.ooh, 0.85, cup.x, cup.y, 'flagstick', { floor: 0.1 });
  const surfFin = T.surfaceAt(fin.x, fin.y);
  if (putt) {
    if (!lip && startD >= 2.5 && finD < 0.35) add('rest', REACT.ooh, 0.7, cup.x, cup.y, 'near miss');
    else if (!lip && startD > 9 && finD < 0.9) add('rest', REACT.clap, 0.35, cup.x, cup.y, 'good lag', { dur: 1.8 });
    return out;
  }
  if (has('tree')) {
    const tr = first('tree');
    add('tree', REACT.ooh, 0.5, tr.x, tr.y, 'tree', { radius: 50, floor: 0 });
  }
  if (SURF_GREEN.has(surfFin) && surfFin === SURF.GREEN) {
    if (finD < 1.2 && !lip && !pin) {
      add('rest', REACT.ooh, 0.85, cup.x, cup.y, 'so close', { floor: 0.12 });
      add('rest', REACT.clap, 1, cup.x, cup.y, 'stiff', { delay: 1.1, dur: 3.2, floor: 0.12 });
    } else add('rest', REACT.clap, finD < 3 ? 0.9 : finD < 8 ? 0.65 : 0.4, cup.x, cup.y, 'on the green', { dur: finD < 3 ? 3 : 2.4 });
    if (fromTee) add('launch', REACT.clap, 0.6, T.tee.x, T.tee.y, 'good shot', { delay: 1.4, radius: 40, floor: 0, dur: 2.2 });
  } else if (fromTee && P >= 4 && surfFin === SURF.FAIRWAY) {
    add('launch', REACT.clap, 0.55, T.tee.x, T.tee.y, 'good shot', { delay: 1.4, radius: 40, floor: 0, dur: 2.2 });
    add('rest', REACT.clap, 0.35, fin.x, fin.y, 'in the fairway', { radius: 40, floor: 0, dur: 1.8 });
  } else if (surfFin === SURF.BUNKER) {
    const g = T.green;
    if (Math.hypot(fin.x - g.cx, fin.y - g.cy) < 60) add('rest', REACT.groan, 0.4, fin.x, fin.y, 'bunker', { radius: 40, floor: 0, dur: 1.6 });
  }
  return out;
}

export class CrowdReactions {
  constructor() {
    this.u = new Float32Array(16); // uReact[4]: slot A (newest) then slot B (fading out)
    this.look = new Float32Array(4); // attention point xyz, w = how much heads follow it
    this.plan = [];
    this.pending = [];
    this.fired = [];
    this.log = [];
    this.count = 0;
    this._lookSet = false;
    this.look[3] = 1;
  }

  reset() {
    this.u.fill(0);
    this.plan = [];
    this.pending = [];
    this.fired.length = 0;
    this._lookSet = false;
  }

  // A shot was struck (game.shot: the result is already known): plan its reactions.
  startShot(shot, ctx) {
    this.plan = planReactions(shot, ctx);
    for (const p of this.plan) p.used = false;
  }

  // A shot event during playback (game 'shotEvent'): queue the plan items waiting for it.
  shotEvent(ev, now) {
    if (!ev) return;
    for (const p of this.plan) {
      if (p.used || p.on !== ev.type) continue;
      p.used = true;
      this.pending.push({ at: now + p.delay, p });
    }
  }

  // Start a reaction now: the previous one moves to slot B and fades out within ~0.6 s.
  trigger(type, o, now) {
    const u = this.u;
    if (u[0] > 0) {
      for (let k = 0; k < 8; k++) u[8 + k] = u[k];
      u[14] = Math.min(u[14], Math.max(0, now - u[1]) + 0.6);
    }
    u[0] = type;
    u[1] = now;
    u[2] = o.x || 0;
    u[3] = o.y || 0;
    u[4] = o.radius || 45;
    u[5] = o.strength == null ? 1 : o.strength;
    u[6] = o.dur || 2.5;
    u[7] = o.floor || 0;
    this.count++;
    const rec = { type, name: REACT_NAMES[type] || 'idle', t: now, strength: u[5], x: u[2], y: u[3], why: o.why || '' };
    this.fired.push(rec);
    this.log.push(rec);
    if (this.log.length > 24) this.log.shift();
    return rec;
  }

  // Once per frame: start due reactions and ease the attention point toward the ball.
  update(now, ball, dt = 1 / 60) {
    this.fired.length = 0;
    if (this.pending.length) {
      for (let k = 0; k < this.pending.length; k++) {
        const q = this.pending[k];
        if (q.at <= now) {
          this.trigger(q.p.type, q.p, now);
          this.pending.splice(k, 1);
          k--;
        }
      }
    }
    const L = this.look;
    if (ball) {
      const jump = Math.abs(ball.x - L[0]) + Math.abs(ball.y - L[1]) > 60;
      if (!this._lookSet || jump) {
        L[0] = ball.x;
        L[1] = ball.y;
        L[2] = ball.z;
        this._lookSet = true;
      } else {
        const k = 1 - Math.exp(-Math.min(0.2, Math.max(0, dt)) * 7);
        L[0] += (ball.x - L[0]) * k;
        L[1] += (ball.y - L[1]) * k;
        L[2] += (ball.z - L[2]) * k;
      }
    }
    return this;
  }

  // The reaction showing at time `now` ('idle' when none): {name, type, t0, strength, why}.
  state(now) {
    const u = this.u;
    const on = u[0] > 0 && now <= u[1] + u[6] * 1.25 + 1;
    const last = this.log[this.log.length - 1] || null;
    return { name: on ? REACT_NAMES[u[0]] : 'idle', type: on ? u[0] : 0, t0: u[1], strength: u[5], why: last ? last.why : '', count: this.count };
  }
}
