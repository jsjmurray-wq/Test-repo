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
//   'roundOver' ({card, totals})  'message' ({text, tone:'info'|'over'}) for OB, water, pick-up
// A restored game re-announces 'hole', 'phase' (and 'decision') on its first update().
//
// Randomness: one mulberry32 stream (state.rng) feeds the swing contact scatter and the per-shot
// physics seed, so a restored save continues exactly as the original would have. Pins and wind
// derive from the round seed.
//
// Courses (docs/architecture.md section 8): Game({course}) plays course.holes and builds each hole
// with buildHole(def, {pinIndex, seed, course}), so the terrain carries the course's theme and
// conditions; a 'windy' course adds WINDY_EXTRA m/s to the Light and Breezy wind ranges. The save
// stores state.courseId; restore() picks the course from it (a save without one is Hollow Pines).
//
// Special shots (section 8.4, shots.js): state.shotType ('normal' by default, serialized) is the
// shot the next swing plays. setShot(id) only takes a shot that the club and lie allow
// (shotsAvailable()); it goes back to 'normal' after every stroke, on every new spot, and when the
// club changes to one that cannot play it. clubInfo(), carryForPower() and shotPreview() follow the
// selected shot (carry/total, the power curve with the side a draw or cut lands on, and the
// intended flight for the aim preview); the club table, suggestClub and playsLike stay the stock
// shot's (the caddie picks the club for a normal swing).
//
// Saves and best rounds (section 8.5): pure helpers for main.js, which owns the storage:
//   courseFromParam(value) -> course id | null       (?course=desert|water|links|pines)
//   saveCourseId(save) -> course id                  (the wrapper's or the game's; old saves: pines)
//   bestMap(raw) -> {[courseId]: {strokes, toPar, date}}   (an old single record counts as pines)
//   mergeBest(a, b) -> map: per course the newer record by date (stored vs in-memory copies)
//   recordBest(map, courseId, totals, holes) -> {map, best, isNew}   (complete rounds only)

import { COURSE } from './course.js';
import { courseById, COURSES, DEFAULT_COURSE_ID } from './courses.js';
import { buildHole as defaultBuildHole } from './terrain.js';
import { SURF, BALL_R, WINDY_EXTRA } from './constants.js';
import { mulberry32, randInt } from './rng.js';
import { clubById } from './clubs.js';
import { simulateShot } from './physics.js';
import { lieAt } from './lie.js';
import { swingToLaunch, PUTT_RANGES } from './swing.js';
import { clubTable, clubRow, suggestClub, playsLike, puttRange, powerCurve, curveAt, shotPreview } from './caddie.js';
import { shotsFor, isEligible } from './shots.js';
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
// (seed, hole, setting, course conditions) so a restored round and a replayed hole get the same
// wind. A windy course (conditions.wind === 'windy') adds WINDY_EXTRA m/s to both ends of the
// range (never to 'off').
export function windFor(seed, holeIndex, setting, conditions = null) {
  let [lo, hi] = WIND_RANGES[setting] || WIND_RANGES.light;
  if (hi <= 0) return { x: 0, y: 0 };
  if (conditions && conditions.wind === 'windy') {
    lo += WINDY_EXTRA;
    hi += WINDY_EXTRA;
  }
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
    this._curve = null;
    this._curveKey = '';
    this._shotRow = null;
    this._shotRowKey = '';
    this._preview = null;
    this._previewKey = '';
    const s = seed >>> 0;
    const pinRng = mulberry32(s ^ 0x51ed270b);
    this.state = {
      v: SAVE_VERSION,
      courseId: course.id || 'pines',
      seed: s,
      settings: { ...DEFAULT_SETTINGS, ...settings },
      pins: course.holes.map(() => randInt(pinRng, 3)),
      card: newCard(course),
      rng: (s ^ 0xa5a5a5a5) >>> 0,
      holeIndex: 0,
      hole: null,
      aimYaw: 0,
      clubId: 'D',
      shotType: 'normal',
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
    this.terrain = terrain || this.buildHole(this.def, { pinIndex: st.pins[i], seed: TREE_SEED, course: this.course });
    st.wind = windFor(st.seed, i, st.settings.wind, this.course.conditions);
    st.hole = newHoleState(this.terrain);
    st.decision = null;
    this.shot = null;
    this._preShot = null;
    this._holedT = 0;
    this._newLie();
    const prev = this.phase;
    this.phase = 'intro';
    st.phase = 'intro';
    this._emit('hole', this.holeInfo());
    this._emit('phase', 'intro', prev);
    return this.terrain;
  }

  holeInfo() {
    const t = this.terrain;
    return {
      index: this.state.holeIndex,
      courseId: this.state.courseId,
      courseName: this.course.name || '',
      theme: t.theme || 'parkland',
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
      st.wind = windFor(st.seed, st.holeIndex, st.settings.wind, this.course.conditions);
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

  // A club that cannot play the selected special shot puts it back to 'normal'.
  setClub(id) {
    const c = clubById(id);
    if (!c) return false;
    this.state.clubId = id;
    if (this.shotType !== 'normal' && (!this.state.hole || !isEligible(this.shotType, c, this.lie))) this.state.shotType = 'normal';
    return true;
  }

  // ------------------------------------------------------------------ special shots

  get shotType() {
    return this.state.shotType || 'normal';
  }

  // Eligible shot ids for the selected club and the lie ('normal' first; only 'normal' to putt).
  shotsAvailable() {
    return shotsFor(this.club, this.lie);
  }

  // Selects the shot the next swing plays; false (and no change) when the club or lie cannot play it.
  setShot(id) {
    if (!isEligible(id, this.club, this.lie)) return false;
    this.state.shotType = id;
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

  // Carry/total (m) of a club from here (with the selected special shot for the selected club), or
  // the putt range for the putter. landAngle: the descent angle (deg); shot: the shot it is for.
  clubInfo(id = this.state.clubId) {
    const c = clubById(id);
    if (!c) return null;
    if (c.kind === 'putter') return { id, name: c.name, carry: null, total: null, puttRange: this.state.puttRange, shot: 'normal' };
    const shot = id === this.state.clubId ? this.shotType : 'normal';
    const row = shot === 'normal' ? this.table.find((r) => r.id === id) : this._specialRow(id, shot);
    return { id, name: c.name, carry: row ? row.carry : null, total: row ? row.total : null, landAngle: row ? row.landAngle : null, shot: row ? row.shot : 'normal' };
  }

  // Club-table row of a special shot (cached per spot, club, shot and hand, like the table).
  _specialRow(id, shot) {
    const b = this.state.hole.ball;
    const w = this.state.wind;
    const handed = this.state.settings.handed;
    const key = `${b.x},${b.y},${w.x},${w.y},${id},${shot},${handed}`;
    if (!this._shotRow || this._shotRowKey !== key) {
      this._shotRow = clubRow(this.terrain, b, this.lie, w, id, { aimYaw: this.state.aimYaw, shot, handed });
      this._shotRowKey = key;
    }
    return this._shotRow;
  }

  // Expected carry/total (m) of the selected club and shot at a swing power, for the live power
  // readout, with side / sideTotal (m across the aim line, + = right: where a draw or cut lands and
  // stops); for the putter, the flat-roll distance. The curve is cached per spot, club and shot.
  carryForPower(power) {
    const c = this.club;
    if (c.kind === 'putter') return { carry: 0, total: power * this.state.puttRange, side: 0, sideTotal: 0 };
    const b = this.state.hole.ball;
    const w = this.state.wind;
    const handed = this.state.settings.handed;
    const key = `${b.x},${b.y},${w.x},${w.y},${c.id},${this.shotType},${handed}`;
    if (!this._curve || this._curveKey !== key) {
      this._curve = powerCurve(this.terrain, b, this.lie, w, c.id, this.state.aimYaw, { shot: this.shotType, handed });
      this._curveKey = key;
    }
    return curveAt(this._curve, power);
  }

  // Intended flight of the selected club and shot at a power along the current aim, over flat
  // ground with the wind (caddie.shotPreview: {path [t,x,y,z]*, carry, total, landing, final}), for
  // the curved aim preview of a draw or cut. null for the putter. Cached per spot, club, shot, aim
  // and power (to 0.01).
  shotPreview(power = 1) {
    const c = this.club;
    if (!c || c.kind === 'putter') return null;
    const b = this.state.hole.ball;
    const w = this.state.wind;
    const st = this.state;
    const p = Math.round(power * 100) / 100;
    const key = `${b.x},${b.y},${w.x},${w.y},${c.id},${this.shotType},${st.settings.handed},${st.aimYaw},${p}`;
    if (!this._preview || this._previewKey !== key) {
      this._preview = shotPreview(this.terrain, b, this.lie, w, c.id, st.aimYaw, { power: p, shot: this.shotType, handed: st.settings.handed });
      this._previewKey = key;
    }
    return this._preview;
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
    st.shotType = 'normal';
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
    const shot = club.kind === 'putter' || !isEligible(this.shotType, club, this.lie) ? 'normal' : this.shotType;
    const launch = swingToLaunch(club, this.lie, sw, st.aimYaw, this._rng, { pos: st.hole.ball, puttRange: st.puttRange, shot, handed: st.settings.handed });
    const seed = (this._rng() * 4294967296) >>> 0;
    st.rng = this._rng.state();
    this._preShot = clone(st);
    const swingInfo = { ok: true, kind: sw.kind, power: sw.power, startDir: sw.startDir, faceToPath: sw.faceToPath, tempo: sw.tempo, label: sw.label, shot };
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
    st.shotType = 'normal'; // a special shot is for one stroke
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
    hole.last = { clubId: sh.clubId, carry: sh.result.carry, total: sh.result.total, outcome: r.outcome, label: sh.swing.label || '', shot: sh.swing.shot || 'normal' };

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

  // json: serialize() output (object or string). opts: {course, buildHole, terrain}. Without
  // opts.course the course comes from data.courseId (older saves have none: Hollow Pines).
  static restore(json, opts = {}) {
    const data = typeof json === 'string' ? JSON.parse(json) : clone(json);
    if (!data || data.v !== SAVE_VERSION || !data.hole || !Array.isArray(data.pins)) throw new Error('Game.restore: unsupported save');
    const course = opts.course || courseById(data.courseId || 'pines');
    const g = new Game({ course, seed: data.seed, settings: data.settings, buildHole: opts.buildHole || defaultBuildHole });
    const pending = data.pendingShot;
    delete data.pendingShot;
    const phase = RESTORABLE.includes(data.phase) ? data.phase : 'address';
    data.courseId = course.id || 'pines';
    if (!data.shotType) data.shotType = 'normal'; // saves from before special shots
    g.state = data;
    g._rng = mulberry32(data.rng >>> 0);
    g.def = g.course.holes[data.holeIndex];
    g.terrain = opts.terrain || g.buildHole(g.def, { pinIndex: data.pins[data.holeIndex], seed: TREE_SEED, course });
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

// ------------------------------------------------------------------ saves and best rounds
// Pure helpers for main.js (which owns localStorage and the in-memory fallback), section 8.5.

// ?course= value -> a known course id, or null (unknown or missing: keep the menu's choice).
export function courseFromParam(value) {
  const v = String(value ?? '').trim().toLowerCase();
  return COURSES.some((c) => c.id === v) ? v : null;
}

// Course of a stored save {v, savedAt, courseId?, game}: the wrapper's id, else the game's; saves
// from before the course picker have neither and are Hollow Pines.
export function saveCourseId(save) {
  const id = (save && (save.courseId || (save.game && save.game.courseId))) || DEFAULT_COURSE_ID;
  return courseById(id).id;
}

const isRecord = (r) => !!r && typeof r === 'object' && Number.isFinite(r.strokes);

// Best rounds by course. golf.best.v1 used to hold one record {strokes, toPar, date} (Hollow Pines,
// the only course then); now it is a map {[courseId]: record}. Anything else is ignored.
export function bestMap(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  if (isRecord(raw)) {
    out[DEFAULT_COURSE_ID] = { strokes: raw.strokes, toPar: raw.toPar ?? 0, date: raw.date || 0 };
    return out;
  }
  for (const [id, r] of Object.entries(raw)) if (isRecord(r) && COURSES.some((c) => c.id === id)) out[id] = { strokes: r.strokes, toPar: r.toPar ?? 0, date: r.date || 0 };
  return out;
}

// Two copies of the best-round map (stored and in memory): per course, the newer record wins.
export function mergeBest(a, b) {
  const A = bestMap(a);
  const B = bestMap(b);
  const out = { ...A };
  for (const [id, r] of Object.entries(B)) if (!out[id] || (r.date || 0) > (out[id].date || 0)) out[id] = r;
  return out;
}

// Records a finished round on a course: only a complete round (totals.played >= holes) counts, and
// it is the new best when the course has none yet or it took fewer strokes. Returns the updated
// map (a copy), the course's best and whether this round set it.
export function recordBest(map, courseId, totals, holes, date = Date.now()) {
  const m = bestMap(map);
  const prev = m[courseId] || null;
  if (!totals || totals.played < holes) return { map: m, best: prev, isNew: false };
  const isNew = !prev || totals.strokes < prev.strokes;
  if (isNew) m[courseId] = { strokes: totals.strokes, toPar: totals.toPar, date };
  return { map: m, best: m[courseId], isNew };
}

