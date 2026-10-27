import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dragCoeff, liftCoeff, windAt, windFactor, flightAccel, AERO_K } from '../src/aero.js';
import { G } from '../src/constants.js';

const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ''} ${a} vs ${b}`);

test('drag and lift coefficients follow the fits and clamp S to [0, 0.6]', () => {
  near(dragCoeff(0), 0.24, 1e-12);
  near(dragCoeff(0.2), 0.24 + 0.036, 1e-12);
  near(dragCoeff(5), 0.24 + 0.18 * 0.6, 1e-12);
  near(dragCoeff(-1), 0.24, 1e-12);
  assert.equal(liftCoeff(0), 0);
  near(liftCoeff(0.1), 0.54 * Math.pow(0.1, 0.4), 1e-12);
  near(liftCoeff(2), 0.54 * Math.pow(0.6, 0.4), 1e-12);
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
  near(a1.x, -AERO_K * 0.24 * 50 * 50, 1e-9, 'pure drag');
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
