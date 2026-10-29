// Green reading (section 8.9): the putt preview is the real error-free putt, the caddie's read
// holes putts on real greens of every course, its words have the right signs and units, and the
// throttle keeps the simulations down.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aidLevel, previewPutt, previewShot, readPutt, PuttReader, readText, puttNotchPower, rangeForRead, visibleEnd,
  drapePath, PreviewThrottle, slopeAt, slopeBand, fmtSmall, passAt, crossAt, READ_PAST,
} from '../src/putting-aid.js';
import { Game } from '../src/game.js';
import { COURSES, courseById, mixedCourse } from '../src/courses.js';
import { simulateShot, planeTerrain } from '../src/physics.js';
import { swingToLaunch, PUTT_RANGES } from '../src/swing.js';
import { clubById, PUTTER_ID } from '../src/clubs.js';
import { lieAt } from '../src/lie.js';
import { BALL_R, SURF } from '../src/constants.js';
import { mulberry32 } from '../src/rng.js';

const PUTTER = clubById(PUTTER_ID);

// A rng whose gaussian() is exactly 0 (u = 1 -> sqrt(-2 ln 1) = 0): the game's contact scatter
// vanishes and its shot seed is 0, so Game#swing plays the error-free putt.
function zeroRng() {
  const f = () => 1;
  f.state = () => 1;
  return f;
}

// Ball spots on the green of hole i, d metres from the cup in a few directions.
function greenSpots(t, ds, seed = 1) {
  const r = mulberry32(seed);
  const out = [];
  for (const d of ds) {
    for (let k = 0; k < 24; k++) {
      const a = r() * Math.PI * 2;
      const x = t.cup.x + Math.cos(a) * d;
      const y = t.cup.y + Math.sin(a) * d;
      if (t.surfaceAt(x, y) === SURF.GREEN) {
        out.push({ x, y });
        break;
      }
    }
  }
  return out;
}

function putterGame(course, hole, seed = 3) {
  const g = new Game({ course, seed, settings: { wind: 'light' } });
  g.loadHole(hole);
  return g;
}

test('aidLevel: auto is full on Easy, partial on Normal, off on Pro; explicit settings win', () => {
  assert.equal(aidLevel('auto', 'easy'), 'full');
  assert.equal(aidLevel('auto', 'normal'), 'partial');
  assert.equal(aidLevel('auto', 'pro'), 'off');
  assert.equal(aidLevel('full', 'pro'), 'full');
  assert.equal(aidLevel('off', 'easy'), 'off');
  assert.equal(aidLevel('partial', 'easy'), 'partial');
});

test('preview equals the real error-free putt bit for bit on greens of every course and a Mixed round', () => {
  const courses = [...COURSES, mixedCourse(11, null, 18)];
  let n = 0;
  for (const course of courses) {
    for (const hole of [0, 4, course.holes.length - 1]) {
      const g = putterGame(course, hole);
      const t = g.terrain;
      for (const s of greenSpots(t, [3, 8], hole + 1)) {
        g.debugPlace(s.x, s.y);
        g.setClub(PUTTER_ID);
        g.setAim(g.aimYaw + 0.02);
        const power = 0.55 + 0.1 * (n % 3);
        const ball = { ...g.state.hole.ball };
        // Against the physics directly (the launch the game builds, no rng).
        const sw = { ok: true, kind: 'putt', power, startDir: 0, faceToPath: 0, tempo: 'smooth' };
        const launch = swingToLaunch(PUTTER, g.lie, sw, g.aimYaw, null, { pos: ball, puttRange: g.puttRange, shot: 'normal', handed: 'R' });
        const real = simulateShot(t, launch, { wind: g.wind, seed: 0 });
        const pv = previewPutt(t, { ball, lie: g.lie, aimYaw: g.aimYaw, power, puttRange: g.puttRange, wind: g.wind, seed: 0 });
        assert.deepEqual(pv.path, real.path);
        assert.deepEqual(pv.final, real.final);
        // And against the game's own stroke with the scatter zeroed.
        g._rng = zeroRng();
        g.swing({ ok: true, kind: 'putt', power, startDir: 0, faceToPath: 0, tempo: 'smooth' });
        assert.deepEqual(g.shot.result.final, pv.final, `${course.id} hole ${hole + 1}`);
        assert.equal(pv.holed, pv.final.outcome === 'holed');
        n++;
      }
    }
  }
  assert.ok(n >= 25, `${n} putts compared`);
});

test('previewShot is the game launch without scatter on the real hole (a chip)', () => {
  const g = putterGame(COURSES[0], 1);
  const t = g.terrain;
  // 20 m short of the cup, back down the hole.
  const P = t.path;
  const p = P.pointAt(Math.max(0, P.length - 25));
  g.debugPlace(p.x, p.y);
  g.setClub('SW');
  const ball = { ...g.state.hole.ball };
  const pv = previewShot(t, { ball, lie: g.lie, clubId: 'SW', aimYaw: g.aimYaw, power: 0.5, wind: g.wind, seed: 0 });
  g._rng = zeroRng();
  g.swing({ ok: true, kind: 'full', power: 0.5, startDir: 0, faceToPath: 0, tempo: 'smooth' });
  assert.deepEqual(pv.final, g.shot.result.final);
  assert.ok(pv.landing && pv.landIndex > 0 && pv.path[pv.landIndex * 4] >= g.shot.result.events.find((e) => e.type === 'land').t);
});

test('the caddie read holes putts on real greens of every course (fast and slow greens, big breakers)', () => {
  let holed = 0;
  let total = 0;
  let bigBreak = 0;
  for (const course of [courseById('desert'), courseById('links'), courseById('pines'), courseById('water')]) {
    for (const hole of [1, 3, 6]) {
      const g = putterGame(course, hole);
      const t = g.terrain;
      for (const s of greenSpots(t, [2.5, 6, 11, 16], hole * 7 + 1)) {
        g.debugPlace(s.x, s.y);
        g.setClub(PUTTER_ID);
        const r = readPutt(t, g.state.hole.ball, { lie: g.lie, wind: g.wind });
        total++;
        if (r.holed) holed++;
        if (Math.abs(r.aimOffset) > 0.25) bigBreak++;
        assert.ok(r.past > READ_PAST - 0.12 && r.past < READ_PAST + 0.12, `pace ${r.past.toFixed(2)} m past`);
        assert.ok(r.sims <= 32);
        // Played for real at the notch power on a fitting range, error-free: it drops.
        const range = rangeForRead(r.F);
        g.setPuttRange(range);
        g.setAim(r.aimYaw);
        const power = puttNotchPower(r, g.puttRange);
        assert.ok(power > 0 && power <= 0.85 + 1e-9);
        g._rng = zeroRng();
        g.swing({ ok: true, kind: 'putt', power, startDir: 0, faceToPath: 0, tempo: 'smooth' });
        const f = g.shot.result.final;
        assert.ok(f.outcome === 'holed' || Math.hypot(f.x - t.cup.x, f.y - t.cup.y) < 0.5, `${course.id} ${hole + 1}: ${f.outcome}`);
        g.shot = null;
        g._setPhase('address');
      }
    }
  }
  assert.ok(total >= 30, `${total} reads`);
  assert.ok(holed >= total - 1, `${holed}/${total} holed`);
  assert.ok(bigBreak >= 3, `${bigBreak} big breakers`);
});

test('PuttReader runs one simulation per step and matches readPutt', () => {
  const g = putterGame(courseById('water'), 2);
  const t = g.terrain;
  const s = greenSpots(t, [7])[0];
  g.debugPlace(s.x, s.y);
  g.setClub(PUTTER_ID);
  const rd = new PuttReader(t, g.state.hole.ball, { lie: g.lie, wind: g.wind });
  let steps = 0;
  while (!rd.step()) {
    steps++;
    assert.equal(rd.sims, steps);
  }
  assert.ok(rd.done && rd.result);
  const r2 = readPutt(t, g.state.hole.ball, { lie: g.lie, wind: g.wind });
  assert.equal(r2.aimYaw, rd.result.aimYaw);
  assert.equal(r2.F, rd.result.F);
});

// A tilted plane green: the putt runs along +x from the origin to a cup 6 m away; sx tilts it
// along the line (up > 0), sy across it (sy < 0: it falls to the left, toward +y... no: +y is
// left of +x, so a negative sy makes the left side lower).
function plane(sx, sy, d = 6) {
  const z0 = 10;
  const cup = { x: d, y: 0, z: z0 + sx * d };
  return planeTerrain({ surface: SURF.GREEN, sx, sy, z0, cup });
}

function readOn(t, units = 'yd') {
  const ball = { x: 0, y: 0, z: t.heightAt(0, 0) + BALL_R };
  const lie = lieAt(t, ball, 0, { handed: 'R' });
  const r = readPutt(t, ball, { lie });
  return { r, tx: readText(r, units) };
}

test('read words: a putt falling left breaks R→L and aims right; the mirror image; straight; up / down', () => {
  const left = readOn(plane(0, -0.02));
  assert.ok(left.r.holed);
  assert.ok(left.r.breakLat > 0.03 && left.r.aimOffset > 0);
  assert.match(left.tx.breakText, /R→L/);
  assert.match(left.tx.aimText, /right$/);
  const right = readOn(plane(0, 0.02));
  assert.ok(right.r.breakLat < -0.03 && right.r.aimOffset < 0);
  assert.match(right.tx.breakText, /L→R/);
  assert.match(right.tx.aimText, /left$/);
  assert.ok(Math.abs(left.r.aimOffset + right.r.aimOffset) < 0.02, 'mirror images aim mirror offsets');
  const up = readOn(plane(0.02, 0));
  assert.equal(up.tx.breakText, 'Straight');
  assert.equal(up.tx.aimText, 'Aim at the hole');
  assert.match(up.tx.slopeText, /^Uphill /);
  assert.match(up.tx.line1, /Uphill, plays/);
  const down = readOn(plane(-0.02, 0));
  assert.match(down.tx.slopeText, /^Downhill /);
  // Uphill plays longer than the distance, downhill shorter.
  assert.ok(up.r.plays > 6.3 && down.r.plays < 5.7, `${up.r.plays} / ${down.r.plays}`);
  assert.ok(up.r.F > down.r.F);
  const flat = readOn(plane(0, 0));
  assert.equal(flat.tx.slopeText, 'Level');
  assert.ok(Math.abs(flat.r.plays - 6) < 0.15);
});

test('read words: the golfer\'s hand changes nothing; Pro leaves out the break and the aim', () => {
  const t = plane(0.01, -0.025);
  const ball = { x: 0, y: 0, z: t.heightAt(0, 0) + BALL_R };
  const a = readPutt(t, ball, { lie: lieAt(t, ball, 0, { handed: 'R' }) });
  const b = readPutt(t, ball, { lie: lieAt(t, ball, 0, { handed: 'L' }) });
  assert.equal(a.aimYaw, b.aimYaw);
  assert.equal(a.F, b.F);
  const pro = readText(a, 'yd', { showAim: false });
  assert.equal(pro.line2, '');
  assert.doesNotMatch(pro.line1, /Breaks|Aim/);
  assert.match(pro.line1, /Uphill .* · Plays \d+ ft/);
});

test('units: inches and feet in yards mode, centimetres and metres in metres mode', () => {
  assert.equal(fmtSmall(0.1, 'yd'), '4 in');
  assert.equal(fmtSmall(0.3, 'yd'), '1 ft');
  assert.equal(fmtSmall(0.46, 'yd'), '1½ ft');
  assert.equal(fmtSmall(1.5, 'yd'), '5 ft');
  assert.equal(fmtSmall(0.1, 'm'), '10 cm');
  assert.equal(fmtSmall(-0.25, 'm'), '25 cm');
  assert.equal(fmtSmall(1.24, 'm'), '1.2 m');
  const { tx } = readOn(plane(0.015, -0.03), 'm');
  assert.match(tx.line1, /Breaks ~\d+ cm R→L · Uphill, plays \d\.\d m/);
  assert.match(tx.slopeText, /cm$/);
  const ft = readOn(plane(0.015, -0.03), 'yd').tx;
  assert.match(ft.playsText, /^Plays \d+ ft$/);
  // Cup counts: half cups, then feet beyond six cups.
  const base = { breakLat: 0, dz: 0, plays: 3 };
  assert.equal(readText({ ...base, aimOffset: 0.05 }, 'yd').aimText, 'Aim ½ cup right');
  assert.equal(readText({ ...base, aimOffset: -0.22 }, 'yd').aimText, 'Aim 2 cups left');
  assert.equal(readText({ ...base, aimOffset: 0.9 }, 'yd').aimText, 'Aim 3 ft right');
  assert.equal(readText({ ...base, aimOffset: 0.01 }, 'yd').aimText, 'Aim at the hole');
});

test('notch power and range: the read pace over the range, a range that fits it', () => {
  assert.equal(puttNotchPower({ F: 6 }, 12), 0.5);
  assert.equal(puttNotchPower({ F: 40 }, 30), null);
  assert.equal(rangeForRead(2), 3);
  assert.equal(rangeForRead(5.2), 9);
  assert.equal(rangeForRead(100), PUTT_RANGES[PUTT_RANGES.length - 1]);
  for (const F of [1, 4, 7.7, 15, 24]) assert.ok(F / rangeForRead(F) <= 0.85);
});

test('slope bands and slopeAt', () => {
  assert.deepEqual([0.5, 1, 2.4, 2.5, 3.9, 4.1].map(slopeBand), [0, 1, 1, 2, 2, 3]);
  const s = slopeAt(plane(0.03, -0.04), 1, 1);
  assert.ok(Math.abs(s.pct - 5) < 1e-6);
  // Downhill is toward -x (it rises along +x) and +y (it falls toward +y).
  assert.ok(Math.abs(s.downYaw - Math.atan2(0.04, -0.03)) < 1e-9);
});

test('visibleEnd: all, none, or up to the break within 40-65% of the roll', () => {
  const t = plane(0, -0.03);
  const ball = { x: 0, y: 0, z: t.heightAt(0, 0) + BALL_R };
  const pv = previewPutt(t, { ball, lie: {}, aimYaw: 0.1, power: 0.7, puttRange: 12 });
  let L = 0;
  const p = pv.path;
  for (let i = 1; i < p.length / 4; i++) L += Math.hypot(p[i * 4 + 1] - p[i * 4 - 3], p[i * 4 + 2] - p[i * 4 - 2]);
  assert.equal(visibleEnd(p, 'full'), Infinity);
  assert.equal(visibleEnd(p, 'off'), 0);
  const v = visibleEnd(p, 'partial');
  assert.ok(v >= 0.4 * L - 1e-9 && v <= 0.65 * L + 1e-9, `${v} of ${L}`);
  const straight = previewPutt(plane(0.01, 0), { ball: { x: 0, y: 0, z: 10 + BALL_R }, lie: {}, aimYaw: 0, power: 0.5, puttRange: 9 });
  let L2 = 0;
  const q = straight.path;
  for (let i = 1; i < q.length / 4; i++) L2 += Math.hypot(q[i * 4 + 1] - q[i * 4 - 3], q[i * 4 + 2] - q[i * 4 - 2]);
  assert.ok(Math.abs(visibleEnd(q, 'partial') - 0.5 * L2) < 1e-6);
});

test('drapePath: draped points up to the arc length, into a reused buffer', () => {
  const t = plane(0.02, -0.01);
  const ball = { x: 0, y: 0, z: t.heightAt(0, 0) + BALL_R };
  const pv = previewPutt(t, { ball, lie: {}, aimYaw: 0, power: 0.6, puttRange: 12 });
  const out = new Float32Array(3 * 520);
  const n = drapePath(t, pv.path, 3, out);
  assert.ok(n > 10 && n <= 520);
  let L = 0;
  for (let i = 1; i < n; i++) L += Math.hypot(out[i * 3] - out[i * 3 - 3], out[i * 3 + 1] - out[i * 3 - 2]);
  assert.ok(Math.abs(L - 3) < 0.02, `length ${L}`);
  for (let i = 0; i < n; i++) assert.ok(Math.abs(out[i * 3 + 2] - (t.heightAt(out[i * 3], out[i * 3 + 1]) + 0.012)) < 1e-4);
  assert.equal(drapePath(t, pv.path, 0, out), 0);
  // A tiny buffer is filled, never overrun.
  const small = new Float32Array(3 * 5);
  assert.equal(drapePath(t, pv.path, Infinity, small), 5);
});

test('passAt: the miss and the pace of a path past the hole', () => {
  const path = new Float32Array([0, 0, 0, 0, 0.1, 1, 0.02, 0, 0.2, 2, 0.02, 0, 0.3, 2.5, 0.02, 0]);
  const m = passAt(path, { x: 1, y: 0 });
  assert.ok(Math.abs(m.lat - -0.02) < 1e-4, `lat ${m.lat}`); // passes on the left (+y) of the hole
  assert.ok(Math.abs(m.past - 1.5) < 0.01);
  const short = passAt(new Float32Array([0, 0, 0, 0, 0.1, 0.6, 0, 0]), { x: 1, y: 0 });
  assert.ok(Math.abs(short.past + 0.4) < 1e-6);
});

test('PreviewThrottle: at most one run per interval while moving, one exact run once still, never the same key twice', () => {
  const th = new PreviewThrottle({ interval: 0.15, settle: 0.08 });
  let runs = 0;
  let t = 0;
  // The aim moves every frame for one second.
  for (let k = 0; k < 60; k++, t += 1 / 60) if (th.want(k, t)) runs++;
  assert.ok(runs >= 6 && runs <= 8, `${runs} runs while moving`);
  // Then it holds still: exactly one more run (the exact one), after `settle`.
  let still = 0;
  let at = null;
  const t0 = t;
  for (let k = 0; k < 60; k++, t += 1 / 60) {
    if (th.want(1000, t)) {
      still++;
      at = t;
    }
  }
  assert.equal(still, 1);
  assert.ok(at - t0 <= 0.15 + 1e-9);
  assert.equal(th.want(1000, t + 5), false);
  // A fresh key after a pause runs at once.
  assert.equal(th.want(2000, t + 6), true);
  th.reset();
  assert.equal(th.want(2000, t + 6.01), true);
});

test('crossAt: the miss along the hole line and the pace, short or past', () => {
  const ball = { x: 0, y: 0 };
  const cup = { x: 1, y: 0 };
  const m = crossAt(new Float32Array([0, 0, 0, 0, 0.1, 0.5, 0.03, 0, 0.2, 1.5, 0.03, 0, 0.3, 2, 0.03, 0]), ball, cup);
  assert.ok(Math.abs(m.lat + 0.03) < 1e-6 && Math.abs(m.past - 1) < 1e-4);
  const short = crossAt(new Float32Array([0, 0, 0, 0, 0.1, 0.7, -0.05, 0]), ball, cup);
  assert.ok(Math.abs(short.past + 0.3) < 1e-6 && Math.abs(short.lat - 0.05) < 1e-6);
});

test('big breakers on steep synthetic greens still read and hole', () => {
  for (const [sx, sy] of [[0, -0.035], [0.02, 0.03], [-0.015, -0.03], [0.03, 0]]) {
    const { r } = readOn(plane(sx, sy, 9));
    assert.ok(r.holed, `${sx}/${sy}`);
    assert.ok(r.sims <= 14, `${r.sims} sims`);
  }
});
