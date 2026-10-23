// Small vector and quaternion helpers. Plain numbers and {x, y} objects; quaternions are
// [w, x, y, z] arrays. Hot loops in physics may inline these instead.

export const len = (x, y) => Math.hypot(x, y);
export const dot = (ax, ay, bx, by) => ax * bx + ay * by;
export const cross = (ax, ay, bx, by) => ax * by - ay * bx;
export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export function normalizeAngle(a) {
  a %= Math.PI * 2;
  if (a > Math.PI) a -= Math.PI * 2;
  if (a < -Math.PI) a += Math.PI * 2;
  return a;
}

// Distance from point p to segment ab, plus the closest point.
export function pointSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = clamp(t, 0, 1);
  const cx = ax + dx * t;
  const cy = ay + dy * t;
  return { d: Math.hypot(px - cx, py - cy), x: cx, y: cy, t };
}

export function quatIdentity() {
  return [1, 0, 0, 0];
}

export function quatMul(a, b) {
  const [aw, ax, ay, az] = a;
  const [bw, bx, by, bz] = b;
  return [
    aw * bw - ax * bx - ay * by - az * bz,
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
  ];
}

export function quatNormalize(q) {
  const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  q[0] /= n;
  q[1] /= n;
  q[2] /= n;
  q[3] /= n;
  return q;
}

// Integrate orientation q by angular velocity w (world frame, rad/s) over dt: q' = dq * q.
export function quatIntegrate(q, wx, wy, wz, dt) {
  const wl = Math.hypot(wx, wy, wz);
  if (wl * dt < 1e-9) return q;
  const half = (wl * dt) / 2;
  const s = Math.sin(half) / wl;
  const dq = [Math.cos(half), wx * s, wy * s, wz * s];
  const r = quatMul(dq, q);
  q[0] = r[0];
  q[1] = r[1];
  q[2] = r[2];
  q[3] = r[3];
  return quatNormalize(q);
}

// Rotate vector v (array [x,y,z]) by the inverse of unit quaternion q (world -> ball-local).
export function quatRotateInv(q, vx, vy, vz, out) {
  const w = q[0];
  const x = -q[1];
  const y = -q[2];
  const z = -q[3];
  // t = 2 * cross(q.xyz, v)
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  out[0] = vx + w * tx + (y * tz - z * ty);
  out[1] = vy + w * ty + (z * tx - x * tz);
  out[2] = vz + w * tz + (x * ty - y * tx);
  return out;
}

// Random-looking but deterministic starting orientation for ball id (so numbers face different ways).
export function quatForBall(id) {
  const a = (id * 2.399963) % (Math.PI * 2);
  const b = ((id * 1.7) % Math.PI) - Math.PI / 2;
  const qz = [Math.cos(a / 2), 0, 0, Math.sin(a / 2)];
  const qx = [Math.cos(b / 2), Math.sin(b / 2), 0, 0];
  return quatNormalize(quatMul(qz, qx));
}
