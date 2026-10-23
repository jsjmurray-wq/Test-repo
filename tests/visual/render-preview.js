// Visual preview for src/render.js.
// Query: ?w=&h= container size (CSS px, default window), scene=rack|play, anim=1, perf=1,
//        guide=0, cue=0, bih=1|bad|drag, pockets=1, targets=1, drop=1, cloth=blue, dpr=N,
//        pull=0..1, stroke=0..1
import { Renderer } from '../../src/render.js';
import { computeView } from '../../src/layout.js';
import { TABLE } from '../../src/table.js';
import { BALL_R, RACK_GAP } from '../../src/constants.js';
import { quatNormalize, quatIntegrate } from '../../src/vec.js';
import { mulberry32 } from '../../src/rng.js';

const P = new window.URLSearchParams(window.location.search);
const num = (k, d) => (P.has(k) && P.get(k) !== '' ? Number(P.get(k)) : d);
const W = num('w', window.innerWidth);
const H = num('h', window.innerHeight);
const sceneName = P.get('scene') || 'rack';
const R = BALL_R;

const wrap = document.getElementById('wrap');
wrap.style.width = W + 'px';
wrap.style.height = H + 'px';
const canvas = document.getElementById('table');
const info = document.getElementById('info');

const rng = mulberry32(7);
function randQuat() {
  return quatNormalize([rng() * 2 - 1, rng() * 2 - 1, rng() * 2 - 1, rng() * 2 - 1]);
}

function makeBalls() {
  const balls = [];
  for (let id = 0; id < 16; id++) balls.push({ id, x: 0, y: 0, q: randQuat(), on: true });
  return balls;
}

function rack(balls) {
  const dx = Math.sqrt(3) * (R + RACK_GAP / 2);
  const dy = 2 * R + RACK_GAP;
  // (2,1) = 8; back corners one solid (7) and one stripe (13)
  const order = [1, 9, 2, 10, 8, 3, 11, 4, 12, 5, 13, 6, 14, 15, 7];
  let k = 0;
  for (let i = 0; i <= 4; i++) {
    for (let j = 0; j <= i; j++) {
      const b = balls[order[k++]];
      b.x = TABLE.footSpot.x + i * dx;
      b.y = (j - i / 2) * dy;
    }
  }
  balls[0].x = TABLE.headStringX - 0.16;
  balls[0].y = 0.07;
}

function scatter(balls) {
  const pos = {
    0: [-0.42, -0.12],
    1: [0.12, 0.05],
    2: [0.55, 0.3],
    3: [0.78, -0.38],
    4: [-0.2, 0.36],
    5: [0.33, -0.22],
    6: [-0.7, -0.4],
    7: [0.9, 0.2],
    8: [0.45, 0.02],
    9: [-0.05, -0.33],
    10: [0.62, -0.08],
    11: [-0.6, 0.25],
    12: [0.2, 0.42],
    13: [-0.85, 0.05],
    14: [0.05, 0.2],
    15: [0.74, 0.43],
  };
  for (const b of balls) [b.x, b.y] = pos[b.id];
  balls[12].on = false; // already pocketed
}

const balls = makeBalls();
if (P.get('face') === '1') {
  // local +x (a number disc) toward the viewer: numbers must read un-mirrored
  for (const b of balls) b.q = [Math.SQRT1_2, 0, -Math.SQRT1_2, 0];
}
if (sceneName === 'play') scatter(balls);
else rack(balls);

const renderer = new Renderer(canvas, { cloth: P.get('cloth') || 'green' });
const dpr = num('dpr', window.devicePixelRatio || 1);
const view = computeView(W, H);
const tCold = performance.now();
renderer.setView(view, dpr);
const setViewColdMs = performance.now() - tCold;

const cueBall = balls[0];
let aimAt = sceneName === 'play' ? balls[1] : balls[1];
let angle = Math.atan2(aimAt.y - cueBall.y, aimAt.x - cueBall.x);
if (sceneName === 'play') angle += 0.035; // a cut
if (P.has('angle')) angle = num('angle', angle);

function scene(time) {
  const bihMode = P.get('bih');
  const s = {
    time,
    balls,
    cue:
      P.get('cue') === '0'
        ? null
        : { x: cueBall.x, y: cueBall.y, angle, pull: num('pull', 0.4), stroke: num('stroke', 0), visible: true },
    guide: P.get('guide') === '0' ? null : { x: cueBall.x, y: cueBall.y, angle, length: num('glen', 0) },
    ballInHand: bihMode
      ? { x: cueBall.x, y: cueBall.y, valid: bihMode !== 'bad', dragging: bihMode === 'drag' }
      : null,
    targets: P.get('targets') === '1' ? [1, 2, 3, 4, 5, 6, 7] : [],
    pockets: P.get('pockets') === '1' ? { selectable: true, called: 2, suggested: 3 } : null,
  };
  if (bihMode && P.get('cue') !== '1') s.cue = null;
  return s;
}

if (P.get('drop') === '1') balls[9].on = false;
let dropStarted = false;
function maybeDrop(time) {
  if (P.get('drop') !== '1') return;
  if (!dropStarted || (P.get('anim') === '1' && Math.floor(time) !== Math.floor(time - 1 / 60))) {
    dropStarted = true;
    const b = balls[9];
    const p = TABLE.pockets[5];
    renderer.onPocket({ type: 'pocket', ball: 9, pocket: 5 }, { id: 9, x: p.x + 0.02, y: p.y + 0.02, q: b.q, on: false });
  }
}

if (P.get('perf') === '1') {
  runPerf();
} else if (P.get('anim') === '1') {
  const spinners = [1, 8, 9, 13, 0];
  let last = performance.now() / 1000;
  const loop = () => {
    const t = performance.now() / 1000;
    const dt = Math.min(0.05, t - last);
    last = t;
    for (const id of spinners) {
      const b = balls[id];
      quatIntegrate(b.q, 6 + id * 0.3, -4 + id * 0.2, 0.5, dt);
    }
    maybeDrop(t);
    renderer.draw(scene(t));
    info.textContent = `frame ${renderer.stats.frameMs.toFixed(2)} ms  sprites ${renderer.stats.sprites} (${renderer.stats.spriteMs.toFixed(2)} ms)`;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
} else {
  const t = num('t', 0.3);
  maybeDrop(t - 0.1);
  renderer.draw(scene(t - 0.1));
  renderer.draw(scene(t));
  window.__ready = true;
}

function runPerf() {
  const N = 200;
  const res = {};
  res.setViewColdMs = setViewColdMs;
  const t0 = performance.now();
  renderer.setView(computeView(W, H - 30), dpr); // same scale when width-limited, new offset
  res.setViewResizeMs = performance.now() - t0;
  renderer.setView(view, dpr);
  res.ballPx = Math.round(2 * R * renderer.ppm);
  res.canvas = `${canvas.width}x${canvas.height}`;
  // warm up
  for (let i = 0; i < 20; i++) {
    for (const b of balls) quatIntegrate(b.q, 5, 3, 1, 0.01);
    renderer.draw(scene(i / 60));
  }
  // worst case: all 16 balls rotate every frame
  let f = 0;
  let sp = 0;
  let spMax = 0;
  let fMax = 0;
  for (let i = 0; i < N; i++) {
    for (const b of balls) quatIntegrate(b.q, 5 + b.id, 3 - b.id * 0.4, 1, 0.01);
    renderer.draw(scene(i / 60));
    f += renderer.stats.frameMs;
    sp += renderer.stats.spriteMs;
    fMax = Math.max(fMax, renderer.stats.frameMs);
    spMax = Math.max(spMax, renderer.stats.spriteMs);
  }
  res.allMoving = { frameAvg: f / N, frameMax: fMax, spriteAvg: sp / N, spriteMax: spMax, spritesPerFrame: renderer.stats.sprites };
  // resting: nothing changes
  f = 0;
  fMax = 0;
  for (let i = 0; i < N; i++) {
    renderer.draw(scene(1 + i / 60));
    f += renderer.stats.frameMs;
    fMax = Math.max(fMax, renderer.stats.frameMs);
  }
  res.resting = { frameAvg: f / N, frameMax: fMax, spritesPerFrame: renderer.stats.sprites };
  window.__perf = res;
  info.textContent = JSON.stringify(res, null, 1);
  window.__ready = true;
}

// Click a pocket to see the hit test.
canvas.addEventListener('pointerdown', (e) => {
  const r = canvas.getBoundingClientRect();
  const id = renderer.pocketAtScreen(e.clientX - r.left, e.clientY - r.top);
  info.textContent = `pocketAtScreen -> ${id}`;
});
window.__renderer = renderer;
window.__view = view;
