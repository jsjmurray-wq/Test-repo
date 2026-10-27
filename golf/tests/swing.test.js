// Swing gestures (interpretSwing) and launch construction (swingToLaunch) from synthetic touch
// traces shaped like the ones input.js records: [{t ms, x, y}] from pointerdown to pointerup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { interpretSwing, swingToLaunch, DIFFICULTY, STRIKE_SPEED, PUTT_RANGES } from '../src/swing.js';
import { FULL_POWER_FRAC, PUTT_POWER_FRAC, MAX_POWER } from '../src/input.js';
import { clubById, dPlane } from '../src/clubs.js';
import { simulateShot, planeTerrain, puttSpeedForDistance } from '../src/physics.js';
import { mulberry32 } from '../src/rng.js';
import { SURF, SURFACES } from '../src/constants.js';
import { DEG } from '../src/vec3.js';

const H = 320; // padRefH
const HZ = 120;

// One swipe: drag straight down `depth` px in backMs, hold, then an upswing of arc length
// depth + follow along a circular arc whose chord points chordDeg right of straight up and whose
// heading turns by bendDeg (clockwise = bending right on screen). The upswing position follows
// s(tau) = L tau^ease over downMs (ease 1 = constant speed, > 1 = accelerating).
function trace({ depth = 100, x0 = 200, y0 = 500, backMs = 350, holdMs = 0, downMs = 300, follow = 70, chordDeg = 0, bendDeg = 0, ease = 1, release = 'end' } = {}) {
  const S = [];
  let t = 1000;
  const dt = 1000 / HZ;
  for (let k = 0; k <= Math.round((backMs / 1000) * HZ); k++) {
    const f = Math.min(1, (k * dt) / backMs);
    S.push({ t: t + k * dt, x: x0, y: y0 + depth * f });
  }
  t = S[S.length - 1].t;
  for (let k = 1; k <= Math.round((holdMs / 1000) * HZ); k++) S.push({ t: t + k * dt, x: x0, y: y0 + depth });
  t = S[S.length - 1].t;
  if (release === 'bottom') return S;
  // Arc: heading h(s) = h0 + bend s / L, chord heading = h0 + bend / 2.
  const L = depth + follow;
  const h0 = (chordDeg - bendDeg / 2) * DEG;
  const bend = bendDeg * DEG;
  const pos = (s) => {
    if (Math.abs(bend) < 1e-9) return { x: Math.sin(h0) * s, y: -Math.cos(h0) * s };
    const k = bend / L;
    // integrate (sin h, -cos h) ds with h = h0 + k s
    return { x: (Math.cos(h0) - Math.cos(h0 + k * s)) / k, y: -(Math.sin(h0 + k * s) - Math.sin(h0)) / k };
  };
  const bx = x0;
  const by = y0 + depth;
  const n = Math.max(2, Math.round((downMs / 1000) * HZ));
  for (let k = 1; k <= n; k++) {
    const tau = k / n;
    const s = L * Math.pow(tau, ease);
    const p = pos(s);
    S.push({ t: t + tau * downMs, x: bx + p.x, y: by + p.y });
  }
  if (release === 'mid') return S.filter((p) => p.y > y0 + depth * 0.5 || p.t <= t);
  return S;
}

const full = (S, o = {}) => interpretSwing(S, { padRefH: H, kind: 'full', difficulty: 'normal', handed: 'R', ...o });

test('a straight swipe: ok, straight start and no curve', () => {
  const r = full(trace());
  assert.equal(r.ok, true);
  assert.equal(r.startDir, 0);
  assert.equal(r.faceToPath, 0);
  assert.equal(r.label, 'Straight');
  assert.ok(Math.abs(r.power - 100 / (FULL_POWER_FRAC * H)) < 1e-9);
});

test('a chord angled right starts the ball right (push); left pulls', () => {
  const r = full(trace({ chordDeg: 20 }));
  assert.ok(r.ok);
  assert.ok(Math.abs(r.alpha - 20) < 0.5, `alpha ${r.alpha}`);
  // normal: (20 - 2) x 0.25
  assert.ok(Math.abs(r.startDir - 4.5) < 0.15, `startDir ${r.startDir}`);
  assert.ok(Math.abs(r.faceToPath) < 1e-9);
  assert.ok(r.label.startsWith('Push'));
  const l = full(trace({ chordDeg: -20 }));
  assert.ok(l.startDir < -4 && l.label.startsWith('Pull'));
  // clamped at +-10 deg
  assert.equal(full(trace({ chordDeg: 45, follow: 150 })).startDir, 10);
});

test('a swipe bending right gives faceToPath > 0 (slice for a right-hander); lefty flips it', () => {
  const r = full(trace({ bendDeg: 60 }));
  assert.ok(r.ok);
  // circular arc: kappa = bend / 2 = 30 deg -> (30 - 4) x 0.08
  assert.ok(Math.abs(r.kappa - 30) < 1.5, `kappa ${r.kappa}`);
  assert.ok(Math.abs(r.faceToPath - 2.08) < 0.15, `ftp ${r.faceToPath}`);
  assert.ok(Math.abs(r.startDir) < 0.2, 'the chord is still straight up');
  assert.equal(r.label, 'Fade');
  const hook = full(trace({ bendDeg: -150 }));
  assert.ok(hook.faceToPath < -4 && hook.label === 'Hook');
  const lefty = full(trace({ bendDeg: 60 }), { handed: 'L' });
  assert.ok(Math.abs(lefty.faceToPath + r.faceToPath) < 1e-9, 'left-handed flips the curvature');
  // for a lefty, curving left is the fade
  assert.equal(lefty.label, 'Fade');
  // D-plane split: start = path + k (face - path)
  assert.ok(Math.abs(r.path + 0.8 * r.faceToPath - r.startDir) < 1e-9);
  assert.ok(Math.abs(r.face - r.path - r.faceToPath) < 1e-9);
  const withClub = full(trace({ bendDeg: 60 }), { club: 'D' });
  const k = dPlane(clubById('D'), 1, 0).startDirDeg;
  assert.ok(Math.abs(withClub.path + k * withClub.faceToPath - withClub.startDir) < 1e-9);
  assert.ok(Math.abs(full(trace({ bendDeg: 400 })).faceToPath) <= 8);
});

test('power from the backswing depth; past full is overswing (capped at 1.1)', () => {
  const half = full(trace({ depth: 0.5 * FULL_POWER_FRAC * H }));
  assert.ok(half.ok && Math.abs(half.power - 0.5) < 1e-9 && !half.overswing);
  const over = full(trace({ depth: 1.08 * FULL_POWER_FRAC * H }));
  assert.ok(over.ok && over.overswing && Math.abs(over.power - 1.08) < 1e-9);
  const way = full(trace({ depth: 2 * FULL_POWER_FRAC * H, downMs: 250 }));
  assert.equal(way.power, MAX_POWER);
});

test('cancel: release in the backswing, a slow return, a tap, a flick that stops short', () => {
  assert.equal(full(trace({ release: 'bottom' })).reason, 'cancel');
  const atBottom = full(trace({ release: 'bottom', holdMs: 300 }));
  assert.equal(atBottom.ok, false);
  assert.equal(atBottom.reason, 'cancel');
  // Back up through the line at ~170 px/s: too slow.
  const slow = full(trace({ downMs: 1000 }));
  assert.equal(slow.ok, false);
  assert.equal(slow.reason, 'tooSlow');
  assert.ok(slow.power > 0.9, 'the power is still reported for the HUD');
  // A tap.
  const tap = full([{ t: 0, x: 100, y: 100 }, { t: 60, x: 101, y: 103 }]);
  assert.equal(tap.reason, 'short');
  assert.equal(full([]).reason, 'short');
  // Lifted half way back up, still moving: did not reach the impact line.
  assert.equal(full(trace({ release: 'mid' })).reason, 'cancel');
  // A fast flick lifted just short of the line (last sample 6 px below it) still strikes.
  const S = trace({ follow: 0, downMs: 80 });
  S[S.length - 1].y += 6;
  const lifted = full(S);
  assert.equal(lifted.ok, true);
});

test('strike speed threshold is STRIKE_SPEED px/s through the line', () => {
  // constant-speed upswings of 170 px over downMs: speed = 170000 / downMs px/s
  const fast = full(trace({ downMs: (170 / (STRIKE_SPEED * 1.1)) * 1000 }));
  const slow = full(trace({ downMs: (170 / (STRIKE_SPEED * 0.9)) * 1000 }));
  assert.equal(fast.ok, true);
  assert.equal(slow.reason, 'tooSlow');
});

test('tempo: rushed, smooth and decelerating downswings', () => {
  // Full power: ideal 0.25 s from the bottom to the line.
  const depth = FULL_POWER_FRAC * H;
  const smooth = full(trace({ depth, follow: 40, downMs: 300 }));
  assert.equal(smooth.tempo, 'smooth');
  const rushed = full(trace({ depth, follow: 40, downMs: 60 }));
  assert.equal(rushed.tempo, 'rushed');
  assert.ok(rushed.label.includes('Rushed'));
  // Creeping up 60 px at 100 px/s, then flicking through the line at 1000 px/s: a valid strike
  // after a 0.64 s downswing (over twice the ideal).
  const S = trace({ depth, release: 'bottom' });
  const b = S[S.length - 1];
  for (let k = 1; k <= 72; k++) S.push({ t: b.t + k * (600 / 72), x: b.x, y: b.y - (60 * k) / 72 });
  const m = S[S.length - 1];
  for (let k = 1; k <= 10; k++) S.push({ t: m.t + k * 8, x: m.x, y: m.y - 8 * k });
  const decel = full(S);
  assert.equal(decel.ok, true);
  assert.equal(decel.tempo, 'decel');
  assert.ok(decel.label.includes('Decel'));
});

test('dead zones and gains by difficulty', () => {
  const S = trace({ chordDeg: 1.5 });
  assert.equal(full(S).startDir, 0, 'normal ignores 1.5 deg');
  assert.ok(Math.abs(full(S, { difficulty: 'pro' }).startDir - 1.5 * DIFFICULTY.pro.gs) < 0.05);
  const S3 = trace({ chordDeg: 3.5 });
  assert.equal(full(S3, { difficulty: 'easy' }).startDir, 0, 'easy ignores 3.5 deg');
  const bend = trace({ bendDeg: 14 }); // kappa ~7
  assert.equal(full(bend, { difficulty: 'easy' }).faceToPath, 0);
  assert.ok(full(bend).faceToPath > 0);
  // Same input, bigger effect on harder settings.
  const big = trace({ chordDeg: 15, bendDeg: 60 });
  const e = full(big, { difficulty: 'easy' });
  const n = full(big);
  const p = full(big, { difficulty: 'pro' });
  assert.ok(e.startDir < n.startDir && n.startDir < p.startDir);
  assert.ok(e.faceToPath < n.faceToPath && n.faceToPath < p.faceToPath);
});

test('putt: depth maps to power, release strokes it, drift pushes or pulls, slow return cancels', () => {
  const putt = (S, o = {}) => interpretSwing(S, { padRefH: H, kind: 'putt', difficulty: 'normal', ...o });
  const depth = 0.5 * PUTT_POWER_FRAC * H;
  const S = trace({ depth, release: 'bottom', holdMs: 200 });
  const r = putt(S);
  assert.equal(r.ok, true);
  assert.ok(Math.abs(r.power - 0.5) < 1e-9);
  assert.equal(r.startDir, 0);
  assert.equal(r.faceToPath, 0);
  // A flick up strokes it too, with the same power (the deepest point).
  const flick = putt(trace({ depth, downMs: 150 }));
  assert.ok(flick.ok && Math.abs(flick.power - 0.5) < 1e-9);
  // Drift 20 px right during the last 150 ms: 20 x 0.08 = 1.6 deg minus the 2 px dead zone.
  const drift = S.map((p) => ({ ...p }));
  const tEnd = drift[drift.length - 1].t;
  for (const p of drift) if (p.t > tEnd - 150) p.x += (20 * (p.t - (tEnd - 150))) / 150;
  const pushed = putt(drift);
  assert.ok(Math.abs(pushed.startDir - 0.08 * 18) < 0.05, `${pushed.startDir}`);
  assert.equal(pushed.label, 'Pushed putt');
  for (const p of drift) if (p.t > tEnd - 150) p.x -= (80 * (p.t - (tEnd - 150))) / 150;
  assert.equal(putt(drift).startDir, -3, 'clamped to 3 deg');
  // Dragged back to the start slowly: cancelled. Tiny press: short.
  const back = trace({ depth, downMs: 1500, follow: 0 });
  assert.equal(putt(back).reason, 'cancel');
  assert.equal(putt([{ t: 0, x: 0, y: 0 }, { t: 50, x: 0, y: 4 }]).reason, 'short');
});

test('swingToLaunch putt: power x range is the flat roll-out', () => {
  const green = planeTerrain({ surface: SURF.GREEN });
  for (const range of [3, 9, 18]) {
    const sw = { ok: true, kind: 'putt', power: 0.6, startDir: 0 };
    const L = swingToLaunch('P', null, sw, 0, null, { pos: { x: 0, y: 0, z: 0 }, puttRange: range });
    assert.equal(L.mode, 'roll');
    assert.ok(Math.abs(L.meta.ballSpeed - puttSpeedForDistance(0.6 * range, SURFACES[SURF.GREEN])) < 1e-12);
    const r = simulateShot(green, L, { record: false });
    assert.ok(Math.abs(r.final.x - 0.6 * range) / (0.6 * range) < 0.02, `rolled ${r.final.x}`);
  }
  assert.ok(PUTT_RANGES.includes(9));
});

test('swingToLaunch full: speed factor, sign conventions and D-plane', () => {
  const c = clubById('7i');
  const sw = (o) => ({ ok: true, kind: 'full', power: 1, startDir: 0, faceToPath: 0, tempo: 'smooth', ...o });
  const L = swingToLaunch(c, null, sw(), Math.PI / 2, null);
  assert.ok(Math.abs(L.meta.ballSpeed - c.ballSpeed) < 1e-9);
  assert.ok(Math.abs(L.meta.spinRpm - c.spinRpm) < 1e-9);
  assert.ok(Math.abs(L.vel.x) < 1e-9 && L.vel.y > 0, 'aimYaw pi/2 flies north');
  const half = swingToLaunch(c, null, sw({ power: 0.5 }), 0, null);
  assert.ok(Math.abs(half.meta.ballSpeed - c.ballSpeed * 0.575) < 1e-9);
  const decel = swingToLaunch(c, null, sw({ tempo: 'decel' }), 0, null);
  assert.ok(Math.abs(decel.meta.ballSpeed - c.ballSpeed * 0.92) < 1e-9);
  // + startDir = right of the aim: aim north, so the ball heads east of north.
  const push = swingToLaunch(c, null, sw({ startDir: 4 }), Math.PI / 2, null);
  assert.ok(push.vel.x > 0);
  assert.ok(Math.abs(push.meta.startDirDeg - 4) < 1e-9);
  // + faceToPath tilts the axis right and the ball curves right.
  const fade = swingToLaunch(c, null, sw({ startDir: 0, faceToPath: 3 }), Math.PI / 2, null);
  assert.ok(fade.meta.tiltDeg > 0 && Math.abs(fade.meta.startDirDeg) < 1e-9);
  const flat = planeTerrain({});
  const straight = simulateShot(flat, swingToLaunch(c, null, sw(), Math.PI / 2, null), { record: false });
  const curved = simulateShot(flat, fade, { record: false });
  assert.ok(curved.landing.x > straight.landing.x + 3, `fade lands ${curved.landing.x} m right`);
  // Partial wedges spin less than the speed alone implies.
  const pw = clubById('PW');
  const p6 = swingToLaunch(pw, null, sw({ power: 0.6 }), 0, null);
  const speedRatio = 0.15 + 0.85 * 0.6;
  assert.ok(Math.abs(p6.meta.spinRpm - pw.spinRpm * speedRatio * (0.7 + 0.3 * 0.6)) < 1e-6);
});

test('swingToLaunch random contact: seeded, and overswing doubles the scatter', () => {
  const c = clubById('7i');
  const sw = (power) => ({ ok: true, kind: 'full', power, startDir: 0, faceToPath: 0, tempo: 'smooth' });
  const a = swingToLaunch(c, null, sw(1), 0, mulberry32(9));
  const b = swingToLaunch(c, null, sw(1), 0, mulberry32(9));
  assert.deepEqual(a, b);
  const spread = (power) => {
    const rng = mulberry32(4);
    let s2 = 0;
    const n = 400;
    for (let i = 0; i < n; i++) s2 += swingToLaunch(c, null, sw(power), 0, rng).meta.startDirDeg ** 2;
    return Math.sqrt(s2 / n);
  };
  const normal = spread(1);
  const over = spread(1.1);
  assert.ok(normal > 0.4 && normal < 0.9, `sigma ${normal}`);
  assert.ok(over / normal > 1.7 && over / normal < 2.3, `ratio ${over / normal}`);
});
