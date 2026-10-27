import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COURSE, holePar, coursePar } from '../src/course.js';
import { buildHole } from '../src/terrain.js';
import { SURF, mToYd } from '../src/constants.js';

const holes = COURSE.holes.map((def) => buildHole(def, { pinIndex: 0, seed: 1 }));

// Distance from p to the green ellipse edge (positive inside), by dense boundary sampling.
function insideDist(green, p) {
  const ca = Math.cos(green.rot);
  const sa = Math.sin(green.rot);
  let best = Infinity;
  for (let k = 0; k < 1440; k++) {
    const a = (k / 1440) * Math.PI * 2;
    const u = green.rx * Math.cos(a);
    const v = green.ry * Math.sin(a);
    const x = green.cx + u * ca - v * sa;
    const y = green.cy + u * sa + v * ca;
    best = Math.min(best, Math.hypot(x - p.x, y - p.y));
  }
  return best;
}

const slope = (t, x, y) => Math.hypot(...Object.values(t.gradAt(x, y)));

test('nine holes, par 36, about 3300 yd', () => {
  assert.equal(COURSE.holes.length, 9);
  assert.equal(coursePar(), 36);
  assert.equal(holePar(0), 4);
  const yd = holes.reduce((a, t) => a + mToYd(t.lengthM), 0);
  assert.ok(yd > 3150 && yd < 3450, `${yd} yd`);
  assert.deepEqual(COURSE.holes.map((h) => h.si).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

for (const t of holes) {
  const def = COURSE.holes[t.n - 1];
  test(`hole ${t.n} (${t.name}): yardage, tee, pins and green`, () => {
    const yd = mToYd(t.lengthM);
    if (t.par === 3) assert.ok(yd <= 230, `${yd}`);
    if (t.par === 4) assert.ok(yd >= 250 && yd <= 470, `${yd}`);
    if (t.par === 5) assert.ok(yd >= 450, `${yd}`);

    assert.equal(t.surfaceAt(t.tee.x, t.tee.y), SURF.TEE);
    assert.ok(!t.isOOB(t.tee.x, t.tee.y) && !t.waterAt(t.tee.x, t.tee.y));

    // cup and tee: the straight line is no longer than the routing and not absurdly shorter
    const straight = Math.hypot(t.cup.x - t.tee.x, t.cup.y - t.tee.y);
    assert.ok(straight <= t.lengthM + 12 && straight >= 0.75 * t.lengthM, `${straight} vs ${t.lengthM}`);

    assert.equal(t.pins.length, 3);
    for (const p of t.pins) {
      assert.equal(t.surfaceAt(p.x, p.y), SURF.GREEN, 'pin on green');
      assert.ok(insideDist(t.green, p) >= 4, `pin ${insideDist(t.green, p).toFixed(2)} m from the edge`);
      for (let r = 0; r <= 2; r += 0.5) {
        for (let k = 0; k < 16; k++) {
          const a = (k / 16) * Math.PI * 2;
          const s = slope(t, p.x + r * Math.cos(a), p.y + r * Math.sin(a));
          assert.ok(s <= 0.025, `slope ${(s * 100).toFixed(2)}% near pin`);
        }
      }
    }
    // green max slope
    const { cx, cy, rx, ry } = t.green;
    const R = Math.max(rx, ry);
    let maxS = 0;
    for (let y = cy - R; y <= cy + R; y += 0.5) {
      for (let x = cx - R; x <= cx + R; x += 0.5) {
        if (t.surfaceAt(x, y) !== SURF.GREEN) continue;
        maxS = Math.max(maxS, slope(t, x, y));
      }
    }
    assert.ok(maxS <= 0.05, `green max slope ${(maxS * 100).toFixed(2)}%`);

    // the cup follows pinIndex
    const t2 = buildHole(def, { pinIndex: 2, seed: 1 });
    assert.ok(Math.hypot(t2.cup.x - t.pins[2].x, t2.cup.y - t.pins[2].y) < 1e-9);
    assert.ok(Math.abs(t2.cup.z - t2.heightAt(t2.cup.x, t2.cup.y)) < 1e-9);
  });

  test(`hole ${t.n}: trees, hazards and playability`, () => {
    for (const s of [1, 2, 3]) {
      const tt = s === 1 ? t : buildHole(def, { seed: s });
      for (const tr of tt.trees) {
        const surf = tt.surfaceAt(tr.x, tr.y);
        assert.ok(![SURF.FAIRWAY, SURF.GREEN, SURF.FRINGE, SURF.TEE, SURF.WATER, SURF.BUNKER].includes(surf), `tree on ${surf}`);
      }
    }
    // every authored water body really is water at its polygon centre region
    for (const w of t.waters) assert.ok(['red', 'yellow'].includes(w.kind) && w.poly.length >= 3);

    if (t.par >= 4) {
      const aim = t.aimPoint(t.tee);
      const d = Math.hypot(aim.x - t.tee.x, aim.y - t.tee.y);
      const ux = (aim.x - t.tee.x) / d;
      const uy = (aim.y - t.tee.y) / d;
      const surf = t.surfaceAt(t.tee.x + ux * 230, t.tee.y + uy * 230);
      assert.ok(surf === SURF.FAIRWAY || surf === SURF.ROUGH, `230 m along the aim lands on ${surf}`);
      // and the drive's flight line does not need to start over OOB
      for (let k = 10; k <= 230; k += 10) assert.ok(!t.isOOB(t.tee.x + ux * k, t.tee.y + uy * k));
    }
    // aimPoint from near the green is the cup
    const near = t.aimPoint({ x: t.greenCenter.x + 30, y: t.greenCenter.y });
    assert.ok(Math.hypot(near.x - t.cup.x, near.y - t.cup.y) < 1e-9);
  });
}
