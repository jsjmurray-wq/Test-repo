// Swing interpretation (touch trace -> swing parameters) and launch construction (swing + club +
// lie -> Launch for physics). Pure module (docs/architecture.md sections 4 and 8.1).
//
//   interpretSwing(samples, {padRefH, kind:'full'|'putt', difficulty, handed, club?, target?,
//                            padRect?}) -> SwingResult
//   swingToLaunch(club, lie, swing, aimYaw, rng, {pos, puttRange, shot, handed}) -> Launch
//   powerForDistance(distAt, dist, maxPower = 1) -> power | null   (inverts a power curve)
//
// samples: [{t (ms), x, y (CSS px)}] for one pointer, pointerdown to pointerup, exactly as
// input.js records them. The touchdown y is the start of the swing; power comes from the deepest
// point below it through input.js powerFromDepth: the same travel (fullPowerPx), full-power detent
// and overswing as the live gauge. opts.target is the target-notch power: on Easy a power within
// EASY_SNAP of it snaps onto it (input.js snapPower, as the live gauge does). opts.padRect turns
// on the drag-out cancel (input.js draggedOut; the live input applies it as well).
//
// SwingResult = {ok, reason?:'cancel'|'short', kind, power, overswing, startDir, faceToPath, face,
//                path, tempo:'smooth'|'rushed'|'decel', tempoErr, label}
//   startDir, faceToPath, face, path are degrees, + = RIGHT of the aim line (screen right is
//   the golfer's right: the camera looks down the aim line). faceToPath > 0 curves the ball
//   right (a fade or slice for a right-hander). Full swings also report strike ('climb' |
//   'release'), alpha / kappa (raw deg), downswingS and upSpeed (px/s).
//
// Full swing gesture. A thumb on a phone flicks short, often starts slowly, pauses at the bottom
// and lifts off before it gets back to where it started, so recognition is forgiving:
//   1. Drag down from the touchdown point (backswing); the deepest point sets the power.
//   2. Swipe back up. It strikes when, after the bottom of the backswing, the finger has climbed
//      at least max(STRIKE_CLIMB_PX, STRIKE_CLIMB_FRAC x depth) and has not slid back down to the
//      bottom by the release (strike 'climb'), or when it is lifted while still moving up at
//      RELEASE_SPEED px/s or more over the last RELEASE_WINDOW_MS (strike 'release': a short
//      flick). It never needs to get back to the touchdown line. A clear climb whose first part
//      averaged under STRIKE_SPEED px/s still strikes, with tempo 'decel'.
//      Not a stroke: released at the bottom with no real upward move ('cancel', e.g. a hold then
//      lift, or a few px of wobble), dragged out of the pad sideways during the backswing
//      ('cancel', with opts.padRect), or a press with almost no backswing ('short').
//   3. The chord from the bottom of the backswing to the release point sets the start direction;
//      the bend of the upswing (heading of the last 40% of its length minus that of the first
//      60%) sets the face-to-path, i.e. the curve. Gains and dead zones depend on difficulty;
//      left-handed play flips the sign of the bend.
//   4. Tempo: the upswing speed v is the climb from the bottom of the final upswing to the
//      touchdown line (or to the top of the upswing when it stops short) over the time since the
//      finger started up. A still pause at the bottom fires no touch events, so that start is
//      extrapolated back from the first samples that leave the bottom. The downswing is timed as
//      if the travel were TEMPO_REF_PX at full power, T = power x TEMPO_REF_PX / v, against the
//      ideal 0.10 + 0.15 x power s: under RUSHED_FRAC of it is 'rushed' (extra face scatter growing
//      from half to all of RUSHED_FACE the quicker it is, tempoErr 0..1; a snap faster than about
//      3300 px/s at full power, 2400 px/s at half power). A climb whose first max(24 px, 25%)
//      averaged under STRIKE_SPEED px/s (a slow return, or creeping up before a flick) is 'decel'
//      (ball speed x DECEL_SPEED). Everything between is 'smooth'.
//
// Putt gesture: drag down to set the pace (power = depth / the putt travel, maps to a flat-roll
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
import { applyShot } from './shots.js';
import { MAX_POWER, powerFromDepth, snapPower, draggedOut, swingSetPoint, swingTravel } from './input.js';

// Difficulty: start-direction gain G_s and curve gain G_c (output deg per input deg) and their
// dead zones on the chord angle (dzA) and the bend (dzK), in degrees.
export const DIFFICULTY = {
  easy: { gs: 0.15, gc: 0.05, dzA: 4, dzK: 8 },
  normal: { gs: 0.25, gc: 0.08, dzA: 2, dzK: 4 },
  pro: { gs: 0.35, gc: 0.12, dzA: 0, dzK: 0 },
};

// Strike recognition (full swing), section 8.1.
export const STRIKE_CLIMB_PX = 24; // the climb after the bottom that strikes...
export const STRIKE_CLIMB_FRAC = 0.25; // ...or this fraction of the backswing depth, if more...
export const STRIKE_CLIMB_MAX = 32; // ...but never more than this (a short flick off a deep backswing)
export const STRIKE_SPEED = 120; // px/s: a climb averaging less than this strikes as 'decel'
export const RELEASE_SPEED = 150; // px/s: lifted while moving up this fast strikes...
export const RELEASE_WINDOW_MS = 80; // ...measured over this window before the release
const MIN_FLICK_PX = 10; // a release strike needs this much climb (not a wobble at the bottom)
const HOLD_FRAC = 0.5; // a climb strike must still be this fraction of the climb threshold up at release
const MIN_WINDOW_MS = 16; // floor of the release-speed window (one 60 Hz frame)
const TEMPO_REF_PX = 150; // nominal full-power travel the downswing is timed over (see tempo)
export const MAX_START_DIR = 10; // deg
export const MAX_FACE_TO_PATH = 8; // deg
export const PUTT_RANGES = [3, 6, 9, 12, 18, 24, 30]; // m, flat-roll distance at power 1
const MIN_DEPTH_PX = 8; // shallower presses are taps, not swings
const BOTTOM_TOL_PX = 3; // jitter allowed while the finger rests at the bottom
const PUTT_DRIFT_MS = 150;
const PUTT_DRIFT_GAIN = 0.08; // deg per px of sideways drift
const PUTT_MAX_DIR = 3; // deg
const PUTT_CANCEL_FRAC = 0.25; // a putt brought back within 25% of its depth of the line cancels
const PUTT_THROUGH_PX = 12; // ...unless it flicks this far through the line (a flick stroke)
const PUTT_SIDE_CANCEL_PX = 60; // a putt dragged this far sideways is abandoned, not struck
export const PUTT_MIN_DEPTH_PX = 20; // shallower putt presses are slips, not strokes
export const RUSHED_FRAC = 0.18; // downswing under this fraction of the ideal is rushed
export const DECEL_FRAC = 2; // (version 1 tempo: over this multiple was decelerating; kept for reference)

// Random contact (deg, fraction): the scatter of a good amateur's strike. Overswing doubles it.
export const SIGMA_DIR = 0.6; // start direction, plus the lie's sdir
export const SIGMA_FACE = 0.4; // face (curve) scatter of a normal swing
export const SIGMA_SPEED = 0.015;
export const RUSHED_FACE = 0.6; // extra face sigma (max) for a rushed tempo
export const DECEL_SPEED = 0.95; // ball speed of a decelerating (slow) swing
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

// Time (ms) at which the trace, climbing from sample b to sample e, first gets up to level y
// (interpolated); the time of e if it never does.
function timeAtLevel(S, b, e, y) {
  for (let i = b + 1; i <= e; i++) {
    if (S[i].y <= y) {
      const p = S[i - 1];
      const q = S[i];
      const f = p.y > q.y ? (p.y - y) / (p.y - q.y) : 1;
      return p.t + (q.t - p.t) * f;
    }
  }
  return S[e].t;
}

// Bottom of the upward run that ends at sample `top`: walk back through samples no higher than
// the run (BOTTOM_TOL_PX of jitter allowed, so a still pause at the bottom belongs to it). Returns
// b, the last sample still at the bottom (where the move up starts, for timing and the chord),
// and level, the lowest y of the run (what climbs are measured from: the first sample of a flick
// may already be a few px up).
function runBottom(S, top) {
  let i0 = top;
  let level = S[top].y;
  while (i0 > 0 && S[i0 - 1].y >= level - BOTTOM_TOL_PX) {
    i0--;
    if (S[i0].y > level) level = S[i0].y;
  }
  let b = i0;
  for (let i = i0; i <= top; i++) if (S[i].y >= level - BOTTOM_TOL_PX) b = i;
  return { b, level };
}

// Inverse of a monotone power -> distance function (e.g. the caddie power curve through
// curveAt): the power in [0, maxPower] whose distance is dist, by bisection; null when even
// maxPower falls short. main.js uses it for the target notch on the power arc.
export function powerForDistance(distAt, dist, maxPower = 1) {
  if (!(dist > 0)) return 0;
  if (!(distAt(maxPower) >= dist)) return null;
  let lo = 0;
  let hi = maxPower;
  for (let i = 0; i < 40; i++) {
    const m = (lo + hi) / 2;
    if (distAt(m) < dist) lo = m;
    else hi = m;
  }
  return (lo + hi) / 2;
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
  // The set point (input.js swingSetPoint): the bottom of the backswing, dialled back by a slow
  // ease up, exactly as the live gauge reads it; the swing is read from there on. The travel
  // shrinks for a swing started low in the pad (swingTravel), as on the gauge.
  const set = swingSetPoint(S, kind !== 'putt');
  const depth = set.y - y0;
  const travel = swingTravel(H, kind, y0, opts.padRect || null);
  const power = snapPower(powerFromDepth(depth, H, kind, travel), opts.target, opts.difficulty);
  if (depth < (kind === 'putt' ? PUTT_MIN_DEPTH_PX : MIN_DEPTH_PX)) return failed(kind, 'short', power);
  if (opts.padRect && draggedOut(S, opts.padRect)) return failed(kind, 'cancel', power);
  const T = set.i > 0 && kind !== 'putt' ? [S[0], ...S.slice(set.i)] : S;
  return kind === 'putt' ? interpretPutt(T, y0, depth, power, diff, opts) : interpretFull(T, y0, depth, power, diff, opts);
}

function interpretFull(S, y0, depth, power, diff, opts) {
  const n = S.length;
  const end = S[n - 1];
  let iMax = 0;
  for (let i = 1; i < n; i++) if (S[i].y > S[iMax].y) iMax = i;
  const thr = Math.min(STRIKE_CLIMB_MAX, Math.max(STRIKE_CLIMB_PX, STRIKE_CLIMB_FRAC * depth));

  // Strike 'climb': the highest point after the bottom of the backswing is at least thr above the
  // bottom of its upward run, and the finger has not slid back down to the bottom by the release
  // (a waggle that ends at the bottom is not a swing).
  let top = iMax;
  for (let i = iMax + 1; i < n; i++) if (S[i].y < S[top].y) top = i;
  let { b, level } = runBottom(S, top);
  let runEnd = top;
  let strike = null;
  if (level - S[top].y >= thr && level - end.y >= HOLD_FRAC * thr) {
    strike = 'climb';
  } else {
    // Strike 'release': a short flick, lifted while still moving up briskly. The speed window
    // starts no earlier than the moment the finger left the bottom, so a pause there (no touch
    // events) does not dilute it, and needs MIN_FLICK_PX of climb, so jitter cannot fake it.
    const re = runBottom(S, n - 1);
    if (re.level - end.y >= MIN_FLICK_PX) {
      const ta = Math.max(end.t - RELEASE_WINDOW_MS, moveStart(S, re.b, end.t, end.y));
      const ya = ta <= S[re.b].t ? re.level : sampleAt(S, ta).y;
      const v = ((ya - end.y) / Math.max(MIN_WINDOW_MS, end.t - ta)) * 1000;
      if (v >= RELEASE_SPEED) {
        strike = 'release';
        ({ b, level } = re);
        runEnd = n - 1;
      }
    }
  }
  // Held at the bottom and lifted, a few px of wobble, or slid back down: no swing.
  if (!strike) return failed('full', 'cancel', power);

  // Strike point for the tempo: where the upswing gets back to the touchdown line, else the top
  // of the upswing (released short of the line).
  const bottom = S[b];
  let ts = timeAtLevel(S, b, runEnd, y0);
  let ys = y0;
  if (S[runEnd].y > y0) {
    ts = S[runEnd].t;
    ys = S[runEnd].y;
  }
  const tm = moveStart(S, b, ts, ys);
  const climbed = Math.max(0, level - ys);
  const T = Math.max(0, ts - tm) / 1000;
  const upSpeed = climbed / Math.max(T, 1e-3);
  // Average speed over the first thr px of the climb (the whole climb for a short release flick).
  const tThr = climbed >= thr ? timeAtLevel(S, b, runEnd, level - thr) : ts;
  const climbSpeed = Math.min(climbed, thr) / Math.max((tThr - tm) / 1000, 1e-3);
  const ideal = 0.1 + 0.15 * power;
  const Teq = (power * TEMPO_REF_PX) / Math.max(upSpeed, 1e-3);
  let tempoErr = 0;
  let tempo = 'smooth';
  if (climbSpeed < STRIKE_SPEED) tempo = 'decel';
  else if (Teq < RUSHED_FRAC * ideal) {
    tempo = 'rushed';
    tempoErr = 1 - Teq / (RUSHED_FRAC * ideal);
  }

  // Direction: chord from the bottom of the backswing to the release point.
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
    strike,
    alpha,
    kappa,
    downswingS: T,
    upSpeed,
  };
}

// Time (ms) the finger started up out of the bottom sample b, the strike being at (ts, ys). The
// first sample clearly above the bottom is traced back at the mean speed of the rest of the
// upswing, so a motionless pause (no events) or a coarse first sample does not count.
function moveStart(S, b, ts, ys) {
  const n = S.length;
  let u = b + 1;
  while (u < n && S[b].y - S[u].y <= BOTTOM_TOL_PX) u++;
  if (u >= n) return S[b].t;
  const q = S[u];
  const rest = q.y - ys;
  const dtRest = ts - q.t;
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
//   opts.shot       special shot id (shots.js, section 8.4; default 'normal'), applied after the lie
//                   and the partial-swing terms, before the D-plane: its path and face-to-path add
//                   to the swipe's own (and the contact scatter's)
//   opts.handed     'R' | 'L': a left-hander's draw and cut are mirrored
// Putts are paced on the hole's own green (lie.puttSurf: the course's green speed), so the putt
// gauge's flat-roll distance holds on fast and slow greens alike.
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
    const green = (lie && lie.puttSurf) || SURFACES[SURF.GREEN];
    const v = puttSpeedForDistance(D, green) * Math.max(0, 1 + PUTT_SIGMA_SPEED * nSpeed);
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
  const pl = applyLie({ ballSpeed: c.ballSpeed * speedFactor, ...partialSwing(c, power, speedFactor), startDirDeg: startDir }, lie, c);
  const shot = opts.shot || 'normal';
  const p = applyShot({ ...pl, faceToPathDeg: faceToPath }, shot, c, lie, { handed: opts.handed, power });
  const pathDeg = p.startDirDeg - k * p.faceToPathDeg;
  const faceDeg = pathDeg + p.faceToPathDeg;
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
  Object.assign(launch.meta, { power, faceDeg, pathDeg, faceToPathDeg: p.faceToPathDeg, shot });
  return launch;
}
