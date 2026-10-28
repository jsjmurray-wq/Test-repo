// Swing gestures (interpretSwing) and launch construction (swingToLaunch) from synthetic touch
// traces shaped like the ones input.js records: [{t ms, x, y}] from pointerdown to pointerup.
// Two kinds of trace: trace() is an idealised 120 Hz swipe for the direction / curve / tempo
// maths, and phoneSwipe() imitates what an iPhone actually reports for a thumb (60 Hz, jitter,
// coalesced and dropped events, no events while the finger is still) for the recognition rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  interpretSwing, swingToLaunch, powerForDistance, DIFFICULTY, PUTT_RANGES, PARTIAL_LAUNCH, DECEL_SPEED,
  STRIKE_CLIMB_PX, STRIKE_CLIMB_FRAC,
} from '../src/swing.js';
import { fullPowerPx, powerFromDepth, depthForPower, padRectFor, MAX_POWER, EASY_SNAP } from '../src/input.js';
import { clubById, dPlane } from '../src/clubs.js';
import { simulateShot, planeTerrain, puttSpeedForDistance } from '../src/physics.js';
import { mulberry32, gaussian } from '../src/rng.js';
import { SURF, SURFACES } from '../src/constants.js';
import { DEG } from '../src/vec3.js';
import { curveAt } from '../src/caddie.js';

const H = 368; // padRefH: the portrait pad of a 393 x 852 iPhone (lower 45% above a 34 px inset)
const FULL = fullPowerPx(H); // ~202 px of travel for full power
const PUTT = fullPowerPx(H, 'putt');
const HZ = 120;

// One idealised swipe: drag straight down `depth` px in backMs, hold, then an upswing of arc
// length depth + follow along a circular arc whose chord points chordDeg right of straight up and
// whose heading turns by bendDeg (clockwise = bending right on screen). The upswing position
// follows s(tau) = L tau^ease over downMs (ease 1 = constant speed, > 1 = accelerating).
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

// A thumb swipe as iOS Safari reports it. The finger path is a list of moves from the touchdown
// point: [ms, dx, dy, ease] (relative, cumulative); ease 'inout' (default: a deliberate move that
// starts and stops gently), 'in' (accelerating: a flick), 'out' (decelerating) or 'linear'. A move
// with dx = dy = 0 is a pause: a still finger fires no touch events (or, with restJitter, a few
// events of +-1 px, as a resting thumb sometimes does). Sampling: 60 Hz with +-2 ms timing jitter,
// position noise (sigma `noise` px) on a 1/3 px grid (a 3x screen), iOS-like coalescing (now and
// then a touch arrives sharing the previous event's timestamp) and dropped frames. The release
// adds the pointerup point when it differs from the last move, exactly as input.js does; with
// liftMoves = false the lift reports no new position (the last move is all there is).
function phoneSwipe(moves, { x0 = 196, y0 = 520, seed = 1, hz = 60, noise = 0.5, coalesce = 0.25, drop = 0.06, restJitter = false, liftMoves = true } = {}) {
  const rng = mulberry32(seed);
  const keys = [{ t: 0, x: x0, y: y0 }];
  for (const [ms, dx, dy, ease = 'inout'] of moves) {
    const k = keys[keys.length - 1];
    keys.push({ t: k.t + ms, x: k.x + dx, y: k.y + dy, ease });
  }
  const easeF = {
    linear: (f) => f,
    in: (f) => f * f,
    out: (f) => 1 - (1 - f) * (1 - f),
    inout: (f) => 0.5 - 0.5 * Math.cos(Math.PI * f),
  };
  const at = (t) => {
    let i = 1;
    while (i < keys.length - 1 && keys[i].t < t) i++;
    const a = keys[i - 1];
    const b = keys[i];
    const f = b.t > a.t ? Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t))) : 1;
    const e = easeF[b.ease](f);
    return { x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e, still: a.x === b.x && a.y === b.y };
  };
  const q = (v) => Math.round(v * 3) / 3;
  const T0 = 1000;
  const S = [{ t: T0, x: x0, y: y0 }];
  let prevT = T0;
  const end = keys[keys.length - 1];
  for (let k = 1; k * (1000 / hz) < end.t; k++) {
    const tk = k * (1000 / hz);
    const p = at(tk);
    if (p.still && !(restJitter && rng() < 0.25)) continue;
    if (rng() < drop) continue;
    let ts = T0 + tk + (rng() - 0.5) * 4;
    if (rng() < coalesce && ts - prevT < 1.5 * (1000 / hz)) ts = prevT; // delivered with the previous frame's event
    ts = Math.max(ts, prevT);
    const j = p.still ? Math.round(rng() * 2 - 1) : 0;
    S.push({ t: ts, x: q(p.x + gaussian(rng) * noise), y: q(p.y + j + gaussian(rng) * noise) });
    prevT = ts;
  }
  const up = { t: Math.max(T0 + end.t, prevT), x: q(end.x), y: q(end.y) };
  const last = S[S.length - 1];
  if (liftMoves && (up.x !== last.x || up.y !== last.y)) S.push(up);
  return S;
}

const opts = (o = {}) => ({ padRefH: H, kind: 'full', difficulty: 'normal', handed: 'R', ...o });
const full = (S, o = {}) => interpretSwing(S, opts(o));
const putt = (S, o = {}) => interpretSwing(S, opts({ kind: 'putt', ...o }));
const thrFor = (depth) => Math.max(STRIKE_CLIMB_PX, STRIKE_CLIMB_FRAC * depth);

// ------------------------------------------------------------------ power

test('power: the backswing depth through the shared gauge mapping (50% travel = 50% power, detent at full)', () => {
  const r = full(trace());
  assert.equal(r.ok, true);
  assert.ok(Math.abs(r.power - powerFromDepth(100, H)) < 1e-12);
  const half = full(trace({ depth: 0.5 * FULL }));
  assert.ok(half.ok && Math.abs(half.power - 0.5) < 1e-9 && !half.overswing);
  // Anywhere from 95% to 112% of the full-power travel is exactly full power.
  for (const f of [0.95, 1, 1.06, 1.1, 1.12]) {
    const s = full(trace({ depth: f * FULL, downMs: 250 }));
    assert.ok(s.ok && s.power === 1 && !s.overswing, `${f} x travel -> ${s.power}`);
  }
  const over = full(trace({ depth: depthForPower(1.06, H), downMs: 250 }));
  assert.ok(over.ok && over.overswing && Math.abs(over.power - 1.06) < 1e-9);
  assert.equal(full(trace({ depth: 2 * FULL, downMs: 250 })).power, MAX_POWER);
  // Putts: their own, shorter travel, linear.
  const p = putt(trace({ depth: 0.5 * PUTT, release: 'bottom', holdMs: 200 }));
  assert.ok(p.ok && Math.abs(p.power - 0.5) < 1e-9);
});

test('Easy snaps the power onto the target notch within EASY_SNAP; other levels never do', () => {
  const S = trace({ depth: depthForPower(0.62, H) });
  assert.ok(Math.abs(full(S).power - 0.62) < 1e-9);
  assert.equal(full(S, { difficulty: 'easy', target: 0.62 + EASY_SNAP * 0.9 }).power, 0.62 + EASY_SNAP * 0.9);
  assert.ok(Math.abs(full(S, { difficulty: 'easy', target: 0.62 + EASY_SNAP * 1.2 }).power - 0.62) < 1e-9);
  assert.ok(Math.abs(full(S, { difficulty: 'normal', target: 0.64 }).power - 0.62) < 1e-9);
  assert.ok(Math.abs(full(S, { difficulty: 'easy', target: null }).power - 0.62) < 1e-9);
  const P = trace({ depth: 0.4 * PUTT, release: 'bottom', holdMs: 100 });
  assert.equal(putt(P, { difficulty: 'easy', target: 0.43 }).power, 0.43);
});

test('powerForDistance inverts a power curve (the target notch)', () => {
  const curve = [0.1, 0.25, 0.4, 0.55, 0.7, 0.85, 1, 1.1].map((power) => ({ power, carry: 150 * power ** 0.9, total: 160 * power ** 0.9 }));
  const carryAt = (p) => curveAt(curve, p).carry;
  for (const want of [10, 60, 110, 149]) {
    const p = powerForDistance(carryAt, want);
    assert.ok(Math.abs(carryAt(p) - want) < 0.01, `${want} m -> ${p}`);
  }
  assert.equal(powerForDistance(carryAt, 151), null, 'out of reach at full power');
  assert.ok(powerForDistance(carryAt, 151, MAX_POWER) > 1, 'reachable with overswing if allowed');
  assert.equal(powerForDistance(carryAt, 0), 0);
});

// ------------------------------------------------------------------ recognition on phone traces

test('short flicks (40-60 px up) after any backswing strike', () => {
  let seed = 1;
  for (const depth of [70, 120, 160, 200, 230]) {
    for (const flick of [40, 50, 60]) {
      for (const ms of [35, 60, 90]) {
        const S = phoneSwipe([[420, 0, depth], [ms, 2, -flick, 'in']], { seed: seed++ });
        const r = full(S);
        assert.equal(r.ok, true, `depth ${depth}, ${flick} px flick in ${ms} ms: ${r.reason}`);
        assert.ok(Math.abs(r.power - powerFromDepth(depth, H)) < 0.03, `power ${r.power}`);
        assert.ok(r.strike === 'climb' || r.strike === 'release');
      }
    }
  }
});

test('a flick that never gets back to the start line strikes, whether lifted moving or after stopping', () => {
  // 180 px backswing, a quick 100 px flick (well short of the line), lifted while still moving.
  const moving = full(phoneSwipe([[450, 0, 180], [110, -3, -100, 'in']], { seed: 3 }));
  assert.ok(moving.ok && moving.tempo === 'smooth', `${moving.reason} ${moving.tempo}`);
  // The same flick stopping and resting 200 ms before the thumb lifts.
  const stopped = full(phoneSwipe([[450, 0, 180], [130, -3, -100, 'out'], [200, 0, 0]], { seed: 4, restJitter: true }));
  assert.ok(stopped.ok && stopped.strike === 'climb', `${stopped.reason}`);
});

test('slow deliberate swings strike; only a really slow climb is decel', () => {
  // A careful 180 px backswing, a pause, then a smooth 250 px upswing over 0.9 s (about 280 px/s).
  const careful = full(phoneSwipe([[700, -4, 180], [300, 0, 0], [900, 6, -250]], { seed: 5 }));
  assert.equal(careful.ok, true);
  assert.equal(careful.tempo, 'smooth', `${careful.upSpeed} px/s`);
  // Creeping back up 120 px at under 100 px/s: still a stroke, but a decelerating one.
  const creep = full(phoneSwipe([[600, 0, 200], [1500, 0, -120, 'linear']], { seed: 6 }));
  assert.equal(creep.ok, true);
  assert.equal(creep.tempo, 'decel');
  assert.ok(creep.label.includes('Decel'));
});

test('a pause at the bottom (no touch events) does not spoil the flick', () => {
  for (const pause of [0, 150, 400, 900]) {
    const r = full(phoneSwipe([[400, 0, 170], [pause, 0, 0], [150, 0, -230, 'in']], { seed: 7 + pause }));
    assert.equal(r.ok, true, `pause ${pause}`);
    assert.equal(r.tempo, 'smooth', `pause ${pause}: ${r.downswingS} s, ${r.upSpeed} px/s`);
    assert.ok(r.downswingS < 0.2, `the pause is not downswing time (${r.downswingS} s)`);
  }
});

test('released mid-upswing (still moving fast) strikes', () => {
  // Heading for 260 px up at about 1 m/s... but the thumb comes off after 70 px.
  const r = full(phoneSwipe([[380, 0, 200], [70, 0, -70, 'linear']], { seed: 9 }));
  assert.equal(r.ok, true, r.reason);
  // The same with a very shallow backswing and a 20 px flick.
  const tiny = full(phoneSwipe([[250, 0, 45], [25, 0, -20, 'in']], { seed: 10 }));
  assert.equal(tiny.ok, true, tiny.reason);
});

test('a 2 px wobble at the bottom, then release, cancels (it is not a hit)', () => {
  for (let seed = 1; seed <= 30; seed++) {
    const S = phoneSwipe([[420, 0, 180], [150, 0, 0], [70, 0, -2], [70, 0, 2], [60, 1, -2], [100, 0, 0]], { seed, restJitter: true });
    const r = full(S);
    assert.equal(r.ok, false, `seed ${seed}: ${r.strike}`);
    assert.equal(r.reason, 'cancel');
  }
  // Holding still at the bottom and lifting.
  assert.equal(full(phoneSwipe([[400, 0, 150], [500, 0, 0]], { restJitter: true })).reason, 'cancel');
  assert.equal(full(trace({ release: 'bottom', holdMs: 300 })).reason, 'cancel');
});

test('a waggle that ends at the bottom cancels; a waggle then a swing strikes', () => {
  const waggle = full(phoneSwipe([[400, 0, 200], [300, 0, -60], [300, 0, 55], [200, 0, 0]], { seed: 11 }));
  assert.equal(waggle.reason, 'cancel');
  const swing = full(phoneSwipe([[400, 0, 200], [300, 0, -60], [300, 0, 55], [150, 0, -200, 'in']], { seed: 12 }));
  assert.equal(swing.ok, true);
  assert.ok(Math.abs(swing.power - powerFromDepth(200, H)) < 0.03, 'the power is the deepest point');
});

test('dragging sideways out of the pad during the backswing cancels (landscape pad)', () => {
  const pad = padRectFor(852, 393, { right: 47, bottom: 21 });
  const x0 = pad.x + 40;
  const y0 = pad.y + 40;
  const o = { padRect: pad, padRefH: pad.h };
  // Down 120 px, then drag 160 px left (120 px past the pad's edge), lift.
  const out = full(phoneSwipe([[350, 0, 120], [300, -160, 10]], { x0, y0, seed: 13 }), o);
  assert.equal(out.reason, 'cancel');
  // ...even if the thumb then swipes up from out there.
  const outUp = full(phoneSwipe([[350, 0, 120], [300, -160, 10], [120, 0, -150, 'in']], { x0, y0, seed: 14 }), o);
  assert.equal(outUp.reason, 'cancel');
  // A slanted backswing that strays 60 px out of the pad still swings, and so does a follow-through
  // that sweeps far out of the pad on the way up.
  const slant = full(phoneSwipe([[350, -100, 110], [130, 30, -160, 'in']], { x0, y0, seed: 15 }), o);
  assert.equal(slant.ok, true);
  const sweep = full(phoneSwipe([[350, 0, 120], [140, -260, -150, 'in']], { x0, y0, seed: 16 }), o);
  assert.equal(sweep.ok, true);
});

test('a press with no backswing is a slip ("short"), not a swing', () => {
  assert.equal(full([{ t: 0, x: 100, y: 100 }, { t: 60, x: 101, y: 103 }]).reason, 'short');
  assert.equal(full([]).reason, 'short');
  assert.equal(full(phoneSwipe([[90, 1, 5], [40, 0, -30, 'in']], { seed: 17 })).reason, 'short');
});

test('fuzz: 300 human swings all strike, 300 hold-and-lift aborts all cancel', () => {
  const rng = mulberry32(2024);
  const U = (a, b) => a + (b - a) * rng();
  for (let i = 0; i < 300; i++) {
    const depth = U(40, 260);
    const moves = [[U(220, 900), U(-30, 30), depth, rng() < 0.5 ? 'inout' : 'out']];
    if (rng() < 0.5) moves.push([U(30, 500), 0, 0]);
    const thr = thrFor(depth);
    if (rng() < 0.4) {
      // a short flick, lifted while moving (or within a frame or two of stopping)
      // (a thumb flick lasts a few frames, however fast it is)
      const len = U(25, Math.max(30, thr));
      const speed = U(400, 2500);
      moves.push([Math.max(50, (len / speed) * 1000), U(-10, 10), -len, rng() < 0.7 ? 'in' : 'linear']);
    } else {
      // a full upswing at any speed, maybe resting at the top before the lift
      const len = U(thr + 8, depth + 220);
      const speed = U(130, 2800);
      moves.push([(len / speed) * 1000, U(-60, 60), -len, ['inout', 'in', 'linear'][Math.floor(rng() * 3)]]);
      if (rng() < 0.3) moves.push([U(20, 300), 0, 0]);
    }
    const S = phoneSwipe(moves, { seed: 100 + i, hz: rng() < 0.3 ? 120 : 60, restJitter: rng() < 0.5, liftMoves: rng() < 0.5 });
    const r = full(S);
    assert.equal(r.ok, true, `swing ${i}: ${JSON.stringify(moves.map((m) => m.map((v) => (typeof v === 'number' ? Math.round(v) : v))))} -> ${r.reason}`);
    assert.ok(Math.abs(r.power - powerFromDepth(depth, H)) < 0.035, `swing ${i}: power ${r.power}`);
  }
  for (let i = 0; i < 300; i++) {
    const depth = U(30, 260);
    const moves = [[U(220, 900), U(-30, 30), depth], [U(0, 600), 0, 0]];
    // a little settle of the thumb (up to 4 px up or down) and a rest before the lift
    if (rng() < 0.6) moves.push([U(40, 160), U(-2, 2), U(-4, 4)], [U(60, 300), 0, 0]);
    const r = full(phoneSwipe(moves, { seed: 1000 + i, restJitter: true, noise: 0.7 }));
    assert.equal(r.ok, false, `abort ${i} struck (${r.strike})`);
  }
});

// ------------------------------------------------------------------ direction, curve, tempo

test('a straight swipe: ok, straight start and no curve', () => {
  const r = full(trace());
  assert.equal(r.ok, true);
  assert.equal(r.startDir, 0);
  assert.equal(r.faceToPath, 0);
  assert.equal(r.label, 'Straight');
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

test('direction and curve read the same from a short flick that stops short of the line', () => {
  // A 60 px flick angled 20 deg right, released 100 px below the start line.
  const r = full(trace({ depth: 160, follow: -100, chordDeg: 20, downMs: 60 }));
  assert.ok(r.ok);
  assert.ok(Math.abs(r.alpha - 20) < 0.5 && r.label.startsWith('Push'));
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

test('tempo: rushed, smooth and decelerating downswings', () => {
  const depth = FULL;
  const smooth = full(trace({ depth, follow: 40, downMs: 400 }));
  assert.equal(smooth.tempo, 'smooth');
  // A frantic snap (about 8000 px/s) is rushed.
  const rushed = full(trace({ depth, follow: 40, downMs: 30 }));
  assert.equal(rushed.tempo, 'rushed');
  assert.ok(rushed.label.includes('Rushed'));
  assert.ok(rushed.tempoErr > 0 && rushed.tempoErr <= 1);
  // Ordinary phone flicks (300-2000 px/s through the whole upswing) are smooth, with or without
  // a motionless pause at the bottom (which fires no touch events).
  for (const speed of [300, 1000, 1600, 2000]) {
    for (const holdMs of [0, 60, 200]) {
      const L = depth + 60;
      const sw = full(trace({ depth, follow: 60, holdMs, downMs: (L / speed) * 1000 }));
      assert.equal(sw.tempo, 'smooth', `${speed} px/s after a ${holdMs} ms pause: ${sw.downswingS} s`);
    }
  }
  // A pause does not change the measured downswing.
  const a = full(trace({ depth, follow: 60, downMs: 150 }));
  const p = full(trace({ depth, follow: 60, downMs: 150, holdMs: 60 }));
  assert.ok(Math.abs(a.downswingS - p.downswingS) < 0.012, `${a.downswingS} vs ${p.downswingS}`);
  // Creeping up 60 px at 100 px/s, then flicking through the line at 1000 px/s: decel.
  const S = trace({ depth, release: 'bottom' });
  const b = S[S.length - 1];
  for (let k = 1; k <= 72; k++) S.push({ t: b.t + k * (600 / 72), x: b.x, y: b.y - (60 * k) / 72 });
  const m = S[S.length - 1];
  for (let k = 1; k <= 20; k++) S.push({ t: m.t + k * 8, x: m.x, y: m.y - 8 * k });
  const decel = full(S);
  assert.equal(decel.ok, true);
  assert.equal(decel.tempo, 'decel');
  assert.ok(decel.label.includes('Decel'));
  // A slow return that used to be "too slow" (170 px/s through the line) now strikes.
  const slow = full(trace({ depth: 100, downMs: 1000 }));
  assert.equal(slow.ok, true);
  assert.ok(slow.tempo === 'smooth' || slow.tempo === 'decel');
});

// ------------------------------------------------------------------ putts

test('putt: depth maps to power, release strokes it, drift pushes or pulls, slow return cancels', () => {
  const depth = 0.5 * PUTT;
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
  // Dragged back to the start, slowly or quickly: cancelled. Tiny press or a slip: short.
  assert.equal(putt(trace({ depth, downMs: 1500, follow: 0 })).reason, 'cancel');
  assert.equal(putt(trace({ depth, downMs: 120, follow: 0 })).reason, 'cancel', 'a quick undo cancels');
  assert.equal(putt(trace({ depth, downMs: 120, follow: 5 })).reason, 'cancel', 'stopping just past the line cancels');
  assert.equal(putt([{ t: 0, x: 0, y: 0 }, { t: 50, x: 0, y: 4 }]).reason, 'short');
  assert.equal(putt(trace({ depth: 12, release: 'bottom', holdMs: 100 })).reason, 'short', 'a 12 px slip');
  // Dragged far sideways off the line, then lifted: abandoned.
  const side = trace({ depth, release: 'bottom', holdMs: 50 });
  const sb = side[side.length - 1];
  for (let k = 1; k <= 12; k++) side.push({ t: sb.t + k * 10, x: sb.x + 150 * (k / 12), y: sb.y });
  assert.equal(putt(side).reason, 'cancel');
  // A phone putt: drag down, settle, lift.
  const phone = putt(phoneSwipe([[300, 1, 0.4 * PUTT], [200, 0, 0]], { restJitter: true }));
  assert.ok(phone.ok && Math.abs(phone.power - 0.4) < 0.02);
});

// ------------------------------------------------------------------ launch

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
  assert.ok(Math.abs(decel.meta.ballSpeed - c.ballSpeed * DECEL_SPEED) < 1e-9);
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
  // Partial wedges launch higher and keep more spin than the speed alone implies (pitches).
  const pw = clubById('PW');
  const p6 = swingToLaunch(pw, null, sw({ power: 0.6 }), 0, null);
  const speedRatio = 0.15 + 0.85 * 0.6;
  assert.ok(Math.abs(p6.meta.spinRpm - pw.spinRpm * Math.sqrt(speedRatio) * (1 - 0.2 * 0.4)) < 1e-6);
  assert.ok(Math.abs(p6.meta.launchDeg - (pw.launch + PARTIAL_LAUNCH.wedge * 0.4)) < 1e-9);
  assert.ok(p6.meta.spinRpm > pw.spinRpm * speedRatio);
});

test('pitches: 20-50 yd lob and sand wedge pitches land steeply and stop within a few yards', () => {
  const green = planeTerrain({ surface: SURF.GREEN });
  const sim = (id, power) => simulateShot(green, swingToLaunch(id, null, { ok: true, kind: 'full', power, startDir: 0, faceToPath: 0, tempo: 'smooth' }, 0, null), { record: false });
  for (const id of ['LW', 'SW']) {
    for (const yd of [25, 40, 55]) {
      let lo = 0.05;
      let hi = 1;
      for (let i = 0; i < 25; i++) {
        const m = (lo + hi) / 2;
        if (sim(id, m).carry < yd * 0.9144) lo = m;
        else hi = m;
      }
      const r = sim(id, (lo + hi) / 2);
      const land = r.events.find((e) => e.type === 'land');
      const roll = (r.total - r.carry) / 0.9144;
      assert.ok(land.angle >= 38, `${id} ${yd} yd lands at ${land.angle}`);
      assert.ok(roll > -1 && roll < 5.5, `${id} ${yd} yd releases ${roll} yd`);
    }
  }
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
