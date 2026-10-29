// The golfer's swing: poses, forward kinematics with two-bone IK, the placement that puts the club
// head on the ball, and the SwingAnimator that plays address, backswing, downswing, impact,
// follow-through and finish (docs/architecture.md section 9). Pure module (no DOM); looks only:
// the ball's physics never reads it.
//
// Poses
//   A pose is a parameter vector (Float64Array(NP), indices in P): pelvis turn/shift/drop/tilt/
//   bank, shoulder turn, spine flex and side bend, the lead arm as a direction in the chest frame
//   (polar angle e from the spine's down axis, azimuth phi toward the lead side) with an extension
//   k, the club's orientation as a quaternion in G, feet (trail heel lift and pivot, knee-in), head
//   look (0 ball .. 1 target) and the elbow pole vectors. evalPose() turns it into per-bone world
//   rotations and positions in G (FK down the spine; the club is placed from the lead-arm
//   parameters and its quaternion; both hands grip it and both arms and legs are solved by
//   two-bone IK), then into skin matrices (world x inverse bind, column-major mat4 per bone).
//   SwingAnimator.pose gives the result as per-bone local quaternions plus the root translation.
//
// Keys (checkpoints, the standard P1..P10 positions of a swing)
//   P1 address and P7 impact are SOLVED per golfer, club and lie: the club is soled behind the
//   ball (address) or its impact point sits exactly on the ball (impact), and the hip hinge is
//   solved so the lead arm reaches (and at address the stance distance so the arms hang under
//   the shoulders). P2 takeaway, P3 lead arm parallel, P4 top, P4X overswing, P5 lead arm
//   parallel down, P6 shaft parallel down, P8 shaft parallel through, P9 trail arm parallel, P10
//   finish are DESIGNED (body angles, grip position, shaft direction, face) and converted to the
//   same parameters. Backswing = spline P1..P4X by u (0..4); downswing from the reached top
//   along the downswing keys (P4..P7) with the hips leading and the club lagging; follow-through
//   = spline P7..P10. Putts: the address rocks about the chest (shoulder pendulum).
//
// Exports: NP, P, placeGolfer(opts), evalPose(rig, prm, out), SwingAnimator, swingTiming(style, power, kind).

import { B, BONE_COUNT, BONE_PARENT, bodyDims, clubSpec, normalizeLook } from './golfer.js';
import { BALL_R } from './constants.js';

// ------------------------------------------------------------------ parameters
export const P = Object.freeze({
  hipTurn: 0, shiftY: 1, shiftX: 2, drop: 3, tilt: 4, bank: 5,
  chest: 6, flex: 7, bend: 8,
  e: 9, phi: 10, k: 11,
  qx: 12, qy: 13, qz: 14, qw: 15,
  heel: 16, pivot: 17, kneeIn: 18, look: 19,
  telX: 20, telY: 21, telZ: 22, lelX: 23, lelY: 24, lelZ: 25,
  clav: 26, rock: 27,
});
export const NP = 28;
const HIP_PARAMS = [P.hipTurn, P.shiftY, P.shiftX, P.drop, P.bank, P.heel, P.pivot, P.kneeIn];
const CHEST_PARAMS = [P.chest, P.flex, P.bend, P.tilt];

// ------------------------------------------------------------------ small math (allocation-free)
const T9 = new Float64Array(9);
function m3id(o, oo) {
  o[oo] = 1; o[oo + 1] = 0; o[oo + 2] = 0;
  o[oo + 3] = 0; o[oo + 4] = 1; o[oo + 5] = 0;
  o[oo + 6] = 0; o[oo + 7] = 0; o[oo + 8] = 1;
}
function m3copy(o, oo, a, ao) {
  for (let i = 0; i < 9; i++) o[oo + i] = a[ao + i];
}
// o = a * b (column-major 3x3). Safe when o aliases a or b.
function m3mul(o, oo, a, ao, b, bo) {
  for (let c = 0; c < 3; c++) {
    const b0 = b[bo + c * 3];
    const b1 = b[bo + c * 3 + 1];
    const b2 = b[bo + c * 3 + 2];
    T9[c * 3] = a[ao] * b0 + a[ao + 3] * b1 + a[ao + 6] * b2;
    T9[c * 3 + 1] = a[ao + 1] * b0 + a[ao + 4] * b1 + a[ao + 7] * b2;
    T9[c * 3 + 2] = a[ao + 2] * b0 + a[ao + 5] * b1 + a[ao + 8] * b2;
  }
  for (let i = 0; i < 9; i++) o[oo + i] = T9[i];
}
// o = a^T * b
function m3tmul(o, oo, a, ao, b, bo) {
  for (let c = 0; c < 3; c++) {
    const b0 = b[bo + c * 3];
    const b1 = b[bo + c * 3 + 1];
    const b2 = b[bo + c * 3 + 2];
    T9[c * 3] = a[ao] * b0 + a[ao + 1] * b1 + a[ao + 2] * b2;
    T9[c * 3 + 1] = a[ao + 3] * b0 + a[ao + 4] * b1 + a[ao + 5] * b2;
    T9[c * 3 + 2] = a[ao + 6] * b0 + a[ao + 7] * b1 + a[ao + 8] * b2;
  }
  for (let i = 0; i < 9; i++) o[oo + i] = T9[i];
}
// Rotation about unit axis (x, y, z) by ang.
function m3axis(o, oo, x, y, z, ang) {
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  const t = 1 - c;
  o[oo] = t * x * x + c; o[oo + 1] = t * x * y + s * z; o[oo + 2] = t * x * z - s * y;
  o[oo + 3] = t * x * y - s * z; o[oo + 4] = t * y * y + c; o[oo + 5] = t * y * z + s * x;
  o[oo + 6] = t * x * z + s * y; o[oo + 7] = t * y * z - s * x; o[oo + 8] = t * z * z + c;
}
// Rotation about a unit axis by src[si] * k (the angle stays in a typed array: a double passed
// as an argument to a non-inlined function would be boxed on the heap every frame).
function m3axisA(o, oo, x, y, z, src, si, k) {
  const ang = src[si] * k;
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  const t = 1 - c;
  o[oo] = t * x * x + c; o[oo + 1] = t * x * y + s * z; o[oo + 2] = t * x * z - s * y;
  o[oo + 3] = t * x * y - s * z; o[oo + 4] = t * y * y + c; o[oo + 5] = t * y * z + s * x;
  o[oo + 6] = t * x * z + s * y; o[oo + 7] = t * y * z - s * x; o[oo + 8] = t * z * z + c;
}
// Same, axis and angle from arrays: axis ax[ai..ai+2], angle src[si].
function m3axisV(o, oo, ax, ai, src, si) {
  const x = ax[ai];
  const y = ax[ai + 1];
  const z = ax[ai + 2];
  const ang = src[si];
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  const t = 1 - c;
  o[oo] = t * x * x + c; o[oo + 1] = t * x * y + s * z; o[oo + 2] = t * x * z - s * y;
  o[oo + 3] = t * x * y - s * z; o[oo + 4] = t * y * y + c; o[oo + 5] = t * y * z + s * x;
  o[oo + 6] = t * x * z + s * y; o[oo + 7] = t * y * z - s * x; o[oo + 8] = t * z * z + c;
}
// out = m * (x, y, z)
function m3v(out, oo, m, mo, x, y, z) {
  const a = m[mo] * x + m[mo + 3] * y + m[mo + 6] * z;
  const b = m[mo + 1] * x + m[mo + 4] * y + m[mo + 7] * z;
  const c = m[mo + 2] * x + m[mo + 5] * y + m[mo + 8] * z;
  out[oo] = a;
  out[oo + 1] = b;
  out[oo + 2] = c;
}
// out = m^T * (x, y, z)
function m3tv(out, oo, m, mo, x, y, z) {
  const a = m[mo] * x + m[mo + 1] * y + m[mo + 2] * z;
  const b = m[mo + 3] * x + m[mo + 4] * y + m[mo + 5] * z;
  const c = m[mo + 6] * x + m[mo + 7] * y + m[mo + 8] * z;
  out[oo] = a;
  out[oo + 1] = b;
  out[oo + 2] = c;
}
function quatFromM3(q, qo, m, mo) {
  const m00 = m[mo];
  const m11 = m[mo + 4];
  const m22 = m[mo + 8];
  const m21 = m[mo + 5];
  const m12 = m[mo + 7];
  const m02 = m[mo + 6];
  const m20 = m[mo + 2];
  const m10 = m[mo + 1];
  const m01 = m[mo + 3];
  const tr = m00 + m11 + m22;
  let x;
  let y;
  let z;
  let w;
  if (tr > 0) {
    const s = 0.5 / Math.sqrt(tr + 1);
    w = 0.25 / s;
    x = (m21 - m12) * s;
    y = (m02 - m20) * s;
    z = (m10 - m01) * s;
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    w = (m21 - m12) / s;
    x = 0.25 * s;
    y = (m01 + m10) / s;
    z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    w = (m02 - m20) / s;
    x = (m01 + m10) / s;
    y = 0.25 * s;
    z = (m12 + m21) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    w = (m10 - m01) / s;
    x = (m02 + m20) / s;
    y = (m12 + m21) / s;
    z = 0.25 * s;
  }
  q[qo] = x;
  q[qo + 1] = y;
  q[qo + 2] = z;
  q[qo + 3] = w;
}
function m3FromQuat(o, oo, q, qo) {
  let x = q[qo];
  let y = q[qo + 1];
  let z = q[qo + 2];
  let w = q[qo + 3];
  const l = len4(x, y, z, w) || 1;
  x /= l;
  y /= l;
  z /= l;
  w /= l;
  o[oo] = 1 - 2 * (y * y + z * z); o[oo + 1] = 2 * (x * y + z * w); o[oo + 2] = 2 * (x * z - y * w);
  o[oo + 3] = 2 * (x * y - z * w); o[oo + 4] = 1 - 2 * (x * x + z * z); o[oo + 5] = 2 * (y * z + x * w);
  o[oo + 6] = 2 * (x * z + y * w); o[oo + 7] = 2 * (y * z - x * w); o[oo + 8] = 1 - 2 * (x * x + y * y);
}
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
// Math.hypot is a builtin call that returns a boxed number; these inline to plain sqrt.
const len2 = (a, b) => Math.sqrt(a * a + b * b);
const len3 = (a, b, c) => Math.sqrt(a * a + b * b + c * c);
const len4 = (a, b, c, d) => Math.sqrt(a * a + b * b + c * c + d * d);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

// ------------------------------------------------------------------ rig
// Allocation-free scratch for one pose evaluation lives on the rig.
function makeScratch() {
  return {
    R: new Float64Array(BONE_COUNT * 9), // world rotations in G
    X: new Float64Array(BONE_COUNT * 3), // world positions (bone origins) in G
    m: new Float64Array(9 * 8),
    v: new Float64Array(3 * 16),
    a: new Float64Array(8), // angles handed to the rotation helpers
    k: new Float64Array(16), // ik inputs
    rk: new Float64Array(9), // putting rock rotation
  };
}

// Stance and pose design per club (multiples of the height H where lengths).
function stanceFor(spec, shot) {
  const id = spec.id;
  const head = spec.head;
  let half = head === 'driver' ? 0.136 : head === 'wood' ? 0.128 : head === 'hybrid' ? 0.122 : head === 'putter' ? 0.092 : head === 'wedge' ? 0.104 : 0.112;
  if (head === 'iron') half += { '5i': 0.006, '6i': 0.003, '7i': 0, '8i': -0.003, '9i': -0.006 }[id] || 0;
  // Ball position (+ toward the target, from the stance centre): off the lead heel for the
  // driver, forward for woods, centre for irons, centre to back for wedges.
  let ballY = head === 'driver' ? 0.088 : head === 'wood' ? 0.052 : head === 'hybrid' ? 0.03 : head === 'putter' ? 0.025 : head === 'wedge' ? -0.006 : { '5i': 0.022, '6i': 0.014, '7i': 0.006, '8i': 0.0, '9i': -0.004 }[id] || 0.005;
  if (shot === 'flop') {
    half += 0.02;
    ballY += 0.02;
  } else if (shot === 'bump') {
    half -= 0.03;
    ballY -= 0.025;
  } else if (shot === 'punch' || shot === 'stinger') {
    ballY -= 0.018;
  }
  return {
    half, ballY,
    flareL: head === 'putter' ? 0.2 : 0.42,
    flareR: head === 'putter' ? -0.06 : -0.14,
  };
}

// Address and impact design per club head type: lie change (rad, + = more upright), forward
// shaft lean (rad, + = hands ahead), side bend (rad, + = trail shoulder lower), arm hang (grip x
// in front of the lead shoulder / H) and lead-arm reach (fraction of the full arm).
function keyDesign(spec, shot) {
  const head = spec.head;
  const D = Math.PI / 180;
  const driver = head === 'driver';
  const wood = head === 'wood' || head === 'hybrid';
  const putt = head === 'putter';
  const wedge = head === 'wedge';
  let leanImp = driver ? -1 * D : wood ? 4 * D : putt ? 3 * D : wedge ? 11 * D : 9 * D;
  let leanAddr = driver ? -3 * D : wood ? 0 : putt ? 4 * D : wedge ? 6 * D : 4 * D;
  let face = 0;
  if (shot === 'flop') {
    face = 24 * D;
    leanImp = 2 * D;
    leanAddr = 0;
  } else if (shot === 'punch' || shot === 'stinger' || shot === 'bump') {
    leanImp += 5 * D;
    leanAddr += 4 * D;
  }
  // Spine angle from vertical at address (hinge + upper-back flex), by club.
  const posture = (driver ? 33 : wood ? 35 : head === 'hybrid' ? 36 : putt ? 44 : wedge ? 40 : 38) * D;
  return {
    addr: { lie: putt ? 0 : -4 * D, lean: leanAddr, face: face * 0.9, bend: driver ? 0.17 : wood ? 0.13 : putt ? 0.05 : 0.1, angMin: (putt ? -2 : 6) * D, angMax: (putt ? 26 : driver ? 30 : 29) * D, posture, reach: putt ? 0.84 : 0.965, flex: putt ? 0.14 : 0.06, drop: putt ? 0.022 : 0.036, shiftX: putt ? -0.014 : -0.022 },
    imp: { lie: putt ? 0 : -0.5 * D, lean: leanImp, face, reach: putt ? 0.84 : 0.995 },
  };
}

// Designed checkpoints for a right-hander, 1.8 m reference golfer, G frame. grip: position of the
// lead hand's grip point (m, scaled by H/1.8 and pulled toward the solved address/impact grip by
// `w`); shaft: grip -> head direction; face: the square face's outward normal hint; tel/lel:
// trail/lead elbow pole directions (where the elbow points).
const DESIGN = {
  P2: { hipTurn: 0.22, shiftY: -0.012, chest: 0.72, flex: 0.12, bend: 0.06, tiltD: 0.0, grip: [0.3, -0.36, 0.9], w: 0.75, shaft: [0.06, -1, 0.02], face: [0.85, 0, -0.5], tel: [-0.6, -0.2, -0.8], lel: [-0.5, 0.5, -0.7], look: 0 },
  P3: { hipTurn: 0.47, shiftY: -0.018, chest: 1.25, flex: 0.1, bend: -0.04, tiltD: 0.0, grip: [0.18, -0.52, 1.1], w: 0.45, shaft: [-0.52, -0.06, 0.85], face: [0.7, -0.35, 0.3], tel: [-0.3, 0.1, -0.95], lel: [-0.2, 0.6, -0.75], clav: 0.06, look: 0 },
  P4: { hipTurn: 0.76, shiftY: -0.02, chest: 1.62, flex: 0.08, bend: -0.14, tiltD: -0.02, grip: [0.08, -0.47, 1.47], w: 0.15, shaft: [0.08, 1, -0.06], face: [0.55, 0, 0.83], tel: [0.25, 0.05, -1], lel: [0.2, 0.5, -0.8], clav: 0.1, look: 0 },
  P4X: { hipTurn: 0.86, shiftY: -0.022, chest: 1.78, flex: 0.07, bend: -0.2, tiltD: -0.03, grip: [0.04, -0.5, 1.52], w: 0.1, shaft: [0.14, 0.82, -0.56], face: [0.5, 0.3, 0.8], tel: [0.25, 0.05, -1], lel: [0.2, 0.5, -0.8], clav: 0.12, look: 0 },
  P5: { hipTurn: 0.12, shiftY: 0.055, chest: 1.12, flex: 0.1, bend: 0.06, tiltD: 0.01, drop: 0.012, kneeIn: 0.25, grip: [0.2, -0.45, 1.1], w: 0.4, shaft: [-0.42, -0.55, 0.72], face: [0.75, -0.55, 0.1], tel: [0.1, -0.1, -1], lel: [-0.1, 0.6, -0.8], clav: 0.06, look: 0 },
  P6: { hipTurn: -0.33, shiftY: 0.075, chest: 0.42, flex: 0.11, bend: 0.2, tiltD: 0.01, drop: 0.012, heel: 0.12, kneeIn: 0.4, grip: [0.29, -0.17, 0.9], w: 0.8, shaft: [0.12, -0.99, -0.05], face: [0.88, 0, -0.45], tel: [-0.4, -0.35, -0.85], lel: [-0.4, 0.5, -0.75], look: 0 },
  P8: { hipTurn: -1.0, shiftY: 0.095, chest: -0.95, flex: 0.1, bend: 0.28, tiltD: -0.03, drop: 0.006, heel: 0.55, pivot: 0.1, kneeIn: 0.6, grip: [0.31, 0.45, 0.94], w: 0.75, shaft: [0.1, 1, 0.08], face: [-0.88, 0, -0.45], tel: [-0.4, -0.5, -0.75], lel: [-0.3, 0.2, -0.95], look: 0.12, k: 0.97, kMin: 0.93 },
  P9: { hipTurn: -1.32, shiftY: 0.11, chest: -1.42, flex: 0.06, bend: 0.2, tiltD: -0.2, drop: 0.0, heel: 0.95, pivot: 0.3, kneeIn: 0.85, grip: [0.2, 0.47, 1.36], w: 0.35, shaft: [-0.45, 0.15, 0.88], face: [-0.6, -0.65, -0.2], tel: [-0.3, -0.4, -0.9], lel: [-0.2, 0.3, -0.95], look: 0.5, k: 0.86, kMin: 0.7 },
  P10: { hipTurn: -1.55, shiftY: 0.12, chest: -1.88, flex: -0.04, bend: -0.04, tiltD: -0.5, drop: -0.005, heel: 1.3, pivot: 0.55, kneeIn: 1.05, grip: [-0.3, 0.02, 1.58], w: 0.0, shaft: [0.55, -0.5, -0.62], face: [0.3, 0.75, -0.3], tel: [0.4, 0.3, -0.85], lel: [-0.2, 0.5, -0.85], look: 1, k: 0.62, kMin: 0.45 },
};
// Shot and style variants of the follow-through (held-off low finish, high open flop, rolled
// draw, held cut, reverse-C big finish).
const VARIANTS = {
  low: {
    P8: { grip: [0.33, 0.42, 1.0], shaft: [0.18, 0.92, 0.36], face: [-0.2, -0.3, 0.93], heel: 0.4, k: 0.98 },
    P9: { hipTurn: -1.12, chest: -1.15, grip: [0.3, 0.5, 1.15], shaft: [0.05, 0.75, 0.66], face: [-0.3, -0.62, 0.72], heel: 0.65, tiltD: -0.08, look: 0.4, k: 0.93 },
    P10: { hipTurn: -1.2, chest: -1.25, grip: [0.28, 0.5, 1.2], shaft: [0.0, 0.72, 0.7], face: [-0.35, -0.65, 0.68], heel: 0.75, pivot: 0.2, kneeIn: 0.7, tiltD: -0.12, bend: 0.2, flex: 0.06, look: 0.6, k: 0.93 },
  },
  flop: {
    P8: { shaft: [0.1, 0.98, 0.18], face: [-0.25, -0.15, 0.95] },
    P10: { grip: [-0.26, 0.04, 1.68], shaft: [0.45, -0.45, -0.77], face: [0.3, 0.8, -0.2] },
  },
  draw: {
    P8: { face: [-0.95, 0, -0.3] },
    P9: { grip: [0.16, 0.47, 1.3], face: [-0.75, -0.55, -0.35] },
  },
  cut: {
    P8: { face: [-0.6, -0.1, 0.75] },
    P9: { grip: [0.24, 0.5, 1.4], face: [-0.25, -0.7, 0.4] },
    P10: { grip: [-0.26, 0.05, 1.6], face: [0.1, 0.9, -0.3] },
  },
  bigfinish: {
    P10: { bend: -0.3, flex: -0.12, tiltD: -0.62, grip: [-0.24, -0.04, 1.72], shaft: [0.5, -0.6, -0.62], hipTurn: -1.5, chest: -1.95 },
  },
};

// Swing timing (seconds) by style, power and kind: downswing (transition + downswing to impact),
// follow-through to the finish, and an automatic backswing when strike() comes without one.
export function swingTiming(style = 'classic', power = 1, kind = 'full') {
  const p = clamp(power, 0, 1.1);
  if (kind === 'putt') {
    const k = style === 'smooth' ? 1.1 : style === 'compact' ? 0.92 : 1;
    return { down: 0.34 * k, follow: 0.55 * k, back: 0.5 * k + 0.2 * p };
  }
  const base = { classic: 0.27, compact: 0.235, bigfinish: 0.26, smooth: 0.315 }[style] || 0.27;
  const fol = { classic: 0.95, compact: 0.8, bigfinish: 1.05, smooth: 1.15 }[style] || 0.95;
  const back = { classic: 0.85, compact: 0.68, bigfinish: 0.9, smooth: 1.05 }[style] || 0.85;
  return { down: base * (0.92 + 0.08 * Math.min(1, p)), follow: fol * (0.55 + 0.45 * Math.min(1, p)), back: back * (0.45 + 0.55 * Math.min(1, p)) };
}

// Backswing length u (0 address .. 3 top .. 4 overswing) for a power and style.
function backU(power, style) {
  const p = clamp(power, 0, 1.1);
  const rows = [[0, 0], [0.25, 1.0], [0.5, 1.9], [0.75, 2.5], [1.0, 3.0], [1.1, 3.42]];
  let u = 0;
  for (let i = 1; i < rows.length; i++) {
    if (p <= rows[i][0]) {
      const t = (p - rows[i - 1][0]) / (rows[i][0] - rows[i - 1][0]);
      u = rows[i - 1][1] + (rows[i][1] - rows[i - 1][1]) * t;
      break;
    }
    u = rows[i][1];
  }
  if (style === 'compact') u *= u > 1 ? 0.85 : 0.95;
  return u;
}

// ------------------------------------------------------------------ placement
// placeGolfer({ball, aimYaw, terrain | ground, handed, look, club, shot}) -> rig.
//   ball     {x, y, z}: the ball centre (world)
//   aimYaw   target direction (yaw, rad)
//   terrain  HoleTerrain (heightAt, normalAt) or ground(x, y) -> z; neither = flat at ball.z - R
//   handed   'R' | 'L' (left-handers are the mirror image)
// The rig holds the world transform (G -> world), the stance and the solved/designed keys.
export function placeGolfer(opts = {}) {
  const look = normalizeLook(opts.look);
  const dims = bodyDims(look);
  const shot = opts.shot || 'normal';
  const spec = clubSpec(opts.club || '7i', dims.H);
  const handed = opts.handed === 'L' ? 'L' : 'R';
  const ball = opts.ball || { x: 0, y: 0, z: BALL_R };
  const aimYaw = opts.aimYaw || 0;
  const ter = opts.terrain || null;
  const ground = ter ? (x, y) => ter.heightAt(x, y) : typeof opts.ground === 'function' ? opts.ground : () => ball.z - BALL_R;
  const normalAt = (x, y, out) => {
    if (ter && ter.normalAt) {
      const n = ter.normalAt(x, y);
      out[0] = n.x;
      out[1] = n.y;
      out[2] = n.z;
      return out;
    }
    const e = 0.05;
    const gx = (ground(x + e, y) - ground(x - e, y)) / (2 * e);
    const gy = (ground(x, y + e) - ground(x, y - e)) / (2 * e);
    const l = Math.sqrt(gx * gx + gy * gy + 1);
    out[0] = -gx / l;
    out[1] = -gy / l;
    out[2] = 1 / l;
    return out;
  };
  const H = dims.H;
  const rig = {
    look, dims, spec, handed, shot, ball: { x: ball.x, y: ball.y, z: ball.z }, aimYaw,
    mirror: handed === 'L' ? -1 : 1,
    yaw: handed === 'L' ? aimYaw + Math.PI / 2 : aimYaw - Math.PI / 2,
    origin: new Float64Array(3),
    W: new Float64Array(16),
    st: stanceFor(spec, shot),
    design: keyDesign(spec, shot),
    feet: null,
    ballG: new Float64Array(3),
    lookFar: new Float64Array(3),
    autoDrop: 0,
    s: makeScratch(),
    keys: null,
    groundFn: ground,
    normalFn: normalAt,
    armLen: 0.6,
    rockAxis: null,
    bx: 0,
    by: 0,
  };
  const st = rig.st;
  const by = st.ballY * H;
  // Initial stance distance guess: the club's horizontal reach plus the hands under the shoulders.
  let bx = 0.17 * H + Math.cos(spec.lie) * spec.len * 0.92;
  let addr = null;
  for (let it = 0; it < 3; it++) {
    setWorld(rig, bx, by);
    setFeet(rig);
    addr = solveAddress(rig, bx, by);
    if (Math.abs(addr.bx - bx) < 1e-4) {
      bx = addr.bx;
      break;
    }
    bx = addr.bx;
  }
  setWorld(rig, bx, by);
  setFeet(rig);
  addr = solveAddress(rig, bx, by);
  rig.bx = addr.bx;
  rig.by = by;
  rig.keys = buildKeys(rig, addr.prm);
  return rig;
}

// World transform: G origin on the ground such that the ball sits at (bx, by) in G.
function setWorld(rig, bx, by) {
  const c = Math.cos(rig.yaw);
  const s = Math.sin(rig.yaw);
  const m = rig.mirror;
  // Columns: G x -> (c, s), G y -> m * (-s, c)
  const ox = rig.ball.x - (c * bx - s * by * m);
  const oy = rig.ball.y - (s * bx + c * by * m);
  const oz = rig.groundFn(ox, oy);
  rig.origin[0] = ox;
  rig.origin[1] = oy;
  rig.origin[2] = oz;
  const W = rig.W;
  W.fill(0);
  W[0] = c; W[1] = s;
  W[4] = -s * m; W[5] = c * m;
  W[10] = 1;
  W[12] = ox; W[13] = oy; W[14] = oz;
  W[15] = 1;
  // Ball in G.
  toG(rig, rig.ball.x, rig.ball.y, rig.ball.z, rig.ballG, 0);
  // A point far down the target line for the finish look.
  rig.lookFar[0] = rig.ballG[0] * 0.6;
  rig.lookFar[1] = rig.ballG[1] + 60;
  rig.lookFar[2] = 9;
}

function toG(rig, x, y, z, out, oo) {
  const W = rig.W;
  const dx = x - W[12];
  const dy = y - W[13];
  const dz = z - W[14];
  // W's rotation part is orthogonal (mirror included): inverse = transpose.
  out[oo] = W[0] * dx + W[1] * dy;
  out[oo + 1] = W[4] * dx + W[5] * dy;
  out[oo + 2] = dz;
}
function fromG(rig, x, y, z, out, oo) {
  const W = rig.W;
  out[oo] = W[0] * x + W[4] * y + W[12];
  out[oo + 1] = W[1] * x + W[5] * y + W[13];
  out[oo + 2] = z + W[14];
}

// Feet on the ground: for each foot the ball-of-the-foot contact point in G (on the ground) and
// the ground's tilt there (rotation taking G's up to the terrain normal).
function setFeet(rig) {
  const D = rig.dims;
  const H = D.H;
  const st = rig.st;
  const f = D.foot;
  const feet = [];
  const w = new Float64Array(3);
  const n = new Float64Array(3);
  for (const [side, flare] of [[1, st.flareL], [-1, st.flareR]]) {
    const ay = side * st.half * H;
    const bxp = Math.cos(flare) * f.ball;
    const byp = ay + Math.sin(flare) * f.ball;
    fromG(rig, bxp, byp, 0, w, 0);
    const gz = rig.groundFn(w[0], w[1]) - rig.origin[2];
    rig.normalFn(w[0], w[1], n);
    // Normal into G (rotation part only; mirror flips y).
    const nx = rig.W[0] * n[0] + rig.W[1] * n[1];
    const ny = rig.W[4] * n[0] + rig.W[5] * n[1];
    const nz = n[2];
    const Rg = new Float64Array(9);
    // Minimal rotation from z to the normal.
    const ax = -ny;
    const ayy = nx;
    const al = len2(ax, ayy);
    if (al < 1e-6) m3id(Rg, 0);
    else m3axis(Rg, 0, ax / al, ayy / al, 0, Math.acos(clamp(nz, -1, 1)));
    feet.push({ side, flare, ball: new Float64Array([bxp, byp, gz]), Rg, ankleY: ay });
  }
  rig.feet = feet;
  // Pelvis drop so the lower foot can still be reached (slopes): about 0.6 of the height
  // difference below the stance centre.
  const lowest = Math.min(feet[0].ball[2], feet[1].ball[2]);
  rig.autoDrop = Math.max(0, -lowest * 0.75);
  void H;
}

// ------------------------------------------------------------------ pose evaluation
const BR = (b) => b * 9;
const BX = (b) => b * 3;

// Torso FK: pelvis, spine, chest, clavicles and shoulder joints (also used by the solves).
function torsoFK(rig, prm) {
  const D = rig.dims;
  const J = D.joints;
  const S = rig.s;
  const R = S.R;
  const X = S.X;
  const m = S.m;
  const H = D.H;
  // Pelvis: R = Rz(-turn) Rx(bank) Ry(tilt)
  m3axisA(m, 0, 0, 1, 0, prm, P.tilt, 1);
  m3axisA(m, 9, 1, 0, 0, prm, P.bank, 1);
  m3mul(m, 0, m, 9, m, 0);
  m3axisA(m, 9, 0, 0, 1, prm, P.hipTurn, -1);
  m3mul(R, BR(B.pelvis), m, 9, m, 0);
  X[0] = prm[P.shiftX] * H;
  X[1] = prm[P.shiftY] * H;
  X[2] = J[2] - (prm[P.drop] * H + rig.autoDrop);
  // Spine and chest share flex, bend and twist (40/60).
  const A = S.a;
  A[0] = prm[P.chest] - prm[P.hipTurn];
  for (let i = 0; i < 2; i++) {
    const b = i === 0 ? B.spine : B.chest;
    const par = i === 0 ? B.pelvis : B.spine;
    const k = i === 0 ? 0.4 : 0.6;
    const v = S.v;
    m3v(v, 0, R, BR(par), J[b * 3] - J[par * 3], J[b * 3 + 1] - J[par * 3 + 1], J[b * 3 + 2] - J[par * 3 + 2]);
    X[BX(b)] = X[BX(par)] + v[0];
    X[BX(b) + 1] = X[BX(par) + 1] + v[1];
    X[BX(b) + 2] = X[BX(par) + 2] + v[2];
    m3axisA(m, 0, 0, 1, 0, prm, P.flex, k);
    m3axisA(m, 9, 1, 0, 0, prm, P.bend, k);
    m3mul(m, 0, m, 0, m, 9);
    m3axisA(m, 9, 0, 0, 1, A, 0, -k);
    m3mul(m, 0, m, 0, m, 9);
    m3mul(R, BR(b), R, BR(par), m, 0);
  }
  // Putting rock: an extra rotation of the chest about the rig's rock axis.
  if (prm[P.rock] !== 0 && rig.rockAxis) {
    m3axisV(S.rk, 0, rig.rockAxis, 0, prm, P.rock);
    m3mul(R, BR(B.chest), S.rk, 0, R, BR(B.chest));
  }
  // Clavicles: the lead one protracts (reaches across) as the arm crosses the chest.
  for (let i = 0; i < 2; i++) {
    const cl = i === 0 ? B.clavL : B.clavR;
    const ua = i === 0 ? B.upperArmL : B.upperArmR;
    const sd = i === 0 ? 1 : -1;
    const v = S.v;
    m3v(v, 0, R, BR(B.chest), J[cl * 3] - J[B.chest * 3], J[cl * 3 + 1] - J[B.chest * 3 + 1], J[cl * 3 + 2] - J[B.chest * 3 + 2]);
    X[BX(cl)] = X[BX(B.chest)] + v[0];
    X[BX(cl) + 1] = X[BX(B.chest) + 1] + v[1];
    X[BX(cl) + 2] = X[BX(B.chest) + 2] + v[2];
    // Protraction: rotate about the chest's z axis (forward for the lead side).
    m3axisA(m, 0, 0, 0, 1, prm, P.clav, sd > 0 ? -1 : 0);
    m3mul(R, BR(cl), R, BR(B.chest), m, 0);
    m3v(v, 0, R, BR(cl), J[ua * 3] - J[cl * 3], J[ua * 3 + 1] - J[cl * 3 + 1], J[ua * 3 + 2] - J[cl * 3 + 2]);
    X[BX(ua)] = X[BX(cl)] + v[0];
    X[BX(ua) + 1] = X[BX(cl) + 1] + v[1];
    X[BX(ua) + 2] = X[BX(cl) + 2] + v[2];
  }
}

// Lead wrist (G) from the arm parameters (after torsoFK): the shoulder plus k x the arm's length
// along (e, phi) in the chest frame; then the club's grip point hangs from it through the lead
// hand's grip frame. Writes the wrist to out[oo..] and the grip to out[oo+3..]; needs the club
// rotation in R[club].
function gripFromArm(rig, prm, out, oo) {
  const S = rig.s;
  const R = S.R;
  const X = S.X;
  const e = prm[P.e];
  const ph = prm[P.phi];
  const se = Math.sin(e);
  m3v(out, oo, R, BR(B.chest), se * Math.cos(ph), se * Math.sin(ph), -Math.cos(e));
  const L = rig.armLen * prm[P.k];
  out[oo] = X[BX(B.upperArmL)] + out[oo] * L;
  out[oo + 1] = X[BX(B.upperArmL) + 1] + out[oo + 1] * L;
  out[oo + 2] = X[BX(B.upperArmL) + 2] + out[oo + 2] * L;
  const w = rig.dims.grip.lead.wrist;
  m3v(out, oo + 3, R, BR(B.club), w[0], w[1], w[2]);
  out[oo + 3] = out[oo] - out[oo + 3];
  out[oo + 4] = out[oo + 1] - out[oo + 4];
  out[oo + 5] = out[oo + 2] - out[oo + 5];
}

// Two-bone IK. root -> target with segment lengths l1, l2 and pole direction; writes the upper
// and lower bone world rotations (bones b1, b2) and their origins. bendSign: +1 when the joint
// bends toward the bone's local -X... arms: the forearm swings toward the upper arm's +X, which
// points away from the pole; legs: toward -X (the knee, toward the pole, is +X).
// Inputs in rig.s.k: root (0..2), target (3..5), lengths (6, 7), pole (8..10), twist hint for
// the lower bone (11..13).
function ik(rig, b1, b2, armLike) {
  const S = rig.s;
  const R = S.R;
  const X = S.X;
  const K = S.k;
  const rx = K[0];
  const ry = K[1];
  const rz = K[2];
  const tx = K[3];
  const ty = K[4];
  const tz = K[5];
  const l1 = K[6];
  const l2 = K[7];
  const px = K[8];
  const py = K[9];
  const pz = K[10];
  const twistX = K[11];
  const twistY = K[12];
  const twistZ = K[13];
  let dx = tx - rx;
  let dy = ty - ry;
  let dz = tz - rz;
  let d = len3(dx, dy, dz);
  if (d < 1e-6) {
    dx = 0;
    dy = 0;
    dz = -1;
    d = 1e-6;
  }
  const ux = dx / d;
  const uy = dy / d;
  const uz = dz / d;
  const dd = clamp(d, Math.abs(l1 - l2) + 1e-4, (l1 + l2) * 0.99995);
  const a = (l1 * l1 - l2 * l2 + dd * dd) / (2 * dd);
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  // Pole perpendicular to the root-target line.
  let pd = px * ux + py * uy + pz * uz;
  let qx = px - ux * pd;
  let qy = py - uy * pd;
  let qz = pz - uz * pd;
  let ql = len3(qx, qy, qz);
  if (ql < 1e-6) {
    // Any perpendicular.
    qx = Math.abs(uz) < 0.9 ? -uy : 1;
    qy = Math.abs(uz) < 0.9 ? ux : 0;
    qz = 0;
    pd = qx * ux + qy * uy + qz * uz;
    qx -= ux * pd;
    qy -= uy * pd;
    qz -= uz * pd;
    ql = len3(qx, qy, qz) || 1;
  }
  qx /= ql;
  qy /= ql;
  qz /= ql;
  const ex = rx + ux * a + qx * h;
  const ey = ry + uy * a + qy * h;
  const ez = rz + uz * a + qz * h;
  // Upper bone: origin at root, +Z from the joint back toward the root.
  X[BX(b1)] = rx;
  X[BX(b1) + 1] = ry;
  X[BX(b1) + 2] = rz;
  let zx = rx - ex;
  let zy = ry - ey;
  let zz = rz - ez;
  let zl = len3(zx, zy, zz) || 1;
  zx /= zl;
  zy /= zl;
  zz /= zl;
  const sg = armLike ? -1 : 1;
  K[0] = zx;
  K[1] = zy;
  K[2] = zz;
  K[3] = sg * qx;
  K[4] = sg * qy;
  K[5] = sg * qz;
  frameFrom(R, BR(b1), K);
  // Lower bone: from the joint toward the (reachable) target.
  X[BX(b2)] = ex;
  X[BX(b2) + 1] = ey;
  X[BX(b2) + 2] = ez;
  let wx = tx - ex;
  let wy = ty - ey;
  let wz = tz - ez;
  zl = len3(wx, wy, wz) || 1;
  zx = -wx / zl;
  zy = -wy / zl;
  zz = -wz / zl;
  // Twist of the lower bone: blend the upper bone's x with the given hint (the hand's x axis).
  const ux1 = R[BR(b1)];
  const uy1 = R[BR(b1) + 1];
  const uz1 = R[BR(b1) + 2];
  K[0] = zx;
  K[1] = zy;
  K[2] = zz;
  K[3] = ux1 + twistX;
  K[4] = uy1 + twistY;
  K[5] = uz1 + twistZ;
  frameFrom(R, BR(b2), K);
}

// Rotation with +Z = z and +X as close as possible to hint (orthonormalised).
function frameFrom(R, o, K) {
  const zx = K[0];
  const zy = K[1];
  const zz = K[2];
  const hx = K[3];
  const hy = K[4];
  const hz = K[5];
  const d = hx * zx + hy * zy + hz * zz;
  let xx = hx - zx * d;
  let xy = hy - zy * d;
  let xz = hz - zz * d;
  let l = len3(xx, xy, xz);
  if (l < 1e-6) {
    xx = Math.abs(zz) < 0.9 ? zy : 1;
    xy = Math.abs(zz) < 0.9 ? -zx : 0;
    xz = 0;
    const d2 = xx * zx + xy * zy + xz * zz;
    xx -= zx * d2;
    xy -= zy * d2;
    xz -= zz * d2;
    l = len3(xx, xy, xz) || 1;
  }
  xx /= l;
  xy /= l;
  xz /= l;
  R[o] = xx; R[o + 1] = xy; R[o + 2] = xz;
  R[o + 3] = zy * xz - zz * xy; R[o + 4] = zz * xx - zx * xz; R[o + 5] = zx * xy - zy * xx;
  R[o + 6] = zx; R[o + 7] = zy; R[o + 8] = zz;
}

// Full pose: world rotations and positions of every bone in G (rig.s.R, rig.s.X).
export function evalPose(rig, prm) {
  const D = rig.dims;
  const J = D.joints;
  const S = rig.s;
  const R = S.R;
  const X = S.X;
  const m = S.m;
  const v = S.v;
  const H = D.H;
  torsoFK(rig, prm);
  // ---- club and hands (a putting stroke rocks the club with the shoulders)
  m3FromQuat(R, BR(B.club), prm, P.qx);
  if (prm[P.rock] !== 0 && rig.rockAxis) m3mul(R, BR(B.club), S.rk, 0, R, BR(B.club));
  gripFromArm(rig, prm, v, 0);
  X[BX(B.club)] = v[3];
  X[BX(B.club) + 1] = v[4];
  X[BX(B.club) + 2] = v[5];
  const G = D.grip;
  for (let i = 0; i < 2; i++) {
    const hb = i === 0 ? B.handL : B.handR;
    const fr = i === 0 ? G.lead : G.trail;
    m3mul(R, BR(hb), R, BR(B.club), fr.rot, 0);
    m3v(v, 6, R, BR(B.club), fr.wrist[0], fr.wrist[1], fr.wrist[2]);
    X[BX(hb)] = v[3] + v[6];
    X[BX(hb) + 1] = v[4] + v[7];
    X[BX(hb) + 2] = v[5] + v[8];
  }
  // ---- arms (IK to the wrists)
  const la = D.upperArm;
  const lf = D.forearm;
  // Trail shoulder reach: the clavicle gives up to 3% of the height when the trail arm is short.
  {
    const s0 = BX(B.upperArmR);
    const tx = X[BX(B.handR)] - X[s0];
    const ty = X[BX(B.handR) + 1] - X[s0 + 1];
    const tz = X[BX(B.handR) + 2] - X[s0 + 2];
    const dist = len3(tx, ty, tz);
    const over = dist - (la + lf) * 0.995;
    if (over > 0) {
      const k = Math.min(over, 0.03 * H) / dist;
      X[s0] += tx * k;
      X[s0 + 1] += ty * k;
      X[s0 + 2] += tz * k;
    }
  }
  for (let i = 0; i < 2; i++) {
    const ua = i === 0 ? B.upperArmL : B.upperArmR;
    const fa = i === 0 ? B.forearmL : B.forearmR;
    const hb = i === 0 ? B.handL : B.handR;
    const pb = i === 0 ? P.lelX : P.telX;
    const s0 = BX(ua);
    const K = S.k;
    K[0] = X[s0];
    K[1] = X[s0 + 1];
    K[2] = X[s0 + 2];
    K[3] = X[BX(hb)];
    K[4] = X[BX(hb) + 1];
    K[5] = X[BX(hb) + 2];
    K[6] = la;
    K[7] = lf;
    K[8] = prm[pb];
    K[9] = prm[pb + 1];
    K[10] = prm[pb + 2];
    K[11] = R[BR(hb)];
    K[12] = R[BR(hb) + 1];
    K[13] = R[BR(hb) + 2];
    ik(rig, ua, fa, true);
  }
  // ---- head: look at the ball (or down the target line)
  {
    const nb = B.neck;
    m3v(v, 0, R, BR(B.chest), J[nb * 3] - J[B.chest * 3], J[nb * 3 + 1] - J[B.chest * 3 + 1], J[nb * 3 + 2] - J[B.chest * 3 + 2]);
    X[BX(nb)] = X[BX(B.chest)] + v[0];
    X[BX(nb) + 1] = X[BX(B.chest) + 1] + v[1];
    X[BX(nb) + 2] = X[BX(B.chest) + 2] + v[2];
    const hc = 0.075 * H;
    // Eye point (approx): above the neck along the chest's up axis.
    const ex = X[BX(nb)] + R[BR(B.chest) + 6] * hc + R[BR(B.chest)] * 0.04 * H;
    const ey = X[BX(nb) + 1] + R[BR(B.chest) + 7] * hc + R[BR(B.chest) + 1] * 0.04 * H;
    const ez = X[BX(nb) + 2] + R[BR(B.chest) + 8] * hc + R[BR(B.chest) + 2] * 0.04 * H;
    const bg = rig.ballG;
    let fx = bg[0] - ex;
    let fy = bg[1] - ey;
    let fz = bg[2] - ez;
    let fl = len3(fx, fy, fz) || 1;
    fx /= fl;
    fy /= fl;
    fz /= fl;
    // The head tilts down less than the eyes do.
    fz *= 0.62;
    const lk = prm[P.look];
    if (lk > 0) {
      const lf2 = rig.lookFar;
      let gx = lf2[0] - ex;
      let gy = lf2[1] - ey;
      let gz = lf2[2] - ez;
      const gl = len3(gx, gy, gz) || 1;
      gx /= gl;
      gy /= gl;
      gz /= gl;
      fx = lerp(fx, gx, lk);
      fy = lerp(fy, gy, lk);
      fz = lerp(fz, gz, lk);
    }
    fl = len3(fx, fy, fz) || 1;
    fx /= fl;
    fy /= fl;
    fz /= fl;
    // Up: the chest's up blended with the world's.
    let ux = R[BR(B.chest) + 6] * 0.5;
    let uy = R[BR(B.chest) + 7] * 0.5;
    let uz = R[BR(B.chest) + 8] * 0.5 + 0.5;
    // Head frame: x = forward, z = up (orthogonalised), y = z x x.
    const d = ux * fx + uy * fy + uz * fz;
    ux -= fx * d;
    uy -= fy * d;
    uz -= fz * d;
    const ul = len3(ux, uy, uz) || 1;
    ux /= ul;
    uy /= ul;
    uz /= ul;
    // Desired head rotation: columns x = f, y = z x f, z = u.
    m[18] = fx; m[19] = fy; m[20] = fz;
    m[21] = uy * fz - uz * fy; m[22] = uz * fx - ux * fz; m[23] = ux * fy - uy * fx;
    m[24] = ux; m[25] = uy; m[26] = uz;
    // Relative to the chest; the neck takes 40% of it.
    m3tmul(m, 27, R, BR(B.chest), m, 18);
    quatFromM3(v, 6, m, 27);
    // Clamp the head's total turn on the chest to 85 degrees.
    let qw = v[9];
    if (qw < 0) {
      v[6] = -v[6];
      v[7] = -v[7];
      v[8] = -v[8];
      qw = -qw;
    }
    const ang = 2 * Math.acos(clamp(qw, -1, 1));
    const maxA = 1.48;
    const sc = ang > maxA ? maxA / ang : 1;
    const sa = Math.sqrt(v[6] * v[6] + v[7] * v[7] + v[8] * v[8]);
    let axx = 1;
    let axy = 0;
    let axz = 0;
    if (sa > 1e-9) {
      axx = v[6] / sa;
      axy = v[7] / sa;
      axz = v[8] / sa;
    }
    const A = S.a;
    A[0] = axx;
    A[1] = axy;
    A[2] = axz;
    A[3] = ang * sc * 0.4;
    A[4] = ang * sc;
    m3axisV(m, 36, A, 0, A, 3);
    m3mul(R, BR(nb), R, BR(B.chest), m, 36);
    m3axisV(m, 36, A, 0, A, 4);
    m3mul(R, BR(B.head), R, BR(B.chest), m, 36);
    const hb = B.head;
    m3v(v, 0, R, BR(nb), J[hb * 3] - J[nb * 3], J[hb * 3 + 1] - J[nb * 3 + 1], J[hb * 3 + 2] - J[nb * 3 + 2]);
    X[BX(hb)] = X[BX(nb)] + v[0];
    X[BX(hb) + 1] = X[BX(nb) + 1] + v[1];
    X[BX(hb) + 2] = X[BX(nb) + 2] + v[2];
  }
  // ---- legs: feet planted (trail heel lifts and pivots), IK from the hips.
  const f = D.foot;
  for (let side = 0; side < 2; side++) {
    const ft = rig.feet[side];
    const lead = side === 0;
    const th = lead ? B.thighL : B.thighR;
    const sn = lead ? B.shinL : B.shinR;
    const fb = lead ? B.footL : B.footR;
    const A = S.a;
    A[0] = ft.flare + (lead ? 0 : prm[P.pivot]);
    A[1] = lead ? 0 : prm[P.heel];
    // Foot rotation: ground tilt * Rz(flare + pivot) * Ry(heel lift).
    m3axisA(m, 0, 0, 0, 1, A, 0, 1);
    m3axisA(m, 9, 0, 1, 0, A, 1, 1);
    m3mul(m, 0, m, 0, m, 9);
    m3mul(R, BR(fb), ft.Rg, 0, m, 0);
    // Ankle = ball contact + R * (ankle - ball contact) in foot space.
    m3v(v, 0, R, BR(fb), -f.ball, 0, D.ankleZ);
    const ax = ft.ball[0] + v[0];
    const ay = ft.ball[1] + v[1];
    const az = ft.ball[2] + v[2];
    // Hip joint.
    m3v(v, 0, R, BR(B.pelvis), J[th * 3] - J[B.pelvis * 3], J[th * 3 + 1] - J[B.pelvis * 3 + 1], J[th * 3 + 2] - J[B.pelvis * 3 + 2]);
    const hx = X[0] + v[0];
    const hy = X[1] + v[1];
    const hz = X[2] + v[2];
    // Knee pole: forward along the foot, the trail knee kicking in toward the target.
    const pa = ft.flare * 0.5 + (lead ? 0 : prm[P.kneeIn]);
    const K = S.k;
    K[0] = hx;
    K[1] = hy;
    K[2] = hz;
    K[3] = ax;
    K[4] = ay;
    K[5] = az;
    K[6] = D.thigh;
    K[7] = D.shin;
    K[8] = Math.cos(pa);
    K[9] = Math.sin(pa);
    K[10] = 0.05;
    K[11] = 0;
    K[12] = 0;
    K[13] = 0;
    ik(rig, th, sn, false);
    X[BX(fb)] = ax;
    X[BX(fb) + 1] = ay;
    X[BX(fb) + 2] = az;
  }
}

// Skin matrices (Float32Array BONE_COUNT * 16): world (W) x [R | X] x T(-rest joint).
function writeSkin(rig, out) {
  const W = rig.W;
  const J = rig.dims.joints;
  const R = rig.s.R;
  const X = rig.s.X;
  for (let b = 0; b < BONE_COUNT; b++) {
    const r = b * 9;
    const jx = J[b * 3];
    const jy = J[b * 3 + 1];
    const jz = J[b * 3 + 2];
    const tx = X[b * 3] - (R[r] * jx + R[r + 3] * jy + R[r + 6] * jz);
    const ty = X[b * 3 + 1] - (R[r + 1] * jx + R[r + 4] * jy + R[r + 7] * jz);
    const tz = X[b * 3 + 2] - (R[r + 2] * jx + R[r + 5] * jy + R[r + 8] * jz);
    const o = b * 16;
    for (let c = 0; c < 3; c++) {
      const x = R[r + c * 3];
      const y = R[r + c * 3 + 1];
      const z = R[r + c * 3 + 2];
      out[o + c * 4] = W[0] * x + W[4] * y;
      out[o + c * 4 + 1] = W[1] * x + W[5] * y;
      out[o + c * 4 + 2] = z;
      out[o + c * 4 + 3] = 0;
    }
    out[o + 12] = W[0] * tx + W[4] * ty + W[12];
    out[o + 13] = W[1] * tx + W[5] * ty + W[13];
    out[o + 14] = tz + W[14];
    out[o + 15] = 1;
  }
}

// ------------------------------------------------------------------ solves
// Club orientation in G from lie, lean (+ = hands ahead) and face angle (+ = open): writes the
// quaternion into prm[P.qx..qw] and returns nothing; m holds the matrix at m[0..8].
function clubBasis(rig, lie, lean, face, out, oo) {
  const ca = Math.cos(lie);
  const sa = Math.sin(lie);
  // s0: grip -> head with no lean (out and down); lean tilts the head toward -Y (hands ahead).
  const cl = Math.cos(-lean);
  const sl = Math.sin(-lean);
  let sx = ca * cl;
  let sy = sl;
  let sz = -sa * cl;
  const l = len3(sx, sy, sz);
  sx /= l;
  sy /= l;
  sz /= l;
  // Z = -s; X = +Y orthogonalised (square face toward the target); then face rotation about Z.
  const zx = -sx;
  const zy = -sy;
  const zz = -sz;
  let xx = 0 - zx * (zy * 1);
  let xy = 1 - zy * (zy * 1);
  let xz = 0 - zz * (zy * 1);
  const xl = len3(xx, xy, xz) || 1;
  xx /= xl;
  xy /= xl;
  xz /= xl;
  const yx = zy * xz - zz * xy;
  const yy = zz * xx - zx * xz;
  const yz = zx * xy - zy * xx;
  // Open face: rotate X toward +Y_club... about Z by +face (counter-clockwise looking down -s).
  const cf = Math.cos(face);
  const sf = Math.sin(face);
  out[oo] = xx * cf + yx * sf;
  out[oo + 1] = xy * cf + yy * sf;
  out[oo + 2] = xz * cf + yz * sf;
  out[oo + 3] = yx * cf - xx * sf;
  out[oo + 4] = yy * cf - xy * sf;
  out[oo + 5] = yz * cf - xz * sf;
  out[oo + 6] = zx;
  out[oo + 7] = zy;
  out[oo + 8] = zz;
}

function clubBasisFromDirs(sh, fc, out, oo) {
  let zx = -sh[0];
  let zy = -sh[1];
  let zz = -sh[2];
  const zl = len3(zx, zy, zz) || 1;
  zx /= zl;
  zy /= zl;
  zz /= zl;
  const d = fc[0] * zx + fc[1] * zy + fc[2] * zz;
  let xx = fc[0] - zx * d;
  let xy = fc[1] - zy * d;
  let xz = fc[2] - zz * d;
  const xl = len3(xx, xy, xz) || 1;
  xx /= xl;
  xy /= xl;
  xz /= xl;
  out[oo] = xx; out[oo + 1] = xy; out[oo + 2] = xz;
  out[oo + 3] = zy * xz - zz * xy; out[oo + 4] = zz * xx - zx * xz; out[oo + 5] = zx * xy - zy * xx;
  out[oo + 6] = zx; out[oo + 7] = zy; out[oo + 8] = zz;
}

// Set the arm parameters (e, phi, k) of prm so the lead grip lands on grip (G).
function setArmToGrip(rig, prm, gx, gy, gz) {
  torsoFK(rig, prm);
  const S = rig.s;
  const X = S.X;
  const v = S.v;
  // The wrist hangs above the grip through the club's (already set) rotation.
  m3FromQuat(S.m, 54, prm, P.qx);
  const w = rig.dims.grip.lead.wrist;
  m3v(v, 3, S.m, 54, w[0], w[1], w[2]);
  const dx = gx + v[3] - X[BX(B.upperArmL)];
  const dy = gy + v[4] - X[BX(B.upperArmL) + 1];
  const dz = gz + v[5] - X[BX(B.upperArmL) + 2];
  const d = len3(dx, dy, dz) || 1e-6;
  m3tv(v, 0, S.R, BR(B.chest), dx / d, dy / d, dz / d);
  prm[P.e] = Math.acos(clamp(-v[2], -1, 1));
  prm[P.phi] = Math.atan2(v[1], v[0]);
  prm[P.k] = d / rig.armLen;
}

// Wrist (lead hand bone origin) distance from the lead shoulder for a club placed with its
// grip at g and rotation m (G), after torsoFK.
function leadWristDist(rig, g, m, mo) {
  const S = rig.s;
  const X = S.X;
  const v = S.v;
  const w = rig.dims.grip.lead.wrist;
  m3v(v, 6, m, mo, w[0], w[1], w[2]);
  return len3(g[0] + v[6] - X[BX(B.upperArmL)], g[1] + v[7] - X[BX(B.upperArmL) + 1], g[2] + v[8] - X[BX(B.upperArmL) + 2]);
}
function trailWristDist(rig, g, m, mo) {
  const S = rig.s;
  const X = S.X;
  const v = S.v;
  const w = rig.dims.grip.trail.wrist;
  m3v(v, 6, m, mo, w[0], w[1], w[2]);
  return len3(g[0] + v[6] - X[BX(B.upperArmR)], g[1] + v[7] - X[BX(B.upperArmR) + 1], g[2] + v[8] - X[BX(B.upperArmR) + 2]);
}

// Grip position for a club whose impact point sits at target (G) with rotation m.
function gripForImpact(rig, m, mo, tx, ty, tz, out) {
  const im = rig.spec.impact;
  const v = rig.s.v;
  m3v(v, 9, m, mo, im[0], im[1], im[2]);
  out[0] = tx - v[9];
  out[1] = ty - v[10];
  out[2] = tz - v[11];
}

function baseParams(rig) {
  const prm = new Float64Array(NP);
  prm[P.qw] = 1;
  prm[P.k] = 0.95;
  prm[P.telX] = -0.5;
  prm[P.telY] = -0.4;
  prm[P.telZ] = -0.8;
  prm[P.lelX] = -0.5;
  prm[P.lelY] = 0.4;
  prm[P.lelZ] = -0.8;
  return prm;
}

// Bisection for the hip hinge so the lead wrist is `reach` of the arm's length from the shoulder.
function solveTilt(rig, prm, g, m, reach) {
  const L = (rig.dims.upperArm + rig.dims.forearm) * reach;
  let lo = -0.2;
  let hi = 1.25;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    prm[P.tilt] = mid;
    torsoFK(rig, prm);
    const d = leadWristDist(rig, g, m, 0);
    // More hinge brings the shoulder down toward the hands.
    if (d > L) lo = mid;
    else hi = mid;
  }
  prm[P.tilt] = (lo + hi) / 2;
  torsoFK(rig, prm);
  return leadWristDist(rig, g, m, 0) / (rig.dims.upperArm + rig.dims.forearm);
}

// Address: the club soled just behind the ball at its address lie; the spine angle is chosen in
// a realistic band for the club (more bend with the short clubs) so the lead arm hangs about
// `hang` (rad) forward of vertical, and for each spine angle the stance distance is solved so
// the lead arm reaches with a soft elbow (`reach`).
function solveAddress(rig, bx0, by) {
  const D = rig.dims;
  const H = D.H;
  // The arm parameters place the lead wrist: k x (upper arm + forearm) from the shoulder.
  rig.armLen = D.upperArm + D.forearm;
  const kd = rig.design.addr;
  const prm = baseParams(rig);
  prm[P.shiftX] = kd.shiftX;
  prm[P.shiftY] = rig.spec.head === 'driver' ? -0.012 : -0.004;
  prm[P.drop] = kd.drop;
  prm[P.flex] = kd.flex;
  prm[P.bend] = kd.bend;
  const m = new Float64Array(9);
  const g = new Float64Array(3);
  const bz = rig.ballG[2];
  clubBasis(rig, rig.spec.lie + kd.lie, kd.lean, kd.face, m, 0);
  const L = (D.upperArm + D.forearm) * kd.reach;
  const w = D.grip.lead.wrist;
  const v = rig.s.v;
  m3v(v, 12, m, 0, w[0], w[1], w[2]);
  // Grip for a stance distance bx (soled just behind the ball).
  const gripAt = (bx) => gripForImpact(rig, m, 0, bx, by - (BALL_R + 0.006), bz, g);
  // For a hinge angle: the stance distance that gives the reach, and the arm's forward angle.
  const solveBx = (tilt) => {
    prm[P.tilt] = tilt;
    torsoFK(rig, prm);
    const X = rig.s.X;
    const sx = X[BX(B.upperArmL)];
    const sy = X[BX(B.upperArmL) + 1];
    const sz = X[BX(B.upperArmL) + 2];
    let lo = 0.2 * H;
    let hi = 1.0 * H;
    const dist = (bx) => {
      gripAt(bx);
      return len3(g[0] + v[12] - sx, g[1] + v[13] - sy, g[2] + v[14] - sz);
    };
    // d grows with bx once the wrist is in front of the shoulder; start the bracket there.
    gripAt(lo);
    lo = Math.max(lo, lo + (sx - (g[0] + v[12])));
    if (dist(lo) > L) {
      gripAt(lo);
      return { bx: lo, ang: Math.atan2(g[0] + v[12] - sx, sz - g[2] - v[14]) };
    }
    for (let i = 0; i < 36; i++) {
      const mid = (lo + hi) / 2;
      if (dist(mid) > L) hi = mid;
      else lo = mid;
    }
    const bx = (lo + hi) / 2;
    gripAt(bx);
    return { bx, ang: Math.atan2(g[0] + v[12] - sx, sz - g[2] - v[14]) };
  };
  // The club's spine angle, unless the arms would then hang outside a natural band (a short
  // golfer stands taller, a tall one bends more); the arm angle grows with the hinge.
  const t0 = kd.posture - kd.flex;
  let r = solveBx(t0);
  const fix = (target, tA, tB) => {
    let a = tA;
    let b = tB;
    for (let i = 0; i < 30; i++) {
      const mid = (a + b) / 2;
      const rm = solveBx(mid);
      if ((rm.ang > target) === (tA < tB)) b = mid;
      else a = mid;
    }
    return solveBx((a + b) / 2);
  };
  if (r.ang > kd.angMax) {
    const rl = solveBx(t0 - 0.26);
    r = rl.ang > kd.angMax ? rl : fix(kd.angMax, t0 - 0.26, t0);
  } else if (r.ang < kd.angMin) {
    const rh = solveBx(t0 + 0.2);
    r = rh.ang < kd.angMin ? rh : fix(kd.angMin, t0, t0 + 0.2);
  }
  const bx = r.bx;
  gripAt(bx);
  quatFromM3(prm, P.qx, m, 0);
  setArmToGrip(rig, prm, g[0], g[1], g[2]);
  void bx0;
  return { bx, prm, grip: g, m };
}

// Impact key: the club's impact point exactly on the ball; hips open, shoulders square-ish,
// trail shoulder low, hands ahead; the hinge solved so the lead arm is straight.
function solveImpact(rig, addr) {
  const kd = rig.design.imp;
  const H = rig.dims.H;
  const putt = rig.spec.head === 'putter';
  const prm = new Float64Array(addr);
  if (!putt) {
    prm[P.hipTurn] = -0.68;
    prm[P.shiftY] = 0.075;
    prm[P.shiftX] = addr[P.shiftX] + 0.006;
    prm[P.drop] = addr[P.drop] + 0.004;
    prm[P.bank] = 0.05;
    prm[P.chest] = -0.32;
    prm[P.flex] = addr[P.flex] - 0.02;
    prm[P.bend] = addr[P.bend] + 0.13 + (rig.spec.head === 'driver' ? 0.04 : 0);
    prm[P.heel] = 0.28;
    prm[P.kneeIn] = 0.45;
    prm[P.telX] = -0.5;
    prm[P.telY] = -0.3;
    prm[P.telZ] = -0.8;
  }
  const m = new Float64Array(9);
  const g = new Float64Array(3);
  const bg = rig.ballG;
  clubBasis(rig, rig.spec.lie + kd.lie, kd.lean, kd.face, m, 0);
  gripForImpact(rig, m, 0, bg[0], bg[1], bg[2], g);
  // Trail arm reach: more side bend (trail shoulder lower) until the trail hand reaches.
  for (let i = 0; i < 8; i++) {
    solveTilt(rig, prm, g, m, kd.reach);
    const L = (rig.dims.upperArm + rig.dims.forearm) * 0.99;
    if (trailWristDist(rig, g, m, 0) <= L || putt) break;
    prm[P.bend] += 0.035;
  }
  quatFromM3(prm, P.qx, m, 0);
  setArmToGrip(rig, prm, g[0], g[1], g[2]);
  void H;
  return prm;
}

// A designed key: body angles relative to the address, grip from the design (scaled, pulled
// toward the solved grip), club from the shaft and face directions.
function designKey(rig, base, des, anchorGrip, mirrorVariant) {
  const D = rig.dims;
  const H = D.H;
  const sc = H / 1.8;
  const prm = new Float64Array(base);
  const a = base;
  prm[P.hipTurn] = des.hipTurn ?? 0;
  prm[P.shiftY] = des.shiftY ?? a[P.shiftY];
  prm[P.shiftX] = a[P.shiftX] + (des.shiftXD || 0);
  prm[P.drop] = a[P.drop] + (des.drop || 0);
  prm[P.tilt] = a[P.tilt] + (des.tiltD || 0);
  prm[P.bank] = des.bank || 0;
  prm[P.chest] = des.chest ?? 0;
  prm[P.flex] = des.flex ?? a[P.flex];
  prm[P.bend] = des.bend ?? a[P.bend];
  prm[P.heel] = des.heel || 0;
  prm[P.pivot] = des.pivot || 0;
  prm[P.kneeIn] = des.kneeIn || 0;
  prm[P.look] = des.look || 0;
  prm[P.clav] = des.clav || 0;
  prm[P.rock] = 0;
  if (des.tel) {
    prm[P.telX] = des.tel[0];
    prm[P.telY] = des.tel[1];
    prm[P.telZ] = des.tel[2];
  }
  if (des.lel) {
    prm[P.lelX] = des.lel[0];
    prm[P.lelY] = des.lel[1];
    prm[P.lelZ] = des.lel[2];
  }
  // Grip: the reference position scaled, pulled toward the solved anchor grip by w.
  const ref = REF_GRIP;
  const w = des.w || 0;
  const gx = des.grip[0] * sc + (anchorGrip[0] - ref[0] * sc) * w;
  const gy = des.grip[1] * sc + (anchorGrip[1] - ref[1] * sc) * w;
  const gz = des.grip[2] * sc + (anchorGrip[2] - ref[2] * sc) * w;
  const m = rig.s.m;
  clubBasisFromDirs(des.shaft, des.face, m, 45);
  quatFromM3(prm, P.qx, m, 45);
  setArmToGrip(rig, prm, gx, gy, gz);
  // The lead arm stays straight through the backswing and downswing; it folds after impact.
  const kMin = des.kMin != null ? des.kMin : 0.965;
  prm[P.k] = clamp(prm[P.k], Math.min(kMin, des.k ?? 1), des.k != null ? des.k : 0.995);
  void mirrorVariant;
  return prm;
}
// Grip of the reference golfer (1.8 m, 7-iron) at address, for scaling the designed grips.
const REF_GRIP = [0.3, 0.035, 0.78];

function mergeDesign(base, over) {
  return over ? { ...base, ...over } : base;
}

// Build every key for the rig (address, impact, designed positions, putting setup).
function buildKeys(rig, addrPrm) {
  const putt = rig.spec.head === 'putter';
  const P1 = addrPrm;
  const P7 = solveImpact(rig, P1);
  const keys = { P1, P7, putt };
  // Rock axis for putting: perpendicular to the target line and the chest -> putter head line.
  torsoFK(rig, P1);
  {
    const X = rig.s.X;
    const cx = X[BX(B.chest)];
    const cy = X[BX(B.chest) + 1];
    const cz = X[BX(B.chest) + 2];
    const bg = rig.ballG;
    const hx = bg[0] - cx;
    const hy = bg[1] - cy;
    const hz = bg[2] - cz;
    // axis = Y x h
    let ax = hz;
    let ay = 0;
    let az = -hx;
    const l = len3(ax, ay, az) || 1;
    ax /= l;
    az /= l;
    // Positive rock must move the head back (-Y): rotating h about axis by +eps changes y by
    // eps * (axis x h).y = eps * (az*hx - ax*hz).
    const dy = az * hx - ax * hz;
    const sgn = dy > 0 ? -1 : 1;
    rig.rockAxis = new Float64Array([ax * sgn, ay * sgn, az * sgn]);
    void hy;
  }
  if (putt) return keys;
  const anchorA = gripOf(rig, P1);
  const anchorI = gripOf(rig, P7);
  const k = (name, variant) => {
    const des = mergeDesign(DESIGN[name], variant && VARIANTS[variant] ? VARIANTS[variant][name] : null);
    const anchor = name === 'P2' || name === 'P3' || name === 'P4' || name === 'P4X' ? anchorA : anchorI;
    return designKey(rig, P1, des, anchor);
  };
  keys.back = [P1, k('P2'), k('P3'), k('P4'), k('P4X')];
  keys.down = [P7, k('P6'), k('P5'), keys.back[3], keys.back[4]];
  keys.make = k;
  // Every follow-through variant up front (fixed shapes; no work at the strike).
  keys.follow = {};
  for (const v of FOLLOW_VARIANTS) keys.follow[v] = [P7, k('P8', v), k('P9', v), k('P10', v)];
  for (const qs of [keys.back, keys.down, ...Object.values(keys.follow)]) alignQuats(qs);
  return keys;
}
const FOLLOW_VARIANTS = ['normal', 'low', 'flop', 'draw', 'cut', 'bigfinish'];

function followKeys(rig, variant) {
  const f = rig.keys.follow;
  return f[variant] || f.normal;
}

function gripOf(rig, prm) {
  torsoFK(rig, prm);
  m3FromQuat(rig.s.R, BR(B.club), prm, P.qx);
  const g = new Float64Array(6);
  gripFromArm(rig, prm, g, 0);
  return g.subarray(3, 6);
}

// Keep consecutive quaternions in the same hemisphere (so splines take the short way).
function alignQuats(list) {
  for (let i = 1; i < list.length; i++) {
    const a = list[i - 1];
    const b = list[i];
    const d = a[P.qx] * b[P.qx] + a[P.qy] * b[P.qy] + a[P.qz] * b[P.qz] + a[P.qw] * b[P.qw];
    if (d < 0) for (let j = P.qx; j <= P.qw; j++) b[j] = -b[j];
  }
}

// Catmull-Rom over a key list at u (0..n-1), into out. Quaternion slots are normalised.
function splineKeys(keys, u, out) {
  const n = keys.length;
  const uu = clamp(u, 0, n - 1);
  let i = Math.floor(uu);
  if (i >= n - 1) i = n - 2;
  const t = uu - i;
  const k0 = keys[Math.max(0, i - 1)];
  const k1 = keys[i];
  const k2 = keys[i + 1];
  const k3 = keys[Math.min(n - 1, i + 2)];
  const t2 = t * t;
  const t3 = t2 * t;
  for (let j = 0; j < NP; j++) {
    const p0 = k0[j];
    const p1 = k1[j];
    const p2 = k2[j];
    const p3 = k3[j];
    out[j] = 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
  }
  normQ(out);
}
function normQ(o) {
  const l = len4(o[P.qx], o[P.qy], o[P.qz], o[P.qw]) || 1;
  o[P.qx] /= l;
  o[P.qy] /= l;
  o[P.qz] /= l;
  o[P.qw] /= l;
}
// out = mix(a, b, t) (quaternions by nlerp on the short arc).
function mixParams(out, a, b, t) {
  const d = a[P.qx] * b[P.qx] + a[P.qy] * b[P.qy] + a[P.qz] * b[P.qz] + a[P.qw] * b[P.qw];
  const s = d < 0 ? -1 : 1;
  for (let j = 0; j < NP; j++) {
    const bj = j >= P.qx && j <= P.qw ? b[j] * s : b[j];
    out[j] = a[j] + (bj - a[j]) * t;
  }
  normQ(out);
}

// ------------------------------------------------------------------ the animator
// const anim = new SwingAnimator(look, {club, handed, shot});
//   anim.place({ball, aimYaw, terrain | ground, handed?, club?, shot?})  fit the golfer to the ball
//   anim.setClub(club), anim.setShot(id), anim.setLook(look)              re-place with the same ball
//   anim.setBackswing(power)            live backswing (0..1.1); the club follows smoothly
//   anim.strike({power, kind, shot, style, onImpact}) -> seconds to impact; onImpact fires once at
//                                       the impact frame (the frame shows the exact impact pose)
//   anim.cancel()                       ease back to address
//   anim.reset()                        snap to address
//   anim.update(dt) -> Float32Array     skin matrices (BONE_COUNT mat4); no allocation per frame
//   anim.state                          'address' | 'backswing' | 'auto' | 'downswing' | 'follow' | 'finish' | 'cancel'
//   anim.clubHeadWorld(out?)            the club's impact point in world (the ball at impact)
//   anim.jointWorld(bone, out?)         a bone origin in world
//   anim.pose                           {root: [x,y,z], quats: Float64Array(BONE_COUNT*4)} local rotations
//   anim.impactTime                     seconds from the strike to impact (set by strike)
export class SwingAnimator {
  constructor(look, opts = {}) {
    this.look = normalizeLook(look);
    this.club = opts.club || '7i';
    this.handed = opts.handed === 'L' ? 'L' : 'R';
    this.shot = opts.shot || 'normal';
    this.style = opts.style || this.look.swing;
    this.bones = new Float32Array(BONE_COUNT * 16);
    this.prm = new Float64Array(NP);
    this._a = new Float64Array(NP);
    this._b = new Float64Array(NP);
    this._c = new Float64Array(NP);
    this._snap = new Float64Array(NP);
    this._v = new Float64Array(3);
    this._v4 = new Float64Array(4);
    this._dw = new Float64Array(45);
    this._hinge = 1.5;
    this._hinge = 1;
    this._variant = 'normal';
    this._follow = null;
    this._tBack = 0.5;
    this._tDown = 0.5;
    this._tFollow = 0.5;
    this._fMax = 0.5;
    this._uFrom = 0.5;
    this.rig = null;
    this.state = 'address';
    this.t = 0.5;
    this.u = 0.5;
    this.uTarget = 0.5;
    this.uTop = 0.5;
    this.power = 0.5;
    this.t = 0;
    this.kind = 'full';
    this.impactTime = 0.5;
    this._tState = 0.5;
    this._onImpact = null;
    this._impacted = false;
    this._idleSeed = 1;
    this._nextIdle = 3.2;
    this._idleKind = 0;
    this._idleT = -1.5;
    this._placeOpts = opts.ball ? opts : null;
    this.place(opts.ball ? opts : { ball: { x: 0, y: 0, z: BALL_R }, aimYaw: Math.PI / 2 });
  }

  place(opts = {}) {
    if (opts.club) this.club = opts.club;
    if (opts.handed) this.handed = opts.handed === 'L' ? 'L' : 'R';
    if (opts.shot) this.shot = opts.shot;
    if (opts.look) this.look = normalizeLook(opts.look);
    this._placeOpts = { ...this._placeOpts, ...opts };
    const o = this._placeOpts;
    this.rig = placeGolfer({ ball: o.ball, aimYaw: o.aimYaw, terrain: o.terrain, ground: o.ground, handed: this.handed, look: this.look, club: this.club, shot: this.shot });
    this.kind = this.rig.keys.putt ? 'putt' : 'full';
    this.reset();
    return this;
  }
  setClub(club) {
    this.club = club;
    return this.place({});
  }
  setShot(shot) {
    this.shot = shot || 'normal';
    return this.place({});
  }
  setLook(look) {
    this.look = normalizeLook(look);
    this.style = this.look.swing;
    return this.place({});
  }
  reset() {
    this.state = 'address';
    this.u = 0;
    this.uTarget = 0;
    this._tState = 0;
    this._impacted = false;
    this._onImpact = null;
    this._idleT = -1;
    this.prm.set(this.rig.keys.P1);
    this._apply();
  }

  // Live backswing from the swing gesture: power 0..1.1.
  setBackswing(power) {
    if (this.state !== 'address' && this.state !== 'backswing') return;
    const p = clamp(+power || 0, 0, 1.1);
    this.power = p;
    this.uTarget = this.kind === 'putt' ? puttRock(p) : backU(p, this.style);
    if (p > 0.001 && this.state === 'address') {
      this.state = 'backswing';
      this._idleT = -1;
    }
  }

  strike({ power = 1, kind, shot, style, onImpact } = {}) {
    if (shot && shot !== this.shot) this.setShot(shot);
    if (style) this.style = style;
    if (kind) this.kind = kind === 'putt' || this.rig.keys.putt ? 'putt' : 'full';
    const p = clamp(+power || 0, 0, 1.1);
    this.power = p;
    const tm = swingTiming(this.style, p, this.kind);
    let uTop = this.kind === 'putt' ? puttRock(p) : backU(p, this.style);
    if (this.shot === 'punch' || this.shot === 'stinger') uTop *= 0.82;
    this._onImpact = typeof onImpact === 'function' ? onImpact : null;
    this._impacted = false;
    this._tDown = tm.down;
    this._tFollow = tm.follow;
    this._fMax = this._followLength(p);
    this._variant = this._followVariant();
    this._follow = this.rig.keys.putt ? null : followKeys(this.rig, this._variant);
    this._hinge = this.shot === 'bump' ? 0.3 : 1;
    // Without a live backswing (tap meter, bot), swing back automatically first.
    const live = this.state === 'backswing' && this.u >= uTop * 0.6;
    if (live) {
      this.uTop = Math.max(this.u, 0.05);
      this.state = 'downswing';
      this._tState = 0;
      this.impactTime = this._tDown;
    } else {
      this._uFrom = this.u;
      this.uTop = Math.max(uTop, 0.05);
      this._tBack = tm.back;
      this.state = 'auto';
      this._tState = 0;
      this.impactTime = this._tBack + this._tDown;
    }
    return this.impactTime;
  }

  cancel() {
    if (this.state === 'address') return;
    this._snap.set(this.prm);
    this.state = 'cancel';
    this._tState = 0;
    this.uTarget = 0;
    this.u = 0;
    this._onImpact = null;
  }

  _followLength(p) {
    if (this.kind === 'putt') return 1;
    const sh = this.shot;
    if (sh === 'bump') return 0.75 + 0.6 * p;
    if (sh === 'punch' || sh === 'stinger') return 2.6;
    // Partial swings finish lower.
    return clamp(1.2 + 1.9 * Math.min(1, p / 0.8), 1.2, 3);
  }
  _followVariant() {
    const sh = this.shot;
    if (sh === 'punch' || sh === 'stinger' || sh === 'bump') return 'low';
    if (sh === 'flop') return 'flop';
    if (sh === 'draw') return 'draw';
    if (sh === 'cut') return 'cut';
    if (this.style === 'bigfinish') return 'bigfinish';
    return 'normal';
  }

  get pose() {
    // Local rotations from the world ones (setup-time helper; allocates).
    const R = this.rig.s.R;
    const q = new Float64Array(BONE_COUNT * 4);
    const m = new Float64Array(9);
    for (let b = 0; b < BONE_COUNT; b++) {
      const p = BONE_PARENT[b];
      if (p < 0) m3copy(m, 0, R, b * 9);
      else m3tmul(m, 0, R, p * 9, R, b * 9);
      quatFromM3(q, b * 4, m, 0);
    }
    const X = this.rig.s.X;
    return { root: [X[0], X[1], X[2]], quats: q, world: Array.from(this.rig.W) };
  }

  clubHeadWorld(out = { x: 0, y: 0, z: 0 }) {
    const S = this.rig.s;
    const v = this._v;
    const im = this.rig.spec.impact;
    m3v(v, 0, S.R, B.club * 9, im[0], im[1], im[2]);
    const x = S.X[B.club * 3] + v[0];
    const y = S.X[B.club * 3 + 1] + v[1];
    const z = S.X[B.club * 3 + 2] + v[2];
    fromG(this.rig, x, y, z, v, 0);
    out.x = v[0];
    out.y = v[1];
    out.z = v[2];
    return out;
  }

  jointWorld(bone, out = { x: 0, y: 0, z: 0 }) {
    const X = this.rig.s.X;
    const v = this._v;
    fromG(this.rig, X[bone * 3], X[bone * 3 + 1], X[bone * 3 + 2], v, 0);
    out.x = v[0];
    out.y = v[1];
    out.z = v[2];
    return out;
  }

  // A point given in a bone's rest (bind) space, in world.
  restPointWorld(bone, p, out = { x: 0, y: 0, z: 0 }) {
    const o = bone * 16;
    const M = this.bones;
    out.x = M[o] * p[0] + M[o + 4] * p[1] + M[o + 8] * p[2] + M[o + 12];
    out.y = M[o + 1] * p[0] + M[o + 5] * p[1] + M[o + 9] * p[2] + M[o + 13];
    out.z = M[o + 2] * p[0] + M[o + 6] * p[1] + M[o + 10] * p[2] + M[o + 14];
    return out;
  }

  // Heel and toe sole points of both feet in world (tests).
  footPoints() {
    const D = this.rig.dims;
    const J = D.joints;
    const res = [];
    for (const fb of [B.footL, B.footR]) {
      const a = [J[fb * 3], J[fb * 3 + 1], J[fb * 3 + 2]];
      res.push(this.restPointWorld(fb, [a[0] - D.foot.heel, a[1], 0]), this.restPointWorld(fb, [a[0] + D.foot.toe, a[1], 0]));
    }
    return res;
  }

  // Evaluate a named pose immediately (previews and tests): 'address' | 'P2' | 'half' (P3) | 'top'
  // (P4, at this power) | 'P5' | 'P6' | 'impact' (P7) | 'P8' | 'P9' | 'finish' (P10). Putts map the
  // names onto the stroke: back halfway (P2, P3), top, coming down (P5, P6), impact, through (P8,
  // P9), finish.
  showPose(name, power = 1) {
    const k = this.rig.keys;
    const out = this.prm;
    if (k.putt) {
      const top = puttRock(power);
      const back = { P2: 0.5, half: 0.8, P3: 0.8, top: 1, P4: 1, P5: 0.6, P6: 0.25 }[name];
      const thru = { P8: 0.45, P9: 0.8, finish: 1.15, P10: 1.15 }[name];
      if (back != null) {
        if (name === 'P5' || name === 'P6') mixParams(out, k.P1, k.P7, name === 'P6' ? 0.7 : 0.3);
        else out.set(k.P1);
        out[P.rock] = top * back;
      } else if (thru != null) {
        out.set(k.P7);
        out[P.rock] = -top * thru;
      } else if (name === 'impact' || name === 'P7') out.set(k.P7);
      else out.set(k.P1);
    } else if (name === 'address' || name === 'P1') out.set(k.P1);
    else if (name === 'impact' || name === 'P7') out.set(k.P7);
    else if (name === 'top' || name === 'P4') splineKeys(k.back, backU(power, this.style), out);
    else if (name === 'P2') out.set(k.back[1]);
    else if (name === 'P3' || name === 'half') out.set(k.back[2]);
    else if (name === 'P5') out.set(k.down[2]);
    else if (name === 'P6') out.set(k.down[1]);
    else if (name === 'P8') out.set(followKeys(this.rig, this._followVariant())[1]);
    else if (name === 'P9') out.set(followKeys(this.rig, this._followVariant())[2]);
    else if (name === 'finish' || name === 'P10') out.set(followKeys(this.rig, this._followVariant())[3]);
    this._apply();
    return this.bones;
  }

  update(dt) {
    dt = clamp(+dt || 0, 0, 0.1);
    this.t += dt;
    this._tState += dt;
    const k = this.rig.keys;
    const out = this.prm;
    switch (this.state) {
      case 'address':
        out.set(k.P1);
        this._idle(dt, out);
        break;
      case 'backswing': {
        // Follow the finger smoothly (critically damped-ish).
        const a = 1 - Math.exp(-14 * dt);
        this.u += (this.uTarget - this.u) * a;
        this._backAt(this.u, out);
        if (this.uTarget <= 0 && this.u < 0.01) {
          this.state = 'address';
          this.u = 0;
        }
        break;
      }
      case 'auto': {
        const x = clamp(this._tState / this._tBack, 0, 1);
        // Smooth start, slowing into the top.
        const e = x * x * (3 - 2 * x);
        this.u = this._uFrom + (this.uTop - this._uFrom) * e;
        this._backAt(this.u, out);
        if (x >= 1) {
          this.state = 'downswing';
          this._tState -= this._tBack;
        }
        break;
      }
      case 'downswing': {
        const d = clamp(this._tState / this._tDown, 0, 1);
        this._downAt(d, out);
        if (d >= 1) {
          this.state = 'follow';
          this._tState -= this._tDown;
          this.u = 0;
          if (!this._impacted) {
            this._impacted = true;
            // This frame shows the exact impact pose.
            out.set(k.P7);
            this._apply();
            const cb = this._onImpact;
            this._onImpact = null;
            if (cb) cb();
            return this.bones;
          }
        }
        break;
      }
      case 'follow': {
        const x = clamp(this._tState / this._tFollow, 0, 1);
        this._followAt(x, out);
        if (x >= 1) {
          this.state = 'finish';
          this._tState = 0;
        }
        break;
      }
      case 'finish':
        this._followAt(1, out);
        // Settle: a gentle breath in the finish.
        out[P.flex] += 0.008 * Math.sin(this.t * 1.6);
        break;
      case 'cancel': {
        const x = clamp(this._tState / 0.45, 0, 1);
        const e = x * x * (3 - 2 * x);
        mixParams(out, this._snap, k.P1, e);
        if (x >= 1) {
          this.state = 'address';
          this._tState = 0;
        }
        break;
      }
      default:
        out.set(k.P1);
    }
    this._apply();
    return this.bones;
  }

  _apply() {
    evalPose(this.rig, this.prm);
    writeSkin(this.rig, this.bones);
  }

  _backAt(u, out) {
    const k = this.rig.keys;
    if (k.putt) {
      out.set(k.P1);
      out[P.rock] = u;
      return;
    }
    splineKeys(k.back, u, out);
    if (this._hinge < 1 && this.state !== 'backswing') this._deadWrist(out, 1 - this._hinge);
  }

  // Downswing from the reached top: arms and club along the downswing keys, the hips ahead of
  // them, the chest in between; a short transition blends out of the backswing.
  _downAt(d, out) {
    const k = this.rig.keys;
    const uTop = this.uTop;
    if (k.putt) {
      // Pendulum: slow start, fastest at impact; the stroke ends on the solved impact pose.
      mixParams(out, k.P1, k.P7, smooth(0.4, 1, d));
      out[P.rock] = uTop * Math.cos((Math.PI / 2) * d);
      return;
    }
    const ea = Math.pow(d, 1.9); // arms and club
    const ec = Math.pow(d, 1.45); // chest
    const eh = 1 - Math.pow(1 - d, 1.5); // hips lead
    const amp = smooth(0, 0.28, d);
    // Arms/club.
    const ua = uTop * (1 - ea);
    splineKeys(k.back, ua, this._a);
    splineKeys(k.down, ua, this._b);
    mixParams(out, this._a, this._b, amp);
    // Chest timing.
    const uc = uTop * (1 - ec);
    splineKeys(k.back, uc, this._a);
    splineKeys(k.down, uc, this._b);
    mixParams(this._c, this._a, this._b, amp);
    for (let i = 0; i < CHEST_PARAMS.length; i++) out[CHEST_PARAMS[i]] = this._c[CHEST_PARAMS[i]];
    // Hips.
    const uh = uTop * (1 - eh);
    splineKeys(k.back, uh, this._a);
    splineKeys(k.down, uh, this._b);
    mixParams(this._c, this._a, this._b, Math.max(amp, smooth(0, 0.15, d)));
    for (let i = 0; i < HIP_PARAMS.length; i++) out[HIP_PARAMS[i]] = this._c[HIP_PARAMS[i]];
    if (this._hinge < 1) this._deadWrist(out, (1 - this._hinge) * (1 - smooth(0.85, 1, d)));
    if (d >= 1) out.set(k.P7);
  }

  _followAt(x, out) {
    const k = this.rig.keys;
    if (k.putt) {
      out.set(k.P7);
      const e = Math.sin((Math.PI / 2) * x);
      out[P.rock] = -this.uTop * 1.15 * e;
      out[P.look] = 0.0;
      return;
    }
    // Fast out of impact, decelerating into the finish.
    const e = 1 - Math.pow(1 - x, 2.4);
    const keys = this._follow || followKeys(this.rig, 'normal');
    splineKeys(keys, this._fMax * e, out);
    if (this._hinge < 1) this._deadWrist(out, 1 - this._hinge);
  }

  // Blend the club toward a "dead wrist" orientation that turns rigidly with the lead arm from
  // the address (chips: little hinge, no release).
  _deadWrist(out, amt) {
    if (amt <= 0) return;
    const rig = this.rig;
    const k = rig.keys;
    const m = this._dw;
    // Arm frame now and at address (chest rotation x swing rotation).
    armFrame(rig, out, m, 0);
    armFrame(rig, k.P1, m, 9);
    m3FromQuat(m, 18, k.P1, P.qx);
    m3tmul(m, 27, m, 9, m, 18); // address club relative to the address arm frame
    m3mul(m, 36, m, 0, m, 27);
    const q = this._v4;
    quatFromM3(q, 0, m, 36);
    const d = q[0] * out[P.qx] + q[1] * out[P.qy] + q[2] * out[P.qz] + q[3] * out[P.qw];
    const s = d < 0 ? -1 : 1;
    for (let j = 0; j < 4; j++) out[P.qx + j] += (q[j] * s - out[P.qx + j]) * amt;
    normQ(out);
  }

  _idle(dt, out) {
    // Breathing.
    out[P.flex] += 0.006 * Math.sin(this.t * 1.5);
    out[P.chest] += 0.004 * Math.sin(this.t * 0.7);
    const k = this.rig.keys;
    if (this._idleT < 0) {
      if (this._tState > this._nextIdle) {
        this._idleT = 0;
        // Deterministic alternation: waggle, look at the target, waggle...
        this._idleKind = (this._idleKind + 1) % 3;
        this._idleSeed = (this._idleSeed * 1103515245 + 12345) >>> 0;
        this._nextIdle = 4 + (this._idleSeed % 1000) / 400;
      }
      return;
    }
    this._idleT += dt;
    const T = this._idleKind === 1 ? 1.6 : 1.1;
    const x = this._idleT / T;
    if (x >= 1) {
      this._idleT = -1;
      this._tState = 0;
      return;
    }
    const w = Math.sin(Math.PI * x);
    if (this._idleKind === 1 || k.putt) {
      out[P.look] = 0.85 * smooth(0, 0.25, x) * smooth(1, 0.7, x);
    } else {
      // Waggle: a little takeaway and back, twice as fast at the hands.
      splineKeys(k.back, 0.32 * w * w, this._a);
      for (let j = P.e; j <= P.qw; j++) out[j] = this._a[j];
      normQ(out);
    }
  }
}

function puttRock(p) {
  return 0.025 + 0.3 * clamp(p, 0, 1.1);
}

// Lead-arm frame (chest rotation x Rz(phi) x Ry(-e)) for prm into m[mo..mo+8].
const AF = new Float64Array(18);
function armFrame(rig, prm, m, mo) {
  torsoFK(rig, prm);
  const R = rig.s.R;
  m3axisA(AF, 0, 0, 0, 1, prm, P.phi, 1);
  m3axisA(AF, 9, 0, 1, 0, prm, P.e, -1);
  m3mul(AF, 0, AF, 0, AF, 9);
  m3mul(m, mo, R, BR(B.chest), AF, 0);
}
