// Geometry builders for the renderer. Pure: every function returns typed arrays and never touches
// WebGL or the DOM, so the meshes are unit-tested in node and kept as CPU copies for context restore.
//
// Conventions: world axes +x east, +y north, +z up. Indexed meshes use Uint16 indices (each mesh or
// terrain chunk stays below 65536 vertices so WebGL1 without OES_element_index_uint works).
// "Camera-relative" arrays are positions with the eye already subtracted (built per frame).

import { FLAGSTICK_H } from './constants.js';

// Terrain chunk size in grid cells. 128 cells -> 129^2 = 16641 vertices per chunk (fits Uint16) and
// a 128 m square at the 1 m grid, small enough for useful frustum culling, large enough that the
// biggest hole (about 540 x 180 m) needs at most 10 chunks of the 25 draw-call budget.
export const TERRAIN_CHUNK = 128;

// ---------------------------------------------------------------------------------------------
// Terrain

// Split the 1 m height grid into chunks. stride > 1 decimates (quality 'low' uses 2).
// Each chunk: {ox, oy, pos (xyz relative to (ox, oy, 0)), nrm, idx (Uint16), minX..maxZ (world)}.
// Normals come from central differences on the full-resolution grid so chunk seams light identically.
export function terrainChunks(grid, { chunk = TERRAIN_CHUNK, stride = 1 } = {}) {
  const { nx, ny, minX, minY, step, heights } = grid;
  const H = (i, j) => heights[Math.min(ny - 1, Math.max(0, j)) * nx + Math.min(nx - 1, Math.max(0, i))];
  const span = chunk * stride; // grid nodes covered per chunk side
  const chunks = [];
  for (let j0 = 0; j0 < ny - 1; j0 += span) {
    for (let i0 = 0; i0 < nx - 1; i0 += span) {
      const i1 = Math.min(nx - 1, i0 + span);
      const j1 = Math.min(ny - 1, j0 + span);
      // Node lists along each axis (always include the last node so chunks meet exactly).
      const is = [];
      for (let i = i0; i < i1; i += stride) is.push(i);
      is.push(i1);
      const js = [];
      for (let j = j0; j < j1; j += stride) js.push(j);
      js.push(j1);
      const cw = is.length;
      const ch = js.length;
      const ox = minX + i0 * step;
      const oy = minY + j0 * step;
      const pos = new Float32Array(cw * ch * 3);
      const nrm = new Float32Array(cw * ch * 3);
      let minZ = Infinity;
      let maxZ = -Infinity;
      let k = 0;
      for (const j of js) {
        for (const i of is) {
          const z = H(i, j);
          pos[k] = (i - i0) * step;
          pos[k + 1] = (j - j0) * step;
          pos[k + 2] = z;
          // n = normalize(-dz/dx, -dz/dy, 1)
          const gx = (H(i + 1, j) - H(i - 1, j)) / (2 * step);
          const gy = (H(i, j + 1) - H(i, j - 1)) / (2 * step);
          const il = 1 / Math.sqrt(gx * gx + gy * gy + 1);
          nrm[k] = -gx * il;
          nrm[k + 1] = -gy * il;
          nrm[k + 2] = il;
          if (z < minZ) minZ = z;
          if (z > maxZ) maxZ = z;
          k += 3;
        }
      }
      const idx = new Uint16Array((cw - 1) * (ch - 1) * 6);
      k = 0;
      for (let b = 0; b < ch - 1; b++) {
        for (let a = 0; a < cw - 1; a++) {
          const v0 = b * cw + a;
          const v1 = v0 + 1;
          const v2 = v0 + cw;
          const v3 = v2 + 1;
          // Alternate the diagonal for a less directional look on slopes.
          if ((a + b) & 1) {
            idx[k++] = v0; idx[k++] = v1; idx[k++] = v3;
            idx[k++] = v0; idx[k++] = v3; idx[k++] = v2;
          } else {
            idx[k++] = v0; idx[k++] = v1; idx[k++] = v2;
            idx[k++] = v1; idx[k++] = v3; idx[k++] = v2;
          }
        }
      }
      chunks.push({
        ox, oy, pos, nrm, idx, vertCount: cw * ch,
        minX: ox, minY: oy, maxX: minX + i1 * step, maxY: minY + j1 * step, minZ, maxZ,
      });
    }
  }
  return chunks;
}

// Skirt ring from the edge of the height grid out to `outer` metres from the hole centre, so the
// course sits in a continuous landscape that dissolves into fog. Positions relative to (cx, cy, 0).
// Rings: grid edge (exact heights) -> +60 m (gently rolling, fbm-free sines) -> outer (low hills).
export function skirtMesh(grid, { outer = 4000, every = 8 } = {}) {
  const { nx, ny, minX, minY, step, heights } = grid;
  const maxX = minX + (nx - 1) * step;
  const maxY = minY + (ny - 1) * step;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  // Perimeter nodes counter-clockwise.
  const per = [];
  const push = (i, j) => per.push([i, j]);
  for (let i = 0; i < nx - 1; i += every) push(i, 0);
  for (let j = 0; j < ny - 1; j += every) push(nx - 1, j);
  for (let i = nx - 1; i > 0; i -= every) push(i, ny - 1);
  for (let j = ny - 1; j > 0; j -= every) push(0, j);
  const n = per.length;
  let avg = 0;
  for (const [i, j] of per) avg += heights[j * nx + i];
  avg /= n;
  const RINGS = 4;
  const pos = new Float32Array(n * RINGS * 3);
  const nrm = new Float32Array(n * RINGS * 3);
  for (let k = 0; k < n; k++) {
    const [i, j] = per[k];
    const x = minX + i * step;
    const y = minY + j * step;
    const z = heights[j * nx + i];
    let dx = x - cx;
    let dy = y - cy;
    const l = Math.hypot(dx, dy) || 1;
    dx /= l;
    dy /= l;
    const az = Math.atan2(dy, dx);
    const roll = 3 * Math.sin(az * 5 + 1.3) + 2 * Math.sin(az * 11 + 0.4);
    const ring = [
      [x, y, z],
      [x + dx * 60, y + dy * 60, z + (avg - z) * 0.4 + roll * 0.5],
      [x + dx * 400, y + dy * 400, avg + roll * 1.5 + 8],
      [cx + dx * outer, cy + dy * outer, avg + 70 + roll * 10],
    ];
    for (let r = 0; r < RINGS; r++) {
      const o = (r * n + k) * 3;
      pos[o] = ring[r][0] - cx;
      pos[o + 1] = ring[r][1] - cy;
      pos[o + 2] = ring[r][2];
      // The skirt is lit as flat ground; nrm.x carries a 0..1 "distance from the course" factor
      // the terrain shader uses to blend rough into woodland.
      nrm[o] = [0, 0.6, 1, 1][r];
      nrm[o + 2] = 1;
    }
  }
  const idx = new Uint16Array(n * (RINGS - 1) * 6);
  let q = 0;
  for (let r = 0; r < RINGS - 1; r++) {
    for (let k = 0; k < n; k++) {
      const a = r * n + k;
      const b = r * n + ((k + 1) % n);
      const c = a + n;
      const d = b + n;
      // CCW seen from above (perimeter runs counter-clockwise, rings go outward).
      idx[q++] = a; idx[q++] = d; idx[q++] = b;
      idx[q++] = a; idx[q++] = c; idx[q++] = d;
    }
  }
  return { cx, cy, pos, nrm, idx, n };
}

// Background tree line on the first skirt band (grid edge -> +60 m), so the course is framed by
// woodland instead of ending at the height grid. Returns instance rows in the renderer's tree layout
// [x, y, z, canopyCentreHeight, rx, rz, trunkR, seed] (world coordinates), split by kind.
export function skirtTrees(skirt, { perVertex = 1.3, seed = 99 } = {}) {
  let st = seed >>> 0;
  const rnd = () => {
    st = (st + 0x6d2b79f5) >>> 0;
    let t = st;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const { pos, n, cx, cy } = skirt;
  const V = (r, k) => {
    const o = (r * n + (k % n)) * 3;
    return [pos[o], pos[o + 1], pos[o + 2]];
  };
  const pines = [];
  const broads = [];
  for (let k = 0; k < n; k++) {
    const cnt = Math.floor(perVertex + rnd());
    for (let m = 0; m < cnt; m++) {
      const a = 0.12 + rnd() * 0.88; // outward fraction across the band
      const b = rnd(); // along the perimeter
      const p00 = V(0, k);
      const p01 = V(0, k + 1);
      const p10 = V(1, k);
      const p11 = V(1, k + 1);
      const lerp = (i) => (p00[i] * (1 - b) + p01[i] * b) * (1 - a) + (p10[i] * (1 - b) + p11[i] * b) * a;
      const x = lerp(0) + cx;
      const y = lerp(1) + cy;
      const z = lerp(2) - 0.5; // sink slightly: the band is planar between ring vertices
      const pine = rnd() < 0.5;
      const rx = pine ? 2.2 + rnd() * 1.4 : 3.6 + rnd() * 2.6;
      const rz = pine ? 5.5 + rnd() * 3 : 3.6 + rnd() * 2;
      const trunkH = pine ? 2.6 + rnd() * 1.6 : 2.8 + rnd() * 1.4;
      const row = [x, y, z, trunkH + rz * 0.8, rx, rz, pine ? 0.25 : 0.32, rnd()];
      (pine ? pines : broads).push(...row);
    }
  }
  return { pines, broads };
}

// ---------------------------------------------------------------------------------------------
// Icosphere (unit radius). Vertex count = 10*4^subdiv + 2.

export function icosphere(subdiv = 2) {
  const t = (1 + Math.sqrt(5)) / 2;
  let verts = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ].map(([x, y, z]) => {
    const l = Math.hypot(x, y, z);
    return [x / l, y / l, z / l];
  });
  let faces = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  for (let s = 0; s < subdiv; s++) {
    const cache = new Map();
    const mid = (a, b) => {
      const key = a < b ? a * 65536 + b : b * 65536 + a;
      let m = cache.get(key);
      if (m === undefined) {
        const p = verts[a];
        const q = verts[b];
        const x = p[0] + q[0];
        const y = p[1] + q[1];
        const z = p[2] + q[2];
        const l = Math.hypot(x, y, z);
        m = verts.length;
        verts.push([x / l, y / l, z / l]);
        cache.set(key, m);
      }
      return m;
    };
    const nf = [];
    for (const [a, b, c] of faces) {
      const ab = mid(a, b);
      const bc = mid(b, c);
      const ca = mid(c, a);
      nf.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    faces = nf;
  }
  const pos = new Float32Array(verts.length * 3);
  verts.forEach((v, i) => pos.set(v, i * 3));
  const idx = new Uint16Array(faces.length * 3);
  faces.forEach((f, i) => idx.set(f, i * 3));
  verts = null;
  return { pos, nrm: pos.slice(), idx };
}

// ---------------------------------------------------------------------------------------------
// Generic coloured mesh builder for props (stakes, tee markers, cup). Positions are world or local
// depending on the caller; colours are linear-ish albedo rgb.

export class MeshBuilder {
  constructor() {
    this.p = [];
    this.n = [];
    this.c = [];
    this.i = [];
  }
  get vertCount() {
    return this.p.length / 3;
  }
  vert(x, y, z, nx, ny, nz, col) {
    this.p.push(x, y, z);
    this.n.push(nx, ny, nz);
    this.c.push(col[0], col[1], col[2]);
    return this.p.length / 3 - 1;
  }
  // Vertical cylinder (open bottom, flat cap) from base (x,y,z) of radius r0 at the bottom, r1 at the top.
  cylinder(x, y, z, r0, r1, h, col, segs = 8, cap = true) {
    const b = this.vertCount;
    for (let s = 0; s <= segs; s++) {
      const a = (s / segs) * Math.PI * 2;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      this.vert(x + ca * r0, y + sa * r0, z, ca, sa, 0, col);
      this.vert(x + ca * r1, y + sa * r1, z + h, ca, sa, 0, col);
    }
    for (let s = 0; s < segs; s++) {
      const v = b + s * 2;
      this.i.push(v, v + 2, v + 1, v + 1, v + 2, v + 3);
    }
    if (cap) {
      const c = this.vert(x, y, z + h, 0, 0, 1, col);
      const r = this.vertCount;
      for (let s = 0; s <= segs; s++) {
        const a = (s / segs) * Math.PI * 2;
        this.vert(x + Math.cos(a) * r1, y + Math.sin(a) * r1, z + h, 0, 0, 1, col);
      }
      for (let s = 0; s < segs; s++) this.i.push(c, r + s, r + s + 1);
    }
  }
  // Sphere (icosphere subdiv 1) of radius r at (x, y, z).
  sphere(x, y, z, r, col, subdiv = 1) {
    const ico = icosphere(subdiv);
    const b = this.vertCount;
    for (let k = 0; k < ico.pos.length; k += 3) {
      this.vert(x + ico.pos[k] * r, y + ico.pos[k + 1] * r, z + ico.pos[k + 2] * r, ico.pos[k], ico.pos[k + 1], ico.pos[k + 2], col);
    }
    for (const v of ico.idx) this.i.push(b + v);
  }
  // Flat annulus (r0..r1) following the ground: heightFn(x, y) gives z; lifted by `lift` metres.
  disc(x, y, r0, r1, col, heightFn, lift = 0.004, segs = 20) {
    const b = this.vertCount;
    for (let s = 0; s <= segs; s++) {
      const a = (s / segs) * Math.PI * 2;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      for (const r of [r0, r1]) {
        const px = x + ca * r;
        const py = y + sa * r;
        this.vert(px, py, heightFn(px, py) + lift, 0, 0, 1, col);
      }
    }
    for (let s = 0; s < segs; s++) {
      const v = b + s * 2;
      this.i.push(v, v + 1, v + 2, v + 1, v + 3, v + 2); // CCW from above
    }
  }
  build() {
    return {
      pos: new Float32Array(this.p),
      nrm: new Float32Array(this.n),
      col: new Float32Array(this.c),
      idx: new Uint16Array(this.i),
    };
  }
}

// ---------------------------------------------------------------------------------------------
// Trees. Unit meshes with a per-vertex attribute {part, shade}: part 0 = trunk (x,y in trunk radii,
// z in 0..1 of the trunk height), part 1 = canopy (x,y in canopy radii, z in -1..1 of the canopy
// half-height around the canopy centre). shade is a baked ambient-occlusion term (0 dark .. 1 lit).
// The tree vertex shader scales them per instance from terrain.trees {trunkR, trunkH, canopy}.

function treeBuilder() {
  const p = [];
  const n = [];
  const a = [];
  const i = [];
  return {
    p, n, a, i,
    v(x, y, z, nx, ny, nz, part, shade) {
      p.push(x, y, z);
      const l = Math.hypot(nx, ny, nz) || 1;
      n.push(nx / l, ny / l, nz / l);
      a.push(part, shade);
      return p.length / 3 - 1;
    },
    trunk(segs = 6) {
      const b = p.length / 3;
      for (let s = 0; s <= segs; s++) {
        const ang = (s / segs) * Math.PI * 2;
        const c = Math.cos(ang);
        const sn = Math.sin(ang);
        this.v(c, sn, 0, c, sn, 0, 0, 0.55);
        this.v(c * 0.6, sn * 0.6, 1, c, sn, 0.2, 0, 0.75);
      }
      for (let s = 0; s < segs; s++) {
        const v = b + s * 2;
        i.push(v, v + 2, v + 1, v + 1, v + 2, v + 3);
      }
    },
    build() {
      return { pos: new Float32Array(p), nrm: new Float32Array(n), attr: new Float32Array(a), idx: new Uint16Array(i) };
    },
  };
}

// Conifer: four stacked, jagged cones from z = -1 (canopy bottom) to the tip at z = 1.
export function pineMesh() {
  const B = treeBuilder();
  B.trunk();
  const tiers = [
    [-1.0, 0.95, 1.0],
    [-0.5, 0.78, 0.85],
    [0.0, 0.58, 0.7],
    [0.42, 0.38, 0.58],
  ];
  const segs = 10;
  tiers.forEach(([z0, r, h], t) => {
    const tip = B.v(0, 0, z0 + h, 0, 0, 1, 1, 1);
    const ring = p0(segs, (s) => {
      const ang = (s / segs) * Math.PI * 2 + t * 0.7;
      const jag = s % 2 ? 0.78 : 1.05; // jagged needle clumps
      const c = Math.cos(ang);
      const sn = Math.sin(ang);
      // Cone side normal tilted up; drooping tier edge slightly below z0.
      return B.v(c * r * jag, sn * r * jag, z0 - 0.06 * jag, c * h, sn * h, r * 0.9, 1, 0.45 + 0.25 * t / 3);
    });
    for (let s = 0; s < segs; s++) B.i.push(ring[s], ring[(s + 1) % segs], tip);
    // Underside (shadowed) disc toward the trunk.
    const under = B.v(0, 0, z0 + 0.12, 0, 0, -1, 1, 0.2);
    for (let s = 0; s < segs; s++) B.i.push(ring[(s + 1) % segs], ring[s], under);
  });
  return B.build();
}

function p0(n, f) {
  const out = [];
  for (let s = 0; s < n; s++) out.push(f(s));
  return out;
}

// Broadleaf: a cluster of lumpy spheres filling the unit canopy ellipsoid, plus the trunk.
export function broadleafMesh() {
  const B = treeBuilder();
  B.trunk();
  const ico = icosphere(1);
  const blobs = [
    [0, 0, 0.15, 0.78],
    [0.45, 0.1, -0.2, 0.55],
    [-0.4, 0.3, -0.15, 0.55],
    [0.05, -0.48, -0.25, 0.52],
    [-0.15, 0.05, 0.55, 0.5],
    [0.3, -0.2, 0.35, 0.45],
  ];
  blobs.forEach(([bx, by, bz, br], k) => {
    const b = B.p.length / 3;
    for (let q = 0; q < ico.pos.length; q += 3) {
      const nx = ico.pos[q];
      const ny = ico.pos[q + 1];
      const nz = ico.pos[q + 2];
      // Deterministic lumpiness so the silhouette is not a perfect sphere.
      const lump = 1 + 0.12 * Math.sin(nx * 7 + k) * Math.cos(ny * 6 - k) + 0.08 * Math.sin(nz * 9 + k * 2);
      const x = bx + nx * br * lump;
      const y = by + ny * br * lump;
      const z = bz + nz * br * lump;
      // Normal: mostly the blob normal, bent toward the whole-canopy normal for soft lighting.
      const gx = x * 0.6 + nx;
      const gy = y * 0.6 + ny;
      const gz = z * 0.6 + nz;
      const shade = 0.35 + 0.65 * Math.min(1, Math.max(0, 0.5 + 0.5 * z + 0.25 * Math.hypot(x, y)));
      B.v(x, y, z, gx, gy, gz, 1, shade);
    }
    for (let q = 0; q < ico.idx.length; q++) B.i.push(b + ico.idx[q]);
  });
  return B.build();
}

// ---------------------------------------------------------------------------------------------
// Flagstick + cloth. attr = {part, u, v}: part 0 = pole (x,y unit radius, z metres), part 1 = cloth
// (u along the flag 0..1 away from the pole, v 0..1 bottom to top; the shader places and waves it).

export function flagMesh({ segs = 6, cu = 10, cv = 5 } = {}) {
  const p = [];
  const n = [];
  const a = [];
  const i = [];
  const v = (x, y, z, nx, ny, nz, part, u, w) => {
    p.push(x, y, z);
    n.push(nx, ny, nz);
    a.push(part, u, w);
    return p.length / 3 - 1;
  };
  // Pole, 0 .. FLAGSTICK_H, with alternating colour bands done in the shader from z.
  for (let s = 0; s <= segs; s++) {
    const ang = (s / segs) * Math.PI * 2;
    const c = Math.cos(ang);
    const sn = Math.sin(ang);
    v(c, sn, 0, c, sn, 0, 0, 0, 0);
    v(c, sn, FLAGSTICK_H, c, sn, 0, 0, 0, 1);
  }
  for (let s = 0; s < segs; s++) {
    const q = s * 2;
    i.push(q, q + 2, q + 1, q + 1, q + 2, q + 3);
  }
  const b = p.length / 3;
  for (let jv = 0; jv <= cv; jv++) {
    for (let ju = 0; ju <= cu; ju++) v(0, 0, 0, 0, 1, 0, 1, ju / cu, jv / cv);
  }
  for (let jv = 0; jv < cv; jv++) {
    for (let ju = 0; ju < cu; ju++) {
      const q = b + jv * (cu + 1) + ju;
      i.push(q, q + 1, q + cu + 1, q + 1, q + cu + 2, q + cu + 1);
    }
  }
  return { pos: new Float32Array(p), nrm: new Float32Array(n), attr: new Float32Array(a), idx: new Uint16Array(i) };
}

// ---------------------------------------------------------------------------------------------
// Water: polygons -> flat triangles at each water level. The outline is pushed out by `pad` metres so
// the shoreline is where the rising bank intersects the plane (no gap, no z-fight at the edge).

export function polyArea(poly) {
  let a = 0;
  for (let k = 0; k < poly.length; k++) {
    const p = poly[k];
    const q = poly[(k + 1) % poly.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

export function offsetPoly(poly, d) {
  const ccw = polyArea(poly) > 0 ? 1 : -1;
  const n = poly.length;
  const out = [];
  for (let k = 0; k < n; k++) {
    const a = poly[(k + n - 1) % n];
    const b = poly[k];
    const c = poly[(k + 1) % n];
    // Outward normals of the two adjacent edges (for CCW polygons the outward normal is (dy, -dx)).
    let e1x = b.x - a.x;
    let e1y = b.y - a.y;
    let l = Math.hypot(e1x, e1y) || 1;
    e1x /= l;
    e1y /= l;
    let e2x = c.x - b.x;
    let e2y = c.y - b.y;
    l = Math.hypot(e2x, e2y) || 1;
    e2x /= l;
    e2y /= l;
    let nx = (e1y + e2y) * ccw;
    let ny = -(e1x + e2x) * ccw;
    l = Math.hypot(nx, ny) || 1;
    nx /= l;
    ny /= l;
    out.push({ x: b.x + nx * d, y: b.y + ny * d });
  }
  return out;
}

// Ear-clipping triangulation of a simple polygon ([{x,y}]). Returns an array of vertex indices.
export function triangulate(poly) {
  const n = poly.length;
  if (n < 3) return [];
  const ccw = polyArea(poly) > 0;
  const V = [];
  for (let k = 0; k < n; k++) V.push(ccw ? k : n - 1 - k);
  const out = [];
  const cross = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const inside = (p, a, b, c) => cross(a, b, p) >= 0 && cross(b, c, p) >= 0 && cross(c, a, p) >= 0;
  let guard = n * n;
  while (V.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let k = 0; k < V.length; k++) {
      const ia = V[(k + V.length - 1) % V.length];
      const ib = V[k];
      const ic = V[(k + 1) % V.length];
      const a = poly[ia];
      const b = poly[ib];
      const c = poly[ic];
      if (cross(a, b, c) <= 1e-9) continue; // reflex
      let ear = true;
      for (const j of V) {
        if (j === ia || j === ib || j === ic) continue;
        if (inside(poly[j], a, b, c)) {
          ear = false;
          break;
        }
      }
      if (!ear) continue;
      out.push(ia, ib, ic);
      V.splice(k, 1);
      clipped = true;
      break;
    }
    if (!clipped) break; // degenerate input: give up gracefully
  }
  if (V.length === 3) out.push(V[0], V[1], V[2]);
  return out;
}

// All water bodies in one mesh: pos (world xyz), idx.
export function waterMesh(waters, pad = 1.6) {
  const p = [];
  const i = [];
  for (const w of waters || []) {
    if (!w.poly || w.poly.length < 3) continue;
    const poly = offsetPoly(w.poly, pad);
    const b = p.length / 3;
    for (const q of poly) p.push(q.x, q.y, w.level);
    for (const t of triangulate(poly)) i.push(b + t);
  }
  return { pos: new Float32Array(p), idx: new Uint16Array(i) };
}

// ---------------------------------------------------------------------------------------------
// Green-read overlay: a draped grid over the green (plus `pad` metres). Per vertex: pos (relative to
// the green centre), grad (dz/dx, dz/dy) and mask (1 on the green fading to 0 at the pad edge).
// Layout: [x, y, z, gx, gy, mask] * N, Uint16 indices.

export function greenReadMesh(terrain, { pad = 3, res = 0.5 } = {}) {
  const g = terrain.green;
  if (!g) return null;
  const c = Math.cos(g.rot || 0);
  const s = Math.sin(g.rot || 0);
  const ex = g.rx + pad;
  const ey = g.ry + pad;
  const nu = Math.ceil((2 * ex) / res) + 1;
  const nv = Math.ceil((2 * ey) / res) + 1;
  const data = new Float32Array(nu * nv * 6);
  const gr = { x: 0, y: 0 };
  let k = 0;
  for (let jv = 0; jv < nv; jv++) {
    for (let ju = 0; ju < nu; ju++) {
      const lu = -ex + (ju / (nu - 1)) * 2 * ex;
      const lv = -ey + (jv / (nv - 1)) * 2 * ey;
      const x = g.cx + lu * c - lv * s;
      const y = g.cy + lu * s + lv * c;
      const z = terrain.heightAt(x, y) + 0.025;
      terrain.gradAt(x, y, gr);
      // Approximate signed distance outside the ellipse in metres.
      const q = Math.hypot(lu / g.rx, lv / g.ry);
      const sd = (q - 1) * Math.min(g.rx, g.ry);
      const mask = Math.max(0, Math.min(1, 1 - sd / pad));
      data[k++] = x - g.cx;
      data[k++] = y - g.cy;
      data[k++] = z;
      data[k++] = gr.x;
      data[k++] = gr.y;
      data[k++] = mask;
    }
  }
  const idx = new Uint16Array((nu - 1) * (nv - 1) * 6);
  k = 0;
  for (let jv = 0; jv < nv - 1; jv++) {
    for (let ju = 0; ju < nu - 1; ju++) {
      const q = jv * nu + ju;
      idx[k++] = q; idx[k++] = q + 1; idx[k++] = q + nu;
      idx[k++] = q + 1; idx[k++] = q + nu + 1; idx[k++] = q + nu;
    }
  }
  return { cx: g.cx, cy: g.cy, data, idx, nu, nv };
}

// ---------------------------------------------------------------------------------------------
// Per-frame ribbons, camera-relative. Layout [x, y, z, u, v, a] * N drawn as a TRIANGLE_STRIP:
// u runs along the ribbon (metres), v is -1/+1 across it, a is an alpha multiplier.

// Shot trail: a camera-facing ribbon through points data=[x,y,z]*count. Width grows with distance so
// the tracer stays at least ~minPx wide (pxPerRad = viewport px per radian of view angle).
export function trailRibbon(data, count, eye, out, { width = 0.07, pxPerRad = 900, minPx = 2.2, maxPts = 400 } = {}) {
  const n = Math.min(count, data.length / 3 | 0);
  if (n < 2) return 0;
  const stepK = Math.max(1, Math.ceil(n / maxPts));
  const pts = [];
  for (let k = 0; k < n; k += stepK) pts.push(k);
  if (pts[pts.length - 1] !== n - 1) pts.push(n - 1);
  const m = pts.length;
  if (out.length < m * 12) return -m * 12; // caller must grow the buffer
  let u = 0;
  let px = data[pts[0] * 3];
  let py = data[pts[0] * 3 + 1];
  let pz = data[pts[0] * 3 + 2];
  let o = 0;
  for (let q = 0; q < m; q++) {
    const k = pts[q];
    const x = data[k * 3];
    const y = data[k * 3 + 1];
    const z = data[k * 3 + 2];
    const kn = pts[Math.min(m - 1, q + 1)];
    const kp = pts[Math.max(0, q - 1)];
    const tx = data[kn * 3] - data[kp * 3];
    const ty = data[kn * 3 + 1] - data[kp * 3 + 1];
    const tz = data[kn * 3 + 2] - data[kp * 3 + 2];
    u += Math.hypot(x - px, y - py, z - pz);
    px = x;
    py = y;
    pz = z;
    const rx = x - eye.x;
    const ry = y - eye.y;
    const rz = z - eye.z;
    const d = Math.hypot(rx, ry, rz) || 1;
    // side = tangent x viewDir
    let sx = ty * rz - tz * ry;
    let sy = tz * rx - tx * rz;
    let sz = tx * ry - ty * rx;
    const sl = Math.hypot(sx, sy, sz) || 1;
    const w = Math.max(width, (minPx / pxPerRad) * d) * 0.5;
    sx = (sx / sl) * w;
    sy = (sy / sl) * w;
    sz = (sz / sl) * w;
    // Fade in from the ball's start and toward the current head slightly.
    const a = Math.min(1, (q + 1) / 6) * (0.55 + 0.45 * (q / (m - 1)));
    out[o++] = rx - sx; out[o++] = ry - sy; out[o++] = rz - sz; out[o++] = u; out[o++] = -1; out[o++] = a;
    out[o++] = rx + sx; out[o++] = ry + sy; out[o++] = rz + sz; out[o++] = u; out[o++] = 1; out[o++] = a;
  }
  return m * 2;
}

// Aim line: a flat ribbon draped on the ground from the ball along aim.yaw for aim.carry metres,
// followed by a landing ring. Returns the strip vertex count; the ring is a separate strip appended
// after a degenerate join so a single draw call renders both. Optional aim.ring (m) sets the ring
// radius (default max(1.6, 3.5% of carry); a putt uses a small one) and aim.width (m) the minimum
// half-width of the line (default 0.06), aim.lift (m) its height above the turf (default 0.06) and
// aim.dash (m) the dash period (default 2.4, the shader's).
export function aimRibbon(terrain, aim, eye, out, { pxPerRad = 900, minPx = 2.5 } = {}) {
  const carry = Math.max(aim.ring != null ? 0.3 : 1, aim.carry || 0);
  const minW = aim.width || 0.06;
  const lift = aim.lift != null ? aim.lift : 0.06;
  const fade = Math.min(2.5, carry * 0.3); // the line fades in from the ball over this many metres
  const uScale = aim.dash ? 2.4 / aim.dash : 1;
  const dx = Math.cos(aim.yaw);
  const dy = Math.sin(aim.yaw);
  const steps = Math.min(160, Math.max(8, Math.ceil(carry / 1.5)));
  let o = 0;
  const put = (x, y, z, u, v, a) => {
    out[o++] = x - eye.x; out[o++] = y - eye.y; out[o++] = z - eye.z; out[o++] = u; out[o++] = v; out[o++] = a;
  };
  const halfW = (x, y, z) => {
    const d = Math.hypot(x - eye.x, y - eye.y, z - eye.z);
    return Math.max(minW, (minPx / pxPerRad) * d * 0.5);
  };
  const H = (x, y) => terrain.heightAt(x, y) + lift;
  for (let k = 0; k <= steps; k++) {
    const t = (k / steps) * carry;
    const x = aim.x + dx * t;
    const y = aim.y + dy * t;
    const z = H(x, y);
    const w = halfW(x, y, z);
    const a = Math.min(1, t / fade) * (k === steps ? 0.9 : 1);
    put(x + dy * w, y - dx * w, z, t * uScale, -1, a);
    put(x - dy * w, y + dx * w, z, t * uScale, 1, a);
  }
  // Landing ring (u < 0 marks ring vertices so the shader draws it solid instead of dashed).
  const cx = aim.x + dx * carry;
  const cy = aim.y + dy * carry;
  const R = aim.ring != null ? aim.ring : Math.max(1.6, carry * 0.035);
  const cz = H(cx, cy);
  const rw = halfW(cx, cy, cz) * 1.2;
  const segs = 36;
  // Degenerate join: repeat last vertex and first ring vertex.
  const last = o - 6;
  for (let q = 0; q < 6; q++) out[o + q] = out[last + q];
  o += 6;
  const ring = (s, r) => {
    const ang = (s / segs) * Math.PI * 2;
    const x = cx + Math.cos(ang) * r;
    const y = cy + Math.sin(ang) * r;
    return [x, y, H(x, y)];
  };
  {
    const [x, y, z] = ring(0, R - rw);
    put(x, y, z, -1, -1, 0.9);
  }
  for (let s = 0; s <= segs; s++) {
    const [x0, y0, z0] = ring(s, R - rw);
    const [x1, y1, z1] = ring(s, R + rw);
    put(x0, y0, z0, -1, -1, 0.9);
    put(x1, y1, z1, -1, 1, 0.9);
  }
  return o / 6;
}
