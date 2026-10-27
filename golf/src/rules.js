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
//   decision,         null | {kind:'water', waterKind, options:['drop','replay'], drop, replay, replayTee}
//   holed, pickUp,    pickUp: 2 x par reached without holing out; the hole is recorded as 2 x par
//   putt,             the stroke was played from the putting green (counts as a putt)
//   fir,              tee shot of a par 4/5: true/false; undefined otherwise
//   gir,              true when this shot reached the green (or holed) in regulation; else undefined
//   message           short text for a toast/banner, or null
// }
//
// Water: red (lateral) relief is the nearest dry, non-hazard spot within two club lengths of where
// the ball last crossed into the penalty area, no nearer the hole. Yellow relief is back on the
// line from the hole through that point, at least 2 m behind it, on dry ground. The player may
// instead replay from the previous spot. Both cost one stroke. OB is stroke and distance.

import { SURF, CLUB_LENGTH, BALL_R } from './constants.js';

export const RELIEF_R = 2 * CLUB_LENGTH; // 2.28 m
export const YELLOW_BACK = 2; // m behind the entry point, at least
const WATER_CLEAR = 0.6; // m: red drops prefer no water this close (the ball sits on a bank)
// Yellow relief may go back as far as the player likes: pick the first spot that is off the
// steep bank and clear of the water, so the next shot is not played from the water's edge.
const YELLOW_CLEAR = 2;
const YELLOW_MAX_SLOPE = 0.08;

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

// Somewhere a ball may be dropped: in bounds, not in water and not in a bunker.
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

// Back on the line from the cup through `entry`, from `minBack` m behind it outward: the first
// dry spot clear of the water by `clear` m on gentle ground, else the first dry spot.
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
    if (!isDropOk(terrain, x, y)) continue;
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
  // Red: nearest acceptable point in the relief circle. Points with water right next to them are
  // only used when nothing better exists.
  const dEntry = Math.hypot(entry.x - cup.x, entry.y - cup.y);
  let best = null;
  let bestScore = Infinity;
  for (let r = 0.25; r <= RELIEF_R + 1e-9; r += 0.25) {
    for (let k = 0; k < 48; k++) {
      const a = (k / 48) * Math.PI * 2;
      const x = entry.x + r * Math.cos(a);
      const y = entry.y + r * Math.sin(a);
      if (Math.hypot(x - cup.x, y - cup.y) < dEntry) continue;
      if (!isDropOk(terrain, x, y)) continue;
      const score = r + (clearOfWater(terrain, x, y, WATER_CLEAR) ? 0 : 100);
      if (score < bestScore) {
        bestScore = score;
        best = { x, y };
      }
    }
  }
  if (best) return spot(terrain, best.x, best.y);
  // Nothing dry within two club lengths (a ball that crossed a wide stretch of water): fall back
  // to going back on the line.
  return backOnLine(terrain, entry, cup, 0);
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
    res.ball = drop;
    res.decision = { kind: 'water', waterKind, options: ['drop', 'replay'], drop, replay: prev, replayTee: !!ctx.fromTee, entry };
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
