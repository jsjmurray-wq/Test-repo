import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hash2, valueNoise2, fbm2 } from '../src/noise.js';
import { buildPath } from '../src/spline.js';
import { buildHole, makeProfile } from '../src/terrain.js';
import { COURSE } from '../src/course.js';
import { SURF } from '../src/constants.js';
import { mulberry32 } from '../src/rng.js';

const hole1 = buildHole(COURSE.holes[0], { pinIndex: 0, seed: 1 });
const hole3 = buildHole(COURSE.holes[2], { pinIndex: 0, seed: 1 });

test('noise is deterministic and in range', () => {
  assert.equal(hash2(3, -7, 11), hash2(3, -7, 11));
  assert.notEqual(hash2(3, -7, 11), hash2(3, -7, 12));
  const r = mulberry32(5);
  for (let i = 0; i < 2000; i++) {
    const x = (r() - 0.5) * 1000;
    const y = (r() - 0.5) * 1000;
    const v = valueNoise2(x, y, 3);
    const f = fbm2(x, y, { oct: 5, seed: 9 });
    assert.ok(v >= 0 && v < 1 && f >= 0 && f < 1);
  }
  // Continuity of value noise across lattice lines.
  assert.ok(Math.abs(valueNoise2(2 - 1e-7, 0.3) - valueNoise2(2 + 1e-7, 0.3)) < 1e-5);
});

test('spline: length, lateral sign and end extension', () => {
  const p = buildPath([[0, 0], [0, 50], [0, 100]]);
  assert.ok(Math.abs(p.length - 100) < 0.01);
  const pr = p.project(3, 40); // facing +y, right is +x
  assert.ok(Math.abs(pr.s - 40) < 1e-6 && Math.abs(pr.lat - 3) < 1e-6);
  assert.ok(p.project(-2, 40).lat < 0);
  const behind = p.project(1, -10);
  assert.ok(Math.abs(behind.s + 10) < 1e-6 && Math.abs(behind.lat - 1) < 1e-6);
  const past = p.project(0, 120);
  assert.ok(Math.abs(past.s - 120) < 1e-6);
  const q = p.pointAt(-5);
  assert.ok(Math.abs(q.y + 5) < 1e-9);
});

test('spline: projection is accurate on doglegs', () => {
  for (const def of [COURSE.holes[0], COURSE.holes[2], COURSE.holes[4]]) {
    const p = buildPath(def.path);
    const r = mulberry32(def.n);
    for (let i = 0; i < 400; i++) {
      const s = 2 + r() * (p.length - 4);
      const lat = (r() * 2 - 1) * 30;
      const c = p.pointAt(s);
      const t = p.tangentAt(s);
      const x = c.x + t.y * lat;
      const y = c.y - t.x * lat;
      const pr = p.project(x, y);
      assert.ok(Math.abs(pr.s - s) < 0.4, `s ${pr.s} vs ${s}`);
      assert.ok(Math.abs(pr.lat - lat) < 0.05, `lat ${pr.lat} vs ${lat}`);
    }
  }
});

test('elevation profile is monotone between keys', () => {
  const f = makeProfile([[0, 0], [100, 5], [200, 5], [300, 0]]);
  assert.equal(f(-10), 0);
  assert.equal(f(400), 0);
  let prev = -Infinity;
  for (let s = 0; s <= 100; s += 1) {
    assert.ok(f(s) >= prev - 1e-9);
    prev = f(s);
  }
  for (let s = 100; s <= 200; s += 5) assert.ok(Math.abs(f(s) - 5) < 1e-9);
});

// A discontinuity shows as a change over a 0.1 m step that the local slope cannot explain.
function checkContinuity(t, seed) {
  const r = mulberry32(seed);
  const { minX, minY, maxX, maxY } = t.bounds;
  const g = { x: 0, y: 0 };
  let worst = 0;
  for (let line = 0; line < 60; line++) {
    let x = minX + r() * (maxX - minX);
    let y = minY + r() * (maxY - minY);
    const a = r() * Math.PI * 2;
    const dx = Math.cos(a) * 0.1;
    const dy = Math.sin(a) * 0.1;
    let h = t.heightAt(x, y);
    for (let k = 0; k < 400; k++) {
      const h1 = t.heightAt(x + dx, y + dy);
      t.gradAt(x, y, g);
      const s0 = Math.hypot(g.x, g.y);
      t.gradAt(x + dx, y + dy, g);
      const s1 = Math.hypot(g.x, g.y);
      const jump = Math.abs(h1 - h) - 0.1 * Math.max(s0, s1);
      if (jump > worst) worst = jump;
      x += dx;
      y += dy;
      h = h1;
    }
  }
  return worst;
}

test('heightAt is continuous (no jumps > 2 cm at 0.1 m steps)', () => {
  assert.ok(checkContinuity(hole1, 1) < 0.02);
  assert.ok(checkContinuity(hole3, 2) < 0.02);
  // On the green the surface is gentle, so even the raw step is tiny.
  const gc = hole3.greenCenter;
  for (let k = -80; k < 80; k++) {
    const a = hole3.heightAt(gc.x + k * 0.1, gc.y + 3);
    const b = hole3.heightAt(gc.x + (k + 1) * 0.1, gc.y + 3);
    assert.ok(Math.abs(a - b) < 0.02);
  }
});

test('normals are unit with z > 0 and gradAt matches finite differences', () => {
  for (const t of [hole1, hole3]) {
    const r = mulberry32(7);
    const { minX, minY, maxX, maxY } = t.bounds;
    for (let i = 0; i < 600; i++) {
      // keep away from grid lines, where the bilinear slope legitimately jumps
      const x = Math.floor(minX + r() * (maxX - minX)) + 0.1 + r() * 0.8;
      const y = Math.floor(minY + r() * (maxY - minY)) + 0.1 + r() * 0.8;
      const n = t.normalAt(x, y);
      assert.ok(Math.abs(Math.hypot(n.x, n.y, n.z) - 1) < 1e-9 && n.z > 0);
      const g = t.gradAt(x, y);
      const h = 0.002;
      const fx = (t.heightAt(x + h, y) - t.heightAt(x - h, y)) / (2 * h);
      const fy = (t.heightAt(x, y + h) - t.heightAt(x, y - h)) / (2 * h);
      assert.ok(Math.abs(fx - g.x) < 0.01 && Math.abs(fy - g.y) < 0.01, `grad ${g.x},${g.y} vs ${fx},${fy}`);
      assert.ok(Math.abs(n.x + g.x * n.z) < 1e-9);
    }
  }
});

test('surface priority OOB > water > bunker > green > fringe > tee > fairway > rough', () => {
  // A synthetic straight hole north with overlapping features.
  const def = {
    n: 99, par: 4, name: 'Lab', si: 1,
    path: [[0, 0], [0, 150], [0, 300]],
    elev: [[0, 0]],
    undulate: 0,
    tee: { s: 0, w: 10, l: 10 },
    fairway: { from: 0, to: 300, width: 40, wobble: 0 },
    green: { rx: 15, ry: 15, fringe: 2, slope: [270, 1], pins: [[0, 0]] },
    bunkers: [
      { s: 100, off: 0, shape: [[0, 0, 5, 5, 0]] }, // on the fairway
      { s: 200, off: 0, shape: [[0, 0, 6, 6, 0]] }, // under the water
      { g: [0, -15], shape: [[0, 0, 3, 3, 0]] }, // across the fringe line
    ],
    water: [{ kind: 'yellow', level: -1, poly: [[195, -30], [195, 30], [205, 30], [205, -30]] }],
    ob: { left: 25 },
    forest: false,
    bounds: { margin: 60 },
  };
  const t = buildHole(def);
  assert.equal(t.surfaceAt(0, 2), SURF.TEE); // tee wins over fairway
  assert.equal(t.surfaceAt(0, 50), SURF.FAIRWAY);
  assert.equal(t.surfaceAt(15, 50), SURF.FAIRWAY);
  assert.equal(t.surfaceAt(22, 50), SURF.ROUGH);
  assert.equal(t.surfaceAt(0, 100), SURF.BUNKER); // bunker over fairway
  assert.equal(t.surfaceAt(0, 200), SURF.WATER); // water over bunker
  assert.equal(t.surfaceAt(-28, 200), SURF.OOB); // OOB over water (left = -x when facing north)
  assert.ok(t.isOOB(-28, 50) && !t.isOOB(28, 50));
  assert.equal(t.surfaceAt(0, 290), SURF.GREEN);
  assert.equal(t.surfaceAt(11.17, 288.83), SURF.FRINGE); // 15.8 m from centre, fringe over fairway
  assert.equal(t.surfaceAt(0, 287.5), SURF.BUNKER); // bunker over green
  assert.equal(t.surfaceAt(1.5, 284.8), SURF.BUNKER); // bunker over fringe
  assert.equal(t.surfaceAt(t.bounds.maxX + 1, 100), SURF.OOB);
  assert.deepEqual(t.waterAt(0, 200), { kind: 'yellow', level: -1 });
  assert.equal(t.waterAt(0, 150), null);
  assert.equal(t.waters[0].poly.length, 4);
  // sgrid caches the same classification at cell centres
  const sg = t.sgrid;
  const i = Math.floor((0.1 - sg.minX) / sg.step);
  const j = Math.floor((100.1 - sg.minY) / sg.step);
  assert.equal(sg.data[j * sg.nx + i], SURF.BUNKER);
  assert.equal(sg.data.length, sg.nx * sg.ny);
  // Water bed sits below the water level; green is above it.
  assert.ok(t.heightAt(0, 200) < -1);
  assert.ok(t.heightAt(0, 100) < t.heightAt(0, 90) - 0.3);
});

test('grid layout and exact green heights', () => {
  const g = hole1.grid;
  assert.equal(g.heights.length, g.nx * g.ny);
  assert.equal(g.step, 1);
  const ix = 37;
  const iy = 120;
  assert.ok(Math.abs(hole1.heightAt(g.minX + ix, g.minY + iy) - g.heights[iy * g.nx + ix]) < 1e-5);
  // The green is analytic: second differences along a line are tiny compared with a bilinear mesh.
  const c = hole1.greenCenter;
  for (let k = 0; k < 50; k++) {
    const x = c.x - 5 + k * 0.2;
    const d2 = hole1.heightAt(x - 0.05, c.y + 1) - 2 * hole1.heightAt(x, c.y + 1) + hole1.heightAt(x + 0.05, c.y + 1);
    assert.ok(Math.abs(d2) < 1e-4);
  }
});

test('raycast hits the terrain near the expected point', () => {
  const t = hole1;
  const r = mulberry32(3);
  for (let i = 0; i < 50; i++) {
    const s = 20 + r() * 300;
    const p = t.path.pointAt(s);
    const target = { x: p.x + (r() - 0.5) * 40, y: p.y + (r() - 0.5) * 40 };
    target.z = t.heightAt(target.x, target.y);
    const o = { x: target.x - 60, y: target.y - 30, z: target.z + 40 };
    const d = { x: target.x - o.x, y: target.y - o.y, z: target.z - o.z };
    const L = Math.hypot(d.x, d.y, d.z);
    const dir = { x: d.x / L, y: d.y / L, z: d.z / L };
    const hit = t.raycast(o, dir, 500);
    assert.ok(hit, 'hit');
    // first intersection can be before the target if a ridge is in the way, never after it
    assert.ok(hit.t <= L + 0.05);
    assert.ok(Math.abs(hit.z - t.heightAt(hit.x, hit.y)) < 0.02);
    assert.ok(Math.abs(o.z + dir.z * hit.t - hit.z) < 0.02);
  }
  assert.equal(t.raycast({ x: 0, y: 0, z: 50 }, { x: 0, y: 0, z: 1 }, 100), null);
});

test('treesNear matches brute force and trees are well formed', () => {
  const t = hole3;
  assert.ok(t.trees.length > 50);
  for (const tr of t.trees) {
    assert.ok(tr.kind === 'pine' || tr.kind === 'broad');
    assert.ok(tr.canopy.cz > tr.z + tr.trunkH && tr.canopy.cz - tr.canopy.rz < tr.z + tr.trunkH + 0.5);
    assert.ok(Math.abs(tr.z - t.heightAt(tr.x, tr.y)) < 1e-6);
  }
  const r = mulberry32(4);
  for (let i = 0; i < 100; i++) {
    const x = t.bounds.minX + r() * (t.bounds.maxX - t.bounds.minX);
    const y = t.bounds.minY + r() * (t.bounds.maxY - t.bounds.minY);
    const rad = r() * 20;
    const got = new Set(t.treesNear(x, y, rad));
    for (const tr of t.trees) {
      const inside = Math.hypot(tr.x - x, tr.y - y) <= rad + tr.canopy.rx;
      assert.equal(got.has(tr), inside);
    }
  }
});

test('course context: theme, conditions and courseId default to Hollow Pines', () => {
  assert.equal(hole1.theme, 'parkland');
  assert.equal(hole1.courseId, 'pines');
  assert.deepEqual(hole1.conditions, { firm: 1, greenStimpFt: 10.5, wind: 'normal' });
  assert.deepEqual(hole1.decor, []);
  for (const w of hole3.waters) assert.ok(w.fill === 'inside' && w.sea === false);
  const course = { id: 'test', theme: 'links', conditions: { firm: 1.4, wind: 'windy' } };
  const t = buildHole(COURSE.holes[1], { course });
  assert.equal(t.theme, 'links');
  assert.equal(t.courseId, 'test');
  assert.deepEqual(t.conditions, { firm: 1.4, greenStimpFt: 10.5, wind: 'windy' });
  // The ground itself does not depend on the course context.
  const t0 = buildHole(COURSE.holes[1]);
  assert.equal(t.grid.heights[777], t0.grid.heights[777]);
  assert.equal(t.trees.length, t0.trees.length);
});

test('OOB stakes run along the OB line about 12 m apart', () => {
  const t = hole1;
  assert.ok(t.stakes.length > 20);
  for (let i = 1; i < t.stakes.length; i++) {
    const d = Math.hypot(t.stakes[i].x - t.stakes[i - 1].x, t.stakes[i].y - t.stakes[i - 1].y);
    assert.ok(d > 10 && d < 14, `gap ${d}`);
  }
  for (const s of t.stakes) assert.ok(Math.abs(t.path.project(s.x, s.y).lat + 52) < 0.6);
});

test('build is deterministic and fast', () => {
  const a = buildHole(COURSE.holes[3], { seed: 9 });
  const t0 = performance.now();
  const b = buildHole(COURSE.holes[3], { seed: 9 });
  const ms = performance.now() - t0;
  assert.ok(ms < 300, `${ms} ms`);
  assert.equal(a.trees.length, b.trees.length);
  assert.equal(a.grid.heights[12345], b.grid.heights[12345]);
});
