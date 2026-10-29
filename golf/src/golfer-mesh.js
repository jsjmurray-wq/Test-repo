// The golfer's mesh: one merged, rigidly skinned, smooth-shaded low-poly figure for a LOOK and a
// club (docs/architecture.md section 9). Pure module.
//
//   buildGolferMesh(look, club) -> {pos, nrm, col, bone, mat, idx, tris, verts, center, height, key}
//     pos   Float32Array xyz in the rest ("bind") space of golfer.js (G at rest, metres)
//     nrm   Float32Array unit normals
//     col   Float32Array rgb 0..1 (sRGB albedo; the shader linearises)
//     bone  Float32Array bone index per vertex (rigid skinning: one bone per vertex)
//     mat   Float32Array material per vertex: 0 cloth, 1 skin, 2 hair, 3 metal, 4 gloss (paint,
//           lenses), 5 rubber/leather, 6 eyes
//     idx   Uint16Array triangles (counter-clockwise from outside)
//     tris  triangle count (~6-8k; tests cap it at 9000)
//   `club` is a club object, id ('7i') or kind ('wood'); the club and both hands are built in club
//   space (golfer.js clubSpec) and carried into the bind space of their bones, so the hands always
//   wrap the grip.
//
// Every part is a parametric surface (lofted tubes with elliptical / superelliptical sections,
// ellipsoids, shells offset from the head) with normals averaged across coincident vertices, so
// seams between rings and stripes stay smooth. Parts overlap at the joints (rounded caps buried
// in the neighbour), which keeps rigid skinning free of gaps when the joints bend.

import { B, BONE_COUNT, bodyDims, clubSpec, hexToRgb, SKIN_TONES, normalizeLook, lookKey } from './golfer.js';

const TAU = Math.PI * 2;
const smooth = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
const bump = (x, c, w) => {
  const d = (x - c) / w;
  return Math.exp(-d * d);
};
const mix3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const mul3 = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const tint3 = (a, k) => [Math.min(1, a[0] * k[0]), Math.min(1, a[1] * k[1]), Math.min(1, a[2] * k[2])];
const lin = (a, b, t) => a + (b - a) * t;

// Piecewise-linear lookup in a table of rows [x, ...values] sorted by x; returns value column k.
function table(rows, x, k) {
  if (x <= rows[0][0]) return rows[0][k];
  for (let i = 1; i < rows.length; i++) {
    if (x <= rows[i][0]) {
      const t = (x - rows[i - 1][0]) / (rows[i][0] - rows[i - 1][0]);
      // Smooth (cosine) blend so profiles have no creases at the rows.
      const s = 0.5 - 0.5 * Math.cos(Math.PI * t);
      return rows[i - 1][k] + (rows[i][k] - rows[i - 1][k]) * s;
    }
  }
  return rows[rows.length - 1][k];
}

// ------------------------------------------------------------------ geometry builder
class Geo {
  constructor() {
    this.P = [];
    this.N = [];
    this.C = [];
    this.Bn = [];
    this.M = [];
    this.I = [];
    this.R = null; // optional transform: rotation (3x3 column-major) and translation
    this.T = null;
  }
  get count() {
    return this.P.length / 3;
  }
  setXform(R, T) {
    this.R = R;
    this.T = T;
  }
  clearXform() {
    this.R = null;
    this.T = null;
  }
  _xp(p) {
    const R = this.R;
    if (!R) return p;
    return [
      R[0] * p[0] + R[3] * p[1] + R[6] * p[2] + this.T[0],
      R[1] * p[0] + R[4] * p[1] + R[7] * p[2] + this.T[1],
      R[2] * p[0] + R[5] * p[1] + R[8] * p[2] + this.T[2],
    ];
  }
  // Parametric grid. us/vs: parameter samples (duplicates in vs give crisp colour bands). pos(u, v,
  // j, i) -> [x,y,z]; col(u, v, j, i, p) -> rgb. Rows run along v; with closeU the u direction
  // wraps (us must not repeat its first value). Winding: u turning counter-clockwise about the
  // direction v grows gives outward faces (flip reverses).
  grid({ us, vs, pos, col, bone, mat = 0, closeU = true, flip = false, matFn = null }) {
    const nu = us.length;
    const nv = vs.length;
    const base = this.count;
    const pts = [];
    for (let j = 0; j < nv; j++) {
      for (let i = 0; i < nu; i++) {
        const p = this._xp(pos(us[i], vs[j], j, i));
        pts.push(p);
        this.P.push(p[0], p[1], p[2]);
        const c = typeof col === 'function' ? col(us[i], vs[j], j, i, p) : col;
        this.C.push(c[0], c[1], c[2]);
        this.Bn.push(bone);
        this.M.push(matFn ? matFn(us[i], vs[j], j, i) : mat);
      }
    }
    const nrm = new Float64Array(nu * nv * 3);
    const cu = closeU ? nu : nu - 1;
    const tri = (a, b, c) => {
      if (flip) this.I.push(base + a, base + c, base + b);
      else this.I.push(base + a, base + b, base + c);
      const pa = pts[a];
      const pb = pts[b];
      const pc = pts[c];
      const ux = pb[0] - pa[0];
      const uy = pb[1] - pa[1];
      const uz = pb[2] - pa[2];
      const vx = pc[0] - pa[0];
      const vy = pc[1] - pa[1];
      const vz = pc[2] - pa[2];
      const s = flip ? -1 : 1;
      const nx = (uy * vz - uz * vy) * s;
      const ny = (uz * vx - ux * vz) * s;
      const nz = (ux * vy - uy * vx) * s;
      for (const k of [a, b, c]) {
        nrm[k * 3] += nx;
        nrm[k * 3 + 1] += ny;
        nrm[k * 3 + 2] += nz;
      }
    };
    for (let j = 0; j < nv - 1; j++) {
      for (let i = 0; i < cu; i++) {
        const i1 = (i + 1) % nu;
        const a = j * nu + i;
        const b = j * nu + i1;
        const c = (j + 1) * nu + i1;
        const d = (j + 1) * nu + i;
        tri(a, b, c);
        tri(a, c, d);
      }
    }
    // Average normals over coincident vertices (poles, duplicate stripe rows, closed seams).
    const key = (p) => `${Math.round(p[0] * 2e4)},${Math.round(p[1] * 2e4)},${Math.round(p[2] * 2e4)}`;
    const groups = new Map();
    for (let k = 0; k < pts.length; k++) {
      const kk = key(pts[k]);
      let g = groups.get(kk);
      if (!g) groups.set(kk, (g = []));
      g.push(k);
    }
    for (const g of groups.values()) {
      if (g.length < 2) continue;
      let x = 0;
      let y = 0;
      let z = 0;
      for (const k of g) {
        x += nrm[k * 3];
        y += nrm[k * 3 + 1];
        z += nrm[k * 3 + 2];
      }
      for (const k of g) {
        nrm[k * 3] = x;
        nrm[k * 3 + 1] = y;
        nrm[k * 3 + 2] = z;
      }
    }
    for (let k = 0; k < pts.length; k++) {
      let x = nrm[k * 3];
      let y = nrm[k * 3 + 1];
      let z = nrm[k * 3 + 2];
      const l = Math.hypot(x, y, z);
      if (l < 1e-12) {
        x = 0;
        y = 0;
        z = 1;
      } else {
        x /= l;
        y /= l;
        z /= l;
      }
      this.N.push(x, y, z);
    }
  }
  // Ellipsoid with semi-axes r = [a, b, c] along the columns of rot (3x3 column-major, default
  // identity) centred at c.
  ellipsoid(c, r, { rot = null, nu = 10, nv = 7, col, bone, mat = 0, shape = null }) {
    const us = [];
    for (let i = 0; i < nu; i++) us.push((i / nu) * TAU);
    const vs = [];
    for (let j = 0; j <= nv; j++) vs.push(-Math.PI / 2 + (j / nv) * Math.PI);
    const R = rot || [1, 0, 0, 0, 1, 0, 0, 0, 1];
    this.grid({
      us, vs, bone, mat, col,
      pos: (u, v) => {
        let x = Math.cos(v) * Math.cos(u) * r[0];
        let y = Math.cos(v) * Math.sin(u) * r[1];
        let z = Math.sin(v) * r[2];
        if (shape) [x, y, z] = shape(x, y, z, u, v);
        return [c[0] + R[0] * x + R[3] * y + R[6] * z, c[1] + R[1] * x + R[4] * y + R[7] * z, c[2] + R[2] * x + R[5] * y + R[8] * z];
      },
    });
  }
  // Tube along the frame (e1, e2, ax) (columns of a rotation; ax = e1 x e2) through rings at
  // parameter vs: ring(v) -> {c:[x,y,z] (in the frame's coordinates), r1, r2, n?: superellipse
  // exponent, f?: (u) -> radial factor}. Rings with r -> 0 close the ends.
  tube({ vs, ring, frame = null, origin = [0, 0, 0], nu = 12, col, bone, mat = 0, matFn = null, us = null, flip = false }) {
    const F = frame || [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const U = us || Array.from({ length: nu }, (_, i) => (i / nu) * TAU);
    this.grid({
      us: U, vs, bone, mat, col, matFn, flip,
      pos: (u, v, j) => {
        const rg = ring(v, j);
        const cu = Math.cos(u);
        const su = Math.sin(u);
        const n = rg.n || 2;
        const ex = n === 2 ? cu : Math.sign(cu) * Math.pow(Math.abs(cu), 2 / n);
        const ey = n === 2 ? su : Math.sign(su) * Math.pow(Math.abs(su), 2 / n);
        const f = rg.f ? rg.f(u) : 1;
        const r1 = (cu >= 0 || rg.r1b == null ? rg.r1 : rg.r1b) * f;
        const r2 = rg.r2 * f;
        const lx = rg.c[0] + ex * r1;
        const ly = rg.c[1] + ey * r2;
        const lz = rg.c[2];
        return [
          origin[0] + F[0] * lx + F[3] * ly + F[6] * lz,
          origin[1] + F[1] * lx + F[4] * ly + F[7] * lz,
          origin[2] + F[2] * lx + F[5] * ly + F[8] * lz,
        ];
      },
    });
  }
  // Tube along a curve: center(v) -> [x,y,z] (bone rest space), radius(v) -> [r1, r2] (r1 along
  // the reference direction `up` projected off the tangent). Rings with zero radius close the ends.
  sweep({ vs, center, radius, up = [0, 0, 1], nu = 8, col, bone, mat = 0 }) {
    const us = Array.from({ length: nu }, (_, i) => (i / nu) * TAU);
    const fr = vs.map((v) => {
      const e = 1e-3;
      const a = center(Math.max(0, v - e));
      const b = center(Math.min(1, v + e));
      let T = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const tl = Math.hypot(T[0], T[1], T[2]) || 1;
      T = [T[0] / tl, T[1] / tl, T[2] / tl];
      const d = up[0] * T[0] + up[1] * T[1] + up[2] * T[2];
      let e1 = [up[0] - T[0] * d, up[1] - T[1] * d, up[2] - T[2] * d];
      const l1 = Math.hypot(e1[0], e1[1], e1[2]) || 1;
      e1 = [e1[0] / l1, e1[1] / l1, e1[2] / l1];
      const e2 = [T[1] * e1[2] - T[2] * e1[1], T[2] * e1[0] - T[0] * e1[2], T[0] * e1[1] - T[1] * e1[0]];
      return { c: center(v), e1, e2, r: radius(v) };
    });
    this.grid({
      us, vs, bone, mat, col,
      pos: (u, v, j) => {
        const f = fr[j];
        const cu = Math.cos(u) * f.r[0];
        const su = Math.sin(u) * f.r[1];
        return [f.c[0] + f.e1[0] * cu + f.e2[0] * su, f.c[1] + f.e1[1] * cu + f.e2[1] * su, f.c[2] + f.e1[2] * cu + f.e2[2] * su];
      },
    });
  }
  // Spherical cap of radius r round unit axis `ax` from centre c, out to half-angle maxA.
  cap(c, ax, r, maxA, { nu = 10, nv = 3, col, bone, mat = 0 }) {
    const ref = Math.abs(ax[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    const d = ref[0] * ax[0] + ref[1] * ax[1] + ref[2] * ax[2];
    let e1 = [ref[0] - ax[0] * d, ref[1] - ax[1] * d, ref[2] - ax[2] * d];
    const l = Math.hypot(e1[0], e1[1], e1[2]);
    e1 = [e1[0] / l, e1[1] / l, e1[2] / l];
    const e2 = [ax[1] * e1[2] - ax[2] * e1[1], ax[2] * e1[0] - ax[0] * e1[2], ax[0] * e1[1] - ax[1] * e1[0]];
    // v runs from the rim (0) to the pole (1) so u turning about ax gives outward faces.
    const vs = Array.from({ length: nv + 1 }, (_, j) => j / nv);
    this.grid({
      us: Array.from({ length: nu }, (_, i) => (i / nu) * TAU), vs, bone, mat, col,
      pos: (u, v) => {
        const a = maxA * (1 - v);
        const sa = Math.sin(a) * r;
        const ca = Math.cos(a) * r;
        const cu = Math.cos(u) * sa;
        const su = Math.sin(u) * sa;
        return [c[0] + ax[0] * ca + e1[0] * cu + e2[0] * su, c[1] + ax[1] * ca + e1[1] * cu + e2[1] * su, c[2] + ax[2] * ca + e1[2] * cu + e2[2] * su];
      },
    });
  }
  // Triangle (a, b, c) wound so its face points along dir.
  triFacing(a, b, c, dir) {
    const P = this.P;
    const ux = P[b * 3] - P[a * 3];
    const uy = P[b * 3 + 1] - P[a * 3 + 1];
    const uz = P[b * 3 + 2] - P[a * 3 + 2];
    const vx = P[c * 3] - P[a * 3];
    const vy = P[c * 3 + 1] - P[a * 3 + 1];
    const vz = P[c * 3 + 2] - P[a * 3 + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    if (nx * dir[0] + ny * dir[1] + nz * dir[2] >= 0) this.I.push(a, b, c);
    else this.I.push(a, c, b);
  }
  // A closed flat polygon slab: outline points in the plane spanned by unit a, b (any winding),
  // front face normal n (world), thickness depth(pt) behind it. Used for the iron heads.
  slab({ outline, origin, a, b, n, depth, col, colBack, bone, mat }) {
    const m = outline.length;
    const P = (pt, d) => [
      origin[0] + a[0] * pt[0] + b[0] * pt[1] - n[0] * d,
      origin[1] + a[1] * pt[0] + b[1] * pt[1] - n[1] * d,
      origin[2] + a[2] * pt[0] + b[2] * pt[1] - n[2] * d,
    ];
    let cx = 0;
    let cy = 0;
    let area = 0;
    for (let k = 0; k < m; k++) {
      const p = outline[k];
      const q = outline[(k + 1) % m];
      cx += p[0] / m;
      cy += p[1] / m;
      area += p[0] * q[1] - q[0] * p[1];
    }
    const ccw = area > 0 ? 1 : -1;
    const wn = this.R ? [this.R[0] * n[0] + this.R[3] * n[1] + this.R[6] * n[2], this.R[1] * n[0] + this.R[4] * n[1] + this.R[7] * n[2], this.R[2] * n[0] + this.R[5] * n[1] + this.R[8] * n[2]] : n;
    const f0 = this.count;
    const front = [P([cx, cy], 0), ...outline.map((p) => P(p, 0))];
    for (const p of front) this._vert(p, n, col, bone, mat);
    for (let k = 0; k < m; k++) this.triFacing(f0, f0 + 1 + k, f0 + 1 + ((k + 1) % m), wn);
    const b0 = this.count;
    const back = [P([cx, cy], depth([cx, cy])), ...outline.map((p) => P(p, depth(p)))];
    const nb = [-n[0], -n[1], -n[2]];
    const wnb = [-wn[0], -wn[1], -wn[2]];
    for (const p of back) this._vert(p, nb, colBack || col, bone, mat);
    for (let k = 0; k < m; k++) this.triFacing(b0, b0 + 1 + k, b0 + 1 + ((k + 1) % m), wnb);
    const w0 = this.count;
    const outs = [];
    for (let k = 0; k < m; k++) {
      const p0 = outline[(k + m - 1) % m];
      const p1 = outline[(k + 1) % m];
      let ex = p1[0] - p0[0];
      let ey = p1[1] - p0[1];
      const el = Math.hypot(ex, ey) || 1;
      ex = (ex / el) * ccw;
      ey = (ey / el) * ccw;
      const on = [a[0] * ey - b[0] * ex, a[1] * ey - b[1] * ex, a[2] * ey - b[2] * ex];
      outs.push(on);
      this._vert(front[k + 1], on, colBack || col, bone, mat);
      this._vert(back[k + 1], on, colBack || col, bone, mat);
    }
    for (let k = 0; k < m; k++) {
      const k1 = (k + 1) % m;
      const a0 = w0 + k * 2;
      const a1 = w0 + k1 * 2;
      const o = outs[k];
      const wo = this.R ? [this.R[0] * o[0] + this.R[3] * o[1] + this.R[6] * o[2], this.R[1] * o[0] + this.R[4] * o[1] + this.R[7] * o[2], this.R[2] * o[0] + this.R[5] * o[1] + this.R[8] * o[2]] : o;
      this.triFacing(a0, a0 + 1, a1 + 1, wo);
      this.triFacing(a0, a1 + 1, a1, wo);
    }
  }
  _vert(p, n, col, bone, mat) {
    const q = this._xp(p);
    let nn = n;
    if (this.R) {
      const R = this.R;
      nn = [R[0] * n[0] + R[3] * n[1] + R[6] * n[2], R[1] * n[0] + R[4] * n[1] + R[7] * n[2], R[2] * n[0] + R[5] * n[1] + R[8] * n[2]];
    }
    const l = Math.hypot(nn[0], nn[1], nn[2]) || 1;
    this.P.push(q[0], q[1], q[2]);
    this.N.push(nn[0] / l, nn[1] / l, nn[2] / l);
    this.C.push(col[0], col[1], col[2]);
    this.Bn.push(bone);
    this.M.push(mat);
  }
  build() {
    return {
      pos: new Float32Array(this.P),
      nrm: new Float32Array(this.N),
      col: new Float32Array(this.C),
      bone: new Float32Array(this.Bn),
      mat: new Float32Array(this.M),
      idx: new Uint16Array(this.I),
      tris: this.I.length / 3,
      verts: this.P.length / 3,
    };
  }
}

const linspace = (a, b, n) => Array.from({ length: n }, (_, i) => a + ((b - a) * i) / (n - 1));
const ring = (n, off = 0) => Array.from({ length: n }, (_, i) => off + (i / n) * TAU);

// ------------------------------------------------------------------ colours
function palette(L) {
  const skin = hexToRgb(SKIN_TONES[L.skin].hex);
  const hair = hexToRgb(L.hairColor);
  const lum = 0.3 * skin[0] + 0.55 * skin[1] + 0.15 * skin[2];
  return {
    skin,
    skinDark: tint3(skin, [0.86, 0.8, 0.8]),
    lip: mix3(tint3(skin, [0.92, 0.72, 0.7]), [0.62, 0.3, 0.3], lum > 0.5 ? 0.18 : 0.05),
    hair,
    hairDark: mul3(hair, 0.72),
    // Stubble reads as a cool darkening of the skin.
    stubble: mix3(skin, mix3(hair, [0.2, 0.18, 0.17], 0.5), 0.32),
    shirt: hexToRgb(L.shirtColor),
    shirt2: hexToRgb(L.shirtColor2),
    legs: hexToRgb(L.legColor),
    shoe: hexToRgb(L.shoeColor),
    glove: hexToRgb(L.gloveColor),
    hat: hexToRgb(L.hatColor),
    belt: [0.13, 0.1, 0.08],
    sole: [0.16, 0.16, 0.17],
    sock: [0.93, 0.93, 0.9],
    iris: lum > 0.55 ? [0.3, 0.38, 0.45] : [0.22, 0.14, 0.09],
    sclera: [0.86, 0.84, 0.8],
  };
}

// ------------------------------------------------------------------ main entry
export function buildGolferMesh(look, club = '7i') {
  const L = normalizeLook(look);
  const D = bodyDims(L);
  const spec = clubSpec(club, D.H);
  const pal = palette(L);
  const g = new Geo();
  const J = (b) => [D.joints[b * 3], D.joints[b * 3 + 1], D.joints[b * 3 + 2]];
  buildTorso(g, D, L, pal, J);
  buildNeck(g, D, L, pal, J);
  buildHead(g, D, L, pal, J);
  buildArms(g, D, L, pal, J);
  buildLegs(g, D, L, pal, J);
  buildHandsAndClub(g, D, L, pal, J, spec);
  const m = g.build();
  const pel = J(B.pelvis);
  return { ...m, center: pel, height: D.H, key: `${lookKey(L)}#${spec.id}`, club: spec.id, bones: BONE_COUNT };
}

// ------------------------------------------------------------------ torso
// Cross-sections as rows [z/H, half-width/H, front depth/H, back depth/H, centre x/H].
const PELVIS_ROWS = [
  [0.448, 0.03, 0.022, 0.024, 0.0],
  [0.46, 0.066, 0.045, 0.05, -0.002],
  [0.478, 0.088, 0.054, 0.056, -0.004],
  [0.5, 0.097, 0.056, 0.06, -0.006],
  [0.525, 0.099, 0.056, 0.06, -0.006],
  [0.552, 0.096, 0.055, 0.055, -0.004],
  [0.58, 0.091, 0.055, 0.053, -0.002],
  [0.6, 0.088, 0.055, 0.05, 0.0],
  [0.613, 0.087, 0.055, 0.049, 0.0],
  [0.622, 0.07, 0.04, 0.036, 0.0],
  [0.626, 0.02, 0.01, 0.01, 0.0],
];
const SPINE_ROWS = [
  [0.585, 0.03, 0.02, 0.02, 0.0],
  [0.592, 0.08, 0.05, 0.044, 0.0],
  [0.605, 0.087, 0.055, 0.047, 0.0],
  [0.635, 0.088, 0.058, 0.048, 0.001],
  [0.665, 0.091, 0.059, 0.05, 0.0],
  [0.69, 0.095, 0.06, 0.052, -0.002],
  [0.705, 0.09, 0.054, 0.048, -0.002],
  [0.712, 0.04, 0.02, 0.02, -0.002],
];
const CHEST_ROWS = [
  [0.664, 0.04, 0.02, 0.02, -0.004],
  [0.672, 0.09, 0.054, 0.049, -0.004],
  [0.695, 0.099, 0.062, 0.055, -0.005],
  [0.725, 0.106, 0.068, 0.059, -0.006],
  [0.755, 0.11, 0.068, 0.062, -0.008],
  [0.782, 0.112, 0.063, 0.061, -0.01],
  [0.802, 0.105, 0.056, 0.058, -0.012],
  [0.818, 0.084, 0.047, 0.052, -0.014],
  [0.831, 0.055, 0.037, 0.043, -0.016],
  [0.84, 0.04, 0.032, 0.036, -0.017],
  [0.846, 0.012, 0.01, 0.01, -0.017],
];

function torsoDims(D, L) {
  const bf = D.build;
  const fem = D.fem;
  return {
    pelvis: { w: (fem ? 1.07 : 1) * bf.hip, dF: (fem ? 0.98 : 1) * (0.7 + 0.3 * bf.belly), dB: (fem ? 1.1 : 1) * bf.hip },
    spine: { w: (fem ? 0.86 : 1) * bf.waist, dF: (fem ? 0.9 : 1) * bf.belly, dB: (fem ? 0.92 : 1) * (0.6 + 0.4 * bf.waist) },
    chest: { w: (fem ? 0.9 : 1) * bf.chest, dF: (fem ? 0.93 : 1) * bf.chest, dB: (fem ? 0.92 : 1) * bf.chest, bust: fem ? 0.016 : 0 },
  };
}

function buildTorso(g, D, L, pal, J) {
  const H = D.H;
  const td = torsoDims(D, L);
  const shirt = L.shirt;
  const stripes = shirt === 'striped';
  const vest = shirt === 'vest';
  const legC = pal.legs;
  const torsoCol = pal.shirt;
  const underCol = vest ? pal.shirt2 : pal.shirt;
  const nu = 22;
  const us = ring(nu, 0);
  // Stripe bands: 0.024 H tall (about 4 cm), duplicated rows at every boundary for crisp edges.
  const stripeBand = 0.024;
  const vsWithStripes = (z0, z1, rows) => {
    const vs = [];
    for (const r of rows) if (r[0] >= z0 - 1e-9 && r[0] <= z1 + 1e-9) vs.push(r[0]);
    if (stripes) {
      for (let z = Math.ceil(z0 / stripeBand) * stripeBand; z < z1 - 0.004; z += stripeBand) {
        if (z > z0 + 0.004) vs.push(z - 1e-6, z + 1e-6);
      }
    }
    return vs.sort((a, b) => a - b);
  };
  const stripeCol = (z) => {
    const k = Math.floor((z + 1e-7) / stripeBand);
    return k % 2 === 0 ? pal.shirt : pal.shirt2;
  };
  const section = (rows, f, zH, u, extra = 0) => {
    const w = table(rows, zH, 1) * f.w * H;
    const dF = table(rows, zH, 2) * f.dF * H;
    const dB = table(rows, zH, 3) * f.dB * H;
    const cx = table(rows, zH, 4) * H;
    const cu = Math.cos(u);
    const su = Math.sin(u);
    const n = 2.5;
    const ex = Math.sign(cu) * Math.pow(Math.abs(cu), 2 / n);
    const ey = Math.sign(su) * Math.pow(Math.abs(su), 2 / n);
    let dx = (cu >= 0 ? dF : dB) * ex;
    // Bust (female) and pecs (male): two soft lobes on the front of the chest.
    if (extra) dx += extra * H * cu * cu * (bump(u, 0.5, 0.42) + bump(u, -0.5, 0.42) + bump(u, TAU - 0.5, 0.42));
    return [cx + dx, w * ey, zH * H];
  };
  // Pelvis (trousers, belt band) ---------------------------------------------------
  {
    const rows = PELVIS_ROWS;
    const vs = rows.map((r) => r[0]);
    vs.push(0.598 - 1e-6, 0.598 + 1e-6, 0.616 - 1e-6, 0.616 + 1e-6);
    vs.sort((a, b) => a - b);
    g.grid({
      us, vs, bone: B.pelvis,
      pos: (u, v) => {
        const p = section(rows, td.pelvis, v, u);
        if (v > 0.597 && v < 0.617) {
          const k = 1 + 0.035;
          p[0] *= k;
          p[1] *= k;
        }
        return p;
      },
      col: (u, v) => {
        if (v > 0.597 && v < 0.617) {
          // Buckle at the front.
          if (Math.cos(u) > 0.985) return [0.75, 0.74, 0.7];
          return pal.belt;
        }
        // Shirt tucked in: a sliver of shirt above the belt.
        return v > 0.617 ? torsoCol : legC;
      },
      matFn: (u, v) => (v > 0.597 && v < 0.617 ? (Math.cos(u) > 0.985 ? 3 : 5) : 0),
    });
  }
  // Abdomen (spine bone) --------------------------------------------------------------
  {
    const rows = SPINE_ROWS;
    const vs = vsWithStripes(0.585, 0.712, rows);
    g.grid({
      us, vs, bone: B.spine,
      pos: (u, v) => section(rows, td.spine, v, u),
      col: (u, v, j) => {
        if (stripes) return stripeCol(vs[j]);
        if (vest && v < 0.61) return mul3(torsoCol, 0.85); // ribbed hem
        return torsoCol;
      },
    });
  }
  // Chest ----------------------------------------------------------------------------------
  {
    const rows = CHEST_ROWS;
    const vs = vsWithStripes(0.664, 0.846, rows);
    const pecs = D.fem ? td.chest.bust : 0.004 * D.build.chest;
    const vBottom = 0.742;
    g.grid({
      us, vs, bone: B.chest,
      pos: (u, v) => {
        const amt = pecs * bump(v, D.fem ? 0.735 : 0.745, D.fem ? 0.03 : 0.028);
        return section(rows, td.chest, v, u, amt);
      },
      col: (u, v, j, i, p) => {
        const a = Math.atan2(Math.sin(u), Math.cos(u)); // -pi..pi, 0 = front
        if (vest) {
          // V-neck: the polo shows above a V from 0.742 H at the front centre.
          const open = (v - vBottom) / (0.832 - vBottom);
          if (open > 0 && Math.abs(a) < 0.08 + 0.62 * open && Math.cos(u) > 0) return underCol;
          if (v > 0.82) return underCol; // shoulders and neckline of the polo
          return torsoCol;
        }
        let c = stripes ? stripeCol(vs[j]) : torsoCol;
        // Placket: a narrow darker strip down the front from the collar.
        if (v > 0.775 && Math.abs(a) < 0.07 && Math.cos(u) > 0) c = mul3(stripes ? pal.shirt : torsoCol, 0.86);
        return c;
      },
    });
  }
  // Polo collar (open at the front): an outer band and its inner face.
  buildCollar(g, D, L, vest ? pal.shirt2 : pal.shirt);
}

function buildCollar(g, D, L, col) {
  const H = D.H;
  const neck = J0(D, B.neck);
  const r0 = 0.037 * H * D.build.neck * (D.fem ? 0.9 : 1);
  const cx = neck[0] + 0.004 * H;
  const z0 = 0.826 * H;
  const gap = 0.42; // half-angle of the opening at the front (rad)
  const us = linspace(gap, TAU - gap, 18);
  const prof = [
    [0, r0 * 1.06, 0],
    [0.4, r0 * 1.12, 0.013 * H],
    [0.75, r0 * 1.22, 0.021 * H],
    [1, r0 * 1.42, 0.012 * H],
  ];
  const pos = (inset) => (u, v) => {
    const k = Math.min(prof.length - 1, Math.round(v * (prof.length - 1)));
    const p = prof[k];
    // Collar points: longer at the front.
    const front = smooth(1.2, 0.4, Math.min(Math.abs(u), Math.abs(TAU - u)));
    const r = p[1] * (1 + 0.08 * front) - inset;
    const z = z0 + p[2] - (v > 0.9 ? 0.012 * H * front : 0);
    return [cx + Math.cos(u) * r * 1.05, Math.sin(u) * r, z];
  };
  const vs = prof.map((p) => p[0]);
  g.grid({ us, vs, closeU: false, bone: B.chest, col, pos: pos(0) });
  g.grid({ us, vs, closeU: false, bone: B.chest, col: mul3(col, 0.8), pos: pos(0.002 * H), flip: true });
}

function J0(D, b) {
  return [D.joints[b * 3], D.joints[b * 3 + 1], D.joints[b * 3 + 2]];
}

// ------------------------------------------------------------------ neck
function buildNeck(g, D, L, pal, J) {
  const H = D.H;
  const n = J(B.neck);
  const r = 0.031 * H * D.build.neck * (D.fem ? 0.86 : 1);
  const zTop = D.chinZ + 0.03 * H;
  g.tube({
    vs: linspace(0, 1, 5), nu: 12, bone: B.neck, mat: 1, col: pal.skin,
    ring: (v) => {
      const z = lin(0.808 * H, zTop, v);
      const cap = v === 0 || v === 1 ? 0.5 : 1;
      return { c: [lin(n[0] - 0.002 * H, n[0] + 0.006 * H, v), 0, z], r1: r * 1.04 * cap, r2: r * 1.1 * cap };
    },
  });
}

// ------------------------------------------------------------------ head
// The head is a superellipsoid deformed into a skull and face: a fuller cranium, a narrower
// jaw and chin, a brow ridge, soft eye sockets, cheekbones and lips. Features (nose, ears,
// eyes and lids, brows) are separate small parts on the head bone. Head-local axes are G's (x
// toward the face).
function headShape(D, L) {
  const s = D.headH / 0.232;
  const fem = D.fem;
  const ax = 0.097 * s * (fem ? 0.97 : 1);
  const ay = 0.077 * s * (fem ? 0.95 : 1);
  const az = 0.116 * s;
  const c = [0.006 * D.H, 0, D.chinZ + az * 0.98];
  const jaw = fem ? 0.36 : 0.3;
  return {
    s, ax, ay, az, c,
    // (th: around z from the face, 0 = front, + = left; ph: -pi/2 chin .. pi/2 crown) -> head-local point
    at(th, ph) {
      const ct = Math.cos(th);
      const st = Math.sin(th);
      const cp = Math.cos(ph);
      const sp = Math.sin(ph);
      // Boxier face, rounder back.
      const n = ct > 0 ? 2.5 : 2.1;
      const ex = Math.sign(ct) * Math.pow(Math.abs(ct), 2 / n);
      const ey = Math.sign(st) * Math.pow(Math.abs(st), 2 / n);
      let x = ax * cp * ex;
      let y = ay * cp * ey;
      let z = az * sp;
      const lower = smooth(0.05, -0.95, sp);
      // Jaw narrows toward the chin; the lower back of the head tucks into the neck.
      y *= 1 - jaw * lower * (0.55 + 0.45 * Math.max(0, ct));
      if (ct < 0) x *= 1 - 0.38 * lower * -ct;
      // Fuller cranium at the back and top.
      if (sp > 0) x *= 1 + 0.07 * sp * Math.max(0, -ct);
      // Flatter temples.
      y *= 1 - 0.05 * bump(sp, 0.45, 0.25) * Math.abs(st);
      // Chin forward, jaw angle (softer for a female face).
      x += 0.012 * s * bump(th, 0, 0.42) * bump(ph, -1.12, 0.28);
      if (!fem) y += Math.sign(st) * 0.004 * s * bump(Math.abs(th), 1.15, 0.3) * bump(ph, -0.8, 0.25);
      // Face front: brow ridge, eye sockets, cheekbones, mouth.
      if (ct > 0) {
        const fw = bump(th, 0, 0.62);
        x += (fem ? 0.0035 : 0.0062) * s * bump(ph, 0.27, 0.09) * fw;
        for (const e of [0.42, -0.42]) x -= 0.0075 * s * bump(th, e, 0.17) * bump(ph, 0.12, 0.09);
        y += Math.sign(st) * 0.004 * s * bump(Math.abs(th), 0.78, 0.2) * bump(ph, -0.06, 0.12);
        // Lips: upper and lower lip forward, a soft line between.
        const lw = bump(th, 0, 0.26);
        x += 0.0045 * s * lw * (bump(ph, -0.47, 0.05) + (fem ? 1.15 : 0.9) * bump(ph, -0.58, 0.05));
        x -= 0.0022 * s * lw * bump(ph, -0.525, 0.025);
        // Philtrum-to-nose area slightly forward; mouth corners in.
        x += 0.003 * s * bump(th, 0, 0.3) * bump(ph, -0.36, 0.1);
        x -= 0.002 * s * (bump(th, 0.3, 0.06) + bump(th, -0.3, 0.06)) * bump(ph, -0.53, 0.06);
      }
      return [x, y, z];
    },
  };
}

function buildHead(g, D, L, pal, J) {
  const hs = headShape(D, L);
  const s = hs.s;
  const c = hs.c;
  const bone = B.head;
  // Theta samples: dense over the face, sparse at the back.
  const ths = [];
  for (let i = 0; i < 18; i++) ths.push(-1.7 + (i / 18) * 3.4);
  for (let i = 0; i < 7; i++) ths.push(1.7 + ((i / 7) * (TAU - 3.4)));
  const phs = [-Math.PI / 2, -1.35, -1.18, -1.02, -0.86, -0.72, -0.62, -0.55, -0.5, -0.43, -0.34, -0.22, -0.1, 0.02, 0.13, 0.24, 0.36, 0.52, 0.7, 0.9, 1.15, 1.38, Math.PI / 2];
  const hairCol = pal.hair;
  const bald = L.hair === 'bald';
  const hairLine = hairlineFor(L);
  const beardRegion = (th, ph) => {
    const a = Math.abs(th);
    if (a > 1.62) return 0;
    const cheek = lin(-0.16, -0.5, smooth(0.9, 1.6, a));
    if (ph > cheek) return 0;
    // Keep the lips clear.
    if (a < 0.3 && ph > -0.62 && ph < -0.44) return 0;
    return smooth(cheek, cheek - 0.12, ph) * smooth(1.62, 1.4, a);
  };
  g.grid({
    us: ths, vs: phs, bone, mat: 1,
    pos: (th, ph) => {
      const p = hs.at(th, ph);
      return [c[0] + p[0], c[1] + p[1], c[2] + p[2]];
    },
    col: (th, ph) => {
      let col = pal.skin;
      const a = Math.abs(th);
      // Lips.
      if (a < 0.3 && ph > -0.62 && ph < -0.43 && Math.cos(th) > 0) {
        const k = bump(th, 0, 0.24) * (bump(ph, -0.47, 0.05) + bump(ph, -0.58, 0.05));
        col = mix3(col, pal.lip, Math.min(1, k * 1.4));
      }
      // Scalp under the hair takes the hair colour (no skin shows at the hairline).
      const hl = hairLine(th);
      if (!bald && ph > hl - 0.04) col = mix3(col, pal.hairDark, smooth(hl - 0.04, hl + 0.06, ph) * 0.9);
      if (bald) {
        // A close-cropped fringe round the back and sides.
        const fr = smooth(0.0, 0.28, ph) * smooth(0.55, 0.3, ph) * smooth(1.0, 1.7, a);
        col = mix3(col, mix3(pal.skin, hairCol, 0.6), fr * 0.7);
      }
      if (L.facialHair === 'stubble' || L.facialHair === 'beard') col = mix3(col, pal.stubble, beardRegion(th, ph));
      // Slightly warmer cheeks and ears, cooler jaw.
      col = mix3(col, tint3(col, [1.03, 0.94, 0.93]), 0.5 * bump(a, 0.75, 0.25) * bump(ph, -0.15, 0.2));
      return col;
    },
  });
  const P = (th, ph, out = 0) => {
    const p = hs.at(th, ph);
    const l = Math.hypot(p[0] / hs.ax, p[1] / hs.ay, p[2] / hs.az) || 1;
    // Approximate outward normal of the base ellipsoid.
    let nx = p[0] / (hs.ax * hs.ax);
    let ny = p[1] / (hs.ay * hs.ay);
    let nz = p[2] / (hs.az * hs.az);
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl;
    ny /= nl;
    nz /= nl;
    void l;
    return [c[0] + p[0] + nx * out, c[1] + p[1] + ny * out, c[2] + p[2] + nz * out];
  };
  buildFace(g, D, L, pal, hs, P);
  buildHair(g, D, L, pal, hs, P, hairLine);
  buildFacialHair(g, D, L, pal, hs, P, beardRegion);
  buildHeadwear(g, D, L, pal, hs, P);
  if (L.sunglasses) buildSunglasses(g, D, L, pal, hs, P);
}

// Hairline height (ph) by angle round the head: forehead, temples, above the ears, nape.
function hairlineFor(L) {
  const fem = L.body === 'female';
  return (th) => {
    const a = Math.abs(Math.atan2(Math.sin(th), Math.cos(th)));
    const rows = [
      [0, fem ? 0.6 : 0.64],
      [0.55, fem ? 0.56 : 0.6],
      [0.95, fem ? 0.38 : 0.44],
      [1.3, 0.3],
      [1.55, 0.22],
      [1.85, -0.05],
      [2.3, -0.4],
      [Math.PI, -0.62],
    ];
    return table(rows, a, 1);
  };
}

function buildFace(g, D, L, pal, hs, P) {
  const s = hs.s;
  const bone = B.head;
  const c = hs.c;
  const fem = D.fem;
  // Nose: a tapered wedge from the bridge to the tip, wider at the base, plus the wings.
  {
    const root = P(0, 0.13, -0.004 * s);
    const tip = P(0, -0.3, 0.019 * s * (fem ? 0.85 : 1));
    const base = P(0, -0.36, 0.002 * s);
    g.tube({
      vs: linspace(0, 1, 7), nu: 10, bone, mat: 1, col: tint3(pal.skin, [1.02, 0.97, 0.96]),
      ring: (v) => {
        const z = lin(root[2], base[2] + 0.004 * s, v);
        const x = lin(root[0], tip[0], Math.pow(v, 0.8)) - (v > 0.85 ? (v - 0.85) * 0.04 * s : 0);
        const w = (0.0045 + 0.007 * v * v) * s * (fem ? 0.88 : 1);
        const d = (0.006 + 0.007 * v) * s;
        const cap = v >= 0.999 ? 0.35 : 1;
        return { c: [x - d * 0.55, 0, z], r1: d * cap, r2: w * cap };
      },
      flip: true, // runs downward
    });
    for (const sd of [1, -1]) {
      const w = P(sd * 0.15, -0.355, 0.003 * s);
      g.ellipsoid([w[0] - 0.003 * s, w[1], w[2]], [0.009 * s, 0.0075 * s, 0.0065 * s], { nu: 8, nv: 5, bone, mat: 1, col: tint3(pal.skin, [1.0, 0.94, 0.93]) });
    }
  }
  // Eyes: dark-irised spheres in the sockets with upper and lower lids, and brows.
  for (const sd of [1, -1]) {
    const th = sd * 0.42;
    const eye = P(th, 0.12, -0.0115 * s);
    const er = 0.0118 * s;
    const fwd = [Math.cos(th * 0.35), Math.sin(th * 0.35), -0.05];
    g.ellipsoid(eye, [er, er, er], { nu: 10, nv: 6, bone, mat: 6, col: pal.sclera });
    // Iris and pupil: a cap just proud of the eyeball, looking forward.
    const fl = Math.hypot(fwd[0], fwd[1], fwd[2]);
    const fa = [fwd[0] / fl, fwd[1] / fl, fwd[2] / fl];
    g.cap(eye, fa, er * 1.006, 0.5, { nu: 10, nv: 2, bone, mat: 6, col: pal.iris });
    g.cap(eye, fa, er * 1.012, 0.2, { nu: 8, nv: 1, bone, mat: 6, col: [0.04, 0.035, 0.03] });
    // Lids: skin shells covering the top 45% and bottom 30% of the eyeball.
    const lidR = er * 1.12;
    g.grid({
      us: linspace(-1.45, 1.45, 9), vs: linspace(0.12, 1.45, 4), bone, mat: 1, closeU: false, col: tint3(pal.skin, [0.97, 0.93, 0.92]),
      pos: (u, v) => [eye[0] + Math.cos(v) * Math.cos(u) * lidR, eye[1] + Math.cos(v) * Math.sin(u) * lidR, eye[2] + Math.sin(v) * lidR],
    });
    g.grid({
      us: linspace(-1.45, 1.45, 9), vs: linspace(-1.4, -0.42, 3), bone, mat: 1, closeU: false, col: pal.skin,
      pos: (u, v) => [eye[0] + Math.cos(v) * Math.cos(u) * lidR * 0.98, eye[1] + Math.cos(v) * Math.sin(u) * lidR * 0.98, eye[2] + Math.sin(v) * lidR * 0.98],
    });
    // Brow: a slim arc on the brow ridge.
    const browCol = L.hair === 'bald' ? mix3(pal.hair, pal.skin, 0.3) : mix3(pal.hair, [0.1, 0.08, 0.07], 0.25);
    g.sweep({
      vs: linspace(0, 1, 6), nu: 6, bone, mat: 2, col: browCol, up: [1, 0, 0],
      center: (v) => P(sd * lin(0.17, 0.72, v), 0.285 - 0.05 * v * v + 0.015 * v, 0.0012 * s),
      radius: (v) => {
        const r = (fem ? 0.0021 : 0.0029) * s * (v === 0 || v === 1 ? 0.25 : 1 - 0.35 * v);
        return [r * 0.6, r];
      },
    });
  }
  // Ears.
  for (const sd of [1, -1]) {
    const p = P(sd * 1.6, -0.05, -0.002 * s);
    const rot = earRot(sd);
    g.ellipsoid([p[0] - 0.006 * s, p[1] + sd * 0.004 * s, p[2]], [0.017 * s, 0.0075 * s, 0.03 * s], {
      rot, nu: 10, nv: 7, bone, mat: 1, col: tint3(pal.skin, [1.02, 0.93, 0.9]),
      shape: (x, y, z) => {
        // Hollow the outer face a little (concha) and thin the lobe.
        const k = sd * y > 0 ? 1 - 0.45 * bump(x / (0.017 * s), 0.1, 0.5) * bump(z / (0.03 * s), -0.1, 0.5) : 1;
        return [x * (z < 0 ? 0.85 : 1), y * k, z];
      },
    });
  }
  void c;
}

function earRot(sd) {
  // Tilted back 15 degrees, turned slightly forward.
  const a = 0.26;
  const b = sd * 0.25;
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  const cb = Math.cos(b);
  const sb = Math.sin(b);
  // R = Rz(b) * Ry(-a)
  const x = [cb * ca, sb * ca, sa];
  const y = [-sb, cb, 0];
  const z = [-cb * sa, -sb * sa, ca];
  return [...x, ...y, ...z];
}

function buildHair(g, D, L, pal, hs, P, hairLine) {
  const style = L.hair;
  if (style === 'bald') return;
  const s = hs.s;
  const bone = B.head;
  const hat = L.headwear;
  const hatLine = hatLineFor(hat);
  const col = pal.hair;
  const buzz = style === 'buzz';
  const curly = style === 'curly';
  const side = style === 'sidepart';
  const thick = (th, ph) => {
    const a = Math.abs(Math.atan2(Math.sin(th), Math.cos(th)));
    const top = smooth(0.0, 1.2, ph);
    let t;
    if (buzz) t = 0.0028;
    else if (curly) t = 0.011 + 0.008 * top + 0.0035 * Math.sin(9 * th + 2.1) * Math.sin(8 * ph + 0.7) + 0.002 * Math.sin(17 * th) * Math.cos(13 * ph);
    else if (side) t = 0.006 + 0.008 * top + 0.007 * bump(th, -0.2, 0.7) * bump(ph, 0.9, 0.45) + 0.004 * smooth(0.3, 1.2, a) * (Math.sin(th) < 0 ? 1 : 0.4);
    else if (style === 'long' || style === 'ponytail') t = 0.006 + 0.005 * top;
    else t = 0.005 + 0.0065 * top + 0.003 * bump(th, 0, 0.6) * bump(ph, 0.75, 0.25);
    // Thin out toward the hairline so the shell meets the scalp softly.
    const hl = hairLine(th);
    t *= 0.25 + 0.75 * smooth(hl, hl + 0.22, ph);
    if (hat !== 'none' && hat !== 'visor') t = Math.min(t, 0.0045);
    return t * s;
  };
  const ths = ring(28, 0);
  // Rows from the hairline (per column) to the crown.
  const rows = 9;
  const vs = linspace(0, 1, rows);
  const phAt = (th, v) => {
    const hl = hairLine(th);
    const top = hat === 'none' || hat === 'visor' ? Math.PI / 2 : Math.min(Math.PI / 2, hatLine(th) + 0.08);
    return lin(hl, top, v);
  };
  if (!(hat !== 'none' && hat !== 'visor' && style === 'buzz')) {
    g.grid({
      us: ths, vs, bone, mat: 2,
      pos: (th, v) => {
        const ph = phAt(th, v);
        return P(th, ph, thick(th, ph));
      },
      col: (th, v) => {
        const ph = phAt(th, v);
        let c = buzz ? mix3(col, pal.skin, 0.35) : col;
        // Side parting: a fine lighter line on the left.
        if (side && Math.abs(th - 0.55) < 0.07 && ph > 0.6) c = mix3(c, pal.skin, 0.35);
        // Lighter crown highlight band, darker under-layers near the nape.
        c = mul3(c, 0.88 + 0.16 * smooth(-0.4, 1.0, ph));
        return c;
      },
    });
  }
  // Long hair: a curtain falling to the shoulders behind and beside the face.
  if (style === 'long') {
    const us = linspace(0.95, TAU - 0.95, 16);
    g.grid({
      us, vs: linspace(0, 1, 6), bone, mat: 2, closeU: false, flip: true, col: mul3(col, 0.95),
      pos: (th, v) => {
        const hl = Math.min(hairLine(th), 0.1);
        const p = P(th, hl, thick(th, hl) * 0.9);
        const drop = v * 0.2 * s;
        const out = (0.004 + 0.02 * v) * s;
        const ct = Math.cos(th);
        const st = Math.sin(th);
        // Hang below the jaw, flaring a little; shorter toward the front.
        const front = smooth(1.6, 1.0, Math.min(Math.abs(Math.atan2(st, ct)), 3));
        return [p[0] + ct * out * 0.6, p[1] + st * out, p[2] - drop * (1 - 0.45 * front)];
      },
    });
    // Inner face of the curtain (so it is solid from the side).
    g.grid({
      us, vs: linspace(0, 1, 6), bone, mat: 2, closeU: false, col: mul3(col, 0.7),
      pos: (th, v) => {
        const hl = Math.min(hairLine(th), 0.1);
        const p = P(th, hl, thick(th, hl) * 0.9 - 0.004 * s);
        const drop = v * 0.2 * s;
        const out = (0.0 + 0.018 * v) * s;
        const ct = Math.cos(th);
        const st = Math.sin(th);
        const front = smooth(1.6, 1.0, Math.min(Math.abs(Math.atan2(st, ct)), 3));
        return [p[0] + ct * out * 0.6, p[1] + st * out, p[2] - drop * (1 - 0.45 * front)];
      },
    });
  }
  if (style === 'ponytail') {
    const root = P(Math.PI, -0.05, 0.004 * s);
    // Band, then a tapering tail falling down the back.
    const vsP = [0, 0.06, 0.12, 0.12 + 1e-4, 0.25, 0.45, 0.65, 0.85, 1];
    g.sweep({
      vs: vsP, nu: 9, bone, mat: 2, up: [-1, 0, 0],
      col: (u, v, j) => (vsP[j] <= 0.12 ? mul3(pal.hat, 0.55) : mul3(col, 0.9 + 0.1 * Math.sin(u * 3))),
      center: (v) => [root[0] - 0.012 * s - 0.03 * s * Math.sin(v * 1.7), root[1], root[2] - 0.17 * s * v],
      radius: (v) => {
        const r = (v <= 0.12 ? 0.0135 : 0.017 * (1 - 0.7 * v) + 0.003) * s * (v === 1 ? 0.25 : v === 0 ? 0.6 : 1);
        return [r, r * 1.1];
      },
    });
  }
}

// Lower edge (ph) of a hat crown round the head.
function hatLineFor(hat) {
  return (th) => {
    const a = Math.abs(Math.atan2(Math.sin(th), Math.cos(th)));
    if (hat === 'bucket') return table([[0, 0.42], [1.4, 0.3], [Math.PI, 0.18]], a, 1);
    if (hat === 'flatcap') return table([[0, 0.44], [1.4, 0.36], [Math.PI, 0.2]], a, 1);
    return table([[0, 0.48], [1.2, 0.4], [2.2, 0.26], [Math.PI, 0.16]], a, 1);
  };
}

function buildFacialHair(g, D, L, pal, hs, P, beardRegion) {
  const fh = L.facialHair;
  if (fh !== 'moustache' && fh !== 'beard') return;
  const s = hs.s;
  const bone = B.head;
  const col = mix3(pal.hair, [0.12, 0.1, 0.09], 0.15);
  // Moustache: a soft bar over the upper lip, tapering at the corners.
  g.sweep({
    vs: linspace(0, 1, 9), nu: 7, bone, mat: 2, col, up: [1, 0, 0],
    center: (v) => {
      const th = lin(-0.38, 0.38, v);
      const ph = -0.425 - 0.08 * Math.pow(Math.abs(v - 0.5) * 2, 2.2);
      return P(th, ph, 0.003 * s);
    },
    radius: (v) => {
      const e = Math.abs(v - 0.5) * 2;
      const r = 0.0055 * s * (1 - 0.55 * e * e) * (v === 0 || v === 1 ? 0.25 : 1);
      return [r * 0.7, r];
    },
  });
  if (fh === 'beard') {
    // A short full beard: a shell over the jaw, chin and cheeks, clear of the lips.
    const us = linspace(-1.62, 1.62, 21);
    const vs = linspace(-Math.PI / 2 + 0.05, -0.12, 9);
    g.grid({
      us, vs, bone, mat: 2, closeU: false, col,
      pos: (th, ph) => {
        const w = beardRegion(th, ph);
        const t = (0.0095 * w - 0.0012) * s * (ph < -1.0 ? 1.15 : 1);
        return P(th, ph, t);
      },
      col: (th, ph) => mix3(pal.stubble, col, Math.min(1, beardRegion(th, ph) * 1.6)),
    });
  }
}

function buildHeadwear(g, D, L, pal, hs, P) {
  const hat = L.headwear;
  if (hat === 'none') return;
  const s = hs.s;
  const bone = B.head;
  const col = pal.hat;
  const hatLine = hatLineFor(hat);
  const off = hat === 'bucket' ? 0.011 * s : 0.0085 * s;
  if (hat !== 'visor') {
    // Crown: a shell from the hat line to the top, a little taller than the head.
    const ths = ring(24, 0);
    const vs = linspace(0, 1, 7);
    const phAt = (th, v) => lin(hatLine(th), Math.PI / 2, v);
    g.grid({
      us: ths, vs, bone, mat: 0,
      pos: (th, v) => {
        const ph = phAt(th, v);
        let o = off + (hat === 'flatcap' ? 0.004 : 0.008) * s * Math.sin(v * Math.PI * 0.5);
        const p = P(th, ph, o);
        if (hat === 'bucket') p[2] = Math.min(p[2], hs.c[2] + hs.az * 1.0);
        if (hat === 'flatcap') {
          // Flat crown pulled forward over the brim.
          const fwd = Math.max(0, Math.cos(th));
          p[0] += 0.016 * s * fwd * v;
          p[2] = Math.min(p[2], hs.c[2] + hs.az * 0.9 + 0.01 * s * (1 - fwd));
        }
        return p;
      },
      col: (th, v) => {
        let c = col;
        // Panel seams on a cap.
        if (hat === 'cap' && v > 0.15) {
          const seam = Math.abs(Math.sin(th * 3));
          if (seam < 0.09) c = mul3(c, 0.88);
        }
        if (hat === 'flatcap') c = mul3(c, 0.94 + 0.08 * Math.sin(th * 23) * Math.sin(v * 19));
        // Sweat band edge.
        if (v < 0.07) c = mul3(c, 0.9);
        return c;
      },
    });
    if (hat === 'cap') {
      const top = P(0, Math.PI / 2, off + 0.0105 * s);
      g.ellipsoid(top, [0.006 * s, 0.006 * s, 0.003 * s], { nu: 8, nv: 4, bone, mat: 0, col: mul3(col, 0.9) });
    }
  } else {
    // Visor band.
    const ths = ring(24, 0);
    g.grid({
      us: ths, vs: [0, 1], bone, mat: 0, col,
      pos: (th, v) => P(th, hatLine(th) + v * 0.17, off * 0.7),
    });
    g.grid({
      us: ths, vs: [0, 1], bone, mat: 0, col: mul3(col, 0.8), flip: true,
      pos: (th, v) => P(th, hatLine(th) + v * 0.17, off * 0.7 - 0.0015 * s),
    });
  }
  // Bills and brims.
  if (hat === 'cap' || hat === 'visor' || hat === 'flatcap') {
    const len = (hat === 'flatcap' ? 0.045 : 0.074) * s;
    const half = hat === 'flatcap' ? 1.0 : 0.95;
    const us = linspace(-half, half, 13);
    const vs = linspace(0, 1, 5);
    const edge = (th) => P(th, hatLine(th) + (hat === 'flatcap' ? 0.0 : 0.01), off * 0.95);
    const billPos = (th, v, dz) => {
      const e = edge(th);
      const w = Math.cos((th / half) * Math.PI * 0.5);
      const reach = len * Math.sqrt(Math.max(0, w)) * v;
      const pitch = hat === 'flatcap' ? 0.35 : 0.2;
      // Out along the head's radial direction, curving down at the sides.
      const ct = Math.cos(th);
      const st = Math.sin(th);
      return [e[0] + ct * reach, e[1] + st * reach * 0.85, e[2] - reach * pitch - 0.01 * s * v * (1 - w) + dz];
    };
    g.grid({ us, vs, closeU: false, bone, mat: 0, flip: true, col, pos: (th, v) => billPos(th, v, 0.0012 * s) });
    g.grid({
      us, vs, closeU: false, bone, mat: 0, col: hat === 'flatcap' ? mul3(col, 0.8) : mix3(mul3(col, 0.75), [0.2, 0.35, 0.25], 0.25),
      pos: (th, v) => billPos(th, v, -0.0012 * s),
    });
  }
  if (hat === 'bucket') {
    const ths = ring(24, 0);
    const vs = linspace(0, 1, 4);
    const brim = (th, v, dz) => {
      const e = P(th, hatLine(th), off);
      const ct = Math.cos(th);
      const st = Math.sin(th);
      const r = 0.05 * s * v;
      return [e[0] + ct * r, e[1] + st * r, e[2] - r * 0.5 + dz];
    };
    g.grid({
      us: ths, vs, bone, mat: 0, flip: true, pos: (th, v) => brim(th, v, 0.0015 * s),
      col: (th, v) => (Math.abs(v - 0.34) < 0.05 || Math.abs(v - 0.67) < 0.05 ? mul3(col, 0.86) : col),
    });
    g.grid({ us: ths, vs, bone, mat: 0, col: mul3(col, 0.78), pos: (th, v) => brim(th, v, -0.0015 * s) });
  }
}

function buildSunglasses(g, D, L, pal, hs, P) {
  const s = hs.s;
  const bone = B.head;
  const lens = [0.12, 0.13, 0.15];
  const frame = [0.08, 0.08, 0.09];
  // Wraparound lens band in front of the eyes, a notch for the nose.
  const us = linspace(-1.02, 1.02, 17);
  const vs = [0, 0.33, 0.66, 1];
  const posAt = (th, v, out) => {
    const a = Math.abs(th);
    const bottom = -0.07 + 0.05 * smooth(0.55, 1.0, a) + 0.12 * smooth(0.17, 0.04, a);
    const ph = lin(bottom, 0.25, v);
    return P(th, ph, out);
  };
  g.grid({ us, vs, closeU: false, bone, mat: 4, col: (th, v) => (v > 0.9 ? frame : lens), pos: (th, v) => posAt(th, v, 0.017 * s) });
  g.grid({ us, vs, closeU: false, bone, mat: 4, flip: true, col: frame, pos: (th, v) => posAt(th, v, 0.0145 * s) });
  // Temple arms back to the ears.
  for (const sd of [1, -1]) {
    g.sweep({
      vs: linspace(0, 1, 5), nu: 5, bone, mat: 4, col: frame, up: [0, 0, 1],
      center: (v) => P(sd * lin(1.0, 1.72, v), 0.2 - 0.03 * v, lin(0.012, 0.004, v) * s),
      radius: (v) => {
        const r = 0.0022 * s * (v === 0 || v === 1 ? 0.5 : 1);
        return [r * 1.5, r];
      },
    });
  }
}

// ------------------------------------------------------------------ arms
function buildArms(g, D, L, pal, J) {
  const H = D.H;
  const limb = D.build.limb * (D.fem ? 0.88 : 1);
  const vest = L.shirt === 'vest';
  const sleeveCol = vest ? pal.shirt2 : pal.shirt;
  const stripes = L.shirt === 'striped';
  for (const [sd, ua, fa, cl] of [[1, B.upperArmL, B.forearmL, B.clavL], [-1, B.upperArmR, B.forearmR, B.clavR]]) {
    const sh = J(ua);
    const el = J(fa);
    const wr = J(sd > 0 ? B.handL : B.handR);
    const lenU = sh[2] - el[2];
    const sleeveEnd = 0.45; // fraction of the upper arm from the shoulder
    // Upper arm: rounded elbow end, biceps, deltoid cap above the joint.
    const vsU = [0, 0.04, 0.12, 0.3, 0.5, 0.55 - 1e-4, 0.55, 0.62, 0.75, 0.86, 0.94, 1.0];
    g.tube({
      vs: vsU, nu: 12, bone: ua,
      mat: 0,
      matFn: (u, v) => (v < 0.55 ? 1 : 0),
      col: (u, v) => {
        if (v < 0.55) return pal.skin;
        if (stripes) return Math.floor((sh[2] - lenU * (1 - v)) / (0.024 * H) + 1e-6) % 2 === 0 ? pal.shirt : pal.shirt2;
        return v < 0.6 ? mul3(sleeveCol, 0.93) : sleeveCol;
      },
      ring: (v) => {
        const z = el[2] - 0.02 * H + v * (lenU + 0.05 * H);
        let r = lin(0.0165, 0.0212, smooth(0, 0.55, v)) * H * limb;
        if (v >= 0.55) r = (0.0232 + 0.0018 * bump(v, 0.78, 0.15)) * H * limb; // sleeve, looser
        if (v > 0.86) r *= 1 - (v - 0.86) * 5.5; // close over the shoulder
        if (v === 0) r *= 0.5;
        // Deltoid sits outward and slightly forward of the joint.
        const dx = 0.002 * H * bump(v, 0.85, 0.15);
        const dy = sd * 0.002 * H * smooth(0.6, 0.95, v);
        return { c: [sh[0] + dx, sh[1] + dy, z], r1: r * 0.95, r2: r };
      },
    });
    void sleeveEnd;
    void cl;
    // Forearm: elbow cap, forearm muscle near the top, slim wrist.
    const lenF = el[2] - wr[2];
    g.tube({
      vs: [0, 0.06, 0.2, 0.45, 0.7, 0.86, 0.95, 1], nu: 11, bone: fa, mat: 1, col: pal.skin,
      ring: (v) => {
        const z = wr[2] - 0.012 * H + v * (lenF + 0.03 * H);
        let r = lin(0.0118, 0.0172, smooth(0.0, 0.72, v)) * H * limb;
        if (v > 0.86) r = 0.0158 * H * limb * (1 - (v - 0.86) * 4.5);
        if (v === 0) r *= 0.6;
        return { c: [el[0] - 0.002 * H * bump(v, 0.9, 0.1), el[1], z], r1: r * 0.92, r2: r * 1.05 };
      },
    });
  }
}

// ------------------------------------------------------------------ legs and shoes
function buildLegs(g, D, L, pal, J) {
  const H = D.H;
  const limb = D.build.limb;
  const fem = D.fem;
  const shorts = L.legwear === 'shorts';
  for (const [sd, th, sn, ft] of [[1, B.thighL, B.shinL, B.footL], [-1, B.thighR, B.shinR, B.footR]]) {
    const hip = J(th);
    const knee = J(sn);
    const ank = J(ft);
    const lenT = hip[2] - knee[2];
    const hemT = shorts ? 0.38 : -1; // shorts hem at this fraction of the thigh above the knee
    const vsT = shorts ? [0, 0.06, 0.2, 0.38 - 1e-4, 0.38, 0.45, 0.62, 0.8, 0.92, 1] : [0, 0.06, 0.2, 0.4, 0.62, 0.8, 0.92, 1];
    const thighK = (fem ? 1.05 : 1) * (0.6 + 0.4 * D.build.hip) * limb;
    g.tube({
      vs: vsT, nu: 13, bone: th,
      matFn: (u, v) => (shorts && v < hemT ? 1 : 0),
      col: (u, v) => (shorts && v < hemT ? pal.skin : shorts && v < hemT + 0.07 ? mul3(pal.legs, 0.9) : pal.legs),
      ring: (v) => {
        const z = knee[2] - 0.02 * H + v * (lenT + 0.05 * H);
        let r = lin(0.03, 0.047, smooth(0.05, 0.85, v)) * H * thighK;
        if (!shorts || v >= hemT) r += 0.006 * H; // trouser / shorts looseness
        if (v > 0.92) r *= 0.8;
        if (v === 0) r *= 0.6;
        // Inner thigh sits slightly inward at the top (toward the crotch).
        return { c: [hip[0] + 0.003 * H * bump(v, 0.5, 0.3), hip[1] - sd * 0.006 * H * smooth(0.6, 1, v), z], r1: r * 0.98, r2: r };
      },
    });
    // Shin and calf (trousers hang straight; bare legs show the calf).
    const lenS = knee[2] - ank[2];
    const vsS = shorts ? [0, 0.04, 0.1, 0.16 - 1e-4, 0.16, 0.3, 0.55, 0.72, 0.88, 0.95, 1] : [0, 0.05, 0.15, 0.35, 0.6, 0.85, 0.95, 1];
    g.tube({
      vs: vsS, nu: 12, bone: sn,
      matFn: (u, v) => (shorts && v >= 0.16 ? 1 : 0),
      col: (u, v) => (shorts ? (v < 0.16 ? pal.sock : pal.skin) : pal.legs),
      ring: (v) => {
        const z = ank[2] + 0.012 * H + v * (lenS + 0.0 * H);
        let r;
        let dx = 0;
        if (shorts) {
          r = (lin(0.0165, 0.029, smooth(0.15, 0.62, v)) - 0.004 * smooth(0.7, 0.95, v)) * H * limb * (fem ? 0.95 : 1);
          if (v < 0.16) r = 0.019 * H * limb;
          dx = -0.007 * H * bump(v, 0.62, 0.2) * limb; // calf
        } else {
          r = lin(0.031, 0.035, smooth(0, 0.8, v)) * H * (0.75 + 0.25 * limb);
          if (v < 0.05) r *= 1.05; // break over the shoe
        }
        if (v > 0.95) r *= 0.85;
        if (v === 1) r *= 0.7;
        return { c: [ank[0] + dx, ank[1], z], r1: r, r2: r * 0.95 };
      },
    });
    // Knee cap for bare legs (covers the rigid seam at the joint).
    if (shorts) {
      g.ellipsoid([knee[0] + 0.004 * H, knee[1], knee[2]], [0.024 * H * limb, 0.026 * H * limb, 0.03 * H * limb], { nu: 10, nv: 6, bone: sn, mat: 1, col: pal.skin });
    }
    buildShoe(g, D, L, pal, ank, ft, sd);
  }
}

function buildShoe(g, D, L, pal, ank, bone, sd) {
  const H = D.H;
  const f = D.foot;
  const fem = D.fem;
  const len = (f.toe + f.heel) * (fem ? 0.94 : 1) * 1.04;
  const x0 = ank[0] - f.heel * 1.08;
  const w = f.width * (fem ? 0.9 : 1);
  const vs = linspace(0, 1, 11);
  g.tube({
    vs, nu: 12, bone,
    matFn: (u, v) => 5,
    col: (u, v) => {
      // Sole: the lower part of the section.
      if (Math.sin(u) < -0.72) return pal.sole;
      // Saddle detail for two-tone looks.
      if (v > 0.38 && v < 0.6 && Math.sin(u) > -0.5) return mix3(pal.shoe, [0.2, 0.2, 0.2], 0.08);
      return pal.shoe;
    },
    // Tube along +x: frame axes (y, z, x) so the section is in y (width) and z (height).
    frame: [0, 1, 0, 0, 0, 1, 1, 0, 0],
    origin: [0, 0, 0],
    ring: (v) => {
      const x = x0 + v * len;
      // Heel round, widest at the ball of the foot, tapering to a rounded toe.
      const wid = w * (0.72 + 0.28 * Math.sin(Math.min(1, v * 1.25) * Math.PI * 0.75)) * (v > 0.85 ? Math.sqrt(Math.max(0, (1 - v) / 0.15)) : 1);
      const ht = (v < 0.45 ? lin(0.052, 0.046, v / 0.45) : lin(0.046, 0.022, (v - 0.45) / 0.55)) * H * (fem ? 0.93 : 1);
      const cap = v === 0 ? 0.35 : 1;
      const r = Math.max(0.0005, wid * 0.5 * cap * (v === 0 ? 1 : 1));
      // Centre the section so the sole is flat on the ground (z = 0 at rest).
      const zc = ht * 0.5 - 0.004 * H;
      return { c: [ank[1] + sd * 0.002 * H * v, zc, x], r1: r, r2: ht * 0.5 * cap, n: 2.6 };
    },
  });
}

// ------------------------------------------------------------------ hands and club
// Hands are modelled gripping the club, in club space, and carried into their bones' bind space
// through the fixed grip frames (golfer.js gripFrames): v_bind = handRest + Rgrip^T (v_club - wrist).
function buildHandsAndClub(g, D, L, pal, J, spec) {
  const grip = D.grip;
  const hs = grip.scale;
  const fem = D.fem;
  const handK = (fem ? 0.9 : 1) * (0.94 + 0.06 * D.build.limb);
  for (const [which, bone, col, gloved] of [['lead', B.handL, pal.glove, true], ['trail', B.handR, pal.skin, false]]) {
    const fr = grip[which];
    const R = fr.rot;
    // Inverse grip transform: club -> hand local -> bind.
    const rest = J(bone);
    const Rt = [R[0], R[3], R[6], R[1], R[4], R[7], R[2], R[5], R[8]];
    const w = fr.wrist;
    const T = [
      rest[0] - (Rt[0] * w[0] + Rt[3] * w[1] + Rt[6] * w[2]),
      rest[1] - (Rt[1] * w[0] + Rt[4] * w[1] + Rt[7] * w[2]),
      rest[2] - (Rt[2] * w[0] + Rt[5] * w[1] + Rt[8] * w[2]),
    ];
    g.setXform(Rt, T);
    buildHand(g, which, fr, bone, col, gloved, pal, hs * handK);
    g.clearXform();
  }
  // Club: club space -> the club bone's bind space is a translation by its rest origin.
  const cr = J(B.club);
  g.setXform([1, 0, 0, 0, 1, 0, 0, 0, 1], cr);
  buildClub(g, spec);
  g.clearXform();
}

// One gripping hand in club space: a fist round the grip (fingers wrapped toward the golfer), the
// back of the hand and palm rising to the wrist, a thumb down the shaft, a glove cuff.
function buildHand(g, which, fr, bone, col, gloved, pal, s) {
  const lead = which === 'lead';
  const gz = fr.grip[2];
  const R = fr.rot;
  const zH = [R[6], R[7], R[8]]; // toward the elbow
  const back = lead ? [R[3], R[4], R[5]] : [-R[3], -R[4], -R[5]]; // back of the hand
  const w = fr.wrist;
  const mat = gloved ? 0 : 1;
  const knuckle = gloved ? mul3(col, 0.94) : tint3(col, [1.02, 0.95, 0.93]);
  // Fist: an ellipsoid-ish loft along the shaft wrapping the grip, offset toward the palm side.
  const fistLen = 0.056 * s;
  g.tube({
    vs: linspace(0, 1, 7), nu: 12, bone, mat,
    col: (u, v) => (Math.cos(u) * (lead ? 1 : -1) > 0.55 ? knuckle : col),
    ring: (v) => {
      const z = gz - fistLen + v * fistLen * 2;
      const e = (v - 0.5) * 2;
      const k = Math.sqrt(Math.max(0, 1 - Math.pow(Math.abs(e), 2.6)));
      const r = 0.031 * s * (0.45 + 0.55 * k);
      // Fingers wrap round to the golfer's side (+Y club); knuckles on the back-of-hand side.
      return { c: [0.004 * s * (lead ? 1 : -1), 0.006 * s, z], r1: r, r2: r * 0.95 };
    },
  });
  // Back of the hand / palm: from the fist up to the wrist.
  const p0 = [0.003 * s * (lead ? 1 : -1), 0.003 * s, gz + 0.012 * s];
  const p1 = w;
  const ax = norm([p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]]);
  const e2 = norm(cross(ax, back));
  const e1 = cross(e2, ax);
  const frame = [...e1, ...e2, ...ax];
  const L = Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]);
  g.tube({
    vs: linspace(0, 1, 6), nu: 12, bone, mat, frame, origin: p0,
    col: (u, v) => (gloved && v > 0.62 && v < 0.78 && Math.cos(u) > 0.2 ? mul3(col, 0.82) : col),
    ring: (v) => {
      const z = v * (L + 0.022 * s);
      const wide = lin(0.05, 0.03, smooth(0.1, 0.95, v)) * s;
      const thick = lin(0.019, 0.021, v) * s;
      const cap = v === 1 ? 0.55 : 1;
      return { c: [0.004 * s * (1 - v), 0, z], r1: thick * cap, r2: wide * 0.5 * cap };
    },
  });
  // Thumb: along the shaft on the target side of the grip, pointing down.
  const ts = lead ? 1 : -1;
  g.tube({
    vs: linspace(0, 1, 5), nu: 8, bone, mat, col: gloved ? col : tint3(col, [1.0, 0.95, 0.94]),
    ring: (v) => {
      const z = gz + 0.02 * s - v * 0.055 * s;
      const r = 0.012 * s * (v === 1 ? 0.45 : v === 0 ? 0.8 : 1 - 0.15 * v);
      return { c: [ts * 0.012 * s, -0.008 * s, z], r1: r, r2: r * 0.9 };
    },
    flip: true,
  });
  // Glove cuff / wrist.
  g.ellipsoid([w[0], w[1], w[2]], [0.02 * s, 0.024 * s, 0.022 * s], {
    rot: [...e1, ...e2, ...ax], nu: 10, nv: 5, bone, mat, col: gloved ? mul3(col, 0.96) : col,
  });
  void pal;
}

function buildClub(g, spec) {
  const bone = B.club;
  const len = spec.len;
  const butt = spec.butt;
  const head = spec.head;
  const gripLen = 0.26;
  const gripCol = [0.12, 0.12, 0.13];
  const graphite = head === 'driver' || head === 'wood' || head === 'hybrid';
  const shaftCol = graphite ? [0.15, 0.15, 0.17] : [0.78, 0.79, 0.8];
  // Grip with a rounded butt cap and a coloured band.
  g.tube({
    vs: [0, 0.03, 0.08, 0.5, 0.86, 0.9, 0.94, 1], nu: 10, bone, mat: 5,
    col: (u, v) => (v > 0.86 && v < 0.9 ? [0.75, 0.12, 0.1] : gripCol),
    ring: (v) => {
      const z = butt - v * gripLen;
      let r = lin(0.0128, 0.0098, v);
      if (v === 0) r *= 0.2;
      else if (v < 0.05) r *= 0.85;
      return { c: [0, 0, z], r1: r, r2: r };
    },
    flip: true,
  });
  // Shaft: from the grip to the hosel.
  const hoselTop = spec.hosel[2] + (head === 'putter' ? 0.03 : 0.05);
  g.tube({
    vs: [0, 1], nu: 8, bone, mat: graphite ? 4 : 3, col: shaftCol,
    ring: (v) => {
      const z = lin(butt - gripLen + 0.01, hoselTop, v);
      const r = lin(0.0078, graphite ? 0.0058 : 0.0052, v);
      return { c: [0, 0, z], r1: r, r2: r };
    },
    flip: true,
  });
  const hz = spec.hosel;
  const t = spec.toe;
  const u = spec.up;
  const fx = [1, 0, 0];
  if (head === 'iron' || head === 'wedge') buildBlade(g, spec, bone);
  else if (head === 'putter') buildPutter(g, spec, bone);
  else buildWoodHead(g, spec, bone);
  // Hosel: a short tapered cylinder along the shaft into the heel.
  if (head !== 'putter') {
    g.tube({
      vs: [0, 0.15, 1], nu: 8, bone, mat: head === 'iron' || head === 'wedge' ? 3 : 4,
      col: head === 'iron' || head === 'wedge' ? [0.8, 0.8, 0.82] : [0.1, 0.1, 0.11],
      ring: (v) => {
        const z = lin(hz[2] + 0.012, hoselTop + 0.002, v);
        const r = lin(head === 'driver' ? 0.0085 : 0.0075, 0.0062, v) * (v === 0 ? 0.6 : 1);
        return { c: [0, 0, z], r1: r, r2: r };
      },
    });
  }
  void t;
  void u;
  void fx;
}

// Iron / wedge: a lofted blade slab with a thicker sole, rounded toe.
function buildBlade(g, spec, bone) {
  const d = spec.dims;
  const wedge = spec.head === 'wedge';
  const lo = spec.loft;
  const t = spec.toe;
  const u = spec.up;
  // Face plane axes: a = toe direction, b = up the face (leaning back by the loft).
  const a = t;
  const b = [-Math.sin(lo), u[1] * Math.cos(lo), u[2] * Math.cos(lo)];
  const L = d.length;
  const Ht = d.height;
  const outline = [];
  // Counter-clockwise in (a, b): heel bottom -> sole -> toe -> top line -> back to the heel.
  const n = 22;
  for (let k = 0; k <= 8; k++) outline.push([0.006 + (k / 8) * (L - 0.016), 0.001 + 0.002 * Math.sin((k / 8) * Math.PI)]);
  for (let k = 1; k <= 8; k++) {
    const ang = -Math.PI / 2 + (k / 8) * Math.PI * 0.95;
    const rx = 0.014;
    const ry = Ht * 0.5;
    outline.push([L - 0.012 + Math.cos(ang) * rx, ry + Math.sin(ang) * ry]);
  }
  for (let k = 1; k <= 5; k++) {
    const f = k / 5;
    outline.push([lin(L - 0.018, 0.012, f), lin(Ht * 0.98, Ht * (wedge ? 0.6 : 0.55), Math.pow(f, 0.9))]);
  }
  outline.push([0.004, Ht * 0.4], [0.001, Ht * 0.2]);
  void n;
  const origin = [spec.dims.prog + 0.001, spec.hosel[1], spec.hosel[2]];
  const chrome = [0.82, 0.83, 0.85];
  const sole = wedge ? 0.022 : 0.016;
  g.slab({
    outline, origin, a, b, n: spec.faceN, bone, mat: 3,
    col: chrome, colBack: [0.7, 0.71, 0.74],
    depth: (p) => lin(sole, 0.006, Math.min(1, p[1] / (Ht * 0.85))) * (p[0] < 0.01 ? 0.8 : 1),
  });
  // Grooves: a few fine dark lines on the face.
  for (let k = 0; k < 7; k++) {
    const yb = 0.008 + k * 0.0045;
    if (yb > Ht * 0.75) break;
    const x0 = 0.016;
    const x1 = L - 0.022;
    const q = (x, y) => [origin[0] + a[0] * x + b[0] * y + 0.0004, origin[1] + a[1] * x + b[1] * y, origin[2] + a[2] * x + b[2] * y];
    const fn = spec.faceN;
    const i0 = g.count;
    for (const [x, y] of [[x0, yb], [x1, yb], [x1, yb + 0.0011], [x0, yb + 0.0011]]) g._vert(q(x, y), fn, [0.35, 0.36, 0.38], bone, 3);
    g.I.push(i0, i0 + 1, i0 + 2, i0, i0 + 2, i0 + 3);
  }
}

// Driver, fairway wood, hybrid: a rounded superellipsoid head with a flat lofted face.
function buildWoodHead(g, spec, bone) {
  const d = spec.dims;
  const t = spec.toe;
  const u = spec.up;
  const f = [1, 0, 0];
  const bk = [-1, 0, 0];
  const lo = spec.loft;
  const fn = spec.faceN;
  const hx = spec.hosel;
  // Head centre: half a length toward the toe, half a depth back, half a height up.
  const cL = d.length * 0.5;
  const cD = d.depth * 0.5 - d.prog;
  const cH = d.height * 0.5;
  const C = [hx[0] + t[0] * cL + bk[0] * cD + u[0] * cH, hx[1] + t[1] * cL + bk[1] * cD + u[1] * cH, hx[2] + t[2] * cL + bk[2] * cD + u[2] * cH];
  const crown = spec.head === 'driver' ? [0.07, 0.08, 0.1] : spec.head === 'wood' ? [0.1, 0.1, 0.11] : [0.16, 0.16, 0.17];
  const faceC = spec.head === 'driver' ? [0.55, 0.56, 0.58] : [0.5, 0.5, 0.52];
  // Face plane point: the sweet spot.
  const sp = spec.sweet;
  const us = ring(18, 0);
  const vs = linspace(-Math.PI / 2, Math.PI / 2, 9);
  g.grid({
    us, vs, bone, mat: 4, flip: true,
    pos: (a, e) => {
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const ce = Math.cos(e);
      const se = Math.sin(e);
      const pe = (x, n) => Math.sign(x) * Math.pow(Math.abs(x), 2 / n);
      // Plan: toe axis (sa), face axis (ca); front flatter, back rounder.
      const ext = ca > 0 ? 3.2 : 2.3;
      const px = pe(ca, ext) * (ca > 0 ? d.depth * 0.5 : d.depth * 0.5) * pe(ce, 2.4);
      const py = pe(sa, 2.6) * d.length * 0.5 * pe(ce, 2.4);
      // Lower crown at the back.
      const hh = d.height * 0.5 * (1 - 0.25 * Math.max(0, -ca));
      const pz = pe(se, se > 0 ? 2.2 : 3.5) * hh;
      let p = [C[0] + f[0] * px + t[0] * py + u[0] * pz, C[1] + f[1] * px + t[1] * py + u[1] * pz, C[2] + f[2] * px + t[2] * py + u[2] * pz];
      // Flatten onto the lofted face plane.
      const dd = (p[0] - sp[0]) * fn[0] + (p[1] - sp[1]) * fn[1] + (p[2] - sp[2]) * fn[2];
      if (dd > 0) p = [p[0] - fn[0] * dd, p[1] - fn[1] * dd, p[2] - fn[2] * dd];
      return p;
    },
    col: (a, e, j, i, p) => {
      const dd = (p[0] - sp[0]) * fn[0] + (p[1] - sp[1]) * fn[1] + (p[2] - sp[2]) * fn[2];
      if (dd > -0.0015 && Math.cos(a) > 0.2) return faceC;
      if (Math.sin(e) < -0.5) return [0.45, 0.46, 0.48]; // sole plate
      // Alignment mark on the crown.
      if (Math.sin(e) > 0.6 && Math.abs(Math.sin(a)) < 0.06 && Math.cos(a) > 0) return [0.8, 0.8, 0.8];
      return crown;
    },
  });
  void lo;
}

// Putter: a classic heel-toe blade with a plumber's neck.
function buildPutter(g, spec, bone) {
  const d = spec.dims;
  const t = spec.toe;
  const u = spec.up;
  const hx = spec.hosel;
  const C = [hx[0] - d.depth * 0.5 + 0.004, hx[1] + t[1] * d.length * 0.45 + u[1] * d.height * 0.5, hx[2] + t[2] * d.length * 0.45 + u[2] * d.height * 0.5];
  const sat = [0.62, 0.63, 0.66];
  g.grid({
    us: ring(16, 0), vs: linspace(-Math.PI / 2, Math.PI / 2, 7), bone, mat: 3, flip: true,
    pos: (a, e) => {
      const pe = (x, n) => Math.sign(x) * Math.pow(Math.abs(x), 2 / n);
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const ce = Math.cos(e);
      const se = Math.sin(e);
      const px = pe(ca, 6) * d.depth * 0.5 * pe(ce, 6);
      const py = pe(sa, 6) * d.length * 0.5 * pe(ce, 6);
      const pz = pe(se, 6) * d.height * 0.5;
      return [C[0] + px + t[0] * 0 + 0, C[1] + t[1] * py + u[1] * pz, C[2] + t[2] * py + u[2] * pz];
    },
    col: (a, e) => (Math.sin(e) > 0.85 && Math.abs(Math.sin(a)) < 0.12 ? [0.95, 0.95, 0.95] : sat),
  });
  // Plumber's neck: a short bent tube from the shaft end into the heel.
  const top = [0, 0, hx[2] + 0.03];
  const heel = [C[0] + 0.004, hx[1] + t[1] * 0.012 + u[1] * d.height, hx[2] + t[2] * 0.012 + u[2] * d.height];
  g.tube({
    vs: [0, 0.5, 1], nu: 8, bone, mat: 3, col: sat,
    ring: (v) => {
      const z = lin(top[2], heel[2], v);
      const r = 0.0055 * (v === 1 ? 0.8 : 1);
      return { c: [lin(top[0], heel[0], smooth(0.4, 1, v)), lin(top[1], heel[1], smooth(0.3, 1, v)), z], r1: r, r2: r };
    },
    flip: true,
  });
}

function norm(a) {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}
function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
