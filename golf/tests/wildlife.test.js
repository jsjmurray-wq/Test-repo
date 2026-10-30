// Wildlife (docs/architecture.md section 10): species meshes, placement per hole and course, the
// behaviour state machine (bounded, returns after fleeing), the flee triggers (a landing ball, the
// golfer, a cheer), the address view corridor, determinism and the allocation-free frame.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COURSES } from '../src/courses.js';
import { buildHole } from '../src/terrain.js';
import { SURF } from '../src/constants.js';
import { mulberry32 } from '../src/rng.js';
import {
  Wildlife, FAUNA, SPECIES, themeSlots, wildlifeSeed, inCorridor, MAX_ANIMALS, INST_FLOATS, SHADOW_FLOATS, ST,
} from '../src/wildlife.js';
import { buildCrowd, crowdSeed, PERSON_FLOATS } from '../src/crowd.js';
import { SPECIES_MESHES, MESH_PARAMS, buildSpeciesMesh, wildlifeMesh, KIND, PART, MAX_SLOTS, SLOT_FLOATS } from '../src/wildlife-mesh.js';

// Every hole of every course, built once (the same pins and tree seed as the game).
const HOLES = [];
for (const c of COURSES) for (let i = 0; i < c.holes.length; i++) HOLES.push({ course: c, i, t: buildHole(c.holes[i], { pinIndex: 0, seed: 1, course: c }) });
const holeOf = (id, n) => HOLES.find((h) => h.course.id === id && h.i === n - 1).t;
const inst = new Float32Array(MAX_ANIMALS * INST_FLOATS);
const shadow = new Float32Array(MAX_ANIMALS * SHADOW_FLOATS);
const run = (w, seconds, ctx = null, dt = 1 / 30) => {
  for (let k = 0; k < Math.round(seconds / dt); k++) w.update(dt, ctx);
};
const groupOf = (w, i) => w.snapshot().filter((a) => a.group === w.grp[i]);

test('species meshes: 80-400 triangles each, valid indices, finite data, unit normals, parts', () => {
  for (const id of SPECIES_MESHES) {
    const m = buildSpeciesMesh(id);
    assert.ok(m.tris >= 80 && m.tris <= 400, `${id}: ${m.tris} triangles`);
    assert.ok(MESH_PARAMS[id], `${id} has animation constants`);
    for (const k of m.idx) assert.ok(k < m.verts, `${id}: index in range`);
    for (const arr of [m.pos, m.alt, m.piv, m.anim, m.nrm]) for (const v of arr) assert.ok(Number.isFinite(v), `${id}: finite`);
    for (let i = 0; i < m.verts; i++) {
      for (const o of [0, 2]) {
        const u = m.nrm[i * 4 + o];
        const v = m.nrm[i * 4 + o + 1];
        assert.ok(Math.abs(u) + Math.abs(v) <= 1.0001 + 1, `${id}: octahedral normal in range`);
      }
      const part = m.anim[i * 4];
      assert.ok(Object.values(PART).includes(part), `${id}: part ${part}`);
      const col = m.anim[i * 4 + 3];
      assert.ok(col >= 0 && col <= 0xffffff && Number.isInteger(col), `${id}: packed colour`);
    }
    // Feet on the ground: the rest pose reaches down to about z = 0 and not far below it.
    let minZ = Infinity;
    for (let i = 0; i < m.verts; i++) minZ = Math.min(minZ, m.alt[i * 3 + 2]);
    assert.ok(minZ > -0.05 && minZ < 0.05, `${id}: lowest point ${minZ.toFixed(3)} m`);
    // Birds have two wings and two legs; mammals four legs (or sprawled ones).
    const parts = new Set();
    for (let i = 0; i < m.verts; i++) parts.add(m.anim[i * 4]);
    if (MESH_PARAMS[id].kind === KIND.BIRD) for (const p of [PART.WING_L, PART.WING_R, PART.LEG_FL, PART.LEG_FR, PART.HEAD, PART.TAIL]) assert.ok(parts.has(p), `${id}: part ${p}`);
    else if (MESH_PARAMS[id].kind === KIND.SPRAWLER) for (const p of [PART.SPRAWL_FL, PART.SPRAWL_HR, PART.SPRAWL_TAIL]) assert.ok(parts.has(p), `${id}: part ${p}`);
    else for (const p of [PART.LEG_FL, PART.LEG_FR, PART.LEG_HL, PART.LEG_HR, PART.HEAD]) assert.ok(parts.has(p), `${id}: part ${p}`);
  }
});

test('folded wings keep their upper side facing out (rest pose normals of the top layer)', () => {
  // Wing vertices whose flight normal faces up (the top layer) face away from the body at rest.
  const oct = (u, v) => {
    let x = u;
    let y = v;
    const z = 1 - Math.abs(u) - Math.abs(v);
    if (z < 0) {
      x = (1 - Math.abs(v)) * Math.sign(u || 1);
      y = (1 - Math.abs(u)) * Math.sign(v || 1);
    }
    const l = Math.hypot(x, y, z);
    return [x / l, y / l, z / l];
  };
  for (const id of ['goose', 'kittiwake', 'heron', 'mallardDrake', 'parrot']) {
    const m = buildSpeciesMesh(id);
    let out = 0;
    let all = 0;
    for (let i = 0; i < m.verts; i++) {
      const part = m.anim[i * 4];
      if (part !== PART.WING_L && part !== PART.WING_R) continue;
      const nA = oct(m.nrm[i * 4], m.nrm[i * 4 + 1]);
      if (nA[2] < 0.5) continue; // the underside layer
      const nB = oct(m.nrm[i * 4 + 2], m.nrm[i * 4 + 3]);
      const side = part === PART.WING_L ? 1 : -1;
      all++;
      if (nB[1] * side > 0) out++;
    }
    assert.ok(out / all > 0.8, `${id}: ${out}/${all} folded top-layer normals face out`);
  }
});

test('theme meshes: the slot list, one buffer per theme, uniform table', () => {
  for (const theme of Object.keys(FAUNA)) {
    const slots = themeSlots(theme);
    assert.ok(slots.length > 0 && slots.length <= MAX_SLOTS, `${theme}: ${slots.length} slots`);
    const w = wildlifeMesh(slots);
    assert.ok(w.verts < 65536);
    assert.equal(w.params.length, slots.length * SLOT_FLOATS);
    assert.equal(w.slotTris.length, slots.length);
    // Every vertex knows its slot, in order.
    let last = 0;
    for (let i = 0; i < w.verts; i++) {
      const s = w.anim[i * 4 + 2];
      assert.ok(s >= last && s < slots.length);
      last = s;
    }
    for (const k of w.idx) assert.ok(k < w.verts);
    // Every species of the theme has its meshes.
    for (const sp of FAUNA[theme]) for (const [m] of SPECIES[sp].variants) assert.ok(slots.includes(m), `${theme}: ${m}`);
  }
});

test('placement: every hole has animals of its theme, under 40, in their habitats', () => {
  for (const { course, i, t } of HOLES) {
    const w = new Wildlife(t);
    const tag = `${course.id} ${i + 1}`;
    assert.ok(w.n > 0 && w.n < 40, `${tag}: ${w.n} animals`);
    const theme = FAUNA[t.theme] ? t.theme : 'parkland';
    const snap = w.snapshot();
    for (const a of snap) {
      assert.ok(FAUNA[theme].includes(a.species), `${tag}: ${a.species} belongs to ${theme}`);
      const S = SPECIES[a.species];
      const surf = t.surfaceAt(a.x, a.y);
      // Nothing on a green, fringe or tee, ever.
      if (a.vis > 0 && a.mode !== 'soar' && a.mode !== 'hover' && a.mode !== 'pass' && a.mode !== 'perch') {
        assert.ok(![SURF.GREEN, SURF.FRINGE, SURF.TEE].includes(surf), `${tag}: ${a.species} on surface ${surf}`);
      }
      if (a.state === 'SWIM') {
        assert.equal(surf, SURF.WATER, `${tag}: ${a.species} swims on water`);
        const lv = t.waterAt(a.x, a.y).level;
        assert.ok(Math.abs(a.z - (lv - MESH_PARAMS[a.mesh].draft)) < 0.03, `${tag}: ${a.species} floats at the water line`);
      }
      if (S.mode === 'wade') {
        assert.equal(surf, SURF.WATER, `${tag}: ${a.species} wades in water`);
        const d = t.waterAt(a.x, a.y).level - t.heightAt(a.x, a.y);
        assert.ok(d > 0 && d < 0.6, `${tag}: ${a.species} in shallows (${d.toFixed(2)} m)`);
      }
      if (a.species === 'deer') {
        const near = t.treesNear(a.x, a.y, 15).filter((o) => (o.kind === 'pine' || o.kind === 'broad' || o.kind === 'palm') && Math.hypot(o.x - a.x, o.y - a.y) < 15);
        assert.ok(near.length > 0, `${tag}: deer at the woods' edge`);
      }
      if (a.species === 'lizard') {
        const rock = (t.trees || []).some((o) => o.kind === 'rock' && Math.hypot(o.x - a.x, o.y - a.y) < o.trunkR && a.z > o.z + 0.3);
        assert.ok(rock, `${tag}: chuckwalla on a rock`);
      }
      if (a.species === 'sheep') assert.ok(t.path.project(a.x, a.y).dist > 50, `${tag}: sheep in the far dunes`);
      // Beyond its comfort distance from the tee: the first address does not flush it.
      if (S.golferR && a.vis > 0) assert.ok(Math.hypot(a.x - t.tee.x, a.y - t.tee.y) > S.golferR, `${tag}: ${a.species} clear of the tee`);
    }
  }
  // Each theme's species all appear somewhere on their course.
  for (const c of COURSES) {
    const seen = new Set();
    for (const h of HOLES.filter((q) => q.course === c)) for (const a of new Wildlife(h.t).snapshot()) seen.add(a.species);
    for (const sp of FAUNA[c.theme]) assert.ok(seen.has(sp), `${c.id}: ${sp} appears`);
  }
});

test('state machine: bounded, finite and inside the hole for 3 minutes of events on every course', () => {
  for (const id of ['pines', 'desert', 'water', 'links']) {
    for (const n of [2, 5, 9]) {
      const t = holeOf(id, n);
      const w = new Wildlife(t, { wind: { x: 5, y: -2 } });
      const rng = mulberry32(n * 7 + id.length);
      const b = t.bounds;
      const ctx = { golfer: true, gx: t.tee.x, gy: t.tee.y, address: true, bx: t.tee.x, by: t.tee.y, yaw: Math.atan2(t.cup.y - t.tee.y, t.cup.x - t.tee.x), carry: 220, wx: 5, wy: -2 };
      for (let s = 0; s < 180; s++) {
        run(w, 1, ctx);
        if (s % 9 === 4 && w.n) {
          const k = Math.floor(rng() * w.n);
          w.ballLanded(w.x[k] + rng() * 10 - 5, w.y[k] + rng() * 10 - 5);
        }
        if (s % 40 === 20) w.cheer(t.cup.x, t.cup.y, 1);
        if (s % 30 === 15) {
          // The golfer walks on: a new address spot down the hole.
          const p = t.path.pointAt(Math.min(t.lengthM, (s / 180) * t.lengthM));
          ctx.gx = ctx.bx = p.x;
          ctx.gy = ctx.by = p.y;
        }
        const cnt = w.write(inst, shadow);
        for (let q = 0; q < cnt * INST_FLOATS; q++) assert.ok(Number.isFinite(inst[q]), `${id} ${n}: finite instance data`);
        for (let q = 0; q < w.shadowCount * SHADOW_FLOATS; q++) assert.ok(Number.isFinite(shadow[q]), `${id} ${n}: finite shadow data`);
      }
      for (const a of w.snapshot()) {
        for (const v of [a.x, a.y, a.z, a.yaw]) assert.ok(Number.isFinite(v), `${id} ${n}: ${a.species} finite`);
        // (Birds that flew off may be out of sight beyond the hole until they come back.)
        const pad = SPECIES[a.species].flight || a.vis <= 0 ? 420 : 1;
        assert.ok(a.x > b.minX - pad && a.x < b.maxX + pad && a.y > b.minY - pad && a.y < b.maxY + pad, `${id} ${n}: ${a.species} (${a.state}) inside the hole`);
        if (a.mode === 'ground' && a.vis > 0 && !['CLIMB', 'FLY', 'TAKEOFF', 'LAND'].includes(a.state)) assert.ok(Math.abs(a.z - t.heightAt(a.x, a.y)) < 1.5 || a.species === 'lizard', `${id} ${n}: ${a.species} on the ground`);
      }
    }
  }
});

test('flee triggers: a landing ball flushes a flock together; one far away does not', () => {
  const t = holeOf('pines', 2);
  const w = new Wildlife(t);
  const duck = w.snapshot().find((a) => a.species === 'mallard' && a.state === 'SWIM');
  assert.ok(duck, 'mallards on the pond');
  // Far away: nothing.
  w.ballLanded(duck.x + 120, duck.y);
  run(w, 0.6);
  assert.ok(groupOf(w, duck.i).every((a) => a.state === 'SWIM'), 'a landing 120 m away leaves them');
  // 8 m away: the whole group takes off within half a second, wings spreading, gaining height.
  w.ballLanded(duck.x + 6, duck.y + 5);
  run(w, 0.6);
  const g = groupOf(w, duck.i);
  assert.ok(g.every((a) => a.state === 'TAKEOFF' || a.state === 'FLY'), `the flock takes off (${g.map((a) => a.state)})`);
  run(w, 1.5);
  for (const a of groupOf(w, duck.i)) {
    assert.ok(a.fly > 0.8, 'wings out');
    assert.ok(a.z > a.home.z + 1, `climbing (${(a.z - a.home.z).toFixed(1)} m)`);
  }
  assert.ok(w.stats.flushes >= 1 && w.stats.landings === 2);
  // A splash in the pond near the heron reaches a little further.
  const heron = w.snapshot().find((a) => a.species === 'heron');
  if (heron) {
    w.ballLanded(heron.x + 30, heron.y, SURF.WATER);
    run(w, 0.6);
    assert.ok(['TAKEOFF', 'FLY'].includes(w.snapshot()[heron.i].state), 'a splash 30 m off flushes the heron');
  }
});

test('flee triggers: the golfer walking up and a crowd cheer', () => {
  const t = holeOf('pines', 7);
  const w = new Wildlife(t);
  const deer = w.snapshot().find((a) => a.species === 'deer');
  assert.ok(deer, 'deer on Hollow Pines 7');
  const ctx = { golfer: true, gx: deer.x + 20, gy: deer.y + 12, address: false, wx: 0, wy: 0 };
  run(w, 0.8, ctx);
  const g = groupOf(w, deer.i);
  assert.ok(g.every((a) => a.state === 'RUN' || a.state === 'STARTLE'), `the deer bolt (${g.map((a) => a.state)})`);
  // They run for the trees, white flags up.
  run(w, 1, ctx);
  const d = w.snapshot()[deer.i];
  assert.ok(Math.hypot(d.x - ctx.gx, d.y - ctx.gy) > Math.hypot(deer.x - ctx.gx, deer.y - ctx.gy), 'away from the golfer');
  // A cheer at a pond lifts the waterfowl; one at the far end of another hole does not.
  const t2 = holeOf('pines', 9);
  const w2 = new Wildlife(t2);
  const duck = w2.snapshot().find((a) => a.state === 'SWIM');
  w2.cheer(duck.x + 400, duck.y + 400, 1);
  run(w2, 0.6);
  assert.equal(w2.snapshot()[duck.i].state, 'SWIM', 'a distant cheer: still swimming');
  w2.cheer(duck.x + 30, duck.y, 1);
  run(w2, 0.6);
  assert.ok(['TAKEOFF', 'FLY'].includes(w2.snapshot()[duck.i].state), 'a cheer 30 m away: up they go');
  assert.equal(w2.stats.cheers, 2);
});

test('returns after fleeing: deer, ducks, squirrels, rabbits, lizards and quail come back', () => {
  const cases = [['pines', 7, 'deer'], ['pines', 2, 'mallard'], ['pines', 1, 'squirrel'], ['links', 2, 'rabbit'], ['desert', 2, 'lizard'], ['desert', 2, 'quail'], ['water', 1, 'flamingo']];
  for (const [id, n, sp] of cases) {
    const t = holeOf(id, n);
    const w = new Wildlife(t);
    const a = w.snapshot().find((q) => q.species === sp);
    assert.ok(a, `${sp} on ${id} ${n}`);
    w.ballLanded(a.x + 2, a.y + 1);
    run(w, 0.8);
    const s1 = w.snapshot()[a.i].state;
    assert.notEqual(s1, a.state, `${sp} reacts (${a.state} -> ${s1})`);
    run(w, 150);
    const b = w.snapshot()[a.i];
    assert.ok(b.vis > 0, `${sp} visible again`);
    assert.ok(['IDLE', 'GRAZE', 'WALK', 'ALERT', 'SWIM', 'BASK'].includes(b.state), `${sp} back to its routine (${b.state})`);
    const home = Math.hypot(b.x - b.home.x, b.y - b.home.y);
    assert.ok(home < SPECIES[sp].roam + 12, `${sp} near home (${home.toFixed(1)} m)`);
  }
});

test('address: nothing in the view corridor or at the golfer after the cut; animals walk out of a new aim', () => {
  let checked = 0;
  for (const { t, course, i } of HOLES) {
    const w = new Wildlife(t);
    // The tee, then two spots down the hole (each a cut to a new address).
    for (const f of [0, 0.45, 0.8]) {
      const p = t.path.pointAt(f * t.lengthM);
      const ctx = { golfer: true, gx: p.x, gy: p.y, address: true, bx: p.x, by: p.y, yaw: Math.atan2(t.cup.y - p.y, t.cup.x - p.x), carry: 180, wx: 0, wy: 0 };
      w.update(1 / 60, ctx);
      const c = { bx: p.x, by: p.y, dx: Math.cos(ctx.yaw), dy: Math.sin(ctx.yaw), len: 180 };
      for (const a of w.snapshot()) {
        if (a.vis <= 0 || a.mode === 'soar' || a.mode === 'pass' || a.mode === 'perch' || a.state === 'FLY' || a.state === 'TAKEOFF') continue;
        const S = SPECIES[a.species];
        if (a.mode === 'hover') {
          if (a.z - t.heightAt(a.x, a.y) < 24) assert.ok(!inCorridor(c, a.x, a.y) || Math.hypot(a.x - p.x, a.y - p.y) > 150, `${course.id} ${i + 1}: gull hanging in the corridor`);
          continue;
        }
        assert.ok(!inCorridor(c, a.x, a.y), `${course.id} ${i + 1} @${f}: ${a.species} (${a.state}) in the view corridor`);
        if (S.golferR) assert.ok(Math.hypot(a.x - p.x, a.y - p.y) > S.golferR * 0.7, `${course.id} ${i + 1}: ${a.species} next to the golfer`);
        checked++;
      }
    }
  }
  assert.ok(checked > 300, `${checked} animal checks`);
  // Turning the aim onto grazing animals sends them walking out to the side.
  const t = holeOf('links', 2);
  const w = new Wildlife(t);
  const r = w.snapshot().find((a) => a.species === 'rabbit');
  const gx = r.x - 40;
  const gy = r.y;
  const ctx = { golfer: true, gx: gx - 200, gy, address: true, bx: gx, by: gy, yaw: 0.6, carry: 120, wx: 0, wy: 0 };
  ctx.golfer = false;
  w.update(1 / 60, ctx); // (the cut: the corridor points away from the rabbit)
  ctx.yaw = 0;
  run(w, 25, ctx);
  const c = { bx: gx, by: gy, dx: 1, dy: 0, len: 120 };
  for (const a of groupOf(w, r.i)) if (a.vis > 0) assert.ok(!inCorridor(c, a.x, a.y), 'out of the new aim line');
});

test('determinism: the same seed and dt sequence give the same animals; another seed differs', () => {
  const t = holeOf('water', 1);
  const ctx = { golfer: true, gx: t.tee.x, gy: t.tee.y, address: true, bx: t.tee.x, by: t.tee.y, yaw: 0.3, carry: 200, wx: 3, wy: 1 };
  const sim = (seed) => {
    const w = new Wildlife(t, { seed });
    for (let k = 0; k < 1800; k++) {
      if (k === 300) w.ballLanded(w.x[0] + 4, w.y[0]);
      if (k === 900) w.cheer(t.cup.x, t.cup.y, 0.8);
      w.update(k % 3 ? 1 / 60 : 1 / 30, ctx);
    }
    const out = new Float32Array(MAX_ANIMALS * INST_FLOATS);
    const n = w.write(out, null);
    return { n, out: Array.from(out.subarray(0, n * INST_FLOATS)) };
  };
  const a = sim(wildlifeSeed(t));
  const b = sim(wildlifeSeed(t));
  assert.equal(a.n, b.n);
  assert.deepEqual(a.out, b.out);
  const c = sim(12345);
  assert.notDeepEqual(a.out, c.out);
  // The hole's own seed depends on course and hole.
  assert.notEqual(wildlifeSeed(holeOf('pines', 1)), wildlifeSeed(holeOf('pines', 2)));
  assert.notEqual(wildlifeSeed(holeOf('pines', 1)), wildlifeSeed(holeOf('desert', 1)));
});

test('gulls hang into the wind; hawks circle; pelicans glide in line', () => {
  const t = holeOf('links', 2);
  const w = new Wildlife(t, { wind: { x: 6, y: 0 } });
  run(w, 8, { golfer: false, address: false, wx: 6, wy: 0 });
  const gulls = w.snapshot().filter((a) => a.species === 'gull');
  assert.ok(gulls.length >= 3);
  for (const g of gulls) {
    assert.equal(g.state, 'HOVER');
    const into = Math.cos(g.yaw - Math.PI); // the wind blows toward +x: face -x
    assert.ok(into > 0.85, `facing into the wind (${g.yaw.toFixed(2)})`);
    assert.ok(Math.hypot(g.x - g.home.x, g.y - g.home.y) < 8, 'holding station');
    assert.ok(g.z - t.heightAt(g.x, g.y) > 5, 'over the dunes');
  }
  const hawkHole = holeOf('desert', 2);
  const wh = new Wildlife(hawkHole);
  const h0 = wh.snapshot().find((a) => a.species === 'hawk');
  run(wh, 10);
  const h1 = wh.snapshot()[h0.i];
  assert.equal(h1.state, 'SOAR');
  assert.ok(h1.z - hawkHole.heightAt(h1.x, h1.y) > 30, 'high on the thermal');
  assert.ok(Math.abs(wh.bank[h0.i]) > 0.1, 'banked into the circle');
  const pel = new Wildlife(holeOf('water', 1));
  run(pel, 1);
  const p = pel.snapshot().filter((a) => a.species === 'pelican');
  assert.ok(p.length >= 3);
  for (let k = 1; k < p.length; k++) assert.ok(Math.abs(p[k].yaw - p[0].yaw) < 1e-6 || Math.abs(Math.abs(p[k].yaw - p[0].yaw) - 2 * Math.PI) < 1e-6, 'same heading');
});

test('the frame allocates nothing: update and write after warm-up', async () => {
  const t = holeOf('pines', 9);
  const w = new Wildlife(t);
  const ctx = { golfer: true, gx: t.tee.x, gy: t.tee.y, address: true, bx: t.tee.x, by: t.tee.y, yaw: 0.2, carry: 200, wx: 2, wy: 1 };
  const out = { kind: '', x: 0, y: 0, z: 0 };
  let frames = 0;
  const seq = () => {
    for (let k = 0; k < 3000; k++) {
      w.update(1 / 60, ctx);
      w.write(inst, shadow);
      while (w.pollCall(out));
      frames++;
    }
  };
  seq();
  seq();
  const { Session } = await import('node:inspector/promises');
  const session = new Session();
  session.connect();
  await session.post('HeapProfiler.enable');
  await session.post('HeapProfiler.startSampling', { samplingInterval: 32 });
  frames = 0;
  seq();
  seq();
  const { profile } = await session.post('HeapProfiler.stopSampling');
  session.disconnect();
  let bytes = 0;
  const walk = (n, inside) => {
    const url = n.callFrame.url || '';
    const mine = inside || /wildlife\.js$/.test(url);
    if (mine && /(wildlife|terrain)\.js$/.test(url)) bytes += n.selfSize || 0;
    for (const c of n.children || []) walk(c, mine);
  };
  walk(profile.head, false);
  assert.ok(bytes / frames < 4, `${(bytes / frames).toFixed(2)} bytes per frame over ${frames} frames`);
});

test('corridor geometry', () => {
  const c = { bx: 0, by: 0, dx: 1, dy: 0, len: 150 };
  assert.ok(inCorridor(c, 50, 5));
  assert.ok(inCorridor(c, -20, 0), 'behind the ball (the camera)');
  assert.ok(!inCorridor(c, 50, 30), 'well to the side');
  assert.ok(!inCorridor(c, 250, 0), 'beyond the carry');
  assert.ok(ST.SWIM !== ST.FLY);
});

test('spectators: animals on foot, waders and bank geese keep clear of the galleries on every hole', () => {
  // (The game passes the hole's gallery, crowd.js buildCrowd, as `avoid`.)
  const clear = (S) => Math.max(6, Math.min(18, 0.45 * (S.golferR || 14)));
  const ctx = { golfer: false, gx: 0, gy: 0, address: false, bx: 0, by: 0, yaw: 0, carry: 0, wx: 0, wy: 0 };
  let animals = 0;
  let plain = 0;
  for (const { course, i, t } of HOLES) {
    const L = buildCrowd(t, { seed: crowdSeed(course.id, i + 1), theme: course.theme, finishing: (i + 1) % 9 === 0 });
    const w = new Wildlife(t, { avoid: { pts: L.people, n: L.nFull, stride: PERSON_FLOATS } });
    animals += w.n;
    plain += new Wildlife(t).n;
    const tag = `${course.id} ${i + 1}`;
    const check = (when) => {
      for (const a of w.snapshot()) {
        const S = SPECIES[a.species];
        if (!(a.vis > 0.3) || a.z - t.heightAt(a.x, a.y) > 1.5 || (S.mode === 'swim' && a.state === 'SWIM')) continue;
        if (S.mode !== 'ground' && S.mode !== 'wade' && !S.bank) continue;
        let md = Infinity;
        for (let k = 0; k < L.nFull; k++) md = Math.min(md, Math.hypot(L.people[k * PERSON_FLOATS] - a.x, L.people[k * PERSON_FLOATS + 1] - a.y));
        // (Home and wander spots keep the full distance; a group member or a walk can come a
        // little nearer.)
        assert.ok(md > clear(S) * 0.7, `${tag} ${when}: ${a.species} ${a.state} ${md.toFixed(1)} m from a spectator`);
      }
    };
    check('placed');
    run(w, 40, ctx);
    check('after 40 s');
  }
  // The galleries cost the courses hardly any animals.
  assert.ok(animals > plain * 0.9, `${animals} animals with the galleries, ${plain} without`);
});
