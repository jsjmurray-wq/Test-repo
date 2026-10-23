// Game state machine tests with a scripted fake physics World. Run: node --test tests/game.test.js
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { BALL_R } from '../src/constants.js';
import { TABLE } from '../src/table.js';
import { Game, TOSS_TIME, CPU_DELAY } from '../src/game.js';
import { validateCuePlacement, nearestValidPlacement } from '../src/rules.js';

const R = BALL_R;
const HSX = TABLE.headStringX;
const EVENTS = ['state', 'toss', 'message', 'shotStart', 'physics', 'shotEnd', 'decision', 'rackOver', 'matchOver', 'cpuTurn'];

// The subset of the physics World interface that Game uses. Each strike() plays the next scripted
// shot: its events come out of the first advance(), and after `frames` advances the balls named in
// `set` are moved, pocketed/off-table balls are taken off, and atRest() turns true.
class FakeWorld {
  constructor(table) {
    this.table = table;
    this.balls = [];
    for (let id = 0; id < 16; id++) {
      this.balls.push({ id, x: 0, y: 0, vx: 0, vy: 0, wx: 0, wy: 0, wz: 0, q: [1, 0, 0, 0], on: true, state: 'rest', pocket: -1 });
    }
    this.t = 0;
    this.log = [];
    this.queue = [];
    this.strikes = [];
    this._frames = 0;
  }

  script({ events = [], set = {}, frames = 3 } = {}) {
    this.queue.push({ events, set, frames });
    return this;
  }

  setBalls(list) {
    const seen = new Set();
    for (const s of list) {
      const b = this.balls[s.id];
      Object.assign(b, { x: s.x, y: s.y, on: s.on !== false, vx: 0, vy: 0, state: s.on !== false ? 'rest' : 'pocketed' });
      seen.add(s.id);
    }
    for (const b of this.balls) if (!seen.has(b.id)) b.on = false;
  }

  strike(shot) {
    this.strikes.push(shot);
    const sc = this.queue.shift() || { events: [], set: {}, frames: 1 };
    let seq = 0;
    const strikeEv = { type: 'strike', seq: seq++, t: 0, v: 2, miscue: false };
    this.t = 0;
    this.log = [strikeEv];
    this._script = sc;
    this._pending = sc.events.map((e, i) => ({ seq: seq++, t: 0.01 * (i + 1), ...e }));
    this._frames = sc.frames;
    this.balls[0].state = 'slide';
    return [strikeEv];
  }

  advance(dt) {
    if (this._frames <= 0) return [];
    this.t += dt;
    this._frames--;
    const out = this._pending;
    this._pending = [];
    this.log.push(...out);
    if (this._frames === 0) {
      for (const e of this.log) if (e.type === 'pocket' || e.type === 'offTable') this.balls[e.ball].on = false;
      for (const [id, ch] of Object.entries(this._script.set)) Object.assign(this.balls[id], ch);
      for (const b of this.balls) b.state = b.on ? 'rest' : 'pocketed';
    }
    return out;
  }

  step(dt) {
    return this.advance(dt);
  }

  atRest() {
    return this._frames <= 0;
  }

  snapshot() {
    return this.balls.map((b) => ({ id: b.id, x: b.x, y: b.y, on: b.on }));
  }

  record() {
    return { log: this.log, final: this.snapshot() };
  }
}

// Event builders for scripts.
const hit = (b, a = 0) => ({ type: 'ball', a: Math.min(a, b), b: Math.max(a, b), v: 1 });
const rail = (b) => ({ type: 'cushion', ball: b, v: 0.5, frozen: false, cushion: 2 });
const pot = (b, pocket = 2) => ({ type: 'pocket', ball: b, pocket, v: 1 });

const BREAK_POT = [hit(1), rail(1), rail(2), pot(3, 2)];
const BREAK_DRY = [hit(1), rail(1), rail(2), rail(9), rail(10)];
const BREAK_ILLEGAL = [hit(1), rail(1)];
const SHOT = { angle: 0, power: 0.6, spin: { x: 0, y: 0 } };

const PVP = [
  { name: 'Ann', kind: 'human' },
  { name: 'Bob', kind: 'human' },
];
const VS_CPU = [
  { name: 'You', kind: 'human' },
  { name: 'CPU', kind: 'cpu', level: 'hard' },
];

function track(g) {
  const log = [];
  for (const name of EVENTS) g.on(name, (payload) => log.push({ name, payload }));
  return log;
}

function newGame({ mode = 'pvp', players = PVP, raceTo = 3, seed = 1 } = {}) {
  const g = new Game({ config: { mode, players, raceTo }, seed, WorldClass: FakeWorld });
  const log = track(g);
  return { g, log };
}

function started(opts) {
  const r = newGame(opts);
  r.g.update(TOSS_TIME);
  r.log.length = 0;
  return r;
}

function roll(g) {
  for (let i = 0; i < 200 && g.phase === 'rolling'; i++) g.update(1 / 60);
  assert.notEqual(g.phase, 'rolling', 'shot never came to rest');
}

function shoot(g, events, { set, call } = {}) {
  g.world.script({ events, set });
  const r = g.shoot({ ...SHOT, call: call || null });
  assert.deepEqual(r, { ok: true });
  roll(g);
}

const names = (log) => log.map((e) => e.name);
const ofType = (log, name) => log.filter((e) => e.name === name).map((e) => e.payload);

function seedWhereBreaker(breaker, opts) {
  for (let seed = 1; seed < 200; seed++) {
    const g = new Game({ config: opts, seed, WorldClass: FakeWorld });
    if (g.match.firstBreaker === breaker) return seed;
  }
  throw new Error('no seed');
}

// Restores a started game edited so that `turn` is on the 8 (solids cleared, groups assigned).
function onEightGame({ raceTo = 3, turn = 0, players = PVP, mode = 'pvp' } = {}) {
  const { g } = started({ raceTo, players, mode });
  const data = JSON.parse(g.serialize());
  const st = data.match.game;
  st.isBreakShot = false;
  st.ballInHand = null;
  st.turn = turn;
  st.groups = turn === 0 ? ['solids', 'stripes'] : ['stripes', 'solids'];
  for (const b of st.balls) if (b.id >= 1 && b.id <= 7) b.on = false;
  const g2 = Game.restore(JSON.stringify(data), { WorldClass: FakeWorld });
  const log = track(g2);
  g2.update(0); // flush the restore replay
  log.length = 0;
  return { g: g2, log };
}

describe('Game', () => {
  test('toss -> aim after 1.2 s', () => {
    const { g, log } = newGame({ seed: 7 });
    assert.equal(g.phase, 'toss');
    assert.equal(g.state.isBreakShot, true);
    assert.equal(g.world.balls[8].on, true); // rack is on the table during the toss
    assert.deepEqual(g.shoot(SHOT), { ok: false, error: 'PHASE' });
    g.update(0.6);
    assert.equal(g.phase, 'toss');
    assert.deepEqual(names(log), []);
    g.update(0.6);
    assert.equal(g.phase, 'aim');
    const toss = ofType(log, 'toss');
    assert.equal(toss.length, 1);
    assert.equal(toss[0].breaker, g.match.firstBreaker);
    assert.equal(g.state.turn, g.match.firstBreaker);
    assert.equal(g.state.breaker, g.match.firstBreaker);
    const who = g.match.firstBreaker === 0 ? 'Ann' : 'Bob';
    assert.deepEqual(ofType(log, 'message')[0], { text: `${who} won the toss and breaks`, kind: 'info' });
    assert.ok(names(log).includes('state'));
    assert.equal(ofType(log, 'cpuTurn').length, 0);
    // Same seed, same toss and rack.
    const again = new Game({ config: { mode: 'pvp', players: PVP }, seed: 7, WorldClass: FakeWorld });
    assert.deepEqual(again.state, new Game({ config: { mode: 'pvp', players: PVP }, seed: 7, WorldClass: FakeWorld }).state);
    g.update(NaN);
    g.update(-1);
    assert.equal(g.phase, 'aim');
  });

  test('a break that pots a ball keeps the turn', () => {
    const { g, log } = started();
    const breaker = g.state.turn;
    assert.equal(g.requirements().isBreak, true);
    g.world.script({ events: BREAK_POT });
    assert.deepEqual(g.shoot(SHOT), { ok: true });
    assert.equal(g.phase, 'rolling');
    assert.deepEqual(g.world.strikes[0], { ...SHOT, power: 0.6, call: null });
    roll(g);
    assert.equal(g.phase, 'aim');
    assert.equal(g.state.turn, breaker);
    assert.equal(g.state.isBreakShot, false);
    assert.equal(g.state.balls[3].on, false);
    const outcome = ofType(log, 'shotEnd')[0].outcome;
    assert.equal(outcome.reason, 'BREAK_POT');
    assert.equal(outcome.continueTurn, true);
    // Event order: shotStart, strike physics, shot physics, messages, shotEnd, state.
    const seq = names(log).filter((n) => n !== 'state');
    assert.deepEqual(seq.slice(0, 3), ['shotStart', 'physics', 'physics']);
    assert.equal(ofType(log, 'physics')[0][0].type, 'strike');
    assert.equal(ofType(log, 'physics')[1].length, BREAK_POT.length);
    assert.equal(names(log).at(-1), 'state');
    assert.ok(names(log).indexOf('shotEnd') > names(log).lastIndexOf('message'));
    assert.ok(ofType(log, 'message').some((m) => m.text.startsWith('Good break')));
    assert.ok(ofType(log, 'message').length <= 3);
  });

  test('a scratch gives the opponent ball in hand with the cue ball placed validly', () => {
    const { g, log } = started();
    const breaker = g.state.turn;
    shoot(g, BREAK_POT);
    log.length = 0;
    shoot(g, [hit(1), rail(1), pot(0, 3)]);
    const st = g.state;
    assert.equal(g.phase, 'aim');
    assert.equal(st.turn, 1 - breaker);
    assert.equal(st.ballInHand, 'anywhere');
    assert.equal(st.balls[0].on, true);
    assert.ok(validateCuePlacement(st, st.balls[0]).ok);
    assert.deepEqual(g.cuePosition(), nearestValidPlacement(st, { x: HSX, y: 0 }));
    assert.equal(g.world.balls[0].on, true); // world updated with the in-hand cue ball
    assert.equal(ofType(log, 'message')[0].kind, 'foul');
    // Dragging onto a ball snaps to a valid spot.
    const b5 = st.balls[5];
    const r = g.placeCue(b5.x, b5.y);
    assert.equal(r.ok, true);
    assert.equal(r.reason, 'overlap');
    assert.ok(validateCuePlacement(g.state, r).ok);
    assert.deepEqual(g.cuePosition(), { x: r.x, y: r.y });
    assert.deepEqual([g.world.balls[0].x, g.world.balls[0].y], [r.x, r.y]);
    const free = g.placeCue(0.3, 0.3);
    assert.deepEqual(free, { ok: true, x: 0.3, y: 0.3 });
    // Shooting from the placement; afterwards the cue is no longer in hand.
    shoot(g, [hit(1), rail(1)]);
    assert.equal(g.state.ballInHand, null);
    assert.equal(g.placeCue(0, 0).ok, false);
  });

  test('a scratch on the break gives kitchen ball in hand', () => {
    const { g } = started();
    shoot(g, [...BREAK_POT, pot(0, 5)]);
    const st = g.state;
    assert.equal(st.ballInHand, 'kitchen');
    assert.deepEqual(g.cuePosition(), { x: HSX - 2 * R, y: 0 });
    const r = g.placeCue(0.4, 0.1);
    assert.ok(r.ok && r.x < HSX && r.reason === 'kitchen');
  });

  describe('illegal break decision', () => {
    function illegal() {
      const { g, log } = started();
      const offender = g.state.turn;
      shoot(g, BREAK_ILLEGAL);
      return { g, log, offender, chooser: 1 - offender };
    }

    test('prompts the incoming player', () => {
      const { g, log, chooser } = illegal();
      assert.equal(g.phase, 'decision');
      const d = ofType(log, 'decision');
      assert.equal(d.length, 1);
      assert.equal(d[0].decision.chooser, chooser);
      assert.deepEqual(d[0].decision.options, ['acceptTable', 'rerackBreak', 'rerackOpponentBreaks']);
      assert.ok(names(log).indexOf('decision') > names(log).indexOf('shotEnd'));
      assert.deepEqual(g.shoot(SHOT), { ok: false, error: 'PHASE' });
      assert.deepEqual(g.decide('nope'), { ok: false, error: 'BAD_OPTION' });
      assert.equal(g.match.score.join(), '0,0');
    });

    test('acceptTable: chooser plays the table as it lies', () => {
      const { g, chooser } = illegal();
      const before = g.state.balls;
      assert.deepEqual(g.decide('acceptTable'), { ok: true });
      assert.equal(g.phase, 'aim');
      assert.equal(g.state.turn, chooser);
      assert.equal(g.state.isBreakShot, false);
      assert.equal(g.state.ballInHand, null);
      assert.deepEqual(g.state.balls, before);
      assert.deepEqual(g.decide('acceptTable'), { ok: false, error: 'PHASE' });
    });

    test('rerackBreak: new rack, chooser breaks', () => {
      const { g, log, chooser } = illegal();
      log.length = 0;
      g.decide('rerackBreak');
      assert.equal(g.phase, 'aim');
      assert.equal(g.state.breaker, chooser);
      assert.equal(g.state.turn, chooser);
      assert.equal(g.state.isBreakShot, true);
      assert.ok(g.state.balls.every((b) => b.on));
      assert.equal(g.state.rackNo, 1);
      assert.equal(ofType(log, 'message')[0].text, `Re-rack — ${chooser === 0 ? 'Ann' : 'Bob'} breaks`);
      assert.equal(g.match.rng, JSON.parse(g.serialize()).match.rng);
    });

    test('rerackOpponentBreaks: offender breaks again', () => {
      const { g, offender } = illegal();
      g.decide('rerackOpponentBreaks');
      assert.equal(g.state.breaker, offender);
      assert.equal(g.state.turn, offender);
      assert.equal(g.state.isBreakShot, true);
    });
  });

  test('8-ball win ends the rack and scores it; next rack alternates the break', () => {
    const { g, log } = onEightGame({ raceTo: 3 });
    const breaker = g.state.breaker;
    assert.equal(g.requirements().mustCallPocket, true);
    assert.deepEqual(g.shoot(SHOT), { ok: false, error: 'MISSING_CALL' });
    shoot(g, [hit(8), pot(8, 2)], { call: { pocket: 2 } });
    assert.equal(g.phase, 'rackOver');
    assert.deepEqual(g.match.score, [1, 0]);
    const ro = ofType(log, 'rackOver');
    assert.equal(ro.length, 1);
    assert.equal(ro[0].winner, 0);
    assert.equal(ro[0].reason, 'EIGHT_LEGAL');
    assert.deepEqual(ro[0].score, [1, 0]);
    assert.equal(ro[0].text, '8-ball in the called pocket');
    assert.equal(ro[0].summary, 'Ann wins the rack — 8-ball in the called pocket · 1–0');
    assert.equal(ofType(log, 'matchOver').length, 0);
    assert.deepEqual(g.match.racks.at(-1).winner, 0);
    assert.equal(g.hud().phase, 'rackOver');
    log.length = 0;
    assert.deepEqual(g.nextRack(), { ok: true });
    assert.equal(g.phase, 'aim');
    assert.equal(g.state.rackNo, 2);
    assert.equal(g.state.breaker, 1 - breaker);
    assert.equal(g.state.isBreakShot, true);
    assert.deepEqual(g.match.score, [1, 0]);
    assert.ok(ofType(log, 'message')[0].text.startsWith('Rack 2 — '));
  });

  test('losing on the 8 scores the rack for the opponent', () => {
    const { g, log } = onEightGame();
    shoot(g, [hit(8), pot(8, 3)], { call: { pocket: 2 } });
    assert.equal(ofType(log, 'rackOver')[0].reason, 'EIGHT_WRONG_POCKET');
    assert.deepEqual(g.match.score, [0, 1]);
  });

  test('race-to ends the match; rematch: the loser breaks', () => {
    const { g, log } = onEightGame({ raceTo: 1, turn: 1 });
    shoot(g, [hit(8), pot(8, 4)], { call: { pocket: 4 } });
    assert.equal(g.phase, 'matchOver');
    assert.equal(g.match.winner, 1);
    assert.deepEqual(g.match.score, [0, 1]);
    assert.deepEqual(names(log).filter((n) => n === 'rackOver' || n === 'matchOver'), ['rackOver', 'matchOver']);
    assert.deepEqual(ofType(log, 'matchOver')[0], { winner: 1, score: [0, 1], summary: 'Bob wins the match 1–0!' });
    assert.deepEqual(g.nextRack(), { ok: false, error: 'PHASE' });
    assert.deepEqual(g.concede(), { ok: false, error: 'PHASE' });
    log.length = 0;
    assert.deepEqual(g.rematch(), { ok: true });
    assert.equal(g.phase, 'aim');
    assert.deepEqual(g.match.score, [0, 0]);
    assert.equal(g.match.winner, null);
    assert.deepEqual(g.match.racks, []);
    assert.equal(g.state.breaker, 0);
    assert.equal(g.state.turn, 0);
    assert.equal(g.state.rackNo, 1);
    assert.equal(g.match.firstBreaker, 0);
    assert.deepEqual(g.rematch(), { ok: false, error: 'PHASE' });
  });

  describe('cpuTurn', () => {
    const cfg = { mode: 'cpu', players: VS_CPU };

    test('emitted 600 ms after the toss when the CPU breaks', () => {
      const seed = seedWhereBreaker(1, cfg);
      const { g, log } = newGame({ ...cfg, seed });
      g.update(TOSS_TIME);
      assert.equal(g.phase, 'aim');
      g.update(CPU_DELAY - 0.01);
      assert.equal(ofType(log, 'cpuTurn').length, 0);
      g.update(0.02);
      assert.deepEqual(ofType(log, 'cpuTurn'), [{ player: 1, level: 'hard' }]);
      g.update(1);
      assert.equal(ofType(log, 'cpuTurn').length, 1);
    });

    test('emitted after the turn passes to the CPU, and after its decisions', () => {
      const seed = seedWhereBreaker(0, cfg);
      const { g, log } = newGame({ ...cfg, seed });
      g.update(TOSS_TIME);
      g.update(2);
      assert.equal(ofType(log, 'cpuTurn').length, 0); // the human breaks
      shoot(g, BREAK_ILLEGAL);
      assert.equal(g.phase, 'decision');
      assert.equal(ofType(log, 'decision')[0].decision.chooser, 1); // main.js asks ai.chooseDecision
      g.update(2);
      assert.equal(ofType(log, 'cpuTurn').length, 0);
      g.decide('rerackBreak');
      assert.equal(g.state.turn, 1);
      g.update(0.3);
      g.update(0.3);
      assert.deepEqual(ofType(log, 'cpuTurn'), [{ player: 1, level: 'hard' }]);
      // CPU's dry break hands the table back to the human: no cpuTurn.
      shoot(g, BREAK_DRY);
      g.update(2);
      assert.equal(ofType(log, 'cpuTurn').length, 1);
      assert.equal(g.state.turn, 0);
      // Human misses: the CPU gets a cpuTurn after 600 ms of update time.
      shoot(g, [hit(1), rail(1)]);
      assert.equal(g.state.turn, 1);
      for (let i = 0; i < 35; i++) g.update(1 / 60);
      assert.equal(ofType(log, 'cpuTurn').length, 1);
      for (let i = 0; i < 3; i++) g.update(1 / 60);
      assert.equal(ofType(log, 'cpuTurn').length, 2);
    });
  });

  test('serialize/restore round trip', () => {
    const { g } = started({ seed: 99 });
    shoot(g, BREAK_POT);
    shoot(g, [hit(1), rail(1), pot(0, 3)]);
    g.placeCue(0.25, -0.2);
    const s1 = g.serialize();
    const g2 = Game.restore(s1, { WorldClass: FakeWorld });
    assert.equal(g2.serialize(), s1);
    assert.equal(g2.phase, g.phase);
    assert.deepEqual(g2.state, g.state);
    assert.deepEqual(g2.match, g.match);
    assert.deepEqual(g2.cuePosition(), { x: 0.25, y: -0.2 });
    assert.deepEqual(g2.world.snapshot(), g.world.snapshot());
    // The restored RNG continues the same sequence: identical next racks.
    g.concede();
    g2.concede();
    g.nextRack();
    g2.nextRack();
    assert.deepEqual(g2.state.balls, g.state.balls);
    assert.equal(g2.serialize(), g.serialize());
    // Restoring re-announces the phase on the first update.
    const g3 = Game.restore(g.serialize(), { WorldClass: FakeWorld });
    const log3 = track(g3);
    g3.update(0.016);
    assert.equal(names(log3)[0], 'state');
    assert.throws(() => Game.restore('{"v":99}', { WorldClass: FakeWorld }));
  });

  test('restore of a save taken mid-roll returns to the shot position; decisions are replayed', () => {
    const { g } = started();
    const pre = g.state;
    g.world.script({ events: BREAK_POT, frames: 10 });
    g.shoot(SHOT);
    g.update(1 / 60);
    assert.equal(g.phase, 'rolling');
    const g2 = Game.restore(g.serialize(), { WorldClass: FakeWorld });
    assert.equal(g2.phase, 'aim');
    assert.deepEqual(g2.state, pre);

    const { g: d } = started();
    shoot(d, BREAK_ILLEGAL);
    const d2 = Game.restore(d.serialize(), { WorldClass: FakeWorld });
    const log = track(d2);
    assert.equal(d2.phase, 'decision');
    d2.update(0.016);
    assert.equal(ofType(log, 'decision').length, 1);
    assert.deepEqual(d2.decide('acceptTable'), { ok: true });
  });

  test('concede: the opponent wins the rack', () => {
    const cpu = started({ mode: 'cpu', players: VS_CPU, seed: seedWhereBreaker(1, { mode: 'cpu', players: VS_CPU }) });
    assert.equal(cpu.g.state.turn, 1); // even on the CPU's turn, the human is the one conceding
    assert.deepEqual(cpu.g.concede(), { ok: true });
    assert.equal(cpu.g.phase, 'rackOver');
    assert.deepEqual(cpu.g.match.score, [0, 1]);
    const ro = ofType(cpu.log, 'rackOver')[0];
    assert.equal(ro.reason, 'CONCEDE');
    assert.equal(ro.winner, 1);
    assert.equal(ro.text, 'you conceded');
    assert.equal(ofType(cpu.log, 'message')[0].text, 'You conceded — CPU wins the rack');
    assert.equal(cpu.g.state.endReason, 'CONCEDE');

    const pvp = started();
    const shooter = pvp.g.state.turn;
    pvp.g.world.script({ events: BREAK_POT, frames: 10 });
    pvp.g.shoot(SHOT);
    pvp.g.update(1 / 60);
    assert.deepEqual(pvp.g.concede(), { ok: true }); // allowed mid-roll: balls freeze
    assert.deepEqual(pvp.g.match.score, shooter === 0 ? [0, 1] : [1, 0]);
    pvp.g.update(1);
    assert.equal(pvp.g.phase, 'rackOver');
  });

  test('stalemate: offered after 10 dry turns, re-racks with the same breaker', () => {
    const { g, log } = started();
    const breaker = g.state.breaker;
    shoot(g, BREAK_DRY);
    for (let i = 0; i < 8; i++) shoot(g, [hit(1), rail(1)]);
    assert.equal(g.state.dryTurns, 9);
    assert.equal(g.canAcceptStalemate(), false);
    assert.deepEqual(g.acceptStalemate(), { ok: false, error: 'NOT_STALEMATE' });
    log.length = 0;
    shoot(g, [hit(1), rail(1)]);
    assert.equal(g.state.dryTurns, 10);
    assert.ok(ofType(log, 'message').some((m) => m.text === 'No balls pocketed in 10 turns — re-rack from the pause menu'));
    assert.equal(g.canAcceptStalemate(), true);
    assert.equal(g.hud().stalemate, true);
    log.length = 0;
    assert.deepEqual(g.acceptStalemate(), { ok: true });
    assert.equal(g.phase, 'aim');
    assert.equal(g.state.breaker, breaker);
    assert.equal(g.state.turn, breaker);
    assert.equal(g.state.isBreakShot, true);
    assert.equal(g.state.dryTurns, 0);
    assert.equal(g.state.rackNo, 1);
    assert.deepEqual(g.match.score, [0, 0]);
    assert.deepEqual(g.match.racks, []);
    assert.ok(ofType(log, 'message')[0].text.startsWith('Stalemate — re-rack'));
  });

  test('hud() combines rules.hudInfo with match context', () => {
    const { g } = started();
    shoot(g, BREAK_POT);
    const h = g.hud();
    assert.equal(h.phase, 'aim');
    assert.equal(h.turn, g.state.turn);
    assert.deepEqual(h.score, [0, 0]);
    assert.equal(h.raceTo, 3);
    assert.deepEqual(h.pocketed, [3]);
    assert.equal(h.players.length, 2);
    assert.equal(typeof h.banner, 'string');
    assert.equal(h.onEight, false);
  });

  test('bad shots are refused', () => {
    const { g } = started();
    assert.deepEqual(g.shoot(null), { ok: false, error: 'BAD_SHOT' });
    assert.deepEqual(g.shoot({ angle: NaN, power: 0.5 }), { ok: false, error: 'BAD_SHOT' });
    g.world.script({ events: BREAK_POT });
    assert.deepEqual(g.shoot({ angle: 1, power: 7 }), { ok: true });
    assert.equal(g.world.strikes[0].power, 1);
    assert.deepEqual(g.world.strikes[0].spin, { x: 0, y: 0 });
    assert.deepEqual(g.shoot(SHOT), { ok: false, error: 'PHASE' });
  });

  test('on() returns an unsubscribe function', () => {
    const { g } = newGame();
    let n = 0;
    const off = g.on('toss', () => n++);
    off();
    g.update(TOSS_TIME);
    assert.equal(n, 0);
  });
});
