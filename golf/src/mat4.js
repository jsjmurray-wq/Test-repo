// 4x4 matrix helpers for the renderer and camera. Matrices are column-major Float32Array(16), the
// layout WebGL's uniformMatrix4fv expects: element (row r, column c) lives at index c*4 + r.
// Clip space follows the WebGL convention (NDC x, y, z in [-1, 1], camera looks down -z in view space).

export function create() {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

// Right-handed perspective projection. fovY in radians.
export function perspective(fovY, aspect, near, far, out = new Float32Array(16)) {
  const f = 1 / Math.tan(fovY / 2);
  const nf = 1 / (near - far);
  out.fill(0);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = (far + near) * nf;
  out[11] = -1;
  out[14] = 2 * far * near * nf;
  return out;
}

// View matrix for an eye at `eye` looking at `target` with approximate up vector `up` ({x,y,z} each).
// If up is parallel to the view direction a fallback up (+y, then +x) is used so the result is never NaN.
export function lookAt(eye, target, up, out = new Float32Array(16)) {
  let fx = target.x - eye.x;
  let fy = target.y - eye.y;
  let fz = target.z - eye.z;
  let l = Math.hypot(fx, fy, fz) || 1;
  fx /= l;
  fy /= l;
  fz /= l;
  // side = f x up
  let ux = up.x;
  let uy = up.y;
  let uz = up.z;
  let sx = fy * uz - fz * uy;
  let sy = fz * ux - fx * uz;
  let sz = fx * uy - fy * ux;
  l = Math.hypot(sx, sy, sz);
  if (l < 1e-6) {
    ux = Math.abs(fy) < 0.9 ? 0 : 1;
    uy = Math.abs(fy) < 0.9 ? 1 : 0;
    uz = 0;
    sx = fy * uz - fz * uy;
    sy = fz * ux - fx * uz;
    sz = fx * uy - fy * ux;
    l = Math.hypot(sx, sy, sz);
  }
  sx /= l;
  sy /= l;
  sz /= l;
  // true up = side x f
  const tx = sy * fz - sz * fy;
  const ty = sz * fx - sx * fz;
  const tz = sx * fy - sy * fx;
  out[0] = sx;
  out[1] = tx;
  out[2] = -fx;
  out[3] = 0;
  out[4] = sy;
  out[5] = ty;
  out[6] = -fy;
  out[7] = 0;
  out[8] = sz;
  out[9] = tz;
  out[10] = -fz;
  out[11] = 0;
  out[12] = -(sx * eye.x + sy * eye.y + sz * eye.z);
  out[13] = -(tx * eye.x + ty * eye.y + tz * eye.z);
  out[14] = fx * eye.x + fy * eye.y + fz * eye.z;
  out[15] = 1;
  return out;
}

// out = a * b (apply b first, then a). Safe when out aliases a or b.
export function multiply(a, b, out = new Float32Array(16)) {
  const r = new Float64Array(16);
  for (let c = 0; c < 4; c++) {
    for (let rr = 0; rr < 4; rr++) {
      r[c * 4 + rr] =
        a[rr] * b[c * 4] + a[4 + rr] * b[c * 4 + 1] + a[8 + rr] * b[c * 4 + 2] + a[12 + rr] * b[c * 4 + 3];
    }
  }
  for (let i = 0; i < 16; i++) out[i] = r[i];
  return out;
}

// General 4x4 inverse (cofactor expansion). Returns null when the matrix is singular.
export function invert(m, out = new Float32Array(16)) {
  const a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3];
  const a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7];
  const a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11];
  const a30 = m[12], a31 = m[13], a32 = m[14], a33 = m[15];
  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;
  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return null;
  det = 1 / det;
  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
  out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
  out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
  out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
  out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
  out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
  out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
  out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
  return out;
}

// Homogeneous transform of point p ({x,y,z}, w = 1). Returns {x, y, z, w} WITHOUT the divide.
export function transform4(m, p) {
  return {
    x: m[0] * p.x + m[4] * p.y + m[8] * p.z + m[12],
    y: m[1] * p.x + m[5] * p.y + m[9] * p.z + m[13],
    z: m[2] * p.x + m[6] * p.y + m[10] * p.z + m[14],
    w: m[3] * p.x + m[7] * p.y + m[11] * p.z + m[15],
  };
}

// Transform a point and apply the perspective divide: returns {x, y, z}.
export function transformPoint(m, p) {
  const r = transform4(m, p);
  const iw = r.w ? 1 / r.w : 0;
  return { x: r.x * iw, y: r.y * iw, z: r.z * iw };
}

// World point -> screen. w, h are the viewport size in whatever pixel unit the caller wants (the
// renderer passes CSS px). sy grows downwards. z is the NDC depth (-1 near .. 1 far); w is the clip w
// (= view-space distance along the view axis for a perspective matrix). visible: in front of the
// camera and inside the viewport.
export function project(viewProj, p, w, h) {
  const r = transform4(viewProj, p);
  if (r.w <= 1e-6) return { sx: 0, sy: 0, z: 1, w: r.w, visible: false };
  const nx = r.x / r.w;
  const ny = r.y / r.w;
  const nz = r.z / r.w;
  const sx = (nx * 0.5 + 0.5) * w;
  const sy = (0.5 - ny * 0.5) * h;
  return { sx, sy, z: nz, w: r.w, visible: nz >= -1 && nz <= 1 && sx >= 0 && sx <= w && sy >= 0 && sy <= h };
}

// Screen point (sx, sy in the same units as w, h) at NDC depth ndcZ -> world point, using the INVERSE
// of the view-projection matrix. ndcZ = -1 gives the near plane, 1 the far plane.
export function unproject(invViewProj, sx, sy, ndcZ, w, h) {
  const nx = (sx / w) * 2 - 1;
  const ny = 1 - (sy / h) * 2;
  return transformPoint(invViewProj, { x: nx, y: ny, z: ndcZ });
}
