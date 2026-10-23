// CPU opponent tests (docs/architecture.md "AI"). Run: node --test tests/ai.test.js
//
// Every planTurn call passes yieldFn: () => Promise.resolve() so the tests do not wait on timers.
// Results that depend on random execution error are checked over fixed seeds (planTurn is
// deterministic per seed), so these tests are not flaky.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { LEVELS, planTurn, chooseDecision } from '../src/ai.js';
import { simulateShot } from '../src/physics.js';
import { TABLE } from '../src/table.js';
import { mulberry32 } from '../src/rng.js';
import { Game } from '../src/game.js';
import {
  RULESET_CASUAL,
  RULESET_PRO,
  newGameState,
  evaluateShot,
  applyOutcome,
  validateShot,
  validateCuePlacement,
  getShotRequirements,
} from '../src/rules.js';

const R = TABLE.R;
const HSX = TABLE.headStringX;
const yieldFn = () => Promise.resolve();
const PLAYERS = Object.freeze([
  { name: 'CPU 1', kind: 'cpu', level: 'hard' },
  { name: 'CPU 2', kind: 'cpu', level: 'hard' },
]);
const LEVEL_NAMES = ['easy', 'medium', 'hard', 'pro'];

// ---- Fixtures ----

// A GameState with only the listed balls on the table: pos = {id: [x, y]}.
function mkState(pos, { groups = [null, null], turn = 0, ballInHand = null, ruleset = RULESET_CASUAL, shotNo = 6 } = {}) {
  const balls = [];
  for (let id = 0; id < 16; id++) balls.push({ id, x: 0, y: 0, on: false });
  for (const [id, [x, y]] of Object.entries(pos)) balls[Number(id)] = { id: Number(id), x, y, on: true };
  return {
    v: 1,
    ruleset,
    players: PLAYERS,
    rackNo: 1,
    breaker: 0,
    turn,
    isBreakShot: false,
    groups,
    ballInHand,
    balls,
    pocketed: [],
    pendingDecision: null,
    shotNo,
    fouls: [0, 0],
    dryTurns: 0,
    history: [],
    winner: null,
    endReason: null,
  };
}

// Point at distance d from pocket `pid`'s centre, approaching along the pocket axis rotated by
// `rotDeg` (0 = straight into the pocket).
function fromPocket(pid, d, rotDeg = 0) {
  const pk = TABLE.pockets[pid];
  const a = Math.atan2(-pk.dir.y, -pk.dir.x) + (rotDeg * Math.PI) / 180;
  return [pk.x + Math.cos(a) * d, pk.y + Math.sin(a) * d];
}

// Outcome of playing plan.shot (after plan.place) in state st.
function play(st, plan) {
  const s = plan.place ? withCue(st, plan.place) : st;
  const r = simulateShot(s.balls, plan.shot);
  const record = { log: r.log, final: r.final, call: plan.shot.call };
  return { state: s, record, out: evaluateShot(s, record, { messages: false }) };
}

function withCue(st, p) {
  const balls = st.balls.slice();
  balls[0] = { id: 0, x: p.x, y: p.y, on: true };
  return { ...st, balls };
}

const kept = (st, out) => (out.gameOver ? out.winner === st.turn : out.continueTurn);

// The table right after a real break (open table, balls spread): a "full table" position.
function afterBreak(seed) {
  const st0 = newGameState({ players: PLAYERS, rng: mulberry32(seed) });
  const r = simulateShot(st0.balls, { angle: 0, power: 0.97, spin: { x: 0, y: -0.1 } });
  const record = { log: r.log, final: r.final, call: null };
  let st = applyOutcome(st0, record, evaluateShot(st0, record, { messages: false }));
  if (st.pendingDecision) st = { ...st, pendingDecision: null, isBreakShot: false };
  return st;
}

// Straight-in hanger: object 15 cm from the foot-left corner, cue 40 cm behind it on the line.
function hangerState() {
  const [ox, oy] = fromPocket(2, 0.15);
  const [cx, cy] = fromPocket(2, 0.15 + 2 * R + 0.4);
  return mkState({ 0: [cx, cy], 3: [ox, oy], 5: [-0.6, -0.3], 8: [-0.2, 0.3], 11: [0.3, -0.35], 13: [-0.75, 0.2] }, { groups: ['solids', 'stripes'] });
}

// 30-degree cut into the foot-left corner: object 0.45 m out, cue 0.6 m from the ghost ball.
function cutState(deg = 30) {
  const pk = TABLE.pockets[2];
  const [ox, oy] = fromPocket(2, 0.45);
  const ux = (pk.x - ox) / Math.hypot(pk.x - ox, pk.y - oy);
  const uy = (pk.y - oy) / Math.hypot(pk.x - ox, pk.y - oy);
  const gx = ox - 2 * R * ux;
  const gy = oy - 2 * R * uy;
  const a = Math.atan2(uy, ux) + (deg * Math.PI) / 180; // cue travels at `deg` to the object line
  const cx = gx - Math.cos(a) * 0.6;
  const cy = gy - Math.sin(a) * 0.6;
  return mkState({ 0: [cx, cy], 3: [ox, oy], 8: [-0.5, -0.3], 11: [-0.7, 0.3] }, { groups: ['solids', 'stripes'] });
}

// ---- Tests ----

describe('levels and API', () => {
  test('LEVELS carries the specified execution noise and search sizes', () => {
    const spec = {
      easy: [1.6, 0.15, 6, 1, 'none', false, false],
      medium: [0.7, 0.08, 14, 2, 'basic', false, false],
      hard: [0.3, 0.04, 28, 3, 'full', true, false],
      pro: [0.12, 0.02, 45, 4, 'full', true, true],
    };
    assert.deepEqual(Object.keys(LEVELS), LEVEL_NAMES);
    for (const [name, [aim, speed, cands, samples, position, safety, side]] of Object.entries(spec)) {
      const L = LEVELS[name];
      assert.deepEqual(
        [L.aimSigmaDeg, L.speedSigma, L.candidates, L.samples, L.position, L.safety, L.sideSpin],
        [aim, speed, cands, samples, position, safety, side],
        name,
      );
      assert.ok(L.candidates * L.samples <= 250, `${name}: simulation cap`);
      assert.ok(L.breakSpeed >= 8.5 && L.breakSpeed <= 9.3);
    }
  });

  test('chooseDecision follows rules.defaultDecision (re-rack and break after an illegal break)', () => {
    assert.equal(chooseDecision({ type: 'illegalBreak', options: ['acceptTable', 'rerackBreak', 'rerackOpponentBreaks'] }), 'rerackBreak');
    assert.equal(chooseDecision({ type: 'eightOnBreak', options: ['acceptTable', 'rerackBreak'] }), 'acceptTable');
    assert.equal(chooseDecision({ type: 'illegalBreak', auto: true, options: ['rerackBreak'] }), 'rerackBreak');
  });

  test('a pending decision is answered instead of planning a shot', async () => {
    const st = { ...hangerState(), pendingDecision: { type: 'illegalBreak', options: ['acceptTable', 'rerackBreak', 'rerackOpponentBreaks'] } };
    const plan = await planTurn(st, { level: 'hard', seed: 1, yieldFn });
    assert.equal(plan.shot, null);
    assert.equal(plan.info.decision, 'rerackBreak');
  });

  test('deterministic for a given seed; a different seed changes the execution error', async () => {
    const st = afterBreak(3);
    const strip = (p) => ({ place: p.place, shot: p.shot, kind: p.info.kind, target: p.info.target, sims: p.info.sims });
    const a = await planTurn(st, { level: 'hard', seed: 42, yieldFn });
    const b = await planTurn(st, { level: 'hard', seed: 42, yieldFn });
    assert.deepEqual(strip(a), strip(b));
    const c = await planTurn(st, { level: 'hard', seed: 43, yieldFn });
    assert.notDeepEqual(a.shot, c.shot);
    // No seed: derived from the position, still deterministic.
    assert.deepEqual(strip(await planTurn(st, { level: 'hard', yieldFn })), strip(await planTurn(st, { level: 'hard', yieldFn })));
  });
});

describe('potting', () => {
  test('hard pots a straight-in hanger in at least 19 of 20 seeds', async () => {
    const st = hangerState();
    let pots = 0;
    for (let seed = 0; seed < 20; seed++) {
      const plan = await planTurn(st, { level: 'hard', seed, yieldFn });
      assert.equal(plan.place, null);
      assert.ok(validateShot(st, plan.shot).ok);
      const { out } = play(st, plan);
      if (out.continueTurn && out.pocketed.includes(3) && !out.fouls.length) pots++;
    }
    assert.ok(pots >= 19, `hard potted ${pots}/20`);
  });

  test('easy misses a 30-degree cut at least once in 20 seeds; potting rates by level (logged)', async () => {
    const st = cutState(30);
    const rates = {};
    for (const level of LEVEL_NAMES) {
      let pots = 0;
      for (let seed = 0; seed < 20; seed++) {
        const plan = await planTurn(st, { level, seed, yieldFn });
        const { out } = play(st, plan);
        if (kept(st, out)) pots++;
      }
      rates[level] = pots;
    }
    console.log(`30-degree cut (0.45 m + 0.6 m), pots out of 20: ${JSON.stringify(rates)}`);
    assert.ok(rates.easy <= 19, 'easy should miss sometimes');
    assert.ok(rates.hard >= rates.easy, 'hard is at least as good as easy');
    assert.ok(rates.pro >= 17, `pro potted ${rates.pro}/20`);
  });
});

describe('the 8-ball', () => {
  // The 8 hangs in the foot-right corner and is the easiest shot on the table.
  const eightHanger = fromPocket(3, 0.12);
  const cueBehind8 = fromPocket(3, 0.12 + 2 * R + 0.35);

  for (const [name, groups, pos] of [
    ['open table', [null, null], { 0: cueBehind8, 8: eightHanger, 2: [-0.3, 0.25], 12: [-0.55, -0.2], 6: [0.1, 0.3] }],
    ['own group', ['solids', 'stripes'], { 0: cueBehind8, 8: eightHanger, 2: [-0.3, 0.25], 12: [-0.55, -0.2], 6: [0.1, 0.3] }],
  ]) {
    test(`never shoots at the 8 when not on it (${name})`, async () => {
      const st = mkState(pos, { groups });
      assert.ok(!getShotRequirements(st).legalTargets.includes(8));
      for (const level of LEVEL_NAMES) {
        for (let seed = 0; seed < 4; seed++) {
          const plan = await planTurn(st, { level, seed, yieldFn });
          assert.notEqual(plan.info.target, 8, `${level} seed ${seed}`);
          assert.equal(plan.shot.call, null);
          const intended = play(st, { place: plan.place, shot: plan.info.intended });
          assert.notEqual(intended.out.first, 8, `${level} seed ${seed}: intended shot hits the 8 first`);
        }
      }
    });
  }

  test('on the 8 it calls the pocket, and hard pots the 8 in the called pocket', async () => {
    const [ex, ey] = fromPocket(2, 0.2, 10);
    const [cx, cy] = fromPocket(2, 0.2 + 2 * R + 0.35, 10);
    const st = mkState({ 0: [cx, cy], 8: [ex, ey], 9: [-0.5, -0.3], 14: [-0.2, 0.35] }, { groups: ['solids', 'stripes'] });
    assert.ok(getShotRequirements(st).mustCallPocket);
    let wins = 0;
    for (let seed = 0; seed < 10; seed++) {
      const plan = await planTurn(st, { level: 'hard', seed, yieldFn });
      assert.equal(plan.info.target, 8);
      assert.equal(plan.shot.call.pocket, 2);
      assert.ok(validateShot(st, plan.shot).ok);
      const { out, record } = play(st, plan);
      if (out.gameOver && out.winner === 0 && out.reason === 'EIGHT_LEGAL') {
        wins++;
        assert.equal(record.log.find((e) => e.type === 'pocket' && e.ball === 8).pocket, plan.shot.call.pocket);
      }
    }
    assert.ok(wins >= 9, `won ${wins}/10`);
  });

  test('a call is always present when one is required (casual and pro rulesets)', async () => {
    const st = afterBreak(11);
    const pro = { ...st, ruleset: RULESET_PRO };
    for (const s of [st, pro]) {
      for (const level of ['medium', 'pro']) {
        const plan = await planTurn(s, { level, seed: 5, yieldFn });
        const placed = plan.place ? withCue(s, plan.place) : s;
        assert.deepEqual(validateShot(placed, plan.shot), { ok: true }, `${s.ruleset.callShot} ${level}`);
      }
    }
  });
});

describe('ball in hand', () => {
  test('placement anywhere always passes validateCuePlacement, and the shot validates', async () => {
    for (let seed = 1; seed <= 6; seed++) {
      const base = afterBreak(seed);
      const st = { ...base, ballInHand: 'anywhere', isBreakShot: false };
      for (const level of LEVEL_NAMES) {
        const plan = await planTurn(st, { level, seed, yieldFn });
        assert.ok(plan.place, 'returns a placement');
        assert.deepEqual(validateCuePlacement(st, plan.place), { ok: true }, `${level} seed ${seed}`);
        assert.deepEqual(validateShot(withCue(st, plan.place), plan.shot), { ok: true });
      }
    }
  });

  test('kitchen ball in hand: placed behind the head string, no kitchen-blocked target', async () => {
    // After a break foul: two of the player's options sit behind the head string.
    const pos = { 0: [HSX - 0.1, 0], 1: [HSX - 0.2, 0.3], 9: [HSX - 0.25, -0.25], 3: [0.3, 0.2], 11: [0.55, -0.3], 8: [0.2, -0.1], 6: [0.65, 0.35] };
    const st = mkState(pos, { ballInHand: 'kitchen' });
    const req = getShotRequirements(st);
    assert.deepEqual(req.kitchenBlocked.sort(), [1, 9]);
    for (const level of LEVEL_NAMES) {
      for (let seed = 0; seed < 3; seed++) {
        const plan = await planTurn(st, { level, seed, yieldFn });
        assert.ok(plan.place.x < HSX, `${level}: x=${plan.place.x}`);
        assert.deepEqual(validateCuePlacement(st, plan.place), { ok: true });
        assert.ok(![1, 9].includes(plan.info.target), `${level} shot at a kitchen-blocked ball`);
        const { out } = play(st, { place: plan.place, shot: plan.info.intended });
        assert.ok(!out.fouls.includes('KITCHEN'), `${level} seed ${seed}: kitchen foul`);
      }
    }
  });
});

describe('break', () => {
  test('breaks from the kitchen and the break is legal in simulation', async () => {
    for (const level of LEVEL_NAMES) {
      for (let seed = 0; seed < 3; seed++) {
        const st = newGameState({ players: PLAYERS, rng: mulberry32(100 + seed) });
        const plan = await planTurn(st, { level, seed, yieldFn });
        assert.equal(plan.info.kind, 'break');
        assert.ok(plan.place && plan.place.x < HSX, 'cue ball in the kitchen');
        assert.ok(Math.abs(Math.abs(plan.place.y) - 0.12) < 0.02, 'from the side');
        assert.deepEqual(validateCuePlacement(st, plan.place), { ok: true });
        assert.equal(plan.shot.call, null);
        assert.ok(plan.shot.spin.y < 0, 'a little draw');
        const { out } = play(st, plan);
        assert.equal(out.breakLegal, true, `${level} seed ${seed}`);
      }
    }
  });
});

describe('safety', () => {
  test('hard plays a legal safety when nothing is on', async () => {
    // Player 0's only ball (1) is frozen to the middle of the head rail with stripes beside it on
    // the rail (no rail pot) and the side pockets are out of angle: nothing to pot.
    const x = -TABLE.HL + R;
    const pos = { 0: [0.7, 0.1], 1: [x, 0], 9: [x, 0.15], 10: [x, -0.15], 11: [-0.75, 0.05], 12: [-0.6, -0.25], 8: [0.3, -0.3] };
    const st = mkState(pos, { groups: ['solids', 'stripes'] });
    let legal = 0;
    for (let seed = 0; seed < 5; seed++) {
      const plan = await planTurn(st, { level: 'hard', seed, yieldFn });
      assert.equal(plan.info.kind, 'safety', `seed ${seed}`);
      assert.equal(plan.info.target, 1);
      const { out } = play(st, { place: null, shot: plan.info.intended });
      if (!out.fouls.length) legal++;
    }
    assert.ok(legal >= 3, `legal intended shots ${legal}/5`);
  });
});

describe('time slicing and budget', () => {
  test('planTurn on a full table returns within budgetMs + 300 ms; timings by level (logged)', async () => {
    const states = [afterBreak(21), afterBreak(22), afterBreak(23)];
    const lines = [];
    for (const level of LEVEL_NAMES) {
      const ms = [];
      let sims = 0;
      for (let i = 0; i < states.length; i++) {
        const t0 = performance.now();
        const plan = await planTurn(states[i], { level, seed: i, yieldFn, budgetMs: 2500 });
        const dt = performance.now() - t0;
        ms.push(dt);
        sims += plan.info.sims;
        assert.ok(dt < 2500 + 300, `${level}: ${dt.toFixed(0)} ms`);
        assert.ok(plan.info.sims <= 250);
      }
      lines.push(`${level} mean ${(ms.reduce((a, b) => a + b) / ms.length).toFixed(0)} ms max ${Math.max(...ms).toFixed(0)} ms, ${(sims / ms.length).toFixed(0)} sims`);
    }
    console.log(`planTurn on a full table (Node): ${lines.join(' | ')}`);
  });

  test('a tight budget stops early and still returns a legal-looking shot', async () => {
    const st = afterBreak(24);
    for (const budgetMs of [0, 40]) {
      const t0 = performance.now();
      const plan = await planTurn(st, { level: 'pro', seed: 1, yieldFn, budgetMs });
      const dt = performance.now() - t0;
      assert.ok(dt < budgetMs + 300, `${dt.toFixed(0)} ms`);
      assert.ok(plan.info.budgetHit);
      assert.ok(Number.isFinite(plan.shot.angle) && plan.shot.power > 0 && plan.shot.power <= 1);
      const placed = plan.place ? withCue(st, plan.place) : st;
      assert.deepEqual(validateShot(placed, plan.shot), { ok: true });
    }
  });

  test('yields to the caller during long plans (default yield uses setTimeout)', async () => {
    const st = afterBreak(25);
    let yields = 0;
    const plan = await planTurn(st, { level: 'pro', seed: 2, yieldFn: () => (yields++, Promise.resolve()) });
    if (plan.info.elapsedMs > 20) assert.ok(yields >= 1, 'yielded at least once');
    // The default yieldFn (setTimeout) and default clock work too.
    const p2 = await planTurn(st, { level: 'easy', seed: 2 });
    assert.ok(Number.isFinite(p2.shot.angle));
  });
});

describe('CPU vs CPU', () => {
  test('a full hard rack through Game completes within 150 shots, every shot validates', async () => {
    const game = new Game({
      config: { mode: 'cpu', players: PLAYERS.map((p) => ({ ...p })), raceTo: 1 },
      seed: 2024,
    });
    let cpuTurn = false;
    game.on('cpuTurn', () => (cpuTurn = true));
    let shots = 0;
    let pots = 0;
    let attempts = 0;
    const times = [];
    for (let frame = 0; frame < 2e6 && shots < 150; frame++) {
      if (game.phase === 'rackOver' || game.phase === 'matchOver') break;
      if (game.phase === 'decision') {
        assert.equal(game.decide(chooseDecision(game.state.pendingDecision)).ok, true);
        continue;
      }
      if (game.phase === 'aim' && game.canAcceptStalemate()) {
        game.acceptStalemate(); // the CPU accepts a stalemate re-rack (rules-spec section 1)
        continue;
      }
      if (game.phase === 'aim' && cpuTurn) {
        cpuTurn = false;
        const t0 = performance.now();
        const plan = await planTurn(game.state, { level: game.players[game.state.turn].level, seed: shots, yieldFn });
        times.push(performance.now() - t0);
        if (plan.place) {
          const r = game.placeCue(plan.place.x, plan.place.y);
          assert.ok(r.ok && !r.snapped, 'placement accepted as is');
        }
        assert.deepEqual(validateShot(game.state, plan.shot), { ok: true });
        const shooter = game.state.turn;
        assert.deepEqual(game.shoot(plan.shot), { ok: true });
        shots++;
        if (['pot', 'bank', 'kick'].includes(plan.info.kind)) {
          attempts++;
          const unsub = game.on('shotEnd', ({ outcome }) => {
            if (outcome.gameOver ? outcome.winner === shooter : outcome.continueTurn) pots++;
            unsub();
          });
        }
      }
      game.update(1 / 60);
    }
    assert.ok(game.phase === 'rackOver' || game.phase === 'matchOver', `phase ${game.phase} after ${shots} shots`);
    assert.ok(shots <= 150);
    times.sort((a, b) => a - b);
    console.log(
      `hard vs hard: ${shots} shots, ${pots}/${attempts} pot attempts kept the turn, ` +
        `end ${game.state.endReason}, plan median ${times[times.length >> 1].toFixed(0)} ms max ${times[times.length - 1].toFixed(0)} ms`,
    );
  });
});
