// Club table and stock launch conditions for a good amateur (~5 handicap). Pure module.
//
// Each club gives full-swing ball speed (m/s), launch angle (deg) and backspin (rpm) as measured
// on a launch monitor. ballSpeed is re-solved by scripts/calibrate.mjs so that the simulated
// carry on flat fairway with no wind matches targetCarryYd.
//
// spinLoft (dynamic loft minus attack angle, deg) drives the D-plane: the spin axis tilts by
// atan((face - path) / spinLoft), so the same face-to-path curves a driver far more than a wedge.
//
// Sign conventions (see docs/architecture.md section 2):
//   tiltDeg     > 0 tilts the spin axis so the ball curves RIGHT (fade/slice for a right-hander)
//   startDirDeg > 0 starts the ball RIGHT of the aim line. Yaw is counter-clockwise positive,
//               so the launch direction is yawDir(aimYaw - startDir).

import { BALL_R } from './constants.js';
import { DEG, clamp } from './vec3.js';

export const PUTTER_ID = 'P';

// prettier-ignore
export const CLUBS = [
  { id: 'D',  name: 'Driver',         short: 'Dr', kind: 'wood',   loft: 10.5, spinLoft: 13, ballSpeed: 67.1, launch: 12.0, spinRpm: 2800, targetCarryYd: 244 },
  { id: '3W', name: '3 Wood',         short: '3W', kind: 'wood',   loft: 15,   spinLoft: 16, ballSpeed: 63.0, launch: 10.5, spinRpm: 3800, targetCarryYd: 228 },
  { id: '5W', name: '5 Wood',         short: '5W', kind: 'wood',   loft: 18,   spinLoft: 19, ballSpeed: 59.9, launch: 11.5, spinRpm: 4400, targetCarryYd: 216 },
  { id: '4H', name: '4 Hybrid',       short: '4H', kind: 'hybrid', loft: 22,   spinLoft: 22, ballSpeed: 56.8, launch: 12.5, spinRpm: 4700, targetCarryYd: 203 },
  { id: '5i', name: '5 Iron',         short: '5i', kind: 'iron',   loft: 26,   spinLoft: 25, ballSpeed: 53.6, launch: 13.0, spinRpm: 5300, targetCarryYd: 190 },
  { id: '6i', name: '6 Iron',         short: '6i', kind: 'iron',   loft: 30,   spinLoft: 28, ballSpeed: 51.0, launch: 14.5, spinRpm: 6100, targetCarryYd: 178 },
  { id: '7i', name: '7 Iron',         short: '7i', kind: 'iron',   loft: 34,   spinLoft: 31, ballSpeed: 48.3, launch: 16.5, spinRpm: 7000, targetCarryYd: 165 },
  { id: '8i', name: '8 Iron',         short: '8i', kind: 'iron',   loft: 38,   spinLoft: 34, ballSpeed: 45.6, launch: 18.5, spinRpm: 7800, targetCarryYd: 152 },
  { id: '9i', name: '9 Iron',         short: '9i', kind: 'iron',   loft: 42,   spinLoft: 37, ballSpeed: 42.9, launch: 21,   spinRpm: 8500, targetCarryYd: 138 },
  { id: 'PW', name: 'Pitching Wedge', short: 'PW', kind: 'wedge',  loft: 46,   spinLoft: 40, ballSpeed: 39.8, launch: 24,   spinRpm: 9000, targetCarryYd: 123 },
  { id: 'GW', name: 'Gap Wedge',      short: 'GW', kind: 'wedge',  loft: 50,   spinLoft: 43, ballSpeed: 36.7, launch: 27,   spinRpm: 9400, targetCarryYd: 108 },
  { id: 'SW', name: 'Sand Wedge',     short: 'SW', kind: 'wedge',  loft: 56,   spinLoft: 47, ballSpeed: 33.1, launch: 31,   spinRpm: 9800, targetCarryYd: 91 },
  { id: 'LW', name: 'Lob Wedge',      short: 'LW', kind: 'wedge',  loft: 60,   spinLoft: 50, ballSpeed: 29.1, launch: 34,   spinRpm: 9600, targetCarryYd: 74 },
  { id: 'P',  name: 'Putter',         short: 'Pt', kind: 'putter', loft: 3,    spinLoft: 3,  ballSpeed: 0,    launch: 0,    spinRpm: 0,    targetCarryYd: 0 },
];

const BY_ID = new Map(CLUBS.map((c) => [c.id, c]));

export function clubById(id) {
  return BY_ID.get(id) || null;
}

// D-plane: spin-axis tilt and start direction from face and path angles (deg, + = right).
// Woods start closer to the face (k = 0.85) than irons and wedges (k = 0.75).
export function dPlane(club, faceDeg, pathDeg) {
  const sl = Math.max(1, club.spinLoft);
  const tiltDeg = clamp(Math.atan((faceDeg - pathDeg) / sl) / DEG, -45, 45);
  const k = club.kind === 'wood' || club.kind === 'hybrid' ? 0.85 : 0.75;
  return { tiltDeg, startDirDeg: k * faceDeg + (1 - k) * pathDeg };
}

// Build a Launch from scalar launch-monitor numbers. pos is the ball CENTRE (ground + BALL_R);
// physics lifts a ball given at ground level up to ground + BALL_R anyway.
export function makeLaunch({
  pos = { x: 0, y: 0, z: BALL_R },
  aimYaw = 0,
  ballSpeed = 0,
  launchDeg = 0,
  spinRpm = 0,
  tiltDeg = 0,
  startDirDeg = 0,
  club = null,
  mode = 'air',
} = {}) {
  const yaw = aimYaw - startDirDeg * DEG;
  const dx = Math.cos(yaw);
  const dy = Math.sin(yaw);
  // right = dir x z_hat = (dy, -dx, 0)
  const rx = dy;
  const ry = -dx;
  const L = launchDeg * DEG;
  const spinRad = (spinRpm * 2 * Math.PI) / 60;
  const tilt = tiltDeg * DEG;
  const roll = mode === 'roll';
  return {
    pos: { x: pos.x, y: pos.y, z: pos.z },
    vel: roll
      ? { x: ballSpeed * dx, y: ballSpeed * dy, z: 0 }
      : { x: ballSpeed * Math.cos(L) * dx, y: ballSpeed * Math.cos(L) * dy, z: ballSpeed * Math.sin(L) },
    // w = spin (cos(tilt) right - sin(tilt) z): pure backspin at zero tilt; + tilt curves right.
    spin: roll
      ? { x: 0, y: 0, z: 0 }
      : { x: spinRad * Math.cos(tilt) * rx, y: spinRad * Math.cos(tilt) * ry, z: -spinRad * Math.sin(tilt) },
    mode: roll ? 'roll' : 'air',
    meta: { club: club ? club.id : null, ballSpeed, launchDeg, spinRpm, tiltDeg, startDirDeg },
  };
}

// Stock full swing with a club (or a putt with opts.ballSpeed for the putter).
// opts: pos, aimYaw, speedScale (ball speed x), spinScale, tiltDeg, startDirDeg, faceToPathDeg
// (overrides tiltDeg through the D-plane with path 0), ballSpeed (override).
export function stockLaunch(club, opts = {}) {
  const c = typeof club === 'string' ? clubById(club) : club;
  const putt = c.kind === 'putter';
  let tiltDeg = opts.tiltDeg || 0;
  let startDirDeg = opts.startDirDeg || 0;
  if (opts.faceToPathDeg !== undefined) {
    const d = dPlane(c, opts.faceToPathDeg, 0);
    tiltDeg = d.tiltDeg;
    if (opts.startDirDeg === undefined) startDirDeg = d.startDirDeg;
  }
  return makeLaunch({
    pos: opts.pos,
    aimYaw: opts.aimYaw || 0,
    ballSpeed: opts.ballSpeed !== undefined ? opts.ballSpeed : c.ballSpeed * (opts.speedScale ?? 1),
    launchDeg: c.launch,
    spinRpm: c.spinRpm * (opts.spinScale ?? 1),
    tiltDeg: putt ? 0 : tiltDeg,
    startDirDeg,
    club: c,
    mode: putt ? 'roll' : 'air',
  });
}
