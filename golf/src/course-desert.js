// Desert course (theme 'desert'). PLACEHOLDER: nine simple but playable holes that exercise the
// version 2 platform (outside: 'desert', waste areas, saguaros, rocks and shrubs, firm ground) so
// the renderer, game and UI can be built against real data. The course designers replace the
// holes with fully designed ones; keep the id, theme and conditions contract (docs/architecture.md
// section 8.2). HoleDef format: course.js and terrain.js headers.

// Polyline length of a path (the centreline spline is a little longer).
function plen(path) {
  let L = 0;
  for (let i = 1; i < path.length; i++) L += Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]);
  return L;
}

// Saguaros, shrubs and rocks scattered over the desert floor.
const DESERT_OBJECTS = [{ kind: { saguaro: 0.35, shrub: 0.45, rock: 0.2 }, area: 'desert', density: 0.3 }];

// Target golf: a fairway island through the landing zone (a forced carry from the tee), a narrow
// band of rough, then desert; a waste area right of the landing zone and two greenside bunkers.
function desertHole(n, par, name, si, path, extra = {}) {
  const L = plen(path);
  const from = par === 3 ? L - 42 : Math.round(L * 0.4);
  return {
    n, par, name, si, path,
    elev: [[0, 2], [L, 0]],
    undulate: 0.5,
    tee: { s: 0, w: 9, l: 14, raise: 0.5 },
    fairway: { from, to: L - 14, width: par === 3 ? [[from, 16], [L - 14, 22]] : [[from, 28], [L * 0.7, 32], [L - 14, 22]], wobble: 2 },
    green: { rx: 13, ry: 14, rot: 0, fringe: 1.2, slope: [270, 1.2], pins: [[-4, 4], [4, -3], [0, 0]] },
    bunkers: [
      { g: [-21, 0], shape: [[0, 0, 4, 7.5, 0]], depth: 0.85 },
      { g: [20.5, 5], shape: [[0, 0, 3.5, 6.5, -10]], depth: 0.8 },
    ],
    outside: 'desert',
    rough: { w: 6, green: 5 },
    areas: par === 3 ? [] : [{ surface: 'waste', poly: [[L * 0.5, 21], [L * 0.75, 21], [L * 0.75, 36], [L * 0.5, 34]], dz: -0.15 }],
    objects: DESERT_OBJECTS,
    forest: false,
    ob: { left: null, right: null },
    bounds: { margin: 70 },
    ...extra,
  };
}

export const DESERT = {
  id: 'desert',
  name: 'Red Mesa',
  tagline: 'Target golf through the high desert',
  theme: 'desert',
  conditions: { firm: 1.25, greenStimpFt: 11, wind: 'normal' },
  holes: [
    desertHole(1, 4, 'Dry Wash', 5, [[0, 0], [5, 180], [-10, 330], [-15, 355]]),
    desertHole(2, 3, 'Mesa Shelf', 9, [[0, 0], [80, 80], [115, 118]]),
    desertHole(3, 5, 'Long Arroyo', 3, [[0, 0], [0, 220], [40, 400], [50, 470]]),
    desertHole(4, 4, 'Sidewinder', 1, [[0, 0], [-140, 40], [-260, 10], [-380, -20]]),
    desertHole(5, 4, 'Coyote', 7, [[0, 0], [20, -150], [60, -300], [70, -330]]),
    desertHole(6, 3, 'Sundial', 8, [[0, 0], [-90, -60], [-140, -100]]),
    desertHole(7, 4, 'Red Rock', 2, [[0, 0], [150, 20], [300, 0], [380, -10]], {
      objects: [...DESERT_OBJECTS, { kind: 'rock', s: 250, off: -28, cluster: 6, spread: 8 }],
    }),
    desertHole(8, 5, 'Sidewash', 4, [[0, 0], [-30, 200], [-10, 380], [20, 470]]),
    desertHole(9, 4, 'Oasis', 6, [[0, 0], [100, 100], [220, 230], [240, 260]]),
  ],
};
