// Version 2 course platform (docs/architecture.md section 8.2): new surfaces, course conditions,
// themed objects, island and sea water, pot bunkers, the course registry, the Game plumbing and
// the theme data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SURF, SURF_NAMES, SURFACES, BALL_R, CUP_R, DEFAULT_CONDITIONS, STIMP_REF_FT, WINDY_EXTRA, mToFt,
} from '../src/constants.js';
import { simulateShot, planeTerrain, surfaceParams, surfaceTable, stimpDistance, puttSpeedForDistance, treeHit } from '../src/physics.js';
import { stockLaunch, clubById } from '../src/clubs.js';
import { buildHole } from '../src/terrain.js';
import { COURSE } from '../src/course.js';
import { COURSES, courseById, DEFAULT_COURSE_ID, courseSummary, PINES } from '../src/courses.js';
import { DESERT } from '../src/course-desert.js';
import { WATER } from '../src/course-water.js';
import { LINKS } from '../src/course-links.js';
import { THEMES, themeFor } from '../src/themes.js';
import { SUN_DIR } from '../src/bake.js';
import { lieAt } from '../src/lie.js';
import { resolveShot, isDropOk } from '../src/rules.js';
import { Game, windFor, WIND_RANGES } from '../src/game.js';
import { mulberry32 } from '../src/rng.js';

const flat = (surface, conditions = null, extra = {}) => planeTerrain({ surface, conditions, ...extra });
const shot = (terrain, id, lopt = {}, sopt = {}) => simulateShot(terrain, stockLaunch(clubById(id), lopt), { record: false, ...sopt });
const roll = (r) => r.total - r.carry;
// A ball set rolling along +x at v m/s from (x, 0).
const rolled = (v, x = 0, z = 0) => ({ pos: { x, y: 0, z: z + BALL_R }, vel: { x: v, y: 0, z: 0 }, spin: { x: 0, y: 0, z: 0 }, mode: 'roll' });
const finite = (r) => [r.final.x, r.final.y, r.final.z, r.total, r.t].every(Number.isFinite);

// Terrain builds are the slow part: share them.
const built = new Map();
function hole(course, i, pinIndex = 0) {
  const k = `${course.id}:${i}:${pinIndex}`;
  if (!built.has(k)) built.set(k, buildHole(course.holes[i], { pinIndex, seed: 1, course }));
  return built.get(k);
}

// ------------------------------------------------------------------ surfaces

test('new surfaces: ids, names, lie factors from the contract table, lie labels', () => {
  assert.equal(SURF.WASTE, 9);
  assert.equal(SURF.DESERT, 10);
  assert.equal(SURF.FESCUE, 11);
  assert.equal(SURF_NAMES[SURF.WASTE], 'Waste area');
  assert.equal(SURF_NAMES[SURF.DESERT], 'Desert');
  assert.equal(SURF_NAMES[SURF.FESCUE], 'Fescue');
  const want = { [SURF.WASTE]: [0.93, 0.75, 1, 1.2], [SURF.DESERT]: [0.75, 0.5, 2, 3.0], [SURF.FESCUE]: [0.7, 0.45, 3, 3.0] };
  for (const [id, [speed, spin, launch, sdir]] of Object.entries(want)) {
    assert.deepEqual(SURFACES[id].lie, { speed, spin, launch, sdir });
    assert.equal(SURFACES[id].color.length, 3);
    const lie = lieAt(flat(Number(id)), { x: 0, y: 0 }, 0);
    assert.equal(lie.label, SURF_NAMES[id]);
    assert.deepEqual(lie.factors, { speed, spin, launch, sdir });
  }
});

test('waste: firm sand takes a low bounce and stops much sooner than fairway', () => {
  for (const id of ['D', '7i']) {
    const fw = shot(flat(SURF.FAIRWAY), id);
    const ws = shot(flat(SURF.WASTE), id);
    assert.ok(roll(ws) < 0.4 * roll(fw), `${id}: waste ${roll(ws)} vs fairway ${roll(fw)}`);
    // The first bounce off the crust is lower than off turf.
    const hop = (r) => Math.max(...r.events.filter((e) => e.type === 'bounce').map((e) => e.t), r.events.find((e) => e.type === 'land').t);
    assert.ok(hop(ws) <= hop(fw), 'fewer, shorter hops');
  }
  // A ball rolling out at 6 m/s.
  const fw = simulateShot(flat(SURF.FAIRWAY), rolled(6), { record: false });
  const ws = simulateShot(flat(SURF.WASTE), rolled(6), { record: false });
  assert.ok(ws.total < 0.5 * fw.total, `rolled ${ws.total} vs ${fw.total}`);
});

test('fescue: the ball stops almost dead', () => {
  assert.ok(roll(shot(flat(SURF.FESCUE), 'D')) < 2, 'driver into fescue');
  assert.ok(roll(shot(flat(SURF.FESCUE), '7i')) < 0.6, '7-iron into fescue');
  // Running off the fairway into the fescue at 8 m/s: held within a metre or two of the edge.
  const t = flat(SURF.FAIRWAY, null, { surfaceFn: (x) => (x < 5 ? SURF.FAIRWAY : SURF.FESCUE) });
  const r = simulateShot(t, rolled(8), { record: false });
  assert.equal(r.final.surface, SURF.FESCUE);
  assert.ok(r.final.x < 7, `stopped ${r.final.x - 5} m into the fescue`);
});

test('desert: erratic, mostly dead bounces with the odd stone kick, always finite', () => {
  const rolls = [];
  const lats = [];
  for (let seed = 1; seed <= 40; seed++) {
    const r = shot(flat(SURF.DESERT), '7i', {}, { seed });
    assert.ok(finite(r) && r.final.outcome === 'rest', `seed ${seed}`);
    rolls.push(roll(r));
    lats.push(r.final.y);
  }
  rolls.sort((a, b) => a - b);
  const med = rolls[20];
  assert.ok(med < 2, `median release ${med} m (dead)`);
  assert.ok(rolls[39] > med + 3, `a stone kicks one on: max ${rolls[39]} m`);
  assert.ok(rolls[39] < 25, 'finite');
  assert.ok(new Set(rolls.map((x) => x.toFixed(2))).size > 25, 'every seed bounces differently');
  assert.ok(Math.max(...lats.map(Math.abs)) > 0.5, 'some bounce kicks sideways');
  // The same seed gives the same shot.
  assert.deepEqual(shot(flat(SURF.DESERT), '7i', {}, { seed: 9 }).final, shot(flat(SURF.DESERT), '7i', {}, { seed: 9 }).final);
});

// ------------------------------------------------------------------ conditions

test('surfaceParams: default conditions are the SURFACES table itself (Hollow Pines unchanged)', () => {
  const pines = hole(COURSE, 0);
  assert.equal(surfaceTable(pines), SURFACES);
  assert.equal(surfaceTable(buildHole(COURSE.holes[1])), SURFACES);
  assert.equal(surfaceTable(flat(SURF.FAIRWAY)), SURFACES);
  assert.equal(surfaceTable({ conditions: { ...DEFAULT_CONDITIONS } }), SURFACES);
  for (const id of Object.values(SURF)) assert.equal(surfaceParams(pines, id), SURFACES[id]);
  assert.equal(surfaceParams(pines, 99), SURFACES[SURF.ROUGH]);
  assert.deepEqual(pines.conditions, { firm: 1, greenStimpFt: 10.5, wind: 'normal' });
  assert.equal(pines.theme, 'parkland');
  assert.equal(pines.courseId, 'pines');
  // Cached per terrain, and only firmness-affected surfaces change.
  const links = hole(LINKS, 0);
  assert.equal(surfaceTable(links), surfaceTable(links));
  for (const id of [SURF.BUNKER, SURF.WATER, SURF.WASTE, SURF.DESERT, SURF.FESCUE, SURF.FRINGE]) assert.equal(surfaceParams(links, id), SURFACES[id]);
  const fw = surfaceParams(links, SURF.FAIRWAY);
  assert.ok(Math.abs(fw.a0 - SURFACES[SURF.FAIRWAY].a0 / 1.45 ** 2) < 1e-12);
  assert.ok(fw.e > 1 && fw.e <= 1.2, 'firmer bounce, clamped');
  assert.equal(SURFACES[SURF.FAIRWAY].a0, 1.1, 'the table itself is untouched');
});

test('links: a firm fairway runs a drive on 30+ yd and releases irons; firm greens release instead of spinning back', () => {
  const yd = (m) => m / 0.9144;
  const park = (id) => roll(shot(flat(SURF.FAIRWAY, COURSE.conditions), id));
  const links = (id) => roll(shot(flat(SURF.FAIRWAY, LINKS.conditions), id));
  const desert = (id) => roll(shot(flat(SURF.FAIRWAY, DESERT.conditions), id));
  // Driver: parkland ~19 yd of roll, Red Mesa ~29, Kittiwake ~37 (a dry links runs on 30+ yd).
  assert.ok(yd(park('D')) > 15 && yd(park('D')) < 22, `parkland D ${yd(park('D')).toFixed(1)} yd`);
  assert.ok(yd(links('D')) >= 30 && yd(links('D')) <= 45, `links D ${yd(links('D')).toFixed(1)} yd`);
  assert.ok(yd(desert('D')) > yd(park('D')) + 5 && yd(desert('D')) < yd(links('D')), `desert D ${yd(desert('D')).toFixed(1)} yd`);
  // A 7-iron landing on a links fairway releases several times as far as on parkland.
  const k = links('7i') / park('7i');
  assert.ok(k >= 3 && k <= 8, `7i x${k.toFixed(2)} (${park('7i').toFixed(2)} -> ${links('7i').toFixed(2)} m)`);
  // A putt-paced roll scales with firmness squared (the roll resistance is a0, kv / firm^2).
  const a = simulateShot(flat(SURF.FAIRWAY, COURSE.conditions), rolled(5), { record: false }).total;
  const b = simulateShot(flat(SURF.FAIRWAY, LINKS.conditions), rolled(5), { record: false }).total;
  assert.ok(Math.abs(b / a - 1.45 ** 2) < 0.06, `rolled x${b / a}`);
  // Greens: on Hollow Pines a full SW spins back and a 7-iron stops; on Kittiwake's firm greens
  // the 7-iron releases a few yards and the SW stops by its pitch mark.
  const onGreen = (c, id) => yd(roll(shot(flat(SURF.GREEN, c), id)));
  assert.ok(onGreen(COURSE.conditions, 'SW') < -2 && Math.abs(onGreen(COURSE.conditions, '7i')) < 1.5);
  assert.ok(onGreen(LINKS.conditions, 'SW') > -0.5 && onGreen(LINKS.conditions, 'SW') < 2.5, `links SW ${onGreen(LINKS.conditions, 'SW').toFixed(1)} yd`);
  assert.ok(onGreen(LINKS.conditions, '7i') > 3 && onGreen(LINKS.conditions, '7i') < 12, `links 7i ${onGreen(LINKS.conditions, '7i').toFixed(1)} yd`);
  assert.ok(onGreen(DESERT.conditions, '7i') > onGreen(COURSE.conditions, '7i') + 1);
  // A softer course (Coral Cay, 0.95) keeps parkland greens.
  assert.deepEqual(surfaceParams({ conditions: { firm: 0.95, greenStimpFt: 10.5 } }, SURF.GREEN), SURFACES[SURF.GREEN]);
});

test('green speed: Stimp 12 rolls 12/9 as far as Stimp 9; 10.5 is the calibrated green', () => {
  const g = (ft) => surfaceParams({ conditions: { firm: 1, greenStimpFt: ft } }, SURF.GREEN);
  assert.equal(g(STIMP_REF_FT), SURFACES[SURF.GREEN]);
  const d9 = stimpDistance(1.83, g(9));
  const d12 = stimpDistance(1.83, g(12));
  assert.ok(Math.abs(d12 / d9 - 12 / 9) < 1e-9, `${d12 / d9}`);
  assert.ok(Math.abs(mToFt(stimpDistance(1.83, g(10.5))) - 10.2) < 0.1);
  // Simulated putts on flat greens of both speeds, same stroke.
  const putt = (ft) => simulateShot(flat(SURF.GREEN, { firm: 1, greenStimpFt: ft }), rolled(2.2), { record: false, pin: false }).total;
  assert.ok(Math.abs(putt(12) / putt(9) - 12 / 9) < 0.02, `${putt(12)} vs ${putt(9)}`);
  // Pacing a putt with the hole's green: the same distance needs less speed on the fast green.
  assert.ok(puttSpeedForDistance(5, g(12)) < puttSpeedForDistance(5, g(9)));
  // The lie carries the hole's green for pacing putts.
  const lie = lieAt(hole(LINKS, 0), hole(LINKS, 0).greenCenter, 0);
  assert.equal(lie.puttSurf, surfaceParams(hole(LINKS, 0), SURF.GREEN));
  assert.ok(lie.puttSurf.a0 > SURFACES[SURF.GREEN].a0, 'links greens are slower');
});

// ------------------------------------------------------------------ objects

test('shrub and gorse: a ball running or flying into one is caught and drops nearly dead', () => {
  for (const kind of ['shrub', 'gorse']) {
    const bush = { kind, x: 12, y: 0, trunkR: 0, trunkH: 0, canopy: { cz: 0.6, rx: 1.5, rz: 0.85 } };
    const t = flat(SURF.ROUGH, null, { trees: [bush] });
    // Rolling at 6 m/s on the fairway toward it (it would roll 5 m in the open).
    const tf = flat(SURF.FAIRWAY, null, { trees: [{ ...bush, x: 3 }] });
    const r = simulateShot(tf, rolled(6), { record: false });
    assert.ok(r.events.some((e) => e.type === 'tree'), `${kind}: rolling ball caught`);
    assert.ok(r.final.x < 3 + 0.5, `${kind}: stopped at ${r.final.x}`);
    // Dropping in from a pitch: lands within the bush's spread.
    const p = { pos: { x: 0, y: 0, z: BALL_R }, vel: { x: 9, y: 0, z: 6 }, spin: { x: 0, y: -100, z: 0 }, mode: 'air' };
    let caught = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const q = simulateShot(t, p, { record: false, seed });
      if (q.events.some((e) => e.type === 'tree')) {
        caught++;
        assert.ok(Math.abs(q.final.x - 12) < 2.5, `${kind}: dropped dead at ${q.final.x}`);
      }
    }
    assert.ok(caught >= 15, `${kind}: caught ${caught}/20`);
  }
});

test('a ball lying inside a bush is played out of it (that bush does not catch it again)', () => {
  for (const kind of ['shrub', 'gorse']) {
    const bush = { kind, x: 0.4, y: 0, trunkR: 0, trunkH: 0, canopy: { cz: 0.6, rx: 1.5, rz: 0.85 } };
    const other = { ...bush, x: 14 };
    const p = { pos: { x: 0, y: 0, z: BALL_R }, vel: { x: 9, y: 0, z: 6 }, spin: { x: 0, y: -100, z: 0 }, mode: 'air' };
    for (let seed = 1; seed <= 10; seed++) {
      const out = simulateShot(flat(SURF.ROUGH, null, { trees: [bush] }), p, { record: false, seed });
      assert.ok(!out.events.some((e) => e.type === 'tree'), `${kind}: re-caught by its own bush (seed ${seed})`);
      assert.ok(out.carry > 8, `${kind}: hacked out ${out.carry.toFixed(1)} m`);
      // A rolling ball leaves it too.
      const run = simulateShot(flat(SURF.FAIRWAY, null, { trees: [bush] }), rolled(4), { record: false, seed });
      assert.ok(run.final.x > 2, `${kind}: rolled out to ${run.final.x.toFixed(2)}`);
    }
    // Another bush in the way still catches it.
    let caught = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const q = simulateShot(flat(SURF.ROUGH, null, { trees: [bush, other] }), p, { record: false, seed });
      if (q.events.some((e) => e.type === 'tree')) caught++;
    }
    assert.ok(caught >= 15, `${kind}: the next bush caught ${caught}/20`);
  }
});

test('rock: hard face (e 0.5) bounces a runner back; its rounded top throws a ball off', () => {
  const rock = { kind: 'rock', x: 10, y: 0, trunkR: 0.8, trunkH: 0.6, canopy: null, hard: true };
  const t = flat(SURF.FAIRWAY, null, { trees: [rock] });
  // A runner at 7 m/s reaches the rock's face (x = 4.2) at about 4.5 m/s.
  const near = flat(SURF.FAIRWAY, null, { trees: [{ ...rock, x: 5 }] });
  const r = simulateShot(near, rolled(7), { record: false });
  assert.ok(r.events.some((e) => e.type === 'tree'), 'hits the rock');
  assert.ok(r.final.x < 4.2 - 0.3, `rebounds back toward the tee: ${r.final.x}`);
  // Off a trunk (e 0.4) the same runner comes back less far.
  const tree = { kind: 'broad', x: 5, y: 0, trunkR: 0.8, trunkH: 0.6, canopy: null };
  const r2 = simulateShot(flat(SURF.FAIRWAY, null, { trees: [tree] }), rolled(7), { record: false });
  assert.ok(r2.events.some((e) => e.type === 'tree'));
  assert.ok(4.2 - r2.final.x < 4.2 - r.final.x, `the rock is livelier than a trunk: ${r2.final.x} vs ${r.final.x}`);
  // Dropped onto the top, a little off centre: it bounces off and never perches.
  for (const dx of [0, 0.3, -0.5]) {
    const drop = { pos: { x: 10 + dx, y: 0.1, z: 4 }, vel: { x: 0, y: 0, z: -1 }, spin: { x: 0, y: 0, z: 0 }, mode: 'air' };
    const q = simulateShot(t, drop, { record: false, seed: 2 });
    assert.ok(q.events.some((e) => e.type === 'tree'), 'bounced on the rock');
    assert.ok(Math.hypot(q.final.x - 10, q.final.y) > 0.8 + BALL_R - 1e-3, `came off: ${q.final.x}, ${q.final.y}`);
    assert.ok(q.final.z < 0.1 && q.t < 10, 'rests on the ground beside it');
  }
});

test('saguaro: a bare hard column (canopy null) stops a low runner and a drive', () => {
  const sag = { kind: 'saguaro', x: 20, y: 0, trunkR: 0.25, trunkH: 6, canopy: null };
  const t = flat(SURF.DESERT, null, { trees: [sag] });
  const r = simulateShot(flat(SURF.FAIRWAY, null, { trees: [{ ...sag, x: 4 }] }), rolled(7), { record: false, seed: 4 });
  assert.ok(r.events.some((e) => e.type === 'tree'));
  assert.ok(r.final.x < 4 - 0.25, `bounced back: ${r.final.x}`);
  // A line drive at head height into it.
  const d = { pos: { x: 0, y: 0, z: 2 }, vel: { x: 40, y: 0, z: 0.5 }, spin: { x: 0, y: -200, z: 0 }, mode: 'air' };
  const q = simulateShot(t, d, { record: false });
  assert.ok(q.events.some((e) => e.type === 'tree'), 'the column is hit');
  assert.ok(q.final.x < 20, 'and it comes back');
  const h = treeHit(sag, { x: 19, y: 0, z: 9 }, { x: 21, y: 0, z: 9 });
  assert.equal(h, null, 'nothing above the column (its arms are visual only)');
});

test('objects with trunkR 0 or canopy null never crash the physics', () => {
  const rng = mulberry32(11);
  const kinds = ['palm', 'saguaro', 'shrub', 'gorse', 'rock', 'grass', 'broad'];
  const trees = [];
  for (let i = 0; i < 160; i++) {
    const kind = kinds[i % kinds.length];
    const x = 10 + rng() * 200;
    const y = (rng() - 0.5) * 60;
    if (kind === 'grass') trees.push({ kind, x, y, trunkR: 0, trunkH: 0, canopy: null });
    else if (kind === 'rock') trees.push({ kind, x, y, trunkR: 0.3 + rng(), trunkH: 0.5, canopy: null, hard: true });
    else if (kind === 'saguaro') trees.push({ kind, x, y, trunkR: 0.25, trunkH: 6, canopy: null });
    else if (kind === 'shrub' || kind === 'gorse') trees.push({ kind, x, y, trunkR: 0, trunkH: 0, canopy: { cz: 0.6, rx: 1.4, rz: 0.85 } });
    else trees.push({ kind, x, y, trunkR: 0.18, trunkH: 9, canopy: { cz: 9.3, rx: 3.5, rz: 1.5 } });
  }
  const t = flat(SURF.WASTE, null, { trees });
  for (let k = 0; k < 40; k++) {
    const id = ['D', '5i', '7i', 'PW'][k % 4];
    const r = shot(t, id, { aimYaw: (rng() - 0.5) * 0.5, speedScale: 0.4 + 0.6 * rng() }, { seed: k + 1 });
    assert.ok(finite(r) && ['rest', 'holed'].includes(r.final.outcome), `shot ${k}`);
  }
  for (let k = 0; k < 20; k++) {
    const r = simulateShot(t, { ...rolled(10 + rng() * 10, 5), vel: { x: 12, y: (rng() - 0.5) * 6, z: 0 } }, { record: false, seed: k });
    assert.ok(finite(r));
  }
});

// ------------------------------------------------------------------ water

test('island green: water everywhere outside the tee and green islands', () => {
  const t = hole(WATER, 2);
  const flood = t.waters.find((w) => w.fill === 'outside');
  assert.ok(flood && flood.islands.length === 2 && flood.poly.length === 4);
  assert.equal(t.surfaceAt(t.tee.x, t.tee.y), SURF.TEE);
  for (const p of t.pins) assert.equal(t.surfaceAt(p.x, p.y), SURF.GREEN);
  // Between the islands, beside them and in the far corners: water at the flood level, bed below.
  const { minX, minY, maxX, maxY } = t.bounds;
  for (const [x, y] of [[0, 70], [0, 100], [50, 140], [-50, 20], [minX + 3, minY + 3], [maxX - 3, maxY - 3], [0, 175]]) {
    assert.equal(t.surfaceAt(x, y), SURF.WATER, `${x},${y}`);
    assert.deepEqual(t.waterAt(x, y), { kind: flood.kind, level: flood.level });
    assert.ok(t.heightAt(x, y) < flood.level, 'bed below the water level');
  }
  // The islands stand clear of the water (green, fringe and tee well above it).
  assert.ok(t.greenCenter.z > flood.level + 0.8 && t.tee.z > flood.level + 0.8);
  assert.equal(t.waterAt(t.greenCenter.x, t.greenCenter.y), null);
  // sgrid agrees.
  const sg = t.sgrid;
  const i = Math.floor((0 - sg.minX) / sg.step);
  const j = Math.floor((70 - sg.minY) / sg.step);
  assert.equal(sg.data[j * sg.nx + i], SURF.WATER);
});

test('island green relief: short or long, the drop is dry, holds the ball and is no nearer the hole', () => {
  const t = hole(WATER, 2);
  const aim = Math.atan2(t.cup.y - t.tee.y, t.cup.x - t.tee.x);
  const pos = { x: t.tee.x, y: t.tee.y, z: t.tee.z + BALL_R };
  let n = 0;
  for (const [id, speedScale] of [['PW', 0.75], ['9i', 0.7], ['6i', 1], ['5i', 1]]) {
    const r = simulateShot(t, stockLaunch(clubById(id), { pos, aimYaw: aim, speedScale }), { seed: 3 });
    assert.equal(r.final.outcome, 'water', `${id} ${speedScale}`);
    const res = resolveShot({ terrain: t, par: 3, strokes: 0, prevSpot: t.tee, fromTee: true, fromSurface: SURF.TEE }, r);
    const d = res.decision;
    assert.ok(d && d.kind === 'water' && res.penalty === 1);
    assert.ok(isDropOk(t, d.drop.x, d.drop.y), 'dry ground');
    assert.notEqual(t.surfaceAt(d.drop.x, d.drop.y), SURF.WATER);
    const dEntry = Math.hypot(d.entry.x - t.cup.x, d.entry.y - t.cup.y);
    const dDrop = Math.hypot(d.drop.x - t.cup.x, d.drop.y - t.cup.y);
    assert.ok(dDrop >= dEntry - 1e-6, `no nearer the hole: ${dDrop} vs ${dEntry}`);
    if (d.relief === 'lateral') assert.ok(Math.hypot(d.drop.x - d.entry.x, d.drop.y - d.entry.y) <= 2.29);
    // A ball dropped there stays put.
    const still = simulateShot(t, { pos: d.drop, vel: { x: 0, y: 0, z: 0 }, spin: { x: 0, y: 0, z: 0 }, mode: 'roll' }, { record: false, maxT: 5 });
    assert.ok(still.final.outcome === 'rest' && still.total < 0.31);
    n++;
  }
  assert.equal(n, 4);
});

test('sea: outside water floods beyond the corridor and its beach; the sea gets relief', () => {
  const t = hole(WATER, 6);
  const sea = t.waters.find((w) => w.fill === 'outside');
  assert.ok(sea && sea.sea === true && sea.islands.length === 0);
  const at = (s, off) => {
    const p = t.path.pointAt(s);
    const d = t.path.tangentAt(s);
    return { x: p.x + d.y * off, y: p.y - d.x * off };
  };
  const c = (s, off) => t.surfaceAt(at(s, off).x, at(s, off).y);
  assert.equal(c(200, 0), SURF.FAIRWAY);
  assert.equal(c(200, 20), SURF.ROUGH);
  assert.equal(c(200, 30), SURF.WASTE, 'beach');
  assert.equal(c(200, 55), SURF.WATER);
  assert.equal(c(200, -45), SURF.WATER);
  assert.equal(c(30, 0), SURF.WATER, 'carry over the sea from the tee');
  // A hook into the sea: relief on dry land, no nearer the hole.
  const pos = { x: t.tee.x, y: t.tee.y, z: t.tee.z + BALL_R };
  const aim = Math.atan2(t.cup.y - t.tee.y, t.cup.x - t.tee.x) + 0.35;
  const r = simulateShot(t, stockLaunch(clubById('D'), { pos, aimYaw: aim }), { seed: 1 });
  assert.equal(r.final.outcome, 'water');
  const res = resolveShot({ terrain: t, par: 4, strokes: 0, prevSpot: t.tee, fromTee: true, fromSurface: SURF.TEE }, r);
  assert.ok(isDropOk(t, res.decision.drop.x, res.decision.drop.y));
});

// ------------------------------------------------------------------ terrain features

test('pot bunkers: deep and round, with a steep revetted face toward the green', () => {
  const def = {
    n: 98, par: 4, name: 'Pot', si: 1,
    path: [[0, 0], [0, 150], [0, 300]],
    elev: [[0, 0]], undulate: 0,
    tee: { s: 0 },
    fairway: { from: 100, to: 290, width: 40, wobble: 0 },
    green: { rx: 14, ry: 14, slope: [270, 1], pins: [[0, 0]] },
    bunkers: [{ s: 200, off: 0, pot: true, r: 2.4 }, { s: 150, off: 0, shape: [[0, 0, 2.4, 2.4, 0]], depth: 0.7 }],
    forest: false,
  };
  const t = buildHole(def);
  const c = t.path.pointAt(200);
  assert.equal(t.surfaceAt(c.x, c.y), SURF.BUNKER);
  const rim = t.heightAt(c.x + 4, c.y);
  assert.ok(rim - t.heightAt(c.x, c.y) >= 1.2, `depth ${rim - t.heightAt(c.x, c.y)}`);
  // The green is +y: the face (toward it) is steeper than the back.
  const slope = (x, y) => Math.hypot(t.gradAt(x, y).x, t.gradAt(x, y).y);
  let face = 0;
  let back = 0;
  for (let d = 1.4; d <= 2.4; d += 0.1) {
    face = Math.max(face, slope(c.x, c.y + d));
    back = Math.max(back, slope(c.x, c.y - d));
  }
  assert.ok(face > 1.2 && face > 1.3 * back, `face ${face} back ${back}`);
  // A shallow ordinary bunker of the same size for comparison.
  const o = t.path.pointAt(150);
  assert.ok(t.heightAt(o.x + 4, o.y) - t.heightAt(o.x, o.y) < 0.9);
});

test('outside, rough band, areas and objects (synthetic hole)', () => {
  const def = {
    n: 97, par: 4, name: 'Lab', si: 1,
    path: [[0, 0], [0, 150], [0, 300]],
    elev: [[0, 0]], undulate: 0,
    tee: { s: 0, w: 10, l: 10 },
    fairway: { from: 60, to: 285, width: 30, wobble: 0 },
    green: { rx: 14, ry: 14, slope: [270, 1], pins: [[0, 0]] },
    outside: 'desert',
    rough: { w: 8, wobble: 0, relief: 0 },
    areas: [
      { surface: 'waste', poly: [[100, 20], [160, 20], [160, 40], [100, 40]], dz: -0.3 },
      { surface: 'fescue', s: 200, off: -30, shape: [[0, 0, 6, 6, 0]] },
      { surface: 'fairway', poly: [[130, 25], [140, 25], [140, 30], [130, 30]] },
    ],
    objects: [
      { kind: { saguaro: 0.5, rock: 0.5 }, area: 'desert', density: 1 },
      { kind: 'shrub', from: 70, to: 260, off: 26, gap: 9, jitter: 1 },
      { kind: 'grass', area: 0, density: 5 },
      { kind: 'palm', s: 150, off: -40, cluster: 4, spread: 6 },
    ],
    forest: false,
  };
  const t = buildHole(def);
  assert.equal(t.surfaceAt(0, 100), SURF.FAIRWAY);
  assert.equal(t.surfaceAt(19, 100), SURF.ROUGH, 'within the rough band');
  assert.equal(t.surfaceAt(26, 80), SURF.DESERT, 'beyond it');
  assert.equal(t.surfaceAt(-60, 150), SURF.DESERT);
  assert.equal(t.surfaceAt(0, 30), SURF.DESERT, 'forced carry between tee and fairway');
  assert.equal(t.surfaceAt(0, 9), SURF.ROUGH, 'band round the tee');
  assert.equal(t.surfaceAt(30, 110), SURF.WASTE);
  assert.equal(t.surfaceAt(35, 135), SURF.WASTE);
  assert.equal(t.surfaceAt(27, 135), SURF.FAIRWAY, 'later areas paint over earlier ones');
  assert.equal(t.surfaceAt(-30, 200), SURF.FESCUE);
  assert.ok(t.heightAt(30, 130) < t.heightAt(30, 90) - 0.25, 'dz lowers the waste area');
  assert.equal(lieAt(t, { x: 30, y: 110 }, Math.PI / 2).label.split(' · ')[0], 'Waste area');
  // Objects: well formed, never on the fairway, tee, green, water or in a bunker.
  const kinds = new Set(t.trees.map((o) => o.kind));
  for (const k of ['saguaro', 'rock', 'shrub', 'palm']) assert.ok(kinds.has(k), k);
  assert.ok(!kinds.has('grass') && t.decor.length > 20 && t.decor.every((d) => d.kind === 'grass' && Number.isFinite(d.z)));
  for (const d of t.decor) assert.equal(t.surfaceAt(d.x, d.y), SURF.WASTE);
  for (const o of t.trees) {
    assert.ok(![SURF.FAIRWAY, SURF.GREEN, SURF.FRINGE, SURF.TEE, SURF.WATER, SURF.BUNKER].includes(t.surfaceAt(o.x, o.y)), `${o.kind}`);
    assert.ok(Math.abs(o.z - t.heightAt(o.x, o.y)) < 1e-6);
    if (o.kind === 'saguaro') assert.ok(o.canopy === null && o.trunkR === 0.25 && o.trunkH >= 4 && o.trunkH <= 9);
    if (o.kind === 'rock') assert.ok(o.canopy === null && o.hard === true && o.trunkR > 0);
    if (o.kind === 'shrub') assert.ok(o.trunkR === 0 && o.canopy.cz - o.z < 1 && o.canopy.rx >= 1 && o.canopy.rx <= 2 && o.canopy.cz - o.canopy.rz < o.z);
    if (o.kind === 'palm') assert.ok(o.trunkR === 0.18 && o.trunkH >= 8 && o.trunkH <= 12 && o.canopy.cz > o.z + o.trunkH - 1);
  }
  // treesNear matches brute force with canopy-less objects.
  const reach = (o) => (o.canopy ? Math.max(o.canopy.rx, o.trunkR) : o.trunkR);
  const r = mulberry32(5);
  for (let i = 0; i < 60; i++) {
    const x = t.bounds.minX + r() * (t.bounds.maxX - t.bounds.minX);
    const y = t.bounds.minY + r() * (t.bounds.maxY - t.bounds.minY);
    const rad = r() * 15;
    const got = new Set(t.treesNear(x, y, rad));
    for (const o of t.trees) assert.equal(got.has(o), Math.hypot(o.x - x, o.y - y) <= rad + reach(o));
  }
});

// ------------------------------------------------------------------ courses

test('course registry: four courses in menu order, lookup with fallback, summaries', () => {
  assert.deepEqual(COURSES.map((c) => c.id), ['pines', 'desert', 'water', 'links']);
  assert.equal(PINES, COURSE);
  assert.equal(DEFAULT_COURSE_ID, 'pines');
  assert.equal(courseById('links'), LINKS);
  assert.equal(courseById('nope'), COURSE);
  assert.equal(courseById(undefined), COURSE);
  assert.deepEqual(COURSES.map((c) => c.theme), ['parkland', 'desert', 'tropical', 'links']);
  for (const c of COURSES) {
    assert.ok(c.name && c.tagline && c.holes.length === 9);
    assert.ok(c.conditions.firm > 0 && c.conditions.greenStimpFt > 0 && ['normal', 'windy'].includes(c.conditions.wind));
    const s = courseSummary(c);
    assert.equal(s.par, 36, c.id);
    assert.ok(s.yards > 2900 && s.yards < 3700, `${c.id} ${s.yards}`);
    assert.deepEqual(c.holes.map((h) => h.si).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  }
  assert.equal(LINKS.conditions.wind, 'windy');
  assert.equal(DESERT.holes[0].outside, 'desert');
});

for (const course of COURSES) {
  test(`${course.name}: all nine holes build in < 300 ms with the tee on TEE and every pin on GREEN`, () => {
    for (let i = 0; i < 9; i++) {
      const def = course.holes[i];
      // Best of two builds: the test files run in parallel processes, so one build can be starved.
      let t0 = performance.now();
      buildHole(def, { pinIndex: 0, seed: 1, course });
      let ms = performance.now() - t0;
      t0 = performance.now();
      const t = buildHole(def, { pinIndex: 1, seed: 1, course });
      ms = Math.min(ms, performance.now() - t0);
      assert.ok(ms < 300, `hole ${i + 1}: ${ms.toFixed(0)} ms`);
      assert.equal(t.courseId, course.id);
      assert.equal(t.theme, course.theme);
      assert.equal(t.conditions.greenStimpFt, course.conditions.greenStimpFt);
      assert.equal(t.surfaceAt(t.tee.x, t.tee.y), SURF.TEE, `hole ${i + 1} tee`);
      assert.equal(t.pins.length, 3);
      for (const p of t.pins) {
        assert.equal(t.surfaceAt(p.x, p.y), SURF.GREEN, `hole ${i + 1} pin`);
        // A cup's worth of green round each pin, gentle enough to putt to.
        for (let k = 0; k < 8; k++) {
          const a = (k / 8) * Math.PI * 2;
          assert.equal(t.surfaceAt(p.x + 4 * Math.cos(a), p.y + 4 * Math.sin(a)), SURF.GREEN, `hole ${i + 1}: pin 4 m inside`);
          const g = t.gradAt(p.x + CUP_R * 20 * Math.cos(a), p.y + CUP_R * 20 * Math.sin(a));
          assert.ok(Math.hypot(g.x, g.y) <= 0.03, `hole ${i + 1}: slope near the pin`);
        }
      }
      for (const o of t.trees) assert.ok(o.canopy === null || (o.canopy.rx > 0 && o.canopy.rz > 0));
      for (const w of t.waters) assert.ok(['red', 'yellow'].includes(w.kind) && w.poly.length >= 3 && Number.isFinite(w.level));
    }
  });
}

test('heights stay continuous on the new terrain features (island, sea, pots, desert)', () => {
  for (const t of [hole(WATER, 2), hole(WATER, 6), hole(LINKS, 0), hole(DESERT, 3)]) {
    const r = mulberry32(t.n * 7 + 1);
    const { minX, minY, maxX, maxY } = t.bounds;
    const g = { x: 0, y: 0 };
    let worst = 0;
    for (let line = 0; line < 40; line++) {
      let x = minX + r() * (maxX - minX);
      let y = minY + r() * (maxY - minY);
      const a = r() * Math.PI * 2;
      const dx = Math.cos(a) * 0.1;
      const dy = Math.sin(a) * 0.1;
      let h = t.heightAt(x, y);
      for (let k = 0; k < 300; k++) {
        const h1 = t.heightAt(x + dx, y + dy);
        t.gradAt(x, y, g);
        const s0 = Math.hypot(g.x, g.y);
        t.gradAt(x + dx, y + dy, g);
        const s1 = Math.hypot(g.x, g.y);
        worst = Math.max(worst, Math.abs(h1 - h) - 0.1 * Math.max(s0, s1));
        x += dx;
        y += dy;
        h = h1;
      }
    }
    assert.ok(worst < 0.02, `${t.courseId} ${t.n}: jump ${worst}`);
  }
});

// ------------------------------------------------------------------ game

const full = (power = 1) => ({ ok: true, kind: 'full', power, startDir: 0, faceToPath: 0, tempo: 'smooth', label: 'Straight' });
function playOut(g) {
  let n = 0;
  while (g.phase === 'flight' && n++ < 60 * 120) g.update(1 / 60);
  assert.notEqual(g.phase, 'flight');
}
const cachedBuild = (def, opts) => {
  const c = opts.course || COURSE;
  const i = c.holes.indexOf(def);
  return i >= 0 && (opts.pinIndex ?? 0) === 0 ? hole(c, i, 0) : buildHole(def, opts);
};

test('Game plays every course: course holes, themed terrain, shots and relief', () => {
  for (const course of COURSES) {
    const g = new Game({ course, seed: 5, settings: { wind: 'light' }, buildHole: (def, opts) => cachedBuild(def, { ...opts, pinIndex: 0 }) });
    g.state.pins = g.state.pins.map(() => 0);
    for (const i of [0, 2]) {
      g.loadHole(i);
      assert.equal(g.def, course.holes[i]);
      assert.equal(g.terrain.courseId, course.id);
      assert.equal(g.holeInfo().theme, course.theme);
      g.skipIntro();
      for (let k = 0; k < 3 && g.phase === 'address'; k++) {
        const r = g.swing(full(0.9));
        assert.ok(r.ok);
        playOut(g);
        if (g.phase === 'decision') g.decide('drop');
      }
      assert.ok(['address', 'holed'].includes(g.phase), `${course.id} hole ${i + 1}: ${g.phase}`);
      assert.ok(Number.isFinite(g.ballPos().x));
      // Hole out from beside the cup.
      const c = g.terrain.cup;
      g.debugPlace(c.x + 0.4, c.y);
      g.setClub('P');
      g.setPuttRange(3);
      g.setAim(Math.PI);
      g.swing({ ok: true, kind: 'putt', power: 0.7 / 3, startDir: 0, faceToPath: 0, tempo: 'smooth', label: 'Putt' });
      playOut(g);
      assert.equal(g.phase, 'holed');
    }
    assert.equal(g.serialize().courseId, course.id);
  }
});

test('wind: a windy course adds 3 m/s to the Light and Breezy ranges, never to Off', () => {
  const windy = { wind: 'windy' };
  for (let seed = 1; seed <= 30; seed++) {
    const a = windFor(seed, 2, 'light');
    const b = windFor(seed, 2, 'light', windy);
    const sa = Math.hypot(a.x, a.y);
    const sb = Math.hypot(b.x, b.y);
    assert.ok(Math.abs(sb - sa - WINDY_EXTRA) < 1e-9, `${sa} -> ${sb}`);
    assert.ok(Math.abs(Math.atan2(a.y, a.x) - Math.atan2(b.y, b.x)) < 1e-9, 'same direction');
    const br = Math.hypot(windFor(seed, 4, 'breezy', windy).x, windFor(seed, 4, 'breezy', windy).y);
    assert.ok(br >= WIND_RANGES.breezy[0] + 3 - 1e-9 && br <= WIND_RANGES.breezy[1] + 3 + 1e-9);
    assert.deepEqual(windFor(seed, 2, 'off', windy), { x: 0, y: 0 });
  }
  assert.deepEqual(windFor(4, 1, 'light', { wind: 'normal' }), windFor(4, 1, 'light'));
  const g = new Game({ course: LINKS, seed: 8, settings: { wind: 'light' }, buildHole: (def, opts) => cachedBuild(def, { ...opts, pinIndex: 0 }) });
  g.loadHole(0);
  assert.ok(Math.hypot(g.wind.x, g.wind.y) >= 3);
});

test('saves: courseId is stored; a save without one restores Hollow Pines', () => {
  const build = (def, opts) => cachedBuild(def, { ...opts, pinIndex: 0 });
  const g = new Game({ course: DESERT, seed: 2, settings: { wind: 'off' }, buildHole: build });
  g.state.pins = g.state.pins.map(() => 0);
  g.loadHole(0);
  g.skipIntro();
  const save = JSON.parse(JSON.stringify(g.serialize()));
  assert.equal(save.courseId, 'desert');
  const h = Game.restore(save, { buildHole: build });
  assert.equal(h.course, DESERT);
  assert.equal(h.terrain.courseId, 'desert');
  assert.deepEqual(h.state, g.state);
  // An old (version 1) save has no courseId.
  const p = new Game({ seed: 2, settings: { wind: 'off' }, buildHole: build });
  p.state.pins = p.state.pins.map(() => 0);
  p.loadHole(0);
  p.skipIntro();
  const old = p.serialize();
  delete old.courseId;
  const q = Game.restore(old, { buildHole: build });
  assert.equal(q.course, COURSE);
  assert.equal(q.state.courseId, 'pines');
  assert.equal(q.terrain.courseId, 'pines');
  assert.equal(q.serialize().courseId, 'pines');
});

// ------------------------------------------------------------------ themes

test('themes: four complete palettes; parkland is the shipped look', () => {
  assert.deepEqual(Object.keys(THEMES).sort(), ['desert', 'links', 'parkland', 'tropical']);
  for (const c of COURSES) assert.equal(themeFor(c.theme).id, c.theme);
  assert.equal(themeFor('nope'), THEMES.parkland);
  const rgb = (a) => Array.isArray(a) && a.length === 3 && a.every((v) => v >= 0 && v <= 1.3);
  for (const th of Object.values(THEMES)) {
    assert.ok(rgb(th.sky.zenith) && rgb(th.sky.horizon) && rgb(th.sky.sunColor) && rgb(th.sky.haze));
    assert.ok(Math.abs(Math.hypot(th.sky.sunDir.x, th.sky.sunDir.y, th.sky.sunDir.z) - 1) < 1e-9 && th.sky.sunDir.z > 0.3);
    assert.ok(th.fog.density > 0 && rgb(th.ambient.sky) && rgb(th.ambient.ground));
    for (const id of Object.values(SURF)) assert.ok(rgb(th.surfaceColors[id]), `${th.id} surface ${id}`);
    assert.ok(rgb(th.water.deep) && rgb(th.water.shallow) && typeof th.water.sea === 'boolean');
    assert.ok(['hills', 'mountains', 'ocean', 'dunes', 'mesas'].includes(th.horizon));
    assert.ok(th.stripe > 0 && th.stripe <= 1);
  }
  const P = THEMES.parkland;
  assert.deepEqual(P.sky.zenith, [0.07, 0.19, 0.56]);
  assert.deepEqual(P.sky.horizon, [0.46, 0.6, 0.78]);
  assert.deepEqual(P.sky.sunColor, [1.08, 0.95 * 1.08, 0.86 * 1.08]);
  assert.ok(Math.abs(P.sky.sunDir.x - SUN_DIR.x) < 1e-12 && Math.abs(P.sky.sunDir.y - SUN_DIR.y) < 1e-12 && Math.abs(P.sky.sunDir.z - SUN_DIR.z) < 1e-12);
  assert.equal(P.fog.density, 1 / 1100);
  for (const id of Object.values(SURF)) assert.deepEqual(P.surfaceColors[id], SURFACES[id].color);
  assert.equal(P.stripe, 1);
  assert.equal(P.horizon, 'hills');
  assert.ok(THEMES.links.stripe < 0.6 && THEMES.tropical.water.sea && THEMES.links.water.sea);
});
