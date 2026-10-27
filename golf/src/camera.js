// Camera rig (pure maths, no DOM). Produces {eye, target, up, fovY, near, far} for the renderer.
//
// Modes
//   address  behind the golfer, ADDRESS_H above the ball, looking down the aim line; distance
//            and pitch from addressFraming(aspect) put the ball low on the screen (in the swing
//            arc) and the horizon in the upper half on every aspect
//   putt     low behind the ball (further back and higher for long putts), looking along the
//            putt line with the ball low on the screen
//   read     orbit above the green (orbit(dyaw) from a drag); target between ball and cup
//   flight   TV sequence: (1) tracking shot from behind the golfer that tilts up with the ball,
//            (2) a lagging chase cam, (3) a cut to a landing camera set up beside and beyond
//            shot.landing (known in advance), which then follows the ball until it stops
//   holed    slow orbit around the cup
//   map      high overview between ball and cup, oriented so the hole plays up the screen
//   flyover  5 s along terrain.path from the tee, ending looking at the green
//
// Every frame the eye is pushed to >= 1 m above the terrain (0.3 m in putt mode), and position and
// target are smoothed with frame-rate independent exponential damping. fovY comes from a 55 degree
// horizontal FOV for the current aspect, clamped to 40..75 degrees.
//
// ctx: {ball:{x,y,z}, aimYaw, cup:{x,y,z}, terrain, shot, aspect}. shot may be the game's
// {result, playT, launch} or a bare ShotResult; landing comes from result.landing (or the first
// 'land' event), the landing time from that event's t, and the clock from shot.playT when present
// (otherwise the rig's own time since setMode).

import { yawDir, damp, clamp, lerp } from './vec3.js';

const DEG = Math.PI / 180;
export const HFOV = 55 * DEG;
export const FLYOVER_T = 5;

export function fovForAspect(aspect) {
  const a = aspect > 0 ? aspect : 1;
  const f = 2 * Math.atan(Math.tan(HFOV / 2) / a);
  return clamp(f, 40 * DEG, 75 * DEG);
}

// Address framing. The HUD puts the swing pad (and its power arc) in the lower part of the
// screen, so the camera sits behind the ball at ADDRESS_H above it and is pitched down so that
// the ball projects low on the screen (NDC y = yBall: inside the arc) while the horizon lands at
// NDC y = yHorizon. Solving for those two screen positions makes the shot look the same on any
// aspect: in landscape (vertical FOV 40 deg) the eye ends up ~5 m back, in portrait (75 deg)
// ~2.4 m back. Returns {back, h, pitch} (m, m, rad below horizontal).
export const ADDRESS_H = 1.6;
export function addressFraming(aspect) {
  const T = Math.tan(fovForAspect(aspect) / 2);
  const wide = aspect >= 1;
  const yBall = wide ? -0.7 : -0.6;
  const yHorizon = wide ? 0.12 : 0.22;
  const pitch = Math.atan(yHorizon * T);
  const toBall = pitch + Math.atan(-yBall * T);
  return { back: ADDRESS_H / Math.tan(toBall), h: ADDRESS_H, pitch };
}

// Eye and target `back` m behind `ball` along dir, `h` m above it, looking down at `pitch`.
function behindBall(ball, dir, back, h, pitch) {
  const eye = { x: ball.x - dir.x * back, y: ball.y - dir.y * back, z: ball.z + h };
  const L = 40;
  const c = Math.cos(pitch) * L;
  return { eye, target: { x: eye.x + dir.x * c, y: eye.y + dir.y * c, z: eye.z - Math.sin(pitch) * L } };
}

const groundZ = (terrain, x, y) => (terrain && terrain.heightAt ? terrain.heightAt(x, y) : 0);

function shotInfo(shot) {
  if (!shot) return null;
  const res = shot.result || shot;
  const events = res.events || [];
  const land = events.find((ev) => ev.type === 'land');
  const landing = res.landing || (land ? { x: land.x, y: land.y, z: land.z } : null);
  const fin = res.final || null;
  return {
    res,
    landing,
    tLand: land ? land.t : null,
    final: fin,
    tEnd: res.t || (events.length ? events[events.length - 1].t : 0),
    playT: typeof shot.playT === 'number' ? shot.playT : null,
    launch: shot.launch || null,
  };
}

export class CameraRig {
  constructor() {
    this.mode = 'address';
    this.ctx = {};
    this.t = 0; // seconds since setMode
    this.eye = { x: 0, y: -5, z: 2 };
    this.target = { x: 0, y: 10, z: 0 };
    this.up = { x: 0, y: 0, z: 1 };
    this.fovY = 60 * DEG;
    this.readYaw = 0;
    this.snap = true; // first update jumps straight to the goal
    this.flight = null;
  }

  setMode(mode, ctx = {}) {
    this.mode = mode;
    this.ctx = { ...this.ctx, ...ctx };
    this.t = 0;
    const c = this.ctx;
    if (mode === 'read') {
      // Start the orbit from behind the ball looking at the hole.
      const b = c.ball || c.cup;
      const cup = c.cup || b;
      this.readYaw = b && cup && (b.x !== cup.x || b.y !== cup.y) ? Math.atan2(b.y - cup.y, b.x - cup.x) : (c.aimYaw || 0) + Math.PI;
    }
    if (mode === 'flight') this._setupFlight();
    if (mode === 'flyover') this.snap = true; // the flyover starts with a cut to the tee
  }

  orbit(dyaw) {
    this.readYaw += dyaw;
  }

  _setupFlight() {
    const c = this.ctx;
    const info = shotInfo(c.shot);
    const ball = c.ball || { x: 0, y: 0, z: 0 };
    const dir = yawDir(c.aimYaw || 0);
    const start = { x: ball.x, y: ball.y, z: ball.z };
    const f = { info, start, dir, phase: 'tv', landCam: null, cutT: Infinity };
    if (info && info.landing) {
      const L = info.landing;
      const dx = L.x - start.x;
      const dy = L.y - start.y;
      const carry = Math.hypot(dx, dy);
      if (carry > 45) {
        // TV landing camera: beyond the landing spot and off to the side, looking back at the ball.
        const ux = dx / carry;
        const uy = dy / carry;
        const side = 0.32 * Math.min(60, 12 + carry * 0.12);
        const ahead = Math.min(45, 14 + carry * 0.1);
        const x = L.x + ux * ahead + uy * side;
        const y = L.y + uy * ahead - ux * side;
        f.landCam = { x, y, z: Math.max(L.z, groundZ(c.terrain, x, y)) + 4.5 + carry * 0.012 };
        // Cut ~1.6 s before touchdown (or 70% of the way if no event time).
        f.cutT = info.tLand != null ? Math.max(1.2, info.tLand - 1.7) : Infinity;
        f.carry = carry;
      }
    }
    this.flight = f;
  }

  // Goal eye/target for the current mode (before damping and terrain clearance).
  _goal(dt) {
    const c = this.ctx;
    const T = c.terrain;
    const ball = c.ball || { x: 0, y: 0, z: 0 };
    const cup = c.cup || (T && T.cup) || { x: ball.x + 100, y: ball.y, z: ball.z };
    const dir = yawDir(c.aimYaw || 0);
    let eye;
    let target;
    let lambda = 5;
    let up = { x: 0, y: 0, z: 1 };
    let clear = 1;
    switch (this.mode) {
      case 'putt': {
        // Low behind the ball; further back and higher for longer putts so the cup stays on
        // screen. Pitched so the ball sits low (inside the swing arc) on any aspect.
        const d = Math.hypot(cup.x - ball.x, cup.y - ball.y);
        const back = clamp(1.3 + d * 0.12, 1.3, 4.5);
        const h = clamp(0.85 + d * 0.05, 0.85, 2.2);
        const yBall = (c.aspect || 1) >= 1 ? -0.6 : -0.55;
        const pitch = Math.atan2(h, back) - Math.atan(-yBall * Math.tan(fovForAspect(c.aspect || 1) / 2));
        ({ eye, target } = behindBall(ball, dir, back, h, pitch));
        clear = 0.3;
        lambda = 6;
        break;
      }
      case 'read': {
        const mx = (ball.x + cup.x) / 2;
        const my = (ball.y + cup.y) / 2;
        const d = Math.hypot(cup.x - ball.x, cup.y - ball.y);
        const r = clamp(d * 0.75 + 7, 9, 30);
        const mz = groundZ(T, mx, my);
        eye = { x: mx + Math.cos(this.readYaw) * r, y: my + Math.sin(this.readYaw) * r, z: mz + r * 0.95 };
        target = { x: mx, y: my, z: mz };
        lambda = 7;
        break;
      }
      case 'holed': {
        const a = this.t * 0.25 + (c.aimYaw || 0) + Math.PI;
        eye = { x: cup.x + Math.cos(a) * 3.2, y: cup.y + Math.sin(a) * 3.2, z: cup.z + 1.3 };
        target = { x: cup.x, y: cup.y, z: cup.z + 0.2 };
        lambda = 3;
        break;
      }
      case 'map': {
        const mx = (ball.x + cup.x) / 2;
        const my = (ball.y + cup.y) / 2;
        const d = Math.hypot(cup.x - ball.x, cup.y - ball.y);
        const fov = fovForAspect(c.aspect || 1);
        const h = clamp((d * 0.62 + 30) / Math.tan(fov / 2), 60, 900);
        const hx = d > 1 ? (cup.x - ball.x) / d : dir.x;
        const hy = d > 1 ? (cup.y - ball.y) / d : dir.y;
        // Slightly tilted (eye behind the midpoint) so the view has depth and up is well defined.
        eye = { x: mx - hx * h * 0.18, y: my - hy * h * 0.18, z: groundZ(T, mx, my) + h };
        target = { x: mx, y: my, z: groundZ(T, mx, my) };
        up = { x: hx, y: hy, z: 0 };
        lambda = 4;
        break;
      }
      case 'flyover': {
        const P = T && T.path;
        const L = P ? P.length : Math.hypot(cup.x - ball.x, cup.y - ball.y);
        const u = clamp(this.t / FLYOVER_T, 0, 1);
        const s = (u * u * (3 - 2 * u)) * Math.max(0, L - 35);
        const at = (q) => (P ? P.pointAt(q) : { x: ball.x + dir.x * q, y: ball.y + dir.y * q });
        const p = at(s);
        const tg = P ? P.tangentAt(s) : dir;
        const look = at(Math.min(L, s + 70));
        const height = lerp(30, 14, u);
        eye = { x: p.x - tg.x * 12, y: p.y - tg.y * 12, z: groundZ(T, p.x, p.y) + height };
        const gx = u > 0.85 ? cup.x : look.x;
        const gy = u > 0.85 ? cup.y : look.y;
        target = { x: gx, y: gy, z: groundZ(T, gx, gy) };
        lambda = 3.5;
        break;
      }
      case 'flight':
        return this._flightGoal(dt);
      default: {
        // address: behind the ball, framed for the aspect (see addressFraming)
        const f = addressFraming(c.aspect || 1);
        ({ eye, target } = behindBall(ball, dir, f.back, f.h, f.pitch));
        lambda = 6;
      }
    }
    return { eye, target, lambda, up, clear };
  }

  _flightGoal() {
    const c = this.ctx;
    const T = c.terrain;
    const ball = c.ball || { x: 0, y: 0, z: 0 };
    let f = this.flight;
    if (!f) {
      this._setupFlight();
      f = this.flight;
    }
    // Shot clock: the game's playback time (it mutates shot.playT) or our own time since setMode.
    const pt = c.shot && typeof c.shot.playT === 'number' ? c.shot.playT : this.t;
    const dx = ball.x - f.start.x;
    const dy = ball.y - f.start.y;
    const travelled = Math.hypot(dx, dy);
    const up = { x: 0, y: 0, z: 1 };
    if (f.landCam && pt >= f.cutT) {
      if (f.phase !== 'land') {
        f.phase = 'land';
        this.snap = true; // hard cut like a TV director
      }
      // Landing camera holds position and pans with the ball; if the ball runs far away, follow it.
      const lc = f.landCam;
      const away = Math.hypot(ball.x - lc.x, ball.y - lc.y);
      let eye = lc;
      if (away > 55) {
        const k = (away - 45) / away;
        eye = { x: lc.x + (ball.x - lc.x) * k, y: lc.y + (ball.y - lc.y) * k, z: lc.z };
      }
      return { eye, target: { x: ball.x, y: ball.y, z: ball.z }, lambda: 9, up, clear: 1 };
    }
    if (f.phase === 'tv' && (pt > 1.6 || travelled > 70)) f.phase = 'chase';
    if (f.phase === 'tv') {
      // Behind the golfer, rising a little; target tracks the ball so the camera tilts up with it.
      const eye = { x: f.start.x - f.dir.x * 4.5, y: f.start.y - f.dir.y * 4.5, z: f.start.z + 1.8 + pt * 0.8 };
      return { eye, target: { x: ball.x, y: ball.y, z: ball.z }, lambda: 10, up, clear: 1 };
    }
    // Chase: behind and above the ball along its direction of travel, lagging (lower lambda).
    const hx = travelled > 1 ? dx / travelled : f.dir.x;
    const hy = travelled > 1 ? dy / travelled : f.dir.y;
    const back = 22;
    const eye = {
      x: ball.x - hx * back,
      y: ball.y - hy * back,
      z: Math.max(ball.z, groundZ(T, ball.x, ball.y)) + 6,
    };
    const target = { x: ball.x + hx * 12, y: ball.y + hy * 12, z: ball.z };
    return { eye, target, lambda: 2.2, up, clear: 1 };
  }

  update(dt, ctx) {
    if (ctx) this.ctx = { ...this.ctx, ...ctx };
    dt = clamp(dt || 0, 0, 0.25);
    this.t += dt;
    const c = this.ctx;
    const T = c.terrain;
    const g = this._goal(dt);
    // Terrain clearance applied to the goal (so damping never drags the eye through a hill).
    const minZ = (x, y) => groundZ(T, x, y) + g.clear;
    g.eye.z = Math.max(g.eye.z, minZ(g.eye.x, g.eye.y));
    if (this.snap) {
      this.eye = { ...g.eye };
      this.target = { ...g.target };
      this.up = { ...g.up };
      this.snap = false;
    } else {
      const k = g.lambda;
      this.eye = {
        x: damp(this.eye.x, g.eye.x, k, dt),
        y: damp(this.eye.y, g.eye.y, k, dt),
        z: damp(this.eye.z, g.eye.z, k, dt),
      };
      this.target = {
        x: damp(this.target.x, g.target.x, k * 1.3, dt),
        y: damp(this.target.y, g.target.y, k * 1.3, dt),
        z: damp(this.target.z, g.target.z, k * 1.3, dt),
      };
      const ux = damp(this.up.x, g.up.x, k, dt);
      const uy = damp(this.up.y, g.up.y, k, dt);
      const uz = damp(this.up.z, g.up.z, k, dt);
      const ul = Math.hypot(ux, uy, uz) || 1;
      this.up = { x: ux / ul, y: uy / ul, z: uz / ul };
    }
    // Hard guarantee after damping too (the path between two clear points can dip into a valley side).
    this.eye.z = Math.max(this.eye.z, minZ(this.eye.x, this.eye.y));
    // Never look straight along up (degenerate view): nudge the target if needed.
    if (Math.hypot(this.target.x - this.eye.x, this.target.y - this.eye.y) < 1e-3 && this.up.z > 0.99) {
      this.target.x += 1e-2;
    }
    this.fovY = fovForAspect(c.aspect || 1);
    const near = this.mode === 'putt' ? 0.08 : this.mode === 'address' ? 0.15 : 0.3;
    return {
      eye: { ...this.eye },
      target: { ...this.target },
      up: { ...this.up },
      fovY: this.fovY,
      near,
      far: 6000,
    };
  }
}
