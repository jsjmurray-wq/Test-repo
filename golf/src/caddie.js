// The caddie: club distances for the current lie and wind, a suggested club, the "plays like"
// distance and the putt range. Pure module; every number comes from simulateShot, so the advice
// always matches the physics the shot will actually get.
//
//   clubTable(terrain, pos, lie, wind, {aimYaw}) -> [{id, name, short, kind, carry, total, carry0,
//                                                   total0, apex, landAngle}]   (m, deg; no putter)
//   suggestClub(terrain, pos, lie, wind, {table, par, teeShot, aimYaw}) -> club id
//   playsLike(terrain, pos, target, wind, table) -> metres
//   puttRange(dist) -> metres
//
// Distances in the table are a stock full swing (power 1, straight, no contact scatter) with the
// lie's factors, simulated over flat fairway at the ball's height: carry/total with the wind
// blowing along aimYaw, carry0/total0 without wind.

import { SURF, BALL_R } from './constants.js';
import { CLUBS, PUTTER_ID } from './clubs.js';
import { simulateShot, planeTerrain } from './physics.js';
import { swingToLaunch, PUTT_RANGES } from './swing.js';
import { DEG } from './vec3.js';

const STOCK = { ok: true, kind: 'full', power: 1, startDir: 0, faceToPath: 0, tempo: 'smooth' };
const ZERO_WIND = { x: 0, y: 0 };
const OVERRUN = 20; // m: a lay-up club may not run more than this past the cup
const CADDIE_SEED = 7; // fixed seed for the caddie's look-ahead shots (canopy luck)

const yawTo = (a, b) => Math.atan2(b.y - a.y, b.x - a.x);
const hasWind = (w) => !!w && (Math.abs(w.x) > 1e-6 || Math.abs(w.y) > 1e-6);

export function clubTable(terrain, pos, lie, wind = ZERO_WIND, opts = {}) {
  const aimYaw = opts.aimYaw ?? (lie && lie.aimYaw !== undefined ? lie.aimYaw : terrain.cup ? yawTo(pos, terrain.cup) : 0);
  const z = terrain.heightAt(pos.x, pos.y);
  const plane = planeTerrain({ surface: SURF.FAIRWAY, z0: z });
  const start = { x: pos.x, y: pos.y, z: z + BALL_R };
  const windy = hasWind(wind);
  const rows = [];
  for (const c of CLUBS) {
    if (c.kind === 'putter') continue;
    const launch = swingToLaunch(c, lie, STOCK, aimYaw, null, { pos: start });
    const r = simulateShot(plane, launch, { wind, record: false, pin: false });
    const r0 = windy ? simulateShot(plane, launch, { record: false, pin: false }) : r;
    const land = r.events.find((e) => e.type === 'land');
    rows.push({
      id: c.id,
      name: c.name,
      short: c.short,
      kind: c.kind,
      carry: r.carry,
      total: r.total,
      carry0: r0.carry,
      total0: r0.total,
      apex: r.apex,
      landAngle: land ? land.angle : 45,
    });
  }
  return rows;
}

// Plays-like distance to target {x, y, z}: the flat, still-air carry that lands there. Wind scales
// it by the no-wind/with-wind carry ratio of the club that carries closest to it; height adds
// dz / tan(descent angle) (the ball has to fly that much further to come down dz higher).
export function playsLike(terrain, pos, target, wind, table) {
  const d = Math.hypot(target.x - pos.x, target.y - pos.y);
  const zTarget = target.z !== undefined ? target.z : terrain.heightAt(target.x, target.y);
  const dz = zTarget - terrain.heightAt(pos.x, pos.y);
  if (!table || !table.length) return d + dz;
  let best = table[0];
  for (const r of table) if (Math.abs(r.carry - d) < Math.abs(best.carry - d)) best = r;
  const windFactor = best.carry > 1 ? best.carry0 / best.carry : 1;
  const tanDescent = Math.tan(Math.max(20, best.landAngle) * DEG);
  return Math.max(0, d * windFactor + dz / tanDescent);
}

// Flat-roll range for the putt gauge: the first of PUTT_RANGES at least 1.25x the distance.
export function puttRange(dist) {
  for (const r of PUTT_RANGES) if (r >= 1.25 * dist) return r;
  return PUTT_RANGES[PUTT_RANGES.length - 1];
}

// Predicted stock shot on the real hole (with wind, trees and hazards).
export function predictShot(terrain, pos, lie, wind, clubId, aimYaw, power = 1) {
  const z = terrain.heightAt(pos.x, pos.y);
  const launch = swingToLaunch(clubId, lie, { ...STOCK, power }, aimYaw, null, { pos: { x: pos.x, y: pos.y, z: z + BALL_R } });
  return simulateShot(terrain, launch, { wind, seed: CADDIE_SEED, record: false });
}

// A rest spot the caddie is happy to play from (not wet, not out, not in sand).
export function isSafeRest(res) {
  const f = res.final;
  if (f.outcome === 'water' || f.outcome === 'ob') return false;
  return f.surface !== SURF.BUNKER && f.surface !== SURF.WATER && f.surface !== SURF.OOB;
}

export function suggestClub(terrain, pos, lie, wind = ZERO_WIND, opts = {}) {
  const surf = lie ? lie.surface : terrain.surfaceAt(pos.x, pos.y);
  if (surf === SURF.GREEN || surf === SURF.FRINGE) return PUTTER_ID;
  const table = opts.table || clubTable(terrain, pos, lie, wind, opts);
  const cup = terrain.cup;
  const aimYaw = opts.aimYaw ?? (lie && lie.aimYaw !== undefined ? lie.aimYaw : yawTo(pos, cup));
  const par = opts.par ?? terrain.par ?? 4;
  const teeShot = opts.teeShot ?? surf === SURF.TEE;
  // The driver is a tee club.
  const usable = table.filter((r) => r.id !== 'D' || surf === SURF.TEE);
  const dist = Math.hypot(cup.x - pos.x, cup.y - pos.y);

  if (!(teeShot && par >= 4)) {
    // Approach (and par-3 tee shots): the shortest club that carries the plays-like distance.
    const pl = playsLike(terrain, pos, cup, wind, table);
    const reach = usable.filter((r) => r.carry >= 0.98 * pl);
    if (reach.length) {
      if (surf === SURF.BUNKER && reach.some((r) => r.id === 'SW')) return 'SW';
      return reach[reach.length - 1].id;
    }
  }
  // Tee shots on par 4/5 and lay-ups: by total distance along the aim line, longest first,
  // skipping clubs that run well past the cup or come to rest in a hazard.
  let fallback = usable[usable.length - 1].id;
  for (const r of usable) {
    if (r.total > dist + OVERRUN) continue;
    const res = predictShot(terrain, pos, lie, wind, r.id, aimYaw);
    if (isSafeRest(res)) return r.id;
    fallback = r.id;
  }
  return fallback;
}
