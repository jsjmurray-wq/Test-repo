// Geometry and matrix tests for the renderer's pure modules (meshes.js, mat4.js, bake.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  terrainChunks, skirtMesh, icosphere, pineMesh, broadleafMesh, flagMesh, waterMesh, triangulate,
  greenReadMesh, trailRibbon, aimRibbon, skirtTrees, MeshBuilder, TERRAIN_CHUNK,
} from '../src/meshes.js';
import { perspective, lookAt, multiply, invert, project, unproject, transformPoint } from '../src/mat4.js';
import { bakeTerrainColor, bakeClouds, bakeNoise, boxBlur } from '../src/bake.js';
import { stubTerrain } from './visual/render-preview.js';

const T = stubTerrain();

function unitNormals(nrm, tol = 1e-4) {
  for (let k = 0; k < nrm.length; k += 3) {
    const l = Math.hypot(nrm[k], nrm[k + 1], nrm[k + 2]);
    if (Math.abs(l - 1) > tol) return false;
  }
  return true;
}

test('mat4: project/unproject round trip', () => {
  const proj = perspective(1.0, 393 / 852, 0.2, 6000);
  const view = lookAt({ x: 3, y: -4, z: 2 }, { x: 10, y: 40, z: 0.5 }, { x: 0, y: 0, z: 1 });
  const vp = multiply(proj, view);
  const inv = invert(vp);
  assert.ok(inv);
  for (const p of [{ x: 10, y: 40, z: 0.5 }, { x: 0, y: 20, z: 3 }, { x: 25, y: 120, z: -2 }, { x: 4, y: 0.5, z: 1.8 }]) {
    const s = project(vp, p, 393, 852);
    assert.ok(s.w > 0);
    const q = unproject(inv, s.sx, s.sy, s.z, 393, 852);
    const err = Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z);
    assert.ok(err < 1e-3 * Math.max(1, Math.hypot(p.x - 3, p.y + 4, p.z - 2)), `round trip error ${err}`);
  }
  // The look-at target projects to the screen centre.
  const c = project(vp, { x: 10, y: 40, z: 0.5 }, 393, 852);
  assert.ok(Math.abs(c.sx - 196.5) < 1e-3 && Math.abs(c.sy - 426) < 1e-3 && c.visible);
  // A point behind the camera is not visible.
  assert.equal(project(vp, { x: 2, y: -30, z: 2 }, 393, 852).visible, false);
  // M * M^-1 = I
  const I = multiply(vp, inv);
  for (let k = 0; k < 16; k++) assert.ok(Math.abs(I[k] - (k % 5 === 0 ? 1 : 0)) < 1e-4);
  // lookAt never produces NaN when looking straight down along up.
  const down = lookAt({ x: 0, y: 0, z: 100 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
  assert.ok(Array.from(down).every(Number.isFinite));
  assert.deepEqual(transformPoint(invert(perspective(1, 1, 1, 10)), { x: 0, y: 0, z: -1 }).z.toFixed(4), '-1.0000');
});

test('terrain chunks: Uint16-safe, cover the grid, unit normals', () => {
  for (const stride of [1, 2]) {
    const chunks = terrainChunks(T.grid, { stride });
    assert.ok(chunks.length >= 1);
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const ch of chunks) {
      assert.ok(ch.idx instanceof Uint16Array);
      assert.ok(ch.vertCount <= 65536, `chunk has ${ch.vertCount} vertices`);
      assert.equal(ch.pos.length, ch.vertCount * 3);
      let mx = 0;
      for (const v of ch.idx) mx = Math.max(mx, v);
      assert.ok(mx < ch.vertCount);
      assert.equal(ch.idx.length % 3, 0);
      assert.ok(unitNormals(ch.nrm));
      maxX = Math.max(maxX, ch.maxX);
      maxY = Math.max(maxY, ch.maxY);
    }
    assert.equal(maxX, T.grid.minX + (T.grid.nx - 1) * T.grid.step);
    assert.equal(maxY, T.grid.minY + (T.grid.ny - 1) * T.grid.step);
  }
  // Positions are chunk-local and heights match the grid exactly.
  const ch = terrainChunks(T.grid)[0];
  assert.equal(ch.pos[2], T.grid.heights[0]);
  assert.equal(TERRAIN_CHUNK + 1 <= 256, true);
});

test('largest real-course-sized grid stays within the draw budget', () => {
  const nx = 540;
  const ny = 620;
  const grid = { nx, ny, minX: 0, minY: 0, step: 1, heights: new Float32Array(nx * ny) };
  const chunks = terrainChunks(grid);
  assert.ok(chunks.length <= 25);
  for (const c of chunks) assert.ok(c.vertCount <= 65536);
});

test('icosphere vertex and face counts', () => {
  for (let s = 0; s <= 3; s++) {
    const m = icosphere(s);
    assert.equal(m.pos.length / 3, 10 * 4 ** s + 2);
    assert.equal(m.idx.length / 3, 20 * 4 ** s);
    assert.ok(unitNormals(m.nrm));
  }
});

test('tree, flag, prop meshes are well formed', () => {
  for (const m of [pineMesh(), broadleafMesh(), flagMesh()]) {
    const n = m.pos.length / 3;
    assert.ok(n < 65536);
    for (const v of m.idx) assert.ok(v < n);
    assert.ok(unitNormals(m.nrm, 1e-3));
  }
  const mb = new MeshBuilder();
  mb.cylinder(0, 0, 0, 0.1, 0.1, 1, [1, 1, 1]);
  mb.sphere(1, 1, 1, 0.2, [1, 0, 0]);
  mb.disc(0, 0, 0, 0.05, [0, 0, 0], () => 0);
  const p = mb.build();
  assert.equal(p.col.length, p.pos.length);
  assert.ok(unitNormals(p.nrm, 1e-3));
});

test('skirt and background trees', () => {
  const sk = skirtMesh(T.grid);
  const n = sk.pos.length / 3;
  assert.ok(n < 65536);
  for (const v of sk.idx) assert.ok(v < n);
  const bg = skirtTrees(sk);
  assert.equal(bg.pines.length % 8, 0);
  assert.ok(bg.pines.length + bg.broads.length > 0);
});

test('water triangulation covers the polygon area', () => {
  const sq = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 5, y: 4 }, { x: 0, y: 10 }];
  const tri = triangulate(sq);
  assert.equal(tri.length, 9);
  let area = 0;
  for (let k = 0; k < tri.length; k += 3) {
    const [a, b, c] = [sq[tri[k]], sq[tri[k + 1]], sq[tri[k + 2]]];
    area += ((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) / 2;
  }
  assert.ok(Math.abs(area - 70) < 1e-9); // 100 - the notch (10 * 6 / 2)
  const w = waterMesh(T.waters);
  assert.ok(w.idx.length >= 3 * (T.waters[0].poly.length - 2));
  for (let k = 2; k < w.pos.length; k += 3) assert.equal(w.pos[k], Math.fround(T.waters[0].level));
});

test('green-read mesh, ribbons', () => {
  const r = greenReadMesh(T);
  assert.ok(r.data.length / 6 < 65536);
  const out = new Float32Array(400 * 12 + 24);
  const data = new Float32Array([0, 0, 1, 10, 50, 20, 20, 100, 30, 30, 150, 10, 35, 190, 0]);
  const n = trailRibbon(data, 5, { x: 0, y: -5, z: 2 }, out);
  assert.equal(n, 10);
  assert.ok(Array.from(out.subarray(0, n * 6)).every(Number.isFinite));
  const aim = new Float32Array(4096);
  const m = aimRibbon(T, { x: 0, y: 0, z: 0.6, yaw: Math.PI / 2, carry: 230 }, { x: 0, y: -3, z: 2.3 }, aim);
  assert.ok(m > 10 && m * 6 <= aim.length);
  assert.ok(Array.from(aim.subarray(0, m * 6)).every(Number.isFinite));
});

test('bakes: sizes, ranges, determinism', () => {
  const b = bakeTerrainColor(T);
  assert.equal(b.width, T.sgrid.nx);
  assert.equal(b.height, T.sgrid.ny);
  assert.equal(b.data.length, b.width * b.height * 4);
  // Green texel carries the crosshatch mask, rough none.
  const texel = (x, y) => {
    const i = Math.floor((x - b.minX) / b.step);
    const j = Math.floor((y - b.minY) / b.step);
    return Array.from(b.data.subarray((j * b.width + i) * 4, (j * b.width + i) * 4 + 4));
  };
  assert.equal(texel(T.green.cx, T.green.cy)[3], 255);
  assert.ok(texel(-60, 100)[3] < 40);
  // Sand is lighter than rough.
  const sand = texel(15, 279);
  const rough = texel(-60, 100);
  assert.ok(sand[0] + sand[1] + sand[2] > rough[0] + rough[1] + rough[2]);
  const c1 = bakeClouds(5, 32);
  const c2 = bakeClouds(5, 32);
  assert.deepEqual(c1.data, c2.data);
  assert.equal(bakeNoise(1, 16).data.length, 16 * 16 * 4);
  const bl = boxBlur(new Float32Array([0, 0, 9, 0, 0]), 5, 1, 1);
  assert.ok(Math.abs(bl[2] - 3) < 1e-6 && Math.abs(bl[1] - 3) < 1e-6 && bl[0] === 0);
});
