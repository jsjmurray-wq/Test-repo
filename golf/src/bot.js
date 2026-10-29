// Autoplay bot: a simulated "decent player" (about a 5 handicap) used by ?autoplay and the
// playability tests. Pure module.
//
//   planShot(game, {rng}) -> {clubId, yaw, swing, puttRange?, target, expected, shot}
//   playBotShot(game, opts) -> game.swing() result plus {plan} (sets club, aim, shot, putt range)
//   prepareBotShot(game, opts) -> plan (sets club, aim, shot, putt range; no swing: the caller
//                                swings game.swing(plan.swing), main.js at the golfer's impact)
//   botDecide(game) -> 'drop' | 'replay' (applies it with game.decide)
// The rng defaults to one derived from the game state, so a plan is reproducible.
//
// How it thinks: every candidate shot is simulated with the real physics on the real hole, with
// the wind, and scored by the expected number of strokes still needed from where it comes to rest
// (a strokes-gained style table by surface and distance). Candidates:
//   approach  a few clubs that can reach, at the cup and at the green centre; power is solved on
//             flat ground first, then corrected (power and aim) against the real terrain until
//             the intended ball stops at the target
//   advance   tee shots on par 4/5 and lay-ups: full swings with several clubs over a fan of aim
//             lines around the hole's aim point
//   putt      reads the break by simulating: aim and pace are corrected from where the previous
//             trial passed the cup until the putt drops (or gets as close as it can)
// Special shots (section 8.4) join the candidates where a decent player would think of them: a
// bump & run for a short approach from short grass, a punch into a stiff headwind, a stinger off
// the tee (or a lay-up) into one. They win only when they score better, like any candidate.
//   escape    from a deep bunker (a pot: the rim a metre or more above the ball), the wedges and
//             their flops at a few powers over a wide fan (out sideways, or backwards), since the
//             line at the cup may cross a face nothing clears
// An approach whose intended ball hits a tree (or comes back behind the ball) is not "corrected"
// toward where the ricochet went; a few lines just either side of it are tried instead, so the bot
// plays round a trunk in its way.
// The best few are re-scored with seeded random misses (the bot's execution error plus the game's
// contact scatter), so risky lines next to water or OB lose to safer ones.
//
// The chosen swing carries the bot's own seeded execution error (direction, curve, power), so it
// plays like a good amateur, not a robot: the game then adds its usual contact scatter.

import { SURF } from './constants.js';
import { clubById, PUTTER_ID } from './clubs.js';
import { simulateShot, planeTerrain } from './physics.js';
import { mulberry32, gaussian } from './rng.js';
import { swingToLaunch, PUTT_RANGES } from './swing.js';
import { isEligible } from './shots.js';
import { MAX_POWER } from './input.js';
import { DEG, clamp } from './vec3.js';

// Execution error of the bot (on top of the game's random contact).
// Putting error grows with length: a long putt is harder to read as well as to start on line.
export const BOT_SKILL = {
  dirSigma: 3.5, // deg, start direction
  curveSigma: 2, // deg, face-to-path
  powerSigma: 0.05, // fraction of power on a full swing
  partialSigma: 0.1, // extra fraction of power on a short-game swing (power -> 0)
  puttDirSigma: 1.4, // deg, plus puttDirPerM per metre of putt
  puttDirPerM: 0.15,
  puttPaceSigma: 0.1, // fraction of the flat-roll distance, plus puttPacePerM per metre
  puttPacePerM: 0.004,
};

const NOISE_SAMPLES = 8; // seeded misses scored per shortlisted candidate (a line with trouble in reach of an ordinary miss scores worse)
const PENALTY_FEAR = 0.3; // extra strokes a penalty "costs" in the bot's mind: it plays away from trouble
const SHORTLIST = 4;
const PUTT_PAST = 0.35; // m: putts are paced to die this far past the cup
const LAYUP_FAN = [-8, -4, 0, 4, 8]; // deg around the aim point
const BUMP_RANGE = 45; // m: approaches this short may be bumped along the ground
const BUMP_CLUBS = ['8i', 'PW'];
const BUMP_FROM = new Set([SURF.FAIRWAY, SURF.FRINGE, SURF.TEE, SURF.WASTE]);
const HEADWIND = 4; // m/s against the shot before the bot thinks of keeping it low
const DEEP_RIM = 1; // m: a bunker whose rim stands this far above the ball calls for an escape
const ESCAPE_FAN = [0, -25, 25, -50, 50, -90, 90, 180]; // deg from the cup line
const ESCAPE_POWERS = [0.6, 0.85, 1];
const AROUND = [-3, 3, -6, 6]; // deg: lines either side of an approach blocked by a tree
const ZERO_WIND = { x: 0, y: 0 };

// Expected strokes to hole out, by surface and distance (m). Piecewise-linear tables tuned to a
// low-handicap amateur; only their ordering matters to the bot.
const PUTT_E = [[0, 1], [0.6, 1.01], [1, 1.06], [2, 1.25], [3, 1.42], [5, 1.62], [8, 1.8], [12, 1.93], [20, 2.08], [40, 2.35]];
const FIELD_E = [[0, 2], [5, 2.15], [20, 2.4], [50, 2.65], [100, 2.85], [150, 3.05], [200, 3.3], [250, 3.6], [300, 3.85], [400, 4.3], [550, 5]];

// Extra expected strokes from a lie (off the fairway): firm waste ground barely matters, the
// desert scrub and long fescue (which grab the club) cost more than rough, sand most.
const LIE_COST = {
  [SURF.ROUGH]: 0.25,
  [SURF.OOB]: 0.25,
  [SURF.BUNKER]: 0.45,
  [SURF.WASTE]: 0.1,
  [SURF.DESERT]: 0.4,
  [SURF.FESCUE]: 0.45,
};

function interp(tab, d) {
  if (d <= tab[0][0]) return tab[0][1];
  for (let i = 1; i < tab.length; i++) {
    if (d <= tab[i][0]) {
      const f = (d - tab[i - 1][0]) / (tab[i][0] - tab[i - 1][0]);
      return tab[i - 1][1] + (tab[i][1] - tab[i - 1][1]) * f;
    }
  }
  const n = tab.length - 1;
  return tab[n][1] + (d - tab[n][0]) * 0.004;
}

// Expected strokes from a resting ball (no penalty context).
function expectedAt(t, x, y, surface) {
  const d = Math.hypot(t.cup.x - x, t.cup.y - y);
  let e;
  if (surface === SURF.GREEN) e = interp(PUTT_E, d);
  else if (surface === SURF.FRINGE) e = interp(PUTT_E, d) + 0.12;
  else {
    e = interp(FIELD_E, d);
    e += LIE_COST[surface] ?? 0;
    // In among the trees (or tight against a cactus or rock): a punch out is likely.
    if (surface !== SURF.FAIRWAY && surface !== SURF.TEE && t.treesNear) {
      const near = t.treesNear(x, y, 4);
      if (near.some((tr) => Math.hypot(tr.x - x, tr.y - y) < (tr.canopy ? tr.canopy.rx : tr.trunkR) + 1)) e += 0.35;
    }
  }
  return e;
}

// Expected strokes after a simulated shot, from a start worth eStart.
function scoreResult(t, res, eStart) {
  const f = res.final;
  if (f.outcome === 'holed') return 0;
  if (f.outcome === 'ob') return 1 + PENALTY_FEAR + eStart; // stroke and distance
  if (f.outcome === 'water') {
    const p = res.waterEntry || f;
    return 1 + PENALTY_FEAR + expectedAt(t, p.x, p.y, SURF.ROUGH) + 0.1;
  }
  return expectedAt(t, f.x, f.y, f.surface);
}

const fullSwing = (power, startDir = 0, faceToPath = 0) => ({ ok: true, kind: 'full', power, startDir, faceToPath, tempo: 'smooth', label: 'Bot' });
const puttSwing = (power, startDir = 0) => ({ ok: true, kind: 'putt', power, startDir, faceToPath: 0, tempo: 'smooth', label: 'Bot' });

function simulate(t, club, lie, swing, yaw, pos, wind, opts = {}) {
  const launch = swingToLaunch(club, lie, swing, yaw, opts.rng || null, { pos, puttRange: opts.puttRange, shot: opts.shot, handed: opts.handed });
  return simulateShot(t, launch, { wind, seed: opts.seed || 3, record: !!opts.record });
}

// Signed lateral (+ = right of the line) and along-line coordinates of p relative to the line from
// `from` along yaw.
function lineCoords(from, yaw, p) {
  const dx = p.x - from.x;
  const dy = p.y - from.y;
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return { along: dx * c + dy * s, lat: dx * s - dy * c };
}

// ------------------------------------------------------------------ full shots

// Relative power error: touch is hardest on short-game swings.
const powerSigma = (p) => BOT_SKILL.powerSigma + BOT_SKILL.partialSigma * Math.max(0, 1 - p);

// Power for which the stock flat-ground total equals `want` (m), by bisection.
function solvePowerFlat(flat, club, lie, yaw, pos, wind, want, so = {}) {
  let lo = 0.05;
  let hi = 1;
  const total = (p) => simulate(flat, club, lie, fullSwing(p), yaw, pos, wind, so).total;
  if (total(hi) <= want) return 1;
  for (let i = 0; i < 9; i++) {
    const mid = 0.5 * (lo + hi);
    if (total(mid) < want) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

// Approach at a target point: solve power on flat ground, then correct power and aim on the real
// hole so the intended ball stops at the target. Returns a candidate.
function approach(ctx, club, target, shot = 'normal') {
  const { t, pos, lie, wind, flat } = ctx;
  const so = { shot, handed: ctx.handed };
  const dist = Math.hypot(target.x - pos.x, target.y - pos.y);
  let yaw = Math.atan2(target.y - pos.y, target.x - pos.x);
  let want = dist + (target.z - pos.z) * 0.9; // a little extra for a raised target
  let power = solvePowerFlat(flat, club, lie, yaw, pos, wind, want, so);
  let res = null;
  for (let it = 0; it < 3; it++) {
    res = simulate(t, club, lie, fullSwing(power), yaw, pos, wind, so);
    const f = res.final;
    if (f.outcome === 'holed') break;
    const c = lineCoords(pos, yaw, f);
    const tc = lineCoords(pos, yaw, target);
    const along = c.along - tc.along;
    const lat = c.lat - tc.lat;
    if (Math.abs(along) < 2 && Math.abs(lat) < 2) break;
    // A ball that hit a tree, or finished behind where it started, says nothing about the aim:
    // correcting toward the ricochet sent shots far off line (planFull tries lines round it).
    if (c.along < 0 || res.events.some((e) => e.type === 'tree')) break;
    // Rotate toward the target (a ball finishing right needs a yaw increase: CCW is left) and
    // re-solve the power for the corrected distance.
    if (f.outcome === 'rest') {
      yaw += Math.atan2(lat, Math.max(5, c.along));
      want = clamp(want - along, 0.3 * dist, 1.5 * dist + 10);
      if (power >= 1 && along < 0) break; // already flat out
      power = solvePowerFlat(flat, club, lie, yaw, pos, wind, want, so);
    } else break;
  }
  return { clubId: club.id, yaw, power, intended: res, shot };
}

// Wind blowing against a shot along yaw (m/s, + = into the player's face).
const headwind = (wind, yaw) => -(wind.x * Math.cos(yaw) + wind.y * Math.sin(yaw));

function candidateClubs(ctx, pl) {
  const { table, lie } = ctx;
  const usable = table.filter((r) => r.id !== 'D' || lie.surface === SURF.TEE);
  // Clubs that reach with a full or near-full swing, shortest first; short game: the wedges.
  const reach = usable.filter((r) => r.carry >= 0.9 * pl).reverse();
  const out = reach.slice(0, 2).map((r) => r.id);
  if (pl < 60) for (const id of ['SW', 'LW', 'GW']) if (!out.includes(id)) out.push(id);
  if (lie.surface === SURF.BUNKER && !out.includes('SW')) out.unshift('SW');
  return out.slice(0, 3);
}

// Height of the highest ground within ~2.5 m above the ball's ground (a deep bunker's rim).
function rimAbove(t, pos) {
  const z = t.heightAt(pos.x, pos.y);
  let top = z;
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * 2 * Math.PI;
    for (const r of [1.5, 2.5, 3.5]) top = Math.max(top, t.heightAt(pos.x + r * Math.cos(a), pos.y + r * Math.sin(a)));
  }
  return top - z;
}

function planFull(game, rng) {
  const t = game.terrain;
  const st = game.state;
  const pos = st.hole.ball;
  const wind = game.wind || ZERO_WIND;
  const z = t.heightAt(pos.x, pos.y);
  const ctx = {
    t,
    pos,
    lie: game.lie,
    wind,
    table: game.table,
    flat: planeTerrain({ surface: SURF.FAIRWAY, z0: z, conditions: t.conditions || null }),
    handed: st.settings.handed,
  };
  const eStart = expectedAt(t, pos.x, pos.y, ctx.lie.surface);
  const cup = t.cup;
  const dCup = Math.hypot(cup.x - pos.x, cup.y - pos.y);
  const pl = dCup + (cup.z - z);
  const usable = ctx.table.filter((r) => r.id !== 'D' || ctx.lie.surface === SURF.TEE);
  const maxCarry = Math.max(...usable.map((r) => r.carry));
  const teeLong = st.hole.onTee && t.par >= 4;
  const cands = [];

  if (!teeLong && maxCarry >= 0.85 * pl) {
    const g = t.greenCenter;
    const targets = [cup];
    if (Math.hypot(g.x - cup.x, g.y - cup.y) > 4) targets.push(g);
    const ids = candidateClubs(ctx, pl);
    for (const id of ids) {
      const club = clubById(id);
      for (const target of targets) cands.push(approach(ctx, club, target));
    }
    // Into a stiff wind, the same clubs knocked down.
    const yawCup = Math.atan2(cup.y - pos.y, cup.x - pos.x);
    if (headwind(wind, yawCup) >= HEADWIND) {
      for (const id of ids) if (isEligible('punch', id, ctx.lie)) cands.push(approach(ctx, clubById(id), cup, 'punch'));
    }
    // Short of the green on short grass: run it along the ground.
    if (pl < BUMP_RANGE && BUMP_FROM.has(ctx.lie.surface)) {
      for (const id of BUMP_CLUBS) if (isEligible('bump', id, ctx.lie)) cands.push(approach(ctx, clubById(id), cup, 'bump'));
    }
  }
  if (teeLong || maxCarry < 1.05 * pl) {
    // Advance: full swings along a fan of lines around the course's aim point.
    const ap = t.aimPoint(pos);
    const yaw0 = Math.atan2(ap.y - pos.y, ap.x - pos.x);
    const ids = usable.filter((r) => r.total <= dCup + 15).slice(0, 6).map((r) => r.id);
    for (const id of ids) {
      const club = clubById(id);
      for (const off of LAYUP_FAN) {
        const yaw = yaw0 + off * DEG;
        cands.push({ clubId: id, yaw, power: 1, intended: simulate(t, club, ctx.lie, fullSwing(1), yaw, pos, wind), shot: 'normal' });
      }
    }
    // Into a stiff wind: the longest two clubs as stingers (they run under it).
    if (headwind(wind, yaw0) >= HEADWIND) {
      const so = { shot: 'stinger', handed: ctx.handed };
      for (const id of ids.filter((i) => isEligible('stinger', i, ctx.lie)).slice(0, 2)) {
        const club = clubById(id);
        for (const off of LAYUP_FAN) {
          const yaw = yaw0 + off * DEG;
          cands.push({ clubId: id, yaw, power: 1, intended: simulate(t, club, ctx.lie, fullSwing(1), yaw, pos, wind, so), shot: 'stinger' });
        }
      }
    }
  }
  // Approaches blocked by a tree: try lines just either side (same club, power and shot).
  for (const c of cands.slice()) {
    if (!c.intended.events.some((e) => e.type === 'tree')) continue;
    const club = clubById(c.clubId);
    for (const off of AROUND) {
      const yaw = c.yaw + off * DEG;
      cands.push({ clubId: c.clubId, yaw, power: c.power, intended: simulate(t, club, ctx.lie, fullSwing(c.power), yaw, pos, wind, { shot: c.shot, handed: ctx.handed }), shot: c.shot });
    }
  }
  // Deep in a pot: wedges and flops over a wide fan, the way out first and the distance second.
  if (ctx.lie.surface === SURF.BUNKER && rimAbove(t, pos) >= DEEP_RIM) {
    const yawCup = Math.atan2(cup.y - pos.y, cup.x - pos.x);
    for (const id of ['SW', 'LW']) {
      const club = clubById(id);
      for (const shot of ['flop', 'normal']) {
        if (shot !== 'normal' && !isEligible(shot, id, ctx.lie)) continue;
        const so = { shot, handed: ctx.handed };
        for (const off of ESCAPE_FAN) {
          const yaw = yawCup + off * DEG;
          for (const power of ESCAPE_POWERS) cands.push({ clubId: id, yaw, power, intended: simulate(t, club, ctx.lie, fullSwing(power), yaw, pos, wind, so), shot });
        }
      }
    }
  }
  if (!cands.length) {
    const yaw = Math.atan2(cup.y - pos.y, cup.x - pos.x);
    cands.push({ clubId: 'SW', yaw, power: 0.5, intended: simulate(t, clubById('SW'), ctx.lie, fullSwing(0.5), yaw, pos, wind), shot: 'normal' });
  }

  // Shortlist on the intended result, then score the best with seeded misses.
  for (const c of cands) c.e0 = scoreResult(t, c.intended, eStart);
  cands.sort((a, b) => a.e0 - b.e0);
  const short = cands.slice(0, SHORTLIST);
  for (const c of short) {
    const club = clubById(c.clubId);
    const sr = mulberry32(0x5eed ^ Math.round(c.yaw * 1e4) ^ Math.round(c.power * 1e4));
    let sum = c.e0;
    for (let k = 0; k < NOISE_SAMPLES; k++) {
      const sw = fullSwing(c.power * (1 + powerSigma(c.power) * gaussian(sr)), BOT_SKILL.dirSigma * gaussian(sr), BOT_SKILL.curveSigma * gaussian(sr));
      sum += scoreResult(t, simulate(t, club, ctx.lie, sw, c.yaw, pos, wind, { rng: sr, seed: 11 + k, shot: c.shot, handed: ctx.handed }), eStart);
    }
    c.e = sum / (NOISE_SAMPLES + 1);
  }
  short.sort((a, b) => a.e - b.e);
  const best = short[0];
  const swing = fullSwing(
    clamp(best.power * (1 + powerSigma(best.power) * gaussian(rng)), 0.05, MAX_POWER),
    BOT_SKILL.dirSigma * gaussian(rng),
    BOT_SKILL.curveSigma * gaussian(rng),
  );
  return { clubId: best.clubId, yaw: best.yaw, swing, target: best.intended.final, expected: best.e, shot: best.shot || 'normal' };
}

// ------------------------------------------------------------------ putts

// Reads the putt by simulation: start at the cup with a pace that dies PUTT_PAST beyond it, then
// correct aim from where the trial passed the hole and pace from where it stopped.
function planPutt(game, rng) {
  const t = game.terrain;
  const pos = game.state.hole.ball;
  const cup = t.cup;
  const club = clubById(PUTTER_ID);
  const lie = game.lie;
  const D = Math.hypot(cup.x - pos.x, cup.y - pos.y);
  const yawCup = Math.atan2(cup.y - pos.y, cup.x - pos.x);
  let range = PUTT_RANGES[PUTT_RANGES.length - 1];
  for (const r of PUTT_RANGES) {
    if (r * 0.95 >= D + 2) {
      range = r;
      break;
    }
  }
  let yaw = yawCup;
  let Df = D + PUTT_PAST;
  let best = null;
  for (let it = 0; it < 8; it++) {
    const power = clamp(Df / range, 0.01, MAX_POWER);
    const res = simulate(t, club, lie, puttSwing(power), yaw, pos, ZERO_WIND, { puttRange: range, record: true });
    // Closest approach of the trial to the cup, and on which side it passed.
    const path = res.path;
    let dMin = Infinity;
    let side = 0;
    for (let i = 0; i < path.length; i += 4) {
      const dx = path[i + 1] - cup.x;
      const dy = path[i + 2] - cup.y;
      const d = Math.hypot(dx, dy);
      if (d < dMin) {
        dMin = d;
        side = lineCoords(pos, yawCup, { x: path[i + 1], y: path[i + 2] }).lat;
      }
    }
    const holed = res.final.outcome === 'holed';
    // A holed trial slides to the cup centre: take its side from where it was captured instead,
    // and keep refining until it drops in the middle (the most margin for error).
    if (holed) side = lineCoords(pos, yawCup, res.events.find((e) => e.type === 'cup')).lat;
    const fc = lineCoords(pos, yawCup, res.final);
    const paceErr = holed ? 0 : fc.along - (D + PUTT_PAST);
    const score = holed ? -1 + Math.abs(side) : dMin + 0.3 * Math.abs(paceErr);
    if (!best || score < best.score) best = { yaw, Df, score, holed };
    if (holed && Math.abs(side) < 0.01) break;
    // Passed right of the cup -> turn left (CCW); stopped long -> softer.
    yaw += Math.atan2(side, Math.max(0.5, D));
    Df = clamp(Df - 0.8 * paceErr, 0.2, range * MAX_POWER);
  }
  const DfErr = best.Df * (1 + (BOT_SKILL.puttPaceSigma + BOT_SKILL.puttPacePerM * D) * gaussian(rng));
  const power = clamp(DfErr / range, 0.01, MAX_POWER);
  const swing = puttSwing(power, (BOT_SKILL.puttDirSigma + BOT_SKILL.puttDirPerM * D) * gaussian(rng));
  return { clubId: PUTTER_ID, yaw: best.yaw, swing, puttRange: range, target: cup, expected: best.holed ? 1 : interp(PUTT_E, D), shot: 'normal' };
}

// ------------------------------------------------------------------ entry points

function botRng(game) {
  const st = game.state;
  const b = st.hole.ball;
  const h = (st.seed ^ Math.imul(st.holeIndex + 1, 0x85ebca6b) ^ Math.imul(st.hole.strokes + 7, 0xc2b2ae35) ^ Math.round(b.x * 1000) ^ Math.round(b.y * 977)) >>> 0;
  return mulberry32(h);
}

export function planShot(game, opts = {}) {
  const rng = opts.rng || botRng(game);
  const s = game.lie.surface;
  return s === SURF.GREEN || s === SURF.FRINGE ? planPutt(game, rng) : planFull(game, rng);
}

// Water relief choice: whichever spot the bot expects to score better from.
export function botDecide(game) {
  const d = game.state.decision;
  if (!d) return null;
  const t = game.terrain;
  const e = (p) => expectedAt(t, p.x, p.y, t.surfaceAt(p.x, p.y));
  const choice = e(d.replay) + 0.05 < e(d.drop) ? 'replay' : 'drop';
  game.decide(choice);
  return choice;
}

export function playBotShot(game, opts = {}) {
  const plan = prepareBotShot(game, opts);
  const r = game.swing(plan.swing);
  return { ...r, plan };
}

// Plans the shot and sets it up (club, aim, shot, putt range) without swinging: the caller swings
// game.swing(plan.swing) later (main.js: when the animated golfer's club reaches the ball).
export function prepareBotShot(game, opts = {}) {
  const plan = planShot(game, opts);
  game.setClub(plan.clubId);
  game.setAim(plan.yaw);
  game.setShot(plan.shot || 'normal');
  if (plan.puttRange) game.setPuttRange(plan.puttRange);
  return plan;
}

