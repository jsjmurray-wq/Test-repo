// Spectator geometry (docs/architecture.md section 10). Pure: typed arrays out, no DOM, no GL.
//
// personMesh() is ONE low-poly spectator (180 triangles) in a rest pose, drawn instanced by the
// crowd program (shaders-crowd.js): 1.75 m tall, standing on z = 0, facing +x with +y on the left,
// arms hanging. Every vertex carries {part, colour slot, aux, ao} in `attr`; the vertex shader
// poses the parts (vertex groups) per instance and per frame:
//   part  PELVIS, TORSO (pivot WAIST), HEAD (pivot NECK), upper arm and forearm (+ hand) on each
//         side (pivots SHOULDER, ELBOW), thigh and shin (+ foot) on each side (pivots HIP, KNEE),
//         HAT (follows the head; the shader shapes it per hat kind) and PARASOL (held over the
//         right shoulder; follows the torso).
//   slot  SKIN, SHIRT, LEGS, SHOES, HAT, HAIR, CANOPY, STICK, SLEEVE (shirt or bare forearm),
//         SHIN (trousers or bare shin): colours come from the instance.
//   aux   hat: ring 0 top .. 3 brim edge; elsewhere 0.
//   ao    baked occlusion (0 dark .. 1 open).
// Budget: torso 30, legs 2 x 19, arms 2 x 19, head 36, hat 30, parasol 8 = 180 triangles.
//
// posePerson(pose, part, p, out) is the shader's skeleton in JS (the same joints, rotations and
// order), used by the tests to check where the hands land in each reaction pose.
//
// furnitureMesh(layout) builds the gallery furniture for one hole as ONE static mesh in world
// coordinates: rope stakes, sagging ropes and the grandstand (tiers, benches, side and back
// panels, front hoarding). {pos, nrm, col (rgb + thin radius: ropes and stakes widen to a minimum
// on-screen width in the shader and dissolve with distance), idx (Uint16), tris}.

// ------------------------------------------------------------------ skeleton (1.75 m figure)
export const PERSON_H = 1.75;
export const PJ = Object.freeze({
  ANKLE_Z: 0.075,
  KNEE_Z: 0.49,
  HIP_Z: 0.91,
  HIP_Y: 0.092,
  WAIST_Z: 1.02,
  SHOULDER_Z: 1.415,
  SHOULDER_Y: 0.178,
  ELBOW_Z: 1.12,
  WRIST_Z: 0.865,
  NECK_Z: 1.49,
  HEAD_Z: 1.615,
});

export const PART = Object.freeze({
  PELVIS: 0, TORSO: 1, HEAD: 2, UARM_L: 3, FARM_L: 4, UARM_R: 5, FARM_R: 6,
  THIGH_L: 7, SHIN_L: 8, THIGH_R: 9, SHIN_R: 10, HAT: 11, PARASOL: 12,
});
export const SLOT = Object.freeze({
  SKIN: 0, SHIRT: 1, LEGS: 2, SHOES: 3, HAT: 4, HAIR: 5, CANOPY: 6, STICK: 7, SLEEVE: 8, SHIN: 9,
});

// Where the parasol is held (torso frame): stick from the hand up to the canopy.
// The stick runs from the right hand (x, y, z0) up and in to the canopy's apex over the head (cx, cy, z1).
export const PARASOL = Object.freeze({ x: 0.25, y: -0.19, z0: 1.2, cx: 0.07, cy: -0.07, z1: 2.08, r: 0.6, drop: 0.2 });

function builder() {
  const p = [];
  const n = [];
  const a = [];
  const i = [];
  return {
    p, n, a, i,
    v(x, y, z, nx, ny, nz, part, slot, aux = 0, ao = 1) {
      p.push(x, y, z);
      const l = Math.hypot(nx, ny, nz) || 1;
      n.push(nx / l, ny / l, nz / l);
      a.push(part, slot, aux, ao);
      return p.length / 3 - 1;
    },
    // Quad strip between two rings of equal length (closed loop).
    band(r0, r1) {
      const m = r0.length;
      for (let k = 0; k < m; k++) {
        const k1 = (k + 1) % m;
        i.push(r0[k], r0[k1], r1[k1], r0[k], r1[k1], r1[k]);
      }
    },
    fan(c, ring, up) {
      const m = ring.length;
      for (let k = 0; k < m; k++) {
        const k1 = (k + 1) % m;
        if (up) i.push(c, ring[k], ring[k1]);
        else i.push(c, ring[k1], ring[k]);
      }
    },
  };
}

// A ring of m vertices round (cx, cy, z): half-depth hx (along x), half-width hy (along y).
function ring(B, cx, cy, z, hx, hy, m, part, slot, ao = 1, nz = 0, rot = 0) {
  const out = [];
  for (let k = 0; k < m; k++) {
    const ang = rot + (k / m) * Math.PI * 2;
    const c = Math.cos(ang);
    const s = Math.sin(ang);
    out.push(B.v(cx + c * hx, cy + s * hy, z, c / Math.max(hx, 1e-3), s / Math.max(hy, 1e-3), nz, part, slot, 0, ao));
  }
  return out;
}

// Limb tube: square section (rotated 45 deg) from z0 (radius r0) down to z1 (radius r1).
function limb(B, y, z0, r0, z1, r1, part, slot, slotLow = slot, ao0 = 0.8, ao1 = 0.9) {
  const top = ring(B, 0, y, z0, r0, r0, 4, part, slot, ao0, 0, Math.PI / 4);
  const bot = ring(B, 0, y, z1, r1, r1, 4, part, slotLow, ao1, 0, Math.PI / 4);
  B.band(bot, top);
  return { top, bot };
}

export function personMesh() {
  const B = builder();
  const J = PJ;
  // ---- torso: hips (pelvis) -> waist -> shoulders, capped up to the neck (30 tris).
  const hips = ring(B, 0, 0, 0.84, 0.11, 0.2, 6, PART.PELVIS, SLOT.SHIRT, 0.75);
  const waist = ring(B, 0, 0, 1.06, 0.1, 0.168, 6, PART.TORSO, SLOT.SHIRT, 0.85);
  const chest = ring(B, 0, 0, 1.44, 0.11, 0.23, 6, PART.TORSO, SLOT.SHIRT, 1);
  B.band(hips, waist);
  B.band(waist, chest);
  const neck = B.v(0, 0, J.NECK_Z + 0.01, 0, 0, 1, PART.TORSO, SLOT.SKIN, 0, 0.9);
  B.fan(neck, chest, true);

  // ---- legs (2 x 19): thigh, shin (bare below shorts), shoe.
  for (const side of [1, -1]) {
    const y = side * J.HIP_Y;
    const thigh = side > 0 ? PART.THIGH_L : PART.THIGH_R;
    const shin = side > 0 ? PART.SHIN_L : PART.SHIN_R;
    limb(B, y, 0.96, 0.098, J.KNEE_Z - 0.02, 0.07, thigh, SLOT.LEGS, SLOT.LEGS, 0.7, 0.85);
    limb(B, y, J.KNEE_Z + 0.03, 0.068, J.ANKLE_Z, 0.05, shin, SLOT.SHIN, SLOT.SHIN, 0.85, 0.8);
    // Shoe: a wedge from the heel to the toe (3 visible faces).
    const hl = B.v(-0.05, y + 0.045, 0.0, -0.6, 0.6, 0.2, shin, SLOT.SHOES, 0, 0.7);
    const hr = B.v(-0.05, y - 0.045, 0.0, -0.6, -0.6, 0.2, shin, SLOT.SHOES, 0, 0.7);
    const toe = B.v(0.2, y, 0.0, 1, 0, 0.3, shin, SLOT.SHOES, 0, 0.8);
    const top = B.v(-0.01, y, 0.1, 0, 0, 1, shin, SLOT.SHOES, 0, 0.9);
    B.i.push(hl, toe, top, hr, top, toe, hl, top, hr);
  }

  // ---- arms (2 x 19): upper arm, forearm (sleeve or bare), hand.
  for (const side of [1, -1]) {
    const y = side * J.SHOULDER_Y;
    const ua = side > 0 ? PART.UARM_L : PART.UARM_R;
    const fa = side > 0 ? PART.FARM_L : PART.FARM_R;
    limb(B, y, J.SHOULDER_Z + 0.035, 0.066, J.ELBOW_Z - 0.01, 0.052, ua, SLOT.SHIRT, SLOT.SHIRT, 0.9, 0.75);
    limb(B, y, J.ELBOW_Z + 0.025, 0.05, J.WRIST_Z, 0.038, fa, SLOT.SLEEVE, SLOT.SLEEVE, 0.8, 0.85);
    // Hand: a flat tetrahedron below the wrist.
    const w0 = B.v(0.04, y, J.WRIST_Z + 0.01, 1, 0, 0, fa, SLOT.SKIN, 0, 0.85);
    const w1 = B.v(-0.03, y + 0.032 * side, J.WRIST_Z + 0.01, -0.6, side * 0.8, 0, fa, SLOT.SKIN, 0, 0.8);
    const w2 = B.v(-0.03, y - 0.032 * side, J.WRIST_Z + 0.01, -0.6, -side * 0.8, 0, fa, SLOT.SKIN, 0, 0.8);
    const tip = B.v(0.01, y, J.WRIST_Z - 0.085, 0, 0, -1, fa, SLOT.SKIN, 0, 0.9);
    B.i.push(w0, w1, tip, w1, w2, tip, w2, w0, tip);
  }

  // ---- head (36): a six-sided lathe, hair on the crown and the back.
  {
    const c = J.HEAD_Z;
    const top = B.v(0, 0, c + 0.13, 0, 0, 1, PART.HEAD, SLOT.HAIR, 0, 1);
    const rA = [];
    const rB = [];
    const rC = [];
    for (let k = 0; k < 6; k++) {
      const ang = (k / 6) * Math.PI * 2;
      const cs = Math.cos(ang);
      const sn = Math.sin(ang);
      rA.push(B.v(cs * 0.072, sn * 0.064, c + 0.095, cs * 0.6, sn * 0.6, 0.8, PART.HEAD, SLOT.HAIR, 0, 1));
      // Widest ring: the face in front, hair behind.
      rB.push(B.v(cs * 0.104, sn * 0.088, c + 0.01, cs, sn, 0.1, PART.HEAD, cs > -0.2 ? SLOT.SKIN : SLOT.HAIR, 0, 1));
      rC.push(B.v(cs * 0.072 + 0.012, sn * 0.06, c - 0.085, cs, sn, -0.5, PART.HEAD, SLOT.SKIN, 0, 0.85));
    }
    const chin = B.v(0.02, 0, c - 0.125, 0.3, 0, -1, PART.HEAD, SLOT.SKIN, 0, 0.7);
    B.fan(top, rA, true);
    B.band(rB, rA);
    B.band(rC, rB);
    B.fan(chin, rC, false);
  }

  // ---- hat (30): a unit lathe the shader shapes per kind (cap, bucket, sun hat, flat cap,
  // beanie); x, y = direction round the crown, aux = ring (0 top, 1 crown shoulder, 2 crown base,
  // 3 brim edge).
  {
    const top = B.v(0, 0, 1, 0, 0, 1, PART.HAT, SLOT.HAT, 0, 1);
    const r1 = [];
    const r2 = [];
    const r3 = [];
    for (let k = 0; k < 6; k++) {
      const ang = (k / 6) * Math.PI * 2;
      const cs = Math.cos(ang);
      const sn = Math.sin(ang);
      r1.push(B.v(cs, sn, 1, cs * 0.6, sn * 0.6, 0.8, PART.HAT, SLOT.HAT, 1, 1));
      r2.push(B.v(cs, sn, 0, cs, sn, 0.2, PART.HAT, SLOT.HAT, 2, 0.85));
      r3.push(B.v(cs, sn, 0, cs * 0.15, sn * 0.15, 1, PART.HAT, SLOT.HAT, 3, 0.9));
    }
    B.fan(top, r1, true);
    B.band(r2, r1);
    B.band(r3, r2);
  }

  // ---- parasol (8): a six-panel canopy on a stick, held over the right shoulder.
  {
    const P = PARASOL;
    const apex = B.v(P.cx, P.cy, P.z1, 0, 0, 1, PART.PARASOL, SLOT.CANOPY, 0, 1);
    const rim = [];
    for (let k = 0; k < 6; k++) {
      const ang = (k / 6) * Math.PI * 2;
      const cs = Math.cos(ang);
      const sn = Math.sin(ang);
      rim.push(B.v(P.cx + cs * P.r, P.cy + sn * P.r, P.z1 - P.drop, cs * 0.35, sn * 0.35, 1, PART.PARASOL, SLOT.CANOPY, 0, 0.9));
    }
    B.fan(apex, rim, true);
    const s0 = B.v(P.x - 0.012, P.y, P.z0, 0, 1, 0, PART.PARASOL, SLOT.STICK, 0, 0.8);
    const s1 = B.v(P.x + 0.012, P.y, P.z0, 0, 1, 0, PART.PARASOL, SLOT.STICK, 0, 0.8);
    const s2 = B.v(P.cx + 0.012, P.cy, P.z1, 0, 1, 0, PART.PARASOL, SLOT.STICK, 0, 0.8);
    const s3 = B.v(P.cx - 0.012, P.cy, P.z1, 0, 1, 0, PART.PARASOL, SLOT.STICK, 0, 0.8);
    B.i.push(s0, s1, s2, s0, s2, s3);
  }

  return {
    pos: new Float32Array(B.p),
    nrm: new Float32Array(B.n),
    attr: new Float32Array(B.a),
    idx: new Uint16Array(B.i),
    tris: B.i.length / 3,
    verts: B.p.length / 3,
  };
}

// ------------------------------------------------------------------ the skeleton in JS
// pose = {aL, phiL, bL, twL, aR, phiR, bR, twR (shoulder forward raise, abduction, elbow flex,
//         upper-arm twist that swings the forearm inward; rad),
//         tPitch, tRoll, tYaw (torso about the waist), hYaw, hPitch (head; + = left / up),
//         hipShift (m, + = left), sit (0 | 1), wid (shoulder/hip width factor, 1)}
// part: a PART id; p: rest point [x, y, z] of a 1.75 m figure. Writes the posed point (1.75 m
// figure, person frame: +x facing, z up from the feet) to out and returns it. The crowd vertex
// shader does exactly this (CROWD_VS).
function rX(a, v) {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [v[0], c * v[1] - s * v[2], s * v[1] + c * v[2]];
}
function rY(a, v) {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [c * v[0] + s * v[2], v[1], -s * v[0] + c * v[2]];
}
function rZ(a, v) {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [c * v[0] - s * v[1], s * v[0] + c * v[1], v[2]];
}
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

export function posePerson(pose, part, p, out = [0, 0, 0]) {
  const J = PJ;
  const wid = pose.wid || 1;
  const sit = pose.sit ? 1 : 0;
  let q = [p[0], p[1] * (part === PART.HEAD || part === PART.HAT || part === PART.PARASOL ? 1 : wid), p[2]];
  const legs = part >= PART.THIGH_L && part <= PART.SHIN_R;
  if (legs) {
    const side = part <= PART.SHIN_L ? 1 : -1;
    const hip = [0, side * J.HIP_Y * wid, J.HIP_Z];
    const knee = [0, side * J.HIP_Y * wid, J.KNEE_Z];
    if (sit) {
      if (part === PART.THIGH_L || part === PART.THIGH_R) q = add(hip, rY(-Math.PI / 2, sub(q, hip)));
      else q = add(q, sub(add(hip, rY(-Math.PI / 2, sub(knee, hip))), knee));
    } else {
      const k = Math.min(1, Math.max(0, (q[2] - J.ANKLE_Z) / (J.HIP_Z - J.ANKLE_Z)));
      q[1] += (pose.hipShift || 0) * k;
    }
  } else if (part === PART.PELVIS) {
    q[1] += sit ? 0 : pose.hipShift || 0;
  } else {
    if (part >= PART.UARM_L && part <= PART.FARM_R) {
      const left = part <= PART.FARM_L;
      const side = left ? 1 : -1;
      const a = left ? pose.aL : pose.aR;
      const phi = left ? pose.phiL : pose.phiR;
      const b = left ? pose.bL : pose.bR;
      const tw = (left ? pose.twL : pose.twR) || 0;
      const sh = [0, side * J.SHOULDER_Y * wid, J.SHOULDER_Z];
      const el = [0, side * J.SHOULDER_Y * wid, J.ELBOW_Z];
      const rot = (v) => rX(side * (phi || 0), rY(-(a || 0), v));
      if (part === PART.UARM_L || part === PART.UARM_R) q = add(sh, rot(sub(q, sh)));
      else q = add(sh, rot(add(sub(el, sh), rZ(-side * tw, rY(-(b || 0), sub(q, el))))));
    } else if (part === PART.HEAD || part === PART.HAT) {
      const nk = [0, 0, J.NECK_Z];
      q = add(nk, rZ(pose.hYaw || 0, rY(-(pose.hPitch || 0), sub(q, nk))));
    }
    const w = [0, 0, J.WAIST_Z];
    q = add(w, rZ(pose.tYaw || 0, rX(pose.tRoll || 0, rY(pose.tPitch || 0, sub(q, w)))));
    q[1] += sit ? 0 : pose.hipShift || 0;
  }
  if (sit) q[2] -= J.HIP_Z - J.KNEE_Z;
  out[0] = q[0];
  out[1] = q[1];
  out[2] = q[2];
  return out;
}

// Arm poses [a, phi, b, twist] (fitted with posePerson to where the hands should be; the shader
// uses the same numbers, injected by shaders-crowd.js). idle: hanging; folded: arms crossed;
// clasp: hands together in front; holding: a hand up (programme, phone, drink); clap: between
// open and shut at 2.5-3 Hz, the hands meeting in front of the chest; cheer: both arms high in a
// V; ooh: hands on the head; mouth: hands to the face; groan: slumped, arms hanging forward;
// parasol: the right hand on the stick.
export const POSES = Object.freeze({
  idle: [0, 0.09, 0.21, 0.07],
  folded: [0.3, -0.05, 1.53, 1.12],
  clasp: [0.15, 0.06, 1.02, 0.86],
  holding: [0.22, 0.1, 1.9, 0.38],
  clapOpen: [0.59, 0.28, 1.86, 0.19],
  clapShut: [0.65, 0.12, 1.73, 0.6],
  cheer: [2.99, -0.35, 0.03, 0.01],
  ooh: [2.72, -0.66, 1.96, 1.2],
  mouth: [1.11, -0.08, 2.32, 0.65],
  groan: [0.01, 0.1, 0.54, 0.19],
  parasol: [0.1, 0.13, 2.0, 0.04],
});
// Where each pose puts the left wrist (person frame, 1.75 m figure), for the tests.
export const POSE_WRIST = Object.freeze({
  idle: [0.05, 0.22, 0.87], folded: [0.2, -0.1, 1.17], clasp: [0.2, 0.03, 1.0], holding: [0.27, 0.1, 1.25],
  clapShut: [0.33, 0.03, 1.33], cheer: [0.08, 0.38, 1.97], ooh: [0.0, 0.11, 1.73], mouth: [0.15, 0.04, 1.56],
  groan: [0.12, 0.2, 0.92], parasol: [0.25, 0.19, 1.25],
});

// ------------------------------------------------------------------ gallery furniture
// Colours (sRGB) per theme: stakes and rope, grandstand panels.
export const FURNITURE_COLORS = Object.freeze({
  parkland: { stake: [0.92, 0.92, 0.88], rope: [0.94, 0.92, 0.84], board: [0.12, 0.27, 0.18], trim: [0.86, 0.8, 0.55], deck: [0.55, 0.56, 0.55], seat: [0.16, 0.36, 0.24], frame: [0.42, 0.44, 0.45] },
  desert: { stake: [0.74, 0.6, 0.42], rope: [0.95, 0.84, 0.36], board: [0.48, 0.24, 0.16], trim: [0.93, 0.86, 0.7], deck: [0.62, 0.58, 0.52], seat: [0.73, 0.4, 0.24], frame: [0.5, 0.45, 0.4] },
  tropical: { stake: [0.95, 0.95, 0.93], rope: [0.97, 0.96, 0.92], board: [0.06, 0.36, 0.42], trim: [0.98, 0.96, 0.9], deck: [0.62, 0.62, 0.6], seat: [0.92, 0.92, 0.88], frame: [0.55, 0.57, 0.58] },
  links: { stake: [0.56, 0.44, 0.3], rope: [0.92, 0.9, 0.82], board: [0.13, 0.2, 0.33], trim: [0.92, 0.86, 0.48], deck: [0.5, 0.5, 0.5], seat: [0.85, 0.82, 0.32], frame: [0.4, 0.42, 0.44] },
});

const STAKE_W = 0.035;
const ROPE_R = 0.011;

class FB {
  constructor() {
    this.p = [];
    this.n = [];
    this.c = [];
    this.i = [];
  }
  v(x, y, z, nx, ny, nz, col, thin = 0) {
    this.p.push(x, y, z);
    const l = Math.hypot(nx, ny, nz) || 1;
    this.n.push(nx / l, ny / l, nz / l);
    this.c.push(col[0], col[1], col[2], thin);
    return this.p.length / 3 - 1;
  }
  // Flat quad a-b-c-d (counter-clockwise seen from the normal's side), one normal.
  quad(a, b, c, d, n, col) {
    const k = [a, b, c, d].map((q) => this.v(q[0], q[1], q[2], n[0], n[1], n[2], col));
    this.i.push(k[0], k[1], k[2], k[0], k[2], k[3]);
  }
  // Axis box in a local frame (origin o, unit axes u (along), w (depth), z up): extents
  // [u0, u1] x [w0, w1] x [z0, z1]; faces listed in `faces` ('top','front','back','left','right').
  box(o, u, w, u0, u1, w0, w1, z0, z1, col, faces = ['top', 'front', 'back', 'left', 'right']) {
    const P = (a, b, z) => [o[0] + u[0] * a + w[0] * b, o[1] + u[1] * a + w[1] * b, o[2] + z];
    for (const f of faces) {
      if (f === 'top') this.quad(P(u0, w0, z1), P(u1, w0, z1), P(u1, w1, z1), P(u0, w1, z1), [0, 0, 1], col);
      if (f === 'front') this.quad(P(u1, w0, z0), P(u1, w0, z1), P(u0, w0, z1), P(u0, w0, z0), [-w[0], -w[1], 0], col);
      if (f === 'back') this.quad(P(u0, w1, z0), P(u0, w1, z1), P(u1, w1, z1), P(u1, w1, z0), [w[0], w[1], 0], col);
      if (f === 'left') this.quad(P(u0, w0, z0), P(u0, w0, z1), P(u0, w1, z1), P(u0, w1, z0), [-u[0], -u[1], 0], col);
      if (f === 'right') this.quad(P(u1, w1, z0), P(u1, w1, z1), P(u1, w0, z1), P(u1, w0, z0), [u[0], u[1], 0], col);
    }
  }
}

// Stake: a thin square post (4 sides + top = 10 triangles), widened on screen far away.
function stake(B, s, col) {
  const h = 0.95;
  const r = STAKE_W / 2;
  const base = B.p.length / 3;
  for (const [dx, dy] of [[1, 1], [-1, 1], [-1, -1], [1, -1]]) {
    B.v(s.x + dx * r, s.y + dy * r, s.z - 0.05, dx, dy, 0, col, r);
    B.v(s.x + dx * r, s.y + dy * r, s.z + h, dx, dy, 0.3, col, r);
  }
  for (let k = 0; k < 4; k++) {
    const a = base + k * 2;
    const b = base + ((k + 1) % 4) * 2;
    B.i.push(a, b, b + 1, a, b + 1, a + 1);
  }
  B.i.push(base + 1, base + 3, base + 5, base + 1, base + 5, base + 7);
}

// Rope between two stakes: a three-sided tube along a sagging curve (4 segments, 24 triangles).
function ropeSpan(B, a, b, col, h, sag) {
  const SEG = 4;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const L = Math.hypot(dx, dy) || 1;
  const ux = dx / L;
  const uy = dy / L;
  // Side vector (horizontal, perpendicular) and up.
  const sx = -uy;
  const sy = ux;
  const rings = [];
  for (let k = 0; k <= SEG; k++) {
    const t = k / SEG;
    const cx = a.x + dx * t;
    const cy = a.y + dy * t;
    const cz = a.z + (b.z - a.z) * t + h - sag * 4 * t * (1 - t);
    const ring = [];
    for (let j = 0; j < 3; j++) {
      const ang = (j / 3) * Math.PI * 2 + Math.PI / 2;
      const ny = Math.cos(ang);
      const nz = Math.sin(ang);
      ring.push(B.v(cx + sx * ny * ROPE_R, cy + sy * ny * ROPE_R, cz + nz * ROPE_R, sx * ny, sy * ny, nz, col, ROPE_R));
    }
    rings.push(ring);
  }
  for (let k = 0; k < SEG; k++) {
    for (let j = 0; j < 3; j++) {
      const j1 = (j + 1) % 3;
      const r0 = rings[k];
      const r1 = rings[k + 1];
      B.i.push(r0[j], r1[j], r1[j1], r0[j], r1[j1], r0[j1]);
    }
  }
}

// The grandstand: stand = {x, y, z (deck height of the front row floor), yaw (facing: the
// direction the seats look), w (width), rows, rowD, rise, ground: [front-left, front-right,
// back-left, back-right ground heights]}. Rows climb away from the field.
function grandstand(B, st, C) {
  const f = [Math.cos(st.yaw), Math.sin(st.yaw)]; // toward the field
  const w = [-f[0], -f[1], 0]; // depth axis: away from the field
  const u = [-f[1], f[0], 0]; // along the stand (its left as seen from the field)
  const o = [st.x, st.y, 0];
  const hw = st.w / 2;
  const D = st.rows * st.rowD;
  const gMin = Math.min(...st.ground) - 0.3;
  const zf = st.z; // front row floor
  const zAt = (k) => zf + k * st.rise; // floor of row k
  const top = zAt(st.rows - 1);
  // Front hoarding: from the ground to 1 m above the first floor, a trim stripe on top.
  B.box(o, u, w, -hw - 0.05, hw + 0.05, -0.12, 0, gMin, zf + 0.85, C.board, ['front', 'top']);
  B.box(o, u, w, -hw - 0.05, hw + 0.05, -0.125, -0.005, zf + 0.85, zf + 0.97, C.trim, ['front', 'top']);
  for (let k = 0; k < st.rows; k++) {
    const d0 = k * st.rowD;
    const d1 = d0 + st.rowD;
    const z = zAt(k);
    // Tread (deck) and the riser below it.
    B.box(o, u, w, -hw, hw, d0, d1, z - 0.06, z, C.deck, k === 0 ? ['top'] : ['top', 'front']);
    if (k > 0) B.box(o, u, w, -hw, hw, d0 - 0.001, d0 + 0.02, zAt(k - 1), z - 0.06, C.frame, ['front']);
    // Bench along the back of the row.
    B.box(o, u, w, -hw + 0.2, hw - 0.2, d1 - 0.42, d1 - 0.12, z + 0.36, z + 0.42, C.seat, ['top', 'front']);
    B.box(o, u, w, -hw + 0.2, hw - 0.2, d1 - 0.42, d1 - 0.12, z, z + 0.36, C.frame, ['front']);
  }
  // Side panels (stepped profile closed down to the ground) and the back wall with a rail.
  const sideZ = top + 1.0;
  for (const s of [-1, 1]) {
    const x = s * (hw + 0.05);
    const n = [u[0] * s, u[1] * s, 0];
    const P = (d, z) => [o[0] + u[0] * x + w[0] * d, o[1] + u[1] * x + w[1] * d, z];
    // Lower panel (ground to each row's floor) per row, then a sloping cheek above.
    for (let k = 0; k < st.rows; k++) {
      const d0 = k * st.rowD;
      const d1 = d0 + st.rowD;
      const z = zAt(k) + 0.42;
      const quad = s > 0 ? [P(d1, gMin), P(d1, z), P(d0, z), P(d0, gMin)] : [P(d0, gMin), P(d0, z), P(d1, z), P(d1, gMin)];
      B.quad(quad[0], quad[1], quad[2], quad[3], n, C.board);
    }
    const tri = s > 0 ? [P(D, zAt(0) + 0.42), P(D, sideZ), P(0, zAt(0) + 0.42)] : [P(0, zAt(0) + 0.42), P(D, sideZ), P(D, zAt(0) + 0.42)];
    const a = B.v(...tri[0], ...n, C.board);
    const b = B.v(...tri[1], ...n, C.board);
    const c = B.v(...tri[2], ...n, C.board);
    B.i.push(a, b, c);
  }
  // Back wall (both faces) and a rail on top.
  B.box(o, u, w, -hw - 0.05, hw + 0.05, D, D + 0.08, gMin, sideZ, C.board, ['front', 'back', 'top']);
  B.box(o, u, w, -hw - 0.05, hw + 0.05, D - 0.02, D + 0.1, sideZ, sideZ + 0.06, C.trim, ['top', 'front', 'back']);
}

export function furnitureMesh(layout, { theme = 'parkland' } = {}) {
  const C = FURNITURE_COLORS[theme] || FURNITURE_COLORS.parkland;
  const B = new FB();
  for (const rope of layout.ropes || []) {
    const pts = rope.pts;
    for (const s of pts) stake(B, s, C.stake);
    for (let k = 0; k + 1 < pts.length; k++) {
      const a = pts[k];
      const b = pts[k + 1];
      const L = Math.hypot(b.x - a.x, b.y - a.y);
      ropeSpan(B, a, b, C.rope, 0.82, Math.min(0.12, 0.012 * L));
    }
  }
  if (layout.stand) grandstand(B, layout.stand, C);
  if (B.p.length / 3 > 65535) throw new Error('crowd furniture: too many vertices');
  return {
    pos: new Float32Array(B.p),
    nrm: new Float32Array(B.n),
    col: new Float32Array(B.c),
    idx: new Uint16Array(B.i),
    tris: B.i.length / 3,
  };
}
