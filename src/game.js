// Match and rack state machine (docs/rules-spec.md section 10, docs/architecture.md "Game").
//
// No DOM and no storage: main.js persists serialize() and drives update(dt) from its rAF loop.
// The physics world is injectable ({WorldClass}) and used only through this interface:
//   new WorldClass(table), balls, setBalls(list), strike(shot), advance(dt) -> events,
//   atRest(), snapshot(), record() -> {log, final}
//
// Phases: 'toss' -> 'aim' -> 'rolling' -> ('aim' | 'decision' | 'rackOver' | 'matchOver').
// Timers ('toss' 1.2 s, 'cpuTurn' 600 ms) run on update() time, so a paused loop pauses them too.

import { TABLE } from './table.js';
import { World } from './physics.js';
import { mulberry32 } from './rng.js';
import { DT, MAX_SHOT_T } from './constants.js';
import {
  RULESET_CASUAL,
  newGameState,
  getShotRequirements,
  validateShot,
  evaluateShot,
  applyOutcome,
  applyDecision,
  validateCuePlacement,
  nearestValidPlacement,
  isOnEight,
  hudInfo,
  playerName,
  verb,
  rackOverText,
  rackReasonText,
  matchOverText,
} from './rules.js';

export const TOSS_TIME = 1.2; // s
export const CPU_DELAY = 0.6; // s of update time before 'cpuTurn'
export const MAX_MESSAGES = 3; // per shot
export const SAVE_VERSION = 1;
const MAX_FRAME_DT = 0.1; // a stalled frame never feeds more than this to the physics

function defaultPlayers(mode) {
  return mode === 'pvp'
    ? [
        { name: 'Player 1', kind: 'human' },
        { name: 'Player 2', kind: 'human' },
      ]
    : [
        { name: 'You', kind: 'human' },
        { name: 'CPU', kind: 'cpu', level: 'medium' },
      ];
}

function normalizeConfig(config = {}) {
  const mode = config.mode === 'pvp' ? 'pvp' : 'cpu';
  const src = Array.isArray(config.players) && config.players.length === 2 ? config.players : defaultPlayers(mode);
  const players = src.map((p, i) => {
    const kind = p.kind === 'cpu' ? 'cpu' : 'human';
    const out = { name: String(p.name || (kind === 'cpu' ? 'CPU' : `Player ${i + 1}`)), kind };
    if (kind === 'cpu') out.level = p.level ?? 'medium';
    return out;
  });
  const ruleset = { ...RULESET_CASUAL, ...(config.ruleset || {}) };
  const raceTo = Number(config.raceTo ?? ruleset.raceTo);
  ruleset.raceTo = Number.isInteger(raceTo) && raceTo > 0 ? raceTo : RULESET_CASUAL.raceTo;
  return { mode, players, ruleset };
}

function nextBreaker(rotation, lastBreaker, lastWinner) {
  if (rotation === 'winner') return lastWinner;
  if (rotation === 'loser') return 1 - lastWinner;
  return 1 - lastBreaker; // 'alternate'
}

export class Game {
  constructor({ config, seed, table = TABLE, WorldClass = World, restoreData = null } = {}) {
    this.table = table;
    this.world = new WorldClass(table);
    this._listeners = {};
    this._shot = null; // the shot in flight (phase 'rolling')
    this.lastShot = null; // last shot struck; the called pocket stays highlighted while rolling
    this._cpuTimer = -1; // >= 0 while a 'cpuTurn' is pending
    this._tossLeft = 0;
    this._replay = false;
    if (restoreData) {
      this._load(restoreData);
      return;
    }
    const cfg = normalizeConfig(config);
    const s = Number.isFinite(seed) ? seed >>> 0 : (Math.random() * 0x100000000) >>> 0;
    this._rng = mulberry32(s);
    const firstBreaker = this._rng() < 0.5 ? 0 : 1; // the coin toss
    const game = newGameState({
      players: cfg.players,
      ruleset: cfg.ruleset,
      breaker: firstBreaker,
      rng: this._rng,
      table,
    });
    this.match = {
      config: cfg,
      score: [0, 0],
      racks: [],
      firstBreaker,
      winner: null,
      rng: this._rng.state(),
      game,
    };
    this.phase = 'toss';
    this._tossLeft = TOSS_TIME;
    this.world.setBalls(game.balls);
  }

  get state() {
    return this.match.game;
  }

  get raceTo() {
    return this.match.config.ruleset.raceTo;
  }

  get players() {
    return this.match.config.players;
  }

  // ---- Events ----

  on(evt, fn) {
    (this._listeners[evt] || (this._listeners[evt] = [])).push(fn);
    return () => {
      const list = this._listeners[evt];
      const i = list ? list.indexOf(fn) : -1;
      if (i >= 0) list.splice(i, 1);
    };
  }

  _emit(evt, payload) {
    const list = this._listeners[evt];
    if (!list) return;
    for (const fn of list.slice()) fn(payload);
  }

  // ---- Queries ----

  requirements() {
    return getShotRequirements(this.state, this.table);
  }

  cuePosition() {
    const b = this.phase === 'rolling' ? this.world.balls[0] : this.state.balls[0];
    return { x: b.x, y: b.y };
  }

  canAcceptStalemate() {
    const st = this.state;
    return this.phase === 'aim' && st.winner == null && st.dryTurns >= st.ruleset.stalemateOfferAfter;
  }

  // rules.hudInfo plus the match context UI.updateHud expects.
  hud() {
    const st = this.state;
    return {
      ...hudInfo(st),
      turn: st.turn,
      phase: this.phase,
      ballInHand: st.ballInHand,
      onEight: !st.isBreakShot && isOnEight(st, st.turn),
      score: this.match.score.slice(),
      raceTo: this.raceTo,
      rackNo: st.rackNo,
      pocketed: st.pocketed.map((p) => p.ball), // tray, in drop order
      stalemate: this.canAcceptStalemate(),
    };
  }

  // ---- Commands ----

  placeCue(x, y) {
    const st = this.state;
    const cur = st.balls[0];
    if (this.phase !== 'aim' || !st.ballInHand) return { ok: false, x: cur.x, y: cur.y, reason: 'notInHand' };
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, x: cur.x, y: cur.y, reason: 'bounds' };
    const check = validateCuePlacement(st, { x, y }, this.table);
    const at = check.ok ? { x, y } : nearestValidPlacement(st, { x, y }, this.table);
    const balls = st.balls.slice();
    balls[0] = { id: 0, x: at.x, y: at.y, on: true };
    this.match.game = { ...st, balls };
    this.world.setBalls(balls);
    // ok: the cue ball is placed (snapped if needed); reason says why the raw point was refused.
    return check.ok ? { ok: true, x: at.x, y: at.y } : { ok: true, x: at.x, y: at.y, reason: check.reason, snapped: true };
  }

  shoot(shot) {
    if (this.phase !== 'aim') return { ok: false, error: 'PHASE' };
    if (!shot || !Number.isFinite(shot.angle) || !Number.isFinite(shot.power)) return { ok: false, error: 'BAD_SHOT' };
    const spin = shot.spin || {};
    const s = {
      angle: shot.angle,
      power: Math.min(1, Math.max(0, shot.power)),
      spin: { x: Number(spin.x) || 0, y: Number(spin.y) || 0 },
      call: shot.call ? { ...shot.call } : null,
    };
    const st = this.state;
    const v = validateShot(st, s, this.table);
    if (!v.ok) return v;
    this.world.setBalls(st.balls);
    const strikeEvents = this.world.strike(s);
    this._shot = s;
    this.lastShot = s;
    this._cpuTimer = -1;
    this.phase = 'rolling';
    this._emit('shotStart', { shot: s, player: st.turn });
    // The strike event (cue sound) comes back from strike(), not from advance().
    if (Array.isArray(strikeEvents) && strikeEvents.length) this._emit('physics', strikeEvents);
    this._emit('state');
    return { ok: true };
  }

  update(dt) {
    if (this._replay) this._flushReplay();
    if (!(dt > 0)) return;
    switch (this.phase) {
      case 'toss':
        this._tossLeft -= dt;
        if (this._tossLeft <= 0) this._finishToss();
        break;
      case 'aim':
        if (this._cpuTimer >= 0) {
          this._cpuTimer -= dt;
          if (this._cpuTimer <= 0) {
            this._cpuTimer = -1;
            const t = this.state.turn;
            this._emit('cpuTurn', { player: t, level: this.players[t].level });
          }
        }
        break;
      case 'rolling': {
        const events = this.world.advance(Math.min(dt, MAX_FRAME_DT));
        if (events && events.length) this._emit('physics', events);
        if (this.phase === 'rolling' && this.world.atRest()) this._resolveShot();
        break;
      }
      default:
        break;
    }
  }

  decide(option) {
    if (this.phase !== 'decision') return { ok: false, error: 'PHASE' };
    const st = this.state;
    if (!st.pendingDecision.options.includes(option)) return { ok: false, error: 'BAD_OPTION' };
    const msg = this._applyDecision(option);
    this._enterAim();
    this._emit('message', msg);
    this._emit('state');
    return { ok: true };
  }

  // The human gives up the rack (in pass-and-play: the current shooter). The opponent wins it.
  concede(player) {
    if (!['aim', 'rolling', 'decision'].includes(this.phase)) return { ok: false, error: 'PHASE' };
    const st = this.state;
    let loser = player;
    if (loser !== 0 && loser !== 1) {
      const humans = [0, 1].filter((i) => this.players[i].kind === 'human');
      loser = humans.length === 1 ? humans[0] : st.turn;
    }
    if (this.phase === 'rolling') {
      this.world.setBalls(this.world.snapshot()); // freeze the balls where they are
      this._shot = null;
    }
    const winner = 1 - loser;
    this.match.game = { ...st, winner, endReason: 'CONCEDE', pendingDecision: null, ballInHand: null };
    const info = this._finishRack(winner, 'CONCEDE');
    const P = this.players;
    this._emit('message', {
      text: `${playerName(P, loser)} conceded — ${playerName(P, winner)} ${verb(P, winner, 'win', 'wins')} the rack`,
      kind: 'info',
    });
    this._emit('state');
    this._emitRackEnd(info);
    return { ok: true };
  }

  // After stalemateOfferAfter dry turns either player may ask for a re-rack (the CPU accepts).
  acceptStalemate() {
    if (!this.canAcceptStalemate()) return { ok: false, error: this.phase === 'aim' ? 'NOT_STALEMATE' : 'PHASE' };
    const st = this.state;
    this._startRack(st.breaker, st.rackNo, 'Stalemate — re-rack');
    return { ok: true };
  }

  // Pause-menu "Restart rack": fresh rack, same breaker, score unchanged.
  restartRack() {
    if (!['aim', 'rolling', 'decision'].includes(this.phase)) return { ok: false, error: 'PHASE' };
    const st = this.state;
    this._startRack(st.breaker, st.rackNo, 'Rack restarted');
    return { ok: true };
  }

  nextRack() {
    if (this.phase !== 'rackOver') return { ok: false, error: 'PHASE' };
    const st = this.state;
    const last = this.match.racks[this.match.racks.length - 1];
    const breaker = nextBreaker(st.ruleset.breakRotation, st.breaker, last.winner);
    this._startRack(breaker, st.rackNo + 1, `Rack ${st.rackNo + 1}`);
    return { ok: true };
  }

  // New match with the same players and settings; the loser of the last match breaks.
  rematch() {
    if (this.phase !== 'matchOver') return { ok: false, error: 'PHASE' };
    const breaker = 1 - this.match.winner;
    this.match = { ...this.match, score: [0, 0], racks: [], firstBreaker: breaker, winner: null };
    this._startRack(breaker, 1, 'Rematch');
    return { ok: true };
  }

  // ---- Save / restore ----

  // A save taken while the balls roll stores the position before the shot plus the shot itself;
  // restore() replays it to rest (physics is deterministic), so quitting mid-shot cannot undo it.
  serialize() {
    return JSON.stringify({
      v: SAVE_VERSION,
      phase: this.phase === 'rolling' ? 'aim' : this.phase,
      tossLeft: this.phase === 'toss' ? this._tossLeft : 0,
      pendingShot: this.phase === 'rolling' && this._shot ? this._shot : null,
      match: { ...this.match, rng: this._rng.state() },
    });
  }

  static restore(json, { WorldClass, table } = {}) {
    const data = typeof json === 'string' ? JSON.parse(json) : JSON.parse(JSON.stringify(json));
    if (!data || data.v !== SAVE_VERSION || !data.match || !data.match.game) throw new Error('Game.restore: unsupported save');
    return new Game({ restoreData: data, WorldClass, table });
  }

  _load(data) {
    this.match = data.match;
    this._rng = mulberry32(this.match.rng >>> 0);
    this.phase = ['toss', 'aim', 'decision', 'rackOver', 'matchOver'].includes(data.phase) ? data.phase : 'aim';
    this._tossLeft = this.phase === 'toss' ? Math.max(0, Number(data.tossLeft) || TOSS_TIME) : 0;
    this.world.setBalls(this.state.balls);
    if (this.phase === 'aim') this._enterAim();
    if (this.phase === 'aim' && data.pendingShot && this.shoot(data.pendingShot).ok) {
      // Same fixed-DT stepping as advance(), so the replay ends exactly where the live shot would.
      const maxSteps = Math.ceil(MAX_SHOT_T / DT) + 10;
      for (let i = 0; i < maxSteps && !this.world.atRest(); i++) this.world.step(DT);
      this._resolveShot();
    }
    // Listeners attach after restore(), so the first update() re-announces the current phase.
    this._replay = true;
  }

  _flushReplay() {
    this._replay = false;
    this._emit('state');
    const st = this.state;
    if (this.phase === 'decision') this._emit('decision', { decision: st.pendingDecision });
    else if (this.phase === 'rackOver' || this.phase === 'matchOver') {
      const last = this.match.racks[this.match.racks.length - 1];
      if (last) this._emitRackEnd(this._rackInfo(last.winner, last.reason, this.phase === 'matchOver'));
    }
  }

  // ---- Internals ----

  _syncRng() {
    this.match.rng = this._rng.state();
  }

  _enterAim() {
    this.phase = 'aim';
    this._cpuTimer = this.players[this.state.turn].kind === 'cpu' ? CPU_DELAY : -1;
  }

  _finishToss() {
    const b = this.match.firstBreaker;
    const P = this.players;
    this._enterAim();
    this._emit('toss', { breaker: b });
    this._emit('message', {
      text: `${playerName(P, b)} won the toss and ${verb(P, b, 'break', 'breaks')}`,
      kind: 'info',
    });
    this._emit('state');
  }

  _resolveShot() {
    const before = this.state;
    const rec = this.world.record();
    const record = { call: this._shot ? this._shot.call : null, log: rec.log, final: rec.final };
    this._shot = null;
    const outcome = evaluateShot(before, record, { messages: true, table: this.table });
    let next = applyOutcome(before, record, outcome, this.table);
    const messages = outcome.messages.slice();
    this.match.game = next;
    if (next.pendingDecision && next.pendingDecision.auto) {
      messages.push(this._applyDecision(next.pendingDecision.options[0]));
      next = this.state;
    }
    this.world.setBalls(next.balls);
    if (!outcome.gameOver && next.dryTurns === next.ruleset.stalemateOfferAfter) {
      messages.push({ text: `No balls pocketed in ${next.dryTurns} turns — re-rack from the pause menu`, kind: 'info' });
    }

    let rackInfo = null;
    if (outcome.gameOver) rackInfo = this._finishRack(outcome.winner, outcome.reason);
    else if (next.pendingDecision) {
      this.phase = 'decision';
      this._cpuTimer = -1;
    } else this._enterAim();

    for (const m of messages.slice(0, MAX_MESSAGES)) this._emit('message', m);
    this._emit('shotEnd', { outcome });
    this._emit('state');
    if (rackInfo) this._emitRackEnd(rackInfo);
    else if (this.phase === 'decision') this._emit('decision', { decision: next.pendingDecision });
  }

  // Applies a decision option to the state and returns the message describing it.
  _applyDecision(option) {
    const st = this.state;
    const next = applyDecision(st, option, this._rng, this.table);
    this._syncRng();
    this.match.game = next;
    this.world.setBalls(next.balls);
    const P = this.players;
    if (option === 'acceptTable') {
      const t = next.turn;
      return { text: `${playerName(P, t)} ${verb(P, t, 'play', 'plays')} from here`, kind: 'info' };
    }
    const b = next.breaker;
    return { text: `Re-rack — ${playerName(P, b)} ${verb(P, b, 'break', 'breaks')}`, kind: 'info' };
  }

  // Score the rack and move to 'rackOver' or 'matchOver'. Events are emitted by the caller.
  _finishRack(winner, reason) {
    const st = this.state;
    const score = this.match.score.slice();
    score[winner]++;
    this.match.score = score;
    this.match.racks = this.match.racks.concat([{ winner, reason, breaker: st.breaker, shots: st.shotNo }]);
    const over = score[winner] >= this.raceTo;
    if (over) this.match.winner = winner;
    this.phase = over ? 'matchOver' : 'rackOver';
    this._cpuTimer = -1;
    return this._rackInfo(winner, reason, over);
  }

  // rackOver payload: {winner, reason, score, text: why the rack ended, summary: full sentence}.
  // matchOver payload: {winner, score, summary}.
  _rackInfo(winner, reason, matchOver) {
    const score = this.match.score.slice();
    return {
      winner,
      reason,
      score,
      text: rackReasonText(this.state),
      summary: rackOverText(this.state, score),
      matchOver,
      matchSummary: matchOver ? matchOverText(this.players, winner, score) : null,
    };
  }

  _emitRackEnd(info) {
    const { winner, reason, score, text, summary } = info;
    this._emit('rackOver', { winner, reason, score, text, summary });
    if (info.matchOver) this._emit('matchOver', { winner, score, summary: info.matchSummary });
  }

  _startRack(breaker, rackNo, label) {
    const game = newGameState({
      players: this.players,
      ruleset: this.match.config.ruleset,
      breaker,
      rng: this._rng,
      rackNo,
      table: this.table,
    });
    this._syncRng();
    this.match.game = game;
    this._shot = null;
    this.world.setBalls(game.balls);
    this._enterAim();
    const P = this.players;
    this._emit('message', { text: `${label} — ${playerName(P, breaker)} ${verb(P, breaker, 'break', 'breaks')}`, kind: 'info' });
    this._emit('state');
  }
}
