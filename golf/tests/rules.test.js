// Rules (penalties, relief, pick-up, names, statistics) and the scorecard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveShot, waterRelief, scoreName, maxStrokes, isDropOk, RELIEF_R } from '../src/rules.js';
import { newCard, recordHole, totals } from '../src/scoring.js';
import { COURSE, coursePar } from '../src/course.js';
import { buildHole } from '../src/terrain.js';
import { SURF, BALL_R, CLUB_LENGTH } from '../src/constants.js';

const hole1 = buildHole(COURSE.holes[0], { pinIndex: 0, seed: 1 });
const hole2 = buildHole(COURSE.holes[1], { pinIndex: 0, seed: 1 });
const hole8 = buildHole(COURSE.holes[7], { pinIndex: 0, seed: 1 });

const centroid = (poly) => ({ x: poly.reduce((a, p) => a + p.x, 0) / poly.length, y: poly.reduce((a, p) => a + p.y, 0) / poly.length });
const d2 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// The point where the segment dry -> wet crosses into the water (bisection on surfaceAt).
function edge(t, dry, wet) {
  let a = dry;
  let b = wet;
  for (let i = 0; i < 40; i++) {
    const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    if (t.surfaceAt(m.x, m.y) === SURF.WATER) b = m;
    else a = m;
  }
  return b;
}

const shotAt = (outcome, p, surface, extra = {}) => ({ final: { x: p.x, y: p.y, z: p.z ?? 0, surface, outcome }, ...extra });
const ctxFor = (t, o = {}) => ({ terrain: t, par: t.par, strokes: 0, prevSpot: { ...t.tee, z: t.tee.z + BALL_R }, fromTee: true, fromSurface: SURF.TEE, ...o });

test('scoreName and maxStrokes', () => {
  assert.equal(scoreName(1, 3), 'Hole in one!');
  assert.equal(scoreName(1, 4), 'Hole in one!');
  assert.equal(scoreName(2, 5), 'Albatross');
  assert.equal(scoreName(3, 5), 'Eagle');
  assert.equal(scoreName(3, 4), 'Birdie');
  assert.equal(scoreName(4, 4), 'Par');
  assert.equal(scoreName(5, 4), 'Bogey');
  assert.equal(scoreName(6, 4), 'Double Bogey');
  assert.equal(scoreName(7, 4), 'Triple Bogey');
  assert.equal(scoreName(8, 4), '+4');
  assert.equal(maxStrokes(3), 6);
  assert.equal(maxStrokes(5), 10);
});

test('OB: stroke and distance, replay from the previous spot (re-tee from the tee)', () => {
  const tee = { ...hole1.tee, z: hole1.tee.z + BALL_R };
  const r = resolveShot(ctxFor(hole1), shotAt('ob', { x: -60, y: 200 }, SURF.OOB));
  assert.equal(r.outcome, 'ob');
  assert.equal(r.penalty, 1);
  assert.equal(r.strokes, 2, 'tee shot + penalty: hitting 3 next');
  assert.deepEqual(r.ball, tee);
  assert.equal(r.reTee, true);
  assert.equal(r.fir, false);
  assert.equal(r.decision, null);
  assert.ok(/Out of bounds/.test(r.message));
  // From the fairway: back to that spot, not the tee.
  const prev = { x: 5, y: 250, z: 1 };
  const r2 = resolveShot(ctxFor(hole1, { strokes: 2, prevSpot: prev, fromTee: false, fromSurface: SURF.FAIRWAY }), shotAt('ob', { x: -60, y: 300 }, SURF.OOB));
  assert.equal(r2.strokes, 4);
  assert.deepEqual(r2.ball, prev);
  assert.equal(r2.reTee, false);
  assert.equal(r2.fir, undefined, 'FIR is only judged on the tee shot');
});

test('red water: drop within two club lengths of the entry, dry, not nearer the hole', () => {
  assert.ok(Math.abs(RELIEF_R - 2 * CLUB_LENGTH) < 1e-12);
  const pond = hole2.waters[0];
  assert.equal(pond.kind, 'red');
  const c = centroid(pond.poly);
  assert.equal(hole2.surfaceAt(c.x, c.y), SURF.WATER);
  for (const from of [hole2.tee, { x: c.x - 30, y: c.y }, { x: c.x, y: c.y - 40 }]) {
    const entry = edge(hole2, from, c);
    const drop = waterRelief(hole2, entry, 'red');
    assert.ok(drop, 'relief found');
    assert.ok(d2(drop, entry) <= RELIEF_R + 1e-9, `${d2(drop, entry)} m from the entry`);
    assert.ok(isDropOk(hole2, drop.x, drop.y));
    assert.notEqual(hole2.surfaceAt(drop.x, drop.y), SURF.WATER);
    assert.ok(d2(drop, hole2.cup) >= d2(entry, hole2.cup) - 1e-9, 'not nearer the hole');
    assert.ok(Math.abs(drop.z - hole2.heightAt(drop.x, drop.y) - BALL_R) < 1e-9);
  }
  // Through resolveShot: +1, a decision with both options, the drop as the default ball.
  const entry = edge(hole2, hole2.tee, c);
  const prev = { ...hole2.tee, z: hole2.tee.z + BALL_R };
  const r = resolveShot(ctxFor(hole2), shotAt('water', c, SURF.WATER, { waterEntry: entry }));
  assert.equal(r.outcome, 'water');
  assert.equal(r.penalty, 1);
  assert.equal(r.strokes, 2);
  assert.deepEqual(r.decision.options, ['drop', 'replay']);
  assert.equal(r.decision.waterKind, 'red');
  assert.deepEqual(r.decision.replay, prev);
  assert.equal(r.decision.replayTee, true);
  assert.deepEqual(r.ball, r.decision.drop);
  assert.ok(d2(r.ball, entry) <= RELIEF_R + 1e-9);
});

test('yellow water: back on the line from the hole through the entry, 2 m or more behind it', () => {
  const water = hole8.waters[0];
  assert.equal(water.kind, 'yellow');
  const c = centroid(water.poly);
  assert.equal(hole8.surfaceAt(c.x, c.y), SURF.WATER);
  const s = hole8.path.project(c.x, c.y).s;
  const fair = hole8.path.pointAt(s);
  for (const from of [fair, hole8.path.pointAt(s - 60), hole8.tee]) {
    const entry = edge(hole8, from, c);
    const drop = waterRelief(hole8, entry, 'yellow');
    assert.ok(drop);
    const ux = entry.x - hole8.cup.x;
    const uy = entry.y - hole8.cup.y;
    const l = Math.hypot(ux, uy);
    const vx = drop.x - entry.x;
    const vy = drop.y - entry.y;
    const along = (vx * ux + vy * uy) / l;
    const across = (vx * uy - vy * ux) / l;
    assert.ok(Math.abs(across) < 1e-6, `on the line (${across})`);
    assert.ok(along >= 2 - 1e-9, `behind the entry by ${along} m`);
    assert.ok(isDropOk(hole8, drop.x, drop.y));
    assert.ok(d2(drop, hole8.cup) > d2(entry, hole8.cup));
  }
  const entry = edge(hole8, fair, c);
  const r = resolveShot(ctxFor(hole8, { strokes: 1, fromTee: false, fromSurface: SURF.FAIRWAY, prevSpot: { ...fair, z: 0 } }), shotAt('water', c, SURF.WATER, { waterEntry: entry }));
  assert.equal(r.decision.waterKind, 'yellow');
  assert.equal(r.strokes, 3);
  assert.equal(r.decision.replayTee, false);
});

test('pick up at double par, whatever happens on the last stroke', () => {
  const ctx = ctxFor(hole1, { strokes: 7, fromTee: false, fromSurface: SURF.ROUGH, prevSpot: { x: 0, y: 300, z: 0 } });
  const rest = resolveShot(ctx, shotAt('rest', { x: 40, y: 330 }, SURF.GREEN));
  assert.equal(rest.pickUp, true);
  assert.equal(rest.strokes, 8);
  assert.ok(/Picked up/.test(rest.message));
  const ob = resolveShot({ ...ctx, strokes: 6 }, shotAt('ob', { x: -90, y: 330 }, SURF.OOB));
  assert.equal(ob.pickUp, true);
  assert.equal(ob.strokes, 8);
  const wet = resolveShot({ ...ctx, strokes: 7 }, shotAt('water', { x: -90, y: 330 }, SURF.WATER));
  assert.equal(wet.pickUp, true);
  assert.equal(wet.strokes, 8);
  assert.equal(wet.decision, null, 'no relief once picked up');
  const holed = resolveShot(ctx, shotAt('holed', hole1.cup, SURF.GREEN));
  assert.equal(holed.holed, true);
  assert.equal(holed.pickUp, false);
  assert.equal(holed.strokes, 8);
  assert.equal(resolveShot({ ...ctx, strokes: 5 }, shotAt('rest', { x: 40, y: 330 }, SURF.GREEN)).pickUp, false);
});

test('statistics: fairway hit, green in regulation, putts', () => {
  const p4 = ctxFor(hole1);
  assert.equal(resolveShot(p4, shotAt('rest', { x: 0, y: 240 }, SURF.FAIRWAY)).fir, true);
  assert.equal(resolveShot(p4, shotAt('rest', { x: 0, y: 240 }, SURF.ROUGH)).fir, false);
  assert.equal(resolveShot(ctxFor(hole2), shotAt('rest', hole2.cup, SURF.FAIRWAY)).fir, undefined, 'no FIR on a par 3');
  // GIR: on the green in par - 2 strokes or fewer.
  const second = { ...p4, strokes: 1, fromTee: false, fromSurface: SURF.FAIRWAY };
  assert.equal(resolveShot(second, shotAt('rest', hole1.cup, SURF.GREEN)).gir, true);
  assert.equal(resolveShot({ ...second, strokes: 2 }, shotAt('rest', hole1.cup, SURF.GREEN)).gir, undefined);
  assert.equal(resolveShot(second, shotAt('rest', hole1.cup, SURF.FRINGE)).gir, undefined);
  const ace = resolveShot(ctxFor(hole2), shotAt('holed', hole2.cup, SURF.GREEN));
  assert.ok(ace.holed && ace.gir && ace.strokes === 1);
  // Putts are strokes played from the green.
  assert.equal(resolveShot({ ...second, strokes: 2, fromSurface: SURF.GREEN }, shotAt('holed', hole1.cup, SURF.GREEN)).putt, true);
  assert.equal(resolveShot({ ...second, fromSurface: SURF.FRINGE }, shotAt('holed', hole1.cup, SURF.GREEN)).putt, false);
});

test('scorecard: new card, recording holes, totals', () => {
  const card = newCard(COURSE);
  assert.equal(card.holes.length, 9);
  assert.equal(card.holes.reduce((a, h) => a + h.par, 0), coursePar());
  for (const h of card.holes) assert.ok(h.lengthM > 100 && h.strokes === null);
  let t = totals(card);
  assert.equal(t.played, 0);
  assert.equal(t.coursePar, 36);
  recordHole(card, 0, { strokes: 5, putts: 2, penalties: 1, fir: false, gir: false });
  recordHole(card, 1, { strokes: 2, putts: 1, fir: true, gir: true });
  recordHole(card, 2, { strokes: 10, putts: 3, penalties: 2, fir: true, gir: false, pickUp: true });
  t = totals(card);
  assert.equal(t.played, 3);
  assert.equal(t.strokes, 17);
  assert.equal(t.par, 12);
  assert.equal(t.toPar, 5);
  assert.equal(t.putts, 6);
  assert.equal(t.penalties, 3);
  assert.equal(t.pickUps, 1);
  assert.deepEqual(t.fir, { hit: 1, of: 2 }, 'par 3s have no fairway');
  assert.equal(card.holes[1].fir, null);
  assert.deepEqual(t.gir, { hit: 1, of: 3 });
  assert.equal(JSON.stringify(JSON.parse(JSON.stringify(card))), JSON.stringify(card), 'plain JSON');
});
