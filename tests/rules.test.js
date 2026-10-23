// Rules engine tests (docs/rules-spec.md section 12). Run: node --test tests/rules.test.js
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { BALL_R, RACK_GAP, groupOf } from '../src/constants.js';
import { TABLE } from '../src/table.js';
import { mulberry32 } from '../src/rng.js';
import {
  RULESET_CASUAL,
  RULESET_PRO,
  createRack,
  newGameState,
  getShotRequirements,
  validateShot,
  evaluateShot,
  applyOutcome,
  applyDecision,
  defaultDecision,
  validateCuePlacement,
  nearestValidPlacement,
  spotPosition,
  isOnEight,
  hudInfo,
  summarize,
  rackOverText,
  matchOverText,
  rackReasonText,
} from '../src/rules.js';

const R = BALL_R;
const HSX = TABLE.headStringX;
const FS = TABLE.footSpot;
const PLAYERS = Object.freeze([
  { name: 'You', kind: 'human' },
  { name: 'CPU', kind: 'cpu', level: 'medium' },
]);
const PVP = Object.freeze([
  { name: 'Ann', kind: 'human' },
  { name: 'Bob', kind: 'human' },
]);

// ---- Fixtures ----

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o) && !ArrayBuffer.isView(o)) {
    Object.freeze(o);
    for (const k of Object.keys(o)) deepFreeze(o[k]);
  }
  return o;
}

// Default layout: object balls on a 5x3 grid well away from pockets, strings and the kitchen.
function gridPos(id) {
  const k = id - 1;
  return [-0.3 + (k % 5) * 0.15, [-0.3, -0.18, 0.15][Math.floor(k / 5)]];
}

function mkState({
  groups = [null, null],
  on = null,
  turn = 0,
  ballInHand = null,
  isBreak = false,
  pos = {},
  players = PLAYERS,
  ruleset = RULESET_CASUAL,
  dryTurns = 0,
} = {}) {
  const onSet = on ? new Set([0, ...on]) : null;
  const balls = [];
  for (let id = 0; id < 16; id++) {
    let [x, y] = id === 0 ? (isBreak ? [HSX - 2 * R, 0] : [-0.35, 0.3]) : gridPos(id);
    if (pos[id]) [x, y] = pos[id];
    balls.push({ id, x, y, on: onSet ? onSet.has(id) : true });
  }
  return deepFreeze({
    v: 1,
    ruleset,
    players,
    rackNo: 1,
    breaker: 0,
    turn,
    isBreakShot: isBreak,
    groups,
    ballInHand: isBreak ? 'kitchen' : ballInHand,
    balls,
    pocketed: [],
    pendingDecision: null,
    shotNo: 0,
    fouls: [0, 0],
    dryTurns,
    history: [],
    winner: null,
    endReason: null,
  });
}

// Log builders: each takes the next seq automatically (global, so always strictly increasing).
let SEQ = 0;
let T = 0;
function ev(o, dt = 0.01) {
  T += dt;
  return { seq: ++SEQ, t: T, ...o };
}
const strike = () => ev({ type: 'strike', v: 3, miscue: false });
const hit = (b, { a = 0, dt } = {}) => ev({ type: 'ball', a: Math.min(a, b), b: Math.max(a, b), v: 1 }, dt);
const rail = (b, { frozen = false } = {}) => ev({ type: 'cushion', ball: b, v: 0.4, frozen, cushion: 3 });
const pot = (b, pocket = 2) => ev({ type: 'pocket', ball: b, pocket, v: 0.8 });
const off = (b) => ev({ type: 'offTable', ball: b });
const cross = (dir) => ev({ type: 'cross', ball: 0, dir });

// Record with `final` = start positions, minus balls that dropped/left, plus `pos` overrides.
function mkRecord(state, log, { call = null, pos = {} } = {}) {
  const gone = new Set(log.filter((e) => e.type === 'pocket' || e.type === 'offTable').map((e) => e.ball));
  const final = state.balls.map((b) => {
    const [x, y] = pos[b.id] || [b.x, b.y];
    return { id: b.id, x, y, on: b.on && !gone.has(b.id) };
  });
  return deepFreeze({ call, log, final });
}

function play(state, log, opts = {}) {
  const rec = mkRecord(state, [strike(), ...log], opts);
  const out = evaluateShot(state, rec, opts.evalOpts);
  deepFreeze(out);
  const next = deepFreeze(applyOutcome(state, rec, out));
  return { out, next, rec };
}

const texts = (out) => out.messages.map((m) => m.text);
const breakState = (opts = {}) => mkState({ isBreak: true, ...opts });
const SHOT = { angle: 0, power: 0.5, spin: { x: 0, y: 0 }, call: null };

// ---- Break ----

describe('break', () => {
  test('B01 break.pot.continues', () => {
    const st = breakState();
    const { out, next } = play(st, [hit(1), rail(1), rail(2), pot(3, 2)]);
    assert.deepEqual(out.fouls, []);
    assert.equal(out.breakLegal, true);
    assert.equal(out.continueTurn, true);
    assert.equal(out.nextPlayer, 0);
    assert.equal(out.reason, 'BREAK_POT');
    assert.equal(out.groupAssigned, null);
    assert.deepEqual(out.credited, []);
    assert.deepEqual(next.groups, [null, null]);
    assert.equal(next.isBreakShot, false);
    assert.equal(next.turn, 0);
    assert.equal(next.ballInHand, null);
    assert.equal(next.balls[3].on, false);
    assert.deepEqual(next.pocketed, [{ ball: 3, pocket: 2, shot: 1, by: 0 }]);
    assert.ok(texts(out).includes('Good break — You shoot again. Table is open'));
  });

  test('B02 break.fourRails.passes', () => {
    const { out, next } = play(breakState(), [hit(1), rail(1), rail(4), rail(9), rail(13)]);
    assert.deepEqual(out.fouls, []);
    assert.equal(out.breakLegal, true);
    assert.equal(out.reason, 'BREAK_DRY');
    assert.equal(out.continueTurn, false);
    assert.equal(out.nextPlayer, 1);
    assert.equal(out.ballInHand, null);
    assert.equal(next.turn, 1);
    assert.equal(next.ballInHand, null);
    assert.equal(next.isBreakShot, false);
    assert.ok(texts(out).includes("Legal break — table is open. CPU's shot"));
  });

  test('B03 break.bothGroups.open', () => {
    const { out, next } = play(breakState(), [hit(1), pot(2, 0), pot(10, 3)]);
    assert.equal(out.reason, 'BREAK_POT');
    assert.equal(out.groupAssigned, null);
    assert.deepEqual(out.pocketed, [2, 10]);
    assert.deepEqual(next.groups, [null, null]);
    assert.equal(next.turn, 0);
  });

  test('B04 break.threeRails.illegal', () => {
    const st = breakState();
    const { out, next } = play(st, [hit(1), rail(1), rail(5), rail(12)]);
    assert.deepEqual(out.fouls, ['ILLEGAL_BREAK']);
    assert.equal(out.primaryFoul, 'ILLEGAL_BREAK');
    assert.equal(out.breakLegal, false);
    assert.equal(out.reason, 'BREAK_ILLEGAL');
    assert.equal(out.nextPlayer, 1);
    assert.equal(out.continueTurn, false);
    assert.equal(out.decision.type, 'illegalBreak');
    assert.equal(out.decision.chooser, 1);
    assert.deepEqual(out.decision.options, ['acceptTable', 'rerackBreak', 'rerackOpponentBreaks']);
    assert.equal(out.decision.cueInHand, null);
    assert.deepEqual(out.decision.labels, {
      acceptTable: 'Play from here',
      rerackBreak: 'Re-rack & break',
      rerackOpponentBreaks: 'Re-rack, You break again',
    });
    assert.equal(out.decision.title, 'Illegal break');
    assert.equal(hudInfo(next).banner, 'Illegal break — CPU chooses');
    assert.ok(texts(out)[0].includes('(3 hit)'));
    assert.deepEqual(next.pendingDecision.options, out.decision.options);
    assert.equal(next.turn, 1);
    assert.deepEqual(validateShot(next, SHOT), { ok: false, error: 'PENDING_DECISION' });
    assert.equal(defaultDecision(next.pendingDecision), 'rerackBreak');
  });

  test('B05 break.sameBallTwice.countsOnce', () => {
    const { out } = play(breakState(), [hit(1), rail(1), rail(1), rail(1), rail(6), rail(6)]);
    assert.equal(out.railBalls, 2);
    assert.equal(out.reason, 'BREAK_ILLEGAL');
  });

  test('B06 break.cueRails.dontCount', () => {
    const { out } = play(breakState(), [hit(1), rail(0), rail(0), rail(1), rail(2), rail(3)]);
    assert.equal(out.railBalls, 3);
    assert.equal(out.reason, 'BREAK_ILLEGAL');
  });

  test('B07 break.totalMiss.illegal', () => {
    const { out } = play(breakState(), [rail(0), rail(0)]);
    assert.deepEqual(out.fouls, ['ILLEGAL_BREAK']);
    assert.equal(out.railBalls, 0);
    assert.equal(out.decision.chooser, 1);
  });

  test('B08 break.illegal.scratch.acceptGivesKitchen', () => {
    const { out, next } = play(breakState(), [hit(1), rail(1), pot(0, 5)]);
    assert.deepEqual(out.fouls, ['ILLEGAL_BREAK', 'SCRATCH']);
    assert.equal(out.decision.cueInHand, 'kitchen');
    assert.equal(out.decision.labels.acceptTable, 'Play from here (ball in hand)');
    assert.equal(next.balls[0].on, false);
    const acc = deepFreeze(applyDecision(next, 'acceptTable', mulberry32(1)));
    assert.equal(acc.turn, 1);
    assert.equal(acc.ballInHand, 'kitchen');
    assert.equal(acc.isBreakShot, false);
    assert.equal(acc.pendingDecision, null);
    assert.equal(acc.balls[0].on, true);
    assert.ok(acc.balls[0].x < HSX);
    assert.ok(validateCuePlacement(acc, acc.balls[0]).ok);
    assert.deepEqual(validateShot(acc, SHOT), { ok: true });
  });

  test('B09 decision.acceptTable', () => {
    const st = breakState();
    const { next } = play(st, [hit(1), rail(1)], { pos: { 0: [0.1, 0.3] } });
    const acc = applyDecision(next, 'acceptTable', mulberry32(1));
    assert.equal(acc.isBreakShot, false);
    assert.equal(acc.turn, 1);
    assert.equal(acc.ballInHand, null);
    assert.deepEqual([acc.balls[0].x, acc.balls[0].y, acc.balls[0].on], [0.1, 0.3, true]);
    assert.deepEqual(acc.groups, [null, null]);
    assert.deepEqual(getShotRequirements(acc).legalTargets, [1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15]);
  });

  test('B10 decision.rerackBreak', () => {
    const { next } = play(breakState(), [hit(1)]);
    const r = applyDecision(next, 'rerackBreak', mulberry32(9));
    assert.equal(r.breaker, 1);
    assert.equal(r.turn, 1);
    assert.equal(r.isBreakShot, true);
    assert.equal(r.ballInHand, 'kitchen');
    assert.equal(r.pendingDecision, null);
    assert.ok(r.balls.every((b) => b.on));
    assert.deepEqual(r.balls, createRack(mulberry32(9)).balls);
    assert.equal(r.shotNo, 0);
  });

  test('B11 decision.rerackOpponentBreaks', () => {
    const { next } = play(breakState(), [hit(1)]);
    const r = applyDecision(next, 'rerackOpponentBreaks', mulberry32(9));
    assert.equal(r.breaker, 0);
    assert.equal(r.turn, 0);
    assert.equal(r.isBreakShot, true);
    assert.throws(() => applyDecision(next, 'bogus', mulberry32(1)));
  });

  test('B12 break.scratch.legal', () => {
    const { out, next } = play(breakState(), [hit(1), rail(1), pot(4, 1), pot(0, 2)]);
    assert.deepEqual(out.fouls, ['SCRATCH']);
    assert.equal(out.breakLegal, true);
    assert.equal(out.reason, 'BREAK_FOUL');
    assert.equal(out.nextPlayer, 1);
    assert.equal(out.ballInHand, 'kitchen');
    assert.equal(next.balls[4].on, false);
    assert.deepEqual(next.groups, [null, null]);
    assert.equal(next.turn, 1);
    assert.equal(next.ballInHand, 'kitchen');
    assert.deepEqual([next.balls[0].x, next.balls[0].y, next.balls[0].on], [HSX - 2 * R, 0, true]);
    assert.equal(texts(out)[0], 'Scratch on the break — CPU has ball in hand behind the head string');
  });

  test('B13 break.eight.spotted.continue', () => {
    const { out, next } = play(breakState(), [hit(1), pot(8, 3)]);
    assert.equal(out.reason, 'EIGHT_ON_BREAK');
    assert.equal(out.gameOver, false);
    assert.equal(out.continueTurn, true);
    assert.deepEqual(out.respot, [{ ball: 8, x: FS.x, y: FS.y }]);
    assert.deepEqual(next.balls[8], { id: 8, x: FS.x, y: FS.y, on: true });
    assert.equal(next.turn, 0);
    assert.deepEqual(next.pocketed, []);
    assert.ok(texts(out).includes('8-ball down on the break — re-spotted'));
  });

  test('B14 break.eight.footSpotBlocked', () => {
    const { out } = play(breakState(), [hit(1), pot(8, 3)], { pos: { 3: [FS.x, 0] } });
    const s = out.respot[0];
    assert.equal(s.y, 0);
    assert.ok(s.x > FS.x);
    const gap = Math.hypot(s.x - FS.x, s.y) - 2 * R;
    assert.ok(gap > 0 && gap <= 0.0001, `gap ${gap}`);
  });

  test('B15 break.eight.longStringBlocked', () => {
    const pos = {};
    for (let k = 0; k < 5; k++) pos[k + 1] = [FS.x + k * 0.11, 0];
    const { out } = play(breakState(), [hit(1), pot(8, 3)], { pos });
    const s = out.respot[0];
    assert.equal(s.y, 0);
    assert.ok(s.x < FS.x);
    const gap = FS.x - s.x - 2 * R;
    assert.ok(gap > 0 && gap <= 0.0001, `gap ${gap}`);
  });

  test('B16 break.eight.cueBlocks', () => {
    const { out } = play(breakState(), [hit(1), pot(8, 3)], { pos: { 0: [FS.x, 0] } });
    const s = out.respot[0];
    const gap = Math.hypot(s.x - FS.x, s.y) - 2 * R;
    assert.ok(gap >= 0.001 - 1e-9, `gap ${gap}`);
    assert.ok(gap < 0.0011);
  });

  test('B17 break.eight.scratch', () => {
    const { out, next } = play(breakState(), [hit(1), pot(8, 3), pot(0, 0)], { pos: { 0: [FS.x, 0] } });
    assert.equal(out.gameOver, false);
    assert.deepEqual(out.fouls, ['SCRATCH']);
    assert.equal(out.reason, 'EIGHT_ON_BREAK');
    assert.deepEqual(out.respot, [{ ball: 8, x: FS.x, y: 0 }]); // the scratched cue doesn't block
    assert.equal(out.nextPlayer, 1);
    assert.equal(next.ballInHand, 'kitchen');
    assert.equal(next.winner, null);
    assert.equal(next.balls[8].on, true);
    assert.ok(next.balls[0].on && next.balls[0].x < HSX);
  });

  test('B18 break.eight.offTable', () => {
    const { out, next } = play(breakState(), [hit(1), rail(1), rail(2), rail(3), rail(4), off(8)]);
    assert.equal(out.gameOver, false);
    assert.deepEqual(out.fouls, ['OBJECT_OFF_TABLE']);
    assert.equal(out.reason, 'EIGHT_ON_BREAK');
    assert.equal(out.respot[0].ball, 8);
    assert.equal(out.ballInHand, 'kitchen');
    assert.equal(next.balls[8].on, true);
    assert.equal(next.turn, 1);
  });

  test('B19 break.objectOffTable', () => {
    const { out, next } = play(breakState(), [hit(1), pot(2, 0), off(5)]);
    assert.deepEqual(out.fouls, ['OBJECT_OFF_TABLE']);
    assert.equal(out.reason, 'BREAK_FOUL');
    assert.deepEqual(out.respot, []);
    assert.equal(out.ballInHand, 'kitchen');
    assert.equal(next.balls[5].on, false);
    assert.ok(next.pocketed.some((p) => p.ball === 5 && p.pocket === -1));
    assert.equal(texts(out)[0], 'Ball off the table on the break — CPU has ball in hand behind the head string');
  });

  test('B20 break.onlyEight.continues', () => {
    const { out, next } = play(breakState(), [hit(1), rail(1), pot(8, 1)]);
    assert.equal(out.breakLegal, true);
    assert.equal(out.continueTurn, true);
    assert.equal(out.reason, 'EIGHT_ON_BREAK');
    assert.equal(next.turn, 0);
    assert.equal(next.balls[8].on, true);
    assert.equal(next.dryTurns, 0);
  });

  test('break foul messages use the right subject for the CPU breaker', () => {
    const st = breakState({ turn: 1 });
    const { out } = play(st, [hit(1), pot(3, 2)]);
    assert.ok(texts(out).includes('Good break — CPU shoots again. Table is open'));
  });
});

// ---- Open table ----

describe('open table', () => {
  test('O01 open.stripe.assigns', () => {
    const { out, next } = play(mkState(), [hit(10), pot(10, 2)]);
    assert.deepEqual(out.fouls, []);
    assert.deepEqual(out.groupAssigned, { player: 0, group: 'stripes' });
    assert.equal(out.continueTurn, true);
    assert.equal(out.reason, 'POT');
    assert.deepEqual(next.groups, ['stripes', 'solids']);
    assert.equal(next.turn, 0);
    assert.ok(texts(out).includes('You are Stripes · CPU is Solids'));
  });

  test('O02 open.combo.solidToStripe.legal', () => {
    const { out, next } = play(mkState(), [hit(2), hit(12, { a: 2 }), pot(12, 4)]);
    assert.deepEqual(out.fouls, []);
    assert.deepEqual(out.groupAssigned, { player: 0, group: 'stripes' });
    assert.deepEqual(next.groups, ['stripes', 'solids']);
  });

  test('O03 open.bothGroups.firstDropWins', () => {
    const a = play(mkState(), [hit(4), pot(4, 0), pot(11, 3)]);
    assert.deepEqual(a.out.groupAssigned, { player: 0, group: 'solids' });
    assert.deepEqual(a.out.credited, [4, 11]);
    const b = play(mkState({ turn: 1 }), [hit(4), pot(11, 3), pot(4, 0)]);
    assert.deepEqual(b.out.groupAssigned, { player: 1, group: 'stripes' });
    assert.deepEqual(b.next.groups, ['solids', 'stripes']);
    assert.ok(texts(b.out).includes('CPU is Stripes · You are Solids'));
  });

  test('O04 open.eightFirst.foul', () => {
    const { out, next } = play(mkState(), [hit(8), hit(3, { a: 8 }), pot(3, 1)]);
    assert.deepEqual(out.fouls, ['EIGHT_FIRST_OPEN']);
    assert.equal(out.reason, 'FOUL');
    assert.equal(out.groupAssigned, null);
    assert.equal(next.balls[3].on, false);
    assert.deepEqual(next.groups, [null, null]);
    assert.equal(next.ballInHand, 'anywhere');
    assert.equal(next.turn, 1);
    assert.equal(next.fouls[0], 1);
  });

  test('O05 open.scratch.noAssign', () => {
    const { out, next } = play(mkState(), [hit(5), pot(5, 0), pot(0, 3)]);
    assert.deepEqual(out.fouls, ['SCRATCH']);
    assert.equal(out.groupAssigned, null);
    assert.deepEqual(next.groups, [null, null]);
    assert.equal(next.balls[5].on, false);
    assert.equal(next.ballInHand, 'anywhere');
    assert.deepEqual([next.balls[0].x, next.balls[0].y, next.balls[0].on], [HSX, 0, true]); // head spot
    assert.equal(texts(out)[0], 'Foul: scratch — CPU has ball in hand');
  });

  test('O06 open.miss.passes', () => {
    const { out, next } = play(mkState(), [hit(5), rail(5)]);
    assert.deepEqual(out.fouls, []);
    assert.equal(out.reason, 'MISS');
    assert.equal(next.turn, 1);
    assert.equal(next.ballInHand, null);
    assert.equal(next.dryTurns, 1);
    assert.ok(texts(out).includes("CPU's shot"));
  });

  test('O07 open.eightPocketed.loss', () => {
    const { out, next } = play(mkState(), [hit(3), hit(8, { a: 3 }), pot(8, 2)], { call: { pocket: 2 } });
    assert.equal(out.gameOver, true);
    assert.equal(out.reason, 'EIGHT_EARLY');
    assert.equal(out.winner, 1);
    assert.equal(next.winner, 1);
    assert.equal(next.endReason, 'EIGHT_EARLY');
    assert.equal(out.messages[0].kind, 'loss');
  });

  test('O08 open.onlyEightLeft.callAndWin', () => {
    const st = mkState({ on: [8] });
    const req = getShotRequirements(st);
    assert.equal(req.onEight, true);
    assert.deepEqual(req.legalTargets, [8]);
    assert.equal(req.mustCallPocket, true);
    const { out } = play(st, [hit(8), pot(8, 3)], { call: { pocket: 3 } });
    assert.equal(out.reason, 'EIGHT_LEGAL');
    assert.equal(out.winner, 0);
    assert.equal(texts(out)[0], 'You win the rack!');
  });

  test('O09 assign.groupAlreadyCleared.onEight', () => {
    // Shooter pockets the last solid on an open table: solids assigned and already cleared.
    const st = mkState({ on: [1, 8, 9, 10, 11] });
    const { out, next } = play(st, [hit(1), pot(1, 0)]);
    assert.deepEqual(out.groupAssigned, { player: 0, group: 'solids' });
    assert.equal(isOnEight(next, 0), true);
    assert.equal(isOnEight(next, 1), false);
    const req = getShotRequirements(next);
    assert.equal(req.onEight, true);
    assert.equal(req.mustCallPocket, true);
    assert.deepEqual(req.legalTargets, [8]);
    // Opponent ends up with the cleared group instead.
    const b = play(mkState({ on: [8, 9, 10, 11] }), [hit(9), pot(9, 4)]);
    assert.deepEqual(b.next.groups, ['stripes', 'solids']);
    assert.equal(isOnEight(b.next, 1), true);
  });

  test('O10 kitchen.directShot.foul', () => {
    const st = mkState({ ballInHand: 'kitchen', pos: { 0: [-0.8, 0], 5: [-0.7, 0.2] } });
    assert.deepEqual(getShotRequirements(st).kitchenBlocked, [5]);
    const { out } = play(st, [hit(5), rail(5)]);
    assert.deepEqual(out.fouls, ['KITCHEN']);
    assert.equal(texts(out)[0], 'Foul: shoot out of the kitchen first — ball in hand');
  });

  test('O11 kitchen.leaveAndReturn.legal', () => {
    const st = mkState({ ballInHand: 'kitchen', pos: { 0: [-0.8, 0], 5: [-0.7, 0.2] } });
    const { out } = play(st, [cross(1), rail(0), cross(-1), hit(5), rail(5)]);
    assert.deepEqual(out.fouls, []);
  });

  test('O12 kitchen.ballOnString.hittable', () => {
    const st = mkState({ ballInHand: 'kitchen', pos: { 0: [-0.8, 0], 5: [HSX, 0.2] } });
    assert.deepEqual(getShotRequirements(st).kitchenBlocked, []);
    const { out } = play(st, [hit(5), rail(5)]);
    assert.deepEqual(out.fouls, []);
  });
});

// ---- Group play ----

describe('group play', () => {
  const G = ['solids', 'stripes'];

  test('G01 own.pot.continue', () => {
    const { out, next } = play(mkState({ groups: G }), [hit(2), pot(2, 1)]);
    assert.deepEqual(out.fouls, []);
    assert.deepEqual(out.credited, [2]);
    assert.equal(out.continueTurn, true);
    assert.equal(out.reason, 'POT');
    assert.equal(next.turn, 0);
    assert.equal(next.dryTurns, 0);
  });

  test('G02 own.plusOpp.continue', () => {
    const { out, next } = play(mkState({ groups: G }), [hit(2), pot(2, 1), pot(10, 0)]);
    assert.deepEqual(out.credited, [2]);
    assert.deepEqual(out.pocketed, [2, 10]);
    assert.equal(out.continueTurn, true);
    assert.equal(next.balls[10].on, false);
  });

  test('G03 oppOnly.passes.noFoul', () => {
    const { out, next } = play(mkState({ groups: G }), [hit(2), hit(10, { a: 2 }), pot(10, 0)]);
    assert.deepEqual(out.fouls, []);
    assert.equal(out.reason, 'OPP_BALL_ONLY');
    assert.equal(next.turn, 1);
    assert.equal(next.ballInHand, null);
    assert.equal(texts(out)[0], "Pocketed CPU's ball — turn over");
  });

  test('G04 wrongFirst.ownPotted.foul', () => {
    const { out, next } = play(mkState({ groups: G }), [hit(10), hit(2, { a: 10 }), pot(2, 2)]);
    assert.deepEqual(out.fouls, ['WRONG_BALL_FIRST']);
    assert.deepEqual(out.credited, []);
    assert.equal(next.balls[2].on, false);
    assert.equal(next.ballInHand, 'anywhere');
    assert.equal(next.turn, 1);
    assert.equal(texts(out)[0], 'Foul: hit the 10-ball first — ball in hand');
  });

  test('G05 eightFirst.groupRemains.foul', () => {
    const { out } = play(mkState({ groups: G }), [hit(8), rail(8)]);
    assert.deepEqual(out.fouls, ['WRONG_BALL_FIRST']);
    assert.equal(out.gameOver, false);
  });

  test('G06 noContact.foul', () => {
    const { out } = play(mkState({ groups: G }), [rail(0), rail(0)]);
    assert.deepEqual(out.fouls, ['NO_CONTACT']);
    assert.equal(texts(out)[0], 'Foul: no ball hit — ball in hand');
  });

  test('G07 noRail.foul', () => {
    const { out } = play(mkState({ groups: G }), [hit(2)]);
    assert.deepEqual(out.fouls, ['NO_RAIL']);
  });

  test('G08 kick.railBeforeOnly.foul', () => {
    const { out } = play(mkState({ groups: G }), [rail(0), hit(2)]);
    assert.deepEqual(out.fouls, ['NO_RAIL']);
  });

  test('G09 kick.objectHitsRail.legal', () => {
    const { out } = play(mkState({ groups: G }), [rail(0), hit(2), rail(2)]);
    assert.deepEqual(out.fouls, []);
    assert.equal(out.reason, 'MISS');
  });

  test('G10 cueRailAfter.legal', () => {
    const { out } = play(mkState({ groups: G }), [hit(2), rail(0)]);
    assert.deepEqual(out.fouls, []);
  });

  test('G11 frozenRail.noLeave.foul', () => {
    const { out } = play(mkState({ groups: G }), [hit(2), rail(2, { frozen: true })]);
    assert.deepEqual(out.fouls, ['NO_RAIL']);
  });

  test('G12 scratch.withOwnPot.noContinue', () => {
    const { out, next } = play(mkState({ groups: G }), [hit(2), pot(2, 1), pot(0, 4)]);
    assert.deepEqual(out.fouls, ['SCRATCH']);
    assert.equal(out.continueTurn, false);
    assert.deepEqual(out.credited, []);
    assert.equal(next.balls[2].on, false);
    assert.equal(next.turn, 1);
    assert.equal(next.ballInHand, 'anywhere');
  });

  test('G13 cueOffTable.foul', () => {
    const { out, next } = play(mkState({ groups: G }), [hit(2), rail(2), off(0)]);
    assert.deepEqual(out.fouls, ['CUE_OFF_TABLE']);
    assert.equal(next.ballInHand, 'anywhere');
    assert.deepEqual([next.balls[0].x, next.balls[0].y, next.balls[0].on], [HSX, 0, true]);
  });

  test('G14 objectOff.permanent.reducesGroup', () => {
    const { out, next } = play(mkState({ groups: G }), [hit(2), hit(3, { a: 2 }), rail(2), off(3)]);
    assert.deepEqual(out.fouls, ['OBJECT_OFF_TABLE']);
    assert.deepEqual(out.respot, []);
    assert.equal(next.balls[3].on, false);
    assert.deepEqual(hudInfo(next).players[0].remaining, [1, 2, 4, 5, 6, 7]);
  });

  test('G15 multiFoul.singlePenalty.primaryScratch', () => {
    const { out, next } = play(mkState({ groups: G }), [hit(10), pot(0, 0)]);
    assert.deepEqual(out.fouls, ['SCRATCH', 'WRONG_BALL_FIRST', 'NO_RAIL']);
    assert.equal(out.primaryFoul, 'SCRATCH');
    assert.equal(out.messages.filter((m) => m.kind === 'foul').length, 1);
    assert.deepEqual(next.fouls, [1, 0]);
    assert.equal(next.ballInHand, 'anywhere');
  });

  test('G16 oppPotsMyLast.onFoul.BIHandCall', () => {
    const st = mkState({ groups: G, on: [1, 2, 8, 15] });
    const { out, next } = play(st, [hit(15), pot(15, 2)]);
    assert.deepEqual(out.fouls, ['WRONG_BALL_FIRST']);
    assert.equal(next.turn, 1);
    assert.equal(next.ballInHand, 'anywhere');
    const req = getShotRequirements(next);
    assert.equal(req.shooter, 1);
    assert.equal(req.onEight, true);
    assert.equal(req.mustCallPocket, true);
    assert.deepEqual(req.legalTargets, [8]);
    assert.ok(texts(out).includes('CPU is on the 8 — call a pocket'));
  });

  test('G17 clearGroup.requirementsEightAndCall', () => {
    const st = mkState({ groups: G, on: [7, 8, 9] });
    const { out, next } = play(st, [hit(7), pot(7, 5)]);
    assert.equal(out.continueTurn, true);
    const req = getShotRequirements(next);
    assert.equal(req.onEight, true);
    assert.equal(req.mustCallPocket, true);
    assert.deepEqual(req.legalTargets, [8]);
    assert.deepEqual(validateShot(next, SHOT), { ok: false, error: 'MISSING_CALL' });
    assert.ok(texts(out).includes('You are on the 8 — call a pocket'));
  });

  test('G18 splitHit.legalWins', () => {
    const st = mkState({ groups: G });
    const a = play(st, [hit(10), hit(2, { dt: 0.0003 }), rail(2)]);
    assert.equal(a.out.first, 2);
    assert.deepEqual(a.out.fouls, []);
    const b = play(st, [hit(10), hit(2, { dt: 0.002 }), rail(2)]);
    assert.equal(b.out.first, 10);
    assert.deepEqual(b.out.fouls, ['WRONG_BALL_FIRST']);
  });
});

// ---- The 8-ball ----

describe('eight ball', () => {
  const G = ['solids', 'stripes'];
  const onEight = (extra = {}) => mkState({ groups: G, on: [8, 9, 10], ...extra });
  const CALL2 = { call: { pocket: 2 } };

  test('E01 eight.calledPocket.win', () => {
    const { out, next } = play(onEight(), [hit(8), pot(8, 2)], CALL2);
    assert.equal(out.gameOver, true);
    assert.equal(out.reason, 'EIGHT_LEGAL');
    assert.equal(out.winner, 0);
    assert.equal(next.winner, 0);
    assert.deepEqual(out.messages, [{ text: 'You win the rack!', kind: 'win' }]);
  });

  test('E02 eight.wrongPocket.loss', () => {
    const { out } = play(onEight(), [hit(8), pot(8, 3)], CALL2);
    assert.equal(out.reason, 'EIGHT_WRONG_POCKET');
    assert.equal(out.winner, 1);
    assert.deepEqual(out.messages, [{ text: '8-ball in the wrong pocket — CPU wins', kind: 'loss' }]);
  });

  test('E03 eight.scratch.loss', () => {
    const { out } = play(onEight(), [hit(8), pot(8, 2), pot(0, 1)], CALL2);
    assert.equal(out.reason, 'EIGHT_FOUL');
    assert.equal(out.winner, 1);
    assert.equal(texts(out)[0], 'Scratched on the 8 — CPU wins');
  });

  test('E04 eight.wrongFirst.loss', () => {
    const { out } = play(onEight(), [hit(10), hit(8, { a: 10 }), pot(8, 2)], CALL2);
    assert.deepEqual(out.fouls, ['WRONG_BALL_FIRST']);
    assert.equal(out.reason, 'EIGHT_FOUL');
    assert.equal(out.winner, 1);
    assert.equal(texts(out)[0], 'Fouled on the 8 — CPU wins');
  });

  test('E05 eight.scratchNoPot.foulOnly', () => {
    const { out, next } = play(onEight(), [hit(8), rail(8), pot(0, 1)], CALL2);
    assert.equal(out.gameOver, false);
    assert.deepEqual(out.fouls, ['SCRATCH']);
    assert.equal(next.winner, null);
    assert.equal(next.turn, 1);
    assert.equal(next.ballInHand, 'anywhere');
  });

  test('E06 eight.miss.foul', () => {
    const { out } = play(onEight(), [rail(0)], CALL2);
    assert.deepEqual(out.fouls, ['NO_CONTACT']);
    assert.equal(out.gameOver, false);
  });

  test('E07 eight.noRail.foul', () => {
    const { out } = play(onEight(), [hit(8)], CALL2);
    assert.deepEqual(out.fouls, ['NO_RAIL']);
    assert.equal(out.gameOver, false);
  });

  test('E08 eight.withOppBall.win', () => {
    const { out } = play(onEight(), [hit(8), pot(9, 0), pot(8, 2)], CALL2);
    assert.equal(out.reason, 'EIGHT_LEGAL');
    assert.equal(out.winner, 0);
  });

  test('E09 eight.withLastBall.loss', () => {
    const st = mkState({ groups: G, on: [7, 8, 9] });
    const { out } = play(st, [hit(7), pot(7, 1), pot(8, 2)], CALL2);
    assert.equal(out.reason, 'EIGHT_WITH_LAST');
    assert.equal(out.winner, 1);
    assert.equal(texts(out)[0], '8-ball went down with the last solid — CPU wins');
  });

  test('E10 eight.comboEarly.loss', () => {
    const st = mkState({ groups: G, on: [5, 6, 8, 9] });
    const { out } = play(st, [hit(6), hit(8, { a: 6 }), pot(8, 2)], CALL2);
    assert.equal(out.reason, 'EIGHT_EARLY');
    assert.equal(out.winner, 1);
  });

  test('E11 eight.offTable.loss', () => {
    const { out } = play(onEight(), [hit(8), off(8)], CALL2);
    assert.equal(out.reason, 'EIGHT_OFF_TABLE');
    assert.equal(out.winner, 1);
  });

  test('E12 validate.missingCall', () => {
    const st = onEight();
    assert.deepEqual(validateShot(st, SHOT), { ok: false, error: 'MISSING_CALL' });
    assert.deepEqual(validateShot(st, { ...SHOT, call: { pocket: 7 } }), { ok: false, error: 'BAD_POCKET' });
    assert.deepEqual(validateShot(st, { ...SHOT, call: { pocket: 2 } }), { ok: true });
    // Without a call (validateShot bypassed), a pocketed 8 counts as the wrong pocket.
    const { out } = play(st, [hit(8), pot(8, 2)]);
    assert.equal(out.reason, 'EIGHT_WRONG_POCKET');
  });

  test('E13 eight.cueOff.loss', () => {
    const { out } = play(onEight(), [hit(8), pot(8, 2), off(0)], CALL2);
    assert.deepEqual(out.fouls, ['CUE_OFF_TABLE']);
    assert.equal(out.reason, 'EIGHT_FOUL');
    assert.equal(out.winner, 1);
  });

  test('CPU win/loss message kinds from the human point of view', () => {
    const st = onEight({ turn: 1, groups: ['stripes', 'solids'] }); // CPU (solids) is on the 8
    const { out } = play(st, [hit(8), pot(8, 2)], CALL2);
    assert.deepEqual(out.messages, [{ text: 'CPU wins the rack!', kind: 'loss' }]);
    const pvp = onEight({ players: PVP });
    const r = play(pvp, [hit(8), pot(8, 4)], CALL2);
    assert.deepEqual(r.out.messages, [{ text: '8-ball in the wrong pocket — Bob wins', kind: 'win' }]);
  });
});

// ---- Placement ----

describe('ball in hand', () => {
  const bih = (ballInHand = 'anywhere', extra = {}) => mkState({ groups: ['solids', 'stripes'], ballInHand, ...extra });

  test('P01 place.valid', () => {
    assert.deepEqual(validateCuePlacement(bih(), { x: 0.5, y: 0.3 }), { ok: true });
    assert.deepEqual(validateCuePlacement(bih('kitchen'), { x: -0.7, y: 0.1 }), { ok: true });
  });

  test('P02 place.overlap', () => {
    const b = bih().balls[7];
    assert.equal(validateCuePlacement(bih(), { x: b.x + 2 * R, y: b.y }).reason, 'overlap');
    assert.equal(validateCuePlacement(bih(), { x: b.x + 2 * R + 0.0002, y: b.y }).ok, true);
    // The cue ball's own old position never blocks.
    const st = bih();
    assert.equal(validateCuePlacement(st, st.balls[0]).ok, true);
  });

  test('P03 place.bounds', () => {
    assert.equal(validateCuePlacement(bih(), { x: TABLE.HL - R + 0.001, y: 0 }).reason, 'bounds');
    assert.equal(validateCuePlacement(bih(), { x: 0.3, y: -(TABLE.HW - R) - 0.001 }).reason, 'bounds');
    assert.equal(validateCuePlacement(bih(), { x: NaN, y: 0 }).reason, 'bounds');
  });

  test('P04 place.kitchen', () => {
    const st = bih('kitchen');
    assert.equal(validateCuePlacement(st, { x: -0.3, y: 0.3 }).reason, 'kitchen');
    assert.equal(validateCuePlacement(st, { x: HSX, y: 0.3 }).reason, 'kitchen');
    assert.equal(validateCuePlacement(st, { x: HSX - 0.001, y: 0.3 }).ok, true);
  });

  test('P05 place.pocket', () => {
    const st = bih();
    assert.equal(validateCuePlacement(st, { x: TABLE.HL - R - 0.01, y: TABLE.HW - R - 0.01 }).reason, 'pocket');
    assert.equal(validateCuePlacement(st, { x: 0, y: TABLE.HW - R }).reason, 'pocket');
    assert.equal(validateCuePlacement(st, { x: -TABLE.HL + R, y: -TABLE.HW + R }).reason, 'pocket');
  });

  test('P06 nearest.validDeterministic', () => {
    const st = bih();
    const b = st.balls[7];
    const cases = [
      { x: b.x, y: b.y },
      { x: b.x + 0.01, y: b.y - 0.005 },
      { x: TABLE.HL, y: TABLE.HW },
      { x: 0, y: TABLE.HW },
      { x: 5, y: -5 },
    ];
    for (const c of cases) {
      const a = nearestValidPlacement(st, c);
      assert.ok(validateCuePlacement(st, a).ok, JSON.stringify({ c, a }));
      assert.deepEqual(nearestValidPlacement(st, c), a);
    }
    // A point next to a ball is pushed out to 2R + 0.2 mm along the line of centres.
    const p = nearestValidPlacement(st, { x: b.x + 0.03, y: b.y });
    assert.ok(Math.abs(Math.hypot(p.x - b.x, p.y - b.y) - (2 * R + 0.0002)) < 1e-9);
    // Kitchen: snapped behind the head string.
    const k = nearestValidPlacement(bih('kitchen'), { x: 0.4, y: 0.1 });
    assert.ok(k.x < HSX && validateCuePlacement(bih('kitchen'), k).ok);
    // Crowded kitchen point (cluster of balls): the ring search still finds a free spot.
    const pos = {};
    const ids = [1, 2, 3, 4, 5, 6, 7];
    ids.forEach((id, i) => (pos[id] = [-0.7 + (i % 3) * 2.05 * R, -0.05 + Math.floor(i / 3) * 2.05 * R]));
    const crowded = bih('kitchen', { pos });
    const q = nearestValidPlacement(crowded, { x: -0.7 + 2.05 * R, y: -0.05 + 2.05 * R * 0.5 });
    assert.ok(validateCuePlacement(crowded, q).ok);
  });

  test('foul places the cue ball where it stopped (snapped if needed)', () => {
    const st = mkState({ groups: ['solids', 'stripes'] });
    const { next } = play(st, [hit(10), rail(10)], { pos: { 0: [0.2, 0.35] } });
    assert.equal(next.ballInHand, 'anywhere');
    assert.deepEqual([next.balls[0].x, next.balls[0].y], [0.2, 0.35]);
    // Frozen against a ball: pushed clear and valid.
    const b9 = st.balls[9];
    const r = play(st, [hit(10), rail(10)], { pos: { 0: [b9.x + 2 * R, b9.y] } });
    assert.ok(validateCuePlacement(r.next, r.next.balls[0]).ok);
    assert.deepEqual(validateShot(r.next, SHOT), { ok: true });
  });

  test('validateShot refuses an invalid placement', () => {
    const st = mkState({ ballInHand: 'kitchen', pos: { 0: [0.2, 0.2] } });
    assert.deepEqual(validateShot(st, SHOT), { ok: false, error: 'BALL_IN_HAND_UNPLACED' });
    const off = mkState({ ballInHand: 'anywhere', on: [1, 2, 3, 8, 9] });
    const noCue = deepFreeze({ ...off, balls: off.balls.map((b) => (b.id === 0 ? { ...b, on: false } : b)) });
    assert.deepEqual(validateShot(noCue, SHOT), { ok: false, error: 'BALL_IN_HAND_UNPLACED' });
  });

  test('spotPosition with a free foot spot', () => {
    assert.deepEqual(spotPosition(mkState().balls, 8), { x: FS.x, y: 0 });
  });
});

// ---- Racking ----

describe('rack', () => {
  test('R01 rack.layout', () => {
    for (const seed of [1, 2, 3, 42, 12345]) {
      const { balls } = createRack(mulberry32(seed));
      assert.equal(balls.length, 16);
      balls.forEach((b, i) => assert.equal(b.id, i));
      assert.ok(balls.every((b) => b.on));
      const dx = Math.sqrt(3) * (R + RACK_GAP / 2);
      const dy = 2 * R + RACK_GAP;
      assert.ok(Math.abs(balls[8].x - (FS.x + 2 * dx)) < 1e-12 && Math.abs(balls[8].y) < 1e-12);
      const apex = balls.find((b) => b.id !== 0 && Math.abs(b.x - FS.x) < 1e-12 && Math.abs(b.y) < 1e-12);
      assert.ok(apex, 'apex on the foot spot');
      const corners = balls.filter((b) => Math.abs(b.x - (FS.x + 4 * dx)) < 1e-9 && Math.abs(Math.abs(b.y) - 2 * dy) < 1e-9);
      assert.equal(corners.length, 2);
      assert.deepEqual(corners.map((b) => groupOf(b.id)).sort(), ['solids', 'stripes']);
      for (let i = 0; i < 16; i++) {
        for (let j = i + 1; j < 16; j++) {
          const d = Math.hypot(balls[i].x - balls[j].x, balls[i].y - balls[j].y);
          assert.ok(d >= 2 * R, `overlap ${i}-${j}`);
        }
      }
      assert.deepEqual([balls[0].x, balls[0].y], [HSX - 2 * R, 0]);
    }
  });

  test('R02 rack.seedDeterminism', () => {
    assert.deepEqual(createRack(mulberry32(77)), createRack(mulberry32(77)));
    const layouts = new Set();
    const cornerSides = new Set();
    const dy = 2 * R + RACK_GAP;
    for (let s = 1; s <= 20; s++) {
      const { balls } = createRack(mulberry32(s));
      layouts.add(JSON.stringify(balls));
      const rightCorner = balls.find((b) => Math.abs(b.y + 2 * dy) < 1e-9);
      cornerSides.add(groupOf(rightCorner.id));
    }
    assert.ok(layouts.size > 15);
    assert.equal(cornerSides.size, 2);
  });

  test('newGameState starts a break with the cue in hand in the kitchen', () => {
    const st = newGameState({ players: PLAYERS, ruleset: RULESET_CASUAL, breaker: 1, rng: mulberry32(5) });
    assert.equal(st.turn, 1);
    assert.equal(st.breaker, 1);
    assert.equal(st.isBreakShot, true);
    assert.equal(st.ballInHand, 'kitchen');
    assert.ok(validateCuePlacement(st, st.balls[0]).ok);
    assert.deepEqual(validateShot(st, SHOT), { ok: true });
    const req = getShotRequirements(st);
    assert.equal(req.isBreak, true);
    assert.equal(req.legalTargets.length, 15);
    assert.equal(req.mustCallPocket, false);
    assert.deepEqual(JSON.parse(JSON.stringify(st)), st);
  });
});

// ---- Match-level rules ----

describe('match', () => {
  test('M08 evaluate.pureDeterministic', () => {
    const st = mkState({ groups: ['solids', 'stripes'] });
    const before = JSON.stringify(st);
    const rec = mkRecord(st, [strike(), hit(2), hit(9, { a: 2 }), pot(9, 3), rail(2), pot(0, 1)]);
    const a = evaluateShot(st, rec);
    const b = evaluateShot(st, rec);
    assert.deepEqual(a, b);
    assert.deepEqual(evaluateShot(st, rec, { messages: false }), { ...a, messages: [] });
    const n1 = applyOutcome(st, rec, a);
    const n2 = applyOutcome(st, rec, b);
    assert.deepEqual(n1, n2);
    assert.equal(JSON.stringify(st), before);
    assert.notEqual(n1.balls, st.balls);
    assert.deepEqual(JSON.parse(JSON.stringify(n1)), n1);
  });

  test('M09 fouls.counted.noThreeFoulLoss', () => {
    let st = mkState({ groups: ['solids', 'stripes'] });
    for (let i = 0; i < 5; i++) {
      const wrong = st.turn === 0 ? 10 : 2; // each player hits the other group first
      st = play(st, [hit(wrong), rail(wrong)]).next;
      assert.equal(st.winner, null);
    }
    assert.deepEqual(st.fouls, [3, 2]);
    assert.equal(st.history.length, 5);
    assert.equal(st.dryTurns, 5);
  });

  test('dry turns count up and reset on a pot; history is capped', () => {
    let st = mkState({ groups: ['solids', 'stripes'], dryTurns: 9 });
    st = play(st, [hit(2), rail(2)]).next;
    assert.equal(st.dryTurns, 10);
    st = play(st, [hit(10), pot(10, 0)]).next;
    assert.equal(st.dryTurns, 0);
    const long = deepFreeze({ ...st, history: new Array(400).fill({ n: 0 }) });
    const r = play(long, [hit(9), rail(9)]);
    assert.equal(r.next.history.length, 400);
    assert.equal(r.next.history[399].reason, 'MISS');
  });

  test('summarize: one pass, unknown events ignored', () => {
    const st = mkState({ groups: ['solids', 'stripes'] });
    const log = [
      strike(),
      ev({ type: 'mystery', ball: 3 }),
      rail(0),
      cross(1),
      hit(3),
      rail(3, { frozen: true }),
      rail(4),
      pot(5, 2),
      pot(0, 1),
      off(6),
    ];
    const S = summarize(log, st);
    assert.equal(S.first, 3);
    assert.equal(S.firstSeq, log[4].seq);
    assert.equal(S.railAfterFirst, true);
    assert.equal(S.railBalls, 1);
    assert.deepEqual(S.pocketedObj, [5]);
    assert.equal(S.pocketOf[5], 2);
    assert.equal(S.pocketOf[0], 1);
    assert.equal(S.pocketOf[3], -1);
    assert.equal(S.cuePocketed, true);
    assert.equal(S.cueOffTable, false);
    assert.deepEqual(S.offTableObj, [6]);
    assert.equal(S.cueLeftKitchenFirst, true);
  });

  test('hudInfo and banners', () => {
    const st = mkState({ groups: ['stripes', 'solids'], on: [1, 2, 8, 9, 15], ballInHand: 'anywhere' });
    const h = hudInfo(st);
    assert.deepEqual(h.players[0], { name: 'You', group: 'stripes', remaining: [9, 15], onEight: false, fouls: 0 });
    assert.deepEqual(h.players[1], { name: 'CPU', group: 'solids', remaining: [1, 2], onEight: false, fouls: 0 });
    assert.equal(h.banner, 'Your shot — ball in hand');
    assert.equal(hudInfo(mkState({ turn: 1, ballInHand: 'kitchen' })).banner, "CPU's shot — ball in hand behind the head string");
    assert.equal(hudInfo(mkState({ groups: ['stripes', 'solids'], on: [1, 8] })).banner, 'You are on the 8 — call a pocket');
    assert.equal(hudInfo(mkState({ isBreak: true, players: PVP, turn: 1 })).banner, "Bob's break");
    const open = hudInfo(mkState());
    assert.equal(open.players[0].group, null);
    assert.deepEqual(open.players[0].remaining, []);
  });

  test('rack and match texts', () => {
    const st = deepFreeze({ ...mkState(), winner: 0, endReason: 'EIGHT_LEGAL' });
    assert.equal(rackOverText(st, [2, 1]), 'You win the rack — 8-ball in the called pocket · 2–1');
    const lost = deepFreeze({ ...mkState(), winner: 1, endReason: 'EIGHT_EARLY' });
    assert.equal(rackOverText(lost, [1, 2]), 'CPU wins the rack — you pocketed the 8 early · 2–1');
    assert.equal(rackReasonText(lost), 'you pocketed the 8 early');
    assert.equal(matchOverText(PLAYERS, 0, [3, 1]), 'You win the match 3–1!');
    assert.equal(matchOverText(PVP, 1, [2, 3]), 'Bob wins the match 3–2!');
  });

  test('ruleset illegalBreak "rerack" produces an automatic decision', () => {
    const st = breakState({ ruleset: { ...RULESET_CASUAL, illegalBreak: 'rerack' } });
    const { out } = play(st, [hit(1)]);
    assert.equal(out.decision.auto, true);
    assert.deepEqual(out.decision.options, ['rerackBreak']);
    assert.equal(defaultDecision(out.decision), 'rerackBreak');
  });
});

// ---- Pro mode (optional) ----

describe('pro mode', () => {
  const pro = (extra = {}) => mkState({ ruleset: RULESET_PRO, groups: ['solids', 'stripes'], ...extra });

  test('C01 all.calledPot.continue', () => {
    const st = pro();
    assert.equal(getShotRequirements(st).mustCallBall, true);
    assert.deepEqual(validateShot(st, SHOT), { ok: false, error: 'MISSING_CALL' });
    const { out } = play(st, [hit(3), pot(3, 1)], { call: { ball: 3, pocket: 1 } });
    assert.deepEqual(out.credited, [3]);
    assert.equal(out.continueTurn, true);
  });

  test('C02 all.uncalledOwnPot.passes', () => {
    const { out, next } = play(pro(), [hit(3), pot(4, 1)], { call: { ball: 3, pocket: 1 } });
    assert.deepEqual(out.fouls, []);
    assert.equal(out.continueTurn, false);
    assert.equal(next.balls[4].on, false);
    assert.equal(next.turn, 1);
  });

  test('C03 all.safety.passes', () => {
    const st = pro();
    assert.deepEqual(validateShot(st, { ...SHOT, call: { safety: true } }), { ok: true });
    const { out } = play(st, [hit(3), pot(3, 1)], { call: { safety: true } });
    assert.equal(out.continueTurn, false);
    assert.deepEqual(out.fouls, []);
  });

  test('C04 all.openAssignByCalled', () => {
    const st = pro({ groups: [null, null] });
    const { out, next } = play(st, [hit(3), pot(12, 0), pot(3, 1)], { call: { ball: 3, pocket: 1 } });
    assert.deepEqual(out.groupAssigned, { player: 0, group: 'solids' });
    assert.deepEqual(next.groups, ['solids', 'stripes']);
  });

  test('eightOnBreak "choose": decision, then accept or re-rack', () => {
    const st = mkState({ ruleset: RULESET_PRO, isBreak: true });
    const { out, next } = play(st, [hit(1), pot(8, 2)]);
    assert.equal(out.decision.type, 'eightOnBreak');
    assert.equal(out.decision.chooser, 0);
    assert.equal(next.balls[8].on, true);
    const acc = applyDecision(next, 'acceptTable', mulberry32(1));
    assert.equal(acc.turn, 0);
    assert.equal(acc.isBreakShot, false);
    assert.equal(acc.pendingDecision, null);
    const rr = applyDecision(next, 'rerackBreak', mulberry32(1));
    assert.equal(rr.breaker, 0);
    assert.equal(rr.isBreakShot, true);
  });
});

// ---- Performance ----

describe('performance', () => {
  test('2,000 evaluations with {messages:false} stay fast', () => {
    const st = mkState({ groups: ['solids', 'stripes'] });
    // A realistic ~80-event shot log.
    const log = [strike(), hit(2)];
    for (let i = 0; i < 70; i++) log.push(i % 3 === 0 ? hit(1 + (i % 7), { a: 9 + (i % 7) }) : rail(1 + (i % 15)));
    log.push(pot(2, 3), pot(11, 0), rail(0));
    const rec = mkRecord(st, log);
    for (let i = 0; i < 2000; i++) evaluateShot(st, rec, { messages: false }); // warm up
    const t0 = performance.now();
    let pots = 0;
    for (let i = 0; i < 2000; i++) pots += evaluateShot(st, rec, { messages: false }).credited.length;
    const ms = performance.now() - t0;
    assert.equal(pots, 2000);
    console.log(`# evaluateShot x2000 (${log.length} events): ${ms.toFixed(2)} ms`);
    assert.ok(ms < 100, `took ${ms} ms`);
  });
});
