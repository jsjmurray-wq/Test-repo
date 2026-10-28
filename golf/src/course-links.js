// Links course (theme 'links'). PLACEHOLDER: nine simple but playable holes that exercise the
// version 2 platform (outside: 'fescue', pot bunkers, gorse, dune grass, firm ground, slower
// greens and windy conditions) so the renderer, game and UI can be built against real data. The
// course designers replace the holes with fully designed ones; keep the id, theme and conditions
// contract (docs/architecture.md section 8.2).

// Polyline length of a path (the centreline spline is a little longer).
function plen(path) {
  let L = 0;
  for (let i = 1; i < path.length; i++) L += Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]);
  return L;
}

// Open, rumpled ground: fairway, a rough band, then fescue with dune grass; gorse along the edge
// of the rough; two pot bunkers in the landing zone and one short of the green.
function linksHole(n, par, name, si, path, extra = {}) {
  const L = plen(path);
  const from = par === 3 ? L - 45 : Math.round(L * 0.3);
  const land = Math.round(L * (par === 5 ? 0.5 : 0.65));
  return {
    n, par, name, si, path,
    elev: [[0, 1.5], [L * 0.5, 0.5], [L, 1.2]],
    undulate: 0.9,
    tee: { s: 0, w: 9, l: 14, raise: 0.5 },
    fairway: { from, to: L - 14, width: par === 3 ? [[from, 18], [L - 14, 24]] : [[from, 32], [L - 14, 26]], wobble: 2.5 },
    green: { rx: 14, ry: 15, rot: 0, fringe: 1.5, slope: [270, 1.0], pins: [[-4, 5], [4, -4], [0, 0]] },
    bunkers: par === 3
      ? [{ g: [-15, -13], pot: true, r: 2.4 }, { g: [16, -6], pot: true, r: 2.2 }]
      : [
        { s: land, off: -5, pot: true, r: 2.2 },
        { s: land + 12, off: 8, pot: true, r: 2 },
        { g: [-15, -13], pot: true, r: 2.4 },
      ],
    outside: 'fescue',
    rough: { w: 10, green: 9 },
    objects: [
      { kind: 'gorse', from: 30, to: L - 30, off: -29, gap: 7, jitter: 3 },
      { kind: 'gorse', from: 30, to: L - 30, off: 29, gap: 9, jitter: 3 },
      { kind: 'grass', area: 'fescue', density: 2 },
    ],
    forest: false,
    ob: { left: null, right: null },
    bounds: { margin: 70 },
    ...extra,
  };
}

export const LINKS = {
  id: 'links',
  name: 'Gorse Point',
  tagline: 'Firm, fast and windswept seaside links',
  theme: 'links',
  conditions: { firm: 1.45, greenStimpFt: 9.5, wind: 'windy' },
  holes: [
    // The sea runs down the left of the opening hole.
    linksHole(1, 4, 'Outward', 5, [[0, 0], [10, 190], [0, 370]], {
      water: [{ kind: 'red', level: -1.5, bank: 10, depth: 2.5, sea: true, poly: [[-40, -52], [420, -52], [420, -140], [-40, -140]] }],
      bounds: { margin: 95 },
    }),
    linksHole(2, 3, 'Postage', 9, [[0, 0], [60, 70], [95, 112]]),
    linksHole(3, 5, 'Long Dunes', 3, [[0, 0], [30, 200], [0, 380], [-10, 475]]),
    linksHole(4, 4, 'Spectacles', 1, [[0, 0], [-160, 60], [-330, 90], [-370, 95]]),
    linksHole(5, 4, 'Whin Bank', 7, [[0, 0], [20, -170], [-20, -320], [-25, -345]]),
    linksHole(6, 3, 'Sandhills', 8, [[0, 0], [-80, -80], [-118, -128]]),
    linksHole(7, 4, 'Firth', 2, [[0, 0], [170, -20], [330, 10], [385, 20]]),
    linksHole(8, 5, 'Hell', 4, [[0, 0], [-10, 210], [40, 390], [60, 470]]),
    linksHole(9, 4, 'Home', 6, [[0, 0], [110, 110], [230, 230], [255, 250]]),
  ],
};
