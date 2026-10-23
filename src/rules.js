// 8-ball rules engine (docs/rules-spec.md, Casual ruleset with optional Pro paths).
//
// Pure module: no DOM, no Math.random, no clock, and no function ever mutates its inputs. Every
// state is plain JSON (no Set/Map) so it can be saved and restored. The AI calls evaluateShot()
// thousands of times on simulated shots, so the evaluation path works on 16-bit ball masks, makes a
// single pass over the shot log and builds no strings when called with {messages:false}.
//
// Conventions: ball ids 0 cue, 1-7 solids, 8, 9-15 stripes. `state.balls` always has 16 entries
// indexed by id. Bit `1 << id` of a mask stands for ball `id`. Shot logs are in `seq` order (the
// physics contract guarantees strictly increasing `seq`).

import { RACK_GAP, groupOf } from './constants.js';
import { TABLE } from './table.js';
import { randInt } from './rng.js';

export const RULESET_CASUAL = Object.freeze({
  callShot: 'eight', // 'eight' | 'all'
  breakFoulBallInHand: 'kitchen', // 'kitchen' | 'anywhere'
  kitchenRule: true,
  eightOnBreak: 'spot', // 'spot' | 'rerack' | 'choose'
  illegalBreak: 'choose', // 'choose' | 'rerack' (auto: incoming player breaks)
  breakRotation: 'alternate', // 'alternate' | 'winner' | 'loser'
  raceTo: 3, // 1, 3, 5, 7
  stalemateOfferAfter: 10,
});

export const RULESET_PRO = Object.freeze({ ...RULESET_CASUAL, callShot: 'all', eightOnBreak: 'choose' });

// Two cue-ball contacts closer together than this are a split hit (benefit of the doubt).
export const SPLIT_WINDOW = 0.0005;
export const HISTORY_CAP = 400;

// Placement / spotting clearances (metres).
const PLACE_BALL_GAP = 0.0001; // cue placement: 2R + 0.1 mm from any ball
const PLACE_PUSH_GAP = 0.0002; // nearestValidPlacement pushes out to 2R + 0.2 mm
const PLACE_POCKET_GAP = 0.001; // cue placement: captureR + R + 1 mm from a pocket centre
const KITCHEN_EPS = 1e-6; // kitchen clamp keeps x strictly in front of the head string
const SPOT_EPS_OBJECT = 0.00005; // spotted 8 may sit 0.05 mm from an object ball
const SPOT_EPS_CUE = 0.001; // ... but never frozen to the cue ball

const ILLEGAL_BREAK_OPTIONS = Object.freeze(['acceptTable', 'rerackBreak', 'rerackOpponentBreaks']);

// ---- Ball masks ----
const SOLIDS_MASK = 0x00fe; // ids 1-7
const EIGHT_MASK = 0x0100; // id 8
const STRIPES_MASK = 0xfe00; // ids 9-15
const GROUPS_MASK = SOLIDS_MASK | STRIPES_MASK;
const OBJECT_MASK = GROUPS_MASK | EIGHT_MASK;

function groupMask(group) {
  if (group === 'solids') return SOLIDS_MASK;
  if (group === 'stripes') return STRIPES_MASK;
  return 0;
}

function otherGroup(group) {
  return group === 'solids' ? 'stripes' : 'solids';
}

function popcount(m) {
  let n = 0;
  while (m) {
    m &= m - 1;
    n++;
  }
  return n;
}

function maskToIds(m) {
  const ids = [];
  for (let id = 0; id < 16; id++) if ((m >> id) & 1) ids.push(id);
  return ids;
}

function onMaskOf(balls) {
  let m = 0;
  for (let i = 0; i < balls.length; i++) if (balls[i].on) m |= 1 << balls[i].id;
  return m;
}

function ballById(balls, id) {
  const b = balls[id];
  return b && b.id === id ? b : balls.find((x) => x.id === id);
}

// "On the 8": the player's group is cleared, or (open table) all 14 group balls are gone.
function onEightFromMask(group, onMask) {
  return group ? (onMask & groupMask(group)) === 0 : (onMask & GROUPS_MASK) === 0;
}

// Legal first-contact targets for player p, as a mask (spec section 4).
function targetMask(state, p, onMask) {
  if (state.isBreakShot) return onMask & OBJECT_MASK;
  const group = state.groups[p];
  if (group) {
    const own = onMask & groupMask(group);
    return own || onMask & EIGHT_MASK;
  }
  const groupBalls = onMask & GROUPS_MASK;
  return groupBalls || onMask & EIGHT_MASK;
}

function copyBalls(balls) {
  const out = new Array(16);
  for (const b of balls) out[b.id] = { id: b.id, x: b.x, y: b.y, on: !!b.on };
  return out;
}

// ---- Names and message helpers ----

// "You" is used for the single human in a game against the CPU (and for a player named "You").
function isYou(players, i) {
  const p = players && players[i];
  if (!p) return false;
  if (p.name === 'You') return true;
  const other = players[1 - i];
  return p.kind === 'human' && !!other && other.kind === 'cpu';
}

export function playerName(players, i) {
  if (isYou(players, i)) return 'You';
  const p = players && players[i];
  return (p && p.name) || `Player ${i + 1}`;
}

// Verb agreement: "You win" / "CPU wins".
export function verb(players, i, plural, singular) {
  return isYou(players, i) ? plural : singular;
}

function lowerName(players, i) {
  return isYou(players, i) ? 'you' : playerName(players, i);
}

function possessive(players, i, capital) {
  if (isYou(players, i)) return capital ? 'Your' : 'your';
  return `${playerName(players, i)}'s`;
}

function bihSuffix(ballInHand) {
  if (ballInHand === 'kitchen') return ' — ball in hand behind the head string';
  if (ballInHand) return ' — ball in hand';
  return '';
}

function turnText(players, i, ballInHand) {
  return `${possessive(players, i, true)} shot${bihSuffix(ballInHand)}`;
}

function onEightText(players, i) {
  return `${playerName(players, i)} ${verb(players, i, 'are', 'is')} on the 8 — call a pocket`;
}

function winKind(players, winner) {
  const w = players[winner];
  const l = players[1 - winner];
  return w && l && w.kind === 'cpu' && l.kind === 'human' ? 'loss' : 'win';
}

function capGroup(group) {
  return group === 'solids' ? 'Solids' : 'Stripes';
}

function singularGroup(group) {
  if (group === 'solids') return 'solid';
  if (group === 'stripes') return 'stripe';
  return 'ball';
}

function foulText(players, code, opp, first) {
  switch (code) {
    case 'SCRATCH':
      return `Foul: scratch — ${playerName(players, opp)} ${verb(players, opp, 'have', 'has')} ball in hand`;
    case 'CUE_OFF_TABLE':
      return 'Foul: cue ball off the table — ball in hand';
    case 'NO_CONTACT':
      return 'Foul: no ball hit — ball in hand';
    case 'WRONG_BALL_FIRST':
      return `Foul: hit the ${first}-ball first — ball in hand`;
    case 'EIGHT_FIRST_OPEN':
      return "Foul: can't hit the 8 first on an open table — ball in hand";
    case 'KITCHEN':
      return 'Foul: shoot out of the kitchen first — ball in hand';
    case 'NO_RAIL':
      return 'Foul: no cushion after contact — ball in hand';
    case 'OBJECT_OFF_TABLE':
      return 'Foul: ball off the table — ball in hand';
    default:
      return 'Foul — ball in hand';
  }
}

function breakFoulText(players, code, opp, ballInHand) {
  const what =
    code === 'SCRATCH'
      ? 'Scratch on the break'
      : code === 'CUE_OFF_TABLE'
        ? 'Cue ball off the table on the break'
        : 'Ball off the table on the break';
  const where = ballInHand === 'kitchen' ? 'ball in hand behind the head string' : 'ball in hand';
  return `${what} — ${playerName(players, opp)} ${verb(players, opp, 'have', 'has')} ${where}`;
}

function eightText(players, reason, p, o, primaryFoul, group) {
  const win = (i) => `${playerName(players, i)} ${verb(players, i, 'win', 'wins')}`;
  switch (reason) {
    case 'EIGHT_LEGAL':
      return `${win(p)} the rack!`;
    case 'EIGHT_EARLY':
      return `8-ball pocketed early — ${win(o)} the rack`;
    case 'EIGHT_WITH_LAST':
      return `8-ball went down with the last ${singularGroup(group)} — ${win(o)}`;
    case 'EIGHT_FOUL':
      return `${primaryFoul === 'SCRATCH' ? 'Scratched' : 'Fouled'} on the 8 — ${win(o)}`;
    case 'EIGHT_WRONG_POCKET':
      return `8-ball in the wrong pocket — ${win(o)}`;
    default:
      return `8-ball off the table — ${win(o)}`;
  }
}

// Title and button labels (keyed by option) for a decision prompt (UI.showDecision).
function decisionText(players, d) {
  const title = d.type === 'eightOnBreak' ? '8-ball down on the break' : 'Illegal break';
  const labels = {};
  for (const opt of d.options) {
    if (opt === 'acceptTable') {
      if (d.type === 'eightOnBreak') labels[opt] = 'Spot the 8 and play on';
      else labels[opt] = d.cueInHand ? 'Play from here (ball in hand)' : 'Play from here';
    } else if (opt === 'rerackBreak') {
      labels[opt] = 'Re-rack & break';
    } else {
      const off = d.offender;
      labels[opt] = `Re-rack, ${playerName(players, off)} ${verb(players, off, 'break', 'breaks')} again`;
    }
  }
  return { title, labels };
}

// ---- Racking ----

// Spec section 5. The 8 sits in slot (2,1); the back corners hold one random solid and one random
// stripe; the other 12 balls are Fisher-Yates shuffled. The cue ball starts in hand (placed) at
// (HEAD_STRING_X - 2R, 0).
export function createRack(rng, geom = TABLE) {
  const R = geom.R;
  const dx = Math.sqrt(3) * (R + RACK_GAP / 2);
  const dy = 2 * R + RACK_GAP;
  const solid = 1 + randInt(rng, 7);
  const stripe = 9 + randInt(rng, 7);
  const solidOnRight = rng() < 0.5; // slot (4,0) is on the -y (right) side
  const rest = [];
  for (let id = 1; id <= 15; id++) if (id !== 8 && id !== solid && id !== stripe) rest.push(id);
  for (let k = rest.length - 1; k > 0; k--) {
    const r = randInt(rng, k + 1);
    const t = rest[k];
    rest[k] = rest[r];
    rest[r] = t;
  }
  const balls = new Array(16);
  let n = 0;
  for (let i = 0; i < 5; i++) {
    for (let j = 0; j <= i; j++) {
      let id;
      if (i === 2 && j === 1) id = 8;
      else if (i === 4 && j === 0) id = solidOnRight ? solid : stripe;
      else if (i === 4 && j === 4) id = solidOnRight ? stripe : solid;
      else id = rest[n++];
      balls[id] = { id, x: geom.footSpot.x + i * dx, y: geom.footSpot.y + (j - i / 2) * dy, on: true };
    }
  }
  balls[0] = { id: 0, x: geom.headStringX - 2 * R, y: 0, on: true };
  return { balls };
}

export function newGameState({ players, ruleset = RULESET_CASUAL, breaker = 0, rng, rackNo = 1, table = TABLE }) {
  const { balls } = createRack(rng, table);
  return {
    v: 1,
    ruleset,
    players,
    rackNo,
    breaker,
    turn: breaker,
    isBreakShot: true,
    groups: [null, null],
    ballInHand: 'kitchen',
    balls,
    pocketed: [],
    pendingDecision: null,
    shotNo: 0,
    fouls: [0, 0],
    dryTurns: 0,
    history: [],
    winner: null,
    endReason: null,
  };
}

// ---- Predicates and requirements ----

export function isOnEight(state, p) {
  return onEightFromMask(state.groups[p], onMaskOf(state.balls));
}

export function getShotRequirements(state, geom = TABLE) {
  const p = state.turn;
  const rs = state.ruleset;
  const isBreak = !!state.isBreakShot;
  const onMask = onMaskOf(state.balls);
  const legalTargets = maskToIds(targetMask(state, p, onMask));
  const onEight = !isBreak && onEightFromMask(state.groups[p], onMask);
  const kitchenBlocked =
    !isBreak && state.ballInHand === 'kitchen' && rs.kitchenRule
      ? legalTargets.filter((id) => ballById(state.balls, id).x < geom.headStringX)
      : [];
  const callAll = rs.callShot === 'all';
  return {
    shooter: p,
    isBreak,
    ballInHand: state.ballInHand,
    legalTargets,
    kitchenBlocked,
    onEight,
    mustCallPocket: !isBreak && (callAll || onEight),
    mustCallBall: !isBreak && callAll && !onEight,
    canCallSafety: !isBreak && callAll,
  };
}

function validPocketId(pocket, geom) {
  return Number.isInteger(pocket) && geom.pockets.some((pk) => pk.id === pocket);
}

export function validateShot(state, shot, geom = TABLE) {
  if (state.pendingDecision) return { ok: false, error: 'PENDING_DECISION' };
  if (state.ballInHand) {
    const cue = ballById(state.balls, 0);
    if (!cue || !cue.on || !validateCuePlacement(state, cue, geom).ok) {
      return { ok: false, error: 'BALL_IN_HAND_UNPLACED' };
    }
  }
  const call = (shot && shot.call) || null;
  if (call && call.pocket != null && !validPocketId(call.pocket, geom)) return { ok: false, error: 'BAD_POCKET' };
  const req = getShotRequirements(state, geom);
  if (req.mustCallPocket) {
    const safety = req.canCallSafety && call && call.safety;
    if (!safety) {
      if (!call || call.pocket == null) return { ok: false, error: 'MISSING_CALL' };
      if (req.mustCallBall && call.ball == null) return { ok: false, error: 'MISSING_CALL' };
    }
  }
  return { ok: true };
}

// ---- Shot log summary ----

function newSummary() {
  return {
    first: null,
    firstSeq: -1,
    firstT: 0,
    railAfterFirst: false,
    railMask: 0,
    railBalls: 0,
    pocketedObj: [],
    pocketOf: new Int8Array(16),
    potMask: 0,
    cuePocketed: false,
    cueOffTable: false,
    offTableObj: [],
    offMask: 0,
    cueLeftKitchenFirst: false,
  };
}

// Reused by evaluateShot so the hot path allocates nothing beyond the Outcome.
const SCRATCH_SUMMARY = newSummary();

// One pass over the log (spec section 2). `targets` is the legal-target mask (for split hits).
function summarizeInto(S, log, targets, isBreak) {
  S.first = null;
  S.firstSeq = -1;
  S.firstT = 0;
  S.railAfterFirst = false;
  S.railMask = 0;
  S.pocketedObj.length = 0;
  S.pocketOf.fill(-1);
  S.potMask = 0;
  S.cuePocketed = false;
  S.cueOffTable = false;
  S.offTableObj.length = 0;
  S.offMask = 0;
  S.cueLeftKitchenFirst = false;
  // While true, a second cue contact inside SPLIT_WINDOW may replace an illegal first ball.
  let splitOpen = false;
  for (let i = 0, n = log.length; i < n; i++) {
    const e = log[i];
    switch (e.type) {
      case 'ball': {
        if (e.a !== 0 && e.b !== 0) break; // object-object contact
        const other = e.a === 0 ? e.b : e.a;
        if (S.first === null) {
          S.first = other;
          S.firstSeq = e.seq;
          S.firstT = e.t;
          splitOpen = ((targets >> other) & 1) === 0;
        } else if (splitOpen) {
          if (e.t - S.firstT > SPLIT_WINDOW) splitOpen = false;
          else if (other !== S.first && (targets >> other) & 1) {
            S.first = other; // split hit: the shooter gets the benefit of the doubt
            splitOpen = false;
          }
        }
        break;
      }
      case 'cushion':
        // A ball frozen to a cushion does not "reach" it unless it leaves and comes back.
        if (e.frozen) break;
        if (S.first !== null) S.railAfterFirst = true; // a kick (rail before contact) doesn't count
        if (e.ball !== 0) S.railMask |= 1 << e.ball;
        break;
      case 'pocket':
        if (S.pocketOf[e.ball] >= 0) break;
        S.pocketOf[e.ball] = e.pocket;
        if (e.ball === 0) S.cuePocketed = true;
        else {
          S.pocketedObj.push(e.ball);
          S.potMask |= 1 << e.ball;
        }
        break;
      case 'offTable':
        if (e.ball === 0) S.cueOffTable = true;
        else if (!((S.offMask >> e.ball) & 1)) {
          S.offMask |= 1 << e.ball;
          S.offTableObj.push(e.ball);
        }
        break;
      case 'cross':
        if (e.dir > 0 && S.first === null) S.cueLeftKitchenFirst = true;
        break;
      default:
        break; // 'strike' and unknown event types are ignored
    }
  }
  S.railBalls = popcount(S.railMask | (isBreak ? S.offMask : 0));
  return S;
}

// Public summary (spec section 2). Returns a fresh object.
export function summarize(log, state) {
  const onMask = onMaskOf(state.balls);
  const S = summarizeInto(newSummary(), log, targetMask(state, state.turn, onMask), !!state.isBreakShot);
  return {
    first: S.first,
    firstSeq: S.firstSeq,
    railAfterFirst: S.railAfterFirst,
    railBalls: S.railBalls,
    pocketedObj: S.pocketedObj,
    pocketOf: S.pocketOf,
    cuePocketed: S.cuePocketed,
    cueOffTable: S.cueOffTable,
    offTableObj: S.offTableObj,
    cueLeftKitchenFirst: S.cueLeftKitchenFirst,
  };
}

// ---- Shot evaluation ----

// Outcome also carries a few extras beyond the spec: shooter, first, railBalls, offTable.
export function evaluateShot(state, record, opts) {
  const msgs = !opts || opts.messages !== false;
  const geom = (opts && opts.table) || TABLE;
  const p = state.turn;
  const onMask = onMaskOf(state.balls);
  const targets = targetMask(state, p, onMask);
  const S = summarizeInto(SCRATCH_SUMMARY, record.log, targets, !!state.isBreakShot);
  const out = {
    fouls: [],
    primaryFoul: null,
    isBreak: !!state.isBreakShot,
    breakLegal: state.isBreakShot ? true : null,
    pocketed: S.pocketedObj.slice(),
    credited: [],
    continueTurn: false,
    nextPlayer: 1 - p,
    ballInHand: null,
    groupAssigned: null,
    respot: [],
    decision: null,
    gameOver: false,
    winner: null,
    reason: 'MISS',
    messages: [],
    shooter: p,
    first: S.first,
    railBalls: S.railBalls,
    offTable: S.offTableObj.slice(),
  };
  if (state.isBreakShot) evalBreak(state, record, S, out, geom, msgs);
  else evalNormal(state, record, S, out, onMask, targets, geom, msgs);
  return out;
}

// Spec section 6.
function evalBreak(state, record, S, out, geom, msgs) {
  const p = state.turn;
  const o = 1 - p;
  const rs = state.ruleset;
  const P = state.players;
  const eightDown = S.pocketOf[8] >= 0 || (S.offMask & EIGHT_MASK) !== 0;
  const legal = S.pocketedObj.length > 0 || S.railBalls >= 4;
  if (S.cuePocketed) out.fouls.push('SCRATCH');
  if (S.cueOffTable) out.fouls.push('CUE_OFF_TABLE');
  const cueFoul = out.fouls.length > 0;

  if (!legal) {
    out.fouls.unshift('ILLEGAL_BREAK');
    out.primaryFoul = 'ILLEGAL_BREAK';
    out.breakLegal = false;
    out.reason = 'BREAK_ILLEGAL';
    const auto = rs.illegalBreak === 'rerack';
    const d = {
      type: 'illegalBreak',
      chooser: o,
      offender: p,
      options: auto ? ['rerackBreak'] : ILLEGAL_BREAK_OPTIONS.slice(),
      cueInHand: cueFoul ? rs.breakFoulBallInHand : null,
      auto,
    };
    if (msgs) {
      Object.assign(d, decisionText(P, d));
      out.messages.push({
        text: `Illegal break — needs a ball pocketed or 4 balls to a cushion (${S.railBalls} hit)`,
        kind: 'foul',
      });
    }
    out.decision = d;
    return;
  }

  if (S.offMask) out.fouls.push('OBJECT_OFF_TABLE'); // any object ball, the 8 included
  out.primaryFoul = out.fouls.length ? out.fouls[0] : null;
  if (eightDown) {
    // The cue ball does not block the spot when it is coming back into hand.
    const spot = spotOn(record.final, 8, geom, cueFoul);
    out.respot.push({ ball: 8, x: spot.x, y: spot.y });
  }
  if (out.fouls.length) {
    out.nextPlayer = o;
    out.ballInHand = rs.breakFoulBallInHand;
    out.reason = eightDown ? 'EIGHT_ON_BREAK' : 'BREAK_FOUL';
  } else {
    out.continueTurn = S.pocketedObj.length > 0; // the 8 alone counts
    out.nextPlayer = out.continueTurn ? p : o;
    out.reason = eightDown ? 'EIGHT_ON_BREAK' : out.continueTurn ? 'BREAK_POT' : 'BREAK_DRY';
  }
  // Pro option (WPA): the breaker, or the incoming player after a foul, may ask for a re-rack.
  if (eightDown && rs.eightOnBreak !== 'spot') {
    const auto = rs.eightOnBreak === 'rerack';
    const d = {
      type: 'eightOnBreak',
      chooser: out.nextPlayer,
      offender: p,
      options: auto ? ['rerackBreak'] : ['acceptTable', 'rerackBreak'],
      cueInHand: out.ballInHand,
      auto,
    };
    if (msgs) Object.assign(d, decisionText(P, d));
    out.decision = d;
  }
  if (!msgs) return;
  const m = out.messages;
  if (out.primaryFoul) m.push({ text: breakFoulText(P, out.primaryFoul, o, out.ballInHand), kind: 'foul' });
  if (eightDown) m.push({ text: '8-ball down on the break — re-spotted', kind: 'info' });
  if (out.continueTurn) {
    m.push({
      text: `Good break — ${playerName(P, p)} ${verb(P, p, 'shoot', 'shoots')} again. Table is open`,
      kind: 'good',
    });
  } else if (out.reason === 'BREAK_DRY') {
    m.push({ text: `Legal break — table is open. ${possessive(P, o, true)} shot`, kind: 'info' });
  }
}

// Spec section 7.
function evalNormal(state, record, S, out, onMask, targets, geom, msgs) {
  const p = state.turn;
  const o = 1 - p;
  const rs = state.ruleset;
  const call = record.call || null;
  const myGroup = state.groups[p];
  const onEight = onEightFromMask(myGroup, onMask);
  const fouls = out.fouls;
  const first = S.first;

  // 1. Contact checks, in priority order.
  if (S.cuePocketed) fouls.push('SCRATCH');
  if (S.cueOffTable) fouls.push('CUE_OFF_TABLE');
  if (first === null) {
    fouls.push('NO_CONTACT'); // the no-rail check is skipped
  } else {
    if (!((targets >> first) & 1)) fouls.push(!myGroup && first === 8 ? 'EIGHT_FIRST_OPEN' : 'WRONG_BALL_FIRST');
    if (
      state.ballInHand === 'kitchen' &&
      rs.kitchenRule &&
      ballById(state.balls, first).x < geom.headStringX &&
      !S.cueLeftKitchenFirst
    ) {
      fouls.push('KITCHEN');
    }
    if (S.pocketedObj.length === 0 && !S.railAfterFirst) fouls.push('NO_RAIL');
  }
  if (S.offMask & ~EIGHT_MASK) fouls.push('OBJECT_OFF_TABLE'); // stays off the table for good
  out.primaryFoul = fouls.length ? fouls[0] : null;

  // 2. The 8 is down: the rack is over either way.
  const eightOff = (S.offMask & EIGHT_MASK) !== 0;
  if (eightOff || S.pocketOf[8] >= 0) {
    let reason;
    if (eightOff) reason = 'EIGHT_OFF_TABLE';
    else if (!onEight) {
      const own = onMask & groupMask(myGroup);
      const ownAfter = own & ~(S.potMask | S.offMask);
      reason = own && !ownAfter ? 'EIGHT_WITH_LAST' : 'EIGHT_EARLY';
    } else if (fouls.length) reason = 'EIGHT_FOUL';
    else if (!call || S.pocketOf[8] !== call.pocket) reason = 'EIGHT_WRONG_POCKET';
    else reason = 'EIGHT_LEGAL';
    out.gameOver = true;
    out.reason = reason;
    out.winner = reason === 'EIGHT_LEGAL' ? p : o;
    out.nextPlayer = o;
    if (msgs) {
      out.messages.push({
        text: eightText(state.players, reason, p, o, out.primaryFoul, myGroup),
        kind: winKind(state.players, out.winner),
      });
    }
    return;
  }

  // 3. Foul with the 8 still up: one penalty, balls stay down, ball in hand anywhere.
  if (fouls.length) {
    out.nextPlayer = o;
    out.ballInHand = 'anywhere';
    out.reason = 'FOUL';
  } else {
    // 4. Legal shot.
    const credited = out.credited;
    if (rs.callShot === 'all') {
      if (
        call &&
        !call.safety &&
        call.ball != null &&
        (targets >> call.ball) & 1 &&
        S.pocketOf[call.ball] === call.pocket
      ) {
        credited.push(call.ball);
        if (!myGroup) out.groupAssigned = { player: p, group: groupOf(call.ball) };
      }
    } else if (myGroup) {
      for (const id of S.pocketedObj) if (groupOf(id) === myGroup) credited.push(id);
    } else {
      for (const id of S.pocketedObj) credited.push(id);
      // First ball to drop (lowest seq) decides the groups.
      if (credited.length) out.groupAssigned = { player: p, group: groupOf(S.pocketedObj[0]) };
    }
    out.continueTurn = credited.length > 0;
    out.nextPlayer = out.continueTurn ? p : o;
    const oppMask = groupMask(state.groups[o]);
    if (credited.length) out.reason = 'POT';
    else if (S.potMask && oppMask && (S.potMask & ~oppMask) === 0) out.reason = 'OPP_BALL_ONLY';
    else out.reason = 'MISS';
  }
  if (msgs) normalMessages(state, S, out, onMask, onEight);
}

function normalMessages(state, S, out, onMask, onEightAtStart) {
  const P = state.players;
  const p = out.shooter;
  const o = 1 - p;
  const m = out.messages;
  if (out.primaryFoul) m.push({ text: foulText(P, out.primaryFoul, o, out.first), kind: 'foul' });
  if (out.groupAssigned) {
    const g = out.groupAssigned.group;
    m.push({
      text: `${playerName(P, p)} ${verb(P, p, 'are', 'is')} ${capGroup(g)} · ${playerName(P, o)} ${verb(P, o, 'are', 'is')} ${capGroup(otherGroup(g))}`,
      kind: 'good',
    });
  }
  if (out.reason === 'OPP_BALL_ONLY') {
    m.push({ text: `Pocketed ${possessive(P, o, false)} ball — turn over`, kind: 'info' });
  }
  // Tell the next shooter when they are on the 8 (newly, or because the turn changed).
  const next = out.nextPlayer;
  let groupNext = state.groups[next];
  if (out.groupAssigned) {
    groupNext = next === out.groupAssigned.player ? out.groupAssigned.group : otherGroup(out.groupAssigned.group);
  }
  const left = onMask & ~(S.potMask | S.offMask);
  const nextOnEight = onEightFromMask(groupNext, left);
  if (nextOnEight && (next !== p || !onEightAtStart)) m.push({ text: onEightText(P, next), kind: 'info' });
  else if (out.reason === 'MISS') m.push({ text: turnText(P, next, null), kind: 'info' });
}

// ---- Applying results ----

export function applyOutcome(state, record, outcome, geom = TABLE) {
  const p = state.turn;
  const n = state.shotNo + 1;
  const balls = copyBalls(record.final);
  for (let i = 0; i < 16; i++) if (!balls[i]) balls[i] = { ...ballById(state.balls, i) };
  const respotted = new Array(16).fill(false);
  for (const r of outcome.respot) {
    balls[r.ball] = { id: r.ball, x: r.x, y: r.y, on: true };
    respotted[r.ball] = true;
  }
  // Rules have the last word on what left the table, whatever `final` says.
  for (const id of outcome.pocketed) if (!respotted[id]) balls[id].on = false;
  if (outcome.offTable) for (const id of outcome.offTable) if (!respotted[id]) balls[id].on = false;

  const added = [];
  const seen = new Array(16).fill(false);
  for (const e of record.log) {
    if ((e.type === 'pocket' || e.type === 'offTable') && e.ball !== 0 && !seen[e.ball]) {
      seen[e.ball] = true;
      if (!respotted[e.ball]) added.push({ ball: e.ball, pocket: e.type === 'pocket' ? e.pocket : -1, shot: n, by: p });
    }
  }
  const cueGone = !balls[0].on || outcome.fouls.includes('SCRATCH') || outcome.fouls.includes('CUE_OFF_TABLE');
  if (cueGone) balls[0].on = false;

  const history = state.history.concat([
    {
      n,
      shooter: p,
      call: record.call || null,
      first: outcome.first === undefined ? null : outcome.first,
      pocketed: outcome.pocketed.slice(),
      fouls: outcome.fouls.slice(),
      reason: outcome.reason,
    },
  ]);
  if (history.length > HISTORY_CAP) history.splice(0, history.length - HISTORY_CAP);
  const fouls = state.fouls.slice();
  if (outcome.fouls.length) fouls[p]++;

  let next = {
    ...state,
    balls,
    pocketed: state.pocketed.concat(added),
    shotNo: n,
    fouls,
    dryTurns: outcome.pocketed.length > 0 ? 0 : state.dryTurns + 1,
    history,
    pendingDecision: null,
  };

  if (outcome.gameOver) {
    next.winner = outcome.winner;
    next.endReason = outcome.reason;
    next.ballInHand = null;
    next.isBreakShot = false;
    return next;
  }
  if (outcome.groupAssigned) {
    const { player, group } = outcome.groupAssigned;
    next.groups = player === 0 ? [group, otherGroup(group)] : [otherGroup(group), group];
  }
  if (outcome.decision) {
    // The chooser decides first; acceptTable later grants decision.cueInHand.
    next.pendingDecision = { ...outcome.decision, options: outcome.decision.options.slice() };
    next.turn = outcome.decision.chooser;
    next.ballInHand = null;
    if (outcome.decision.type === 'eightOnBreak') next.isBreakShot = false;
    return next;
  }
  next.turn = outcome.nextPlayer;
  next.isBreakShot = false;
  next.ballInHand = outcome.ballInHand;
  if (next.ballInHand) next = placeCueInHand(next, cueGone, geom);
  return next;
}

// Ball-in-hand UX: the cue ball is placed straight away at the spec's default start position
// (kitchen spot / head spot after a scratch / where it stopped), snapped to a valid spot.
function placeCueInHand(st, scratched, geom) {
  const cue = ballById(st.balls, 0);
  let target;
  if (st.ballInHand === 'kitchen') target = { x: geom.headStringX - 2 * geom.R, y: 0 };
  else if (scratched || !cue.on) target = { x: geom.headStringX, y: 0 };
  else target = { x: cue.x, y: cue.y };
  const at = nearestValidPlacement(st, target, geom);
  const balls = st.balls.slice();
  balls[0] = { id: 0, x: at.x, y: at.y, on: true };
  return { ...st, balls };
}

export function applyDecision(state, option, rng, geom = TABLE) {
  const d = state.pendingDecision;
  if (!d) throw new Error('applyDecision: no pending decision');
  if (!d.options.includes(option)) throw new Error(`applyDecision: '${option}' is not an option`);
  if (option === 'rerackBreak') return rerack(state, d.chooser, rng, geom);
  if (option === 'rerackOpponentBreaks') return rerack(state, 1 - d.chooser, rng, geom);
  // acceptTable: the chooser plays the table as it lies (an 8 that left the table is spotted).
  let balls = state.balls;
  const eight = ballById(balls, 8);
  if (!eight.on) {
    const spot = spotOn(balls, 8, geom, !!d.cueInHand);
    balls = balls.slice();
    balls[8] = { id: 8, x: spot.x, y: spot.y, on: true };
  }
  let next = {
    ...state,
    balls,
    turn: d.chooser,
    isBreakShot: false,
    pendingDecision: null,
    ballInHand: d.cueInHand || null,
  };
  if (next.ballInHand) next = placeCueInHand(next, true, geom);
  return next;
}

function rerack(state, breaker, rng, geom) {
  return newGameState({
    players: state.players,
    ruleset: state.ruleset,
    breaker,
    rng,
    rackNo: state.rackNo,
    table: geom,
  });
}

// The CPU's choice. Re-racking and breaking is the strongest answer to an illegal break.
export function defaultDecision(decision) {
  if (decision.auto || decision.options.length === 1) return decision.options[0];
  if (decision.type === 'illegalBreak' && decision.options.includes('rerackBreak')) return 'rerackBreak';
  if (decision.options.includes('acceptTable')) return 'acceptTable';
  return decision.options[0];
}

// ---- Ball in hand ----

export function validateCuePlacement(state, pt, geom = TABLE) {
  const R = geom.R;
  const { x, y } = pt;
  if (!(Math.abs(x) <= geom.HL - R && Math.abs(y) <= geom.HW - R)) return { ok: false, reason: 'bounds' };
  for (const pk of geom.pockets) {
    if (Math.hypot(x - pk.x, y - pk.y) < pk.captureR + R + PLACE_POCKET_GAP) return { ok: false, reason: 'pocket' };
  }
  const minD = 2 * R + PLACE_BALL_GAP;
  for (const b of state.balls) {
    if (b.id === 0 || !b.on) continue;
    if (Math.hypot(x - b.x, y - b.y) < minD) return { ok: false, reason: 'overlap' };
  }
  if (state.ballInHand === 'kitchen' && !(x < geom.headStringX)) return { ok: false, reason: 'kitchen' };
  return { ok: true };
}

// Deterministic snap used while dragging the cue ball (spec section 8).
export function nearestValidPlacement(state, pt, geom = TABLE) {
  const R = geom.R;
  const xMin = -(geom.HL - R);
  const xMax = state.ballInHand === 'kitchen' ? Math.min(geom.HL - R, geom.headStringX - KITCHEN_EPS) : geom.HL - R;
  const yMax = geom.HW - R;
  const clampPt = (x, y) => ({
    x: x < xMin ? xMin : x > xMax ? xMax : x,
    y: y < -yMax ? -yMax : y > yMax ? yMax : y,
  });
  const valid = (q) => validateCuePlacement(state, q, geom).ok;
  const start = clampPt(Number.isFinite(pt.x) ? pt.x : 0, Number.isFinite(pt.y) ? pt.y : 0);
  if (valid(start)) return start;

  // 1. Push straight out of the deepest obstacle (ball or pocket), up to 8 times.
  let q = start;
  for (let it = 0; it < 8; it++) {
    let worst = 0;
    let cx = 0;
    let cy = 0;
    let need = 0;
    for (const b of state.balls) {
      if (b.id === 0 || !b.on) continue;
      const pen = 2 * R + PLACE_BALL_GAP - Math.hypot(q.x - b.x, q.y - b.y);
      if (pen > worst) {
        worst = pen;
        cx = b.x;
        cy = b.y;
        need = 2 * R + PLACE_PUSH_GAP;
      }
    }
    for (const pk of geom.pockets) {
      const req = pk.captureR + R + PLACE_POCKET_GAP;
      const pen = req - Math.hypot(q.x - pk.x, q.y - pk.y);
      if (pen > worst) {
        worst = pen;
        cx = pk.x;
        cy = pk.y;
        need = req + PLACE_PUSH_GAP;
      }
    }
    if (worst <= 0) break;
    let ux = q.x - cx;
    let uy = q.y - cy;
    let l = Math.hypot(ux, uy);
    if (l < 1e-9) {
      ux = -1; // exactly on the obstacle: push toward the head rail
      uy = 0;
      l = 1;
    }
    q = clampPt(cx + (ux / l) * need, cy + (uy / l) * need);
    if (valid(q)) return q;
  }

  // 2. Rings of radius k*R/2 around the requested point, 16 angles each.
  for (let k = 1; k <= 40; k++) {
    const r = (k * R) / 2;
    for (let a = 0; a < 16; a++) {
      const ang = (a * Math.PI) / 8;
      const c = { x: start.x + r * Math.cos(ang), y: start.y + r * Math.sin(ang) };
      if (valid(c)) return c;
    }
  }

  // 3. Last resort (crowded kitchen): coarse scan of the allowed area, closest valid point wins.
  let best = null;
  let bestD = Infinity;
  const step = R / 2;
  for (let x = xMin; x <= xMax; x += step) {
    for (let y = -yMax; y <= yMax; y += step) {
      const c = { x, y };
      const dd = (x - start.x) ** 2 + (y - start.y) ** 2;
      if (dd < bestD && valid(c)) {
        best = c;
        bestD = dd;
      }
    }
  }
  return best || start;
}

// ---- Spotting ----

// WPA spotting: on the long string behind the foot spot, as close to the spot as possible;
// if the long string is full, in front of the spot toward the head rail. y is always 0.
export function spotPosition(balls, ballId, geom = TABLE) {
  return spotOn(balls, ballId, geom, false);
}

function spotOn(balls, ballId, geom, ignoreCue) {
  const R = geom.R;
  const fx = geom.footSpot.x;
  const fy = geom.footSpot.y;
  const intervals = [];
  for (const b of balls) {
    if (!b.on || b.id === ballId || (ignoreCue && b.id === 0)) continue;
    const reach = 2 * R + (b.id === 0 ? SPOT_EPS_CUE : SPOT_EPS_OBJECT);
    const ay = Math.abs(b.y - fy);
    if (ay >= reach) continue;
    const h = Math.sqrt(reach * reach - ay * ay);
    intervals.push([b.x - h, b.x + h]);
  }
  intervals.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const iv of intervals) {
    const last = merged[merged.length - 1];
    if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
    else merged.push([iv[0], iv[1]]);
  }
  // Blocked sets are open intervals: a ball exactly at an end touches with the full clearance.
  let x = fx;
  for (const [lo, hi] of merged) if (x > lo && x < hi) x = hi;
  if (x <= geom.HL - R) return { x, y: fy };
  x = fx;
  for (let k = merged.length - 1; k >= 0; k--) {
    const [lo, hi] = merged[k];
    if (x > lo && x < hi) x = lo;
  }
  return { x, y: fy };
}

// ---- HUD and summary text ----

export function hudInfo(state) {
  const players = [0, 1].map((i) => {
    const group = state.groups[i];
    const remaining = [];
    if (group) for (const b of state.balls) if (b.on && groupOf(b.id) === group) remaining.push(b.id);
    remaining.sort((a, b) => a - b);
    return {
      name: playerName(state.players, i),
      group,
      remaining,
      onEight: !state.isBreakShot && isOnEight(state, i),
      fouls: state.fouls[i],
    };
  });
  return { players, banner: bannerText(state) };
}

function bannerText(state) {
  const P = state.players;
  if (state.winner != null) {
    const w = state.winner;
    return `${playerName(P, w)} ${verb(P, w, 'win', 'wins')} the rack!`;
  }
  const d = state.pendingDecision;
  if (d) {
    const c = d.chooser;
    return `${d.title || decisionText(P, d).title} — ${playerName(P, c)} ${verb(P, c, 'choose', 'chooses')}`;
  }
  const t = state.turn;
  if (state.isBreakShot) return `${possessive(P, t, true)} break`;
  if (isOnEight(state, t)) return onEightText(P, t) + (state.ballInHand ? ' · ball in hand' : '');
  return turnText(P, t, state.ballInHand);
}

// Why the rack ended, from the loser's side where it matters: "you pocketed the 8 early".
export function rackReasonText(state) {
  const l = 1 - state.winner;
  const loser = lowerName(state.players, l);
  switch (state.endReason) {
    case 'EIGHT_LEGAL':
      return '8-ball in the called pocket';
    case 'EIGHT_EARLY':
      return `${loser} pocketed the 8 early`;
    case 'EIGHT_WITH_LAST':
      return `${loser} sank the 8 with the last ${singularGroup(state.groups[l])}`;
    case 'EIGHT_FOUL':
      return `${loser} fouled on the 8`;
    case 'EIGHT_WRONG_POCKET':
      return `${loser} put the 8 in the wrong pocket`;
    case 'EIGHT_OFF_TABLE':
      return `${loser} knocked the 8 off the table`;
    case 'CONCEDE':
      return `${loser} conceded`;
    default:
      return 'rack over';
  }
}

// "You win the rack — 8-ball in the called pocket · 2–1" (winner's score first).
export function rackOverText(state, score) {
  const w = state.winner;
  if (w == null) return '';
  const P = state.players;
  const s = score ? ` · ${score[w]}–${score[1 - w]}` : '';
  return `${playerName(P, w)} ${verb(P, w, 'win', 'wins')} the rack — ${rackReasonText(state)}${s}`;
}

export function matchOverText(players, winner, score) {
  const l = 1 - winner;
  return `${playerName(players, winner)} ${verb(players, winner, 'win', 'wins')} the match ${score[winner]}–${score[l]}!`;
}
