// Visual preview for the renderer and camera rig, plus a synthetic HoleTerrain stub that the unit
// tests share (the DOM part only runs in a browser).
//
// URL params: ?course=pines|desert|water|links (default pines) and ?hole=N (1..9; without either
// the synthetic stub), ?cam= (or ?mode=) address|putt|read|flight|holed|map|flyover|free (with
// &eye=x,y,dz&at=x,y,dz: a fixed close-up camera, dz above the ground), ?t=S (advance
// the simulated clock by S seconds before the screenshot), ?gl1=1 (force WebGL1), ?read=1
// (green-read overlay), ?wind=x,y (m/s), ?pin=0..2, ?quality=low, ?anim=1 (keep animating).

import { Renderer } from '../../src/render.js';
import { CameraRig } from '../../src/camera.js';
import { buildPath } from '../../src/spline.js';
import { SURF } from '../../src/constants.js';
import { courseById } from '../../src/courses.js';
import { buildHole } from '../../src/terrain.js';

// ------------------------------------------------------------------------------------------
// Stub terrain: a 300 m par 4 running north (+y) over rolling ground, with a fairway strip, a green
// ellipse with fringe, a greenside bunker, a pond left of the fairway, trees and OOB stakes left.
export function stubTerrain() {
  const minX = -90;
  const maxX = 90;
  const minY = -40;
  const maxY = 340;
  const pathPts = [[0, 0], [6, 110], [-4, 220], [0, 290]];
  const path = buildPath(pathPts);
  const G = { cx: 0, cy: 290, rx: 14, ry: 12, rot: 0.2 };
  const bunker = { x: 15, y: 279, r: 5.5, depth: 0.7 };
  const pond = { x: -30, y: 150, r: 15, level: -0.6 };
  const greenZ = (x, y) => 4.2 + 0.02 * (x - G.cx) - 0.025 * (y - G.cy);
  const ellQ = (x, y) => {
    const c = Math.cos(G.rot);
    const s = Math.sin(G.rot);
    const dx = x - G.cx;
    const dy = y - G.cy;
    const u = (dx * c + dy * s) / G.rx;
    const v = (-dx * s + dy * c) / G.ry;
    return Math.hypot(u, v);
  };
  const sm = (a, b, x) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  function heightAt(x, y) {
    let z = 0.014 * y + 2.6 * Math.sin(x / 37 + 0.5) * Math.cos(y / 53) + 1.3 * Math.sin(y / 23 + x / 41);
    z += 0.004 * x * x * sm(30, 90, Math.abs(x)) * 0.25; // valley sides rise toward the edges
    // Tee pad.
    const tee = Math.max(Math.abs(x) - 5, Math.abs(y) - 8, 0);
    z += (0.6 - z) * (1 - sm(0, 5, tee));
    // Green: analytic tilted plane blended in.
    const q = ellQ(x, y);
    z += (greenZ(x, y) - z) * (1 - sm(1.05, 1.6, q));
    // Pond bed and bank.
    const dp = Math.hypot(x - pond.x, y - pond.y);
    if (dp < pond.r) z = pond.level - 1.2 * sm(0, 6, pond.r - dp);
    else if (dp < pond.r + 9) {
      const zb = pond.level + 0.12 * (dp - pond.r);
      z = zb + (z - zb) * sm(0, 9, dp - pond.r);
    }
    // Bunker bowl with a small lip.
    const db = Math.hypot(x - bunker.x, y - bunker.y);
    if (db < bunker.r) z -= bunker.depth * sm(0, 2, bunker.r - db);
    else if (db < bunker.r + 1.2) z += 0.15 * Math.sin(((db - bunker.r) / 1.2) * Math.PI);
    return z;
  }
  const gradAt = (x, y, out = { x: 0, y: 0 }) => {
    const e = 0.05;
    out.x = (heightAt(x + e, y) - heightAt(x - e, y)) / (2 * e);
    out.y = (heightAt(x, y + e) - heightAt(x, y - e)) / (2 * e);
    return out;
  };
  const normalAt = (x, y) => {
    const g = gradAt(x, y);
    const l = Math.sqrt(g.x * g.x + g.y * g.y + 1);
    return { x: -g.x / l, y: -g.y / l, z: 1 / l };
  };
  const isOOB = (x, y) => x < -70 || x < minX || x > maxX || y < minY || y > maxY;
  function surfaceAt(x, y) {
    if (isOOB(x, y)) return SURF.OOB;
    if (Math.hypot(x - pond.x, y - pond.y) < pond.r) return SURF.WATER;
    if (Math.hypot(x - bunker.x, y - bunker.y) < bunker.r) return SURF.BUNKER;
    const q = ellQ(x, y);
    if (q < 1) return SURF.GREEN;
    if (q < 1 + 1.4 / G.ry) return SURF.FRINGE;
    if (Math.abs(x) < 5 && Math.abs(y) < 8) return SURF.TEE;
    const pr = path.project(x, y);
    const w = 15 + 3 * Math.sin(pr.s / 30);
    if (pr.s > 45 && pr.s < 282 && Math.abs(pr.lat) < w) return SURF.FAIRWAY;
    return SURF.ROUGH;
  }
  const waterAt = (x, y) => (Math.hypot(x - pond.x, y - pond.y) < pond.r ? { kind: 'red', level: pond.level } : null);
  // Grids.
  const nx = maxX - minX + 1;
  const ny = maxY - minY + 1;
  const heights = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) heights[j * nx + i] = heightAt(minX + i, minY + j);
  const snx = (maxX - minX) * 2;
  const sny = (maxY - minY) * 2;
  const sdata = new Uint8Array(snx * sny);
  for (let j = 0; j < sny; j++) for (let i = 0; i < snx; i++) sdata[j * snx + i] = surfaceAt(minX + (i + 0.5) * 0.5, minY + (j + 0.5) * 0.5);
  // Trees: lines both sides plus a cluster right of the green.
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
  const trees = [];
  const addTree = (x, y) => {
    if (surfaceAt(x, y) !== SURF.ROUGH && surfaceAt(x, y) !== SURF.OOB) return;
    const pine = rnd() < 0.5;
    const t = pine
      ? { trunkR: 0.25, trunkH: 2.6 + rnd() * 1.4, rx: 2.2 + rnd(), rz: 5.5 + rnd() * 2.5 }
      : { trunkR: 0.32, trunkH: 2.8 + rnd(), rx: 3.6 + rnd() * 2, rz: 3.5 + rnd() * 1.5 };
    const z = heightAt(x, y);
    trees.push({ x, y, z, trunkR: t.trunkR, trunkH: t.trunkH, canopy: { cz: z + t.trunkH + t.rz * 0.8, rx: t.rx, rz: t.rz }, kind: pine ? 'pine' : 'broad' });
  };
  for (let y = 20; y < 330; y += 9) {
    addTree(-42 - rnd() * 20, y + rnd() * 5);
    addTree(38 + rnd() * 25, y + rnd() * 5);
    if (rnd() < 0.5) addTree(62 + rnd() * 25, y + rnd() * 5);
  }
  for (let k = 0; k < 7; k++) addTree(34 + rnd() * 14, 290 + rnd() * 30);
  const stakes = [];
  for (let y = -30; y < 335; y += 12) stakes.push({ x: -70, y, z: heightAt(-70, y) });
  const cup = { x: 3, y: 292, z: heightAt(3, 292) };
  const tee = { x: 0, y: 0, z: heightAt(0, 0) };
  const pondPoly = [];
  for (let k = 0; k < 24; k++) {
    const a = (k / 24) * Math.PI * 2;
    pondPoly.push({ x: pond.x + Math.cos(a) * pond.r, y: pond.y + Math.sin(a) * pond.r });
  }
  function raycast(o, d, maxT = 3000) {
    let prev = 0;
    for (let t = 0.25; t < maxT; t += Math.max(0.25, t * 0.02)) {
      if (o.z + d.z * t <= heightAt(o.x + d.x * t, o.y + d.y * t)) {
        let lo = prev;
        let hi = t;
        for (let k = 0; k < 24; k++) {
          const m = (lo + hi) / 2;
          if (o.z + d.z * m <= heightAt(o.x + d.x * m, o.y + d.y * m)) hi = m;
          else lo = m;
        }
        const x = o.x + d.x * hi;
        const y = o.y + d.y * hi;
        return { x, y, z: heightAt(x, y), t: hi };
      }
      prev = t;
    }
    return null;
  }
  return {
    n: 0, par: 4, name: 'Preview', si: 1, lengthM: path.length,
    bounds: { minX, minY, maxX, maxY },
    tee, cup, greenCenter: { x: G.cx, y: G.cy, z: heightAt(G.cx, G.cy) },
    green: { ...G },
    path, heightAt, gradAt, normalAt, surfaceAt, isOOB, waterAt,
    waters: [{ kind: 'red', level: pond.level, poly: pondPoly }],
    trees,
    treesNear: (x, y, r) => trees.filter((t) => Math.hypot(t.x - x, t.y - y) <= r + t.canopy.rx),
    stakes, raycast,
    aimPoint: () => ({ x: cup.x, y: cup.y }),
    grid: { nx, ny, minX, minY, step: 1, heights },
    sgrid: { nx: snx, ny: sny, minX, minY, step: 0.5, data: sdata },
  };
}

// Synthetic shot (parabola, then a short roll) in the ShotResult shape, for flight previews.
export function fakeShot(terrain, from, yaw, carry = 210, apex = 30, tFlight = 6) {
  const dx = Math.cos(yaw);
  const dy = Math.sin(yaw);
  const path = [];
  const hz = 60;
  const roll = carry * 0.08;
  const tEnd = tFlight + 2;
  for (let k = 0; k <= tEnd * hz; k++) {
    const t = k / hz;
    let s;
    let z;
    if (t <= tFlight) {
      const u = t / tFlight;
      s = carry * (u * (1.15 - 0.15 * u));
      const g = terrain.heightAt(from.x + dx * s, from.y + dy * s);
      z = from.z + (g - from.z) * u + apex * 4 * u * (1 - u) * (1 - 0.3 * u);
    } else {
      const u = Math.min(1, (t - tFlight) / 2);
      s = carry + roll * (1 - (1 - u) * (1 - u));
      z = terrain.heightAt(from.x + dx * s, from.y + dy * s) + 0.02;
    }
    path.push(t, from.x + dx * s, from.y + dy * s, z);
  }
  const L = { x: from.x + dx * carry, y: from.y + dy * carry };
  L.z = terrain.heightAt(L.x, L.y);
  const F = { x: from.x + dx * (carry + roll), y: from.y + dy * (carry + roll) };
  F.z = terrain.heightAt(F.x, F.y);
  return {
    path: new Float32Array(path),
    events: [{ type: 'launch', t: 0, ...from }, { type: 'land', t: tFlight, ...L }, { type: 'rest', t: tEnd, ...F }],
    final: { ...F, outcome: 'rest' },
    landing: L,
    carry, total: carry + roll, apex, t: tEnd,
  };
}

// Ball position and trail prefix at playback time t.
export function samplePath(res, t) {
  const p = res.path;
  const n = p.length / 4;
  const k = Math.min(n - 1, Math.max(0, Math.round(t * 60)));
  const trail = new Float32Array((k + 1) * 3);
  for (let q = 0; q <= k; q++) {
    trail[q * 3] = p[q * 4 + 1];
    trail[q * 3 + 1] = p[q * 4 + 2];
    trail[q * 3 + 2] = p[q * 4 + 3];
  }
  return { ball: { x: p[k * 4 + 1], y: p[k * 4 + 2], z: p[k * 4 + 3] }, trail: { data: trail, count: k + 1 } };
}

// ------------------------------------------------------------------------------------------
if (typeof document !== 'undefined') main();

function main() {
  const qs = new URLSearchParams(location.search);
  const course = courseById(qs.get('course') || 'pines');
  const holeN = parseInt(qs.get('hole') || (qs.get('course') ? '1' : '0'), 10);
  const mode = qs.get('cam') || qs.get('mode') || 'address';
  const tAdv = parseFloat(qs.get('t') || '0');
  const windQ = (qs.get('wind') || '3,1.5').split(',').map(Number);
  const wind = { x: windQ[0] || 0, y: windQ[1] || 0 };
  const canvas = document.getElementById('c');
  const info = document.getElementById('info');
  const t0 = performance.now();
  const def = holeN >= 1 ? course.holes[holeN - 1] : null;
  const terrain = def ? buildHole(def, { pinIndex: parseInt(qs.get('pin') || '0', 10), seed: 1, course }) : stubTerrain();
  const tBuild = performance.now() - t0;
  const renderer = new Renderer(canvas, { test: true, gl1: qs.get('gl1') === '1', quality: qs.get('quality') || 'auto' });
  if (!renderer.ok) {
    info.textContent = 'WebGL unavailable';
    document.body.dataset.ready = '1';
    return;
  }
  const t1 = performance.now();
  renderer.setHole(terrain);
  const tSet = performance.now() - t1;
  const rig = new CameraRig();
  const resize = () => {
    renderer.resize(window.innerWidth, window.innerHeight, window.devicePixelRatio || 1);
  };
  resize();
  window.addEventListener('resize', resize);

  const tee = { x: terrain.tee.x, y: terrain.tee.y, z: terrain.tee.z + 0.03 };
  const aimP = terrain.aimPoint ? terrain.aimPoint(tee) : terrain.cup;
  const aimYaw = Math.atan2(aimP.y - tee.y, aimP.x - tee.x);
  let ball = { ...tee };
  let yaw = aimYaw;
  // Putt / read: put the ball on the green 7 m short of the cup.
  if (mode === 'putt' || mode === 'read' || mode === 'holed') {
    const g = terrain.greenCenter;
    const c = terrain.cup;
    let dx = g.x - c.x - 7;
    let dy = g.y - c.y - 5;
    const l = Math.hypot(dx, dy) || 1;
    dx /= l;
    dy /= l;
    ball = { x: c.x + dx * 7, y: c.y + dy * 7 };
    ball.z = terrain.heightAt(ball.x, ball.y) + 0.0214;
    yaw = Math.atan2(c.y - ball.y, c.x - ball.x);
  }
  const shotRes = fakeShot(terrain, tee, aimYaw, Math.min(230, terrain.lengthM * 0.65));
  const shot = { result: shotRes, playT: 0 };
  const ctx = () => ({ ball, aimYaw: yaw, cup: terrain.cup, terrain, shot, aspect: window.innerWidth / window.innerHeight });
  rig.setMode(mode, ctx());
  let simT = 0;
  let trail = null;
  const step = (dt) => {
    simT += dt;
    if (mode === 'flight') {
      shot.playT = Math.min(simT, shotRes.t);
      const s = samplePath(shotRes, shot.playT);
      ball = s.ball;
      trail = s.trail;
    }
    if (mode === 'read') rig.orbit(dt * 0.05);
    return rig.update(dt, ctx());
  };
  // Advance the clock in fixed steps before the first frame (deterministic screenshots).
  let cam = step(0);
  for (let t = 0; t < tAdv; t += 1 / 30) cam = step(1 / 30);
  // ?cam=free&eye=x,y,dz&at=x,y,dz: a fixed camera (dz above the ground) for close-ups.
  if (mode === 'free') {
    const v = (k, d) => (qs.get(k) || d).split(',').map(Number);
    const [ex, ey, ez] = v('eye', '0,-20,8');
    const [ax, ay, az] = v('at', '0,60,0');
    cam = {
      ...cam,
      eye: { x: ex, y: ey, z: terrain.heightAt(ex, ey) + ez },
      target: { x: ax, y: ay, z: terrain.heightAt(ax, ay) + az },
      up: { x: 0, y: 0, z: 1 },
      shiftX: 0,
    };
  }
  const frameDraw = () => {
    renderer.draw({
      time: simT,
      cam,
      ball: { ...ball, visible: true },
      trail,
      aim: mode === 'address' ? { x: ball.x, y: ball.y, z: ball.z, yaw, carry: Math.min(230, terrain.lengthM * 0.65) } : mode === 'putt' ? { x: ball.x, y: ball.y, z: ball.z, yaw, carry: 7 } : null,
      pin: { visible: true },
      wind,
      read: { on: qs.get('read') === '1' || mode === 'read' || mode === 'putt' },
    });
  };
  frameDraw();
  const st = renderer.stats();
  info.textContent = `${def ? course.name + ' ' + holeN + ' ' : ''}${terrain.name} ${mode} | build ${tBuild.toFixed(0)} ms, setHole ${tSet.toFixed(0)} ms | ${st.drawCalls} draws, ${(st.tris / 1000).toFixed(0)}k tris, ${renderer.ctx.gl2 ? 'WebGL2' : 'WebGL1'}`;
  window.__preview = { renderer, rig, terrain, stats: st, tBuild, tSet };
  document.body.dataset.ready = '1';
  if (qs.get('anim') === '1') {
    let last = performance.now();
    const loop = (now) => {
      cam = step(Math.min(0.05, (now - last) / 1000));
      last = now;
      frameDraw();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }
}
