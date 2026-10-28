// The caddie: club distances for the current lie and wind, a suggested club, the "plays like"
// distance and the putt range. Pure module; every number comes from simulateShot, so the advice
// always matches the physics the shot will actually get.
//
//   clubTable(terrain, pos, lie, wind, {aimYaw, shot, handed}) -> [{id, name, short, kind, carry,
//            total, totalG, carry0, total0, apex, landAngle, side, shot}]   (m, deg; no putter)
//   clubRow(terrain, pos, lie, wind, clubId, {aimYaw, shot, handed}) -> one row of the table
//   suggestClub(terrain, pos, lie, wind, {table, par, teeShot, aimYaw}) -> club id
//   expectedFinish(row, k = RELEASE_K) -> carry + k x release on a green (m): what an approach is
//            chosen by; releaseK(shotId) is k for a shot (shots that are meant to run count it all)
//   playsLike(terrain, pos, target, wind, table) -> metres
//   puttRange(dist) -> metres
//   powerCurve(terrain, pos, lie, wind, clubId, aimYaw, {shot, handed}) -> [{power, carry, total,
//            side, sideTotal}]
//   curveAt(curve, power) -> {carry, total, side, sideTotal}   (for the live power-arc readout)
//   predictShot(terrain, pos, lie, wind, clubId, aimYaw, power, {shot, handed}) -> ShotResult
//   shotPreview(terrain, pos, lie, wind, clubId, aimYaw, {power, shot, handed}) -> {path, carry,
//            total, landing, final}   (the intended flight over flat ground, recorded)
//
// Distances in the table are a stock full swing (power 1, straight, no contact scatter) with the
// lie's factors, simulated over flat fairway at the ball's height: carry/total with the wind
// blowing along aimYaw, carry0/total0 without wind; totalG is the total over a flat green. The flat
// fairway and green carry the hole's course conditions (firm links fairways run further).
//
// Special shots (shots.js, section 8.4): opts.shot plays the shot (with opts.handed for the side a
// draw or cut bends to) wherever the club can play it; a club that cannot keeps its normal shot,
// and each row says which it got (row.shot). side / sideTotal: where the ball lands / stops across
// the aim line (m, + = right), so the HUD can put the landing ring where a draw or cut comes down.

import { SURF, BALL_R } from './constants.js';
import { CLUBS, PUTTER_ID, clubById } from './clubs.js';
import { simulateShot, planeTerrain } from './physics.js';
import { swingToLaunch, PUTT_RANGES } from './swing.js';
import { isEligible, shotById } from './shots.js';
import { DEG } from './vec3.js';

const STOCK = { ok: true, kind: 'full', power: 1, startDir: 0, faceToPath: 0, tempo: 'smooth' };
const ZERO_WIND = { x: 0, y: 0 };
const OVERRUN = 20; // m: a lay-up club may not run more than this past the cup
// Approaches aim to finish at the pin: carry plus most of the stock release on a green (some
// approaches land short of it, on slower grass).
export const RELEASE_K = 0.85;
const REACH = 0.97; // a club "gets there" when its expected finish is within 3% of plays-like
const CADDIE_SEED = 7; // fixed seed for the caddie's look-ahead shots (canopy luck)

const yawTo = (a, b) => Math.atan2(b.y - a.y, b.x - a.x);
const hasWind = (w) => !!w && (Math.abs(w.x) > 1e-6 || Math.abs(w.y) > 1e-6);

// Signed offset of p across the line from `from` along yaw (+ = right of the line).
function sideOf(from, yaw, p) {
  return (p.x - from.x) * Math.sin(yaw) - (p.y - from.y) * Math.cos(yaw);
}

// The swing options for a club and a special shot: the shot only where the club can play it.
function shotOpts(club, lie, opts) {
  const shot = opts.shot && isEligible(opts.shot, club, lie) ? opts.shot : 'normal';
  return { shot, handed: opts.handed || 'R' };
}

function tableRow(c, lie, wind, aimYaw, start, plane, greenPlane, opts) {
  const so = shotOpts(c, lie, opts);
  const launch = swingToLaunch(c, lie, STOCK, aimYaw, null, { pos: start, ...so });
  const r = simulateShot(plane, launch, { wind, record: false, pin: false });
  const r0 = hasWind(wind) ? simulateShot(plane, launch, { record: false, pin: false }) : r;
  // The same shot landing on a green, which lets a low-spin ball (a flier) run much further.
  const rg = simulateShot(greenPlane, launch, { wind, record: false, pin: false });
  const land = r.events.find((e) => e.type === 'land');
  return {
    id: c.id,
    name: c.name,
    short: c.short,
    kind: c.kind,
    carry: r.carry,
    total: r.total,
    totalG: rg.total,
    carry0: r0.carry,
    total0: r0.total,
    apex: r.apex,
    landAngle: land ? land.angle : 45,
    side: r.landing ? sideOf(start, aimYaw, r.landing) : 0,
    shot: so.shot,
  };
}

function tableSetup(terrain, pos, lie, opts) {
  const aimYaw = opts.aimYaw ?? (lie && lie.aimYaw !== undefined ? lie.aimYaw : terrain.cup ? yawTo(pos, terrain.cup) : 0);
  const z = terrain.heightAt(pos.x, pos.y);
  const conditions = terrain.conditions || null;
  return {
    aimYaw,
    start: { x: pos.x, y: pos.y, z: z + BALL_R },
    plane: planeTerrain({ surface: SURF.FAIRWAY, z0: z, conditions }),
    greenPlane: planeTerrain({ surface: SURF.GREEN, z0: z, conditions }),
  };
}

export function clubTable(terrain, pos, lie, wind = ZERO_WIND, opts = {}) {
  const { aimYaw, start, plane, greenPlane } = tableSetup(terrain, pos, lie, opts);
  const rows = [];
  for (const c of CLUBS) if (c.kind !== 'putter') rows.push(tableRow(c, lie, wind, aimYaw, start, plane, greenPlane, opts));
  return rows;
}

// One club's row (the club picker's carry/total for a special shot), as clubTable would give it.
export function clubRow(terrain, pos, lie, wind = ZERO_WIND, clubId, opts = {}) {
  const c = typeof clubId === 'string' ? clubById(clubId) : clubId;
  if (!c || c.kind === 'putter') return null;
  const { aimYaw, start, plane, greenPlane } = tableSetup(terrain, pos, lie, opts);
  return tableRow(c, lie, wind, aimYaw, start, plane, greenPlane, opts);
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

// Carry and total of one club against swing power, over flat ground with the lie and the wind
// (8 short simulations; the HUD interpolates it while the player draws the club back). With a
// special shot (opts.shot) the curve is that shot's; side / sideTotal are where it lands / stops
// across the aim line (m, + = right: a draw lands left of it).
export const CURVE_POWERS = [0.1, 0.25, 0.4, 0.55, 0.7, 0.85, 1, 1.1];

export function powerCurve(terrain, pos, lie, wind, clubId, aimYaw, opts = {}) {
  const z = terrain.heightAt(pos.x, pos.y);
  const plane = planeTerrain({ surface: SURF.FAIRWAY, z0: z, conditions: terrain.conditions || null });
  const start = { x: pos.x, y: pos.y, z: z + BALL_R };
  const so = shotOpts(typeof clubId === 'string' ? clubById(clubId) : clubId, lie, opts);
  return CURVE_POWERS.map((power) => {
    const launch = swingToLaunch(clubId, lie, { ...STOCK, power }, aimYaw, null, { pos: start, ...so });
    const r = simulateShot(plane, launch, { wind, record: false, pin: false });
    return { power, carry: r.carry, total: r.total, side: r.landing ? sideOf(start, aimYaw, r.landing) : 0, sideTotal: sideOf(start, aimYaw, r.final) };
  });
}

export function curveAt(curve, power) {
  if (power <= curve[0].power) {
    const a = curve[0];
    const f = Math.max(0, power) / a.power;
    return { carry: a.carry * f, total: a.total * f, side: (a.side ?? 0) * f, sideTotal: (a.sideTotal ?? 0) * f };
  }
  for (let i = 1; i < curve.length; i++) {
    if (power <= curve[i].power || i === curve.length - 1) {
      const a = curve[i - 1];
      const b = curve[i];
      const f = Math.min(1, (power - a.power) / (b.power - a.power));
      const lerp = (u = 0, v = 0) => u + (v - u) * f;
      return { carry: lerp(a.carry, b.carry), total: lerp(a.total, b.total), side: lerp(a.side, b.side), sideTotal: lerp(a.sideTotal, b.sideTotal) };
    }
  }
  return { carry: 0, total: 0, side: 0, sideTotal: 0 };
}

// Predicted stock shot on the real hole (with wind, trees and hazards); opts.shot plays a special
// shot.
export function predictShot(terrain, pos, lie, wind, clubId, aimYaw, power = 1, opts = {}) {
  const z = terrain.heightAt(pos.x, pos.y);
  const so = shotOpts(typeof clubId === 'string' ? clubById(clubId) : clubId, lie, opts);
  const launch = swingToLaunch(clubId, lie, { ...STOCK, power }, aimYaw, null, { pos: { x: pos.x, y: pos.y, z: z + BALL_R }, ...so });
  return simulateShot(terrain, launch, { wind, seed: CADDIE_SEED, record: false });
}

// The intended flight of a shot at a power over flat fairway at the ball's height (with the wind),
// recorded for the aim preview: main.js drapes path [t, x, y, z]* onto the hole to draw where a
// draw or cut bends. landing / final are world {x, y, z}.
export function shotPreview(terrain, pos, lie, wind, clubId, aimYaw, opts = {}) {
  const z = terrain.heightAt(pos.x, pos.y);
  const plane = planeTerrain({ surface: SURF.FAIRWAY, z0: z, conditions: terrain.conditions || null });
  const so = shotOpts(typeof clubId === 'string' ? clubById(clubId) : clubId, lie, opts);
  const power = opts.power ?? 1;
  const launch = swingToLaunch(clubId, lie, { ...STOCK, power }, aimYaw, null, { pos: { x: pos.x, y: pos.y, z: z + BALL_R }, ...so });
  const r = simulateShot(plane, launch, { wind, record: true, pin: false });
  return { path: r.path, carry: r.carry, total: r.total, landing: r.landing, final: r.final };
}

// A rest spot the caddie is happy to play from (not wet, not out, not in sand, not in the desert
// scrub or the long fescue; firm waste ground is fine).
const UNSAFE = new Set([SURF.BUNKER, SURF.WATER, SURF.OOB, SURF.DESERT, SURF.FESCUE]);
export function isSafeRest(res) {
  const f = res.final;
  if (f.outcome === 'water' || f.outcome === 'ob') return false;
  return !UNSAFE.has(f.surface);
}

// Where a stock shot is expected to stop, along the line (m). k is the share of the release that
// counts (RELEASE_K: some approaches land short, on slower grass).
export function expectedFinish(row, k = RELEASE_K) {
  return row.carry + k * Math.max(0, (row.totalG ?? row.total) - row.carry);
}

// Release share for a shot: the running shots (stinger, punch, bump & run) are played to run, so
// all of it counts.
export function releaseK(shotId) {
  const s = shotById(shotId);
  return s.releaseK ?? RELEASE_K;
}

export function suggestClub(terrain, pos, lie, wind = ZERO_WIND, opts = {}) {
  const surf = lie ? lie.surface : terrain.surfaceAt(pos.x, pos.y);
  if (surf === SURF.GREEN || surf === SURF.FRINGE) return PUTTER_ID;
  const table = opts.table || clubTable(terrain, pos, lie, wind, opts);
  const cup = terrain.cup;
  const aimYaw = opts.aimYaw ?? (lie && lie.aimYaw !== undefined ? lie.aimYaw : yawTo(pos, cup));
  const par = opts.par ?? terrain.par ?? 4;
  const teeShot = opts.teeShot ?? surf === SURF.TEE;
  // The driver is a tee club, and a club is no use when a shorter one carries at least as far
  // (woods from the rough).
  const usable = table.filter((r, i) => (r.id !== 'D' || surf === SURF.TEE) && !table.slice(i + 1).some((q) => q.carry >= r.carry));
  const dist = Math.hypot(cup.x - pos.x, cup.y - pos.y);

  if (!(teeShot && par >= 4)) {
    // Approach (and par-3 tee shots): the shortest club whose stock shot finishes (carry plus
    // most of its release) at the plays-like distance; the power gauge handles the difference.
    const pl = playsLike(terrain, pos, cup, wind, table);
    const reach = usable.filter((r) => expectedFinish(r) >= REACH * pl);
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
