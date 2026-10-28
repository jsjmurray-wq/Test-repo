// Red Mesa (the desert course): the course.test.js checks for its nine holes, the target-golf
// design rules (forced carries, clear tee shots, a safe club off every tee, drops at the lake) and
// playability by the autoplay bot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DESERT } from '../src/course-desert.js';
import { buildHole } from '../src/terrain.js';
import { simulateShot } from '../src/physics.js';
import { stockLaunch, clubById } from '../src/clubs.js';
import { waterRelief, isDropOk, holdsBall } from '../src/rules.js';
import { Game, TREE_SEED } from '../src/game.js';
import { playBotShot, botDecide } from '../src/bot.js';
import { SURF, mToYd } from '../src/constants.js';

const course = DESERT;
// The game builds every hole with TREE_SEED (the course looks the same every round).
const holes = course.holes.map((def) => buildHole(def, { pinIndex: 0, seed: TREE_SEED, course }));

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

// Unit vector and length from the tee toward a point.
function lineTo(t, p) {
  const d = Math.hypot(p.x - t.tee.x, p.y - t.tee.y);
  return { ux: (p.x - t.tee.x) / d, uy: (p.y - t.tee.y) / d, d };
}

// A stock full swing from the tee along yaw, on the real hole, no wind.
function teeShot(t, clubId, yaw) {
  const pos = { x: t.tee.x, y: t.tee.y, z: t.tee.z + 0.03 };
  return simulateShot(t, stockLaunch(clubById(clubId), { pos, aimYaw: yaw }), { seed: 3, record: false });
}

test('Red Mesa course object: id, theme, conditions, name and tagline', () => {
  assert.equal(course.id, 'desert');
  assert.equal(course.theme, 'desert');
  assert.deepEqual(course.conditions, { firm: 1.25, greenStimpFt: 11, wind: 'normal' });
  assert.ok(course.name.length > 3 && course.tagline.length > 10);
  // Target golf: every hole is set in desert.
  for (const h of course.holes) assert.equal(h.outside, 'desert');
});

test('nine holes, par 36 (two 3s, five 4s, two 5s), 3100-3400 yd, stroke indexes 1-9', () => {
  assert.equal(course.holes.length, 9);
  assert.deepEqual(course.holes.map((h) => h.n), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(course.holes.reduce((a, h) => a + h.par, 0), 36);
  const count = (p) => course.holes.filter((h) => h.par === p).length;
  assert.deepEqual([count(3), count(4), count(5)], [2, 5, 2]);
  const yd = holes.reduce((a, t) => a + mToYd(t.lengthM), 0);
  assert.ok(yd >= 3100 && yd <= 3400, `${yd.toFixed(0)} yd`);
  assert.deepEqual(course.holes.map((h) => h.si).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  for (const h of course.holes) assert.ok(h.name && h.name.length >= 4);
  assert.equal(new Set(course.holes.map((h) => h.name)).size, 9);
});

test('a drivable par 4 and a par 3 over a canyon', () => {
  // Drivable: a stock driver straight at the green (still air) finishes on or by the green.
  const driv = holes.filter((t) => t.par === 4).some((t) => {
    const { ux, uy } = lineTo(t, t.greenCenter);
    const r = teeShot(t, 'D', Math.atan2(uy, ux));
    return Math.hypot(r.final.x - t.cup.x, r.final.y - t.cup.y) < 30 && r.final.outcome === 'rest';
  });
  assert.ok(driv, 'no drivable par 4');
  // Canyon: on some par 3 the ground between tee and green falls at least 12 m below both.
  const canyon = holes.filter((t) => t.par === 3).some((t) => {
    const { ux, uy, d } = lineTo(t, t.greenCenter);
    let lo = Infinity;
    for (let k = 20; k < d - 20; k += 2) lo = Math.min(lo, t.heightAt(t.tee.x + ux * k, t.tee.y + uy * k));
    return Math.min(t.tee.z, t.greenCenter.z) - lo >= 12;
  });
  assert.ok(canyon, 'no canyon par 3');
});

test('every hole builds in < 300 ms (warmed up, best of three: the test files run in parallel)', () => {
  for (const def of course.holes) {
    buildHole(def, { pinIndex: 0, seed: TREE_SEED, course });
    let best = Infinity;
    for (let k = 0; k < 3; k++) {
      const t0 = performance.now();
      buildHole(def, { pinIndex: k, seed: TREE_SEED, course });
      best = Math.min(best, performance.now() - t0);
    }
    assert.ok(best < 300, `hole ${def.n}: ${best.toFixed(0)} ms`);
  }
});

for (const t of holes) {
  const def = course.holes[t.n - 1];
  test(`hole ${t.n} (${t.name}): yardage, tee, pins and green`, () => {
    const yd = mToYd(t.lengthM);
    if (t.par === 3) assert.ok(yd >= 130 && yd <= 230, `${yd}`);
    if (t.par === 4) assert.ok(yd >= 250 && yd <= 470, `${yd}`);
    if (t.par === 5) assert.ok(yd >= 450 && yd <= 600, `${yd}`);
    assert.equal(t.courseId, 'desert');
    assert.equal(t.theme, 'desert');

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
    // green max slope (11 ft greens: keep them gentle)
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
    const t2 = buildHole(def, { pinIndex: 2, seed: TREE_SEED, course });
    assert.ok(Math.hypot(t2.cup.x - t.pins[2].x, t2.cup.y - t.pins[2].y) < 1e-9);
    assert.ok(Math.abs(t2.cup.z - t2.heightAt(t2.cup.x, t2.cup.y)) < 1e-9);

    // aimPoint from near the green is the cup
    const near = t.aimPoint({ x: t.greenCenter.x + 30, y: t.greenCenter.y });
    assert.ok(Math.hypot(near.x - t.cup.x, near.y - t.cup.y) < 1e-9);
  });

  test(`hole ${t.n}: objects off the short grass, a clear tee shot and a forced carry`, () => {
    for (const s of [1, 2, 3]) {
      const tt = s === TREE_SEED ? t : buildHole(def, { seed: s, course });
      assert.ok(tt.trees.length > 150, `only ${tt.trees.length} objects`);
      for (const tr of tt.trees) {
        const surf = tt.surfaceAt(tr.x, tr.y);
        assert.ok(![SURF.FAIRWAY, SURF.GREEN, SURF.FRINGE, SURF.TEE, SURF.WATER, SURF.BUNKER].includes(surf), `${tr.kind} on ${surf}`);
        assert.ok(tr.canopy === null || (tr.canopy.rx > 0 && tr.canopy.rz > 0));
      }
    }
    const kinds = new Set(t.trees.map((o) => o.kind));
    for (const k of ['saguaro', 'shrub', 'rock']) assert.ok(kinds.has(k), `no ${k}`);
    for (const w of t.waters) assert.ok(['red', 'yellow'].includes(w.kind) && w.poly.length >= 3 && !w.sea);

    // No saguaro or tree stands in the tee shot (or the view from the tee): clear by 8 m for the
    // first 60 m, 5 m out to 120 m, along the line to the aim point (par 3s: the cup).
    const aim = t.par === 3 ? t.cup : t.aimPoint(t.tee);
    const { ux, uy } = lineTo(t, aim);
    for (const o of t.trees) {
      if (o.kind === 'rock' || o.kind === 'shrub') continue;
      const dx = o.x - t.tee.x;
      const dy = o.y - t.tee.y;
      const along = dx * ux + dy * uy;
      const lat = Math.abs(dx * uy - dy * ux) - (o.canopy ? o.canopy.rx : o.trunkR);
      if (along > 3 && along < 120) assert.ok(lat >= (along < 60 ? 8 : 5), `${o.kind} ${along.toFixed(0)} m out, ${lat.toFixed(1)} m off the line`);
    }
    // Target golf: the tee shot carries desert (or a wash) before the fairway or green.
    const s60 = t.surfaceAt(t.tee.x + ux * 60, t.tee.y + uy * 60);
    assert.ok(s60 === SURF.DESERT || s60 === SURF.WASTE, `60 m out is ${s60}`);
  });

  test(`hole ${t.n}: a safe club off the tee`, () => {
    if (t.par === 3) {
      // Some club from the 4-hybrid to the pitching wedge finishes on the green, struck stock at
      // the cup in still air.
      const yaw = Math.atan2(t.cup.y - t.tee.y, t.cup.x - t.tee.x);
      const on = ['4H', '5i', '6i', '7i', '8i', '9i', 'PW'].filter((id) => teeShot(t, id, yaw).final.surface === SURF.GREEN);
      assert.ok(on.length >= 1, 'no club reaches the green');
      return;
    }
    // Par 4/5: along the default aim line, at least two of the clubs from the driver to the
    // 7-iron finish on the fairway (on the firm desert ground the woods run through a short
    // hole's dogleg, so the lay-up is an iron) and none of them in water or out of bounds; the
    // line never starts over OOB.
    const aim = t.aimPoint(t.tee);
    const yaw = Math.atan2(aim.y - t.tee.y, aim.x - t.tee.x);
    const res = ['D', '3W', '5W', '4H', '5i', '6i', '7i'].map((id) => [id, teeShot(t, id, yaw).final]);
    const onFw = res.filter(([, f]) => f.surface === SURF.FAIRWAY).map(([id]) => id);
    assert.ok(onFw.length >= 2, `on the fairway: ${onFw.join(',')} (${res.map(([id, f]) => `${id}:${f.surface}`).join(' ')})`);
    for (const [id, f] of res) assert.equal(f.outcome, 'rest', `${id} ${f.outcome}`);
    const { ux, uy } = lineTo(t, aim);
    for (let k = 10; k <= 230; k += 10) assert.ok(!t.isOOB(t.tee.x + ux * k, t.tee.y + uy * k));
  });
}

test('the lake on the 9th: red relief always finds a dry drop close to where the ball went in', () => {
  const t = holes[8];
  const lakes = t.waters.filter((w) => w.kind === 'red');
  assert.equal(lakes.length, 2);
  let n = 0;
  let close = 0;
  for (const w of lakes) {
    const cx = w.poly.reduce((a, p) => a + p.x, 0) / w.poly.length;
    const cy = w.poly.reduce((a, p) => a + p.y, 0) / w.poly.length;
    for (const p of w.poly) {
      // An entry just inside the edge.
      const d = Math.hypot(cx - p.x, cy - p.y);
      const entry = { x: p.x + ((cx - p.x) / d) * 0.4, y: p.y + ((cy - p.y) / d) * 0.4 };
      if (t.surfaceAt(entry.x, entry.y) !== SURF.WATER) continue;
      const drop = waterRelief(t, entry, 'red');
      n++;
      assert.ok(drop && isDropOk(t, drop.x, drop.y) && holdsBall(t, drop.x, drop.y), `no drop for (${entry.x.toFixed(1)}, ${entry.y.toFixed(1)})`);
      const r = Math.hypot(drop.x - entry.x, drop.y - entry.y);
      assert.ok(r < 30, `drop ${r.toFixed(1)} m away`);
      if (r <= 2.5) close++;
    }
  }
  assert.ok(n >= 12, `${n} entries`);
  assert.ok(close / n >= 0.8, `only ${close}/${n} drops within two club lengths`);
});

// ------------------------------------------------------------------ playability (autoplay bot)

const cache = new Map();
const cachedBuild = (def, opts) => {
  const k = `${def.n}:${opts.pinIndex}:${opts.seed}`;
  if (!cache.has(k)) cache.set(k, buildHole(def, opts));
  return cache.get(k);
};

// Plays the hole out with the bot; returns the number of strokes and asserts no ball gets stuck
// (every full shot from off the green moves the ball, a hole never needs more than 14 swings).
function playHole(g) {
  let guard = 0;
  let stuck = 0;
  while (g.phase !== 'holed' && guard++ < 40) {
    if (g.phase === 'intro') g.skipIntro();
    else if (g.phase === 'decision') botDecide(g);
    else if (g.phase === 'address') {
      const from = { ...g.state.hole.ball };
      const onGreen = g.lie.surface === SURF.GREEN || g.lie.surface === SURF.FRINGE;
      const r = playBotShot(g);
      assert.ok(r.ok, `bot swing ${JSON.stringify(r.plan)}`);
      g.skip();
      const f = r.shot.result.final;
      if (!onGreen && f.outcome === 'rest' && Math.hypot(f.x - from.x, f.y - from.y) < 3) stuck++;
    } else assert.fail(`unexpected phase ${g.phase}`);
  }
  assert.equal(g.phase, 'holed');
  assert.ok(stuck <= 1, `${stuck} shots that barely moved the ball`);
  return g.state.card.holes[g.state.holeIndex].strokes;
}

for (const seed of [1, 2]) {
  test(`bot round on Red Mesa, seed ${seed}, light wind, normal: every hole <= par + 3, 33-48 total`, () => {
    const g = new Game({ course, seed, settings: { wind: 'light', difficulty: 'normal' }, buildHole: cachedBuild });
    const lines = [];
    for (let i = 0; i < 9; i++) {
      g.loadHole(i);
      const s = playHole(g);
      const h = g.state.card.holes[i];
      lines.push(`${i + 1}: ${s} (par ${h.par}${h.pickUp ? ', picked up' : ''})`);
      assert.ok(s <= h.par + 3, `hole ${i + 1}: ${s} on a par ${h.par}`);
    }
    const t = g.totals();
    assert.equal(t.played, 9);
    assert.equal(t.par, 36);
    assert.ok(t.strokes >= 33 && t.strokes <= 48, `round of ${t.strokes}: ${lines.join(', ')}`);
    assert.ok(t.pickUps <= 1);
  });
}
