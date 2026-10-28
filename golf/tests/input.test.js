// Pure gesture helpers from input.js (no DOM needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  padRectFor, layoutMode, swingProgress, aimDelta, orbitDelta, isTap, inRect,
  fullPowerPx, powerFromRaw, powerFromDepth, depthForPower, snapPower, onTarget, meterRaw, meterPower, draggedOut,
  MAX_POWER, DETENT_LO, DETENT_HI, OVERSWING_FROM, EASY_SNAP, TARGET_GLOW, METER_FILL_S, SIDE_OUT_PX,
} from '../src/input.js';

test('layoutMode thresholds match the pool game', () => {
  assert.equal(layoutMode(393, 852), 'portrait');
  assert.equal(layoutMode(852, 393), 'landscape');
  assert.equal(layoutMode(820, 1180 * 0.8), 'square');
});

test('portrait pad is the lower 45% above the bottom safe inset, full width', () => {
  const r = padRectFor(393, 852, { bottom: 34 });
  assert.equal(r.x, 0);
  assert.equal(r.w, 393);
  assert.equal(r.h, Math.round(818 * 0.45));
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

test('full-power travel is a comfortable thumb distance: 0.55 x pad height, 140-220 px (putts 0.5 x, 110-200 px)', () => {
  assert.equal(fullPowerPx(300), 165);
  assert.equal(fullPowerPx(200), 140);
  assert.equal(fullPowerPx(600), 220);
  assert.equal(fullPowerPx(300, 'putt'), 150);
  assert.equal(fullPowerPx(150, 'putt'), 110);
  assert.equal(fullPowerPx(600, 'putt'), 200);
  // An iPhone 15 in portrait (pad 368 px) and landscape (pad 268 px).
  assert.ok(Math.abs(fullPowerPx(padRectFor(393, 852, { bottom: 34 }).h) - 202.4) < 0.1);
  assert.ok(Math.abs(fullPowerPx(padRectFor(852, 393, { bottom: 21 }).h) - 147.4) < 0.1);
  // Ten pixels are now a few percent of power, not ten.
  const H = 368;
  assert.ok(powerFromDepth(110, H) - powerFromDepth(100, H) < 0.055);
});

test('power curve: 1:1 up to 80%, a detent holding exactly full power from 0.95 to 1.12 x travel, then overswing', () => {
  // 25/50/75% of the travel reads 25/50/75%: the gauge ticks are where the finger is.
  for (const f of [0.1, 0.25, 0.5, 0.75, 0.8]) assert.ok(Math.abs(powerFromRaw(f) - f) < 1e-12);
  // Continuous and monotone everywhere (no jumps a player could fall into).
  let prev = 0;
  for (let r = 0; r <= 1.4; r += 0.001) {
    const p = powerFromRaw(r);
    assert.ok(p >= prev - 1e-12 && p - prev < 0.002, `jump at ${r}: ${prev} -> ${p}`);
    prev = p;
  }
  for (const r of [DETENT_LO, 0.97, 1, DETENT_HI, 1.1, OVERSWING_FROM]) assert.equal(powerFromRaw(r), 1, `raw ${r}`);
  assert.ok(powerFromRaw(0.9) > 0.9 && powerFromRaw(0.9) < 1);
  assert.ok(Math.abs(powerFromRaw(1.17) - 1.05) < 1e-9);
  assert.equal(powerFromRaw(1.5), MAX_POWER);
  // Putts are linear (pace needs every pixel) and cap at MAX_POWER.
  assert.equal(powerFromRaw(0.97, 'putt'), 0.97);
  assert.equal(powerFromRaw(1.05, 'putt'), 1.05);
  assert.equal(powerFromRaw(2, 'putt'), MAX_POWER);
});

test('depthForPower inverts powerFromDepth', () => {
  for (const H of [268, 368, 450]) {
    for (const kind of ['full', 'putt']) {
      for (const p of [0, 0.2, 0.5, 0.83, 0.9, 0.99, 1, 1.04, 1.1]) {
        const d = depthForPower(p, H, kind);
        assert.ok(Math.abs(powerFromDepth(d, H, kind) - p) < 1e-9, `${kind} ${H} ${p}`);
      }
    }
  }
  // Full power is the middle of the detent: the most forgiving place to aim for.
  const mid = depthForPower(1, 368) / fullPowerPx(368);
  assert.ok(mid > DETENT_LO && mid < DETENT_HI);
});

test('swingProgress: depth below touchdown maps to power through the same curve, held during the downswing', () => {
  const H = 368;
  const s = (ys) => ys.map((y, i) => ({ t: i * 16, x: 100, y }));
  const half = swingProgress(s([100, 100 + 0.5 * fullPowerPx(H)]), H, 'full');
  assert.ok(Math.abs(half.power - 0.5) < 1e-9);
  assert.equal(half.phase, 'back');
  assert.equal(half.overswing, false);
  assert.equal(half.full, false);
  const atFull = swingProgress(s([100, 100 + 1.08 * fullPowerPx(H)]), H, 'full');
  assert.ok(atFull.power === 1 && atFull.full && !atFull.overswing);
  const over = swingProgress(s([100, 100 + 5 * H]), H, 'full');
  assert.equal(over.power, MAX_POWER);
  assert.equal(over.overswing, true);
  const putt = swingProgress(s([100, 100 + fullPowerPx(H, 'putt')]), H, 'putt');
  assert.ok(Math.abs(putt.power - 1) < 1e-9 && !putt.full);
  // The gauge holds the backswing while the finger travels up.
  const ys = [100, 140, 180, 196, 150, 100, 40];
  const p = swingProgress(s(ys), H);
  assert.equal(p.maxDepth, 96);
  assert.equal(p.depth, 0);
  assert.equal(p.phase, 'down');
  assert.ok(Math.abs(p.power - powerFromDepth(96, H)) < 1e-12);
  assert.equal(swingProgress([], H).power, 0);
});

test('target notch: glows within TARGET_GLOW, Easy snaps within EASY_SNAP', () => {
  assert.ok(onTarget(0.62, 0.62 + TARGET_GLOW * 0.9));
  assert.ok(!onTarget(0.62, 0.62 + TARGET_GLOW * 1.2));
  assert.ok(!onTarget(0.62, null));
  assert.equal(snapPower(0.6, 0.6 + EASY_SNAP * 0.9, 'easy'), 0.6 + EASY_SNAP * 0.9);
  assert.equal(snapPower(0.6, 0.6 - EASY_SNAP * 0.9, 'easy'), 0.6 - EASY_SNAP * 0.9);
  assert.equal(snapPower(0.6, 0.6 + EASY_SNAP * 1.1, 'easy'), 0.6);
  assert.equal(snapPower(0.6, 0.62, 'normal'), 0.6);
  assert.equal(snapPower(0.6, 0.62, 'pro'), 0.6);
  assert.equal(snapPower(0.6, null, 'easy'), 0.6);
});

test('tap meter: power fills 0 -> 1.1 over 1.4 s (hanging at full), falls back, then expires', () => {
  assert.equal(meterPower(0), 0);
  assert.ok(Math.abs(meterPower(METER_FILL_S) - MAX_POWER) < 1e-9);
  assert.ok(Math.abs(meterPower(METER_FILL_S, 'putt') - MAX_POWER) < 1e-9);
  assert.ok(Math.abs(meterPower(2 * METER_FILL_S)) < 1e-9);
  assert.equal(meterPower(2 * METER_FILL_S + 0.01), null);
  assert.equal(meterRaw(3), null);
  // Rising and falling symmetrically.
  for (const t of [0.2, 0.7, 1.1, 1.3]) assert.ok(Math.abs(meterPower(t) - meterPower(2 * METER_FILL_S - t)) < 1e-9);
  // Full power holds for about 0.2 s on the way up (the detent), so it can be timed.
  let held = 0;
  for (let t = 0; t <= METER_FILL_S; t += 0.001) if (meterPower(t) === 1) held += 0.001;
  assert.ok(held > 0.17 && held < 0.23, `held ${held} s`);
  // Putts fill linearly.
  assert.ok(Math.abs(meterPower(0.7, 'putt') - 0.55) < 1e-9);
});

test('draggedOut: more than SIDE_OUT_PX sideways out of the pad during the backswing only', () => {
  const pad = padRectFor(852, 393, { right: 47, bottom: 21 });
  const x0 = pad.x + 30;
  const y0 = pad.y + 30;
  const tr = (pts) => pts.map(([dx, dy], i) => ({ t: i * 16, x: x0 + dx, y: y0 + dy }));
  assert.equal(draggedOut(tr([[0, 0], [0, 60], [0, 120]]), pad), false);
  // 30 px inside the left edge + 100 px left = 70 px out: still a swing.
  assert.equal(draggedOut(tr([[0, 0], [0, 60], [-100, 110]]), pad), false);
  // 130 px left = 100 px out, while still going down: abandoned.
  assert.equal(draggedOut(tr([[0, 0], [0, 60], [-130, 110]]), pad), true);
  assert.equal(draggedOut(tr([[0, 0], [0, 60], [-30 - SIDE_OUT_PX - 1, 60]]), pad), true);
  // ...but a follow-through that sweeps out of the pad on the way up is fine.
  assert.equal(draggedOut(tr([[0, 0], [0, 120], [-60, 60], [-200, -40]]), pad), false);
  // Portrait: the pad is the full width, so a thumb cannot leave it sideways.
  const portrait = padRectFor(393, 852, { bottom: 34 });
  assert.equal(draggedOut([{ t: 0, x: 380, y: 500 }, { t: 16, x: 393, y: 560 }], portrait), false);
  assert.equal(draggedOut([], pad), false);
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
