// Ball physics: cue strike, cloth friction (slide / roll / spin), and exact time-of-impact
// collisions with balls, cushions, jaw noses and pockets. Pure module: no DOM, no clock, no
// Math.random, so a shot simulated twice gives bit-identical results.
//
// Model (SI units, z up, R = ball radius, m = ball mass, I = 2/5 m R^2). All impulses below are
// per unit mass (velocity changes), so m never appears.
//
// * Strike: the cue ball leaves at shotSpeed(power) along the aim line plus squirt. A tip offset b
//   (fraction of R, + = follow) gives roll spin 5 V b / (2R) about the horizontal axis
//   perpendicular to the shot (b = 0.4 is exactly natural roll). A side offset a (+ = right
//   english) gives wz = +5 V a / (2R): the tip pushes the right side of the ball forward, which is
//   counter-clockwise seen from above (+z) in this right-handed frame.
// * Cloth: the contact-point velocity is u = (vx - R wy, vy + R wx). While |u| > 0 the ball
//   slides: friction MU_SLIDE g opposes u, and u decays along a fixed direction at 3.5 MU_SLIDE g,
//   so the slide phase is integrated exactly and switches to rolling inside the substep. Rolling
//   balls lose MU_ROLL g of speed; english (wz) decays at SPIN_DECEL independently.
// * Collisions: within each substep balls move in straight lines. The earliest time of impact
//   among ball-ball pairs, cushion segments, jaw noses and pocket capture circles is found
//   analytically, every ball is advanced to it, the contact is resolved, and the search repeats.
//   Nothing can tunnel, whatever the speed or substep. Contacts inside a cluster of touching
//   balls (the rack, frozen combinations) are resolved together by a Hertzian micro-simulation.
// * Ball-ball: equal masses, normal restitution E_BALL, plus a friction impulse opposing the 3D
//   slip of the two contact points (gives cut-induced and spin-induced throw, and a little spin
//   transfer). Friction falls with slip speed as measured on real balls.
// * Cushions: the nose touches the ball 0.27 R above its centre. The normal impulse passes
//   through the ball centre (a sphere's contact normal always does) with a speed-dependent
//   restitution; the friction impulse acts at the nose contact point, so english changes the
//   rebound angle and topspin is partly killed by the rail. Energy can only decrease.

import {
  BALL_R,
  BALL_M,
  BALL_COUNT,
  G,
  MU_SLIDE,
  MU_ROLL,
  SPIN_DECEL,
  MU_BALL,
  E_BALL,
  E_CUSHION,
  E_CUSHION_FAST,
  CUSHION_FAST_V,
  MU_CUSHION,
  DT,
  AI_DT,
  MAX_SHOT_T,
  REST_V,
  REST_W,
  MAX_TIP,
  MISCUE_TIP,
  MAX_SQUIRT_RAD,
  shotSpeed,
} from './constants.js';
import { TABLE } from './table.js';
import { quatIntegrate, quatForBall } from './vec.js';

const R = BALL_R;
const TWO_R = 2 * R;
const FOUR_R2 = TWO_R * TWO_R;
// Angular velocity change per unit (impulse / mass) applied at lever arm R: R / (2/5 R^2).
const ANG = 2.5 / R;

// Cloth friction.
const SLIDE_ACC = MU_SLIDE * G; // linear deceleration while sliding
const SLIDE_ALPHA = (5 * MU_SLIDE * G) / (2 * R); // angular acceleration while sliding
const SLIP_DECEL = 3.5 * MU_SLIDE * G; // rate at which the contact slip |u| decays
const ROLL_DECEL = MU_ROLL * G;
const SLIP_EPS = 1e-4; // m/s; below this the ball is rolling
const REST_V2 = REST_V * REST_V;
const REST_W2 = REST_W * REST_W;

// Cushion contact geometry: the nose is 1.27 R above the cloth, i.e. 0.27 R above the centre.
const NOSE_SIN = 0.27;
const NOSE_COS = Math.sqrt(1 - NOSE_SIN * NOSE_SIN);
// Fraction of the "stick" impulse the cushion friction may reach. The rubber nose is compliant
// and the contact short, so the ball does not fully grip the cushion; with full grip a stun ball
// at 45 degrees comes off 2-3 degrees short of the mirror angle. 0.75 keeps a plain bank on the
// mirror line (+/- 1 degree) while english still swings it by 5-10 degrees (local tuning).
const CUSHION_STICK = 0.75;

// Ball-ball friction falls with the sliding speed at the contact. Alciatore's fit to measured
// throw is mu(v) = 0.00995 + 0.108 exp(-1.088 v); it is scaled so mu(1 m/s) = MU_BALL.
const THROW_A = 9.951e-3;
const THROW_B = 0.108;
const THROW_C = 1.088;
const THROW_SCALE = MU_BALL / (THROW_A + THROW_B * Math.exp(-THROW_C));

// Clusters: when a ball-ball contact involves a ball that is touching (or within CLUSTER_GAP of)
// a third ball, as in the rack or a frozen combination, the contacts are not independent: the
// gaps are smaller than the balls' compression (about 0.8 mm at break speed), so the impact runs
// through every ball at once. Such clusters are resolved by a short micro-simulation with
// Hertzian contacts (F = K d^1.5; K from phenolic resin, contact time ~0.3 ms) whose unloading
// branch is scaled by E_BALL^2, so each isolated contact still has restitution E_BALL. The
// result is applied as one instantaneous collision (positions unchanged), like a pair impulse.
const CLUSTER_GAP = 0.001;
const HERTZ_K = 4.9e8 / BALL_M; // Hertz constant (N m^-1.5) per unit ball mass
const MICRO_DT = 2.5e-6;
const MICRO_MAX_STEPS = 1200; // 3 ms of contact time at most
const CLUSTER_GAP_D2 = (TWO_R + CLUSTER_GAP) * (TWO_R + CLUSTER_GAP);

// Events and bookkeeping.
const CUSHION_EVENT_V = 0.005; // m/s; slower cushion contacts are resting contact, not hits
const BALL_EVENT_V = 1e-4; // m/s; ignore numerical "kisses" between touching balls
const FROZEN_GAP = 0.0005; // a ball this close to a cushion at the strike is frozen to it
const FROZEN_LEAVE = 0.001; // ... until it moves this far away
const SAFETY_MARGIN = 0.08; // beyond the cushion lines: treat as pocketed (never expected)
const EVENT_CAP = 64; // contacts resolved exactly per substep before falling back
const MAX_SUBSTEP = 0.0025; // step(dt) splits longer intervals into substeps no longer than this
const MAX_ADVANCE = 0.1; // advance() ignores frame gaps beyond this (avoids a spiral of death)
const SEPARATE_ITERS = 4;

// Miscue: the tip slips off the ball.
const MISCUE_SPEED = 0.3;
const MISCUE_SPIN = 0.2;
const MISCUE_DEFLECT = (2 * Math.PI) / 180;

// Event kinds found by the time-of-impact search.
const K_NONE = 0;
const K_BALL = 1;
const K_SEG = 2;
const K_NOSE = 3;
const K_POCKET = 4;

function ballFriction(slip) {
  return THROW_SCALE * (THROW_A + THROW_B * Math.exp(-THROW_C * slip));
}

// ---------------------------------------------------------------------------------------------
// Cue strike
// ---------------------------------------------------------------------------------------------

// Initial cue-ball velocity and spin for shot {angle, power, spin:{x, y}}.
export function strikeVelocity(shot) {
  const spin = (shot && shot.spin) || {};
  let a = Number(spin.x) || 0; // side offset, + = right english
  let b = Number(spin.y) || 0; // vertical offset, + = follow
  let speed = shotSpeed(shot ? Number(shot.power) || 0 : 0);
  let dir = shot ? Number(shot.angle) || 0 : 0;
  let miscue = false;
  const off = Math.hypot(a, b);
  if (off > MISCUE_TIP) {
    // The tip slides off: a weak, nearly spinless shot that skids away from the side struck.
    miscue = true;
    dir += (a / off) * MISCUE_DEFLECT; // right-side miscue goes left (counter-clockwise)
    speed *= MISCUE_SPEED;
    a *= MISCUE_SPIN;
    b *= MISCUE_SPIN;
  } else if (off > MAX_TIP) {
    a *= MAX_TIP / off;
    b *= MAX_TIP / off;
  }
  // Squirt: side english pushes the cue ball off the aim line, away from the side struck.
  dir += (a / MAX_TIP) * MAX_SQUIRT_RAD;
  const dx = Math.cos(dir);
  const dy = Math.sin(dir);
  const roll = (5 * speed * b) / (2 * R); // about perp(d) = (-dy, dx)
  return {
    vx: speed * dx,
    vy: speed * dy,
    wx: -dy * roll,
    wy: dx * roll,
    wz: (5 * speed * a) / (2 * R),
    miscue,
  };
}

// ---------------------------------------------------------------------------------------------
// Table geometry in the form the collision search wants (cached per table object)
// ---------------------------------------------------------------------------------------------

const geometryCache = new WeakMap();

function geometryFor(table) {
  let g = geometryCache.get(table);
  if (!g) {
    g = buildGeometry(table);
    geometryCache.set(table, g);
  }
  return g;
}

function buildGeometry(table) {
  // Each feature carries an axis-aligned box of the ball-centre positions that can touch it.
  const segs = table.cushions.map((c) => {
    const dx = c.b.x - c.a.x;
    const dy = c.b.y - c.a.y;
    const len = Math.hypot(dx, dy);
    return {
      id: c.id,
      ax: c.a.x,
      ay: c.a.y,
      tx: dx / len,
      ty: dy / len,
      len,
      nx: c.n.x,
      ny: c.n.y,
      x0: Math.min(c.a.x, c.b.x) - R,
      x1: Math.max(c.a.x, c.b.x) + R,
      y0: Math.min(c.a.y, c.b.y) - R,
      y1: Math.max(c.a.y, c.b.y) + R,
    };
  });
  const noses = table.noses.map((n) => {
    const rr = R + n.r;
    // A nose is the rounded tip of a jaw: report hits on it as hits on the jaw segment that
    // starts at that jaw point.
    let cushion = -1;
    let best = Infinity;
    for (const c of table.cushions) {
      if (c.pocket !== n.pocket) continue;
      const d = Math.hypot(c.a.x - n.x, c.a.y - n.y);
      if (d < best) {
        best = d;
        cushion = c.id;
      }
    }
    return {
      x: n.x,
      y: n.y,
      rr,
      rr2: rr * rr,
      cushion,
      x0: n.x - rr,
      x1: n.x + rr,
      y0: n.y - rr,
      y1: n.y + rr,
    };
  });
  const pockets = table.pockets.map((p) => ({
    id: p.id,
    x: p.x,
    y: p.y,
    r2: p.captureR * p.captureR,
    x0: p.x - p.captureR,
    x1: p.x + p.captureR,
    y0: p.y - p.captureR,
    y1: p.y + p.captureR,
  }));

  // "Fast box": a ball whose swept centre stays inside it cannot reach any feature, so the
  // per-feature tests are skipped for most of the table. Start from the cushion lines and shrink
  // along whichever axis loses less for each feature box that still pokes in (the corner
  // capture circles reach inside the rail lines).
  const margin = 1e-5;
  let fx = table.HL - R - margin;
  let fy = table.HW - R - margin;
  for (const f of [...segs, ...noses, ...pockets]) {
    if (f.x0 > fx || f.x1 < -fx || f.y0 > fy || f.y1 < -fy) continue;
    const ex = f.x0 > 0 ? f.x0 : f.x1 < 0 ? -f.x1 : 0;
    const ey = f.y0 > 0 ? f.y0 : f.y1 < 0 ? -f.y1 : 0;
    if (ex / fx >= ey / fy) fx = Math.max(0, ex - margin);
    else fy = Math.max(0, ey - margin);
  }
  return { segs, noses, pockets, fastX: fx, fastY: fy, nSeg: segs.length };
}

function newBall(id) {
  return {
    id,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    wx: 0,
    wy: 0,
    wz: 0,
    q: quatForBall(id),
    on: false,
    state: 'pocketed',
    pocket: -1,
  };
}

function stopBall(b) {
  b.vx = 0;
  b.vy = 0;
  b.wx = 0;
  b.wy = 0;
  b.wz = 0;
}

function newStats() {
  // Diagnostics only (not part of the contract): substeps run, contacts resolved, substeps
  // that hit EVENT_CAP, balls caught by the off-table safety net, and cluster micro-steps.
  return { substeps: 0, contacts: 0, capHits: 0, safety: 0, clusters: 0, microSteps: 0 };
}

// ---------------------------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------------------------

export class World {
  constructor(table = TABLE) {
    this.table = table;
    this.balls = [];
    for (let id = 0; id < BALL_COUNT; id++) this.balls.push(newBall(id));
    this.t = 0;
    this.log = [];
    this.maxT = MAX_SHOT_T;
    // Orientation only matters for drawing; headless simulations switch it off.
    this.trackOrientation = true;
    this.stats = newStats();
    this._geo = geometryFor(table);
    this._seq = 0;
    this._acc = 0;
    this._needSeparate = false;
    // Balls frozen against a cushion feature at the strike: parallel arrays of ball id,
    // feature index (segments first, then noses) and whether it is still frozen.
    this._frozenBall = [];
    this._frozenFeat = [];
    this._frozenOn = [];
    // Scratch space for cluster micro-simulations.
    this._mem = new Int32Array(BALL_COUNT);
    this._cl = new Float64Array(BALL_COUNT * 7);
    this._clPrev = new Float64Array((BALL_COUNT * (BALL_COUNT - 1)) / 2);
    this._clHit = new Uint8Array((BALL_COUNT * (BALL_COUNT - 1)) / 2);
    // Result of the last time-of-impact search.
    this._evKind = K_NONE;
    this._evI = -1;
    this._evJ = -1;
    this._evT = 0;
  }

  // list: [{id, x, y, on}]. Velocities are zeroed and orientations kept; balls missing from
  // the list are taken off the table.
  setBalls(list) {
    const seen = new Array(BALL_COUNT).fill(false);
    for (const s of list) {
      const b = this.balls[s.id];
      if (!b) continue;
      seen[s.id] = true;
      b.x = Number(s.x) || 0;
      b.y = Number(s.y) || 0;
      b.on = s.on !== false;
      stopBall(b);
      b.state = b.on ? 'rest' : 'pocketed';
      b.pocket = -1;
    }
    for (const b of this.balls) {
      if (seen[b.id]) continue;
      b.on = false;
      stopBall(b);
      b.state = 'pocketed';
      b.pocket = -1;
    }
    this._acc = 0;
    this._frozenBall.length = 0;
    this._frozenFeat.length = 0;
    this._frozenOn.length = 0;
    this._needSeparate = true;
  }

  // Strike the cue ball. Starts a new shot log (time and seq restart at 0) and returns the
  // events produced (the strike event).
  strike(shot) {
    this.t = 0;
    this._seq = 0;
    this.log = [];
    this._acc = 0;
    this.stats = newStats();
    this._findFrozen();
    this._needSeparate = true;
    const s = strikeVelocity(shot);
    const cue = this.balls[0];
    if (cue.on) {
      cue.vx = s.vx;
      cue.vy = s.vy;
      cue.wx = s.wx;
      cue.wy = s.wy;
      cue.wz = s.wz;
      cue.state = 'slide';
    }
    const ev = { type: 'strike', seq: this._seq++, t: 0, v: Math.hypot(s.vx, s.vy), miscue: s.miscue };
    this.log.push(ev);
    return [ev];
  }

  // Advance exactly dt (split into substeps of at most MAX_SUBSTEP). Returns the new events.
  step(dt = DT) {
    const out = [];
    if (!(dt > 0)) return out;
    const n = Math.max(1, Math.ceil(dt / MAX_SUBSTEP - 1e-9));
    const h = dt / n;
    for (let k = 0; k < n; k++) {
      if (!this._anyActive()) break;
      this._substep(h, out);
    }
    return out;
  }

  // Render-loop driver: runs whole DT substeps from an accumulator. Returns the new events.
  advance(dt) {
    const out = [];
    this._acc += Math.min(Math.max(Number(dt) || 0, 0), MAX_ADVANCE);
    while (this._acc >= DT - 1e-12) {
      if (!this._anyActive()) {
        this._acc = 0;
        break;
      }
      this._acc = Math.max(0, this._acc - DT);
      const ev = this.step(DT);
      for (let i = 0; i < ev.length; i++) out.push(ev[i]);
    }
    return out;
  }

  // True when no ball is rolling or sliding. A ball may still be spinning in place (state
  // 'spin'); that cannot move anything, so the shot is over.
  atRest() {
    for (const b of this.balls) {
      if (b.on && (b.state === 'slide' || b.state === 'roll')) return false;
    }
    return true;
  }

  snapshot() {
    return this.balls.map((b) => ({ id: b.id, x: b.x, y: b.y, on: b.on }));
  }

  record() {
    return { log: this.log, final: this.snapshot() };
  }

  // ---- internals ------------------------------------------------------------------------------

  _anyActive() {
    for (const b of this.balls) if (b.on && b.state !== 'rest') return true;
    return false;
  }

  _substep(h, out) {
    if (this.t >= this.maxT) {
      this._forceRest();
      return;
    }
    this.stats.substeps++;
    if (this._needSeparate) {
      this._needSeparate = false;
      this._separate(this.t, out);
    }
    // 1. Collision pass: straight-line motion, resolving contacts in time order.
    let rem = h;
    let local = 0;
    let count = 0;
    for (;;) {
      if (!this._scan(rem)) {
        this._advanceAll(rem, local, out);
        break;
      }
      const te = this._evT;
      if (te > 0) {
        this._advanceAll(te, local, out);
        local += te;
        rem -= te;
        if (rem < 0) rem = 0;
      }
      this._resolve(this.t + local, out);
      if (++count >= EVENT_CAP) {
        // Pathological cluster (e.g. a ball wedged between a ball and a rail): finish the
        // substep and clean up any overlap directly.
        this.stats.capHits++;
        this._advanceAll(rem, local, out);
        this._separate(this.t + h, out);
        break;
      }
    }
    this.stats.contacts += count;
    // 2. Cloth friction over the whole substep.
    this._friction(h);
    this.t += h;
    // 3. Safety net: a ball outside the table is pocketed in the nearest pocket.
    const lx = this.table.HL + SAFETY_MARGIN;
    const ly = this.table.HW + SAFETY_MARGIN;
    for (const b of this.balls) {
      if (b.on && (Math.abs(b.x) > lx || Math.abs(b.y) > ly)) {
        this.stats.safety++;
        this._pocketBall(b, this._nearestPocket(b), this.t, out);
      }
    }
  }

  _forceRest() {
    for (const b of this.balls) {
      if (!b.on) continue;
      stopBall(b);
      b.state = 'rest';
    }
  }

  // Move every translating ball in a straight line for dt; emits head-string crossings and
  // releases frozen-cushion flags. `local` is the time already elapsed in this substep.
  _advanceAll(dt, local, out) {
    if (dt <= 0) return;
    const balls = this.balls;
    const cue = balls[0];
    if (cue.on && cue.vx !== 0) {
      const hx = this.table.headStringX;
      const x0 = cue.x;
      const x1 = x0 + cue.vx * dt;
      const out0 = x0 > hx;
      const out1 = x1 > hx;
      if (out0 !== out1) {
        let tc = (hx - x0) / cue.vx;
        tc = tc < 0 ? 0 : tc > dt ? dt : tc;
        this._emit({ type: 'cross', seq: this._seq++, t: this.t + local + tc, ball: 0, dir: out1 ? 1 : -1 }, out);
      }
    }
    for (let i = 0; i < balls.length; i++) {
      const b = balls[i];
      if (!b.on || (b.vx === 0 && b.vy === 0)) continue;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
    }
    // Motion is linear here, so checking the gap at segment ends catches every departure.
    const fb = this._frozenBall;
    for (let k = 0; k < fb.length; k++) {
      if (!this._frozenOn[k]) continue;
      const b = balls[fb[k]];
      if (!b.on || this._featureGap(b, this._frozenFeat[k]) > FROZEN_LEAVE) this._frozenOn[k] = false;
    }
  }

  // Earliest contact within [0, limit) from the current positions and velocities. Stores it in
  // this._ev* and returns true if one exists.
  _scan(limit) {
    const balls = this.balls;
    const g = this._geo;
    const n = balls.length;
    let best = limit;
    let kind = K_NONE;
    let ia = -1;
    let ib = -1;
    for (let i = 0; i < n; i++) {
      const a = balls[i];
      if (!a.on) continue;
      const ax = a.x;
      const ay = a.y;
      const avx = a.vx;
      const avy = a.vy;

      // (a) Ball-ball: |dp + dv t| = 2R while approaching.
      for (let j = i + 1; j < n; j++) {
        const b = balls[j];
        if (!b.on) continue;
        const dvx = b.vx - avx;
        const dvy = b.vy - avy;
        if (dvx === 0 && dvy === 0) continue; // both at rest, or moving together
        const dx = b.x - ax;
        const dy = b.y - ay;
        const reach = TWO_R + (Math.abs(dvx) + Math.abs(dvy)) * best;
        if (dx > reach || dx < -reach || dy > reach || dy < -reach) continue;
        const bb = dx * dvx + dy * dvy;
        if (bb >= 0) continue; // separating
        const c = dx * dx + dy * dy - FOUR_R2;
        let t;
        if (c <= 0) {
          t = 0; // touching or overlapping and approaching: immediate contact
        } else {
          const aa = dvx * dvx + dvy * dvy;
          const disc = bb * bb - aa * c;
          if (disc <= 0) continue;
          t = c / (-bb + Math.sqrt(disc)); // stable form of (-bb - sqrt(disc)) / aa
        }
        if (t < best) {
          best = t;
          kind = K_BALL;
          ia = i;
          ib = j;
        }
      }

      if (avx === 0 && avy === 0) continue;
      // Swept box of the centre over the remaining window.
      const ex = ax + avx * best;
      const ey = ay + avy * best;
      const x0 = ax < ex ? ax : ex;
      const x1 = ax < ex ? ex : ax;
      const y0 = ay < ey ? ay : ey;
      const y1 = ay < ey ? ey : ay;
      if (x1 < g.fastX && x0 > -g.fastX && y1 < g.fastY && y0 > -g.fastY) continue;

      // (b) Cushion segments: one-sided, centre reaches distance R from the line while moving
      // against n, and the contact point lies within the segment.
      const segs = g.segs;
      for (let s = 0; s < segs.length; s++) {
        const f = segs[s];
        if (x1 < f.x0 || x0 > f.x1 || y1 < f.y0 || y0 > f.y1) continue;
        const vn = avx * f.nx + avy * f.ny;
        if (vn >= 0) continue;
        const d0 = (ax - f.ax) * f.nx + (ay - f.ay) * f.ny;
        if (d0 <= 0) continue; // behind the cushion (pocket side)
        const t = d0 <= R ? 0 : (d0 - R) / -vn;
        if (t >= best) continue;
        const along = (ax + avx * t - f.ax) * f.tx + (ay + avy * t - f.ay) * f.ty;
        if (along < 0 || along > f.len) continue;
        best = t;
        kind = K_SEG;
        ia = i;
        ib = s;
      }

      // (c) Jaw noses: centre reaches distance R + r from the nose centre.
      const noses = g.noses;
      for (let s = 0; s < noses.length; s++) {
        const f = noses[s];
        if (x1 < f.x0 || x0 > f.x1 || y1 < f.y0 || y0 > f.y1) continue;
        const fx = ax - f.x;
        const fy = ay - f.y;
        const bb = fx * avx + fy * avy;
        if (bb >= 0) continue;
        const c = fx * fx + fy * fy - f.rr2;
        let t;
        if (c <= 0) {
          t = 0;
        } else {
          const aa = avx * avx + avy * avy;
          const disc = bb * bb - aa * c;
          if (disc <= 0) continue;
          t = c / (-bb + Math.sqrt(disc));
        }
        if (t < best) {
          best = t;
          kind = K_NOSE;
          ia = i;
          ib = s;
        }
      }

      // (d) Pockets: the centre enters the capture circle.
      const pockets = g.pockets;
      for (let s = 0; s < pockets.length; s++) {
        const f = pockets[s];
        if (x1 < f.x0 || x0 > f.x1 || y1 < f.y0 || y0 > f.y1) continue;
        const fx = ax - f.x;
        const fy = ay - f.y;
        const c = fx * fx + fy * fy - f.r2;
        let t;
        if (c <= 0) {
          t = 0;
        } else {
          const bb = fx * avx + fy * avy;
          if (bb >= 0) continue;
          const aa = avx * avx + avy * avy;
          const disc = bb * bb - aa * c;
          if (disc <= 0) continue;
          t = c / (-bb + Math.sqrt(disc));
        }
        if (t < best) {
          best = t;
          kind = K_POCKET;
          ia = i;
          ib = s;
        }
      }
    }
    this._evKind = kind;
    this._evI = ia;
    this._evJ = ib;
    this._evT = kind === K_NONE ? limit : best;
    return kind !== K_NONE;
  }

  _resolve(time, out) {
    const balls = this.balls;
    const g = this._geo;
    const b = balls[this._evI];
    switch (this._evKind) {
      case K_BALL: {
        const m = this._clusterAround(this._evI, this._evJ);
        if (m > 2) this._resolveCluster(m, time, out);
        else this._collideBalls(b, balls[this._evJ], time, out);
        break;
      }
      case K_SEG: {
        const f = g.segs[this._evJ];
        this._collideCushion(b, f.nx, f.ny, f.id, this._evJ, time, out);
        break;
      }
      case K_NOSE: {
        const f = g.noses[this._evJ];
        let nx = b.x - f.x;
        let ny = b.y - f.y;
        const d = Math.sqrt(nx * nx + ny * ny) || 1;
        nx /= d;
        ny /= d;
        this._collideCushion(b, nx, ny, f.cushion, g.nSeg + this._evJ, time, out);
        break;
      }
      case K_POCKET:
        this._pocketBall(b, g.pockets[this._evJ].id, time, out);
        break;
    }
  }

  _collideBalls(a, b, time, out) {
    let nx = b.x - a.x;
    let ny = b.y - a.y;
    const d = Math.sqrt(nx * nx + ny * ny);
    if (d > 1e-12) {
      nx /= d;
      ny /= d;
    } else {
      nx = 1;
      ny = 0;
    }
    const vn = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny; // approach speed along the line of centres
    if (vn <= 0) return;
    // Normal impulse (equal masses, reduced mass m/2).
    const jn = 0.5 * (1 + E_BALL) * vn;
    a.vx -= jn * nx;
    a.vy -= jn * ny;
    b.vx += jn * nx;
    b.vy += jn * ny;
    // Relative slip of the contact points, r_a = R n and r_b = -R n:
    // u = va - vb + R (wa + wb) x n, minus its normal part. It has a vertical component when
    // the balls carry follow or draw.
    const swz = a.wz + b.wz;
    let ux = a.vx - b.vx - R * swz * ny;
    let uy = a.vy - b.vy + R * swz * nx;
    const uz = R * ((a.wx + b.wx) * ny - (a.wy + b.wy) * nx);
    const un = ux * nx + uy * ny;
    ux -= un * nx;
    uy -= un * ny;
    const us = Math.sqrt(ux * ux + uy * uy + uz * uz);
    if (us > 1e-9) {
      // Coulomb friction, capped at the impulse that stops the slip (both spheres: 2 x 3.5).
      const jt = Math.min(ballFriction(us) * jn, us / 7);
      const k = jt / us;
      const jx = -k * ux; // impulse on a; b receives the opposite
      const jy = -k * uy;
      const jz = -k * uz;
      // Only horizontal velocity changes (the table takes the vertical part).
      a.vx += jx;
      a.vy += jy;
      b.vx -= jx;
      b.vy -= jy;
      // Torque r x J / I is the same for both balls: (R n) x j = (-R n) x (-j).
      const dwx = ANG * (ny * jz);
      const dwy = ANG * (-nx * jz);
      const dwz = ANG * (nx * jy - ny * jx);
      a.wx += dwx;
      a.wy += dwy;
      a.wz += dwz;
      b.wx += dwx;
      b.wy += dwy;
      b.wz += dwz;
    }
    a.state = 'slide';
    b.state = 'slide';
    if (vn > BALL_EVENT_V) {
      const lo = a.id < b.id ? a.id : b.id;
      const hi = a.id < b.id ? b.id : a.id;
      this._emit({ type: 'ball', seq: this._seq++, t: time, a: lo, b: hi, v: vn }, out);
    }
  }

  // Collect the balls connected to the contact pair (i, j) through gaps below CLUSTER_GAP into
  // this._mem. Returns how many there are.
  _clusterAround(i, j) {
    const balls = this.balls;
    const mem = this._mem;
    mem[0] = i;
    mem[1] = j;
    let m = 2;
    for (let k = 0; k < m; k++) {
      const a = balls[mem[k]];
      for (let c = 0; c < balls.length; c++) {
        const b = balls[c];
        if (!b.on) continue;
        let seen = false;
        for (let q = 0; q < m; q++) {
          if (mem[q] === c) {
            seen = true;
            break;
          }
        }
        if (seen) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        if (dx * dx + dy * dy < CLUSTER_GAP_D2) mem[m++] = c;
      }
    }
    return m;
  }

  // Resolve the cluster in this._mem[0..m) with a Hertzian micro-simulation (see CLUSTER_GAP).
  // Only the velocities and spins it produces are kept. 'ball' events are emitted in the order
  // the pairs first touch, all at the same time.
  _resolveCluster(m, time, out) {
    const balls = this.balls;
    const mem = this._mem;
    const s = this._cl; // per member: x, y, vx, vy, wx, wy, wz
    const prev = this._clPrev;
    const hit = this._clHit;
    for (let k = 0; k < m; k++) {
      const b = balls[mem[k]];
      const o = k * 7;
      s[o] = b.x;
      s[o + 1] = b.y;
      s[o + 2] = b.vx;
      s[o + 3] = b.vy;
      s[o + 4] = b.wx;
      s[o + 5] = b.wy;
      s[o + 6] = b.wz;
    }
    const pairs = (m * (m - 1)) / 2;
    prev.fill(0, 0, pairs);
    hit.fill(0, 0, pairs);
    const unload = E_BALL * E_BALL;
    this.stats.clusters++;
    for (let step = 0; step < MICRO_MAX_STEPS; step++) {
      this.stats.microSteps++;
      let busy = false;
      let p = 0;
      for (let i = 0; i < m; i++) {
        const oi = i * 7;
        for (let j = i + 1; j < m; j++, p++) {
          const oj = j * 7;
          const dx = s[oj] - s[oi];
          const dy = s[oj + 1] - s[oi + 1];
          const d2 = dx * dx + dy * dy;
          if (d2 >= CLUSTER_GAP_D2) {
            prev[p] = 0;
            continue;
          }
          const d = Math.sqrt(d2);
          const nx = d > 1e-12 ? dx / d : 1;
          const ny = d > 1e-12 ? dy / d : 0;
          const vn = (s[oi + 2] - s[oj + 2]) * nx + (s[oi + 3] - s[oj + 3]) * ny; // approach speed
          const delta = TWO_R - d;
          if (delta <= 0) {
            prev[p] = 0;
            if (vn > 0) busy = true; // about to touch
            continue;
          }
          busy = true;
          if (!hit[p]) {
            hit[p] = 1;
            if (vn > BALL_EVENT_V) {
              const ia = balls[mem[i]].id;
              const ib = balls[mem[j]].id;
              this._emit(
                { type: 'ball', seq: this._seq++, t: time, a: ia < ib ? ia : ib, b: ia < ib ? ib : ia, v: vn },
                out,
              );
            }
          }
          let f = HERTZ_K * delta * Math.sqrt(delta);
          if (delta < prev[p]) f *= unload; // restitution phase
          prev[p] = delta;
          const jn = f * MICRO_DT; // impulse per unit mass on each ball
          s[oi + 2] -= jn * nx;
          s[oi + 3] -= jn * ny;
          s[oj + 2] += jn * nx;
          s[oj + 3] += jn * ny;
          // Contact friction, exactly as in _collideBalls but per micro-step.
          const swz = s[oi + 6] + s[oj + 6];
          let ux = s[oi + 2] - s[oj + 2] - R * swz * ny;
          let uy = s[oi + 3] - s[oj + 3] + R * swz * nx;
          const uz = R * ((s[oi + 4] + s[oj + 4]) * ny - (s[oi + 5] + s[oj + 5]) * nx);
          const un = ux * nx + uy * ny;
          ux -= un * nx;
          uy -= un * ny;
          const us = Math.sqrt(ux * ux + uy * uy + uz * uz);
          if (us > 1e-9) {
            const jt = Math.min(ballFriction(us) * jn, us / 7);
            const k = jt / us;
            const jx = -k * ux;
            const jy = -k * uy;
            const jz = -k * uz;
            s[oi + 2] += jx;
            s[oi + 3] += jy;
            s[oj + 2] -= jx;
            s[oj + 3] -= jy;
            const dwx = ANG * (ny * jz);
            const dwy = ANG * (-nx * jz);
            const dwz = ANG * (nx * jy - ny * jx);
            s[oi + 4] += dwx;
            s[oi + 5] += dwy;
            s[oi + 6] += dwz;
            s[oj + 4] += dwx;
            s[oj + 5] += dwy;
            s[oj + 6] += dwz;
          }
        }
      }
      if (!busy) break;
      for (let k = 0; k < m; k++) {
        const o = k * 7;
        s[o] += s[o + 2] * MICRO_DT;
        s[o + 1] += s[o + 3] * MICRO_DT;
      }
    }
    for (let k = 0; k < m; k++) {
      const b = balls[mem[k]];
      const o = k * 7;
      if (b.vx === s[o + 2] && b.vy === s[o + 3]) continue; // untouched member
      b.vx = s[o + 2];
      b.vy = s[o + 3];
      b.wx = s[o + 4];
      b.wy = s[o + 5];
      b.wz = s[o + 6];
      b.state = 'slide';
    }
  }

  // Cushion impact with inward horizontal normal n (segment normal, or radial for a nose).
  _collideCushion(b, nx, ny, cushionId, feat, time, out) {
    const vn = -(b.vx * nx + b.vy * ny); // speed into the cushion
    if (vn <= 0) return;
    const f = vn / CUSHION_FAST_V;
    const e = E_CUSHION + (E_CUSHION_FAST - E_CUSHION) * (f < 1 ? f : 1);
    // Normal impulse through the centre: no torque.
    const jn = (1 + e) * vn;
    b.vx += jn * nx;
    b.vy += jn * ny;
    // Contact point r = R (-cos th n + sin th z); its velocity u = v + w x r.
    const rx = -NOSE_COS * nx;
    const ry = -NOSE_COS * ny;
    const rz = NOSE_SIN;
    const ux = b.vx + R * (b.wy * rz - b.wz * ry);
    const uy = b.vy + R * (b.wz * rx - b.wx * rz);
    const uz = R * (b.wx * ry - b.wy * rx);
    // Slip in the cushion's tangent plane: along the cushion t = (-ny, nx) and vertically.
    const tx = -ny;
    const ty = nx;
    const st = ux * tx + uy * ty;
    const sz = uz;
    const s = Math.sqrt(st * st + sz * sz);
    if (s > 1e-9) {
      const ht = st / s;
      const hz = sz / s;
      // Slip change per unit impulse along the slip direction: 3.5 along t (linear + angular),
      // 2.5 cos^2 th vertically (angular only, vertical velocity is not modelled).
      const kEff = 3.5 * ht * ht + 2.5 * NOSE_COS * NOSE_COS * hz * hz;
      const j = Math.min(MU_CUSHION * jn, (CUSHION_STICK * s) / kEff);
      const jt = -j * ht;
      const jz = -j * hz;
      const jx = jt * tx;
      const jy = jt * ty;
      b.vx += jx;
      b.vy += jy;
      // dw = r x J / I
      b.wx += ANG * (ry * jz - rz * jy);
      b.wy += ANG * (rz * jx - rx * jz);
      b.wz += ANG * (rx * jy - ry * jx);
    }
    b.state = 'slide';
    if (vn > CUSHION_EVENT_V) {
      this._emit(
        {
          type: 'cushion',
          seq: this._seq++,
          t: time,
          ball: b.id,
          v: vn,
          frozen: this._isFrozen(b.id, feat),
          cushion: cushionId,
        },
        out,
      );
    }
  }

  _pocketBall(b, pocketId, time, out) {
    const v = Math.hypot(b.vx, b.vy);
    b.on = false;
    b.state = 'pocketed';
    b.pocket = pocketId;
    stopBall(b);
    this._emit({ type: 'pocket', seq: this._seq++, t: time, ball: b.id, pocket: pocketId, v }, out);
  }

  _nearestPocket(b) {
    let best = 0;
    let bd = Infinity;
    for (const p of this.table.pockets) {
      const d = Math.hypot(b.x - p.x, b.y - p.y);
      if (d < bd) {
        bd = d;
        best = p.id;
      }
    }
    return best;
  }

  // Direct overlap removal: used for initial positions and after EVENT_CAP. Approaching
  // overlapping pairs are resolved as contacts, then pushed apart along the normal.
  _separate(time, out) {
    const balls = this.balls;
    const g = this._geo;
    const n = balls.length;
    for (let iter = 0; iter < SEPARATE_ITERS; iter++) {
      let moved = false;
      for (let i = 0; i < n; i++) {
        const a = balls[i];
        if (!a.on) continue;
        for (let j = i + 1; j < n; j++) {
          const b = balls[j];
          if (!b.on) continue;
          if (a.vx === 0 && a.vy === 0 && b.vx === 0 && b.vy === 0) continue;
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const d2 = dx * dx + dy * dy;
          if (d2 >= FOUR_R2 * (1 - 1e-9)) continue;
          const d = Math.sqrt(d2);
          const nx = d > 1e-12 ? dx / d : 1;
          const ny = d > 1e-12 ? dy / d : 0;
          if ((a.vx - b.vx) * nx + (a.vy - b.vy) * ny > 0) this._collideBalls(a, b, time, out);
          const push = 0.5 * (TWO_R - d) + 1e-9;
          a.x -= nx * push;
          a.y -= ny * push;
          b.x += nx * push;
          b.y += ny * push;
          moved = true;
        }
      }
      for (let i = 0; i < n; i++) {
        const b = balls[i];
        if (!b.on || (b.vx === 0 && b.vy === 0)) continue;
        for (let s = 0; s < g.segs.length; s++) {
          const f = g.segs[s];
          const d0 = (b.x - f.ax) * f.nx + (b.y - f.ay) * f.ny;
          if (d0 <= 0 || d0 >= R * (1 - 1e-9)) continue;
          const along = (b.x - f.ax) * f.tx + (b.y - f.ay) * f.ty;
          if (along < 0 || along > f.len) continue;
          if (b.vx * f.nx + b.vy * f.ny < 0) this._collideCushion(b, f.nx, f.ny, f.id, s, time, out);
          b.x += f.nx * (R - d0);
          b.y += f.ny * (R - d0);
          moved = true;
        }
        for (let s = 0; s < g.noses.length; s++) {
          const f = g.noses[s];
          const dx = b.x - f.x;
          const dy = b.y - f.y;
          const d2 = dx * dx + dy * dy;
          if (d2 >= f.rr2 * (1 - 1e-9)) continue;
          const d = Math.sqrt(d2) || 1e-12;
          const nx = dx / d;
          const ny = dy / d;
          if (b.vx * nx + b.vy * ny < 0) this._collideCushion(b, nx, ny, f.cushion, g.nSeg + s, time, out);
          b.x += nx * (f.rr - d);
          b.y += ny * (f.rr - d);
          moved = true;
        }
        for (const p of g.pockets) {
          const dx = b.x - p.x;
          const dy = b.y - p.y;
          if (dx * dx + dy * dy <= p.r2) {
            this._pocketBall(b, p.id, time, out);
            break;
          }
        }
      }
      if (!moved) break;
    }
  }

  // Cloth friction, english decay, orientation and state for one substep of length h.
  _friction(h) {
    const orient = this.trackOrientation;
    const balls = this.balls;
    for (let i = 0; i < balls.length; i++) {
      const b = balls[i];
      if (!b.on || b.state === 'rest') continue;
      let vx = b.vx;
      let vy = b.vy;
      let wx = b.wx;
      let wy = b.wy;
      let wz = b.wz;
      if (orient) quatIntegrate(b.q, wx, wy, wz, h);
      // English decays on its own: it does not move the contact point on the cloth.
      if (wz > 0) {
        wz -= SPIN_DECEL * h;
        if (wz < 0) wz = 0;
      } else if (wz < 0) {
        wz += SPIN_DECEL * h;
        if (wz > 0) wz = 0;
      }
      // Contact-point velocity on the cloth.
      const ux = vx - R * wy;
      const uy = vy + R * wx;
      const us = Math.sqrt(ux * ux + uy * uy);
      let rollT = h;
      let sliding = false;
      if (us > SLIP_EPS) {
        // Sliding friction keeps a constant direction while the slip shrinks linearly, so the
        // slide phase is exact; if the slip vanishes inside the step the rest is rolling.
        const tSlip = us / SLIP_DECEL;
        const ts = tSlip < h ? tSlip : h;
        const hx = ux / us;
        const hy = uy / us;
        vx -= SLIDE_ACC * hx * ts;
        vy -= SLIDE_ACC * hy * ts;
        wx -= SLIDE_ALPHA * hy * ts;
        wy += SLIDE_ALPHA * hx * ts;
        if (tSlip < h) rollT = h - tSlip;
        else sliding = true;
      }
      if (!sliding) {
        const sp = Math.sqrt(vx * vx + vy * vy);
        if (sp > 0) {
          const ns = sp - ROLL_DECEL * rollT;
          if (ns <= 0) {
            vx = 0;
            vy = 0;
          } else {
            vx *= ns / sp;
            vy *= ns / sp;
          }
        }
        // Pure rolling: lock the horizontal spin to the velocity (rolling in +x has wy = vx/R).
        wx = -vy / R;
        wy = vx / R;
      }
      let state;
      if (vx * vx + vy * vy < REST_V2 && wx * wx + wy * wy < REST_W2) {
        vx = 0;
        vy = 0;
        wx = 0;
        wy = 0;
        if (wz * wz < REST_W2) {
          wz = 0;
          state = 'rest';
        } else {
          state = 'spin';
        }
      } else {
        state = sliding ? 'slide' : 'roll';
      }
      b.vx = vx;
      b.vy = vy;
      b.wx = wx;
      b.wy = wy;
      b.wz = wz;
      b.state = state;
    }
  }

  _emit(ev, out) {
    this.log.push(ev);
    out.push(ev);
  }

  // Gap between ball and cushion feature f (segments first, then noses).
  _featureGap(b, f) {
    const g = this._geo;
    if (f < g.nSeg) {
      const s = g.segs[f];
      return (b.x - s.ax) * s.nx + (b.y - s.ay) * s.ny - R;
    }
    const n = g.noses[f - g.nSeg];
    return Math.hypot(b.x - n.x, b.y - n.y) - n.rr;
  }

  _findFrozen() {
    const g = this._geo;
    this._frozenBall.length = 0;
    this._frozenFeat.length = 0;
    this._frozenOn.length = 0;
    for (const b of this.balls) {
      if (!b.on) continue;
      for (let f = 0; f < g.nSeg + g.noses.length; f++) {
        if (f < g.nSeg) {
          const s = g.segs[f];
          const along = (b.x - s.ax) * s.tx + (b.y - s.ay) * s.ty;
          if (along < 0 || along > s.len) continue;
        }
        if (Math.abs(this._featureGap(b, f)) <= FROZEN_GAP) {
          this._frozenBall.push(b.id);
          this._frozenFeat.push(f);
          this._frozenOn.push(true);
        }
      }
    }
  }

  _isFrozen(id, feat) {
    const fb = this._frozenBall;
    for (let k = 0; k < fb.length; k++) {
      if (fb[k] === id && this._frozenFeat[k] === feat) return this._frozenOn[k];
    }
    return false;
  }
}

// Headless, deterministic simulation of one shot (used by the AI). balls: [{id, x, y, on}].
// Runs until nothing rolls or slides (or opts.maxT) and returns {log, final, t}.
export function simulateShot(balls, shot, opts = {}) {
  const dt = opts.dt ?? AI_DT;
  const maxT = opts.maxT ?? MAX_SHOT_T;
  const table = opts.table ?? TABLE;
  const w = new World(table);
  w.trackOrientation = false;
  w.maxT = maxT;
  w.setBalls(balls);
  w.strike(shot);
  let guard = Math.ceil(maxT / dt) + 2;
  while (!w.atRest() && guard-- > 0) w.step(dt);
  if (!w.atRest()) w._forceRest();
  return { log: w.log, final: w.snapshot(), t: w.t };
}
