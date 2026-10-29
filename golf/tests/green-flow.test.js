// Flowing slope streaks (section 8.9): particles run downhill, faster on steeper greens, stay on
// the green, and the streak quads are finite and fill reused buffers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { slopeField, sampleSlope, FlowParticles, flowIndices, flowSpeed, FLOW_FLOATS, FLOW_MAX } from '../src/green-flow.js';
import { planeTerrain } from '../src/physics.js';
import { SURF } from '../src/constants.js';

// A tilted plane with an elliptical green (rx 14, ry 9, turned 0.4 rad) at the origin.
function greenPlane(sx, sy) {
  const green = { cx: 0, cy: 0, rx: 14, ry: 9, rot: 0.4 };
  const c = Math.cos(green.rot);
  const s = Math.sin(green.rot);
  const t = planeTerrain({
    sx, sy, z0: 5,
    surfaceFn: (x, y) => {
      const u = x * c + y * s;
      const v = -x * s + y * c;
      return (u / green.rx) ** 2 + (v / green.ry) ** 2 <= 1 ? SURF.GREEN : SURF.FRINGE;
    },
  });
  t.green = green;
  return t;
}

function run(t, secs = 2) {
  const f = slopeField(t);
  const p = new FlowParticles(f, { seed: 3 });
  const x0 = Float32Array.from(p.x);
  const y0 = Float32Array.from(p.y);
  const age0 = Float32Array.from(p.age);
  for (let k = 0; k < secs * 30; k++) p.step(1 / 30);
  // Mean displacement of the particles that did not respawn.
  let dx = 0;
  let dy = 0;
  let n = 0;
  for (let i = 0; i < p.n; i++) {
    if (p.age[i] < age0[i] + secs - 1e-3) continue; // respawned
    dx += p.x[i] - x0[i];
    dy += p.y[i] - y0[i];
    n++;
  }
  return { f, p, dx: dx / Math.max(1, n), dy: dy / Math.max(1, n), n };
}

test('slopeField samples the gradient, the height and the green mask', () => {
  const t = greenPlane(0.02, -0.01);
  const f = slopeField(t);
  const s = sampleSlope(f, 2, 1, { gx: 0, gy: 0, h: 0, mask: 0 });
  assert.ok(Math.abs(s.gx - 0.02) < 1e-6 && Math.abs(s.gy + 0.01) < 1e-6);
  assert.ok(Math.abs(s.h - t.heightAt(2, 1)) < 1e-4);
  assert.equal(s.mask, 1);
  assert.equal(sampleSlope(f, 40, 0, s).mask, 0);
  assert.ok(Math.abs(f.area - Math.PI * 14 * 9) / (Math.PI * 14 * 9) < 0.08);
});

test('particles run downhill, faster on steeper ground, and stay on the green', () => {
  const gentle = run(greenPlane(0.008, 0));
  const steep = run(greenPlane(0.035, 0));
  assert.ok(steep.n > 20 && gentle.n > 20);
  // Downhill is -x on both.
  assert.ok(gentle.dx < -0.01 && Math.abs(gentle.dy) < Math.abs(gentle.dx) * 0.2, `gentle ${gentle.dx}, ${gentle.dy}`);
  assert.ok(steep.dx < gentle.dx * 3, `steep ${steep.dx} vs gentle ${gentle.dx}`);
  const diag = run(greenPlane(-0.02, -0.02));
  assert.ok(diag.dx > 0.1 && diag.dy > 0.1 && Math.abs(diag.dx - diag.dy) < 0.05 * Math.abs(diag.dx) + 1e-3);
  for (const r of [gentle, steep, diag]) {
    const s = { gx: 0, gy: 0, h: 0, mask: 0 };
    for (let i = 0; i < r.p.n; i++) assert.ok(sampleSlope(r.f, r.p.x[i], r.p.y[i], s).mask >= 0.5);
  }
  assert.ok(flowSpeed(4) > flowSpeed(1) && flowSpeed(0) > 0 && flowSpeed(50) <= 1.2);
});

test('a flat green: particles barely move and show no streaks', () => {
  const flat = run(greenPlane(0, 0));
  assert.ok(Math.abs(flat.dx) < 1e-6 && Math.abs(flat.dy) < 1e-6);
  for (let i = 0; i < flat.p.n; i++) assert.equal(flat.p.alpha(i), 0);
});

test('streak quads: count, finite camera-relative vertices, reused buffer, bounded count', () => {
  const t = greenPlane(0.02, 0.01);
  const f = slopeField(t);
  const p = new FlowParticles(f, { seed: 9 });
  assert.ok(p.n > 50 && p.n <= FLOW_MAX);
  const out = new Float32Array(FLOW_MAX * 4 * FLOW_FLOATS);
  const eye = { x: -20, y: -5, z: 12 };
  p.step(0.05);
  const m = p.writeQuads(out, eye, { pxPerRad: 1000 });
  assert.equal(m, p.n);
  for (let k = 0; k < m * 4 * FLOW_FLOATS; k++) assert.ok(Number.isFinite(out[k]));
  // Heads (u = 1) sit at the particle, camera-relative.
  assert.ok(Math.abs(out[2 * FLOW_FLOATS] + out[3 * FLOW_FLOATS] - 2 * (p.x[0] - eye.x)) < 1e-3);
  const small = new Float32Array(10 * 4 * FLOW_FLOATS);
  assert.equal(p.writeQuads(small, eye), 10);
  assert.equal(new FlowParticles(f, { count: 5000 }).n, FLOW_MAX);
  const idx = flowIndices(3);
  assert.deepEqual([...idx.slice(6, 12)], [4, 5, 6, 5, 7, 6]);
});
