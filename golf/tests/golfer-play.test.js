// The golfer in play (section 9.7): the TV framing with the golfer (camera.js golferFraming and the
// address / putt / flight cameras with ctx.golfer), the saved look (golfer.js loadLook/saveLook)
// and the bot's prepare-then-swing split (bot.js prepareBotShot).
import test from 'node:test';
import assert from 'node:assert/strict';
import { CameraRig, golferFraming, fovForAspect, FLIGHT_HOLD } from '../src/camera.js';
import { SwingAnimator } from '../src/swing-anim.js';
import { B, BONE_COUNT, DEFAULT_LOOK, loadLook, saveLook, LOOK_KEY, presetById } from '../src/golfer.js';
import { BALL_R } from '../src/constants.js';
import { Game } from '../src/game.js';
import { prepareBotShot } from '../src/bot.js';
import { buildHole } from '../src/terrain.js';
import { fakeShot, samplePath } from './visual/render-preview.js';

const PORTRAIT = 393 / 852;
const LANDSCAPE = 852 / 393;

// Flat ground at z = 0 with a cup 160 m down +y.
const flat = {
  heightAt: () => 0,
  normalAt: () => ({ x: 0, y: 0, z: 1 }),
  cup: { x: 0, y: 160, z: 0 },
};

// NDC of a world point for a camera {eye, target, up, fovY, shiftX} at an aspect.
function ndc(cam, aspect, p) {
  const f = norm(sub(cam.target, cam.eye));
  const r = norm(cross(f, cam.up));
  const u = cross(r, f);
  const d = sub(p, cam.eye);
  const z = dot(d, f);
  const T = Math.tan(cam.fovY / 2);
  return { x: dot(d, r) / z / (T * aspect) + (cam.shiftX || 0), y: dot(d, u) / z / T, z };
}
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const norm = (a) => {
  const l = Math.hypot(a.x, a.y, a.z) || 1;
  return { x: a.x / l, y: a.y / l, z: a.z / l };
};

// The golfer placed at a ball on flat ground aiming down +y, as main.js does, with his framing.
function setup(club, handed, look = DEFAULT_LOOK) {
  const ball = { x: 0, y: 0, z: BALL_R };
  const aimYaw = Math.PI / 2;
  const A = new SwingAnimator(look, { club, handed, ball, aimYaw, terrain: flat });
  const o = A.rig.origin;
  const c = Math.cos(aimYaw);
  const s = Math.sin(aimYaw);
  const frame = { lat: -s * (o[0] - ball.x) + c * (o[1] - ball.y), along: c * (o[0] - ball.x) + s * (o[1] - ball.y), H: A.rig.dims.H };
  return { A, ball, aimYaw, frame };
}

function addressCam(S, aspect, putt, carry = 150) {
  const rig = new CameraRig();
  const ctx = { ball: S.ball, aimYaw: S.aimYaw, cup: putt ? { x: 0.4, y: 6, z: 0 } : flat.cup, terrain: flat, aspect, carry, golfer: S.frame, padShift: aspect > 1.25 ? 0.6 : 0 };
  rig.setMode(putt ? 'putt' : 'address', ctx);
  return { rig, cam: rig.update(0.016, {}), ctx };
}

// Every bone origin and the club head in world for the current pose.
function points(A) {
  const pts = [];
  for (let b = 0; b < BONE_COUNT; b++) pts.push({ b, ...A.jointWorld(b) });
  pts.push({ b: 'head-top', ...A.restPointWorld(B.head, [0, 0, A.rig.dims.H + 0.02]) });
  pts.push({ b: 'clubhead', ...A.clubHeadWorld() });
  return pts;
}

test('golferFraming: the golfer on his side, the ball in the arc, the figure fits', () => {
  for (const aspect of [PORTRAIT, LANDSCAPE, 0.9]) {
    for (const lat of [0.8, 1.0, 1.25, -1.0]) {
      const f = golferFraming(aspect, { dist: 200, lat, H: 1.8 });
      const T = Math.tan(fovForAspect(aspect) / 2);
      assert.ok(f.back > 2 && f.back < 12, `back ${f.back}`);
      assert.ok(f.h >= 1.2 && f.h <= 3.7, `h ${f.h}`);
      // The figure plus a club above the head fits in under ~85% of the height.
      assert.ok((1.8 + 0.4) / f.F / T <= 0.85 + 1e-9, `figure ${(2.2 / f.F / T).toFixed(2)} NDC`);
      if (aspect < 1) {
        // Portrait: the golfer on his own side, the ball no more than 0.32 the other way.
        assert.ok(Math.sign(f.golferX) === -Math.sign(lat) && Math.abs(f.golferX) <= 0.5, `golfer x ${f.golferX}`);
        assert.ok(Math.abs(f.shift) <= 0.32 + 1e-9 && (f.shift === 0 || Math.sign(f.shift) === Math.sign(lat)), `ball shift ${f.shift}`);
      } else assert.equal(f.shift, 0);
    }
  }
  // Longer shots never lower the eye; putts follow the putt length.
  const p3 = golferFraming(PORTRAIT, { dist: 3, lat: 0.8, putt: true });
  const p20 = golferFraming(PORTRAIT, { dist: 20, lat: 0.8, putt: true });
  assert.ok(p20.h > p3.h && p3.h >= 1.3);
});

test('address with the golfer: TV framing behind him on the target line, whole figure, line clear', () => {
  for (const aspect of [PORTRAIT, LANDSCAPE]) {
    for (const handed of ['R', 'L']) {
      for (const club of ['D', '7i', 'SW', 'P']) {
        const S = setup(club, handed);
        const putt = club === 'P';
        const { cam, rig } = addressCam(S, aspect, putt);
        assert.ok(rig.framing && rig.framing.golfer, 'golfer framing used');
        // On the target line behind the ball.
        assert.ok(Math.abs(cam.eye.x - S.ball.x) < 1e-6 && cam.eye.y < S.ball.y - 2, `eye ${JSON.stringify(cam.eye)}`);
        const ball = ndc(cam, aspect, S.ball);
        const tag = `${aspect < 1 ? 'portrait' : 'landscape'} ${handed} ${club}`;
        // The ball low in the swing arc (portrait: centre third; landscape: on the pad at 0.6).
        assert.ok(ball.y < -0.4 && ball.y > -0.7, `${tag}: ball y ${ball.y.toFixed(2)}`);
        if (aspect < 1) assert.ok(Math.abs(ball.x) <= 0.33, `${tag}: ball x ${ball.x.toFixed(2)}`);
        else assert.ok(Math.abs(ball.x - 0.6) < 1e-6, `${tag}: ball x ${ball.x.toFixed(2)}`);
        // The target (or cup) above the ball, on screen.
        const tgt = ndc(cam, aspect, putt ? { x: 0.4, y: 6, z: 0 } : { x: 0, y: 150, z: 0 });
        assert.ok(tgt.y > ball.y + 0.1 && tgt.y < 0.6 && Math.abs(tgt.x) < 1, `${tag}: target ${tgt.x.toFixed(2)},${tgt.y.toFixed(2)}`);
        const side = handed === 'L' ? 1 : -1; // where the golfer stands on screen relative to the ball
        for (const pose of ['address', 'top', 'impact', 'finish']) {
          S.A.showPose(pose, 1);
          const pts = points(S.A);
          for (const p of pts) {
            const q = ndc(cam, aspect, p);
            assert.ok(q.z > 2, `${tag} ${pose}: camera ${q.z.toFixed(2)} m from ${p.b} (never inside him)`);
            // Whole figure on screen (top 12% left for the top bar).
            assert.ok(Math.abs(q.x) < 1 && q.y < 0.88 && q.y > -1, `${tag} ${pose}: ${p.b} at ${q.x.toFixed(2)},${q.y.toFixed(2)}`);
          }
          // His body (pelvis, chest, neck, head) stays on his side of the target line (a putter's
          // eyes are over the ball, so his head comes close to it).
          for (const b of [B.pelvis, B.chest, B.neck, B.head]) {
            const q = ndc(cam, aspect, S.A.jointWorld(b));
            assert.ok(side * (q.x - ball.x) > (putt ? 0.02 : 0.08), `${tag} ${pose}: bone ${b} crosses the line (${q.x.toFixed(2)} vs ball ${ball.x.toFixed(2)})`);
          }
        }
        // Portrait: his centre in his third of the screen.
        if (aspect < 1) {
          S.A.showPose('address');
          const c = ndc(cam, aspect, S.A.jointWorld(B.chest));
          assert.ok(side * c.x > 0.3, `${tag}: chest x ${c.x.toFixed(2)} (his third)`);
        }
      }
    }
  }
});

test('flight with the golfer: holds the address framing through the follow-through, then pans', () => {
  const T = { ...flat, heightAt: () => 0 };
  const S = setup('D', 'R');
  const { rig, ctx } = addressCam(S, PORTRAIT, false, 230);
  let cam;
  for (let k = 0; k < 5; k++) cam = rig.update(1 / 30, {});
  const eye0 = { ...cam.eye };
  const shift0 = cam.shiftX;
  const res = fakeShot(T, S.ball, S.aimYaw, 220, 25, 8);
  const shot = { result: res, playT: 0 };
  rig.setMode('flight', { ...ctx, shot, terrain: T });
  for (let t = 0; t < FLIGHT_HOLD - 0.05; t += 1 / 30) {
    shot.playT = t;
    cam = rig.update(1 / 30, { ball: samplePath(res, t).ball, shot });
    assert.ok(Math.hypot(cam.eye.x - eye0.x, cam.eye.y - eye0.y, cam.eye.z - eye0.z) < 1e-6, `held at ${t.toFixed(2)} s`);
    assert.ok(Math.abs(cam.shiftX - shift0) < 1e-6, 'the lens shift holds too');
  }
  for (let t = FLIGHT_HOLD; t < 1.6; t += 1 / 30) {
    shot.playT = t;
    cam = rig.update(1 / 30, { ball: samplePath(res, t).ball, shot });
  }
  // Panning with the ball from the same spot: the view points at it.
  const b = samplePath(res, 1.6).ball;
  const q = ndc(cam, PORTRAIT, b);
  assert.ok(Math.abs(q.x) < 0.6 && Math.abs(q.y) < 0.6, `ball on screen while tracking (${q.x.toFixed(2)}, ${q.y.toFixed(2)})`);
  assert.ok(Math.hypot(cam.eye.x - eye0.x, cam.eye.y - eye0.y) < 1, 'still behind the golfer');
  // Without a golfer the flight camera is the version 1 TV sequence (no hold).
  const r2 = new CameraRig();
  r2.setMode('flight', { ball: S.ball, aimYaw: S.aimYaw, cup: flat.cup, terrain: T, shot: { result: res, playT: 0 }, aspect: PORTRAIT });
  assert.equal(r2.flight.hold, null);
});

test('loadLook / saveLook: localStorage golf.golfer.v1 with a memory fallback', () => {
  const store = new Map();
  const storage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  // Nothing saved yet in this test's storage: but the module may hold a look saved earlier in this
  // process (memory wins), so start from a known one.
  const pro = presetById('ladypro').look;
  const saved = saveLook({ ...pro, swing: 'compact', junk: 1 }, storage);
  assert.equal(saved.swing, 'compact');
  assert.ok(!('junk' in saved));
  assert.deepEqual(JSON.parse(store.get(LOOK_KEY)), saved);
  assert.deepEqual(loadLook(storage), saved);
  // Storage that throws: the look is still kept (memory) and a stale stored copy is removed.
  const broken = {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('quota');
    },
    removeItem: (k) => store.delete(k),
  };
  const next = saveLook({ ...pro, hair: 'curly' }, broken);
  assert.equal(next.hair, 'curly');
  assert.ok(!store.has(LOOK_KEY), 'stale copy removed');
  assert.equal(loadLook(broken).hair, 'curly');
  assert.equal(loadLook(null).hair, 'curly');
  // Garbage in storage normalises (memory still wins in this process, so check normalizeLook's path
  // through a fresh value): saveLook of garbage gives the default look.
  assert.deepEqual(saveLook('nonsense', null), { ...DEFAULT_LOOK });
});

test('prepareBotShot sets club, aim and shot but does not swing; the swing launches later', () => {
  const g = new Game({ seed: 3, settings: { wind: 'off', difficulty: 'normal' }, buildHole });
  g.loadHole(1);
  g.skipIntro();
  assert.equal(g.phase, 'address');
  const plan = prepareBotShot(g);
  assert.equal(g.phase, 'address');
  assert.equal(g.state.hole.strokes, 0);
  assert.equal(g.state.clubId, plan.clubId);
  assert.ok(Math.abs(g.aimYaw - plan.yaw) < 1e-9);
  const r = g.swing(plan.swing);
  assert.ok(r.ok);
  assert.equal(g.phase, 'flight');
  assert.equal(g.state.hole.strokes, 1);
});
