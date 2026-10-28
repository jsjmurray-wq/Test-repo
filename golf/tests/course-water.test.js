// The water course, Coral Cay (src/course-water.js): course data, every hole's yardage, tee, pins
// and green, the water features the design promises, relief from every water body, build time and
// playability by the autoplay bot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WATER } from '../src/course-water.js';
import { courseById, courseSummary } from '../src/courses.js';
import { buildHole } from '../src/terrain.js';
import { SURF, BALL_R, mToYd, ydToM } from '../src/constants.js';
import { resolveShot, isDropOk, holdsBall } from '../src/rules.js';
import { simulateShot } from '../src/physics.js';
import { stockLaunch, clubById, CLUBS } from '../src/clubs.js';
import { Game } from '../src/game.js';
import { playBotShot, botDecide } from '../src/bot.js';

// Terrain builds are the slow part: share them.
const cache = new Map();
function build(def, opts = {}) {
  const k = `${def.n}:${opts.pinIndex || 0}:${opts.seed || 1}`;
  if (!cache.has(k)) cache.set(k, buildHole(def, { pinIndex: 0, seed: 1, ...opts, course: WATER }));
  return cache.get(k);
}
const holes = WATER.holes.map((def) => build(def));

// Distance from p to the green ellipse edge (positive inside), by dense boundary sampling.
function insideDist(green, p) {
  const ca = Math.cos(green.rot);
  const sa = Math.sin(green.rot);
  let best = Infinity;
  for (let k = 0; k < 1440; k++) {
    const a = (k / 1440) * Math.PI * 2;
    const u = green.rx * Math.cos(a);
    const v = green.ry * Math.sin(a);
    best = Math.min(best, Math.hypot(green.cx + u * ca - v * sa - p.x, green.cy + u * sa + v * ca - p.y));
  }
  return best;
}
const slope = (t, x, y) => Math.hypot(...Object.values(t.gradAt(x, y)));
// Point (r, f) metres from the green centre (r to the right, f away from the tee).
function greenPt(t, r, f) {
  const d = t.path.tangentAt(t.lengthM);
  return { x: t.greenCenter.x + r * d.y + f * d.x, y: t.greenCenter.y - r * d.x + f * d.y };
}
// Point (s, off) along the centreline (off + to the right).
function at(t, s, off) {
  const p = t.path.pointAt(s);
  const d = t.path.tangentAt(s);
  return { x: p.x + d.y * off, y: p.y - d.x * off };
}
const surf = (t, p) => t.surfaceAt(p.x, p.y);

test('Coral Cay course object: id, tropical theme, lush conditions, registered', () => {
  assert.equal(WATER.id, 'water');
  assert.equal(WATER.theme, 'tropical');
  assert.ok(WATER.name.length > 3 && WATER.tagline.length > 10);
  assert.deepEqual(WATER.conditions, { firm: 0.95, greenStimpFt: 10.5, wind: 'normal' });
  assert.equal(courseById('water'), WATER);
  for (const t of holes) {
    assert.equal(t.courseId, 'water');
    assert.equal(t.theme, 'tropical');
    assert.equal(t.conditions.firm, 0.95);
  }
});

test('nine holes, par 36 (two par 3s, two par 5s), 3100-3400 yd, stroke indexes 1-9', () => {
  assert.equal(WATER.holes.length, 9);
  assert.deepEqual(WATER.holes.map((h) => h.n), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const pars = WATER.holes.map((h) => h.par);
  assert.equal(pars.reduce((a, b) => a + b, 0), 36);
  assert.equal(pars.filter((p) => p === 3).length, 2);
  assert.equal(pars.filter((p) => p === 5).length, 2);
  const yd = holes.reduce((a, t) => a + mToYd(t.lengthM), 0);
  assert.ok(yd > 3100 && yd < 3400, `${yd} yd`);
  assert.equal(courseSummary(WATER).par, 36);
  assert.deepEqual(WATER.holes.map((h) => h.si).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(new Set(WATER.holes.map((h) => h.name)).size, 9);
});

for (const t of holes) {
  const def = WATER.holes[t.n - 1];
  test(`hole ${t.n} (${t.name}): yardage, tee, pins and green`, () => {
    const yd = mToYd(t.lengthM);
    if (t.par === 3) assert.ok(yd >= 120 && yd <= 230, `${yd}`);
    if (t.par === 4) assert.ok(yd >= 300 && yd <= 470, `${yd}`);
    if (t.par === 5) assert.ok(yd >= 450 && yd <= 600, `${yd}`);

    assert.equal(t.surfaceAt(t.tee.x, t.tee.y), SURF.TEE);
    assert.ok(!t.isOOB(t.tee.x, t.tee.y) && !t.waterAt(t.tee.x, t.tee.y));
    // The whole tee box stands clear of every water body.
    for (const w of t.waters) assert.ok(t.tee.z > w.level + 0.8, `tee ${t.tee.z.toFixed(2)} over water ${w.level.toFixed(2)}`);

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
    const { cx, cy, rx, ry } = t.green;
    const R = Math.max(rx, ry);
    let maxS = 0;
    for (let y = cy - R; y <= cy + R; y += 0.5) {
      for (let x = cx - R; x <= cx + R; x += 0.5) {
        if (t.surfaceAt(x, y) !== SURF.GREEN) continue;
        maxS = Math.max(maxS, slope(t, x, y));
        // The green and its fringe stand clear of the water.
        for (const w of t.waters) assert.ok(t.heightAt(x, y) > w.level + 0.6);
      }
    }
    assert.ok(maxS <= 0.05, `green max slope ${(maxS * 100).toFixed(2)}%`);

    const t2 = build(def, { pinIndex: 2 });
    assert.ok(Math.hypot(t2.cup.x - t.pins[2].x, t2.cup.y - t.pins[2].y) < 1e-9);
    assert.ok(Math.abs(t2.cup.z - t2.heightAt(t2.cup.x, t2.cup.y)) < 1e-9);
  });

  test(`hole ${t.n}: objects, water, a safe line and relief`, () => {
    for (const s of [1, 2, 3]) {
      const tt = build(def, { seed: s });
      for (const tr of tt.trees) {
        const sf = tt.surfaceAt(tr.x, tr.y);
        assert.ok(![SURF.FAIRWAY, SURF.GREEN, SURF.FRINGE, SURF.TEE, SURF.WATER, SURF.BUNKER].includes(sf), `object on ${sf}`);
      }
    }
    // Palms everywhere; water on every hole, all of it red (lateral relief).
    assert.ok(t.trees.filter((o) => o.kind === 'palm').length >= 5, 'palms');
    assert.ok(t.waters.length >= 1, 'water');
    for (const w of t.waters) assert.ok(w.kind === 'red' && w.poly.length >= 3 && Number.isFinite(w.level));
    // Dry land never sits below a flood's water level (it would draw as flooded).
    const flood = t.waters.find((w) => w.fill === 'outside');
    if (flood) {
      const g = t.grid;
      for (let j = 0; j < g.ny; j += 2) {
        for (let i = 0; i < g.nx; i += 2) {
          const x = g.minX + i;
          const y = g.minY + j;
          if (t.surfaceAt(x, y) !== SURF.WATER) assert.ok(g.heights[j * g.nx + i] > flood.level - 0.03, `dry ${x},${y} under the flood`);
        }
      }
    }

    if (t.par >= 4) {
      // The default tee line finds dry, in-bounds short grass or rough at driver distance.
      const aim = t.aimPoint(t.tee);
      const d = Math.hypot(aim.x - t.tee.x, aim.y - t.tee.y);
      const ux = (aim.x - t.tee.x) / d;
      const uy = (aim.y - t.tee.y) / d;
      for (const k of [215, 230, 245]) {
        const sf = t.surfaceAt(t.tee.x + ux * k, t.tee.y + uy * k);
        assert.ok(sf === SURF.FAIRWAY || sf === SURF.ROUGH, `${k} m along the aim lands on ${sf}`);
      }
      for (let k = 10; k <= 230; k += 10) assert.ok(!t.isOOB(t.tee.x + ux * k, t.tee.y + uy * k));
    }
    // aimPoint from near the green is the cup.
    const near = t.aimPoint({ x: t.greenCenter.x + 30, y: t.greenCenter.y });
    assert.ok(Math.hypot(near.x - t.cup.x, near.y - t.cup.y) < 1e-9);

    // Relief: a fan of stock shots from the tee and the fairway (every club that could be chosen,
    // pulled and pushed, struck full and a little thin). Every ball that finds the water gets a
    // legal spot to play on from: a drop that is dry, holds the ball and is no nearer the hole, or,
    // where the rules give no drop (long over an island or a point green), the replay. Real drops
    // must be the rule.
    const spots = [{ p: t.tee, tee: true }];
    if (t.par > 3) for (const f of [0.6, 0.8]) spots.push({ p: at(t, t.lengthM * f, 0), tee: false });
    let wet = 0;
    let replays = 0;
    for (const sp of spots) {
      const pos = { x: sp.p.x, y: sp.p.y, z: t.heightAt(sp.p.x, sp.p.y) + BALL_R };
      const prev = { ...pos };
      const ap = t.aimPoint(sp.p);
      const yaw = Math.atan2(ap.y - sp.p.y, ap.x - sp.p.x);
      const clubs = sp.tee && t.par > 3 ? ['D', '3W', '5W', '4H'] : ['4H', '5i', '7i', '9i', 'GW'];
      for (const id of clubs) {
        for (const da of [-9, -4, 0, 4, 9]) {
          for (const speedScale of [0.88, 1]) {
            const r = simulateShot(t, stockLaunch(clubById(id), { pos, aimYaw: yaw + (da * Math.PI) / 180, speedScale }), { seed: 3, record: false });
            if (r.final.outcome !== 'water') continue;
            wet++;
            const res = resolveShot({ terrain: t, par: t.par, strokes: 0, prevSpot: prev, fromTee: sp.tee, fromSurface: sp.tee ? SURF.TEE : SURF.FAIRWAY }, r);
            const d = res.decision;
            assert.ok(d && res.penalty === 1);
            assert.ok(isDropOk(t, d.drop.x, d.drop.y) && holdsBall(t, d.drop.x, d.drop.y), `drop ${d.drop.x.toFixed(1)},${d.drop.y.toFixed(1)}`);
            if (Math.hypot(d.drop.x - prev.x, d.drop.y - prev.y) < 0.01) {
              replays++;
              continue;
            }
            const dE = Math.hypot(d.entry.x - t.cup.x, d.entry.y - t.cup.y);
            assert.ok(Math.hypot(d.drop.x - t.cup.x, d.drop.y - t.cup.y) >= dE - 1e-6, 'no nearer the hole');
          }
        }
      }
    }
    assert.ok(replays <= 0.15 * wet, `${replays} of ${wet} water balls without a drop`);

    // Sensible clubs on the default line find dry land: the long clubs off a par 4/5 tee, and on
    // a par 3 the club whose carry fits the hole.
    const pos = { x: t.tee.x, y: t.tee.y, z: t.tee.z + BALL_R };
    const ap = t.aimPoint(t.tee);
    const yaw = Math.atan2(ap.y - t.tee.y, ap.x - t.tee.x);
    const dist = Math.hypot(t.cup.x - t.tee.x, t.cup.y - t.tee.y) + (t.cup.z - t.tee.z);
    const ids = t.par > 3 ? ['D', '3W', '5W', '4H'] : [CLUBS.find((c) => c.targetCarryYd && ydToM(c.targetCarryYd) <= dist + 6).id];
    for (const id of ids) {
      const r = simulateShot(t, stockLaunch(clubById(id), { pos, aimYaw: yaw }), { seed: 1, record: false });
      assert.equal(r.final.outcome, 'rest', `${id} off the tee: ${r.final.outcome}`);
      if (t.par === 3) assert.ok([SURF.GREEN, SURF.FRINGE].includes(r.final.surface), `${id} to the green: ${r.final.surface}`);
    }
  });
}

test('all nine holes build in under 300 ms', () => {
  for (const def of WATER.holes) {
    // Best of two: the test files run in parallel processes, so one build can be starved.
    let ms = Infinity;
    for (let k = 0; k < 2; k++) {
      const t0 = performance.now();
      buildHole(def, { pinIndex: k, seed: 1, course: WATER });
      ms = Math.min(ms, performance.now() - t0);
    }
    assert.ok(ms < 300, `hole ${def.n}: ${ms.toFixed(0)} ms`);
  }
});

test('the signature water: split fairway, island green, forced carry, peninsula, beaches, the ocean', () => {
  const [h1, h2, h3, h4, h5, h6, h7, h8, h9] = holes;
  // 1: the lagoon's tail in front of the tee and in the corner of the dogleg, with a beach.
  assert.equal(surf(h1, at(h1, 60, 0)), SURF.WATER);
  assert.ok(h1.sgrid.data.includes(SURF.WASTE));

  // 2: a lagoon splits the fairway: fairway on both sides of it at the fork, the sea beyond the
  //    beach on the left, and the green open from the left branch.
  let left = null;
  let right = null;
  for (let off = -60; off <= 90; off += 1) {
    const sf = surf(h2, at(h2, 360, off));
    if (sf === SURF.WATER && left === null) left = off;
    if (left !== null && sf === SURF.WATER) right = off;
  }
  assert.ok(left !== null && right - left > 25, 'lagoon at the fork');
  const sides = [-40, -20, 0].map((o) => surf(h2, at(h2, 360, left + o)));
  assert.ok(sides.includes(SURF.FAIRWAY), 'left branch');
  assert.ok([10, 20, 30].map((o) => surf(h2, at(h2, 360, right + o))).includes(SURF.FAIRWAY), 'right branch');
  assert.ok(h2.waters.some((w) => w.sea), 'the sea');

  // 3: island green: water everywhere but the tee islet and the green island.
  const flood = h3.waters.find((w) => w.fill === 'outside');
  assert.ok(flood && flood.islands.length === 2);
  for (let a = 0; a < 360; a += 15) {
    const p = greenPt(h3, 32 * Math.cos((a * Math.PI) / 180), 30 * Math.sin((a * Math.PI) / 180));
    assert.equal(surf(h3, p), SURF.WATER, `round the island at ${a} deg`);
  }
  assert.equal(surf(h3, at(h3, 70, 0)), SURF.WATER);

  // 4: the drive must carry the lagoon; the fairway beyond is dry; dry ground left of the inlet.
  let wet = 0;
  for (let s = 20; s <= 140; s += 5) if (surf(h4, at(h4, s, 0)) === SURF.WATER) wet += 5;
  assert.ok(wet >= 90 && wet <= 140, `carry over the inlet ${wet} m`);
  assert.equal(surf(h4, at(h4, 230, 0)), SURF.FAIRWAY);
  assert.notEqual(surf(h4, at(h4, 80, -45)), SURF.WATER);

  // 5: peninsula green: water right, behind and left of it; the front is dry.
  for (const [r, f] of [[24, 0], [0, 26], [-26, 6]]) assert.equal(surf(h5, greenPt(h5, r, f)), SURF.WATER, `${r},${f}`);
  for (const [r, f] of [[0, -22], [-10, -20], [10, -20]]) assert.notEqual(surf(h5, greenPt(h5, r, f)), SURF.WATER, `${r},${f}`);

  // 6: beach and sea right of and behind the green.
  assert.equal(surf(h6, greenPt(h6, 21, 0)), SURF.WASTE);
  assert.equal(surf(h6, greenPt(h6, 34, 0)), SURF.WATER);
  assert.equal(surf(h6, greenPt(h6, 0, 40)), SURF.WATER);
  assert.ok(h6.waters.some((w) => w.sea));

  // 7: a spit in the ocean.
  const sea7 = h7.waters.find((w) => w.fill === 'outside');
  assert.ok(sea7 && sea7.sea && sea7.islands.length === 0);
  assert.equal(surf(h7, at(h7, 30, 0)), SURF.WATER);

  // 8: the sea bay down the left, a beach between it and the fairway.
  assert.ok(h8.waters.some((w) => w.sea));
  assert.equal(surf(h8, at(h8, 270, -20)), SURF.WASTE);
  assert.equal(surf(h8, at(h8, 270, -40)), SURF.WATER);

  // 9: the lagoon's arm in front of the green; the right side is the open door.
  assert.equal(surf(h9, greenPt(h9, -6, -32)), SURF.WATER);
  assert.notEqual(surf(h9, greenPt(h9, 24, -30)), SURF.WATER);

  // Beaches (waste) on most holes.
  assert.ok(holes.filter((t) => t.sgrid.data.includes(SURF.WASTE)).length >= 7);
});

// ------------------------------------------------------------------ playability

// Plays the hole out with the bot; returns the strokes on the card. A ball never stays stuck:
// every swing is accepted and the hole is finished within 30 bot actions.
function playHole(g) {
  let guard = 0;
  while (g.phase !== 'holed' && guard++ < 30) {
    if (g.phase === 'intro') g.skipIntro();
    else if (g.phase === 'decision') botDecide(g);
    else if (g.phase === 'address') {
      const r = playBotShot(g);
      assert.ok(r.ok, `bot swing ${JSON.stringify(r.plan)}`);
      g.skip();
    } else assert.fail(`unexpected phase ${g.phase}`);
  }
  assert.equal(g.phase, 'holed', 'the hole is finished');
  return g.state.card.holes[g.state.holeIndex].strokes;
}

for (const seed of [1, 2]) {
  test(`bot round on Coral Cay (seed ${seed}, normal difficulty): every hole <= par + 3, round par-3 to par+12`, () => {
    const g = new Game({ course: WATER, seed, settings: { wind: 'light', difficulty: 'normal' }, buildHole: (def, opts) => build(def, opts) });
    const lines = [];
    for (let i = 0; i < 9; i++) {
      g.loadHole(i);
      const s = playHole(g);
      const h = g.state.card.holes[i];
      lines.push(`${i + 1}: ${s}${h.pickUp ? ' (picked up)' : ''}`);
      assert.ok(s <= h.par + 3, `hole ${i + 1}: ${s} on a par ${h.par}`);
    }
    const t = g.totals();
    assert.equal(t.played, 9);
    assert.ok(t.strokes >= 33 && t.strokes <= 48, `round of ${t.strokes}: ${lines.join(', ')}`);
    assert.ok(t.pickUps <= 1);
  });
}
