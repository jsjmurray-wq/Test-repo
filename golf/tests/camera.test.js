// CameraRig tests on the synthetic stub hole: terrain clearance in every mode, framing, FOV.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CameraRig, fovForAspect, FLYOVER_T } from '../src/camera.js';
import { stubTerrain, fakeShot, samplePath } from './visual/render-preview.js';

const T = stubTerrain();
const DEG = Math.PI / 180;
const tee = { x: T.tee.x, y: T.tee.y, z: T.tee.z + 0.03 };
const yaw = Math.atan2(T.cup.y - tee.y, T.cup.x - tee.x);

function clearance(cam, min) {
  const g = T.heightAt(cam.eye.x, cam.eye.y);
  return cam.eye.z - g >= min - 1e-9;
}

function finite(cam) {
  return [cam.eye, cam.target, cam.up].every((v) => [v.x, v.y, v.z].every(Number.isFinite)) && Number.isFinite(cam.fovY);
}

test('fovY from a 55 degree horizontal FOV, clamped 40..75', () => {
  assert.ok(Math.abs(fovForAspect(16 / 9) - 2 * Math.atan(Math.tan(27.5 * DEG) / (16 / 9))) < 1e-9 || fovForAspect(16 / 9) === 40 * DEG);
  assert.equal(fovForAspect(393 / 852), 75 * DEG);
  assert.equal(fovForAspect(4), 40 * DEG);
  const f = fovForAspect(1);
  assert.ok(f > 40 * DEG && f < 75 * DEG);
});

test('address: eye = ball - aimDir*3.2 + z*1.7', () => {
  const rig = new CameraRig();
  rig.setMode('address', { ball: tee, aimYaw: yaw, cup: T.cup, terrain: T, aspect: 0.46 });
  const cam = rig.update(0.016, {});
  const ex = tee.x - Math.cos(yaw) * 3.2;
  const ey = tee.y - Math.sin(yaw) * 3.2;
  assert.ok(Math.hypot(cam.eye.x - ex, cam.eye.y - ey) < 1e-6);
  assert.ok(Math.abs(cam.eye.z - Math.max(tee.z + 1.7, T.heightAt(ex, ey) + 1)) < 1e-6);
  assert.ok(cam.near > 0 && cam.far > 1000);
});

test('eye stays >= 1 m above terrain in every mode (>= 0.3 m putting)', () => {
  const green = { x: T.cup.x - 6, y: T.cup.y - 4 };
  green.z = T.heightAt(green.x, green.y) + 0.0214;
  const shotRes = fakeShot(T, tee, yaw, 210, 30, 6);
  const balls = [tee, green, { x: -60, y: 120, z: T.heightAt(-60, 120) + 0.02 }, { x: 40, y: 300, z: T.heightAt(40, 300) + 0.02 }];
  for (const mode of ['address', 'putt', 'read', 'flight', 'holed', 'map', 'flyover']) {
    for (const b of balls) {
      for (const aspect of [393 / 852, 852 / 393]) {
        for (let a = 0; a < 8; a++) {
          const aimYaw = (a / 8) * Math.PI * 2;
          const rig = new CameraRig();
          const shot = { result: shotRes, playT: 0 };
          let ball = b;
          rig.setMode(mode, { ball, aimYaw, cup: T.cup, terrain: T, shot, aspect });
          const min = mode === 'putt' ? 0.3 : 1;
          const dur = mode === 'flyover' ? FLYOVER_T + 1 : mode === 'flight' ? shotRes.t + 0.5 : 3;
          for (let t = 0; t < dur; t += 1 / 15) {
            if (mode === 'flight') {
              shot.playT = Math.min(t, shotRes.t);
              ball = samplePath(shotRes, shot.playT).ball;
            }
            if (mode === 'read') rig.orbit(0.2);
            const cam = rig.update(1 / 15, { ball, shot });
            assert.ok(finite(cam), `${mode} produced non-finite camera`);
            assert.ok(clearance(cam, min), `${mode} eye below clearance at t=${t.toFixed(2)}: ${cam.eye.z - T.heightAt(cam.eye.x, cam.eye.y)}`);
          }
        }
      }
    }
  }
});

test('flight: tracks from behind, then cuts to a landing camera near shot.landing', () => {
  const shotRes = fakeShot(T, tee, yaw, 210, 30, 6);
  const shot = { result: shotRes, playT: 0 };
  const rig = new CameraRig();
  rig.setMode('flight', { ball: tee, aimYaw: yaw, cup: T.cup, terrain: T, shot, aspect: 0.46 });
  let cam;
  for (let t = 0; t <= 0.5; t += 1 / 30) {
    shot.playT = t;
    cam = rig.update(1 / 30, { ball: samplePath(shotRes, t).ball, shot });
  }
  // Early: eye still behind the tee.
  assert.ok(Math.hypot(cam.eye.x - tee.x, cam.eye.y - tee.y) < 8);
  for (let t = 0.5; t <= 5.9; t += 1 / 30) {
    shot.playT = t;
    cam = rig.update(1 / 30, { ball: samplePath(shotRes, t).ball, shot });
  }
  // Near touchdown: the camera sits within ~70 m of the landing spot, looking at the ball.
  const L = shotRes.landing;
  assert.ok(Math.hypot(cam.eye.x - L.x, cam.eye.y - L.y) < 70, 'landing cam near landing');
  const b = samplePath(shotRes, 5.9).ball;
  assert.ok(Math.hypot(cam.target.x - b.x, cam.target.y - b.y, cam.target.z - b.z) < 3);
});

test('map: high above and up vector along the hole; flyover ends looking at the green', () => {
  const rig = new CameraRig();
  rig.setMode('map', { ball: tee, aimYaw: yaw, cup: T.cup, terrain: T, aspect: 0.46 });
  let cam;
  for (let k = 0; k < 120; k++) cam = rig.update(1 / 30, {});
  assert.ok(cam.eye.z - T.heightAt(cam.eye.x, cam.eye.y) > 100);
  const hx = (T.cup.x - tee.x) / Math.hypot(T.cup.x - tee.x, T.cup.y - tee.y);
  assert.ok(cam.up.x * hx + cam.up.y * Math.sqrt(1 - hx * hx) > 0.9);
  const fly = new CameraRig();
  fly.setMode('flyover', { ball: tee, aimYaw: yaw, cup: T.cup, terrain: T, aspect: 0.46 });
  for (let t = 0; t < FLYOVER_T + 1; t += 1 / 30) cam = fly.update(1 / 30, {});
  assert.ok(Math.hypot(cam.target.x - T.cup.x, cam.target.y - T.cup.y) < 5);
  assert.ok(Math.hypot(cam.eye.x - T.cup.x, cam.eye.y - T.cup.y) < 90);
});

test('read: orbit moves the eye around the green', () => {
  const ball = { x: T.cup.x - 6, y: T.cup.y - 4, z: T.heightAt(T.cup.x - 6, T.cup.y - 4) };
  const rig = new CameraRig();
  rig.setMode('read', { ball, aimYaw: yaw, cup: T.cup, terrain: T, aspect: 0.46 });
  const a = rig.update(1, {});
  rig.orbit(Math.PI / 2);
  let b;
  for (let k = 0; k < 60; k++) b = rig.update(1 / 30, {});
  assert.ok(Math.hypot(a.eye.x - b.eye.x, a.eye.y - b.eye.y) > 5);
  assert.ok(b.eye.z > T.heightAt(b.eye.x, b.eye.y) + 5);
});
