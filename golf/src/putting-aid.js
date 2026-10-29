// Green-reading aids (pure, no DOM): the putt preview, the caddie's read, its words, the slope
// bands and the preview throttle (architecture.md section 8.9).
//
// - previewPutt: the error-free putt at the current aim and power, played on the live hole (its
//   terrain, green speed through lie.puttSurf, the wind) exactly as Game#swing plays it, minus the
//   contact scatter: swingToLaunch with no rng, then simulateShot. So the line is the real putt.
// - PuttReader / readPutt: the caddie's read. A fixed-point search (with a secant step once it has
//   two points) on the aim and the flat-roll pace F, measured on the hole with the cup covered
//   (simulateShot {cup: null}) so a putt that would drop still shows where its pace takes it,
//   then checked with the real cup. The pace finishes `past` m beyond the hole (0.4: firm enough
//   to hold its line, the pace good putters aim for). PuttReader runs one simulation per step(),
//   so main.js spreads a read over frames (at most one simulation per frame with the preview).
// - readText: "Breaks ~9 in R→L", "Uphill 8 in", "Plays 21 ft", "Aim 2 cups right" (the break is
//   the aim's offset at the hole, so the two always agree).
// - slopeAt / slopeBand / SLOPE_COLORS: steepness in percent and its colour band.
// - PreviewThrottle: when to run the next preview simulation as the aim or the power moves.
//
// Conventions: yaw CCW from +x; "right" is the player's right facing the hole (dir × ẑ). A path
// is simulateShot's Float32Array [t, x, y, z]* (ball centre).

import { simulateShot } from './physics.js';
import { swingToLaunch, PUTT_RANGES } from './swing.js';
import { clubById, PUTTER_ID } from './clubs.js';
import { CUP_R, mToFt } from './constants.js';
import { MAX_POWER } from './input.js';
import { normalizeAngle } from './vec3.js';

export const AID_LEVELS = ['auto', 'full', 'partial', 'off'];
export const READ_PAST = 0.4; // m: the caddie's pace finishes this far past the hole
export const SLOPE_BANDS = [1, 2.5, 4]; // percent: green < 1 <= yellow < 2.5 <= orange < 4 <= red
export const SLOPE_COLORS = ['#3ddc84', '#ffd23f', '#ff9a3c', '#ff4d4d'];
export const SLOPE_COLORS_LIN = [
  [0.24, 0.86, 0.52],
  [1.0, 0.82, 0.25],
  [1.0, 0.6, 0.24],
  [1.0, 0.3, 0.3],
];
const PUTTER = clubById(PUTTER_ID);
const CUP_D = 2 * CUP_R; // one "cup" of aim

// Preview level from the setting ('auto' | 'full' | 'partial' | 'off') and the difficulty:
// auto is full on Easy, partial (the first part of the roll) on Normal and off on Pro.
export function aidLevel(setting, difficulty) {
  if (setting === 'full' || setting === 'partial' || setting === 'off') return setting;
  return difficulty === 'easy' ? 'full' : difficulty === 'pro' ? 'off' : 'partial';
}

// The error-free putt at this aim and power (power × puttRange = flat-roll metres).
// opts: {ball (centre), lie (lieAt: carries the green speed), aimYaw, power, puttRange, wind, seed,
// cup (simulateShot's option; default the hole's cup)}. Returns {path, final, holed, t, result}.
export function previewPutt(terrain, { ball, lie, aimYaw, power, puttRange, wind = null, seed = 1, cup } = {}) {
  const sw = { ok: true, kind: 'putt', power, startDir: 0, faceToPath: 0, tempo: 'smooth' };
  const launch = swingToLaunch(PUTTER, lie, sw, aimYaw, null, { pos: ball, puttRange });
  const opts = { wind: wind || undefined, seed };
  if (cup !== undefined) opts.cup = cup;
  const r = simulateShot(terrain, launch, opts);
  return { path: r.path, final: r.final, holed: r.final.outcome === 'holed', t: r.t, result: r };
}

// The error-free chip / pitch at this aim and power on the real hole (the game's own launch with
// no contact scatter). Returns {path, landing, landIndex (first sample at or after touchdown),
// final, holed}.
export function previewShot(terrain, { ball, lie, clubId, aimYaw, power = 1, wind = null, shot = 'normal', handed = 'R', seed = 1 } = {}) {
  const sw = { ok: true, kind: 'full', power, startDir: 0, faceToPath: 0, tempo: 'smooth' };
  const launch = swingToLaunch(clubById(clubId), lie, sw, aimYaw, null, { pos: ball, shot, handed });
  const r = simulateShot(terrain, launch, { wind: wind || undefined, seed });
  const land = r.events.find((e) => e.type === 'land');
  let landIndex = 0;
  if (land) {
    const n = r.path.length / 4;
    while (landIndex < n - 1 && r.path[landIndex * 4] < land.t) landIndex++;
  }
  return { path: r.path, landing: r.landing, landIndex, final: r.final, holed: r.final.outcome === 'holed', result: r };
}

// Where a path passes the cup: the closest approach (segment-interpolated) and, from it, the
// signed miss across the direction of travel (lat, + = passes right of the hole) and the pace
// (past: path length from there to the rest, or minus the distance still short when it stops
// first). i is the index of the sample at or before the closest point.
export function passAt(path, cup) {
  const n = path.length / 4;
  let best = Infinity;
  let bi = 0;
  let bx = path[1];
  let by = path[2];
  let bf = 0;
  for (let i = 0; i < n - 1; i++) {
    const x0 = path[i * 4 + 1];
    const y0 = path[i * 4 + 2];
    const dx = path[i * 4 + 5] - x0;
    const dy = path[i * 4 + 6] - y0;
    const l2 = dx * dx + dy * dy;
    let f = l2 > 1e-12 ? ((cup.x - x0) * dx + (cup.y - y0) * dy) / l2 : 0;
    f = f < 0 ? 0 : f > 1 ? 1 : f;
    const x = x0 + dx * f;
    const y = y0 + dy * f;
    const d = Math.hypot(x - cup.x, y - cup.y);
    if (d < best) {
      best = d;
      bi = i;
      bx = x;
      by = y;
      bf = f;
    }
  }
  // Travel direction at the closest point (a few samples either side: the last step can be tiny).
  const j0 = Math.max(0, bi - 3);
  const j1 = Math.min(n - 1, bi + 4);
  let tx = path[j1 * 4 + 1] - path[j0 * 4 + 1];
  let ty = path[j1 * 4 + 2] - path[j0 * 4 + 2];
  const tl = Math.hypot(tx, ty) || 1;
  tx /= tl;
  ty /= tl;
  const lat = (bx - cup.x) * ty - (by - cup.y) * tx; // (P - cup) · right, right = (ty, -tx)
  const atEnd = bi >= n - 2 && bf >= 0.999;
  let past;
  if (atEnd) {
    past = (bx - cup.x) * tx + (by - cup.y) * ty; // <= 0: still short of the hole
  } else {
    past = (1 - bf) * Math.hypot(path[bi * 4 + 5] - path[bi * 4 + 1], path[bi * 4 + 6] - path[bi * 4 + 2]);
    for (let i = bi + 1; i < n - 1; i++) past += Math.hypot(path[i * 4 + 5] - path[i * 4 + 1], path[i * 4 + 6] - path[i * 4 + 2]);
  }
  return { dist: best, lat, past, i: bi, x: bx, y: by };
}

// Where a path crosses the hole's line (through the cup, square to the chord ball -> cup): the
// miss along it (lat, + = right of the hole seen from the ball) and the pace (past: path length
// from the crossing to the rest; when it never gets there, minus how far short it stops).
export function crossAt(path, ball, cup) {
  const n = path.length / 4;
  const d = Math.hypot(cup.x - ball.x, cup.y - ball.y) || 1;
  const ux = (cup.x - ball.x) / d;
  const uy = (cup.y - ball.y) / d;
  const along = (i) => (path[i * 4 + 1] - ball.x) * ux + (path[i * 4 + 2] - ball.y) * uy;
  for (let i = 0; i < n - 1; i++) {
    const s0 = along(i);
    const s1 = along(i + 1);
    if (s0 < d && s1 >= d) {
      const f = (d - s0) / (s1 - s0 || 1);
      const x = path[i * 4 + 1] + (path[i * 4 + 5] - path[i * 4 + 1]) * f;
      const y = path[i * 4 + 2] + (path[i * 4 + 6] - path[i * 4 + 2]) * f;
      let past = (1 - f) * Math.hypot(path[i * 4 + 5] - path[i * 4 + 1], path[i * 4 + 6] - path[i * 4 + 2]);
      for (let k = i + 1; k < n - 1; k++) past += Math.hypot(path[k * 4 + 5] - path[k * 4 + 1], path[k * 4 + 6] - path[k * 4 + 2]);
      return { lat: (x - cup.x) * uy - (y - cup.y) * ux, past, i, x, y };
    }
  }
  const j = n - 1;
  const x = path[j * 4 + 1];
  const y = path[j * 4 + 2];
  return { lat: (x - cup.x) * uy - (y - cup.y) * ux, past: along(j) - d, i: j, x, y };
}

// Largest signed distance of a path from the chord ball -> cup, up to the sample i (+ = right).
function bulge(path, ball, cup, iMax) {
  const d = Math.hypot(cup.x - ball.x, cup.y - ball.y) || 1;
  const ux = (cup.x - ball.x) / d;
  const uy = (cup.y - ball.y) / d;
  let m = 0;
  const n = Math.min(path.length / 4, iMax + 1);
  for (let i = 0; i < n; i++) {
    const l = (path[i * 4 + 1] - ball.x) * uy - (path[i * 4 + 2] - ball.y) * ux;
    if (Math.abs(l) > Math.abs(m)) m = l;
  }
  return m;
}

// The caddie's read, one simulation per step(): new PuttReader(terrain, ball, {lie, wind}); call
// step() until it returns true; .result then holds {aimYaw, F (flat-roll m), holed, path (the
// putt with the real cup), past (m past the hole, cup covered), breakLat (m, + = the line bulges
// right of the straight one: breaks right to left), aimOffset (m across at the hole, + = right),
// dz (m, cup minus ball ground), plays (flat-roll metres to the hole: F − past), slopeBall,
// slopeCup ({pct, downYaw}), d, sims}.
export class PuttReader {
  constructor(terrain, ball, { lie, wind = null, past = READ_PAST, maxIter = 12, seed = 1 } = {}) {
    this.terrain = terrain;
    this.ball = { x: ball.x, y: ball.y, z: ball.z };
    this.lie = lie;
    this.wind = wind;
    this.past = past;
    this.maxIter = maxIter;
    this.seed = seed;
    this.sims = 0;
    this.done = false;
    this.result = null;
    this._it = this._run();
  }

  // Runs one simulation; true once the read is complete.
  step() {
    if (this.done) return true;
    const r = this._it.next();
    if (r.done) {
      this.done = true;
      this.result = r.value;
    }
    return this.done;
  }

  _sim(yaw, F, cup) {
    this.sims++;
    // power 1 over a range of F: the flat-roll distance is exactly F.
    return previewPutt(this.terrain, { ball: this.ball, lie: this.lie, aimYaw: yaw, power: 1, puttRange: Math.max(0.05, F), wind: this.wind, seed: this.seed, cup });
  }

  *_run() {
    const t = this.terrain;
    const ball = this.ball;
    const cup = t.cup;
    const d = Math.hypot(cup.x - ball.x, cup.y - ball.y);
    const D = Math.max(0.5, d);
    const yaw0 = Math.atan2(cup.y - ball.y, cup.x - ball.x);
    const target = this.past;
    // Unknowns in metres: a = yaw·D (the aim moved across at the hole), F; errors: the miss across
    // the hole line and the pace error. Broyden's method from the flat-green Jacobian.
    let a = yaw0 * D;
    let F = d + target;
    let J = [-1, 0, 0, 1]; // d(lat)/da, d(lat)/dF, d(pace)/da, d(pace)/dF
    let prev = null;
    let best = null;
    const score = (m) => Math.abs(m.lat) / 0.012 + Math.abs(m.past - target) / 0.05;
    for (let it = 0; it < this.maxIter; it++) {
      const yaw = a / D;
      const pv = this._sim(yaw, F, null);
      const m = crossAt(pv.path, ball, cup);
      yield;
      const cand = { yaw, F, a, m, path: pv.path, sc: score(m) };
      if (!best || cand.sc < best.sc) best = cand;
      if (cand.sc <= 1.2) break;
      const e0 = m.lat;
      const e1 = m.past - target;
      if (prev) {
        const dx0 = a - prev.a;
        const dx1 = F - prev.F;
        const n2 = dx0 * dx0 + dx1 * dx1;
        if (n2 > 1e-10) {
          const r0 = e0 - prev.e0 - (J[0] * dx0 + J[1] * dx1);
          const r1 = e1 - prev.e1 - (J[2] * dx0 + J[3] * dx1);
          J = [J[0] + (r0 * dx0) / n2, J[1] + (r0 * dx1) / n2, J[2] + (r1 * dx0) / n2, J[3] + (r1 * dx1) / n2];
        }
      }
      const det = J[0] * J[3] - J[1] * J[2];
      let s0;
      let s1;
      if (Math.abs(det) > 1e-6) {
        s0 = -(J[3] * e0 - J[1] * e1) / det;
        s1 = -(-J[2] * e0 + J[0] * e1) / det;
      } else {
        J = [-1, 0, 0, 1];
        s0 = e0;
        s1 = -e1;
      }
      // A step that would undo progress (worse than the best so far) is halved from the best.
      prev = { a, F, e0, e1 };
      if (cand.sc > best.sc * 2 && cand !== best) {
        a = best.a + 0.5 * (a - best.a);
        F = best.F + 0.5 * (F - best.F);
        prev = null;
        J = [-1, 0, 0, 1];
        continue;
      }
      const lim = 0.25 * D;
      a += Math.max(-lim, Math.min(lim, 0.95 * s0));
      F = Math.max(0.1, F + Math.max(-0.45 * F, Math.min(0.6 * F + 1, 0.95 * s1)));
    }
    // Check the best line with the real hole; if it does not drop, try a small ring around it.
    let pv = this._sim(best.yaw, best.F, undefined);
    yield;
    let aim = { yaw: best.yaw, F: best.F, pv };
    if (!pv.holed) {
      const tries = [];
      for (const dy of [0.5, -0.5, 1, -1, 2, -2]) for (const kf of [1, 0.96, 1.04]) tries.push([dy, kf]);
      for (const [dy, kf] of tries) {
        const y = best.yaw + dy * (Math.PI / 180);
        const f = best.F * kf;
        const q = this._sim(y, f, undefined);
        yield;
        if (q.holed) {
          aim = { yaw: y, F: f, pv: q };
          break;
        }
      }
    }
    const pass = crossAt(best.path, ball, cup);
    const dz = t.heightAt(cup.x, cup.y) - t.heightAt(ball.x, ball.y);
    const delta = normalizeAngle(aim.yaw - yaw0);
    return {
      aimYaw: normalizeAngle(aim.yaw),
      F: aim.F,
      holed: aim.pv.holed,
      path: aim.pv.path,
      past: best.m.past,
      breakLat: bulge(best.path, ball, cup, pass.i),
      aimOffset: -d * Math.tan(delta),
      dz,
      plays: Math.max(0, aim.F - best.m.past),
      slopeBall: slopeAt(t, ball.x, ball.y),
      slopeCup: slopeAt(t, cup.x, cup.y),
      d,
      sims: this.sims,
    };
  }
}

// The whole read at once (tests, tools). opts as PuttReader.
export function readPutt(terrain, ball, opts = {}) {
  const r = new PuttReader(terrain, ball, opts);
  while (!r.step());
  return r.result;
}

// The notch power for a read at this putt range (null if it needs more than MAX_POWER).
export function puttNotchPower(read, puttRange) {
  if (!read || !(puttRange > 0)) return null;
  const p = read.F / puttRange;
  return p <= MAX_POWER ? p : null;
}

// The putt range that fits a read's pace (the first with F/range <= 0.85; the longest otherwise).
export function rangeForRead(F) {
  for (const r of PUTT_RANGES) if (F / r <= 0.85) return r;
  return PUTT_RANGES[PUTT_RANGES.length - 1];
}

// Steepness at (x, y): {pct, downYaw} (percent grade and the yaw that runs straight downhill).
export function slopeAt(terrain, x, y, out = { pct: 0, downYaw: 0 }) {
  const g = terrain.gradAt(x, y);
  out.pct = Math.hypot(g.x, g.y) * 100;
  out.downYaw = Math.atan2(-g.y, -g.x);
  return out;
}

// Colour band of a slope in percent: 0 green (< 1), 1 yellow (< 2.5), 2 orange (< 4), 3 red.
export function slopeBand(pct) {
  return pct < SLOPE_BANDS[0] ? 0 : pct < SLOPE_BANDS[1] ? 1 : pct < SLOPE_BANDS[2] ? 2 : 3;
}

// ------------------------------------------------------------------ words
const half = (x) => Math.round(x * 2) / 2;
const halves = (x) => {
  const w = Math.floor(x);
  const h = x - w >= 0.5;
  return `${w > 0 ? w : ''}${h ? '½' : ''}` || '0';
};

// A small length in the putt units: yards mode -> in / ft, metres -> cm / m.
export function fmtSmall(m, units) {
  const a = Math.abs(m);
  if (units === 'm') {
    if (a < 1) return `${Math.max(1, Math.round(a * 100))} cm`;
    return `${a < 10 ? a.toFixed(1) : Math.round(a)} m`;
  }
  const inches = a * 39.3701;
  if (inches < 11.5) return `${Math.max(1, Math.round(inches))} in`;
  const ft = mToFt(a);
  return ft < 4 ? `${halves(half(ft))} ft` : `${Math.round(ft)} ft`;
}

// A putt length in the putt units (feet in yards mode, metres otherwise).
export function fmtPuttLen(m, units) {
  if (units === 'm') return `${m < 10 ? m.toFixed(1) : Math.round(m)} m`;
  return `${Math.round(mToFt(m))} ft`;
}

// The read in words. units 'yd' | 'm'; opts.showAim false (Pro) leaves out the break and the aim.
// Returns {breakText, slopeText, playsText, aimText, line1, line2}.
// The break is told as the aim: how far outside the hole to start it (aimOffset), the number a
// golfer means by "breaks 6 in" (breakLat, the line's widest bulge, is smaller and is not shown).
// "Straight" exactly when the aim rounds to the hole.
export function readText(read, units = 'yd', { showAim = true } = {}) {
  const ao = read.aimOffset;
  const cups = Math.abs(ao) / CUP_D;
  const straight = cups < 0.25;
  const breakText = straight ? 'Straight' : `Breaks ~${fmtSmall(ao, units)} ${ao > 0 ? 'R→L' : 'L→R'}`;
  const dz = read.dz;
  const slopeText = Math.abs(dz) < 0.015 ? 'Level' : `${dz > 0 ? 'Uphill' : 'Downhill'} ${fmtSmall(dz, units)}`;
  const playsText = `Plays ${fmtPuttLen(read.plays, units)}`;
  const side = ao > 0 ? 'right' : 'left';
  let aimText;
  if (straight) aimText = 'Aim at the hole';
  else if (cups <= 6) {
    const c = Math.max(0.5, half(cups));
    aimText = `Aim ${halves(c)} cup${c > 1 ? 's' : ''} ${side}`;
  } else aimText = `Aim ${fmtSmall(read.aimOffset, units)} ${side}`;
  const slopeWord = Math.abs(dz) < 0.015 ? 'Level' : dz > 0 ? 'Uphill' : 'Downhill';
  const line1 = showAim ? `${breakText} · ${slopeWord}, ${playsText.toLowerCase()}` : `${slopeText} · ${playsText}`;
  const line2 = showAim ? aimText : '';
  return { breakText, slopeText, playsText, aimText, line1, line2 };
}

// ------------------------------------------------------------------ preview line
// How much of a preview path to show (arc length, m): all of it ('full'), none ('off'), or for
// 'partial' up to where the putt breaks most (its furthest point from the start -> rest chord,
// when that is 3 cm or more), kept within 40-65% of the roll; half the roll for a straight putt.
export function visibleEnd(path, level) {
  if (level === 'off') return 0;
  const n = path.length / 4;
  if (level === 'full' || n < 2) return Infinity;
  const x0 = path[1];
  const y0 = path[2];
  const x1 = path[(n - 1) * 4 + 1];
  const y1 = path[(n - 1) * 4 + 2];
  const cl = Math.hypot(x1 - x0, y1 - y0) || 1;
  const ux = (x1 - x0) / cl;
  const uy = (y1 - y0) / cl;
  let L = 0;
  let sApex = 0;
  let mApex = 0;
  for (let i = 1; i < n; i++) {
    L += Math.hypot(path[i * 4 + 1] - path[i * 4 - 3], path[i * 4 + 2] - path[i * 4 - 2]);
    const lat = Math.abs((path[i * 4 + 1] - x0) * uy - (path[i * 4 + 2] - y0) * ux);
    if (lat > mApex) {
      mApex = lat;
      sApex = L;
    }
  }
  if (mApex < 0.03) return 0.5 * L;
  return Math.min(0.65 * L, Math.max(0.4 * L, sApex));
}

// Drapes a path's samples on the ground into out = [x, y, z]* up to arc length maxLen (the last
// point interpolated), skipping samples closer than minStep to the last one kept. Allocation free.
// Returns the point count.
export function drapePath(terrain, path, maxLen, out, { lift = 0.012, minStep = 0.1, from = 0 } = {}) {
  const n = path.length / 4;
  const cap = (out.length / 3) | 0;
  if (n - from < 2 || cap < 2 || !(maxLen > 0)) return 0;
  let c = 0;
  let L = 0;
  let px = path[from * 4 + 1];
  let py = path[from * 4 + 2];
  let kx = px;
  let ky = py;
  const put = (x, y) => {
    out[c * 3] = x;
    out[c * 3 + 1] = y;
    out[c * 3 + 2] = terrain.heightAt(x, y) + lift;
    c++;
  };
  put(px, py);
  for (let i = from + 1; i < n && c < cap; i++) {
    const x = path[i * 4 + 1];
    const y = path[i * 4 + 2];
    const s = Math.hypot(x - px, y - py);
    if (L + s >= maxLen) {
      const f = s > 0 ? (maxLen - L) / s : 0;
      put(px + (x - px) * f, py + (y - py) * f);
      return c;
    }
    L += s;
    px = x;
    py = y;
    if (Math.hypot(x - kx, y - ky) >= minStep || i === n - 1) {
      put(x, y);
      kx = x;
      ky = y;
    }
  }
  return c;
}

// ------------------------------------------------------------------ throttle
// When to run the next preview simulation for a changing key (aim, power, range): a new key runs
// at once if the last run is at least `interval` s old, otherwise it waits; while the key keeps
// changing, at most one run per interval; once it has been still for `settle` s, one last exact
// run. The same key never runs twice in a row. now in seconds.
export class PreviewThrottle {
  constructor({ interval = 0.15, settle = 0.08 } = {}) {
    this.interval = interval;
    this.settle = settle;
    this.lastKey = null;
    this.lastRunT = -Infinity;
    this.pendingKey = null;
    this.changedT = 0;
    this.runs = 0;
  }

  want(key, now) {
    if (key === this.lastKey) return false;
    if (key !== this.pendingKey) {
      this.pendingKey = key;
      this.changedT = now;
    }
    if (now - this.lastRunT >= this.interval || now - this.changedT >= this.settle) {
      this.lastKey = key;
      this.lastRunT = now;
      this.runs++;
      return true;
    }
    return false;
  }

  reset() {
    this.lastKey = null;
    this.pendingKey = null;
    this.lastRunT = -Infinity;
  }
}
