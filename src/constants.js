// Single source of truth for table geometry, physics constants and ball appearance.
// Units are SI (metres, seconds, kilograms, radians).
// Coordinates: origin at the table centre, +x along the long axis toward the FOOT rail
// (the head / break end is at -x), +y across the table (to the left when looking from the
// head end toward the foot), +z up.

// ---- Balls ----
export const BALL_R = 0.028575; // 57.15 mm diameter
export const BALL_M = 0.17;
export const BALL_COUNT = 16; // 0 = cue, 1-7 solids, 8 = eight, 9-15 stripes

// ---- Table: 7-ft American bar table (playing surface measured cushion nose to nose) ----
export const TABLE_L = 1.981;
export const TABLE_W = 0.991;
export const HL = TABLE_L / 2; // half length
export const HW = TABLE_W / 2; // half width
export const HEAD_STRING_X = -HL / 2;
export const HEAD_SPOT = Object.freeze({ x: -HL / 2, y: 0 });
export const FOOT_SPOT = Object.freeze({ x: HL / 2, y: 0 });

// Pockets (WPA-style). Mouth = distance between the two jaw points.
export const CORNER_MOUTH = 0.116;
export const SIDE_MOUTH = 0.129;
export const CORNER_FACING_DEG = 142; // angle between cushion face and pocket facing
export const SIDE_FACING_DEG = 104;
export const CORNER_CAPTURE_R = 0.052; // capture circle radius, centred on the corner point
export const SIDE_CAPTURE_R = 0.048; // capture circle radius, centred behind the side mouth
export const SIDE_CAPTURE_OFFSET = 0.025; // side capture centre sits this far outside the cushion line
export const JAW_NOSE_R = 0.004; // rounded tip of each jaw

// Visual-only dimensions (outside the playing surface)
export const CUSHION_DEPTH = 0.05; // nose of the cushion to the wooden rail
export const RAIL_WIDTH = 0.11; // wooden rail beyond the cushion
export const POCKET_VISUAL_R = 0.062; // drawn pocket hole radius (corner), side is slightly larger

// ---- Physics ----
export const G = 9.81;
export const MU_SLIDE = 0.2; // ball-cloth sliding friction
export const MU_ROLL = 0.01; // rolling resistance
export const SPIN_DECEL = 10; // rad/s^2 decay of z-spin (english)
export const MU_BALL = 0.05; // ball-ball friction (throw)
export const E_BALL = 0.95; // ball-ball restitution
export const E_CUSHION = 0.8; // cushion restitution at low normal speed
export const E_CUSHION_FAST = 0.7; // ... falling linearly to this at CUSHION_FAST_V
export const CUSHION_FAST_V = 6;
export const MU_CUSHION = 0.2; // ball-cushion friction

export const DT = 0.001; // fixed physics substep (s)
export const AI_DT = 0.002; // coarser substep used by the AI's headless sims
export const MAX_SHOT_T = 60; // s; after this every ball is forced to rest
export const REST_V = 0.005; // m/s
export const REST_W = 0.5; // rad/s

// ---- Cue ----
export const V_MIN = 0.25; // cue-ball speed at power 0 (m/s)
export const V_MAX = 9.5; // cue-ball speed at power 1
export const POWER_EXP = 1.7; // speed = V_MIN + (V_MAX - V_MIN) * power^POWER_EXP
export const MAX_TIP = 0.5; // max tip offset, as a fraction of R
export const MISCUE_TIP = 0.55; // beyond this the shot miscues
export const MAX_SQUIRT_RAD = (1.5 * Math.PI) / 180; // cue-ball deflection at full side spin

// ---- Rack ----
export const RACK_GAP = 0.00002; // 0.02 mm between racked balls

// ---- Appearance ----
// Standard American ball colours (1-7 solids, 9-15 stripes share the colour of n-8).
export const BALL_COLORS = Object.freeze([
  '#f8f4e8', // 0 cue
  '#f2c10f', // 1 yellow
  '#1b4fb5', // 2 blue
  '#d3271f', // 3 red
  '#5b2a86', // 4 purple
  '#f06a12', // 5 orange
  '#137a3c', // 6 green
  '#7d1d1d', // 7 maroon
  '#111111', // 8 black
  '#f2c10f', // 9
  '#1b4fb5', // 10
  '#d3271f', // 11
  '#5b2a86', // 12
  '#f06a12', // 13
  '#137a3c', // 14
  '#7d1d1d', // 15
]);

export const CLOTH_COLORS = Object.freeze({
  green: '#1f7a46',
  blue: '#1d5f9e',
});

export function isStripe(id) {
  return id >= 9 && id <= 15;
}

export function groupOf(id) {
  if (id === 0) return 'cue';
  if (id === 8) return 'eight';
  return id < 8 ? 'solids' : 'stripes';
}

// Power (0..1) -> cue-ball speed (m/s), and its inverse.
export function shotSpeed(power) {
  const p = Math.min(1, Math.max(0, power));
  return V_MIN + (V_MAX - V_MIN) * Math.pow(p, POWER_EXP);
}

export function powerForSpeed(speed) {
  const s = Math.min(V_MAX, Math.max(V_MIN, speed));
  return Math.pow((s - V_MIN) / (V_MAX - V_MIN), 1 / POWER_EXP);
}
