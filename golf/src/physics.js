// Golf ball physics: flight, bounce, roll, cup, trees and flagstick. Pure module: no DOM, no
// clock, no Math.random (the per-shot rng is mulberry32(seed)), so a shot simulated twice with the
// same inputs gives bit-identical results.
//
// Model (SI units, +z up, R = ball radius; impulses are per unit mass, so m never appears):
//
// * Flight: RK4 on (p, v) at DT_AIR with the aero forces of aero.js; spin is held constant within
//   a step and decays as exp(-dt/SPIN_TAU). When z - R - ground changes sign the step is bisected
//   (8 halvings, re-integrating from the start of the step) to find the time of impact.
// * Bounce (Penner crater model, 3D): the impact normal is tilted back toward the incoming ball by
//   the crater angle, restitution falls with normal speed, and friction is the smaller of mu*Jn
//   (sliding through the impact) and the 2/7 |slip| that brings the contact point to rest
//   (rolling at separation). Spin gets the matching torque, so backspin can reverse the ball.
// * Ground: the ball is held on the surface. While the contact point slips it skids (friction
//   muS g n_z opposes the slip, and slip decays 7/2 times faster than v because spin also
//   changes); then it rolls with a = (5/7) g_t - (a0 + kv|v|) v_hat. The 5/7 is the rolling
//   sphere's effective inertia. It rests when slow and the slope cannot overcome a0 (static hold).
//   If the surface drops away faster than free fall (a crest) the ball takes off again.
// * Cup: swept segment against the cup circle each ground step (no tunnelling at any speed). The
//   ball is captured if it can fall R before crossing the chord: v <= 2 sqrt(CUP_R^2 - b^2) / t_fall.
// * Trees: trunks are hard cylinders; canopies are ellipsoids the ball may pass through, with a hit
//   probability that grows with the path length inside.

import {
  BALL_R,
  G,
  DT_AIR,
  DT_GROUND,
  MAX_SHOT_T,
  RECORD_HZ,
  SURF,
  SURFACES,
  CUP_R,
  FLAGSTICK_H,
  FLAGSTICK_R,
  SPIN_TAU,
} from './constants.js';
import { flightAccel } from './aero.js';
import { mulberry32 } from './rng.js';

const R = BALL_R;
const DEG = Math.PI / 180;
const T_FALL = Math.sqrt((2 * R) / G); // time to fall one ball radius into the cup
const CUP_DEPTH = 0.1016;
const SLIP_EPS = 0.01; // m/s contact slip below which the ball rolls
const REST_V = 0.01; // m/s
const STALL_V = 0.03; // m/s: below this a ball may be creeping, see the stall test
const STALL_T = 0.5; // s
const STALL_D = 0.015; // m moved over STALL_T below which a creeping ball counts as stopped
const LAND_VN = 0.5; // m/s outgoing normal speed below which a bounce becomes ground contact
const CREST_EPS = 2e-5; // m the free-fall path must clear the ground by to take off from a crest
const TRUNK_E = 0.4;
const TREE_QUERY_R = 12; // m search radius for treesNear (covers trunk + canopy radius)
const ZERO_WIND = { x: 0, y: 0 };

const surfOf = (id) => SURFACES[id] || SURFACES[SURF.ROUGH];

// ---------------------------------------------------------------------------------------------
// Flight

const _st = { v: { x: 0, y: 0, z: 0 }, w: null, zAgl: 0 };
const _a1 = { x: 0, y: 0, z: 0 };
const _a2 = { x: 0, y: 0, z: 0 };
const _a3 = { x: 0, y: 0, z: 0 };
const _a4 = { x: 0, y: 0, z: 0 };

function accel(pz, vx, vy, vz, w, wind, gz, out) {
  _st.v.x = vx;
  _st.v.y = vy;
  _st.v.z = vz;
  _st.w = w;
  _st.zAgl = pz - gz;
  return flightAccel(_st, wind, out);
}

// One RK4 step of length dt for s = {p, v, w}, in place. groundZ is the terrain height under the
// ball (used for the wind profile). Spin decays after the step.
export function flightStep(s, dt, wind = ZERO_WIND, groundZ = 0) {
  const p = s.p;
  const v = s.v;
  const w = s.w;
  const h = dt / 2;
  const a1 = accel(p.z, v.x, v.y, v.z, w, wind, groundZ, _a1);
  const v2x = v.x + a1.x * h;
  const v2y = v.y + a1.y * h;
  const v2z = v.z + a1.z * h;
  const a2 = accel(p.z + v.z * h, v2x, v2y, v2z, w, wind, groundZ, _a2);
  const v3x = v.x + a2.x * h;
  const v3y = v.y + a2.y * h;
  const v3z = v.z + a2.z * h;
  const a3 = accel(p.z + v2z * h, v3x, v3y, v3z, w, wind, groundZ, _a3);
  const v4x = v.x + a3.x * dt;
  const v4y = v.y + a3.y * dt;
  const v4z = v.z + a3.z * dt;
  const a4 = accel(p.z + v3z * dt, v4x, v4y, v4z, w, wind, groundZ, _a4);
  const k = dt / 6;
  p.x += k * (v.x + 2 * v2x + 2 * v3x + v4x);
  p.y += k * (v.y + 2 * v2y + 2 * v3y + v4y);
  p.z += k * (v.z + 2 * v2z + 2 * v3z + v4z);
  v.x += k * (a1.x + 2 * a2.x + 2 * a3.x + a4.x);
  v.y += k * (a1.y + 2 * a2.y + 2 * a3.y + a4.y);
  v.z += k * (a1.z + 2 * a2.z + 2 * a3.z + a4.z);
  const decay = Math.exp(-dt / SPIN_TAU);
  w.x *= decay;
  w.y *= decay;
  w.z *= decay;
  return s;
}

// ---------------------------------------------------------------------------------------------
// Bounce

// Penner crater bounce off a surface with unit normal n, in place on v and w.
// surf is a SURFACES entry. Returns the outgoing speed along the true normal n.
export function bounceImpulse(v, w, n, surf) {
  const vdn = v.x * n.x + v.y * n.y + v.z * n.z;
  if (vdn >= 0) return vdn; // moving away: no contact
  const vnIn = -vdn;
  const hx0 = v.x;
  const hy0 = v.y;
  // Tangential velocity and impact angle against the undeformed surface.
  const tx = v.x + vnIn * n.x;
  const ty = v.y + vnIn * n.y;
  const tz = v.z + vnIn * n.z;
  const vt = Math.sqrt(tx * tx + ty * ty + tz * tz);
  const speed = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
  // 1. Crater: the ball digs a pit whose back wall faces it; tilt n toward -v_t.
  let nx = n.x;
  let ny = n.y;
  let nz = n.z;
  if (vt > 1e-9) {
    const thIn = Math.atan2(vnIn, vt) / DEG;
    const thC = Math.min(28, 15.4 * (speed / 18.6) * (thIn / 44.4) * surf.crater) * DEG;
    const c = Math.cos(thC);
    const s = Math.sin(thC) / vt;
    nx = n.x * c - tx * s;
    ny = n.y * c - ty * s;
    nz = n.z * c - tz * s;
  }
  // 2. Restitution against the crater normal.
  const vn = -(v.x * nx + v.y * ny + v.z * nz);
  if (vn <= 0) return v.x * n.x + v.y * n.y + v.z * n.z;
  const e = (vn <= 20 ? 0.51 - 0.0375 * vn + 0.000903 * vn * vn : 0.12) * surf.e;
  const Jn = (1 + e) * vn;
  // 3. Friction: slip of the contact point (r = -R n_eff) in the crater tangent plane.
  w.x *= surf.spinKeep;
  w.y *= surf.spinKeep;
  w.z *= surf.spinKeep;
  const ux = v.x + vn * nx;
  const uy = v.y + vn * ny;
  const uz = v.z + vn * nz;
  // w x (-R n) = R (n x w)
  const sx = ux + R * (ny * w.z - nz * w.y);
  const sy = uy + R * (nz * w.x - nx * w.z);
  const sz = uz + R * (nx * w.y - ny * w.x);
  const sl = Math.sqrt(sx * sx + sy * sy + sz * sz);
  let jx = 0;
  let jy = 0;
  let jz = 0;
  if (sl > 1e-9) {
    const jt = Math.min(surf.mu * Jn, (2 / 7) * sl) / sl;
    jx = -jt * sx;
    jy = -jt * sy;
    jz = -jt * sz;
  }
  // 4. Apply: v += Jn n_eff + Jt, w += 5/(2R) (-n_eff x Jt).
  v.x += Jn * nx + jx;
  v.y += Jn * ny + jy;
  v.z += Jn * nz + jz;
  const k = 5 / (2 * R);
  w.x += k * -(ny * jz - nz * jy);
  w.y += k * -(nz * jx - nx * jz);
  w.z += k * -(nx * jy - ny * jx);
  // Extension: soft surfaces (sand) also plough, losing a fraction of the outgoing tangential
  // speed that the rigid-contact Coulomb model cannot remove (it stops at rolling, 5/7 of v_t).
  if (surf.plough) {
    const on = v.x * n.x + v.y * n.y + v.z * n.z;
    const f = 1 - surf.plough;
    v.x = on * n.x + (v.x - on * n.x) * f;
    v.y = on * n.y + (v.y - on * n.y) * f;
    v.z = on * n.z + (v.z - on * n.z) * f;
    w.x *= f;
    w.y *= f;
    w.z *= f;
  }
  // 5. Cap the reverse horizontal speed (grass and turf can only grab so much).
  const h0 = Math.hypot(hx0, hy0);
  if (h0 > 1e-9) {
    const dx = hx0 / h0;
    const dy = hy0 / h0;
    const along = v.x * dx + v.y * dy;
    if (along < -surf.maxBack) {
      v.x -= (along + surf.maxBack) * dx;
      v.y -= (along + surf.maxBack) * dy;
    }
  }
  return v.x * n.x + v.y * n.y + v.z * n.z;
}

// ---------------------------------------------------------------------------------------------
// Ground

// One ground step of length dt for s = {p, v, w} on a surface with unit normal n, gravity only
// (no position update; simulateShot moves and re-seats the ball). Returns true while skidding.
export function rollStep(s, n, surf, dt = DT_GROUND) {
  const v = s.v;
  const w = s.w;
  // Keep v in the tangent plane.
  const vdn = v.x * n.x + v.y * n.y + v.z * n.z;
  v.x -= vdn * n.x;
  v.y -= vdn * n.y;
  v.z -= vdn * n.z;
  // Gravity projected on the tangent plane: g_t = g - (g.n) n with g = (0, 0, -G).
  const gtx = G * n.z * n.x;
  const gty = G * n.z * n.y;
  const gtz = -G + G * n.z * n.z;
  // Contact slip s = v + w x (-R n) = v + R (n x w).
  const sx = v.x + R * (n.y * w.z - n.z * w.y);
  const sy = v.y + R * (n.z * w.x - n.x * w.z);
  const sz = v.z + R * (n.x * w.y - n.y * w.x);
  const sl = Math.sqrt(sx * sx + sy * sy + sz * sz);
  const k = 5 / (2 * R);
  if (sl > SLIP_EPS) {
    const aF = surf.muS * G * Math.max(n.z, 0.2);
    if (3.5 * aF * dt >= sl) {
      // Friction stops the slip within this step: apply the exact impulse -(2/7) s.
      const jx = -(2 / 7) * sx;
      const jy = -(2 / 7) * sy;
      const jz = -(2 / 7) * sz;
      v.x += jx + (5 / 7) * gtx * dt;
      v.y += jy + (5 / 7) * gty * dt;
      v.z += jz + (5 / 7) * gtz * dt;
      w.x += k * -(n.y * jz - n.z * jy);
      w.y += k * -(n.z * jx - n.x * jz);
      w.z += k * -(n.x * jy - n.y * jx);
      return false;
    }
    const fx = (-aF * sx) / sl;
    const fy = (-aF * sy) / sl;
    const fz = (-aF * sz) / sl;
    v.x += (gtx + fx) * dt;
    v.y += (gty + fy) * dt;
    v.z += (gtz + fz) * dt;
    w.x += k * -(n.y * fz - n.z * fy) * dt;
    w.y += k * -(n.z * fx - n.x * fz) * dt;
    w.z += k * -(n.x * fy - n.y * fx) * dt;
    return true;
  }
  // Pure roll. Semi-implicit: gravity first, then resistance that can stop but never reverse.
  v.x += (5 / 7) * gtx * dt;
  v.y += (5 / 7) * gty * dt;
  v.z += (5 / 7) * gtz * dt;
  const sp = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
  const dec = (surf.a0 + surf.kv * sp) * dt;
  if (dec >= sp) {
    v.x = 0;
    v.y = 0;
    v.z = 0;
  } else {
    const f = (sp - dec) / sp;
    v.x *= f;
    v.y *= f;
    v.z *= f;
  }
  // Rolling without slip: w = (n x v) / R (sidespin about n is dropped on the ground).
  w.x = (n.y * v.z - n.z * v.y) / R;
  w.y = (n.z * v.x - n.x * v.z) / R;
  w.z = (n.x * v.y - n.y * v.x) / R;
  return false;
}

// Flat-ground roll-out distance from speed v0 in pure roll: integrating dv/dx = -(a0 + kv v)/v
// gives D = v0/kv - (a0/kv^2) ln(1 + kv v0 / a0).
export function stimpDistance(v0, surf) {
  if (v0 <= 0) return 0;
  const { a0, kv } = surf;
  if (kv < 1e-9) return (v0 * v0) / (2 * a0);
  return v0 / kv - (a0 / (kv * kv)) * Math.log(1 + (kv * v0) / a0);
}

// Inverse of stimpDistance by bisection: the pure-roll start speed that rolls D metres on flat.
export function puttSpeedForDistance(D, surf) {
  if (D <= 0) return 0;
  let lo = 0;
  let hi = 1;
  while (stimpDistance(hi, surf) < D && hi < 200) hi *= 2;
  for (let i = 0; i < 60; i++) {
    const mid = 0.5 * (lo + hi);
    if (stimpDistance(mid, surf) < D) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

// ---------------------------------------------------------------------------------------------
// Cup

// Swept test of the ball centre moving p0 -> p1 (horizontal) against the cup circle (radius CUP_R
// around cup.x, cup.y). Returns null if the segment misses the circle, else
//   {holed, lipout, b, vCap}
// where b is the signed offset of the path from the cup centre (+ = ball passes RIGHT of centre).
// When not holed, v is deflected in place by sign(b) min(35, 40 (|b|/CUP_R)(vCap/v)) degrees
// (toward the offset side, i.e. away from the hole) and slowed by (1 - 0.25 vCap/v).
export function cupCheck(p0, p1, v, cup) {
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const cx = cup.x - p0.x;
  const cy = cup.y - p0.y;
  const L2 = dx * dx + dy * dy;
  let tau = L2 > 0 ? (cx * dx + cy * dy) / L2 : 0;
  tau = tau < 0 ? 0 : tau > 1 ? 1 : tau;
  const qx = p0.x + dx * tau - cup.x;
  const qy = p0.y + dy * tau - cup.y;
  if (qx * qx + qy * qy > CUP_R * CUP_R) return null;
  const sp = Math.hypot(v.x, v.y);
  let b = 0;
  if (L2 > 0) {
    const L = Math.sqrt(L2);
    // cross(d, c - p0) > 0 when the cup is to the left, i.e. the ball passes right of it.
    b = (dx * cy - dy * cx) / L;
  }
  const ab = Math.min(Math.abs(b), CUP_R);
  const vCap = (2 * Math.sqrt(CUP_R * CUP_R - ab * ab)) / T_FALL;
  if (sp <= vCap) return { holed: true, lipout: false, b, vCap };
  const ang = (b >= 0 ? 1 : -1) * Math.min(35, 40 * (ab / CUP_R) * (vCap / sp)) * DEG;
  // Positive ang turns clockwise (to the right): yaw is counter-clockwise positive.
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  const vx = v.x * c + v.y * s;
  const vy = -v.x * s + v.y * c;
  const f = 1 - (0.25 * vCap) / sp;
  v.x = vx * f;
  v.y = vy * f;
  if (v.z !== undefined) v.z *= f;
  return { holed: false, lipout: ab > 0.4 * CUP_R, b, vCap };
}

// ---------------------------------------------------------------------------------------------
// Trees

// Geometry of the ball centre moving p0 -> p1 against one tree. tree = {x, y, z, trunkR, trunkH,
// canopy:{cz, rx, rz}}; z is the ground at the trunk and canopy.cz is the ABSOLUTE world z of the
// canopy centre (the HoleTerrain convention, also used by the renderer). Returns null,
// {kind:'trunk', tau, nx, ny, rr, inside} (tau = segment fraction at contact, n = outward
// horizontal normal, rr = trunk radius + R; inside: p0 already overlapped the trunk),
// {kind:'cap', tau, nx, ny, rr, top} (the ball dropped onto the top of the trunk, where the
// branches fork) or {kind:'canopy', len} (p1 inside the canopy; len = chord length of the line
// through the ellipsoid along the direction of travel).
export function treeHit(tree, p0, p1) {
  const base = tree.z || 0;
  // Trunk: swept circle of radius trunkR + R in the horizontal plane.
  const rr = (tree.trunkR || 0) + R;
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const fx = p0.x - tree.x;
  const fy = p0.y - tree.y;
  const a = dx * dx + dy * dy;
  const c0 = fx * fx + fy * fy - rr * rr;
  if (rr > R) {
    const top = base + (tree.trunkH || 0);
    // Cap: the segment falls through the top of the trunk inside its radius.
    if (p0.z > top && p1.z <= top) {
      const tt = (p0.z - top) / (p0.z - p1.z);
      const hx = fx + dx * tt;
      const hy = fy + dy * tt;
      if (hx * hx + hy * hy <= rr * rr) {
        const hl = Math.hypot(hx, hy);
        const ml = Math.sqrt(a);
        // Outward from the axis; dead centre: the way the ball was travelling.
        const nx = hl > 1e-6 ? hx / hl : ml > 1e-9 ? dx / ml : 1;
        const ny = hl > 1e-6 ? hy / hl : ml > 1e-9 ? dy / ml : 0;
        return { kind: 'cap', tau: tt, nx, ny, rr, top };
      }
    }
    let tau = -1;
    if (c0 <= 0) tau = 0;
    else if (a > 0) {
      const bq = fx * dx + fy * dy;
      const disc = bq * bq - a * c0;
      if (bq < 0 && disc >= 0) {
        const t = (-bq - Math.sqrt(disc)) / a;
        if (t <= 1) tau = t;
      }
    }
    if (tau >= 0) {
      const z = p0.z + (p1.z - p0.z) * tau;
      if (z >= base - R && z <= top) {
        const hx = fx + dx * tau;
        const hy = fy + dy * tau;
        const hl = Math.hypot(hx, hy) || 1;
        return { kind: 'trunk', tau, nx: hx / hl, ny: hy / hl, rr, inside: c0 <= 0 };
      }
    }
  }
  const cp = tree.canopy;
  if (cp && cp.rx > 0 && cp.rz > 0) {
    const qx = (p1.x - tree.x) / cp.rx;
    const qy = (p1.y - tree.y) / cp.rx;
    const qz = (p1.z - cp.cz) / cp.rz;
    const c = qx * qx + qy * qy + qz * qz - 1;
    if (c < 0) {
      const dz = p1.z - p0.z;
      const dl = Math.sqrt(a + dz * dz) || 1;
      const ex = dx / dl / cp.rx;
      const ey = dy / dl / cp.rx;
      const ez = dz / dl / cp.rz;
      const aa = ex * ex + ey * ey + ez * ez;
      const bb = qx * ex + qy * ey + qz * ez;
      const disc = bb * bb - aa * c;
      const len = aa > 0 ? (2 * Math.sqrt(Math.max(0, disc))) / aa : 0;
      return { kind: 'canopy', len };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Synthetic terrain (calibration, tests and caddie tables)

// A HoleTerrain-compatible plane: z = z0 + sx x + sy y with one surface, or custom heightFn /
// surfaceFn / waterFn / oobFn. trees is an array of tree objects; cup {x,y,z} or null.
export function planeTerrain({
  surface = SURF.FAIRWAY,
  sx = 0,
  sy = 0,
  z0 = 0,
  cup = null,
  heightFn = null,
  surfaceFn = null,
  waterFn = null,
  oobFn = null,
  trees = [],
} = {}) {
  const heightAt = heightFn || ((x, y) => z0 + sx * x + sy * y);
  const gradAt = (x, y, out = { x: 0, y: 0 }) => {
    if (!heightFn) {
      out.x = sx;
      out.y = sy;
      return out;
    }
    const e = 0.01;
    out.x = (heightAt(x + e, y) - heightAt(x - e, y)) / (2 * e);
    out.y = (heightAt(x, y + e) - heightAt(x, y - e)) / (2 * e);
    return out;
  };
  for (const t of trees) if (t.z === undefined) t.z = heightAt(t.x, t.y);
  return {
    cup,
    trees,
    waters: [],
    heightAt,
    gradAt,
    normalAt(x, y) {
      const g = gradAt(x, y);
      const l = Math.sqrt(g.x * g.x + g.y * g.y + 1);
      return { x: -g.x / l, y: -g.y / l, z: 1 / l };
    },
    surfaceAt: surfaceFn || (() => surface),
    isOOB: oobFn || (() => false),
    waterAt: waterFn || (() => null),
    treesNear(x, y, r) {
      return trees.filter((t) => Math.hypot(t.x - x, t.y - y) <= r);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Whole shot

// simulateShot(terrain, launch, {wind, seed, maxT, record, pin}) -> ShotResult (see
// docs/architecture.md section 2). Extra option pin (default: true unless the launch is a putt)
// enables the flagstick for balls in the air. apex is the highest ball-centre height above the
// launch point. waterEntry is where the ball's path last crossed into the water (refined by
// bisection on surfaceAt); lastDry is the last sampled ball position over dry ground.
export function simulateShot(terrain, launch, opts = {}) {
  const wind = opts.wind || ZERO_WIND;
  const maxT = opts.maxT ?? MAX_SHOT_T;
  const record = opts.record !== false;
  const rng = mulberry32(opts.seed ?? 1);
  const cup = terrain.cup || null;
  const pinOn = opts.pin ?? launch.mode !== 'roll';
  const hasTrees = !!(terrain.treesNear && terrain.trees && terrain.trees.length);

  const s = {
    p: { x: launch.pos.x, y: launch.pos.y, z: launch.pos.z },
    v: { x: launch.vel.x, y: launch.vel.y, z: launch.vel.z },
    w: { x: launch.spin ? launch.spin.x : 0, y: launch.spin ? launch.spin.y : 0, z: launch.spin ? launch.spin.z : 0 },
  };
  const p = s.p;
  const v = s.v;
  const w = s.w;

  // Ground probe: height (raised to the water level over water) and surface under (x, y).
  let gz = 0;
  let gs = 0;
  const probe = (x, y) => {
    gs = terrain.surfaceAt(x, y);
    gz = terrain.heightAt(x, y);
    if (gs === SURF.WATER && terrain.waterAt) {
      const wa = terrain.waterAt(x, y);
      if (wa && wa.level > gz) gz = wa.level;
    }
  };

  probe(p.x, p.y);
  if (p.z < gz + R) p.z = gz + R;
  const start = { x: p.x, y: p.y, z: p.z };

  const path = [];
  const events = [];
  let t = 0;
  let nextRec = 0;
  let lastRecT = -1;
  const rec = (force) => {
    if (!record) return;
    if (force ? t > lastRecT : t >= nextRec - 1e-9) {
      path.push(t, p.x, p.y, p.z);
      lastRecT = t;
      if (!force) nextRec += 1 / RECORD_HZ;
      while (nextRec <= t) nextRec += 1 / RECORD_HZ;
    }
  };
  const speed = () => Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
  const emit = (type, surface = gs, sp = speed(), extra = null) => {
    rec(true);
    const ev = { type, t, x: p.x, y: p.y, z: p.z, surface, v: sp };
    if (extra) Object.assign(ev, extra);
    events.push(ev);
  };

  let mode = launch.mode === 'roll' ? 'ground' : 'air';
  let outcome = null;
  let landing = null;
  let carry = 0;
  let apexZ = p.z;
  let dryX = gs !== SURF.WATER ? p.x : NaN;
  let dryY = gs !== SURF.WATER ? p.y : NaN;
  let waterEntry = null;
  let lastDry = null;
  let cupInside = false;
  let pinInside = false;
  const canopyInside = new Set();
  let n = terrain.normalAt(p.x, p.y);
  // Slope (dz per horizontal metre) the ball actually followed on its last ground step.
  let slopeAct = 0;
  const seatSlope = () => {
    const vh = Math.hypot(v.x, v.y);
    slopeAct = vh > 1e-9 ? v.z / vh : 0;
  };

  emit('launch');

  if (mode === 'ground') {
    p.z = gz + R;
    const d = v.x * n.x + v.y * n.y + v.z * n.z;
    v.x -= d * n.x;
    v.y -= d * n.y;
    v.z -= d * n.z;
    // Putts start in pure roll.
    w.x = (n.y * v.z - n.z * v.y) / R;
    w.y = (n.z * v.x - n.x * v.z) / R;
    w.z = (n.x * v.y - n.y * v.x) / R;
    seatSlope();
  }

  const trackDry = () => {
    if (gs !== SURF.WATER) {
      dryX = p.x;
      dryY = p.y;
    }
  };

  const enterWater = () => {
    // Refine the margin crossing between the last dry sample and the splash point.
    if (Number.isFinite(dryX)) {
      lastDry = { x: dryX, y: dryY };
      let ax = dryX;
      let ay = dryY;
      let bx = p.x;
      let by = p.y;
      for (let i = 0; i < 10; i++) {
        const mx = 0.5 * (ax + bx);
        const my = 0.5 * (ay + by);
        if (terrain.surfaceAt(mx, my) === SURF.WATER) {
          bx = mx;
          by = my;
        } else {
          ax = mx;
          ay = my;
        }
      }
      waterEntry = { x: bx, y: by };
    } else {
      waterEntry = { x: p.x, y: p.y };
    }
    outcome = 'water';
    emit('water', SURF.WATER);
  };

  const holeOut = () => {
    outcome = 'holed';
    emit('cup', gs);
    // Short drop animation: slide to the cup centre, then sink.
    const t0 = t;
    t = t0 + 0.05;
    p.x = cup.x;
    p.y = cup.y;
    p.z = cup.z + R;
    rec(true);
    t = t0 + 0.15;
    p.z = cup.z - CUP_DEPTH + R;
    v.x = v.y = v.z = 0;
    rec(true);
  };

  // Trees and flagstick against the segment p0 -> p. Returns true if the state was changed.
  const p0 = { x: 0, y: 0, z: 0 };
  const obstacles = (inAir) => {
    if (inAir && pinOn && cup) {
      const hx = p.x - cup.x;
      const hy = p.y - cup.y;
      const rr = FLAGSTICK_R + R;
      const inside = hx * hx + hy * hy < rr * rr && p.z > cup.z && p.z < cup.z + FLAGSTICK_H;
      if (inside && !pinInside) {
        // Bounce off the stick: reflect the radial part with e ~0.35, keep some tangential.
        const hl = Math.hypot(hx, hy) || 1;
        const nx = hl > 1e-6 ? hx / hl : -v.x / (Math.hypot(v.x, v.y) || 1);
        const ny = hl > 1e-6 ? hy / hl : -v.y / (Math.hypot(v.x, v.y) || 1);
        const vn = v.x * nx + v.y * ny;
        if (vn < 0) {
          const tx = v.x - vn * nx;
          const ty = v.y - vn * ny;
          v.x = -0.35 * vn * nx + 0.6 * tx;
          v.y = -0.35 * vn * ny + 0.6 * ty;
          emit('pin');
        }
      }
      pinInside = inside;
    }
    if (!hasTrees) return false;
    const list = terrain.treesNear(p.x, p.y, TREE_QUERY_R);
    let changed = false;
    for (let i = 0; i < list.length; i++) {
      const tr = list[i];
      if (tr.z === undefined) tr.z = terrain.heightAt(tr.x, tr.y);
      const hit = treeHit(tr, p0, p);
      if (!hit) {
        canopyInside.delete(tr);
        continue;
      }
      if (hit.kind === 'cap') {
        // Dropped onto the top of the trunk, where the limbs fork: it glances off outward with a
        // small hop, losing most of its speed (no ball may perch on the trunk).
        const sp = speed();
        p.x = tr.x + hit.nx * (hit.rr + 1e-3);
        p.y = tr.y + hit.ny * (hit.rr + 1e-3);
        p.z = hit.top + R;
        const out = 0.3 * sp;
        v.x = 0.3 * v.x + out * hit.nx;
        v.y = 0.3 * v.y + out * hit.ny;
        v.z = Math.max(0, -v.z) * 0.15;
        w.x *= 0.5;
        w.y *= 0.5;
        w.z *= 0.5;
        emit('tree', gs);
        changed = true;
        continue;
      }
      if (hit.kind === 'trunk') {
        let nx = hit.nx;
        let ny = hit.ny;
        if (hit.inside) {
          // Already overlapping the trunk at the start of the step: push it out radially and keep
          // this step's motion (resetting to p0 would pin it there while gravity builds up).
          const ox = p.x - tr.x;
          const oy = p.y - tr.y;
          const ol = Math.hypot(ox, oy);
          if (ol > 1e-6) {
            nx = ox / ol;
            ny = oy / ol;
          }
          if (ol < hit.rr) {
            p.x = tr.x + nx * (hit.rr + 1e-3);
            p.y = tr.y + ny * (hit.rr + 1e-3);
          }
        } else {
          // Hard cylinder: move to the contact point and reflect the radial velocity.
          p.x = p0.x + (p.x - p0.x) * hit.tau + nx * 1e-3;
          p.y = p0.y + (p.y - p0.y) * hit.tau + ny * 1e-3;
          p.z = p0.z + (p.z - p0.z) * hit.tau;
        }
        const vn = v.x * nx + v.y * ny;
        if (vn < 0) {
          v.x -= (1 + TRUNK_E) * vn * nx;
          v.y -= (1 + TRUNK_E) * vn * ny;
          v.x *= 0.8;
          v.y *= 0.8;
          w.x *= 0.5;
          w.y *= 0.5;
          w.z *= 0.5;
          emit('tree', gs);
          changed = true;
        }
        continue;
      }
      // Canopy: one roll per traversal.
      if (!inAir || canopyInside.has(tr)) continue;
      canopyInside.add(tr);
      if (rng() < 1 - Math.exp(-hit.len / 3)) {
        const sp = speed();
        if (sp < 1e-6) continue;
        const keep = 0.25 + 0.2 * rng();
        // Random direction in a 60 degree cone (30 degree half-angle) around v, biased down.
        const dx = v.x / sp;
        const dy = v.y / sp;
        const dz = v.z / sp;
        const ax = Math.abs(dz) < 0.9 ? 0 : 1;
        const ay = 0;
        const az = Math.abs(dz) < 0.9 ? 1 : 0;
        // e1 = normalize(a x d), e2 = d x e1
        let e1x = ay * dz - az * dy;
        let e1y = az * dx - ax * dz;
        let e1z = ax * dy - ay * dx;
        const e1l = Math.hypot(e1x, e1y, e1z) || 1;
        e1x /= e1l;
        e1y /= e1l;
        e1z /= e1l;
        const e2x = dy * e1z - dz * e1y;
        const e2y = dz * e1x - dx * e1z;
        const e2z = dx * e1y - dy * e1x;
        const cosT = 1 - rng() * (1 - Math.cos(30 * DEG));
        const sinT = Math.sqrt(1 - cosT * cosT);
        const phi = 2 * Math.PI * rng();
        const nx = cosT * dx + sinT * (Math.cos(phi) * e1x + Math.sin(phi) * e2x);
        const ny = cosT * dy + sinT * (Math.cos(phi) * e1y + Math.sin(phi) * e2y);
        const nz = cosT * dz + sinT * (Math.cos(phi) * e1z + Math.sin(phi) * e2z) - 0.35;
        const nl = Math.hypot(nx, ny, nz) || 1;
        const ns = (sp * keep) / nl;
        v.x = nx * ns;
        v.y = ny * ns;
        v.z = nz * ns;
        w.x *= 0.3;
        w.y *= 0.3;
        w.z *= 0.3;
        emit('tree', gs);
        changed = true;
      }
    }
    return changed;
  };

  const saved = { p: { x: 0, y: 0, z: 0 }, v: { x: 0, y: 0, z: 0 }, w: { x: 0, y: 0, z: 0 } };
  const save = () => {
    saved.p.x = p.x; saved.p.y = p.y; saved.p.z = p.z;
    saved.v.x = v.x; saved.v.y = v.y; saved.v.z = v.z;
    saved.w.x = w.x; saved.w.y = w.y; saved.w.z = w.z;
  };
  const restore = () => {
    p.x = saved.p.x; p.y = saved.p.y; p.z = saved.p.z;
    v.x = saved.v.x; v.y = saved.v.y; v.z = saved.v.z;
    w.x = saved.w.x; w.y = saved.w.y; w.z = saved.w.z;
  };

  // Ball meets the ground at the current state (z already seated on gz + R).
  const impact = () => {
    const surf = surfOf(gs);
    n = terrain.normalAt(p.x, p.y);
    const vnIn = -(v.x * n.x + v.y * n.y + v.z * n.z);
    const vh = Math.hypot(v.x, v.y);
    // A rolled launch (putt) never "lands": a hop off a crest is just a bounce.
    const first = !landing && launch.mode !== 'roll';
    if (first) {
      landing = { x: p.x, y: p.y, z: p.z };
      carry = Math.hypot(p.x - start.x, p.y - start.y);
    }
    if (gs === SURF.WATER) {
      enterWater();
      return;
    }
    // Impact events also carry the descent angle below horizontal (deg).
    const angle = Math.atan2(-v.z, vh) / DEG;
    if (first) emit('land', gs, speed(), { angle });
    // Slam dunk: dropping into the hole on the fly.
    if (cup && vh < 3 && Math.hypot(p.x - cup.x, p.y - cup.y) < CUP_R - R) {
      holeOut();
      return;
    }
    if (!first && vnIn < LAND_VN) {
      // Soft touchdown after a small hop (crest or kink): just follow the ground again.
      mode = 'ground';
    } else {
      if (!first) emit('bounce', gs, speed(), { angle });
      const out = bounceImpulse(v, w, n, surf);
      if (out < LAND_VN) mode = 'ground';
    }
    if (mode === 'ground') {
      const d = v.x * n.x + v.y * n.y + v.z * n.z;
      v.x -= d * n.x;
      v.y -= d * n.y;
      v.z -= d * n.z;
      seatSlope();
    }
  };

  const finishRest = () => {
    if (cup && Math.hypot(p.x - cup.x, p.y - cup.y) < CUP_R && Math.abs(p.z - R - cup.z) < 0.1) {
      holeOut();
      return;
    }
    v.x = v.y = v.z = 0;
    outcome = gs === SURF.OOB || (terrain.isOOB && terrain.isOOB(p.x, p.y)) ? 'ob' : 'rest';
    emit('rest', gs, 0);
  };

  const grad = { x: 0, y: 0 };
  let stallT = -1;
  let stallX = 0;
  let stallY = 0;
  let stallV = 0;

  while (!outcome) {
    if (t >= maxT) {
      finishRest();
      break;
    }
    p0.x = p.x;
    p0.y = p.y;
    p0.z = p.z;
    if (mode === 'air') {
      const gz0 = gz;
      stallT = -1;
      save();
      flightStep(s, DT_AIR, wind, gz0);
      t += DT_AIR;
      if (obstacles(true)) {
        probe(p.x, p.y);
        if (p.z < gz + R) p.z = gz + R;
        rec(false);
        continue;
      }
      probe(p.x, p.y);
      if (p.z - R < gz) {
        // Bisect for the time of impact, re-integrating from the start of the step.
        let lo = 0;
        let hi = DT_AIR;
        for (let i = 0; i < 8; i++) {
          const mid = 0.5 * (lo + hi);
          restore();
          flightStep(s, mid, wind, gz0);
          probe(p.x, p.y);
          if (p.z - R < gz) hi = mid;
          else lo = mid;
        }
        restore();
        flightStep(s, hi, wind, gz0);
        probe(p.x, p.y);
        t += hi - DT_AIR;
        p.z = gz + R;
        impact();
        if (outcome) break;
      } else {
        if (p.z > apexZ) apexZ = p.z;
        trackDry();
      }
      rec(false);
      continue;
    }

    // ---- ground ----
    const surf = surfOf(gs);
    n = terrain.normalAt(p.x, p.y);
    const skidding = rollStep(s, n, surf, DT_GROUND);
    const sp = speed();
    if (!skidding && sp < REST_V) {
      // Static hold: the same downhill pull rollStep applies, (5/7) g sin(theta), against a0.
      const gr = terrain.gradAt(p.x, p.y, grad) || grad;
      const tn = Math.hypot(gr.x, gr.y);
      if ((5 / 7) * G * (tn / Math.sqrt(1 + tn * tn)) < surf.a0 * 1.05) {
        finishRest();
        break;
      }
    }
    // Stall: where the pull only just beats the drag the ball can creep at a few mm/s for ever.
    // A ball that has moved less than STALL_D over STALL_T without speeding up has, to the eye,
    // stopped (one just starting to roll down a slope is speeding up and carries on).
    if (!skidding && sp < STALL_V) {
      if (stallT < 0) {
        stallT = t;
        stallX = p.x;
        stallY = p.y;
        stallV = sp;
      } else if (t - stallT >= STALL_T) {
        if (Math.hypot(p.x - stallX, p.y - stallY) < STALL_D && sp <= stallV * 1.05 + 1e-4) {
          finishRest();
          break;
        }
        stallT = -1;
      }
    } else stallT = -1;
    p.x += v.x * DT_GROUND;
    p.y += v.y * DT_GROUND;
    p.z += v.z * DT_GROUND;
    t += DT_GROUND;
    probe(p.x, p.y);
    if (gs === SURF.WATER) {
      enterWater();
      break;
    }
    // Crest: extrapolate the slope the ball actually travelled on the last step (not the local
    // normal, which smooths kinks) and add free fall. If that clears the ground, it takes off.
    const hm = Math.hypot(p.x - p0.x, p.y - p0.y);
    const zFree = p0.z + slopeAct * hm - 0.5 * G * DT_GROUND * DT_GROUND;
    if (zFree - R > gz + CREST_EPS) {
      p.z = zFree;
      v.z = (slopeAct * hm) / DT_GROUND - G * DT_GROUND;
      mode = 'air';
    } else {
      p.z = gz + R;
      const n1 = terrain.normalAt(p.x, p.y);
      const d = v.x * n1.x + v.y * n1.y + v.z * n1.z;
      if (sp > 0) {
        v.x -= d * n1.x;
        v.y -= d * n1.y;
        v.z -= d * n1.z;
        const sp1 = speed();
        if (sp1 > 0) {
          const f = sp / sp1;
          v.x *= f;
          v.y *= f;
          v.z *= f;
        }
      }
    }
    if (mode === 'ground' && hm > 1e-9) slopeAct = (p.z - p0.z) / hm;
    trackDry();
    obstacles(false);
    if (cup) {
      const dc = Math.hypot(p.x - cup.x, p.y - cup.y);
      if (!cupInside) {
        const res = cupCheck(p0, p, v, cup);
        if (res) {
          if (res.holed) {
            holeOut();
            break;
          }
          cupInside = true;
          if (res.lipout) emit('lipout');
        }
      } else if (dc > CUP_R + R) {
        cupInside = false;
      }
    }
    rec(false);
  }

  rec(true);
  const final = { x: p.x, y: p.y, z: p.z, surface: gs, outcome };
  return {
    path: record ? new Float32Array(path) : new Float32Array(0),
    events,
    final,
    carry,
    total: Math.hypot(p.x - start.x, p.y - start.y),
    apex: apexZ - start.z,
    landing,
    waterEntry,
    lastDry,
    t,
  };
}
