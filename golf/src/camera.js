// Camera rig (pure maths, no DOM). Produces {eye, target, up, fovY, near, far} for the renderer.
//
// Modes
//   address  behind the ball looking down the aim line; height, distance and pitch from
//            addressFraming(aspect, {dist, dz}) put the ball low on the screen (in the swing arc)
//            and the shot's target just above the centre, raising the eye for long shots and
//            whenever a ridge would hide the landing area
//   putt     low behind the ball (further back and higher for long putts), looking along the
//            putt line with the ball low on the screen
//   read     reading the putt (setReadView): 'orbit' above the green (orbit(dyaw) from a drag;
//            the default), 'ball' low behind the ball looking down the line at the hole, 'hole'
//            low behind the hole looking back at the ball, 'overhead' straight down on ball and
//            hole with the line running up the screen (ctx.lineLat: the read's bulge, m, so a
//            big breaker fits). A drag in a preset view continues as an orbit from where it is.
//   flight   TV sequence: (1) tracking shot from behind the golfer that tilts up with the ball,
//            (2) a lagging chase cam, (3) a cut to a landing camera set up beside and beyond
//            shot.landing (known in advance), which then follows the ball until it stops
//   holed    slow orbit around the cup
//   map      high overview between ball and cup, oriented so the hole plays up the screen
//   relief   water relief: looks down on the entry, the drop spot and (if near) the replay spot,
//            in the part of the screen the decision sheet leaves free (ctx.relief)
//   flyover  5 s along terrain.path from the tee, ending looking at the green
//
// Every frame the eye is pushed to >= 1 m above the terrain (0.3 m in putt mode), and position and
// target are smoothed with frame-rate independent exponential damping. fovY comes from a 55 degree
// horizontal FOV for the current aspect, clamped to 40..75 degrees.
//
// ctx: {ball:{x,y,z}, aimYaw, cup:{x,y,z}, terrain, shot, aspect, carry?, padShift?, relief?}. carry is the
// club's carry (m) for the address framing; padShift the NDC x of the swing pad's centre (a lens
// shift for address and putt, output as shiftX). shot may be the game's
// {result, playT, launch} or a bare ShotResult; landing comes from result.landing (or the first
// 'land' event), the landing time from that event's t, and the clock from shot.playT when present
// (otherwise the rig's own time since setMode).

import { yawDir, damp, clamp, lerp } from './vec3.js';

const DEG = Math.PI / 180;
export const HFOV = 55 * DEG;
export const FLYOVER_T = 5;
export const FLIGHT_HOLD = 0.6; // s the flight camera holds on the golfer's follow-through (ctx.golfer)
const RELIEF_SHIFT = 0.48; // landscape relief view: points on the right, the sheet on the left

export function fovForAspect(aspect) {
  const a = aspect > 0 ? aspect : 1;
  const f = 2 * Math.atan(Math.tan(HFOV / 2) / a);
  return clamp(f, 40 * DEG, 75 * DEG);
}

// Address framing. The HUD puts the swing pad (and its power arc) in the lower part of the
// screen, so the ball must project low (NDC y = yBall, inside the arc), while the shot's target
// (the landing point `dist` m down the aim line, `dz` m above the ball's ground) sits a little
// above the centre (NDC y = yTarget). A low eye flattens everything past ~60 m into a few pixels
// at the horizon (the green and flag vanish, a pond behind a convex bank is hidden), so the eye
// rises with the target distance: ADDRESS_H for anything within ADDRESS_NEAR, up to
// ADDRESS_H_MAX for a drive, which gives the landing area a few degrees of grazing angle. Given
// the height, the distance back is solved (bisection) so both screen positions hold on any
// aspect; landscape puts the ball higher (the arc is beside it, see `shiftX` in update()).
// Returns {back, h, pitch, yBall, yTarget, dist} (m, m, rad below horizontal, NDC, NDC, m).
export const ADDRESS_H = 1.6;
export const ADDRESS_H_MAX = 9;
export const ADDRESS_NEAR = 40; // m
// The rise per metre scales with the vertical field of view: a narrow (landscape) view needs less
// height for the same look, and would otherwise have to back far away to fit ball and target.
export function addressEyeH(dist, aspect = 0.5) {
  const k = 0.05 * (Math.tan(fovForAspect(aspect) / 2) / Math.tan((75 * DEG) / 2));
  return clamp(ADDRESS_H + k * (dist - ADDRESS_NEAR), ADDRESS_H, ADDRESS_H_MAX);
}
export function addressFraming(aspect, { dist = 0, dz = 0, h = null } = {}) {
  const T = Math.tan(fovForAspect(aspect) / 2);
  const wide = aspect >= 1;
  const yBall = wide ? -0.45 : -0.6;
  const yTarget = wide ? 0.3 : 0.12;
  const D = Math.max(dist, ADDRESS_NEAR);
  const hh = h ?? addressEyeH(D, aspect);
  const below = Math.atan(-yBall * T);
  // Angle between ball and target seen from `b` m behind the ball; it shrinks as b grows.
  const want = below + Math.atan(yTarget * T);
  const sep = (b) => Math.atan(hh / b) - Math.atan((hh - dz) / (b + D));
  let lo = 0.3;
  let hi = 30;
  if (sep(hi) > want) lo = hi;
  for (let i = 0; i < 40 && lo < hi; i++) {
    const mid = 0.5 * (lo + hi);
    if (sep(mid) > want) lo = mid;
    else hi = mid;
  }
  const back = 0.5 * (lo + hi);
  return { back, h: hh, pitch: Math.atan(hh / back) - below, yBall, yTarget, dist: D };
}

// TV framing with the golfer (section 9.7): the camera stands on the target line behind the ball,
// as close as lets the golfer's whole figure (club at the top included) stay within hWant of the
// screen height and the golfer and ball fit side by side: the golfer up to xWant (NDC) from the
// centre on his side (left third for a right-hander, right third for a left-hander) and the ball
// up to ballMax the other way (portrait: a lens shift moves both, `shift` = the ball's NDC x, so
// the ball stays in the swing arc; landscape centres the view on the pad instead, ctx.padShift).
// Then the eye height is solved so the ball projects at yBall (in the arc) and the shot's target
// (`dist` m down the line, `dz` m above the ball's ground) at yTarget, within [hMin, hMax].
// Putts: the eye height follows the putt length instead (the cup is near; a short putt is seen
// from lower so ball and cup separate), and landscape lets the golfer stand taller (puttHWant: a
// putter never goes above his waist) so the eye comes in close enough that the putt line is more
// than a few dozen pixels on the short screen. lat: the golfer's stance centre across the line (m, + =
// left of it), along: its offset along the line from the ball (m, + toward the target), H: his
// height (m).
// Returns {back, h, pitch, yBall, yTarget, dist, F, golferX, shift, below} (golferX: the golfer's
// NDC x).
export const GOLFER_FRAME = {
  portrait: { xWant: 0.48, ballMax: 0.32, hWant: 0.74, hMin: 1.45, hMax: 3.6, yBall: -0.6, yTarget: 0.15, puttBall: -0.55 },
  landscape: { xWant: 0.3, ballMax: 0, hWant: 0.84, hMin: 1.25, hMax: 3.2, yBall: -0.45, yTarget: 0.3, puttBall: -0.45, puttHWant: 1.3 },
};
export function golferFraming(aspect, { dist = 150, dz = 0, lat = 0.75, along = 0, H = 1.8, putt = false } = {}) {
  const T = Math.tan(fovForAspect(aspect) / 2);
  const wide = aspect >= 1;
  const K = wide ? GOLFER_FRAME.landscape : GOLFER_FRAME.portrait;
  const yBall = putt ? K.puttBall : K.yBall;
  const L = Math.max(0.3, Math.abs(lat));
  const side = lat < 0 ? -1 : 1;
  // Eye-to-golfer distance: golfer and ball fit side by side, and he is no taller than hWant.
  const hWant = (putt && K.puttHWant) || K.hWant;
  const F = Math.max(L / ((K.xWant + K.ballMax) * T * aspect), (H + 0.4) / (hWant * T), 2.6);
  const sep = L / F / (T * aspect);
  const shift = sep > K.xWant ? side * (sep - K.xWant) : 0;
  const back = Math.max(2.2, F - along);
  const below = Math.atan(-yBall * T);
  const D = Math.max(dist, putt ? 0.3 : 8);
  let h;
  if (putt) {
    h = clamp(1.35 + 0.05 * D, 1.35, 2.6);
  } else {
    const yAt = (hh) => Math.tan(Math.atan(hh / back) - below - Math.atan((hh - dz) / (back + D))) / T;
    let lo = K.hMin;
    let hi = K.hMax;
    if (yAt(hi) <= K.yTarget) h = hi;
    else if (yAt(lo) >= K.yTarget) h = lo;
    else {
      for (let i = 0; i < 32; i++) {
        const mid = 0.5 * (lo + hi);
        if (yAt(mid) < K.yTarget) lo = mid;
        else hi = mid;
      }
      h = 0.5 * (lo + hi);
    }
  }
  return { back, h, pitch: Math.atan(h / back) - below, yBall, yTarget: K.yTarget, dist: D, F, golferX: shift - side * sep, shift, below };
}

// Framing for a low view down a line (the read cameras): from the near point (projected at NDC
// y = yNear) to the far one `dist` m away and `dz` m higher (at NDC y = yFar), seen from `h` m
// above the near point. Solves the distance back like addressFraming (no 40 m floor).
// Returns {back, h, pitch}.
export function lineFraming(aspect, { dist = 5, dz = 0, h = 1.2, yNear = -0.55, yFar = 0.2 } = {}) {
  const T = Math.tan(fovForAspect(aspect) / 2);
  const D = Math.max(0.5, dist);
  const below = Math.atan(-yNear * T);
  const want = below + Math.atan(yFar * T);
  const sep = (b) => Math.atan(h / b) - Math.atan((h - dz) / (b + D));
  let lo = 0.3;
  let hi = 40;
  if (sep(hi) > want) lo = hi;
  for (let i = 0; i < 40 && lo < hi; i++) {
    const mid = 0.5 * (lo + hi);
    if (sep(mid) > want) lo = mid;
    else hi = mid;
  }
  const back = 0.5 * (lo + hi);
  return { back, h, pitch: Math.atan(h / back) - below };
}

export const READ_VIEWS = ['orbit', 'ball', 'hole', 'overhead'];

// Is the straight line from eye to p clear of the terrain (with a margin)?
function sightClear(terrain, eye, p, margin = 0.3) {
  if (!terrain || !terrain.heightAt) return true;
  for (let k = 2; k <= 19; k++) {
    const f = k / 20;
    const x = eye.x + (p.x - eye.x) * f;
    const y = eye.y + (p.y - eye.y) * f;
    if (terrain.heightAt(x, y) > eye.z + (p.z - eye.z) * f - margin) return false;
  }
  return true;
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
    this.readView = 'orbit';
    this.snap = true; // first update jumps straight to the goal
    this.flight = null;
    this.framing = null; // last address framing (tests, HUD)
    this.snap0 = true;
    this.shiftX = 0; // NDC lens shift (landscape: the ball sits under the swing arc on the right)
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
      this.readView = 'orbit';
    }
    if (mode === 'flight') this._setupFlight();
    if (mode === 'flyover') this.snap = true; // the flyover starts with a cut to the tee
  }

  orbit(dyaw) {
    if (this.mode === 'read' && this.readView !== 'orbit') {
      // Carry on from where the preset view is, as an orbit round the ball-cup midpoint.
      const c = this.ctx;
      const b = c.ball || { x: 0, y: 0 };
      const cup = c.cup || b;
      this.readYaw = Math.atan2(this.eye.y - (b.y + cup.y) / 2, this.eye.x - (b.x + cup.x) / 2);
      this.readView = 'orbit';
    }
    this.readYaw += dyaw;
  }

  // Read sub-view: 'orbit' | 'ball' | 'hole' | 'overhead' (see the header).
  setReadView(v) {
    if (!READ_VIEWS.includes(v)) return;
    if (v === 'orbit' && this.readView !== 'orbit') {
      this.readView = 'ball';
      this.orbit(0);
      return;
    }
    this.readView = v;
  }

  _setupFlight() {
    const c = this.ctx;
    const info = shotInfo(c.shot);
    const ball = c.ball || { x: 0, y: 0, z: 0 };
    const dir = yawDir(c.aimYaw || 0);
    const start = { x: ball.x, y: ball.y, z: ball.z };
    const f = { info, start, dir, phase: 'tv', landCam: null, cutT: Infinity, hold: null, holding: false };
    // With the golfer in view (ctx.golfer) the TV shot first holds the address framing for
    // FLIGHT_HOLD s of the shot clock (the follow-through and the ball leaving), then pans with it.
    if (c.golfer) f.hold = { eye: { ...this.eye }, target: { ...this.target }, T: FLIGHT_HOLD };
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
        if (c.golfer) {
          ({ eye, target } = this._golferGoal(ball, dir, cup, true));
          clear = 0.3;
          lambda = 6;
          break;
        }
        // Low behind the ball; further back and higher for longer putts so the cup stays on
        // screen. Pitched so the ball sits low (inside the swing arc) on any aspect.
        const d = Math.hypot(cup.x - ball.x, cup.y - ball.y);
        const back = clamp(1.3 + d * 0.12, 1.3, 4.5);
        const h = clamp(0.85 + d * 0.05, 0.85, 2.2);
        const yBall = (c.aspect || 1) >= 1 ? -0.45 : -0.55;
        const pitch = Math.atan2(h, back) - Math.atan(-yBall * Math.tan(fovForAspect(c.aspect || 1) / 2));
        ({ eye, target } = behindBall(ball, dir, back, h, pitch));
        clear = 0.3;
        lambda = 6;
        break;
      }
      case 'read': {
        if (this.readView !== 'orbit') {
          ({ eye, target, up } = this._readGoal(ball, cup));
          lambda = 4.5;
          clear = 0.4;
          break;
        }
        const mx = (ball.x + cup.x) / 2;
        const my = (ball.y + cup.y) / 2;
        const d = Math.hypot(cup.x - ball.x, cup.y - ball.y);
        // Close enough on a short putt that ball and cup are more than dots.
        const r = clamp(d * 0.85 + 4, 5.5, 30);
        const mz = groundZ(T, mx, my);
        eye = { x: mx + Math.cos(this.readYaw) * r, y: my + Math.sin(this.readYaw) * r, z: mz + r * 0.85 };
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
      case 'relief': {
        // Water relief: look down on where the ball went in (entry), the drop spot and, when it
        // is nearby, where it was played from, so the choice is an informed one. The points sit
        // in the part of the screen the decision sheet leaves free: the upper half in portrait
        // (sheet at the bottom), the right half in landscape (lens shift, sheet on the left).
        const r = c.relief || {};
        const entry = r.entry || ball;
        const pts = [entry, r.drop || ball];
        if (r.replay && Math.hypot(r.replay.x - entry.x, r.replay.y - entry.y) < 90) pts.push(r.replay);
        const mx = pts.reduce((a, p) => a + p.x, 0) / pts.length;
        const my = pts.reduce((a, p) => a + p.y, 0) / pts.length;
        let span = 0;
        for (const p of pts) span = Math.max(span, Math.hypot(p.x - mx, p.y - my));
        const T2 = Math.tan(fovForAspect(c.aspect || 1) / 2);
        const wide = (c.aspect || 1) >= 1;
        const h = clamp((span + 12) / (T2 * (wide ? 0.8 : 0.45)), 25, 260);
        const dd = r.drop ? Math.hypot(cup.x - r.drop.x, cup.y - r.drop.y) : 0;
        const hx = dd > 1 ? (cup.x - r.drop.x) / dd : dir.x;
        const hy = dd > 1 ? (cup.y - r.drop.y) / dd : dir.y;
        const off = wide ? 0 : 0.25 * h * T2; // the look point sits behind the points: they rise
        const gz = groundZ(T, mx, my);
        target = { x: mx - hx * off, y: my - hy * off, z: gz };
        eye = { x: target.x - hx * h * 0.25, y: target.y - hy * h * 0.25, z: gz + h };
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
        if (c.golfer) {
          ({ eye, target } = this._golferGoal(ball, dir, cup, false));
          lambda = 6;
          break;
        }
        // address: behind the ball, framed for the aspect and the shot (see addressFraming): the
        // target is the club's carry down the aim line (not past the cup). If a ridge hides it
        // (a raised tee over a convex bank), the eye climbs until the landing area is in sight.
        const dCup = Math.hypot(cup.x - ball.x, cup.y - ball.y);
        const dist = clamp(Math.min(c.carry ?? dCup, dCup + 10), 0, 280);
        const tx = ball.x + dir.x * Math.max(dist, ADDRESS_NEAR);
        const ty = ball.y + dir.y * Math.max(dist, ADDRESS_NEAR);
        const tz = T && T.heightAt ? groundZ(T, tx, ty) : ball.z;
        const dz = tz - (ball.z - 0.02);
        let f = addressFraming(c.aspect || 1, { dist, dz });
        ({ eye, target } = behindBall(ball, dir, f.back, f.h, f.pitch));
        for (let k = 0; k < 6 && !sightClear(T, eye, { x: tx, y: ty, z: tz + 0.5 }); k++) {
          f = addressFraming(c.aspect || 1, { dist, dz, h: f.h + 1.5 });
          ({ eye, target } = behindBall(ball, dir, f.back, f.h, f.pitch));
        }
        this.framing = f;
        lambda = 6;
      }
    }
    return { eye, target, lambda, up, clear };
  }

  // The preset read views (behind the ball, behind the hole, overhead).
  _readGoal(ball, cup) {
    const c = this.ctx;
    const T = c.terrain;
    const aspect = c.aspect || 1;
    const wide = aspect >= 1;
    let d = Math.hypot(cup.x - ball.x, cup.y - ball.y);
    let ux = d > 0.05 ? (cup.x - ball.x) / d : Math.cos(c.aimYaw || 0);
    let uy = d > 0.05 ? (cup.y - ball.y) / d : Math.sin(c.aimYaw || 0);
    d = Math.max(d, 0.5);
    const gb = groundZ(T, ball.x, ball.y);
    const gc = groundZ(T, cup.x, cup.y);
    if (this.readView === 'overhead') {
      const Tn = Math.tan(fovForAspect(aspect) / 2);
      const lat = Math.abs(c.lineLat || 0);
      // The line runs up the screen: its length fits the height, its bulge the width, inside the
      // band the read card and the camera buttons leave free.
      const h = clamp(Math.max((d / 2 + 1.4) / (Tn * (wide ? 0.62 : 0.5)), (lat + 1.2) / (Tn * aspect * 0.8), 5), 5, 90);
      const mx = (ball.x + cup.x) / 2;
      const my = (ball.y + cup.y) / 2;
      const gz = groundZ(T, mx, my);
      const off = wide ? 0.08 * h * Tn : 0.2 * h * Tn; // look a little beyond: the pair sits lower
      const target = { x: mx + ux * off, y: my + uy * off, z: gz };
      const eye = { x: target.x - ux * h * 0.12, y: target.y - uy * h * 0.12, z: gz + h };
      return { eye, target, up: { x: ux, y: uy, z: 0 } };
    }
    const fromBall = this.readView === 'ball';
    const near = fromBall ? { x: ball.x, y: ball.y, z: gb } : { x: cup.x, y: cup.y, z: gc };
    const far = fromBall ? { x: cup.x, y: cup.y, z: gc } : { x: ball.x, y: ball.y, z: gb };
    if (!fromBall) {
      ux = -ux;
      uy = -uy;
    }
    const dir = { x: ux, y: uy };
    let h = clamp(0.75 + d * 0.06, 0.8, 3.2);
    const yNear = wide ? -0.5 : -0.42;
    const yFar = wide ? 0.25 : 0.12;
    let f = lineFraming(aspect, { dist: d, dz: far.z - near.z, h, yNear, yFar });
    let g = behindBall(near, dir, f.back, f.h, f.pitch);
    for (let k = 0; k < 8 && !sightClear(T, g.eye, { x: far.x, y: far.y, z: far.z + 0.15 }, 0.1); k++) {
      h += 0.5;
      f = lineFraming(aspect, { dist: d, dz: far.z - near.z, h, yNear, yFar });
      g = behindBall(near, dir, f.back, f.h, f.pitch);
    }
    return { eye: g.eye, target: g.target, up: { x: 0, y: 0, z: 1 } };
  }

  // Address and putt with the golfer in view (golferFraming): on the target line behind the ball.
  // The eye keeps 1 m (putts 0.3 m) over the ground behind the ball, the pitch is re-solved for the
  // height it ends up at (the ball stays in the arc), and a ridge hiding the target lifts it.
  _golferGoal(ball, dir, cup, putt) {
    const c = this.ctx;
    const T = c.terrain;
    const gf = c.golfer;
    const dCup = Math.hypot(cup.x - ball.x, cup.y - ball.y);
    const dist = putt ? dCup : clamp(Math.min(c.carry ?? dCup, dCup + 10), 0, 280);
    const D = Math.max(dist, putt ? 0.3 : 8);
    const tx = ball.x + dir.x * D;
    const ty = ball.y + dir.y * D;
    const tz = putt ? groundZ(T, cup.x, cup.y) : T && T.heightAt ? groundZ(T, tx, ty) : ball.z;
    const f = golferFraming(c.aspect || 1, { dist, dz: tz - (ball.z - 0.02), lat: gf.lat, along: gf.along, H: gf.H, putt });
    // Landscape, a left-hander: he stands right of the ball, which with the ball on the swing pad
    // (on the right of the screen) would put him inside the arc and under the thumb. The lens shift
    // moves ball and golfer instead so that he stands just left of the pad (padShift - 1 is the
    // pad's left edge when it reaches the right edge of the screen; hw ~ his half width at the top).
    if ((c.aspect || 1) >= 1.25 && gf.lat < 0 && c.padShift > 0) {
      const sep = Math.abs(f.golferX - f.shift);
      const hw = (sep * 0.42) / Math.max(0.3, Math.abs(gf.lat));
      f.shift = c.padShift - 1 - 0.04 - sep - hw;
      f.golferX = f.shift + sep;
      f.clearPad = true;
    }
    const ex = ball.x - dir.x * f.back;
    const ey = ball.y - dir.y * f.back;
    let h = Math.max(f.h, groundZ(T, ex, ey) + (putt ? 0.3 : 1) - ball.z);
    let g = behindBall(ball, dir, f.back, h, Math.atan(h / f.back) - f.below);
    const aim = { x: tx, y: ty, z: tz + 0.5 };
    for (let k = 0; k < 6 && !putt && !sightClear(T, g.eye, aim); k++) {
      h += 0.75;
      g = behindBall(ball, dir, f.back, h, Math.atan(h / f.back) - f.below);
    }
    this.framing = { ...f, h, pitch: Math.atan(h / f.back) - f.below, golfer: true };
    return g;
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
    const hold = f.hold;
    f.holding = !!hold && f.phase === 'tv' && pt < hold.T;
    if (f.phase === 'tv' && (hold ? pt > 1.6 + hold.T || travelled > 85 : pt > 1.6 || travelled > 70)) f.phase = 'chase';
    if (f.phase === 'tv' && hold) {
      // Hold on the golfer's follow-through, then pan up with the ball from the same spot, rising.
      if (f.holding) return { eye: { ...hold.eye }, target: { ...hold.target }, lambda: 12, up, clear: 1 };
      const e = hold.eye;
      return { eye: { x: e.x, y: e.y, z: e.z + (pt - hold.T) * 0.7 }, target: { x: ball.x, y: ball.y, z: ball.z }, lambda: 5, up, clear: 1 };
    }
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
    this.snap0 = this.snap;
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
    // Lens shift: at address and putting the view's centre moves to the swing pad (landscape puts
    // the pad on the right), so the ball sits in the arc while the aim line stays vertical.
    const held = this.mode === 'flight' && this.flight && this.flight.holding;
    // (With the golfer, portrait shifts the view too: golfer on his side, the ball in the arc.)
    const gShift = c.golfer && this.framing && this.framing.golfer ? this.framing.shift || 0 : 0;
    let shiftGoal = this.mode === 'address' || this.mode === 'putt' || held ? (c.padShift || 0) + gShift : 0;
    if (this.mode === 'relief' && (c.aspect || 1) >= 1.25) shiftGoal = RELIEF_SHIFT;
    this.shiftX = this.snap0 ? shiftGoal : damp(this.shiftX, shiftGoal, 6, dt);
    const near = this.mode === 'putt' ? 0.08 : this.mode === 'address' ? 0.15 : 0.3;
    return {
      eye: { ...this.eye },
      target: { ...this.target },
      up: { ...this.up },
      fovY: this.fovY,
      near,
      far: 6000,
      shiftX: this.shiftX,
    };
  }
}
