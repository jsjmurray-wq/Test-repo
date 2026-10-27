// Round state machine (docs/architecture.md section 4, "Game"). Pure module: no DOM, no clock and
// no storage. main.js drives update(dt) from its rAF loop, feeds swings from input.js through
// interpretSwing, renders from terrain/ballPos()/shot, and persists serialize().
//
// Phases
//   null -> loadHole(i) -> 'intro' -> skipIntro() -> 'address' -> swing() -> 'flight'
//   'flight' -> (update() plays the shot back; END_HOLD s after the ball stops it resolves) ->
//       'address'  (ball at rest, or out of bounds: replay from the previous spot)
//       'decision' (water: decide('drop' | 'replay'))
//       'holed'    (holed, or picked up at double par)
//   'holed' -> (HOLED_HOLD s of update(), or skip()) -> 'scorecard' -> nextHole() -> 'intro' ...
//   After the last hole 'holed' goes to 'roundOver' instead of 'scorecard' (the final card).
//
// Events (on(evt, fn) returns an unsubscribe function)
//   'phase' (phase, prev)        'hole' (holeInfo)           'shotStart' (shot)
//   'shotEvent' (physics event; the launch event also carries kind, club, power)
//   'shotEnd' ({shot, resolution})                            'decision' (decision)
//   'holed' ({holeIndex, strokes, par, name, pickUp, toPar, card, totals})
//   'roundOver' ({card, totals})  'message' ({text, tone:'info'|'over'|'under'|'par'|'ace'})
// A restored game re-announces 'hole', 'phase' (and 'decision') on its first update().
//
// Randomness: one mulberry32 stream (state.rng) feeds the swing contact scatter and the per-shot
// physics seed, so a restored save continues exactly as the original would have. Pins and wind
// derive from the round seed.

import { COURSE } from './course.js';
import { buildHole as defaultBuildHole } from './terrain.js';
import { SURF, BALL_R } from './constants.js';
import { mulberry32, randInt } from './rng.js';
import { clubById } from './clubs.js';
import { simulateShot } from './physics.js';
import { lieAt } from './lie.js';
import { swingToLaunch, PUTT_RANGES } from './swing.js';
import { clubTable, suggestClub, playsLike, puttRange } from './caddie.js';
import { resolveShot, scoreName } from './rules.js';
import { newCard, recordHole, totals } from './scoring.js';
import { normalizeAngle } from './vec3.js';

export const SAVE_VERSION = 1;
export const END_HOLD = 0.8; // s of playback after the ball stops before the shot resolves
export const HOLED_HOLD = 2.5; // s in 'holed' before the scorecard
export const TREE_SEED = 1; // the course looks the same every round; pins and wind vary
export const WIND_RANGES = { off: [0, 0], light: [0, 4], breezy: [3, 8] }; // m/s at 10 m
export const DEFAULT_SETTINGS = Object.freeze({ wind: 'light', difficulty: 'normal', units: 'yd', handed: 'R' });

const RESTORABLE = ['intro', 'address', 'decision', 'holed', 'scorecard', 'roundOver'];
const clone = (o) => JSON.parse(JSON.stringify(o));
const copy3 = (p) => ({ x: p.x, y: p.y, z: p.z });

// Wind for a hole: uniform direction, speed uniform in the setting's range; a pure function of
// (seed, hole, setting) so a restored round and a replayed hole get the same wind.
export function windFor(seed, holeIndex, setting) {
  const [lo, hi] = WIND_RANGES[setting] || WIND_RANGES.light;
  if (hi <= 0) return { x: 0, y: 0 };
  const r = mulberry32(((seed >>> 0) ^ Math.imul(holeIndex + 1, 0x9e3779b1)) >>> 0);
  r();
  const speed = lo + (hi - lo) * r();
  const dir = r() * Math.PI * 2;
  return { x: speed * Math.cos(dir), y: speed * Math.sin(dir) };
}

// Ball position on a recorded path [t, x, y, z]* at time t (linear between samples).
export function pathAt(path, t) {
  const n = path.length / 4;
  if (n === 0) return null;
  if (t <= path[0]) return { x: path[1], y: path[2], z: path[3] };
  const k = (n - 1) * 4;
  if (t >= path[k]) return { x: path[k + 1], y: path[k + 2], z: path[k + 3] };
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (path[mid * 4] <= t) lo = mid;
    else hi = mid;
  }
  const a = lo * 4;
  const b = hi * 4;
  const f = path[b] > path[a] ? (t - path[a]) / (path[b] - path[a]) : 1;
  return { x: path[a + 1] + (path[b + 1] - path[a + 1]) * f, y: path[a + 2] + (path[b + 2] - path[a + 2]) * f, z: path[a + 3] + (path[b + 3] - path[a + 3]) * f };
}

function newHoleState(terrain) {
  return {
    strokes: 0,
    putts: 0,
    penalties: 0,
    fir: null,
    gir: false,
    pickUp: false,
    done: false,
    ball: { x: terrain.tee.x, y: terrain.tee.y, z: terrain.tee.z + BALL_R },
    onTee: true,
    last: null, // {clubId, carry, total, outcome, label} of the last finished shot
  };
}

export class Game {
  constructor({ course = COURSE, seed = 1, settings = {}, buildHole = defaultBuildHole } = {}) {
    this.course = course;
    this.buildHole = buildHole;
    this._listeners = {};
    this.phase = null;
    this.terrain = null;
    this.def = null;
    this.shot = null; // {result, playT, launch, clubId, seed, resolution, swing, next, done}
    this._preShot = null; // state snapshot taken at the strike (mid-flight saves)
    this._holedT = 0;
    this._announce = false;
    this._lie = null;
    this._lieKey = '';
    this._table = null;
    this._tableKey = '';
    const s = seed >>> 0;
    const pinRng = mulberry32(s ^ 0x51ed270b);
    this.state = {
      v: SAVE_VERSION,
      seed: s,
      settings: { ...DEFAULT_SETTINGS, ...settings },
      pins: course.holes.map(() => randInt(pinRng, 3)),
      card: newCard(course),
      rng: (s ^ 0xa5a5a5a5) >>> 0,
      holeIndex: 0,
      hole: null,
      aimYaw: 0,
      clubId: 'D',
      puttRange: PUTT_RANGES[2],
      wind: { x: 0, y: 0 },
      decision: null,
      phase: null,
    };
    this._rng = mulberry32(this.state.rng);
  }

  // ------------------------------------------------------------------ events

  on(evt, fn) {
    (this._listeners[evt] || (this._listeners[evt] = [])).push(fn);
    return () => {
      const l = this._listeners[evt];
      const i = l ? l.indexOf(fn) : -1;
      if (i >= 0) l.splice(i, 1);
    };
  }

  _emit(evt, ...args) {
    const l = this._listeners[evt];
    if (!l) return;
    for (const fn of l.slice()) fn(...args);
  }

  _setPhase(p) {
    const prev = this.phase;
    this.phase = p;
    this.state.phase = p;
    this._emit('phase', p, prev);
  }

  // ------------------------------------------------------------------ holes

  loadHole(i, terrain = null) {
    const st = this.state;
    st.holeIndex = i;
    this.def = this.course.holes[i];
    this.terrain = terrain || this.buildHole(this.def, { pinIndex: st.pins[i], seed: TREE_SEED });
    st.wind = windFor(st.seed, i, st.settings.wind);
    st.hole = newHoleState(this.terrain);
    st.decision = null;
    this.shot = null;
    this._preShot = null;
    this._holedT = 0;
    this._newLie();
    this.phase = 'intro';
    st.phase = 'intro';
    this._emit('hole', this.holeInfo());
    this._emit('phase', 'intro', null);
    return this.terrain;
  }

  holeInfo() {
    const t = this.terrain;
    return {
      index: this.state.holeIndex,
      n: t.n,
      par: t.par,
      name: t.name,
      si: t.si,
      lengthM: t.lengthM,
      pinIndex: this.state.pins[this.state.holeIndex],
      wind: { ...this.state.wind },
      terrain: t,
      def: this.def,
    };
  }

  skipIntro() {
    if (this.phase !== 'intro') return false;
    this._setPhase('address');
    return true;
  }

  // Tap-to-skip: intro -> address, flight -> fast-forward to the end, holed -> scorecard.
  skip() {
    if (this.phase === 'intro') return this.skipIntro();
    if (this.phase === 'flight' && this.shot) {
      this.update(Math.max(0, this.shot.result.t + END_HOLD - this.shot.playT));
      return true;
    }
    if (this.phase === 'holed') {
      this._toScorecard();
      return true;
    }
    return false;
  }

  nextHole() {
    if (this.phase !== 'holed' && this.phase !== 'scorecard') return false;
    const i = this.state.holeIndex + 1;
    if (i >= this.course.holes.length) {
      if (this.phase !== 'roundOver') this._roundOver();
      return true;
    }
    this.loadHole(i);
    return true;
  }

  setSettings(partial = {}) {
    const st = this.state;
    const prevWind = st.settings.wind;
    st.settings = { ...st.settings, ...partial };
    if (st.settings.wind !== prevWind && this.terrain) {
      st.wind = windFor(st.seed, st.holeIndex, st.settings.wind);
      this._table = null;
    }
    this._lie = null;
  }

  // ------------------------------------------------------------------ address state

  get aimYaw() {
    return this.state.aimYaw;
  }

  setAim(yaw) {
    this.state.aimYaw = normalizeAngle(yaw);
  }

  get club() {
    return clubById(this.state.clubId);
  }

  setClub(id) {
    if (!clubById(id)) return false;
    this.state.clubId = id;
    return true;
  }

  get wind() {
    return this.state.wind;
  }

  get puttRange() {
    return this.state.puttRange;
  }

  setPuttRange(m) {
    let best = PUTT_RANGES[0];
    for (const r of PUTT_RANGES) if (Math.abs(r - m) < Math.abs(best - m)) best = r;
    this.state.puttRange = best;
    return best;
  }

  // dir +1 / -1 steps through PUTT_RANGES.
  stepPuttRange(dir) {
    const i = PUTT_RANGES.indexOf(this.state.puttRange);
    const j = Math.max(0, Math.min(PUTT_RANGES.length - 1, (i < 0 ? 2 : i) + (dir > 0 ? 1 : -1)));
    this.state.puttRange = PUTT_RANGES[j];
    return this.state.puttRange;
  }

  get isPutt() {
    const c = this.club;
    return !!c && c.kind === 'putter';
  }

  // Lie of the ball for the current aim (cached until the ball or the aim moves).
  get lie() {
    const b = this.state.hole.ball;
    const key = `${b.x},${b.y},${this.state.aimYaw},${this.state.settings.handed}`;
    if (!this._lie || this._lieKey !== key) {
      this._lie = lieAt(this.terrain, b, this.state.aimYaw, { handed: this.state.settings.handed });
      this._lieKey = key;
    }
    return this._lie;
  }

  // Caddie club table for the current spot (computed once per lie, along the default aim).
  get table() {
    const b = this.state.hole.ball;
    const w = this.state.wind;
    const key = `${b.x},${b.y},${w.x},${w.y}`;
    if (!this._table || this._tableKey !== key) {
      this._table = clubTable(this.terrain, b, this.lie, w, { aimYaw: this.state.aimYaw });
      this._tableKey = key;
    }
    return this._table;
  }

  // Carry/total (m) of a club from here, or the putt range for the putter.
  clubInfo(id = this.state.clubId) {
    const c = clubById(id);
    if (!c) return null;
    if (c.kind === 'putter') return { id, name: c.name, carry: null, total: null, puttRange: this.state.puttRange };
    const row = this.table.find((r) => r.id === id);
    return { id, name: c.name, carry: row ? row.carry : null, total: row ? row.total : null };
  }

  suggestClub() {
    const t = this.terrain;
    return suggestClub(t, this.state.hole.ball, this.lie, this.state.wind, {
      table: this.lie.surface === SURF.GREEN || this.lie.surface === SURF.FRINGE ? [] : this.table,
      par: t.par,
      teeShot: this.state.hole.onTee,
      aimYaw: this.state.aimYaw,
    });
  }

  distanceToCup() {
    const b = this.ballPos();
    const c = this.terrain.cup;
    return Math.hypot(c.x - b.x, c.y - b.y);
  }

  // Plays-like distance to the cup (m), or null on the green.
  playsLike() {
    const s = this.lie.surface;
    if (s === SURF.GREEN || this.isPutt) return null;
    return playsLike(this.terrain, this.state.hole.ball, this.terrain.cup, this.state.wind, this.table);
  }

  // Current ball centre {x, y, z}; during flight, interpolated from the shot path at playT.
  ballPos() {
    if (this.phase === 'flight' && this.shot) {
      const p = pathAt(this.shot.result.path, this.shot.playT);
      if (p) return p;
    }
    return copy3(this.state.hole.ball);
  }

  totals() {
    return totals(this.state.card);
  }

  // New spot: default aim (the course's aim point, or the cup from on and around the green),
  // the caddie's club and the putt range.
  _newLie() {
    const st = this.state;
    const t = this.terrain;
    const b = st.hole.ball;
    const s = t.surfaceAt(b.x, b.y);
    const target = s === SURF.GREEN || s === SURF.FRINGE ? t.cup : t.aimPoint(b);
    st.aimYaw = Math.atan2(target.y - b.y, target.x - b.x);
    this._lie = null;
    this._table = null;
    st.puttRange = puttRange(Math.hypot(t.cup.x - b.x, t.cup.y - b.y));
    st.clubId = this.suggestClub();
  }

  // ------------------------------------------------------------------ shots

  // swingResult from interpretSwing (or a bot). A failed swing (cancel, too slow, too short) is
  // not a stroke. Returns {ok, shot} or {ok:false, reason}.
  swing(sw) {
    if (this.phase !== 'address') return { ok: false, reason: 'phase' };
    if (!sw || !sw.ok) return { ok: false, reason: (sw && sw.reason) || 'cancel' };
    const st = this.state;
    const club = this.club;
    const launch = swingToLaunch(club, this.lie, sw, st.aimYaw, this._rng, { pos: st.hole.ball, puttRange: st.puttRange });
    const seed = (this._rng() * 4294967296) >>> 0;
    st.rng = this._rng.state();
    this._preShot = clone(st);
    const swingInfo = { ok: true, kind: sw.kind, power: sw.power, startDir: sw.startDir, faceToPath: sw.faceToPath, tempo: sw.tempo, label: sw.label };
    return { ok: true, shot: this._strike(launch, seed, club.id, swingInfo) };
  }

  _strike(launch, seed, clubId, swingInfo) {
    const st = this.state;
    const hole = st.hole;
    const t = this.terrain;
    const club = clubById(clubId);
    const lie = this.lie;
    const result = simulateShot(t, launch, { wind: st.wind, seed });
    const resolution = resolveShot(
      { terrain: t, par: t.par, strokes: hole.strokes, prevSpot: hole.ball, fromTee: hole.onTee, fromSurface: lie.surface },
      result,
    );
    for (const ev of result.events) {
      if (ev.type === 'launch') {
        ev.kind = club.kind;
        ev.club = club.id;
        ev.power = swingInfo.power;
      }
    }
    this.shot = { result, playT: 0, launch, clubId, seed, resolution, swing: swingInfo, from: copy3(hole.ball), next: 0, done: false };
    hole.strokes += 1;
    this._setPhase('flight');
    this._emit('shotStart', this.shot);
    this._emitEvents();
    return this.shot;
  }

  _emitEvents() {
    const sh = this.shot;
    const evs = sh.result.events;
    while (sh.next < evs.length && evs[sh.next].t <= sh.playT) this._emit('shotEvent', evs[sh.next++]);
  }

  update(dt) {
    if (this._announce) {
      this._announce = false;
      if (this.terrain) this._emit('hole', this.holeInfo());
      this._emit('phase', this.phase, null);
      if (this.phase === 'decision' && this.state.decision) this._emit('decision', this.state.decision);
    }
    if (!(dt > 0)) return;
    if (this.phase === 'flight' && this.shot) {
      this.shot.playT += dt;
      this._emitEvents();
      if (this.shot.playT >= this.shot.result.t + END_HOLD) this._finishShot();
    } else if (this.phase === 'holed') {
      this._holedT += dt;
      if (this._holedT >= HOLED_HOLD) this._toScorecard();
    }
  }

  _finishShot() {
    const sh = this.shot;
    const r = sh.resolution;
    const st = this.state;
    const hole = st.hole;
    sh.playT = Math.max(sh.playT, sh.result.t);
    this._emitEvents();
    sh.done = true;
    this._preShot = null;

    hole.strokes = r.strokes;
    hole.penalties += r.penalty;
    if (r.putt) hole.putts++;
    if (r.fir !== undefined) hole.fir = r.fir;
    if (r.gir) hole.gir = true;
    hole.last = { clubId: sh.clubId, carry: sh.result.carry, total: sh.result.total, outcome: r.outcome, label: sh.swing.label || '' };

    let next;
    let tone = 'info';
    if (r.holed || r.pickUp) {
      hole.done = true;
      hole.pickUp = r.pickUp;
      hole.ball = r.holed ? copy3(sh.result.final) : copy3(hole.ball);
      recordHole(st.card, st.holeIndex, { strokes: hole.strokes, putts: hole.putts, penalties: hole.penalties, fir: hole.fir, gir: hole.gir, pickUp: hole.pickUp });
      this._holedT = 0;
      next = 'holed';
    } else if (r.decision) {
      st.decision = clone(r.decision);
      hole.ball = copy3(r.ball);
      hole.onTee = false;
      next = 'decision';
      tone = 'over';
    } else {
      hole.ball = copy3(r.ball);
      hole.onTee = r.reTee;
      if (r.penalty) tone = 'over';
      this._newLie();
      next = 'address';
    }
    this.phase = next;
    st.phase = next;
    this._emit('shotEnd', { shot: sh, resolution: r });
    if (r.message) this._emit('message', { text: r.message, tone });
    this._emit('phase', next, 'flight');
    if (next === 'holed') this._emit('holed', this._holedInfo());
    else if (next === 'decision') this._emit('decision', st.decision);
  }

  _holedInfo() {
    const st = this.state;
    const h = st.card.holes[st.holeIndex];
    const name = h.pickUp ? 'Picked up' : scoreName(h.strokes, h.par);
    return { holeIndex: st.holeIndex, strokes: h.strokes, par: h.par, name, pickUp: h.pickUp, toPar: h.strokes - h.par, card: st.card, totals: totals(st.card) };
  }

  // Water relief choice: 'drop' (the relief spot) or 'replay' (from where the last shot was
  // played). The penalty stroke was already added when the ball went in.
  decide(option) {
    if (this.phase !== 'decision' || !this.state.decision) return false;
    const st = this.state;
    const d = st.decision;
    if (option === 'replay') {
      st.hole.ball = copy3(d.replay);
      st.hole.onTee = !!d.replayTee;
    } else {
      st.hole.ball = copy3(d.drop);
      st.hole.onTee = false;
    }
    st.decision = null;
    this._newLie();
    this._setPhase('address');
    return true;
  }

  _toScorecard() {
    if (this.state.holeIndex >= this.course.holes.length - 1) this._roundOver();
    else this._setPhase('scorecard');
  }

  _roundOver() {
    this._setPhase('roundOver');
    this._emit('roundOver', { card: this.state.card, totals: totals(this.state.card) });
  }

  // Tests and debugging: put the ball at (x, y) and address it (no stroke).
  debugPlace(x, y) {
    const st = this.state;
    st.hole.ball = { x, y, z: this.terrain.heightAt(x, y) + BALL_R };
    st.hole.onTee = false;
    st.decision = null;
    this.shot = null;
    this._preShot = null;
    this._newLie();
    this._setPhase('address');
  }

  // ------------------------------------------------------------------ save / restore

  // JSON-safe snapshot. A save taken during a flight stores the position before the shot plus
  // the launch and seed; restore() re-simulates it (physics is deterministic) and resolves it, so
  // quitting mid-flight cannot undo a stroke.
  serialize() {
    const flying = this.phase === 'flight' && this.shot && !this.shot.done && this._preShot;
    const data = clone(flying ? this._preShot : this.state);
    data.rng = this._rng.state();
    data.phase = flying ? 'address' : this.phase;
    data.pendingShot = flying ? { launch: this.shot.launch, seed: this.shot.seed, clubId: this.shot.clubId, swing: this.shot.swing } : null;
    return data;
  }

  // json: serialize() output (object or string). opts: {course, buildHole, terrain}.
  static restore(json, opts = {}) {
    const data = typeof json === 'string' ? JSON.parse(json) : clone(json);
    if (!data || data.v !== SAVE_VERSION || !data.hole || !Array.isArray(data.pins)) throw new Error('Game.restore: unsupported save');
    const g = new Game({ course: opts.course || COURSE, seed: data.seed, settings: data.settings, buildHole: opts.buildHole || defaultBuildHole });
    const pending = data.pendingShot;
    delete data.pendingShot;
    const phase = RESTORABLE.includes(data.phase) ? data.phase : 'address';
    g.state = data;
    g._rng = mulberry32(data.rng >>> 0);
    g.def = g.course.holes[data.holeIndex];
    g.terrain = opts.terrain || g.buildHole(g.def, { pinIndex: data.pins[data.holeIndex], seed: TREE_SEED });
    g.phase = phase;
    data.phase = phase;
    if (pending && phase === 'address') {
      g._preShot = clone(data);
      g._strike(pending.launch, pending.seed, pending.clubId, pending.swing || {});
      g._finishShot();
    }
    g._announce = true;
    return g;
  }
}

