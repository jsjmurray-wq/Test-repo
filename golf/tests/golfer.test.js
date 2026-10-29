// The golfer character: skeleton, look schema, mesh and swing animation (docs section 9).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BONES, BONE_COUNT, B, BONE_PARENT, OPTIONS, DEFAULT_LOOK, PRESETS, presetById, normalizeLook, randomLook,
  lookKey, SKIN_TONES, HAIR_COLORS, CLOTH_COLORS, clubSpec, CLUB_SPECS, bodyDims,
} from '../src/golfer.js';
import { buildGolferMesh } from '../src/golfer-mesh.js';
import { SwingAnimator, placeGolfer, swingTiming, NP } from '../src/swing-anim.js';
import { CLUBS } from '../src/clubs.js';
import { BALL_R } from '../src/constants.js';
import { mulberry32 } from '../src/rng.js';

const CLUB_IDS = CLUBS.map((c) => c.id);
const HEIGHTS = [155, 175, 200];
const dist3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const finite = (arr) => arr.every((v) => Number.isFinite(v));

// Strike from address and step until onImpact: returns the club head at that frame.
function strikeToImpact(anim, power = 1, opts = {}) {
  let head = null;
  let calls = 0;
  let tAt = 0;
  const dt = 1 / 60;
  let t = 0;
  const T = anim.strike({ power, ...opts, onImpact: () => {
    calls++;
    head = anim.clubHeadWorld();
    tAt = t;
  } });
  for (let i = 0; i < 400 && anim.state !== 'finish'; i++) {
    t += dt;
    anim.update(dt);
  }
  return { head, calls, T, tAt };
}

test('skeleton: about 20 bones, parents precede children, club under the lead hand', () => {
  assert.equal(BONES.length, BONE_COUNT);
  assert.ok(BONE_COUNT >= 18 && BONE_COUNT <= 24);
  assert.equal(BONE_PARENT[B.pelvis], -1);
  for (let b = 1; b < BONE_COUNT; b++) assert.ok(BONE_PARENT[b] >= 0 && BONE_PARENT[b] < b, BONES[b]);
  assert.equal(BONE_PARENT[B.club], B.handL);
  const d = bodyDims({ height: 180 });
  // Rest segments lie straight along -Z (the IK frames rely on it).
  const J = (b) => [d.joints[b * 3], d.joints[b * 3 + 1], d.joints[b * 3 + 2]];
  for (const [a, b] of [[B.upperArmL, B.forearmL], [B.forearmL, B.handL], [B.thighR, B.shinR], [B.shinR, B.footR]]) {
    assert.ok(Math.abs(J(a)[0] - J(b)[0]) < 1e-9 && Math.abs(J(a)[1] - J(b)[1]) < 1e-9 && J(a)[2] > J(b)[2]);
  }
  // Realistic proportions: about 7.5-8 heads tall, shoulders wider than hips for a man.
  assert.ok(1.8 / d.headH > 7.3 && 1.8 / d.headH < 8.1, `${1.8 / d.headH} heads`);
  assert.ok(d.shoulderHalf > d.hipHalf * 1.8);
});

test('normalizeLook: defaults, every option, garbage', () => {
  assert.deepEqual(normalizeLook(undefined), { ...DEFAULT_LOOK });
  for (const g of [null, 42, 'x', [], NaN, () => 1, true, { body: 7, skin: 'red', height: 'tall', hair: {}, hairColor: 5, sunglasses: 'yes', headwear: null, shirtColor: '#zzzzzz', legColor: '#12345', swing: 'wild', extra: 1 }]) {
    const L = normalizeLook(g);
    assert.deepEqual(Object.keys(L).sort(), Object.keys(DEFAULT_LOOK).sort());
    assert.ok(OPTIONS.body.includes(L.body) && OPTIONS.hair.includes(L.hair) && OPTIONS.swing.includes(L.swing));
    assert.ok(L.height >= 155 && L.height <= 200 && Number.isInteger(L.skin) && L.skin >= 0 && L.skin < 8);
    for (const k of ['hairColor', 'hatColor', 'shirtColor', 'shirtColor2', 'legColor', 'shoeColor', 'gloveColor']) assert.match(L[k], /^#[0-9a-f]{6}$/);
    assert.equal(typeof L.sunglasses, 'boolean');
  }
  assert.equal(normalizeLook({ height: 999 }).height, 200);
  assert.equal(normalizeLook({ height: -5 }).height, 155);
  assert.equal(normalizeLook({ body: 'female' }).height, 168);
  assert.equal(normalizeLook({ body: 'female', facialHair: 'beard' }).facialHair, 'none');
  assert.equal(normalizeLook({ skin: 'deep' }).skin, 7);
  assert.equal(normalizeLook({ shirtColor: 'navy' }).shirtColor, CLOTH_COLORS.find((c) => c.id === 'navy').hex);
  assert.equal(normalizeLook({ hairColor: '#ABCDEF' }).hairColor, '#abcdef');
  assert.equal(SKIN_TONES.length, 8);
  assert.ok(HAIR_COLORS.length >= 6 && CLOTH_COLORS.length >= 12);
  // Idempotent and stable keys.
  const r = randomLook(mulberry32(3));
  assert.deepEqual(normalizeLook(r), r);
  assert.equal(lookKey(r), lookKey(normalizeLook(r)));
});

test('presets: 6-8 diverse looks, male and female, valid', () => {
  assert.ok(PRESETS.length >= 6 && PRESETS.length <= 8);
  assert.equal(new Set(PRESETS.map((p) => p.id)).size, PRESETS.length);
  assert.ok(PRESETS.some((p) => p.look.body === 'female') && PRESETS.some((p) => p.look.body === 'male'));
  assert.ok(new Set(PRESETS.map((p) => p.look.skin)).size >= 5);
  for (const p of PRESETS) {
    assert.deepEqual(normalizeLook(p.look), p.look);
    assert.ok(p.name && presetById(p.id) === p);
  }
  assert.equal(presetById('nope'), null);
  const rng = mulberry32(9);
  for (let i = 0; i < 30; i++) {
    const L = randomLook(rng);
    assert.deepEqual(normalizeLook(L), L);
  }
});

test('club specs: every club, fitted length, impact point on the face', () => {
  for (const id of CLUB_IDS) {
    const s = clubSpec(id, 1.8);
    assert.ok(CLUB_SPECS[id]);
    assert.ok(s.len > 0.8 && s.len < 1.25, id);
    assert.ok(Math.abs(Math.hypot(...s.faceN) - 1) < 1e-9);
    // The impact point is in front of the face (+X) and below the shaft's bottom.
    assert.ok(s.impact[0] > 0 && s.impact[2] < s.hosel[2] + 0.06);
  }
  assert.ok(clubSpec('D', 2.0).len > clubSpec('D', 1.55).len);
  assert.equal(clubSpec('wood').id, '3W');
  assert.equal(clubSpec({ id: 'SW' }).id, 'SW');
  assert.equal(clubSpec('garbage').id, '7i');
});

test('mesh: budgets, valid indices, bone ids and unit normals for every option', () => {
  const looks = [{ ...DEFAULT_LOOK }];
  for (const [k, list] of Object.entries(OPTIONS)) {
    if (k === 'height') continue;
    for (const v of list) looks.push({ ...DEFAULT_LOOK, [k]: v });
  }
  for (const s of [0, 3, 7]) looks.push({ ...DEFAULT_LOOK, skin: s, sunglasses: true, height: 155 + s * 6 });
  looks.push(...PRESETS.map((p) => p.look));
  // The heaviest combination of options.
  looks.push({ hair: 'long', headwear: 'bucket', shirt: 'striped', facialHair: 'beard', legwear: 'shorts', sunglasses: true, build: 'heavy', height: 200 });
  let maxTris = 0;
  let minTris = Infinity;
  for (const [i, L] of looks.entries()) {
    const club = CLUB_IDS[i % CLUB_IDS.length];
    const m = buildGolferMesh(L, club);
    const nv = m.pos.length / 3;
    assert.equal(m.nrm.length, nv * 3);
    assert.equal(m.col.length, nv * 3);
    assert.equal(m.bone.length, nv);
    assert.equal(m.mat.length, nv);
    assert.ok(m.idx instanceof Uint16Array && nv < 65536);
    assert.equal(m.tris, m.idx.length / 3);
    assert.ok(m.tris <= 9000, `${JSON.stringify(L)} ${club}: ${m.tris} tris`);
    maxTris = Math.max(maxTris, m.tris);
    minTris = Math.min(minTris, m.tris);
    for (let k = 0; k < m.idx.length; k++) if (m.idx[k] >= nv) assert.fail(`index ${m.idx[k]} >= ${nv}`);
    for (let k = 0; k < nv; k++) {
      const b = m.bone[k];
      if (!(Number.isInteger(b) && b >= 0 && b < BONE_COUNT)) assert.fail(`bone ${b}`);
      const l = Math.hypot(m.nrm[k * 3], m.nrm[k * 3 + 1], m.nrm[k * 3 + 2]);
      if (Math.abs(l - 1) > 1e-3) assert.fail(`normal length ${l}`);
    }
    assert.ok(finite(m.pos) && finite(m.col));
    for (const c of m.col) if (c < 0 || c > 1) assert.fail(`colour ${c}`);
  }
  assert.ok(minTris > 4500, `smooth enough: ${minTris}`);
  // Every bone carries geometry.
  const m = buildGolferMesh(DEFAULT_LOOK, '7i');
  const used = new Set(m.bone);
  for (let b = 0; b < BONE_COUNT; b++) assert.ok(used.has(b), BONES[b]);
});

test('FK: no NaN in any key pose for any club, look and hand', () => {
  for (const id of CLUB_IDS) {
    for (const handed of ['R', 'L']) {
      const anim = new SwingAnimator(PRESETS[CLUB_IDS.indexOf(id) % PRESETS.length].look, { club: id, handed, ball: { x: 3, y: -2, z: 1.2 + BALL_R }, aimYaw: 2.1 });
      for (const pose of ['address', 'P2', 'P3', 'top', 'P5', 'P6', 'impact', 'P8', 'P9', 'finish']) {
        const bones = anim.showPose(pose);
        assert.ok(finite(Array.from(bones)), `${id} ${handed} ${pose}`);
      }
    }
  }
});

test('impact: the club head is on the ball (2 cm) for every club, height, hand, style and build', () => {
  const styles = OPTIONS.swing;
  let worst = 0;
  let n = 0;
  for (const id of CLUB_IDS) {
    for (const height of HEIGHTS) {
      for (const handed of ['R', 'L']) {
        for (const [bi, build] of OPTIONS.build.entries()) {
          for (const style of styles) {
            const body = (bi + styles.indexOf(style)) % 2 ? 'female' : 'male';
            const ball = { x: -40 + n * 0.37, y: 12 - n * 0.11, z: 4.5 + BALL_R };
            const anim = new SwingAnimator({ height, build, body, swing: style }, { club: id, handed, ball, aimYaw: n * 0.7 });
            const r = strikeToImpact(anim, id === 'P' ? 0.5 : 1, { style });
            assert.equal(r.calls, 1);
            const d = dist3(r.head, ball);
            worst = Math.max(worst, d);
            assert.ok(d < 0.02, `${id} ${height} ${handed} ${build} ${style}: ${(d * 100).toFixed(1)} cm`);
            n++;
          }
        }
      }
    }
  }
  assert.ok(worst < 0.02);
  // The key pose itself is exact.
  const a = new SwingAnimator({}, { club: '7i', ball: { x: 1, y: 2, z: 3 }, aimYaw: 1 });
  a.showPose('impact');
  assert.ok(dist3(a.clubHeadWorld(), { x: 1, y: 2, z: 3 }) < 1e-6);
});

test('placement: right-hander on the left of the ball looking down the line, left-hander mirrored; facing the ball', () => {
  for (const aimYaw of [0, 1.1, -2.5]) {
    const d = { x: Math.cos(aimYaw), y: Math.sin(aimYaw) };
    const right = { x: d.y, y: -d.x }; // d x z
    const ball = { x: 5, y: 7, z: BALL_R };
    for (const handed of ['R', 'L']) {
      const anim = new SwingAnimator({}, { club: '7i', handed, ball, aimYaw });
      const pel = anim.jointWorld(B.pelvis);
      const side = (pel.x - ball.x) * right.x + (pel.y - ball.y) * right.y;
      if (handed === 'R') assert.ok(side < -0.4, `RH on the left: ${side}`);
      else assert.ok(side > 0.4, `LH on the right: ${side}`);
      // Stance across the line: both feet roughly abreast of the ball along the target line.
      const fl = anim.jointWorld(B.footL);
      const fr = anim.jointWorld(B.footR);
      const along = (p) => (p.x - ball.x) * d.x + (p.y - ball.y) * d.y;
      assert.ok(along(fl) > along(fr), 'lead foot nearer the target');
    }
  }
});

test('feet stay on the ground: flat and 10% slopes (up, down, side), address, top and impact', () => {
  const slopes = [[0, 0], [0.1, 0], [-0.1, 0], [0, 0.1], [0, -0.1], [0.07, 0.07]];
  for (const [sx, sy] of slopes) {
    const ground = (x, y) => 2 + sx * x + sy * y;
    for (const handed of ['R', 'L']) {
      for (const club of ['D', '7i', 'P']) {
        for (const aimYaw of [0, 2]) {
          const ball = { x: 1.5, y: -0.7, z: ground(1.5, -0.7) + BALL_R };
          const anim = new SwingAnimator({ height: 175 }, { club, handed, ball, aimYaw, ground });
          for (const pose of ['address', 'top', 'impact']) {
            anim.showPose(pose);
            const pts = anim.footPoints();
            // Lead foot (heel, toe) always; trail foot too except its heel at impact (it lifts).
            const check = pose === 'impact' ? [0, 1, 3] : [0, 1, 2, 3];
            for (const k of check) {
              const p = pts[k];
              const dz = p.z - ground(p.x, p.y);
              assert.ok(Math.abs(dz) < 0.05, `slope ${sx},${sy} ${handed} ${club} ${pose} pt ${k}: ${dz.toFixed(3)}`);
            }
          }
        }
      }
    }
  }
});

test('terrain placement uses heightAt/normalAt', () => {
  const terrain = { heightAt: (x, y) => 0.08 * x, normalAt: () => ({ x: -0.08 / Math.hypot(0.08, 1), y: 0, z: 1 / Math.hypot(0.08, 1) }) };
  const ball = { x: 0, y: 0, z: BALL_R };
  const rig = placeGolfer({ ball, aimYaw: 0.3, terrain, club: '7i' });
  assert.ok(Math.abs(rig.origin[2] - terrain.heightAt(rig.origin[0], rig.origin[1])) < 1e-9);
});

test('backswing: hands rise with power; club head rises to lead-arm parallel; its path grows', () => {
  for (const club of ['D', '7i', 'SW']) {
    const anim = new SwingAnimator({}, { club, ball: { x: 0, y: 0, z: BALL_R }, aimYaw: 0 });
    let prevHand = -Infinity;
    let prevHead = -Infinity;
    let prevPath = -1;
    let path = 0;
    let last = anim.clubHeadWorld();
    for (let p = 0; p <= 1.1 + 1e-9; p += 0.05) {
      anim.setBackswing(p);
      for (let i = 0; i < 90; i++) {
        anim.update(1 / 60);
        const h = anim.clubHeadWorld();
        path += dist3(h, last);
        last = h;
      }
      const hand = anim.jointWorld(B.handL).z;
      const head = anim.clubHeadWorld().z;
      assert.ok(hand >= prevHand - 0.006, `${club} hands at ${p.toFixed(2)}`);
      if (p <= 0.55) assert.ok(head > prevHead, `${club} head at ${p.toFixed(2)}`);
      assert.ok(path >= prevPath);
      prevHand = hand;
      prevHead = head;
      prevPath = path;
    }
    assert.ok(path > 2.5, `${club} the club head travels a full arc: ${path.toFixed(2)} m`);
  }
  // Putts: the putter head rises steadily with the backstroke.
  const putt = new SwingAnimator({}, { club: 'P', ball: { x: 0, y: 0, z: BALL_R }, aimYaw: 0 });
  let prev = -Infinity;
  for (let p = 0; p <= 1.1 + 1e-9; p += 0.1) {
    putt.setBackswing(p);
    for (let i = 0; i < 90; i++) putt.update(1 / 60);
    const z = putt.clubHeadWorld().z;
    assert.ok(z > prev);
    prev = z;
  }
});

test('strike: onImpact once, at the returned time; timing by style; live and automatic backswings', () => {
  for (const style of OPTIONS.swing) {
    for (const live of [false, true]) {
      const anim = new SwingAnimator({ swing: style }, { club: '7i', ball: { x: 0, y: 0, z: BALL_R }, aimYaw: 0 });
      if (live) {
        anim.setBackswing(1);
        for (let i = 0; i < 90; i++) anim.update(1 / 60);
      }
      const r = strikeToImpact(anim, 1, { style });
      assert.equal(r.calls, 1);
      assert.ok(r.tAt >= r.T - 1e-9 && r.tAt < r.T + 1 / 60 + 1e-9, `${style} live=${live}: impact at ${r.tAt} vs ${r.T}`);
      if (live) assert.ok(r.T >= 0.22 && r.T <= 0.32, `downswing ${r.T}`);
      assert.equal(anim.state, 'finish');
    }
  }
  const t = OPTIONS.swing.map((s) => swingTiming(s, 1).down);
  assert.ok(t[OPTIONS.swing.indexOf('compact')] < t[OPTIONS.swing.indexOf('smooth')]);
  // Putts.
  const p = new SwingAnimator({}, { club: 'P', ball: { x: 0, y: 0, z: BALL_R }, aimYaw: 0 });
  const r = strikeToImpact(p, 0.4);
  assert.equal(r.calls, 1);
  assert.equal(p.kind, 'putt');
});

test('cancel eases back to address; reset snaps', () => {
  const ball = { x: 0, y: 0, z: BALL_R };
  const anim = new SwingAnimator({}, { club: '7i', ball, aimYaw: 0 });
  anim.showPose('address');
  const addrHead = anim.clubHeadWorld();
  const addrHand = anim.jointWorld(B.handL);
  anim.reset();
  anim.setBackswing(0.8);
  for (let i = 0; i < 40; i++) anim.update(1 / 60);
  assert.equal(anim.state, 'backswing');
  assert.ok(dist3(anim.clubHeadWorld(), addrHead) > 0.5);
  anim.cancel();
  assert.equal(anim.state, 'cancel');
  for (let i = 0; i < 40; i++) anim.update(1 / 60);
  assert.equal(anim.state, 'address');
  // Back at address (idle breathing aside).
  assert.ok(dist3(anim.clubHeadWorld(), addrHead) < 0.02, `head ${dist3(anim.clubHeadWorld(), addrHead)}`);
  assert.ok(dist3(anim.jointWorld(B.handL), addrHand) < 0.01);
  // Cancel from the follow-through too, and reset snaps exactly.
  anim.strike({ power: 1 });
  for (let i = 0; i < 80; i++) anim.update(1 / 60);
  anim.cancel();
  for (let i = 0; i < 40; i++) anim.update(1 / 60);
  assert.equal(anim.state, 'address');
  anim.reset();
  assert.ok(dist3(anim.clubHeadWorld(), addrHead) < 1e-9);
  // A cancelled swing never calls onImpact.
  let called = 0;
  anim.strike({ power: 1, onImpact: () => called++ });
  anim.update(1 / 60);
  anim.cancel();
  for (let i = 0; i < 120; i++) anim.update(1 / 60);
  assert.equal(called, 0);
});

test('pose: local quaternions and root; bones are proper rigid transforms (mirrored for left-handers)', () => {
  for (const handed of ['R', 'L']) {
    const anim = new SwingAnimator({}, { club: 'D', handed, ball: { x: 0, y: 0, z: BALL_R }, aimYaw: 0.4 });
    const bones = anim.showPose('top');
    const pose = anim.pose;
    assert.equal(pose.quats.length, BONE_COUNT * 4);
    for (let b = 0; b < BONE_COUNT; b++) {
      const q = pose.quats.subarray(b * 4, b * 4 + 4);
      assert.ok(Math.abs(Math.hypot(...q) - 1) < 1e-6);
      const o = b * 16;
      const m = bones;
      const det = m[o] * (m[o + 5] * m[o + 10] - m[o + 6] * m[o + 9]) - m[o + 4] * (m[o + 1] * m[o + 10] - m[o + 2] * m[o + 9]) + m[o + 8] * (m[o + 1] * m[o + 6] - m[o + 2] * m[o + 5]);
      assert.ok(Math.abs(Math.abs(det) - 1) < 1e-4);
      assert.equal(Math.sign(det), handed === 'L' ? -1 : 1);
    }
  }
  assert.equal(NP, 28);
});

test('SwingAnimator.update allocates nothing after warm-up', async () => {
  // Design: update() writes into preallocated typed arrays and returns the same buffer. Check it
  // with V8's sampling heap profiler: bytes allocated in swing-anim.js frames per update, after a
  // warm-up long enough for the optimizing compiler (unoptimized code boxes every float, which is
  // an engine detail, not an allocation the code makes).
  const anim = new SwingAnimator(PRESETS[0].look, { club: '7i', ball: { x: 0, y: 0, z: BALL_R }, aimYaw: 0 });
  let frames = 0;
  const run = (n, dt) => {
    for (let i = 0; i < n; i++) anim.update(dt);
    frames += n;
  };
  // Every state for thousands of frames: idle with waggles, live backswing, downswing (small
  // steps), follow-through, finish hold, cancel.
  const seq = () => {
    anim.reset();
    run(2000, 1 / 60);
    anim.setBackswing(1);
    run(3000, 1e-3);
    anim.strike({ power: 1 });
    run(5000, 1e-4);
    run(3000, 1 / 60);
    anim.cancel();
    run(2000, 1e-3);
  };
  for (let k = 0; k < 4; k++) seq();
  const out = anim.update(1 / 60);
  assert.equal(anim.update(1 / 60), out, 'the same buffer every frame');
  const { Session } = await import('node:inspector/promises');
  const session = new Session();
  session.connect();
  await session.post('HeapProfiler.enable');
  await session.post('HeapProfiler.startSampling', { samplingInterval: 32 });
  frames = 0;
  for (let k = 0; k < 4; k++) seq();
  const { profile } = await session.post('HeapProfiler.stopSampling');
  session.disconnect();
  let bytes = 0;
  const walk = (n, inAnim) => {
    const mine = inAnim || /swing-anim\.js$/.test(n.callFrame.url || '');
    if (mine && /swing-anim\.js$/.test(n.callFrame.url || '')) bytes += n.selfSize || 0;
    for (const c of n.children || []) walk(c, mine);
  };
  walk(profile.head, false);
  // A single small object per frame would be ~16-32 bytes; a typed array 100+.
  assert.ok(bytes / frames < 4, `${(bytes / frames).toFixed(2)} bytes per frame over ${frames} frames`);
});
