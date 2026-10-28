// Physical constants, surface table and unit helpers shared by every golf module.
// Units SI (m, s, kg, rad/s). World axes: +x east, +y north, +z up. Each hole is authored in its
// own local frame with the tee near the origin.

// ---------- ball ----------
export const BALL_M = 0.04593; // kg
export const BALL_D = 0.04267; // m
export const BALL_R = BALL_D / 2;
export const BALL_A = Math.PI * BALL_R * BALL_R; // cross-section, m^2
export const BALL_I = 0.4 * BALL_M * BALL_R * BALL_R; // solid-sphere approximation

// ---------- environment ----------
export const G = 9.81;
export const RHO = 1.204; // kg/m^3, 20 °C at sea level
export const SPIN_TAU = 25; // s, exponential spin decay in flight
export const WIND_Z0 = 0.03; // m, surface roughness for the log wind profile
export const WIND_REF_Z = 10; // m, height at which wind speed is quoted

// ---------- course furniture ----------
export const CUP_R = 0.054; // 108 mm cup
export const FLAGSTICK_H = 2.13;
export const FLAGSTICK_R = 0.0127;
export const CLUB_LENGTH = 1.14; // m, driver length used to measure relief areas

// ---------- simulation ----------
export const DT_AIR = 1 / 240;
export const DT_GROUND = 1 / 240;
export const MAX_SHOT_T = 45; // s, hard cap on one simulated shot
export const RECORD_HZ = 60; // path samples per second for playback

// ---------- surfaces ----------
// 0 is unused so a zeroed grid reads as "unknown".
export const SURF = {
  TEE: 1,
  FAIRWAY: 2,
  ROUGH: 3,
  FRINGE: 4,
  GREEN: 5,
  BUNKER: 6,
  WATER: 7,
  OOB: 8,
  // Version 2 (themed courses). None of them is a penalty area.
  WASTE: 9, // desert hardpan, waste sand, beach sand: grounding the club allowed
  DESERT: 10, // natural desert scrub with stones
  FESCUE: 11, // links long fescue, marram and gorse edges
};

export const SURF_NAMES = ['', 'Tee', 'Fairway', 'Rough', 'Fringe', 'Green', 'Bunker', 'Water', 'Out of bounds', 'Waste area', 'Desert', 'Fescue'];

// Ground interaction per surface (tuned by the physics calibration tests; see golf/tests/physics.test.js).
//   e        restitution multiplier on the Penner restitution curve
//   crater   multiplier on the Penner crater tilt
//   mu       impact (tangential impulse) friction
//   muS      skid friction while sliding on the ground
//   a0, kv   rolling resistance a = a0 + kv*|v| (m/s^2); green tuned to Stimp ~10.2 ft (3.10 m)
//   spinKeep spin multiplier applied before the impact impulse (grass between ball and face/turf)
//   maxBack  cap on reverse horizontal speed after a bounce (m/s)
//   plough   optional (sand): fraction of outgoing tangential speed and spin lost on impact
//   erratic  optional (desert): random tilt (rad, sigma) of the impact normal from stones and ruts
//   stone    optional (desert): chance per bounce of striking a stone: a lively kick (e x STONE_E,
//            little friction or ploughing) off a face tilted up to ~35 degrees
//   lie      factors applied to a shot played FROM this surface:
//            speed (ball speed), spin, launch (deg added), sdir (extra direction sigma deg)
//   color    albedo (0..1 rgb) for renderer and UI
//   stripe   mowing-stripe strength for the renderer
export const SURFACES = {
  [SURF.TEE]: {
    e: 1.0, crater: 1.0, mu: 0.35, muS: 0.4, a0: 1.1, kv: 0.7, spinKeep: 1, maxBack: 0.6,
    lie: { speed: 1.0, spin: 1.0, launch: 0, sdir: 0.5 },
    color: [0.33, 0.6, 0.24], stripe: 0.05,
  },
  [SURF.FAIRWAY]: {
    e: 1.0, crater: 1.0, mu: 0.35, muS: 0.4, a0: 1.1, kv: 0.7, spinKeep: 1, maxBack: 0.6,
    lie: { speed: 1.0, spin: 1.0, launch: 0, sdir: 0.6 },
    color: [0.36, 0.62, 0.22], stripe: 0.08,
  },
  [SURF.ROUGH]: {
    e: 0.6, crater: 1.6, mu: 0.45, muS: 0.6, a0: 2.6, kv: 0.8, spinKeep: 0.3, maxBack: 0,
    lie: { speed: 0.88, spin: 0.55, launch: 1.5, sdir: 2.5 },
    color: [0.24, 0.45, 0.16], stripe: 0,
  },
  [SURF.FRINGE]: {
    e: 0.95, crater: 1.0, mu: 0.4, muS: 0.4, a0: 0.75, kv: 0.1, spinKeep: 1, maxBack: 0.6,
    lie: { speed: 0.97, spin: 0.9, launch: 0, sdir: 0.8 },
    color: [0.34, 0.64, 0.25], stripe: 0.04,
  },
  [SURF.GREEN]: {
    e: 0.9, crater: 1.25, mu: 0.5, muS: 0.4, a0: 0.45, kv: 0.075, spinKeep: 1, maxBack: 1.8,
    lie: { speed: 1.0, spin: 1.0, launch: 0, sdir: 0.5 },
    color: [0.38, 0.7, 0.28], stripe: 0.05,
  },
  [SURF.BUNKER]: {
    e: 0.12, crater: 2.0, mu: 0.8, muS: 0.9, a0: 7.0, kv: 3.0, spinKeep: 0.5, maxBack: 0, plough: 0.6,
    lie: { speed: 0.78, spin: 0.6, launch: 2, sdir: 2.0 },
    color: [0.86, 0.79, 0.6], stripe: 0,
  },
  // Water absorbs the ball on first contact (outcome 'water').
  [SURF.WATER]: {
    e: 0, crater: 0, mu: 1, muS: 1, a0: 99, kv: 99, spinKeep: 0, maxBack: 0,
    lie: { speed: 0, spin: 0, launch: 0, sdir: 0 },
    color: [0.16, 0.36, 0.45], stripe: 0,
  },
  // Out of bounds plays as rough physically; the penalty is judged at rest.
  [SURF.OOB]: {
    e: 0.6, crater: 1.6, mu: 0.45, muS: 0.6, a0: 2.6, kv: 0.8, spinKeep: 0.3, maxBack: 0,
    lie: { speed: 0.88, spin: 0.55, launch: 1.5, sdir: 2.5 },
    color: [0.22, 0.4, 0.15], stripe: 0,
  },
  // Firm, compacted sand (hardpan, waste areas, beaches): the ball takes one low skip off the crust
  // (some ploughing), then the sand drags it to a stop much sooner than turf.
  [SURF.WASTE]: {
    e: 0.4, crater: 1.5, mu: 0.6, muS: 0.7, a0: 3.4, kv: 1.6, spinKeep: 0.6, maxBack: 0, plough: 0.25,
    lie: { speed: 0.93, spin: 0.75, launch: 1, sdir: 1.2 },
    color: [0.84, 0.75, 0.57], stripe: 0,
  },
  // Loose desert soil between stones and scrub: mostly dead bounces (soft, ploughing), but the
  // ground is uneven (erratic normal) and now and then the ball strikes a stone and kicks away.
  [SURF.DESERT]: {
    e: 0.45, crater: 1.8, mu: 0.6, muS: 0.8, a0: 4.5, kv: 2.0, spinKeep: 0.4, maxBack: 0, plough: 0.35,
    erratic: 0.22, stone: 0.18,
    lie: { speed: 0.75, spin: 0.5, launch: 2, sdir: 3.0 },
    color: [0.66, 0.48, 0.33], stripe: 0,
  },
  // Knee-high fescue and marram: the grass swallows the ball (deep crater, heavy ploughing, almost
  // no rebound) and holds it within a few centimetres.
  [SURF.FESCUE]: {
    e: 0.25, crater: 2.4, mu: 0.7, muS: 0.9, a0: 9, kv: 4, spinKeep: 0.2, maxBack: 0, plough: 0.75,
    lie: { speed: 0.7, spin: 0.45, launch: 3, sdir: 3.0 },
    color: [0.66, 0.6, 0.37], stripe: 0,
  },
};

// Restitution multiplier of a stone struck in desert ground (a hard, lively kick).
export const STONE_E = 1.6;

// Course conditions (docs/architecture.md section 8.2). Hollow Pines plays at these, which
// reproduce the SURFACES table exactly.
//   firm          fairway/tee/rough firmness: roll resistance / firm, fairway e + (firm - 1) * 0.25
//   greenStimpFt  nominal green speed. STIMP_REF_FT is the rating of the calibrated SURFACES green
//                 (its closed-form roll from 1.83 m/s is 3.10 m); other speeds scale every green roll
//                 distance by greenStimpFt / STIMP_REF_FT
//   wind          'normal' | 'windy' (adds WINDY_EXTRA m/s to the Light and Breezy wind ranges)
export const STIMP_REF_FT = 10.5;
export const WINDY_EXTRA = 3;
export const DEFAULT_CONDITIONS = Object.freeze({ firm: 1, greenStimpFt: STIMP_REF_FT, wind: 'normal' });

// ---------- units ----------
export const M_PER_YD = 0.9144;
export const M_PER_FT = 0.3048;
export const MPS_PER_MPH = 0.44704;

export const mToYd = (m) => m / M_PER_YD;
export const ydToM = (yd) => yd * M_PER_YD;
export const mToFt = (m) => m / M_PER_FT;
export const rpmToRad = (rpm) => (rpm * 2 * Math.PI) / 60;
export const radToRpm = (w) => (w * 60) / (2 * Math.PI);

// Distance for display. units 'yd' | 'm'. Short distances (putts) switch to ft / m with a decimal.
export function fmtDist(m, units = 'yd', { short = false } = {}) {
  if (units === 'm') return short && m < 10 ? `${m.toFixed(1)} m` : `${Math.round(m)} m`;
  if (short && m < 20) return `${Math.round(mToFt(m))} ft`;
  return `${Math.round(mToYd(m))} yd`;
}

// Wind speed for display: mph with yards, km/h with metres.
export function fmtWind(mps, units = 'yd') {
  return units === 'm' ? `${Math.round(mps * 3.6)} km/h` : `${Math.round(mps / MPS_PER_MPH)} mph`;
}
