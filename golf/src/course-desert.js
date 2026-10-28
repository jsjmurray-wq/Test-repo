// Red Mesa: the desert course (theme 'desert', docs/architecture.md section 8.2). Sonoran target
// golf: emerald fairway islands set in natural desert (outside: 'desert'), forced carries from tees
// perched on the hillsides, dry washes (arroyos: sunken WASTE channels lined with palo verde)
// crossing and shadowing the holes, saguaro stands and boulder outcrops on the ridges that frame
// every hole, and firm, fast turf (conditions: firm 1.25, greens 11 ft).
//
// HoleDef format: course.js and terrain.js headers. Features are placed by (s, off) along the
// centreline (off + = right looking down the hole) or green-relative g: [r, f] (r right, f away
// from the tee, from the green centre).
//
// Design notes (for a ~5 handicap: driver ~240 yd carry, and the firm fairways add some roll):
//  - Every tee shot has a safe line: the fairway island starts 135-165 m out (a carry a hybrid
//    clears from the raised tees) and is 30-35 m wide where a drive lands, with 5-6 m of rough
//    before the desert. Par 3s have a bail-out apron short right of the green.
//  - The desert floor is playable but costly (erratic bounces, the ball sits down, scrub and cactus
//    in the way); washes are WASTE (firm sand, no penalty, the club may be grounded), so a ball in a
//    wash can be played on. Only the 9th has water (a lake, red), with gentle banks for the drop.
//  - Greens run at 11 ft, so their planes stay at 1.1-1.4% with soft bumps and one gentle tier.
//  - The ridges come from `corridor` (the land rises beyond w m of the centreline, up to ~h m) and
//    large mounds topped with boulders; each tee sits on a shelf that falls away in front of it.

// ------------------------------------------------------------------ authoring helpers

const TAU = Math.PI * 2;

// Smooth, irregular wiggle in about [-1, 1]: three incommensurate sines (deterministic).
function wiggle(t, seed) {
  return 0.55 * Math.sin(t + seed) + 0.3 * Math.sin(2.31 * t + 1.7 * seed) + 0.15 * Math.sin(4.13 * t + 2.9 * seed);
}

// A dry wash crossing the hole. Its centre crosses the centreline at arc length s and runs from
// lateral offset o0 to o1, skewed by `skew` (m of s per m of offset) and meandering by `amp` over a
// wavelength `wave`; the half-width hw breathes by +-35%. Returns {poly: [[s, off], ...], at(u)}
// where at(off) gives the centre s and the half-width there (for the trees along its banks).
function crossWash({ s, o0, o1, hw, skew = 0, amp = 6, wave = 60, seed = 1, step = 6 }) {
  const at = (off) => ({
    c: s + skew * off + amp * wiggle((off / wave) * TAU, seed),
    w: hw * (1 + 0.35 * wiggle(off / 21, seed + 4)),
  });
  const a = [];
  const b = [];
  for (let off = o0; off <= o1 + 1e-6; off += step) {
    const { c, w } = at(off);
    a.push([c - w, off]);
    b.push([c + w, off]);
  }
  return { poly: a.concat(b.reverse()), at, u0: o0, u1: o1, along: false };
}

// A wash running down the side of the hole from s0 to s1, centred on lateral offset `off`.
function sideWash({ s0, s1, off, hw, amp = 6, wave = 90, seed = 1, step = 8 }) {
  const at = (s) => ({
    c: off + amp * wiggle((s / wave) * TAU, seed),
    w: hw * (1 + 0.35 * wiggle(s / 23, seed + 4)),
  });
  const a = [];
  const b = [];
  for (let s = s0; s <= s1 + 1e-6; s += step) {
    const { c, w } = at(s);
    a.push([s, c - w]);
    b.push([s, c + w]);
  }
  return { poly: a.concat(b.reverse()), at, u0: s0, u1: s1, along: true };
}

// The sunken sandy bed of a wash as an `areas` entry; wide, soft banks (ease) so its edge reads
// as a cut bank rather than a kerb.
const washArea = (w, dz = -1.3) => ({ surface: 'waste', poly: w.poly, dz, ease: 6 });

// Palo verde (drawn as broadleaves), saguaros and boulders strung along both banks of a wash: a
// small cluster every `every` metres, skipping the stretch within `clear` m of the line of play
// for crossing washes, so the fairway corridor stays open.
function washBanks(w, { every = 22, clear = 0, kind = { broad: 0.4, rock: 0.4, saguaro: 0.2 }, n = 3 } = {}) {
  const out = [];
  for (let u = w.u0 + every / 2; u <= w.u1; u += every) {
    if (!w.along && Math.abs(u) < clear) continue;
    const { c, w: hw } = w.at(u);
    for (const side of [-1, 1]) {
      const edge = c + side * (hw + 3);
      out.push(w.along ? { kind, s: u, off: edge, cluster: n, spread: 5 } : { kind, s: edge, off: u, cluster: n, spread: 5 });
    }
  }
  return out;
}

// An arc of overlapping ellipses round the green, for waste areas that hug it: from green-frame
// angle a0 to a1 (deg: 0 = right, 90 = back, 270 = front) at radius r, ellipses of half-length
// len along the arc and half-width wid across it.
function greenArc(a0, a1, r, len, wid, n = 3) {
  const out = [];
  for (let k = 0; k < n; k++) {
    const a = a0 + ((a1 - a0) * k) / Math.max(1, n - 1);
    const rad = (a * Math.PI) / 180;
    out.push([r * Math.cos(rad), r * Math.sin(rad), len * (0.85 + 0.15 * (k % 3)), wid, a + 90]);
  }
  return out;
}

// Polyline length of a path (the centreline spline is a touch longer).
function plen(path) {
  let L = 0;
  for (let i = 1; i < path.length; i++) L += Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]);
  return L;
}

// The desert floor. Near the line of play: stones, boulders and dry bunch grass (visual only), with
// saguaros standing over them; the creosote and bursage scrub starts `shrubFrom` m out. Shrubs are
// kept back from play on purpose: physics drops a ball that rolls into one dead inside it, and a
// ball at rest inside a bush is caught again by most shots played from there (the bush's canopy
// is rolled again at the strike), so they stay out of the forced carries, washes and the first
// band of desert beyond the rough.
//  - Saguaro rows keep clear of the line of play: |off| >= `inner` (18 m) with 5 m of jitter in
//    front of the tee (the forced carry, up to `carry` - 12 m, where the first fairway or a par 3's
//    green surround begins), so none stands in a tee shot or the view from the tee; saguaro rows
//    at 33 and 44 m run the full length beyond the rough.
//  - Scrub rows (creosote with saguaros) from `shrubFrom` (55 m) out, every `step` m.
function desertLife(path, carry, { inner = 18, outer = 88, step = 11, gap = 20, shrubFrom = 55 } = {}) {
  const L = plen(path);
  const out = [{ kind: { rock: 0.35, grass: 0.65 }, area: 'desert', density: 0.4 }];
  const row = (kind, off, to, g = gap) => {
    for (const side of [-1, 1]) out.push({ kind, from: -50, to, off: side * off, gap: g, jitter: 5 });
  };
  for (let off = inner; off < 33; off += step) row({ saguaro: 0.75, rock: 0.25 }, off, carry - 12);
  row('saguaro', 33, L + 60, 26);
  row({ saguaro: 0.6, rock: 0.4 }, 44, L + 60, 24);
  for (let off = shrubFrom; off <= outer; off += step) row({ shrub: 0.65, saguaro: 0.35 }, off, L + 60);
  return out;
}

// A boulder outcrop on a hill: rocks piled round `at` (pair it with a mound) and a stand of
// saguaros on its flanks.
function outcrop(at, n, spread, saguaros = Math.max(2, Math.round(n / 5))) {
  return [
    { kind: 'rock', ...at, cluster: n, spread },
    { kind: { saguaro: 0.75, rock: 0.25 }, ...at, cluster: saguaros, spread: spread * 1.5 },
  ];
}

// A greenside bunker on the ray at green-frame angle a (deg: 0 = right, 90 = back, 270 = front),
// curled round the green (len m along the edge, wid m across), its near edge `gap` m outside the
// green's edge: at least fringe + 2 m, so its lip and bowl never tilt the putting surface.
function greenBunker(green, { a, len = 6, wid = 3.4, gap = 3.6, depth = 0.85 }) {
  const rad = (a * Math.PI) / 180;
  const phi = ((a - (green.rot || 0)) * Math.PI) / 180;
  const edge = 1 / Math.hypot(Math.cos(phi) / green.rx, Math.sin(phi) / green.ry);
  const d = edge + gap + wid;
  return { g: [d * Math.cos(rad), d * Math.sin(rad)], shape: [[0, 0, len, wid, a + 90]], depth };
}

// Turns a hole's `greenside` bunker specs into ordinary bunkers (the HoleDef terrain.js reads).
function finish(def) {
  const { greenside = [], ...rest } = def;
  return { ...rest, bunkers: [...(def.bunkers || []), ...greenside.map((b) => greenBunker(def.green, b))] };
}

// ------------------------------------------------------------------ centrelines, washes and water

// Centrelines (tee first, green centre last), shared by the holes and their saguaro rows.
const PATHS = [
  [[0, 0], [3, 125], [12, 230], [36, 300], [55, 342]], // 1 Trailhead
  [[0, 0], [-8, 80], [-12, 152]], // 2 Canyon
  [[0, 0], [-6, 165], [18, 310], [46, 405], [44, 478]], // 3 Long Arroyo
  [[0, 0], [2, 165], [-30, 262], [-95, 330], [-135, 352]], // 4 Sidewinder
  [[0, 0], [12, 120], [18, 195], [34, 255]], // 5 Coyote
  [[0, 0], [24, 86], [45, 172]], // 6 Sundial
  [[0, 0], [-55, 135], [-88, 250], [-100, 360]], // 7 Red Rock
  [[0, 0], [10, 190], [-20, 330], [-50, 410], [-55, 462]], // 8 Sidewash
  [[0, 0], [-5, 150], [15, 250], [60, 320], [85, 352]], // 9 Oasis
];

const W1 = crossWash({ s: 290, o0: -100, o1: 100, hw: 9, skew: 0.12, amp: 7, wave: 80, seed: 1 });
const W2 = crossWash({ s: 76, o0: -100, o1: 100, hw: 12, skew: -0.05, amp: 5, wave: 70, seed: 2 });
const W3 = crossWash({ s: 298, o0: -100, o1: 100, hw: 11, skew: 0.16, amp: 8, wave: 75, seed: 3 });
const W5 = crossWash({ s: 221, o0: -70, o1: 80, hw: 6, skew: -0.08, amp: 3, wave: 55, seed: 5 });
const W7 = sideWash({ s0: 30, s1: 350, off: -44, hw: 7, amp: 6, wave: 120, seed: 7 });
const W8a = sideWash({ s0: 100, s1: 402, off: -45, hw: 7, amp: 6, wave: 110, seed: 8 });
const W8b = crossWash({ s: 420, o0: -95, o1: 80, hw: 7, skew: -0.1, amp: 4, wave: 60, seed: 9 });

// A rounded, slightly irregular blob [[s, off], ...]: an ellipse of semi-axes rs (along the hole)
// and ro (across) round (cs, co), its radius wobbling by `wob` (fraction). minOff keeps it clear
// of the fairway on the left.
function blob(cs, co, rs, ro, { wob = 0.12, seed = 1, n = 16, minOff = -Infinity } = {}) {
  const pts = [];
  for (let k = 0; k < n; k++) {
    const a = (k / n) * TAU;
    const f = 1 + wob * wiggle(a * 2, seed);
    pts.push([cs + rs * f * Math.cos(a), Math.max(minOff, co + ro * f * Math.sin(a))]);
  }
  return pts;
}

// The 9th's lake and the pond that spills into it over a rock ledge, and a collar of grass round
// both (the oasis), clear of the fairway.
const LAKE = blob(333, 31, 36, 14, { seed: 3 });
const POND = blob(352, 53, 9, 5, { seed: 6, n: 12 });
const OASIS = [blob(333, 33, 44, 22, { seed: 3, minOff: 14 }), blob(352, 54, 17, 11, { seed: 6, n: 12 })];

// ------------------------------------------------------------------ the course

export const DESERT = {
  id: 'desert',
  name: 'Red Mesa',
  tagline: 'Target golf through the high desert',
  theme: 'desert',
  conditions: { firm: 1.25, greenStimpFt: 11, wind: 'normal' },
  holes: [
    // 1. Downhill opener from a tee perched 14 m above the valley floor: a 150 m carry to a wide
    //    fairway island bending gently right; a dry wash crosses 50 m short of the green.
    {
      n: 1, par: 4, name: 'Trailhead', si: 5,
      path: PATHS[0],
      elev: [[0, 14], [16, 13.7], [48, 6.5], [120, 2.5], [190, 0], [300, 0.8], [350, 2]],
      corridor: { w: 38, h: 30 },
      undulate: 0.8,
      tee: { s: 0, w: 9, l: 14, raise: 0.5 },
      fairway: {
        from: 152, to: 338,
        width: [[152, 26], [172, 32], [195, 30], [218, 35], [242, 30], [265, 27], [284, 25], [300, 24], [320, 23], [338, 22]],
        shift: [[152, -3], [185, 2], [215, 5], [245, 1], [275, -2], [300, 0]],
        wobble: 2.5,
      },
      rough: { w: 5, tee: 3, green: 5 },
      outside: 'desert',
      green: {
        rx: 12, ry: 14, rot: 8, fringe: 1.2, slope: [255, 1.3],
        bumps: [[5, 6, 5, 0.07]],
        pins: [[-4, 6], [4, -6], [1, 0]],
      },
      bunkers: [
        { s: 228, off: -22, shape: [[0, 0, 5.5, 9, -8], [-2, 7, 3, 3.5, 0]], depth: 0.75 },
      ],
      greenside: [{ a: 220, len: 5, wid: 3.4 }, { a: 10, len: 7.5, wid: 3.4 }],
      areas: [washArea(W1, -1.4)],
      mounds: [[110, -66, 40, 12], [245, 68, 42, 16], [340, -62, 34, 9]],
      objects: [
        ...desertLife(PATHS[0], 152),
        ...washBanks(W1, { clear: 30 }),
        ...outcrop({ s: 245, off: 68 }, 30, 14),
        ...outcrop({ s: 110, off: -66 }, 18, 11),
      ],
      forest: false,
      ob: { left: null, right: null },
      bounds: { margin: 66 },
    },

    // 2. Par 3 across a canyon: the tee stands on the rim of an arroyo 20 m below it, the green
    //    on the far rim. All carry (about 120 m to the far rim); the bail-out is the apron short
    //    right of the green.
    {
      n: 2, par: 3, name: 'Canyon', si: 8,
      path: PATHS[1],
      elev: [[0, 12], [12, 11.8], [24, 9], [46, -4], [60, -8], [90, -8.5], [104, -4], [116, 1.5], [128, 4.5], [152, 5]],
      corridor: { w: 38, h: 26 },
      undulate: 0.6,
      tee: { s: 0, w: 10, l: 12, raise: 0.5 },
      fairway: { from: 112, to: 146, width: [[112, 10], [124, 17], [136, 18], [146, 12]], shift: [[112, 13], [130, 15], [146, 18]], wobble: 1.2 },
      rough: { w: 5, tee: 3, green: 5 },
      outside: 'desert',
      green: {
        rx: 13, ry: 12.5, rot: 10, fringe: 1.2, slope: [250, 1.3],
        bumps: [[-6, -5, 3.5, 0.05]],
        pins: [[-4, 3], [4, -3], [1, 5]],
      },
      greenside: [{ a: 195, len: 7, wid: 3.6 }, { a: 42, len: 6, wid: 3.2, depth: 0.8 }],
      areas: [washArea(W2, -0.5)],
      objects: [
        ...desertLife(PATHS[1], 112),
        ...washBanks(W2, { every: 18, clear: 14, kind: { rock: 0.7, saguaro: 0.3 } }),
        // Boulders tumbled down both canyon walls.
        ...[-62, -40, -18, 18, 40, 62].flatMap((off) => [
          { kind: { rock: 0.75, saguaro: 0.25 }, s: 38, off, cluster: 6, spread: 6 },
          { kind: { rock: 0.75, saguaro: 0.25 }, s: 108, off: off + Math.sign(off) * 4, cluster: 6, spread: 6 },
        ]),
        { kind: 'rock', s: 108, off: 0, cluster: 5, spread: 6 },
        ...outcrop({ g: [-36, 22] }, 18, 10),
      ],
      forest: false,
      ob: { left: null, right: null },
      bounds: { margin: 70 },
    },

    // 3. Uphill three-shotter through an open valley: two fairway islands either side of a broad
    //    arroyo at 290-320 m. The lay-up carries the wash or stays short of it; hardpan right of
    //    the second fairway.
    {
      n: 3, par: 5, name: 'Long Arroyo', si: 3,
      path: PATHS[2],
      elev: [[0, 9], [15, 8.8], [45, 5], [150, 1.5], [262, 2], [298, -0.5], [330, 2.5], [380, 5], [478, 8.5]],
      corridor: { w: 46, h: 20 },
      undulate: 0.8,
      tee: { s: 0, w: 9, l: 15, raise: 0.5 },
      fairway: [
        {
          from: 158, to: 278, wobble: 2.5,
          width: [[158, 26], [180, 32], [205, 29], [228, 34], [255, 30], [278, 26]],
          shift: [[158, 3], [200, -2], [240, -4], [278, -1]],
        },
        {
          from: 318, to: 466, wobble: 2.2,
          width: [[318, 24], [345, 30], [370, 27], [395, 29], [425, 25], [450, 23], [466, 22]],
          shift: [[318, -4], [360, -1], [400, 2], [466, 0]],
        },
      ],
      rough: { w: 5, tee: 3, green: 5 },
      outside: 'desert',
      green: {
        rx: 12, ry: 15.5, rot: -6, fringe: 1.2, slope: [265, 1.1],
        tiers: [{ angle: 90, at: 0.5, h: 0.25, w: 5.5 }],
        bumps: [[6, -9, 4, 0.06]],
        pins: [[3, -8], [-3, 9], [-5, -6]],
      },
      bunkers: [
        { s: 245, off: -21, shape: [[0, 0, 5, 9, -5]], depth: 0.75 },
        { s: 402, off: 20, shape: [[0, 0, 4.5, 8, 6], [-1, 8, 3, 3, 0]], depth: 0.75 },
      ],
      greenside: [{ a: 207, len: 7, wid: 3.6, depth: 0.9 }, { a: 30, len: 6.5, wid: 3.6 }],
      areas: [
        washArea(W3, -1.6),
        { surface: 'waste', s: 372, off: 32, shape: [[0, 0, 7, 22, 4], [3, 24, 6, 12, -10], [-2, -20, 5, 9, 15]], dz: -0.2 },
      ],
      mounds: [[200, -72, 40, 16], [430, -64, 34, 12], [60, 56, 28, 6], [330, 70, 30, 9]],
      objects: [
        ...desertLife(PATHS[2], 158),
        ...washBanks(W3, { clear: 30 }),
        ...outcrop({ s: 200, off: -72 }, 30, 16, 9),
        ...outcrop({ s: 430, off: -64 }, 26, 13),
        ...outcrop({ s: 330, off: 70 }, 14, 10),
      ],
      forest: false,
      ob: { left: null, right: null },
      bounds: { margin: 66 },
    },

    // 4. The longest par 4: a dogleg left round a boulder-strewn hill. The bold line over the
    //    hill's shoulder shortens it; hardpan through the corner catches the overhit drive.
    {
      n: 4, par: 4, name: 'Sidewinder', si: 2,
      path: PATHS[3],
      corners: [235],
      elev: [[0, 12], [16, 11.7], [45, 6], [140, 2], [230, 1], [330, 3], [410, 4]],
      corridor: { w: 44, h: 22 },
      undulate: 0.8,
      tee: { s: 0, w: 9, l: 15, raise: 0.5 },
      fairway: {
        from: 160, to: 396, wobble: 2.5,
        width: [[160, 28], [185, 32], [212, 30], [240, 34], [268, 30], [300, 27], [330, 28], [360, 24], [396, 22]],
        shift: [[160, 2], [210, 4], [250, 2], [300, -2], [396, 0]],
      },
      rough: { w: 5, tee: 3, green: 5 },
      outside: 'desert',
      green: {
        rx: 11.5, ry: 14, rot: 20, fringe: 1.2, slope: [250, 1.2],
        bumps: [[-5, 7, 4, 0.06]],
        pins: [[3, 6], [-3, -6], [0, 0]],
      },
      bunkers: [
        { s: 258, off: 23, shape: [[0, 0, 5, 9, 10]], depth: 0.75 },
      ],
      greenside: [{ a: 167, len: 8, wid: 3.6, depth: 0.9 }, { a: 302, len: 5.5, wid: 3.2 }],
      areas: [{ surface: 'waste', s: 266, off: 38, shape: [[0, 0, 9, 24, -12], [6, -24, 7, 10, 20], [-3, 22, 6, 9, -30]], dz: -0.25 }],
      mounds: [[245, -64, 36, 14], [200, -44, 14, 3], [120, 62, 28, 6]],
      objects: [
        ...desertLife(PATHS[3], 160, { inner: 22 }),
        ...outcrop({ s: 245, off: -64 }, 46, 20, 12),
        ...outcrop({ s: 200, off: -44 }, 10, 7),
        { kind: { broad: 0.6, rock: 0.4 }, g: [-30, 25], cluster: 5, spread: 12 },
      ],
      forest: false,
      ob: { left: null, right: null },
      bounds: { margin: 66 },
    },

    // 5. Drivable par 4 falling 18 m from the tee. The safe play lays up on the shelf short of a
    //    small wash; the driver flies the wash to a narrow green guarded by waste right and sand
    //    left. Come up short and the ball sits on the wash's firm sand.
    {
      n: 5, par: 4, name: 'Coyote', si: 9,
      path: PATHS[4],
      corners: [190],
      elev: [[0, 18], [14, 17.7], [40, 11], [125, 5], [195, 1], [258, 0]],
      corridor: { w: 42, h: 24 },
      undulate: 0.7,
      tee: { s: 0, w: 9, l: 14, raise: 0.5 },
      fairway: [
        { from: 135, to: 212, width: [[135, 26], [152, 33], [172, 30], [192, 32], [212, 26]], shift: [[135, -2], [165, 1], [190, -1], [212, 0]], wobble: 2.2 },
        { from: 230, to: 244, width: [[230, 16], [244, 18]], wobble: 1 },
      ],
      rough: { w: 6, tee: 3, green: 6 },
      outside: 'desert',
      green: {
        rx: 11, ry: 14.5, rot: 0, fringe: 1.2, slope: [250, 1.3],
        bumps: [[4, 6, 4, 0.06]],
        pins: [[-3, 6], [3, -5], [0, 1]],
      },
      greenside: [{ a: 207, len: 6, wid: 3.4, depth: 0.9 }, { a: 108, len: 6, wid: 3, depth: 0.8 }],
      areas: [
        washArea(W5, -1.1),
        { surface: 'waste', g: [0, 0], shape: greenArc(-40, 20, 21, 9, 5.5, 3), dz: -0.4 },
      ],
      mounds: [[90, -58, 30, 9], [300, 30, 34, 10]],
      objects: [
        ...desertLife(PATHS[4], 135),
        ...washBanks(W5, { every: 20, clear: 22 }),
        ...outcrop({ g: [-36, 18] }, 16, 10),
        ...outcrop({ s: 90, off: -58 }, 18, 12),
      ],
      forest: false,
      ob: { left: null, right: null },
      bounds: { margin: 70 },
    },

    // 6. Long downhill par 3 to a green wrapped by a sandy waste area front and left, a boulder
    //    ridge behind it. Short right is the bail-out.
    {
      n: 6, par: 3, name: 'Sundial', si: 7,
      path: PATHS[5],
      elev: [[0, 13], [14, 12.7], [40, 8], [120, 2], [172, 0.5]],
      corridor: { w: 40, h: 24 },
      undulate: 0.7,
      tee: { s: 0, w: 10, l: 12, raise: 0.5 },
      fairway: { from: 118, to: 160, width: [[118, 10], [132, 17], [148, 19], [160, 12]], shift: [[118, 12], [140, 16], [160, 19]], wobble: 1.2 },
      rough: { w: 5, tee: 3, green: 5 },
      outside: 'desert',
      green: {
        rx: 13, ry: 12.5, rot: -12, fringe: 1.2, slope: [240, 1.3],
        bumps: [[6, -4, 4, 0.06]],
        pins: [[-5, 3], [5, -2], [0, 5]],
      },
      greenside: [{ a: 12, len: 7, wid: 3.4 }, { a: 102, len: 7, wid: 3.2, depth: 0.8 }],
      areas: [{ surface: 'waste', g: [0, 0], shape: greenArc(150, 275, 22, 10, 6.5, 4), dz: -0.4 }],
      mounds: [[232, 2, 30, 9], [60, 52, 26, 6]],
      objects: [
        ...desertLife(PATHS[5], 118),
        ...outcrop({ s: 232, off: 2 }, 34, 16, 8),
        ...outcrop({ s: 60, off: 52 }, 12, 9),
      ],
      forest: false,
      ob: { left: null, right: null },
      bounds: { margin: 70 },
    },

    // 7. The hardest hole: uphill through a narrow valley with a wash shadowing the whole left
    //    side; bunkers pinch the fairway at 255 m and a red-rock outcrop stands right of the
    //    raised green.
    {
      n: 7, par: 4, name: 'Red Rock', si: 1,
      path: PATHS[6],
      corners: [235],
      elev: [[0, 2], [100, 1], [220, 4], [300, 8], [376, 11]],
      corridor: { w: 36, h: 30 },
      undulate: 0.8,
      tee: { s: 0, w: 9, l: 15, raise: 0.6 },
      fairway: {
        from: 150, to: 362, wobble: 2.2,
        width: [[150, 26], [175, 31], [205, 28], [228, 32], [255, 24], [280, 25], [310, 24], [335, 23], [362, 20]],
        shift: [[150, 3], [200, 1], [255, 0], [300, 2], [362, 0]],
      },
      rough: { w: 5, tee: 3, green: 5 },
      outside: 'desert',
      green: {
        rx: 12, ry: 13.5, rot: 5, fringe: 1.2, raise: 0.3, slope: [270, 1.4],
        bumps: [[-5, 6, 4, 0.06]],
        pins: [[4, 5], [-4, -5], [0, 1]],
      },
      bunkers: [
        { s: 255, off: -18, shape: [[0, 0, 4.5, 8, 0]], depth: 0.75 },
        { s: 262, off: 18, shape: [[0, 0, 4, 7, 0]], depth: 0.75 },
      ],
      greenside: [{ a: 190, len: 7.5, wid: 3.6, depth: 0.9 }],
      areas: [washArea(W7, -1.3)],
      mounds: [[374, 40, 22, 9], [150, 60, 28, 8]],
      objects: [
        ...desertLife(PATHS[6], 150, { shrubFrom: 66 }),
        ...washBanks(W7, { every: 24 }),
        ...outcrop({ s: 374, off: 40 }, 42, 15, 6),
        ...outcrop({ s: 150, off: 60 }, 18, 11),
      ],
      forest: false,
      ob: { left: null, right: null },
      bounds: { margin: 66 },
    },

    // 8. Reachable downhill par 5. A wash runs down the left and cuts across 40 m short of the
    //    green, so the second shot must carry it to go for the green or lay up on the shelf.
    {
      n: 8, par: 5, name: 'Sidewash', si: 6,
      path: PATHS[7],
      elev: [[0, 12], [16, 11.7], [50, 7], [200, 2], [350, -1], [471, -2]],
      corridor: { w: 44, h: 22 },
      undulate: 0.8,
      tee: { s: 0, w: 9, l: 15, raise: 0.5 },
      fairway: [
        {
          from: 165, to: 405, wobble: 2.5,
          width: [[165, 28], [190, 32], [220, 30], [255, 34], [290, 29], [330, 28], [365, 30], [405, 26]],
          shift: [[165, 3], [220, 0], [260, 3], [330, 0], [405, 2]],
        },
        { from: 433, to: 462, width: [[433, 22], [462, 22]], wobble: 1.5 },
      ],
      rough: { w: 5, tee: 3, green: 5 },
      outside: 'desert',
      green: {
        rx: 11.5, ry: 14.5, rot: -15, fringe: 1.2, slope: [245, 1.2],
        bumps: [[5, -7, 5, 0.06]],
        pins: [[3, 5], [-4, -5], [1, 0]],
      },
      bunkers: [
        { s: 270, off: 23, shape: [[0, 0, 5, 9, 0]], depth: 0.75 },
      ],
      greenside: [{ a: 345, len: 7.5, wid: 3.4, depth: 0.9 }, { a: 128, len: 5.5, wid: 3, depth: 0.8 }, { a: 295, len: 5, wid: 3, depth: 0.8 }],
      areas: [washArea(W8a, -1.3), washArea(W8b, -1.3)],
      mounds: [[300, 66, 34, 12], [120, 60, 26, 6], [200, -78, 34, 10]],
      objects: [
        ...desertLife(PATHS[7], 165, { shrubFrom: 66 }),
        ...washBanks(W8a, { every: 26 }),
        ...washBanks(W8b, { every: 20, clear: 16 }),
        ...outcrop({ s: 300, off: 66 }, 26, 13),
        ...outcrop({ s: 200, off: -78 }, 16, 11),
      ],
      forest: false,
      ob: { left: null, right: null },
      bounds: { margin: 66 },
    },

    // 9. Home through the oasis: a dogleg right round a lake (red) that guards the front right of
    //    the green, fed by a pond spilling over a rock ledge above it. Palms and palo verde shade
    //    the water's grassy banks.
    {
      n: 9, par: 4, name: 'Oasis', si: 4,
      path: PATHS[8],
      corners: [255],
      elev: [[0, 7], [16, 6.8], [45, 4], [100, 3], [230, 0], [365, -0.5]],
      corridor: { w: 42, h: 24 },
      undulate: 0.7,
      tee: { s: 0, w: 9, l: 15, raise: 0.5 },
      fairway: {
        from: 150, to: 366, wobble: 2.2,
        width: [[150, 26], [175, 31], [200, 29], [225, 34], [255, 30], [285, 28], [315, 26], [345, 23], [366, 20]],
        shift: [[150, -2], [200, 2], [240, -1], [290, -3], [352, 0]],
      },
      rough: { w: 6, tee: 3, green: 6 },
      outside: 'desert',
      green: {
        rx: 12, ry: 13.5, rot: -10, fringe: 1.2, slope: [200, 1.2],
        bumps: [[-5, 6, 4, 0.06]],
        pins: [[4, 5], [-4, -4], [-2, 4]],
      },
      water: [
        { kind: 'red', level: -1.1, bank: 6, depth: 1.6, poly: LAKE },
        { kind: 'red', level: 2.05, bank: 4, depth: 0.8, poly: POND },
      ],
      bunkers: [
        { s: 240, off: -22, shape: [[0, 0, 5, 9, 0]], depth: 0.75 },
      ],
      greenside: [{ a: 190, len: 7.5, wid: 3.6, depth: 0.9 }, { a: 85, len: 6.5, wid: 3, depth: 0.8 }],
      areas: OASIS.map((poly) => ({ surface: 'rough', poly })),
      mounds: [[366, 68, 18, 4], [120, -64, 32, 10], [230, 70, 30, 8]],
      objects: [
        ...desertLife(PATHS[8], 150, { inner: 26 }),
        { kind: { palm: 0.65, broad: 0.35 }, s: 335, off: 58, cluster: 8, spread: 16 },
        { kind: 'palm', s: 296, off: 30, cluster: 2, spread: 6 },
        { kind: 'rock', s: 349, off: 47, cluster: 9, spread: 3.5 },
        { kind: 'rock', s: 356, off: 61, cluster: 12, spread: 6 },
        { kind: { broad: 0.7, rock: 0.3 }, s: 200, off: -42, cluster: 5, spread: 10 },
        ...outcrop({ s: 120, off: -64 }, 22, 13),
        ...outcrop({ s: 230, off: 70 }, 14, 10),
      ],
      forest: false,
      ob: { left: null, right: null },
      bounds: { margin: 66 },
    },
  ].map(finish),
};
