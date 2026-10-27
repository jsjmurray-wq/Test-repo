import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dragCoeff, liftCoeff, windAt, windFactor, flightAccel, AERO_K, CD, CL, U_REF } from '../src/aero.js';
import { G } from '../src/constants.js';

const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ''} ${a} vs ${b}`);

test('drag and lift coefficients follow the fits and clamp S to [0, 0.6]', () => {
  const cd = (S, u = U_REF) => CD.a + CD.b * S + CD.b2 * S * S + CD.e * (U_REF / u - 1);
  near(dragCoeff(0), CD.a, 1e-12);
  near(dragCoeff(0.2), cd(0.2), 1e-12);
  near(dragCoeff(5), cd(0.6), 1e-12);
  near(dragCoeff(-1), CD.a, 1e-12);
  near(dragCoeff(0.2, 30), cd(0.2, 30), 1e-12);
  near(dragCoeff(0.2, 5), cd(0.2, 15), 1e-12, 'speed floor');
  assert.ok(dragCoeff(0.1, 75) < dragCoeff(0.1, 40), 'a little less drag at driver speed');
  // Drag and lift both grow with spin over the whole range.
  for (let S = 0.05; S <= 0.6; S += 0.05) {
    assert.ok(dragCoeff(S) > dragCoeff(S - 0.05));
    assert.ok(liftCoeff(S) > liftCoeff(S - 0.05));
  }
  assert.equal(liftCoeff(0), 0);
  near(liftCoeff(0.1), (CL.c * Math.pow(0.1, CL.p)) / (1 + CL.q * 0.1), 1e-12);
  near(liftCoeff(2), liftCoeff(0.6), 1e-12);
  // Typical values: driver (S ~ 0.09) and wedge (S ~ 0.5) spin.
  assert.ok(liftCoeff(0.09) > 0.12 && liftCoeff(0.09) < 0.2);
  assert.ok(liftCoeff(0.5) > 0.32 && liftCoeff(0.5) < 0.42);
});

test('log wind profile: 1x at 10 m, weaker near the ground, floor at 0.5 m', () => {
  near(windFactor(10), 1, 1e-12);
  assert.ok(windFactor(2) < windFactor(10));
  assert.ok(windFactor(40) > 1.1 && windFactor(40) < 1.3);
  near(windFactor(0), windFactor(0.5), 1e-12);
  const w = windAt({ x: 3, y: -4 }, 10);
  near(w.x, 3, 1e-12);
  near(w.y, -4, 1e-12);
  assert.equal(w.z, 0);
});

test('flight accel: gravity at rest, drag opposes motion, backspin lifts', () => {
  const zero = { x: 0, y: 0, z: 0 };
  const a0 = flightAccel({ v: zero, w: zero, zAgl: 5 }, { x: 0, y: 0 });
  assert.deepEqual(a0, { x: 0, y: 0, z: -G });
  const a1 = flightAccel({ v: { x: 50, y: 0, z: 0 }, w: zero, zAgl: 5 }, { x: 0, y: 0 });
  near(a1.x, -AERO_K * dragCoeff(0, 50) * 50 * 50, 1e-9, 'pure drag');
  near(a1.z, -G, 1e-12);
  // Moving +x, right is -y; backspin w = spin * right gives upward lift.
  const a2 = flightAccel({ v: { x: 50, y: 0, z: 0 }, w: { x: 0, y: -300, z: 0 }, zAgl: 5 }, { x: 0, y: 0 });
  assert.ok(a2.z > -G + 5, `lift ${a2.z}`);
  assert.ok(a2.x < a1.x, 'spin adds drag');
});

test('wind: a headwind adds drag, a crosswind pushes downwind', () => {
  const st = { v: { x: 40, y: 0, z: 0 }, w: { x: 0, y: 0, z: 0 }, zAgl: 20 };
  const calm = flightAccel(st, { x: 0, y: 0 });
  const head = flightAccel(st, { x: -5, y: 0 });
  const tail = flightAccel(st, { x: 5, y: 0 });
  const cross = flightAccel(st, { x: 0, y: 5 });
  assert.ok(head.x < calm.x && tail.x > calm.x);
  assert.ok(cross.y > 0);
});
