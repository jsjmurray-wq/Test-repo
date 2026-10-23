// Pure geometric aim prediction (no physics): what the cue ball hits first along a straight line,
// the ghost-ball position, and where the object ball and cue ball head afterwards.
// Used by the renderer (aim guide), input (pre-selecting the called pocket) and the AI.

import { BALL_R, HL, HW } from './constants.js';

const R = BALL_R;

// Ray (px,py)+t*(dx,dy), d unit. Returns smallest t >= 0 where the moving centre is 2R from c.
export function rayCircle(px, py, dx, dy, cx, cy, rad) {
  const fx = px - cx;
  const fy = py - cy;
  const b = fx * dx + fy * dy;
  const c = fx * fx + fy * fy - rad * rad;
  if (c < 0) return 0; // already overlapping
  const disc = b * b - c;
  if (disc < 0 || b > 0) return Infinity;
  const t = -b - Math.sqrt(disc);
  return t >= 0 ? t : Infinity;
}

// Distance along the ray until a ball centre would touch the cushion rectangle.
export function rayRails(px, py, dx, dy) {
  const lx = HL - R;
  const ly = HW - R;
  let t = Infinity;
  let nx = 0;
  let ny = 0;
  if (dx > 1e-12) {
    const tt = (lx - px) / dx;
    if (tt < t) [t, nx, ny] = [tt, -1, 0];
  } else if (dx < -1e-12) {
    const tt = (-lx - px) / dx;
    if (tt < t) [t, nx, ny] = [tt, 1, 0];
  }
  if (dy > 1e-12) {
    const tt = (ly - py) / dy;
    if (tt < t) [t, nx, ny] = [tt, 0, -1];
  } else if (dy < -1e-12) {
    const tt = (-ly - py) / dy;
    if (tt < t) [t, nx, ny] = [tt, 0, 1];
  }
  return { t: Math.max(0, t), nx, ny };
}

// Which pocket (if any) a ball rolling from (px,py) along unit (dx,dy) reaches before a rail.
export function predictPocket(px, py, dx, dy, pockets, balls = null, ignore = []) {
  const rail = rayRails(px, py, dx, dy);
  let best = null;
  let bestT = Infinity;
  for (const p of pockets) {
    // Aim at the capture circle shrunk a little so marginal paths are not "in".
    const t = rayCircle(px, py, dx, dy, p.x, p.y, p.captureR * 0.85);
    if (t < bestT && t <= rail.t + 0.08) {
      bestT = t;
      best = p.id;
    }
  }
  if (best !== null && balls) {
    for (const b of balls) {
      if (!b.on || ignore.includes(b.id)) continue;
      const t = rayCircle(px, py, dx, dy, b.x, b.y, 2 * R);
      if (t < bestT) return null;
    }
  }
  return best;
}

// Trace the cue ball from (cx,cy) at world angle `angle` through `balls` (array of {id,x,y,on}).
export function traceAim(balls, cx, cy, angle, pockets = null) {
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  let hitT = Infinity;
  let hit = null;
  for (const b of balls) {
    if (!b.on || b.id === 0) continue;
    const t = rayCircle(cx, cy, dx, dy, b.x, b.y, 2 * R);
    if (t < hitT) {
      hitT = t;
      hit = b;
    }
  }
  const rail = rayRails(cx, cy, dx, dy);
  if (!hit || rail.t < hitT) {
    const gx = cx + dx * rail.t;
    const gy = cy + dy * rail.t;
    // Mirror reflection off the rail
    const dn = dx * rail.nx + dy * rail.ny;
    const rx = dx - 2 * dn * rail.nx;
    const ry = dy - 2 * dn * rail.ny;
    return { type: 'rail', ghost: { x: gx, y: gy }, dist: rail.t, reflect: { x: rx, y: ry } };
  }
  const gx = cx + dx * hitT;
  const gy = cy + dy * hitT;
  let nx = (hit.x - gx) / (2 * R);
  let ny = (hit.y - gy) / (2 * R);
  const nl = Math.hypot(nx, ny) || 1;
  nx /= nl;
  ny /= nl;
  const cosCut = Math.max(-1, Math.min(1, dx * nx + dy * ny));
  // Cue ball tangent line (stun approximation): d minus its normal component.
  let tx = dx - cosCut * nx;
  let ty = dy - cosCut * ny;
  const tl = Math.hypot(tx, ty);
  if (tl > 1e-9) {
    tx /= tl;
    ty /= tl;
  } else {
    tx = 0;
    ty = 0;
  }
  const pocket = pockets ? predictPocket(hit.x, hit.y, nx, ny, pockets, balls, [hit.id, 0]) : null;
  return {
    type: 'ball',
    ball: hit.id,
    ghost: { x: gx, y: gy },
    dist: hitT,
    objDir: { x: nx, y: ny },
    cueDir: { x: tx, y: ty },
    cut: Math.acos(cosCut), // 0 = full ball
    pocket,
  };
}
