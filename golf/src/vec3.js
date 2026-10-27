// Small 3D vector helpers. Vectors are plain {x, y, z} objects; hot loops may use the out-param
// variants (or inline the maths) to avoid allocation.

export const v3 = (x = 0, y = 0, z = 0) => ({ x, y, z });
export const copy = (a) => ({ x: a.x, y: a.y, z: a.z });
export const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const scale = (a, s) => ({ x: a.x * s, y: a.y * s, z: a.z * s });
export const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
export const cross = (a, b) => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
export const len = (a) => Math.hypot(a.x, a.y, a.z);
export const len2 = (a) => a.x * a.x + a.y * a.y + a.z * a.z;
export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
export const dist2d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

export function norm(a) {
  const l = Math.hypot(a.x, a.y, a.z);
  return l > 0 ? { x: a.x / l, y: a.y / l, z: a.z / l } : { x: 0, y: 0, z: 0 };
}

export function set(out, x, y, z) {
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}

export function addTo(out, a, s = 1) {
  out.x += a.x * s;
  out.y += a.y * s;
  out.z += a.z * s;
  return out;
}

export function crossTo(out, a, b) {
  const x = a.y * b.z - a.z * b.y;
  const y = a.z * b.x - a.x * b.z;
  const z = a.x * b.y - a.y * b.x;
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const lerp3 = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t });

export function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

// Frame-rate independent exponential approach of cur toward target (lambda in 1/s).
export const damp = (cur, target, lambda, dt) => target + (cur - target) * Math.exp(-lambda * dt);

export function normalizeAngle(a) {
  a %= Math.PI * 2;
  if (a > Math.PI) a -= Math.PI * 2;
  if (a < -Math.PI) a += Math.PI * 2;
  return a;
}

// Horizontal unit vector for yaw (radians, 0 = +x/east, counter-clockwise positive, so PI/2 = +y/north).
export const yawDir = (yaw) => ({ x: Math.cos(yaw), y: Math.sin(yaw), z: 0 });
export const yawOf = (dx, dy) => Math.atan2(dy, dx);
export const DEG = Math.PI / 180;
