import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CLUBS, clubById, stockLaunch, makeLaunch, dPlane, PUTTER_ID } from '../src/clubs.js';
import { BALL_R } from '../src/constants.js';

const DEG = Math.PI / 180;
const len = (a) => Math.hypot(a.x, a.y, a.z);
const cross = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });

test('club table: 14 clubs, unique ids, longest first, putter last', () => {
  assert.equal(CLUBS.length, 14);
  assert.equal(new Set(CLUBS.map((c) => c.id)).size, 14);
  assert.equal(CLUBS[CLUBS.length - 1].id, PUTTER_ID);
  const full = CLUBS.filter((c) => c.kind !== 'putter');
  for (let i = 1; i < full.length; i++) {
    assert.ok(full[i].targetCarryYd < full[i - 1].targetCarryYd, full[i].id);
    assert.ok(full[i].ballSpeed < full[i - 1].ballSpeed, full[i].id);
    assert.ok(full[i].spinLoft > full[i - 1].spinLoft, full[i].id);
  }
  for (const c of CLUBS) {
    for (const k of ['id', 'name', 'short', 'kind', 'loft', 'spinLoft', 'ballSpeed', 'launch', 'spinRpm', 'targetCarryYd']) {
      assert.ok(c[k] !== undefined, `${c.id}.${k}`);
    }
  }
  assert.equal(clubById('7i').name, '7 Iron');
  assert.equal(clubById('nope'), null);
});

test('stockLaunch builds the documented launch vector', () => {
  const c = clubById('7i');
  const L = stockLaunch(c, { aimYaw: 0.7, pos: { x: 1, y: 2, z: 3 + BALL_R } });
  assert.equal(L.mode, 'air');
  assert.ok(Math.abs(len(L.vel) - c.ballSpeed) < 1e-9);
  assert.ok(Math.abs(Math.asin(L.vel.z / len(L.vel)) / DEG - c.launch) < 1e-9);
  assert.ok(Math.abs((len(L.spin) * 60) / (2 * Math.PI) - c.spinRpm) < 1e-6);
  // Horizontal direction is the aim yaw.
  assert.ok(Math.abs(Math.atan2(L.vel.y, L.vel.x) - 0.7) < 1e-12);
  // Zero tilt: w_hat x v_hat lies in the vertical plane of the shot and points up (pure backspin
  // lift; exactly +z for a level velocity).
  const l = cross(L.spin, L.vel);
  const right = { x: Math.sin(0.7), y: -Math.cos(0.7), z: 0 };
  assert.ok(l.z > 0);
  assert.ok(Math.abs(l.x * right.x + l.y * right.y) < 1e-9 * len(l));
  assert.deepEqual(L.pos, { x: 1, y: 2, z: 3 + BALL_R });
  assert.equal(L.meta.club, '7i');
});

test('positive tilt curves right; positive startDir starts right', () => {
  // Facing +y (aimYaw = 90 deg), the golfer's right is +x.
  const L = stockLaunch('D', { aimYaw: Math.PI / 2, tiltDeg: 20 });
  const side = cross(L.spin, L.vel);
  assert.ok(side.x > 0, 'Magnus force has a +x (right) component');
  const S = stockLaunch('D', { aimYaw: Math.PI / 2, startDirDeg: 5 });
  assert.ok(S.vel.x > 0, 'starts right of the aim line');
});

test('D-plane: tilt from face-to-path over spin loft; start dir mostly face', () => {
  const d = dPlane(clubById('D'), 3, 0);
  assert.ok(Math.abs(Math.tan(d.tiltDeg * DEG) - 3 / 13) < 1e-9);
  assert.ok(Math.abs(d.startDirDeg - 0.85 * 3) < 1e-9);
  const w = dPlane(clubById('PW'), 3, 0);
  assert.ok(w.tiltDeg < d.tiltDeg / 2);
  assert.ok(Math.abs(w.startDirDeg - 0.75 * 3) < 1e-9);
  assert.equal(dPlane(clubById('D'), 60, 0).tiltDeg, 45);
});

test('putter launches roll mode, makeLaunch defaults', () => {
  const P = stockLaunch(clubById(PUTTER_ID), { ballSpeed: 2 });
  assert.equal(P.mode, 'roll');
  assert.equal(P.vel.z, 0);
  assert.ok(Math.abs(len(P.vel) - 2) < 1e-12);
  const M = makeLaunch();
  assert.equal(M.mode, 'air');
  assert.equal(M.pos.z, BALL_R);
});

test('module style rule: only top-level imports and export declarations', () => {
  for (const f of ['clubs.js', 'aero.js', 'physics.js']) {
    const src = readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');
    assert.ok(!/export\s+default/.test(src), f);
    assert.ok(!/export\s*\{/.test(src), f);
    assert.ok(!/import\s*\*/.test(src), f);
    assert.ok(!/import\s*\(/.test(src), f);
    assert.ok(!/\b(document|window)\./.test(src), f);
    for (const m of src.matchAll(/from\s+'([^']+)'/g)) assert.match(m[1], /^\.\/[a-z0-9-]+\.js$/, f);
  }
});
