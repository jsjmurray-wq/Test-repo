// Golfer preview: the character on a real tee (Renderer + a real hole), posed or swinging.
//
// URL params
//   look=<preset id> (golfer.js PRESETS; default the default look), plus any look field to
//        override (body, skin, height, build, hair, hairColor, facialHair, sunglasses, headwear,
//        hatColor, shirt, shirtColor, shirtColor2, legwear, legColor, shoeColor, gloveColor, swing)
//   club=<id> (D, 3W, 4H, 7i, SW, P ...), handed=R|L, shot=<shots.js id>, power=0..1.1
//   pose=address|P2|half|top|P5|P6|impact|P8|P9|finish (a key pose), or t=<seconds> into a scripted
//        swing (address 0.4 s, backswing to `power`, a pause, strike; impact at about 1.7 s)
//   cam=behind|face|side|close|profile|hands|clubhead|clubface (behind = down the line, the TV view),
//        turn=deg (turntable round the golfer), spin=1 (auto-rotating turntable), dist=m, fov=deg,
//        anim=1 (play the swing live, looping), gl1=1 (force WebGL1)
//   course=pines|desert|water|links, hole=1..9, slope=x,y (a synthetic tilted ground instead)
// window.__golfer.set({...same keys}) re-poses without a reload (screenshot scripts); it merges into
// the options set so far, and set({...}, {replace: true}) starts from the URL's options instead (so
// a power, shot or hand from an earlier case does not carry over).

import { Renderer } from '../../src/render.js';
import { courseById } from '../../src/courses.js';
import { buildHole } from '../../src/terrain.js';
import { buildGolferMesh } from '../../src/golfer-mesh.js';
import { SwingAnimator } from '../../src/swing-anim.js';
import { PRESETS, presetById, DEFAULT_LOOK, normalizeLook } from '../../src/golfer.js';
import { BALL_R } from '../../src/constants.js';

const LOOK_KEYS = Object.keys(DEFAULT_LOOK);

if (typeof document !== 'undefined') main();

function main() {
  const qs = new URLSearchParams(location.search);
  const canvas = document.getElementById('c');
  const info = document.getElementById('info');
  const course = courseById(qs.get('course') || 'pines');
  const holeN = parseInt(qs.get('hole') || '1', 10);
  const terrain = buildHole(course.holes[holeN - 1], { pinIndex: 0, seed: 1, course });
  const renderer = new Renderer(canvas, { test: true, quality: qs.get('quality') || 'auto', gl1: qs.get('gl1') === '1' });
  if (!renderer.ok) {
    info.textContent = 'WebGL unavailable';
    document.body.dataset.ready = '1';
    return;
  }
  renderer.setHole(terrain);
  const resize = () => renderer.resize(window.innerWidth, window.innerHeight, window.devicePixelRatio || 1);
  resize();
  window.addEventListener('resize', resize);
  const tee = terrain.tee;
  const aimP = terrain.aimPoint ? terrain.aimPoint(tee) : terrain.cup;
  const aimYaw = Math.atan2(aimP.y - tee.y, aimP.x - tee.x);
  const state = { anim: null, mesh: null, opts: {}, simT: 0, cam: null };

  function lookFrom(o) {
    const pre = presetById(o.look || '') || null;
    const L = { ...(pre ? pre.look : DEFAULT_LOOK) };
    for (const k of LOOK_KEYS) if (o[k] != null) L[k] = o[k];
    if (L.sunglasses === '1' || L.sunglasses === 'true') L.sunglasses = true;
    if (L.sunglasses === '0' || L.sunglasses === 'false') L.sunglasses = false;
    if (L.height != null) L.height = Number(L.height);
    if (L.skin != null && /^\d+$/.test(String(L.skin))) L.skin = Number(L.skin);
    return normalizeLook(L);
  }

  function set(o, { replace = false } = {}) {
    const opts = { ...(replace ? state.urlOpts : state.opts), ...o };
    state.opts = opts;
    const look = lookFrom(opts);
    const club = opts.club || '7i';
    const handed = opts.handed === 'L' ? 'L' : 'R';
    const shot = opts.shot || 'normal';
    let ground = null;
    if (opts.slope) {
      const [sx, sy] = String(opts.slope).split(',').map(Number);
      ground = (x, y) => tee.z + (x - tee.x) * (sx || 0) + (y - tee.y) * (sy || 0);
    }
    const bz = (ground ? ground(tee.x, tee.y) : terrain.heightAt(tee.x, tee.y)) + BALL_R;
    const ball = { x: tee.x, y: tee.y, z: bz };
    const key = JSON.stringify([look, club, handed, shot, opts.slope || null]);
    if (state.key !== key) {
      state.mesh = buildGolferMesh(look, club);
      state.anim = new SwingAnimator(look, { club, handed, shot, ball, aimYaw, terrain: ground ? null : terrain, ground });
      state.key = key;
      state.ball = ball;
      state.ground = ground;
    }
    const anim = state.anim;
    const power = opts.power != null ? Number(opts.power) : anim.kind === 'putt' ? 0.4 : 1;
    if (opts.t != null && opts.t !== '') runScript(anim, Number(opts.t), power, shot, opts.style);
    else anim.showPose(opts.pose || 'address', power);
    state.cam = cameraFor(opts, anim, ball, aimYaw);
    draw();
  }

  function runScript(anim, T, power, shot, style) {
    anim.reset();
    const dt = 1 / 60;
    let t = 0;
    let struck = false;
    const tStart = 0.4;
    const tBack = anim.kind === 'putt' ? 0.6 : 0.9;
    while (t < T - 1e-9) {
      const step = Math.min(dt, T - t);
      if (!struck) {
        const x = Math.min(1, Math.max(0, (t - tStart) / tBack));
        if (x > 0) anim.setBackswing(power * (x * x * (3 - 2 * x)));
        if (t >= tStart + tBack + 0.12) {
          anim.strike({ power, shot, style: style || anim.style, onImpact: () => (state.impactT = t) });
          struck = true;
        }
      }
      anim.update(step);
      t += step;
    }
    state.simT = T;
  }

  function cameraFor(o, anim, ball, yaw) {
    const d = { x: Math.cos(yaw), y: Math.sin(yaw) };
    const hand = anim.handed === 'L' ? -1 : 1;
    // The golfer faces right(d) for a right-hander; f = facing, toward the ball from the golfer.
    const f = { x: d.y * hand, y: -d.x * hand };
    const pel = anim.jointWorld(0);
    const gc = { x: pel.x, y: pel.y, z: ball.z + 0.95 };
    const mode = o.cam || 'behind';
    const dist = o.dist != null ? Number(o.dist) : null;
    let eye;
    let at;
    if (mode === 'behind') {
      const k = dist || 4.2;
      eye = { x: ball.x - d.x * k - f.x * 0.6, y: ball.y - d.y * k - f.y * 0.6, z: ball.z + 1.45 };
      at = { x: ball.x + d.x * 3 - f.x * 0.75, y: ball.y + d.y * 3 - f.y * 0.75, z: ball.z + 0.8 };
    } else if (mode === 'face') {
      const k = dist || 3.6;
      eye = { x: gc.x + f.x * k, y: gc.y + f.y * k, z: ball.z + 1.15 };
      at = { x: gc.x + f.x * 0.3, y: gc.y + f.y * 0.3, z: ball.z + 0.9 };
    } else if (mode === 'side') {
      const k = dist || 3.6;
      eye = { x: gc.x + d.x * k, y: gc.y + d.y * k, z: ball.z + 1.15 };
      at = { x: gc.x, y: gc.y, z: ball.z + 0.9 };
    } else if (mode === 'close' || mode === 'profile') {
      // Along the head's own forward axis (or its side for a profile), whatever the pose.
      const b = anim.bones;
      const o = 4 * 16;
      const fw = { x: b[o], y: b[o + 1], z: b[o + 2] };
      const sd = { x: b[o + 4], y: b[o + 5], z: b[o + 6] };
      const up = { x: b[o + 8], y: b[o + 9], z: b[o + 10] };
      const head = anim.jointWorld(4);
      const c = { x: head.x + up.x * 0.1 + fw.x * 0.04, y: head.y + up.y * 0.1 + fw.y * 0.04, z: head.z + up.z * 0.1 + fw.z * 0.04 };
      const k = dist || 0.75;
      const ax = mode === 'profile' ? sd : fw;
      eye = { x: c.x + ax.x * k, y: c.y + ax.y * k, z: c.z + ax.z * k };
      at = c;
      return { eye, target: at, up, fovY: (30 * Math.PI) / 180, near: 0.05, far: 6000, shiftX: 0 };
    } else if (mode === 'clubhead') {
      // Low, from in front of the ball (the golfer's far side), toe on the left.
      const k = dist || 0.55;
      eye = { x: ball.x + f.x * k - d.x * 0.25, y: ball.y + f.y * k - d.y * 0.25, z: ball.z + 0.12 };
      at = { x: ball.x - f.x * 0.03, y: ball.y - f.y * 0.03, z: ball.z };
      return { eye, target: at, up: { x: 0, y: 0, z: 1 }, fovY: (30 * Math.PI) / 180, near: 0.02, far: 6000, shiftX: 0 };
    } else if (mode === 'clubface') {
      // Low, from the target side, looking back at the face.
      const k = dist || 0.5;
      eye = { x: ball.x + d.x * k + f.x * 0.12, y: ball.y + d.y * k + f.y * 0.12, z: ball.z + 0.06 };
      at = { x: ball.x - f.x * 0.06, y: ball.y - f.y * 0.06, z: ball.z };
      return { eye, target: at, up: { x: 0, y: 0, z: 1 }, fovY: (30 * Math.PI) / 180, near: 0.02, far: 6000, shiftX: 0 };
    } else if (mode === 'hands') {
      const hnd = anim.jointWorld(8);
      const k = dist || 0.8;
      eye = { x: hnd.x + f.x * k + d.x * 0.2, y: hnd.y + f.y * k + d.y * 0.2, z: hnd.z + 0.25 };
      at = { x: hnd.x, y: hnd.y, z: hnd.z - 0.05 };
    } else {
      const k = dist || 4.0;
      eye = { x: gc.x - d.x * k, y: gc.y - d.y * k, z: ball.z + 1.2 };
      at = { x: gc.x, y: gc.y, z: ball.z + 0.9 };
    }
    const turn = ((Number(o.turn) || 0) * Math.PI) / 180;
    if (turn) {
      const cx = at.x;
      const cy = at.y;
      const ex = eye.x - cx;
      const ey = eye.y - cy;
      eye = { x: cx + ex * Math.cos(turn) - ey * Math.sin(turn), y: cy + ex * Math.sin(turn) + ey * Math.cos(turn), z: eye.z };
    }
    const fov = ((Number(o.fov) || (mode === 'close' || mode === 'hands' ? 30 : 42)) * Math.PI) / 180;
    return { eye, target: at, up: { x: 0, y: 0, z: 1 }, fovY: fov, near: 0.05, far: 6000, shiftX: 0 };
  }

  function draw() {
    const anim = state.anim;
    renderer.draw({
      time: state.simT,
      cam: state.cam,
      ball: { ...state.ball, visible: true, minPx: 2 },
      trail: null,
      aim: null,
      pin: { visible: true },
      wind: { x: 1, y: 0.5 },
      read: { on: false },
      golfer: { visible: true, mesh: state.mesh, bones: anim.bones, alpha: 1, fadeNear: !/close|hands|profile|clubhead|clubface/.test(state.opts.cam || '') },
    });
    const st = renderer.stats();
    const h = anim.clubHeadWorld();
    const b = state.ball;
    info.textContent = `${anim.look.body} ${anim.look.height}cm ${anim.club} ${anim.state} | ${state.mesh.tris} tris | ${st.drawCalls} draws | head-ball ${(Math.hypot(h.x - b.x, h.y - b.y, h.z - b.z) * 100).toFixed(1)} cm`;
  }

  const o = {};
  for (const [k, v] of qs.entries()) o[k] = v;
  state.urlOpts = { ...o };
  set(o);
  window.__golfer = { set, renderer, state, presets: PRESETS.map((p) => p.id) };
  document.body.dataset.ready = '1';
  if (qs.get('anim') === '1' || qs.get('spin') === '1') {
    let last = performance.now();
    let t0 = 0;
    let turn = Number(qs.get('turn')) || 0;
    const swing = qs.get('anim') === '1';
    const loop = (now) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const anim = state.anim;
      t0 += dt;
      // Turntable: the camera circles the golfer at 24 degrees a second.
      if (qs.get('spin') === '1') {
        turn = (turn + dt * 24) % 360;
        state.opts.turn = turn;
        state.cam = cameraFor(state.opts, anim, state.ball, aimYaw);
      }
      if (!swing) {
        anim.update(dt);
        state.simT += dt;
        draw();
        requestAnimationFrame(loop);
        return;
      }
      if (t0 > 0.6 && anim.state === 'address' && !state.live) {
        state.live = true;
        anim.strike({ power: 1 });
      }
      if (anim.state === 'finish' && t0 > 6) {
        anim.reset();
        state.live = false;
        t0 = 0;
      }
      anim.update(dt);
      state.simT += dt;
      draw();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }
}
