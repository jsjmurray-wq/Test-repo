// CPU opponent (docs/architecture.md "AI").
//
// planTurn() picks the shot for whoever is to move in a GameState:
//   1. Candidates. Ghost-ball pots for every legal target x pocket, using a "pocket window": the
//      range of object-ball directions that reach the pocket's capture circle without touching a
//      jaw nose, a jaw facing, the adjacent rails or another ball. Corridors cue -> ghost and
//      object -> pocket must be clear (no ball centre within 2R). Cuts beyond 80 degrees and side
//      pockets approached more than 60 degrees off their axis are rejected. When no good direct
//      pot exists, one-rail banks (object ball) and kicks (cue ball) are added by mirroring the
//      pocket / ghost ball across each rail's ball-centre line.
//   2. Pre-score. The chance that the level's aim error stays inside the pocket window, using the
//      exact ghost-ball sensitivity d(object direction)/d(cue aim). Cheap, so it is also how the
//      next shot (position play) and the opponent's chances are judged after a simulated shot.
//   3. Simulation. The best candidates (several speed tiers x stun/follow/draw, side spin at pro)
//      are probed once to compensate throw, then simulated K times with seeded aim/speed noise by
//      physics.simulateShot and judged by rules.evaluateShot:
//        score = P(keep turn) + wPos*position - P(foul) - wOpp*opponentBest*(1-P) - 2*P(lose rack)
//   4. Safety (hard/pro) when the best P < 0.35: soft legal-contact shots (full / half / thin hits,
//      one-rail kicks for hidden targets) that minimise the opponent's best pre-score.
//   5. Ball in hand: the cue ball is placed behind the ghost ball of the best target/pocket pairs
//      (validated by rules.validateCuePlacement, so the kitchen is respected). Break: from the
//      kitchen at y = +/-0.12, full on the apex ball at 8.5-9.3 m/s with a little draw.
//   The chosen shot gets one more noise sample: that is how the CPU misses.
//
// Pure module (no DOM, no Math.random). Deterministic for a given seed as long as the time budget
// is not hit. planTurn is async and yields every ~8 ms of work so the render loop keeps running.

import { AI_DT, MAX_TIP, MAX_SQUIRT_RAD, MU_SLIDE, MU_ROLL, G, E_BALL, shotSpeed, powerForSpeed } from './constants.js';
import { TABLE } from './table.js';
import { normalizeAngle } from './vec.js';
import { mulberry32, gaussian } from './rng.js';
import { traceAim } from './aim.js';
import { World, simulateShot } from './physics.js';
import {
  getShotRequirements,
  evaluateShot,
  applyOutcome,
  validateCuePlacement,
  nearestValidPlacement,
  defaultDecision,
} from './rules.js';

// Level table. aimSigmaDeg / speedSigma: 1-sigma execution error (degrees of cue aim, fraction of
// cue speed). candidates: shots simulated; samples: noisy simulations per candidate.
// position: 'none' | 'basic' | 'full' (how much the next shot counts and how many speed/spin
// variants are tried). safety: plays safe when nothing good is on. sideSpin: uses english.
export const LEVELS = Object.freeze({
  easy: Object.freeze({
    id: 'easy',
    aimSigmaDeg: 1.6,
    speedSigma: 0.15,
    candidates: 6,
    samples: 1,
    position: 'none',
    safety: false,
    sideSpin: false,
    breakSpeed: 8.5,
  }),
  medium: Object.freeze({
    id: 'medium',
    aimSigmaDeg: 0.7,
    speedSigma: 0.08,
    candidates: 14,
    samples: 2,
    position: 'basic',
    safety: false,
    sideSpin: false,
    breakSpeed: 8.8,
  }),
  hard: Object.freeze({
    id: 'hard',
    aimSigmaDeg: 0.3,
    speedSigma: 0.04,
    candidates: 28,
    samples: 3,
    position: 'full',
    safety: true,
    sideSpin: false,
    breakSpeed: 9.0,
  }),
  pro: Object.freeze({
    id: 'pro',
    aimSigmaDeg: 0.12,
    speedSigma: 0.02,
    candidates: 45,
    samples: 4,
    position: 'full',
    safety: true,
    sideSpin: true,
    breakSpeed: 9.3,
  }),
});

const LEVEL_ORDER = ['easy', 'medium', 'hard', 'pro'];

// ---- Tuning ----
const DEG = Math.PI / 180;
const MAX_SIMS = 250; // full simulations per planTurn (throw probes are extra and short)
const SLICE_MS = 8; // yield to the caller after this much work
const DEFAULT_BUDGET_MS = 2500;
const COS_MAX_CUT = Math.cos(80 * DEG);
const COS_MAX_CUT_KICK = Math.cos(70 * DEG);
const COS_SIDE_APPROACH = Math.cos(60 * DEG);
const SIGMA_REF = 0.5 * DEG; // aim error assumed when judging the next shot / the opponent's shot
const SIGMA_FLOOR = 0.15 * DEG; // unmodelled error (residual throw, cloth) added to every estimate
const WIN_N = 15; // directions sampled across a pocket's capture circle
const WIN_SPAN = 0.9; // ... out to this fraction of its radius
const GRAZE = 0.0015; // a path may graze a jaw or rail by this much (parallel contact is harmless)
const BANK_FACTOR = 0.6; // pre-score window shrink for one-rail banks
const KICK_FACTOR = 0.5; // ... and for kicks (the cue ball's rebound is less predictable)
const RAIL_KEEP = 0.8; // speed kept through a rail contact (speed model only)
const RAIL_MARGIN = 0.025; // bank / kick contact points stay this far from the jaws
const POCKET_CLEAR = 0.003; // a path within captureR + this of a pocket centre drops the ball
const DIRECT_GOOD = 0.15; // below this best direct pre-score, banks and kicks are considered
const SAFETY_P = 0.35;
const W_FOUL = 1.0;
const W_OPP = 0.4;
const W_OPP_SAFE = 0.9; // opponent weight once the CPU is considering a safety
const W_LOSS = 2.0;
const WIN_BONUS = 0.5;
const BIH_CUE_DIST = 0.3; // ball in hand is judged as a straight shot from this far behind the ghost
const V_CUE_MIN = 0.35; // m/s
const V_CUE_MAX = 7.5;
const SPEED_MARGIN = Object.freeze({ soft: 0.25, medium: 0.8, firm: 2.0 }); // extra object-ball travel (m)
const SPIN = Object.freeze({
  stun: Object.freeze({ x: 0, y: 0 }),
  follow: Object.freeze({ x: 0, y: 0.3 }),
  draw: Object.freeze({ x: 0, y: -0.35 }),
});
const SIDE_SPINS = Object.freeze([Object.freeze({ x: 0.25, y: 0.1 }), Object.freeze({ x: -0.25, y: 0.1 })]);
// Per position mode: first simulated variant per pair, breadth (pairs tried with that variant), and
// the full variant list explored for the most promising pairs.
const POSITION = Object.freeze({
  none: { weight: 0, oppWeight: 0.2, breadth: 6, speeds: ['medium'], spins: ['stun'] },
  basic: { weight: 0.3, oppWeight: W_OPP, breadth: 8, speeds: ['medium', 'soft'], spins: ['stun', 'follow', 'draw'] },
  full: {
    weight: 0.6,
    oppWeight: W_OPP,
    breadth: 12,
    speeds: ['medium', 'soft', 'firm'],
    spins: ['stun', 'follow', 'draw'],
  },
});
const SAFETY_CUTS = Object.freeze([0, 35, -35, 65, -65]); // degrees
const SAFETY_CONTACT_V = 0.75; // m/s cue-ball speed at contact for a safety
const SAFETY_MAX = Object.freeze({ hard: 24, pro: 32 });
const BREAK_Y = 0.12;
const BREAK_BACK = 0.04; // cue placed this far behind the head string for the break

// Cloth model used for speed selection (matches physics.js: sliding friction until natural roll,
// then rolling resistance).
const MUG = MU_SLIDE * G;
const ROLLG = MU_ROLL * G;
const TRANSFER = (1 + E_BALL) / 2; // object speed / cue normal speed in a ball-ball impact
// Distance an object ball (no spin) travels from speed v: slides to 5/7 v, then rolls out.
const TRAVEL_K = 6 / 24.5 / MUG + 25 / 49 / (2 * ROLLG);

// ---------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------

// The CPU's answer to an illegal-break / 8-on-the-break prompt.
export function chooseDecision(decision) {
  return defaultDecision(decision);
}

// Plan the turn for state.turn. Returns {place: {x,y} | null, shot: {angle, power, spin, call}, info}.
// A pending decision returns {place: null, shot: null, info: {kind: 'decision', decision}}.
export async function planTurn(state, opts = {}) {
  const env = makeEnv(state, opts);
  if (state.pendingDecision) {
    return { place: null, shot: null, info: { kind: 'decision', decision: chooseDecision(state.pendingDecision) } };
  }
  let result;
  if (state.isBreakShot) result = await planBreak(env, state);
  else {
    let place = null;
    let st = state;
    if (state.ballInHand) {
      place = choosePlacement(env, state);
      st = withCueAt(state, place);
      await env.tick();
    }
    result = await planShot(env, st);
    result.place = place;
  }
  const intended = result.shot;
  const shot = noisyShot(env, intended); // execution error of the final stroke
  const info = {
    ...result.info,
    level: env.lv.id,
    intended,
    sims: env.sims,
    probes: env.probes,
    evaluated: env.evaluated,
    budgetHit: env.budgetHit,
    elapsedMs: env.now() - env.t0,
  };
  return { place: result.place ? { x: result.place.x, y: result.place.y } : null, shot, info };
}

// ---------------------------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------------------------

function defaultNow() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
}

function defaultYield() {
  return new Promise((r) => setTimeout(r, 0));
}

function resolveLevel(level) {
  if (typeof level === 'string' && LEVELS[level]) return LEVELS[level];
  if (typeof level === 'number' && Number.isFinite(level)) {
    return LEVELS[LEVEL_ORDER[Math.max(0, Math.min(3, Math.round(level)))]];
  }
  if (level && typeof level === 'object') return { ...LEVELS.medium, ...level };
  return LEVELS.medium;
}

// A seed derived from the position, so planTurn is deterministic even without opts.seed.
function stateSeed(state) {
  let h = 0x811c9dc5 ^ (state.shotNo | 0);
  for (const b of state.balls) {
    if (!b || !b.on) continue;
    h = Math.imul(h ^ b.id, 0x01000193);
    h = Math.imul(h ^ Math.round(b.x * 1e5), 0x01000193);
    h = Math.imul(h ^ Math.round(b.y * 1e5), 0x01000193);
  }
  return h >>> 0;
}

function makeEnv(state, opts) {
  const table = opts.table || TABLE;
  const lv = resolveLevel(opts.level);
  const now = typeof opts.now === 'function' ? opts.now : defaultNow;
  const seed = Number.isFinite(opts.seed) ? opts.seed >>> 0 : stateSeed(state);
  const t0 = now();
  const env = {
    table,
    geo: plannerGeometry(table),
    lv,
    pos: POSITION[lv.position] || POSITION.basic,
    aimSigma: lv.aimSigmaDeg * DEG,
    speedSigma: lv.speedSigma,
    rankSigma: Math.hypot(lv.aimSigmaDeg * DEG, SIGMA_FLOOR),
    refSigma: Math.hypot(SIGMA_REF, SIGMA_FLOOR),
    rng: mulberry32((seed ^ 0x5bd1e995) >>> 0),
    now,
    yieldFn: typeof opts.yieldFn === 'function' ? opts.yieldFn : defaultYield,
    budgetMs: Number.isFinite(opts.budgetMs) ? opts.budgetMs : DEFAULT_BUDGET_MS,
    t0,
    sliceStart: t0,
    sims: 0,
    probes: 0,
    evaluated: 0,
    budgetHit: false,
    probeWorld: null,
  };
  env.tick = async () => {
    if (env.now() - env.sliceStart >= SLICE_MS) {
      await env.yieldFn();
      env.sliceStart = env.now();
    }
  };
  // True once no new candidate may be evaluated.
  env.stop = () => {
    if (env.sims >= MAX_SIMS) return true;
    if (env.now() - env.t0 > env.budgetMs) {
      env.budgetHit = true;
      return true;
    }
    return false;
  };
  return env;
}

// ---------------------------------------------------------------------------------------------
// Table geometry used by the planner (cached per table object)
// ---------------------------------------------------------------------------------------------

const geoCache = new WeakMap();

function plannerGeometry(table) {
  let g = geoCache.get(table);
  if (g) return g;
  const R = table.R;
  const near = (p, q) => Math.hypot(p.x - q.x, p.y - q.y) < 1e-6;
  const rails = table.cushions
    .filter((c) => c.kind === 'rail')
    .map((c) => ({ ax: c.a.x, ay: c.a.y, bx: c.b.x, by: c.b.y, nx: c.n.x, ny: c.n.y, a: c.a, b: c.b }));
  const pockets = table.pockets.map((p) => ({
    id: p.id,
    kind: p.kind,
    x: p.x,
    y: p.y,
    rc: p.captureR,
    dx: p.dir.x,
    dy: p.dir.y,
    jaws: table.cushions
      .filter((c) => c.kind === 'jaw' && c.pocket === p.id)
      .map((c) => ({ ax: c.a.x, ay: c.a.y, bx: c.b.x, by: c.b.y })),
    noses: table.noses.filter((n) => n.pocket === p.id).map((n) => ({ x: n.x, y: n.y, rr: R + n.r })),
    // Rails that end at one of this pocket's jaws: the only rails a path into it can cross.
    rails: rails.filter((r) => p.jaws.some((j) => near(j, r.a) || near(j, r.b))),
  }));
  // Ball-centre lines of the rails (where a ball touches the cushion), for banks and kicks.
  const mirrors = rails.map((r) => {
    const len = Math.hypot(r.bx - r.ax, r.by - r.ay);
    return {
      qx: r.ax + r.nx * R,
      qy: r.ay + r.ny * R,
      tx: (r.bx - r.ax) / len,
      ty: (r.by - r.ay) / len,
      nx: r.nx,
      ny: r.ny,
      lo: RAIL_MARGIN,
      hi: len - RAIL_MARGIN,
    };
  });
  g = { R, HL: table.HL, HW: table.HW, headStringX: table.headStringX, pockets, mirrors };
  geoCache.set(table, g);
  return g;
}

// ---------------------------------------------------------------------------------------------
// Small geometry helpers (allocation-free: they run in the hottest loops)
// ---------------------------------------------------------------------------------------------

function segPoint(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = ax + dx * t - px;
  const ey = ay + dy * t - py;
  return Math.sqrt(ex * ex + ey * ey);
}

function segSeg(ax, ay, bx, by, cx, cy, dx, dy) {
  const o1 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const o2 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
  const o3 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
  const o4 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
  if (o1 > 0 !== o2 > 0 && o3 > 0 !== o4 > 0) return 0;
  return Math.min(
    segPoint(ax, ay, cx, cy, dx, dy),
    segPoint(bx, by, cx, cy, dx, dy),
    segPoint(cx, cy, ax, ay, bx, by),
    segPoint(dx, dy, ax, ay, bx, by),
  );
}

function erf(x) {
  const s = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
  return s * y;
}

// Probability that a Gaussian aim error (sigma) stays within +/- allowed.
function inWindow(allowed, sigma) {
  return allowed <= 0 ? 0 : erf(allowed / (sigma * Math.SQRT2));
}

// Balls on the table as flat arrays (plus the id-indexed source list).
function ballSet(balls) {
  const ids = [];
  const xs = [];
  const ys = [];
  const byId = new Array(16).fill(null);
  for (const b of balls) {
    if (!b) continue;
    byId[b.id] = b;
    if (!b.on) continue;
    ids.push(b.id);
    xs.push(b.x);
    ys.push(b.y);
  }
  return { ids, xs, ys, n: ids.length, byId };
}

// No ball centre (other than skipA / skipB) within `clear` of segment a-b.
function corridorClear(bs, ax, ay, bx, by, skipA, skipB, clear) {
  for (let i = 0; i < bs.n; i++) {
    const id = bs.ids[i];
    if (id === skipA || id === skipB) continue;
    if (segPoint(bs.xs[i], bs.ys[i], ax, ay, bx, by) < clear) return false;
  }
  return true;
}

// A ball running along segment a-b would drop into some pocket on the way.
function crossesPocket(geo, ax, ay, bx, by) {
  for (const pk of geo.pockets) if (segPoint(pk.x, pk.y, ax, ay, bx, by) < pk.rc + POCKET_CLEAR) return true;
  return false;
}

function onTable(geo, x, y, tol = 0.001) {
  return Math.abs(x) <= geo.HL - geo.R + tol && Math.abs(y) <= geo.HW - geo.R + tol;
}

// Reflect (px,py) across mirror line m.
function reflect(m, px, py) {
  const s = (px - m.qx) * m.nx + (py - m.qy) * m.ny;
  return { x: px - 2 * s * m.nx, y: py - 2 * s * m.ny };
}

// Where segment s -> p' (p' mirrored, outside) meets mirror line m; null if off the cushion.
function railHit(m, sx, sy, px, py) {
  const ds = (sx - m.qx) * m.nx + (sy - m.qy) * m.ny;
  const dp = (px - m.qx) * m.nx + (py - m.qy) * m.ny;
  if (ds <= 0.001 || dp >= 0) return null;
  const t = ds / (ds - dp);
  const x = sx + (px - sx) * t;
  const y = sy + (py - sy) * t;
  const along = (x - m.qx) * m.tx + (y - m.qy) * m.ty;
  if (along < m.lo || along > m.hi) return null;
  return { x, y };
}

// ---------------------------------------------------------------------------------------------
// Pocket windows and the geometric pre-score
// ---------------------------------------------------------------------------------------------

// Clearance (m, >= 0 means clean) of an object ball running from o toward the point t inside
// pocket pk, up to where its centre enters the capture circle. Checks the pocket's jaw noses and
// facings, the rails ending at its jaws and every other ball (the cue ball is ignored: it is
// behind the object ball at contact).
function pathClearance(geo, bs, ox, oy, tx, ty, pk, skip) {
  const R = geo.R;
  let ux = tx - ox;
  let uy = ty - oy;
  const l = Math.hypot(ux, uy);
  if (l < 1e-9) return -1;
  ux /= l;
  uy /= l;
  const fx = ox - pk.x;
  const fy = oy - pk.y;
  const b = fx * ux + fy * uy;
  const disc = b * b - (fx * fx + fy * fy - pk.rc * pk.rc);
  if (disc <= 0) return -1;
  const tIn = -b - Math.sqrt(disc);
  if (tIn < 0) return -1;
  const ex = ox + ux * tIn;
  const ey = oy + uy * tIn;
  let clr = Infinity;
  for (const n of pk.noses) {
    const d = segPoint(n.x, n.y, ox, oy, ex, ey) - n.rr + GRAZE;
    if (d < clr) clr = d;
  }
  for (const j of pk.jaws) {
    const d = segSeg(ox, oy, ex, ey, j.ax, j.ay, j.bx, j.by) - R + GRAZE;
    if (d < clr) clr = d;
  }
  for (const r of pk.rails) {
    const d = segSeg(ox, oy, ex, ey, r.ax, r.ay, r.bx, r.by) - R + GRAZE;
    if (d < clr) clr = d;
  }
  if (clr < 0) return clr;
  const twoR = 2 * R;
  for (let i = 0; i < bs.n; i++) {
    const id = bs.ids[i];
    if (id === skip || id === 0) continue;
    const d = segPoint(bs.xs[i], bs.ys[i], ox, oy, ex, ey) - twoR;
    if (d < clr) {
      clr = d;
      if (clr < 0) return clr;
    }
  }
  return clr;
}

// The window of directions that pot a ball at (ox,oy) in pocket pk: aim point (centre of the
// widest clear run of sampled directions), unit direction u, distance to capture entry, lateral
// half-width at the pocket (hw) and angular half-width (half). null when nothing goes in.
function pocketWindow(geo, bs, ox, oy, pk, skip) {
  const L = Math.hypot(pk.x - ox, pk.y - oy);
  if (L <= pk.rc + 1e-6) return null;
  const vx = (pk.x - ox) / L;
  const vy = (pk.y - oy) / L;
  if (pk.kind === 'side' && vx * pk.dx + vy * pk.dy < COS_SIDE_APPROACH) return null;
  const nx = -vy;
  const ny = vx;
  const span = pk.rc * WIN_SPAN;
  const step = (2 * span) / (WIN_N - 1);
  let runStart = -1;
  let bestStart = -1;
  let bestLen = 0;
  for (let k = 0; k < WIN_N; k++) {
    const s = -span + k * step;
    if (pathClearance(geo, bs, ox, oy, pk.x + nx * s, pk.y + ny * s, pk, skip) >= 0) {
      if (runStart < 0) runStart = k;
      if (k - runStart + 1 > bestLen) {
        bestLen = k - runStart + 1;
        bestStart = runStart;
      }
    } else runStart = -1;
  }
  if (!bestLen) return null;
  const sMid = -span + (bestStart + (bestLen - 1) / 2) * step;
  const tx = pk.x + nx * sMid;
  const ty = pk.y + ny * sMid;
  let ux = tx - ox;
  let uy = ty - oy;
  const lt = Math.hypot(ux, uy);
  ux /= lt;
  uy /= lt;
  const fx = ox - pk.x;
  const fy = oy - pk.y;
  const b = fx * ux + fy * uy;
  const tIn = -b - Math.sqrt(Math.max(0, b * b - (fx * fx + fy * fy - pk.rc * pk.rc)));
  const hw = (bestLen * step) / 2;
  return { pocket: pk.id, tx, ty, ux, uy, tIn: Math.max(0, tIn), L, hw, half: Math.atan2(hw, L) };
}

// Ghost-ball geometry of a cue ball at (cx,cy) driving ball `tid` (at o) along unit u.
// Returns null when the ghost is off the table, the cut is too thin or the cue's path is blocked.
// gain = |d(object direction) / d(cue aim)|, the ghost-ball error amplification.
function ghostShot(geo, bs, cx, cy, tid, ux, uy, maxCos = COS_MAX_CUT) {
  const R = geo.R;
  const o = bs.byId[tid];
  const gx = o.x - 2 * R * ux;
  const gy = o.y - 2 * R * uy;
  if (!onTable(geo, gx, gy)) return null;
  let ax = gx - cx;
  let ay = gy - cy;
  const d1 = Math.hypot(ax, ay);
  let cosCut;
  if (d1 < 1e-4) {
    ax = ux; // the cue ball already sits on the ghost: drive straight through
    ay = uy;
    cosCut = 1;
  } else {
    ax /= d1;
    ay /= d1;
    cosCut = ax * ux + ay * uy;
  }
  if (cosCut < maxCos) return null;
  if (d1 >= 1e-4) {
    if (!corridorClear(bs, cx, cy, gx, gy, 0, tid, 2 * R)) return null;
    if (crossesPocket(geo, cx, cy, gx, gy)) return null;
  }
  const proj = (o.x - cx) * ax + (o.y - cy) * ay; // D cos(beta - alpha)
  const dThetaDAlpha = 1 - proj / (2 * R * cosCut);
  return {
    angle: Math.atan2(ay, ax),
    gx,
    gy,
    d1,
    cosCut,
    gainSigned: dThetaDAlpha,
    gain: Math.max(1, Math.abs(dThetaDAlpha)),
  };
}

// Direct pot of `tid` into the window's pocket from (cx,cy), with its pre-score for aim sigma.
function directPot(geo, bs, cx, cy, tid, win, sigma) {
  const gs = ghostShot(geo, bs, cx, cy, tid, win.ux, win.uy);
  if (!gs) return null;
  const pre = inWindow(win.half / gs.gain, sigma) * speedFeasibility(gs.d1, win.tIn, gs.cosCut);
  return {
    kind: 'pot',
    target: tid,
    pocket: win.pocket,
    angle: gs.angle,
    objDir: { x: win.ux, y: win.uy },
    d1: gs.d1,
    d2: win.tIn,
    cosCut: gs.cosCut,
    gainSigned: gs.gainSigned,
    pre,
  };
}

// Long, thin shots need a lot of speed (and speed costs accuracy).
function speedFeasibility(d1, d2, cosCut) {
  const v = cueSpeedFor(objectSpeedFor(d2 + SPEED_MARGIN.soft) / (TRANSFER * Math.max(cosCut, 0.17)), 1, d1);
  if (v > V_CUE_MAX) return 0.25;
  if (v > 5) return 0.7;
  return 1;
}

// Best pre-score for the player to move in st (used for position play and the opponent).
function bestShotValue(env, st) {
  const geo = env.geo;
  const req = getShotRequirements(st, env.table);
  const bs = ballSet(st.balls);
  const cue = bs.byId[0];
  const blocked = req.kitchenBlocked;
  const inHand = !!st.ballInHand || !cue || !cue.on;
  // Ball in hand: judged as a straight shot from BIH_CUE_DIST behind the ghost ball.
  const bihGain = BIH_CUE_DIST / (2 * geo.R);
  let best = 0;
  for (const tid of req.legalTargets) {
    if (blocked.length && blocked.includes(tid)) continue;
    const o = bs.byId[tid];
    for (const pk of geo.pockets) {
      const win = pocketWindow(geo, bs, o.x, o.y, pk, tid);
      if (!win) continue;
      // Upper bound first: a straight shot with gain 1 cannot beat the current best.
      if (inWindow(win.half, env.refSigma) <= best) continue;
      let v;
      if (inHand) v = inWindow(win.half / bihGain, env.refSigma);
      else {
        const s = directPot(geo, bs, cue.x, cue.y, tid, win, env.refSigma);
        v = s ? s.pre : 0;
      }
      if (v > best) best = v;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------------------------
// Candidate generation
// ---------------------------------------------------------------------------------------------

function shotTargets(req) {
  const blocked = req.kitchenBlocked;
  return blocked.length ? req.legalTargets.filter((id) => !blocked.includes(id)) : req.legalTargets.slice();
}

// All direct pots from the cue ball's position, best pre-score first.
function directCandidates(env, bs, targets) {
  const geo = env.geo;
  const cue = bs.byId[0];
  const out = [];
  for (const tid of targets) {
    const o = bs.byId[tid];
    for (const pk of geo.pockets) {
      const win = pocketWindow(geo, bs, o.x, o.y, pk, tid);
      if (!win) continue;
      const c = directPot(geo, bs, cue.x, cue.y, tid, win, env.rankSigma);
      if (c && c.pre > 0) out.push(c);
    }
  }
  return out;
}

// One-rail banks (object ball off a rail) and kicks (cue ball off a rail), found by mirroring.
function bankKickCandidates(env, bs, targets) {
  const geo = env.geo;
  const R = geo.R;
  const cue = bs.byId[0];
  const out = [];
  for (const tid of targets) {
    const o = bs.byId[tid];
    for (const pk of geo.pockets) {
      // Banks: mirror the pocket across each rail line the object ball can reach.
      for (const m of geo.mirrors) {
        const side = (pk.x - m.qx) * m.nx + (pk.y - m.qy) * m.ny;
        if (side <= 0) continue; // pockets on this rail itself cannot be banked into
        const p1 = reflect(m, pk.x, pk.y);
        const b1 = railHit(m, o.x, o.y, p1.x, p1.y);
        if (!b1) continue;
        const win = pocketWindow(geo, bs, b1.x, b1.y, pk, tid);
        if (!win) continue;
        const p2 = reflect(m, win.tx, win.ty); // refine on the window's aim point
        const b = railHit(m, o.x, o.y, p2.x, p2.y);
        if (!b) continue;
        if (!corridorClear(bs, o.x, o.y, b.x, b.y, 0, tid, 2 * R)) continue;
        if (crossesPocket(geo, o.x, o.y, b.x, b.y)) continue;
        let ux = b.x - o.x;
        let uy = b.y - o.y;
        const l1 = Math.hypot(ux, uy);
        ux /= l1;
        uy /= l1;
        const gs = ghostShot(geo, bs, cue.x, cue.y, tid, ux, uy, COS_MAX_CUT_KICK);
        if (!gs) continue;
        const d2 = l1 + Math.hypot(win.tx - b.x, win.ty - b.y) - pk.rc;
        const half = Math.atan2(win.hw, d2) * BANK_FACTOR;
        const pre = inWindow(half / gs.gain, env.rankSigma) * speedFeasibility(gs.d1, d2 / RAIL_KEEP, gs.cosCut);
        if (pre <= 0) continue;
        out.push({
          kind: 'bank',
          target: tid,
          pocket: pk.id,
          angle: gs.angle,
          objDir: { x: ux, y: uy },
          d1: gs.d1,
          d2: d2 / RAIL_KEEP,
          cosCut: gs.cosCut,
          gainSigned: gs.gainSigned,
          pre,
        });
      }
      // Kicks: the cue ball goes off a rail into the ghost ball of a direct pot.
      const win = pocketWindow(geo, bs, o.x, o.y, pk, tid);
      if (!win) continue;
      const gx = o.x - 2 * R * win.ux;
      const gy = o.y - 2 * R * win.uy;
      if (!onTable(geo, gx, gy)) continue;
      for (const m of geo.mirrors) {
        const gm = reflect(m, gx, gy);
        const b = railHit(m, cue.x, cue.y, gm.x, gm.y);
        if (!b) continue;
        if (!corridorClear(bs, cue.x, cue.y, b.x, b.y, 0, -1, 2 * R)) continue;
        if (!corridorClear(bs, b.x, b.y, gx, gy, 0, tid, 2 * R)) continue;
        if (crossesPocket(geo, cue.x, cue.y, b.x, b.y) || crossesPocket(geo, b.x, b.y, gx, gy)) continue;
        const l2 = Math.hypot(gx - b.x, gy - b.y);
        const cosCut = ((gx - b.x) * win.ux + (gy - b.y) * win.uy) / l2;
        if (cosCut < COS_MAX_CUT_KICK) continue;
        const lk = Math.hypot(b.x - cue.x, b.y - cue.y) + l2;
        const gain = Math.max(1, lk / (2 * R * cosCut));
        const half = win.half * KICK_FACTOR;
        const pre =
          inWindow(half / gain, env.rankSigma) * speedFeasibility(lk / RAIL_KEEP, win.tIn, cosCut);
        if (pre <= 0) continue;
        out.push({
          kind: 'kick',
          target: tid,
          pocket: pk.id,
          angle: Math.atan2(b.y - cue.y, b.x - cue.x),
          objDir: null, // no throw correction through a rail
          d1: lk / RAIL_KEEP,
          d2: win.tIn,
          cosCut,
          gainSigned: 0,
          pre,
        });
      }
    }
  }
  return out;
}

// Soft legal-contact shots: full / half / thin hits on every reachable legal target, and one-rail
// kicks onto targets the cue ball cannot see directly (or that are behind the head string while
// the cue ball is in the kitchen: the kick must cross the string first).
function contactCandidates(env, bs, req) {
  const geo = env.geo;
  const R = geo.R;
  const cue = bs.byId[0];
  const out = [];
  const blocked = req.kitchenBlocked;
  for (const deg of SAFETY_CUTS) {
    for (const tid of req.legalTargets) {
      if (blocked.includes(tid)) continue;
      const o = bs.byId[tid];
      const dx = o.x - cue.x;
      const dy = o.y - cue.y;
      const D = Math.hypot(dx, dy);
      const off = 2 * R * Math.sin(deg * DEG); // perpendicular offset of the cue line from o
      if (D <= Math.abs(off) + 1e-4) continue;
      const alpha = Math.atan2(dy, dx) - Math.asin(off / D);
      const ax = Math.cos(alpha);
      const ay = Math.sin(alpha);
      const t = dx * ax + dy * ay - Math.sqrt(Math.max(0, 4 * R * R - off * off));
      if (t < 0) continue;
      const gx = cue.x + ax * t;
      const gy = cue.y + ay * t;
      if (!corridorClear(bs, cue.x, cue.y, gx, gy, 0, tid, 2 * R)) continue;
      if (crossesPocket(geo, cue.x, cue.y, gx, gy)) continue;
      out.push({ kind: 'safety', target: tid, pocket: null, angle: alpha, objDir: null, d1: t, d2: 0, cosCut: 1, pre: 0 });
    }
  }
  // Kicks for targets with no direct contact found above.
  const seen = new Set(out.map((c) => c.target));
  for (const tid of req.legalTargets) {
    if (seen.has(tid) && !blocked.includes(tid)) continue;
    const o = bs.byId[tid];
    for (const m of geo.mirrors) {
      const om = reflect(m, o.x, o.y);
      const b = railHit(m, cue.x, cue.y, om.x, om.y);
      if (!b) continue;
      if (blocked.includes(tid) && b.x < geo.headStringX + R) continue;
      if (!corridorClear(bs, cue.x, cue.y, b.x, b.y, 0, -1, 2 * R)) continue;
      if (!corridorClear(bs, b.x, b.y, o.x, o.y, 0, tid, 2 * R)) continue;
      if (crossesPocket(geo, cue.x, cue.y, b.x, b.y) || crossesPocket(geo, b.x, b.y, o.x, o.y)) continue;
      const lk = Math.hypot(b.x - cue.x, b.y - cue.y) + Math.hypot(o.x - b.x, o.y - b.y) - 2 * R;
      out.push({
        kind: 'safety',
        target: tid,
        pocket: null,
        angle: Math.atan2(b.y - cue.y, b.x - cue.x),
        objDir: null,
        d1: lk / RAIL_KEEP,
        d2: 0,
        cosCut: 1,
        pre: 0,
        kick: true,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Speed model
// ---------------------------------------------------------------------------------------------

// Speed of a ball launched at v0 with contact slip ratio k (k = 1 - 2.5 * tip offset: 1 = stun,
// 0 = natural roll, > 1 = draw) after it has travelled d metres. 0 if it stops first.
function speedAfter(v0, k, d) {
  const sgn = k > 0 ? 1 : k < 0 ? -1 : 0;
  const ts = (Math.abs(k) * v0) / (3.5 * MUG); // slip decays at 3.5 mu g
  const ds = v0 * ts - 0.5 * sgn * MUG * ts * ts;
  if (d <= ds) return Math.sqrt(Math.max(0, v0 * v0 - 2 * sgn * MUG * d));
  const v1 = v0 - sgn * MUG * ts;
  const v2 = v1 * v1 - 2 * ROLLG * (d - ds);
  return v2 > 0 ? Math.sqrt(v2) : 0;
}

// Object-ball launch speed that carries it `dist` metres.
function objectSpeedFor(dist) {
  return Math.sqrt(Math.max(0, dist) / TRAVEL_K);
}

// Cue speed (m/s) so that the cue ball still moves at `vc` after `d` metres.
function cueSpeedFor(vc, k, d) {
  if (speedAfter(12, k, d) < vc) return 12;
  let lo = vc;
  let hi = 12;
  for (let i = 0; i < 28; i++) {
    const mid = (lo + hi) / 2;
    if (speedAfter(mid, k, d) >= vc) hi = mid;
    else lo = mid;
  }
  return hi;
}

// Cue speed for a pot candidate with the given speed tier and tip offset.
function potSpeed(cand, tier, spinY) {
  const vObj = objectSpeedFor(cand.d2 + SPEED_MARGIN[tier]);
  const vc = vObj / (TRANSFER * Math.max(cand.cosCut, 0.17));
  const v = cueSpeedFor(vc, 1 - 2.5 * spinY, cand.d1);
  return Math.min(V_CUE_MAX, Math.max(V_CUE_MIN, v));
}

// ---------------------------------------------------------------------------------------------
// Shots, noise and simulation
// ---------------------------------------------------------------------------------------------

// Aim angle that launches the cue ball along `dir` with side spin sx (cancels squirt).
function aimFor(dir, sx) {
  return normalizeAngle(dir - (sx / MAX_TIP) * MAX_SQUIRT_RAD);
}

function noisyShot(env, shot) {
  const angle = normalizeAngle(shot.angle + gaussian(env.rng) * env.aimSigma);
  const speed = shotSpeed(shot.power) * Math.max(0.2, 1 + gaussian(env.rng) * env.speedSigma);
  return {
    angle,
    power: powerForSpeed(speed),
    spin: { x: shot.spin.x, y: shot.spin.y },
    call: shot.call ? { ...shot.call } : null,
  };
}

// The `call` a shot needs (only the 8 is called in the casual ruleset).
function makeCall(env, st, req, cand, angle) {
  if (!req.mustCallPocket) return null;
  if (cand.pocket == null && req.canCallSafety) return { safety: true };
  let pocket = cand.pocket;
  if (pocket == null) {
    // A safety on the 8 must still name a pocket: where the 8 would head, else the nearest.
    const cue = st.balls[0];
    const tr = traceAim(st.balls, cue.x, cue.y, angle, env.table.pockets);
    if (tr.type === 'ball' && tr.ball === cand.target && tr.pocket != null) pocket = tr.pocket;
    else pocket = nearestPocket(env, st.balls[cand.target]);
  }
  return req.mustCallBall ? { ball: cand.target, pocket } : { pocket };
}

function nearestPocket(env, b) {
  let best = 0;
  let bd = Infinity;
  for (const pk of env.table.pockets) {
    const d = Math.hypot(pk.x - b.x, pk.y - b.y);
    if (d < bd) {
      bd = d;
      best = pk.id;
    }
  }
  return best;
}

// Run the shot up to the cue ball's first contact and return the object ball's departure angle,
// or null if the cue ball hits something else first.
function probeDeparture(env, balls, shot, tid) {
  if (!env.probeWorld) {
    env.probeWorld = new World(env.table);
    env.probeWorld.trackOrientation = false;
  }
  const w = env.probeWorld;
  w.setBalls(balls);
  w.strike(shot);
  env.probes++;
  const maxSteps = Math.ceil(5 / AI_DT);
  for (let s = 0; s < maxSteps && !w.atRest(); s++) {
    const ev = w.step(AI_DT);
    for (let i = 0; i < ev.length; i++) {
      const e = ev[i];
      if (e.type === 'ball' && e.a === 0) {
        if (e.b !== tid) return null;
        const b = w.balls[tid];
        return Math.atan2(b.vy, b.vx);
      }
      if (e.type === 'pocket' && e.ball === 0) return null;
    }
  }
  return null;
}

// Correct the aim for throw (cut- and spin-induced) using the ghost-ball sensitivity.
function compensateThrow(env, st, cand, shot) {
  if (!cand.objDir || Math.abs(cand.gainSigned) < 1.5) return shot;
  const want = Math.atan2(cand.objDir.y, cand.objDir.x);
  let angle = shot.angle;
  for (let it = 0; it < 2; it++) {
    const got = probeDeparture(env, st.balls, { ...shot, angle }, cand.target);
    if (got === null) break;
    const err = normalizeAngle(want - got);
    if (Math.abs(err) < 0.0004) break;
    const d = err / cand.gainSigned;
    angle = normalizeAngle(angle + Math.max(-DEG, Math.min(DEG, d)));
  }
  return { ...shot, angle };
}

// What a simulated result means for the shooter.
function judge(env, st, record) {
  const out = evaluateShot(st, record, { messages: false, table: env.table });
  const p = st.turn;
  const win = out.gameOver && out.winner === p;
  const loss = out.gameOver && out.winner !== p;
  const keep = win || (!out.gameOver && out.continueTurn);
  return { out, win, loss, keep, foul: out.fouls.length > 0 };
}

// Simulate a shot `samples` times with execution noise and score it.
async function evaluateShotPlan(env, st, cand, shot, samples) {
  let n = 0;
  let keep = 0;
  let foul = 0;
  let loss = 0;
  let wins = 0;
  let posSum = 0;
  let oppSum = 0;
  for (let k = 0; k < samples; k++) {
    if (env.sims >= MAX_SIMS) break;
    const s = noisyShot(env, shot);
    const r = simulateShot(st.balls, s, { dt: AI_DT, table: env.table });
    env.sims++;
    const record = { log: r.log, final: r.final, call: s.call };
    const j = judge(env, st, record);
    n++;
    if (j.foul) foul++;
    if (j.loss) loss++;
    if (j.win) {
      wins++;
      keep++;
      posSum += 1;
    } else if (!j.loss) {
      const next = applyOutcome(st, record, j.out, env.table);
      if (j.keep) {
        keep++;
        if (env.pos.weight > 0) posSum += bestShotValue(env, next);
      } else if (env.pos.oppWeight > 0) {
        oppSum += bestShotValue(env, next);
      }
    }
    await env.tick();
  }
  env.evaluated++;
  if (!n) return null;
  const P = keep / n;
  const pFoul = foul / n;
  const pLoss = loss / n;
  const pos = posSum / n;
  const opp = oppSum / n;
  const base = P + (wins / n) * WIN_BONUS + env.pos.weight * pos - W_FOUL * pFoul - W_LOSS * pLoss;
  return {
    cand,
    shot,
    n,
    p: P,
    pFoul,
    pLoss,
    pos,
    opp,
    score: base - env.pos.oppWeight * opp,
    safeScore: base - W_OPP_SAFE * opp,
  };
}

// Highest `key` among evaluations, never one that loses the rack more often than not when an
// alternative exists.
function pickBest(list, key) {
  const pool = list.some((e) => e.pLoss < 0.5) ? list.filter((e) => e.pLoss < 0.5) : list;
  let best = null;
  for (const e of pool) if (!best || e[key] > best[key]) best = e;
  return best;
}

// ---------------------------------------------------------------------------------------------
// Planning a normal shot
// ---------------------------------------------------------------------------------------------

function variantList(env) {
  const out = [];
  for (const sp of env.pos.speeds) for (const name of env.pos.spins) out.push({ tier: sp, spin: SPIN[name] });
  if (env.lv.sideSpin) for (const s of SIDE_SPINS) out.push({ tier: 'medium', spin: s });
  return out;
}

function buildPotShot(env, st, req, cand, variant) {
  const speed = potSpeed(cand, variant.tier, variant.spin.y);
  const angle = aimFor(cand.angle, variant.spin.x);
  const shot = {
    angle,
    power: powerForSpeed(speed),
    spin: { x: variant.spin.x, y: variant.spin.y },
    call: makeCall(env, st, req, cand, angle),
  };
  return compensateThrow(env, st, cand, shot);
}

function buildContactShot(env, st, req, cand) {
  const v = cueSpeedFor(SAFETY_CONTACT_V, 1, cand.d1);
  return {
    angle: cand.angle,
    power: powerForSpeed(Math.min(V_CUE_MAX, Math.max(V_CUE_MIN, v))),
    spin: { x: 0, y: 0 },
    call: makeCall(env, st, req, cand, cand.angle),
  };
}

async function planShot(env, st) {
  const req = getShotRequirements(st, env.table);
  const bs = ballSet(st.balls);
  const targets = shotTargets(req);
  const K = Math.max(1, env.lv.samples);
  const N = env.lv.candidates;

  // 1. Candidates, best pre-score first.
  const cands = directCandidates(env, bs, targets);
  let bestDirect = 0;
  for (const c of cands) if (c.pre > bestDirect) bestDirect = c.pre;
  if (bestDirect < DIRECT_GOOD) for (const c of bankKickCandidates(env, bs, targets)) cands.push(c);
  cands.sort((a, b) => b.pre - a.pre);
  await env.tick();

  // 2. Breadth: the default variant of the best pairs. 3. Depth: other variants of the pairs that
  // simulated best.
  const variants = variantList(env);
  const evals = [];
  const breadth = Math.min(cands.length, env.pos.breadth, N);
  for (let i = 0; i < breadth && !env.stop(); i++) {
    const shot = buildPotShot(env, st, req, cands[i], variants[0]);
    const e = await evaluateShotPlan(env, st, cands[i], shot, K);
    if (e) evals.push(e);
  }
  if (variants.length > 1) {
    const order = evals.slice().sort((a, b) => b.score - a.score);
    let used = evals.length;
    for (const top of order) {
      if (used >= N || env.stop()) break;
      for (let v = 1; v < variants.length && used < N && !env.stop(); v++) {
        const shot = buildPotShot(env, st, req, top.cand, variants[v]);
        const e = await evaluateShotPlan(env, st, top.cand, shot, K);
        used++;
        if (e) evals.push(e);
      }
    }
  }
  let best = pickBest(evals, 'score');

  // 4. Safety (or, at any level, a plain legal hit when there is nothing to pot at all).
  const wantSafety = env.lv.safety && (!best || best.p < SAFETY_P);
  let safeties = [];
  if (wantSafety || !cands.length) {
    const cs = contactCandidates(env, bs, req);
    const max = wantSafety ? SAFETY_MAX[env.lv.id] || SAFETY_MAX.hard : Math.max(2, N);
    const first = [];
    for (let i = 0; i < cs.length && i < max && !env.stop(); i++) {
      const shot = buildContactShot(env, st, req, cs[i]);
      const e = await evaluateShotPlan(env, st, cs[i], shot, 1);
      if (e) first.push(e);
    }
    // The most promising ones get the remaining samples.
    first.sort((a, b) => b.safeScore - a.safeScore);
    for (let i = 0; i < Math.min(4, first.length) && K > 1 && !env.stop(); i++) {
      const more = await evaluateShotPlan(env, st, first[i].cand, first[i].shot, K - 1);
      if (more) first[i] = mergeEvals(env, first[i], more);
    }
    safeties = first;
    const pool = evals.concat(safeties);
    const key = wantSafety ? 'safeScore' : 'score';
    const choice = pickBest(pool, key);
    if (choice) best = choice;
  }

  // 5. Nothing simulated (time budget): best geometric candidate, else a soft hit.
  if (!best) {
    if (cands.length) {
      const shot = buildPotShot(env, st, req, cands[0], variants[0]);
      return { shot, info: { kind: cands[0].kind, target: cands[0].target, pocket: cands[0].pocket, p: cands[0].pre } };
    }
    return fallbackPlan(env, st, req, bs);
  }
  const c = best.cand;
  return {
    shot: best.shot,
    info: {
      kind: c.kind,
      target: c.target,
      pocket: c.pocket,
      p: best.p,
      pFoul: best.pFoul,
      pLoss: best.pLoss,
      position: best.pos,
      opponent: best.opp,
      score: best.score,
      safetyConsidered: wantSafety,
      candidates: cands.length,
    },
  };
}

// Pool two evaluations of the same shot (sample-weighted).
function mergeEvals(env, a, b) {
  const n = a.n + b.n;
  const mix = (k) => (a[k] * a.n + b[k] * b.n) / n;
  return { ...a, n, p: mix('p'), pFoul: mix('pFoul'), pLoss: mix('pLoss'), pos: mix('pos'), opp: mix('opp'), score: mix('score'), safeScore: mix('safeScore') };
}

// Softly hit the nearest legal target full in the face.
function fallbackPlan(env, st, req, bs) {
  const cue = bs.byId[0];
  let tid = null;
  let bd = Infinity;
  const pool = shotTargets(req);
  for (const id of pool.length ? pool : req.legalTargets) {
    const b = bs.byId[id];
    const d = Math.hypot(b.x - cue.x, b.y - cue.y);
    if (d < bd) {
      bd = d;
      tid = id;
    }
  }
  const cand = { kind: 'fallback', target: tid, pocket: null, d1: tid == null ? 0.5 : bd, angle: 0 };
  if (tid != null) cand.angle = Math.atan2(bs.byId[tid].y - cue.y, bs.byId[tid].x - cue.x);
  return { shot: buildContactShot(env, st, req, cand), info: { kind: 'fallback', target: tid, pocket: null, p: 0 } };
}

// ---------------------------------------------------------------------------------------------
// Ball in hand
// ---------------------------------------------------------------------------------------------

function withCueAt(state, pt) {
  const balls = state.balls.slice();
  balls[0] = { id: 0, x: pt.x, y: pt.y, on: true };
  return { ...state, balls };
}

// Cue-ball placement: behind the ghost ball of the best target/pocket pairs, 0.12-0.45 m back
// along the shot line with a few lateral offsets (a slight angle helps position), validated by the
// rules (the kitchen restriction included).
function choosePlacement(env, state) {
  const geo = env.geo;
  const R = geo.R;
  const table = env.table;
  const req = getShotRequirements(state, table);
  const bs = ballSet(state.balls);
  const kitchen = state.ballInHand === 'kitchen';
  const targets = shotTargets(req);
  const pairs = [];
  for (const tid of targets) {
    const o = bs.byId[tid];
    for (const pk of geo.pockets) {
      const win = pocketWindow(geo, bs, o.x, o.y, pk, tid);
      if (win) pairs.push({ tid, win });
    }
  }
  pairs.sort((a, b) => b.win.half - a.win.half);
  let best = null;
  let bestScore = -1;
  const backs = [0.12, 0.2, 0.3, 0.45];
  const lats = [0, 0.05, -0.05, 0.1, -0.1];
  for (const { tid, win } of pairs.slice(0, 12)) {
    const o = bs.byId[tid];
    const gx = o.x - 2 * R * win.ux;
    const gy = o.y - 2 * R * win.uy;
    if (!onTable(geo, gx, gy, 0)) continue;
    const dists = backs.slice();
    if (kitchen && win.ux > 0.05) {
      // Back along the line until it is behind the head string.
      const dk = (gx - (geo.headStringX - 0.01)) / win.ux;
      if (dk > 0) dists.push(dk + 0.02, dk + 0.1, dk + 0.25);
    }
    for (const d of dists) {
      for (const lat of lats) {
        const px = gx - win.ux * d - win.uy * lat;
        const py = gy - win.uy * d + win.ux * lat;
        if (!validateCuePlacement(state, { x: px, y: py }, table).ok) continue;
        const s = directPot(geo, bs, px, py, tid, win, env.rankSigma);
        if (!s) continue;
        // A small cut (5-25 degrees) gives the cue ball somewhere to go after contact.
        const cut = Math.acos(Math.min(1, s.cosCut)) / DEG;
        const score = s.pre * (cut > 5 && cut < 25 ? 1.04 : 1) - 0.01 * d;
        if (score > bestScore) {
          bestScore = score;
          best = { x: px, y: py };
        }
      }
    }
  }
  if (best) return best;
  // Nothing found: the rules' own snap from a sensible spot.
  const at = kitchen ? { x: geo.headStringX - 0.2, y: 0 } : { x: 0, y: 0 };
  return nearestValidPlacement(state, at, table);
}

// ---------------------------------------------------------------------------------------------
// Break
// ---------------------------------------------------------------------------------------------

async function planBreak(env, state) {
  const geo = env.geo;
  const R = geo.R;
  const table = env.table;
  const objs = state.balls.filter((b) => b && b.on && b.id !== 0).sort((a, b) => a.x - b.x);
  const apex = objs[0] || { x: table.footSpot.x, y: table.footSpot.y };
  const speed = env.lv.breakSpeed;
  const spin = { x: 0, y: -0.1 };
  const K = Math.max(1, env.lv.samples);
  const sides = env.rng() < 0.5 ? [BREAK_Y, -BREAK_Y] : [-BREAK_Y, BREAK_Y];
  const plans = [];
  for (const y of sides) {
    let place = { x: geo.headStringX - BREAK_BACK, y };
    if (!validateCuePlacement(state, place, table).ok) place = nearestValidPlacement(state, place, table);
    // Full on the apex, a touch toward the second-row ball on the cue's side (drives the rack).
    const second = objs.slice(1, 3).find((b) => Math.sign(b.y - apex.y) === Math.sign(y)) || apex;
    const ax = apex.x + 0.15 * (second.x - apex.x) * (R / Math.max(R, Math.hypot(second.x - apex.x, second.y - apex.y)));
    const ay = apex.y + 0.15 * (second.y - apex.y) * (R / Math.max(R, Math.hypot(second.x - apex.x, second.y - apex.y)));
    const shot = { angle: Math.atan2(ay - place.y, ax - place.x), power: powerForSpeed(speed), spin, call: null };
    const st = withCueAt(state, place);
    let score = 0;
    let n = 0;
    for (let k = 0; k < K && !env.stop(); k++) {
      const s = noisyShot(env, shot);
      const r = simulateShot(st.balls, s, { dt: AI_DT, table });
      env.sims++;
      const out = evaluateShot(st, { log: r.log, final: r.final, call: null }, { messages: false, table });
      score += (out.continueTurn ? 1 : 0) - (out.fouls.length ? 1 : 0) - (out.breakLegal === false ? 1 : 0);
      n++;
      await env.tick();
    }
    plans.push({ place, shot, score: n ? score / n : -Infinity });
  }
  env.evaluated += plans.length;
  const best = plans[0].score >= plans[1].score ? plans[0] : plans[1];
  return { place: best.place, shot: best.shot, info: { kind: 'break', target: apex.id, pocket: null, p: best.score } };
}
