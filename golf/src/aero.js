// Golf ball aerodynamics. Pure module: no DOM, no clock, no Math.random.
//
// Model (SI units, z up). The force on the ball depends on the air-relative velocity
// u = v - W(z_agl) and the spin parameter S = R|w|/|u|:
//
//   C_D = 0.186 + 0.545 S - 0.42 S^2 + 0.063 (50/|u| - 1)   drag rises with spin (wake), and a
//                                     little at low speed (the dimples' drag crisis is behind us
//                                     at driver speed, still fading at wedge speed)
//   C_L = 1.15 S^0.766 / (1 + 1.55 S)  Magnus lift: weak at driver spin (S ~ 0.09), saturating
//                                     at wedge spin (S ~ 0.5)
//   a   = -g z  - k C_D |u| u  +  k C_L |u|^2 (w_hat x u_hat),   k = rho A / (2 m)
//
// The coefficients were fitted to TrackMan's PGA Tour and LPGA averages (ball speed, launch and
// spin in; carry, apex and descent angle out): irons and wedges land within ~2 deg and ~2 yd of
// apex, the driver about 3 deg steep. S is clamped to [0, 0.6] and |u| to >= 15 m/s in the drag
// term; beyond those the fits are extrapolations.
//
// Wind follows a neutral-atmosphere log profile anchored at 10 m:
//   W(z) = W10 ln(max(z, 0.5) / z0) / ln(10 / z0)
// so a ball at 30 m apex sees ~1.2x the quoted wind and a ball near the ground ~0.5x.

import { BALL_A, BALL_M, BALL_R, G, RHO, WIND_Z0, WIND_REF_Z } from './constants.js';

// Per-unit-mass aerodynamic factor rho A / (2 m) (1/m).
export const AERO_K = (RHO * BALL_A) / (2 * BALL_M);
export const S_MAX = 0.6;

const LOG_REF = Math.log(WIND_REF_Z / WIND_Z0);

export const U_REF = 50; // m/s: the speed at which the drag's speed term is zero
// Fit coefficients (see the header).
export const CD = { a: 0.186, b: 0.545, b2: -0.42, e: 0.063 };
export const CL = { c: 1.15, p: 0.766, q: 1.55 };

const clampS = (S) => (S < 0 ? 0 : S > S_MAX ? S_MAX : S);

// Drag coefficient at spin parameter S and air speed u (m/s; default U_REF = no speed term).
export function dragCoeff(S, u = U_REF) {
  const s = clampS(S);
  const uu = u > 15 ? u : 15;
  return CD.a + CD.b * s + CD.b2 * s * s + CD.e * (U_REF / uu - 1);
}

export function liftCoeff(S) {
  const s = clampS(S);
  return s > 0 ? (CL.c * Math.pow(s, CL.p)) / (1 + CL.q * s) : 0;
}

// Scale factor of the log wind profile at height zAgl above ground (1 at 10 m).
export function windFactor(zAgl) {
  const z = zAgl > 0.5 ? zAgl : 0.5;
  return Math.log(z / WIND_Z0) / LOG_REF;
}

// Wind vector {x, y, z:0} at height zAgl for a 10 m reference wind wind10 = {x, y} (m/s).
export function windAt(wind10, zAgl, out = { x: 0, y: 0, z: 0 }) {
  const k = windFactor(zAgl);
  out.x = (wind10 ? wind10.x : 0) * k;
  out.y = (wind10 ? wind10.y : 0) * k;
  out.z = 0;
  return out;
}

// Acceleration of a ball in flight. state = {v:{x,y,z}, w:{x,y,z} (rad/s), zAgl (m)}.
// wind is the 10 m wind {x, y}. Writes into and returns out {x,y,z}.
export function flightAccel(state, wind, out = { x: 0, y: 0, z: 0 }) {
  const v = state.v;
  const w = state.w;
  const k = wind && (wind.x || wind.y) ? windFactor(state.zAgl) : 0;
  const ux = v.x - (k ? wind.x * k : 0);
  const uy = v.y - (k ? wind.y * k : 0);
  const uz = v.z;
  const u = Math.sqrt(ux * ux + uy * uy + uz * uz);
  out.x = 0;
  out.y = 0;
  out.z = -G;
  if (u < 1e-9) return out;
  const wm = Math.sqrt(w.x * w.x + w.y * w.y + w.z * w.z);
  const S = (BALL_R * wm) / u;
  const drag = AERO_K * dragCoeff(S, u) * u;
  out.x -= drag * ux;
  out.y -= drag * uy;
  out.z -= drag * uz;
  if (wm > 0) {
    // k C_L |u|^2 (w_hat x u_hat) = k C_L |u| (w x u) / |w|
    const lift = (AERO_K * liftCoeff(S) * u) / wm;
    out.x += lift * (w.y * uz - w.z * uy);
    out.y += lift * (w.z * ux - w.x * uz);
    out.z += lift * (w.x * uy - w.y * ux);
  }
  return out;
}
