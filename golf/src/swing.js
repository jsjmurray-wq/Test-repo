// Swing interpretation (touch trace -> swing parameters) and launch construction (swing + club +
// lie -> Launch for physics). Pure module (docs/architecture.md section 4).
//
//   interpretSwing(samples, {padRefH, kind:'full'|'putt', difficulty, handed, club?}) -> SwingResult
//   swingToLaunch(club, lie, swing, aimYaw, rng, {pos, puttRange}) -> Launch
//
// samples: [{t (ms), x, y (CSS px)}] for one pointer, pointerdown to pointerup, exactly as
// input.js records them. The touchdown y is the impact line; power comes from the deepest point
// below it, with the same reference travel as the live gauge (input.js FULL_POWER_FRAC /
// PUTT_POWER_FRAC x padRefH, capped at MAX_POWER).
//
// SwingResult = {ok, reason?:'cancel'|'tooSlow'|'short', kind, power, overswing, startDir,
//                faceToPath, face, path, tempo:'smooth'|'rushed'|'decel', tempoErr, label}
//   startDir, faceToPath, face, path are degrees, + = RIGHT of the aim line (screen right is
//   the golfer's right: the camera looks down the aim line). faceToPath > 0 curves the ball
//   right (a fade or slice for a right-hander).
//
// Full swing gesture
//   1. Drag down from the touchdown point (backswing); depth sets the power.
//   2. Swipe up through the touchdown line at >= STRIKE_SPEED px/s: that is the strike. A finger
//      lifted while still flicking up fast, within LIFT_GRACE_S of the line, also strikes (the
//      last touch sample of a fast flick often lands just short of the line).
//      Releasing during the backswing cancels ('cancel'); coming back up too slowly is 'tooSlow';
//      a press with almost no backswing is 'short'. None of these count as a stroke.
//   3. The chord from the bottom of the backswing to the release point sets the start direction;
//      the bend of the upswing (heading of the last 40% of its length minus that of the first
//      60%) sets the face-to-path, i.e. the curve. Gains and dead zones depend on difficulty;
//      left-handed play flips the sign of the bend.
//   4. Tempo: the downswing (from the moment the finger starts up out of the bottom to the strike)
//      ideally takes 0.10 + 0.15 x power s, and any brisk flick (up to ~2400 px/s at full power)
//      is fine. Under RUSHED_FRAC of the ideal is 'rushed': extra face scatter growing from half
//      to all of RUSHED_FACE the quicker it is (tempoErr 0..1). Over twice the ideal is 'decel'
//      (ball speed x 0.92). A still pause at the bottom fires no touch events, so the move's start
//      is extrapolated back from the first samples that leave the bottom.
//
// Putt gesture: drag down to set the pace (power = depth / (0.30 padRefH) maps to a flat-roll
// distance power x puttRange), then release, or flick up through the start line. Sliding back to
// within 25% of the depth of the start line (and no further), or sliding far sideways, cancels at
// any speed: that is how a player changes their mind. Presses under PUTT_MIN_DEPTH_PX are slips.
// The sideways drift of the last 150 ms (x 0.08 deg/px on Normal, scaled like G_s on Easy/Pro and
// with a dzA px dead zone, clamped to +-3 deg) pushes or pulls the putt.

import { BALL_R, SURF, SURFACES } from './constants.js';
import { clamp, DEG } from './vec3.js';
import { gaussian } from './rng.js';
import { clubById, dPlane, makeLaunch } from './clubs.js';
import { puttSpeedForDistance } from './physics.js';
import { applyLie } from './lie.js';
import { FULL_POWER_FRAC, PUTT_POWER_FRAC, MAX_POWER } from './input.js';

// Difficulty: start-direction gain G_s and curve gain G_c (output deg per input deg) and their
// dead zones on the chord angle (dzA) and the bend (dzK), in degrees.
export const DIFFICULTY = {
  easy: { gs: 0.15, gc: 0.05, dzA: 4, dzK: 8 },
  normal: { gs: 0.25, gc: 0.08, dzA: 2, dzK: 4 },
  pro: { gs: 0.35, gc: 0.12, dzA: 0, dzK: 0 },
};

export const STRIKE_SPEED = 400; // px/s upward through the impact line
export const MAX_START_DIR = 10; // deg
export const MAX_FACE_TO_PATH = 8; // deg
export const PUTT_RANGES = [3, 6, 9, 12, 18, 24, 30]; // m, flat-roll distance at power 1
const MIN_DEPTH_PX = 8; // shallower presses are taps, not swings
const LIFT_GRACE_S = 0.05; // a flick lifted this close (in time) to the line still strikes
const SPEED_WINDOW_MS = 50; // strike speed is averaged over this window before the line
const BOTTOM_TOL_PX = 3; // jitter allowed while the finger rests at the bottom
const PUTT_DRIFT_MS = 150;
const PUTT_DRIFT_GAIN = 0.08; // deg per px of sideways drift
const PUTT_MAX_DIR = 3; // deg
const PUTT_CANCEL_FRAC = 0.25; // a putt brought back within 25% of its depth of the line cancels
const PUTT_THROUGH_PX = 12; // ...unless it flicks this far through the line (a flick stroke)
const PUTT_SIDE_CANCEL_PX = 60; // a putt dragged this far sideways is abandoned, not struck
export const PUTT_MIN_DEPTH_PX = 20; // shallower putt presses are slips, not strokes
export const RUSHED_FRAC = 0.18; // downswing under this fraction of the ideal is rushed
export const DECEL_FRAC = 2; // ...over this multiple is decelerating

// Random contact (deg, fraction): the scatter of a good amateur's strike. Overswing doubles it.
export const SIGMA_DIR = 0.6; // start direction, plus the lie's sdir
export const SIGMA_FACE = 0.4; // face (curve) scatter of a normal swing
export const SIGMA_SPEED = 0.015;
export const RUSHED_FACE = 0.6; // extra face sigma (max) for a rushed tempo
export const DECEL_SPEED = 0.92;
export const PUTT_SIGMA_SPEED = 0.01;
export const PUTT_SIGMA_DIR = 0.3;

const sgn = (v) => (v < 0 ? -1 : 1);
// Dead zone then gain: |v| below dz gives 0, beyond it grows from 0.
const shape = (v, dz, gain) => (Math.abs(v) <= dz ? 0 : sgn(v) * (Math.abs(v) - dz) * gain);
// Screen heading of a segment in degrees: 0 = straight up, + = toward screen right.
const heading = (a, b) => Math.atan2(b.x - a.x, a.y - b.y) / DEG;

function wrapDeg(a) {
  a %= 360;
  if (a > 180) a -= 360;
  if (a < -180) a += 360;
  return a;
}

// Linear interpolation of the trace at time t (ms), clamped to its ends.
function sampleAt(S, t) {
  if (t <= S[0].t) return S[0];
  const n = S.length;
  if (t >= S[n - 1].t) return S[n - 1];
  let i = 1;
  while (i < n - 1 && S[i].t < t) i++;
  const a = S[i - 1];
  const b = S[i];
  const f = b.t > a.t ? (t - a.t) / (b.t - a.t) : 1;
  return { t, x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
}

// Upward speed (px/s) of the trace over [max(t0, t1 - window), t1] ending at y1.
function upSpeed(S, tFrom, t1, y1) {
  const ta = Math.max(tFrom, t1 - SPEED_WINDOW_MS);
  const dt = t1 - ta;
  if (dt < 1) {
    // Degenerate (one jump): fall back to the last segment before t1.
    let i = S.length - 1;
    while (i > 0 && S[i].t > t1) i--;
    const a = S[Math.max(0, i - 1)];
    const b = S[i];
    const d = Math.max(1, b.t - a.t);
    return ((a.y - b.y) / d) * 1000;
  }
  return ((sampleAt(S, ta).y - y1) / dt) * 1000;
}

export function swingLabel(startDir, faceToPath, handed = 'R') {
  const lefty = handed === 'L';
  let start = '';
  if (Math.abs(startDir) >= 1) start = (startDir > 0) !== lefty ? 'Push' : 'Pull';
  let curve = '';
  if (Math.abs(faceToPath) >= 0.75) {
    // Curving right is a fade/slice for a right-hander and a draw/hook for a left-hander.
    const away = (faceToPath > 0) !== lefty;
    const big = Math.abs(faceToPath) >= 2.5;
    curve = away ? (big ? 'Slice' : 'Fade') : big ? 'Hook' : 'Draw';
  }
  if (start && curve) return `${start} ${curve.toLowerCase()}`;
  return start || curve || 'Straight';
}

function failed(kind, reason, power) {
  const labels = { cancel: 'Cancelled', tooSlow: 'Too slow', short: 'Too short' };
  return {
    ok: false,
    reason,
    kind,
    power,
    overswing: kind === 'full' && power > 1,
    startDir: 0,
    faceToPath: 0,
    face: 0,
    path: 0,
    tempo: 'smooth',
    tempoErr: 0,
    label: labels[reason],
  };
}

export function interpretSwing(samples, opts = {}) {
  const kind = opts.kind === 'putt' ? 'putt' : 'full';
  const S = Array.isArray(samples) ? samples : [];
  if (S.length < 2) return failed(kind, 'short', 0);
  const H = Math.max(1, opts.padRefH || 300);
  const diff = DIFFICULTY[opts.difficulty] || DIFFICULTY.normal;
  const y0 = S[0].y;
  let maxY = y0;
  for (const s of S) if (s.y > maxY) maxY = s.y;
  const depth = maxY - y0;
  const frac = kind === 'putt' ? PUTT_POWER_FRAC : FULL_POWER_FRAC;
  const power = clamp(depth / (frac * H), 0, MAX_POWER);
  if (depth < (kind === 'putt' ? PUTT_MIN_DEPTH_PX : MIN_DEPTH_PX)) return failed(kind, 'short', power);
  return kind === 'putt' ? interpretPutt(S, y0, depth, power, diff, opts) : interpretFull(S, y0, power, diff, opts);
}

function interpretFull(S, y0, power, diff, opts) {
  const n = S.length;
  let iMax = 0;
  for (let i = 1; i < n; i++) if (S[i].y > S[iMax].y) iMax = i;
  // Strike: the first upward crossing of the impact line after the deepest point.
  let c = -1;
  for (let i = iMax + 1; i < n; i++) {
    if (S[i].y <= y0) {
      c = i;
      break;
    }
  }
  const last = c >= 0 ? c - 1 : n - 1;
  // Start of the downswing: walk back through the final upward run (and any pause at the
  // bottom) to the last sample still at the bottom of the backswing.
  let i0 = last;
  let runMax = S[last].y;
  while (i0 > 0 && S[i0 - 1].y >= runMax - BOTTOM_TOL_PX) {
    i0--;
    if (S[i0].y > runMax) runMax = S[i0].y;
  }
  let b = i0;
  for (let i = i0; i <= last; i++) if (S[i].y >= runMax - BOTTOM_TOL_PX) b = i;
  const bottom = S[b];

  let tc;
  let vStrike;
  if (c >= 0) {
    const p = S[c - 1];
    const q = S[c];
    const f = p.y > q.y ? (p.y - y0) / (p.y - q.y) : 1;
    tc = p.t + (q.t - p.t) * f;
    vStrike = upSpeed(S, bottom.t, tc, y0);
  } else {
    // No crossing: a fast flick lifted just short of the line still strikes; anything else
    // (released in the backswing or on the way back up) cancels.
    const e = S[n - 1];
    const v = upSpeed(S, bottom.t, e.t, e.y);
    if (b === n - 1 || v < STRIKE_SPEED || (e.y - y0) / v > LIFT_GRACE_S) return failed('full', 'cancel', power);
    tc = e.t + ((e.y - y0) / v) * 1000;
    vStrike = v;
  }
  if (vStrike < STRIKE_SPEED) return failed('full', 'tooSlow', power);

  // Tempo of the downswing, from when the finger starts up out of the bottom.
  const T = Math.max(0, tc - moveStart(S, b, tc, y0)) / 1000;
  const ideal = 0.1 + 0.15 * power;
  const tempoErr = T < RUSHED_FRAC * ideal ? 1 - T / (RUSHED_FRAC * ideal) : 0;
  const tempo = tempoErr > 0 ? 'rushed' : T > DECEL_FRAC * ideal ? 'decel' : 'smooth';

  // Direction: chord from the bottom of the backswing to the release point.
  const end = S[n - 1];
  const alpha = heading(bottom, end);
  // Curvature: split the upswing trace at 60% of its arc length.
  let total = 0;
  for (let i = b + 1; i < n; i++) total += Math.hypot(S[i].x - S[i - 1].x, S[i].y - S[i - 1].y);
  let kappa = 0;
  if (total > 1e-6) {
    const target = 0.6 * total;
    let acc = 0;
    let split = end;
    for (let i = b + 1; i < n; i++) {
      const seg = Math.hypot(S[i].x - S[i - 1].x, S[i].y - S[i - 1].y);
      if (acc + seg >= target && seg > 0) {
        const f = (target - acc) / seg;
        split = { x: S[i - 1].x + (S[i].x - S[i - 1].x) * f, y: S[i - 1].y + (S[i].y - S[i - 1].y) * f };
        break;
      }
      acc += seg;
    }
    const d1 = Math.hypot(split.x - bottom.x, split.y - bottom.y);
    const d2 = Math.hypot(end.x - split.x, end.y - split.y);
    if (d1 > 1e-6 && d2 > 1e-6) kappa = wrapDeg(heading(split, end) - heading(bottom, split));
  }
  if (opts.handed === 'L') kappa = -kappa;

  const startDir = clamp(shape(alpha, diff.dzA, diff.gs), -MAX_START_DIR, MAX_START_DIR);
  const faceToPath = clamp(shape(kappa, diff.dzK, diff.gc), -MAX_FACE_TO_PATH, MAX_FACE_TO_PATH);
  // D-plane split (start = path + k x faceToPath); k depends on the club, 0.8 if unknown.
  const club = typeof opts.club === 'string' ? clubById(opts.club) : opts.club;
  const k = club ? dPlane(club, 1, 0).startDirDeg : 0.8;
  const path = startDir - k * faceToPath;
  let label = swingLabel(startDir, faceToPath, opts.handed);
  if (tempo === 'rushed') label += ' · Rushed';
  else if (tempo === 'decel') label += ' · Decel';
  return {
    ok: true,
    kind: 'full',
    power,
    overswing: power > 1,
    startDir,
    faceToPath,
    face: path + faceToPath,
    path,
    tempo,
    tempoErr,
    label,
    alpha,
    kappa,
    downswingS: T,
  };
}

// Time (ms) the finger started up out of the bottom sample b, the strike being at (tc, y0). The
// first sample clearly above the bottom is traced back at the mean speed of the rest of the
// upswing, so a motionless pause (no events) or a coarse first sample does not count.
function moveStart(S, b, tc, y0) {
  const n = S.length;
  let u = b + 1;
  while (u < n && S[b].y - S[u].y <= BOTTOM_TOL_PX) u++;
  if (u >= n) return S[b].t;
  const q = S[u];
  const rest = q.y - y0;
  const dtRest = tc - q.t;
  const v = rest > 1 && dtRest > 1 ? rest / dtRest : (S[b].y - q.y) / Math.max(1, q.t - S[b].t);
  return Math.max(S[b].t, q.t - (S[b].y - q.y) / Math.max(v, 1e-3));
}

function interpretPutt(S, y0, depth, power, diff, opts) {
  const n = S.length;
  const end = S[n - 1];
  // Sliding back to (near) the start line, at any speed, or far off sideways is a change of mind;
  // a release anywhere else, or a flick on through the line, strokes the putt.
  let iMax = 0;
  for (let i = 1; i < n; i++) if (S[i].y > S[iMax].y) iMax = i;
  const back = end.y - y0;
  if (back <= PUTT_CANCEL_FRAC * depth && back >= -PUTT_THROUGH_PX) return failed('putt', 'cancel', power);
  if (Math.abs(end.x - S[iMax].x) > PUTT_SIDE_CANCEL_PX) return failed('putt', 'cancel', power);
  // Sideways drift over the last 150 ms pushes (right) or pulls (left) the putt. Easier settings
  // damp it and ignore a few px of wobble (same ratio as the full-swing gains).
  const from = sampleAt(S, end.t - PUTT_DRIFT_MS);
  const drift = end.x - from.x;
  const dzPx = diff.dzA; // 4 / 2 / 0 px
  const gain = PUTT_DRIFT_GAIN * (diff.gs / DIFFICULTY.normal.gs);
  const startDir = clamp(shape(drift, dzPx, gain), -PUTT_MAX_DIR, PUTT_MAX_DIR);
  let label = 'Putt';
  if (Math.abs(startDir) >= 0.3) label = (startDir > 0) !== (opts.handed === 'L') ? 'Pushed putt' : 'Pulled putt';
  return {
    ok: true,
    kind: 'putt',
    power,
    overswing: false,
    startDir,
    faceToPath: 0,
    face: startDir,
    path: startDir,
    tempo: 'smooth',
    tempoErr: 0,
    label,
  };
}

// Launch and spin of a shorter, softer swing. A pitch is played with the face open and little
// shaft lean, so it launches higher than the full shot (up to PARTIAL_LAUNCH deg more for wedges,
// a little for irons), and its spin falls more slowly than its ball speed (a 40 yd sand-wedge
// pitch still has ~6000 rpm): it lands at 40-50 deg and stops within a few yards.
export const PARTIAL_LAUNCH = { wedge: 8, iron: 2 };
export function partialSwing(club, power, speedFactor = 0.15 + 0.85 * power) {
  const short = 1 - Math.min(1, Math.max(0, power));
  const sf = Math.max(0, speedFactor);
  if (club.kind === 'wedge') {
    return { launchDeg: club.launch + PARTIAL_LAUNCH.wedge * short, spinRpm: club.spinRpm * Math.pow(sf, 0.5) * (1 - 0.2 * short) };
  }
  return { launchDeg: club.launch + (club.kind === 'iron' ? PARTIAL_LAUNCH.iron * short : 0), spinRpm: club.spinRpm * sf };
}

// Builds the Launch for a swing. rng (a mulberry32 function) adds the random contact; pass null for
// the intended, error-free shot (caddie tables and the bot's planning).
//   opts.pos        ball centre {x, y, z} (physics lifts a ball given at ground level)
//   opts.puttRange  flat-roll distance (m) at putt power 1
export function swingToLaunch(club, lie, swing, aimYaw, rng, opts = {}) {
  const c = typeof club === 'string' ? clubById(club) : club;
  const pos = opts.pos || { x: 0, y: 0, z: BALL_R };
  const g = rng ? () => gaussian(rng) : () => 0;
  const power = clamp(swing && Number.isFinite(swing.power) ? swing.power : 1, 0, MAX_POWER);

  if (c.kind === 'putter') {
    const range = opts.puttRange || PUTT_RANGES[2];
    const D = power * range;
    const nSpeed = g();
    const nDir = g();
    const v = puttSpeedForDistance(D, SURFACES[SURF.GREEN]) * Math.max(0, 1 + PUTT_SIGMA_SPEED * nSpeed);
    const launch = makeLaunch({
      pos,
      aimYaw,
      ballSpeed: v,
      startDirDeg: (swing.startDir || 0) + PUTT_SIGMA_DIR * nDir,
      club: c,
      mode: 'roll',
    });
    Object.assign(launch.meta, { power, puttDistance: D, puttRange: range, faceDeg: launch.meta.startDirDeg, pathDeg: launch.meta.startDirDeg });
    return launch;
  }

  const over = power > 1 || !!swing.overswing;
  const disp = over ? 2 : 1;
  const k = dPlane(c, 1, 0).startDirDeg; // start = path + k x (face - path)
  const sDir = SIGMA_DIR * disp + (lie ? lie.factors.sdir : 0);
  const sFace = SIGMA_FACE * disp + (swing.tempo === 'rushed' ? RUSHED_FACE * (0.5 + 0.5 * clamp(swing.tempoErr ?? 1, 0, 1)) : 0);
  const sSpeed = SIGMA_SPEED * disp;
  const nDir = g();
  const nFace = g();
  const nSpeed = g();
  // A face error moves the start direction by k of itself and the curve by all of it; a path
  // (direction) error moves both face and path, so only the start direction.
  const faceErr = nFace * sFace;
  const faceToPath = (swing.faceToPath || 0) + faceErr;
  const startDir = (swing.startDir || 0) + nDir * sDir + k * faceErr;
  const speedFactor = (0.15 + 0.85 * power) * Math.max(0.5, 1 + nSpeed * sSpeed) * (swing.tempo === 'decel' ? DECEL_SPEED : 1);
  const p = applyLie({ ballSpeed: c.ballSpeed * speedFactor, ...partialSwing(c, power, speedFactor), startDirDeg: startDir }, lie, c);
  const pathDeg = p.startDirDeg - k * faceToPath;
  const faceDeg = pathDeg + faceToPath;
  const d = dPlane(c, faceDeg, pathDeg);
  const launch = makeLaunch({
    pos,
    aimYaw,
    ballSpeed: Math.max(0, p.ballSpeed),
    launchDeg: Math.max(0, p.launchDeg),
    spinRpm: Math.max(0, p.spinRpm),
    tiltDeg: d.tiltDeg,
    startDirDeg: d.startDirDeg,
    club: c,
    mode: 'air',
  });
  Object.assign(launch.meta, { power, faceDeg, pathDeg, faceToPathDeg: faceToPath });
  return launch;
}
