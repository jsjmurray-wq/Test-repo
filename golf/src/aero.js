// Golf ball aerodynamics. Pure module: no DOM, no clock, no Math.random.
//
// Model (Smits & Smith style, SI units, z up). The force on the ball depends on the air-relative
// velocity u = v - W(z_agl) and the spin parameter S = R|w|/|u|:
//
//   C_D = 0.24 + 0.18 S            drag rises with spin (more wake turbulence)
//   C_L = 0.54 S^0.4               Magnus lift, steep at low S, flattening at high S
//   a   = -g z  - k C_D |u| u  +  k C_L |u|^2 (w_hat x u_hat),   k = rho A / (2 m)
//
// S is clamped to [0, 0.6]; beyond that the fits are extrapolations and real balls plateau.
//
// Wind follows a neutral-atmosphere log profile anchored at 10 m:
//   W(z) = W10 ln(max(z, 0.5) / z0) / ln(10 / z0)
// so a ball at 30 m apex sees ~1.2x the quoted wind and a ball near the ground ~0.5x.

import { BALL_A, BALL_M, BALL_R, G, RHO, WIND_Z0, WIND_REF_Z } from './constants.js';

// Per-unit-mass aerodynamic factor rho A / (2 m) (1/m).
export const AERO_K = (RHO * BALL_A) / (2 * BALL_M);
export const S_MAX = 0.6;

const LOG_REF = Math.log(WIND_REF_Z / WIND_Z0);

export function dragCoeff(S) {
  const s = S < 0 ? 0 : S > S_MAX ? S_MAX : S;
  return 0.24 + 0.18 * s;
}

export function liftCoeff(S) {
  const s = S < 0 ? 0 : S > S_MAX ? S_MAX : S;
  return s > 0 ? 0.54 * Math.pow(s, 0.4) : 0;
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
  const drag = AERO_K * dragCoeff(S) * u;
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
