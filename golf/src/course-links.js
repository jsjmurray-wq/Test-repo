// Kittiwake Links: the links course (theme 'links', docs/architecture.md section 8.2). An old
// Scottish seaside links laid through the sandhills between the town and the shore: firm, fast and
// rumpled fairways, deep revetted pot bunkers in the driving zones and round the greens, tall
// fescue and marram on the dunes (outside: 'fescue') with gorse (whin) thickets on their crests,
// big wild greens on plateaus with run-offs and false fronts, a burn, the beach and the sea.
//   1  Kittiwake     par 4  opener along the shore: beach and sea all down the left behind a low
//                           dune ridge, sandhills and gorse on the right, pots either side of the
//                           driving zone; a green open in front to run the ball onto
//   2  Sandhills     par 4  the blind drive: a marram-covered dune ridge crosses the hole 100-140 m
//                           out; the fairway beyond falls into a valley guarded by pots, then up to
//                           a plateau green with run-offs on both sides
//   3  Postage       par 3  short, from a high dune tee to a long narrow green on a shelf in the
//                           dunes, ringed by six pots (the Coffin left), a big dune on the left
//   4  Hell          par 5  the long one: the Beardies (a nest of pots) left of the driving zone,
//                           out of bounds (the old wall) all down the right, Hell bunker in the
//                           middle of the second-shot landing zone, a huge green on a plateau
//                           behind a steep false front
//   5  Burnside      par 4  wide open drive; the burn (red) crosses just in front of a green that
//                           slopes back toward it
//   6  Whins         par 4  the hardest: a long dogleg right through the gorse-crested dunes, pots
//                           in the elbow, to a green in a dell
//   7  Haar          par 3  long, toward the sea: an open, firm entrance between two pots invites
//                           the running shot; the green falls away at the back
//   8  Strand        par 5  along the shore again, the sea on the right: the beach cuts in at the
//                           second-shot landing zone, a line of cross pots, the green by the beach
//   9  Home          par 4  the home hole: a huge fairway, out of bounds right (the town), pots
//                           down the left, and the Valley of Sin, a deep hollow short-left of a
//                           big two-tier green
// Conditions (section 8.2): firm 1.45 (a drive landing on the fairway runs on 30-40 yd, a 7-iron
// releases on the firm greens and a wedge stops by its pitch mark instead of spinning back), greens
// 9.5 ft, windy. Bump & run and punch shots are the natural play: the greens are open in front,
// raised on firm ground, with short grass (fairway-cut run-offs) all round.
//
// Design notes (for a ~5 handicap: driver ~240 yd carry, plus 30-40 yd of run on firm turf):
//  - Every tee shot has a wide line: fairways are 40-58 m wide where drives land, with ~9 m of
//    rough before the fescue. The pots in the landing zones sit off the aim line (the bold player
//    flirts with them); the greenside pots leave an open front on every green but the Postage.
//  - Fescue stops a ball dead and costs distance (the way out is a short iron or a wedge, lie.js),
//    but it is never a penalty. Gorse (whin) is nearly unplayable (a ball inside a bush is hacked
//    out 20-30 yd, lie.js BUSH_LIE), so the thickets stand on the dunes, 20 m or more from any
//    short grass.
//  - Pot bunkers are deep with revetted sod faces (terrain.potAt, physics REVET): a long club from
//    the floor dies against the face; the way out is a wedge or a flop, sideways if need be.
//  - The sandhills come from the corridor rise (the land climbs beyond ~45 m of the centreline)
//    plus chains of dune humps down each side; bare-sand blowouts scar their faces.
//  - The sea and the burn are red penalty areas (lateral relief), with sand or grass beside them
//    to drop on.
//  - Greens are 9.5 ft: planes at 1.3-1.8% with tiers and humps, all under 5%; three pins each
//    on calm spots (<= 2.5% within 2 m, >= 4 m inside the fringe).
//  - Pot bunker faces (the revetted walls) are the only ground steeper than ~41 deg: dunes and
//    mounds stay well under that, so the renderer's sod only appears on the pots.
//
// HoleDef format: course.js and terrain.js headers. Features are placed by (s, off) along the
// centreline (off + = right looking down the hole) or green-relative g: [r, f] (r right, f away
// from the tee, from the green centre). Authoring helpers below are pure data builders; only
// LINKS is exported.

import { buildPath } from './spline.js';
import { makeProfile } from './terrain.js';
import { mulberry32 } from './rng.js';

const DEG = Math.PI / 180;
const r2 = (v) => Math.round(v * 100) / 100;

// ------------------------------------------------------------------ authoring helpers

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

// A band either side of a polyline [[x, y], ...]: the closed polygon between offsets a and b
// (metres along the polyline's left normal; a < b). Used for beaches along a shore.
function band(line, a, b) {
  const nrm = line.map((p, i) => {
    const q0 = line[Math.max(0, i - 1)];
    const q1 = line[Math.min(line.length - 1, i + 1)];
    const dx = q1[0] - q0[0];
    const dy = q1[1] - q0[1];
    const l = Math.hypot(dx, dy) || 1;
    return [-dy / l, dx / l];
  });
  const side = (d) => line.map((p, i) => [p[0] + nrm[i][0] * d, p[1] + nrm[i][1] * d]);
  return [...side(a), ...side(b).reverse()];
}

// The sea (red, sea: true) beyond a coastline. `line` runs along the shore, its first and last
// points outside the hole's bounds; the polygon closes round the named corners of the bounds
// ('NE', 'NW', 'SW', 'SE', in order from the line's last point back to its first) pushed far out
// to sea, so the polygon stays simple, the renderer clips it to a clean shoreline and
// the far corners pull the sea's direction offshore. `abs` is the absolute water level: HoleDef
// levels are relative to the centreline elevation at the polygon's centroid, so it is converted
// the way terrain.js measures it.
const SEA_OUT = 1500;
function sea(path, elev, box, line, corners, abs, extra = {}) {
  const n = line.length;
  const xy = [line[0], ...smoothOpen(line.slice(1, n - 1), 1), line[n - 1]];
  for (const c of corners) {
    xy.push([c.includes('E') ? box.maxX + SEA_OUT : box.minX - SEA_OUT, c.includes('N') ? box.maxY + SEA_OUT : box.minY - SEA_OUT]);
  }
  const p = buildPath(path);
  const cx = xy.reduce((a, q) => a + q[0], 0) / xy.length;
  const cy = xy.reduce((a, q) => a + q[1], 0) / xy.length;
  const sRef = Math.min(p.length, Math.max(0, p.project(cx, cy).s));
  const level = r2(abs - makeProfile(elev)(sRef));
  return { kind: 'red', sea: true, level, bank: 26, depth: 3, xy, ...extra };
}

// Centreline arc length of a control polygon (the yardage).
const lengthOf = (path) => buildPath(path).length;

// A round pot bunker hugging the green G = {rx, ry, rot} (the HoleDef green): its edge `gap` m
// beyond the green's edge at angle a (deg in the green frame: 0 = right, 90 = back, 180 = left,
// 270 = front), radius r. shape (optional) replaces the circle with ellipses in the pot's frame.
function potG(G, a, gap, r, extra = {}) {
  const phi = (a - (G.rot || 0)) * DEG;
  const rho = 1 / Math.hypot(Math.cos(phi) / G.rx, Math.sin(phi) / G.ry);
  const d = rho + gap + r;
  return { g: [r2(d * Math.cos(a * DEG)), r2(d * Math.sin(a * DEG))], pot: true, r, ...extra };
}

// A pot bunker on the course at (s, off).
const pot = (s, off, r = 2.3, extra = {}) => ({ s, off, pot: true, r, ...extra });

// Rumpled links fairway: n humps and hollows [s, off, radius, height] scattered between s0 and s1
// within `half` m of the centreline (deterministic). Heights alternate in sign a little so the
// ground both kicks and gathers.
function rumples(seed, s0, s1, half, n, h = [0.35, 0.9], r = [6, 11]) {
  const rng = mulberry32(seed);
  const out = [];
  for (let k = 0; k < n; k++) {
    const s = s0 + (s1 - s0) * ((k + rng()) / n);
    const off = (rng() * 2 - 1) * half;
    const hh = h[0] + (h[1] - h[0]) * rng();
    out.push([r2(s), r2(off), r2(r[0] + (r[1] - r[0]) * rng()), r2(rng() < 0.2 ? -0.5 * hh : hh)]);
  }
  return out;
}

// A dune ridge: overlapping mounds along a polyline [[s, off], ...], about `gap` m apart, radius r
// (+-20%) and height h (+-30%) varying along it (deterministic). Neighbours overlap into a lumpy
// crest ~1.2 h high with saddles between the humps; slopes stay under ~0.5 for r >= 4 h.
function dunes(seed, pts, r, h, gap = 0.85 * r) {
  const rng = mulberry32(seed);
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const [s0, o0] = pts[i];
    const [s1, o1] = pts[i + 1];
    const L = Math.hypot(s1 - s0, o1 - o0);
    const n = Math.max(1, Math.round(L / gap));
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5 * rng()) / n;
      out.push([r2(s0 + (s1 - s0) * t), r2(o0 + (o1 - o0) * t), r2(r * (0.8 + 0.4 * rng())), r2(h * (0.7 + 0.6 * rng()))]);
    }
  }
  return out;
}

// A dune ridge round a green: like dunes() with the polyline given green-relative ([r, f] from the
// green centre). Beyond the end of the centreline the (s, off) frame runs on along the end tangent,
// as the green frame does, so (r, f) is (s = L + f, off = r).
const greenDunes = (L, seed, pts, r, h) => dunes(seed, pts.map(([rr, f]) => [L + f, rr]), r, h);

// The sandhills framing a hole: a wandering chain of dune humps down each side between s0 and s1,
// at about offL (negative, left) and offR (right), their line drifting by up to `wob` m.
function sandhills(seed, s0, s1, offL, offR, r, h, wob = 8) {
  const rng = mulberry32(seed);
  const side = (off) => {
    const pts = [];
    for (let s = s0; s < s1 + 39; s += 40) pts.push([Math.min(s, s1), off + Math.sign(off) * wob * (rng() * 2 - 1)]);
    return pts;
  };
  const out = [];
  if (offL != null) out.push(...dunes(seed + 1, side(offL), r, h));
  if (offR != null) out.push(...dunes(seed + 2, side(offR), r, h));
  return out;
}

// A sand blowout: a scar of bare sand (waste) scooped out of a dune face at (s, off), rx along the
// hole and ry across it, turned by rot degrees.
const blowout = (s, off, rx, ry, rot = 0) => ({
  surface: 'waste', s, off, dz: -0.6, ease: 4,
  shape: [[0, 0, rx, ry, rot], [r2(rx * 0.45), r2(ry * 0.5), r2(rx * 0.55), r2(ry * 0.8), rot + 40], [r2(-rx * 0.5), r2(-ry * 0.3), r2(rx * 0.5), r2(ry * 0.75), rot - 30]],
});

// A hummock of rough left standing in the fairway short of the driving zone (only a topped shot
// finds it): a raised island of longer grass.
const hummock = (s, off, rx, ry, rot = 0) => ({ surface: 'rough', s, off, shape: [[0, 0, rx, ry, rot], [r2(rx * 0.5), r2(ry * 0.4), r2(rx * 0.6), r2(ry * 0.7), rot + 30]], dz: 0.9, ease: 3 });

// Closely mown surrounds (run-off areas) round a green: an ellipse `pad` m wider than the green.
const surrounds = (G, pad = 9, extra = {}) => ({ surface: 'fairway', g: [0, 0], shape: [[0, 0, G.rx + pad, G.ry + pad, G.rot || 0]], ...extra });

// The links look: rough band, fescue beyond with dune grass, no trees.
const ROUGH = { w: 9, tee: 6, green: 7, wobble: 3, relief: 0.7 };
const GRASS = { kind: 'grass', area: 'fescue', density: 2.6 };
// Gorse thickets: a row along a dune crest, or a clump.
const gorseRow = (from, to, off, gap = 6) => ({ kind: 'gorse', from, to, off, gap, jitter: 3 });
const gorse = (s, off, n = 6, spread = 8) => ({ kind: 'gorse', s, off, cluster: n, spread });

// ------------------------------------------------------------------ the holes' frames

// 1. Kittiwake: north along the shore (the sea to the west, on the left).
const P1 = [[0, 0], [5, 120], [-2, 230], [-20, 332]];
const E1 = [[0, 4.6], [45, 3.4], [150, 2.4], [260, 2.6], [340, 3.3]];
const G1 = { rx: 16, ry: 18, rot: 12 };
const L1 = lengthOf(P1);
const B1 = holeBox(P1, 100);
// Traversed south to north: the left normal points west, out to sea.
const SHORE1 = [[-68, B1.minY - 10], [-66, -40], [-72, 40], [-86, 110], [-78, 175], [-84, 235], [-102, 295], [-106, 360], [-114, B1.maxY + 10]];

// 2. Sandhills: east, blind over the ridge.
const P2 = [[0, 0], [120, -2], [250, 6], [370, -4]];
const G2 = { rx: 15, ry: 17, rot: -8 };
const L2 = lengthOf(P2);

// 3. Postage: south, down from a high dune tee.
const P3 = [[0, 0], [-4, -70], [-6, -140]];
const G3 = { rx: 9.5, ry: 17, rot: 0 };
const L3 = lengthOf(P3);

// 4. Hell: north, OB (the old wall) right.
const P4 = [[0, 0], [10, 150], [-12, 285], [-4, 390], [8, 470]];
const G4 = { rx: 19, ry: 15, rot: -6 };
const L4 = lengthOf(P4);

// 5. Burnside: east-north-east, the burn in front of the green.
const P5 = [[0, 0], [150, 22], [316, 58]];
const G5 = { rx: 17, ry: 14, rot: 4 };
const L5 = lengthOf(P5);

// 6. Whins: north, dogleg right.
const P6 = [[0, 0], [-30, 170], [-18, 290], [34, 390]];
const G6 = { rx: 15, ry: 17, rot: 20 };
const L6 = lengthOf(P6);

// 7. Haar: south-west, toward the sea.
const P7 = [[0, 0], [-62, -68], [-122, -140]];
const G7 = { rx: 17, ry: 18, rot: -10 };
const L7 = lengthOf(P7);

// 8. Strand: west along the shore (the sea to the north, on the right).
const P8 = [[0, 0], [-170, -8], [-330, 8], [-458, 40]];
const E8 = [[0, 3.2], [150, 2.3], [330, 1.9], [470, 2.6]];
const G8 = { rx: 16, ry: 15, rot: 15 };
const L8 = lengthOf(P8);
const B8 = holeBox(P8, 80);
// Traversed east to west: the left normal points south, inland.
const SHORE8 = [[B8.maxX + 10, 72], [40, 70], [-60, 64], [-150, 66], [-220, 56], [-280, 50], [-340, 62], [-400, 76], [-470, 86], [B8.minX - 10, 92]];

// 9. Home: east, OB right (the town).
const P9 = [[0, 0], [150, -4], [270, 6], [360, 0]];
const G9 = { rx: 20, ry: 16, rot: 0 };
const L9 = lengthOf(P9);

// The burn on the 5th: a meandering channel 4-6 m wide crossing the hole just short of the green,
// as an (s, off) polygon from off -70 to +70. Its far bank stays 13+ m short of the green's front
// edge (the bank must not reach the green's own surround).
function burn5() {
  const a = [];
  const b = [];
  for (let off = -70; off <= 70; off += 4) {
    const c = L5 - 34 + 4.5 * Math.sin(off / 12 + 0.6) + 1.5 * Math.sin(off / 5.3);
    const w = 2.5 + 0.6 * Math.sin(off / 9) + 0.3 * Math.sin(off / 3.7);
    a.push([r2(c - w), off]);
    b.push([r2(c + w), off]);
  }
  return [...a, ...b.reverse()];
}

// ------------------------------------------------------------------ the course

export const LINKS = {
  id: 'links',
  name: 'Kittiwake Links',
  tagline: 'Firm, fast and windswept seaside links',
  theme: 'links',
  conditions: { firm: 1.45, greenStimpFt: 9.5, wind: 'windy' },
  holes: [
    // 1. Kittiwake. The opener runs north along the shore from a tee up in the dunes: beach and
    //    sea all down the left behind a low, broken dune ridge, the sandhills rising on the right
    //    with gorse on their crests. A pot on the sea side of the driving zone and two on the right;
    //    the green sits a little up, pots left and right, the front open for a running shot.
    {
      n: 1, par: 4, name: 'Kittiwake', si: 6,
      path: P1,
      elev: E1,
      corridor: { w: 44, h: 3 },
      undulate: 1.0,
      tee: { s: 0, w: 9, l: 11, raise: 1.2 },
      fairway: {
        from: 60, to: L1 - 16, wobble: 3,
        width: [[60, 28], [150, 40], [230, 44], [290, 34], [L1 - 16, 26]],
        shift: [[60, 3], [160, -3], [260, 2], [L1 - 16, 0]],
      },
      outside: 'fescue',
      rough: ROUGH,
      green: {
        ...G1, fringe: 1.5, raise: 0.5, slope: [250, 1.3],
        tiers: [{ angle: 70, at: 2, h: 0.28, w: 6 }],
        bumps: [[-10, -3, 4.5, 0.1]],
        pins: [[-4, -9], [4, 11], [8, -9]],
      },
      water: [sea(P1, E1, B1, SHORE1, ['NW', 'SW'], -0.6)],
      areas: [
        { surface: 'waste', xy: smooth(band(SHORE1, -22, 6), 1) },
        surrounds(G1),
        hummock(96, -5, 7, 4, 10),
        blowout(110, 42, 8, 4, 10),
        blowout(250, 46, 9, 5, -20),
        blowout(175, -47, 6, 3.5, 0),
      ],
      bunkers: [
        pot(208, -10, 2.3),
        pot(236, 13, 2.5),
        pot(252, 21, 2.0),
        potG(G1, 235, 3.5, 2.6),
        potG(G1, 345, 3.5, 2.3),
        potG(G1, 140, 4, 2.0),
      ],
      mounds: [
        ...rumples(101, 85, L1 - 40, 18, 12),
        ...dunes(102, [[20, -48], [100, -46], [170, -52], [240, -50], [310, -56]], 14, 2.0, 18),
        ...sandhills(103, -20, L1 + 30, null, 52, 22, 4.5),
      ],
      objects: [
        gorse(40, 64, 6, 8),
        gorse(130, 68, 7, 9),
        gorse(215, 62, 6, 8),
        gorse(300, 66, 7, 9),
        gorse(L1 + 58, 30, 6, 8),
        GRASS,
      ],
      forest: false,
      ob: { left: null, right: null },
      bounds: { margin: 100 },
    },

    // 2. Sandhills. The blind drive: a marram-covered dune ridge with a bare sand face crosses the
    //    hole 100-140 m out, hiding the landing area. Beyond it the fairway falls into a valley with
    //    pots either side of the landing zone, then climbs to a plateau green with run-offs left and
    //    right. No sea on this hole: it lies off to the right, beyond the sandhills.
    {
      n: 2, par: 4, name: 'Sandhills', si: 2,
      path: P2,
      corners: [250],
      elev: [[0, 2.0], [60, 2.6], [180, 0.8], [270, 1.2], [L2, 2.6]],
      corridor: { w: 44, h: 8 },
      undulate: 1.1,
      tee: { s: 0, w: 9, l: 11, raise: 1.0 },
      fairway: { from: 165, to: L2 - 14, width: [[165, 36], [240, 44], [300, 36], [L2 - 14, 26]], wobble: 3 },
      outside: 'fescue',
      rough: ROUGH,
      green: {
        ...G2, fringe: 1.5, raise: 1.0, slope: [235, 1.4],
        tiers: [{ angle: 100, at: 1, h: 0.25, w: 6 }],
        bumps: [[-7, -9, 4.5, 0.1]],
        pins: [[5, -8], [-4, 11], [7, 10]],
      },
      areas: [
        surrounds(G2),
        // The sandy face of the ridge, seen from the tee.
        blowout(100, -14, 9, 5, 10),
        blowout(104, 26, 7, 4, -15),
        blowout(230, 44, 8, 5, 20),
        blowout(300, -46, 9, 5, -10),
      ],
      bunkers: [
        pot(232, -12, 2.4),
        pot(246, 11, 2.2),
        pot(270, 16, 2.0),
        potG(G2, 200, 3.5, 2.4),
        potG(G2, 320, 3.5, 2.2),
        potG(G2, 20, 4, 2.0),
      ],
      mounds: [
        // The ridge across the hole.
        ...dunes(201, [[122, -78], [114, -50], [108, -18], [112, 20], [119, 52], [126, 80]], 22, 3.8, 14),
        ...rumples(202, 175, L2 - 40, 18, 12),
        ...sandhills(203, 150, L2 + 30, -54, 54, 22, 4.5),
      ],
      objects: [
        gorse(30, -30, 5, 6),
        gorse(24, 32, 4, 6),
        gorse(118, -78, 8, 10),
        gorse(124, 80, 8, 10),
        gorse(200, -66, 6, 9),
        gorse(260, 70, 7, 9),
        gorse(330, -68, 6, 9),
        gorse(L2 + 60, 10, 8, 12),
        GRASS,
      ],
      forest: false,
      ob: { left: null, right: null },
      bounds: { margin: 85 },
    },

    // 3. Postage. A short par 3 from a high dune tee to a long, narrow green on a shelf in the
    //    sandhills: a big dune on the left with the Coffin (a long pot) under it, two pots right,
    //    one front and one back; fescue all the way to a short apron.
    {
      n: 3, par: 3, name: 'Postage', si: 8,
      path: P3,
      elev: [[0, 6.0], [40, 4.5], [95, 1.8], [L3, 3.2]],
      corridor: { w: 36, h: 8 },
      undulate: 0.9,
      tee: { s: 0, w: 9, l: 10, raise: 0.8 },
      fairway: { from: L3 - 46, to: L3 - 14, width: [[L3 - 46, 16], [L3 - 14, 18]], wobble: 1.5 },
      outside: 'fescue',
      rough: { ...ROUGH, w: 7 },
      green: {
        ...G3, fringe: 1.5, raise: 0.9, slope: [270, 1.6],
        tiers: [{ angle: 90, at: -1, h: 0.17, w: 4 }],
        pins: [[0, -9], [-2, 6], [1.5, 12]],
      },
      areas: [
        surrounds(G3, 7),
        blowout(125, -33, 7, 4, 10),
        blowout(60, 34, 6, 3.5, -10),
      ],
      bunkers: [
        potG(G3, 180, 3.5, 2.2, { shape: [[0, 0, 2.4, 5.5, 0]] }),
        potG(G3, 215, 3.5, 2.2),
        potG(G3, 10, 3.5, 2.3),
        potG(G3, 330, 3.5, 2.0),
        potG(G3, 270, 4, 2.2),
        potG(G3, 95, 4.5, 2.0),
      ],
      mounds: [
        ...dunes(301, [[50, -40], [100, -42], [140, -44], [185, -38]], 16, 3.6),
        ...dunes(302, [[20, 38], [90, 42], [160, 46]], 15, 2.6),
      ],
      objects: [
        gorse(26, 30, 4, 6),
        gorse(70, -52, 7, 9),
        gorse(30, 46, 6, 8),
        gorse(-22, -26, 6, 7),
        gorse(L3 + 55, -24, 6, 8),
        GRASS,
      ],
      forest: false,
      ob: { left: null, right: null },
      bounds: { margin: 85 },
    },

    // 4. Hell. The long par 5: the Beardies (a nest of pots) left of the driving zone and the old
    //    wall (out of bounds, a hedge of gorse beyond it) all the way down the right; Hell bunker in
    //    the middle of the fairway where a lay-up lands; a huge green on a plateau behind a steep
    //    false front.
    {
      n: 4, par: 5, name: 'Hell', si: 4,
      path: P4,
      corners: [287],
      elev: [[0, 2.0], [150, 1.2], [300, 1.8], [400, 1.4], [L4, 3.0]],
      corridor: { w: 50, h: 6 },
      undulate: 1.1,
      tee: { s: 0, w: 9, l: 12, raise: 1.0 },
      // The Elysian Fields: the fairway opens out beyond the Beardies, then pinches in at Hell.
      fairway: { from: 110, to: L4 - 16, width: [[110, 32], [200, 44], [270, 54], [330, 50], [372, 36], [420, 40], [L4 - 16, 28]], wobble: 3 },
      outside: 'fescue',
      rough: ROUGH,
      green: {
        ...G4, fringe: 1.5, raise: 1.8, slope: [265, 1.6],
        tiers: [{ angle: 90, at: -9, h: 0.16, w: 4 }],
        bumps: [[10, 5, 4, 0.1], [-11, 4, 5, 0.1]],
        pins: [[-5, 6], [9, -3], [3, 9]],
      },
      areas: [
        surrounds(G4, 10),
        hummock(150, 8, 8, 4.5, 0),
        blowout(170, -50, 8, 4.5, 15),
        blowout(330, -54, 9, 5, -10),
      ],
      bunkers: [
        // The Beardies.
        pot(212, -15, 2.0),
        pot(220, -22, 2.2),
        pot(231, -27, 1.9),
        pot(240, -18, 1.8),
        // Hell.
        pot(372, -4, 6, { shape: [[0, 0, 6.5, 4.5, 10], [3, 2.5, 4, 3.5, 0]], depth: 1.8 }),
        pot(428, 13, 2.0),
        potG(G4, 200, 4, 2.6),
        potG(G4, 300, 4, 2.2),
      ],
      mounds: [
        ...rumples(401, 120, L4 - 40, 20, 14),
        ...sandhills(402, -20, L4 + 20, -58, null, 22, 4.5),
      ],
      objects: [
        gorse(30, -32, 5, 6),
        gorseRow(10, L4 - 40, 54, 5),
        gorse(80, -66, 6, 9),
        gorse(250, -72, 8, 10),
        gorse(400, -68, 7, 9),
        GRASS,
      ],
      forest: false,
      ob: { left: null, right: 48 },
      bounds: { margin: 85 },
    },

    // 5. Burnside. A wide-open drive over flat, rumpled ground; the burn (red) crosses just in front
    //    of a green that slopes back toward it, so the pitch must carry it and stop.
    {
      n: 5, par: 4, name: 'Burnside', si: 7,
      path: P5,
      elev: [[0, 1.6], [L5, 1.6]],
      corridor: { w: 64, h: 4 },
      undulate: 0.9,
      tee: { s: 0, w: 9, l: 12, raise: 0.8 },
      fairway: { from: 40, to: L5 - 16, width: [[40, 40], [150, 56], [250, 58], [L5 - 16, 46]], wobble: 3 },
      outside: 'fescue',
      rough: ROUGH,
      green: {
        ...G5, fringe: 1.5, raise: 0.4, slope: [270, 1.5],
        tiers: [{ angle: 0, at: 3, h: 0.2, w: 6 }],
        bumps: [[-11, -5, 5, 0.12]],
        pins: [[-6, 5], [10, -3], [11, 4]],
      },
      water: [{ kind: 'red', level: -1.2, bank: 4.5, depth: 1.0, poly: burn5() }],
      areas: [
        surrounds(G5, 8),
        blowout(120, -64, 7, 4, 0),
        blowout(230, 66, 8, 4.5, 15),
      ],
      bunkers: [
        pot(218, -17, 2.3),
        pot(236, 16, 2.4),
        pot(252, 25, 2.0),
        potG(G5, 95, 4, 2.2),
        potG(G5, 185, 4, 2.3),
      ],
      mounds: [
        ...rumples(501, 60, L5 - 45, 24, 14),
        ...sandhills(502, 0, L5 - 70, -70, 70, 20, 3.0),
      ],
      objects: [
        gorse(60, -76, 7, 9),
        gorse(170, 78, 7, 9),
        gorse(260, -80, 6, 8),
        gorse(L5 + 58, 20, 7, 9),
        GRASS,
      ],
      forest: false,
      ob: { left: null, right: null },
      bounds: { margin: 80 },
    },

    // 6. Whins. The hardest hole: a long dogleg right between high, gorse-crested dunes, pots in the
    //    elbow (and one beyond it on the left), to a green in a dell ringed by sandhills.
    {
      n: 6, par: 4, name: 'Whins', si: 1,
      path: P6,
      corners: [290],
      elev: [[0, 5.5], [60, 3.5], [200, 2.0], [300, 2.8], [L6, 4.2]],
      corridor: { w: 42, h: 8 },
      undulate: 1.1,
      tee: { s: 0, w: 9, l: 12, raise: 1.0 },
      fairway: { from: 130, to: L6 - 15, width: [[130, 34], [230, 40], [300, 34], [L6 - 15, 26]], wobble: 3 },
      outside: 'fescue',
      rough: ROUGH,
      green: {
        ...G6, fringe: 1.5, slope: [250, 1.4],
        tiers: [{ angle: 60, at: 2, h: 0.25, w: 6 }],
        bumps: [[-9, -5, 4, 0.1]],
        pins: [[1, -9], [6, 9], [-1, 12]],
      },
      areas: [
        surrounds(G6, 8),
        blowout(150, -44, 8, 4.5, 10),
        blowout(205, 46, 7, 4, -15),
        blowout(80, 44, 6, 3.5, 0),
      ],
      bunkers: [
        pot(250, 17, 2.4),
        pot(268, 22, 2.2),
        pot(240, -20, 2.3),
        pot(345, -12, 2.0),
        potG(G6, 190, 3.5, 2.4),
        potG(G6, 330, 4, 2.2),
      ],
      mounds: [
        ...rumples(601, 140, L6 - 40, 18, 12),
        ...greenDunes(L6, 602, [[-40, -14], [-42, 14], [-18, 42], [16, 42], [40, 16]], 16, 3.0),
        ...sandhills(603, 0, 330, -52, 52, 22, 4.0),
      ],
      objects: [
        gorse(28, 30, 5, 6),
        gorse(60, -62, 7, 9),
        gorse(115, -60, 6, 8),
        gorse(175, -66, 7, 9),
        gorse(235, -62, 6, 8),
        gorse(60, 60, 6, 8),
        gorse(130, 64, 7, 9),
        gorse(300, 64, 9, 11),
        gorse(L6 + 58, -10, 7, 9),
        GRASS,
      ],
      forest: false,
      ob: { left: null, right: null },
      bounds: { margin: 80 },
    },

    // 7. Haar. A long par 3 toward the sea. The entrance between two pots is open and firm: the
    //    running shot is the play, since the green falls away at the back into a hollow.
    {
      n: 7, par: 3, name: 'Haar', si: 9,
      path: P7,
      elev: [[0, 3.5], [80, 1.5], [L7, 1.8]],
      corridor: { w: 42, h: 6 },
      undulate: 0.9,
      tee: { s: 0, w: 9, l: 10, raise: 1.0 },
      fairway: { from: 80, to: L7 - 16, width: [[80, 22], [140, 30], [L7 - 16, 26]], wobble: 2 },
      outside: 'fescue',
      rough: ROUGH,
      green: {
        ...G7, fringe: 1.5, raise: 0.3, slope: [90, 1.5],
        bumps: [[-8, -8, 6, 0.15], [8, 9, 5, -0.12]],
        pins: [[-6, 4], [6, -5], [-2, 11]],
      },
      areas: [
        surrounds(G7, 9),
        { surface: 'fairway', g: [0, 27], shape: [[0, 0, 13, 7, 0]], dz: -2, ease: 6 },
        blowout(60, -42, 7, 4, 10),
        blowout(130, 44, 7, 4, -10),
      ],
      bunkers: [
        potG(G7, 230, 3, 2.5),
        potG(G7, 310, 3.5, 2.3),
        pot(L7 - 48, -12, 2.0),
        pot(L7 - 56, 13, 2.0),
      ],
      mounds: [
        ...rumples(701, 85, L7 - 30, 12, 8),
        ...sandhills(702, -20, L7, -48, 48, 18, 3.5),
      ],
      objects: [
        gorse(26, -28, 4, 6),
        gorse(20, -56, 6, 8),
        gorse(100, -58, 7, 9),
        gorse(40, 56, 6, 8),
        gorse(150, 58, 6, 8),
        GRASS,
      ],
      forest: false,
      ob: { left: null, right: null },
      bounds: { margin: 80 },
    },

    // 8. Strand. Along the shore again, the sea on the right: the beach cuts in at the second-shot
    //    landing zone, a line of cross pots asks for a decision, and the green sits by the beach with
    //    a run-off toward it. The sandhills rise on the left.
    {
      n: 8, par: 5, name: 'Strand', si: 5,
      path: P8,
      corners: [331],
      elev: E8,
      corridor: { w: 46, h: 3 },
      undulate: 1.0,
      tee: { s: 0, w: 9, l: 12, raise: 1.0 },
      fairway: { from: 110, to: L8 - 15, width: [[110, 32], [230, 42], [330, 38], [400, 32], [L8 - 15, 26]], wobble: 3 },
      outside: 'fescue',
      rough: ROUGH,
      green: {
        ...G8, fringe: 1.5, raise: 0.6, slope: [20, 1.3],
        tiers: [{ angle: 200, at: 3, h: 0.22, w: 6 }],
        bumps: [[10, 4, 4, 0.1]],
        pins: [[7, -4], [-11, 1], [2, 9]],
      },
      water: [sea(P8, E8, B8, SHORE8, ['NW', 'NE'], -0.6)],
      areas: [
        { surface: 'waste', xy: smooth(band(SHORE8, -6, 18), 1) },
        surrounds(G8),
        blowout(120, -50, 8, 4.5, 10),
        blowout(300, -52, 9, 5, -15),
      ],
      bunkers: [
        pot(230, -15, 2.4),
        pot(248, -22, 2.2),
        pot(342, -16, 2.1),
        pot(346, -2, 2.0),
        pot(340, 11, 2.1),
        potG(G8, 180, 3.5, 2.4),
        potG(G8, 250, 4, 2.0),
      ],
      mounds: [
        ...rumples(801, 120, L8 - 40, 18, 12),
        ...sandhills(802, -20, L8 + 20, -56, null, 24, 4.5),
        ...dunes(803, [[40, 40], [120, 38], [190, 36]], 13, 1.8, 16),
      ],
      objects: [
        gorse(28, 30, 4, 6),
        gorse(60, -64, 6, 8),
        gorse(160, -70, 8, 10),
        gorse(270, -66, 6, 8),
        gorse(380, -68, 7, 9),
        GRASS,
      ],
      forest: false,
      ob: { left: null, right: null },
      bounds: { margin: 80 },
    },

    // 9. Home. A huge fairway open to the wind; out of bounds (the town) all down the right, pots
    //    down the left under the sandhills; the Valley of Sin, a deep hollow short-left of a big
    //    two-tier green, gathers the timid approach.
    {
      n: 9, par: 4, name: 'Home', si: 3,
      path: P9,
      elev: [[0, 2.2], [200, 1.6], [L9, 2.8]],
      corridor: { w: 55, h: 4 },
      undulate: 0.9,
      tee: { s: 0, w: 9, l: 12, raise: 0.8 },
      fairway: { from: 50, to: L9 - 15, width: [[50, 46], [200, 54], [300, 50], [L9 - 15, 40]], wobble: 3, shift: [[50, -4], [250, -6], [L9 - 15, -2]] },
      outside: 'fescue',
      rough: ROUGH,
      green: {
        ...G9, fringe: 1.5, raise: 0.9, slope: [255, 1.3],
        tiers: [{ angle: 90, at: 1, h: 0.25, w: 6 }],
        bumps: [[12, 9, 4, 0.1]],
        pins: [[-8, -7], [7, -8], [-6, 9]],
      },
      areas: [
        surrounds(G9, 10),
        // The Valley of Sin.
        { surface: 'fairway', g: [-4, -26], shape: [[0, 0, 11, 7, 15]], dz: -1.6, ease: 6 },
        hummock(132, 6, 9, 5, -10),
        hummock(160, -20, 6, 4, 20),
        blowout(140, -62, 8, 4.5, 10),
      ],
      bunkers: [
        pot(225, -24, 2.3),
        pot(242, -16, 2.2),
        pot(265, 18, 2.0),
        potG(G9, 340, 4, 2.2),
        potG(G9, 150, 4, 2.0),
      ],
      mounds: [
        ...rumples(901, 70, L9 - 45, 22, 13),
        ...sandhills(902, -20, L9 + 30, -66, null, 22, 4.0),
      ],
      objects: [
        gorse(60, -76, 7, 9),
        gorse(200, -80, 8, 10),
        gorse(320, -74, 6, 8),
        GRASS,
      ],
      forest: false,
      ob: { left: null, right: 45 },
      bounds: { margin: 80 },
    },
  ],
};
