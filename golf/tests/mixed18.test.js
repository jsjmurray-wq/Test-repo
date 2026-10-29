// Mixed rounds of 9 or 18 holes (docs/architecture.md section 8.8): the 18-hole draw, the course
// object, an 18-hole round's flow, saves on the back nine, Out/In totals and the best records.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game, courseFromParam, saveCourseId, bestMap, recordBest } from '../src/game.js';
import {
  COURSES, drawMixedHoles, mixedCourse, mixedSummary, courseName, isCourseId, isMixedId, mixedId, mixedHoles,
  MIXED_ID, MIXED18_ID, MIXED_SIZES,
} from '../src/courses.js';
import { buildHole } from '../src/terrain.js';
import { newCard, recordHole, totals } from '../src/scoring.js';

const cache = new Map();
const build = (def, opts) => {
  const k = `${opts.course ? opts.course.id : 'pines'}:${def.n}:${opts.pinIndex}:${opts.seed}`;
  if (!cache.has(k)) cache.set(k, buildHole(def, opts));
  return cache.get(k);
};
const putt = (power) => ({ ok: true, kind: 'putt', power, startDir: 0, faceToPath: 0, tempo: 'smooth', label: 'Putt' });
const parOf = (p) => COURSES.find((c) => c.id === p.courseId).holes[p.hole].par;
const key = (p) => `${p.courseId}:${p.hole}`;

function playOut(g) {
  let n = 0;
  while (g.phase === 'flight' && n++ < 60 * 120) g.update(1 / 60);
  assert.notEqual(g.phase, 'flight');
}

function holeOut(g, d = 0.5) {
  const t = g.terrain;
  const c = t.cup;
  const gx = t.greenCenter.x - c.x;
  const gy = t.greenCenter.y - c.y;
  const l = Math.hypot(gx, gy) || 1;
  g.debugPlace(c.x + (gx / l) * d, c.y + (gy / l) * d);
  assert.ok(g.swing(putt((d + 0.3) / g.puttRange)).ok);
  playOut(g);
  let n = 0;
  while (g.phase === 'holed' && n++ < 400) g.update(1 / 60);
}

test('mixed 18 draw: balanced, par 72, no repeats, no course twice in a row, over many seeds', () => {
  const seen = new Set();
  const N = 2000;
  for (let seed = 0; seed < N; seed++) {
    const p = drawMixedHoles(seed, 18);
    assert.deepEqual(drawMixedHoles(seed, 18), p, 'deterministic per seed');
    assert.equal(p.length, 18);
    assert.equal(new Set(p.map(key)).size, 18, 'no hole twice');
    const per = {};
    const pars = { 3: 0, 4: 0, 5: 0 };
    for (const h of p) {
      per[h.courseId] = (per[h.courseId] || 0) + 1;
      pars[parOf(h)]++;
    }
    assert.equal(Object.keys(per).length, 4);
    assert.ok(Object.values(per).every((n) => n >= 4 && n <= 5), `4-5 holes per course (${JSON.stringify(per)})`);
    assert.equal(Object.values(per).filter((n) => n === 5).length, 2);
    assert.deepEqual(pars, { 3: 4, 4: 10, 5: 4 });
    const out = p.slice(0, 9).reduce((a, h) => a + parOf(h), 0);
    const inn = p.slice(9).reduce((a, h) => a + parOf(h), 0);
    assert.equal(out, 36);
    assert.equal(inn, 36);
    assert.equal(parOf(p[0]), 4, 'the 1st is a par 4');
    assert.equal(parOf(p[9]), 4, 'the 10th is a par 4');
    for (let i = 1; i < 18; i++) {
      assert.notEqual(p[i].courseId, p[i - 1].courseId, `seed ${seed}: holes ${i} and ${i + 1} from one course`);
      const a = parOf(p[i - 1]);
      assert.ok(!(a !== 4 && parOf(p[i]) === a), `seed ${seed}: back-to-back par ${a}s`);
    }
    seen.add(p.map(key).join());
  }
  assert.ok(seen.size >= N - 10, `rounds differ (${seen.size} distinct)`);
});

test('mixed 9 draw is unchanged: default n, the golden seed', () => {
  for (let s = 0; s < 50; s++) assert.deepEqual(drawMixedHoles(s), drawMixedHoles(s, 9));
  assert.equal(drawMixedHoles(7).map((h) => `${h.courseId}${h.hole}`).join(), 'links8,water5,links2,desert7,pines4,water4,links0,desert4,pines2');
});

test('mixed course objects and helpers for 9 and 18', () => {
  const c = mixedCourse(5, null, 18);
  assert.equal(c.id, MIXED18_ID);
  assert.equal(c.name, 'Mixed Eighteen');
  assert.ok(c.mixed);
  assert.equal(c.holes.length, 18);
  assert.equal(c.holeCourses.length, 18);
  assert.deepEqual(c.picks, drawMixedHoles(5, 18));
  c.picks.forEach((p, i) => assert.equal(c.holes[i], COURSES.find((k) => k.id === p.courseId).holes[p.hole]));
  // A saved 18-hole draw replays (its length says 18); a broken one is redrawn with 18 holes.
  const replay = mixedCourse(99, drawMixedHoles(5, 18));
  assert.equal(replay.id, MIXED18_ID);
  assert.deepEqual(replay.picks, drawMixedHoles(5, 18));
  assert.deepEqual(mixedCourse(99, [{ courseId: 'mars', hole: 0 }], 18).picks, drawMixedHoles(99, 18));
  // An explicit size wins over a saved draw of the other size.
  assert.equal(mixedCourse(99, drawMixedHoles(5, 18), 9).holes.length, 9);
  assert.equal(mixedCourse(3).id, MIXED_ID);
  assert.equal(mixedCourse(3).holes.length, 9);
  const s18 = mixedSummary(18);
  assert.equal(s18.id, MIXED18_ID);
  assert.equal(s18.par, 72);
  assert.equal(s18.holes, 18);
  assert.equal(s18.lengthM, null);
  assert.equal(mixedSummary().par, 36);
  assert.equal(mixedSummary(9).id, MIXED_ID);
  assert.deepEqual(MIXED_SIZES, [9, 18]);
  assert.ok(isMixedId('mixed') && isMixedId('mixed18') && !isMixedId('pines'));
  assert.equal(mixedId(18), 'mixed18');
  assert.equal(mixedId('18'), 'mixed18');
  assert.equal(mixedId(9), 'mixed');
  assert.equal(mixedHoles('mixed18'), 18);
  assert.equal(mixedHoles('mixed'), 9);
  assert.equal(mixedHoles('links'), 0);
  assert.ok(isCourseId('mixed18'));
  assert.equal(courseName('mixed18'), 'Mixed Eighteen');
  assert.equal(courseName('mixed'), 'Mixed Nine');
});

test('mixed 18 round: card 1-18, the scorecard after the 9th, hole 10 from its own course, round over after the 18th', () => {
  const course = mixedCourse(21, null, 18);
  const g = new Game({ course, seed: 21, settings: { wind: 'off' }, buildHole: build });
  assert.equal(g.state.courseId, MIXED18_ID);
  assert.deepEqual(g.state.card.holes.map((h) => h.n), Array.from({ length: 18 }, (_, i) => i + 1));
  assert.equal(g.state.card.course, 'Mixed Eighteen');
  assert.equal(g.state.pins.length, 18);
  g.state.card.holes.forEach((h, i) => assert.equal(h.from.courseId, course.picks[i].courseId));
  // Holes 1-8 recorded at par +1 on the 2nd; hole 9 holed for real.
  g.debugSkipTo(8, (k, par) => par + (k === 1 ? 1 : 0));
  assert.equal(g.state.holeIndex, 8);
  assert.equal(g.phase, 'intro');
  assert.equal(g.state.card.holes[1].strokes, course.holes[1].par + 1);
  g.skipIntro();
  holeOut(g);
  assert.equal(g.phase, 'scorecard', 'the 9th is not the end of an 18-hole round');
  const t9 = g.totals();
  assert.equal(t9.played, 9);
  assert.equal(t9.out.played, 9);
  assert.equal(t9.in.played, 0);
  assert.equal(t9.out.strokes, t9.strokes);
  assert.ok(g.nextHole());
  const info = g.holeInfo();
  assert.equal(info.n, 10);
  assert.equal(info.holeCourseId, course.picks[9].courseId);
  assert.equal(g.terrain.courseId, course.picks[9].courseId);
  // On to the 18th: the round ends there.
  g.debugSkipTo(17);
  g.skipIntro();
  holeOut(g);
  assert.equal(g.phase, 'roundOver');
  const t = g.totals();
  assert.equal(t.played, 18);
  assert.equal(t.coursePar, 72);
  assert.equal(t.out.strokes + t.in.strokes, t.strokes);
});

test('mixed 18 save on hole 14: restore at address and mid-flight; old Mixed Nine saves still restore', () => {
  const course = mixedCourse(33, null, 18);
  const g = new Game({ course, seed: 33, settings: { wind: 'light' }, buildHole: build });
  g.debugSkipTo(13, (k, par) => par + (k % 3) - 1);
  g.skipIntro();
  const save = JSON.parse(JSON.stringify(g.serialize()));
  assert.equal(save.courseId, MIXED18_ID);
  assert.equal(save.mix.length, 18);
  assert.equal(saveCourseId({ v: 1, courseId: MIXED18_ID, game: save }), MIXED18_ID);
  const h = Game.restore(save, { buildHole: build });
  assert.equal(h.course.id, MIXED18_ID);
  assert.deepEqual(h.course.picks, course.picks);
  assert.deepEqual(h.state, g.state);
  assert.equal(h.terrain.courseId, g.courseOf(13).id);
  assert.deepEqual(h.state.card.holes.slice(0, 13).map((x) => x.strokes), g.state.card.holes.slice(0, 13).map((x) => x.strokes));
  // Mid-flight: the pending shot is re-simulated and resolved, as on a nine.
  g.setClub('7i');
  assert.ok(g.swing({ ok: true, kind: 'full', power: 0.8, startDir: 0, faceToPath: 0, tempo: 'smooth', label: 'Straight' }).ok);
  g.update(0.3);
  const fly = JSON.parse(JSON.stringify(g.serialize()));
  playOut(g);
  const k = Game.restore(fly, { buildHole: build });
  assert.equal(k.course.id, MIXED18_ID);
  assert.deepEqual(k.state.hole.ball, g.state.hole.ball);
  assert.equal(k.state.hole.strokes, g.state.hole.strokes);
  // A save from before Mixed Eighteen: courseId 'mixed' with nine picks.
  const nine = mixedCourse(8);
  const n = new Game({ course: nine, seed: 8, settings: { wind: 'off' }, buildHole: build });
  n.loadHole(4);
  n.skipIntro();
  const old = JSON.parse(JSON.stringify(n.serialize()));
  const r = Game.restore(old, { buildHole: build });
  assert.equal(r.course.id, MIXED_ID);
  assert.equal(r.course.holes.length, 9);
  assert.deepEqual(r.course.picks, nine.picks);
  // A hole index outside the course is an unusable save.
  assert.throws(() => Game.restore({ ...old, holeIndex: 12 }, { buildHole: build }));
});

test('scoring: Out / In totals on an 18-hole card; a nine has Out only', () => {
  const card = newCard(mixedCourse(4, null, 18));
  for (let i = 0; i < 12; i++) recordHole(card, i, { strokes: card.holes[i].par + (i < 9 ? 1 : -1), putts: 2 });
  const t = totals(card);
  assert.equal(t.out.played, 9);
  assert.equal(t.out.par, 36);
  assert.equal(t.out.coursePar, 36);
  assert.equal(t.out.toPar, 9);
  assert.equal(t.out.putts, 18);
  assert.equal(t.in.played, 3);
  assert.equal(t.in.toPar, -3);
  assert.equal(t.in.coursePar, 36);
  assert.equal(t.out.strokes + t.in.strokes, t.strokes);
  assert.equal(t.toPar, 6);
  const nine = newCard(mixedCourse(4));
  recordHole(nine, 0, { strokes: 5, putts: 2 });
  const tn = totals(nine);
  assert.equal(tn.in, null);
  assert.equal(tn.out.strokes, tn.strokes);
  assert.equal(tn.out.coursePar, tn.coursePar);
});

test('best rounds: Mixed Nine keeps the old mixed record; Mixed 18 is separate and compared to par; ?holes=', () => {
  const nineBest = { strokes: 39, toPar: 3, date: 4 };
  const m = bestMap({ mixed: nineBest });
  assert.deepEqual(m, { mixed: nineBest }, 'the stored mixed best is Mixed Nine\'s');
  assert.equal(m.mixed18, undefined);
  let r = recordBest(m, MIXED18_ID, { played: 17, strokes: 70, toPar: -1 }, 18, 10);
  assert.ok(!r.isNew && r.best === null, 'only a complete 18 counts');
  r = recordBest(m, MIXED18_ID, { played: 18, strokes: 78, toPar: 6 }, 18, 20);
  assert.ok(r.isNew);
  assert.deepEqual(r.map.mixed, nineBest, 'Mixed Nine keeps its best');
  assert.deepEqual(r.map.mixed18, { strokes: 78, toPar: 6, date: 20 });
  // Compared to par: fewer strokes but a worse score to par is not a best.
  r = recordBest(r.map, MIXED18_ID, { played: 18, strokes: 77, toPar: 7 }, 18, 30);
  assert.ok(!r.isNew);
  r = recordBest(r.map, MIXED18_ID, { played: 18, strokes: 79, toPar: 5 }, 18, 40);
  assert.ok(r.isNew && r.map.mixed18.toPar === 5);
  r = recordBest(r.map, MIXED_ID, { played: 9, strokes: 40, toPar: 2 }, 9, 50);
  assert.ok(r.isNew && r.map.mixed.toPar === 2, 'Mixed Nine compares to par too');
  assert.deepEqual(Object.keys(bestMap(r.map)).sort(), ['mixed', 'mixed18']);
  assert.equal(courseFromParam('mixed', '18'), 'mixed18');
  assert.equal(courseFromParam('mixed', 18), 'mixed18');
  assert.equal(courseFromParam('mixed', '9'), 'mixed');
  assert.equal(courseFromParam('mixed', 9), 'mixed');
  assert.equal(courseFromParam('mixed'), 'mixed');
  assert.equal(courseFromParam('mixed18'), 'mixed18');
  assert.equal(courseFromParam('mixed18', '9'), 'mixed');
  assert.equal(courseFromParam('mixed9'), 'mixed');
  assert.equal(courseFromParam('desert', '18'), 'desert');
  assert.equal(courseFromParam('mixed', '27'), 'mixed');
});
