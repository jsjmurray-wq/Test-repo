// Pure gesture helpers from input.js (no DOM needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  padRectFor, layoutMode, swingProgress, aimDelta, orbitDelta, isTap, inRect,
  FULL_POWER_FRAC, PUTT_POWER_FRAC, MAX_POWER,
} from '../src/input.js';

test('layoutMode thresholds match the pool game', () => {
  assert.equal(layoutMode(393, 852), 'portrait');
  assert.equal(layoutMode(852, 393), 'landscape');
  assert.equal(layoutMode(820, 1180 * 0.8), 'square');
});

test('portrait pad is the lower 40% above the bottom safe inset, full width', () => {
  const r = padRectFor(393, 852, { bottom: 34 });
  assert.equal(r.x, 0);
  assert.equal(r.w, 393);
  assert.equal(r.h, Math.round(818 * 0.4));
  assert.equal(r.y + r.h, 818);
});

test('landscape pad sits on the right, clear of the right safe inset', () => {
  const r = padRectFor(852, 393, { right: 47, bottom: 21 });
  assert.ok(r.x > 852 / 2);
  assert.equal(r.x + r.w, 852 - 47);
  assert.equal(r.y + r.h, 393 - 21);
  assert.ok(r.h > 393 * 0.6);
  assert.ok(inRect(r, r.x + 5, r.y + 5));
  assert.ok(!inRect(r, 10, 10));
});

test('swingProgress: depth below touchdown maps to power, capped at MAX_POWER', () => {
  const H = 300;
  const s = (ys) => ys.map((y, i) => ({ t: i * 16, x: 100, y }));
  const half = swingProgress(s([100, 100 + 0.5 * FULL_POWER_FRAC * H]), H, 'full');
  assert.ok(Math.abs(half.power - 0.5) < 1e-9);
  assert.equal(half.phase, 'back');
  assert.equal(half.overswing, false);
  const over = swingProgress(s([100, 100 + 5 * H]), H, 'full');
  assert.equal(over.power, MAX_POWER);
  assert.equal(over.overswing, true);
  // Putts use a slightly shorter reference travel.
  const putt = swingProgress(s([100, 100 + PUTT_POWER_FRAC * H]), H, 'putt');
  assert.ok(Math.abs(putt.power - 1) < 1e-9);
});

test('swingProgress holds the backswing power during the downswing', () => {
  const H = 300;
  const ys = [100, 140, 180, 196, 150, 100, 40];
  const p = swingProgress(ys.map((y, i) => ({ t: i * 16, x: 100, y })), H);
  assert.equal(p.maxDepth, 96);
  assert.equal(p.depth, 0);
  assert.equal(p.phase, 'down');
  assert.ok(Math.abs(p.power - 96 / (FULL_POWER_FRAC * H)) < 1e-9);
  assert.equal(swingProgress([], H).power, 0);
});

test('aimDelta: drag right turns clockwise (yaw decreases); faster drags turn more per px', () => {
  assert.ok(aimDelta(10, 100) < 0);
  assert.ok(aimDelta(-10, 100) > 0);
  const slow = Math.abs(aimDelta(10, 100)); // 100 px/s
  const fast = Math.abs(aimDelta(10, 5)); // 2000 px/s
  assert.ok(fast > 2 * slow);
  assert.ok(fast <= 3 * slow + 1e-12);
  assert.ok(orbitDelta(10) < 0);
});

test('isTap', () => {
  assert.ok(isTap({ t: 0, x: 0, y: 0 }, { t: 120, x: 4, y: 3 }));
  assert.ok(!isTap({ t: 0, x: 0, y: 0 }, { t: 120, x: 30, y: 0 }));
  assert.ok(!isTap({ t: 0, x: 0, y: 0 }, { t: 900, x: 0, y: 0 }));
});
