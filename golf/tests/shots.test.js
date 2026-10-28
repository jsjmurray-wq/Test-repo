// Special shots (docs/architecture.md section 8.4): eligibility, the shot table's target results
// with the real physics and clubs over flat synthetic ground (full power, no wind unless stated),
// handedness, the swingToLaunch hook and the caddie following the selected shot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SHOTS, shotById, shotsFor, isEligible, applyShot, shotIntent } from '../src/shots.js';
import { swingToLaunch } from '../src/swing.js';
import { simulateShot, planeTerrain } from '../src/physics.js';
import { lieAt } from '../src/lie.js';
import { clubById, CLUBS } from '../src/clubs.js';
import { clubTable, clubRow, powerCurve, curveAt, predictShot, shotPreview, releaseK, RELEASE_K } from '../src/caddie.js';
import { mulberry32 } from '../src/rng.js';
import { SURF, mToYd } from '../src/constants.js';

const STOCK = { ok: true, kind: 'full', power: 1, startDir: 0, faceToPath: 0, tempo: 'smooth' };
const ZERO = { x: 0, y: 0 };
const fairway = planeTerrain({ surface: SURF.FAIRWAY });
const teeLie = lieAt(fairway, { x: 0, y: 0 }, 0);

// One shot along +x from the origin (aim yaw 0: + y is LEFT of the line) over flat ground.
function hit(clubId, shot, { land = SURF.FAIRWAY, wind = ZERO, power = 1, handed = 'R', conditions = null, swing = {} } = {}) {
  const t = planeTerrain({ surface: land, conditions });
  const launch = swingToLaunch(clubId, teeLie, { ...STOCK, power, ...swing }, 0, null, { pos: { x: 0, y: 0, z: 0.03 }, shot, handed });
  const r = simulateShot(t, launch, { wind, record: false, pin: false });
  const landEv = r.events.find((e) => e.type === 'land');
  return { carry: r.carry, total: r.total, roll: r.total - r.carry, apex: r.apex, left: r.final.y, angle: landEv ? landEv.angle : null, launch };
}
const yd = (m) => mToYd(m);

// ------------------------------------------------------------------ eligibility

test('SHOTS: the seven shots in menu order, each with a name and a one-line blurb', () => {
  assert.deepEqual(SHOTS.map((s) => s.id), ['normal', 'draw', 'cut', 'stinger', 'punch', 'flop', 'bump']);
  for (const s of SHOTS) {
    assert.ok(s.name && s.blurb && s.blurb.length < 70, s.id);
  }
  assert.equal(shotById('bump').name, 'Bump & run');
  assert.equal(shotById('nope').id, 'normal');
});

test('eligibility: draw/cut for every full-swing club, the rest by club and lie', () => {
  const ids = (club, lie) => shotsFor(clubById(club), lie);
  const L = (surface) => ({ surface });
  assert.deepEqual(ids('P', L(SURF.GREEN)), ['normal'], 'the putter only putts');
  for (const c of CLUBS.filter((k) => k.kind !== 'putter')) {
    const s = shotsFor(c, L(SURF.FAIRWAY));
    assert.equal(s[0], 'normal');
    assert.ok(s.includes('draw') && s.includes('cut'), c.id);
    assert.equal(s.includes('stinger'), ['D', '3W', '5W', '4H', '5i', '6i'].includes(c.id), `stinger ${c.id}`);
    assert.equal(s.includes('punch'), ['4H', '5i', '6i', '7i', '8i', '9i', 'PW', 'GW'].includes(c.id), `punch ${c.id}`);
    assert.equal(s.includes('flop'), ['GW', 'SW', 'LW'].includes(c.id), `flop ${c.id}`);
    assert.equal(s.includes('bump'), ['7i', '8i', '9i', 'PW', 'GW', 'SW'].includes(c.id), `bump ${c.id}`);
  }
  assert.deepEqual(ids('D', L(SURF.TEE)), ['normal', 'draw', 'cut', 'stinger']);
  assert.deepEqual(ids('GW', L(SURF.ROUGH)), ['normal', 'draw', 'cut', 'punch', 'flop', 'bump']);
  // No stinger from sand or fescue; no flop off hardpan or desert floor (no cushion of grass).
  assert.ok(!ids('5i', L(SURF.BUNKER)).includes('stinger'));
  assert.ok(!ids('5i', L(SURF.FESCUE)).includes('stinger'));
  assert.ok(ids('5i', L(SURF.ROUGH)).includes('stinger'));
  assert.ok(!ids('LW', L(SURF.WASTE)).includes('flop'));
  assert.ok(!ids('LW', L(SURF.DESERT)).includes('flop'));
  assert.ok(ids('LW', L(SURF.BUNKER)).includes('flop'));
  // Without a lie only the club matters; ids also work.
  assert.ok(isEligible('stinger', 'D', null));
  assert.ok(!isEligible('stinger', '7i', null));
  assert.ok(!isEligible('unknown', '7i', null));
});

test('applyShot: normal, an unknown id and the putter change nothing; the factors apply otherwise', () => {
  const p = { ballSpeed: 50, launchDeg: 16, spinRpm: 7000, startDirDeg: 1, faceToPathDeg: 0.5, extra: 'kept' };
  const c = clubById('7i');
  assert.deepEqual(applyShot(p, 'normal', c, null), p);
  assert.deepEqual(applyShot(p, 'what', c, null), p);
  assert.deepEqual(applyShot(p, 'draw', clubById('P'), null), p);
  assert.notEqual(applyShot(p, 'normal', c, null), p, 'a copy');
  const pu = applyShot(p, 'punch', c, null);
  assert.ok(Math.abs(pu.launchDeg - 16 * 0.6) < 1e-9 && Math.abs(pu.spinRpm - 7000 * 0.75) < 1e-9 && pu.extra === 'kept');
  // Draw: the path moves 3 deg right and the face closes 4 deg to it, on top of the swing's own.
  const d = applyShot(p, 'draw', c, null);
  const k = 0.75; // irons
  const path0 = p.startDirDeg - k * p.faceToPathDeg;
  const path1 = d.startDirDeg - k * d.faceToPathDeg;
  assert.ok(Math.abs(path1 - path0 - 3) < 1e-9 && Math.abs(d.faceToPathDeg - p.faceToPathDeg + 4) < 1e-9);
  // Left-handed: mirrored.
  const dl = applyShot(p, 'draw', c, null, { handed: 'L' });
  assert.ok(Math.abs(dl.faceToPathDeg - p.faceToPathDeg - 4) < 1e-9);
  assert.deepEqual(shotIntent('draw', c, 'L'), { startDirDeg: -shotIntent('draw', c, 'R').startDirDeg, faceToPathDeg: 4 });
  assert.deepEqual(shotIntent('stinger', c), { startDirDeg: 0, faceToPathDeg: 0 });
  // A flop off a short wedge swing is capped at 60 deg of launch.
  assert.equal(applyShot({ ...p, launchDeg: 50 }, 'flop', clubById('LW'), null).launchDeg, 60);
});

// ------------------------------------------------------------------ the shot table

test('draw and cut: a 7-iron finishes 6-15 yd left / right of the normal shot; mirrored left-handed', () => {
  const n = hit('7i', 'normal');
  const d = hit('7i', 'draw');
  const c = hit('7i', 'cut');
  assert.ok(yd(d.left - n.left) >= 6 && yd(d.left - n.left) <= 15, `draw ${yd(d.left - n.left)} yd left`);
  assert.ok(yd(n.left - c.left) >= 6 && yd(n.left - c.left) <= 15, `cut ${yd(n.left - c.left)} yd right`);
  // The draw is delofted (spin -8%) and runs about 3-8 yd further; the cut carries 2-4% less.
  assert.ok(d.launch.meta.spinRpm < n.launch.meta.spinRpm * 0.93);
  assert.ok(yd(d.roll - n.roll) >= 3 && yd(d.roll - n.roll) <= 8, `draw rolls ${yd(d.roll - n.roll)} yd more`);
  const cutLoss = 1 - c.carry / n.carry;
  assert.ok(cutLoss >= 0.02 && cutLoss <= 0.04, `cut carry -${(cutLoss * 100).toFixed(1)}%`);
  assert.ok(c.launch.meta.spinRpm > n.launch.meta.spinRpm * 1.07 && c.launch.meta.launchDeg > n.launch.meta.launchDeg + 0.9);
  // Both start on the aim line (irons) and bend: the curve comes from the face-to-path.
  assert.ok(Math.abs(d.launch.meta.startDirDeg) < 0.01 && d.launch.meta.tiltDeg < -5);
  assert.ok(Math.abs(c.launch.meta.startDirDeg) < 0.01 && c.launch.meta.tiltDeg > 5);
  // Left-handed: the draw goes right by the same amount, the cut left.
  const dl = hit('7i', 'draw', { handed: 'L' });
  const cl = hit('7i', 'cut', { handed: 'L' });
  assert.ok(Math.abs(dl.left + d.left) < 1e-6 && Math.abs(dl.total - d.total) < 1e-6, `${dl.left} vs ${d.left}`);
  assert.ok(Math.abs(cl.left + c.left) < 1e-6);
  // Every club draws left and cuts right; the lofted ones (more spin loft) bend least.
  let prev = Infinity;
  for (const id of ['D', '5i', 'PW', 'LW']) {
    const nn = hit(id, 'normal');
    const bend = hit(id, 'draw').left - nn.left;
    assert.ok(bend > 1.5 && nn.left - hit(id, 'cut').left > 1.5 && bend < prev, `${id} bends ${bend.toFixed(1)} m`);
    prev = bend;
  }
});

test("the swipe's own curve adds to a draw's", () => {
  const d = hit('7i', 'draw');
  const fade = hit('7i', 'draw', { swing: { faceToPath: 2 } });
  assert.ok(Math.abs(fade.launch.meta.faceToPathDeg - -2) < 1e-9, 'face-to-path -4 + 2');
  assert.ok(fade.left < d.left - 2, 'a fading swipe straightens the draw');
});

test('stinger: a driver stays under 15 m, carries 15-25% less, rolls 2-4x as far, total -12%..+5%', () => {
  for (const conditions of [null, { firm: 1.45 }]) {
    const n = hit('D', 'normal', { conditions });
    const s = hit('D', 'stinger', { conditions });
    const tag = conditions ? 'firm links fairway' : 'fairway';
    assert.ok(s.apex < 15 && n.apex > 20, `${tag}: apex ${s.apex.toFixed(1)} m`);
    const loss = 1 - s.carry / n.carry;
    assert.ok(loss >= 0.15 && loss <= 0.25, `${tag}: carry -${(loss * 100).toFixed(1)}%`);
    const roll = s.roll / n.roll;
    assert.ok(roll >= 2 && roll <= 4, `${tag}: roll x${roll.toFixed(2)}`);
    const tot = s.total / n.total - 1;
    assert.ok(tot >= -0.12 && tot <= 0.05, `${tag}: total ${(tot * 100).toFixed(1)}%`);
  }
  // The long irons and woods fly low too.
  for (const id of ['3W', '5W', '4H', '5i', '6i']) assert.ok(hit(id, 'stinger').apex < 0.5 * hit(id, 'normal').apex, id);
});

test('punch: apex under 60% of normal, carry 80-90%, and a 5 m/s headwind costs at most half as much', () => {
  const head = { x: -5, y: 0 };
  for (const id of ['4H', '5i', '6i', '7i', '8i', '9i', 'PW', 'GW']) {
    const n = hit(id, 'normal');
    const p = hit(id, 'punch');
    assert.ok(p.apex < 0.6 * n.apex, `${id} apex ${(p.apex / n.apex).toFixed(2)}`);
    const c = p.carry / n.carry;
    assert.ok(c >= 0.8 && c <= 0.9, `${id} carry ${c.toFixed(3)}`);
    const lossN = n.carry - hit(id, 'normal', { wind: head }).carry;
    const lossP = p.carry - hit(id, 'punch', { wind: head }).carry;
    assert.ok(lossN > 5 && lossP <= 0.5 * lossN, `${id} headwind costs ${lossP.toFixed(1)} m vs ${lossN.toFixed(1)} m`);
  }
});

test('flop: lands at 55 deg or steeper and stops within 3 yd on the green', () => {
  for (const id of ['GW', 'SW', 'LW']) {
    const n = hit(id, 'normal', { land: SURF.GREEN });
    const f = hit(id, 'flop', { land: SURF.GREEN });
    assert.ok(f.angle >= 55, `${id} lands at ${f.angle.toFixed(1)} deg`);
    assert.ok(f.angle > n.angle + 5 && f.apex < n.apex && f.carry < 0.65 * n.carry, `${id} higher, softer, shorter`);
    assert.ok(Math.abs(yd(f.roll)) <= 3, `${id} rolls ${yd(f.roll).toFixed(1)} yd`);
  }
  // A short flop (the usual use) stops too.
  for (const power of [0.4, 0.6]) assert.ok(Math.abs(yd(hit('LW', 'flop', { land: SURF.GREEN, power }).roll)) <= 3, `LW at ${power}`);
});

test('bump & run: carry is 25-45% of the total, and far more of it rolls than a normal pitch', () => {
  for (const id of ['7i', '8i', '9i', 'PW', 'GW', 'SW']) {
    const b = hit(id, 'bump');
    const f = b.carry / b.total;
    assert.ok(f >= 0.25 && f <= 0.45, `${id} carry ${(f * 100).toFixed(0)}% of total`);
    assert.ok(b.apex < 3, `${id} apex ${b.apex.toFixed(1)}`);
  }
  // A 25-yard chip: mostly roll, against a normal pitch that mostly flies.
  const chip = hit('8i', 'bump', { power: 0.35 });
  const pitch = hit('SW', 'normal', { power: 0.35 });
  assert.ok(chip.roll > 2 * chip.carry && pitch.carry > pitch.roll, `${chip.carry}/${chip.roll} vs ${pitch.carry}/${pitch.roll}`);
});

test('contact scatter still applies to a special shot, seeded', () => {
  const sw = { ...STOCK };
  const a = swingToLaunch('7i', teeLie, sw, 0, mulberry32(5), { shot: 'punch' });
  const b = swingToLaunch('7i', teeLie, sw, 0, mulberry32(5), { shot: 'punch' });
  const ideal = swingToLaunch('7i', teeLie, sw, 0, null, { shot: 'punch' });
  assert.deepEqual(a, b);
  assert.notDeepEqual(a.meta.startDirDeg, ideal.meta.startDirDeg);
  assert.equal(a.meta.shot, 'punch');
  // The putter ignores a shot.
  const putt = swingToLaunch('P', teeLie, { ok: true, kind: 'putt', power: 0.5, startDir: 0 }, 0, null, { puttRange: 9, shot: 'flop' });
  assert.equal(putt.mode, 'roll');
});

// ------------------------------------------------------------------ the caddie follows the shot

test('caddie: club table, one row, power curve, prediction and preview follow opts.shot', () => {
  const pos = { x: 0, y: 0 };
  const stock = clubTable(fairway, pos, teeLie, ZERO, { aimYaw: 0 });
  const st = clubTable(fairway, pos, teeLie, ZERO, { aimYaw: 0, shot: 'stinger' });
  const D0 = stock.find((r) => r.id === 'D');
  const D1 = st.find((r) => r.id === 'D');
  assert.equal(D1.shot, 'stinger');
  assert.ok(D1.apex < 15 && D1.carry < 0.85 * D0.carry, 'the driver row is the stinger');
  // Clubs that cannot stinger keep their normal shot.
  const w0 = stock.find((r) => r.id === 'SW');
  const w1 = st.find((r) => r.id === 'SW');
  assert.equal(w1.shot, 'normal');
  assert.equal(w1.carry, w0.carry);
  // One row, as the table gives it.
  const row = clubRow(fairway, pos, teeLie, ZERO, 'D', { aimYaw: 0, shot: 'stinger' });
  assert.deepEqual(row, D1);
  assert.equal(clubRow(fairway, pos, teeLie, ZERO, 'P'), null);
  // A draw lands left of the aim line (side < 0 is left) in the table and along the power curve.
  const dr = clubRow(fairway, pos, teeLie, ZERO, '7i', { aimYaw: 0, shot: 'draw' });
  assert.ok(dr.side < -5, `draw lands ${dr.side.toFixed(1)} m`);
  assert.ok(clubRow(fairway, pos, teeLie, ZERO, '7i', { aimYaw: 0, shot: 'draw', handed: 'L' }).side > 5);
  const curve = powerCurve(fairway, pos, teeLie, ZERO, '7i', 0, { shot: 'draw' });
  const plain = powerCurve(fairway, pos, teeLie, ZERO, '7i', 0);
  const at = curveAt(curve, 1);
  assert.ok(Math.abs(at.carry - dr.carry) < 1e-6 && at.side < -5 && at.sideTotal < at.side);
  assert.ok(Math.abs(curveAt(plain, 1).side) < 1e-6, 'a straight shot lands on the line');
  assert.ok(curveAt(curve, 0.5).side > at.side && curveAt(curve, 0.5).side < 0, 'less bend at half power');
  // The power curve of a punch is shorter at every power.
  const pc = powerCurve(fairway, pos, teeLie, ZERO, '7i', 0, { shot: 'punch' });
  for (let i = 0; i < pc.length; i++) assert.ok(pc[i].carry < plain[i].carry, `power ${pc[i].power}`);
  // An ineligible shot is played normally.
  assert.deepEqual(powerCurve(fairway, pos, teeLie, ZERO, '7i', 0, { shot: 'stinger' }), plain);
  // Prediction on the real ground, and the recorded preview of the flight.
  const pr = predictShot(fairway, pos, teeLie, ZERO, '7i', 0, 1, { shot: 'draw' });
  assert.ok(pr.final.y > 5, 'the predicted draw finishes left (+y)');
  const pv = shotPreview(fairway, pos, teeLie, ZERO, '7i', 0, { power: 1, shot: 'draw' });
  assert.ok(pv.path.length > 40 && Math.abs(pv.carry - dr.carry) < 1e-6 && pv.landing.y > 5);
  // Release share: running shots count all of it (target notch), the others RELEASE_K.
  assert.equal(releaseK('bump'), 1);
  assert.equal(releaseK('stinger'), 1);
  assert.equal(releaseK('draw'), RELEASE_K);
  assert.equal(releaseK('normal'), RELEASE_K);
});
