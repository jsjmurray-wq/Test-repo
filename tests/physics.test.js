// Physics tests: strike model, cloth friction, collisions, cushions, pockets, events,
// determinism and performance. Run with: node --test tests/physics.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { World, strikeVelocity, simulateShot } from '../src/physics.js';
import { TABLE } from '../src/table.js';
import {
  BALL_R as R,
  BALL_M,
  DT,
  AI_DT,
  G,
  MU_SLIDE,
  MAX_SHOT_T,
  MAX_TIP,
  MAX_SQUIRT_RAD,
  RACK_GAP,
  FOOT_SPOT,
  HEAD_STRING_X,
  shotSpeed,
  powerForSpeed,
} from '../src/constants.js';

const DEG = 180 / Math.PI;
const I = 0.4 * BALL_M * R * R;

// ---- helpers --------------------------------------------------------------------------------

function world(list) {
  const w = new World();
  w.setBalls(list.map((b) => ({ on: true, ...b })));
  return w;
}

// Step until at rest; onStep(world, events) runs after every step. Returns all events.
function run(w, { dt = DT, onStep = null, maxSteps = 200000 } = {}) {
  const all = [];
  for (let n = 0; n < maxSteps && !w.atRest(); n++) {
    const ev = w.step(dt);
    for (const e of ev) all.push(e);
    if (onStep) onStep(w, ev);
  }
  return all;
}

// Step until pred(world, events) is true (or rest). Returns the events of the step it fired on.
function stepUntil(w, pred, dt = DT, maxSteps = 200000) {
  for (let n = 0; n < maxSteps; n++) {
    const ev = w.step(dt);
    if (pred(w, ev)) return ev;
    if (w.atRest()) break;
  }
  return null;
}

function energy(w) {
  let e = 0;
  for (const b of w.balls) {
    if (!b.on) continue;
    e += 0.5 * BALL_M * (b.vx * b.vx + b.vy * b.vy);
    e += 0.5 * I * (b.wx * b.wx + b.wy * b.wy + b.wz * b.wz);
  }
  return e;
}

// Rack per rules-spec: apex on the foot spot, rows toward the foot rail, 8 in the centre.
function rack() {
  const g = RACK_GAP;
  const dx = Math.sqrt(3) * (R + g / 2);
  const dy = 2 * R + g;
  const ids = [1, 9, 2, 10, 8, 3, 11, 4, 12, 5, 13, 6, 14, 7, 15]; // slot (2,1) is the 8
  const out = [];
  let k = 0;
  for (let i = 0; i < 5; i++) {
    for (let j = 0; j <= i; j++) out.push({ id: ids[k++], x: FOOT_SPOT.x + i * dx, y: (j - i / 2) * dy, on: true });
  }
  return out;
}

function breakSetup(cy = 0) {
  const cue = { id: 0, x: HEAD_STRING_X, y: cy, on: true };
  const balls = [cue, ...rack()];
  const angle = Math.atan2(FOOT_SPOT.y - cy, FOOT_SPOT.x - cue.x);
  return { balls, shot: { angle, power: 1, spin: { x: 0, y: 0 } } };
}

// Spin offset that cancels the forward roll the cloth builds over distance d, so a ball
// struck at speed v arrives with zero spin (a true stun).
function stunSpin(v, d) {
  const a = MU_SLIDE * G;
  const t = (v - Math.sqrt(v * v - 2 * a * d)) / a;
  return -(a * t) / v;
}

const angleOf = (vx, vy) => Math.atan2(vy, vx) * DEG;

function angleBetween(ax, ay, bx, by) {
  const c = (ax * bx + ay * by) / (Math.hypot(ax, ay) * Math.hypot(bx, by));
  return Math.acos(Math.max(-1, Math.min(1, c))) * DEG;
}

function maxOverlap(w) {
  let worst = 0;
  const on = w.balls.filter((b) => b.on);
  for (let i = 0; i < on.length; i++) {
    for (let j = i + 1; j < on.length; j++) {
      const d = Math.hypot(on[i].x - on[j].x, on[i].y - on[j].y);
      worst = Math.max(worst, 2 * R - d);
    }
  }
  return worst;
}

// Largest distance any on-table ball's centre has crossed past R from a rail cushion line,
// for balls whose centre projects onto that rail (jaws/pocket throats are excluded).
function maxRailPenetration(w) {
  let worst = 0;
  for (const b of w.balls) {
    if (!b.on) continue;
    for (const c of TABLE.cushions) {
      if (c.kind !== 'rail') continue;
      const tx = c.b.x - c.a.x;
      const ty = c.b.y - c.a.y;
      const along = ((b.x - c.a.x) * tx + (b.y - c.a.y) * ty) / (tx * tx + ty * ty);
      if (along < 0 || along > 1) continue;
      const d = (b.x - c.a.x) * c.n.x + (b.y - c.a.y) * c.n.y;
      worst = Math.max(worst, R - d);
    }
  }
  return worst;
}

// ---- strike ---------------------------------------------------------------------------------

test('strike: b = 0.4 is exactly natural roll in any direction', () => {
  for (const angle of [0, 0.7, 2, -2.5, Math.PI]) {
    const s = strikeVelocity({ angle, power: 0.4, spin: { x: 0, y: 0.4 } });
    const ux = s.vx - R * s.wy;
    const uy = s.vy + R * s.wx;
    assert.ok(Math.hypot(ux, uy) < 1e-12, `contact velocity ${Math.hypot(ux, uy)} at angle ${angle}`);
    assert.ok(Math.abs(Math.hypot(s.vx, s.vy) - shotSpeed(0.4)) < 1e-12);
    assert.equal(s.wz, 0);
    assert.equal(s.miscue, false);
  }
});

test('strike: rolling in +x spins about +y; draw spins the other way', () => {
  const f = strikeVelocity({ angle: 0, power: 0.3, spin: { x: 0, y: 0.4 } });
  assert.ok(f.wy > 0 && Math.abs(f.wx) < 1e-12);
  const d = strikeVelocity({ angle: 0, power: 0.3, spin: { x: 0, y: -0.4 } });
  assert.ok(d.wy < 0);
});

test('strike: right english squirts left and spins counter-clockwise (+wz)', () => {
  const s = strikeVelocity({ angle: 0, power: 0.5, spin: { x: 0.5, y: 0 } });
  const dir = Math.atan2(s.vy, s.vx);
  assert.ok(Math.abs(dir - MAX_SQUIRT_RAD) < 1e-12, 'full right english deflects by MAX_SQUIRT_RAD to the left');
  assert.ok(s.wz > 0);
  assert.ok(Math.abs(s.wz - (5 * shotSpeed(0.5) * 0.5) / (2 * R)) < 1e-9);
  const l = strikeVelocity({ angle: 0, power: 0.5, spin: { x: -0.25, y: 0 } });
  assert.ok(Math.atan2(l.vy, l.vx) < 0 && l.wz < 0);
});

test('strike: offsets are clamped to MAX_TIP; beyond MISCUE_TIP the shot miscues', () => {
  const c = strikeVelocity({ angle: 0, power: 0.5, spin: { x: 0, y: 0.53 } });
  assert.equal(c.miscue, false);
  assert.ok(Math.abs(c.wy - (5 * shotSpeed(0.5) * MAX_TIP) / (2 * R)) < 1e-9);
  const m = strikeVelocity({ angle: 1, power: 0.5, spin: { x: 0.6, y: 0 } });
  assert.equal(m.miscue, true);
  assert.ok(Math.abs(Math.hypot(m.vx, m.vy) - 0.3 * shotSpeed(0.5)) < 1e-12);
  // Deflected 2 degrees away from the side struck (right offset -> left), plus the small squirt.
  const expected = 1 + (2 * Math.PI) / 180 + ((0.6 * 0.2) / MAX_TIP) * MAX_SQUIRT_RAD;
  assert.ok(Math.abs(Math.atan2(m.vy, m.vx) - expected) < 1e-12);
  // Deterministic.
  assert.deepEqual(m, strikeVelocity({ angle: 1, power: 0.5, spin: { x: 0.6, y: 0 } }));
  const w = world([{ id: 0, x: 0, y: 0 }]);
  const ev = w.strike({ angle: 0, power: 0.5, spin: { x: 0, y: -0.7 } });
  assert.equal(ev[0].type, 'strike');
  assert.equal(ev[0].miscue, true);
});

// ---- cloth ----------------------------------------------------------------------------------

test('natural roll: no sliding before the first rail, plausible total distance, stops', () => {
  const w = world([{ id: 0, x: -0.6, y: 0.1 }]);
  w.strike({ angle: 0, power: 0.3, spin: { x: 0, y: 0.4 } });
  let path = 0;
  let px = -0.6;
  let py = 0.1;
  let railed = false;
  let slidBeforeRail = false;
  const ev = run(w, {
    onStep(wd, events) {
      const c = wd.balls[0];
      path += Math.hypot(c.x - px, c.y - py);
      px = c.x;
      py = c.y;
      if (events.some((e) => e.type === 'cushion')) railed = true;
      if (!railed && c.state === 'slide') slidBeforeRail = true;
    },
  });
  assert.equal(slidBeforeRail, false);
  assert.ok(path > 1 && path < 6, `rolled ${path.toFixed(2)} m`);
  assert.ok(ev.some((e) => e.type === 'cushion' && e.ball === 0));
  assert.ok(w.atRest());
  assert.equal(w.balls[0].state, 'rest');
});

test('sliding ball reaches natural roll at 5/7 of its speed (stun on open cloth)', () => {
  const w = world([{ id: 0, x: -0.8, y: 0 }]);
  w.strike({ angle: 0, power: powerForSpeed(2), spin: { x: 0, y: 0 } });
  stepUntil(w, (wd) => wd.balls[0].state === 'roll');
  const c = w.balls[0];
  assert.ok(Math.abs(Math.hypot(c.vx, c.vy) / 2 - 5 / 7) < 0.01, `ratio ${Math.hypot(c.vx, c.vy) / 2}`);
  assert.ok(Math.abs(c.vx - R * c.wy) < 1e-9);
});

// ---- ball-ball ------------------------------------------------------------------------------

test('stun shot straight in: cue ball stops dead, object ball takes ~95% of the speed', () => {
  const v = 3;
  const d = 0.6 - 2 * R;
  const w = world([
    { id: 0, x: -0.5, y: 0 },
    { id: 1, x: 0.1, y: 0 },
  ]);
  w.strike({ angle: 0, power: powerForSpeed(v), spin: { x: 0, y: stunSpin(v, d) } });
  let spinAtImpact = 0;
  let speedAtImpact = 0;
  const ev = stepUntil(w, (wd, e) => {
    if (!e.some((x) => x.type === 'ball')) {
      spinAtImpact = R * wd.balls[0].wy;
      speedAtImpact = wd.balls[0].vx;
      return false;
    }
    return true;
  });
  assert.ok(ev, 'balls collide');
  assert.ok(Math.abs(spinAtImpact) < 0.02 * speedAtImpact, 'the cue ball arrives without spin');
  const hit = ev.find((e) => e.type === 'ball');
  assert.deepEqual([hit.a, hit.b], [0, 1]);
  const ratio = Math.hypot(w.balls[1].vx, w.balls[1].vy) / hit.v;
  assert.ok(ratio > 0.93 && ratio < 0.99, `object ball speed ratio ${ratio}`);
  // Where the cue ball first stops (the object ball comes back off the foot rail later).
  stepUntil(w, (wd) => wd.balls[0].state === 'rest');
  assert.ok(Math.abs(w.balls[0].x - (0.1 - 2 * R)) < 0.02, `cue ball drifted to ${w.balls[0].x}`);
});

test('stun cut: cue and object ball separate at 90 +/- 3 degrees', () => {
  // A firm stun on a medium-to-thin cut. (On fuller or slower cuts the separation really is
  // smaller: E_BALL < 1 leaves the cue ball some forward speed and slow cuts throw more.)
  for (const cutDeg of [45, 55, 65]) {
    const v = 3;
    const cut = cutDeg / DEG;
    const ox = 0.1;
    const oy = 2 * R * Math.sin(cut);
    const d = ox + 0.5 - 2 * R * Math.cos(cut);
    const w = world([
      { id: 0, x: -0.5, y: 0 },
      { id: 1, x: ox, y: oy },
    ]);
    w.strike({ angle: 0, power: powerForSpeed(v), spin: { x: 0, y: stunSpin(v, d) } });
    stepUntil(w, (wd, e) => e.some((x) => x.type === 'ball'));
    w.step(); // shortly after contact
    const c = w.balls[0];
    const o = w.balls[1];
    const sep = angleBetween(c.vx, c.vy, o.vx, o.vy);
    assert.ok(Math.abs(sep - 90) <= 3, `cut ${cutDeg}: separation ${sep.toFixed(2)} deg`);
    // Cut-induced throw pushes the object ball off the line of centres toward the cue ball's
    // path, by a couple of degrees.
    const throwDeg = angleBetween(o.vx, o.vy, Math.cos(cut), Math.sin(cut));
    assert.ok(throwDeg > 0.3 && throwDeg < 4, `cut ${cutDeg}: throw ${throwDeg.toFixed(2)} deg`);
  }
});

test('half-ball hit with a rolling cue ball deflects it ~30 degrees', () => {
  const w = world([
    { id: 0, x: -0.6, y: 0 },
    { id: 1, x: 0, y: R }, // centre line offset R: half-ball
  ]);
  w.strike({ angle: 0, power: 0.25, spin: { x: 0, y: 0.4 } });
  stepUntil(w, (wd, e) => e.some((x) => x.type === 'ball'));
  stepUntil(w, (wd) => wd.balls[0].state === 'roll');
  const c = w.balls[0];
  const defl = -angleOf(c.vx, c.vy);
  assert.ok(Math.abs(defl - 30) <= 5, `cue ball deflection ${defl.toFixed(2)} deg`);
});

test('draw comes back, follow goes through (full-ball hit)', () => {
  for (const [b, sign] of [
    [-0.5, -1],
    [0.5, 1],
  ]) {
    const w = world([
      { id: 0, x: -0.4, y: 0 },
      { id: 1, x: 0.1, y: 0 },
    ]);
    w.strike({ angle: 0, power: powerForSpeed(2), spin: { x: 0, y: b } });
    stepUntil(w, (wd, e) => e.some((x) => x.type === 'ball'));
    const contactX = w.balls[0].x;
    stepUntil(w, (wd) => wd.balls[0].state === 'roll');
    const c = w.balls[0];
    assert.ok(Math.sign(c.vx) === sign && Math.abs(c.vx) > 0.2, `b=${b}: rolling vx ${c.vx}`);
    for (let i = 0; i < 200; i++) w.step();
    assert.ok(sign * (w.balls[0].x - contactX) > 0.05, `b=${b}: moved ${w.balls[0].x - contactX}`);
  }
});

test('a cue ball frozen to an object ball hits it in the first substep', () => {
  const w = world([
    { id: 0, x: 0, y: 0 },
    { id: 5, x: 2 * R, y: 0 },
  ]);
  w.strike({ angle: 0, power: 0.2, spin: { x: 0, y: 0 } });
  const ev = w.step();
  const hit = ev.find((e) => e.type === 'ball');
  assert.ok(hit, 'ball event in the first step');
  assert.deepEqual([hit.a, hit.b], [0, 5]);
  assert.ok(hit.t <= DT);
});

test('frozen combination: the impact runs through the touching balls', () => {
  // Cue ball into a line of three frozen balls: like a Newton's cradle, the last ball leaves
  // with most of the speed and the middle ones barely move.
  const w = world([
    { id: 0, x: -0.4, y: 0 },
    { id: 1, x: 0, y: 0 },
    { id: 2, x: 2 * R, y: 0 },
    { id: 3, x: 4 * R, y: 0 },
  ]);
  w.strike({ angle: 0, power: powerForSpeed(2), spin: { x: 0, y: stunSpin(2, 0.4 - 2 * R) } });
  const ev = stepUntil(w, (wd, e) => e.some((x) => x.type === 'ball'));
  const sp = (id) => Math.hypot(w.balls[id].vx, w.balls[id].vy);
  const hit = ev.find((e) => e.type === 'ball');
  assert.deepEqual([hit.a, hit.b], [0, 1], 'first contact is the cue ball');
  assert.ok(sp(3) > 0.75 * hit.v, `last ball ${sp(3)} of ${hit.v}`);
  assert.ok(sp(1) < 0.25 * hit.v && sp(2) < 0.25 * hit.v);
  assert.ok(maxOverlap(w) < 1e-4);
});

// ---- energy, tunnelling, break --------------------------------------------------------------

test('energy never increases during a break', () => {
  const { balls, shot } = breakSetup(0.05);
  const w = world(balls);
  w.strike(shot);
  let e0 = energy(w);
  let steps = 0;
  run(w, {
    onStep(wd) {
      const e1 = energy(wd);
      assert.ok(e1 <= e0 * (1 + 1e-9) + 1e-12, `energy rose from ${e0} to ${e1} at t=${wd.t}`);
      e0 = e1;
      steps++;
    },
  });
  assert.ok(steps > 100);
});

test('no tunnelling at 9.5 m/s: into a ball, into the rack, into rails and jaws', () => {
  const cases = [
    [{ id: 0, x: -0.7, y: 0.02 }, { id: 4, x: 0.3, y: 0 }],
    breakSetup(0).balls,
    breakSetup(-0.2).balls,
    [{ id: 0, x: 0.2, y: 0.1 }], // straight into the foot rail
    [{ id: 0, x: 0.6, y: 0.2 }], // toward the foot-left corner jaws
    [{ id: 0, x: -0.3, y: -0.3 }], // toward the side pocket jaws
  ];
  const angles = [0, null, null, 0, 0.6, 1.3];
  cases.forEach((list, k) => {
    const w = world(list);
    const cue = list[0];
    const angle = angles[k] ?? Math.atan2(-cue.y, FOOT_SPOT.x - cue.x);
    w.strike({ angle, power: 1, spin: { x: 0.2, y: -0.2 } });
    let worstBall = 0;
    let worstRail = 0;
    run(w, {
      onStep(wd) {
        worstBall = Math.max(worstBall, maxOverlap(wd));
        worstRail = Math.max(worstRail, maxRailPenetration(wd));
        for (const b of wd.balls) {
          if (!b.on) continue;
          assert.ok(Math.abs(b.x) < TABLE.HL + 0.01 && Math.abs(b.y) < TABLE.HW + 0.01, `ball ${b.id} left the table`);
        }
      },
    });
    assert.ok(worstBall < 1e-4, `case ${k}: ball overlap ${worstBall}`);
    assert.ok(worstRail < 1e-4, `case ${k}: rail penetration ${worstRail}`);
    assert.equal(w.stats.safety, 0, `case ${k}: safety net used`);
  });
});

test('break: the rack spreads, at least 4 object balls reach a rail, everything rests', () => {
  for (const cy of [0, 0.12, -0.2]) {
    const { balls, shot } = breakSetup(cy);
    const r = simulateShot(balls, shot);
    const railed = new Set(r.log.filter((e) => e.type === 'cushion' && e.ball !== 0).map((e) => e.ball));
    const pocketed = r.log.filter((e) => e.type === 'pocket').map((e) => e.ball);
    assert.ok(railed.size + pocketed.filter((b) => b !== 0).length >= 4, `cy=${cy}: ${railed.size} balls railed`);
    assert.ok(r.t < MAX_SHOT_T, `cy=${cy}: t=${r.t}`);
    assert.ok(r.final.every((b) => Number.isFinite(b.x) && Number.isFinite(b.y)));
    // The rack really breaks up: most object balls move well away from their rack spots.
    const start = new Map(balls.map((b) => [b.id, b]));
    const moved = r.final.filter((b) => b.id !== 0 && (!b.on || Math.hypot(b.x - start.get(b.id).x, b.y - start.get(b.id).y) > 0.15));
    assert.ok(moved.length >= 10, `cy=${cy}: only ${moved.length} balls moved 15 cm`);
    const hit = r.log.find((e) => e.type === 'ball');
    assert.equal(hit.a, 0, 'cue ball hits the rack first');
  }
});

// ---- pockets --------------------------------------------------------------------------------

test('straight-in pots: corner and side pockets report the right pocket id', () => {
  const corner = TABLE.pockets[2]; // foot-left (+HL, +HW)
  const u = { x: Math.SQRT1_2, y: Math.SQRT1_2 };
  const w = world([
    { id: 0, x: corner.x - 0.55 * u.x, y: corner.y - 0.55 * u.y },
    { id: 1, x: corner.x - 0.25 * u.x, y: corner.y - 0.25 * u.y },
  ]);
  w.strike({ angle: Math.PI / 4, power: 0.3, spin: { x: 0, y: -0.2 } });
  let ev = run(w);
  let pot = ev.find((e) => e.type === 'pocket' && e.ball === 1);
  assert.ok(pot, 'object ball pocketed');
  assert.equal(pot.pocket, 2);
  assert.equal(w.balls[1].on, false);
  assert.equal(w.balls[1].state, 'pocketed');
  assert.equal(w.balls[1].pocket, 2);

  const w2 = world([
    { id: 0, x: 0, y: -0.15 },
    { id: 9, x: 0, y: TABLE.HW - 0.15 },
  ]);
  w2.strike({ angle: Math.PI / 2, power: 0.25, spin: { x: 0, y: -0.2 } });
  ev = run(w2);
  pot = ev.find((e) => e.type === 'pocket' && e.ball === 9);
  assert.ok(pot, 'object ball pocketed in the side');
  assert.equal(pot.pocket, 1);
  assert.ok(pot.v > 0);
  const snap = w2.snapshot();
  assert.equal(snap.length, 16);
  assert.equal(snap.find((b) => b.id === 9).on, false);
});

test('a ball rolling frozen along a rail rolls past the side pocket, into the corner', () => {
  const w = world([{ id: 0, x: -0.4, y: TABLE.HW - R }]);
  w.strike({ angle: 0, power: 0.15, spin: { x: 0, y: 0.4 } });
  const ev = run(w);
  const pots = ev.filter((e) => e.type === 'pocket');
  assert.equal(pots.length, 1);
  assert.equal(pots[0].pocket, 2, 'drops in the foot-left corner, not the side');
  assert.ok(!ev.some((e) => e.type === 'cushion' && !e.frozen), 'no jaw rattle on the way past');
});

// ---- cushions -------------------------------------------------------------------------------

// Fire a stun ball at 45 degrees into the left long rail (y = +HW) and return the incidence and
// rebound angles measured from the rail normal.
function bank(spinX) {
  const v = 2.5;
  const x0 = -0.1;
  const y0 = 0.15; // close enough that the stun draw plus english stays inside MAX_TIP
  const d = (TABLE.HW - R - y0) * Math.SQRT2;
  const w = world([{ id: 0, x: x0, y: y0 }]);
  w.strike({ angle: Math.PI / 4, power: powerForSpeed(v), spin: { x: spinX, y: stunSpin(v, d) } });
  let vin = null;
  const ev = stepUntil(w, (wd, e) => {
    if (!e.some((x) => x.type === 'cushion')) {
      vin = [wd.balls[0].vx, wd.balls[0].vy];
      return false;
    }
    return true;
  });
  assert.equal(w.log[0].miscue, false);
  const hit = ev.find((e) => e.type === 'cushion');
  const c = w.balls[0];
  return {
    hit,
    in: angleOf(vin[1], vin[0]), // angle from +y (the normal into the rail)
    out: angleOf(-c.vy, c.vx), // angle from -y (the normal out of the rail)
  };
}

test('bank: a spinless ball rebounds at the mirror angle +/- 3 degrees', () => {
  const b = bank(0);
  assert.ok(b.hit.ball === 0 && b.hit.frozen === false);
  assert.equal(TABLE.cushions[b.hit.cushion].kind, 'rail');
  assert.ok(Math.abs(b.in - 45) < 0.5);
  assert.ok(Math.abs(b.out - b.in) <= 3, `in ${b.in.toFixed(2)} out ${b.out.toFixed(2)}`);
});

test('running english widens the rebound, reverse english shortens it', () => {
  // Heading up-table and to the right (+x), the ball comes off the rail to the shooter's
  // right, so right english is running english.
  const none = bank(0);
  const running = bank(0.4);
  const reverse = bank(-0.4);
  const turn = (b) => b.out - b.in;
  assert.ok(turn(running) > turn(none) + 2, `running ${turn(running).toFixed(2)} vs none ${turn(none).toFixed(2)}`);
  assert.ok(turn(reverse) < turn(none) - 2, `reverse ${turn(reverse).toFixed(2)} vs none ${turn(none).toFixed(2)}`);
});

test('rails: a ball fired straight at the head rail comes back on the same line', () => {
  const y0 = 0.05;
  const w = world([{ id: 0, x: 0.3, y: y0 }]);
  w.strike({ angle: Math.PI, power: 0.35, spin: { x: 0, y: 0 } });
  let drift = 0;
  let back = false;
  const ev = run(w, {
    onStep(wd) {
      drift = Math.max(drift, Math.abs(wd.balls[0].y - y0));
      if (wd.balls[0].vx > 0) back = true;
    },
  });
  assert.ok(back, 'ball came back');
  assert.ok(drift < 0.001, `drift ${drift}`);
  const hit = ev.find((e) => e.type === 'cushion');
  assert.equal(TABLE.cushions[hit.cushion].n.x, 1, 'head rail');
});

test('a rolling ball loses most of its topspin into the rail but still comes back', () => {
  const w = world([{ id: 0, x: 0.3, y: 0 }]);
  w.strike({ angle: 0, power: 0.2, spin: { x: 0, y: 0.4 } });
  let vin = 0;
  stepUntil(w, (wd, e) => {
    if (!e.some((x) => x.type === 'cushion')) {
      vin = wd.balls[0].vx;
      return false;
    }
    return true;
  });
  const c = w.balls[0];
  assert.ok(c.vx < -0.6 * vin && c.vx > -0.85 * vin, `rebound ${c.vx} from ${vin}`);
  assert.ok(Math.abs(c.wy) < 0.5 * (vin / R), 'topspin partly killed');
  stepUntil(w, (wd) => wd.balls[0].state === 'roll');
  assert.ok(w.balls[0].vx < -0.2 * vin, 'still rolling back');
});

// ---- events and bookkeeping -----------------------------------------------------------------

test('events: seq strictly increasing, t non-decreasing, strike first', () => {
  const { balls, shot } = breakSetup(0.1);
  const w = world(balls);
  w.strike(shot);
  run(w);
  const log = w.log;
  assert.equal(log[0].type, 'strike');
  assert.equal(log[0].seq, 0);
  for (let i = 1; i < log.length; i++) {
    assert.ok(log[i].seq > log[i - 1].seq);
    assert.ok(log[i].t >= log[i - 1].t);
  }
  for (const e of log) {
    if (e.type === 'ball') assert.ok(e.a < e.b && e.v > 0);
    if (e.type === 'cushion') assert.ok(e.v > 0.005 && typeof e.frozen === 'boolean');
  }
  // A new strike resets the log and seq.
  w.strike({ angle: 0, power: 0.1, spin: { x: 0, y: 0 } });
  assert.equal(w.log.length, 1);
  assert.equal(w.log[0].seq, 0);
  assert.equal(w.t, 0);
});

test('frozen balls: no cushion noise for resting balls, frozen flag on frozen contacts', () => {
  // Ball 3 rests frozen on the right long rail; the cue ball rolls elsewhere.
  const w = world([
    { id: 0, x: -0.5, y: 0.2 },
    { id: 3, x: 0.2, y: -(TABLE.HW - R) },
  ]);
  w.strike({ angle: 0, power: 0.2, spin: { x: 0, y: 0 } });
  let ev = run(w);
  assert.ok(!ev.some((e) => e.type === 'cushion' && e.ball === 3));

  // The cue ball shot along the rail it is frozen to makes no non-frozen cushion events
  // until it reaches the end rail.
  const w2 = world([{ id: 0, x: -0.5, y: TABLE.HW - R }]);
  w2.strike({ angle: 0, power: 0.15, spin: { x: 0, y: 0.3 } });
  ev = run(w2);
  const longRail = ev.filter((e) => e.type === 'cushion' && TABLE.cushions[e.cushion].n.y === -1);
  assert.ok(longRail.every((e) => e.frozen), 'contacts with its own rail are frozen');

  // An object ball frozen on a rail, driven into it: the contact is reported as frozen.
  const w3 = world([
    { id: 0, x: 0.3, y: -0.2 },
    { id: 6, x: 0.3, y: -(TABLE.HW - R) },
  ]);
  w3.strike({ angle: -Math.PI / 2, power: 0.3, spin: { x: 0, y: 0 } });
  ev = run(w3);
  const c6 = ev.filter((e) => e.type === 'cushion' && e.ball === 6);
  assert.ok(c6.length > 0, 'object ball pressed into its rail');
  assert.equal(c6[0].frozen, true);
});

test('cross event when the cue ball leaves the kitchen, and when it comes back', () => {
  const w = world([{ id: 0, x: HEAD_STRING_X - 0.2, y: 0.1 }]);
  w.strike({ angle: 0, power: 0.45, spin: { x: 0, y: 0 } });
  const ev = run(w);
  const cross = ev.filter((e) => e.type === 'cross');
  assert.ok(cross.length >= 2, 'out and back in');
  assert.equal(cross[0].dir, 1);
  assert.equal(cross[0].ball, 0);
  assert.equal(cross[1].dir, -1);
  // Crossing time matches the 0.2 m to the head string (the ball slows a little on the way).
  const tc = 0.2 / shotSpeed(0.45);
  assert.ok(cross[0].t > tc && cross[0].t < 1.1 * tc, `t=${cross[0].t} vs ${tc}`);
});

test('MAX_SHOT_T: a shot is cut off and everything forced to rest', () => {
  const r = simulateShot([{ id: 0, x: 0, y: 0, on: true }], { angle: 0.3, power: 1, spin: { x: 0, y: 0 } }, { maxT: 0.5 });
  assert.ok(r.t >= 0.5 && r.t < 0.51);
  assert.ok(r.final[0].on);
});

// ---- determinism and drivers ----------------------------------------------------------------

test('determinism: the same break twice is identical; simulateShot matches World stepping', () => {
  const { balls, shot } = breakSetup(0.07);
  const a = simulateShot(balls, shot);
  const b = simulateShot(balls, shot);
  assert.deepEqual(a, b);

  const w = world(balls);
  w.strike(shot);
  run(w, { dt: AI_DT });
  assert.deepEqual(w.record().final, a.final);
  assert.deepEqual(w.log, a.log);
  assert.equal(w.t, a.t);

  assert.ok(!/Math\.random\s*\(/.test(readFileSync(new URL('../src/physics.js', import.meta.url), 'utf8')));
});

test('advance() runs whole DT substeps from an accumulator and matches step(DT)', () => {
  const list = [
    { id: 0, x: -0.5, y: 0.1 },
    { id: 2, x: 0.2, y: 0.05 },
  ];
  const shot = { angle: 0, power: 0.35, spin: { x: 0.1, y: 0.2 } };
  const a = world(list);
  a.strike(shot);
  const evA = [];
  for (let f = 0; f < 600 && !a.atRest(); f++) for (const e of a.advance(1 / 60)) evA.push(e);
  const b = world(list);
  b.strike(shot);
  const evB = run(b, { dt: DT });
  assert.ok(a.atRest());
  assert.deepEqual(a.snapshot(), b.snapshot());
  assert.deepEqual(evA, evB);
  // A long frame gap is capped instead of simulating it all.
  const c = world(list);
  c.strike(shot);
  c.advance(5);
  assert.ok(c.t <= 0.1 + 1e-9);
});

test('setBalls keeps orientation, zeroes motion, and takes missing balls off', () => {
  const w = world([{ id: 0, x: -0.3, y: 0 }]);
  w.strike({ angle: 0, power: 0.3, spin: { x: 0, y: 0.4 } });
  for (let i = 0; i < 300; i++) w.step();
  const q = [...w.balls[0].q];
  assert.ok(Math.abs(Math.hypot(...q) - 1) < 1e-9);
  w.setBalls([{ id: 0, x: 0.1, y: 0.2, on: true }]);
  assert.deepEqual(w.balls[0].q, q);
  assert.equal(w.balls[0].vx, 0);
  assert.equal(w.balls[0].state, 'rest');
  assert.equal(w.balls[5].on, false);
  assert.ok(w.atRest());
});

test('orientation: a ball rolling in +x turns about +y', () => {
  const w = world([{ id: 0, x: -0.3, y: 0 }]);
  w.balls[0].q = [1, 0, 0, 0];
  w.strike({ angle: 0, power: 0.2, spin: { x: 0, y: 0.4 } });
  const x0 = w.balls[0].x;
  for (let i = 0; i < 100; i++) w.step();
  const [qw, qx, qy, qz] = w.balls[0].q;
  const turned = 2 * Math.atan2(qy, qw); // rotation angle about +y
  assert.ok(Math.abs(qx) < 1e-9 && Math.abs(qz) < 1e-9);
  assert.ok(Math.abs(turned - (w.balls[0].x - x0) / R) < 0.01, `turned ${turned}`);
});

// ---- performance ----------------------------------------------------------------------------

test('performance: simulateShot timing (logged)', () => {
  const typical = [
    { id: 0, x: -0.5, y: 0.1, on: true },
    { id: 3, x: 0.3, y: 0.05, on: true },
    { id: 11, x: 0.6, y: -0.2, on: true },
    { id: 8, x: -0.1, y: -0.3, on: true },
  ];
  const tShot = { angle: Math.atan2(-0.03, 0.8), power: 0.35, spin: { x: 0.1, y: 0.2 } };
  const { balls, shot } = breakSetup(0.04);
  const time = (fn, n) => {
    for (let i = 0; i < 5; i++) fn(); // warm up the JIT
    const t0 = performance.now();
    for (let i = 0; i < n; i++) fn();
    return (performance.now() - t0) / n;
  };
  const tTypical = time(() => simulateShot(typical, tShot), 40);
  const tBreak = time(() => simulateShot(balls, shot), 20);
  console.log(`simulateShot @AI_DT: typical shot ${tTypical.toFixed(2)} ms, full-power break ${tBreak.toFixed(2)} ms`);
  assert.ok(tTypical < 8 * 3 && tBreak < 60 * 3, 'far outside the budget');
});
