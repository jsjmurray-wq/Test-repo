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
// reaches the pin (or the aim point when the pin is out of reach, moved up until the caddie's
// predicted shot lands in play), from the inverse of the caddie's power curve; Easy snaps a power
// within 5% onto it.
//
// Courses (section 8.5): the main menu's course picker chooses the course of a new round (the
// choice is remembered in golf.course.v1; ?course= overrides it); the menu backdrop flies over the
// chosen course. The save (golf.save.v1) carries the course id, and the best round is kept per
// course (golf.best.v1 = {[courseId]: best}; an old single record is Hollow Pines'). Restart and
// Play again replay the round's own course.
//
// Mixed rounds: the fifth card draws 9 ("Mixed Nine") or 18 ("Mixed Eighteen", its 9 | 18
// switch) holes at random from all four courses (courses.js mixedCourse, seeded by the round
// seed). Each hole is built with its own course (theme, conditions, wind), the intro names the
// course it comes from, the save stores the draw, and the best rounds (by score to par) are kept
// under 'mixed' and 'mixed18'. Restart replays the same holes; Play again draws new ones.
//
// Special shots (section 8.4): the shot chip beside the club picker opens the shot sheet (the
// eligible shots with their carry/total); the selection lasts one stroke. The club readout, power
// gauge, target notch and aim preview follow it: a draw or cut shows its curved flight draped on
// the ground (gold) ending in the landing ring, and the toast names the shot ("7i Stinger · ...").
//
// Green reading (section 8.9): on the green a dotted preview line shows where the putt at the
// current aim and power rolls (the error-free putt on the live hole: all of it on Easy, the first
// part on Normal, none on Pro, or the 'Putt preview' setting), at most one simulation per frame
// through putting-aid's PreviewThrottle, while the caddie's read (PuttReader, one simulation per
// frame) fills the read card ("Breaks ~1 ft R→L · Uphill, plays 21 ft / Aim 2 cups right") and
// sets the putt notch to its pace; "Aim at read" snaps the aim (and a fitting putt range) to it.
// Read adds flowing slope streaks, slope tags at the ball and the cup and three camera presets.
// Within 40 m of the green a chip shows its roll the same way.
//
// The golfer (section 9.7): the player's golfer (golfer.js loadLook, golf.golfer.v1) stands at the
// ball at every address, holding the selected club and facing the aim (re-placed when the aim,
// club, shot or hand changes), and idles and waggles there. The backswing follows the live power
// (swipe gauge or tap meter); a cancel eases back to address; a recognised strike plays the
// downswing and the ball is launched (game.swing) on the animation's impact frame, 0.22-0.32 s
// later (the whoosh peaks there, the impact sound comes with the launch). Until then the swing is
// committed: input is off, the controls ignore taps, and pause, quit or hiding the page launch it at
// once. The cameras frame him TV style, from behind on the target line (camera.js golferFraming),
// and the flight camera holds on his follow-through before it follows the ball. The bot swings
// the same way. applyGolferLook(look) rebuilds him (the customiser's hook).
//
// URL parameters
//   ?course=ID    desert | water | links | pines | mixed: the course for new rounds (menu and autoplay)
//   ?holes=18     with course=mixed: a Mixed Eighteen round (mixed18); fixed courses ignore it
//   ?debug=1      fps / draw-call overlay
//   ?autoplay=1   the bot plays every hole; globalThis.__golfDone = {total, toPar, played} at the end
//   ?fast=N       playback speed (flight, intro, holed hold, the golfer's swing), e.g. 8
//   ?hole=N       start a new round at hole N (1-based)
//   ?seed=N       round seed (pins, wind, contact scatter); ?test=1 defaults it to 1
//   ?nogl=1       no WebGL: a NullRenderer stub keeps the logic and HUD running
//   ?test=1       renderer test mode (pixel read-back) and app.debug hooks for the e2e tests
//   ?quality=low  low-quality renderer regardless of the setting
// globalThis.__golf = app (debugging and tests).

import { Game, TREE_SEED, courseFromParam, saveCourseId, mergeBest, recordBest } from './game.js';
import { COURSES, courseById, courseSummary, DEFAULT_COURSE_ID, MIXED_ID, MIXED18_ID, mixedCourse, mixedSummary, courseName, isCourseId, isMixedId, mixedHoles } from './courses.js';
import { shotById, shotIntent } from './shots.js';
import { buildHole } from './terrain.js';
import { Renderer } from './render.js';
import { CameraRig, FLYOVER_T, fovForAspect } from './camera.js';
import { InputController, readSafeInsets, snapPower, meterPower, depthForPower, swingTravel, MAX_POWER } from './input.js';
import { UI, fmtToPar } from './ui.js';
import { AudioFX } from './audio.js';
import { interpretSwing, swingLabel, powerForDistance } from './swing.js';
import { releaseK, predictShot, isSafeRest } from './caddie.js';
import { aidLevel, previewPutt, previewShot, PuttReader, readText, puttNotchPower, rangeForRead, visibleEnd, drapePath, PreviewThrottle, slopeAt, slopeBand } from './putting-aid.js';
import { PUTT_RANGES } from './swing.js';
import { prepareBotShot, botDecide } from './bot.js';
import { SwingAnimator } from './swing-anim.js';
import { buildGolferMesh } from './golfer-mesh.js';
import { loadLook, normalizeLook, lookKey } from './golfer.js';
import { CLUBS, clubById } from './clubs.js';
import { SURF, fmtDist, mToFt } from './constants.js';
import { clamp, DEG, normalizeAngle } from './vec3.js';
// Golfer customiser (section 9, Customiser; own aliases so these lines never clash with the above).
import { Customiser, renderAvatars } from './customiser.js';
import { SwingAnimator as StudioAnimator } from './swing-anim.js';
import { buildGolferMesh as buildStudioMesh } from './golfer-mesh.js';
import { B as STUDIO_BONES, lookKey as studioLookKey, loadLook as studioLoadLook } from './golfer.js';
import { BALL_R as STUDIO_BALL_R } from './constants.js';

const SAVE_KEY = 'golf.save.v1';
const BEST_KEY = 'golf.best.v1';
const COURSE_KEY = 'golf.course.v1'; // the course picked on the menu
const PREVIEW_LIFT = 0.1; // m: the curved shot preview floats this far over the turf
const INTRO_HOLD = 1.2; // s the intro holds on the green after the flyover before play starts
const MAP_EXIT_S = 0.45; // after a Map tap, return to the address view this much later
const BOT_THINK_S = 0.6; // autoplay pause before each shot (game time)
const CUT_DIST = 60; // m: camera moves longer than this are hard cuts, not swoops
const PIN_ATTEND_M = 9; // m: putts longer than this keep the flagstick in (attended) at address
const MAX_DT = 0.1; // s: frame dt clamp (a stall must not skip half a shot)
const PUTT_PAST_M = 0.35; // m: the putt notch is the pace that dies this far past the cup (flat)
const MIN_TARGET = 0.04; // a target power below this (a tap-in) gets no notch
const FULL_SLACK = 0.03; // a target this little past full power is shown at full
const AIM_STEP = 0.02; // a notch whose shot is not safely in play moves in steps this big
const AIM_SEARCH = 0.16; // ...at most this far from where it started (down as well as up)
const PIN_SEARCH = 0.06; // (a pin notch moves at most this far: it is still the pin)
const SCATTER_P = 0.03; // power either side of the notch that must be in play too (~2 sigma of contact)
const SAFE_MARGIN = 3; // m: an aim-point notch's rest keeps this clear of trouble
const CHIP_PREVIEW_M = 40; // m from the green edge: a chip or pitch shows its roll (section 8.9)
const PREVIEW_COLOR = [1, 1, 1, 0.95];
const DROP_COLOR = [1, 0.84, 0.25, 1]; // the preview putt drops
const CHIP_COLOR = [0.9, 0.97, 1, 0.9];
const CARRY_HAZARDS = new Set([SURF.WATER, SURF.OOB, SURF.BUNKER, SURF.DESERT, SURF.FESCUE]); // no landing there

const params = new URLSearchParams(globalThis.location ? location.search : '');
const flag = (k) => params.has(k) && params.get(k) !== '0';
const DEBUG = flag('debug');
const AUTOPLAY = flag('autoplay');
const TEST = flag('test');
const NOGL = flag('nogl');
const FAST = clamp(parseFloat(params.get('fast')) || 1, 0.25, 50);
const START_HOLE = clamp((parseInt(params.get('hole'), 10) || 1) - 1, 0, 17); // clamped per course in newRound
const QUALITY = params.get('quality') === 'low' ? 'low' : null;
const SEED = params.has('seed') ? parseInt(params.get('seed'), 10) >>> 0 : TEST ? 1 : null;
const COURSE_PARAM = courseFromParam(params.get('course'), params.get('holes'));

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
  preview: { data: new Float32Array(3 * 512), count: 0 }, // curved aim preview (draw / cut)
  courseId: DEFAULT_COURSE_ID, // course for a new round (menu picker, ?course=)
  backdropCourse: null,
  backdropT: 0,
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
  params: { DEBUG, AUTOPLAY, TEST, NOGL, FAST, START_HOLE, QUALITY, SEED, COURSE: COURSE_PARAM },
  debug: null,
};

// Green-reading state (section 8.9): the throttled preview, the caddie's read for the ball's spot
// and reused buffers (nothing is allocated per frame once they exist).
const aid = {
  throttle: new PreviewThrottle({ interval: 0.15, settle: 0.08 }),
  level: 'off',
  terrain: null,
  bx: NaN,
  by: NaN,
  reader: null,
  read: null, // PuttReader result for this spot
  pv: null, // last preview: {holed, final, kind:'putt'|'chip'}
  pvBuf: new Float32Array(3 * 520),
  pvCount: 0,
  chipBuf: new Float32Array(3 * 520),
  chipCount: 0,
  paths: [],
  pathPutt: { data: null, count: 0, color: PREVIEW_COLOR, width: 0.045, minPx: 7, ring: true, ringR: 0.09 },
  pathChip: { data: null, count: 0, color: CHIP_COLOR, width: 0.08, minPx: 7, ring: true, ringR: 0.6 },
  cam: 'orbit',
  sims: 0,
};
aid.pathPutt.data = aid.pvBuf;
aid.pathChip.data = aid.chipBuf;
app.aid = aid;

// ------------------------------------------------------------------ terrain cache
// buildHole is deterministic per (course, hole, pin, seed); keep the last few so the menu backdrop,
// the prebuilt next hole and a restored round never build the same terrain twice.
const terrainCache = new Map();
function cachedBuildHole(def, opts = {}) {
  const key = `${(opts.course && opts.course.id) || DEFAULT_COURSE_ID}:${def.n}:${opts.pinIndex ?? 0}:${opts.seed ?? 1}`;
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
  memSave = JSON.stringify({ v: 1, savedAt: Date.now(), courseId: g.course.id || DEFAULT_COURSE_ID, game: g.serialize() });
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

// Best rounds by course {[courseId]: {strokes, toPar, date}}: the stored and in-memory copies
// merged per course (an old single record counts as Hollow Pines').
function loadBest() {
  let stored = null;
  try {
    stored = parse(localStorage.getItem(BEST_KEY));
  } catch {
    /* fall back to memory */
  }
  return mergeBest(stored, memBest);
}

// Records a completed nine on its course; returns {best, isNew} for that course.
function recordBestRound(tot, course) {
  const map = loadBest();
  if (AUTOPLAY) return { best: map[course.id] || null, isNew: false };
  const r = recordBest(map, course.id, tot, course.holes.length);
  if (r.isNew) {
    memBest = r.map;
    try {
      localStorage.setItem(BEST_KEY, JSON.stringify(r.map));
    } catch {
      /* memory only */
    }
  }
  return { best: r.best, isNew: r.isNew };
}

// The course picked on the menu (remembered across visits; ?course= wins for this visit).
function loadCourseChoice() {
  try {
    return courseFromParam(localStorage.getItem(COURSE_KEY));
  } catch {
    return null;
  }
}

function saveCourseChoice(id) {
  try {
    localStorage.setItem(COURSE_KEY, id);
  } catch {
    /* memory only */
  }
}

// Menu card data per course (par and length need the hole splines: computed once).
const summaries = new Map();
function summaryOf(course) {
  if (!summaries.has(course.id)) summaries.set(course.id, courseSummary(course));
  return summaries.get(course.id);
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
  const lineLat = aid.read ? aid.read.breakLat : 0;
  return { ball: rigBall(g), aimYaw: g.aimYaw, cup: t.cup, terrain: t, shot: g.shot, aspect: app.cssW / app.cssH, carry, padShift, relief: g.state.decision, lineLat, golfer: golferCamCtx(g) };
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
  ui.hideShots();
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
  const shot = shotById(g.shotType);
  app.ui.setShot({ id: shot.id, name: shot.short || shot.name, show: c.kind !== 'putter' });
  app.targetPower = targetPower(g);
  app.ui.setTarget(app.targetPower);
  aid.throttle.reset();
  updateReadCard();
  syncControls();
}

// Power that reaches the target from here with the selected club. Full swings: the pin, up to
// MAX_POWER (a notch in the red zone says the pin needs an overswing, or more club); when even
// that falls short, the aim point (the course's lay-up / dogleg target), where the notch never
// asks for more than full power. The power comes from the inverse of the caddie's power curve on
// the "expected finish" (carry plus most of the release, as the caddie picks clubs), with the
// height difference over the club's descent angle added like the plays-like distance (the curve
// already has the wind). A pin that needs at most FULL_SLACK more than full power reads as full
// (the detent): a 3% overswing for a few yards would double the scatter. The aim-point notch is
// checked on the real hole (playablePower). Putts: the flat-roll pace that dies PUTT_PAST_M past
// the cup. null for a tap-in.
function targetPower(g) {
  if (!g || g.phase !== 'address' || !g.terrain) return null;
  if (g.isPutt) {
    // Easy / Normal: the caddie's pace for this green (uphill, downhill, the green speed); Pro and
    // until the read is in: the flat-roll pace.
    const rd = aidRead(g);
    const p = rd && app.ui.getSetting('difficulty') !== 'pro' ? puttNotchPower(rd, g.puttRange) : (g.distanceToCup() + PUTT_PAST_M) / g.puttRange;
    return p != null && p >= MIN_TARGET && p <= MAX_POWER ? p : null;
  }
  const t = g.terrain;
  const b = g.state.hole.ball;
  // The selected shot's descent angle and release share (a bump & run is played to run).
  const info = g.clubInfo();
  const tanDescent = Math.tan(Math.max(20, info.landAngle ?? 45) * DEG);
  const k = releaseK(g.shotType);
  const finish = (p) => {
    const d = g.carryForPower(p);
    return d.carry + k * Math.max(0, d.total - d.carry);
  };
  const zBall = t.heightAt(b.x, b.y);
  const need = (q) => Math.hypot(q.x - b.x, q.y - b.y) + (t.heightAt(q.x, q.y) - zBall) / tanDescent;
  let p = powerForDistance(finish, need(t.cup), MAX_POWER);
  if (p != null) {
    if (p > 1 && p <= 1 + FULL_SLACK) p = 1;
    if (p >= MIN_TARGET && p <= 1) p = playablePower(g, p, { margin: 0, max: 1, search: PIN_SEARCH });
  } else p = playablePower(g, Math.min(1, powerForDistance(finish, need(t.aimPoint(b)), MAX_POWER) ?? 1), { margin: SAFE_MARGIN, max: 1 });
  if (p > 1 && p <= 1 + FULL_SLACK) p = 1;
  return p >= MIN_TARGET ? p : null;
}

// The notch's own shot is played on the real hole (the caddie's predictShot: no scatter, with the
// wind and the selected shot). The aim point is where the hole bends, often just past a forced
// carry (a wash, the desert, a lagoon): a notch that reaches it on the "expected finish" (carry plus
// most of the release) can land in the carry, which gives no release (Red Mesa's 3rd sent a 64%
// driver into the desert 7 m short of the fairway); and a notch whose shot only just stays in play
// puts an ordinary strike in trouble (Red Mesa's 8th: an on-target 3-wood rested 0.5 m from the
// scrub, and contact scatter put it in). So a notch must be safely in play: at its power and at
// SCATTER_P either side (about two sigma of contact) the shot lands clear of water, OB, sand, scrub
// and fescue and rests out of them, and for an aim-point notch its rest is SAFE_MARGIN m clear of
// them too. When it is not, the notch moves to the nearest power that is, AIM_STEP at a time, down
// as well as up, within AIM_SEARCH (never past full power for the aim point); when nothing near is,
// it stays (full power is the caddie's own check of the club). Pin notches get the same check with
// no margin (a pin tucked by a bunker is still the target), and at most a few steps.
function playablePower(g, p, { margin = SAFE_MARGIN, max = 1, search = AIM_SEARCH } = {}) {
  const t = g.terrain;
  const b = g.state.hole.ball;
  const opts = { shot: g.shotType, handed: app.ui.getSetting('handed') };
  const memo = new Map();
  const clear = (x, y) => {
    for (let k = 0; k < 8; k++) {
      const a = (k * Math.PI) / 4;
      if (CARRY_HAZARDS.has(t.surfaceAt(x + margin * Math.cos(a), y + margin * Math.sin(a)))) return false;
    }
    return true;
  };
  const inPlay = (q) => {
    const key = Math.round(q * 1000);
    if (!memo.has(key)) {
      const r = predictShot(t, b, g.lie, g.wind, g.club.id, g.aimYaw, q, opts);
      const ok = isSafeRest(r) && !(r.landing && CARRY_HAZARDS.has(t.surfaceAt(r.landing.x, r.landing.y))) && (margin <= 0 || clear(r.final.x, r.final.y));
      memo.set(key, ok);
    }
    return memo.get(key);
  };
  const safe = (q) => inPlay(q) && inPlay(Math.max(0.05, q - SCATTER_P)) && inPlay(Math.min(MAX_POWER, q + SCATTER_P));
  if (safe(p)) return p;
  const lo = Math.max(MIN_TARGET, p - search);
  const hi = Math.min(max, p + search);
  for (let d = AIM_STEP; d <= search + 1e-9; d += AIM_STEP) {
    // Nearest first; on a tie the longer one (short of the target is where forced carries bite).
    if (p + d <= hi && safe(p + d)) return p + d;
    if (p - d >= lo && safe(p - d)) return p - d;
  }
  // Nothing safely in play near: at least a power whose own shot is in play (the old rule).
  if (inPlay(p)) return p;
  for (let q = p + AIM_STEP; q <= hi; q += AIM_STEP) if (inPlay(q)) return q;
  return max >= 1 && margin > 0 ? 1 : p;
}

function syncControls() {
  const g = app.game;
  if (!g || !g.phase) return;
  const flyover = app.view === 'flyover';
  app.ui.setControls({
    // (While a struck swing comes down to the ball the swing controls are already gone.)
    phase: flyover ? 'intro' : golfer.pending ? 'swing' : g.phase,
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
  // A struck swing on its way down to the ball takes no input (it is committed).
  if (g && !app.paused && !menuOpen() && !app.ui.shotsOpen && !golfer.pending) {
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
  if (!g || g.phase !== 'address' || golfer.pending) return;
  const prev = app.view;
  cancelMeter();
  golferCancel();
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
  aid.cam = app.rig.readView;
  app.ui.setReadCam(v === 'read' ? aid.cam : null);
  updateReadCard();
  syncControls();
  updateInputMode();
}

// The intro's course line: the course name, or in a mixed round the hole's own course and its
// number there ("Red Mesa · No. 7").
function showIntroCard(g) {
  const t = g.terrain;
  const info = g.holeInfo();
  const course = info.mixed ? `${info.holeCourseName} · No. ${info.holeN}` : g.course.name;
  app.ui.showIntro({ hole: info.n, name: t.name, par: t.par, lengthM: t.lengthM, si: t.si, course });
}

function enterAddress() {
  const g = app.game;
  app.view = 'play';
  app.mapExitT = -1;
  app.swingPower = null;
  app.meter = null;
  app.ui.hideIntro();
  // The golfer steps up to the ball (placed before the camera frames him); a new spot is a cut.
  placeGolferNow(g, true);
  app.rig.snap = true;
  camMode(g.isPutt ? 'putt' : 'address');
  // Warm the caddie's power curve now (8 short simulations) so the first move of the swing
  // gauge does not hitch.
  g.carryForPower(0.5);
  refreshClub();
  refreshHud();
}

function changeClub(dir) {
  const g = app.game;
  if (!g || g.phase !== 'address' || golfer.pending) return;
  const ids = CLUBS.map((c) => c.id);
  const i = clamp(ids.indexOf(g.state.clubId) + dir, 0, ids.length - 1);
  if (ids[i] === g.state.clubId) return;
  cancelMeter();
  const wasPutt = g.isPutt;
  g.setClub(ids[i]);
  placeGolferNow(g, true); // the new club in his hands (and its stance)
  if (g.isPutt !== wasPutt) setView('play'); // putt camera <-> address camera, pad mode
  g.carryForPower(0.5);
  refreshClub();
  refreshHud();
  updateInputMode();
}

// ------------------------------------------------------------------ special shots
// The shot chip opens the sheet of the shots this club can play from this lie, each with its
// carry/total from here; the pick lasts one stroke (game.js resets it).
function openShots() {
  const g = app.game;
  if (!g || g.phase !== 'address' || g.isPutt || app.paused || app.view !== 'play' || golfer.pending) return;
  cancelMeter();
  golferCancel();
  const shots = g.shotsAvailable().map((id) => {
    const s = shotById(id);
    const info = g.clubInfo(g.club.id, id);
    return { id, name: s.name, blurb: s.blurb, carry: info.carry, total: info.total };
  });
  app.ui.showShots({ shots, current: g.shotType, handed: app.ui.getSetting('handed'), kicker: `${g.club.name} · ${g.lie.label}` });
  updateInputMode();
}

function pickShot(id) {
  const g = app.game;
  if (g && g.phase === 'address' && !golfer.pending && g.setShot(id)) {
    placeGolferNow(g, true); // the shot's stance
    g.carryForPower(0.5); // warm the shot's power curve before the first swing
    refreshClub();
    refreshHud();
    saveGame();
  }
  updateInputMode();
}

// ------------------------------------------------------------------ game lifecycle
function bindGame(game) {
  for (const off of app.unsub) off();
  golfer.pending = null; // (a swing of another round is never launched into this one)
  golfer.key = '';
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
  golfer.pending = null;
  golfer.key = '';
  app.game = null;
  app.paused = false;
  app.view = 'play';
  app.trail.count = 0;
}

// A new round on a course (the menu's choice; Restart and Play again pass the round's own). A
// mixed round draws its nine from the round seed, or replays a given draw (picks: Restart).
function newRound(courseId = app.courseId, picks = null) {
  closeDialogs();
  app.ui.hideMenu();
  app.ui.hidePause();
  const seed = SEED ?? ((Date.now() ^ Math.floor(Math.random() * 0x7fffffff)) >>> 0);
  const course = isMixedId(courseId) ? mixedCourse(seed, picks, mixedHoles(courseId)) : courseById(courseId);
  const game = new Game({ course, seed, settings: gameSettings(), buildHole: cachedBuildHole });
  bindGame(game);
  game.loadHole(Math.min(START_HOLE, course.holes.length - 1));
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
  flushSwing(); // a swing already on its way down counts
  saveGame();
  unbindGame();
  closeDialogs();
  app.ui.hidePause();
  // The backdrop is the hole just played: fly the menu's course again.
  app.backdropCourse = null;
  setBackdrop(app.courseId);
  showMenu();
  releaseWakeLock();
  updateInputMode();
}

function showMenu() {
  const best = loadBest();
  const save = loadSave();
  let resumeSub = '';
  if (save && save.game) {
    const hole = (save.game.holeIndex ?? 0) + 1;
    resumeSub = `${courseName(saveCourseId(save))} · Hole ${hole}`;
  }
  app.ui.showHud(false);
  app.ui.showMenu({
    canResume: !!save,
    courses: [
      ...COURSES.map((c) => ({ ...summaryOf(c), best: best[c.id] || null })),
      { ...mixedSummary(9), best: best[MIXED_ID] || null },
      { ...mixedSummary(18), best: best[MIXED18_ID] || null },
    ],
    selected: app.courseId,
    resumeSub,
  });
  updateInputMode();
}

// Course card picked: remember it and fly the backdrop over its first hole.
function selectCourse(id) {
  app.courseId = isCourseId(id) ? id : courseById(id).id;
  saveCourseChoice(app.courseId);
  setBackdrop(app.courseId);
}

// Menu backdrop: the chosen course's first hole (built a moment after the tap has painted); for
// the mixed round, the first hole of a fixed sample draw.
function backdropHole(courseId) {
  const course = isMixedId(courseId) ? mixedCourse(1, null, mixedHoles(courseId)) : courseById(courseId);
  const i = course.mixed ? 0 : Math.min(START_HOLE, course.holes.length - 1);
  return { def: course.holes[i], course: course.mixed ? course.holeCourses[i] : course };
}

function setBackdrop(courseId) {
  if (app.renderer.isNull || app.game) return;
  const id = isCourseId(courseId) ? courseId : DEFAULT_COURSE_ID;
  if (app.backdropCourse === id) return;
  app.backdropCourse = id;
  clearTimeout(app.backdropT);
  app.backdropT = setTimeout(() => {
    if (app.game || app.backdropCourse !== id) return;
    try {
      const { def, course } = backdropHole(id);
      const t = cachedBuildHole(def, { pinIndex: 0, seed: TREE_SEED, course });
      app.holeTerrain = t;
      app.renderer.setHole(t);
    } catch (err) {
      console.error(err);
    }
  }, 30);
}

function setPaused(on) {
  // A swing already on its way down is struck before the pause (it was committed), and a live
  // backswing or tap meter is let go.
  if (on) flushSwing();
  app.paused = !!on;
  app.drewPaused = false;
  app.lastTime = 0;
  if (on) {
    app.meter = null;
    app.ui.setPower(null);
    golferCancel();
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
  golfer.key = ''; // placed at the tee once the hole is played
  app.ui.setHud({ hole: info.n, par: info.par, lengthM: info.lengthM, si: info.si });
  app.audio.setWind(Math.hypot(info.wind.x, info.wind.y));
  refreshHud();
}

function onPhase(phase, prev) {
  const g = app.game;
  const ui = app.ui;
  app.swingPower = null;
  app.meter = null;
  if (phase !== 'address') {
    ui.setReadCard(null);
    ui.setSlopeTags(null);
    aid.pvCount = 0;
    aid.chipCount = 0;
  }
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
      if (prev == null) showFinalCard(g.state.card, g.totals(), { best: loadBest()[g.course.id] || null, isNew: false }, g.course);
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
  if (i < g.course.holes.length) cachedBuildHole(g.course.holes[i], { pinIndex: g.state.pins[i], seed: TREE_SEED, course: g.courseOf(i) });
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
      // A special shot is named with the club: "7i Stinger · 140/178 yd · Straight".
      const sp = shot.swing && shot.swing.shot && shot.swing.shot !== 'normal' ? ` ${shotById(shot.swing.shot).name}` : '';
      app.ui.toast(`${clubShort(c)}${sp} · ${fmtPair(res.carry, res.total)} · ${shotLabel(shot)}`, 3400);
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
// A special shot's own shape (a draw's bend) is in the toast's first segment, so it is taken out
// here: a straight swipe on a draw reads "Straight".
function shotLabel(shot) {
  const handed = app.ui.getSetting('handed');
  const m = shot.launch.meta;
  const sw = shot.swing;
  const it = shotIntent(sw && sw.shot, shot.clubId, handed);
  const actual = swingLabel((m.startDirDeg || 0) - it.startDirDeg, (m.faceToPathDeg || 0) - it.faceToPathDeg, handed);
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
  const g = app.game;
  const best = recordBestRound(totals, g.course);
  clearSave();
  showFinalCard(card, totals, best, g.course);
  if (AUTOPLAY) globalThis.__golfDone = { total: totals.strokes, toPar: totals.toPar, played: totals.played, holes: g.course.holes.length, pickUps: totals.pickUps, course: g.course.id };
}

// The final card: the course name heads it ("Red Mesa · New best round!").
function showFinalCard(card, totals, { best, isNew }, course) {
  // (A mixed round's best is its score to par: every draw is different.)
  const bestText = best && (course.mixed ? `Best ${fmtToPar(best.toPar)}` : `Best ${best.strokes} (${fmtToPar(best.toPar)})`);
  const kicker = isNew ? 'New best round!' : bestText || 'Round complete';
  app.ui.showScorecard(card, { final: true, kicker, course: course.name, title: `${totals.strokes} strokes · ${fmtToPar(totals.toPar)}` });
}

// ------------------------------------------------------------------ input callbacks
function onAim(dyaw) {
  const g = app.game;
  if (!g || g.phase !== 'address' || app.paused || golfer.pending) return;
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
  // The golfer's backswing follows the gauge (swipe or tap meter).
  if (golfer.anim && !golfer.pending) golfer.anim.setBackswing(power);
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
    golferCancel();
    if (sw.reason === 'cancel') {
      if (g.isPutt) setHint('Putt cancelled', 2200);
      else app.ui.toast('Swing cancelled — swipe up to hit', 2200);
    }
    return;
  }
  strike(g, sw);
}

// A recognised swing (swipe, tap meter or the bot): the golfer plays the downswing (from the live
// backswing, else after an automatic one) and the ball is launched on its impact frame
// (launchSwing). Exactly once: a second strike while one is on its way is ignored.
function strike(g, sw) {
  if (golfer.pending || !g || g.phase !== 'address') return;
  const A = golfer.anim;
  if (A) placeGolferNow(g); // the right club and aim in his hands (a no-op when they already are)
  const p = { g, sw, t: 0, tImpact: 0, whoosh: sw.kind !== 'full', clock: golfer.clock };
  golfer.pending = p;
  if (A) p.tImpact = A.strike({ power: sw.power, kind: sw.kind, shot: g.shotType, onImpact: () => launchSwing(p, 'impact') });
  if (!A || !(p.tImpact > 0)) {
    launchSwing(p, 'direct');
    return;
  }
  golferTick(p, 0);
  syncControls();
  updateInputMode();
}

// The swipe was abandoned before the release: dragged out of the pad sideways, or the system
// took the touch (pointercancel). A mode change also ends up here, silently.
function onSwingCancel(reason) {
  app.swingPower = null;
  app.ui.setPower(null);
  golferCancel();
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
  if (!g || g.phase !== 'address' || app.paused || golfer.pending) return;
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
  cancelMeter(false); // (the golfer keeps his backswing: the strike comes down from it)
  if (raw == null) {
    golferCancel();
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

// golferToo: the golfer's backswing eases back to address with it.
function cancelMeter(golferToo = true) {
  if (!app.meter) return;
  app.meter = null;
  app.swingPower = null;
  app.ui.setPower(null);
  if (golferToo) golferCancel();
}

function onTap(sx, sy) {
  const g = app.game;
  if (!g || g.phase !== 'address' || app.view !== 'map' || golfer.pending) return;
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

// ------------------------------------------------------------------ the golfer (section 9.7)
// swing-anim.js plays him; this section places him at the ball, feeds him the gesture and turns
// his impact frame into the launch. golfer.pending is the struck swing on its way down
// ({g, sw, t, tImpact, whoosh}): set by strike(), cleared by launchSwing() (on the animator's
// onImpact, or at once by flushSwing() / the watchdog), so a swing is launched exactly once.
const GOLFER_MESHES = 6; // golfer meshes kept (look x club; a club change re-uses them)
const WHOOSH_LEAD = 0.16; // s: the whoosh peaks this long after it starts (audio.js), so it starts this early
const IMPACT_GRACE = 0.5; // s past the expected impact before the watchdog launches anyway
const PLACE_EVERY = 0.03; // s: an aim drag re-places him at most this often

const golfer = {
  anim: null, // SwingAnimator
  look: null, // the player's look (golfer.js)
  lookKey: '',
  meshes: new Map(), // `${lookKey}#${club}` -> buildGolferMesh() result (LRU)
  meshLook: '', // the look of scene.mesh
  key: '', // what he was placed for (ball, aim, club, shot, hand, look); '' = not placed
  placedAt: -1,
  frame: null, // {lat, along, H}: his stance relative to the ball and aim (camera framing)
  pending: null,
  clock: 0, // s of game time his animation has run (?fast scales it)
  last: null, // the last launch {how, strikeAt, launchAt, tImpact, kind, headErr} (tests)
  count: {}, // launches by how: impact | flush | watchdog | direct (tests)
  scene: { visible: true, mesh: null, bones: null, alpha: 1, fadeNear: true },
  hidden: false, // tests: draw the frame without him
};
app.golfer = golfer;

function initGolfer() {
  golfer.look = loadLook();
  golfer.lookKey = lookKey(golfer.look);
  golfer.anim = new SwingAnimator(golfer.look, { club: '7i' });
}

// The customiser's hook: the player's new look (golfer.js saveLook stores it) rebuilds the golfer in
// the game at once (mesh, proportions, swing style). Returns the normalised look.
function applyGolferLook(look) {
  flushSwing();
  golfer.look = normalizeLook(look);
  golfer.lookKey = lookKey(golfer.look);
  golfer.meshes.clear();
  if (golfer.anim) golfer.anim.setLook(golfer.look);
  golfer.key = '';
  const g = app.game;
  if (g && g.phase === 'address') placeGolferNow(g, true);
  return golfer.look;
}
app.applyGolferLook = applyGolferLook;

const golferHanded = () => (app.ui.getSetting('handed') === 'L' ? 'L' : 'R');

// One merged mesh per look and club, built once (10-30 ms) and kept for the next club change.
function golferMesh(clubId) {
  const k = `${golfer.lookKey}#${clubId}`;
  let m = golfer.meshes.get(k);
  if (m) golfer.meshes.delete(k);
  else m = buildGolferMesh(golfer.look, clubId);
  golfer.meshes.set(k, m);
  while (golfer.meshes.size > GOLFER_MESHES) golfer.meshes.delete(golfer.meshes.keys().next().value);
  return m;
}

// Places him at the ball (address phase, no swing on its way): facing the aim with the selected
// club and the shot's stance, on the real ground. Only when something changed, unless forced.
function placeGolferNow(g, force = false) {
  const A = golfer.anim;
  if (!A || !g || !g.terrain || g.phase !== 'address' || golfer.pending) return false;
  const b = g.ballPos();
  const handed = golferHanded();
  const key = `${b.x.toFixed(3)},${b.y.toFixed(3)},${b.z.toFixed(3)}|${g.aimYaw.toFixed(4)}|${g.state.clubId}|${g.shotType}|${handed}|${golfer.lookKey}`;
  if (key === golfer.key && !force) return false;
  const back = A.state === 'backswing' ? A.power : 0; // (a tap meter running while the aim moves)
  A.place({ ball: { x: b.x, y: b.y, z: b.z }, aimYaw: g.aimYaw, terrain: g.terrain, handed, club: g.state.clubId, shot: g.shotType });
  if (back > 0) A.setBackswing(back);
  golfer.key = key;
  golfer.placedAt = golfer.clock;
  // His stance centre across and along the aim line from the ball (+ = left of the line / ahead).
  const o = A.rig.origin;
  const c = Math.cos(g.aimYaw);
  const s = Math.sin(g.aimYaw);
  const dx = o[0] - b.x;
  const dy = o[1] - b.y;
  golfer.frame = { lat: -s * dx + c * dy, along: c * dx + s * dy, H: A.rig.dims.H };
  return true;
}

// Is he on screen? At address in the play view (not Read, Map or the flyover: those keep him out
// of the way), and during the shot where he struck it (holding his finish), and at the hole-out.
function golferShown(g) {
  if (!golfer.anim || golfer.hidden || !golfer.key || !g || !g.phase) return false;
  if (g.phase === 'address') return app.view === 'play';
  return g.phase === 'flight' || g.phase === 'holed';
}

// Camera context: his stance for the TV framing (address, putt and the flight's opening hold).
function golferCamCtx(g) {
  return golferShown(g) && golfer.frame && (g.phase === 'address' || g.phase === 'flight') ? golfer.frame : null;
}

// scene.golfer (render.js section 9.5), or null. #hud[data-golfer] = 'R' | 'L' while he stands at
// the ball ('0' otherwise): style.css moves the idle pad hint and the readout clear of him.
function golferScene(g) {
  const on = !app.renderer.isNull && golferShown(g);
  const flag = on && g.phase === 'address' ? golfer.anim.handed : '0';
  if (app.ui.el.hud.dataset.golfer !== flag) app.ui.el.hud.dataset.golfer = flag;
  if (!on) return null;
  const s = golfer.scene;
  s.visible = true;
  s.alpha = 1;
  s.fadeNear = true;
  if (!s.mesh || s.mesh.club !== golfer.anim.club || golfer.meshLook !== golfer.lookKey) {
    s.mesh = golferMesh(golfer.anim.club);
    golfer.meshLook = golfer.lookKey;
  }
  s.bones = golfer.anim.bones;
  return s;
}

// A live backswing (gauge or meter) let go: he eases back to address. Never a struck swing.
function golferCancel() {
  const A = golfer.anim;
  if (A && !golfer.pending && A.state === 'backswing') A.cancel();
}

// The impact frame: the ball is struck now (game.swing), once, if the round is still where the
// swing was made. how: 'impact' (the animator's impact frame), 'flush' or 'watchdog' (at once).
function launchSwing(p, how) {
  if (golfer.pending !== p) return;
  golfer.pending = null;
  golfer.count[how] = (golfer.count[how] || 0) + 1;
  const g = p.g;
  if (!p.whoosh) {
    p.whoosh = true;
    app.audio.handle({ type: 'swing', power: p.sw.power });
  }
  if (app.game === g && g.phase === 'address') {
    const A = golfer.anim;
    let headErr = null;
    if (A) {
      const h = A.clubHeadWorld();
      const b = g.ballPos();
      headErr = Math.hypot(h.x - b.x, h.y - b.y, h.z - b.z);
    }
    golfer.last = { how, strikeAt: p.clock, launchAt: golfer.clock, tImpact: p.tImpact, kind: p.sw.kind, headErr, state: A ? A.state : null };
    g.swing(p.sw);
    if (TEST && app.debug && app.debug.freezeAtImpact) {
      app.debug.freezeAtImpact = false;
      app.frozen = true;
    }
  }
  syncControls();
  updateInputMode();
}

// Strike a committed swing now (pause, quit, page hidden, a new look): the animation is run on to
// its impact frame so the launch still comes from it; launched directly if that does not happen.
function flushSwing() {
  const p = golfer.pending;
  if (!p) return;
  const A = golfer.anim;
  for (let i = 0; i < 40 && golfer.pending === p && A && (A.state === 'auto' || A.state === 'downswing'); i++) {
    A.update(0.1);
    golferTick(p, 0.1);
  }
  if (golfer.pending === p) launchSwing(p, 'flush');
}

// The struck swing's clock: the whoosh starts so it peaks at impact; the watchdog launches a swing
// whose impact frame never came.
function golferTick(p, dt) {
  p.t += dt;
  if (golfer.pending !== p) return;
  if (!p.whoosh && p.tImpact - p.t <= WHOOSH_LEAD) {
    p.whoosh = true;
    app.audio.handle({ type: 'swing', power: p.sw.power });
  }
  if (p.t > p.tImpact + IMPACT_GRACE) launchSwing(p, 'watchdog');
}

// Per frame (game time, ?fast included): keep him placed at address and run his animation in steps
// of at most 0.1 s, stopping on the impact frame so it is drawn.
function updateGolfer(sdt) {
  const A = golfer.anim;
  const g = app.game;
  if (!A || !g) return;
  if (g.phase === 'address' && !golfer.pending && golfer.clock - golfer.placedAt >= PLACE_EVERY) placeGolferNow(g);
  let left = Math.min(sdt, 1);
  for (let i = 0; i < 10 && left > 1e-6; i++) {
    const step = Math.min(0.1, left);
    left -= step;
    golfer.clock += step;
    const p = golfer.pending;
    const before = A.state;
    A.update(step);
    if (p) golferTick(p, step);
    if (before === 'downswing' && A.state === 'follow') break;
  }
}

// ------------------------------------------------------------------ autoplay bot
function tickBot(dt) {
  const g = app.game;
  const b = app.bot;
  if (b.phase !== g.phase) {
    b.phase = g.phase;
    b.wait = 0;
  }
  if (b.busy || golfer.pending) return;
  b.wait += dt;
  if (g.phase === 'address' && b.wait >= BOT_THINK_S) {
    // Planning takes a few hundred ms: run it outside the frame so the last frame shows first.
    // The plan sets club, aim and shot; the golfer then swings it (an automatic backswing) and
    // the ball goes at his impact frame, as for the player.
    b.busy = true;
    setTimeout(() => {
      b.busy = false;
      b.wait = 0;
      if (app.game !== g || g.phase !== 'address' || app.paused || golfer.pending) return;
      const plan = prepareBotShot(g);
      placeGolferNow(g, true);
      strike(g, plan.swing);
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
  if (!g || app.paused || app.frozen) return; // (frozen: tests hold a frame, e.g. the impact)
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
  // The golfer after the game: on his impact frame the shot starts (game.swing), and that frame
  // draws the ball still at the club.
  if (app.game === g) updateGolfer(sdt);
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

// Height to drape the aim preview on: the ground, or the water surface over a lake or the sea (a
// draw across Coral Cay's lagoon would otherwise run under the water and look broken).
function drapeZ(t, x, y) {
  const z = t.heightAt(x, y);
  const w = t.waterAt ? t.waterAt(x, y) : null;
  return w && w.level > z ? w.level : z;
}

// Curved aim preview for a draw or cut at address: the intended flight at the gauge's power (full
// power while idle) draped on the hole up to where it lands, so the line bends the way the ball
// will. Returns {trail, landing} or null for shots that fly straight down the aim line.
function buildPreview(g, power) {
  const it = shotIntent(g.shotType, g.club, app.ui.getSetting('handed'));
  if (!it.faceToPathDeg) return null;
  const pv = g.shotPreview(power);
  if (!pv || !pv.landing) return null;
  const t = g.terrain;
  const path = pv.path;
  const n = path.length / 4;
  const pr = app.preview;
  if (pr.data.length < (n + 1) * 3) pr.data = new Float32Array((n + 64) * 3);
  const d = pr.data;
  // Up to the first touchdown: past the apex, the first sample back at (or below) the launch height.
  const z0 = path[3];
  let apex = 0;
  let k = 0;
  for (; k < n; k++) {
    const z = path[k * 4 + 3];
    if (z > path[apex * 4 + 3]) apex = k;
    if (k > apex + 1 && z <= z0 + 0.02) break;
    const x = path[k * 4 + 1];
    const y = path[k * 4 + 2];
    d[k * 3] = x;
    d[k * 3 + 1] = y;
    d[k * 3 + 2] = drapeZ(t, x, y) + PREVIEW_LIFT;
  }
  const L = pv.landing;
  d[k * 3] = L.x;
  d[k * 3 + 1] = L.y;
  d[k * 3 + 2] = drapeZ(t, L.x, L.y) + PREVIEW_LIFT;
  pr.count = k + 1;
  // Direction of travel at the landing, for the ring's stub.
  const j = Math.max(0, k - 1);
  const yaw = Math.atan2(L.y - d[j * 3 + 1], L.x - d[j * 3]);
  return { trail: pr.count > 1 ? pr : null, landing: L, yaw, carry: pv.carry };
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
  scene.golfer = golferScene(g);
  scene.trail = buildTrail(g);
  const putting = g.isPutt;
  const rollShot = !!g.shot && g.shot.launch.mode === 'roll';
  // Flagstick out for putts (physics plays putts with the pin out too), and it stays out after a
  // holed putt while the scorecard is up. On a long putt it is attended until the stroke, so the
  // hole can be seen from 10+ m.
  const attended = phase === 'address' && putting && g.distanceToCup() > PIN_ATTEND_M;
  // Reading the green from above, the flag marks the hole (the cup alone is a dot).
  // (Behind the hole the stick would stand in front of the lens: the cup marks it.)
  scene.pin.visible = (reading && app.rig.readView !== 'hole') || attended || !((phase === 'address' && putting) || ((phase === 'flight' || phase === 'holed' || phase === 'scorecard') && rollShot));
  if (phase === 'address' && (app.view === 'play' || app.view === 'map' || (reading && putting))) {
    if (putting) {
      // Putt line: thin, close to the turf, short dashes, and a small ring at the flat-roll
      // distance while the putter is drawn back (at the cup otherwise). With the full preview
      // the dotted roll replaces it.
      const carry = app.swingPower != null ? app.swingPower * g.puttRange : g.distanceToCup();
      if (!(aid.level === 'full' && aid.pvCount > 1)) scene.aim = { x: b.x, y: b.y, z: b.z, yaw: g.aimYaw, carry: Math.max(0.3, carry), ring: 0.2, width: 0.012, lift: 0.008, dash: 0.45 };
    } else {
      const pv = buildPreview(g, app.swingPower != null ? app.swingPower : 1);
      if (pv) {
        // Draw / cut: the gold curve is the line; the landing ring sits where it comes down.
        scene.trail = pv.trail;
        const L = pv.landing;
        scene.aim = { x: L.x, y: L.y, z: L.z, yaw: pv.yaw, carry: 0.3, ring: Math.max(1.6, pv.carry * 0.035) };
      } else {
        let carry = app.swingPower != null ? g.carryForPower(app.swingPower).carry : g.clubInfo().carry || 100;
        // Near the green the chip preview knows where it really comes down (slopes, firmness).
        const L = aid.chipCount > 1 && aid.pv && aid.pv.kind === 'chip' ? aid.pv.landing : null;
        if (L) carry = Math.hypot(L.x - b.x, L.y - b.y);
        scene.aim = { x: b.x, y: b.y, z: b.z, yaw: g.aimYaw, carry: Math.max(1, carry) };
      }
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
    scene.read = app.view === 'read' ? { on: true, alpha: 0.85, chevrons: true, flow: 1, flowPx: 4.5 } : { on: true, alpha: 0.32, chevrons: false, flow: 0.6, flowPx: 3 };
  }
  if (phase === 'address' && app.view !== 'map' && app.view !== 'flyover') scene.paths = aidPaths(g);
  return scene;
}

// ------------------------------------------------------------------ green reading (section 8.9)
// The read for the ball's current spot, or null while it is being worked out.
function aidRead(g) {
  const b = g.state.hole.ball;
  return aid.read && b.x === aid.bx && b.y === aid.by && g.terrain === aid.terrain ? aid.read : null;
}

// A new spot (or hole): drop the read and the previews.
function aidResetSpot(g) {
  const b = g.state.hole.ball;
  aid.terrain = g.terrain;
  aid.bx = b.x;
  aid.by = b.y;
  aid.reader = null;
  aid.read = null;
  aid.pv = null;
  aid.pvCount = 0;
  aid.chipCount = 0;
  aid.throttle.reset();
}

// The putt's power for the preview: the live gauge, else the notch, else the flat pace.
function aidPuttPower(g) {
  if (app.swingPower != null) return app.swingPower;
  if (app.targetPower != null) return app.targetPower;
  return clamp((g.distanceToCup() + PUTT_PAST_M) / g.puttRange, 0.02, MAX_POWER);
}

// Once per frame at address: at most one simulation, the preview first (it follows the player's
// hands), else one step of the caddie's read.
function stepAid(now) {
  const g = app.game;
  const b = g.state.hole.ball;
  if (b.x !== aid.bx || b.y !== aid.by || g.terrain !== aid.terrain) aidResetSpot(g);
  const s = app.ui.settings;
  aid.level = aidLevel(s.puttAid, s.difficulty);
  let simmed = false;
  if (g.isPutt) {
    if (!aid.reader && !aid.read) aid.reader = new PuttReader(g.terrain, b, { lie: g.lie, wind: g.wind });
    if (aid.level !== 'off') {
      const power = aidPuttPower(g);
      const key = (Math.round(normalizeAngle(g.aimYaw) * 4000) * 4096 + Math.round(power * 2000)) * 16 + PUTT_RANGES.indexOf(g.puttRange) + 1;
      if (aid.throttle.want(key, now)) {
        const pv = previewPutt(g.terrain, { ball: b, lie: g.lie, aimYaw: g.aimYaw, power, puttRange: g.puttRange, wind: g.wind });
        const len = visibleEnd(pv.path, aid.level);
        aid.pvCount = drapePath(g.terrain, pv.path, len, aid.pvBuf);
        aid.pv = { kind: 'putt', holed: pv.holed, final: pv.final, power };
        aid.sims++;
        simmed = true;
      }
    } else aid.pvCount = 0;
    if (!simmed && aid.reader && !aid.reader.done && aid.reader.step()) {
      aid.read = aid.reader.result;
      aid.reader = null;
      app.targetPower = targetPower(g);
      app.ui.setTarget(app.targetPower);
      aid.throttle.reset(); // the idle preview follows the new notch
      updateReadCard();
    }
    aid.chipCount = 0;
  } else {
    aid.pvCount = 0;
    const lie = g.lie;
    const near = lie.surface !== SURF.GREEN && lie.greenDist <= CHIP_PREVIEW_M;
    if (near && aid.level !== 'off') {
      const power = app.swingPower != null ? app.swingPower : app.targetPower != null ? app.targetPower : 1;
      const key = (Math.round(normalizeAngle(g.aimYaw) * 4000) * 4096 + Math.round(power * 2000)) * 16;
      if (aid.throttle.want(key, now)) {
        const pv = previewShot(g.terrain, { ball: b, lie, clubId: g.club.id, aimYaw: g.aimYaw, power, wind: g.wind, shot: g.shotType, handed: s.handed });
        aid.chipCount = pv.landing ? drapePath(g.terrain, pv.path, Infinity, aid.chipBuf, { from: pv.landIndex, lift: 0.03, minStep: 0.25 }) : 0;
        aid.pv = { kind: 'chip', holed: pv.holed, final: pv.final, landing: pv.landing, power };
        aid.sims++;
      }
    } else aid.chipCount = 0;
  }
}

// scene.paths for the renderer (reused array and objects).
function aidPaths(g) {
  const out = aid.paths;
  out.length = 0;
  if (g.isPutt && aid.pvCount > 1 && aid.pv) {
    const p = aid.pathPutt;
    p.count = aid.pvCount;
    p.color = aid.pv.holed ? DROP_COLOR : PREVIEW_COLOR;
    p.ringR = aid.pv.holed ? 0.11 : 0.085;
    out.push(p);
  } else if (!g.isPutt && aid.chipCount > 1) {
    const p = aid.pathChip;
    p.count = aid.chipCount;
    p.color = aid.pv && aid.pv.holed ? DROP_COLOR : CHIP_COLOR;
    out.push(p);
  }
  return out;
}

// The read card (putting at address): pending until the read is in. Pro shows slope and plays only.
function updateReadCard() {
  const g = app.game;
  if (!g || g.phase !== 'address' || !g.isPutt || app.view === 'map' || app.view === 'flyover') {
    app.ui.setReadCard(null);
    return;
  }
  const rd = aidRead(g);
  if (!rd) {
    app.ui.setReadCard({ pending: true });
    return;
  }
  const pro = app.ui.getSetting('difficulty') === 'pro';
  const tx = readText(rd, units(), { showAim: !pro });
  app.ui.setReadCard({ line1: tx.line1, line2: tx.line2, canAim: !pro });
}

// "Aim at read": the caddie's line, with a putt range its pace fits (so the notch sits mid-arc).
function aimAtRead() {
  const g = app.game;
  const rd = g && g.phase === 'address' && g.isPutt ? aidRead(g) : null;
  if (!rd) return false;
  g.setAim(rd.aimYaw);
  const p = rd.F / g.puttRange;
  if (p > 0.85 || p < 0.3) g.setPuttRange(rangeForRead(rd.F));
  if (app.view !== 'play') setView('play');
  refreshClub();
  app.hudDirty = true;
  app.ui.toast('Aimed at the read · putt to the gold notch', 2600);
  saveGame();
  return true;
}

function setReadCam(v) {
  const g = app.game;
  if (!g || g.phase !== 'address') return;
  if (app.view !== 'read') setView('read');
  app.rig.setReadView(v);
  aid.cam = app.rig.readView;
  app.ui.setReadCam(aid.cam);
}

function onOrbit(dyaw) {
  app.rig.orbit(dyaw);
  if (aid.cam !== app.rig.readView) {
    aid.cam = app.rig.readView;
    app.ui.setReadCam(aid.cam);
  }
}

// Slope tags (putting): the cup's while lining up, the ball's and the cup's in Read; each a little
// off its point so the hole itself stays clear, with an arrow pointing downhill on screen.
const _tagSlope = { pct: 0, downYaw: 0 };
function updateSlopeTags(g) {
  const ui = app.ui;
  if (g.phase !== 'address' || !g.isPutt || (app.view !== 'read' && app.view !== 'play')) {
    ui.setSlopeTags(null);
    return;
  }
  const t = g.terrain;
  const r = app.renderer;
  const list = [];
  const add = (x, y, dx, dy) => {
    const z = t.heightAt(x, y);
    const p = r.project(x, y, z);
    if (!p.visible || p.sx < 0 || p.sy < 0 || p.sx > app.cssW || p.sy > app.cssH) return;
    const s = slopeAt(t, x, y, _tagSlope);
    const q = r.project(x + Math.cos(s.downYaw) * 0.6, y + Math.sin(s.downYaw) * 0.6, z - (s.pct / 100) * 0.6);
    const angle = Math.atan2(q.sy - p.sy, q.sx - p.sx);
    list.push({ x: p.sx + dx, y: p.sy + dy, text: `${s.pct < 10 ? s.pct.toFixed(1) : Math.round(s.pct)}%`, angle, band: slopeBand(s.pct) });
  };
  const c = t.cup;
  add(c.x, c.y, 58, -12);
  if (app.view === 'read') {
    const b = g.state.hole.ball;
    add(b.x, b.y, 0, 30);
  }
  ui.setSlopeTags(list);
}

// The golfer stays out of the read: hidden in the Read cameras, see-through while lining up a
// putt with a preview line (so it never covers the line). Applies to scene.golfer when the scene
// has one (section 9).
function applyGolferReadRule(scene) {
  const gs = scene.golfer;
  const g = app.game;
  if (!gs || !g || g.phase !== 'address') return;
  if (app.view === 'read') gs.visible = false;
  else if (g.isPutt && aid.pvCount > 1) gs.alpha = Math.min(gs.alpha == null ? 1 : gs.alpha, 0.45);
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
  if (studioFrame(time, dt)) return; // the Golfer customiser's preview while it is open
  const g = app.game;
  let cam;
  if (g && g.phase && g.terrain) {
    if (app.paused && app.drewPaused) return;
    cam = app.rig.update(dt * FAST, camCtx());
    app.drewPaused = app.paused;
  } else if (app.holeTerrain) {
    cam = menuCam(time);
  } else return;
  if (g && g.phase === 'address' && !app.paused) stepAid(performance.now() / 1000);
  const scene = buildScene(time, cam);
  applyGolferReadRule(scene);
  app.renderer.draw(scene);
  app.lastScene = scene;
  if (g && g.phase) updateLiveHud(g, cam, dt);
}

// Per-frame HUD bits: the wind arrow follows the camera; the distance to the pin counts down in
// flight; an aim drag refreshes the lie (sidehill / uphill labels depend on the aim).
function updateLiveHud(g, cam, dt) {
  updateSlopeTags(g);
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
  flushSwing(); // (a swing on its way down is struck with the settings it was made with)
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
    // Backswing depth (CSS px) for a swing power on the current pad (e2e swipe helpers). y0: the
    // touchdown y in page px (a swing started low in the pad has a shorter travel: swingTravel).
    depthForPower(power, kind = 'full', y0 = null) {
      const r = app.renderer.canvas ? app.renderer.canvas.getBoundingClientRect() : { top: 0 };
      const travel = y0 == null ? null : swingTravel(app.input.padRefH, kind, y0 - r.top, app.input.padRect);
      return depthForPower(power, app.input.padRefH, kind, travel);
    },
    state() {
      const g = app.game;
      if (!g) return { phase: 'menu', courseId: app.courseId };
      return {
        phase: g.phase,
        hole: g.state.holeIndex,
        strokes: g.state.hole.strokes,
        clubId: g.state.clubId,
        putt: g.isPutt,
        card: g.state.card.holes.map((h) => h.strokes),
        courseId: g.course.id,
        holeCourseId: g.courseOf().id,
        theme: g.terrain ? g.terrain.theme : null,
        mix: g.state.mix,
        holes: g.course.holes.length,
        shotType: g.shotType,
      };
    },
    // Green reading (section 8.9): put the ball d m from the cup on the green, at world yaw
    // angleDeg from it (the nearest green spot along that ray), with the putter; returns {x, y}.
    placeOnGreen(d = 6, angleDeg = 0) {
      const g = app.game;
      const t = g.terrain;
      const c = t.cup;
      const a = angleDeg * DEG;
      let x = c.x;
      let y = c.y;
      for (let r = d; r > 0.5; r -= 0.25) {
        x = c.x + Math.cos(a) * r;
        y = c.y + Math.sin(a) * r;
        if (t.surfaceAt(x, y) === SURF.GREEN) break;
      }
      g.debugPlace(x, y);
      if (!g.isPutt) changeClub(CLUBS.length);
      return { x, y };
    },
    // The aids' state: level, the read (and its words), the preview, the notch, sims run.
    aid() {
      const g = app.game;
      const rd = g ? aidRead(g) : null;
      const pv = aid.pv;
      return {
        level: aid.level,
        cam: app.rig.readView,
        // The camera has arrived where its mode wants it (within 5 cm).
        camSettled: (() => {
          const goal = app.rig._goal(0).eye;
          const e = app.rig.eye;
          return Math.hypot(goal.x - e.x, goal.y - e.y, Math.max(goal.z, e.z) - e.z) < 0.05;
        })(),
        view: app.view,
        read: rd ? { aimYaw: rd.aimYaw, F: rd.F, holed: rd.holed, breakLat: rd.breakLat, aimOffset: rd.aimOffset, plays: rd.plays, dz: rd.dz, sims: rd.sims, text: readText(rd, units(), { showAim: true }) } : null,
        reading: !!aid.reader,
        preview: pv ? { kind: pv.kind, holed: pv.holed, final: pv.final, power: pv.power, count: pv.kind === 'putt' ? aid.pvCount : aid.chipCount } : null,
        aimYaw: g ? g.aimYaw : null,
        puttRange: g ? g.puttRange : null,
        targetPower: app.targetPower,
        sims: aid.sims,
        card: app.ui.el.readcard ? { hidden: app.ui.el.readcard.hidden, text: app.ui.el.readcard.textContent.replace(/\s+/g, ' ').trim() } : null,
      };
    },
    aimAtRead,
    readCam: setReadCam,
    // Mixed 18 tests: record the holes before i (par + toPar[k] strokes each) and load hole i.
    skipTo(i, toPar = []) {
      const g = app.game;
      g.debugSkipTo(i, (k, par) => par + (toPar[k] || 0));
      saveGame();
      return g.state.holeIndex;
    },
    // The golfer (section 9.7): his animation state, what he holds, where he stands (screen px of
    // his chest and pelvis) and the last launch ({strikeAt, launchAt, tImpact} in game seconds,
    // headErr: club head to ball at the launch, m).
    golferState() {
      const A = golfer.anim;
      const g = app.game;
      if (!A) return null;
      const r = app.renderer;
      const at = (bone) => {
        const p = A.jointWorld(bone);
        const q = r.project(p.x, p.y, p.z);
        return { x: p.x, y: p.y, z: p.z, sx: q.sx, sy: q.sy, visible: q.visible };
      };
      return {
        shown: golferShown(g),
        drawn: !!(app.lastScene && app.lastScene.golfer && app.lastScene.golfer.visible !== false),
        state: A.state,
        u: A.u,
        power: A.power,
        club: A.club,
        shot: A.shot,
        handed: A.handed,
        style: A.style,
        kind: A.kind,
        placed: golfer.key !== '',
        frame: golfer.frame,
        pending: !!golfer.pending,
        tImpact: golfer.pending ? golfer.pending.tImpact : null,
        last: golfer.last,
        clock: golfer.clock,
        look: golfer.look,
        chest: at(2),
        pelvis: at(0),
        head: at(4),
        mirror: A.rig.mirror,
        framing: app.rig.framing,
      };
    },
    // The club head's impact point (world and screen) and the ball.
    clubHead() {
      const A = golfer.anim;
      const g = app.game;
      if (!A) return null;
      const h = A.clubHeadWorld();
      const q = app.renderer.project(h.x, h.y, h.z);
      const b = g ? g.ballPos() : null;
      return { x: h.x, y: h.y, z: h.z, sx: q.sx, sy: q.sy, ball: b, dist: b ? Math.hypot(h.x - b.x, h.y - b.y, h.z - b.z) : null };
    },
    // Draw without the golfer (pixel and draw-call comparisons), freeze the frame (screenshots),
    // freeze on the next impact frame.
    hideGolfer(on = true) {
      golfer.hidden = !!on;
      app.drewPaused = false;
    },
    freeze(on = true) {
      app.frozen = !!on;
      app.lastTime = 0;
    },
    freezeAtImpact: false,
  };
}

// ================================================================== golfer customiser
// (section 9, Customiser) The Golfer screen (customiser.js) opens from the Golfer buttons on the menu
// and the pause sheet (ui 'golfer'). While it is open, this section draws the studio preview instead
// of the game or the menu backdrop: the golfer at address on the tee of the hole on the renderer
// (the menu's course, or the hole being played), lit by a key light beside the camera, turned and
// zoomed by the customiser's view (drag, pinch, tabs) and framed in its see-through stage by a lens
// shift (cam.shiftX / shiftY). Look changes rebuild the mesh (kept per look and club; slider drags
// are throttled by the customiser) and re-fit the rig when the body changes; Try swing plays a full
// swing in the look's style with the preview club (whoosh and strike; the ball is gone until he is
// back at address). Done saves the look (customiser.js) and hands it to the game
// (app.applyGolferLook rebuilds the in-game golfer at once); Cancel changes nothing. The frame
// allocates nothing. Hooks: initCustomiser() in boot, studioFrame() at the top of render().
const STUDIO_HALF_FOV = 14 * DEG; // half the vertical field of view inside the stage's frame
const STUDIO_HOLD_S = 1.3; // the finish is held this long before he steps back to address
const STUDIO_MESHES = 8; // meshes kept (looks and clubs flicked back and forth rebuild nothing)
const STUDIO_WHOOSH_LEAD = 0.16; // s: the whoosh starts this long before impact (it peaks there)
const STUDIO_IMPACT = { D: 'driver', '7i': 'iron', SW: 'wedge', P: 'putter' };
const studio = {
  on: false,
  anim: null,
  mesh: null,
  meshes: new Map(),
  look: null,
  club: 'D',
  terrain: null,
  H: 1.8,
  ground: 0,
  fx: 1, // the way he faces (toward the ball line), a horizontal unit vector
  fy: 0,
  hand: 1, // 1 right-handed, -1 left-handed
  swing: 0, // 0 at address, 1 swinging, 2 holding the finish, 3 stepping back
  t: 0,
  tImpact: 0,
  whoosh: false,
  ballOut: false,
  swings: 0, // swings started and impacts shown (tests)
  impacts: 0,
  pel: { x: 0, y: 0, z: 0 },
  head: { x: 0, y: 0, z: 0 },
  gaze: 0, // 0..1: how far his head turns from the ball to the camera (the face close-up)
  ballG: new Float64Array(3), // the rig's own head target (the ball in his frame)
  cam: { eye: { x: 0, y: 0, z: 0 }, target: { x: 0, y: 0, z: 0 }, up: { x: 0, y: 0, z: 1 }, fovY: 0.5, near: 0.1, far: 3000, shiftX: 0, shiftY: 0 },
  scene: null,
};
studio.scene = {
  time: 0,
  cam: studio.cam,
  ball: { x: 0, y: 0, z: 0, visible: true, minPx: 0 },
  trail: null,
  aim: null,
  pin: { visible: true },
  wind: { x: 1.2, y: 0.5 },
  read: { on: false },
  sunDir: { x: 0, y: 0, z: 1 },
  golfer: { visible: true, mesh: null, bones: null, alpha: 1, fadeNear: false },
};

function initCustomiser() {
  app.customiser = new Customiser(document, {
    onChange: studioLook,
    onClub: studioClub,
    onTry: studioTry,
    onDone: (look) => {
      if (app.applyGolferLook) app.applyGolferLook(look);
    },
    onClose: closeStudio,
  });
  renderAvatars(document, studioLoadLook());
  app.ui.on('golfer', openCustomiser);
  if (app.debug) {
    app.debug.studio = () => ({
      open: !!(app.customiser && app.customiser.isOpen),
      look: studio.look && { ...studio.look },
      club: studio.club,
      meshKey: studio.mesh ? studio.mesh.key : null,
      state: studio.anim ? studio.anim.state : null,
      swing: studio.swing,
      swings: studio.swings,
      impacts: studio.impacts,
      ballOut: studio.ballOut,
      frame: app.customiser && { ...app.customiser.frameRect },
      shift: [studio.cam.shiftX, studio.cam.shiftY],
    });
    if (!app.debug.golferLook) app.debug.golferLook = () => (app.golfer && app.golfer.look ? { ...app.golfer.look } : null);
  }
}

function openCustomiser() {
  const cz = app.customiser;
  if (!cz || cz.isOpen) return;
  cz.open(studioLoadLook(), { from: app.game ? 'pause' : 'menu' });
  studio.look = { ...cz.look };
  studio.club = cz.club;
  studio.on = true;
  studioPlace();
  updateInputMode();
}

// Done or Cancel: back to the menu backdrop or the paused game (drawn once more under the sheet).
function closeStudio() {
  studio.on = false;
  studio.meshes.clear();
  studio.mesh = null;
  studio.scene.golfer.mesh = null;
  app.drewPaused = false;
  app.lastTime = 0;
  updateInputMode();
}

// The golfer at address on the tee (the ball teed there), facing down the hole.
function studioPlace() {
  const t = app.holeTerrain;
  studio.terrain = t;
  let x = 0;
  let y = 0;
  let yaw = Math.PI / 2;
  if (t) {
    const tee = t.tee;
    const ap = t.aimPoint ? t.aimPoint(tee) : t.cup;
    x = tee.x;
    y = tee.y;
    yaw = Math.atan2(ap.y - tee.y, ap.x - tee.x);
  }
  const gz = t ? t.heightAt(x, y) : 0;
  const ball = studio.scene.ball;
  ball.x = x;
  ball.y = y;
  ball.z = gz + STUDIO_BALL_R;
  const handed = app.ui.getSetting('handed') === 'L' ? 'L' : 'R';
  const opts = { ball: { x, y, z: ball.z }, aimYaw: yaw, terrain: t || null, ground: t ? null : () => 0, handed, club: studio.club, look: studio.look };
  if (!studio.anim) studio.anim = new StudioAnimator(studio.look, opts);
  else studio.anim.place(opts);
  studio.anim.style = studio.look.swing;
  studio.hand = handed === 'L' ? -1 : 1;
  // Facing: right(aim) for a right-hander, its mirror for a left-hander.
  studio.fx = Math.sin(yaw) * studio.hand;
  studio.fy = -Math.cos(yaw) * studio.hand;
  studio.ground = gz;
  studio.H = studio.look.height / 100;
  studio.anim.jointWorld(STUDIO_BONES.pelvis, studio.pel);
  studio.ballG.set(studio.anim.rig.ballG);
  studio.gaze = 0;
  studioSwingDone();
  studioMeshNow();
}

function studioMeshNow() {
  const k = `${studioLookKey(studio.look)}#${studio.club}`;
  let m = studio.meshes.get(k);
  if (m) studio.meshes.delete(k);
  else m = buildStudioMesh(studio.look, studio.club);
  studio.meshes.set(k, m);
  while (studio.meshes.size > STUDIO_MESHES) studio.meshes.delete(studio.meshes.keys().next().value);
  studio.mesh = m;
}

// A look change from the customiser: the mesh always, the rig only when the body changed (which
// ends a swing in progress); the swing style takes effect on the next swing.
function studioLook(look) {
  if (!studio.on) return;
  const prev = studio.look;
  studio.look = { ...look };
  if (prev.body !== look.body || prev.height !== look.height || prev.build !== look.build) studioPlace();
  else {
    studio.anim.look = studio.look;
    if (studio.swing === 0) studio.anim.style = look.swing;
    studioMeshNow();
  }
}

function studioClub(id) {
  if (!studio.on) return;
  studio.club = id;
  studioPlace();
}

function studioTry() {
  const A = studio.anim;
  if (!studio.on || !A || studio.swing === 1) return;
  if (A.state !== 'address') A.reset();
  studioSwingDone();
  studioLookAt(0); // eyes back on the ball
  const putt = studio.club === 'P';
  const power = putt ? 0.5 : 1;
  A.style = studio.look.swing;
  studio.tImpact = A.strike({
    power,
    style: studio.look.swing,
    onImpact: () => {
      studio.ballOut = true;
      studio.impacts++;
      app.audio.impact(STUDIO_IMPACT[studio.club] || 'iron', power);
    },
  });
  studio.t = 0;
  studio.whoosh = putt;
  studio.swing = 1;
  studio.swings++;
  app.customiser.setSwinging(true);
}

function studioSwingDone() {
  studio.swing = 0;
  studio.t = 0;
  studio.ballOut = false;
  if (app.customiser) app.customiser.setSwinging(false);
}

// Per frame while the customiser is open (called first in render()): true = drawn here.
function studioFrame(time, dt) {
  if (!studio.on) return false;
  const A = studio.anim;
  const cz = app.customiser;
  if (!A || !cz) return true;
  const sdt = dt * FAST; // the swing plays at ?fast like the game's (the camera does not)
  // The swing: whoosh before impact, hold the finish, then ease back to address.
  if (studio.swing === 1) {
    studio.t += sdt;
    if (!studio.whoosh && studio.tImpact - studio.t <= STUDIO_WHOOSH_LEAD) {
      studio.whoosh = true;
      app.audio.handle({ type: 'swing', power: 1 });
    }
    if (A.state === 'finish' || (A.state === 'follow' && studio.club === 'P' && studio.t > studio.tImpact + 0.9)) {
      studio.swing = 2;
      studio.t = 0;
    }
  } else if (studio.swing === 2) {
    studio.t += sdt;
    if (studio.t >= STUDIO_HOLD_S) {
      A.cancel();
      studio.swing = 3;
    }
  } else if (studio.swing === 3 && A.state === 'address') studioSwingDone();
  // Face close-up at address: he looks up at the camera.
  const want = studio.swing === 0 && A.state === 'address' && cz.view.zoom > 0.45 ? 1 : 0;
  studioLookAt(studio.gaze + (want - studio.gaze) * (1 - Math.exp(-4 * dt)));
  // In steps of at most 0.1 s (the animator's own clamp), stopping on the impact frame so it is drawn.
  let left = Math.min(sdt, 1);
  for (let i = 0; i < 10 && left > 1e-6; i++) {
    const step = Math.min(0.1, left);
    left -= step;
    const before = A.state;
    A.update(step);
    if (before === 'downswing' && A.state === 'follow') break;
  }
  const v = cz.stepView(dt);
  if (app.renderer.isNull) return true;
  studioCamera(v, cz.frameRect);
  const s = studio.scene;
  s.time = time;
  s.ball.visible = !studio.ballOut;
  s.golfer.mesh = studio.mesh;
  s.golfer.bones = A.bones;
  app.renderer.draw(s);
  return true;
}

// His head's look target (swing-anim.js aims the head at rig.ballG; the keys were solved from the
// ball at placement, so at run time only the head reads it): from the ball (w 0) toward the camera
// (w 1), written in his frame G (rig.W is G -> world: a rotation, mirrored for a left-hander).
function studioLookAt(w) {
  studio.gaze = w < 0.002 ? 0 : w;
  const rig = studio.anim && studio.anim.rig;
  if (!rig) return;
  const bg = rig.ballG;
  const b0 = studio.ballG;
  if (!studio.gaze) {
    bg[0] = b0[0];
    bg[1] = b0[1];
    bg[2] = b0[2];
    return;
  }
  const W = rig.W;
  const e = studio.cam.eye;
  const px = e.x - W[12];
  const py = e.y - W[13];
  const pz = e.z - W[14];
  const k = studio.gaze;
  bg[0] = b0[0] + (W[0] * px + W[1] * py + W[2] * pz - b0[0]) * k;
  bg[1] = b0[1] + (W[4] * px + W[5] * py + W[6] * pz - b0[1]) * k;
  bg[2] = b0[2] + (W[8] * px + W[9] * py + W[10] * pz - b0[2]) * k;
}

// The preview camera: full body (zoom 0) to the face (zoom 1), wider for the swing (zoom < 0),
// round the golfer by the view's yaw (0 = face on, + toward his target side), framed in the
// stage's frame rect with a lens shift. Writes studio.cam and the key light (scene.sunDir).
function studioCamera(v, fr) {
  const s = studio;
  const H = s.H;
  const c = s.cam;
  const zf = clamp(v.zoom, 0, 1);
  const e = zf * zf * (3 - 2 * zf);
  const wide = clamp(-v.zoom, 0, 0.6);
  // Targets: the middle of the figure at address; the face (the head bone sits at the chin).
  s.anim.jointWorld(STUDIO_BONES.head, s.head);
  const k = H / 1.8;
  const bx = s.pel.x + s.fx * 0.16 * k;
  const by = s.pel.y + s.fy * 0.16 * k;
  const bz = s.ground + (0.44 + 0.16 * wide) * H;
  const hx = s.head.x + s.fx * 0.05 * k;
  const hy = s.head.y + s.fy * 0.05 * k;
  const hz = s.head.z + 0.09 * k;
  const tx = bx + (hx - bx) * e;
  const ty = by + (hy - by) * e;
  const tz = bz + (hz - bz) * e;
  // Distance: the body's half-height (and the club) fills the frame; the face about 0.2 m.
  const tanH = Math.tan(STUDIO_HALF_FOV);
  const dBody = ((0.6 + 0.75 * wide) * H + 0.1) / tanH;
  const dFace = 0.3 / tanH;
  const d = dBody * Math.pow(dFace / dBody, e);
  const elev = 0.07 - 0.09 * e + v.pitch;
  const a = v.yaw * s.hand;
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  const dx = s.fx * ca - s.fy * sa;
  const dy = s.fx * sa + s.fy * ca;
  const ce = Math.cos(elev);
  c.target.x = tx;
  c.target.y = ty;
  c.target.z = tz;
  c.eye.x = tx + dx * d * ce;
  c.eye.y = ty + dy * d * ce;
  c.eye.z = tz + d * Math.sin(elev);
  const t = s.terrain;
  if (t) c.eye.z = Math.max(c.eye.z, t.heightAt(c.eye.x, c.eye.y) + 0.25);
  // Lens: the frame rect's own field of view, centred on it.
  const W = Math.max(1, app.cssW);
  const Hc = Math.max(1, app.cssH);
  c.fovY = 2 * Math.atan((tanH * Hc) / Math.max(40, fr.h));
  c.shiftX = (2 * (fr.x + fr.w / 2)) / W - 1;
  c.shiftY = 1 - (2 * (fr.y + fr.h / 2)) / Hc;
  c.near = clamp(d * 0.25, 0.08, 0.6);
  // Key light from beside the camera (up and to its left), so the face is always lit.
  const kl = a + 0.6 * s.hand;
  const sun = s.scene.sunDir;
  sun.x = (s.fx * Math.cos(kl) - s.fy * Math.sin(kl)) * 0.72;
  sun.y = (s.fx * Math.sin(kl) + s.fy * Math.cos(kl)) * 0.72;
  sun.z = 0.69;
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
  initGolfer();
  app.input = new InputController(canvas, {
    onAim,
    onSwingStart: () => app.ui.setHint(null),
    onSwingProgress,
    onSwing,
    onSwingCancel,
    onPadTap,
    onOrbit,
    onTap,
    onSkip,
  });
  app.input.swingStyle = settings.swing;
  app.courseId = COURSE_PARAM || loadCourseChoice() || DEFAULT_COURSE_ID;
  if (TEST) installDebugHooks();

  // From the menu: the picked course; Play again (final card) and Restart: the round's own (a
  // mixed round: Restart keeps its nine holes, Play again draws a new nine).
  const replayCourse = () => newRound(app.game ? app.game.course.id : app.courseId);
  ui.on('new-round', replayCourse);
  ui.on('resume', resumeGame);
  ui.on('restart', () => newRound(app.game ? app.game.course.id : app.courseId, app.game && app.game.course.mixed ? app.game.course.picks : null));
  ui.on('course', selectCourse);
  ui.on('shots', openShots);
  ui.on('shot', pickShot);
  ui.on('shots-closed', updateInputMode);
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
  ui.on('read-cam', setReadCam);
  ui.on('aim-read', aimAtRead);
  ui.on('map', () => setView(app.view === 'map' ? 'play' : 'map'));
  ui.on('flyover', () => setView('flyover'));
  ui.on('putt-range+', () => app.game && (app.game.stepPuttRange(1), refreshClub()));
  ui.on('putt-range-', () => app.game && (app.game.stepPuttRange(-1), refreshClub()));
  ui.on('layout', () => {
    app.sizeKey = '';
    resize();
  });
  ui.onChange(onSettings);
  initCustomiser(); // the Golfer customiser (section 9, Customiser)

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
      flushSwing(); // a swing on its way down is struck before the save
      saveGame();
    } else {
      app.audio.resume();
      app.lastTime = 0;
      if (app.game) requestWakeLock();
    }
  });
  globalThis.addEventListener('pagehide', () => {
    flushSwing();
    saveGame();
  });

  // Build the menu backdrop (hole 1) after the spinner has painted.
  ui.setLoading(true, 'Loading course');
  requestAnimationFrame(() =>
    setTimeout(() => {
      try {
        if (!app.renderer.isNull) {
          const { def, course } = backdropHole(app.courseId);
          app.backdropCourse = app.courseId;
          app.holeTerrain = cachedBuildHole(def, { pinIndex: 0, seed: TREE_SEED, course });
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
