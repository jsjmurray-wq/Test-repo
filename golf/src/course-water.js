// Coral Cay: the water course (theme 'tropical', docs/architecture.md section 8.2). A lagoon and
// ocean resort nine where water is the defining hazard on every hole, yet each hole keeps a dry,
// sensible line for the player who wants one:
//   1  Palm Walk     par 4  opener from a dune tee over a lagoon's tail, then bending left round
//                          the lagoon with a beach on its near shore
//   2  The Fork      par 5  the fairway splits round a lagoon: the narrow left branch runs between
//                          the lagoon and the beach straight at an open green (in range in two
//                          from a good drive), the wide right branch beyond the lagoon's foot
//                          leaves a pitch over its top arm
//   3  The Island    par 3  island green in the lagoon (fill: 'outside'), the tee on its own islet
//   4  Mangroves     par 4  forced carry over a lagoon inlet, then the lagoon all down the inside
//                          of a dogleg right to the green; the bail-out is left
//   5  Peninsula     par 4  short two-shotter to a green on a peninsula: water right, behind and
//                          left, the front open for a running approach
//   6  Shell Beach   par 3  along the shore: beach and sea right of and behind the green
//   7  Breakers      par 4  a coral spit in the ocean (outside: 'water'): a carry over the cove
//                          (or the long way round by the left-hand beach), surf on both sides
//   8  Reef Run      par 5  cape hole: the sea bay down the left; bite off as much as you dare
//   9  Sunset        par 4  home along a lagoon to a green over its arm, the sea beyond the palms
// Conditions: lush and soft (firm 0.95), greens 10.5 ft, normal trade winds.
//
// Authoring helpers (pure data; only WATER is exported): shores are drawn as coarse polygons and
// rounded by Chaikin corner cutting, so they read as natural curves. Water and beaches round a
// green are drawn in the green's own frame (r right, f forward from the green centre, along the
// end of the centreline), and greenside bunkers are placed by their gap to the green's edge.

import { buildPath } from './spline.js';

const DEG = Math.PI / 180;
const r2 = (v) => Math.round(v * 100) / 100;

// Closed Chaikin smoothing: every pass replaces each corner by points at 1/4 and 3/4 of its edges.
function smooth(pts, passes = 3) {
  let p = pts;
  for (let k = 0; k < passes; k++) {
    const q = [];
    for (let i = 0; i < p.length; i++) {
      const a = p[i];
      const b = p[(i + 1) % p.length];
      q.push([0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]], [0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]]);
    }
    p = q;
  }
  return p.map(([x, y]) => [r2(x), r2(y)]);
}

// The green's frame of a centreline: (r, f) metres from the green centre (r to the right, f away
// from the tee, along the end of the path) -> [x, y]. Used for water and sand round greens.
function greenFrame(path) {
  const p = buildPath(path);
  const e = p.pointAt(p.length);
  const t = p.tangentAt(p.length);
  return (r, f) => [e.x + r * t.y + f * t.x, e.y - r * t.x + f * t.y];
}
const inFrame = (fr, pts) => pts.map(([r, f]) => fr(r, f));

// Points along a centreline: (s, off) -> [x, y] (off + to the right, beyond the ends along the end
// tangents, as terrain.js frames them); .len is the hole's length.
function alongPath(path) {
  const p = buildPath(path);
  const at = (s, off) => {
    const q = p.pointAt(s);
    const t = p.tangentAt(s);
    return [r2(q.x + t.y * off), r2(q.y - t.x * off)];
  };
  at.len = p.length;
  return at;
}

// A greenside bunker hugging the green G = {rx, ry, rot} (the HoleDef green): its inner edge `gap` m
// beyond the green's edge at angle a (deg in the green frame: 0 = right, 90 = back, 180 = left,
// 270 = front), `len` m half-length round the green and `wid` m half-width; `lobes` [[t, d, rx, ry]]
// add flashes along (t) and away from (d) the green.
function side(G, a, gap, len, wid, lobes = []) {
  const phi = (a - (G.rot || 0)) * DEG;
  const rho = 1 / Math.hypot(Math.cos(phi) / G.rx, Math.sin(phi) / G.ry);
  const d = rho + gap + wid;
  const ca = Math.cos(a * DEG);
  const sa = Math.sin(a * DEG);
  const shape = [[0, 0, len, wid, a + 90]];
  for (const [t, dd, rx, ry] of lobes) shape.push([r2(-t * sa + dd * ca), r2(t * ca + dd * sa), rx, ry, a + 90]);
  return { g: [r2(d * ca), r2(d * sa)], shape };
}

// Open Chaikin smoothing of a polyline: the end points stay put.
function smoothOpen(pts, passes = 3) {
  let p = pts;
  for (let k = 0; k < passes; k++) {
    const q = [p[0]];
    for (let i = 0; i < p.length - 1; i++) {
      const a = p[i];
      const b = p[i + 1];
      q.push([0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]], [0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]]);
    }
    q.push(p[p.length - 1]);
    p = q;
  }
  return p.map(([x, y]) => [r2(x), r2(y)]);
}

// The hole's bounds as terrain.js computes them: the centreline's box grown by the margin.
function holeBox(path, margin) {
  const p = buildPath(path);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let s = 0; s <= p.length + 5; s += 5) {
    const q = p.pointAt(Math.min(s, p.length));
    minX = Math.min(minX, q.x);
    minY = Math.min(minY, q.y);
    maxX = Math.max(maxX, q.x);
    maxY = Math.max(maxY, q.y);
  }
  return { minX: Math.floor(minX - margin), minY: Math.floor(minY - margin), maxX: Math.ceil(maxX + margin), maxY: Math.ceil(maxY + margin) };
}

// A sea (water with sea: true) bounded by a coastline. `line` runs along the shore with its first
// and last points just outside the hole's bounds (only the inner points are smoothed); the polygon
// closes round the named corners of the bounds ('NE', 'NW', 'SW', 'SE'), pushed far out. The
// renderer clips the sea to the height grid, and this keeps the clipped outline simple (no runs of
// points along the grid edge), while the far corners pull the sea's direction offshore.
const SEA_OUT = 1500;
function seaShore(box, line, corners) {
  const n = line.length;
  const inner = smoothOpen(line.slice(1, n - 1), 2);
  const far = corners.map((c) => [
    c.includes('E') ? box.maxX + SEA_OUT : box.minX - SEA_OUT,
    c.includes('N') ? box.maxY + SEA_OUT : box.minY - SEA_OUT,
  ]);
  return [line[0], ...inner, line[n - 1], ...far];
}

// Palms (with a few broadleaf trees) in rows down both sides of a hole.
function palmRows(from, to, offL, offR, gap = 13) {
  return [
    { kind: { palm: 0.85, broad: 0.15 }, from, to, off: offL, gap, jitter: 4 },
    { kind: { palm: 0.85, broad: 0.15 }, from, to, off: offR, gap, jitter: 4 },
  ];
}

// Background jungle beyond the playing corridor.
const FOREST = { kind: { palm: 0.55, broad: 0.45 }, inner: 48, density: 0.55, spacing: 10 };

// ---- centrelines, greens and the frames the holes are drawn in ----
const P1 = [[0, 0], [6, 140], [-2, 238], [-26, 322], [-34, 342]];
const G1 = { rx: 13, ry: 15, rot: 8 };
const P2 = [[0, 0], [2, 250], [-24, 390], [-22, 466]];
const G2 = { rx: 13, ry: 15, rot: -6 };
const F2 = greenFrame(P2);
const B2 = holeBox(P2, 80);
const G3 = { rx: 13, ry: 12, rot: -12 };
const P4 = [[0, 0], [150, 6], [250, -22], [330, -70], [350, -86]];
const G4 = { rx: 12, ry: 15, rot: -10 };
const F4 = greenFrame(P4);
const P5 = [[0, 0], [-40, 140], [-70, 240], [-84, 302]];
const G5 = { rx: 12, ry: 13, rot: 0 };
const F5 = greenFrame(P5);
const P6 = [[0, 0], [100, -50], [150, -76]];
const G6 = { rx: 13, ry: 13, rot: 20 };
const F6 = greenFrame(P6);
const B6 = holeBox(P6, 70);
const P7 = [[0, 0], [-4, 150], [8, 270], [38, 340], [46, 356]];
const G7 = { rx: 12, ry: 14, rot: 15 };
const L7 = alongPath(P7).len;
const P8 = [[0, 0], [-220, 6], [-340, -36], [-424, -88]];
const G8 = { rx: 13, ry: 15, rot: 10 };
const A8 = alongPath(P8);
const L8 = A8.len;
const B8 = holeBox(P8, 80);
const P9 = [[0, 0], [90, 150], [150, 262], [176, 326]];
const G9 = { rx: 13, ry: 15, rot: -10 };
const F9 = greenFrame(P9);

// A raised tee on a dune: a mound of height h (m) and radius r (m) under the tee box. terrain.js
// flattens the box at the centreline elevation plus tee.raise, so raise includes h (h + ~0.5).
const dune = (h, r = 30) => [0, 0, r, h];

export const WATER = {
  id: 'water',
  name: 'Coral Cay',
  tagline: 'Lagoons, an island green and ocean carries',
  theme: 'tropical',
  conditions: { firm: 0.95, greenStimpFt: 10.5, wind: 'normal' },
  holes: [
    // 1. Opener, a gentle dogleg left from a dune tee. The drive carries the tail of a lagoon (an
    //    easy 85 m, a white beach below the tee), and the lagoon then fills the inside of the corner
    //    with a beach on its near shore: the bold line flirts with it, the fairway right is
    //    generous (a bunker guards the outside of the corner).
    {
      n: 1, par: 4, name: 'Palm Walk', si: 6,
      path: P1,
      elev: [[0, 2.2], [120, 1.3], [240, 1.0], [345, 1.7]],
      corridor: { w: 50, h: 2.5 },
      undulate: 0.45,
      tee: { s: 0, w: 10, l: 16, raise: 3.5 },
      fairway: { from: 130, to: 330, width: [[130, 30], [230, 38], [290, 30], [330, 22]], wobble: 2 },
      green: {
        ...G1, fringe: 1.2, raise: 0.35, slope: [250, 1.2],
        bumps: [[5, 6, 5, 0.07]],
        pins: [[-4, 6], [4, -6], [2, 1]],
      },
      water: [{
        kind: 'red', level: -1.1, bank: 7, depth: 1.8,
        xy: smooth([
          [36, 54], [30, 72], [10, 80], [-16, 84], [-32, 100], [-34, 128], [-24, 150], [-20, 192], [-25, 232], [-38, 262], [-60, 278],
          [-86, 276], [-100, 256], [-104, 226], [-96, 200], [-100, 174], [-88, 148], [-74, 122], [-70, 92], [-72, 64], [-52, 48], [-20, 44], [10, 42],
        ], 2),
      }],
      areas: [
        // The lagoon's beaches: in front of the tee, and between the fairway and the water.
        { surface: 'waste', xy: smooth([[-58, 36], [-20, 34], [16, 34], [42, 44], [46, 52], [30, 46], [0, 44], [-30, 46], [-56, 46]], 2) },
        { surface: 'waste', xy: smooth([[-18, 150], [-12, 192], [-16, 236], [-28, 266], [-50, 287], [-70, 290], [-50, 266], [-34, 240], [-30, 196], [-34, 150], [-30, 136]]) },
      ],
      bunkers: [
        { s: 232, off: 21, shape: [[0, 0, 5, 9, -10], [3, 7, 3, 3.5, 0]], depth: 0.7 },
        { ...side(G1, 205, 4, 7, 3.5, [[4, 2, 3, 2.5]]), depth: 0.8 },
        { ...side(G1, 40, 4.5, 6, 3), depth: 0.75 },
      ],
      objects: [
        ...palmRows(20, 330, -34, 36),
        { kind: 'palm', s: 205, off: -36, cluster: 4, spread: 6 },
        { kind: 'palm', s: 380, off: 4, cluster: 6, spread: 14 },
        { kind: 'palm', s: -14, off: 14, cluster: 3, spread: 5 },
      ],
      mounds: [dune(3), [190, 30, 12, 1.2], [300, 28, 10, 0.9]],
      forest: FOREST,
      ob: { left: null, right: null },
      bounds: { margin: 82 },
    },

    // 2. Split-fairway par 5. Beyond the landing area a lagoon divides the hole. The left branch,
    //    between the lagoon and the beach (the sea beyond it), is narrow but runs straight at an
    //    open green, in range in two from a good drive; the wide right branch, across the lagoon's
    //    foot, is the safer second but leaves a pitch over the lagoon's top arm.
    {
      n: 2, par: 5, name: 'The Fork', si: 3,
      path: P2,
      elev: [[0, 2.0], [200, 1.2], [330, 0.9], [466, 1.4]],
      corridor: { w: 60, h: 2 },
      undulate: 0.4,
      tee: { s: 0, w: 10, l: 16, raise: 3.0 },
      fairway: [
        { from: 175, to: 300, width: [[175, 36], [250, 44], [300, 40]], wobble: 2 },
        { from: 296, to: 452, width: [[296, 30], [380, 26], [452, 22]], wobble: 1.6 },
      ],
      green: {
        ...G2, fringe: 1.2, raise: 0.35, slope: [215, 1.1],
        bumps: [[-5, 7, 5, 0.06]],
        pins: [[4, 6], [-4, -6], [-2, 1]],
      },
      water: [
        {
          kind: 'red', level: -1.0, bank: 7, depth: 1.8,
          xy: smooth([[14, 300], [36, 296], [52, 316], [56, 360], [50, 405], [40, 436], ...inFrame(F2, [[38, -16], [30, -2], [22, -6]]), [6, 440], [4, 400], [5, 350], [4, 318]]),
        },
        // The sea beyond the beach on the left.
        {
          kind: 'red', level: -1.3, bank: 10, depth: 3, sea: true,
          xy: seaShore(B2, [[-66, B2.minY - 8], [-62, -40], [-62, 60], [-70, 200], [-72, 300], [-84, 380], [-90, 470], [-84, 520], [-80, B2.maxY + 8]], ['NW', 'SW']),
        },
      ],
      areas: [
        // The right branch of the fork, beyond the lagoon.
        { surface: 'fairway', xy: smooth([[60, 300], [86, 302], [94, 350], [92, 410], [80, 432], [64, 420], [62, 370], [58, 318]], 2) },
        // Beach along the sea.
        { surface: 'waste', xy: smooth([[-46, B2.minY - 10], [-44, -40], [-44, 60], [-52, 200], [-54, 300], [-66, 380], [-72, 470], [-66, 520], [-62, B2.maxY + 10], [-110, B2.maxY + 10], [-110, B2.minY - 10]], 2) },
      ],
      bunkers: [
        { s: 262, off: -24, shape: [[0, 0, 5, 9, 6], [-2, 8, 3, 3, 0]], depth: 0.7 },
        { ...side(G2, 185, 4, 7, 3.5), depth: 0.8 },
        { ...side(G2, 100, 4.5, 7, 3, [[-6, 1, 3, 2.5]]), depth: 0.75 },
        { ...side(G2, 238, 5, 3, 3), depth: 0.9 },
      ],
      objects: [
        { kind: { palm: 0.9, broad: 0.1 }, from: 20, to: 280, off: -40, gap: 14, jitter: 4 },
        { kind: { palm: 0.85, broad: 0.15 }, from: 20, to: 280, off: 38, gap: 13, jitter: 4 },
        { kind: 'palm', from: 300, to: 440, off: -34, gap: 16, jitter: 3 },
        { kind: 'palm', s: 500, off: 0, cluster: 7, spread: 16 },
        { kind: 'palm', s: 360, off: 125, cluster: 6, spread: 14 },
        { kind: 'palm', s: -14, off: -14, cluster: 3, spread: 5 },
        { kind: 'palm', from: 30, to: 520, off: -56, gap: 26, jitter: 5 },
      ],
      mounds: [dune(2.5), [150, 30, 12, 1.0]],
      forest: { ...FOREST, inner: 70 },
      ob: { left: null, right: null },
      bounds: { margin: 80 },
    },

    // 3. The island green, Sawgrass style: a thin collar of rough round the green and its little
    //    bunker, water on every side, the tee on its own palm islet. Short or long drops back
    //    where the ball crossed into the lagoon.
    {
      n: 3, par: 3, name: 'The Island', si: 8,
      path: [[0, 0], [0, 70], [0, 133]],
      elev: [[0, 1.4], [133, 1.4]],
      undulate: 0.2,
      tee: { s: 0, w: 10, l: 14, raise: 0.5 },
      fairway: [],
      green: {
        ...G3, fringe: 1.2, raise: 0.25, slope: [250, 1.0],
        bumps: [[4, 4, 4, 0.05]],
        pins: [[5, 3], [-5, -3], [-1, 5]],
      },
      water: [
        // The green island first: it sets the lagoon's level, depth and banks.
        {
          kind: 'red', fill: 'outside', level: -1.1, bank: 3.5, depth: 2.4,
          xy: smooth([[-13, 113], [5, 112], [18, 118], [22, 133], [19, 147], [8, 154], [-9, 157], [-25, 152], [-31, 138], [-26, 121]]),
        },
        // The tee islet.
        {
          kind: 'red', fill: 'outside',
          xy: smooth([[-17, -36], [7, -40], [24, -27], [25, -4], [18, 15], [5, 23], [-10, 21], [-21, 7], [-24, -16]]),
        },
      ],
      areas: [
        { surface: 'waste', xy: smooth([[-24, -30], [-6, -42], [12, -40], [-4, -30], [-20, -18]], 2) },
      ],
      bunkers: [{ ...side(G3, 185, 4, 4, 2.4), depth: 0.6 }],
      objects: [
        { kind: 'palm', s: -22, off: 12, cluster: 3, spread: 6 },
        { kind: 'palm', s: -10, off: -16, cluster: 2, spread: 4 },
        { kind: 'palm', s: 150, off: -21, cluster: 2, spread: 2.5 },
      ],
      forest: false,
      ob: { left: null, right: null },
      bounds: { margin: 60 },
    },

    // 4. The hardest hole. From a tee high on a dune the drive must carry a lagoon inlet (about
    //    125 m on the line, less to the left), then the lagoon runs down the whole inside of the
    //    dogleg right to the green's right edge. Left is dry all the way.
    {
      n: 4, par: 4, name: 'Mangroves', si: 1,
      path: P4,
      corners: [250],
      elev: [[0, 3.2], [60, 1.6], [180, 1.2], [300, 1.0], [372, 1.8]],
      corridor: { w: 55, h: 3 },
      undulate: 0.45,
      tee: { s: 0, w: 10, l: 16, raise: 2.6 },
      fairway: { from: 150, to: 360, width: [[150, 30], [220, 34], [300, 30], [360, 22]], wobble: 2 },
      green: {
        ...G4, fringe: 1.2, raise: 0.4, slope: [160, 1.2],
        bumps: [[-5, 5, 4, 0.06]],
        pins: [[-4, 6], [3, -6], [-1, 0]],
      },
      water: [{
        kind: 'red', level: -1.1, bank: 7, depth: 2,
        xy: smooth([
          [24, -6], [32, 16], [62, 28], [100, 24], [134, 12], [150, -14], [192, -36], [240, -52], [280, -72],
          ...inFrame(F4, [[22, -30], [24, -8], [26, 14], [40, 20]]),
          [330, -150], [270, -150], [180, -125], [100, -100], [40, -76], [14, -40],
        ], 2),
      }],
      areas: [
        { surface: 'waste', xy: smooth([[150, -6], [196, -26], [244, -42], [284, -60], [300, -78], [270, -82], [230, -64], [188, -48], [160, -30], [140, -20]]) },
        { surface: 'waste', xy: smooth([[30, 20], [62, 34], [100, 30], [128, 20], [104, 18], [64, 22]], 2) },
      ],
      bunkers: [
        { s: 228, off: -22, shape: [[0, 0, 5, 10, -6], [-3, 8, 3, 3.5, 0]], depth: 0.75 },
        { ...side(G4, 180, 4, 8, 3.5), depth: 0.85 },
        { ...side(G4, 110, 4.5, 6, 3), depth: 0.8 },
      ],
      objects: [
        { kind: { palm: 0.8, broad: 0.2 }, from: 20, to: 350, off: -42, gap: 12, jitter: 4 },
        { kind: 'palm', from: 175, to: 300, off: 30, gap: 18, jitter: 3 },
        { kind: { broad: 0.7, palm: 0.3 }, s: 120, off: 115, cluster: 8, spread: 20 },
        { kind: 'palm', s: 395, off: 0, cluster: 6, spread: 14 },
        { kind: 'palm', s: -16, off: -12, cluster: 3, spread: 5 },
      ],
      mounds: [dune(2, 26), [200, -32, 12, 1.2]],
      forest: FOREST,
      ob: { left: null, right: null },
      bounds: { margin: 75 },
    },

    // 5. Short par 4 to a peninsula green: a broad lagoon fills the right of the hole and wraps
    //    round the green's right side, back and left. The front is open, so a running approach or
    //    a miss short-left is safe.
    {
      n: 5, par: 4, name: 'Peninsula', si: 7,
      path: P5,
      elev: [[0, 1.8], [150, 1.0], [302, 1.3]],
      corridor: { w: 50, h: 2.5 },
      undulate: 0.4,
      tee: { s: 0, w: 10, l: 15, raise: 3.0 },
      fairway: { from: 120, to: 290, width: [[120, 30], [210, 34], [260, 28], [290, 20]], wobble: 2 },
      green: {
        ...G5, fringe: 1.2, raise: 0.45, slope: [250, 1.2],
        bumps: [[4, 5, 4, 0.06]],
        pins: [[-3, 5], [3, -5], [4, 3]],
      },
      water: [{
        kind: 'red', level: -1.0, bank: 3.5, depth: 2,
        xy: smooth(inFrame(F5, [
          [24, -160], [23, -110], [22, -60], [20, -18], [20, 4], [16, 16], [6, 21], [-6, 21], [-15, 16], [-20, 6], [-22, -6],
          [-30, -16], [-46, -20], [-60, -4], [-62, 24], [-54, 50], [-24, 62], [20, 62], [70, 52], [104, 30], [112, -40], [108, -110], [90, -165],
        ]), 2),
      }],
      areas: [
        { surface: 'waste', xy: smooth(inFrame(F5, [[15, -160], [16, -110], [15, -60], [14, -28], [24, -40], [28, -110], [28, -160]]), 2) },
      ],
      bunkers: [
        { s: 222, off: -21, shape: [[0, 0, 4.5, 9, 5]], depth: 0.75 },
        { ...side(G5, 225, 4, 5, 3), depth: 0.8 },
      ],
      objects: [
        { kind: { palm: 0.8, broad: 0.2 }, from: 20, to: 300, off: -38, gap: 12, jitter: 4 },
        { kind: 'palm', from: 20, to: 140, off: 34, gap: 13, jitter: 3 },
        { kind: 'palm', s: 330, off: -48, cluster: 5, spread: 10 },
        { kind: 'palm', s: -14, off: 13, cluster: 3, spread: 5 },
      ],
      mounds: [dune(2.5, 28), [160, -30, 12, 1.1]],
      forest: FOREST,
      ob: { left: null, right: null },
      bounds: { margin: 75 },
    },

    // 6. Par 3 from a tee high on the dunes down to the shore: the beach and the sea run round the
    //    right of and behind the green. Bail out left, where a bunker and a palm-topped dune wait.
    {
      n: 6, par: 3, name: 'Shell Beach', si: 9,
      path: P6,
      elev: [[0, 3.0], [60, 2.0], [168, 1.6]],
      corridor: { w: 45, h: 2.5 },
      undulate: 0.35,
      tee: { s: 0, w: 10, l: 13, raise: 4.5 },
      fairway: { from: 115, to: 158, width: [[115, 18], [158, 26]], wobble: 1 },
      green: {
        ...G6, fringe: 1.2, raise: 0.3, slope: [120, 1.1],
        bumps: [[-4, 4, 4, 0.06]],
        pins: [[-4, 4], [4, -4], [-1, -1]],
      },
      water: [{
        kind: 'red', level: -1.2, bank: 8, depth: 3, sea: true,
        xy: seaShore(B6, [
          [20, B6.minY - 8], [24, -128], [50, -110], [78, -96], ...inFrame(F6, [[28, -40], [27, -12], [25, 10], [16, 26], [2, 33], [-12, 38]]),
          [204, -56], [208, -20], [214, 24], [B6.maxX + 8, 62],
        ], ['SE']),
      }],
      areas: [
        {
          surface: 'waste',
          xy: smooth([
            [16, B6.minY - 10], [20, -118], [46, -98], [74, -86], ...inFrame(F6, [[18, -40], [18, -14], [17, 6], [10, 19], [0, 23], [-12, 27]]),
            [196, -56], [198, -20], [204, 24], [B6.maxX + 10, 56], [B6.maxX + 10, B6.minY - 10],
          ], 2),
        },
      ],
      bunkers: [
        { ...side(G6, 175, 4, 7, 3.5, [[-5, 1, 3, 2.5]]), depth: 0.8 },
        { ...side(G6, 255, 5, 5, 2.8), depth: 0.7 },
      ],
      objects: [
        { kind: { palm: 0.8, broad: 0.2 }, from: 10, to: 170, off: -34, gap: 12, jitter: 4 },
        { kind: 'palm', s: 150, off: -38, cluster: 5, spread: 9 },
        { kind: 'palm', from: 30, to: 120, off: 24, gap: 22, jitter: 4 },
        { kind: 'palm', s: -14, off: -12, cluster: 3, spread: 5 },
        { kind: 'palm', g: [-10, 27], cluster: 3, spread: 5 },
        { kind: 'palm', g: [22, -34], cluster: 2, spread: 4 },
      ],
      mounds: [dune(3.8, 32), [140, -36, 10, 1.4]],
      forest: FOREST,
      ob: { left: null, right: null },
      bounds: { margin: 70 },
    },

    // 7. A coral spit in the ocean. The drive carries a cove of surf (or follows the beach round the
    //    left), then the fairway runs along the spit with beach and breakers on the right and a
    //    palm fringe on the left, to a green on the point.
    {
      n: 7, par: 4, name: 'Breakers', si: 2,
      path: P7,
      corners: [270],
      elev: [[0, 3.4], [60, 2.2], [150, 1.8], [356, 2.0]],
      corridor: { w: 60, h: 1 },
      undulate: 0.35,
      tee: { s: 0, w: 10, l: 14, raise: 0.5 },
      outside: 'water',
      outsideWater: { kind: 'red', level: -1.5, depth: 3, bank: 7, sea: true },
      rough: { w: 13, tee: 7, green: 9, wobble: 2 },
      fairway: { from: 110, to: 342, width: [[110, 26], [200, 32], [290, 28], [342, 20]], wobble: 2 },
      green: {
        ...G7, fringe: 1.2, raise: 0.3, slope: [200, 1.1],
        bumps: [[4, -5, 4, 0.06]],
        pins: [[-3, 5], [4, -5], [-1, -1]],
      },
      areas: [
        // The beach on the right of the spit.
        { surface: 'waste', poly: smooth([[140, 18], [200, 22], [260, 22], [300, 20], [330, 16], [334, 30], [300, 38], [230, 44], [170, 40], [138, 30]], 1) },
        // The beach round the left of the cove, from the tee to the spit.
        { surface: 'waste', poly: smooth([[-10, -6], [20, -22], [60, -28], [100, -28], [130, -22], [152, -18], [150, -36], [110, -44], [60, -46], [20, -40], [-12, -22]], 1) },
        // A crescent of sand on the point behind the green.
        { surface: 'waste', poly: smooth([[L7 + 17, 18], [L7 + 30, 20], [L7 + 40, 6], [L7 + 37, -10], [L7 + 25, -18], [L7 + 17, -14], [L7 + 20, 0]], 2) },
      ],
      bunkers: [
        { s: 238, off: -17, shape: [[0, 0, 4, 8, 4]], depth: 0.6 },
        { ...side(G7, 190, 3.5, 6, 3), depth: 0.6 },
      ],
      objects: [
        { kind: 'palm', from: 140, to: 330, off: -24, gap: 14, jitter: 3 },
        { kind: 'palm', from: 10, to: 140, off: -36, gap: 14, jitter: 4 },
        { kind: 'grass', area: 0, density: 1.2 },
        { kind: 'grass', area: 1, density: 1.2 },
        { kind: 'palm', s: L7 + 30, off: 10, cluster: 3, spread: 4 },
      ],
      forest: false,
      ob: { left: null, right: null },
      bounds: { margin: 70 },
    },

    // 8. Cape par 5 round a sea bay on the left. The braver the drive bites across the bay, the
    //    shorter the hole; the second can be laid up right of the bay or fired at a green on the
    //    shore with the sea left and behind.
    {
      n: 8, par: 5, name: 'Reef Run', si: 5,
      path: P8,
      elev: [[0, 2.4], [150, 1.4], [300, 1.0], [450, 1.6]],
      corridor: { w: 55, h: 2.5 },
      undulate: 0.45,
      tee: { s: 0, w: 10, l: 16, raise: 3.5 },
      fairway: { from: 165, to: 440, width: [[165, 34], [250, 38], [330, 32], [400, 28], [440, 22]], wobble: 2 },
      green: {
        ...G8, fringe: 1.2, raise: 0.35, slope: [220, 1.1],
        bumps: [[5, 5, 5, 0.06]],
        pins: [[4, 6], [-4, -6], [2, -1]],
      },
      water: [{
        kind: 'red', level: -1.3, bank: 10, depth: 3, sea: true,
        xy: seaShore(B8, [
          [B8.maxX + 8, A8(-60, -48)[1]], A8(-40, -47), A8(60, -45), A8(160, -40), A8(220, -32), A8(270, -27), A8(320, -31),
          A8(370, -40), A8(L8 - 40, -36), A8(L8 - 10, -36), A8(L8 + 18, -28), A8(L8 + 36, -8), A8(L8 + 46, 20), [B8.minX - 8, A8(L8 + 50, 40)[1]],
        ], ['SW', 'SE']),
      }],
      areas: [
        {
          surface: 'waste',
          poly: smooth([[-140, -33], [-40, -32], [60, -30], [160, -25], [220, -17], [270, -13], [320, -16], [370, -25], [L8 - 40, -21], [L8 - 10, -20],
            [L8 + 14, -14], [L8 + 28, 4], [L8 + 34, 30], [L8 + 34, 60], [L8 + 90, 60], [L8 + 90, -140], [-140, -140]], 2),
        },
      ],
      bunkers: [
        { s: 250, off: 22, shape: [[0, 0, 5, 10, -8]], depth: 0.75 },
        { s: 372, off: 20, shape: [[0, 0, 4.5, 8, 10], [-2, 7, 3, 3, 0]], depth: 0.7 },
        { ...side(G8, 350, 4, 8, 3.5), depth: 0.8 },
        { ...side(G8, 95, 4.5, 6, 3), depth: 0.75 },
      ],
      objects: [
        { kind: { palm: 0.85, broad: 0.15 }, from: 20, to: 440, off: 40, gap: 12, jitter: 4 },
        { kind: 'palm', from: 20, to: 210, off: -24, gap: 16, jitter: 3 },
        { kind: 'palm', s: 480, off: 26, cluster: 6, spread: 12 },
        { kind: 'palm', s: -14, off: 14, cluster: 3, spread: 5 },
        { kind: 'palm', from: 30, to: 430, off: -30, gap: 28, jitter: 4 },
      ],
      mounds: [dune(3), [210, 34, 12, 1.2], [330, 36, 12, 1.0]],
      forest: FOREST,
      ob: { left: null, right: null },
      bounds: { margin: 80 },
    },

    // 9. Home hole. A lagoon runs down the left of the drive zone and curls across the front of
    //    the green, so the approach from the left carries water; the open door is right. The sea
    //    lies beyond the palms behind the green.
    {
      n: 9, par: 4, name: 'Sunset', si: 4,
      path: P9,
      elev: [[0, 2.0], [150, 1.1], [270, 1.0], [330, 1.6]],
      corridor: { w: 55, h: 2.5 },
      undulate: 0.4,
      tee: { s: 0, w: 10, l: 16, raise: 3.5 },
      fairway: { from: 140, to: 300, width: [[140, 32], [220, 36], [270, 30], [300, 26]], wobble: 2 },
      green: {
        ...G9, fringe: 1.2, raise: 0.4, slope: [210, 1.2],
        tiers: [{ angle: 90, at: 0, h: 0.22, w: 7 }],
        pins: [[4, 9.5], [-4, -9.5], [3, -9.5]],
      },
      water: [{
        kind: 'red', level: -1.1, bank: 6, depth: 2,
        xy: smooth(inFrame(F9, [
          [-30, -215], [-30, -160], [-30, -110], [-26, -72], [-16, -50], [-2, -44], [10, -40], [16, -32], [12, -26], [2, -24], [-12, -25],
          [-28, -28], [-44, -38], [-60, -64], [-68, -110], [-66, -170], [-54, -220],
        ]), 2),
      }],
      areas: [
        { surface: 'waste', xy: smooth(inFrame(F9, [[-22, -205], [-21, -150], [-21, -100], [-20, -76], [-31, -72], [-36, -110], [-36, -160], [-34, -205]]), 2) },
      ],
      bunkers: [
        { s: 232, off: 22, shape: [[0, 0, 5, 9, -10]], depth: 0.75 },
        { ...side(G9, 0, 4, 8, 3.5), depth: 0.85 },
        { ...side(G9, 105, 4.5, 6, 3), depth: 0.75 },
      ],
      objects: [
        { kind: { palm: 0.85, broad: 0.15 }, from: 20, to: 320, off: 36, gap: 12, jitter: 4 },
        { kind: 'palm', from: 20, to: 130, off: -34, gap: 14, jitter: 3 },
        { kind: 'palm', s: 362, off: 0, cluster: 9, spread: 18 },
        { kind: 'palm', from: 150, to: 300, off: -28, gap: 24, jitter: 3 },
        { kind: 'palm', s: -14, off: 14, cluster: 3, spread: 5 },
      ],
      mounds: [dune(3), [200, 34, 12, 1.2]],
      forest: FOREST,
      ob: { left: null, right: null },
      bounds: { margin: 75 },
    },
  ],
};
