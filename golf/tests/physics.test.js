import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLUBS, clubById, stockLaunch, makeLaunch } from '../src/clubs.js';
import { simulateShot, flightStep, bounceImpulse, treeHit, planeTerrain } from '../src/physics.js';
import { SURF, SURFACES, BALL_R, G, RECORD_HZ, mToYd } from '../src/constants.js';

// Minimal HoleTerrain built here (independent of terrain.js and of planeTerrain) to prove that
// simulateShot only relies on the contract.
function makeTerrain({ h = () => 0, surf = () => SURF.FAIRWAY, water = () => null, trees = [], cup = null, oob = () => false } = {}) {
  const e = 0.005;
  const gradAt = (x, y, out = { x: 0, y: 0 }) => {
    out.x = (h(x + e, y) - h(x - e, y)) / (2 * e);
    out.y = (h(x, y + e) - h(x, y - e)) / (2 * e);
    return out;
  };
  for (const t of trees) t.z = h(t.x, t.y);
  return {
    cup,
    trees,
    heightAt: h,
    gradAt,
    normalAt(x, y) {
      const g = gradAt(x, y);
      const l = Math.hypot(g.x, g.y, 1);
      return { x: -g.x / l, y: -g.y / l, z: 1 / l };
    },
    surfaceAt: surf,
    isOOB: oob,
    waterAt: water,
    treesNear: (x, y, r) => trees.filter((t) => Math.hypot(t.x - x, t.y - y) <= r),
  };
}

const flat = (s = SURF.FAIRWAY) => makeTerrain({ surf: () => s });
const shot = (id, terrain = flat(), lopt = {}, sopt = {}) => simulateShot(terrain, stockLaunch(clubById(id), lopt), sopt);
const yd = (m) => mToYd(m);
const landAngle = (r) => r.events.find((e) => e.type === 'land').angle;

test('full-power carries: ranges, strictly decreasing, within 3% of target', () => {
  const ranges = { D: [235, 252], '7i': [155, 172], PW: [115, 130], LW: [65, 80] };
  let prev = Infinity;
  for (const c of CLUBS) {
    if (c.kind === 'putter') continue;
    const r = shot(c.id);
    const carry = yd(r.carry);
    assert.ok(carry < prev, `${c.id} ${carry}`);
    prev = carry;
    assert.ok(Math.abs(carry - c.targetCarryYd) / c.targetCarryYd <= 0.03, `${c.id} carry ${carry}`);
    if (ranges[c.id]) {
      const [lo, hi] = ranges[c.id];
      assert.ok(carry >= lo && carry <= hi, `${c.id} carry ${carry}`);
    }
  }
});

test('trajectory shapes: driver apex 25-33 m, descent steepens from driver (~40) to wedges (~49)', () => {
  const d = shot('D');
  assert.ok(d.apex >= 25 && d.apex <= 33, `apex ${d.apex}`);
  const angles = ['D', '5i', '7i', 'PW', 'LW'].map((id) => landAngle(shot(id)));
  for (let i = 1; i < angles.length; i++) assert.ok(angles[i] > angles[i - 1] - 0.5, `angles ${angles}`);
  // TrackMan-like descent angles (a 5 handicap's 7-iron lands at 46-50 deg, the driver 37-41).
  assert.ok(angles[0] >= 36 && angles[0] <= 42, `driver ${angles[0]}`);
  assert.ok(angles[2] >= 45 && angles[2] <= 50, `7-iron ${angles[2]}`);
  assert.ok(angles[3] >= 47 && angles[3] <= 53, `PW ${angles[3]}`);
  // Long irons no longer run 15+ yd on a green.
  const g5 = shot('5i', flat(SURF.GREEN));
  assert.ok(yd(g5.total - g5.carry) < 9, `5-iron releases ${yd(g5.total - g5.carry)} yd on a green`);
});

test('a zero-spin driver carries at least 15% less', () => {
  const d = shot('D');
  const z = shot('D', flat(), { spinScale: 0 });
  assert.ok(z.carry <= 0.85 * d.carry, `${z.carry} vs ${d.carry}`);
});

test('spin-axis tilt +-15 deg: driver finishes 15-40 yd right / left', () => {
  // aimYaw 0 = +x, so right is -y.
  const r = shot('D', flat(), { tiltDeg: 15 });
  const l = shot('D', flat(), { tiltDeg: -15 });
  assert.ok(yd(-r.final.y) >= 15 && yd(-r.final.y) <= 40, `right ${yd(-r.final.y)}`);
  assert.ok(yd(l.final.y) >= 15 && yd(l.final.y) <= 40, `left ${yd(l.final.y)}`);
  assert.ok(Math.abs(r.final.y + l.final.y) < 0.01, 'mirror image');
});

test('same face-to-path curves wedges less than half as much as the driver', () => {
  const curve = (id) => -shot(id, flat(), { faceToPathDeg: 4, startDirDeg: 0 }).landing.y;
  const d = curve('D');
  assert.ok(d > 0);
  for (const id of ['PW', 'SW', 'LW']) assert.ok(curve(id) < d / 2, `${id} ${curve(id)} vs ${d}`);
});

test('wind: 5 m/s head costs 15-30 yd, tail gains 8-18 yd, crosswind drifts downwind', () => {
  const calm = shot('D').carry;
  const head = shot('D', flat(), {}, { wind: { x: -5, y: 0 } }).carry;
  const tail = shot('D', flat(), {}, { wind: { x: 5, y: 0 } }).carry;
  assert.ok(yd(calm - head) >= 15 && yd(calm - head) <= 30, `head ${yd(calm - head)}`);
  assert.ok(yd(tail - calm) >= 8 && yd(tail - calm) <= 18, `tail ${yd(tail - calm)}`);
  const cross = shot('D', flat(), {}, { wind: { x: 0, y: 5 } });
  assert.ok(cross.landing.y > 5, `drift ${cross.landing.y}`);
  const cross2 = shot('D', flat(), {}, { wind: { x: 0, y: -5 } });
  assert.ok(cross2.landing.y < -5);
});

test('deterministic: identical inputs give bitwise identical results', () => {
  const trees = () => [{ x: 60, y: 0, trunkR: 0.3, trunkH: 3, canopy: { cz: 12, rx: 5, rz: 5 }, kind: 'oak' }];
  const run = () =>
    simulateShot(makeTerrain({ trees: trees() }), stockLaunch('7i', { tiltDeg: 3 }), { wind: { x: 1.3, y: -2 }, seed: 7 });
  const a = run();
  const b = run();
  assert.deepEqual(Buffer.from(a.path.buffer), Buffer.from(b.path.buffer));
  assert.equal(JSON.stringify(a.events), JSON.stringify(b.events));
  assert.equal(JSON.stringify(a.final), JSON.stringify(b.final));
});

test('path is [t,x,y,z]* at RECORD_HZ, starts at launch, ends at the final position', () => {
  const r = shot('7i');
  assert.ok(r.path instanceof Float32Array);
  assert.equal(r.path.length % 4, 0);
  const n = r.path.length / 4;
  assert.ok(Math.abs(n - r.t * RECORD_HZ) < r.events.length + 3, `${n} samples for ${r.t}s`);
  for (let i = 4; i < r.path.length; i += 4) assert.ok(r.path[i] > r.path[i - 4]);
  assert.equal(r.path[0], 0);
  const L = r.path.length;
  assert.ok(Math.abs(r.path[L - 3] - r.final.x) < 1e-3);
  assert.equal(r.events[0].type, 'launch');
  assert.equal(r.events.at(-1).type, 'rest');
  assert.equal(r.final.outcome, 'rest');
  assert.equal(shot('7i', flat(), {}, { record: false }).path.length, 0);
});

test('fairway: driver rolls out 10-30 yd', () => {
  const d = shot('D');
  const roll = yd(d.total - d.carry);
  assert.ok(roll >= 10 && roll <= 30, `roll ${roll}`);
});

test('green: 7i rolls -2..+8 yd; full SW checks (<=1 yd forward or spins back <=5 yd)', () => {
  const g = flat(SURF.GREEN);
  const i7 = shot('7i', g);
  const r7 = yd(i7.final.x - i7.landing.x);
  assert.ok(r7 >= -2 && r7 <= 8, `7i roll ${r7}`);
  const sw = shot('SW', g);
  const rs = yd(sw.final.x - sw.landing.x);
  assert.ok(rs <= 1 && rs >= -5, `SW roll ${rs}`);
});

test('rough rolls less than fairway; bunker stops within 1.5 m', () => {
  for (const id of ['D', '7i']) {
    const f = shot(id);
    const r = shot(id, flat(SURF.ROUGH));
    assert.ok(r.total - r.carry < f.total - f.carry, id);
  }
  // A full wedge checks up on either (the rough's grass kills the backspin, so it does not draw back).
  for (const s of [SURF.FAIRWAY, SURF.ROUGH]) {
    const w = shot('PW', flat(s));
    assert.ok(Math.abs(w.total - w.carry) < 1.5, `PW on ${s}: ${w.total - w.carry}`);
  }
  for (const id of ['D', '7i', 'SW']) {
    const b = shot(id, flat(SURF.BUNKER));
    assert.ok(Math.hypot(b.final.x - b.landing.x, b.final.y - b.landing.y) < 1.5, `${id} bunker`);
    assert.equal(b.final.surface, SURF.BUNKER);
  }
});

test('water on the fly: outcome water with waterEntry at the margin', () => {
  // Pond from x = 190 to 260 (water level 0.3 m below the fairway).
  const wet = (x) => x >= 190 && x <= 260;
  const t = makeTerrain({
    h: (x) => (wet(x) ? -0.8 : 0),
    surf: (x) => (wet(x) ? SURF.WATER : SURF.FAIRWAY),
    water: (x) => (wet(x) ? { kind: 'red', level: -0.3 } : null),
  });
  const r = shot('D', t);
  assert.equal(r.final.outcome, 'water');
  assert.ok(r.events.some((e) => e.type === 'water'));
  assert.ok(Math.abs(r.waterEntry.x - 190) < 0.5, `entry ${r.waterEntry.x}`);
  assert.ok(r.lastDry.x < 190);
  assert.ok(Math.abs(r.final.z - (-0.3 + BALL_R)) < 1e-6, 'splashes at the water level');
  assert.ok(r.landing && r.carry > 190);
});

test('rolling into water: outcome water with lastDry on the bank', () => {
  const wet = (x) => x >= 3;
  const t = makeTerrain({ surf: (x) => (wet(x) ? SURF.WATER : SURF.GREEN), water: (x) => (wet(x) ? { kind: 'yellow', level: 0 } : null) });
  const r = simulateShot(t, stockLaunch('P', { ballSpeed: 3 }));
  assert.equal(r.final.outcome, 'water');
  assert.ok(r.lastDry.x < 3 && r.lastDry.x > 2.9, `lastDry ${r.lastDry.x}`);
  assert.ok(Math.abs(r.waterEntry.x - 3) < 0.02);
  assert.equal(r.landing, null);
  assert.equal(r.carry, 0);
});

test('out of bounds: resting on OOB gives outcome ob', () => {
  const r = shot('7i', makeTerrain({ oob: (x) => x > 100 }));
  assert.equal(r.final.outcome, 'ob');
  const s = shot('7i', makeTerrain({ surf: (x) => (x > 100 ? SURF.OOB : SURF.FAIRWAY) }));
  assert.equal(s.final.outcome, 'ob');
});

test('crest: a fast rolling ball takes off over a sharp brow and lands further on', () => {
  const h = (x) => (x < 5 ? 0 : x < 8 ? -0.6 * (x - 5) : -1.8);
  const t = makeTerrain({ h, surf: () => SURF.GREEN });
  const r = simulateShot(t, makeLaunch({ ballSpeed: 6, mode: 'roll', club: clubById('7i') }));
  let maxGap = 0;
  for (let i = 0; i < r.path.length; i += 4) maxGap = Math.max(maxGap, r.path[i + 3] - BALL_R - h(r.path[i + 1]));
  assert.ok(maxGap > 0.05, `airborne gap ${maxGap}`);
  assert.ok(r.events.some((e) => e.type === 'bounce'));
  // A slow ball stays on the ground over a gentle crest.
  const g = makeTerrain({ h: (x) => (x < 5 ? 0.05 * x : 0.25 - 0.05 * (x - 5)), surf: () => SURF.GREEN });
  const s = simulateShot(g, makeLaunch({ ballSpeed: 1.5, mode: 'roll' }));
  let gap = 0;
  for (let i = 0; i < s.path.length; i += 4) gap = Math.max(gap, s.path[i + 3] - BALL_R - g.heightAt(s.path[i + 1], 0));
  assert.ok(gap < 0.005, `slow ball gap ${gap}`);
});

test('canopy: a shot through a dense canopy usually hits it and drops short', () => {
  // Place a big canopy where an unobstructed 7i passes about 12 m up.
  const free = shot('7i');
  let i = 0;
  while (free.path[i + 1] < 50) i += 4;
  const z50 = free.path[i + 3];
  let hits = 0;
  for (let seed = 1; seed <= 10; seed++) {
    const tree = { x: 50, y: 0, trunkR: 0.4, trunkH: z50 - 8, canopy: { cz: z50, rx: 6, rz: 5 }, kind: 'oak' };
    const r = simulateShot(makeTerrain({ trees: [tree] }), stockLaunch('7i'), { seed });
    if (r.events.some((e) => e.type === 'tree')) {
      hits++;
      assert.ok(r.total < free.total * 0.6, `hit but went ${r.total}`);
    } else {
      assert.ok(Math.abs(r.carry - free.carry) < 1e-6, 'a miss leaves the flight untouched');
    }
  }
  assert.ok(hits >= 7, `hits ${hits}/10`);
});

test('trunk: a low runner hitting a trunk rebounds', () => {
  const tree = { x: 10, y: 0, trunkR: 0.3, trunkH: 4, canopy: { cz: 7, rx: 3, rz: 3 }, kind: 'pine' };
  const t = makeTerrain({ trees: [tree] });
  const r = simulateShot(t, makeLaunch({ pos: { x: 0, y: 0, z: 0.5 }, ballSpeed: 20, launchDeg: 5 }));
  const ev = r.events.find((e) => e.type === 'tree');
  assert.ok(ev, 'tree event');
  assert.ok(Math.abs(ev.x - (10 - 0.3 - BALL_R)) < 0.05, `contact at ${ev.x}`);
  assert.ok(r.final.x < 9.7, `final ${r.final.x}`);
  const hit = treeHit(tree, { x: 9, y: 0, z: 1 }, { x: 11, y: 0, z: 1 });
  assert.equal(hit.kind, 'trunk');
  assert.ok(Math.abs(hit.nx + 1) < 1e-9);
  assert.equal(treeHit(tree, { x: 9, y: 0, z: 3.5 }, { x: 9.5, y: 0, z: 3.5 }), null);
  assert.equal(treeHit(tree, { x: 9, y: 0, z: 7 }, { x: 9.5, y: 0, z: 7 }).kind, 'canopy');
});

test('trunk top: a ball dropping onto it glances off and falls without hanging', () => {
  const tree = { x: 0, y: 0, trunkR: 0.3, trunkH: 4, canopy: { cz: 7, rx: 3, rz: 3 }, kind: 'oak' };
  const t = makeTerrain({ trees: [tree] });
  for (const off of [0, 0.1, 0.25]) {
    // Falling almost straight down from 6 m onto the trunk top (a canopy deflection does this).
    const r = simulateShot(t, makeLaunch({ pos: { x: off, y: 0, z: 6 }, ballSpeed: 3, launchDeg: -85 }), { pin: false });
    assert.ok(r.events.some((e) => e.type === 'tree'), 'hit the trunk');
    const P = r.path;
    let still = 0;
    for (let i = 4; i < P.length; i += 4) {
      if (P[i + 3] > 0.1 && Math.abs(P[i + 3] - P[i - 1]) < 1e-4) still += P[i] - P[i - 4];
    }
    assert.ok(still < 0.05, `motionless in the air for ${still.toFixed(2)} s`);
    assert.ok(Math.hypot(r.final.x, r.final.y) > 0.3 + BALL_R, 'ends outside the trunk');
    assert.ok(r.t < 10, `shot lasts ${r.t} s`);
  }
});

test('rest: a slow ball on a slope just inside the hold limit stops instead of creeping to MAX_SHOT_T', () => {
  for (const [surf, slope] of [[SURF.ROUGH, 0.393], [SURF.ROUGH, 0.402], [SURF.FAIRWAY, 0.166], [SURF.GREEN, 0.066], [SURF.BUNKER, 1.1]]) {
    const t = planeTerrain({ surface: surf, sx: slope });
    for (const v0 of [0.05, 0.3]) {
      const r = simulateShot(t, makeLaunch({ pos: { x: 0, y: 0, z: 0 }, aimYaw: 0, ballSpeed: v0, mode: 'roll' }), { record: false });
      assert.ok(r.t < 30, `surface ${surf} at ${slope * 100}% from ${v0} m/s: t = ${r.t.toFixed(1)} s, moved ${r.total.toFixed(2)} m`);
    }
  }
});

test('flagstick: a ball flying into the pin bounces off it', () => {
  const cup = { x: 30, y: 0, z: 0 };
  const t = makeTerrain({ cup, surf: () => SURF.GREEN });
  // Thrown level at 1 m height from 5 m out: it meets the stick about 0.8 m up.
  const r2 = simulateShot(t, makeLaunch({ pos: { x: 25, y: 0, z: 1 }, ballSpeed: 12, launchDeg: 0 }));
  assert.ok(r2.events.some((e) => e.type === 'pin'));
  assert.ok(r2.final.x < 32, `final ${r2.final.x}`);
  const off = simulateShot(t, makeLaunch({ pos: { x: 25, y: 0, z: 1 }, ballSpeed: 12, launchDeg: 0 }), { pin: false });
  assert.ok(!off.events.some((e) => e.type === 'pin'));
});

test('slam dunk: a slow ball dropping onto the cup is holed', () => {
  const cup = { x: 5, y: 0, z: 0 };
  const t = makeTerrain({ cup, surf: () => SURF.GREEN });
  const r = simulateShot(t, makeLaunch({ pos: { x: 5, y: 0, z: 1 }, ballSpeed: 0.5, launchDeg: -90 }));
  assert.equal(r.final.outcome, 'holed');
  assert.ok(r.events.some((e) => e.type === 'cup'));
});

test('bounceImpulse: vertical drop follows the Penner restitution curve', () => {
  const v = { x: 0, y: 0, z: -5 };
  const w = { x: 0, y: 0, z: 0 };
  const out = bounceImpulse(v, w, { x: 0, y: 0, z: 1 }, { ...SURFACES[SURF.FAIRWAY], e: 1 });
  const e = 0.51 - 0.0375 * 5 + 0.000903 * 25;
  assert.ok(Math.abs(out - 5 * e) < 1e-9);
  // Backspin landing: friction reverses through the impact, never adds energy.
  const v2 = { x: 8, y: 0, z: -10 };
  const w2 = { x: 0, y: -900, z: 0 };
  bounceImpulse(v2, w2, { x: 0, y: 0, z: 1 }, SURFACES[SURF.GREEN]);
  assert.ok(v2.x < 8);
  assert.ok(Math.hypot(v2.x, v2.z) < Math.hypot(8, 10));
});

test('flightStep: RK4 free fall without air matches the closed form', () => {
  const s = { p: { x: 0, y: 0, z: 100 }, v: { x: 0, y: 0, z: 0 }, w: { x: 0, y: 0, z: 0 } };
  flightStep(s, 0.01);
  // Tiny drag at ~0.1 m/s is negligible.
  assert.ok(Math.abs(s.v.z + G * 0.01) < 1e-6);
  assert.ok(Math.abs(s.p.z - (100 - 0.5 * G * 1e-4)) < 1e-8);
});

test('planeTerrain satisfies the contract simulateShot needs', () => {
  const t = planeTerrain({ surface: SURF.GREEN, sx: 0.02 });
  assert.ok(Math.abs(t.normalAt(0, 0).x + 0.02 / Math.hypot(0.02, 1)) < 1e-12);
  const r = simulateShot(t, stockLaunch('PW'));
  assert.equal(r.final.outcome, 'rest');
});

test('performance: driver < 20 ms, 30 m putt < 15 ms', () => {
  const g = flat(SURF.GREEN);
  for (let i = 0; i < 3; i++) shot('D');
  let t0 = performance.now();
  for (let i = 0; i < 5; i++) shot('D');
  const dms = (performance.now() - t0) / 5;
  assert.ok(dms < 20, `driver ${dms} ms`);
  t0 = performance.now();
  for (let i = 0; i < 5; i++) simulateShot(g, stockLaunch('P', { ballSpeed: 6.8 }));
  const pms = (performance.now() - t0) / 5;
  assert.ok(pms < 15, `putt ${pms} ms`);
});
