// Simplified Rules of Golf for solo stroke play (docs/architecture.md section 4). Pure module.
//
//   resolveShot(ctx, shot) -> Resolution     what a finished shot means for the score and the ball
//   waterRelief(terrain, entry, kind, {cup}) -> {x, y, z} | null
//   scoreName(strokes, par), maxStrokes(par) = 2 x par
//
// ctx = {terrain, par, strokes (taken BEFORE this shot), prevSpot:{x,y,z} (where it was played
//        from), fromTee (prevSpot is on the tee box), fromSurface (SURF id of that lie)}
// shot = ShotResult from simulateShot.
//
// Resolution = {
//   outcome: 'rest'|'holed'|'ob'|'water',
//   strokes,          total after this shot, penalties included
//   penalty,          0 or 1
//   ball:{x,y,z},     where the next stroke is played from (ball centre; for water: the drop)
//   reTee,            the next stroke is from the tee box (stroke and distance from the tee)
//   decision,         null | {kind:'water', waterKind, relief:'lateral'|'line', options:['drop','replay'],
//                     drop, replay, replayTee, entry}
//   holed, pickUp,    pickUp: 2 x par reached without holing out; the hole is recorded as 2 x par
//   putt,             the stroke was played from the putting green (counts as a putt)
//   fir,              tee shot of a par 4/5: true/false; undefined otherwise
//   gir,              true when this shot reached the green (or holed) in regulation; else undefined
//   message           short text for a toast/banner, or null
// }
//
// Water: red (lateral) relief is a spot within two club lengths of where the ball last crossed
// into the penalty area, no nearer the hole, chosen like a golfer would: close to the entry but
// off the steep bank (Rule 14.2e: the ball must stay where it is placed, so spots it would roll
// away from are never used). Yellow relief is back on the line from the hole through that point,
// at least 2 m behind it, on dry ground. The player may instead replay from the previous spot.
// Both cost one stroke. OB is stroke and distance.

import { SURF, CLUB_LENGTH, BALL_R, G } from './constants.js';
import { simulateShot, contactParams } from './physics.js';
import { clamp } from './vec3.js';

export const RELIEF_R = 2 * CLUB_LENGTH; // 2.28 m
export const YELLOW_BACK = 2; // m behind the entry point, at least
const WATER_CLEAR = 0.6; // m: red drops prefer no water this close (the ball sits on a bank)
// Yellow relief may go back as far as the player likes: pick the first spot that is off the
// steep bank and clear of the water, so the next shot is not played from the water's edge.
const YELLOW_CLEAR = 2;
const YELLOW_MAX_SLOPE = 0.08;
// Red relief: each 1% of slope costs as much as 8 cm of extra distance from the entry, and
// ground steeper than RED_GENTLE is used only when the whole relief area is that steep.
const RED_SLOPE_COST = 8;
const RED_GENTLE = 0.1;
const HOLD_MARGIN = 0.85; // a drop spot must hold the ball with this margin on the rolling drag
const STAY_MOVE = 0.3; // m: a ball released at the spot may settle this far, no further
const RED_LINE_MAX = 30; // m: how far back on the line a red drop looks for level ground

export function maxStrokes(par) {
  return 2 * par;
}

export function scoreName(strokes, par) {
  if (strokes === 1) return 'Hole in one!';
  const d = strokes - par;
  if (d <= -3) return 'Albatross';
  if (d === -2) return 'Eagle';
  if (d === -1) return 'Birdie';
  if (d === 0) return 'Par';
  if (d === 1) return 'Bogey';
  if (d === 2) return 'Double Bogey';
  if (d === 3) return 'Triple Bogey';
  return `+${d}`;
}

// Somewhere a ball may be dropped: in bounds, not in water and not in a bunker. Waste areas,
// desert and fescue are not penalty areas (general area): a drop may land there.
export function isDropOk(terrain, x, y) {
  const s = terrain.surfaceAt(x, y);
  if (s === SURF.WATER || s === SURF.OOB || s === SURF.BUNKER) return false;
  if (terrain.isOOB && terrain.isOOB(x, y)) return false;
  return !(terrain.waterAt && terrain.waterAt(x, y));
}

function clearOfWater(terrain, x, y, r) {
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    if (terrain.surfaceAt(x + r * Math.cos(a), y + r * Math.sin(a)) === SURF.WATER) return false;
  }
  return true;
}

const spot = (terrain, x, y) => ({ x, y, z: terrain.heightAt(x, y) + BALL_R });
const _g = { x: 0, y: 0 };

function slopeAt(terrain, x, y) {
  const g = terrain.gradAt(x, y, _g) || _g;
  return Math.hypot(g.x, g.y);
}

// Can a ball sit still here? The downhill pull of a rolling ball, (5/7) g sin(theta), must stay
// well under the surface's rolling drag a0 (the physics rest test, with a margin; firm courses
// have less drag, so fewer spots hold).
export function holdsBall(terrain, x, y) {
  const t = slopeAt(terrain, x, y);
  const surf = contactParams(terrain, terrain.surfaceAt(x, y), t);
  return (5 / 7) * G * (t / Math.sqrt(1 + t * t)) < surf.a0 * HOLD_MARGIN;
}

// Final check of a drop spot: release a ball there at zero speed and see that it stays put.
function staysPut(terrain, s) {
  const r = simulateShot(
    terrain,
    { pos: { x: s.x, y: s.y, z: s.z }, vel: { x: 0, y: 0, z: 0 }, spin: { x: 0, y: 0, z: 0 }, mode: 'roll' },
    { record: false, maxT: 5, pin: false },
  );
  return r.final.outcome === 'rest' && r.total <= STAY_MOVE;
}

// Back on the line from the cup through `entry`, from `minBack` m behind it outward: the first
// dry spot clear of the water by `clear` m on gentle ground, else the first dry spot that holds
// the ball.
function backOnLine(terrain, entry, cup, minBack, clear = WATER_CLEAR) {
  let ux = entry.x - cup.x;
  let uy = entry.y - cup.y;
  const l = Math.hypot(ux, uy);
  if (l < 1e-6) {
    ux = 1;
    uy = 0;
  } else {
    ux /= l;
    uy /= l;
  }
  let firstDry = null;
  let firstClear = null;
  const g = { x: 0, y: 0 };
  for (let d = minBack; d <= 250; d += 0.5) {
    const x = entry.x + ux * d;
    const y = entry.y + uy * d;
    if (!isDropOk(terrain, x, y) || !holdsBall(terrain, x, y)) continue;
    if (!firstDry) firstDry = spot(terrain, x, y);
    if (!clearOfWater(terrain, x, y, clear)) continue;
    if (!firstClear) firstClear = spot(terrain, x, y);
    terrain.gradAt(x, y, g);
    if (Math.hypot(g.x, g.y) <= YELLOW_MAX_SLOPE) return spot(terrain, x, y);
    if (d > minBack + 40) break;
  }
  return firstClear || firstDry;
}

export function waterRelief(terrain, entry, kind = 'red', { cup = terrain.cup } = {}) {
  if (!entry) return null;
  if (kind === 'yellow') return backOnLine(terrain, entry, cup, YELLOW_BACK, YELLOW_CLEAR);
  // Red: the cheapest spot in the relief circle, where cost = distance from the entry + slope.
  // Spots that cannot hold a ball are never used; spots with water right next to them or on
  // ground steeper than RED_GENTLE only when nothing better exists.
  const dEntry = Math.hypot(entry.x - cup.x, entry.y - cup.y);
  const cands = [];
  for (let r = 0.25; r <= RELIEF_R + 1e-9; r += 0.25) {
    for (let k = 0; k < 48; k++) {
      const a = (k / 48) * Math.PI * 2;
      const x = entry.x + r * Math.cos(a);
      const y = entry.y + r * Math.sin(a);
      if (Math.hypot(x - cup.x, y - cup.y) < dEntry) continue;
      if (!isDropOk(terrain, x, y) || !holdsBall(terrain, x, y)) continue;
      const sl = slopeAt(terrain, x, y);
      const cost = r + RED_SLOPE_COST * sl + (sl > RED_GENTLE ? 50 : 0) + (clearOfWater(terrain, x, y, WATER_CLEAR) ? 0 : 100);
      cands.push({ x, y, cost, sl });
    }
  }
  cands.sort((a, b) => a.cost - b.cost);
  // Release a ball at the best few: bumps the slope sample misses can still roll it away.
  let steep = null;
  let steepSl = 1;
  for (let i = 0; i < Math.min(cands.length, 12); i++) {
    const s = spot(terrain, cands[i].x, cands[i].y);
    if (!staysPut(terrain, s)) continue;
    if (cands[i].cost < 50) return s;
    steep = s;
    steepSl = cands[i].sl;
    break;
  }
  // The whole relief area is steep bank: like a golfer, use the other red-area option (Rule
  // 17.1d(2)) when it finds level ground nearby, back on the line from the hole through the entry.
  // The steeper the bank, the further back is worth walking (6 m at 10%, 24 m at 40%).
  const maxBack = clamp(6 + 60 * (steepSl - RED_GENTLE), 6, RED_LINE_MAX);
  const level = levelOnLine(terrain, entry, cup, maxBack);
  if (level) return level;
  if (steep) return steep;
  // Nothing in two club lengths holds a ball (a wide stretch of water or a steep bank all
  // round): go back on the line as far as it takes.
  return backOnLine(terrain, entry, cup, 0);
}

// Back on the line from the cup through `entry`, within maxBack m: the first spot on gentle
// ground, clear of the water, that holds the ball. null if there is none.
function levelOnLine(terrain, entry, cup, maxBack) {
  const l = Math.hypot(entry.x - cup.x, entry.y - cup.y);
  if (l < 1e-6) return null;
  const ux = (entry.x - cup.x) / l;
  const uy = (entry.y - cup.y) / l;
  let dry = false;
  for (let d = 0.5; d <= maxBack; d += 0.5) {
    const x = entry.x + ux * d;
    const y = entry.y + uy * d;
    // Never across the water: stop where the line runs back into it.
    const wet = terrain.surfaceAt(x, y) === SURF.WATER;
    if (wet && dry) break;
    dry = dry || !wet;
    if (!isDropOk(terrain, x, y) || slopeAt(terrain, x, y) > RED_GENTLE) continue;
    if (!holdsBall(terrain, x, y) || !clearOfWater(terrain, x, y, WATER_CLEAR)) continue;
    const s = spot(terrain, x, y);
    if (staysPut(terrain, s)) return s;
  }
  return null;
}

export function resolveShot(ctx, shot) {
  const { terrain, par } = ctx;
  const f = shot.final;
  const strokes = (ctx.strokes || 0) + 1;
  const res = {
    outcome: f.outcome,
    strokes,
    penalty: 0,
    ball: { x: f.x, y: f.y, z: f.z },
    reTee: false,
    decision: null,
    holed: false,
    pickUp: false,
    putt: ctx.fromSurface === SURF.GREEN,
    fir: undefined,
    gir: undefined,
    message: null,
  };
  const prev = ctx.prevSpot ? { x: ctx.prevSpot.x, y: ctx.prevSpot.y, z: ctx.prevSpot.z } : res.ball;

  if (f.outcome === 'holed') {
    res.holed = true;
    res.ball = { x: terrain.cup.x, y: terrain.cup.y, z: terrain.cup.z };
  } else if (f.outcome === 'ob') {
    res.penalty = 1;
    res.ball = prev;
    res.reTee = !!ctx.fromTee;
    res.message = 'Out of bounds · Stroke and distance';
  } else if (f.outcome === 'water') {
    res.penalty = 1;
    const entry = shot.waterEntry || shot.lastDry || { x: f.x, y: f.y };
    const wa = terrain.waterAt ? terrain.waterAt(f.x, f.y) || terrain.waterAt(entry.x, entry.y) : null;
    const waterKind = wa ? wa.kind : 'red';
    const drop = waterRelief(terrain, entry, waterKind) || prev;
    // How the drop was found, for the dialog: beside the entry, or back on the line.
    const relief = waterKind === 'red' && Math.hypot(drop.x - entry.x, drop.y - entry.y) <= RELIEF_R + 1e-6 ? 'lateral' : 'line';
    res.ball = drop;
    res.decision = { kind: 'water', waterKind, relief, options: ['drop', 'replay'], drop, replay: prev, replayTee: !!ctx.fromTee, entry };
    res.message = waterKind === 'yellow' ? 'Water hazard · Penalty stroke' : 'Penalty area · Penalty stroke';
  }
  res.strokes = strokes + res.penalty;

  // Statistics.
  if ((ctx.strokes || 0) === 0 && par >= 4) {
    res.fir = res.holed || (f.outcome === 'rest' && [SURF.FAIRWAY, SURF.FRINGE, SURF.GREEN].includes(f.surface));
  }
  if (res.strokes <= par - 2 && (res.holed || (f.outcome === 'rest' && f.surface === SURF.GREEN))) res.gir = true;

  // Pick up at double par.
  if (!res.holed && res.strokes >= maxStrokes(par)) {
    res.pickUp = true;
    res.strokes = maxStrokes(par);
    res.decision = null;
    res.message = 'Picked up · Double par';
  }
  return res;
}
