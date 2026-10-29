// Geometry and matrix tests for the renderer's pure modules (meshes.js, mat4.js, bake.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  terrainChunks, skirtMesh, icosphere, pineMesh, broadleafMesh, flagMesh, waterMesh, triangulate,
  greenReadMesh, trailRibbon, aimRibbon, skirtTrees, MeshBuilder, TERRAIN_CHUNK, palmMesh, saguaroMesh,
  bushMesh, rockMesh, grassMesh, skirtObjects, seaSetup,
} from '../src/meshes.js';
import { perspective, lookAt, multiply, invert, project, unproject, transformPoint } from '../src/mat4.js';
import { bakeTerrainColor, bakeClouds, bakeNoise, boxBlur, bakeWaterDepth, WATER_DEPTH_MAX } from '../src/bake.js';
import { THEMES, themeFor } from '../src/themes.js';
import { SURF } from '../src/constants.js';
import { courseById } from '../src/courses.js';
import { buildHole } from '../src/terrain.js';
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

// ------------------------------------------------------------------ version 2: course themes

const hole = (id, n) => {
  const c = courseById(id);
  return buildHole(c.holes[n - 1], { pinIndex: 0, seed: 1, course: c });
};

// Sum of |xy area| of the triangles of an indexed mesh (pos may be offset; only xy is used).
function xyArea(pos, idx) {
  let a = 0;
  for (let k = 0; k < idx.length; k += 3) {
    const [p, q, r] = [idx[k] * 3, idx[k + 1] * 3, idx[k + 2] * 3];
    a += Math.abs((pos[q] - pos[p]) * (pos[r + 1] - pos[p + 1]) - (pos[q + 1] - pos[p + 1]) * (pos[r] - pos[p])) / 2;
  }
  return a;
}

test('themed object meshes: well formed, 4-wide attributes, within the triangle budget', () => {
  const budget = { palm: 420, saguaro: 600, bush: 420, rock: 100, grass: 60 };
  const meshes = { palm: palmMesh(), saguaro: saguaroMesh(), bush: bushMesh(), rock: rockMesh(), grass: grassMesh() };
  for (const [k, m] of Object.entries(meshes)) {
    const n = m.pos.length / 3;
    assert.equal(m.nrm.length, n * 3, k);
    assert.equal(m.attr.length, n * 4, k);
    for (const v of m.idx) assert.ok(v < n, k);
    assert.ok(unitNormals(m.nrm, 1e-3), k);
    assert.ok(Array.from(m.pos).every(Number.isFinite) && Array.from(m.attr).every(Number.isFinite), k);
    assert.ok(m.idx.length / 3 <= budget[k], `${k}: ${m.idx.length / 3} triangles`);
  }
  // Palm: trunk 0..1 high, fronds (part 1) and dead fronds (part 2), u 0..1 along, v -1..1 across.
  const pa = meshes.palm.attr;
  const parts = new Set();
  for (let k = 0; k < pa.length; k += 4) {
    parts.add(pa[k]);
    if (pa[k] > 0) assert.ok(pa[k + 2] >= 0 && pa[k + 2] <= 1 && Math.abs(pa[k + 3]) <= 1);
  }
  assert.deepEqual([...parts].sort(), [0, 1, 2]);
  // Saguaro: column z in 0..2 (dome above 1), four arms with ids 1..4.
  const sa = meshes.saguaro;
  const arms = new Set();
  for (let k = 0; k < sa.attr.length; k += 4) {
    if (sa.attr[k] === 0) assert.ok(sa.pos[(k / 4) * 3 + 2] >= 0 && sa.pos[(k / 4) * 3 + 2] <= 2);
    else arms.add(sa.attr[k + 3]);
  }
  assert.deepEqual([...arms].sort(), [1, 2, 3, 4]);
  // Rock: flat shaded (every triangle has its own three vertices).
  assert.equal(meshes.rock.idx.length, meshes.rock.pos.length / 3);
  // Bush and rock stay inside their unit boxes (the shader scales them by rx / rz).
  for (const m of [meshes.bush, meshes.rock]) {
    for (let k = 0; k < m.pos.length; k += 3) assert.ok(Math.hypot(m.pos[k], m.pos[k + 1]) < 1.4 && Math.abs(m.pos[k + 2]) < 1.4);
  }
});

test('dense skirt edge meets the grid at every node; same rings and coverage', () => {
  const a = skirtMesh(T.grid);
  const b = skirtMesh(T.grid, { dense: true });
  const n = a.n;
  assert.equal(b.n, n);
  // The 4 x n ring vertices are unchanged (skirt objects index them).
  assert.deepEqual(Array.from(b.pos.subarray(0, n * 12)), Array.from(a.pos));
  const nv = b.pos.length / 3;
  assert.ok(nv < 65536);
  for (const v of b.idx) assert.ok(v < nv);
  // The extra vertices are grid nodes with their exact heights, one per perimeter node.
  const g = T.grid;
  assert.equal(nv - n * 4, 2 * (g.nx - 1) + 2 * (g.ny - 1) - n);
  for (let v = n * 4; v < nv; v++) {
    const i = Math.round((b.pos[v * 3] + b.cx - g.minX) / g.step);
    const j = Math.round((b.pos[v * 3 + 1] + b.cy - g.minY) / g.step);
    assert.ok(i === 0 || j === 0 || i === g.nx - 1 || j === g.ny - 1);
    assert.equal(b.pos[v * 3 + 2], g.heights[j * g.nx + i]);
  }
  // Same footprint (the fans re-triangulate the first band only).
  assert.ok(Math.abs(xyArea(a.pos, a.idx) - xyArea(b.pos, b.idx)) < 1e-6 * xyArea(a.pos, a.idx));
});

test('sea setup: none on parkland, all round on an island, toward the sea water otherwise', () => {
  assert.equal(seaSetup(T, THEMES.parkland), null);
  const island = hole('water', 3);
  const s3 = seaSetup(island, themeFor(island.theme));
  assert.ok(s3.full && s3.cosHalf < -1);
  assert.equal(s3.level, island.waters.find((w) => w.fill === 'outside').level);
  const links = hole('links', 1);
  const s1 = seaSetup(links, themeFor(links.theme));
  const sw = links.waters.find((w) => w.sea);
  assert.ok(!s1.full && s1.level === sw.level);
  const cx = (s1.rect.minX + s1.rect.maxX) / 2;
  const cy = (s1.rect.minY + s1.rect.maxY) / 2;
  const mx = sw.poly.reduce((t, q) => t + q.x, 0) / sw.poly.length;
  const my = sw.poly.reduce((t, q) => t + q.y, 0) / sw.poly.length;
  assert.ok((mx - cx) * s1.dir.x + (my - cy) * s1.dir.y > 0);
  assert.ok(Math.abs(Math.hypot(s1.dir.x, s1.dir.y) - 1) < 1e-9);
  // An ocean theme without sea water still has a sea, below the whole grid edge.
  const l2 = hole('links', 2);
  const s2 = seaSetup(l2, themeFor(l2.theme));
  const g = l2.grid;
  let lo = Infinity;
  for (let i = 0; i < g.nx; i++) lo = Math.min(lo, g.heights[i], g.heights[(g.ny - 1) * g.nx + i]);
  for (let j = 0; j < g.ny; j++) lo = Math.min(lo, g.heights[j * g.nx], g.heights[j * g.nx + g.nx - 1]);
  assert.ok(Math.abs(s2.level - (lo - 1.5)) < 1e-6);
  // A desert hole has no sea.
  const d1 = hole('desert', 1);
  assert.equal(seaSetup(d1, themeFor(d1.theme)), null);
});

test('skirt toward the sea drops below it; landward it stays above', () => {
  const t = hole('links', 2);
  const sea = seaSetup(t, themeFor(t.theme));
  const sk = skirtMesh(t.grid, { sea, dense: true });
  const n = sk.n;
  let seaward = 0;
  let landward = 0;
  for (let k = 0; k < n; k++) {
    const x = sk.pos[k * 3];
    const y = sk.pos[k * 3 + 1];
    const c = (x * sea.dir.x + y * sea.dir.y) / (Math.hypot(x, y) || 1);
    const z2 = sk.pos[(2 * n + k) * 3 + 2];
    if (c > sea.cosHalf + 0.4) {
      assert.ok(z2 < sea.level - 10, 'seaward ring 2 under the sea');
      assert.ok(sk.nrm[(n + k) * 3 + 1] > 0.5, 'seaward weight in nrm.y');
      seaward++;
    } else if (c < sea.cosHalf - 0.4) {
      for (let r = 1; r < 4; r++) assert.ok(sk.pos[(r * n + k) * 3 + 2] >= sea.level + 0.8 - 1e-4, 'landward above the sea');
      landward++;
    }
  }
  assert.ok(seaward > 5 && landward > 5);
});

test('water mesh with the sea: hole water clipped to the grid, the sea on the skirt with its depth', () => {
  const t = hole('links', 1);
  const sea = seaSetup(t, themeFor(t.theme));
  const sk = skirtMesh(t.grid, { sea, dense: true });
  const w = waterMesh(t.waters, 1.6, { sea, skirt: sk });
  const nv = w.pos.length / 3;
  assert.equal(w.water.length, nv * 2);
  assert.ok(nv < 65536);
  for (const v of w.idx) assert.ok(v < nv);
  const nSk = sk.pos.length / 3;
  const first = nv - nSk - sk.n; // the hole's own water comes first
  for (let v = 0; v < first; v++) {
    assert.equal(w.water[v * 2 + 1], -1000);
    const x = w.pos[v * 3];
    const y = w.pos[v * 3 + 1];
    if (w.water[v * 2] === 1) assert.ok(x >= sea.rect.minX && x <= sea.rect.maxX && y >= sea.rect.minY && y <= sea.rect.maxY);
  }
  for (let k = 0; k < nSk; k++) {
    const v = first + k;
    assert.equal(w.water[v * 2], 1);
    assert.ok(Math.abs(w.water[v * 2 + 1] - (sea.level - sk.pos[k * 3 + 2])) < 1e-3);
    assert.ok(Math.abs(w.pos[v * 3 + 2] - sea.level) < 1e-3);
  }
  // Without a sea the layout is the shipped one plus the flags (all 0, texture depth).
  const p = waterMesh(T.waters);
  assert.ok(Array.from(p.water).every((x, k) => (k % 2 ? x === -1000 : x === 0)));
  // An island hole: the flood plane stays (clipped to the grid), the sea ring joins it.
  const isl = hole('water', 3);
  const s3 = seaSetup(isl, themeFor(isl.theme));
  const w3 = waterMesh(isl.waters, 1.6, { sea: s3, skirt: skirtMesh(isl.grid, { sea: s3, dense: true }) });
  assert.ok(w3.water.length / 2 > 4);
});

test('skirt objects: themed kinds in the instance layout, none in the sea', () => {
  const t = hole('water', 9);
  const th = themeFor(t.theme);
  const sea = seaSetup(t, th);
  const sk = skirtMesh(t.grid, { sea, dense: true });
  const bg = skirtObjects(sk, { kinds: th.skirtObjects.kinds, perVertex: 1.5, grass: 1, minZ: sea.level + 0.6 });
  let count = 0;
  for (const [kind, rows] of Object.entries(bg.rows)) {
    assert.ok(kind in th.skirtObjects.kinds);
    assert.equal(rows.length % 8, 0);
    for (let k = 0; k < rows.length; k += 8) {
      assert.ok(rows[k + 2] + 0.3 >= sea.level + 0.6 - 1e-6);
      assert.ok(rows[k + 7] >= 0 && rows[k + 7] < 1);
      count++;
    }
  }
  assert.ok(count > 50);
  assert.equal(bg.grass.length % 8, 0);
  // Deterministic.
  assert.deepEqual(skirtObjects(sk, { kinds: { rock: 1 }, perVertex: 0.5 }), skirtObjects(sk, { kinds: { rock: 1 }, perVertex: 0.5 }));
});

test('themed bakes: parkland is the shipped bake; new surfaces carry detail; pot faces are sod', () => {
  // Parkland (the default for a terrain without a theme) is exactly the version 1 bake.
  const a = bakeTerrainColor(T);
  const b = bakeTerrainColor(T, { theme: THEMES.parkland });
  assert.deepEqual(a.data, b.data);
  assert.equal(a.detail, null);
  // Hollow Pines' own bunkers never read as revetted faces.
  const p1 = hole('pines', 1);
  assert.equal(bakeTerrainColor(p1).detail, null);
  // Desert: the desert channel where the surface is desert.
  const d = hole('desert', 2);
  const bd = bakeTerrainColor(d);
  assert.ok(bd.detail);
  const sg = d.sgrid;
  let hit = 0;
  let tested = 0;
  for (let k = 0; k < sg.data.length; k += 97) {
    if (sg.data[k] !== SURF.DESERT) continue;
    tested++;
    if (bd.detail.data[k * 4] > 200) hit++;
  }
  assert.ok(tested > 50 && hit / tested > 0.9);
  // Links: fescue channel, and revetted faces (alpha) next to pot bunkers only.
  const l = hole('links', 2);
  const bl = bakeTerrainColor(l);
  let sod = 0;
  const lg = l.sgrid;
  for (let k = 0; k < lg.data.length; k++) {
    if (bl.detail.data[k * 4 + 3] > 64) {
      sod++;
      const i = k % lg.nx;
      const j = Math.floor(k / lg.nx);
      let near = false;
      for (let dj = -6; dj <= 6 && !near; dj++) {
        for (let di = -6; di <= 6; di++) {
          const q = (j + dj) * lg.nx + i + di;
          if (q >= 0 && q < lg.data.length && lg.data[q] === SURF.BUNKER) near = true;
        }
      }
      assert.ok(near, 'sod face away from a bunker');
    }
  }
  assert.ok(sod > 10);
  // The theme's colours reach the bake: a links fairway is yellower than Hollow Pines'.
  const texel = (bk, t, surf) => {
    for (let k = 0; k < t.sgrid.data.length; k += 13) if (t.sgrid.data[k] === surf) return Array.from(bk.data.subarray(k * 4, k * 4 + 3));
    return null;
  };
  const fwL = texel(bl, l, SURF.FAIRWAY);
  const fwP = texel(bakeTerrainColor(p1), p1, SURF.FAIRWAY);
  assert.ok(fwL[0] / fwL[1] > fwP[0] / fwP[1]);
});

test('water depth bake: depth in the water, distance to the shore', () => {
  const dp = bakeWaterDepth(T);
  const g = T.grid;
  assert.equal(dp.width, g.nx);
  assert.equal(dp.data.length, g.nx * g.ny * 4);
  const at = (x, y) => {
    const i = Math.round((x - g.minX) / g.step);
    const j = Math.round((y - g.minY) / g.step);
    return Array.from(dp.data.subarray((j * g.nx + i) * 4, (j * g.nx + i) * 4 + 2));
  };
  // Pond centre (-30, 150), radius 15, level -0.6: deep and far from the shore; dry ground 0.
  const c = at(-30, 150);
  const edge = at(-30 + 13, 150);
  assert.ok(c[0] > 0 && Math.abs(c[0] / 255 * WATER_DEPTH_MAX - (-0.6 - T.heightAt(-30, 150))) < 0.05);
  assert.ok(c[1] > edge[1] && c[1] >= 12 && c[1] <= 17);
  assert.deepEqual(at(0, 0), [0, 0]);
  // The ocean flood of an island hole: deepest far from the islands.
  const isl = hole('water', 3);
  const di = bakeWaterDepth(isl);
  let maxD = 0;
  for (let k = 1; k < di.data.length; k += 4) maxD = Math.max(maxD, di.data[k]);
  assert.ok(maxD > 20);
});

test('themes carry everything the renderer reads', () => {
  const kinds = ['pine', 'broad', 'palm', 'saguaro', 'shrub', 'gorse', 'rock', 'grass'];
  const rgb = (a) => Array.isArray(a) && a.length === 3 && a.every((v) => v >= 0 && v <= 1.3);
  for (const th of Object.values(THEMES)) {
    assert.ok(th.clouds && th.clouds.cover > 0, th.id);
    assert.ok(rgb(th.ridges.far) && rgb(th.ridges.near) && rgb(th.skirt.near) && rgb(th.skirt.far), th.id);
    assert.equal((th.skirt.detail || [0, 0, 0, 0]).length, 4);
    for (const k of kinds) assert.ok(rgb(th.tints[k]), `${th.id} ${k}`);
    assert.ok(rgb(th.trunks.palm) && rgb(th.trunks.saguaro) && rgb(th.revet), th.id);
    assert.ok(th.water.tint === null || rgb(th.water.tint), th.id);
    assert.ok(th.water.clarity > 0 && th.water.haze > 0 && th.water.haze <= 1, th.id);
    assert.ok(th.horizon !== 'ocean' || ['hills', 'mountains', 'mesas', 'dunes'].includes(th.land), th.id);
    assert.ok(Array.isArray(th.seaAz) && th.seaAz.length > 0, th.id);
    if (th.skirtObjects) for (const k of Object.keys(th.skirtObjects.kinds)) assert.ok(kinds.includes(k), `${th.id} ${k}`);
  }
  // Parkland keeps the shipped look: shipped skirt colours, tree tints, no objects of its own.
  const P = THEMES.parkland;
  assert.deepEqual(P.skirt.near, [0.21, 0.37, 0.13]);
  assert.deepEqual(P.skirt.far, [0.12, 0.22, 0.09]);
  assert.deepEqual(P.tints.pine, [0.11, 0.2, 0.11]);
  assert.deepEqual(P.tints.broad, [0.19, 0.3, 0.12]);
  assert.deepEqual(P.ridges.far, [0.06, 0.1, 0.13]);
  assert.deepEqual(P.ridges.near, [0.025, 0.05, 0.025]);
  assert.deepEqual(P.clouds, { cover: 1, shift: 0, grey: 0 });
  assert.equal(P.skirtObjects, null);
  assert.equal(P.water.tint, null);
  assert.ok(!P.fog.highClear);
});

test('pathRibbon: a dotted strip through draped points, u in strip widths, with an end ring', async () => {
  const { pathRibbon } = await import('../src/meshes.js');
  const pts = new Float32Array([0, 0, 0, 1, 0, 0, 2, 0.1, 0, 3, 0.3, 0]);
  const out = new Float32Array(2000);
  const eye = { x: -3, y: 0, z: 1.5 };
  const n = pathRibbon(pts, 4, eye, out, { width: 0.04, minPx: 1, pxPerRad: 1000 });
  assert.equal(n, 8);
  // u grows along the strip in units of the width (0.04 m wide: 1 m = 25 widths).
  assert.ok(Math.abs(out[1 * 6 + 3] - 0) < 1e-6 && Math.abs(out[3 * 6 + 3] - 25) < 1e-3);
  assert.equal(out[4], -1);
  assert.equal(out[10], 1);
  const nr = pathRibbon(pts, 4, eye, out, { width: 0.04, ring: true, ringR: 0.1 });
  assert.equal(nr, 8 + 2 + 33 * 2);
  for (let k = 0; k < nr * 6; k++) assert.ok(Number.isFinite(out[k]));
  assert.ok(out[(nr - 1) * 6 + 3] < 0, 'ring vertices have u < 0');
  assert.equal(pathRibbon(pts, 4, eye, new Float32Array(10)), 0, 'too small a buffer draws nothing');
  assert.equal(pathRibbon(pts, 1, eye, out), 0);
});
