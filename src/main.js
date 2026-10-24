// App entry: wires the match state machine (game.js + physics), renderer, touch input, UI, audio
// and the CPU player into one requestAnimationFrame loop.

import { TABLE } from './table.js';
import { computeView } from './layout.js';
import { traceAim } from './aim.js';
import { Renderer } from './render.js';
import { InputController } from './input.js';
import { UI } from './ui.js';
import { Game } from './game.js';
import { planTurn, chooseDecision } from './ai.js';
import { AudioFX } from './audio.js';

const SAVE_KEY = 'pool8.save.v1';
const STROKE_TIME = 0.09; // s, forward cue stroke before the ball is struck
const MIN_THINK_MS = 800; // the CPU never answers instantly

const params = new URLSearchParams(globalThis.location ? location.search : '');
const DEBUG = params.has('debug');
const AUTOPLAY = params.get('autoplay');

const app = {
  game: null,
  config: null,
  ui: null,
  renderer: null,
  input: null,
  audio: new AudioFX(),
  view: null,
  viewKey: '',
  paused: false,
  aim: { angle: 0, power: 0, spin: { x: 0, y: 0 }, call: null, callExplicit: false },
  stroke: null, // human stroke animation {t, shot, pull}
  cpu: null, // CPU turn: {phase:'think'|'place'|'aim'|'pull'|'stroke', t, plan, ...}
  token: 0, // bumped whenever a game starts or ends so stale async work is dropped
  cpuEpoch: 0, // bumped whenever the board is reset mid-game so an in-flight CPU plan is dropped
  placing: false,
  lastTime: 0,
  frameMs: 0,
  wakeLock: null,
};

// ---------- persistence ----------
// localStorage can be missing or throw (private browsing, sandboxed iframes), so the latest save
// is also kept in memory: "Resume" then still works for the rest of the session.
let memSave = null;
let persisted = false; // whether the last save reached localStorage

function saveGame() {
  if (!app.game || AUTOPLAY) return;
  if (app.game.phase === 'matchOver') {
    clearSave(); // nothing to resume once the match is decided
    return;
  }
  memSave = JSON.stringify({ config: app.config, game: app.game.serialize() });
  try {
    localStorage.setItem(SAVE_KEY, memSave);
    persisted = true;
  } catch {
    persisted = false;
  }
}

function loadSave() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    /* fall back to the in-memory copy */
  }
  return memSave ? JSON.parse(memSave) : null;
}

function clearSave() {
  memSave = null;
  try {
    localStorage.removeItem(SAVE_KEY);
  } catch {
    /* ignore */
  }
}

// ---------- layout ----------
function resize() {
  const wrap = document.getElementById('table-wrap');
  const w = Math.max(1, Math.round(wrap.clientWidth));
  const h = Math.max(1, Math.round(wrap.clientHeight));
  const dpr = Math.min(3, globalThis.devicePixelRatio || 1);
  const key = `${w}x${h}@${dpr}`;
  if (key === app.viewKey) return; // rebuilding the static layers costs ~100 ms
  app.viewKey = key;
  app.view = computeView(w, h);
  app.renderer.setView(app.view, dpr);
  app.drewPaused = false; // setView clears the canvas; draw it again even when paused
}

// ---------- helpers ----------
function isHumanTurn() {
  const g = app.game;
  return !!g && g.players[g.state.turn].kind === 'human';
}

function defaultAimAngle() {
  // Point at the nearest legal target (the head ball on the break).
  const g = app.game;
  const req = g.requirements();
  const cue = g.cuePosition();
  let best = null;
  let bestD = Infinity;
  // After a break scratch, balls behind the head string can't be hit directly.
  const blocked = new Set(req.kitchenBlocked || []);
  const legal = req.legalTargets || [];
  const open = legal.filter((id) => !blocked.has(id));
  for (const id of open.length ? open : legal) {
    const b = g.state.balls[id];
    if (!b || !b.on) continue;
    const d = Math.hypot(b.x - cue.x, b.y - cue.y);
    if (d < bestD) {
      bestD = d;
      best = b;
    }
  }
  return best ? Math.atan2(best.y - cue.y, best.x - cue.x) : 0;
}

function setAim(angle) {
  app.aim.angle = angle;
  app.input.angle = angle;
}

function resetShotControls() {
  app.aim.power = 0;
  app.aim.spin = { x: 0, y: 0 };
  app.aim.call = null;
  app.aim.callExplicit = false;
  app.input.power = 0;
  app.input.spin = { x: 0, y: 0 };
  app.ui.setSpinIndicator({ x: 0, y: 0 });
}

function updateInputMode() {
  const g = app.game;
  if (!g) {
    app.input.setMode({ enabled: false, ballInHand: false, mustCallPocket: false });
    return;
  }
  const req = g.requirements();
  const enabled = isHumanTurn() && g.phase === 'aim' && !app.stroke && !app.paused;
  app.input.setMode({
    enabled,
    ballInHand: enabled && !!req.ballInHand,
    cue: g.cuePosition(),
    mustCallPocket: enabled && !!req.mustCallPocket,
  });
}

function refreshHud() {
  const g = app.game;
  if (!g) return;
  const hud = g.hud();
  hud.kitchenBlocked = (g.requirements().kitchenBlocked || []).length;
  // Prompts like "Ball in hand" are for the human holding the phone, not the CPU.
  if (!isHumanTurn()) hud.hint = '';
  app.ui.updateHud(hud);
}

// ---------- game lifecycle ----------
function bindGame(game) {
  app.game = game;
  app.token++;
  app.stroke = null;
  app.cpu = null;
  app.paused = false;
  app.renderer.reset();
  app.ui.setThinking(false);
  const token = app.token;
  const live = () => token === app.token;

  game.on('state', () => {
    if (!live()) return;
    refreshHud();
    updateInputMode();
  });
  game.on('message', ({ text, kind }) => {
    if (!live()) return;
    // "Player 2's shot" is already shown by the turn pill (and the pass-and-play banner).
    if (kind === 'info' && text === game.hud().banner) return;
    app.ui.toast(text, kind);
  });
  game.on('physics', (events) => {
    if (!live()) return;
    app.audio.handle(events);
    for (const ev of events) {
      if (ev.type === 'pocket') app.renderer.onPocket(ev, game.world.balls[ev.ball]);
    }
  });
  game.on('shotStart', () => live() && updateInputMode());
  game.on('shotEnd', () => {
    if (!live()) return;
    resetShotControls();
    if (isHumanTurn()) {
      setAim(defaultAimAngle());
      // Pass-and-play: tell whose turn it is when the table changes hands.
      const st = game.state;
      const prev = st.history && st.history.length ? st.history[st.history.length - 1].shooter : st.turn;
      if (app.config.mode === 'pvp' && prev !== st.turn && game.phase === 'aim') {
        app.ui.banner(`${game.players[st.turn].name} — your shot`);
      }
    }
    saveGame();
  });
  game.on('decision', ({ decision }) => {
    if (!live()) return;
    if (game.players[decision.chooser].kind === 'cpu') {
      setTimeout(() => live() && game.phase === 'decision' && game.decide(chooseDecision(decision)), 900);
    } else {
      app.ui.showDecision(decision);
    }
  });
  game.on('rackOver', (info) => {
    if (!live()) return;
    saveGame();
    if (game.phase === 'matchOver') return; // the matchOver event follows immediately
    app.ui.showRackOver({ ...info, raceTo: game.raceTo });
    if (AUTOPLAY) setTimeout(() => live() && game.nextRack(), 1200);
  });
  game.on('matchOver', (info) => {
    if (!live()) return;
    clearSave();
    app.ui.showMatchOver({ ...info, raceTo: game.raceTo });
    if (AUTOPLAY) globalThis.__poolDone = true;
  });
  game.on('cpuTurn', ({ level }) => live() && runCpuTurn(level, token));

  resetShotControls();
  setAim(defaultAimAngle());
  refreshHud();
  updateInputMode();
  requestWakeLock();
  if (game.phase === 'toss') app.ui.banner('Tossing for the break…', 1200);
}

function startGame(config) {
  app.config = config;
  const seed = (Date.now() ^ Math.floor(Math.random() * 0x7fffffff)) >>> 0;
  bindGame(new Game({ config, seed, table: TABLE }));
  app.ui.hideMenu();
  saveGame();
}

function resumeGame() {
  const save = loadSave();
  if (!save) return;
  try {
    const game = Game.restore(save.game, { table: TABLE });
    app.config = save.config || game.match.config;
    app.ui._config = app.config;
    app.ui._mode = app.config.mode;
    bindGame(game);
    app.ui.hideMenu();
    // Game re-emits 'state' / pending decisions / cpuTurn on its first update after a restore.
  } catch (err) {
    console.warn('Could not restore the saved match', err);
    clearSave();
    app.ui.setResumeAvailable(false);
    app.ui.showMenu();
  }
}

function quitToMenu() {
  saveGame();
  dropCpuWork();
  app.token++;
  app.game = null;
  app.stroke = null;
  app.cpu = null;
  app.paused = false;
  app.renderer.reset();
  app.ui.setThinking(false);
  app.ui.setResumeAvailable(!!loadSave());
  updateInputMode();
  releaseWakeLock();
}

function freshRackControls() {
  dropCpuWork();
  app.renderer.reset();
  resetShotControls();
}

// Forget any CPU plan being computed or animated (the board is about to change).
function dropCpuWork() {
  app.cpuEpoch++;
  app.cpu = null;
  app.stroke = null;
  app.ui.setThinking(false);
}

// ---------- shooting ----------
function humanShoot({ angle, power, spin }) {
  const g = app.game;
  if (!g || g.phase !== 'aim' || !isHumanTurn() || app.stroke || app.paused) return;
  const req = g.requirements();
  if (req.mustCallPocket && app.aim.call == null) {
    app.ui.toast('Tap a pocket to call the 8-ball', 'info');
    app.input.power = 0;
    return;
  }
  app.aim.angle = angle;
  const shot = {
    angle,
    power,
    spin: { x: spin.x, y: spin.y },
    call: req.mustCallPocket ? { pocket: app.aim.call } : null,
  };
  app.stroke = { t: 0, shot, pull: power };
  updateInputMode();
}

function tickStroke(dt) {
  const s = app.stroke;
  if (!s) return;
  s.t += dt;
  if (s.t < STROKE_TIME) return;
  app.stroke = null;
  const res = app.game.shoot(s.shot);
  app.aim.power = 0;
  app.input.power = 0;
  if (res && res.ok === false) {
    const msg = {
      MISSING_CALL: 'Tap a pocket to call the 8-ball',
      BALL_IN_HAND_UNPLACED: 'Place the cue ball first',
    }[res.error];
    app.ui.toast(msg || 'That shot is not allowed', 'info');
  }
  updateInputMode();
}

// ---------- CPU ----------
function yieldToBrowser() {
  return new Promise((resolve) => {
    if (typeof MessageChannel !== 'undefined') {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => resolve();
      ch.port2.postMessage(0);
    } else setTimeout(resolve, 0);
  });
}

async function runCpuTurn(level, token) {
  const g = app.game;
  if (!g || token !== app.token || app.cpu || g.phase !== 'aim' || isHumanTurn()) return;
  const st0 = g.state; // replaced by restart / concede / decisions / new racks
  const epoch = ++app.cpuEpoch;
  app.cpu = { phase: 'think' };
  app.ui.setThinking(true);
  const t0 = performance.now();
  let plan = null;
  try {
    plan = await planTurn(g.state, {
      level: level || 'medium',
      seed: (Math.imul(g.state.shotNo + 1, 2654435761) ^ (g.match.rng >>> 0) ^ g.state.rackNo) >>> 0,
      table: TABLE,
      yieldFn: yieldToBrowser,
      now: () => performance.now(),
      budgetMs: 2500,
    });
  } catch (err) {
    console.error('CPU planning failed', err);
  }
  const wait = MIN_THINK_MS - (performance.now() - t0);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  const stale =
    token !== app.token || app.game !== g || g.phase !== 'aim' || g.state !== st0 || epoch !== app.cpuEpoch;
  if (stale) {
    if (token === app.token && epoch === app.cpuEpoch) {
      app.cpu = null;
      app.ui.setThinking(false);
    }
    return;
  }
  app.ui.setThinking(false);
  if (!plan || !plan.shot) {
    plan = { place: null, shot: { angle: defaultAimAngle(), power: 0.35, spin: { x: 0, y: 0 }, call: null } };
  }
  const from = g.cuePosition();
  app.cpu = {
    phase: plan.place ? 'place' : 'aim',
    t: 0,
    plan,
    from: { x: from.x, y: from.y },
    startAngle: app.aim.angle,
    token,
  };
}

const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

function shortestDelta(a, b) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

// Animates the CPU like a person: move the cue ball (ball in hand), swing the cue onto the line,
// draw it back, then stroke through.
function tickCpu(dt) {
  const c = app.cpu;
  const g = app.game;
  if (!c || c.phase === 'think' || !g) return;
  if (c.token !== app.token || g.phase !== 'aim' || isHumanTurn()) {
    app.cpu = null;
    return;
  }
  c.t += dt;
  const { shot, place } = c.plan;
  if (c.phase === 'place') {
    const dur = 0.5;
    const k = ease(Math.min(1, c.t / dur));
    g.placeCue(c.from.x + (place.x - c.from.x) * k, c.from.y + (place.y - c.from.y) * k);
    if (c.t >= dur) {
      g.placeCue(place.x, place.y);
      Object.assign(c, { phase: 'aim', t: 0, startAngle: app.aim.angle });
    }
  } else if (c.phase === 'aim') {
    const delta = shortestDelta(c.startAngle, shot.angle);
    const dur = 0.35 + Math.min(0.6, Math.abs(delta) * 0.35);
    app.aim.angle = c.startAngle + delta * ease(Math.min(1, c.t / dur));
    if (c.t >= dur + 0.2) {
      app.aim.angle = shot.angle;
      Object.assign(c, { phase: 'pull', t: 0 });
    }
  } else if (c.phase === 'pull') {
    const dur = 0.3 + 0.4 * shot.power;
    app.aim.power = shot.power * ease(Math.min(1, c.t / dur));
    if (c.t >= dur + 0.18) Object.assign(c, { phase: 'stroke', t: 0 });
  } else if (c.phase === 'stroke' && c.t >= STROKE_TIME) {
    app.cpu = null;
    app.aim.power = 0;
    const res = g.shoot(shot);
    if (res && res.ok === false) {
      // Never let the game stall on a bad plan: fall back to a gentle legal-looking shot.
      console.warn('CPU shot rejected', res, shot);
      const req = g.requirements();
      g.shoot({
        angle: defaultAimAngle(),
        power: 0.35,
        spin: { x: 0, y: 0 },
        call: req.mustCallPocket ? { pocket: 0 } : null,
      });
    }
  }
}

// ---------- scene ----------
// Rings on the balls you may hit: your group once groups are set, and after a break scratch the
// balls outside the kitchen (on a plain open table every ball is legal, so none are ringed).
function highlightTargets(g, req) {
  const legal = req.legalTargets || [];
  const blocked = req.kitchenBlocked || [];
  if (blocked.length) return legal.filter((id) => !blocked.includes(id));
  return g.state.groups[g.state.turn] ? legal : [];
}
function buildScene(time) {
  const g = app.game;
  if (!g) return { time, balls: [], cue: null, guide: null, ballInHand: null, targets: [], pockets: null };
  const req = g.requirements();
  const human = isHumanTurn();
  const aiming = g.phase === 'aim';
  const cuePos = g.cuePosition();
  const cpuShowing = !!app.cpu && app.cpu.phase !== 'think' && app.cpu.phase !== 'place';
  if (human && !app.stroke) app.aim.angle = app.input.angle;
  const angle = app.aim.angle;

  let pull = human ? app.input.power : app.aim.power;
  let stroke = 0;
  if (app.stroke) {
    pull = app.stroke.pull;
    stroke = Math.min(1, app.stroke.t / STROKE_TIME);
  } else if (app.cpu && app.cpu.phase === 'stroke') {
    pull = app.cpu.plan.shot.power;
    stroke = Math.min(1, app.cpu.t / STROKE_TIME);
  }
  const showCue = aiming && (human || cpuShowing) && !app.placing;
  const scene = {
    time,
    balls: g.world.balls,
    cue: showCue ? { x: cuePos.x, y: cuePos.y, angle, pull, stroke, visible: true } : null,
    guide:
      aiming && human && app.ui.settings.aimGuide && !app.stroke && !app.placing
        ? { x: cuePos.x, y: cuePos.y, angle, length: 0 }
        : null,
    ballInHand:
      aiming && req.ballInHand && (human || (app.cpu && app.cpu.phase === 'place'))
        ? { x: cuePos.x, y: cuePos.y, valid: true, dragging: app.placing || (!!app.cpu && app.cpu.phase === 'place') }
        : null,
    targets: aiming && human && !app.stroke && pull === 0 ? highlightTargets(g, req) : [],
    pockets: null,
  };
  if (aiming && req.mustCallPocket) {
    if (human) {
      if (!app.aim.callExplicit) {
        const tr = traceAim(g.world.balls, cuePos.x, cuePos.y, angle, TABLE.pockets);
        app.aim.call = tr.type === 'ball' && tr.ball === 8 ? tr.pocket : null;
      }
      scene.pockets = { selectable: true, called: app.aim.call, suggested: app.aim.callExplicit ? null : app.aim.call };
    } else if (cpuShowing && app.cpu.plan.shot.call) {
      scene.pockets = { selectable: false, called: app.cpu.plan.shot.call.pocket, suggested: null };
    }
  } else if (g.phase === 'rolling' && g.lastShot && g.lastShot.call && g.lastShot.call.pocket != null) {
    scene.pockets = { selectable: false, called: g.lastShot.call.pocket, suggested: null };
  }
  return scene;
}

// ---------- loop ----------
function frame(nowMs) {
  const now = nowMs / 1000;
  const dt = app.lastTime ? Math.min(0.05, Math.max(0, now - app.lastTime)) : 1 / 60;
  app.lastTime = now;
  const t0 = performance.now();
  if (app.game && !app.paused) {
    tickStroke(dt);
    tickCpu(dt);
    app.game.update(dt);
  }
  // Nothing changes behind the opaque menu, or while paused once the paused frame is drawn.
  const covered = !app.game && app.ui.el.menu && app.ui.el.menu.classList.contains('open');
  if (!covered && !(app.paused && app.drewPaused)) {
    app.renderer.draw(buildScene(now));
    app.drewPaused = app.paused;
  }
  app.frameMs = app.frameMs * 0.9 + (performance.now() - t0) * 0.1;
  if (DEBUG) drawDebug(dt);
  requestAnimationFrame(frame);
}

let debugEl = null;
function drawDebug(dt) {
  if (!debugEl) {
    debugEl = document.createElement('div');
    debugEl.style.cssText =
      'position:fixed;left:4px;bottom:4px;z-index:99;font:11px ui-monospace,monospace;color:#9f9;' +
      'background:rgba(0,0,0,.55);padding:2px 6px;border-radius:4px;pointer-events:none';
    document.body.appendChild(debugEl);
  }
  const phase = app.game ? app.game.phase : 'menu';
  debugEl.textContent = `${(1 / Math.max(dt, 1e-3)).toFixed(0)} fps · frame ${app.frameMs.toFixed(2)} ms · ${phase}`;
}

// ---------- wake lock (keeps the screen on mid-game; optional, may be refused in iframes) ----------
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

// ---------- boot ----------
function boot() {
  const root = document.getElementById('app') || document;
  const canvas = document.getElementById('table');

  app.ui = new UI(document, {
    onStart: (config) => startGame(config),
    onResume: () => resumeGame(),
    onPause: (paused) => {
      if (!app.game) return;
      app.paused = !!paused;
      app.drewPaused = false;
      if (!paused) app.lastTime = 0;
      updateInputMode();
    },
    onRestartRack: () => {
      if (!app.game) return;
      app.paused = false;
      if (app.game.phase === 'toss') app.game.update(1e3); // finish the toss first
      freshRackControls();
      const r = app.game.restartRack();
      if (!r.ok) app.ui.toast('The rack can be restarted once the balls stop', 'info');
      setAim(defaultAimAngle());
      updateInputMode();
    },
    onConcede: () => {
      if (!app.game) return;
      app.paused = false;
      if (app.game.phase === 'toss') app.game.update(1e3);
      dropCpuWork();
      app.game.concede();
      updateInputMode();
    },
    onQuit: () => quitToMenu(),
    canPersist: () => {
      saveGame();
      return persisted || !app.game;
    },
    onDecision: (option) => {
      if (app.game && app.game.phase === 'decision') {
        dropCpuWork();
        const r = app.game.decide(option);
        if (r.ok && option !== 'acceptTable') freshRackControls();
        if (r.ok && isHumanTurn()) setAim(defaultAimAngle());
      }
    },
    onNextRack: () => {
      if (!app.game) return;
      freshRackControls();
      app.game.nextRack();
      setAim(defaultAimAngle());
    },
    onRematch: () => {
      if (!app.game) return;
      freshRackControls();
      app.game.rematch();
      setAim(defaultAimAngle());
    },
    onSettings: (s) => {
      app.renderer.setCloth(s.cloth);
      app.audio.setEnabled(s.sound);
    },
    onLayout: () => requestAnimationFrame(resize),
  });

  app.renderer = new Renderer(canvas, { table: TABLE, cloth: app.ui.settings.cloth });
  app.audio.setEnabled(app.ui.settings.sound);

  app.input = new InputController({
    canvas,
    powerEl: document.getElementById('power'),
    spinEl: document.getElementById('spin'),
    spinPadEl: document.getElementById('spinpad'),
    fineEl: document.getElementById('fine'),
    getView: () => app.view,
    renderer: app.renderer,
    callbacks: {
      onAim: (a) => (app.aim.angle = a),
      onPower: (p) => (app.aim.power = p),
      onShoot: (s) => humanShoot(s),
      onCancel: () => (app.aim.power = 0),
      onPlace: (x, y) => {
        if (!app.game) return;
        app.placing = true;
        app.game.placeCue(x, y);
      },
      onPlaceEnd: (x, y) => {
        app.placing = false;
        if (!app.game) return;
        app.game.placeCue(x, y);
        updateInputMode();
      },
      onCallPocket: (id) => {
        app.aim.call = id;
        app.aim.callExplicit = true;
        app.audio.ball(0.25);
      },
      onSpin: (s) => {
        app.aim.spin = { x: s.x, y: s.y };
        app.ui.setSpinIndicator(s);
      },
    },
  });
  app.input.setMode({ enabled: false });

  // The table container changes size with orientation, folding and the HUD layout.
  const wrap = document.getElementById('table-wrap');
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => resize()).observe(wrap);
  globalThis.addEventListener('resize', () => requestAnimationFrame(resize));
  resize();

  // iOS only lets audio start from a user gesture.
  const unlock = () => app.audio.unlock();
  root.addEventListener('pointerdown', unlock, { capture: true });
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

  globalThis.__pool = app; // for debugging and the e2e tests

  if (AUTOPLAY) {
    const level = ['easy', 'medium', 'hard', 'pro'].includes(AUTOPLAY) ? AUTOPLAY : 'hard';
    app.ui.hideMenu();
    startGame({
      mode: 'cpu',
      level,
      raceTo: 1,
      players: [
        { name: 'CPU A', kind: 'cpu', level },
        { name: 'CPU B', kind: 'cpu', level },
      ],
    });
  } else {
    app.ui.setResumeAvailable(!!loadSave());
    app.ui.showMenu();
  }
  requestAnimationFrame(frame);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
