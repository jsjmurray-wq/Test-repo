// Spectators (docs/architecture.md section 10): gallery placement on every hole of every course,
// counts per setting, determinism, the grandstand, reaction mapping and the state machine, the
// person and furniture meshes, the skeleton's poses and the baked shadows.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COURSES } from '../src/courses.js';
import { buildHole } from '../src/terrain.js';
import { SURF } from '../src/constants.js';
import {
  buildCrowd, crowdSeed, crowdCount, crowdShadowBake, corridorClearance, planReactions, CrowdReactions,
  PERSON_FLOATS, MAX_PEOPLE, MIN_LIGHT, REACT, REACT_NAMES, MAX_SLOPE, packColor, unpackColor,
} from '../src/crowd.js';
import { personMesh, furnitureMesh, posePerson, POSES, POSE_WRIST, PART, PJ } from '../src/crowd-mesh.js';
import { CROWD_VS, CROWD_FS, CROWD_PROP_VS } from '../src/shaders-crowd.js';
import { bakeTerrainColor } from '../src/bake.js';

const FORBID = new Set([SURF.TEE, SURF.FAIRWAY, SURF.FRINGE, SURF.GREEN, SURF.BUNKER, SURF.WATER, SURF.OOB]);
const MOWN = new Set([SURF.TEE, SURF.FAIRWAY, SURF.FRINGE, SURF.GREEN]);
const WET = new Set([SURF.BUNKER, SURF.WATER]);

// Every hole of every course, built once.
const HOLES = [];
for (const c of COURSES) {
  for (const def of c.holes) {
    const t = buildHole(def, { pinIndex: 0, seed: 1, course: c });
    HOLES.push({ c, def, t, L: buildCrowd(t, { seed: crowdSeed(c.id, def.n), theme: c.theme }) });
  }
}
const person = (L, i) => {
  const o = i * PERSON_FLOATS;
  const P = L.people;
  return { x: P[o], y: P[o + 1], z: P[o + 2], yaw: P[o + 3], s: P[o + 4], seed: P[o + 5], flags: P[o + 6], sit: P[o + 6] % 2 >= 1 };
};

function segDist(px, py, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / l2));
  return { d: Math.hypot(px - a.x - dx * t, py - a.y - dy * t), along: t * Math.sqrt(l2) };
}

test('every hole of every course: counts per setting within 40..250, Light a prefix of Full', () => {
  for (const { c, def, L } of HOLES) {
    const tag = `${c.id} ${def.n}`;
    assert.ok(L.nFull <= MAX_PEOPLE && L.nFull <= 250, `${tag}: full ${L.nFull}`);
    assert.ok(L.nFull >= 120, `${tag}: full ${L.nFull}`);
    assert.ok(L.nLight >= MIN_LIGHT && L.nLight <= 100 && L.nLight < L.nFull, `${tag}: light ${L.nLight}`);
    assert.equal(L.people.length, L.nFull * PERSON_FLOATS);
    assert.equal(crowdCount(L, 'off'), 0);
    assert.equal(crowdCount(L, 'light'), L.nLight);
    assert.equal(crowdCount(L, 'full'), L.nFull);
    for (let k = 0; k < L.people.length; k++) assert.ok(Number.isFinite(L.people[k]), `${tag}: finite instance data`);
    assert.ok(L.ropes.length >= 2, `${tag}: rope lines`);
  }
});

test('every hole: nobody in play, in water, sand or out of bounds, on a steep slope or against a tree', () => {
  for (const { c, def, t, L } of HOLES) {
    const tag = `${c.id} ${def.n}`;
    for (let i = 0; i < L.nFull; i++) {
      const p = person(L, i);
      const s = t.surfaceAt(p.x, p.y);
      assert.ok(!FORBID.has(s), `${tag}: person ${i} on surface ${s}`);
      assert.ok(!t.isOOB(p.x, p.y), `${tag}: person ${i} out of bounds`);
      if (p.sit) continue; // (the grandstand's footprint is checked below)
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        assert.ok(!MOWN.has(t.surfaceAt(p.x + Math.cos(a) * 1.5, p.y + Math.sin(a) * 1.5)), `${tag}: person ${i} within 1.5 m of the mown areas`);
        assert.ok(!WET.has(t.surfaceAt(p.x + Math.cos(a) * 1.0, p.y + Math.sin(a) * 1.0)), `${tag}: person ${i} within 1 m of sand or water`);
      }
      const g = t.gradAt(p.x, p.y);
      assert.ok(Math.hypot(g.x, g.y) <= MAX_SLOPE + 0.02, `${tag}: person ${i} on a slope of ${Math.hypot(g.x, g.y).toFixed(2)}`);
      assert.ok(Math.abs(p.z - t.heightAt(p.x, p.y)) < 0.01, `${tag}: person ${i} on the ground`);
      for (const tr of t.treesNear(p.x, p.y, 1)) {
        const d = Math.hypot(tr.x - p.x, tr.y - p.y);
        assert.ok(d > (tr.trunkR || 0) + 0.3, `${tag}: person ${i} inside a ${tr.kind}`);
      }
    }
    for (const rp of L.ropes) for (const s of rp.pts) assert.ok(!FORBID.has(t.surfaceAt(s.x, s.y)), `${tag}: a stake in play`);
  }
});

test('every hole: nobody in the address-view corridor or within 8 m of the line of play near the tee', () => {
  for (const { c, def, t, L } of HOLES) {
    const tag = `${c.id} ${def.n}`;
    const aim = t.aimPoint(t.tee);
    for (let i = 0; i < L.nFull; i++) {
      const p = person(L, i);
      assert.ok(corridorClearance(L.corridor, p.x, p.y) >= 0, `${tag}: person ${i} in the corridor`);
      const s = segDist(p.x, p.y, t.tee, aim);
      if (s.along < 40) assert.ok(s.d >= 8, `${tag}: person ${i} ${s.d.toFixed(1)} m from the tee line`);
    }
    // The corridor runs from behind the tee to the cup.
    const P = L.corridor.pts;
    assert.ok(Math.hypot(P[P.length - 1].x - t.cup.x, P[P.length - 1].y - t.cup.y) < 1, `${tag}: corridor ends at the cup`);
  }
});

test('green galleries stay out of the approach in front of the green', () => {
  for (const { c, def, t, L } of HOLES) {
    const g = t.green;
    const pa = t.path.pointAt(Math.max(0, t.path.length - 70));
    const dl = Math.hypot(g.cx - pa.x, g.cy - pa.y);
    const din = { x: (g.cx - pa.x) / dl, y: (g.cy - pa.y) / dl };
    for (let i = 0; i < L.nFull; i++) {
      const p = person(L, i);
      const d = Math.hypot(p.x - g.cx, p.y - g.cy);
      if (d > 45 || p.sit) continue;
      const front = -((p.x - g.cx) * din.x + (p.y - g.cy) * din.y) / d;
      assert.ok(front < Math.cos((50 * Math.PI) / 180), `${c.id} ${def.n}: person ${i} in front of the green`);
    }
  }
});

test('grandstand: on par 3s and finishing holes when there is room, seated, never in play', () => {
  let stands = 0;
  for (const { c, def, t, L } of HOLES) {
    const tag = `${c.id} ${def.n}`;
    if (def.par !== 3 && def.n !== 9) assert.equal(L.stand, null, `${tag}: no grandstand`);
    if (!L.stand) continue;
    stands++;
    const st = L.stand;
    const fx = Math.cos(st.yaw);
    const fy = Math.sin(st.yaw);
    for (let a = -st.w / 2; a <= st.w / 2; a += 1) {
      for (let d = 0; d <= st.rows * st.rowD; d += 0.85) {
        const x = st.x - fy * a - fx * d;
        const y = st.y + fx * a - fy * d;
        assert.ok(!FORBID.has(t.surfaceAt(x, y)), `${tag}: grandstand over play`);
        assert.ok(t.heightAt(x, y) < st.z + Math.floor(d / st.rowD) * st.rise + 0.05, `${tag}: ground through a tier`);
      }
    }
    // It faces the green.
    const toG = Math.atan2(t.green.cy - st.y, t.green.cx - st.x);
    assert.ok(Math.cos(toG - st.yaw) > 0.95, `${tag}: grandstand faces the green`);
    let seated = 0;
    for (let i = 0; i < L.nFull; i++) if (person(L, i).sit) seated++;
    assert.ok(seated >= 20 && seated <= st.seats, `${tag}: ${seated} seated`);
  }
  assert.ok(stands >= 11, `grandstands on ${stands} holes`); // of 12 (the island par 3 has no room)
  // A finishing hole of a mixed round gets one; the 9th of a course without the flag does not.
  const h = HOLES.find((q) => q.c.id === 'pines' && q.def.n === 4);
  assert.ok(buildCrowd(h.t, { seed: 5, finishing: true }).stand, 'finishing par 4 has a grandstand');
  const h9 = HOLES.find((q) => q.c.id === 'pines' && q.def.n === 9);
  assert.equal(buildCrowd(h9.t, { seed: 5, finishing: false }).stand, null);
});

test('deterministic per seed; another seed gives another crowd', () => {
  const { t, c, def } = HOLES[0];
  const a = buildCrowd(t, { seed: crowdSeed(c.id, def.n) });
  const b = buildCrowd(t, { seed: crowdSeed(c.id, def.n) });
  assert.deepEqual(Array.from(a.people), Array.from(b.people));
  assert.deepEqual(a.ropes, b.ropes);
  const d = buildCrowd(t, { seed: crowdSeed(c.id, def.n) + 1 });
  assert.notDeepEqual(Array.from(a.people.slice(0, 120)), Array.from(d.people.slice(0, 120)));
  assert.notEqual(crowdSeed('pines', 1), crowdSeed('desert', 1));
  assert.notEqual(crowdSeed('pines', 1), crowdSeed('pines', 2));
});

test('instance data: heights, colours, flags and theme wardrobes', () => {
  const stats = {};
  for (const { c, L } of HOLES) {
    const s = (stats[c.theme] = stats[c.theme] || { n: 0, para: 0, long: 0, shorts: 0, hats: {} });
    for (let i = 0; i < L.nFull; i++) {
      const p = person(L, i);
      assert.ok(p.s > 0.6 && p.s < 1.15, 'height scale');
      assert.ok(p.seed >= 0 && p.seed < 1);
      for (let k = 7; k < 12; k++) {
        const v = L.people[i * PERSON_FLOATS + k];
        assert.ok(Number.isInteger(v) && v >= 0 && v < 2 ** 24, 'packed colour');
      }
      const hat = Math.floor(p.flags / 2) % 8;
      assert.ok(hat <= 5);
      s.n++;
      s.hats[hat] = (s.hats[hat] || 0) + 1;
      if (Math.floor(p.flags / 16) % 2) s.para++;
      if (Math.floor(p.flags / 32) % 2) s.long++;
      if (Math.floor(p.flags / 64) % 2) s.shorts++;
    }
  }
  // Links: jackets and bucket hats / flat caps; tropical and desert: parasols, sun hats, shorts.
  assert.ok(stats.links.long / stats.links.n > 0.85, 'links: rain jackets');
  assert.ok(((stats.links.hats[2] || 0) + (stats.links.hats[4] || 0)) / stats.links.n > 0.35, 'links: bucket hats and flat caps');
  for (const th of ['tropical', 'desert']) {
    assert.ok(stats[th].para / stats[th].n > 0.05, `${th}: parasols`);
    assert.ok((stats[th].hats[3] || 0) / stats[th].n > 0.2, `${th}: sun hats`);
    assert.ok(stats[th].shorts / stats[th].n > 0.4, `${th}: shorts`);
  }
  assert.deepEqual(unpackColor(packColor([1, 0.5, 0])).map((v) => Math.round(v * 255)), [255, 128, 0]);
});

// ------------------------------------------------------------------ reactions
const PINES2 = HOLES.find((q) => q.c.id === 'pines' && q.def.n === 2).t; // par 3
const PINES1 = HOLES.find((q) => q.c.id === 'pines' && q.def.n === 1).t; // par 4

function fakeShot(t, { putt = true, from, final, events = [], holed = false, strokes = 2, outcome = 'rest', waterEntry = null } = {}) {
  const cup = t.cup;
  const f = final || cup;
  return {
    from: from || { x: cup.x + 5, y: cup.y, z: cup.z },
    launch: { mode: putt ? 'roll' : 'air' },
    result: { events: [{ type: 'launch', t: 0 }, ...events, { type: 'rest', t: 5, x: f.x, y: f.y }], final: { ...f, outcome }, waterEntry },
    resolution: { holed, strokes, outcome },
  };
}
const kinds = (plan) => plan.map((p) => `${p.on}:${REACT_NAMES[p.type]}`);

test('reaction mapping from shot outcomes', () => {
  const t = PINES2;
  const cup = t.cup;
  const holedAt = [{ type: 'cup', t: 3 }];
  // Holed: birdie (2 on a par 3) cheers, par applauds, a long par putt cheers, an ace roars.
  assert.deepEqual(kinds(planReactions(fakeShot(t, { holed: true, strokes: 2, events: holedAt }), { terrain: t, par: 3 })), ['cup:cheer']);
  assert.deepEqual(kinds(planReactions(fakeShot(t, { holed: true, strokes: 3, events: holedAt }), { terrain: t, par: 3 })), ['cup:clap']);
  const long = fakeShot(t, { holed: true, strokes: 3, events: holedAt, from: { x: cup.x + 9, y: cup.y, z: cup.z } });
  assert.deepEqual(kinds(planReactions(long, { terrain: t, par: 3 })), ['cup:cheer']);
  const ace = planReactions(fakeShot(t, { putt: false, holed: true, strokes: 1, events: holedAt, from: t.tee }), { terrain: t, par: 3 });
  assert.equal(ace[0].type, REACT.cheer);
  assert.equal(ace[0].strength, 1);
  assert.equal(ace[0].why, 'ace');
  // A lip-out and a near miss: 'ooh'.
  const lip = fakeShot(t, { events: [{ type: 'lipout', t: 2 }], final: { x: cup.x + 0.3, y: cup.y, z: cup.z } });
  assert.deepEqual(kinds(planReactions(lip, { terrain: t, par: 3 })), ['lipout:ooh']);
  const near = fakeShot(t, { from: { x: cup.x + 6, y: cup.y, z: cup.z }, final: { x: cup.x + 0.2, y: cup.y, z: cup.z } });
  assert.deepEqual(kinds(planReactions(near, { terrain: t, par: 3 })), ['rest:ooh']);
  // Water and OB: a groan.
  const wet = fakeShot(t, { putt: false, outcome: 'water', from: t.tee, events: [{ type: 'water', t: 4 }], waterEntry: { x: cup.x - 20, y: cup.y } });
  assert.deepEqual(kinds(planReactions(wet, { terrain: t, par: 3 })), ['water:groan']);
  const ob = fakeShot(t, { putt: false, outcome: 'ob', from: t.tee });
  assert.deepEqual(kinds(planReactions(ob, { terrain: t, par: 3 })), ['rest:groan']);
  // A tee shot that stops close: 'ooh' then the applause, and the tee gallery's "good shot".
  const stiff = fakeShot(t, { putt: false, from: t.tee, final: { x: cup.x + 0.8, y: cup.y, z: cup.z } });
  const ps = planReactions(stiff, { terrain: t, par: 3, fromTee: true });
  assert.deepEqual(kinds(ps), ['rest:ooh', 'rest:clap', 'launch:clap']);
  assert.ok(ps[1].delay > 0.5, 'the applause follows the ooh');
  // Onto the green further away: applause; a par-4 drive into the fairway: the tee gallery claps.
  const on = fakeShot(t, { putt: false, from: t.tee, final: { x: t.green.cx, y: t.green.cy, z: 0 } });
  assert.ok(kinds(planReactions(on, { terrain: t, par: 3 })).includes('rest:clap'));
  const t1 = PINES1;
  let fw = null;
  for (let s = 200; s < 260 && !fw; s += 2) {
    const p = t1.path.pointAt(s);
    if (t1.surfaceAt(p.x, p.y) === SURF.FAIRWAY) fw = { x: p.x, y: p.y, z: t1.heightAt(p.x, p.y) };
  }
  const drive = fakeShot(t1, { putt: false, from: t1.tee, final: fw });
  assert.deepEqual(kinds(planReactions(drive, { terrain: t1, par: 4, fromTee: true })), ['launch:clap', 'rest:clap']);
  // A plain miss earns nothing.
  const miss = fakeShot(t, { from: { x: cup.x + 4, y: cup.y, z: cup.z }, final: { x: cup.x + 1.5, y: cup.y, z: cup.z } });
  assert.deepEqual(planReactions(miss, { terrain: t, par: 3 }), []);
});

test('CrowdReactions: events start the planned reactions, two slots, attention point', () => {
  const t = PINES2;
  const cup = t.cup;
  const cr = new CrowdReactions();
  const shot = fakeShot(t, { holed: true, strokes: 2, events: [{ type: 'cup', t: 3 }] });
  cr.startShot(shot, { terrain: t, par: 3 });
  cr.shotEvent({ type: 'launch' }, 10);
  cr.update(10, cup, 1 / 60);
  assert.equal(cr.fired.length, 0);
  assert.equal(cr.state(10).name, 'idle');
  cr.shotEvent({ type: 'cup' }, 12);
  cr.update(12, cup, 1 / 60);
  assert.equal(cr.fired.length, 1);
  assert.equal(cr.state(12.5).name, 'cheer');
  assert.equal(cr.u[0], REACT.cheer);
  assert.equal(cr.u[1], 12);
  assert.ok(Math.abs(cr.u[2] - cup.x) < 1e-3 && Math.abs(cr.u[3] - cup.y) < 1e-3);
  cr.update(12.1, cup, 1 / 60);
  assert.equal(cr.fired.length, 0, 'fired once');
  // Each event starts its reaction once.
  cr.shotEvent({ type: 'cup' }, 13);
  cr.update(13, cup, 1 / 60);
  assert.equal(cr.fired.length, 0);
  // A new reaction moves the old one to slot B, cut short to fade out.
  cr.trigger(REACT.clap, { x: 1, y: 2, strength: 0.5, dur: 3 }, 14);
  assert.equal(cr.u[0], REACT.clap);
  assert.equal(cr.u[8], REACT.cheer);
  assert.ok(cr.u[14] <= 14 - 12 + 0.6 + 1e-6, 'old reaction cut short');
  assert.equal(cr.state(14.2).name, 'clap');
  assert.equal(cr.state(30).name, 'idle');
  // Delayed plan items wait.
  const stiff = fakeShot(t, { putt: false, from: t.tee, final: { x: cup.x + 0.8, y: cup.y, z: cup.z } });
  cr.startShot(stiff, { terrain: t, par: 3 });
  cr.shotEvent({ type: 'rest' }, 40);
  cr.update(40, cup, 1 / 60);
  assert.equal(cr.state(40.1).name, 'ooh');
  cr.update(40.5, cup, 1 / 60);
  assert.equal(cr.state(40.6).name, 'ooh');
  cr.update(41.3, cup, 1 / 60);
  assert.equal(cr.state(41.4).name, 'clap');
  assert.deepEqual(cr.log.slice(-2).map((q) => q.why), ['so close', 'stiff']);
  // Attention: snaps to a new ball far away, eases toward a moving one.
  cr.update(50, { x: 500, y: 0, z: 0 }, 1 / 60);
  assert.equal(cr.look[0], 500);
  cr.update(50.02, { x: 510, y: 0, z: 0 }, 1 / 60);
  assert.ok(cr.look[0] > 500 && cr.look[0] < 510);
  cr.reset();
  assert.equal(cr.u[0], 0);
  assert.equal(cr.state(60).name, 'idle');
});

// ------------------------------------------------------------------ meshes and shaders
test('person mesh: <= 180 triangles, valid parts, slots and normals', () => {
  const m = personMesh();
  assert.ok(m.tris <= 180, `${m.tris} triangles`);
  assert.ok(m.tris >= 120);
  const nv = m.pos.length / 3;
  for (const i of m.idx) assert.ok(i < nv);
  for (let v = 0; v < nv; v++) {
    const n = Math.hypot(m.nrm[v * 3], m.nrm[v * 3 + 1], m.nrm[v * 3 + 2]);
    assert.ok(Math.abs(n - 1) < 1e-5);
    const part = m.attr[v * 4];
    const slot = m.attr[v * 4 + 1];
    assert.ok(Number.isInteger(part) && part >= 0 && part <= PART.PARASOL);
    assert.ok(Number.isInteger(slot) && slot >= 0 && slot <= 9);
  }
  // Standing figure: feet on the ground, head at about 1.75 m (hat and parasol are shaped later).
  let zMin = Infinity;
  let zMax = -Infinity;
  for (let v = 0; v < nv; v++) {
    const part = m.attr[v * 4];
    if (part === PART.HAT || part === PART.PARASOL) continue;
    zMin = Math.min(zMin, m.pos[v * 3 + 2]);
    zMax = Math.max(zMax, m.pos[v * 3 + 2]);
  }
  assert.ok(Math.abs(zMin) < 0.01 && Math.abs(zMax - 1.745) < 0.02, `${zMin} .. ${zMax}`);
});

test('skeleton: each pose puts the hands where it should (and the shader uses the same numbers)', () => {
  const wrist = (arm) => posePerson({ aL: arm[0], phiL: arm[1], bL: arm[2], twL: arm[3] }, PART.FARM_L, [0, PJ.SHOULDER_Y, PJ.WRIST_Z]);
  for (const k of Object.keys(POSE_WRIST)) {
    const w = wrist(POSES[k]);
    const d = Math.hypot(w[0] - POSE_WRIST[k][0], w[1] - POSE_WRIST[k][1], w[2] - POSE_WRIST[k][2]);
    assert.ok(d < 0.13, `${k}: wrist ${w.map((v) => v.toFixed(2))} ${d.toFixed(3)} m off`);
  }
  assert.ok(wrist(POSES.cheer)[2] > 1.85, 'cheer: hands above the head');
  assert.ok(Math.abs(wrist(POSES.clapShut)[1]) < 0.09 && wrist(POSES.clapShut)[0] > 0.2, 'clap: hands meet in front');
  const ooh = wrist(POSES.ooh);
  assert.ok(Math.hypot(ooh[0], ooh[1], ooh[2] - PJ.HEAD_Z) < 0.2, 'ooh: hands on the head');
  // The right arm mirrors the left.
  const r = posePerson({ aR: POSES.cheer[0], phiR: POSES.cheer[1], bR: POSES.cheer[2], twR: POSES.cheer[3] }, PART.FARM_R, [0, -PJ.SHOULDER_Y, PJ.WRIST_Z]);
  const l = wrist(POSES.cheer);
  assert.ok(Math.abs(r[0] - l[0]) < 1e-9 && Math.abs(r[1] + l[1]) < 1e-9 && Math.abs(r[2] - l[2]) < 1e-9);
  // Seated: feet on the floor, the hips on a 0.42 m bench.
  const foot = posePerson({ sit: 1 }, PART.SHIN_L, [0.2, PJ.HIP_Y, 0]);
  assert.ok(Math.abs(foot[2]) < 1e-9 && foot[0] > 0.5);
  const hip = posePerson({ sit: 1 }, PART.PELVIS, [0, 0, 0.84]);
  assert.ok(Math.abs(hip[2] - 0.42) < 1e-9);
  // The shader carries the same skeleton and poses.
  for (const v of [PJ.HIP_Z, PJ.SHOULDER_Y, PJ.ELBOW_Z, POSES.ooh[0], POSES.clapShut[3]]) assert.ok(CROWD_VS.includes(String(v)), `shader has ${v}`);
  for (const src of [CROWD_VS, CROWD_FS, CROWD_PROP_VS]) assert.ok(!/\$\{/.test(src), 'no unfilled template');
  assert.ok(/uniform vec4 uReact\[4\]/.test(CROWD_VS) && /playFade/.test(CROWD_PROP_VS));
});

test('furniture: ropes, stakes and grandstand in one mesh within budget; total crowd triangles on Full', () => {
  const person = personMesh();
  for (const { c, def, L } of HOLES) {
    const f = furnitureMesh(L, { theme: c.theme });
    const nv = f.pos.length / 3;
    assert.ok(nv < 65536);
    for (const i of f.idx) assert.ok(i < nv);
    assert.equal(f.col.length, nv * 4);
    assert.ok(f.tris > 200 && f.tris < 4000, `${c.id} ${def.n}: furniture ${f.tris} triangles`);
    const total = f.tris + L.nFull * person.tris;
    assert.ok(total <= 43000, `${c.id} ${def.n}: ${total} crowd triangles on Full`);
    assert.ok(f.tris + L.nLight * person.tris <= 22000);
  }
});

test('baked shadows: darken the ground under the shown people only', () => {
  const { t, L } = HOLES.find((q) => q.c.id === 'pines' && q.def.n === 2);
  const bake = bakeTerrainColor(t, {});
  const sun = { x: -0.6, y: -0.4, z: 0.69 };
  const none = crowdShadowBake(bake, L, 0, sun);
  assert.deepEqual(none, bake.data);
  const full = crowdShadowBake(bake, L, L.nFull, sun);
  const light = crowdShadowBake(bake, L, L.nLight, sun);
  const darker = (d) => {
    let n = 0;
    for (let k = 0; k < d.length; k += 4) if (d[k] < bake.data[k]) n++;
    return n;
  };
  assert.ok(darker(full) > darker(light) && darker(light) > 0);
  // Never brighter, alpha (mowing mask) untouched.
  for (let k = 0; k < full.length; k++) {
    if (k % 4 === 3) assert.equal(full[k], bake.data[k]);
    else assert.ok(full[k] <= bake.data[k]);
  }
  // The texel under a standing person is darkened (the shadow starts at the feet).
  let p = null;
  for (let i = 0; i < L.nFull && !p; i++) if (L.people[i * PERSON_FLOATS + 6] % 2 < 1) p = i;
  const x = L.people[p * PERSON_FLOATS] + 0.4 * 0.83;
  const y = L.people[p * PERSON_FLOATS + 1] + 0.4 * 0.55;
  const k = (Math.floor((y - bake.minY) / bake.step) * bake.width + Math.floor((x - bake.minX) / bake.step)) * 4;
  assert.ok(full[k] < bake.data[k]);
});
