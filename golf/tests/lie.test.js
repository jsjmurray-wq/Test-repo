// Lies: surfaces and slopes on the real holes, plus exact slope maths on synthetic planes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lieAt, applyLie, greenEdgeDist, isExplosion } from '../src/lie.js';
import { COURSE } from '../src/course.js';
import { buildHole } from '../src/terrain.js';
import { planeTerrain } from '../src/physics.js';
import { clubById } from '../src/clubs.js';
import { SURF, SURFACES } from '../src/constants.js';
import { DEG } from '../src/vec3.js';

const hole1 = buildHole(COURSE.holes[0], { pinIndex: 0, seed: 1 });
const hole7 = buildHole(COURSE.holes[6], { pinIndex: 0, seed: 1 });

const at = (t, s, off = 0) => {
  const p = t.path.pointAt(s);
  const d = t.path.tangentAt(s);
  return { x: p.x + d.y * off, y: p.y - d.x * off };
};
const yawAlong = (t, s) => {
  const d = t.path.tangentAt(s);
  return Math.atan2(d.y, d.x);
};
const params = { ballSpeed: 50, launchDeg: 15, spinRpm: 6000, startDirDeg: 0 };
const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

test('surfaces and labels on hole 1: tee, fairway, rough, bunker, fringe, green', () => {
  const cases = [
    [hole1.tee, SURF.TEE, 'Tee'],
    [at(hole1, 250), SURF.FAIRWAY, 'Fairway'],
    [at(hole1, 100, 25), SURF.ROUGH, 'Rough'],
    [at(hole1, 225, 18), SURF.BUNKER, 'Bunker'],
    [hole1.cup, SURF.GREEN, 'Green'],
  ];
  for (const [p, surf, name] of cases) {
    const lie = lieAt(hole1, p, Math.atan2(hole1.cup.y - p.y, hole1.cup.x - p.x));
    assert.equal(lie.surface, surf, name);
    assert.ok(lie.label.startsWith(name), `${lie.label}`);
    const base = SURFACES[surf].lie;
    assert.equal(lie.factors.spin, base.spin);
    assert.equal(lie.factors.sdir, base.sdir);
    // speed and launch only move with the slope
    assert.ok(Math.abs(lie.factors.speed - base.speed) < 0.05);
    assert.ok(Math.abs(lie.factors.launch - base.launch) < 4);
  }
  // the fringe ring around the green
  const g = hole1.green;
  const ux = Math.cos(g.rot);
  const uy = Math.sin(g.rot);
  const p = { x: g.cx + ux * (g.rx + 0.6), y: g.cy + uy * (g.rx + 0.6) };
  const fr = lieAt(hole1, p, 0);
  assert.equal(fr.surface, SURF.FRINGE);
  assert.equal(fr.label, 'Fringe');
  assert.ok(fr.greenDist > 0.3 && fr.greenDist < 0.9, `${fr.greenDist}`);
  assert.equal(lieAt(hole1, hole1.cup, 0).greenDist, 0);
  assert.equal(greenEdgeDist(g, g.cx, g.cy), 0);
});

test('hole 7 drops into a valley: downhill lie facing the hole, uphill facing the tee', () => {
  // Find a clearly sloped rough spot in the valley (the profile falls ~8 m over 130 m).
  let found = null;
  for (let s = 70; s <= 150 && !found; s += 2) {
    const p = at(hole7, s);
    const lie = lieAt(hole7, p, yawAlong(hole7, s));
    if (lie.surface === SURF.ROUGH && lie.slopeAlong < -0.05 && Math.abs(lie.slopeAlong) > Math.abs(lie.slopeAcross)) found = { p, s, lie };
  }
  assert.ok(found, 'a downhill spot exists');
  const { p, s, lie } = found;
  assert.equal(lie.label, 'Rough · Downhill');
  assert.ok(lie.factors.launch < SURFACES[SURF.ROUGH].lie.launch, 'downhill de-lofts');
  assert.equal(lie.factors.speed, SURFACES[SURF.ROUGH].lie.speed, 'no uphill speed loss');
  const back = lieAt(hole7, p, yawAlong(hole7, s) + Math.PI);
  assert.equal(back.label, 'Rough · Uphill');
  assert.ok(close(back.slopeAlong, -lie.slopeAlong, 1e-9));
  assert.ok(back.factors.speed < SURFACES[SURF.ROUGH].lie.speed);
});

test('slope maths on a plane: launch +0.6 x angle, uphill speed loss, sidehill direction', () => {
  // Rising 10% to the east, aiming east: uphill.
  const up = lieAt(planeTerrain({ sx: 0.1 }), { x: 0, y: 0 }, 0);
  assert.ok(close(up.slopeAlong, 0.1) && close(up.slopeAcross, 0));
  assert.ok(close(up.factors.launch, 0.6 * Math.atan(0.1) / DEG));
  assert.ok(close(up.factors.speed, 1 - 0.4 * 0.1));
  assert.equal(up.label, 'Fairway · Uphill');
  assert.equal(up.dirOffset, 0);
  const down = lieAt(planeTerrain({ sx: 0.1 }), { x: 0, y: 0 }, Math.PI);
  assert.ok(close(down.factors.launch, -0.6 * Math.atan(0.1) / DEG));
  assert.equal(down.factors.speed, 1);
  // Rising 10% to the north, aiming east: right (south) is downhill, so the ball is below a
  // right-hander's feet and goes right (the way the ground falls).
  const side = lieAt(planeTerrain({ sy: 0.1 }), { x: 0, y: 0 }, 0);
  assert.ok(close(side.slopeAcross, -0.1));
  assert.ok(close(side.dirOffset, 0.5 * Math.atan(0.1) / DEG));
  assert.equal(side.label, 'Fairway · Ball below feet');
  assert.equal(lieAt(planeTerrain({ sy: 0.1 }), { x: 0, y: 0 }, 0, { handed: 'L' }).label, 'Fairway · Ball above feet');
  const above = lieAt(planeTerrain({ sy: -0.1 }), { x: 0, y: 0 }, 0);
  assert.ok(above.dirOffset < 0, 'ball above the feet pulls left');
  assert.equal(above.label, 'Fairway · Ball above feet');
  // Clamped at 4 degrees; gentle slopes are not named.
  assert.equal(lieAt(planeTerrain({ sy: 0.4 }), { x: 0, y: 0 }, 0).dirOffset, 4);
  assert.equal(lieAt(planeTerrain({ sx: 0.03 }), { x: 0, y: 0 }, 0).label, 'Fairway');
});

test('applyLie: lie factors, woods from rough and sand, greenside explosion, putter untouched', () => {
  const rough = lieAt(planeTerrain({ surface: SURF.ROUGH }), { x: 0, y: 0 }, 0);
  const iron = applyLie(params, rough, clubById('7i'));
  const R = SURFACES[SURF.ROUGH].lie;
  assert.ok(close(iron.ballSpeed, 50 * R.speed));
  assert.ok(close(iron.spinRpm, 6000 * R.spin));
  assert.ok(close(iron.launchDeg, 15 + R.launch));
  const wood = applyLie(params, rough, clubById('3W'));
  assert.ok(close(wood.ballSpeed, 50 * R.speed * 0.85), 'woods from rough lose 15% more');

  const sandTerrain = planeTerrain({ surface: SURF.BUNKER });
  const sand = lieAt(sandTerrain, { x: 0, y: 0 }, 0); // no green: a fairway bunker
  const B = SURFACES[SURF.BUNKER].lie;
  assert.ok(close(applyLie(params, sand, clubById('5W')).ballSpeed, 50 * B.speed * 0.5), 'wood from sand x 0.5');
  assert.ok(close(applyLie(params, sand, clubById('SW')).ballSpeed, 50 * B.speed), 'fairway bunker wedge: plain sand lie');
  assert.ok(!isExplosion(sand, clubById('SW')));

  // Greenside bunker on hole 1 (left of the green): an explosion with a wedge.
  const gb = hole1.green;
  let p = null;
  for (let d = 10; d < 30 && !p; d += 0.5) {
    for (let a = 0; a < 360 && !p; a += 5) {
      const q = { x: gb.cx + d * Math.cos(a * DEG), y: gb.cy + d * Math.sin(a * DEG) };
      if (hole1.surfaceAt(q.x, q.y) === SURF.BUNKER) p = q;
    }
  }
  assert.ok(p, 'greenside bunker found');
  const lie = lieAt(hole1, p, Math.atan2(hole1.cup.y - p.y, hole1.cup.x - p.x));
  assert.ok(lie.greenDist <= 40);
  const sw = clubById('SW');
  assert.ok(isExplosion(lie, sw));
  const ex = applyLie(params, lie, sw);
  const slopeSpeed = lie.factors.speed / B.speed;
  assert.ok(close(ex.ballSpeed, 50 * 0.6 * slopeSpeed), `${ex.ballSpeed}`);
  assert.ok(close(ex.spinRpm, 6000 * 0.5));
  assert.ok(close(ex.launchDeg, 15 + lie.factors.launch - B.launch + 6));
  // the 7 iron from the same bunker is a normal sand shot
  assert.ok(close(applyLie(params, lie, clubById('7i')).ballSpeed, 50 * lie.factors.speed));

  const side = lieAt(planeTerrain({ sy: 0.1 }), { x: 0, y: 0 }, 0);
  assert.ok(close(applyLie(params, side, clubById('7i')).startDirDeg, side.dirOffset));
  assert.deepEqual(applyLie(params, rough, clubById('P')), params);
  assert.deepEqual(applyLie(params, null, clubById('7i')), params);
});
