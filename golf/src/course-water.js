// Water course (theme 'tropical'). PLACEHOLDER: nine simple but playable holes that exercise the
// version 2 platform (an island green built with fill: 'outside' water, an ocean hole with
// outside: 'water' and sea: true, lagoons, beaches as waste areas, palms) so the renderer, game
// and UI can be built against real data. The course designers replace the holes with fully
// designed ones; keep the id, theme and conditions contract (docs/architecture.md section 8.2).

// Polyline length of a path (the centreline spline is a little longer).
function plen(path) {
  let L = 0;
  for (let i = 1; i < path.length; i++) L += Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]);
  return L;
}

// Regular polygon [[x, y], ...] of radius r round (cx, cy).
function ring(cx, cy, r, n = 12) {
  const pts = [];
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}

// A strip [[s, off], ...] from s0 to s1 between lateral offsets o0 and o1, with a vertex every
// ~20 m so it follows the bends of the hole.
function band(s0, s1, o0, o1) {
  const n = Math.max(1, Math.round((s1 - s0) / 20));
  const near = [];
  const far = [];
  for (let k = 0; k <= n; k++) {
    const s = s0 + ((s1 - s0) * k) / n;
    near.push([s, o0]);
    far.push([s, o1]);
  }
  return near.concat(far.reverse());
}

// Palms lining both sides of the hole, mostly palms with a few broadleaves.
function palms(L) {
  return [
    { kind: { palm: 0.8, broad: 0.2 }, from: 20, to: L - 10, off: -36, gap: 12, jitter: 4 },
    { kind: { palm: 0.8, broad: 0.2 }, from: 20, to: L - 10, off: 36, gap: 12, jitter: 4 },
  ];
}

function waterHole(n, par, name, si, path, extra = {}) {
  const L = plen(path);
  const from = par === 3 ? L - 42 : Math.round(L * 0.38);
  return {
    n, par, name, si, path,
    elev: [[0, 1.2], [L, 0.6]],
    undulate: 0.4,
    tee: { s: 0, w: 9, l: 14, raise: 0.4 },
    fairway: { from, to: L - 14, width: par === 3 ? [[from, 16], [L - 14, 22]] : [[from, 30], [L - 14, 22]], wobble: 2 },
    green: { rx: 13, ry: 14, rot: 0, fringe: 1.2, slope: [260, 1.1], pins: [[-4, 4], [4, -3], [0, 0]] },
    bunkers: [
      { g: [-21, 0], shape: [[0, 0, 4, 7.5, 0]], depth: 0.8 },
      { g: [20.5, 5], shape: [[0, 0, 3.5, 6.5, -10]], depth: 0.8 },
    ],
    objects: palms(L),
    forest: { kind: { palm: 0.6, broad: 0.4 }, inner: 46, density: 0.5 },
    ob: { left: null, right: null },
    bounds: { margin: 70 },
    ...extra,
  };
}

export const WATER = {
  id: 'water',
  name: 'Coral Cay',
  tagline: 'Island greens, palms and ocean carries',
  theme: 'tropical',
  conditions: { firm: 1.05, greenStimpFt: 11, wind: 'normal' },
  holes: [
    // A lagoon (red) left of the landing zone, with a beach on its near shore.
    waterHole(1, 4, 'Lagoon', 5, [[0, 0], [0, 180], [20, 345]], {
      water: [{ kind: 'red', level: -1, bank: 6, poly: [[150, -28], [235, -26], [245, -50], [210, -64], [150, -58]] }],
      areas: [{ surface: 'waste', poly: band(140, 250, -18, -27) }],
    }),
    waterHole(2, 3, 'Shell Beach', 9, [[0, 0], [90, 60], [140, 95]], {
      areas: [{ surface: 'waste', g: [0, 24], shape: [[0, 0, 16, 5, 0]] }],
    }),
    // Island green: the tee and the green stand on their own islands in the lagoon.
    waterHole(3, 3, 'The Island', 8, [[0, 0], [0, 70], [0, 140]], {
      elev: [[0, 1], [140, 1]],
      undulate: 0.25,
      fairway: [],
      green: { rx: 13, ry: 14, rot: 0, fringe: 1.2, raise: 0.3, slope: [250, 1.0], pins: [[-4, 4], [4, -3], [0, 0]] },
      bunkers: [{ g: [0, 20], shape: [[0, 0, 5, 2.2, 0]], depth: 0.6 }],
      water: [
        { kind: 'red', fill: 'outside', level: -1.0, bank: 4, depth: 2.2, xy: ring(0, 140, 28) },
        { kind: 'red', fill: 'outside', xy: [[-24, -24], [24, -24], [24, 24], [-24, 24]] },
      ],
      objects: [{ kind: 'palm', s: 140, off: -24, cluster: 3, spread: 3 }],
      forest: false,
      bounds: { margin: 60 },
    }),
    waterHole(4, 5, 'Trade Winds', 1, [[0, 0], [-20, 220], [30, 400], [40, 470]]),
    waterHole(5, 4, 'Mangrove', 3, [[0, 0], [130, 60], [250, 170], [270, 190]], {
      water: [{ kind: 'yellow', level: -1, bank: 6, poly: [[170, -20], [182, -20], [182, 20], [170, 20]] }],
    }),
    waterHole(6, 4, 'Pelican', 7, [[0, 0], [-150, -90], [-280, -150], [-310, -160]]),
    // Ocean hole: everything beyond the corridor (and its beach) is the sea.
    waterHole(7, 4, 'Breakers', 2, [[0, 0], [0, 200], [40, 350]], {
      outside: 'water',
      outsideWater: { kind: 'red', level: -1.5, depth: 3, bank: 10, sea: true },
      rough: { w: 12, green: 12 },
      fairway: { from: 60, to: 337, width: [[60, 28], [200, 32], [337, 22]], wobble: 2 },
      areas: [{ surface: 'waste', poly: band(90, 300, 22, 40) }],
      objects: [{ kind: 'palm', from: 40, to: 330, off: -24, gap: 14, jitter: 3 }],
      forest: false,
    }),
    waterHole(8, 5, 'Reef Run', 4, [[0, 0], [10, -230], [-30, -400], [-35, -475]]),
    waterHole(9, 4, 'Sunset', 6, [[0, 0], [-120, 90], [-240, 200], [-265, 225]], {
      water: [{ kind: 'red', level: -1, bank: 6, sea: true, poly: [[260, 26], [340, 24], [360, 60], [250, 60]] }],
    }),
  ],
};
