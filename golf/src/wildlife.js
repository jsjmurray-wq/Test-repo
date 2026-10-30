// Wildlife (docs/architecture.md section 10): the animals of each course theme, placed in their
// habitats per hole and simulated as they graze, wander, swim, soar and flee. Pure module: no DOM,
// no GL; deterministic for a given seed and sequence of dt and events; nothing here touches the
// ball (physics never sees an animal). The renderer draws what write() produces (wildlife pass).
//
//   const wild = new Wildlife(terrain, {seed = wildlifeSeed(terrain), wind = {x, y}});
//   wild.update(dt, ctx)     ctx (a reused object, scalars only): {golfer (bool), gx, gy (golfer),
//                            address (bool), bx, by, yaw, carry (the shot about to be played), wx, wy
//                            (wind m/s)}. A new address spot (a camera cut) first moves animals out
//                            of the view corridor and away from the golfer, unseen.
//   wild.ballLanded(x, y, surface?)   flush animals near a landing (or bounce, tree, splash)
//   wild.cheer(x, y, strength 0..1)   a crowd roar: birds lift, nearby animals look up or bolt
//   wild.write(inst, shadow) -> count  instance rows (INST_FLOATS each) and contact shadows
//                            (SHADOW_FLOATS each, wild.shadowCount); allocation free
//   wild.pollCall(out) -> bool        the next animal call {kind, x, y, z} for the audio
//   wild.n, wild.slots (mesh ids by slot), wild.stats {landings, flushes, cheers, relocated}
//   wild.snapshot() -> [{species, mesh, state, x, y, z, vis, home...}] (tests and debug)
//
// Instance row (render.js / WILD_VS):
//   [x, y, z, yaw] [slot + 0.5 * vis, headDown, seed, phase (cycles)]
//   mammals [gait (0 stand .. 1 walk .. 2 run), alert pose, head turn, body pitch]
//   birds   [fly (0 rest pose .. 1 flight pose; -1 swimming), flap (in flight) | walk (on foot),
//            bank, pitch]
// Shadow row: [x, y, ground z, yaw] [half length, half width, alpha, 0] [ground normal, 0].
//
// Species by theme (FAUNA): parkland deer, grey squirrels, mallards and Canada geese on ponds, a
// songbird flock, a grey heron; desert roadrunner, jackrabbits, red-tailed hawks on thermals,
// chuckwallas on rocks, a Gambel's quail covey, a distant coyote; tropical brown pelicans gliding
// in line along the shore, flamingos in the lagoon shallows, egrets, iguanas, parrots flying
// between palms; links kittiwakes and herring gulls hanging in the wind over the dunes, rabbits
// in the fescue, oystercatchers on the beach, blackface sheep in the far dunes.

import { SURF } from './constants.js';
import { mulberry32 } from './rng.js';
import { themeFor } from './themes.js';
import { MESH_PARAMS, KIND } from './wildlife-mesh.js';
import { rockMesh } from './meshes.js';

export const MAX_ANIMALS = 40; // per hole (the budget is under 40)
export const INST_FLOATS = 12;
export const SHADOW_FLOATS = 12;
const MAX_CALLS = 8;
const TAU = Math.PI * 2;
const G = 9.81;

// States (snapshot().state is the name).
export const ST = Object.freeze({
  IDLE: 0, GRAZE: 1, WALK: 2, RUN: 3, ALERT: 4, HIDE: 5, SWIM: 6, TAKEOFF: 7, FLY: 8, LAND: 9,
  SOAR: 10, HOVER: 11, CLIMB: 12, PASS: 13, BASK: 14, PERCH: 15, STARTLE: 16,
});
export const STATE_NAMES = Object.freeze(Object.keys(ST));
// What a flight is for (fm): land at the target, leave and hide, fly a waypoint then come home
// and land, perch out of sight (a tree or a palm crown), return to hovering.
const FM_LAND = 0;
const FM_EXIT = 1;
const FM_LOOP = 2;
const FM_PERCH = 3;
const FM_HOVER = 4;
const FM_PARKED = 9; // hidden by a relocation that found no spot (tried again at the next one)

// ------------------------------------------------------------------ species
// mode: ground | swim | wade | soar | hover | pass | perch (how it lives); habitat: where it is
// placed; flee: what it does when flushed; flushR (m from a landing ball), golferR (m from the
// golfer); walk / run (m/s), stride / runStride (m per gait cycle); roam (m round home); rest
// weights {graze, idle, walk}; flight {cruise m/s, alt m, flapHz, glide 0..1, climb m/s, turn
// rad/s}; hideT (s in cover before it comes back); call / alarm: audio kinds (audio.js call()).
const SPECIES_DEFS = {
  deer: {
    variants: [['doe', 0.75], ['buck', 0.25]], mode: 'ground', habitat: 'woodsEdge', group: [2, 4], spread: 7,
    flee: 'cover', flushR: 26, golferR: 48, walk: 0.8, run: 8.5, stride: 1.5, runStride: 3.8, turn: 2.2, roam: 9,
    rest: { graze: 0.62, idle: 0.24, walk: 0.14 }, fleeDist: [22, 34], hideT: [35, 70], alarm: 'deer',
  },
  squirrel: {
    variants: [['squirrel', 1]], mode: 'ground', habitat: 'treeFoot', group: [1, 1], count: [2, 3], spread: 0,
    flee: 'climb', flushR: 12, golferR: 15, walk: 1.1, run: 4.5, stride: 0.32, runStride: 0.75, turn: 5, roam: 4,
    rest: { graze: 0.5, idle: 0.35, walk: 0.15 }, hideT: [18, 40],
  },
  mallard: {
    variants: [['mallardDrake', 0.55], ['mallardHen', 0.45]], mode: 'swim', habitat: 'pondWater', group: [3, 6], spread: 5,
    flee: 'flyAway', flushR: 22, golferR: 26, walk: 0.45, swim: 0.35, stride: 0.12, turn: 1.6, roam: 12,
    flight: { cruise: 15, alt: 14, flapHz: 6, glide: 0.05, climb: 3.5, turn: 1.2 }, hideT: [25, 55],
    call: { kind: 'duck', every: [9, 24] }, alarm: 'duck',
  },
  goose: {
    variants: [['goose', 1]], mode: 'swim', habitat: 'pondWater', bank: 0.5, group: [3, 6], spread: 6,
    flee: 'flyLoop', flushR: 24, golferR: 30, walk: 0.5, swim: 0.4, stride: 0.22, turn: 1.4, roam: 12,
    rest: { graze: 0.6, idle: 0.25, walk: 0.15 },
    flight: { cruise: 15, alt: 20, flapHz: 3.1, glide: 0.1, climb: 3, turn: 0.7 }, hideT: [20, 40],
    call: { kind: 'goose', every: [10, 26] }, alarm: 'goose',
  },
  songbird: {
    variants: [['songbird', 1]], mode: 'ground', habitat: 'woodsEdge', group: [6, 9], spread: 3.5,
    flee: 'toTrees', flushR: 15, golferR: 17, walk: 0.7, run: 1.2, stride: 0.09, runStride: 0.12, turn: 6, roam: 4,
    rest: { graze: 0.7, idle: 0.2, walk: 0.1 }, hop: true,
    flight: { cruise: 9, alt: 6, flapHz: 15, glide: 0.4, climb: 3, turn: 3 }, hideT: [15, 35],
    call: { kind: 'songbird', every: [4, 10] }, alarm: 'songbird',
  },
  heron: {
    variants: [['heron', 1]], mode: 'wade', habitat: 'pondShallow', group: [1, 1], spread: 0,
    flee: 'flyAway', flushR: 28, golferR: 40, walk: 0.3, run: 0.6, stride: 0.45, runStride: 0.6, turn: 1, roam: 10,
    rest: { graze: 0.25, idle: 0.6, walk: 0.15 },
    flight: { cruise: 9, alt: 11, flapHz: 2.2, glide: 0.2, climb: 1.8, turn: 0.6 }, hideT: [30, 60],
    call: { kind: 'heron', every: [45, 90] }, alarm: 'heron',
  },
  roadrunner: {
    variants: [['roadrunner', 1]], mode: 'ground', habitat: 'desertScrub', group: [1, 1], count: [1, 2], spread: 0,
    flee: 'away', flushR: 18, golferR: 24, walk: 1.0, run: 7, stride: 0.3, runStride: 0.9, turn: 4, roam: 14,
    rest: { graze: 0.3, idle: 0.35, walk: 0.35 }, fleeDist: [22, 40], dash: true,
  },
  jackrabbit: {
    variants: [['jackrabbit', 1]], mode: 'ground', habitat: 'desertScrub', group: [1, 1], count: [2, 3], spread: 0,
    flee: 'away', flushR: 20, golferR: 26, walk: 0.9, run: 9, stride: 0.45, runStride: 2.4, turn: 4, roam: 8,
    rest: { graze: 0.55, idle: 0.35, walk: 0.1 }, fleeDist: [40, 70], zigzag: true,
  },
  hawk: {
    variants: [['hawk', 1]], mode: 'soar', habitat: 'thermal', group: [1, 1], count: [1, 2], spread: 0,
    flight: { cruise: 10, alt: 60, flapHz: 3.5, glide: 0.92, climb: 1.5, turn: 0.6 },
    call: { kind: 'hawk', every: [22, 55] },
  },
  lizard: {
    variants: [['lizard', 1]], mode: 'ground', habitat: 'rockTop', group: [1, 1], count: [3, 5], spread: 0,
    flee: 'crevice', flushR: 7, golferR: 9, walk: 0.3, run: 2.5, stride: 0.12, runStride: 0.3, turn: 6, roam: 0.2,
    rest: { bask: 1 }, hideT: [15, 35],
  },
  quail: {
    variants: [['quail', 1]], mode: 'ground', habitat: 'desertScrub', group: [6, 9], spread: 3,
    flee: 'flyShort', flushR: 16, golferR: 20, walk: 0.55, run: 3.5, stride: 0.1, runStride: 0.22, turn: 5, roam: 6,
    rest: { graze: 0.6, idle: 0.15, walk: 0.25 },
    flight: { cruise: 11, alt: 2.5, flapHz: 16, glide: 0.5, climb: 3, turn: 2 },
    call: { kind: 'quail', every: [10, 22] }, alarm: 'wings',
  },
  coyote: {
    variants: [['coyote', 1]], mode: 'ground', habitat: 'farDesert', group: [1, 1], spread: 0,
    flee: 'away', flushR: 30, golferR: 60, walk: 1.3, run: 6, stride: 1.3, runStride: 2.4, turn: 2, roam: 35,
    rest: { graze: 0.15, idle: 0.35, walk: 0.5 }, fleeDist: [60, 100],
    call: { kind: 'coyote', every: [60, 140] },
  },
  pelican: {
    variants: [['pelican', 1]], mode: 'pass', habitat: 'shoreLine', group: [3, 5], spread: 0,
    flight: { cruise: 9.5, alt: 4.5, flapHz: 2.3, glide: 0.75, climb: 1, turn: 0.5 }, hideT: [18, 45],
  },
  flamingo: {
    variants: [['flamingo', 1]], mode: 'wade', habitat: 'lagoonShallow', group: [5, 8], spread: 4,
    flee: 'flyShort', flushR: 18, golferR: 30, walk: 0.35, run: 1.4, stride: 0.55, runStride: 0.9, turn: 1.2, roam: 9,
    rest: { graze: 0.7, idle: 0.2, walk: 0.1 },
    flight: { cruise: 12, alt: 9, flapHz: 2.8, glide: 0.1, climb: 2, turn: 0.6 },
    call: { kind: 'flamingo', every: [12, 30] }, alarm: 'flamingo',
  },
  egret: {
    variants: [['egret', 1]], mode: 'wade', habitat: 'pondShallow', group: [1, 1], count: [1, 2], spread: 0,
    flee: 'flyAway', flushR: 24, golferR: 34, walk: 0.3, run: 0.6, stride: 0.42, runStride: 0.6, turn: 1, roam: 10,
    rest: { graze: 0.35, idle: 0.5, walk: 0.15 },
    flight: { cruise: 9, alt: 10, flapHz: 2.6, glide: 0.2, climb: 1.8, turn: 0.7 }, hideT: [30, 60],
  },
  iguana: {
    variants: [['iguana', 1]], mode: 'ground', habitat: 'beachOrPalms', group: [1, 1], count: [2, 3], spread: 0,
    flee: 'crevice', flushR: 9, golferR: 12, walk: 0.25, run: 2.2, stride: 0.25, runStride: 0.5, turn: 2, roam: 2,
    rest: { bask: 0.8, walk: 0.2 }, hideT: [20, 45],
  },
  parrot: {
    variants: [['parrot', 1]], mode: 'perch', habitat: 'palms', group: [4, 6], spread: 2.5,
    flight: { cruise: 13, alt: 14, flapHz: 9, glide: 0.05, climb: 3, turn: 1.6 }, hideT: [12, 32],
    call: { kind: 'parrot', every: [3, 7] },
  },
  gull: {
    variants: [['kittiwake', 0.6], ['herringGull', 0.4]], mode: 'hover', habitat: 'dunesAir', group: [1, 1], count: [4, 6], spread: 0,
    flight: { cruise: 9, alt: 14, flapHz: 3.4, glide: 0.8, climb: 1.5, turn: 0.9 },
    call: { kind: 'gull', every: [6, 16] },
  },
  rabbit: {
    variants: [['rabbit', 1]], mode: 'ground', habitat: 'fescueNear', group: [2, 3], count: [2, 2], spread: 6,
    flee: 'burrow', flushR: 15, golferR: 20, walk: 0.7, run: 6, stride: 0.3, runStride: 1.3, turn: 5, roam: 6,
    rest: { graze: 0.65, idle: 0.3, walk: 0.05 }, hideT: [18, 45],
  },
  oystercatcher: {
    variants: [['oystercatcher', 1]], mode: 'ground', habitat: 'beach', group: [2, 4], spread: 4,
    flee: 'flyShort', flushR: 20, golferR: 26, walk: 0.5, run: 2.2, stride: 0.18, runStride: 0.3, turn: 4, roam: 8,
    rest: { graze: 0.65, idle: 0.2, walk: 0.15 },
    flight: { cruise: 13, alt: 3, flapHz: 6, glide: 0.1, climb: 2, turn: 1.6 },
    call: { kind: 'oystercatcher', every: [9, 24] }, alarm: 'oystercatcher',
  },
  sheep: {
    variants: [['sheep', 1]], mode: 'ground', habitat: 'farDunes', group: [3, 4], spread: 6,
    flee: 'shuffle', flushR: 9, golferR: 22, walk: 0.5, run: 1.6, stride: 0.75, runStride: 1.1, turn: 1.2, roam: 10,
    rest: { graze: 0.8, idle: 0.12, walk: 0.08 }, fleeDist: [10, 18],
    call: { kind: 'sheep', every: [18, 45] },
  },
};
const SPECIES_LIST = Object.keys(SPECIES_DEFS).map((name, id) => {
  const d = { name, id, ...SPECIES_DEFS[name] };
  const m = MESH_PARAMS[d.variants[0][0]];
  d.size = m.size;
  d.len = m.len;
  d.wid = m.wid;
  d.bird = m.kind === KIND.BIRD;
  d.rest = d.rest || { idle: 1 };
  return Object.freeze(d);
});
export const SPECIES = Object.freeze(Object.fromEntries(SPECIES_LIST.map((d) => [d.name, d])));

// Species by course theme, in placement order (the first ones get the budget first).
export const FAUNA = Object.freeze({
  parkland: ['deer', 'mallard', 'goose', 'heron', 'songbird', 'squirrel'],
  desert: ['hawk', 'lizard', 'jackrabbit', 'quail', 'roadrunner', 'coyote'],
  tropical: ['flamingo', 'pelican', 'egret', 'parrot', 'iguana'],
  links: ['gull', 'rabbit', 'oystercatcher', 'sheep'],
});
// Ambient calls with no animal in view (birdsong from the woods, a lark over the links), per theme.
const AMBIENT = {
  parkland: [{ kind: 'songbird', every: [3, 8], r: [40, 140] }, { kind: 'woodpigeon', every: [14, 30], r: [60, 180] }],
  desert: [{ kind: 'dove', every: [12, 28], r: [60, 200] }, { kind: 'wren', every: [9, 20], r: [30, 120] }],
  tropical: [{ kind: 'tropical', every: [5, 12], r: [40, 160] }, { kind: 'parrot', every: [16, 34], r: [80, 200] }],
  links: [{ kind: 'lark', every: [12, 26], r: [30, 90] }, { kind: 'gull', every: [9, 20], r: [80, 220] }],
};

// The mesh ids of a theme in slot order (one slot per variant mesh).
export function themeSlots(theme) {
  const list = FAUNA[theme] || FAUNA.parkland;
  const out = [];
  for (const s of list) for (const [m] of SPECIES[s].variants) if (!out.includes(m)) out.push(m);
  return out;
}

// Seed for a hole's animals (course id and hole number): the same every visit.
export function wildlifeSeed(terrain) {
  let h = 2166136261;
  const s = `${terrain.courseId || 'pines'}:${terrain.n || 0}:wildlife`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// The address view corridor: the camera behind the ball, the ball and golfer, and the flight down
// the aim line to beyond the carry, widening with distance. Animals never stand in it while the
// player addresses the ball. c = {bx, by, dx, dy (unit aim), len (carry)}.
export function inCorridor(c, x, y) {
  const rx = x - c.bx;
  const ry = y - c.by;
  const a = rx * c.dx + ry * c.dy;
  if (a < -32 || a > c.len + 32) return false;
  const l = Math.abs(-rx * c.dy + ry * c.dx);
  return l < Math.min(28, 9 + 0.1 * Math.max(0, a));
}

// ------------------------------------------------------------------ terrain helpers
function sgAt(t, x, y) {
  const g = t.sgrid;
  if (!g) return t.surfaceAt(x, y);
  const i = Math.floor((x - g.minX) / g.step);
  const j = Math.floor((y - g.minY) / g.step);
  if (i < 0 || j < 0 || i >= g.nx || j >= g.ny) return SURF.OOB;
  return g.data[j * g.nx + i];
}
const NO_STAND = new Set([SURF.GREEN, SURF.FRINGE, SURF.TEE, SURF.BUNKER, SURF.WATER, SURF.OOB]);
const wrapA = (a) => {
  a %= TAU;
  if (a > Math.PI) a -= TAU;
  else if (a < -Math.PI) a += TAU;
  return a;
};
const clampN = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const approach = (v, target, rate, dt) => v + (target - v) * Math.min(1, rate * dt);

// ------------------------------------------------------------------ habitats (placement only)
// Each finder returns up to n candidate spots {x, y, z, ...} for a species, drawn with rng.
function holeInfo(t) {
  const g = t.green;
  const gr = g ? Math.max(g.rx, g.ry) + (g.fringe || 1) : 15;
  const b = t.bounds;
  return {
    gx: g ? g.cx : t.cup.x, gy: g ? g.cy : t.cup.y, gr,
    tx: t.tee.x, ty: t.tee.y,
    minX: b.minX + 4, minY: b.minY + 4, maxX: b.maxX - 4, maxY: b.maxY - 4,
    L: t.lengthM || 300,
  };
}
// A spot an animal may stand on: inside the bounds, on a standable surface, clear of the green and
// tee, on gentle ground.
function standable(t, H, x, y, { teeR = 40, greenPad = 16 } = {}) {
  if (x < H.minX || x > H.maxX || y < H.minY || y > H.maxY) return false;
  if (NO_STAND.has(sgAt(t, x, y))) return false;
  if (Math.hypot(x - H.gx, y - H.gy) < H.gr + greenPad) return false;
  if (Math.hypot(x - H.tx, y - H.ty) < teeR) return false;
  const gr = t.gradAt(x, y);
  return Math.hypot(gr.x, gr.y) < 0.45;
}
function centreDist(t, x, y) {
  return t.path && t.path.project ? t.path.project(x, y).dist : Math.hypot(x - t.cup.x, y - t.cup.y);
}
function waterInfo(t, x, y) {
  const w = t.waterAt ? t.waterAt(x, y) : null;
  return w ? { level: w.level, depth: w.level - t.heightAt(x, y) } : null;
}
function inSea(t, x, y) {
  for (const w of t.waters || []) {
    if (!w.sea) continue;
    if (w.fill === 'outside') return true;
    if (pointIn(w.poly, x, y)) return true;
  }
  return false;
}
function pointIn(poly, x, y) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
function waterBox(t) {
  // Bounding box of the hole's water (sea flood: the whole hole).
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const w of t.waters || []) for (const p of w.poly) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  return x0 < x1 ? { x0, y0, x1, y1 } : null;
}
function forestTrees(t, kinds) {
  return (t.trees || []).filter((tr) => kinds.includes(tr.kind) && tr.canopy);
}

const FINDERS = {
  // Open ground just outside the canopy of the woods, in view of the hole.
  woodsEdge(t, H, rng, n, opt) {
    const trees = forestTrees(t, ['pine', 'broad', 'palm']);
    const out = [];
    if (!trees.length) return out;
    for (let k = 0; k < 900 && out.length < n; k++) {
      const tr = trees[Math.floor(rng() * trees.length)];
      const a = rng() * TAU;
      const r = tr.canopy.rx + 2 + rng() * 5;
      const x = tr.x + Math.cos(a) * r;
      const y = tr.y + Math.sin(a) * r;
      if (!standable(t, H, x, y, { teeR: opt.teeR || 45 })) continue;
      const cd = centreDist(t, x, y);
      if (cd < (opt.minC || 16) || cd > (opt.maxC || 75)) continue;
      // Under no canopy, and open toward the hole (no trunk in the way 6 m nearer the line).
      const near = t.treesNear(x, y, 1.5);
      if (near.some((o) => o.canopy && Math.hypot(o.x - x, o.y - y) < o.canopy.rx * 0.8 + 0.6)) continue;
      out.push({ x, y, z: t.heightAt(x, y), cx: tr.x, cy: tr.y, tree: tr });
    }
    return out;
  },
  // Near the foot of a tree (squirrels): the tree to climb.
  treeFoot(t, H, rng, n, opt) {
    const trees = forestTrees(t, ['pine', 'broad']);
    const out = [];
    if (!trees.length) return out;
    for (let k = 0; k < 600 && out.length < n; k++) {
      const tr = trees[Math.floor(rng() * trees.length)];
      const a = rng() * TAU;
      const r = (tr.trunkR || 0.3) + 1.2 + rng() * 3.5;
      const x = tr.x + Math.cos(a) * r;
      const y = tr.y + Math.sin(a) * r;
      if (!standable(t, H, x, y, { teeR: opt.teeR || 30 })) continue;
      const cd = centreDist(t, x, y);
      if (cd < 14 || cd > 60) continue;
      out.push({ x, y, z: t.heightAt(x, y), tree: tr });
    }
    return out;
  },
  // Open water (not the sea), at least 0.35 m deep and 2.5 m from the shore.
  pondWater(t, H, rng, n, opt) {
    const box = waterBox(t);
    const out = [];
    if (!box) return out;
    for (let k = 0; k < 1500 && out.length < n; k++) {
      const x = box.x0 + rng() * (box.x1 - box.x0);
      const y = box.y0 + rng() * (box.y1 - box.y0);
      if (x < H.minX || x > H.maxX || y < H.minY || y > H.maxY) continue;
      if (sgAt(t, x, y) !== SURF.WATER || inSea(t, x, y)) continue;
      const w = waterInfo(t, x, y);
      if (!w || w.depth < 0.35) continue;
      let ok = true;
      for (let q = 0; q < 6 && ok; q++) ok = sgAt(t, x + Math.cos(q) * 2.5, y + Math.sin(q) * 2.5) === SURF.WATER;
      if (!ok || Math.hypot(x - H.gx, y - H.gy) < H.gr + 6 || Math.hypot(x - H.tx, y - H.ty) < (opt.teeR || 25)) continue;
      if (opt.bank && rng() < opt.bank) {
        // On the grass of the bank instead (geese graze there): walk out of the water.
        const a = rng() * TAU;
        for (let r = 3; r < 40; r += 1.5) {
          const bx = x + Math.cos(a) * r;
          const by = y + Math.sin(a) * r;
          const s = sgAt(t, bx, by);
          if (s === SURF.WATER) continue;
          if ((s === SURF.ROUGH || s === SURF.FAIRWAY) && standable(t, H, bx + Math.cos(a) * 2, by + Math.sin(a) * 2, { teeR: 30 })) {
            const px = bx + Math.cos(a) * 3;
            const py = by + Math.sin(a) * 3;
            out.push({ x: px, y: py, z: t.heightAt(px, py), bank: true, level: w.level });
          }
          break;
        }
        continue;
      }
      out.push({ x, y, z: w.level, level: w.level });
    }
    return out;
  },
  // Wading depth (0.06-0.45 m of water over the bed) near the shore; not the sea.
  pondShallow(t, H, rng, n, opt) {
    const box = waterBox(t);
    const out = [];
    if (!box) return out;
    for (let k = 0; k < 4000 && out.length < n; k++) {
      const x = box.x0 + rng() * (box.x1 - box.x0);
      const y = box.y0 + rng() * (box.y1 - box.y0);
      if (x < H.minX || x > H.maxX || y < H.minY || y > H.maxY) continue;
      if (sgAt(t, x, y) !== SURF.WATER) continue;
      if (!opt.sea && inSea(t, x, y)) continue;
      const w = waterInfo(t, x, y);
      if (!w || w.depth < 0.06 || w.depth > (opt.maxDepth || 0.45)) continue;
      if (Math.hypot(x - H.gx, y - H.gy) < H.gr + 10 || Math.hypot(x - H.tx, y - H.ty) < Math.max(35, opt.teeR || 0)) continue;
      out.push({ x, y, z: t.heightAt(x, y), level: w.level });
    }
    return out;
  },
  lagoonShallow(t, H, rng, n, opt) {
    return FINDERS.pondShallow(t, H, rng, n, { ...opt, maxDepth: 0.55 });
  },
  // On top of a boulder in view (chuckwallas bask there).
  rockTop(t, H, rng, n, opt) {
    const rocks = (t.trees || []).filter((o) => o.kind === 'rock' && o.trunkH >= 0.4 && o.trunkR >= 0.45);
    const out = [];
    for (let k = 0; k < 400 && out.length < n && rocks.length; k++) {
      const r = rocks[Math.floor(rng() * rocks.length)];
      if (out.some((o) => o.rock === r)) continue;
      const cd = centreDist(t, r.x, r.y);
      if (cd < 12 || cd > 60 || Math.hypot(r.x - H.tx, r.y - H.ty) < Math.max(25, opt.teeR || 0) || Math.hypot(r.x - H.gx, r.y - H.gy) < H.gr + 8) continue;
      const top = rockTop(r);
      out.push({ x: top.x, y: top.y, z: top.z, yaw: top.yaw, rock: r });
    }
    return out;
  },
  desertScrub(t, H, rng, n, opt) {
    return groundScatter(t, H, rng, n, [SURF.DESERT, SURF.WASTE], opt.minC || 16, opt.maxC || 70, Math.max(40, opt.teeR || 0));
  },
  farDesert(t, H, rng, n, opt) {
    return groundScatter(t, H, rng, n, [SURF.DESERT], 55, 400, Math.max(110, opt.teeR || 0));
  },
  fescueNear(t, H, rng, n, opt) {
    return groundScatter(t, H, rng, n, [SURF.FESCUE, SURF.ROUGH], 20, 58, Math.max(40, opt.teeR || 0));
  },
  farDunes(t, H, rng, n, opt) {
    return groundScatter(t, H, rng, n, [SURF.FESCUE], 58, 400, Math.max(80, opt.teeR || 0));
  },
  // Beach or waste sand within 14 m of water (oystercatchers, iguanas).
  beach(t, H, rng, n, opt = {}) {
    const cand = groundScatter(t, H, rng, n * 6, [SURF.WASTE], 0, 400, Math.max(35, opt.teeR || 0));
    const out = [];
    for (const c of cand) {
      let wet = false;
      for (let q = 0; q < 8 && !wet; q++) for (const r of [5, 10, 14]) if (sgAt(t, c.x + Math.cos(q * 0.785) * r, c.y + Math.sin(q * 0.785) * r) === SURF.WATER) wet = true;
      if (wet) out.push(c);
      if (out.length >= n) break;
    }
    return out;
  },
  beachOrPalms(t, H, rng, n, opt) {
    const out = FINDERS.beach(t, H, rng, n, opt);
    if (out.length >= n) return out;
    const palms = (t.trees || []).filter((o) => o.kind === 'palm');
    for (let k = 0; k < 600 && out.length < n && palms.length; k++) {
      const p = palms[Math.floor(rng() * palms.length)];
      const a = rng() * TAU;
      const x = p.x + Math.cos(a) * (2 + rng() * 4);
      const y = p.y + Math.sin(a) * (2 + rng() * 4);
      if (!standable(t, H, x, y, { teeR: Math.max(35, opt.teeR || 0) })) continue;
      const cd = centreDist(t, x, y);
      if (cd < 14 || cd > 60) continue;
      out.push({ x, y, z: t.heightAt(x, y) });
    }
    return out;
  },
  // A thermal over the desert off the line of the hole: centre, radius, height.
  thermal(t, H, rng, n) {
    const out = [];
    for (let k = 0; k < 300 && out.length < n; k++) {
      const s = H.L * (0.15 + rng() * 0.8);
      const p = t.path.pointAt(s);
      const tg = t.path.tangentAt(s);
      const side = rng() < 0.5 ? -1 : 1;
      const off = 45 + rng() * 90;
      const x = p.x + tg.y * off * side;
      const y = p.y - tg.x * off * side;
      out.push({ x, y, z: t.heightAt(clampN(x, H.minX, H.maxX), clampN(y, H.minY, H.maxY)) + 45 + rng() * 40, r: 28 + rng() * 22 });
    }
    return out;
  },
  // Where gulls hang in the wind: over the dunes off the line, 9-22 m up.
  dunesAir(t, H, rng, n) {
    const out = groundScatter(t, H, rng, n, [SURF.FESCUE, SURF.WASTE, SURF.ROUGH], 22, 75, 30);
    for (const o of out) o.z += 9 + rng() * 13;
    return out;
  },
  // Palm crowns (parrots perch out of sight in them).
  palms(t, H, rng, n) {
    const palms = (t.trees || []).filter((o) => o.kind === 'palm' && o.canopy);
    const out = [];
    for (const p of palms) {
      const cd = centreDist(t, p.x, p.y);
      if (cd > 12 && cd < 90 && Math.hypot(p.x - H.tx, p.y - H.ty) > 20) out.push({ x: p.x, y: p.y, z: p.canopy.cz, palm: p });
    }
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = out[i];
      out[i] = out[j];
      out[j] = tmp;
    }
    return out.slice(0, n);
  },
  // A line over the water for pelicans to glide along: from a to b, 4-7 m above the water.
  shoreLine(t, H, rng, n) {
    const box = waterBox(t);
    const out = [];
    if (!box) return out;
    const wet = (x, y) => sgAt(t, x, y) === SURF.WATER || x < H.minX || x > H.maxX || y < H.minY || y > H.maxY;
    for (let k = 0; k < 600 && out.length < n; k++) {
      const x = box.x0 + rng() * (box.x1 - box.x0);
      const y = box.y0 + rng() * (box.y1 - box.y0);
      if (sgAt(t, x, y) !== SURF.WATER) continue;
      const w = waterInfo(t, x, y);
      if (!w) continue;
      const a = rng() * Math.PI;
      const dx = Math.cos(a);
      const dy = Math.sin(a);
      let good = 0;
      for (let s = -100; s <= 100; s += 20) if (wet(x + dx * s, y + dy * s)) good++;
      if (good < 9) continue;
      if (Math.hypot(x - H.tx, y - H.ty) < 30) continue;
      out.push({ x, y, z: w.level + 4 + rng() * 3, dx, dy, level: w.level });
    }
    return out;
  },
};

// The flattest high spot on a boulder as the renderer draws it (meshes.js rockMesh, shaped per
// instance like OBJ_VS: stretched by variant, turned by it, a quarter of it buried), for a lizard
// 0.4 m long: {x, y, z, yaw} with the body lying along the ridge.
let ROCK = null;
function rockTop(r) {
  if (!ROCK) ROCK = rockMesh();
  const seed = r.variant != null ? r.variant : 0.5;
  const fr = (v) => v - Math.floor(v);
  const R = r.trunkR || 0.6;
  const h = r.trunkH || 0.6;
  const sx = R * (0.85 + 0.35 * fr(seed * 3.1));
  const sy = R * (0.85 + 0.35 * fr(seed * 5.7));
  const sz = h * 0.78;
  const ang = seed * 43.98;
  const ca = Math.cos(ang);
  const sa = Math.sin(ang);
  const P = ROCK.pos;
  const I = ROCK.idx;
  const pt = (k) => {
    const x = P[k * 3] * sx;
    const y = P[k * 3 + 1] * sy;
    return [r.x + x * ca - y * sa, r.y + x * sa + y * ca, r.z + h * 0.25 + P[k * 3 + 2] * sz];
  };
  const T = [];
  for (let k = 0; k < I.length; k += 3) T.push([pt(I[k]), pt(I[k + 1]), pt(I[k + 2])]);
  // Surface height under (x, y): the highest triangle covering it.
  const zAt = (x, y) => {
    let best = -Infinity;
    for (const [a, b, c] of T) {
      const d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
      if (Math.abs(d) < 1e-9) continue;
      const l1 = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / d;
      const l2 = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / d;
      const l3 = 1 - l1 - l2;
      if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
      best = Math.max(best, l1 * a[2] + l2 * b[2] + l3 * c[2]);
    }
    return best;
  };
  let out = { x: r.x, y: r.y, z: zAt(r.x, r.y), yaw: 0 };
  let bestScore = -Infinity;
  for (let k = 0; k < 24; k++) {
    const a = (k / 24) * TAU;
    const rr = (k % 3) * 0.12 * R;
    const x = r.x + Math.cos(a * 2.3) * rr;
    const y = r.y + Math.sin(a * 2.3) * rr;
    // The body's ends along heading a must sit on the rock too (no tail in the air or in the rock).
    const zc = zAt(x, y);
    const zf = zAt(x + Math.cos(a) * 0.15, y + Math.sin(a) * 0.15);
    const zb = zAt(x - Math.cos(a) * 0.2, y - Math.sin(a) * 0.2);
    if (!Number.isFinite(zc + zf + zb)) continue;
    const score = zc - 1.5 * (Math.abs(zf - zc) + Math.abs(zb - zc));
    if (score > bestScore) {
      bestScore = score;
      out = { x, y, z: Math.max(zc, zf, zb) - 0.005, yaw: a };
    }
  }
  return out;
}

function groundScatter(t, H, rng, n, surfaces, minC, maxC, teeR = 40) {
  const out = [];
  const b = t.bounds;
  for (let k = 0; k < 2500 && out.length < n; k++) {
    // Along the hole, then out to the side (more samples where the hole is).
    const s = H.L * (-0.05 + rng() * 1.1);
    const p = t.path.pointAt(clampN(s, 0, H.L));
    const tg = t.path.tangentAt(clampN(s, 0, H.L));
    const off = (rng() < 0.5 ? -1 : 1) * (minC + rng() * Math.max(1, Math.min(maxC, 160) - minC));
    const x = p.x + tg.y * off;
    const y = p.y - tg.x * off;
    if (x < b.minX + 4 || x > b.maxX - 4 || y < b.minY + 4 || y > b.maxY - 4) continue;
    if (!surfaces.includes(sgAt(t, x, y))) continue;
    if (!standable(t, H, x, y, { teeR })) continue;
    const cd = centreDist(t, x, y);
    if (cd < minC || cd > maxC) continue;
    if (t.treesNear(x, y, 0.8).some((o) => Math.hypot(o.x - x, o.y - y) < (o.canopy ? o.canopy.rx * 0.8 : o.trunkR + 0.5))) continue;
    out.push({ x, y, z: t.heightAt(x, y) });
  }
  return out;
}

// ------------------------------------------------------------------ the simulation
export class Wildlife {
  constructor(terrain, { seed = wildlifeSeed(terrain), wind = null, theme = terrain.theme } = {}) {
    this.terrain = terrain;
    this.theme = FAUNA[theme] ? theme : 'parkland';
    this.seed = seed >>> 0;
    this.rng = mulberry32(this.seed);
    this.slots = themeSlots(this.theme);
    this.time = 0;
    this.wx = wind ? wind.x : 0;
    this.wy = wind ? wind.y : 0;
    this.stats = { landings: 0, flushes: 0, cheers: 0, relocated: 0 };
    const sun = themeFor(this.theme).sky.sunDir;
    const sl = Math.hypot(sun.x, sun.y, sun.z) || 1;
    this.sun = { x: sun.x / sl, y: sun.y / sl, z: Math.max(0.15, sun.z / sl) };
    this.H = holeInfo(terrain);
    this._nrm = { x: 0, y: 0, z: 1 };
    this.cor = { on: false, bx: 0, by: 0, dx: 1, dy: 0, len: 0 };
    this._spot = { bx: NaN, by: NaN };
    // Per-animal state (typed arrays: nothing is allocated per frame).
    const N = MAX_ANIMALS;
    const F = () => new Float64Array(N);
    this.n = 0;
    this.sp = new Int16Array(N);
    this.slot = new Int16Array(N);
    this.grp = new Int16Array(N);
    this.st = new Int16Array(N);
    this.fm = new Int16Array(N);
    for (const k of ['x', 'y', 'z', 'yaw', 'spd', 'vz', 'tx', 'ty', 'tz', 'hx', 'hy', 'hz', 't', 't2', 'ph', 'gait', 'head', 'alt', 'turn', 'pitch',
      'fly', 'flap', 'bank', 'vis', 'cx', 'cy', 'cz', 'cr', 'ca', 'ox', 'oy', 'lvl', 'seedv', 'aux', 'thx', 'thy', 'look', 'walkAmp', 'fade']) this[k] = F();
    // Groups (flocks, coveys, herds): a shared threat and flight destination.
    this.gN = 0;
    this.gSp = new Int16Array(N);
    this.gx = F();
    this.gy = F();
    this.gz = F();
    this.gT = F();
    this.gS = F(); // pelicans: distance along the pass line
    this.gDx = F(); // pelicans: the line's direction
    this.gDy = F();
    this.gAx = F(); // the way the group flees (unit, away from the threat)
    this.gAy = F();
    this.gDir = new Int8Array(N);
    this.gCall = F();
    this.gLast = F();
    // Per species: candidate spots (relocation, wander targets) and pass lines.
    this.pools = new Map();
    this._place();
    // Calls for the audio (a small ring of reused records) and the ambient chorus.
    this._calls = [];
    for (let k = 0; k < MAX_CALLS; k++) this._calls.push({ kind: '', x: 0, y: 0, z: 0 });
    this._callHead = 0;
    this._callCount = 0;
    this._amb = (AMBIENT[this.theme] || []).map((a) => ({ ...a, t: a.every[0] + this.rng() * (a.every[1] - a.every[0]) }));
    this.shadowCount = 0;
  }

  // ---------------------------------------------------------------- placement
  _place() {
    const t = this.terrain;
    const rng = this.rng;
    const H = this.H;
    for (const name of FAUNA[this.theme]) {
      const S = SPECIES[name];
      // Presence per hole: most species most of the time.
      const chance = { deer: 0.8, goose: 0.75, heron: 0.75, roadrunner: 0.75, quail: 0.8, coyote: 0.6, sheep: 0.75, egret: 0.85, songbird: 0.85 }[name] ?? 1;
      if (rng() > chance) continue;
      const groups = S.count ? S.count[0] + Math.floor(rng() * (S.count[1] - S.count[0] + 1)) : name === 'mallard' && rng() < 0.4 ? 2 : 1;
      // (Placed beyond its comfort distance from the tee: the first address is there.)
      const pool = FINDERS[S.habitat](t, H, rng, 28, { bank: S.bank || 0, teeR: Math.max(30, (S.golferR || 0) * 1.15) });
      this.pools.set(name, pool);
      if (!pool.length) continue;
      let used = 0;
      for (let gi = 0; gi < groups; gi++) {
        const size = S.group[0] + Math.floor(rng() * (S.group[1] - S.group[0] + 1));
        if (this.n + 1 > MAX_ANIMALS) break;
        // Group anchors apart from each other.
        let spot = null;
        for (let k = used; k < pool.length && !spot; k++) {
          const c = pool[k];
          if (this._spotTaken(c.x, c.y, S.group[1] > 1 ? 25 : 8)) continue;
          spot = c;
          used = k + 1;
        }
        if (!spot) break;
        this._addGroup(S, spot, Math.min(size, MAX_ANIMALS - this.n));
      }
    }
  }

  _spotTaken(x, y, r) {
    for (let i = 0; i < this.n; i++) if (Math.hypot(this.hx[i] - x, this.hy[i] - y) < r) return true;
    return false;
  }

  _variant(S) {
    let r = this.rng();
    for (const [m, w] of S.variants) {
      if ((r -= w) <= 0) return m;
    }
    return S.variants[0][0];
  }

  _addGroup(S, spot, size) {
    const rng = this.rng;
    const g = this.gN++;
    this.gSp[g] = S.id;
    this.gx[g] = spot.x;
    this.gy[g] = spot.y;
    this.gz[g] = spot.z;
    this.gCall[g] = S.call ? S.call.every[0] * rng() + 2 : 1e9;
    this.gLast[g] = -1e9;
    this.gDir[g] = 1;
    this.gT[g] = 0;
    this.gS[g] = 0;
    if (S.mode === 'pass') {
      // The pass line: spot = {x, y, dx, dy, z}; the flock starts somewhere along it.
      this.gx[g] = spot.x;
      this.gy[g] = spot.y;
      this.gz[g] = spot.z;
      this.gDx[g] = spot.dx;
      this.gDy[g] = spot.dy;
      this.gS[g] = -220 + rng() * 200;
      this.gDir[g] = rng() < 0.5 ? 1 : -1;
    }
    for (let k = 0; k < size; k++) {
      const i = this.n++;
      this.sp[i] = S.id;
      this.grp[i] = g;
      this.slot[i] = this.slots.indexOf(this._variant(S));
      this.seedv[i] = rng();
      const a = rng() * TAU;
      const r = k === 0 ? 0 : S.spread * (0.4 + 0.6 * Math.sqrt(rng()));
      this.ox[i] = Math.cos(a) * r;
      this.oy[i] = Math.sin(a) * r;
      this.vis[i] = 1;
      this.fade[i] = 1;
      this.yaw[i] = rng() * TAU;
      this.ph[i] = rng();
      this.lvl[i] = spot.level != null ? spot.level : NaN;
      this._initAnimal(i, S, spot, k);
    }
  }

  _initAnimal(i, S, spot, k) {
    const t = this.terrain;
    const rng = this.rng;
    let x = spot.x + this.ox[i];
    let y = spot.y + this.oy[i];
    switch (S.mode) {
      case 'soar':
        this.cx[i] = spot.x;
        this.cy[i] = spot.y;
        this.cz[i] = spot.z;
        this.cr[i] = spot.r;
        this.ca[i] = rng() * TAU;
        this.x[i] = spot.x + Math.cos(this.ca[i]) * spot.r;
        this.y[i] = spot.y + Math.sin(this.ca[i]) * spot.r;
        this.z[i] = spot.z;
        this.st[i] = ST.SOAR;
        this.fly[i] = 1;
        this.spd[i] = S.flight.cruise;
        break;
      case 'hover':
        this.cx[i] = spot.x;
        this.cy[i] = spot.y;
        this.cz[i] = spot.z;
        this.cr[i] = 12 + rng() * 10;
        this.ca[i] = rng() * TAU;
        this.x[i] = spot.x;
        this.y[i] = spot.y;
        this.z[i] = spot.z;
        this.st[i] = ST.HOVER;
        this.fly[i] = 1;
        break;
      case 'pass':
        this.st[i] = ST.PASS;
        this.fly[i] = 1;
        this.x[i] = spot.x;
        this.y[i] = spot.y;
        this.z[i] = spot.z;
        this.aux[i] = k; // place in the line
        break;
      case 'perch':
        this.st[i] = ST.PERCH;
        this.vis[i] = 0;
        this.fade[i] = 0;
        this.x[i] = spot.x + this.ox[i] * 0.3;
        this.y[i] = spot.y + this.oy[i] * 0.3;
        this.z[i] = spot.z;
        this.t[i] = 3 + rng() * 14;
        break;
      default: {
        // Ground, swimmers and waders: a valid spot near the group anchor.
        if (S.mode === 'swim' && !spot.bank) {
          if (!this._wet(x, y)) {
            x = spot.x;
            y = spot.y;
          }
          this.z[i] = spot.level - MESH_PARAMS[this._mesh(i)].draft;
          this.st[i] = ST.SWIM;
          this.fly[i] = -1;
        } else if (S.mode === 'wade') {
          // (A wading spot near the anchor, never on top of another bird.)
          for (let k = 0; k < 12 && (!this._shallow(x, y, i) || this._crowded(x, y, i, 0.9)); k++) {
            const a = rng() * TAU;
            const r = (0.8 + 0.5 * k) * Math.max(1, S.spread * 0.5);
            x = spot.x + Math.cos(a) * r;
            y = spot.y + Math.sin(a) * r;
          }
          if (!this._shallow(x, y, i)) {
            x = spot.x;
            y = spot.y;
          }
          this.z[i] = t.heightAt(x, y);
          this.st[i] = ST.IDLE;
        } else if (S.habitat === 'rockTop') {
          x = spot.x;
          y = spot.y;
          this.z[i] = spot.z;
          if (spot.yaw != null) this.yaw[i] = spot.yaw;
          this.st[i] = ST.BASK;
          this.cz[i] = spot.z;
          this.cr[i] = spot.rock ? spot.rock.trunkR : 0.5;
        } else {
          if (!this._okStand(x, y)) {
            x = spot.x;
            y = spot.y;
          }
          this.z[i] = t.heightAt(x, y);
          this.st[i] = S.rest.bask ? ST.BASK : ST.GRAZE;
          if (spot.tree) {
            this.cx[i] = spot.tree.x;
            this.cy[i] = spot.tree.y;
            this.cr[i] = spot.tree.trunkR || 0.3;
            this.cz[i] = spot.tree.canopy ? spot.tree.canopy.cz - spot.tree.canopy.rz * 0.6 : 5;
          }
          if (S.flee === 'burrow') {
            // The burrow: a little way off toward the rough's edge (out of the fescue).
            const a = this.rng() * TAU;
            this.cx[i] = x + Math.cos(a) * (4 + this.rng() * 6);
            this.cy[i] = y + Math.sin(a) * (4 + this.rng() * 6);
          }
          if (spot.bank) this.lvl[i] = spot.level;
        }
        this.x[i] = x;
        this.y[i] = y;
        this.t[i] = 1 + rng() * 6;
      }
    }
    this.hx[i] = this.x[i];
    this.hy[i] = this.y[i];
    this.hz[i] = this.z[i];
  }

  _mesh(i) {
    return this.slots[this.slot[i]];
  }

  // Another animal already stands within r of (x, y)?
  _crowded(x, y, i, r) {
    for (let j = 0; j < this.n; j++) if (j !== i && Math.abs(this.x[j] - x) < r && Math.abs(this.y[j] - y) < r) return true;
    return false;
  }

  _wet(x, y) {
    return sgAt(this.terrain, x, y) === SURF.WATER;
  }

  // Wading depth at (x, y) for animal i (its water's level): a few cm to about half a metre.
  _shallow(x, y, i) {
    if (sgAt(this.terrain, x, y) !== SURF.WATER) return false;
    const lv = this.lvl[i];
    if (Number.isNaN(lv)) return true;
    const d = lv - this.terrain.heightAt(x, y);
    return d > 0.03 && d < 0.58;
  }

  _okStand(x, y) {
    const H = this.H;
    if (x < H.minX || x > H.maxX || y < H.minY || y > H.maxY) return false;
    const s = sgAt(this.terrain, x, y);
    if (s === SURF.WATER || s === SURF.OOB || s === SURF.GREEN || s === SURF.FRINGE || s === SURF.TEE || s === SURF.BUNKER) return false;
    const dx = x - H.gx;
    const dy = y - H.gy;
    return dx * dx + dy * dy > (H.gr + 8) * (H.gr + 8);
  }

  setWind(x, y) {
    this.wx = x || 0;
    this.wy = y || 0;
  }

  // ---------------------------------------------------------------- events
  // A ball came down at (x, y): anything within its flush distance takes flight or runs.
  ballLanded(x, y, surface = null) {
    this.stats.landings++;
    const wet = surface === SURF.WATER;
    for (let i = 0; i < this.n; i++) {
      const S = SPECIES_LIST[this.sp[i]];
      if (!S.flushR || this.vis[i] <= 0 || this._busy(i)) continue;
      const R = S.flushR * (wet && (S.mode === 'swim' || S.mode === 'wade') ? 1.35 : 1);
      const dx = this.x[i] - x;
      const dy = this.y[i] - y;
      if (dx * dx + dy * dy < R * R) this._startle(i, x, y, 1);
    }
  }

  // A crowd roar at (x, y): birds within ~40-120 m lift off, nearer animals look up or bolt.
  // (The crowd calls this; main.js also calls it for a holed birdie or better.)
  cheer(x, y, strength = 1) {
    const s = clampN(strength, 0, 1);
    if (s <= 0) return;
    this.stats.cheers++;
    for (let i = 0; i < this.n; i++) {
      const S = SPECIES_LIST[this.sp[i]];
      if (this._busy(i)) continue;
      const d = Math.hypot(this.x[i] - x, this.y[i] - y);
      if (S.mode === 'hover' && d < 60 + 80 * s) {
        // Gulls wheel up and away, then come back to hang in the wind.
        this._flyTo(i, this.cx[i] + (this.x[i] - x) / Math.max(1, d) * 45, this.cy[i] + (this.y[i] - y) / Math.max(1, d) * 45, this.cz[i] + 8, FM_HOVER);
        this.st[i] = ST.FLY;
        continue;
      }
      const birdR = 40 + 80 * s;
      if (S.mode === 'perch') {
        if (this.st[i] === ST.PERCH && d < birdR) this.t[i] = Math.min(this.t[i], 0.05 + this.rng() * 0.3);
        continue;
      }
      if (S.mode === 'soar' || S.mode === 'pass' || this.vis[i] <= 0) continue;
      const bolt = 15 + 25 * s;
      if (S.bird && d < birdR) this._startle(i, x, y, s);
      else if (!S.bird && S.flushR && d < bolt) this._startle(i, x, y, s);
      else if (!S.bird && d < 60 + 60 * s && this.st[i] !== ST.HIDE) {
        // Heads up: look toward the noise for a few seconds.
        this.st[i] = ST.ALERT;
        this.t[i] = 2.5 + this.rng() * 3;
        this.thx[i] = x;
        this.thy[i] = y;
      }
    }
  }

  _busy(i) {
    const s = this.st[i];
    return s === ST.STARTLE || s === ST.RUN || s === ST.TAKEOFF || s === ST.HIDE || s === ST.CLIMB || (s === ST.FLY && this.fm[i] !== FM_LAND) || s === ST.LAND;
  }

  // Startle i and its group: each member reacts after its own short delay.
  _startle(i, x, y, strength) {
    const g = this.grp[i];
    const S = SPECIES_LIST[this.sp[i]];
    if (this.time - this.gLast[g] < 1.5) return;
    this.gLast[g] = this.time;
    this.stats.flushes++;
    // The group's destination away from the threat (birds fly as a flock to it).
    let ax = this.x[i] - x;
    let ay = this.y[i] - y;
    const al = Math.hypot(ax, ay) || 1;
    ax /= al;
    ay /= al;
    this.gAx[g] = ax;
    this.gAy[g] = ay;
    for (let j = 0; j < this.n; j++) {
      if (this.grp[j] !== g || this._busy(j) || (this.vis[j] <= 0 && S.mode !== 'perch')) continue;
      this.st[j] = ST.STARTLE;
      this.t[j] = j === i ? 0.05 : 0.08 + this.rng() * 0.35;
      this.thx[j] = x;
      this.thy[j] = y;
    }
    if (S.alarm) this._call(S.alarm, this.x[i], this.y[i], this.z[i]);
    if (S.bird && S.flee !== 'away') this._call('wings', this.x[i], this.y[i], this.z[i]);
  }

  // The flee itself, once the startle delay is over.
  _flee(i) {
    const S = SPECIES_LIST[this.sp[i]];
    const rng = this.rng;
    const g = this.grp[i];
    const ax = this.gAx[g];
    const ay = this.gAy[g];
    const t = this.terrain;
    if (S.mode === 'perch') {
      this._perchHop(i);
      return;
    }
    switch (S.flee) {
      case 'cover': {
        // Into the woods: past the tree line, away from the threat.
        const cx = this.cx[i] || this.x[i];
        const cy = this.cy[i] || this.y[i];
        let dx = cx - this.x[i];
        let dy = cy - this.y[i];
        const l = Math.hypot(dx, dy) || 1;
        dx = dx / l + ax * 0.6;
        dy = dy / l + ay * 0.6;
        const m = Math.hypot(dx, dy) || 1;
        const d = S.fleeDist[0] + rng() * (S.fleeDist[1] - S.fleeDist[0]);
        this._runTo(i, this.x[i] + (dx / m) * d + this.ox[i], this.y[i] + (dy / m) * d + this.oy[i], true);
        break;
      }
      case 'climb':
        this._runTo(i, this.cx[i] + (this.x[i] - this.cx[i]) * 0.02, this.cy[i] + (this.y[i] - this.cy[i]) * 0.02, false);
        break;
      case 'burrow':
        this._runTo(i, this.cx[i], this.cy[i], false);
        break;
      case 'crevice': {
        // Off the rock (or into the bushes): a short dash, then out of sight.
        const a = Math.atan2(ay, ax) + (rng() - 0.5);
        const r = (this.cr[i] || 0.6) + 0.6 + rng() * 1.2;
        this._runTo(i, this.x[i] + Math.cos(a) * r, this.y[i] + Math.sin(a) * r, false);
        break;
      }
      case 'away':
      case 'shuffle': {
        const d = S.fleeDist[0] + rng() * (S.fleeDist[1] - S.fleeDist[0]);
        let a = Math.atan2(ay, ax) + (rng() - 0.5) * 0.8;
        let tx = this.x[i] + Math.cos(a) * d;
        let ty = this.y[i] + Math.sin(a) * d;
        for (let k = 0; k < 6 && !this._okStand(tx, ty); k++) {
          a += (k % 2 ? 1 : -1) * 0.5 * (k + 1);
          tx = this.x[i] + Math.cos(a) * d;
          ty = this.y[i] + Math.sin(a) * d;
        }
        if (!this._okStand(tx, ty)) {
          tx = this.x[i] + ax * 6;
          ty = this.y[i] + ay * 6;
        }
        if (S.flee === 'shuffle') {
          this.st[i] = ST.WALK;
          this.tx[i] = tx;
          this.ty[i] = ty;
          this.aux[i] = 1.8; // brisk
        } else this._runTo(i, tx, ty, false);
        break;
      }
      case 'flyAway': {
        const d = 170 + rng() * 80;
        const a = Math.atan2(ay, ax) + (rng() - 0.5) * 0.7;
        const gz0 = t.heightAt(this.x[i], this.y[i]);
        this._takeoff(i, this.x[i] + Math.cos(a) * d + this.ox[i] * 2, this.y[i] + Math.sin(a) * d + this.oy[i] * 2, gz0 + S.flight.alt + rng() * 4, FM_EXIT);
        break;
      }
      case 'flyLoop': {
        // A circuit: out to the side and back round to land where they were.
        const side = g % 2 ? 1 : -1;
        const a = Math.atan2(ay, ax) + side * 0.9;
        const d = 80 + rng() * 40;
        const gz0 = t.heightAt(this.x[i], this.y[i]);
        this._takeoff(i, this.x[i] + Math.cos(a) * d + this.ox[i] * 2, this.y[i] + Math.sin(a) * d + this.oy[i] * 2, gz0 + S.flight.alt, FM_LOOP);
        break;
      }
      case 'flyShort': {
        // Low and short (a covey bursting off, flamingos moving along the lagoon).
        const d = 30 + rng() * 40;
        let a = Math.atan2(ay, ax) + (rng() - 0.5) * 0.6;
        let tx = 0;
        let ty = 0;
        let ok = false;
        // (Somewhere well clear of the threat and the golfer, or it would only flush again.)
        const clear = Math.max(S.golferR || 0, S.flushR || 0) * 1.25;
        for (let k = 0; k < 14 && !ok; k++) {
          const dk = d * (1 + 0.15 * k);
          tx = this.hx[i] + Math.cos(a) * dk + this.ox[i];
          ty = this.hy[i] + Math.sin(a) * dk + this.oy[i];
          ok = S.mode === 'wade' ? this._shallow(tx, ty, i) : this._okStand(tx, ty);
          if (ok && Math.hypot(tx - this.thx[i], ty - this.thy[i]) < clear) ok = false;
          if (ok && this.gOn && Math.hypot(tx - this.gpx, ty - this.gpy) < clear) ok = false;
          a += (k % 2 ? 1 : -1) * 0.4 * (k + 1);
        }
        if (!ok) {
          // Nowhere to land near: leave for a while instead.
          this._takeoff(i, this.x[i] + ax * 180, this.y[i] + ay * 180, t.heightAt(this.x[i], this.y[i]) + S.flight.alt + 6, FM_EXIT);
          break;
        }
        const gz = t.heightAt(tx, ty);
        this.hx[i] = tx;
        this.hy[i] = ty;
        this.hz[i] = gz;
        this._takeoff(i, tx, ty, gz, FM_LAND);
        break;
      }
      case 'toTrees': {
        // Up into the nearest canopy, out of sight.
        const tr = this._nearestTree(this.x[i], this.y[i]);
        if (tr) this._takeoff(i, tr.x + this.ox[i] * 0.4, tr.y + this.oy[i] * 0.4, tr.canopy.cz, FM_PERCH);
        else this._takeoff(i, this.x[i] + ax * 60, this.y[i] + ay * 60, this.z[i] + 8, FM_EXIT);
        break;
      }
      default:
        this.st[i] = ST.ALERT;
        this.t[i] = 3;
    }
  }

  _nearestTree(x, y) {
    let best = null;
    let bd = Infinity;
    for (const tr of this.terrain.treesNear(x, y, 40)) {
      if (!tr.canopy || (tr.kind !== 'pine' && tr.kind !== 'broad' && tr.kind !== 'palm')) continue;
      const d = Math.hypot(tr.x - x, tr.y - y);
      if (d < bd) {
        bd = d;
        best = tr;
      }
    }
    return best;
  }

  _runTo(i, x, y, cover) {
    this.st[i] = ST.RUN;
    this.tx[i] = x;
    this.ty[i] = y;
    this.aux[i] = cover ? 1 : 0;
    this.t2[i] = 0;
  }

  _takeoff(i, x, y, z, fm) {
    this.st[i] = ST.TAKEOFF;
    this.t[i] = 0;
    this._flyTo(i, x, y, z, fm);
    // A spring off the ground or the water (a dabbling duck almost straight up).
    const S = SPECIES_LIST[this.sp[i]];
    this.vz[i] = S.flight ? S.flight.climb * 0.85 : 1.5;
  }

  _flyTo(i, x, y, z, fm) {
    this.tx[i] = x;
    this.ty[i] = y;
    this.tz[i] = z;
    this.fm[i] = fm;
  }

  // Parrots: to another palm (the flock together).
  _perchHop(i) {
    const pool = this.pools.get('parrot') || [];
    if (!pool.length) return;
    const g = this.grp[i];
    // One destination per flock: the group's next palm.
    if (this.time - this.gT[g] > 1) {
      this.gT[g] = this.time;
      let best = null;
      for (let k = 0; k < 6; k++) {
        const c = pool[Math.floor(this.rng() * pool.length)];
        const d = Math.hypot(c.x - this.x[i], c.y - this.y[i]);
        if (d > 35 && d < 160) {
          best = c;
          break;
        }
      }
      if (!best) best = pool[Math.floor(this.rng() * pool.length)];
      this.gx[g] = best.x;
      this.gy[g] = best.y;
      this.gz[g] = best.z;
    }
    this.vis[i] = 1;
    this.fade[i] = 0.2;
    this.st[i] = ST.TAKEOFF;
    this.t[i] = 0;
    this._flyTo(i, this.gx[g] + this.ox[i] * 0.5, this.gy[g] + this.oy[i] * 0.5, this.gz[g] + 0.5, FM_PERCH);
    this.vz[i] = 2;
  }

  // ---------------------------------------------------------------- calls
  _call(kind, x, y, z) {
    const c = this._calls[(this._callHead + this._callCount) % MAX_CALLS];
    if (this._callCount >= MAX_CALLS) return;
    c.kind = kind;
    c.x = x;
    c.y = y;
    c.z = z;
    this._callCount++;
  }

  // The next pending call into out {kind, x, y, z}; false when there is none.
  pollCall(out) {
    if (!this._callCount) return false;
    const c = this._calls[this._callHead];
    out.kind = c.kind;
    out.x = c.x;
    out.y = c.y;
    out.z = c.z;
    this._callHead = (this._callHead + 1) % MAX_CALLS;
    this._callCount--;
    return true;
  }

  // ---------------------------------------------------------------- the address spot
  // A new address spot (always a camera cut): animals standing in the view corridor, or too close to
  // the golfer, are moved to another spot of their habitat out of sight; flocks move together.
  _relocate(ctx) {
    const c = this.cor;
    const moved = this._movedGroups || (this._movedGroups = new Uint8Array(MAX_ANIMALS));
    moved.fill(0);
    for (let i = 0; i < this.n; i++) {
      const S = SPECIES_LIST[this.sp[i]];
      const s = this.st[i];
      if (S.mode === 'soar' || S.mode === 'pass' || S.mode === 'perch') continue;
      const parked = s === ST.HIDE && this.fm[i] === FM_PARKED;
      if (!parked && (s === ST.FLY || s === ST.TAKEOFF || s === ST.LAND || (s === ST.HIDE && this.vis[i] <= 0))) continue;
      const g = this.grp[i];
      if (moved[g]) continue;
      const near = ctx.golfer ? Math.hypot(this.x[i] - ctx.gx, this.y[i] - ctx.gy) < (S.golferR || 20) * 0.7 : false;
      const px = S.mode === 'hover' ? this.cx[i] : this.x[i];
      const py = S.mode === 'hover' ? this.cy[i] : this.y[i];
      if (!parked && !near && !inCorridor(c, px, py)) continue;
      if (S.mode === 'hover' && this.z[i] - this.terrain.heightAt(px, py) > 24) continue;
      moved[g] = 1;
      const pool = this.pools.get(S.name) || [];
      let spot = null;
      for (let k = 0; k < pool.length && !spot; k++) {
        const q = pool[(k + Math.floor(this.rng() * pool.length)) % pool.length];
        if (inCorridor(c, q.x, q.y)) continue;
        if (ctx.golfer && Math.hypot(q.x - ctx.gx, q.y - ctx.gy) < (S.golferR || 20) * 1.2) continue;
        spot = q;
      }
      this.stats.relocated++;
      for (let j = 0; j < this.n; j++) {
        if (this.grp[j] !== g) continue;
        if (!spot) {
          // Nowhere else to be: out of sight until the next spot.
          this.st[j] = ST.HIDE;
          this.vis[j] = 0;
          this.fade[j] = 0;
          this.t[j] = 1e9;
          this.fm[j] = FM_PARKED;
          continue;
        }
        this.vis[j] = 1;
        this.fm[j] = FM_LAND;
        this._initAnimal(j, S, spot, j === i ? 0 : 1);
        this.fade[j] = 1;
      }
    }
  }

  // ---------------------------------------------------------------- per frame
  update(dt, ctx = null) {
    if (!(dt > 0)) return;
    dt = Math.min(dt, 0.1);
    this.time += dt;
    if (ctx) {
      if (ctx.wx != null) {
        this.wx = ctx.wx;
        this.wy = ctx.wy;
      }
      const c = this.cor;
      if (ctx.address) {
        c.bx = ctx.bx;
        c.by = ctx.by;
        c.dx = Math.cos(ctx.yaw);
        c.dy = Math.sin(ctx.yaw);
        c.len = Math.max(30, ctx.carry || 0);
        const fresh = !c.on || Math.abs(ctx.bx - this._spot.bx) > 0.5 || Math.abs(ctx.by - this._spot.by) > 0.5;
        c.on = true;
        if (fresh) {
          this._spot.bx = ctx.bx;
          this._spot.by = ctx.by;
          this._relocate(ctx);
        }
      } else c.on = false;
    }
    const gOn = !!(ctx && ctx.golfer);
    this.gOn = gOn;
    this.gpx = gOn ? ctx.gx : 0;
    this.gpy = gOn ? ctx.gy : 0;
    const corOn = this.cor.on;
    for (let i = 0; i < this.n; i++) {
      const S = SPECIES_LIST[this.sp[i]];
      // The golfer walking up: anything within its comfort distance moves off.
      if (gOn && S.golferR && this.vis[i] > 0 && !this._busy(i) && this.st[i] !== ST.ALERT) {
        const dx = this.x[i] - ctx.gx;
        const dy = this.y[i] - ctx.gy;
        if (dx * dx + dy * dy < S.golferR * S.golferR) this._startle(i, ctx.gx, ctx.gy, 0.7);
      }
      // Address: ground animals idling in the corridor (the aim moved onto them) walk out of it.
      if (corOn && S.mode === 'ground' && (this.st[i] === ST.IDLE || this.st[i] === ST.GRAZE) && inCorridor(this.cor, this.x[i], this.y[i])) {
        this.st[i] = ST.WALK;
        this.tx[i] = this.x[i];
        this.ty[i] = this.y[i];
        this.aux[i] = 1.5;
        this.t2[i] = 0;
      }
      this._step(i, S, dt);
    }
    this._groupCalls(dt);
    this._ambient(dt, ctx);
  }

  _groupCalls(dt) {
    for (let g = 0; g < this.gN; g++) {
      const S = SPECIES_LIST[this.gSp[g]];
      if (!S.call) continue;
      this.gCall[g] -= dt;
      if (this.gCall[g] > 0) continue;
      this.gCall[g] = S.call.every[0] + this.rng() * (S.call.every[1] - S.call.every[0]);
      // A visible member calls (perched parrots call from the crown).
      for (let i = 0; i < this.n; i++) {
        if (this.grp[i] !== g) continue;
        if (this.vis[i] <= 0 && S.mode !== 'perch') continue;
        this._call(S.call.kind, this.x[i], this.y[i], this.z[i]);
        break;
      }
    }
  }

  _ambient(dt, ctx) {
    for (let q = 0; q < this._amb.length; q++) {
      const a = this._amb[q];
      a.t -= dt;
      if (a.t > 0) continue;
      a.t = a.every[0] + this.rng() * (a.every[1] - a.every[0]);
      // Somewhere off to the side of where the play is.
      const cx = ctx && ctx.golfer ? ctx.gx : this.H.tx;
      const cy = ctx && ctx.golfer ? ctx.gy : this.H.ty;
      const ang = this.rng() * TAU;
      const r = a.r[0] + this.rng() * (a.r[1] - a.r[0]);
      const x = cx + Math.cos(ang) * r;
      const y = cy + Math.sin(ang) * r;
      this._call(a.kind, x, y, this.terrain.heightAt(clampN(x, this.H.minX, this.H.maxX), clampN(y, this.H.minY, this.H.maxY)) + 6);
    }
  }

  _step(i, S, dt) {
    const rng = this.rng;
    // Fade in / out (hidden in cover, a burrow, a canopy).
    const vt = this.vis[i] > 0 ? 1 : 0;
    this.fade[i] = approach(this.fade[i], vt, 3, dt);
    switch (this.st[i]) {
      case ST.STARTLE:
        this.t[i] -= dt;
        this.head[i] = approach(this.head[i], 0, 8, dt);
        this.alt[i] = approach(this.alt[i], 1, 6, dt);
        if (this.t[i] <= 0) this._flee(i);
        this._groundPose(i, S, dt, 0);
        return;
      case ST.IDLE:
      case ST.GRAZE:
      case ST.ALERT:
      case ST.BASK:
        this._rest(i, S, dt);
        return;
      case ST.WALK:
      case ST.RUN:
        this._move(i, S, dt);
        return;
      case ST.HIDE:
        this._hide(i, S, dt);
        return;
      case ST.CLIMB: {
        // Up the trunk, nose to the bark, and into the canopy.
        this.z[i] += 1.6 * dt;
        this.pitch[i] = approach(this.pitch[i], Math.PI / 2, 10, dt);
        this.gait[i] = 1.6;
        this.ph[i] += dt * 3;
        if (this.z[i] >= this.cz[i]) {
          this.st[i] = ST.HIDE;
          this.vis[i] = 0;
          this.t[i] = S.hideT[0] + rng() * (S.hideT[1] - S.hideT[0]);
        }
        return;
      }
      case ST.SWIM:
        this._swim(i, S, dt);
        return;
      case ST.TAKEOFF:
      case ST.FLY:
      case ST.LAND:
        this._flight(i, S, dt);
        return;
      case ST.SOAR:
        this._soar(i, S, dt);
        return;
      case ST.HOVER:
        this._hover(i, S, dt);
        return;
      case ST.PASS:
        this._pass(i, S, dt);
        return;
      case ST.PERCH:
        this.t[i] -= dt;
        this.fly[i] = 1;
        if (this.t[i] <= 0) {
          // The flock leaves together (the first one to be ready takes the others).
          const g = this.grp[i];
          for (let j = 0; j < this.n; j++) if (this.grp[j] === g && this.st[j] === ST.PERCH) this._perchHop(j);
        }
        return;
      default:
    }
  }

  // Standing, grazing, alert or basking; choose what to do next when the timer runs out.
  _rest(i, S, dt) {
    const rng = this.rng;
    const st = this.st[i];
    this.t[i] -= dt;
    this.t2[i] += dt;
    let headT = 0;
    let altT = 0;
    if (st === ST.GRAZE) {
      // Head down, lifted every few seconds to look round; now and then a step or two.
      const cyc = (this.t2[i] + this.seedv[i] * 9) % (5 + this.seedv[i] * 4);
      headT = cyc < 1.4 ? 0.15 : 1;
      if (S.mode === 'swim') headT = cyc < 2.5 ? 0 : 0.85;
    } else if (st === ST.ALERT) {
      altT = 1;
      headT = 0;
      if (this.t[i] <= 0) altT = 0;
    } else if (st === ST.BASK) {
      // A lizard's push-ups every few seconds.
      const cyc = (this.t2[i] + this.seedv[i] * 7) % (4 + this.seedv[i] * 5);
      altT = cyc < 0.25 ? 1 : cyc < 0.5 ? 0 : cyc < 0.75 ? 1 : 0;
    }
    this.head[i] = approach(this.head[i], headT, 3, dt);
    this.alt[i] = approach(this.alt[i], altT, st === ST.BASK ? 14 : 4, dt);
    // Look round (toward the threat when alert).
    let lookT = Math.sin(this.time * (0.35 + this.seedv[i] * 0.3) + this.seedv[i] * 20) * 0.6;
    if (st === ST.ALERT) lookT = clampN(wrapA(Math.atan2(this.thy[i] - this.y[i], this.thx[i] - this.x[i]) - this.yaw[i]), -1.2, 1.2);
    this.turn[i] = approach(this.turn[i], lookT, 2, dt);
    this._groundPose(i, S, dt, 0);
    if (this.t[i] > 0) return;
    // Next: graze / idle / walk (or bask), by the species' weights.
    const R = S.rest;
    let r = rng() * ((R.graze || 0) + (R.idle || 0) + (R.walk || 0) + (R.bask || 0));
    if (st === ST.ALERT) r = 0; // after a look up, back to feeding
    if ((r -= R.graze || 0) < 0) {
      this.st[i] = R.graze ? ST.GRAZE : ST.IDLE;
      this.t[i] = 4 + rng() * 10;
    } else if ((r -= R.idle || 0) < 0) {
      this.st[i] = ST.IDLE;
      this.t[i] = 2 + rng() * 6;
    } else if ((r -= R.walk || 0) < 0) {
      this._wander(i, S);
    } else {
      this.st[i] = ST.BASK;
      this.t[i] = 6 + rng() * 10;
    }
    this.t2[i] = 0;
  }

  // A short walk to a new spot near home (on foot or wading), never onto a green, tee or into water.
  _wander(i, S) {
    const rng = this.rng;
    for (let k = 0; k < 8; k++) {
      const a = rng() * TAU;
      const r = S.roam * Math.sqrt(rng());
      const x = this.hx[i] + Math.cos(a) * r + this.ox[i] * 0.3;
      const y = this.hy[i] + Math.sin(a) * r + this.oy[i] * 0.3;
      const ok = S.mode === 'wade' ? this._shallow(x, y, i) : this._okStand(x, y);
      if (!ok || (this.cor.on && inCorridor(this.cor, x, y))) continue;
      this.st[i] = ST.WALK;
      this.tx[i] = x;
      this.ty[i] = y;
      this.aux[i] = 1;
      this.t[i] = 30;
      return;
    }
    this.st[i] = ST.IDLE;
    this.t[i] = 2 + rng() * 3;
  }

  // Walking or running toward (tx, ty).
  _move(i, S, dt) {
    const rng = this.rng;
    const run = this.st[i] === ST.RUN;
    // Out of the view corridor at address: walk off to the side (not across the aim line).
    if (!run && this.cor.on && inCorridor(this.cor, this.x[i], this.y[i]) && inCorridor(this.cor, this.tx[i], this.ty[i])) {
      const c = this.cor;
      const lat = -(this.x[i] - c.bx) * c.dy + (this.y[i] - c.by) * c.dx;
      const side = lat >= 0 ? 1 : -1;
      this.tx[i] = this.x[i] - c.dy * side * 30;
      this.ty[i] = this.y[i] + c.dx * side * 30;
      this.aux[i] = 2;
    }
    let dx = this.tx[i] - this.x[i];
    let dy = this.ty[i] - this.y[i];
    const d = Math.hypot(dx, dy);
    let vT = run ? S.run : S.walk * (this.aux[i] || 1);
    if (S.zigzag && run) dy += Math.sin(this.t2[i] * 3.1 + this.seedv[i] * 9) * d * 0.25;
    if (S.dash && !run && this.seedv[i] > 0.5) vT *= 1 + 2 * Math.max(0, Math.sin(this.t2[i] * 0.9));
    this.t2[i] += dt;
    const want = Math.atan2(dy, dx);
    const err = wrapA(want - this.yaw[i]);
    const turn = S.turn * (run ? 1.6 : 1);
    this.yaw[i] += clampN(err, -turn * dt, turn * dt);
    // Slow for sharp turns and on arrival.
    vT *= Math.max(0.2, Math.cos(Math.min(Math.abs(err), 1.4)));
    if (d < 1.5) vT *= Math.max(0.25, d / 1.5);
    this.spd[i] = approach(this.spd[i], vT, run ? 4 : 2, dt);
    const nx = this.x[i] + Math.cos(this.yaw[i]) * this.spd[i] * dt;
    const ny = this.y[i] + Math.sin(this.yaw[i]) * this.spd[i] * dt;
    // Keep off water (waders keep to it) and inside the hole.
    const H = this.H;
    const wet = sgAt(this.terrain, nx, ny) === SURF.WATER;
    const blocked = (S.mode === 'wade' ? !this._shallow(nx, ny, i) : wet && !run) || nx < H.minX || nx > H.maxX || ny < H.minY || ny > H.maxY;
    if (!blocked) {
      this.x[i] = nx;
      this.y[i] = ny;
    } else if (!run) {
      this.st[i] = ST.IDLE;
      this.t[i] = 1 + rng() * 2;
    }
    this.z[i] = this._groundZ(i, S);
    this.head[i] = approach(this.head[i], run ? 0 : 0.12, 4, dt);
    this.alt[i] = approach(this.alt[i], run && S.flee === 'cover' ? 1 : 0, 5, dt);
    this.turn[i] = approach(this.turn[i], 0, 3, dt);
    this._groundPose(i, S, dt, this.spd[i]);
    const arrived = d < (run ? 0.8 : 0.35) || (blocked && run) || this.t2[i] > 25;
    if (!arrived) return;
    this.spd[i] = 0;
    if (!run) {
      this.st[i] = S.rest.graze ? ST.GRAZE : ST.IDLE;
      this.t[i] = 3 + rng() * 8;
      this.aux[i] = 1;
      return;
    }
    switch (S.flee) {
      case 'cover':
        this.st[i] = ST.HIDE; // standing in the trees, watching
        this.vis[i] = 1;
        this.t[i] = S.hideT[0] + rng() * (S.hideT[1] - S.hideT[0]);
        break;
      case 'climb':
        this.st[i] = ST.CLIMB;
        this.yaw[i] = Math.atan2(this.cy[i] - this.y[i], this.cx[i] - this.x[i]);
        // (The body pitches nose-up about its centre, which puts the feet cz ahead of the origin.)
        this.x[i] = this.cx[i] - Math.cos(this.yaw[i]) * (this.cr[i] + 0.03 + MESH_PARAMS[this._mesh(i)].cz);
        this.y[i] = this.cy[i] - Math.sin(this.yaw[i]) * (this.cr[i] + 0.03 + MESH_PARAMS[this._mesh(i)].cz);
        break;
      case 'burrow':
      case 'crevice':
        this.st[i] = ST.HIDE;
        this.vis[i] = 0;
        this.t[i] = S.hideT[0] + rng() * (S.hideT[1] - S.hideT[0]);
        break;
      default:
        this.st[i] = ST.ALERT;
        this.t[i] = 2 + rng() * 4;
        this.hx[i] = this.x[i];
        this.hy[i] = this.y[i];
    }
  }

  _groundZ(i, S) {
    if (S.habitat === 'rockTop' && Math.hypot(this.x[i] - this.hx[i], this.y[i] - this.hy[i]) < (this.cr[i] || 0.5) * 0.7) return this.cz[i];
    return this.terrain.heightAt(this.x[i], this.y[i]);
  }

  // Gait and pose bookkeeping for animals on the ground (mammals and birds on foot).
  _groundPose(i, S, dt, v) {
    const runStart = S.walk * 1.6;
    if (S.bird) {
      this.fly[i] = approach(this.fly[i], 0, 6, dt);
      this.walkAmp[i] = approach(this.walkAmp[i], v > 0.05 ? 1 : 0, 6, dt);
      this.flap[i] = 0;
      this.bank[i] = approach(this.bank[i], 0, 4, dt);
      this.pitch[i] = approach(this.pitch[i], 0, 4, dt);
      this.ph[i] += (v / Math.max(0.05, S.stride)) * dt;
      return;
    }
    const g = v < runStart ? v / S.walk : 1 + Math.min(1, (v - runStart) / Math.max(0.1, S.run - runStart));
    this.gait[i] = approach(this.gait[i], v > 0.02 ? Math.min(2, g) : 0, 6, dt);
    const stride = this.gait[i] <= 1 ? S.stride : S.stride + (S.runStride - S.stride) * (this.gait[i] - 1);
    this.ph[i] += (v / Math.max(0.05, stride)) * dt;
    if (this.st[i] !== ST.CLIMB) this.pitch[i] = approach(this.pitch[i], 0, 6, dt);
  }

  _hide(i, S, dt) {
    const rng = this.rng;
    this.t[i] -= dt;
    this.spd[i] = 0;
    this._groundPose(i, S, dt, 0);
    this.alt[i] = approach(this.alt[i], 0, 1.5, dt);
    if (this.t[i] > 0) return;
    if (this.gOn && S.golferR && Math.hypot(this.hx[i] - this.gpx, this.hy[i] - this.gpy) < S.golferR * 1.15) {
      this.t[i] = 8 + rng() * 8; // still too close to the golfer: wait
      return;
    }
    // Come back.
    if (S.bird) {
      if (S.mode === 'perch') return;
      // From the far exit point (or the canopy) back home, to land.
      this.vis[i] = 1;
      this.fade[i] = this.fm[i] === FM_PERCH ? 0.3 : 1;
      this.fly[i] = 1;
      this.st[i] = ST.FLY;
      const S2 = S.flight;
      const tz = S.mode === 'swim' ? this.hz[i] : this.terrain.heightAt(this.hx[i], this.hy[i]);
      this._flyTo(i, this.hx[i], this.hy[i], tz, FM_LAND);
      this.spd[i] = S2.cruise;
      this.vz[i] = 0;
      return;
    }
    switch (S.flee) {
      case 'climb':
        // Back down at the foot of the tree, then home.
        this.x[i] = this.cx[i] + (this.hx[i] - this.cx[i]) / Math.max(1, Math.hypot(this.hx[i] - this.cx[i], this.hy[i] - this.cy[i])) * (this.cr[i] + 0.3);
        this.y[i] = this.cy[i] + (this.hy[i] - this.cy[i]) / Math.max(1, Math.hypot(this.hx[i] - this.cx[i], this.hy[i] - this.cy[i])) * (this.cr[i] + 0.3);
        this.z[i] = this.terrain.heightAt(this.x[i], this.y[i]);
        this.pitch[i] = 0;
        this.vis[i] = 1;
        this.st[i] = ST.WALK;
        this.tx[i] = this.hx[i];
        this.ty[i] = this.hy[i];
        this.aux[i] = 2;
        this.t2[i] = 0;
        break;
      case 'burrow':
        this.vis[i] = 1;
        this.st[i] = ST.ALERT;
        this.t[i] = 3 + rng() * 3;
        this.thx[i] = this.hx[i];
        this.thy[i] = this.hy[i];
        break;
      case 'crevice':
        // Back on its rock (or its spot on the sand).
        this.x[i] = this.hx[i];
        this.y[i] = this.hy[i];
        this.z[i] = this.hz[i];
        this.vis[i] = 1;
        this.st[i] = S.rest.bask ? ST.BASK : ST.IDLE;
        this.t[i] = 5 + rng() * 6;
        break;
      default:
        // Out of the trees and back to where it was grazing.
        this.vis[i] = 1;
        this.st[i] = ST.WALK;
        this.tx[i] = this.hx[i];
        this.ty[i] = this.hy[i];
        this.aux[i] = 1;
        this.t2[i] = 0;
    }
  }

  // Swimming: drifting about the pond, dabbling; geese walk out to graze on the bank.
  _swim(i, S, dt) {
    const rng = this.rng;
    this.t[i] -= dt;
    this.t2[i] += dt;
    const dx = this.tx[i] - this.x[i];
    const dy = this.ty[i] - this.y[i];
    const d = Math.hypot(dx, dy);
    if (this.t[i] <= 0 || d < 0.5 || !this.tx[i]) {
      // A new heading: a point of open water near home.
      this.t[i] = 6 + rng() * 12;
      for (let k = 0; k < 8; k++) {
        const a = rng() * TAU;
        const r = S.roam * Math.sqrt(rng());
        const x = this.hx[i] + Math.cos(a) * r + this.ox[i] * 0.5;
        const y = this.hy[i] + Math.sin(a) * r + this.oy[i] * 0.5;
        if (this._wet(x, y) && this._wet(x + 1.5, y) && this._wet(x - 1.5, y) && this._wet(x, y + 1.5) && this._wet(x, y - 1.5)) {
          this.tx[i] = x;
          this.ty[i] = y;
          break;
        }
      }
    }
    const v = S.swim * (d > 0.5 ? 1 : 0.3);
    const want = Math.atan2(dy, dx);
    const err = wrapA(want - this.yaw[i]);
    this.yaw[i] += clampN(err, -S.turn * dt, S.turn * dt);
    this.spd[i] = approach(this.spd[i], v * Math.max(0.2, Math.cos(Math.min(1.4, Math.abs(err)))), 1.5, dt);
    const nx = this.x[i] + Math.cos(this.yaw[i]) * this.spd[i] * dt;
    const ny = this.y[i] + Math.sin(this.yaw[i]) * this.spd[i] * dt;
    if (this._wet(nx, ny)) {
      this.x[i] = nx;
      this.y[i] = ny;
    } else this.t[i] = 0;
    // Bob on the water; ducks up-end to feed now and then.
    this.z[i] = this.lvl[i] - MESH_PARAMS[this._mesh(i)].draft + 0.008 * Math.sin(this.time * 1.7 + this.seedv[i] * 30);
    const cyc = (this.t2[i] + this.seedv[i] * 11) % (9 + this.seedv[i] * 6);
    const dabble = S.name === 'mallard' && cyc < 2.2;
    this.pitch[i] = approach(this.pitch[i], dabble ? -1.15 : 0, 3, dt);
    this.head[i] = approach(this.head[i], dabble ? 0.6 : 0, 3, dt);
    this.fly[i] = approach(this.fly[i], -1, 4, dt);
    this.walkAmp[i] = 0;
    this.flap[i] = 0;
    this.bank[i] = approach(this.bank[i], 0, 3, dt);
    this.turn[i] = 0;
  }

  // Flight: take off, fly to the target, then land, leave, perch or go back to hovering.
  _flight(i, S, dt) {
    const F = S.flight;
    const rng = this.rng;
    const st = this.st[i];
    this.t[i] += dt;
    const dx = this.tx[i] - this.x[i];
    const dy = this.ty[i] - this.y[i];
    const d = Math.hypot(dx, dy);
    const landing = this.fm[i] === FM_LAND || this.fm[i] === FM_PERCH;
    // Speed: up to cruise, down for the landing.
    let vT = F.cruise;
    if (landing && d < 40) vT = Math.max(2, Math.min(F.cruise, d * 0.45 + 1.5));
    if (st === ST.TAKEOFF) vT = F.cruise * Math.min(1, 0.35 + this.t[i] * 0.5);
    this.spd[i] = approach(this.spd[i], vT, st === ST.TAKEOFF ? 1.4 : 0.9, dt);
    // Heading with a turn-rate limit; bank into the turn.
    const want = Math.atan2(dy, dx);
    const err = wrapA(want - this.yaw[i]);
    const final = landing && d < 4;
    const rate = clampN(err * (final ? 6 : 1.6), -(final ? 4 : F.turn), final ? 4 : F.turn) * (st === ST.TAKEOFF ? 0.6 : 1);
    this.yaw[i] += rate * dt;
    if (final) this.spd[i] = Math.min(this.spd[i], d * 0.9 + 0.4);
    this.x[i] += Math.cos(this.yaw[i]) * this.spd[i] * dt;
    this.y[i] += Math.sin(this.yaw[i]) * this.spd[i] * dt;
    // Height: climb out, cruise, glide down to the landing (over the last ~35 m).
    const H = this.H;
    const gz = this.terrain.heightAt(clampN(this.x[i], H.minX, H.maxX), clampN(this.y[i], H.minY, H.maxY));
    let zT = this.tz[i];
    if (landing && d > 6) zT = this.tz[i] + Math.min(F.alt, Math.max(0, d - 6) * 0.35);
    if (!landing) zT = Math.max(zT, gz + 3);
    const climb = st === ST.TAKEOFF ? F.climb * 1.2 : F.climb;
    const vzT = clampN((zT - this.z[i]) * 0.9, -2.5, climb);
    this.vz[i] = approach(this.vz[i], vzT, 2, dt);
    this.z[i] += this.vz[i] * dt;
    if (!landing || d > 3) this.z[i] = Math.max(this.z[i], gz + 0.4 * Math.min(1, this.t[i]));
    // Pose: wings out, flapping on the climb and in bursts, gliding down.
    this.fly[i] = approach(this.fly[i], 1, st === ST.TAKEOFF ? 7 : 4, dt);
    const burst = Math.sin(this.time * (0.7 + this.seedv[i] * 0.4) + this.seedv[i] * 10) > F.glide * 2 - 1;
    let flapT = st === ST.TAKEOFF || this.vz[i] > 0.6 ? 1 : burst ? 0.75 : 0;
    if (landing && d < 8) flapT = 0.7; // flare
    if (this.vz[i] < -0.8 && !(landing && d < 8)) flapT = 0;
    this.flap[i] = approach(this.flap[i], flapT, 5, dt);
    this.ph[i] += F.flapHz * (st === ST.TAKEOFF ? 1.25 : 1) * dt;
    this.bank[i] = approach(this.bank[i], clampN(-Math.atan((this.spd[i] * rate) / G), -0.6, 0.6), 3, dt);
    this.pitch[i] = approach(this.pitch[i], clampN(Math.atan2(this.vz[i], Math.max(2, this.spd[i])) * 0.8 + (landing && d < 8 ? 0.35 : 0), -0.4, 0.6), 3, dt);
    this.head[i] = approach(this.head[i], 0, 4, dt);
    this.walkAmp[i] = 0;
    if (st === ST.TAKEOFF && this.t[i] > 1.4) this.st[i] = ST.FLY;
    // Arrivals.
    const H2 = this.H;
    const outside = this.x[i] < H2.minX - 150 || this.x[i] > H2.maxX + 150 || this.y[i] < H2.minY - 150 || this.y[i] > H2.maxY + 150;
    switch (this.fm[i]) {
      case FM_EXIT:
        if (d < 8 || outside) {
          this.st[i] = ST.HIDE;
          this.vis[i] = 0;
          this.t[i] = S.hideT ? S.hideT[0] + rng() * (S.hideT[1] - S.hideT[0]) : 30;
        }
        break;
      case FM_LOOP:
        if (d < 12) {
          // Round and back home to land.
          this._flyTo(i, this.hx[i], this.hy[i], S.mode === 'swim' ? this.hz[i] : this.terrain.heightAt(this.hx[i], this.hy[i]), FM_LAND);
        }
        break;
      case FM_HOVER:
        if (d < 10) {
          this._flyTo(i, this.cx[i], this.cy[i], this.cz[i], FM_LAND);
          this.fm[i] = FM_HOVER + 1; // heading back to the hover spot
        }
        break;
      case FM_HOVER + 1:
        if (d < 4) this.st[i] = ST.HOVER;
        break;
      case FM_PERCH:
        if (d < 1.2 && Math.abs(this.z[i] - this.tz[i]) < 1.5) {
          this.vis[i] = 0;
          this.x[i] = this.tx[i];
          this.y[i] = this.ty[i];
          this.z[i] = this.tz[i];
          this.spd[i] = 0;
          if (S.mode === 'perch') {
            this.st[i] = ST.PERCH;
            this.t[i] = S.hideT[0] + rng() * (S.hideT[1] - S.hideT[0]);
          } else {
            this.st[i] = ST.HIDE;
            this.t[i] = S.hideT[0] + rng() * (S.hideT[1] - S.hideT[0]);
          }
        }
        break;
      default:
        // Landing: touch down, fold the wings.
        if (d < 0.6 && this.z[i] - this.tz[i] < 0.3) this._touchDown(i, S);
        else if (d < 2.5 && this.z[i] - this.tz[i] < 1.2) {
          this.spd[i] = approach(this.spd[i], 0.8, 3, dt);
          this.z[i] = approach(this.z[i], this.tz[i], 3, dt);
        }
    }
  }

  _touchDown(i, S) {
    this.spd[i] = 0;
    this.vz[i] = 0;
    this.x[i] = this.tx[i];
    this.y[i] = this.ty[i];
    this.z[i] = this.tz[i];
    this.flap[i] = 0;
    this.t2[i] = 0;
    if (S.mode === 'swim' && this._wet(this.x[i], this.y[i])) {
      this.st[i] = ST.SWIM;
      this.t[i] = 0;
      this.tx[i] = 0;
      return;
    }
    this.z[i] = this.terrain.heightAt(this.x[i], this.y[i]);
    this.st[i] = ST.ALERT;
    this.t[i] = 1.5 + this.rng() * 2;
    this.thx[i] = this.x[i] - Math.cos(this.yaw[i]);
    this.thy[i] = this.y[i] - Math.sin(this.yaw[i]);
  }

  // Circling on a thermal (hawks), drifting with the wind, a few wingbeats now and then.
  _soar(i, S, dt) {
    const F = S.flight;
    const v = F.cruise;
    const r = this.cr[i];
    const w = v / r;
    this.ca[i] += w * dt;
    this.cx[i] += this.wx * 0.25 * dt;
    this.cy[i] += this.wy * 0.25 * dt;
    // Drift back over the hole when the wind has carried the thermal too far.
    const H = this.H;
    if (this.cx[i] < H.minX - 80 || this.cx[i] > H.maxX + 80 || this.cy[i] < H.minY - 80 || this.cy[i] > H.maxY + 80) {
      this.cx[i] = this.hx[i];
      this.cy[i] = this.hy[i];
    }
    const tx = this.cx[i] + Math.cos(this.ca[i]) * r;
    const ty = this.cy[i] + Math.sin(this.ca[i]) * r;
    this.x[i] = approach(this.x[i], tx, 2, dt);
    this.y[i] = approach(this.y[i], ty, 2, dt);
    this.z[i] = approach(this.z[i], this.cz[i] + 3 * Math.sin(this.ca[i] * 0.5 + this.seedv[i] * 7), 0.5, dt);
    this.yaw[i] = this.ca[i] + Math.PI / 2;
    this.bank[i] = approach(this.bank[i], -Math.atan((v * w) / G) * 1.15, 2, dt);
    this.pitch[i] = approach(this.pitch[i], 0.04, 2, dt);
    this.fly[i] = 1;
    const beat = Math.sin(this.time * 0.21 + this.seedv[i] * 17) > 0.93;
    this.flap[i] = approach(this.flap[i], beat ? 0.7 : 0, 4, dt);
    this.ph[i] += F.flapHz * dt;
  }

  // Hanging in the wind over the dunes (kittiwakes and gulls), facing into it; in a calm, slow
  // circles instead.
  _hover(i, S, dt) {
    const F = S.flight;
    const wl = Math.hypot(this.wx, this.wy);
    const s = this.seedv[i];
    const T = this.time;
    this.fly[i] = 1;
    if (wl > 2.2) {
      const tx = this.cx[i] + 3 * Math.sin(T * 0.13 + s * 20) + 1.2 * Math.sin(T * 0.51 + s * 7);
      const ty = this.cy[i] + 3 * Math.cos(T * 0.11 + s * 13) + 1.2 * Math.sin(T * 0.43 + s * 3);
      this.x[i] = approach(this.x[i], tx, 0.6, dt);
      this.y[i] = approach(this.y[i], ty, 0.6, dt);
      this.z[i] = approach(this.z[i], this.cz[i] + 1.5 * Math.sin(T * 0.3 + s * 9), 0.6, dt);
      const into = Math.atan2(-this.wy, -this.wx) + 0.15 * Math.sin(T * 0.7 + s * 5);
      this.yaw[i] += clampN(wrapA(into - this.yaw[i]), -1.2 * dt, 1.2 * dt);
      this.bank[i] = approach(this.bank[i], 0.12 * Math.sin(T * 1.3 + s * 11), 3, dt);
      this.pitch[i] = approach(this.pitch[i], 0.12, 2, dt);
      const adjust = Math.sin(T * 0.6 + s * 31) > 0.85;
      this.flap[i] = approach(this.flap[i], adjust ? 0.35 : 0, 6, dt);
      this.spd[i] = 0;
    } else {
      const r = this.cr[i];
      const w = F.cruise / r;
      this.ca[i] += w * dt;
      this.x[i] = approach(this.x[i], this.cx[i] + Math.cos(this.ca[i]) * r, 2, dt);
      this.y[i] = approach(this.y[i], this.cy[i] + Math.sin(this.ca[i]) * r, 2, dt);
      this.z[i] = approach(this.z[i], this.cz[i] + 2 * Math.sin(this.ca[i] + s * 4), 0.5, dt);
      this.yaw[i] = this.ca[i] + Math.PI / 2;
      this.bank[i] = approach(this.bank[i], -Math.atan((F.cruise * w) / G), 2, dt);
      this.pitch[i] = approach(this.pitch[i], 0.05, 2, dt);
      const beat = Math.sin(T * 0.4 + s * 17) > 0.6;
      this.flap[i] = approach(this.flap[i], beat ? 0.8 : 0, 4, dt);
      this.spd[i] = F.cruise;
    }
    this.ph[i] += F.flapHz * dt;
  }

  // Pelicans in line along the shore: the leader sets the pace, each bird flaps a moment after
  // the one ahead of it; out of sight past the end of the line, then back the other way.
  _pass(i, S, dt) {
    const F = S.flight;
    const g = this.grp[i];
    const k = this.aux[i];
    // The group clock is advanced by its first member.
    if (k === 0) {
      if (this.vis[i] > 0 || this.gT[g] <= 0) this.gS[g] += F.cruise * dt;
      if (this.gS[g] > 260) {
        // Past the end: hidden for a while, then back the other way.
        if (this.gT[g] <= 0) this.gT[g] = S.hideT[0] + this.rng() * (S.hideT[1] - S.hideT[0]);
        this.gT[g] -= dt;
        if (this.gT[g] <= 0) {
          this.gS[g] = -260;
          this.gDir[g] = -this.gDir[g];
        }
      }
    }
    const dir = this.gDir[g];
    const s = (this.gS[g] - k * 9) * dir;
    const lx = this.gDx[g];
    const ly = this.gDy[g];
    const side = k % 2 ? 1 : -1;
    const off = Math.ceil(k / 2) * 2.2 * side;
    this.x[i] = this.gx[g] + lx * s - ly * off;
    this.y[i] = this.gy[g] + ly * s + lx * off;
    this.z[i] = this.gz[g] + 0.6 * Math.sin(this.time * 0.35 + k * 0.6);
    this.yaw[i] = Math.atan2(ly * dir, lx * dir);
    this.vis[i] = Math.abs(this.gS[g] - k * 9) < 250 ? 1 : 0;
    this.fly[i] = 1;
    const beat = ((this.time - k * 0.38) % 9.5 + 9.5) % 9.5 < 2.6;
    this.flap[i] = approach(this.flap[i], beat ? 0.8 : 0, 6, dt);
    this.ph[i] += F.flapHz * dt;
    this.bank[i] = approach(this.bank[i], 0, 2, dt);
    this.pitch[i] = approach(this.pitch[i], 0.02, 2, dt);
  }

  // ---------------------------------------------------------------- output
  // Instance rows for the visible animals and their contact shadows. Returns the instance count;
  // this.shadowCount holds the shadows written.
  write(inst, shadow = null) {
    let n = 0;
    let ns = 0;
    const t = this.terrain;
    const sun = this.sun;
    const nr = this._nrm;
    const H = this.H;
    const maxI = Math.floor(inst.length / INST_FLOATS);
    const maxS = shadow ? Math.floor(shadow.length / SHADOW_FLOATS) : 0;
    for (let i = 0; i < this.n && n < maxI; i++) {
      const f = this.fade[i];
      if (f < 0.004) continue;
      const S = SPECIES_LIST[this.sp[i]];
      const o = n * INST_FLOATS;
      inst[o] = this.x[i];
      inst[o + 1] = this.y[i];
      inst[o + 2] = this.z[i];
      inst[o + 3] = this.yaw[i];
      inst[o + 4] = this.slot[i] + 0.5 * clampN(f, 0, 1);
      inst[o + 5] = clampN(this.head[i], 0, 1);
      inst[o + 6] = this.seedv[i];
      inst[o + 7] = this.ph[i] % 1000;
      if (S.bird) {
        inst[o + 8] = this.fly[i];
        inst[o + 9] = this.fly[i] > 0.5 ? this.flap[i] : this.walkAmp[i];
        inst[o + 10] = this.bank[i];
        inst[o + 11] = this.pitch[i];
      } else {
        inst[o + 8] = this.gait[i];
        inst[o + 9] = clampN(this.alt[i], 0, 1);
        inst[o + 10] = this.turn[i];
        inst[o + 11] = this.pitch[i];
      }
      n++;
      // Contact shadow: under animals on the ground (not swimmers), and under birds flying low.
      if (ns >= maxS || this.st[i] === ST.CLIMB) continue;
      const swimming = S.bird && this.fly[i] < -0.5;
      if (swimming) continue;
      const gx = clampN(this.x[i], H.minX, H.maxX);
      const gy = clampN(this.y[i], H.minY, H.maxY);
      const gz = t.heightAt(gx, gy);
      const hgt = this.z[i] - gz;
      if (hgt > 5 || this._wet(gx, gy)) continue;
      const a = f * 0.42 * clampN(1 - hgt / 5, 0, 1) * Math.min(1, sun.z * 2.2);
      if (a < 0.01) continue;
      // Thrown away from the sun by about the body's height (and the height above the ground).
      const k = Math.min(1.6, (S.size * 0.45 + hgt) / sun.z) * 0.5;
      t.normalAt(gx, gy, nr);
      const so = ns * SHADOW_FLOATS;
      shadow[so] = this.x[i] - sun.x * k;
      shadow[so + 1] = this.y[i] - sun.y * k;
      shadow[so + 2] = t.heightAt(this.x[i] - sun.x * k, this.y[i] - sun.y * k);
      shadow[so + 3] = this.yaw[i];
      shadow[so + 4] = S.len * 0.55 * (1 + 0.15 * hgt);
      shadow[so + 5] = S.wid * 0.6 * (S.bird && this.fly[i] > 0.5 ? 2.5 : 1);
      shadow[so + 6] = a;
      shadow[so + 7] = 0;
      shadow[so + 8] = nr.x;
      shadow[so + 9] = nr.y;
      shadow[so + 10] = nr.z;
      shadow[so + 11] = 0;
      ns++;
    }
    this.shadowCount = ns;
    return n;
  }

  // Plain objects for tests and the debug hook (allocates; not for the frame loop).
  snapshot() {
    const out = [];
    for (let i = 0; i < this.n; i++) {
      const S = SPECIES_LIST[this.sp[i]];
      out.push({
        i, species: S.name, mesh: this._mesh(i), slot: this.slot[i], group: this.grp[i], state: STATE_NAMES[this.st[i]], mode: S.mode,
        x: this.x[i], y: this.y[i], z: this.z[i], yaw: this.yaw[i], home: { x: this.hx[i], y: this.hy[i], z: this.hz[i] },
        vis: this.vis[i], fade: this.fade[i], fly: this.fly[i], flap: this.flap[i], gait: this.gait[i], level: this.lvl[i],
      });
    }
    return out;
  }
}
