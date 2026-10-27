// Centreline of a hole: a centripetal Catmull-Rom spline through 2D control points, resampled to a
// dense polyline with uniform ~1 m arc-length spacing.
//
// buildPath(points) -> {length, pointAt(s), tangentAt(s), project(x,y), projectInto(x,y,out)}
//   s    arc length from the first point (m)
//   lat  signed lateral offset, + to the RIGHT of travel (right = tangent x z-up = (ty, -tx))
//   dist distance to the polyline (clamped to its ends)
// Beyond the ends the path continues along the end tangents: pointAt(-5) is 5 m behind the first
// point, and project() returns s < 0 (or s > length) with lat measured from that straight
// extension. This keeps (s, lat) continuous all round the hole, which the terrain relies on.
//
// Projection is coarse-to-fine: a brute-force pass over "buckets" of 8 polyline segments (a coarse
// chord per bucket) picks the nearest bucket, then the fine 1 m segments in and next to it are
// searched exactly. That is ~70 + 24 segment tests for a 500 m hole, independent of how far the
// query point is from the path.

const BUCKET = 8;

// One centripetal (alpha = 0.5) Catmull-Rom segment from p1 to p2, Barry-Goldman evaluation.
function crSegment(p0, p1, p2, p3, out, steps) {
  const knot = (a, b) => Math.max(1e-6, Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1])));
  const t0 = 0;
  const t1 = t0 + knot(p0, p1);
  const t2 = t1 + knot(p1, p2);
  const t3 = t2 + knot(p2, p3);
  for (let k = 0; k < steps; k++) {
    const t = t1 + ((t2 - t1) * k) / steps;
    const a1x = ((t1 - t) * p0[0] + (t - t0) * p1[0]) / (t1 - t0);
    const a1y = ((t1 - t) * p0[1] + (t - t0) * p1[1]) / (t1 - t0);
    const a2x = ((t2 - t) * p1[0] + (t - t1) * p2[0]) / (t2 - t1);
    const a2y = ((t2 - t) * p1[1] + (t - t1) * p2[1]) / (t2 - t1);
    const a3x = ((t3 - t) * p2[0] + (t - t2) * p3[0]) / (t3 - t2);
    const a3y = ((t3 - t) * p2[1] + (t - t2) * p3[1]) / (t3 - t2);
    const b1x = ((t2 - t) * a1x + (t - t0) * a2x) / (t2 - t0);
    const b1y = ((t2 - t) * a1y + (t - t0) * a2y) / (t2 - t0);
    const b2x = ((t3 - t) * a2x + (t - t1) * a3x) / (t3 - t1);
    const b2y = ((t3 - t) * a2y + (t - t1) * a3y) / (t3 - t1);
    out.push((t2 - t) / (t2 - t1) * b1x + (t - t1) / (t2 - t1) * b2x, (t2 - t) / (t2 - t1) * b1y + (t - t1) / (t2 - t1) * b2y);
  }
}

// points: [[x, y], ...] (at least 2). Phantom end points mirror the neighbours so the curve starts
// and ends heading straight at / away from the second and second-to-last points.
export function buildPath(points) {
  const P = points.map((p) => [p[0], p[1]]);
  const n = P.length;
  if (n < 2) throw new Error('buildPath needs at least 2 points');
  const first = [2 * P[0][0] - P[1][0], 2 * P[0][1] - P[1][1]];
  const last = [2 * P[n - 1][0] - P[n - 2][0], 2 * P[n - 1][1] - P[n - 2][1]];
  const ext = [first, ...P, last];

  // Fine raw samples (~0.25 m) then arc-length resampling.
  const raw = [];
  for (let i = 0; i < n - 1; i++) {
    const chord = Math.hypot(P[i + 1][0] - P[i][0], P[i + 1][1] - P[i][1]);
    crSegment(ext[i], ext[i + 1], ext[i + 2], ext[i + 3], raw, Math.max(4, Math.ceil(chord / 0.25)));
  }
  raw.push(P[n - 1][0], P[n - 1][1]);
  const rn = raw.length / 2;
  const acc = new Float64Array(rn);
  for (let i = 1; i < rn; i++) acc[i] = acc[i - 1] + Math.hypot(raw[2 * i] - raw[2 * i - 2], raw[2 * i + 1] - raw[2 * i - 1]);
  const length = acc[rn - 1];

  const N = Math.max(1, Math.ceil(length)); // segments of the dense polyline
  const ds = length / N;
  const X = new Float64Array(N + 1);
  const Y = new Float64Array(N + 1);
  let j = 0;
  for (let i = 0; i <= N; i++) {
    const s = i * ds;
    while (j < rn - 2 && acc[j + 1] < s) j++;
    const span = acc[j + 1] - acc[j];
    const t = span > 0 ? Math.min(1, Math.max(0, (s - acc[j]) / span)) : 0;
    X[i] = raw[2 * j] + (raw[2 * j + 2] - raw[2 * j]) * t;
    Y[i] = raw[2 * j + 1] + (raw[2 * j + 3] - raw[2 * j + 1]) * t;
  }
  // Unit tangents at the samples (central differences, one-sided at the ends).
  const TX = new Float64Array(N + 1);
  const TY = new Float64Array(N + 1);
  for (let i = 0; i <= N; i++) {
    const a = Math.max(0, i - 1);
    const b = Math.min(N, i + 1);
    const dx = X[b] - X[a];
    const dy = Y[b] - Y[a];
    const l = Math.hypot(dx, dy) || 1;
    TX[i] = dx / l;
    TY[i] = dy / l;
  }
  const t0x = TX[0], t0y = TY[0], t1x = TX[N], t1y = TY[N];

  function pointAt(s, out = { x: 0, y: 0 }) {
    if (s <= 0) {
      out.x = X[0] + t0x * s;
      out.y = Y[0] + t0y * s;
      return out;
    }
    if (s >= length) {
      out.x = X[N] + t1x * (s - length);
      out.y = Y[N] + t1y * (s - length);
      return out;
    }
    const f = s / ds;
    const i = Math.min(N - 1, Math.floor(f));
    const t = f - i;
    out.x = X[i] + (X[i + 1] - X[i]) * t;
    out.y = Y[i] + (Y[i + 1] - Y[i]) * t;
    return out;
  }

  function tangentAt(s, out = { x: 0, y: 0 }) {
    const f = Math.min(N, Math.max(0, s / ds));
    const i = Math.min(N - 1, Math.floor(f));
    const t = f - i;
    const x = TX[i] + (TX[i + 1] - TX[i]) * t;
    const y = TY[i] + (TY[i + 1] - TY[i]) * t;
    const l = Math.hypot(x, y) || 1;
    out.x = x / l;
    out.y = y / l;
    return out;
  }

  // Coarse buckets: chord from sample b*BUCKET to min(N, (b+1)*BUCKET).
  const NB = Math.ceil(N / BUCKET);

  function segDist2(px, py, ax, ay, bx, by) {
    const dx = bx - ax;
    const dy = by - ay;
    const l2 = dx * dx + dy * dy;
    let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ex = ax + dx * t - px;
    const ey = ay + dy * t - py;
    return ex * ex + ey * ey;
  }

  function projectInto(px, py, out) {
    let bestB = 0;
    let bestD = Infinity;
    for (let b = 0; b < NB; b++) {
      const i0 = b * BUCKET;
      const i1 = Math.min(N, i0 + BUCKET);
      const d = segDist2(px, py, X[i0], Y[i0], X[i1], Y[i1]);
      if (d < bestD) {
        bestD = d;
        bestB = b;
      }
    }
    const lo = Math.max(0, (bestB - 1) * BUCKET);
    const hi = Math.min(N, (bestB + 2) * BUCKET);
    let bi = lo;
    let bt = 0;
    let bd = Infinity;
    let rawT = 0;
    for (let i = lo; i < hi; i++) {
      const ax = X[i], ay = Y[i];
      const dx = X[i + 1] - ax;
      const dy = Y[i + 1] - ay;
      const l2 = dx * dx + dy * dy;
      const tr = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
      const t = tr < 0 ? 0 : tr > 1 ? 1 : tr;
      const ex = ax + dx * t - px;
      const ey = ay + dy * t - py;
      const d = ex * ex + ey * ey;
      if (d < bd) {
        bd = d;
        bi = i;
        bt = t;
        rawT = tr;
      }
    }
    // Beyond either end: measure along / across the straight extension.
    if (bi === 0 && rawT <= 0) {
      const rx = px - X[0], ry = py - Y[0];
      out.s = rx * t0x + ry * t0y;
      out.lat = rx * t0y - ry * t0x;
      out.dist = Math.hypot(rx, ry);
      return out;
    }
    if (bi === N - 1 && rawT >= 1) {
      const rx = px - X[N], ry = py - Y[N];
      out.s = length + rx * t1x + ry * t1y;
      out.lat = rx * t1y - ry * t1x;
      out.dist = Math.hypot(rx, ry);
      return out;
    }
    const s = (bi + bt) * ds;
    const dist = Math.sqrt(bd);
    // Side from the interpolated tangent; magnitude = true distance, so lat stays continuous.
    const tx = TX[bi] + (TX[bi + 1] - TX[bi]) * bt;
    const ty = TY[bi] + (TY[bi + 1] - TY[bi]) * bt;
    const qx = X[bi] + (X[bi + 1] - X[bi]) * bt;
    const qy = Y[bi] + (Y[bi + 1] - Y[bi]) * bt;
    const side = (px - qx) * ty - (py - qy) * tx;
    out.s = s;
    out.lat = side >= 0 ? dist : -dist;
    out.dist = dist;
    return out;
  }

  const project = (x, y) => projectInto(x, y, { s: 0, lat: 0, dist: 0 });

  return { length, ds, points: P, xs: X, ys: Y, pointAt, tangentAt, project, projectInto };
}
