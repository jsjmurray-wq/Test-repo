// The course: nine hand-designed holes as pure data (HoleDef), turned into terrain by terrain.js.
//
// HoleDef authoring format (private to the Course group; see docs/architecture.md §3)
//   path      [[x, y], ...] world-frame control points of the centreline, tee first, green centre
//             last (centripetal Catmull-Rom). The yardage is the spline length.
//   elev      [[s, z], ...] centreline elevation (monotone cubic Hermite, flat beyond the ends).
//   corridor  {w, h}: the land rises by ~h m beyond w m from the centreline (wraps round the ends).
//   undulate  fbm amplitude (m) of the rolling ground.
//   corners   [s, ...] dogleg corners used by aimPoint (default: control points turning > 10°).
//   tee       {s, w, l, raise}: flat box (w across, l along) centred on the path at s.
//   fairway   one or an array of {from, to, width:[[s, fullWidth], ...], wobble, shift?:[[s, off]]}.
//   green     {rx, ry, rot, fringe, raise, slope:[dirDeg, pct], tiers:[{angle, at, h, w}],
//              bumps:[[r, f, radius, h]], pins:[[r, f] x3]}. Green frame: r = right, f = forward
//             (away from the tee), centred on the last path point. Angles: 0 = right, 90 = back,
//             270 = front. slope[0] is the downhill direction; a tier steps UP by h along its angle
//             across a band of half-width w centred at `at` (keep h / (2w) small: greens <= 5%).
//             rx is the semi-axis across the line of play rotated by rot degrees (counter-clockwise).
//   bunkers   [{s, off} | {g:[r, f]}, shape:[[r, f, rx, ry, rotDeg], ...] (union of ellipses in the
//             anchor frame), depth].
//   water     [{kind:'red'|'yellow', level, poly:[[s, off], ...] | xy:[[x, y], ...], bank, depth}].
//             level is relative to the centreline elevation at the polygon's mean s.
//   trees     rows {from, to, off, gap, jitter, mix} or clusters {s, off, cluster, spread, mix};
//             mix = fraction of pines. forest: {inner, density, mix} background woodland (or false).
//   mounds    [[s, off, radius, height], ...].
//   ob        {left, right, from?, to?}: lateral distance of the OB line (null = none).
//   bounds    {margin}: playable area = centreline bounding box grown by margin.

export const COURSE = {
  name: 'Hollow Pines',
  holes: [
    // 1. Gentle dogleg right. OB left, fairway bunker right in the driving zone, two greenside traps.
    {
      n: 1, par: 4, name: 'First Light', si: 5,
      path: [[0, 0], [-3, 120], [4, 212], [30, 287], [51, 342]],
      corners: [222],
      elev: [[0, 1.5], [120, 0.2], [250, -0.8], [350, 0.6]],
      corridor: { w: 48, h: 5 },
      tee: { s: 0, w: 9, l: 14, raise: 0.45 },
      fairway: { from: 150, to: 338, width: [[150, 30], [225, 32], [290, 27], [338, 22]], wobble: 2.2 },
      green: {
        rx: 13, ry: 15, rot: 10, fringe: 1.2, slope: [260, 1.2],
        bumps: [[6, 7, 5, 0.06]],
        pins: [[-4, 6], [4, -6], [1, 0]],
      },
      bunkers: [
        { s: 225, off: 18, shape: [[0, 0, 6, 10, 8], [3, -7, 3.5, 4, 0]], depth: 0.75 },
        { g: [-21, -2], shape: [[0, 0, 4, 8.5, 12]], depth: 0.85 },
        { g: [17, 15], shape: [[0, 0, 7, 3.5, -40]], depth: 0.8 },
      ],
      trees: [
        { from: 25, to: 330, off: -40, gap: 9, jitter: 4, mix: 0.7 },
        { from: 30, to: 190, off: 37, gap: 11, jitter: 4, mix: 0.4 },
        { s: 285, off: 45, cluster: 7, spread: 12, mix: 0.3 },
        { s: 380, off: 10, cluster: 6, spread: 14, mix: 0.5 },
      ],
      mounds: [[200, -26, 12, 1.4], [320, 26, 10, 1.1]],
      ob: { left: 52, right: null },
      bounds: { margin: 75 },
    },

    // 2. Downhill par 3 over the corner of a pond (red) short and left; bunker back right.
    {
      n: 2, par: 3, name: 'Mirror Pond', si: 9,
      path: [[0, 0], [75, 3], [145, 5]],
      elev: [[0, 7.6], [40, 6.2], [110, 0.8], [145, 0]],
      corridor: { w: 42, h: 6 },
      undulate: 0.5,
      tee: { s: 0, w: 10, l: 12, raise: 0.4 },
      fairway: { from: 102, to: 132, width: [[102, 16], [132, 24]], wobble: 1 },
      green: {
        rx: 12, ry: 13, rot: -10, fringe: 1.2, slope: [235, 1.3],
        bumps: [[-4, -5, 4, 0.08]],
        pins: [[4, 4], [-3, -4], [0, 7]],
      },
      water: [{
        kind: 'red', level: -1.2, bank: 6,
        poly: [[82, -9], [98, -4], [116, -6], [124, -14], [123, -28], [108, -37], [90, -35], [78, -22]],
      }],
      bunkers: [{ g: [12, 18], shape: [[0, 0, 7, 3.5, -45], [-4, 3, 3, 2.5, 0]], depth: 0.6 }],
      trees: [
        { from: 10, to: 160, off: -34, gap: 10, jitter: 4, mix: 0.6 },
        { from: 10, to: 150, off: 30, gap: 10, jitter: 4, mix: 0.4 },
        { s: 175, off: 0, cluster: 8, spread: 14, mix: 0.6 },
      ],
      ob: { left: null, right: null },
      bounds: { margin: 65 },
    },

    // 3. Double dogleg par 5: left then right, a creek (red) crossing at 295-305 m, climbing 6 m to a
    //    two-tier green.
    {
      n: 3, par: 5, name: 'Serpent', si: 3,
      path: [[0, 0], [4, 130], [-14, 230], [-58, 312], [-74, 392], [-67, 456]],
      corners: [228, 335],
      elev: [[0, 0.5], [200, 0.6], [298, -0.6], [380, 2.2], [470, 6]],
      corridor: { w: 50, h: 6 },
      tee: { s: 0, w: 9, l: 15, raise: 0.4 },
      fairway: [
        { from: 165, to: 287, width: [[165, 30], [230, 33], [287, 28]], wobble: 2.2 },
        { from: 314, to: 450, width: [[314, 26], [380, 30], [450, 20]], wobble: 2 },
      ],
      green: {
        rx: 13, ry: 16, rot: -8, fringe: 1.2, slope: [270, 1.0],
        tiers: [{ angle: 90, at: 1, h: 0.3, w: 6.5 }],
        bumps: [[6, 10, 4, 0.06]],
        pins: [[3, -8], [-2, 9.5], [-6, -7]],
      },
      water: [{
        kind: 'red', level: -1.1, bank: 8, depth: 1.2,
        poly: [[293, -120], [296, -40], [294, 0], [297, 40], [295, 120], [305, 120], [306, 40], [303, 0], [306, -40], [303, -120]],
      }],
      bunkers: [
        { s: 240, off: -19, shape: [[0, 0, 5, 9, -6]], depth: 0.7 },
        { s: 392, off: 16, shape: [[0, 0, 5, 7, 10], [-1, 8, 3, 3.5, 0]], depth: 0.7 },
        { g: [-20.5, -4], shape: [[0, 0, 4, 7.5, 0]], depth: 0.9 },
        { g: [14, -16], shape: [[0, 0, 6, 3.2, 35]], depth: 0.9 },
      ],
      trees: [
        { from: 20, to: 280, off: -40, gap: 10, jitter: 4, mix: 0.6 },
        { from: 30, to: 280, off: 40, gap: 10, jitter: 4, mix: 0.6 },
        { from: 320, to: 470, off: -38, gap: 9, jitter: 4, mix: 0.4 },
        { from: 320, to: 460, off: 37, gap: 9, jitter: 4, mix: 0.4 },
        { s: 300, off: -30, cluster: 4, spread: 7, mix: 0.1 },
      ],
      mounds: [[150, 22, 10, 1.2], [345, -24, 11, 1.3]],
      ob: { left: null, right: null },
      bounds: { margin: 75 },
    },

    // 4. Long uphill par 4 between tree lines, OB all down the left, pot bunker short left.
    {
      n: 4, par: 4, name: 'The Climb', si: 1,
      path: [[0, 0], [-28, -120], [-52, -250], [-66, -374]],
      elev: [[0, 0], [110, 1.2], [260, 4.6], [375, 7]],
      corridor: { w: 42, h: 7 },
      tee: { s: 0, w: 9, l: 15, raise: 0.5 },
      fairway: { from: 145, to: 360, width: [[145, 28], [250, 30], [360, 22]], wobble: 1.8 },
      green: {
        rx: 12, ry: 14, rot: 6, fringe: 1.2, slope: [275, 1.2],
        bumps: [[-5, 5, 4.5, 0.08]],
        pins: [[3, 5], [-3, -5], [0, 0]],
      },
      bunkers: [
        { s: 238, off: 17, shape: [[0, 0, 5, 8, 0]], depth: 0.7 },
        { g: [-12, -18], shape: [[0, 0, 2.8, 2.8, 0]], depth: 1.1 },
        { g: [19.5, 2], shape: [[0, 0, 3.5, 7, -5]], depth: 0.8 },
      ],
      trees: [
        { from: 15, to: 370, off: -30, gap: 7, jitter: 3, mix: 0.7 },
        { from: 15, to: 370, off: 30, gap: 7, jitter: 3, mix: 0.7 },
        { from: 30, to: 360, off: -40, gap: 9, jitter: 4, mix: 0.8 },
        { from: 30, to: 360, off: 40, gap: 9, jitter: 4, mix: 0.8 },
      ],
      ob: { left: 45, right: null },
      bounds: { margin: 70 },
    },

    // 5. Short risk/reward dogleg left wrapped round a lake (red); bold line carries ~215 m.
    {
      n: 5, par: 4, name: 'Lakeside', si: 7,
      path: [[0, 0], [115, 2], [180, 22], [203, 80], [206, 128]],
      corners: [185],
      elev: [[0, 1.2], [150, 0.2], [300, 0.6]],
      corridor: { w: 75, h: 4 },
      undulate: 0.45,
      tee: { s: 0, w: 9, l: 14, raise: 0.4 },
      fairway: { from: 120, to: 290, width: [[120, 30], [200, 36], [250, 28], [290, 22]], wobble: 1.8 },
      green: {
        rx: 12, ry: 14, rot: 0, fringe: 1.2, slope: [200, 1.1],
        bumps: [[-5, 5, 5, 0.06]],
        pins: [[4, 6], [-2, -6], [0, 1]],
      },
      water: [{
        kind: 'red', level: -1.0, bank: 7,
        xy: [[95, 30], [135, 28], [160, 38], [175, 62], [180, 95], [182, 128], [176, 150], [155, 156], [135, 140], [118, 105], [100, 65]],
      }],
      bunkers: [
        { s: 225, off: 22, shape: [[0, 0, 5, 8, 0]], depth: 0.7 },
        { g: [18.5, -6], shape: [[0, 0, 3.5, 7, 0]], depth: 0.85 },
        { g: [6, 20.5], shape: [[0, 0, 7, 3, 0]], depth: 0.7 },
      ],
      trees: [
        { from: 20, to: 170, off: 34, gap: 9, jitter: 4, mix: 0.5 },
        { from: 210, to: 310, off: 44, gap: 9, jitter: 4, mix: 0.5 },
        { s: 60, off: -38, cluster: 6, spread: 12, mix: 0.3 },
      ],
      ob: { left: null, right: null },
      forest: { inner: 50 },
      bounds: { margin: 75 },
    },

    // 6. Par 3 to a green perched 4 m up with a false front; bunkers either side.
    {
      n: 6, par: 3, name: 'Eyrie', si: 8,
      path: [[0, 0], [60, 80], [105, 140]],
      elev: [[0, 0], [128, 0.2], [146, 1.6], [158, 3.8], [175, 4.2]],
      corridor: { w: 40, h: 6 },
      undulate: 0.5,
      tee: { s: 0, w: 10, l: 12, raise: 0.5 },
      fairway: { from: 112, to: 162, width: [[112, 18], [162, 26]], wobble: 1 },
      green: {
        rx: 12, ry: 12.5, rot: 15, fringe: 1.2, slope: [270, 1.2],
        bumps: [[6, -6, 5, 0.06]],
        pins: [[-4, 4], [4, -3], [0, 6]],
      },
      bunkers: [
        { g: [-20.5, -2], shape: [[0, 0, 4, 8, 10]], depth: 0.9 },
        { g: [20, 3], shape: [[0, 0, 4, 7, -10]], depth: 0.9 },
        { s: 130, off: -13, shape: [[0, 0, 5, 4, 20]], depth: 0.6 },
      ],
      trees: [
        { from: 10, to: 190, off: -32, gap: 9, jitter: 4, mix: 0.6 },
        { from: 10, to: 190, off: 32, gap: 9, jitter: 4, mix: 0.6 },
        { s: 205, off: 5, cluster: 9, spread: 15, mix: 0.7 },
      ],
      ob: { left: null, right: null },
      bounds: { margin: 65 },
    },

    // 7. The tee shot falls 10 m into a valley; the approach climbs to a plateau green over a line
    //    of cross bunkers at 300 m. OB right.
    {
      n: 7, par: 4, name: 'Long Drop', si: 2,
      path: [[0, 0], [-140, 8], [-270, 2], [-392, -24]],
      elev: [[0, 10], [60, 8.2], [190, 0], [265, 0.4], [345, 4.6], [395, 5.2]],
      corridor: { w: 45, h: 7 },
      tee: { s: 0, w: 9, l: 15, raise: 0.5 },
      fairway: { from: 160, to: 380, width: [[160, 30], [240, 34], [300, 30], [380, 22]], wobble: 2 },
      green: {
        rx: 14, ry: 13, rot: 0, fringe: 1.2, slope: [250, 1.3],
        bumps: [[6, -3, 4, 0.08]],
        pins: [[5, 3], [-5, -3], [-1, 4]],
      },
      bunkers: [
        { s: 300, off: -10, shape: [[0, 0, 7.5, 3.2, 4]], depth: 0.8 },
        { s: 303, off: 9, shape: [[0, 0, 6.5, 3, -6]], depth: 0.8 },
        { s: 298, off: 24, shape: [[0, 0, 4, 2.8, 0]], depth: 0.7 },
        { g: [-21.8, 0], shape: [[0, 0, 4, 8, 0]], depth: 0.9 },
        { g: [11, -18.8], shape: [[0, 0, 5.5, 3, -25]], depth: 0.85 },
      ],
      trees: [
        { from: 20, to: 390, off: -38, gap: 10, jitter: 4, mix: 0.5 },
        { from: 20, to: 280, off: 36, gap: 10, jitter: 4, mix: 0.5 },
        { s: 225, off: -32, cluster: 5, spread: 9, mix: 0.2 },
      ],
      mounds: [[210, 26, 12, 1.5]],
      ob: { left: null, right: 50 },
      bounds: { margin: 72 },
    },

    // 8. Reachable par 5: water (red, lateral relief) all down the right of the second half, green
    // tucked right. It runs alongside the hole, so yellow back-on-the-line relief would be unusable.
    {
      n: 8, par: 5, name: 'Temptation', si: 4,
      path: [[0, 0], [6, -150], [0, -288], [-22, -388], [-56, -438]],
      corners: [300],
      elev: [[0, 0.8], [200, -0.4], [445, 0.4]],
      corridor: { w: 50, h: 5 },
      tee: { s: 0, w: 9, l: 15, raise: 0.4 },
      fairway: [
        { from: 150, to: 428, width: [[150, 30], [260, 34], [330, 28], [400, 24], [428, 20]], wobble: 2 },
      ],
      green: {
        rx: 12, ry: 14, rot: -20, fringe: 1.2, slope: [140, 1.2],
        bumps: [[5, -7, 5, 0.06]],
        pins: [[3, 5], [-4, -4], [1, 0]],
      },
      water: [{
        kind: 'red', level: -1.0, bank: 6,
        poly: [[228, 26], [290, 21], [350, 22], [405, 21], [430, 25], [455, 33], [470, 52], [445, 62], [390, 58], [320, 55], [250, 52], [222, 40]],
      }],
      bunkers: [
        { s: 250, off: -19, shape: [[0, 0, 5, 10, 0]], depth: 0.7 },
        { s: 362, off: -18, shape: [[0, 0, 4.5, 7, -5], [-2, 7, 3, 3, 0]], depth: 0.7 },
        { g: [-20.5, 4], shape: [[0, 0, 4, 8, 15]], depth: 0.9 },
      ],
      trees: [
        { from: 20, to: 430, off: -40, gap: 9, jitter: 4, mix: 0.5 },
        { from: 20, to: 210, off: 36, gap: 10, jitter: 4, mix: 0.5 },
        { s: 470, off: -10, cluster: 7, spread: 13, mix: 0.6 },
      ],
      mounds: [[180, -27, 12, 1.4]],
      ob: { left: null, right: null },
      bounds: { margin: 75 },
    },

    // 9. Uphill home hole: pond left of the landing area, two-tier green below the clubhouse.
    {
      n: 9, par: 4, name: 'Homeward', si: 6,
      path: [[0, 0], [66, 112], [112, 210], [132, 274], [140, 333]],
      corners: [235],
      elev: [[0, 0], [150, 1.2], [260, 3.8], [365, 6.2]],
      corridor: { w: 48, h: 6 },
      tee: { s: 0, w: 9, l: 15, raise: 0.45 },
      fairway: { from: 155, to: 345, width: [[155, 30], [230, 32], [300, 27], [345, 22]], wobble: 2 },
      green: {
        rx: 14, ry: 15, rot: 4, fringe: 1.2, slope: [265, 0.9],
        tiers: [{ angle: 90, at: 0, h: 0.3, w: 6.5 }],
        bumps: [[7, -9, 3.5, 0.05]],
        pins: [[4, 9], [-4, -8], [6, -7.5]],
      },
      water: [{
        kind: 'red', level: -1.1, bank: 8,
        poly: [[188, -24], [210, -21], [240, -23], [258, -32], [255, -52], [232, -62], [205, -60], [186, -44]],
      }],
      bunkers: [
        { s: 255, off: 18, shape: [[0, 0, 5, 8, 0]], depth: 0.7 },
        { g: [-21.8, 2], shape: [[0, 0, 4, 9, 0]], depth: 0.9 },
        { g: [19.5, -10.5], shape: [[0, 0, 5, 3.5, 40]], depth: 0.85 },
      ],
      trees: [
        { from: 20, to: 170, off: -36, gap: 10, jitter: 4, mix: 0.6 },
        { from: 20, to: 360, off: 40, gap: 9, jitter: 4, mix: 0.6 },
        { from: 270, to: 360, off: -40, gap: 9, jitter: 4, mix: 0.5 },
        { s: 400, off: 0, cluster: 8, spread: 16, mix: 0.4 },
      ],
      mounds: [[300, 25, 10, 1.2]],
      ob: { left: null, right: 55 },
      bounds: { margin: 72 },
    },
  ],
};

// Par of hole i (0-based index into COURSE.holes).
export function holePar(i) {
  return COURSE.holes[i].par;
}

export function coursePar() {
  return COURSE.holes.reduce((a, h) => a + h.par, 0);
}
