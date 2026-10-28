// Game state machine: phases, shot playback events, penalties and relief decisions, save/restore,
// wind and the caddie it relies on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game, HOLED_HOLD, END_HOLD, windFor, pathAt, courseFromParam, saveCourseId, bestMap, mergeBest, recordBest } from '../src/game.js';
import { COURSE } from '../src/course.js';
import { courseById, COURSES, mixedCourse, drawMixedHoles, holeCourse, mixedSummary, isCourseId, courseName, MIXED_ID } from '../src/courses.js';
import { buildHole } from '../src/terrain.js';
import { clubTable, suggestClub, playsLike, puttRange, expectedFinish } from '../src/caddie.js';
import { lieAt } from '../src/lie.js';
import { SURF, BALL_R } from '../src/constants.js';
import { planeTerrain } from '../src/physics.js';

// Terrain builds are the slow part (~100 ms): share them between games.
const cache = new Map();
const build = (def, opts) => {
  const k = `${opts.course ? opts.course.id : 'pines'}:${def.n}:${opts.pinIndex}:${opts.seed}`;
  if (!cache.has(k)) cache.set(k, buildHole(def, opts));
  return cache.get(k);
};
const newGame = (o = {}) => new Game({ seed: 3, settings: { wind: 'off' }, buildHole: build, ...o });
const full = (power = 1, o = {}) => ({ ok: true, kind: 'full', power, startDir: 0, faceToPath: 0, tempo: 'smooth', label: 'Straight', ...o });
const putt = (power, o = {}) => ({ ok: true, kind: 'putt', power, startDir: 0, faceToPath: 0, tempo: 'smooth', label: 'Putt', ...o });

// Plays the current flight back at 60 fps until the phase changes.
function playOut(g) {
  let n = 0;
  while (g.phase === 'flight' && n++ < 60 * 120) g.update(1 / 60);
  assert.notEqual(g.phase, 'flight', 'the shot ends');
}

// Puts the ball `d` m short of the cup (on the line from the green centre side) and holes it.
function holeOut(g, d = 0.5) {
  const t = g.terrain;
  const c = t.cup;
  const gx = t.greenCenter.x - c.x;
  const gy = t.greenCenter.y - c.y;
  const l = Math.hypot(gx, gy) || 1;
  g.debugPlace(c.x + (gx / l) * d, c.y + (gy / l) * d);
  assert.equal(g.club.id, 'P', 'the caddie hands over the putter on the green');
  const r = g.swing(putt((d + 0.3) / g.puttRange));
  assert.ok(r.ok);
  playOut(g);
}

test('phase flow: intro -> address -> flight -> address -> holed -> scorecard -> next hole', () => {
  const g = newGame();
  const phases = [];
  const holes = [];
  g.on('phase', (p, prev) => phases.push(`${prev}>${p}`));
  g.on('hole', (h) => holes.push(h.n));
  assert.equal(g.phase, null);
  g.loadHole(1);
  assert.equal(g.phase, 'intro');
  assert.deepEqual(holes, [2]);
  assert.equal(g.swing(full()).ok, false, 'no swinging during the intro');
  assert.ok(g.skipIntro());
  assert.equal(g.phase, 'address');
  assert.equal(g.lie.label, 'Tee');
  assert.ok(['8i', '9i', '7i', 'PW'].includes(g.club.id), `par-3 tee club ${g.club.id}`);
  assert.equal(g.state.hole.strokes, 0);

  // A cancelled swing is not a stroke.
  assert.deepEqual(g.swing({ ok: false, reason: 'cancel' }), { ok: false, reason: 'cancel' });
  assert.equal(g.state.hole.strokes, 0);
  assert.equal(g.phase, 'address');

  const tee = g.ballPos();
  const r = g.swing(full());
  assert.ok(r.ok);
  assert.equal(g.phase, 'flight');
  assert.equal(g.state.hole.strokes, 1, 'the stroke counts at impact');
  assert.equal(g.shot, r.shot);
  g.update(1.0);
  const mid = g.ballPos();
  assert.ok(Math.hypot(mid.x - tee.x, mid.y - tee.y) > 20, 'ball moves during playback');
  assert.ok(mid.z > tee.z + 5, 'and flies');
  playOut(g);
  assert.ok(['address', 'decision', 'holed'].includes(g.phase));
  if (g.phase === 'decision') g.decide('drop');

  holeOut(g);
  assert.equal(g.phase, 'holed');
  const card = g.state.card.holes[1];
  assert.ok(card.strokes >= 2);
  assert.equal(card.putts, 1);
  assert.equal(g.distanceToCup() < 0.01, true);
  // holed -> scorecard after HOLED_HOLD of update time; then the next hole.
  g.update(HOLED_HOLD * 0.5);
  assert.equal(g.phase, 'holed');
  g.update(HOLED_HOLD * 0.6);
  assert.equal(g.phase, 'scorecard');
  assert.ok(g.nextHole());
  assert.equal(g.phase, 'intro');
  assert.equal(g.state.holeIndex, 2);
  assert.equal(g.state.hole.strokes, 0);
  assert.deepEqual(holes, [2, 3]);
  assert.deepEqual(phases.slice(0, 4), ['null>intro', 'intro>address', 'address>flight', 'flight>' + phases[3].split('>')[1]]);
  assert.ok(phases.includes('holed>scorecard') && phases.includes('scorecard>intro'));
});

test('holed: score name, card and stats; the last hole ends the round', () => {
  const g = newGame();
  const holed = [];
  const over = [];
  g.on('holed', (h) => holed.push(h));
  g.on('roundOver', (r) => over.push(r));
  g.loadHole(8);
  g.skipIntro();
  holeOut(g, 0.4);
  assert.equal(g.phase, 'holed');
  assert.equal(holed.length, 1);
  assert.equal(holed[0].strokes, 1);
  assert.equal(holed[0].name, 'Hole in one!');
  assert.equal(holed[0].par, 4);
  assert.equal(g.state.card.holes[8].strokes, 1);
  assert.equal(g.state.card.holes[8].gir, true);
  assert.equal(g.state.card.holes[8].fir, true, 'holing the first stroke counts as hitting the fairway');
  assert.ok(g.skip(), 'tap skips to the end of the hole');
  assert.equal(g.phase, 'roundOver');
  assert.equal(over.length, 1);
  assert.equal(over[0].totals.played, 1);
  assert.equal(g.nextHole(), false);
});

test('shot events are emitted in time order during playback, then shotEnd', () => {
  const g = newGame();
  g.loadHole(0);
  g.skipIntro();
  const log = [];
  g.on('shotStart', () => log.push(['start']));
  g.on('shotEvent', (e) => log.push(['ev', e.type, e.t]));
  g.on('shotEnd', ({ resolution }) => log.push(['end', resolution.outcome]));
  g.on('phase', (p) => log.push(['phase', p]));
  const r = g.swing(full());
  assert.deepEqual(log[0], ['phase', 'flight']);
  assert.deepEqual(log[1], ['start']);
  assert.equal(log[2][1], 'launch', 'launch is emitted at impact');
  const launch = r.shot.result.events[0];
  assert.equal(launch.kind, 'wood');
  assert.equal(launch.club, 'D');
  // Nothing else until the clock passes each event.
  assert.equal(log.length, 3);
  const land = r.shot.result.events.find((e) => e.type === 'land');
  g.update(land.t - 0.05);
  assert.ok(!log.some((l) => l[1] === 'land'));
  g.update(0.1);
  assert.ok(log.some((l) => l[1] === 'land'));
  playOut(g);
  const evs = log.filter((l) => l[0] === 'ev');
  assert.equal(evs.length, r.shot.result.events.length, 'every event once');
  for (let i = 1; i < evs.length; i++) assert.ok(evs[i][2] >= evs[i - 1][2], 'non-decreasing t');
  const iEnd = log.findIndex((l) => l[0] === 'end');
  assert.ok(iEnd > log.lastIndexOf(evs[evs.length - 1]), 'shotEnd after the last event');
  assert.deepEqual(log[log.length - 1], ['phase', g.phase]);
  // Playback lasted the shot plus the hold.
  assert.ok(r.shot.playT >= r.shot.result.t + END_HOLD - 1e-9);
  // pathAt interpolates the recorded path.
  const p = pathAt(r.shot.result.path, land.t);
  assert.ok(Math.hypot(p.x - land.x, p.y - land.y) < 0.6);
});

test('out of bounds from the tee: stroke and distance, re-tee', () => {
  const g = newGame();
  g.loadHole(0);
  g.skipIntro();
  const msgs = [];
  g.on('message', (m) => msgs.push(m));
  g.setAim(g.aimYaw + (35 * Math.PI) / 180); // well left, over the OB line
  g.swing(full());
  playOut(g);
  assert.equal(g.shot.resolution.outcome, 'ob');
  assert.equal(g.phase, 'address');
  assert.equal(g.state.hole.strokes, 2, 'hitting three');
  assert.equal(g.state.hole.penalties, 1);
  assert.equal(g.state.hole.onTee, true);
  assert.equal(g.lie.label, 'Tee');
  assert.ok(Math.hypot(g.ballPos().x - g.terrain.tee.x, g.ballPos().y - g.terrain.tee.y) < 1e-9);
  assert.equal(g.club.id, 'D', 'driver again off the tee');
  assert.ok(msgs.some((m) => /Out of bounds/.test(m.text) && m.tone === 'over'));
  assert.equal(g.state.hole.fir, false);
});

function intoThePond(g) {
  g.loadHole(1);
  g.skipIntro();
  const w = g.terrain.waters[0];
  const c = { x: w.poly.reduce((a, p) => a + p.x, 0) / w.poly.length, y: w.poly.reduce((a, p) => a + p.y, 0) / w.poly.length };
  const b = g.ballPos();
  g.setAim(Math.atan2(c.y - b.y, c.x - b.x));
  g.setClub('PW');
  g.swing(full(0.85));
  playOut(g);
  assert.equal(g.phase, 'decision');
}

test('water: decision phase, drop or replay, one penalty stroke either way', () => {
  const g = newGame();
  const decisions = [];
  g.on('decision', (d) => decisions.push(d));
  intoThePond(g);
  assert.equal(decisions.length, 1);
  const d = g.state.decision;
  assert.deepEqual(d.options, ['drop', 'replay']);
  assert.equal(g.state.hole.strokes, 2);
  assert.equal(g.swing(full()).ok, false, 'no swing until decided');
  const g2 = newGame();
  intoThePond(g2);
  assert.ok(g2.decide('replay'));
  assert.equal(g2.phase, 'address');
  assert.equal(g2.state.hole.onTee, true);
  assert.equal(g2.lie.label, 'Tee');
  assert.equal(g2.state.hole.strokes, 2);
  const g3 = newGame();
  intoThePond(g3);
  assert.ok(g3.decide('drop'));
  const b = g3.ballPos();
  assert.ok(Math.hypot(b.x - g3.state.hole.ball.x, b.y - g3.state.hole.ball.y) < 1e-12);
  // Lateral relief within two club lengths, or back on the line to level ground when the whole
  // relief area is steep bank.
  const de = Math.hypot(b.x - d.entry.x, b.y - d.entry.y);
  assert.ok(d.relief === 'lateral' ? de <= 2.28 + 1e-9 : de <= 30 + 1e-9, `${d.relief} drop ${de} m from the entry`);
  assert.notEqual(g3.lie.surface, SURF.WATER);
  assert.equal(g3.state.hole.onTee, false);
  assert.equal(g3.decide('drop'), false, 'only once');
});

test('serialize/restore at address mid-hole: identical state and identical future shots', () => {
  const g = newGame({ seed: 11, settings: { wind: 'breezy' } });
  g.loadHole(3);
  g.skipIntro();
  g.swing(full(1, { startDir: 2 }));
  playOut(g);
  assert.equal(g.phase, 'address');
  g.setClub('5i');
  g.setAim(g.aimYaw + 0.05);
  const save = JSON.parse(JSON.stringify(g.serialize()));
  const h = Game.restore(JSON.stringify(save), { buildHole: build });
  assert.equal(h.phase, 'address');
  assert.deepEqual(h.state, g.state);
  assert.equal(h.club.id, '5i');
  assert.equal(h.aimYaw, g.aimYaw);
  assert.deepEqual(h.wind, g.wind);
  // The same swing on both continues the same random stream.
  const a = g.swing(full(0.9, { faceToPath: 1 }));
  const b = h.swing(full(0.9, { faceToPath: 1 }));
  assert.deepEqual(a.shot.launch, b.shot.launch);
  assert.deepEqual(a.shot.result.final, b.shot.result.final);
  assert.equal(a.shot.seed, b.shot.seed);
  playOut(g);
  playOut(h);
  assert.deepEqual(h.serialize(), g.serialize());
});

test('serialize during the flight: restore resolves the shot (the stroke is not undone)', () => {
  const g = newGame({ seed: 12, settings: { wind: 'light' } });
  g.loadHole(0);
  g.skipIntro();
  g.swing(full());
  g.update(1.5);
  assert.equal(g.phase, 'flight');
  const save = g.serialize();
  assert.ok(save.pendingShot);
  assert.equal(save.phase, 'address');
  playOut(g);
  const h = Game.restore(save, { buildHole: build });
  assert.equal(h.phase, g.phase);
  assert.deepEqual(h.state, g.state);
  assert.deepEqual(h.serialize(), g.serialize());
  // Listeners attached after restore hear the current state on the first update.
  const heard = [];
  h.on('hole', (i) => heard.push(['hole', i.n]));
  h.on('phase', (p) => heard.push(['phase', p]));
  h.update(0);
  assert.deepEqual(heard, [['hole', 1], ['phase', g.phase]]);
});

test('serialize/restore in the decision phase, then the same decision and swing', () => {
  const g = newGame({ seed: 21 });
  intoThePond(g);
  const h = Game.restore(JSON.stringify(g.serialize()), { buildHole: build });
  assert.equal(h.phase, 'decision');
  const heard = [];
  h.on('decision', (d) => heard.push(d));
  h.update(0);
  assert.equal(heard.length, 1);
  assert.deepEqual(heard[0], g.state.decision);
  g.decide('drop');
  h.decide('drop');
  assert.deepEqual(h.state, g.state);
  const a = g.swing(full(0.5));
  const b = h.swing(full(0.5));
  assert.deepEqual(a.shot.result.final, b.shot.result.final);
  assert.throws(() => Game.restore({ v: 99 }), /unsupported/);
});

test('wind is seeded per hole by the setting', () => {
  for (let i = 0; i < 9; i++) {
    assert.deepEqual(windFor(5, i, 'off'), { x: 0, y: 0 });
    const l = Math.hypot(windFor(5, i, 'light').x, windFor(5, i, 'light').y);
    const b = Math.hypot(windFor(5, i, 'breezy').x, windFor(5, i, 'breezy').y);
    assert.ok(l >= 0 && l <= 4, `light ${l}`);
    assert.ok(b >= 3 && b <= 8, `breezy ${b}`);
    assert.deepEqual(windFor(5, i, 'breezy'), windFor(5, i, 'breezy'));
  }
  assert.notDeepEqual(windFor(5, 0, 'breezy'), windFor(5, 1, 'breezy'));
  const g = newGame({ settings: { wind: 'breezy' } });
  g.loadHole(4);
  assert.deepEqual(g.wind, windFor(3, 4, 'breezy'));
  g.setSettings({ wind: 'off' });
  assert.deepEqual(g.wind, { x: 0, y: 0 });
});

test('caddie: club table, suggestions, plays-like and putt range', () => {
  const t = build(COURSE.holes[0], { pinIndex: 0, seed: 1 });
  const tee = t.tee;
  const lie = lieAt(t, tee, Math.atan2(t.cup.y - tee.y, t.cup.x - tee.x));
  const table = clubTable(t, tee, lie, { x: 0, y: 0 });
  assert.equal(table.length, 13);
  for (let i = 1; i < table.length; i++) assert.ok(table[i].carry < table[i - 1].carry, `${table[i].id}`);
  assert.ok(table[0].carry > 210 && table[0].carry < 235, `driver ${table[0].carry}`);
  // Headwind shortens the carry, and the caddie knows it.
  const yaw = lie.aimYaw;
  const head = clubTable(t, tee, lie, { x: -5 * Math.cos(yaw), y: -5 * Math.sin(yaw) });
  assert.ok(head[6].carry < table[6].carry - 5);
  assert.ok(Math.abs(head[6].carry0 - table[6].carry) < 1e-9);
  assert.equal(suggestClub(t, tee, lie, { x: 0, y: 0 }, { table, par: 4, teeShot: true }), 'D');
  const onGreen = lieAt(t, t.cup, 0);
  assert.equal(suggestClub(t, t.cup, onGreen, { x: 0, y: 0 }), 'P');
  // Approach: the shortest club whose stock shot finishes (carry + most of the green release) at the
  // plays-like distance, so it neither comes up short nor runs a club past.
  for (const back of [100, 130, 150, 175]) {
    const p = t.path.pointAt(t.lengthM - back);
    const al = lieAt(t, p, Math.atan2(t.cup.y - p.y, t.cup.x - p.x));
    const at = clubTable(t, p, al, { x: 0, y: 0 });
    const id = suggestClub(t, p, al, { x: 0, y: 0 }, { table: at, par: 4, teeShot: false });
    const pl = playsLike(t, p, t.cup, { x: 0, y: 0 }, at);
    const row = at.find((r) => r.id === id);
    const i = at.indexOf(row);
    assert.ok(expectedFinish(row) >= 0.97 * pl && (i === at.length - 1 || expectedFinish(at[i + 1]) < 0.97 * pl), `${id} for ${pl}`);
    assert.ok(expectedFinish(row) < pl + 15, `${id} finishes ${expectedFinish(row) - pl} m past`);
  }
  // From the rough no wood is picked when a hybrid or iron carries further.
  const rp = { x: 0, y: 0 };
  const roughT = planeTerrain({ surface: SURF.ROUGH, cup: { x: 160, y: 0, z: 0 } });
  roughT.par = 4;
  const rl = lieAt(roughT, rp, 0);
  const rt = clubTable(roughT, rp, rl, { x: 0, y: 0 });
  for (let k = 1; k < rt.length; k++) if (rt[k].carry >= rt[k - 1].carry) assert.notEqual(suggestClub(roughT, rp, rl, { x: 0, y: 0 }, { table: rt, teeShot: false }), rt[k - 1].id);
  // Plays-like: uphill plays longer, downhill shorter.
  const flatT = planeTerrain({});
  const at = clubTable(flatT, { x: 0, y: 0 }, lieAt(flatT, { x: 0, y: 0 }, 0), { x: 0, y: 0 });
  const up = playsLike(flatT, { x: 0, y: 0 }, { x: 150, y: 0, z: 10 }, { x: 0, y: 0 }, at);
  const down = playsLike(flatT, { x: 0, y: 0 }, { x: 150, y: 0, z: -10 }, { x: 0, y: 0 }, at);
  assert.ok(up > 155 && down < 145, `${up} ${down}`);
  // Putt range: the first of 3, 6, 9, 12, 18, 24, 30 m at least 1.25x the distance.
  assert.equal(puttRange(2), 3);
  assert.equal(puttRange(2.5), 6);
  assert.equal(puttRange(7), 9);
  assert.equal(puttRange(15), 24);
  assert.equal(puttRange(60), 30);
});

test('debugPlace, ball position and distances', () => {
  const g = newGame();
  g.loadHole(0);
  g.skipIntro();
  const t = g.terrain;
  const p = t.path.pointAt(200);
  g.debugPlace(p.x, p.y);
  assert.equal(g.phase, 'address');
  const b = g.ballPos();
  assert.ok(Math.abs(b.z - t.heightAt(p.x, p.y) - BALL_R) < 1e-9);
  assert.ok(Math.abs(g.distanceToCup() - Math.hypot(t.cup.x - p.x, t.cup.y - p.y)) < 1e-9);
  assert.equal(g.state.hole.strokes, 0);
  assert.ok(g.playsLike() > 100);
  assert.ok(g.clubInfo().carry > 100);
  // Live power readout: grows with power and matches the club table at full power.
  const c1 = g.carryForPower(1);
  assert.ok(Math.abs(c1.carry - g.clubInfo().carry) < 1e-6);
  assert.ok(g.carryForPower(0.5).carry < 0.75 * c1.carry && g.carryForPower(0.5).carry > 0.3 * c1.carry);
  assert.ok(g.carryForPower(1.1).carry > c1.carry);
  g.setClub('P');
  assert.equal(g.carryForPower(0.5).total, 0.5 * g.puttRange);
  assert.equal(g.stepPuttRange(+1), 30);
  assert.equal(g.setPuttRange(10), 9);
});

// ------------------------------------------------------------------ special shots (section 8.4)

test('special shots: eligible list, selection, reset after the stroke and on a club that cannot play it', () => {
  const g = newGame();
  g.loadHole(0);
  g.skipIntro();
  assert.equal(g.shotType, 'normal');
  assert.equal(g.club.id, 'D');
  assert.deepEqual(g.shotsAvailable(), ['normal', 'draw', 'cut', 'stinger']);
  assert.equal(g.setShot('flop'), false, 'a driver cannot flop');
  assert.equal(g.shotType, 'normal');
  const stock = g.clubInfo();
  const stockCurve = g.carryForPower(1);
  assert.ok(g.setShot('stinger'));
  assert.equal(g.shotType, 'stinger');
  // The club picker and the power gauge follow the shot.
  const info = g.clubInfo();
  assert.equal(info.shot, 'stinger');
  assert.ok(info.carry < 0.85 * stock.carry && info.landAngle < stock.landAngle, `${info.carry} vs ${stock.carry}`);
  assert.ok(Math.abs(g.carryForPower(1).carry - info.carry) < 1e-6 && g.carryForPower(1).carry < stockCurve.carry);
  assert.ok(g.shotPreview(1).path.length > 10);
  // The preview is taken to a 2% power step and a quarter-degree aim step and cached: the gauge
  // and the aim drag ask every frame without a simulation each time.
  const pv = g.shotPreview(0.703);
  assert.equal(g.shotPreview(0.708), pv);
  assert.notEqual(g.shotPreview(0.75), pv);
  g.setAim(g.aimYaw + 0.0005);
  assert.equal(g.shotPreview(0.70), pv, 'a hair of aim reuses it');
  assert.equal(g.clubInfo('3W').shot, 'normal', 'other clubs show their normal shot');
  // Changing to a club that can still play it keeps it; one that cannot resets it.
  g.setClub('3W');
  assert.equal(g.shotType, 'stinger');
  g.setClub('9i');
  assert.equal(g.shotType, 'normal');
  // The stroke plays the shot, then it goes back to normal.
  g.setClub('D');
  g.setShot('stinger');
  const r = g.swing(full());
  assert.ok(r.ok);
  assert.equal(r.shot.swing.shot, 'stinger');
  assert.equal(r.shot.launch.meta.shot, 'stinger');
  assert.ok(r.shot.result.apex < 15, `stinger apex ${r.shot.result.apex}`);
  assert.equal(g.shotType, 'normal', 'reset at the strike');
  playOut(g);
  if (g.phase === 'decision') g.decide('drop');
  assert.equal(g.shotType, 'normal');
  assert.equal(g.state.hole.last.shot, 'stinger');
  // The putter has only the normal stroke.
  holeOut(g);
  assert.equal(g.phase, 'holed');
});

test('special shots: a draw curves left of the stock shot in the game; left-handed it goes right', () => {
  const finish = (shot, handed) => {
    const g = newGame({ settings: { wind: 'off', handed } });
    g.loadHole(0);
    g.skipIntro();
    g.setClub('5i');
    if (shot) assert.ok(g.setShot(shot));
    const r = g.swing(full());
    const f = r.shot.result.landing;
    const b = r.shot.from;
    const yaw = g.aimYaw;
    return (f.x - b.x) * Math.sin(yaw) - (f.y - b.y) * Math.cos(yaw); // + = right of the aim
  };
  const n = finish(null, 'R');
  assert.ok(finish('draw', 'R') < n - 8, 'right-handed draw lands left');
  assert.ok(finish('draw', 'L') > finish(null, 'L') + 8, 'left-handed draw lands right');
  assert.ok(finish('cut', 'R') > n + 8);
});

test('special shots: the selected shot is saved; old saves play normal; a mid-flight save restores identically', () => {
  const g = newGame({ seed: 31 });
  g.loadHole(1);
  g.skipIntro();
  g.setClub('7i');
  assert.ok(g.setShot('punch'));
  const save = JSON.parse(JSON.stringify(g.serialize()));
  assert.equal(save.shotType, 'punch');
  const h = Game.restore(save, { buildHole: build });
  assert.equal(h.shotType, 'punch');
  assert.deepEqual(h.state, g.state);
  // A save from before special shots has no shotType.
  delete save.shotType;
  const old = Game.restore(save, { buildHole: build });
  assert.equal(old.shotType, 'normal');
  // Mid-flight: the restore re-plays the punch and resolves it.
  g.swing(full(0.9));
  g.update(0.5);
  const fly = g.serialize();
  assert.equal(fly.pendingShot.swing.shot, 'punch');
  playOut(g);
  const k = Game.restore(fly, { buildHole: build });
  assert.deepEqual(k.state, g.state);
  assert.equal(k.shot.launch.meta.shot, 'punch');
});

// ------------------------------------------------------------------ courses and saves (section 8.5)

test('courses: a round on Red Mesa names the course, saves its id and restores onto it', () => {
  const desert = courseById('desert');
  const g = new Game({ course: desert, seed: 5, settings: { wind: 'off' }, buildHole: build });
  const heard = [];
  g.on('hole', (h) => heard.push(h));
  g.loadHole(2);
  assert.equal(heard[0].courseId, 'desert');
  assert.equal(heard[0].courseName, desert.name);
  assert.equal(heard[0].theme, 'desert');
  assert.equal(g.state.card.course, desert.name);
  g.skipIntro();
  const save = JSON.parse(JSON.stringify(g.serialize()));
  assert.equal(save.courseId, 'desert');
  const h = Game.restore(save, { buildHole: build });
  assert.equal(h.course.id, 'desert');
  assert.equal(h.terrain.courseId, 'desert');
  assert.deepEqual(h.state, g.state);
  // An old save (no course id) is Hollow Pines.
  const p = newGame();
  p.loadHole(0);
  const ps = JSON.parse(JSON.stringify(p.serialize()));
  delete ps.courseId;
  assert.equal(Game.restore(ps, { buildHole: build }).course.id, 'pines');
});

test('mixed rounds: nine random holes, par 36, two or three from every course, seeded per round', () => {
  const seen = new Set();
  for (let seed = 1; seed <= 60; seed++) {
    const picks = drawMixedHoles(seed);
    assert.deepEqual(drawMixedHoles(seed), picks, 'deterministic per seed');
    assert.equal(picks.length, 9);
    const c = mixedCourse(seed);
    assert.equal(c.holes.reduce((a, h) => a + h.par, 0), 36);
    assert.deepEqual(c.holes.map((h) => h.par).sort().join(''), '334444455');
    assert.equal(c.holes[0].par, 4, 'opens with a par 4');
    const per = {};
    for (const p of picks) per[p.courseId] = (per[p.courseId] || 0) + 1;
    for (const k of COURSES) assert.ok(per[k.id] >= 2 && per[k.id] <= 3, `seed ${seed}: ${k.id} gives ${per[k.id]}`);
    assert.equal(new Set(picks.map((p) => `${p.courseId}:${p.hole}`)).size, 9, 'no hole twice');
    for (let i = 1; i < 9; i++) assert.notEqual(picks[i].courseId, picks[i - 1].courseId, `seed ${seed}: no two holes of one course in a row`);
    for (let i = 0; i < 9; i++) assert.equal(holeCourse(c, i).holes[picks[i].hole], c.holes[i]);
    seen.add(picks.map((p) => `${p.courseId}${p.hole}`).join());
  }
  assert.ok(seen.size >= 55, 'rounds differ');
  // A saved draw is replayed as is; a broken one is drawn again from the seed.
  const keep = mixedCourse(99, drawMixedHoles(5));
  assert.deepEqual(keep.picks, drawMixedHoles(5));
  assert.deepEqual(mixedCourse(99, [{ courseId: 'mars', hole: 0 }]).picks, drawMixedHoles(99));
  assert.equal(holeCourse(courseById('desert'), 3).id, 'desert', 'a normal round: its own course');
  assert.ok(isCourseId(MIXED_ID) && isCourseId('links') && !isCourseId('mars'));
  assert.equal(courseName(MIXED_ID), 'Mixed Nine');
  const sum = mixedSummary();
  assert.equal(sum.par, 36);
  assert.equal(sum.lengthM, null);
});

test('mixed rounds: each hole plays its own course (theme, conditions, windy wind); the card and save follow', () => {
  const course = mixedCourse(11);
  const g = new Game({ course, seed: 11, settings: { wind: 'light' }, buildHole: build });
  const heard = [];
  g.on('hole', (h) => heard.push(h));
  assert.equal(g.state.courseId, MIXED_ID);
  assert.deepEqual(g.state.mix, course.picks);
  assert.deepEqual(g.state.card.holes.map((h) => h.n), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(g.state.card.course, 'Mixed Nine');
  for (let i = 0; i < 9; i++) {
    const src = course.holeCourses[i];
    assert.equal(g.state.card.holes[i].from.courseId, src.id);
    assert.equal(g.state.card.holes[i].from.n, course.holes[i].n);
  }
  const linksAt = course.picks.findIndex((p) => p.courseId === 'links');
  const otherAt = course.picks.findIndex((p) => p.courseId !== 'links');
  for (const i of [otherAt, linksAt]) {
    g.loadHole(i);
    const info = heard[heard.length - 1];
    const src = course.holeCourses[i];
    assert.equal(info.n, i + 1, 'the round numbers its own holes');
    assert.equal(info.holeN, course.holes[i].n);
    assert.equal(info.holeCourseId, src.id);
    assert.equal(info.holeCourseName, src.name);
    assert.equal(info.courseName, 'Mixed Nine');
    assert.ok(info.mixed);
    assert.equal(g.terrain.theme, src.theme);
    assert.equal(g.terrain.courseId, src.id);
    assert.deepEqual(g.terrain.conditions, { firm: 1, greenStimpFt: 10.5, wind: 'normal', ...src.conditions });
    assert.deepEqual(g.wind, windFor(11, i, 'light', src.conditions), 'the hole\'s own course sets the wind (Kittiwake is windy)');
  }
  // Save and restore: the same nine holes, on the same hole and course.
  g.skipIntro();
  const save = JSON.parse(JSON.stringify(g.serialize()));
  assert.equal(save.courseId, MIXED_ID);
  assert.equal(saveCourseId({ v: 1, courseId: MIXED_ID, game: save }), MIXED_ID);
  const h = Game.restore(save, { buildHole: build });
  assert.ok(h.course.mixed);
  assert.deepEqual(h.course.picks, course.picks);
  assert.equal(h.terrain.courseId, 'links');
  assert.deepEqual(h.state, g.state);
  // The round runs to the end on the mixed nine.
  h.update(0);
  h.state.holeIndex = 8;
  h.loadHole(8);
  h.skipIntro();
  holeOut(h);
  let n = 0;
  while (h.phase === 'holed' && n++ < 400) h.update(1 / 60);
  assert.equal(h.phase, 'roundOver');
});

test('saves and best rounds: ?course=, the save wrapper, the per-course best map', () => {
  assert.equal(courseFromParam('mixed'), 'mixed');
  assert.deepEqual(bestMap({ mixed: { strokes: 39, toPar: 3, date: 4 } }), { mixed: { strokes: 39, toPar: 3, date: 4 } });
  assert.equal(courseFromParam('desert'), 'desert');
  assert.equal(courseFromParam(' Links '), 'links');
  assert.equal(courseFromParam('pines'), 'pines');
  assert.equal(courseFromParam('mars'), null);
  assert.equal(courseFromParam(null), null);
  assert.equal(courseFromParam(''), null);
  // The save wrapper: its own id, else the game's; old saves have neither (Hollow Pines).
  assert.equal(saveCourseId({ v: 1, courseId: 'water', game: {} }), 'water');
  assert.equal(saveCourseId({ v: 1, game: { courseId: 'links' } }), 'links');
  assert.equal(saveCourseId({ v: 1, savedAt: 5, game: { v: 1 } }), 'pines');
  assert.equal(saveCourseId(null), 'pines');
  assert.equal(saveCourseId({ courseId: 'nowhere' }), 'pines');
  // Best rounds: the old single record is Hollow Pines' best.
  const old = { strokes: 38, toPar: 2, date: 100 };
  assert.deepEqual(bestMap(old), { pines: old });
  assert.deepEqual(bestMap(null), {});
  assert.deepEqual(bestMap('junk'), {});
  assert.deepEqual(bestMap({ desert: { strokes: 40, toPar: 4, date: 3 }, mars: { strokes: 1 }, links: { nope: 1 } }), { desert: { strokes: 40, toPar: 4, date: 3 } });
  // Stored vs in-memory copies merge per course, the newer record winning.
  const m = mergeBest({ pines: { strokes: 39, toPar: 3, date: 50 }, water: { strokes: 41, toPar: 5, date: 90 } }, { pines: { strokes: 37, toPar: 1, date: 60 }, links: { strokes: 44, toPar: 8, date: 10 } });
  assert.deepEqual(Object.keys(m).sort(), ['links', 'pines', 'water']);
  assert.equal(m.pines.strokes, 37);
  assert.equal(m.water.strokes, 41);
  assert.equal(mergeBest(old, null).pines.strokes, 38);
  // Recording: only a complete nine counts; a lower score on that course is a new best.
  const nine = (strokes) => ({ played: 9, strokes, toPar: strokes - 36 });
  let r = recordBest(old, 'desert', nine(41), 9, 200);
  assert.ok(r.isNew);
  assert.deepEqual(r.best, { strokes: 41, toPar: 5, date: 200 });
  assert.equal(r.map.pines.strokes, 38, 'other courses keep their best');
  r = recordBest(r.map, 'pines', nine(39), 9, 300);
  assert.ok(!r.isNew);
  assert.equal(r.best.strokes, 38);
  r = recordBest(r.map, 'pines', nine(36), 9, 400);
  assert.ok(r.isNew && r.map.pines.strokes === 36 && r.map.desert.strokes === 41);
  r = recordBest(r.map, 'links', { played: 5, strokes: 20, toPar: 0 }, 9, 500);
  assert.ok(!r.isNew && r.best === null && !r.map.links, 'an unfinished round does not count');
});

