// App entry: wires the round state machine (game.js), renderer, camera rig, touch input, HUD,
// audio and the autoplay bot into one requestAnimationFrame loop. Everything else is a pure
// module or a small DOM module with its own API; this file only connects them.
//
// Flow: menu -> new round / resume -> per hole: intro flyover (tap to skip) -> address (aim by
// drag or Map tap, swing on the pad) -> flight playback -> address | relief decision | holed ->
// scorecard (the next hole is prebuilt while it shows) -> ... -> round over (final card, best
// round). The round is saved on every shot, hole and phase change (golf.save.v1, with an
// in-memory fallback when storage is blocked) so it survives Safari being closed.
//
// Swing (architecture.md section 8.1): with settings.swing = 'swipe' the pad gesture goes through
// input.js (live gauge) and interpretSwing; with 'tap' the pad runs a tap meter here (first tap
// starts it, the second hits). Either way the power arc carries a target notch: the power that
// reaches the pin (or the aim point when the pin is out of reach), from the inverse of the
// caddie's power curve; Easy snaps a power within 5% onto it.
//
// URL parameters
//   ?debug=1      fps / draw-call overlay
//   ?autoplay=1   the bot plays every hole; globalThis.__golfDone = {total, toPar, played} at the end
//   ?fast=N       playback speed (flight, intro, holed hold), e.g. 8
//   ?hole=N       start a new round at hole N (1-based)
//   ?seed=N       round seed (pins, wind, contact scatter); ?test=1 defaults it to 1
//   ?nogl=1       no WebGL: a NullRenderer stub keeps the logic and HUD running
//   ?test=1       renderer test mode (pixel read-back) and app.debug hooks for the e2e tests
//   ?quality=low  low-quality renderer regardless of the setting
// globalThis.__golf = app (debugging and tests).

import { Game, TREE_SEED } from './game.js';
import { COURSE, coursePar } from './course.js';
import { buildHole } from './terrain.js';
import { Renderer } from './render.js';
import { CameraRig, FLYOVER_T, fovForAspect } from './camera.js';
import { InputController, readSafeInsets, snapPower, meterPower, depthForPower, MAX_POWER } from './input.js';
import { UI, fmtToPar } from './ui.js';
import { AudioFX } from './audio.js';
import { interpretSwing, swingLabel, powerForDistance } from './swing.js';
import { RELEASE_K } from './caddie.js';
import { playBotShot, botDecide } from './bot.js';
import { CLUBS, clubById } from './clubs.js';
import { SURF, fmtDist, mToFt } from './constants.js';
import { clamp, DEG } from './vec3.js';

const SAVE_KEY = 'golf.save.v1';
const BEST_KEY = 'golf.best.v1';
const INTRO_HOLD = 1.2; // s the intro holds on the green after the flyover before play starts
const MAP_EXIT_S = 0.45; // after a Map tap, return to the address view this much later
const BOT_THINK_S = 0.6; // autoplay pause before each shot (game time)
const CUT_DIST = 60; // m: camera moves longer than this are hard cuts, not swoops
const PIN_ATTEND_M = 9; // m: putts longer than this keep the flagstick in (attended) at address
const MAX_DT = 0.1; // s: frame dt clamp (a stall must not skip half a shot)
const PUTT_PAST_M = 0.35; // m: the putt notch is the pace that dies this far past the cup (flat)
const MIN_TARGET = 0.04; // a target power below this (a tap-in) gets no notch

const params = new URLSearchParams(globalThis.location ? location.search : '');
const flag = (k) => params.has(k) && params.get(k) !== '0';
const DEBUG = flag('debug');
const AUTOPLAY = flag('autoplay');
const TEST = flag('test');
const NOGL = flag('nogl');
const FAST = clamp(parseFloat(params.get('fast')) || 1, 0.25, 50);
const START_HOLE = clamp((parseInt(params.get('hole'), 10) || 1) - 1, 0, COURSE.holes.length - 1);
const QUALITY = params.get('quality') === 'low' ? 'low' : null;
const SEED = params.has('seed') ? parseInt(params.get('seed'), 10) >>> 0 : TEST ? 1 : null;

// Stand-in for the WebGL renderer under ?nogl=1: same API, draws nothing, so the whole game
// (logic, HUD, input, saves) still runs where WebGL is missing (and in logic-only e2e runs).
class NullRenderer {
  constructor() {
    this.ok = true;
    this.isNull = true;
    this.terrain = null;
    this.cssW = 1;
    this.cssH = 1;
  }

  setHole(terrain) {
    this.terrain = terrain;
  }

  resize(w, h) {
    this.cssW = w;
    this.cssH = h;
  }

  project() {
    return { sx: 0, sy: 0, z: 1, visible: false };
  }

  pickTerrain() {
    return null;
  }

  draw() {}

  stats() {
    return { drawCalls: 0, tris: 0, renderScale: 1, ms: 0 };
  }

  debugPixel() {
    return [0, 0, 0, 0];
  }
}

const app = {
  ui: null,
  renderer: null,
  input: null,
  audio: null,
  rig: null,
  game: null,
  unsub: [],
  holeTerrain: null, // terrain currently uploaded to the renderer
  paused: false,
  drewPaused: false,
  view: 'play', // address sub-view: 'play' | 'read' | 'map' | 'flyover'
  viewT: 0,
  mapExitT: -1,
  introT: 0,
  swingPower: null, // live power while a swing is being drawn (moves the aim ring)
  targetPower: null, // power that reaches the pin / aim point (the arc's target notch), or null
  meter: null, // tap meter while it runs: {t0 (ms, event clock), kind:'full'|'putt'}
  trail: { data: new Float32Array(3 * 1024), count: 0 },
  hudDirty: false,
  hudT: 0,
  windRel: null,
  cssW: 1,
  cssH: 1,
  dpr: 1,
  sizeKey: '',
  lastTime: 0,
  time: 0,
  frameMs: 0,
  fps: 60,
  wakeLock: null,
  bot: { phase: null, wait: 0, busy: false },
  hintTimer: 0,
  customHint: false,
  errors: 0,
  lastScene: null,
  params: { DEBUG, AUTOPLAY, TEST, NOGL, FAST, START_HOLE, QUALITY, SEED },
  debug: null,
};

// ------------------------------------------------------------------ terrain cache
// buildHole is deterministic per (hole, pin, seed); keep the last few so the menu backdrop, the
// prebuilt next hole and a restored round never build the same terrain twice.
const terrainCache = new Map();
function cachedBuildHole(def, opts = {}) {
  const key = `${def.n}:${opts.pinIndex ?? 0}:${opts.seed ?? 1}`;
  let t = terrainCache.get(key);
  if (!t) {
    t = buildHole(def, opts);
    terrainCache.set(key, t);
    while (terrainCache.size > 3) terrainCache.delete(terrainCache.keys().next().value);
  }
  return t;
}

// ------------------------------------------------------------------ persistence
// localStorage can be missing or throw (private browsing, sandboxed iframes), so the latest save
// is also kept in memory: "Resume" then still works for the rest of the session.
let memSave = null;
let memBest = null;

function saveGame() {
  const g = app.game;
  if (!g || AUTOPLAY || !g.phase) return;
  if (g.phase === 'roundOver') {
    clearSave(); // nothing to resume once the round is over
    return;
  }
  memSave = JSON.stringify({ v: 1, savedAt: Date.now(), game: g.serialize() });
  try {
    localStorage.setItem(SAVE_KEY, memSave);
  } catch {
    // In-memory copy only (quota full, storage blocked). Drop the stored copy, which is now
    // stale (removing needs no quota), so it can never be resumed instead of this one.
    try {
      localStorage.removeItem(SAVE_KEY);
    } catch {
      /* ignore */
    }
  }
}

const parse = (raw) => {
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};
// The newer of two saved records by their timestamp field (either may be null).
const newer = (a, b, key) => (!a ? b : !b ? a : (b[key] || 0) > (a[key] || 0) ? b : a);

function loadSave() {
  let stored = null;
  try {
    stored = parse(localStorage.getItem(SAVE_KEY));
  } catch {
    /* fall back to the in-memory copy */
  }
  return newer(stored, parse(memSave), 'savedAt');
}

function clearSave() {
  memSave = null;
  try {
    localStorage.removeItem(SAVE_KEY);
  } catch {
    /* ignore */
  }
}

function loadBest() {
  let stored = null;
  try {
    stored = parse(localStorage.getItem(BEST_KEY));
  } catch {
    /* fall back to memory */
  }
  return newer(stored, memBest, 'date');
}

// Records a completed nine; returns {best, isNew}.
function recordBest(tot) {
  const prev = loadBest();
  if (tot.played < COURSE.holes.length || AUTOPLAY) return { best: prev, isNew: false };
  const isNew = !prev || tot.strokes < prev.strokes;
  if (isNew) {
    memBest = { strokes: tot.strokes, toPar: tot.toPar, date: Date.now() };
    try {
      localStorage.setItem(BEST_KEY, JSON.stringify(memBest));
    } catch {
      /* memory only */
    }
  }
  return { best: isNew ? memBest : prev, isNew };
}

// ------------------------------------------------------------------ formatting
const units = () => app.ui.getSetting('units');
const fmtLong = (m) => fmtDist(m, units());
const fmtShort = (m) => fmtDist(m, units(), { short: true });
// Putt range and roll: feet in yard mode at any length (a 24 m range reads "79 ft", not "26 yd").
const fmtPutt = (m) => (units() === 'm' ? `${m < 10 ? m.toFixed(1) : Math.round(m)} m` : `${Math.round(mToFt(m))} ft`);

function gameSettings() {
  const s = app.ui.settings;
  return { wind: s.wind, difficulty: s.difficulty, units: s.units, handed: s.handed };
}

// ------------------------------------------------------------------ layout
function resize() {
  const canvas = app.renderer.canvas || document.getElementById('gl');
  const r = canvas.getBoundingClientRect();
  const vv = globalThis.visualViewport;
  const w = Math.max(1, Math.round(r.width || (vv ? vv.width : innerWidth)));
  const h = Math.max(1, Math.round(r.height || (vv ? vv.height : innerHeight)));
  const dpr = globalThis.devicePixelRatio || 1;
  // iOS can leave the page scrolled after a rotation or toolbar change; the game never scrolls.
  if (vv && (vv.offsetTop || vv.pageTop) && globalThis.scrollTo) globalThis.scrollTo(0, 0);
  // The safe-area insets are part of the key: flipping an iPhone from landscape-left to
  // landscape-right swaps them without changing the size, and the swing pad must move too.
  const ins = readSafeInsets();
  const key = `${w}x${h}@${dpr}:${ins.top},${ins.right},${ins.bottom},${ins.left}`;
  if (key === app.sizeKey) return;
  app.sizeKey = key;
  app.cssW = w;
  app.cssH = h;
  app.dpr = dpr;
  app.renderer.resize(w, h, dpr);
  app.input.resize();
  app.ui.applyLayout();
  app.ui.setPadRect(app.input.padRect);
  app.drewPaused = false;
}

// ------------------------------------------------------------------ helpers
const menuOpen = () => !app.ui.el.menu.hidden;

function onGreenish(g) {
  const s = g.lie.surface;
  return s === SURF.GREEN || s === SURF.FRINGE;
}

// Ball position the camera follows. During a putt the camera stays where the putt was struck
// (a fixed shot down the line, the ball rolling away from it).
function rigBall(g) {
  if (g.phase === 'flight' && g.shot && g.shot.launch.mode === 'roll') return g.shot.from;
  return g.ballPos();
}

function camCtx() {
  const g = app.game;
  const t = g.terrain;
  // Address framing follows the club's stock carry (not the live gauge, so the view holds still
  // during the swing); in landscape the view centre shifts onto the swing pad (lens shift).
  const carry = g.phase === 'address' && !g.isPutt ? g.clubInfo().carry || 100 : undefined;
  const pad = app.input.padRect;
  const padShift = app.cssW > app.cssH * 1.25 ? (2 * (pad.x + pad.w / 2)) / app.cssW - 1 : 0;
  return { ball: rigBall(g), aimYaw: g.aimYaw, cup: t.cup, terrain: t, shot: g.shot, aspect: app.cssW / app.cssH, carry, padShift, relief: g.state.decision };
}

// Switch the camera mode; long moves are hard cuts (a swoop through trees looks wrong).
function camMode(mode, ctx = camCtx()) {
  const rig = app.rig;
  const prev = rig.mode;
  rig.setMode(mode, ctx);
  const b = ctx.ball;
  if (b && (prev === 'flight' || prev === 'holed' || prev === 'flyover') && Math.hypot(rig.eye.x - b.x, rig.eye.y - b.y) > CUT_DIST) rig.snap = true;
}

function setHint(text, ms = 1800) {
  app.ui.setHint(text);
  app.customHint = !!text;
  syncHinted();
  clearTimeout(app.hintTimer);
  if (text) {
    app.hintTimer = setTimeout(() => {
      app.ui.setHint(null);
      app.customHint = false;
      syncHinted();
    }, ms);
  }
}

// After the first putt on a hole the idle putt hint is hidden (it would sit over the cup); a
// message such as "Putt cancelled" still shows.
function syncHinted() {
  const g = app.game;
  const on = !!g && g.phase && g.isPutt && g.state.hole.putts > 0 && !app.customHint;
  app.ui.el.hud.dataset.hinted = on ? '1' : '0';
}

function closeDialogs() {
  const ui = app.ui;
  ui.hideScorecard();
  ui.el.decision.hidden = true;
  ui.hideIntro();
  ui.setPower(null);
}

// ------------------------------------------------------------------ HUD
function refreshHud() {
  const g = app.game;
  if (!g || !g.terrain || !g.phase) return;
  const st = g.state;
  const lie = g.lie;
  const w = g.wind;
  app.ui.setHud({
    strokes: st.hole.strokes,
    toPar: g.totals().toPar,
    distToPin: g.distanceToCup(),
    playsLike: g.phase === 'address' ? g.playsLike() : null,
    lieLabel: lie.label,
    lieSurface: lie.surface,
    windSpeed: Math.hypot(w.x, w.y),
  });
  app.hudDirty = false;
}

function refreshClub() {
  const g = app.game;
  if (!g || !g.terrain || !g.phase) return;
  const c = g.club;
  if (c.kind === 'putter') {
    app.ui.setClub({ name: c.name, sub: `Range ${fmtPutt(g.puttRange)}` });
  } else {
    const info = g.clubInfo();
    app.ui.setClub({ name: c.name, carry: info.carry, total: info.total });
  }
  app.targetPower = targetPower(g);
  app.ui.setTarget(app.targetPower);
  syncControls();
}

// Power that reaches the target from here with the selected club: the pin, or the aim point when
// the pin is out of reach at full power; null when neither is (or for a tap-in). Full swings use
// the inverse of the caddie's power curve on the "expected finish" (carry plus most of the
// release, as the caddie picks clubs), with the height difference over the club's descent angle
// added like the plays-like distance (the curve already has the wind). Putts: the flat-roll pace
// that dies PUTT_PAST_M past the cup.
function targetPower(g) {
  if (!g || g.phase !== 'address' || !g.terrain) return null;
  if (g.isPutt) {
    const p = (g.distanceToCup() + PUTT_PAST_M) / g.puttRange;
    return p >= MIN_TARGET && p <= MAX_POWER ? p : null;
  }
  const t = g.terrain;
  const b = g.state.hole.ball;
  const row = g.table.find((r) => r.id === g.club.id);
  const tanDescent = Math.tan(Math.max(20, row ? row.landAngle : 45) * DEG);
  const finish = (p) => {
    const d = g.carryForPower(p);
    return d.carry + RELEASE_K * Math.max(0, d.total - d.carry);
  };
  const zBall = t.heightAt(b.x, b.y);
  for (const target of [t.cup, t.aimPoint(b)]) {
    const dist = Math.hypot(target.x - b.x, target.y - b.y) + (t.heightAt(target.x, target.y) - zBall) / tanDescent;
    const p = powerForDistance(finish, dist, 1);
    if (p != null) return p >= MIN_TARGET ? p : null;
  }
  return null;
}

function syncControls() {
  const g = app.game;
  if (!g || !g.phase) return;
  const flyover = app.view === 'flyover';
  app.ui.setControls({
    phase: flyover ? 'intro' : g.phase,
    putt: g.isPutt,
    canRead: g.phase === 'address' && onGreenish(g),
    read: app.view === 'read',
    map: app.view === 'map',
    puttRange: fmtPutt(g.puttRange),
  });
  syncHinted();
}

function updateInputMode() {
  const g = app.game;
  const input = app.input;
  let m = 'disabled';
  if (g && !app.paused && !menuOpen()) {
    if (AUTOPLAY) {
      m = g.phase === 'flight' || g.phase === 'holed' || g.phase === 'intro' ? 'watch' : 'disabled';
    } else {
      switch (g.phase) {
        case 'intro':
          m = 'intro';
          break;
        case 'address':
          if (app.view === 'read') m = 'read';
          else if (app.view === 'map') m = 'map';
          else if (app.view === 'flyover') m = 'intro';
          else m = g.isPutt ? 'putt' : 'full';
          break;
        case 'flight':
        case 'holed':
          m = 'watch';
          break;
        default:
          m = 'disabled';
      }
    }
  }
  input.setMode(m);
}

// ------------------------------------------------------------------ address sub-views
function setView(v) {
  const g = app.game;
  if (!g || g.phase !== 'address') return;
  const prev = app.view;
  cancelMeter();
  app.view = v;
  app.viewT = 0;
  app.mapExitT = -1;
  const ctx = camCtx();
  if (v === 'read' || v === 'map') camMode(v, ctx);
  else if (v === 'flyover') {
    camMode('flyover', ctx);
    showIntroCard(g);
  } else {
    if (prev === 'flyover') {
      app.ui.hideIntro();
      app.rig.snap = true; // cut back to the ball like TV
    }
    camMode(g.isPutt ? 'putt' : 'address', ctx);
  }
  syncControls();
  updateInputMode();
}

function showIntroCard(g) {
  const t = g.terrain;
  app.ui.showIntro({ hole: t.n, name: t.name, par: t.par, lengthM: t.lengthM, si: t.si });
}

function enterAddress() {
  const g = app.game;
  app.view = 'play';
  app.mapExitT = -1;
  app.swingPower = null;
  app.meter = null;
  app.ui.hideIntro();
  camMode(g.isPutt ? 'putt' : 'address');
  // Warm the caddie's power curve now (8 short simulations) so the first move of the swing
  // gauge does not hitch.
  g.carryForPower(0.5);
  refreshClub();
  refreshHud();
}

function changeClub(dir) {
  const g = app.game;
  if (!g || g.phase !== 'address') return;
  const ids = CLUBS.map((c) => c.id);
  const i = clamp(ids.indexOf(g.state.clubId) + dir, 0, ids.length - 1);
  if (ids[i] === g.state.clubId) return;
  cancelMeter();
  const wasPutt = g.isPutt;
  g.setClub(ids[i]);
  if (g.isPutt !== wasPutt) setView('play'); // putt camera <-> address camera, pad mode
  g.carryForPower(0.5);
  refreshClub();
  refreshHud();
  updateInputMode();
}

// ------------------------------------------------------------------ game lifecycle
function bindGame(game) {
  for (const off of app.unsub) off();
  app.game = game;
  app.paused = false;
  app.view = 'play';
  app.trail.count = 0;
  app.bot = { phase: null, wait: 0, busy: false };
  app.unsub = [
    game.on('hole', onHole),
    game.on('phase', onPhase),
    game.on('shotEvent', onShotEvent),
    game.on('shotEnd', onShotEnd),
    game.on('decision', onDecision),
    game.on('holed', onHoled),
    game.on('roundOver', onRoundOver),
    game.on('message', ({ text }) => app.ui.toast(text, 3000)),
  ];
  app.ui.showHud(true);
  requestWakeLock();
}

function unbindGame() {
  for (const off of app.unsub) off();
  app.unsub = [];
  app.game = null;
  app.paused = false;
  app.view = 'play';
  app.trail.count = 0;
}

function newRound() {
  closeDialogs();
  app.ui.hideMenu();
  app.ui.hidePause();
  const seed = SEED ?? ((Date.now() ^ Math.floor(Math.random() * 0x7fffffff)) >>> 0);
  const game = new Game({ seed, settings: gameSettings(), buildHole: cachedBuildHole });
  bindGame(game);
  game.loadHole(START_HOLE);
  saveGame();
  updateInputMode();
}

function resumeGame() {
  const save = loadSave();
  closeDialogs();
  if (!save || !save.game) {
    showMenu();
    return;
  }
  try {
    const game = Game.restore(save.game, { buildHole: cachedBuildHole });
    bindGame(game);
    game.setSettings(gameSettings());
    // The game re-announces 'hole', 'phase' (and a pending 'decision') on its first update().
    game.update(0);
    updateInputMode();
  } catch (err) {
    console.warn('Could not restore the saved round', err);
    clearSave();
    unbindGame();
    showMenu();
  }
}

function quitToMenu() {
  saveGame();
  unbindGame();
  closeDialogs();
  app.ui.hidePause();
  showMenu();
  releaseWakeLock();
  updateInputMode();
}

function showMenu() {
  const best = loadBest();
  app.ui.showHud(false);
  app.ui.showMenu({
    canResume: !!loadSave(),
    courseName: COURSE.name,
    courseSub: `${COURSE.holes.length} holes · Par ${coursePar()}${best ? ` · Best ${best.strokes} (${fmtToPar(best.toPar)})` : ''}`,
  });
  updateInputMode();
}

function setPaused(on) {
  app.paused = !!on;
  app.drewPaused = false;
  app.lastTime = 0;
  if (on) {
    app.meter = null;
    app.ui.setPower(null);
    saveGame();
  }
  updateInputMode();
}

// ------------------------------------------------------------------ game events
function onHole(info) {
  const t = info.terrain;
  if (app.holeTerrain !== t) {
    app.renderer.setHole(t);
    app.holeTerrain = t;
  }
  app.trail.count = 0;
  app.windRel = null;
  app.rig.snap = true;
  app.ui.setHud({ hole: info.n, par: info.par, lengthM: info.lengthM, si: info.si });
  app.audio.setWind(Math.hypot(info.wind.x, info.wind.y));
  refreshHud();
}

function onPhase(phase, prev) {
  const g = app.game;
  const ui = app.ui;
  app.swingPower = null;
  app.meter = null;
  switch (phase) {
    case 'intro':
      app.view = 'play';
      app.introT = 0;
      ui.hideScorecard();
      showIntroCard(g);
      camMode('flyover');
      app.rig.snap = true;
      break;
    case 'address':
      enterAddress();
      break;
    case 'flight': {
      ui.hideIntro();
      app.trail.count = 0;
      ui.setHud({ strokes: g.state.hole.strokes, playsLike: null });
      // Putts keep the low putt camera fixed at the ball's start; full shots get the TV sequence.
      if (g.shot && g.shot.launch.mode !== 'roll') camMode('flight', { ...camCtx(), ball: g.shot.from });
      break;
    }
    case 'holed':
      camMode('holed');
      break;
    case 'decision':
      // Look down on where it went in and where the drop would be before the choice.
      camMode('relief');
      break;
    case 'scorecard':
      ui.showScorecard(g.state.card, { current: g.state.holeIndex });
      // Prebuild the next hole's terrain while the card is up (about 0.1-0.2 s of CPU).
      setTimeout(() => prebuildNext(g), 150);
      break;
    case 'roundOver':
      // A restored finished round (the live 'roundOver' event shows its own card).
      if (prev == null) showFinalCard(g.state.card, g.totals(), { best: loadBest(), isNew: false });
      break;
    default:
      break;
  }
  if (phase !== 'flight') refreshHud();
  syncControls();
  updateInputMode();
  if (phase === 'intro' || phase === 'address' || phase === 'decision' || phase === 'scorecard') saveGame();
}

function prebuildNext(g) {
  if (app.game !== g || g.phase !== 'scorecard') return;
  const i = g.state.holeIndex + 1;
  if (i < COURSE.holes.length) cachedBuildHole(COURSE.holes[i], { pinIndex: g.state.pins[i], seed: TREE_SEED });
}

function onShotEvent(ev) {
  app.audio.handle(ev);
  if (ev.type === 'lipout') app.ui.toast('Lip out', 1600);
}

function onShotEnd({ shot, resolution: r }) {
  if (!r.holed) {
    const c = clubById(shot.clubId);
    const res = shot.result;
    if (shot.launch.mode === 'roll') {
      const left = app.game.distanceToCup();
      app.ui.toast(`${c.name} · ${fmtPutt(res.total)} · ${fmtShort(left)} left`, 2600);
    } else {
      app.ui.toast(`${clubShort(c)} · ${fmtPair(res.carry, res.total)} · ${shotLabel(shot)}`, 3400);
    }
  }
  saveGame();
}

// Short club names for toasts ("PW", "7i"; the driver keeps its name).
const clubShort = (c) => (c.id === 'D' ? 'Driver' : c.short);
// "105/122 yd": carry / total in one segment.
const fmtPair = (a, b) => `${fmtLong(a).split(' ')[0]}/${fmtLong(b)}`;

// What the swipe did, and separately what random contact added: a straight swipe that the
// contact scatter pulled reads "Straight → pull", so the player is not blamed for the dice.
function shotLabel(shot) {
  const handed = app.ui.getSetting('handed');
  const m = shot.launch.meta;
  const actual = swingLabel(m.startDirDeg || 0, m.faceToPathDeg || 0, handed);
  const sw = shot.swing;
  if (!sw || sw.kind !== 'full') return actual;
  const swipe = swingLabel(sw.startDir || 0, sw.faceToPath || 0, handed);
  let label = swipe === actual ? swipe : `${swipe} → ${actual.toLowerCase()}`;
  if (sw.tempo === 'rushed') label += ', rushed';
  else if (sw.tempo === 'decel') label += ', decel';
  return label;
}

function onDecision(d) {
  const g = app.game;
  if (AUTOPLAY) return; // the bot decides in tickBot
  const yellow = d.waterKind === 'yellow';
  const lateral = d.relief === 'lateral';
  app.ui
    .showDecision({
      kicker: 'Penalty · 1 stroke',
      title: yellow ? 'In the water' : 'In the penalty area',
      text: 'Take a drop, or replay from where you last played.',
      options: [
        { id: 'drop', label: 'Drop', detail: lateral ? '+1 · within two club lengths of where it crossed' : '+1 · back on the line from the hole, on level ground' },
        { id: 'replay', label: d.replayTee ? 'Re-tee' : 'Replay', detail: d.replayTee ? '+1 · play again from the tee' : '+1 · from where you last played' },
      ],
    })
    .then((id) => {
      if (id && app.game === g && g.phase === 'decision') {
        g.decide(id);
        saveGame();
      }
    });
}

function onHoled(info) {
  const tone = info.pickUp ? 'over' : info.strokes === 1 ? 'ace' : info.toPar < 0 ? 'under' : info.toPar === 0 ? 'par' : 'over';
  const sub = info.pickUp ? `Hole ${info.holeIndex + 1} · ${info.strokes}` : `${info.strokes} ${info.strokes === 1 ? 'stroke' : 'strokes'} · Total ${fmtToPar(info.totals.toPar)}`;
  app.ui.banner(info.name, sub, { tone, ms: 2600 });
  if (!info.pickUp) {
    const strength = info.strokes === 1 || info.toPar <= -2 ? 1 : info.toPar === -1 ? 0.75 : info.toPar === 0 ? 0.35 : 0;
    if (strength > 0) app.audio.handle({ type: 'applause', strength });
  }
  refreshHud();
}

function onRoundOver({ card, totals }) {
  const best = recordBest(totals);
  clearSave();
  showFinalCard(card, totals, best);
  if (AUTOPLAY) globalThis.__golfDone = { total: totals.strokes, toPar: totals.toPar, played: totals.played, pickUps: totals.pickUps };
}

function showFinalCard(card, totals, { best, isNew }) {
  const kicker = isNew ? 'New best round!' : best ? `Round complete · Best ${best.strokes} (${fmtToPar(best.toPar)})` : 'Round complete';
  app.ui.showScorecard(card, { final: true, kicker, title: `${totals.strokes} strokes · ${fmtToPar(totals.toPar)}` });
}

// ------------------------------------------------------------------ input callbacks
function onAim(dyaw) {
  const g = app.game;
  if (!g || g.phase !== 'address' || app.paused) return;
  g.setAim(g.aimYaw + dyaw);
  app.hudDirty = true;
}

// Live gauge: the arc, the carry (or roll) readout and the aim ring at this power. On Easy a power
// within 5% of the target notch snaps onto it, here and in the struck swing alike.
function showPower(rawPower) {
  const g = app.game;
  const power = snapPower(rawPower, app.targetPower, app.ui.getSetting('difficulty'));
  app.swingPower = power;
  const d = g.carryForPower(power);
  const carryText = g.isPutt ? fmtPutt(d.total) : fmtLong(d.carry);
  app.ui.setPower({ power, overswing: power > 1, full: !g.isPutt && power === 1, carryText, target: app.targetPower });
}

function onSwingProgress(p) {
  const g = app.game;
  if (!g || g.phase !== 'address') return;
  showPower(p.power);
}

function onSwing(samples) {
  const g = app.game;
  app.swingPower = null;
  app.ui.setPower(null);
  if (!g || g.phase !== 'address' || app.paused) return;
  const s = app.ui.settings;
  const sw = interpretSwing(samples, {
    padRefH: app.input.padRefH,
    kind: g.isPutt ? 'putt' : 'full',
    difficulty: s.difficulty,
    handed: s.handed,
    club: g.club,
    target: app.targetPower,
    padRect: app.input.padRect,
  });
  if (TEST) app.lastSwing = { samples, sw, padRefH: app.input.padRefH };
  if (!sw.ok) {
    if (sw.reason === 'cancel') {
      if (g.isPutt) setHint('Putt cancelled', 2200);
      else app.ui.toast('Swing cancelled — swipe up to hit', 2200);
    }
    return;
  }
  strike(g, sw);
}

function strike(g, sw) {
  if (sw.kind === 'full') app.audio.handle({ type: 'swing', power: sw.power });
  g.swing(sw);
}

// The swipe was abandoned before the release: dragged out of the pad sideways, or the system
// took the touch (pointercancel). A mode change also ends up here, silently.
function onSwingCancel(reason) {
  app.swingPower = null;
  app.ui.setPower(null);
  const g = app.game;
  if ((reason === 'dragOut' || reason === 'pointercancel') && g && g.phase === 'address' && !app.paused) {
    if (g.isPutt) setHint('Putt cancelled', 2200);
    else app.ui.toast('Swing cancelled', 1800);
  }
}

// ------------------------------------------------------------------ tap meter
// settings.swing = 'tap': the first tap in the pad starts a power bar (input.js meterPower: it
// fills 0 -> 1.1 over 1.4 s, hanging briefly at full power, then falls back); the second tap
// hits at the bar's power, timed on the events' own clock. Straight: no direction or curve from
// a tap, but the usual contact scatter applies. Putts use the putt range the same way.
function onPadTap({ t }) {
  const g = app.game;
  if (!g || g.phase !== 'address' || app.paused) return;
  const nowMs = performance.now();
  // Event times share performance.now()'s clock in current browsers; fall back if one does not.
  const at = Number.isFinite(t) && Math.abs(t - nowMs) < 5000 ? t : nowMs;
  const kind = g.isPutt ? 'putt' : 'full';
  if (!app.meter || app.meter.kind !== kind) {
    app.meter = { t0: at, kind };
    app.ui.setHint(null);
    tickMeter(nowMs);
    return;
  }
  const raw = meterPower((at - app.meter.t0) / 1000, kind);
  cancelMeter();
  if (raw == null) {
    setHint('Too late · tap to start again', 2200);
    return;
  }
  const power = snapPower(raw, app.targetPower, app.ui.getSetting('difficulty'));
  const sw = { ok: true, kind, power, overswing: power > 1, startDir: 0, faceToPath: 0, face: 0, path: 0, tempo: 'smooth', tempoErr: 0, label: 'Tap swing' };
  if (TEST) app.lastSwing = { samples: null, sw, padRefH: app.input.padRefH, tap: true };
  strike(g, sw);
}

// Per frame while the meter runs: show its power; once it has fallen back, abandon it.
function tickMeter(nowMs) {
  const m = app.meter;
  const p = meterPower((nowMs - m.t0) / 1000, m.kind);
  if (p == null) {
    cancelMeter();
    setHint('Too late · tap to start again', 2200);
    return;
  }
  showPower(p);
}

function cancelMeter() {
  if (!app.meter) return;
  app.meter = null;
  app.swingPower = null;
  app.ui.setPower(null);
}

function onTap(sx, sy) {
  const g = app.game;
  if (!g || g.phase !== 'address' || app.view !== 'map') return;
  const p = app.renderer.pickTerrain(sx, sy);
  if (!p) return;
  const b = g.state.hole.ball;
  g.setAim(Math.atan2(p.y - b.y, p.x - b.x));
  app.hudDirty = true;
  app.mapExitT = MAP_EXIT_S; // let the aim line visibly snap, then return to the ball
}

function onSkip() {
  const g = app.game;
  if (!g || app.paused) return;
  if (app.view === 'flyover') {
    setView('play');
    return;
  }
  g.skip();
}

// ------------------------------------------------------------------ autoplay bot
function tickBot(dt) {
  const g = app.game;
  const b = app.bot;
  if (b.phase !== g.phase) {
    b.phase = g.phase;
    b.wait = 0;
  }
  if (b.busy) return;
  b.wait += dt;
  if (g.phase === 'address' && b.wait >= BOT_THINK_S) {
    // Planning takes a few hundred ms: run it outside the frame so the last frame shows first.
    b.busy = true;
    setTimeout(() => {
      b.busy = false;
      b.wait = 0;
      if (app.game !== g || g.phase !== 'address' || app.paused) return;
      const r = playBotShot(g);
      if (r.ok && r.plan.swing.kind === 'full') app.audio.handle({ type: 'swing', power: r.plan.swing.power });
    }, 0);
  } else if (g.phase === 'decision' && b.wait >= 0.5) {
    botDecide(g);
    saveGame();
  } else if (g.phase === 'scorecard' && b.wait >= 0.8) {
    g.nextHole();
  }
}

// ------------------------------------------------------------------ frame
function tick(dt) {
  const g = app.game;
  if (!g || app.paused) return;
  const sdt = dt * FAST;
  if (g.phase === 'intro') {
    app.introT += sdt;
    if (app.introT >= FLYOVER_T + INTRO_HOLD) g.skipIntro();
  } else if (g.phase === 'address') {
    if (app.view === 'flyover') {
      app.viewT += sdt;
      if (app.viewT >= FLYOVER_T + INTRO_HOLD) setView('play');
    } else if (app.view === 'map' && app.mapExitT >= 0) {
      app.mapExitT -= dt;
      if (app.mapExitT < 0) setView('play');
    }
  }
  g.update(sdt);
  if (app.meter && app.game === g && g.phase === 'address') tickMeter(performance.now());
  if (AUTOPLAY && app.game === g) tickBot(sdt);
}

// Shot trail: the recorded path up to the playback time, ending at the interpolated ball.
function buildTrail(g) {
  const sh = g.shot;
  if (!sh || sh.launch.mode === 'roll') return null;
  if (g.phase !== 'flight' && g.phase !== 'holed' && g.phase !== 'decision') return null;
  const path = sh.result.path;
  const n = path.length / 4;
  const tNow = g.phase === 'flight' ? sh.playT : Infinity;
  let k = 0;
  while (k < n && path[k * 4] <= tNow) k++;
  const tr = app.trail;
  if (tr.data.length < (k + 1) * 3) tr.data = new Float32Array((k + 64) * 3 * 2);
  const d = tr.data;
  for (let i = 0; i < k; i++) {
    d[i * 3] = path[i * 4 + 1];
    d[i * 3 + 1] = path[i * 4 + 2];
    d[i * 3 + 2] = path[i * 4 + 3];
  }
  let count = k;
  if (g.phase === 'flight' && k < n) {
    const b = g.ballPos();
    d[count * 3] = b.x;
    d[count * 3 + 1] = b.y;
    d[count * 3 + 2] = b.z;
    count++;
  }
  tr.count = count;
  return count > 1 ? tr : null;
}

function buildScene(time, cam) {
  const g = app.game;
  const scene = { time, cam, ball: null, trail: null, aim: null, pin: { visible: true }, wind: { x: 0, y: 0 }, read: { on: false } };
  if (!g || !g.phase) return scene;
  const phase = g.phase;
  const b = g.ballPos();
  // At address the camera may sit well back and up for a long shot: keep the ball readable.
  const reading = phase === 'address' && app.view === 'read';
  // In the relief decision the ball is shown at the drop spot (that is where it will be played).
  scene.ball = { x: b.x, y: b.y, z: b.z, visible: true, minPx: reading ? 4.5 : phase === 'decision' ? 5 : phase === 'address' ? 3.5 : 2.5 };
  scene.wind = g.wind;
  scene.trail = buildTrail(g);
  const putting = g.isPutt;
  const rollShot = !!g.shot && g.shot.launch.mode === 'roll';
  // Flagstick out for putts (physics plays putts with the pin out too), and it stays out after a
  // holed putt while the scorecard is up. On a long putt it is attended until the stroke, so the
  // hole can be seen from 10+ m.
  const attended = phase === 'address' && putting && g.distanceToCup() > PIN_ATTEND_M;
  // Reading the green from above, the flag marks the hole (the cup alone is a dot).
  scene.pin.visible = attended || reading || !((phase === 'address' && putting) || ((phase === 'flight' || phase === 'holed' || phase === 'scorecard') && rollShot));
  if (phase === 'address' && (app.view === 'play' || app.view === 'map' || (reading && putting))) {
    if (putting) {
      // Putt line: thin, close to the turf, short dashes, and a small ring at the flat-roll
      // distance while the putter is drawn back (at the cup otherwise).
      const carry = app.swingPower != null ? app.swingPower * g.puttRange : g.distanceToCup();
      scene.aim = { x: b.x, y: b.y, z: b.z, yaw: g.aimYaw, carry: Math.max(0.3, carry), ring: 0.2, width: 0.012, lift: 0.008, dash: 0.45 };
    } else {
      const carry = app.swingPower != null ? g.carryForPower(app.swingPower).carry : g.clubInfo().carry || 100;
      scene.aim = { x: b.x, y: b.y, z: b.z, yaw: g.aimYaw, carry: Math.max(1, carry) };
    }
  }
  const dec = phase === 'decision' ? g.state.decision : null;
  if (dec && dec.entry && dec.drop) {
    // Dashed line from where it went in to the drop spot, ringed.
    const e = dec.entry;
    const d = dec.drop;
    const len = Math.hypot(d.x - e.x, d.y - e.y);
    scene.aim = { x: e.x, y: e.y, z: d.z, yaw: Math.atan2(d.y - e.y, d.x - e.x), carry: Math.max(0.3, len), ring: 1.2, dash: 1.2 };
  }
  if (phase === 'address' && (app.view === 'read' || (putting && app.view === 'play'))) {
    scene.read = app.view === 'read' ? { on: true, alpha: 0.85, chevrons: true } : { on: true, alpha: 0.3, chevrons: false };
  }
  return scene;
}

// Menu backdrop: a slow drone shot drifting down the current hole's fairway.
function menuCam(time) {
  const t = app.holeTerrain;
  const P = t.path;
  const L = P.length;
  const u = 0.5 - 0.5 * Math.cos(time * 0.05);
  const s = L * (0.05 + 0.4 * u);
  const p = P.pointAt(s);
  const tg = P.tangentAt(s);
  const look = P.pointAt(Math.min(L, s + 150));
  const ex = p.x - tg.x * 30;
  const ey = p.y - tg.y * 30;
  return {
    eye: { x: ex, y: ey, z: Math.max(t.heightAt(ex, ey), t.heightAt(p.x, p.y)) + 24 },
    target: { x: look.x, y: look.y, z: t.heightAt(look.x, look.y) + 3 },
    up: { x: 0, y: 0, z: 1 },
    fovY: fovForAspect(app.cssW / app.cssH),
    near: 0.5,
    far: 6000,
  };
}

function render(time, dt) {
  const g = app.game;
  let cam;
  if (g && g.phase && g.terrain) {
    if (app.paused && app.drewPaused) return;
    cam = app.rig.update(dt * FAST, camCtx());
    app.drewPaused = app.paused;
  } else if (app.holeTerrain) {
    cam = menuCam(time);
  } else return;
  const scene = buildScene(time, cam);
  app.renderer.draw(scene);
  app.lastScene = scene;
  if (g && g.phase) updateLiveHud(g, cam, dt);
}

// Per-frame HUD bits: the wind arrow follows the camera; the distance to the pin counts down in
// flight; an aim drag refreshes the lie (sidehill / uphill labels depend on the aim).
function updateLiveHud(g, cam, dt) {
  const w = g.wind;
  if (Math.hypot(w.x, w.y) > 0.05) {
    const rel = Math.atan2(w.y, w.x) - Math.atan2(cam.target.y - cam.eye.y, cam.target.x - cam.eye.x);
    if (app.windRel == null || Math.abs(Math.atan2(Math.sin(rel - app.windRel), Math.cos(rel - app.windRel))) > 0.03) {
      app.windRel = rel;
      app.ui.setHud({ windRelAngle: rel });
    }
  }
  app.hudT += dt;
  if (g.phase === 'flight' && app.hudT > 0.1) {
    app.hudT = 0;
    // The lie chip follows the ball in flight instead of showing the old lie.
    const sh = g.shot;
    const land = sh && sh.result.events.find((ev) => ev.type === 'land');
    const rolling = !sh || sh.launch.mode === 'roll' || (land && sh.playT >= land.t);
    app.ui.setHud({ distToPin: g.distanceToCup(), lieLabel: rolling ? 'Rolling' : 'In the air', lieSurface: 'flight' });
  } else if (app.hudDirty && app.hudT > 0.05) {
    app.hudT = 0;
    refreshHud();
  }
}

function frame(nowMs) {
  requestAnimationFrame(frame);
  const now = nowMs / 1000;
  const dt = app.lastTime ? clamp(now - app.lastTime, 0, MAX_DT) : 1 / 60;
  app.lastTime = now;
  app.time += dt;
  const t0 = performance.now();
  try {
    tick(dt);
    render(app.time, dt);
  } catch (err) {
    // Keep the loop alive; report the first few failures only.
    if (app.errors++ < 3) console.error(err);
  }
  app.frameMs = app.frameMs * 0.9 + (performance.now() - t0) * 0.1;
  app.fps = app.fps * 0.95 + (1 / Math.max(dt, 1e-3)) * 0.05;
  if (DEBUG) drawDebug();
}

let debugEl = null;
function drawDebug() {
  if (!debugEl) {
    debugEl = document.createElement('div');
    debugEl.style.cssText =
      'position:fixed;left:4px;bottom:4px;z-index:99;font:11px ui-monospace,monospace;color:#9f9;' +
      'background:rgba(0,0,0,.55);padding:2px 6px;border-radius:4px;pointer-events:none';
    document.body.appendChild(debugEl);
  }
  const st = app.renderer.stats();
  const phase = app.game ? app.game.phase : 'menu';
  debugEl.textContent = `${app.fps.toFixed(0)} fps · ${app.frameMs.toFixed(1)} ms · ${st.drawCalls} draws · ${(st.tris / 1000).toFixed(0)}k tris · x${(st.renderScale || 1).toFixed(2)} · ${phase}`;
}

// ------------------------------------------------------------------ wake lock
// Keeps the screen on mid-round; optional, and may be refused in embedded frames.
function wakeLockAllowed() {
  // Embedded frames (e.g. an Artifact) may forbid it; asking anyway logs a policy violation.
  const policy = document.permissionsPolicy || document.featurePolicy;
  return !(policy && policy.allowsFeature && !policy.allowsFeature('screen-wake-lock'));
}

async function requestWakeLock() {
  try {
    if (navigator.wakeLock && !app.wakeLock && !document.hidden && wakeLockAllowed()) {
      app.wakeLock = await navigator.wakeLock.request('screen');
      app.wakeLock.addEventListener('release', () => (app.wakeLock = null));
    }
  } catch {
    app.wakeLock = null;
  }
}

function releaseWakeLock() {
  try {
    if (app.wakeLock) app.wakeLock.release();
  } catch {
    /* ignore */
  }
  app.wakeLock = null;
}

// ------------------------------------------------------------------ settings
function applyQuality(q) {
  const r = app.renderer;
  if (r.isNull || QUALITY) return;
  r.quality = q;
  r.maxScale = q === 'low' ? 0.75 : 1;
  r.renderScale = r.maxScale;
  r.resize(app.cssW, app.cssH, app.dpr);
  if (app.holeTerrain) r.setHole(app.holeTerrain);
}

function onSettings(s, key) {
  if (key === 'sound') app.audio.setEnabled(s.sound);
  if (key === 'quality') applyQuality(s.quality);
  if (key === 'swing') {
    cancelMeter();
    app.input.swingStyle = s.swing;
  }
  const g = app.game;
  if (g && ['wind', 'difficulty', 'handed', 'units'].includes(key)) {
    g.setSettings({ [key]: s[key] });
    if (key === 'wind') app.audio.setWind(Math.hypot(g.wind.x, g.wind.y));
    app.windRel = null;
    if (g.phase === 'address') g.carryForPower(0.5);
  }
  refreshHud();
  refreshClub();
}

// ------------------------------------------------------------------ test hooks
function installDebugHooks() {
  app.debug = {
    // Put the ball d metres from the cup, on the side the ball (or the green centre) is on.
    placeNearCup(d = 0.6) {
      const g = app.game;
      const t = g.terrain;
      const c = t.cup;
      const from = g.state.hole.ball;
      let dx = from.x - c.x;
      let dy = from.y - c.y;
      let l = Math.hypot(dx, dy);
      if (l < 0.5) {
        dx = t.greenCenter.x - c.x;
        dy = t.greenCenter.y - c.y;
        l = Math.hypot(dx, dy) || 1;
      }
      const x = c.x + (dx / l) * d;
      const y = c.y + (dy / l) * d;
      g.debugPlace(x, y);
      return { x, y };
    },
    skyPixel() {
      return app.renderer.debugPixel(app.cssW / 2, app.cssH * 0.06);
    },
    padRect() {
      const r = app.renderer.canvas ? app.renderer.canvas.getBoundingClientRect() : { left: 0, top: 0 };
      const p = app.input.padRect;
      return { x: r.left + p.x, y: r.top + p.y, w: p.w, h: p.h };
    },
    // Backswing depth (CSS px) for a swing power on the current pad (e2e swipe helpers).
    depthForPower(power, kind = 'full') {
      return depthForPower(power, app.input.padRefH, kind);
    },
    state() {
      const g = app.game;
      if (!g) return { phase: 'menu' };
      return { phase: g.phase, hole: g.state.holeIndex, strokes: g.state.hole.strokes, clubId: g.state.clubId, putt: g.isPutt, card: g.state.card.holes.map((h) => h.strokes) };
    },
  };
}

// ------------------------------------------------------------------ boot
function boot() {
  const canvas = document.getElementById('gl');
  const ui = new UI(document);
  app.ui = ui;
  globalThis.__golf = app;
  const settings = ui.settings;
  app.renderer = NOGL ? new NullRenderer() : new Renderer(canvas, { quality: QUALITY || settings.quality, test: TEST });
  if (!app.renderer.ok) {
    ui.showNoGL();
    return;
  }
  if (!app.renderer.canvas) app.renderer.canvas = canvas;
  app.audio = new AudioFX();
  app.audio.setEnabled(settings.sound);
  app.rig = new CameraRig();
  app.input = new InputController(canvas, {
    onAim,
    onSwingStart: () => app.ui.setHint(null),
    onSwingProgress,
    onSwing,
    onSwingCancel,
    onPadTap,
    onOrbit: (dyaw) => app.rig.orbit(dyaw),
    onTap,
    onSkip,
  });
  app.input.swingStyle = settings.swing;
  if (TEST) installDebugHooks();

  ui.on('new-round', newRound);
  ui.on('resume', resumeGame);
  ui.on('restart', newRound);
  ui.on('quit', quitToMenu);
  ui.on('pause', () => setPaused(true));
  ui.on('unpause', () => setPaused(false));
  ui.on('next-hole', () => {
    const g = app.game;
    if (g && (g.phase === 'holed' || g.phase === 'scorecard')) {
      g.nextHole();
      saveGame();
    }
  });
  ui.on('club-prev', () => changeClub(-1));
  ui.on('club-next', () => changeClub(1));
  ui.on('read', () => setView(app.view === 'read' ? 'play' : 'read'));
  ui.on('map', () => setView(app.view === 'map' ? 'play' : 'map'));
  ui.on('flyover', () => setView('flyover'));
  ui.on('putt-range+', () => app.game && (app.game.stepPuttRange(1), refreshClub()));
  ui.on('putt-range-', () => app.game && (app.game.stepPuttRange(-1), refreshClub()));
  ui.on('layout', () => {
    app.sizeKey = '';
    resize();
  });
  ui.onChange(onSettings);

  // Size: the canvas follows the layout viewport; iOS changes it with the toolbars and rotation.
  const relayout = () => requestAnimationFrame(resize);
  globalThis.addEventListener('resize', relayout);
  globalThis.addEventListener('orientationchange', relayout);
  if (globalThis.visualViewport) {
    visualViewport.addEventListener('resize', relayout);
    visualViewport.addEventListener('scroll', relayout);
  }
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(relayout).observe(canvas);
  resize();

  // iOS only lets audio start from a user gesture.
  const unlock = () => app.audio.unlock();
  document.addEventListener('pointerdown', unlock, { capture: true });
  document.addEventListener('pointerup', unlock, { capture: true });
  document.addEventListener('touchend', unlock, { capture: true });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      app.audio.suspend();
      saveGame();
    } else {
      app.audio.resume();
      app.lastTime = 0;
      if (app.game) requestWakeLock();
    }
  });
  globalThis.addEventListener('pagehide', saveGame);

  // Build the menu backdrop (hole 1) after the spinner has painted.
  ui.setLoading(true, 'Loading course');
  requestAnimationFrame(() =>
    setTimeout(() => {
      try {
        if (!app.renderer.isNull) {
          app.holeTerrain = cachedBuildHole(COURSE.holes[START_HOLE], { pinIndex: 0, seed: TREE_SEED });
          app.renderer.setHole(app.holeTerrain);
        }
      } catch (err) {
        console.error(err);
      }
      ui.setLoading(false);
      if (AUTOPLAY) newRound();
      else showMenu();
      requestAnimationFrame(frame);
    }, 0),
  );
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
