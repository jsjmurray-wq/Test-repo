// Game state machine: phases, shot playback events, penalties and relief decisions, save/restore,
// wind and the caddie it relies on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game, HOLED_HOLD, END_HOLD, windFor, pathAt } from '../src/game.js';
import { COURSE } from '../src/course.js';
import { buildHole } from '../src/terrain.js';
import { clubTable, suggestClub, playsLike, puttRange, expectedFinish } from '../src/caddie.js';
import { lieAt } from '../src/lie.js';
import { SURF, BALL_R } from '../src/constants.js';
import { planeTerrain } from '../src/physics.js';

// Terrain builds are the slow part (~100 ms): share them between games.
const cache = new Map();
const build = (def, opts) => {
  const k = `${def.n}:${opts.pinIndex}:${opts.seed}`;
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
