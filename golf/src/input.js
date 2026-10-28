// Pointer input for the golf canvas: aim drag, swing-pad recording, read-mode orbit, map taps
// and tap-to-skip. Pointer Events only (touch, pen and mouse). Coordinates are CSS px relative to
// the canvas. No UI knowledge: the HUD only mirrors padRect (ui.js imports padRectFor).
//
//   const input = new InputController(canvas, {onAim, onSwingStart, onSwingProgress, onSwing,
//                                              onSwingCancel, onPadTap, onOrbit, onTap, onSkip});
//   input.mode = 'full'|'putt'|'read'|'map'|'intro'|'watch'|'disabled'   (setMode(m) also works)
//   input.swingStyle = 'swipe'|'tap'   how the pad is used in full/putt (settings.swing)
//   input.padRect -> {x, y, w, h}  (CSS px, canvas-relative)   input.padRefH -> padRect.h
//   input.resize()   recompute padRect (automatic on canvas/window resize)
//   input.destroy()
//
// Gestures by mode
//   full / putt  press in the aim zone (outside padRect) and drag horizontally -> onAim(dyaw).
//                Drag right turns the aim right (clockwise from above), so dyaw < 0.
//                swipe style: press in the swing pad -> onSwingStart({x, y}), then every move
//                onSwingProgress({depth, maxDepth, raw, power, overswing, full, phase}), and on
//                release onSwing(samples) with samples [{t (ms), x, y}] from pointerdown to
//                pointerup. The canvas captures the pointer, and moves/releases are also heard on
//                the window, so leaving the pad (or the canvas) never drops a swing.
//                onSwingCancel(reason) ends a swing without a stroke: 'pointercancel' (the system
//                took the touch), 'dragOut' (dragged more than SIDE_OUT_PX sideways out of the pad
//                during the backswing), 'mode' / 'style' (the mode or swing style changed).
//                tap style: a press in the pad -> onPadTap({x, y, t}) at once (t = the event time
//                in ms, for meter timing); main.js runs the tap meter.
//   read         drag anywhere -> onOrbit(dyaw) (grab-the-world: drag right orbits clockwise).
//   map          tap -> onTap(sx, sy); a horizontal drag still aims (onAim) for fine tuning.
//   intro/watch  tap anywhere -> onSkip() (not within SKIP_GUARD_MS of entering the mode).
//   disabled     nothing.
// Only the first pointer is tracked; extra fingers are ignored until it lifts.
//
// Power (architecture.md section 8.1). The touchdown y is the swing's start; the deepest point
// below it is the backswing. fullPowerPx(padH) is the travel for full power, a comfortable thumb
// distance, shared by the live gauge (swingProgress) and swing.js (interpretSwing):
//   raw = maxDepth / fullPowerPx         (putts use their own, slightly shorter travel)
//   full swing: power = raw up to 0.8 (so 25/50/75% of the travel is 25/50/75% power), then a
//     slightly steeper ramp to 1.0 at raw 0.95; a detent holds exactly 1.0 from raw 0.95 to 1.12
//     (0.95-1.06 is the detent proper, 1.06-1.12 its margin), and only past 1.12x the travel does
//     the swing overswing, up to MAX_POWER = 1.1 at raw 1.22.
//   putt: power = raw (no detent: pace needs every pixel), capped at MAX_POWER.
//
// Travel from where the thumb lands (swingTravel): a swing started low in the pad (on the ball, say)
// has less room below it than fullPowerPx, so its travel shrinks to fit: full power (the detent
// proper) always lies inside the pad, down to a floor of TRAVEL_MIN_PX. Both the gauge and
// interpretSwing take the pad rect for this.
//
// Dialling back (swingSetPoint): the power comes from the set point, the bottom of the backswing,
// which follows the finger down and also back UP while it moves up slowly (under DIAL_SPEED px/s,
// once it has risen DIAL_MIN_PX): a player who overshoots the notch eases back to it and the gauge
// follows. Only a brisker move up is the swing itself (interpretSwing strikes from the set point).

import { clamp } from './vec3.js';

// Travel for full power: FRAC x the pad height, clamped to [MIN_PX, MAX_PX] CSS px.
export const FULL_POWER_FRAC = 0.55;
export const FULL_POWER_MIN_PX = 140;
export const FULL_POWER_MAX_PX = 220;
export const PUTT_POWER_FRAC = 0.5;
export const PUTT_POWER_MIN_PX = 110;
export const PUTT_POWER_MAX_PX = 200;
export const MAX_POWER = 1.1;
// Full-swing power curve over raw travel (fractions of fullPowerPx).
export const RAMP_FROM = 0.8; // 1:1 below this
export const DETENT_LO = 0.95; // full power from here...
export const DETENT_HI = 1.06; // ...the detent proper ends here...
export const OVERSWING_FROM = 1.12; // ...and overswing only starts past this
// Target notch: the gauge glows within TARGET_GLOW of the target power; Easy snaps within EASY_SNAP.
export const TARGET_GLOW = 0.03; // of the full-power travel (raw), see onTarget
export const EASY_SNAP = 0.05;
// Tap meter: the power fills 0 -> MAX_POWER over METER_FILL_S, then falls back to 0 over the same
// time; a meter left running past that is abandoned.
export const METER_FILL_S = 1.4;
// A swing dragged this far sideways out of the pad during the backswing is abandoned.
export const SIDE_OUT_PX = 90;
// Travel floor for a swing started near the bottom of the pad.
export const TRAVEL_MIN_PX = 90;
// Dialling back: the finger moving up slower than this (px/s, measured once it has risen
// DIAL_MIN_PX above the set point; then sample by sample) moves the set point up with it.
export const DIAL_SPEED = 90;
export const DIAL_MIN_PX = 6;

const AIM_RAD_PER_PX = 0.0022; // ~0.13 deg/px for slow, precise drags
const AIM_FAST_PX_S = 900; // drags faster than this get up to 3x gain for big turns
const ORBIT_RAD_PER_PX = 0.007;
const TAP_PX = 10;
const TAP_MS = 350;
const DOWN_SLOP_PX = 6; // finger must climb this far above its lowest point to count as the downswing
// Taps to skip are ignored this long after the input enters 'intro' or 'watch': the second tap of
// a double tap on an overlay button ("Next hole", "Resume") lands on the canvas once the overlay
// has closed, and must not skip the flyover or fast-forward the shot.
export const SKIP_GUARD_MS = 350;
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

// ------------------------------------------------------------------ pure helpers (unit-tested)

// Layout of the canvas for the swing pad: 'portrait' | 'landscape' | 'square' (same thresholds
// as ui.applyLayout()).
export function layoutMode(w, h) {
  const a = w / Math.max(1, h);
  if (a >= 1.25) return 'landscape';
  if (a <= 0.8) return 'portrait';
  return 'square';
}

// The swing pad for a w x h canvas with safe-area insets {top, right, bottom, left}.
//   portrait / square: the lower 45% of the area above the bottom safe inset, full width (the
//   club and putt-range pickers sit on its bottom edge, below the arc; they are DOM buttons above
//   the canvas, so a press on them never starts a swing, and with pointer capture a backswing may
//   run over them).
//   landscape: the lower 72% of the height on the right 40% of the width (a 40% strip along the
//   bottom of a 390 px tall screen leaves too little travel for the backswing).
export function padRectFor(w, h, insets = {}) {
  const sb = insets.bottom || 0;
  const sr = insets.right || 0;
  const usableH = Math.max(1, h - sb);
  if (layoutMode(w, h) === 'landscape') {
    const pw = Math.round(w * 0.4);
    const ph = Math.round(usableH * 0.72);
    return { x: w - sr - pw, y: usableH - ph, w: pw, h: ph };
  }
  const ph = Math.round(usableH * 0.45);
  return { x: 0, y: usableH - ph, w, h: ph };
}

export function inRect(r, x, y) {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

// Backswing travel (CSS px) for full power with a pad padH px tall.
export function fullPowerPx(padH, kind = 'full') {
  const h = Math.max(1, padH || 0);
  if (kind === 'putt') return clamp(PUTT_POWER_FRAC * h, PUTT_POWER_MIN_PX, PUTT_POWER_MAX_PX);
  return clamp(FULL_POWER_FRAC * h, FULL_POWER_MIN_PX, FULL_POWER_MAX_PX);
}

// Power from raw travel (a fraction of fullPowerPx): see the header for the curve.
export function powerFromRaw(raw, kind = 'full') {
  const r = Math.max(0, Number.isFinite(raw) ? raw : 0);
  if (kind === 'putt') return Math.min(r, MAX_POWER);
  if (r <= RAMP_FROM) return r;
  // (1e-9: depth / travel round-off must not miss the detent's edge)
  if (r < DETENT_LO - 1e-9) return RAMP_FROM + ((r - RAMP_FROM) * (1 - RAMP_FROM)) / (DETENT_LO - RAMP_FROM);
  if (r <= OVERSWING_FROM + 1e-9) return 1;
  return Math.min(MAX_POWER, 1 + (r - OVERSWING_FROM));
}

// Travel (px) for full power of a swing that touched down at y0 in padRect: fullPowerPx, or less
// when the pad's bottom edge is closer than that (full swings keep the detent proper, up to
// DETENT_HI, inside the pad; putts their full power), never under TRAVEL_MIN_PX. Without a pad
// rect or y0: fullPowerPx.
export function swingTravel(padH, kind = 'full', y0 = null, padRect = null) {
  const px = fullPowerPx(padH, kind);
  if (!padRect || !Number.isFinite(y0)) return px;
  const room = padRect.y + padRect.h - y0;
  return clamp(room / (kind === 'putt' ? 1 : DETENT_HI), Math.min(px, TRAVEL_MIN_PX), px);
}

// Power for a backswing depth (px below the touchdown point); travel: swingTravel (default
// fullPowerPx).
export function powerFromDepth(depth, padH, kind = 'full', travel = null) {
  return powerFromRaw(Math.max(0, depth) / (travel || fullPowerPx(padH, kind)), kind);
}

// Raw travel (a fraction of the full-power travel) that gives `power`: the inverse of powerFromRaw
// (full power: the middle of the detent).
export function rawForPower(power, kind = 'full') {
  const p = clamp(Number.isFinite(power) ? power : 0, 0, MAX_POWER);
  if (kind === 'putt') return p;
  if (p <= RAMP_FROM) return p;
  if (p < 1) return RAMP_FROM + ((p - RAMP_FROM) * (DETENT_LO - RAMP_FROM)) / (1 - RAMP_FROM);
  if (p === 1) return (DETENT_LO + DETENT_HI) / 2;
  return OVERSWING_FROM + (p - 1);
}

// Inverse of powerFromDepth: the depth (px) that gives `power` (full power: the middle of the
// detent). Used by tests and the e2e swipe helpers.
export function depthForPower(power, padH, kind = 'full', travel = null) {
  return rawForPower(power, kind) * (travel || fullPowerPx(padH, kind));
}

// Easy difficulty: a power within EASY_SNAP of the target notch snaps onto it.
export function snapPower(power, target, difficulty) {
  if (difficulty !== 'easy' || !Number.isFinite(target) || !Number.isFinite(power)) return power;
  return Math.abs(power - target) <= EASY_SNAP ? target : power;
}

// The gauge glows when the power is this close to the target notch, measured in travel (raw) so the
// window is the same width under the thumb everywhere on the arc (±TARGET_GLOW of the full-power
// travel, about ±6 px): in the steeper 80-100% ramp it spans a little more power, and a notch just
// short of full power reaches into the detent instead of ending a pixel before it.
export function onTarget(power, target, kind = 'full') {
  return Number.isFinite(target) && Number.isFinite(power) && Math.abs(rawForPower(power, kind) - rawForPower(target, kind)) <= TARGET_GLOW + 1e-9;
}

// Tap meter: raw travel equivalent elapsedS seconds after the first tap. The power (through
// powerFromRaw) fills 0 -> MAX_POWER over METER_FILL_S, hanging briefly in the full-power detent
// on a full swing, then falls back the same way; null once it has fallen back (abandoned).
export function meterRaw(elapsedS, kind = 'full') {
  const top = kind === 'putt' ? MAX_POWER : OVERSWING_FROM + (MAX_POWER - 1);
  const e = Math.max(0, Number.isFinite(elapsedS) ? elapsedS : 0);
  if (e <= METER_FILL_S) return (top * e) / METER_FILL_S;
  if (e <= 2 * METER_FILL_S) return top * (2 - e / METER_FILL_S);
  return null;
}

export function meterPower(elapsedS, kind = 'full') {
  const raw = meterRaw(elapsedS, kind);
  return raw == null ? null : powerFromRaw(raw, kind);
}

// True when the finger, while still in the backswing (at or near its lowest point so far), was
// dragged more than SIDE_OUT_PX sideways beyond the pad's left or right edge: the player is
// abandoning the swing. In portrait the pad spans the screen, so only landscape can trigger it.
export function draggedOut(samples, padRect) {
  if (!samples || !samples.length || !padRect) return false;
  let maxY = -Infinity;
  for (const s of samples) {
    if (s.y > maxY) maxY = s.y;
    if (s.y < maxY - DOWN_SLOP_PX) continue; // on the way up: a wide follow-through is fine
    if (s.x < padRect.x - SIDE_OUT_PX || s.x > padRect.x + padRect.w + SIDE_OUT_PX) return true;
  }
  return false;
}

// Set point of a swing trace: the bottom of the backswing the power is read from. It follows the
// finger down, and while the finger eases back up slowly it follows it up too (dialling back):
//  - a rise starts at the first sample clearly (CLEAR_PX) above the set point; once it is
//    DIAL_MIN_PX above and has lasted DIAL_MIN_MS, an average speed from that first sample under
//    DIAL_SPEED enters dialling (timed from the first sample above, so a pause at the bottom with no
//    touch events never makes a flick look slow; the minimum time lets an upswing that starts
//    gently get going);
//  - while dialling, the set point follows sample by sample as long as the speed over the last
//    DIAL_WINDOW_MS stays under DIAL_SPEED;
//  - a rise that has once gone COMMIT_SPEED or faster is the swing: it never dials (a climb that
//    rests at the top before the lift is still a climb).
// Returns {i, y}: the sample index and its y. Every later sample is at or above it. Pure and causal,
// so the live gauge (swingProgress on the trace so far) and interpretSwing (the whole trace) agree.
// dial false (putts: the stroke is the release, and a thumb relaxing forward before it must not
// soften the putt): just the deepest point.
const CLEAR_PX = 3;
const DIAL_MIN_MS = 100;
const DIAL_WINDOW_MS = 50;
const COMMIT_SPEED = 150;
const GAP_MS = 120; // no events for this long: the thumb was resting
function windowSpeed(S, i) {
  const s = S[i];
  let k = i - 1;
  while (k > 0 && S[k].t > s.t - DIAL_WINDOW_MS) k--;
  return ((S[k].y - s.y) / Math.max(8, s.t - S[k].t)) * 1000;
}
export function swingSetPoint(samples, dial = true) {
  if (!samples || !samples.length) return { i: 0, y: 0 };
  let si = 0;
  let sy = samples[0].y;
  if (!dial) {
    for (let i = 1; i < samples.length; i++) {
      if (samples[i].y > sy) {
        si = i;
        sy = samples[i].y;
      }
    }
    return { i: si, y: sy };
  }
  let up = -1; // first sample of the current rise clearly above the set point
  let dialing = false;
  let committed = false;
  for (let i = 1; i < samples.length; i++) {
    const s = samples[i];
    if (s.y >= sy) {
      si = i;
      sy = s.y;
      up = -1;
      committed = false;
      continue;
    }
    if (committed) continue;
    // A jump after a gap in the events (the thumb rested, then moved: iOS sends nothing while it
    // is still) starts a new rise however long the gap was: it is never read as slow.
    const prev = samples[i - 1];
    if (s.t - prev.t > GAP_MS && prev.y - s.y > CLEAR_PX) {
      dialing = false;
      up = i;
      continue;
    }
    if (dialing) {
      const v = windowSpeed(samples, i);
      if (v < DIAL_SPEED) {
        si = i;
        sy = s.y;
        continue;
      }
      dialing = false;
      if (v >= COMMIT_SPEED) committed = true;
      up = sy - s.y > CLEAR_PX ? i : -1;
      continue;
    }
    if (up < 0) {
      if (sy - s.y > CLEAR_PX) up = i;
      continue;
    }
    const a = samples[up];
    const v = ((a.y - s.y) / Math.max(1, s.t - a.t)) * 1000;
    if (v >= COMMIT_SPEED || windowSpeed(samples, i) >= COMMIT_SPEED) committed = true;
    else if (sy - s.y >= DIAL_MIN_PX && s.t - a.t >= DIAL_MIN_MS && v < DIAL_SPEED) {
      si = i;
      sy = s.y;
      up = -1;
      dialing = true;
    }
  }
  return { i: si, y: sy };
}

// Live swing state from the samples so far. The touchdown y is the start; depth is how far below
// it the finger is now, maxDepth the set point's depth (the bottom of the backswing, dialled back
// by a slow move up on a full swing: swingSetPoint). Power follows the set point, so the gauge
// holds the backswing while the finger swings up and follows a slow ease back. phase: 'back' while
// the finger is still at (or near) the set point, 'down' once it climbs away. full: in the
// full-power detent. padRect: the pad, for the travel of a swing started low in it (swingTravel);
// travel is returned.
export function swingProgress(samples, padRefH, kind = 'full', padRect = null) {
  if (!samples || samples.length === 0) return { depth: 0, maxDepth: 0, raw: 0, power: 0, overswing: false, full: false, phase: 'back', travel: fullPowerPx(padRefH, kind) };
  const y0 = samples[0].y;
  const travel = swingTravel(padRefH, kind, y0, padRect);
  const maxDepth = Math.max(0, swingSetPoint(samples, kind !== 'putt').y - y0);
  const depth = Math.max(0, samples[samples.length - 1].y - y0);
  const raw = maxDepth / travel;
  const power = powerFromRaw(raw, kind);
  const phase = maxDepth - depth > DOWN_SLOP_PX ? 'down' : 'back';
  return { depth, maxDepth, raw, power, overswing: power > 1, full: kind !== 'putt' && power === 1, phase, travel };
}

// Aim yaw change for a horizontal drag of dx px over dtMs. Faster drags turn more per pixel.
// Dragging right turns the aim clockwise (yaw is counter-clockwise positive), hence the minus.
export function aimDelta(dx, dtMs) {
  const speed = Math.abs(dx) / Math.max(1, dtMs) * 1000;
  const gain = 1 + 2 * clamp((speed - 150) / AIM_FAST_PX_S, 0, 1);
  return -dx * AIM_RAD_PER_PX * gain;
}

export function orbitDelta(dx) {
  return -dx * ORBIT_RAD_PER_PX;
}

export function isTap(down, up) {
  return Math.hypot(up.x - down.x, up.y - down.y) <= TAP_PX && up.t - down.t <= TAP_MS;
}

// Safe-area insets in CSS px from the --sat/--sar/--sab/--sal tokens set in style.css.
export function readSafeInsets() {
  const out = { top: 0, right: 0, bottom: 0, left: 0 };
  try {
    const cs = getComputedStyle(document.documentElement);
    out.top = parseFloat(cs.getPropertyValue('--sat')) || 0;
    out.right = parseFloat(cs.getPropertyValue('--sar')) || 0;
    out.bottom = parseFloat(cs.getPropertyValue('--sab')) || 0;
    out.left = parseFloat(cs.getPropertyValue('--sal')) || 0;
  } catch {
    // no DOM (tests) - keep zeros
  }
  return out;
}

const MODES = ['full', 'putt', 'read', 'map', 'intro', 'watch', 'disabled'];
const STYLES = ['swipe', 'tap'];
const noop = () => {};

// ------------------------------------------------------------------ controller (DOM)

export class InputController {
  constructor(canvas, callbacks = {}) {
    this.canvas = canvas;
    this.onAim = callbacks.onAim || noop;
    this.onSwingStart = callbacks.onSwingStart || noop;
    this.onSwingProgress = callbacks.onSwingProgress || noop;
    this.onSwing = callbacks.onSwing || noop;
    this.onSwingCancel = callbacks.onSwingCancel || noop;
    this.onPadTap = callbacks.onPadTap || noop;
    this.onOrbit = callbacks.onOrbit || noop;
    this.onTap = callbacks.onTap || noop;
    this.onSkip = callbacks.onSkip || noop;
    this._mode = 'disabled';
    this._style = 'swipe';
    this.padRect = { x: 0, y: 0, w: 1, h: 1 };
    // active gesture {id, kind:'aim'|'swing'|'padtap'|'void'|'orbit'|'map'|'tap', down, last, samples}
    this._g = null;
    this._off = [];

    const on = (el, type, fn, opts) => {
      el.addEventListener(type, fn, opts);
      this._off.push(() => el.removeEventListener(type, fn, opts));
    };
    on(canvas, 'pointerdown', (e) => this._down(e));
    // Moves and releases are heard on the window: with pointer capture they target the canvas and
    // bubble up; if the capture is ever lost (iOS), they still arrive from whatever element is
    // under the finger, so a swing is never dropped or left hanging.
    on(window, 'pointermove', (e) => this._move(e));
    on(window, 'pointerup', (e) => this._up(e, false));
    on(window, 'pointercancel', (e) => this._up(e, true));
    // iOS: stop long-press magnifier / callout and double-tap zoom on the game surface.
    on(canvas, 'contextmenu', (e) => e.preventDefault());
    on(canvas, 'touchstart', (e) => e.preventDefault(), { passive: false });
    const onResize = () => this.resize();
    on(window, 'resize', onResize);
    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(onResize);
      this._ro.observe(canvas);
      this._off.push(() => this._ro.disconnect());
    }
    this.resize();
  }

  get mode() {
    return this._mode;
  }

  set mode(m) {
    this.setMode(m);
  }

  // Changing mode abandons any gesture in progress (a swing being recorded is cancelled).
  setMode(m) {
    if (!MODES.includes(m)) throw new Error(`InputController: unknown mode ${m}`);
    if (m === this._mode) return;
    this._abandon('mode');
    this._mode = m;
    if (m === 'intro' || m === 'watch') this._skipGuard = now() + SKIP_GUARD_MS;
  }

  get swingStyle() {
    return this._style;
  }

  set swingStyle(s) {
    if (!STYLES.includes(s)) throw new Error(`InputController: unknown swing style ${s}`);
    if (s === this._style) return;
    this._abandon('style');
    this._style = s;
  }

  get padRefH() {
    return this.padRect.h;
  }

  resize() {
    const w = this.canvas.clientWidth || this.canvas.width || 1;
    const h = this.canvas.clientHeight || this.canvas.height || 1;
    this.padRect = padRectFor(w, h, readSafeInsets());
  }

  destroy() {
    for (const off of this._off) off();
    this._off = [];
    this._g = null;
  }

  _abandon(reason) {
    if (this._g && this._g.kind === 'swing') this.onSwingCancel(reason);
    this._g = null;
  }

  _pt(e) {
    const r = this.canvas.getBoundingClientRect();
    return { t: e.timeStamp || now(), x: e.clientX - r.left, y: e.clientY - r.top };
  }

  _down(e) {
    if (this._g || this._mode === 'disabled') return;
    if (e.button !== undefined && e.button > 0) return; // mouse: left button only
    const p = this._pt(e);
    let kind;
    switch (this._mode) {
      case 'full':
      case 'putt':
        if (!inRect(this.padRect, p.x, p.y)) kind = 'aim';
        else kind = this._style === 'tap' ? 'padtap' : 'swing';
        break;
      case 'read':
        kind = 'orbit';
        break;
      case 'map':
        kind = 'map';
        break;
      default: // intro / watch
        if (now() < (this._skipGuard || 0)) return; // the tail of a double tap on a closing overlay
        kind = 'tap';
    }
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      // synthetic events in tests have no active pointer
    }
    this._g = { id: e.pointerId, kind, down: p, last: p, samples: [p] };
    if (kind === 'swing') {
      this.onSwingStart({ x: p.x, y: p.y });
      this.onSwingProgress(swingProgress(this._g.samples, this.padRefH, this._mode, this.padRect));
    } else if (kind === 'padtap') {
      this.onPadTap({ x: p.x, y: p.y, t: p.t });
    }
    e.preventDefault();
  }

  _move(e) {
    const g = this._g;
    if (!g || e.pointerId !== g.id) return;
    if (g.kind === 'void' || g.kind === 'padtap') return; // abandoned swing / tap meter press
    // Coalesced events give the full 120 Hz touch trace on iOS even when rAF runs at 60 Hz;
    // the swing interpreter needs it for the flick speed and curvature.
    const list = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : null;
    const evs = list && list.length ? list : [e];
    for (const ev of evs) {
      const p = this._pt(ev);
      if (p.t < g.last.t) p.t = g.last.t; // coalesced timestamps can be coarse; keep monotonic
      if (g.kind === 'swing') {
        g.samples.push(p);
      } else if (g.kind === 'aim' || g.kind === 'map') {
        const dx = p.x - g.last.x;
        if (dx !== 0 && (g.kind === 'aim' || Math.abs(p.x - g.down.x) > TAP_PX)) this.onAim(aimDelta(dx, p.t - g.last.t));
      } else if (g.kind === 'orbit') {
        const dx = p.x - g.last.x;
        if (dx !== 0) this.onOrbit(orbitDelta(dx));
      }
      g.last = p;
    }
    if (g.kind === 'swing') {
      if (draggedOut(g.samples, this.padRect)) {
        // Dragged off to the side in the backswing: abandoned at once (the gauge disappears
        // while the finger is still down), and the rest of this touch is ignored.
        g.kind = 'void';
        this.onSwingCancel('dragOut');
      } else {
        this.onSwingProgress(swingProgress(g.samples, this.padRefH, this._mode, this.padRect));
      }
    }
    e.preventDefault();
  }

  _up(e, cancelled) {
    const g = this._g;
    if (!g || e.pointerId !== g.id) return;
    this._g = null;
    const p = this._pt(e);
    if (g.kind === 'swing') {
      if (cancelled) {
        this.onSwingCancel('pointercancel');
        return;
      }
      if (p.t >= g.last.t && (p.x !== g.last.x || p.y !== g.last.y)) g.samples.push(p);
      this.onSwing(g.samples);
    } else if (!cancelled && isTap(g.down, p)) {
      if (g.kind === 'map') this.onTap(p.x, p.y);
      else if (g.kind === 'tap') this.onSkip();
    }
  }
}
